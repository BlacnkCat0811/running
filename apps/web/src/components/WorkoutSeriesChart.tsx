import type { WorkoutMetricSeries } from "@rai/api-contracts";
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const minute = (seconds: number): string => `${Math.round(seconds / 60)}′`;

export interface SeriesReferenceBand {
  label: string;
  lower: number | null;
  upper: number | null;
  color: string;
}

export function WorkoutSeriesChart({ title, series, color, bands = [] }: {
  title: string;
  series: WorkoutMetricSeries;
  color: string;
  bands?: SeriesReferenceBand[];
}) {
  const values = series.points.map((point) => point.value);
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 1;
  return (
    <article className="series-chart">
      <header><span>{title}</span><b>{series.totalSamples.toLocaleString("zh-CN")} 个样本</b></header>
      {series.points.length > 1 ? <ResponsiveContainer width="100%" height={180}><LineChart syncId="workout-series" data={series.points} margin={{ top: 10, right: 10, bottom: 0, left: -10 }}><CartesianGrid stroke="#e1e6e1" vertical={false} />{bands.map((band) => <ReferenceArea key={band.label} y1={band.lower ?? minimum} y2={band.upper ?? maximum} fill={band.color} fillOpacity={0.32} ifOverflow="hidden" />)}<XAxis dataKey="offsetSeconds" tickFormatter={minute} tick={{ fontSize: 9, fill: "#748078" }} tickLine={false} axisLine={false} minTickGap={28} /><YAxis domain={["auto", "auto"]} tick={{ fontSize: 9, fill: "#748078" }} tickLine={false} axisLine={false} width={42} /><Tooltip formatter={(value) => [`${Number(value).toFixed(1)} ${series.unit}`, title]} labelFormatter={(value) => `训练 ${minute(Number(value))}`} contentStyle={{ borderRadius: 6, borderColor: "#d9dfd9", fontSize: 11 }} /><Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.7} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer> : <div className="series-empty">该训练没有足够的 {title} Record。</div>}
    </article>
  );
}
