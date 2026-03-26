import { describe, expect, it } from 'vitest';
import { routeWireGeometries } from './wireRouting';

describe('routeWireGeometries', () => {
  it('uses a simple single-cubic curve for unblocked ported routes', () => {
    const geometries = routeWireGeometries(
      new Map(),
      [{
        key: 'direct',
        startPoint: { x: 0, y: 0 },
        endPoint: { x: 180, y: 0 },
        startPort: 'right',
        endPort: 'left',
      }],
    );

    const geometry = geometries.direct;
    expect(geometry.points).toEqual([
      { x: 0, y: 0 },
      { x: 180, y: 0 },
    ]);
    expect(geometry.path).toMatch(/^M 0 0 C [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ 180 0$/);
  });

  it('falls back to libavoid when a simple port curve would cross another tile', () => {
    const geometries = routeWireGeometries(
      new Map([
        ['left-tile', { x: 0, y: 0, width: 240, height: 160 }],
        ['right-tile', { x: 420, y: 40, width: 260, height: 180 }],
        ['blocker', { x: 250, y: -40, width: 140, height: 240 }],
      ]),
      [{
        key: 'ported-direct',
        startPoint: { x: 240, y: 80 },
        endPoint: { x: 420, y: 130 },
        startPort: 'right',
        endPort: 'left',
        startRectId: 'left-tile',
        endRectId: 'right-tile',
      }],
    );

    const geometry = geometries['ported-direct'];
    expect(geometry.points.length).toBeGreaterThan(2);
    expect(geometry.points[0]).toEqual({ x: 240, y: 80 });
    expect(geometry.points[geometry.points.length - 1]).toEqual({ x: 420, y: 130 });
  });
});
