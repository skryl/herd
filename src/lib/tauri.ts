import { invoke } from '@tauri-apps/api/core';
import type {
  AgentBrowserInstallStatus,
  AgentDebugState,
  BrowserBackend,
  BrowserExtensionPage,
  ClaudeMenuData,
  LayoutStateMap,
  LoadedSessionConfiguration,
  NetworkConnection,
  PortMode,
  PortNetworkingMode,
  SavedSessionConfigurationSummary,
  TilePortSetting,
  TilePort,
  TmuxSnapshot,
  WorkItem,
} from './types';

export interface BrowserWebviewViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  pageZoom: number;
}

export interface BrowserWebviewState {
  currentUrl: string;
  backend: BrowserBackend;
  screenshotDataUrl?: string | null;
}

export type BrowserPreviewFormat = 'text' | 'braille' | 'ansi' | 'ascii';

export interface BrowserTextPreviewResult {
  format: BrowserPreviewFormat;
  text: string;
  columns: number;
  rows: number;
}

export async function getTmuxState(): Promise<TmuxSnapshot> {
  return invoke<TmuxSnapshot>('get_tmux_state');
}

export async function getLayoutState(): Promise<LayoutStateMap> {
  return invoke<LayoutStateMap>('get_layout_state');
}

export async function getAgentDebugState(): Promise<AgentDebugState> {
  return invoke<AgentDebugState>('get_agent_debug_state');
}

export async function getWorkItems(sessionId?: string | null): Promise<WorkItem[]> {
  return invoke<WorkItem[]>('get_work_items', { sessionId: sessionId ?? null });
}

export async function sendRootMessageCommand(message: string): Promise<void> {
  return invoke('send_root_message_command', { message });
}

export async function sendDirectMessageCommand(target: string, message: string): Promise<void> {
  return invoke('send_direct_message_command', { target, message });
}

export async function sendPublicMessageCommand(message: string): Promise<void> {
  return invoke('send_public_message_command', { message });
}

export async function createWorkItem(title: string, sessionId?: string | null): Promise<WorkItem> {
  return invoke<WorkItem>('create_work_item', { title, sessionId: sessionId ?? null });
}

export async function deleteWorkItem(workId: string): Promise<void> {
  return invoke('delete_work_item', { workId });
}

export async function approveWorkItem(workId: string): Promise<WorkItem> {
  return invoke<WorkItem>('approve_work_item', { workId });
}

export async function improveWorkItem(workId: string, comment: string): Promise<WorkItem> {
  return invoke<WorkItem>('improve_work_item', { workId, comment });
}

export async function readWorkStagePreview(workId: string): Promise<string> {
  return invoke<string>('read_work_stage_preview', { workId });
}

export async function connectNetworkTiles(
  fromTileId: string,
  fromPort: TilePort,
  toTileId: string,
  toPort: TilePort,
): Promise<NetworkConnection> {
  return invoke<NetworkConnection>('connect_network_tiles', { fromTileId, fromPort, toTileId, toPort });
}

export async function disconnectNetworkPort(
  tileId: string,
  port: TilePort,
): Promise<NetworkConnection | null> {
  return invoke<NetworkConnection | null>('disconnect_network_port', { tileId, port });
}

export async function setNetworkPortSettings(
  tileId: string,
  port: TilePort,
  accessMode?: PortMode | null,
  networkingMode?: PortNetworkingMode | null,
): Promise<TilePortSetting> {
  return invoke<TilePortSetting>('set_network_port_settings', {
    tileId,
    port,
    accessMode: accessMode ?? null,
    networkingMode: networkingMode ?? null,
  });
}

export async function newSession(name?: string): Promise<string> {
  return invoke<string>('new_session', { name: name ?? null });
}

export async function killSession(sessionId: string): Promise<void> {
  return invoke('kill_session', { sessionId });
}

export async function selectSession(sessionId: string): Promise<void> {
  return invoke('select_session', { sessionId });
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
  return invoke('rename_session', { sessionId, name });
}

export async function listSavedSessionConfigurations(): Promise<SavedSessionConfigurationSummary[]> {
  return invoke<SavedSessionConfigurationSummary[]>('list_saved_session_configurations');
}

export async function saveSessionConfiguration(
  sessionId: string,
  minimizedTileIds: string[],
  layoutEntriesByTile: LayoutStateMap,
): Promise<SavedSessionConfigurationSummary> {
  return invoke<SavedSessionConfigurationSummary>('save_session_configuration', {
    sessionId,
    minimizedTileIds,
    layoutEntriesByTile,
  });
}

export async function loadSessionConfiguration(
  sessionId: string,
  configName: string,
): Promise<LoadedSessionConfiguration> {
  return invoke<LoadedSessionConfiguration>('load_session_configuration', { sessionId, configName });
}

export async function deleteSessionConfiguration(configName: string): Promise<void> {
  return invoke('delete_session_configuration', { configName });
}

export async function setSessionRootCwd(sessionId: string, cwd: string): Promise<string> {
  return invoke<string>('set_session_root_cwd', { sessionId, cwd });
}

export async function setSessionBrowserBackend(sessionId: string, backend: BrowserBackend): Promise<string> {
  return invoke<string>('set_session_browser_backend', { sessionId, backend });
}

export async function getAgentBrowserInstallStatus(): Promise<AgentBrowserInstallStatus> {
  return invoke<AgentBrowserInstallStatus>('get_agent_browser_install_status');
}

export async function setAgentBrowserInstallDeclined(declined: boolean): Promise<AgentBrowserInstallStatus> {
  return invoke<AgentBrowserInstallStatus>('set_agent_browser_install_declined', { declined });
}

export async function installAgentBrowserRuntime(): Promise<AgentBrowserInstallStatus> {
  return invoke<AgentBrowserInstallStatus>('install_agent_browser_runtime');
}

export async function newWindow(targetSessionId?: string | null): Promise<string> {
  return invoke<string>('new_window', { targetSessionId: targetSessionId ?? null });
}

export async function spawnAgentWindow(targetSessionId?: string | null): Promise<{
  agent_id: string;
  agent_type: 'claude' | 'fixture';
  agent_role: 'root' | 'worker';
  pane_id: string;
  window_id: string;
  session_id: string;
  cwd: string;
}> {
  return invoke('spawn_agent_window', { targetSessionId: targetSessionId ?? null });
}

export async function spawnBrowserWindow(
  targetSessionId?: string | null,
  browserIncognito?: boolean | null,
  browserPath?: string | null,
): Promise<string> {
  return invoke<string>('spawn_browser_window', {
    targetSessionId: targetSessionId ?? null,
    browserIncognito: browserIncognito ?? null,
    browserPath: browserPath ?? null,
  });
}

export async function syncBrowserWebview(
  paneId: string,
  viewport: BrowserWebviewViewport,
  initialUrl?: string | null,
): Promise<BrowserWebviewState> {
  return invoke<BrowserWebviewState>('browser_webview_sync', {
    paneId,
    viewport,
    initialUrl: initialUrl ?? null,
  });
}

export async function navigateBrowserWebview(
  paneId: string,
  url: string,
): Promise<BrowserWebviewState> {
  return invoke<BrowserWebviewState>('browser_webview_navigate', { paneId, url });
}

export async function loadBrowserWebview(
  paneId: string,
  path: string,
): Promise<BrowserWebviewState> {
  return invoke<BrowserWebviewState>('browser_webview_load', { paneId, path });
}

export async function reloadBrowserWebview(paneId: string): Promise<BrowserWebviewState> {
  return invoke<BrowserWebviewState>('browser_webview_reload', { paneId });
}

export async function backBrowserWebview(paneId: string): Promise<BrowserWebviewState> {
  return invoke<BrowserWebviewState>('browser_webview_back', { paneId });
}

export async function forwardBrowserWebview(paneId: string): Promise<BrowserWebviewState> {
  return invoke<BrowserWebviewState>('browser_webview_forward', { paneId });
}

export async function hideBrowserWebview(paneId: string): Promise<void> {
  return invoke('browser_webview_hide', { paneId });
}

export async function readBrowserPreview(
  paneId: string,
  format?: BrowserPreviewFormat | null,
  columns?: number | null,
): Promise<BrowserTextPreviewResult> {
  return invoke<BrowserTextPreviewResult>('browser_webview_preview', {
    paneId,
    format: format ?? null,
    columns: columns ?? null,
  });
}

export async function getBrowserExtensionPages(): Promise<BrowserExtensionPage[]> {
  return invoke<BrowserExtensionPage[]>('browser_extension_pages');
}

export async function splitPane(targetPaneId?: string | null): Promise<string> {
  return invoke<string>('split_pane', { targetPaneId: targetPaneId ?? null });
}

export async function killWindow(windowId: string): Promise<void> {
  return invoke('kill_window', { windowId });
}

export async function killPane(paneId: string): Promise<void> {
  return invoke('kill_pane', { paneId });
}

export async function selectWindow(windowId: string): Promise<void> {
  return invoke('select_window', { windowId });
}

export async function resizeWindow(windowId: string, cols: number, rows: number): Promise<void> {
  return invoke('resize_window', { windowId, cols, rows });
}

export async function renameWindow(windowId: string, name: string): Promise<void> {
  return invoke('rename_window', { windowId, name });
}

export async function setPaneTitle(paneId: string, title: string): Promise<void> {
  return invoke('set_pane_title', { paneId, title });
}

export async function writePane(paneId: string, data: string): Promise<void> {
  return invoke('write_pty', { sessionId: paneId, data });
}

export async function readPaneOutput(paneId: string): Promise<string> {
  return invoke<string>('read_pty_output', { sessionId: paneId });
}

export async function saveLayoutState(
  paneId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  locked = false,
): Promise<void> {
  return invoke('save_layout_state', { paneId, x, y, width, height, locked });
}

export async function tmuxStatus(): Promise<{ server: boolean; cc: boolean }> {
  return invoke<{ server: boolean; cc: boolean }>('tmux_status');
}

export async function clearDebugLogs(): Promise<void> {
  return invoke('clear_debug_logs');
}

export async function setTestDriverState(options: {
  frontendReady?: boolean;
  bootstrapComplete?: boolean;
}): Promise<void> {
  return invoke('__set_test_driver_state', {
    frontendReady: options.frontendReady ?? null,
    bootstrapComplete: options.bootstrapComplete ?? null,
  });
}

export async function getClaudeMenuDataForPane(paneId: string): Promise<ClaudeMenuData> {
  return invoke<ClaudeMenuData>('get_claude_menu_data_for_pane', { paneId });
}

export async function resolveTestDriverRequest(
  requestId: string,
  data?: unknown,
  error?: string,
): Promise<void> {
  return invoke('__resolve_test_driver_request', {
    requestId,
    data: data ?? null,
    error: error ?? null,
  });
}
