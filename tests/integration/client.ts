import net from 'node:net';
import readline from 'node:readline';

import type {
  AgentInfo,
  AppStateTree,
  NetworkConnection,
  PaneKind,
  SessionTileInfo,
  TileGraph,
  TilePort,
  TileTypeFilter,
  TestDriverKey,
  TestDriverProjection,
  TestDriverRequest,
  TestDriverStatus,
  ChannelInfo,
  WorkItem,
} from '../../src/lib/types';

interface SocketResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export class HerdTestClient {
  constructor(private readonly socketPath: string) {}

  async sendCommand<T = unknown>(command: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const lines = readline.createInterface({ input: socket });
      const timer = setTimeout(() => {
        lines.close();
        socket.destroy();
        reject(new Error(`socket request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.on('connect', () => {
        socket.write(`${JSON.stringify(command)}\n`);
      });

      socket.on('error', (error) => {
        clearTimeout(timer);
        lines.close();
        socket.destroy();
        reject(error);
      });

      lines.on('line', (line) => {
        clearTimeout(timer);
        lines.close();
        socket.destroy();

        try {
          const response = JSON.parse(line) as SocketResponse<T>;
          if (!response.ok) {
            reject(new Error(response.error ?? 'socket request failed'));
            return;
          }
          resolve((response.data ?? null) as T);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async testDriver<T = unknown>(request: TestDriverRequest, timeoutMs = 20_000): Promise<T> {
    return this.sendCommand<T>({ command: 'test_driver', request }, timeoutMs);
  }

  async ping(): Promise<{ pong: boolean; status: TestDriverStatus }> {
    return this.testDriver<{ pong: boolean; status: TestDriverStatus }>({ type: 'ping' });
  }

  async waitForReady(timeoutMs = 60_000): Promise<TestDriverStatus> {
    return this.testDriver<TestDriverStatus>({ type: 'wait_for_ready', timeout_ms: timeoutMs }, timeoutMs + 5_000);
  }

  async waitForBootstrap(timeoutMs = 60_000): Promise<TestDriverStatus> {
    return this.testDriver<TestDriverStatus>({ type: 'wait_for_bootstrap', timeout_ms: timeoutMs }, timeoutMs + 5_000);
  }

  async waitForIdle(timeoutMs = 20_000, settleMs = 150): Promise<void> {
    await this.testDriver({ type: 'wait_for_idle', timeout_ms: timeoutMs, settle_ms: settleMs }, timeoutMs + 5_000);
  }

  async getStateTree(): Promise<AppStateTree> {
    return this.testDriver<AppStateTree>({ type: 'get_state_tree' });
  }

  async getProjection(): Promise<TestDriverProjection> {
    return this.testDriver<TestDriverProjection>({ type: 'get_projection' });
  }

  async getStatus(): Promise<TestDriverStatus> {
    return this.testDriver<TestDriverStatus>({ type: 'get_status' });
  }

  async pressKeys(keys: TestDriverKey[], viewportWidth?: number, viewportHeight?: number) {
    return this.testDriver<{ handled: boolean[] }>({
      type: 'press_keys',
      keys,
      viewport_width: viewportWidth,
      viewport_height: viewportHeight,
    });
  }

  async commandBarOpen() {
    await this.testDriver({ type: 'command_bar_open' });
  }

  async commandBarSetText(text: string) {
    await this.testDriver({ type: 'command_bar_set_text', text });
  }

  async commandBarSubmit() {
    await this.testDriver({ type: 'command_bar_submit' });
  }

  async commandBarCancel() {
    await this.testDriver({ type: 'command_bar_cancel' });
  }

  async toolbarSelectTab(sessionId: string) {
    await this.testDriver({ type: 'toolbar_select_tab', session_id: sessionId });
  }

  async toolbarAddTab(name?: string | null) {
    return this.testDriver<{ id: string; name: string } | null>({ type: 'toolbar_add_tab', name });
  }

  async toolbarSpawnShell() {
    await this.testDriver({ type: 'toolbar_spawn_shell' });
  }

  async toolbarSpawnAgent() {
    await this.testDriver({ type: 'toolbar_spawn_agent' });
  }

  async toolbarSpawnWork(title: string) {
    return this.testDriver<WorkItem>({ type: 'toolbar_spawn_work', title });
  }

  async sidebarOpen() {
    await this.testDriver({ type: 'sidebar_open' });
  }

  async sidebarClose() {
    await this.testDriver({ type: 'sidebar_close' });
  }

  async sidebarSelectItem(index: number) {
    await this.testDriver({ type: 'sidebar_select_item', index });
  }

  async sidebarMoveSelection(delta: number) {
    await this.testDriver({ type: 'sidebar_move_selection', delta });
  }

  async sidebarBeginRename() {
    await this.testDriver({ type: 'sidebar_begin_rename' });
  }

  async driverTileSelect(tileId: string) {
    await this.testDriver({ type: 'tile_select', tile_id: tileId });
  }

  async driverTileClose(tileId: string) {
    await this.testDriver({ type: 'tile_close', tile_id: tileId });
  }

  async driverTileDrag(tileId: string, dx: number, dy: number) {
    await this.testDriver({ type: 'tile_drag', tile_id: tileId, dx, dy });
  }

  async driverTileResize(tileId: string, width: number, height: number) {
    await this.testDriver({ type: 'tile_resize', tile_id: tileId, width, height });
  }

  async driverTileTitleDoubleClick(tileId: string, viewportWidth?: number, viewportHeight?: number) {
    await this.testDriver({
      type: 'tile_title_double_click',
      tile_id: tileId,
      viewport_width: viewportWidth,
      viewport_height: viewportHeight,
    });
  }

  async canvasPan(dx: number, dy: number) {
    await this.testDriver({ type: 'canvas_pan', dx, dy });
  }

  async canvasContextMenu(clientX: number, clientY: number) {
    await this.testDriver({ type: 'canvas_context_menu', client_x: clientX, client_y: clientY });
  }

  async canvasZoomAt(x: number, y: number, zoomFactor: number) {
    await this.testDriver({ type: 'canvas_zoom_at', x, y, zoom_factor: zoomFactor });
  }

  async canvasWheel(deltaY: number, clientX: number, clientY: number) {
    await this.testDriver({ type: 'canvas_wheel', delta_y: deltaY, client_x: clientX, client_y: clientY });
  }

  async canvasFitAll(viewportWidth?: number, viewportHeight?: number) {
    await this.testDriver({ type: 'canvas_fit_all', viewport_width: viewportWidth, viewport_height: viewportHeight });
  }

  async canvasReset() {
    await this.testDriver({ type: 'canvas_reset' });
  }

  async driverTileContextMenu(tileId: string, clientX: number, clientY: number) {
    await this.testDriver({ type: 'tile_context_menu', tile_id: tileId, client_x: clientX, client_y: clientY });
  }

  async driverPortContextMenu(tileId: string, port: TilePort, clientX: number, clientY: number) {
    await this.testDriver({ type: 'port_context_menu', tile_id: tileId, port, client_x: clientX, client_y: clientY });
  }

  async contextMenuSelect(itemId: string) {
    await this.testDriver({ type: 'context_menu_select', item_id: itemId });
  }

  async contextMenuDismiss() {
    await this.testDriver({ type: 'context_menu_dismiss' });
  }

  async confirmCloseTab() {
    await this.testDriver({ type: 'confirm_close_tab' });
  }

  async cancelCloseTab() {
    await this.testDriver({ type: 'cancel_close_tab' });
  }

  async readOutput(tileId: string): Promise<{ output: string }> {
    return this.sendCommand({ command: 'shell_output_read', tile_id: tileId });
  }

  async execInShell(tileId: string, shellCommand: string): Promise<void> {
    await this.sendCommand({ command: 'shell_exec', tile_id: tileId, shell_command: shellCommand });
  }

  async setTileRole(tileId: string, role: PaneKind): Promise<void> {
    await this.sendCommand({ command: 'shell_role_set', tile_id: tileId, role });
  }

  async messageChannelList(senderTileId?: string | null, senderAgentId?: string | null): Promise<ChannelInfo[]> {
    return this.sendCommand({
      command: 'message_channel_list',
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async messageChannelSubscribe(channelName: string, agentId?: string | null, senderTileId?: string | null, senderAgentId?: string | null): Promise<ChannelInfo> {
    return this.sendCommand({
      command: 'message_channel_subscribe',
      channel_name: channelName,
      agent_id: agentId ?? null,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async messageChannelUnsubscribe(channelName: string, agentId?: string | null, senderTileId?: string | null, senderAgentId?: string | null): Promise<ChannelInfo> {
    return this.sendCommand({
      command: 'message_channel_unsubscribe',
      channel_name: channelName,
      agent_id: agentId ?? null,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async agentRegister(
    agentId: string,
    tileId: string,
    title = 'Agent',
    agentRole: 'worker' | 'root' = 'worker',
  ): Promise<{ agent: AgentInfo }> {
    return this.sendCommand({
      command: 'agent_register',
      agent_id: agentId,
      agent_type: 'claude',
      agent_role: agentRole,
      tile_id: tileId,
      title,
    });
  }

  async agentPingAck(agentId: string): Promise<{ agent: AgentInfo }> {
    return this.sendCommand({
      command: 'agent_ping_ack',
      agent_id: agentId,
    });
  }

  async messageDirect(toAgentId: string, message: string, senderTileId?: string | null): Promise<void> {
    await this.sendCommand({
      command: 'message_direct',
      to_agent_id: toAgentId,
      message,
      sender_tile_id: senderTileId ?? null,
    });
  }

  async messagePublic(message: string, senderTileId?: string | null, mentions?: string[]): Promise<void> {
    await this.sendCommand({
      command: 'message_public',
      message,
      sender_tile_id: senderTileId ?? null,
      mentions: mentions ?? [],
    });
  }

  async messageChannel(message: string, channelName: string, senderTileId?: string | null, senderAgentId?: string | null, mentions?: string[]): Promise<void> {
    await this.sendCommand({
      command: 'message_channel',
      channel_name: channelName,
      message,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
      mentions: mentions ?? [],
    });
  }

  async messageNetwork(message: string, senderTileId?: string | null, senderAgentId?: string | null): Promise<void> {
    await this.sendCommand({
      command: 'message_network',
      message,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async messageRoot(message: string, senderTileId?: string | null, senderAgentId?: string | null): Promise<void> {
    await this.sendCommand({
      command: 'message_root',
      message,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async listNetwork(
    senderTileId?: string | null,
    senderAgentId?: string | null,
    tileType?: TileTypeFilter | null,
  ): Promise<TileGraph> {
    return this.sendCommand({
      command: 'network_list',
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
      tile_type: tileType ?? null,
    });
  }

  async networkGet(
    tileId: string,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<SessionTileInfo> {
    return this.sendCommand({
      command: 'network_get',
      tile_id: tileId,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async networkCall<T = unknown>(
    tileId: string,
    action: string,
    args?: Record<string, unknown>,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<{ tile_id: string; action: string; result: T }> {
    return this.sendCommand({
      command: 'network_call',
      tile_id: tileId,
      action,
      args: args ?? {},
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async browserDrive<T = unknown>(
    tileId: string,
    action: 'click' | 'select' | 'type' | 'dom_query' | 'eval' | 'screenshot',
    args?: Record<string, unknown>,
    senderTileId?: string | null,
    senderAgentId?: string | null,
    timeoutMs?: number,
  ): Promise<{ tile_id: string; action: string; result: T }> {
    return this.sendCommand(
      {
        command: 'browser_drive',
        tile_id: tileId,
        action,
        args: args ?? {},
        sender_tile_id: senderTileId ?? null,
        sender_agent_id: senderAgentId ?? null,
      },
      timeoutMs,
    );
  }

  async browserExtensionCall<T = unknown>(
    tileId: string,
    method: string,
    args?: Record<string, unknown>,
    senderTileId?: string | null,
    senderAgentId?: string | null,
    timeoutMs?: number,
  ): Promise<{ tile_id: string; action: string; result: T }> {
    return this.sendCommand(
      {
        command: 'network_call',
        tile_id: tileId,
        action: 'extension_call',
        args: {
          method,
          args: args ?? {},
        },
        sender_tile_id: senderTileId ?? null,
        sender_agent_id: senderAgentId ?? null,
      },
      timeoutMs,
    );
  }

  async tileCreate(
    tileType: TileTypeFilter,
    options?: {
      title?: string | null;
      x?: number | null;
      y?: number | null;
      width?: number | null;
      height?: number | null;
      parentSessionId?: string | null;
      parentTileId?: string | null;
      browserIncognito?: boolean | null;
      browserPath?: string | null;
      senderTileId?: string | null;
      senderAgentId?: string | null;
    },
  ): Promise<SessionTileInfo> {
    return this.sendCommand({
      command: 'tile_create',
      tile_type: tileType,
      title: options?.title ?? null,
      x: options?.x ?? null,
      y: options?.y ?? null,
      width: options?.width ?? null,
      height: options?.height ?? null,
      parent_session_id: options?.parentSessionId ?? null,
      parent_tile_id: options?.parentTileId ?? null,
      browser_incognito: options?.browserIncognito ?? null,
      browser_path: options?.browserPath ?? null,
      sender_tile_id: options?.senderTileId ?? null,
      sender_agent_id: options?.senderAgentId ?? null,
    });
  }

  async tileList(
    senderTileId?: string | null,
    senderAgentId?: string | null,
    tileType?: TileTypeFilter | null,
  ): Promise<TileGraph> {
    return this.sendCommand({
      command: 'tile_list',
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
      tile_type: tileType ?? null,
    });
  }

  async tileDestroy(
    tileId: string,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<void> {
    await this.sendCommand({
      command: 'tile_destroy',
      tile_id: tileId,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async tileGet(
    tileId: string,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<SessionTileInfo> {
    return this.sendCommand({
      command: 'tile_get',
      tile_id: tileId,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async tileRename(
    tileId: string,
    title: string,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<SessionTileInfo> {
    return this.sendCommand({
      command: 'tile_rename',
      tile_id: tileId,
      title,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async tileMove(
    tileId: string,
    x: number,
    y: number,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<SessionTileInfo> {
    return this.sendCommand({
      command: 'tile_move',
      tile_id: tileId,
      x,
      y,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async tileResize(
    tileId: string,
    width: number,
    height: number,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<SessionTileInfo> {
    return this.sendCommand({
      command: 'tile_resize',
      tile_id: tileId,
      width,
      height,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async tileCall<T = unknown>(
    tileId: string,
    action: string,
    args?: Record<string, unknown>,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<{ tile_id: string; action: string; result: T }> {
    return this.sendCommand({
      command: 'tile_call',
      tile_id: tileId,
      action,
      args: args ?? {},
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async getWorkTile(
    workId: string,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<SessionTileInfo> {
    return this.tileGet(`work:${workId}`, senderTileId, senderAgentId);
  }

  async networkConnect(
    fromTileId: string,
    fromPort: string,
    toTileId: string,
    toPort: string,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<NetworkConnection> {
    return this.sendCommand({
      command: 'network_connect',
      from_tile_id: fromTileId,
      from_port: fromPort,
      to_tile_id: toTileId,
      to_port: toPort,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async networkDisconnect(
    tileId: string,
    port: string,
    senderTileId?: string | null,
    senderAgentId?: string | null,
  ): Promise<NetworkConnection | null> {
    return this.sendCommand({
      command: 'network_disconnect',
      tile_id: tileId,
      port,
      sender_tile_id: senderTileId ?? null,
      sender_agent_id: senderAgentId ?? null,
    });
  }

  async workStageStart(workId: string, agentId: string): Promise<WorkItem> {
    return this.sendCommand({
      command: 'work_stage_start',
      work_id: workId,
      agent_id: agentId,
    });
  }

  async workStageComplete(workId: string, agentId: string): Promise<WorkItem> {
    return this.sendCommand({
      command: 'work_stage_complete',
      work_id: workId,
      agent_id: agentId,
    });
  }

  async workReviewApprove(workId: string): Promise<WorkItem> {
    return this.sendCommand({
      command: 'work_review_approve',
      work_id: workId,
    });
  }

  async workReviewImprove(workId: string, comment: string): Promise<WorkItem> {
    return this.sendCommand({
      command: 'work_review_improve',
      work_id: workId,
      comment,
    });
  }

  async testDomQuery<T = unknown>(js: string): Promise<T> {
    return this.sendCommand<T>({ command: 'test_dom_query', js });
  }

  async testDomKeys(keys: string): Promise<void> {
    await this.sendCommand({ command: 'test_dom_keys', keys });
  }
}
