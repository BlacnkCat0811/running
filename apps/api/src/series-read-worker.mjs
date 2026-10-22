// `/series` 专属读 worker：把一次完整的 workoutSeries 组装放到独立线程，
// 主线程只做路由/序列化。worker 自己打开只读连接；所有结果都属于该连接的
// 同一读快照。数据库替换由主线程的 read lease 阻止，worker 在文件 inode
// 变化时由主线程重建。
import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { RaiReadStore } = await import("./data.ts");
const store = new RaiReadStore(workerData.path);

parentPort.postMessage({ type: "ready" });
parentPort.on("message", (message) => {
  if (message?.close === true) {
    store.close();
    process.exit(0);
  }
  try {
    const series = store.workoutSeries(String(message.id), Array.isArray(message.candidates) ? message.candidates : []);
    parentPort.postMessage({ requestId: message.requestId, series });
  } catch (error) {
    parentPort.postMessage({
      requestId: message.requestId,
      error: { kind: "business", message: String(error?.message ?? error) }
    });
  }
});
process.on("exit", () => { try { store.close(); } catch { /* already closed */ } });
