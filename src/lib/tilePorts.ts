import type { TilePort, TilePortCount, TilePortSide, TilePortSlot } from './types';

export const TILE_PORT_SIDES: TilePortSide[] = ['left', 'top', 'right', 'bottom'];
export const TILE_PORT_COUNT_OPTIONS: TilePortCount[] = [4, 8, 12, 16];
export const DEFAULT_TILE_PORT_COUNT: TilePortCount = 4;

function parseTilePort(port: TilePort) {
  const match = /^(left|top|right|bottom)(?:-(2|3|4))?$/.exec(port);
  if (!match) {
    throw new Error(`Unsupported tile port: ${port}`);
  }
  return {
    side: match[1] as TilePortSide,
    slot: Number(match[2] ?? 1) as TilePortSlot,
  };
}

export function tilePortId(side: TilePortSide, slot: TilePortSlot): TilePort {
  return slot === 1 ? side : `${side}-${slot}` as TilePort;
}

export function tilePortSide(port: TilePort): TilePortSide {
  return parseTilePort(port).side;
}

export function tilePortSlot(port: TilePort): TilePortSlot {
  return parseTilePort(port).slot;
}

export function tilePortsPerSide(count: TilePortCount): TilePortSlot {
  return (count / 4) as TilePortSlot;
}

export function tilePortsForCount(count: TilePortCount): TilePort[] {
  const portsPerSide = tilePortsPerSide(count);
  const ports: TilePort[] = [];
  for (let slot = 1; slot <= portsPerSide; slot += 1) {
    for (const side of TILE_PORT_SIDES) {
      ports.push(tilePortId(side, slot as TilePortSlot));
    }
  }
  return ports;
}

export function visibleTilePortSlotsBySide(
  configuredCount: TilePortCount,
  occupiedPorts: Iterable<TilePort>,
): Record<TilePortSide, TilePortSlot> {
  const configuredPerSide = tilePortsPerSide(configuredCount);
  const visibleSlotsBySide = Object.fromEntries(
    TILE_PORT_SIDES.map((side) => [side, configuredPerSide]),
  ) as Record<TilePortSide, TilePortSlot>;

  for (const port of occupiedPorts) {
    const side = tilePortSide(port);
    const slot = tilePortSlot(port);
    if (slot > visibleSlotsBySide[side]) {
      visibleSlotsBySide[side] = slot;
    }
  }

  return visibleSlotsBySide;
}

export function visibleTilePorts(
  configuredCount: TilePortCount,
  occupiedPorts: Iterable<TilePort>,
): TilePort[] {
  const configuredPorts = new Set(tilePortsForCount(configuredCount));
  const occupiedExtras = [...new Set(Array.from(occupiedPorts))]
    .filter((port) => !configuredPorts.has(port))
    .sort((left, right) =>
      tilePortSlot(left) - tilePortSlot(right)
      || TILE_PORT_SIDES.indexOf(tilePortSide(left)) - TILE_PORT_SIDES.indexOf(tilePortSide(right)));
  return [...Array.from(configuredPorts), ...occupiedExtras];
}

export function tilePortOffsetRatio(port: TilePort, visibleSlotCount: number): number {
  return tilePortSlot(port) / (visibleSlotCount + 1);
}
