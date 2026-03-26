import net from 'node:net';
import readline from 'node:readline';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AgentInfo,
  SessionTileInfo,
  TestDriverProjection,
  WorkItem,
  WorkStage,
  WorkTileDetails,
} from '../../src/lib/types';
import { HerdTestClient } from './client';
import { createIsolatedTab, waitFor } from './helpers';
import { startIntegrationRuntime, type HerdIntegrationRuntime } from './runtime';

const HERD_WELCOME_MESSAGE =
  'Welcome to Herd. Review the /herd-worker skill, inspect the recent public activity in your session, and coordinate through public, network, direct, or root messages. Root manages the full session-wide MCP surface.';

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
  response: { agent: AgentInfo };
  nextEvent: (timeoutMs?: number) => Promise<AgentChannelEvent>;
  close: () => void;
}

function currentStageStatus(item: WorkItem, stage: WorkStage = item.current_stage) {
  return item.stages.find((entry) => entry.stage === stage)?.status;
}

function workTileId(workId: string) {
  return `work:${workId}`;
}

function workItemFromTile(tile: SessionTileInfo): WorkItem {
  const details = tile.details as WorkTileDetails;
  return {
    work_id: details.work_id,
    tile_id: tile.tile_id,
    session_id: tile.session_id,
    title: tile.title,
    topic: details.topic,
    owner_agent_id: details.owner_agent_id ?? null,
    current_stage: details.current_stage,
    stages: details.stages,
    reviews: details.reviews,
    created_at: details.created_at,
    updated_at: details.updated_at,
  };
}

function rootAgentForProjection(projection: TestDriverProjection): AgentInfo | undefined {
  return projection.agents.find(
    (agent) => agent.agent_role === 'root' && agent.alive && agent.session_id === projection.active_tab_id,
  );
}

async function waitForActiveTab(
  client: HerdTestClient,
  sessionId: string,
  predicate?: (projection: TestDriverProjection) => boolean,
): Promise<TestDriverProjection> {
  await client.toolbarSelectTab(sessionId);
  return waitFor(
    `session ${sessionId} to become active`,
    () => client.getProjection(),
    (projection) =>
      projection.active_tab_id === sessionId
      && (predicate ? predicate(projection) : true),
    30_000,
    150,
  );
}

async function waitForRootAgentInSession(client: HerdTestClient, sessionId: string): Promise<AgentInfo> {
  const projection = await waitForActiveTab(
    client,
    sessionId,
    (nextProjection) => Boolean(rootAgentForProjection(nextProjection)),
  );
  const rootAgent = rootAgentForProjection(projection);
  if (!rootAgent) {
    throw new Error(`missing root agent for session ${sessionId}`);
  }
  return rootAgent;
}

async function spawnShellInActiveTab(client: HerdTestClient): Promise<string> {
  const before = await client.getProjection();
  const knownPaneIds = new Set(before.active_tab_terminals.map((terminal) => terminal.id));
  await client.tileCreate('shell', {
    parentSessionId: before.active_tab_id,
  });
  const projection = await waitFor(
    'shell create in active tab',
    () => client.getProjection(),
    (nextProjection) => nextProjection.active_tab_terminals.some((terminal) => !knownPaneIds.has(terminal.id)),
    30_000,
    150,
  );
  const created = projection.active_tab_terminals.find((terminal) => !knownPaneIds.has(terminal.id));
  if (!created) {
    throw new Error('failed to locate spawned shell pane');
  }
  return created.id;
}

async function createWorkInSession(
  client: HerdTestClient,
  title: string,
  senderTileId: string,
): Promise<WorkItem> {
  const createdTile = await client.tileCreate('work', {
    title,
    parentTileId: senderTileId,
    senderTileId,
  });
  return workItemFromTile(createdTile);
}

async function loadWorkItemAsRoot(
  client: HerdTestClient,
  rootAgent: AgentInfo,
  workId: string,
): Promise<WorkItem> {
  const tile = await client.getWorkTile(workId, rootAgent.tile_id, rootAgent.agent_id);
  return workItemFromTile(tile);
}

async function openAgentEventSubscription(socketPath: string, agentId: string): Promise<AgentEventSubscription> {
  const socket = net.createConnection(socketPath);
  const lines = readline.createInterface({ input: socket });
  const bufferedLines: string[] = [];
  let settled = false;
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
  socket.on('close', () => {
    if (!settled) {
      rejectPending(new Error(`agent event subscription for ${agentId} closed unexpectedly`));
    }
  });

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
    settled = true;
    lines.close();
    socket.destroy();
    throw new Error(response.error ?? `agent event subscription failed for ${agentId}`);
  }

  return {
    response: response.data!,
    nextEvent: async (timeoutMs = 10_000) => {
      const line = await nextLine(timeoutMs);
      const envelope = JSON.parse(line) as AgentStreamEnvelope;
      if (envelope.type !== 'event') {
        throw new Error(`unexpected agent stream envelope: ${line}`);
      }
      return envelope.event;
    },
    close: () => {
      settled = true;
      lines.close();
      socket.destroy();
    },
  };
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

describe.sequential('work registry integration', () => {
  let runtime: HerdIntegrationRuntime;
  let client: HerdTestClient;

  beforeAll(async () => {
    runtime = await startIntegrationRuntime();
    client = runtime.client;
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('creates work from the toolbar and keeps work projection local to the active session', async () => {
    const firstProjection = await createIsolatedTab(client, 'work-toolbar-a');
    const firstSessionId = firstProjection.active_tab_id!;

    const firstItem = await client.toolbarSpawnWork('Toolbar work A');
    let projection = await waitFor(
      'first session work item projection',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === firstSessionId
        && nextProjection.work_items.some((item) => item.work_id === firstItem.work_id),
      30_000,
      150,
    );
    expect(projection.work_items.map((item) => item.work_id)).toEqual([firstItem.work_id]);

    const secondProjection = await createIsolatedTab(client, 'work-toolbar-b');
    const secondSessionId = secondProjection.active_tab_id!;
    const secondItem = await client.toolbarSpawnWork('Toolbar work B');
    projection = await waitFor(
      'second session work item projection',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === secondSessionId
        && nextProjection.work_items.some((item) => item.work_id === secondItem.work_id),
      30_000,
      150,
    );
    expect(projection.work_items.map((item) => item.work_id)).toEqual([secondItem.work_id]);

    projection = await waitForActiveTab(
      client,
      firstSessionId,
      (nextProjection) =>
        nextProjection.work_items.some((item) => item.work_id === firstItem.work_id)
        && !nextProjection.work_items.some((item) => item.work_id === secondItem.work_id),
    );
    expect(projection.work_items.map((item) => item.work_id)).toEqual([firstItem.work_id]);
  });

  it('keeps agent, topic, chatter, and work views private to the caller session', async () => {
    const firstProjection = await createIsolatedTab(client, 'private-a');
    const firstPaneId = await spawnShellInActiveTab(client);
    const firstChatterPaneId = await spawnShellInActiveTab(client);
    const firstSessionId = firstProjection.active_tab_id!;
    const firstRootAgent = await waitForRootAgentInSession(client, firstSessionId);
    await client.agentRegister('agent-private-a', firstPaneId, 'Private Agent A');

    const secondProjection = await createIsolatedTab(client, 'private-b');
    const secondPaneId = await spawnShellInActiveTab(client);
    const secondChatterPaneId = await spawnShellInActiveTab(client);
    const secondSessionId = secondProjection.active_tab_id!;
    const secondRootAgent = await waitForRootAgentInSession(client, secondSessionId);
    await client.agentRegister('agent-private-b', secondPaneId, 'Private Agent B');
    const firstSubscription = await openAgentEventSubscription(runtime.socketPath, 'agent-private-a');
    const secondSubscription = await openAgentEventSubscription(runtime.socketPath, 'agent-private-b');

    try {
      const firstWork = await createWorkInSession(client, 'Private work A', firstPaneId);
      await client.messageChannelSubscribe('#scope-a', 'agent-private-a', firstRootAgent.tile_id, firstRootAgent.agent_id);
      await client.messageChannel('scope-a sync #scope-a', '#scope-a', firstPaneId, 'agent-private-a');
      const secondWork = await createWorkInSession(client, 'Private work B', secondPaneId);
      await client.messageChannelSubscribe('#scope-b', 'agent-private-b', secondRootAgent.tile_id, secondRootAgent.agent_id);
      await client.messageChannel('scope-b sync #scope-b', '#scope-b', secondPaneId, 'agent-private-b');

      const firstAgents = (await client.tileList(firstChatterPaneId, null, 'agent')).tiles
        .map((tile) => (tile.details as { agent_id: string }).agent_id)
        .sort();
      expect(firstAgents).toContain('agent-private-a');
      expect(firstAgents.some((agentId) => agentId.startsWith('root:'))).toBe(true);
      expect(firstAgents).toHaveLength(2);
      expect((await client.messageChannelList(firstChatterPaneId)).map((channel) => channel.name)).toEqual(['#scope-a', firstWork.topic]);
      expect(
        (await client.tileList(firstChatterPaneId, null, 'work')).tiles.map(
          (tile) => (tile.details as { work_id: string }).work_id,
        ),
      ).toEqual([firstWork.work_id]);

      const secondAgents = (await client.tileList(secondChatterPaneId, null, 'agent')).tiles
        .map((tile) => (tile.details as { agent_id: string }).agent_id)
        .sort();
      expect(secondAgents).toContain('agent-private-b');
      expect(secondAgents.some((agentId) => agentId.startsWith('root:'))).toBe(true);
      expect(secondAgents).toHaveLength(2);
      expect((await client.messageChannelList(secondChatterPaneId)).map((channel) => channel.name)).toEqual(['#scope-b', secondWork.topic]);
      expect(
        (await client.tileList(secondChatterPaneId, null, 'work')).tiles.map(
          (tile) => (tile.details as { work_id: string }).work_id,
        ),
      ).toEqual([secondWork.work_id]);

      await expect(client.messageDirect('agent-private-b', 'cross-session denied', firstPaneId)).rejects.toThrow(
        /across sessions/,
      );

      let projection = await waitForActiveTab(
        client,
        firstSessionId,
        (nextProjection) =>
          nextProjection.chatter.some((entry) => entry.message === 'scope-a sync #scope-a')
          && !nextProjection.chatter.some((entry) => entry.message === 'scope-b sync #scope-b'),
      );
      expect(projection.chatter.every((entry) => entry.session_id === firstSessionId)).toBe(true);

      projection = await waitForActiveTab(
        client,
        secondSessionId,
        (nextProjection) =>
          nextProjection.chatter.some((entry) => entry.message === 'scope-b sync #scope-b')
          && !nextProjection.chatter.some((entry) => entry.message === 'scope-a sync #scope-a'),
      );
      expect(projection.chatter.every((entry) => entry.session_id === secondSessionId)).toBe(true);
    } finally {
      firstSubscription.close();
      secondSubscription.close();
    }
  });

  it('derives owner-only work updates from the port graph and enforces the full stage review lifecycle', async () => {
    const projection = await createIsolatedTab(client, 'work-lifecycle');
    const rootAgent = await waitForRootAgentInSession(client, projection.active_tab_id!);
    const ownerPaneId = await spawnShellInActiveTab(client);
    const nonOwnerPaneId = await spawnShellInActiveTab(client);

    await client.agentRegister('agent-owner-life', ownerPaneId, 'Lifecycle Owner');
    const ownerSubscription = await openAgentEventSubscription(runtime.socketPath, 'agent-owner-life');
    await client.agentRegister('agent-non-owner-life', nonOwnerPaneId, 'Lifecycle Non Owner');
    const nonOwnerSubscription = await openAgentEventSubscription(runtime.socketPath, 'agent-non-owner-life');

    try {
      let item = await createWorkInSession(client, 'Lifecycle work item', ownerPaneId);
      expect(item.owner_agent_id ?? null).toBeNull();
      expect(currentStageStatus(item)).toBe('ready');

      expect((await client.messageChannelList(rootAgent.tile_id, rootAgent.agent_id)).some((channel) => channel.name === item.topic)).toBe(true);

      await client.networkConnect(ownerPaneId, 'left', workTileId(item.work_id), 'left', rootAgent.tile_id);
      item = await loadWorkItemAsRoot(client, rootAgent, item.work_id);
      expect(item.owner_agent_id).toBe('agent-owner-life');

      const ownerNetwork = await client.listNetwork(ownerPaneId, 'agent-owner-life');
      expect(ownerNetwork.tiles.map((tile) => tile.tile_id).sort()).toEqual([ownerPaneId, workTileId(item.work_id)].sort());
      expect(ownerNetwork.connections).toHaveLength(1);

      await expect(client.workStageStart(item.work_id, 'agent-non-owner-life')).rejects.toThrow(/only the owner/);

      item = await client.workStageStart(item.work_id, 'agent-owner-life');
      expect(currentStageStatus(item)).toBe('in_progress');

      await expect(client.workStageComplete(item.work_id, 'agent-non-owner-life')).rejects.toThrow(/only the owner/);

      item = await client.workStageComplete(item.work_id, 'agent-owner-life');
      expect(currentStageStatus(item)).toBe('completed');

      await expect(client.workReviewImprove(item.work_id, '   ')).rejects.toThrow(/requires a comment/);

      item = await client.workReviewImprove(item.work_id, 'needs more detail');
      expect(currentStageStatus(item)).toBe('in_progress');
      expect(item.reviews.at(-1)?.decision).toBe('improve');
      expect(item.reviews.at(-1)?.comment).toBe('needs more detail');

      item = await client.workStageComplete(item.work_id, 'agent-owner-life');
      expect(currentStageStatus(item)).toBe('completed');

      item = await client.workReviewApprove(item.work_id);
      expect(item.current_stage).toBe('prd');
      expect(currentStageStatus(item)).toBe('ready');

      item = await client.workStageStart(item.work_id, 'agent-owner-life');
      expect(currentStageStatus(item)).toBe('in_progress');
      item = await client.workStageComplete(item.work_id, 'agent-owner-life');
      expect(currentStageStatus(item)).toBe('completed');
      item = await client.workReviewApprove(item.work_id);
      expect(item.current_stage).toBe('artifact');
      expect(currentStageStatus(item)).toBe('ready');

      item = await client.workStageStart(item.work_id, 'agent-owner-life');
      item = await client.workStageComplete(item.work_id, 'agent-owner-life');
      expect(currentStageStatus(item)).toBe('completed');
      item = await client.workReviewApprove(item.work_id);
      expect(item.current_stage).toBe('artifact');
      expect(currentStageStatus(item, 'artifact')).toBe('approved');

      const projectionWithWorkLogs = await waitFor(
        'work command wrappers appear in tile message logs',
        () => client.getProjection(),
        (nextProjection) => {
          const targetId = workTileId(item.work_id);
          const wrappers = nextProjection.tile_message_logs
            .filter((entry) => entry.channel === 'socket' && entry.target_id === targetId)
            .map((entry) => entry.wrapper_command);
          return (
            nextProjection.tile_message_logs.some(
              (entry) =>
                entry.channel === 'socket'
                && entry.target_id === item.session_id
                && entry.target_kind === 'session'
                && entry.wrapper_command === 'tile_create'
                && entry.message_name === 'tile_create',
            )
            && (
              wrappers.includes('work_stage_start')
              && wrappers.includes('work_stage_complete')
              && wrappers.includes('work_review_improve')
              && wrappers.includes('work_review_approve')
            )
          );
        },
        30_000,
        150,
      );
      expect(
        projectionWithWorkLogs.tile_message_logs.some(
          (entry) =>
            entry.channel === 'socket'
            && entry.target_id === workTileId(item.work_id)
            && entry.wrapper_command === 'work_stage_start'
            && entry.message_name === 'stage_start',
        ),
      ).toBe(true);

      await client.networkDisconnect(ownerPaneId, 'left', rootAgent.tile_id, rootAgent.agent_id);
      const unowned = await loadWorkItemAsRoot(client, rootAgent, item.work_id);
      expect(unowned.owner_agent_id ?? null).toBeNull();

      const reloaded = await loadWorkItemAsRoot(client, rootAgent, item.work_id);
      expect(reloaded.reviews.map((review) => review.decision)).toEqual([
        'improve',
        'approve',
        'approve',
        'approve',
      ]);
    } finally {
      ownerSubscription.close();
      nonOwnerSubscription.close();
    }
  });

  it('clears derived owners when direct delivery finds no live subscriber', async () => {
    const projection = await createIsolatedTab(client, 'dead-cleanup');
    const rootAgent = await waitForRootAgentInSession(client, projection.active_tab_id!);
    const ownerPaneId = await spawnShellInActiveTab(client);
    const senderPaneId = await spawnShellInActiveTab(client);

    const ownerInfo = (await client.agentRegister('agent-dead-owner', ownerPaneId, 'Dead Owner')).agent;
    const ownerSubscription = await openAgentEventSubscription(runtime.socketPath, 'agent-dead-owner');
    try {
      let item = await createWorkInSession(client, 'Dead cleanup work', ownerPaneId);
      await client.networkConnect(ownerPaneId, 'left', workTileId(item.work_id), 'left', rootAgent.tile_id);
      item = await loadWorkItemAsRoot(client, rootAgent, item.work_id);
      expect(item.owner_agent_id).toBe('agent-dead-owner');

      ownerSubscription.close();
      await expect(client.messageDirect('agent-dead-owner', 'ping owner', senderPaneId)).rejects.toThrow(
        /no live subscribers/,
      );
      item = await loadWorkItemAsRoot(client, rootAgent, item.work_id);
      expect(item.owner_agent_id ?? null).toBeNull();

      const chatterProjection = await waitFor(
        'dead-agent sign-off chatter',
        () => client.getProjection(),
        (nextProjection) =>
          nextProjection.chatter.some((entry) => entry.display_text === `${ownerInfo.display_name}: Signed Off`),
        30_000,
        150,
      );
      expect(chatterProjection.chatter.some((entry) => entry.display_text === `${ownerInfo.display_name}: Signed Off`)).toBe(true);
    } finally {
      ownerSubscription.close();
    }
  });

  it('derives network membership only from manual connections and delivers network messages inside that component', async () => {
    const projection = await createIsolatedTab(client, 'network-routing');
    const rootAgent = await waitForRootAgentInSession(client, projection.active_tab_id!);
    const agentAPaneId = await spawnShellInActiveTab(client);
    const agentBPaneId = await spawnShellInActiveTab(client);
    const agentCPaneId = await spawnShellInActiveTab(client);

    await client.agentRegister('agent-network-a', agentAPaneId, 'Network Agent A');
    await client.agentRegister('agent-network-b', agentBPaneId, 'Network Agent B');
    await client.agentRegister('agent-network-c', agentCPaneId, 'Network Agent C');

    const subA = await openAgentEventSubscription(runtime.socketPath, 'agent-network-a');
    const subB = await openAgentEventSubscription(runtime.socketPath, 'agent-network-b');
    const subC = await openAgentEventSubscription(runtime.socketPath, 'agent-network-c');

    try {
      await client.networkConnect(agentAPaneId, 'left', agentBPaneId, 'right', rootAgent.tile_id);
      const work = await createWorkInSession(client, 'Network list work', agentAPaneId);
      await client.networkConnect(agentAPaneId, 'top', workTileId(work.work_id), 'left', rootAgent.tile_id);

      const component = await client.listNetwork(agentAPaneId, 'agent-network-a');
      expect(component.tiles.map((tile) => tile.tile_id).sort()).toEqual(
        [agentAPaneId, agentBPaneId, workTileId(work.work_id)].sort(),
      );
      expect(component.connections).toHaveLength(2);
      expect(component.tiles.find((tile) => tile.tile_id === agentAPaneId)).toMatchObject({
        session_id: projection.active_tab_id,
        kind: 'agent',
        command: expect.any(String),
        details: {
          agent_id: 'agent-network-a',
          agent_role: 'worker',
          alive: true,
        },
      });

      const workOnly = await client.listNetwork(agentAPaneId, 'agent-network-a', 'work');
      expect(workOnly.tiles).toHaveLength(1);
      expect(workOnly.tiles[0]).toMatchObject({
        tile_id: workTileId(work.work_id),
        session_id: projection.active_tab_id,
        kind: 'work',
        title: work.title,
        details: {
          work_id: work.work_id,
          topic: work.topic,
        },
      });
      expect(workOnly.connections).toEqual([]);

      await client.messageNetwork('network-only update', agentAPaneId, 'agent-network-a');

      const delivered = await collectAgentEvents(
        subB,
        (events) => events.some((event) => event.message === 'network-only update'),
        15_000,
      );
      expect(delivered.some((event) => event.message === 'network-only update')).toBe(true);

      await expect(
        collectAgentEvents(
          subC,
          (events) => events.some((event) => event.message === 'network-only update'),
          1_000,
        ),
      ).rejects.toThrow(/timed out/i);

      const networkProjection = await waitFor(
        'network chatter log entry',
        () => client.getProjection(),
        (nextProjection) =>
          nextProjection.chatter.some(
            (entry) => entry.kind === 'network' && entry.message === 'network-only update',
          ),
        30_000,
        150,
      );
      expect(
        networkProjection.chatter.some((entry) => entry.kind === 'network' && entry.message === 'network-only update'),
      ).toBe(true);
    } finally {
      subA.close();
      subB.close();
      subC.close();
    }
  });

  it('sends the welcome DM and replays the last hour of public chatter on first agent subscription', async () => {
    const projection = await createIsolatedTab(client, 'welcome-bootstrap');
    const paneId = projection.selected_tile_id!;

    await client.messagePublic('bootstrap replay #welcome-bootstrap', paneId);
    await client.agentRegister('agent-bootstrap', paneId, 'Bootstrap Agent');

    const subscription = await openAgentEventSubscription(runtime.socketPath, 'agent-bootstrap');
    try {
      expect(subscription.response.agent.agent_id).toBe('agent-bootstrap');

      const events = await collectAgentEvents(
        subscription,
        (received) =>
          received.some((event) => event.kind === 'system' && event.message === 'Signed On')
          && received.some(
            (event) =>
              event.kind === 'direct'
              && event.from_display_name === 'HERD'
              && event.message === HERD_WELCOME_MESSAGE,
          )
          && received.some(
            (event) =>
              event.kind === 'public'
              && event.replay
              && event.message === 'bootstrap replay #welcome-bootstrap',
          ),
        15_000,
      );

      expect(events.some((event) => event.kind === 'system' && event.message === 'Signed On')).toBe(true);
      expect(
        events.some(
          (event) =>
            event.kind === 'direct'
            && event.from_display_name === 'HERD'
            && event.message === HERD_WELCOME_MESSAGE,
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.kind === 'public'
            && event.replay
            && event.message === 'bootstrap replay #welcome-bootstrap',
        ),
      ).toBe(true);
    } finally {
      subscription.close();
    }
  });

  it('delivers channel chatter only to subscribed agents and replays subscribed channel history', async () => {
    const projection = await createIsolatedTab(client, 'channel-delivery');
    const sessionId = projection.active_tab_id!;
    const rootAgent = await waitForRootAgentInSession(client, sessionId);

    const paneA = await spawnShellInActiveTab(client);
    const paneB = await spawnShellInActiveTab(client);
    const paneC = await spawnShellInActiveTab(client);

    await client.agentRegister('agent-channel-a', paneA, 'Channel Agent A');
    await client.agentRegister('agent-channel-b', paneB, 'Channel Agent B');
    await client.agentRegister('agent-channel-c', paneC, 'Channel Agent C');
    await client.agentPingAck('agent-channel-a');
    await client.agentPingAck('agent-channel-b');
    await client.agentPingAck('agent-channel-c');

    await client.sendCommand({
      command: 'message_channel_subscribe',
      agent_id: 'agent-channel-a',
      channel_name: '#delivery',
      sender_agent_id: rootAgent.agent_id,
      sender_tile_id: rootAgent.tile_id,
    });
    await client.sendCommand({
      command: 'message_channel_subscribe',
      agent_id: 'agent-channel-b',
      channel_name: '#delivery',
      sender_agent_id: rootAgent.agent_id,
      sender_tile_id: rootAgent.tile_id,
    });

    const subA = await openAgentEventSubscription(runtime.socketPath, 'agent-channel-a');
    const subB = await openAgentEventSubscription(runtime.socketPath, 'agent-channel-b');

    try {
      await client.sendCommand({
        command: 'message_channel',
        channel_name: '#delivery',
        message: 'channel hello',
        sender_agent_id: 'agent-channel-a',
        sender_tile_id: paneA,
      });

      const deliveredA = await collectAgentEvents(
        subA,
        (events) => events.some((event) => event.kind === 'channel' && event.message === 'channel hello'),
        15_000,
      );
      expect(
        deliveredA.some((event) => event.kind === 'channel' && event.channels.includes('#delivery')),
      ).toBe(true);

      const deliveredB = await collectAgentEvents(
        subB,
        (events) => events.some((event) => event.kind === 'channel' && event.message === 'channel hello'),
        15_000,
      );
      expect(
        deliveredB.some((event) => event.kind === 'channel' && event.channels.includes('#delivery')),
      ).toBe(true);

      await client.sendCommand({
        command: 'message_channel_subscribe',
        agent_id: 'agent-channel-c',
        channel_name: '#delivery',
        sender_agent_id: rootAgent.agent_id,
        sender_tile_id: rootAgent.tile_id,
      });

      const replaySubscription = await openAgentEventSubscription(runtime.socketPath, 'agent-channel-c');
      try {
        const replayed = await collectAgentEvents(
          replaySubscription,
          (events) => events.some((event) => event.kind === 'channel' && event.replay && event.message === 'channel hello'),
          15_000,
        );
        expect(
          replayed.some((event) => event.kind === 'channel' && event.replay && event.channels.includes('#delivery')),
        ).toBe(true);
      } finally {
        replaySubscription.close();
      }

      await client.sendCommand({
        command: 'message_channel_unsubscribe',
        agent_id: 'agent-channel-b',
        channel_name: '#delivery',
        sender_agent_id: rootAgent.agent_id,
        sender_tile_id: rootAgent.tile_id,
      });

      await expect(
        client.sendCommand({
          command: 'message_channel',
          channel_name: '#delivery',
          message: 'blocked send',
          sender_agent_id: 'agent-channel-b',
          sender_tile_id: paneB,
        }),
      ).rejects.toThrow(/subscribed/i);

      await client.sendCommand({
        command: 'message_channel',
        channel_name: '#delivery',
        message: 'channel follow-up',
        sender_agent_id: 'agent-channel-a',
        sender_tile_id: paneA,
      });

      const followUpA = await collectAgentEvents(
        subA,
        (events) => events.some((event) => event.kind === 'channel' && event.message === 'channel follow-up'),
        15_000,
      );
      expect(followUpA.some((event) => event.message === 'channel follow-up')).toBe(true);

      await expect(
        collectAgentEvents(
          subB,
          (events) => events.some((event) => event.kind === 'channel' && event.message === 'channel follow-up'),
          1_000,
        ),
      ).rejects.toThrow(/timed out/i);
    } finally {
      subA.close();
      subB.close();
    }
  });
});
