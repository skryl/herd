import { invoke } from '@tauri-apps/api/core';
import type { ClaudeMenuData, LayoutStateMap, TmuxSnapshot } from './types';

export async function getTmuxState(): Promise<TmuxSnapshot> {
  return invoke<TmuxSnapshot>('get_tmux_state');
}

export async function getLayoutState(): Promise<LayoutStateMap> {
  return invoke<LayoutStateMap>('get_layout_state');
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

export async function newWindow(targetSessionId?: string | null): Promise<string> {
  return invoke<string>('new_window', { targetSessionId: targetSessionId ?? null });
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
): Promise<void> {
  return invoke('save_layout_state', { paneId, x, y, width, height });
}

export async function tmuxStatus(): Promise<{ server: boolean; cc: boolean }> {
  return invoke<{ server: boolean; cc: boolean }>('tmux_status');
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
