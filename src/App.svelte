<script lang="ts">
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { onDestroy, onMount } from 'svelte';
  import Canvas from './lib/Canvas.svelte';
  import CommandBar from './lib/CommandBar.svelte';
  import ConfirmDialog from './lib/ConfirmDialog.svelte';
  import DebugPane from './lib/DebugPane.svelte';
  import HelpPane from './lib/HelpPane.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import StatusBar from './lib/StatusBar.svelte';
  import Toolbar from './lib/Toolbar.svelte';
  import { handleGlobalKeyInput, keyboardEventToKeyInput } from './lib/interaction/keyboard';
  import {
    applyPaneRole,
    applyPaneReadOnly,
    applyTmuxSnapshot,
    bootstrapAppState,
    dispatchIntent,
  } from './lib/stores/appState';
  import { setTestDriverState } from './lib/tauri';
  import { installTestDriver } from './lib/testDriver';
  import type { PaneKind, TmuxSnapshot } from './lib/types';

  let unlistenTmuxState: UnlistenFn | null = null;
  let unlistenReadOnly: UnlistenFn | null = null;
  let unlistenRole: UnlistenFn | null = null;
  let disposeTestDriver: (() => void) | null = null;

  function handleSpawnShell() {
    void dispatchIntent({ type: 'new-shell' });
  }

  function handleKeyDown(e: KeyboardEvent) {
    void handleGlobalKeyInput(keyboardEventToKeyInput(e), {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight - 54,
      onHandled: () => e.preventDefault(),
    });
  }

  onMount(async () => {
    disposeTestDriver = await installTestDriver();
    window.addEventListener('keydown', handleKeyDown, true);
    unlistenTmuxState = await listen<TmuxSnapshot>('tmux-state', (event) => {
      applyTmuxSnapshot(event.payload);
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
    await bootstrapAppState();
    await setTestDriverState({ bootstrapComplete: true });
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeyDown, true);
    if (unlistenTmuxState) unlistenTmuxState();
    if (unlistenReadOnly) unlistenReadOnly();
    if (unlistenRole) unlistenRole();
    if (disposeTestDriver) disposeTestDriver();
  });
</script>

<Toolbar onSpawnShell={handleSpawnShell} />
<Sidebar />
<Canvas />
<CommandBar />
<ConfirmDialog />
<DebugPane />
<StatusBar />
<HelpPane />
