import type {
  DailyZoneProfile,
  DashboardResponse,
  PhysiologyGuidanceCode,
  PredictionResponse,
  TrainingPeriodSummary,
  TrainingStatisticsOverviewResponse,
  TrainingZonesCurrentResponse,
  WorkoutListItem,
} from "@rai/api-contracts";
import { useNavigate } from "react-router-dom";

import { duration, heartRateZone, pace, paceZone } from "../format.js";
import { useRemote } from "../hooks.js";
import {
  bpmRange,
  Card,
  IosLoading,
  paceRange,
  percent,
  trainingStatusLabel,
  zoneColor,
} from "./shared.js";

const guidanceLabels: Record<PhysiologyGuidanceCode, string> = {
  direct_vo2_evidence_missing: "缺少 Apple Health VO₂max 直接记录，上限主要依赖训练表现。",
  standard_test_missing: "还没有确认的测试跑或比赛，成绩预测保持低置信。",
  threshold_segments_missing: "缺少稳定的阈值片段，乳酸阈值仍以先验为主。",
  prediction_confidence_low: "证据有限，请把区间而不是单点作为主要参考。",
};

function aerobicPaceNote(
  latest: WorkoutListItem | null | undefined,
  rolling: TrainingPeriodSummary | null | undefined,
): string {
  const latestPace = latest?.averagePaceSecondsPerKm;
  const rollingPace = rolling?.averagePaceSecondsPerKm;
  if (latestPace == null) return "等待有效训练";
  if (rollingPace == null) return "最近一次有效训练";
  const delta = latestPace - rollingPace;
  const seconds = Math.abs(Math.round(delta));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `${delta <= 0 ? "快" : "慢"} ${clock}，较 28 天均值`;
}

export function IosBodyStatusCard() {
  const navigate = useNavigate();
  const predictions = useRemote<PredictionResponse>("/v1/predictions");
  const dashboard = useRemote<DashboardResponse>("/v1/dashboard");
  const snapshot = predictions.data?.snapshot;
  const latest = dashboard.data?.latestWorkout;
  const recovery = predictions.data?.inputs.recoveryReadiness;
  return (
    <Card title="身体状态" action="查看指标" onAction={() => navigate("/body")}>
      {predictions.error && !predictions.data ? (
        <IosLoading compact error={predictions.error} onRetry={() => void predictions.reload()} />
      ) : (
        <div className="ios-phy-grid">
          <PhyTile label="恢复准备度" value={recovery == null ? "--" : percent(recovery)} />
          <PhyTile
            label="VO₂max"
            value={snapshot?.vo2Max.valueMlKgMin == null ? "--" : snapshot.vo2Max.valueMlKgMin.toFixed(1)}
            unit="ml/kg/min"
          />
          <PhyTile
            label="最近训练平均配速"
            value={pace(latest?.averagePaceSecondsPerKm ?? null)}
            unit="/km"
            wide
          />
          <PhyTile
            label="乳酸阈配速"
            value={pace(snapshot?.lactateThreshold.paceSecondsPerKm ?? null)}
            unit="/km"
          />
          <PhyTile
            label="阈值心率"
            value={
              snapshot?.lactateThreshold.heartRateBpm == null
                ? "--"
                : String(Math.round(snapshot.lactateThreshold.heartRateBpm))
            }
            unit="bpm"
          />
        </div>
      )}
    </Card>
  );
}

export function IosPhysiologyPage() {
  const predictions = useRemote<PredictionResponse>("/v1/predictions");
  const dashboard = useRemote<DashboardResponse>("/v1/dashboard");
  const zones = useRemote<TrainingZonesCurrentResponse>("/v1/training-zones/current");
  const load = useRemote<TrainingStatisticsOverviewResponse>("/v1/training-statistics/overview");
  if (!predictions.data && (predictions.loading || predictions.error)) {
    return <IosLoading error={predictions.error} onRetry={() => void predictions.reload()} />;
  }
  if (!predictions.data) {
    return <IosLoading error="没有可用的生理预测" onRetry={() => void predictions.reload()} />;
  }
  const report = predictions.data;
  const snapshot = report.snapshot;
  const vo2 = snapshot.vo2Max;
  const threshold = snapshot.lactateThreshold;
  const profile = zones.data?.profile ?? null;
  const easy = profile?.paceBands.find((band) => band.zone === "easy");
  const status = load.data?.status ?? null;
  const recovery = report.inputs.recoveryReadiness;
  const latest = dashboard.data?.latestWorkout;
  const rolling = load.data?.rolling28Days ?? null;

  return (
    <>
      <section className="ios-detail-hero">
        <span>恢复准备度</span>
        <strong>
          {recovery == null ? "--" : percent(recovery)}
        </strong>
        <p>
          {status
            ? `${trainingStatusLabel[status.trainingStatus]}${
                status.recoveryEvidence == null ? "" : ` · 恢复证据 ${percent(status.recoveryEvidence)}`
              }`
            : "基于睡眠、HRV 与近期负荷"}
        </p>
      </section>
      <div className="ios-stat-grid">
        <div className="ios-stat">
          <small>VO₂max</small>
          <b>{vo2.valueMlKgMin == null ? "--" : `${vo2.valueMlKgMin.toFixed(1)}`}</b>
          <em>{vo2.status === "available" ? `置信 ${percent(vo2.confidence)}` : "证据不足"}</em>
        </div>
        <div className="ios-stat">
          <small>有效 VDOT</small>
          <b>{snapshot.performanceVdot.value == null ? "--" : snapshot.performanceVdot.value.toFixed(1)}</b>
          <em>{snapshot.performanceVdot.status === "available" ? "表现能力" : "证据不足"}</em>
        </div>
        <div className="ios-stat">
          <small>乳酸阈配速</small>
          <b>{pace(threshold.paceSecondsPerKm)}</b>
          <em>/km · 当前预测快照</em>
        </div>
        <div className="ios-stat">
          <small>阈值心率</small>
          <b>{threshold.heartRateBpm == null ? "--" : Math.round(threshold.heartRateBpm)}</b>
          <em>bpm</em>
        </div>
      </div>
      <Card title="最近训练平均配速">
        <p className="ios-phy-copy">
          最近一次有效训练的平均配速，对比近 28 天均值。它不是固定的有氧能力或轻松跑处方。
        </p>
        <div className="ios-fact-list">
          <div className="ios-fact">
            <small>最近训练</small>
            <b>{pace(latest?.averagePaceSecondsPerKm ?? null)}/km</b>
          </div>
          <div className="ios-fact">
            <small>28 天均值</small>
            <b>{pace(rolling?.averagePaceSecondsPerKm ?? null)}/km</b>
          </div>
        </div>
        <p className="ios-phy-copy">{aerobicPaceNote(latest, rolling)}</p>
        {dashboard.error && !dashboard.data ? (
          <IosLoading compact error={dashboard.error} onRetry={() => void dashboard.reload()} />
        ) : null}
      </Card>
      <Card title="轻松跑区（分区处方）">
        <p className="ios-phy-copy">
          来自训练分区快照，给日常轻松跑当区间参考，和上面的训练平均配速不是同一个数。
        </p>
        <div className="ios-fact-list">
          <div className="ios-fact">
            <small>轻松配速</small>
            <b>{easy ? displayPaceRange(easy.lowerSecondsPerKm, easy.upperSecondsPerKm) : "暂不可用"}</b>
          </div>
          <div className="ios-fact">
            <small>分区 LT 锚点</small>
            <b>
              {profile?.lactateThresholdPaceSecondsPerKm == null
                ? "--"
                : `${pace(profile.lactateThresholdPaceSecondsPerKm)}/km`}
            </b>
          </div>
        </div>
        {zones.error && !zones.data ? (
          <IosLoading compact error={zones.error} onRetry={() => void zones.reload()} />
        ) : null}
      </Card>
      {profile ? <ZoneCard profile={profile} /> : null}
      <Card title="成绩预测（区间）">
        <p className="ios-phy-copy">
          只把区间当参考，不承诺比赛成绩。证据不足时保持低置信。
        </p>
        {snapshot.races.map((prediction) => {
          const label = prediction.distance === "five_k" ? "5 公里" : prediction.distance === "ten_k" ? "10 公里" : "半马";
          return (
            <div className="ios-fact-list" key={prediction.distance}>
              <div className="ios-fact">
                <small>{label}</small>
                <b>
                  {prediction.predictedSeconds == null ? "--" : duration(prediction.predictedSeconds)}
                </b>
              </div>
              <div className="ios-fact">
                <small>乐观 / 保守</small>
                <b>
                  {prediction.optimisticSeconds == null
                    ? "暂不可用"
                    : prediction.pessimisticSeconds == null
                      ? `${duration(prediction.optimisticSeconds)} 或更慢`
                      : `${duration(prediction.optimisticSeconds)}–${duration(prediction.pessimisticSeconds)}`}
                </b>
              </div>
            </div>
          );
        })}
      </Card>
      {report.guidanceCodes.length ? (
        <Card title="说明">
          <ul className="ios-phy-notes">
            {report.guidanceCodes.map((code) => (
              <li key={code}>{guidanceLabels[code] ?? code}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function displayPaceRange(lower: number | null, upper: number | null): string {
  if (lower == null && upper == null) return "暂不可用";
  if (lower != null && upper == null) return `${pace(lower)}/km 或更慢`;
  if (lower == null && upper != null) return `不快于 ${pace(upper)}/km`;
  return `${pace(lower!)}/km–${pace(upper!)}/km`;
}

function ZoneCard({ profile }: { profile: DailyZoneProfile }) {
  return (
    <>
      <Card title="心率分区">
        <small className="ios-phy-copy">
          静息 {Math.round(profile.restingHeartRateBpm)} · 最高 {Math.round(profile.maximumHeartRateBpm)} bpm
        </small>
        <div className="ios-zone-list">
          {profile.heartRateBands.map((band) => (
            <div key={band.zone}>
              <span>{heartRateZone(band.zone)}</span>
              <i>
                <b style={{ width: "100%", background: zoneColor(band.zone) }} />
              </i>
              <strong>{bpmRange(band.lowerBpm, band.upperBpm)}</strong>
            </div>
          ))}
        </div>
      </Card>
      <Card title="配速分区">
        <div className="ios-zone-list">
          {profile.paceBands.map((band) => (
            <div key={band.zone} className={band.zone === "easy" ? "ios-zone-emphasis" : undefined}>
              <span>{paceZone(band.zone)}</span>
              <i>
                <b style={{ width: "100%", background: zoneColor(band.zone === "easy" ? "aerobic_base" : band.zone) }} />
              </i>
              <strong>{paceRange(band.lowerSecondsPerKm, band.upperSecondsPerKm)}</strong>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function PhyTile({
  label,
  value,
  unit,
  wide = false,
}: {
  label: string;
  value: string;
  unit?: string;
  wide?: boolean;
}) {
  return (
    <div className={`ios-phy-tile${wide ? " wide" : ""}`}>
      <small>{label}</small>
      <b>
        {value}
        {unit && value !== "--" ? <em>{unit}</em> : null}
      </b>
    </div>
  );
}
