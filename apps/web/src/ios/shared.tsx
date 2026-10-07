import type { MobileSessionStructure, TrainingStatusCode, WorkoutListItem } from "@rai/api-contracts";
import { type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { pace, sessionType, shortDate } from "../format.js";
import { ArrowRight, PersonSimpleRun, Target } from "../icons.js";

export const dimensionLabels = {
  efficiency: "效率",
  pace: "配速",
  cardio: "心肺",
  stability: "稳定",
  recovery: "恢复",
} as const;

export const zoneColors: Record<string, string> = {
  recovery: "#54a864",
  aerobic_base: "#3aa6c6",
  aerobic_power: "#e9b91f",
  lactate_threshold: "#ed6549",
  anaerobic: "#123f2b",
};

export function zoneColor(zone: string): string {
  return zoneColors[zone] ?? "#ed6549";
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  const when = hour < 12 ? "早上" : hour < 18 ? "下午" : "晚上";
  return `${when}好，跑者`;
}

export function formatToday(now = new Date()): string {
  return now.toLocaleDateString("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function weekDay(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString("zh-CN", {
    weekday: "short",
  });
}

export function formatMd(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日`;
}

export function shanghaiDate(value: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function monthLabel(month: string): string {
  const parts = month.split("-");
  const year = parts[0] ?? month;
  const mm = Number(parts[1] ?? 0);
  return mm ? `${year}年${mm}月` : month;
}

export function Card({
  title,
  action,
  onAction,
  children,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="ios-card">
      <div className="ios-card-title">
        <b>{title}</b>
        {action ? (
          onAction ? (
            <button type="button" className="ios-card-action" onClick={onAction}>
              {action}
              <ArrowRight size={14} />
            </button>
          ) : (
            <span>
              {action}
              <ArrowRight size={14} />
            </span>
          )
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function IosLoading({
  error,
  onRetry,
  compact = false,
}: {
  error: string | null;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const retry = onRetry ?? (() => window.location.reload());
  return (
    <div
      className={`ios-loading${compact ? " compact" : ""}`}
      aria-live="polite"
      role={error ? "alert" : "status"}
    >
      <span>{error ?? "正在读取数据…"}</span>
      {error ? (
        <button type="button" className="ios-save" onClick={retry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

export const trainingStatusLabel: Record<TrainingStatusCode, string> = {
  insufficient_data: "数据积累中",
  recovery: "恢复阶段",
  maintaining: "状态稳定",
  effective_stimulus: "训练有效",
  high_load: "负荷较高",
  attention: "需要关注恢复",
};

export function bpmRange(lower: number | null, upper: number | null): string {
  if (lower == null && upper != null) return `< ${Math.round(upper)}`;
  if (lower != null && upper == null) return `≥ ${Math.round(lower)}`;
  if (lower == null && upper == null) return "--";
  return `${Math.round(lower ?? 0)}–${Math.round(upper ?? 0)}`;
}

export function paceRange(lower: number | null, upper: number | null): string {
  if (lower == null && upper == null) return "--";
  if (lower == null && upper != null) return `< ${pace(upper)}`;
  if (lower != null && upper == null) return `≥ ${pace(lower)}`;
  return `${pace(lower)}–${pace(upper)}`;
}

export function percent(value: number | null | undefined): string {
  if (value == null) return "--";
  return `${Math.round(value * 100)}%`;
}

/**
 * One-line summary of a prescription, e.g. `6 × 800m`.
 *
 * Mirrors `WorkoutPlanMapper.structureSummary` in `apps/ios/RAI/WorkoutPlanMapper.swift`
 * — the two must stay in step. Only the *display* of a prescription is derived
 * here; the prescription itself (kind → zone, pace and heart-rate ranges) is
 * always read from the server and never re-derived on a client.
 */
export function structureSummary(structure: MobileSessionStructure | null | undefined): string {
  const block = structure?.blocks?.[0];
  const work = block?.steps.find((step) => step.purpose === "work") ?? block?.steps[0];
  if (!block || !work) return "";
  const sets = Math.max(1, block.iterations);
  const goal = work.goal;
  if (goal.type === "distance") {
    const text = goal.meters >= 1000 ? `${(goal.meters / 1000).toFixed(1)}km` : `${Math.round(goal.meters)}m`;
    return `${sets} × ${text}`;
  }
  if (goal.type === "time") {
    const text = goal.seconds >= 60 ? `${Math.round(goal.seconds / 60)}分` : `${Math.round(goal.seconds)}秒`;
    return `${sets} × ${text}`;
  }
  return `${sets} 组`;
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="ios-empty-state">
      <Target size={23} />
      <span>{label}</span>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ios-stat">
      <small>{label}</small>
      <b>{value}</b>
    </div>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="ios-fact">
      <small>{label}</small>
      <b>{value}</b>
    </div>
  );
}

export function RecordRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | null;
}) {
  return (
    <div className="ios-record">
      <span>
        {label}
        {detail ? <small>{detail}</small> : null}
      </span>
      <b>{value}</b>
    </div>
  );
}

export function WorkoutRow({
  workout,
  detailed = false,
}: {
  workout: WorkoutListItem;
  detailed?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const typeLabel = sessionType(workout.sessionType || "unknown");
  return (
    <button
      type="button"
      className="ios-workout-row"
      aria-label={`查看${typeLabel}详情`}
      onClick={() =>
        navigate(`/workouts/${workout.id}`, {
          state: { from: `${location.pathname}${location.search}` },
        })
      }
    >
      <span className="ios-workout-icon">
        <PersonSimpleRun size={19} />
      </span>
      <span className="ios-workout-copy">
        <b>{typeLabel}</b>
        <small>
          {shortDate(workout.startedAt)}
          {workout.currentAbility != null ? ` · CA ${workout.currentAbility.toFixed(0)}` : ""}
          {detailed && workout.averageHeartRateBpm
            ? ` · ${Math.round(workout.averageHeartRateBpm)} 次/分`
            : ""}
          {workout.averagePaceSecondsPerKm
            ? ` · ${pace(workout.averagePaceSecondsPerKm)}`
            : ""}
        </small>
        <span className="ios-workout-tags">
          {workout.assessmentStatus ? <i>{workout.assessmentStatus === "eligible" ? "有效" : workout.assessmentStatus === "trial" ? "试算" : "排除"}</i> : null}
          {workout.indoor ? <i>室内</i> : null}
          {workout.sourceCategory !== "apple_watch" ? <i>第三方</i> : null}
          {workout.confidence != null && workout.confidence < 0.6 ? <i>低置信</i> : null}
        </span>
      </span>
      <strong>
        {workout.distanceKm == null ? "--" : workout.distanceKm.toFixed(1)}{" "}
        <small>km</small>
      </strong>
      <ArrowRight size={14} className="ios-workout-chevron" />
    </button>
  );
}

export function Sparkline({
  values,
  label,
  color,
}: {
  values: number[];
  label: string;
  color: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const sampled = downsample(values, 48);
  const d = sampled
    .map((value, index) => {
      const x = (index / Math.max(1, sampled.length - 1)) * 100;
      const y = 24 - ((value - min) / span) * 22 - 1;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <div className="ios-sparkline-block">
      <small>{label}</small>
      <svg
        className="ios-sparkline"
        viewBox="0 0 100 24"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        <path d={d} stroke={color} />
      </svg>
    </div>
  );
}

function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const sampled: number[] = [];
  const step = (values.length - 1) / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(values[Math.round(index * step)] ?? 0);
  }
  return sampled;
}
