import type {
  ImportJobResponse,
  InsufficientPredictionLabelsResponse,
  ModelRunComparisonResponse,
  ModelRunSummary,
  PredictionModelDetailResponse,
  PredictionModelListResponse,
  RecomputeJobDto,
  TrainPredictionModelResponse,
} from "@rai/api-contracts";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError, api } from "../api.js";
import {
  notifyDatabaseStateChanged,
  notifyDataUpdated,
} from "../events.js";
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
} from "../components/Feedback.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { date } from "../format.js";
import { useRemote } from "../hooks.js";
import {
  ArrowClockwise,
  CheckCircle,
  Database,
  FileZip,
  FolderOpen,
  ShieldCheck,
  UploadSimple,
} from "../icons.js";

type ImportInspection = {
  sourceId: string;
  status: "ready" | "unchanged" | "invalid";
  displayName?: string;
  exportFileName: string;
  exportBytes: number;
  exportCreatedAt: string | null;
  sourceSha256: string;
  routeFileCount: number;
  estimatedWorkoutCount: number | null;
  previousImportAt: string | null;
  warnings: Array<{ code?: string; message: string } | string>;
};

type ImportSourceCandidate = {
  id: string;
  sourceId?: string;
  displayName: string;
  path?: string;
  inputPath?: string;
  originalPath?: string;
  sizeBytes?: number;
  exportBytes?: number;
  modifiedAt?: string;
};

type EnhancedImportJob = ImportJobResponse & {
  progress?: number;
  summary?: {
    importMode: "unchanged" | "incremental" | "full";
    insertedWorkouts: number;
    updatedWorkouts: number;
    removedWorkouts: number;
    unchangedWorkouts: number;
    routesUpdated: number;
    featuresReused: number;
    featuresRecomputed: number;
    modelReplayFrom: string | null;
    durationMs: number;
    backupName: string | null;
  };
};

const IMPORT_JOB_STORAGE_KEY = "rai:active-import-job";

function formatBytes(value: number) {
  if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function uploadExport(file: File, onProgress: (value: number) => void) {
  return new Promise<{ sourceId: string }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/v1/imports/uploads");
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error("上传中断，请检查本地 API 后重试"));
    request.onload = () => {
      const body = request.response as { sourceId?: string; message?: string } | null;
      if (request.status >= 200 && request.status < 300 && body?.sourceId) resolve({ sourceId: body.sourceId });
      else reject(new Error(body?.message ?? "无法接收导出文件"));
    };
    const data = new FormData();
    data.append("file", file);
    request.send(data);
  });
}

export function DataModelPage({ databaseReady }: { databaseReady: boolean }) {
  const models = useRemote<ModelRunSummary[]>("/v1/model-runs", databaseReady);
  const jobs = useRemote<RecomputeJobDto[]>("/v1/jobs", databaseReady);
  const predictionModels = useRemote<PredictionModelListResponse>(
    "/v1/prediction-models",
    databaseReady,
  );
  const [path, setPath] = useState("");
  const [importJob, setImportJob] = useState<EnhancedImportJob | null>(null);
  const [importPollError, setImportPollError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ImportInspection | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [candidates, setCandidates] = useState<ImportSourceCandidate[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseRunId, setBaseRunId] = useState("");
  const [candidateRunId, setCandidateRunId] = useState("");
  const [comparison, setComparison] =
    useState<ModelRunComparisonResponse | null>(null);
  const [comparisonBusy, setComparisonBusy] = useState(false);
  const comparisonRequestId = useRef(0);
  const [selectedJob, setSelectedJob] = useState<RecomputeJobDto | null>(null);
  const [selectedPredictionModel, setSelectedPredictionModel] =
    useState<PredictionModelDetailResponse | null>(null);
  const notifiedSuccessfulImports = useRef(new Set<string>());
  const [predictionModelBusy, setPredictionModelBusy] = useState(false);
  const [predictionModelNotice, setPredictionModelNotice] = useState<{
    tone: "info" | "success" | "error";
    message: string;
    shortage?: InsufficientPredictionLabelsResponse;
  } | null>(null);

  const activePredictionRun =
    predictionModels.data?.runs.find((run) => run.active) ?? null;
  const pendingPredictionRun =
    predictionModels.data?.runs.find((run) =>
      ["queued", "running", "validating"].includes(run.status),
    ) ?? null;

  useEffect(() => {
    const savedJobId = localStorage.getItem(IMPORT_JOB_STORAGE_KEY);
    if (savedJobId) {
      void api<EnhancedImportJob>(`/v1/import-jobs/${savedJobId}`)
        .then((job) => {
          setImportJob(job);
          if (!["queued", "running"].includes(job.status)) {
            localStorage.removeItem(IMPORT_JOB_STORAGE_KEY);
          }
        })
        .catch(() => localStorage.removeItem(IMPORT_JOB_STORAGE_KEY));
    } else {
      void api<EnhancedImportJob | null>("/v1/import-jobs/active")
        .then((job) => {
          if (!job) return;
          setImportJob(job);
          localStorage.setItem(IMPORT_JOB_STORAGE_KEY, job.id);
        })
        .catch(() => undefined);
    }
    void api<{ sources: ImportSourceCandidate[] }>("/v1/import-sources/discover", { method: "POST", body: "{}" })
      .then((result) => setCandidates(result.sources ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!importJob || !["queued", "running"].includes(importJob.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api<EnhancedImportJob>(
          `/v1/import-jobs/${importJob.id}`,
        );
        if (stopped) return;
        setImportJob(next);
        setImportPollError(null);
        if (!["queued", "running"].includes(next.status)) {
          localStorage.removeItem(IMPORT_JOB_STORAGE_KEY);
          void jobs.reload();
          void models.reload();
          return;
        }
      } catch (caught) {
        if (stopped) return;
        setImportPollError(
          caught instanceof Error ? caught.message : "无法读取导入进度",
        );
      }
      timer = setTimeout(() => {
        void poll();
      }, 1500);
    };
    timer = setTimeout(() => {
      void poll();
    }, 1500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [importJob, jobs.reload, models.reload]);

  useEffect(() => {
    if (importJob?.status !== "succeeded" || notifiedSuccessfulImports.current.has(importJob.id)) return;
    notifiedSuccessfulImports.current.add(importJob.id);
    notifyDatabaseStateChanged(importJob.id);
    notifyDataUpdated(importJob.id);
  }, [importJob?.id, importJob?.status]);

  useEffect(() => {
    if (!models.data || candidateRunId || baseRunId) return;
    const candidate =
      models.data.find((model) => model.active) ??
      models.data.find((model) => model.status === "succeeded");
    const base = models.data.find(
      (model) => model.status === "succeeded" && model.id !== candidate?.id,
    );
    if (candidate) setCandidateRunId(candidate.id);
    if (base) setBaseRunId(base.id);
  }, [baseRunId, candidateRunId, models.data]);

  useEffect(() => {
    if (
      !predictionModels.data?.runs.some((run) =>
        ["queued", "running", "validating"].includes(run.status),
      )
    )
      return;
    const timer = setInterval(() => {
      void predictionModels.reload();
    }, 2000);
    return () => clearInterval(timer);
  }, [predictionModels.data, predictionModels.reload]);

  const inspectSource = async (sourceId: string) => {
    setBusy(true);
    setError(null);
    try {
      setInspection(await api<ImportInspection>("/v1/imports/inspect", {
        method: "POST",
        body: JSON.stringify({ sourceId }),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法检查导出文件");
    } finally {
      setBusy(false);
    }
  };
  const selectExport = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("请选择 Apple 健康导出的 ZIP 文件");
      return;
    }
    setInspection(null);
    setUploadProgress(0);
    setError(null);
    try {
      const uploaded = await uploadExport(file, setUploadProgress);
      setUploadProgress(100);
      await inspectSource(uploaded.sourceId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "上传失败");
    } finally {
      setUploadProgress(null);
    }
  };
  const startImport = async (requestBody: { sourceId: string } | { inputPath: string; confirmReplace: true }) => {
    setBusy(true);
    setError(null);
    setImportPollError(null);
    try {
      const job = await api<EnhancedImportJob>("/v1/import-jobs", {
          method: "POST",
          body: JSON.stringify(requestBody),
        });
      setImportJob(job);
      setInspection(null);
      localStorage.setItem(IMPORT_JOB_STORAGE_KEY, job.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };
  const recompute = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<{ jobId: string }>("/v1/model-runs", {
        method: "POST",
        body: "{}",
      });
      void jobs.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法创建重算任务");
    } finally {
      setBusy(false);
    }
  };
  const activate = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/model-runs/${id}/activate`, {
        method: "POST",
        body: "{}",
      });
      void models.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法激活模型");
    } finally {
      setBusy(false);
    }
  };
  const compare = async () => {
    if (!baseRunId || !candidateRunId) return;
    const requestId = ++comparisonRequestId.current;
    const requestedBase = baseRunId;
    const requestedCandidate = candidateRunId;
    setComparisonBusy(true);
    setError(null);
    try {
      const next = await api<ModelRunComparisonResponse>(
        `/v1/model-runs/compare?base=${encodeURIComponent(requestedBase)}&candidate=${encodeURIComponent(requestedCandidate)}`,
      );
      if (requestId === comparisonRequestId.current) setComparison(next);
    } catch (caught) {
      if (requestId === comparisonRequestId.current)
        setError(caught instanceof Error ? caught.message : "无法比较模型运行");
    } finally {
      if (requestId === comparisonRequestId.current) setComparisonBusy(false);
    }
  };
  const inspectJob = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setSelectedJob(await api<RecomputeJobDto>(`/v1/jobs/${id}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法读取任务详情");
    } finally {
      setBusy(false);
    }
  };
  const cancelJob = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/jobs/${id}/cancel`, { method: "POST", body: "{}" });
      await jobs.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法取消任务");
    } finally {
      setBusy(false);
    }
  };
  const trainPredictionModel = async () => {
    setPredictionModelBusy(true);
    setPredictionModelNotice(null);
    setError(null);
    try {
      const result = await api<TrainPredictionModelResponse>(
        "/v1/prediction-models/train",
        { method: "POST", body: "{}" },
      );
      setPredictionModelNotice({
        tone: "info",
        message: `训练任务 ${result.runId.slice(0, 12)} 已进入队列。验证期间继续使用当前预测路径，通过全部门槛后直接激活。`,
      });
      await predictionModels.reload();
    } catch (caught) {
      const body =
        caught instanceof ApiError && caught.status === 422
          ? (caught.body as Partial<InsufficientPredictionLabelsResponse>)
          : null;
      const shortage =
        body?.code === "insufficient_labeled_outcomes"
          ? (body as InsufficientPredictionLabelsResponse)
          : undefined;
      setPredictionModelNotice({
        tone: "error",
        message: shortage
          ? `当前有 ${shortage.available}/${shortage.required} 条可用真实结果，尚不能训练。`
          : caught instanceof Error
            ? caught.message
            : "无法创建 CatBoost 训练任务",
        ...(shortage ? { shortage } : {}),
      });
    } finally {
      setPredictionModelBusy(false);
    }
  };
  const inspectPredictionModel = async (id: string) => {
    setPredictionModelBusy(true);
    setError(null);
    try {
      setSelectedPredictionModel(
        await api<PredictionModelDetailResponse>(`/v1/prediction-models/${id}`),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "无法读取预测模型详情",
      );
    } finally {
      setPredictionModelBusy(false);
    }
  };
  const cancelPredictionModel = async (id: string) => {
    setPredictionModelBusy(true);
    setPredictionModelNotice(null);
    setError(null);
    try {
      await api<{ cancelRequested: true }>(
        `/v1/prediction-models/${id}/cancel`,
        { method: "POST", body: "{}" },
      );
      setPredictionModelNotice({
        tone: "info",
        message:
          "已提交取消请求，当前阶段完成后停止训练；当前 active 模型不受影响。",
      });
      await predictionModels.reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "无法取消预测模型训练",
      );
    } finally {
      setPredictionModelBusy(false);
    }
  };
  const activatePredictionModel = async (id: string) => {
    setPredictionModelBusy(true);
    setPredictionModelNotice(null);
    setError(null);
    try {
      await api<{ activePredictionModelRunId: string }>(
        `/v1/prediction-models/${id}/activate`,
        { method: "POST", body: "{}" },
      );
      setPredictionModelNotice({
        tone: "success",
        message: "历史 CatBoost 模型已原子切换为当前预测模型。",
      });
      await predictionModels.reload();
      window.dispatchEvent(new Event("rai:data-updated"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法激活预测模型");
    } finally {
      setPredictionModelBusy(false);
    }
  };

  return (
    <div className="page data-page">
      <header className="page-header split">
        <div>
          <h1>数据与模型</h1>
          <p>管理 Apple Health 导入、任务队列与模型历史。</p>
        </div>
        {databaseReady ? (
          <Link to="/data/audit" className="button secondary">
            查看数据审计
          </Link>
        ) : (
          <span className="status-badge attention">等待首次导入</span>
        )}
      </header>
      {error ? <ErrorBlock message={error} /> : null}
      <section className="data-grid">
        <article className="panel import-panel import-update-panel">
          <div className="panel-heading">
            <div>
              <h2>更新健康数据</h2>
              <p>选择 Apple 健康导出的 ZIP，其余步骤由系统在本机完成。</p>
            </div>
            <FolderOpen size={22} />
          </div>
          {!importJob || ["failed", "cancelled", "succeeded"].includes(importJob.status) ? <>
          <input ref={fileInput} className="visually-hidden" type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void selectExport(file); event.target.value = ""; }} />
          <button className={`import-dropzone ${dragActive ? "active" : ""}`} type="button" disabled={busy || uploadProgress !== null} onClick={() => fileInput.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragActive(false)} onDrop={(event) => { event.preventDefault(); setDragActive(false); const file = event.dataTransfer.files[0]; if (file) void selectExport(file); }}>
            <span className="import-dropzone-icon"><UploadSimple size={24} /></span>
            <span><b>选择 Apple 健康导出 ZIP</b><small>也可以将文件拖到这里</small></span>
          </button>
          {uploadProgress !== null ? <div className="upload-progress" role="progressbar" aria-label="上传导出文件" aria-valuenow={uploadProgress} aria-valuemin={0} aria-valuemax={100}><span><b>正在接收导出文件</b><small>{uploadProgress}%</small></span><i><em style={{ width: `${uploadProgress}%` }} /></i></div> : null}
          {inspection ? <div className={`import-inspection ${inspection.status}`}>
            <div className="inspection-title"><FileZip size={20} /><span><b>{inspection.displayName ?? inspection.exportFileName}</b><small>{formatBytes(inspection.exportBytes)}{inspection.exportCreatedAt ? ` · ${date(inspection.exportCreatedAt, true)}` : ""}</small></span><StatusBadge value={inspection.status} /></div>
            <dl><div><dt>预计训练</dt><dd>{inspection.estimatedWorkoutCount?.toLocaleString("zh-CN") ?? "待导入确认"}</dd></div><div><dt>路线文件</dt><dd>{inspection.routeFileCount.toLocaleString("zh-CN")}</dd></div><div><dt>更新判断</dt><dd>{inspection.status === "unchanged" ? "没有变化" : inspection.status === "ready" ? "可以更新" : "无法导入"}</dd></div></dl>
            {inspection.warnings.length ? <ul>{inspection.warnings.map((warning, index) => <li key={typeof warning === "string" ? warning : warning.code ?? index}>{typeof warning === "string" ? warning : warning.message}</li>)}</ul> : null}
            <button className="button primary" disabled={busy || inspection.status !== "ready"} onClick={() => void startImport({ sourceId: inspection.sourceId })}>{inspection.status === "unchanged" ? "数据已是最新" : busy ? "正在开始" : "开始更新"}</button>
          </div> : null}
          {candidates.length ? <div className="discovered-sources"><span><b>发现本机导出</b><small>选择后先检查变化，不会自动更新</small></span>{candidates.slice(0, 3).map((candidate) => <button key={candidate.id} type="button" disabled={busy} onClick={() => void inspectSource(candidate.sourceId ?? candidate.id)}><FolderOpen size={17} /><span><b>{candidate.displayName}</b><small>{candidate.exportBytes || candidate.sizeBytes ? formatBytes(candidate.exportBytes ?? candidate.sizeBytes ?? 0) : candidate.originalPath ?? candidate.inputPath ?? candidate.path ?? "Apple 健康导出"}</small></span></button>)}</div> : null}
          <details className="advanced-import"><summary>高级：从已解压目录导入</summary><label className="field"><span>导出目录</span><input value={path} placeholder="例如 D:\\健康数据\\apple_health_export" onChange={(event) => setPath(event.target.value)} /></label><button className="button secondary" disabled={!path.trim() || busy} onClick={() => void startImport({ inputPath: path.trim(), confirmReplace: true })}>从目录更新</button></details>
          </> : null}
          {importJob ? (
            <div className={`import-job-view ${importJob.status}`}
            >
            <div
              className="import-status"
              role={importJob.error ? "alert" : "status"}
              aria-live={importJob.error ? "assertive" : "polite"}
            >
              <StatusBadge value={importJob.status} />
              <div>
                <b>
                  {importPollError ? "正在重新连接导入任务" : importJob.message}
                </b>
                <small>{importPollError ?? importJob.phase}</small>
                {importJob.error ? <p>{importJob.error}</p> : null}
              </div>
            </div>
            {["queued", "running"].includes(importJob.status) ? <div className="import-stage-progress"><i><em style={{ width: `${Math.max(4, Math.min(100, importJob.progress ?? 8))}%` }} /></i><ol>{["检查与备份", "读取健康数据", "更新分析结果", "安全切换"].map((stage, index) => <li key={stage} className={(importJob.progress ?? 0) >= index * 25 ? "active" : ""}>{stage}</li>)}</ol></div> : null}
            {importJob.status === "succeeded" && importJob.summary ? <div className="import-result"><h3>更新完成</h3><dl><div><dt>新增跑步</dt><dd>{importJob.summary.insertedWorkouts}</dd></div><div><dt>更新跑步</dt><dd>{importJob.summary.updatedWorkouts}</dd></div><div><dt>移除跑步</dt><dd>{importJob.summary.removedWorkouts}</dd></div><div><dt>复用特征</dt><dd>{importJob.summary.featuresReused}</dd></div></dl><small>{importJob.summary.importMode === "incremental" ? "已使用增量更新" : importJob.summary.importMode === "unchanged" ? "数据没有变化" : "已完成完整更新"}</small></div> : null}
            {!["queued", "running"].includes(importJob.status) ? <button className="text-button import-another" onClick={() => setImportJob(null)}>选择另一份导出</button> : null}
            </div>
          ) : null}
        </article>
        <article className="panel privacy-panel">
          <ShieldCheck size={30} />
          <h2>健康数据留在本机</h2>
          <p>API 只监听 127.0.0.1。路线在浏览器本地渲染，不发送给地图服务。</p>
          <div>
            <span>
              <CheckCircle size={16} />
              SQLite 本地存储
            </span>
            <span>
              <CheckCircle size={16} />
              不可变模型运行
            </span>
            <span>
              <CheckCircle size={16} />
              原始路线不外传
            </span>
          </div>
        </article>
      </section>

      <section className="panel model-panel">
        <div className="panel-heading">
          <div>
            <h2>模型历史</h2>
            <p>成功运行保持不可变，active 指针决定当前展示结果。</p>
          </div>
          <button
            className="button secondary"
            disabled={busy || !databaseReady}
            onClick={() => void recompute()}
          >
            <ArrowClockwise size={16} />
            完整重算
          </button>
        </div>
        {!databaseReady ? (
          <EmptyBlock
            title="首次导入后生成模型"
            body="导入成功后会自动完成特征提取与模型回放，并在这里显示不可变运行历史。"
          />
        ) : models.loading ? (
          <LoadingBlock />
        ) : models.error || !models.data ? (
          <ErrorBlock message={models.error ?? "没有模型运行"} />
        ) : (
          <div className="model-list">
            {models.data.map((model) => (
              <div key={model.id} className={model.active ? "active" : ""}>
                <Database size={18} />
                <span>
                  <b>{model.modelVersion}</b>
                  <small>
                    {date(model.createdAt, true)} · {model.assessmentCount} 评分
                    · {model.snapshotCount} 日快照
                  </small>
                </span>
                <code>{model.modelConfigHash.slice(0, 10)}</code>
                <StatusBadge value={model.status} />
                {model.active ? (
                  <em>当前</em>
                ) : model.status === "succeeded" ? (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void activate(model.id)}
                  >
                    设为当前
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel comparison-panel">
        <div className="panel-heading">
          <div>
            <h2>模型运行对照</h2>
            <p>
              候选值减基线值；只比较两个 Run 都包含的同一 Training Session。
            </p>
          </div>
        </div>
        <div className="comparison-controls">
          <label className="field">
            <span>基线 Run</span>
            <select
              disabled={!databaseReady}
              value={baseRunId}
              onChange={(event) => {
                comparisonRequestId.current += 1;
                setComparisonBusy(false);
                setBaseRunId(event.target.value);
                setComparison(null);
              }}
            >
              <option value="">请选择</option>
              {models.data
                ?.filter((model) => model.status === "succeeded")
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {date(model.createdAt, true)} ·{" "}
                    {model.modelConfigHash.slice(0, 8)}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>候选 Run</span>
            <select
              disabled={!databaseReady}
              value={candidateRunId}
              onChange={(event) => {
                comparisonRequestId.current += 1;
                setComparisonBusy(false);
                setCandidateRunId(event.target.value);
                setComparison(null);
              }}
            >
              <option value="">请选择</option>
              {models.data
                ?.filter((model) => model.status === "succeeded")
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.active ? "当前 · " : ""}
                    {date(model.createdAt, true)} ·{" "}
                    {model.modelConfigHash.slice(0, 8)}
                  </option>
                ))}
            </select>
          </label>
          <button
            className="button secondary"
            disabled={comparisonBusy || !databaseReady || !baseRunId || !candidateRunId}
            onClick={() => void compare()}
          >
            运行对照
          </button>
        </div>
        {comparison ? (
          <>
            <div className="comparison-metrics">
              <span>
                <small>共同训练</small>
                <b>{comparison.metrics.matchedSessions}</b>
              </span>
              <span>
                <small>平均 CA 差</small>
                <b>
                  {comparison.metrics.currentAbilityMeanDelta === null
                    ? "--"
                    : `${comparison.metrics.currentAbilityMeanDelta >= 0 ? "+" : ""}${comparison.metrics.currentAbilityMeanDelta.toFixed(3)}`}
                </b>
              </span>
              <span>
                <small>平均绝对 CA 差</small>
                <b>
                  {comparison.metrics.currentAbilityMeanAbsoluteDelta?.toFixed(
                    3,
                  ) ?? "--"}
                </b>
              </span>
              <span>
                <small>最终 TA 差</small>
                <b>
                  {comparison.metrics.finalTrueAbilityDelta === null
                    ? "--"
                    : `${comparison.metrics.finalTrueAbilityDelta >= 0 ? "+" : ""}${comparison.metrics.finalTrueAbilityDelta.toFixed(3)}`}
                </b>
              </span>
              <span>
                <small>置信度平均差</small>
                <b>
                  {comparison.metrics.confidenceMeanDelta?.toFixed(4) ?? "--"}
                </b>
              </span>
              <span>
                <small>资格状态变化</small>
                <b>{comparison.metrics.assessmentStatusChanged}</b>
              </span>
            </div>
            {comparison.topChangedWorkouts.length ? (
              <div className="comparison-list">
                {comparison.topChangedWorkouts.map((workout) => (
                  <div key={workout.trainingSessionId}>
                    <span>
                      <b>{date(workout.startedAt)}</b>
                      <small>
                        {workout.baseCurrentAbility?.toFixed(2) ?? "--"} →{" "}
                        {workout.candidateCurrentAbility?.toFixed(2) ?? "--"}
                      </small>
                    </span>
                    <strong
                      className={
                        (workout.delta ?? 0) >= 0
                          ? "positive-text"
                          : "negative-text"
                      }
                    >
                      {workout.delta === null
                        ? "--"
                        : `${workout.delta >= 0 ? "+" : ""}${workout.delta.toFixed(3)}`}
                    </strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-inline">
                两个 Run 的逐次 CA 完全一致，或没有可共同比较的训练。
              </p>
            )}
          </>
        ) : (
          <p className="empty-inline">
            {databaseReady
              ? "选择两个成功的不可变 Run 进行量化对照。比较不会切换 active 模型。"
              : "首次导入完成后可比较不同模型运行。"}
          </p>
        )}
      </section>

      <section className="panel prediction-model-management">
        <div className="panel-heading">
          <div>
            <h2>成绩预测模型</h2>
            <p>
              使用真实比赛与标准测试标签训练 CatBoost
              残差模型；离线门槛全部通过后直接激活。
            </p>
          </div>
          <button
            className="button primary"
            aria-describedby="prediction-training-requirements prediction-training-state"
            disabled={
              !databaseReady ||
              predictionModelBusy ||
              Boolean(pendingPredictionRun)
            }
            onClick={() => void trainPredictionModel()}
          >
            <ArrowClockwise size={16} />
            {predictionModelBusy
              ? "正在提交训练"
              : pendingPredictionRun
                ? "训练正在进行"
                : "训练并自动激活"}
          </button>
        </div>
        <div
          className={`prediction-model-current ${activePredictionRun ? "active" : "fallback"}`}
          id="prediction-training-state"
          role="status"
          aria-live="polite"
        >
          <span>
            <small>当前预测路径</small>
            <b>{activePredictionRun ? "CatBoost 已激活" : "公式基线"}</b>
          </span>
          <span>
            <small>切换规则</small>
            <b>
              {pendingPredictionRun
                ? "验证中，保持当前结果"
                : "验证通过后原子激活"}
            </b>
          </span>
          <span>
            <small>当前 Run</small>
            <b title={activePredictionRun?.id}>
              {activePredictionRun?.id.slice(0, 14) ?? "无 active 模型"}
            </b>
          </span>
        </div>
        <div
          className="prediction-model-policy"
          id="prediction-training-requirements"
        >
          <ShieldCheck size={18} />
          <p>
            <b>不会使用普通训练伪造标签。</b>至少需要 50 条真实结果，且
            5K、10K、半马各不少于 8 条。训练或验证失败不会替换当前模型；没有
            active 模型时继续使用可解释的公式基线。
          </p>
        </div>
        {predictionModelNotice ? (
          <div
            className={`prediction-model-notice ${predictionModelNotice.tone}`}
            role={predictionModelNotice.tone === "error" ? "alert" : "status"}
            aria-live={
              predictionModelNotice.tone === "error" ? "assertive" : "polite"
            }
          >
            <b>
              {predictionModelNotice.tone === "error"
                ? "暂时不能开始训练"
                : predictionModelNotice.tone === "success"
                  ? "模型切换完成"
                  : "训练状态更新"}
            </b>
            <p>{predictionModelNotice.message}</p>
            {predictionModelNotice.shortage ? (
              <dl aria-label="真实结果标签缺口">
                <div>
                  <dt>5K</dt>
                  <dd>
                    {predictionModelNotice.shortage.availableByDistance.five_k}/
                    {predictionModelNotice.shortage.requiredPerDistance}
                  </dd>
                </div>
                <div>
                  <dt>10K</dt>
                  <dd>
                    {predictionModelNotice.shortage.availableByDistance.ten_k}/
                    {predictionModelNotice.shortage.requiredPerDistance}
                  </dd>
                </div>
                <div>
                  <dt>半马</dt>
                  <dd>
                    {
                      predictionModelNotice.shortage.availableByDistance
                        .half_marathon
                    }
                    /{predictionModelNotice.shortage.requiredPerDistance}
                  </dd>
                </div>
              </dl>
            ) : null}
          </div>
        ) : null}
        {!databaseReady ? (
          <EmptyBlock
            title="首次导入后可训练"
            body="导入数据并标记标准测试或比赛结果后，才能建立个人残差模型。"
          />
        ) : predictionModels.loading ? (
          <LoadingBlock label="正在读取预测模型历史" />
        ) : predictionModels.error || !predictionModels.data ? (
          <ErrorBlock
            message={predictionModels.error ?? "无法读取预测模型"}
            onRetry={() => void predictionModels.reload()}
          />
        ) : predictionModels.data.runs.length === 0 ? (
          <EmptyBlock
            title="当前使用公式预测"
            body="尚无 CatBoost 模型。积累足够的真实比赛与标准测试标签后，可在这里训练；验证通过会直接激活。"
          />
        ) : (
          <div className="prediction-model-list">
            {predictionModels.data.runs.map((run) => (
              <article
                key={run.id}
                className={run.active ? "active" : ""}
                aria-current={run.active ? "true" : undefined}
              >
                <div className="prediction-model-identity">
                  <Database size={18} />
                  <span>
                    <b>{run.modelVersion}</b>
                    <small>
                      {date(run.createdAt, true)} · 特征{" "}
                      {run.featureSchemaVersion}
                    </small>
                  </span>
                </div>
                <div className="prediction-model-samples">
                  <span>
                    <small>标签 / 持出</small>
                    <b>
                      {run.labelCount} / {run.holdoutPredictionCount}
                    </b>
                  </span>
                  <span>
                    <small>5K · 10K · 半马</small>
                    <b>
                      {run.labelCountByDistance.five_k} ·{" "}
                      {run.labelCountByDistance.ten_k} ·{" "}
                      {run.labelCountByDistance.half_marathon}
                    </b>
                  </span>
                </div>
                <div
                  className={`prediction-model-score ${run.metrics && run.metrics.maeImprovement < 0 ? "negative" : ""}`}
                >
                  <small>walk-forward MAE 改善</small>
                  <b>
                    {run.metrics
                      ? `${(run.metrics.maeImprovement * 100).toFixed(1)}%`
                      : "--"}
                  </b>
                  <small>
                    {run.metrics
                      ? `${Math.round(run.metrics.baselineMaeSeconds)}s → ${Math.round(run.metrics.modelMaeSeconds)}s`
                      : "等待验证"}
                  </small>
                </div>
                <StatusBadge value={run.status} />
                <div className="prediction-model-actions">
                  <button
                    className="text-button"
                    disabled={predictionModelBusy}
                    aria-expanded={selectedPredictionModel?.run.id === run.id}
                    aria-controls="prediction-model-detail"
                    onClick={() => void inspectPredictionModel(run.id)}
                  >
                    详情
                  </button>
                  {["queued", "running", "validating"].includes(run.status) ? (
                    <button
                      className="text-button danger-text"
                      disabled={predictionModelBusy}
                      onClick={() => void cancelPredictionModel(run.id)}
                    >
                      取消训练
                    </button>
                  ) : !run.active && run.status === "succeeded" ? (
                    <button
                      className="text-button"
                      disabled={predictionModelBusy}
                      onClick={() => void activatePredictionModel(run.id)}
                    >
                      切换至此模型
                    </button>
                  ) : run.active ? (
                    <em>当前 active</em>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
        {selectedPredictionModel ? (
          <section
            className="prediction-model-detail"
            id="prediction-model-detail"
            aria-labelledby="prediction-model-detail-title"
          >
            <div>
              <h3 id="prediction-model-detail-title">CatBoost 运行详情</h3>
              <button
                className="icon-button"
                aria-label="关闭预测模型详情"
                onClick={() => setSelectedPredictionModel(null)}
              >
                ×
              </button>
            </div>
            <dl>
              <div>
                <dt>特征契约</dt>
                <dd>{selectedPredictionModel.run.featureSchemaVersion}</dd>
              </div>
              <div>
                <dt>训练数据截至</dt>
                <dd>
                  {date(
                    selectedPredictionModel.run.trainingDataThroughAt,
                    true,
                  )}
                </dd>
              </div>
              <div>
                <dt>Artifact SHA-256</dt>
                <dd>
                  {selectedPredictionModel.run.artifactSha256?.slice(0, 18) ??
                    "--"}
                </dd>
              </div>
              <div>
                <dt>覆盖率变化</dt>
                <dd>
                  {selectedPredictionModel.run.metrics
                    ? `${(selectedPredictionModel.run.metrics.intervalCoverageChange * 100).toFixed(1)} pp`
                    : "--"}
                </dd>
              </div>
            </dl>
            <ol aria-label="训练阶段事件">
              {selectedPredictionModel.events.map((event) => (
                <li key={event.id}>
                  <span>{event.phase}</span>
                  <b>
                    {event.progressCurrent}/{event.progressTotal}
                  </b>
                  <small>{event.message}</small>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </section>

      <section className="panel jobs-panel">
        <div className="panel-heading">
          <div>
            <h2>任务记录</h2>
            <p>导入、完整重算与快照刷新均按单 worker 串行执行。</p>
          </div>
        </div>
        {!databaseReady ? (
          <p className="empty-inline">
            首次导入任务提交后，进度会显示在这里和全局状态栏。
          </p>
        ) : jobs.loading ? (
          <LoadingBlock />
        ) : jobs.data ? (
          <>
            <div className="job-list">
              {jobs.data.slice(0, 12).map((job) => {
                const progress = job.progressTotal
                  ? Math.round((job.progressCurrent / job.progressTotal) * 100)
                  : 0;
                return (
                  <div key={job.id}>
                    <span>
                      <b>{job.jobType}</b>
                      <small>{date(job.createdAt, true)}</small>
                    </span>
                    <span className="job-progress">
                      <i
                        role="progressbar"
                        aria-label={`${job.jobType}进度`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress}
                      >
                        <em style={{ width: `${progress}%` }} />
                      </i>
                      <small>
                        {job.progressPhase} · {job.progressCurrent}/
                        {job.progressTotal}
                      </small>
                    </span>
                    <StatusBadge value={job.status} />
                    <span className="job-actions">
                      <button
                        className="text-button"
                        onClick={() => void inspectJob(job.id)}
                      >
                        详情
                      </button>
                      {["queued", "running"].includes(job.status) ? (
                        <button
                          className="text-button danger-text"
                          disabled={busy}
                          onClick={() => void cancelJob(job.id)}
                        >
                          取消
                        </button>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
            {selectedJob ? (
              <div className="job-detail">
                <div>
                  <h3>任务阶段</h3>
                  <button
                    className="icon-button"
                    aria-label="关闭任务详情"
                    onClick={() => setSelectedJob(null)}
                  >
                    ×
                  </button>
                </div>
                <dl>
                  <div>
                    <dt>任务</dt>
                    <dd>{selectedJob.jobType}</dd>
                  </div>
                  <div>
                    <dt>状态</dt>
                    <dd>{selectedJob.status}</dd>
                  </div>
                  <div>
                    <dt>Run</dt>
                    <dd>{selectedJob.modelRunId?.slice(0, 18) ?? "--"}</dd>
                  </div>
                </dl>
                {selectedJob.error ? (
                  <pre aria-label="任务错误详情">
                    {JSON.stringify(selectedJob.error, null, 2)}
                  </pre>
                ) : null}
                <ol>
                  {selectedJob.events?.map((event) => (
                    <li key={event.id}>
                      <span>{event.phase}</span>
                      <b>
                        {event.progressCurrent}/{event.progressTotal}
                      </b>
                      <small>{event.message}</small>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
