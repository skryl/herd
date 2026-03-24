<script lang="ts">
  import BrowserTile from './BrowserTile.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import TerminalTile from './TerminalTile.svelte';
  import WorkCard from './WorkCard.svelte';
  import {
    activeNetworkDrag,
    activeTabConnections,
    activeTabWorkCards,
    activeSessionWorkItems,
    activeTabTerminals,
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
    updateNetworkPortDrag,
    visibleActiveTabNetworkConnections,
    wheelCanvas,
  } from './stores/appState';

  let isPanning = false;
  let lastX = 0;
  let lastY = 0;
  let cursorWorldX = $state(0);
  let cursorWorldY = $state(0);
  let workCardLayouts = $derived(new Map($activeTabWorkCards.map((card) => [card.workId, card])));
  let releaseAnimationProgress = $state(1);
  let effectiveSidebarWidth = $derived($sidebarOpen ? 240 : 0);
  let effectiveDebugHeight = $derived(
    $debugPaneOpen && Number.isFinite($debugPaneHeight) && $debugPaneHeight > 0 ? $debugPaneHeight : 0,
  );

  const NETWORK_RELEASE_DURATION_MS = 180;

  type TilePort = 'left' | 'top' | 'right' | 'bottom';

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

  function portVector(port: TilePort) {
    switch (port) {
      case 'left':
        return { x: -1, y: 0 };
      case 'top':
        return { x: 0, y: -1 };
      case 'right':
        return { x: 1, y: 0 };
      case 'bottom':
        return { x: 0, y: 1 };
    }
  }

  function curvedPath(x1: number, y1: number, fromPort: TilePort, x2: number, y2: number, toPort: TilePort) {
    const distance = Math.hypot(x2 - x1, y2 - y1);
    const handle = Math.max(36, Math.min(120, distance * 0.45));
    const fromVector = portVector(fromPort);
    const toVector = portVector(toPort);
    const cx1 = x1 + fromVector.x * handle;
    const cy1 = y1 + fromVector.y * handle;
    const cx2 = x2 + toVector.x * handle;
    const cy2 = y2 + toVector.y * handle;
    return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
  }

  function easedReleaseProgress(progress: number) {
    return 1 - (1 - progress) ** 3;
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
      e.preventDefault();
    }
  }

  function handleMouseMove(e: MouseEvent) {
    const state = $canvasState;
    const rect = (e.currentTarget as HTMLElement)?.getBoundingClientRect();
    if (rect) {
      cursorWorldX = Math.round((e.clientX - rect.left - state.panX) / state.zoom);
      cursorWorldY = Math.round((e.clientY - rect.top - state.panY) / state.zoom);
      updateNetworkPortDrag(e.clientX - rect.left, e.clientY - rect.top);
    }

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

<svelte:window onmouseup={handleMouseUp} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
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
            d="M {conn.x1} {conn.y1} C {conn.cx1} {conn.cy1}, {conn.cx2} {conn.cy2}, {conn.x2} {conn.y2}"
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
            d={`M ${conn.x1} ${conn.y1} C ${conn.cx1} ${conn.cy1}, ${conn.cx2} ${conn.cy2}, ${conn.x2} ${conn.y2}`}
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
      </svg>
    {/if}

    <div class="origin-mark">
      <div class="origin-h"></div>
      <div class="origin-v"></div>
      <span class="origin-label">0,0</span>
    </div>

    {#each $activeTabTerminals as term (term.id)}
      {#if term.kind === 'browser'}
        <BrowserTile info={term} />
      {:else}
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

  {#if $activeNetworkDrag}
    <svg class="network-draft-svg">
      <path
        d={curvedPath(
          $activeNetworkDrag.startX,
          $activeNetworkDrag.startY,
          $activeNetworkDrag.port,
          $activeNetworkDrag.snappedX ?? $activeNetworkDrag.currentX,
          $activeNetworkDrag.snappedY ?? $activeNetworkDrag.currentY,
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
        d={curvedPath(
          $networkReleaseAnimation.anchorX,
          $networkReleaseAnimation.anchorY,
          $networkReleaseAnimation.anchorPort,
          looseX,
          looseY,
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
