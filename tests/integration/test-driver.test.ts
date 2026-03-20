import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HerdTestClient } from './client';
import { createIsolatedTab, terminalById, waitFor } from './helpers';
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
    expect(projection.context_menu).toBeNull();
  });

  it('opens and dismisses typed context menus for the canvas and the selected tile', async () => {
    let projection = await client.getProjection();
    const selectedPaneId = projection.selected_pane_id;
    expect(selectedPaneId).toBeTruthy();

    await client.canvasContextMenu(240, 180);
    projection = await client.getProjection();
    expect(projection.context_menu?.target).toBe('canvas');
    expect(projection.context_menu?.items.map((item) => item.label)).toEqual(['New Shell']);

    await client.contextMenuDismiss();
    projection = await client.getProjection();
    expect(projection.context_menu).toBeNull();

    await client.tileContextMenu(selectedPaneId!, 480, 260);
    projection = await client.getProjection();
    expect(projection.context_menu?.target).toBe('pane');
    expect(projection.context_menu?.pane_id).toBe(selectedPaneId);
    expect(projection.context_menu?.items.map((item) => item.label)).toEqual(['Close Shell']);
  });

  it('creates a shell at the clicked point and closes a regular shell through context-menu selection', async () => {
    let projection = await client.getProjection();
    const initialCount = projection.active_tab_terminals.length;
    expect(initialCount).toBeGreaterThan(0);

    await client.canvasContextMenu(260, 200);
    projection = await client.getProjection();
    expect(projection.context_menu?.items.some((item) => item.id === 'new-shell')).toBe(true);

    await client.contextMenuSelect('new-shell');
    projection = await waitFor(
      'context-menu shell creation',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_terminals.length === initialCount + 1,
      30_000,
      150,
    );

    const createdTile = [...projection.active_tab_terminals].sort((left, right) => right.x - left.x)[0];
    expect(createdTile.x).toBeGreaterThanOrEqual(120);
    expect(createdTile.y).toBeGreaterThanOrEqual(90);

    await client.tileContextMenu(createdTile.id, 640, 320);
    projection = await client.getProjection();
    expect(projection.context_menu?.items.some((item) => item.id === 'close-shell')).toBe(true);

    await client.contextMenuSelect('close-shell');
    projection = await waitFor(
      'context-menu shell close',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_terminals.length === initialCount,
      30_000,
      150,
    );
    expect(projection.context_menu).toBeNull();
  });

  it('shows Claude commands only for Claude tiles and dispatches execute vs insert correctly', async () => {
    let projection = await createIsolatedTab(client, 'claude-menu');
    const paneId = projection.selected_pane_id;
    expect(paneId).toBeTruthy();

    await client.execInShell(paneId!, 'exec cat -vet');
    await client.waitForIdle(30_000, 250);
    await client.readOutput(paneId!);

    await client.setTileRole(paneId!, 'claude');
    await client.waitForIdle();

    await client.tileContextMenu(paneId!, 420, 240);
    projection = await waitFor(
      'Claude context menu commands',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.context_menu?.pane_id === paneId
        && nextProjection.context_menu.loading_claude_commands === false
        && nextProjection.context_menu.items.some((item) => item.id === 'claude-skills')
        && nextProjection.context_menu.items.some((item) => item.id === 'claude-command:clear')
        && nextProjection.context_menu.items.some((item) => item.id === 'claude-command:model'),
      30_000,
      150,
    );

    expect(projection.context_menu?.items[0]?.label).toBe('Skills');
    expect(projection.context_menu?.items[0]?.children?.map((item) => item.label)).toEqual(['/codex']);
    expect(projection.context_menu?.items.map((item) => item.label)).toContain('Close Shell');
    expect(projection.context_menu?.items.map((item) => item.label)).toContain('/clear');
    expect(projection.context_menu?.items.map((item) => item.label)).toContain('/model');

    await client.contextMenuSelect('claude-command:model');
    let output = await waitFor(
      'insert-only Claude command echo',
      () => client.readOutput(paneId!),
      (result) => result.output.includes('/model '),
      20_000,
      150,
    );
    expect(output.output).toContain('/model ');
    expect(output.output).not.toContain('^M');

    await client.tileContextMenu(paneId!, 420, 240);
    await waitFor(
      'Claude context menu commands reopen',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.context_menu?.pane_id === paneId
        && nextProjection.context_menu.loading_claude_commands === false
        && nextProjection.context_menu.items.some((item) => item.id === 'claude-command:clear'),
      30_000,
      150,
    );

    await client.execInShell(paneId!, 'exec cat -vet');
    await client.waitForIdle(30_000, 250);
    await client.readOutput(paneId!);

    await client.tileContextMenu(paneId!, 420, 240);
    await waitFor(
      'Claude context menu commands after reset',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.context_menu?.pane_id === paneId
        && nextProjection.context_menu.loading_claude_commands === false
        && nextProjection.context_menu.items.some((item) => item.id === 'claude-command:clear'),
      30_000,
      150,
    );

    await client.contextMenuSelect('claude-command:clear');
    output = await waitFor(
      'execute Claude command echo',
      () => client.readOutput(paneId!),
      (result) => result.output.includes('/clear$'),
      20_000,
      150,
    );
    expect(output.output).toContain('/clear$');

    await client.setTileRole(paneId!, 'output');
    await client.waitForIdle();
    await client.tileContextMenu(paneId!, 420, 240);
    projection = await client.getProjection();
    expect(projection.context_menu?.items).toEqual([
      { id: 'close-shell', label: 'Close Shell', kind: 'action', disabled: false },
    ]);

    await client.contextMenuDismiss();
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
