import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, useRemoteMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  useRemoteMock: vi.fn(),
}));

vi.mock("../src/api.js", () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly body: unknown) {
      super(message);
    }
  },
  api: apiMock,
}));
vi.mock("../src/hooks.js", () => ({ useRemote: useRemoteMock }));

import { ApiError } from "../src/api.js";
import { DataModelPage, uploadExport } from "../src/pages/DataModelPage.js";

const remote = (data: unknown) => ({
  data,
  dataPath: null,
  error: null,
  loading: false,
  reload: vi.fn().mockResolvedValue(true),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeXMLHttpRequest {
  static latest: FakeXMLHttpRequest;
  readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  timeout = 0;
  responseType: XMLHttpRequestResponseType = "";
  response: unknown = null;
  status = 0;
  aborted = false;
  onerror: ((event: ProgressEvent) => void) | null = null;
  ontimeout: ((event: ProgressEvent) => void) | null = null;
  onabort: ((event: ProgressEvent) => void) | null = null;
  onload: ((event: ProgressEvent) => void) | null = null;
  constructor() { FakeXMLHttpRequest.latest = this; }
  open() {}
  send() {}
  abort() {
    this.aborted = true;
    this.onabort?.(new ProgressEvent("abort"));
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DataModelPage recompute job details", () => {
  it("uses background refresh and exposes task-list failures", async () => {
    localStorage.clear();
    apiMock.mockReset();
    const reloadJobs = vi.fn().mockResolvedValue(false);
    useRemoteMock.mockImplementation((path: string, enabled?: boolean, backgroundRefresh?: boolean) => {
      if (path === "/v1/jobs") {
        expect(enabled).toBe(true);
        expect(backgroundRefresh).toBe(true);
        return { ...remote(null), error: "jobs offline", reload: reloadJobs };
      }
      if (path === "/v1/prediction-models") return remote({ runs: [] });
      return remote([]);
    });
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    expect(await screen.findByText("jobs offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(reloadJobs).toHaveBeenCalled();
  });

  it("keeps the cached task list visible while a background refresh is pending", async () => {
    localStorage.clear();
    apiMock.mockReset();
    const cachedJob = {
      id: "job-cached", jobType: "full_recompute", status: "succeeded",
      progressPhase: "complete", progressCurrent: 2, progressTotal: 2,
      cancelRequested: false, modelRunId: "model-cached", error: null,
      createdAt: "2026-07-18T00:00:00.000Z", startedAt: null,
      completedAt: "2026-07-18T00:01:00.000Z", events: [],
    };
    useRemoteMock.mockImplementation((path: string) => {
      if (path === "/v1/jobs") {
        return { ...remote([cachedJob]), loading: true, error: "refresh pending" };
      }
      if (path === "/v1/prediction-models") return remote({ runs: [] });
      return remote([]);
    });
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      throw new Error(`Unexpected API call: ${path}`);
    });

    const view = render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    expect(await screen.findByText("full_recompute")).toBeTruthy();
    expect(view.container.querySelector(".jobs-panel .loading-block")).toBeNull();
    expect(screen.getByText(/当前保留上次成功加载的状态/)).toBeTruthy();
  });

  it("refreshes an open running job through its terminal event", async () => {
    vi.useFakeTimers();
    localStorage.clear();
    apiMock.mockReset();
    const reloadJobs = vi.fn().mockResolvedValue(true);
    const runningJob = {
      id: "job-1",
      jobType: "full_recompute",
      status: "running",
      progressPhase: "assessments",
      progressCurrent: 1,
      progressTotal: 2,
      cancelRequested: false,
      modelRunId: null,
      error: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      startedAt: "2026-07-18T00:00:01.000Z",
      completedAt: null,
      events: [{ id: "event-1", phase: "assessments", progressCurrent: 1, progressTotal: 2, message: "First phase", createdAt: "2026-07-18T00:00:02.000Z" }],
    };
    const succeededJob = {
      ...runningJob,
      status: "succeeded",
      progressPhase: "complete",
      progressCurrent: 2,
      completedAt: "2026-07-18T00:00:05.000Z",
      events: [...runningJob.events, { id: "event-2", phase: "complete", progressCurrent: 2, progressTotal: 2, message: "Terminal event", createdAt: "2026-07-18T00:00:05.000Z" }],
    };
    const modelsRemote = remote([]);
    const jobsRemote = { ...remote([runningJob]), reload: reloadJobs };
    const predictionsRemote = remote({ runs: [] });
    useRemoteMock.mockImplementation((path: string) => {
      if (path === "/v1/model-runs") return modelsRemote;
      if (path === "/v1/jobs") return jobsRemote;
      if (path === "/v1/prediction-models") return predictionsRemote;
      throw new Error(`Unexpected remote path: ${path}`);
    });
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      if (path === "/v1/jobs/job-1") {
        const detailCalls = apiMock.mock.calls.filter(([calledPath]) => calledPath === path).length;
        return Promise.resolve(detailCalls === 1 ? runningJob : succeededJob);
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    const view = render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    const detailsButton = view.container.querySelector<HTMLButtonElement>(".job-list .text-button");
    expect(detailsButton).not.toBeNull();
    await act(async () => {
      fireEvent.click(detailsButton!);
      await Promise.resolve();
    });
    expect(view.container.querySelector(".job-detail")?.textContent).toContain("First phase");

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.querySelector(".job-detail")?.textContent).toContain("succeeded");
    expect(view.container.querySelector(".job-detail")?.textContent).toContain("Terminal event");
    expect(reloadJobs).toHaveBeenCalled();
  });

  it("clears a transient detail polling error after polling recovers", async () => {
    vi.useFakeTimers();
    localStorage.clear();
    apiMock.mockReset();
    const runningJob = {
      id: "job-1", jobType: "full_recompute", status: "running",
      progressPhase: "assessments", progressCurrent: 1, progressTotal: 2,
      cancelRequested: false, modelRunId: null, error: null,
      createdAt: "2026-07-18T00:00:00.000Z", startedAt: null, completedAt: null,
      events: [],
    };
    const succeededJob = { ...runningJob, status: "succeeded", progressCurrent: 2 };
    useRemoteMock.mockImplementation((path: string) => {
      if (path === "/v1/jobs") return remote([runningJob]);
      if (path === "/v1/prediction-models") return remote({ runs: [] });
      return remote([]);
    });
    let detailCalls = 0;
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      if (path === "/v1/jobs/job-1") {
        detailCalls += 1;
        if (detailCalls === 1) return Promise.resolve(runningJob);
        if (detailCalls === 2) return Promise.reject(new Error("temporary detail failure"));
        return Promise.resolve(succeededJob);
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    const view = render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    await act(async () => {
      fireEvent.click(view.container.querySelector<HTMLButtonElement>(".job-list .text-button")!);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain("temporary detail failure");

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.textContent).not.toContain("temporary detail failure");
  });
});

describe("DataModelPage prediction model details", () => {
  it("refreshes an open running prediction through its terminal event", async () => {
    vi.useFakeTimers();
    localStorage.clear();
    apiMock.mockReset();
    const reloadPredictions = vi.fn().mockResolvedValue(true);
    const runningRun = {
      id: "prediction-1",
      modelVersion: "catboost-v1",
      featureSchemaVersion: "features-v1",
      status: "running",
      active: false,
      createdAt: "2026-07-18T00:00:00.000Z",
      trainingDataThroughAt: "2026-07-17T00:00:00.000Z",
      artifactSha256: null,
      labelCount: 12,
      holdoutPredictionCount: 3,
      labelCountByDistance: { five_k: 4, ten_k: 4, half_marathon: 4 },
      metrics: null,
    };
    const succeededRun = { ...runningRun, status: "succeeded", artifactSha256: "abc123" };
    const runningDetail = {
      run: runningRun,
      events: [{ id: "event-1", phase: "training", progressCurrent: 1, progressTotal: 2, message: "Running", createdAt: runningRun.createdAt }],
    };
    const succeededDetail = {
      run: succeededRun,
      events: [...runningDetail.events, { id: "event-2", phase: "complete", progressCurrent: 2, progressTotal: 2, message: "Terminal event", createdAt: runningRun.createdAt }],
    };
    useRemoteMock.mockImplementation((path: string) => {
      if (path === "/v1/prediction-models") {
        return { ...remote({ runs: [runningRun] }), reload: reloadPredictions };
      }
      return remote([]);
    });
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      if (path === "/v1/prediction-models/prediction-1") {
        const calls = apiMock.mock.calls.filter(([calledPath]) => calledPath === path).length;
        return Promise.resolve(calls === 1 ? runningDetail : succeededDetail);
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    const view = render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "详情" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector(".prediction-model-detail")?.textContent).toContain("Running");

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.querySelector(".prediction-model-detail")?.textContent).toContain("Terminal event");
    expect(reloadPredictions).toHaveBeenCalled();
  });
});

describe("DataModelPage import source selection", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    apiMock.mockReset();
    useRemoteMock.mockImplementation((path: string) => {
      if (path === "/v1/prediction-models") return remote({ runs: [] });
      return remote([]);
    });
  });

  it("serializes source inspection so a pending result cannot be replaced", async () => {
    const inspection = deferred<Record<string, unknown>>();
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") {
        return Promise.resolve({
          sources: [
            { id: "source-a", displayName: "Export A", exportBytes: 1024 },
            { id: "source-b", displayName: "Export B", exportBytes: 2048 },
          ],
        });
      }
      if (path === "/v1/imports/inspect") return inspection.promise;
      throw new Error(`Unexpected API call: ${path} ${init?.method ?? "GET"}`);
    });

    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    const sourceA = await screen.findByRole("button", { name: /Export A/ });
    const sourceB = screen.getByRole("button", { name: /Export B/ });
    const zipPicker = screen.getByRole("button", { name: /选择 Apple 健康导出 ZIP/ });

    fireEvent.click(sourceA);

    await waitFor(() => {
      expect((sourceA as HTMLButtonElement).disabled).toBe(true);
      expect((sourceB as HTMLButtonElement).disabled).toBe(true);
      expect((zipPicker as HTMLButtonElement).disabled).toBe(true);
    });
    fireEvent.click(sourceB);
    expect(apiMock.mock.calls.filter(([path]) => path === "/v1/imports/inspect")).toHaveLength(1);

    inspection.resolve({
      sourceId: "source-a",
      status: "ready",
      displayName: "Inspected Export A",
      exportFileName: "export.zip",
      exportBytes: 1024,
      exportCreatedAt: null,
      sourceSha256: "hash-a",
      routeFileCount: 0,
      estimatedWorkoutCount: 7,
      previousImportAt: null,
      warnings: [],
    });

    expect(await screen.findByText("Inspected Export A")).toBeTruthy();
    expect((screen.getByRole("button", { name: "开始更新" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears a ready inspection when a non-ZIP file is selected", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") {
        return Promise.resolve({ sources: [{ id: "source-a", displayName: "Export A" }] });
      }
      if (path === "/v1/imports/inspect") {
        return Promise.resolve({
          sourceId: "source-a",
          status: "ready",
          displayName: "Inspected Export A",
          exportFileName: "export.zip",
          exportBytes: 1024,
          exportCreatedAt: null,
          sourceSha256: "hash-a",
          routeFileCount: 0,
          estimatedWorkoutCount: 7,
          previousImportAt: null,
          warnings: [],
        });
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Export A/ }));
    expect(await screen.findByText("Inspected Export A")).toBeTruthy();

    const dropzone = screen.getByRole("button", { name: /选择 Apple 健康导出 ZIP/ });
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(["xml"], "export.xml", { type: "text/xml" })] },
    });

    expect(await screen.findByText("请选择 Apple 健康导出的 ZIP 文件")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Inspected Export A")).toBeNull();
      expect(screen.queryByRole("button", { name: "开始更新" })).toBeNull();
    });
  });

  it("does not time out server-side extraction by default but supports an explicit timeout", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);

    const pending = uploadExport(new File(["zip"], "export.zip"), vi.fn());
    expect(FakeXMLHttpRequest.latest!.timeout).toBe(0);
    FakeXMLHttpRequest.latest!.status = 200;
    FakeXMLHttpRequest.latest!.response = { sourceId: "source-default" };
    FakeXMLHttpRequest.latest!.onload?.(new ProgressEvent("load"));
    await expect(pending).resolves.toEqual({ sourceId: "source-default" });

    const timedOut = uploadExport(new File(["zip"], "export.zip"), vi.fn(), { timeoutMs: 321 });
    expect(FakeXMLHttpRequest.latest!.timeout).toBe(321);
    FakeXMLHttpRequest.latest!.ontimeout?.(new ProgressEvent("timeout"));
    await expect(timedOut).rejects.toThrow("上传超时");
    expect(FakeXMLHttpRequest.latest!.aborted).toBe(true);

    const controller = new AbortController();
    const aborted = uploadExport(new File(["zip"], "export.zip"), vi.fn(), { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow("上传已取消");
  });

  it("re-enables every import source after an upload timeout", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") {
        return Promise.resolve({ sources: [{ id: "source-a", displayName: "Export A" }] });
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    const source = await screen.findByRole("button", { name: /Export A/ });
    const dropzone = screen.getByRole("button", { name: /选择 Apple 健康导出 ZIP/ });
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(["zip"], "export.zip", { type: "application/zip" })] },
    });

    await screen.findByRole("button", { name: "取消上传" });
    expect((source as HTMLButtonElement).disabled).toBe(true);
    expect((dropzone as HTMLButtonElement).disabled).toBe(true);
    FakeXMLHttpRequest.latest!.ontimeout?.(new ProgressEvent("timeout"));

    expect(await screen.findByText("上传超时，请检查本地 API 后重试")).toBeTruthy();
    await waitFor(() => {
      expect((source as HTMLButtonElement).disabled).toBe(false);
      expect((dropzone as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("deletes an uploaded source when the page is left before import starts", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      if (path === "/v1/imports/inspect") {
        return Promise.resolve({
          sourceId: "uploaded-source",
          status: "ready",
          displayName: "Uploaded Export",
          exportFileName: "export.zip",
          exportBytes: 3,
          exportCreatedAt: null,
          sourceSha256: "hash",
          routeFileCount: 0,
          estimatedWorkoutCount: 1,
          previousImportAt: null,
          warnings: [],
        });
      }
      if (path === "/v1/import-sources/uploaded-source" && init?.method === "DELETE") {
        return Promise.resolve({ deleted: true });
      }
      throw new Error(`Unexpected API call: ${path} ${init?.method ?? "GET"}`);
    });

    const view = render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    fireEvent.drop(screen.getByRole("button", { name: /选择 Apple 健康导出 ZIP/ }), {
      dataTransfer: { files: [new File(["zip"], "export.zip", { type: "application/zip" })] },
    });
    FakeXMLHttpRequest.latest!.status = 200;
    FakeXMLHttpRequest.latest!.response = { sourceId: "uploaded-source" };
    FakeXMLHttpRequest.latest!.onload?.(new ProgressEvent("load"));

    expect(await screen.findByText("Uploaded Export")).toBeTruthy();
    view.unmount();

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/v1/import-sources/uploaded-source",
        expect.objectContaining({ method: "DELETE", keepalive: true }),
      );
    });
  });

  it("does not let another mounted page delete a live upload", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    let deleteAttempts = 0;
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      if (path === "/v1/imports/inspect") {
        return Promise.resolve({
          sourceId: "leased-source", status: "ready", displayName: "Leased Export",
          exportFileName: "export.zip", exportBytes: 3, exportCreatedAt: null,
          sourceSha256: "hash", routeFileCount: 0, estimatedWorkoutCount: 1,
          previousImportAt: null, warnings: [],
        });
      }
      if (path === "/v1/import-sources/leased-source" && init?.method === "DELETE") {
        deleteAttempts += 1;
        return Promise.resolve({ deleted: true });
      }
      throw new Error(`Unexpected API call: ${path} ${init?.method ?? "GET"}`);
    });

    const first = render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    fireEvent.drop(screen.getByRole("button", { name: /选择 Apple 健康导出 ZIP/ }), {
      dataTransfer: { files: [new File(["zip"], "export.zip", { type: "application/zip" })] },
    });
    FakeXMLHttpRequest.latest!.status = 200;
    FakeXMLHttpRequest.latest!.response = { sourceId: "leased-source" };
    FakeXMLHttpRequest.latest!.onload?.(new ProgressEvent("load"));
    expect(await screen.findByText("Leased Export")).toBeTruthy();

    const second = render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    expect(deleteAttempts).toBe(0);

    second.unmount();
    first.unmount();
    await waitFor(() => expect(deleteAttempts).toBe(1));
  });

  it("transfers an uploaded source to a matching reconciled import job", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    let activeRequests = 0;
    let deleteAttempts = 0;
    const activeJob = {
      id: "reconciled-upload-job", sourceId: "reconciled-upload", status: "running",
      phase: "import", message: "Reconciled uploaded import",
      createdAt: new Date(Date.now() + 1_000).toISOString(), completedAt: null, error: null, progress: 10,
    };
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/import-jobs/active") {
        activeRequests += 1;
        return Promise.resolve(activeRequests === 1 ? null : activeJob);
      }
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      if (path === "/v1/imports/inspect") {
        return Promise.resolve({
          sourceId: "reconciled-upload", status: "ready", displayName: "Uploaded Export",
          exportFileName: "export.zip", exportBytes: 3, exportCreatedAt: null,
          sourceSha256: "hash", routeFileCount: 0, estimatedWorkoutCount: 1,
          previousImportAt: null, warnings: [],
        });
      }
      if (path === "/v1/import-jobs" && init?.method === "POST") {
        return Promise.reject(new Error("connection reset after submit"));
      }
      if (path === "/v1/import-sources/reconciled-upload" && init?.method === "DELETE") {
        deleteAttempts += 1;
        return Promise.resolve({ deleted: true });
      }
      throw new Error(`Unexpected API call: ${path} ${init?.method ?? "GET"}`);
    });

    const page = render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    fireEvent.drop(screen.getByRole("button", { name: /选择 Apple 健康导出 ZIP/ }), {
      dataTransfer: { files: [new File(["zip"], "export.zip", { type: "application/zip" })] },
    });
    FakeXMLHttpRequest.latest!.status = 200;
    FakeXMLHttpRequest.latest!.response = { sourceId: "reconciled-upload" };
    FakeXMLHttpRequest.latest!.onload?.(new ProgressEvent("load"));
    fireEvent.click(await screen.findByRole("button", { name: "开始更新" }));

    expect(await screen.findByText("Reconciled uploaded import")).toBeTruthy();
    page.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(deleteAttempts).toBe(0);
  });

  it("recovers a saved import job through the active endpoint after a transient detail failure", async () => {
    localStorage.setItem("rai:active-import-job", "saved-job");
    const activeJob = {
      id: "saved-job",
      status: "running",
      phase: "import",
      message: "Recovered active import",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      completedAt: null,
      error: null,
      progress: 25,
    };
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/saved-job") {
        return Promise.reject(new Error("temporary detail failure"));
      }
      if (path === "/v1/import-jobs/active") return Promise.resolve(activeJob);
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);

    expect(await screen.findByText("Recovered active import")).toBeTruthy();
    expect(localStorage.getItem("rai:active-import-job")).toBe("saved-job");
    expect(apiMock).toHaveBeenCalledWith("/v1/import-jobs/active");
  });

  it("only forgets a saved import job after an explicit not-found response", async () => {
    localStorage.setItem("rai:active-import-job", "missing-job");
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/missing-job") {
        return Promise.reject(new ApiError("not found", 404, {}));
      }
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);

    await waitFor(() => {
      expect(localStorage.getItem("rai:active-import-job")).toBeNull();
    });
  });

  it("adopts the active job when import creation has an uncertain response", async () => {
    const activeJob = {
      id: "reconciled-job",
      sourceId: "source-a",
      status: "running",
      phase: "import",
      message: "Reconciled import",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      completedAt: null,
      error: null,
      progress: 10,
    };
    let activeRequests = 0;
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/import-jobs/active") {
        activeRequests += 1;
        return Promise.resolve(activeRequests === 1 ? null : activeJob);
      }
      if (path === "/v1/import-sources/discover") {
        return Promise.resolve({ sources: [{ id: "source-a", displayName: "Export A" }] });
      }
      if (path === "/v1/imports/inspect") {
        return Promise.resolve({
          sourceId: "source-a", status: "ready", displayName: "Export A",
          exportFileName: "export.zip", exportBytes: 1024, exportCreatedAt: null,
          sourceSha256: "hash", routeFileCount: 0, estimatedWorkoutCount: 1,
          previousImportAt: null, warnings: [],
        });
      }
      if (path === "/v1/import-jobs" && init?.method === "POST") {
        return Promise.reject(new Error("connection reset after submit"));
      }
      throw new Error(`Unexpected API call: ${path} ${init?.method ?? "GET"}`);
    });

    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Export A/ }));
    fireEvent.click(await screen.findByRole("button", { name: "开始更新" }));

    expect(await screen.findByText("Reconciled import")).toBeTruthy();
    expect(localStorage.getItem("rai:active-import-job")).toBe("reconciled-job");
    expect(screen.queryByText("connection reset after submit")).toBeNull();
  });

  it("adopts a quickly completed latest job when the create response is uncertain", async () => {
    const databaseStateChanged = vi.fn();
    const dataUpdated = vi.fn();
    window.addEventListener("rai:database-state-changed", databaseStateChanged);
    window.addEventListener("rai:data-updated", dataUpdated);
    const completedJob = {
      id: "completed-job",
      sourceId: "source-a",
      status: "succeeded",
      phase: "complete",
      message: "Import already completed",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      completedAt: new Date().toISOString(),
      error: null,
      progress: 100,
      summary: {
        importMode: "incremental",
        insertedWorkouts: 1,
        updatedWorkouts: 0,
        removedWorkouts: 0,
        featuresReused: 0,
      },
    };
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-jobs/latest") return Promise.resolve(completedJob);
      if (path === "/v1/import-sources/discover") {
        return Promise.resolve({ sources: [{ id: "source-a", displayName: "Export A" }] });
      }
      if (path === "/v1/imports/inspect") {
        return Promise.resolve({
          sourceId: "source-a", status: "ready", displayName: "Export A",
          exportFileName: "export.zip", exportBytes: 1024, exportCreatedAt: null,
          sourceSha256: "hash", routeFileCount: 0, estimatedWorkoutCount: 1,
          previousImportAt: null, warnings: [],
        });
      }
      if (path === "/v1/import-jobs" && init?.method === "POST") {
        return Promise.reject(new Error("connection reset after submit"));
      }
      throw new Error(`Unexpected API call: ${path} ${init?.method ?? "GET"}`);
    });

    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Export A/ }));
    fireEvent.click(await screen.findByRole("button", { name: "开始更新" }));

    expect(await screen.findByText("Import already completed")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith("/v1/import-jobs/latest");
    expect(localStorage.getItem("rai:active-import-job")).toBeNull();
    expect(screen.queryByText("connection reset after submit")).toBeNull();
    await waitFor(() => {
      expect(databaseStateChanged).toHaveBeenCalledOnce();
      expect(dataUpdated).toHaveBeenCalledOnce();
    });
    window.removeEventListener("rai:database-state-changed", databaseStateChanged);
    window.removeEventListener("rai:data-updated", dataUpdated);
  });

  it("does not adopt an older terminal job from the same source", async () => {
    const oldJob = {
      id: "previous-job",
      sourceId: "source-a",
      status: "succeeded",
      phase: "complete",
      message: "Previous import",
      createdAt: "2020-01-01T00:00:00.000Z",
      completedAt: "2020-01-01T00:01:00.000Z",
      error: null,
      progress: 100,
    };
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/import-jobs/active") return Promise.resolve(null);
      if (path === "/v1/import-jobs/latest") return Promise.resolve(oldJob);
      if (path === "/v1/import-sources/discover") {
        return Promise.resolve({ sources: [{ id: "source-a", displayName: "Export A" }] });
      }
      if (path === "/v1/imports/inspect") {
        return Promise.resolve({
          sourceId: "source-a", status: "ready", displayName: "Export A",
          exportFileName: "export.zip", exportBytes: 1024, exportCreatedAt: null,
          sourceSha256: "hash", routeFileCount: 0, estimatedWorkoutCount: 1,
          previousImportAt: null, warnings: [],
        });
      }
      if (path === "/v1/import-jobs" && init?.method === "POST") {
        return Promise.reject(new Error("connection reset before submit"));
      }
      throw new Error(`Unexpected API call: ${path} ${init?.method ?? "GET"}`);
    });

    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Export A/ }));
    fireEvent.click(await screen.findByRole("button", { name: "开始更新" }));

    expect(await screen.findByText("connection reset before submit")).toBeTruthy();
    expect(screen.queryByText("Previous import")).toBeNull();
    expect(localStorage.getItem("rai:active-import-job")).toBeNull();
  });

  it("does not let an unmounted recovery delete a newer page's import job", async () => {
    const oldLookup = deferred<Record<string, unknown>>();
    const newJob = {
      id: "new-job",
      status: "running",
      phase: "import",
      message: "New page import",
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      progress: 20,
    };
    localStorage.setItem("rai:active-import-job", "old-job");
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/old-job") return oldLookup.promise;
      if (path === "/v1/import-jobs/new-job") return Promise.resolve(newJob);
      if (path === "/v1/import-sources/discover") return Promise.resolve({ sources: [] });
      throw new Error(`Unexpected API call: ${path}`);
    });

    const oldPage = render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/v1/import-jobs/old-job"));
    oldPage.unmount();
    localStorage.setItem("rai:active-import-job", "new-job");
    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    expect(await screen.findByText("New page import")).toBeTruthy();

    await act(async () => {
      oldLookup.reject(new ApiError("not found", 404, {}));
      await Promise.resolve();
    });

    expect(localStorage.getItem("rai:active-import-job")).toBe("new-job");
  });

  it("shows and locks import controls while recovery status is uncertain", async () => {
    localStorage.setItem("rai:active-import-job", "uncertain-job");
    apiMock.mockImplementation((path: string) => {
      if (path === "/v1/import-jobs/uncertain-job") {
        return Promise.reject(new Error("job detail offline"));
      }
      if (path === "/v1/import-jobs/active") {
        return Promise.reject(new Error("active lookup offline"));
      }
      if (path === "/v1/import-sources/discover") {
        return Promise.resolve({ sources: [{ id: "source-a", displayName: "Export A" }] });
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);

    expect(await screen.findByText("正在确认上次导入任务")).toBeTruthy();
    expect(screen.getByText("active lookup offline")).toBeTruthy();
    expect((screen.getByRole("button", { name: /选择 Apple 健康导出 ZIP/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((await screen.findByRole("button", { name: /Export A/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiMock.mock.calls.some(([path]) => path === "/v1/imports/inspect")).toBe(false);
  });

  it("ignores an uncertain import reconciliation that completes after unmount", async () => {
    const activeLookup = deferred<Record<string, unknown>>();
    let activeRequests = 0;
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/import-jobs/active") {
        activeRequests += 1;
        return activeRequests === 1 ? Promise.resolve(null) : activeLookup.promise;
      }
      if (path === "/v1/import-sources/discover") {
        return Promise.resolve({ sources: [{ id: "source-a", displayName: "Export A" }] });
      }
      if (path === "/v1/imports/inspect") {
        return Promise.resolve({
          sourceId: "source-a", status: "ready", displayName: "Export A",
          exportFileName: "export.zip", exportBytes: 1024, exportCreatedAt: null,
          sourceSha256: "hash", routeFileCount: 0, estimatedWorkoutCount: 1,
          previousImportAt: null, warnings: [],
        });
      }
      if (path === "/v1/import-jobs" && init?.method === "POST") {
        return Promise.reject(new Error("connection reset after submit"));
      }
      throw new Error(`Unexpected API call: ${path} ${init?.method ?? "GET"}`);
    });

    const page = render(<MemoryRouter><DataModelPage databaseReady /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Export A/ }));
    fireEvent.click(await screen.findByRole("button", { name: "开始更新" }));
    await waitFor(() => expect(activeRequests).toBe(2));
    page.unmount();
    localStorage.setItem("rai:active-import-job", "new-job");

    await act(async () => {
      activeLookup.resolve({
        id: "old-job", status: "running", phase: "import", message: "Old import",
        createdAt: new Date().toISOString(), completedAt: null, error: null, progress: 10,
      });
      await Promise.resolve();
    });

    expect(localStorage.getItem("rai:active-import-job")).toBe("new-job");
  });
});
