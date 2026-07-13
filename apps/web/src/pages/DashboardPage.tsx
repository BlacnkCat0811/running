import type {
  DashboardResponse,
  TrainingStatisticsOverviewResponse,
  TrainingStatusCode,
  TrendResponse,
} from "@rai/api-contracts";
import { Link } from "react-router-dom";

import { AbilityChart } from "../components/AbilityChart.js";
import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { WorkoutTable } from "../components/WorkoutTable.js";
import { date, explanation, number, sessionType } from "../format.js";
import { useRemote } from "../hooks.js";
import { ArrowRight, Pulse, TrendDown, TrendUp } from "../icons.js";

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
  const gv = data.latestSnapshot?.growthVelocityPerWeek ?? null;
  const weekChange = data.latestSnapshot?.changeFrom7DaysAgo ?? null;
  const latest = data.latestWorkout;
  const caGap =
    latest?.currentAbility !== null &&
    latest?.currentAbility !== undefined &&
    data.latestSnapshot?.trueAbility !== null &&
    data.latestSnapshot?.trueAbility !== undefined
      ? latest.currentAbility - data.latestSnapshot.trueAbility
      : null;
  const calibration = data.calibration;
  return (
    <div className="page dashboard-page">
      <header className="page-header split">
        <div>
          <h1>你的跑步能力</h1>
          <p>区分单次发挥和长期训练水平。</p>
        </div>
        <div className="dashboard-header-actions">
          <div className="model-chip">
            <span>Active model</span>
            <b>{data.activeModel?.modelVersion ?? "未激活"}</b>
            <small>{data.latestSnapshot?.localDate ?? "--"}</small>
          </div>
          <Link to="/data" className="button secondary">
            导入更新
          </Link>
        </div>
      </header>

      {data.runningJob ? (
        <div className="job-banner">
          <Pulse size={20} />
          <span>
            <b>模型正在重算</b>
            <small>继续展示当前 active Run，完成后自动切换。</small>
          </span>
          <StatusBadge value={data.runningJob.status} />
        </div>
      ) : null}
      {calibration.status !== "completed" ? (
        <section className="panel calibration-panel">
          <div className="panel-heading">
            <div>
              <h2>
                {calibration.status === "not_started"
                  ? "等待校准数据"
                  : "真实跑力正在校准"}
              </h2>
              <p>
                模型当前以有效训练次数和时间跨度建立个人基准；时长与高覆盖心率作为质量参考。
              </p>
            </div>
            <StatusBadge value="calibrating" />
          </div>
          <div className="calibration-grid">
            <span>
              <small>有效训练</small>
              <b>
                {calibration.eligibleSessions} /{" "}
                {calibration.requirements.sessions}
              </b>
            </span>
            <span>
              <small>累计时长</small>
              <b>
                {Math.round(calibration.eligibleDurationMinutes)} /{" "}
                {calibration.requirements.durationMinutes} 分
              </b>
            </span>
            <span>
              <small>覆盖跨度</small>
              <b>
                {calibration.spanDays} / {calibration.requirements.spanDays} 天
              </b>
            </span>
            <span>
              <small>高心率覆盖</small>
              <b>
                {calibration.highCoverageSessions} /{" "}
                {calibration.requirements.highCoverageSessions}
              </b>
            </span>
          </div>
        </section>
      ) : null}

      <section className="hero-metrics" aria-label="能力概览">
        <article className="metric-primary">
          <span>真实跑力 / TA</span>
          <strong>{number(data.latestSnapshot?.trueAbility ?? null)}</strong>
          <small>
            {data.latestSnapshot?.decayPoints
              ? `含 ${number(data.latestSnapshot.decayPoints)} 点停跑衰减`
              : weekChange === null
                ? "长期训练能力"
                : `较 7 天前 ${weekChange >= 0 ? "+" : ""}${weekChange.toFixed(2)}`}
          </small>
        </article>
        <article className="metric-ca">
          <span>最新即时能力 / CA</span>
          <strong>{number(latest?.currentAbility ?? null)}</strong>
          <small>
            {latest
              ? `${date(latest.startedAt)} · ${sessionType(latest.sessionType)}${caGap === null ? "" : ` · 比 TA ${caGap >= 0 ? "+" : ""}${caGap.toFixed(2)}`}`
              : "暂无有效训练"}
          </small>
        </article>
        <article className="metric-support">
          <span>成长速度 / GV</span>
          <strong>
            {gv === null ? "--" : `${gv >= 0 ? "+" : ""}${gv.toFixed(2)}`}
          </strong>
          <small>每周能力点</small>
          {gv !== null && gv >= 0 ? (
            <TrendUp size={28} />
          ) : (
            <TrendDown size={28} />
          )}
        </article>
        <article className="metric-support">
          <span>当前模型样本</span>
          <strong>
            {data.activeModel?.featureCount ?? data.totals.sessions}
          </strong>
          <small>
            {data.totals.eligible} 有效 · {data.totals.trial} 试算 ·{" "}
            {data.totals.excluded} 排除
          </small>
        </article>
      </section>

      {statistics.data?.week ? (
        <Link
          to="/statistics"
          className="training-summary-band"
          aria-label="查看运动统计"
        >
          <span>
            <small>本周跑量</small>
            <b>{(statistics.data.week.distanceMeters / 1_000).toFixed(1)} km</b>
            <em>
              {statistics.data.week.comparison?.distanceChangeFraction ===
                null ||
              statistics.data.week.comparison?.distanceChangeFraction ===
                undefined
                ? "--"
                : `${statistics.data.week.comparison.distanceChangeFraction >= 0 ? "+" : ""}${Math.round(statistics.data.week.comparison.distanceChangeFraction * 100)}%`}
            </em>
          </span>
          <span>
            <small>训练状态</small>
            <b>
              {trainingStatusLabel(
                statistics.data.status?.trainingStatus ?? "insufficient_data",
              )}
            </b>
            <em>
              负荷置信度{" "}
              {statistics.data.statusConfidence === null
                ? "--"
                : `${Math.round(statistics.data.statusConfidence * 100)}%`}
            </em>
          </span>
          <span>
            <small>最近 7 日负荷</small>
            <b>{Math.round(statistics.data.status?.current7dLoad ?? 0)}</b>
            <em>
              负荷比 {statistics.data.status?.loadRatio?.toFixed(2) ?? "--"}
            </em>
          </span>
          <ArrowRight size={18} />
        </Link>
      ) : null}

      <section className="dashboard-grid">
        <article className="panel trend-panel">
          <div className="panel-heading">
            <div>
              <h2>近四周能力</h2>
              <p>TA 是趋势，CA 是每次训练的即时表现。</p>
            </div>
            <Link to="/trends" className="text-link">
              查看完整趋势 <ArrowRight size={15} />
            </Link>
          </div>
          {trend.data ? (
            <AbilityChart trend={trend.data} height={285} />
          ) : trend.error ? (
            <ErrorBlock
              message={trend.error}
              onRetry={() => void trend.reload()}
            />
          ) : (
            <LoadingBlock label="正在读取趋势" />
          )}
          {trend.data ? (
            <div className="chart-legend">
              <span className="ta">TA 真实跑力</span>
              <span className="ca">CA 即时能力</span>
            </div>
          ) : null}
        </article>
        <article className="panel explanation-panel">
          <div className="panel-heading">
            <div>
              <h2>本次更新说明</h2>
              <p>解释当前 CA 与 TA 变化。</p>
            </div>
          </div>
          {data.explanationCodes.length > 0 ? (
            <ol className="explanation-list">
              {data.explanationCodes.map((code, index) => (
                <li key={code}>
                  <span>{index + 1}</span>
                  {explanation(code)}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">暂无可用解释。</p>
          )}
          <div className="cardio-note">
            <b>Cardio {number(data.dimensions?.cardio ?? null)}</b>
            <span>诊断，不参与当前 CA</span>
          </div>
          {latest ? (
            <Link
              to={`/workouts/${latest.id}`}
              state={{ from: "/" }}
              className="button primary full"
            >
              查看训练详情
            </Link>
          ) : null}
        </article>
      </section>

      <section className="panel recent-panel">
        <div className="panel-heading">
          <div>
            <h2>最近训练</h2>
            <p>按训练时间倒序，展示 active Model Run 结果。</p>
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

function trainingStatusLabel(status: TrainingStatusCode): string {
  return (
    {
      insufficient_data: "数据积累中",
      recovery: "恢复 / 训练减少",
      maintaining: "负荷维持",
      effective_stimulus: "有效训练刺激",
      high_load: "当前负荷较高",
      attention: "需要关注恢复",
    } as Record<TrainingStatusCode, string>
  )[status];
}
