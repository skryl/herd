export interface TerminalInfo {
  id: string;
  paneId: string;
  windowId: string;
  sessionId: string;
  tabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  command: string;
  readOnly?: boolean;
}

export interface CanvasState {
  panX: number;
  panY: number;
  zoom: number;
}

export type CanvasZoomMode = 'focused' | 'fullscreen';

export interface CanvasZoomBookmark {
  mode: CanvasZoomMode;
  paneId: string;
  previousCanvas: CanvasState;
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
  canvas: CanvasState;
  zoomBookmark: CanvasZoomBookmark | null;
}

export interface TmuxStateSlice {
  version: number;
  serverName: string;
  sessions: Record<string, TmuxSession>;
  sessionOrder: string[];
  windows: Record<string, TmuxWindow>;
  windowOrder: string[];
  panes: Record<string, TmuxPane & { readOnly?: boolean }>;
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
