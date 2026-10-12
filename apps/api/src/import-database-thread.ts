import { parentPort, workerData } from "node:worker_threads";
import { buildImportAudit, checkpointImportDatabase, databaseReadable, type ImportDatabaseTask } from "./import-database-tasks.js";
import { applyDataOnlyImport } from "./data-only-import.js";

const task = workerData as ImportDatabaseTask;
let result: unknown;
switch (task.operation) {
  case "verify": result = databaseReadable(task.path); break;
  case "audit": result = buildImportAudit(task.path); break;
  case "checkpoint": result = checkpointImportDatabase(task.path); break;
  case "data-only": result = await applyDataOnlyImport(task.input); break;
}
parentPort?.postMessage(result);
