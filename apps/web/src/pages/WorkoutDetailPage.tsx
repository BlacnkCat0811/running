import "../pixel-layout.css";
import "../training-reference.css";
import "../components/share-card-panel.css";
import type { RunningDynamicsAnalysis, WorkoutDetailResponse, WorkoutEnvironmentView, WorkoutSegment, WorkoutSegmentPurpose, WorkoutSeriesResponse } from "@rai/api-contracts";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { OverrideDrawer } from "../components/OverrideDrawer.js";
import { RoutePlot } from "../components/RoutePlot.js";
import { ShareCardPanel } from "../components/ShareCardPanel.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { WorkoutSeriesChart } from "../components/WorkoutSeriesChart.js";
import { api } from "../api.js";
import { confidenceLevel, date, duration, dynamicsReason, environment, environmentReason, environmentStatus, explanation, heartRateZone, missingReason, number, pace, paceZone, sessionType, status, stimulusType } from "../format.js";
import { useRemote } from "../hooks.js";
import { ArrowLeft, CheckCircle, Heartbeat, MapTrifold, PencilSimple, Pulse, Target, Timer, Warning } from "../icons.js";

const dimensionLabels = { efficiency: "Efficiency", pace: "Pace", cardio: "Cardio", stability: "Stability", recovery: "Recovery" } as const;
const loadSourceLabels = { composite: "综合训练负荷", heart_rate_series: "心率序列计算", average_heart_rate: "平均心率估算", rpe: "RPE 估算", session_type: "训练类型估算" } as const;
const loadExplanationLabels: Record<string, string> = {
  load_source_heart_rate_series: "按训练窗口内的心率区间积分",
  load_source_average_heart_rate: "心率序列覆盖不足，使用平均心率估算",
  load_source_rpe: "缺少可用心率，使用主观用力程度估算",
  load_source_session_type: "缺少心率和 RPE，使用训练类型保守估算"
};
const zoneColors = ["#dce8ec", "#dfeadf", "#f0e4b8", "#f4d3c9", "#efc2be"];
const segmentPurposeLabels: Record<WorkoutSegmentPurpose, string> = {
  warmup: "热身",
  work: "训练",
  recovery: "恢复",
  cooldown: "整理放松",
  unplanned: "自由训练"
};
const sessionKindLabels: Record<string, string> = {
  rest: "休息",
  recovery: "恢复跑",
  easy: "轻松跑",
  long_run: "长距离",
  tempo: "节奏跑",
  interval: "间歇"
};

/** The dose the step asked for; `null` when the segment came from a watch lap rather than a plan. */
const segmentGoal = (segment: WorkoutSegment): string => {
  if (segment.goalType === "distance" && segment.goalMeters !== null) return `${Math.round(segment.goalMeters)} m`;
  if (segment.goalType === "time" && segment.goalSeconds !== null) return duration(segment.goalSeconds);
  if (segment.goalType === "open") return "自由";
  return "--";
};

/** The alert the watch was told to enforce; the plan's intent, not the measured outcome. */
const segmentAlert = (segment: WorkoutSegment): string => {
  if (segment.alertKind === null) return "--";
  const unit = segment.alertKind === "pace" ? "/km" : " bpm";
  const format = (value: number | null): string | null =>
    value === null ? null : segment.alertKind === "pace" ? pace(value) : String(Math.round(value));
  const lower = format(segment.alertLower);
  const upper = format(segment.alertUpper);
  if (lower !== null && upper !== null) return `${lower}–${upper}${unit}`;
  if (upper !== null) return `≤ ${upper}${unit}`;
  if (lower !== null) return `≥ ${lower}${unit}`;
  return segment.alertKind === "pace" ? "配速提醒" : "心率提醒";
};

function ZoneDistribution({ title, coverage, items, kind }: {
  title: string;
  coverage: number;
  items: Array<{ zone: string; durationSeconds: number; distanceMeters: number; fraction: number }>;
  kind: "heart" | "pace";
}) {
  return <div className="workout-zone-distribution"><header><span><b>{title}</b><small>有效覆盖 {Math.round(coverage * 100)}%</small></span></header><div className="zone-stacked-bar" aria-label={`${title}分布`}>{items.map((item, index) => <i key={item.zone} className={`zone-${index + 1}`} style={{ width: `${Math.max(0, item.fraction * 100)}%` }} title={`${kind === "heart" ? heartRateZone(item.zone) : paceZone(item.zone)} ${duration(item.durationSeconds)}`} />)}</div><div className="zone-exposure-list">{items.map((item, index) => <span key={item.zone}><i className={`zone-${index + 1}`} /><b>{kind === "heart" ? heartRateZone(item.zone) : paceZone(item.zone)}</b><small>{duration(item.durationSeconds)}{kind === "pace" && item.distanceMeters > 0 ? ` · ${(item.distanceMeters / 1000).toFixed(1)} km` : ""}</small></span>)}</div></div>;
}

export function WorkoutSplits({ splits, grade }: { splits: WorkoutSeriesResponse["splits"]; grade: WorkoutSeriesResponse["grade"] }) {
  // Grade columns appear only when at least one split actually has altitude. A
  // permanently empty pair of columns would read as "flat everywhere", which is
  // exactly the unknown-versus-zero confusion the contract forbids.
  const withGrade = splits.some((split) => split.grade?.gradePercent !== null && split.grade?.gradePercent !== undefined);
  const gradeNote = grade === null
    ? null
    : grade.reasonCodes.length > 0
      ? grade.reasonCodes.map(environmentReason).join("；")
      : null;
  return (
    <section className="panel workout-splits-panel">
      <div className="panel-heading">
        <div>
          <h2>公里分段</h2>
          <p>按累计距离切分；最后不足 1 公里的尾段单独列出。</p>
        </div>
        <code>{splits.length} 段</code>
      </div>
      {withGrade && grade !== null ? (
        <div className="splits-grade-summary">
          <span>等强配速（全程加权）<b>{grade.gradeAdjustedPaceSecondsPerKm === null ? "--" : `${pace(grade.gradeAdjustedPaceSecondsPerKm)}/km`}</b></span>
          <span>累计爬升 <b>{grade.gainMeters === null ? "--" : `${Math.round(grade.gainMeters)} m`}</b></span>
          <span>累计下降 <b>{grade.lossMeters === null ? "--" : `${Math.round(grade.lossMeters)} m`}</b></span>
          <span>覆盖 <b>{grade.coveredSplits}/{grade.totalSplits} 段</b></span>
          <small>按 Minetti 能耗模型折算为平地等效配速（模型值，非实测）</small>
        </div>
      ) : gradeNote ? (
        <p className="splits-grade-note">未计算坡度与等强配速：{gradeNote}。</p>
      ) : null}
      {splits.length === 0 ? (
        <div className="splits-empty">没有足够的跑速数据生成公里分段</div>
      ) : (
        <div className="splits-table-wrap">
          <table className="splits-table">
            <caption className="sr-only">公里分段</caption>
            <thead>
              <tr>
                <th scope="col">分段</th>
                <th scope="col">用时</th>
                <th scope="col">距离</th>
                <th scope="col">平均配速</th>
                {withGrade ? <th scope="col">坡度</th> : null}
                {withGrade ? <th scope="col">等强配速</th> : null}
                <th scope="col">平均心率</th>
                <th scope="col">平均步频</th>
              </tr>
            </thead>
            <tbody>
              {splits.map((split) => (
                <tr key={split.index}>
                  <td><b>{split.distanceMeters < 999.5 ? "尾段" : `${split.index} km`}</b></td>
                  <td>{duration(split.durationSeconds)}</td>
                  <td>{(split.distanceMeters / 1000).toFixed(split.distanceMeters < 1000 ? 2 : 1)} km</td>
                  <td>{pace(split.averagePaceSecondsPerKm)}/km</td>
                  {withGrade ? (
                    <td title={split.grade?.reasonCodes.map(environmentReason).join("；") ?? undefined}>
                      {split.grade?.gradePercent === null || split.grade?.gradePercent === undefined
                        ? "--"
                        : `${split.grade.gradePercent > 0 ? "+" : ""}${split.grade.gradePercent.toFixed(1)}%`}
                    </td>
                  ) : null}
                  {withGrade ? (
                    <td>
                      {split.grade?.gradeAdjustedPaceSecondsPerKm === null || split.grade?.gradeAdjustedPaceSecondsPerKm === undefined
                        ? "--"
                        : `${pace(split.grade.gradeAdjustedPaceSecondsPerKm)}/km`}
                    </td>
                  ) : null}
                  <td>{split.averageHeartRateBpm === null ? "--" : `${Math.round(split.averageHeartRateBpm)} bpm`}</td>
                  <td>{split.averageCadenceSpm === null ? "--" : `${Math.round(split.averageCadenceSpm)} spm`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * §19 stride read-out.
 *
 * Three statements the panel must never blur: how much of the run each metric
 * actually covers, whether the two halves were run at comparable speed, and that
 * these are device estimates rather than laboratory measurements.
 */
export function WorkoutDynamicsPanel({ dynamics }: { dynamics: RunningDynamicsAnalysis }) {
  const analysable = dynamics.metrics.filter((metric) => metric.status === "available" || metric.status === "partial");
  return (
    <section className="panel workout-dynamics-panel">
      <div className="panel-heading">
        <div>
          <h2>跑姿动态</h2>
          <p>同一次跑的前后半程对比，且只在配速可比的位置比较；来自手表估计，未经实验室校验。</p>
        </div>
        <code>{dynamics.policyVersion}</code>
      </div>
      {analysable.length === 0 ? (
        <div className="splits-empty">{dynamics.note ?? "这次训练没有可用的跑姿动态样本"}</div>
      ) : (
        <>
          <div className="dynamics-grid">
            {dynamics.metrics.map((metric) => (
              <div key={metric.name} className={`dynamics-metric dynamics-${metric.status}`}>
                <small>{metric.label}</small>
                <b>{metric.average === null ? "--" : `${metric.average.toFixed(metric.unit === "spm" ? 0 : 1)} ${metric.unit}`}</b>
                <span>
                  {metric.driftFraction === null
                    ? "无同配速对比"
                    : `后半程 ${metric.driftFraction > 0 ? "+" : ""}${(metric.driftFraction * 100).toFixed(1)}%`}
                </span>
                <em>覆盖 {Math.round(metric.coverage * 100)}% · {metric.samples} 样本</em>
                {metric.reasonCodes.length > 0 ? (
                  <em className="dynamics-reason">{metric.reasonCodes.map(dynamicsReason).join("；")}</em>
                ) : null}
              </div>
            ))}
          </div>
          {dynamics.flags.length > 0 ? (
            <ul className="dynamics-flags">
              {dynamics.flags.map((flag) => (
                <li key={flag.code}>{flag.detail}<small>（同配速样本 {flag.comparableSamples} 个）</small></li>
              ))}
            </ul>
          ) : null}
          <p className="dynamics-note">
            {dynamics.note ?? "未发现同配速下的明显漂移。"}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Environment read-out for one run.
 *
 * The correction itself is applied by the physiology evidence path, not here; this
 * panel exists so the reader can see the number that path used. When the capture
 * carried no weather the panel says so and names the missing fields — it never
 * renders a zero correction that would look like "reference conditions".
 */
export function WorkoutEnvironmentPanel({ environment }: { environment: WorkoutEnvironmentView | null }) {
  if (environment === null) {
    return (
      <section className="panel workout-environment-panel">
        <div className="panel-heading"><div><h2>环境条件</h2><p>这次训练缺少可用于归一化的距离或时长。</p></div></div>
      </section>
    );
  }
  const measured = environment.temperatureC !== null || environment.humidityPercent !== null;
  return (
    <section className="panel workout-environment-panel">
      <div className="panel-heading">
        <div>
          <h2>环境条件</h2>
          <p>来自手表训练自带的天气与爬升元数据；修正量与历史成绩证据使用同一份计算。</p>
        </div>
        <code>{environmentStatus(environment.status)}</code>
      </div>
      <div className="environment-grid">
        <span><small>温度</small><b>{environment.temperatureC === null ? "--" : `${environment.temperatureC.toFixed(1)} °C`}</b></span>
        <span><small>湿度</small><b>{environment.humidityPercent === null ? "--" : `${Math.round(environment.humidityPercent)} %`}</b></span>
        <span><small>爬升</small><b>{environment.elevationGainMeters === null ? "--" : `${Math.round(environment.elevationGainMeters)} m`}</b></span>
        <span><small>修正量</small><b>{environment.correction === null ? "--" : `${(environment.correction.total * 100).toFixed(1)} %`}</b></span>
        <span><small>等效用时</small><b>{environment.adjusted === null ? "--" : duration(environment.adjusted.durationSeconds)}</b></span>
        <span><small>等效配速</small><b>{environment.adjusted === null || environment.adjusted.paceSecondsPerKm === null ? "--" : `${pace(environment.adjusted.paceSecondsPerKm)}/km`}</b></span>
      </div>
      <div className="environment-reasons">
        {environment.reasonCodes.map((code) => <span key={code}>{environmentReason(code)}</span>)}
      </div>
      <p className="environment-note">
        {environment.status === "unavailable"
          ? "环境数据不完整，因此本次不做修正，也不会按 0 惩罚处理；上面列出的原始读数仍然保留。"
          : environmentalNote(measured)}
      </p>
    </section>
  );
}

/** Wording for the two states that actually produced a correction. */
function environmentalNote(measured: boolean): string {
  return measured
    ? "等效配速是把本次观测折算到参考条件后的结果，用于跨天气比较，不代表当天能跑出的最好成绩。"
    : "本次导入没有携带温度/湿度元数据，因此不做环境修正，也不会按 0 惩罚处理。";
}

/**
 * What the run was actually made of — the plan's own steps, not a 1 km ruler.
 *
 * Rendered above the kilometre splits because it is the answer to "did I run the
 * session I was given"; the splits stay as the neutral fallback. An empty panel
 * always explains itself: "no Watch lap events and no matching plan" is a fact
 * worth showing, and a silent blank reads as a bug.
 */
export function WorkoutSegments({ series }: { series: WorkoutSeriesResponse }) {
  const { segments, segmentPlan, segmentNote } = series;
  const heading = (
    <div className="panel-heading">
      <div>
        <h2>课表分段</h2>
        <p>{segmentNote ?? "这次训练没有可用的分段信息。"}</p>
      </div>
      <code>{segments.length} 段</code>
    </div>
  );
  if (segments.length === 0) {
    return <section className="panel workout-segments-panel">{heading}<div className="splits-empty">{segmentNote ?? "没有可用的分段数据，请参考下方公里分段"}</div></section>;
  }
  return (
    <section className="panel workout-segments-panel">
      {heading}
      {segmentPlan ? (
        <div className="segment-plan-match">
          匹配到 <b>{segmentPlan.localDate}</b> 第 {segmentPlan.revision} 版课表（{sessionKindLabels[segmentPlan.kind] ?? segmentPlan.kind}）
          <span>{segmentPlan.reason}</span>
          <span>可解释 {(segmentPlan.explainedFraction * 100).toFixed(0)}%</span>
          {segmentPlan.plannedDistanceKm === null ? null : <span>计划 {segmentPlan.plannedDistanceKm.toFixed(1)} km</span>}
        </div>
      ) : null}
      <div className="splits-table-wrap">
        <table className="splits-table segments-table">
          <caption className="sr-only">课表分段</caption>
          <thead>
            <tr>
              <th scope="col">分段</th>
              <th scope="col">目标</th>
              <th scope="col">提醒</th>
              <th scope="col">用时</th>
              <th scope="col">距离</th>
              <th scope="col">平均配速</th>
              <th scope="col">平均心率</th>
              <th scope="col">平均步频</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((segment) => (
              <tr key={segment.index}>
                <td>
                  <b>{segment.label}</b>
                  {/* The chip is a claim about the step's *intent*, and only a matched
                      plan can support it. Without one, every segment is tagged
                      `unplanned`, and "自由训练" would name a session type nobody
                      recorded — a lap is not a free run just because no plan explains
                      it. The row's own label ("第 N 段") already says what is known. */}
                  {segmentPlan ? (
                    <small className={`segment-purpose purpose-${segment.purpose}`}>{segmentPurposeLabels[segment.purpose]}</small>
                  ) : null}
                </td>
                <td>{segmentGoal(segment)}</td>
                <td>{segmentAlert(segment)}</td>
                <td>{duration(segment.durationSeconds)}</td>
                <td>{(segment.distanceMeters / 1000).toFixed(2)} km</td>
                <td>{segment.averagePaceSecondsPerKm === null ? "--" : `${pace(segment.averagePaceSecondsPerKm)}/km`}</td>
                <td>{segment.averageHeartRateBpm === null ? "--" : `${Math.round(segment.averageHeartRateBpm)} bpm`}</td>
                <td>{segment.averageCadenceSpm === null ? "--" : `${Math.round(segment.averageCadenceSpm)} spm`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function WorkoutDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const returnTo = (location.state as { from?: string } | null)?.from ?? "/workouts";
  const detailPath = `/v1/workouts/${id ?? ""}`;
  const seriesPath = `/v1/workouts/${id ?? ""}/series`;
  // Path-bound resources must not background-refresh previous data under a new id.
  const detail = useRemote<WorkoutDetailResponse>(detailPath, true, false);
  const series = useRemote<WorkoutSeriesResponse>(seriesPath);
  const [editing, setEditing] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<"queued" | "running" | "succeeded" | "failed" | "cancelled" | null>(null);
  const [jobPollError, setJobPollError] = useState<string | null>(null);

  // Drop in-flight recompute UI when navigating to another workout.
  useEffect(() => {
    setEditing(false);
    setJobId(null);
    setJobStatus(null);
    setJobPollError(null);
  }, [id]);

  const watchJob = (value: string | null) => {
    setEditing(false);
    setJobId(value);
    setJobStatus(value ? "queued" : null);
    setJobPollError(null);
    if (!value) {
      void detail.reload().then((ok) => {
        if (!ok) setJobPollError("覆盖已保存，但最新详情刷新失败。当前仍显示保存前的数据。");
      });
    }
  };

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const job = await api<{ status: "queued" | "running" | "succeeded" | "failed" | "cancelled" }>(`/v1/jobs/${jobId}`);
        if (cancelled) return;
        setJobStatus(job.status);
        setJobPollError(null);
        if (
          job.status === "succeeded" ||
          job.status === "failed" ||
          job.status === "cancelled"
        ) {
          void detail.reload().then((ok) => {
            if (!ok) setJobPollError("任务已结束，但最新详情刷新失败。当前仍显示刷新前的数据。");
          });
          return;
        }
        timer = setTimeout(() => void poll(), 1000);
      } catch (caught) {
        if (cancelled) return;
        setJobPollError(caught instanceof Error ? caught.message : "无法读取重算状态");
        timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [detail.reload, jobId]);

  if (detail.loading && (!detail.data || detail.dataPath !== detailPath)) return <LoadingBlock />;
  if (!detail.data || detail.dataPath !== detailPath) {
    return <ErrorBlock message={detail.error ?? "训练不存在"} onRetry={() => void detail.reload()} />;
  }
  const data = detail.data;
  const workout = data.workout;
  const heartBands = data.zoneProfile?.heartRateBands.map((band, index) => ({
    label: heartRateZone(band.zone), lower: band.lowerBpm, upper: band.upperBpm, color: zoneColors[index] ?? zoneColors[0]!
  })) ?? [];
  const paceBands = data.zoneProfile?.paceBands.map((band, index) => ({
    label: paceZone(band.zone),
    lower: band.upperSecondsPerKm === null ? null : 3600 / band.upperSecondsPerKm,
    upper: band.lowerSecondsPerKm === null ? null : 3600 / band.lowerSecondsPerKm,
    color: zoneColors[index] ?? zoneColors[0]!
  })) ?? [];
  return (
    <div className="page detail-page">
      <Link to={returnTo} className="back-link"><ArrowLeft size={17} /> {returnTo.startsWith("/workouts") ? "返回训练记录" : "返回上一页"}</Link>
      {detail.error && !(!jobId && jobPollError) ? <p className="zone-setting-refresh-error" role="alert">最新详情刷新失败，当前保留上次成功加载的数据。<button type="button" className="text-button" onClick={() => void detail.reload()}>重新加载</button></p> : null}
      {!jobId && jobPollError ? <p className="zone-setting-refresh-error" role="alert">{jobPollError}<button type="button" className="text-button" onClick={() => void detail.reload().then((ok) => { if (ok) setJobPollError(null); })}>重新加载</button></p> : null}
      <header className="page-header split detail-reference-header"><div className="detail-title-block"><span className="detail-runner-mark" aria-hidden="true" /><div><h1 aria-label="训练详情 跑步">训练详情</h1><p>{date(workout.startedAt)} · {sessionType(workout.sessionType)} · {number(workout.distanceKm)} km</p><div className="workout-type-pair"><span><small>环境</small>{environment(workout.indoor)}</span><span className="stimulus"><small>刺激</small>{stimulusType(workout.stimulusType)} · {workout.stimulusConfidence === null ? "--" : `${Math.round(workout.stimulusConfidence * 100)}%`}</span></div></div></div><div className="header-actions"><StatusBadge value={workout.assessmentStatus} /><button className="button primary" onClick={() => setEditing(true)}><PencilSimple size={16} />编辑覆盖</button></div></header>
      {jobId ? <div className={`job-banner ${jobStatus === "succeeded" ? "completed" : jobStatus === "failed" || jobStatus === "cancelled" ? "failed" : ""}`}>{jobStatus === "succeeded" ? <CheckCircle size={20} /> : <Warning size={20} />}<span><b>{jobStatus === "succeeded" ? "新模型已激活" : jobStatus === "failed" ? "重算失败" : jobStatus === "cancelled" ? "重算已取消" : jobPollError ? "正在重新连接任务" : "重算任务进行中"}</b><small>{jobStatus === "succeeded" ? jobPollError ?? "页面已经切换到最新 active Run。" : jobStatus === "failed" || jobStatus === "cancelled" ? "旧 active Run 保持不变，可在数据与模型页查看任务详情。" : jobPollError ?? "当前页面继续展示旧 active Run，完成后自动更新。"}</small></span></div> : null}

      <section className="performance-strip expanded detail-reference-metrics"><article><Timer size={31} /><span>距离</span><b>{number(workout.distanceKm)} km</b></article><article><Timer size={31} /><span>用时</span><b>{duration(workout.durationSeconds)}</b></article><article><Pulse size={31} /><span>平均配速</span><b>{pace(workout.averagePaceSecondsPerKm)}/km</b></article><article><Heartbeat size={31} /><span>平均心率</span><b>{workout.averageHeartRateBpm === null ? "--" : `${Math.round(workout.averageHeartRateBpm)} bpm`}</b></article><article><Target size={31} /><span>即时能力</span><b>{number(workout.currentAbility)}</b></article><article><CheckCircle size={31} /><span>置信度</span><b>{confidenceLevel(workout.confidence)}</b></article></section>
      {!series.loading && !series.error && series.data && series.dataPath === seriesPath ? <><WorkoutSegments series={series.data} /><WorkoutSplits splits={series.data.splits} grade={series.data.grade} /></> : null}
      <WorkoutEnvironmentPanel environment={workout.environment} />
      {series.data && series.dataPath === seriesPath ? <WorkoutDynamicsPanel dynamics={series.data.dynamics} /> : null}
      {data.trainingLoad ? <><section className="workout-load-band"><span><small>综合负荷</small><b>{Math.round(data.trainingLoad.breakdown.compositeLoad)}</b></span><span><small>内部负荷</small><b>{data.trainingLoad.breakdown.internalLoad === null ? "--" : Math.round(data.trainingLoad.breakdown.internalLoad)}</b></span><span><small>配速负荷</small><b>{data.trainingLoad.breakdown.paceLoad === null ? "--" : Math.round(data.trainingLoad.breakdown.paceLoad)}</b></span><span><small>距离修正</small><b>×{data.trainingLoad.breakdown.distanceFactor.toFixed(2)}</b></span><span><small>原始 HRR-TRIMP</small><b>{data.trainingLoad.breakdown.rawHrrTrimp === null ? "--" : data.trainingLoad.breakdown.rawHrrTrimp.toFixed(1)}</b></span><span><small>距离暴露</small><b>{data.trainingLoad.breakdown.distanceExposureRatio === null ? "--" : `${data.trainingLoad.breakdown.distanceExposureRatio.toFixed(2)}× P75`}</b></span><span><small>心率负荷置信</small><b>{Math.round(data.trainingLoad.breakdown.heartRateConfidence * 100)}%</b></span><span><small>配速负荷置信</small><b>{Math.round(data.trainingLoad.breakdown.paceConfidence * 100)}%</b></span></section><div className="workout-load-explanations"><span>{loadSourceLabels[data.trainingLoad.source]}</span>{data.trainingLoad.explanations.map((item) => <span key={item.code}>{loadExplanationLabels[item.code] ?? item.code}</span>)}</div></> : null}

      {data.zoneSummary ? <section className="panel workout-zones-panel"><div className="panel-heading"><div><h2>{stimulusType(data.zoneSummary.stimulusType)}</h2><p>{data.zoneSummary.secondaryStimulusTypes.length ? `次要刺激：${data.zoneSummary.secondaryStimulusTypes.map(stimulusType).join("、")}` : "未识别达到最低剂量的次要刺激"} · 快照 {data.zoneSummary.zoneProfileId.slice(-8)}</p></div><strong>{Math.round(data.zoneSummary.stimulusConfidence * 100)}%</strong></div><div className="workout-zone-grid"><ZoneDistribution title="心率分区" coverage={data.zoneSummary.heartRateCoverage} items={data.zoneSummary.heartRateExposure} kind="heart" /><ZoneDistribution title="配速分区" coverage={data.zoneSummary.paceCoverage} items={data.zoneSummary.paceExposure} kind="pace" /></div>{data.zoneSummary.explanationCodes.length ? <div className="zone-explanations">{data.zoneSummary.explanationCodes.map((code) => <span key={code}>{explanation(code)}</span>)}</div> : null}</section> : null}

      <section className="panel workout-series-panel full-series-panel"><div className="panel-heading"><div><h2>补充训练时序</h2><p>步频、海拔、功率与跑姿指标共用训练偏移时间轴。</p></div>{series.data && series.dataPath === seriesPath ? <code>{series.data.sourceCategory}</code> : null}</div>{series.loading || (series.dataPath !== seriesPath && !series.error) ? <LoadingBlock label="正在读取训练时间序列" /> : series.error || !series.data || series.dataPath !== seriesPath ? <ErrorBlock message={series.error ?? "没有训练时间序列"} onRetry={() => void series.reload()} /> : <div className="series-grid"><WorkoutSeriesChart title="步频" series={series.data.series.cadence} color="#3c6e9d" /><WorkoutSeriesChart title="海拔" series={series.data.series.elevation} color="#6e786f" /><WorkoutSeriesChart title="跑步功率" series={series.data.series.power} color="#a96c19" /><WorkoutSeriesChart title="步幅" series={series.data.series.strideLength} color="#6d5ca8" /><WorkoutSeriesChart title="垂直振幅（设备估计）" series={series.data.series.verticalOscillation} color="#aa5571" /><WorkoutSeriesChart title="触地时间（设备估计）" series={series.data.series.groundContactTime} color="#7d6447" /></div>}</section>

      <section className="detail-grid">
        <article className="panel route-panel"><div className="panel-heading"><div><h2>运动轨迹</h2><p>{workout.routePointCount} 个原始轨迹点，质量 {number(workout.routeQuality)}</p></div>{workout.hasRoute ? <MapTrifold size={21} /> : null}</div><RoutePlot points={data.route} /></article>
        <article className="panel score-summary workout-analysis-panel"><div className="panel-heading"><div><h2>训练分析</h2><p>展示 API 返回的原始评分字段与解释码，不在页面端推断等级。</p></div></div><ul><li><CheckCircle size={18} /><span><b>整体指标</b><small>即时能力 {number(workout.currentAbility)} · 评估状态 {status(workout.assessmentStatus)} · 质量分 {number(workout.qualityScore)}</small></span></li><li><Heartbeat size={18} /><span><b>心率</b><small>{workout.averageHeartRateBpm === null ? "无心率数据" : `平均 ${Math.round(workout.averageHeartRateBpm)} bpm · 覆盖 ${workout.heartRateCoverage === null ? "--" : `${Math.round(workout.heartRateCoverage * 100)}%`}`}</small></span></li><li><Pulse size={18} /><span><b>配速与节奏</b><small>平均配速 {pace(workout.averagePaceSecondsPerKm)}/km，本次识别为{sessionType(workout.sessionType)}。</small></span></li><li><Target size={18} /><span><b>建议</b><small>{workout.explanationCodes[0] ? explanation(workout.explanationCodes[0]) : "暂无模型解释码。"}</small></span></li></ul><div className="analysis-ta-update"><span>TA 更新</span><b>{number(workout.trueAbilityBefore)} → {number(workout.trueAbilityAfter)}</b><small className={(workout.trueAbilityDelta ?? 0) >= 0 ? "positive-text" : "negative-text"}>{workout.trueAbilityDelta === null ? "--" : `${workout.trueAbilityDelta >= 0 ? "+" : ""}${workout.trueAbilityDelta.toFixed(2)}`}</small></div></article>
      </section>

      <section className="panel workout-series-panel primary-series-panel"><div className="panel-heading"><div><h2 aria-label="训练内变化">配速与心率</h2><p>两项关键时序使用同一训练偏移时间轴。</p></div>{series.data && series.dataPath === seriesPath ? <span className="series-legend"><i /> 配速（/km） <i /> 心率（bpm）</span> : null}</div>{series.loading || (series.dataPath !== seriesPath && !series.error) ? <LoadingBlock label="正在读取训练时间序列" /> : series.error || !series.data || series.dataPath !== seriesPath ? <ErrorBlock message={series.error ?? "没有训练时间序列"} onRetry={() => void series.reload()} /> : <div className="series-grid"><WorkoutSeriesChart title="心率" series={series.data.series.heartRate} color="#ef3f22" bands={heartBands} /><WorkoutSeriesChart title="跑速" series={series.data.series.speed} color="#199bd3" bands={paceBands} /></div>}</section>

      <section className="detail-grid lower">
        <article className="panel"><div className="panel-heading"><div><h2>维度评分</h2><p>Cardio 仅作诊断，不进入当前 CA 权重。</p></div></div><div className="dimension-list">{Object.entries(data.dimensions).map(([key, value]) => <div key={key} className={key === "cardio" ? "diagnostic" : ""}><span>{dimensionLabels[key as keyof typeof dimensionLabels]}{key === "cardio" ? <small>诊断</small> : null}</span><b>{number(value)}</b><i style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></div>)}</div></article>
        <article className="panel"><div className="panel-heading"><div><h2>解释与数据质量</h2><p>所有结论来自 active Assessment · {workout.modelVersion}。</p></div></div><ul className="evidence-list">{workout.explanationCodes.map((code) => <li key={code}>{explanation(code)}</li>)}</ul><div className="quality-grid"><span><small>心率覆盖</small><b>{workout.heartRateCoverage === null ? "--" : `${(workout.heartRateCoverage * 100).toFixed(1)}%`}</b></span><span><small>质量分</small><b>{number(workout.qualityScore)}</b></span><span><small>来源置信</small><b>{number(workout.sourceConfidence)}</b></span><span><small>训练贡献</small><b>{number(workout.workoutContribution)}</b></span></div>{workout.missingReasons.length > 0 ? <div className="missing-reasons"><b>数据与资格说明</b>{workout.missingReasons.map((reason) => <span key={reason}>{missingReason(reason)}</span>)}</div> : null}<div className="running-form-metrics"><span>功率 {workout.averagePowerWatts === null ? "--" : `${Math.round(workout.averagePowerWatts)} W`}</span><span>步幅 {workout.averageStrideLengthMeters === null ? "--" : `${workout.averageStrideLengthMeters.toFixed(2)} m`}</span><span>垂直振幅（设备估计，仅记录） {workout.averageVerticalOscillationCm === null ? "--" : `${workout.averageVerticalOscillationCm.toFixed(1)} cm`}</span><span>触地时间（设备估计，仅记录） {workout.averageGroundContactTimeMs === null ? "--" : `${Math.round(workout.averageGroundContactTimeMs)} ms`}</span></div></article>
      </section>
      {data.override ? <section className="panel review-panel"><div className="panel-heading"><div><h2>个人复盘</h2><p>标准测试和比赛标签会用于生理与成绩预测校准，不反向修改当前 CA。</p></div><code>revision {data.override.revision}</code></div><div className="review-content"><span><small>RPE</small><b>{data.override.rpe ?? "--"}</b></span><span><small>标准测试</small><b>{data.override.performanceProtocol ?? "--"}</b></span><span><small>状态标签</small><b>{data.override.conditionTags.join("、") || "--"}</b></span><span className="review-note"><small>备注</small><p>{data.override.note || "没有备注"}</p></span></div></section> : null}
      <div className="desktop-share-card"><ShareCardPanel key={workout.id} trainingSessionId={workout.id} /></div>
      {editing ? <OverrideDrawer detail={data} onClose={() => setEditing(false)} onSaved={(value) => void watchJob(value)} /> : null}
    </div>
  );
}
