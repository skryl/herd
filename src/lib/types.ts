export interface TerminalInfo {
  id: string;
  paneId: string;
  windowId: string;
  parentWindowId?: string | null;
  sessionId: string;
  tabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  command: string;
  readOnly?: boolean;
  kind?: PaneKind;
}

export interface CanvasState {
  panX: number;
  panY: number;
  zoom: number;
}

export type PaneKind = 'regular' | 'claude' | 'output';

export type ContextMenuTarget = 'canvas' | 'pane';

export interface ClaudeCommandDescriptor {
  name: string;
  execution: 'execute' | 'insert';
  source: 'builtin' | 'custom' | 'skill' | 'mcp' | 'unknown';
}

export interface ClaudeMenuData {
  commands: ClaudeCommandDescriptor[];
  skills: ClaudeCommandDescriptor[];
}

export interface ContextMenuItem {
  id: string;
  label: string;
  kind: 'action' | 'separator' | 'label' | 'status' | 'submenu';
  disabled: boolean;
  children?: ContextMenuItem[];
}

export interface ContextMenuState {
  open: boolean;
  target: ContextMenuTarget;
  paneId: string | null;
  clientX: number;
  clientY: number;
  worldX: number | null;
  worldY: number | null;
  claudeCommands: ClaudeCommandDescriptor[];
  claudeSkills: ClaudeCommandDescriptor[];
  loadingClaudeCommands: boolean;
  claudeCommandsError: string | null;
}

export interface PendingSpawnPlacement {
  sessionId: string;
  worldX: number;
  worldY: number;
}

export type ArrangementMode = 'circle' | 'snowflake' | 'stack-down' | 'stack-right' | 'spiral';

export type CanvasZoomMode = 'focused' | 'fullscreen';

export interface CanvasZoomBookmark {
  mode: CanvasZoomMode;
  paneId: string;
  previousCanvas: CanvasState;
}

export interface CloseTabConfirmation {
  sessionId: string;
  sessionName: string;
  paneCount: number;
}

export interface Tab {
  id: string;
  name: string;
}

export interface SidebarTreeItem {
  type: 'session' | 'window' | 'pane';
  label: string;
  indent: number;
  sessionId?: string;
  windowId?: string;
  paneId?: string;
  command?: string;
  dead?: boolean;
}

export type HerdMode = 'command' | 'input';

export interface TmuxSession {
  id: string;
  name: string;
  active: boolean;
  window_ids: string[];
  active_window_id: string | null;
}

export interface TmuxWindow {
  id: string;
  session_id: string;
  session_name: string;
  index: number;
  name: string;
  active: boolean;
  cols: number;
  rows: number;
  pane_ids: string[];
  parent_window_id?: string | null;
}

export interface TmuxPane {
  id: string;
  session_id: string;
  window_id: string;
  window_index: number;
  pane_index: number;
  cols: number;
  rows: number;
  title: string;
  command: string;
  active: boolean;
  dead: boolean;
}

export interface TmuxSnapshot {
  version: number;
  server_name: string;
  active_session_id: string | null;
  active_window_id: string | null;
  active_pane_id: string | null;
  sessions: TmuxSession[];
  windows: TmuxWindow[];
  panes: TmuxPane[];
}

export interface LayoutEntry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneViewportHint {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface UiState {
  mode: HerdMode;
  commandBarOpen: boolean;
  commandText: string;
  helpOpen: boolean;
  sidebarOpen: boolean;
  sidebarSelectedIdx: number;
  debugPaneOpen: boolean;
  selectedPaneId: string | null;
  paneViewportHints: Record<string, PaneViewportHint>;
  arrangementCycleBySession: Record<string, number>;
  arrangementModeBySession: Record<string, ArrangementMode | null>;
  canvas: CanvasState;
  zoomBookmark: CanvasZoomBookmark | null;
  closeTabConfirmation: CloseTabConfirmation | null;
  contextMenu: ContextMenuState | null;
  pendingSpawnPlacement: PendingSpawnPlacement | null;
}

export interface TmuxStateSlice {
  version: number;
  serverName: string;
  sessions: Record<string, TmuxSession>;
  sessionOrder: string[];
  windows: Record<string, TmuxWindow>;
  windowOrder: string[];
  panes: Record<string, TmuxPane & { readOnly?: boolean; role?: PaneKind }>;
  paneOrderByWindow: Record<string, string[]>;
  activeSessionId: string | null;
  activeWindowId: string | null;
  activePaneId: string | null;
}

export interface LayoutStateSlice {
  entries: Record<string, LayoutEntry>;
}

export interface AppStateTree {
  tmux: TmuxStateSlice;
  layout: LayoutStateSlice;
  ui: UiState;
}

export interface PtyOutputEvent {
  pane_id: string;
  data: string;
}

export interface LayoutStateMap {
  [paneId: string]: LayoutEntry;
}

export interface TestDriverKey {
  key: string;
  shift_key?: boolean;
  ctrl_key?: boolean;
  alt_key?: boolean;
  meta_key?: boolean;
}

export type TestDriverRequest =
  | { type: 'ping' }
  | { type: 'wait_for_ready'; timeout_ms?: number }
  | { type: 'wait_for_bootstrap'; timeout_ms?: number }
  | { type: 'wait_for_idle'; timeout_ms?: number; settle_ms?: number }
  | { type: 'get_state_tree' }
  | { type: 'get_projection' }
  | { type: 'get_status' }
  | { type: 'press_keys'; keys: TestDriverKey[]; viewport_width?: number; viewport_height?: number }
  | { type: 'command_bar_open' }
  | { type: 'command_bar_set_text'; text: string }
  | { type: 'command_bar_submit' }
  | { type: 'command_bar_cancel' }
  | { type: 'toolbar_select_tab'; session_id: string }
  | { type: 'toolbar_add_tab'; name?: string | null }
  | { type: 'toolbar_spawn_shell' }
  | { type: 'sidebar_open' }
  | { type: 'sidebar_close' }
  | { type: 'sidebar_select_item'; index: number }
  | { type: 'sidebar_move_selection'; delta: number }
  | { type: 'sidebar_begin_rename' }
  | { type: 'tile_select'; pane_id: string }
  | { type: 'tile_close'; pane_id: string }
  | { type: 'tile_drag'; pane_id: string; dx: number; dy: number }
  | { type: 'tile_resize'; pane_id: string; width: number; height: number }
  | { type: 'tile_title_double_click'; pane_id: string; viewport_width?: number; viewport_height?: number }
  | { type: 'canvas_pan'; dx: number; dy: number }
  | { type: 'canvas_context_menu'; client_x: number; client_y: number }
  | { type: 'canvas_zoom_at'; x: number; y: number; zoom_factor: number }
  | { type: 'canvas_wheel'; delta_y: number; client_x: number; client_y: number }
  | { type: 'canvas_fit_all'; viewport_width?: number; viewport_height?: number }
  | { type: 'canvas_reset' }
  | { type: 'tile_context_menu'; pane_id: string; client_x: number; client_y: number }
  | { type: 'context_menu_select'; item_id: string }
  | { type: 'context_menu_dismiss' }
  | { type: 'confirm_close_tab' }
  | { type: 'cancel_close_tab' };

export interface TestDriverStatus {
  enabled: boolean;
  frontend_ready: boolean;
  bootstrap_complete: boolean;
  runtime_id: string | null;
  tmux_server_name: string;
  socket_path: string;
  tmux_server_alive: boolean;
  control_client_alive: boolean;
}

export interface TestDriverProjection {
  mode: HerdMode;
  command_bar: {
    open: boolean;
    text: string;
  };
  help_open: boolean;
  sidebar: {
    open: boolean;
    selected_index: number;
    items: SidebarTreeItem[];
  };
  close_tab_confirmation: CloseTabConfirmation | null;
  context_menu: {
    target: ContextMenuTarget;
    pane_id: string | null;
    client_x: number;
    client_y: number;
    world_x: number | null;
    world_y: number | null;
    claude_commands: ClaudeCommandDescriptor[];
    claude_skills: ClaudeCommandDescriptor[];
    loading_claude_commands: boolean;
    claude_commands_error: string | null;
    items: ContextMenuItem[];
  } | null;
  selected_pane_id: string | null;
  canvas: CanvasState;
  tabs: Tab[];
  active_tab_id: string | null;
  active_tab_terminals: TerminalInfo[];
  active_tab_connections: Array<{
    child_window_id: string;
    parent_window_id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    cx1: number;
    cy1: number;
    cx2: number;
    cy2: number;
  }>;
  indicators: {
    tmux: boolean;
    cc: boolean;
    sock: boolean;
  };
}
