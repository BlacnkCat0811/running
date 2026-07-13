import type { RuntimeStatusResponse } from "@rai/api-contracts";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api.js";
import { ArrowClockwise, CheckCircle, Warning } from "../icons.js";
import { StatusBadge } from "./StatusBadge.js";

const activeStatuses = new Set(["queued", "running"]);
const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);

export function GlobalTaskStatus() {
  const [status, setStatus] = useState<RuntimeStatusResponse | null>(null);
  const [notice, setNotice] = useState<{ id: string; status: string; message: string } | null>(null);
  const previous = useRef<RuntimeStatusResponse | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await api<RuntimeStatusResponse>("/v1/runtime-status");
        if (cancelled) return;
        const before = previous.current;
        if (initialized.current && before) {
          const transitions = [
            { before: before.recomputeJob, after: next.recomputeJob, type: "模型重算" },
            { before: before.importJob, after: next.importJob, type: "数据导入" }
          ];
          for (const transition of transitions) {
            const sameJobFinished =
              transition.before && transition.after &&
              transition.before.id === transition.after.id &&
              activeStatuses.has(transition.before.status) &&
              terminalStatuses.has(transition.after.status);
            const newJobAlreadyFinished =
              transition.after &&
              transition.before?.id !== transition.after.id &&
              terminalStatuses.has(transition.after.status);
            if (transition.after && (sameJobFinished || newJobAlreadyFinished)) {
              const succeeded = transition.after.status === "succeeded";
              setNotice({
                id: transition.after.id,
                status: transition.after.status,
                message: succeeded ? `${transition.type}完成，已刷新当前数据。` : `${transition.type}未完成，请查看任务记录。`
              });
              if (succeeded) window.dispatchEvent(new Event("rai:data-updated"));
            }
          }
        }
        initialized.current = true;
        previous.current = next;
        setStatus(next);
        timer = setTimeout(() => void poll(), next.busy ? 1500 : 7000);
      } catch {
        if (!cancelled) timer = setTimeout(() => void poll(), 7000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const importJob = status?.importJob && activeStatuses.has(status.importJob.status) ? status.importJob : null;
  const recompute = status?.recomputeJob && activeStatuses.has(status.recomputeJob.status) ? status.recomputeJob : null;
  const active = importJob ?? recompute;
  const progress = recompute?.progressTotal
    ? Math.round((recompute.progressCurrent / recompute.progressTotal) * 100)
    : null;
  if (!active && !notice) return null;

  return (
    <aside
      className={`global-task ${notice && notice.status !== "succeeded" ? "failed" : notice ? "succeeded" : ""}`}
      aria-live={notice && notice.status !== "succeeded" ? "assertive" : "polite"}
      aria-atomic="true"
      aria-label="后台任务状态"
    >
      {notice ? (notice.status === "succeeded" ? <CheckCircle size={19} /> : <Warning size={19} />) : <ArrowClockwise size={19} />}
      <span>
        <b>{notice?.message ?? (importJob ? importJob.message : "模型正在重算")}</b>
        <small>{notice ? "active 数据以服务端结果为准" : importJob ? importJob.phase : `${recompute?.progressPhase ?? "queued"} · ${recompute?.progressCurrent ?? 0}/${recompute?.progressTotal ?? 0}`}</small>
        {progress !== null ? <i role="progressbar" aria-label="模型重算进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><em style={{ width: `${progress}%` }} /></i> : null}
      </span>
      {active ? <StatusBadge value={active.status} /> : null}
      <Link to="/data" className="text-link">查看</Link>
      {notice ? <button className="global-task-close" aria-label="关闭通知" onClick={() => setNotice(null)}>×</button> : null}
    </aside>
  );
}
