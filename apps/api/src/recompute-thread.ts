import { parentPort, workerData } from "node:worker_threads";

import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";

const databasePath = String((workerData as { databasePath: string }).databasePath);
const store = await RaiDatabase.open(databasePath, { migrationPolicy: "refuse" });
let completed: ReturnType<RaiApplicationService["runNextJob"]> = null;
try {
  completed = new RaiApplicationService(store).runNextJob();
} finally {
  store.close();
}
parentPort?.postMessage({ ran: completed !== null, jobId: completed?.id ?? null });
