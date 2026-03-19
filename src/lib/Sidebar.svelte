<script lang="ts">
  import { appState, setSidebarSelection, sidebarItems, sidebarOpen, sidebarSelectedIdx } from './stores/appState';
</script>

{#if $sidebarOpen}
  <div class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">TMUX</span>
    </div>
    <div class="sidebar-tree">
      {#each $sidebarItems as item, index}
        <button
          type="button"
          class="tree-item"
          class:selected={index === $sidebarSelectedIdx}
          class:active-session={item.sessionId === $appState.tmux.activeSessionId && item.type === 'session'}
          class:active-window={item.windowId === $appState.tmux.activeWindowId}
          class:active-pane={item.paneId === $appState.ui.selectedPaneId}
          class:session={item.type === 'session'}
          class:window={item.type === 'window'}
          class:pane={item.type === 'pane'}
          style="padding-left: {8 + item.indent * 12}px"
          onclick={() => setSidebarSelection(index)}
        >
          <span class="tree-tag">{item.type === 'session' ? 'SES' : item.type === 'window' ? 'WIN' : 'PAN'}</span>
          <span class="tree-label">{item.label}</span>
          {#if item.command && item.command !== item.label}
            <span class="tree-cmd">{item.command}</span>
          {/if}
          {#if item.dead}
            <span class="tree-dead">DEAD</span>
          {/if}
        </button>
      {/each}
      {#if $sidebarItems.length === 0}
        <div class="tree-empty">no panes</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sidebar {
    position: fixed;
    top: var(--toolbar-height);
    left: 0;
    bottom: 22px;
    width: 240px;
    background: var(--pcb-base);
    border-right: 1px solid var(--copper-dim);
    z-index: 500;
    display: flex;
    flex-direction: column;
    user-select: none;
    -webkit-user-select: none;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--copper-dim);
  }

  .sidebar-title {
    font-size: 10px;
    color: var(--phosphor-green);
    letter-spacing: 2px;
  }

  .sidebar-tree {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .tree-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font-size: 10px;
    color: var(--silk-dim);
    cursor: pointer;
    width: 100%;
    border: 0;
    background: transparent;
    text-align: left;
    font-family: inherit;
  }

  .tree-item.selected {
    background: rgba(51, 255, 51, 0.08);
    color: var(--phosphor-green);
  }

  .tree-item.active-window {
    box-shadow: inset 2px 0 0 var(--copper);
  }

  .tree-item.active-session {
    box-shadow: inset 2px 0 0 var(--phosphor-green);
  }

  .tree-item.active-pane {
    color: var(--phosphor-green);
  }

  .tree-item.session {
    color: var(--copper);
  }

  .tree-item.window {
    color: var(--silk-white);
  }

  .tree-item.pane {
    color: var(--silk-dim);
  }

  .tree-tag {
    font-size: 7px;
    padding: 0 3px;
    border: 1px solid var(--component-border);
    flex-shrink: 0;
    line-height: 1.4;
  }

  .tree-label {
    flex: 1;
  }

  .tree-cmd {
    font-size: 8px;
    color: var(--copper-dim);
  }

  .tree-dead {
    font-size: 8px;
    color: var(--phosphor-red);
  }

  .tree-empty {
    padding: 8px;
    color: var(--silk-dim);
    font-size: 9px;
  }
</style>
