import { get, type Unsubscriber } from 'svelte/store';
import { tick } from 'svelte';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  addTab,
  appState,
  beginSidebarRename,
  buildTestDriverProjection,
  cancelCommandBar,
  dismissContextMenu,
  closeSidebar,
  commandText,
  dispatchIntent,
  dragTileBy,
  fitCanvasToActiveTab,
  mode,
  moveSidebarSelection,
  openSidebar,
  panCanvasBy,
  openCanvasContextMenu,
  openPaneContextMenu,
  removeTerminal,
  resizeTileTo,
  selectContextMenuItem,
  selectTile,
  setSidebarSelection,
  submitCommandBar,
  wheelCanvas,
  zoomCanvasAtPoint,
  zoomCanvasToTile,
} from './stores/appState';
import { handleGlobalKeyInput } from './interaction/keyboard';
import { resolveTestDriverRequest, setTestDriverState, tmuxStatus } from './tauri';
import type { TestDriverProjection, TestDriverRequest, TestDriverStatus } from './types';

interface TestDriverEventPayload {
  request_id: string;
  request: TestDriverRequest;
}

const POLL_INTERVAL_MS = 25;

let lastStateChangeAt = Date.now();
let activeRequestCount = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function projectionStatus(status: { server: boolean; cc: boolean }): TestDriverStatus {
  return {
    enabled: true,
    frontend_ready: true,
    bootstrap_complete: true,
    runtime_id: null,
    tmux_server_name: '',
    socket_path: '',
    tmux_server_alive: status.server,
    control_client_alive: status.cc,
  };
}

async function getProjection(): Promise<TestDriverProjection> {
  const status = await tmuxStatus().catch(() => ({ server: false, cc: false }));
  return buildTestDriverProjection(get(appState), projectionStatus(status));
}

async function waitForIdle(timeoutMs = 10_000, settleMs = 150): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const idleFor = Date.now() - lastStateChangeAt;
    if (activeRequestCount <= 1 && idleFor >= settleMs) {
      await tick();
      if (activeRequestCount <= 1 && Date.now() - lastStateChangeAt >= settleMs) {
        return;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for app idle after ${timeoutMs}ms`);
}

async function executeRequest(request: TestDriverRequest): Promise<unknown> {
  switch (request.type) {
    case 'ping':
      return { pong: true };
    case 'wait_for_ready':
    case 'wait_for_bootstrap':
      return null;
    case 'wait_for_idle':
      await waitForIdle(request.timeout_ms, request.settle_ms);
      return null;
    case 'get_state_tree':
      return get(appState);
    case 'get_projection':
      return getProjection();
    case 'get_status':
      return projectionStatus(await tmuxStatus().catch(() => ({ server: false, cc: false })));
    case 'press_keys': {
      const handled: boolean[] = [];
      for (const key of request.keys) {
        handled.push(await handleGlobalKeyInput(key, {
          viewportWidth: request.viewport_width,
          viewportHeight: request.viewport_height,
        }));
      }
      return { handled };
    }
    case 'command_bar_open':
      await dispatchIntent({ type: 'open-command-bar' });
      return null;
    case 'command_bar_set_text':
      commandText.set(request.text);
      return null;
    case 'command_bar_submit':
      await submitCommandBar();
      return null;
    case 'command_bar_cancel':
      cancelCommandBar();
      return null;
    case 'toolbar_select_tab':
      await dispatchIntent({ type: 'select-session', sessionId: request.session_id });
      return null;
    case 'toolbar_add_tab':
      return addTab(request.name ?? undefined);
    case 'toolbar_spawn_shell':
      await dispatchIntent({ type: 'new-shell' });
      return null;
    case 'sidebar_open':
      openSidebar();
      return null;
    case 'sidebar_close':
      closeSidebar();
      return null;
    case 'sidebar_select_item':
      setSidebarSelection(request.index);
      return null;
    case 'sidebar_move_selection':
      moveSidebarSelection(request.delta);
      return null;
    case 'sidebar_begin_rename':
      beginSidebarRename();
      return null;
    case 'tile_select':
      selectTile(request.pane_id);
      return null;
    case 'tile_close':
      removeTerminal(request.pane_id);
      return null;
    case 'tile_drag':
      await dragTileBy(request.pane_id, request.dx, request.dy);
      return null;
    case 'tile_resize':
      await resizeTileTo(request.pane_id, request.width, request.height);
      return null;
    case 'tile_title_double_click':
      zoomCanvasToTile(request.pane_id, request.viewport_width, request.viewport_height);
      return null;
    case 'canvas_pan':
      panCanvasBy(request.dx, request.dy);
      return null;
    case 'canvas_context_menu':
      openCanvasContextMenu(request.client_x, request.client_y);
      return null;
    case 'canvas_zoom_at':
      zoomCanvasAtPoint(request.x, request.y, request.zoom_factor);
      return null;
    case 'canvas_wheel':
      if (get(mode) === 'input') {
        return null;
      }
      wheelCanvas(request.delta_y, request.client_x, request.client_y);
      return null;
    case 'canvas_fit_all':
      fitCanvasToActiveTab(request.viewport_width, request.viewport_height);
      return null;
    case 'canvas_reset':
      await dispatchIntent({ type: 'reset-canvas' });
      return null;
    case 'tile_context_menu':
      openPaneContextMenu(request.pane_id, request.client_x, request.client_y);
      return null;
    case 'context_menu_select':
      await selectContextMenuItem(request.item_id);
      return null;
    case 'context_menu_dismiss':
      dismissContextMenu();
      return null;
    case 'confirm_close_tab':
      await dispatchIntent({ type: 'confirm-close-active-tab' });
      return null;
    case 'cancel_close_tab':
      await dispatchIntent({ type: 'cancel-close-active-tab' });
      return null;
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

export async function installTestDriver(): Promise<() => void> {
  const unsubscribeState: Unsubscriber = appState.subscribe(() => {
    lastStateChangeAt = Date.now();
  });

  const unlisten: UnlistenFn = await listen<TestDriverEventPayload>('test-driver-request', async (event) => {
    activeRequestCount += 1;
    try {
      const data = await executeRequest(event.payload.request);
      await resolveTestDriverRequest(event.payload.request_id, data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await resolveTestDriverRequest(event.payload.request_id, null, message);
    } finally {
      activeRequestCount = Math.max(0, activeRequestCount - 1);
      lastStateChangeAt = Date.now();
    }
  });

  await setTestDriverState({ frontendReady: true });

  return () => {
    unsubscribeState();
    unlisten();
  };
}
