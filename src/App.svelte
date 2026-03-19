<script lang="ts">
  import { get } from 'svelte/store';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { onDestroy, onMount } from 'svelte';
  import Canvas from './lib/Canvas.svelte';
  import CommandBar from './lib/CommandBar.svelte';
  import DebugPane from './lib/DebugPane.svelte';
  import HelpPane from './lib/HelpPane.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import StatusBar from './lib/StatusBar.svelte';
  import Toolbar from './lib/Toolbar.svelte';
  import {
    activeTabId,
    activeTabTerminals,
    addTab,
    appState,
    applyPaneReadOnly,
    applyTmuxSnapshot,
    autoArrange,
    beginSidebarRename,
    bootstrapAppState,
    canvasState,
    commandBarOpen,
    debugPaneOpen,
    dispatchIntent,
    helpOpen,
    mode,
    moveSidebarSelection,
    nextTab,
    prevTab,
    removeTab,
    selectedTerminalId,
    selectDirectional,
    selectNextTerminal,
    selectPrevTerminal,
    sidebarOpen,
    terminals,
    updateTerminal,
  } from './lib/stores/appState';
  import type { TmuxSnapshot } from './lib/types';

  let unlistenTmuxState: UnlistenFn | null = null;
  let unlistenReadOnly: UnlistenFn | null = null;
  const CANVAS_PAN_STEP = 80;
  const WINDOW_MOVE_STEP = 10;

  function handleSpawnShell() {
    void dispatchIntent({ type: 'new-shell' });
  }

  function toggleSelectedZoom(fullscreen = false) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight - 54;
    void dispatchIntent(
      fullscreen
        ? { type: 'toggle-selected-fullscreen-zoom', viewportWidth, viewportHeight }
        : { type: 'toggle-selected-zoom', viewportWidth, viewportHeight },
    );
  }

  function fitAll() {
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
    const viewW = window.innerWidth;
    const viewH = window.innerHeight - 54;
    const zoom = Math.min(viewW * 0.9 / (maxX - minX), viewH * 0.9 / (maxY - minY), 2);
    const panX = (viewW - (maxX - minX) * zoom) / 2 - minX * zoom;
    const panY = (viewH - (maxY - minY) * zoom) / 2 - minY * zoom;
    canvasState.set({ zoom, panX, panY });
  }

  function closeActiveTabWithConfirmation() {
    const tabId = get(activeTabId);
    if (!tabId) return;
    const currentState = get(appState);
    const panesInTab = get(activeTabTerminals).length;
    if (panesInTab > 1) {
      const sessionName = currentState.tmux.sessions[tabId]?.name || 'this tab';
      const shouldClose = window.confirm(`Close "${sessionName}" and kill ${panesInTab} panes?`);
      if (!shouldClose) return;
    }
    removeTab(tabId);
  }

  function zoomCanvasAtViewportCenter(zoomFactor: number) {
    const viewport = document.querySelector<HTMLElement>('.canvas-viewport');
    const rect = viewport?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.height / 2 : (window.innerHeight - 54) / 2;

    canvasState.update((state) => {
      const newZoom = Math.max(0.2, Math.min(3, state.zoom * zoomFactor));
      const dx = cx - state.panX;
      const dy = cy - state.panY;
      const scale = newZoom / state.zoom;

      return {
        zoom: newZoom,
        panX: cx - dx * scale,
        panY: cy - dy * scale,
      };
    });
  }

  function panCanvas(dx: number, dy: number) {
    canvasState.update((state) => ({
      ...state,
      panX: state.panX + dx,
      panY: state.panY + dy,
    }));
  }

  function moveSelectedTerminal(dx: number, dy: number) {
    const selectedId = get(selectedTerminalId);
    if (!selectedId) return;
    const term = get(terminals).find((item) => item.id === selectedId);
    if (!term) return;
    updateTerminal(selectedId, { x: term.x + dx, y: term.y + dy });
  }

  function keyEventToData(e: KeyboardEvent): string | null {
    if (e.metaKey || e.altKey) return null;
    if (e.key === 'Enter') return '\r';
    if (e.key === 'Backspace') return '\x7f';
    if (e.key === 'Tab') return '\t';
    if (e.key === 'ArrowUp') return '\x1b[A';
    if (e.key === 'ArrowDown') return '\x1b[B';
    if (e.key === 'ArrowRight') return '\x1b[C';
    if (e.key === 'ArrowLeft') return '\x1b[D';
    if (e.key === 'Home') return '\x1b[H';
    if (e.key === 'End') return '\x1b[F';
    if (e.key === 'Delete') return '\x1b[3~';
    if (e.key === ' ' || e.code === 'Space') return ' ';
    if (e.key.length === 1) {
      if (e.ctrlKey) {
        const code = e.key.toLowerCase().charCodeAt(0) - 96;
        if (code >= 1 && code <= 26) return String.fromCharCode(code);
        return null;
      }
      return e.key;
    }
    return null;
  }

  function handleKeyDown(e: KeyboardEvent) {
    const state = get(appState);
    const currentMode = get(mode);

    if (get(commandBarOpen)) {
      return;
    }

    if (get(helpOpen)) {
      helpOpen.set(false);
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape') {
      if (currentMode === 'input') {
        if (e.shiftKey) {
          void dispatchIntent({ type: 'exit-input-mode' });
          e.preventDefault();
        }
        return;
      }
      if (get(sidebarOpen)) {
        sidebarOpen.set(false);
        e.preventDefault();
        return;
      }
      e.preventDefault();
      return;
    }

    if (currentMode === 'input') {
      const data = keyEventToData(e);
      if (data) {
        void dispatchIntent({ type: 'send-input', data });
        e.preventDefault();
      }
      return;
    }

    const lowerKey = e.key.toLowerCase();

    if (e.ctrlKey && !e.metaKey && !e.altKey && ['h', 'j', 'k', 'l'].includes(lowerKey)) {
      const distance = WINDOW_MOVE_STEP * (e.shiftKey ? 2 : 1);
      const dx = lowerKey === 'h' ? -distance : lowerKey === 'l' ? distance : 0;
      const dy = lowerKey === 'k' ? -distance : lowerKey === 'j' ? distance : 0;
      moveSelectedTerminal(dx, dy);
      e.preventDefault();
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && ['h', 'j', 'k', 'l'].includes(lowerKey)) {
      const dx = lowerKey === 'h' ? -CANVAS_PAN_STEP : lowerKey === 'l' ? CANVAS_PAN_STEP : 0;
      const dy = lowerKey === 'k' ? -CANVAS_PAN_STEP : lowerKey === 'j' ? CANVAS_PAN_STEP : 0;
      panCanvas(dx, dy);
      e.preventDefault();
      return;
    }

    if (
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.shiftKey &&
      (e.key === '_' || e.key === '-' || e.key === '+' || e.key === '=')
    ) {
      zoomCanvasAtViewportCenter(e.key === '+' || e.key === '=' ? 1.05 : 0.95);
      e.preventDefault();
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === 'b') {
      void dispatchIntent({ type: 'toggle-sidebar' });
      e.preventDefault();
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === 'd') {
      void dispatchIntent({ type: 'toggle-debug' });
      e.preventDefault();
      return;
    }

    if (e.metaKey || e.altKey || e.ctrlKey) {
      return;
    }

    if (get(sidebarOpen)) {
      if (e.key === 'j') {
        moveSidebarSelection(1);
        e.preventDefault();
        return;
      }
      if (e.key === 'k') {
        moveSidebarSelection(-1);
        e.preventDefault();
        return;
      }
      if (e.key === 'z') {
        toggleSelectedZoom();
        e.preventDefault();
        return;
      }
      if (e.key === 'Z') {
        toggleSelectedZoom(true);
        e.preventDefault();
        return;
      }
      if (e.key === 'r') {
        beginSidebarRename();
        e.preventDefault();
        return;
      }
      if (e.key === 'i') {
        const selectedId = get(selectedTerminalId);
        if (selectedId && !state.tmux.panes[selectedId]?.readOnly) {
          sidebarOpen.set(false);
          void dispatchIntent({ type: 'enter-input-mode' });
        }
        e.preventDefault();
        return;
      }
    }

    switch (e.key) {
      case 'i':
        void dispatchIntent({ type: 'enter-input-mode' });
        e.preventDefault();
        break;
      case '?':
        void dispatchIntent({ type: 'open-help' });
        e.preventDefault();
        break;
      case ':':
        void dispatchIntent({ type: 'open-command-bar' });
        e.preventDefault();
        break;
      case 'h':
      case 'j':
      case 'k':
      case 'l':
        selectDirectional(e.key as 'h' | 'j' | 'k' | 'l');
        e.preventDefault();
        break;
      case 'n':
        selectNextTerminal();
        e.preventDefault();
        break;
      case 'p':
        selectPrevTerminal();
        e.preventDefault();
        break;
      case 'N':
        nextTab();
        e.preventDefault();
        break;
      case 'P':
        prevTab();
        e.preventDefault();
        break;
      case 'H':
      case 'J':
      case 'K':
      case 'L': {
        const dx = e.key === 'H' ? -CANVAS_PAN_STEP : e.key === 'L' ? CANVAS_PAN_STEP : 0;
        const dy = e.key === 'K' ? -CANVAS_PAN_STEP : e.key === 'J' ? CANVAS_PAN_STEP : 0;
        panCanvas(dx, dy);
        e.preventDefault();
        break;
      }
      case 'z':
        toggleSelectedZoom();
        e.preventDefault();
        break;
      case 'Z':
        toggleSelectedZoom(true);
        e.preventDefault();
        break;
      case 'f':
        fitAll();
        e.preventDefault();
        break;
      case '0':
        void dispatchIntent({ type: 'reset-canvas' });
        e.preventDefault();
        break;
      case 'a':
        void autoArrange(get(activeTabId)).then(() => fitAll());
        e.preventDefault();
        break;
      case 's':
        handleSpawnShell();
        e.preventDefault();
        break;
      case 'x':
        void dispatchIntent({ type: 'close-selected-pane' });
        e.preventDefault();
        break;
      case 'X':
        closeActiveTabWithConfirmation();
        e.preventDefault();
        break;
      case 't':
        void addTab();
        e.preventDefault();
        break;
      case 'w': {
        closeActiveTabWithConfirmation();
        e.preventDefault();
        break;
      }
    }
  }

  onMount(async () => {
    await bootstrapAppState();
    window.addEventListener('keydown', handleKeyDown, true);
    unlistenTmuxState = await listen<TmuxSnapshot>('tmux-state', (event) => {
      applyTmuxSnapshot(event.payload);
    });
    unlistenReadOnly = await listen<{ session_id?: string; pane_id?: string; read_only: boolean }>('shell-read-only', (event) => {
      const paneId = event.payload.pane_id ?? event.payload.session_id;
      if (paneId) {
        applyPaneReadOnly(paneId, event.payload.read_only);
      }
    });
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeyDown, true);
    if (unlistenTmuxState) unlistenTmuxState();
    if (unlistenReadOnly) unlistenReadOnly();
  });
</script>

<Toolbar onSpawnShell={handleSpawnShell} />
<Sidebar />
<Canvas />
<CommandBar />
<DebugPane />
<StatusBar />
<HelpPane />
