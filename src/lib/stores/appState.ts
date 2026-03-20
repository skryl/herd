import { tick } from 'svelte';
import { derived, get, writable, type Readable, type Writable } from 'svelte/store';
import {
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
  selectSession,
  selectWindow,
  setPaneTitle,
  writePane,
} from '../tauri';
import type {
  ArrangementMode,
  AppStateTree,
  CanvasState,
  CanvasZoomMode,
  ClaudeCommandDescriptor,
  CloseTabConfirmation,
  ContextMenuItem,
  ContextMenuState,
  HerdMode,
  LayoutEntry,
  LayoutStateMap,
  PendingSpawnPlacement,
  PaneViewportHint,
  PaneKind,
  PtyOutputEvent,
  SidebarTreeItem,
  Tab,
  TerminalInfo,
  TestDriverProjection,
  TestDriverStatus,
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
const AUTO_ARRANGE_PATTERNS: ArrangementMode[] = ['circle', 'snowflake', 'stack-down', 'stack-right', 'spiral'];

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
  | { type: 'confirm-close-active-tab' }
  | { type: 'cancel-close-active-tab' }
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
  arrangementCycleBySession: {},
  arrangementModeBySession: {},
  canvas: {
    panX: 0,
    panY: 0,
    zoom: 1,
  },
  zoomBookmark: null,
  closeTabConfirmation: null,
  contextMenu: null,
  pendingSpawnPlacement: null,
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
      role: existing[pane.id]?.role,
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

function paneKindForPane(state: AppStateTree, paneId: string): PaneKind {
  const pane = state.tmux.panes[paneId];
  const window = pane ? state.tmux.windows[pane.window_id] : null;
  if (!pane || !window) {
    return 'regular';
  }

  if (pane.role === 'claude' || pane.role === 'output') {
    return pane.role;
  }

  const titleSignals = [pane.title, window.name].join(' ');
  if (titleSignals.includes('Claude Code') || /\bclaude\b/i.test(pane.command)) {
    return 'claude';
  }

  return 'regular';
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
    loadingClaudeCommands: paneKindForPane(state, paneId) === 'claude',
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
    ];
  }

  if (!contextMenu.paneId) {
    return [];
  }

  const items: ContextMenuItem[] = [];

  if (paneKindForPane(state, contextMenu.paneId) === 'claude') {
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

  items.push({ id: 'close-shell', label: 'Close Shell', kind: 'action', disabled: false });

  if (paneKindForPane(state, contextMenu.paneId) === 'claude') {
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

  if (itemId === 'new-shell' && contextMenu.target === 'canvas') {
    const sessionId = state.tmux.activeSessionId;
    if (!sessionId || contextMenu.worldX === null || contextMenu.worldY === null) {
      return { state: dismissContextMenuInState(state), effects: [] };
    }
    const dismissedState = dismissContextMenuInState(state);
    return {
      state: {
        ...dismissedState,
        ui: {
          ...dismissedState.ui,
          pendingSpawnPlacement: {
            sessionId,
            worldX: contextMenu.worldX,
            worldY: contextMenu.worldY,
          },
        },
      },
      effects: [{ type: 'new-window', sessionId }],
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
): Record<string, LayoutEntry> {
  const nextEntries: Record<string, LayoutEntry> = {};

  for (const session of Object.values(sessions)) {
    for (const windowId of session.window_ids) {
      const existing = previousEntries[windowId];
      if (existing) {
        nextEntries[windowId] = existing;
        continue;
      }

      const parentWindowId = windows[windowId]?.parent_window_id ?? null;
      const parentEntry = parentWindowId ? nextEntries[parentWindowId] ?? previousEntries[parentWindowId] : null;
      if (parentEntry) {
        nextEntries[windowId] = findOpenPosition(
          parentEntry.x + parentEntry.width + GAP + GRID_SNAP,
          parentEntry.y,
          DEFAULT_TILE_WIDTH,
          DEFAULT_TILE_HEIGHT,
          session.window_ids.filter((id) => id !== windowId),
          nextEntries,
        );
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
  const nextEntries = { ...entries };
  const existing = nextEntries[targetWindowId];
  const width = existing?.width ?? DEFAULT_TILE_WIDTH;
  const height = existing?.height ?? DEFAULT_TILE_HEIGHT;
  nextEntries[targetWindowId] = {
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
  const layoutEntries = reconcileLayoutEntries(previousState.layout.entries, sessions, windows);

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
  const pendingPlacement = applyPendingSpawnPlacement(previousState, nextTmux, layoutEntries);
  const snappedLayoutEntries = snapLayoutEntriesToTmux(pendingPlacement.entries, windows, paneViewportHints);
  const closeTabConfirmation = previousState.ui.closeTabConfirmation
    ? buildCloseTabConfirmation(nextTmux, previousState.ui.closeTabConfirmation.sessionId)
    : null;

  let nextState: AppStateTree = {
    tmux: nextTmux,
    layout: {
      entries: snappedLayoutEntries,
    },
    ui: {
      ...previousState.ui,
      selectedPaneId,
      paneViewportHints,
      arrangementCycleBySession,
      arrangementModeBySession,
      closeTabConfirmation,
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
    nextState = applyArrangementPattern(nextState, sessionId, pattern).state;
  }
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

    case 'new-tab':
      return { state, effects: [{ type: 'new-session' }] };

    case 'close-selected-pane': {
      const paneId = state.ui.selectedPaneId;
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
            },
          },
          effects: [],
        };
      }
      return { state, effects: [{ type: 'kill-window', windowId }] };
    }

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

export async function selectContextMenuItem(itemId: string) {
  const { state, effects } = reduceContextMenuSelection(get(appState), itemId);
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

export function applyPaneRole(paneId: string, role: PaneKind) {
  appState.update((state) => applyPaneRoleToState(state, paneId, role));
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

export const closeTabConfirmation = createWritableSlice<CloseTabConfirmation | null>(
  (state) => state.ui.closeTabConfirmation,
  (state, value) => ({ ...state, ui: { ...state.ui, closeTabConfirmation: value } }),
);

export const contextMenuState = derived(appState, ($state) => $state.ui.contextMenu);

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

export const activeArrangementMode = derived(appState, ($state) => {
  const sessionId = $state.tmux.activeSessionId;
  return sessionId ? $state.ui.arrangementModeBySession[sessionId] ?? null : null;
});

export const sidebarItems = derived(appState, ($state) => buildSidebarItems($state));
export const contextMenuItems = derived(appState, ($state) => buildContextMenuItems($state));

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
  const entry = window ? state.layout.entries[window.id] : null;
  if (!pane || !window || !entry) return null;
  return {
    id: pane.id,
    paneId: pane.id,
    windowId: window.id,
    parentWindowId: window.parent_window_id ?? null,
    sessionId: pane.session_id,
    tabId: pane.session_id,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
    title: defaultWindowTitle(window, pane),
    command: pane.command,
    readOnly: pane.readOnly,
    kind: paneKindForPane(state, pane.id),
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

export interface CanvasConnection {
  childWindowId: string;
  parentWindowId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx1: number;
  cy1: number;
  cx2: number;
  cy2: number;
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
    if (term) {
      terminalsByWindowId.set(windowId, term);
    }
  }

  const connections: CanvasConnection[] = [];
  for (const child of terminalsByWindowId.values()) {
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

    const distance = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    const offset = Math.min(distance * 0.4, 80);
    let cx1 = x1;
    let cy1 = y1;
    let cx2 = x2;
    let cy2 = y2;

    if (Math.abs(dx) > Math.abs(dy)) {
      cx1 = x1 + (dx > 0 ? offset : -offset);
      cx2 = x2 + (dx > 0 ? -offset : offset);
    } else {
      cy1 = y1 + (dy > 0 ? offset : -offset);
      cy2 = y2 + (dy > 0 ? -offset : offset);
    }

    connections.push({
      childWindowId: child.windowId,
      parentWindowId,
      x1,
      y1,
      x2,
      y2,
      cx1,
      cy1,
      cx2,
      cy2,
    });
  }

  return connections;
}

export const activeTabConnections = derived(appState, ($state) => buildCanvasConnections($state));

function activeViewportWidth(viewportWidth?: number): number {
  return viewportWidth ?? window.innerWidth;
}

function activeViewportHeight(viewportHeight?: number): number {
  return viewportHeight ?? (window.innerHeight - 54);
}

export function panCanvasBy(dx: number, dy: number) {
  canvasState.update((state) => ({
    ...state,
    panX: state.panX + dx,
    panY: state.panY + dy,
  }));
}

export function zoomCanvasAtPoint(x: number, y: number, zoomFactor: number) {
  canvasState.update((state) => {
    const newZoom = Math.max(0.2, Math.min(3, state.zoom * zoomFactor));
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
  const list = get(activeTabTerminals);
  if (list.length === 0) return;

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
  const viewW = activeViewportWidth(viewportWidth);
  const viewH = activeViewportHeight(viewportHeight);
  const zoom = Math.min(viewW * 0.8 / term.width, viewH * 0.8 / term.height, 2);
  const panX = viewW / 2 - (term.x + term.width / 2) * zoom;
  const panY = viewH / 2 - (term.y + term.height / 2) * zoom;
  canvasState.set({ zoom, panX, panY });
}

export function selectTile(paneId: string) {
  selectedTerminalId.set(paneId);
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
      selected_index: state.ui.sidebarSelectedIdx,
      items: buildSidebarItems(state),
    },
    close_tab_confirmation: state.ui.closeTabConfirmation,
    context_menu: state.ui.contextMenu
      ? {
        target: state.ui.contextMenu.target,
        pane_id: state.ui.contextMenu.paneId,
        client_x: state.ui.contextMenu.clientX,
        client_y: state.ui.contextMenu.clientY,
        world_x: state.ui.contextMenu.worldX,
        world_y: state.ui.contextMenu.worldY,
        claude_commands: state.ui.contextMenu.claudeCommands,
        claude_skills: state.ui.contextMenu.claudeSkills,
        loading_claude_commands: state.ui.contextMenu.loadingClaudeCommands,
        claude_commands_error: state.ui.contextMenu.claudeCommandsError,
        items: buildContextMenuItems(state),
      }
      : null,
    selected_pane_id: state.ui.selectedPaneId,
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
      .filter((term): term is TerminalInfo => Boolean(term)),
    active_tab_connections: buildCanvasConnections(state).map((connection) => ({
      child_window_id: connection.childWindowId,
      parent_window_id: connection.parentWindowId,
      x1: connection.x1,
      y1: connection.y1,
      x2: connection.x2,
      y2: connection.y2,
      cx1: connection.cx1,
      cy1: connection.cy1,
      cx2: connection.cx2,
      cy2: connection.cy2,
    })),
    indicators: {
      tmux: status.tmux_server_alive,
      cc: status.control_client_alive,
      sock: true,
    },
  };
}

export function setCanvasState(value: CanvasState) {
  canvasState.set(value);
}

export function openCanvasContextMenu(clientX: number, clientY: number) {
  appState.update((state) => openCanvasContextMenuInState(state, clientX, clientY));
}

export function openPaneContextMenu(paneId: string, clientX: number, clientY: number) {
  appState.update((state) => openPaneContextMenuInState(state, paneId, clientX, clientY));
  const state = get(appState);
  if (paneKindForPane(state, paneId) !== 'claude') {
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
  const anchorEntry = state.layout.entries[anchorWindowId] ?? {
    x: 100,
    y: 100,
    width: DEFAULT_TILE_WIDTH,
    height: DEFAULT_TILE_HEIGHT,
  };

  const arrangedEntries: Record<string, LayoutEntry> = {};
  const entries = { ...state.layout.entries };
  arrangedEntries[anchorWindowId] = {
    ...anchorEntry,
    width: entries[anchorWindowId]?.width ?? anchorEntry.width,
    height: entries[anchorWindowId]?.height ?? anchorEntry.height,
  };
  entries[anchorWindowId] = arrangedEntries[anchorWindowId];

  const siblingCount = orderedWindowIds.length - 1;
  orderedWindowIds.slice(1).forEach((windowId, index) => {
    const width = entries[windowId]?.width ?? DEFAULT_TILE_WIDTH;
    const height = entries[windowId]?.height ?? DEFAULT_TILE_HEIGHT;
    const position = arrangedPositionForIndex(
      pattern,
      arrangedEntries[anchorWindowId],
      width,
      height,
      index,
      siblingCount,
    );
    arrangedEntries[windowId] = findOpenPosition(
      position.x,
      position.y,
      width,
      height,
      Object.keys(arrangedEntries),
      arrangedEntries,
    );
    entries[windowId] = arrangedEntries[windowId];
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
    Object.entries(next.arrangedEntries).map(([windowId, entry]) =>
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
    default:
      return { type: 'none' };
  }
}
