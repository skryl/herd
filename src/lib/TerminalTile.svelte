<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { createPty, destroyPty, writePty, resizePty, readPtyOutput, saveTileState } from './tauri';
  import { removeTerminal, updateTerminal, selectedTerminalId } from './stores/terminals';
  import { canvasState } from './stores/canvas';
  import { mode } from './stores/mode';
  import { registerTile, unregisterTile } from './stores/tileRegistry';
  import type { TerminalInfo } from './types';

  interface Props {
    info: TerminalInfo;
  }
  let { info }: Props = $props();

  let isSelected = $derived($selectedTerminalId === info.id);
  let isInputMode = $derived($mode === 'input');

  let termRef: HTMLDivElement;
  let terminal: Terminal;
  let fitAddon: FitAddon;
  let sessionId = $state<string | null>(null);
  let unlisten: UnlistenFn | null = null;
  let unlisten2: UnlistenFn | null = null;

  // Component designator (U1, U2, etc.)
  let designator = $derived('U' + info.id.replace(/\D/g, ''));
  // Show custom title if set, otherwise show designator
  let displayTitle = $derived(info.title !== 'shell' ? info.title : designator);

  // Drag state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let origX = 0;
  let origY = 0;

  // Resize state
  let isResizing = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let origW = 0;
  let origH = 0;

  onMount(async () => {
    terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 12,
      fontFamily: "'Share Tech Mono', 'Courier New', monospace",
      lineHeight: 1.15,
      theme: {
        background: '#060d04',
        foreground: '#33ff33',
        cursor: '#33ff33',
        cursorAccent: '#060d04',
        selectionBackground: 'rgba(51, 255, 51, 0.2)',
        selectionForeground: '#33ff33',
        black: '#0a0e08',
        red: '#ff3333',
        green: '#33ff33',
        yellow: '#ffaa00',
        blue: '#3388ff',
        magenta: '#cc33ff',
        cyan: '#33cccc',
        white: '#c0c8b8',
        brightBlack: '#2a3a20',
        brightRed: '#ff5555',
        brightGreen: '#55ff55',
        brightYellow: '#ffcc33',
        brightBlue: '#5599ff',
        brightMagenta: '#dd55ff',
        brightCyan: '#55dddd',
        brightWhite: '#e0e8d8',
      },
      scrollback: 5000,
      allowProposedApi: true,
    });

    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(termRef);

    await new Promise(r => setTimeout(r, 50));
    fitAddon.fit();

    const cols = terminal.cols;
    const rows = terminal.rows;

    // Register tile methods immediately — writeData uses sessionId which updates later
    registerTile(info.id, {
      scrollUp: () => terminal.scrollLines(-3),
      scrollDown: () => terminal.scrollLines(3),
      focusTerminal: () => terminal.focus(),
      blurTerminal: () => terminal.blur(),
      writeData: (data: string) => {
        if (sessionId) writePty(sessionId, data).catch(() => {});
      },
    });

    if (!info.sessionId) {
      terminal.write('\r\nWaiting for session...\r\n');
      return;
    }

    sessionId = info.sessionId;

    // Listen on a single global event, filter by session_id or pane_id
    unlisten = await listen<{ sid: string; pane: string; data: string }>('pty-output', (event) => {
      const { sid, pane, data } = event.payload;
      if (sid === sessionId || pane === info.paneId) {
        terminal.write(data);
      }
    });

    // Resize the pane to match our tile dimensions
    await resizePty(sessionId, cols, rows).catch(() => {});

    // Force the shell to redraw after a delay. The delay ensures our
    // pty-output listener is fully registered before the output arrives.
    setTimeout(() => {
      if (sessionId) writePty(sessionId, '\x0c').catch(() => {});
    }, 500);
  });

  onDestroy(() => {
    unregisterTile(info.id);
    if (unlisten) unlisten();
    if (unlisten2) unlisten2();
    if (sessionId) destroyPty(sessionId).catch(() => {});
    if (terminal) terminal.dispose();
  });

  function handleTitleDblClick(e: MouseEvent) {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight - 32;
    // Zoom so the tile fills ~80% of the viewport
    const zoom = Math.min(viewW * 0.8 / info.width, viewH * 0.8 / info.height, 2);
    const panX = viewW / 2 - (info.x + info.width / 2) * zoom;
    const panY = viewH / 2 - (info.y + info.height / 2) * zoom;
    canvasState.set({ zoom, panX, panY });
    e.stopPropagation();
  }

  function handleTitleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    origX = info.x;
    origY = info.y;
    e.preventDefault();
    e.stopPropagation();
  }

  function handleResizeMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    origW = info.width;
    origH = info.height;
    e.preventDefault();
    e.stopPropagation();
  }

  function handleWindowMouseMove(e: MouseEvent) {
    if (isDragging) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      updateTerminal(info.id, { x: origX + dx, y: origY + dy });
    } else if (isResizing) {
      const dx = e.clientX - resizeStartX;
      const dy = e.clientY - resizeStartY;
      const newW = Math.max(300, origW + dx);
      const newH = Math.max(200, origH + dy);
      updateTerminal(info.id, { width: newW, height: newH });
    }
  }

  function handleWindowMouseUp() {
    if (isResizing && fitAddon && sessionId) {
      fitAddon.fit();
      resizePty(sessionId, terminal.cols, terminal.rows).catch(() => {});
    }
    // Persist position/size after drag or resize
    if ((isDragging || isResizing) && sessionId) {
      saveTileState(sessionId, info.x, info.y, info.width, info.height, info.title).catch(() => {});
    }
    isDragging = false;
    isResizing = false;
  }

  function handleClose() {
    removeTerminal(info.id);
  }
</script>

<svelte:window onmousemove={handleWindowMouseMove} onmouseup={handleWindowMouseUp} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="pcb-component"
  class:selected={isSelected}
  style="left: {info.x}px; top: {info.y}px; width: {info.width}px; height: {info.height}px; z-index: {isSelected ? 10 : 1};"
  onmousedown={(e) => {
    selectedTerminalId.set(info.id);
    // In command mode, prevent xterm from stealing focus
    if ($mode === 'command') {
      e.preventDefault();
    }
    e.stopPropagation();
  }}
>
  <!-- Silkscreen component outline -->
  <div class="component-body">
    <!-- Notch indicator (IC orientation mark) -->
    <div class="ic-notch"></div>

    <!-- Header bar with designator -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="header-bar" onmousedown={handleTitleMouseDown} ondblclick={handleTitleDblClick}>
      <div class="header-left">
        <span class="designator">{displayTitle}</span>
        <span class="component-type">{info.readOnly ? 'VIEW' : 'TTY'}</span>
      </div>
      <div class="header-right">
        <span class="coord-info">{Math.round(info.x)},{Math.round(info.y)}</span>
        <button class="close-btn" onclick={handleClose}>
          <span class="close-x">×</span>
        </button>
      </div>
    </div>

    <!-- Terminal screen area -->
    <div class="screen-housing">
      <div class="screen-bezel">
        <div class="terminal-container" bind:this={termRef}></div>
      </div>
      <!-- Phosphor glow effect -->
      <div class="phosphor-glow"></div>
      <!-- Prevent xterm from stealing focus -->
      <div class="input-shield"></div>
    </div>

    <!-- Bottom info strip -->
    <div class="info-strip">
      <span class="info-item">
        {#if sessionId}
          <span class="status-dot active"></span>
          <span class="info-label">SID:{sessionId?.slice(0, 8)}</span>
        {:else}
          <span class="status-dot"></span>
          <span class="info-label">INIT...</span>
        {/if}
      </span>
      <span class="info-item">
        <span class="info-label">{info.width}×{info.height}</span>
      </span>
    </div>
  </div>

  <!-- Resize handle -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="resize-handle" onmousedown={handleResizeMouseDown}>
    <svg width="10" height="10" viewBox="0 0 10 10">
      <line x1="9" y1="1" x2="1" y2="9" stroke="var(--copper-dim)" stroke-width="1"/>
      <line x1="9" y1="4" x2="4" y2="9" stroke="var(--copper-dim)" stroke-width="1"/>
      <line x1="9" y1="7" x2="7" y2="9" stroke="var(--copper-dim)" stroke-width="1"/>
    </svg>
  </div>
</div>

<style>
  .pcb-component {
    position: absolute;
    display: flex;
    align-items: stretch;
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.6));
  }

  .pcb-component.selected {
    filter: drop-shadow(0 0 6px rgba(51, 255, 51, 0.3));
  }

  .pcb-component.selected .component-body {
    border-color: var(--phosphor-green-dim);
  }

  /* ---- COMPONENT BODY ---- */
  .component-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--component-bg);
    border: 1px solid var(--component-border);
    position: relative;
    min-width: 0;
  }

  /* IC orientation notch */
  .ic-notch {
    position: absolute;
    top: -1px;
    left: 50%;
    transform: translateX(-50%);
    width: 16px;
    height: 8px;
    border-radius: 0 0 8px 8px;
    border: 1px solid var(--component-border);
    border-top: none;
    background: var(--pcb-dark);
  }

  /* ---- HEADER BAR ---- */
  .header-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 22px;
    padding: 0 8px;
    background: var(--pcb-mask);
    border-bottom: 1px solid var(--component-border);
    cursor: move;
    user-select: none;
    -webkit-user-select: none;
    flex-shrink: 0;
  }

  .header-left, .header-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .designator {
    font-size: 11px;
    font-weight: normal;
    color: var(--silk-white);
    letter-spacing: 1px;
  }

  .component-type {
    font-size: 9px;
    color: var(--silk-dim);
    letter-spacing: 0.5px;
  }

  .coord-info {
    font-size: 8px;
    color: var(--copper-dim);
    letter-spacing: 0.5px;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: none;
    border: 1px solid transparent;
    color: var(--silk-dim);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 14px;
    line-height: 1;
    padding: 0;
    transition: all 0.1s;
  }

  .close-btn:hover {
    border-color: var(--phosphor-red);
    color: var(--phosphor-red);
    background: rgba(255, 51, 51, 0.1);
  }

  .close-x {
    margin-top: -1px;
  }

  /* ---- TERMINAL SCREEN ---- */
  .screen-housing {
    flex: 1;
    position: relative;
    overflow: hidden;
    min-height: 0;
  }

  .screen-bezel {
    position: absolute;
    inset: 3px;
    border: 1px solid var(--pcb-light);
    overflow: hidden;
  }

  .terminal-container {
    width: 100%;
    height: 100%;
    padding: 2px 4px;
  }

  .terminal-container :global(.xterm) {
    height: 100%;
  }

  /* Block clicks to xterm in command mode */
  .input-shield {
    position: absolute;
    inset: 0;
    z-index: 1;
    cursor: default;
  }

  /* Green phosphor glow around terminal edge */
  .phosphor-glow {
    position: absolute;
    inset: 2px;
    pointer-events: none;
    box-shadow: inset 0 0 20px rgba(51, 255, 51, 0.03);
    border: 1px solid rgba(51, 255, 51, 0.04);
  }

  /* ---- INFO STRIP ---- */
  .info-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 16px;
    padding: 0 8px;
    background: var(--pcb-mask);
    border-top: 1px solid var(--component-border);
    flex-shrink: 0;
  }

  .info-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .info-label {
    font-size: 8px;
    color: var(--silk-dim);
    letter-spacing: 0.5px;
  }

  .status-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--silk-dim);
  }

  .status-dot.active {
    background: var(--phosphor-green);
    box-shadow: 0 0 4px var(--phosphor-green);
  }

  /* ---- RESIZE HANDLE ---- */
  .resize-handle {
    position: absolute;
    bottom: 0;
    right: 16px;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }

  .resize-handle:hover :global(line) {
    stroke: var(--phosphor-green-dim);
  }
</style>
