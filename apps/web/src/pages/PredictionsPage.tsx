import { useMemo, useState, type FormEvent } from "react";
import type {
  PhysiologyGuidanceCode,
  PredictionResponse,
  RaceDistance,
  RaceTimePrediction
} from "@rai/api-contracts";

import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { date, duration, number, pace } from "../format.js";
import { CheckCircle, ShieldCheck, Warning, WarningCircle } from "../icons.js";
import { useRemote } from "../hooks.js";

interface ScenarioDraft {
  temperatureC: string;
  humidityPercent: string;
  elevationGain5k: string;
  elevationGain10k: string;
  elevationGainHalfMarathon: string;
}

type MachineLearningFallbackReason = RaceTimePrediction["machineLearningFallbackReason"];

const emptyScenario: ScenarioDraft = {
  temperatureC: "",
  humidityPercent: "",
  elevationGain5k: "",
  elevationGain10k: "",
  elevationGainHalfMarathon: ""
};

const distanceLabels: Record<RaceDistance, string> = {
  five_k: "5K",
  ten_k: "10K",
  half_marathon: "半程马拉松"
};

const evidenceLabels: Record<string, string> = {
  apple_health_vo2max: "Apple Health VO₂max",
  race_performance: "比赛表现",
  standard_test_performance: "标准测试跑",
  time_trial_performance: "计时测试",
  hard_workout_performance: "高强度训练参考",
  future_evidence_excluded: "已排除未来数据",
  stale_evidence: "部分证据较旧",
  evidence_disagreement: "证据之间存在差异",
  single_source_only: "当前只有单一证据来源",
  vo2_upper_prior: "VO₂max 作为生理上限参考",
  training_performance_envelope: "训练表现包络",
  performance_evidence_missing: "缺少标准表现证据",
  performance_vo2_gap: "生理能力与比赛表现存在差距",
  performance_environment_normalized: "已归一化训练环境",
  lactate_threshold_one_hour_proxy: "一小时可持续速度先验",
  lactate_threshold_hr_reserve_proxy: "心率储备阈值先验",
  sustained_threshold_segment: "稳定高强度片段",
  threshold_test_segment: "阈值测试片段",
  race_threshold_segment: "比赛阈值片段",
  threshold_evidence_disagreement: "阈值证据存在差异",
  threshold_segments_missing: "缺少可靠阈值片段",
  heart_rate_inputs_missing: "缺少静息或最高心率",
  race_prediction_vdot_baseline: "Daniels VDOT 基线",
  endurance_readiness_unmodeled: "专项准备度不足",
  race_readiness_applied: "已应用专项准备度",
  race_readiness_low: "专项准备度偏低",
  heat_humidity_adjustment: "已应用温湿度修正",
  elevation_adjustment: "已应用爬升修正",
  fatigue_adjustment: "已应用疲劳修正",
  standard_conditions: "标准环境条件",
  walk_forward_bias_calibration: "已应用 walk-forward 偏差校准",
  ridge_residual_model: "已应用验证通过的 Ridge 残差模型",
  catboost_residual_model: "已应用验证通过的 CatBoost 残差模型"
};

const fallbackReasonLabels: Record<Exclude<MachineLearningFallbackReason, null>, string> = {
  no_active_model: "尚无已激活的 CatBoost 模型",
  unsupported_distance: "当前模型不支持这个距离",
  inference_failed: "本次 ONNX 推理失败，已安全回退",
  feature_schema_mismatch: "特征契约不匹配，已安全回退"
};

const guidanceLabels: Record<PhysiologyGuidanceCode, string> = {
  direct_vo2_evidence_missing: "缺少 Apple Health VO₂max 直接记录，生理上限估计主要依赖训练表现。",
  standard_test_missing: "还没有用户确认的标准测试跑或比赛结果，成绩预测保持低置信。",
  threshold_segments_missing: "没有满足稳定性与强度条件的阈值片段，乳酸阈值仍以先验为主。",
  prediction_confidence_low: "当前预测证据有限，请把区间而不是单一点值作为主要参考。"
};

const confidenceLabel = (value: string): string =>
  value === "high" ? "高置信" : value === "moderate" ? "中等置信" : "低置信";

const confidenceClass = (value: string): string =>
  value === "high" ? "positive" : value === "moderate" ? "attention" : "danger";

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

const adjustment = (seconds: number | null): string => {
  if (seconds === null) return "--";
  if (Math.abs(seconds) < 0.5) return "0:00";
  return `${seconds > 0 ? "+" : "−"}${duration(Math.abs(seconds))}`;
};

function EvidenceTags({ codes }: { codes: string[] }) {
  return (
    <div className="prediction-evidence-tags">
      {codes.map((code) => <span key={code}>{evidenceLabels[code] ?? code}</span>)}
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
  const adjustments = [
    ["专项准备度", prediction.readinessAdjustmentSeconds],
    ["温湿度", prediction.environmentAdjustmentSeconds],
    ["累计爬升", prediction.elevationAdjustmentSeconds],
    ["恢复与疲劳", prediction.fatigueAdjustmentSeconds],
    ["历史偏差校准", prediction.calibrationAdjustmentSeconds],
    ["机器学习残差", prediction.machineLearningAdjustmentSeconds]
  ] as const;
  return (
    <article className="panel race-prediction-card">
      <header>
        <div><span>目标距离</span><h2>{label}</h2></div>
        <span className={`status-badge ${confidenceClass(prediction.confidenceLevel)}`}>
          {confidenceLabel(prediction.confidenceLevel)}
        </span>
      </header>
      <div className="race-time-pair">
        <span><small>标准条件潜力</small><strong>{duration(prediction.potentialSeconds ?? 0)}</strong></span>
        <span><small>当前场景预测</small><strong>{duration(prediction.predictedSeconds)}</strong></span>
      </div>
      <div className="prediction-range">
        <small>合理区间</small>
        <b>{prediction.optimisticSeconds === null ? "--" : duration(prediction.optimisticSeconds)} — {prediction.pessimisticSeconds === null ? "--" : duration(prediction.pessimisticSeconds)}</b>
      </div>
      <div className="readiness-meter">
        <span><small>专项准备度</small><b>{prediction.readiness === null ? "--" : `${Math.round(prediction.readiness * 100)}%`}</b></span>
        <i role="progressbar" aria-label={`${label} 专项准备度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((prediction.readiness ?? 0) * 100)}><em style={{ width: `${Math.round((prediction.readiness ?? 0) * 100)}%` }} /></i>
      </div>
      <dl className="prediction-adjustments">
        {adjustments.map(([name, value]) => <div key={name}><dt>{name}</dt><dd className={(value ?? 0) > 0 ? "slower" : ""}>{adjustment(value)}</dd></div>)}
      </dl>
      <footer>
        <span>{predictionMethod(prediction.method)} · 置信度 {Math.round(prediction.confidence * 100)}%</span>
        {prediction.machineLearningFallbackReason ? <span className="prediction-fallback-note" role="note">公式回退：{fallbackReasonLabels[prediction.machineLearningFallbackReason]}</span> : null}
        <EvidenceTags codes={prediction.evidenceCodes} />
      </footer>
    </article>
  );
}

export function PredictionsPage() {
  const [draft, setDraft] = useState<ScenarioDraft>(emptyScenario);
  const [query, setQuery] = useState("");
  const path = useMemo(() => `/v1/predictions${query}`, [query]);
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
  return (
    <div className="page predictions-page">
      <header className="page-header split">
        <div><h1>生理与成绩预测</h1><p>区分生理上限、当前表现能力和专项比赛准备度。</p></div>
        <div className="model-chip"><span>Prediction model</span><b>{snapshot.modelVersion}</b><small>{date(data.generatedAt, true)}</small></div>
      </header>

      {data.guidanceCodes.length > 0 ? (
        <section className="prediction-guidance" aria-label="预测提示">
          <Warning size={20} />
          <div>{data.guidanceCodes.map((code) => <p key={code}>{guidanceLabels[code]}</p>)}</div>
        </section>
      ) : null}

      <section className="prediction-overview" aria-label="生理能力预测">
        <article>
          <span>VO₂max 生理估计</span>
          <strong>{number(snapshot.vo2Max.valueMlKgMin, 1)}</strong>
          <small>ml/kg/min · {confidenceLabel(snapshot.vo2Max.confidenceLevel)}</small>
          <p>{snapshot.vo2Max.rangeMlKgMin ? `${number(snapshot.vo2Max.rangeMlKgMin.lower, 1)}–${number(snapshot.vo2Max.rangeMlKgMin.upper, 1)}` : "区间不可用"}</p>
        </article>
        <article>
          <span>有效 VDOT</span>
          <strong>{number(snapshot.performanceVdot.value, 1)}</strong>
          <small>实际表现能力 · {confidenceLabel(snapshot.performanceVdot.confidenceLevel)}</small>
          <p>{snapshot.performanceVdot.range ? `${number(snapshot.performanceVdot.range.lower, 1)}–${number(snapshot.performanceVdot.range.upper, 1)}` : "区间不可用"}</p>
        </article>
        <article>
          <span>乳酸阈值配速</span>
          <strong>{pace(snapshot.lactateThreshold.paceSecondsPerKm)}</strong>
          <small>/km · {confidenceLabel(snapshot.lactateThreshold.confidenceLevel)}</small>
          <p>{snapshot.lactateThreshold.paceRangeSecondsPerKm ? `${pace(snapshot.lactateThreshold.paceRangeSecondsPerKm.lower)}–${pace(snapshot.lactateThreshold.paceRangeSecondsPerKm.upper)}` : "区间不可用"}</p>
        </article>
        <article>
          <span>乳酸阈值心率</span>
          <strong>{snapshot.lactateThreshold.heartRateBpm === null ? "--" : Math.round(snapshot.lactateThreshold.heartRateBpm)}</strong>
          <small>bpm · 基于个人心率储备</small>
          <p>{snapshot.lactateThreshold.heartRateRangeBpm ? `${Math.round(snapshot.lactateThreshold.heartRateRangeBpm.lower)}–${Math.round(snapshot.lactateThreshold.heartRateRangeBpm.upper)} bpm` : "缺少心率输入"}</p>
        </article>
      </section>

      <section className="panel scenario-panel">
        <div className="panel-heading"><div><h2>比赛场景</h2><p>调整天气和赛道爬升，仅重新计算预测，不修改历史数据或 CA/TA。</p></div><code>恢复准备度 {Math.round(data.inputs.recoveryReadiness * 100)}%</code></div>
        <form className="scenario-form" onSubmit={submit}>
          <label className="field"><span>温度 °C</span><input aria-label="温度" type="number" min="-40" max="60" step="0.1" value={draft.temperatureC} onChange={(event) => update("temperatureC", event.target.value)} placeholder="标准条件" /></label>
          <label className="field"><span>湿度 %</span><input aria-label="湿度" type="number" min="0" max="100" step="1" value={draft.humidityPercent} onChange={(event) => update("humidityPercent", event.target.value)} placeholder="标准条件" /></label>
          <label className="field"><span>5K 爬升 m</span><input aria-label="5K 爬升" type="number" min="0" max="10000" step="1" value={draft.elevationGain5k} onChange={(event) => update("elevationGain5k", event.target.value)} placeholder="0" /></label>
          <label className="field"><span>10K 爬升 m</span><input aria-label="10K 爬升" type="number" min="0" max="10000" step="1" value={draft.elevationGain10k} onChange={(event) => update("elevationGain10k", event.target.value)} placeholder="0" /></label>
          <label className="field"><span>半马爬升 m</span><input aria-label="半马爬升" type="number" min="0" max="10000" step="1" value={draft.elevationGainHalfMarathon} onChange={(event) => update("elevationGainHalfMarathon", event.target.value)} placeholder="0" /></label>
          <div className="scenario-actions"><button type="button" className="button secondary" onClick={reset}>恢复标准条件</button><button className="button primary" type="submit">应用场景</button></div>
        </form>
      </section>

      <section className="race-prediction-grid">
        {snapshot.races.map((prediction) => <RaceCard key={prediction.distance} prediction={prediction} />)}
      </section>

      <section className="prediction-detail-grid">
        <article className="panel prediction-evidence-panel">
          <div className="panel-heading"><div><h2>证据与准备度</h2><p>所有证据均限制在预测生成时刻之前。</p></div><ShieldCheck size={19} /></div>
          <div className="prediction-input-metrics">
            <span><small>Apple VO₂max</small><b>{data.inputs.directVo2Evidence}</b></span>
            <span><small>表现证据</small><b>{data.inputs.performanceVdotEvidence}</b></span>
            <span><small>阈值片段</small><b>{data.inputs.lactateThresholdSegments}</b></span>
            <span><small>标准结果</small><b>{data.inputs.labeledRaceOutcomes}</b></span>
          </div>
          <div className="readiness-list">
            {(Object.entries(data.inputs.readiness) as Array<[RaceDistance, number]>).map(([distanceKey, value]) => (
              <div key={distanceKey}><span>{distanceLabels[distanceKey]}</span><i><em style={{ width: `${Math.round(value * 100)}%` }} /></i><b>{Math.round(value * 100)}%</b></div>
            ))}
          </div>
        </article>
        <article className={`panel prediction-model-panel ${ml.activeModelRunId ? "active" : "fallback"}`}>
          <div className="panel-heading"><div><h2>CatBoost 预测模型</h2><p>离线 walk-forward 验证通过后直接激活；没有可用模型时明确回退到公式。</p></div>{ml.activeModelRunId ? <CheckCircle size={19} /> : <WarningCircle size={19} />}</div>
          <dl>
            <div><dt>当前预测路径</dt><dd>{ml.activeModelRunId ? "CatBoost 已激活" : "公式基线"}</dd></div>
            <div><dt>模型版本</dt><dd>{ml.activeModelVersion ?? "无 active 模型"}</dd></div>
            <div><dt>Feature version</dt><dd>{ml.featureSchemaVersion ?? "--"}</dd></div>
            <div><dt>Active Run</dt><dd title={ml.activeModelRunId ?? undefined}>{ml.activeModelRunId?.slice(0, 14) ?? "--"}</dd></div>
            <div><dt>训练标签</dt><dd>{ml.trainedExampleCount}</dd></div>
            <div><dt>持出预测</dt><dd>{ml.evaluatedOutcomeCount}</dd></div>
            <div><dt>MAE 改善</dt><dd>{ml.meanAbsoluteErrorImprovement === null ? "--" : `${(ml.meanAbsoluteErrorImprovement * 100).toFixed(1)}%`}</dd></div>
            <div><dt>距离退化检查</dt><dd>{ml.meanAbsoluteErrorImprovement === null ? "--" : ml.regressesAnyDistanceByMoreThan5Percent ? "未通过" : "通过"}</dd></div>
            <div><dt>Artifact</dt><dd title={ml.artifactSha256 ?? undefined}>{ml.artifactSha256?.slice(0, 14) ?? "--"}</dd></div>
            <div><dt>激活时间</dt><dd>{ml.activatedAt ? date(ml.activatedAt, true) : "--"}</dd></div>
          </dl>
          {!ml.activeModelRunId ? <div className="prediction-formula-fallback" role="note"><WarningCircle size={17} /><p><b>当前使用公式预测。</b>{data.inputs.labeledRaceOutcomes < 50 ? `只有 ${data.inputs.labeledRaceOutcomes} 条真实结果，尚未达到 50 条训练门槛。` : "当前没有通过验证并激活的 CatBoost artifact。"}</p></div> : <p className="prediction-model-active-note" role="note"><CheckCircle size={17} /><span><b>当前 active 模型已通过离线验证。</b>若某个距离不受支持或 ONNX 推理失败，该距离会单独显示公式回退原因，不会中断其他预测。</span></p>}
        </article>
      </section>

      <section className="panel disclaimer-panel prediction-disclaimer">
        <WarningCircle size={21} /><div><h2>预测边界</h2><p>{snapshot.disclaimer} 成绩区间还会受到赛道、补给、配速策略、伤病和比赛执行影响，不应被视为成绩承诺。</p></div>
      </section>
    </div>
  );
}
