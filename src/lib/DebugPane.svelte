<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { clearDebugLogs } from './tauri';
  import {
    activeArrangementMode,
    chatterEntries,
    debugPaneHeight,
    debugPaneOpen,
    debugTab,
    dispatchIntent,
    refreshAgentDebugState,
  } from './stores/appState';
  import { mode } from './stores/mode';
  import { selectedTerminalId, terminals } from './stores/terminals';
  import { activeTabTerminals, activeTabId } from './stores/tabs';
  import { canvasState } from './stores/canvas';

  const MIN_DEBUG_HEIGHT = 120;
  const DEBUG_HEIGHT_STORAGE_KEY = 'herd-debug-pane-height';

  let logLines = $state<string[]>([]);
  let pollInterval: ReturnType<typeof setInterval>;
  let logRef = $state<HTMLDivElement>();
  let chatterRef = $state<HTMLDivElement>();
  let lastSocketSize = 0;
  let lastCcSize = 0;
  let isResizing = false;
  let resizeStartY = 0;
  let resizeStartHeight = 200;
  let effectiveDebugHeight = $derived(
    Number.isFinite($debugPaneHeight) && $debugPaneHeight > 0 ? $debugPaneHeight : 200,
  );

  let debugInfo = $derived({
    mode: $mode,
    selectedId: $selectedTerminalId?.slice(0, 8) || 'none',
    tabTerminals: $activeTabTerminals.length,
    totalTerminals: $terminals.length,
    zoom: Math.round($canvasState.zoom * 100),
    panX: Math.round($canvasState.panX),
    panY: Math.round($canvasState.panY),
    tabId: $activeTabId,
    arrangement: $activeArrangementMode ?? 'manual',
  });

  function scrollToBottom(container: HTMLDivElement | undefined) {
    requestAnimationFrame(() => {
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

  function appendLogLine(prefix: string, line: string) {
    logLines = [...logLines.slice(-400), `${prefix} ${line}`];
    if ($debugTab === 'logs') {
      scrollToBottom(logRef);
    }
  }

  async function pollLogs() {
    try {
      const sockResp = await invoke<string>('read_log_tail', { logName: 'socket', offset: lastSocketSize });
      if (sockResp && sockResp.length > 0) {
        lastSocketSize += sockResp.length;
        for (const line of sockResp.split('\n').filter(Boolean)) {
          appendLogLine('SOCK', line);
        }
      }
    } catch {}

    try {
      const ccResp = await invoke<string>('read_log_tail', { logName: 'cc', offset: lastCcSize });
      if (ccResp && ccResp.length > 0) {
        lastCcSize += ccResp.length;
        for (const line of ccResp.split('\n').filter(Boolean)) {
          if (!line.includes('%output')) {
            appendLogLine('CC', line);
          }
        }
      }
    } catch {}
  }

  async function redrawAll() {
    await invoke('redraw_all_panes').catch(() => undefined);
  }

  async function restartTmux() {
    await invoke('tmux_restart').catch(() => undefined);
  }

  async function handleClearLogs() {
    await clearDebugLogs().catch(() => undefined);
    logLines = [];
    lastSocketSize = 0;
    lastCcSize = 0;
    await refreshAgentDebugState();
  }

  function reloadWebview() {
    window.location.reload();
  }

  function clampDebugHeight(nextHeight: number) {
    return Math.max(MIN_DEBUG_HEIGHT, Math.min(window.innerHeight - 80, nextHeight));
  }

  function persistDebugHeight(height: number) {
    localStorage.setItem(DEBUG_HEIGHT_STORAGE_KEY, String(Math.round(height)));
  }

  function handleResizeMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    isResizing = true;
    resizeStartY = e.clientY;
    resizeStartHeight = $debugPaneHeight;
    e.preventDefault();
    e.stopPropagation();
  }

  function handleWindowMouseMove(e: MouseEvent) {
    if (!isResizing) return;
    const dy = e.clientY - resizeStartY;
    debugPaneHeight.set(clampDebugHeight(resizeStartHeight - dy));
  }

  function handleWindowMouseUp() {
    if (!isResizing) return;
    isResizing = false;
    persistDebugHeight($debugPaneHeight);
  }

  $effect(() => {
    if ($debugTab === 'logs') {
      logLines.length;
      scrollToBottom(logRef);
    }
  });

  $effect(() => {
    if ($debugTab === 'chatter') {
      $chatterEntries.length;
      scrollToBottom(chatterRef);
    }
  });

  onMount(() => {
    const storedHeight = Number(localStorage.getItem(DEBUG_HEIGHT_STORAGE_KEY) || '');
    if (Number.isFinite(storedHeight) && storedHeight > 0) {
      debugPaneHeight.set(clampDebugHeight(storedHeight));
    }
    pollInterval = setInterval(pollLogs, 2000);
    pollLogs();
  });

  onDestroy(() => {
    clearInterval(pollInterval);
  });
</script>

<svelte:window onmousemove={handleWindowMouseMove} onmouseup={handleWindowMouseUp} />

{#if $debugPaneOpen}
  <div class="debug-pane" style={`height: ${effectiveDebugHeight}px;`}>
    <div class="debug-header">
      <div class="debug-header-left">
        <span class="debug-title">DEBUG</span>
        <div class="debug-tabs">
          <button class:active={$debugTab === 'info'} onclick={() => dispatchIntent({ type: 'select-debug-tab', tab: 'info' })}>
            Info
          </button>
          <button class:active={$debugTab === 'logs'} onclick={() => dispatchIntent({ type: 'select-debug-tab', tab: 'logs' })}>
            Logs
          </button>
          <button class:active={$debugTab === 'chatter'} onclick={() => dispatchIntent({ type: 'select-debug-tab', tab: 'chatter' })}>
            Chatter
          </button>
        </div>
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="debug-resize-grip" onmousedown={handleResizeMouseDown}>
        <span></span>
        <span></span>
        <span></span>
      </div>
      <div class="debug-header-right">
        <button class="debug-btn" data-debug-action="clear-logs" onclick={handleClearLogs}>CLEAR LOGS</button>
        <button class="debug-btn" onclick={redrawAll}>REDRAW ALL</button>
        <button class="debug-btn" onclick={restartTmux}>RESTART TMUX</button>
        <button class="debug-btn warn" onclick={reloadWebview}>RELOAD VIEW</button>
        <button class="debug-close" onclick={() => debugPaneOpen.set(false)}>×</button>
      </div>
    </div>

    {#if $debugTab === 'info'}
      <div class="debug-log info-log">
        <div class="log-line info-line">
          [{debugInfo.mode}]
          sel={debugInfo.selectedId}
          tiles={debugInfo.tabTerminals}/{debugInfo.totalTerminals}
          arr={debugInfo.arrangement}
          zoom={debugInfo.zoom}%
          pan={debugInfo.panX},{debugInfo.panY}
        </div>
      </div>
    {:else if $debugTab === 'chatter'}
      <div class="debug-log chatter-log" bind:this={chatterRef}>
        {#if $chatterEntries.length === 0}
          <div class="log-line muted">No chatter yet</div>
        {:else}
          {#each $chatterEntries as entry, index (`${entry.timestamp_ms}:${index}`)}
            <div class="log-line chatter">{entry.display_text}</div>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="debug-log" bind:this={logRef}>
        {#each logLines as line}
          <div class="log-line" class:sock={line.startsWith('SOCK')} class:cc={line.startsWith('CC')}>{line}</div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .debug-pane {
    position: fixed;
    bottom: 22px;
    left: 0;
    right: 0;
    height: 200px;
    background: var(--pcb-dark);
    border-top: 1px solid var(--copper);
    display: flex;
    flex-direction: column;
    z-index: 900;
  }

  .debug-header {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 8px;
    background: var(--pcb-base);
    border-bottom: 1px solid var(--copper-dim);
    flex-shrink: 0;
  }

  .debug-header-left,
  .debug-header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .debug-title {
    font-size: 10px;
    color: var(--phosphor-amber);
    letter-spacing: 2px;
    font-weight: normal;
  }

  .debug-tabs {
    display: flex;
    gap: 4px;
  }

  .debug-tabs button {
    background: none;
    border: 1px solid var(--component-border);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 1px 6px;
    cursor: pointer;
  }

  .debug-tabs button.active {
    border-color: var(--copper);
    color: var(--copper);
    background: rgba(242, 176, 90, 0.08);
  }

  .debug-btn {
    background: none;
    border: 1px solid var(--component-border);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 1px 6px;
    cursor: pointer;
  }

  .debug-btn:hover {
    border-color: var(--phosphor-green-dim);
    color: var(--phosphor-green);
    background: rgba(51, 255, 51, 0.05);
  }

  .debug-btn.warn:hover {
    border-color: var(--phosphor-red);
    color: var(--phosphor-red);
    background: rgba(255, 51, 51, 0.05);
  }

  .debug-close {
    background: none;
    border: none;
    color: var(--silk-dim);
    font-size: 14px;
    cursor: pointer;
    font-family: var(--font-mono);
    padding: 0 4px;
  }

  .debug-close:hover {
    color: var(--phosphor-red);
  }

  .debug-resize-grip {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 18px;
    padding: 0 6px;
    align-items: center;
    justify-content: center;
    color: var(--silk-dim);
    cursor: ns-resize;
    user-select: none;
  }

  .debug-resize-grip:hover {
    color: var(--phosphor-amber);
  }

  .debug-resize-grip span {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
  }

  .debug-log {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px;
    font-family: var(--font-mono);
    font-size: 9px;
    line-height: 1.5;
  }

  .info-log {
    background: rgba(242, 176, 90, 0.02);
  }

  .log-line {
    color: var(--silk-dim);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .log-line.info-line {
    color: var(--silk-dim);
  }

  .log-line.sock {
    color: var(--phosphor-green-dim);
  }

  .log-line.cc {
    color: var(--copper-dim);
  }

  .log-line.chatter {
    color: var(--silk-white);
  }

  .log-line.muted {
    color: var(--copper-dim);
  }
</style>
