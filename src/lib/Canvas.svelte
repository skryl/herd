<script lang="ts">
  import TerminalTile from './TerminalTile.svelte';
  import {
    activeTabConnections,
    activeTabTerminals,
    canvasState,
    debugPaneOpen,
    mode,
    panCanvasBy,
    sidebarOpen,
    wheelCanvas,
  } from './stores/appState';

  let isPanning = false;
  let lastX = 0;
  let lastY = 0;
  let cursorWorldX = $state(0);
  let cursorWorldY = $state(0);

  function handleWheel(e: WheelEvent) {
    if ($mode === 'input') {
      return;
    }
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    wheelCanvas(e.deltaY, e.clientX - rect.left, e.clientY - rect.top);
  }

  function handleMouseDown(e: MouseEvent) {
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
  }
</script>

<svelte:window onmouseup={handleMouseUp} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="canvas-viewport"
  style="--sidebar-width: {$sidebarOpen ? '240px' : '0px'}; --debug-height: {$debugPaneOpen ? '200px' : '0px'}"
  onwheel={handleWheel}
  onmousedown={handleMouseDown}
  onmousemove={handleMouseMove}
  oncontextmenu={(e) => e.preventDefault()}
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

    <div class="origin-mark">
      <div class="origin-h"></div>
      <div class="origin-v"></div>
      <span class="origin-label">0,0</span>
    </div>

    {#each $activeTabTerminals as term (term.id)}
      <TerminalTile info={term} />
    {/each}
  </div>

  <div class="coord-readout">
    <span class="coord-label">POS</span>
    <span class="coord-value">X:{cursorWorldX} Y:{cursorWorldY}</span>
  </div>
</div>

<style>
  .canvas-viewport {
    position: fixed;
    top: var(--toolbar-height);
    left: var(--sidebar-width, 0px);
    right: 0;
    bottom: calc(22px + var(--debug-height, 0px));
    transition: left 0.15s;
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
