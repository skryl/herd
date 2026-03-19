import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStateTree, TmuxSnapshot } from '../types';

const tauriMocks = vi.hoisted(() => ({
  getLayoutState: vi.fn(),
  getTmuxState: vi.fn(),
  killPane: vi.fn(),
  killSession: vi.fn(),
  killWindow: vi.fn(),
  newSession: vi.fn(),
  newWindow: vi.fn(),
  renameSession: vi.fn(),
  renameWindow: vi.fn(),
  resizeWindow: vi.fn(),
  saveLayoutState: vi.fn(),
  selectSession: vi.fn(),
  selectWindow: vi.fn(),
  setPaneTitle: vi.fn(),
  writePane: vi.fn(),
}));

vi.mock('../tauri', () => tauriMocks);

import {
  __resetWindowResizeTrackingForTest,
  applyPaneReadOnlyToState,
  applyTmuxSnapshot,
  applyTmuxSnapshotToState,
  appState,
  autoArrange,
  beginSidebarRename,
  buildCanvasConnections,
  buildSidebarItems,
  buildSidebarRenameCommand,
  calculateWindowSizeRequest,
  initialAppState,
  parseCommandBarCommand,
  reportPaneViewport,
  reduceIntent,
} from './appState';

function freshState(): AppStateTree {
  return JSON.parse(JSON.stringify(initialAppState)) as AppStateTree;
}

function baseSnapshot(): TmuxSnapshot {
  return {
    version: 1,
    server_name: 'herd',
    active_session_id: '$1',
    active_window_id: '@1',
    active_pane_id: '%1',
    sessions: [
      { id: '$1', name: 'Main', active: true, window_ids: ['@1', '@2'], active_window_id: '@1' },
      { id: '$2', name: 'Build', active: false, window_ids: ['@3'], active_window_id: '@3' },
    ],
    windows: [
      { id: '@1', session_id: '$1', session_name: 'Main', index: 0, name: 'shell', active: true, cols: 80, rows: 24, pane_ids: ['%1'] },
      { id: '@2', session_id: '$1', session_name: 'Main', index: 1, name: 'logs', active: false, cols: 90, rows: 28, pane_ids: ['%2'] },
      { id: '@3', session_id: '$2', session_name: 'Build', index: 0, name: 'build', active: true, cols: 100, rows: 30, pane_ids: ['%3'] },
    ],
    panes: [
      { id: '%1', session_id: '$1', window_id: '@1', window_index: 0, pane_index: 0, cols: 80, rows: 24, title: 'shell', command: 'zsh', active: true, dead: false },
      { id: '%2', session_id: '$1', window_id: '@2', window_index: 1, pane_index: 0, cols: 90, rows: 28, title: 'logs', command: 'tail', active: false, dead: false },
      { id: '%3', session_id: '$2', window_id: '@3', window_index: 0, pane_index: 0, cols: 100, rows: 30, title: 'build', command: 'npm', active: true, dead: false },
    ],
  };
}

function snapshotWithMainWindowCount(count: number): TmuxSnapshot {
  const snapshot = baseSnapshot();
  if (count <= 2) return snapshot;

  const extraWindowIds: string[] = [];
  const extraWindows = [];
  const extraPanes = [];

  for (let offset = 0; offset < count - 2; offset += 1) {
    const windowNumber = offset + 4;
    const paneNumber = offset + 4;
    const windowId = `@${windowNumber}`;
    const paneId = `%${paneNumber}`;
    extraWindowIds.push(windowId);
    extraWindows.push({
      id: windowId,
      session_id: '$1',
      session_name: 'Main',
      index: offset + 2,
      name: `shell-${offset + 3}`,
      active: false,
      cols: 80,
      rows: 24,
      pane_ids: [paneId],
    });
    extraPanes.push({
      id: paneId,
      session_id: '$1',
      window_id: windowId,
      window_index: offset + 2,
      pane_index: 0,
      cols: 80,
      rows: 24,
      title: `shell-${offset + 3}`,
      command: 'zsh',
      active: false,
      dead: false,
    });
  }

  return {
    ...snapshot,
    sessions: [
      {
        ...snapshot.sessions[0],
        window_ids: ['@1', '@2', ...extraWindowIds],
      },
      snapshot.sessions[1],
    ],
    windows: [...snapshot.windows, ...extraWindows],
    panes: [...snapshot.panes, ...extraPanes],
  };
}

beforeEach(() => {
  appState.set(freshState());
  __resetWindowResizeTrackingForTest();
  Object.values(tauriMocks).forEach((mockFn) => mockFn.mockReset());
  tauriMocks.resizeWindow.mockResolvedValue(undefined);
});

describe('applyTmuxSnapshotToState', () => {
  it('hydrates tmux sessions, windows, and tile layout from the snapshot', () => {
    const next = applyTmuxSnapshotToState(freshState(), baseSnapshot());

    expect(next.tmux.serverName).toBe('herd');
    expect(next.tmux.activeSessionId).toBe('$1');
    expect(next.tmux.activeWindowId).toBe('@1');
    expect(next.tmux.activePaneId).toBe('%1');
    expect(next.tmux.sessionOrder).toEqual(['$1', '$2']);
    expect(next.tmux.windowOrder).toEqual(['@1', '@2', '@3']);
    expect(next.ui.selectedPaneId).toBe('%1');
    expect(Object.keys(next.layout.entries)).toEqual(['@1', '@2', '@3']);
  });

  it('drops stale layout entries and preserves read-only pane metadata', () => {
    const withSnapshot = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    withSnapshot.layout.entries['@1'] = { x: 10, y: 20, width: 500, height: 300 };
    withSnapshot.layout.entries['@9'] = { x: 1, y: 1, width: 1, height: 1 };
    const readOnlyState = applyPaneReadOnlyToState(withSnapshot, '%2', true);

    const next = applyTmuxSnapshotToState(readOnlyState, {
      ...baseSnapshot(),
      version: 2,
      sessions: [
        { id: '$1', name: 'Main', active: true, window_ids: ['@1'], active_window_id: '@1' },
      ],
      windows: [
        { id: '@1', session_id: '$1', session_name: 'Main', index: 0, name: 'shell', active: true, cols: 80, rows: 24, pane_ids: ['%1'] },
      ],
      panes: [baseSnapshot().panes[0]],
      active_session_id: '$1',
      active_window_id: '@1',
      active_pane_id: '%1',
    });

    expect(next.layout.entries['@1']).toEqual({ x: 10, y: 20, width: 500, height: 300 });
    expect(next.layout.entries['@9']).toBeUndefined();
    expect(next.tmux.panes['%2']).toBeUndefined();
  });

  it('preserves tile layout entries when switching tabs between sessions', () => {
    const initial = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    initial.layout.entries['@1'] = { x: 10, y: 20, width: 500, height: 300 };
    initial.layout.entries['@3'] = { x: 700, y: 40, width: 640, height: 400 };

    const switched = applyTmuxSnapshotToState(initial, {
      ...baseSnapshot(),
      version: 2,
      active_session_id: '$2',
      active_window_id: '@3',
      active_pane_id: '%3',
      sessions: [
        { id: '$1', name: 'Main', active: false, window_ids: ['@1', '@2'], active_window_id: '@1' },
        { id: '$2', name: 'Build', active: true, window_ids: ['@3'], active_window_id: '@3' },
      ],
      windows: [
        { ...baseSnapshot().windows[0], active: true },
        { ...baseSnapshot().windows[1], active: false },
        { ...baseSnapshot().windows[2], active: true },
      ],
      panes: [
        { ...baseSnapshot().panes[0], active: true },
        { ...baseSnapshot().panes[1], active: false },
        { ...baseSnapshot().panes[2], active: true },
      ],
    });

    expect(switched.layout.entries['@1']).toEqual({ x: 10, y: 20, width: 500, height: 300 });
    expect(switched.layout.entries['@3']).toEqual({ x: 700, y: 40, width: 640, height: 400 });
    expect(switched.tmux.activeSessionId).toBe('$2');
    expect(switched.ui.selectedPaneId).toBe('%3');
  });

  it('places new child windows next to their parent window', () => {
    const next = applyTmuxSnapshotToState(freshState(), {
      ...baseSnapshot(),
      version: 2,
      sessions: [
        { id: '$1', name: 'Main', active: true, window_ids: ['@1', '@2', '@4'], active_window_id: '@1' },
        { id: '$2', name: 'Build', active: false, window_ids: ['@3'], active_window_id: '@3' },
      ],
      windows: [
        { ...baseSnapshot().windows[0] },
        { ...baseSnapshot().windows[1] },
        { ...baseSnapshot().windows[2] },
        {
          id: '@4',
          session_id: '$1',
          session_name: 'Main',
          index: 2,
          name: 'agent',
          active: false,
          cols: 80,
          rows: 24,
          pane_ids: ['%4'],
          parent_window_id: '@1',
        },
      ],
      panes: [
        ...baseSnapshot().panes,
        {
          id: '%4',
          session_id: '$1',
          window_id: '@4',
          window_index: 2,
          pane_index: 0,
          cols: 80,
          rows: 24,
          title: 'agent',
          command: 'claude',
          active: false,
          dead: false,
        },
      ],
    });

    expect(next.layout.entries['@4'].x).toBeGreaterThan(next.layout.entries['@1'].x + next.layout.entries['@1'].width);
    expect(Math.abs(next.layout.entries['@4'].y - next.layout.entries['@1'].y)).toBeLessThanOrEqual(60);
  });
});

describe('reduceIntent', () => {
  it('maps new shell controls to tmux window creation in the active session', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const result = reduceIntent(state, { type: 'new-shell' });
    expect(result.effects).toEqual([{ type: 'new-window', sessionId: '$1' }]);
  });

  it('maps new tab controls to tmux session creation', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const result = reduceIntent(state, { type: 'new-tab' });
    expect(result.effects).toEqual([{ type: 'new-session' }]);
  });

  it('maps close tile control to a tmux kill effect when other windows remain', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    expect(reduceIntent(state, { type: 'close-selected-pane' }).effects).toEqual([
      { type: 'kill-window', windowId: '@1' },
    ]);
  });

  it('requests confirmation before closing the last window because it would kill the session', () => {
    const state = applyTmuxSnapshotToState(freshState(), {
      ...baseSnapshot(),
      version: 2,
      active_session_id: '$2',
      active_window_id: '@3',
      active_pane_id: '%3',
      sessions: [
        { id: '$1', name: 'Main', active: false, window_ids: ['@1', '@2'], active_window_id: '@1' },
        { id: '$2', name: 'Build', active: true, window_ids: ['@3'], active_window_id: '@3' },
      ],
    });

    const closePane = reduceIntent(state, { type: 'close-selected-pane' });
    expect(closePane.effects).toEqual([]);
    expect(closePane.state.ui.closeTabConfirmation).toEqual({
      sessionId: '$2',
      sessionName: 'Build',
      paneCount: 1,
    });
  });

  it('requests confirmation for multi-pane tab closes', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const closeTab = reduceIntent(state, { type: 'close-active-tab' });
    expect(closeTab.effects).toEqual([]);
    expect(closeTab.state.ui.closeTabConfirmation).toEqual({
      sessionId: '$1',
      sessionName: 'Main',
      paneCount: 2,
    });
  });

  it('kills the active tab immediately when only one pane would be removed', () => {
    const state = applyTmuxSnapshotToState(freshState(), {
      ...baseSnapshot(),
      version: 2,
      active_session_id: '$2',
      active_window_id: '@3',
      active_pane_id: '%3',
      sessions: [
        { id: '$1', name: 'Main', active: false, window_ids: ['@1', '@2'], active_window_id: '@1' },
        { id: '$2', name: 'Build', active: true, window_ids: ['@3'], active_window_id: '@3' },
      ],
    });

    const closeTab = reduceIntent(state, { type: 'close-active-tab' });
    expect(closeTab.effects).toEqual([{ type: 'kill-session', sessionId: '$2' }]);
    expect(closeTab.state.ui.closeTabConfirmation).toBeNull();
  });

  it('confirms and cancels pending tab closes through ui state', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const requested = reduceIntent(state, { type: 'close-active-tab' }).state;

    const cancelled = reduceIntent(requested, { type: 'cancel-close-active-tab' });
    expect(cancelled.effects).toEqual([]);
    expect(cancelled.state.ui.closeTabConfirmation).toBeNull();

    const confirmed = reduceIntent(requested, { type: 'confirm-close-active-tab' });
    expect(confirmed.effects).toEqual([{ type: 'kill-session', sessionId: '$1' }]);
    expect(confirmed.state.ui.closeTabConfirmation).toBeNull();
  });

  it('maps next and previous tab controls to tmux session selection', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    expect(reduceIntent(state, { type: 'select-next-tab' }).effects).toEqual([
      { type: 'select-session', sessionId: '$2' },
    ]);
    expect(reduceIntent(state, { type: 'select-prev-tab' }).effects).toEqual([
      { type: 'select-session', sessionId: '$2' },
    ]);
  });

  it('updates local ui state for overlays and mode changes', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = reduceIntent(state, { type: 'toggle-sidebar' }).state;
    state = reduceIntent(state, { type: 'toggle-debug' }).state;
    state = reduceIntent(state, { type: 'open-command-bar' }).state;
    state = reduceIntent(state, { type: 'open-help' }).state;
    state = reduceIntent(state, { type: 'enter-input-mode' }).state;

    expect(state.ui.sidebarOpen).toBe(true);
    expect(state.ui.debugPaneOpen).toBe(true);
    expect(state.ui.commandBarOpen).toBe(true);
    expect(state.ui.helpOpen).toBe(true);
    expect(state.ui.mode).toBe('input');

    state = reduceIntent(state, { type: 'exit-input-mode' }).state;
    expect(state.ui.mode).toBe('command');
  });

  it('maps typed input to a pane write effect and keeps move/reset local', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const send = reduceIntent(state, { type: 'send-input', data: 'ls\r' });
    expect(send.effects).toEqual([{ type: 'write-pane', paneId: '%1', data: 'ls\r' }]);

    state = reduceIntent(state, { type: 'move-selected-pane', dx: 25, dy: 15 }).state;
    expect(state.layout.entries['@1'].x).toBeGreaterThan(0);
    expect(state.layout.entries['@1'].y).toBeGreaterThan(0);

    state.ui.canvas = { panX: 100, panY: 200, zoom: 2 };
    state = reduceIntent(state, { type: 'reset-canvas' }).state;
    expect(state.ui.canvas).toEqual({ panX: 0, panY: 0, zoom: 1 });
    expect(state.ui.zoomBookmark).toBeNull();
  });

  it('toggles focused zoom for the selected pane and restores the prior canvas', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.ui.canvas = { panX: 33, panY: 44, zoom: 0.75 };

    state = reduceIntent(state, {
      type: 'toggle-selected-zoom',
      viewportWidth: 1000,
      viewportHeight: 600,
    }).state;

    expect(state.ui.zoomBookmark).toEqual({
      mode: 'focused',
      paneId: '%1',
      previousCanvas: { panX: 33, panY: 44, zoom: 0.75 },
    });
    expect(state.ui.canvas.zoom).toBeCloseTo(1.2);
    expect(state.ui.canvas.panX).toBeCloseTo(-4);
    expect(state.ui.canvas.panY).toBeCloseTo(-60);

    state = reduceIntent(state, {
      type: 'toggle-selected-zoom',
      viewportWidth: 1000,
      viewportHeight: 600,
    }).state;

    expect(state.ui.canvas).toEqual({ panX: 33, panY: 44, zoom: 0.75 });
    expect(state.ui.zoomBookmark).toBeNull();
  });

  it('toggles fullscreen zoom and keeps the original canvas bookmark when switching zoom modes', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.ui.canvas = { panX: 12, panY: 24, zoom: 0.9 };

    state = reduceIntent(state, {
      type: 'toggle-selected-zoom',
      viewportWidth: 1000,
      viewportHeight: 600,
    }).state;

    state = reduceIntent(state, {
      type: 'toggle-selected-fullscreen-zoom',
      viewportWidth: 1000,
      viewportHeight: 600,
    }).state;

    expect(state.ui.zoomBookmark).toEqual({
      mode: 'fullscreen',
      paneId: '%1',
      previousCanvas: { panX: 12, panY: 24, zoom: 0.9 },
    });
    expect(state.ui.canvas.zoom).toBeCloseTo(1.5);
    expect(state.ui.canvas.panX).toBeCloseTo(-130);
    expect(state.ui.canvas.panY).toBeCloseTo(-150);

    state = reduceIntent(state, {
      type: 'toggle-selected-fullscreen-zoom',
      viewportWidth: 1000,
      viewportHeight: 600,
    }).state;

    expect(state.ui.canvas).toEqual({ panX: 12, panY: 24, zoom: 0.9 });
    expect(state.ui.zoomBookmark).toBeNull();
  });

  it('maps rename controls to session and window naming effects', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    expect(reduceIntent(state, { type: 'rename-selected-pane', name: 'server' }).effects).toEqual([
      { type: 'rename-window', windowId: '@1', name: 'server' },
    ]);
    expect(reduceIntent(state, { type: 'rename-active-tab', name: 'Ops' }).effects).toEqual([
      { type: 'rename-session', sessionId: '$1', name: 'Ops' },
    ]);
  });

  it('switches tabs and focuses the tile when tree navigation lands on another pane', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const paneIndex = buildSidebarItems(state).findIndex((item) => item.paneId === '%3');
    const result = reduceIntent(state, { type: 'set-sidebar-selection', index: paneIndex });

    expect(result.state.ui.sidebarSelectedIdx).toBe(paneIndex);
    expect(result.state.ui.selectedPaneId).toBe('%3');
    expect(result.effects).toEqual([
      { type: 'select-session', sessionId: '$2' },
      { type: 'select-window', windowId: '@3' },
    ]);
  });

  it('switches tabs when tree navigation lands on another session', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const sessionIndex = buildSidebarItems(state).findIndex((item) => item.type === 'session' && item.sessionId === '$2');
    const result = reduceIntent(state, { type: 'set-sidebar-selection', index: sessionIndex });

    expect(result.state.ui.selectedPaneId).toBe('%3');
    expect(result.effects).toEqual([{ type: 'select-session', sessionId: '$2' }]);
  });
});

describe('buildCanvasConnections', () => {
  it('builds a connection line for parent-child windows in the active tab', () => {
    const state = applyTmuxSnapshotToState(freshState(), {
      ...baseSnapshot(),
      windows: [
        { ...baseSnapshot().windows[0] },
        { ...baseSnapshot().windows[1], parent_window_id: '@1' },
        { ...baseSnapshot().windows[2] },
      ],
    });

    const connections = buildCanvasConnections(state);
    expect(connections).toHaveLength(1);
    expect(connections[0].parentWindowId).toBe('@1');
    expect(connections[0].childWindowId).toBe('@2');
  });
});

describe('parseCommandBarCommand', () => {
  it('maps shell, close, and closeall command bar verbs', () => {
    expect(parseCommandBarCommand('sh')).toEqual({ type: 'intent', intent: { type: 'new-shell' } });
    expect(parseCommandBarCommand('close')).toEqual({ type: 'intent', intent: { type: 'close-selected-pane' } });
    expect(parseCommandBarCommand('qa')).toEqual({ type: 'close-all' });
  });

  it('maps tab command bar verbs', () => {
    expect(parseCommandBarCommand('tn')).toEqual({ type: 'new-tab', name: undefined });
    expect(parseCommandBarCommand('tabnew Build')).toEqual({ type: 'new-tab', name: 'Build' });
    expect(parseCommandBarCommand('tc')).toEqual({ type: 'intent', intent: { type: 'close-active-tab' } });
    expect(parseCommandBarCommand('tr Ops')).toEqual({
      type: 'intent',
      intent: { type: 'rename-active-tab', name: 'Ops' },
    });
  });
});

describe('autoArrange', () => {
  it('anchors the first arrangement on the selected tile and persists the new layout', async () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries['@1'] = { x: 100, y: 100, width: 640, height: 400 };
    state.layout.entries['@2'] = { x: 880, y: 60, width: 640, height: 400 };
    state.ui.selectedPaneId = '%1';
    appState.set(state);

    await autoArrange('$1');

    const next = get(appState);
    expect(next.layout.entries['@1']).toEqual({ x: 100, y: 100, width: 640, height: 400 });
    expect(next.layout.entries['@2']).toEqual({ x: 100, y: 540, width: 640, height: 400 });
    expect(tauriMocks.saveLayoutState).toHaveBeenCalledTimes(2);
    expect(tauriMocks.saveLayoutState).toHaveBeenNthCalledWith(1, '@1', 100, 100, 640, 400);
    expect(tauriMocks.saveLayoutState).toHaveBeenNthCalledWith(2, '@2', 100, 540, 640, 400);
  });

  it('cycles through different arrangements on repeated calls', async () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries['@1'] = { x: 100, y: 100, width: 640, height: 400 };
    state.layout.entries['@2'] = { x: 880, y: 60, width: 640, height: 400 };
    state.ui.selectedPaneId = '%1';
    appState.set(state);

    await autoArrange('$1');
    const first = get(appState).layout.entries['@2'];

    await autoArrange('$1');
    const second = get(appState).layout.entries['@2'];

    await autoArrange('$1');
    const third = get(appState).layout.entries['@2'];

    expect(first).toEqual({ x: 100, y: 540, width: 640, height: 400 });
    expect(second).toEqual({ x: 780, y: 100, width: 640, height: 400 });
    expect(third).toEqual({ x: 560, y: 260, width: 640, height: 400 });
  });

  it('adds circle and snowflake radial arrangements around the selected tile', async () => {
    const state = applyTmuxSnapshotToState(freshState(), snapshotWithMainWindowCount(7));
    for (const windowId of state.tmux.sessions['$1'].window_ids) {
      state.layout.entries[windowId] = { x: 100, y: 100, width: 640, height: 400 };
    }
    state.ui.selectedPaneId = '%1';
    appState.set(state);

    await autoArrange('$1');
    await autoArrange('$1');
    await autoArrange('$1');
    await autoArrange('$1');
    const spiral = get(appState).layout.entries;

    await autoArrange('$1');
    const circle = get(appState).layout.entries;

    await autoArrange('$1');
    const snowflake = get(appState).layout.entries;

    expect(spiral['@1']).toEqual({ x: 100, y: 100, width: 640, height: 400 });
    expect(spiral['@2']).toEqual({ x: 780, y: 100, width: 640, height: 400 });
    expect(spiral['@4']).toEqual({ x: 780, y: 540, width: 640, height: 400 });

    expect(circle['@1']).toEqual({ x: 100, y: 100, width: 640, height: 400 });
    expect(circle['@2']).toEqual({ x: 100, y: -320, width: 640, height: 400 });
    expect(circle['@4']).toEqual({ x: 680, y: -120, width: 640, height: 400 });
    expect(circle['@5']).toEqual({ x: 680, y: 320, width: 640, height: 400 });

    expect(snowflake['@1']).toEqual({ x: 100, y: 100, width: 640, height: 400 });
    expect(snowflake['@2']).toEqual({ x: 440, y: -280, width: 640, height: 400 });
    expect(snowflake['@4']).toEqual({ x: 780, y: 100, width: 640, height: 400 });
    expect(snowflake['@5']).toEqual({ x: 440, y: 480, width: 640, height: 400 });
  });
});

describe('sidebar rename helpers', () => {
  it('builds a session rename command from the selected tree item', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const sessionIndex = buildSidebarItems(state).findIndex((item) => item.type === 'session' && item.sessionId === '$2');
    state.ui.sidebarSelectedIdx = sessionIndex;

    expect(buildSidebarRenameCommand(state)).toBe('tr Build');
  });

  it('builds a window rename command from the selected tree item', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const windowIndex = buildSidebarItems(state).findIndex((item) => item.type === 'window' && item.windowId === '@2');
    state.ui.sidebarSelectedIdx = windowIndex;

    expect(buildSidebarRenameCommand(state)).toBe('rename logs');
  });

  it('opens the command bar with the selected tree item rename command', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const windowIndex = buildSidebarItems(state).findIndex((item) => item.type === 'window' && item.windowId === '@2');
    state.ui.sidebarSelectedIdx = windowIndex;
    appState.set(state);

    beginSidebarRename();

    const next = get(appState);
    expect(next.ui.commandBarOpen).toBe(true);
    expect(next.ui.commandText).toBe('rename logs');
  });
});

describe('window sizing helpers', () => {
  it('computes a tmux window size request from the owning pane viewport', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.ui.paneViewportHints['%1'] = { cols: 100, rows: 30, pixelWidth: 750, pixelHeight: 480 };

    expect(calculateWindowSizeRequest(state, '@1')).toEqual({ cols: 100, rows: 30 });
  });

  it('reports pane viewport measurements without resizing tmux unless explicitly requested', async () => {
    appState.set(applyTmuxSnapshotToState(freshState(), baseSnapshot()));

    await reportPaneViewport('%1', 100, 30, 750, 480);

    const state = get(appState);
    expect(state.ui.paneViewportHints['%1']).toEqual({
      cols: 100,
      rows: 30,
      pixelWidth: 750,
      pixelHeight: 480,
    });
    expect(tauriMocks.resizeWindow).not.toHaveBeenCalled();
  });

  it('resizes the owning tmux window when explicitly requested', async () => {
    appState.set(applyTmuxSnapshotToState(freshState(), baseSnapshot()));

    await reportPaneViewport('%1', 100, 30, 750, 480, true);

    expect(tauriMocks.resizeWindow).toHaveBeenCalledWith('@1', 100, 30);
  });

  it('persists snapped tile dimensions after tmux reports the actual window size', async () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries['@1'] = { x: 0, y: 0, width: 640, height: 400 };
    appState.set(state);
    await reportPaneViewport('%1', 100, 24, 750, 480, true);

    const resizingState = get(appState);
    resizingState.ui.paneViewportHints['%1'] = { cols: 80, rows: 20, pixelWidth: 600, pixelHeight: 320 };
    appState.set(resizingState);

    applyTmuxSnapshot({
      ...baseSnapshot(),
      version: 2,
      windows: [
        { ...baseSnapshot().windows[0], cols: 100, rows: 24 },
        baseSnapshot().windows[1],
        baseSnapshot().windows[2],
      ],
      panes: [
        { ...baseSnapshot().panes[0], cols: 100, rows: 24 },
        baseSnapshot().panes[1],
        baseSnapshot().panes[2],
      ],
    });

    expect(get(appState).layout.entries['@1']).toEqual({ x: 0, y: 0, width: 790, height: 464 });
    expect(tauriMocks.saveLayoutState).toHaveBeenCalledWith('@1', 0, 0, 790, 464);
  });

  it('does not snap unrelated tiles when another tile in the session is resized', async () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries['@1'] = { x: 0, y: 0, width: 640, height: 400 };
    state.layout.entries['@2'] = { x: 500, y: 0, width: 540, height: 360 };
    state.ui.paneViewportHints['%1'] = { cols: 80, rows: 20, pixelWidth: 600, pixelHeight: 320 };
    state.ui.paneViewportHints['%2'] = { cols: 80, rows: 20, pixelWidth: 600, pixelHeight: 320 };
    appState.set(state);

    await reportPaneViewport('%1', 100, 24, 750, 480, true);
    const resizingState = get(appState);
    resizingState.ui.paneViewportHints['%1'] = { cols: 80, rows: 20, pixelWidth: 600, pixelHeight: 320 };
    appState.set(resizingState);

    applyTmuxSnapshot({
      ...baseSnapshot(),
      version: 2,
      windows: [
        { ...baseSnapshot().windows[0], cols: 100, rows: 24 },
        { ...baseSnapshot().windows[1], cols: 100, rows: 24 },
        baseSnapshot().windows[2],
      ],
      panes: [
        { ...baseSnapshot().panes[0], cols: 100, rows: 24 },
        { ...baseSnapshot().panes[1], cols: 100, rows: 24 },
        baseSnapshot().panes[2],
      ],
    });

    expect(get(appState).layout.entries['@1']).toEqual({ x: 0, y: 0, width: 790, height: 464 });
    expect(get(appState).layout.entries['@2']).toEqual({ x: 500, y: 0, width: 540, height: 360 });
  });
});
