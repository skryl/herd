import { derived, get, writable, type Readable, type Writable } from 'svelte/store';
import {
  getLayoutState,
  getTmuxState,
  killSession,
  killPane,
  killWindow,
  newSession,
  newWindow,
  renameSession,
  renameWindow,
  resizeWindow,
  saveLayoutState,
  selectSession,
  selectWindow,
  setPaneTitle,
  writePane,
} from '../tauri';
import type {
  AppStateTree,
  CanvasState,
  CanvasZoomMode,
  HerdMode,
  LayoutEntry,
  LayoutStateMap,
  PaneViewportHint,
  PtyOutputEvent,
  SidebarTreeItem,
  Tab,
  TerminalInfo,
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

type TmuxEffect =
  | { type: 'new-session'; name?: string }
  | { type: 'new-window'; sessionId?: string | null }
  | { type: 'kill-session'; sessionId: string }
  | { type: 'kill-window'; windowId: string }
  | { type: 'select-session'; sessionId: string }
  | { type: 'select-window'; windowId: string }
  | { type: 'rename-session'; sessionId: string; name: string }
  | { type: 'rename-window'; windowId: string; name: string }
  | { type: 'write-pane'; paneId: string; data: string };

export type UiIntent =
  | { type: 'new-shell' }
  | { type: 'new-tab' }
  | { type: 'close-selected-pane' }
  | { type: 'close-active-tab' }
  | { type: 'select-session'; sessionId: string }
  | { type: 'select-next-tab' }
  | { type: 'select-prev-tab' }
  | { type: 'rename-active-tab'; name: string }
  | { type: 'rename-selected-pane'; name: string }
  | { type: 'toggle-sidebar' }
  | { type: 'set-sidebar-selection'; index: number }
  | { type: 'move-sidebar-selection'; delta: number }
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
  | { type: 'reset-canvas' };

export type CommandBarAction =
  | { type: 'intent'; intent: UiIntent }
  | { type: 'new-tab'; name?: string }
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
  sidebarSelectedIdx: 0,
  debugPaneOpen: false,
  selectedPaneId: null,
  paneViewportHints: {},
  canvas: {
    panX: 0,
    panY: 0,
    zoom: 1,
  },
  zoomBookmark: null,
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
  ui: initialUiState,
};

export const appState = writable<AppStateTree>(initialAppState);

function snapToGrid(value: number): number {
  return Math.round(value / GRID_SNAP) * GRID_SNAP;
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

  return {
    x,
    y: snapToGrid(desiredY + paneIds.length * (height + GAP)),
    width,
    height,
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
    ? Math.max(0.2, Math.min(viewportWidth / term.width, viewportHeight / term.height))
    : Math.max(0.2, Math.min(viewportWidth * 0.8 / term.width, viewportHeight * 0.8 / term.height, 2));
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

  for (const sessionId of state.tmux.sessionOrder) {
    const session = state.tmux.sessions[sessionId];
    if (!session) continue;
    items.push({
      type: 'session',
      label: session.name,
      indent: 0,
      sessionId,
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
        sessionId,
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
        sessionId,
        windowId,
        paneId,
        command: pane.command,
        dead: pane.dead,
      });
    }
  }

  return items;
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

function selectedSidebarItem(state: AppStateTree): SidebarTreeItem | null {
  const items = buildSidebarItems(state);
  return items[clampSidebarIndex(state, state.ui.sidebarSelectedIdx)] ?? null;
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

function reconcileLayoutEntries(
  previousEntries: Record<string, LayoutEntry>,
  sessions: Record<string, TmuxSession>,
): Record<string, LayoutEntry> {
  const nextEntries: Record<string, LayoutEntry> = {};

  for (const session of Object.values(sessions)) {
    for (const windowId of session.window_ids) {
      const existing = previousEntries[windowId];
      if (existing) {
        nextEntries[windowId] = existing;
        continue;
      }

      const offset = session.window_ids.indexOf(windowId) * 40;
      nextEntries[windowId] = findOpenPosition(
        100 + offset,
        100 + offset,
        DEFAULT_TILE_WIDTH,
        DEFAULT_TILE_HEIGHT,
        session.window_ids.filter((id) => id !== windowId),
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
    const entry = nextEntries[windowId];
    const hint = paneId ? paneViewportHints[paneId] : null;
    if (!paneId || !entry || !hint) continue;
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

    nextEntries[windowId] = {
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

export function applyTmuxSnapshotToState(
  previousState: AppStateTree,
  snapshot: TmuxSnapshot,
): AppStateTree {
  const { record: sessions, order: sessionOrder } = buildSessionsRecord(snapshot.sessions);
  const { record: windows, order: windowOrder } = buildWindowsRecord(snapshot.windows);
  const { panesRecord, paneOrderByWindow } = buildPanesRecord(snapshot.panes, previousState.tmux.panes);
  const layoutEntries = reconcileLayoutEntries(previousState.layout.entries, sessions);

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
  const snappedLayoutEntries = snapLayoutEntriesToTmux(layoutEntries, windows, paneViewportHints);

  const nextState: AppStateTree = {
    tmux: nextTmux,
    layout: {
      entries: snappedLayoutEntries,
    },
    ui: {
      ...previousState.ui,
      selectedPaneId,
      paneViewportHints,
      sidebarSelectedIdx: previousState.ui.sidebarSelectedIdx,
    },
  };
  nextState.ui.sidebarSelectedIdx = clampSidebarIndex(nextState, nextState.ui.sidebarSelectedIdx);
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

export function reduceIntent(
  state: AppStateTree,
  intent: UiIntent,
): { state: AppStateTree; effects: TmuxEffect[] } {
  switch (intent.type) {
    case 'new-shell':
      return state.tmux.activeSessionId
        ? { state, effects: [{ type: 'new-window', sessionId: state.tmux.activeSessionId }] }
        : { state, effects: [] };

    case 'new-tab':
      return { state, effects: [{ type: 'new-session' }] };

    case 'close-selected-pane': {
      const paneId = state.ui.selectedPaneId;
      const windowId = paneId ? state.tmux.panes[paneId]?.window_id : null;
      return windowId
        ? { state, effects: [{ type: 'kill-window', windowId }] }
        : { state, effects: [] };
    }

    case 'close-active-tab':
      return state.tmux.activeSessionId
        ? { state, effects: [{ type: 'kill-session', sessionId: state.tmux.activeSessionId }] }
        : { state, effects: [] };

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
            sidebarSelectedIdx: state.ui.sidebarOpen ? state.ui.sidebarSelectedIdx : sidebarAnchorIndex(state),
          },
        },
        effects: [],
      };

    case 'set-sidebar-selection': {
      const sidebarSelectedIdx = clampSidebarIndex(state, intent.index);
      const item = buildSidebarItems(state)[sidebarSelectedIdx];
      if (!item) {
        return {
          state: {
            ...state,
            ui: { ...state.ui, sidebarSelectedIdx },
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
              sidebarSelectedIdx,
              selectedPaneId: item.paneId,
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
              sidebarSelectedIdx,
              selectedPaneId,
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
              sidebarSelectedIdx,
              selectedPaneId: preferredPaneIdForSession(state, item.sessionId) ?? state.ui.selectedPaneId,
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

    case 'move-sidebar-selection':
      return reduceIntent(state, {
        type: 'set-sidebar-selection',
        index: state.ui.sidebarSelectedIdx + intent.delta,
      });

    case 'toggle-debug':
      return { state: { ...state, ui: { ...state.ui, debugPaneOpen: !state.ui.debugPaneOpen } }, effects: [] };

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
      const windowId = paneId ? state.tmux.panes[paneId]?.window_id : null;
      const entry = windowId ? state.layout.entries[windowId] : null;
      if (!paneId || !windowId || !entry) return { state, effects: [] };
      return {
        state: {
          ...state,
          layout: {
            entries: {
              ...state.layout.entries,
              [windowId]: {
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
  }
}

export async function dispatchIntent(intent: UiIntent) {
  const { state, effects } = reduceIntent(get(appState), intent);
  appState.set(state);
  for (const effect of effects) {
    await runEffect(effect);
  }
}

export async function bootstrapAppState() {
  const [layout, snapshot] = await Promise.all([getLayoutState(), getTmuxState()]);
  appState.update((state) => applyTmuxSnapshotToState({
    ...state,
    layout: { entries: layout },
  }, snapshot));
}

export function applyTmuxSnapshot(snapshot: TmuxSnapshot) {
  const previousState = get(appState);
  const nextState = applyTmuxSnapshotToState(previousState, snapshot);
  appState.set(nextState);

  const changedEntries = collectChangedLayoutEntries(previousState.layout.entries, nextState.layout.entries);
  for (const [windowId, entry] of changedEntries) {
    void saveLayoutState(windowId, entry.x, entry.y, entry.width, entry.height);
  }
}

export function applyPaneReadOnly(paneId: string, readOnly: boolean) {
  appState.update((state) => applyPaneReadOnlyToState(state, paneId, readOnly));
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

export const canvasState = createWritableSlice<CanvasState>(
  (state) => state.ui.canvas,
  (state, value) => ({ ...state, ui: { ...state.ui, canvas: value, zoomBookmark: null } }),
);

export const selectedTerminalId = createWritableSlice<string | null>(
  (state) => state.ui.selectedPaneId,
  (state, value) => ({ ...state, ui: { ...state.ui, selectedPaneId: value } }),
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

export const sidebarItems = derived(appState, ($state) => buildSidebarItems($state));

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

export function __resetWindowResizeTrackingForTest() {
  pendingWindowResizeRequests.clear();
}

function terminalInfoForPane(state: AppStateTree, paneId: string): TerminalInfo | null {
  const pane = state.tmux.panes[paneId];
  const window = pane ? state.tmux.windows[pane.window_id] : null;
  const entry = window ? state.layout.entries[window.id] : null;
  if (!pane || !window || !entry) return null;
  return {
    id: pane.id,
    paneId: pane.id,
    windowId: window.id,
    sessionId: pane.session_id,
    tabId: pane.session_id,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
    title: defaultWindowTitle(window, pane),
    command: pane.command,
    readOnly: pane.readOnly,
  };
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

export function setCanvasState(value: CanvasState) {
  canvasState.set(value);
}

export function updateCanvasState(fn: (current: CanvasState) => CanvasState) {
  canvasState.update(fn);
}

export function setSelectedPane(paneId: string | null) {
  selectedTerminalId.set(paneId);
}

export function updatePaneLayout(paneId: string, updates: Partial<LayoutEntry>) {
  appState.update((state) => {
    const windowId = state.tmux.panes[paneId]?.window_id;
    const entry = windowId ? state.layout.entries[windowId] : null;
    if (!windowId || !entry) return state;
    return {
      ...state,
      layout: {
        entries: {
          ...state.layout.entries,
          [windowId]: { ...entry, ...updates },
        },
      },
    };
  });
}

export async function persistPaneLayout(paneId: string) {
  const state = get(appState);
  const windowId = state.tmux.panes[paneId]?.window_id;
  const entry = windowId ? state.layout.entries[windowId] : null;
  if (!windowId || !entry) return;
  await saveLayoutState(windowId, entry.x, entry.y, entry.width, entry.height);
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
  void killPane(id);
}

export function updateTerminal(id: string, updates: Partial<TerminalInfo>) {
  const layoutUpdates: Partial<LayoutEntry> = {};
  if (typeof updates.x === 'number') layoutUpdates.x = updates.x;
  if (typeof updates.y === 'number') layoutUpdates.y = updates.y;
  if (typeof updates.width === 'number') layoutUpdates.width = updates.width;
  if (typeof updates.height === 'number') layoutUpdates.height = updates.height;
  updatePaneLayout(id, layoutUpdates);
}

export function updateTerminalBySessionId(sessionId: string, updates: Partial<TerminalInfo>) {
  updateTerminal(sessionId, updates);
}

export function removeTerminalBySessionId(sessionId: string) {
  removeTerminal(sessionId);
}

export function selectNextTerminal() {
  const list = get(activeTabTerminals);
  if (list.length === 0) return;
  const currentId = get(selectedTerminalId);
  const index = list.findIndex((term) => term.id === currentId);
  const next = (index + 1) % list.length;
  selectedTerminalId.set(list[next].id);
}

export function selectPrevTerminal() {
  const list = get(activeTabTerminals);
  if (list.length === 0) return;
  const currentId = get(selectedTerminalId);
  const index = list.findIndex((term) => term.id === currentId);
  const prev = (index - 1 + list.length) % list.length;
  selectedTerminalId.set(list[prev].id);
}

export function selectDirectional(direction: 'h' | 'j' | 'k' | 'l') {
  const list = get(activeTabTerminals);
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

export async function autoArrange(sessionId: string | null) {
  if (!sessionId) return;
  const state = get(appState);
  const windowIds = state.tmux.sessions[sessionId]?.window_ids ?? [];
  if (windowIds.length === 0) return;

  const cellW = DEFAULT_TILE_WIDTH;
  const cellH = DEFAULT_TILE_HEIGHT;
  const cols = Math.max(1, Math.floor(Math.sqrt(windowIds.length)));

  const arrangedEntries: Record<string, LayoutEntry> = {};

  appState.update((current) => {
    const entries = { ...current.layout.entries };
    windowIds.forEach((windowId, index) => {
      arrangedEntries[windowId] = {
        x: snapToGrid((index % cols) * (cellW + GAP)),
        y: snapToGrid(Math.floor(index / cols) * (cellH + GAP)),
        width: entries[windowId]?.width ?? cellW,
        height: entries[windowId]?.height ?? cellH,
      };
      entries[windowId] = arrangedEntries[windowId];
    });
    return {
      ...current,
      layout: { entries },
    };
  });

  await Promise.all(
    Object.entries(arrangedEntries).map(([windowId, entry]) =>
      saveLayoutState(windowId, entry.x, entry.y, entry.width, entry.height),
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
      const list = get(activeTabTerminals);
      if (list.length === 0) break;
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
      const viewW = window.innerWidth;
      const viewH = window.innerHeight - 54;
      const contentW = maxX - minX;
      const contentH = maxY - minY;
      const zoom = Math.min(viewW * 0.9 / contentW, viewH * 0.9 / contentH, 2);
      const panX = (viewW - contentW * zoom) / 2 - minX * zoom;
      const panY = (viewH - contentH * zoom) / 2 - minY * zoom;
      canvasState.set({ zoom, panX, panY });
      break;
    }
    default:
      break;
  }
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
    default:
      return { type: 'none' };
  }
}
