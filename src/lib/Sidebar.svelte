<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { sidebarOpen, sidebarSelectedIdx } from './stores/sidebar';
  import { terminals, selectedTerminalId } from './stores/terminals';
  import { canvasState } from './stores/canvas';

  interface TmuxPane {
    window_index: string;
    window_name: string;
    pane_id: string;
    command: string;
    pid: string;
    dead: boolean;
  }

  interface TmuxSession {
    session: string;
    panes: TmuxPane[];
  }

  let tree = $state<TmuxSession[]>([]);
  let flatItems = $derived(buildFlatList(tree));
  let pollInterval: ReturnType<typeof setInterval>;

  interface FlatItem {
    type: 'server' | 'session' | 'window' | 'pane';
    label: string;
    indent: number;
    pane?: TmuxPane;
    herdSessionId?: string;
  }

  function buildFlatList(sessions: TmuxSession[]): FlatItem[] {
    const items: FlatItem[] = [];
    const allTerms = $terminals;

    // Server node
    items.push({
      type: 'server',
      label: 'herd',
      indent: 0,
    });

    for (const sess of sessions) {
      // Session node
      items.push({
        type: 'session',
        label: sess.session,
        indent: 1,
      });

      // Group panes by window_index
      const windows = new Map<string, TmuxPane[]>();
      for (const pane of sess.panes) {
        const key = pane.window_index;
        if (!windows.has(key)) windows.set(key, []);
        windows.get(key)!.push(pane);
      }

      for (const [winIdx, panes] of windows) {
        const winName = panes[0]?.window_name || winIdx;

        // Window node
        items.push({
          type: 'window',
          label: `${winIdx}: ${winName}`,
          indent: 2,
        });

        // Pane nodes
        for (const pane of panes) {
          const tile = allTerms.find(t => t.paneId === pane.pane_id);
          const title = tile?.title && tile.title !== 'shell' ? tile.title : '';

          items.push({
            type: 'pane',
            label: title || pane.command,
            indent: 3,
            pane,
            herdSessionId: tile?.sessionId,
          });
        }
      }
    }
    return items;
  }

  async function refresh() {
    try {
      const result = await invoke<TmuxSession[]>('tmux_tree');
      tree = result;
    } catch {
      tree = [];
    }
  }

  onMount(() => {
    refresh();
    pollInterval = setInterval(refresh, 3000);
  });

  onDestroy(() => {
    clearInterval(pollInterval);
  });

  // When sidebar selection changes, highlight the corresponding canvas tile
  $effect(() => {
    if (!$sidebarOpen) return;
    const item = flatItems[$sidebarSelectedIdx];
    if (item?.herdSessionId) {
      const term = $terminals.find(t => t.sessionId === item.herdSessionId);
      if (term) {
        selectedTerminalId.set(term.id);
      }
    }
  });
</script>

{#if $sidebarOpen}
  <div class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">TMUX</span>
    </div>
    <div class="sidebar-tree">
      {#each flatItems as item, i}
        <div
          class="tree-item"
          class:selected={i === $sidebarSelectedIdx}
          class:server={item.type === 'server'}
          class:session={item.type === 'session'}
          class:window={item.type === 'window'}
          class:pane={item.type === 'pane'}
          style="padding-left: {8 + item.indent * 12}px"
        >
          {#if item.type === 'server'}
            <span class="tree-tag server-tag">SVR</span>
          {:else if item.type === 'session'}
            <span class="tree-tag session-tag">SES</span>
          {:else if item.type === 'window'}
            <span class="tree-tag window-tag">WIN</span>
          {:else}
            <span class="tree-tag pane-tag">PAN</span>
          {/if}
          <span class="tree-label">{item.label}</span>
          {#if item.pane}
            {#if item.pane.command !== item.label}
              <span class="tree-cmd">{item.pane.command}</span>
            {/if}
            <span class="tree-pid">{item.pane.pid}</span>
          {/if}
          {#if item.pane?.dead}
            <span class="tree-dead">DEAD</span>
          {/if}
        </div>
      {/each}
      {#if flatItems.length <= 1}
        <div class="tree-empty">no sessions</div>
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
    cursor: default;
  }

  .tree-item.selected {
    background: rgba(51, 255, 51, 0.08);
    color: var(--phosphor-green);
  }

  .tree-item.server {
    color: var(--copper);
    font-size: 10px;
  }

  .tree-item.session {
    color: var(--silk-white);
  }

  .tree-item.window {
    color: var(--phosphor-amber-dim);
    font-size: 9px;
  }

  .tree-tag {
    font-size: 7px;
    padding: 0 3px;
    border: 1px solid;
    flex-shrink: 0;
    letter-spacing: 0.5px;
    line-height: 1.4;
  }

  .server-tag {
    color: var(--copper);
    border-color: var(--copper-dim);
  }

  .session-tag {
    color: var(--phosphor-amber-dim);
    border-color: rgba(255, 170, 0, 0.2);
  }

  .window-tag {
    color: var(--phosphor-green-dim);
    border-color: rgba(51, 255, 51, 0.15);
  }

  .pane-tag {
    color: var(--silk-dim);
    border-color: var(--component-border);
  }

  .tree-item.selected .tree-tag {
    border-color: var(--phosphor-green-dim);
    color: var(--phosphor-green);
  }

  .tree-cmd {
    font-size: 9px;
    color: var(--copper-dim);
    flex-shrink: 0;
  }

  .tree-item.selected .tree-cmd {
    color: var(--phosphor-green-dim);
  }

  .tree-dead {
    font-size: 8px;
    color: var(--phosphor-red);
    flex-shrink: 0;
  }

  .tree-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tree-pid {
    font-size: 8px;
    color: var(--copper-dim);
    flex-shrink: 0;
  }

  .tree-empty {
    padding: 8px;
    font-size: 9px;
    color: var(--silk-dim);
    text-align: center;
  }
</style>
