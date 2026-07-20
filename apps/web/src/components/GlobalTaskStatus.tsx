import type { RuntimeStatusResponse } from "@rai/api-contracts";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api.js";
import {
  notifyDatabaseStateChanged,
  notifyDataUpdated,
} from "../events.js";
import { ArrowClockwise, CheckCircle, Warning } from "../icons.js";
import { StatusBadge } from "./StatusBadge.js";

const activeStatuses = new Set(["queued", "running", "validating"]);
const terminalStatuses = new Set(["succeeded", "rejected", "failed", "cancelled"]);
const POLL_FAILURE_NOTICE_THRESHOLD = 3;

export function GlobalTaskStatus() {
  const [status, setStatus] = useState<RuntimeStatusResponse | null>(null);
  const [notice, setNotice] = useState<{ id: string; status: string; message: string } | null>(null);
  const [reconnectNotice, setReconnectNotice] = useState(false);
  const previous = useRef<RuntimeStatusResponse | null>(null);
  const initialized = useRef(false);
  const consecutiveFailures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await api<RuntimeStatusResponse>("/v1/runtime-status");
        if (cancelled) return;
        consecutiveFailures.current = 0;
        setReconnectNotice(false);
        const before = previous.current;
        if (initialized.current && before) {
          const transitions = [
            { before: before.recomputeJob, after: next.recomputeJob, type: "模型重算", changesDatabaseState: false },
            { before: before.importJob, after: next.importJob, type: "数据导入", changesDatabaseState: true },
            { before: before.predictionModelJob, after: next.predictionModelJob, type: "预测模型训练", changesDatabaseState: false }
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
              if (succeeded) {
                if (transition.changesDatabaseState) {
                  notifyDatabaseStateChanged(transition.after.id);
                }
                notifyDataUpdated(transition.after.id);
              }
            }
          }
        }
        initialized.current = true;
        previous.current = next;
        setStatus(next);
        timer = setTimeout(() => void poll(), next.busy ? 1500 : 7000);
      } catch {
        if (cancelled) return;
        consecutiveFailures.current += 1;
        if (consecutiveFailures.current >= POLL_FAILURE_NOTICE_THRESHOLD) {
          setReconnectNotice(true);
        }
        timer = setTimeout(() => void poll(), 7000);
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

  const importJob = !reconnectNotice && status?.importJob && activeStatuses.has(status.importJob.status) ? status.importJob : null;
  const recompute = !reconnectNotice && status?.recomputeJob && activeStatuses.has(status.recomputeJob.status) ? status.recomputeJob : null;
  const prediction = !reconnectNotice && status?.predictionModelJob && activeStatuses.has(status.predictionModelJob.status)
    ? status.predictionModelJob
    : null;
  const active = importJob ?? recompute ?? prediction;
  const progress = recompute?.progressTotal
    ? Math.round((recompute.progressCurrent / recompute.progressTotal) * 100)
    : null;
  if (!active && !notice && !reconnectNotice) return null;

  return (
    <aside
      className={`global-task ${notice && notice.status !== "succeeded" ? "failed" : notice ? "succeeded" : ""}`}
      aria-live={notice && notice.status !== "succeeded" ? "assertive" : "polite"}
      aria-atomic="true"
      aria-label="后台任务状态"
    >
      {notice ? (notice.status === "succeeded" ? <CheckCircle size={19} /> : <Warning size={19} />) : <ArrowClockwise size={19} />}
      <span>
        <b>
          {notice?.message
            ?? (reconnectNotice
              ? "后台状态暂时不可用，正在重试连接"
              : importJob
                ? importJob.message
                : recompute
                  ? "模型正在重算"
                  : "预测模型正在训练")}
        </b>
        <small>
          {notice
            ? "active 数据以服务端结果为准"
            : reconnectNotice
              ? "网络或本地 API 短暂中断，恢复后会自动更新"
              : importJob
                ? importJob.phase
                : recompute
                  ? `${recompute.progressPhase ?? "queued"} · ${recompute.progressCurrent ?? 0}/${recompute.progressTotal ?? 0}`
                  : prediction?.status === "validating"
                    ? "正在验证模型质量与兼容性"
                    : "正在构建并训练个人残差模型"}
        </small>
        {progress !== null ? <i role="progressbar" aria-label="模型重算进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><em style={{ width: `${progress}%` }} /></i> : null}
      </span>
      {active ? <StatusBadge value={active.status} /> : null}
      <Link to="/data" className="text-link">查看</Link>
      {notice ? <button className="global-task-close" aria-label="关闭通知" onClick={() => setNotice(null)}>×</button> : null}
    </aside>
  );
}
