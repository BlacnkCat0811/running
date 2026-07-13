import type { TrendResponse } from "@rai/api-contracts";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { shortDate } from "../format.js";

export function DimensionTrendChart({ trend }: { trend: TrendResponse }) {
  const data = trend.workouts.filter((workout) => Object.values(workout.dimensions).some((value) => value !== null)).map((workout) => ({
    date: workout.date.slice(0, 10),
    Efficiency: workout.dimensions.efficiency,
    Pace: workout.dimensions.pace,
    Cardio: workout.dimensions.cardio,
    Stability: workout.dimensions.stability,
    Recovery: workout.dimensions.recovery
  }));
  if (data.length < 2) return <div className="series-empty">当前范围没有足够的维度评分用于趋势比较。</div>;
  return <div className="trend-secondary-chart" role="img" aria-label={`五维即时能力趋势，共 ${data.length} 次可评分训练`}><ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}><CartesianGrid vertical={false} stroke="#e1e6e1" strokeDasharray="2 6" /><XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 9, fill: "#748078" }} tickLine={false} axisLine={false} minTickGap={32} /><YAxis domain={[0, 100]} width={34} tick={{ fontSize: 9, fill: "#748078" }} tickLine={false} axisLine={false} /><Tooltip /><Legend wrapperStyle={{ fontSize: 10 }} /><Line type="monotone" dataKey="Efficiency" stroke="#1f6d4c" dot={false} connectNulls /><Line type="monotone" dataKey="Pace" stroke="#d86a53" dot={false} connectNulls /><Line type="monotone" dataKey="Stability" stroke="#3c6e9d" dot={false} connectNulls /><Line type="monotone" dataKey="Recovery" stroke="#a96c19" dot={false} connectNulls /><Line type="monotone" dataKey="Cardio" stroke="#8b7aa9" strokeDasharray="4 4" dot={false} connectNulls /></LineChart></ResponsiveContainer></div>;
}

export function TrainingContextChart({ trend, showVolume, showLoad }: { trend: TrendResponse; showVolume: boolean; showLoad: boolean }) {
  const source = trend.context;
  const bucketSize = source.length > 180 ? 7 : 1;
  const data = [] as Array<{ date: string; distanceKm: number; durationMinutes: number; trainingLoad: number }>;
  for (let index = 0; index < source.length; index += bucketSize) {
    const bucket = source.slice(index, index + bucketSize);
    const first = bucket[0];
    if (!first) continue;
    data.push({
      date: first.date,
      distanceKm: bucket.reduce((sum, item) => sum + item.distanceKm, 0),
      durationMinutes: bucket.reduce((sum, item) => sum + item.durationMinutes, 0),
      trainingLoad: bucket.reduce((sum, item) => sum + item.trainingLoad, 0)
    });
  }
  if (!showVolume && !showLoad) return <div className="series-empty">打开“跑量”或“负荷”图层查看训练上下文。</div>;
  return <div className="trend-secondary-chart" role="img" aria-label={`训练上下文，共 ${source.length} 个训练日`}><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}><CartesianGrid vertical={false} stroke="#e1e6e1" /><XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 9, fill: "#748078" }} tickLine={false} axisLine={false} minTickGap={32} /><YAxis width={34} tick={{ fontSize: 9, fill: "#748078" }} tickLine={false} axisLine={false} /><Tooltip /><Legend wrapperStyle={{ fontSize: 10 }} />{showVolume ? <Bar dataKey="distanceKm" name="跑量 km" fill="#8bb39c" radius={[2, 2, 0, 0]} /> : null}{showLoad ? <Bar dataKey="trainingLoad" name="训练负荷" fill="#d9a15c" radius={[2, 2, 0, 0]} /> : null}</BarChart></ResponsiveContainer></div>;
}
