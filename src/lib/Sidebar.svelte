<script lang="ts">
  import {
    activeSessionWorkItems,
    appState,
    agentInfos,
    networkCallSparksEnabled,
    selectedWorkId,
    selectAgentItem,
    selectWorkItem,
    setSidebarSection,
    setSidebarSelection,
    sidebarSection,
    sidebarItems,
    sidebarOpen,
    sidebarSelectedIdx,
    tilePortCount,
  } from './stores/appState';
  import { TILE_PORT_COUNT_OPTIONS } from './tilePorts';
  import { setSessionRootCwd } from './tauri';

  let workCollapsed = $state(false);
  let settingsCollapsed = $state(false);
  let tmuxCollapsed = $state(false);
  let agentsCollapsed = $state(false);
  let updatingSessionCwd = $state(false);

  let sortedAgents = $derived(
    [...$agentInfos].sort((left, right) => {
      if (left.alive !== right.alive) return left.alive ? -1 : 1;
      if (left.session_id !== right.session_id) return left.session_id.localeCompare(right.session_id);
      return left.display_name.localeCompare(right.display_name);
    }),
  );

  let activeSession = $derived(
    $appState.tmux.activeSessionId ? ($appState.tmux.sessions[$appState.tmux.activeSessionId] ?? null) : null,
  );
  let sessionWorkItems = $derived($activeSessionWorkItems);
  let selectedTileId = $derived.by(() => {
    const paneId = $appState.ui.selectedPaneId;
    if (!paneId) return null;
    const pane = $appState.tmux.panes[paneId];
    if (!pane) return null;
    return pane.tile_id ?? $appState.tmux.windows[pane.window_id]?.tile_id ?? null;
  });

  async function handleEditSpawnDirectory() {
    if (!activeSession) return;
    const current = activeSession.root_cwd ?? '';
    const next = window.prompt('Spawn directory for this tab/session', current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;

    updatingSessionCwd = true;
    try {
      await setSessionRootCwd(activeSession.id, trimmed);
    } catch (error) {
      console.error('set_session_root_cwd failed:', error);
    } finally {
      updatingSessionCwd = false;
    }
  }

  function ownerLabel(agentId: string | null | undefined) {
    if (!agentId) return 'unowned';
    return $agentInfos.find((agent) => agent.agent_id === agentId)?.display_name ?? agentId;
  }
</script>

{#if $sidebarOpen}
  <div class="sidebar">
    <div class="sidebar-titlebar">
      <span class="sidebar-root-title">TREE</span>
      <button
        class="sidebar-hide"
        type="button"
        title="Hide sidebar"
        aria-label="Hide sidebar"
        onclick={() => sidebarOpen.set(false)}
      >
        ×
      </button>
    </div>
    <div class="sidebar-sections">
      <section class="sidebar-section" class:focused-section={$sidebarSection === 'settings'}>
        <div class="sidebar-subheader">
          <button class="sidebar-subheader-main" type="button" onclick={() => setSidebarSection('settings')}>
            <span class="sidebar-subtitle settings">SETTINGS</span>
          </button>
          <button
            class="section-toggle"
            type="button"
            title={settingsCollapsed ? 'Expand SETTINGS section' : 'Collapse SETTINGS section'}
            aria-label={settingsCollapsed ? 'Expand SETTINGS section' : 'Collapse SETTINGS section'}
            onclick={(event) => {
              event.stopPropagation();
              settingsCollapsed = !settingsCollapsed;
            }}
          >
            {settingsCollapsed ? '+' : '−'}
          </button>
        </div>
        {#if !settingsCollapsed}
          <div class="session-cwd-card settings-card">
            <div class="session-cwd-topline">
              <span class="session-cwd-label settings-card-label">SPAWN DIR</span>
              <button
                class="session-cwd-edit"
                type="button"
                disabled={!activeSession || updatingSessionCwd}
                title="Edit spawn directory for the active tab"
                onclick={handleEditSpawnDirectory}
              >
                {updatingSessionCwd ? '...' : 'EDIT'}
              </button>
            </div>
            <div class="session-cwd-value">{activeSession?.root_cwd ?? 'unavailable'}</div>
          </div>
          <div class="tile-port-count-card settings-card">
            <div class="tile-port-count-topline">
              <span class="settings-card-label">PORTS</span>
              <span class="tile-port-count-current">{$tilePortCount}</span>
            </div>
            <div class="tile-port-count-group" role="group" aria-label="Tile port count">
              {#each TILE_PORT_COUNT_OPTIONS as count}
                <button
                  class="tile-port-count-toggle"
                  class:selected={$tilePortCount === count}
                  type="button"
                  data-port-count={count}
                  aria-pressed={$tilePortCount === count}
                  onclick={() => tilePortCount.set(count)}
                >
                  {count}
                </button>
              {/each}
            </div>
            <div class="tile-port-count-help">available ports per tile</div>
          </div>
          <div class="wire-sparks-card settings-card">
            <div class="wire-sparks-topline">
              <span class="settings-card-label">WIRE SPARKS</span>
              <span class="wire-sparks-current">{$networkCallSparksEnabled ? 'ON' : 'OFF'}</span>
            </div>
            <button
              class="wire-sparks-toggle"
              class:selected={$networkCallSparksEnabled}
              type="button"
              aria-pressed={$networkCallSparksEnabled}
              onclick={() => networkCallSparksEnabled.set(!$networkCallSparksEnabled)}
            >
              {$networkCallSparksEnabled ? 'DISABLE' : 'ENABLE'}
            </button>
            <div class="tile-port-count-help">animate network calls over canvas wires</div>
          </div>
        {/if}
      </section>

      <section class="sidebar-section" class:focused-section={$sidebarSection === 'work'}>
        <div class="sidebar-subheader">
          <button class="sidebar-subheader-main" type="button" onclick={() => setSidebarSection('work')}>
            <span class="sidebar-subtitle work">WORK</span>
          </button>
          <button
            class="section-toggle"
            type="button"
            title={workCollapsed ? 'Expand WORK section' : 'Collapse WORK section'}
            aria-label={workCollapsed ? 'Expand WORK section' : 'Collapse WORK section'}
            onclick={(event) => {
              event.stopPropagation();
              workCollapsed = !workCollapsed;
            }}
          >
            {workCollapsed ? '+' : '−'}
          </button>
        </div>
        {#if !workCollapsed}
          <div class="work-list">
            {#if sessionWorkItems.length === 0}
              <div class="tree-empty">no work items</div>
            {:else}
              {#each sessionWorkItems as item (item.work_id)}
                <button
                  type="button"
                  class="work-item"
                  class:selected-work={item.work_id === $selectedWorkId}
                  class:needs-review={item.stages.find((stage) => stage.stage === item.current_stage)?.status === 'completed'}
                  onclick={() => selectWorkItem(item.work_id)}
                >
                  <div class="work-item-topline">
                    <span class="work-item-id">{item.work_id}</span>
                    <span class="work-item-stage">{item.current_stage}/{item.stages.find((stage) => stage.stage === item.current_stage)?.status}</span>
                  </div>
                  <div class="work-item-title">{item.title}</div>
                  <div class="work-item-meta">{ownerLabel(item.owner_agent_id)}</div>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </section>

      <section class="sidebar-section" class:focused-section={$sidebarSection === 'agents'}>
        <div class="sidebar-subheader">
          <button class="sidebar-subheader-main" type="button" onclick={() => setSidebarSection('agents')}>
            <span class="sidebar-subtitle agents">AGENTS</span>
          </button>
          <button
            class="section-toggle"
            type="button"
            title={agentsCollapsed ? 'Expand AGENTS section' : 'Collapse AGENTS section'}
            aria-label={agentsCollapsed ? 'Expand AGENTS section' : 'Collapse AGENTS section'}
            onclick={(event) => {
              event.stopPropagation();
              agentsCollapsed = !agentsCollapsed;
            }}
          >
            {agentsCollapsed ? '+' : '−'}
          </button>
        </div>
        {#if !agentsCollapsed}
          <div class="agent-list">
            {#if sortedAgents.length === 0}
              <div class="tree-empty">no agents</div>
            {:else}
              {#each sortedAgents as agent (agent.agent_id)}
                <button
                  type="button"
                  class="agent-item"
                  class:active-agent={agent.tile_id === selectedTileId}
                  class:dead-agent={!agent.alive}
                  onclick={() => selectAgentItem(agent.agent_id)}
                >
                  <div class="agent-main-row">
                    <span class="agent-tag">{agent.alive ? 'AGT' : 'OFF'}</span>
                    <span class="agent-name">{agent.display_name}</span>
                  </div>
                  <div class="agent-meta">id={agent.agent_id}</div>
                  <div class="agent-meta">tile={agent.tile_id} tab={agent.session_id}</div>
                  {#if agent.channels.length > 0}
                    <div class="agent-meta">channels={agent.channels.join(', ')}</div>
                  {/if}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </section>

      <section class="sidebar-section" class:focused-section={$sidebarSection === 'tmux'}>
        <div class="sidebar-subheader">
          <button class="sidebar-subheader-main" type="button" onclick={() => setSidebarSection('tmux')}>
            <span class="sidebar-subtitle">TMUX</span>
          </button>
          <button
            class="section-toggle"
            type="button"
            title={tmuxCollapsed ? 'Expand TMUX section' : 'Collapse TMUX section'}
            aria-label={tmuxCollapsed ? 'Expand TMUX section' : 'Collapse TMUX section'}
            onclick={(event) => {
              event.stopPropagation();
              tmuxCollapsed = !tmuxCollapsed;
            }}
          >
            {tmuxCollapsed ? '+' : '−'}
          </button>
        </div>
        {#if !tmuxCollapsed}
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
        {/if}
      </section>
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

  .sidebar-sections {
    flex: 1;
    overflow-y: auto;
  }

  .sidebar-titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-bottom: 1px solid var(--copper);
    background: rgba(0, 0, 0, 0.16);
    flex-shrink: 0;
  }

  .sidebar-root-title {
    font-size: 10px;
    color: var(--phosphor-amber);
    letter-spacing: 2px;
  }

  .sidebar-hide {
    width: 18px;
    height: 18px;
    border: none;
    background: none;
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 14px;
    line-height: 1;
    padding: 0;
    cursor: pointer;
  }

  .sidebar-hide:hover {
    color: var(--phosphor-red);
  }

  .sidebar-section {
    border-bottom: 1px solid rgba(242, 176, 90, 0.08);
  }

  .sidebar-section.focused-section {
    box-shadow: inset 2px 0 0 #6ebcff;
    background: rgba(110, 188, 255, 0.03);
  }

  .sidebar-subheader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-bottom: 1px solid var(--copper-dim);
  }

  .sidebar-subheader-main {
    flex: 1;
    display: flex;
    align-items: center;
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 0;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
  }

  .sidebar-subtitle {
    font-size: 10px;
    color: var(--phosphor-green);
    letter-spacing: 2px;
  }

  .sidebar-subtitle.work {
    color: #6ebcff;
  }

  .sidebar-subtitle.settings {
    color: var(--phosphor-amber);
  }

  .sidebar-subtitle.agents {
    color: var(--copper);
  }

  .section-toggle {
    width: 16px;
    height: 16px;
    border: 1px solid var(--component-border);
    background: rgba(0, 0, 0, 0.14);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
  }

  .section-toggle:hover {
    border-color: var(--copper);
    color: var(--copper);
    background: rgba(242, 176, 90, 0.06);
  }

  .sidebar-tree {
    padding: 4px 0;
  }

  .settings-card {
    padding: 8px;
    border-bottom: 1px solid rgba(242, 176, 90, 0.08);
    background: rgba(0, 0, 0, 0.12);
  }

  .session-cwd-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }

  .settings-card-label {
    font-size: 9px;
    color: var(--copper);
    letter-spacing: 1.5px;
  }

  .session-cwd-edit {
    border: 1px solid var(--component-border);
    background: rgba(0, 0, 0, 0.16);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 2px 6px;
    cursor: pointer;
  }

  .session-cwd-edit:hover:not(:disabled) {
    border-color: var(--copper);
    color: var(--copper);
  }

  .session-cwd-edit:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .session-cwd-value {
    font-size: 10px;
    color: var(--silk-white);
    word-break: break-all;
    line-height: 1.4;
  }

  .tile-port-count-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .wire-sparks-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .tile-port-count-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .tile-port-count-current {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--silk-white);
  }

  .tile-port-count-group {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  }

  .tile-port-count-toggle {
    border: 1px solid var(--component-border);
    background: rgba(0, 0, 0, 0.16);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 5px 0;
    cursor: pointer;
  }

  .tile-port-count-toggle:hover {
    border-color: var(--copper);
    color: var(--copper);
  }

  .tile-port-count-toggle.selected {
    border-color: var(--copper);
    color: var(--silk-white);
    background: rgba(242, 176, 90, 0.12);
  }

  .tile-port-count-help {
    font-size: 10px;
    color: var(--silk-dim);
    line-height: 1.4;
  }

  .wire-sparks-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .wire-sparks-current {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--silk-white);
  }

  .wire-sparks-toggle {
    border: 1px solid var(--component-border);
    background: rgba(0, 0, 0, 0.16);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 6px 8px;
    cursor: pointer;
    text-align: center;
  }

  .wire-sparks-toggle:hover {
    border-color: var(--copper);
    color: var(--copper);
  }

  .wire-sparks-toggle.selected {
    border-color: var(--copper);
    color: var(--silk-white);
    background: rgba(242, 176, 90, 0.12);
  }

  .work-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid rgba(110, 188, 255, 0.12);
  }

  .work-item {
    border: 1px solid var(--component-border);
    background: rgba(0, 0, 0, 0.12);
    color: var(--silk-white);
    text-align: left;
    padding: 6px 8px;
    cursor: pointer;
    font-family: inherit;
  }

  .work-item.selected-work {
    border-color: #6ebcff;
    background: rgba(110, 188, 255, 0.08);
  }

  .work-item.needs-review {
    border-color: var(--copper);
    box-shadow: inset 2px 0 0 var(--copper);
  }

  .work-item-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 9px;
    color: var(--silk-dim);
  }

  .work-item-id {
    color: #6ebcff;
  }

  .work-item-stage {
    text-transform: uppercase;
  }

  .work-item-title {
    font-size: 10px;
    color: var(--silk-white);
    margin-bottom: 4px;
  }

  .work-item-meta {
    font-size: 9px;
    color: var(--silk-dim);
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

  .agent-list {
    padding: 6px 0 8px;
  }

  .agent-item {
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    font-family: inherit;
    padding: 5px 8px 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    cursor: pointer;
  }

  .agent-item.active-agent {
    background: rgba(242, 176, 90, 0.06);
  }

  .agent-item.dead-agent .agent-name,
  .agent-item.dead-agent .agent-meta {
    color: var(--copper-dim);
  }

  .agent-main-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
  }

  .agent-tag {
    font-size: 7px;
    padding: 0 3px;
    border: 1px solid rgba(242, 176, 90, 0.28);
    color: var(--copper);
    line-height: 1.4;
    flex-shrink: 0;
  }

  .agent-name {
    font-size: 10px;
    color: var(--silk-white);
    word-break: break-word;
  }

  .agent-meta {
    font-size: 8px;
    color: var(--silk-dim);
    font-family: var(--font-mono);
    line-height: 1.4;
    word-break: break-word;
  }
</style>
