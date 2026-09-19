import { dirname, resolve, sep } from "node:path";
import type { ImportJobResponse } from "@rai/api-contracts";
import { isHealthKitUploadSource, type ImportSourceManager } from "./import-sources.js";
import type { ImportWorker } from "./import-worker.js";
import type { MutationCoordinator } from "./mutation-coordinator.js";

/** Share the enqueue lock across the occupancy check and asynchronous removal. */
export async function finalizeImportSource(
  sources: ImportSourceManager,
  mutations: MutationCoordinator,
  worker: Pick<ImportWorker, "activeInputPaths">,
  job: ImportJobResponse,
  succeeded: boolean,
  durable: boolean
): Promise<void> {
  if (!durable || !job.sourceId) return;
  const release = await mutations.acquireWhenAvailable("terminal import source cleanup");
  try {
    const source = await sources.get(job.sourceId);
    if (!source) return;
    if (source.kind !== "upload") {
      if (succeeded) await sources.markUsed(job.sourceId);
      return;
    }
    const otherInputs = worker.activeInputPaths(job.id);
    const directory = dirname(resolve(source.originalPath));
    if (otherInputs.some((path) => {
      const input = resolve(path);
      return input === directory || input.startsWith(directory + sep);
    })) {
      // A retry was accepted before cleanup acquired the lock. Transfer source
      // ownership to it; retrying this cleanup would block that job behind us.
      return;
    }
    if (succeeded && isHealthKitUploadSource(source, source.inputPath)) {
      await sources.retainImportedUpload(job.sourceId);
    } else {
      await sources.cleanupUpload(job.sourceId, otherInputs);
    }
  } finally { release(); }
}
