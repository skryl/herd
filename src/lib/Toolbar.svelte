<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { canvasState } from './stores/canvas';
  import { tabs, activeTabId, addTab, activeTabTerminals } from './stores/tabs';
  import { agentInfos } from './stores/appState';

  interface Props {
    onSpawnShell: () => void;
    onSpawnAgent: () => void;
    onSpawnBrowser: () => void;
    onSpawnWork: () => void;
  }
  let { onSpawnShell, onSpawnAgent, onSpawnBrowser, onSpawnWork }: Props = $props();

  let termCount = $derived($activeTabTerminals.length);
  let agentCount = $derived($agentInfos.length);
  let zoomPct = $derived(Math.round($canvasState.zoom * 100));

  let tmuxAlive = $state(false);
  let ccAlive = $state(false);
  let pollInterval: ReturnType<typeof setInterval>;

  onMount(() => {
    checkTmux();
    pollInterval = setInterval(checkTmux, 3000);
  });

  onDestroy(() => {
    clearInterval(pollInterval);
  });

  async function checkTmux() {
    try {
      const status = await invoke<{ server: boolean; cc: boolean }>('tmux_status');
      tmuxAlive = status.server;
      ccAlive = status.cc;
    } catch {
      tmuxAlive = false;
      ccAlive = false;
    }
  }

  async function handleTmuxClick() {
    if (tmuxAlive) {
      await invoke('spawn_log_shell', {
        cmd: 'bash -c \'tmux -f /dev/null -L herd list-sessions -F "#{session_id} #{session_name}"; echo "---"; tmux -f /dev/null -L herd list-windows -a -F "#{session_id} w#{window_index}: #{window_id} #{window_name} panes=#{window_panes}"; echo "---"; tmux -f /dev/null -L herd list-panes -a -F "#{session_id} w#{window_index}: #{window_id} #{pane_id} #{pane_current_command}"; echo "---"; echo "Watching..."; while true; do tmux -f /dev/null -L herd list-sessions -F "#{session_id} #{session_name}" 2>/dev/null; echo "---"; tmux -f /dev/null -L herd list-windows -a -F "#{session_id} w#{window_index}: #{window_id} #{window_name} panes=#{window_panes}" 2>/dev/null; echo "---"; tmux -f /dev/null -L herd list-panes -a -F "#{session_id} w#{window_index}: #{window_id} #{pane_id} #{pane_current_command}" 2>/dev/null; sleep 2; echo "---"; done\''
      }).catch((e: any) => console.error('spawn_log_shell failed:', e));
    } else {
      try {
        await invoke('tmux_restart');
        tmuxAlive = true;
      } catch (e) {
        console.error('tmux restart failed:', e);
      }
    }
  }

  async function handleSockClick() {
    await invoke('spawn_log_shell', {
      cmd: 'bash -c \'tail -f /Users/skryl/Dev/herd/tmp/herd-socket.log 2>/dev/null || tail -f /tmp/herd-socket.log 2>/dev/null || echo "No socket log found"\''
    }).catch((e: any) => console.error('spawn_log_shell failed:', e));
  }
</script>

<div class="toolbar">
  <div class="toolbar-left">
    <div class="logo-block">
      <span class="logo-glyph">⬡</span>
      <span class="logo-en">HERD</span>
    </div>

    <div class="separator"></div>

    <div class="tab-bar">
      {#each $tabs as tab (tab.id)}
        <button
          class="tab-btn"
          class:active={$activeTabId === tab.id}
          onclick={() => activeTabId.set(tab.id)}
        >
          {tab.name}
        </button>
      {/each}
      <button class="tab-add-btn" onclick={() => addTab()}>+</button>
    </div>

    <div class="separator"></div>

    <button class="tool-btn spawn" onclick={onSpawnShell}>
      <span class="btn-icon">+</span>
      <span class="btn-label">SHELL</span>
    </button>

    <button class="tool-btn spawn agent" onclick={onSpawnAgent}>
      <span class="btn-icon">+</span>
      <span class="btn-label">AGENT</span>
    </button>

    <button class="tool-btn spawn browser" onclick={onSpawnBrowser}>
      <span class="btn-icon">+</span>
      <span class="btn-label">BROWSER</span>
    </button>

    <button class="tool-btn spawn work" onclick={onSpawnWork}>
      <span class="btn-icon">+</span>
      <span class="btn-label">WORK</span>
    </button>
  </div>

  <div class="toolbar-right">
    <div class="status-block">
      <span class="status-label">NODES</span>
      <span class="status-value">{termCount}</span>
    </div>
    <div class="status-block">
      <span class="status-label">AGENTS</span>
      <span class="status-value">{agentCount}</span>
    </div>
    <div class="status-block">
      <span class="status-label">ZOOM</span>
      <span class="status-value">{zoomPct}%</span>
    </div>

    <div class="separator"></div>

    <button class="indicator-btn" onclick={handleTmuxClick} title="tmux server status">
      <span class="indicator-dot" class:alive={tmuxAlive} class:dead={!tmuxAlive}></span>
      <span class="indicator-label">TMUX</span>
    </button>

    <button class="indicator-btn" title="tmux -CC control mode">
      <span class="indicator-dot" class:alive={ccAlive} class:dead={!ccAlive}></span>
      <span class="indicator-label">CC</span>
    </button>

    <button class="indicator-btn" onclick={handleSockClick} title="Socket traffic log">
      <span class="indicator-dot alive"></span>
      <span class="indicator-label">SOCK</span>
    </button>
  </div>
</div>

<style>
  .toolbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: var(--toolbar-height);
    background: var(--pcb-base);
    border-bottom: 1px solid var(--copper-dim);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px;
    z-index: 1000;
    user-select: none;
    -webkit-user-select: none;
  }

  .toolbar-left, .toolbar-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .logo-block {
    display: flex;
    align-items: baseline;
    gap: 5px;
    padding: 0 4px;
  }

  .logo-glyph {
    font-size: 14px;
    color: var(--phosphor-green);
    text-shadow: 0 0 8px var(--phosphor-green-glow);
    line-height: 1;
  }

  .logo-en {
    font-size: 11px;
    color: var(--copper);
    letter-spacing: 3px;
  }

  .separator {
    width: 1px;
    height: 18px;
    background: var(--copper-dim);
    margin: 0 2px;
  }

  .tab-bar {
    display: flex;
    align-items: center;
    gap: 1px;
  }

  .tab-btn {
    background: none;
    border: 1px solid transparent;
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 2px 8px;
    cursor: pointer;
    letter-spacing: 0.5px;
    transition: all 0.1s;
  }

  .tab-btn:hover {
    color: var(--silk-white);
  }

  .tab-btn.active {
    color: var(--phosphor-green);
    border-color: var(--phosphor-green-dim);
    background: rgba(51, 255, 51, 0.06);
  }

  .tab-add-btn {
    background: none;
    border: 1px solid transparent;
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 1px 5px;
    cursor: pointer;
    line-height: 1;
    transition: all 0.1s;
  }

  .tab-add-btn:hover {
    color: var(--phosphor-green);
    border-color: var(--component-border);
  }

  .tool-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: 1px solid var(--component-border);
    color: var(--silk-white);
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 2px 8px;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    transition: all 0.1s;
  }

  .tool-btn:hover {
    border-color: var(--phosphor-green-dim);
    color: var(--phosphor-green);
    background: rgba(51, 255, 51, 0.05);
  }

  .tool-btn.agent {
    border-color: rgba(242, 176, 90, 0.45);
  }

  .tool-btn.agent .btn-icon {
    color: var(--copper);
  }

  .tool-btn.agent:hover {
    border-color: var(--copper);
    color: var(--copper);
    background: rgba(242, 176, 90, 0.08);
  }

  .tool-btn.work {
    border-color: rgba(110, 188, 255, 0.45);
  }

  .tool-btn.work .btn-icon {
    color: #6ebcff;
  }

  .tool-btn.work:hover {
    border-color: #6ebcff;
    color: #6ebcff;
    background: rgba(110, 188, 255, 0.08);
  }

  .tool-btn.browser {
    border-color: rgba(102, 225, 255, 0.45);
  }

  .tool-btn.browser .btn-icon {
    color: #66e1ff;
  }

  .tool-btn.browser:hover {
    border-color: #66e1ff;
    color: #66e1ff;
    background: rgba(102, 225, 255, 0.08);
  }

  .btn-icon {
    color: var(--phosphor-green);
    font-size: 13px;
    line-height: 1;
  }

  .btn-label {
    font-size: 10px;
  }

  .status-block {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px;
    border-left: 1px solid rgba(42, 58, 32, 0.5);
  }

  .status-label {
    font-size: 9px;
    color: var(--silk-dim);
  }

  .status-value {
    font-size: 10px;
    color: var(--phosphor-amber);
  }

  .indicator-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: 1px solid transparent;
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 2px 6px;
    cursor: pointer;
    transition: all 0.1s;
  }

  .indicator-btn:hover {
    border-color: var(--component-border);
    color: var(--silk-white);
  }

  .indicator-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .indicator-dot.alive {
    background: var(--phosphor-green);
    box-shadow: 0 0 6px var(--phosphor-green);
  }

  .indicator-dot.dead {
    background: var(--phosphor-red);
    box-shadow: 0 0 6px var(--phosphor-red);
  }

  .indicator-label {
    letter-spacing: 0.5px;
  }
</style>
