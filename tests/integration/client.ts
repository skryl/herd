import net from 'node:net';
import readline from 'node:readline';

import type {
  AppStateTree,
  PaneKind,
  TestDriverKey,
  TestDriverProjection,
  TestDriverRequest,
  TestDriverStatus,
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

  async tileSelect(paneId: string) {
    await this.testDriver({ type: 'tile_select', pane_id: paneId });
  }

  async tileClose(paneId: string) {
    await this.testDriver({ type: 'tile_close', pane_id: paneId });
  }

  async tileDrag(paneId: string, dx: number, dy: number) {
    await this.testDriver({ type: 'tile_drag', pane_id: paneId, dx, dy });
  }

  async tileResize(paneId: string, width: number, height: number) {
    await this.testDriver({ type: 'tile_resize', pane_id: paneId, width, height });
  }

  async tileTitleDoubleClick(paneId: string, viewportWidth?: number, viewportHeight?: number) {
    await this.testDriver({
      type: 'tile_title_double_click',
      pane_id: paneId,
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

  async tileContextMenu(paneId: string, clientX: number, clientY: number) {
    await this.testDriver({ type: 'tile_context_menu', pane_id: paneId, client_x: clientX, client_y: clientY });
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

  async listShells(): Promise<Array<Record<string, unknown>>> {
    return this.sendCommand({ command: 'list_shells' });
  }

  async readOutput(sessionId: string): Promise<{ output: string }> {
    return this.sendCommand({ command: 'read_output', session_id: sessionId });
  }

  async execInShell(sessionId: string, shellCommand: string): Promise<void> {
    await this.sendCommand({ command: 'exec_in_shell', session_id: sessionId, shell_command: shellCommand });
  }

  async setTileRole(sessionId: string, role: PaneKind): Promise<void> {
    await this.sendCommand({ command: 'set_tile_role', session_id: sessionId, role });
  }

  async testDomQuery<T = unknown>(js: string): Promise<T> {
    return this.sendCommand<T>({ command: 'test_dom_query', js });
  }

  async testDomKeys(keys: string): Promise<void> {
    await this.sendCommand({ command: 'test_dom_keys', keys });
  }
}
