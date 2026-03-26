import type { TilePort } from './types';
import { tilePortSide } from './tilePorts';

export interface CurvePoint {
  x: number;
  y: number;
}

export interface CubicBezierSegment {
  startPoint: CurvePoint;
  control1: CurvePoint;
  control2: CurvePoint;
  endPoint: CurvePoint;
}

const SIMPLE_CURVE_HANDLE_MIN = 36;
const SIMPLE_CURVE_HANDLE_MAX = 120;
const SIMPLE_CURVE_HANDLE_SCALE = 0.45;

export function portVector(port: TilePort): CurvePoint {
  switch (tilePortSide(port)) {
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

export function cubicBezierPath(segment: CubicBezierSegment) {
  return [
    `M ${segment.startPoint.x} ${segment.startPoint.y}`,
    `C ${segment.control1.x} ${segment.control1.y} ${segment.control2.x} ${segment.control2.y} ${segment.endPoint.x} ${segment.endPoint.y}`,
  ].join(' ');
}

export function simplePortCurveSegment(
  startPoint: CurvePoint,
  startPort: TilePort,
  endPoint: CurvePoint,
  endPort: TilePort,
): CubicBezierSegment {
  const handle = Math.max(
    SIMPLE_CURVE_HANDLE_MIN,
    Math.min(SIMPLE_CURVE_HANDLE_MAX, Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y) * SIMPLE_CURVE_HANDLE_SCALE),
  );
  const startVector = portVector(startPort);
  const endVector = portVector(endPort);
  return {
    startPoint,
    control1: {
      x: startPoint.x + startVector.x * handle,
      y: startPoint.y + startVector.y * handle,
    },
    control2: {
      x: endPoint.x + endVector.x * handle,
      y: endPoint.y + endVector.y * handle,
    },
    endPoint,
  };
}

export function simplePortCurvePath(
  startPoint: CurvePoint,
  startPort: TilePort,
  endPoint: CurvePoint,
  endPort: TilePort,
) {
  return cubicBezierPath(simplePortCurveSegment(startPoint, startPort, endPoint, endPort));
}
