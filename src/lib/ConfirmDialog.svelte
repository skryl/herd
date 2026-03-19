<script lang="ts">
  import { closeTabConfirmation, dispatchIntent } from './stores/appState';
</script>

{#if $closeTabConfirmation}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="confirm-overlay" onclick={() => void dispatchIntent({ type: 'cancel-close-active-tab' })}>
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="confirm-pane" onclick={(e) => e.stopPropagation()}>
      <div class="confirm-title">CLOSE TAB</div>
      <div class="confirm-message">
        Close "{$closeTabConfirmation.sessionName}" and kill {$closeTabConfirmation.paneCount} panes?
      </div>
      <div class="confirm-actions">
        <button class="confirm-button" onclick={() => void dispatchIntent({ type: 'cancel-close-active-tab' })}>
          Cancel
        </button>
        <button class="confirm-button danger" onclick={() => void dispatchIntent({ type: 'confirm-close-active-tab' })}>
          Close Tab
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 2200;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .confirm-pane {
    width: min(420px, calc(100vw - 32px));
    background: var(--pcb-base);
    border: 1px solid var(--phosphor-red-dim);
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.8);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .confirm-title {
    color: var(--phosphor-red);
    font-size: 11px;
    letter-spacing: 2px;
  }

  .confirm-message {
    color: var(--silk-dim);
    font-size: 11px;
    line-height: 1.5;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm-button {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--component-border);
    color: var(--silk-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 6px 10px;
    cursor: pointer;
  }

  .confirm-button:hover {
    color: var(--phosphor-green);
    border-color: var(--phosphor-green-dim);
  }

  .confirm-button.danger {
    color: var(--phosphor-red);
    border-color: var(--phosphor-red-dim);
    background: rgba(255, 64, 64, 0.08);
  }

  .confirm-button.danger:hover {
    color: var(--phosphor-red);
    border-color: var(--phosphor-red);
  }
</style>
