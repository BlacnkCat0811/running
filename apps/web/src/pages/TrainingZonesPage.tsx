import type {
  DailyZoneProfile,
  TrainingZoneProfileSettings,
  TrainingZonesCurrentResponse,
  TrainingZonesHistoryResponse,
  UpdateTrainingZoneProfileInput
} from "@rai/api-contracts";
import { useEffect, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

import { api, ApiError } from "../api.js";
import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import {
  date,
  heartRateZone,
  pace,
  paceZone,
  shortDate,
  zoneSource,
  zoneStatus
} from "../format.js";
import { useRemote } from "../hooks.js";
import { CheckCircle, SlidersHorizontal, WarningCircle } from "../icons.js";

const heartZoneClass: Record<string, string> = {
  recovery: "zone-1",
  aerobic_base: "zone-2",
  aerobic_power: "zone-3",
  lactate_threshold: "zone-4",
  anaerobic: "zone-5"
};
const paceZoneClass: Record<string, string> = {
  easy: "zone-1",
  marathon: "zone-2",
  lactate_threshold: "zone-3",
  anaerobic_endurance: "zone-4",
  sprint: "zone-5"
};

const bpmRange = (lower: number | null, upper: number | null): string => {
  if (lower === null && upper !== null) return `< ${Math.round(upper)} bpm`;
  if (lower !== null && upper === null) return `≥ ${Math.round(lower)} bpm`;
  return `${Math.round(lower ?? 0)}–${Math.round(upper ?? 0)} bpm`;
};

const paceRange = (lower: number | null, upper: number | null): string => {
  if (lower === null && upper === null) return "--–--";
  if (lower === null && upper !== null) return `< ${pace(upper)}/km`;
  if (lower !== null && upper === null) return `≥ ${pace(lower)}/km`;
  return `${pace(lower)}–${pace(upper)}/km`;
};

function ZoneTable({ profile, kind }: { profile: DailyZoneProfile; kind: "heart" | "pace" }) {
  const heart = kind === "heart";
  const confidence = heart ? profile.heartRateConfidence : profile.paceConfidence;
  const lowConfidence = confidence < 0.35 || (heart ? profile.heartRateSource : profile.paceSource) === "fallback";
  return (
    <section className="panel zone-table-panel">
      <div className="panel-heading">
        <div>
          <h2>{heart ? "储备心率五区" : "阈配速五区"}</h2>
          <p>{heart ? `静息 ${Math.round(profile.restingHeartRateBpm)} · 最高 ${Math.round(profile.maximumHeartRateBpm)} bpm` : profile.lactateThresholdPaceSecondsPerKm === null ? "阈配速证据不足" : `乳酸阈配速 ${pace(profile.lactateThresholdPaceSecondsPerKm)}/km`}</p>
        </div>
        <span className={`zone-confidence ${lowConfidence ? "low" : ""}`}>
          {Math.round(confidence * 100)}%
        </span>
      </div>
      <div className="zone-table" role="list">
        {heart ? profile.heartRateBands.map((band, index) => (
          <div key={band.zone} role="listitem">
            <i className={heartZoneClass[band.zone]} aria-hidden="true" />
            <span><small>Z{index + 1}</small><b>{heartRateZone(band.zone)}</b></span>
            <strong>{bpmRange(band.lowerBpm, band.upperBpm)}</strong>
            <small>{band.lowerReserveFraction === null ? "HRR <60%" : band.upperReserveFraction === null ? "HRR ≥90%" : `HRR ${Math.round(band.lowerReserveFraction * 100)}–<${Math.round(band.upperReserveFraction * 100)}%`}</small>
          </div>
        )) : profile.paceBands.map((band, index) => (
          <div key={band.zone} role="listitem">
            <i className={paceZoneClass[band.zone]} aria-hidden="true" />
            <span><small>Z{index + 1}</small><b>{paceZone(band.zone)}</b></span>
            <strong>{paceRange(band.lowerSecondsPerKm, band.upperSecondsPerKm)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function AnchorHistory({ profiles }: { profiles: DailyZoneProfile[] }) {
  const data = profiles.map((profile) => ({
    date: profile.localDate,
    resting: profile.restingHeartRateBpm,
    maximum: profile.maximumHeartRateBpm,
    thresholdPace: profile.lactateThresholdPaceSecondsPerKm
  }));
  return (
    <section className="panel zone-history-panel">
      <div className="panel-heading"><div><h2>90 天锚点变化</h2><p>每个自然日的冻结值，历史训练不会随当前估计变化</p></div></div>
      {data.length ? <div className="zone-history-chart">
        <div className="zone-history-visual" role="img" aria-label={`分区锚点历史，共 ${data.length} 天`}>
          <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 18, right: 14, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="#dfe5df" />
            <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: "#6d786f" }} tickLine={false} axisLine={false} minTickGap={32} />
            <YAxis yAxisId="heart" width={38} domain={["auto", "auto"]} tick={{ fontSize: 9, fill: "#6d786f" }} tickLine={false} axisLine={false} />
            <YAxis yAxisId="pace" orientation="right" width={48} domain={["auto", "auto"]} tickFormatter={(value) => pace(Number(value))} tick={{ fontSize: 9, fill: "#b25b4b" }} tickLine={false} axisLine={false} />
            <Tooltip formatter={(value, name) => [name === "阈配速" ? `${pace(Number(value))}/km` : `${Math.round(Number(value))} bpm`, name]} labelFormatter={(value) => String(value)} />
            <Line yAxisId="heart" dataKey="resting" name="静息心率" stroke="#3c6e9d" strokeWidth={1.7} dot={false} isAnimationActive={false} />
            <Line yAxisId="heart" dataKey="maximum" name="最高心率" stroke="#a96c19" strokeWidth={1.7} dot={false} isAnimationActive={false} />
            <Line yAxisId="pace" dataKey="thresholdPace" name="阈配速" stroke="#b25b4b" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          </LineChart>
          </ResponsiveContainer>
        </div>
        <details className="ability-chart-data zone-history-data">
          <summary>浏览分区锚点历史数据（{data.length}）</summary>
          <div className="ability-chart-data-list zone-history-data-list" role="list" aria-label="分区锚点历史数据">
            {data.map((point) => <div key={point.date} role="listitem">
              <b>{point.date}</b>
              <span>静息心率 {Math.round(point.resting)} bpm</span>
              <span>最高心率 {Math.round(point.maximum)} bpm</span>
              <span>阈配速 {point.thresholdPace === null ? "--" : `${pace(point.thresholdPace)}/km`}</span>
            </div>)}
          </div>
        </details>
      </div> : <div className="series-empty">暂无分区历史。</div>}
    </section>
  );
}

type Modes = { resting: "auto" | "manual"; maximum: "auto" | "manual"; pace: "auto" | "manual" };
type Values = { resting: string; maximum: string; pace: string };
type ValueErrors = Partial<Record<keyof Values, string>>;

function ZoneSettings({ current, onSaved }: { current: TrainingZonesCurrentResponse; onSaved: () => Promise<boolean> }) {
  const modesFromCurrent = (): Modes => ({
    resting: current.settings.restingHeartRate.mode,
    maximum: current.settings.maximumHeartRate.mode,
    pace: current.settings.lactateThresholdPace.mode
  });
  const valuesFromCurrent = (): Values => ({
    resting: String(current.settings.restingHeartRate.valueBpm ?? Math.round(current.profile.restingHeartRateBpm)),
    maximum: String(current.settings.maximumHeartRate.valueBpm ?? Math.round(current.profile.maximumHeartRateBpm)),
    pace: String(Math.round(current.settings.lactateThresholdPace.valueSecondsPerKm ?? current.profile.lactateThresholdPaceSecondsPerKm ?? 336))
  });
  const [modes, setModes] = useState<Modes>(modesFromCurrent);
  const [values, setValues] = useState<Values>(valuesFromCurrent);
  const [editingRevision, setEditingRevision] = useState(current.settings.revision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [valueErrors, setValueErrors] = useState<ValueErrors>({});
  const [saved, setSaved] = useState<TrainingZoneProfileSettings | null>(null);
  useEffect(() => {
    if (dirty || current.settings.revision < editingRevision) return;
    setRefreshError(false);
    setSaved((previous) => previous && current.settings.revision > previous.revision ? null : previous);
    setModes(modesFromCurrent());
    setValues(valuesFromCurrent());
    setEditingRevision(current.settings.revision);
  }, [current, dirty, editingRevision]);
  const updateMode = (key: keyof Modes, mode: "auto" | "manual") => {
    setModes((value) => ({ ...value, [key]: mode }));
    setDirty(true);
  };
  const loadLatest = () => {
    setModes(modesFromCurrent());
    setValues(valuesFromCurrent());
    setEditingRevision(current.settings.revision);
    setDirty(false);
    setError(null);
    setRefreshError(false);
    setValueErrors({});
    setSaved(null);
  };
  const fields = [
    { key: "resting" as const, label: "静息心率", unit: "bpm", min: 35, max: 110 },
    { key: "maximum" as const, label: "最高心率", unit: "bpm", min: 120, max: 230 },
    { key: "pace" as const, label: "乳酸阈配速", unit: "秒/公里", min: 150, max: 900 }
  ];
  const save = async () => {
    if (savingRef.current) return;
    setError(null);
    setRefreshError(false);
    setSaved(null);
    const nextValueErrors: ValueErrors = {};
    const parsed = {} as Record<keyof Values, number>;
    for (const field of fields) {
      const value = values[field.key].trim();
      const numeric = value === "" ? Number.NaN : Number(value);
      parsed[field.key] = numeric;
      if (modes[field.key] === "manual" && (!Number.isFinite(numeric) || numeric < field.min || numeric > field.max)) {
        nextValueErrors[field.key] = `请输入 ${field.min}–${field.max} ${field.unit} 范围内的有效数值`;
      }
    }
    if (
      modes.resting === "manual" &&
      modes.maximum === "manual" &&
      !nextValueErrors.resting &&
      !nextValueErrors.maximum &&
      parsed.maximum - parsed.resting < 30
    ) {
      nextValueErrors.resting = "静息心率必须至少比最高心率低 30 bpm";
      nextValueErrors.maximum = "最高心率必须至少比静息心率高 30 bpm";
    }
    setValueErrors(nextValueErrors);
    if (Object.keys(nextValueErrors).length > 0) return;
    savingRef.current = true;
    setSaving(true);
    const payload: UpdateTrainingZoneProfileInput = {
      expectedRevision: editingRevision,
      restingHeartRate: { mode: modes.resting, valueBpm: modes.resting === "manual" ? parsed.resting : null },
      maximumHeartRate: { mode: modes.maximum, valueBpm: modes.maximum === "manual" ? parsed.maximum : null },
      lactateThresholdPace: { mode: modes.pace, valueSecondsPerKm: modes.pace === "manual" ? parsed.pace : null }
    };
    try {
      const result = await api<TrainingZoneProfileSettings>("/v1/training-zones/profile", {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      setSaved(result);
      setEditingRevision(result.revision);
      setDirty(false);
      setRefreshError(!(await onSaved()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法保存分区设置");
      if (caught instanceof ApiError && caught.status === 409) await onSaved();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <section className="panel zone-settings-panel">
      <div className="panel-heading"><div><h2>自动调整与手动锁定</h2><p>修改从下一个上海自然日生效，不追溯历史训练</p></div><SlidersHorizontal size={20} /></div>
      <div className="zone-setting-fields">
        {fields.map((field) => <div key={field.key} className="zone-setting-row">
          <span><b>{field.label}</b><small>{field.min}–{field.max} {field.unit}</small></span>
          <div className="segmented" role="group" aria-label={`${field.label}模式`}>
            <button type="button" disabled={saving} className={modes[field.key] === "auto" ? "active" : ""} aria-pressed={modes[field.key] === "auto"} onClick={() => updateMode(field.key, "auto")}>自动</button>
            <button type="button" disabled={saving} className={modes[field.key] === "manual" ? "active" : ""} aria-pressed={modes[field.key] === "manual"} onClick={() => updateMode(field.key, "manual")}>手动</button>
          </div>
          <label><span className="sr-only">{field.label}</span><input type="number" min={field.min} max={field.max} step="1" disabled={saving || modes[field.key] === "auto"} value={values[field.key]} aria-invalid={valueErrors[field.key] ? true : undefined} aria-describedby={valueErrors[field.key] ? `${field.key}-zone-error` : undefined} onChange={(event) => {
            setValues((value) => ({ ...value, [field.key]: event.target.value }));
            setDirty(true);
            setValueErrors((currentErrors) => ({ ...currentErrors, [field.key]: undefined }));
          }} /><small>{field.unit}</small></label>
          {valueErrors[field.key] ? <small id={`${field.key}-zone-error`} className="zone-field-error">{valueErrors[field.key]}</small> : null}
        </div>)}
      </div>
      {error ? <p className="form-error zone-setting-message" role="alert">{error}</p> : null}
      {dirty && current.settings.revision > editingRevision ? <p className="zone-setting-refresh-error" role="alert">检测到 revision {current.settings.revision} 的外部更新；当前编辑内容已保留。<button type="button" className="text-button" disabled={saving} onClick={loadLatest}>加载最新设置</button></p> : null}
      {saved ? <p className="zone-setting-success" role="status"><CheckCircle size={16} />revision {saved.revision} 将于 {saved.effectiveFromLocalDate} 生效</p> : null}
      {refreshError ? <p className="zone-setting-refresh-error" role="alert">设置已保存，但最新分区刷新失败。<button type="button" className="text-button" onClick={() => void onSaved().then((ok) => setRefreshError(!ok))}>重新加载</button></p> : null}
      <div className="panel-actions"><button type="button" className="button primary" disabled={saving} onClick={() => void save()}>{saving ? "正在保存" : "保存设置"}</button></div>
    </section>
  );
}

export function TrainingZonesPage() {
  const current = useRemote<TrainingZonesCurrentResponse>("/v1/training-zones/current", true, true);
  const history = useRemote<TrainingZonesHistoryResponse>("/v1/training-zones/history?days=90");
  if (current.loading) return <div className="page"><LoadingBlock label="正在读取今日分区" /></div>;
  if (!current.data) return <div className="page"><ErrorBlock message={current.error ?? "今日分区尚未生成"} onRetry={() => void current.reload()} /></div>;
  const profile = current.data.profile;
  const lowHeartRateConfidence = profile.heartRateConfidence < 0.35 || profile.heartRateSource === "fallback";
  const lowPaceConfidence = profile.paceConfidence < 0.35 || profile.paceSource === "fallback";
  const lowConfidence = profile.status !== "stable" || lowHeartRateConfidence || lowPaceConfidence;
  const confidenceNote = lowHeartRateConfidence && lowPaceConfidence
    ? "心率与阈配速证据不足，训练分类会同步降低置信度。"
    : lowHeartRateConfidence
      ? "心率证据不足，依赖心率分区的训练分类会同步降低置信度。"
      : "阈值证据不足时会保留上次锚点并衰减置信度；训练分类会同步降低置信度。";
  return (
    <div className="page zones-page">
      <header className="page-header split">
        <div><h1>训练分区</h1><p>{profile.localDate} · Asia/Shanghai · 快照 {profile.id.slice(-8)}</p></div>
        <span className={`zone-status ${lowConfidence ? "low" : ""}`}>{lowConfidence ? <WarningCircle size={17} /> : <CheckCircle size={17} />}{lowConfidence ? "低置信试算" : zoneStatus(profile.status)}</span>
      </header>
      {current.error ? <ErrorBlock title="分区刷新失败" message={current.error} onRetry={() => void current.reload()} /> : null}
      <section className="zone-profile-strip">
        <span><small>心率来源</small><b>{zoneSource(profile.heartRateSource)}</b><em>{Math.round(profile.heartRateConfidence * 100)}% 置信度</em></span>
        <span><small>配速来源</small><b>{zoneSource(profile.paceSource)}</b><em>{Math.round(profile.paceConfidence * 100)}% 置信度</em></span>
        <span><small>最近证据</small><b>{profile.dataThroughAt ? date(profile.dataThroughAt) : "暂无"}</b><em>{profile.evidence.thresholdEvidenceCount} 条阈值证据</em></span>
        <span><small>有效样本</small><b>{profile.evidence.restingHeartRateDays} 日 / {profile.evidence.maximumHeartRateWorkouts} 次</b><em>静息心率 / 最高心率</em></span>
      </section>
      {lowConfidence ? <div className="zone-confidence-note"><WarningCircle size={18} /><span><b>当前训练分区为低置信试算</b><small>{confidenceNote}</small></span></div> : null}
      <div className="zone-tables"><ZoneTable profile={profile} kind="heart" /><ZoneTable profile={profile} kind="pace" /></div>
      <div className="zone-lower-grid">
        {history.loading ? <section className="panel"><LoadingBlock /></section> : history.error || !history.data ? <section className="panel"><ErrorBlock message={history.error ?? "没有分区历史"} /></section> : <AnchorHistory profiles={history.data.profiles} />}
        <ZoneSettings current={current.data} onSaved={current.reload} />
      </div>
    </div>
  );
}
