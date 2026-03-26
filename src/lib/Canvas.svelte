<script lang="ts">
  import BrowserTile from './BrowserTile.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import MinimizedTileDock from './MinimizedTileDock.svelte';
  import TerminalTile from './TerminalTile.svelte';
  import WorkCard from './WorkCard.svelte';
  import type { TileMessageLogEntry, TilePort } from './types';
  import { simplePortCurvePath } from './wireCurves';
  import {
    activeNetworkDrag,
    appState,
    activeTabConnections,
    activeTabWorkCards,
    activeSessionWorkItems,
    activeTabTerminals,
    activeTabVisibleTerminals,
    activeTabVisibleWorkCards,
    buildNetworkCallSignals,
    canvasState,
    clearNetworkReleaseAnimation,
    completeNetworkPortDrag,
    debugPaneHeight,
    debugPaneOpen,
    dismissContextMenu,
    mode,
    networkReleaseAnimation,
    openCanvasContextMenu,
    panCanvasBy,
    sidebarOpen,
    suspendBrowserWebviewsForMotion,
    type NetworkCallSignal,
    updateNetworkPortDrag,
    visibleActiveTabNetworkConnections,
    wheelCanvas,
  } from './stores/appState';

  let isPanning = false;
  let lastX = 0;
  let lastY = 0;
  let viewportRef = $state<HTMLDivElement | null>(null);
  let cursorWorldX = $state(0);
  let cursorWorldY = $state(0);
  let workCardLayouts = $derived(new Map($activeTabVisibleWorkCards.map((card) => [card.workId, card])));
  let releaseAnimationProgress = $state(1);
  let networkCallSignals = $state<NetworkCallSignal[]>([]);
  let effectiveSidebarWidth = $derived($sidebarOpen ? 240 : 0);
  let effectiveDebugHeight = $derived(
    $debugPaneOpen && Number.isFinite($debugPaneHeight) && $debugPaneHeight > 0 ? $debugPaneHeight : 0,
  );

  const NETWORK_RELEASE_DURATION_MS = 180;
  const NETWORK_SIGNAL_REMOVE_BUFFER_MS = 120;
  const seenNetworkCallLogKeysBySession = new Map<string, Set<string>>();
  const networkSignalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let networkSignalSessionId: string | null = null;

  function draftTargetPort() {
    const drag = $activeNetworkDrag;
    if (!drag) return 'right' as TilePort;
    if (drag.snappedPort) return drag.snappedPort;
    const dx = (drag.snappedX ?? drag.currentX) - drag.startX;
    const dy = (drag.snappedY ?? drag.currentY) - drag.startY;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? 'left' : 'right';
    }
    return dy >= 0 ? 'top' : 'bottom';
  }

  function easedReleaseProgress(progress: number) {
    return 1 - (1 - progress) ** 3;
  }

  function clearNetworkSignalTimers() {
    for (const timer of networkSignalTimers.values()) {
      clearTimeout(timer);
    }
    networkSignalTimers.clear();
  }

  function clearActiveNetworkCallSignals() {
    clearNetworkSignalTimers();
    networkCallSignals = [];
  }

  function networkCallLogKey(entry: TileMessageLogEntry, index: number) {
    return [
      entry.session_id,
      entry.timestamp_ms,
      entry.caller_tile_id ?? '-',
      entry.target_id,
      entry.message_name,
      entry.wrapper_command,
      entry.channel,
      index,
    ].join(':');
  }

  $effect(() => {
    const animation = $networkReleaseAnimation;
    if (!animation) {
      releaseAnimationProgress = 1;
      return;
    }

    releaseAnimationProgress = 0;
    let frame = 0;
    const startedAt = performance.now();

    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / NETWORK_RELEASE_DURATION_MS);
      releaseAnimationProgress = progress;
      if (progress >= 1) {
        clearNetworkReleaseAnimation();
        return;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  });

  $effect(() => {
    const state = $appState;
    const activeSessionId = state.tmux.activeSessionId;

    if (!activeSessionId) {
      networkSignalSessionId = null;
      clearActiveNetworkCallSignals();
      return;
    }

    const currentLogs = state.tileMessageLogs.filter(
      (entry) =>
        entry.session_id === activeSessionId
        && entry.layer === 'network'
        && entry.wrapper_command === 'network_call'
        && entry.outcome === 'ok'
        && Boolean(entry.caller_tile_id)
        && Boolean(entry.target_id),
    );

    if (networkSignalSessionId !== activeSessionId) {
      networkSignalSessionId = activeSessionId;
      clearActiveNetworkCallSignals();
      seenNetworkCallLogKeysBySession.set(
        activeSessionId,
        new Set(currentLogs.map((entry, index) => networkCallLogKey(entry, index))),
      );
      return;
    }

    let seenLogKeys = seenNetworkCallLogKeysBySession.get(activeSessionId);
    if (!seenLogKeys) {
      seenLogKeys = new Set<string>();
      seenNetworkCallLogKeysBySession.set(activeSessionId, seenLogKeys);
    }

    const unseenEntries: TileMessageLogEntry[] = [];
    for (const [index, entry] of currentLogs.entries()) {
      const key = networkCallLogKey(entry, index);
      if (seenLogKeys.has(key)) {
        continue;
      }
      seenLogKeys.add(key);
      unseenEntries.push(entry);
    }

    if (unseenEntries.length === 0) {
      return;
    }

    const nextSignals = buildNetworkCallSignals(state, unseenEntries);
    if (nextSignals.length === 0) {
      return;
    }

    networkCallSignals = [...networkCallSignals, ...nextSignals];
    for (const signal of nextSignals) {
      const timer = setTimeout(() => {
        networkSignalTimers.delete(signal.id);
        networkCallSignals = networkCallSignals.filter((candidate) => candidate.id !== signal.id);
      }, signal.totalDurationMs + NETWORK_SIGNAL_REMOVE_BUFFER_MS);
      networkSignalTimers.set(signal.id, timer);
    }
  });

  $effect(() => {
    return () => {
      clearNetworkSignalTimers();
    };
  });

  function handleWheel(e: WheelEvent) {
    if ($mode === 'input') {
      return;
    }
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    wheelCanvas(e.deltaY, e.clientX - rect.left, e.clientY - rect.top);
  }

  function handleMouseDown(e: MouseEvent) {
    if (e.button === 0) {
      dismissContextMenu();
    }
    if (e.button === 0 || e.button === 1) {
      isPanning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      suspendBrowserWebviewsForMotion();
      e.preventDefault();
    }
  }

  function updateCanvasPointer(clientX: number, clientY: number) {
    if (!viewportRef) {
      return null;
    }

    const state = $canvasState;
    const rect = viewportRef.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    cursorWorldX = Math.round((localX - state.panX) / state.zoom);
    cursorWorldY = Math.round((localY - state.panY) / state.zoom);
    updateNetworkPortDrag(localX, localY);
    return { localX, localY };
  }

  function handleMouseMove(e: MouseEvent) {
    updateCanvasPointer(e.clientX, e.clientY);

    if (!isPanning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    panCanvasBy(dx, dy);
  }

  function handleWindowMouseMove(e: MouseEvent) {
    if (!$activeNetworkDrag && !isPanning) {
      return;
    }

    const target = e.target;
    if (viewportRef && target instanceof Node && viewportRef.contains(target)) {
      return;
    }

    updateCanvasPointer(e.clientX, e.clientY);

    if (!isPanning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    panCanvasBy(dx, dy);
  }

  function handleMouseUp() {
    isPanning = false;
    void completeNetworkPortDrag();
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openCanvasContextMenu(e.clientX - rect.left, e.clientY - rect.top);
  }
</script>

<svelte:window onmousemove={handleWindowMouseMove} onmouseup={handleMouseUp} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={viewportRef}
  class="canvas-viewport"
  style={`left: ${effectiveSidebarWidth}px; bottom: ${22 + effectiveDebugHeight}px;`}
  onwheel={handleWheel}
  onmousedown={handleMouseDown}
  onmousemove={handleMouseMove}
  oncontextmenu={handleContextMenu}
>
  <div class="pcb-grid"></div>

  <div
    class="canvas-world"
    style="transform: translate({$canvasState.panX}px, {$canvasState.panY}px) scale({$canvasState.zoom})"
  >
    {#if $activeTabConnections.length > 0}
      <svg class="connections-svg">
        {#each $activeTabConnections as conn (conn.childWindowId)}
          <path
            d={conn.path}
            class="conn-line"
          />
          <circle cx={conn.x1} cy={conn.y1} r="3" class="conn-dot-parent" />
          <circle cx={conn.x2} cy={conn.y2} r="3" class="conn-dot" />
        {/each}
      </svg>
    {/if}

    {#if $visibleActiveTabNetworkConnections.length > 0}
      <svg class="network-svg">
        {#each $visibleActiveTabNetworkConnections as conn (`${conn.fromTileId}:${conn.fromPort}-${conn.toTileId}:${conn.toPort}`)}
          <path
            d={conn.path}
            class="network-line"
            class:network-line-read-only={conn.wireMode === 'read_only'}
            class:network-line-full-duplex={conn.wireMode === 'full_duplex'}
          />
          <circle
            cx={conn.x1}
            cy={conn.y1}
            r="4"
            class="network-dot"
            class:network-dot-read-only={conn.wireMode === 'read_only'}
            class:network-dot-full-duplex={conn.wireMode === 'full_duplex'}
          />
          <circle
            cx={conn.x2}
            cy={conn.y2}
            r="4"
            class="network-dot"
            class:network-dot-read-only={conn.wireMode === 'read_only'}
            class:network-dot-full-duplex={conn.wireMode === 'full_duplex'}
          />
        {/each}
        {#each networkCallSignals as signal (signal.id)}
          {#each signal.segments as segment (segment.id)}
            <path
              d={segment.path}
              class="network-signal-line"
              class:network-signal-line-read-only={segment.wireMode === 'read_only'}
              class:network-signal-line-full-duplex={segment.wireMode === 'full_duplex'}
              data-from-tile-id={signal.fromTileId}
              data-to-tile-id={signal.toTileId}
              data-connection-key={segment.connectionKey}
              style={`animation-delay: ${segment.delayMs}ms; animation-duration: ${segment.durationMs}ms;`}
            />
            <circle
              r="4.5"
              class="network-signal-dot"
              class:network-signal-dot-read-only={segment.wireMode === 'read_only'}
              class:network-signal-dot-full-duplex={segment.wireMode === 'full_duplex'}
              data-from-tile-id={signal.fromTileId}
              data-to-tile-id={signal.toTileId}
              data-connection-key={segment.connectionKey}
              style={`animation-delay: ${segment.delayMs}ms; animation-duration: ${segment.durationMs}ms;`}
            >
              <animateMotion
                begin={`${segment.delayMs}ms`}
                dur={`${segment.durationMs}ms`}
                path={segment.motionPath}
                fill="freeze"
                rotate="auto"
              />
            </circle>
          {/each}
        {/each}
      </svg>
    {/if}

    <div class="origin-mark">
      <div class="origin-h"></div>
      <div class="origin-v"></div>
      <span class="origin-label">0,0</span>
    </div>

    {#each $activeTabVisibleTerminals as term (term.id)}
      {#if term.kind !== 'browser'}
        <TerminalTile info={term} />
      {/if}
    {/each}

    {#each $activeSessionWorkItems as item (item.work_id)}
      {@const layout = workCardLayouts.get(item.work_id)}
      {#if layout}
        <WorkCard {item} {layout} />
      {/if}
    {/each}
  </div>

  <div class="browser-tile-overlay-layer">
    {#each $activeTabVisibleTerminals as term (term.id)}
      {#if term.kind === 'browser'}
        <BrowserTile info={term} />
      {/if}
    {/each}
  </div>

  <MinimizedTileDock />

  {#if $activeNetworkDrag}
    <svg class="network-draft-svg">
      <path
        d={simplePortCurvePath(
          { x: $activeNetworkDrag.startX, y: $activeNetworkDrag.startY },
          $activeNetworkDrag.port,
          { x: $activeNetworkDrag.snappedX ?? $activeNetworkDrag.currentX, y: $activeNetworkDrag.snappedY ?? $activeNetworkDrag.currentY },
          draftTargetPort(),
        )}
        class="network-draft-line"
      />
      <circle
        cx={$activeNetworkDrag.startX}
        cy={$activeNetworkDrag.startY}
        r="4"
        class="network-dot"
      />
      <circle
        cx={$activeNetworkDrag.snappedX ?? $activeNetworkDrag.currentX}
        cy={$activeNetworkDrag.snappedY ?? $activeNetworkDrag.currentY}
        r="4"
        class="network-dot"
      />
    </svg>
  {/if}

  {#if $networkReleaseAnimation}
    {@const retract = easedReleaseProgress(releaseAnimationProgress)}
    {@const looseX = $networkReleaseAnimation.looseX + ($networkReleaseAnimation.anchorX - $networkReleaseAnimation.looseX) * retract}
    {@const looseY = $networkReleaseAnimation.looseY + ($networkReleaseAnimation.anchorY - $networkReleaseAnimation.looseY) * retract}
    <svg class="network-draft-svg">
      <path
        d={simplePortCurvePath(
          { x: $networkReleaseAnimation.anchorX, y: $networkReleaseAnimation.anchorY },
          $networkReleaseAnimation.anchorPort,
          { x: looseX, y: looseY },
          $networkReleaseAnimation.loosePort,
        )}
        class="network-release-line"
        style={`opacity: ${1 - releaseAnimationProgress};`}
      />
      <circle
        cx={$networkReleaseAnimation.anchorX}
        cy={$networkReleaseAnimation.anchorY}
        r="4"
        class="network-dot"
        style={`opacity: ${1 - releaseAnimationProgress * 0.35};`}
      />
      <circle
        cx={looseX}
        cy={looseY}
        r="4"
        class="network-dot network-release-dot"
        style={`opacity: ${1 - releaseAnimationProgress};`}
      />
    </svg>
  {/if}

  <ContextMenu />

  <div class="coord-readout">
    <span class="coord-label">POS</span>
    <span class="coord-value">X:{cursorWorldX} Y:{cursorWorldY}</span>
  </div>
</div>

<style>
  .canvas-viewport {
    position: fixed;
    top: var(--toolbar-height);
    left: 0;
    right: 0;
    bottom: 22px;
    transition: left 0.15s, bottom 0.15s;
    overflow: hidden;
    background: var(--pcb-dark);
    cursor: crosshair;
  }

  .canvas-viewport:active {
    cursor: grabbing;
  }

  .pcb-grid {
    position: absolute;
    inset: 0;
    background-image: radial-gradient(circle, var(--grid-dot) 1px, transparent 1px);
    background-size: 20px 20px;
    pointer-events: none;
  }

  .canvas-world {
    transform-origin: 0 0;
    position: absolute;
    top: 0;
    left: 0;
  }

  .connections-svg {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
  }

  .browser-tile-overlay-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 20;
  }

  .network-svg {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
  }

  .conn-line {
    fill: none;
    stroke: rgba(242, 176, 90, 0.58);
    stroke-width: 2;
    stroke-dasharray: 7 5;
    filter: drop-shadow(0 0 5px rgba(242, 176, 90, 0.28));
  }

  .conn-dot,
  .conn-dot-parent {
    pointer-events: none;
  }

  .conn-dot {
    fill: rgba(242, 176, 90, 0.95);
  }

  .conn-dot-parent {
    fill: rgba(120, 229, 164, 0.95);
  }

  .network-line {
    fill: none;
    stroke-width: 2.5;
  }

  .network-line-read-only {
    stroke: rgba(92, 200, 255, 0.8);
    filter: drop-shadow(0 0 6px rgba(92, 200, 255, 0.28));
  }

  .network-dot-read-only {
    fill: rgba(92, 200, 255, 0.96);
  }

  .network-line-full-duplex {
    stroke: rgba(240, 184, 92, 0.82);
    filter: drop-shadow(0 0 6px rgba(240, 184, 92, 0.28));
  }

  .network-dot-full-duplex {
    fill: rgba(247, 203, 136, 0.96);
  }

  .network-draft-svg {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: visible;
    z-index: 50;
  }

  .network-signal-line {
    fill: none;
    stroke-width: 5;
    stroke-linecap: round;
    opacity: 0;
    animation-name: network-signal-line-pulse;
    animation-timing-function: ease-out;
    animation-fill-mode: both;
    pointer-events: none;
  }

  .network-signal-line-read-only {
    stroke: rgba(140, 236, 255, 0.96);
    filter: drop-shadow(0 0 10px rgba(92, 200, 255, 0.6));
  }

  .network-signal-line-full-duplex {
    stroke: rgba(255, 221, 130, 0.96);
    filter: drop-shadow(0 0 10px rgba(240, 184, 92, 0.55));
  }

  .network-signal-dot {
    opacity: 0;
    pointer-events: none;
    animation-name: network-signal-dot-visibility;
    animation-timing-function: linear;
    animation-fill-mode: both;
  }

  .network-signal-dot-read-only {
    fill: rgba(166, 244, 255, 1);
    filter: drop-shadow(0 0 12px rgba(92, 200, 255, 0.78));
  }

  .network-signal-dot-full-duplex {
    fill: rgba(255, 235, 171, 1);
    filter: drop-shadow(0 0 12px rgba(240, 184, 92, 0.78));
  }

  .network-draft-line {
    fill: none;
    stroke: rgba(92, 200, 255, 0.88);
    stroke-width: 2;
    stroke-dasharray: 7 5;
  }

  .network-release-line {
    fill: none;
    stroke: rgba(92, 200, 255, 0.82);
    stroke-width: 2.25;
    filter: drop-shadow(0 0 8px rgba(92, 200, 255, 0.22));
  }

  .network-release-dot {
    filter: drop-shadow(0 0 8px rgba(92, 200, 255, 0.3));
  }

  .origin-mark {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
  }

  .origin-h {
    position: absolute;
    top: 0;
    left: -20px;
    width: 40px;
    height: 1px;
    background: var(--copper-dim);
    opacity: 0.6;
  }

  .origin-v {
    position: absolute;
    top: -20px;
    left: 0;
    width: 1px;
    height: 40px;
    background: var(--copper-dim);
    opacity: 0.6;
  }

  .origin-label {
    position: absolute;
    top: 4px;
    left: 4px;
    font-size: 8px;
    color: var(--copper-dim);
    font-family: var(--font-mono);
  }

  .coord-readout {
    position: fixed;
    bottom: 26px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 9px;
    color: var(--silk-dim);
    z-index: 100;
    pointer-events: none;
    font-family: var(--font-mono);
  }

  .coord-label {
    color: var(--copper);
  }

  @keyframes network-signal-line-pulse {
    0% {
      opacity: 0;
      stroke-width: 2.5;
    }

    18% {
      opacity: 1;
      stroke-width: 5.5;
    }

    72% {
      opacity: 0.9;
      stroke-width: 4.25;
    }

    100% {
      opacity: 0;
      stroke-width: 3;
    }
  }

  @keyframes network-signal-dot-visibility {
    0% {
      opacity: 0;
    }

    12% {
      opacity: 1;
    }

    88% {
      opacity: 1;
    }

    100% {
      opacity: 0;
    }
  }
</style>
