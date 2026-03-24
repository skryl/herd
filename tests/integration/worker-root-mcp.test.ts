import net from 'node:net';
import readline from 'node:readline';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentInfo, TestDriverProjection } from '../../src/lib/types';
import { HerdTestClient } from './client';
import { createIsolatedTab, waitFor } from './helpers';
import { startIntegrationRuntime, type HerdIntegrationRuntime } from './runtime';

interface SocketResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface AgentChannelEvent {
  kind: 'direct' | 'public' | 'network' | 'root' | 'system' | 'ping';
  from_agent_id?: string | null;
  from_display_name: string;
  to_agent_id?: string | null;
  to_display_name?: string | null;
  message: string;
  topics: string[];
  mentions: string[];
  replay: boolean;
  ping_id?: string | null;
  timestamp_ms: number;
}

interface AgentStreamEnvelope {
  type: 'event';
  event: AgentChannelEvent;
}

interface AgentEventSubscription {
  nextEvent: (timeoutMs?: number) => Promise<AgentChannelEvent>;
  close: () => void;
}

async function collectAgentEvents(
  subscription: AgentEventSubscription,
  predicate: (events: AgentChannelEvent[]) => boolean,
  timeoutMs = 10_000,
): Promise<AgentChannelEvent[]> {
  const deadline = Date.now() + timeoutMs;
  const events: AgentChannelEvent[] = [];
  while (Date.now() <= deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    events.push(await subscription.nextEvent(remaining));
    if (predicate(events)) {
      return events;
    }
  }
  throw new Error(`timed out waiting for expected agent events: ${JSON.stringify(events)}`);
}

async function openAgentEventSubscription(socketPath: string, agentId: string): Promise<AgentEventSubscription> {
  const socket = net.createConnection(socketPath);
  const lines = readline.createInterface({ input: socket });
  const bufferedLines: string[] = [];
  let lineResolver: ((line: string) => void) | null = null;
  let lineRejecter: ((error: Error) => void) | null = null;

  const rejectPending = (error: Error) => {
    if (!lineRejecter) {
      return;
    }
    const reject = lineRejecter;
    lineResolver = null;
    lineRejecter = null;
    reject(error);
  };

  lines.on('line', (line) => {
    if (lineResolver) {
      const resolve = lineResolver;
      lineResolver = null;
      lineRejecter = null;
      resolve(line);
      return;
    }
    bufferedLines.push(line);
  });

  socket.on('error', (error) => rejectPending(error instanceof Error ? error : new Error(String(error))));
  socket.on('close', () => rejectPending(new Error(`agent event subscription for ${agentId} closed unexpectedly`)));

  await new Promise<void>((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('error', reject);
  });

  const nextLine = (timeoutMs = 10_000): Promise<string> =>
    new Promise((resolve, reject) => {
      if (bufferedLines.length > 0) {
        resolve(bufferedLines.shift()!);
        return;
      }
      const timer = setTimeout(() => {
        if (lineResolver === resolve) {
          lineResolver = null;
          lineRejecter = null;
        }
        reject(new Error(`timed out waiting for subscription line for ${agentId}`));
      }, timeoutMs);
      lineResolver = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      lineRejecter = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });

  socket.write(`${JSON.stringify({ command: 'agent_events_subscribe', agent_id: agentId })}\n`);
  const firstLine = await nextLine();
  const response = JSON.parse(firstLine) as SocketResponse<{ agent: AgentInfo }>;
  if (!response.ok) {
    lines.close();
    socket.destroy();
    throw new Error(response.error ?? `agent event subscription failed for ${agentId}`);
  }

  return {
    nextEvent: async (timeoutMs = 10_000) => {
      const line = await nextLine(timeoutMs);
      const envelope = JSON.parse(line) as AgentStreamEnvelope;
      if (envelope.type !== 'event') {
        throw new Error(`unexpected agent stream envelope: ${line}`);
      }
      return envelope.event;
    },
    close: () => {
      lines.close();
      socket.destroy();
    },
  };
}

async function waitForActiveTab(client: HerdTestClient, sessionId: string) {
  await client.toolbarSelectTab(sessionId);
  return waitFor(
    `session ${sessionId} to become active`,
    () => client.getProjection(),
    (projection) => projection.active_tab_id === sessionId,
    30_000,
    150,
  );
}

async function spawnWorkerShellInActiveTab(client: HerdTestClient): Promise<string> {
  const before = await client.getProjection();
  const knownPaneIds = new Set(before.active_tab_terminals.map((terminal) => terminal.id));
  await client.tileCreate('shell', {
    parentSessionId: before.active_tab_id,
    parentTileId: before.selected_tile_id,
  });
  const projection = await waitFor(
    'worker shell create in active tab',
    () => client.getProjection(),
    (nextProjection) => nextProjection.active_tab_terminals.some((terminal) => !knownPaneIds.has(terminal.id)),
    30_000,
    150,
  );
  const created = projection.active_tab_terminals.find((terminal) => !knownPaneIds.has(terminal.id));
  if (!created) {
    throw new Error('failed to locate spawned worker shell pane');
  }
  return created.id;
}

async function spawnBrowserInActiveTab(client: HerdTestClient): Promise<string> {
  const before = await client.getProjection();
  const knownPaneIds = new Set(before.active_tab_terminals.map((terminal) => terminal.id));
  await client.tileCreate('browser', {
    parentSessionId: before.active_tab_id,
    parentTileId: before.selected_tile_id,
  });
  const projection = await waitFor(
    'browser create in active tab',
    () => client.getProjection(),
    (nextProjection) => nextProjection.active_tab_terminals.some((terminal) => !knownPaneIds.has(terminal.id) && terminal.kind === 'browser'),
    30_000,
    150,
  );
  const created = projection.active_tab_terminals.find(
    (terminal) => !knownPaneIds.has(terminal.id) && terminal.kind === 'browser',
  );
  if (!created) {
    throw new Error('failed to locate spawned browser pane');
  }
  return created.id;
}

async function spawnWorkerAgentInActiveTab(client: HerdTestClient): Promise<{ paneId: string; agentId: string }> {
  const before = await waitFor(
    'live root agent before worker agent create',
    () => client.getProjection(),
    (projection) => Boolean(rootAgentForProjection(projection)),
    60_000,
    150,
  );
  const root = rootAgentForProjection(before);
  if (!root) {
    throw new Error('no live root agent available for tile_create');
  }
  const knownPaneIds = new Set(before.active_tab_terminals.map((terminal) => terminal.id));
  const knownAgentIds = new Set(before.agents.map((agent) => agent.agent_id));
  await client.tileCreate('agent', {
    parentSessionId: before.active_tab_id,
    parentTileId: root.tile_id,
    senderTileId: root.tile_id,
    senderAgentId: root.agent_id,
  });
  const projection = await waitFor(
    'worker agent create in active tab',
    () => client.getProjection(),
    (nextProjection) =>
      nextProjection.active_tab_terminals.some((terminal) => !knownPaneIds.has(terminal.id) && terminal.kind === 'claude')
      && nextProjection.agents.some(
        (agent) =>
          !knownAgentIds.has(agent.agent_id)
          && agent.agent_role === 'worker'
          && agent.alive
          && agent.session_id === before.active_tab_id,
      ),
    60_000,
    150,
  );
  const createdTerminal = projection.active_tab_terminals.find(
    (terminal) => !knownPaneIds.has(terminal.id) && terminal.kind === 'claude',
  );
  const createdAgent = projection.agents.find(
    (agent) =>
      !knownAgentIds.has(agent.agent_id)
      && agent.agent_role === 'worker'
      && agent.alive
      && agent.tile_id === createdTerminal?.id,
  );
  if (!createdTerminal || !createdAgent) {
    throw new Error('failed to locate spawned worker agent');
  }
  return { paneId: createdTerminal.id, agentId: createdAgent.agent_id };
}

function rootAgentForProjection(projection: TestDriverProjection): AgentInfo | undefined {
  return projection.agents.find((agent) => agent.agent_role === 'root' && agent.alive);
}

describe.sequential('worker/root mcp and permissions', () => {
  let runtime: HerdIntegrationRuntime;
  let client: HerdTestClient;

  beforeAll(async () => {
    runtime = await startIntegrationRuntime();
    client = runtime.client;
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('creates and repairs a red root agent for each session', async () => {
    const firstProjection = await waitFor(
      'bootstrap root agent',
      () => client.getProjection(),
      (projection) => Boolean(rootAgentForProjection(projection)),
      60_000,
      250,
    );
    const firstRoot = rootAgentForProjection(firstProjection);
    expect(firstRoot).toBeTruthy();
    expect(firstRoot?.agent_role).toBe('root');
    expect(firstRoot?.agent_id).toBe(`root:${firstProjection.active_tab_id}`);

    const newTabProjection = await createIsolatedTab(client, 'root-agent-tab');
    const sessionId = newTabProjection.active_tab_id!;
    const sessionProjection = await waitFor(
      'new session boots with a single visible root tile',
      () => waitForActiveTab(client, sessionId),
      (projection) =>
        projection.active_tab_id === sessionId
        && projection.active_tab_terminals.length === 1
        && projection.active_tab_terminals[0]?.kind === 'root_agent',
      60_000,
      250,
    );
    const sessionRoot = rootAgentForProjection(sessionProjection);
    expect(sessionRoot?.agent_id).toBe(`root:${sessionId}`);
    expect(sessionProjection.active_tab_terminals[0]?.kind).toBe('root_agent');

    await client.sendCommand({ command: 'agent_unregister', agent_id: sessionRoot!.agent_id });
    const repaired = await waitFor(
      'root agent repair',
      () => client.getProjection(),
      (projection) => {
        if (projection.active_tab_id !== sessionId) return false;
        const root = rootAgentForProjection(projection);
        const visibleRootTiles = projection.active_tab_terminals.filter((terminal) => terminal.kind === 'root_agent');
        return root?.agent_id === `root:${sessionId}` && root.alive && visibleRootTiles.length === 1;
      },
      60_000,
      250,
    );
    expect(rootAgentForProjection(repaired)?.agent_id).toBe(`root:${sessionId}`);
    expect(repaired.active_tab_terminals.filter((terminal) => terminal.kind === 'root_agent')).toHaveLength(1);
  });

  it('allows closing a root agent with confirmation and auto-restarts it', async () => {
    const projection = await waitFor(
      'existing root agent before close',
      () => client.getProjection(),
      (nextProjection) => Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const root = rootAgentForProjection(projection);
    expect(root).toBeTruthy();

    await client.driverTileClose(root!.tile_id);
    const confirmProjection = await waitFor(
      'root close confirmation dialog',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.close_pane_confirmation?.tileId === root!.tile_id
        && nextProjection.close_pane_confirmation.confirmLabel === 'Close Root Agent',
      30_000,
      150,
    );
    expect(confirmProjection.close_pane_confirmation?.title).toBe('CLOSE ROOT AGENT');

    await client.pressKeys([{ key: 'Enter' }]);
    const restarted = await waitFor(
      'root agent restart after confirmed close',
      () => client.getProjection(),
      (nextProjection) => {
        const nextRoot = rootAgentForProjection(nextProjection);
        const visibleRootTiles = nextProjection.active_tab_terminals.filter((terminal) => terminal.kind === 'root_agent');
        return (
          nextRoot?.agent_id === root!.agent_id
          && nextRoot.tile_id === root!.tile_id
          && visibleRootTiles.length === 1
          && nextProjection.close_pane_confirmation === null
        );
      },
      60_000,
      250,
    );

    expect(rootAgentForProjection(restarted)?.agent_id).toBe(root!.agent_id);
    expect(restarted.active_tab_terminals.filter((terminal) => terminal.kind === 'root_agent')).toHaveLength(1);
  });

  it('restarts a root agent when its process dies unexpectedly', async () => {
    const projection = await waitFor(
      'existing root agent before kill',
      () => client.getProjection(),
      (nextProjection) => Boolean(rootAgentForProjection(nextProjection)?.agent_pid),
      60_000,
      250,
    );
    const root = rootAgentForProjection(projection);
    expect(root?.agent_pid).toBeTruthy();

    process.kill(root!.agent_pid!, 'SIGKILL');

    const restarted = await waitFor(
      'root agent restart after process death',
      () => client.getProjection(),
      (nextProjection) => {
        const nextRoot = rootAgentForProjection(nextProjection);
        const visibleRootTiles = nextProjection.active_tab_terminals.filter((terminal) => terminal.kind === 'root_agent');
        return (
          nextRoot?.agent_id === root!.agent_id
          && nextRoot.alive
          && nextRoot.agent_pid != null
          && nextRoot.agent_pid !== root!.agent_pid
          && visibleRootTiles.length === 1
        );
      },
      60_000,
      250,
    );

    expect(rootAgentForProjection(restarted)?.agent_id).toBe(root!.agent_id);
    expect(rootAgentForProjection(restarted)?.agent_pid).not.toBe(root!.agent_pid);
    expect(restarted.active_tab_terminals.filter((terminal) => terminal.kind === 'root_agent')).toHaveLength(1);
  });

  it('creates actual worker agents through tile_create instead of plain shells', async () => {
    const created = await spawnWorkerAgentInActiveTab(client);
    const projection = await client.getProjection();
    const terminal = projection.active_tab_terminals.find((candidate) => candidate.id === created.paneId);
    const agent = projection.agents.find((candidate) => candidate.agent_id === created.agentId);
    expect(terminal?.kind).toBe('claude');
    expect(terminal?.agentId).toBe(created.agentId);
    expect(terminal?.parentWindowId).toBe(rootAgentForProjection(projection)?.window_id);
    expect(agent?.agent_role).toBe('worker');
    expect(agent?.tile_id).toBe(created.paneId);
    expect(
      projection.active_tab_connections.some((connection) => connection.child_window_id === terminal?.windowId),
    ).toBe(false);
  });

  it('registers tile-backed agents by tile_id', async () => {
    const projection = await createIsolatedTab(client, 'agent-register');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in agent-register tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const shellTile = await client.tileCreate('shell', {
      parentSessionId: sessionId,
      parentTileId: rootAgent.tile_id,
      senderTileId: rootAgent.tile_id,
      senderAgentId: rootAgent.agent_id,
    });
    const paneId = shellTile.tile_id;
    const agentId = 'agent-register-live';

    const registration = await client.agentRegister(agentId, paneId, 'Registered Agent');
    expect(registration.agent.tile_id).toBe(paneId);

    const pingAck = await client.agentPingAck(agentId);
    expect(pingAck.agent.alive).toBe(true);

    const liveProjection = await waitFor(
      'registered agent becomes alive',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === sessionId
        && nextProjection.agents.some(
          (agent) => agent.agent_id === agentId && agent.tile_id === paneId && agent.alive,
        ),
      30_000,
      150,
    );
    expect(liveProjection.agents.find((agent) => agent.agent_id === agentId)?.alive).toBe(true);
  });

  it('enforces worker local-network permissions at the backend', async () => {
    const projection = await createIsolatedTab(client, 'worker-perms');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in worker-perms tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const worker = await spawnWorkerAgentInActiveTab(client);
    const observer = await spawnWorkerAgentInActiveTab(client);
    const shellPaneId = await spawnWorkerShellInActiveTab(client);
    const browserPaneId = await spawnBrowserInActiveTab(client);
    const foreignPaneId = await spawnWorkerShellInActiveTab(client);

    await client.networkConnect(worker.paneId, 'left', shellPaneId, 'right', rootAgent.tile_id, rootAgent.agent_id);
    await client.networkConnect(worker.paneId, 'right', browserPaneId, 'left', rootAgent.tile_id, rootAgent.agent_id);
    await client.networkConnect(observer.paneId, 'left', browserPaneId, 'right', rootAgent.tile_id, rootAgent.agent_id);

    await expect(
      client.sendCommand({
        command: 'agent_list',
        sender_agent_id: worker.agentId,
        sender_tile_id: worker.paneId,
      }),
    ).rejects.toThrow(/unknown variant/i);

    await expect(
      client.sendCommand({
        command: 'shell_list',
        sender_agent_id: worker.agentId,
        sender_tile_id: worker.paneId,
      }),
    ).rejects.toThrow(/unknown variant/i);

    await expect(
      client.sendCommand({
        command: 'tile_list',
        sender_agent_id: worker.agentId,
        sender_tile_id: worker.paneId,
      }),
    ).rejects.toThrow(/root/i);

    await expect(
      client.sendCommand({
        command: 'work_list',
        agent_id: worker.agentId,
        sender_tile_id: worker.paneId,
      }),
    ).rejects.toThrow(/unknown variant/i);

    await expect(
      client.sendCommand({
        command: 'session_list',
        sender_agent_id: worker.agentId,
        sender_tile_id: worker.paneId,
      }),
    ).rejects.toThrow(/unknown variant/i);

    await expect(
      client.sendCommand({
        command: 'tile_move',
        tile_id: worker.paneId,
        x: 500,
        y: 200,
        sender_agent_id: worker.agentId,
        sender_tile_id: worker.paneId,
      }),
    ).rejects.toThrow(/root/i);

    const visibleNetwork = await client.listNetwork(worker.paneId, worker.agentId);
    expect((visibleNetwork as any).sender_tile_id).toBe(worker.paneId);
    expect(visibleNetwork.tiles.map((tile) => tile.tile_id)).toContain(browserPaneId);
    expect(visibleNetwork.tiles.find((tile) => tile.tile_id === shellPaneId)?.responds_to).toEqual([
      'get',
      'call',
      'output_read',
      'input_send',
      'exec',
      'role_set',
    ]);
    expect(visibleNetwork.tiles.find((tile) => tile.tile_id === browserPaneId)?.responds_to).toEqual([
      'get',
      'call',
      'navigate',
      'load',
      'drive',
    ]);

    const shellTile = await client.networkGet(shellPaneId, worker.paneId, worker.agentId);
    expect(shellTile.tile_id).toBe(shellPaneId);
    expect(shellTile.responds_to).toEqual([
      'get',
      'call',
      'output_read',
      'input_send',
      'exec',
      'role_set',
    ]);

    const browserTile = await client.networkGet(browserPaneId, worker.paneId, worker.agentId);
    expect(browserTile.tile_id).toBe(browserPaneId);
    expect(browserTile.message_api).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'navigate',
          args: [
            {
              name: 'url',
              type: 'string',
              required: true,
              description: 'Absolute URL to load in the browser tile.',
            },
          ],
        }),
        expect.objectContaining({
          name: 'load',
          args: [
            {
              name: 'path',
              type: 'string',
              required: true,
              description: 'Absolute or repo-relative file path to load.',
            },
          ],
        }),
        expect.objectContaining({
          name: 'drive',
          args: [
            {
              name: 'action',
              type: 'string',
              required: true,
              description: 'Browser drive subcommand to execute.',
              enum_values: ['click', 'type', 'dom_query', 'eval'],
            },
            {
              name: 'args',
              type: 'object',
              required: false,
              description: 'Nested args for the selected browser drive subcommand.',
            },
          ],
          subcommands: expect.arrayContaining([
            expect.objectContaining({
              name: 'click',
              args: [
                {
                  name: 'selector',
                  type: 'string',
                  required: true,
                  description: 'CSS selector for the target element.',
                },
              ],
            }),
            expect.objectContaining({
              name: 'type',
              args: [
                {
                  name: 'selector',
                  type: 'string',
                  required: true,
                  description: 'CSS selector for the target element.',
                },
                {
                  name: 'text',
                  type: 'string',
                  required: true,
                  description: 'Text to insert into the target element.',
                },
                {
                  name: 'clear',
                  type: 'boolean',
                  required: false,
                  description: 'Whether to clear the existing value first. Defaults to true.',
                },
              ],
            }),
            expect.objectContaining({
              name: 'dom_query',
              args: [
                {
                  name: 'js',
                  type: 'string',
                  required: true,
                  description: 'JavaScript expression to evaluate in the browser DOM.',
                },
              ],
            }),
            expect.objectContaining({
              name: 'eval',
              args: [
                {
                  name: 'js',
                  type: 'string',
                  required: true,
                  description: 'JavaScript source to execute in the browser DOM.',
                },
              ],
            }),
          ]),
        }),
      ]),
    );

    const observerVisibleNetwork = await client.listNetwork(observer.paneId, observer.agentId);
    expect(observerVisibleNetwork.tiles.find((tile) => tile.tile_id === browserPaneId)?.responds_to).toEqual([
      'get',
      'call',
      'navigate',
      'load',
      'drive',
    ]);
    expect(observerVisibleNetwork.tiles.find((tile) => tile.tile_id === shellPaneId)?.responds_to).toEqual([
      'get',
      'call',
      'output_read',
    ]);

    const observerBrowserTile = await client.networkGet(browserPaneId, observer.paneId, observer.agentId);
    expect(observerBrowserTile.responds_to).toEqual(browserTile.responds_to);
    expect(observerBrowserTile.message_api).toEqual(browserTile.message_api);

    const observerShellTile = await client.networkGet(shellPaneId, observer.paneId, observer.agentId);
    expect(observerShellTile.responds_to).toEqual([
      'get',
      'call',
      'output_read',
    ]);

    await expect(client.networkGet(foreignPaneId, worker.paneId, worker.agentId)).rejects.toThrow(/sender network/i);
    await expect(
      client.networkCall(foreignPaneId, 'output_read', {}, worker.paneId, worker.agentId),
    ).rejects.toThrow(/sender network/i);
    await expect(
      client.tileCall(foreignPaneId, 'output_read', {}, worker.paneId, worker.agentId),
    ).rejects.toThrow(/sender network/i);

    await client.networkCall(
      shellPaneId,
      'input_send',
      { input: "printf 'worker-network-ok\\n'\n" },
      worker.paneId,
      worker.agentId,
    );
    const shellRead = await waitFor(
      'worker network_call shell output',
      () => client.networkCall<{ output: string }>(shellPaneId, 'output_read', {}, worker.paneId, worker.agentId),
      (response) => response.result.output.includes('worker-network-ok'),
      30_000,
      150,
    );
    expect(shellRead.result.output).toContain('worker-network-ok');

    await client.networkCall(
      shellPaneId,
      'exec',
      { command: "printf 'worker-network-exec-ok\\n'" },
      worker.paneId,
      worker.agentId,
    );
    const shellExecRead = await waitFor(
      'worker network_call shell exec output',
      () => client.networkCall<{ output: string }>(shellPaneId, 'output_read', {}, worker.paneId, worker.agentId),
      (response) => response.result.output.includes('worker-network-exec-ok'),
      30_000,
      150,
    );
    expect(shellExecRead.result.output).toContain('worker-network-exec-ok');

    await client.networkCall(
      shellPaneId,
      'input_send',
      { input: "printf 'worker-network-after-exec\\n'\n" },
      worker.paneId,
      worker.agentId,
    );
    const shellAfterExecRead = await waitFor(
      'worker network_call shell remains usable after exec',
      () => client.networkCall<{ output: string }>(shellPaneId, 'output_read', {}, worker.paneId, worker.agentId),
      (response) => response.result.output.includes('worker-network-after-exec'),
      30_000,
      150,
    );
    expect(shellAfterExecRead.result.output).toContain('worker-network-after-exec');

    const browserLoad = await client.networkCall<{ currentUrl?: string; current_url?: string }>(
      browserPaneId,
      'load',
      { path: 'README.md' },
      worker.paneId,
      worker.agentId,
    );
    const browserUrl = browserLoad.result.current_url ?? browserLoad.result.currentUrl ?? '';
    expect(browserUrl.startsWith('file://')).toBe(true);

    const browserDrive = await client.networkCall<string>(
      browserPaneId,
      'drive',
      { action: 'dom_query', args: { js: 'document.body ? "browser-drive-ok" : ""' } },
      worker.paneId,
      worker.agentId,
    );
    expect(browserDrive.result).toBe('browser-drive-ok');

    await client.networkCall(
      shellPaneId,
      'input_send',
      { input: "printf 'observer-read-ok\\n'\n" },
      worker.paneId,
      worker.agentId,
    );
    const observerRead = await waitFor(
      'observer network_call shell output',
      () => client.networkCall<{ output: string }>(shellPaneId, 'output_read', {}, observer.paneId, observer.agentId),
      (response) => response.result.output.includes('observer-read-ok'),
      30_000,
      150,
    );
    expect(observerRead.result.output).toContain('observer-read-ok');

    await expect(
      client.networkCall(shellPaneId, 'input_send', { input: "printf 'observer-should-fail\\n'\n" }, observer.paneId, observer.agentId),
    ).rejects.toThrow(/not supported|not allowed/i);
    const observerBrowserLoad = await client.networkCall<{ currentUrl?: string; current_url?: string }>(
      browserPaneId,
      'load',
      { path: 'README.md' },
      observer.paneId,
      observer.agentId,
    );
    const observerBrowserUrl = observerBrowserLoad.result.current_url ?? observerBrowserLoad.result.currentUrl ?? '';
    expect(observerBrowserUrl.startsWith('file://')).toBe(true);
    const observerBrowserDrive = await client.networkCall<string>(
      browserPaneId,
      'drive',
      { action: 'dom_query', args: { js: 'document.body ? "observer-browser-ok" : ""' } },
      observer.paneId,
      observer.agentId,
    );
    expect(observerBrowserDrive.result).toBe('observer-browser-ok');

    await expect(
      client.tileCall(browserPaneId, 'destroy', {}, worker.paneId, worker.agentId),
    ).rejects.toThrow(/not supported|not allowed/i);
    await expect(
      client.tileCall(shellPaneId, 'input_send', { input: "printf 'observer-bypass\\n'\n" }, observer.paneId, observer.agentId),
    ).rejects.toThrow(/not supported|not allowed/i);
    await expect(
      client.tileCall(`work:work-s1-001`, 'output_read', {}, worker.paneId, worker.agentId),
    ).rejects.toThrow(/sender network|not allowed|unknown tile/i);

    const projectionWithNetworkLogs = await waitFor(
      'network_call layered logs appear',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.tile_message_logs.some(
          (entry) =>
            entry.layer === 'network'
            && entry.wrapper_command === 'network_call'
            && entry.target_kind === 'network'
            && entry.target_id === shellPaneId,
        )
        && nextProjection.tile_message_logs.some(
          (entry) =>
            entry.layer === 'message'
            && entry.wrapper_command === 'network_call'
            && entry.target_id === shellPaneId
            && entry.related_tile_ids.includes(worker.paneId),
        ),
      30_000,
      150,
    );

    expect(
      projectionWithNetworkLogs.tile_message_logs
        .filter((entry) => entry.wrapper_command === 'network_call' && entry.target_id === shellPaneId)
        .map((entry) => entry.layer),
    ).toEqual(expect.arrayContaining(['network', 'message']));

    await expect(
      client.sendCommand({
        command: 'message_public',
        message: 'worker public message',
        sender_agent_id: worker.agentId,
        sender_tile_id: worker.paneId,
      }),
    ).resolves.toBeNull();

    expect(projection.active_tab_id).toBeTruthy();
  });

  it('allows shared shell access from multiple workers on one local network', async () => {
    const projection = await createIsolatedTab(client, 'worker-shared-tools');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in worker-shared-tools tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const workerA = await spawnWorkerAgentInActiveTab(client);
    const workerB = await spawnWorkerAgentInActiveTab(client);
    const shellPaneId = await spawnWorkerShellInActiveTab(client);

    await client.networkConnect(workerA.paneId, 'left', shellPaneId, 'right', rootAgent.tile_id, rootAgent.agent_id);
    await client.networkConnect(workerB.paneId, 'left', shellPaneId, 'top', rootAgent.tile_id, rootAgent.agent_id);

    await client.tileCall(
      shellPaneId,
      'input_send',
      { input: "printf 'shared-worker-a\\n'\n" },
      workerA.paneId,
      workerA.agentId,
    );
    await client.tileCall(
      shellPaneId,
      'input_send',
      { input: "printf 'shared-worker-b\\n'\n" },
      workerB.paneId,
      workerB.agentId,
    );

    const shellRead = await waitFor(
      'shared shell output after worker writes',
      () => client.tileCall<{ output: string }>(shellPaneId, 'output_read', {}, workerA.paneId, workerA.agentId),
      (response) =>
        response.result.output.includes('shared-worker-a')
        && response.result.output.includes('shared-worker-b'),
      30_000,
      150,
    );
    expect(shellRead.result.output).toContain('shared-worker-a');
    expect(shellRead.result.output).toContain('shared-worker-b');
  });

  it('keeps agent tiles read-only over direct worker network connections', async () => {
    const projection = await createIsolatedTab(client, 'worker-agent-read-only');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in worker-agent-read-only tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const workerA = await spawnWorkerAgentInActiveTab(client);
    const workerB = await spawnWorkerAgentInActiveTab(client);

    await client.networkConnect(workerA.paneId, 'left', workerB.paneId, 'right', rootAgent.tile_id, rootAgent.agent_id);
    await client.networkConnect(workerA.paneId, 'top', rootAgent.tile_id, 'bottom', rootAgent.tile_id, rootAgent.agent_id);

    const visibleNetwork = await client.listNetwork(workerA.paneId, workerA.agentId);
    const workerBTile = visibleNetwork.tiles.find((tile) => tile.tile_id === workerB.paneId);
    const rootTile = visibleNetwork.tiles.find((tile) => tile.tile_id === rootAgent.tile_id);

    expect(workerBTile?.responds_to).toEqual(['get', 'call', 'output_read']);
    expect(rootTile?.responds_to).toEqual(['get', 'call', 'output_read']);

    const workerBGet = await client.networkGet(workerB.paneId, workerA.paneId, workerA.agentId);
    expect(workerBGet.responds_to).toEqual(['get', 'call', 'output_read']);
    expect(workerBGet.message_api.map((message) => message.name)).toEqual(['get', 'call', 'output_read']);
    expect(workerBGet.message_api.find((message) => message.name === 'call')?.args).toEqual([
      {
        name: 'action',
        type: 'string',
        required: true,
        description: 'Message name to invoke on this tile.',
        enum_values: ['get', 'output_read'],
      },
      {
        name: 'args',
        type: 'object',
        required: false,
        description: 'Optional message-specific argument object.',
      },
    ]);

    const rootGet = await client.networkGet(rootAgent.tile_id, workerA.paneId, workerA.agentId);
    expect(rootGet.responds_to).toEqual(['get', 'call', 'output_read']);

    await expect(
      client.networkCall(workerB.paneId, 'input_send', { input: "printf 'should-not-run\\n'\n" }, workerA.paneId, workerA.agentId),
    ).rejects.toThrow(/not supported|not allowed/i);
    await expect(
      client.networkCall(workerB.paneId, 'exec', { command: "printf 'should-not-run\\n'" }, workerA.paneId, workerA.agentId),
    ).rejects.toThrow(/not supported|not allowed/i);
    await expect(
      client.networkCall(rootAgent.tile_id, 'role_set', { role: 'observer' }, workerA.paneId, workerA.agentId),
    ).rejects.toThrow(/not supported|not allowed/i);
  });

  it('lists current-session tiles for root and supports tile-type filters', async () => {
    const projection = await createIsolatedTab(client, 'session-list');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in session-list tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const workerPaneId = await spawnWorkerShellInActiveTab(client);
    const work = await client.tileCreate('work', {
      title: 'Session list work',
      parentTileId: rootAgent.tile_id,
      senderTileId: rootAgent.tile_id,
      senderAgentId: rootAgent.agent_id,
    });
    const workDetails = work.details as { work_id: string; topic: string };

    const full = await client.tileList(rootAgent.tile_id, rootAgent.agent_id);
    expect(full.session_id).toBe(sessionId);
    expect(full.tiles.find((tile) => tile.tile_id === rootAgent.tile_id)).toMatchObject({
      kind: 'root_agent',
      details: {
        agent_id: rootAgent.agent_id,
        agent_role: 'root',
        display_name: 'Root',
      },
    });
    expect(full.tiles.some((tile) => tile.tile_id === workerPaneId && tile.kind === 'shell')).toBe(true);
    expect(full.tiles.some((tile) => tile.tile_id === work.tile_id && tile.kind === 'work')).toBe(true);

    const workOnly = await client.tileList(rootAgent.tile_id, rootAgent.agent_id, 'work');
    expect(workOnly.tiles).toHaveLength(1);
    expect(workOnly.tiles[0]).toMatchObject({
      tile_id: work.tile_id,
      session_id: sessionId,
      kind: 'work',
      title: work.title,
      width: expect.any(Number),
      height: expect.any(Number),
      details: {
        work_id: workDetails.work_id,
        topic: workDetails.topic,
      },
    });
  });

  it('lists, gets, moves, and resizes tiles for root', async () => {
    const projection = await createIsolatedTab(client, 'tile-api');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in tile-api tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const workerPaneId = await spawnWorkerShellInActiveTab(client);
    const work = await client.tileCreate('work', {
      title: 'Tile api work',
      parentTileId: rootAgent.tile_id,
      senderTileId: rootAgent.tile_id,
      senderAgentId: rootAgent.agent_id,
    });
    const workDetails = work.details as { work_id: string };

    const tiles = (await client.tileList(rootAgent.tile_id, rootAgent.agent_id)).tiles;
    const workerTile = tiles.find((tile) => tile.tile_id === workerPaneId);
    const workTileId = work.tile_id;
    const workTile = tiles.find((tile) => tile.tile_id === workTileId);

    expect(workerTile).toMatchObject({
      tile_id: workerPaneId,
      session_id: sessionId,
      kind: 'shell',
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
      details: {
        window_name: expect.any(String),
      },
    });
    expect(workTile).toMatchObject({
      tile_id: workTileId,
      kind: 'work',
      width: expect.any(Number),
      height: expect.any(Number),
      details: {
        work_id: workDetails.work_id,
        topic: (work.details as { topic: string }).topic,
      },
    });

    const rootTile = await client.tileGet(rootAgent.tile_id, rootAgent.tile_id, rootAgent.agent_id);
    expect(rootTile).toMatchObject({
      tile_id: rootAgent.tile_id,
      session_id: sessionId,
      kind: 'root_agent',
      window_id: rootAgent.window_id,
      details: {
        agent_id: rootAgent.agent_id,
        agent_role: 'root',
        display_name: 'Root',
      },
    });

    const moved = await client.tileMove(workerPaneId, 1180, 260, rootAgent.tile_id, rootAgent.agent_id);
    expect(moved).toMatchObject({
      tile_id: workerPaneId,
      x: 1180,
      y: 260,
    });

    await waitFor(
      'moved tile layout reflected in frontend state',
      () => client.getStateTree(),
      (stateTree) => {
        const entry = moved.window_id ? stateTree.layout.entries[moved.window_id] : null;
        return entry?.x === 1180 && entry?.y === 260;
      },
      30_000,
      150,
    );

    const resized = await client.tileResize(workerPaneId, 760, 520, rootAgent.tile_id, rootAgent.agent_id);
    expect(resized).toMatchObject({
      tile_id: workerPaneId,
      width: 760,
      height: 520,
    });

    await waitFor(
      'resized tile layout reflected in frontend state',
      () => client.getStateTree(),
      (stateTree) => {
        const entry = resized.window_id ? stateTree.layout.entries[resized.window_id] : null;
        return entry?.width === 760 && entry?.height === 520;
      },
      30_000,
      150,
    );

    const resizedWork = await client.tileResize(workTileId, 420, 340, rootAgent.tile_id, rootAgent.agent_id);
    expect(resizedWork).toMatchObject({
      tile_id: workTileId,
      width: 420,
      height: 340,
      details: {
        work_id: workDetails.work_id,
      },
    });

    await client.tileCall(
      workerPaneId,
      'input_send',
      { input: "printf 'root-send-ok\\n'\n" },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    const shellRead = await waitFor(
      'root tile_call reaches any session tile',
      () => client.tileCall<{ output: string }>(workerPaneId, 'output_read', {}, rootAgent.tile_id, rootAgent.agent_id),
      (response) => response.result.output.includes('root-send-ok'),
      30_000,
      150,
    );
    expect(shellRead.result.output).toContain('root-send-ok');

    const projectionWithLogs = await waitFor(
      'tile message logs include socket tile_call entries',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.tile_message_logs.some(
          (entry) =>
            entry.channel === 'socket'
            && entry.target_id === workerPaneId
            && entry.wrapper_command === 'tile_call'
            && entry.message_name === 'input_send',
        )
        && nextProjection.tile_message_logs.some(
          (entry) =>
            entry.channel === 'socket'
            && entry.target_id === workerPaneId
            && entry.wrapper_command === 'tile_call'
            && entry.message_name === 'output_read',
        ),
      30_000,
      150,
    );
    expect(
      projectionWithLogs.tile_message_logs.filter((entry) => entry.target_id === workerPaneId).map((entry) => entry.channel),
    ).toContain('socket');
  });

  it('routes session-scoped socket commands through the session receiver', async () => {
    const projection = await createIsolatedTab(client, 'session-receiver');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in session-receiver tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;

    const shellToDestroy = await spawnWorkerShellInActiveTab(client);
    const browserToDestroy = await spawnBrowserInActiveTab(client);
    const worker = await spawnWorkerAgentInActiveTab(client);

    const registeredPaneId = await spawnWorkerShellInActiveTab(client);
    const registeredAgentId = 'agent-session-route';
    await client.agentRegister(registeredAgentId, registeredPaneId, 'Session Route');
    await client.agentPingAck(registeredAgentId);

    await client.messageTopicSubscribe('#session-route', worker.agentId);
    const topics = await client.messageTopicList(rootAgent.tile_id);
    expect(topics.some((topic) => topic.name === '#session-route')).toBe(true);

    await client.tileList(rootAgent.tile_id, rootAgent.agent_id);
    await client.networkConnect(worker.paneId, 'left', rootAgent.tile_id, 'left', rootAgent.tile_id, rootAgent.agent_id);

    const visibleNetwork = await client.listNetwork(worker.paneId, worker.agentId);
    expect(visibleNetwork.tiles.map((tile) => tile.tile_id)).toContain(rootAgent.tile_id);

    await client.sendCommand({
      command: 'message_direct',
      to_agent_id: rootAgent.agent_id,
      message: 'session receiver direct',
      sender_agent_id: worker.agentId,
      sender_tile_id: worker.paneId,
    });
    await client.sendCommand({
      command: 'message_public',
      message: 'session receiver public',
      topics: ['#session-route'],
      mentions: [],
      sender_agent_id: worker.agentId,
      sender_tile_id: worker.paneId,
    });
    await client.sendCommand({
      command: 'message_network',
      message: 'session receiver network',
      sender_agent_id: worker.agentId,
      sender_tile_id: worker.paneId,
    });
    await client.sendCommand({
      command: 'message_root',
      message: 'session receiver root',
      sender_agent_id: worker.agentId,
      sender_tile_id: worker.paneId,
    });

    await client.networkDisconnect(worker.paneId, 'left', rootAgent.tile_id, rootAgent.agent_id);
    await client.messageTopicUnsubscribe('#session-route', worker.agentId);
    await client.sendCommand({
      command: 'agent_unregister',
      agent_id: registeredAgentId,
    });
    await client.tileDestroy(shellToDestroy, rootAgent.tile_id, rootAgent.agent_id);
    await client.tileDestroy(browserToDestroy, rootAgent.tile_id, rootAgent.agent_id);

    const expectedWrappers = [
      'tile_create',
      'tile_destroy',
      'agent_register',
      'agent_ping_ack',
      'message_topic_list',
      'network_list',
      'tile_list',
      'network_connect',
      'network_disconnect',
      'message_direct',
      'message_public',
      'message_network',
      'message_root',
      'message_topic_subscribe',
      'message_topic_unsubscribe',
      'agent_unregister',
    ];

    const projectionWithSessionLogs = await waitFor(
      'session-scoped wrapper commands appear in session-targeted message logs',
      () => client.getProjection(),
      (nextProjection) =>
        expectedWrappers.every((wrapperCommand) =>
          nextProjection.tile_message_logs.some(
            (entry) =>
              entry.channel === 'socket'
              && entry.layer === 'socket'
              && entry.target_kind === 'session'
              && entry.target_id === sessionId
              && entry.wrapper_command === wrapperCommand
              && entry.message_name === wrapperCommand,
          )
          && nextProjection.tile_message_logs.some(
            (entry) =>
              entry.channel === 'socket'
              && entry.layer === 'message'
              && entry.target_kind === 'session'
              && entry.target_id === sessionId
              && entry.wrapper_command === wrapperCommand
              && entry.message_name === wrapperCommand,
          )
        ),
      60_000,
      200,
    );

    expect(
      projectionWithSessionLogs.tile_message_logs
        .filter((entry) => entry.target_kind === 'session' && entry.target_id === sessionId)
        .map((entry) => entry.wrapper_command),
    ).toEqual(expect.arrayContaining(expectedWrappers));
  });

  it('routes message_root and message_network inside the sender session', async () => {
    const projection = await createIsolatedTab(client, 'worker-msgs');
    const sessionId = projection.active_tab_id!;
    const root = await waitFor(
      'root agent in worker-msgs tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(root)!;
    const rootSubscription = await openAgentEventSubscription(runtime.socketPath, rootAgent.agent_id);

    const firstWorkerPane = await spawnWorkerShellInActiveTab(client);
    const secondWorkerPane = await spawnWorkerShellInActiveTab(client);
    await client.agentRegister('agent-network-a', firstWorkerPane, 'Worker A');
    await client.agentRegister('agent-network-b', secondWorkerPane, 'Worker B');
    const firstWorkerSubscription = await openAgentEventSubscription(runtime.socketPath, 'agent-network-a');
    const secondWorkerSubscription = await openAgentEventSubscription(runtime.socketPath, 'agent-network-b');
    const senderProjection = await waitFor(
      'registered worker display name',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === sessionId
        && nextProjection.agents.some((agent) => agent.agent_id === 'agent-network-a'),
      30_000,
      150,
    );
    const senderLabel =
      senderProjection.agents.find((agent) => agent.agent_id === 'agent-network-a')?.display_name ?? 'Agent';

    try {
      await client.sendCommand({
        command: 'message_root',
        message: 'need session help',
        sender_agent_id: 'agent-network-a',
        sender_tile_id: firstWorkerPane,
      });
      const rootEvents = await collectAgentEvents(
        rootSubscription,
        (events) =>
          events.some(
            (event) =>
              event.kind === 'direct'
              && event.message === 'need session help'
              && event.to_agent_id === rootAgent.agent_id,
          ),
        10_000,
      );
      const rootEvent = rootEvents.find((event) => event.message === 'need session help')!;
      expect(rootEvent.message).toBe('need session help');
      expect(rootEvent.to_agent_id).toBe(rootAgent.agent_id);

      await client.sendCommand({
        command: 'message_network',
        message: 'network sync',
        sender_agent_id: 'agent-network-a',
        sender_tile_id: firstWorkerPane,
      });
      const networkEvents = await collectAgentEvents(
        secondWorkerSubscription,
        (events) => events.some((event) => event.kind === 'direct' && event.message === 'network sync'),
        10_000,
      );
      const networkEvent = networkEvents.find((event) => event.message === 'network sync')!;
      expect(networkEvent.message).toBe('network sync');
      expect(networkEvent.kind).toBe('direct');

      const chatterProjection = await waitFor(
        'network/root chatter lines',
        () => client.getProjection(),
        (nextProjection) =>
          nextProjection.active_tab_id === sessionId
          && nextProjection.chatter.some((entry) => entry.display_text === `${senderLabel} -> Root: need session help`)
          && nextProjection.chatter.some((entry) => entry.display_text === `${senderLabel} -> Network: network sync`),
        30_000,
        150,
      );
      expect(
        chatterProjection.chatter.some(
          (entry) => entry.display_text === `${senderLabel} -> Root: need session help`,
        ),
      ).toBe(true);
      expect(
        chatterProjection.chatter.some(
          (entry) => entry.display_text === `${senderLabel} -> Network: network sync`,
        ),
      ).toBe(true);
    } finally {
      rootSubscription.close();
      firstWorkerSubscription.close();
      secondWorkerSubscription.close();
    }
  });

  it('drives browser tiles through browser_drive', async () => {
    const projection = await createIsolatedTab(client, 'browser-drive');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in browser-drive tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const worker = await spawnWorkerAgentInActiveTab(client);
    const browserPaneId = await spawnBrowserInActiveTab(client);
    const foreignBrowserPaneId = await spawnBrowserInActiveTab(client);

    await client.sendCommand({
      command: 'browser_load',
      tile_id: browserPaneId,
      path: 'tests/fixtures/browser-drive.html',
      sender_agent_id: rootAgent.agent_id,
      sender_tile_id: rootAgent.tile_id,
    });
    await client.sendCommand({
      command: 'browser_load',
      tile_id: foreignBrowserPaneId,
      path: 'tests/fixtures/browser-drive.html',
      sender_agent_id: rootAgent.agent_id,
      sender_tile_id: rootAgent.tile_id,
    });

    const rootTitle = await waitFor(
      'root browser_drive title read',
      () => client.browserDrive<string>(
        browserPaneId,
        'dom_query',
        { js: 'document.title' },
        rootAgent.tile_id,
        rootAgent.agent_id,
      ),
      (response) => response.result === 'browser-drive-fixture',
      30_000,
      150,
    );
    expect(rootTitle.result).toBe('browser-drive-fixture');

    await client.networkConnect(worker.paneId, 'left', browserPaneId, 'left', rootAgent.tile_id, rootAgent.agent_id);

    await expect(
      client.browserDrive(
        foreignBrowserPaneId,
        'dom_query',
        { js: 'document.title' },
        worker.paneId,
        worker.agentId,
      ),
    ).rejects.toThrow(/sender network/i);

    const visibleBrowserNetwork = await waitFor(
      'worker visible browser on local network',
      () => client.listNetwork(worker.paneId, worker.agentId, 'browser'),
      (component) => component.tiles.some((tile) => tile.tile_id === browserPaneId),
      30_000,
      150,
    );
    expect(visibleBrowserNetwork.sender_tile_id).toBe(worker.paneId);

    const typed = await client.browserDrive<{ value: string }>(
      browserPaneId,
      'type',
      { selector: '#name', text: 'Shenzhen', clear: true },
      worker.paneId,
      worker.agentId,
    );
    expect(typed.result.value).toBe('Shenzhen');

    const clicked = await client.browserDrive<{ clicked: boolean }>(
      browserPaneId,
      'click',
      { selector: '#apply' },
      worker.paneId,
      worker.agentId,
    );
    expect(clicked.result.clicked).toBe(true);

    const query = await waitFor(
      'worker browser_drive dom_query result',
      () => client.browserDrive<{ result: string; clicks: string }>(
        browserPaneId,
        'dom_query',
        {
          js: `({
            result: document.querySelector('#result')?.textContent ?? '',
            clicks: document.querySelector('#counter')?.textContent ?? ''
          })`,
        },
        worker.paneId,
        worker.agentId,
      ),
      (response) => response.result.result === 'hello Shenzhen' && response.result.clicks === '1',
      30_000,
      150,
    );
    expect(query.result).toEqual({
      result: 'hello Shenzhen',
      clicks: '1',
    });

    const evalResult = await client.browserDrive<string>(
      browserPaneId,
      'eval',
      {
        js: `
document.body.dataset.driven = 'yes';
return document.body.dataset.driven;
`,
      },
      worker.paneId,
      worker.agentId,
    );
    expect(evalResult.result).toBe('yes');
  });

  it('routes command-bar sudo, dm, and cm messages from User', async () => {
    const projection = await createIsolatedTab(client, 'sudo-cmd');
    const sessionId = projection.active_tab_id!;
    const root = await waitFor(
      'root agent in sudo-cmd tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(root)!;
    const worker = await spawnWorkerAgentInActiveTab(client);
    const workerProjection = await waitFor(
      'worker agent details in sudo-cmd tab',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === sessionId
        && nextProjection.agents.some((agent) => agent.agent_id === worker.agentId && agent.alive),
      60_000,
      150,
    );
    const workerAgent = workerProjection.agents.find((agent) => agent.agent_id === worker.agentId)!;
    const workerDisplayIndex = workerAgent.display_name.replace(/^Agent\s+/, '');
    const rootSubscription = await openAgentEventSubscription(runtime.socketPath, rootAgent.agent_id);
    const workerSubscription = await openAgentEventSubscription(runtime.socketPath, worker.agentId);

    try {
      await client.commandBarOpen();
      await client.commandBarSetText('sudo please inspect this session');
      await client.commandBarSubmit();

      const rootEvents = await collectAgentEvents(
        rootSubscription,
        (events) =>
          events.some(
            (event) =>
              event.kind === 'direct'
              && event.message === 'please inspect this session'
              && event.to_agent_id === rootAgent.agent_id,
          ),
        10_000,
      );
      const rootEvent = rootEvents.find((event) => event.message === 'please inspect this session')!;
      expect(rootEvent.from_display_name).toBe('User');

      await client.commandBarOpen();
      await client.commandBarSetText(`dm ${workerDisplayIndex} hello worker`);
      await client.commandBarSubmit();

      const workerEvents = await collectAgentEvents(
        workerSubscription,
        (events) =>
          events.some(
            (event) =>
              event.kind === 'direct'
              && event.message === 'hello worker'
              && event.to_agent_id === worker.agentId,
          ),
        10_000,
      );
      const workerEvent = workerEvents.find((event) => event.message === 'hello worker')!;
      expect(workerEvent.from_display_name).toBe('User');

      await client.commandBarOpen();
      await client.commandBarSetText('cm hey all!');
      await client.commandBarSubmit();

      const rootBroadcasts = await collectAgentEvents(
        rootSubscription,
        (events) =>
          events.some(
            (event) =>
              event.kind === 'public'
              && event.message === 'hey all!',
          ),
        10_000,
      );
      const rootBroadcast = rootBroadcasts.find((event) => event.message === 'hey all!')!;
      expect(rootBroadcast.from_display_name).toBe('User');

      const chatterProjection = await waitFor(
        'sudo dm cm chatter lines',
        () => client.getProjection(),
        (nextProjection) =>
          nextProjection.active_tab_id === sessionId
          && nextProjection.chatter.some((entry) => entry.display_text === 'User -> Root: please inspect this session')
          && nextProjection.chatter.some(
            (entry) => entry.display_text === `User -> ${workerAgent.display_name}: hello worker`,
          )
          && nextProjection.chatter.some((entry) => entry.display_text === 'User -> Chatter: hey all!'),
        30_000,
        150,
      );
      expect(
        chatterProjection.chatter.some(
          (entry) => entry.display_text === 'User -> Root: please inspect this session',
        ),
      ).toBe(true);
      expect(
        chatterProjection.chatter.some(
          (entry) => entry.display_text === `User -> ${workerAgent.display_name}: hello worker`,
        ),
      ).toBe(true);
      expect(
        chatterProjection.chatter.some(
          (entry) => entry.display_text === 'User -> Chatter: hey all!',
        ),
      ).toBe(true);
    } finally {
      rootSubscription.close();
      workerSubscription.close();
    }
  });
});
