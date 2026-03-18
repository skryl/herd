<script lang="ts">
  import { mode } from './stores/mode';
  import { selectedTerminalId } from './stores/terminals';
  import { activeTabTerminals } from './stores/tabs';

  let selectedIndex = $derived(() => {
    const tabTerms = $activeTabTerminals;
    const selId = $selectedTerminalId;
    if (!selId || tabTerms.length === 0) return 0;
    return tabTerms.findIndex(t => t.id === selId) + 1;
  });

  let totalInTab = $derived($activeTabTerminals.length);
</script>

<div class="status-bar">
  <div class="status-left">
    <span class="mode-badge" class:command={$mode === 'command'} class:input={$mode === 'input'}>
      {$mode === 'command' ? 'CMD' : 'INS'}
    </span>
    <span class="window-count">[{selectedIndex()}/{totalInTab}]</span>
  </div>

  <div class="status-center">
    {#if $mode === 'command'}
      <span class="shortcut"><span class="key">h</span><span class="key">j</span><span class="key">k</span><span class="key">l</span> focus</span>
      <span class="sep">│</span>
      <span class="shortcut"><span class="key">H</span><span class="key">J</span><span class="key">K</span><span class="key">L</span> move</span>
      <span class="sep">│</span>
      <span class="shortcut"><span class="key">t</span><span class="key">w</span> tab</span>
      <span class="sep">│</span>
      <span class="shortcut"><span class="key">N</span><span class="key">P</span> switch</span>
      <span class="sep">│</span>
      <span class="shortcut"><span class="key">s</span> shell</span>
      <span class="sep">│</span>
      <span class="shortcut"><span class="key">z</span> zoom</span>
      <span class="sep">│</span>
      <span class="shortcut"><span class="key">i</span> input</span>
      <span class="sep">│</span>
      <span class="shortcut"><span class="key">b</span> tree</span>
      <span class="sep">│</span>
      <span class="shortcut"><span class="key">d</span> debug</span>
      <span class="sep">│</span>
      <span class="shortcut"><span class="key">:</span> cmd</span>
      <span class="sep">│</span>
      <span class="shortcut"><span class="key">?</span> help</span>
    {:else}
      <span class="shortcut"><span class="key">Shift+Esc</span> back to cmd</span>
    {/if}
  </div>

  <div class="status-right">
  </div>
</div>

<style>
  .status-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 22px;
    background: var(--pcb-base);
    border-top: 1px solid var(--copper-dim);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px;
    z-index: 1000;
    user-select: none;
    -webkit-user-select: none;
    font-size: 10px;
  }

  .status-left, .status-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .status-center {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .mode-badge {
    padding: 1px 6px;
    font-size: 9px;
    letter-spacing: 1px;
    border: 1px solid;
  }

  .mode-badge.command {
    color: var(--phosphor-green);
    border-color: var(--phosphor-green-dim);
    background: rgba(51, 255, 51, 0.08);
  }

  .mode-badge.input {
    color: var(--phosphor-amber);
    border-color: var(--phosphor-amber-dim);
    background: rgba(255, 170, 0, 0.08);
  }

  .window-count {
    color: var(--silk-dim);
    font-size: 9px;
  }

  .shortcut {
    color: var(--silk-dim);
    font-size: 9px;
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .key {
    color: var(--phosphor-green);
    background: rgba(51, 255, 51, 0.06);
    border: 1px solid var(--component-border);
    padding: 0 3px;
    font-size: 9px;
    line-height: 1.4;
  }

  .sep {
    color: var(--component-border);
    font-size: 9px;
  }
</style>
