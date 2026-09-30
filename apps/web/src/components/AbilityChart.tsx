import type { TrendResponse } from "@rai/api-contracts";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { useLocation, useNavigate } from "react-router-dom";

import { shortDate } from "../format.js";

interface ChartDatum {
  date: string;
  ta: number | null;
  ca: number | null;
  confidence: number | null;
  decay: number;
}

interface CaDatum {
  id: string;
  date: string;
  ca: number | null;
  confidence: number | null;
  assessmentStatus: string;
  modelVersion: string;
}

function CaDot({ onActivate, ...props }: { onActivate: (id: string) => void } & Record<string, unknown>) {
  const { cx, cy, payload } = props as { cx?: number; cy?: number; payload?: CaDatum };
  if (cx === undefined || cy === undefined || !payload) return null;
  const lowConfidence = (payload.confidence ?? 0) < 0.6;
  const activate = () => onActivate(payload.id);
  return <circle
    className="ability-ca-dot"
    cx={cx}
    cy={cy}
    r={lowConfidence ? 4.5 : 4}
    fill={lowConfidence ? "#fff8e9" : "#d86a53"}
    stroke={lowConfidence ? "#b96f18" : "#d86a53"}
    strokeWidth={lowConfidence ? 2 : 1}
    onClick={activate}
  />;
}

function AbilityTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: unknown; payload?: Record<string, unknown> }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const source = payload.find((item) => typeof item.payload?.ca === "number")?.payload;
  return <div className="chart-tooltip"><b>{String(source?.date ?? label ?? "")}</b>{source ? <><span>即时能力 CA：{Number(source.ca).toFixed(2)}</span><span>置信度：{source.confidence === null ? "--" : `${Math.round(Number(source.confidence) * 100)}%`}</span><span>状态：{String(source.assessmentStatus)}</span><span>模型：{String(source.modelVersion)}</span></> : payload.map((item) => <span key={item.name}>{item.name}：{typeof item.value === "number" ? item.value.toFixed(2) : String(item.value ?? "--")}</span>)}</div>;
}

export function activeTrendModelVersion(trend: TrendResponse): string {
  return trend.modelRuns.find((run) => run.active)?.modelVersion ?? "--";
}

/** 图表用的 daily 点（含跨 epoch 断线标记），抽成纯函数以便直接断言"没有跨 epoch 的连线"。 */
export function trendChartSeries(daily: TrendResponse["daily"]): ChartDatum[] {
  return daily.map((point, index) => ({
    date: point.date,
    // 换标尺后的第一个点从 `null` 开始：曲线断开，而不是把两个 epoch 连成一段涨跌。
    ta: index > 0 && point.baselineEpochId !== daily[index - 1]?.baselineEpochId ? null : point.trueAbility,
    ca: null,
    confidence: null,
    decay: point.decayPoints
  }));
}

export interface TrendEpochSegment {
  epochId: string | null;
  start: string;
  end: string;
}

/** 连续同 epoch 的日期区间。`null` 是一种合法的 epoch 值（未知），不是"等于上一个"。 */
export function trendEpochSegments(daily: TrendResponse["daily"]): TrendEpochSegment[] {
  const segments: TrendEpochSegment[] = [];
  for (const point of daily) {
    const epochId = point.baselineEpochId ?? null;
    const current = segments.at(-1);
    if (current && current.epochId === epochId) current.end = point.date;
    else segments.push({ epochId, start: point.date, end: point.date });
  }
  return segments;
}

/** epoch 切换点（切换当日的日期）。分段展示与文案都由它驱动。 */
export function trendEpochBoundaries(daily: TrendResponse["daily"]): string[] {
  return trendEpochSegments(daily).slice(1).map((segment) => segment.start);
}

/** `snapshot_status === "calibrating"` 的连续区间：标尺尚未定型，与"能力下跌"不是一回事。 */
export function trendCalibratingRanges(daily: TrendResponse["daily"]): Array<{ start: string; end: string }> {
  const ranges: Array<{ start: string; end: string }> = [];
  for (const point of daily) {
    if (point.status !== "calibrating") continue;
    const current = ranges.at(-1);
    if (current && new Date(`${point.date}T00:00:00Z`).getTime() - new Date(`${current.end}T00:00:00Z`).getTime() <= 86_400_000) {
      current.end = point.date;
    } else {
      ranges.push({ start: point.date, end: point.date });
    }
  }
  return ranges;
}

export function AbilityChart({ trend, height = 300, showTa = true, showCa = true }: { trend: TrendResponse; height?: number; showTa?: boolean; showCa?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const openWorkout = (id: string) => void navigate(`/workouts/${id}`, { state: { from: `${location.pathname}${location.search}` } });
  const data: ChartDatum[] = trendChartSeries(trend.daily);
  const activeModelVersion = activeTrendModelVersion(trend);
  const caData: CaDatum[] = trend.workouts.filter((workout) => workout.currentAbility !== null).map((workout) => ({
    id: workout.id,
    date: workout.date.slice(0, 10),
    ca: workout.currentAbility,
    confidence: workout.confidence,
    assessmentStatus: workout.assessmentStatus,
    modelVersion: activeModelVersion
  }));
  const decayRanges: Array<{ start: string; end: string }> = [];
  for (const point of trend.daily) {
    if (point.decayPoints <= 0) continue;
    const current = decayRanges.at(-1);
    if (current && new Date(`${point.date}T00:00:00Z`).getTime() - new Date(`${current.end}T00:00:00Z`).getTime() <= 86_400_000) current.end = point.date;
    else decayRanges.push({ start: point.date, end: point.date });
  }
  const epochSegments = trendEpochSegments(trend.daily);
  const epochBoundaries = trendEpochBoundaries(trend.daily);
  const calibratingRanges = trendCalibratingRanges(trend.daily);
  return (
    <>
      <div className="ability-chart" style={{ height }} role="region" aria-label={`能力趋势：${trend.startDate ?? "--"} 至 ${trend.endDate ?? "--"}，${trend.workouts.length} 次训练`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="#dfe5df" strokeDasharray="2 6" />
            <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: "#6d786f", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={32} />
            <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} width={36} tick={{ fill: "#6d786f", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip content={<AbilityTooltip />} />
            {/* 换了标尺之后的区段整体加底色：两侧一眼可分，不用去读刻度。 */}
            {epochSegments.slice(1).map((segment) => (
              <ReferenceArea key={`epoch-${segment.start}`} x1={segment.start} x2={segment.end} fill="#6d786f" fillOpacity={0.06} strokeOpacity={0} />
            ))}
            {calibratingRanges.map((range) => <ReferenceArea key={`calibrating-${range.start}-${range.end}`} x1={range.start} x2={range.end} fill="#8d7bd8" fillOpacity={0.1} strokeOpacity={0} />)}
            {decayRanges.map((range) => <ReferenceArea key={`${range.start}-${range.end}`} x1={range.start} x2={range.end} fill="#d99a3d" fillOpacity={0.12} strokeOpacity={0} />)}
            {epochBoundaries.map((date) => (
              <ReferenceLine key={`epoch-line-${date}`} x={date} stroke="#6d786f" strokeWidth={1.6} label={{ value: "基线重建", position: "insideTopLeft", fontSize: 9, fill: "#6d786f" }} />
            ))}
            {trend.modelRuns.map((run) => <ReferenceLine key={run.id} x={run.date.slice(0, 10)} stroke="#89938c" strokeDasharray="3 4" label={{ value: run.active ? "当前模型" : "模型运行", position: "insideTopRight", fontSize: 9, fill: "#6d786f" }} />)}
            {showTa ? <Line type="monotone" dataKey="ta" name="真实跑力 TA" stroke="#1f6d4c" strokeWidth={2.2} dot={false} connectNulls={false} /> : null}
            {showCa ? <Scatter data={caData} dataKey="ca" name="即时能力 CA" shape={<CaDot onActivate={openWorkout} />} fill="#d86a53" cursor="pointer" /> : null}
          </ComposedChart>
        </ResponsiveContainer>
        {showCa && caData.length > 0 ? <details className="ability-chart-data">
          <summary>浏览即时能力训练点（{caData.length}）</summary>
          <div className="ability-chart-data-list" role="list" aria-label="即时能力训练点">
            {caData.map((point) => <div key={point.id} role="listitem"><a
                href={`/workouts/${point.id}`}
                aria-label={`${point.date}，即时能力 CA ${point.ca?.toFixed(2) ?? "--"}，置信度 ${point.confidence === null ? "--" : `${Math.round(point.confidence * 100)}%`}，查看训练详情`}
                onClick={(event) => {
                  event.preventDefault();
                  openWorkout(point.id);
                }}
              >{point.date} · CA {point.ca?.toFixed(2) ?? "--"}</a></div>)}
          </div>
        </details> : null}
      </div>
      {epochBoundaries.length > 0 ? (
        <p className="ability-chart-epoch-note">
          此处基线重建（{epochBoundaries.join("、")}）：分数标尺已变，不代表该日体能突变；两侧不可直接比较，也不跨基线计算区间涨跌。
        </p>
      ) : null}
      {calibratingRanges.length > 0 ? (
        <p className="ability-chart-epoch-note">
          紫色区间为重新校准期（{calibratingRanges.map((range) => range.start === range.end ? range.start : `${range.start} 至 ${range.end}`).join("、")}）：样本仍在积累，分数尚未定型。
        </p>
      ) : null}
    </>
  );
}
