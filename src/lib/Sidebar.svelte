<script lang="ts">
  import { onMount } from 'svelte';
  import {
    activeSessionWorkItems,
    appState,
    agentInfos,
    closeSettingsSidebar,
    closeSidebar,
    gridSnapEnabled,
    gridSnapSize,
    networkCallSparksEnabled,
    refreshSavedSessionConfigurations,
    savedSessionConfigurations,
    saveSessionConfigurationForSession,
    selectedWorkId,
    selectAgentItem,
    loadSavedSessionConfigurationIntoSession,
    selectWorkItem,
    setSidebarSection,
    setSidebarSelection,
    settingsSidebarOpen,
    sidebarSection,
    sidebarItems,
    sidebarOpen,
    sidebarSelectedIdx,
    tilePortCount,
  } from './stores/appState';
  import { TILE_PORT_COUNT_OPTIONS } from './tilePorts';
  import {
    deleteSessionConfiguration,
    getAgentBrowserInstallStatus,
    installAgentBrowserRuntime,
    renameSession,
    setAgentBrowserInstallDeclined,
    setSessionBrowserBackend,
    setSessionRootCwd,
  } from './tauri';
  import { GRID_SNAP_SIZE_OPTIONS } from './types';
  import type { AgentBrowserInstallStatus, BrowserBackend } from './types';

  let { kind = 'tree' }: { kind?: 'tree' | 'settings' } = $props();

  let workCollapsed = $state(false);
  let tmuxCollapsed = $state(false);
  let agentsCollapsed = $state(false);
  let updatingSessionCwd = $state(false);
  let renamingSession = $state(false);
  let savingSessionConfig = $state(false);
  let deletingSessionConfig = $state(false);
  let loadingSessionConfig = $state(false);
  let browserBackendBusy = $state(false);
  let sessionNameDraft = $state('');
  let sessionNameDirty = $state(false);
  let sessionNameSessionId = $state<string | null>(null);
  let agentBrowserStatus = $state<AgentBrowserInstallStatus | null>(null);
  let sessionConfigStatus = $state<{ tone: 'success' | 'error'; text: string } | null>(null);

  function sanitizeSessionConfigName(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) {
      return null;
    }

    let sanitized = '';
    let lastWasSeparator = false;
    for (const ch of trimmed) {
      if ((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
        sanitized += ch.toLowerCase();
        lastWasSeparator = false;
      } else if (!lastWasSeparator) {
        sanitized += '_';
        lastWasSeparator = true;
      }
    }

    const normalized = sanitized.replace(/^_+|_+$/g, '');
    return normalized.length > 0 ? normalized : null;
  }

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
  let currentSessionConfigName = $derived(sanitizeSessionConfigName(sessionNameDraft));
  let currentSavedSessionSummary = $derived.by(() => {
    const configName = currentSessionConfigName;
    if (!configName) {
      return null;
    }
    return $savedSessionConfigurations.find((entry) => entry.config_name === configName) ?? null;
  });
  let activeSessionBrowserTileCount = $derived.by(() => {
    const sessionId = activeSession?.id;
    if (!sessionId) return 0;
    return Object.values($appState.tmux.panes).filter(
      (pane) => pane.session_id === sessionId && (pane.role === 'browser' || pane.command === 'browser'),
    ).length;
  });
  let sessionWorkItems = $derived($activeSessionWorkItems);
  let selectedTileId = $derived.by(() => {
    const paneId = $appState.ui.selectedPaneId;
    if (!paneId) return null;
    const pane = $appState.tmux.panes[paneId];
    if (!pane) return null;
    return pane.tile_id ?? $appState.tmux.windows[pane.window_id]?.tile_id ?? null;
  });
  let sidebarVisible = $derived(kind === 'tree' ? $sidebarOpen : $settingsSidebarOpen);

  $effect(() => {
    const nextSessionId = activeSession?.id ?? null;
    const nextSessionName = activeSession?.name ?? '';
    if (nextSessionId !== sessionNameSessionId || !sessionNameDirty) {
      sessionNameSessionId = nextSessionId;
      sessionNameDraft = nextSessionName;
      sessionNameDirty = false;
      sessionConfigStatus = null;
    }
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

  async function refreshAgentBrowserRuntimeStatus() {
    try {
      agentBrowserStatus = await getAgentBrowserInstallStatus();
    } catch (error) {
      console.error('get_agent_browser_install_status failed:', error);
      agentBrowserStatus = null;
    }
  }

  async function ensureAgentBrowserInstalled() {
    const currentStatus = agentBrowserStatus ?? await getAgentBrowserInstallStatus();
    agentBrowserStatus = currentStatus;
    if (currentStatus.ready) {
      return currentStatus;
    }

    const confirmed = window.confirm(
      `Install agent-browser ${currentStatus.version} and Chrome for Testing into ${currentStatus.runtime_dir}?`,
    );
    if (!confirmed) {
      agentBrowserStatus = await setAgentBrowserInstallDeclined(true);
      return null;
    }

    agentBrowserStatus = await installAgentBrowserRuntime();
    return agentBrowserStatus;
  }

  async function handleSelectBrowserBackend(nextBackend: BrowserBackend) {
    if (!activeSession || browserBackendBusy || activeSession.browser_backend === nextBackend) {
      return;
    }

    if (
      activeSessionBrowserTileCount > 0
      && !window.confirm(
        `Switch this session's browser backend to ${nextBackend === 'agent_browser' ? 'Agent Browser' : 'Live Webview'}? Existing browser tiles will reconnect through the new backend.`,
      )
    ) {
      return;
    }

    browserBackendBusy = true;
    try {
      if (nextBackend === 'agent_browser') {
        const status = await ensureAgentBrowserInstalled();
        if (!status?.ready) {
          return;
        }
      }
      await setSessionBrowserBackend(activeSession.id, nextBackend);
      await refreshAgentBrowserRuntimeStatus();
    } catch (error) {
      console.error('set_session_browser_backend failed:', error);
    } finally {
      browserBackendBusy = false;
    }
  }

  async function commitSessionName(): Promise<string | null> {
    if (!activeSession) return null;
    const trimmed = sessionNameDraft.trim();
    if (!trimmed) {
      sessionNameDraft = activeSession.name;
      sessionNameDirty = false;
      return activeSession.name;
    }
    if (trimmed === activeSession.name) {
      sessionNameDirty = false;
      return trimmed;
    }

    renamingSession = true;
    try {
      await renameSession(activeSession.id, trimmed);
      sessionNameDraft = trimmed;
      sessionNameDirty = false;
      return trimmed;
    } catch (error) {
      console.error('rename_session failed:', error);
      sessionNameDraft = activeSession.name;
      sessionNameDirty = false;
      return null;
    } finally {
      renamingSession = false;
    }
  }

  async function handleSaveSessionConfiguration() {
    if (!activeSession || savingSessionConfig || deletingSessionConfig || loadingSessionConfig) return;
    const committedName = await commitSessionName();
    if (!committedName) return;

    const configName = sanitizeSessionConfigName(committedName);
    if (!configName) return;
    const existingSummary = $savedSessionConfigurations.find((entry) => entry.config_name === configName);
    if (
      existingSummary
      && !window.confirm(
        `Overwrite saved session "${existingSummary.session_name}" (${existingSummary.file_name})?`,
      )
    ) {
      return;
    }

    savingSessionConfig = true;
    sessionConfigStatus = null;
    try {
      const summary = await saveSessionConfigurationForSession(activeSession.id);
      await refreshSavedSessionConfigurations();
      sessionConfigStatus = {
        tone: 'success',
        text: existingSummary
          ? `Overwrote ${summary.file_name}.`
          : `Saved ${summary.file_name}.`,
      };
    } catch (error) {
      console.error('save_session_configuration failed:', error);
      sessionConfigStatus = {
        tone: 'error',
        text: error instanceof Error ? error.message : 'Failed to save session.',
      };
    } finally {
      savingSessionConfig = false;
    }
  }

  async function handleDeleteSessionConfiguration() {
    if (!activeSession || savingSessionConfig || deletingSessionConfig || loadingSessionConfig) return;
    const summary = currentSavedSessionSummary;
    if (!summary) return;
    if (!window.confirm(`Delete saved session "${summary.session_name}" (${summary.file_name})?`)) {
      return;
    }

    deletingSessionConfig = true;
    sessionConfigStatus = null;
    try {
      await deleteSessionConfiguration(summary.config_name);
      await refreshSavedSessionConfigurations();
      sessionConfigStatus = {
        tone: 'success',
        text: `Deleted ${summary.file_name}.`,
      };
    } catch (error) {
      console.error('delete_session_configuration failed:', error);
      sessionConfigStatus = {
        tone: 'error',
        text: error instanceof Error ? error.message : 'Failed to delete saved session.',
      };
    } finally {
      deletingSessionConfig = false;
    }
  }

  async function handleLoadSessionConfiguration() {
    if (!activeSession || savingSessionConfig || deletingSessionConfig || loadingSessionConfig) return;
    const committedName = await commitSessionName();
    if (!committedName) return;

    loadingSessionConfig = true;
    try {
      await loadSavedSessionConfigurationIntoSession(activeSession.id, committedName);
      await refreshSavedSessionConfigurations();
    } catch (error) {
      console.error('load_session_configuration failed:', error);
      sessionConfigStatus = {
        tone: 'error',
        text: error instanceof Error ? error.message : 'Failed to load saved session.',
      };
    } finally {
      loadingSessionConfig = false;
    }
  }

  function ownerLabel(agentId: string | null | undefined) {
    if (!agentId) return 'unowned';
    return $agentInfos.find((agent) => agent.agent_id === agentId)?.display_name ?? agentId;
  }

  onMount(() => {
    if (kind === 'settings') {
      void refreshAgentBrowserRuntimeStatus();
    }
  });
</script>

{#if sidebarVisible}
  <div class="sidebar">
    <div class="sidebar-titlebar">
      <span class="sidebar-root-title">{kind === 'tree' ? 'TREE' : 'SETTINGS'}</span>
      <button
        class="sidebar-hide"
        type="button"
        title="Hide sidebar"
        aria-label="Hide sidebar"
        onclick={() => {
          if (kind === 'tree') {
            closeSidebar();
          } else {
            closeSettingsSidebar();
          }
        }}
      >
        ×
      </button>
    </div>
    <div class="sidebar-sections">
      {#if kind === 'settings'}
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
        <div class="session-config-card settings-card">
          <div class="session-config-topline">
            <span class="settings-card-label">SESSION NAME</span>
          </div>
          <input
            class="session-name-input"
            type="text"
            bind:value={sessionNameDraft}
            placeholder="Session name"
            disabled={!activeSession || renamingSession || savingSessionConfig || deletingSessionConfig || loadingSessionConfig}
            oninput={() => {
              sessionNameDirty = true;
              sessionConfigStatus = null;
            }}
            onblur={() => {
              void commitSessionName();
            }}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commitSessionName();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                sessionNameDraft = activeSession?.name ?? '';
                sessionNameDirty = false;
              }
            }}
          />
          <div class="session-config-actions">
            <button
              class="session-config-button"
              type="button"
              disabled={!activeSession || renamingSession || savingSessionConfig || deletingSessionConfig || loadingSessionConfig}
              onclick={handleSaveSessionConfiguration}
            >
              {savingSessionConfig ? 'SAVING...' : 'SAVE'}
            </button>
            <button
              class="session-config-button"
              type="button"
              disabled={!activeSession || renamingSession || savingSessionConfig || deletingSessionConfig || loadingSessionConfig || !currentSavedSessionSummary}
              onclick={handleDeleteSessionConfiguration}
            >
              {deletingSessionConfig ? 'DELETING...' : 'DELETE'}
            </button>
            <button
              class="session-config-button"
              type="button"
              disabled={!activeSession || renamingSession || savingSessionConfig || deletingSessionConfig || loadingSessionConfig}
              onclick={handleLoadSessionConfiguration}
            >
              {loadingSessionConfig ? 'LOADING...' : 'LOAD'}
            </button>
          </div>
          <div
            class="session-config-status"
            class:success={sessionConfigStatus?.tone === 'success'}
            class:error={sessionConfigStatus?.tone === 'error'}
          >
            {#if sessionConfigStatus}
              {sessionConfigStatus.text}
            {:else if currentSavedSessionSummary}
              Saved file: {currentSavedSessionSummary.file_name}
            {:else}
              No saved session file for this name.
            {/if}
          </div>
        </div>
        <div class="browser-backend-card settings-card">
          <div class="browser-backend-topline">
            <span class="settings-card-label">BROWSER BACKEND</span>
            <span class="browser-backend-status">
              {agentBrowserStatus?.ready ? 'READY' : (agentBrowserStatus?.declined ? 'DECLINED' : 'NOT INSTALLED')}
            </span>
          </div>
          <div class="browser-backend-options">
            <button
              class="browser-backend-toggle"
              class:selected={activeSession?.browser_backend === 'live_webview'}
              type="button"
              disabled={!activeSession || browserBackendBusy}
              aria-pressed={activeSession?.browser_backend === 'live_webview'}
              onclick={() => {
                void handleSelectBrowserBackend('live_webview');
              }}
            >
              LIVE WEBVIEW
            </button>
            <button
              class="browser-backend-toggle"
              class:selected={activeSession?.browser_backend === 'agent_browser'}
              type="button"
              disabled={!activeSession || browserBackendBusy}
              aria-pressed={activeSession?.browser_backend === 'agent_browser'}
              onclick={() => {
                void handleSelectBrowserBackend('agent_browser');
              }}
            >
              AGENT BROWSER
            </button>
          </div>
          <div class="browser-backend-note">
            {#if browserBackendBusy}
              Updating browser backend…
            {:else if agentBrowserStatus?.error}
              {agentBrowserStatus.error}
            {:else if agentBrowserStatus?.ready}
              Runtime: {agentBrowserStatus.runtime_dir}
            {:else if agentBrowserStatus?.declined}
              Agent Browser stays unavailable until you choose it again.
            {:else}
              Selecting Agent Browser will install its bundled runtime and Chrome for Testing.
            {/if}
          </div>
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
            <span class="settings-card-label">SNAP TO GRID</span>
            <button
              class="wire-sparks-toggle"
              class:selected={$gridSnapEnabled}
              type="button"
              aria-label="Toggle snap to grid"
              aria-pressed={$gridSnapEnabled}
              onclick={() => gridSnapEnabled.set(!$gridSnapEnabled)}
            >
              <span class="wire-sparks-toggle-thumb" aria-hidden="true"></span>
              <span class="wire-sparks-toggle-option">ON</span>
              <span class="wire-sparks-toggle-option">OFF</span>
            </button>
          </div>
          <div class="tile-port-count-help">snap tile movement and placement to the canvas grid</div>
        </div>
        <div class="tile-port-count-card settings-card">
          <div class="tile-port-count-topline">
            <span class="settings-card-label">GRID SIZE</span>
            <span class="tile-port-count-current">{$gridSnapSize}</span>
          </div>
          <div class="tile-port-count-group" role="group" aria-label="Canvas grid snap size">
            {#each GRID_SNAP_SIZE_OPTIONS as size}
              <button
                class="tile-port-count-toggle"
                class:selected={$gridSnapSize === size}
                type="button"
                data-grid-snap-size={size}
                aria-pressed={$gridSnapSize === size}
                onclick={() => gridSnapSize.set(size)}
              >
                {size}
              </button>
            {/each}
          </div>
          <div class="tile-port-count-help">snap granularity in canvas pixels</div>
        </div>
        <div class="wire-sparks-card settings-card">
          <div class="wire-sparks-topline">
            <span class="settings-card-label">WIRE SPARKS</span>
            <button
              class="wire-sparks-toggle"
              class:selected={$networkCallSparksEnabled}
              type="button"
              aria-label="Toggle wire sparks"
              aria-pressed={$networkCallSparksEnabled}
              onclick={() => networkCallSparksEnabled.set(!$networkCallSparksEnabled)}
            >
              <span class="wire-sparks-toggle-thumb" aria-hidden="true"></span>
              <span class="wire-sparks-toggle-option">ON</span>
              <span class="wire-sparks-toggle-option">OFF</span>
            </button>
          </div>
          <div class="tile-port-count-help">animate network calls over canvas wires</div>
        </div>
      {:else}
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

  .browser-backend-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .browser-backend-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .browser-backend-status {
    font-size: 9px;
    color: var(--silk-dim);
    letter-spacing: 1px;
  }

  .browser-backend-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }

  .browser-backend-toggle {
    border: 1px solid var(--component-border);
    background: rgba(0, 0, 0, 0.16);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 6px 0;
    cursor: pointer;
  }

  .browser-backend-toggle:hover:not(:disabled) {
    border-color: var(--copper);
    color: var(--copper);
  }

  .browser-backend-toggle.selected {
    border-color: var(--copper);
    color: var(--silk-white);
    background: rgba(242, 176, 90, 0.12);
  }

  .browser-backend-toggle:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .browser-backend-note {
    font-size: 10px;
    color: var(--silk-dim);
    line-height: 1.4;
    word-break: break-word;
  }

  .session-config-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .session-config-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .session-name-input {
    width: 100%;
    border: 1px solid var(--component-border);
    background: rgba(0, 0, 0, 0.16);
    color: var(--silk-white);
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 6px 8px;
    outline: none;
  }

  .session-name-input:focus {
    border-color: var(--copper);
  }

  .session-name-input:disabled {
    opacity: 0.6;
  }

  .session-config-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }

  .session-config-button {
    border: 1px solid var(--component-border);
    background: rgba(0, 0, 0, 0.16);
    color: var(--silk-white);
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 6px 0;
    cursor: pointer;
  }

  .session-config-button:hover:not(:disabled) {
    border-color: var(--copper);
    color: var(--copper);
  }

  .session-config-button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .session-config-status {
    min-height: 14px;
    font-size: 10px;
    color: var(--silk-dim);
    line-height: 1.4;
    word-break: break-word;
  }

  .session-config-status.success {
    color: var(--phosphor-green);
  }

  .session-config-status.error {
    color: var(--phosphor-red);
  }

  .tile-port-count-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .wire-sparks-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
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

  .wire-sparks-toggle {
    position: relative;
    display: inline-grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: center;
    width: 72px;
    padding: 2px;
    border: 1px solid var(--component-border);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.22);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 9px;
    line-height: 1;
    cursor: pointer;
    overflow: hidden;
    transition:
      border-color 0.14s ease,
      background 0.14s ease,
      color 0.14s ease,
      box-shadow 0.14s ease;
  }

  .wire-sparks-toggle-thumb {
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: 2px;
    width: calc(50% - 2px);
    border-radius: 999px;
    background: rgba(242, 176, 90, 0.14);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.06),
      0 0 10px rgba(242, 176, 90, 0.12);
    transform: translateX(100%);
    transition:
      transform 0.16s ease,
      background 0.16s ease,
      box-shadow 0.16s ease;
  }

  .wire-sparks-toggle-option {
    position: relative;
    z-index: 1;
    padding: 4px 0;
    text-align: center;
    letter-spacing: 0.5px;
  }

  .wire-sparks-toggle:hover {
    border-color: var(--copper);
    color: var(--copper);
    box-shadow: 0 0 12px rgba(242, 176, 90, 0.12);
  }

  .wire-sparks-toggle.selected {
    border-color: var(--copper);
    color: var(--silk-white);
    background: rgba(242, 176, 90, 0.08);
  }

  .wire-sparks-toggle.selected .wire-sparks-toggle-thumb {
    transform: translateX(0);
    background: rgba(242, 176, 90, 0.18);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.08),
      0 0 12px rgba(242, 176, 90, 0.18);
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
