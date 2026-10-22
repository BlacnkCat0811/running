// 请求外统计重建 worker：只读连接，按消息计算一个 type 的最长时长/非规范时间戳。
// 结果由主线程按“调度时捕获的连接状态”核对后安装；worker 自己不猜测版本。
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const GLOB = "????-??-??T??:??:??.???Z";
const database = new DatabaseSync(workerData.path, { readOnly: true });
database.exec("PRAGMA busy_timeout = 5000");
const statement = database.prepare(
  `SELECT MAX(julianday(end_at) - julianday(start_at)) * 86400000.0 AS milliseconds,
          SUM(CASE WHEN start_at GLOB ? AND end_at GLOB ? THEN 0 ELSE 1 END) AS nonCanonical
     FROM health_records WHERE type = ?`
);

parentPort.on("message", (message) => {
  if (message?.close === true) {
    database.close();
    process.exit(0);
  }
  try {
    const row = statement.get(GLOB, GLOB, String(message.type));
    const value = row?.milliseconds;
    parentPort.postMessage({
      type: String(message.type),
      stats: {
        maxDurationMs: typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null,
        hasNonCanonicalTimestamps: Number(row?.nonCanonical ?? 0) > 0
      }
    });
  } catch (error) {
    parentPort.postMessage({ type: String(message.type), error: String(error?.message ?? error) });
  }
});
