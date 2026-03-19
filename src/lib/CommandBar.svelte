<script lang="ts">
  import { commandBarOpen, commandText, executeCommandBarCommand } from './stores/appState';

  let inputRef = $state<HTMLInputElement>();

  async function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      commandBarOpen.set(false);
      commandText.set('');
      e.preventDefault();
    } else if (e.key === 'Enter') {
      await executeCommandBarCommand($commandText.trim());
      commandBarOpen.set(false);
      commandText.set('');
      e.preventDefault();
    }
  }

  $effect(() => {
    if ($commandBarOpen && inputRef) {
      inputRef.focus();
    }
  });
</script>

{#if $commandBarOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="command-bar" onkeydown={handleKeyDown}>
    <span class="prompt">:</span>
    <input
      bind:this={inputRef}
      bind:value={$commandText}
      class="command-input"
      spellcheck="false"
      autocomplete="off"
    />
  </div>
{/if}

<style>
  .command-bar {
    position: fixed;
    bottom: 22px;
    left: 0;
    right: 0;
    height: 24px;
    background: var(--pcb-dark);
    border-top: 1px solid var(--copper-dim);
    display: flex;
    align-items: center;
    padding: 0 8px;
    z-index: 1001;
  }

  .prompt {
    color: var(--phosphor-green);
    font-size: 13px;
    font-family: var(--font-mono);
    margin-right: 4px;
  }

  .command-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--phosphor-green);
    font-family: var(--font-mono);
    font-size: 12px;
    caret-color: var(--phosphor-green);
  }
</style>
