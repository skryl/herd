<script lang="ts">
  import { canvasState } from './stores/canvas';
  import { activeTabTerminals } from './stores/tabs';
  import { terminals } from './stores/terminals';
  import { sidebarOpen } from './stores/sidebar';
  import { debugPaneOpen } from './stores/debugPane';
  import TerminalTile from './TerminalTile.svelte';
  import type { TerminalInfo } from './types';
  import { get } from 'svelte/store';

  let isPanning = false;
  let lastX = 0;
  let lastY = 0;

  let cursorWorldX = $state(0);
  let cursorWorldY = $state(0);

  // Compute connection lines between parent/child terminals.
  // Lines connect from the closest sides of parent and child.
  let connections = $derived(computeConnections($activeTabTerminals));

  interface Connection {
    x1: number; y1: number;
    x2: number; y2: number;
    // Control points for a smooth curve
    cx1: number; cy1: number;
    cx2: number; cy2: number;
  }

  function computeConnections(tabTerms: TerminalInfo[]): Connection[] {
    const lines: Connection[] = [];
    const allTerms = get(terminals);

    for (const child of tabTerms) {
      if (!child.parentSessionId) continue;
      const parent = allTerms.find(t => t.sessionId === child.parentSessionId);
      if (!parent) continue;

      // Centers
      const pcx = parent.x + parent.width / 2;
      const pcy = parent.y + parent.height / 2;
      const ccx = child.x + child.width / 2;
      const ccy = child.y + child.height / 2;

      const dx = ccx - pcx;
      const dy = ccy - pcy;

      let x1: number, y1: number, x2: number, y2: number;

      // Determine which side of parent faces the child
      if (Math.abs(dx) > Math.abs(dy)) {
        // Horizontal: left/right
        if (dx > 0) {
          // Child is to the right
          x1 = parent.x + parent.width;
          y1 = pcy;
          x2 = child.x;
          y2 = ccy;
        } else {
          // Child is to the left
          x1 = parent.x;
          y1 = pcy;
          x2 = child.x + child.width;
          y2 = ccy;
        }
      } else {
        // Vertical: above/below
        if (dy > 0) {
          // Child is below
          x1 = pcx;
          y1 = parent.y + parent.height;
          x2 = ccx;
          y2 = child.y;
        } else {
          // Child is above
          x1 = pcx;
          y1 = parent.y;
          x2 = ccx;
          y2 = child.y + child.height;
        }
      }

      // Bezier control points: curve outward from the exit side
      const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
      const offset = Math.min(dist * 0.4, 80);

      let cx1 = x1, cy1 = y1, cx2 = x2, cy2 = y2;
      if (Math.abs(dx) > Math.abs(dy)) {
        cx1 = x1 + (dx > 0 ? offset : -offset);
        cx2 = x2 + (dx > 0 ? -offset : offset);
      } else {
        cy1 = y1 + (dy > 0 ? offset : -offset);
        cy2 = y2 + (dy > 0 ? -offset : offset);
      }

      lines.push({ x1, y1, x2, y2, cx1, cy1, cx2, cy2 });
    }
    return lines;
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    canvasState.update(s => {
      const zoomFactor = e.deltaY > 0 ? 0.95 : 1.05;
      const newZoom = Math.max(0.2, Math.min(3, s.zoom * zoomFactor));

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const dx = cx - s.panX;
      const dy = cy - s.panY;
      const scale = newZoom / s.zoom;

      return {
        zoom: newZoom,
        panX: cx - dx * scale,
        panY: cy - dy * scale,
      };
    });
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
    canvasState.update(s => ({
      ...s,
      panX: s.panX + dx,
      panY: s.panY + dy,
    }));
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
    <!-- Origin crosshair -->
    <div class="origin-mark">
      <div class="origin-h"></div>
      <div class="origin-v"></div>
      <span class="origin-label">0,0</span>
    </div>

    <!-- Connection lines (SVG overlay in world coords) -->
    {#if connections.length > 0}
      <svg class="connections-svg">
        {#each connections as conn}
          <path
            d="M {conn.x1} {conn.y1} C {conn.cx1} {conn.cy1}, {conn.cx2} {conn.cy2}, {conn.x2} {conn.y2}"
            class="conn-line"
          />
          <circle cx={conn.x1} cy={conn.y1} r="3" class="conn-dot-parent" />
          <circle cx={conn.x2} cy={conn.y2} r="3" class="conn-dot" />
        {/each}
      </svg>
    {/if}

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
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-image:
      radial-gradient(circle, var(--grid-dot) 1px, transparent 1px);
    background-size: 20px 20px;
    pointer-events: none;
  }

  .canvas-world {
    transform-origin: 0 0;
    position: absolute;
    top: 0;
    left: 0;
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

  /* Connection lines between parent/child shells */
  .connections-svg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    z-index: 0;
  }

  .conn-line {
    stroke: var(--copper);
    stroke-width: 1.5;
    stroke-dasharray: 6 4;
    fill: none;
    opacity: 0.6;
  }

  .conn-dot-parent {
    fill: var(--copper-dim);
    opacity: 0.6;
  }

  .conn-dot {
    fill: var(--copper);
    opacity: 0.8;
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
    color: var(--silk-dim);
    font-size: 9px;
  }

  .coord-value {
    color: var(--phosphor-amber-dim);
    letter-spacing: 0.5px;
  }
</style>
