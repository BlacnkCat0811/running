import "../pixel-layout.css";
import "../dashboard-reference.css";
import type {
  DashboardResponse,
  DailyTrainingMetric,
  TrainingStatisticsOverviewResponse,
  TrainingStatusCode,
  TrendResponse,
} from "@rai/api-contracts";
import { Link } from "react-router-dom";

import { DashboardPerformanceChart } from "../components/DashboardPerformanceChart.js";
import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { WorkoutTable } from "../components/WorkoutTable.js";
import { pace } from "../format.js";
import { useRemote } from "../hooks.js";
import {
  ArrowRight,
  ChartBar,
  Heartbeat,
  Pulse,
  Timer,
} from "../icons.js";

export function DashboardPage() {
  const dashboard = useRemote<DashboardResponse>("/v1/dashboard");
  const trend = useRemote<TrendResponse>("/v1/trends?days=28");
  const statistics = useRemote<TrainingStatisticsOverviewResponse>(
    "/v1/training-statistics/overview",
  );
  if (dashboard.loading) return <LoadingBlock />;
  if (dashboard.error || !dashboard.data)
    return (
      <ErrorBlock
        message={dashboard.error ?? "没有可用数据"}
        onRetry={() => void dashboard.reload()}
      />
    );

  const data = dashboard.data;
  const latest = data.latestWorkout;
  const dimensions = data.dimensions;
  const status = statistics.data?.status ?? null;
  const rolling = statistics.data?.rolling28Days ?? null;
  const paceDelta =
    latest?.averagePaceSecondsPerKm !== null &&
    latest?.averagePaceSecondsPerKm !== undefined &&
    rolling?.averagePaceSecondsPerKm !== null &&
    rolling?.averagePaceSecondsPerKm !== undefined
      ? latest.averagePaceSecondsPerKm - rolling.averagePaceSecondsPerKm
      : null;
  const loadDelta =
    status && status.previous7dLoad > 0
      ? (status.current7dLoad - status.previous7dLoad) / status.previous7dLoad
      : null;

  return (
    <div className="page dashboard-page dashboard-reference-layout">
      <header className="page-header dashboard-reference-header">
        <span className="dashboard-runner-mark" aria-hidden="true" />
        <h1>你的跑步能力</h1>
      </header>

      {data.runningJob ? (
        <div className="job-banner">
          <Pulse size={20} />
          <span>
            <b>模型正在重算</b>
            <small>继续展示当前结果，完成后自动切换。</small>
          </span>
          <StatusBadge value={data.runningJob.status} />
        </div>
      ) : null}

      <section className="dashboard-capability-grid" aria-label="跑步能力概览">
        <CapabilityCard
          tone="pace"
          icon={<Timer size={50} />}
          label="最近训练均配"
          value={pace(latest?.averagePaceSecondsPerKm ?? null)}
          unit="/km"
          delta={
            paceDelta === null
              ? "最近一次有效训练"
              : `${paceDelta <= 0 ? "快" : "慢"} ${formatSeconds(Math.abs(paceDelta))}，较 28 天均值`
          }
        />
        <CapabilityCard
          tone="endurance"
          icon={<Heartbeat size={50} />}
          label="稳定性评分"
          value={score(dimensions?.stability)}
          unit="/100"
          delta="来自最近一次训练的稳定性评分"
        />
        <CapabilityCard
          tone="intensity"
          icon={<ChartBar size={50} />}
          label="近 7 日负荷"
          value={score(status?.current7dLoad)}
          unit=""
          delta={
            loadDelta === null
              ? "最近 7 日综合训练负荷"
              : `${loadDelta >= 0 ? "+" : ""}${Math.round(loadDelta * 100)}%，较前 7 日`
          }
        />
        <CapabilityCard
          tone="recovery"
          icon={<Pulse size={50} />}
          label="训练内恢复维度"
          value={score(dimensions?.recovery)}
          unit="/100"
          delta={
            status?.recoveryEvidence === null ||
            status?.recoveryEvidence === undefined
              ? "最近训练暂无该维度"
              : "来自最近一次训练"
          }
        />
      </section>

      <section className="dashboard-reference-grid">
        <article className="panel dashboard-performance-panel">
          <div className="panel-heading">
            <div>
              <h2>近四周能力与负荷</h2>
              <p>能力评分与训练负荷分别按各自单位显示。</p>
            </div>
            <Link to="/trends" className="text-link">
              完整趋势 <ArrowRight size={15} />
            </Link>
          </div>
          <div className="dashboard-performance-legend">
            <span className="endurance">耐力稳定性</span>
            <span className="intensity">训练负荷（独立轴）</span>
            <span className="pace">配速能力</span>
          </div>
          {trend.data ? (
            <DashboardPerformanceChart trend={trend.data} />
          ) : trend.error ? (
            <ErrorBlock
              message={trend.error}
              onRetry={() => void trend.reload()}
            />
          ) : (
            <LoadingBlock label="正在读取趋势" />
          )}
          <div className="dashboard-model-contract">
            <span>TA 真实跑力</span>
            <span>诊断，不参与当前 CA</span>
          </div>
          <p className="dashboard-performance-note">
            {performanceSummary(trend.data, status)}
          </p>
        </article>

        {statistics.error ? (
          <ErrorBlock
            title="训练统计刷新失败"
            message={statistics.error}
            onRetry={() => void statistics.reload()}
          />
        ) : statistics.loading && !statistics.data ? (
          <article className="panel dashboard-status-panel">
            <LoadingBlock label="正在读取训练状态" />
          </article>
        ) : (
          <TrainingStatusPanel status={status} />
        )}
      </section>

      <section className="panel recent-panel dashboard-recent-panel">
        <div className="panel-heading">
          <div>
            <h2>最近训练</h2>
            <p>最近六次跑步的结构、配速、心率与评分结果。</p>
          </div>
          <Link to="/workouts" className="text-link">
            全部训练 <ArrowRight size={15} />
          </Link>
        </div>
        <WorkoutTable items={data.recentWorkouts} compact />
      </section>
    </div>
  );
}

function CapabilityCard({
  tone,
  icon,
  label,
  value,
  unit,
  delta,
}: {
  tone: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  unit: string;
  delta: string;
}) {
  return (
    <article className={`dashboard-capability-card ${tone}`}>
      <span className="capability-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <span className="capability-label">{label}</span>
        <strong>
          {value}<small>{unit}</small>
        </strong>
        <p>{delta}</p>
      </div>
    </article>
  );
}

function TrainingStatusPanel({ status }: { status: DailyTrainingMetric | null }) {
  const code = status?.trainingStatus ?? "insufficient_data";
  return (
    <article className={`panel dashboard-status-panel ${code}`}>
      <div className="panel-heading">
        <div>
          <h2>训练状态</h2>
          <p>综合短期负荷与长期负荷。</p>
        </div>
      </div>
      <div className="dashboard-status-summary">
        <b>{trainingStatusLabel(code)}</b>
        <span>{trainingStatusDescription(code)}</span>
      </div>
      <div className="dashboard-status-facts">
        <StatusFact label="短期负荷" value={status ? Math.round(status.current7dLoad) : null} note="最近 7 日" />
        <StatusFact label="长期负荷" value={status ? Math.round(status.chronicEwma * 7) : null} note="慢性 EWMA" />
        <StatusFact label="负荷比" value={status?.loadRatio ?? null} note={loadRatioNote(status?.loadRatio ?? null)} decimals={2} />
      </div>
      <Link to="/statistics" className="button primary full">
        查看运动统计 <ArrowRight size={15} />
      </Link>
    </article>
  );
}

function StatusFact({
  label,
  value,
  note,
  decimals = 0,
  suffix = "",
}: {
  label: string;
  value: number | null;
  note: string;
  decimals?: number;
  suffix?: string;
}) {
  return (
    <span>
      <small>{label}</small>
      <b>{value === null ? "--" : `${value.toFixed(decimals)}${suffix}`}</b>
      <em>{note}</em>
    </span>
  );
}

function score(value: number | null | undefined): string {
  return value === null || value === undefined ? "--" : String(Math.round(value));
}

function formatSeconds(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function performanceSummary(
  trend: TrendResponse | null | undefined,
  status: DailyTrainingMetric | null,
): string {
  if (!trend?.workouts.length) return "完成更多有效训练后，这里会显示能力变化。";
  const first = trend.workouts[0]?.dimensions.stability;
  const last = trend.workouts.at(-1)?.dimensions.stability;
  if (first === null || first === undefined || last === null || last === undefined)
    return "训练趋势已更新，部分维度仍在积累数据。";
  const direction = last >= first ? "提升" : "回落";
  const load = status?.loadRatio;
  return `耐力稳定性较区间首项${direction} ${Math.abs(last - first).toFixed(1)} 分；${load !== null && load !== undefined && load > 1.5 ? "近期负荷偏高，优先安排恢复。" : "当前负荷处于可控范围。"}`;
}

function trainingStatusLabel(status: TrainingStatusCode): string {
  return (
    {
      insufficient_data: "数据积累中",
      recovery: "恢复阶段",
      maintaining: "状态稳定",
      effective_stimulus: "训练有效",
      high_load: "负荷较高",
      attention: "需要关注恢复",
    } as Record<TrainingStatusCode, string>
  )[status];
}

function trainingStatusDescription(status: TrainingStatusCode): string {
  return (
    {
      insufficient_data: "训练样本不足，继续保持规律记录。",
      recovery: "近期训练量降低，身体正在恢复。",
      maintaining: "负荷稳定，适合保持当前训练节奏。",
      effective_stimulus: "训练刺激充分，恢复与负荷较平衡。",
      high_load: "负荷上升明显，需要关注睡眠和轻松跑比例。",
      attention: "急性负荷高于长期基线，建议优先恢复。",
    } as Record<TrainingStatusCode, string>
  )[status];
}

function loadRatioNote(value: number | null): string {
  if (value === null) return "数据不足";
  if (value > 1.5) return "偏高";
  if (value < 0.8) return "偏低";
  return "适中";
}
