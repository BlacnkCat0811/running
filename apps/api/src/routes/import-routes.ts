import type { ImportJobRequest } from "@rai/api-contracts";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { ImportArchiveTooLargeError, ImportSourceNotFoundError, type ImportSourceManager } from "../import-sources.js";
import { preflightDirectSyncPayload } from "../direct-sync-ingest.js";
import { laneRefusalFailure, type ImportWorker } from "../import-worker.js";
import type { MutationCoordinator } from "../mutation-coordinator.js";
import { identifierParamsSchema, importJobBodySchema, importSourceBodySchema } from "../schemas.js";

export function registerImportRoutes(app: FastifyInstance, dependencies: {
  importWorker: ImportWorker;
  importSources: ImportSourceManager;
  sourceMutations: MutationCoordinator;
  scopeSyncBatchId: (value: string) => string;
}): void {
  const { importWorker, importSources, sourceMutations, scopeSyncBatchId } = dependencies;
  app.post<{ Body: ImportJobRequest }>("/v1/import-jobs", { schema: { body: importJobBodySchema } }, async (request, reply) => {
    const release = sourceMutations.acquire("import source enqueue");
    try {
      const { sourceId } = request.body;
      const existing = importWorker.findBySourceId(sourceId);
      if (existing && ["queued", "running", "succeeded"].includes(existing.status)) return existing;
      const source = await importSources.get(sourceId);
      if (!source) return reply.code(404).send({ message: "未找到导入来源" });
      // Acceptance is durable before responding; execution takes the main write lease later.
      const job = importWorker.create(source.inputPath, undefined, sourceId, {
        kind: source.kind, displayName: source.displayName, originalPath: source.originalPath
      });
      return reply.code(202).send(job);
    } finally { release(); }
  });

  app.post<{ Params: { id: string } }>("/v1/import-jobs/:id/cancel", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
    const result = await importWorker.cancel(request.params.id);
    if (result === "not_found") return reply.code(404).send({ message: "未找到导入任务" });
    if (result === "terminal" || result === "publishing") return reply.code(409).send({ message: "任务已完成或正在发布，不能取消" });
    return { cancelRequested: result === "requested", status: result === "requested" ? "cancelling" : "cancelled" };
  });
  app.post("/v1/imports/uploads", async (request, reply) => {
    const rawBatchId = request.headers["x-rai-sync-batch"];
    if (
      rawBatchId !== undefined &&
      (typeof rawBatchId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rawBatchId))
    ) {
      return reply.code(400).send({ code: "invalid_sync_batch_id", message: "同步批次标识无效" });
    }
    const syncBatchId = typeof rawBatchId === "string" ? scopeSyncBatchId(rawBatchId) : null;
    const file = await request.file();
    if (!file) return reply.code(400).send({ message: "请选择 Apple 健康导出 ZIP" });
    if (file.mimetype !== "application/zip" && file.mimetype !== "application/x-zip-compressed" && !file.filename.toLowerCase().endsWith(".zip")) {
      return reply.code(415).send({ message: "只支持 ZIP 文件" });
    }
    const inspection = await importSources.saveUpload(
      file.file,
      file.filename,
      syncBatchId
    ).catch((error: unknown) => {
      if (file.file.truncated) throw new ImportArchiveTooLargeError("ZIP 文件超过大小限制");
      throw error;
    });
    if (file.file.truncated) {
      const existing = syncBatchId
        ? await importSources.get(inspection.sourceId)
        : null;
      if (existing?.idempotencyKey !== syncBatchId) {
        await importSources.cleanupUpload(inspection.sourceId);
      }
      throw new ImportArchiveTooLargeError("ZIP 文件超过大小限制");
    }
    const source = await importSources.get(inspection.sourceId);
    const sizeBytes = source && existsSync(source.originalPath)
      ? (await (await import("node:fs/promises")).stat(source.originalPath)).size
      : inspection.exportBytes;
    if (inspection.timings) {
      reply.header("Server-Timing", `receive;dur=${inspection.timings.receiveMs.toFixed(1)}, extract;dur=${inspection.timings.extractMs.toFixed(1)}, inspect;dur=${inspection.timings.inspectMs.toFixed(1)}`);
    }
    return {
      sourceId: inspection.sourceId,
      uploadId: inspection.sourceId,
      fileName: file.filename,
      sizeBytes,
      ...(inspection.timings ? { timings: inspection.timings } : {})
    };
  });

  app.post<{ Body: { sourceId: string } }>("/v1/imports/inspect", { schema: { body: importSourceBodySchema } }, async (request, reply) => {
    try {
      const inspection = await importSources.inspect(request.body.sourceId);
      // S3.1：直连**预检**（同步 400；不建 job、零副作用）。判据与 worker 兜底**同源**
      // （`preflightDirectSyncPayload`，单一来源）—— 超界/不合规的载荷在这里拿到稳定码 +
      // bounds/actual，客户端据此拆批；不再"悄悄降级"进整库备份通路（那条链路已删，S3.3）。
      const source = await importSources.get(request.body.sourceId);
      if (source) {
        const preflight = preflightDirectSyncPayload(source.inputPath);
        if (!preflight.ok) {
          const failure = laneRefusalFailure(preflight.rejection.reason);
          return reply.code(400).send({
            code: failure.code,
            message: failure.message,
            reason: preflight.rejection.reason,
            ...(preflight.rejection.actual === undefined ? {} : { actual: preflight.rejection.actual }),
            ...(preflight.rejection.bounds === undefined ? {} : { bounds: preflight.rejection.bounds }),
            sourceId: request.body.sourceId
          });
        }
      }
      return inspection;
    }
    catch (error) {
      if (error instanceof ImportSourceNotFoundError) return reply.code(404).send({ message: error.message });
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/v1/import-sources/:id",
    { schema: { params: identifierParamsSchema } },
    async (request, reply) => {
      const release = sourceMutations.acquire("import source cleanup");
      try {
        if (!await importSources.cleanupUpload(request.params.id, importWorker.activeInputPaths())) {
          return reply.code(404).send({ message: "未找到可清理的上传来源" });
        }
        return { deleted: true };
      } finally { release(); }
    }
  );

  app.post("/v1/import-sources/discover", async () => ({ sources: await importSources.discover() }));

  app.get("/v1/import-sources/recent", async () => ({ sources: await importSources.recent() }));

  app.get("/v1/import-jobs/active", async () => {
    return importWorker.active();
  });

  app.get("/v1/import-jobs/latest", async () => importWorker.latest());

  app.get<{ Params: { id: string } }>("/v1/import-jobs/:id", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
    const job = importWorker.get(request.params.id);
    if (!job) return reply.code(404).send({ message: "未找到导入任务" });
    return job;
  });

}
