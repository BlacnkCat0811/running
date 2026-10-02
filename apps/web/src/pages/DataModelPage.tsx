import "../pixel-layout.css";
import "../data-reference.css";
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

import { ApiError, api, readApiToken } from "../api.js";
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
import { date, status as statusLabel } from "../format.js";
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
  displayName: string;
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

interface UncertainImportSubmission {
  sourceId: string;
  submittedAt: number;
}

function belongsToSubmission(job: EnhancedImportJob | null, submission: UncertainImportSubmission): boolean {
  return job?.sourceId === submission.sourceId &&
    Number.isFinite(Date.parse(job.createdAt)) &&
    Date.parse(job.createdAt) >= submission.submittedAt;
}

async function findSubmittedImportJob(
  submission: UncertainImportSubmission,
): Promise<EnhancedImportJob | null> {
  const activeJob = await api<EnhancedImportJob | null>("/v1/import-jobs/active");
  if (belongsToSubmission(activeJob, submission)) return activeJob;
  const latestJob = await api<EnhancedImportJob | null>("/v1/import-jobs/latest");
  return belongsToSubmission(latestJob, submission) ? latestJob : null;
}

function rememberImportJob(job: EnhancedImportJob): void {
  if (["queued", "running"].includes(job.status)) {
    localStorage.setItem(IMPORT_JOB_STORAGE_KEY, job.id);
  } else if (localStorage.getItem(IMPORT_JOB_STORAGE_KEY) === job.id) {
    localStorage.removeItem(IMPORT_JOB_STORAGE_KEY);
  }
}

function formatBytes(value: number) {
  if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

interface UploadExportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function uploadExport(
  file: File,
  onProgress: (value: number) => void,
  options: UploadExportOptions = {},
) {
  return new Promise<{ sourceId: string }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    // The response includes server-side ZIP validation and extraction, which can
    // legitimately take much longer than the local file transfer.
    const timeoutMs = options.timeoutMs ?? 0;
    let settled = false;
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    const succeed = (value: { sourceId: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => request.abort();
    request.open("POST", "/v1/imports/uploads");
    const token = readApiToken();
    if (token) request.setRequestHeader("authorization", `Bearer ${token}`);
    request.responseType = "json";
    request.timeout = timeoutMs;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => fail(new Error("上传中断，请检查本地 API 后重试"));
    request.ontimeout = () => {
      fail(new Error("上传超时，请检查本地 API 后重试"));
      request.abort();
    };
    request.onabort = () => fail(new Error("上传已取消"));
    request.onload = () => {
      const body = request.response as { sourceId?: string; message?: string } | null;
      if (request.status >= 200 && request.status < 300 && body?.sourceId) succeed({ sourceId: body.sourceId });
      else fail(new Error(body?.message ?? "无法接收导出文件"));
    };
    if (options.signal?.aborted) {
      fail(new Error("上传已取消"));
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    const data = new FormData();
    data.append("file", file);
    request.send(data);
  });
}

export function DataModelPage({ databaseReady }: { databaseReady: boolean }) {
  const models = useRemote<ModelRunSummary[]>("/v1/model-runs", databaseReady);
  const jobs = useRemote<RecomputeJobDto[]>("/v1/jobs", databaseReady, true);
  const predictionModels = useRemote<PredictionModelListResponse>(
    "/v1/prediction-models",
    databaseReady,
    true,
  );
  const [importJob, setImportJob] = useState<EnhancedImportJob | null>(null);
  const [importPollError, setImportPollError] = useState<string | null>(null);
  const [uncertainImportSubmission, setUncertainImportSubmission] =
    useState<UncertainImportSubmission | null>(null);
  const [inspection, setInspection] = useState<ImportInspection | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [importSourceBusy, setImportSourceBusy] = useState(false);
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
  const importSourceOperationId = useRef(0);
  const importSourceOperationActive = useRef(false);
  const importJobCoordinationId = useRef(0);
  const activeUploadController = useRef<AbortController | null>(null);
  const pendingUploadSourceId = useRef<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<RecomputeJobDto | null>(null);
  const [selectedJobPollError, setSelectedJobPollError] = useState<string | null>(null);
  const [selectedPredictionModel, setSelectedPredictionModel] =
    useState<PredictionModelDetailResponse | null>(null);
  const notifiedSuccessfulImports = useRef(new Set<string>());
  const observedActiveRecomputeJobs = useRef(new Set<string>());
  const notifiedPredictionRuns = useRef(new Set<string>());
  const [predictionModelBusy, setPredictionModelBusy] = useState(false);
  const [predictionModelNotice, setPredictionModelNotice] = useState<{
    tone: "info" | "success" | "error";
    message: string;
    shortage?: InsufficientPredictionLabelsResponse;
    runId?: string;
  } | null>(null);

  const discardPendingUpload = () => {
    const sourceId = pendingUploadSourceId.current;
    if (!sourceId) return;
    pendingUploadSourceId.current = null;
    void api(`/v1/import-sources/${sourceId}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => undefined);
  };

  useEffect(() => () => {
    importSourceOperationId.current += 1;
    importJobCoordinationId.current += 1;
    importSourceOperationActive.current = false;
    activeUploadController.current?.abort();
    activeUploadController.current = null;
    discardPendingUpload();
  }, []);

  const activePredictionRun =
    predictionModels.data?.runs.find((run) => run.active) ?? null;
  const pendingPredictionRun =
    predictionModels.data?.runs.find((run) =>
      ["queued", "running", "validating"].includes(run.status),
    ) ?? null;
  const importRecoveryUncertain = importJob === null && importPollError !== null;

  useEffect(() => {
    let stopped = false;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const coordinationId = importJobCoordinationId.current;
    const isCurrent = () =>
      !stopped && coordinationId === importJobCoordinationId.current;
    const adoptImportJob = (job: EnhancedImportJob) => {
      if (!isCurrent()) return;
      setImportJob(job);
      setImportPollError(null);
      if (["queued", "running"].includes(job.status)) {
        localStorage.setItem(IMPORT_JOB_STORAGE_KEY, job.id);
      } else if (localStorage.getItem(IMPORT_JOB_STORAGE_KEY) === job.id) {
        localStorage.removeItem(IMPORT_JOB_STORAGE_KEY);
      }
    };
    const scheduleRecovery = () => {
      if (!isCurrent() || recoveryTimer) return;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        void recoverImportJob();
      }, 1500);
    };
    async function recoverImportJob(): Promise<void> {
      const savedJobId = localStorage.getItem(IMPORT_JOB_STORAGE_KEY);
      let savedLookupUncertain = false;
      if (savedJobId) {
        try {
          const savedJob = await api<EnhancedImportJob>(`/v1/import-jobs/${savedJobId}`);
          if (!isCurrent() || localStorage.getItem(IMPORT_JOB_STORAGE_KEY) !== savedJobId) return;
          adoptImportJob(savedJob);
          return;
        } catch (caught) {
          if (caught instanceof ApiError && caught.status === 404) {
            if (!isCurrent()) return;
            if (localStorage.getItem(IMPORT_JOB_STORAGE_KEY) === savedJobId) {
              localStorage.removeItem(IMPORT_JOB_STORAGE_KEY);
            }
          } else {
            savedLookupUncertain = true;
            if (isCurrent()) {
              setImportPollError(
                caught instanceof Error ? caught.message : "无法恢复导入任务",
              );
            }
          }
        }
      }
      if (!isCurrent()) return;
      try {
        const activeJob = await api<EnhancedImportJob | null>("/v1/import-jobs/active");
        if (!isCurrent()) return;
        if (activeJob) {
          adoptImportJob(activeJob);
        } else if (savedLookupUncertain) {
          scheduleRecovery();
        } else {
          setImportPollError(null);
        }
      } catch (caught) {
        if (!isCurrent()) return;
        setImportPollError(
          caught instanceof Error ? caught.message : "无法恢复导入任务",
        );
        scheduleRecovery();
      }
    }
    void recoverImportJob();
    void api<{ sources: ImportSourceCandidate[] }>("/v1/import-sources/discover", { method: "POST", body: "{}" })
      .then((result) => setCandidates(result.sources ?? []))
      .catch(() => undefined);
    return () => {
      stopped = true;
      if (recoveryTimer) clearTimeout(recoveryTimer);
    };
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
          if (localStorage.getItem(IMPORT_JOB_STORAGE_KEY) === next.id) {
            localStorage.removeItem(IMPORT_JOB_STORAGE_KEY);
          }
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
    if (!uncertainImportSubmission) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const submission = uncertainImportSubmission;
    const sourceId = submission.sourceId;
    const poll = async () => {
      try {
        const activeJob = await findSubmittedImportJob(submission);
        if (stopped) return;
        if (activeJob?.sourceId === sourceId) {
          if (pendingUploadSourceId.current === sourceId) pendingUploadSourceId.current = null;
          setImportJob(activeJob);
          setInspection(null);
          setError(null);
          setImportPollError(null);
          setUncertainImportSubmission(null);
          rememberImportJob(activeJob);
          if (!["queued", "running"].includes(activeJob.status)) {
            void jobs.reload();
            void models.reload();
          }
          return;
        }
        if (activeJob) setError("另一个导入任务正在运行，本次提交未被接管");
        setImportPollError(null);
        setUncertainImportSubmission(null);
      } catch (caught) {
        if (stopped) return;
        setImportPollError(
          caught instanceof Error ? caught.message : "无法确认导入任务",
        );
        timer = setTimeout(() => { void poll(); }, 1500);
      }
    };
    timer = setTimeout(() => { void poll(); }, 1500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [uncertainImportSubmission, jobs.reload, models.reload]);

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

  useEffect(() => {
    if (
      !selectedPredictionModel ||
      !["queued", "running", "validating"].includes(selectedPredictionModel.run.status)
    ) return;
    const runId = selectedPredictionModel.run.id;
    let stopped = false;
    const refresh = async () => {
      try {
        const detail = await api<PredictionModelDetailResponse>(`/v1/prediction-models/${runId}`);
        if (!stopped) {
          setSelectedPredictionModel(detail);
          if (!["queued", "running", "validating"].includes(detail.run.status)) {
            void predictionModels.reload();
          }
        }
      } catch {
        // Keep the last successful detail visible; list/global polling reports failures.
      }
    };
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [predictionModels.reload, selectedPredictionModel?.run.id, selectedPredictionModel?.run.status]);

  useEffect(() => {
    const activeJobs = jobs.data?.filter((job) =>
      ["queued", "running"].includes(job.status),
    ) ?? [];
    if (activeJobs.length === 0) return;
    for (const job of activeJobs) observedActiveRecomputeJobs.current.add(job.id);
    const timer = setInterval(() => {
      void jobs.reload();
    }, 2000);
    return () => clearInterval(timer);
  }, [jobs.data, jobs.reload]);

  useEffect(() => {
    if (!selectedJob || !["queued", "running"].includes(selectedJob.status)) return;
    const selectedJobId = selectedJob.id;
    let stopped = false;
    const timer = setInterval(() => {
      void api<RecomputeJobDto>(`/v1/jobs/${selectedJobId}`)
        .then((next) => {
          if (stopped) return;
          setSelectedJob((current) => current?.id === selectedJobId ? next : current);
          setSelectedJobPollError(null);
          if (!["queued", "running"].includes(next.status)) void jobs.reload();
        })
        .catch((caught) => {
          if (!stopped) {
            setSelectedJobPollError(
              caught instanceof Error ? caught.message : "无法读取任务详情",
            );
          }
        });
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [jobs.reload, selectedJob?.id, selectedJob?.status]);

  useEffect(() => {
    if (!jobs.data) return;
    for (const job of jobs.data) {
      if (
        observedActiveRecomputeJobs.current.delete(job.id) &&
        ["succeeded", "failed", "cancelled"].includes(job.status)
      ) {
        notifyDataUpdated(job.id);
      }
    }
  }, [jobs.data]);

  useEffect(() => {
    const runId = predictionModelNotice?.runId;
    if (!runId) return;
    const run = predictionModels.data?.runs.find((candidate) => candidate.id === runId);
    if (!run) return;
    if (["queued", "running", "validating"].includes(run.status)) {
      setPredictionModelNotice((current) => current?.runId === runId ? {
        ...current,
        tone: "info",
        message: `训练任务 ${runId.slice(0, 12)} 当前${statusLabel(run.status)}。验证期间继续使用当前预测路径，通过全部门槛后直接激活。`,
      } : current);
      return;
    }
    const succeeded = run.status === "succeeded";
    if (succeeded && !notifiedPredictionRuns.current.has(run.id)) {
      notifiedPredictionRuns.current.add(run.id);
      notifyDataUpdated(run.id);
    }
    setPredictionModelNotice((current) => current?.runId === runId ? {
      tone: succeeded ? "success" : "error",
      message: succeeded
        ? `训练任务 ${runId.slice(0, 12)} 已通过验证${run.active ? "并激活" : ""}。`
        : `训练任务 ${runId.slice(0, 12)} ${statusLabel(run.status)}，当前 active 模型未受影响。`,
    } : current);
  }, [predictionModelNotice?.runId, predictionModels.data]);

  const beginImportSourceOperation = () => {
    if (importSourceOperationActive.current || importRecoveryUncertain) return null;
    discardPendingUpload();
    importSourceOperationActive.current = true;
    const operationId = ++importSourceOperationId.current;
    setImportSourceBusy(true);
    setInspection(null);
    setError(null);
    return operationId;
  };
  const finishImportSourceOperation = (operationId: number) => {
    if (operationId !== importSourceOperationId.current) return;
    importSourceOperationActive.current = false;
    setImportSourceBusy(false);
  };
  const requestInspection = async (sourceId: string, operationId: number) => {
    const next = await api<ImportInspection>("/v1/imports/inspect", {
      method: "POST",
      body: JSON.stringify({ sourceId }),
    });
    if (operationId === importSourceOperationId.current) setInspection(next);
  };
  const inspectSource = async (sourceId: string) => {
    const operationId = beginImportSourceOperation();
    if (operationId === null) return;
    try {
      await requestInspection(sourceId, operationId);
    } catch (caught) {
      if (operationId === importSourceOperationId.current) {
        setError(caught instanceof Error ? caught.message : "无法检查导出文件");
      }
    } finally {
      finishImportSourceOperation(operationId);
    }
  };
  const selectExport = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      importSourceOperationId.current += 1;
      importSourceOperationActive.current = false;
      activeUploadController.current?.abort();
      activeUploadController.current = null;
      setImportSourceBusy(false);
      setUploadProgress(null);
      setInspection(null);
      discardPendingUpload();
      setError("请选择 Apple 健康导出的 ZIP 文件");
      return;
    }
    const operationId = beginImportSourceOperation();
    if (operationId === null) return;
    const uploadController = new AbortController();
    activeUploadController.current = uploadController;
    setUploadProgress(0);
    let uploadedSourceId: string | null = null;
    try {
      const uploaded = await uploadExport(file, (progress) => {
        if (operationId === importSourceOperationId.current) setUploadProgress(progress);
      }, { signal: uploadController.signal });
      uploadedSourceId = uploaded.sourceId;
      pendingUploadSourceId.current = uploaded.sourceId;
      if (operationId !== importSourceOperationId.current) {
        discardPendingUpload();
        return;
      }
      setUploadProgress(100);
      await requestInspection(uploaded.sourceId, operationId);
    } catch (caught) {
      if (uploadedSourceId && pendingUploadSourceId.current === uploadedSourceId) {
        discardPendingUpload();
      }
      if (operationId === importSourceOperationId.current) {
        setError(caught instanceof Error ? caught.message : "上传失败");
      }
    } finally {
      if (activeUploadController.current === uploadController) activeUploadController.current = null;
      if (operationId === importSourceOperationId.current) setUploadProgress(null);
      finishImportSourceOperation(operationId);
    }
  };
  const startImport = async (sourceId: string) => {
    if (importSourceOperationActive.current || importRecoveryUncertain) return;
    const submission = { sourceId, submittedAt: Date.now() };
    const coordinationId = ++importJobCoordinationId.current;
    const isCurrent = () => coordinationId === importJobCoordinationId.current;
    setBusy(true);
    setError(null);
    setImportPollError(null);
    try {
      const job = await api<EnhancedImportJob>("/v1/import-jobs", {
          method: "POST",
          body: JSON.stringify({ sourceId }),
        });
      if (!isCurrent()) return;
      if (pendingUploadSourceId.current === sourceId) pendingUploadSourceId.current = null;
      setImportJob(job);
      setInspection(null);
      setUncertainImportSubmission(null);
      localStorage.setItem(IMPORT_JOB_STORAGE_KEY, job.id);
    } catch (caught) {
      const resultIsUncertain =
        !(caught instanceof ApiError) || caught.status >= 500;
      if (resultIsUncertain) {
        // Once submission may have reached the API, only the server can safely
        // decide when the upload input is no longer owned by a worker.
        if (pendingUploadSourceId.current === sourceId) pendingUploadSourceId.current = null;
        try {
          const activeJob = await findSubmittedImportJob(submission);
          if (!isCurrent()) return;
          if (activeJob?.sourceId === sourceId) {
            if (pendingUploadSourceId.current === sourceId) pendingUploadSourceId.current = null;
            setImportJob(activeJob);
            setInspection(null);
            setImportPollError(null);
            setUncertainImportSubmission(null);
            rememberImportJob(activeJob);
            if (!["queued", "running"].includes(activeJob.status)) {
              void jobs.reload();
              void models.reload();
            }
            return;
          }
        } catch (reconciliationError) {
          if (isCurrent()) {
            setError(caught instanceof Error ? caught.message : "导入失败");
            setImportPollError(
              reconciliationError instanceof Error
                ? reconciliationError.message
                : "无法确认导入任务",
            );
            setUncertainImportSubmission(submission);
          }
          return;
        }
      }
      if (isCurrent()) {
        setError(caught instanceof Error ? caught.message : "导入失败");
      }
    } finally {
      if (isCurrent()) setBusy(false);
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
      await models.reload();
      notifyDataUpdated(`model-run:${id}`);
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
    setSelectedJobPollError(null);
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
  /**
   * §12.12 训练范围。缺省人群：老行为不变；个人范围必须显式请求 ——
   * 它训练出来的是**一个人**的模型，激活判据（优于规则基线 5%）一个字不放宽。
   */
  const trainPredictionModel = async (scope: "population" | "personal" = "population") => {
    setPredictionModelBusy(true);
    setPredictionModelNotice(null);
    setError(null);
    try {
      const result = await api<TrainPredictionModelResponse>(
        "/v1/prediction-models/train",
        { method: "POST", body: JSON.stringify({ scope }) },
      );
      setPredictionModelNotice({
        tone: "info",
        message: `训练任务 ${result.runId.slice(0, 12)} 当前${statusLabel(result.status)}。验证期间继续使用当前预测路径，通过全部门槛后直接激活。`,
        runId: result.runId,
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
        // 这句话是既有行为，不因为新增个人范围而改写：缺什么就说什么。
        // 个人范围的建议另起一行渲染，读者不会把两件事混成一句。
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
        runId: id,
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
        <div className="header-title-with-icon">
          <Database size={54} />
          <div><h1>数据与模型</h1>
          <p>管理 Apple Health 导入、任务队列与模型历史。</p></div>
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
              <p>先上传并检查 Apple 健康导出的 ZIP，确认后再开始更新。</p>
            </div>
            <FolderOpen size={22} />
          </div>
          {importRecoveryUncertain ? (
            <div className="import-status" role="alert" aria-live="assertive">
              <StatusBadge value="running" />
              <div>
                <b>正在确认上次导入任务</b>
                <small>{importPollError}</small>
              </div>
            </div>
          ) : null}
          {!importJob || ["failed", "cancelled", "succeeded"].includes(importJob.status) ? <>
          <input ref={fileInput} className="visually-hidden" type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void selectExport(file); event.target.value = ""; }} />
          <button className={`import-dropzone ${dragActive ? "active" : ""}`} type="button" disabled={busy || importSourceBusy || importRecoveryUncertain} onClick={() => fileInput.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragActive(false)} onDrop={(event) => { event.preventDefault(); setDragActive(false); if (importRecoveryUncertain) return; const file = event.dataTransfer.files[0]; if (file) void selectExport(file); }}>
            <span className="import-dropzone-icon"><UploadSimple size={24} /></span>
            <span><b>选择 Apple 健康导出 ZIP</b><small>也可以将文件拖到这里</small></span>
          </button>
          {uploadProgress !== null ? <div className="upload-progress" role="progressbar" aria-label={uploadProgress >= 100 ? "正在校验并解压导出文件" : "上传导出文件"} aria-valuenow={uploadProgress} aria-valuemin={0} aria-valuemax={100}><span><b>{uploadProgress >= 100 ? "正在校验并解压导出文件" : "正在接收导出文件"}</b><small>{uploadProgress}%</small></span><i><em style={{ width: `${uploadProgress}%` }} /></i><button type="button" className="text-button" onClick={() => activeUploadController.current?.abort()}>取消上传</button></div> : null}
          {inspection ? <div className={`import-inspection ${inspection.status}`}>
            <div className="inspection-title"><FileZip size={20} /><span><b>{inspection.displayName ?? inspection.exportFileName}</b><small>{formatBytes(inspection.exportBytes)}{inspection.exportCreatedAt ? ` · ${date(inspection.exportCreatedAt, true)}` : ""}</small></span><StatusBadge value={inspection.status} /></div>
            <dl><div><dt>预计训练</dt><dd>{inspection.estimatedWorkoutCount?.toLocaleString("zh-CN") ?? "待导入确认"}</dd></div><div><dt>路线文件</dt><dd>{inspection.routeFileCount.toLocaleString("zh-CN")}</dd></div><div><dt>更新判断</dt><dd>{inspection.status === "unchanged" ? "没有变化" : inspection.status === "ready" ? "可以更新" : "无法导入"}</dd></div></dl>
            {inspection.warnings.length ? <ul>{inspection.warnings.map((warning, index) => <li key={typeof warning === "string" ? warning : warning.code ?? index}>{typeof warning === "string" ? warning : warning.message}</li>)}</ul> : null}
            <button className="button primary" disabled={busy || importSourceBusy || importRecoveryUncertain || inspection.status !== "ready"} onClick={() => void startImport(inspection.sourceId)}>{inspection.status === "unchanged" ? "数据已是最新" : busy ? "正在开始" : "开始更新"}</button>
          </div> : null}
          {candidates.length ? <div className="discovered-sources"><span><b>发现本机导出</b><small>选择后先检查变化，不会自动更新</small></span>{candidates.slice(0, 3).map((candidate) => <button key={candidate.id} type="button" disabled={busy || importSourceBusy || importRecoveryUncertain} onClick={() => void inspectSource(candidate.id)}><FolderOpen size={17} /><span><b>{candidate.displayName}</b><small>{candidate.exportBytes || candidate.sizeBytes ? formatBytes(candidate.exportBytes ?? candidate.sizeBytes ?? 0) : "Apple 健康导出"}</small></span></button>)}</div> : null}
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
                  <small
                    title={
                      model.engineVersion === null || model.engineVersion === undefined
                        ? "该模型运行写入时还没有引擎版本列，无法回填；不要拿当前引擎版本当作它的引擎"
                        : `产出该运行的引擎：${model.engineVersion}`
                    }
                  >
                    {date(model.createdAt, true)} · {model.assessmentCount} 评分
                    · {model.snapshotCount} 日快照
                    · 引擎 {model.engineVersion ?? "未知"}
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
                ? `${statusLabel(pendingPredictionRun.status)}，保持当前结果`
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
            {predictionModelNotice.shortage &&
            predictionModelNotice.shortage.scope !== "personal" ? (
              <button
                type="button"
                className="text-button"
                disabled={predictionModelBusy}
                onClick={() => void trainPredictionModel("personal")}
              >
                改用个人范围训练（≥24 条，每个距离 ≥4 条；激活判据不变）
              </button>
            ) : null}
          </div>
        ) : null}
        {!databaseReady ? (
          <EmptyBlock
            title="首次导入后可训练"
            body="导入数据并标记标准测试或比赛结果后，才能建立个人残差模型。"
          />
        ) : predictionModels.loading && !predictionModels.data ? (
          <LoadingBlock label="正在读取预测模型历史" />
        ) : !predictionModels.data ? (
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
          <>
          {predictionModels.error ? <p className="zone-setting-refresh-error" role="alert">预测模型历史自动刷新失败，当前保留上次成功加载的列表。<button type="button" className="text-button" onClick={() => void predictionModels.reload()}>重新加载</button></p> : null}
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
          </>
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
        ) : jobs.loading && !jobs.data ? (
          <LoadingBlock />
        ) : !jobs.data ? (
          <ErrorBlock
            message={jobs.error ?? "无法读取任务记录"}
            onRetry={() => void jobs.reload()}
          />
        ) : (
          <>
            {jobs.error ? (
              <p className="zone-setting-refresh-error" role="alert">
                任务记录自动刷新失败，当前保留上次成功加载的状态。
                <button type="button" className="text-button" onClick={() => void jobs.reload()}>
                  重新加载
                </button>
              </p>
            ) : null}
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
                    onClick={() => {
                      setSelectedJob(null);
                      setSelectedJobPollError(null);
                    }}
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
                {selectedJobPollError ? (
                  <p className="zone-setting-refresh-error" role="alert">
                    {selectedJobPollError}，正在自动重试。
                  </p>
                ) : null}
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
        )}
      </section>
    </div>
  );
}
