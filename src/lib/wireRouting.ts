import { AvoidLib, type Avoid } from 'libavoid-js';
import type { TilePort } from './types';
import { tilePortOffsetRatio, tilePortSide } from './tilePorts';
import { cubicBezierPath, portVector, simplePortCurveSegment, type CubicBezierSegment } from './wireCurves';

await AvoidLib.load(new URL('../../node_modules/libavoid-js/dist/libavoid.wasm', import.meta.url).href);

const AVOID = AvoidLib.getInstance();

function avoidEnumValue(value: unknown) {
  if (typeof value === 'number') {
    return value;
  }
  if (value && typeof value === 'object' && 'value' in value) {
    return Number((value as { value: unknown }).value);
  }
  return Number(value);
}

export interface WireRoutePoint {
  x: number;
  y: number;
}

export interface WireRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WireRouteSpec {
  key: string;
  startPoint: WireRoutePoint;
  endPoint: WireRoutePoint;
  startPort?: TilePort;
  endPort?: TilePort;
  startRectId?: string;
  endRectId?: string;
}

export interface RoutedWireGeometry {
  points: WireRoutePoint[];
  path: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const ORTHOGONAL_ROUTER_FLAG = avoidEnumValue(AVOID.RouterFlag.OrthogonalRouting);
const ORTHOGONAL_CONN_TYPE = avoidEnumValue(AVOID.ConnType.ConnType_Orthogonal);
const SHAPE_BUFFER_DISTANCE = avoidEnumValue(AVOID.RoutingParameter.shapeBufferDistance);
const IDEAL_NUDGING_DISTANCE = avoidEnumValue(AVOID.RoutingParameter.idealNudgingDistance);
const SPLINE_TANGENT_SCALE = 0.7;
const PORT_CHECKPOINT_OFFSET = 8;
const ROUTE_PADDING = 12;
const SIMPLE_CURVE_INTERSECTION_STEPS = 24;

function normalizePoints(points: WireRoutePoint[]) {
  const normalized: WireRoutePoint[] = [];
  for (const point of points) {
    const last = normalized[normalized.length - 1];
    if (last && last.x === point.x && last.y === point.y) {
      continue;
    }
    normalized.push(point);
  }
  return normalized;
}

function distance(fromPoint: WireRoutePoint, toPoint: WireRoutePoint) {
  return Math.hypot(toPoint.x - fromPoint.x, toPoint.y - fromPoint.y);
}

function addPoint(point: WireRoutePoint, other: WireRoutePoint, scale: number) {
  return {
    x: point.x + other.x * scale,
    y: point.y + other.y * scale,
  };
}

function subtractPoints(left: WireRoutePoint, right: WireRoutePoint) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
  };
}

function clampControlToSegmentDirection(
  control: WireRoutePoint,
  startPoint: WireRoutePoint,
  endPoint: WireRoutePoint,
) {
  if (startPoint.x === endPoint.x) {
    const minY = Math.min(startPoint.y, endPoint.y);
    const maxY = Math.max(startPoint.y, endPoint.y);
    return {
      x: control.x,
      y: Math.min(Math.max(control.y, minY), maxY),
    };
  }

  if (startPoint.y === endPoint.y) {
    const minX = Math.min(startPoint.x, endPoint.x);
    const maxX = Math.max(startPoint.x, endPoint.x);
    return {
      x: Math.min(Math.max(control.x, minX), maxX),
      y: control.y,
    };
  }

  return control;
}

function projectControlToSegmentLine(
  control: WireRoutePoint,
  startPoint: WireRoutePoint,
  endPoint: WireRoutePoint,
) {
  if (startPoint.x === endPoint.x) {
    const minY = Math.min(startPoint.y, endPoint.y);
    const maxY = Math.max(startPoint.y, endPoint.y);
    return {
      x: startPoint.x,
      y: Math.min(Math.max(control.y, minY), maxY),
    };
  }

  if (startPoint.y === endPoint.y) {
    const minX = Math.min(startPoint.x, endPoint.x);
    const maxX = Math.max(startPoint.x, endPoint.x);
    return {
      x: Math.min(Math.max(control.x, minX), maxX),
      y: startPoint.y,
    };
  }

  return control;
}

function tangentAtPoint(points: WireRoutePoint[], index: number) {
  if (index === 0) {
    return addPoint(
      { x: 0, y: 0 },
      subtractPoints(points[1], points[0]),
      SPLINE_TANGENT_SCALE,
    );
  }
  if (index === points.length - 1) {
    return addPoint(
      { x: 0, y: 0 },
      subtractPoints(points[index], points[index - 1]),
      SPLINE_TANGENT_SCALE,
    );
  }
  return addPoint(
    { x: 0, y: 0 },
    subtractPoints(points[index + 1], points[index - 1]),
    SPLINE_TANGENT_SCALE,
  );
}

function unitVector(fromPoint: WireRoutePoint, toPoint: WireRoutePoint) {
  const dx = toPoint.x - fromPoint.x;
  const dy = toPoint.y - fromPoint.y;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude === 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: dx / magnitude,
    y: dy / magnitude,
  };
}

function centeredSingleSegmentPath(
  startPoint: WireRoutePoint,
  endPoint: WireRoutePoint,
  startPort?: TilePort,
  endPort?: TilePort,
) {
  const midpoint = {
    x: (startPoint.x + endPoint.x) / 2,
    y: (startPoint.y + endPoint.y) / 2,
  };
  const segmentLength = distance(startPoint, endPoint);
  const endpointHandle = Math.min(Math.max(24, segmentLength * 0.24), segmentLength / 2);
  const midpointHandle = Math.min(Math.max(18, segmentLength * 0.14), segmentLength / 3);

  const startDirection = startPort ? portVector(startPort) : unitVector(startPoint, midpoint);
  const endDirection = endPort ? portVector(endPort) : unitVector(endPoint, midpoint);
  const rawMidpointDirection = {
    x: startDirection.x - endDirection.x,
    y: startDirection.y - endDirection.y,
  };
  const midpointDirection =
    rawMidpointDirection.x === 0 && rawMidpointDirection.y === 0
      ? unitVector(startPoint, endPoint)
      : unitVector({ x: 0, y: 0 }, rawMidpointDirection);

  const startControl = addPoint(startPoint, startDirection, endpointHandle);
  const midpointControlIn = addPoint(midpoint, midpointDirection, -midpointHandle);
  const midpointControlOut = addPoint(midpoint, midpointDirection, midpointHandle);
  const endControl = addPoint(endPoint, endDirection, endpointHandle);

  return [
    `M ${startPoint.x} ${startPoint.y}`,
    `C ${startControl.x} ${startControl.y} ${midpointControlIn.x} ${midpointControlIn.y} ${midpoint.x} ${midpoint.y}`,
    `C ${midpointControlOut.x} ${midpointControlOut.y} ${endControl.x} ${endControl.y} ${endPoint.x} ${endPoint.y}`,
  ].join(' ');
}

function centeredDirectPath(
  startPoint: WireRoutePoint,
  endPoint: WireRoutePoint,
  startPort?: TilePort,
  endPort?: TilePort,
) {
  return centeredSingleSegmentPath(startPoint, endPoint, startPort, endPort);
}

function pathFromPoints(points: WireRoutePoint[], startPort?: TilePort, endPort?: TilePort) {
  if (points.length === 0) {
    throw new Error('Cannot build a wire path without points.');
  }
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }
  if (points.length === 2) {
    return centeredDirectPath(points[0], points[1], startPort, endPort);
  }

  const commands = [`M ${points[0].x} ${points[0].y}`];

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    if (distance(current, next) === 0) {
      continue;
    }

    const control1 = clampControlToSegmentDirection(
      addPoint(current, tangentAtPoint(points, index), 1 / 3),
      current,
      next,
    );
    const control2 = clampControlToSegmentDirection(
      addPoint(next, tangentAtPoint(points, index + 1), -1 / 3),
      current,
      next,
    );

    const finalControl1 = index === 0
      ? projectControlToSegmentLine(control1, current, next)
      : control1;
    const finalControl2 = index === points.length - 2
      ? projectControlToSegmentLine(control2, current, next)
      : control2;

    commands.push(`C ${finalControl1.x} ${finalControl1.y} ${finalControl2.x} ${finalControl2.y} ${next.x} ${next.y}`);
  }
  return commands.join(' ');
}

function rectangleForRect(rect: WireRect) {
  return new AVOID.Rectangle(
    new AVOID.Point(rect.x + rect.width / 2, rect.y + rect.height / 2),
    rect.width,
    rect.height,
  );
}

function pointStrictlyInsideRect(point: WireRoutePoint, rect: WireRect) {
  return (
    point.x > rect.x
    && point.x < rect.x + rect.width
    && point.y > rect.y
    && point.y < rect.y + rect.height
  );
}

function segmentCrossesRectInterior(start: WireRoutePoint, end: WireRoutePoint, rect: WireRect) {
  if (pointStrictlyInsideRect(start, rect) || pointStrictlyInsideRect(end, rect)) {
    return true;
  }

  const xMin = rect.x;
  const xMax = rect.x + rect.width;
  const yMin = rect.y;
  const yMax = rect.y + rect.height;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let entry = 0;
  let exit = 1;

  const clip = (p: number, q: number) => {
    if (p === 0) {
      return q >= 0;
    }
    const ratio = q / p;
    if (p < 0) {
      if (ratio > exit) {
        return false;
      }
      if (ratio > entry) {
        entry = ratio;
      }
      return true;
    }
    if (ratio < entry) {
      return false;
    }
    if (ratio < exit) {
      exit = ratio;
    }
    return true;
  };

  if (!clip(-dx, start.x - xMin)) return false;
  if (!clip(dx, xMax - start.x)) return false;
  if (!clip(-dy, start.y - yMin)) return false;
  if (!clip(dy, yMax - start.y)) return false;
  if (entry > exit) return false;

  const midpoint = {
    x: start.x + dx * ((entry + exit) / 2),
    y: start.y + dy * ((entry + exit) / 2),
  };
  return pointStrictlyInsideRect(midpoint, rect);
}

function expandRect(rect: WireRect, padding: number): WireRect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function cubicBezierPoint(segment: CubicBezierSegment, progress: number): WireRoutePoint {
  const inverse = 1 - progress;
  const inverseSquared = inverse * inverse;
  const inverseCubed = inverseSquared * inverse;
  const progressSquared = progress * progress;
  const progressCubed = progressSquared * progress;
  return {
    x:
      inverseCubed * segment.startPoint.x
      + 3 * inverseSquared * progress * segment.control1.x
      + 3 * inverse * progressSquared * segment.control2.x
      + progressCubed * segment.endPoint.x,
    y:
      inverseCubed * segment.startPoint.y
      + 3 * inverseSquared * progress * segment.control1.y
      + 3 * inverse * progressSquared * segment.control2.y
      + progressCubed * segment.endPoint.y,
  };
}

function sampleCubicBezierSegment(segment: CubicBezierSegment) {
  return Array.from({ length: SIMPLE_CURVE_INTERSECTION_STEPS + 1 }, (_, index) =>
    cubicBezierPoint(segment, index / SIMPLE_CURVE_INTERSECTION_STEPS),
  );
}

function simpleCurveGeometry(spec: WireRouteSpec): RoutedWireGeometry {
  if (!spec.startPort || !spec.endPort) {
    throw new Error('Simple curve geometry requires both ports.');
  }

  const startPoint = { ...spec.startPoint };
  const endPoint = { ...spec.endPoint };
  const segment = simplePortCurveSegment(startPoint, spec.startPort, endPoint, spec.endPort);
  return {
    points: [startPoint, endPoint],
    path: cubicBezierPath(segment),
    x1: startPoint.x,
    y1: startPoint.y,
    x2: endPoint.x,
    y2: endPoint.y,
  };
}

function simpleCurveNeedsAvoidance(rects: Map<string, WireRect>, spec: WireRouteSpec) {
  if (!spec.startPort || !spec.endPort) {
    return true;
  }
  if (rects.size === 0) {
    return false;
  }
  if (!spec.startRectId || !spec.endRectId) {
    return true;
  }

  const segment = simplePortCurveSegment(spec.startPoint, spec.startPort, spec.endPoint, spec.endPort);
  const samples = sampleCubicBezierSegment(segment);
  for (const [rectId, rect] of rects) {
    if (rectId === spec.startRectId || rectId === spec.endRectId) {
      continue;
    }
    const paddedRect = expandRect(rect, ROUTE_PADDING);
    for (let index = 0; index < samples.length - 1; index += 1) {
      if (segmentCrossesRectInterior(samples[index], samples[index + 1], paddedRect)) {
        return true;
      }
    }
  }
  return false;
}

function routePointsForConnection(
  router: Avoid['Router'],
  spec: WireRouteSpec,
) {
  const connection = new AVOID.ConnRef(
    router,
    new AVOID.ConnEnd(new AVOID.Point(spec.startPoint.x, spec.startPoint.y)),
    new AVOID.ConnEnd(new AVOID.Point(spec.endPoint.x, spec.endPoint.y)),
  );
  connection.setRoutingType(ORTHOGONAL_CONN_TYPE);

  if (spec.startPort && spec.endPort) {
    const startDirection = portVector(spec.startPort);
    const endDirection = portVector(spec.endPort);
    const checkpoints = new AVOID.CheckpointVector();
    checkpoints.push_back(new AVOID.Checkpoint(
      new AVOID.Point(
        spec.startPoint.x + startDirection.x * PORT_CHECKPOINT_OFFSET,
        spec.startPoint.y + startDirection.y * PORT_CHECKPOINT_OFFSET,
      ),
    ));
    checkpoints.push_back(new AVOID.Checkpoint(
      new AVOID.Point(
        spec.endPoint.x + endDirection.x * PORT_CHECKPOINT_OFFSET,
        spec.endPoint.y + endDirection.y * PORT_CHECKPOINT_OFFSET,
      ),
    ));
    connection.setRoutingCheckpoints(checkpoints);
  }

  return connection;
}

export function routeWireGeometries(
  rects: Map<string, WireRect>,
  specs: WireRouteSpec[],
): Record<string, RoutedWireGeometry> {
  if (specs.length === 0) {
    return {};
  }

  const directGeometries = Object.fromEntries(specs.flatMap((spec) => {
    if (!spec.startPort || !spec.endPort || simpleCurveNeedsAvoidance(rects, spec)) {
      return [];
    }
    return [[spec.key, simpleCurveGeometry(spec)] satisfies [string, RoutedWireGeometry]];
  }));
  const routedSpecs = specs.filter((spec) => !(spec.key in directGeometries));
  if (routedSpecs.length === 0) {
    return directGeometries;
  }

  const router = new AVOID.Router(ORTHOGONAL_ROUTER_FLAG);
  router.setRoutingParameter(SHAPE_BUFFER_DISTANCE, ROUTE_PADDING);
  router.setRoutingParameter(IDEAL_NUDGING_DISTANCE, 16);

  for (const rect of rects.values()) {
    new AVOID.ShapeRef(router, rectangleForRect(rect));
  }

  const connections = routedSpecs.map((spec) => {
    return {
      key: spec.key,
      spec,
      connection: routePointsForConnection(router, spec),
    };
  });

  router.processTransaction();

  const geometries = Object.fromEntries(connections.map(({ key, spec, connection }) => {
    const route = connection.displayRoute();
    const points = normalizePoints(Array.from({ length: route.size() }, (_, index) => {
      const point = route.at(index);
      return { x: point.x, y: point.y };
    }));
    if (points.length < 2) {
      throw new Error(`Wire route "${key}" did not produce a valid path.`);
    }
    const [startPoint] = points;
    const endPoint = points[points.length - 1];
    return [key, {
      points,
      path: pathFromPoints(points, spec.startPort, spec.endPort),
      x1: startPoint.x,
      y1: startPoint.y,
      x2: endPoint.x,
      y2: endPoint.y,
    } satisfies RoutedWireGeometry];
  }));

  router.delete();
  return {
    ...directGeometries,
    ...geometries,
  };
}

export function portPoint(rect: WireRect, port: TilePort, visibleSlotCount = 1): WireRoutePoint {
  const ratio = tilePortOffsetRatio(port, visibleSlotCount);
  switch (tilePortSide(port)) {
    case 'left':
      return { x: rect.x, y: rect.y + rect.height * ratio };
    case 'top':
      return { x: rect.x + rect.width * ratio, y: rect.y };
    case 'right':
      return { x: rect.x + rect.width, y: rect.y + rect.height * ratio };
    case 'bottom':
      return { x: rect.x + rect.width * ratio, y: rect.y + rect.height };
  }
}
