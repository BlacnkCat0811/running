import "../pixel-layout.css";
import { WorkoutSummaryExport } from "../components/WorkoutSummaryExport.js";
import "../data-reference.css";
import type {
  BackupDto,
  DashboardResponse,
  DatabaseDeletionResponse,
  DataSummaryResponse,
  HealthResponse,
} from "@rai/api-contracts";
import { useEffect, useRef, useState } from "react";

import { PrivacyZoneEditor } from "../components/ShareCardPanel.js";
import { Link } from "react-router-dom";

import { ApiError, api, readApiToken, writeApiToken } from "../api.js";
import { useApiToken } from "../api-token.js";
import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { notifyDataUpdated, notifyDatabaseStateChanged } from "../events.js";
import { date } from "../format.js";
import { useRemote } from "../hooks.js";
import {
  Database,
  HardDrives,
  LockKey,
  MapPinLine,
  PersonSimpleRun,
  ShieldCheck,
  Timer,
  Warning,
} from "../icons.js";

const bytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
};

const mutationResultIsUncertain = (caught: unknown): boolean =>
  !(caught instanceof ApiError) || caught.status >= 500;

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
      if (items.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1);
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
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
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected && !(previousFocus instanceof HTMLButtonElement && previousFocus.disabled)) {
        previousFocus.focus();
      }
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
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState(() => readApiToken());
  const tokenSaved = useApiToken().length > 0;
  const [revealToken, setRevealToken] = useState(false);
  // 匿名只读模式下浏览器没有令牌，/v1/backups 必然 401；没有令牌就不发这个请求，
  // 免得设置页在"本来就看不了备份"的情况下挂一个红色错误块。
  const backups = useRemote<BackupDto[]>("/v1/backups", tokenSaved);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupDto | null>(null);
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const deleteErrorRef = useRef<HTMLParagraphElement>(null);
  const restoreErrorRef = useRef<HTMLParagraphElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!success || busy || confirmOpen || restoreTarget) return;
    successRef.current?.focus();
  }, [success, busy, confirmOpen, restoreTarget]);

  // Focus only after React has committed the error element and enabled the
  // dialog again; requestAnimationFrame can run before a concurrent render.
  useEffect(() => {
    if (!busy && deleteError && confirmOpen) deleteErrorRef.current?.focus();
  }, [busy, deleteError, confirmOpen]);
  useEffect(() => {
    if (!busy && restoreError && restoreTarget) restoreErrorRef.current?.focus();
  }, [busy, restoreError, restoreTarget]);

  const persistApiToken = () => {
    writeApiToken(tokenDraft);
    const stored = readApiToken();
    setSuccess(stored ? "API 令牌已保存，正在重新读取数据。" : "API 令牌已清除。");
    // 两个事件缺一不可：data-updated 刷新各页数据，database-state-changed 让 App
    // 重新检查 /v1/health —— 未配置令牌时 App 拿不到 health 会整体渲染错误块，
    // 不重新检查的话填完令牌也出不去这个页面。
    notifyDataUpdated();
    notifyDatabaseStateChanged();
  };

  const clearApiToken = () => {
    setTokenDraft("");
    writeApiToken("");
    setSuccess("API 令牌已清除。");
    notifyDataUpdated();
    notifyDatabaseStateChanged();
  };

  const deleteDatabase = async () => {
    setBusy(true);
    setDeleteError(null);
    setSuccess(null);
    try {
      const result = await api<DatabaseDeletionResponse>(
        "/v1/database",
        {
          method: "DELETE",
          body: JSON.stringify({ confirmation }),
        },
      );
      setDeleted(result.deleted);
      window.dispatchEvent(new Event("rai:database-state-changed"));
      closeDeleteDialog();
      setSuccess(
        result.preservation.kind === "backup"
          ? `本地数据库已删除；可恢复的删除前备份：${result.preservation.backup.name}`
          : `本地数据库已删除；损坏数据库已隔离，仅供取证，不能直接恢复：${result.preservation.snapshot.name}`,
      );
      await backups.reload();
    } catch (caught) {
      if (mutationResultIsUncertain(caught)) {
        let health: HealthResponse;
        try {
          health = await api<HealthResponse>("/v1/health");
        } catch (healthError) {
          setDeleteError(
            `无法确认删除结果：${healthError instanceof Error ? healthError.message : "无法读取数据库状态"}`,
          );
          return;
        }
        window.dispatchEvent(new Event("rai:database-state-changed"));
        if (!health.databaseReady) {
          setDeleted(true);
          closeDeleteDialog();
          setSuccess("本地数据库已删除；连接中断后已通过运行状态确认。");
          void backups.reload();
          return;
        }
      }
      setDeleteError(caught instanceof Error ? caught.message : "无法删除本地数据库");
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
      if (mutationResultIsUncertain(caught)) {
        let health: HealthResponse;
        try {
          health = await api<HealthResponse>("/v1/health");
        } catch (healthError) {
          setRestoreError(
            `无法确认恢复结果：${healthError instanceof Error ? healthError.message : "无法读取数据库状态"}`,
          );
          return;
        }
        window.dispatchEvent(new Event("rai:database-state-changed"));
        if (health.databaseReady && !databaseReady) {
          const restoredName = restoreTarget.name;
          setDeleted(false);
          closeRestoreDialog();
          setSuccess(`已恢复备份：${restoredName}；连接中断后已通过运行状态确认。`);
          window.dispatchEvent(new Event("rai:data-updated"));
          void backups.reload();
          return;
        }
        if (health.databaseReady) {
          setRestoreError("数据库当前可用，但无法确认是否已切换到所选备份；页面状态已刷新，请核对数据后再操作。");
          window.dispatchEvent(new Event("rai:data-updated"));
          void backups.reload();
          return;
        }
      }
      setRestoreError(caught instanceof Error ? caught.message : "无法恢复备份");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page settings-page">
      <header className="page-header">
        <div className="header-title-with-icon"><HardDrives size={54} /><div>
          <h1>设置</h1>
          <p>当前版本为单用户、本地优先的个人工具。</p>
        </div></div>
      </header>
      {success ? (
        <div className="success-message" ref={successRef} tabIndex={-1}>
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

      <WorkoutSummaryExport />
      <section className="panel api-token-panel">
        <div className="panel-heading">
          <div>
            <h2>API 访问令牌</h2>
            <p>浏览数据无需令牌；保存、导入、删除等修改操作需要令牌。iOS App 由壳自动注入，无需在此配置。</p>
          </div>
          <code>{tokenSaved ? "已配置" : "未配置"}</code>
        </div>
        <form
          className="api-token-form"
          onSubmit={(event) => {
            event.preventDefault();
            persistApiToken();
          }}
        >
          <label className="field">
            <span>Token</span>
            <input
              type={revealToken ? "text" : "password"}
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder="粘贴服务器 /etc/rai/rai.env 中的 RAI_API_TOKEN"
              autoComplete="off"
              spellCheck={false}
            />
            <small>仅保存在当前浏览器的 localStorage，不写入构建产物，也不会上传到第三方。</small>
          </label>
          <div className="api-token-actions">
            <button className="button primary" type="submit" disabled={!tokenDraft.trim()}>
              保存并重新读取
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={() => setRevealToken((value) => !value)}
            >
              {revealToken ? "隐藏" : "显示"}
            </button>
            {tokenSaved ? (
              <button className="button secondary" type="button" onClick={clearApiToken}>
                清除
              </button>
            ) : null}
          </div>
        </form>
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
              <Database aria-hidden="true" />
              <small>健康记录</small>
              <b>{summary.data.counts.healthRecords.toLocaleString("zh-CN")}</b>
            </span>
            <span>
              <PersonSimpleRun aria-hidden="true" />
              <small>原始训练</small>
              <b>{summary.data.counts.workouts.toLocaleString("zh-CN")}</b>
            </span>
            <span>
              <ShieldCheck aria-hidden="true" />
              <small>真实训练 Session</small>
              <b>
                {summary.data.counts.trainingSessions.toLocaleString("zh-CN")}
              </b>
            </span>
            <span>
              <MapPinLine aria-hidden="true" />
              <small>路线点</small>
              <b>{summary.data.counts.routePoints.toLocaleString("zh-CN")}</b>
            </span>
            <span>
              <Timer aria-hidden="true" />
              <small>当前评分</small>
              <b>{summary.data.counts.assessments.toLocaleString("zh-CN")}</b>
            </span>
            <span>
              <LockKey aria-hidden="true" />
              <small>数据集版本</small>
              <b className="dataset-value">
                {summary.data.datasetVersion ?? "--"}
              </b>
            </span>
          </div>
        )}
      </section>

      {/* D9 隐私区：决定**分享出去**的卡片显示什么，App 内仍显示完整轨迹。
          没有数据库时整块不挂载：否则首次导入流程会去打一个必然 409 的接口，
          控制台里那条错误会盖住真正需要用户注意的信息。 */}
      {hasDatabase ? <PrivacyZoneEditor /> : null}

      {/* §11「项目退出备份责任」：常规"创建备份"入口退役。
          下面这块**保留**备份清单与恢复/下载：那是恢复能力，不是备份能力
          —— 退役恢复入口换不来 §11 想要的任何东西，却会拆掉"发现损坏还能回滚"的
          最后一道线（§12）。 */}
      <section className="panel backup-panel">
        <div className="panel-heading">
          <div>
            <h2>本地备份</h2>
            <p>
              应用不再创建备份（创建、校验、轮换与删除都已退役）。请在维护窗口前由运维
              自行完成一致性备份：活跃 WAL 库不能只复制 rai.sqlite，须用 SQLite
              一致性备份 API 或存储快照。下面列出的已有备份不会被应用删除，由运维决定
              保留或归档。
            </p>
          </div>
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
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-inline">{tokenSaved ? "还没有本地备份。" : "配置令牌后可查看、下载与恢复备份。"}</p>
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
              删除当前 SQLite 及 WAL 文件。可读取的数据库会先创建可恢复的本机备份；
              损坏数据库会隔离为仅供取证的快照，不能直接恢复。Apple Health
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
            tabIndex={-1}
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
                {busy ? "正在保留并删除" : "确认删除"}
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
            tabIndex={-1}
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
                id="restore-confirmation"
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
