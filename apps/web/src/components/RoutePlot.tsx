import type { RoutePointDto } from "@rai/api-contracts";

export interface KilometerMark {
  latitude: number;
  longitude: number;
  kilometer: number;
}

export const MAX_ROUTE_KILOMETER_MARKS = 200;
const MAX_ROUTE_SEGMENT_METERS = 25_000;

function validCoordinate(point: RoutePointDto): boolean {
  return Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= -90 && point.latitude <= 90 &&
    point.longitude >= -180 && point.longitude <= 180;
}

function distanceMeters(left: RoutePointDto, right: RoutePointDto): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(right.latitude - left.latitude);
  const dLon = radians(right.longitude - left.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routeSegments(points: RoutePointDto[]): Array<{
  from: RoutePointDto;
  to: RoutePointDto;
}> {
  const segments: Array<{ from: RoutePointDto; to: RoutePointDto }> = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (!from || !to || !validCoordinate(from) || !validCoordinate(to)) continue;
    const distance = distanceMeters(from, to);
    if (!Number.isFinite(distance) || distance <= 0 || distance > MAX_ROUTE_SEGMENT_METERS) continue;
    segments.push({ from, to });
  }
  return segments;
}

export function buildKilometerMarks(points: RoutePointDto[]): KilometerMark[] {
  const marks: KilometerMark[] = [];
  let cumulative = 0;
  let nextKilometer = 1;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current || !validCoordinate(previous) || !validCoordinate(current)) continue;
    const segmentDistance = distanceMeters(previous, current);
    if (!Number.isFinite(segmentDistance) || segmentDistance <= 0 || segmentDistance > MAX_ROUTE_SEGMENT_METERS) continue;
    while (
      cumulative + segmentDistance >= nextKilometer * 1000 &&
      marks.length < MAX_ROUTE_KILOMETER_MARKS
    ) {
      const fraction = (nextKilometer * 1000 - cumulative) / segmentDistance;
      marks.push({
        latitude: previous.latitude + (current.latitude - previous.latitude) * fraction,
        longitude: previous.longitude + (current.longitude - previous.longitude) * fraction,
        kilometer: nextKilometer,
      });
      nextKilometer += 1;
    }
    cumulative += segmentDistance;
    if (marks.length >= MAX_ROUTE_KILOMETER_MARKS) break;
  }
  return marks;
}

export function RoutePlot({ points }: { points: RoutePointDto[] }) {
  const segments = routeSegments(points);
  if (segments.length === 0) return <div className="route-empty">这次训练没有可用路线</div>;
  const routePoints = segments.flatMap((segment) => [segment.from, segment.to]);
  const latitudes = routePoints.map((point) => point.latitude);
  const longitudes = routePoints.map((point) => point.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const width = Math.max(maxLon - minLon, 0.00001);
  const height = Math.max(maxLat - minLat, 0.00001);
  const project = (point: RoutePointDto) => {
    const x = 24 + ((point.longitude - minLon) / width) * 752;
    const y = 24 + (1 - (point.latitude - minLat) / height) * 272;
    return { x, y, point };
  };
  const projectedSegments = segments.map((segment) => ({
    from: project(segment.from),
    to: project(segment.to),
  }));
  const kilometerMarks = buildKilometerMarks(points).map((mark) => ({
    x: 24 + ((mark.longitude - minLon) / width) * 752,
    y: 24 + (1 - (mark.latitude - minLat) / height) * 272,
    kilometer: mark.kilometer,
  }));
  const speeds = routePoints.map((point) => point.speedMetersPerSecond).filter((value): value is number => value !== null && value > 0);
  const minSpeed = speeds.length ? Math.min(...speeds) : null;
  const maxSpeed = speeds.length ? Math.max(...speeds) : null;
  const segmentColor = (speed: number | null): string => {
    if (speed === null || minSpeed === null || maxSpeed === null || maxSpeed === minSpeed) return "#1f6d4c";
    const ratio = Math.max(0, Math.min(1, (speed - minSpeed) / (maxSpeed - minSpeed)));
    return `hsl(${18 + ratio * 125} 48% ${44 - ratio * 8}%)`;
  };
  const first = projectedSegments[0]?.from;
  const last = projectedSegments.at(-1)?.to;
  return (
    <svg className="route-plot" viewBox="0 0 800 320" role="img" aria-label="跑步路线">
      <rect x="0" y="0" width="800" height="320" rx="6" fill="#edf2ee" />
      {projectedSegments.map((segment, index) => (
        <line key={index} x1={segment.from.x} y1={segment.from.y} x2={segment.to.x} y2={segment.to.y} stroke={segmentColor(segment.to.point.speedMetersPerSecond)} strokeWidth="4" strokeLinecap="round" />
      ))}
      {kilometerMarks.map((mark) => <g key={mark.kilometer}><circle cx={mark.x} cy={mark.y} r="8" fill="#ffffff" stroke="#647268" strokeWidth="1.5" /><text x={mark.x} y={mark.y + 3} textAnchor="middle" fontSize="8" fill="#334239">{mark.kilometer}</text></g>)}
      {first ? <g><circle cx={first.x} cy={first.y} r="7" fill="#1f6d4c" /><text x={first.x + 11} y={first.y - 8} fontSize="10" fill="#1f6d4c">起点</text></g> : null}
      {last ? <g><circle cx={last.x} cy={last.y} r="7" fill="#d86a53" /><text x={last.x + 11} y={last.y + 15} fontSize="10" fill="#a84d3a">终点</text></g> : null}
      {speeds.length ? <text x="776" y="302" textAnchor="end" fontSize="9" fill="#6d786f">轨迹颜色：慢 → 快</text> : null}
    </svg>
  );
}
