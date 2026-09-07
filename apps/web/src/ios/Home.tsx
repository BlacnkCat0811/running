import type { MobileTodayResponse } from "@rai/api-contracts";
import { useNavigate } from "react-router-dom";
import { useState } from "react";

import { api } from "../api.js";
import { notifyDataUpdated } from "../events.js";
import { duration, explanation, pace, sessionKind, sleepDuration } from "../format.js";
import { useRemote } from "../hooks.js";
import { hasNativeBridge, postNative, useNativeStatus } from "./native.js";
import { Card, IosLoading } from "./shared.js";

export function IosHome() {
  const navigate = useNavigate();
  const result = useRemote<MobileTodayResponse>("/v1/mobile/today");
  const native = useNativeStatus();
  if (!result.data) {
    return (
      <IosLoading error={result.error} onRetry={() => void result.reload()} />
    );
  }
  const data = result.data;
  const phase = data.today.workoutCount > 0 ? "post_run" : (data.phase ?? inferPhase(data));
  const emptyToday = data.today.workoutCount === 0 && data.today.distanceKm === 0;
  const ta = data.ability.trueAbility;
  const change = data.ability.changeFrom7DaysAgo;

  return (
    <>
      <StaleBanner
        latestDataDate={data.latestDataDate}
        todayDate={data.today.localDate}
      />
      {native.isBusy ? (
        <div className="ios-stale-banner">{native.lastSyncMessage ?? "正在同步健康"}</div>
      ) : null}
      {data.calibration.status !== "completed" ? (
        <div className="ios-stale-banner">{data.calibration.message}</div>
      ) : null}

      {phase === "need_sync" ? (
        <section className="ios-verdict-card yellow">
        <span>需要同步</span>
          <strong>数据不是今天的</strong>
          <p>同步健康后再给今日裁决，避免用过期恢复开绿灯。</p>
        </section>
      ) : null}

      <section className="ios-ability-hero">
        <span>长期跑力估计</span>
        <strong>{ta == null ? "--" : ta.toFixed(1)}</strong>
        <p>
          {change == null ? data.ability.explanation : `${change >= 0 ? "+" : ""}${change.toFixed(1)} · ${data.ability.explanation}`}
        </p>
      </section>

      {phase === "post_run" ? (
        <PostRunBlocks
          data={data}
          onOpenWorkout={() => data.postRun && navigate(`/workouts/${data.postRun.workoutId}`)}
        />
      ) : (
        <MorningBlocks
          data={data}
          emptyToday={emptyToday}
          locked={phase === "locked" || phase === "rest_done"}
          restDone={phase === "rest_done"}
          onLocked={() => void result.reload()}
        />
      )}

      <nav className="ios-home-links" aria-label="下钻">
        <button type="button" className="ios-save ios-save-secondary" onClick={() => navigate("/week")}>
          本周
        </button>
        <button type="button" className="ios-save ios-save-secondary" onClick={() => navigate("/body")}>
          身体指标
        </button>
        <button type="button" className="ios-save ios-save-secondary" onClick={() => navigate("/workouts")}>
          训练
        </button>
      </nav>
    </>
  );
}

function MorningBlocks({
  data,
  emptyToday,
  locked,
  restDone,
  onLocked,
}: {
  data: MobileTodayResponse;
  emptyToday: boolean;
  locked: boolean;
  restDone: boolean;
  onLocked: () => void;
}) {
  const session = data.nextSession;
  return (
    <>
      <section className={`ios-verdict-card ${data.verdict.tone}`}>
          <span>今日训练建议</span>
        <strong>{data.verdict.title}</strong>
        <p>{data.verdict.reason}</p>
      </section>
      <Card title="昨夜恢复事实">
        <div className="ios-fact-list">
          <div className="ios-fact"><small>睡眠</small><b>{sleepDuration(data.recovery.lastNightSleepMinutes)}</b></div>
          <div className="ios-fact"><small>过夜 HRV (SDNN)</small><b>{data.recovery.morningHrvMs == null ? "--" : `${Math.round(data.recovery.morningHrvMs)} ms`}</b></div>
          <div className="ios-fact"><small>RHR</small><b>{data.recovery.restingHeartRateBpm == null ? "--" : `${Math.round(data.recovery.restingHeartRateBpm)} bpm`}</b></div>
        </div>
        <small>{data.recovery.note}</small>
      </Card>
      <Card title={restDone ? "今天的动作" : locked ? "已锁定的课" : "下一堂课"}>
        <div className="ios-next-session">
          <b>{restDone ? "今天的动作：休息" : session.title}</b>
          <small>{session.reason}</small>
          {session.kind !== "rest" ? (
            <div className="ios-fact-list">
              <div className="ios-fact">
                <small>距离</small>
                <b>{session.distanceKm == null ? "--" : `${session.distanceKm.toFixed(1)} km`}</b>
              </div>
              <div className="ios-fact">
                <small>配速</small>
                <b>
                  {session.paceSecondsPerKmLower == null
                    ? "--"
                    : paceRange(session.paceSecondsPerKmLower, session.paceSecondsPerKmUpper)}
                </b>
              </div>
              <div className="ios-fact">
                <small>心率</small>
                <b>
                  {session.heartRateBpmLower == null
                    ? "--"
                    : `${Math.round(session.heartRateBpmLower)}–${session.heartRateBpmUpper == null ? "" : Math.round(session.heartRateBpmUpper)}`}
                </b>
              </div>
            </div>
          ) : null}
          {emptyToday ? (
            <p className="ios-phy-copy">今天还没跑 · 本周已 {data.week.distanceKm.toFixed(1)} km</p>
          ) : null}
          {!locked ? <LockButton revision={data.recommendationRevision} onLocked={onLocked} /> : null}
          {data.lock.relockSuggested ? <RelockButton revision={data.recommendationRevision} onLocked={onLocked} /> : null}
        </div>
      </Card>
    </>
  );
}

function PostRunBlocks({
  data,
  onOpenWorkout,
}: {
  data: MobileTodayResponse;
  onOpenWorkout: () => void;
}) {
  const post = data.postRun;
  return (
    <>
      <section className="ios-today-hero">
        <span>
          今日跑步
          {data.today.workoutCount ? ` · ${data.today.workoutCount} 次` : ""}
        </span>
        <strong>
          {data.today.distanceKm.toFixed(1)} <small>km</small>
        </strong>
        <div className="ios-today-metrics">
          <span>
            <b>{duration(data.today.durationSeconds)}</b>
            <small>时长</small>
          </span>
          <span>
            <b>{pace(data.today.paceSecondsPerKm)}</b>
            <small>配速</small>
          </span>
          <span>
            <b>{post?.updatedTrueAbility ? "已更新 TA" : "未进 TA"}</b>
            <small>能力</small>
          </span>
        </div>
      </section>
      {post ? (
      <Card title="跑后结论" action="详情" onAction={onOpenWorkout}>
        <p className="ios-phy-copy">
          <b>{post.headline}</b>
        </p>
        <ul className="ios-phy-notes">
          {post.details.map((line) => (
            <li key={line}>{explanation(line)}</li>
          ))}
        </ul>
        <p className="ios-phy-copy">
          对照 {sessionKind(data.nextSession.kind)}
          {data.nextSession.paceSecondsPerKmLower
            ? ` · 目标 ${pace(data.nextSession.paceSecondsPerKmLower)}–${pace(data.nextSession.paceSecondsPerKmUpper)}`
            : ""}
        </p>
      </Card>
      ) : null}
    </>
  );
}

function LockButton({ revision, onLocked }: { revision: string; onLocked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="ios-save" disabled={busy} onClick={() => {
        setBusy(true);
        setError(null);
        void api("/v1/mobile/lock", {
          method: "POST",
          body: JSON.stringify({ action: "lock", expectedRevision: revision }),
        }).then(() => { notifyDataUpdated(); onLocked(); })
          .catch((caught) => setError(caught instanceof Error ? caught.message : "确认失败，请重试"))
          .finally(() => setBusy(false));
      }}>
        {busy ? "确认中…" : "确认今日安排"}
      </button>
      {error ? <small className="ios-sync-error" role="alert">{error}</small> : null}
    </>
  );
}

function RelockButton({ revision, onLocked }: { revision: string; onLocked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="ios-save ios-save-secondary" disabled={busy} onClick={() => {
        setBusy(true);
        setError(null);
        void api("/v1/mobile/lock", {
          method: "POST",
          body: JSON.stringify({ action: "relock", expectedRevision: revision }),
        }).then(() => { notifyDataUpdated(); onLocked(); })
          .catch((caught) => setError(caught instanceof Error ? caught.message : "重新确认失败，请重试"))
          .finally(() => setBusy(false));
      }}>
        {busy ? "确认中…" : "恢复变差，重新确认"}
      </button>
      {error ? <small className="ios-sync-error" role="alert">{error}</small> : null}
    </>
  );
}

function paceRange(lower: number | null, upper: number | null): string {
  if (lower == null && upper == null) return "暂不可用";
  if (lower != null && upper == null) return `${pace(lower)}/km 或更慢`;
  if (lower == null && upper != null) return `不快于 ${pace(upper)}/km`;
  return `${pace(lower!)}/km–${pace(upper!)}/km`;
}

function inferPhase(data: MobileTodayResponse): MobileTodayResponse["phase"] {
  if (data.today.workoutCount > 0) return "post_run";
  if (data.latestDataDate == null || data.latestDataDate < data.today.localDate) return "need_sync";
  if (data.lock.present && data.nextSession.kind === "rest") return "rest_done";
  if (data.lock.present) return "locked";
  return "morning_open";
}

function StaleBanner({
  latestDataDate,
  todayDate,
}: {
  latestDataDate: string | null;
  todayDate: string;
}) {
  const empty = latestDataDate == null || latestDataDate === "";
  if (!empty && latestDataDate >= todayDate) return null;
  const canSync = hasNativeBridge();
  if (empty) {
    return (
      <div className="ios-stale-banner">
        {canSync ? (
          <button
            type="button"
            className="ios-stale-action"
            onClick={() => postNative({ action: "syncHealth", full: false })}
          >
            点同步健康读取跑步
          </button>
        ) : (
          <span>点原生「同步健康」按钮读取跑步</span>
        )}
      </div>
    );
  }
  return (
    <div className="ios-stale-banner">
      数据截至 {latestDataDate}
      {canSync ? (
        <button
          type="button"
          className="ios-stale-action"
          onClick={() => postNative({ action: "syncHealth", full: false })}
        >
          同步健康
        </button>
      ) : (
        <span> · 点「同步健康」更新</span>
      )}
    </div>
  );
}
