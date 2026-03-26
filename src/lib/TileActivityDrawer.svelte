<script lang="ts">
  import type { TileActivityEntry } from './types';

  const DEFAULT_ACTIVITY_HEIGHT = 96;
  const MIN_ACTIVITY_HEIGHT = 72;

  interface Props {
    entries: TileActivityEntry[];
    fillAvailableSpace?: boolean;
    emptyText?: string;
  }

  let { entries, fillAvailableSpace = false, emptyText = 'No activity yet' }: Props = $props();
  let drawerRef = $state<HTMLDivElement>();
  let bodyRef = $state<HTMLDivElement>();
  let drawerHeight = $state(DEFAULT_ACTIVITY_HEIGHT);
  let isResizing = false;
  let resizeStartY = 0;
  let resizeStartHeight = DEFAULT_ACTIVITY_HEIGHT;

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (bodyRef) {
        bodyRef.scrollTop = bodyRef.scrollHeight;
      }
    });
  }

  function maxDrawerHeight() {
    const parentHeight = drawerRef?.parentElement instanceof HTMLElement
      ? drawerRef.parentElement.clientHeight - 28
      : window.innerHeight - 120;
    return Math.max(MIN_ACTIVITY_HEIGHT, parentHeight);
  }

  function clampDrawerHeight(nextHeight: number) {
    return Math.max(MIN_ACTIVITY_HEIGHT, Math.min(maxDrawerHeight(), nextHeight));
  }

  function handleResizeMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    isResizing = true;
    resizeStartY = event.clientY;
    resizeStartHeight = drawerHeight;
    event.preventDefault();
    event.stopPropagation();
  }

  function handleWindowMouseMove(event: MouseEvent) {
    if (!isResizing) return;
    const dy = event.clientY - resizeStartY;
    drawerHeight = clampDrawerHeight(resizeStartHeight - dy);
  }

  function handleWindowMouseUp() {
    if (!isResizing) return;
    isResizing = false;
  }

  $effect(() => {
    entries.length;
    scrollToBottom();
  });
</script>

<svelte:window onmousemove={handleWindowMouseMove} onmouseup={handleWindowMouseUp} />

<div
  bind:this={drawerRef}
  class="tile-activity"
  style={fillAvailableSpace
    ? `min-height: ${MIN_ACTIVITY_HEIGHT}px; flex: 1 1 ${drawerHeight}px;`
    : `height: ${drawerHeight}px; flex-basis: ${drawerHeight}px;`}
>
  <div class="activity-header">
    <span class="activity-title">Activity</span>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="drawer-resize-grip" onmousedown={handleResizeMouseDown}>
      <span></span>
      <span></span>
      <span></span>
    </div>
    <span class="drawer-header-spacer" aria-hidden="true"></span>
  </div>
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
    min-height: 0;
    margin: 0 8px 6px;
    border: 1px solid var(--activity-border, rgba(242, 176, 90, 0.22));
    background: var(--activity-bg, rgba(8, 14, 8, 0.95));
    display: flex;
    flex-direction: column;
  }

  .activity-header {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    color: var(--activity-accent, var(--copper));
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    border-bottom: 1px solid var(--activity-border-soft, rgba(242, 176, 90, 0.18));
  }

  .activity-title {
    justify-self: start;
  }

  .drawer-header-spacer {
    justify-self: stretch;
  }

  .drawer-resize-grip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    cursor: ns-resize;
    padding: 2px 6px;
    user-select: none;
    -webkit-user-select: none;
    justify-self: center;
  }

  .drawer-resize-grip span {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.8;
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
