<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { get } from 'svelte/store';
  import Toolbar from './lib/Toolbar.svelte';
  import Canvas from './lib/Canvas.svelte';
  import StatusBar from './lib/StatusBar.svelte';
  import CommandBar from './lib/CommandBar.svelte';
  import HelpPane from './lib/HelpPane.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import DebugPane from './lib/DebugPane.svelte';
  import { canvasState } from './lib/stores/canvas';
  import { sidebarOpen, sidebarSelectedIdx } from './lib/stores/sidebar';
  import { debugPaneOpen } from './lib/stores/debugPane';
  import {
    spawnTerminal,
    removeTerminal,
    updateTerminal,
    updateTerminalBySessionId,
    removeTerminalBySessionId,
    selectedTerminalId,
    terminals,
    autoArrange,
  } from './lib/stores/terminals';
  import { mode, commandBarOpen, helpOpen } from './lib/stores/mode';
  import { nextTab, prevTab, selectNextTerminal, selectPrevTerminal, selectDirectional, activeTabId, addTab, removeTab } from './lib/stores/tabs';
  import { getTileMethods } from './lib/stores/tileRegistry';
  import { invoke } from '@tauri-apps/api/core';
  import { createPty, writePty } from './lib/tauri';
  import type { ShellSpawnedEvent, ShellTitleChangedEvent } from './lib/types';

  let unlistenSpawn: UnlistenFn | null = null;
  let unlistenTitle: UnlistenFn | null = null;
  let unlistenDestroy: UnlistenFn | null = null;

  function handleSpawnShell() {
    // Tell tmux to create a new window. The control mode reader will detect
    // the new pane and emit shell-spawned, which creates the tile.
    createPty(80, 24).catch((e: any) => console.error('create_pty failed:', e));
  }


  function zoomToSelected() {
    const selId = get(selectedTerminalId);
    if (!selId) return;
    const term = get(terminals).find(t => t.id === selId);
    if (!term) return;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight - 54;
    const zoom = Math.min(viewW * 0.8 / term.width, viewH * 0.8 / term.height, 2);
    const panX = viewW / 2 - (term.x + term.width / 2) * zoom;
    const panY = viewH / 2 - (term.y + term.height / 2) * zoom;
    canvasState.set({ zoom, panX, panY });
  }

  function fitAll() {
    const tabId = get(activeTabId);
    const tabTerms = get(terminals).filter(t => t.tabId === tabId);
    if (tabTerms.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tabTerms) {
      minX = Math.min(minX, t.x);
      minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + t.width);
      maxY = Math.max(maxY, t.y + t.height);
    }
    const viewW = window.innerWidth;
    const viewH = window.innerHeight - 54;
    const zoom = Math.min(viewW * 0.9 / (maxX - minX), viewH * 0.9 / (maxY - minY), 2);
    const panX = (viewW - (maxX - minX) * zoom) / 2 - minX * zoom;
    const panY = (viewH - (maxY - minY) * zoom) / 2 - minY * zoom;
    canvasState.set({ zoom, panX, panY });
  }

  function closeAllInTab() {
    const tabId = get(activeTabId);
    const tabTerms = get(terminals).filter(t => t.tabId === tabId);
    for (const t of tabTerms) removeTerminal(t.id);
  }

  function handleKeyDown(e: KeyboardEvent) {
    const currentMode = get(mode);
    const cmdBarOpen = get(commandBarOpen);
    const isHelpOpen = get(helpOpen);

    // Debug: write to a visible element
    const selId2 = get(selectedTerminalId);
    const tile2 = selId2 ? getTileMethods(selId2) : null;
    const dbg = `[${currentMode}] key=${e.key} sel=${selId2?.slice(0,8)||'none'} wd=${!!tile2?.writeData}`;
    const el = document.getElementById('herd-debug');
    if (el) el.textContent = dbg;

    // If command bar is open, let it handle keys
    if (cmdBarOpen) return;

    // Close help on any key
    if (isHelpOpen) {
      helpOpen.set(false);
      e.preventDefault();
      return;
    }

    // Shift+Esc: exit input mode. Plain Esc passes through to the shell.
    // In command mode, plain Esc closes sidebar/help.
    if (e.key === 'Escape') {
      if (currentMode === 'input') {
        if (e.shiftKey) {
          mode.set('command');
          e.preventDefault();
        }
        // Plain Esc in input mode: let it pass through to the shell
        return;
      }
      // Command mode: close sidebar or no-op
      if (get(sidebarOpen)) {
        sidebarOpen.set(false);
        e.preventDefault();
        return;
      }
      e.preventDefault();
      return;
    }

    // In input mode: forward keystrokes directly to the selected pane
    if (currentMode === 'input') {
      const selId = get(selectedTerminalId);
      if (!selId) return;
      const tile = getTileMethods(selId);
      if (!tile?.writeData) return;

      // Convert key events to terminal data
      let data: string | null = null;
      if (e.key === 'Enter') data = '\r';
      else if (e.key === 'Backspace') data = '\x7f';
      else if (e.key === 'Tab') data = '\t';
      else if (e.key === 'ArrowUp') data = '\x1b[A';
      else if (e.key === 'ArrowDown') data = '\x1b[B';
      else if (e.key === 'ArrowRight') data = '\x1b[C';
      else if (e.key === 'ArrowLeft') data = '\x1b[D';
      else if (e.key === 'Home') data = '\x1b[H';
      else if (e.key === 'End') data = '\x1b[F';
      else if (e.key === 'Delete') data = '\x1b[3~';
      else if (e.key.length === 1 && !e.metaKey) {
        if (e.ctrlKey) {
          // Ctrl+A through Ctrl+Z → 0x01-0x1A
          const code = e.key.toLowerCase().charCodeAt(0) - 96;
          if (code >= 1 && code <= 26) data = String.fromCharCode(code);
        } else {
          data = e.key;
        }
      }

      if (data) {
        document.title = `WRITING: ${data.length}b to ${selId?.slice(0,8)}`;
        tile.writeData(data);
        e.preventDefault();
      } else {
        document.title = `NO DATA for key=${e.key}`;
      }
      return;
    }

    if (currentMode === 'command') {
      // Sidebar toggle
      if (e.key === 'b') {
        sidebarOpen.update(v => !v);
        e.preventDefault();
        return;
      }

      // Debug pane toggle
      if (e.key === 'd') {
        debugPaneOpen.update(v => !v);
        e.preventDefault();
        return;
      }

      // When sidebar is open, j/k/z control sidebar navigation
      if (get(sidebarOpen)) {
        if (e.key === 'j') {
          sidebarSelectedIdx.update(i => i + 1);
          e.preventDefault();
          return;
        }
        if (e.key === 'k') {
          sidebarSelectedIdx.update(i => Math.max(0, i - 1));
          e.preventDefault();
          return;
        }
        if (e.key === 'z') {
          // Zoom to the currently highlighted sidebar item's tile
          zoomToSelected();
          e.preventDefault();
          return;
        }
        if (e.key === 'i') {
          const selTerm = get(terminals).find(t => t.id === get(selectedTerminalId));
          if (!selTerm?.readOnly) {
            sidebarOpen.set(false);
            mode.set('input');
          }
          e.preventDefault();
          return;
        }
      }

      switch (e.key) {
        // --- Mode ---
        case 'i': {
          // Don't enter input mode on read-only tiles
          const selTerm = get(terminals).find(t => t.id === get(selectedTerminalId));
          if (selTerm?.readOnly) {
            e.preventDefault();
            break;
          }
          mode.set('input');
          e.preventDefault();
          break;
        }
        case '?':
          helpOpen.set(true);
          e.preventDefault();
          break;
        case ':':
          commandBarOpen.set(true);
          e.preventDefault();
          break;

        // --- Navigation (h/j/k/l directional, n/p cycle) ---
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
        // --- Move selected window (H/J/K/L) ---
        case 'H':
        case 'J':
        case 'K':
        case 'L': {
          const selId = get(selectedTerminalId);
          if (selId) {
            const term = get(terminals).find(t => t.id === selId);
            if (term) {
              const dx = e.key === 'H' ? -10 : e.key === 'L' ? 10 : 0;
              const dy = e.key === 'K' ? -10 : e.key === 'J' ? 10 : 0;
              updateTerminal(selId, { x: term.x + dx, y: term.y + dy });
            }
          }
          e.preventDefault();
          break;
        }

        // --- View ---
        case 'z':
          zoomToSelected();
          e.preventDefault();
          break;
        case 'f':
          fitAll();
          e.preventDefault();
          break;
        case '0':
          canvasState.set({ panX: 0, panY: 0, zoom: 1 });
          e.preventDefault();
          break;
        case 'a':
          autoArrange(get(activeTabId)).then(() => fitAll());
          e.preventDefault();
          break;

        // --- Windows ---
        case 's':
          handleSpawnShell();
          e.preventDefault();
          break;
        case 'q':
          { const selId = get(selectedTerminalId); if (selId) { selectNextTerminal(); removeTerminal(selId); } }
          e.preventDefault();
          break;
        case 'Q':
          closeAllInTab();
          e.preventDefault();
          break;

        // --- Tabs ---
        case 't':
          addTab();
          e.preventDefault();
          break;
        case 'w':
          removeTab(get(activeTabId));
          e.preventDefault();
          break;
      }
    }
  }

  onMount(async () => {
    // Use raw addEventListener to ensure keydown always fires regardless of Svelte re-renders
    window.addEventListener('keydown', handleKeyDown, true);

    unlistenSpawn = await listen<ShellSpawnedEvent>('shell-spawned', (event) => {
      const { session_id, pane_id, x, y, width, height, parent_session_id } = event.payload;
      // Don't create duplicates (check both session_id and pane_id across ALL tabs)
      const allTerms = get(terminals);
      const existing = allTerms.find(t =>
        t.sessionId === session_id || (pane_id && t.paneId === pane_id)
      );
      if (existing) return;

      // If this pane has a parent, put it on the same tab as the parent
      let tabId = get(activeTabId);
      if (parent_session_id) {
        const parent = allTerms.find(t => t.sessionId === parent_session_id);
        if (parent) tabId = parent.tabId;
      }

      spawnTerminal(x, y, width || 640, height || 400, session_id, tabId, parent_session_id || undefined, pane_id);
    });

    // Clear all tiles when tmux restarts
    await listen('shells-clear', () => {
      terminals.set([]);
      selectedTerminalId.set(null);
    });

    // Periodically clean orphan tiles (tiles whose panes no longer exist)
    setInterval(async () => {
      try {
        const resp = await invoke<{ data: Array<{ id: string; pane_id: string }> }>('list_shells_raw');
        const livePaneIds = new Set(resp.data?.map((s: any) => s.pane_id) || []);
        const allTerms = get(terminals);
        const orphans = allTerms.filter(t => t.paneId && !livePaneIds.has(t.paneId));
        if (orphans.length > 0) {
          terminals.update(list => list.filter(t => !t.paneId || livePaneIds.has(t.paneId)));
        }
      } catch {}
    }, 5000);

    unlistenTitle = await listen<ShellTitleChangedEvent>('shell-title-changed', (event) => {
      const { session_id, title } = event.payload;
      updateTerminalBySessionId(session_id, { title });
    });

    unlistenDestroy = await listen<string>('shell-destroyed', (event) => {
      removeTerminalBySessionId(event.payload);
    });

    await listen<{ session_id: string; read_only: boolean }>('shell-read-only', (event) => {
      const { session_id, read_only } = event.payload;
      updateTerminalBySessionId(session_id, { readOnly: read_only });
    });
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeyDown, true);
    if (unlistenSpawn) unlistenSpawn();
    if (unlistenTitle) unlistenTitle();
    if (unlistenDestroy) unlistenDestroy();
  });
</script>

{''}

<Toolbar onSpawnShell={handleSpawnShell} />
<Sidebar />
<Canvas />
<CommandBar />
<DebugPane />
<StatusBar />
<HelpPane />
