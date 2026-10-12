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
  default: {
    // 🔴 这个 default 今天不可达 —— 它守的是**将来**：给 `ImportDatabaseTask` 加了新 operation
    // 却忘了在这里加分支时，`result` 会保持 `undefined` 并被当作成功回传，
    // 调用方看到的是"没报错"，而不是"没执行"。下面这行 `never` 赋值让这种遗漏**编译不过**；
    // 万一有人用 `as` 绕过编译，运行期也会抛错而不是静默成功。
    const unsupported: never = task;
    throw new Error(`Unsupported import database task: ${JSON.stringify(unsupported)}`);
  }
}
parentPort?.postMessage(result);
