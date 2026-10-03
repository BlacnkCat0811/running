import type { ShareCardRoutePoint } from "@rai/api-contracts";

/**
 * Privacy-zone trimming for share cards (docs/WEB.md, docs/DECISIONS.md D9).
 *
 * This is the **only** place a shared route is filtered, and it runs on the
 * server: the clients (browser canvas, iOS ImageRenderer) draw the polylines they
 * are given and never see the coordinates that were removed. Two implementations
 * of "hide my home" would be two chances to leak it.
 *
 * The failure this module exists to prevent is subtler than "don't draw the
 * start". Dropping the points inside a zone leaves a straight chord between the
 * two survivors — the card then shows a line straight through the house. So
 * segments are cut where they cross a circle, not merely pruned of their
 * endpoints.
 *
 * Geometry is done in a local equirectangular frame (metres) around each
 * zone's own centre: at the scale of a 5 km privacy zone the error is far below the
 * zone radius, and it keeps the intersection arithmetic a plain quadratic.
 */

export interface PrivacyZoneCircle {
  centerLatitude: number;
  centerLongitude: number;
  radiusMeters: number;
}

export interface RouteTrimResult {
  polylines: ShareCardRoutePoint[][];
  /** Points that fell inside a zone and were removed. */
  redactedPoints: number;
  /** Breaks in the drawn line caused by zones (see the contract's `gaps`). */
  gaps: number;
  zonesApplied: number;
}

const EARTH_METERS_PER_DEGREE_LATITUDE = 110_540;

const finitePoint = (point: ShareCardRoutePoint): boolean =>
  Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180;

/** Squared distance in metres inside the local frame. */
function squaredDistance(
  ax: number, ay: number, bx: number, by: number
): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Parameters `t ∈ [0,1]` where the segment `a→b` lies inside the circle, or null
 * when it never does. Outside-interval subtraction happens in the caller so that
 * overlapping zones are unioned before anything is cut.
 */
function insideInterval(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, radius: number
): [number, number] | null {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;

  if (a === 0) {
    // A degenerate segment is a point: inside or not, never "crossing".
    return c <= 0 ? [0, 1] : null;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const t0 = (-b - root) / (2 * a);
  const t1 = (-b + root) / (2 * a);
  const start = Math.max(0, Math.min(t0, t1));
  const end = Math.min(1, Math.max(t0, t1));
  return start <= end ? [start, end] : null;
}

/** Union of intervals, assumed to be produced without overlaps by the caller. */
function subtractIntervals(
  cuts: ReadonlyArray<[number, number]>
): Array<[number, number]> {
  const sorted = [...cuts].sort((left, right) => left[0] - right[0]);
  const pieces: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start > cursor) pieces.push([cursor, Math.min(start, 1)]);
    cursor = Math.max(cursor, end);
    if (cursor >= 1) break;
  }
  if (cursor < 1) pieces.push([cursor, 1]);
  return pieces.filter(([start, end]) => end - start > 1e-9);
}

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

const longitudeDelta = (degrees: number): number => ((degrees + 180) % 360 + 360) % 360 - 180;

/** Canonical coordinates without a drawable chord between +180 and -180. */
function splitAtDateline(points: ShareCardRoutePoint[]): ShareCardRoutePoint[][] {
  const result: ShareCardRoutePoint[][] = [];
  let offset = Math.floor((points[0]!.longitude + 180) / 360) * 360;
  let current = [{ ...points[0]!, longitude: points[0]!.longitude - offset }];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const longitude = b.longitude - offset;
    if (longitude > 180 || longitude < -180) {
      const boundary = longitude > 180 ? 180 : -180;
      const t = (boundary + offset - a.longitude) / (b.longitude - a.longitude);
      const latitude = lerp(a.latitude, b.latitude, t);
      current.push({ latitude, longitude: boundary });
      result.push(current);
      offset += boundary * 2;
      current = [{ latitude, longitude: -boundary }];
    }
    current.push({ ...b, longitude: b.longitude - offset });
  }
  if (current.length >= 2) result.push(current);
  return result;
}

/**
 * Removes everything inside any zone from a route, splitting the polyline where a
 * segment crosses a boundary.
 *
 * Returns polylines rather than one line with gaps so a renderer cannot
 * accidentally reconnect across a cut: the break is in the data structure, not in
 * a flag the drawing code has to remember to honour.
 */
export function trimRouteForShare(
  points: readonly ShareCardRoutePoint[],
  zones: readonly PrivacyZoneCircle[]
): RouteTrimResult {
  const usable = points.filter(finitePoint);
  const usableZones = zones.filter(
    (zone) =>
      Number.isFinite(zone.centerLatitude) && Number.isFinite(zone.centerLongitude) &&
      Number.isFinite(zone.radiusMeters) && zone.radiusMeters > 0 &&
      Math.abs(zone.centerLatitude) <= 90 && Math.abs(zone.centerLongitude) <= 180
  );
  if (usable.length === 0) {
    return { polylines: [], redactedPoints: 0, gaps: 0, zonesApplied: usableZones.length };
  }

  const referenceLongitude = usable[0]!.longitude;
  const unwrapped: ShareCardRoutePoint[] = [];
  for (const point of usable) {
    const previous = unwrapped.at(-1)?.longitude ?? referenceLongitude;
    const delta = point.longitude - previous;
    unwrapped.push({ ...point, longitude: previous + (Math.abs(delta) <= 180 ? delta : longitudeDelta(delta)) });
  }
  const circles = usableZones.map((zone) => ({
    latitude: zone.centerLatitude,
    longitude: referenceLongitude + longitudeDelta(zone.centerLongitude - referenceLongitude),
    metersPerDegreeLongitude: 111_320 * Math.cos((zone.centerLatitude * Math.PI) / 180),
    radius: zone.radiusMeters
  }));
  const insideAnyZone = (index: number): boolean =>
    circles.some((circle) => squaredDistance(
      longitudeDelta(unwrapped[index]!.longitude - circle.longitude) * circle.metersPerDegreeLongitude,
      (unwrapped[index]!.latitude - circle.latitude) * EARTH_METERS_PER_DEGREE_LATITUDE,
      0, 0
    ) <= circle.radius ** 2);

  let redactedPoints = 0;
  usable.forEach((_, index) => {
    const inside = insideAnyZone(index);
    if (inside) redactedPoints += 1;
  });

  const polylines: ShareCardRoutePoint[][] = [];
  let current: ShareCardRoutePoint[] = [];
  /** True while `current` ends exactly at the start of the segment being walked. */
  let open = false;
  const closeCurrent = (): void => {
    if (current.length >= 2) polylines.push(current);
    current = [];
    open = false;
  };

  for (let index = 0; index < usable.length - 1; index += 1) {
    const a = unwrapped[index]!;
    const b = unwrapped[index + 1]!;
    const cuts: Array<[number, number]> = [];
    for (const circle of circles) {
      // Pick the zone's nearest longitude copy for this unwrapped segment.
      const centerLongitude = circle.longitude + Math.round(((a.longitude + b.longitude) / 2 - circle.longitude) / 360) * 360;
      const interval = insideInterval(
        (a.longitude - centerLongitude) * circle.metersPerDegreeLongitude,
        (a.latitude - circle.latitude) * EARTH_METERS_PER_DEGREE_LATITUDE,
        (b.longitude - centerLongitude) * circle.metersPerDegreeLongitude,
        (b.latitude - circle.latitude) * EARTH_METERS_PER_DEGREE_LATITUDE,
        0, 0, circle.radius
      );
      if (interval !== null) cuts.push(interval);
    }

    // No cut: the whole segment is drawn, and it continues whatever came before.
    const pieces: Array<[number, number]> = cuts.length === 0 ? [[0, 1]] : subtractIntervals(cuts);
    if (pieces.length === 0) {
      // Entirely inside a zone: nothing to draw, and the line must break here.
      closeCurrent();
      continue;
    }

    pieces.forEach(([pieceStart, pieceEnd], pieceIndex) => {
      const startsAtSegmentStart = pieceStart <= 1e-9;
      // A piece that does not begin where the previous drawing stopped must start a
      // new polyline: reconnecting across the gap is the chord-through-the-house bug.
      if (pieceIndex > 0 || !startsAtSegmentStart) closeCurrent();
      const from = { latitude: lerp(a.latitude, b.latitude, pieceStart), longitude: lerp(a.longitude, b.longitude, pieceStart) };
      const to = { latitude: lerp(a.latitude, b.latitude, pieceEnd), longitude: lerp(a.longitude, b.longitude, pieceEnd) };
      if (!open) current = [from];
      current.push(to);
      if (pieceEnd >= 1 - 1e-9) {
        open = true;
      } else {
        closeCurrent();
      }
    });
  }
  closeCurrent();

  // A single surviving point cannot be drawn as a route, and reporting it as one
  // would suggest the card shows more than it does.
  return {
    polylines: polylines.flatMap(splitAtDateline),
    redactedPoints,
    // What a reader needs in order to interpret a broken line on the card.
    gaps: Math.max(0, polylines.length - 1),
    zonesApplied: usableZones.length
  };
}
