import type { WorkoutDetailResponse, WorkoutSeriesResponse } from "@rai/api-contracts";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { OverrideDrawer } from "../components/OverrideDrawer.js";
import { RoutePlot } from "../components/RoutePlot.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { WorkoutSeriesChart } from "../components/WorkoutSeriesChart.js";
import { api } from "../api.js";
import { confidenceLevel, date, duration, environment, explanation, heartRateZone, missingReason, number, pace, paceZone, sessionType, source, stimulusType } from "../format.js";
import { useRemote } from "../hooks.js";
import { ArrowLeft, CheckCircle, MapTrifold, PencilSimple, Warning } from "../icons.js";

const dimensionLabels = { efficiency: "Efficiency", pace: "Pace", cardio: "Cardio", stability: "Stability", recovery: "Recovery" } as const;
const loadSourceLabels = { heart_rate_series: "心率序列计算", average_heart_rate: "平均心率估算", rpe: "RPE 估算", session_type: "训练类型估算" } as const;
const loadExplanationLabels: Record<string, string> = {
  load_source_heart_rate_series: "按训练窗口内的心率区间积分",
  load_source_average_heart_rate: "心率序列覆盖不足，使用平均心率估算",
  load_source_rpe: "缺少可用心率，使用主观用力程度估算",
  load_source_session_type: "缺少心率和 RPE，使用训练类型保守估算"
};
const zoneColors = ["#dce8ec", "#dfeadf", "#f0e4b8", "#f4d3c9", "#efc2be"];

function ZoneDistribution({ title, coverage, items, kind }: {
  title: string;
  coverage: number;
  items: Array<{ zone: string; durationSeconds: number; distanceMeters: number; fraction: number }>;
  kind: "heart" | "pace";
}) {
  return <div className="workout-zone-distribution"><header><span><b>{title}</b><small>有效覆盖 {Math.round(coverage * 100)}%</small></span></header><div className="zone-stacked-bar" aria-label={`${title}分布`}>{items.map((item, index) => <i key={item.zone} className={`zone-${index + 1}`} style={{ width: `${Math.max(0, item.fraction * 100)}%` }} title={`${kind === "heart" ? heartRateZone(item.zone) : paceZone(item.zone)} ${duration(item.durationSeconds)}`} />)}</div><div className="zone-exposure-list">{items.map((item, index) => <span key={item.zone}><i className={`zone-${index + 1}`} /><b>{kind === "heart" ? heartRateZone(item.zone) : paceZone(item.zone)}</b><small>{duration(item.durationSeconds)}{kind === "pace" && item.distanceMeters > 0 ? ` · ${(item.distanceMeters / 1000).toFixed(1)} km` : ""}</small></span>)}</div></div>;
}

function WorkoutSplits({ splits }: { splits: WorkoutSeriesResponse["splits"] }) {
  return <section className="panel workout-splits-panel"><div className="panel-heading"><div><h2>公里分段</h2><p>按累计距离切分；最后不足 1 公里的尾段单独列出。</p></div><code>{splits.length} 段</code></div>{splits.length === 0 ? <div className="splits-empty">没有足够的跑速数据生成公里分段</div> : <div className="splits-table-wrap"><table className="splits-table"><caption className="sr-only">公里分段</caption><thead><tr><th scope="col">分段</th><th scope="col">用时</th><th scope="col">距离</th><th scope="col">平均配速</th><th scope="col">平均心率</th><th scope="col">平均步频</th></tr></thead><tbody>{splits.map((split) => <tr key={split.index}><td><b>{split.distanceMeters < 999.5 ? "尾段" : `${split.index} km`}</b></td><td>{duration(split.durationSeconds)}</td><td>{(split.distanceMeters / 1000).toFixed(split.distanceMeters < 1000 ? 2 : 1)} km</td><td>{pace(split.averagePaceSecondsPerKm)}/km</td><td>{split.averageHeartRateBpm === null ? "--" : `${Math.round(split.averageHeartRateBpm)} bpm`}</td><td>{split.averageCadenceSpm === null ? "--" : `${Math.round(split.averageCadenceSpm)} spm`}</td></tr>)}</tbody></table></div>}</section>;
}

export function WorkoutDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const returnTo = (location.state as { from?: string } | null)?.from ?? "/workouts";
  const detail = useRemote<WorkoutDetailResponse>(`/v1/workouts/${id ?? ""}`);
  const series = useRemote<WorkoutSeriesResponse>(`/v1/workouts/${id ?? ""}/series`);
  const [editing, setEditing] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<"queued" | "running" | "succeeded" | "failed" | "cancelled" | null>(null);
  const [jobPollError, setJobPollError] = useState<string | null>(null);

  const watchJob = (value: string | null) => {
    setEditing(false);
    setJobId(value);
    setJobStatus(value ? "queued" : null);
    setJobPollError(null);
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
        if (job.status === "succeeded") {
          void detail.reload();
          return;
        }
        if (job.status === "failed" || job.status === "cancelled") return;
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

  if (detail.loading) return <LoadingBlock />;
  if (detail.error || !detail.data) return <ErrorBlock message={detail.error ?? "训练不存在"} onRetry={() => void detail.reload()} />;
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
      <header className="page-header split"><div><h1>{date(workout.startedAt)} 跑步</h1><p>{environment(workout.indoor)} · {source(workout.sourceCategory)} · {workout.hasRoute ? "路线可用" : "无路线"}</p><div className="workout-type-pair"><span><small>结构</small>{sessionType(workout.sessionType)}</span><span className="stimulus"><small>刺激</small>{stimulusType(workout.stimulusType)} · {workout.stimulusConfidence === null ? "--" : `${Math.round(workout.stimulusConfidence * 100)}%`}</span></div></div><div className="header-actions"><StatusBadge value={workout.assessmentStatus} /><button className="button primary" onClick={() => setEditing(true)}><PencilSimple size={16} />编辑覆盖</button></div></header>
      {jobId ? <div className={`job-banner ${jobStatus === "succeeded" ? "completed" : jobStatus === "failed" || jobStatus === "cancelled" ? "failed" : ""}`}>{jobStatus === "succeeded" ? <CheckCircle size={20} /> : <Warning size={20} />}<span><b>{jobStatus === "succeeded" ? "新模型已激活" : jobStatus === "failed" ? "重算失败" : jobStatus === "cancelled" ? "重算已取消" : jobPollError ? "正在重新连接任务" : "重算任务进行中"}</b><small>{jobStatus === "succeeded" ? "页面已经切换到最新 active Run。" : jobStatus === "failed" || jobStatus === "cancelled" ? "旧 active Run 保持不变，可在数据与模型页查看任务详情。" : jobPollError ?? "当前页面继续展示旧 active Run，完成后自动更新。"}</small></span></div> : null}

      <section className="performance-strip expanded"><article><span>距离</span><b>{number(workout.distanceKm)} km</b></article><article><span>运动 / 经过时长</span><b>{duration(workout.durationSeconds)} / {duration(workout.elapsedSeconds)}</b></article><article><span>平均配速</span><b>{pace(workout.averagePaceSecondsPerKm)}/km</b></article><article><span>平均心率</span><b>{workout.averageHeartRateBpm === null ? "--" : `${Math.round(workout.averageHeartRateBpm)} bpm`}</b></article><article><span>活动能量</span><b>{workout.activeEnergyKcal === null ? "--" : `${Math.round(workout.activeEnergyKcal)} kcal`}</b></article><article><span>累计爬升</span><b>{workout.elevationGainMeters === null ? "--" : `${Math.round(workout.elevationGainMeters)} m`}</b></article><article><span>平均步频</span><b>{workout.averageCadenceSpm === null ? "--" : `${Math.round(workout.averageCadenceSpm)} spm`}</b></article><article><span>平均功率</span><b>{workout.averagePowerWatts === null ? "--" : `${Math.round(workout.averagePowerWatts)} W`}</b></article></section>
      {!series.loading && !series.error && series.data ? <WorkoutSplits splits={series.data.splits} /> : null}
      {data.trainingLoad ? <><section className="workout-load-band"><span><small>综合负荷</small><b>{Math.round(data.trainingLoad.breakdown.compositeLoad)}</b></span><span><small>内部负荷</small><b>{data.trainingLoad.breakdown.internalLoad === null ? "--" : Math.round(data.trainingLoad.breakdown.internalLoad)}</b></span><span><small>配速负荷</small><b>{data.trainingLoad.breakdown.paceLoad === null ? "--" : Math.round(data.trainingLoad.breakdown.paceLoad)}</b></span><span><small>距离修正</small><b>×{data.trainingLoad.breakdown.distanceFactor.toFixed(2)}</b></span><span><small>原始 HRR-TRIMP</small><b>{data.trainingLoad.breakdown.rawHrrTrimp === null ? "--" : data.trainingLoad.breakdown.rawHrrTrimp.toFixed(1)}</b></span><span><small>距离暴露</small><b>{data.trainingLoad.breakdown.distanceExposureRatio === null ? "--" : `${data.trainingLoad.breakdown.distanceExposureRatio.toFixed(2)}× P75`}</b></span><span><small>心率负荷置信</small><b>{Math.round(data.trainingLoad.breakdown.heartRateConfidence * 100)}%</b></span><span><small>配速负荷置信</small><b>{Math.round(data.trainingLoad.breakdown.paceConfidence * 100)}%</b></span></section><div className="workout-load-explanations"><span>{loadSourceLabels[data.trainingLoad.source]}</span>{data.trainingLoad.explanations.map((item) => <span key={item.code}>{loadExplanationLabels[item.code] ?? item.code}</span>)}</div></> : null}

      {data.zoneSummary ? <section className="panel workout-zones-panel"><div className="panel-heading"><div><h2>{stimulusType(data.zoneSummary.stimulusType)}</h2><p>{data.zoneSummary.secondaryStimulusTypes.length ? `次要刺激：${data.zoneSummary.secondaryStimulusTypes.map(stimulusType).join("、")}` : "未识别达到最低剂量的次要刺激"} · 快照 {data.zoneSummary.zoneProfileId.slice(-8)}</p></div><strong>{Math.round(data.zoneSummary.stimulusConfidence * 100)}%</strong></div><div className="workout-zone-grid"><ZoneDistribution title="心率分区" coverage={data.zoneSummary.heartRateCoverage} items={data.zoneSummary.heartRateExposure} kind="heart" /><ZoneDistribution title="配速分区" coverage={data.zoneSummary.paceCoverage} items={data.zoneSummary.paceExposure} kind="pace" /></div>{data.zoneSummary.explanationCodes.length ? <div className="zone-explanations">{data.zoneSummary.explanationCodes.map((code) => <span key={code}>{explanation(code)}</span>)}</div> : null}</section> : null}

      <section className="panel workout-series-panel"><div className="panel-heading"><div><h2>训练内变化</h2><p>图表共用训练偏移时间轴；心率和跑速底色来自本次训练的冻结分区快照。</p></div>{series.data ? <code>{series.data.sourceCategory}</code> : null}</div>{series.loading ? <LoadingBlock label="正在读取训练时间序列" /> : series.error || !series.data ? <ErrorBlock message={series.error ?? "没有训练时间序列"} onRetry={() => void series.reload()} /> : <div className="series-grid"><WorkoutSeriesChart title="心率" series={series.data.series.heartRate} color="#b94f3f" bands={heartBands} /><WorkoutSeriesChart title="跑速" series={series.data.series.speed} color="#175f43" bands={paceBands} /><WorkoutSeriesChart title="步频" series={series.data.series.cadence} color="#3c6e9d" /><WorkoutSeriesChart title="海拔" series={series.data.series.elevation} color="#6e786f" /><WorkoutSeriesChart title="跑步功率" series={series.data.series.power} color="#a96c19" /><WorkoutSeriesChart title="步幅" series={series.data.series.strideLength} color="#6d5ca8" /><WorkoutSeriesChart title="垂直振幅" series={series.data.series.verticalOscillation} color="#aa5571" /><WorkoutSeriesChart title="触地时间" series={series.data.series.groundContactTime} color="#7d6447" /></div>}</section>

      <section className="detail-grid">
        <article className="panel route-panel"><div className="panel-heading"><div><h2>运动轨迹</h2><p>{workout.routePointCount} 个原始轨迹点，质量 {number(workout.routeQuality)}</p></div>{workout.hasRoute ? <MapTrifold size={21} /> : null}</div><RoutePlot points={data.route} /></article>
        <article className="panel score-summary"><span>即时能力 / CA</span><strong>{number(workout.currentAbility)}</strong><p>置信度 {confidenceLevel(workout.confidence)} · {workout.confidence === null ? "--" : `${Math.round(workout.confidence * 100)}%`}</p><div className="ta-update"><span>TA 更新</span><b>{number(workout.trueAbilityBefore)} → {number(workout.trueAbilityAfter)}</b><small className={(workout.trueAbilityDelta ?? 0) >= 0 ? "positive-text" : "negative-text"}>{workout.trueAbilityDelta === null ? "--" : `${workout.trueAbilityDelta >= 0 ? "+" : ""}${workout.trueAbilityDelta.toFixed(2)}`}</small></div><p className="model-update-note">{workout.updatedTrueAbility ? "本次已参与真实跑力更新" : "本次未更新真实跑力"}</p></article>
      </section>

      <section className="detail-grid lower">
        <article className="panel"><div className="panel-heading"><div><h2>维度评分</h2><p>Cardio 仅作诊断，不进入当前 CA 权重。</p></div></div><div className="dimension-list">{Object.entries(data.dimensions).map(([key, value]) => <div key={key} className={key === "cardio" ? "diagnostic" : ""}><span>{dimensionLabels[key as keyof typeof dimensionLabels]}{key === "cardio" ? <small>诊断</small> : null}</span><b>{number(value)}</b><i style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></div>)}</div></article>
        <article className="panel"><div className="panel-heading"><div><h2>解释与数据质量</h2><p>所有结论来自 active Assessment · {workout.modelVersion}。</p></div></div><ul className="evidence-list">{workout.explanationCodes.map((code) => <li key={code}>{explanation(code)}</li>)}</ul><div className="quality-grid"><span><small>心率覆盖</small><b>{workout.heartRateCoverage === null ? "--" : `${(workout.heartRateCoverage * 100).toFixed(1)}%`}</b></span><span><small>质量分</small><b>{number(workout.qualityScore)}</b></span><span><small>来源置信</small><b>{number(workout.sourceConfidence)}</b></span><span><small>训练贡献</small><b>{number(workout.workoutContribution)}</b></span></div>{workout.missingReasons.length > 0 ? <div className="missing-reasons"><b>数据与资格说明</b>{workout.missingReasons.map((reason) => <span key={reason}>{missingReason(reason)}</span>)}</div> : null}<div className="running-form-metrics"><span>步幅 {workout.averageStrideLengthMeters === null ? "--" : `${workout.averageStrideLengthMeters.toFixed(2)} m`}</span><span>垂直振幅 {workout.averageVerticalOscillationCm === null ? "--" : `${workout.averageVerticalOscillationCm.toFixed(1)} cm`}</span><span>触地时间 {workout.averageGroundContactTimeMs === null ? "--" : `${Math.round(workout.averageGroundContactTimeMs)} ms`}</span></div></article>
      </section>
      {data.override ? <section className="panel review-panel"><div className="panel-heading"><div><h2>个人复盘</h2><p>标准测试和比赛标签会用于生理与成绩预测校准，不反向修改当前 CA。</p></div><code>revision {data.override.revision}</code></div><div className="review-content"><span><small>RPE</small><b>{data.override.rpe ?? "--"}</b></span><span><small>标准测试</small><b>{data.override.performanceProtocol ?? "--"}</b></span><span><small>状态标签</small><b>{data.override.conditionTags.join("、") || "--"}</b></span><span className="review-note"><small>备注</small><p>{data.override.note || "没有备注"}</p></span></div></section> : null}
      {editing ? <OverrideDrawer detail={data} onClose={() => setEditing(false)} onSaved={(value) => void watchJob(value)} /> : null}
    </div>
  );
}
