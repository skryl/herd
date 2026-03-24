export interface TerminalInfo {
  id: string;
  tileId: string;
  paneId: string;
  windowId: string;
  parentWindowId?: string | null;
  parentWindowSource?: WindowParentSource | null;
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
  agentId?: string | null;
}

export interface CanvasState {
  panX: number;
  panY: number;
  zoom: number;
}

export type PaneKind = 'regular' | 'claude' | 'root_agent' | 'browser' | 'output';
export type DebugTab = 'info' | 'chatter' | 'logs';
export type AgentType = 'claude';
export type AgentRole = 'root' | 'worker';
export type SidebarSection = 'settings' | 'work' | 'agents' | 'tmux';
export type TilePort = 'left' | 'top' | 'right' | 'bottom';
export type PortMode = 'read' | 'read_write';
export type NetworkTileKind = 'agent' | 'root_agent' | 'shell' | 'work' | 'browser';
export type WindowParentSource = 'hook' | 'manual';

export interface AgentInfo {
  agent_id: string;
  agent_type: AgentType;
  agent_role: AgentRole;
  tile_id: string;
  window_id: string;
  session_id: string;
  title: string;
  display_name: string;
  alive: boolean;
  chatter_subscribed: boolean;
  topics: string[];
  agent_pid?: number | null;
}

export interface TopicInfo {
  session_id: string;
  name: string;
  subscriber_count: number;
  last_activity_at?: number | null;
}

export type AgentLogKind = 'incoming_hook' | 'outgoing_call';

export interface AgentLogEntry {
  session_id: string;
  agent_id: string;
  tile_id: string;
  kind: AgentLogKind;
  text: string;
  timestamp_ms: number;
}

export type TileMessageChannel = 'cli' | 'socket' | 'mcp' | 'internal';
export type TileMessageLogLayer = 'socket' | 'message' | 'network';
export type TileMessageOutcome = 'ok' | 'not_found' | 'error';

export interface TileMessageLogEntry {
  session_id: string;
  layer: TileMessageLogLayer;
  channel: TileMessageChannel;
  target_id: string;
  target_kind: string;
  wrapper_command: string;
  message_name: string;
  caller_agent_id?: string | null;
  caller_tile_id?: string | null;
  caller_window_id?: string | null;
  args: unknown;
  related_tile_ids: string[];
  outcome: TileMessageOutcome;
  error?: string | null;
  duration_ms: number;
  timestamp_ms: number;
}

export type WorkStage = 'plan' | 'prd' | 'artifact';
export type WorkStageStatus = 'ready' | 'in_progress' | 'completed' | 'approved';
export type WorkReviewDecision = 'approve' | 'improve';

export interface WorkStageState {
  stage: WorkStage;
  status: WorkStageStatus;
}

export interface WorkReviewEntry {
  stage: WorkStage;
  decision: WorkReviewDecision;
  comment?: string | null;
  created_at: number;
}

export interface WorkItem {
  work_id: string;
  tile_id: string;
  session_id: string;
  title: string;
  topic: string;
  owner_agent_id?: string | null;
  current_stage: WorkStage;
  stages: WorkStageState[];
  reviews: WorkReviewEntry[];
  created_at: number;
  updated_at: number;
}

export interface NetworkConnection {
  session_id: string;
  from_tile_id: string;
  from_port: TilePort;
  to_tile_id: string;
  to_port: TilePort;
}

export type TileTypeFilter = 'agent' | 'shell' | 'browser' | 'work';

export interface AgentTileDetails {
  agent_id: string;
  agent_type: AgentType;
  agent_role: AgentRole;
  display_name: string;
  alive: boolean;
  chatter_subscribed: boolean;
  topics: string[];
  agent_pid?: number | null;
}

export interface PaneTileDetails {
  window_name: string;
  window_index: number;
  pane_index: number;
  cols: number;
  rows: number;
  active: boolean;
  dead: boolean;
}

export interface BrowserTileDetails extends PaneTileDetails {
  current_url?: string | null;
}

export interface WorkTileDetails {
  work_id: string;
  topic: string;
  owner_agent_id?: string | null;
  current_stage: WorkStage;
  stages: WorkStageState[];
  reviews: WorkReviewEntry[];
  created_at: number;
  updated_at: number;
}

export type TileDetails = AgentTileDetails | PaneTileDetails | BrowserTileDetails | WorkTileDetails;

export interface TileMessageArgSpec {
  name: string;
  type: string;
  required: boolean;
  description?: string | null;
  enum_values?: string[];
}

export interface TileMessageSubcommandSpec {
  name: string;
  description?: string | null;
  args?: TileMessageArgSpec[];
}

export interface TileMessageSpec {
  name: string;
  description?: string | null;
  args?: TileMessageArgSpec[];
  subcommands?: TileMessageSubcommandSpec[];
}

export interface SessionTileInfo {
  tile_id: string;
  session_id: string;
  kind: NetworkTileKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  window_id?: string | null;
  parent_window_id?: string | null;
  parent_window_source?: WindowParentSource | null;
  command?: string | null;
  responds_to: string[];
  message_api: TileMessageSpec[];
  details: TileDetails;
}

export interface ProjectedTerminalInfo {
  id: string;
  windowId: string;
  parentWindowId?: string | null;
  parentWindowSource?: WindowParentSource | null;
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
  agentId?: string | null;
}

export interface ProjectionSidebarTreeItem {
  type: 'session' | 'window' | 'tile';
  label: string;
  indent: number;
  sessionId?: string;
  windowId?: string;
  tileId?: string;
  command?: string;
  dead?: boolean;
}

export interface ProjectionCloseTileConfirmation {
  tileId: string;
  title: string;
  message: string;
  confirmLabel: string;
}

export type ProjectionContextMenuTarget = 'canvas' | 'tile';

export interface ProjectionContextMenu {
  target: ProjectionContextMenuTarget;
  tile_id: string | null;
  client_x: number;
  client_y: number;
  world_x: number | null;
  world_y: number | null;
  claude_commands: ClaudeCommandDescriptor[];
  claude_skills: ClaudeCommandDescriptor[];
  loading_claude_commands: boolean;
  claude_commands_error: string | null;
  items: ContextMenuItem[];
}

export interface TileGraph {
  session_id: string;
  sender_tile_id?: string | null;
  tiles: SessionTileInfo[];
  connections: NetworkConnection[];
}

export type ChatterKind = 'direct' | 'public' | 'network' | 'root' | 'sign_on' | 'sign_off';

export interface ChatterEntry {
  session_id: string;
  kind: ChatterKind;
  from_agent_id?: string | null;
  from_display_name: string;
  to_agent_id?: string | null;
  to_display_name?: string | null;
  message: string;
  topics: string[];
  mentions: string[];
  timestamp_ms: number;
  public: boolean;
  display_text: string;
}

export interface TileActivityEntry {
  kind:
    | 'incoming_dm'
    | 'outgoing_dm'
    | 'outgoing_chatter'
    | 'mention'
    | 'topic'
    | 'incoming_hook'
    | 'outgoing_call'
    | 'socket_log'
    | 'message_log'
    | 'network_log';
  text: string;
  timestamp_ms: number;
}

export interface WorkCanvasCard {
  workId: string;
  tileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentDebugState {
  agents: AgentInfo[];
  topics: TopicInfo[];
  chatter: ChatterEntry[];
  agent_logs: AgentLogEntry[];
  tile_message_logs: TileMessageLogEntry[];
  connections: NetworkConnection[];
}

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

export interface ClosePaneConfirmation {
  paneId: string;
  title: string;
  message: string;
  confirmLabel: string;
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
  root_cwd?: string | null;
}

export interface TmuxWindow {
  id: string;
  tile_id?: string | null;
  session_id: string;
  session_name: string;
  index: number;
  name: string;
  active: boolean;
  cols: number;
  rows: number;
  pane_ids: string[];
  parent_window_id?: string | null;
  parent_window_source?: WindowParentSource | null;
}

export interface TmuxPane {
  id: string;
  tile_id?: string | null;
  role?: PaneKind | null;
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
  sidebarSection: SidebarSection;
  sidebarSelectedIdx: number;
  debugPaneOpen: boolean;
  debugPaneHeight: number;
  debugTab: DebugTab;
  selectedPaneId: string | null;
  selectedWorkId: string | null;
  paneViewportHints: Record<string, PaneViewportHint>;
  arrangementCycleBySession: Record<string, number>;
  arrangementModeBySession: Record<string, ArrangementMode | null>;
  canvas: CanvasState;
  zoomBookmark: CanvasZoomBookmark | null;
  closeTabConfirmation: CloseTabConfirmation | null;
  closePaneConfirmation: ClosePaneConfirmation | null;
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
  agents: Record<string, AgentInfo>;
  topics: Record<string, TopicInfo>;
  chatter: ChatterEntry[];
  agentLogs: AgentLogEntry[];
  tileMessageLogs: TileMessageLogEntry[];
  network: {
    connections: NetworkConnection[];
  };
  work: {
    items: Record<string, WorkItem>;
    order: string[];
  };
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
  | { type: 'toolbar_spawn_agent' }
  | { type: 'toolbar_spawn_work'; title: string }
  | { type: 'sidebar_open' }
  | { type: 'sidebar_close' }
  | { type: 'sidebar_select_item'; index: number }
  | { type: 'sidebar_move_selection'; delta: number }
  | { type: 'sidebar_begin_rename' }
  | { type: 'tile_select'; tile_id: string }
  | { type: 'tile_close'; tile_id: string }
  | { type: 'tile_drag'; tile_id: string; dx: number; dy: number }
  | { type: 'tile_resize'; tile_id: string; width: number; height: number }
  | { type: 'tile_title_double_click'; tile_id: string; viewport_width?: number; viewport_height?: number }
  | { type: 'canvas_pan'; dx: number; dy: number }
  | { type: 'canvas_context_menu'; client_x: number; client_y: number }
  | { type: 'canvas_zoom_at'; x: number; y: number; zoom_factor: number }
  | { type: 'canvas_wheel'; delta_y: number; client_x: number; client_y: number }
  | { type: 'canvas_fit_all'; viewport_width?: number; viewport_height?: number }
  | { type: 'canvas_reset' }
  | { type: 'tile_context_menu'; tile_id: string; client_x: number; client_y: number }
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
    section: SidebarSection;
    selected_index: number;
    items: ProjectionSidebarTreeItem[];
  };
  close_tab_confirmation: CloseTabConfirmation | null;
  close_pane_confirmation: ProjectionCloseTileConfirmation | null;
  context_menu: ProjectionContextMenu | null;
  selected_tile_id: string | null;
  selected_work_id: string | null;
  debug_tab: DebugTab;
  agents: AgentInfo[];
  topics: TopicInfo[];
  chatter: ChatterEntry[];
  agent_logs: AgentLogEntry[];
  tile_message_logs: TileMessageLogEntry[];
  tile_activity_by_id: Record<string, TileActivityEntry[]>;
  work_items: WorkItem[];
  canvas: CanvasState;
  tabs: Tab[];
  active_tab_id: string | null;
  active_tab_terminals: ProjectedTerminalInfo[];
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
  active_tab_network_connections: NetworkConnection[];
  active_tab_work_cards: WorkCanvasCard[];
  indicators: {
    tmux: boolean;
    cc: boolean;
    sock: boolean;
  };
}
