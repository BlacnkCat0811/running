import type { RoutePointDto } from "@rai/api-contracts";

export function RoutePlot({ points }: { points: RoutePointDto[] }) {
  if (points.length < 2) return <div className="route-empty">这次训练没有可用路线</div>;
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const width = Math.max(maxLon - minLon, 0.00001);
  const height = Math.max(maxLat - minLat, 0.00001);
  const projected = points.map((point) => {
    const x = 24 + ((point.longitude - minLon) / width) * 752;
    const y = 24 + (1 - (point.latitude - minLat) / height) * 272;
    return { x, y, point };
  });
  const distanceMeters = (left: RoutePointDto, right: RoutePointDto): number => {
    const radians = (value: number) => value * Math.PI / 180;
    const dLat = radians(right.latitude - left.latitude);
    const dLon = radians(right.longitude - left.longitude);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };
  const kilometerMarks: Array<{ x: number; y: number; kilometer: number }> = [];
  let cumulative = 0;
  let nextKilometer = 1;
  for (let index = 1; index < projected.length; index += 1) {
    const previous = projected[index - 1];
    const current = projected[index];
    if (!previous || !current) continue;
    cumulative += distanceMeters(previous.point, current.point);
    if (cumulative >= nextKilometer * 1000) {
      kilometerMarks.push({ x: current.x, y: current.y, kilometer: nextKilometer });
      nextKilometer += 1;
    }
  }
  const speeds = points.map((point) => point.speedMetersPerSecond).filter((value): value is number => value !== null && value > 0);
  const minSpeed = speeds.length ? Math.min(...speeds) : null;
  const maxSpeed = speeds.length ? Math.max(...speeds) : null;
  const segmentColor = (speed: number | null): string => {
    if (speed === null || minSpeed === null || maxSpeed === null || maxSpeed === minSpeed) return "#1f6d4c";
    const ratio = Math.max(0, Math.min(1, (speed - minSpeed) / (maxSpeed - minSpeed)));
    return `hsl(${18 + ratio * 125} 48% ${44 - ratio * 8}%)`;
  };
  const first = projected[0];
  const last = projected.at(-1);
  return (
    <svg className="route-plot" viewBox="0 0 800 320" role="img" aria-label="跑步路线">
      <rect x="0" y="0" width="800" height="320" rx="6" fill="#edf2ee" />
      {projected.slice(1).map((current, index) => {
        const previous = projected[index];
        if (!previous) return null;
        return <line key={index} x1={previous.x} y1={previous.y} x2={current.x} y2={current.y} stroke={segmentColor(current.point.speedMetersPerSecond)} strokeWidth="4" strokeLinecap="round" />;
      })}
      {kilometerMarks.map((mark) => <g key={mark.kilometer}><circle cx={mark.x} cy={mark.y} r="8" fill="#ffffff" stroke="#647268" strokeWidth="1.5" /><text x={mark.x} y={mark.y + 3} textAnchor="middle" fontSize="8" fill="#334239">{mark.kilometer}</text></g>)}
      {first ? <g><circle cx={first.x} cy={first.y} r="7" fill="#1f6d4c" /><text x={first.x + 11} y={first.y - 8} fontSize="10" fill="#1f6d4c">起点</text></g> : null}
      {last ? <g><circle cx={last.x} cy={last.y} r="7" fill="#d86a53" /><text x={last.x + 11} y={last.y + 15} fontSize="10" fill="#a84d3a">终点</text></g> : null}
      {speeds.length ? <text x="776" y="302" textAnchor="end" fontSize="9" fill="#6d786f">轨迹颜色：慢 → 快</text> : null}
    </svg>
  );
}
