<script lang="ts">
  import { parseAnsiPreview } from './ansiPreview';

  const DEFAULT_DISPLAY_HEIGHT = 140;
  const MIN_DISPLAY_HEIGHT = 88;

  interface Props {
    text: string;
    columns: number;
    rows: number;
    fillAvailableSpace?: boolean;
    emptyText?: string;
  }

  let {
    text,
    columns,
    rows,
    fillAvailableSpace = false,
    emptyText = 'No display frame yet',
  }: Props = $props();
  let drawerRef = $state<HTMLDivElement>();
  let drawerHeight = $state(DEFAULT_DISPLAY_HEIGHT);
  let isResizing = false;
  let resizeStartY = 0;
  let resizeStartHeight = DEFAULT_DISPLAY_HEIGHT;
  let ansiLines = $derived(parseAnsiPreview(text));

  function maxDrawerHeight() {
    const parentHeight = drawerRef?.parentElement instanceof HTMLElement
      ? drawerRef.parentElement.clientHeight - 28
      : window.innerHeight - 120;
    return Math.max(MIN_DISPLAY_HEIGHT, parentHeight);
  }

  function clampDrawerHeight(nextHeight: number) {
    return Math.max(MIN_DISPLAY_HEIGHT, Math.min(maxDrawerHeight(), nextHeight));
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
</script>

<svelte:window onmousemove={handleWindowMouseMove} onmouseup={handleWindowMouseUp} />

<div
  bind:this={drawerRef}
  class="terminal-display"
  data-display-columns={columns}
  data-display-rows={rows}
  style={fillAvailableSpace
    ? `min-height: ${MIN_DISPLAY_HEIGHT}px; flex: 1 1 ${drawerHeight}px;`
    : `height: ${drawerHeight}px; flex-basis: ${drawerHeight}px;`}
>
  <div class="display-header">
    <div class="display-header-left">
      <span class="display-title">Display</span>
      {#if columns > 0 && rows > 0}
        <span class="display-meta">{columns}x{rows}</span>
      {/if}
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="drawer-resize-grip" onmousedown={handleResizeMouseDown}>
      <span></span>
      <span></span>
      <span></span>
    </div>
    <span class="display-header-spacer" aria-hidden="true"></span>
  </div>
  <div class="terminal-display-body">
    {#if text}
      <div class="terminal-display-frame">
        <div class="terminal-display-ansi">
          {#each ansiLines as line}
            <div class="terminal-display-ansi-line">
              {#if line.length === 0}
                <span class="terminal-display-ansi-empty"> </span>
              {:else}
                {#each line as segment}
                  <span
                    data-ansi-segment="true"
                    style={`color: ${segment.foreground ?? 'inherit'}; background-color: ${segment.background ?? 'transparent'};`}
                  >{segment.text}</span>
                {/each}
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="terminal-display-empty">{emptyText}</div>
    {/if}
  </div>
</div>

<style>
  .terminal-display {
    min-height: 0;
    margin: 0 8px 6px;
    border: 1px solid var(--display-border, rgba(242, 176, 90, 0.24));
    background: var(--display-bg, rgba(7, 10, 12, 0.96));
    display: flex;
    flex-direction: column;
  }

  .display-header {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    color: var(--display-accent, var(--copper));
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    border-bottom: 1px solid var(--display-border-soft, rgba(242, 176, 90, 0.16));
  }

  .display-header-left {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .display-meta {
    color: var(--display-meta, var(--silk-dim));
  }

  .display-header-spacer {
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

  .terminal-display-body {
    flex: 1;
    overflow: auto;
    padding: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .terminal-display-frame {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 10px 12px;
    border: 1px solid rgba(242, 176, 90, 0.18);
    background:
      linear-gradient(180deg, rgba(8, 15, 8, 0.96), rgba(4, 9, 4, 0.98)),
      radial-gradient(circle at top, rgba(51, 255, 51, 0.08), transparent 58%);
    box-shadow: inset 0 0 18px rgba(51, 255, 51, 0.06);
  }

  .terminal-display-ansi {
    color: var(--display-text, #dff6de);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1.2;
    white-space: pre;
  }

  .terminal-display-ansi-line {
    min-height: calc(10px * 1.2);
  }

  .terminal-display-ansi-empty {
    opacity: 0;
  }

  .terminal-display-empty {
    color: var(--display-empty, rgba(242, 176, 90, 0.62));
    font-family: var(--font-mono);
    font-size: 9px;
    line-height: 1.45;
    white-space: pre-wrap;
    text-align: center;
  }
</style>
