import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStateTree, TmuxSnapshot, WorkItem } from '../types';

const tauriMocks = vi.hoisted(() => ({
  approveWorkItem: vi.fn(),
  connectNetworkTiles: vi.fn(),
  createWorkItem: vi.fn(),
  deleteWorkItem: vi.fn(),
  disconnectNetworkPort: vi.fn(),
  getBrowserExtensionPages: vi.fn(),
  sendDirectMessageCommand: vi.fn(),
  sendPublicMessageCommand: vi.fn(),
  getAgentDebugState: vi.fn(),
  getClaudeMenuDataForPane: vi.fn(),
  getLayoutState: vi.fn(),
  getTmuxState: vi.fn(),
  getWorkItems: vi.fn(),
  improveWorkItem: vi.fn(),
  killPane: vi.fn(),
  killSession: vi.fn(),
  killWindow: vi.fn(),
  loadBrowserWebview: vi.fn(),
  newSession: vi.fn(),
  newWindow: vi.fn(),
  readWorkStagePreview: vi.fn(),
  renameSession: vi.fn(),
  renameWindow: vi.fn(),
  resizeWindow: vi.fn(),
  saveLayoutState: vi.fn(),
  sendRootMessageCommand: vi.fn(),
  selectSession: vi.fn(),
  selectWindow: vi.fn(),
  setNetworkPortSettings: vi.fn(),
  setPaneTitle: vi.fn(),
  spawnBrowserWindow: vi.fn(),
  spawnAgentWindow: vi.fn(),
  writePane: vi.fn(),
}));

vi.mock('../tauri', () => tauriMocks);

import {
  __resetWindowResizeTrackingForTest,
  agentInfos,
  applyPaneReadOnlyToState,
  applyPaneRoleToState,
  applyAgentDebugStateToState,
  applyTileSignalStateToState,
  applyTmuxSnapshot,
  applyTmuxSnapshotToState,
  appState,
  activeNetworkDrag,
  activeTabTerminals,
  activeTabVisibleTerminals,
  activeTabVisibleWorkCards,
  activeTabWorkCards,
  appendChatterEntryToState,
  applyWorkItemsToState,
  autoArrange,
  autoArrangeWithElk,
  beginNetworkPortDrag,
  beginSidebarRename,
  bootstrapAppState,
  buildCanvasWorkCards,
  buildContextMenuItems,
  buildCanvasConnections,
  buildNetworkCallSignals,
  buildTestDriverProjection,
  buildTileActivityEntries,
  canvasState,
  clientDeltaToWorldDelta,
  buildRenderedNetworkConnections,
  buildSidebarItems,
  buildSidebarRenameCommand,
  calculateWindowSizeRequest,
  clearCurrentNetworkDragPortSnap,
  completeNetworkPortDrag,
  dismissContextMenuInState,
  fitCanvasToActiveTab,
  initialAppState,
  networkReleaseAnimation,
  openCanvasContextMenuInState,
  openPaneContextMenuInState,
  openPortContextMenuInState,
  openPaneContextMenu,
  parseCommandBarCommand,
  portCanAcceptCurrentDrag,
  reduceContextMenuSelection,
  reportPaneViewport,
  restoreMinimizedTile,
  reduceIntent,
  executeCommandBarCommand,
  activeSessionWorkItems,
  snapCurrentNetworkDragToPort,
  channelInfos,
  togglePaneMinimized,
  toggleWorkCardMinimized,
  updateNetworkPortDrag,
  zoomCanvasAtPoint,
} from './appState';

function freshState(): AppStateTree {
  return JSON.parse(JSON.stringify(initialAppState)) as AppStateTree;
}

const TILE_BY_PANE = {
  '%1': 'AaAaA1',
  '%2': 'BbBbB2',
  '%3': 'CcCcC3',
  '%4': 'DdDdD4',
  '%5': 'EeEeE5',
  '%6': 'FfFfF6',
  '%7': 'GgGgG7',
  '%8': 'HhHhH8',
} as const;

const TILE_BY_WINDOW = {
  '@1': TILE_BY_PANE['%1'],
  '@2': TILE_BY_PANE['%2'],
  '@3': TILE_BY_PANE['%3'],
  '@4': TILE_BY_PANE['%4'],
  '@5': TILE_BY_PANE['%5'],
  '@6': TILE_BY_PANE['%6'],
  '@7': TILE_BY_PANE['%7'],
  '@8': TILE_BY_PANE['%8'],
} as const;

function tileForPane(paneId: keyof typeof TILE_BY_PANE): string {
  return TILE_BY_PANE[paneId];
}

function tileForWindow(windowId: keyof typeof TILE_BY_WINDOW): string {
  return TILE_BY_WINDOW[windowId];
}

function tileForWork(workId: string): string {
  return {
    'work-s1-001': 'WwWwW1',
    'work-s1-002': 'XxXxX2',
    'work-s2-001': 'YyYyY3',
  }[workId] ?? `work-${workId}`;
}

function layoutEntryForWindow(state: AppStateTree, windowId: keyof typeof TILE_BY_WINDOW) {
  return state.layout.entries[tileForWindow(windowId)];
}

function pointStrictlyInsideRect(
  point: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
) {
  return (
    point.x > rect.x
    && point.x < rect.x + rect.width
    && point.y > rect.y
    && point.y < rect.y + rect.height
  );
}

function segmentCrossesRectInterior(
  start: { x: number; y: number },
  end: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
) {
  if (pointStrictlyInsideRect(start, rect) || pointStrictlyInsideRect(end, rect)) {
    return true;
  }

  const xMin = rect.x;
  const xMax = rect.x + rect.width;
  const yMin = rect.y;
  const yMax = rect.y + rect.height;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let entry = 0;
  let exit = 1;

  const clip = (p: number, q: number) => {
    if (p === 0) {
      return q >= 0;
    }
    const ratio = q / p;
    if (p < 0) {
      if (ratio > exit) {
        return false;
      }
      if (ratio > entry) {
        entry = ratio;
      }
      return true;
    }
    if (ratio < entry) {
      return false;
    }
    if (ratio < exit) {
      exit = ratio;
    }
    return true;
  };

  if (!clip(-dx, start.x - xMin)) return false;
  if (!clip(dx, xMax - start.x)) return false;
  if (!clip(-dy, start.y - yMin)) return false;
  if (!clip(dy, yMax - start.y)) return false;
  if (entry > exit) return false;

  const midpoint = {
    x: start.x + dx * ((entry + exit) / 2),
    y: start.y + dy * ((entry + exit) / 2),
  };
  return pointStrictlyInsideRect(midpoint, rect);
}

function baseSnapshot(): TmuxSnapshot {
  return {
    version: 1,
    server_name: 'herd',
    active_session_id: '$1',
    active_window_id: '@1',
    active_pane_id: '%1',
    sessions: [
      { id: '$1', name: 'Main', active: true, window_ids: ['@1', '@2'], active_window_id: '@1', root_cwd: '/Users/skryl/Dev/herd' },
      { id: '$2', name: 'Build', active: false, window_ids: ['@3'], active_window_id: '@3', root_cwd: '/Users/skryl/Dev/herd/src-tauri' },
    ],
    windows: [
      { id: '@1', tile_id: tileForWindow('@1'), session_id: '$1', session_name: 'Main', index: 0, name: 'shell', active: true, cols: 80, rows: 24, pane_ids: ['%1'] },
      { id: '@2', tile_id: tileForWindow('@2'), session_id: '$1', session_name: 'Main', index: 1, name: 'logs', active: false, cols: 90, rows: 28, pane_ids: ['%2'] },
      { id: '@3', tile_id: tileForWindow('@3'), session_id: '$2', session_name: 'Build', index: 0, name: 'build', active: true, cols: 100, rows: 30, pane_ids: ['%3'] },
    ],
    panes: [
      { id: '%1', tile_id: tileForPane('%1'), session_id: '$1', window_id: '@1', window_index: 0, pane_index: 0, cols: 80, rows: 24, title: 'shell', command: 'zsh', active: true, dead: false },
      { id: '%2', tile_id: tileForPane('%2'), session_id: '$1', window_id: '@2', window_index: 1, pane_index: 0, cols: 90, rows: 28, title: 'logs', command: 'tail', active: false, dead: false },
      { id: '%3', tile_id: tileForPane('%3'), session_id: '$2', window_id: '@3', window_index: 0, pane_index: 0, cols: 100, rows: 30, title: 'build', command: 'npm', active: true, dead: false },
    ],
  };
}

function baseTestDriverStatus() {
  return {
    enabled: true,
    frontend_ready: true,
    bootstrap_complete: true,
    runtime_id: null,
    tmux_server_name: 'herd',
    socket_path: '/tmp/herd.sock',
    tmux_server_alive: true,
    control_client_alive: true,
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
      tile_id: tileForWindow(windowId as keyof typeof TILE_BY_WINDOW),
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
      tile_id: tileForPane(paneId as keyof typeof TILE_BY_PANE),
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

function entriesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

beforeEach(() => {
  appState.set(freshState());
  activeNetworkDrag.set(null);
  networkReleaseAnimation.set(null);
  __resetWindowResizeTrackingForTest();
  Object.values(tauriMocks).forEach((mockFn) => mockFn.mockReset());
  tauriMocks.getClaudeMenuDataForPane.mockResolvedValue({ commands: [], skills: [] });
  tauriMocks.getAgentDebugState.mockResolvedValue({
    agents: [],
    channels: [],
    chatter: [],
    agent_logs: [],
    tile_message_logs: [],
    connections: [],
    agent_displays: [],
    tile_signals: [],
    port_settings: [],
  });
  tauriMocks.getBrowserExtensionPages.mockResolvedValue([]);
  tauriMocks.getWorkItems.mockResolvedValue([]);
  tauriMocks.loadBrowserWebview.mockResolvedValue(undefined);
  tauriMocks.resizeWindow.mockResolvedValue(undefined);
  tauriMocks.spawnAgentWindow.mockResolvedValue(undefined);
  tauriMocks.connectNetworkTiles.mockResolvedValue(undefined);
  tauriMocks.disconnectNetworkPort.mockResolvedValue(null);
  tauriMocks.setNetworkPortSettings.mockResolvedValue({
    session_id: '$1',
    tile_id: tileForPane('%1'),
    port: 'left',
    access_mode: 'read_write',
    networking_mode: 'broadcast',
  });
});

function sampleWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const workId = overrides.work_id ?? 'work-s1-001';
  return {
    work_id: workId,
    tile_id: tileForWork(workId),
    session_id: '$1',
    title: 'Socket refactor',
    topic: '#work-s1-001',
    owner_agent_id: null,
    current_stage: 'plan',
    stages: [
      { stage: 'plan', status: 'ready' },
      { stage: 'prd', status: 'ready' },
      { stage: 'artifact', status: 'ready' },
    ],
    reviews: [],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('applyTmuxSnapshotToState', () => {
  it('hydrates tmux sessions, windows, and tile layout from the snapshot', () => {
    const next = applyTmuxSnapshotToState(freshState(), baseSnapshot());

    expect(next.tmux.serverName).toBe('herd');
    expect(next.tmux.activeSessionId).toBe('$1');
    expect(next.tmux.activeWindowId).toBe('@1');
    expect(next.tmux.activePaneId).toBe('%1');
    expect(next.tmux.sessionOrder).toEqual(['$1', '$2']);
    expect(next.tmux.windowOrder).toEqual(['@1', '@2', '@3']);
    expect(next.tmux.sessions['$1'].root_cwd).toBe('/Users/skryl/Dev/herd');
    expect(next.ui.selectedPaneId).toBe('%1');
    expect(Object.keys(next.layout.entries)).toEqual([
      tileForWindow('@1'),
      tileForWindow('@2'),
      tileForWindow('@3'),
    ]);
  });

  it('drops stale layout entries and preserves read-only pane metadata', () => {
    const withSnapshot = applyWorkItemsToState(
      applyTmuxSnapshotToState(freshState(), baseSnapshot()),
      [sampleWorkItem()],
    );
    withSnapshot.layout.entries[tileForWindow('@1')] = { x: 10, y: 20, width: 500, height: 300 };
    withSnapshot.layout.entries['@9'] = { x: 1, y: 1, width: 1, height: 1 };
    withSnapshot.layout.entries[tileForWork('work-s1-001')] = { x: 1400, y: 120, width: 360, height: 320 };
    const readOnlyState = applyPaneReadOnlyToState(withSnapshot, '%2', true);

    const next = applyTmuxSnapshotToState(readOnlyState, {
      ...baseSnapshot(),
      version: 2,
      sessions: [
        { id: '$1', name: 'Main', active: true, window_ids: ['@1'], active_window_id: '@1' },
      ],
      windows: [
        { ...baseSnapshot().windows[0], active: true },
      ],
      panes: [baseSnapshot().panes[0]],
      active_session_id: '$1',
      active_window_id: '@1',
      active_pane_id: '%1',
    });

    expect(next.layout.entries[tileForWindow('@1')]).toEqual({ x: 10, y: 20, width: 500, height: 300 });
    expect(next.layout.entries['@9']).toBeUndefined();
    expect(next.layout.entries[tileForWork('work-s1-001')]).toEqual({ x: 1400, y: 120, width: 360, height: 320 });
    expect(next.tmux.panes['%2']).toBeUndefined();
  });

  it('preserves tile layout entries when switching tabs between sessions', () => {
    const initial = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    initial.layout.entries[tileForWindow('@1')] = { x: 10, y: 20, width: 500, height: 300 };
    initial.layout.entries[tileForWindow('@3')] = { x: 700, y: 40, width: 640, height: 400 };

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

    expect(switched.layout.entries[tileForWindow('@1')]).toEqual({ x: 10, y: 20, width: 500, height: 300 });
    expect(switched.layout.entries[tileForWindow('@3')]).toEqual({ x: 700, y: 40, width: 640, height: 400 });
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
          tile_id: tileForWindow('@4'),
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
          tile_id: tileForPane('%4'),
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

    expect(next.layout.entries[tileForWindow('@4')].x).toBeGreaterThan(next.layout.entries[tileForWindow('@1')].x + next.layout.entries[tileForWindow('@1')].width);
    expect(Math.abs(next.layout.entries[tileForWindow('@4')].y - next.layout.entries[tileForWindow('@1')].y)).toBeLessThanOrEqual(60);
  });
});

describe('network connectors', () => {
  it('defaults tile port count to four total ports', () => {
    expect(initialAppState.ui.tilePortCount).toBe(4);
  });

  it('enables network call sparks by default', () => {
    expect(initialAppState.ui.networkCallSparksEnabled).toBe(true);
  });

  it('builds simple rendered curves when nothing blocks the wire', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    state.network.connections = [{
      session_id: '$1',
      from_tile_id: tileForPane('%1'),
      from_port: 'right',
      to_tile_id: tileForPane('%2'),
      to_port: 'left',
    }];

    const [connection] = buildRenderedNetworkConnections(state);
    expect(connection).toMatchObject({
      fromTileId: tileForPane('%1'),
      fromPort: 'right',
      toTileId: tileForPane('%2'),
      toPort: 'left',
      wireMode: 'full_duplex',
      x1: 240,
      y1: 80,
      x2: 420,
      y2: 130,
    });
    expect(connection.points).toEqual([
      { x: 240, y: 80 },
      { x: 420, y: 130 },
    ]);
    expect(connection.path).toMatch(/^M 240 80 C [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ 420 130$/);
    const firstCurveMatch = connection.path.match(/^M 240 80 C ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/);
    expect(firstCurveMatch).not.toBeNull();
    const firstControl1 = { x: Number(firstCurveMatch?.[1]), y: Number(firstCurveMatch?.[2]) };
    const firstSegmentStart = connection.points[0];
    const firstSegmentEnd = connection.points[1];
    const firstSegmentVector = {
      x: firstSegmentEnd.x - firstSegmentStart.x,
      y: firstSegmentEnd.y - firstSegmentStart.y,
    };
    const firstControlVector = {
      x: firstControl1.x - firstSegmentStart.x,
      y: firstControl1.y - firstSegmentStart.y,
    };
    expect(
      firstSegmentVector.x * firstControlVector.x + firstSegmentVector.y * firstControlVector.y,
    ).toBeGreaterThan(0);
    const lastCurveMatch = connection.path.match(/C ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) 420 130$/);
    expect(lastCurveMatch).not.toBeNull();
    const lastControl2 = { x: Number(lastCurveMatch?.[3]), y: Number(lastCurveMatch?.[4]) };
    const lastSegmentStart = connection.points[connection.points.length - 2];
    const lastSegmentEnd = connection.points[connection.points.length - 1];
    const lastSegmentVector = {
      x: lastSegmentStart.x - lastSegmentEnd.x,
      y: lastSegmentStart.y - lastSegmentEnd.y,
    };
    const lastControlVector = {
      x: lastControl2.x - lastSegmentEnd.x,
      y: lastControl2.y - lastSegmentEnd.y,
    };
    expect(
      lastSegmentVector.x * lastControlVector.x + lastSegmentVector.y * lastControlVector.y,
    ).toBeGreaterThan(0);
    expect(connection.path).toMatch(/420 130$/);
    expect(connection.path).not.toContain(' Q ');
    expect(connection).not.toHaveProperty('cx1');
    expect(connection).not.toHaveProperty('cy1');
    expect(connection).not.toHaveProperty('cx2');
    expect(connection).not.toHaveProperty('cy2');
  });

  it('routes around blocking tiles instead of crossing their bounds', () => {
    const state = applyTmuxSnapshotToState(freshState(), snapshotWithMainWindowCount(4));
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 560, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@4')] = { x: 250, y: -40, width: 300, height: 240 };
    state.network.connections = [{
      session_id: '$1',
      from_tile_id: tileForPane('%1'),
      from_port: 'right',
      to_tile_id: tileForPane('%2'),
      to_port: 'left',
    }];

    const [connection] = buildRenderedNetworkConnections(state);
    expect(connection?.points.length).toBeGreaterThan(2);

    const blocker = state.layout.entries[tileForWindow('@4')];
    const segmentsCrossingBlocker = connection.points
      .slice(0, -1)
      .filter((point, index) => segmentCrossesRectInterior(point, connection.points[index + 1], blocker));

    expect(segmentsCrossingBlocker).toHaveLength(0);
  });

  it('keeps browser connections full-duplex on non-left ports', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyPaneRoleToState(state, '%2', 'browser');
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    state.network.connections = [{
      session_id: '$1',
      from_tile_id: tileForPane('%1'),
      from_port: 'right',
      to_tile_id: tileForPane('%2'),
      to_port: 'top',
    }];

    const [connection] = buildRenderedNetworkConnections(state);
    expect(connection?.wireMode).toBe('full_duplex');
  });

  it('snaps network drags to the nearest valid target port and completes on mouseup', async () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);
    updateNetworkPortDrag(405, 136);

    expect(get(activeNetworkDrag)).toMatchObject({
      snappedTileId: tileForPane('%2'),
      snappedPort: 'left',
      snappedX: 420,
      snappedY: 130,
    });

    await completeNetworkPortDrag();

    expect(tauriMocks.connectNetworkTiles).toHaveBeenCalledWith(
      tileForPane('%1'),
      'right',
      tileForPane('%2'),
      'left',
    );
  });

  it('uses a larger circular snap vicinity around target ports', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);
    updateNetworkPortDrag(450, 145);

    expect(get(activeNetworkDrag)).toMatchObject({
      snappedTileId: tileForPane('%2'),
      snappedPort: 'left',
      snappedX: 420,
      snappedY: 130,
    });

    updateNetworkPortDrag(460, 170);

    expect(get(activeNetworkDrag)).toMatchObject({
      snappedTileId: null,
      snappedPort: null,
      snappedX: null,
      snappedY: null,
    });
  });

  it('lets a valid target port claim the active drag directly on hover', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);
    updateNetworkPortDrag(330, 95);

    expect(get(activeNetworkDrag)).toMatchObject({
      snappedTileId: null,
      snappedPort: null,
    });

    snapCurrentNetworkDragToPort(tileForPane('%2'), 'left');

    expect(get(activeNetworkDrag)).toMatchObject({
      snappedTileId: tileForPane('%2'),
      snappedPort: 'left',
      snappedX: 420,
      snappedY: 130,
    });
  });

  it('clears a forced port snap when leaving that same target port', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);
    snapCurrentNetworkDragToPort(tileForPane('%2'), 'left');
    clearCurrentNetworkDragPortSnap(tileForPane('%2'), 'left');

    expect(get(activeNetworkDrag)).toMatchObject({
      snappedTileId: null,
      snappedPort: null,
      snappedX: null,
      snappedY: null,
    });
  });

  it('does not force-snap incompatible ports even if the cursor enters them', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyPaneRoleToState(state, '%2', 'browser');
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);
    snapCurrentNetworkDragToPort(tileForPane('%2'), 'left');

    expect(get(activeNetworkDrag)).toMatchObject({
      snappedTileId: null,
      snappedPort: null,
      snappedX: null,
      snappedY: null,
    });
  });

  it('does not advertise work left as a valid snap target for non-agent drags', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyWorkItemsToState(state, [sampleWorkItem()]);
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWork('work-s1-001')] = { x: 420, y: 40, width: 260, height: 180 };
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);
    updateNetworkPortDrag(405, 130);

    expect(portCanAcceptCurrentDrag(tileForWork('work-s1-001'), 'left')).toBe(false);
    expect(get(activeNetworkDrag)).toMatchObject({
      snappedTileId: null,
      snappedPort: null,
      snappedX: null,
      snappedY: null,
    });
  });

  it('allows agent drags to snap into work left', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyPaneRoleToState(state, '%1', 'claude');
    state = applyWorkItemsToState(state, [sampleWorkItem()]);
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWork('work-s1-001')] = { x: 420, y: 40, width: 260, height: 180 };
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);
    updateNetworkPortDrag(405, 130);

    expect(portCanAcceptCurrentDrag(tileForWork('work-s1-001'), 'left')).toBe(true);
    expect(get(activeNetworkDrag)).toMatchObject({
      snappedTileId: tileForWork('work-s1-001'),
      snappedPort: 'left',
      snappedX: 420,
      snappedY: 130,
    });
  });

  it('does not advertise browser left as a valid snap target for non-agent drags', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyPaneRoleToState(state, '%2', 'browser');
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);
    updateNetworkPortDrag(405, 130);

    expect(portCanAcceptCurrentDrag(tileForPane('%2'), 'left')).toBe(false);
    expect(get(activeNetworkDrag)).toMatchObject({
      snappedTileId: null,
      snappedPort: null,
      snappedX: null,
      snappedY: null,
    });
  });

  it('detaches occupied drags from the opposite endpoint', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    state.network.connections = [{
      session_id: '$1',
      from_tile_id: tileForPane('%1'),
      from_port: 'right',
      to_tile_id: tileForPane('%2'),
      to_port: 'left',
    }];
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);

    expect(get(activeNetworkDrag)).toMatchObject({
      tileId: tileForPane('%2'),
      port: 'left',
      grabbedTileId: tileForPane('%1'),
      grabbedPort: 'right',
      startX: 420,
      startY: 130,
      currentX: 240,
      currentY: 80,
      startedOccupied: true,
    });
  });

  it('reconnects occupied drags from the anchored endpoint', async () => {
    const snapshot = baseSnapshot();
    snapshot.sessions[0].window_ids.push('@4');
    snapshot.windows.push({
      id: '@4',
      tile_id: tileForWindow('@4'),
      session_id: '$1',
      session_name: 'Main',
      index: 2,
      name: 'worker',
      active: false,
      cols: 80,
      rows: 24,
      pane_ids: ['%4'],
    });
    snapshot.panes.push({
      id: '%4',
      tile_id: tileForPane('%4'),
      session_id: '$1',
      window_id: '@4',
      window_index: 2,
      pane_index: 0,
      cols: 80,
      rows: 24,
      title: 'worker',
      command: 'zsh',
      active: false,
      dead: false,
    });

    const state = applyTmuxSnapshotToState(freshState(), snapshot);
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    state.layout.entries[tileForWindow('@4')] = { x: 780, y: 40, width: 260, height: 180 };
    state.network.connections = [{
      session_id: '$1',
      from_tile_id: tileForPane('%1'),
      from_port: 'right',
      to_tile_id: tileForPane('%2'),
      to_port: 'left',
    }];
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);
    await completeNetworkPortDrag(tileForPane('%4'), 'left');

    expect(tauriMocks.connectNetworkTiles).toHaveBeenCalledWith(
      tileForPane('%2'),
      'left',
      tileForPane('%4'),
      'left',
    );
  });

  it('starts a retract animation when an occupied drag is released without reconnecting', async () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    state.network.connections = [{
      session_id: '$1',
      from_tile_id: tileForPane('%1'),
      from_port: 'right',
      to_tile_id: tileForPane('%2'),
      to_port: 'left',
    }];
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right', 240, 80);
    updateNetworkPortDrag(332, 108);
    await completeNetworkPortDrag();

    expect(tauriMocks.disconnectNetworkPort).toHaveBeenCalledWith(tileForPane('%2'), 'left');
    expect(get(networkReleaseAnimation)).toMatchObject({
      anchorTileId: tileForPane('%2'),
      anchorPort: 'left',
      anchorX: 420,
      anchorY: 130,
    });
  });

  it('positions higher-slot rendered connections away from the side midpoint', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.ui.tilePortCount = 8;
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWindow('@2')] = { x: 420, y: 40, width: 260, height: 180 };
    state.network.connections = [{
      session_id: '$1',
      from_tile_id: tileForPane('%1'),
      from_port: 'right-2',
      to_tile_id: tileForPane('%2'),
      to_port: 'left-2',
    }];

    const [connection] = buildRenderedNetworkConnections(state);
    expect(connection).toMatchObject({
      fromPort: 'right-2',
      toPort: 'left-2',
      x1: 240,
      x2: 420,
    });
    expect(connection.y1).toBeCloseTo(160 * (2 / 3));
    expect(connection.y2).toBeCloseTo(40 + 180 * (2 / 3));
    expect(connection.y1).not.toBeCloseTo(80);
    expect(connection.y2).not.toBeCloseTo(130);
  });

  it('applies left-side agent-only rules to higher left slots', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.ui.tilePortCount = 8;
    state = applyWorkItemsToState(state, [sampleWorkItem()]);
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 240, height: 160 };
    state.layout.entries[tileForWork('work-s1-001')] = { x: 420, y: 40, width: 260, height: 180 };
    appState.set(state);

    beginNetworkPortDrag(tileForPane('%1'), 'right-2', 240, 80);
    expect(portCanAcceptCurrentDrag(tileForWork('work-s1-001'), 'left-2')).toBe(false);

    const agentState = applyPaneRoleToState(state, '%1', 'claude');
    appState.set(agentState);
    beginNetworkPortDrag(tileForPane('%1'), 'right-2', 240, 80);
    expect(portCanAcceptCurrentDrag(tileForWork('work-s1-001'), 'left-2')).toBe(true);
  });
});

describe('work state', () => {
  it('bootstraps current-session work items from tauri', async () => {
    tauriMocks.getLayoutState.mockResolvedValue({});
    tauriMocks.getTmuxState.mockResolvedValue(baseSnapshot());
    tauriMocks.getAgentDebugState.mockResolvedValue({
      agents: [],
      channels: [],
      chatter: [],
      agent_logs: [],
      tile_message_logs: [],
      connections: [],
      agent_displays: [],
      tile_signals: [],
      port_settings: [],
    });
    tauriMocks.getWorkItems.mockResolvedValue([
      sampleWorkItem(),
      sampleWorkItem({
        work_id: 'work-s1-002',
        title: 'PRD review',
        current_stage: 'prd',
        stages: [
          { stage: 'plan', status: 'approved' },
          { stage: 'prd', status: 'completed' },
          { stage: 'artifact', status: 'ready' },
        ],
        updated_at: 20,
      }),
    ]);

    await bootstrapAppState();

    const state = get(appState);
    expect(state.work.order).toEqual(['work-s1-001', 'work-s1-002']);
    expect(state.work.items['work-s1-002'].title).toBe('PRD review');
  });

  it('keeps work state on tmux snapshot updates and exposes current-session items', () => {
    const seeded = applyWorkItemsToState(
      applyTmuxSnapshotToState(freshState(), baseSnapshot()),
      [
        sampleWorkItem(),
        sampleWorkItem({
          work_id: 'work-s2-001',
          session_id: '$2',
          title: 'Artifact polish',
          topic: '#work-s2-001',
        }),
      ],
    );
    appState.set(seeded);

    const switched = applyTmuxSnapshotToState(seeded, {
      ...baseSnapshot(),
      version: 2,
      active_session_id: '$2',
      active_window_id: '@3',
      active_pane_id: '%3',
      sessions: [
        { id: '$1', name: 'Main', active: false, window_ids: ['@1', '@2'], active_window_id: '@1', root_cwd: '/Users/skryl/Dev/herd' },
        { id: '$2', name: 'Build', active: true, window_ids: ['@3'], active_window_id: '@3', root_cwd: '/Users/skryl/Dev/herd/src-tauri' },
      ],
    });
    appState.set(switched);

    expect(switched.work.order).toEqual(['work-s1-001', 'work-s2-001']);
    expect(get(activeSessionWorkItems).map((item) => item.work_id)).toEqual(['work-s2-001']);
  });
});

describe('session-scoped agent debug state', () => {
  it('normalizes pointer movement by the current canvas zoom', () => {
    expect(clientDeltaToWorldDelta(40, 20, 2)).toEqual({ dx: 20, dy: 10 });
    expect(clientDeltaToWorldDelta(40, 20, 0.5)).toEqual({ dx: 80, dy: 40 });
  });

  it('allows the main canvas to zoom out to the lower floor', () => {
    canvasState.set({ panX: 100, panY: 50, zoom: 1 });

    zoomCanvasAtPoint(400, 300, 0.05);

    expect(get(canvasState).zoom).toBe(0.05);
  });

  it('keeps only active-session agents, channels, and chatter from debug snapshots', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const next = applyAgentDebugStateToState(state, {
      agents: [
        {
          agent_id: 'agent-1',
          agent_type: 'claude',
          agent_role: 'worker',
          tile_id: tileForPane('%1'),
          window_id: '@1',
          session_id: '$1',
          title: 'Agent',
          display_name: 'Agent 1',
          alive: true,
          chatter_subscribed: true,
          channels: ['#work-s1-001'],
        },
        {
          agent_id: 'agent-2',
          agent_type: 'claude',
          agent_role: 'worker',
          tile_id: tileForPane('%3'),
          window_id: '@3',
          session_id: '$2',
          title: 'Agent',
          display_name: 'Agent 2',
          alive: true,
          chatter_subscribed: true,
          channels: ['#work-s2-001'],
        },
      ],
      agent_logs: [],
      tile_message_logs: [],
      connections: [],
      agent_displays: [],
      tile_signals: [],
      port_settings: [],
      channels: [
        { session_id: '$1', name: '#work-s1-001', subscriber_count: 1, last_activity_at: 10 },
        { session_id: '$2', name: '#work-s2-001', subscriber_count: 1, last_activity_at: 20 },
      ],
      chatter: [
        {
          session_id: '$1',
          kind: 'public',
          from_agent_id: 'agent-1',
          from_display_name: 'Agent 1',
          message: 'hello from main',
          to_agent_id: null,
          to_display_name: null,
          channels: ['#work-s1-001'],
          mentions: [],
          timestamp_ms: 1,
          public: true,
          display_text: 'Agent 1 -> Chatter: hello from main',
        },
        {
          session_id: '$2',
          kind: 'public',
          from_agent_id: 'agent-2',
          from_display_name: 'Agent 2',
          message: 'hello from build',
          to_agent_id: null,
          to_display_name: null,
          channels: ['#work-s2-001'],
          mentions: [],
          timestamp_ms: 2,
          public: true,
          display_text: 'Agent 2 -> Chatter: hello from build',
        },
      ],
    });

    expect(Object.keys(next.agents)).toEqual(['agent-1']);
    expect(Object.keys(next.channels)).toEqual(['#work-s1-001']);
    expect(next.chatter.map((entry) => entry.session_id)).toEqual(['$1']);
  });

  it('stores agent display frames by tile id for the active session', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const next = applyAgentDebugStateToState(state, {
      agents: [
        {
          agent_id: 'agent-1',
          agent_type: 'claude',
          agent_role: 'worker',
          tile_id: tileForPane('%1'),
          window_id: '@1',
          session_id: '$1',
          title: 'Agent',
          display_name: 'Agent 1',
          alive: true,
          chatter_subscribed: true,
          channels: [],
        },
      ],
      channels: [],
      chatter: [],
      agent_logs: [],
      tile_message_logs: [],
      connections: [],
      port_settings: [],
      agent_displays: [
        {
          agent_id: 'agent-1',
          tile_id: tileForPane('%1'),
          session_id: '$1',
          text: 'AB\\nCD',
          columns: 2,
          rows: 2,
          updated_at: 42,
        },
        {
          agent_id: 'agent-2',
          tile_id: tileForPane('%3'),
          session_id: '$2',
          text: 'ZZ',
          columns: 2,
          rows: 1,
          updated_at: 84,
        },
      ],
      tile_signals: [],
    });

    expect(next.agentDisplays).toEqual({
      [tileForPane('%1')]: {
        agent_id: 'agent-1',
        tile_id: tileForPane('%1'),
        session_id: '$1',
        text: 'AB\\nCD',
        columns: 2,
        rows: 2,
        updated_at: 42,
      },
    });
  });

  it('stores tile signal states by tile id for the active session and applies incremental updates', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const offLeds = Array.from({ length: 8 }, (_, index) => ({
      index: index + 1,
      on: false,
      color: null,
    }));
    const next = applyAgentDebugStateToState(state, {
      agents: [],
      channels: [],
      chatter: [],
      agent_logs: [],
      tile_message_logs: [],
      connections: [],
      port_settings: [],
      agent_displays: [],
      tile_signals: [
        {
          tile_id: tileForPane('%1'),
          session_id: '$1',
          leds: offLeds,
          status_text: '\u001b[33mREADY\u001b[0m',
          updated_at: 42,
        },
        {
          tile_id: tileForPane('%3'),
          session_id: '$2',
          leds: offLeds,
          status_text: 'foreign',
          updated_at: 84,
        },
      ],
    });

    expect(next.tileSignals).toEqual({
      [tileForPane('%1')]: {
        tile_id: tileForPane('%1'),
        session_id: '$1',
        leds: offLeds,
        status_text: '\u001b[33mREADY\u001b[0m',
        updated_at: 42,
      },
    });

    const updated = applyTileSignalStateToState(next, {
      tile_id: tileForPane('%1'),
      session_id: '$1',
      leds: offLeds.map((led) => (led.index === 1 ? { ...led, on: true, color: 'red' } : led)),
      status_text: '\u001b[31mALERT\u001b[0m',
      updated_at: 128,
    });

    expect(updated.tileSignals[tileForPane('%1')]).toEqual({
      tile_id: tileForPane('%1'),
      session_id: '$1',
      leds: offLeds.map((led) => (led.index === 1 ? { ...led, on: true, color: 'red' } : led)),
      status_text: '\u001b[31mALERT\u001b[0m',
      updated_at: 128,
    });

    const ignored = applyTileSignalStateToState(updated, {
      tile_id: tileForPane('%3'),
      session_id: '$2',
      leds: offLeds.map((led) => (led.index === 3 ? { ...led, on: true, color: 'blue' } : led)),
      status_text: 'ignored',
      updated_at: 256,
    });

    expect(ignored.tileSignals).toEqual(updated.tileSignals);
  });

  it('ignores chatter append events from other sessions and derives active-session registry views', () => {
    const seeded = applyAgentDebugStateToState(
      applyTmuxSnapshotToState(freshState(), baseSnapshot()),
      {
        agents: [
          {
            agent_id: 'agent-1',
            agent_type: 'claude',
            agent_role: 'worker',
            tile_id: tileForPane('%1'),
            window_id: '@1',
            session_id: '$1',
            title: 'Agent',
            display_name: 'Agent 1',
            alive: true,
            chatter_subscribed: true,
            channels: ['#work-s1-001'],
          },
          {
            agent_id: 'agent-2',
            agent_type: 'claude',
            agent_role: 'worker',
            tile_id: tileForPane('%3'),
            window_id: '@3',
            session_id: '$2',
            title: 'Agent',
            display_name: 'Agent 2',
            alive: true,
            chatter_subscribed: true,
            channels: ['#work-s2-001'],
          },
        ],
        agent_logs: [],
        tile_message_logs: [],
        connections: [],
        agent_displays: [],
        tile_signals: [],
        port_settings: [],
        channels: [
          { session_id: '$1', name: '#work-s1-001', subscriber_count: 1, last_activity_at: 10 },
          { session_id: '$2', name: '#work-s2-001', subscriber_count: 1, last_activity_at: 20 },
        ],
        chatter: [],
      },
    );
    appState.set(seeded);

    appState.update((state) =>
      appendChatterEntryToState(state, {
        session_id: '$2',
        kind: 'public',
        from_agent_id: 'agent-2',
        from_display_name: 'Agent 2',
        message: 'foreign',
        to_agent_id: null,
        to_display_name: null,
        channels: ['#work-s2-001'],
        mentions: [],
        timestamp_ms: 99,
        public: true,
        display_text: 'Agent 2 -> Chatter: foreign',
      }),
    );

    expect(get(agentInfos).map((agent) => agent.agent_id)).toEqual(['agent-1']);
    expect(get(channelInfos).map((channel) => channel.name)).toEqual(['#work-s1-001']);
    expect(get(appState).chatter).toEqual([]);
  });

  it('merges chatter, agent logs, and tile message logs into tile activity entries in timestamp order', () => {
    const state = applyAgentDebugStateToState(
      applyTmuxSnapshotToState(freshState(), baseSnapshot()),
      {
        agents: [
          {
            agent_id: 'agent-1',
            agent_type: 'claude',
            agent_role: 'worker',
            tile_id: tileForPane('%1'),
            window_id: '@1',
            session_id: '$1',
            title: 'Agent',
            display_name: 'Agent 1',
            alive: true,
            chatter_subscribed: true,
            channels: [],
          },
        ],
        channels: [],
        chatter: [
          {
            session_id: '$1',
            kind: 'direct',
            from_agent_id: 'agent-2',
            from_display_name: 'Agent 2',
            to_agent_id: 'agent-1',
            to_display_name: 'Agent 1',
            message: 'hello',
            channels: [],
            mentions: [],
            timestamp_ms: 20,
            public: false,
            display_text: 'Agent 2 -> Agent 1: hello',
          },
        ],
        agent_logs: [
          {
            session_id: '$1',
            agent_id: 'agent-1',
            tile_id: tileForPane('%1'),
            kind: 'incoming_hook',
            text: `MCP hook [system] Port connected: ${tileForPane('%1')}:left <-> ${tileForWork('work-s1-001')}:left`,
            timestamp_ms: 10,
          },
          {
            session_id: '$1',
            agent_id: 'agent-1',
            tile_id: tileForPane('%1'),
            kind: 'outgoing_call',
            text: 'MCP call message_direct {"to_agent_id":"agent-2","message":"hello"}',
            timestamp_ms: 30,
          },
        ],
        tile_message_logs: [
          {
            session_id: '$1',
            layer: 'message',
            channel: 'socket',
            target_id: tileForPane('%1'),
            target_kind: 'agent',
            wrapper_command: 'tile_call',
            message_name: 'output_read',
            caller_tile_id: tileForPane('%2'),
            args: {},
            related_tile_ids: [tileForPane('%1'), tileForPane('%2')],
            outcome: 'ok',
            duration_ms: 5,
            timestamp_ms: 25,
          },
        ],
        connections: [],
        agent_displays: [],
        tile_signals: [],
        port_settings: [],
      },
    );

    expect(buildTileActivityEntries(state, tileForPane('%1'))).toEqual([
      {
        kind: 'incoming_hook',
        text: `MCP hook [system] Port connected: ${tileForPane('%1')}:left <-> ${tileForWork('work-s1-001')}:left`,
        timestamp_ms: 10,
      },
      {
        kind: 'incoming_dm',
        text: 'Agent 2 -> Agent 1: hello',
        timestamp_ms: 20,
      },
      {
        kind: 'message_log',
        text: `[MESSAGE/SOCKET] recv output_read <- ${tileForPane('%2')}`,
        timestamp_ms: 25,
      },
      {
        kind: 'outgoing_call',
        text: 'MCP call message_direct {"to_agent_id":"agent-2","message":"hello"}',
        timestamp_ms: 30,
      },
    ]);
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

  it('opens a confirmation dialog before closing a root agent pane', () => {
    const seeded = applyPaneRoleToState(
      applyTmuxSnapshotToState(freshState(), baseSnapshot()),
      '%1',
      'root_agent',
    );

    const result = reduceIntent(seeded, { type: 'close-selected-pane' });
    expect(result.effects).toEqual([]);
    expect(result.state.ui.closePaneConfirmation).toEqual({
      paneId: '%1',
      title: 'CLOSE ROOT AGENT',
      message: 'Close this Root agent? Herd will restart it automatically.',
      confirmLabel: 'Close Root Agent',
    });
  });

  it('confirms a root agent close by killing its window', () => {
    const seeded = applyPaneRoleToState(
      applyTmuxSnapshotToState(freshState(), baseSnapshot()),
      '%1',
      'root_agent',
    );
    const withDialog = reduceIntent(seeded, { type: 'close-selected-pane' }).state;

    const result = reduceIntent(withDialog, { type: 'confirm-close-pane' });
    expect(result.effects).toEqual([{ type: 'kill-window', windowId: '@1' }]);
    expect(result.state.ui.closePaneConfirmation).toBeNull();
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
    expect(state.layout.entries[tileForWindow('@1')].x).toBeGreaterThan(0);
    expect(state.layout.entries[tileForWindow('@1')].y).toBeGreaterThan(0);

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

  it('keeps the tmux tree local to the active tab and focuses panes without switching tabs', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const sidebarItems = buildSidebarItems(state);
    expect(sidebarItems.every((item) => item.sessionId === '$1')).toBe(true);

    const paneIndex = sidebarItems.findIndex((item) => item.paneId === '%2');
    const result = reduceIntent(state, { type: 'set-sidebar-selection', index: paneIndex });

    expect(result.state.ui.sidebarSelectedIdx).toBe(paneIndex);
    expect(result.state.ui.selectedPaneId).toBe('%2');
    expect(result.effects).toEqual([{ type: 'select-window', windowId: '@2' }]);
  });

  it('moves focus between sidebar sections and uses section-local j/k navigation', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyWorkItemsToState(state, [
      sampleWorkItem(),
      sampleWorkItem({
        work_id: 'work-s1-002',
        title: 'Artifact polish',
        topic: '#work-s1-002',
      }),
    ]);
    state = applyAgentDebugStateToState(state, {
      agents: [
        {
          agent_id: 'agent-1',
          agent_type: 'claude',
          agent_role: 'worker',
          tile_id: tileForPane('%2'),
          window_id: '@2',
          session_id: '$1',
          title: 'Agent',
          display_name: 'Agent 1',
          alive: true,
          chatter_subscribed: true,
          channels: ['#work-s1-002'],
        },
      ],
      agent_logs: [],
      tile_message_logs: [],
      connections: [],
      agent_displays: [],
      tile_signals: [],
      port_settings: [],
      channels: [],
      chatter: [],
    });

    state = reduceIntent(state, { type: 'move-sidebar-section', delta: -1 }).state;
    expect(state.ui.sidebarSection).toBe('agents');
    expect(state.ui.selectedPaneId).toBe('%2');

    state = reduceIntent(state, { type: 'move-sidebar-section', delta: -1 }).state;
    expect(state.ui.sidebarSection).toBe('work');
    expect(state.ui.selectedWorkId).toBe('work-s1-001');

    state = reduceIntent(state, { type: 'move-sidebar-selection', delta: 1 }).state;
    expect(state.ui.selectedWorkId).toBe('work-s1-002');

    state = reduceIntent(state, { type: 'move-sidebar-section', delta: -1 }).state;
    expect(state.ui.sidebarSection).toBe('settings');

    state = reduceIntent(state, { type: 'move-sidebar-section', delta: 1 }).state;
    expect(state.ui.sidebarSection).toBe('work');
    expect(state.ui.selectedWorkId).toBe('work-s1-002');
  });

  it('shows the same agent context menu for root and worker agents', () => {
    const base = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const worker = openPaneContextMenuInState(applyPaneRoleToState(base, '%1', 'claude'), '%1', 420, 240);
    const root = openPaneContextMenuInState(applyPaneRoleToState(base, '%1', 'root_agent'), '%1', 420, 240);

    expect(buildContextMenuItems(root)).toEqual(buildContextMenuItems(worker));
    expect(buildContextMenuItems(root)).toEqual([
      {
        id: 'claude-skills',
        label: 'Skills',
        kind: 'submenu',
        disabled: false,
        children: [{ id: 'skills-loading', label: 'Loading…', kind: 'status', disabled: true }],
      },
      { id: 'separator-skills', label: '', kind: 'separator', disabled: true },
      { id: 'close-shell', label: 'Close Shell', kind: 'action', disabled: false },
      { id: 'separator-claude', label: '', kind: 'separator', disabled: true },
      { id: 'claude-label', label: 'Claude Commands', kind: 'label', disabled: true },
      { id: 'claude-loading', label: 'Loading…', kind: 'status', disabled: true },
    ]);
  });

  it('prefers backend-provided pane roles over title-based browser guesses', () => {
    const state = applyTmuxSnapshotToState(freshState(), {
      ...baseSnapshot(),
      windows: [
        { ...baseSnapshot().windows[0], name: 'Browser' },
        ...baseSnapshot().windows.slice(1),
      ],
      panes: [
        { ...baseSnapshot().panes[0], title: 'Browser', role: 'regular' },
        ...baseSnapshot().panes.slice(1),
      ],
    });

    const projection = buildTestDriverProjection(state, baseTestDriverStatus());
    expect(projection.active_tab_terminals.find((term) => term.id === tileForPane('%1'))?.kind).toBe('regular');
  });

  it('surfaces one current agent entry per current agent tile and excludes stale non-agent bindings', () => {
    let state = applyTmuxSnapshotToState(freshState(), {
      ...baseSnapshot(),
      active_window_id: '@1',
      windows: [
        { ...baseSnapshot().windows[0], name: 'Root' },
        { ...baseSnapshot().windows[1], id: '@4', tile_id: tileForWindow('@4'), index: 1, name: 'Worker-1', pane_ids: ['%4'] },
        { ...baseSnapshot().windows[2], id: '@5', tile_id: tileForWindow('@5'), session_id: '$1', session_name: 'Main', active: false, index: 2, name: 'Worker-2', pane_ids: ['%5'], cols: 90, rows: 28 },
        { ...baseSnapshot().windows[2], id: '@6', tile_id: tileForWindow('@6'), session_id: '$1', session_name: 'Main', active: false, index: 3, name: 'Browser', pane_ids: ['%6'], cols: 90, rows: 28 },
      ],
      panes: [
        { ...baseSnapshot().panes[0], title: 'Root', role: 'root_agent' },
        { ...baseSnapshot().panes[1], id: '%4', tile_id: tileForPane('%4'), window_id: '@4', window_index: 1, title: 'Worker-1', command: '2.1.81', role: 'claude' },
        { ...baseSnapshot().panes[2], id: '%5', tile_id: tileForPane('%5'), session_id: '$1', window_id: '@5', window_index: 2, title: 'Worker-2', command: '2.1.81', active: false, role: 'claude' },
        { ...baseSnapshot().panes[2], id: '%6', tile_id: tileForPane('%6'), session_id: '$1', window_id: '@6', window_index: 3, title: 'Browser', command: 'zsh', active: false, role: 'browser' },
      ],
      sessions: [
        { ...baseSnapshot().sessions[0], window_ids: ['@1', '@4', '@5', '@6'], active_window_id: '@1' },
        baseSnapshot().sessions[1],
      ],
    });
    state = applyAgentDebugStateToState(state, {
      agents: [
        {
          agent_id: 'root:$1',
          agent_type: 'claude',
          agent_role: 'root',
          tile_id: tileForPane('%1'),
          window_id: '@1',
          session_id: '$1',
          title: 'Root',
          display_name: 'Root',
          alive: true,
          chatter_subscribed: true,
          channels: [],
        },
        {
          agent_id: 'worker-1-live',
          agent_type: 'claude',
          agent_role: 'worker',
          tile_id: tileForPane('%4'),
          window_id: '@4',
          session_id: '$1',
          title: 'Agent',
          display_name: 'Agent 1',
          alive: true,
          chatter_subscribed: true,
          channels: [],
        },
        {
          agent_id: 'worker-2-dead',
          agent_type: 'claude',
          agent_role: 'worker',
          tile_id: tileForPane('%5'),
          window_id: '@5',
          session_id: '$1',
          title: 'Agent',
          display_name: 'Agent 2',
          alive: false,
          chatter_subscribed: true,
          channels: [],
        },
        {
          agent_id: 'stale-browser-binding',
          agent_type: 'claude',
          agent_role: 'worker',
          tile_id: tileForPane('%6'),
          window_id: '@6',
          session_id: '$1',
          title: 'Agent',
          display_name: 'Agent 999',
          alive: false,
          chatter_subscribed: true,
          channels: [],
        },
      ],
      agent_logs: [],
      tile_message_logs: [],
      connections: [],
      agent_displays: [],
      tile_signals: [],
      port_settings: [],
      channels: [],
      chatter: [],
    });

    appState.set(state);
    expect(get(agentInfos).map((agent) => agent.tile_id)).toEqual([
      tileForPane('%4'),
      tileForPane('%5'),
      tileForPane('%1'),
    ]);
  });
});

describe('buildCanvasConnections', () => {
  it('builds a connection line for parent-child windows in the active tab', () => {
    const state = applyTmuxSnapshotToState(freshState(), {
      ...baseSnapshot(),
      windows: [
        { ...baseSnapshot().windows[0] },
        { ...baseSnapshot().windows[1], parent_window_id: '@1', parent_window_source: 'hook' },
        { ...baseSnapshot().windows[2] },
      ],
    });

    const connections = buildCanvasConnections(state);
    expect(connections).toHaveLength(1);
    expect(connections[0].parentWindowId).toBe('@1');
    expect(connections[0].childWindowId).toBe('@2');
    expect(connections[0].path).toMatch(/^M [\d.-]+ [\d.-]+(?: (?:L [\d.-]+ [\d.-]+|C [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+))+$/);
    expect(connections[0].path).not.toContain(' Q ');
  });

  it('does not draw manual parent-child lineage lines', () => {
    const state = applyTmuxSnapshotToState(freshState(), {
      ...baseSnapshot(),
      windows: [
        { ...baseSnapshot().windows[0] },
        { ...baseSnapshot().windows[1], parent_window_id: '@1', parent_window_source: 'manual' },
        { ...baseSnapshot().windows[2] },
      ],
    });

    expect(buildCanvasConnections(state)).toHaveLength(0);
  });
});

describe('buildNetworkCallSignals', () => {
  it('derives a direct wire signal from a network_call log entry', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyPaneRoleToState(state, '%1', 'claude');
    state = applyAgentDebugStateToState(state, {
      agents: [
        {
          agent_id: 'agent-1',
          agent_type: 'claude',
          agent_role: 'worker',
          tile_id: tileForPane('%1'),
          window_id: '@1',
          session_id: '$1',
          title: 'Agent',
          display_name: 'Agent 1',
          alive: true,
          chatter_subscribed: true,
          channels: [],
        },
      ],
      channels: [],
      chatter: [],
      agent_logs: [],
      tile_message_logs: [],
      agent_displays: [],
      tile_signals: [],
      port_settings: [],
      connections: [
        {
          session_id: '$1',
          from_tile_id: tileForPane('%1'),
          from_port: 'right',
          to_tile_id: tileForPane('%2'),
          to_port: 'left',
        },
      ],
    });

    const signals = buildNetworkCallSignals(state, [
      {
        session_id: '$1',
        layer: 'network',
        channel: 'socket',
        target_id: tileForPane('%2'),
        target_kind: 'network',
        wrapper_command: 'network_call',
        message_name: 'output_read',
        caller_tile_id: tileForPane('%1'),
        args: {},
        related_tile_ids: [tileForPane('%1'), tileForPane('%2')],
        outcome: 'ok',
        duration_ms: 8,
        timestamp_ms: 1000,
      },
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.segments).toHaveLength(1);
    expect(signals[0]?.segments[0]?.connectionKey).toBe(`${tileForPane('%1')}:right-${tileForPane('%2')}:left`);
    expect(signals[0]?.segments[0]?.senderTileId).toBe(tileForPane('%1'));
    expect(signals[0]?.segments[0]?.senderPort).toBe('right');
    expect(signals[0]?.segments[0]?.receiverTileId).toBe(tileForPane('%2'));
    expect(signals[0]?.segments[0]?.receiverPort).toBe('left');
    expect(signals[0]?.segments[0]?.path).toMatch(/^M [\d.-]+ [\d.-]+(?: (?:L [\d.-]+ [\d.-]+|C [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+))+$/);
    expect(signals[0]?.segments[0]?.reverse).toBe(false);
    expect(signals[0]?.totalDurationMs).toBeGreaterThan(0);
  });

  it('breaks a multi-hop network_call into ordered wire segments', () => {
    let state = applyTmuxSnapshotToState(freshState(), {
      ...baseSnapshot(),
      windows: [
        { ...baseSnapshot().windows[0] },
        { ...baseSnapshot().windows[1] },
        { ...baseSnapshot().windows[2], id: '@4', tile_id: tileForWindow('@4'), session_id: '$1', session_name: 'Main', active: false, index: 2, name: 'relay', pane_ids: ['%4'], cols: 90, rows: 28 },
      ],
      panes: [
        { ...baseSnapshot().panes[0], role: 'claude', title: 'Worker' },
        { ...baseSnapshot().panes[1], title: 'Relay', command: 'zsh' },
        { ...baseSnapshot().panes[2], id: '%4', tile_id: tileForPane('%4'), session_id: '$1', window_id: '@4', window_index: 2, pane_index: 0, cols: 90, rows: 28, title: 'Target', command: 'zsh', active: false, dead: false },
      ],
      sessions: [
        { ...baseSnapshot().sessions[0], window_ids: ['@1', '@2', '@4'], active_window_id: '@1' },
        baseSnapshot().sessions[1],
      ],
      active_window_id: '@1',
      active_pane_id: '%1',
    });
    state = applyPaneRoleToState(state, '%1', 'claude');
    state = applyAgentDebugStateToState(state, {
      agents: [
        {
          agent_id: 'agent-1',
          agent_type: 'claude',
          agent_role: 'worker',
          tile_id: tileForPane('%1'),
          window_id: '@1',
          session_id: '$1',
          title: 'Agent',
          display_name: 'Agent 1',
          alive: true,
          chatter_subscribed: true,
          channels: [],
        },
      ],
      channels: [],
      chatter: [],
      agent_logs: [],
      tile_message_logs: [],
      agent_displays: [],
      tile_signals: [],
      port_settings: [],
      connections: [
        {
          session_id: '$1',
          from_tile_id: tileForPane('%1'),
          from_port: 'right',
          to_tile_id: tileForPane('%2'),
          to_port: 'left',
        },
        {
          session_id: '$1',
          from_tile_id: tileForPane('%2'),
          from_port: 'right',
          to_tile_id: tileForPane('%4'),
          to_port: 'left',
        },
      ],
    });

    const signals = buildNetworkCallSignals(state, [
      {
        session_id: '$1',
        layer: 'network',
        channel: 'mcp',
        target_id: tileForPane('%4'),
        target_kind: 'network',
        wrapper_command: 'network_call',
        message_name: 'output_read',
        caller_tile_id: tileForPane('%1'),
        args: {},
        related_tile_ids: [tileForPane('%1'), tileForPane('%4')],
        outcome: 'ok',
        duration_ms: 10,
        timestamp_ms: 2000,
      },
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.segments).toHaveLength(2);
    expect(signals[0]?.segments[0]).toMatchObject({
      senderTileId: tileForPane('%1'),
      senderPort: 'right',
      receiverTileId: tileForPane('%2'),
      receiverPort: 'left',
    });
    expect(signals[0]?.segments[1]).toMatchObject({
      senderTileId: tileForPane('%2'),
      senderPort: 'right',
      receiverTileId: tileForPane('%4'),
      receiverPort: 'left',
    });
    expect(signals[0]?.segments[1]?.delayMs).toBeGreaterThan(signals[0]?.segments[0]?.delayMs ?? 0);
  });
});

describe('buildCanvasWorkCards', () => {
  it('does not auto-select work just because the active tab has work items', () => {
    const state = applyWorkItemsToState(
      applyTmuxSnapshotToState(freshState(), baseSnapshot()),
      [sampleWorkItem()],
    );

    expect(state.ui.selectedWorkId).toBeNull();
    expect(state.ui.sidebarSection).toBe('tmux');
  });

  it('builds one work card per active-session item and places them to the right of terminal tiles', () => {
    const state = applyWorkItemsToState(
      applyTmuxSnapshotToState(freshState(), baseSnapshot()),
      [
        sampleWorkItem(),
        sampleWorkItem({
          work_id: 'work-s1-002',
          title: 'Artifact polish',
          topic: '#work-s1-002',
        }),
        sampleWorkItem({
          work_id: 'work-s2-001',
          session_id: '$2',
          title: 'Build PRD',
          topic: '#work-s2-001',
        }),
      ],
    );

    state.layout.entries[tileForWindow('@1')] = { x: 100, y: 80, width: 640, height: 400 };
    state.layout.entries[tileForWindow('@2')] = { x: 860, y: 120, width: 640, height: 400 };
    state.layout.entries[tileForWindow('@3')] = { x: 40, y: 60, width: 640, height: 400 };

    const cards = buildCanvasWorkCards(state);

    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.workId)).toEqual(['work-s1-001', 'work-s1-002']);
    expect(cards[0].x).toBeGreaterThan(1500);
    expect(cards[0].y).toBe(80);
    expect(cards[1].y).toBeGreaterThan(cards[0].y + cards[0].height);
  });

  it('creates a persisted layout entry for new work items and uses that layout on the canvas', () => {
    const state = applyWorkItemsToState(
      applyTmuxSnapshotToState(freshState(), baseSnapshot()),
      [sampleWorkItem()],
    );

    expect(state.layout.entries[tileForWork('work-s1-001')]).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      width: 360,
      height: 320,
    });

    state.layout.entries[tileForWork('work-s1-001')] = {
      x: 2220,
      y: 420,
      width: 480,
      height: 360,
    };

    const cards = buildCanvasWorkCards(state);
    expect(cards).toEqual([
      {
        workId: 'work-s1-001',
        tileId: tileForWork('work-s1-001'),
        x: 2220,
        y: 420,
        width: 480,
        height: 360,
      },
    ]);
  });

  it('tracks minimized pane and work tiles separately from visible canvas projections', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 100, y: 80, width: 640, height: 400 };
    state.layout.entries[tileForWindow('@2')] = { x: 860, y: 120, width: 640, height: 400 };
    state = applyWorkItemsToState(state, [sampleWorkItem()]);
    state.layout.entries[tileForWork('work-s1-001')] = { x: 1540, y: 90, width: 360, height: 320 };
    appState.set(state);

    togglePaneMinimized('%1');
    toggleWorkCardMinimized('work-s1-001');

    const allTerminals = get(activeTabTerminals);
    const visibleTerminals = get(activeTabVisibleTerminals);
    const allWorkCards = get(activeTabWorkCards);
    const visibleWorkCards = get(activeTabVisibleWorkCards);

    expect(allTerminals.find((term) => term.id === '%1')).toMatchObject({ minimized: true });
    expect(allWorkCards.find((card) => card.workId === 'work-s1-001')).toMatchObject({ minimized: true });
    expect(visibleTerminals.map((term) => term.id)).toEqual(['%2']);
    expect(visibleWorkCards).toEqual([]);

    restoreMinimizedTile(tileForPane('%1'));
    restoreMinimizedTile(tileForWork('work-s1-001'));

    expect(get(activeTabVisibleTerminals).map((term) => term.id)).toEqual(['%1', '%2']);
    expect(get(activeTabVisibleWorkCards).map((card) => card.workId)).toEqual(['work-s1-001']);
  });

  it('fits the canvas to only non-minimized tiles', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 80, y: 100, width: 320, height: 200 };
    state.layout.entries[tileForWindow('@2')] = { x: 2200, y: 120, width: 640, height: 400 };
    appState.set(state);
    vi.stubGlobal('window', {
      clearTimeout,
      innerHeight: 900,
      innerWidth: 1400,
      setTimeout,
    });

    togglePaneMinimized('%2');
    fitCanvasToActiveTab(1400, 846);

    expect(get(canvasState)).toEqual({
      zoom: 2,
      panX: 220,
      panY: 23,
    });
    vi.unstubAllGlobals();
  });
});

describe('context menu state', () => {
  it('opens a canvas context menu with click-derived world coordinates and dismisses it locally', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.ui.canvas = { panX: 100, panY: 50, zoom: 2 };

    state = openCanvasContextMenuInState(state, 320, 250);
    expect(state.ui.contextMenu).toEqual({
      open: true,
      target: 'canvas',
      paneId: null,
      tileId: null,
      portId: null,
      clientX: 320,
      clientY: 250,
      worldX: 110,
      worldY: 100,
      claudeCommands: [],
      claudeSkills: [],
      loadingClaudeCommands: false,
      claudeCommandsError: null,
    });

    state = dismissContextMenuInState(state);
    expect(state.ui.contextMenu).toBeNull();
  });

  it('opens a pane context menu, selects the pane, and derives regular-tile actions', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = openPaneContextMenuInState(state, '%2', 640, 360);

    expect(state.ui.selectedPaneId).toBe('%2');
    expect(state.ui.contextMenu?.target).toBe('pane');
    expect(state.ui.contextMenu?.paneId).toBe('%2');
    expect(state.ui.contextMenu?.tileId).toBe(tileForPane('%2'));
    expect(state.ui.contextMenu?.portId).toBeNull();
    expect(buildContextMenuItems(state)).toEqual([
      { id: 'close-shell', label: 'Close Shell', kind: 'action', disabled: false },
    ]);
  });

  it('opens a port context menu with effective access and networking selections', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.network.portSettings = [
      {
        session_id: '$1',
        tile_id: tileForPane('%2'),
        port: 'right',
        access_mode: 'read',
        networking_mode: 'gateway',
      },
    ];

    state = openPortContextMenuInState(state, tileForPane('%2'), 'right', 700, 340);

    expect(state.ui.contextMenu).toMatchObject({
      target: 'port',
      tileId: tileForPane('%2'),
      portId: 'right',
      paneId: '%2',
      clientX: 700,
      clientY: 340,
    });
    expect(buildContextMenuItems(state)).toEqual([
      { id: 'port-label', label: 'Port right', kind: 'label', disabled: true },
      {
        id: 'port-access',
        label: 'Access',
        kind: 'submenu',
        disabled: false,
        children: [
          { id: 'port-access:read', label: 'Read', kind: 'action', disabled: false, selected: true },
          { id: 'port-access:read_write', label: 'Read/Write', kind: 'action', disabled: false, selected: false },
        ],
      },
      {
        id: 'port-networking',
        label: 'Networking',
        kind: 'submenu',
        disabled: false,
        children: [
          { id: 'port-networking:broadcast', label: 'Broadcast', kind: 'action', disabled: false, selected: false },
          { id: 'port-networking:gateway', label: 'Gateway', kind: 'action', disabled: false, selected: true },
        ],
      },
    ]);
  });

  it('maps port menu selections to network port setting effects', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = openPortContextMenuInState(state, tileForPane('%2'), 'right', 700, 340);

    expect(reduceContextMenuSelection(state, 'port-access:read').effects).toEqual([
      { type: 'set-network-port-settings', tileId: tileForPane('%2'), port: 'right', accessMode: 'read', networkingMode: null },
    ]);

    expect(reduceContextMenuSelection(state, 'port-networking:gateway').effects).toEqual([
      { type: 'set-network-port-settings', tileId: tileForPane('%2'), port: 'right', accessMode: null, networkingMode: 'gateway' },
    ]);
  });

  it('derives browser-tile Load submenu items from browser extension pages', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyPaneRoleToState(state, '%2', 'browser');
    state.browserExtensionPages = [
      { label: 'Checkers', path: 'extensions/browser/checkers/index.html' },
      { label: 'Pong', path: 'extensions/browser/pong/index.html' },
    ];
    state = openPaneContextMenuInState(state, '%2', 640, 360);

    expect(buildContextMenuItems(state)).toEqual([
      {
        id: 'browser-load',
        label: 'Load',
        kind: 'submenu',
        disabled: false,
        children: [
          { id: 'browser-load:extensions/browser/checkers/index.html', label: 'Checkers', kind: 'action', disabled: false },
          { id: 'browser-load:extensions/browser/pong/index.html', label: 'Pong', kind: 'action', disabled: false },
        ],
      },
      { id: 'separator-browser-load', label: '', kind: 'separator', disabled: true },
      { id: 'close-shell', label: 'Close Browser', kind: 'action', disabled: false },
    ]);
  });

  it('maps browser Load submenu selection to a browser file-load effect', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyPaneRoleToState(state, '%2', 'browser');
    state.browserExtensionPages = [
      { label: 'Checkers', path: 'extensions/browser/checkers/index.html' },
    ];
    state = openPaneContextMenuInState(state, '%2', 640, 360);

    const selected = reduceContextMenuSelection(state, 'browser-load:extensions/browser/checkers/index.html');
    expect(selected.state.ui.contextMenu).toBeNull();
    expect(selected.state.ui.selectedPaneId).toBe('%2');
    expect(selected.effects).toEqual([
      { type: 'load-browser-file', paneId: '%2', path: 'extensions/browser/checkers/index.html' },
    ]);
  });

  it('maps canvas New Shell selection to tmux window creation and a pending click placement', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.ui.canvas = { panX: 100, panY: 50, zoom: 2 };
    state = openCanvasContextMenuInState(state, 320, 250);

    expect(buildContextMenuItems(state).map((item) => item.id)).toEqual([
      'new-shell',
      'new-agent',
      'new-browser',
      'new-work',
    ]);

    const selected = reduceContextMenuSelection(state, 'new-shell');
    expect(selected.effects).toEqual([{ type: 'new-window', sessionId: '$1' }]);
    expect(selected.state.ui.contextMenu).toBeNull();
    expect(selected.state.ui.pendingSpawnPlacement).toEqual({
      sessionId: '$1',
      worldX: 110,
      worldY: 100,
    });
  });

  it('maps canvas Agent, Browser, and Work selections to their matching actions', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.ui.canvas = { panX: 100, panY: 50, zoom: 2 };
    state = openCanvasContextMenuInState(state, 320, 250);

    expect(reduceContextMenuSelection(state, 'new-agent').effects).toEqual([
      { type: 'new-agent-window', sessionId: '$1' },
    ]);

    expect(reduceContextMenuSelection(state, 'new-browser').effects).toEqual([
      { type: 'new-browser-window', sessionId: '$1' },
    ]);

    expect(reduceContextMenuSelection(state, 'new-work').effects).toEqual([
      {
        type: 'open-work-dialog',
        placement: { sessionId: '$1', worldX: 110, worldY: 100 },
      },
    ]);
  });

  it('applies the pending click placement to the next created window instead of default layout', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.ui.canvas = { panX: 100, panY: 50, zoom: 2 };
    state = openCanvasContextMenuInState(state, 320, 250);
    state = reduceContextMenuSelection(state, 'new-shell').state;

    const next = applyTmuxSnapshotToState(state, {
      ...baseSnapshot(),
      version: 2,
      sessions: [
        { id: '$1', name: 'Main', active: true, window_ids: ['@1', '@2', '@4'], active_window_id: '@1' },
        { id: '$2', name: 'Build', active: false, window_ids: ['@3'], active_window_id: '@3' },
      ],
      windows: [
        ...baseSnapshot().windows,
        {
          id: '@4',
          tile_id: tileForWindow('@4'),
          session_id: '$1',
          session_name: 'Main',
          index: 2,
          name: 'shell-3',
          active: false,
          cols: 80,
          rows: 24,
          pane_ids: ['%4'],
        },
      ],
      panes: [
        ...baseSnapshot().panes,
        {
          id: '%4',
          tile_id: tileForPane('%4'),
          session_id: '$1',
          window_id: '@4',
          window_index: 2,
          pane_index: 0,
          cols: 80,
          rows: 24,
          title: 'shell-3',
          command: 'zsh',
          active: false,
          dead: false,
        },
      ],
    });

    expect(next.layout.entries[tileForWindow('@4')]).toMatchObject({
      x: 120,
      y: 100,
    });
    expect(next.ui.pendingSpawnPlacement).toBeNull();
  });

  it('maps regular Close Shell selection through the existing close path', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = openPaneContextMenuInState(state, '%2', 640, 360);

    const selected = reduceContextMenuSelection(state, 'close-shell');
    expect(selected.effects).toEqual([{ type: 'kill-window', windowId: '@2' }]);
    expect(selected.state.ui.contextMenu).toBeNull();
    expect(selected.state.ui.selectedPaneId).toBe('%2');
  });

  it('builds Claude-specific items for explicit Claude panes and excludes output panes', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyPaneRoleToState(state, '%1', 'claude');
    state = openPaneContextMenuInState(state, '%1', 600, 320);

    expect(buildContextMenuItems(state)).toEqual([
      { id: 'claude-skills', label: 'Skills', kind: 'submenu', disabled: false, children: [{ id: 'skills-loading', label: 'Loading…', kind: 'status', disabled: true }] },
      { id: 'separator-skills', label: '', kind: 'separator', disabled: true },
      { id: 'close-shell', label: 'Close Shell', kind: 'action', disabled: false },
      { id: 'separator-claude', label: '', kind: 'separator', disabled: true },
      { id: 'claude-label', label: 'Claude Commands', kind: 'label', disabled: true },
      { id: 'claude-loading', label: 'Loading…', kind: 'status', disabled: true },
    ]);

    state = {
      ...state,
      ui: {
        ...state.ui,
        contextMenu: state.ui.contextMenu && {
          ...state.ui.contextMenu,
          loadingClaudeCommands: false,
          claudeCommands: [
            { name: 'clear', execution: 'execute', source: 'builtin' },
            { name: 'model', execution: 'insert', source: 'builtin' },
            { name: 'codex', execution: 'execute', source: 'skill' },
          ],
          claudeSkills: [
            { name: 'codex', execution: 'execute', source: 'skill' },
          ],
        },
      },
    };

    expect(buildContextMenuItems(state)).toEqual([
      {
        id: 'claude-skills',
        label: 'Skills',
        kind: 'submenu',
        disabled: false,
        children: [{ id: 'claude-command:codex', label: '/codex', kind: 'action', disabled: false }],
      },
      { id: 'separator-skills', label: '', kind: 'separator', disabled: true },
      { id: 'close-shell', label: 'Close Shell', kind: 'action', disabled: false },
      { id: 'separator-claude', label: '', kind: 'separator', disabled: true },
      { id: 'claude-label', label: 'Claude Commands', kind: 'label', disabled: true },
      { id: 'claude-command:clear', label: '/clear', kind: 'action', disabled: false },
      { id: 'claude-command:model', label: '/model', kind: 'action', disabled: false },
    ]);

    state = applyPaneRoleToState(state, '%1', 'output');
    expect(buildContextMenuItems(state)).toEqual([
      { id: 'close-shell', label: 'Close Shell', kind: 'action', disabled: false },
    ]);
  });

  it('routes Claude command items to execute-or-insert pane writes', () => {
    let state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state = applyPaneRoleToState(state, '%1', 'claude');
    state = openPaneContextMenuInState(state, '%1', 600, 320);
    state = {
      ...state,
      ui: {
        ...state.ui,
        contextMenu: state.ui.contextMenu && {
          ...state.ui.contextMenu,
          loadingClaudeCommands: false,
          claudeCommands: [
            { name: 'clear', execution: 'execute', source: 'builtin' },
            { name: 'model', execution: 'insert', source: 'builtin' },
          ],
          claudeSkills: [],
        },
      },
    };

    const executed = reduceContextMenuSelection(state, 'claude-command:clear');
    expect(executed.state.ui.contextMenu).toBeNull();
    expect(executed.state.ui.selectedPaneId).toBe('%1');
    expect(executed.effects).toEqual([{ type: 'write-pane', paneId: '%1', data: '/clear\r' }]);

    const inserted = reduceContextMenuSelection(state, 'claude-command:model');
    expect(inserted.effects).toEqual([{ type: 'write-pane', paneId: '%1', data: '/model ' }]);
  });

  it('loads menu data for root agents when opening the pane context menu', async () => {
    tauriMocks.getClaudeMenuDataForPane.mockResolvedValue({
      commands: [
        { name: 'model', execution: 'insert', source: 'builtin' },
      ],
      skills: [
        { name: 'herd-root', execution: 'execute', source: 'skill' },
      ],
    });

    appState.set(
      applyPaneRoleToState(
        applyTmuxSnapshotToState(freshState(), baseSnapshot()),
        '%1',
        'root_agent',
      ),
    );

    openPaneContextMenu('%1', 600, 320);
    expect(tauriMocks.getClaudeMenuDataForPane).toHaveBeenCalledWith('%1');

    await Promise.resolve();

    expect(get(appState).ui.contextMenu).toMatchObject({
      paneId: '%1',
      loadingClaudeCommands: false,
      claudeCommandsError: null,
      claudeCommands: [{ name: 'model', execution: 'insert', source: 'builtin' }],
      claudeSkills: [{ name: 'herd-root', execution: 'execute', source: 'skill' }],
    });
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

  it('maps sudo command bar verbs', () => {
    expect(parseCommandBarCommand('sudo please inspect local work')).toEqual({
      type: 'sudo',
      message: 'please inspect local work',
    });
    expect(parseCommandBarCommand('sudo')).toEqual({ type: 'none' });
  });

  it('maps dm and cm command bar verbs', () => {
    expect(parseCommandBarCommand('dm 10 hi there')).toEqual({
      type: 'dm',
      target: '10',
      message: 'hi there',
    });
    expect(parseCommandBarCommand('cm hey all!')).toEqual({
      type: 'cm',
      message: 'hey all!',
    });
    expect(parseCommandBarCommand('dm')).toEqual({ type: 'none' });
    expect(parseCommandBarCommand('dm 10')).toEqual({ type: 'none' });
    expect(parseCommandBarCommand('cm')).toEqual({ type: 'none' });
  });
});

describe('executeCommandBarCommand', () => {
  it('routes sudo through the root message invoke', async () => {
    tauriMocks.sendRootMessageCommand.mockResolvedValue(undefined);

    await executeCommandBarCommand('sudo please inspect local work');

    expect(tauriMocks.sendRootMessageCommand).toHaveBeenCalledWith('please inspect local work');
  });

  it('routes dm and cm through the user message invokes', async () => {
    tauriMocks.sendDirectMessageCommand.mockResolvedValue(undefined);
    tauriMocks.sendPublicMessageCommand.mockResolvedValue(undefined);

    await executeCommandBarCommand('dm 10 hi there');
    await executeCommandBarCommand('cm hey all!');

    expect(tauriMocks.sendDirectMessageCommand).toHaveBeenCalledWith('10', 'hi there');
    expect(tauriMocks.sendPublicMessageCommand).toHaveBeenCalledWith('hey all!');
  });
});

describe('autoArrange', () => {
  it('anchors the first arrangement on the selected tile and persists the new layout', async () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 100, y: 100, width: 640, height: 400 };
    state.layout.entries[tileForWindow('@2')] = { x: 880, y: 60, width: 640, height: 400 };
    state.ui.selectedPaneId = '%1';
    appState.set(state);

    await autoArrange('$1');

    const next = get(appState);
    expect(next.layout.entries[tileForWindow('@1')]).toEqual({ x: 100, y: 100, width: 640, height: 400 });
    expect(next.layout.entries[tileForWindow('@2')]).toEqual({ x: 100, y: -700, width: 640, height: 400 });
    expect(next.ui.arrangementModeBySession['$1']).toBe('circle');
    expect(next.ui.arrangementCycleBySession['$1']).toBe(1);
    expect(tauriMocks.saveLayoutState).toHaveBeenCalledTimes(2);
    expect(tauriMocks.saveLayoutState).toHaveBeenNthCalledWith(1, tileForWindow('@1'), 100, 100, 640, 400);
    expect(tauriMocks.saveLayoutState).toHaveBeenNthCalledWith(2, tileForWindow('@2'), 100, -700, 640, 400);
  });

  it('advances through the remaining arrangement cycle on repeated calls', async () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 100, y: 100, width: 640, height: 400 };
    state.layout.entries[tileForWindow('@2')] = { x: 880, y: 60, width: 640, height: 400 };
    state.ui.selectedPaneId = '%1';
    appState.set(state);

    await autoArrange('$1');
    const first = get(appState).layout.entries[tileForWindow('@2')];

    await autoArrange('$1');
    const second = get(appState).layout.entries[tileForWindow('@2')];

    await autoArrange('$1');
    const third = get(appState).layout.entries[tileForWindow('@2')];

    await autoArrange('$1');
    const fourth = get(appState).layout.entries[tileForWindow('@2')];

    await autoArrange('$1');
    const fifth = get(appState).layout.entries[tileForWindow('@2')];

    expect(first).toEqual({ x: 100, y: -700, width: 640, height: 400 });
    expect(second).toEqual({ x: 500, y: -580, width: 640, height: 400 });
    expect(third).toEqual({ x: 100, y: 540, width: 640, height: 400 });
    expect(fourth).toEqual({ x: 780, y: 100, width: 640, height: 400 });
    expect(fifth).toEqual({ x: 780, y: 100, width: 640, height: 400 });
  });

  it('adds circle and snowflake radial arrangements around the selected tile', async () => {
    const state = applyTmuxSnapshotToState(freshState(), snapshotWithMainWindowCount(7));
    for (const windowId of state.tmux.sessions['$1'].window_ids) {
      state.layout.entries[tileForWindow(windowId as keyof typeof TILE_BY_WINDOW)] = {
        x: 100,
        y: 100,
        width: 640,
        height: 400,
      };
    }
    state.ui.selectedPaneId = '%1';
    appState.set(state);

    await autoArrange('$1');
    const circle = get(appState).layout.entries;

    await autoArrange('$1');
    const snowflake = get(appState).layout.entries;

    await autoArrange('$1');
    await autoArrange('$1');
    await autoArrange('$1');
    const spiral = get(appState).layout.entries;

    expect(circle[tileForWindow('@1')]).toEqual({ x: 100, y: 100, width: 640, height: 400 });
    expect(circle[tileForWindow('@2')]).toEqual({ x: 100, y: -700, width: 640, height: 400 });
    expect(circle[tileForWindow('@4')]).toEqual({ x: 780, y: -300, width: 640, height: 400 });
    expect(circle[tileForWindow('@5')]).toEqual({ x: 780, y: 500, width: 640, height: 400 });

    expect(snowflake[tileForWindow('@1')]).toEqual({ x: 100, y: 100, width: 640, height: 400 });
    expect(snowflake[tileForWindow('@2')]).toEqual({ x: 500, y: -580, width: 640, height: 400 });
    expect(snowflake[tileForWindow('@4')]).toEqual({ x: 900, y: 100, width: 640, height: 400 });
    expect(snowflake[tileForWindow('@5')]).toEqual({ x: 500, y: 780, width: 640, height: 400 });

    expect(spiral[tileForWindow('@1')]).toEqual({ x: 100, y: 100, width: 640, height: 400 });
    expect(spiral[tileForWindow('@2')]).toEqual({ x: 780, y: 100, width: 640, height: 400 });
    expect(spiral[tileForWindow('@4')]).toEqual({ x: 780, y: 540, width: 640, height: 400 });
  });

  it('keeps all arranged windows non-overlapping across the full cycle', async () => {
    const state = applyTmuxSnapshotToState(freshState(), snapshotWithMainWindowCount(7));
    for (const windowId of state.tmux.sessions['$1'].window_ids) {
      state.layout.entries[tileForWindow(windowId as keyof typeof TILE_BY_WINDOW)] = {
        x: 100,
        y: 100,
        width: 640,
        height: 400,
      };
    }
    state.ui.selectedPaneId = '%1';
    appState.set(state);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await autoArrange('$1');
      const entries = get(appState).layout.entries;
      const arranged = state.tmux.sessions['$1'].window_ids.map(
        (windowId) => entries[tileForWindow(windowId as keyof typeof TILE_BY_WINDOW)],
      );

      for (let left = 0; left < arranged.length; left += 1) {
        for (let right = left + 1; right < arranged.length; right += 1) {
          expect(entriesOverlap(arranged[left], arranged[right])).toBe(false);
        }
      }
    }
  });

  it('reapplies the current arrangement mode when a new shell appears in the same session', async () => {
    const state = applyTmuxSnapshotToState(freshState(), snapshotWithMainWindowCount(4));
    for (const windowId of state.tmux.sessions['$1'].window_ids) {
      state.layout.entries[tileForWindow(windowId as keyof typeof TILE_BY_WINDOW)] = {
        x: 100,
        y: 100,
        width: 640,
        height: 400,
      };
    }
    state.ui.selectedPaneId = '%1';
    appState.set(state);

    await autoArrange('$1');
    const arranged = get(appState);
    const next = applyTmuxSnapshotToState(arranged, snapshotWithMainWindowCount(5));

    expect(next.ui.arrangementModeBySession['$1']).toBe('circle');
    expect(next.ui.arrangementCycleBySession['$1']).toBe(1);
    expect(next.layout.entries[tileForWindow('@1')]).toEqual({ x: 100, y: 100, width: 640, height: 400 });
    expect(next.layout.entries[tileForWindow('@2')]).toEqual({ x: 100, y: -700, width: 640, height: 400 });
    expect(next.layout.entries[tileForWindow('@4')]).toEqual({ x: 900, y: 100, width: 640, height: 400 });
    expect(next.layout.entries[tileForWindow('@5')]).toEqual({ x: 100, y: 900, width: 640, height: 400 });
    expect(next.layout.entries[tileForWindow('@6')]).toEqual({ x: -700, y: 100, width: 640, height: 400 });
  });

  it('arranges current-session tiles with ELK using network connections and preserves the selected-tile anchor', async () => {
    let state = applyTmuxSnapshotToState(freshState(), snapshotWithMainWindowCount(4));
    state = applyWorkItemsToState(state, [sampleWorkItem()]);
    state.layout.entries[tileForWindow('@1')] = { x: 120, y: 120, width: 320, height: 200 };
    state.layout.entries[tileForWindow('@2')] = { x: 900, y: 80, width: 420, height: 260 };
    state.layout.entries[tileForWindow('@4')] = { x: 520, y: 700, width: 360, height: 220 };
    state.layout.entries[tileForWork('work-s1-001')] = { x: 1440, y: 440, width: 300, height: 240 };
    state.ui.selectedPaneId = '%2';
    state.network.connections = [
      {
        session_id: '$1',
        from_tile_id: tileForWindow('@1'),
        from_port: 'right',
        to_tile_id: tileForWindow('@2'),
        to_port: 'left',
      },
      {
        session_id: '$1',
        from_tile_id: tileForWindow('@2'),
        from_port: 'right',
        to_tile_id: tileForWindow('@4'),
        to_port: 'left',
      },
      {
        session_id: '$1',
        from_tile_id: tileForWindow('@2'),
        from_port: 'bottom',
        to_tile_id: tileForWork('work-s1-001'),
        to_port: 'top',
      },
    ];
    appState.set(state);

    await autoArrangeWithElk('$1');

    const next = get(appState);
    const first = next.layout.entries[tileForWindow('@1')];
    const anchor = next.layout.entries[tileForWindow('@2')];
    const third = next.layout.entries[tileForWindow('@4')];
    const work = next.layout.entries[tileForWork('work-s1-001')];

    expect(next.ui.arrangementModeBySession['$1']).toBe('elk');
    expect(anchor).toEqual({ x: 900, y: 80, width: 420, height: 260 });
    expect(first.width).toBe(320);
    expect(third.width).toBe(360);
    expect(work.width).toBe(300);
    expect(first.x + first.width).toBeLessThanOrEqual(anchor.x);
    expect(anchor.x + anchor.width).toBeLessThanOrEqual(third.x);
    expect(work.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
    expect(entriesOverlap(first, anchor)).toBe(false);
    expect(entriesOverlap(anchor, third)).toBe(false);
    expect(entriesOverlap(anchor, work)).toBe(false);
    const persistedTileIds = tauriMocks.saveLayoutState.mock.calls.map(([entryId]) => entryId);
    expect(persistedTileIds).toEqual(expect.arrayContaining([
      tileForWindow('@1'),
      tileForWindow('@2'),
      tileForWindow('@4'),
      tileForWork('work-s1-001'),
    ]));
  });

  it('preserves elk mode across session growth without falling back to the lowercase cycle', () => {
    const initial = applyTmuxSnapshotToState(freshState(), snapshotWithMainWindowCount(4));
    initial.layout.entries[tileForWindow('@1')] = { x: 100, y: 100, width: 320, height: 220 };
    initial.layout.entries[tileForWindow('@2')] = { x: 900, y: 120, width: 420, height: 260 };
    initial.layout.entries[tileForWindow('@4')] = { x: 1500, y: 140, width: 360, height: 220 };
    initial.ui.arrangementModeBySession['$1'] = 'elk';
    initial.ui.arrangementCycleBySession['$1'] = 3;
    initial.network.connections = [
      {
        session_id: '$1',
        from_tile_id: tileForWindow('@1'),
        from_port: 'right',
        to_tile_id: tileForWindow('@2'),
        to_port: 'left',
      },
      {
        session_id: '$1',
        from_tile_id: tileForWindow('@2'),
        from_port: 'right',
        to_tile_id: tileForWindow('@4'),
        to_port: 'left',
      },
      {
        session_id: '$1',
        from_tile_id: tileForWindow('@4'),
        from_port: 'right',
        to_tile_id: tileForWindow('@5'),
        to_port: 'left',
      },
    ];

    const next = applyTmuxSnapshotToState(initial, snapshotWithMainWindowCount(5));
    expect(next.ui.arrangementModeBySession['$1']).toBe('elk');
    expect(next.ui.arrangementCycleBySession['$1']).toBe(3);
    expect(next.layout.entries[tileForWindow('@2')]).toEqual({ x: 900, y: 120, width: 420, height: 260 });
    expect(next.layout.entries[tileForWindow('@5')].width).toBe(640);
    expect(next.layout.entries[tileForWindow('@5')].height).toBe(400);
  });
});

describe('sidebar rename helpers', () => {
  it('builds a session rename command from the selected tree item', () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    const sessionIndex = buildSidebarItems(state).findIndex((item) => item.type === 'session' && item.sessionId === '$1');
    state.ui.sidebarSelectedIdx = sessionIndex;

    expect(buildSidebarRenameCommand(state)).toBe('tr Main');
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
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 640, height: 400 };
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

    expect(get(appState).layout.entries[tileForWindow('@1')]).toEqual({ x: 0, y: 0, width: 790, height: 464 });
    expect(tauriMocks.saveLayoutState).toHaveBeenCalledWith(tileForWindow('@1'), 0, 0, 790, 464);
  });

  it('does not snap unrelated tiles when another tile in the session is resized', async () => {
    const state = applyTmuxSnapshotToState(freshState(), baseSnapshot());
    state.layout.entries[tileForWindow('@1')] = { x: 0, y: 0, width: 640, height: 400 };
    state.layout.entries[tileForWindow('@2')] = { x: 500, y: 0, width: 540, height: 360 };
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

    expect(get(appState).layout.entries[tileForWindow('@1')]).toEqual({ x: 0, y: 0, width: 790, height: 464 });
    expect(get(appState).layout.entries[tileForWindow('@2')]).toEqual({ x: 500, y: 0, width: 540, height: 360 });
  });
});
