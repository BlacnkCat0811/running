import type { PerformanceEntryDistance } from "@rai/api-contracts";
import { useState } from "react";

import { api, readApiToken } from "../api.js";
import { useRemote } from "../hooks.js";
import { duration, raceDistance, shortDate } from "../format.js";
import { ErrorBlock, LoadingBlock } from "./Feedback.js";
import { Plus, Trash } from "../icons.js";

/**
 * Manually entered race results (§12.10).
 *
 * This panel exists because the label pipeline could only ever see labels attached to
 * a training session — a runner whose races predate the watch had zero labels, which
 * is precisely the state the project review recorded. Everything here is label and
 * evaluation evidence: it calibrates predictions and can be scored against, and it
 * never becomes a route, a heart-rate series or an ability assessment.
 *
 * Loaded on demand for the same reason the privacy editor is: a panel that fetches on
 * mount turns "database is being replaced" into a console error on pages that never
 * needed it.
 */

interface LabelProgress {
  funnel: {
    usableOutcomeCount: number;
    manualEntryCount: number;
    confirmedCount: number;
    byDistance: Record<PerformanceEntryDistance, { usable: number; evaluated: number }>;
  };
  candidates: CandidateRow[];
  personal: {
    available: boolean;
    samples: number;
    labelCount: number;
    scoredCount: number;
    distances: number;
    spanDays: number;
    minimumSamples: number;
    minimumDistances: number;
    minimumSpanDays: number;
    reasonCodes: string[];
    band: {
      samples: number;
      evaluated: number;
      relativeLower: number;
      relativeCenter: number;
      relativeUpper: number;
      coverageClaim: string;
    } | null;
  };
}

/** `+1.2%` / `−0.8%` — a ratio band reads as a percentage, never as seconds. */
const relative = (ratio: number): string => `${ratio >= 1 ? "+" : "−"}${Math.abs((ratio - 1) * 100).toFixed(1)}%`;

const personalReason = (code: string): string => ({
  samples_below_minimum: "可用于留一法的标签不足",
  distances_below_minimum: "覆盖的距离种类不足",
  span_below_minimum: "时间跨度不足"
}[code] ?? code);

interface CandidateRow {
  trainingSessionId: string;
  localDate: string;
  distance: PerformanceEntryDistance;
  actualDistanceMeters: number;
  durationSeconds: number;
  paceSecondsPerKm: number;
  confidence: "likely" | "possible";
  reasons: string[];
}

interface EntryRow {
  id: string;
  localDate: string;
  distance: PerformanceEntryDistance;
  durationSeconds: number;
  note: string | null;
  recordedAt: string;
  revokedAt: string | null;
}

const DISTANCES: PerformanceEntryDistance[] = ["five_k", "ten_k", "half_marathon"];

/** `42:30` / `1:32:10` — the way a race result is written down. */
const clock = (seconds: number): string => {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
};

export function PerformanceEntriesPanel() {
  const [opened, setOpened] = useState(false);
  const [token] = useState(() => readApiToken());
  const remote = useRemote<{ entries: EntryRow[] }>("/v1/performance-entries", opened && token.length > 0);
  const progress = useRemote<LabelProgress>("/v1/label-funnel", opened && token.length > 0);
  const [draft, setDraft] = useState({ localDate: "", distance: "ten_k" as PerformanceEntryDistance, minutes: "", seconds: "" });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!opened) {
    return (
      <section className="panel performance-entry-panel">
        <div className="panel-heading">
          <div>
            <h2>手工成绩</h2>
            <p>录入没有手表记录的比赛成绩，作为预测校准与评估的标签；它不会生成轨迹或能力评分。</p>
          </div>
          <button type="button" className="button" onClick={() => setOpened(true)}><Plus size={16} />录入成绩</button>
        </div>
      </section>
    );
  }
  if (token.length === 0) {
    return (
      <section className="panel performance-entry-panel">
        <div className="panel-heading"><div><h2>手工成绩</h2><p>成绩录入需要令牌：请先在设置中保存令牌。</p></div></div>
      </section>
    );
  }

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus(null);
    const minutes = Number(draft.minutes || 0);
    const seconds = Number(draft.seconds || 0);
    try {
      await api<EntryRow>("/v1/performance-entries", {
        method: "POST",
        body: JSON.stringify({
          localDate: draft.localDate,
          distance: draft.distance,
          durationSeconds: minutes * 60 + seconds,
          note: null
        })
      });
      setStatus("已录入。它会从**录入时刻**起参与预测校准，不会追溯改写此前的预测。");
      setDraft({ localDate: "", distance: draft.distance, minutes: "", seconds: "" });
      await remote.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "录入失败");
    } finally {
      setBusy(false);
    }
  };

  /**
   * 一键确认已有训练：候选只是建议，确认走的是与手工录入完全相同的写入路径 ——
   * 候选本身永远不会变成标签。
   */
  const confirmCandidate = async (candidate: CandidateRow): Promise<void> => {
    setError(null);
    setStatus(null);
    try {
      await api<EntryRow>("/v1/performance-entries", {
        method: "POST",
        body: JSON.stringify({
          localDate: candidate.localDate,
          distance: candidate.distance,
          durationSeconds: candidate.durationSeconds,
          note: null
        })
      });
      setStatus("已确认为成绩标签：与手工录入走同一条写入路径，候选列表里不会再出现。");
      await Promise.all([remote.reload(), progress.reload()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "确认失败");
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setError(null);
    setStatus(null);
    try {
      await api<{ revoked: boolean }>(`/v1/performance-entries/${id}`, { method: "DELETE" });
      setStatus("已撤销：该条从撤销时刻起不再计入标签（记录仍然保留，便于对账）。");
      await remote.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "撤销失败");
    }
  };

  return (
    <section className="panel performance-entry-panel">
      <div className="panel-heading">
        <div>
          <h2>手工成绩</h2>
          <p>只作标签与评估证据：可校准、可被评估，不生成轨迹或能力评分。</p>
        </div>
      </div>
      {/* §12.11 个人自校准的进度：说清还差什么，而不是给一个没有依据的区间。 */}
      {progress.data ? (
        <div className="performance-entry-progress">
          <span>可用标签 <b>{progress.data.funnel.usableOutcomeCount}</b>（手工 {progress.data.funnel.manualEntryCount}）</span>
          <span>个人区间门槛：标签 {progress.data.personal.samples}/{progress.data.personal.minimumSamples} · 距离 {progress.data.personal.distances}/{progress.data.personal.minimumDistances} · 跨度 {progress.data.personal.spanDays}/{progress.data.personal.minimumSpanDays} 天</span>
          {progress.data.personal.band ? (
            /* 相对带，不是绝对秒数：它乘在任意距离的规则预测上。刻意不用 P80/P90 措辞。 */
            <small>
              自校准带：{relative(progress.data.personal.band.relativeLower)} ~ {relative(progress.data.personal.band.relativeUpper)}
              （中心 {relative(progress.data.personal.band.relativeCenter)}，{progress.data.personal.band.evaluated} 个留出残差）。
              把它乘在任意距离的规则预测上，就是你自己的区间；它是**自我校准**，不是人群 P80/P90 保证。
            </small>
          ) : (
            <small>
              {progress.data.personal.available
                ? "已满足样本门槛，但可用残差还不足以形成分位数带。"
                : `尚未达到：${progress.data.personal.reasonCodes.map(personalReason).join("、")}。`}
            </small>
          )}
        </div>
      ) : null}
      {remote.loading && !remote.data ? <LoadingBlock label="正在读取成绩条目" /> : null}
      {remote.error ? <ErrorBlock message={remote.error} onRetry={() => void remote.reload()} /> : null}
      {remote.data ? (
        remote.data.entries.length === 0 ? (
          <p className="performance-entry-empty">还没有手工成绩。比赛成绩是打破"零标签"最快的一条路。</p>
        ) : (
          <div className="performance-entry-list">
            {remote.data.entries.map((entry) => (
              <div className={`performance-entry-row ${entry.revokedAt === null ? "" : "revoked"}`} key={entry.id}>
                <span>{shortDate(entry.localDate)}</span>
                <span>{raceDistance(entry.distance)}</span>
                <b>{clock(entry.durationSeconds)}</b>
                <span>{entry.revokedAt === null ? `录入于 ${shortDate(entry.recordedAt)}` : "已撤销"}</span>
                {entry.revokedAt === null ? (
                  <button type="button" className="text-button" onClick={() => void revoke(entry.id)} aria-label={`撤销 ${entry.localDate} 的成绩`}><Trash size={16} /></button>
                ) : <span />}
              </div>
            ))}
          </div>
        )
      ) : null}
      {progress.data && progress.data.candidates.length > 0 ? (
        <div className="race-candidate-list">
          <b>看起来像比赛的训练</b>
          <small>只是建议：确认后按同一条写入路径成为标签，任何一条都可以先核对理由。</small>
          {progress.data.candidates.map((candidate) => (
            <div className="race-candidate-row" key={candidate.trainingSessionId}>
              <span>{shortDate(candidate.localDate)}</span>
              <span>{raceDistance(candidate.distance)}</span>
              <b>{clock(candidate.durationSeconds)}</b>
              <span className={candidate.confidence === "likely" ? "likely" : ""}>
                {candidate.confidence === "likely" ? "很可能" : "可能"}
              </span>
              <span className="race-candidate-reasons">{candidate.reasons.join("；")}</span>
              <button type="button" className="text-button" onClick={() => void confirmCandidate(candidate)}>确认</button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="performance-entry-form">
        <label><span>日期</span><input type="date" value={draft.localDate} onChange={(event) => setDraft({ ...draft, localDate: event.target.value })} /></label>
        <label><span>距离</span><select value={draft.distance} onChange={(event) => setDraft({ ...draft, distance: event.target.value as PerformanceEntryDistance })}>{DISTANCES.map((item) => <option key={item} value={item}>{raceDistance(item)}</option>)}</select></label>
        <label><span>分</span><input inputMode="numeric" value={draft.minutes} onChange={(event) => setDraft({ ...draft, minutes: event.target.value })} placeholder="42" /></label>
        <label><span>秒</span><input inputMode="numeric" value={draft.seconds} onChange={(event) => setDraft({ ...draft, seconds: event.target.value })} placeholder="30" /></label>
        <button type="button" className="button primary" disabled={busy || draft.localDate.length === 0} onClick={() => void submit()}>录入</button>
      </div>
      {error ? <p className="zone-setting-refresh-error" role="alert">{error}</p> : null}
      {status ? <p className="performance-entry-status" role="status">{status}</p> : null}
      <p className="performance-entry-note">
        手工成绩没有 GPS 与心率佐证，是你自己的陈述；系统按录入时刻起算，撤销同样按时刻生效。
      </p>
    </section>
  );
}
