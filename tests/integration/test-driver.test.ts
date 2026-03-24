import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HerdTestClient } from './client';
import { createIsolatedTab, terminalById, waitFor } from './helpers';
import { startIntegrationRuntime, type HerdIntegrationRuntime } from './runtime';

const VIEWPORT_WIDTH = 1400;
const VIEWPORT_HEIGHT = 846;

async function spawnShellInActiveTab(client: HerdTestClient): Promise<string> {
  const before = await client.getProjection();
  const knownPaneIds = new Set(before.active_tab_terminals.map((terminal) => terminal.id));
  await client.tileCreate('shell', {
    parentSessionId: before.active_tab_id,
  });
  const projection = await waitFor(
    'shell create in active tab',
    () => client.getProjection(),
    (nextProjection) => nextProjection.active_tab_terminals.some((terminal) => !knownPaneIds.has(terminal.id)),
    30_000,
    150,
  );
  const created = projection.active_tab_terminals.find((terminal) => !knownPaneIds.has(terminal.id));
  if (!created) {
    throw new Error('failed to locate spawned shell pane');
  }
  return created.id;
}

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
    const selectedPane = state.ui.selectedPaneId ? state.tmux.panes[state.ui.selectedPaneId] : null;
    const selectedTileId = selectedPane
      ? (selectedPane.tile_id ?? state.tmux.windows[selectedPane.window_id]?.tile_id ?? null)
      : null;
    expect(projection.active_tab_id).toBe(state.tmux.activeSessionId);
    expect(projection.active_tab_terminals.length).toBeGreaterThan(0);
    expect(projection.selected_tile_id).toBe(selectedTileId);
    expect(projection.sidebar.items.length).toBeGreaterThan(0);
    expect(projection.indicators.sock).toBe(true);
    expect(projection.context_menu).toBeNull();
  });

  it('routes test socket commands through the herd receiver', async () => {
    const ping = await client.ping();
    expect(ping.pong).toBe(true);

    const domQuery = await client.testDomQuery<{ ok: boolean }>(`return { ok: true };`);
    expect(domQuery.ok).toBe(true);

    await client.testDomKeys('F13');

    const projection = await waitFor(
      'herd receiver logs for test socket commands',
      () => client.getProjection(),
      (nextProjection) =>
        ['test_driver', 'test_dom_query', 'test_dom_keys'].every((wrapperCommand) =>
          nextProjection.tile_message_logs.some(
            (entry) =>
              entry.channel === 'socket'
              && entry.layer === 'socket'
              && entry.target_kind === 'herd'
              && entry.target_id === runtime.runtimeId
              && entry.wrapper_command === wrapperCommand,
          )
          && nextProjection.tile_message_logs.some(
            (entry) =>
              entry.channel === 'socket'
              && entry.layer === 'message'
              && entry.target_kind === 'herd'
              && entry.target_id === runtime.runtimeId
              && entry.wrapper_command === wrapperCommand,
          ),
        ),
      30_000,
      150,
    );

    expect(
      projection.tile_message_logs
        .filter((entry) => entry.target_kind === 'herd' && entry.target_id === runtime.runtimeId)
        .map((entry) => entry.wrapper_command),
    ).toEqual(expect.arrayContaining(['test_driver', 'test_dom_query', 'test_dom_keys']));
  });

  it('renders canvas tiles for the active tab and opens the debug pane', async () => {
    const projection = await client.getProjection();
    const canvas = await client.testDomQuery<{
      hasCanvas: boolean;
      tileCount: number;
      workCount: number;
    }>(
      `return {
        hasCanvas: document.querySelector(".canvas-viewport") !== null,
        tileCount: document.querySelectorAll(".pcb-component").length,
        workCount: document.querySelectorAll(".work-card").length
      };`,
    );

    expect(canvas.hasCanvas).toBe(true);
    expect(canvas.tileCount).toBe(projection.active_tab_terminals.length);
    expect(canvas.workCount).toBe(projection.active_tab_work_cards.length);

    await client.pressKeys([{ key: 'd' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);

    const debug = await waitFor(
      'debug pane opens',
      () =>
        client.testDomQuery<{
          open: boolean;
          tabs: string[];
        }>(
          `return {
            open: document.querySelector(".debug-pane") !== null,
            tabs: Array.from(document.querySelectorAll(".debug-tabs button")).map((el) => el.textContent ?? "")
          };`,
        ),
      (result) => result.open,
      10_000,
      100,
    );

    expect(debug.tabs).toEqual(['Info', 'Logs', 'Chatter']);
  });

  it('surfaces agent messaging activity in the per-pane activity projection', async () => {
    const paneId = await spawnShellInActiveTab(client);
    expect(paneId).toBeTruthy();

    await client.agentRegister('agent-log-test', paneId!, 'Activity Agent');

    const agentProjection = await waitFor(
      'registered agent projection',
      () => client.getProjection(),
      (nextProjection) => nextProjection.agents.some((entry) => entry.agent_id === 'agent-log-test'),
      30_000,
      150,
    );
    const agent = agentProjection.agents.find((entry) => entry.agent_id === 'agent-log-test');
    expect(agent).toBeTruthy();
    await client.agentPingAck('agent-log-test');

    await client.messagePublic('activity projection topic', paneId!, ['#activity']);

    const projection = await waitFor(
      'agent activity projection',
      () => client.getProjection(),
      (nextProjection) =>
        (nextProjection.tile_activity_by_id[paneId!] ?? []).some(
          (entry) => entry.kind === 'outgoing_chatter',
        ),
      30_000,
      150,
    );

    expect(projection.tile_activity_by_id[paneId!]?.map((entry) => entry.kind)).toContain('outgoing_chatter');

    await client.testDomQuery(`
      document
        .querySelector('[data-tile-id="${paneId!}"] .activity-toggle-btn')
        ?.click();
      return true;
    `);

    const drawerVisible = await waitFor(
      'tile activity drawer visible',
      () => client.testDomQuery<boolean>(`
        return Boolean(
          document.querySelector('[data-tile-id="${paneId!}"] .tile-activity .activity-line')
        );
      `),
      Boolean,
      30_000,
      150,
    );
    expect(drawerVisible).toBe(true);
  });

  it('clears persisted logs from the debug pane', async () => {
    const probeMessage = `debug clear log probe ${Date.now()}`;
    await client.messagePublic(probeMessage);

    await client.pressKeys([{ key: 'd' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);

    await waitFor(
      'logs appear before clear',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.chatter.some((entry) => entry.message === probeMessage)
        && nextProjection.tile_message_logs.some(
          (entry) =>
            entry.wrapper_command === 'message_public'
            && (entry.args as { message?: string } | undefined)?.message === probeMessage,
        ),
      30_000,
      150,
    );

    const clearBoundaryMs = Date.now() - 100;
    await client.testDomQuery(`
      document.querySelector('[data-debug-action="clear-logs"]')?.click();
      return true;
    `);

    const projection = await waitFor(
      'pre-clear logs removed from projection',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.chatter.every((entry) => entry.timestamp_ms >= clearBoundaryMs)
        && nextProjection.agent_logs.every((entry) => entry.timestamp_ms >= clearBoundaryMs)
        && nextProjection.tile_message_logs.every((entry) => entry.timestamp_ms >= clearBoundaryMs)
        && !nextProjection.chatter.some(
          (entry) => entry.message === probeMessage || entry.display_text.includes(probeMessage),
        )
        && !nextProjection.tile_message_logs.some(
          (entry) =>
            (entry.args as { message?: string } | undefined)?.message === probeMessage
            || JSON.stringify(entry.args).includes(probeMessage)
            || entry.error?.includes(probeMessage),
        ),
      30_000,
      150,
    );

    expect(projection.chatter.every((entry) => entry.timestamp_ms >= clearBoundaryMs)).toBe(true);
    expect(projection.agent_logs.every((entry) => entry.timestamp_ms >= clearBoundaryMs)).toBe(true);
    expect(projection.tile_message_logs.every((entry) => entry.timestamp_ms >= clearBoundaryMs)).toBe(true);
    expect(projection.chatter.some((entry) => entry.message === probeMessage)).toBe(false);
    expect(
      projection.tile_message_logs.some(
        (entry) =>
          (entry.args as { message?: string } | undefined)?.message === probeMessage
          || JSON.stringify(entry.args).includes(probeMessage)
          || entry.error?.includes(probeMessage),
      ),
    ).toBe(false);
  });

  it('opens and dismisses typed context menus for the canvas and the selected tile', async () => {
    let projection = await client.getProjection();
    const selectedTileId = projection.selected_tile_id;
    expect(selectedTileId).toBeTruthy();

    await client.canvasContextMenu(240, 180);
    projection = await client.getProjection();
    expect(projection.context_menu?.target).toBe('canvas');
    expect(projection.context_menu?.items.map((item) => item.label)).toEqual([
      'New Shell',
      'New Agent',
      'New Browser',
      'New Work',
    ]);

    await client.contextMenuDismiss();
    projection = await client.getProjection();
    expect(projection.context_menu).toBeNull();

    await client.driverTileContextMenu(selectedTileId!, 480, 260);
    projection = await client.getProjection();
    expect(projection.context_menu?.target).toBe('tile');
    expect(projection.context_menu?.tile_id).toBe(selectedTileId);
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

    await client.driverTileContextMenu(createdTile.id, 640, 320);
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

  it('shows Claude commands only for Agent tiles and dispatches execute vs insert correctly', async () => {
    let projection = await createIsolatedTab(client, 'claude-menu');
    const paneId = await spawnShellInActiveTab(client);
    expect(paneId).toBeTruthy();

    await client.execInShell(paneId!, 'exec cat -vet');
    await client.waitForIdle(30_000, 250);
    await client.readOutput(paneId!);

    await client.setTileRole(paneId!, 'claude');
    await client.waitForIdle();

    await client.driverTileContextMenu(paneId!, 420, 240);
    projection = await waitFor(
      'Agent tile Claude commands',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.context_menu?.tile_id === paneId
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
      'insert-only Agent-tile Claude command echo',
      () => client.readOutput(paneId!),
      (result) => result.output.includes('/model '),
      20_000,
      150,
    );
    expect(output.output).toContain('/model ');
    expect(output.output).not.toContain('^M');

    await client.driverTileContextMenu(paneId!, 420, 240);
    await waitFor(
      'Agent tile Claude commands reopen',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.context_menu?.tile_id === paneId
        && nextProjection.context_menu.loading_claude_commands === false
        && nextProjection.context_menu.items.some((item) => item.id === 'claude-command:clear'),
      30_000,
      150,
    );

    await client.execInShell(paneId!, 'exec cat -vet');
    await client.waitForIdle(30_000, 250);
    await client.readOutput(paneId!);

    await client.driverTileContextMenu(paneId!, 420, 240);
    await waitFor(
      'Agent tile Claude commands after reset',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.context_menu?.tile_id === paneId
        && nextProjection.context_menu.loading_claude_commands === false
        && nextProjection.context_menu.items.some((item) => item.id === 'claude-command:clear'),
      30_000,
      150,
    );

    await client.contextMenuSelect('claude-command:clear');
    output = await waitFor(
      'execute Agent-tile Claude command echo',
      () => client.readOutput(paneId!),
      (result) => result.output.includes('/clear$'),
      20_000,
      150,
    );
    expect(output.output).toContain('/clear$');

    await client.setTileRole(paneId!, 'output');
    await client.waitForIdle();
    await client.driverTileContextMenu(paneId!, 420, 240);
    projection = await client.getProjection();
    expect(projection.context_menu?.items).toEqual([
      { id: 'close-shell', label: 'Close Shell', kind: 'action', disabled: false },
    ]);

    await client.contextMenuDismiss();
  });

  it('covers mode, help, sidebar, command bar, and tab creation through the typed driver', async () => {
    let projection = await client.getProjection();
    const paneId = projection.selected_tile_id;
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

  it('lets focused dialog inputs bypass global shortcuts and temporarily switch the app into input mode', async () => {
    let projection = await client.getProjection();
    expect(projection.mode).toBe('command');

    await client.testDomQuery(`document.querySelector('.tool-btn.work')?.click(); return true;`);
    await waitFor(
      'work dialog input to appear',
      () => client.testDomQuery<boolean>(`return Boolean(document.querySelector('.work-input'));`),
      (visible) => visible === true,
      30_000,
      150,
    );

    const focused = await client.testDomQuery<boolean>(
      `const input = document.querySelector('.work-input'); input?.focus(); return document.activeElement === input;`,
    );
    expect(focused).toBe(true);

    projection = await waitFor(
      'dialog input mode override',
      () => client.getProjection(),
      (nextProjection) => nextProjection.mode === 'input',
      30_000,
      150,
    );
    expect(projection.mode).toBe('input');

    const bypass = await client.testDomQuery<{ defaultPrevented: boolean; sidebarOpen: boolean }>(`
      const input = document.querySelector('.work-input');
      const event = new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true });
      input?.dispatchEvent(event);
      return {
        defaultPrevented: event.defaultPrevented,
        sidebarOpen: Boolean(document.querySelector('.sidebar')),
      };
    `);
    expect(bypass.defaultPrevented).toBe(false);
    expect(bypass.sidebarOpen).toBe(false);

    await client.testDomQuery(`
      const input = document.querySelector('.work-input');
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    `);
    await waitFor(
      'work dialog close',
      () => client.testDomQuery<boolean>(`return Boolean(document.querySelector('.work-input'));`),
      (visible) => visible === false,
      30_000,
      150,
    );
    projection = await waitFor(
      'command mode after closing work dialog',
      () => client.getProjection(),
      (nextProjection) => nextProjection.mode === 'command',
      30_000,
      150,
    );
    expect(projection.mode).toBe('command');
  });

  it('renders work cards on the canvas, keeps the sidebar compact, and scopes tmux items to the active tab', async () => {
    let projection = await createIsolatedTab(client, 'canvas-work-a');
    const firstSessionId = projection.active_tab_id!;

    const firstWork = await client.toolbarSpawnWork('Canvas Work A');
    const secondWork = await client.toolbarSpawnWork('Canvas Work B');
    projection = await waitFor(
      'canvas work cards in first tab',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === firstSessionId
        && nextProjection.work_items.length === 2
        && nextProjection.active_tab_work_cards.length === 2,
      30_000,
      150,
    );

    const secondTab = await createIsolatedTab(client, 'canvas-work-b');
    const secondSessionId = secondTab.active_tab_id!;
    const hiddenWork = await client.toolbarSpawnWork('Canvas Work Hidden');
    projection = await waitFor(
      'second tab work card',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === secondSessionId
        && nextProjection.work_items.some((item) => item.work_id === hiddenWork.work_id),
      30_000,
      150,
    );

    await client.toolbarSelectTab(firstSessionId);
    await client.sidebarOpen();
    projection = await waitFor(
      'return to first tab work view',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === firstSessionId
        && nextProjection.work_items.every((item) => item.session_id === firstSessionId)
        && nextProjection.active_tab_work_cards.length === 2
        && nextProjection.sidebar.items.every((item) => item.sessionId === firstSessionId),
      30_000,
      150,
    );

    expect([...projection.active_tab_work_cards.map((card) => card.workId)].sort()).toEqual([
      firstWork.work_id,
      secondWork.work_id,
    ].sort());

    const canvasSnapshot = await client.testDomQuery<{
      workTitles: string[];
      compactWorkCount: number;
      detailPanels: number;
    }>(`return {
      workTitles: Array.from(document.querySelectorAll('.work-card .work-card-title')).map((node) => node.textContent?.trim() ?? ''),
      compactWorkCount: document.querySelectorAll('.work-list .work-item').length,
      detailPanels: document.querySelectorAll('.sidebar .work-detail').length,
    };`);

    expect([...canvasSnapshot.workTitles].sort()).toEqual(['Canvas Work A', 'Canvas Work B'].sort());
    expect(canvasSnapshot.compactWorkCount).toBe(2);
    expect(canvasSnapshot.detailPanels).toBe(0);
  });

  it('gives work cards a draggable titlebar and lets the canvas delete them', async () => {
    let projection = await createIsolatedTab(client, 'work-card-tile');
    const work = await client.toolbarSpawnWork('Drag And Delete');

    projection = await waitFor(
      'work card to appear',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_work_cards.some((card) => card.workId === work.work_id),
      30_000,
      150,
    );

    const originalCard = projection.active_tab_work_cards.find((card) => card.workId === work.work_id)!;

    const dragReady = await client.testDomQuery<boolean>(`
      const header = document.querySelector('[data-work-id="${work.work_id}"] .work-card-titlebar');
      return header instanceof HTMLElement;
    `);
    expect(dragReady).toBe(true);

    await client.testDomQuery(`
      const header = document.querySelector('[data-work-id="${work.work_id}"] .work-card-titlebar');
      if (!(header instanceof HTMLElement)) {
        throw new Error('missing work-card titlebar');
      }
      const rect = header.getBoundingClientRect();
      header.dispatchEvent(new MouseEvent('mousedown', {
        button: 0,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 20,
        clientY: rect.top + 10,
      }));
      window.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 140,
        clientY: rect.top + 90,
      }));
      window.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 140,
        clientY: rect.top + 90,
      }));
      return true;
    `);

    projection = await waitFor(
      'dragged work card position',
      () => client.getProjection(),
      (nextProjection) => {
        const nextCard = nextProjection.active_tab_work_cards.find((card) => card.workId === work.work_id);
        return Boolean(nextCard) && (nextCard!.x !== originalCard.x || nextCard!.y !== originalCard.y);
      },
      30_000,
      150,
    );

    const movedCard = projection.active_tab_work_cards.find((card) => card.workId === work.work_id)!;
    expect(movedCard.x).not.toBe(originalCard.x);
    expect(movedCard.y).not.toBe(originalCard.y);

    await client.testDomQuery(`
      const button = document.querySelector('[data-work-id="${work.work_id}"] .work-card-close');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('missing work-card delete button');
      }
      button.click();
      return true;
    `);

    projection = await waitFor(
      'work card deletion',
      () => client.getProjection(),
      (nextProjection) =>
        !nextProjection.work_items.some((item) => item.work_id === work.work_id)
        && !nextProjection.active_tab_work_cards.some((card) => card.workId === work.work_id),
      30_000,
      150,
    );

    expect(projection.work_items.some((item) => item.work_id === work.work_id)).toBe(false);
  });

  it('renders tile ports with the right modes and supports drag-connect plus disconnect on the canvas', async () => {
    let projection = await createIsolatedTab(client, 'network-ports');
    const agentPaneId = await spawnShellInActiveTab(client);
    await client.agentRegister('agent-port-owner', agentPaneId, 'Port Owner');
    const work = await client.toolbarSpawnWork('Port Wiring');

    projection = await waitFor(
      'agent tile and work card for port test',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals.some((terminal) => terminal.id === agentPaneId)
        && nextProjection.agents.some((agent) => agent.agent_id === 'agent-port-owner')
        && nextProjection.active_tab_work_cards.some((card) => card.workId === work.work_id),
      30_000,
      150,
    );

    const portSnapshot = await client.testDomQuery<{
      agentLeft: string;
      workLeft: string;
      workTop: string;
    }>(`
      const agentLeft = document.querySelector('[data-port-tile="${agentPaneId}"][data-port="left"]');
      const workLeft = document.querySelector('[data-port-tile="work:${work.work_id}"][data-port="left"]');
      const workTop = document.querySelector('[data-port-tile="work:${work.work_id}"][data-port="top"]');
      return {
        agentLeft: agentLeft?.className ?? '',
        workLeft: workLeft?.className ?? '',
        workTop: workTop?.className ?? '',
      };
    `);

    expect(portSnapshot.agentLeft).toContain('port-read-write');
    expect(portSnapshot.workLeft).toContain('port-read-write');
    expect(portSnapshot.workTop).toContain('port-read');

    await client.testDomQuery(`
      const source = document.querySelector('[data-port-tile="${agentPaneId}"][data-port="left"]');
      const target = document.querySelector('[data-port-tile="work:${work.work_id}"][data-port="left"]');
      if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        throw new Error('missing port handles');
      }
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      source.dispatchEvent(new MouseEvent('mousedown', {
        button: 0,
        bubbles: true,
        cancelable: true,
        clientX: sourceRect.left + sourceRect.width / 2,
        clientY: sourceRect.top + sourceRect.height / 2,
      }));
      window.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: targetRect.left + targetRect.width / 2,
        clientY: targetRect.top + targetRect.height / 2,
      }));
      target.dispatchEvent(new MouseEvent('mouseup', {
        button: 0,
        bubbles: true,
        cancelable: true,
        clientX: targetRect.left + targetRect.width / 2,
        clientY: targetRect.top + targetRect.height / 2,
      }));
      return true;
    `);

    projection = await waitFor(
      'network edge creation from drag connect',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_network_connections.some(
          (connection) =>
            ((connection.from_tile_id === agentPaneId && connection.from_port === 'left')
              && (connection.to_tile_id === `work:${work.work_id}` && connection.to_port === 'left'))
            || ((connection.to_tile_id === agentPaneId && connection.to_port === 'left')
              && (connection.from_tile_id === `work:${work.work_id}` && connection.from_port === 'left')),
        ),
      30_000,
      150,
    );

    expect(projection.active_tab_network_connections).toHaveLength(1);

    await client.testDomQuery(`
      const source = document.querySelector('[data-port-tile="${agentPaneId}"][data-port="left"]');
      if (!(source instanceof HTMLElement)) {
        throw new Error('missing occupied source port');
      }
      const sourceRect = source.getBoundingClientRect();
      source.dispatchEvent(new MouseEvent('mousedown', {
        button: 0,
        bubbles: true,
        cancelable: true,
        clientX: sourceRect.left + sourceRect.width / 2,
        clientY: sourceRect.top + sourceRect.height / 2,
      }));
      window.dispatchEvent(new MouseEvent('mouseup', {
        button: 0,
        bubbles: true,
        cancelable: true,
        clientX: sourceRect.left - 40,
        clientY: sourceRect.top - 40,
      }));
      return true;
    `);

    projection = await waitFor(
      'network edge removal from disconnect drag',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_network_connections.length === 0,
      30_000,
      150,
    );

    expect(projection.active_tab_network_connections).toHaveLength(0);
  });

  it('uses Shift+J/K to focus sidebar sections and j/k to select work and agent items on the canvas', async () => {
    let projection = await createIsolatedTab(client, 'sidebar-focus');
    const paneId = projection.selected_tile_id!;

    const firstWork = await client.toolbarSpawnWork('Focus Work A');
    const secondWork = await client.toolbarSpawnWork('Focus Work B');
    await client.agentRegister('agent-focus', paneId, 'Focus Agent');
    projection = await waitFor(
      'agent registration in focused tab',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.agents.some((agent) => agent.agent_id === 'agent-focus')
        && nextProjection.work_items.length >= 2,
      30_000,
      150,
    );

    await client.sidebarOpen();

    await client.pressKeys([{ key: 'K', shift_key: true }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await waitFor(
      'agents sidebar section focus',
      () => client.getProjection(),
      (nextProjection) => nextProjection.sidebar.section === 'agents' && nextProjection.selected_tile_id === paneId,
      30_000,
      150,
    );

    await client.pressKeys([{ key: 'K', shift_key: true }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await waitFor(
      'work sidebar section focus',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.sidebar.section === 'work'
        && [firstWork.work_id, secondWork.work_id].includes(nextProjection.selected_work_id ?? ''),
      30_000,
      150,
    );

    const initiallySelectedWorkId = projection.selected_work_id!;
    const nextWorkId = initiallySelectedWorkId === firstWork.work_id ? secondWork.work_id : firstWork.work_id;

    let selectedCanvasWork = await client.testDomQuery<string>(
      `return document.querySelector('.work-card.selected-work-card')?.getAttribute('data-work-id') ?? '';`,
    );
    expect(selectedCanvasWork).toBe(initiallySelectedWorkId);

    await client.pressKeys([{ key: 'j' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await waitFor(
      'move within work sidebar section',
      () => client.getProjection(),
      (nextProjection) => nextProjection.selected_work_id === nextWorkId,
      30_000,
      150,
    );

    selectedCanvasWork = await client.testDomQuery<string>(
      `return document.querySelector('.work-card.selected-work-card')?.getAttribute('data-work-id') ?? '';`,
    );
    expect(selectedCanvasWork).toBe(nextWorkId);

    await client.pressKeys([{ key: 'J', shift_key: true }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await waitFor(
      'return to agents sidebar section',
      () => client.getProjection(),
      (nextProjection) => nextProjection.sidebar.section === 'agents' && nextProjection.selected_tile_id === paneId,
      30_000,
      150,
    );
  });

  it('covers shell create, tile selection/close, sidebar rename, and canvas actions through the typed driver', async () => {
    expect(createdSessionId).toBeTruthy();

    await client.toolbarSelectTab(createdSessionId!);
    await client.waitForIdle();

    let projection = await client.getProjection();
    expect(projection.active_tab_id).toBe(createdSessionId);
    expect(projection.active_tab_terminals).toHaveLength(1);

    const firstPaneId = projection.selected_tile_id;
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
    expect(projection.selected_tile_id).not.toBe(firstPaneId);

    const cycledPaneId = projection.selected_tile_id;
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

    await client.driverTileDrag(cycledPaneId!, 80, 40);
    await client.waitForIdle();
    projection = await client.getProjection();
    const draggedTile = terminalById(projection.active_tab_terminals, cycledPaneId!);
    expect(draggedTile.x).toBe(beforeTile.x + 80);
    expect(draggedTile.y).toBe(beforeTile.y + 40);

    await client.driverTileResize(cycledPaneId!, beforeTile.width + 120, beforeTile.height + 80);
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

    await client.driverTileTitleDoubleClick(cycledPaneId!, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
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
    let projection = await createIsolatedTab(client, 'driver-close-tab');
    const activeSessionId = projection.active_tab_id;
    expect(activeSessionId).toBeTruthy();

    await client.pressKeys([{ key: 's' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    await waitFor(
      'second shell before tab close',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === activeSessionId && nextProjection.active_tab_terminals.length > 1,
      30_000,
      150,
    );

    projection = await client.getProjection();
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

    projection = await waitFor(
      'closed multi-window tab',
      () => client.getProjection(),
      (nextProjection) => !nextProjection.tabs.some((tab) => tab.id === activeSessionId),
      30_000,
      150,
    );
    expect(projection.tabs.some((tab) => tab.id === activeSessionId)).toBe(false);
    expect(projection.indicators.tmux).toBe(true);
    expect(projection.indicators.cc).toBe(true);
  });

  it('replaces the last closed session with a root-agent session', async () => {
    const isolatedRuntime = await startIntegrationRuntime();
    const isolatedClient = isolatedRuntime.client;

    try {
      let projection = await isolatedClient.getProjection();
      const initialSessionId = projection.active_tab_id;
      expect(initialSessionId).toBeTruthy();
      expect(projection.tabs).toHaveLength(1);
      expect(projection.active_tab_terminals).toHaveLength(1);
      expect(projection.active_tab_terminals[0]?.kind).toBe('root_agent');

      await isolatedClient.commandBarOpen();
      await isolatedClient.commandBarSetText('tc');
      await isolatedClient.commandBarSubmit();
      await isolatedClient.waitForIdle(60_000, 250);

      projection = await waitFor(
        'replacement session after last tab close',
        () => isolatedClient.getProjection(),
        (nextProjection) =>
          nextProjection.tabs.length === 1
          && nextProjection.active_tab_id !== initialSessionId
          && nextProjection.active_tab_terminals.length === 1
          && nextProjection.active_tab_terminals[0]?.kind === 'root_agent',
        60_000,
        250,
      );

      expect(projection.active_tab_terminals[0]?.kind).toBe('root_agent');
    } finally {
      await isolatedRuntime.stop();
    }
  });
});
