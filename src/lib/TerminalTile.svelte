<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { FitAddon } from '@xterm/addon-fit';
  import { Terminal } from '@xterm/xterm';
  import { readPaneOutput } from './tauri';
  import type { TerminalInfo, PtyOutputEvent } from './types';
  import {
    canvasState,
    mode,
    persistPaneLayout,
    reportPaneViewport,
    removeTerminal,
    selectedTerminalId,
    updateTerminal,
  } from './stores/appState';

  interface Props {
    info: TerminalInfo;
  }

  let { info }: Props = $props();

  let termRef = $state<HTMLDivElement>();
  let terminal: Terminal;
  let fitAddon: FitAddon;
  let helperTextarea: HTMLTextAreaElement | null = null;
  let unlistenOutput: UnlistenFn | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let syncFrame: number | null = null;
  let lastViewportKey = '';

  let isSelected = $derived($selectedTerminalId === info.id);
  let designator = $derived(`P${info.id.replace(/\D/g, '') || info.paneId.replace(/\D/g, '')}`);
  let displayTitle = $derived(info.title !== 'shell' ? info.title : designator);

  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let origX = 0;
  let origY = 0;

  let isResizing = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let origW = 0;
  let origH = 0;

  function syncHelperTextarea() {
    const nextTextarea = termRef?.querySelector('textarea');
    const normalized = nextTextarea instanceof HTMLTextAreaElement ? nextTextarea : null;
    if (normalized === helperTextarea) return;
    helperTextarea = normalized;
  }

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
    terminal.open(termRef!);
    syncHelperTextarea();
    await new Promise((resolve) => setTimeout(resolve, 50));
    syncHelperTextarea();
    void syncViewport(true);

    const initialOutput = await readPaneOutput(info.paneId).catch(() => '');
    if (initialOutput) {
      terminal.write(initialOutput);
    }

    unlistenOutput = await listen<PtyOutputEvent>('pty-output', (event) => {
      if (event.payload.pane_id === info.paneId) {
        terminal.write(event.payload.data);
      }
    });

    resizeObserver = new ResizeObserver(() => {
      queueViewportSync();
    });
    resizeObserver.observe(termRef!);
  });

  onDestroy(() => {
    if (syncFrame !== null) {
      cancelAnimationFrame(syncFrame);
    }
    if (resizeObserver) resizeObserver.disconnect();
    if (unlistenOutput) unlistenOutput();
    if (terminal) terminal.dispose();
  });

  function queueViewportSync() {
    if (syncFrame !== null) {
      cancelAnimationFrame(syncFrame);
    }
    syncFrame = requestAnimationFrame(() => {
      syncFrame = null;
      void syncViewport();
    });
  }

  async function syncViewport(requestResize = false) {
    if (!terminal || !fitAddon || !termRef) return;
    fitAddon.fit();
    const cols = terminal.cols;
    const rows = terminal.rows;
    const pixelWidth = termRef.clientWidth;
    const pixelHeight = termRef.clientHeight;
    if (!cols || !rows || !pixelWidth || !pixelHeight) return;

    const viewportKey = [
      info.x,
      info.y,
      info.width,
      info.height,
      cols,
      rows,
      pixelWidth,
      pixelHeight,
    ].join(':');

    if (viewportKey === lastViewportKey && !requestResize) return;
    lastViewportKey = viewportKey;
    await reportPaneViewport(info.paneId, cols, rows, pixelWidth, pixelHeight, requestResize);
  }

  $effect(() => {
    info.x;
    info.y;
    info.width;
    info.height;
    if (terminal) {
      queueViewportSync();
    }
  });

  $effect(() => {
    syncHelperTextarea();
    if (!terminal || !helperTextarea) return;

    if ($mode === 'input' && isSelected && !info.readOnly) {
      helperTextarea.focus();
      return;
    }

    if (document.activeElement === helperTextarea) {
      helperTextarea.blur();
    }
  });

  function handleTitleDblClick(e: MouseEvent) {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight - 32;
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
      updateTerminal(info.id, {
        width: Math.max(300, origW + dx),
        height: Math.max(200, origH + dy),
      });
    }
  }

  function handleWindowMouseUp() {
    const wasDragging = isDragging;
    const wasResizing = isResizing;

    if (wasDragging) {
      void persistPaneLayout(info.id);
    }

    if (wasResizing) {
      void syncViewport(true);
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
    if ($mode === 'command') {
      e.preventDefault();
    }
    e.stopPropagation();
  }}
>
  <div class="component-body">
    <div class="ic-notch"></div>

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

    <div class="screen-housing">
      <div class="screen-bezel">
        <div class="terminal-container" bind:this={termRef}></div>
      </div>
      <div class="phosphor-glow"></div>
      <div class="input-shield" class:pass-through={$mode === 'input'}></div>
    </div>

    <div class="info-strip">
      <span class="info-item">
        <span class="status-dot active"></span>
        <span class="info-label">PID:{info.paneId.slice(0, 8)}</span>
      </span>
      <span class="info-item">
        <span class="info-label">{info.width}×{info.height}</span>
      </span>
    </div>
  </div>

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

  .component-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--component-bg);
    border: 1px solid var(--component-border);
    position: relative;
    min-width: 0;
  }

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
    padding: 0;
  }

  .close-btn:hover {
    color: var(--phosphor-red);
    border-color: rgba(255, 51, 51, 0.2);
  }

  .close-x {
    font-size: 12px;
    line-height: 1;
  }

  .screen-housing {
    position: relative;
    flex: 1;
    min-height: 0;
    background: linear-gradient(180deg, #0b1408 0%, #060d04 100%);
  }

  .screen-bezel {
    position: absolute;
    inset: 8px;
    border: 1px solid var(--component-border);
    background: #060d04;
    overflow: hidden;
  }

  .terminal-container {
    width: 100%;
    height: 100%;
    padding: 6px;
  }

  .phosphor-glow {
    position: absolute;
    inset: 8px;
    pointer-events: none;
    box-shadow: inset 0 0 24px rgba(51, 255, 51, 0.06);
  }

  .input-shield {
    position: absolute;
    inset: 8px;
    background: transparent;
    pointer-events: auto;
  }

  .input-shield.pass-through {
    pointer-events: none;
  }

  .info-strip {
    height: 20px;
    padding: 0 8px;
    border-top: 1px solid var(--component-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    background: rgba(0, 0, 0, 0.2);
  }

  .info-item {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .info-label {
    font-size: 8px;
    color: var(--silk-dim);
    letter-spacing: 0.5px;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--component-border);
  }

  .status-dot.active {
    background: var(--phosphor-green);
    box-shadow: 0 0 6px rgba(51, 255, 51, 0.3);
  }

  .resize-handle {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
