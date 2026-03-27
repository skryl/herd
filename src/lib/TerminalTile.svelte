<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { FitAddon } from '@xterm/addon-fit';
  import { Terminal } from '@xterm/xterm';
  import TerminalDisplayDrawer from './TerminalDisplayDrawer.svelte';
  import TileSignalStrip from './TileSignalStrip.svelte';
  import TileActivityDrawer from './TileActivityDrawer.svelte';
  import TilePorts from './TilePorts.svelte';
  import { readPaneOutput } from './tauri';
  import type { TerminalInfo, PtyOutputEvent } from './types';
  import {
    agentDisplayByTileId,
    canvasState,
    clientDeltaToWorldDelta,
    mode,
    openPaneContextMenu,
    persistPaneLayout,
    registerPaneDriverHandle,
    reportPaneViewport,
    removeTerminal,
    selectTile,
    selectedTileIds,
    tileSignalByTileId,
    tileActivityById,
    togglePaneMinimized,
    updateTerminal,
    zoomCanvasToTile,
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
  let unregisterDriverHandle: (() => void) | null = null;

  let isSelected = $derived($selectedTileIds.includes(info.tileId));
  let isLocked = $derived(Boolean(info.locked));
  let designator = $derived(`P${info.id.replace(/\D/g, '') || info.paneId.replace(/\D/g, '')}`);
  let displayTitle = $derived(info.title !== 'shell' ? info.title : designator);
  let activityEntries = $derived($tileActivityById[info.tileId] ?? []);
  let displayFrame = $derived($agentDisplayByTileId[info.tileId] ?? null);
  let tileSignal = $derived($tileSignalByTileId[info.tileId] ?? null);
  let isRootAgentTile = $derived(info.kind === 'root_agent');
  let isAgentTile = $derived(isRootAgentTile || info.kind === 'claude');
  let isBrowserTile = $derived(info.kind === 'browser');
  let canClose = $derived(true);
  let closeLabel = $derived(isRootAgentTile ? 'Close Root Agent' : 'Close Shell');
  let minimizeLabel = $derived(isRootAgentTile ? 'Minimize Root Agent' : isAgentTile ? 'Minimize Agent' : 'Minimize Shell');
  let displayEmptyText = $derived(isAgentTile ? 'No display frame yet' : 'Display is only available for agent tiles');
  let defaultStatusText = $derived(buildDefaultStatusText(displayTitle, info.tileId));
  let shellViewOpen = $state(true);
  let displayOpen = $state(false);
  let activityOpen = $state(false);

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
    unregisterDriverHandle = registerPaneDriverHandle(info.paneId, {
      focusInput() {
        syncHelperTextarea();
        helperTextarea?.focus();
      },
      syncViewport,
    });

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
    if (unregisterDriverHandle) unregisterDriverHandle();
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

    if ($mode === 'input' && isSelected && !info.readOnly && shellViewOpen) {
      helperTextarea.focus();
      return;
    }

    if (document.activeElement === helperTextarea) {
      helperTextarea.blur();
    }
  });

  function handleTitleDblClick(e: MouseEvent) {
    zoomCanvasToTile(info.paneId, window.innerWidth, window.innerHeight - 32);
    e.stopPropagation();
  }

  function handleTitleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    if (isLocked) return;
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
      const { dx, dy } = clientDeltaToWorldDelta(
        e.clientX - dragStartX,
        e.clientY - dragStartY,
        $canvasState.zoom,
      );
      updateTerminal(info.id, { x: origX + dx, y: origY + dy });
    } else if (isResizing) {
      const { dx, dy } = clientDeltaToWorldDelta(
        e.clientX - resizeStartX,
        e.clientY - resizeStartY,
        $canvasState.zoom,
      );
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

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const viewport = (e.currentTarget as HTMLElement).closest('.canvas-viewport') as HTMLElement | null;
    const rect = viewport?.getBoundingClientRect();
    const clientX = rect ? e.clientX - rect.left : e.clientX;
    const clientY = rect ? e.clientY - rect.top : e.clientY;
    openPaneContextMenu(info.id, clientX, clientY);
  }

  function buildDefaultStatusText(title: string, tileId: string) {
    return `\u001b[32m\u25cf ONLINE\u001b[0m \u001b[90m\u2502\u001b[0m \u001b[36m${title}\u001b[0m \u001b[90m\u2502\u001b[0m \u001b[33m\u26a1 ready\u001b[0m \u001b[90m\u2502\u001b[0m \u001b[35mtile ${tileId}\u001b[0m`;
  }

  $effect(() => {
    shellViewOpen;
    if (shellViewOpen && terminal) {
      queueViewportSync();
    }
  });
</script>

<svelte:window onmousemove={handleWindowMouseMove} onmouseup={handleWindowMouseUp} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="pcb-component"
  class:selected={isSelected}
  class:kind-agent={isAgentTile}
  class:kind-root-agent={isRootAgentTile}
  class:kind-browser={isBrowserTile}
  data-tile-id={info.tileId}
  style="left: {info.x}px; top: {info.y}px; width: {info.width}px; height: {info.height}px; z-index: {isSelected ? 10 : 1};"
  onmousedown={(e) => {
    selectTile(info.id, e.shiftKey);
    if ($mode === 'command') {
      e.preventDefault();
    }
    e.stopPropagation();
  }}
  oncontextmenu={handleContextMenu}
>
  <TilePorts tileId={info.tileId} />
  <div class="component-body">
    <div class="ic-notch"></div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="header-bar" onmousedown={handleTitleMouseDown} ondblclick={handleTitleDblClick}>
      <div class="header-left">
        {#if isLocked}
          <span class="tile-lock-indicator" title="Locked" aria-label="Locked">
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3.5 5V3.75a2.5 2.5 0 1 1 5 0V5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
              <rect x="2.2" y="5" width="7.6" height="5.2" rx="1" fill="none" stroke="currentColor" stroke-width="1.1" />
            </svg>
          </span>
        {/if}
        {#if isAgentTile}
          <span class="agent-badge" class:root-agent-badge={isRootAgentTile} title={isRootAgentTile ? 'Root agent tile' : 'Agent tile'} aria-label={isRootAgentTile ? 'Root agent tile' : 'Agent tile'}>
            {isRootAgentTile ? 'ROOT' : 'CC'}
          </span>
        {:else if isBrowserTile}
          <span class="browser-badge" title="Browser tile" aria-label="Browser tile">WEB</span>
        {/if}
        <span class="designator">{displayTitle}</span>
        <TileSignalStrip signal={tileSignal} showStatus={false} compactLeds={true} />
      </div>
      <div class="header-right">
        <button
          class="header-control-btn minimize-btn"
          type="button"
          title={minimizeLabel}
          aria-label={minimizeLabel}
          onmousedown={(event) => event.stopPropagation()}
          onclick={() => togglePaneMinimized(info.id)}
        >
          <span class="control-glyph">_</span>
        </button>
        {#if canClose}
          <button
            class="header-control-btn close-btn"
            type="button"
            onclick={handleClose}
            title={closeLabel}
            aria-label={closeLabel}
            onmousedown={(event) => event.stopPropagation()}
          >
            <span class="close-x">×</span>
          </button>
        {/if}
      </div>
    </div>

    <div class="screen-housing" class:shell-view-hidden={!shellViewOpen}>
      <div class="screen-bezel">
        <div class="terminal-container" bind:this={termRef}></div>
      </div>
      <div class="phosphor-glow"></div>
      <div class="input-shield" class:pass-through={$mode === 'input'}></div>
    </div>

    {#if displayOpen}
      <TerminalDisplayDrawer
        text={displayFrame?.text ?? ''}
        columns={displayFrame?.columns ?? 0}
        rows={displayFrame?.rows ?? 0}
        fillAvailableSpace={!shellViewOpen}
        emptyText={displayEmptyText}
      />
    {/if}

    {#if activityOpen}
      <TileActivityDrawer
        entries={activityEntries}
        fillAvailableSpace={!shellViewOpen}
        emptyText="No activity yet"
      />
    {/if}

    <div class="info-strip">
      <div class="info-cluster info-cluster-left">
        <TileSignalStrip signal={tileSignal} showLeds={false} defaultStatusText={defaultStatusText} />
      </div>
      <div class="info-cluster info-cluster-right">
        <button
          class="shell-view-toggle-btn"
          class:active={shellViewOpen}
          type="button"
          title={shellViewOpen ? 'Hide shell view' : 'Show shell view'}
          aria-label={shellViewOpen ? 'Hide shell view' : 'Show shell view'}
          onclick={(event) => {
            event.stopPropagation();
            shellViewOpen = !shellViewOpen;
          }}
        >
          SHELL
        </button>
        <button
          class="display-toggle-btn"
          class:active={displayOpen}
          type="button"
          title={displayOpen ? 'Hide display view' : 'Show display view'}
          aria-label={displayOpen ? 'Hide display view' : 'Show display view'}
          onclick={(event) => {
            event.stopPropagation();
            displayOpen = !displayOpen;
          }}
        >
          DISPLAY
        </button>
        <button
          class="activity-toggle-btn"
          class:active={activityOpen}
          type="button"
          title={activityOpen ? 'Hide activity log' : 'Show activity log'}
          aria-label={activityOpen ? 'Hide activity log' : 'Show activity log'}
          onclick={(event) => {
            event.stopPropagation();
            activityOpen = !activityOpen;
          }}
        >
          ACT {activityEntries.length}
        </button>
      </div>
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
    --tile-port-contour: var(--component-border);
  }

  .pcb-component.selected {
    filter: drop-shadow(0 0 6px rgba(51, 255, 51, 0.3));
    --tile-port-contour: var(--phosphor-green-dim);
  }

  .pcb-component.kind-agent {
    --tile-port-contour: rgba(242, 176, 90, 0.34);
  }

  .pcb-component.kind-root-agent {
    --tile-port-contour: rgba(255, 92, 92, 0.4);
  }

  .pcb-component.kind-browser {
    --tile-port-contour: rgba(102, 225, 255, 0.34);
  }

  .pcb-component.selected .component-body {
    border-color: var(--phosphor-green-dim);
  }

  .pcb-component.kind-agent.selected {
    filter: drop-shadow(0 0 8px rgba(242, 176, 90, 0.28));
    --tile-port-contour: rgba(242, 176, 90, 0.5);
  }

  .pcb-component.kind-agent.selected .component-body {
    border-color: rgba(242, 176, 90, 0.5);
  }

  .pcb-component.kind-root-agent.selected {
    filter: drop-shadow(0 0 8px rgba(255, 92, 92, 0.3));
    --tile-port-contour: rgba(255, 92, 92, 0.52);
  }

  .pcb-component.kind-root-agent.selected .component-body {
    border-color: rgba(255, 92, 92, 0.52);
  }

  .pcb-component.kind-browser.selected {
    filter: drop-shadow(0 0 8px rgba(102, 225, 255, 0.28));
    --tile-port-contour: rgba(102, 225, 255, 0.5);
  }

  .pcb-component.kind-browser.selected .component-body {
    border-color: rgba(102, 225, 255, 0.5);
  }

  .component-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--component-bg);
    border: 1px solid var(--component-border);
    position: relative;
    min-width: 0;
    --activity-border: rgba(51, 255, 51, 0.22);
    --activity-border-soft: rgba(51, 255, 51, 0.14);
    --activity-accent: var(--phosphor-green);
    --activity-text: var(--silk-dim);
    --activity-empty: rgba(51, 255, 51, 0.54);
    --activity-bg: rgba(8, 14, 8, 0.95);
  }

  .pcb-component.kind-agent .component-body {
    border-color: rgba(242, 176, 90, 0.34);
    --activity-border: rgba(242, 176, 90, 0.22);
    --activity-border-soft: rgba(242, 176, 90, 0.18);
    --activity-accent: var(--copper);
    --activity-empty: var(--copper-dim);
  }

  .pcb-component.kind-root-agent .component-body {
    border-color: rgba(255, 92, 92, 0.4);
    --activity-border: rgba(255, 92, 92, 0.26);
    --activity-border-soft: rgba(255, 92, 92, 0.18);
    --activity-accent: #ff7b7b;
    --activity-empty: rgba(255, 123, 123, 0.68);
  }

  .pcb-component.kind-browser .component-body {
    border-color: rgba(102, 225, 255, 0.34);
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

  .pcb-component.kind-agent .header-bar {
    background: linear-gradient(180deg, rgba(52, 35, 14, 0.9), rgba(34, 24, 10, 0.92));
    border-bottom-color: rgba(242, 176, 90, 0.34);
  }

  .pcb-component.kind-root-agent .header-bar {
    background: linear-gradient(180deg, rgba(60, 18, 18, 0.92), rgba(34, 11, 11, 0.94));
    border-bottom-color: rgba(255, 92, 92, 0.4);
  }

  .pcb-component.kind-browser .header-bar {
    background: linear-gradient(180deg, rgba(12, 36, 44, 0.9), rgba(9, 25, 31, 0.92));
    border-bottom-color: rgba(102, 225, 255, 0.34);
  }

  .header-left, .header-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .header-left {
    min-width: 0;
    flex: 1;
  }

  .tile-lock-indicator {
    display: inline-flex;
    width: 12px;
    height: 12px;
    color: var(--copper);
    flex: 0 0 12px;
  }

  .tile-lock-indicator svg {
    width: 100%;
    height: 100%;
  }

  .header-right {
    flex-shrink: 0;
  }

  .designator {
    font-size: 11px;
    color: var(--silk-white);
    letter-spacing: 1px;
    min-width: 0;
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 14px;
    padding: 0 4px;
    border: 1px solid rgba(242, 176, 90, 0.35);
    border-radius: 3px;
    background: rgba(242, 176, 90, 0.08);
    color: var(--copper);
    font-family: var(--font-mono);
    font-size: 8px;
    letter-spacing: 0.6px;
    line-height: 1;
    text-transform: uppercase;
    box-shadow: inset 0 0 8px rgba(242, 176, 90, 0.05);
  }

  .root-agent-badge {
    border-color: rgba(255, 92, 92, 0.38);
    background: rgba(255, 92, 92, 0.12);
    color: #ff7b7b;
    box-shadow: inset 0 0 8px rgba(255, 92, 92, 0.08);
  }

  .browser-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 14px;
    padding: 0 4px;
    border: 1px solid rgba(102, 225, 255, 0.35);
    border-radius: 3px;
    background: rgba(102, 225, 255, 0.08);
    color: #66e1ff;
    font-family: var(--font-mono);
    font-size: 8px;
    letter-spacing: 0.6px;
    line-height: 1;
    text-transform: uppercase;
    box-shadow: inset 0 0 8px rgba(102, 225, 255, 0.05);
  }

  .header-control-btn {
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

  .minimize-btn {
    color: var(--copper-dim);
  }

  .minimize-btn:hover {
    color: var(--phosphor-green);
    border-color: rgba(51, 255, 51, 0.2);
  }

  .close-btn {
    color: var(--silk-dim);
  }

  .close-btn:hover {
    color: var(--phosphor-red);
    border-color: rgba(255, 51, 51, 0.2);
  }

  .control-glyph {
    font-size: 10px;
    line-height: 1;
    transform: translateY(-1px);
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

  .screen-housing.shell-view-hidden {
    display: none;
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
    height: 24px;
    padding: 0 8px;
    border-top: 1px solid var(--component-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-shrink: 0;
    margin-top: auto;
    background: rgba(0, 0, 0, 0.2);
  }

  .info-cluster {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .info-cluster-left {
    flex: 1 1 auto;
    overflow: hidden;
  }

  .info-cluster-right {
    justify-content: flex-end;
    flex-shrink: 0;
  }

  .shell-view-toggle-btn,
  .display-toggle-btn,
  .activity-toggle-btn {
    height: 18px;
    padding: 0 6px;
    border: 1px solid var(--activity-border);
    background: rgba(0, 0, 0, 0.18);
    color: var(--activity-accent);
    font-family: var(--font-mono);
    font-size: 8px;
    letter-spacing: 0.6px;
    cursor: pointer;
  }

  .shell-view-toggle-btn.active,
  .display-toggle-btn.active,
  .activity-toggle-btn.active,
  .shell-view-toggle-btn:hover,
  .display-toggle-btn:hover,
  .activity-toggle-btn:hover {
    border-color: var(--activity-accent);
    background: color-mix(in srgb, var(--activity-accent) 10%, rgba(0, 0, 0, 0.18));
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
