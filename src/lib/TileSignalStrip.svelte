<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import { parseAnsiPreview, type AnsiPreviewSegment } from './ansiPreview';
  import type { TileSignalLed, TileSignalState } from './types';

  const DEFAULT_LED_COUNT = 8;
  const MARQUEE_GAP_PX = 32;
  const MARQUEE_SPEED_PX_PER_SEC = 40;

  interface Props {
    signal?: TileSignalState | null;
    showLeds?: boolean;
    showStatus?: boolean;
    compactLeds?: boolean;
    defaultStatusText?: string;
  }

  let {
    signal = null,
    showLeds = true,
    showStatus = true,
    compactLeds = false,
    defaultStatusText = '',
  }: Props = $props();
  let viewportRef = $state<HTMLDivElement>();
  let measureRef = $state<HTMLDivElement>();
  let resizeObserver: ResizeObserver | null = null;
  let measureFrame: number | null = null;
  let marqueeActive = $state(false);
  let marqueeDistance = $state(0);
  let marqueeDurationSeconds = $state(1);

  function defaultLeds(): TileSignalLed[] {
    return Array.from({ length: DEFAULT_LED_COUNT }, (_, index) => ({
      index: index + 1,
      on: false,
      color: null,
    }));
  }

  function resolvedLeds(leds: TileSignalLed[] | null | undefined): TileSignalLed[] {
    if (!leds || leds.length !== DEFAULT_LED_COUNT) {
      return defaultLeds();
    }
    const sorted = [...leds].sort((left, right) => left.index - right.index);
    return sorted.every((led, index) => led.index === index + 1) ? sorted : defaultLeds();
  }

  let ledStates = $derived(resolvedLeds(signal?.leds));
  let customStatusText = $derived(signal?.status_text ?? '');
  let statusText = $derived(customStatusText || defaultStatusText);
  let statusSegments = $derived(parseAnsiPreview(statusText)[0] ?? []);

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

  function queueMeasure() {
    if (!showStatus) {
      marqueeActive = false;
      marqueeDistance = 0;
      marqueeDurationSeconds = 1;
      return;
    }
    if (measureFrame !== null) {
      cancelAnimationFrame(measureFrame);
    }
    measureFrame = requestAnimationFrame(() => {
      measureFrame = null;
      const viewportWidth = viewportRef?.clientWidth ?? 0;
      const contentWidth = measureRef?.scrollWidth ?? 0;
      marqueeActive = Boolean(statusText && viewportWidth > 0 && contentWidth > viewportWidth + 1);
      marqueeDistance = contentWidth + MARQUEE_GAP_PX;
      marqueeDurationSeconds = Math.max(1, marqueeDistance / MARQUEE_SPEED_PX_PER_SEC);
    });
  }

  $effect(() => {
    signal?.updated_at;
    showStatus;
    statusText;
    statusSegments.length;
    queueMeasure();
  });

  onMount(() => {
    resizeObserver = new ResizeObserver(() => {
      queueMeasure();
    });
    if (viewportRef) {
      resizeObserver.observe(viewportRef);
    }
    if (measureRef) {
      resizeObserver.observe(measureRef);
    }
    queueMeasure();
  });

  onDestroy(() => {
    if (measureFrame !== null) {
      cancelAnimationFrame(measureFrame);
    }
    resizeObserver?.disconnect();
  });
</script>

<div
  class="tile-signal-strip"
  data-show-leds={showLeds ? 'true' : 'false'}
  data-show-status={showStatus ? 'true' : 'false'}
  data-compact-leds={compactLeds ? 'true' : 'false'}
>
  {#if showLeds}
    <div class="tile-signal-led-bar" aria-label="Tile signal LEDs">
      {#each ledStates as led}
        <span
          class="tile-signal-led"
          data-led-index={led.index}
          data-on={led.on ? 'true' : 'false'}
          data-color={led.color ?? ''}
          style={led.on && led.color ? `--tile-signal-color: ${led.color};` : ''}
        ></span>
      {/each}
    </div>
  {/if}
  {#if showStatus}
    <div class="tile-signal-status" data-marquee-active={marqueeActive ? 'true' : 'false'}>
      <div bind:this={viewportRef} class="tile-signal-status-viewport">
        {#if marqueeActive}
          <div
            class="tile-signal-status-marquee"
            style={`--tile-signal-distance: ${marqueeDistance}px; --tile-signal-duration: ${marqueeDurationSeconds}s; --tile-signal-gap: ${MARQUEE_GAP_PX}px;`}
          >
            <div class="tile-signal-status-line">
              {#if statusSegments.length === 0}
                <span class="tile-signal-status-empty"> </span>
              {:else}
                {#each statusSegments as segment}
                  <span data-ansi-segment="true" style={ansiSegmentStyle(segment)}>{segment.text}</span>
                {/each}
              {/if}
            </div>
            <div class="tile-signal-status-gap" aria-hidden="true"></div>
            <div class="tile-signal-status-line" aria-hidden="true">
              {#if statusSegments.length === 0}
                <span class="tile-signal-status-empty"> </span>
              {:else}
                {#each statusSegments as segment}
                  <span data-ansi-segment="true" style={ansiSegmentStyle(segment)}>{segment.text}</span>
                {/each}
              {/if}
            </div>
          </div>
        {:else}
          <div class="tile-signal-status-line">
            {#if statusSegments.length === 0}
              <span class="tile-signal-status-empty"> </span>
            {:else}
              {#each statusSegments as segment}
                <span data-ansi-segment="true" style={ansiSegmentStyle(segment)}>{segment.text}</span>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
      <div class="tile-signal-status-measure" bind:this={measureRef} aria-hidden="true">
        {#if statusSegments.length === 0}
          <span class="tile-signal-status-empty"> </span>
        {:else}
          {#each statusSegments as segment}
            <span data-ansi-segment="true" style={ansiSegmentStyle(segment)}>{segment.text}</span>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .tile-signal-strip {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .tile-signal-strip[data-show-leds='true'][data-show-status='true'] {
    gap: 8px;
    flex: 1;
  }

  .tile-signal-strip[data-show-leds='true'][data-show-status='false'] {
    gap: 6px;
    flex: 0 0 auto;
  }

  .tile-signal-strip[data-show-leds='false'][data-show-status='true'] {
    gap: 0;
    flex: 1 1 auto;
    width: 100%;
  }

  .tile-signal-led-bar {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .tile-signal-strip[data-compact-leds='true'] .tile-signal-led-bar {
    gap: 3px;
  }

  .tile-signal-led {
    width: 10px;
    height: 4px;
    border-radius: 999px;
    background: rgba(120, 132, 118, 0.18);
    border: 1px solid rgba(120, 132, 118, 0.18);
    box-shadow: inset 0 0 3px rgba(0, 0, 0, 0.35);
  }

  .tile-signal-strip[data-compact-leds='true'] .tile-signal-led {
    width: 8px;
    height: 3px;
  }

  .tile-signal-led[data-on='true'] {
    background: var(--tile-signal-color, var(--phosphor-green));
    border-color: color-mix(in srgb, var(--tile-signal-color, var(--phosphor-green)) 70%, rgba(255, 255, 255, 0.18));
    box-shadow:
      0 0 8px color-mix(in srgb, var(--tile-signal-color, var(--phosphor-green)) 60%, transparent),
      inset 0 0 4px rgba(255, 255, 255, 0.2);
  }

  .tile-signal-status {
    position: relative;
    min-width: 0;
    flex: 1;
  }

  .tile-signal-status-viewport {
    overflow: hidden;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 8px;
    line-height: 1;
    letter-spacing: 0.35px;
    color: var(--silk-dim);
    white-space: nowrap;
  }

  .tile-signal-status-line,
  .tile-signal-status-measure {
    display: inline-flex;
    align-items: center;
    gap: 0;
    white-space: pre;
  }

  .tile-signal-status-empty {
    opacity: 0;
  }

  .tile-signal-status-marquee {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
    will-change: transform;
    animation: tile-signal-marquee var(--tile-signal-duration) linear infinite;
  }

  .tile-signal-status-gap {
    width: var(--tile-signal-gap);
    flex-shrink: 0;
  }

  .tile-signal-status-measure {
    position: absolute;
    left: 0;
    top: 0;
    visibility: hidden;
    pointer-events: none;
  }

  @keyframes tile-signal-marquee {
    from {
      transform: translateX(0);
    }
    to {
      transform: translateX(calc(-1px * var(--tile-signal-distance)));
    }
  }
</style>
