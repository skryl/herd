import net from 'node:net';
import readline from 'node:readline';

import type { AgentInfo, SessionTileInfo, TileGraph, TileTypeFilter } from '../../src/lib/types';
import { waitFor } from './helpers';
import { HerdTestClient } from './client';
import type { HerdIntegrationRuntime } from './runtime';

interface SocketResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface AgentChannelEvent {
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

async function openAgentEventSubscription(socketPath: string, agentId: string): Promise<AgentEventSubscription> {
  const socket = net.createConnection(socketPath);
  const lines = readline.createInterface({ input: socket });
  const bufferedLines: string[] = [];
  let closed = false;
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
    if (closed) {
      return;
    }
    rejectPending(new Error(`agent event subscription for ${agentId} closed unexpectedly`));
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
  if (!response.ok || !response.data) {
    throw new Error(response.error ?? `failed to subscribe to agent events for ${agentId}`);
  }

  return {
    response: response.data,
    nextEvent: async (timeoutMs = 10_000) => {
      const line = await nextLine(timeoutMs);
      const envelope = JSON.parse(line) as AgentStreamEnvelope;
      if (envelope.type !== 'event') {
        throw new Error(`unexpected agent stream payload for ${agentId}: ${line}`);
      }
      return envelope.event;
    },
    close: () => {
      closed = true;
      lines.close();
      socket.destroy();
    },
  };
}

export class FixtureAgentController {
  private subscription: AgentEventSubscription | null = null;

  private completion: Promise<void> | null = null;

  private queuedEvents: AgentChannelEvent[] = [];

  private pendingEvent:
    | {
      resolve: (event: AgentChannelEvent) => void;
      reject: (error: Error) => void;
    }
    | null = null;

  private stopped = false;

  private pump: Promise<void> | null = null;

  constructor(
    readonly runtime: HerdIntegrationRuntime,
    readonly client: HerdTestClient,
    public agent: AgentInfo,
  ) {}

  async connect(): Promise<void> {
    this.subscription = await openAgentEventSubscription(this.runtime.socketPath, this.agent.agent_id);
    this.agent = this.subscription.response.agent;
    const ack = await this.client.agentPingAck(this.agent.agent_id);
    this.agent = ack.agent;
    this.pump = this.pumpEvents();
  }

  run<TContext>(script: (context: TContext) => Promise<void>, context: TContext): Promise<void> {
    this.completion = script(context);
    return this.completion;
  }

  async waitForCompletion(): Promise<void> {
    await this.completion;
  }

  async waitForEvent(
    label: string,
    predicate: (event: AgentChannelEvent) => boolean,
    timeoutMs = 90_000,
  ): Promise<AgentChannelEvent> {
    if (!this.subscription) {
      throw new Error(`fixture agent ${this.agent.agent_id} is not connected`);
    }
    const deadline = Date.now() + timeoutMs;
    const seen: AgentChannelEvent[] = [];
    while (Date.now() <= deadline) {
      const event = await this.nextQueuedEvent(Math.max(1, deadline - Date.now()));
      seen.push(event);
      if (predicate(event)) {
        return event;
      }
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(seen)}`);
  }

  close() {
    this.stopped = true;
    this.subscription?.close();
    this.rejectPending(new Error(`fixture agent ${this.agent.agent_id} controller closed`));
  }

  private async pumpEvents(): Promise<void> {
    while (this.subscription && !this.stopped) {
      try {
        const event = await this.subscription.nextEvent(60_000);
        if (event.kind === 'ping') {
          const ack = await this.client.agentPingAck(this.agent.agent_id);
          this.agent = ack.agent;
          continue;
        }
        this.pushEvent(event);
      } catch (error) {
        if (this.stopped) {
          return;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        this.rejectPending(err);
        return;
      }
    }
  }

  private pushEvent(event: AgentChannelEvent) {
    if (this.pendingEvent) {
      const pending = this.pendingEvent;
      this.pendingEvent = null;
      pending.resolve(event);
      return;
    }
    this.queuedEvents.push(event);
  }

  private rejectPending(error: Error) {
    if (!this.pendingEvent) {
      return;
    }
    const pending = this.pendingEvent;
    this.pendingEvent = null;
    pending.reject(error);
  }

  private async nextQueuedEvent(timeoutMs: number): Promise<AgentChannelEvent> {
    if (this.queuedEvents.length > 0) {
      return this.queuedEvents.shift()!;
    }
    if (this.pendingEvent) {
      throw new Error(`fixture agent ${this.agent.agent_id} already has a pending event waiter`);
    }
    return new Promise<AgentChannelEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingEvent?.resolve === resolve) {
          this.pendingEvent = null;
        }
        reject(new Error(`timed out waiting for queued event for ${this.agent.agent_id}`));
      }, timeoutMs);
      this.pendingEvent = {
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }
}

abstract class BaseFixtureAgentContext {
  constructor(protected readonly controller: FixtureAgentController) {}

  get client() {
    return this.controller.client;
  }

  get agent() {
    return this.controller.agent;
  }

  get agentId() {
    return this.agent.agent_id;
  }

  get tileId() {
    return this.agent.tile_id;
  }

  get sessionId() {
    return this.agent.session_id;
  }

  get rootAgentId() {
    return `root:${this.sessionId}`;
  }

  async waitForEvent(
    label: string,
    predicate: (event: AgentChannelEvent) => boolean,
    timeoutMs?: number,
  ): Promise<AgentChannelEvent> {
    return this.controller.waitForEvent(label, predicate, timeoutMs);
  }

  async waitForDirectMessage(message: string, timeoutMs?: number): Promise<AgentChannelEvent> {
    return this.waitForEvent(
      `direct message ${message}`,
      (event) => event.kind === 'direct' && event.message === message,
      timeoutMs,
    );
  }

  async waitForDirectMessageMatching(
    label: string,
    predicate: (message: string, event: AgentChannelEvent) => boolean,
    timeoutMs?: number,
  ): Promise<AgentChannelEvent> {
    return this.waitForEvent(
      label,
      (event) => event.kind === 'direct' && predicate(event.message, event),
      timeoutMs,
    );
  }

  async messageDirect(toAgentId: string, message: string): Promise<void> {
    await this.client.sendCommand({
      command: 'message_direct',
      to_agent_id: toAgentId,
      message,
      sender_agent_id: this.agentId,
      sender_tile_id: this.tileId,
    });
  }

  async messagePublic(message: string, mentions?: string[]): Promise<void> {
    await this.client.sendCommand({
      command: 'message_public',
      message,
      sender_agent_id: this.agentId,
      sender_tile_id: this.tileId,
      mentions: mentions ?? [],
    });
  }

  async messageChannel(channelName: string, message: string, mentions?: string[]): Promise<void> {
    await this.client.sendCommand({
      command: 'message_channel',
      channel_name: channelName,
      message,
      sender_agent_id: this.agentId,
      sender_tile_id: this.tileId,
      mentions: mentions ?? [],
    });
  }

  async messageNetwork(message: string): Promise<void> {
    await this.client.messageNetwork(message, this.tileId, this.agentId);
  }

  async messageRoot(message: string): Promise<void> {
    await this.client.messageRoot(message, this.tileId, this.agentId);
  }
}

export class FixtureRootContext extends BaseFixtureAgentContext {
  async browserDrive<T = unknown>(
    tileId: string,
    action: 'click' | 'select' | 'type' | 'dom_query' | 'eval' | 'screenshot',
    args?: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<T> {
    const result = await this.client.browserDrive<T>(
      tileId,
      action,
      args,
      this.tileId,
      this.agentId,
      timeoutMs,
    );
    return result.result;
  }

  async browserExtensionCall<T = unknown>(
    tileId: string,
    method: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.client.tileCall<T>(
      tileId,
      'extension_call',
      {
        method,
        args: args ?? {},
      },
      this.tileId,
      this.agentId,
    );
    return result.result;
  }

  async tileCreate(
    tileType: TileTypeFilter,
    options?: {
      title?: string | null;
      parentSessionId?: string | null;
      parentTileId?: string | null;
      browserIncognito?: boolean | null;
      browserPath?: string | null;
    },
  ): Promise<SessionTileInfo> {
    return this.client.tileCreate(tileType, {
      ...options,
      senderTileId: this.tileId,
      senderAgentId: this.agentId,
    });
  }

  async tileRename(tileId: string, title: string): Promise<SessionTileInfo> {
    return this.client.tileRename(tileId, title, this.tileId, this.agentId);
  }

  async networkConnect(fromTileId: string, fromPort: string, toTileId: string, toPort: string) {
    return this.client.networkConnect(fromTileId, fromPort, toTileId, toPort, this.tileId, this.agentId);
  }

  async browserLoad(tileId: string, path: string): Promise<void> {
    await this.client.sendCommand({
      command: 'browser_load',
      tile_id: tileId,
      path,
      sender_agent_id: this.agentId,
      sender_tile_id: this.tileId,
    });
  }

  async browserEval<T = unknown>(tileId: string, js: string): Promise<T> {
    return this.browserDrive<T>(tileId, 'eval', { js });
  }

  async waitForBrowserReady(tileId: string, timeoutMs = 60_000): Promise<void> {
    await waitFor(
      `browser ready for ${tileId}`,
      () => this.browserDomQuery<boolean>(
        tileId,
        "Boolean(document.querySelector('#join') && document.querySelector('#status'))",
      ),
      Boolean,
      timeoutMs,
      250,
    );
  }

  async browserClick(tileId: string, selector: string): Promise<{ clicked: boolean }> {
    return this.browserDrive(tileId, 'click', { selector });
  }

  async browserType(tileId: string, selector: string, text: string, clear = true): Promise<{ value: string }> {
    return this.browserDrive(tileId, 'type', { selector, text, clear });
  }

  async browserSelect(tileId: string, selector: string, value: string): Promise<{ value: string }> {
    return this.browserDrive(tileId, 'select', { selector, value });
  }

  async browserDomQuery<T = unknown>(tileId: string, js: string): Promise<T> {
    return this.browserDrive<T>(tileId, 'dom_query', { js });
  }

  async browserText(tileId: string, selector: string): Promise<string> {
    const selectorJson = JSON.stringify(selector);
    return this.browserDomQuery<string>(
      tileId,
      `(document.querySelector(${selectorJson})?.textContent ?? '').trim()`,
    );
  }

  async browserTexts(tileId: string, selector: string): Promise<string[]> {
    const selectorJson = JSON.stringify(selector);
    return this.browserDomQuery<string[]>(
      tileId,
      `Array.from(document.querySelectorAll(${selectorJson})).map((element) => (element.textContent ?? '').trim())`,
    );
  }

  async waitForBrowserText(
    tileId: string,
    label: string,
    selector: string,
    predicate: (value: string) => boolean,
    timeoutMs = 90_000,
  ): Promise<string> {
    return waitFor(
      label,
      () => this.browserText(tileId, selector),
      predicate,
      timeoutMs,
      400,
    );
  }

  async waitForBrowserTexts(
    tileId: string,
    label: string,
    selector: string,
    predicate: (value: string[]) => boolean,
    timeoutMs = 90_000,
  ): Promise<string[]> {
    return waitFor(
      label,
      () => this.browserTexts(tileId, selector),
      predicate,
      timeoutMs,
      400,
    );
  }
}

export class FixtureWorkerContext extends BaseFixtureAgentContext {
  async networkList(tileType?: TileTypeFilter | null): Promise<TileGraph> {
    return this.client.listNetwork(this.tileId, this.agentId, tileType ?? null);
  }

  async networkGet(tileId: string): Promise<SessionTileInfo> {
    return this.client.networkGet(tileId, this.tileId, this.agentId);
  }

  async networkCall<T = unknown>(
    tileId: string,
    action: string,
    args?: Record<string, unknown>,
  ): Promise<{ tile_id: string; action: string; result: T }> {
    return this.client.networkCall<T>(tileId, action, args, this.tileId, this.agentId);
  }

  async browserDrive<T = unknown>(
    browserTitle: string,
    action: 'click' | 'select' | 'type' | 'dom_query' | 'eval' | 'screenshot',
    args?: Record<string, unknown>,
  ): Promise<T> {
    const browser = await this.findConnectedBrowser(browserTitle);
    const result = await this.networkCall<T>(browser.tile_id, 'drive', {
      action,
      args: args ?? {},
    });
    return result.result;
  }

  async browserExtensionCall<T = unknown>(
    browserTitle: string,
    method: string,
    args?: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<T> {
    const browser = await this.findConnectedBrowser(browserTitle);
    const result = await this.client.browserExtensionCall<T>(
      browser.tile_id,
      method,
      args,
      this.tileId,
      this.agentId,
      timeoutMs,
    );
    return result.result;
  }

  async findConnectedBrowser(title: string): Promise<SessionTileInfo> {
    const network = await this.networkList('browser');
    const browser = network.tiles.find((tile) => tile.kind === 'browser' && tile.title === title);
    if (!browser) {
      throw new Error(`worker ${this.agentId} cannot see browser tile titled ${title}`);
    }
    return browser;
  }

  async browserEval<T = unknown>(browserTitle: string, js: string): Promise<T> {
    return this.browserDrive<T>(browserTitle, 'eval', { js });
  }

  async browserClick(browserTitle: string, selector: string): Promise<{ clicked: boolean }> {
    return this.browserDrive(browserTitle, 'click', { selector });
  }

  async browserType(browserTitle: string, selector: string, text: string, clear = true): Promise<{ value: string }> {
    return this.browserDrive(browserTitle, 'type', { selector, text, clear });
  }

  async browserSelect(browserTitle: string, selector: string, value: string): Promise<{ value: string }> {
    return this.browserDrive(browserTitle, 'select', { selector, value });
  }

  async browserDomQuery<T = unknown>(browserTitle: string, js: string): Promise<T> {
    return this.browserDrive(browserTitle, 'dom_query', { js });
  }

  async browserText(browserTitle: string, selector: string): Promise<string> {
    const selectorJson = JSON.stringify(selector);
    return this.browserDomQuery<string>(
      browserTitle,
      `(document.querySelector(${selectorJson})?.textContent ?? '').trim()`,
    );
  }

  async browserTexts(browserTitle: string, selector: string): Promise<string[]> {
    const selectorJson = JSON.stringify(selector);
    return this.browserDomQuery<string[]>(
      browserTitle,
      `Array.from(document.querySelectorAll(${selectorJson})).map((element) => (element.textContent ?? '').trim())`,
    );
  }

  async waitForBrowserText(
    browserTitle: string,
    label: string,
    selector: string,
    predicate: (value: string) => boolean,
    timeoutMs = 90_000,
  ): Promise<string> {
    return waitFor(
      label,
      () => this.browserText(browserTitle, selector),
      predicate,
      timeoutMs,
      400,
    );
  }

  async waitForBrowserTexts(
    browserTitle: string,
    label: string,
    selector: string,
    predicate: (value: string[]) => boolean,
    timeoutMs = 90_000,
  ): Promise<string[]> {
    return waitFor(
      label,
      () => this.browserTexts(browserTitle, selector),
      predicate,
      timeoutMs,
      400,
    );
  }
}

async function waitForFixtureAgent(
  client: HerdTestClient,
  label: string,
  predicate: (agent: AgentInfo) => boolean,
  timeoutMs = 90_000,
): Promise<AgentInfo> {
  const projection = await waitFor(
    label,
    () => client.getProjection(),
    (nextProjection) => nextProjection.agents.some(predicate),
    timeoutMs,
    200,
  );
  const agent = projection.agents.find(predicate);
  if (!agent) {
    throw new Error(`missing fixture agent for ${label}`);
  }
  return agent;
}

export async function attachFixtureRootAgent(
  runtime: HerdIntegrationRuntime,
  client: HerdTestClient,
  sessionId: string,
): Promise<{ controller: FixtureAgentController; context: FixtureRootContext }> {
  const agent = await waitForFixtureAgent(
    client,
    `fixture root agent in session ${sessionId}`,
    (info) => info.session_id === sessionId && info.agent_role === 'root' && info.agent_type === 'fixture',
  );
  const controller = new FixtureAgentController(runtime, client, agent);
  await controller.connect();
  const context = new FixtureRootContext(controller);
  return { controller, context };
}

export async function attachFixtureWorkerByTitle(
  runtime: HerdIntegrationRuntime,
  client: HerdTestClient,
  sessionId: string,
  title: string,
  script: (context: FixtureWorkerContext) => Promise<void>,
): Promise<{ controller: FixtureAgentController; context: FixtureWorkerContext }> {
  const agent = await waitForFixtureAgent(
    client,
    `fixture worker ${title}`,
    (info) =>
      info.session_id === sessionId
      && info.agent_role === 'worker'
      && info.agent_type === 'fixture'
      && info.title === title,
  );
  const controller = new FixtureAgentController(runtime, client, agent);
  await controller.connect();
  const context = new FixtureWorkerContext(controller);
  controller.run(script, context);
  return { controller, context };
}
