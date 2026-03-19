import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HerdTestClient } from './client';
import { terminalById, waitFor } from './helpers';
import { startIntegrationRuntime, type HerdIntegrationRuntime } from './runtime';

const VIEWPORT_WIDTH = 1400;
const VIEWPORT_HEIGHT = 846;

describe.sequential('in-app test driver', () => {
  let runtime: HerdIntegrationRuntime;
  let client: HerdTestClient;
  let createdSessionId: string | null = null;

  beforeAll(async () => {
    runtime = await startIntegrationRuntime();
    client = runtime.client;
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('boots with ready status, projection, and state tree access', async () => {
    const ping = await client.ping();
    expect(ping.pong).toBe(true);
    expect(ping.status.runtime_id).toBe(runtime.runtimeId);
    expect(ping.status.frontend_ready).toBe(true);
    expect(ping.status.bootstrap_complete).toBe(true);

    const status = await client.getStatus();
    expect(status.tmux_server_alive).toBe(true);
    expect(status.control_client_alive).toBe(true);

    const projection = await client.getProjection();
    const state = await client.getStateTree();
    expect(projection.active_tab_id).toBe(state.tmux.activeSessionId);
    expect(projection.active_tab_terminals.length).toBeGreaterThan(0);
    expect(projection.selected_pane_id).toBe(state.ui.selectedPaneId);
    expect(projection.sidebar.items.length).toBeGreaterThan(0);
    expect(projection.indicators.sock).toBe(true);
  });

  it('covers mode, help, sidebar, command bar, and tab creation through the typed driver', async () => {
    let projection = await client.getProjection();
    const paneId = projection.selected_pane_id;
    expect(paneId).toBeTruthy();

    await client.pressKeys([{ key: '?' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.help_open).toBe(true);

    await client.pressKeys([{ key: 'Escape' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.help_open).toBe(false);

    await client.pressKeys([{ key: 'b' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.sidebar.open).toBe(true);

    await client.pressKeys([{ key: 'Escape' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.sidebar.open).toBe(false);

    await client.pressKeys([{ key: 'i' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.mode).toBe('input');

    await client.pressKeys(
      [
        { key: 'e' },
        { key: 'c' },
        { key: 'h' },
        { key: 'o' },
        { key: ' ' },
        { key: 'd' },
        { key: 'r' },
        { key: 'i' },
        { key: 'v' },
        { key: 'e' },
        { key: 'r' },
        { key: 'Enter' },
      ],
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    await client.waitForIdle();
    const output = await client.readOutput(paneId!);
    expect(output.output).toContain('driver');

    await client.pressKeys([{ key: 'Escape', shift_key: true }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.mode).toBe('command');

    await client.pressKeys([{ key: ':' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.command_bar.open).toBe(true);

    await client.commandBarSetText('tn driver-tab');
    await client.commandBarSubmit();
    projection = await waitFor(
      'driver-tab creation',
      () => client.getProjection(),
      (nextProjection) => nextProjection.tabs.some((tab) => tab.name === 'driver-tab'),
      30_000,
      150,
    );

    const createdTab = projection.tabs.find((tab) => tab.name === 'driver-tab');
    expect(createdTab).toBeTruthy();
    createdSessionId = createdTab!.id;
    expect(projection.active_tab_id).toBe(createdSessionId);
  });

  it('covers shell spawn, tile selection/close, sidebar rename, and canvas actions through the typed driver', async () => {
    expect(createdSessionId).toBeTruthy();

    await client.toolbarSelectTab(createdSessionId!);
    await client.waitForIdle();

    let projection = await client.getProjection();
    expect(projection.active_tab_id).toBe(createdSessionId);
    expect(projection.active_tab_terminals).toHaveLength(1);

    const firstPaneId = projection.selected_pane_id;
    expect(firstPaneId).toBeTruthy();

    await client.pressKeys([{ key: 's' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await waitFor(
      'spawned shell tile',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === createdSessionId && nextProjection.active_tab_terminals.length > 1,
      30_000,
      150,
    );

    expect(projection.active_tab_terminals.length).toBeGreaterThan(1);

    const beforeCanvas = projection.canvas;

    await client.pressKeys([{ key: 'n' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.selected_pane_id).not.toBe(firstPaneId);

    const cycledPaneId = projection.selected_pane_id;
    expect(cycledPaneId).toBeTruthy();
    const beforeTile = terminalById(projection.active_tab_terminals, cycledPaneId!);

    await client.sidebarOpen();
    projection = await client.getProjection();
    expect(projection.sidebar.open).toBe(true);

    const renameTargetIndex = projection.sidebar.items.findIndex(
      (item) => item.sessionId === createdSessionId && item.type === 'window',
    );
    expect(renameTargetIndex).toBeGreaterThanOrEqual(0);

    await client.sidebarSelectItem(renameTargetIndex);
    await client.sidebarBeginRename();
    projection = await client.getProjection();
    expect(projection.command_bar.open).toBe(true);
    expect(projection.command_bar.text.length).toBeGreaterThan(0);
    await client.commandBarCancel();

    await client.tileDrag(cycledPaneId!, 80, 40);
    await client.waitForIdle();
    projection = await client.getProjection();
    const draggedTile = terminalById(projection.active_tab_terminals, cycledPaneId!);
    expect(draggedTile.x).toBe(beforeTile.x + 80);
    expect(draggedTile.y).toBe(beforeTile.y + 40);

    await client.tileResize(cycledPaneId!, beforeTile.width + 120, beforeTile.height + 80);
    await client.waitForIdle(30_000, 250);
    projection = await client.getProjection();
    const resizedTile = terminalById(projection.active_tab_terminals, cycledPaneId!);
    expect(resizedTile.width).toBeGreaterThanOrEqual(beforeTile.width + 100);
    expect(resizedTile.height).toBeGreaterThanOrEqual(beforeTile.height + 60);

    await client.canvasPan(50, 25);
    projection = await client.getProjection();
    expect(projection.canvas.panX).toBe(beforeCanvas.panX + 50);
    expect(projection.canvas.panY).toBe(beforeCanvas.panY + 25);

    await client.canvasZoomAt(400, 300, 1.1);
    projection = await client.getProjection();
    expect(projection.canvas.zoom).toBeGreaterThan(beforeCanvas.zoom);

    await client.tileTitleDoubleClick(cycledPaneId!, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.canvas.zoom).toBeGreaterThan(1);

    await client.canvasReset();
    projection = await client.getProjection();
    expect(projection.canvas.zoom).toBe(1);
    expect(projection.canvas.panX).toBe(0);
    expect(projection.canvas.panY).toBe(0);

    await client.pressKeys([{ key: 'x' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await waitFor(
      'closed spawned shell tile',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === createdSessionId && nextProjection.active_tab_terminals.length === 1,
      30_000,
      150,
    );
    expect(projection.close_tab_confirmation).toBeNull();
  });

  it('confirms multi-window tab closes through the typed driver only', async () => {
    await client.toolbarSelectTab(createdSessionId!);
    await client.waitForIdle();

    await client.pressKeys([{ key: 's' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    await waitFor(
      'second shell before tab close',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === createdSessionId && nextProjection.active_tab_terminals.length > 1,
      30_000,
      150,
    );

    let projection = await client.getProjection();
    const activeSessionId = projection.active_tab_id;
    expect(activeSessionId).toBe(createdSessionId);
    expect(projection.active_tab_terminals.length).toBeGreaterThan(1);

    await client.pressKeys([{ key: 'X' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.close_tab_confirmation?.sessionId).toBe(activeSessionId);
    expect(projection.close_tab_confirmation?.paneCount).toBeGreaterThan(1);

    await client.cancelCloseTab();
    projection = await client.getProjection();
    expect(projection.close_tab_confirmation).toBeNull();

    await client.pressKeys([{ key: 'X' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    await client.confirmCloseTab();
    await client.waitForIdle(30_000, 250);

    projection = await client.getProjection();
    expect(projection.tabs.some((tab) => tab.id === activeSessionId)).toBe(false);
    expect(projection.indicators.tmux).toBe(true);
    expect(projection.indicators.cc).toBe(true);
  });
});
