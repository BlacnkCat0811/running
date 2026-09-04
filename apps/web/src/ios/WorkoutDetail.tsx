import type {
  OverrideWorkoutInput,
  WorkoutDetailResponse,
  WorkoutSeriesResponse,
} from "@rai/api-contracts";
import { useState } from "react";
import { useParams } from "react-router-dom";

import { RoutePlot } from "../components/RoutePlot.js";
import { api } from "../api.js";
import { notifyDataUpdated } from "../events.js";
import {
  date,
  duration,
  environment,
  explanation,
  heartRateZone,
  missingReason,
  pace,
  sessionType,
  status,
  stimulusType,
} from "../format.js";
import { useRemote } from "../hooks.js";
import { MapTrifold } from "../icons.js";
import {
  Card,
  dimensionLabels,
  Fact,
  IosLoading,
  Sparkline,
  Stat,
  zoneColor,
} from "./shared.js";

export function IosWorkoutDetail() {
  const { id } = useParams();
  const detailPath = `/v1/workouts/${id ?? ""}`;
  const seriesPath = `/v1/workouts/${id ?? ""}/series`;
  const detail = useRemote<WorkoutDetailResponse>(detailPath, Boolean(id), false);
  const series = useRemote<WorkoutSeriesResponse>(seriesPath, Boolean(id));

  if (!id) return <IosLoading error="训练不存在" />;
  if (detail.loading && (!detail.data || detail.dataPath !== detailPath)) {
    return <IosLoading error={null} />;
  }
  if (!detail.data || detail.dataPath !== detailPath) {
    return (
      <IosLoading
        error={detail.error ?? "训练不存在"}
        onRetry={() => void detail.reload()}
      />
    );
  }

  const workout = detail.data.workout;
  const zones = detail.data.zoneSummary;
  const load = detail.data.trainingLoad;
  const splits =
    series.data && series.dataPath === seriesPath ? series.data.splits : [];
  const dimensions = detail.data.dimensions;
  const heartRateValues = seriesPoints(series.data?.series.heartRate.points);
  const paceValues = speedToPace(series.data?.series.speed.points);
  const honesty = honestyLine(
    workout.assessmentStatus,
    workout.missingReasons,
    workout.averageHeartRateBpm,
    workout.indoor,
    workout.updatedTrueAbility,
  );
  const seriesError = !series.data ? series.error : null;
  const easyFraction = easyHeartFraction(zones?.heartRateExposure);

  return (
    <>
      <section className="ios-detail-hero">
        <span>
          {sessionType(workout.sessionType || "unknown")} ·{" "}
          {environment(workout.indoor)}
          {workout.stimulusType ? ` · ${stimulusType(workout.stimulusType)}` : ""}
        </span>
        <strong>
          {workout.distanceKm == null ? "--" : workout.distanceKm.toFixed(1)}{" "}
          <small>km</small>
        </strong>
        <p>{date(workout.startedAt, true)}</p>
        {honesty ? <small className="ios-honesty">{honesty}</small> : null}
        {workout.indoor ? (
          <small className="ios-honesty">室内跑计入负荷，不更新真实能力。</small>
        ) : null}
      </section>
      <div className="ios-stat-grid">
        <Stat label="用时" value={duration(workout.durationSeconds)} />
        <Stat
          label="平均配速"
          value={
            workout.averagePaceSecondsPerKm
              ? pace(workout.averagePaceSecondsPerKm)
              : "--"
          }
        />
        <Stat
          label="平均心率"
          value={
            workout.averageHeartRateBpm == null
              ? "--"
              : `${Math.round(workout.averageHeartRateBpm)}`
          }
        />
        <Stat
          label="卡路里"
          value={
            workout.activeEnergyKcal == null
              ? "--"
              : `${Math.round(workout.activeEnergyKcal)}`
          }
        />
      </div>
      <Card title="训练数据">
        <div className="ios-fact-list">
          <Fact
            label="爬升"
            value={
              workout.elevationGainMeters == null
                ? "--"
                : `${Math.round(workout.elevationGainMeters)} m`
            }
          />
          <Fact
            label="步频"
            value={
              workout.averageCadenceSpm == null
                ? "--"
                : `${Math.round(workout.averageCadenceSpm)} spm`
            }
          />
          <Fact
            label="即时能力"
            value={
              workout.currentAbility == null
                ? "--"
                : workout.currentAbility.toFixed(1)
            }
          />
          <Fact
            label="训练负荷"
            value={load ? String(Math.round(load.breakdown.compositeLoad)) : "--"}
          />
        </div>
      </Card>
      {seriesError ? (
        <Card title="心率与配速">
          <IosLoading
            compact
            error={seriesError}
            onRetry={() => void series.reload()}
          />
        </Card>
      ) : heartRateValues || paceValues ? (
        <Card title="心率与配速">
          {heartRateValues ? (
            <Sparkline values={heartRateValues} label="心率" color="#ed6549" />
          ) : null}
          {paceValues ? (
            <Sparkline values={paceValues} label="配速" color="#247446" />
          ) : null}
        </Card>
      ) : null}
      {workout.hasRoute || detail.data.route.length ? (
        <Card title="路线">
          <div className="ios-route">
            {detail.data.route.length ? (
              <RoutePlot points={detail.data.route} />
            ) : (
              <div className="ios-empty-state">
                <MapTrifold size={23} />
                <span>没有可用路线</span>
              </div>
            )}
          </div>
        </Card>
      ) : null}
      {seriesError ? (
        <Card title="公里分段">
          <IosLoading
            compact
            error={seriesError}
            onRetry={() => void series.reload()}
          />
        </Card>
      ) : splits.length ? (
        <Card title="公里分段">
          <div className="ios-split-row ios-split-head">
            <span>分段</span>
            <span>用时</span>
            <span>配速</span>
            <span>心率</span>
          </div>
          {splits.map((split) => (
            <div className="ios-split-row" key={split.index}>
              <b>{split.distanceMeters < 999.5 ? "尾段" : `${split.index} km`}</b>
              <span>{duration(split.durationSeconds)}</span>
              <span>{pace(split.averagePaceSecondsPerKm)}</span>
              <span>
                {split.averageHeartRateBpm == null
                  ? "--"
                  : Math.round(split.averageHeartRateBpm)}
              </span>
            </div>
          ))}
        </Card>
      ) : null}
      {zones ? (
        <Card title="心率区间">
          <div className="ios-zone-list">
            {zones.heartRateExposure.map((zone) => (
              <div key={zone.zone}>
                <span>{heartRateZone(zone.zone)}</span>
                <i>
                  <b
                    style={{
                      width: `${zone.fraction * 100}%`,
                      background: zoneColor(zone.zone),
                    }}
                  />
                </i>
                <strong>{Math.round(zone.fraction * 100)}%</strong>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      <Card title="为什么是这个分">
        <div className="ios-fact-list">
          <Fact label="是否更新 TA" value={workout.updatedTrueAbility ? "是" : "否"} />
          <Fact
            label="心率覆盖"
            value={
              workout.heartRateCoverage == null
                ? "--"
                : `${Math.round(workout.heartRateCoverage * 100)}%`
            }
          />
          <Fact
            label="贡献"
            value={
              workout.workoutContribution == null
                ? "--"
                : workout.workoutContribution.toFixed(2)
            }
          />
          <Fact
            label="在区时间"
            value={easyFraction == null ? "--" : `${Math.round(easyFraction * 100)}% 轻松`}
          />
        </div>
        {workout.explanationCodes.length ? (
          <ul className="ios-phy-notes">
            {workout.explanationCodes.map((code) => (
              <li key={code}>{explanation(code)}</li>
            ))}
          </ul>
        ) : null}
        {workout.missingReasons.length ? (
          <ul className="ios-phy-notes">
            {workout.missingReasons.map((reason) => (
              <li key={reason}>{missingReason(reason)}</li>
            ))}
          </ul>
        ) : null}
      </Card>
      <IosOverrideForm detail={detail.data} onSaved={() => void detail.reload()} />
      <Card title="能力变化">
        <div className="ios-fact-list">
          <Fact
            label="TA 前"
            value={
              workout.trueAbilityBefore == null
                ? "--"
                : workout.trueAbilityBefore.toFixed(1)
            }
          />
          <Fact
            label="TA 后"
            value={
              workout.trueAbilityAfter == null
                ? "--"
                : workout.trueAbilityAfter.toFixed(1)
            }
          />
          <Fact
            label="变化"
            value={
              workout.trueAbilityDelta == null
                ? "--"
                : `${workout.trueAbilityDelta >= 0 ? "+" : ""}${workout.trueAbilityDelta.toFixed(2)}`
            }
          />
        </div>
        <div className="ios-dim-list">
          {(Object.keys(dimensionLabels) as Array<keyof typeof dimensionLabels>).map(
            (key) => {
              const value = dimensions[key];
              return (
                <div className="ios-dim-row" key={key}>
                  <span>{dimensionLabels[key]}</span>
                  <i>
                    <b
                      style={{
                        width: `${Math.max(0, Math.min(100, value ?? 0))}%`,
                      }}
                    />
                  </i>
                  <strong>{value == null ? "--" : value.toFixed(0)}</strong>
                </div>
              );
            },
          )}
        </div>
      </Card>
    </>
  );
}

function seriesPoints(
  points: Array<{ value: number }> | undefined,
): number[] | null {
  if (!points || points.length < 2) return null;
  return points.map((point) => point.value);
}

function speedToPace(
  points: Array<{ value: number }> | undefined,
): number[] | null {
  if (!points || points.length < 2) return null;
  const paceValues = points
    .map((point) => (point.value > 0.2 ? 1000 / point.value : null))
    .filter((value): value is number => value != null);
  return paceValues.length >= 2 ? paceValues : null;
}

function honestyLine(
  assessmentStatus: string | null,
  missingReasons: string[],
  averageHeartRateBpm: number | null,
  indoor: boolean | null,
  updatedTrueAbility: boolean,
): string | null {
  const parts: string[] = [];
  if (assessmentStatus) parts.push(status(assessmentStatus));
  if (indoor) parts.push("室内试算");
  if (!updatedTrueAbility) parts.push("未更新真实能力");
  const hrReason =
    missingReasons.find((reason) => reason.startsWith("heart_rate")) ??
    (averageHeartRateBpm == null ? "heart_rate_missing" : null);
  if (hrReason) parts.push(missingReason(hrReason));
  return parts.length ? parts.join(" · ") : null;
}

function easyHeartFraction(
  exposure: Array<{ zone: string; fraction: number }> | undefined,
): number | null {
  if (!exposure?.length) return null;
  return exposure
    .filter((item) => item.zone === "recovery" || item.zone === "aerobic_base")
    .reduce((sum, item) => sum + item.fraction, 0);
}

const sessionTypes = ["easy", "steady", "tempo", "interval", "long_run", "race", "recovery"] as const;
const protocols = [
  ["five_k_time_trial", "5 km 计时"],
  ["ten_k_time_trial", "10 km 计时"],
  ["thirty_min_threshold", "30 分钟阈值"],
  ["half_marathon_race", "半马比赛"],
  ["other_race", "其他比赛"],
] as const;

function IosOverrideForm({
  detail,
  onSaved,
}: {
  detail: WorkoutDetailResponse;
  onSaved: () => void;
}) {
  const previous = detail.override;
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(previous?.sessionType ?? "");
  const [protocol, setProtocol] = useState(previous?.performanceProtocol ?? "");
  const [eligibility, setEligibility] = useState(previous?.eligibilityOverride ?? "");
  const [rpe, setRpe] = useState(previous?.rpe?.toString() ?? "");
  const [note, setNote] = useState(previous?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit() {
    const parsedRpe = rpe.trim() === "" ? null : Number(rpe);
    if (parsedRpe !== null && (!Number.isInteger(parsedRpe) || parsedRpe < 1 || parsedRpe > 10)) {
      setError("RPE 必须是 1–10 的整数");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: OverrideWorkoutInput = {
        eligibilityOverride: eligibility === "include" || eligibility === "exclude" ? eligibility : null,
        statisticsParticipation: previous?.statisticsParticipation ?? null,
        sessionType: (session || null) as OverrideWorkoutInput["sessionType"],
        performanceProtocol: (protocol || null) as OverrideWorkoutInput["performanceProtocol"],
        rpe: parsedRpe,
        conditionTags: previous?.conditionTags ?? [],
        note: note.trim() || null,
      };
      await api(`/v1/workouts/${detail.workout.id}/override`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setSaved(true);
      notifyDataUpdated();
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="课型 / RPE / 排除">
      {!open ? (
        <button type="button" className="ios-save" onClick={() => setOpen(true)}>
          {previous ? "修改覆盖" : "确认课型或排除"}
        </button>
      ) : (
        <>
          <label className="ios-input-label" htmlFor="ios-session-type">课型</label>
          <select
            id="ios-session-type"
            className="ios-input"
            value={session}
            onChange={(event) => setSession(event.target.value)}
          >
            <option value="">不覆盖</option>
            {sessionTypes.map((item) => (
              <option key={item} value={item}>{sessionType(item)}</option>
            ))}
          </select>
          <label className="ios-input-label" htmlFor="ios-protocol">标准测试</label>
          <select
            id="ios-protocol"
            className="ios-input"
            value={protocol}
            onChange={(event) => setProtocol(event.target.value)}
          >
            <option value="">不是测试</option>
            {protocols.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <label className="ios-input-label" htmlFor="ios-eligibility">是否进入模型</label>
          <select
            id="ios-eligibility"
            className="ios-input"
            value={eligibility}
            onChange={(event) => setEligibility(event.target.value)}
          >
            <option value="">遵循模型</option>
            <option value="include">强制包含</option>
            <option value="exclude">排除</option>
          </select>
          <label className="ios-input-label" htmlFor="ios-rpe">RPE（1–10）</label>
          <input
            id="ios-rpe"
            className="ios-input"
            value={rpe}
            inputMode="numeric"
            onChange={(event) => setRpe(event.target.value)}
          />
          <label className="ios-input-label" htmlFor="ios-note">备注</label>
          <input
            id="ios-note"
            className="ios-input"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          {error ? <p className="ios-sync-error">{error}</p> : null}
          <button type="button" className="ios-save" disabled={saving} onClick={() => void submit()}>
            {saved ? "已保存并重算" : "保存覆盖"}
          </button>
        </>
      )}
    </Card>
  );
}
