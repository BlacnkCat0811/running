import type { TrendResponse } from "@rai/api-contracts";
import {
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { shortDate } from "../format.js";

interface DashboardTrendPoint {
  date: string;
  endurance: number | null;
  intensity: number | null;
  pace: number | null;
}

function average(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : null;
}

export function buildDashboardTrendPoints(trend: TrendResponse): DashboardTrendPoint[] {
  const byDate = new Map<
    string,
    { endurance: Array<number | null>; pace: Array<number | null> }
  >();
  for (const workout of trend.workouts) {
    const date = workout.date.slice(0, 10);
    const current = byDate.get(date) ?? { endurance: [], pace: [] };
    current.endurance.push(workout.dimensions.stability);
    current.pace.push(workout.dimensions.pace);
    byDate.set(date, current);
  }
  const loads = new Map(
    trend.context.map((item) => [item.date, item.trainingLoad]),
  );
  return [...byDate.entries()].map(([date, values]) => ({
    date,
    endurance: average(values.endurance),
    intensity: loads.get(date) ?? null,
    pace: average(values.pace),
  }));
}

export function trainingLoadAxisMaximum(points: DashboardTrendPoint[]): number {
  const maximum = Math.max(0, ...points.map((point) => point.intensity ?? 0));
  if (maximum <= 100) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const step = magnitude / 2;
  return Math.ceil(maximum / step) * step;
}

function PixelDot(props: Record<string, unknown>) {
  const { cx, cy, stroke } = props as {
    cx?: number;
    cy?: number;
    stroke?: string;
  };
  if (cx === undefined || cy === undefined) return null;
  return (
    <rect
      x={cx - 3}
      y={cy - 3}
      width={6}
      height={6}
      fill="#fffef8"
      stroke={stroke}
      strokeWidth={2}
      shapeRendering="crispEdges"
    />
  );
}

function roundedLabel(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : "";
}

export function DashboardPerformanceChart({ trend }: { trend: TrendResponse }) {
  const data = buildDashboardTrendPoints(trend);
  if (!data.length) return <div className="series-empty">暂无近四周训练趋势。</div>;
  const loadMaximum = trainingLoadAxisMaximum(data);
  return (
    <div className="dashboard-performance-chart" role="img" aria-label="近四周跑步能力趋势">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 14, right: 0, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="#c9d6c9" strokeDasharray="3 4" />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            tick={{ fill: "#486452", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#247446" }}
          />
          <YAxis
            yAxisId="score"
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            width={34}
            tick={{ fill: "#486452", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#247446" }}
          />
          <YAxis
            yAxisId="load"
            orientation="right"
            domain={[0, loadMaximum]}
            width={42}
            tick={{ fill: "#9d4c3d", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#ed6549" }}
          />
          <Tooltip
            formatter={(value, name) => [
              String(name) === "训练负荷"
                ? `${Number(value).toFixed(1)} 负荷`
                : `${Number(value).toFixed(1)} /100`,
              String(name),
            ]}
            labelFormatter={(value) => String(value)}
          />
          <Line
            type="stepAfter"
            yAxisId="score"
            dataKey="endurance"
            name="耐力稳定性"
            stroke="#2f9855"
            strokeWidth={2.2}
            dot={<PixelDot />}
            connectNulls
          ><LabelList dataKey="endurance" position="bottom" fill="#2f9855" fontSize={9} formatter={roundedLabel} /></Line>
          <Line
            type="stepAfter"
            yAxisId="load"
            dataKey="intensity"
            name="训练负荷"
            stroke="#ed6549"
            strokeWidth={2.2}
            dot={<PixelDot />}
            connectNulls
          ><LabelList dataKey="intensity" position="top" fill="#ed6549" fontSize={9} formatter={roundedLabel} /></Line>
          <Line
            type="stepAfter"
            yAxisId="score"
            dataKey="pace"
            name="配速能力"
            stroke="#3aa6c6"
            strokeWidth={2.2}
            dot={<PixelDot />}
            connectNulls
          ><LabelList dataKey="pace" position="top" fill="#3aa6c6" fontSize={9} formatter={roundedLabel} /></Line>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
