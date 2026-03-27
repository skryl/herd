<script lang="ts">
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { onDestroy, onMount, tick } from 'svelte';
  import Canvas from './lib/Canvas.svelte';
  import CommandBar from './lib/CommandBar.svelte';
  import ConfirmDialog from './lib/ConfirmDialog.svelte';
  import DebugPane from './lib/DebugPane.svelte';
  import HelpPane from './lib/HelpPane.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import StatusBar from './lib/StatusBar.svelte';
  import Toolbar from './lib/Toolbar.svelte';
  import { handleArrangeElkEvent } from './lib/appEvents';
  import { handleGlobalKeyInput, keyboardEventToKeyInput } from './lib/interaction/keyboard';
  import {
    applyRemoteLayoutEntry,
    appendChatterEntry,
    applyAgentDebugState,
    applyTileSignalState,
    applyPaneRole,
    applyPaneReadOnly,
    applyTmuxSnapshot,
    bootstrapAppState,
    dispatchIntent,
    mode,
    persistWorkCardLayout,
    refreshAgentDebugState,
    refreshWorkItems,
    registerWorkDialogOpener,
    updateWorkCardLayout,
  } from './lib/stores/appState';
  import { activeTabId } from './lib/stores/tabs';
  import {
    createWorkItem,
    getAgentBrowserInstallStatus,
    installAgentBrowserRuntime,
    setAgentBrowserInstallDeclined,
    setTestDriverState,
  } from './lib/tauri';
  import { installTestDriver } from './lib/testDriver';
  import type { AgentDebugState, ChatterEntry, HerdMode, PaneKind, PendingSpawnPlacement, TileSignalState, TmuxSnapshot } from './lib/types';

  let unlistenTmuxState: UnlistenFn | null = null;
  let unlistenReadOnly: UnlistenFn | null = null;
  let unlistenRole: UnlistenFn | null = null;
  let unlistenAgentState: UnlistenFn | null = null;
  let unlistenTileSignalState: UnlistenFn | null = null;
  let unlistenChatterEntry: UnlistenFn | null = null;
  let unlistenWorkUpdated: UnlistenFn | null = null;
  let unlistenLayoutEntry: UnlistenFn | null = null;
  let unlistenArrangeElk: UnlistenFn | null = null;
  let disposeTestDriver: (() => void) | null = null;
  let workDialogOpen = false;
  let workDialogTitle = '';
  let workDialogBusy = false;
  let workInputRef: HTMLInputElement | null = null;
  let workDialogModeRestore: HerdMode | null = null;
  let workDialogPlacement: PendingSpawnPlacement | null = null;
  let unregisterWorkDialogOpener: (() => void) | null = null;

  function isShortcutPassthroughTarget(target: EventTarget | null): target is HTMLElement {
    if (!(target instanceof HTMLElement)) return false;
    if (target.closest('.command-bar')) return false;
    if (target.closest('.terminal-container') || target.closest('.xterm')) return false;
    return (
      target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || target.isContentEditable
    );
  }

  function enterWorkDialogInputMode() {
    if (workDialogModeRestore === null) {
      workDialogModeRestore = $mode;
    }
    if ($mode !== 'input') {
      mode.set('input');
    }
  }

  function restoreWorkDialogMode() {
    if (workDialogModeRestore !== null) {
      mode.set(workDialogModeRestore);
      workDialogModeRestore = null;
    }
  }

  function handleSpawnShell() {
    void dispatchIntent({ type: 'new-shell' });
  }

  function handleSpawnAgent() {
    void dispatchIntent({ type: 'new-agent' });
  }

  function handleSpawnBrowser() {
    void dispatchIntent({ type: 'new-browser' });
  }

  function handleSpawnWork(placement: PendingSpawnPlacement | null = null) {
    workDialogTitle = '';
    workDialogPlacement = placement;
    workDialogOpen = true;
    enterWorkDialogInputMode();
    void tick().then(() => workInputRef?.focus());
  }

  function closeWorkDialog() {
    if (workDialogBusy) return;
    workDialogOpen = false;
    workDialogTitle = '';
    workDialogPlacement = null;
    restoreWorkDialogMode();
  }

  async function submitWorkDialog() {
    const trimmed = workDialogTitle.trim();
    if (!trimmed || workDialogBusy) return;

    workDialogBusy = true;
    try {
      const item = await createWorkItem(trimmed, workDialogPlacement?.sessionId ?? $activeTabId ?? null);
      await refreshWorkItems(item.session_id);
      if (workDialogPlacement) {
        updateWorkCardLayout(item.work_id, {
          x: workDialogPlacement.worldX,
          y: workDialogPlacement.worldY,
        });
        await persistWorkCardLayout(item.work_id);
      }
      workDialogOpen = false;
      workDialogTitle = '';
      workDialogPlacement = null;
      restoreWorkDialogMode();
    } catch (error) {
      console.error('create_work_item failed:', error);
    } finally {
      workDialogBusy = false;
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (isShortcutPassthroughTarget(e.target)) {
      return;
    }
    void handleGlobalKeyInput(keyboardEventToKeyInput(e), {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight - 54,
      onHandled: () => e.preventDefault(),
    });
  }

  onMount(async () => {
    disposeTestDriver = await installTestDriver();
    unregisterWorkDialogOpener = registerWorkDialogOpener((placement) => {
      handleSpawnWork(placement);
    });
    window.addEventListener('keydown', handleKeyDown, true);
    unlistenTmuxState = await listen<TmuxSnapshot>('tmux-state', (event) => {
      applyTmuxSnapshot(event.payload);
      void refreshAgentDebugState();
      void refreshWorkItems(event.payload.active_session_id ?? null);
    });
    unlistenReadOnly = await listen<{ session_id?: string; pane_id?: string; read_only: boolean }>('shell-read-only', (event) => {
      const paneId = event.payload.pane_id ?? event.payload.session_id;
      if (paneId) {
        applyPaneReadOnly(paneId, event.payload.read_only);
      }
    });
    unlistenRole = await listen<{ session_id?: string; pane_id?: string; role: PaneKind }>('shell-role', (event) => {
      const paneId = event.payload.pane_id ?? event.payload.session_id;
      if (paneId) {
        applyPaneRole(paneId, event.payload.role);
      }
    });
    unlistenAgentState = await listen<AgentDebugState>('herd-agent-state', (event) => {
      applyAgentDebugState(event.payload);
    });
    unlistenTileSignalState = await listen<TileSignalState>('herd-tile-signal-state', (event) => {
      applyTileSignalState(event.payload);
    });
    unlistenChatterEntry = await listen<ChatterEntry>('herd-chatter-entry', (event) => {
      appendChatterEntry(event.payload);
    });
    unlistenWorkUpdated = await listen<{ session_id: string; work_id: string }>('herd-work-updated', () => {
      void refreshWorkItems($activeTabId ?? null);
    });
    unlistenLayoutEntry = await listen<{
      entry_id: string;
      pane_id?: string | null;
      x: number;
      y: number;
      width: number;
      height: number;
      request_resize?: boolean;
    }>('herd-layout-entry', (event) => {
      void applyRemoteLayoutEntry(
        event.payload.entry_id,
        {
          x: event.payload.x,
          y: event.payload.y,
          width: event.payload.width,
          height: event.payload.height,
        },
        event.payload.pane_id ?? null,
        event.payload.request_resize ?? false,
      );
    });
    unlistenArrangeElk = await listen<{ session_id?: string | null }>('herd-arrange-elk', (event) => {
      void handleArrangeElkEvent(event.payload);
    });
    await bootstrapAppState();
    try {
      const status = await getAgentBrowserInstallStatus();
      if (status.prompt_pending && !navigator.webdriver) {
        const confirmed = window.confirm(
          `Install agent-browser ${status.version} and Chrome for Testing into ${status.runtime_dir}?`,
        );
        if (confirmed) {
          await installAgentBrowserRuntime();
        } else {
          await setAgentBrowserInstallDeclined(true);
        }
      }
    } catch (error) {
      console.error('initial agent-browser install prompt failed:', error);
    }
    await setTestDriverState({ bootstrapComplete: true });
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeyDown, true);
    if (unlistenTmuxState) unlistenTmuxState();
    if (unlistenReadOnly) unlistenReadOnly();
    if (unlistenRole) unlistenRole();
    if (unlistenAgentState) unlistenAgentState();
    if (unlistenTileSignalState) unlistenTileSignalState();
    if (unlistenChatterEntry) unlistenChatterEntry();
    if (unlistenWorkUpdated) unlistenWorkUpdated();
    if (unlistenLayoutEntry) unlistenLayoutEntry();
    if (unlistenArrangeElk) unlistenArrangeElk();
    if (unregisterWorkDialogOpener) unregisterWorkDialogOpener();
    if (disposeTestDriver) disposeTestDriver();
  });
</script>

<Toolbar
  onSpawnShell={handleSpawnShell}
  onSpawnAgent={handleSpawnAgent}
  onSpawnBrowser={handleSpawnBrowser}
  onSpawnWork={() => handleSpawnWork()}
/>
<Sidebar kind="tree" />
<Sidebar kind="settings" />
<Canvas />
<CommandBar />
<ConfirmDialog />
{#if workDialogOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="work-overlay" onclick={closeWorkDialog}>
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="work-pane" onclick={(event) => event.stopPropagation()}>
      <div class="work-title">NEW WORK</div>
      <div class="work-message">Create a work item for the current tab/session.</div>
      <input
        bind:this={workInputRef}
        bind:value={workDialogTitle}
        class="work-input"
        placeholder="Work item title"
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void submitWorkDialog();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            closeWorkDialog();
          }
        }}
      />
      <div class="work-actions">
        <button class="work-button" type="button" onclick={closeWorkDialog} disabled={workDialogBusy}>
          Cancel
        </button>
        <button
          class="work-button primary"
          type="button"
          onclick={() => void submitWorkDialog()}
          disabled={workDialogBusy || !workDialogTitle.trim()}
        >
          {workDialogBusy ? 'Creating...' : 'Create Work'}
        </button>
      </div>
    </div>
  </div>
{/if}
<DebugPane />
<StatusBar />
<HelpPane />

<style>
  .work-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 2200;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .work-pane {
    width: min(460px, calc(100vw - 32px));
    background: var(--pcb-base);
    border: 1px solid rgba(110, 188, 255, 0.4);
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.8);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .work-title {
    color: #6ebcff;
    font-size: 11px;
    letter-spacing: 2px;
  }

  .work-message {
    color: var(--silk-dim);
    font-size: 11px;
    line-height: 1.5;
  }

  .work-input {
    width: 100%;
    background: rgba(0, 0, 0, 0.18);
    border: 1px solid var(--component-border);
    color: var(--silk-white);
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 8px;
    box-sizing: border-box;
  }

  .work-input:focus {
    outline: none;
    border-color: #6ebcff;
  }

  .work-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .work-button {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--component-border);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 6px 10px;
    cursor: pointer;
  }

  .work-button:hover:not(:disabled) {
    color: var(--phosphor-green);
    border-color: var(--phosphor-green-dim);
  }

  .work-button.primary {
    color: #6ebcff;
    border-color: rgba(110, 188, 255, 0.35);
    background: rgba(110, 188, 255, 0.08);
  }

  .work-button.primary:hover:not(:disabled) {
    color: #9dd3ff;
    border-color: #6ebcff;
  }

  .work-button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
