import { parentPort, workerData } from "node:worker_threads";

import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/health-export-parser";

const databasePath = String((workerData as { databasePath: string }).databasePath);
const store = await RaiDatabase.open(databasePath);
try {
  const completed = new RaiApplicationService(store).runNextJob();
  parentPort?.postMessage({ ran: completed !== null, jobId: completed?.id ?? null });
} finally {
  store.close();
}
