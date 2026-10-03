import "../pixel-layout.css";
import "../analysis-reference.css";
import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type {
  PhysiologyGuidanceCode,
  PredictionResponse,
  RaceDistance,
  RaceTimePrediction
} from "@rai/api-contracts";

import { PerformanceEntriesPanel } from "../components/PerformanceEntriesPanel.js";
import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { date, duration, number, pace } from "../format.js";
import { CheckCircle, Heartbeat, ShieldCheck, Target, Timer, Warning, WarningCircle } from "../icons.js";
import { useRemote } from "../hooks.js";

interface ScenarioDraft {
  temperatureC: string;
  humidityPercent: string;
  elevationGain5k: string;
  elevationGain10k: string;
  elevationGainHalfMarathon: string;
}

const emptyScenario: ScenarioDraft = {
  temperatureC: "",
  humidityPercent: "",
  elevationGain5k: "",
  elevationGain10k: "",
  elevationGainHalfMarathon: ""
};

const distanceLabels: Record<RaceDistance, string> = {
  five_k: "5 公里",
  ten_k: "10 公里",
  half_marathon: "半程马拉松"
};

const distanceKilometers: Record<RaceDistance, number> = {
  five_k: 5,
  ten_k: 10,
  half_marathon: 21.0975
};

function labelRejectionText(code: string): string {
  const labels: Record<string, string> = {
    inactive_session: "已删除或非活动训练",
    not_completed: "训练尚未完成",
    not_confirmed: "未确认标准测试或比赛",
    user_excluded: "用户已排除",
    threshold_only_protocol: "仅用于阈值估计，不作为比赛成绩标签",
    distance_missing: "距离缺失或无效",
    unsupported_distance: "距离不符合当前比赛预测范围",
    protocol_distance_mismatch: "所选测试协议与实际距离不匹配",
    duration_or_pace_out_of_range: "时长或配速不满足标签质量要求"
  };
  return labels[code] ?? code;
}

const guidanceLabels: Record<PhysiologyGuidanceCode, string> = {
  direct_vo2_evidence_missing: "缺少 Apple Health VO₂max 直接记录，生理上限估计主要依赖训练表现。",
  standard_test_missing: "还没有用户确认的标准测试跑或比赛结果，成绩预测保持低置信。",
  threshold_segments_missing: "没有满足稳定性与强度条件的阈值片段，乳酸阈值仍以先验为主。",
  race_readiness_missing: "缺少专项训练证据，准备度未建模，预测使用保守默认值。",
  prediction_confidence_low: "当前预测证据有限，请把区间而不是单一点值作为主要参考。"
};

const predictionMethod = (value: string): string => {
  switch (value) {
    case "ridge_ensemble_v5": return "Ridge 残差增强";
    case "catboost_residual_v6": return "CatBoost 残差增强";
    case "bias_calibrated_v4": return "历史偏差校准";
    case "daniels_vdot_conditions_v3": return "VDOT + 场景修正";
    case "daniels_vdot_readiness_v2": return "VDOT + 专项准备度";
    default: return "Daniels VDOT";
  }
};

const fallbackLabels: Record<NonNullable<RaceTimePrediction["machineLearningFallbackReason"]>, string> = {
  no_active_model: "当前没有已激活的机器学习模型，本距离使用公式基线。",
  unsupported_distance: "机器学习模型不支持本距离，本距离使用公式基线。",
  inference_failed: "机器学习推理失败，本距离已回退到公式基线。",
  feature_schema_mismatch: "模型特征版本不匹配，本距离已回退到公式基线。"
};

function PredictionMetric({
  icon,
  label,
  value,
  detail,
  progress
}: {
  icon: "timer" | "medal" | "clipboard";
  label: string;
  value: string;
  detail: string;
  progress?: number;
}) {
  return (
    <div className="race-metric">
      <span className={`race-metric-icon ${icon}`} aria-hidden="true">
        {icon === "timer" ? <Timer size={32} /> : icon === "medal" ? "1" : "="}
      </span>
      <span className="race-metric-copy">
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
      {progress === undefined ? null : <i><b style={{ width: `${progress}%` }} /></i>}
    </div>
  );
}

function RaceCard({ prediction }: { prediction: RaceTimePrediction }) {
  const label = distanceLabels[prediction.distance];
  if (prediction.status !== "available" || prediction.predictedSeconds === null) {
    return (
      <article className="panel race-prediction-card unavailable">
        <header><h2>{label}</h2><span className="status-badge neutral">数据不足</span></header>
        <p>当前没有足够的有效 VDOT 证据生成成绩预测。</p>
      </article>
    );
  }
  const readiness = prediction.readiness === null ? null : Math.round(prediction.readiness * 100);
  const distanceKm = distanceKilometers[prediction.distance];
  const potentialValue =
    prediction.potentialSeconds === null ? "--" : duration(prediction.potentialSeconds);
  const potentialDetail =
    prediction.potentialSeconds === null
      ? "暂无生理潜力估计"
      : `相当配速 ${pace(prediction.potentialSeconds / distanceKm)} /km`;
  return (
    <article className="panel race-prediction-card">
      <header><h2>{label}</h2></header>
      <PredictionMetric icon="timer" label="生理潜力" value={potentialValue} detail={potentialDetail} />
      <PredictionMetric icon="medal" label="当前能力" value={duration(prediction.predictedSeconds)} detail={`相当配速 ${pace(prediction.predictedSeconds / distanceKm)} /km`} />
      <PredictionMetric icon="clipboard" label="专项准备度" value={readiness === null ? "--" : `${readiness}%`} detail={readiness === null ? "证据不足，不等于准备度低" : "训练暴露规则估计，未实证校准"} {...(readiness === null ? {} : { progress: readiness })} />
      <footer className="race-prediction-meta">
        <dl>
          <div><dt>方法</dt><dd>{predictionMethod(prediction.method)}</dd></div>
          <div><dt>证据可靠性（规则估计）</dt><dd>{Math.round(prediction.confidence * 100)}%</dd></div>
          <div><dt>参考区间（非 P80/P90 保证）</dt><dd>{prediction.optimisticSeconds === null ? "--" : duration(prediction.optimisticSeconds)} 至 {prediction.pessimisticSeconds === null ? "--" : duration(prediction.pessimisticSeconds)}</dd></div>
        </dl>
        {prediction.intervalEvidence?.status === "empirically_evaluated" && prediction.intervalEvidence.p80 ? <p>
          经验区间（目标覆盖 80%）：{duration(prediction.intervalEvidence.p80.lowerSeconds)} 至 {duration(prediction.intervalEvidence.p80.upperSeconds)}。
          独立验证 {prediction.intervalEvidence.evaluationSamples} 场，实际覆盖 {number((prediction.intervalEvidence.coverageP80??0)*100,1)}%；不保证单场结果。
        </p> : null}
        {prediction.machineLearningFallbackReason === null ? null : <p className="prediction-fallback-note">{
          prediction.machineLearningPolicyReason === "calibration_unavailable" ? "模型尚未通过独立区间校准，继续使用公式基线。"
            : prediction.machineLearningPolicyReason === "ridge_not_validated" ? "模型缺少有效的简单模型对照验证，继续使用公式基线。"
              : fallbackLabels[prediction.machineLearningFallbackReason]
        }</p>}
      </footer>
    </article>
  );
}

function MarathonCard() {
  return (
    <article className="panel race-prediction-card marathon-placeholder">
      <header><h2>马拉松</h2></header>
      <p className="prediction-marathon-unavailable">
        当前模型未提供马拉松距离预测。请以 5K / 10K / 半马结果为准；全马能力请结合专项训练与官方成绩评估。
      </p>
    </article>
  );
}

export function PredictionsPage() {
  const [draft, setDraft] = useState<ScenarioDraft>(emptyScenario);
  const [query, setQuery] = useState("");
  const path = useMemo(() => `/v1/predictions${query || "?mode=current_prepared"}`, [query]);
  const report = useRemote<PredictionResponse>(path);

  const update = (key: keyof ScenarioDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(draft)) {
      if (value.trim() !== "") params.set(key, value.trim());
    }
    if (params.size > 0) {
      params.set("mode","race_day_scenario");
      params.set("targetDate",new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()));
    }
    const next = params.size === 0 ? "" : `?${params.toString()}`;
    if (next === query) void report.reload();
    else setQuery(next);
  };
  const reset = () => {
    setDraft(emptyScenario);
    if (query === "") void report.reload();
    else setQuery("");
  };

  if (report.loading) return <div className="page"><LoadingBlock label="正在重放生理预测" /></div>;
  if (report.error || !report.data) {
    return <div className="page"><ErrorBlock message={report.error ?? "没有可用预测"} onRetry={() => void report.reload()} /></div>;
  }

  const data = report.data;
  const snapshot = data.snapshot;
  const ml = data.modelSelection.machineLearning;
  const recoveryScore = data.inputs.recoveryReadiness == null ? null : Math.round(data.inputs.recoveryReadiness * 100);
  const evidenceCounts = [
    ["表现 VDOT 证据", data.inputs.performanceVdotEvidence],
    ["阈值片段", data.inputs.lactateThresholdSegments],
    ["标记比赛/测试", data.inputs.labeledRaceOutcomes],
    ["直接 VO₂ 记录", data.inputs.directVo2Evidence]
  ] as const;
  const mlStatusLabel =
    ml.status === "active"
      ? "CatBoost 已应用"
      : ml.status === "inference_unavailable"
        ? "模型不可用，已回退公式"
        : ml.status === "stale"
          ? "模型已过期，请重新训练"
          : ml.status === "insufficient_samples"
            ? "样本不足"
            : "公式基线";
  return (
    <div className="page predictions-page">
      <header className="page-header split">
        <div className="header-title-with-icon"><span className="prediction-title-mark" aria-hidden="true">1</span><div><h1>生理与成绩预测</h1><p>区分生理上限、当前表现能力和专项比赛准备度。</p></div></div>
        <nav className="prediction-reference-tabs" aria-label="分析页面导航"><Link to="/zones">训练分区</Link><Link to="/statistics">运动统计</Link><Link to="/trends">能力趋势</Link><b aria-current="page">生理与成绩预测</b></nav>
        <div className="model-chip"><span aria-hidden="true">▦</span><b>{snapshot.modelVersion}</b><small>{date(data.generatedAt, true)}</small><i aria-hidden="true">⌄</i></div>
      </header>

      <section className="prediction-overview" aria-label="生理能力预测">
        <article>
          <span className="overview-icon blue"><Timer size={38} /></span><div><span>VO₂max</span><strong>{number(snapshot.vo2Max.valueMlKgMin, 1)}<small>ml/kg/min</small></strong><p>当前估计 · 置信度 <b>{Math.round(snapshot.vo2Max.confidence * 100)}%</b></p><span className="prediction-test-label">有效 VDOT</span><span className="sr-only">{number(snapshot.performanceVdot.value, 1)}</span></div>
        </article>
        <article>
          <span className="overview-icon coral"><Target size={38} /></span><div><span>乳酸阈值 pace</span><strong>{pace(snapshot.lactateThreshold.paceSecondsPerKm)}<small>/km</small></strong><p><b>当前模型快照</b></p></div>
        </article>
        <article>
          <span className="overview-icon heart"><Heartbeat size={40} weight="fill" /></span><div><span>阈值心率</span><strong>{snapshot.lactateThreshold.heartRateBpm === null ? "--" : Math.round(snapshot.lactateThreshold.heartRateBpm)}<small>bpm</small></strong><p><b>当前模型快照</b></p></div>
        </article>
        <article>
          <span className="overview-icon battery"><ShieldCheck size={39} /></span><div><span>恢复准备度</span><strong>{recoveryScore == null ? "--" : <>{recoveryScore}<small>%</small></>}</strong><p><b>{recoveryScore == null ? "数据不足，已省略疲劳修正" : "近期背景规则估计，非医学评估"}</b></p></div>
        </article>
      </section>

      <section className="race-prediction-grid">
        {snapshot.races.map((prediction) => <RaceCard key={prediction.distance} prediction={prediction} />)}
        <MarathonCard />
      </section>

      {data.labelFunnel ? <section className="panel" aria-label="标签评估进度">
        <h2>标签与验证进度</h2>
        <p>训练 {data.labelFunnel.sessionCount} 次 → 已确认 {data.labelFunnel.confirmedCount} 次 → 合格比赛结果 {data.labelFunnel.usableOutcomeCount} 次 → 训练样本 {data.labelFunnel.trainingSampleCount} 次 → 可回放评估 {data.labelFunnel.evaluatedOutcomeCount} 次。</p>
        {data.labelFunnel.trainingExcludedOutcomeCount > 0 ? <p>缺少赛前证据的成绩 {data.labelFunnel.trainingExcludedOutcomeCount} 次，未进入训练集。</p> : null}
        <p>{data.labelFunnel.accuracyStatus === "not_evaluable"
          ? "尚无合格标签，不能证明预测准确率或激活精度增强。"
          : "已有标签不代表通过发布门槛；仍需分距离、独立留出和区间验证。"}</p>
        <p>请在已有训练详情的“标准测试 / 比赛”中确认真实结果。无需为凑标签增加训练或频繁进行全力测试。</p>
        <Link to="/workouts">查看训练并确认已有结果</Link>
        {Object.keys(data.labelFunnel.primaryRejections).length ? <details>
          <summary>未进入评估的原因</summary>
          <ul>{Object.entries(data.labelFunnel.primaryRejections).map(([code, count]) =>
            <li key={code}>{labelRejectionText(code)}：{count}</li>)}</ul>
        </details> : null}
      </section> : null}

      <section className="panel scenario-panel">
        <div className="panel-heading"><div><h2>比赛场景</h2><p>调整温湿度和赛道爬升，仅重新计算预测，不修改历史数据或 CA/TA。</p></div></div>
        <form className="scenario-form" onSubmit={submit}>
          <label className="field"><span>温度</span><input aria-label="温度" type="number" min="-40" max="60" step="0.1" value={draft.temperatureC} onChange={(event) => update("temperatureC", event.target.value)} placeholder="15°C" /></label>
          <label className="field"><span>湿度</span><input aria-label="湿度" type="number" min="0" max="100" step="1" value={draft.humidityPercent} onChange={(event) => update("humidityPercent", event.target.value)} placeholder="50%" /></label>
          <label className="field"><span>5K 爬升</span><input aria-label="5K 爬升" type="number" min="0" max="10000" step="1" value={draft.elevationGain5k} onChange={(event) => update("elevationGain5k", event.target.value)} placeholder="0 m" /></label>
          <label className="field"><span>10K 爬升</span><input aria-label="10K 爬升" type="number" min="0" max="10000" step="1" value={draft.elevationGain10k} onChange={(event) => update("elevationGain10k", event.target.value)} placeholder="0 m" /></label>
          <label className="field"><span>半马爬升</span><input aria-label="半马爬升" type="number" min="0" max="10000" step="1" value={draft.elevationGainHalfMarathon} onChange={(event) => update("elevationGainHalfMarathon", event.target.value)} placeholder="0 m" /></label>
          <div className="scenario-actions"><button type="button" className="button secondary" aria-label="恢复标准条件" onClick={reset}>重置</button><button className="button primary" type="submit">应用场景</button></div>
        </form>
      </section>

      <section className="prediction-detail-grid">
        <article className="panel prediction-evidence-panel">
          <div className="panel-heading"><div><h2>证据计数</h2><p>均限制在预测生成时刻之前，为原始计数而非编造百分比。</p></div><ShieldCheck size={19} /></div>
          <div className="evidence-readiness-layout">
            <div className="readiness-list">
              {evidenceCounts.map(([label, value], index) => (
                <div key={label}>
                  <span><i>{["◉", "▥", "◆", "▥"][index]}</i>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <div className="readiness-score">
              <span><b>{recoveryScore == null ? "--" : <>{recoveryScore}<small>%</small></>}</b></span>
              <strong>恢复准备度</strong>
              <small>近期背景规则估计，未实证校准</small>
            </div>
          </div>
        </article>
        <article className={`panel prediction-model-panel ${ml.status === "active" ? "active" : "fallback"}`}>
          <div className="panel-heading"><div><h2 aria-label="CatBoost 预测模型">模型状态</h2><p>离线验证通过后可激活；失败时明确回退到公式。</p></div>{ml.status === "active" ? <CheckCircle size={19} /> : <WarningCircle size={19} />}</div>
          <dl>
            <div><dt>模型版本</dt><dd>{ml.activeModelVersion ?? "无 active 模型"}</dd></div>
            <div><dt>生成时间</dt><dd>{date(data.generatedAt, true)}</dd></div>
            <div><dt>特征 schema</dt><dd>{ml.featureSchemaVersion ?? "--"}</dd></div>
            <div><dt>推理状态</dt><dd><i className="status-dot" />{mlStatusLabel}</dd></div>
            <div><dt>训练样本</dt><dd>{ml.trainedExampleCount}</dd></div>
            <div><dt>Holdout 评估</dt><dd>{ml.evaluatedOutcomeCount}</dd></div>
            <div><dt>MAE 改善</dt><dd>{ml.meanAbsoluteErrorImprovement === null ? "--" : `${(ml.meanAbsoluteErrorImprovement * 100).toFixed(1)}%`}</dd></div>
          </dl>
        </article>
        <section className="panel disclaimer-panel prediction-disclaimer">
          <div><h2>预测边界 <Warning size={16} weight="fill" /></h2><p>实际成绩可能受天气、赛道、战术执行与临场状态影响。区间与置信度仅供参考，不构成医疗或竞赛决策依据。</p></div>
        </section>
      </section>
      <footer className="prediction-footnote"><WarningCircle size={18} /><div><p>本预测基于当前数据与模型计算，仅供参考，不构成医学、训练或比赛决策的唯一依据。请结合自身状态与专业建议合理使用。</p>{data.guidanceCodes.length ? <ul aria-label="预测提示">{data.guidanceCodes.map((code) => <li key={code}>{guidanceLabels[code]}</li>)}</ul> : null}</div><span className="prediction-test-label">温湿度</span></footer>
      <PerformanceEntriesPanel />
    </div>
  );
}
