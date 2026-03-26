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
    activeNetworkCallPortActivity,
    buildNetworkCallSignals,
    canvasState,
    clearNetworkReleaseAnimation,
    completeNetworkPortDrag,
    debugPaneHeight,
    debugPaneOpen,
    dismissContextMenu,
    mode,
    networkCallSparksEnabled,
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

  interface ActiveNetworkCallSignal extends NetworkCallSignal {
    startedAtMs: number;
  }

  interface VisibleNetworkCallSignalSegment {
    id: string;
    fromTileId: string;
    toTileId: string;
    senderTileId: string;
    senderPort: TilePort;
    receiverTileId: string;
    receiverPort: TilePort;
    connectionKey: string;
    wireMode: 'read_only' | 'full_duplex';
    path: string;
    reverse: boolean;
    opacity: number;
    glowOpacity: number;
    coreOpacity: number;
    dotX: number;
    dotY: number;
    trailX: number;
    trailY: number;
    trailOpacity: number;
  }

  let isPanning = false;
  let lastX = 0;
  let lastY = 0;
  let viewportRef = $state<HTMLDivElement | null>(null);
  let cursorWorldX = $state(0);
  let cursorWorldY = $state(0);
  let workCardLayouts = $derived(new Map($activeTabVisibleWorkCards.map((card) => [card.workId, card])));
  let releaseAnimationProgress = $state(1);
  let networkCallSignals = $state<ActiveNetworkCallSignal[]>([]);
  let networkSignalNowMs = $state(0);
  let effectiveSidebarWidth = $derived($sidebarOpen ? 240 : 0);
  let effectiveDebugHeight = $derived(
    $debugPaneOpen && Number.isFinite($debugPaneHeight) && $debugPaneHeight > 0 ? $debugPaneHeight : 0,
  );

  const NETWORK_RELEASE_DURATION_MS = 180;
  const NETWORK_SIGNAL_REMOVE_BUFFER_MS = 120;
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const seenNetworkCallLogKeysBySession = new Map<string, Set<string>>();
  const networkSignalPathGeometries = new Map<string, { element: SVGPathElement; length: number }>();
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

  function clearActiveNetworkCallSignals() {
    networkCallSignals = [];
    networkSignalNowMs = 0;
    networkSignalPathGeometries.clear();
    activeNetworkCallPortActivity.set([]);
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

  function networkSignalPathGeometry(path: string) {
    const cached = networkSignalPathGeometries.get(path);
    if (cached) {
      return cached;
    }
    if (typeof document === 'undefined') {
      return null;
    }

    const element = document.createElementNS(SVG_NAMESPACE, 'path');
    element.setAttribute('d', path);
    const geometry = {
      element,
      length: Math.max(0, element.getTotalLength()),
    };
    networkSignalPathGeometries.set(path, geometry);
    return geometry;
  }

  function pointAlongSignalPath(path: string, progress: number, reverse: boolean) {
    const geometry = networkSignalPathGeometry(path);
    if (!geometry || geometry.length <= 0) {
      return { x: 0, y: 0 };
    }

    const clampedProgress = Math.max(0, Math.min(1, progress));
    const distance = geometry.length * (reverse ? 1 - clampedProgress : clampedProgress);
    const point = geometry.element.getPointAtLength(Math.max(0, Math.min(geometry.length, distance)));
    return { x: point.x, y: point.y };
  }

  function signalOpacity(progress: number) {
    if (progress <= 0) {
      return 0;
    }
    if (progress < 0.12) {
      return progress / 0.12;
    }
    if (progress > 0.88) {
      return Math.max(0, (1 - progress) / 0.12);
    }
    return 1;
  }

  function trailProgress(progress: number) {
    return Math.max(0, progress - 0.08);
  }

  function visibleNetworkCallSignalSegments(): VisibleNetworkCallSignalSegment[] {
    if (!$networkCallSparksEnabled) {
      return [];
    }
    const nowMs = networkSignalNowMs;
    return networkCallSignals.flatMap((signal) =>
      signal.segments.flatMap<VisibleNetworkCallSignalSegment>((segment) => {
        const elapsedMs = nowMs - signal.startedAtMs - segment.delayMs;
        if (elapsedMs < 0 || elapsedMs > segment.durationMs) {
          return [];
        }
        const progress = segment.durationMs <= 0
          ? 1
          : Math.max(0, Math.min(1, elapsedMs / segment.durationMs));
        const dot = pointAlongSignalPath(segment.path, progress, segment.reverse);
        const trail = pointAlongSignalPath(segment.path, trailProgress(progress), segment.reverse);
        const opacity = signalOpacity(progress);
        return [{
          id: segment.id,
          fromTileId: signal.fromTileId,
          toTileId: signal.toTileId,
          senderTileId: segment.senderTileId,
          senderPort: segment.senderPort,
          receiverTileId: segment.receiverTileId,
          receiverPort: segment.receiverPort,
          connectionKey: segment.connectionKey,
          wireMode: segment.wireMode,
          path: segment.path,
          reverse: segment.reverse,
          opacity,
          glowOpacity: opacity * 0.38,
          coreOpacity: opacity * 0.92,
          dotX: dot.x,
          dotY: dot.y,
          trailX: trail.x,
          trailY: trail.y,
          trailOpacity: opacity * 0.28,
        }];
      }),
    );
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
    const sparksEnabled = $networkCallSparksEnabled;

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

    if (!sparksEnabled) {
      seenNetworkCallLogKeysBySession.set(
        activeSessionId,
        new Set(currentLogs.map((entry, index) => networkCallLogKey(entry, index))),
      );
      clearActiveNetworkCallSignals();
      return;
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

    const startedAtMs = performance.now();
    networkSignalNowMs = startedAtMs;
    networkCallSignals = [
      ...networkCallSignals,
      ...nextSignals.map((signal) => ({ ...signal, startedAtMs })),
    ];
  });

  $effect(() => {
    if (networkCallSignals.length === 0) {
      networkSignalNowMs = 0;
      return;
    }

    let frame = 0;
    const tick = (now: number) => {
      networkSignalNowMs = now;
      const activeSignals = networkCallSignals.filter(
        (signal) => now - signal.startedAtMs <= signal.totalDurationMs + NETWORK_SIGNAL_REMOVE_BUFFER_MS,
      );
      if (activeSignals.length !== networkCallSignals.length) {
        networkCallSignals = activeSignals;
      }
      if (activeSignals.length === 0) {
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  });

  $effect(() => {
    const activePortKeys = new Set<string>();
    const nextActivity = visibleNetworkCallSignalSegments().flatMap((segment) => {
      const sendKey = `${segment.senderTileId}:${segment.senderPort}:send`;
      const receiveKey = `${segment.receiverTileId}:${segment.receiverPort}:receive`;
      return [
        activePortKeys.has(sendKey)
          ? null
          : (activePortKeys.add(sendKey), {
              tileId: segment.senderTileId,
              port: segment.senderPort,
              direction: 'send' as const,
            }),
        activePortKeys.has(receiveKey)
          ? null
          : (activePortKeys.add(receiveKey), {
              tileId: segment.receiverTileId,
              port: segment.receiverPort,
              direction: 'receive' as const,
            }),
      ];
    }).filter((activity) => activity !== null);
    activeNetworkCallPortActivity.set(nextActivity);
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
        {#each visibleNetworkCallSignalSegments() as segment (segment.id)}
            <path
              d={segment.path}
              class="network-signal-glow"
              class:network-signal-glow-read-only={segment.wireMode === 'read_only'}
              class:network-signal-glow-full-duplex={segment.wireMode === 'full_duplex'}
              data-from-tile-id={segment.fromTileId}
              data-to-tile-id={segment.toTileId}
              data-connection-key={segment.connectionKey}
              style={`opacity: ${segment.glowOpacity};`}
            />
            <path
              d={segment.path}
              class="network-signal-line"
              class:network-signal-line-read-only={segment.wireMode === 'read_only'}
              class:network-signal-line-full-duplex={segment.wireMode === 'full_duplex'}
              data-from-tile-id={segment.fromTileId}
              data-to-tile-id={segment.toTileId}
              data-connection-key={segment.connectionKey}
              style={`opacity: ${segment.coreOpacity};`}
            />
            <circle
              cx={segment.trailX}
              cy={segment.trailY}
              r="7.5"
              class="network-signal-trail"
              class:network-signal-trail-read-only={segment.wireMode === 'read_only'}
              class:network-signal-trail-full-duplex={segment.wireMode === 'full_duplex'}
              data-connection-key={segment.connectionKey}
              style={`opacity: ${segment.trailOpacity};`}
            />
            <circle
              cx={segment.dotX}
              cy={segment.dotY}
              r="10"
              class="network-signal-spark-halo"
              class:network-signal-spark-halo-read-only={segment.wireMode === 'read_only'}
              class:network-signal-spark-halo-full-duplex={segment.wireMode === 'full_duplex'}
              data-connection-key={segment.connectionKey}
              style={`opacity: ${segment.glowOpacity};`}
            />
            <circle
              cx={segment.dotX}
              cy={segment.dotY}
              r="4.5"
              class="network-signal-dot"
              class:network-signal-dot-read-only={segment.wireMode === 'read_only'}
              class:network-signal-dot-full-duplex={segment.wireMode === 'full_duplex'}
              data-from-tile-id={segment.fromTileId}
              data-to-tile-id={segment.toTileId}
              data-connection-key={segment.connectionKey}
              style={`opacity: ${segment.opacity};`}
            />
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
    stroke-width: 4.25;
    stroke-linecap: round;
    pointer-events: none;
  }

  .network-signal-line-read-only {
    stroke: rgba(212, 251, 255, 0.98);
    filter: drop-shadow(0 0 8px rgba(92, 200, 255, 0.58));
  }

  .network-signal-line-full-duplex {
    stroke: rgba(255, 244, 196, 0.98);
    filter: drop-shadow(0 0 8px rgba(240, 184, 92, 0.52));
  }

  .network-signal-glow {
    fill: none;
    stroke-width: 12;
    stroke-linecap: round;
    pointer-events: none;
  }

  .network-signal-glow-read-only {
    stroke: rgba(116, 226, 255, 0.92);
    filter: drop-shadow(0 0 16px rgba(92, 200, 255, 0.8));
  }

  .network-signal-glow-full-duplex {
    stroke: rgba(255, 201, 102, 0.92);
    filter: drop-shadow(0 0 16px rgba(240, 184, 92, 0.75));
  }

  .network-signal-dot {
    pointer-events: none;
  }

  .network-signal-dot-read-only {
    fill: rgba(240, 253, 255, 1);
    filter: drop-shadow(0 0 10px rgba(92, 200, 255, 0.95));
  }

  .network-signal-dot-full-duplex {
    fill: rgba(255, 248, 221, 1);
    filter: drop-shadow(0 0 10px rgba(240, 184, 92, 0.92));
  }

  .network-signal-spark-halo,
  .network-signal-trail {
    pointer-events: none;
  }

  .network-signal-spark-halo-read-only {
    fill: rgba(141, 236, 255, 0.94);
    filter: drop-shadow(0 0 18px rgba(92, 200, 255, 0.88));
  }

  .network-signal-spark-halo-full-duplex {
    fill: rgba(255, 210, 121, 0.94);
    filter: drop-shadow(0 0 18px rgba(240, 184, 92, 0.84));
  }

  .network-signal-trail-read-only {
    fill: rgba(141, 236, 255, 0.72);
    filter: drop-shadow(0 0 10px rgba(92, 200, 255, 0.52));
  }

  .network-signal-trail-full-duplex {
    fill: rgba(255, 210, 121, 0.72);
    filter: drop-shadow(0 0 10px rgba(240, 184, 92, 0.5));
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

</style>
