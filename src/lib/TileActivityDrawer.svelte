<script lang="ts">
  import type { TileActivityEntry } from './types';

  interface Props {
    entries: TileActivityEntry[];
    emptyText?: string;
  }

  let { entries, emptyText = 'No activity yet' }: Props = $props();
  let bodyRef = $state<HTMLDivElement>();

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (bodyRef) {
        bodyRef.scrollTop = bodyRef.scrollHeight;
      }
    });
  }

  $effect(() => {
    entries.length;
    scrollToBottom();
  });
</script>

<div class="tile-activity">
  <div class="activity-header">Activity</div>
  <div class="activity-body" bind:this={bodyRef}>
    {#if entries.length === 0}
      <div class="activity-line empty">{emptyText}</div>
    {:else}
      {#each entries as entry, index (`${entry.timestamp_ms}:${index}`)}
        <div class="activity-line">{entry.text}</div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .tile-activity {
    flex: 0 0 96px;
    min-height: 0;
    margin: 0 8px 6px;
    border: 1px solid var(--activity-border, rgba(242, 176, 90, 0.22));
    background: var(--activity-bg, rgba(8, 14, 8, 0.95));
    display: flex;
    flex-direction: column;
  }

  .activity-header {
    padding: 4px 6px;
    color: var(--activity-accent, var(--copper));
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    border-bottom: 1px solid var(--activity-border-soft, rgba(242, 176, 90, 0.18));
  }

  .activity-body {
    flex: 1;
    overflow-y: auto;
    padding: 4px 6px 6px;
    font-family: var(--font-mono);
    font-size: 9px;
    line-height: 1.45;
  }

  .activity-line {
    color: var(--activity-text, var(--silk-dim));
    white-space: pre-wrap;
    word-break: break-word;
  }

  .activity-line.empty {
    color: var(--activity-empty, var(--copper-dim));
  }
</style>
