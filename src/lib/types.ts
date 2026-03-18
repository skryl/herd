export interface TerminalInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  sessionId?: string;
  paneId?: string;
  tabId: string;
  parentSessionId?: string;
  readOnly?: boolean;
}

export interface CanvasState {
  panX: number;
  panY: number;
  zoom: number;
}

export interface Tab {
  id: string;
  name: string;
}

export type HerdMode = 'command' | 'input';

export interface ShellSpawnedEvent {
  session_id: string;
  pane_id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parent_session_id?: string;
}

export interface ShellTitleChangedEvent {
  session_id: string;
  title: string;
}
