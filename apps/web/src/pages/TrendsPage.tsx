import type { TrendResponse } from "@rai/api-contracts";
import { useState } from "react";
import { Link } from "react-router-dom";

import { AbilityChart } from "../components/AbilityChart.js";
import { DimensionTrendChart, TrainingContextChart } from "../components/TrendAnalysisCharts.js";
import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { date, number } from "../format.js";
import { useRemote } from "../hooks.js";

const ranges = [{ label: "4 周", days: 28 }, { label: "12 周", days: 84 }, { label: "6 月", days: 183 }, { label: "1 年", days: 365 }, { label: "全部", days: 4000 }];

export function TrendsPage() {
  const [days, setDays] = useState(84);
  const [layers, setLayers] = useState({ ta: true, ca: true, volume: true, load: true });
  const result = useRemote<TrendResponse>(`/v1/trends?days=${days}`);
  return (
    <div className="page">
      <header className="page-header split">
        <div><h1>能力趋势</h1><p>同时检查 TA、CA、Decay 与成长速度。</p></div>
        <div className="segmented" role="group" aria-label="趋势时间范围">
          {ranges.map((range) => <button type="button" key={range.days} className={days === range.days ? "active" : ""} aria-pressed={days === range.days} onClick={() => setDays(range.days)}>{range.label}</button>)}
        </div>
      </header>
      {result.loading ? <LoadingBlock /> : result.error || !result.data ? <ErrorBlock message={result.error ?? "没有趋势数据"} onRetry={() => void result.reload()} /> : <>
        <section className="panel full-chart">
          <div className="panel-heading">
            <div><h2>{result.data.startDate} 至 {result.data.endDate}</h2><p>TA、CA、Decay 与模型运行点使用独立视觉编码。</p></div>
            <div className="layer-toggles">{([['ta','TA'],['ca','CA'],['volume','跑量'],['load','负荷']] as const).map(([key,label]) => <label key={key}><input type="checkbox" checked={layers[key]} onChange={(event) => setLayers((current) => ({ ...current, [key]: event.target.checked }))} />{label}</label>)}</div>
          </div>
          <AbilityChart trend={result.data} height={430} showTa={layers.ta} showCa={layers.ca} />
          <div className="chart-legend"><span className="ta">TA 真实跑力</span><span className="ca">CA 即时能力</span><span className="decay">琥珀区段为停跑 Decay</span><span>琥珀空心点为低置信 CA</span><span>虚线为模型运行点</span></div>
        </section>
        <section className="trend-summary-grid">
          <article><span>当前 TA</span><b>{number(result.data.daily.at(-1)?.trueAbility ?? null)}</b></article>
          <article><span>每周 GV</span><b>{number(result.data.daily.at(-1)?.growthVelocityPerWeek ?? null)}</b></article>
          <article><span>区间训练</span><b>{result.data.workouts.length}</b></article>
          <article><span>区间跑量</span><b>{result.data.context.reduce((sum, item) => sum + item.distanceKm, 0).toFixed(1)} km</b></article>
        </section>
        <section className="trend-analysis-grid">
          <article className="panel"><div className="panel-heading"><div><h2>五维即时趋势</h2><p>Cardio 为虚线诊断项，不参与当前 CA。</p></div></div><DimensionTrendChart trend={result.data} /></article>
          <article className="panel"><div className="panel-heading"><div><h2>训练上下文</h2><p>负荷为运动时长 × 可用心率强度的本地估计。</p></div></div><TrainingContextChart trend={result.data} showVolume={layers.volume} showLoad={layers.load} /></article>
        </section>
        <section className="panel trend-events">
          <div className="panel-heading"><div><h2>训练事件</h2><p>选择 CA 点对应的训练，检查评分证据。</p></div></div>
          <div className="event-grid">{result.data.workouts.slice(-12).reverse().map((workout) => <Link to={`/workouts/${workout.id}`} state={{ from: "/trends" }} key={workout.id}><span>{date(workout.date)}</span><b>CA {number(workout.currentAbility)}</b><small>{number(workout.distanceKm)} km · 置信度 {workout.confidence === null ? "--" : `${Math.round(workout.confidence * 100)}%`}</small></Link>)}</div>
        </section>
      </>}
    </div>
  );
}
