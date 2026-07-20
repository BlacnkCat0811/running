import "../pixel-layout.css";
import "../analysis-reference.css";
import type { TrendResponse } from "@rai/api-contracts";
import { useState } from "react";
import { Link } from "react-router-dom";

import { AbilityChart } from "../components/AbilityChart.js";
import {
  DimensionTrendChart,
  TrainingContextChart,
} from "../components/TrendAnalysisCharts.js";
import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { date, number } from "../format.js";
import { useRemote } from "../hooks.js";
import { ChartLine, Pulse, ShieldCheck, TrendUp } from "../icons.js";

const ranges = [
  { label: "28 天", days: 28 },
  { label: "90 天", days: 90 },
  { label: "180 天", days: 180 },
  { label: "1 年", days: 365 },
];

export function TrendsPage() {
  const [days, setDays] = useState(90);
  const [layers, setLayers] = useState({
    ta: true,
    ca: true,
    volume: true,
    load: true,
  });
  const result = useRemote<TrendResponse>(`/v1/trends?days=${days}`);
  const data = result.data;
  const caValues =
    data?.workouts
      .map((workout) => workout.currentAbility)
      .filter((value): value is number => value !== null) ?? [];
  const confidenceValues =
    data?.workouts
      .map((workout) => workout.confidence)
      .filter((value): value is number => value !== null) ?? [];
  const caMin = caValues.length ? Math.min(...caValues) : null;
  const caMax = caValues.length ? Math.max(...caValues) : null;
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) /
      confidenceValues.length
    : null;
  const sampleCount = data?.workouts.length ?? 0;
  const dataStatus = sampleCount === 0
    ? "数据不足"
    : sampleCount < 3
      ? "样本有限"
      : "数据充足";
  const calculationStatus = confidence === null
    ? "稳定性待评估"
    : confidence >= 0.8 && sampleCount >= 3
      ? "计算稳定"
      : "置信度偏低";
  const latest = data?.daily.at(-1) ?? null;
  const first = data?.daily.find((point) => point.trueAbility !== null) ?? null;
  const taDelta =
    latest?.trueAbility !== null &&
    latest?.trueAbility !== undefined &&
    first?.trueAbility !== null &&
    first?.trueAbility !== undefined
      ? latest.trueAbility - first.trueAbility
      : null;

  return (
    <div className="page trends-page trends-reference-layout">
      <header className="page-header split trends-reference-header">
        <div className="trends-title-block">
          <ChartLine size={38} />
          <div>
            <h1>能力趋势</h1>
            <p>观察真实跑力、即时能力、成长速度和数据稳定性。</p>
          </div>
        </div>
        <div className="segmented" role="group" aria-label="趋势时间范围">
          {ranges.map((range) => (
            <button
              type="button"
              key={range.days}
              className={days === range.days ? "active" : ""}
              aria-pressed={days === range.days}
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </header>

      {result.loading ? (
        <LoadingBlock />
      ) : result.error || !data ? (
        <ErrorBlock
          message={result.error ?? "没有趋势数据"}
          onRetry={() => void result.reload()}
        />
      ) : (
        <>
          <section className="trend-summary-grid trend-reference-summary">
            <TrendMetric
              icon={<ChartLine size={34} />}
              label="真实跑力 TA"
              value={number(latest?.trueAbility ?? null)}
              note={taDelta === null ? "区间变化不可用" : `区间 ${taDelta >= 0 ? "+" : ""}${taDelta.toFixed(2)}`}
              tone="ta"
            />
            <TrendMetric
              icon={<Pulse size={34} />}
              label="即时能力 CA"
              value={caMin === null || caMax === null ? "--" : `${number(caMin)}–${number(caMax)}`}
              note={`${data.workouts.length} 次有效训练`}
              tone="ca"
            />
            <TrendMetric
              icon={<TrendUp size={34} />}
              label="成长速度"
              value={latest?.growthVelocityPerWeek === null || latest?.growthVelocityPerWeek === undefined ? "--" : `${latest.growthVelocityPerWeek >= 0 ? "+" : ""}${latest.growthVelocityPerWeek.toFixed(2)}`}
              note="每周能力点"
              tone="growth"
            />
            <TrendMetric
              icon={<ShieldCheck size={34} />}
              label="置信度"
              value={confidence === null ? "--" : `${Math.round(confidence * 100)}%`}
              note={confidence === null ? "数据不足" : confidence >= 0.8 ? "数据稳定性良好" : "仍需积累训练"}
              tone="confidence"
            />
          </section>

          <div className="trend-reference-status" aria-label="趋势数据状态">
            <span>● {dataStatus}</span><span>● {calculationStatus}</span><span>★ 置信度 {confidence === null ? "--" : confidence >= .8 ? "高" : confidence >= .6 ? "中" : "低"}</span>
          </div>

          <section className="trends-primary-grid">
            <article className="panel full-chart">
              <div className="panel-heading">
                <div>
                  <h2>能力变化</h2>
                  <p>{data.startDate} 至 {data.endDate}</p>
                </div>
                <div className="layer-toggles">
                  {(
                    [
                      ["ta", "TA"],
                      ["ca", "CA"],
                      ["volume", "跑量"],
                      ["load", "负荷"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={layers[key]}
                        onChange={(event) =>
                          setLayers((current) => ({
                            ...current,
                            [key]: event.target.checked,
                          }))
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <AbilityChart
                trend={data}
                height={330}
                showTa={layers.ta}
                showCa={layers.ca}
              />
              <div className="chart-legend">
                <span className="ta">TA 真实跑力</span>
                <span className="ca">训练即时能力 CA</span>
              </div>
            </article>

            <article className="panel trend-interpretation-panel">
              <div className="panel-heading">
                <div>
                  <h2>趋势解读</h2>
                  <p>从长期能力与单次表现理解变化。</p>
                </div>
              </div>
              <ul>
                <li><i className="ta" /><span><b>真实跑力</b>{trendSentence(taDelta)}</span></li>
                <li><i className="ca" /><span><b>即时能力</b>{caRangeSentence(caMin, caMax)}</span></li>
                <li><i className="growth" /><span><b>整体趋势</b>{growthSentence(latest?.growthVelocityPerWeek ?? null)}</span></li>
              </ul>
              <div className="trend-direction-meter">
                <span>总体趋势</span>
                <i><em style={{ left: `${trendPosition(latest?.growthVelocityPerWeek ?? null)}%` }} /></i>
                <small><b>下滑</b><b>稳定</b><b>上升</b></small>
              </div>
            </article>
          </section>

          <section className="trends-reference-lower">
            <article className="panel trend-events">
              <div className="panel-heading">
                <div>
                  <h2>训练事件</h2>
                  <p>关键训练对能力变化产生的实际影响。</p>
                </div>
              </div>
              <div className="event-grid">
                {data.workouts.slice(-6).map((workout) => (
                  <Link
                    to={`/workouts/${workout.id}`}
                    state={{ from: "/trends" }}
                    key={workout.id}
                  >
                    <span>{date(workout.date)}</span>
                    <b>CA {number(workout.currentAbility)}</b>
                    <small>{number(workout.distanceKm)} km · 置信度 {workout.confidence === null ? "--" : `${Math.round(workout.confidence * 100)}%`}</small>
                  </Link>
                ))}
              </div>
            </article>
            <article className="panel trend-dimensions-panel">
              <div className="panel-heading">
                <div>
                  <h2>五维即时趋势</h2>
                  <p>最近训练的五维即时评分。</p>
                </div>
              </div>
              <DimensionTrendChart trend={data} />
            </article>
          </section>

          <section className="panel trend-context-panel">
            <div className="panel-heading">
              <div>
                <h2>训练上下文</h2>
                <p>跑量与训练负荷用于解释能力波动。</p>
              </div>
            </div>
            <TrainingContextChart
              trend={data}
              showVolume={layers.volume}
              showLoad={layers.load}
            />
          </section>
        </>
      )}
    </div>
  );
}

function TrendMetric({ icon, label, value, note, tone }: { icon: React.ReactNode; label: string; value: string; note: string; tone: string }) {
  return <article className={tone}><span className="trend-metric-icon" aria-hidden="true">{icon}</span><div><span>{label}</span><b>{value}</b><small>{note}</small></div></article>;
}

function trendSentence(delta: number | null): string {
  if (delta === null) return "当前区间没有足够数据判断变化。";
  return `当前区间${delta >= 0 ? "上升" : "下降"} ${Math.abs(delta).toFixed(2)} 分。`;
}

function caRangeSentence(minimum: number | null, maximum: number | null): string {
  if (minimum === null || maximum === null) return "当前区间没有即时能力训练点。";
  return `训练表现位于 ${number(minimum)}–${number(maximum)}，波动反映当天状态。`;
}

function growthSentence(value: number | null): string {
  if (value === null) return "成长速度仍在计算。";
  if (value > 0.1) return "能力稳定向上，可维持当前训练节奏。";
  if (value < -0.1) return "能力处于回落区间，优先检查恢复。";
  return "能力基本稳定，训练刺激与恢复较平衡。";
}

function trendPosition(value: number | null): number {
  if (value === null) return 50;
  return Math.max(8, Math.min(92, 50 + value * 35));
}
