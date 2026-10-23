// 阶段 4 / T04 的子进程：在**真实发布事务**里执行 active 指针翻转 + 任务结算，
// 并在 COMMIT 之前 SIGKILL（kill 模式）或正常提交（commit 模式）。
//
// `RecomputeJobRepository.complete()` 通过 `withDatabaseTransaction` 结构化发现
// `withWriteTransaction`（生产里由 write-lease 的代理提供）。这里提供一个等价
// 代理，只把“COMMIT 之前”变成可注入的进程级屏障；SQL 与仓库调用都走生产实现。
import { RaiDatabase, RecomputeJobRepository, SqliteModelRunRepository } from "@rai/storage-sqlite";

const [databasePath, jobId, candidateRunId, mode] = process.argv.slice(2);
const store = await RaiDatabase.open(databasePath, { migrationPolicy: "refuse" });
try {
  const db = store.database;
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === "withWriteTransaction") {
        return (operation) => {
          target.exec("BEGIN IMMEDIATE");
          const value = operation();
          if (mode === "kill") {
            // 进程级崩溃屏障：不是 sleep/计时窗口，SQLite 必须把整个事务回滚。
            process.kill(process.pid, "SIGKILL");
            throw new Error("unreachable after SIGKILL");
          }
          target.exec("COMMIT");
          return value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const completed = new RecomputeJobRepository(proxy).complete(jobId, "completed", 1, 1, "phase4 T04", () => {
    new SqliteModelRunRepository(db).activateSucceeded(candidateRunId, "2026-10-23T06:30:00.000Z");
  });
  if (!completed) throw new Error("job was not running");
  process.stdout.write("committed\n");
} finally {
  try { store.close(); } catch { /* SIGKILL 模式不会走到这里 */ }
}
