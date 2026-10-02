import "../pixel-layout.css";
import "../training-reference.css";
import type {
  DailyTrainingMetric,
  RecoveryTimeEstimate,
  TrainingLoadTimelineDay,
  TrainingPeriodSummary,
  TrainingStatisticsGranularity,
  TrainingStatisticsHistoryResponse,
  TrainingStatisticsOverviewResponse,
  TrainingLoadTimelineResponse,
  TrainingStatusCode
} from "@rai/api-contracts";
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { duration, formStatus, pace, recoveryBasis, sessionType, shortDate, stimulusType } from "../format.js";
import { useRemote } from "../hooks.js";
import { Pulse, TrendDown, TrendUp, WarningCircle } from "../icons.js";

const statusLabels: Record<TrainingStatusCode, string> = {
  insufficient_data: "数据积累中",
  recovery: "恢复 / 训练减少",
  maintaining: "负荷维持",
  effective_stimulus: "有效训练刺激",
  high_load: "当前负荷较高",
  attention: "需要关注恢复"
};

const statusTone: Record<TrainingStatusCode, string> = {
  insufficient_data: "neutral",
  recovery: "recovery",
  maintaining: "maintaining",
  effective_stimulus: "productive",
  high_load: "high",
  attention: "attention"
};

const explanationLabels: Record<string, (value: number | null) => string> = {
  insufficient_training_history: (value) => `当前积累 ${Math.round(value ?? 0)} 天训练历史`,
  load_ratio_attention: (value) => `急性负荷为慢性负荷的 ${(value ?? 0).toFixed(2)} 倍`,
  ramp_rate_attention: (value) => `近 7 日负荷增长 ${Math.round((value ?? 0) * 100)}%`,
  low_recovery_with_load: (value) => `恢复证据偏低（${Math.round((value ?? 0) * 100)}%）`,
  load_ratio_high: (value) => `当前负荷比 ${(value ?? 0).toFixed(2)}`,
  strain_above_personal_p90: (value) => `训练应激 ${Math.round(value ?? 0)}，高于个人近期范围`,
  seven_days_without_run: (value) => `已连续 ${Math.round(value ?? 0)} 天没有跑步`,
  load_ratio_recovery: (value) => `当前负荷比 ${(value ?? 0).toFixed(2)}，处于减量区间`,
  effective_load_range: (value) => `当前负荷比 ${(value ?? 0).toFixed(2)}，刺激与长期负荷匹配`,
  load_maintaining: (value) => `当前负荷比 ${(value ?? 0).toFixed(2)}，整体保持稳定`
};

const granularities: Array<{ value: TrainingStatisticsGranularity; label: string }> = [
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "year", label: "年" }
];

const limits: Record<TrainingStatisticsGranularity, number> = { week: 12, month: 12, year: 20 };

const km = (meters: number): string => (meters / 1_000).toFixed(1);
const percent = (value: number | null): string => value === null ? "--" : `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;
const load = (value: number | null | undefined): string => value === null || value === undefined ? "--" : Math.round(value).toString();

function PeriodMetric({ label, value, comparison }: { label: string; value: string; comparison?: number | null }) {
  return <article><span>{label}</span><b>{value}</b>{comparison !== undefined ? <small className={(comparison ?? 0) >= 0 ? "positive-text" : "negative-text"}>{percent(comparison ?? null)}</small> : null}</article>;
}

function StatusPanel({ metric, confidence }: { metric: DailyTrainingMetric | null; confidence: number | null }) {
  if (!metric) return <section className="panel training-status-panel neutral"><div><span>训练状态</span><h2>等待统计数据</h2><p>完成一次模型重算后生成负荷时间线。</p></div></section>;
  const explanations = metric.statusExplanations.map((item) => explanationLabels[item.code]?.(item.value) ?? item.code);
  return <section className={`panel training-status-panel ${statusTone[metric.trainingStatus]}`}>
    <div><span>当前训练状态</span><h2>{statusLabels[metric.trainingStatus]}</h2><p>{explanations[0] ?? "训练负荷保持在个人近期范围内"}</p></div>
    <div className="status-load-ratio"><small>急性 / 慢性</small><strong>{metric.loadRatio === null ? "--" : metric.loadRatio.toFixed(2)}</strong><span>置信度 {confidence === null ? "--" : `${Math.round(confidence * 100)}%`}</span></div>
    <div className="status-evidence">{explanations.slice(0, 3).map((item) => <span key={item}><Pulse size={14} />{item}</span>)}</div>
  </section>;
}

function VolumeHistoryChart({ periods }: { periods: TrainingPeriodSummary[] }) {
  const data = [...periods].sort((left, right) => left.periodStart.localeCompare(right.periodStart)).map((period) => ({
    date: period.periodStart,
    distance: Number((period.distanceMeters / 1_000).toFixed(2)),
    trainingLoad: Number(period.totalLoad.toFixed(1))
  }));
  if (!data.length) return <div className="series-empty">当前范围没有训练统计。</div>;
  return <div className="statistics-chart chart-with-data"><div className="chart-visual" role="img" aria-label={`跑量与负荷历史，共 ${data.length} 个周期`}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{ top: 16, right: 10, bottom: 0, left: 0 }}><CartesianGrid vertical={false} stroke="#dfe5df" /><XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: "#6d786f" }} tickLine={false} axisLine={false} minTickGap={30} /><YAxis yAxisId="distance" width={38} tick={{ fontSize: 9, fill: "#6d786f" }} tickLine={false} axisLine={false} /><YAxis yAxisId="load" orientation="right" width={38} tick={{ fontSize: 9, fill: "#a96c19" }} tickLine={false} axisLine={false} /><Tooltip formatter={(value, name) => [name === "跑量 km" ? `${Number(value).toFixed(1)} km` : Math.round(Number(value)), name]} labelFormatter={(value) => String(value)} /><Bar yAxisId="distance" dataKey="distance" name="跑量 km" fill="#76a489" radius={[3, 3, 0, 0]} /><Line yAxisId="load" type="monotone" dataKey="trainingLoad" name="训练负荷" stroke="#b87822" strokeWidth={2} dot={false} /></ComposedChart></ResponsiveContainer></div><details className="chart-data-details"><summary>查看跑量与负荷数据</summary><div className="chart-data-table-wrap"><table><caption className="sr-only">跑量与训练负荷历史数据</caption><thead><tr><th>周期开始</th><th>跑量</th><th>训练负荷</th></tr></thead><tbody>{data.map((item) => <tr key={item.date}><td>{item.date}</td><td>{item.distance.toFixed(1)} km</td><td>{item.trainingLoad.toFixed(1)}</td></tr>)}</tbody></table></div></details></div>;
}

function EvidenceTimeline({ periods }: { periods: TrainingPeriodSummary[] }) {
  const events = [...periods]
    .sort((left, right) => left.periodStart.localeCompare(right.periodStart))
    .slice(-7);
  if (!events.length) return <div className="series-empty">当前范围没有训练证据。</div>;
  return <section className="panel statistics-evidence-timeline" aria-label="证据时间线">
    <div className="panel-heading"><div><h2>证据时间线</h2><p>周期训练数据持续写入模型证据</p></div></div>
    <div className="statistics-event-track">
      {events.map((event, index) => <article key={event.periodStart}>
        <time>{shortDate(event.periodStart)}</time>
        <i aria-hidden="true">{index % 4 === 0 ? "◷" : index % 4 === 1 ? "⚑" : index % 4 === 2 ? "▥" : "♥"}</i>
        <b>{event.workoutCount} 次训练</b>
        <span>{km(event.distanceMeters)} km</span>
        <small>训练负荷 <em>{load(event.totalLoad)}</em></small>
      </article>)}
    </div>
  </section>;
}

type LoadView = "composite" | "internal" | "pace";

/**
 * §9.6 form and recovery, side by side.
 *
 * Deliberately one panel rather than two cards: the two numbers come from the same
 * load curve, and splitting them invites reading the recovery estimate as an
 * independent measurement of the body. The footnote says which is which.
 */
export function FormRecoveryPanel({ day, recovery }: {
  day: TrainingLoadTimelineDay | null;
  recovery: RecoveryTimeEstimate;
}) {
  const remaining = recovery.remainingHours;
  const readyLabel = recovery.readyAt === null || remaining === null
    ? "--"
    : remaining === 0
      ? "现在即可安排质量课"
      : `${new Date(recovery.readyAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 之后`;
  const formLabel = day === null || day.form === null
    ? "数据不足"
    : `${day.form > 0 ? "+" : ""}${day.form.toFixed(1)}（${day.formRatio === null ? "--" : `${day.formRatio >= 0 ? "+" : ""}${Math.round(day.formRatio * 100)}%`}）`;
  return (
    <section className="panel form-recovery-panel" aria-label="状态与恢复">
      <div className="panel-heading">
        <div>
          <h2>状态与恢复</h2>
          <p>两项都从同一条负荷曲线派生；不是生理测量，也不覆盖当天的恢复证据。</p>
        </div>
        <code>{recovery.policyVersion}</code>
      </div>
      <div className="form-recovery-grid">
        <div className="form-block">
          <small>状态（慢性 − 急性 EWMA）</small>
          <b>{formLabel}</b>
          <span className={`form-status form-${day?.formStatus ?? "insufficient_data"}`}>{formStatus(day?.formStatus ?? "insufficient_data")}</span>
          <em>正值表示长期负荷高于近期负荷，通常出现在减量或休息之后。</em>
        </div>
        <div className="recovery-block">
          <small>建议间隔（负荷外推）</small>
          <b>{remaining === null ? "--" : remaining === 0 ? "已结束" : `${remaining} 小时`}</b>
          <span>{readyLabel}</span>
          <em>{recovery.status === "insufficient_data" ? "数据不足，不外推" : `起点：${recovery.anchor?.localDate ?? "--"} 的${sessionType(recovery.anchor?.sessionType ?? "unknown")}`}</em>
        </div>
      </div>
      <div className="form-recovery-basis">
        {recovery.basisCodes.map((code) => <span key={code}>{recoveryBasis(code)}</span>)}
      </div>
      <p className="form-recovery-note">状态是负荷曲线上的相对位置，恢复时间是按其负荷推算的建议间隔；两者都不构成医学结论，也不替代当天的恢复读数。</p>
    </section>
  );
}

function LoadTimelineChart({ items, components, view }: {
  items: TrainingLoadTimelineDay[];
  components: TrainingLoadTimelineResponse["components"];
  view: LoadView;
}) {
  const source = items.slice(-180);
  if (!source.length) return <div className="series-empty">当前没有负荷时间线。</div>;
  const componentMap = new Map(components.map((item) => [item.localDate, item]));
  const data = source.map((item) => ({
    ...item,
    selectedLoad: view === "internal"
      ? componentMap.get(item.localDate)?.internalLoad ?? null
      : view === "pace"
        ? componentMap.get(item.localDate)?.paceLoad ?? null
        : componentMap.get(item.localDate)?.compositeLoad ?? item.load
  }));
  const label = view === "internal" ? "内部负荷" : view === "pace" ? "配速负荷" : "综合负荷";
  return <div className="statistics-chart load-timeline-chart chart-with-data"><div className="chart-visual" role="img" aria-label={`${label}趋势，共 ${source.length} 天`}><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 16, right: 10, bottom: 0, left: 0 }}><CartesianGrid vertical={false} stroke="#dfe5df" /><XAxis dataKey="localDate" tickFormatter={shortDate} tick={{ fontSize: 10, fill: "#6d786f" }} tickLine={false} axisLine={false} minTickGap={34} /><YAxis yAxisId="load" width={40} tick={{ fontSize: 9, fill: "#6d786f" }} tickLine={false} axisLine={false} />{view === "composite" ? <YAxis yAxisId="form" orientation="right" width={40} tick={{ fontSize: 9, fill: "#4b6fa8" }} tickLine={false} axisLine={false} /> : null}<Tooltip formatter={(value, name) => [value === null ? "--" : Number(value).toFixed(1), name]} /><Bar yAxisId="load" dataKey="selectedLoad" name={label} fill={view === "internal" ? "#b85a4a" : view === "pace" ? "#3d779b" : "#d1a755"} opacity={0.72} />{view === "composite" ? <><Line yAxisId="load" type="monotone" dataKey="acuteEwma" name="急性负荷" stroke="#b94f3f" strokeWidth={2} dot={false} /><Line yAxisId="load" type="monotone" dataKey="chronicEwma" name="慢性负荷" stroke="#1f6d4c" strokeWidth={2} dot={false} /><Line yAxisId="form" type="monotone" dataKey="form" name="状态（慢−急）" stroke="#4b6fa8" strokeWidth={1.6} strokeDasharray="4 3" dot={false} connectNulls={false} /></> : null}</BarChart></ResponsiveContainer></div><details className="chart-data-details"><summary>查看{label}数据</summary><div className="chart-data-table-wrap"><table><caption className="sr-only">{label}每日趋势数据</caption><thead><tr><th>日期</th><th>{label}</th>{view === "composite" ? <><th>急性负荷</th><th>慢性负荷</th><th>状态</th></> : null}</tr></thead><tbody>{data.map((item) => <tr key={item.localDate}><td>{item.localDate}</td><td>{item.selectedLoad === null ? "--" : item.selectedLoad.toFixed(1)}</td>{view === "composite" ? <><td>{item.acuteEwma === null ? "--" : item.acuteEwma.toFixed(1)}</td><td>{item.chronicEwma === null ? "--" : item.chronicEwma.toFixed(1)}</td><td>{item.form === null ? "--" : item.form.toFixed(1)}</td></> : null}</tr>)}</tbody></table></div></details></div>;
}

export function StatisticsPage() {
  const [granularity, setGranularity] = useState<TrainingStatisticsGranularity>("week");
  const [distributionView, setDistributionView] = useState<"structure" | "stimulus">("structure");
  const [loadView, setLoadView] = useState<LoadView>("composite");
  const overview = useRemote<TrainingStatisticsOverviewResponse>("/v1/training-statistics/overview");
  const history = useRemote<TrainingStatisticsHistoryResponse>(`/v1/training-statistics/history?granularity=${granularity}&limit=${limits[granularity]}`);
  const timeline = useRemote<TrainingLoadTimelineResponse>("/v1/training-statistics/load?days=180");
  if (overview.loading) return <div className="page"><LoadingBlock label="正在计算训练统计" /></div>;
  if (overview.error || !overview.data) return <div className="page"><ErrorBlock message={overview.error ?? "无法读取训练统计"} onRetry={() => void overview.reload()} /></div>;
  const current = granularity === "week" ? overview.data.week : granularity === "month" ? overview.data.month : overview.data.year;
  const distribution = current ? (distributionView === "structure" ? current.typeDistribution.map((item) => ({ key: item.sessionType, label: sessionType(item.sessionType), ...item })) : current.stimulusDistribution.map((item) => ({ key: item.stimulusType, label: stimulusType(item.stimulusType), ...item }))) : [];
  return <div className="page statistics-page statistics-reference-page">
    <header className="page-header split runner-page-header statistics-reference-header"><div><h1>运动统计</h1><p>{overview.data.status?.localDate ?? "--"} · 跑量、训练负荷与恢复节奏</p></div><div className="segmented" role="group" aria-label="统计周期">{granularities.map((item) => <button type="button" key={item.value} className={granularity === item.value ? "active" : ""} aria-pressed={granularity === item.value} onClick={() => setGranularity(item.value)}>{item.label}</button>)}</div></header>
    <StatusPanel metric={overview.data.status} confidence={overview.data.statusConfidence} />
    <FormRecoveryPanel
      day={timeline.data && timeline.dataPath === "/v1/training-statistics/load?days=180" ? timeline.data.days.at(-1) ?? null : null}
      recovery={overview.data.recoveryTime}
    />
    {current ? <>
      <section className="statistics-kpis" aria-label="当前周期统计">
        <PeriodMetric label="跑量" value={`${km(current.distanceMeters)} km`} comparison={current.comparison?.distanceChangeFraction ?? null} />
        <PeriodMetric label="运动时间" value={duration(current.durationSeconds)} comparison={current.comparison?.durationChangeFraction ?? null} />
        <PeriodMetric label="训练次数" value={`${current.workoutCount}`} comparison={current.comparison?.workoutCountChangeFraction ?? null} />
        <PeriodMetric label="训练负荷" value={load(current.totalLoad)} comparison={current.comparison?.loadChangeFraction ?? null} />
        <PeriodMetric label="平均配速" value={`${pace(current.averagePaceSecondsPerKm)}/km`} />
        <PeriodMetric label="最长跑" value={`${km(current.longestRunMeters)} km`} />
      </section>
      <section className="statistics-grid statistics-reference-main">
        <article className="panel statistics-history-panel"><div className="panel-heading"><div><h2>{granularity === "week" ? "周" : granularity === "month" ? "月" : "年"}跑量与负荷</h2><p>{current.isComplete ? "完整周期" : "当前周期按同进度比较"}</p></div><span className="chart-key"><i />跑量 <i />负荷</span></div>{history.loading ? <LoadingBlock /> : history.error || !history.data ? <ErrorBlock message={history.error ?? "没有历史统计"} /> : <VolumeHistoryChart periods={history.data.periods} />}</article>
        <article className="panel type-distribution-panel statistics-reference-distribution"><div className="panel-heading"><div><h2>{distributionView === "structure" ? "训练类型分布" : "生理刺激分布"}</h2><p>按当前周期的训练负荷</p></div><div className="segmented compact" role="group" aria-label="训练分布类型"><button type="button" className={distributionView === "structure" ? "active" : ""} aria-pressed={distributionView === "structure"} onClick={() => setDistributionView("structure")}>结构</button><button type="button" className={distributionView === "stimulus" ? "active" : ""} aria-pressed={distributionView === "stimulus"} onClick={() => setDistributionView("stimulus")}>刺激</button></div></div>{distribution.length ? <div>{distribution.map((item) => <div key={item.key}><span><b>{item.label}</b><small>{item.workoutCount} 次 · {km(item.distanceMeters)} km</small></span><strong>{load(item.load)}</strong><i><em style={{ width: `${Math.min(100, current.totalLoad > 0 ? item.load / current.totalLoad * 100 : 0)}%` }} /></i></div>)}</div> : <div className="series-empty"><WarningCircle size={20} />当前周期没有训练</div>}</article>
      </section>
      {history.loading || history.error || !history.data ? null : <EvidenceTimeline periods={history.data.periods} />}
      <section className="statistics-grid lower">
        <article className="panel"><div className="panel-heading"><div><h2>负荷趋势</h2><p>{loadView === "composite" ? "综合负荷及急慢性 EWMA" : loadView === "internal" ? "按储备心率计算的内部负荷" : "按阈配速计算的外部负荷"}</p></div><div className="segmented compact" role="group" aria-label="负荷趋势类型">{([{"value":"composite","label":"综合"},{"value":"internal","label":"内部"},{"value":"pace","label":"配速"}] as const).map((item) => <button type="button" key={item.value} className={loadView === item.value ? "active" : ""} aria-pressed={loadView === item.value} onClick={() => setLoadView(item.value)}>{item.label}</button>)}</div></div>{timeline.loading ? <LoadingBlock /> : timeline.error || !timeline.data ? <ErrorBlock message={timeline.error ?? "没有负荷时间线"} /> : <LoadTimelineChart items={timeline.data.days} components={timeline.data.components} view={loadView} />}</article>
        <article className="panel load-summary-panel"><div className="panel-heading"><div><h2>负荷摘要</h2><p>最近 7 日与长期训练节奏</p></div>{overview.data.status?.rampRate !== null && overview.data.status?.rampRate !== undefined && overview.data.status.rampRate >= 0 ? <TrendUp size={20} /> : <TrendDown size={20} />}</div><dl><div><dt>最近 7 日</dt><dd>{load(overview.data.status?.current7dLoad)}</dd></div><div><dt>前 7 日</dt><dd>{load(overview.data.status?.previous7dLoad)}</dd></div><div><dt>增长率</dt><dd>{percent(overview.data.status?.rampRate ?? null)}</dd></div><div><dt>单调度</dt><dd>{overview.data.status?.monotony?.toFixed(2) ?? "--"}</dd></div><div><dt>训练应激</dt><dd>{load(overview.data.status?.strain)}</dd></div><div><dt>恢复证据</dt><dd>{overview.data.status?.recoveryEvidence === null || overview.data.status?.recoveryEvidence === undefined ? "--" : `${Math.round(overview.data.status.recoveryEvidence * 100)}%`}</dd></div></dl></article>
      </section>
      <section className="statistics-secondary-kpis" aria-label="补充周期统计">
        <PeriodMetric label="累计爬升" value={`${Math.round(current.elevationGainMeters)} m`} />
        <PeriodMetric label="平均心率" value={current.averageHeartRate === null ? "--" : `${Math.round(current.averageHeartRate)} bpm`} />
        <PeriodMetric label="数据完整度" value={`${Math.round(current.dataCompleteness * 100)}%`} />
        <PeriodMetric label="负荷置信度" value={current.loadConfidence === null ? "--" : `${Math.round(current.loadConfidence * 100)}%`} />
      </section>
    </> : <section className="panel statistics-empty"><WarningCircle size={24} /><h2>正在生成运动统计</h2><p>完成一次完整重算后显示周、月、年跑量和负荷趋势。</p></section>}
  </div>;
}
