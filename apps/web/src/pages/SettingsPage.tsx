import type {
  BackupDto,
  DashboardResponse,
  DataSummaryResponse,
} from "@rai/api-contracts";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api.js";
import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { date } from "../format.js";
import { useRemote } from "../hooks.js";
import {
  HardDrives,
  LockKey,
  MapPinLine,
  ShieldCheck,
  Warning,
} from "../icons.js";

const bytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
};

function useDialogFocus(open: boolean, busy: boolean, close: () => void) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const closeRef = useRef(close);
  busyRef.current = busy;
  closeRef.current = close;
  const rememberFocus = () => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  };

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const selector =
      "button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";
    const focusable = () =>
      Array.from(dialog?.querySelectorAll<HTMLElement>(selector) ?? []);
    (
      dialog?.querySelector<HTMLElement>("[autofocus]") ?? focusable()[0]
    )?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  return [dialogRef, rememberFocus] as const;
}

export function SettingsPage({ databaseReady }: { databaseReady: boolean }) {
  const summary = useRemote<DataSummaryResponse>(
    "/v1/data-summary",
    databaseReady,
  );
  const dashboard = useRemote<DashboardResponse>(
    "/v1/dashboard",
    databaseReady,
  );
  const backups = useRemote<BackupDto[]>("/v1/backups");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupDto | null>(null);
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const deleteErrorRef = useRef<HTMLParagraphElement>(null);
  const restoreErrorRef = useRef<HTMLParagraphElement>(null);
  const hasDatabase = databaseReady && !deleted;
  const closeDeleteDialog = () => {
    setConfirmOpen(false);
    setConfirmation("");
    setDeleteError(null);
  };
  const closeRestoreDialog = () => {
    setRestoreTarget(null);
    setRestoreConfirmation("");
    setRestoreError(null);
  };
  const [deleteDialogRef, rememberDeleteFocus] = useDialogFocus(
    confirmOpen,
    busy,
    closeDeleteDialog,
  );
  const [restoreDialogRef, rememberRestoreFocus] = useDialogFocus(
    Boolean(restoreTarget),
    busy,
    closeRestoreDialog,
  );

  const createBackup = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const backup = await api<BackupDto>("/v1/backups", {
        method: "POST",
        body: "{}",
      });
      setSuccess(`备份已创建：${backup.name}`);
      await backups.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法创建备份");
    } finally {
      setBusy(false);
    }
  };

  const deleteBackup = async (backup: BackupDto) => {
    if (!window.confirm(`确认永久删除本地备份 ${backup.name}？`)) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api<{ deleted: boolean; backup: BackupDto }>(
        `/v1/backups/${encodeURIComponent(backup.name)}`,
        { method: "DELETE" },
      );
      setSuccess(`备份已删除：${backup.name}`);
      await backups.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法删除备份");
    } finally {
      setBusy(false);
    }
  };

  const deleteDatabase = async () => {
    setBusy(true);
    setDeleteError(null);
    setSuccess(null);
    try {
      const result = await api<{ deleted: boolean; backup: BackupDto }>(
        "/v1/database",
        {
          method: "DELETE",
          body: JSON.stringify({ confirmation }),
        },
      );
      setDeleted(result.deleted);
      window.dispatchEvent(new Event("rai:database-state-changed"));
      closeDeleteDialog();
      setSuccess(`本地数据库已删除；删除前备份：${result.backup.name}`);
      await backups.reload();
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "无法删除本地数据库");
      requestAnimationFrame(() => deleteErrorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async () => {
    if (!restoreTarget) return;
    setBusy(true);
    setRestoreError(null);
    setSuccess(null);
    try {
      const result = await api<{
        restored: boolean;
        restoredBackup: BackupDto;
        safetyBackup: BackupDto | null;
      }>(`/v1/backups/${encodeURIComponent(restoreTarget.name)}/restore`, {
        method: "POST",
        body: JSON.stringify({ confirmation: restoreConfirmation }),
      });
      setDeleted(false);
      closeRestoreDialog();
      setSuccess(
        `已恢复备份：${result.restoredBackup.name}${result.safetyBackup ? `；恢复前快照：${result.safetyBackup.name}` : ""}`,
      );
      window.dispatchEvent(new Event("rai:database-state-changed"));
      window.dispatchEvent(new Event("rai:data-updated"));
      await backups.reload();
    } catch (caught) {
      setRestoreError(caught instanceof Error ? caught.message : "无法恢复备份");
      requestAnimationFrame(() => restoreErrorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page settings-page">
      <header className="page-header">
        <h1>设置</h1>
        <p>当前版本为单用户、本地优先的个人工具。</p>
      </header>
      {error ? <ErrorBlock message={error} /> : null}
      {success ? (
        <div className="success-message">
          <ShieldCheck size={18} />
          <span>{success}</span>
        </div>
      ) : null}
      <section className="settings-list">
        <article>
          <HardDrives size={22} />
          <div>
            <h2>本地数据库</h2>
            <p>默认路径为 var/rai.sqlite。应用不会创建云端副本。</p>
          </div>
          <span>SQLite</span>
        </article>
        <article>
          <MapPinLine size={22} />
          <div>
            <h2>路线隐私</h2>
            <p>GPX 坐标只通过本地 API 提供给当前浏览器。</p>
          </div>
          <span>仅本机</span>
        </article>
        <article>
          <LockKey size={22} />
          <div>
            <h2>访问边界</h2>
            <p>API 固定监听 127.0.0.1，不开放局域网访问。</p>
          </div>
          <span>Localhost</span>
        </article>
        <article>
          <MapPinLine size={22} />
          <div>
            <h2>显示时区</h2>
            <p>训练绝对时间保存在 SQLite，页面统一按当前产品时区格式化。</p>
          </div>
          <span>Asia/Shanghai</span>
        </article>
      </section>

      <section className="panel database-summary">
        <div className="panel-heading">
          <div>
            <h2>数据资产</h2>
            <p>以下数字直接来自当前 SQLite，不在页面端推算。</p>
          </div>
          {summary.data ? (
            <code>{bytes(summary.data.databaseBytes)}</code>
          ) : null}
        </div>
        {!hasDatabase ? (
          <p className="empty-inline">
            本地数据库尚未准备。请前往“数据与模型”导入 Apple Health 导出。
          </p>
        ) : summary.loading ? (
          <LoadingBlock />
        ) : summary.error || !summary.data ? (
          <ErrorBlock message={summary.error ?? "无法读取数据摘要"} />
        ) : (
          <div className="summary-metrics">
            <span>
              <small>健康记录</small>
              <b>{summary.data.counts.healthRecords.toLocaleString("zh-CN")}</b>
            </span>
            <span>
              <small>原始训练</small>
              <b>{summary.data.counts.workouts.toLocaleString("zh-CN")}</b>
            </span>
            <span>
              <small>真实训练 Session</small>
              <b>
                {summary.data.counts.trainingSessions.toLocaleString("zh-CN")}
              </b>
            </span>
            <span>
              <small>路线点</small>
              <b>{summary.data.counts.routePoints.toLocaleString("zh-CN")}</b>
            </span>
            <span>
              <small>当前评分</small>
              <b>{summary.data.counts.assessments.toLocaleString("zh-CN")}</b>
            </span>
            <span>
              <small>数据集版本</small>
              <b className="dataset-value">
                {summary.data.datasetVersion ?? "--"}
              </b>
            </span>
          </div>
        )}
      </section>

      <section className="panel backup-panel">
        <div className="panel-heading">
          <div>
            <h2>本地备份</h2>
            <p>使用 SQLite 在线备份，包含尚在 WAL 中的已提交数据；系统默认保留最近 10 份且总量不超过 20 GB。</p>
          </div>
          <button
            className="button secondary"
            disabled={busy || !hasDatabase}
            onClick={() => void createBackup()}
          >
            {busy ? "处理中" : "创建备份"}
          </button>
        </div>
        {backups.loading ? (
          <LoadingBlock />
        ) : backups.error ? (
          <ErrorBlock message={backups.error} />
        ) : backups.data?.length ? (
          <div className="backup-list">
            {backups.data.map((backup) => (
              <div key={backup.name}>
                <span>
                  <b>{backup.name}</b>
                  <small>
                    {date(backup.createdAt, true)} · {bytes(backup.sizeBytes)}
                  </small>
                </span>
                <span className="backup-actions">
                  <a
                    className="text-link"
                    href={`/v1/backups/${encodeURIComponent(backup.name)}`}
                  >
                    下载
                  </a>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      rememberRestoreFocus();
                      setRestoreTarget(backup);
                      setRestoreConfirmation("");
                      setRestoreError(null);
                    }}
                  >
                    恢复
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    aria-label={`删除备份 ${backup.name}`}
                    onClick={() => void deleteBackup(backup)}
                  >
                    删除
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-inline">还没有本地备份。</p>
        )}
      </section>

      <section className="panel model-settings-panel">
        <div className="panel-heading">
          <div>
            <h2>模型状态</h2>
            <p>当前展示结果始终来自一个成功且不可变的 active Model Run。</p>
          </div>
          {dashboard.data ? (
            <code>{dashboard.data.activeModel?.modelVersion ?? "--"}</code>
          ) : null}
        </div>
        {!hasDatabase ? (
          <p className="empty-inline">首次导入后显示模型与校准信息。</p>
        ) : dashboard.loading ? (
          <LoadingBlock />
        ) : dashboard.error || !dashboard.data ? (
          <ErrorBlock message={dashboard.error ?? "无法读取模型状态"} />
        ) : (
          <div className="model-settings-grid">
            <span>
              <small>校准状态</small>
              <b>
                {dashboard.data.calibration.status === "completed"
                  ? "已完成"
                  : "校准中"}
              </b>
            </span>
            <span>
              <small>有效训练</small>
              <b>{dashboard.data.calibration.eligibleSessions}</b>
            </span>
            <span>
              <small>基准锚点</small>
              <b>
                {dashboard.data.calibration.baselineEndAt
                  ? date(dashboard.data.calibration.baselineEndAt)
                  : "--"}
              </b>
            </span>
            <span>
              <small>配置哈希</small>
              <b>
                {dashboard.data.activeModel?.modelConfigHash.slice(0, 10) ??
                  "--"}
              </b>
            </span>
          </div>
        )}
        <footer className="panel-actions">
          <Link to="/data" className="button secondary">
            模型历史与完整重算
          </Link>
          {hasDatabase ? (
            <a className="button secondary" href="/v1/diagnostics" download>
              导出脱敏诊断 JSON
            </a>
          ) : null}
        </footer>
      </section>

      <section className="panel danger-panel">
        <div>
          <Warning size={22} />
          <span>
            <h2>删除本地 RAI 数据</h2>
            <p>
              删除当前 SQLite 及 WAL
              文件。系统会先自动创建一份可下载的本机备份，Apple Health
              原始导出目录不会被修改。
            </p>
          </span>
        </div>
        <button
          className="button danger"
          disabled={busy || !hasDatabase}
          onClick={() => {
            rememberDeleteFocus();
            setConfirmation("");
            setDeleteError(null);
            setConfirmOpen(true);
          }}
        >
          删除数据库
        </button>
      </section>
      <section className="panel about-panel">
        <h2>RAI V1</h2>
        <p>
          当前模型版本保持冻结。Cardio 只用于诊断，不参与 CA
          权重。页面不计算评分，也不修改历史 Model Run。
        </p>
      </section>
      <section className="panel disclaimer-panel">
        <ShieldCheck size={24} />
        <div>
          <h2>健康免责声明</h2>
          <p>
            RAI
            是个人训练趋势工具，不是医疗设备。分数和解释不能用于诊断疾病、判断伤病或替代专业医疗建议。出现胸痛、晕厥、异常心率或其他不适时，应停止运动并寻求专业帮助。
          </p>
        </div>
      </section>

      {confirmOpen ? (
        <div
          className="confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy)
              closeDeleteDialog();
          }}
        >
          <section
            ref={deleteDialogRef}
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            aria-describedby={deleteError ? "delete-database-error" : undefined}
          >
            <Warning size={28} />
            <h2 id="delete-title">确认删除本地数据库</h2>
            <p>此操作会让概览、训练和趋势暂时不可用。请输入下方确认文字：</p>
            <code>删除我的 RAI 数据</code>
            <label className="field">
              <span>确认文字</span>
              <input
                autoFocus
                disabled={busy}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            {deleteError ? <p id="delete-database-error" ref={deleteErrorRef} className="form-error dialog-error" role="alert" tabIndex={-1}>{deleteError}</p> : null}
            <footer>
              <button
                className="button secondary"
                disabled={busy}
                onClick={closeDeleteDialog}
              >
                取消
              </button>
              <button
                className="button danger"
                disabled={busy || confirmation !== "删除我的 RAI 数据"}
                onClick={() => void deleteDatabase()}
              >
                {busy ? "正在备份并删除" : "确认删除"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {restoreTarget ? (
        <div
          className="confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy)
              closeRestoreDialog();
          }}
        >
          <section
            ref={restoreDialogRef}
            className="confirm-dialog restore-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-title"
            aria-describedby={restoreError ? "restore-database-error" : undefined}
          >
            <HardDrives size={28} />
            <h2 id="restore-title">恢复本地数据库备份</h2>
            <p>
              系统会先校验备份；若当前数据库存在，还会创建一份恢复前安全快照。请输入确认文字：
            </p>
            <code>恢复此备份</code>
            <p className="restore-name">{restoreTarget.name}</p>
            <label className="field">
              <span>恢复确认文字</span>
              <input
                autoFocus
                disabled={busy}
                value={restoreConfirmation}
                onChange={(event) => setRestoreConfirmation(event.target.value)}
              />
            </label>
            {restoreError ? <p id="restore-database-error" ref={restoreErrorRef} className="form-error dialog-error" role="alert" tabIndex={-1}>{restoreError}</p> : null}
            <footer>
              <button
                className="button secondary"
                disabled={busy}
                onClick={closeRestoreDialog}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={busy || restoreConfirmation !== "恢复此备份"}
                onClick={() => void restoreBackup()}
              >
                {busy ? "正在校验并恢复" : "确认恢复"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
