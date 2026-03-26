<script lang="ts">
  import { activeTabMinimizedDockItems, restoreMinimizedTile } from './stores/appState';
</script>

{#if $activeTabMinimizedDockItems.length > 0}
  <div class="minimized-tile-dock">
    {#each $activeTabMinimizedDockItems as item (item.tileId)}
      <button
        class="minimized-tile-button"
        class:selected={item.selected}
        type="button"
        data-minimized-tile-id={item.tileId}
        title={`Restore ${item.label}`}
        aria-label={`Restore ${item.label}`}
        onclick={() => restoreMinimizedTile(item.tileId)}
      >
        <span class="minimized-tile-badge">{item.badge}</span>
        <span class="minimized-tile-label">{item.label}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .minimized-tile-dock {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-end;
    pointer-events: none;
    z-index: 28;
  }

  .minimized-tile-button {
    min-width: 140px;
    max-width: 220px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border: 1px solid rgba(51, 255, 51, 0.2);
    background:
      linear-gradient(180deg, rgba(14, 24, 12, 0.96), rgba(8, 16, 7, 0.98));
    color: var(--silk-white);
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.5px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    pointer-events: auto;
    overflow: hidden;
  }

  .minimized-tile-button.selected {
    border-color: rgba(51, 255, 51, 0.46);
    box-shadow:
      0 0 0 1px rgba(51, 255, 51, 0.18),
      0 10px 28px rgba(0, 0, 0, 0.4);
  }

  .minimized-tile-button:hover {
    border-color: rgba(51, 255, 51, 0.38);
    transform: translateY(-1px);
  }

  .minimized-tile-badge {
    flex: 0 0 auto;
    padding: 2px 5px;
    border: 1px solid rgba(51, 255, 51, 0.16);
    background: rgba(51, 255, 51, 0.08);
    color: var(--phosphor-green);
    font-size: 8px;
    letter-spacing: 0.8px;
  }

  .minimized-tile-label {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
</style>
