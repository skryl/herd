<script lang="ts">
  import {
    activeNetworkDrag,
    activeNetworkCallPortActivity,
    appState,
    beginNetworkPortDrag,
    clearCurrentNetworkDragPortSnap,
    completeNetworkPortDrag,
    openPortContextMenu,
    portCanAcceptCurrentDrag,
    portNetworkingModeForTile,
    portModeForTile,
    snapCurrentNetworkDragToPort,
  } from './stores/appState';
  import { tilePortOffsetRatio, tilePortSide, visibleTilePortSlotsBySide, visibleTilePorts } from './tilePorts';
  import type { TilePort } from './types';

  let { tileId }: { tileId: string } = $props();

  let occupiedPorts = $derived(
    $appState.network.connections.flatMap((connection) => {
      const ports: TilePort[] = [];
      if (connection.from_tile_id === tileId) {
        ports.push(connection.from_port);
      }
      if (connection.to_tile_id === tileId) {
        ports.push(connection.to_port);
      }
      return ports;
    }),
  );
  let visibleSlotsBySide = $derived(visibleTilePortSlotsBySide($appState.ui.tilePortCount, occupiedPorts));
  let ports = $derived(visibleTilePorts($appState.ui.tilePortCount, occupiedPorts));
  let localPortActivity = $derived($activeNetworkCallPortActivity.filter((activity) => activity.tileId === tileId));

  function occupied(port: TilePort) {
    if ($activeNetworkDrag?.startedOccupied && $activeNetworkDrag.grabbedTileId === tileId && $activeNetworkDrag.grabbedPort === port) {
      return false;
    }
    return $appState.network.connections.some(
      (connection) =>
        (connection.from_tile_id === tileId && connection.from_port === port)
        || (connection.to_tile_id === tileId && connection.to_port === port),
    );
  }

  function snapped(port: TilePort) {
    return $activeNetworkDrag?.snappedTileId === tileId && $activeNetworkDrag?.snappedPort === port;
  }

  function detached(port: TilePort) {
    return $activeNetworkDrag?.startedOccupied && $activeNetworkDrag?.grabbedTileId === tileId && $activeNetworkDrag?.grabbedPort === port;
  }

  function connectable(port: TilePort) {
    return portCanAcceptCurrentDrag(tileId, port);
  }

  function sending(port: TilePort) {
    return localPortActivity.some((activity) => activity.port === port && activity.direction === 'send');
  }

  function receiving(port: TilePort) {
    return localPortActivity.some((activity) => activity.port === port && activity.direction === 'receive');
  }

  function portStyle(port: TilePort) {
    const side = tilePortSide(port);
    const ratio = tilePortOffsetRatio(port, visibleSlotsBySide[side]) * 100;
    switch (side) {
      case 'left':
      case 'right':
        return `top: calc(${ratio}% - 13px);`;
      case 'top':
      case 'bottom':
        return `left: calc(${ratio}% - 13px);`;
    }
  }

  function handleMouseDown(port: TilePort, event: MouseEvent) {
    event.stopPropagation();
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const portRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const viewport = (event.currentTarget as HTMLElement).closest('.canvas-viewport') as HTMLElement | null;
    const viewportRect = viewport?.getBoundingClientRect();
    beginNetworkPortDrag(
      tileId,
      port,
      viewportRect ? portRect.left + portRect.width / 2 - viewportRect.left : portRect.left + portRect.width / 2,
      viewportRect ? portRect.top + portRect.height / 2 - viewportRect.top : portRect.top + portRect.height / 2,
    );
  }

  function handleMouseUp(port: TilePort, event: MouseEvent) {
    event.stopPropagation();
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    if ($activeNetworkDrag && !connectable(port)) {
      void completeNetworkPortDrag();
      return;
    }
    void completeNetworkPortDrag(tileId, port);
  }

  function handleMouseEnter(port: TilePort, event: MouseEvent) {
    if (!$activeNetworkDrag) {
      return;
    }
    event.stopPropagation();
    if (connectable(port)) {
      snapCurrentNetworkDragToPort(tileId, port);
      return;
    }
    clearCurrentNetworkDragPortSnap(tileId, port);
  }

  function handleMouseLeave(port: TilePort, event: MouseEvent) {
    if (!$activeNetworkDrag) {
      return;
    }
    event.stopPropagation();
    clearCurrentNetworkDragPortSnap(tileId, port);
  }

  function handleContextMenu(port: TilePort, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    openPortContextMenu(tileId, port, event.clientX, event.clientY);
  }
</script>

{#each ports as port}
  <div
    role="button"
    tabindex="-1"
    aria-label={`${tileId} ${port} port`}
    class={`tile-port port-${tilePortSide(port)} ${portModeForTile(tileId, port) === 'read_write' ? 'port-read-write' : 'port-read'} ${occupied(port) ? 'port-occupied' : connectable(port) ? 'port-open' : 'port-unavailable'} ${snapped(port) ? 'port-snapped' : ''} ${detached(port) ? 'port-detached' : ''} ${portModeForTile(tileId, port) === 'read' ? 'port-access-read' : ''} ${portNetworkingModeForTile(tileId, port) === 'gateway' ? 'port-networking-gateway' : ''}`}
    data-port-tile={tileId}
    data-port={port}
    data-port-access={portModeForTile(tileId, port)}
    data-port-networking={portNetworkingModeForTile(tileId, port)}
    data-port-send-active={sending(port) ? 'true' : 'false'}
    data-port-receive-active={receiving(port) ? 'true' : 'false'}
    style={portStyle(port)}
    onmousedown={(event) => handleMouseDown(port, event)}
    onmouseenter={(event) => handleMouseEnter(port, event)}
    onmousemove={(event) => handleMouseEnter(port, event)}
    onmouseleave={(event) => handleMouseLeave(port, event)}
    onmouseup={(event) => handleMouseUp(port, event)}
    oncontextmenu={(event) => handleContextMenu(port, event)}
  >
    <span class={`port-light port-light-left ${sending(port) ? 'light-active-send' : portModeForTile(tileId, port) === 'read' ? 'light-active-read' : ''}`}></span>
    <span class={`port-light port-light-right ${receiving(port) ? 'light-active-receive' : portNetworkingModeForTile(tileId, port) === 'gateway' ? 'light-active-gateway' : ''}`}></span>
  </div>
{/each}

<style>
  .tile-port {
    position: absolute;
    box-sizing: border-box;
    overflow: visible;
    border: 1px solid var(--tile-port-contour, var(--socket-border));
    background:
      linear-gradient(180deg, rgba(7, 11, 13, 0.94), rgba(5, 8, 10, 0.95));
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.025),
      inset 0 -1px 2px rgba(0, 0, 0, 0.14),
      0 0 0 1px rgba(5, 8, 10, 0.18);
    z-index: 6;
    transition:
      transform 0.14s ease,
      box-shadow 0.14s ease,
      border-color 0.14s ease,
      background 0.14s ease,
      opacity 0.14s ease;
  }

  .tile-port::after {
    content: '';
    position: absolute;
    inset: 3px;
    border-radius: inherit;
    background:
      linear-gradient(180deg, var(--socket-fill-soft), rgba(0, 0, 0, 0.015)),
      radial-gradient(circle at 50% 50%, var(--socket-fill-strong), transparent 78%);
    opacity: 0.46;
    transition:
      opacity 0.14s ease,
      box-shadow 0.14s ease,
      transform 0.14s ease;
  }

  .port-light {
    position: absolute;
    top: 50%;
    width: 5px;
    height: 5px;
    border-radius: 999px;
    transform: translateY(-50%);
    background: rgba(255, 255, 255, 0.12);
    box-shadow: 0 0 0 1px rgba(5, 8, 10, 0.3);
    z-index: 2;
  }

  .port-light-left {
    left: 2px;
  }

  .port-light-right {
    right: 2px;
  }

  .port-left .port-light,
  .port-right .port-light {
    left: 50%;
    right: auto;
    transform: translateX(-50%);
  }

  .port-left .port-light-left,
  .port-right .port-light-left {
    top: 4px;
  }

  .port-left .port-light-right,
  .port-right .port-light-right {
    top: auto;
    bottom: 4px;
  }

  .light-active-read {
    background: rgba(255, 94, 94, 0.95);
    box-shadow:
      0 0 0 1px rgba(84, 14, 14, 0.48),
      0 0 10px rgba(255, 94, 94, 0.45);
  }

  .light-active-gateway {
    background: rgba(255, 163, 61, 0.95);
    box-shadow:
      0 0 0 1px rgba(92, 48, 0, 0.42),
      0 0 10px rgba(255, 163, 61, 0.42);
  }

  .light-active-send,
  .light-active-receive {
    background: rgba(84, 255, 142, 0.98);
    box-shadow:
      0 0 0 1px rgba(8, 64, 24, 0.54),
      0 0 12px rgba(84, 255, 142, 0.64);
    animation: network-port-traffic-blink 0.34s ease-in-out infinite alternate;
  }

  @keyframes network-port-traffic-blink {
    from {
      opacity: 0.35;
      transform: translateY(-50%) scale(0.88);
    }

    to {
      opacity: 1;
      transform: translateY(-50%) scale(1.16);
    }
  }

  .port-left .light-active-send,
  .port-right .light-active-send,
  .port-left .light-active-receive,
  .port-right .light-active-receive {
    animation-name: network-port-traffic-blink-vertical;
  }

  @keyframes network-port-traffic-blink-vertical {
    from {
      opacity: 0.35;
      transform: translateX(-50%) scale(0.88);
    }

    to {
      opacity: 1;
      transform: translateX(-50%) scale(1.16);
    }
  }

  .tile-port:hover {
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.04),
      inset 0 -1px 2px rgba(0, 0, 0, 0.16),
      0 0 0 1px rgba(5, 8, 10, 0.2),
      0 0 16px color-mix(in srgb, var(--socket-glow) 40%, transparent);
  }

  .tile-port:hover::after {
    opacity: 1;
    box-shadow: 0 0 10px color-mix(in srgb, var(--socket-glow) 55%, transparent);
  }

  .port-snapped {
    transform: scale(1.04);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.05),
      inset 0 -1px 2px rgba(0, 0, 0, 0.16),
      0 0 0 1px rgba(5, 8, 10, 0.2),
      0 0 18px rgba(92, 200, 255, 0.35);
  }

  .port-snapped::after {
    opacity: 1;
    box-shadow: 0 0 14px rgba(92, 200, 255, 0.42);
  }

  .port-detached {
    opacity: 0.7;
  }

  .port-detached::after {
    opacity: 0.35;
  }

  .port-left {
    left: -1px;
    top: calc(50% - 13px);
    width: 18px;
    height: 26px;
    border-left: none;
    border-radius: 0 8px 8px 0;
  }

  .port-top {
    top: -1px;
    left: calc(50% - 13px);
    width: 26px;
    height: 18px;
    border-top: none;
    border-radius: 0 0 8px 8px;
  }

  .port-right {
    right: -1px;
    top: calc(50% - 13px);
    width: 18px;
    height: 26px;
    border-right: none;
    border-radius: 8px 0 0 8px;
  }

  .port-bottom {
    bottom: -1px;
    left: calc(50% - 13px);
    width: 26px;
    height: 18px;
    border-bottom: none;
    border-radius: 8px 8px 0 0;
  }

  .port-read-write {
    --socket-border: rgba(240, 184, 92, 0.5);
    --socket-fill-soft: rgba(240, 184, 92, 0.16);
    --socket-fill-strong: rgba(240, 184, 92, 0.22);
    --socket-hover: rgba(247, 203, 136, 0.82);
    --socket-glow: rgba(240, 184, 92, 0.7);
  }

  .port-read {
    --socket-border: rgba(110, 210, 240, 0.46);
    --socket-fill-soft: rgba(110, 210, 240, 0.14);
    --socket-fill-strong: rgba(110, 210, 240, 0.2);
    --socket-hover: rgba(171, 232, 255, 0.82);
    --socket-glow: rgba(110, 210, 240, 0.66);
  }

  .port-occupied {
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.025),
      inset 0 -1px 3px rgba(0, 0, 0, 0.18),
      0 0 0 1px rgba(5, 8, 10, 0.2),
      0 0 12px color-mix(in srgb, var(--socket-glow) 32%, transparent);
  }

  .port-occupied::after {
    opacity: 0.92;
  }

  .port-unavailable {
    opacity: 0.34;
    filter: saturate(0.58);
  }

  .port-unavailable::after {
    opacity: 0.16;
  }
</style>
