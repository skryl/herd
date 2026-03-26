import { tick } from 'svelte';
import { derived, get, writable, type Readable, type Writable } from 'svelte/store';
import ELK from 'elkjs/lib/elk.bundled.js';
import {
  routeWireGeometries,
  wirePathFromPoints,
  type RoutedWireGeometry,
  type WireRouteSpec,
} from '../wireRouting';
import {
  DEFAULT_TILE_PORT_COUNT,
  tilePortOffsetRatio,
  tilePortsForCount,
  tilePortSide,
  visibleTilePortSlotsBySide,
  visibleTilePorts,
} from '../tilePorts';
import {
  connectNetworkTiles,
  deleteWorkItem as deleteWorkItemCommand,
  disconnectNetworkPort,
  getBrowserExtensionPages,
  sendDirectMessageCommand,
  sendPublicMessageCommand,
  getWorkItems,
  getAgentDebugState,
  getClaudeMenuDataForPane,
  getLayoutState,
  getTmuxState,
  killSession,
  killWindow,
  newSession,
  newWindow,
  renameSession,
  renameWindow,
  resizeWindow,
  saveLayoutState,
  sendRootMessageCommand,
  selectSession,
  selectWindow,
  setPaneTitle,
  loadBrowserWebview,
  spawnBrowserWindow,
  spawnAgentWindow,
  writePane,
} from '../tauri';
import type {
  AgentDebugState,
  AgentInfo,
  ArrangementMode,
  AppStateTree,
  CanvasState,
  CanvasZoomMode,
  ChannelInfo,
  ChatterEntry,
  ClaudeCommandDescriptor,
  ClosePaneConfirmation,
  CloseTabConfirmation,
  BrowserExtensionPage,
  ContextMenuItem,
  ContextMenuState,
  DebugTab,
  HerdMode,
  LayoutEntry,
  LayoutStateMap,
  NetworkConnection,
  NetworkTileKind,
  PortMode,
  PendingSpawnPlacement,
  PaneViewportHint,
  PaneKind,
  PtyOutputEvent,
  SidebarSection,
  SidebarTreeItem,
  Tab,
  TerminalInfo,
  TestDriverProjection,
  TestDriverStatus,
  TileActivityEntry,
  TileMessageLogEntry,
  TilePortCount,
  TilePort,
  WorkCanvasCard,
  WorkItem,
  TmuxPane,
  TmuxSession,
  TmuxSnapshot,
  TmuxWindow,
  UiState,
} from '../types';

const GRID_SNAP = 20;
const GAP = 30;
const DEFAULT_TILE_WIDTH = 640;
const DEFAULT_TILE_HEIGHT = 400;
const WORK_CARD_WIDTH = 360;
const WORK_CARD_HEIGHT = 320;
const MIN_CANVAS_ZOOM = 0.05;
const MAX_CANVAS_ZOOM = 3;
const DEFAULT_DEBUG_PANE_HEIGHT = 200;
const NETWORK_SNAP_DISTANCE = 44;
const SIDEBAR_SECTIONS: SidebarSection[] = ['settings', 'work', 'agents', 'tmux'];
const AUTO_ARRANGE_PATTERNS: ArrangementMode[] = ['circle', 'snowflake', 'stack-down', 'stack-right', 'spiral'];
const ELK_PORT_SIZE = 8;
const ELK_LAYOUT = new ELK();
const BROWSER_WEBVIEW_MOTION_SETTLE_MS = 140;

let browserWebviewMotionSettleTimer: ReturnType<typeof setTimeout> | null = null;

type TmuxEffect =
  | { type: 'new-session'; name?: string }
  | { type: 'new-window'; sessionId?: string | null }
  | { type: 'new-agent-window'; sessionId?: string | null }
  | { type: 'new-browser-window'; sessionId?: string | null }
  | { type: 'kill-session'; sessionId: string }
  | { type: 'kill-window'; windowId: string }
  | { type: 'select-session'; sessionId: string }
  | { type: 'select-window'; windowId: string }
  | { type: 'rename-session'; sessionId: string; name: string }
  | { type: 'rename-window'; windowId: string; name: string }
  | { type: 'write-pane'; paneId: string; data: string }
  | { type: 'load-browser-file'; paneId: string; path: string }
  | { type: 'open-work-dialog'; placement: PendingSpawnPlacement | null };

export type UiIntent =
  | { type: 'new-shell' }
  | { type: 'new-agent' }
  | { type: 'new-browser' }
  | { type: 'new-tab' }
  | { type: 'close-selected-pane' }
  | { type: 'close-active-tab' }
  | { type: 'confirm-close-pane' }
  | { type: 'cancel-close-pane' }
  | { type: 'confirm-close-active-tab' }
  | { type: 'cancel-close-active-tab' }
  | { type: 'select-session'; sessionId: string }
  | { type: 'select-next-tab' }
  | { type: 'select-prev-tab' }
  | { type: 'rename-active-tab'; name: string }
  | { type: 'rename-selected-pane'; name: string }
  | { type: 'toggle-sidebar' }
  | { type: 'set-sidebar-section'; section: SidebarSection }
  | { type: 'move-sidebar-section'; delta: number }
  | { type: 'set-sidebar-selection'; index: number }
  | { type: 'move-sidebar-selection'; delta: number }
  | { type: 'select-work-item'; workId: string }
  | { type: 'select-agent-item'; agentId: string }
  | { type: 'toggle-debug' }
  | { type: 'open-command-bar' }
  | { type: 'close-command-bar' }
  | { type: 'set-command-text'; text: string }
  | { type: 'open-help' }
  | { type: 'close-help' }
  | { type: 'enter-input-mode' }
  | { type: 'exit-input-mode' }
  | { type: 'send-input'; data: string }
  | { type: 'toggle-selected-zoom'; viewportWidth: number; viewportHeight: number }
  | { type: 'toggle-selected-fullscreen-zoom'; viewportWidth: number; viewportHeight: number }
  | { type: 'move-selected-pane'; dx: number; dy: number }
  | { type: 'select-debug-tab'; tab: DebugTab }
  | { type: 'reset-canvas' };

export type CommandBarAction =
  | { type: 'intent'; intent: UiIntent }
  | { type: 'new-tab'; name?: string }
  | { type: 'dm'; target: string; message: string }
  | { type: 'cm'; message: string }
  | { type: 'sudo'; message: string }
  | { type: 'close-all' }
  | { type: 'zoom-selected' }
  | { type: 'fit-all' }
  | { type: 'none' };

const initialUiState: UiState = {
  mode: 'command',
  commandBarOpen: false,
  commandText: '',
  helpOpen: false,
  sidebarOpen: false,
  sidebarSection: 'tmux',
  sidebarSelectedIdx: 0,
  tilePortCount: DEFAULT_TILE_PORT_COUNT,
  debugPaneOpen: false,
  debugPaneHeight: DEFAULT_DEBUG_PANE_HEIGHT,
  debugTab: 'logs',
  selectedPaneId: null,
  selectedWorkId: null,
  paneViewportHints: {},
  arrangementCycleBySession: {},
  arrangementModeBySession: {},
  canvas: {
    panX: 0,
    panY: 0,
    zoom: 1,
  },
  zoomBookmark: null,
  closeTabConfirmation: null,
  closePaneConfirmation: null,
  contextMenu: null,
  pendingSpawnPlacement: null,
  minimizedTileIdsBySession: {},
};

export const initialAppState: AppStateTree = {
  tmux: {
    version: 0,
    serverName: 'herd',
    sessions: {},
    sessionOrder: [],
    windows: {},
    windowOrder: [],
    panes: {},
    paneOrderByWindow: {},
    activeSessionId: null,
    activeWindowId: null,
    activePaneId: null,
  },
  layout: {
    entries: {},
  },
  agents: {},
  channels: {},
  browserExtensionPages: [],
  chatter: [],
  agentLogs: [],
  tileMessageLogs: [],
  network: {
    connections: [],
  },
  work: {
    items: {},
    order: [],
  },
  ui: initialUiState,
};

export const appState = writable<AppStateTree>(initialAppState);

let workDialogOpener: ((placement: PendingSpawnPlacement | null) => void) | null = null;

interface NetworkDragState {
  tileId: string;
  port: TilePort;
  grabbedTileId: string;
  grabbedPort: TilePort;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startedOccupied: boolean;
  detachedConnectionKey: string | null;
  snappedTileId: string | null;
  snappedPort: TilePort | null;
  snappedX: number | null;
  snappedY: number | null;
}

export const activeNetworkDrag = writable<NetworkDragState | null>(null);

interface NetworkReleaseAnimationState {
  connectionKey: string;
  anchorTileId: string;
  anchorPort: TilePort;
  anchorX: number;
  anchorY: number;
  looseX: number;
  looseY: number;
  loosePort: TilePort;
}

export const networkReleaseAnimation = writable<NetworkReleaseAnimationState | null>(null);

export function clearNetworkReleaseAnimation() {
  networkReleaseAnimation.set(null);
}

interface Point {
  x: number;
  y: number;
}

interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function registerWorkDialogOpener(
  opener: (placement: PendingSpawnPlacement | null) => void,
): () => void {
  workDialogOpener = opener;
  return () => {
    if (workDialogOpener === opener) {
      workDialogOpener = null;
    }
  };
}

function snapToGrid(value: number): number {
  return Math.round(value / GRID_SNAP) * GRID_SNAP;
}

function windowTileId(window: TmuxWindow | null | undefined): string | null {
  return window?.tile_id ?? null;
}

function paneTileId(state: AppStateTree, paneId: string): string | null {
  const pane = state.tmux.panes[paneId];
  if (!pane) return null;
  return pane.tile_id ?? windowTileId(state.tmux.windows[pane.window_id]) ?? null;
}

export function paneIdForTileId(state: AppStateTree, tileId: string): string | null {
  for (const pane of Object.values(state.tmux.panes)) {
    if ((pane.tile_id ?? windowTileId(state.tmux.windows[pane.window_id]) ?? null) === tileId) {
      return pane.id;
    }
  }
  return null;
}

function workLayoutKey(state: AppStateTree, workId: string): string | null {
  return state.work.items[workId]?.tile_id ?? null;
}

function workTileIdSet(workItems: WorkItem[]): Set<string> {
  return new Set(workItems.map((item) => item.tile_id));
}

function selectedLayoutTileId(state: AppStateTree, sessionId: string): string | null {
  const selectedWork = state.ui.selectedWorkId ? state.work.items[state.ui.selectedWorkId] ?? null : null;
  if (selectedWork?.session_id === sessionId) {
    return selectedWork.tile_id;
  }
  const selectedPaneId = state.ui.selectedPaneId;
  if (!selectedPaneId) {
    return null;
  }
  const pane = state.tmux.panes[selectedPaneId];
  if (!pane || pane.session_id !== sessionId) {
    return null;
  }
  return paneTileId(state, selectedPaneId);
}

function workItemForTileId(state: AppStateTree, tileId: string): WorkItem | null {
  return Object.values(state.work.items).find((item) => item?.tile_id === tileId) ?? null;
}

function sessionIdForTileId(state: AppStateTree, tileId: string): string | null {
  const workItem = workItemForTileId(state, tileId);
  if (workItem) {
    return workItem.session_id;
  }
  const paneId = paneIdForTileId(state, tileId);
  return paneId ? state.tmux.panes[paneId]?.session_id ?? null : null;
}

function validTileIdsBySession(
  sessions: AppStateTree['tmux']['sessions'],
  windows: AppStateTree['tmux']['windows'],
  workItems: AppStateTree['work']['items'],
): Map<string, Set<string>> {
  const validBySession = new Map<string, Set<string>>();

  for (const sessionId of Object.keys(sessions)) {
    validBySession.set(sessionId, new Set<string>());
  }

  for (const window of Object.values(windows)) {
    if (!window) continue;
    const tileId = windowTileId(window);
    if (!tileId) continue;
    let validTileIds = validBySession.get(window.session_id);
    if (!validTileIds) {
      validTileIds = new Set<string>();
      validBySession.set(window.session_id, validTileIds);
    }
    validTileIds.add(tileId);
  }

  for (const item of Object.values(workItems)) {
    let validTileIds = validBySession.get(item.session_id);
    if (!validTileIds) {
      validTileIds = new Set<string>();
      validBySession.set(item.session_id, validTileIds);
    }
    validTileIds.add(item.tile_id);
  }

  return validBySession;
}

function reconcileMinimizedTileIds(
  minimizedTileIdsBySession: Record<string, string[]>,
  sessions: AppStateTree['tmux']['sessions'],
  windows: AppStateTree['tmux']['windows'],
  workItems: AppStateTree['work']['items'],
): Record<string, string[]> {
  const validBySession = validTileIdsBySession(sessions, windows, workItems);
  const nextMinimizedTileIdsBySession: Record<string, string[]> = {};

  for (const [sessionId, tileIds] of Object.entries(minimizedTileIdsBySession)) {
    const validTileIds = validBySession.get(sessionId);
    if (!validTileIds || validTileIds.size === 0) {
      continue;
    }
    const filteredTileIds = tileIds.filter((tileId, index) =>
      validTileIds.has(tileId) && tileIds.indexOf(tileId) === index);
    if (filteredTileIds.length > 0) {
      nextMinimizedTileIdsBySession[sessionId] = filteredTileIds;
    }
  }

  return nextMinimizedTileIdsBySession;
}

function minimizedTileIdsForSession(state: AppStateTree, sessionId: string | null | undefined): string[] {
  return sessionId ? state.ui.minimizedTileIdsBySession[sessionId] ?? [] : [];
}

function isTileMinimizedInState(state: AppStateTree, tileId: string): boolean {
  const sessionId = sessionIdForTileId(state, tileId);
  return Boolean(sessionId && minimizedTileIdsForSession(state, sessionId).includes(tileId));
}

function setTileMinimizedInState(
  state: AppStateTree,
  tileId: string,
  nextMinimized: boolean,
): AppStateTree {
  const sessionId = sessionIdForTileId(state, tileId);
  if (!sessionId) {
    return state;
  }

  const currentMinimizedTileIds = minimizedTileIdsForSession(state, sessionId);
  const currentlyMinimized = currentMinimizedTileIds.includes(tileId);
  if (currentlyMinimized === nextMinimized) {
    return state;
  }

  const nextSessionTileIds = nextMinimized
    ? [...currentMinimizedTileIds, tileId]
    : currentMinimizedTileIds.filter((currentTileId) => currentTileId !== tileId);
  const nextMinimizedTileIdsBySession = { ...state.ui.minimizedTileIdsBySession };
  if (nextSessionTileIds.length > 0) {
    nextMinimizedTileIdsBySession[sessionId] = nextSessionTileIds;
  } else {
    delete nextMinimizedTileIdsBySession[sessionId];
  }

  return {
    ...state,
    ui: {
      ...state.ui,
      minimizedTileIdsBySession: nextMinimizedTileIdsBySession,
    },
  };
}

function layoutEntryForTileId(state: AppStateTree, tileId: string): LayoutEntry {
  const existing = state.layout.entries[tileId];
  if (existing) {
    return existing;
  }
  const workItem = workItemForTileId(state, tileId);
  if (workItem) {
    return {
      x: 100,
      y: 100,
      width: WORK_CARD_WIDTH,
      height: WORK_CARD_HEIGHT,
    };
  }
  return {
    x: 100,
    y: 100,
    width: DEFAULT_TILE_WIDTH,
    height: DEFAULT_TILE_HEIGHT,
  };
}

function sessionLayoutTileIds(state: AppStateTree, sessionId: string): string[] {
  const windowTileIds = state.tmux.sessions[sessionId]?.window_ids
    .map((windowId) => windowTileId(state.tmux.windows[windowId]))
    .filter((tileId): tileId is string => Boolean(tileId))
    ?? [];
  const workTileIds = Object.values(state.work.items)
    .filter((item) => item.session_id === sessionId)
    .map((item) => item.tile_id);
  return Array.from(new Set([...windowTileIds, ...workTileIds]));
}

function rectsOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function findOpenPosition(
  desiredX: number,
  desiredY: number,
  width: number,
  height: number,
  paneIds: string[],
  entries: Record<string, LayoutEntry>,
): LayoutEntry {
  let x = snapToGrid(desiredX);
  let y = snapToGrid(desiredY);
  const overlaps = (cx: number, cy: number) =>
    paneIds.some((paneId) => {
      const entry = entries[paneId];
      return entry && rectsOverlap(cx, cy, width, height, entry.x, entry.y, entry.width, entry.height);
    });

  if (!overlaps(x, y)) {
    return { x, y, width, height };
  }

  for (let ring = 1; ring <= 20; ring += 1) {
    const stepX = (width + GAP) * ring;
    const stepY = (height + GAP) * ring;
    const candidates = [
      { x: desiredX + stepX, y: desiredY },
      { x: desiredX - stepX, y: desiredY },
      { x: desiredX, y: desiredY + stepY },
      { x: desiredX, y: desiredY - stepY },
      { x: desiredX + stepX, y: desiredY + stepY },
      { x: desiredX - stepX, y: desiredY + stepY },
      { x: desiredX + stepX, y: desiredY - stepY },
      { x: desiredX - stepX, y: desiredY - stepY },
    ];
    for (const candidate of candidates) {
      const cx = snapToGrid(candidate.x);
      const cy = snapToGrid(candidate.y);
      if (!overlaps(cx, cy)) {
        return { x: cx, y: cy, width, height };
      }
    }
  }

  return { x, y, width, height };
}

function elkPortSide(port: TilePort): 'WEST' | 'NORTH' | 'EAST' | 'SOUTH' {
  switch (tilePortSide(port)) {
    case 'left':
      return 'WEST';
    case 'top':
      return 'NORTH';
    case 'right':
      return 'EAST';
    case 'bottom':
      return 'SOUTH';
  }
}

function dominantElkDirection(connections: NetworkConnection[]): 'RIGHT' | 'DOWN' {
  let horizontal = 0;
  let vertical = 0;
  for (const connection of connections) {
    for (const port of [connection.from_port, connection.to_port]) {
      const side = tilePortSide(port);
      if (side === 'left' || side === 'right') {
        horizontal += 1;
      } else {
        vertical += 1;
      }
    }
  }
  return vertical > horizontal ? 'DOWN' : 'RIGHT';
}

async function applyElkArrangement(
  state: AppStateTree,
  sessionId: string,
): Promise<{ state: AppStateTree; arrangedEntries: Record<string, LayoutEntry> }> {
  const tileIds = sessionLayoutTileIds(state, sessionId);
  if (tileIds.length === 0) {
    return { state, arrangedEntries: {} };
  }

  const selectedTileId = selectedLayoutTileId(state, sessionId);
  const nodeEntries = Object.fromEntries(tileIds.map((tileId) => [tileId, layoutEntryForTileId(state, tileId)]));
  const graphConnections = state.network.connections.filter(
    (connection) =>
      connection.session_id === sessionId
      && tileIds.includes(connection.from_tile_id)
      && tileIds.includes(connection.to_tile_id),
  );
  const currentMinX = tileIds.reduce((value, tileId) => Math.min(value, nodeEntries[tileId].x), Infinity);
  const currentMinY = tileIds.reduce((value, tileId) => Math.min(value, nodeEntries[tileId].y), Infinity);
  const occupiedPortsByTileId = new Map<string, TilePort[]>();
  for (const connection of graphConnections) {
    occupiedPortsByTileId.set(connection.from_tile_id, [
      ...(occupiedPortsByTileId.get(connection.from_tile_id) ?? []),
      connection.from_port,
    ]);
    occupiedPortsByTileId.set(connection.to_tile_id, [
      ...(occupiedPortsByTileId.get(connection.to_tile_id) ?? []),
      connection.to_port,
    ]);
  }

  const graph = {
    id: sessionId,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'org.eclipse.elk.direction': dominantElkDirection(graphConnections),
      'org.eclipse.elk.edgeRouting': 'ORTHOGONAL',
      'org.eclipse.elk.separateConnectedComponents': 'true',
      'org.eclipse.elk.spacing.nodeNode': String(GAP * 2),
      'org.eclipse.elk.spacing.componentComponent': String(GAP * 4),
      'org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers': String(GAP * 4),
      'org.eclipse.elk.padding': `[top=${GAP},left=${GAP},bottom=${GAP},right=${GAP}]`,
    },
    children: tileIds.map((tileId) => {
      const entry = nodeEntries[tileId];
      return {
        id: tileId,
        width: entry.width,
        height: entry.height,
        layoutOptions: {
          'org.eclipse.elk.portConstraints': 'FIXED_SIDE',
        },
        ports: visibleTilePorts(state.ui.tilePortCount, occupiedPortsByTileId.get(tileId) ?? []).map((port) => ({
          id: `${tileId}:${port}`,
          width: ELK_PORT_SIZE,
          height: ELK_PORT_SIZE,
          layoutOptions: {
            'org.eclipse.elk.port.side': elkPortSide(port),
          },
        })),
      };
    }),
    edges: graphConnections.map((connection, index) => ({
      id: `elk-edge-${index}`,
      sources: [`${connection.from_tile_id}:${connection.from_port}`],
      targets: [`${connection.to_tile_id}:${connection.to_port}`],
    })),
  };

  const result = await ELK_LAYOUT.layout(graph);
  const resultChildren = Object.fromEntries((result.children ?? []).map((child) => [child.id, child]));
  const anchorEntry = selectedTileId ? nodeEntries[selectedTileId] ?? null : null;
  const anchorNode = selectedTileId ? resultChildren[selectedTileId] ?? null : null;
  const anchorOffsetX = anchorEntry && anchorNode && typeof anchorNode.x === 'number'
    ? anchorEntry.x - anchorNode.x
    : null;
  const anchorOffsetY = anchorEntry && anchorNode && typeof anchorNode.y === 'number'
    ? anchorEntry.y - anchorNode.y
    : null;
  const offsetX = anchorOffsetX !== null
    ? anchorOffsetX
    : (Number.isFinite(currentMinX) ? currentMinX : 100) - Math.min(...tileIds.map((tileId) => resultChildren[tileId]?.x ?? 0));
  const offsetY = anchorOffsetY !== null
    ? anchorOffsetY
    : (Number.isFinite(currentMinY) ? currentMinY : 100) - Math.min(...tileIds.map((tileId) => resultChildren[tileId]?.y ?? 0));

  const desiredEntries = Object.fromEntries(tileIds.map((tileId) => {
    const entry = nodeEntries[tileId];
    const laidOut = resultChildren[tileId];
    return [tileId, {
      x: (laidOut?.x ?? entry.x) + offsetX,
      y: (laidOut?.y ?? entry.y) + offsetY,
      width: entry.width,
      height: entry.height,
    } satisfies LayoutEntry];
  }));

  const orderedTileIds = [...tileIds].sort((left, right) => {
    if (left === selectedTileId) return -1;
    if (right === selectedTileId) return 1;
    const leftEntry = desiredEntries[left];
    const rightEntry = desiredEntries[right];
    return leftEntry.y - rightEntry.y || leftEntry.x - rightEntry.x;
  });

  const arrangedEntries: Record<string, LayoutEntry> = {};
  for (const tileId of orderedTileIds) {
    const entry = desiredEntries[tileId];
    if (tileId === selectedTileId && anchorEntry) {
      arrangedEntries[tileId] = { ...anchorEntry };
      continue;
    }
    arrangedEntries[tileId] = findOpenPosition(
      entry.x,
      entry.y,
      entry.width,
      entry.height,
      Object.keys(arrangedEntries),
      arrangedEntries,
    );
  }

  return {
    state: {
      ...state,
      layout: {
        entries: {
          ...state.layout.entries,
          ...arrangedEntries,
        },
      },
      ui: {
        ...state.ui,
        arrangementModeBySession: {
          ...state.ui.arrangementModeBySession,
          [sessionId]: 'elk',
        },
      },
    },
    arrangedEntries,
  };
}

function buildWindowsRecord(windows: TmuxWindow[]) {
  const record: Record<string, TmuxWindow> = {};
  const order: string[] = [];
  for (const window of [...windows].sort((a, b) => {
    if (a.session_id !== b.session_id) {
      return a.session_id.localeCompare(b.session_id, undefined, { numeric: true });
    }
    return a.index - b.index;
  })) {
    record[window.id] = window;
    order.push(window.id);
  }
  return { record, order };
}

function buildSessionsRecord(sessions: TmuxSession[]) {
  const record: Record<string, TmuxSession> = {};
  const order: string[] = [];
  for (const session of [...sessions].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
    record[session.id] = session;
    order.push(session.id);
  }
  return { record, order };
}

function buildPanesRecord(panes: TmuxPane[], existing: AppStateTree['tmux']['panes']) {
  const panesRecord: AppStateTree['tmux']['panes'] = {};
  const paneOrderByWindow: Record<string, string[]> = {};

  for (const pane of [...panes].sort((a, b) => {
    if (a.window_index !== b.window_index) return a.window_index - b.window_index;
    return a.pane_index - b.pane_index;
  })) {
    panesRecord[pane.id] = {
      ...pane,
      readOnly: existing[pane.id]?.readOnly ?? false,
      role: pane.role ?? existing[pane.id]?.role,
    };
    if (!paneOrderByWindow[pane.window_id]) {
      paneOrderByWindow[pane.window_id] = [];
    }
    paneOrderByWindow[pane.window_id].push(pane.id);
  }

  return { panesRecord, paneOrderByWindow };
}

function defaultPaneTitle(pane: TmuxPane): string {
  if (pane.title.trim()) return pane.title;
  if (pane.command === 'zsh' || pane.command === 'bash' || pane.command === 'sh') return 'shell';
  return pane.command || 'shell';
}

function defaultWindowTitle(window: TmuxWindow, pane?: TmuxPane | null): string {
  if (window.name.trim()) return window.name;
  if (pane) return defaultPaneTitle(pane);
  return `window ${window.index}`;
}

function canvasForTerminal(
  term: TerminalInfo,
  viewportWidth: number,
  viewportHeight: number,
  mode: CanvasZoomMode,
): CanvasState {
  const zoom = mode === 'fullscreen'
    ? Math.max(MIN_CANVAS_ZOOM, Math.min(viewportWidth / term.width, viewportHeight / term.height))
    : Math.max(
      MIN_CANVAS_ZOOM,
      Math.min(viewportWidth * 0.8 / term.width, viewportHeight * 0.8 / term.height, 2),
    );
  return {
    zoom,
    panX: viewportWidth / 2 - (term.x + term.width / 2) * zoom,
    panY: viewportHeight / 2 - (term.y + term.height / 2) * zoom,
  };
}

function toggleSelectedZoom(
  state: AppStateTree,
  mode: CanvasZoomMode,
  viewportWidth: number,
  viewportHeight: number,
): AppStateTree {
  const paneId = state.ui.selectedPaneId;
  if (!paneId) return state;

  const term = terminalInfoForPane(state, paneId);
  if (!term) return state;

  const bookmark = state.ui.zoomBookmark;
  if (bookmark && bookmark.paneId === paneId && bookmark.mode === mode) {
    return {
      ...state,
      ui: {
        ...state.ui,
        canvas: bookmark.previousCanvas,
        zoomBookmark: null,
      },
    };
  }

  const previousCanvas = bookmark?.previousCanvas ?? state.ui.canvas;
  return {
    ...state,
    ui: {
      ...state.ui,
      canvas: canvasForTerminal(term, viewportWidth, viewportHeight, mode),
      zoomBookmark: {
        mode,
        paneId,
        previousCanvas,
      },
    },
  };
}

export function buildSidebarItems(state: AppStateTree): SidebarTreeItem[] {
  const items: SidebarTreeItem[] = [];
  const activeSessionId = state.tmux.activeSessionId;
  if (!activeSessionId) {
    return items;
  }

  const session = state.tmux.sessions[activeSessionId];
  if (!session) {
    return items;
  }
  items.push({
    type: 'session',
    label: session.name,
    indent: 0,
    sessionId: activeSessionId,
  });

  for (const windowId of session.window_ids) {
    const window = state.tmux.windows[windowId];
    if (!window) continue;
    const paneId = window.pane_ids[0];
    const windowPane = paneId ? state.tmux.panes[paneId] : null;
    items.push({
      type: 'window',
      label: `${window.index}: ${defaultWindowTitle(window, windowPane)}`,
      indent: 1,
      sessionId: activeSessionId,
      windowId,
      command: windowPane?.command,
      dead: windowPane?.dead,
    });

    if (!paneId) continue;
    const pane = state.tmux.panes[paneId];
    if (!pane) continue;
    items.push({
      type: 'pane',
      label: defaultPaneTitle(pane),
      indent: 2,
      sessionId: activeSessionId,
      windowId,
      paneId,
      command: pane.command,
      dead: pane.dead,
    });
  }

  return items;
}

function activeSessionWorkItemsInState(state: AppStateTree): WorkItem[] {
  const activeSessionId = state.tmux.activeSessionId;
  return state.work.order
    .map((workId) => state.work.items[workId])
    .filter(
      (item): item is WorkItem =>
        Boolean(item) && (!activeSessionId || item.session_id === activeSessionId),
    );
}

function compareAgentsForCurrentTile(left: AgentInfo, right: AgentInfo): number {
  return Number(right.alive) - Number(left.alive)
    || Number(right.agent_role === 'root') - Number(left.agent_role === 'root')
    || left.display_name.localeCompare(right.display_name)
    || left.agent_id.localeCompare(right.agent_id);
}

function activeSessionAgentsInState(state: AppStateTree): AgentInfo[] {
  const activeSessionId = state.tmux.activeSessionId;
  const currentAgentsByTile = new Map<string, AgentInfo>();
  for (const agent of Object.values(state.agents).filter((agent) => !activeSessionId || agent.session_id === activeSessionId)) {
    const paneId = paneIdForTileId(state, agent.tile_id);
    if (!paneId) continue;
    const kind = paneKindForPane(state, paneId);
    if (kind !== 'claude' && kind !== 'root_agent') continue;
    const existing = currentAgentsByTile.get(agent.tile_id);
    if (!existing || compareAgentsForCurrentTile(agent, existing) < 0) {
      currentAgentsByTile.set(agent.tile_id, agent);
    }
  }
  return [...currentAgentsByTile.values()]
    .sort((left, right) => left.display_name.localeCompare(right.display_name));
}

function selectFirstWorkId(state: AppStateTree): string | null {
  return activeSessionWorkItemsInState(state)[0]?.work_id ?? null;
}

function selectFirstAgentPaneId(state: AppStateTree): string | null {
  const agent = activeSessionAgentsInState(state)[0];
  return agent ? paneIdForTileId(state, agent.tile_id) : null;
}

function isAgentPaneSelected(state: AppStateTree): boolean {
  const selectedPaneId = state.ui.selectedPaneId;
  if (!selectedPaneId) return false;
  return activeSessionAgentsInState(state).some((agent) => paneIdForTileId(state, agent.tile_id) === selectedPaneId);
}

function sidebarSectionForState(state: AppStateTree): SidebarSection {
  if (state.ui.selectedWorkId && activeSessionWorkItemsInState(state).some((item) => item.work_id === state.ui.selectedWorkId)) {
    return 'work';
  }
  if (isAgentPaneSelected(state)) {
    return 'agents';
  }
  return 'tmux';
}

function clampSidebarIndex(state: AppStateTree, index: number): number {
  const items = buildSidebarItems(state);
  if (items.length === 0) return 0;
  return Math.max(0, Math.min(index, items.length - 1));
}

function preferredPaneIdForWindow(state: AppStateTree, windowId: string): string | null {
  const paneIds = state.tmux.paneOrderByWindow[windowId] ?? [];
  if (paneIds.length === 0) return null;
  return paneIds.find((paneId) => state.tmux.panes[paneId]?.active) ?? paneIds[0] ?? null;
}

function preferredPaneIdForSession(state: AppStateTree, sessionId: string): string | null {
  const session = state.tmux.sessions[sessionId];
  if (!session) return null;
  const activeWindowId = session.active_window_id ?? session.window_ids[0];
  if (!activeWindowId) return null;
  return preferredPaneIdForWindow(state, activeWindowId);
}

function sidebarAnchorIndex(state: AppStateTree): number {
  const items = buildSidebarItems(state);
  if (state.ui.selectedPaneId) {
    const paneIndex = items.findIndex((item) => item.paneId === state.ui.selectedPaneId);
    if (paneIndex >= 0) return paneIndex;
  }
  if (state.tmux.activeSessionId) {
    const sessionIndex = items.findIndex((item) => item.sessionId === state.tmux.activeSessionId && !item.windowId && !item.paneId);
    if (sessionIndex >= 0) return sessionIndex;
  }
  if (state.tmux.activeWindowId) {
    const windowIndex = items.findIndex((item) => item.type === 'window' && item.windowId === state.tmux.activeWindowId);
    if (windowIndex >= 0) return windowIndex;
  }
  return 0;
}

function selectedWorkIdForSession(
  state: AppStateTree,
  preferredWorkId: string | null = state.ui.selectedWorkId,
  fallbackToFirst = false,
): string | null {
  const workItems = activeSessionWorkItemsInState(state);
  if (workItems.length === 0) {
    return null;
  }
  if (preferredWorkId && workItems.some((item) => item.work_id === preferredWorkId)) {
    return preferredWorkId;
  }
  return fallbackToFirst ? workItems[0].work_id : null;
}

function selectedAgentPaneIdForSession(
  state: AppStateTree,
  preferredPaneId: string | null = state.ui.selectedPaneId,
): string | null {
  const agents = activeSessionAgentsInState(state);
  if (agents.length === 0) {
    return null;
  }
  if (preferredPaneId && agents.some((agent) => paneIdForTileId(state, agent.tile_id) === preferredPaneId)) {
    return preferredPaneId;
  }
  return paneIdForTileId(state, agents[0].tile_id);
}

function countPanesInSession(tmux: AppStateTree['tmux'], sessionId: string): number {
  const session = tmux.sessions[sessionId];
  if (!session) return 0;
  return session.window_ids.reduce((count, windowId) => {
    const paneCount = tmux.paneOrderByWindow[windowId]?.length ?? tmux.windows[windowId]?.pane_ids.length ?? 0;
    return count + paneCount;
  }, 0);
}

function buildCloseTabConfirmation(
  tmux: AppStateTree['tmux'],
  sessionId: string,
  force = false,
): CloseTabConfirmation | null {
  const session = tmux.sessions[sessionId];
  if (!session) return null;
  const paneCount = countPanesInSession(tmux, sessionId);
  if (!force && paneCount <= 1) return null;
  return {
    sessionId,
    sessionName: session.name || 'Session',
    paneCount,
  };
}

function buildClosePaneConfirmation(state: AppStateTree, paneId: string): ClosePaneConfirmation | null {
  const pane = state.tmux.panes[paneId];
  if (!pane || pane.role !== 'root_agent') {
    return null;
  }
  return {
    paneId,
    title: 'CLOSE ROOT AGENT',
    message: 'Close this Root agent? Herd will restart it automatically.',
    confirmLabel: 'Close Root Agent',
  };
}

function selectedSidebarItem(state: AppStateTree): SidebarTreeItem | null {
  if (state.ui.sidebarSection !== 'tmux') {
    return null;
  }
  const items = buildSidebarItems(state);
  return items[clampSidebarIndex(state, state.ui.sidebarSelectedIdx)] ?? null;
}

function focusSidebarSectionState(state: AppStateTree, section: SidebarSection): AppStateTree {
  if (section === 'work') {
    return {
      ...state,
      ui: {
        ...state.ui,
        sidebarSection: 'work',
        selectedPaneId: null,
        selectedWorkId: selectedWorkIdForSession(state, state.ui.selectedWorkId, true),
      },
    };
  }

  if (section === 'agents') {
    return {
      ...state,
      ui: {
        ...state.ui,
        sidebarSection: 'agents',
        selectedPaneId: selectedAgentPaneIdForSession(state),
        selectedWorkId: null,
      },
    };
  }

  if (section === 'tmux') {
    return {
      ...state,
      ui: {
        ...state.ui,
        sidebarSection: 'tmux',
        sidebarSelectedIdx: clampSidebarIndex(state, state.ui.sidebarSelectedIdx ?? sidebarAnchorIndex(state)),
        selectedWorkId: null,
      },
    };
  }

  return {
    ...state,
    ui: {
      ...state.ui,
      sidebarSection: 'settings',
    },
  };
}

export function buildSidebarRenameCommand(state: AppStateTree): string | null {
  const item = selectedSidebarItem(state);
  if (!item) return null;

  if (item.type === 'session' && item.sessionId) {
    const session = state.tmux.sessions[item.sessionId];
    return session ? `tr ${session.name}` : null;
  }

  if (item.type === 'window' && item.windowId) {
    const window = state.tmux.windows[item.windowId];
    const pane = window?.pane_ids[0] ? state.tmux.panes[window.pane_ids[0]] : null;
    return window ? `rename ${defaultWindowTitle(window, pane)}` : null;
  }

  if (item.type === 'pane' && item.paneId) {
    const pane = state.tmux.panes[item.paneId];
    const window = pane ? state.tmux.windows[pane.window_id] : null;
    return pane && window ? `rename ${defaultWindowTitle(window, pane)}` : null;
  }

  return null;
}

function paneKindForPane(state: AppStateTree, paneId: string): PaneKind {
  const pane = state.tmux.panes[paneId];
  const window = pane ? state.tmux.windows[pane.window_id] : null;
  if (!pane || !window) {
    return 'regular';
  }

  if (pane.role) {
    return pane.role;
  }

  const tileId = paneTileId(state, paneId);
  const liveAgent = tileId
    ? Object.values(state.agents)
      .filter((agent) => agent.tile_id === tileId && agent.alive)
      .sort(compareAgentsForCurrentTile)[0]
    : null;
  if (liveAgent) {
    return liveAgent.agent_role === 'root' ? 'root_agent' : 'claude';
  }

  const titleSignals = [pane.title, window.name].join(' ');
  if (/\bbrowser\b/i.test(titleSignals)) {
    return 'browser';
  }
  if (titleSignals.includes('Root')) {
    return 'root_agent';
  }
  if (titleSignals.includes('Agent') || titleSignals.includes('Claude Code') || /\bclaude\b/i.test(pane.command)) {
    return 'claude';
  }

  return 'regular';
}

function isAgentPaneKind(kind: PaneKind): boolean {
  return kind === 'claude' || kind === 'root_agent';
}

function canvasWorldCoordinates(state: AppStateTree, clientX: number, clientY: number) {
  return {
    worldX: Math.round((clientX - state.ui.canvas.panX) / state.ui.canvas.zoom),
    worldY: Math.round((clientY - state.ui.canvas.panY) / state.ui.canvas.zoom),
  };
}

export function openCanvasContextMenuInState(
  state: AppStateTree,
  clientX: number,
  clientY: number,
): AppStateTree {
  const { worldX, worldY } = canvasWorldCoordinates(state, clientX, clientY);
  const contextMenu: ContextMenuState = {
    open: true,
    target: 'canvas',
    paneId: null,
    clientX,
    clientY,
    worldX,
    worldY,
    claudeCommands: [],
    claudeSkills: [],
    loadingClaudeCommands: false,
    claudeCommandsError: null,
  };
  return {
    ...state,
    ui: {
      ...state.ui,
      contextMenu,
    },
  };
}

export function openPaneContextMenuInState(
  state: AppStateTree,
  paneId: string,
  clientX: number,
  clientY: number,
): AppStateTree {
  const paneKind = paneKindForPane(state, paneId);
  const contextMenu: ContextMenuState = {
    open: true,
    target: 'pane',
    paneId,
    clientX,
    clientY,
    worldX: null,
    worldY: null,
    claudeCommands: [],
    claudeSkills: [],
    loadingClaudeCommands: isAgentPaneKind(paneKind),
    claudeCommandsError: null,
  };
  return {
    ...state,
    ui: {
      ...state.ui,
      selectedPaneId: paneId,
      contextMenu,
    },
  };
}

export function dismissContextMenuInState(state: AppStateTree): AppStateTree {
  if (!state.ui.contextMenu) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      contextMenu: null,
    },
  };
}

export function buildContextMenuItems(state: AppStateTree): ContextMenuItem[] {
  const contextMenu = state.ui.contextMenu;
  if (!contextMenu?.open) {
    return [];
  }

  if (contextMenu.target === 'canvas') {
    return [
      { id: 'new-shell', label: 'New Shell', kind: 'action', disabled: false },
      { id: 'new-agent', label: 'New Agent', kind: 'action', disabled: false },
      { id: 'new-browser', label: 'New Browser', kind: 'action', disabled: false },
      { id: 'new-work', label: 'New Work', kind: 'action', disabled: false },
    ];
  }

  if (!contextMenu.paneId) {
    return [];
  }

  const paneKind = paneKindForPane(state, contextMenu.paneId);
  const items: ContextMenuItem[] = [];
  const browserExtensionPages = state.browserExtensionPages ?? [];

  if (paneKind === 'browser') {
    const browserPageItems = browserExtensionPages.length > 0
      ? browserExtensionPages.map((page) => ({
        id: `browser-load:${page.path}`,
        label: page.label,
        kind: 'action' as const,
        disabled: false,
      }))
      : [{ id: 'browser-load-empty', label: 'No browser pages', kind: 'status', disabled: true } satisfies ContextMenuItem];

    items.push({
      id: 'browser-load',
      label: 'Load',
      kind: 'submenu',
      disabled: false,
      children: browserPageItems,
    });
    items.push({ id: 'separator-browser-load', label: '', kind: 'separator', disabled: true });
  }

  if (isAgentPaneKind(paneKind)) {
    const skillNames = new Set(contextMenu.claudeSkills.map((command) => command.name));
    const skillItems = contextMenu.loadingClaudeCommands
      ? [{ id: 'skills-loading', label: 'Loading…', kind: 'status', disabled: true } satisfies ContextMenuItem]
      : contextMenu.claudeCommandsError
        ? [{ id: 'skills-error', label: contextMenu.claudeCommandsError, kind: 'status', disabled: true } satisfies ContextMenuItem]
        : contextMenu.claudeSkills.length > 0
          ? contextMenu.claudeSkills.map((command) => ({
            id: `claude-command:${command.name}`,
            label: `/${command.name}`,
            kind: 'action' as const,
            disabled: false,
          }))
          : [{ id: 'skills-empty', label: 'No skills', kind: 'status', disabled: true } satisfies ContextMenuItem];

    items.push({
      id: 'claude-skills',
      label: 'Skills',
      kind: 'submenu',
      disabled: false,
      children: skillItems,
    });
    items.push({ id: 'separator-skills', label: '', kind: 'separator', disabled: true });
  }

  items.push({
    id: 'close-shell',
    label: paneKind === 'browser' ? 'Close Browser' : 'Close Shell',
    kind: 'action',
    disabled: false,
  });

  if (isAgentPaneKind(paneKind)) {
    const skillNames = new Set(contextMenu.claudeSkills.map((command) => command.name));
    const regularCommands = contextMenu.claudeCommands.filter((command) => !skillNames.has(command.name));

    items.push({ id: 'separator-claude', label: '', kind: 'separator', disabled: true });
    items.push({ id: 'claude-label', label: 'Claude Commands', kind: 'label', disabled: true });
    if (contextMenu.loadingClaudeCommands) {
      items.push({ id: 'claude-loading', label: 'Loading…', kind: 'status', disabled: true });
    } else if (contextMenu.claudeCommandsError) {
      items.push({ id: 'claude-error', label: contextMenu.claudeCommandsError, kind: 'status', disabled: true });
    } else if (regularCommands.length === 0) {
      items.push({ id: 'claude-empty', label: 'No commands', kind: 'status', disabled: true });
    } else {
      for (const command of regularCommands) {
        items.push({
          id: `claude-command:${command.name}`,
          label: `/${command.name}`,
          kind: 'action',
          disabled: false,
        });
      }
    }
  }

  return items;
}

export function reduceContextMenuSelection(
  state: AppStateTree,
  itemId: string,
): { state: AppStateTree; effects: TmuxEffect[] } {
  const contextMenu = state.ui.contextMenu;
  if (!contextMenu?.open) {
    return { state, effects: [] };
  }

  if (
    (itemId === 'new-shell' || itemId === 'new-agent' || itemId === 'new-browser' || itemId === 'new-work')
    && contextMenu.target === 'canvas'
  ) {
    const sessionId = state.tmux.activeSessionId;
    if (!sessionId || contextMenu.worldX === null || contextMenu.worldY === null) {
      return { state: dismissContextMenuInState(state), effects: [] };
    }
    const dismissedState = dismissContextMenuInState(state);
    const placement = {
      sessionId,
      worldX: contextMenu.worldX,
      worldY: contextMenu.worldY,
    };
    if (itemId === 'new-work') {
      return {
        state: dismissedState,
        effects: [{ type: 'open-work-dialog', placement }],
      };
    }
    return {
      state: {
        ...dismissedState,
        ui: {
          ...dismissedState.ui,
          pendingSpawnPlacement: placement,
        },
      },
      effects: [{
        type:
          itemId === 'new-agent'
            ? 'new-agent-window'
            : itemId === 'new-browser'
              ? 'new-browser-window'
              : 'new-window',
        sessionId,
      }],
    };
  }

  if (itemId === 'close-shell' && contextMenu.target === 'pane' && contextMenu.paneId) {
    const selectedState = {
      ...state,
      ui: {
        ...state.ui,
        selectedPaneId: contextMenu.paneId,
      },
    };
    return reduceIntent(dismissContextMenuInState(selectedState), { type: 'close-selected-pane' });
  }

  if (itemId.startsWith('browser-load:') && contextMenu.target === 'pane' && contextMenu.paneId) {
    const path = itemId.slice('browser-load:'.length);
    const selectedState = {
      ...state,
      ui: {
        ...state.ui,
        selectedPaneId: contextMenu.paneId,
      },
    };
    return {
      state: dismissContextMenuInState(selectedState),
      effects: [{ type: 'load-browser-file', paneId: contextMenu.paneId, path }],
    };
  }

  if (itemId.startsWith('claude-command:') && contextMenu.target === 'pane' && contextMenu.paneId) {
    const commandName = itemId.slice('claude-command:'.length);
    const command = contextMenu.claudeCommands.find((entry) => entry.name === commandName);
    if (!command) {
      return { state: dismissContextMenuInState(state), effects: [] };
    }

    const commandText = command.execution === 'execute'
      ? `/${command.name}\r`
      : `/${command.name} `;
    const dismissedState = dismissContextMenuInState(state);
    return {
      state: {
        ...dismissedState,
        ui: {
          ...dismissedState.ui,
          selectedPaneId: contextMenu.paneId,
        },
      },
      effects: [{ type: 'write-pane', paneId: contextMenu.paneId, data: commandText }],
    };
  }

  return { state: dismissContextMenuInState(state), effects: [] };
}

function reconcileLayoutEntries(
  previousEntries: Record<string, LayoutEntry>,
  sessions: Record<string, TmuxSession>,
  windows: Record<string, TmuxWindow>,
  workItems: Record<string, WorkItem>,
): Record<string, LayoutEntry> {
  const nextEntries: Record<string, LayoutEntry> = {};
  const windowEntryIds = new Set(
    Object.values(windows)
      .map((window) => windowTileId(window))
      .filter((entryId): entryId is string => Boolean(entryId)),
  );
  const workEntryIds = new Set(
    Object.values(workItems)
      .map((item) => item?.tile_id)
      .filter((entryId): entryId is string => Boolean(entryId)),
  );

  for (const [entryId, entry] of Object.entries(previousEntries)) {
    if (workEntryIds.has(entryId)) {
      nextEntries[entryId] = entry;
    }
  }

  for (const session of Object.values(sessions)) {
    for (const windowId of session.window_ids) {
      const window = windows[windowId];
      const entryId = windowTileId(window);
      if (!window || !entryId) {
        continue;
      }
      const existing = previousEntries[entryId];
      if (existing) {
        nextEntries[entryId] = existing;
        continue;
      }

      const parentWindowId = window.parent_window_id ?? null;
      const parentEntryId = parentWindowId ? windowTileId(windows[parentWindowId]) : null;
      const parentEntry = parentEntryId ? nextEntries[parentEntryId] ?? previousEntries[parentEntryId] : null;
      if (parentEntry) {
        nextEntries[entryId] = findOpenPosition(
          parentEntry.x + parentEntry.width + GAP + GRID_SNAP,
          parentEntry.y,
          DEFAULT_TILE_WIDTH,
          DEFAULT_TILE_HEIGHT,
          session.window_ids
            .filter((id) => id !== windowId)
            .map((id) => windowTileId(windows[id]))
            .filter((id): id is string => Boolean(id)),
          nextEntries,
        );
        continue;
      }

      const offset = session.window_ids.indexOf(windowId) * 40;
      nextEntries[entryId] = findOpenPosition(
        100 + offset,
        100 + offset,
        DEFAULT_TILE_WIDTH,
        DEFAULT_TILE_HEIGHT,
        session.window_ids
          .filter((id) => id !== windowId)
          .map((id) => windowTileId(windows[id]))
          .filter((id): id is string => Boolean(id)),
        nextEntries,
      );
    }
  }

  return nextEntries;
}

function reconcilePaneViewportHints(
  previousHints: Record<string, PaneViewportHint>,
  panes: Record<string, AppStateTree['tmux']['panes'][string]>,
): Record<string, PaneViewportHint> {
  const nextHints: Record<string, PaneViewportHint> = {};
  for (const paneId of Object.keys(panes)) {
    const hint = previousHints[paneId];
    if (hint) {
      nextHints[paneId] = hint;
    }
  }
  return nextHints;
}

function reconcileArrangementCycles(
  previousCycles: Record<string, number>,
  sessions: Record<string, TmuxSession>,
): Record<string, number> {
  const nextCycles: Record<string, number> = {};
  for (const sessionId of Object.keys(sessions)) {
    if (typeof previousCycles[sessionId] === 'number') {
      nextCycles[sessionId] = previousCycles[sessionId];
    }
  }
  return nextCycles;
}

function reconcileArrangementModes(
  previousModes: Record<string, ArrangementMode | null>,
  sessions: Record<string, TmuxSession>,
): Record<string, ArrangementMode | null> {
  const nextModes: Record<string, ArrangementMode | null> = {};
  for (const sessionId of Object.keys(sessions)) {
    const pattern = previousModes[sessionId];
    if (pattern) {
      nextModes[sessionId] = pattern;
    }
  }
  return nextModes;
}

function applyPendingSpawnPlacement(
  previousState: AppStateTree,
  nextTmux: AppStateTree['tmux'],
  entries: Record<string, LayoutEntry>,
): {
  entries: Record<string, LayoutEntry>;
  pendingSpawnPlacement: PendingSpawnPlacement | null;
  consumedSessionId: string | null;
} {
  const pending = previousState.ui.pendingSpawnPlacement;
  if (!pending) {
    return { entries, pendingSpawnPlacement: null, consumedSessionId: null };
  }

  const session = nextTmux.sessions[pending.sessionId];
  if (!session) {
    return { entries, pendingSpawnPlacement: null, consumedSessionId: null };
  }

  const previousWindowIds = previousState.tmux.sessions[pending.sessionId]?.window_ids ?? [];
  const newWindowIds = session.window_ids.filter((windowId) => !previousWindowIds.includes(windowId));
  if (newWindowIds.length === 0) {
    return { entries, pendingSpawnPlacement: pending, consumedSessionId: null };
  }

  const targetWindowId = newWindowIds[newWindowIds.length - 1];
  const targetEntryId = windowTileId(nextTmux.windows[targetWindowId]);
  if (!targetEntryId) {
    return { entries, pendingSpawnPlacement: pending, consumedSessionId: null };
  }
  const nextEntries = { ...entries };
  const existing = nextEntries[targetEntryId];
  const width = existing?.width ?? DEFAULT_TILE_WIDTH;
  const height = existing?.height ?? DEFAULT_TILE_HEIGHT;
  nextEntries[targetEntryId] = {
    x: snapToGrid(pending.worldX),
    y: snapToGrid(pending.worldY),
    width,
    height,
  };

  return {
    entries: nextEntries,
    pendingSpawnPlacement: null,
    consumedSessionId: pending.sessionId,
  };
}

function snapLayoutEntriesToTmux(
  entries: Record<string, LayoutEntry>,
  windows: Record<string, AppStateTree['tmux']['windows'][string]>,
  paneViewportHints: Record<string, PaneViewportHint>,
): Record<string, LayoutEntry> {
  const nextEntries = { ...entries };

  for (const [windowId, window] of Object.entries(windows)) {
    const pendingResizeKey = pendingWindowResizeRequests.get(windowId);
    if (pendingResizeKey !== `${window.cols}x${window.rows}`) continue;

    const paneId = window.pane_ids[0];
    const entryId = windowTileId(window);
    const entry = entryId ? nextEntries[entryId] : null;
    const hint = paneId ? paneViewportHints[paneId] : null;
    if (!paneId || !entryId || !entry || !hint) continue;
    if (hint.cols <= 0 || hint.rows <= 0 || hint.pixelWidth <= 0 || hint.pixelHeight <= 0) continue;
    if (window.cols <= 0 || window.rows <= 0) continue;

    const cellWidth = hint.pixelWidth / hint.cols;
    const cellHeight = hint.pixelHeight / hint.rows;
    const frameWidth = Math.max(0, entry.width - hint.pixelWidth);
    const frameHeight = Math.max(0, entry.height - hint.pixelHeight);
    const snappedWidth = Math.round(frameWidth + window.cols * cellWidth);
    const snappedHeight = Math.round(frameHeight + window.rows * cellHeight);

    if (Math.abs(snappedWidth - entry.width) < 1 && Math.abs(snappedHeight - entry.height) < 1) {
      continue;
    }

    nextEntries[entryId] = {
      ...entry,
      width: snappedWidth,
      height: snappedHeight,
    };
    pendingWindowResizeRequests.delete(windowId);
  }

  return nextEntries;
}

function layoutEntryChanged(previous: LayoutEntry | undefined, next: LayoutEntry | undefined): boolean {
  if (!previous || !next) return previous !== next;
  return previous.x !== next.x
    || previous.y !== next.y
    || previous.width !== next.width
    || previous.height !== next.height;
}

function collectChangedLayoutEntries(
  previousEntries: Record<string, LayoutEntry>,
  nextEntries: Record<string, LayoutEntry>,
): Array<[string, LayoutEntry]> {
  const changed: Array<[string, LayoutEntry]> = [];
  for (const [paneId, entry] of Object.entries(nextEntries)) {
    if (layoutEntryChanged(previousEntries[paneId], entry)) {
      changed.push([paneId, entry]);
    }
  }
  return changed;
}

function chooseSelectedPaneId(
  previousState: AppStateTree,
  nextTmux: AppStateTree['tmux'],
): string | null {
  const activeSessionId = nextTmux.activeSessionId;
  if (!activeSessionId) return null;

  const currentSelection = previousState.ui.selectedPaneId;
  if (currentSelection && nextTmux.panes[currentSelection]?.session_id === activeSessionId) {
    return currentSelection;
  }

  if (nextTmux.activePaneId && nextTmux.panes[nextTmux.activePaneId]?.session_id === activeSessionId) {
    return nextTmux.activePaneId;
  }

  return preferredPaneIdForSession({ ...previousState, tmux: nextTmux }, activeSessionId);
}

function nextArrangementPatternForSession(state: AppStateTree, sessionId: string): ArrangementMode {
  const patternIndex = state.ui.arrangementCycleBySession[sessionId] ?? 0;
  return AUTO_ARRANGE_PATTERNS[patternIndex % AUTO_ARRANGE_PATTERNS.length];
}

function arrangementIndex(pattern: ArrangementMode): number {
  const index = AUTO_ARRANGE_PATTERNS.indexOf(pattern);
  return index >= 0 ? index : 0;
}

export function applyTmuxSnapshotToState(
  previousState: AppStateTree,
  snapshot: TmuxSnapshot,
): AppStateTree {
  const { record: sessions, order: sessionOrder } = buildSessionsRecord(snapshot.sessions);
  const { record: windows, order: windowOrder } = buildWindowsRecord(snapshot.windows);
  const { panesRecord, paneOrderByWindow } = buildPanesRecord(snapshot.panes, previousState.tmux.panes);
  const layoutEntries = reconcileLayoutEntries(previousState.layout.entries, sessions, windows, previousState.work.items);

  const activeSessionId = snapshot.active_session_id ?? sessionOrder[0] ?? null;
  const activeWindowId = snapshot.active_window_id
    ?? (activeSessionId ? sessions[activeSessionId]?.active_window_id ?? null : null)
    ?? windowOrder[0]
    ?? null;
  const nextTmux: AppStateTree['tmux'] = {
    version: snapshot.version,
    serverName: snapshot.server_name,
    sessions,
    sessionOrder,
    windows,
    windowOrder,
    panes: panesRecord,
    paneOrderByWindow,
    activeSessionId,
    activeWindowId,
    activePaneId: snapshot.active_pane_id ?? null,
  };

  const selectedPaneId = chooseSelectedPaneId(previousState, nextTmux);
  const paneViewportHints = reconcilePaneViewportHints(previousState.ui.paneViewportHints, panesRecord);
  const arrangementCycleBySession = reconcileArrangementCycles(
    previousState.ui.arrangementCycleBySession,
    sessions,
  );
  const arrangementModeBySession = reconcileArrangementModes(
    previousState.ui.arrangementModeBySession,
    sessions,
  );
  const minimizedTileIdsBySession = reconcileMinimizedTileIds(
    previousState.ui.minimizedTileIdsBySession,
    sessions,
    windows,
    previousState.work.items,
  );
  const pendingPlacement = applyPendingSpawnPlacement(previousState, nextTmux, layoutEntries);
  const snappedLayoutEntries = snapLayoutEntriesToTmux(pendingPlacement.entries, windows, paneViewportHints);
  const closeTabConfirmation = previousState.ui.closeTabConfirmation
    ? buildCloseTabConfirmation(nextTmux, previousState.ui.closeTabConfirmation.sessionId)
    : null;
  const closePaneConfirmation = previousState.ui.closePaneConfirmation
    ? buildClosePaneConfirmation({ ...previousState, tmux: nextTmux }, previousState.ui.closePaneConfirmation.paneId)
    : null;

  let nextState: AppStateTree = {
    tmux: nextTmux,
    layout: {
      entries: snappedLayoutEntries,
    },
    agents: previousState.agents,
    channels: previousState.channels,
    browserExtensionPages: previousState.browserExtensionPages,
    chatter: previousState.chatter,
    agentLogs: previousState.agentLogs,
    tileMessageLogs: previousState.tileMessageLogs,
    network: previousState.network,
    work: previousState.work,
    ui: {
      ...previousState.ui,
      selectedPaneId,
      selectedWorkId: selectedWorkIdForSession({ ...previousState, tmux: nextTmux }),
      paneViewportHints,
      arrangementCycleBySession,
      arrangementModeBySession,
      minimizedTileIdsBySession,
      closeTabConfirmation,
      closePaneConfirmation,
      pendingSpawnPlacement: pendingPlacement.pendingSpawnPlacement,
      sidebarSelectedIdx: previousState.ui.sidebarSelectedIdx,
    },
  };
  for (const sessionId of nextTmux.sessionOrder) {
    const pattern = nextState.ui.arrangementModeBySession[sessionId];
    const previousWindowCount = previousState.tmux.sessions[sessionId]?.window_ids.length ?? 0;
    const nextWindowCount = nextTmux.sessions[sessionId]?.window_ids.length ?? 0;
    if (pendingPlacement.consumedSessionId === sessionId) continue;
    if (!pattern || nextWindowCount <= previousWindowCount) continue;
    if (pattern === 'elk') continue;
    nextState = applyArrangementPattern(nextState, sessionId, pattern).state;
  }
  nextState.ui.sidebarSelectedIdx = clampSidebarIndex(nextState, nextState.ui.sidebarSelectedIdx);
  nextState.ui.sidebarSection = sidebarSectionForState(nextState);
  return nextState;
}

export function applyPaneReadOnlyToState(
  state: AppStateTree,
  paneId: string,
  readOnly: boolean,
): AppStateTree {
  const pane = state.tmux.panes[paneId];
  if (!pane) return state;
  return {
    ...state,
    tmux: {
      ...state.tmux,
      panes: {
        ...state.tmux.panes,
        [paneId]: {
          ...pane,
          readOnly,
        },
      },
    },
  };
}

export function applyPaneRoleToState(
  state: AppStateTree,
  paneId: string,
  role: PaneKind,
): AppStateTree {
  const pane = state.tmux.panes[paneId];
  if (!pane) return state;
  return {
    ...state,
    tmux: {
      ...state.tmux,
      panes: {
        ...state.tmux.panes,
        [paneId]: {
          ...pane,
          role,
        },
      },
    },
  };
}

export function reduceIntent(
  state: AppStateTree,
  intent: UiIntent,
): { state: AppStateTree; effects: TmuxEffect[] } {
  switch (intent.type) {
    case 'new-shell':
      return state.tmux.activeSessionId
        ? { state, effects: [{ type: 'new-window', sessionId: state.tmux.activeSessionId }] }
        : { state, effects: [] };

    case 'new-agent':
      return state.tmux.activeSessionId
        ? { state, effects: [{ type: 'new-agent-window', sessionId: state.tmux.activeSessionId }] }
        : { state, effects: [] };

    case 'new-browser':
      return state.tmux.activeSessionId
        ? { state, effects: [{ type: 'new-browser-window', sessionId: state.tmux.activeSessionId }] }
        : { state, effects: [] };

    case 'new-tab':
      return { state, effects: [{ type: 'new-session' }] };

    case 'close-selected-pane': {
      const paneId = state.ui.selectedPaneId;
      if (paneId && state.tmux.panes[paneId]?.role === 'root_agent') {
        return {
          state: {
            ...state,
            ui: {
              ...state.ui,
              closePaneConfirmation: buildClosePaneConfirmation(state, paneId),
            },
          },
          effects: [],
        };
      }
      const windowId = paneId ? state.tmux.panes[paneId]?.window_id : null;
      const sessionId = paneId ? state.tmux.panes[paneId]?.session_id : null;
      const session = sessionId ? state.tmux.sessions[sessionId] : null;
      if (!windowId || !sessionId || !session) {
        return { state, effects: [] };
      }
      if (session.window_ids.length <= 1) {
        return {
          state: {
            ...state,
            ui: {
              ...state.ui,
              closeTabConfirmation: buildCloseTabConfirmation(state.tmux, sessionId, true),
              closePaneConfirmation: null,
            },
          },
          effects: [],
        };
      }
      return { state, effects: [{ type: 'kill-window', windowId }] };
    }

    case 'confirm-close-pane':
      return state.ui.closePaneConfirmation
        ? {
          state: {
            ...state,
            ui: {
              ...state.ui,
              closePaneConfirmation: null,
            },
          },
          effects: state.tmux.panes[state.ui.closePaneConfirmation.paneId]
            ? [{ type: 'kill-window', windowId: state.tmux.panes[state.ui.closePaneConfirmation.paneId].window_id }]
            : [],
        }
        : { state, effects: [] };

    case 'cancel-close-pane':
      return {
        state: {
          ...state,
          ui: {
            ...state.ui,
            closePaneConfirmation: null,
          },
        },
        effects: [],
      };

    case 'close-active-tab':
      if (!state.tmux.activeSessionId) {
        return { state, effects: [] };
      }
      {
        const closeTabConfirmation = buildCloseTabConfirmation(state.tmux, state.tmux.activeSessionId);
        return {
          state: {
            ...state,
            ui: {
              ...state.ui,
              closeTabConfirmation,
              closePaneConfirmation: null,
            },
          },
          effects: closeTabConfirmation
            ? []
            : [{ type: 'kill-session', sessionId: state.tmux.activeSessionId }],
        };
      }

    case 'confirm-close-active-tab':
      return state.ui.closeTabConfirmation
        ? {
          state: {
            ...state,
            ui: {
              ...state.ui,
              closeTabConfirmation: null,
              closePaneConfirmation: null,
            },
          },
          effects: [{ type: 'kill-session', sessionId: state.ui.closeTabConfirmation.sessionId }],
        }
        : { state, effects: [] };

    case 'cancel-close-active-tab':
      return {
        state: {
          ...state,
          ui: {
            ...state.ui,
            closeTabConfirmation: null,
            closePaneConfirmation: null,
          },
        },
        effects: [],
      };

    case 'select-session':
      return { state, effects: [{ type: 'select-session', sessionId: intent.sessionId }] };

    case 'select-next-tab': {
      if (state.tmux.sessionOrder.length === 0) return { state, effects: [] };
      const currentId = state.tmux.activeSessionId ?? state.tmux.sessionOrder[0];
      const index = state.tmux.sessionOrder.findIndex((id) => id === currentId);
      const nextIndex = (index + 1) % state.tmux.sessionOrder.length;
      return {
        state,
        effects: [{ type: 'select-session', sessionId: state.tmux.sessionOrder[nextIndex] }],
      };
    }

    case 'select-prev-tab': {
      if (state.tmux.sessionOrder.length === 0) return { state, effects: [] };
      const currentId = state.tmux.activeSessionId ?? state.tmux.sessionOrder[0];
      const index = state.tmux.sessionOrder.findIndex((id) => id === currentId);
      const prevIndex = (index - 1 + state.tmux.sessionOrder.length) % state.tmux.sessionOrder.length;
      return {
        state,
        effects: [{ type: 'select-session', sessionId: state.tmux.sessionOrder[prevIndex] }],
      };
    }

    case 'rename-active-tab':
      return state.tmux.activeSessionId
        ? { state, effects: [{ type: 'rename-session', sessionId: state.tmux.activeSessionId, name: intent.name }] }
        : { state, effects: [] };

    case 'rename-selected-pane': {
      const paneId = state.ui.selectedPaneId;
      const windowId = paneId ? state.tmux.panes[paneId]?.window_id : null;
      return windowId
        ? { state, effects: [{ type: 'rename-window', windowId, name: intent.name }] }
        : { state, effects: [] };
    }

    case 'toggle-sidebar':
      return {
        state: {
          ...state,
          ui: {
            ...state.ui,
            sidebarOpen: !state.ui.sidebarOpen,
            sidebarSection: state.ui.sidebarOpen ? state.ui.sidebarSection : sidebarSectionForState(state),
            sidebarSelectedIdx: state.ui.sidebarOpen ? state.ui.sidebarSelectedIdx : sidebarAnchorIndex(state),
          },
        },
        effects: [],
      };

    case 'set-sidebar-section':
      return {
        state: focusSidebarSectionState(state, intent.section),
        effects: [],
      };

    case 'move-sidebar-section': {
      const currentIndex = SIDEBAR_SECTIONS.indexOf(state.ui.sidebarSection);
      const nextIndex = Math.max(0, Math.min(SIDEBAR_SECTIONS.length - 1, currentIndex + intent.delta));
      return {
        state: focusSidebarSectionState(state, SIDEBAR_SECTIONS[nextIndex] ?? 'tmux'),
        effects: [],
      };
    }

    case 'set-sidebar-selection': {
      if (state.ui.sidebarSection !== 'tmux') {
        return reduceIntent(
          {
            ...state,
            ui: {
              ...state.ui,
              sidebarSection: 'tmux',
            },
          },
          intent,
        );
      }
      const sidebarSelectedIdx = clampSidebarIndex(state, intent.index);
      const item = buildSidebarItems(state)[sidebarSelectedIdx];
      if (!item) {
        return {
          state: {
            ...state,
            ui: { ...state.ui, sidebarSection: 'tmux', sidebarSelectedIdx, selectedWorkId: null },
          },
          effects: [],
        };
      }

      if (item.type === 'pane' && item.paneId && item.windowId) {
        const effects: TmuxEffect[] = [];
        if (item.sessionId && state.tmux.activeSessionId !== item.sessionId) {
          effects.push({ type: 'select-session', sessionId: item.sessionId });
        }
        if (state.tmux.activeWindowId !== item.windowId) {
          effects.push({ type: 'select-window', windowId: item.windowId });
        }
        return {
          state: {
            ...state,
            ui: {
              ...state.ui,
              sidebarSection: 'tmux',
              sidebarSelectedIdx,
              selectedPaneId: item.paneId,
              selectedWorkId: null,
            },
          },
          effects,
        };
      }

      if (item.type === 'window' && item.windowId) {
        const selectedPaneId = preferredPaneIdForWindow(state, item.windowId) ?? state.ui.selectedPaneId;
        const effects: TmuxEffect[] = [];
        if (item.sessionId && state.tmux.activeSessionId !== item.sessionId) {
          effects.push({ type: 'select-session', sessionId: item.sessionId });
        }
        if (state.tmux.activeWindowId !== item.windowId) {
          effects.push({ type: 'select-window', windowId: item.windowId });
        }
        return {
          state: {
            ...state,
            ui: {
              ...state.ui,
              sidebarSection: 'tmux',
              sidebarSelectedIdx,
              selectedPaneId,
              selectedWorkId: null,
            },
          },
          effects,
        };
      }

      if (item.type === 'session' && item.sessionId) {
        return {
          state: {
            ...state,
            ui: {
              ...state.ui,
              sidebarSection: 'tmux',
              sidebarSelectedIdx,
              selectedPaneId: preferredPaneIdForSession(state, item.sessionId) ?? state.ui.selectedPaneId,
              selectedWorkId: null,
            },
          },
          effects: state.tmux.activeSessionId === item.sessionId
            ? []
            : [{ type: 'select-session', sessionId: item.sessionId }],
        };
      }

      return {
        state: {
          ...state,
          ui: { ...state.ui, sidebarSelectedIdx },
        },
        effects: [],
      };
    }

    case 'move-sidebar-selection': {
      if (state.ui.sidebarSection === 'work') {
        const items = activeSessionWorkItemsInState(state);
        if (items.length === 0) {
          return { state, effects: [] };
        }
        const currentIndex = Math.max(
          0,
          items.findIndex((item) => item.work_id === selectedWorkIdForSession(state, state.ui.selectedWorkId, true)),
        );
        const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + intent.delta));
        return {
          state: {
            ...state,
            ui: {
              ...state.ui,
              sidebarSection: 'work',
              selectedPaneId: null,
              selectedWorkId: items[nextIndex]?.work_id ?? null,
            },
          },
          effects: [],
        };
      }

      if (state.ui.sidebarSection === 'agents') {
        const agents = activeSessionAgentsInState(state);
        if (agents.length === 0) {
          return { state, effects: [] };
        }
        const currentIndex = Math.max(
          0,
          agents.findIndex((agent) => paneIdForTileId(state, agent.tile_id) === selectedAgentPaneIdForSession(state)),
        );
        const nextIndex = Math.max(0, Math.min(agents.length - 1, currentIndex + intent.delta));
        return {
          state: {
            ...state,
            ui: {
              ...state.ui,
              sidebarSection: 'agents',
              selectedPaneId: agents[nextIndex] ? paneIdForTileId(state, agents[nextIndex].tile_id) : null,
              selectedWorkId: null,
            },
          },
          effects: [],
        };
      }

      if (state.ui.sidebarSection === 'settings') {
        return { state, effects: [] };
      }

      return reduceIntent(state, {
        type: 'set-sidebar-selection',
        index: state.ui.sidebarSelectedIdx + intent.delta,
      });
    }

    case 'select-work-item':
      return {
        state: {
          ...state,
          ui: {
            ...state.ui,
            sidebarSection: 'work',
            selectedWorkId: selectedWorkIdForSession(state, intent.workId),
          },
        },
        effects: [],
      };

    case 'select-agent-item': {
      const agent = state.agents[intent.agentId];
      if (!agent) {
        return { state, effects: [] };
      }
      const paneId = paneIdForTileId(state, agent.tile_id);
      if (!paneId) {
        return { state, effects: [] };
      }
      return {
        state: {
          ...state,
          ui: {
            ...state.ui,
            sidebarSection: 'agents',
            selectedPaneId: paneId,
            selectedWorkId: null,
          },
        },
        effects: [],
      };
    }

    case 'toggle-debug':
      return { state: { ...state, ui: { ...state.ui, debugPaneOpen: !state.ui.debugPaneOpen } }, effects: [] };

    case 'select-debug-tab':
      return { state: { ...state, ui: { ...state.ui, debugTab: intent.tab } }, effects: [] };

    case 'open-command-bar':
      return { state: { ...state, ui: { ...state.ui, commandBarOpen: true } }, effects: [] };

    case 'close-command-bar':
      return {
        state: { ...state, ui: { ...state.ui, commandBarOpen: false, commandText: '' } },
        effects: [],
      };

    case 'set-command-text':
      return { state: { ...state, ui: { ...state.ui, commandText: intent.text } }, effects: [] };

    case 'open-help':
      return { state: { ...state, ui: { ...state.ui, helpOpen: true } }, effects: [] };

    case 'close-help':
      return { state: { ...state, ui: { ...state.ui, helpOpen: false } }, effects: [] };

    case 'enter-input-mode': {
      const paneId = state.ui.selectedPaneId;
      if (!paneId || state.tmux.panes[paneId]?.readOnly) {
        return { state, effects: [] };
      }
      return { state: { ...state, ui: { ...state.ui, mode: 'input' } }, effects: [] };
    }

    case 'exit-input-mode':
      return { state: { ...state, ui: { ...state.ui, mode: 'command' } }, effects: [] };

    case 'send-input':
      return state.ui.selectedPaneId
        ? { state, effects: [{ type: 'write-pane', paneId: state.ui.selectedPaneId, data: intent.data }] }
        : { state, effects: [] };

    case 'toggle-selected-zoom':
      return {
        state: toggleSelectedZoom(state, 'focused', intent.viewportWidth, intent.viewportHeight),
        effects: [],
      };

    case 'toggle-selected-fullscreen-zoom':
      return {
        state: toggleSelectedZoom(state, 'fullscreen', intent.viewportWidth, intent.viewportHeight),
        effects: [],
      };

    case 'move-selected-pane': {
      const paneId = state.ui.selectedPaneId;
      const tileId = paneId ? paneTileId(state, paneId) : null;
      const entry = tileId ? state.layout.entries[tileId] : null;
      if (!paneId || !tileId || !entry) return { state, effects: [] };
      return {
        state: {
          ...state,
          layout: {
            entries: {
              ...state.layout.entries,
              [tileId]: {
                ...entry,
                x: entry.x + intent.dx,
                y: entry.y + intent.dy,
              },
            },
          },
        },
        effects: [],
      };
    }

    case 'reset-canvas':
      return {
        state: {
          ...state,
          ui: {
            ...state.ui,
            canvas: { panX: 0, panY: 0, zoom: 1 },
            zoomBookmark: null,
          },
        },
        effects: [],
      };
  }
}

async function runEffect(effect: TmuxEffect) {
  switch (effect.type) {
    case 'new-session':
      await newSession(effect.name);
      break;
    case 'new-window':
      await newWindow(effect.sessionId ?? null);
      break;
    case 'new-agent-window':
      await spawnAgentWindow(effect.sessionId ?? null);
      break;
    case 'new-browser-window':
      await spawnBrowserWindow(effect.sessionId ?? null);
      break;
    case 'kill-session':
      await killSession(effect.sessionId);
      break;
    case 'kill-window':
      await killWindow(effect.windowId);
      break;
    case 'select-session':
      await selectSession(effect.sessionId);
      break;
    case 'select-window':
      await selectWindow(effect.windowId);
      break;
    case 'rename-session':
      await renameSession(effect.sessionId, effect.name);
      break;
    case 'rename-window':
      await renameWindow(effect.windowId, effect.name);
      break;
    case 'write-pane':
      await writePane(effect.paneId, effect.data);
      break;
    case 'load-browser-file':
      await loadBrowserWebview(effect.paneId, effect.path);
      break;
    case 'open-work-dialog':
      workDialogOpener?.(effect.placement);
      break;
  }
}

export async function dispatchIntent(intent: UiIntent) {
  const { state, effects } = reduceIntent(get(appState), intent);
  appState.set(state);
  for (const effect of effects) {
    await runEffect(effect);
  }
}

export async function selectContextMenuItem(itemId: string) {
  const { state, effects } = reduceContextMenuSelection(get(appState), itemId);
  appState.set(state);
  for (const effect of effects) {
    await runEffect(effect);
  }
}

export async function bootstrapAppState() {
  const [layout, snapshot, debugState, workItems, browserExtensionPages] = await Promise.all([
    getLayoutState(),
    getTmuxState(),
    getAgentDebugState().catch(() => ({ agents: [], channels: [], chatter: [], agent_logs: [], tile_message_logs: [], connections: [] } satisfies AgentDebugState)),
    getWorkItems().catch(() => [] as WorkItem[]),
    getBrowserExtensionPages().catch(() => [] as BrowserExtensionPage[]),
  ]);
  const nextState = {
    ...applyWorkItemsToState(
    applyAgentDebugStateToState(
      applyTmuxSnapshotToState(
        {
          ...get(appState),
          layout: { entries: layout },
        },
        snapshot,
      ),
      debugState,
    ),
    workItems,
    ),
    browserExtensionPages,
  };
  appState.set(nextState);
  await persistChangedWorkLayoutEntries(layout, nextState.layout.entries, workItems);
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight - 54 : 720;
  fitCanvasToActiveTab(viewportWidth, viewportHeight);
}

export async function refreshWorkItems(sessionId?: string | null) {
  const items = await getWorkItems(sessionId ?? null).catch(() => [] as WorkItem[]);
  const previousState = get(appState);
  const nextState = applyWorkItemsToState(previousState, items);
  appState.set(nextState);
  await persistChangedWorkLayoutEntries(previousState.layout.entries, nextState.layout.entries, items);
}

export async function refreshAgentDebugState() {
  const debugState = await getAgentDebugState().catch(
    () => ({ agents: [], channels: [], chatter: [], agent_logs: [], tile_message_logs: [], connections: [] } satisfies AgentDebugState),
  );
  appState.update((state) => applyAgentDebugStateToState(state, debugState));
}

export function applyTmuxSnapshot(snapshot: TmuxSnapshot) {
  const previousState = get(appState);
  const nextState = applyTmuxSnapshotToState(previousState, snapshot);
  appState.set(nextState);

  const changedEntries = collectChangedLayoutEntries(previousState.layout.entries, nextState.layout.entries);
  for (const [entryId, entry] of changedEntries) {
    void saveLayoutState(entryId, entry.x, entry.y, entry.width, entry.height);
  }
}

export function applyPaneReadOnly(paneId: string, readOnly: boolean) {
  appState.update((state) => applyPaneReadOnlyToState(state, paneId, readOnly));
}

export function applyPaneRole(paneId: string, role: PaneKind) {
  appState.update((state) => applyPaneRoleToState(state, paneId, role));
}

export function applyAgentDebugState(debugState: AgentDebugState) {
  appState.update((state) => applyAgentDebugStateToState(state, debugState));
}

export function appendChatterEntry(entry: ChatterEntry) {
  appState.update((state) => appendChatterEntryToState(state, entry));
}

function createWritableSlice<T>(
  selector: (state: AppStateTree) => T,
  setter: (state: AppStateTree, value: T) => AppStateTree,
): Writable<T> {
  return {
    subscribe: derived(appState, selector).subscribe,
    set(value: T) {
      appState.update((state) => setter(state, value));
    },
    update(fn: (value: T) => T) {
      appState.update((state) => setter(state, fn(selector(state))));
    },
  };
}

export const mode = createWritableSlice<HerdMode>(
  (state) => state.ui.mode,
  (state, value) => ({ ...state, ui: { ...state.ui, mode: value } }),
);

export const commandBarOpen = createWritableSlice<boolean>(
  (state) => state.ui.commandBarOpen,
  (state, value) => ({ ...state, ui: { ...state.ui, commandBarOpen: value } }),
);

export const commandText = createWritableSlice<string>(
  (state) => state.ui.commandText,
  (state, value) => ({ ...state, ui: { ...state.ui, commandText: value } }),
);

export const helpOpen = createWritableSlice<boolean>(
  (state) => state.ui.helpOpen,
  (state, value) => ({ ...state, ui: { ...state.ui, helpOpen: value } }),
);

export const sidebarOpen = createWritableSlice<boolean>(
  (state) => state.ui.sidebarOpen,
  (state, value) => ({ ...state, ui: { ...state.ui, sidebarOpen: value } }),
);

export const sidebarSelectedIdx = createWritableSlice<number>(
  (state) => state.ui.sidebarSelectedIdx,
  (state, value) => ({ ...state, ui: { ...state.ui, sidebarSelectedIdx: value } }),
);

export const debugPaneOpen = createWritableSlice<boolean>(
  (state) => state.ui.debugPaneOpen,
  (state, value) => ({ ...state, ui: { ...state.ui, debugPaneOpen: value } }),
);

export const debugPaneHeight = createWritableSlice<number>(
  (state) => state.ui.debugPaneHeight,
  (state, value) => ({ ...state, ui: { ...state.ui, debugPaneHeight: value } }),
);

export const debugTab = createWritableSlice<DebugTab>(
  (state) => state.ui.debugTab,
  (state, value) => ({ ...state, ui: { ...state.ui, debugTab: value } }),
);

export const closeTabConfirmation = createWritableSlice<CloseTabConfirmation | null>(
  (state) => state.ui.closeTabConfirmation,
  (state, value) => ({ ...state, ui: { ...state.ui, closeTabConfirmation: value } }),
);

export const closePaneConfirmation = createWritableSlice<ClosePaneConfirmation | null>(
  (state) => state.ui.closePaneConfirmation,
  (state, value) => ({ ...state, ui: { ...state.ui, closePaneConfirmation: value } }),
);

export const contextMenuState = derived(appState, ($state) => $state.ui.contextMenu);

export const canvasState = createWritableSlice<CanvasState>(
  (state) => state.ui.canvas,
  (state, value) => ({ ...state, ui: { ...state.ui, canvas: value, zoomBookmark: null } }),
);

export const selectedTerminalId = createWritableSlice<string | null>(
  (state) => state.ui.selectedPaneId,
  (state, value) => ({ ...state, ui: { ...state.ui, selectedPaneId: value, selectedWorkId: null } }),
);

export const selectedWorkId = createWritableSlice<string | null>(
  (state) => state.ui.selectedWorkId,
  (state, value) => ({ ...state, ui: { ...state.ui, selectedWorkId: value } }),
);

export const sidebarSection = createWritableSlice<SidebarSection>(
  (state) => state.ui.sidebarSection,
  (state, value) => ({ ...state, ui: { ...state.ui, sidebarSection: value } }),
);

export const tilePortCount = createWritableSlice<TilePortCount>(
  (state) => state.ui.tilePortCount,
  (state, value) => ({ ...state, ui: { ...state.ui, tilePortCount: value } }),
);

export const tmuxWindows = derived(appState, ($state) =>
  $state.tmux.windowOrder
    .map((id) => $state.tmux.windows[id])
    .filter(Boolean),
);

export const tabs = derived(appState, ($state): Tab[] =>
  $state.tmux.sessionOrder
    .map((id) => $state.tmux.sessions[id])
    .filter(Boolean)
    .map((session) => ({
      id: session.id,
      name: session.name || 'Session',
    })),
);

export const activeTabId: Writable<string | null> = {
  subscribe: derived(appState, ($state) => $state.tmux.activeSessionId).subscribe,
  set(value: string | null) {
    if (value) {
      void dispatchIntent({ type: 'select-session', sessionId: value });
    }
  },
  update() {},
};

export const activeArrangementMode = derived(appState, ($state) => {
  const sessionId = $state.tmux.activeSessionId;
  return sessionId ? $state.ui.arrangementModeBySession[sessionId] ?? null : null;
});

export const sidebarItems = derived(appState, ($state) => buildSidebarItems($state));
export const contextMenuItems = derived(appState, ($state) => buildContextMenuItems($state));
export const chatterEntries = derived(appState, ($state) => $state.chatter);
export const agentInfos = derived(appState, ($state) =>
  activeSessionAgentsInState($state),
);
export const channelInfos = derived(appState, ($state) =>
  Object.values($state.channels)
    .filter((channel) => !$state.tmux.activeSessionId || channel.session_id === $state.tmux.activeSessionId)
    .sort((left, right) => left.name.localeCompare(right.name)),
);
export const activeSessionWorkItems = derived(appState, ($state) =>
  activeSessionWorkItemsInState($state),
);

export function calculateWindowSizeRequest(
  state: AppStateTree,
  windowId: string,
  sourcePaneId?: string,
): { cols: number; rows: number } | null {
  const window = state.tmux.windows[windowId];
  const paneId = sourcePaneId ?? window?.pane_ids[0];
  const hint = paneId ? state.ui.paneViewportHints[paneId] : null;
  if (!window || !paneId || !hint) return null;
  if (hint.cols <= 0 || hint.rows <= 0) return null;

  return {
    cols: Math.max(20, hint.cols),
    rows: Math.max(8, hint.rows),
  };
}

const pendingWindowResizeRequests = new Map<string, string>();
const paneDriverHandles = new Map<string, PaneDriverHandle>();

export interface PaneDriverHandle {
  focusInput: () => void;
  syncViewport: (requestResize?: boolean) => Promise<void>;
}

export function __resetWindowResizeTrackingForTest() {
  pendingWindowResizeRequests.clear();
}

export function registerPaneDriverHandle(paneId: string, handle: PaneDriverHandle): () => void {
  paneDriverHandles.set(paneId, handle);
  return () => {
    if (paneDriverHandles.get(paneId) === handle) {
      paneDriverHandles.delete(paneId);
    }
  };
}

function terminalInfoForPane(state: AppStateTree, paneId: string): TerminalInfo | null {
  const pane = state.tmux.panes[paneId];
  const window = pane ? state.tmux.windows[pane.window_id] : null;
  const tileId = pane ? paneTileId(state, pane.id) : null;
  const entry = tileId ? state.layout.entries[tileId] : null;
  const kind = pane ? paneKindForPane(state, pane.id) : 'regular';
  const agent = tileId && (kind === 'claude' || kind === 'root_agent')
    ? activeSessionAgentsInState(state).find((item) => item.tile_id === tileId) ?? null
    : null;
  if (!pane || !window || !tileId || !entry) return null;
  const minimized = isTileMinimizedInState(state, tileId);
  return {
    id: pane.id,
    tileId,
    paneId: pane.id,
    windowId: window.id,
    parentWindowId: window.parent_window_id ?? null,
    parentWindowSource: window.parent_window_source ?? null,
    sessionId: pane.session_id,
    tabId: pane.session_id,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
    title: defaultWindowTitle(window, pane),
    command: pane.command,
    readOnly: pane.readOnly,
    kind,
    agentId: agent?.agent_id ?? null,
    ...(minimized ? { minimized: true } : {}),
  };
}

function buildAgentRecord(agents: AgentInfo[]): Record<string, AgentInfo> {
  const record: Record<string, AgentInfo> = {};
  for (const agent of agents) {
    record[agent.agent_id] = agent;
  }
  return record;
}

function buildChannelRecord(channels: ChannelInfo[]): Record<string, ChannelInfo> {
  const record: Record<string, ChannelInfo> = {};
  for (const channel of channels) {
    record[channel.name] = channel;
  }
  return record;
}

function buildWorkRecord(items: WorkItem[]): { items: Record<string, WorkItem>; order: string[] } {
  const record: Record<string, WorkItem> = {};
  for (const item of items) {
    record[item.work_id] = item;
  }
  return {
    items: record,
    order: items.map((item) => item.work_id),
  };
}

function buildDefaultWorkLayoutEntry(
  state: AppStateTree,
  workItems: WorkItem[],
  entries: Record<string, LayoutEntry>,
  workId: string,
): LayoutEntry {
  const terminals = state.tmux.windowOrder
    .filter((windowId) => state.tmux.windows[windowId]?.session_id === state.tmux.activeSessionId)
    .map((windowId) => {
      const paneId = state.tmux.windows[windowId]?.pane_ids[0];
      return paneId ? terminalInfoForPane(state, paneId) : null;
    })
    .filter((term): term is TerminalInfo => Boolean(term));

  const maxX = terminals.reduce((value, term) => Math.max(value, term.x + term.width), 80);
  const minY = terminals.reduce((value, term) => Math.min(value, term.y), 80);
  const baseX = maxX + GAP * 2;
  const baseY = Number.isFinite(minY) ? minY : 80;
  const workIndex = workItems.findIndex((item) => item.work_id === workId);
  const desiredY = baseY + Math.max(0, workIndex) * (WORK_CARD_HEIGHT + GAP);
  const currentWorkItem = workItems.find((item) => item.work_id === workId) ?? null;

  const occupiedIds = [
    ...state.tmux.windowOrder
      .filter((windowId) => state.tmux.windows[windowId]?.session_id === state.tmux.activeSessionId)
      .map((windowId) => windowTileId(state.tmux.windows[windowId]))
      .filter((entryId): entryId is string => Boolean(entryId)),
    ...workItems
      .map((item) => item.tile_id)
      .filter((entryId) => entryId !== currentWorkItem?.tile_id),
  ];

  return findOpenPosition(baseX, desiredY, WORK_CARD_WIDTH, WORK_CARD_HEIGHT, occupiedIds, entries);
}

function ensureWorkLayoutEntries(state: AppStateTree, workItems: WorkItem[]): Record<string, LayoutEntry> {
  let changed = false;
  const nextEntries = { ...state.layout.entries };
  const workTileIds = workTileIdSet(workItems);

  for (const entryId of Object.keys(nextEntries)) {
    const trackedWindow = Object.values(state.tmux.windows).some((window) => windowTileId(window) === entryId);
    if (!trackedWindow && !workTileIds.has(entryId)) {
      delete nextEntries[entryId];
      changed = true;
    }
  }

  for (const item of workItems) {
    const entryId = item.tile_id;
    if (nextEntries[entryId]) {
      continue;
    }
    nextEntries[entryId] = buildDefaultWorkLayoutEntry(state, workItems, nextEntries, item.work_id);
    changed = true;
  }

  return changed ? nextEntries : state.layout.entries;
}

function removeWorkLayoutEntry(
  state: AppStateTree,
  entries: Record<string, LayoutEntry>,
  workId: string,
): Record<string, LayoutEntry> {
  const item = state.work.items[workId];
  const entryId = item?.tile_id ?? null;
  if (!entryId || !(entryId in entries)) {
    return entries;
  }
  const nextEntries = { ...entries };
  delete nextEntries[entryId];
  return nextEntries;
}

async function persistChangedWorkLayoutEntries(
  previousEntries: Record<string, LayoutEntry>,
  nextEntries: Record<string, LayoutEntry>,
  workItems: WorkItem[],
) {
  const workTileIds = workTileIdSet(workItems);
  const changedEntries = collectChangedLayoutEntries(previousEntries, nextEntries)
    .filter(([entryId]) => workTileIds.has(entryId));
  if (changedEntries.length === 0) {
    return;
  }

  await Promise.all(
    changedEntries.map(([entryId, entry]) =>
      saveLayoutState(entryId, entry.x, entry.y, entry.width, entry.height),
    ),
  );
}

export function applyAgentDebugStateToState(state: AppStateTree, debugState: AgentDebugState): AppStateTree {
  const activeSessionId = state.tmux.activeSessionId;
  const agents = activeSessionId
    ? debugState.agents.filter((agent) => agent.session_id === activeSessionId)
    : debugState.agents;
  const channels = activeSessionId
    ? debugState.channels.filter((channel) => channel.session_id === activeSessionId)
    : debugState.channels;
  const chatter = activeSessionId
    ? debugState.chatter.filter((entry) => entry.session_id === activeSessionId)
    : debugState.chatter;
  const agentLogs = activeSessionId
    ? debugState.agent_logs.filter((entry) => entry.session_id === activeSessionId)
    : debugState.agent_logs;
  const tileMessageLogs = activeSessionId
    ? debugState.tile_message_logs.filter((entry) => entry.session_id === activeSessionId)
    : debugState.tile_message_logs;
  const nextDebugTab =
    state.ui.debugTab === 'logs' && chatter.length > 0
      ? 'chatter'
      : state.ui.debugTab;
  return {
    ...state,
    agents: buildAgentRecord(agents),
    channels: buildChannelRecord(channels),
    chatter,
    agentLogs,
    tileMessageLogs,
    network: {
      connections: debugState.connections.filter(
        (connection) => !activeSessionId || connection.session_id === activeSessionId,
      ),
    },
    ui: {
      ...state.ui,
      debugTab: nextDebugTab,
    },
  };
}

export function appendChatterEntryToState(state: AppStateTree, entry: ChatterEntry): AppStateTree {
  if (state.tmux.activeSessionId && entry.session_id !== state.tmux.activeSessionId) {
    return state;
  }
  const nextDebugTab = state.ui.debugTab === 'logs' ? 'chatter' : state.ui.debugTab;
  return {
    ...state,
    chatter: [...state.chatter, entry],
    ui: {
      ...state.ui,
      debugTab: nextDebugTab,
    },
  };
}

export function applyWorkItemsToState(state: AppStateTree, workItems: WorkItem[]): AppStateTree {
  const nextState = {
    ...state,
    layout: {
      entries: ensureWorkLayoutEntries(state, workItems),
    },
    work: buildWorkRecord(workItems),
  };
  return {
    ...nextState,
    ui: {
      ...nextState.ui,
      selectedWorkId: selectedWorkIdForSession(nextState),
      sidebarSection: sidebarSectionForState(nextState),
      minimizedTileIdsBySession: reconcileMinimizedTileIds(
        nextState.ui.minimizedTileIdsBySession,
        nextState.tmux.sessions,
        nextState.tmux.windows,
        nextState.work.items,
      ),
    },
  };
}

function tileMessageLogKind(layer: TileMessageLogEntry['layer']): TileActivityEntry['kind'] {
  switch (layer) {
    case 'network':
      return 'network_log';
    case 'message':
      return 'message_log';
    default:
      return 'socket_log';
  }
}

function tileMessageLogRelatesToTile(entry: TileMessageLogEntry, tileId: string) {
  return entry.caller_tile_id === tileId
    || entry.target_id === tileId
    || entry.related_tile_ids.includes(tileId);
}

function formatTileMessageActivityText(entry: TileMessageLogEntry, tileId: string) {
  const prefix = `[${entry.layer.toUpperCase()}/${entry.channel.toUpperCase()}]`;
  const outcome = entry.outcome === 'ok' ? '' : ` ${entry.outcome.toUpperCase()}`;
  const error = entry.error ? ` ${entry.error}` : '';
  if (entry.caller_tile_id === tileId && entry.target_id !== tileId) {
    return `${prefix} send ${entry.wrapper_command} -> ${entry.target_kind}:${entry.target_id}${outcome}${error}`;
  }
  if (entry.target_id === tileId) {
    const caller = entry.caller_tile_id ? ` <- ${entry.caller_tile_id}` : '';
    return `${prefix} recv ${entry.message_name}${caller}${outcome}${error}`;
  }
  return `${prefix} ${entry.wrapper_command}${outcome}${error}`;
}

export function buildTileActivityEntries(state: AppStateTree, tileId: string): TileActivityEntry[] {
  const agent = Object.values(state.agents).find((item) => item.tile_id === tileId);

  const chatterEntries = agent ? state.chatter.flatMap<TileActivityEntry>((entry) => {
    if (entry.kind === 'direct') {
      if (entry.to_agent_id === agent.agent_id) {
        return [{ kind: 'incoming_dm' as const, text: entry.display_text, timestamp_ms: entry.timestamp_ms }];
      }
      if (entry.from_agent_id === agent.agent_id) {
        return [{ kind: 'outgoing_dm' as const, text: entry.display_text, timestamp_ms: entry.timestamp_ms }];
      }
      return [];
    }

    if (entry.kind === 'public' || entry.kind === 'channel') {
      if (entry.from_agent_id === agent.agent_id) {
        return [{ kind: 'outgoing_chatter' as const, text: entry.display_text, timestamp_ms: entry.timestamp_ms }];
      }
      if (entry.mentions.includes(agent.agent_id)) {
        return [{ kind: 'mention' as const, text: entry.display_text, timestamp_ms: entry.timestamp_ms }];
      }
      if (entry.channels.some((channel) => agent.channels.includes(channel))) {
        return [{ kind: 'channel' as const, text: entry.display_text, timestamp_ms: entry.timestamp_ms }];
      }
    }

    if (entry.kind === 'network' || entry.kind === 'root') {
      if (entry.from_agent_id === agent.agent_id) {
        return [{ kind: 'outgoing_chatter' as const, text: entry.display_text, timestamp_ms: entry.timestamp_ms }];
      }
      if (entry.to_agent_id === agent.agent_id) {
        return [{ kind: 'incoming_dm' as const, text: entry.display_text, timestamp_ms: entry.timestamp_ms }];
      }
    }

    return [];
  }) : [];

  const agentLogEntries = state.agentLogs
    .filter((entry) => entry.tile_id === tileId)
    .map<TileActivityEntry>((entry) => ({
      kind: entry.kind,
      text: entry.text,
      timestamp_ms: entry.timestamp_ms,
    }));

  const tileMessageEntries = state.tileMessageLogs
    .filter((entry) => tileMessageLogRelatesToTile(entry, tileId))
    .map<TileActivityEntry>((entry) => ({
      kind: tileMessageLogKind(entry.layer),
      text: formatTileMessageActivityText(entry, tileId),
      timestamp_ms: entry.timestamp_ms,
    }));

  return [...chatterEntries, ...agentLogEntries, ...tileMessageEntries]
    .sort((left, right) => left.timestamp_ms - right.timestamp_ms);
}

export const terminals = derived(appState, ($state) =>
  $state.tmux.windowOrder
    .flatMap((windowId) => $state.tmux.windows[windowId]?.pane_ids[0] ?? [])
    .map((paneId) => terminalInfoForPane($state, paneId))
    .filter((term): term is TerminalInfo => Boolean(term)),
);

export const activeTabTerminals = derived(appState, ($state) => {
  const activeSessionId = $state.tmux.activeSessionId;
  if (!activeSessionId) return [] as TerminalInfo[];
  return $state.tmux.windowOrder
    .filter((windowId) => $state.tmux.windows[windowId]?.session_id === activeSessionId)
    .map((windowId) => {
      const paneId = $state.tmux.windows[windowId]?.pane_ids[0];
      return paneId ? terminalInfoForPane($state, paneId) : null;
    })
    .filter((term): term is TerminalInfo => Boolean(term));
});

export const activeTabVisibleTerminals = derived(activeTabTerminals, ($terminals) =>
  $terminals.filter((term) => !term.minimized),
);

export function buildCanvasWorkCards(state: AppStateTree): WorkCanvasCard[] {
  const workItems = activeSessionWorkItemsInState(state);
  if (workItems.length === 0) return [];

  return workItems.flatMap((item) => {
    const entry = state.layout.entries[item.tile_id];
    if (!entry) return [];
    const minimized = isTileMinimizedInState(state, item.tile_id);
    return [{
      workId: item.work_id,
      tileId: item.tile_id,
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      ...(minimized ? { minimized: true } : {}),
    }];
  });
}

export const activeTabWorkCards = derived(appState, ($state) => buildCanvasWorkCards($state));

export const activeTabVisibleWorkCards = derived(activeTabWorkCards, ($cards) =>
  $cards.filter((card) => !card.minimized),
);

export interface MinimizedTileDockItem {
  tileId: string;
  kind: 'pane' | 'work';
  label: string;
  badge: string;
  selected: boolean;
}

function dockBadgeForPaneKind(kind: PaneKind | undefined): string {
  switch (kind) {
    case 'browser':
      return 'WEB';
    case 'root_agent':
      return 'ROOT';
    case 'claude':
      return 'AGENT';
    case 'output':
      return 'VIEW';
    default:
      return 'TTY';
  }
}

export const activeTabMinimizedDockItems = derived(appState, ($state): MinimizedTileDockItem[] => {
  const activeSessionId = $state.tmux.activeSessionId;
  if (!activeSessionId) {
    return [];
  }

  const items: MinimizedTileDockItem[] = [];
  for (const tileId of minimizedTileIdsForSession($state, activeSessionId)) {
    const workItem = workItemForTileId($state, tileId);
    if (workItem) {
      items.push({
        tileId,
        kind: 'work',
        label: workItem.title,
        badge: 'WORK',
        selected: $state.ui.selectedWorkId === workItem.work_id,
      });
      continue;
    }

    const paneId = paneIdForTileId($state, tileId);
    const terminal = paneId ? terminalInfoForPane($state, paneId) : null;
    if (!terminal?.minimized) {
      continue;
    }

    items.push({
      tileId,
      kind: 'pane',
      label: terminal.title,
      badge: dockBadgeForPaneKind(terminal.kind),
      selected: $state.ui.selectedPaneId === paneId,
    });
  }

  return items;
});

export interface CanvasConnection {
  childWindowId: string;
  parentWindowId: string;
  path: string;
  points: Point[];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RenderedNetworkConnection {
  fromTileId: string;
  fromPort: TilePort;
  toTileId: string;
  toPort: TilePort;
  wireMode: 'read_only' | 'full_duplex';
  path: string;
  points: Point[];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface NetworkCallSignalSegment {
  id: string;
  fromTileId: string;
  toTileId: string;
  connectionKey: string;
  wireMode: RenderedNetworkConnection['wireMode'];
  path: string;
  motionPath: string;
  delayMs: number;
  durationMs: number;
}

export interface NetworkCallSignal {
  id: string;
  fromTileId: string;
  toTileId: string;
  timestampMs: number;
  totalDurationMs: number;
  segments: NetworkCallSignalSegment[];
}

export function portModeForTileKind(kind: NetworkTileKind, port: TilePort): PortMode {
  if (kind === 'work' && tilePortSide(port) !== 'left') {
    return 'read';
  }
  return 'read_write';
}

function tileKindForTileId(state: AppStateTree, tileId: string): NetworkTileKind | null {
  if (workItemForTileId(state, tileId)) {
    return 'work';
  }
  const paneId = paneIdForTileId(state, tileId);
  const pane = paneId ? state.tmux.panes[paneId] : null;
  if (!pane) {
    return null;
  }
  const kind = paneKindForPane(state, pane.id);
  switch (kind) {
    case 'claude':
      return 'agent';
    case 'root_agent':
      return 'root_agent';
    case 'browser':
      return 'browser';
    default:
      return 'shell';
  }
}

function networkConnectionKey(connection: NetworkConnection): string {
  return `${connection.from_tile_id}:${connection.from_port}-${connection.to_tile_id}:${connection.to_port}`;
}

function renderedNetworkConnectionKey(connection: RenderedNetworkConnection): string {
  return `${connection.fromTileId}:${connection.fromPort}-${connection.toTileId}:${connection.toPort}`;
}

function renderedNetworkConnectionMode(
  state: AppStateTree,
  connection: NetworkConnection,
): 'read_only' | 'full_duplex' {
  const fromKind = tileKindForTileId(state, connection.from_tile_id);
  const toKind = tileKindForTileId(state, connection.to_tile_id);
  if (!fromKind || !toKind) {
    return 'full_duplex';
  }
  return (
    portModeForTileKind(fromKind, connection.from_port) === 'read_write'
    && portModeForTileKind(toKind, connection.to_port) === 'read_write'
  )
    ? 'full_duplex'
    : 'read_only';
}

function approximateWirePathLength(points: Point[]) {
  if (points.length < 2) {
    return 0;
  }
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    length += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  return length;
}

interface NetworkConnectionRouteHop {
  connection: NetworkConnection;
  reverse: boolean;
}

function findNetworkConnectionRoute(
  state: AppStateTree,
  sessionId: string,
  fromTileId: string,
  toTileId: string,
): NetworkConnectionRouteHop[] | null {
  if (fromTileId === toTileId) {
    return [];
  }

  const scopedConnections = state.network.connections.filter((connection) => connection.session_id === sessionId);
  if (scopedConnections.length === 0) {
    return null;
  }

  const visited = new Set<string>([fromTileId]);
  const queue: Array<{ tileId: string; hops: NetworkConnectionRouteHop[] }> = [{ tileId: fromTileId, hops: [] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    for (const connection of scopedConnections) {
      let nextTileId: string | null = null;
      let reverse = false;
      if (connection.from_tile_id === current.tileId) {
        nextTileId = connection.to_tile_id;
      } else if (connection.to_tile_id === current.tileId) {
        nextTileId = connection.from_tile_id;
        reverse = true;
      }

      if (!nextTileId || visited.has(nextTileId)) {
        continue;
      }

      const nextHops = [...current.hops, { connection, reverse }];
      if (nextTileId === toTileId) {
        return nextHops;
      }

      visited.add(nextTileId);
      queue.push({ tileId: nextTileId, hops: nextHops });
    }
  }

  return null;
}

function networkCallSignalDurationMs(connection: RenderedNetworkConnection) {
  const estimatedPathLength = approximateWirePathLength(connection.points);
  return Math.max(220, Math.min(480, Math.round(estimatedPathLength * 0.8)));
}

export function buildNetworkCallSignals(
  state: AppStateTree,
  logEntries: TileMessageLogEntry[],
): NetworkCallSignal[] {
  if (logEntries.length === 0) {
    return [];
  }

  const renderedConnectionsByKey = new Map(
    buildRenderedNetworkConnections(state).map((connection) => [renderedNetworkConnectionKey(connection), connection]),
  );
  const SIGNAL_GAP_MS = 40;

  return logEntries.flatMap((entry, entryIndex) => {
    if (
      entry.layer !== 'network'
      || entry.wrapper_command !== 'network_call'
      || entry.outcome !== 'ok'
      || !entry.caller_tile_id
      || !entry.target_id
      || entry.caller_tile_id === entry.target_id
    ) {
      return [];
    }

    const route = findNetworkConnectionRoute(
      state,
      entry.session_id,
      entry.caller_tile_id,
      entry.target_id,
    );
    if (!route || route.length === 0) {
      return [];
    }

    let accumulatedDelayMs = 0;
    const segments: NetworkCallSignalSegment[] = [];

    for (const [segmentIndex, hop] of route.entries()) {
      const connectionKey = networkConnectionKey(hop.connection);
      const renderedConnection = renderedConnectionsByKey.get(connectionKey);
      if (!renderedConnection) {
        return [];
      }

      const durationMs = networkCallSignalDurationMs(renderedConnection);
      const delayMs = accumulatedDelayMs;
      accumulatedDelayMs += durationMs + SIGNAL_GAP_MS;

      segments.push({
        id: [
          entry.session_id,
          entry.timestamp_ms,
          entry.caller_tile_id,
          entry.target_id,
          entry.message_name,
          entryIndex,
          segmentIndex,
        ].join(':'),
        fromTileId: entry.caller_tile_id,
        toTileId: entry.target_id,
        connectionKey,
        wireMode: renderedConnection.wireMode,
        path: renderedConnection.path,
        motionPath: hop.reverse
          ? wirePathFromPoints(
            [...renderedConnection.points].reverse(),
            renderedConnection.toPort,
            renderedConnection.fromPort,
          )
          : renderedConnection.path,
        delayMs,
        durationMs,
      });
    }

    if (segments.length === 0) {
      return [];
    }

    const lastSegment = segments[segments.length - 1];
    return [{
      id: [
        entry.session_id,
        entry.timestamp_ms,
        entry.caller_tile_id,
        entry.target_id,
        entry.message_name,
        entryIndex,
      ].join(':'),
      fromTileId: entry.caller_tile_id,
      toTileId: entry.target_id,
      timestampMs: entry.timestamp_ms,
      totalDurationMs: lastSegment.delayMs + lastSegment.durationMs,
      segments,
    }];
  });
}

function oppositeConnectionEndpoint(
  connection: NetworkConnection,
  tileId: string,
  port: TilePort,
): { tileId: string; port: TilePort } | null {
  if (connection.from_tile_id === tileId && connection.from_port === port) {
    return { tileId: connection.to_tile_id, port: connection.to_port };
  }
  if (connection.to_tile_id === tileId && connection.to_port === port) {
    return { tileId: connection.from_tile_id, port: connection.from_port };
  }
  return null;
}

function connectionForPort(
  state: AppStateTree,
  tileId: string,
  port: TilePort,
  ignoredConnectionKey?: string | null,
): NetworkConnection | null {
  return state.network.connections.find((connection) => {
    if (ignoredConnectionKey && networkConnectionKey(connection) === ignoredConnectionKey) {
      return false;
    }
    return (
      (connection.from_tile_id === tileId && connection.from_port === port)
      || (connection.to_tile_id === tileId && connection.to_port === port)
    );
  }) ?? null;
}

function removeNetworkConnectionFromState(state: AppStateTree, connectionKey: string): AppStateTree {
  return {
    ...state,
    network: {
      connections: state.network.connections.filter(
        (connection) => networkConnectionKey(connection) !== connectionKey,
      ),
    },
  };
}

function upsertNetworkConnectionInState(state: AppStateTree, connection: NetworkConnection): AppStateTree {
  const connectionKey = networkConnectionKey(connection);
  return {
    ...state,
    network: {
      connections: [
        ...state.network.connections.filter(
          (existing) => networkConnectionKey(existing) !== connectionKey,
        ),
        connection,
      ].sort((left, right) =>
        networkConnectionKey(left).localeCompare(networkConnectionKey(right), undefined, { numeric: true }),
      ),
    },
  };
}

function inferredLoosePort(startX: number, startY: number, endX: number, endY: number): TilePort {
  const dx = endX - startX;
  const dy = endY - startY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'left' : 'right';
  }
  return dy >= 0 ? 'top' : 'bottom';
}

function buildNetworkReleaseAnimation(drag: NetworkDragState): NetworkReleaseAnimationState | null {
  if (!drag.startedOccupied || !drag.detachedConnectionKey) {
    return null;
  }
  const looseX = drag.snappedX ?? drag.currentX;
  const looseY = drag.snappedY ?? drag.currentY;
  return {
    connectionKey: drag.detachedConnectionKey,
    anchorTileId: drag.tileId,
    anchorPort: drag.port,
    anchorX: drag.startX,
    anchorY: drag.startY,
    looseX,
    looseY,
    loosePort: drag.snappedPort ?? inferredLoosePort(drag.startX, drag.startY, looseX, looseY),
  };
}

function activeSessionTileRects(state: AppStateTree): Map<string, TileRect> {
  const activeSessionId = state.tmux.activeSessionId;
  const tileRects = new Map<string, TileRect>();
  if (!activeSessionId) {
    return tileRects;
  }

  for (const windowId of state.tmux.windowOrder) {
    const window = state.tmux.windows[windowId];
    if (!window || window.session_id !== activeSessionId) continue;
    const paneId = window.pane_ids[0];
    if (!paneId) continue;
    const terminal = terminalInfoForPane(state, paneId);
    if (terminal && !terminal.minimized) {
      tileRects.set(terminal.tileId, {
        x: terminal.x,
        y: terminal.y,
        width: terminal.width,
        height: terminal.height,
      });
    }
  }

  for (const card of buildCanvasWorkCards(state)) {
    if (card.minimized) continue;
    tileRects.set(card.tileId, {
      x: card.x,
      y: card.y,
      width: card.width,
      height: card.height,
    });
  }

  return tileRects;
}

function occupiedPortsForTile(state: AppStateTree, tileId: string): TilePort[] {
  return state.network.connections.flatMap((connection) => {
    const ports: TilePort[] = [];
    if (connection.from_tile_id === tileId) {
      ports.push(connection.from_port);
    }
    if (connection.to_tile_id === tileId) {
      ports.push(connection.to_port);
    }
    return ports;
  });
}

function portPoint(rect: TileRect, port: TilePort, visibleSlotCount: number): Point {
  const ratio = tilePortOffsetRatio(port, visibleSlotCount);
  switch (tilePortSide(port)) {
    case 'left':
      return { x: rect.x, y: rect.y + rect.height * ratio };
    case 'top':
      return { x: rect.x + rect.width * ratio, y: rect.y };
    case 'right':
      return { x: rect.x + rect.width, y: rect.y + rect.height * ratio };
    case 'bottom':
      return { x: rect.x + rect.width * ratio, y: rect.y + rect.height };
  }
}

function portPointForTile(state: AppStateTree, tileId: string, rect: TileRect, port: TilePort): Point {
  const visibleSlotsBySide = visibleTilePortSlotsBySide(state.ui.tilePortCount, occupiedPortsForTile(state, tileId));
  return portPoint(rect, port, visibleSlotsBySide[tilePortSide(port)]);
}

interface WireRouteCache {
  key: string | null;
  routes: Record<string, RoutedWireGeometry>;
}

const canvasWireRouteCache: WireRouteCache = { key: null, routes: {} };
const networkWireRouteCache: WireRouteCache = { key: null, routes: {} };

function wireRouteCacheKey(rects: Map<string, TileRect>, specs: WireRouteSpec[]) {
  const rectPart = [...rects.entries()]
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId, undefined, { numeric: true }))
    .map(([tileId, rect]) => `${tileId}:${rect.x},${rect.y},${rect.width},${rect.height}`)
    .join('|');
  const specPart = [...specs]
    .sort((left, right) => left.key.localeCompare(right.key, undefined, { numeric: true }))
    .map((spec) =>
      `${spec.key}:${spec.startPoint.x},${spec.startPoint.y}->${spec.endPoint.x},${spec.endPoint.y}:${spec.startPort ?? '-'}:${spec.endPort ?? '-'}:${spec.startRectId ?? '-'}:${spec.endRectId ?? '-'}`)
    .join('|');
  return `${rectPart}::${specPart}`;
}

function routeWireGeometriesWithCache(
  cache: WireRouteCache,
  rects: Map<string, TileRect>,
  specs: WireRouteSpec[],
) {
  if (specs.length === 0) {
    cache.key = '';
    cache.routes = {};
    return cache.routes;
  }
  const nextKey = wireRouteCacheKey(rects, specs);
  if (cache.key === nextKey) {
    return cache.routes;
  }
  cache.key = nextKey;
  cache.routes = routeWireGeometries(rects, specs);
  return cache.routes;
}

function isAgentKind(kind: NetworkTileKind): boolean {
  return kind === 'agent' || kind === 'root_agent';
}

function portAcceptsTile(kind: NetworkTileKind, port: TilePort, otherKind: NetworkTileKind): boolean {
  if ((kind === 'work' || kind === 'browser') && tilePortSide(port) === 'left') {
    return isAgentKind(otherKind);
  }
  return true;
}

function canConnectPorts(
  state: AppStateTree,
  fromTileId: string,
  fromPort: TilePort,
  toTileId: string,
  toPort: TilePort,
  ignoredConnectionKey?: string | null,
): boolean {
  if (fromTileId === toTileId) {
    return false;
  }

  const fromKind = tileKindForTileId(state, fromTileId);
  const toKind = tileKindForTileId(state, toTileId);
  if (!fromKind || !toKind) {
    return false;
  }

  if (connectionForPort(state, toTileId, toPort, ignoredConnectionKey)) {
    return false;
  }

  const fromMode = portModeForTileKind(fromKind, fromPort);
  const toMode = portModeForTileKind(toKind, toPort);
  if (fromMode === 'read' && toMode === 'read') {
    return false;
  }

  return portAcceptsTile(fromKind, fromPort, toKind) && portAcceptsTile(toKind, toPort, fromKind);
}

function worldPointToViewport(state: AppStateTree, point: Point): Point {
  return {
    x: point.x * state.ui.canvas.zoom + state.ui.canvas.panX,
    y: point.y * state.ui.canvas.zoom + state.ui.canvas.panY,
  };
}

function snappedNetworkTarget(
  state: AppStateTree,
  drag: NetworkDragState,
  currentX: number,
  currentY: number,
): Pick<NetworkDragState, 'snappedTileId' | 'snappedPort' | 'snappedX' | 'snappedY'> {
  const tileRects = activeSessionTileRects(state);
  let best:
    | {
        tileId: string;
        port: TilePort;
        x: number;
        y: number;
        distance: number;
      }
    | null = null;

  for (const [tileId, rect] of tileRects) {
    if (tileId === drag.tileId) continue;
    for (const port of tilePortsForCount(state.ui.tilePortCount)) {
      if (!canConnectPorts(state, drag.tileId, drag.port, tileId, port, drag.detachedConnectionKey)) {
        continue;
      }
      const candidate = worldPointToViewport(state, portPointForTile(state, tileId, rect, port));
      const distance = Math.hypot(candidate.x - currentX, candidate.y - currentY);
      if (distance > NETWORK_SNAP_DISTANCE) {
        continue;
      }
      if (!best || distance < best.distance) {
        best = { tileId, port, x: candidate.x, y: candidate.y, distance };
      }
    }
  }

  if (!best) {
    return {
      snappedTileId: null,
      snappedPort: null,
      snappedX: null,
      snappedY: null,
    };
  }

  return {
    snappedTileId: best.tileId,
    snappedPort: best.port,
    snappedX: best.x,
    snappedY: best.y,
  };
}

export function buildCanvasConnections(state: AppStateTree): CanvasConnection[] {
  const activeSessionId = state.tmux.activeSessionId;
  if (!activeSessionId) return [];

  const terminalsByWindowId = new Map<string, TerminalInfo>();
  for (const windowId of state.tmux.windowOrder) {
    const window = state.tmux.windows[windowId];
    if (!window || window.session_id !== activeSessionId) continue;
    const paneId = window.pane_ids[0];
    if (!paneId) continue;
    const term = terminalInfoForPane(state, paneId);
    if (term && !term.minimized) {
      terminalsByWindowId.set(windowId, term);
    }
  }

  const tileRects = activeSessionTileRects(state);
  const pendingConnections: Array<{
    childWindowId: string;
    parentWindowId: string;
    spec: WireRouteSpec;
  }> = [];
  for (const child of terminalsByWindowId.values()) {
    if (child.parentWindowSource !== 'hook') continue;
    const parentWindowId = child.parentWindowId ?? null;
    if (!parentWindowId) continue;
    const parent = terminalsByWindowId.get(parentWindowId);
    if (!parent) continue;

    const parentCenterX = parent.x + parent.width / 2;
    const parentCenterY = parent.y + parent.height / 2;
    const childCenterX = child.x + child.width / 2;
    const childCenterY = child.y + child.height / 2;
    const dx = childCenterX - parentCenterX;
    const dy = childCenterY - parentCenterY;

    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;

    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) {
        x1 = parent.x + parent.width;
        y1 = parentCenterY;
        x2 = child.x;
        y2 = childCenterY;
      } else {
        x1 = parent.x;
        y1 = parentCenterY;
        x2 = child.x + child.width;
        y2 = childCenterY;
      }
    } else if (dy > 0) {
      x1 = parentCenterX;
      y1 = parent.y + parent.height;
      x2 = childCenterX;
      y2 = child.y;
    } else {
      x1 = parentCenterX;
      y1 = parent.y;
      x2 = childCenterX;
      y2 = child.y + child.height;
    }

    pendingConnections.push({
      childWindowId: child.windowId,
      parentWindowId,
      spec: {
        key: child.windowId,
        startPoint: { x: x1, y: y1 },
        endPoint: { x: x2, y: y2 },
      },
    });
  }

  const routedGeometries = routeWireGeometriesWithCache(
    canvasWireRouteCache,
    tileRects,
    pendingConnections.map((connection) => connection.spec),
  );

  return pendingConnections.flatMap((connection) => {
    const geometry = routedGeometries[connection.spec.key];
    if (!geometry) {
      return [];
    }
    return [{
      childWindowId: connection.childWindowId,
      parentWindowId: connection.parentWindowId,
      path: geometry.path,
      points: geometry.points,
      x1: geometry.x1,
      y1: geometry.y1,
      x2: geometry.x2,
      y2: geometry.y2,
    }];
  });
}

export const activeTabConnections = derived(appState, ($state) => buildCanvasConnections($state));
export function buildRenderedNetworkConnections(state: AppStateTree): RenderedNetworkConnection[] {
  const activeSessionId = state.tmux.activeSessionId;
  if (!activeSessionId) return [];

  const tileRects = activeSessionTileRects(state);
  const scopedConnections = state.network.connections.filter((connection) => connection.session_id === activeSessionId);
  const routedGeometries = routeWireGeometriesWithCache(
    networkWireRouteCache,
    tileRects,
    scopedConnections.flatMap((connection) => {
      const fromRect = tileRects.get(connection.from_tile_id);
      const toRect = tileRects.get(connection.to_tile_id);
      if (!fromRect || !toRect) {
        return [];
      }
      return [{
        key: networkConnectionKey(connection),
        startPoint: portPointForTile(state, connection.from_tile_id, fromRect, connection.from_port),
        endPoint: portPointForTile(state, connection.to_tile_id, toRect, connection.to_port),
        startPort: connection.from_port,
        endPort: connection.to_port,
        startRectId: connection.from_tile_id,
        endRectId: connection.to_tile_id,
      } satisfies WireRouteSpec];
    }),
  );

  return scopedConnections
    .flatMap((connection) => {
      const geometry = routedGeometries[networkConnectionKey(connection)];
      if (!geometry) {
        return [];
      }
      return [{
        fromTileId: connection.from_tile_id,
        fromPort: connection.from_port,
        toTileId: connection.to_tile_id,
        toPort: connection.to_port,
        wireMode: renderedNetworkConnectionMode(state, connection),
        path: geometry.path,
        points: geometry.points,
        x1: geometry.x1,
        y1: geometry.y1,
        x2: geometry.x2,
        y2: geometry.y2,
      }];
    });
}
export const activeTabNetworkConnections = derived(appState, ($state) => buildRenderedNetworkConnections($state));
export const visibleActiveTabNetworkConnections = derived(
  [activeTabNetworkConnections, activeNetworkDrag, networkReleaseAnimation],
  ([$connections, $drag, $release]) => {
    const hidden = new Set<string>();
    if ($drag?.detachedConnectionKey) {
      hidden.add($drag.detachedConnectionKey);
    }
    if ($release?.connectionKey) {
      hidden.add($release.connectionKey);
    }
    if (hidden.size === 0) {
      return $connections;
    }
    return $connections.filter((connection) => !hidden.has(renderedNetworkConnectionKey(connection)));
  },
);

export function portModeForTile(tileId: string, port: TilePort): PortMode {
  const state = get(appState);
  const kind = tileKindForTileId(state, tileId);
  return portModeForTileKind(kind ?? 'shell', port);
}

export function portCanAcceptCurrentDrag(tileId: string, port: TilePort): boolean {
  const drag = get(activeNetworkDrag);
  if (!drag) {
    return true;
  }
  return canConnectPorts(get(appState), drag.tileId, drag.port, tileId, port, drag.detachedConnectionKey);
}

export function snapCurrentNetworkDragToPort(tileId: string, port: TilePort) {
  activeNetworkDrag.update((drag) => {
    if (!drag) {
      return drag;
    }

    const state = get(appState);
    if (!canConnectPorts(state, drag.tileId, drag.port, tileId, port, drag.detachedConnectionKey)) {
      return drag;
    }

    const rect = activeSessionTileRects(state).get(tileId);
    if (!rect) {
      return drag;
    }

    const snappedPoint = worldPointToViewport(state, portPointForTile(state, tileId, rect, port));
    return {
      ...drag,
      snappedTileId: tileId,
      snappedPort: port,
      snappedX: snappedPoint.x,
      snappedY: snappedPoint.y,
    };
  });
}

export function clearCurrentNetworkDragPortSnap(tileId: string, port: TilePort) {
  activeNetworkDrag.update((drag) => {
    if (!drag || drag.snappedTileId !== tileId || drag.snappedPort !== port) {
      return drag;
    }

    return {
      ...drag,
      snappedTileId: null,
      snappedPort: null,
      snappedX: null,
      snappedY: null,
    };
  });
}

export function portOccupied(tileId: string, port: TilePort): boolean {
  return connectionForPort(get(appState), tileId, port) !== null;
}

export function beginNetworkPortDrag(tileId: string, port: TilePort, startX: number, startY: number) {
  const state = get(appState);
  const existingConnection = connectionForPort(state, tileId, port);
  let anchorTileId = tileId;
  let anchorPort = port;
  let anchorX = startX;
  let anchorY = startY;
  let detachedConnectionKey: string | null = null;

  if (existingConnection) {
    const detachedEndpoint = oppositeConnectionEndpoint(existingConnection, tileId, port);
    if (detachedEndpoint) {
      anchorTileId = detachedEndpoint.tileId;
      anchorPort = detachedEndpoint.port;
      detachedConnectionKey = networkConnectionKey(existingConnection);
      const anchorRect = activeSessionTileRects(state).get(anchorTileId);
      if (anchorRect) {
        const anchorPoint = worldPointToViewport(state, portPointForTile(state, anchorTileId, anchorRect, anchorPort));
        anchorX = anchorPoint.x;
        anchorY = anchorPoint.y;
      }
    }
  }

  networkReleaseAnimation.set(null);
  activeNetworkDrag.set({
    tileId: anchorTileId,
    port: anchorPort,
    grabbedTileId: tileId,
    grabbedPort: port,
    startX: anchorX,
    startY: anchorY,
    currentX: startX,
    currentY: startY,
    startedOccupied: existingConnection !== null,
    detachedConnectionKey,
    snappedTileId: null,
    snappedPort: null,
    snappedX: null,
    snappedY: null,
  });
}

export function updateNetworkPortDrag(currentX: number, currentY: number) {
  activeNetworkDrag.update((drag) => {
    if (!drag) return drag;
    const next = { ...drag, currentX, currentY };
    return {
      ...next,
      ...snappedNetworkTarget(get(appState), next, currentX, currentY),
    };
  });
}

export async function disconnectTilePort(tileId: string, port: TilePort) {
  const removed = await disconnectNetworkPort(tileId, port);
  if (removed) {
    appState.update((state) => removeNetworkConnectionFromState(state, networkConnectionKey(removed)));
  }
  return removed;
}

export async function cancelNetworkPortDrag(disconnectOccupied = false) {
  const drag = get(activeNetworkDrag);
  activeNetworkDrag.set(null);
  if (disconnectOccupied && drag?.startedOccupied) {
    networkReleaseAnimation.set(buildNetworkReleaseAnimation(drag));
    await disconnectTilePort(drag.tileId, drag.port);
  }
}

export async function completeNetworkPortDrag(targetTileId?: string, targetPort?: TilePort) {
  const drag = get(activeNetworkDrag);
  activeNetworkDrag.set(null);
  if (!drag) return;

  const resolvedTargetTileId = targetTileId ?? drag.snappedTileId ?? null;
  const resolvedTargetPort = targetPort ?? drag.snappedPort ?? null;
  const state = get(appState);
  const validTarget =
    Boolean(resolvedTargetTileId)
    && Boolean(resolvedTargetPort)
    && !(drag.tileId === resolvedTargetTileId && drag.port === resolvedTargetPort)
    && canConnectPorts(
      state,
      drag.tileId,
      drag.port,
      resolvedTargetTileId as string,
      resolvedTargetPort as TilePort,
      drag.detachedConnectionKey,
    );

  if (!validTarget) {
    if (drag.startedOccupied) {
      networkReleaseAnimation.set(buildNetworkReleaseAnimation(drag));
      try {
        await disconnectTilePort(drag.tileId, drag.port);
      } catch (error) {
        networkReleaseAnimation.set(null);
        console.error('network detach failed:', error);
      }
    }
    return;
  }

  try {
    if (drag.startedOccupied) {
      await disconnectTilePort(drag.tileId, drag.port);
    }
    networkReleaseAnimation.set(null);
    const connection = await connectNetworkTiles(
      drag.tileId,
      drag.port,
      resolvedTargetTileId as string,
      resolvedTargetPort as TilePort,
    );
    appState.update((nextState) => upsertNetworkConnectionInState(nextState, connection));
  } catch (error) {
    console.error('network drag failed:', error);
  }
}

export const tileActivityById = derived(appState, ($state) => {
  const record: Record<string, TileActivityEntry[]> = {};
  for (const windowId of $state.tmux.windowOrder) {
    const paneId = $state.tmux.windows[windowId]?.pane_ids[0];
    const terminal = paneId ? terminalInfoForPane($state, paneId) : null;
    if (!terminal) continue;
    const entries = buildTileActivityEntries($state, terminal.tileId);
    if (entries.length > 0) {
      record[terminal.tileId] = entries;
    }
  }
  for (const item of $state.work.order.map((workId) => $state.work.items[workId]).filter(Boolean) as WorkItem[]) {
    const entries = buildTileActivityEntries($state, item.tile_id);
    if (entries.length > 0) {
      record[item.tile_id] = entries;
    }
  }
  return record;
});

export const browserWebviewsSuspended = writable(false);

export function suspendBrowserWebviewsForMotion() {
  browserWebviewsSuspended.set(true);
  if (browserWebviewMotionSettleTimer !== null) {
    clearTimeout(browserWebviewMotionSettleTimer);
  }
  browserWebviewMotionSettleTimer = setTimeout(() => {
    browserWebviewMotionSettleTimer = null;
    browserWebviewsSuspended.set(false);
  }, BROWSER_WEBVIEW_MOTION_SETTLE_MS);
}

function activeViewportWidth(viewportWidth?: number): number {
  return viewportWidth ?? window.innerWidth;
}

function activeViewportHeight(viewportHeight?: number): number {
  return viewportHeight ?? (window.innerHeight - 54);
}

export function panCanvasBy(dx: number, dy: number) {
  suspendBrowserWebviewsForMotion();
  canvasState.update((state) => ({
    ...state,
    panX: state.panX + dx,
    panY: state.panY + dy,
  }));
}

export function clientDeltaToWorldDelta(dx: number, dy: number, zoom: number) {
  const safeZoom = Math.max(zoom, 0.01);
  return {
    dx: dx / safeZoom,
    dy: dy / safeZoom,
  };
}

export function zoomCanvasAtPoint(x: number, y: number, zoomFactor: number) {
  suspendBrowserWebviewsForMotion();
  canvasState.update((state) => {
    const newZoom = Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM, state.zoom * zoomFactor));
    const dx = x - state.panX;
    const dy = y - state.panY;
    const scale = newZoom / state.zoom;

    return {
      zoom: newZoom,
      panX: x - dx * scale,
      panY: y - dy * scale,
    };
  });
}

export function zoomCanvasAtViewportCenter(zoomFactor: number, viewportWidth?: number, viewportHeight?: number) {
  zoomCanvasAtPoint(
    activeViewportWidth(viewportWidth) / 2,
    activeViewportHeight(viewportHeight) / 2,
    zoomFactor,
  );
}

export function wheelCanvas(deltaY: number, clientX: number, clientY: number) {
  zoomCanvasAtPoint(clientX, clientY, deltaY > 0 ? 0.95 : 1.05);
}

export function fitCanvasToActiveTab(viewportWidth?: number, viewportHeight?: number) {
  suspendBrowserWebviewsForMotion();
  const list = get(activeTabVisibleTerminals);
  const workCards = get(activeTabVisibleWorkCards);
  if (list.length === 0 && workCards.length === 0) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const term of list) {
    minX = Math.min(minX, term.x);
    minY = Math.min(minY, term.y);
    maxX = Math.max(maxX, term.x + term.width);
    maxY = Math.max(maxY, term.y + term.height);
  }
  for (const card of workCards) {
    minX = Math.min(minX, card.x);
    minY = Math.min(minY, card.y);
    maxX = Math.max(maxX, card.x + card.width);
    maxY = Math.max(maxY, card.y + card.height);
  }

  const viewW = activeViewportWidth(viewportWidth);
  const viewH = activeViewportHeight(viewportHeight);
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const zoom = Math.min(viewW * 0.9 / contentW, viewH * 0.9 / contentH, 2);
  const panX = (viewW - contentW * zoom) / 2 - minX * zoom;
  const panY = (viewH - contentH * zoom) / 2 - minY * zoom;
  canvasState.set({ zoom, panX, panY });
}

export function zoomCanvasToTile(paneId: string, viewportWidth?: number, viewportHeight?: number) {
  const term = get(terminals).find((item) => item.id === paneId);
  if (!term) return;
  suspendBrowserWebviewsForMotion();
  const viewW = activeViewportWidth(viewportWidth);
  const viewH = activeViewportHeight(viewportHeight);
  const zoom = Math.min(viewW * 0.8 / term.width, viewH * 0.8 / term.height, 2);
  const panX = viewW / 2 - (term.x + term.width / 2) * zoom;
  const panY = viewH / 2 - (term.y + term.height / 2) * zoom;
  canvasState.set({ zoom, panX, panY });
}

function selectPaneInState(state: AppStateTree, paneId: string): AppStateTree {
  return {
    ...state,
    ui: {
      ...state.ui,
      selectedPaneId: paneId,
      selectedWorkId: null,
      sidebarSection: isAgentPaneSelected({
        ...state,
        ui: { ...state.ui, selectedPaneId: paneId, selectedWorkId: null },
      })
        ? 'agents'
        : 'tmux',
    },
  };
}

function selectWorkItemInState(state: AppStateTree, workId: string): AppStateTree {
  return {
    ...state,
    ui: {
      ...state.ui,
      selectedPaneId: null,
      selectedWorkId: selectedWorkIdForSession(state, workId, true),
      sidebarSection: 'work',
    },
  };
}

export function selectTile(paneId: string) {
  appState.update((state) => selectPaneInState(state, paneId));
}

export function selectWorkItem(workId: string) {
  appState.update((state) => selectWorkItemInState(state, workId));
}

export function togglePaneMinimized(paneId: string) {
  appState.update((state) => {
    const tileId = paneTileId(state, paneId);
    if (!tileId) {
      return state;
    }
    return setTileMinimizedInState(state, tileId, !isTileMinimizedInState(state, tileId));
  });
}

export function toggleWorkCardMinimized(workId: string) {
  appState.update((state) => {
    const tileId = workLayoutKey(state, workId);
    if (!tileId) {
      return state;
    }
    return setTileMinimizedInState(state, tileId, !isTileMinimizedInState(state, tileId));
  });
}

export function restoreMinimizedTile(tileId: string) {
  appState.update((state) => {
    const nextState = setTileMinimizedInState(state, tileId, false);
    const workItem = workItemForTileId(nextState, tileId);
    if (workItem) {
      return selectWorkItemInState(nextState, workItem.work_id);
    }
    const paneId = paneIdForTileId(nextState, tileId);
    if (paneId) {
      return selectPaneInState(nextState, paneId);
    }
    return nextState;
  });
}

export function selectAgentItem(agentId: string) {
  appState.update((state) => {
    const agent = state.agents[agentId];
    if (!agent) return state;
    const paneId = paneIdForTileId(state, agent.tile_id);
    if (!paneId) return state;
    return {
      ...state,
      ui: {
        ...state.ui,
        selectedPaneId: paneId,
        selectedWorkId: null,
        sidebarSection: 'agents',
      },
    };
  });
}

export async function moveSelectedTerminalBy(dx: number, dy: number) {
  await dispatchIntent({ type: 'move-selected-pane', dx, dy });
}

export async function dragTileBy(paneId: string, dx: number, dy: number, persist = true) {
  const term = get(terminals).find((item) => item.id === paneId);
  if (!term) return;
  selectedTerminalId.set(paneId);
  updateTerminal(paneId, { x: term.x + dx, y: term.y + dy });
  if (persist) {
    await persistPaneLayout(paneId);
  }
}

export async function resizeTileTo(
  paneId: string,
  width: number,
  height: number,
  persist = true,
  requestResize = true,
) {
  selectedTerminalId.set(paneId);
  updateTerminal(paneId, {
    width: Math.max(300, width),
    height: Math.max(200, height),
  });
  if (persist) {
    await persistPaneLayout(paneId);
  }
  await tick();
  const handle = paneDriverHandles.get(paneId);
  if (handle) {
    await handle.syncViewport(requestResize);
  }
}

function projectSidebarItems(state: AppStateTree): TestDriverProjection['sidebar']['items'] {
  return buildSidebarItems(state).map((item) => ({
    type: item.type === 'pane' ? 'tile' : item.type,
    label: item.label,
    indent: item.indent,
    sessionId: item.sessionId,
    windowId: item.windowId,
    tileId: item.paneId ? (paneTileId(state, item.paneId) ?? undefined) : undefined,
    command: item.command,
    dead: item.dead,
  }));
}

function projectClosePaneConfirmation(
  state: AppStateTree,
): TestDriverProjection['close_pane_confirmation'] {
  const confirmation = state.ui.closePaneConfirmation;
  if (!confirmation) {
    return null;
  }
  const tileId = paneTileId(state, confirmation.paneId);
  if (!tileId) {
    return null;
  }
  return {
    tileId,
    title: confirmation.title,
    message: confirmation.message,
    confirmLabel: confirmation.confirmLabel,
  };
}

function projectContextMenu(state: AppStateTree): TestDriverProjection['context_menu'] {
  if (!state.ui.contextMenu) {
    return null;
  }
  return {
    target: state.ui.contextMenu.target === 'pane' ? 'tile' : 'canvas',
    tile_id: state.ui.contextMenu.paneId ? paneTileId(state, state.ui.contextMenu.paneId) : null,
    client_x: state.ui.contextMenu.clientX,
    client_y: state.ui.contextMenu.clientY,
    world_x: state.ui.contextMenu.worldX,
    world_y: state.ui.contextMenu.worldY,
    claude_commands: state.ui.contextMenu.claudeCommands,
    claude_skills: state.ui.contextMenu.claudeSkills,
    loading_claude_commands: state.ui.contextMenu.loadingClaudeCommands,
    claude_commands_error: state.ui.contextMenu.claudeCommandsError,
    items: buildContextMenuItems(state),
  };
}

function projectTerminalInfo(terminal: TerminalInfo): TestDriverProjection['active_tab_terminals'][number] {
  return {
    id: terminal.tileId,
    windowId: terminal.windowId,
    parentWindowId: terminal.parentWindowId,
    parentWindowSource: terminal.parentWindowSource,
    sessionId: terminal.sessionId,
    tabId: terminal.tabId,
    x: terminal.x,
    y: terminal.y,
    width: terminal.width,
    height: terminal.height,
    title: terminal.title,
    command: terminal.command,
    readOnly: terminal.readOnly,
    kind: terminal.kind,
    agentId: terminal.agentId,
    minimized: terminal.minimized,
  };
}

export function buildTestDriverProjection(
  state: AppStateTree,
  status: TestDriverStatus,
): TestDriverProjection {
  return {
    mode: state.ui.mode,
    command_bar: {
      open: state.ui.commandBarOpen,
      text: state.ui.commandText,
    },
    help_open: state.ui.helpOpen,
    sidebar: {
      open: state.ui.sidebarOpen,
      section: state.ui.sidebarSection,
      selected_index: state.ui.sidebarSelectedIdx,
      items: projectSidebarItems(state),
    },
    close_tab_confirmation: state.ui.closeTabConfirmation,
    close_pane_confirmation: projectClosePaneConfirmation(state),
    context_menu: projectContextMenu(state),
    selected_tile_id: state.ui.selectedPaneId ? paneTileId(state, state.ui.selectedPaneId) : null,
    selected_work_id: state.ui.selectedWorkId,
    debug_tab: state.ui.debugTab,
    agents: Object.values(state.agents),
    channels: Object.values(state.channels),
    chatter: state.chatter,
    agent_logs: state.agentLogs,
    tile_message_logs: state.tileMessageLogs,
    tile_activity_by_id: Object.fromEntries(
      [
        ...state.tmux.windowOrder
          .map((windowId) => state.tmux.windows[windowId]?.pane_ids[0])
          .filter((paneId): paneId is string => Boolean(paneId))
          .map((paneId) => paneTileId(state, paneId))
          .filter((tileId): tileId is string => Boolean(tileId)),
        ...state.work.order
          .map((workId) => state.work.items[workId]?.tile_id)
          .filter((tileId): tileId is string => Boolean(tileId)),
      ]
        .map((tileId) => [tileId, buildTileActivityEntries(state, tileId)])
        .filter(([, entries]) => entries.length > 0),
    ),
    work_items: state.work.order
      .map((workId) => state.work.items[workId])
      .filter(
        (item): item is WorkItem =>
          Boolean(item) && (!state.tmux.activeSessionId || item.session_id === state.tmux.activeSessionId),
      ),
    canvas: state.ui.canvas,
    tabs: state.tmux.sessionOrder
      .map((id) => state.tmux.sessions[id])
      .filter(Boolean)
      .map((session) => ({
        id: session.id,
        name: session.name || 'Session',
      })),
    active_tab_id: state.tmux.activeSessionId,
    active_tab_terminals: state.tmux.windowOrder
      .filter((windowId) => state.tmux.windows[windowId]?.session_id === state.tmux.activeSessionId)
      .map((windowId) => {
        const paneId = state.tmux.windows[windowId]?.pane_ids[0];
        return paneId ? terminalInfoForPane(state, paneId) : null;
      })
      .filter((term): term is TerminalInfo => Boolean(term))
      .map((term) => projectTerminalInfo(term)),
    active_tab_connections: buildCanvasConnections(state).map((connection) => ({
      child_window_id: connection.childWindowId,
      parent_window_id: connection.parentWindowId,
      path: connection.path,
      points: connection.points.map((point) => ({ x: point.x, y: point.y })),
      x1: connection.x1,
      y1: connection.y1,
      x2: connection.x2,
      y2: connection.y2,
    })),
    active_tab_network_connections: state.network.connections.filter(
      (connection) => !state.tmux.activeSessionId || connection.session_id === state.tmux.activeSessionId,
    ),
    active_tab_work_cards: buildCanvasWorkCards(state),
    indicators: {
      tmux: status.tmux_server_alive,
      cc: status.control_client_alive,
      sock: true,
    },
  };
}

export function setCanvasState(value: CanvasState) {
  suspendBrowserWebviewsForMotion();
  canvasState.set(value);
}

export function openCanvasContextMenu(clientX: number, clientY: number) {
  appState.update((state) => openCanvasContextMenuInState(state, clientX, clientY));
}

export function openPaneContextMenu(paneId: string, clientX: number, clientY: number) {
  appState.update((state) => openPaneContextMenuInState(state, paneId, clientX, clientY));
  const state = get(appState);
  if (!isAgentPaneKind(paneKindForPane(state, paneId))) {
    return;
  }

  void getClaudeMenuDataForPane(paneId)
    .then((menu) => {
      appState.update((current) => {
        const contextMenu = current.ui.contextMenu;
        if (!contextMenu || contextMenu.target !== 'pane' || contextMenu.paneId !== paneId) {
          return current;
        }
        return {
          ...current,
          ui: {
            ...current.ui,
            contextMenu: {
              ...contextMenu,
              claudeCommands: menu.commands,
              claudeSkills: menu.skills,
              loadingClaudeCommands: false,
              claudeCommandsError: null,
            },
          },
        };
      });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      appState.update((current) => {
        const contextMenu = current.ui.contextMenu;
        if (!contextMenu || contextMenu.target !== 'pane' || contextMenu.paneId !== paneId) {
          return current;
        }
        return {
          ...current,
          ui: {
            ...current.ui,
            contextMenu: {
              ...contextMenu,
              claudeCommands: [],
              claudeSkills: [],
              loadingClaudeCommands: false,
              claudeCommandsError: message,
            },
          },
        };
      });
    });
}

export function dismissContextMenu() {
  appState.update((state) => dismissContextMenuInState(state));
}

export function updateCanvasState(fn: (current: CanvasState) => CanvasState) {
  suspendBrowserWebviewsForMotion();
  canvasState.update(fn);
}

export function setSelectedPane(paneId: string | null) {
  selectedTerminalId.set(paneId);
}

export function updatePaneLayout(paneId: string, updates: Partial<LayoutEntry>) {
  appState.update((state) => {
    const tileId = paneTileId(state, paneId);
    const entry = tileId ? state.layout.entries[tileId] : null;
    if (!tileId || !entry) return state;
    return {
      ...state,
      layout: {
        entries: {
          ...state.layout.entries,
          [tileId]: { ...entry, ...updates },
        },
      },
    };
  });
}

export function updateWorkCardLayout(workId: string, updates: Partial<LayoutEntry>) {
  appState.update((state) => {
    const entryId = workLayoutKey(state, workId);
    const entry = entryId ? state.layout.entries[entryId] : null;
    if (!entryId || !entry) return state;
    return {
      ...state,
      layout: {
        entries: {
          ...state.layout.entries,
          [entryId]: { ...entry, ...updates },
        },
      },
    };
  });
}

export async function applyRemoteLayoutEntry(
  entryId: string,
  entry: LayoutEntry,
  paneId?: string | null,
  requestResize = false,
) {
  appState.update((state) => ({
    ...state,
    layout: {
      entries: {
        ...state.layout.entries,
        [entryId]: entry,
      },
    },
  }));

  if (!requestResize || !paneId) {
    return;
  }

  await tick();
  const handle = paneDriverHandles.get(paneId);
  if (handle) {
    await handle.syncViewport(true);
  }
}

export async function persistPaneLayout(paneId: string) {
  const state = get(appState);
  const tileId = paneTileId(state, paneId);
  const entry = tileId ? state.layout.entries[tileId] : null;
  if (!tileId || !entry) return;
  await saveLayoutState(tileId, entry.x, entry.y, entry.width, entry.height);
}

export async function persistWorkCardLayout(workId: string) {
  const state = get(appState);
  const entryId = workLayoutKey(state, workId);
  const entry = entryId ? state.layout.entries[entryId] : null;
  if (!entryId || !entry) return;
  await saveLayoutState(entryId, entry.x, entry.y, entry.width, entry.height);
}

export async function dragWorkCardBy(workId: string, dx: number, dy: number, persist = true) {
  const state = get(appState);
  const entryId = workLayoutKey(state, workId);
  const entry = entryId ? state.layout.entries[entryId] : null;
  if (!entry) return;
  updateWorkCardLayout(workId, { x: entry.x + dx, y: entry.y + dy });
  if (persist) {
    await persistWorkCardLayout(workId);
  }
}

export async function deleteWorkCard(workId: string, sessionId: string) {
  await deleteWorkItemCommand(workId);
  appState.update((state) => {
    const tileId = state.work.items[workId]?.tile_id ?? null;
    const nextState = tileId ? setTileMinimizedInState(state, tileId, false) : state;
    return {
      ...nextState,
      layout: {
        entries: removeWorkLayoutEntry(nextState, nextState.layout.entries, workId),
      },
    };
  });
  await refreshWorkItems(sessionId);
}

export async function addTab(name?: string): Promise<Tab | null> {
  const sessionId = await newSession(name);
  return { id: sessionId, name: name || 'New Tab' };
}

export function removeTab(id: string) {
  void killSession(id);
}

export function nextTab() {
  void dispatchIntent({ type: 'select-next-tab' });
}

export function prevTab() {
  void dispatchIntent({ type: 'select-prev-tab' });
}

export function setSidebarSelection(index: number) {
  void dispatchIntent({ type: 'set-sidebar-selection', index });
}

export function moveSidebarSelection(delta: number) {
  void dispatchIntent({ type: 'move-sidebar-selection', delta });
}

export function setSidebarSection(section: SidebarSection) {
  void dispatchIntent({ type: 'set-sidebar-section', section });
}

export function moveSidebarSection(delta: number) {
  void dispatchIntent({ type: 'move-sidebar-section', delta });
}

export function openSidebar() {
  sidebarOpen.set(true);
}

export function closeSidebar() {
  sidebarOpen.set(false);
}

export function beginSidebarRename() {
  appState.update((state) => {
    const renameCommand = buildSidebarRenameCommand(state);
    if (!renameCommand) return state;
    return {
      ...state,
      ui: {
        ...state.ui,
        commandBarOpen: true,
        commandText: renameCommand,
      },
    };
  });
}

export async function reportPaneViewport(
  paneId: string,
  cols: number,
  rows: number,
  pixelWidth: number,
  pixelHeight: number,
  requestResize = false,
) {
  appState.update((state) => {
    const pane = state.tmux.panes[paneId];
    if (!pane || cols <= 0 || rows <= 0 || pixelWidth <= 0 || pixelHeight <= 0) {
      return state;
    }

    const nextState: AppStateTree = {
      ...state,
      ui: {
        ...state.ui,
        paneViewportHints: {
          ...state.ui.paneViewportHints,
          [paneId]: { cols, rows, pixelWidth, pixelHeight },
        },
      },
    };
    return nextState;
  });

  if (!requestResize) return;

  const nextState = get(appState);
  const pane = nextState.tmux.panes[paneId];
  if (!pane) return;
  const windowSize = calculateWindowSizeRequest(nextState, pane.window_id, paneId);
  if (!windowSize) return;
  const request = { windowId: pane.window_id, ...windowSize };
  const key = `${request.cols}x${request.rows}`;
  if (pendingWindowResizeRequests.get(request.windowId) === key) {
    return;
  }
  pendingWindowResizeRequests.set(request.windowId, key);
  await resizeWindow(request.windowId, request.cols, request.rows).catch(() => {
    pendingWindowResizeRequests.delete(request.windowId);
  });
}

export function removeTerminal(id: string) {
  selectedTerminalId.set(id);
  void dispatchIntent({ type: 'close-selected-pane' });
}

export function updateTerminal(id: string, updates: Partial<TerminalInfo>) {
  const layoutUpdates: Partial<LayoutEntry> = {};
  if (typeof updates.x === 'number') layoutUpdates.x = updates.x;
  if (typeof updates.y === 'number') layoutUpdates.y = updates.y;
  if (typeof updates.width === 'number') layoutUpdates.width = updates.width;
  if (typeof updates.height === 'number') layoutUpdates.height = updates.height;
  if (Object.keys(layoutUpdates).length > 0) {
    suspendBrowserWebviewsForMotion();
  }
  updatePaneLayout(id, layoutUpdates);
}

export function updateTerminalBySessionId(sessionId: string, updates: Partial<TerminalInfo>) {
  updateTerminal(sessionId, updates);
}

export function removeTerminalBySessionId(sessionId: string) {
  removeTerminal(sessionId);
}

export function selectNextTerminal() {
  const list = get(activeTabVisibleTerminals);
  if (list.length === 0) return;
  const currentId = get(selectedTerminalId);
  const index = list.findIndex((term) => term.id === currentId);
  const next = (index + 1) % list.length;
  selectedTerminalId.set(list[next].id);
}

export function selectPrevTerminal() {
  const list = get(activeTabVisibleTerminals);
  if (list.length === 0) return;
  const currentId = get(selectedTerminalId);
  const index = list.findIndex((term) => term.id === currentId);
  const prev = (index - 1 + list.length) % list.length;
  selectedTerminalId.set(list[prev].id);
}

export function selectDirectional(direction: 'h' | 'j' | 'k' | 'l') {
  const list = get(activeTabVisibleTerminals);
  if (list.length === 0) return;
  const currentId = get(selectedTerminalId);
  const current = list.find((term) => term.id === currentId);
  if (!current) {
    selectedTerminalId.set(list[0].id);
    return;
  }

  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  let best: TerminalInfo | null = null;
  let bestDistance = Infinity;

  for (const term of list) {
    if (term.id === current.id) continue;
    const tx = term.x + term.width / 2;
    const ty = term.y + term.height / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    let valid = false;
    switch (direction) {
      case 'h':
        valid = dx < -20;
        break;
      case 'j':
        valid = dy > 20;
        break;
      case 'k':
        valid = dy < -20;
        break;
      case 'l':
        valid = dx > 20;
        break;
    }
    if (!valid) continue;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = term;
    }
  }

  if (best) {
    selectedTerminalId.set(best.id);
  }
}

function spiralOffset(index: number): { col: number; row: number } {
  let x = 0;
  let y = 0;
  let dx = 1;
  let dy = 0;
  let segmentLength = 1;
  let segmentProgress = 0;
  let segmentTurns = 0;

  for (let step = 0; step <= index; step += 1) {
    x += dx;
    y += dy;
    segmentProgress += 1;
    if (segmentProgress === segmentLength) {
      segmentProgress = 0;
      const nextDx = -dy;
      const nextDy = dx;
      dx = nextDx;
      dy = nextDy;
      segmentTurns += 1;
      if (segmentTurns % 2 === 0) {
        segmentLength += 1;
      }
    }
  }

  return { col: x, row: y };
}

function circleRingPosition(index: number, total: number): { ring: number; slot: number; slots: number } {
  let remainingIndex = index;
  let remainingTotal = total;
  let ring = 1;

  while (remainingTotal > 0) {
    const capacity = ring * 6;
    const slots = Math.min(remainingTotal, capacity);
    if (remainingIndex < slots) {
      return { ring, slot: remainingIndex, slots };
    }
    remainingIndex -= slots;
    remainingTotal -= slots;
    ring += 1;
  }

  return { ring: 1, slot: 0, slots: 1 };
}

function radialPosition(
  anchor: LayoutEntry,
  width: number,
  height: number,
  angle: number,
  radiusX: number,
  radiusY: number,
): { x: number; y: number } {
  const anchorCenterX = anchor.x + anchor.width / 2;
  const anchorCenterY = anchor.y + anchor.height / 2;
  return {
    x: anchorCenterX + Math.cos(angle) * radiusX - width / 2,
    y: anchorCenterY + Math.sin(angle) * radiusY - height / 2,
  };
}

function arrangementOrder(windowIds: string[], anchorWindowId: string): string[] {
  return [anchorWindowId, ...windowIds.filter((windowId) => windowId !== anchorWindowId)];
}

function arrangedPositionForIndex(
  pattern: ArrangementMode,
  anchor: LayoutEntry,
  width: number,
  height: number,
  index: number,
  total: number,
): { x: number; y: number } {
  const anchorStepX = Math.max(anchor.width, width) + GAP;
  const anchorStepY = Math.max(anchor.height, height) + GAP;
  const radialStep = Math.max(
    anchorStepX,
    anchorStepY,
    Math.hypot((anchor.width + width) / 2 + GAP, (anchor.height + height) / 2 + GAP),
  );
  const step = index + 1;

  switch (pattern) {
    case 'stack-down':
      return {
        x: anchor.x,
        y: anchor.y + step * anchorStepY,
      };
    case 'stack-right':
      return {
        x: anchor.x + step * anchorStepX,
        y: anchor.y,
      };
    case 'spiral': {
      const { col, row } = spiralOffset(index);
      return {
        x: anchor.x + col * anchorStepX,
        y: anchor.y + row * anchorStepY,
      };
    }
    case 'circle': {
      const { ring, slot, slots } = circleRingPosition(index, total);
      const angle = -Math.PI / 2 + (slot * Math.PI * 2) / Math.max(slots, 1);
      return radialPosition(anchor, width, height, angle, radialStep * ring, radialStep * ring);
    }
    case 'snowflake': {
      const ring = Math.floor(index / 6) + 1;
      const spoke = index % 6;
      const angle = -Math.PI / 3 + spoke * (Math.PI / 3);
      return radialPosition(anchor, width, height, angle, radialStep * ring, radialStep * ring);
    }
    case 'elk':
      return {
        x: anchor.x,
        y: anchor.y,
      };
  }
}

function applyArrangementPattern(
  state: AppStateTree,
  sessionId: string,
  pattern: ArrangementMode,
): { state: AppStateTree; arrangedEntries: Record<string, LayoutEntry> } {
  const windowIds = state.tmux.sessions[sessionId]?.window_ids ?? [];
  if (windowIds.length === 0) {
    return { state, arrangedEntries: {} };
  }

  const selectedPaneId = state.ui.selectedPaneId;
  const selectedWindowId = selectedPaneId ? state.tmux.panes[selectedPaneId]?.window_id ?? null : null;
  const anchorWindowId = selectedWindowId && windowIds.includes(selectedWindowId)
    ? selectedWindowId
    : windowIds[0];
  const orderedWindowIds = arrangementOrder(windowIds, anchorWindowId);
  const anchorEntryId = windowTileId(state.tmux.windows[anchorWindowId]);
  if (!anchorEntryId) {
    return { state, arrangedEntries: {} };
  }
  const orderedEntryIds = orderedWindowIds
    .map((windowId) => windowTileId(state.tmux.windows[windowId]))
    .filter((entryId): entryId is string => Boolean(entryId));
  if (orderedEntryIds.length === 0) {
    return { state, arrangedEntries: {} };
  }
  const anchorEntry = state.layout.entries[anchorEntryId] ?? {
    x: 100,
    y: 100,
    width: DEFAULT_TILE_WIDTH,
    height: DEFAULT_TILE_HEIGHT,
  };

  const arrangedEntries: Record<string, LayoutEntry> = {};
  const entries = { ...state.layout.entries };
  arrangedEntries[anchorEntryId] = {
    ...anchorEntry,
    width: entries[anchorEntryId]?.width ?? anchorEntry.width,
    height: entries[anchorEntryId]?.height ?? anchorEntry.height,
  };
  entries[anchorEntryId] = arrangedEntries[anchorEntryId];

  const siblingCount = orderedEntryIds.length - 1;
  orderedEntryIds.slice(1).forEach((entryId, index) => {
    const width = entries[entryId]?.width ?? DEFAULT_TILE_WIDTH;
    const height = entries[entryId]?.height ?? DEFAULT_TILE_HEIGHT;
    const position = arrangedPositionForIndex(
      pattern,
      arrangedEntries[anchorEntryId],
      width,
      height,
      index,
      siblingCount,
    );
    arrangedEntries[entryId] = findOpenPosition(
      position.x,
      position.y,
      width,
      height,
      Object.keys(arrangedEntries),
      arrangedEntries,
    );
    entries[entryId] = arrangedEntries[entryId];
  });

  const nextPatternIndex = (arrangementIndex(pattern) + 1) % AUTO_ARRANGE_PATTERNS.length;
  return {
    state: {
      ...state,
      layout: { entries },
      ui: {
        ...state.ui,
        arrangementCycleBySession: {
          ...state.ui.arrangementCycleBySession,
          [sessionId]: nextPatternIndex,
        },
        arrangementModeBySession: {
          ...state.ui.arrangementModeBySession,
          [sessionId]: pattern,
        },
      },
    },
    arrangedEntries,
  };
}

export async function autoArrange(sessionId: string | null) {
  if (!sessionId) return;
  const state = get(appState);
  const pattern = nextArrangementPatternForSession(state, sessionId);
  const next = applyArrangementPattern(state, sessionId, pattern);
  if (Object.keys(next.arrangedEntries).length === 0) return;
  appState.set(next.state);

  await Promise.all(
    Object.entries(next.arrangedEntries).map(([entryId, entry]) =>
      saveLayoutState(entryId, entry.x, entry.y, entry.width, entry.height),
    ),
  );
}

export async function autoArrangeWithElk(sessionId: string | null) {
  if (!sessionId) return;
  const state = get(appState);
  const next = await applyElkArrangement(state, sessionId);
  if (Object.keys(next.arrangedEntries).length === 0) return;
  appState.set(next.state);

  await Promise.all(
    Object.entries(next.arrangedEntries).map(([entryId, entry]) =>
      saveLayoutState(entryId, entry.x, entry.y, entry.width, entry.height),
    ),
  );
}

export async function executeCommandBarCommand(command: string) {
  const action = parseCommandBarCommand(command);

  switch (action.type) {
    case 'intent':
      await dispatchIntent(action.intent);
      break;
    case 'new-tab':
      await addTab(action.name);
      break;
    case 'dm':
      await sendDirectMessageCommand(action.target, action.message);
      break;
    case 'cm':
      await sendPublicMessageCommand(action.message);
      break;
    case 'sudo':
      await sendRootMessageCommand(action.message);
      break;
    case 'close-all': {
      const list = get(activeTabTerminals);
      for (const term of list) {
        await killWindow(term.windowId);
      }
      break;
    }
    case 'zoom-selected': {
      await dispatchIntent({
        type: 'toggle-selected-zoom',
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight - 54,
      });
      break;
    }
    case 'fit-all': {
      fitCanvasToActiveTab(window.innerWidth, window.innerHeight - 54);
      break;
    }
    default:
      break;
  }
}

export function cancelCommandBar() {
  commandBarOpen.set(false);
  commandText.set('');
}

export async function submitCommandBar() {
  const command = get(commandText).trim();
  await executeCommandBarCommand(command);
  cancelCommandBar();
}

export function parseCommandBarCommand(command: string): CommandBarAction {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const verb = parts[0];
  const tail = parts.slice(1).join(' ');
  if (!verb) return { type: 'none' };

  switch (verb) {
    case 'sh':
    case 'shell':
    case 'new':
      return { type: 'intent', intent: { type: 'new-shell' } };
    case 'q':
    case 'close':
      return { type: 'intent', intent: { type: 'close-selected-pane' } };
    case 'qa':
    case 'closeall':
      return { type: 'close-all' };
    case 'rename':
      return tail ? { type: 'intent', intent: { type: 'rename-selected-pane', name: tail } } : { type: 'none' };
    case 'tabnew':
    case 'tn':
      return { type: 'new-tab', name: tail || undefined };
    case 'tabclose':
    case 'tc':
      return { type: 'intent', intent: { type: 'close-active-tab' } };
    case 'tabrename':
    case 'tr':
      return tail ? { type: 'intent', intent: { type: 'rename-active-tab', name: tail } } : { type: 'none' };
    case 'z':
    case 'zoom':
      return { type: 'zoom-selected' };
    case 'fit':
      return { type: 'fit-all' };
    case 'reset':
      return { type: 'intent', intent: { type: 'reset-canvas' } };
    case 'dm': {
      const target = parts[1];
      const message = parts.slice(2).join(' ');
      return target && message ? { type: 'dm', target, message } : { type: 'none' };
    }
    case 'cm':
      return tail ? { type: 'cm', message: tail } : { type: 'none' };
    case 'sudo':
      return tail ? { type: 'sudo', message: tail } : { type: 'none' };
    default:
      return { type: 'none' };
  }
}
