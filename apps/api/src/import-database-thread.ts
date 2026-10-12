import { parentPort, workerData } from "node:worker_threads";
import { buildImportAudit, checkpointImportDatabase, databaseReadable, type ImportDatabaseTask } from "./import-database-tasks.js";

const task = workerData as ImportDatabaseTask;
let result: unknown;
switch (task.operation) {
  case "verify": result = databaseReadable(task.path); break;
  case "audit": result = buildImportAudit(task.path); break;
  case "checkpoint": result = checkpointImportDatabase(task.path); break;
}
parentPort?.postMessage(result);
