<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { debugPaneOpen } from './stores/debugPane';
  import { mode } from './stores/mode';
  import { selectedTerminalId, terminals } from './stores/terminals';
  import { activeTabTerminals, activeTabId } from './stores/tabs';
  import { canvasState } from './stores/canvas';

  let logLines = $state<string[]>([]);
  let pollInterval: ReturnType<typeof setInterval>;
  let logRef = $state<HTMLDivElement>();
  let lastSocketSize = 0;
  let lastCcSize = 0;
  let autoFollow = true;

  // Reactive debug info
  let debugInfo = $derived({
    mode: $mode,
    selectedId: $selectedTerminalId?.slice(0, 8) || 'none',
    tabTerminals: $activeTabTerminals.length,
    totalTerminals: $terminals.length,
    zoom: Math.round($canvasState.zoom * 100),
    panX: Math.round($canvasState.panX),
    panY: Math.round($canvasState.panY),
    tabId: $activeTabId,
  });

  function log(msg: string) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logLines = [...logLines.slice(-200), `[${ts}] ${msg}`];
    if (autoFollow) {
      requestAnimationFrame(() => {
        if (logRef) logRef.scrollTop = logRef.scrollHeight;
      });
    }
  }

  function handleLogScroll() {
    if (!logRef) return;
    // If user scrolled away from bottom, stop following
    const atBottom = logRef.scrollHeight - logRef.scrollTop - logRef.clientHeight < 30;
    autoFollow = atBottom;
  }

  async function pollLogs() {
    try {
      // Tail socket log
      const sockResp = await invoke<string>('read_log_tail', { logName: 'socket', offset: lastSocketSize });
      if (sockResp && sockResp.length > 0) {
        lastSocketSize += sockResp.length;
        for (const line of sockResp.split('\n').filter(Boolean)) {
          log(`SOCK ${line}`);
        }
      }
    } catch {}

    try {
      // Tail CC log
      const ccResp = await invoke<string>('read_log_tail', { logName: 'cc', offset: lastCcSize });
      if (ccResp && ccResp.length > 0) {
        lastCcSize += ccResp.length;
        for (const line of ccResp.split('\n').filter(Boolean)) {
          if (!line.includes('%output')) { // Skip noisy %output lines
            log(`CC ${line}`);
          }
        }
      }
    } catch {}
  }

  async function redrawAll() {
    log('Redrawing all panes...');
    try {
      await invoke('redraw_all_panes');
      log('Redraw complete');
    } catch (e) {
      log(`Redraw failed: ${e}`);
    }
  }

  async function restartTmux() {
    log('Restarting tmux...');
    try {
      await invoke('tmux_restart');
      log('tmux restarted');
    } catch (e) {
      log(`tmux restart failed: ${e}`);
    }
  }

  function reloadWebview() {
    log('Reloading webview...');
    window.location.reload();
  }

  onMount(() => {
    log('Debug pane opened');
    pollInterval = setInterval(pollLogs, 2000);
    pollLogs();
  });

  onDestroy(() => {
    clearInterval(pollInterval);
  });
</script>

{#if $debugPaneOpen}
  <div class="debug-pane">
    <div class="debug-header">
      <div class="debug-header-left">
        <span class="debug-title">DEBUG</span>
        <span class="debug-info">
          [{debugInfo.mode}]
          sel={debugInfo.selectedId}
          tiles={debugInfo.tabTerminals}/{debugInfo.totalTerminals}
          zoom={debugInfo.zoom}%
          pan={debugInfo.panX},{debugInfo.panY}
        </span>
      </div>
      <div class="debug-header-right">
        <button class="debug-btn" onclick={redrawAll}>REDRAW ALL</button>
        <button class="debug-btn" onclick={restartTmux}>RESTART TMUX</button>
        <button class="debug-btn warn" onclick={reloadWebview}>RELOAD VIEW</button>
        <button class="debug-close" onclick={() => debugPaneOpen.set(false)}>×</button>
      </div>
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="debug-log" bind:this={logRef} onscroll={handleLogScroll}>
      {#each logLines as line}
        <div class="log-line" class:sock={line.includes('SOCK')} class:cc={line.includes('CC')}>{line}</div>
      {/each}
    </div>
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 8px;
    background: var(--pcb-base);
    border-bottom: 1px solid var(--copper-dim);
    flex-shrink: 0;
  }

  .debug-header-left, .debug-header-right {
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

  .debug-info {
    font-size: 9px;
    color: var(--silk-dim);
    font-family: var(--font-mono);
  }

  .debug-btn {
    background: none;
    border: 1px solid var(--component-border);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 1px 6px;
    cursor: pointer;
    letter-spacing: 0.5px;
    transition: all 0.1s;
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

  .debug-log {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px;
    font-family: var(--font-mono);
    font-size: 9px;
    line-height: 1.5;
  }

  .log-line {
    color: var(--silk-dim);
    white-space: pre-wrap;
    word-break: break-all;
  }

  .log-line.sock {
    color: var(--phosphor-green-dim);
  }

  .log-line.cc {
    color: var(--copper-dim);
  }
</style>
