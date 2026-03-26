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
  kind: 'direct' | 'public' | 'channel' | 'network' | 'root' | 'system' | 'ping';
  from_agent_id?: string | null;
  from_display_name: string;
  to_agent_id?: string | null;
  to_display_name?: string | null;
  message: string;
  channels: string[];
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

interface BrowserScreenshotResult {
  mimeType: string;
  dataBase64: string;
}

interface BrowserTextScreenshotResult {
  format: 'braille' | 'ascii' | 'ansi' | 'text';
  text: string;
  columns: number;
  rows: number;
}

const GAMEPAD_BUTTON_NAMES = ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'] as const;

function expectPngScreenshot(result: BrowserScreenshotResult) {
  expect(result.mimeType).toBe('image/png');
  expect(result.dataBase64.length).toBeGreaterThan(100);
  const bytes = Buffer.from(result.dataBase64, 'base64');
  expect(bytes.length).toBeGreaterThan(100);
  expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
}

function expectBrailleScreenshot(result: BrowserTextScreenshotResult, columns: number) {
  expect(result.format).toBe('braille');
  expect(result.columns).toBe(columns);
  expect(result.rows).toBeGreaterThan(0);
  expect(result.text.length).toBeGreaterThan(10);
  expect(result.text).toMatch(/[\u2801-\u28ff]/u);
}

function expectBrailleScreenshotShape(result: BrowserTextScreenshotResult, columns: number) {
  expect(result.format).toBe('braille');
  expect(result.columns).toBe(columns);
  expect(result.rows).toBeGreaterThan(0);
  expect(result.text.length).toBeGreaterThan(10);
  expect(result.text).toMatch(/[\u2800-\u28ff]/u);
}

function expectAsciiScreenshot(result: BrowserTextScreenshotResult, columns: number) {
  expect(result.format).toBe('ascii');
  expect(result.columns).toBe(columns);
  expect(result.rows).toBeGreaterThan(0);
  expect(result.text.length).toBeGreaterThan(10);
  expect(result.text).not.toContain('\u001b[');
  expect(result.text).not.toMatch(/[\u2800-\u28ff]/u);
  expect(result.text.replace(/\s/g, '').length).toBeGreaterThan(0);
}

function expectAsciiScreenshotShape(result: BrowserTextScreenshotResult, columns: number) {
  expect(result.format).toBe('ascii');
  expect(result.columns).toBe(columns);
  expect(result.rows).toBeGreaterThan(0);
  expect(result.text.length).toBeGreaterThan(10);
  expect(result.text).not.toContain('\u001b[');
  expect(result.text).not.toMatch(/[\u2800-\u28ff]/u);
}

function expectAnsiScreenshot(result: BrowserTextScreenshotResult, columns: number) {
  expect(result.format).toBe('ansi');
  expect(result.columns).toBe(columns);
  expect(result.rows).toBeGreaterThan(0);
  expect(result.text.length).toBeGreaterThan(10);
  expect(result.text).toMatch(/\u001b\[[0-9;]*m/);
}

function expectTextScreenshot(result: BrowserTextScreenshotResult, columns: number) {
  expect(result.format).toBe('text');
  expect(result.columns).toBe(columns);
  expect(result.rows).toBeGreaterThan(0);
  expect(result.text.length).toBeGreaterThan(10);
  expect(result.text).not.toContain('\u001b[');
  expect(result.text).not.toMatch(/[\u2800-\u28ff]/u);
  expect(result.text).toContain('SCORE 1200');
  expect(result.text).toContain('LIVES x3');
  expect(result.text).toContain('PRESS START');

  const lines = result.text.split('\n');
  const scoreLine = lines.findIndex((line) => line.includes('SCORE 1200'));
  const livesLine = lines.findIndex((line) => line.includes('LIVES x3'));
  const promptLine = lines.findIndex((line) => line.includes('PRESS START'));
  expect(scoreLine).toBeGreaterThanOrEqual(0);
  expect(livesLine).toBeGreaterThanOrEqual(0);
  expect(promptLine).toBeGreaterThan(scoreLine + 2);
  expect(Math.abs(scoreLine - livesLine)).toBeLessThanOrEqual(1);

  const scoreColumn = lines[scoreLine]!.indexOf('SCORE 1200');
  const livesColumn = lines[livesLine]!.indexOf('LIVES x3');
  expect(scoreColumn).toBeGreaterThanOrEqual(0);
  expect(livesColumn - scoreColumn).toBeGreaterThan(20);
}

function expectImageDerivedTextScreenshot(result: BrowserTextScreenshotResult, columns: number) {
  expect(result.format).toBe('text');
  expect(result.columns).toBe(columns);
  expect(result.rows).toBeGreaterThan(0);
  expect(result.text.length).toBeGreaterThan(10);
  expect(result.text).not.toContain('\u001b[');
  expect(result.text).not.toMatch(/[\u2800-\u28ff]/u);
}

function tinyNesRomBase64() {
  const header = Uint8Array.from([
    0x4e, 0x45, 0x53, 0x1a,
    0x01,
    0x01,
    0x00,
    0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const prg = new Uint8Array(16 * 1024).fill(0xea);
  prg.set([0x78, 0xd8, 0x4c, 0x00, 0x80], 0);
  prg[0x3ffa] = 0x00;
  prg[0x3ffb] = 0x80;
  prg[0x3ffc] = 0x00;
  prg[0x3ffd] = 0x80;
  prg[0x3ffe] = 0x00;
  prg[0x3fff] = 0x80;
  const chr = new Uint8Array(8 * 1024);
  return Buffer.from(Uint8Array.from([...header, ...prg, ...chr])).toString('base64');
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

async function spawnBrowserInActiveTab(
  client: HerdTestClient,
  options?: { browserIncognito?: boolean },
): Promise<string> {
  const before = await client.getProjection();
  const knownPaneIds = new Set(before.active_tab_terminals.map((terminal) => terminal.id));
  await client.tileCreate('browser', {
    parentSessionId: before.active_tab_id,
    parentTileId: before.selected_tile_id,
    browserIncognito: options?.browserIncognito ?? false,
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
              enum_values: ['click', 'select', 'type', 'dom_query', 'eval', 'screenshot'],
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
              name: 'select',
              args: [
                {
                  name: 'selector',
                  type: 'string',
                  required: true,
                  description: 'CSS selector for the target select element.',
                },
                {
                  name: 'value',
                  type: 'string',
                  required: true,
                  description: 'Option value to select.',
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
            expect.objectContaining({
              name: 'screenshot',
              args: [
                {
                  name: 'format',
                  type: 'string',
                  required: false,
                  description: 'Screenshot output format. Defaults to image.',
                  enum_values: ['image', 'braille', 'ascii', 'ansi', 'text'],
                },
                {
                  name: 'columns',
                  type: 'number',
                  required: false,
                  description: 'Requested text width in characters when format is braille, ascii, ansi, or text.',
                },
              ],
            }),
          ]),
        }),
      ]),
    );

    const rootBrowserTile = await client.tileGet(browserPaneId, rootAgent.tile_id, rootAgent.agent_id);
    expect(rootBrowserTile.tile_id).toBe(browserPaneId);
    expect(rootBrowserTile.responds_to).toEqual(browserTile.responds_to);
    expect(rootBrowserTile.message_api).toEqual(browserTile.message_api);

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

  it('animates network wires after a network_call', async () => {
    const projection = await createIsolatedTab(client, 'worker-network-signal');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in worker-network-signal tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const worker = await spawnWorkerAgentInActiveTab(client);
    const shellPaneId = await spawnWorkerShellInActiveTab(client);

    await client.networkConnect(worker.paneId, 'left', shellPaneId, 'right', rootAgent.tile_id, rootAgent.agent_id);

    await waitFor(
      'network wire is visible on canvas',
      () => client.testDomQuery<number>('return document.querySelectorAll(".network-line").length;'),
      (count) => count > 0,
      30_000,
      100,
    );

    await client.networkCall(shellPaneId, 'output_read', {}, worker.paneId, worker.agentId);

    const signalSnapshot = await waitFor(
      'network signal pulse appears on the wire',
      () =>
        client.testDomQuery<{
          lineCount: number;
          dotCount: number;
          fromTileId: string | null;
          toTileId: string | null;
          senderPortBlink: boolean;
          receiverPortBlink: boolean;
        }>(`
          const line = document.querySelector('.network-signal-line');
          const senderPort = document.querySelector('[data-port-tile="${worker.paneId}"][data-port="left"]');
          const receiverPort = document.querySelector('[data-port-tile="${shellPaneId}"][data-port="right"]');
          return {
            lineCount: document.querySelectorAll('.network-signal-line').length,
            dotCount: document.querySelectorAll('.network-signal-dot').length,
            fromTileId: line?.getAttribute('data-from-tile-id') ?? null,
            toTileId: line?.getAttribute('data-to-tile-id') ?? null,
            senderPortBlink: senderPort?.getAttribute('data-port-send-active') === 'true'
              && senderPort?.querySelector('.port-light-left')?.classList.contains('light-active-send'),
            receiverPortBlink: receiverPort?.getAttribute('data-port-receive-active') === 'true'
              && receiverPort?.querySelector('.port-light-right')?.classList.contains('light-active-receive'),
          };
        `),
      (snapshot) =>
        snapshot.lineCount > 0
        && snapshot.dotCount > 0
        && snapshot.senderPortBlink
        && snapshot.receiverPortBlink,
      30_000,
      75,
    );

    expect(signalSnapshot.fromTileId).toBe(worker.paneId);
    expect(signalSnapshot.toTileId).toBe(shellPaneId);
    expect(signalSnapshot.senderPortBlink).toBe(true);
    expect(signalSnapshot.receiverPortBlink).toBe(true);
  });

  it('suppresses network sparks when disabled in the sidebar settings', async () => {
    const projection = await createIsolatedTab(client, 'worker-network-signal-disabled');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in worker-network-signal-disabled tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const worker = await spawnWorkerAgentInActiveTab(client);
    const shellPaneId = await spawnWorkerShellInActiveTab(client);

    await client.networkConnect(worker.paneId, 'left', shellPaneId, 'right', rootAgent.tile_id, rootAgent.agent_id);

    await waitFor(
      'network wire is visible on canvas',
      () => client.testDomQuery<number>('return document.querySelectorAll(".network-line").length;'),
      (count) => count > 0,
      30_000,
      100,
    );

    await client.sidebarOpen();
    await client.testDomQuery(`
      document.querySelector('.wire-sparks-toggle')?.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }));
      return document.querySelector('.wire-sparks-toggle')?.getAttribute('aria-pressed') ?? '';
    `);

    await waitFor(
      'wire sparks setting disables spark rendering',
      () => client.testDomQuery<boolean>('return document.querySelector(".wire-sparks-toggle")?.getAttribute("aria-pressed") === "true";'),
      (enabled) => enabled === false,
      30_000,
      100,
    );

    await client.networkCall(shellPaneId, 'output_read', {}, worker.paneId, worker.agentId);

    await waitFor(
      'network call log arrives while sparks are disabled',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.tile_message_logs.some(
          (entry) =>
            entry.wrapper_command === 'network_call'
            && entry.target_id === shellPaneId
            && entry.related_tile_ids.includes(worker.paneId),
        ),
      30_000,
      150,
    );

    const sparkSnapshot = await client.testDomQuery<{ lineCount: number; dotCount: number }>(`
      return {
        lineCount: document.querySelectorAll('.network-signal-line').length,
        dotCount: document.querySelectorAll('.network-signal-dot').length,
      };
    `);

    expect(sparkSnapshot.lineCount).toBe(0);
    expect(sparkSnapshot.dotCount).toBe(0);
  });

  it('returns self_info for a worker tile and renders an agent-local self_display_draw frame in the terminal display drawer', async () => {
    const projection = await createIsolatedTab(client, 'agent-display-draw');
    const sessionId = projection.active_tab_id!;
    await waitFor(
      'root agent in agent-display-draw tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const worker = await spawnWorkerAgentInActiveTab(client);
    const frameText = '\u001b[38;2;255;90;90mAB\u001b[0m\n\u001b[48;2;40;120;255mCD\u001b[0m';

    const selfInfo = await client.sendCommand<{
      tile_id: string;
      kind: string;
      message_api: Array<{ name: string }>;
    }>({
      command: 'self_info',
      sender_agent_id: worker.agentId,
      sender_tile_id: worker.paneId,
    });

    expect(selfInfo.tile_id).toBe(worker.paneId);
    expect(selfInfo.kind).toBe('agent');
    expect(selfInfo.message_api.some((message) => message.name === 'get')).toBe(true);

    await client.sendCommand({
      command: 'self_display_draw',
      text: frameText,
      columns: 2,
      rows: 2,
      sender_agent_id: worker.agentId,
      sender_tile_id: worker.paneId,
    });

    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${worker.paneId}"] .display-toggle-btn')?.click();
      return true;
    `);

    const displayState = await waitFor(
      'agent display drawer renders centered ansi frame',
      () =>
        client.testDomQuery<{
          open: boolean;
          text: string;
          ansiSegments: number;
          horizontalCenterDelta: number;
          verticalCenterDelta: number;
        }>(`
          const tile = document.querySelector('[data-tile-id="${worker.paneId}"]');
          const drawer = tile?.querySelector('.terminal-display');
          const body = drawer?.querySelector('.terminal-display-body');
          const frame = drawer?.querySelector('.terminal-display-frame');
          const bodyRect = body?.getBoundingClientRect();
          const frameRect = frame?.getBoundingClientRect();
          return {
            open: Boolean(drawer),
            text: frame?.textContent ?? '',
            ansiSegments: frame?.querySelectorAll('[data-ansi-segment="true"]').length ?? 0,
            horizontalCenterDelta: bodyRect && frameRect
              ? Math.abs((frameRect.left + frameRect.width / 2) - (bodyRect.left + bodyRect.width / 2))
              : -1,
            verticalCenterDelta: bodyRect && frameRect
              ? Math.abs((frameRect.top + frameRect.height / 2) - (bodyRect.top + bodyRect.height / 2))
              : -1,
          };
        `),
      (state) =>
        state.open
        && state.text.includes('AB')
        && state.text.includes('CD')
        && state.ansiSegments >= 2
        && state.horizontalCenterDelta >= 0
        && state.horizontalCenterDelta < 3
        && state.verticalCenterDelta >= 0
        && state.verticalCenterDelta < 3,
      30_000,
      150,
    );

    expect(displayState.text).toContain('AB');
    expect(displayState.text).toContain('CD');
    expect(displayState.ansiSegments).toBeGreaterThanOrEqual(2);
  });

  it('renders tile-local LED and status strips for both agent and plain shell tiles', async () => {
    const projection = await createIsolatedTab(client, 'tile-signal-strip');
    const sessionId = projection.active_tab_id!;
    await waitFor(
      'root agent in tile-signal-strip tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const worker = await spawnWorkerAgentInActiveTab(client);
    const shellTileId = await spawnWorkerShellInActiveTab(client);
    await client.driverTileResize(worker.paneId, 320, 420);
    await client.waitForIdle(30_000, 150);

    await client.sendCommand({
      command: 'self_led_control',
      commands: [
        { op: 'on', led: 1, color: 'red' },
        { op: 'on', led: 3, color: 'lime' },
        { op: 'sleep', ms: 200 },
      ],
      sender_agent_id: worker.agentId,
      sender_tile_id: worker.paneId,
    });
    await client.sendCommand({
      command: 'self_display_status',
      text: '\u001b[33mATTENTION ATTENTION ATTENTION ATTENTION ATTENTION ATTENTION ATTENTION ATTENTION\u001b[0m',
      sender_agent_id: worker.agentId,
      sender_tile_id: worker.paneId,
    });

    await client.sendCommand({
      command: 'self_led_control',
      pattern_name: 'solid',
      pattern_args: {
        primary_color: 'rgb(0, 170, 255)',
        delay_ms: 180,
      },
      sender_tile_id: shellTileId,
    });

    const initialSignalState = await waitFor(
      'tile-local LED strips render with idle shell status',
      () =>
        client.testDomQuery<{
          agentHeaderLedCount: number;
          agentInfoStripLedCount: number;
          agentColors: string[];
          agentStatusText: string;
          agentMarqueeActive: boolean;
          agentTitleToLedGap: number;
          shellHeaderLedCount: number;
          shellInfoStripLedCount: number;
          shellStatusText: string;
          shellTitleToLedGap: number;
          headerIdentityCount: number;
        }>(`
          const summarize = (tileId) => {
            const tile = document.querySelector('[data-tile-id="' + tileId + '"]');
            const headerLeds = Array.from(tile?.querySelectorAll('.header-bar .tile-signal-led[data-on="true"]') ?? []);
            const infoStripLeds = Array.from(tile?.querySelectorAll('.info-strip .tile-signal-led[data-on="true"]') ?? []);
            const titleRect = tile?.querySelector('.header-bar .designator')?.getBoundingClientRect();
            const ledBarRect = tile?.querySelector('.header-bar .tile-signal-led-bar')?.getBoundingClientRect();
            return {
              headerLedCount: headerLeds.length,
              infoStripLedCount: infoStripLeds.length,
              colors: headerLeds.map((led) => led.getAttribute('data-color') ?? ''),
              statusText: tile?.querySelector('.tile-signal-status-viewport')?.textContent ?? '',
              marqueeActive: tile?.querySelector('.tile-signal-status')?.getAttribute('data-marquee-active') === 'true',
              titleToLedGap: titleRect && ledBarRect ? Math.abs(ledBarRect.left - titleRect.right) : -1,
              identityCount: tile?.querySelectorAll('.header-identity-item').length ?? 0,
            };
          };
          const agent = summarize('${worker.paneId}');
          const shell = summarize('${shellTileId}');
          return {
            agentHeaderLedCount: agent.headerLedCount,
            agentInfoStripLedCount: agent.infoStripLedCount,
            agentColors: agent.colors,
            agentStatusText: agent.statusText,
            agentMarqueeActive: agent.marqueeActive,
            agentTitleToLedGap: agent.titleToLedGap,
            shellHeaderLedCount: shell.headerLedCount,
            shellInfoStripLedCount: shell.infoStripLedCount,
            shellStatusText: shell.statusText,
            shellTitleToLedGap: shell.titleToLedGap,
            headerIdentityCount: agent.identityCount + shell.identityCount,
          };
        `),
      (state) =>
        state.agentHeaderLedCount >= 2
        && state.agentInfoStripLedCount === 0
        && state.agentColors.includes('red')
        && state.agentColors.includes('lime')
        && state.agentTitleToLedGap >= 0
        && state.agentTitleToLedGap < 12
        && state.shellHeaderLedCount === 8
        && state.shellInfoStripLedCount === 0
        && state.shellStatusText.includes('ONLINE')
        && state.shellStatusText.includes(shellTileId)
        && state.shellTitleToLedGap >= 0
        && state.shellTitleToLedGap < 12
        && state.headerIdentityCount === 0,
      30_000,
      150,
    );

    expect(initialSignalState.agentHeaderLedCount).toBeGreaterThanOrEqual(2);
    expect(initialSignalState.shellHeaderLedCount).toBe(8);
    expect(initialSignalState.shellStatusText).toContain('ONLINE');
    expect(initialSignalState.shellStatusText).toContain(shellTileId);

    await client.sendCommand({
      command: 'self_display_status',
      text: '\u001b[36mSHELL READY\u001b[0m',
      sender_tile_id: shellTileId,
    });

    const shellStatusUpdated = await waitFor(
      'plain shell status strip updates',
      () =>
        client.testDomQuery<string>(`
          return document.querySelector('[data-tile-id="${shellTileId}"] .tile-signal-status-viewport')?.textContent ?? '';
        `),
      (text) => text.includes('SHELL READY'),
      30_000,
      150,
    );

    expect(shellStatusUpdated).toContain('SHELL READY');
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

    await client.messageChannelSubscribe('#session-route', worker.agentId, rootAgent.tile_id, rootAgent.agent_id);
    const channels = await client.messageChannelList(rootAgent.tile_id, rootAgent.agent_id);
    expect(channels.some((channel) => channel.name === '#session-route')).toBe(true);

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
      command: 'message_channel',
      channel_name: '#session-route',
      message: 'session receiver public',
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
    await client.messageChannelUnsubscribe('#session-route', worker.agentId, rootAgent.tile_id, rootAgent.agent_id);
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
      'message_channel_list',
      'network_list',
      'tile_list',
      'network_connect',
      'network_disconnect',
      'message_direct',
      'message_channel',
      'message_network',
      'message_root',
      'message_channel_subscribe',
      'message_channel_unsubscribe',
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

    const screenshot = await client.browserDrive<BrowserScreenshotResult>(
      browserPaneId,
      'screenshot',
      {},
      worker.paneId,
      worker.agentId,
    );
    expectPngScreenshot(screenshot.result);

    const brailleScreenshot = await client.browserDrive<BrowserTextScreenshotResult>(
      browserPaneId,
      'screenshot',
      { format: 'braille', columns: 24 },
      worker.paneId,
      worker.agentId,
    );
    expectBrailleScreenshot(brailleScreenshot.result, 24);

    const asciiScreenshot = await client.browserDrive<BrowserTextScreenshotResult>(
      browserPaneId,
      'screenshot',
      { format: 'ascii', columns: 24 },
      worker.paneId,
      worker.agentId,
    );
    expectAsciiScreenshot(asciiScreenshot.result, 24);

    const ansiScreenshot = await client.browserDrive<BrowserTextScreenshotResult>(
      browserPaneId,
      'screenshot',
      { format: 'ansi', columns: 24 },
      worker.paneId,
      worker.agentId,
    );
    expectAnsiScreenshot(ansiScreenshot.result, 24);

    await client.sendCommand({
      command: 'browser_load',
      tile_id: browserPaneId,
      path: 'tests/fixtures/browser-text-layout.html',
      sender_agent_id: rootAgent.agent_id,
      sender_tile_id: rootAgent.tile_id,
    });
    await waitFor(
      'browser text layout fixture loaded',
      () => client.browserDrive<string>(
        browserPaneId,
        'dom_query',
        { js: 'document.title' },
        worker.paneId,
        worker.agentId,
      ),
      (response) => response.result === 'browser-text-layout',
      30_000,
      150,
    );

    const textScreenshot = await client.browserDrive<BrowserTextScreenshotResult>(
      browserPaneId,
      'screenshot',
      { format: 'text', columns: 80 },
      worker.paneId,
      worker.agentId,
    );
    expectTextScreenshot(textScreenshot.result, 80);
  });

  it('exposes browser extension metadata and enforces sender-bound extension calls', async () => {
    const projection = await createIsolatedTab(client, 'browser-extension-holdem');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in browser-extension-holdem tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const northWorker = await spawnWorkerAgentInActiveTab(client);
    const eastWorker = await spawnWorkerAgentInActiveTab(client);
    const browserPaneId = await spawnBrowserInActiveTab(client);

    await client.sendCommand({
      command: 'browser_load',
      tile_id: browserPaneId,
      path: 'extensions/browser/texas-holdem/index.html',
      sender_agent_id: rootAgent.agent_id,
      sender_tile_id: rootAgent.tile_id,
    });

    await waitFor(
      'texas holdem page loads',
      () => client.tileGet(browserPaneId, rootAgent.tile_id, rootAgent.agent_id),
      (tile) => (tile.details as any)?.current_url?.includes('extensions/browser/texas-holdem/index.html') === true,
      30_000,
      150,
    );

    await client.networkConnect(northWorker.paneId, 'left', browserPaneId, 'left', rootAgent.tile_id, rootAgent.agent_id);
    await client.networkConnect(eastWorker.paneId, 'right', browserPaneId, 'right', rootAgent.tile_id, rootAgent.agent_id);

    const rootBrowserTile = await waitFor(
      'root sees loaded browser extension metadata',
      () => client.tileGet(browserPaneId, rootAgent.tile_id, rootAgent.agent_id),
      (tile) => Boolean((tile.details as any)?.extension),
      30_000,
      150,
    );
    expect(rootBrowserTile.responds_to).toContain('extension_call');
    expect(rootBrowserTile.message_api.find((message) => message.name === 'call')?.args?.[0]?.enum_values).toContain('extension_call');
    expect(rootBrowserTile.message_api.find((message) => message.name === 'extension_call')?.subcommands?.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'state',
        'claim_seat',
        'register_commentator',
        'start_match',
        'act',
        'reveal_private',
        'reveal_all',
      ]),
    );
    expect((rootBrowserTile.details as any).extension).toEqual(
      expect.objectContaining({
        extension_id: 'texas-holdem',
        label: "Texas Hold'em",
        source_path: 'extensions/browser/texas-holdem/index.html',
      }),
    );

    const workerBrowserTile = await waitFor(
      'worker sees extension_call on connected browser',
      () => client.networkGet(browserPaneId, northWorker.paneId, northWorker.agentId),
      (tile) => tile.responds_to.includes('extension_call'),
      30_000,
      150,
    );
    expect(workerBrowserTile.responds_to).toContain('extension_call');

    const commentator = await client.tileCall<{ state: { commentator: { name: string } | null } }>(
      browserPaneId,
      'extension_call',
      {
        method: 'register_commentator',
        args: { name: 'Booth' },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expect(commentator.result.state.commentator?.name).toBe('Booth');

    await client.browserExtensionCall(browserPaneId, 'claim_seat', { seat: 'north', name: 'North' }, northWorker.paneId, northWorker.agentId);
    await client.browserExtensionCall(browserPaneId, 'claim_seat', { seat: 'east', name: 'East' }, eastWorker.paneId, eastWorker.agentId);

    await expect(
      client.browserExtensionCall(browserPaneId, 'register_commentator', {}, northWorker.paneId, northWorker.agentId),
    ).rejects.toThrow(/players cannot register/i);
    await expect(
      client.tileCall(
        browserPaneId,
        'extension_call',
        {
          method: 'reveal_private',
          args: {},
        },
        rootAgent.tile_id,
        rootAgent.agent_id,
      ),
    ).rejects.toThrow(/does not own a seat/i);

    const northReveal = await client.browserExtensionCall<{ seat: string; cards: string[] }>(
      browserPaneId,
      'reveal_private',
      {},
      northWorker.paneId,
      northWorker.agentId,
    );
    const eastReveal = await client.browserExtensionCall<{ seat: string; cards: string[] }>(
      browserPaneId,
      'reveal_private',
      {},
      eastWorker.paneId,
      eastWorker.agentId,
    );
    const allReveal = await client.tileCall<{ hands: Record<string, string[]> }>(
      browserPaneId,
      'extension_call',
      {
        method: 'reveal_all',
        args: {},
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );

    expect(northReveal.result.seat).toBe('north');
    expect(northReveal.result.cards).toEqual([]);
    expect(eastReveal.result.seat).toBe('east');
    expect(eastReveal.result.cards).toEqual([]);
    expect(allReveal.result.hands).toEqual({
      north: [],
      east: [],
    });
  });

  it('exposes game boy extension metadata and bundled ROM controls', async () => {
    const projection = await createIsolatedTab(client, 'browser-extension-game-boy');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in browser-extension-game-boy tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const browserPaneId = await spawnBrowserInActiveTab(client);

    await client.sendCommand({
      command: 'browser_load',
      tile_id: browserPaneId,
      path: 'extensions/browser/game-boy/index.html',
      sender_agent_id: rootAgent.agent_id,
      sender_tile_id: rootAgent.tile_id,
    });

    await waitFor(
      'game boy page loads',
      () => client.tileGet(browserPaneId, rootAgent.tile_id, rootAgent.agent_id),
      (tile) => (tile.details as any)?.current_url?.includes('extensions/browser/game-boy/index.html') === true,
      30_000,
      150,
    );

    const rootBrowserTile = await waitFor(
      'root sees loaded game boy extension metadata',
      () => client.tileGet(browserPaneId, rootAgent.tile_id, rootAgent.agent_id),
      (tile) => Boolean((tile.details as any)?.extension),
      30_000,
      150,
    );
    expect(rootBrowserTile.responds_to).toContain('extension_call');
    expect(rootBrowserTile.message_api.find((message) => message.name === 'extension_call')?.subcommands?.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'state',
        'load_bundled_rom',
        'screenshot',
        'set_button',
        'button_combo',
        'release_all_buttons',
      ]),
    );
    expect((rootBrowserTile.details as any).extension).toEqual(
      expect.objectContaining({
        extension_id: 'game-boy',
        label: 'Game Boy',
        source_path: 'extensions/browser/game-boy/index.html',
      }),
    );

    const readyState = await waitFor(
      'game boy core ready',
      () => client.tileCall<{
        core_ready: boolean;
        available_roms: Array<{ filename: string }>;
      }>(
        browserPaneId,
        'extension_call',
        {
          method: 'state',
          args: {},
        },
        rootAgent.tile_id,
        rootAgent.agent_id,
      ),
      (response) => response.result.core_ready === true,
      30_000,
      150,
    );
    expect(readyState.result.available_roms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: 'pokemon_yellow.gb' }),
      ]),
    );

    const loaded = await client.tileCall<{
      state: {
        loaded: boolean;
        rom: { filename: string; source: string };
      };
    }>(
      browserPaneId,
      'extension_call',
      {
        method: 'load_bundled_rom',
        args: { rom: 'pokemon_yellow.gb' },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expect(loaded.result.state.loaded).toBe(true);
    expect(loaded.result.state.rom).toMatchObject({
      filename: 'pokemon_yellow.gb',
      source: 'bundled',
    });

    const imageScreenshot = await client.tileCall<BrowserScreenshotResult>(
      browserPaneId,
      'extension_call',
      {
        method: 'screenshot',
        args: {},
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expectPngScreenshot(imageScreenshot.result);

    const brailleScreenshot = await client.tileCall<BrowserTextScreenshotResult>(
      browserPaneId,
      'extension_call',
      {
        method: 'screenshot',
        args: { format: 'braille', columns: 48 },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expectBrailleScreenshotShape(brailleScreenshot.result, 48);

    const asciiScreenshot = await client.tileCall<BrowserTextScreenshotResult>(
      browserPaneId,
      'extension_call',
      {
        method: 'screenshot',
        args: { format: 'ascii', columns: 48 },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expectAsciiScreenshotShape(asciiScreenshot.result, 48);

    const ansiScreenshot = await client.tileCall<BrowserTextScreenshotResult>(
      browserPaneId,
      'extension_call',
      {
        method: 'screenshot',
        args: { format: 'ansi', columns: 48 },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expectAnsiScreenshot(ansiScreenshot.result, 48);

    const textScreenshot = await client.tileCall<BrowserTextScreenshotResult>(
      browserPaneId,
      'extension_call',
      {
        method: 'screenshot',
        args: { format: 'text', columns: 48 },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expectImageDerivedTextScreenshot(textScreenshot.result, 48);

    const pressed = await client.tileCall<{
      button: string;
      pressed: boolean;
      state: { buttons: Record<string, boolean> };
    }>(
      browserPaneId,
      'extension_call',
      {
        method: 'set_button',
        args: { button: 'start', pressed: true },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expect(pressed.result.button).toBe('start');
    expect(pressed.result.state.buttons.start).toBe(true);

    for (const button of GAMEPAD_BUTTON_NAMES) {
      const buttonDown = await client.tileCall<{
        button: string;
        pressed: boolean;
        state: { buttons: Record<string, boolean> };
      }>(
        browserPaneId,
        'extension_call',
        {
          method: 'set_button',
          args: { button, pressed: true },
        },
        rootAgent.tile_id,
        rootAgent.agent_id,
      );
      expect(buttonDown.result.button).toBe(button);
      expect(buttonDown.result.state.buttons[button]).toBe(true);

      const buttonUp = await client.tileCall<{
        button: string;
        pressed: boolean;
        state: { buttons: Record<string, boolean> };
      }>(
        browserPaneId,
        'extension_call',
        {
          method: 'set_button',
          args: { button, pressed: false },
        },
        rootAgent.tile_id,
        rootAgent.agent_id,
      );
      expect(buttonUp.result.button).toBe(button);
      expect(buttonUp.result.state.buttons[button]).toBe(false);
    }

    const comboStarted = await client.tileCall<{
      sequence_length: number;
      delay_ms: number;
      hold_ms: number;
      state: { buttons: Record<string, boolean> };
    }>(
      browserPaneId,
      'extension_call',
      {
        method: 'button_combo',
        args: {
          sequence: [{ buttons: ['start'] }],
          delay_ms: 30,
          hold_ms: 10,
        },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expect(comboStarted.result.sequence_length).toBe(1);
    expect(comboStarted.result.state.buttons.start).toBe(true);

    await waitFor(
      'game boy combo releases start button',
      () => client.tileCall<{ buttons: Record<string, boolean> }>(
        browserPaneId,
        'extension_call',
        {
          method: 'state',
          args: {},
        },
        rootAgent.tile_id,
        rootAgent.agent_id,
      ),
      (response) => response.result.buttons.start === false,
      5_000,
      25,
    );

    const released = await client.tileCall<{
      state: { buttons: Record<string, boolean> };
    }>(
      browserPaneId,
      'extension_call',
      {
        method: 'release_all_buttons',
        args: {},
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expect(released.result.state.buttons.start).toBe(false);
  });

  it('exposes jsnes extension metadata and multiplayer controls', async () => {
    const projection = await createIsolatedTab(client, 'browser-extension-jsnes');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in browser-extension-jsnes tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const browserPaneId = await spawnBrowserInActiveTab(client);
    const secondPlayerPaneId = await spawnWorkerShellInActiveTab(client);

    await client.sendCommand({
      command: 'browser_load',
      tile_id: browserPaneId,
      path: 'extensions/browser/jsnes/index.html',
      sender_agent_id: rootAgent.agent_id,
      sender_tile_id: rootAgent.tile_id,
    });

    await waitFor(
      'jsnes page loads',
      () => client.tileGet(browserPaneId, rootAgent.tile_id, rootAgent.agent_id),
      (tile) => (tile.details as any)?.current_url?.includes('extensions/browser/jsnes/index.html') === true,
      30_000,
      150,
    );

    const rootBrowserTile = await waitFor(
      'root sees loaded jsnes extension metadata',
      () => client.tileGet(browserPaneId, rootAgent.tile_id, rootAgent.agent_id),
      (tile) => Boolean((tile.details as any)?.extension),
      30_000,
      150,
    );
    expect(rootBrowserTile.responds_to).toContain('extension_call');
    expect(rootBrowserTile.message_api.find((message) => message.name === 'extension_call')?.subcommands?.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'state',
        'claim_player',
        'load_rom_base64',
        'screenshot',
        'set_button',
        'button_combo',
        'release_all_buttons',
      ]),
    );
    expect((rootBrowserTile.details as any).extension).toEqual(
      expect.objectContaining({
        extension_id: 'jsnes',
        label: 'JSNES',
        source_path: 'extensions/browser/jsnes/index.html',
      }),
    );

    await client.networkConnect(
      secondPlayerPaneId,
      'right',
      browserPaneId,
      'right',
      rootAgent.tile_id,
      rootAgent.agent_id,
    );

    await waitFor(
      'connected shell sees extension_call on jsnes browser',
      () => client.networkGet(browserPaneId, secondPlayerPaneId, null),
      (tile) => tile.responds_to.includes('extension_call'),
      30_000,
      150,
    );

    const readyState = await waitFor(
      'jsnes core ready',
      () => client.tileCall<{
        core_ready: boolean;
      }>(
        browserPaneId,
        'extension_call',
        {
          method: 'state',
          args: {},
        },
        rootAgent.tile_id,
        rootAgent.agent_id,
      ),
      (response) => response.result.core_ready === true,
      30_000,
      150,
    );
    expect(readyState.result.core_ready).toBe(true);

    const playerOne = await client.tileCall<{
      player: { player: number; claimed: boolean; owner_tile_id: string };
    }>(
      browserPaneId,
      'extension_call',
      {
        method: 'claim_player',
        args: { player: 1, name: 'North' },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expect(playerOne.result.player).toMatchObject({
      player: 1,
      claimed: true,
      owner_tile_id: rootAgent.tile_id,
    });

    const playerTwo = await client.browserExtensionCall<{
      player: { player: number; claimed: boolean; owner_tile_id: string };
    }>(
      browserPaneId,
      'claim_player',
      { player: 2, name: 'South' },
      secondPlayerPaneId,
      null,
    );
    expect(playerTwo.result.player).toMatchObject({
      player: 2,
      claimed: true,
      owner_tile_id: secondPlayerPaneId,
    });

    const loaded = await client.tileCall<{
      state: {
        loaded: boolean;
        rom: { filename: string; source: string };
      };
    }>(
      browserPaneId,
      'extension_call',
      {
        method: 'load_rom_base64',
        args: {
          filename: 'tiny-test.nes',
          data_base64: tinyNesRomBase64(),
        },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expect(loaded.result.state.loaded).toBe(true);
    expect(loaded.result.state.rom).toMatchObject({
      filename: 'tiny-test.nes',
      source: 'api',
    });

    const imageScreenshot = await client.tileCall<BrowserScreenshotResult>(
      browserPaneId,
      'extension_call',
      {
        method: 'screenshot',
        args: {},
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expectPngScreenshot(imageScreenshot.result);

    const brailleScreenshot = await client.tileCall<BrowserTextScreenshotResult>(
      browserPaneId,
      'extension_call',
      {
        method: 'screenshot',
        args: { format: 'braille', columns: 64 },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expectBrailleScreenshotShape(brailleScreenshot.result, 64);

    const asciiScreenshot = await client.tileCall<BrowserTextScreenshotResult>(
      browserPaneId,
      'extension_call',
      {
        method: 'screenshot',
        args: { format: 'ascii', columns: 64 },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expectAsciiScreenshotShape(asciiScreenshot.result, 64);

    const ansiScreenshot = await client.tileCall<BrowserTextScreenshotResult>(
      browserPaneId,
      'extension_call',
      {
        method: 'screenshot',
        args: { format: 'ansi', columns: 64 },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expectAnsiScreenshot(ansiScreenshot.result, 64);

    const textScreenshot = await client.tileCall<BrowserTextScreenshotResult>(
      browserPaneId,
      'extension_call',
      {
        method: 'screenshot',
        args: { format: 'text', columns: 64 },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expectImageDerivedTextScreenshot(textScreenshot.result, 64);

    const playerOnePress = await client.tileCall<{
      player: { player: number; buttons: Record<string, boolean> };
    }>(
      browserPaneId,
      'extension_call',
      {
        method: 'set_button',
        args: { button: 'start', pressed: true },
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expect(playerOnePress.result.player.player).toBe(1);
    expect(playerOnePress.result.player.buttons.start).toBe(true);

    const playerTwoPress = await client.browserExtensionCall<{
      player: { player: number; buttons: Record<string, boolean> };
    }>(
      browserPaneId,
      'set_button',
      { button: 'a', pressed: true },
      secondPlayerPaneId,
      null,
    );
    expect(playerTwoPress.result.player.player).toBe(2);
    expect(playerTwoPress.result.player.buttons.a).toBe(true);

    for (const button of GAMEPAD_BUTTON_NAMES) {
      const buttonDown = await client.tileCall<{
        player: { player: number; buttons: Record<string, boolean> };
        button: string;
        pressed: boolean;
      }>(
        browserPaneId,
        'extension_call',
        {
          method: 'set_button',
          args: { button, pressed: true },
        },
        rootAgent.tile_id,
        rootAgent.agent_id,
      );
      expect(buttonDown.result.player.player).toBe(1);
      expect(buttonDown.result.button).toBe(button);
      expect(buttonDown.result.player.buttons[button]).toBe(true);

      const buttonUp = await client.tileCall<{
        player: { player: number; buttons: Record<string, boolean> };
        button: string;
        pressed: boolean;
      }>(
        browserPaneId,
        'extension_call',
        {
          method: 'set_button',
          args: { button, pressed: false },
        },
        rootAgent.tile_id,
        rootAgent.agent_id,
      );
      expect(buttonUp.result.player.player).toBe(1);
      expect(buttonUp.result.button).toBe(button);
      expect(buttonUp.result.player.buttons[button]).toBe(false);
    }

    const comboStarted = await client.browserExtensionCall<{
      player: { player: number; buttons: Record<string, boolean> };
      sequence_length: number;
      delay_ms: number;
      hold_ms: number;
    }>(
      browserPaneId,
      'button_combo',
      {
        sequence: [{ buttons: ['a'] }],
        delay_ms: 30,
        hold_ms: 10,
      },
      secondPlayerPaneId,
      null,
    );
    expect(comboStarted.result.player.player).toBe(2);
    expect(comboStarted.result.sequence_length).toBe(1);
    expect(comboStarted.result.player.buttons.a).toBe(true);

    await waitFor(
      'jsnes combo releases player two A button',
      () => client.tileCall<{
        players: Array<{ player: number; buttons: Record<string, boolean> }>;
      }>(
        browserPaneId,
        'extension_call',
        {
          method: 'state',
          args: {},
        },
        rootAgent.tile_id,
        rootAgent.agent_id,
      ),
      (response) => response.result.players.find((player) => player.player === 2)?.buttons.a === false,
      5_000,
      25,
    );

    const released = await client.browserExtensionCall<{
      player: { player: number; buttons: Record<string, boolean> };
    }>(
      browserPaneId,
      'release_all_buttons',
      {},
      secondPlayerPaneId,
      null,
    );
    expect(released.result.player.player).toBe(2);
    expect(released.result.player.buttons.a).toBe(false);
  });

  it('creates browser tiles with optional incognito storage isolation', async () => {
    const projection = await createIsolatedTab(client, 'browser-incognito');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in browser-incognito tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      250,
    );
    const rootAgent = rootAgentForProjection(rootProjection)!;
    const defaultBrowserPaneId = await spawnBrowserInActiveTab(client);
    const incognitoBrowserPaneId = await spawnBrowserInActiveTab(client, { browserIncognito: true });

    await client.sendCommand({
      command: 'browser_load',
      tile_id: defaultBrowserPaneId,
      path: 'tests/fixtures/browser-drive.html',
      sender_agent_id: rootAgent.agent_id,
      sender_tile_id: rootAgent.tile_id,
    });
    await client.sendCommand({
      command: 'browser_load',
      tile_id: incognitoBrowserPaneId,
      path: 'tests/fixtures/browser-drive.html',
      sender_agent_id: rootAgent.agent_id,
      sender_tile_id: rootAgent.tile_id,
    });

    const storageKey = 'herd-incognito-check';
    const defaultStored = await waitFor(
      'default browser stores localStorage value',
      () => client.browserDrive<string>(
        defaultBrowserPaneId,
        'eval',
        {
          js: `
localStorage.setItem('${storageKey}', 'default-profile');
return localStorage.getItem('${storageKey}');
`,
        },
        rootAgent.tile_id,
        rootAgent.agent_id,
      ),
      (response) => response.result === 'default-profile',
      30_000,
      150,
    );
    expect(defaultStored.result).toBe('default-profile');

    const incognitoStored = await client.browserDrive<string | null>(
      incognitoBrowserPaneId,
      'eval',
      {
        js: `
return localStorage.getItem('${storageKey}');
`,
      },
      rootAgent.tile_id,
      rootAgent.agent_id,
    );
    expect(incognitoStored.result).toBe(null);
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
