import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HerdTestClient } from './client';
import { createIsolatedTab, rootDir, terminalById, waitFor } from './helpers';
import { startIntegrationRuntime, type HerdIntegrationRuntime } from './runtime';

const VIEWPORT_WIDTH = 1400;
const VIEWPORT_HEIGHT = 846;

function rootAgentForProjection(projection: Awaited<ReturnType<HerdTestClient['getProjection']>>) {
  return projection.agents.find((agent) => agent.agent_role === 'root' && agent.alive);
}

function sanitizeSessionConfigName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

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

async function spawnToolbarShellInActiveTab(client: HerdTestClient): Promise<string> {
  const before = await client.getProjection();
  const knownPaneIds = new Set(before.active_tab_terminals.map((terminal) => terminal.id));
  await client.toolbarSpawnShell();
  const projection = await waitFor(
    'toolbar shell create in active tab',
    () => client.getProjection(),
    (nextProjection) => nextProjection.active_tab_terminals.some((terminal) => !knownPaneIds.has(terminal.id)),
    30_000,
    150,
  );
  const created = projection.active_tab_terminals.find((terminal) => !knownPaneIds.has(terminal.id));
  if (!created) {
    throw new Error('failed to locate toolbar-spawned shell pane');
  }
  return created.id;
}

async function spawnBrowserInActiveTab(
  client: HerdTestClient,
  options?: { browserPath?: string },
): Promise<string> {
  const before = await client.getProjection();
  const knownPaneIds = new Set(before.active_tab_terminals.map((terminal) => terminal.id));
  await client.tileCreate('browser', {
    parentSessionId: before.active_tab_id,
    browserPath: options?.browserPath ?? null,
  });
  const projection = await waitFor(
    'browser create in active tab',
    () => client.getProjection(),
    (nextProjection) =>
      nextProjection.active_tab_terminals.some(
        (terminal) => terminal.kind === 'browser' && !knownPaneIds.has(terminal.id),
      ),
    30_000,
    150,
  );
  const created = projection.active_tab_terminals.find(
    (terminal) => terminal.kind === 'browser' && !knownPaneIds.has(terminal.id),
  );
  if (!created) {
    throw new Error('failed to locate spawned browser tile');
  }
  return created.id;
}

async function waitForDomDriver(client: HerdTestClient, label: string): Promise<void> {
  await waitFor(
    label,
    async () => {
      try {
        return await client.testDomQuery<boolean>('return true;');
      } catch {
        return false;
      }
    },
    (ready) => ready === true,
    30_000,
    150,
  );
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

    await client.messagePublic('activity projection topic', paneId!);

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

    const drawerResize = await client.testDomQuery<{ grip: boolean; before: number; gripCenterDelta: number }>(`
      const drawer = document.querySelector('[data-tile-id="${paneId!}"] .tile-activity');
      const grip = drawer?.querySelector('.drawer-resize-grip');
      const header = drawer?.querySelector('.activity-header');
      const before = drawer?.getBoundingClientRect().height ?? 0;
      const gripRect = grip?.getBoundingClientRect();
      const headerRect = header?.getBoundingClientRect();
      return {
        grip: Boolean(grip),
        before,
        gripCenterDelta: gripRect && headerRect
          ? Math.abs((gripRect.left + gripRect.width / 2) - (headerRect.left + headerRect.width / 2))
          : -1,
      };
    `);
    expect(drawerResize.grip).toBe(true);
    expect(drawerResize.gripCenterDelta).toBeLessThan(10);
    await client.testDomQuery(`
      const grip = document.querySelector('[data-tile-id="${paneId!}"] .tile-activity .drawer-resize-grip');
      grip?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 420 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 360 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientY: 360 }));
      return true;
    `);
    const resizedActivityHeight = await waitFor(
      'activity drawer resize',
      () => client.testDomQuery<number>(`
        return document.querySelector('[data-tile-id="${paneId!}"] .tile-activity')?.getBoundingClientRect().height ?? 0;
      `),
      (height) => height > drawerResize.before + 4,
      10_000,
      100,
    );
    expect(resizedActivityHeight).toBeGreaterThan(drawerResize.before);
  });

  it('shows shell, display, and activity toggles on terminal tiles', async () => {
    const paneId = await spawnShellInActiveTab(client);
    expect(paneId).toBeTruthy();

    const initialChrome = await client.testDomQuery<{
      buttonOrder: string[];
      shellActive: boolean;
      displayActive: boolean;
      activityActive: boolean;
      shellVisible: boolean;
      displayVisible: boolean;
      activityVisible: boolean;
    }>(`
      const tile = document.querySelector('[data-tile-id="${paneId!}"]');
      return {
        buttonOrder: Array.from(tile?.querySelectorAll('.info-cluster-right button') ?? [])
          .map((button) => button.textContent?.trim() ?? ''),
        shellActive: tile?.querySelector('.shell-view-toggle-btn')?.classList.contains('active') ?? false,
        displayActive: tile?.querySelector('.display-toggle-btn')?.classList.contains('active') ?? false,
        activityActive: tile?.querySelector('.activity-toggle-btn')?.classList.contains('active') ?? false,
        shellVisible: !(tile?.querySelector('.screen-housing')?.classList.contains('shell-view-hidden') ?? true),
        displayVisible: Boolean(tile?.querySelector('.terminal-display')),
        activityVisible: Boolean(tile?.querySelector('.tile-activity')),
      };
    `);

    expect(initialChrome.buttonOrder[0]).toBe('SHELL');
    expect(initialChrome.buttonOrder[1]).toBe('DISPLAY');
    expect(initialChrome.buttonOrder[2]?.startsWith('ACT')).toBe(true);
    expect(initialChrome.shellActive).toBe(true);
    expect(initialChrome.displayActive).toBe(false);
    expect(initialChrome.activityActive).toBe(false);
    expect(initialChrome.shellVisible).toBe(true);
    expect(initialChrome.displayVisible).toBe(false);
    expect(initialChrome.activityVisible).toBe(false);

    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${paneId!}"] .display-toggle-btn')?.click();
      return true;
    `);

    const displayOpen = await waitFor(
      'terminal display drawer visible',
      () => client.testDomQuery<{ active: boolean; open: boolean; grip: boolean }>(`
        const tile = document.querySelector('[data-tile-id="${paneId!}"]');
        const display = tile?.querySelector('.terminal-display');
        return {
          active: tile?.querySelector('.display-toggle-btn')?.classList.contains('active') ?? false,
          open: Boolean(display),
          grip: Boolean(display?.querySelector('.drawer-resize-grip')),
        };
      `),
      (state) => state.active && state.open && state.grip,
      30_000,
      150,
    );
    expect(displayOpen.active).toBe(true);

    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${paneId!}"] .shell-view-toggle-btn')?.click();
      return true;
    `);

    const shellHidden = await waitFor(
      'terminal shell view hidden while display stays open',
      () => client.testDomQuery<{
        shellActive: boolean;
        shellVisible: boolean;
        displayVisible: boolean;
        bottomGap: number;
        displayTopGap: number;
        displayBottomGap: number;
      }>(`
        const tile = document.querySelector('[data-tile-id="${paneId!}"]');
        const tileRect = tile?.getBoundingClientRect();
        const headerRect = tile?.querySelector('.header-bar')?.getBoundingClientRect();
        const displayRect = tile?.querySelector('.terminal-display')?.getBoundingClientRect();
        const infoStripRect = tile?.querySelector('.info-strip')?.getBoundingClientRect();
        return {
          shellActive: tile?.querySelector('.shell-view-toggle-btn')?.classList.contains('active') ?? false,
          shellVisible: !(tile?.querySelector('.screen-housing')?.classList.contains('shell-view-hidden') ?? true),
          displayVisible: Boolean(tile?.querySelector('.terminal-display')),
          bottomGap: tileRect && infoStripRect ? Math.abs(tileRect.bottom - infoStripRect.bottom) : -1,
          displayTopGap: headerRect && displayRect ? Math.abs(displayRect.top - headerRect.bottom) : -1,
          displayBottomGap: displayRect && infoStripRect ? Math.abs((displayRect.bottom + 6) - infoStripRect.top) : -1,
        };
      `),
      (state) =>
        !state.shellActive
        && !state.shellVisible
        && state.displayVisible
        && state.bottomGap >= 0
        && state.bottomGap < 3
        && state.displayTopGap >= 0
        && state.displayTopGap < 3
        && state.displayBottomGap >= 0
        && state.displayBottomGap < 3,
      30_000,
      150,
    );
    expect(shellHidden.shellVisible).toBe(false);
    expect(shellHidden.bottomGap).toBeLessThan(3);
    expect(shellHidden.displayTopGap).toBeLessThan(3);
    expect(shellHidden.displayBottomGap).toBeLessThan(3);

    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${paneId!}"] .activity-toggle-btn')?.click();
      return true;
    `);

    const activityOpen = await waitFor(
      'terminal activity drawer visible alongside display drawer',
      () => client.testDomQuery<{
        activityActive: boolean;
        displayVisible: boolean;
        activityVisible: boolean;
        displayTopGap: number;
        activityBottomGap: number;
      }>(`
        const tile = document.querySelector('[data-tile-id="${paneId!}"]');
        const headerRect = tile?.querySelector('.header-bar')?.getBoundingClientRect();
        const displayRect = tile?.querySelector('.terminal-display')?.getBoundingClientRect();
        const activityRect = tile?.querySelector('.tile-activity')?.getBoundingClientRect();
        const infoStripRect = tile?.querySelector('.info-strip')?.getBoundingClientRect();
        return {
          activityActive: tile?.querySelector('.activity-toggle-btn')?.classList.contains('active') ?? false,
          displayVisible: Boolean(tile?.querySelector('.terminal-display')),
          activityVisible: Boolean(tile?.querySelector('.tile-activity')),
          displayTopGap: headerRect && displayRect ? Math.abs(displayRect.top - headerRect.bottom) : -1,
          activityBottomGap: activityRect && infoStripRect ? Math.abs((activityRect.bottom + 6) - infoStripRect.top) : -1,
        };
      `),
      (state) =>
        state.activityActive
        && state.displayVisible
        && state.activityVisible
        && state.displayTopGap >= 0
        && state.displayTopGap < 3
        && state.activityBottomGap >= 0
        && state.activityBottomGap < 3,
      30_000,
      150,
    );
    expect(activityOpen.activityVisible).toBe(true);
    expect(activityOpen.displayTopGap).toBeLessThan(3);
    expect(activityOpen.activityBottomGap).toBeLessThan(3);
  });

  it('injects HERD_TILE_ID into spawned shell tiles', async () => {
    const tileId = await spawnShellInActiveTab(client);

    await client.execInShell(
      tileId,
      "printf '__HERD_ENV__ tile=%s sock=%s\\n' \"$HERD_TILE_ID\" \"$HERD_SOCK\"",
    );

    const output = await waitFor(
      'shell env output',
      () => client.readOutput(tileId),
      (nextOutput) => nextOutput.output.includes('__HERD_ENV__ tile='),
      30_000,
      150,
    );

    expect(output.output).toContain(`__HERD_ENV__ tile=${tileId} `);
    expect(output.output).toMatch(/__HERD_ENV__ tile=\S+ sock=\/tmp\/herd(?:-[^\s]+)?\.sock/);
  });

  it('injects HERD_TILE_ID into toolbar-spawned shell tiles', async () => {
    const tileId = await spawnToolbarShellInActiveTab(client);

    await client.execInShell(
      tileId,
      "printf '__HERD_TOOLBAR_ENV__ tile=%s sock=%s\\n' \"$HERD_TILE_ID\" \"$HERD_SOCK\"",
    );

    const output = await waitFor(
      'toolbar shell env output',
      () => client.readOutput(tileId),
      (nextOutput) => nextOutput.output.includes('__HERD_TOOLBAR_ENV__ tile='),
      30_000,
      150,
    );

    expect(output.output).toContain(`__HERD_TOOLBAR_ENV__ tile=${tileId} `);
    expect(output.output).toMatch(/__HERD_TOOLBAR_ENV__ tile=\S+ sock=\/tmp\/herd(?:-[^\s]+)?\.sock/);
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
    expect(projection.context_menu?.items.map((item) => item.label)).toContain('Close Shell');

    await client.driverPortContextMenu(selectedTileId!, 'left', 520, 280);
    projection = await client.getProjection();
    expect(projection.context_menu?.target).toBe('port');
    expect(projection.context_menu?.tile_id).toBe(selectedTileId);
    expect(projection.context_menu?.port_id).toBe('left');
    expect(projection.context_menu?.items).toEqual([
      { id: 'port-label', label: 'Port left', kind: 'label', disabled: true },
      {
        id: 'port-access',
        label: 'Access',
        kind: 'submenu',
        disabled: false,
        children: [
          { id: 'port-access:read', label: 'Read', kind: 'action', disabled: false, selected: false },
          { id: 'port-access:read_write', label: 'Read/Write', kind: 'action', disabled: false, selected: true },
        ],
      },
      {
        id: 'port-networking',
        label: 'Networking',
        kind: 'submenu',
        disabled: false,
        children: [
          { id: 'port-networking:broadcast', label: 'Broadcast', kind: 'action', disabled: false, selected: true },
          { id: 'port-networking:gateway', label: 'Gateway', kind: 'action', disabled: false, selected: false },
        ],
      },
    ]);
  });

  it('supports shift multi-select and lock/unlock through the tile context menu', async () => {
    await createIsolatedTab(client, 'tile-locking');
    const firstTileId = await spawnShellInActiveTab(client);
    const secondTileId = await spawnShellInActiveTab(client);

    await waitFor(
      'two spawned shell tiles are visible for locking',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals.some((terminal) => terminal.id === firstTileId)
        && nextProjection.active_tab_terminals.some((terminal) => terminal.id === secondTileId),
      30_000,
      150,
    );

    await client.driverTileSelect(firstTileId);
    await client.driverTileSelect(secondTileId, true);

    let projection = await client.getProjection();
    expect(projection.selected_tile_id).toBe(secondTileId);
    expect(projection.selected_tile_ids).toEqual([secondTileId, firstTileId]);

    await client.driverTileContextMenu(secondTileId, 520, 280);
    projection = await client.getProjection();
    expect(projection.context_menu?.target).toBe('tile');
    expect(projection.context_menu?.items.map((item) => item.label)).toEqual(['Close', 'Lock']);

    const initialPositions = Object.fromEntries(
      projection.active_tab_terminals
        .filter((terminal) => terminal.id === firstTileId || terminal.id === secondTileId)
        .map((terminal) => [terminal.id, { x: terminal.x, y: terminal.y }]),
    );

    await client.contextMenuSelect('toggle-lock-tiles');

    projection = await waitFor(
      'multi-selected tiles lock',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals
          .filter((terminal) => terminal.id === firstTileId || terminal.id === secondTileId)
          .every((terminal) => terminal.locked === true),
      30_000,
      150,
    );

    expect(
      await client.testDomQuery<boolean>(`
        return ${JSON.stringify([firstTileId, secondTileId])}.every((tileId) =>
          document.querySelector('.pcb-component[data-tile-id="' + tileId + '"] .tile-lock-indicator') !== null
        );
      `),
    ).toBe(true);

    await client.driverTileDrag(firstTileId, 120, 40);
    await client.waitForIdle();
    projection = await client.getProjection();
    expect(
      projection.active_tab_terminals.find((terminal) => terminal.id === firstTileId),
    ).toMatchObject(initialPositions[firstTileId]!);

    await client.driverTileContextMenu(secondTileId, 520, 280);
    projection = await client.getProjection();
    expect(projection.context_menu?.items.map((item) => item.label)).toEqual(['Close', 'Unlock']);

    await client.contextMenuSelect('toggle-lock-tiles');

    projection = await waitFor(
      'multi-selected tiles unlock',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals
          .filter((terminal) => terminal.id === firstTileId || terminal.id === secondTileId)
          .every((terminal) => terminal.locked !== true),
      30_000,
      150,
    );

    await client.driverTileDrag(firstTileId, 120, 40);
    projection = await waitFor(
      'unlocked tile moves after drag',
      () => client.getProjection(),
      (nextProjection) => {
        const terminal = nextProjection.active_tab_terminals.find((item) => item.id === firstTileId);
        return Boolean(
          terminal
          && terminal.x === initialPositions[firstTileId]!.x + 120
          && terminal.y === initialPositions[firstTileId]!.y + 40,
        );
      },
      30_000,
      150,
    );

    expect(
      projection.active_tab_terminals.find((terminal) => terminal.id === firstTileId),
    ).toMatchObject({
      x: initialPositions[firstTileId]!.x + 120,
      y: initialPositions[firstTileId]!.y + 40,
    });
  });

  it('updates port settings from the port context menu, lights the indicators, and disconnects invalidated edges', async () => {
    await createIsolatedTab(client, 'port-context-menu');
    const shellTileId = await spawnShellInActiveTab(client);
    const work = await client.toolbarSpawnWork('Gateway Test');

    await waitFor(
      'shell tile and work card for port menu test',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals.some((terminal) => terminal.id === shellTileId)
        && nextProjection.active_tab_work_cards.some((card) => card.workId === work.work_id),
      30_000,
      150,
    );

    await client.networkConnect(shellTileId, 'top', work.tile_id, 'top');

    await waitFor(
      'shell-work connection appears before access downgrade',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_network_connections.some(
          (connection) =>
            ((connection.from_tile_id === shellTileId && connection.from_port === 'top')
              || (connection.to_tile_id === shellTileId && connection.to_port === 'top'))
            && ((connection.from_tile_id === work.tile_id && connection.from_port === 'top')
              || (connection.to_tile_id === work.tile_id && connection.to_port === 'top')),
        ),
      30_000,
      150,
    );

    await client.driverPortContextMenu(shellTileId, 'top', 560, 300);
    let projection = await client.getProjection();
    expect(projection.context_menu?.target).toBe('port');
    expect(projection.context_menu?.port_id).toBe('top');

    await client.contextMenuSelect('port-access:read');

    projection = await waitFor(
      'access downgrade disconnects read-read edge',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.context_menu === null
        && nextProjection.active_tab_network_connections.every(
          (connection) =>
            !(
              ((connection.from_tile_id === shellTileId && connection.from_port === 'top')
                || (connection.to_tile_id === shellTileId && connection.to_port === 'top'))
              && ((connection.from_tile_id === work.tile_id && connection.from_port === 'top')
                || (connection.to_tile_id === work.tile_id && connection.to_port === 'top'))
            ),
        ),
      30_000,
      150,
    );
    expect(projection.active_tab_network_connections.some((connection) => connection.from_tile_id === shellTileId && connection.from_port === 'top')).toBe(false);

    let domState = await client.testDomQuery<{
      access: string;
      networking: string;
      readLight: boolean;
      gatewayLight: boolean;
    }>(`
      const port = document.querySelector('[data-port-tile="${shellTileId}"][data-port="top"]');
      return {
        access: port?.getAttribute('data-port-access') ?? '',
        networking: port?.getAttribute('data-port-networking') ?? '',
        readLight: port?.querySelector('.port-light-left')?.classList.contains('light-active-read') ?? false,
        gatewayLight: port?.querySelector('.port-light-right')?.classList.contains('light-active-gateway') ?? false,
      };
    `);
    expect(domState).toEqual({
      access: 'read',
      networking: 'broadcast',
      readLight: true,
      gatewayLight: false,
    });

    await client.driverPortContextMenu(shellTileId, 'top', 560, 300);
    await client.contextMenuSelect('port-networking:gateway');

    domState = await waitFor(
      'gateway indicator updates after networking selection',
      () => client.testDomQuery<{
        access: string;
        networking: string;
        readLight: boolean;
        gatewayLight: boolean;
      }>(`
        const port = document.querySelector('[data-port-tile="${shellTileId}"][data-port="top"]');
        return {
          access: port?.getAttribute('data-port-access') ?? '',
          networking: port?.getAttribute('data-port-networking') ?? '',
          readLight: port?.querySelector('.port-light-left')?.classList.contains('light-active-read') ?? false,
          gatewayLight: port?.querySelector('.port-light-right')?.classList.contains('light-active-gateway') ?? false,
        };
      `),
      (nextState) => nextState.networking === 'gateway' && nextState.gatewayLight,
      30_000,
      150,
    );
    expect(domState).toEqual({
      access: 'read',
      networking: 'gateway',
      readLight: true,
      gatewayLight: true,
    });
  });

  it('applies gateway traversal rules to sender-visible network_list and network_call', async () => {
    await createIsolatedTab(client, 'gateway-routing');
    const senderTileId = await spawnShellInActiveTab(client);
    const gatewayTileId = await spawnShellInActiveTab(client);
    const targetTileId = await spawnShellInActiveTab(client);

    await waitFor(
      'three shell tiles are visible for gateway routing',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals.some((terminal) => terminal.id === senderTileId)
        && nextProjection.active_tab_terminals.some((terminal) => terminal.id === gatewayTileId)
        && nextProjection.active_tab_terminals.some((terminal) => terminal.id === targetTileId),
      30_000,
      150,
    );

    await client.networkConnect(senderTileId, 'right', gatewayTileId, 'left');
    await client.networkConnect(gatewayTileId, 'right', targetTileId, 'left');

    let senderNetwork = await client.listNetwork(senderTileId);
    expect(senderNetwork.tiles.map((tile) => tile.tile_id)).toEqual(expect.arrayContaining([
      senderTileId,
      gatewayTileId,
      targetTileId,
    ]));

    await client.driverPortContextMenu(gatewayTileId, 'left', 560, 320);
    await client.contextMenuSelect('port-networking:gateway');

    await waitFor(
      'gateway mode is reflected on the ingress port',
      () => client.testDomQuery<{ networking: string; gatewayLight: boolean }>(`
        const port = document.querySelector('[data-port-tile="${gatewayTileId}"][data-port="left"]');
        return {
          networking: port?.getAttribute('data-port-networking') ?? '',
          gatewayLight: port?.querySelector('.port-light-right')?.classList.contains('light-active-gateway') ?? false,
        };
      `),
      (nextState) => nextState.networking === 'gateway' && nextState.gatewayLight,
      30_000,
      150,
    );

    senderNetwork = await client.listNetwork(senderTileId);
    expect(senderNetwork.tiles.map((tile) => tile.tile_id).sort()).toEqual([gatewayTileId, senderTileId].sort());

    await expect(
      client.networkCall(targetTileId, 'output_read', {}, senderTileId),
    ).rejects.toThrow(/sender network/i);

    const gatewayNetwork = await client.listNetwork(gatewayTileId);
    expect(gatewayNetwork.tiles.map((tile) => tile.tile_id).sort()).toEqual([gatewayTileId, senderTileId, targetTileId].sort());

    const gatewayRead = await client.networkCall<{ output: string }>(targetTileId, 'output_read', {}, gatewayTileId);
    expect(gatewayRead.tile_id).toBe(targetTileId);
    expect(gatewayRead.action).toBe('output_read');
    expect(typeof gatewayRead.result.output).toBe('string');
  });

  it('shows browser Load submenu entries and suppresses browser webviews while context menus and motion are active', async () => {
    await createIsolatedTab(client, 'browser-context-menu');
    const browserTileId = await spawnBrowserInActiveTab(client);
    await client.waitForIdle(30_000, 250);

    await client.driverTileContextMenu(browserTileId, 480, 260);
    let projection = await waitFor(
      'browser tile context menu opens',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.context_menu?.tile_id === browserTileId
        && nextProjection.context_menu.items.some((item) => item.id === 'browser-load'),
      30_000,
      150,
    );

    expect(projection.context_menu?.items.map((item) => item.label)).toEqual(['Load', '', 'Close Browser']);
    const loadLabels = projection.context_menu?.items[0]?.children?.map((item) => item.label) ?? [];
    expect(loadLabels).toEqual(expect.arrayContaining([
      'Checkers',
      'Draw Poker',
      'Game Boy',
      'Pong',
      'Snake Arena',
      'Texas Holdem',
    ]));
    expect(loadLabels.indexOf('Game Boy')).toBeGreaterThan(loadLabels.indexOf('Draw Poker'));
    expect(loadLabels.indexOf('Game Boy')).toBeLessThan(loadLabels.indexOf('Pong'));

    const menuStackState = await client.testDomQuery<{ suppressed: boolean }>(`
      return {
        suppressed: document.querySelector('[data-tile-id="${browserTileId}"]')?.classList.contains('webview-suppressed') ?? false,
      };
    `);
    expect(menuStackState.suppressed).toBe(true);

    await client.contextMenuSelect('browser-load:extensions/browser/checkers/index.html');

    const loadedUrlState = await waitFor(
      'browser extension page loads from context menu',
      () => client.testDomQuery<{ value: string; placeholder: string; suppressed: boolean }>(`
        const tile = document.querySelector('[data-tile-id="${browserTileId}"]');
        const input = tile?.querySelector('.url-input');
        const placeholder = tile?.querySelector('.placeholder-url');
        return {
          value: input instanceof HTMLInputElement ? input.value : '',
          placeholder: placeholder?.textContent ?? '',
          suppressed: tile?.classList.contains('webview-suppressed') ?? false,
        };
      `),
      (nextState) =>
        (nextState.value.includes('extensions/browser/checkers/index.html')
          || nextState.placeholder.includes('extensions/browser/checkers/index.html'))
        && nextState.suppressed === false,
      30_000,
      150,
    );
    expect(loadedUrlState.value || loadedUrlState.placeholder).toContain('extensions/browser/checkers/index.html');

    projection = await client.getProjection();
    expect(projection.context_menu).toBeNull();

    await client.canvasPan(24, 16);
    const motionSuppressedState = await waitFor(
      'browser webview suppresses during canvas motion',
      () => client.testDomQuery<{ suppressed: boolean }>(`
        return {
          suppressed: document.querySelector('[data-tile-id="${browserTileId}"]')?.classList.contains('webview-suppressed') ?? false,
        };
      `),
      (nextState) => nextState.suppressed,
      10_000,
      50,
    );
    expect(motionSuppressedState.suppressed).toBe(true);

    const motionRestoredState = await waitFor(
      'browser webview restores after canvas motion settles',
      () => client.testDomQuery<{ suppressed: boolean }>(`
        return {
          suppressed: document.querySelector('[data-tile-id="${browserTileId}"]')?.classList.contains('webview-suppressed') ?? false,
        };
      `),
      (nextState) => nextState.suppressed === false,
      10_000,
      50,
    );
    expect(motionRestoredState.suppressed).toBe(false);

    await client.driverTileDrag(browserTileId, 80, 40);
    const dragSuppressedState = await waitFor(
      'browser webview suppresses during tile drag motion',
      () => client.testDomQuery<{ suppressed: boolean }>(`
        return {
          suppressed: document.querySelector('[data-tile-id="${browserTileId}"]')?.classList.contains('webview-suppressed') ?? false,
        };
      `),
      (nextState) => nextState.suppressed,
      10_000,
      50,
    );
    expect(dragSuppressedState.suppressed).toBe(true);

    const dragRestoredState = await waitFor(
      'browser webview restores after tile drag motion settles',
      () => client.testDomQuery<{ suppressed: boolean }>(`
        return {
          suppressed: document.querySelector('[data-tile-id="${browserTileId}"]')?.classList.contains('webview-suppressed') ?? false,
        };
      `),
      (nextState) => nextState.suppressed === false,
      10_000,
      50,
    );
    expect(dragRestoredState.suppressed).toBe(false);
  });

  it('creates a browser tile already loaded with an extension page', async () => {
    await createIsolatedTab(client, 'browser-create-with-extension');
    const browserTileId = await spawnBrowserInActiveTab(client, {
      browserPath: 'extensions/browser/checkers/index.html',
    });
    await client.waitForIdle(30_000, 250);
    await waitForDomDriver(client, 'dom driver after browser create-time extension load');

    const loadedUrlState = await waitFor(
      'browser extension page loads on create',
      () => client.testDomQuery<{ value: string; placeholder: string }>(`
        const tile = document.querySelector('[data-tile-id="${browserTileId}"]');
        const input = tile?.querySelector('.url-input');
        const placeholder = tile?.querySelector('.placeholder-url');
        return {
          value: input instanceof HTMLInputElement ? input.value : '',
          placeholder: placeholder?.textContent ?? '',
        };
      `),
      (nextState) =>
        nextState.value.includes('extensions/browser/checkers/index.html')
        || nextState.placeholder.includes('extensions/browser/checkers/index.html'),
      30_000,
      150,
    );
    expect(loadedUrlState.value || loadedUrlState.placeholder).toContain('extensions/browser/checkers/index.html');
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

    await client.pressKeys([{ key: ',' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.settings_sidebar_open).toBe(true);

    await client.pressKeys([{ key: 'Escape' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await client.getProjection();
    expect(projection.settings_sidebar_open).toBe(false);

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

  it('gates browser tile address bar focus behind input mode', async () => {
    let projection = await client.getProjection();
    const shellTileId = projection.active_tab_terminals.find((terminal) => terminal.kind !== 'browser')?.id;
    expect(shellTileId).toBeTruthy();

    const browserTileId = await spawnBrowserInActiveTab(client);
    await client.waitForIdle(30_000, 250);
    await waitForDomDriver(client, 'dom driver after browser spawn');
    await client.driverTileSelect(browserTileId);

    let focusState = await client.testDomQuery<{
      activeMatches: boolean;
      readOnly: boolean;
      tabIndex: number;
    }>(`
      const input = document.querySelector('[data-tile-id="${browserTileId}"] .url-input');
      return {
        activeMatches: document.activeElement === input,
        readOnly: input instanceof HTMLInputElement ? input.readOnly : false,
        tabIndex: input instanceof HTMLInputElement ? input.tabIndex : -999,
      };
    `);
    expect(focusState.activeMatches).toBe(false);
    expect(focusState.readOnly).toBe(true);
    expect(focusState.tabIndex).toBe(-1);

    await waitForDomDriver(client, 'dom driver before browser input mode keypress');
    await client.pressKeys([{ key: 'i' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await waitFor(
      'browser input mode after i',
      () => client.getProjection(),
      (nextProjection) => nextProjection.mode === 'input' && nextProjection.selected_tile_id === browserTileId,
      30_000,
      150,
    );
    expect(projection.mode).toBe('input');

    focusState = await waitFor(
      'browser url focus after i',
      () => client.testDomQuery<{
        activeMatches: boolean;
        readOnly: boolean;
        tabIndex: number;
      }>(`
        const input = document.querySelector('[data-tile-id="${browserTileId}"] .url-input');
        return {
          activeMatches: document.activeElement === input,
          readOnly: input instanceof HTMLInputElement ? input.readOnly : false,
          tabIndex: input instanceof HTMLInputElement ? input.tabIndex : -999,
        };
      `),
      (nextState) => nextState.activeMatches,
      30_000,
      150,
    );
    expect(focusState.readOnly).toBe(false);
    expect(focusState.tabIndex).toBe(0);

    await client.testDomQuery(`
      const input = document.querySelector('[data-tile-id="${browserTileId}"] .url-input');
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true, cancelable: true }));
      return true;
    `);
    projection = await waitFor(
      'command mode after browser shift escape',
      () => client.getProjection(),
      (nextProjection) => nextProjection.mode === 'command',
      30_000,
      150,
    );
    expect(projection.mode).toBe('command');

    await client.driverTileSelect(shellTileId!);
    await waitForDomDriver(client, 'dom driver before shell input mode keypress');
    await client.pressKeys([{ key: 'i' }], VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    projection = await waitFor(
      'input mode on shell before reselecting browser',
      () => client.getProjection(),
      (nextProjection) => nextProjection.mode === 'input' && nextProjection.selected_tile_id === shellTileId,
      30_000,
      150,
    );
    expect(projection.mode).toBe('input');

    await client.driverTileSelect(browserTileId);
    focusState = await waitFor(
      'browser url focus after selecting while already in input mode',
      () => client.testDomQuery<{
        activeMatches: boolean;
        readOnly: boolean;
      }>(`
        const input = document.querySelector('[data-tile-id="${browserTileId}"] .url-input');
        return {
          activeMatches: document.activeElement === input,
          readOnly: input instanceof HTMLInputElement ? input.readOnly : false,
        };
      `),
      (nextState) => nextState.activeMatches,
      30_000,
      150,
    );
    expect(focusState.readOnly).toBe(false);
  });

  it('shows a live browser DOM text preview immediately left of the activity toggle', async () => {
    const projection = await createIsolatedTab(client, 'browser-text-preview');
    const sessionId = projection.active_tab_id!;
    const rootProjection = await waitFor(
      'root agent in browser-text-preview tab',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_id === sessionId && Boolean(rootAgentForProjection(nextProjection)),
      60_000,
      150,
    );
    const rootAgent = rootAgentForProjection(rootProjection);
    expect(rootAgent).toBeTruthy();

    const browserTileId = await spawnBrowserInActiveTab(client);
    await client.sendCommand({
      command: 'browser_load',
      tile_id: browserTileId,
      path: 'tests/fixtures/browser-text-layout.html',
      sender_agent_id: rootAgent!.agent_id,
      sender_tile_id: rootAgent!.tile_id,
    });
    await waitFor(
      'browser text layout fixture loaded',
      () => client.browserDrive<string>(
        browserTileId,
        'dom_query',
        { js: 'document.title' },
        rootAgent!.tile_id,
        rootAgent!.agent_id,
      ),
      (response) => response.result === 'browser-text-layout',
      30_000,
      150,
    );
    await client.waitForIdle(30_000, 250);
    await waitForDomDriver(client, 'dom driver after browser preview fixture load');

    const browserChromeState = await client.testDomQuery<{
      overlayPresent: boolean;
      insideCanvasWorld: boolean;
      buttonOrder: string[];
      zoomLabel: string | null;
    }>(`
      const tile = document.querySelector('[data-tile-id="${browserTileId}"]');
      return {
        overlayPresent: Boolean(document.querySelector('.browser-tile-overlay-layer')),
        insideCanvasWorld: Boolean(tile?.closest('.canvas-world')),
        buttonOrder: Array.from(tile?.querySelectorAll('.info-cluster-right button') ?? [])
          .map((button) => button.textContent?.trim() ?? ''),
        zoomLabel: tile?.getAttribute('data-browser-page-zoom') ?? null,
      };
    `);
    expect(browserChromeState.overlayPresent).toBe(true);
    expect(browserChromeState.insideCanvasWorld).toBe(false);
    expect(browserChromeState.zoomLabel).toBe('100%');
    expect(browserChromeState.buttonOrder[0]).toBe('Z-');
    expect(browserChromeState.buttonOrder[1]).toBe('Z+');
    expect(browserChromeState.buttonOrder[2]).toBe('TXT');
    expect(browserChromeState.buttonOrder[3]?.startsWith('ACT')).toBe(true);

    const browserTileRectBeforeCanvasZoom = await client.testDomQuery<{ width: number; height: number }>(`
      const rect = document.querySelector('[data-tile-id="${browserTileId}"]')?.getBoundingClientRect();
      return {
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
      };
    `);
    const beforeCanvasZoom = await client.getProjection();
    await client.canvasZoomAt(400, 300, 1.1);
    const afterCanvasZoom = await waitFor(
      'canvas zoom after browser tile measurement',
      () => client.getProjection(),
      (nextProjection) => nextProjection.canvas.zoom > beforeCanvasZoom.canvas.zoom,
      10_000,
      100,
    );
    expect(afterCanvasZoom.canvas.zoom).toBeGreaterThan(beforeCanvasZoom.canvas.zoom);
    const browserTileRectAfterCanvasZoom = await waitFor(
      'browser tile size grows with canvas zoom',
      () => client.testDomQuery<{ width: number; height: number }>(`
        const rect = document.querySelector('[data-tile-id="${browserTileId}"]')?.getBoundingClientRect();
        return {
          width: rect?.width ?? 0,
          height: rect?.height ?? 0,
        };
      `),
      (nextRect) =>
        nextRect.width > browserTileRectBeforeCanvasZoom.width + 2
        && nextRect.height > browserTileRectBeforeCanvasZoom.height + 2,
      10_000,
      100,
    );
    expect(browserTileRectAfterCanvasZoom.width).toBeGreaterThan(browserTileRectBeforeCanvasZoom.width);
    expect(browserTileRectAfterCanvasZoom.height).toBeGreaterThan(browserTileRectBeforeCanvasZoom.height);
    const zoomLabelAfterCanvasZoom = await client.testDomQuery<string | null>(`
      return document.querySelector('[data-tile-id="${browserTileId}"]')?.getAttribute('data-browser-page-zoom') ?? null;
    `);
    expect(zoomLabelAfterCanvasZoom).toBe('100%');

    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${browserTileId}"] .browser-page-zoom-in-btn')?.click();
      return true;
    `);
    const zoomedInLabel = await waitFor(
      'browser page zoom label after zoom in',
      () => client.testDomQuery<string | null>(`
        return document.querySelector('[data-tile-id="${browserTileId}"]')?.getAttribute('data-browser-page-zoom') ?? null;
      `),
      (label) => label === '110%',
      10_000,
      100,
    );
    expect(zoomedInLabel).toBe('110%');
    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${browserTileId}"] .browser-page-zoom-out-btn')?.click();
      return true;
    `);
    const resetZoomLabel = await waitFor(
      'browser page zoom label after zoom out',
      () => client.testDomQuery<string | null>(`
        return document.querySelector('[data-tile-id="${browserTileId}"]')?.getAttribute('data-browser-page-zoom') ?? null;
      `),
      (label) => label === '100%',
      10_000,
      100,
    );
    expect(resetZoomLabel).toBe('100%');
    const buttonOrder = await client.testDomQuery<string[]>(`
      return Array.from(document.querySelectorAll('[data-tile-id="${browserTileId}"] .info-cluster-right button'))
        .map((button) => button.textContent?.trim() ?? '');
    `);
    expect(buttonOrder[0]).toBe('Z-');
    expect(buttonOrder[1]).toBe('Z+');
    expect(buttonOrder[2]).toBe('TXT');
    expect(buttonOrder[3]?.startsWith('ACT')).toBe(true);

    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${browserTileId}"] .text-preview-toggle-btn')?.click();
      return true;
    `);

    const afterClickState = await client.testDomQuery<{ active: boolean; open: boolean }>(`
      const button = document.querySelector('[data-tile-id="${browserTileId}"] .text-preview-toggle-btn');
      const preview = document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview');
      return {
        active: button?.classList.contains('active') ?? false,
        open: Boolean(preview),
      };
    `);
    expect(afterClickState.active).toBe(true);

    let previewTextState = await waitFor(
      'browser text preview opens with content',
      () => client.testDomQuery<{ open: boolean; text: string }>(`
        const preview = document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview');
        const body = preview?.querySelector('.preview-text');
        return {
          open: Boolean(preview),
          text: body?.textContent ?? '',
        };
      `),
      (nextState) =>
        nextState.open
        && nextState.text.includes('SCORE')
        && nextState.text.includes('1200')
        && nextState.text.includes('LIVES')
        && nextState.text.includes('x3')
        && nextState.text.includes('PRESS')
        && nextState.text.includes('START'),
      30_000,
      150,
    );
    expect(previewTextState.open).toBe(true);

    const previewControls = await waitFor(
      'browser preview header controls render',
      () => client.testDomQuery<{
        formats: string[];
        activeFormat: string | null;
        refreshLabel: string | null;
      }>(`
        const preview = document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview');
        const formatButtons = Array.from(preview?.querySelectorAll('.preview-format-toggle') ?? []);
        const refreshButton = preview?.querySelector('.preview-refresh-rate-btn');
        return {
          formats: formatButtons.map((button) => button.textContent?.trim() ?? ''),
          activeFormat: preview?.getAttribute('data-preview-format') ?? null,
          refreshLabel: refreshButton?.textContent?.trim() ?? null,
        };
      `),
      (nextState) =>
        nextState.formats.join(',') === 'Text,Braille,ANSI,ASCII'
        && nextState.activeFormat === 'text'
        && nextState.refreshLabel !== null,
      30_000,
      150,
    );
    expect(previewControls.formats).toEqual(['Text', 'Braille', 'ANSI', 'ASCII']);
    expect(previewControls.activeFormat).toBe('text');
    expect(previewControls.refreshLabel).toBe('1s');

    const refreshSequence = [previewControls.refreshLabel];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const previousLabel = refreshSequence[refreshSequence.length - 1];
      await client.testDomQuery(`
        document.querySelector('[data-tile-id="${browserTileId}"] .preview-refresh-rate-btn')?.click();
        return true;
      `);
      const nextLabel = await waitFor(
        `browser preview refresh rate cycle ${attempt + 1}`,
        () => client.testDomQuery<string | null>(`
          return document.querySelector('[data-tile-id="${browserTileId}"] .preview-refresh-rate-btn')?.textContent?.trim() ?? null;
        `),
        (label) => Boolean(label) && label !== previousLabel,
        10_000,
        100,
      );
      refreshSequence.push(nextLabel);
    }
    expect(refreshSequence).toEqual(['1s', '3s', '0.5s', '1s']);

    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${browserTileId}"] .preview-format-toggle[data-format="braille"]')?.click();
      return true;
    `);
    let activeFormatState = await waitFor(
      'browser preview switches to braille',
      () => client.testDomQuery<{ format: string | null; text: string }>(`
        const preview = document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview');
        const body = preview?.querySelector('.preview-text');
        return {
          format: preview?.getAttribute('data-preview-format') ?? null,
          text: body?.textContent ?? '',
        };
      `),
      (nextState) =>
        Boolean(nextState)
        && nextState.format === 'braille'
        && /[\u2800-\u28FF]/.test(nextState.text),
      30_000,
      150,
    );
    expect(activeFormatState.format).toBe('braille');

    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${browserTileId}"] .preview-format-toggle[data-format="ansi"]')?.click();
      return true;
    `);
    activeFormatState = await waitFor(
      'browser preview switches to ansi',
      () => client.testDomQuery<{
        format: string | null;
        text: string;
        renderedAnsi: boolean;
        segmentCount: number;
        firstStyle: string | null;
      }>(`
        const preview = document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview');
        const body = preview?.querySelector('.preview-text');
        const ansi = preview?.querySelector('.preview-ansi');
        const firstSegment = ansi?.querySelector('[data-ansi-segment="true"]');
        return {
          format: preview?.getAttribute('data-preview-format') ?? null,
          text: body?.textContent ?? '',
          renderedAnsi: Boolean(ansi),
          segmentCount: ansi?.querySelectorAll('[data-ansi-segment="true"]').length ?? 0,
          firstStyle: firstSegment?.getAttribute('style') ?? null,
        };
      `),
      (nextState) =>
        Boolean(nextState)
        && nextState.format === 'ansi'
        && nextState.renderedAnsi
        && nextState.segmentCount > 0
        && Boolean(nextState.firstStyle)
        && !nextState.text.includes('\u001b['),
      30_000,
      150,
    );
    expect(activeFormatState.format).toBe('ansi');
    expect(activeFormatState.renderedAnsi).toBe(true);
    expect(activeFormatState.firstStyle).toContain('rgb(');

    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${browserTileId}"] .preview-format-toggle[data-format="ascii"]')?.click();
      return true;
    `);
    activeFormatState = await waitFor(
      'browser preview switches to ascii',
      () => client.testDomQuery<{ format: string | null; text: string }>(`
        const preview = document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview');
        const body = preview?.querySelector('.preview-text');
        return {
          format: preview?.getAttribute('data-preview-format') ?? null,
          text: body?.textContent ?? '',
        };
      `),
      (nextState) =>
        Boolean(nextState)
        && nextState.format === 'ascii',
      30_000,
      150,
    );
    expect(activeFormatState.format).toBe('ascii');

    await client.testDomQuery(`
      document.querySelector('[data-tile-id="${browserTileId}"] .preview-format-toggle[data-format="text"]')?.click();
      return true;
    `);
    const restoredTextState = await waitFor(
      'browser preview switches back to text',
      () => client.testDomQuery<{ format: string | null; text: string }>(`
        const preview = document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview');
        const body = preview?.querySelector('.preview-text');
        return {
          format: preview?.getAttribute('data-preview-format') ?? null,
          text: body?.textContent ?? '',
        };
      `),
      (nextState) =>
        Boolean(nextState)
        && nextState.format === 'text'
        && nextState.text.includes('SCORE')
        && nextState.text.includes('1200'),
      30_000,
      150,
    );
    expect(restoredTextState.format).toBe('text');

    const previewResize = await client.testDomQuery<{ grip: boolean; before: number; gripCenterDelta: number }>(`
      const drawer = document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview');
      const grip = drawer?.querySelector('.drawer-resize-grip');
      const header = drawer?.querySelector('.preview-header');
      const before = drawer?.getBoundingClientRect().height ?? 0;
      const gripRect = grip?.getBoundingClientRect();
      const headerRect = header?.getBoundingClientRect();
      return {
        grip: Boolean(grip),
        before,
        gripCenterDelta: gripRect && headerRect
          ? Math.abs((gripRect.left + gripRect.width / 2) - (headerRect.left + headerRect.width / 2))
          : -1,
      };
    `);
    expect(previewResize.grip).toBe(true);
    expect(previewResize.gripCenterDelta).toBeLessThan(10);
    await client.testDomQuery(`
      const grip = document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview .drawer-resize-grip');
      grip?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 420 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 340 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientY: 340 }));
      return true;
    `);
    const resizedPreviewHeight = await waitFor(
      'browser preview drawer resize',
      () => client.testDomQuery<number>(`
        return document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview')?.getBoundingClientRect().height ?? 0;
      `),
      (height) => height > previewResize.before + 4,
      10_000,
      100,
    );
    expect(resizedPreviewHeight).toBeGreaterThan(previewResize.before);

    await client.browserDrive<string>(
      browserTileId,
      'eval',
      {
        js: `
document.querySelector('#score').textContent = 'SCORE 9800';
return document.querySelector('#score').textContent;
`,
      },
      rootAgent!.tile_id,
      rootAgent!.agent_id,
    );

    previewTextState = await waitFor(
      'browser text preview refreshes after dom mutation',
      () => client.testDomQuery<{ text: string }>(`
        const body = document.querySelector('[data-tile-id="${browserTileId}"] .browser-text-preview .preview-text');
        return { text: body?.textContent ?? '' };
      `),
      (nextState) => nextState.text.includes('9800'),
      30_000,
      150,
    );
    expect(previewTextState.text).toContain('SCORE');
    expect(previewTextState.text).toContain('9800');
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

  it('minimizes tiles into a dock above the status bar and restores them', async () => {
    let projection = await createIsolatedTab(client, 'minimize-dock');
    const shellTileId = await spawnShellInActiveTab(client);
    const work = await client.toolbarSpawnWork('Minimize Me');

    projection = await waitFor(
      'work card for minimize test',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_work_cards.some((card) => card.workId === work.work_id),
      30_000,
      150,
    );

    const minimizeButtons = await client.testDomQuery<{
      shell: boolean;
      work: boolean;
    }>(`
      return {
        shell: document.querySelector('[data-tile-id="${shellTileId}"] .minimize-btn') instanceof HTMLButtonElement,
        work: document.querySelector('[data-work-id="${work.work_id}"] .work-card-minimize') instanceof HTMLButtonElement,
      };
    `);
    expect(minimizeButtons).toEqual({ shell: true, work: true });

    await client.testDomQuery(`
      const shellButton = document.querySelector('[data-tile-id="${shellTileId}"] .minimize-btn');
      const workButton = document.querySelector('[data-work-id="${work.work_id}"] .work-card-minimize');
      if (!(shellButton instanceof HTMLButtonElement) || !(workButton instanceof HTMLButtonElement)) {
        throw new Error('missing minimize buttons');
      }
      shellButton.click();
      workButton.click();
      return true;
    `);

    projection = await waitFor(
      'shell and work minimized',
      () => client.getProjection(),
      (nextProjection) => {
        const shell = nextProjection.active_tab_terminals.find((terminal) => terminal.id === shellTileId);
        const card = nextProjection.active_tab_work_cards.find((entry) => entry.workId === work.work_id);
        return shell?.minimized === true && card?.minimized === true;
      },
      30_000,
      150,
    );

    const minimizedDom = await client.testDomQuery<{
      dockIds: string[];
      shellVisible: boolean;
      workVisible: boolean;
      dockBottom: number | null;
      statusTop: number | null;
    }>(`
      const dockItems = Array.from(document.querySelectorAll('[data-minimized-tile-id]'));
      const firstDock = dockItems[0];
      const statusBar = document.querySelector('.status-bar');
      return {
        dockIds: dockItems.map((item) => item.getAttribute('data-minimized-tile-id') ?? ''),
        shellVisible: document.querySelector('[data-tile-id="${shellTileId}"]') !== null,
        workVisible: document.querySelector('[data-work-id="${work.work_id}"]') !== null,
        dockBottom: firstDock instanceof HTMLElement ? firstDock.getBoundingClientRect().bottom : null,
        statusTop: statusBar instanceof HTMLElement ? statusBar.getBoundingClientRect().top : null,
      };
    `);

    expect(minimizedDom.dockIds).toEqual(expect.arrayContaining([shellTileId, work.tile_id]));
    expect(minimizedDom.shellVisible).toBe(false);
    expect(minimizedDom.workVisible).toBe(false);
    expect(minimizedDom.dockBottom).not.toBeNull();
    expect(minimizedDom.statusTop).not.toBeNull();
    expect(minimizedDom.dockBottom!).toBeLessThanOrEqual(minimizedDom.statusTop!);

    await client.testDomQuery(`
      const shellDock = document.querySelector('[data-minimized-tile-id="${shellTileId}"]');
      const workDock = document.querySelector('[data-minimized-tile-id="${work.tile_id}"]');
      if (!(shellDock instanceof HTMLButtonElement) || !(workDock instanceof HTMLButtonElement)) {
        throw new Error('missing minimized dock buttons');
      }
      shellDock.click();
      workDock.click();
      return true;
    `);

    projection = await waitFor(
      'shell and work restored',
      () => client.getProjection(),
      (nextProjection) => {
        const shell = nextProjection.active_tab_terminals.find((terminal) => terminal.id === shellTileId);
        const card = nextProjection.active_tab_work_cards.find((entry) => entry.workId === work.work_id);
        return shell?.minimized !== true && card?.minimized !== true;
      },
      30_000,
      150,
    );

    const restoredDom = await client.testDomQuery<{
      dockCount: number;
      shellVisible: boolean;
      workVisible: boolean;
    }>(`
      return {
        dockCount: document.querySelectorAll('[data-minimized-tile-id]').length,
        shellVisible: document.querySelector('[data-tile-id="${shellTileId}"]') !== null,
        workVisible: document.querySelector('[data-work-id="${work.work_id}"]') !== null,
      };
    `);

    expect(restoredDom).toEqual({
      dockCount: 0,
      shellVisible: true,
      workVisible: true,
    });
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

  it('orients side-port lights vertically while keeping top-port lights horizontal', async () => {
    await createIsolatedTab(client, 'port-light-orientation');
    const paneId = await spawnShellInActiveTab(client);
    await client.agentRegister('agent-port-light-owner', paneId, 'Port Light Owner');

    const portOrientation = await waitFor(
      'left and top shell ports for orientation check',
      () => client.testDomQuery<{
        leftHorizontalDelta: number;
        leftVerticalDelta: number;
        topHorizontalDelta: number;
        topVerticalDelta: number;
      }>(`
        const leftPort = document.querySelector('[data-port-tile="${paneId}"][data-port="left"]');
        const topPort = document.querySelector('[data-port-tile="${paneId}"][data-port="top"]');
        const center = (rect) => ({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        const axisDelta = (port) => {
          const first = port?.querySelector('.port-light-left');
          const second = port?.querySelector('.port-light-right');
          if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) {
            return { horizontal: -1, vertical: -1 };
          }
          const firstCenter = center(first.getBoundingClientRect());
          const secondCenter = center(second.getBoundingClientRect());
          return {
            horizontal: Math.abs(firstCenter.x - secondCenter.x),
            vertical: Math.abs(firstCenter.y - secondCenter.y),
          };
        };
        const leftAxes = axisDelta(leftPort);
        const topAxes = axisDelta(topPort);
        return {
          leftHorizontalDelta: leftAxes.horizontal,
          leftVerticalDelta: leftAxes.vertical,
          topHorizontalDelta: topAxes.horizontal,
          topVerticalDelta: topAxes.vertical,
        };
      `),
      (state) =>
        state.leftHorizontalDelta >= 0
        && state.leftVerticalDelta > state.leftHorizontalDelta
        && state.topHorizontalDelta >= 0
        && state.topHorizontalDelta > state.topVerticalDelta,
      30_000,
      150,
    );

    expect(portOrientation.leftVerticalDelta).toBeGreaterThan(portOrientation.leftHorizontalDelta);
    expect(portOrientation.topHorizontalDelta).toBeGreaterThan(portOrientation.topVerticalDelta);
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

  it('shows canvas settings in the settings sidebar and lets you adjust snapping, ports, and wire sparks', async () => {
    const projection = await createIsolatedTab(client, 'ports-setting');
    const selectedTileId = projection.selected_tile_id;
    await client.settingsSidebarOpen();

    const initialSettings = await client.testDomQuery<{
      labels: string[];
      selectedPortCount: string;
      snapEnabled: boolean;
      selectedGridSize: string;
      selectedTilePortCount: number;
      sparksEnabled: boolean;
    }>(`
      const tileId = ${JSON.stringify(selectedTileId)};
      return {
        labels: Array.from(document.querySelectorAll('.sidebar .settings-card-label')).map((element) => element.textContent?.trim() ?? ''),
        selectedPortCount: document.querySelector('.tile-port-count-toggle[data-port-count].selected')?.textContent?.trim() ?? '',
        snapEnabled: document.querySelector('.wire-sparks-toggle[aria-label="Toggle snap to grid"]')?.getAttribute('aria-pressed') === 'true',
        selectedGridSize: document.querySelector('.tile-port-count-toggle[data-grid-snap-size].selected')?.textContent?.trim() ?? '',
        sparksEnabled: document.querySelector('.wire-sparks-toggle[aria-label="Toggle wire sparks"]')?.getAttribute('aria-pressed') === 'true',
        selectedTilePortCount: tileId
          ? document.querySelectorAll(\`[data-tile-id="\${tileId}"] [data-port]\`).length
          : 0,
      };
    `);

    expect(initialSettings.labels).toEqual([
      'SPAWN DIR',
      'SESSION NAME',
      'BROWSER BACKEND',
      'PORTS',
      'SNAP TO GRID',
      'GRID SIZE',
      'WIRE SPARKS',
    ]);
    expect(initialSettings.selectedPortCount).toBe('4');
    expect(initialSettings.snapEnabled).toBe(true);
    expect(initialSettings.selectedGridSize).toBe('20');
    expect(initialSettings.sparksEnabled).toBe(true);
    expect(initialSettings.selectedTilePortCount).toBe(4);

    await client.testDomQuery(`
      document.querySelector('.tile-port-count-toggle[data-port-count="12"]')?.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }));
      return true;
    `);

    const updatedSettings = await waitFor(
      'ports setting changes selected tile port count',
      () =>
        client.testDomQuery<{
          selectedPortCount: string;
          selectedTilePortCount: number;
        }>(`
          const tileId = ${JSON.stringify(selectedTileId)};
          return {
            selectedPortCount: document.querySelector('.tile-port-count-toggle[data-port-count].selected')?.textContent?.trim() ?? '',
            selectedTilePortCount: tileId
              ? document.querySelectorAll(\`[data-tile-id="\${tileId}"] [data-port]\`).length
              : 0,
          };
        `),
      (nextState) => nextState.selectedPortCount === '12' && nextState.selectedTilePortCount === 12,
      30_000,
      150,
    );

    expect(updatedSettings.selectedPortCount).toBe('12');
    expect(updatedSettings.selectedTilePortCount).toBe(12);

    await client.testDomQuery(`
      document.querySelector('.wire-sparks-toggle[aria-label="Toggle snap to grid"]')?.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }));
      return true;
    `);

    const updatedSnapSetting = await waitFor(
      'snap to grid toggles off',
      () =>
        client.testDomQuery<{ snapEnabled: boolean }>(`
          return {
            snapEnabled: document.querySelector('.wire-sparks-toggle[aria-label="Toggle snap to grid"]')?.getAttribute('aria-pressed') === 'true',
          };
        `),
      (nextState) => nextState.snapEnabled === false,
      30_000,
      150,
    );

    expect(updatedSnapSetting.snapEnabled).toBe(false);

    await client.testDomQuery(`
      document.querySelector('.tile-port-count-toggle[data-grid-snap-size="40"]')?.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }));
      return true;
    `);

    const updatedGridSize = await waitFor(
      'grid snap size changes to 40',
      () =>
        client.testDomQuery<{ selectedGridSize: string }>(`
          return {
            selectedGridSize: document.querySelector('.tile-port-count-toggle[data-grid-snap-size].selected')?.textContent?.trim() ?? '',
          };
        `),
      (nextState) => nextState.selectedGridSize === '40',
      30_000,
      150,
    );

    expect(updatedGridSize.selectedGridSize).toBe('40');

    await client.testDomQuery(`
      document.querySelector('.wire-sparks-toggle[aria-label="Toggle wire sparks"]')?.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }));
      return true;
    `);

    const updatedSparkSetting = await waitFor(
      'wire sparks setting toggles off',
      () =>
        client.testDomQuery<{ sparksEnabled: boolean }>(`
          return {
            sparksEnabled: document.querySelector('.wire-sparks-toggle[aria-label="Toggle wire sparks"]')?.getAttribute('aria-pressed') === 'true',
          };
        `),
      (nextState) => nextState.sparksEnabled === false,
      30_000,
      150,
    );

    expect(updatedSparkSetting.sparksEnabled).toBe(false);
  });

  it('restores the canvas pan and zoom for each tab when switching away and back', async () => {
    let firstProjection = await createIsolatedTab(client, `canvas-a-${Date.now()}`);
    const firstSessionId = firstProjection.active_tab_id!;

    await client.canvasPan(180, 95);
    await client.canvasZoomAt(720, 420, 1.18);

    firstProjection = await waitFor(
      'first tab canvas changed',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === firstSessionId
        && Math.abs(nextProjection.canvas.panX) > 0.001
        && Math.abs(nextProjection.canvas.panY) > 0.001
        && Math.abs(nextProjection.canvas.zoom - 1) > 0.001,
      30_000,
      150,
    );
    const firstCanvas = firstProjection.canvas;

    let secondProjection = await createIsolatedTab(client, `canvas-b-${Date.now()}`);
    const secondSessionId = secondProjection.active_tab_id!;

    await client.canvasPan(-140, 70);
    await client.canvasZoomAt(640, 360, 0.88);

    secondProjection = await waitFor(
      'second tab canvas changed',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === secondSessionId
        && Math.abs(nextProjection.canvas.panX - firstCanvas.panX) > 0.001
        && Math.abs(nextProjection.canvas.panY - firstCanvas.panY) > 0.001
        && Math.abs(nextProjection.canvas.zoom - firstCanvas.zoom) > 0.001,
      30_000,
      150,
    );
    const secondCanvas = secondProjection.canvas;

    await client.toolbarSelectTab(firstSessionId);
    const restoredFirstProjection = await waitFor(
      'first tab canvas restored after switching back',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === firstSessionId
        && Math.abs(nextProjection.canvas.panX - firstCanvas.panX) < 0.001
        && Math.abs(nextProjection.canvas.panY - firstCanvas.panY) < 0.001
        && Math.abs(nextProjection.canvas.zoom - firstCanvas.zoom) < 0.001,
      30_000,
      150,
    );
    expect(restoredFirstProjection.canvas.panX).toBeCloseTo(firstCanvas.panX, 4);
    expect(restoredFirstProjection.canvas.panY).toBeCloseTo(firstCanvas.panY, 4);
    expect(restoredFirstProjection.canvas.zoom).toBeCloseTo(firstCanvas.zoom, 4);
  });

  it('saves and loads session configurations from settings and opens them from the toolbar dropdown', async () => {
    const sessionName = `saved-session-${Date.now()}`;
    const configName = sanitizeSessionConfigName(sessionName);
    const configPath = path.join(rootDir(), 'sessions', `${configName}_session.json`);

    try {
      let projection = await createIsolatedTab(client, sessionName);
      const sourceSessionId = projection.active_tab_id!;

      const shellPaneId = await spawnShellInActiveTab(client);
      const browserPaneId = await spawnBrowserInActiveTab(client, {
        browserPath: 'extensions/browser/texas-holdem/index.html',
      });
      const work = await client.toolbarSpawnWork('Saved Session Work');

      projection = await waitFor(
        'saved-session initial tiles',
        () => client.getProjection(),
        (nextProjection) =>
          nextProjection.active_tab_id === sourceSessionId
          && nextProjection.active_tab_terminals.length === 3
          && nextProjection.active_tab_work_cards.some((card) => card.workId === work.work_id),
        30_000,
        150,
      );

      const rootAgent = rootAgentForProjection(projection);
      expect(rootAgent).toBeTruthy();
      const originalRoot = projection.active_tab_terminals.find((terminal) => terminal.kind === 'root_agent');
      const originalShell = projection.active_tab_terminals.find((terminal) => terminal.id === shellPaneId);
      const originalBrowser = projection.active_tab_terminals.find((terminal) => terminal.id === browserPaneId);
      const originalWorkCard = projection.active_tab_work_cards.find((card) => card.workId === work.work_id);
      expect(originalRoot).toBeTruthy();
      expect(originalShell).toBeTruthy();
      expect(originalBrowser).toBeTruthy();
      expect(originalWorkCard).toBeTruthy();

      await client.driverTileDrag(rootAgent!.tile_id, 140, 100);
      await client.driverTileDrag(shellPaneId, -120, 80);
      await client.driverTileDrag(browserPaneId, 180, 120);
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
          clientX: rect.left + 160,
          clientY: rect.top + 110,
        }));
        window.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 160,
          clientY: rect.top + 110,
        }));
        return true;
      `);

      projection = await waitFor(
        'saved-session custom tile positions',
        () => client.getProjection(),
        (nextProjection) => {
          const nextRoot = nextProjection.active_tab_terminals.find((terminal) => terminal.kind === 'root_agent');
          const nextShell = nextProjection.active_tab_terminals.find((terminal) => terminal.id === shellPaneId);
          const nextBrowser = nextProjection.active_tab_terminals.find((terminal) => terminal.id === browserPaneId);
          const nextWorkCard = nextProjection.active_tab_work_cards.find((card) => card.workId === work.work_id);
          return Boolean(nextRoot)
            && Boolean(nextShell)
            && Boolean(nextBrowser)
            && Boolean(nextWorkCard)
            && (nextRoot!.x !== originalRoot!.x || nextRoot!.y !== originalRoot!.y)
            && (nextShell!.x !== originalShell!.x || nextShell!.y !== originalShell!.y)
            && (nextBrowser!.x !== originalBrowser!.x || nextBrowser!.y !== originalBrowser!.y)
            && (nextWorkCard!.x !== originalWorkCard!.x || nextWorkCard!.y !== originalWorkCard!.y);
        },
        30_000,
        150,
      );

      const savedShellPosition = projection.active_tab_terminals.find((terminal) => terminal.id === shellPaneId)!;

      await client.networkConnect(rootAgent!.tile_id, 'right', browserPaneId, 'left');
      await client.waitForIdle(30_000, 250);
      await client.testDomQuery(`
        const button = document.querySelector('[data-tile-id="${shellPaneId}"] .minimize-btn');
        if (button instanceof HTMLButtonElement) {
          button.click();
          return true;
        }
        return false;
      `);

      projection = await waitFor(
        'saved-session shell minimized',
        () => client.getProjection(),
        (nextProjection) =>
          nextProjection.active_tab_id === sourceSessionId
          && nextProjection.active_tab_terminals.some((terminal) => terminal.id === shellPaneId && terminal.kind === 'regular')
          && nextProjection.active_tab_network_connections.length === 1,
        30_000,
        150,
      );

      const savedRootPosition = projection.active_tab_terminals.find((terminal) => terminal.kind === 'root_agent')!;
      const savedBrowserPosition = projection.active_tab_terminals.find((terminal) => terminal.id === browserPaneId)!;
      const savedWorkPosition = projection.active_tab_work_cards.find((card) => card.workId === work.work_id)!;

      await client.settingsSidebarOpen();
      await client.testDomQuery(`
        const saveButton = Array.from(document.querySelectorAll('.session-config-button')).find((element) =>
          (element.textContent ?? '').trim().startsWith('SAVE')
        );
        if (saveButton instanceof HTMLButtonElement) {
          saveButton.click();
          return true;
        }
        return false;
      `);

      await waitFor(
        'saved session configuration file exists',
        async () => {
          try {
            await fs.access(configPath);
            return true;
          } catch {
            return false;
          }
        },
        (exists) => exists,
        30_000,
        150,
      );

      const savedConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
        tiles: Array<{ kind: string; layout: { x: number; y: number; width: number; height: number } }>;
      };
      const savedConfigRoot = savedConfig.tiles.find((tile) => tile.kind === 'root_agent');
      const savedConfigShell = savedConfig.tiles.find((tile) => tile.kind === 'shell');
      const savedConfigBrowser = savedConfig.tiles.find((tile) => tile.kind === 'browser');
      const savedConfigWork = savedConfig.tiles.find((tile) => tile.kind === 'work');
      expect(savedConfigRoot?.layout.x).toBeCloseTo(savedRootPosition.x, 4);
      expect(savedConfigRoot?.layout.y).toBeCloseTo(savedRootPosition.y, 4);
      expect(savedConfigShell?.layout.x).toBeCloseTo(savedShellPosition.x, 4);
      expect(savedConfigShell?.layout.y).toBeCloseTo(savedShellPosition.y, 4);
      expect(savedConfigBrowser?.layout.x).toBeCloseTo(savedBrowserPosition.x, 4);
      expect(savedConfigBrowser?.layout.y).toBeCloseTo(savedBrowserPosition.y, 4);
      expect(savedConfigWork?.layout.x).toBeCloseTo(savedWorkPosition.x, 4);
      expect(savedConfigWork?.layout.y).toBeCloseTo(savedWorkPosition.y, 4);

      await spawnShellInActiveTab(client);
      projection = await waitFor(
        'session diverges after save',
        () => client.getProjection(),
        (nextProjection) =>
          nextProjection.active_tab_id === sourceSessionId
          && nextProjection.active_tab_terminals.length === 4,
        30_000,
        150,
      );

      await client.testDomQuery(`
        const loadButton = Array.from(document.querySelectorAll('.session-config-button')).find((element) =>
          (element.textContent ?? '').trim().startsWith('LOAD')
        );
        if (loadButton instanceof HTMLButtonElement) {
          loadButton.click();
          return true;
        }
        return false;
      `);

      projection = await waitFor(
        'current tab restored from saved session configuration',
        () => client.getProjection(),
        (nextProjection) =>
          nextProjection.active_tab_id === sourceSessionId
          && nextProjection.active_tab_terminals.length === 3
          && nextProjection.active_tab_terminals.some((terminal) => terminal.kind === 'browser')
          && nextProjection.active_tab_terminals.some((terminal) => terminal.kind === 'regular')
          && nextProjection.active_tab_network_connections.length === 1
          && nextProjection.active_tab_work_cards.length === 1,
        45_000,
        150,
      );

      projection = await waitFor(
        'restored root, browser, and work positions after current-tab load',
        () => client.getProjection(),
        (nextProjection) => {
          const nextRoot = nextProjection.active_tab_terminals.find((terminal) => terminal.kind === 'root_agent');
          const nextBrowser = nextProjection.active_tab_terminals.find((terminal) => terminal.kind === 'browser');
          const nextWork = nextProjection.active_tab_work_cards[0];
          return Boolean(nextRoot)
            && Boolean(nextBrowser)
            && Boolean(nextWork)
            && Math.abs(nextRoot!.x - savedRootPosition.x) < 0.001
            && Math.abs(nextRoot!.y - savedRootPosition.y) < 0.001
            && Math.abs(nextBrowser!.x - savedBrowserPosition.x) < 0.001
            && Math.abs(nextBrowser!.y - savedBrowserPosition.y) < 0.001
            && Math.abs(nextWork!.x - savedWorkPosition.x) < 0.001
            && Math.abs(nextWork!.y - savedWorkPosition.y) < 0.001;
        },
        30_000,
        150,
      );

      expect(projection.active_tab_work_cards).toHaveLength(1);
      expect(projection.active_tab_network_connections).toHaveLength(1);
      expect(projection.active_tab_terminals.some((terminal) => terminal.kind === 'regular')).toBe(true);
      const restoredRoot = projection.active_tab_terminals.find((terminal) => terminal.kind === 'root_agent')!;
      const restoredShell = projection.active_tab_terminals.find((terminal) => terminal.kind === 'regular')!;
      const restoredBrowser = projection.active_tab_terminals.find((terminal) => terminal.kind === 'browser')!;
      const restoredWork = projection.active_tab_work_cards[0]!;

      await client.testDomQuery(`
        const restoreButton = document.querySelector('[data-minimized-tile-id="${restoredShell.id}"]');
        if (restoreButton instanceof HTMLButtonElement) {
          restoreButton.click();
          return true;
        }
        return false;
      `);

      projection = await waitFor(
        'restored shell returns to saved world position after unminimize',
        () => client.getProjection(),
        (nextProjection) => {
          const nextShell = nextProjection.active_tab_terminals.find((terminal) => terminal.id === restoredShell.id);
          return Boolean(nextShell)
            && Math.abs(nextShell!.x - savedShellPosition.x) < 0.001
            && Math.abs(nextShell!.y - savedShellPosition.y) < 0.001;
        },
        30_000,
        150,
      );

      const tabCountBeforeToolbarLoad = projection.tabs.length;
      await waitFor(
        'saved session configuration appears in toolbar dropdown',
        () =>
          client.testDomQuery<{ ready: boolean }>(`
            const select = document.querySelector('.tab-load-select');
            const option = document.querySelector('.tab-load-select option[value="${configName}"]');
            return {
              ready: select instanceof HTMLSelectElement && !select.disabled && option instanceof HTMLOptionElement,
            };
          `),
        (state) => state.ready,
        30_000,
        150,
      );
      await client.testDomQuery(`
        const select = document.querySelector('.tab-load-select');
        if (select instanceof HTMLSelectElement) {
          select.value = ${JSON.stringify(configName)};
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      `);

      const toolbarLoadedProjection = await waitFor(
        'toolbar opens saved session configuration in a new tab',
        () => client.getProjection(),
        (nextProjection) =>
          nextProjection.tabs.length === tabCountBeforeToolbarLoad + 1
          && nextProjection.active_tab_id !== sourceSessionId
          && nextProjection.active_tab_terminals.length === 3
          && nextProjection.active_tab_terminals.some((terminal) => terminal.kind === 'browser')
          && nextProjection.active_tab_network_connections.length === 1
          && nextProjection.active_tab_work_cards.length === 1
          && nextProjection.active_tab_terminals.some((terminal) => terminal.kind === 'regular'),
        45_000,
        150,
      );

      expect(toolbarLoadedProjection.tabs.some((tab) => tab.name === sessionName)).toBe(true);
      const toolbarPositionProjection = await waitFor(
        'restored root, browser, and work positions after toolbar load',
        () => client.getProjection(),
        (nextProjection) => {
          const nextRoot = nextProjection.active_tab_terminals.find((terminal) => terminal.kind === 'root_agent');
          const nextBrowser = nextProjection.active_tab_terminals.find((terminal) => terminal.kind === 'browser');
          const nextWork = nextProjection.active_tab_work_cards[0];
          return Boolean(nextRoot)
            && Boolean(nextBrowser)
            && Boolean(nextWork)
            && Math.abs(nextRoot!.x - savedRootPosition.x) < 0.001
            && Math.abs(nextRoot!.y - savedRootPosition.y) < 0.001
            && Math.abs(nextBrowser!.x - savedBrowserPosition.x) < 0.001
            && Math.abs(nextBrowser!.y - savedBrowserPosition.y) < 0.001
            && Math.abs(nextWork!.x - savedWorkPosition.x) < 0.001
            && Math.abs(nextWork!.y - savedWorkPosition.y) < 0.001;
        },
        30_000,
        150,
      );

      const toolbarRoot = toolbarPositionProjection.active_tab_terminals.find((terminal) => terminal.kind === 'root_agent')!;
      const toolbarShell = toolbarPositionProjection.active_tab_terminals.find((terminal) => terminal.kind === 'regular')!;
      const toolbarBrowser = toolbarPositionProjection.active_tab_terminals.find((terminal) => terminal.kind === 'browser')!;
      const toolbarWork = toolbarPositionProjection.active_tab_work_cards[0]!;

      await client.testDomQuery(`
        const restoreButton = document.querySelector('[data-minimized-tile-id="${toolbarShell.id}"]');
        if (restoreButton instanceof HTMLButtonElement) {
          restoreButton.click();
          return true;
        }
        return false;
      `);

      const toolbarRestoredProjection = await waitFor(
        'toolbar-loaded shell returns to saved world position after unminimize',
        () => client.getProjection(),
        (nextProjection) => {
          const nextShell = nextProjection.active_tab_terminals.find((terminal) => terminal.id === toolbarShell.id);
          return Boolean(nextShell)
            && Math.abs(nextShell!.x - savedShellPosition.x) < 0.001
            && Math.abs(nextShell!.y - savedShellPosition.y) < 0.001;
        },
        30_000,
        150,
      );

      const toolbarRestoredShell = toolbarRestoredProjection.active_tab_terminals.find((terminal) => terminal.id === toolbarShell.id)!;
      expect(toolbarRestoredShell.x).toBeCloseTo(savedShellPosition.x, 4);
      expect(toolbarRestoredShell.y).toBeCloseTo(savedShellPosition.y, 4);
    } finally {
      await fs.rm(configPath, { force: true }).catch(() => undefined);
    }
  });

  it('confirms before overwriting an existing saved session configuration', async () => {
    const sessionName = `overwrite-session-${Date.now()}`;
    const configName = sanitizeSessionConfigName(sessionName);
    const configPath = path.join(rootDir(), 'sessions', `${configName}_session.json`);

    try {
      let projection = await createIsolatedTab(client, sessionName);
      const rootAgent = rootAgentForProjection(projection);
      expect(rootAgent).toBeTruthy();

      await client.settingsSidebarOpen();
      await client.testDomQuery(`
        const saveButton = Array.from(document.querySelectorAll('.session-config-button')).find((element) =>
          (element.textContent ?? '').trim().startsWith('SAVE')
        );
        if (!(saveButton instanceof HTMLButtonElement)) {
          throw new Error('missing session save button');
        }
        saveButton.click();
        return true;
      `);

      await waitFor(
        'initial saved session configuration file exists',
        async () => {
          try {
            await fs.access(configPath);
            return true;
          } catch {
            return false;
          }
        },
        (exists) => exists,
        30_000,
        150,
      );

      await waitFor(
        'initial saved session configuration appears in toolbar dropdown',
        () =>
          client.testDomQuery<{ ready: boolean }>(`
            return {
              ready: document.querySelector('.tab-load-select option[value="${configName}"]') instanceof HTMLOptionElement,
            };
          `),
        (state) => state.ready,
        30_000,
        150,
      );

      const initialConfig = await fs.readFile(configPath, 'utf8');
      const initialProjection = await client.getProjection();
      const initialRoot = initialProjection.active_tab_terminals.find((terminal) => terminal.kind === 'root_agent');
      expect(initialRoot).toBeTruthy();

      await client.driverTileDrag(rootAgent!.tile_id, 160, 110);
      const movedProjection = await waitFor(
        'root tile moved before overwrite attempt',
        () => client.getProjection(),
        (nextProjection) => {
          const nextRoot = nextProjection.active_tab_terminals.find((terminal) => terminal.kind === 'root_agent');
          return Boolean(nextRoot)
            && (nextRoot!.x !== initialRoot!.x || nextRoot!.y !== initialRoot!.y);
        },
        30_000,
        150,
      );
      const movedRoot = movedProjection.active_tab_terminals.find((terminal) => terminal.kind === 'root_agent')!;

      await client.testDomQuery(`
        window.__saveConfirmCalls = [];
        window.confirm = (message) => {
          window.__saveConfirmCalls.push(String(message));
          return false;
        };
        const saveButton = Array.from(document.querySelectorAll('.session-config-button')).find((element) =>
          (element.textContent ?? '').trim().startsWith('SAVE')
        );
        if (!(saveButton instanceof HTMLButtonElement)) {
          throw new Error('missing session save button');
        }
        saveButton.click();
        return true;
      `);

      const cancelledConfirm = await waitFor(
        'overwrite confirmation appears and is cancelled',
        () =>
          client.testDomQuery<{ confirmCalls: string[] }>(`
            return { confirmCalls: Array.from(window.__saveConfirmCalls ?? []) };
          `),
        (state) => state.confirmCalls.length === 1,
        30_000,
        150,
      );

      expect(cancelledConfirm.confirmCalls).toHaveLength(1);
      expect(cancelledConfirm.confirmCalls[0]).toContain(`${configName}_session.json`);
      expect(await fs.readFile(configPath, 'utf8')).toBe(initialConfig);

      await client.testDomQuery(`
        window.__saveConfirmCalls = [];
        window.confirm = (message) => {
          window.__saveConfirmCalls.push(String(message));
          return true;
        };
        const saveButton = Array.from(document.querySelectorAll('.session-config-button')).find((element) =>
          (element.textContent ?? '').trim().startsWith('SAVE')
        );
        if (!(saveButton instanceof HTMLButtonElement)) {
          throw new Error('missing session save button');
        }
        saveButton.click();
        return true;
      `);

      const confirmedOverwrite = await waitFor(
        'overwrite confirmation appears and is accepted',
        () =>
          client.testDomQuery<{ confirmCalls: string[] }>(`
            return { confirmCalls: Array.from(window.__saveConfirmCalls ?? []) };
          `),
        (state) => state.confirmCalls.length === 1,
        30_000,
        150,
      );

      expect(confirmedOverwrite.confirmCalls).toHaveLength(1);

      await waitFor(
        'saved session configuration overwritten after confirmation',
        async () => {
          const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
            tiles: Array<{ kind: string; layout: { x: number; y: number } }>;
          };
          const savedRoot = parsed.tiles.find((tile) => tile.kind === 'root_agent');
          return (
            Boolean(savedRoot)
            && Math.abs(savedRoot!.layout.x - movedRoot.x) < 0.001
            && Math.abs(savedRoot!.layout.y - movedRoot.y) < 0.001
          );
        },
        (saved) => saved,
        30_000,
        150,
      );
    } finally {
      await fs.rm(configPath, { force: true }).catch(() => undefined);
    }
  });

  it('shows save and delete status for the current session configuration name', async () => {
    const sessionName = `save-delete-session-${Date.now()}`;
    const configName = sanitizeSessionConfigName(sessionName);
    const fileName = `${configName}_session.json`;
    const configPath = path.join(rootDir(), 'sessions', fileName);
    const savedStatusText = `Saved ${fileName}.`;
    const deletedStatusText = `Deleted ${fileName}.`;

    try {
      await createIsolatedTab(client, sessionName);
      await client.settingsSidebarOpen();

      const initialState = await waitFor(
        'initial delete disabled and empty save status',
        () =>
          client.testDomQuery<{ deleteDisabled: boolean; statusText: string }>(`
            const deleteButton = Array.from(document.querySelectorAll('.session-config-button')).find((element) =>
              (element.textContent ?? '').trim().startsWith('DELETE')
            );
            const status = document.querySelector('.session-config-status');
            return {
              deleteDisabled: deleteButton instanceof HTMLButtonElement ? deleteButton.disabled : true,
              statusText: (status?.textContent ?? '').trim(),
            };
          `),
        (state) => state.deleteDisabled && state.statusText === 'No saved session file for this name.',
        30_000,
        150,
      );

      expect(initialState.deleteDisabled).toBe(true);

      await client.testDomQuery(`
        const saveButton = Array.from(document.querySelectorAll('.session-config-button')).find((element) =>
          (element.textContent ?? '').trim().startsWith('SAVE')
        );
        if (!(saveButton instanceof HTMLButtonElement)) {
          throw new Error('missing session save button');
        }
        saveButton.click();
        return true;
      `);

      await waitFor(
        'session configuration file saved',
        async () => {
          try {
            await fs.access(configPath);
            return true;
          } catch {
            return false;
          }
        },
        (exists) => exists,
        30_000,
        150,
      );

      const savedState = await waitFor(
        'delete enabled and save status shown',
        () =>
          client.testDomQuery<{ deleteDisabled: boolean; statusText: string }>(`
            const deleteButton = Array.from(document.querySelectorAll('.session-config-button')).find((element) =>
              (element.textContent ?? '').trim().startsWith('DELETE')
            );
            const status = document.querySelector('.session-config-status');
            return {
              deleteDisabled: deleteButton instanceof HTMLButtonElement ? deleteButton.disabled : true,
              statusText: (status?.textContent ?? '').trim(),
            };
          `),
        (state) => !state.deleteDisabled && state.statusText === savedStatusText,
        30_000,
        150,
      );

      expect(savedState.deleteDisabled).toBe(false);

      await client.testDomQuery(`
        window.__deleteConfirmCalls = [];
        window.confirm = (message) => {
          window.__deleteConfirmCalls.push(String(message));
          return true;
        };
        const deleteButton = Array.from(document.querySelectorAll('.session-config-button')).find((element) =>
          (element.textContent ?? '').trim().startsWith('DELETE')
        );
        if (!(deleteButton instanceof HTMLButtonElement)) {
          throw new Error('missing session delete button');
        }
        deleteButton.click();
        return true;
      `);

      const deleteConfirm = await waitFor(
        'delete confirmation appears',
        () =>
          client.testDomQuery<{ confirmCalls: string[] }>(`
            return { confirmCalls: Array.from(window.__deleteConfirmCalls ?? []) };
          `),
        (state) => state.confirmCalls.length === 1,
        30_000,
        150,
      );

      expect(deleteConfirm.confirmCalls[0]).toContain(fileName);

      await waitFor(
        'session configuration file deleted',
        async () => {
          try {
            await fs.access(configPath);
            return false;
          } catch {
            return true;
          }
        },
        (deleted) => deleted,
        30_000,
        150,
      );

      const deletedState = await waitFor(
        'delete disabled and delete status shown',
        () =>
          client.testDomQuery<{ deleteDisabled: boolean; statusText: string }>(`
            const deleteButton = Array.from(document.querySelectorAll('.session-config-button')).find((element) =>
              (element.textContent ?? '').trim().startsWith('DELETE')
            );
            const status = document.querySelector('.session-config-status');
            return {
              deleteDisabled: deleteButton instanceof HTMLButtonElement ? deleteButton.disabled : true,
              statusText: (status?.textContent ?? '').trim(),
            };
          `),
        (state) => state.deleteDisabled && state.statusText === deletedStatusText,
        30_000,
        150,
      );

      expect(deletedState.deleteDisabled).toBe(true);
    } finally {
      await fs.rm(configPath, { force: true }).catch(() => undefined);
    }
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
