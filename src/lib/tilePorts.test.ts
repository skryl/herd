import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TILE_PORT_COUNT,
  TILE_PORT_COUNT_OPTIONS,
  tilePortId,
  tilePortSide,
  tilePortSlot,
  tilePortsForCount,
  visibleTilePorts,
  visibleTilePortSlotsBySide,
} from './tilePorts';

describe('tile port helpers', () => {
  it('defaults to four total ports and exposes the supported toggle values', () => {
    expect(DEFAULT_TILE_PORT_COUNT).toBe(4);
    expect(TILE_PORT_COUNT_OPTIONS).toEqual([4, 8, 12, 16]);
  });

  it('builds slot-aware port ids while preserving slot one names', () => {
    expect(tilePortId('left', 1)).toBe('left');
    expect(tilePortId('left', 2)).toBe('left-2');
    expect(tilePortId('bottom', 4)).toBe('bottom-4');
    expect(tilePortSide('right-3')).toBe('right');
    expect(tilePortSlot('right-3')).toBe(3);
  });

  it('expands configured counts into per-side ports', () => {
    expect(tilePortsForCount(4)).toEqual(['left', 'top', 'right', 'bottom']);
    expect(tilePortsForCount(8)).toEqual([
      'left',
      'top',
      'right',
      'bottom',
      'left-2',
      'top-2',
      'right-2',
      'bottom-2',
    ]);
    expect(tilePortsForCount(12)).toContain('top-3');
    expect(tilePortsForCount(16)).toContain('bottom-4');
  });

  it('keeps occupied higher-slot ports visible when the configured count is lowered', () => {
    expect(visibleTilePorts(4, ['right-3', 'bottom-4'])).toEqual([
      'left',
      'top',
      'right',
      'bottom',
      'right-3',
      'bottom-4',
    ]);
    expect(visibleTilePortSlotsBySide(4, ['right-3', 'bottom-4'])).toEqual({
      left: 1,
      top: 1,
      right: 3,
      bottom: 4,
    });
  });
});
