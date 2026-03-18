<script lang="ts">
  import { commandBarOpen, commandText } from './stores/mode';
  import { addTab, removeTab, tabs, activeTabId } from './stores/tabs';
  import { terminals, removeTerminal, selectedTerminalId, spawnTerminal, updateTerminal } from './stores/terminals';
  import { canvasState } from './stores/canvas';
  import { get } from 'svelte/store';

  let inputRef: HTMLInputElement;

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      commandBarOpen.set(false);
      commandText.set('');
      e.preventDefault();
    } else if (e.key === 'Enter') {
      executeCommand($commandText.trim());
      commandBarOpen.set(false);
      commandText.set('');
      e.preventDefault();
    }
  }

  function executeCommand(cmd: string) {
    const parts = cmd.split(/\s+/);
    const verb = parts[0];

    switch (verb) {
      // --- Shell commands ---
      case 'sh':
      case 'shell':
      case 'new': {
        const state = get(canvasState);
        const cx = (window.innerWidth / 2 - state.panX) / state.zoom;
        const cy = ((window.innerHeight - 62) / 2 - state.panY) / state.zoom;
        const offset = Math.random() * 60 - 30;
        spawnTerminal(cx - 320 + offset, cy - 200 + offset, 640, 400, undefined, get(activeTabId));
        break;
      }

      case 'q':
      case 'close': {
        const selId = get(selectedTerminalId);
        if (selId) removeTerminal(selId);
        break;
      }

      case 'qa':
      case 'closeall': {
        const tabId = get(activeTabId);
        const tabTerms = get(terminals).filter(t => t.tabId === tabId);
        for (const t of tabTerms) removeTerminal(t.id);
        break;
      }

      case 'rename': {
        const selId = get(selectedTerminalId);
        const name = parts.slice(1).join(' ');
        if (selId && name) updateTerminal(selId, { title: name });
        break;
      }

      // --- Tab commands ---
      case 'tabnew':
      case 'tn': {
        addTab(parts.slice(1).join(' ') || undefined);
        break;
      }

      case 'tabclose':
      case 'tc': {
        removeTab(get(activeTabId));
        break;
      }

      case 'tabrename':
      case 'tr': {
        const name = parts.slice(1).join(' ');
        if (name) {
          const tabId = get(activeTabId);
          tabs.update(list => list.map(t => t.id === tabId ? { ...t, name } : t));
        }
        break;
      }

      // --- View commands ---
      case 'z':
      case 'zoom': {
        const selId = get(selectedTerminalId);
        if (!selId) break;
        const term = get(terminals).find(t => t.id === selId);
        if (!term) break;
        const viewW = window.innerWidth;
        const viewH = window.innerHeight - 54;
        const zoom = Math.min(viewW * 0.8 / term.width, viewH * 0.8 / term.height, 2);
        const panX = viewW / 2 - (term.x + term.width / 2) * zoom;
        const panY = viewH / 2 - (term.y + term.height / 2) * zoom;
        canvasState.set({ zoom, panX, panY });
        break;
      }

      case 'fit': {
        // Zoom to fit all terminals in view
        const tabId = get(activeTabId);
        const tabTerms = get(terminals).filter(t => t.tabId === tabId);
        if (tabTerms.length === 0) break;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const t of tabTerms) {
          minX = Math.min(minX, t.x);
          minY = Math.min(minY, t.y);
          maxX = Math.max(maxX, t.x + t.width);
          maxY = Math.max(maxY, t.y + t.height);
        }
        const viewW = window.innerWidth;
        const viewH = window.innerHeight - 54;
        const contentW = maxX - minX;
        const contentH = maxY - minY;
        const zoom = Math.min(viewW * 0.9 / contentW, viewH * 0.9 / contentH, 2);
        const panX = (viewW - contentW * zoom) / 2 - minX * zoom;
        const panY = (viewH - contentH * zoom) / 2 - minY * zoom;
        canvasState.set({ zoom, panX, panY });
        break;
      }

      case 'reset': {
        canvasState.set({ panX: 0, panY: 0, zoom: 1 });
        break;
      }

      // --- Help ---
      case 'h':
      case 'help': {
        // Could display help — for now just log
        console.log(HELP_TEXT);
        break;
      }

      default:
        break;
    }
  }

  const HELP_TEXT = `Commands:
  :sh :shell :new     — new shell
  :q :close           — close selected shell
  :qa :closeall       — close all shells in tab
  :rename <name>      — rename selected shell
  :tn :tabnew [name]  — new tab
  :tc :tabclose       — close tab
  :tr :tabrename <n>  — rename tab
  :z :zoom            — zoom to selected shell
  :fit                — fit all shells in view
  :reset              — reset zoom/pan
  :h :help            — show help`;

  $effect(() => {
    if ($commandBarOpen && inputRef) {
      inputRef.focus();
    }
  });
</script>

{#if $commandBarOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="command-bar" onkeydown={handleKeyDown}>
    <span class="prompt">:</span>
    <input
      bind:this={inputRef}
      bind:value={$commandText}
      class="command-input"
      spellcheck="false"
      autocomplete="off"
    />
  </div>
{/if}

<style>
  .command-bar {
    position: fixed;
    bottom: 22px;
    left: 0;
    right: 0;
    height: 24px;
    background: var(--pcb-dark);
    border-top: 1px solid var(--copper-dim);
    display: flex;
    align-items: center;
    padding: 0 8px;
    z-index: 1001;
  }

  .prompt {
    color: var(--phosphor-green);
    font-size: 13px;
    font-family: var(--font-mono);
    margin-right: 4px;
  }

  .command-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--phosphor-green);
    font-family: var(--font-mono);
    font-size: 12px;
    caret-color: var(--phosphor-green);
  }
</style>
