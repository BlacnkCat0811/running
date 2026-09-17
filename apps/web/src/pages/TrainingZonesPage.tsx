import "../pixel-layout.css";
import "../analysis-reference.css";
import type {
  DailyZoneProfile,
  TrainingZoneProfileSettings,
  TrainingZonesCurrentResponse,
  TrainingZonesHistoryResponse,
  UpdateTrainingZoneProfileInput
} from "@rai/api-contracts";
import { useEffect, useRef, useState } from "react";

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
    <section className={`panel zone-table-panel ${heart ? "heart-zones" : "pace-zones"}`}>
      <div className="panel-heading">
        <div>
          <h2>{heart ? "心率分区" : "配速分区"}</h2>
          <p>{heart ? `静息 ${Math.round(profile.restingHeartRateBpm)} · 最高 ${Math.round(profile.maximumHeartRateBpm)} bpm` : profile.lactateThresholdPaceSecondsPerKm === null ? "阈配速证据不足" : `乳酸阈配速 ${pace(profile.lactateThresholdPaceSecondsPerKm)}/km`}</p>
        </div>
        <span className={`zone-confidence ${lowConfidence ? "low" : ""}`}>
          {Math.round(confidence * 100)}%
        </span>
      </div>
      <div className="zone-table" role="list">
        {heart ? profile.heartRateBands.map((band, index) => (
          <div key={band.zone} role="listitem" className={`zone-row zone-row-${index + 1}`}>
            <i className={heartZoneClass[band.zone]} aria-hidden="true" />
            <span><small>Z{index + 1}</small><b>{heartRateZone(band.zone)}</b></span>
            <strong>{bpmRange(band.lowerBpm, band.upperBpm)}</strong>
            <small>{band.lowerReserveFraction === null ? "HRR <60%" : band.upperReserveFraction === null ? "HRR ≥90%" : `HRR ${Math.round(band.lowerReserveFraction * 100)}–<${Math.round(band.upperReserveFraction * 100)}%`}</small>
            <span className="zone-reference-axis" aria-hidden="true"><i /></span>
          </div>
        )) : profile.paceBands.map((band, index) => (
          <div key={band.zone} role="listitem" className={`zone-row zone-row-${index + 1}`}>
            <i className={paceZoneClass[band.zone]} aria-hidden="true" />
            <span><small>Z{index + 1}</small><b>{paceZone(band.zone)}</b></span>
            <strong>{paceRange(band.lowerSecondsPerKm, band.upperSecondsPerKm)}</strong>
            <span className="zone-reference-axis" aria-hidden="true"><i /></span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AnchorHistory({ profiles }: { profiles: DailyZoneProfile[] }) {
  const recent = profiles.slice(-5).reverse();
  return (
    <section className="panel zone-history-panel">
      <div className="panel-heading"><div><h2>分区历史</h2><p>每日冻结快照不会随当前估计变化</p></div></div>
      {recent.length ? <div className="zone-history-cards" role="list" aria-label={`分区锚点历史，共 ${profiles.length} 天`}>
        {recent.map((profile) => <article key={profile.id} role="listitem">
          <b>{shortDate(profile.localDate)}</b>
          <small>{zoneSource(profile.heartRateSource)}</small>
          <span>最高心率 <strong>{Math.round(profile.maximumHeartRateBpm)} bpm</strong></span>
          <span>LT 配速 <strong>{profile.lactateThresholdPaceSecondsPerKm === null ? "--" : `${pace(profile.lactateThresholdPaceSecondsPerKm)}/km`}</strong></span>
          <em>置信度 {Math.round(((profile.heartRateConfidence + profile.paceConfidence) / 2) * 100)}%</em>
        </article>)}
      </div> : <div className="series-empty">暂无分区历史。</div>}
    </section>
  );
}

function ZoneEvidence({ profiles }: { profiles: DailyZoneProfile[] }) {
  const recent = profiles.slice(-7);
  return (
    <section className="panel zone-evidence-panel">
      <div className="panel-heading"><div><h2>近 7 日证据</h2><p>每日心率与配速分区置信度</p></div><div className="zone-evidence-legend"><span>心率</span><span>配速</span></div></div>
      {recent.length ? <div className="zone-evidence-chart" role="img" aria-label={`近 ${recent.length} 日分区证据`}>
        {recent.map((profile) => <div key={profile.id} className="zone-evidence-day">
          <b>{Math.round(((profile.heartRateConfidence + profile.paceConfidence) / 2) * 100)}</b>
          <span><i style={{ height: `${confidenceHeightPercent(profile.heartRateConfidence)}%` }} /><em style={{ height: `${confidenceHeightPercent(profile.paceConfidence)}%` }} /></span>
          <small>{shortDate(profile.localDate)}</small>
        </div>)}
      </div> : <div className="series-empty">暂无证据。</div>}
    </section>
  );
}

export function confidenceHeightPercent(confidence: number): number {
  return Math.max(0, Math.min(100, confidence * 100));
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
      <header className="page-header split zones-reference-header">
        <div><h1>训练分区</h1><p>{profile.localDate} · Asia/Shanghai · 快照 {profile.id.slice(-8)}</p></div>
        <div className="zones-snapshot-control"><span>▣</span><b>每日冻结快照</b><strong>{profile.localDate}</strong></div>
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
      <p className="zone-source-note">{profile.paceSource === "manual"
        ? "配速分区使用手动阈配速；手动设置本身不代表实测阈值。"
        : profile.paceSource === "fallback"
          ? "配速分区当前使用回退估计，非实测阈值。"
          : "自动阈配速结合 VDOT 代理与可用训练证据，并可能沿用历史锚点；不等同于实测阈值。"}</p>
      <div className="zone-tables"><ZoneTable profile={profile} kind="heart" /><ZoneTable profile={profile} kind="pace" /></div>
      <div className="zone-lower-grid">
        {history.loading ? <section className="panel"><LoadingBlock /></section> : history.error || !history.data ? <section className="panel"><ErrorBlock message={history.error ?? "没有分区历史"} /></section> : <ZoneEvidence profiles={history.data.profiles} />}
        <ZoneSettings current={current.data} onSaved={current.reload} />
        {history.data ? <AnchorHistory profiles={history.data.profiles} /> : null}
      </div>
    </div>
  );
}
