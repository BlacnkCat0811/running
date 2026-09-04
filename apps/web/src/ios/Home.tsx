import type { MobileTodayResponse } from "@rai/api-contracts";
import { useNavigate } from "react-router-dom";

import { api } from "../api.js";
import { notifyDataUpdated } from "../events.js";
import { duration, explanation, pace, sessionKind } from "../format.js";
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
          <span>先同步</span>
          <strong>数据不是今天的</strong>
          <p>同步健康后再给今日裁决，避免用过期恢复开绿灯。</p>
        </section>
      ) : null}

      <section className="ios-ability-hero">
        <span>真实能力 TA</span>
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
        <span>今日裁决</span>
        <strong>{data.verdict.title}</strong>
        <p>{data.verdict.reason}</p>
      </section>
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
                    : `${pace(session.paceSecondsPerKmLower)}–${pace(session.paceSecondsPerKmUpper)}`}
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
          {!locked ? <LockButton onLocked={onLocked} /> : null}
          {data.lock.relockSuggested ? <RelockButton onLocked={onLocked} /> : null}
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

function LockButton({ onLocked }: { onLocked: () => void }) {
  return (
    <button
      type="button"
      className="ios-save"
      onClick={() => {
        void api("/v1/mobile/lock", {
          method: "POST",
          body: JSON.stringify({ action: "lock" }),
        }).then(() => {
          notifyDataUpdated();
          onLocked();
        });
      }}
    >
      锁定今天
    </button>
  );
}

function RelockButton({ onLocked }: { onLocked: () => void }) {
  return (
    <button
      type="button"
      className="ios-save ios-save-secondary"
      onClick={() => {
        void api("/v1/mobile/lock", {
          method: "POST",
          body: JSON.stringify({ action: "relock" }),
        }).then(() => {
          notifyDataUpdated();
          onLocked();
        });
      }}
    >
      恢复变差，改锁为轻松/休息
    </button>
  );
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
