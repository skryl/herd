<script lang="ts">
  import { parseAnsiPreview, type AnsiPreviewSegment } from './ansiPreview';
  import type { BrowserPreviewFormat } from './tauri';

  const DEFAULT_PREVIEW_HEIGHT = 136;
  const MIN_PREVIEW_HEIGHT = 88;
  const PREVIEW_FORMAT_BUTTONS: Array<{ value: BrowserPreviewFormat; label: string }> = [
    { value: 'text', label: 'Text' },
    { value: 'braille', label: 'Braille' },
    { value: 'ansi', label: 'ANSI' },
    { value: 'ascii', label: 'ASCII' },
  ];

  interface Props {
    text: string;
    loading: boolean;
    error?: string | null;
    format: BrowserPreviewFormat;
    columns: number;
    rows: number;
    refreshRateLabel: string;
    onSelectFormat: (format: BrowserPreviewFormat) => void;
    onCycleRefreshRate: () => void;
  }

  let {
    text,
    loading,
    error = null,
    format,
    columns,
    rows,
    refreshRateLabel,
    onSelectFormat,
    onCycleRefreshRate,
  }: Props = $props();
  let drawerRef = $state<HTMLDivElement>();
  let drawerHeight = $state(DEFAULT_PREVIEW_HEIGHT);
  let isResizing = false;
  let resizeStartY = 0;
  let resizeStartHeight = DEFAULT_PREVIEW_HEIGHT;
  let ansiLines = $derived(format === 'ansi' ? parseAnsiPreview(text) : []);

  function maxDrawerHeight() {
    const parentHeight = drawerRef?.parentElement instanceof HTMLElement
      ? drawerRef.parentElement.clientHeight - 28
      : window.innerHeight - 120;
    return Math.max(MIN_PREVIEW_HEIGHT, parentHeight);
  }

  function clampDrawerHeight(nextHeight: number) {
    return Math.max(MIN_PREVIEW_HEIGHT, Math.min(maxDrawerHeight(), nextHeight));
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

  function ansiSegmentStyle(segment: AnsiPreviewSegment) {
    const styles: string[] = [];
    if (segment.foreground) {
      styles.push(`color: ${segment.foreground}`);
    }
    if (segment.background) {
      styles.push(`background-color: ${segment.background}`);
    }
    return styles.join('; ');
  }
</script>

<svelte:window onmousemove={handleWindowMouseMove} onmouseup={handleWindowMouseUp} />

<div
  bind:this={drawerRef}
  class="browser-text-preview"
  data-preview-format={format}
  data-refresh-rate={refreshRateLabel}
  style={`height: ${drawerHeight}px; flex-basis: ${drawerHeight}px;`}
>
  <div class="preview-header">
    <div class="preview-header-left">
      <span class="preview-title">Preview</span>
      <div class="preview-format-group">
        {#each PREVIEW_FORMAT_BUTTONS as option}
          <button
            class="preview-format-toggle"
            class:active={format === option.value}
            data-format={option.value}
            type="button"
            aria-pressed={format === option.value}
            onclick={(event) => {
              event.stopPropagation();
              onSelectFormat(option.value);
            }}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="drawer-resize-grip" onmousedown={handleResizeMouseDown}>
      <span></span>
      <span></span>
      <span></span>
    </div>
    <div class="preview-header-right">
      <button
        class="preview-refresh-rate-btn"
        type="button"
        title="Cycle live preview refresh rate"
        aria-label="Cycle live preview refresh rate"
        onclick={(event) => {
          event.stopPropagation();
          onCycleRefreshRate();
        }}
      >
        {refreshRateLabel}
      </button>
      <span class="preview-meta">{columns}x{rows || 0}</span>
    </div>
  </div>
  <div class="preview-body">
    {#if text}
      {#if format === 'ansi'}
        <div class="preview-ansi">
          {#each ansiLines as line}
            <div class="preview-ansi-line">
              {#if line.length === 0}
                <span class="preview-ansi-empty"> </span>
              {:else}
                {#each line as segment}
                  <span
                    data-ansi-segment="true"
                    style={ansiSegmentStyle(segment)}
                  >{segment.text}</span>
                {/each}
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <pre class="preview-text">{text}</pre>
      {/if}
    {:else if loading}
      <div class="preview-empty">Loading live preview…</div>
    {:else if error}
      <div class="preview-empty error">{error}</div>
    {:else}
      <div class="preview-empty">No visible preview output</div>
    {/if}
  </div>
</div>

<style>
  .browser-text-preview {
    min-height: 0;
    margin: 0 8px 6px;
    border: 1px solid var(--preview-border, rgba(102, 225, 255, 0.22));
    background: var(--preview-bg, rgba(5, 12, 18, 0.98));
    display: flex;
    flex-direction: column;
  }

  .preview-header {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    color: var(--preview-accent, #66e1ff);
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    border-bottom: 1px solid var(--preview-border-soft, rgba(102, 225, 255, 0.18));
  }

  .preview-title {
    justify-self: start;
  }

  .preview-header-left,
  .preview-header-right {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .preview-header-right {
    justify-self: end;
  }

  .preview-format-group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .preview-format-toggle,
  .preview-refresh-rate-btn {
    height: 16px;
    padding: 0 6px;
    border: 1px solid var(--preview-border-soft, rgba(102, 225, 255, 0.18));
    background: rgba(0, 0, 0, 0.22);
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  .preview-format-toggle.active,
  .preview-format-toggle[aria-pressed='true'],
  .preview-format-toggle:hover,
  .preview-refresh-rate-btn:hover {
    border-color: var(--preview-accent, #66e1ff);
    background: color-mix(in srgb, var(--preview-accent, #66e1ff) 12%, rgba(0, 0, 0, 0.22));
  }

  .preview-meta {
    color: var(--preview-meta, rgba(102, 225, 255, 0.65));
    justify-self: end;
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

  .preview-body {
    flex: 1;
    overflow: auto;
    padding: 4px 6px 6px;
  }

  .preview-text {
    margin: 0;
    color: var(--preview-text, #d8f8ff);
    font-family: var(--font-mono);
    font-size: 8px;
    line-height: 1.25;
    white-space: pre;
  }

  .preview-ansi {
    color: var(--preview-text, #d8f8ff);
    font-family: var(--font-mono);
    font-size: 8px;
    line-height: 1.25;
    white-space: pre;
  }

  .preview-ansi-line {
    min-height: calc(8px * 1.25);
  }

  .preview-ansi-empty {
    opacity: 0;
  }

  .preview-empty {
    color: var(--preview-empty, rgba(102, 225, 255, 0.62));
    font-family: var(--font-mono);
    font-size: 9px;
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .preview-empty.error {
    color: #ff8a8a;
  }
</style>
