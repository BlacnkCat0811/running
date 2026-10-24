// §14.2 A17 / A05 / §10.1 的**协议那一半**：真机等价 HTTP 验收。
//
// 为什么需要这个文件：A17 的通过条件里"文案/状态截图"是**人肉证据**，真机只能回答
// "界面确实显示了那句话"。但它底下那半是纯协议问题 —— raw COMMIT 之后客户端到底能拿到什么、
// 重放能不能拿回**原回执**、删除-only 会不会被当成 EOF、COMMIT 前后强杀分别留下什么。
// 这半个 A17 不需要 iPhone，只需要**真实进程 + 真实 HTTP + 真实 ZIP 上传**，所以在这里机械化。
//
// 与既有文件的边界（避免重复覆盖）：
//   · `direct-sync-handshake-capability.test.ts` —— 能力位与合同结构，本文件只用它做**前提**；
//   · `import-worker-direct-sync.test.ts` —— 进程内 `ImportWorker`（没有 HTTP、没有上传）；
//   · `direct-sync-prohibited-operations.test.ts` —— §14.1 的禁止操作清单。
// 本文件唯一走的是**真机的那条会话顺序**：上传 → inspect → import-jobs → 轮询终态 → 重放，
// 以及两个只有"真子进程"才能证明的时序场景（COMMIT 前强杀 / COMMIT 后丢回复）。
//
// ⚠️ 本文件**不**覆盖、也不得被引用为通过证据：
//   · §14.3 P01–P06 的性能口径（需要目标云机，本机给不了）；
//   · 真机上"界面显示的文案"（那是 A17 剩下的人肉一半）；
//   · iOS 侧的 `DirectSyncCursorPolicy`（本机没有 swiftc/Xcode，见文件末尾那条用例的说明）。
//
// ⚠️ 另一个刻意的边界：本文件**不**对 `/v1/backups` 相关行为做任何断言。同批有另一位写者
// 正在让备份入口退场（§11/A15），把判据钉在那里会让两边互相误伤。

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import type { HandshakeResponse, ImportJobResponse } from "@rai/api-contracts";
import {
  CONTRACT_VERSION, DATABASE_TIMEZONE, DIRECT_SYNC_ANALYSIS_REQUEST_MODE
} from "@rai/contracts";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

import type { ImportInspection } from "../src/import-sources.js";

import { posixOnlyReason } from "./posix-only.js";

const projectRoot = resolve(import.meta.dirname, "../../..");

/**
 * A05/F01 这条判据在 Windows 上做不出来，理由有两层，两层都是平台机制而不是计时抖动：
 *
 * 1. 判据本身要求「COMMIT 前的确定性屏障以 SIGKILL 结束进程」，然后逐表比对全回滚。
 *    Windows 没有 POSIX 信号：`child.kill("SIGKILL")` 由 libuv 映射成 `TerminateProcess`，
 *    `signalCode` 恒为 `null`、`exitCode` 变成 1（同文件 :397 的注释已写明这一点），
 *    所以「进程真的被 SIGKILL 掉了」这件事在 Windows 上没有读数。
 * 2. 更靠前：这条用例给子进程传了 `--import <绝对路径>`（见 `startServer` 里的
 *    `join(projectRoot, "apps/api/test/fixtures/pre-commit-barrier.mjs")`），
 *    ESM 加载器只接受 `file://` URL，Windows 盘符路径被当成协议 `d:` —— 子进程在屏障
 *    加载之前就以 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 退出（CI 2026-10-25 实测栈就是
 *    `throwIfUnsupportedESM_URLScheme` ← `apps/api/test/direct-sync-http-acceptance.test.ts`）。
 *    这一层是**测试夹具**的 Windows 不兼容（应改用 `pathToFileURL`），值得单独一张票；
 *    修好它之后仍会撞上第 1 层。
 */
const PRECOMMIT_SIGKILL_ONLY = posixOnlyReason(
  "Windows 上这条判据没有前提：COMMIT 前屏障要求以 SIGKILL 结束子进程（signalCode 恒为 null、"
  + "exitCode=1），且夹具的 `--import <盘符绝对路径>` 在 ESM 加载器里被当成协议 `d:`，"
  + "子进程在屏障加载前就以 ERR_UNSUPPORTED_ESM_URL_SCHEME 退出（CI 2026-10-25）。"
  + "因此『COMMIT 前强杀 ⇒ 删除与 GPX 同事务全回滚』没有被检查；SIGKILL 语义与夹具的 "
  + "file:// 拼写是另一个工作包。"
);

/** 轮询上界。真机上"同步"是长任务，但**验收**不该靠等：超时就是失败，且要说清等到哪一步。 */
const POLL_BUDGET_MS = 120_000;

// ---------------------------------------------------------------------------
// 载荷构造
// ---------------------------------------------------------------------------

/**
 * 强杀用例的载荷条数。
 *
 * 它取的是"写事务长到能在中间取到样本"与"留在直连上界内"之间的值：上界是直连 xml 的
 * 8 MiB（2026-10-14 由 2 MiB 放宽；此前与 record-only 快通路共用 `DATA_ONLY_MAX_XML_BYTES`，
 * 快通路至今仍为 2 MiB）。界内约束必须显式成立：越界时这些用例测的就不是写事务路径了
 * （收口前是静默回退候选链路，收口后是显式失败）——两种都会让报告看不出差别。
 *
 * 它对**丢回复**用例同样是必需的：从"回执落库"到"父进程把终态写出去"的窗口只有几十毫秒
 * （实测：小载荷 59 ms，4500 条约 140 ms），而 `child.kill()` 自身有一段不可控延迟。
 * 用小载荷时杀进去的时刻**大多数落在窗口之后** —— 那时重启读回的是父进程已经写好的终态，
 * 用例根本没走到"从持久回执恢复"那条路径（第一次实现就是这样，五跑四红）。所以两个用例共享这个尺寸。
 */
const KILL_FIXTURE_RECORDS = 4500;

/**
 * 4500 条**纯非评分记录**：没有 Workout ⇒ 本批在结构上碰不到分析。
 *
 * "COMMIT 前强杀 ⇒ 恰好提交一次"这条判据刻意用这个载荷：它把分析登记这条**正交**语义排除在外，
 * 于是"代次不许动"这类断言说的就是这一批自己的事。混进 Workout 之后那些断言仍然成立，
 * 但它们守的变成了另一条车道的行为 —— 判据不再只描述被测对象（实测踩过一次：加了 Workout 后
 * 「dependency 代次不许动」红在 1 !== 0，而那是**正确**的服务端行为）。
 */
function recordOnlyLargeFixtureXml(): string {
  return `<HealthData locale="en_US">${
    Array.from({ length: KILL_FIXTURE_RECORDS }, (_, index) => stepRecordXml(index)).join("")
  }</HealthData>`;
}

/** 同尺寸、但**带一个 Workout**：用于"丢回复"用例 —— 它要顺带证明恢复也没有重复登记分析任务。 */
function analysisLargeFixtureXml(): string {
  const workout = workoutExportXml().replace(/^<HealthData[^>]*>|<\/HealthData>\s*$/g, "");
  return recordOnlyLargeFixtureXml().replace("</HealthData>", `${workout}</HealthData>`);
}

/** A05 GPX 变体：同一个大载荷 + 一个**显式**引用 GPX 的 Workout；ZIP 里必须带上这份 GPX。 */
const KILL_GPX_ROUTE_RELATIVE_PATH = "workout-routes/route-kill.gpx";
const KILL_GPX_ROUTE_POINTS = 3;

/**
 * 3 个 trkpt 的最小合法 GPX（形状同 `phase3-import-matrix.test.ts` 的 T11 夹具）。
 *
 * 🔴 点数不是装饰：重启后的判据要同时钉住 `route_version_points` 与
 * `readable_route_points` 视图 = 3 —— 只写 0 点会让"版本已发布"与"点可读"
 * 这两件事分不开（视图本身还要求 `point_count > 0`）。
 */
const killRouteGpx = (): string =>
  `<gpx><trk><trkseg>${Array.from({ length: KILL_GPX_ROUTE_POINTS }, (_, index) =>
    `<trkpt lat="23.1${index}" lon="113.3${index}"><ele>12.5</ele>` +
    `<time>2026-01-02T08:00:0${index}Z</time></trkpt>`
  ).join("")}</trkseg></trk></gpx>`;

/**
 * 真机形态的 Workout + `<WorkoutRoute><FileReference .../></WorkoutRoute>`。
 *
 * 显式引用是这条用例的关键：只有 XML 点名了这条路线，GPX 文件才会被挂到这次
 * 训练上并走"版本发布"路径；只把 GPX 塞进 ZIP 而不引用，路线不会被读侧看见。
 */
const workoutWithRouteExportXml = (): string => `<HealthData locale="en_US">
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch"
    duration="30" durationUnit="min"
    startDate="2026-01-02 08:00:00 +0000" endDate="2026-01-02 08:30:00 +0000">
    <MetadataEntry key="RAIHealthKitWorkoutUUID" value="${WORKOUT_UUID}"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
    <WorkoutRoute><FileReference path="/${KILL_GPX_ROUTE_RELATIVE_PATH}"/></WorkoutRoute>
  </Workout>
</HealthData>`;

/** 4500 条记录 + 一个带显式 GPX 引用的 Workout：留在直连上界内，但写事务足够长。 */
function gpxLargeFixtureXml(): string {
  const workout = workoutWithRouteExportXml().replace(/^<HealthData[^>]*>|<\/HealthData>\s*$/g, "");
  return recordOnlyLargeFixtureXml().replace("</HealthData>", `${workout}</HealthData>`);
}

/** 夹具自带的上界自检：越界就不在"直连车道内的批"里（旧版静默回退，收口后显式失败），所以每次构造都验一遍。 */
function assertWithinDirectSyncBounds(xml: string): void {
  const bytes = Buffer.byteLength(xml, "utf8");
  assert.ok(bytes < 8 * 1024 * 1024, `夹具载荷必须留在直连上界内（8 MiB，2026-10-14 起），实际 ${bytes} 字节`);
  assert.ok(xml.split("<Record ").length - 1 <= 5000, "夹具载荷必须留在 5000 条上界之内");
}

const sampleUuid = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

/**
 * 每条记录必须有**自己的时刻**。
 *
 * 🔴 这不是为了好看：canonical id 的输入是 `[type, sourceName, startAt, endAt, value, unit]`
 * （`apple-health-parser.ts` 的 `buildRecord`）。所有记录共用同一个 `startDate` 时，
 * 它们会算出**同一个** canonical id —— 于是第二条记录会撞上
 * `UNIQUE constraint failed: rai_delta_record_writes.id`，看起来像服务端缺陷、其实是夹具造了
 * 一个真机上不可能存在的载荷（健康样本按定义各有时刻）。夹具必须造真机形态的数据。
 */
const sampleInstant = (index: number): string => {
  const moment = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 1000);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${moment.getUTCFullYear()}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())} ` +
    `${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())} +0000`;
};

const stepRecordXml = (index: number): string =>
  `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="10"` +
  ` startDate="${sampleInstant(index)}" endDate="${sampleInstant(index)}">` +
  `<MetadataEntry key="RAIHealthKitSampleUUID" value="${sampleUuid(index)}"/></Record>`;

const WORKOUT_UUID = "00000000-0000-4000-8000-0000000000aa";

const workoutExportXml = (): string => `<HealthData locale="en_US">
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch"
    duration="30" durationUnit="min"
    startDate="2026-01-02 08:00:00 +0000" endDate="2026-01-02 08:30:00 +0000">
    <MetadataEntry key="RAIHealthKitWorkoutUUID" value="${WORKOUT_UUID}"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
  </Workout>
</HealthData>`;

/**
 * 真机的 v2 清单。`sourceScope: "healthkit"` 是直连车道的前提之一
 * （§14.4 的"部分载荷"语义：缺省**不是**删除），也是 `resolvePreserveAbsent` 判 `preserveAbsent: true` 的依据。
 */
const syncManifest = (options: { deletedWorkoutIds?: string[]; deletedRecords?: Array<{ type: string; uuid: string }> } = {}): string =>
  JSON.stringify({
    version: 2,
    sourceScope: "healthkit",
    sourceIds: [],
    deletedSourceIds: options.deletedWorkoutIds ?? [],
    deletedRecords: options.deletedRecords ?? []
  });

// ---------------------------------------------------------------------------
// ZIP 构造（沿用 `stored-zip-contract.test.ts` 的最小写法：真 ZIP，不是假文件）
// ---------------------------------------------------------------------------

const u16 = (value: number): Buffer => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer; };
const u32 = (value: number): Buffer => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; };

function storedZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const nameData = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    // 先压缩、再用压缩后更小才采用（method 8 必须是 **raw** deflate；yauzl 拒绝 zlib 包装）。
    const compressed = deflateRawSync(entry.data);
    const useDeflate = compressed.length > 0 && compressed.length < entry.data.length;
    const stored = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(stored.length), u32(entry.data.length), u16(nameData.length), u16(0), nameData, stored
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(stored.length), u32(entry.data.length), u16(nameData.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(localOffset), nameData
    ]);
    locals.push(local);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0),
    u16(entries.length), u16(entries.length), u32(centralBytes.length), u32(localOffset), u16(0)
  ]);
  return Buffer.concat([...locals, centralBytes, end]);
}

/**
 * 一个真机会话上传的 ZIP 本体。
 *
 * ⚠️ 文件名里的 `apple-health-healthkit` 不是装饰：`isHealthKitUploadFilename` 认这个 token，
 * 而它决定"成功导入后保留上传件还是清掉"（`finalizeImportSource`）。名字变了，清理路径就变了，
 * 于是测试会在**别的地方**（重放时找不到来源）以看不懂的方式变红。
 */
function healthKitZip(
  xml: string,
  manifest: string,
  entries: ReadonlyArray<{ name: string; data: Buffer }> = []
): Buffer {
  return storedZip([
    { name: "export.xml", data: Buffer.from(xml, "utf8") },
    { name: "sync-manifest.json", data: Buffer.from(manifest, "utf8") },
    ...entries
  ]);
}

// ---------------------------------------------------------------------------
// 运行时夹具：隔离的 var/，绝不碰 var/rai.sqlite
// ---------------------------------------------------------------------------

interface Harness {
  root: string;
  databasePath: string;
  runtimeStatePath: string;
  /** 启动一个真 API 子进程并等它就绪。返回的 handle 用于 kill / 再次启动。 */
  start(options?: { preCommitBarrierMarker?: string }): Promise<ServerHandle>;
  /** 为了强杀之后的断言，夹具要能**不经过 HTTP** 读主库。 */
  readMain<T>(run: (db: DatabaseSync) => T): T;
  dispose(): void;
}

interface ServerHandle {
  readonly child: ChildProcess;
  readonly baseUrl: string;
  stop(): Promise<void>;
  output(): string;
}

function createHarness(prefix: string): Harness {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(root, "var/rai.sqlite");
  mkdirSync(join(root, "var"), { recursive: true });
  const runtimeStatePath = join(root, "var/runtime.sqlite");
  return {
    root,
    databasePath,
    runtimeStatePath,
    start: (options) => startServer(root, databasePath, options),
    readMain: (run) => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        // 收尾体检与仍在运行的服务端可能同时持有 WAL 连接；给只读探测一个
        // 有界等待，避免把"恰好撞上 checkpoint/清理写锁"误报成用例失败。
        db.exec("PRAGMA busy_timeout=5000");
        return run(db);
      } finally { db.close(); }
    },
    dispose: () => { removeTree(root); }
  };
}

/**
 * 主库的**基线身份**。
 *
 * 🔴 这一步不能省：直连车道要求 `dataset_version` + `import_completed_at` + 解析器合同/身份算法
 * 四项都在（`eligibleIdentity`），否则接收器**证明性地回退**（返回 null），任务就会掉进旧候选链路
 * ——旧链路的证据形态完全不同（备份、暂存副本、换库），本文件所有"零副作用"断言都会以看不懂的方式红。
 * 生产上这四个键由一次正常导入写下；这里用隔离库显式种上，等价于"手机上已经有过一次基线同步"。
 */
/** 让迁移真的跑一遍（表结构必须由**生产迁移**建立，不能由测试自己编 DDL）。 */
async function prepareDatabase(harness: Harness): Promise<void> {
  mkdirSync(join(harness.root, "var"), { recursive: true });
  const store = await RaiDatabase.open(harness.databasePath);
  store.close();
  // 迁移建好表之后再种基线身份：顺序反了会盖掉迁移写下的行。
  const db = new DatabaseSync(harness.databasePath);
  try {
    const put = db.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)");
    for (const [key, value] of [
      ["dataset_version", "baseline"],
      ["parser_contract_version", CONTRACT_VERSION],
      ["parser_identity_algorithm", identityAlgorithmFingerprint()],
      ["import_completed_at", "2026-01-01T00:00:00.000Z"]
    ] as const) put.run(key, value);
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// 真子进程
// ---------------------------------------------------------------------------

async function startServer(
  root: string, databasePath: string, options: { preCommitBarrierMarker?: string } = {}
): Promise<ServerHandle> {
  const args = ["--import", "tsx"];
  if (options.preCommitBarrierMarker !== undefined) {
    args.push("--import", join(projectRoot, "apps/api/test/fixtures/pre-commit-barrier.mjs"));
  }
  args.push("apps/api/src/server.ts");
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: root,
      RAI_DATABASE: databasePath,
      RAI_API_PORT: "0",
      RAI_LOG_LEVEL: "silent",
      RAI_API_TOKEN: "",
      RAI_SERVER_ID: "local",
      RAI_ATHLETE_ID: "athlete_1",
      RAI_DATASET_EPOCH: "default",
      ...(options.preCommitBarrierMarker === undefined ? {} : {
        RAI_PRECOMMIT_BARRIER_MARKER: options.preCommitBarrierMarker
      })
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const port = await waitForBoundPort(child, () => output);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForApi(child, baseUrl, () => output);
  return {
    child,
    baseUrl,
    output: () => output,
    stop: async () => { await stopServer(child, () => output); }
  };
}

async function waitForBoundPort(child: ChildProcess, output: () => string): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(output() || "API 没有上报绑定端口")), POLL_BUDGET_MS);
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      reject(new Error(output() || `API 启动即退出（exit ${code}）`));
    };
    child.once("exit", onExit);
    child.on("message", (message: unknown) => {
      const value = message as { type?: unknown; port?: unknown };
      if (value?.type === "rai:ready" && Number.isInteger(value.port)) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolvePort(value.port as number);
      }
    });
  });
}

async function waitForApi(child: ChildProcess, baseUrl: string, output: () => string): Promise<void> {
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output() || `API 退出（exit ${child.exitCode}）`);
    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) return;
    } catch { /* 还在启动。 */ }
    await delay(50);
  }
  throw new Error(output() || `API 在 ${POLL_BUDGET_MS} ms 内没有就绪`);
}

async function stopServer(child: ChildProcess, output: () => string): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
  child.kill();
  // Windows 上 close 事件可能因为 stdio 句柄拖着不来；超时后退化成强杀，别让清理卡住整条套件。
  await Promise.race([closed, delay(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  void output;
}

/** 硬杀。Windows 上 `SIGKILL` 由 libuv 映射成 `TerminateProcess`：无 handler、无 flush、无 finally。 */
function hardKill(handle: ServerHandle): void {
  handle.child.kill("SIGKILL");
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 目录清理要重试：刚刚强杀的子进程可能还攥着 `-wal` / `-shm` 句柄。 */
function removeTree(path: string): void {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch { /* 句柄还没释放。 */ }
  }
}

// ---------------------------------------------------------------------------
// HTTP 会话助手（就是真机走的那五步）
// ---------------------------------------------------------------------------

interface Session {
  readonly baseUrl: string;
  upload(zip: Buffer, batchId: string, fileName: string): Promise<UploadReceipt>;
  inspect(sourceId: string): Promise<ImportInspection>;
  createJob(sourceId: string): Promise<{ status: number; job: ImportJobResponse }>;
  job(jobId: string): Promise<ImportJobResponse | null>;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
}

interface UploadReceipt {
  sourceId: string;
  uploadId: string;
  fileName: string;
  sizeBytes: number;
}

function session(baseUrl: string): Session {
  const json = async <T>(response: Response): Promise<T> => {
    const text = await response.text();
    assert.ok(response.ok, `${response.url} 期望 2xx，实际 ${response.status}：${text}`);
    return JSON.parse(text) as T;
  };
  return {
    baseUrl,
    async upload(zip, batchId, fileName) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), fileName);
      const response = await fetch(`${baseUrl}/v1/imports/uploads`, {
        method: "POST", headers: { "x-rai-sync-batch": batchId }, body: form
      });
      return await json<UploadReceipt>(response);
    },
    async inspect(sourceId) {
      return await json<ImportInspection>(await fetch(`${baseUrl}/v1/imports/inspect`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId })
      }));
    },
    async createJob(sourceId) {
      const response = await fetch(`${baseUrl}/v1/import-jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId })
      });
      return { status: response.status, job: await json<ImportJobResponse>(response) };
    },
    async job(jobId) {
      const response = await fetch(`${baseUrl}/v1/import-jobs/${jobId}`);
      if (response.status === 404) return null;
      return await json<ImportJobResponse>(response);
    },
    get: (path) => fetch(`${baseUrl}${path}`),
    post: (path, body) => fetch(`${baseUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    })
  };
}

interface WaitOptions {
  /** 轮询上界。 */
  budgetMs?: number;
  /** 用于失败信息：这一次到底在等什么。 */
  what: string;
}

/**
 * 失败时要看得见**走到哪一步**，而不是只看到"导入失败"。
 *
 * 为什么必须带上阶段账本与子进程输出：直连车道拒收时会**证明性地回退**（接收器返回 null），
 * 而回退之后走的是完全不同的证据形态。只报 `status: "failed"` 的文件，红的时候没人能判断
 * 是"直连没接上"还是"这条用例本身写错了"——本仓已经为这种不可诊断的红付过代价。
 */
function describeJob(job: ImportJobResponse, serverOutput: () => string): string {
  const stages = Object.keys(job.performance?.stagesMs ?? {});
  return JSON.stringify({
    status: job.status,
    phase: job.phase,
    message: job.message,
    error: job.error,
    stages,
    summary: job.summary
  }, null, 2) + `\n--- API 子进程输出 ---\n${serverOutput().slice(-4000)}`;
}

/** 轮询到**终态**。没有固定 sleep：只有"还没到"与"超时即失败"。 */
async function waitForTerminal(
  api: Session, jobId: string, options: WaitOptions
): Promise<ImportJobResponse> {
  const deadline = Date.now() + (options.budgetMs ?? POLL_BUDGET_MS);
  let last: ImportJobResponse | null = null;
  while (Date.now() < deadline) {
    last = await api.job(jobId);
    if (last === null) throw new Error(`等待「${options.what}」时任务 ${jobId} 变成 404（运行时状态丢了）`);
    if (last.status === "succeeded" || last.status === "failed" || last.status === "cancelled") return last;
    await delay(25);
  }
  throw new Error(`等待「${options.what}」超时（${options.budgetMs ?? POLL_BUDGET_MS} ms）：` +
    `任务 ${jobId} 仍是 ${JSON.stringify({ status: last?.status, phase: last?.phase, message: last?.message })}`);
}

/** 轮询一个**非终态**的中间证据（例如"COMMIT 已经落库、父进程还没写完终态"）。 */
async function waitForCondition<T>(
  probe: () => T | null, options: WaitOptions & { intervalMs?: number; describe?: () => string }
): Promise<T> {
  const budget = options.budgetMs ?? POLL_BUDGET_MS;
  const deadline = Date.now() + budget;
  let lastProbeError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = probe();
      if (value !== null) return value;
      lastProbeError = null;
    } catch (error) { lastProbeError = error; }
    await delay(options.intervalMs ?? 5);
  }
  // 超时信息必须能自己回答"卡在哪一步"：只写"超时"会让人去猜服务端是不是真的没写。
  throw new Error(`等待「${options.what}」超时（${budget} ms）` +
    (options.describe === undefined ? "" : `；最后一次观测：${options.describe()}`) +
    (lastProbeError === null ? "" : `；最后一次探测报错：${String(lastProbeError)}`));
}

// ---------------------------------------------------------------------------
// 主库只读探测（强杀之后 HTTP 已经不可用，只能直接读文件）
// ---------------------------------------------------------------------------

interface MainFacts {
  healthRecords: number;
  workouts: number;
  trainingSessions: number;
  batches: string[];
  batchStatuses: Array<{ id: string; status: string }>;
  rawGeneration: number;
  dependencyGeneration: number;
  recomputeJobs: Array<{ id: string; jobType: string; status: string; dependency: number }>;
  receiptKeys: string[];
  importMode: string | null;
}

const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);

function readMainFacts(databasePath: string): MainFacts {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const receiptRow = db.prepare("SELECT value FROM import_manifest WHERE key='direct_sync_payload_class'").get() as
      { value?: string } | undefined;
    return {
      healthRecords: count(db, "SELECT COUNT(*) AS n FROM health_records"),
      workouts: count(db, "SELECT COUNT(*) AS n FROM workouts WHERE deleted_at IS NULL"),
      trainingSessions: count(db, "SELECT COUNT(*) AS n FROM training_sessions"),
      batches: (db.prepare("SELECT id FROM import_batches ORDER BY created_at").all() as Array<{ id: string }>)
        .map((row) => row.id),
      batchStatuses: db.prepare("SELECT id, status FROM import_batches ORDER BY created_at").all() as
        Array<{ id: string; status: string }>,
      rawGeneration: count(db, "SELECT raw_generation AS n FROM import_generations WHERE singleton = 1"),
      dependencyGeneration: count(db, "SELECT dependency_generation AS n FROM import_generations WHERE singleton = 1"),
      recomputeJobs: (db.prepare(`SELECT id, job_type AS jobType, status,
        target_dependency_generation AS dependency FROM recompute_jobs ORDER BY created_at`).all() as
        Array<{ id: string; jobType: string; status: string; dependency: number }>),
      receiptKeys: (db.prepare("SELECT key FROM import_manifest WHERE key LIKE 'rai.applied-import.%'").all() as
        Array<{ key: string }>).map((row) => row.key),
      importMode: receiptRow?.value ?? null
    };
  } finally { db.close(); }
}

const receiptKey = (jobId: string): string => `rai.applied-import.${jobId}`;

/**
 * GPX 相关表的**全部**行数（含已删除事实、未发布版本、旧表）。
 *
 * 强杀之后只能这样读：HTTP 已经不可用，而"有没有半批"必须逐表回答。刻意不按
 * `deleted_at IS NULL` 过滤 —— 半批的指控是"事务里留下了行"，哪怕这些行本来会被软删，
 * 也已经是 COMMIT 之前不该存在的东西。`readable_route_points` 是读侧唯一的路线点入口，
 * **不**断言 `route_points` 表（新代码把点写进 `route_versions`，旧表只在指针为 NULL 时才有行）。
 */
interface GpxTableFacts {
  healthRecords: number;
  workouts: number;
  trainingSessions: number;
  workoutRoutes: number;
  routeVersions: number;
  routeVersionPoints: number;
  routeFileFingerprints: number;
  importBatches: number;
  readableRoutePoints: number;
}

function readGpxTableFacts(databasePath: string): GpxTableFacts {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return {
      healthRecords: count(db, "SELECT COUNT(*) AS n FROM health_records"),
      workouts: count(db, "SELECT COUNT(*) AS n FROM workouts"),
      trainingSessions: count(db, "SELECT COUNT(*) AS n FROM training_sessions"),
      workoutRoutes: count(db, "SELECT COUNT(*) AS n FROM workout_routes"),
      routeVersions: count(db, "SELECT COUNT(*) AS n FROM route_versions"),
      routeVersionPoints: count(db, "SELECT COUNT(*) AS n FROM route_version_points"),
      routeFileFingerprints: count(db, "SELECT COUNT(*) AS n FROM route_file_fingerprints"),
      importBatches: count(db, "SELECT COUNT(*) AS n FROM import_batches"),
      readableRoutePoints: count(db, "SELECT COUNT(*) AS n FROM readable_route_points")
    };
  } finally { db.close(); }
}

/**
 * P2：批次前/杀后/重试后的**逐表精确快照**。
 *
 * 只挑与“删除 + GPX + 批次/回执/代次”有因果关系的表；每张表按 rowid 全列投影，
 * 因此任何半批行（含软删标记、版本点、墓碑、变更账本、任务）都会逐字段暴露。
 * 不按 `deleted_at IS NULL` 过滤：半批本身就是“事务里曾经有行”的指控。
 */
const P2_SNAPSHOT_TABLES = [
  "health_records",
  "healthkit_record_sources",
  "healthkit_record_facts",
  "import_entity_changes",
  "import_source_tombstones",
  "workouts",
  "training_sessions",
  "workout_routes",
  "route_versions",
  "route_version_points",
  "route_file_fingerprints",
  "import_batches",
  "recompute_jobs",
  "import_generations",
  "import_manifest"
] as const;

function readP2Snapshot(databasePath: string): Record<string, string> {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const snapshot: Record<string, string> = {};
    for (const table of P2_SNAPSHOT_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
      snapshot[table] = JSON.stringify(rows.map((row) => ({ ...row })));
    }
    return snapshot;
  } finally { db.close(); }
}

/**
 * 字段名集合。
 *
 * 为什么不用 `Object.keys(row).sort()`：`node:sqlite` 的查询结果是 **null 原型对象**，
 * 两者在 `deepStrictEqual` 下不相等（原型参与比较）—— 那会让一条"服务端给了哪些字段"的判据
 * 因为**夹具的取值方式**而红，读的人只会看到两个长得一模一样的对象。
 */
function sortedKeys(value: object): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

/** `node:sqlite` 的行是 null 原型对象；要跟普通对象 deepEqual 就得先归一化。 */
function plainRows(rows: readonly object[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row }) as Record<string, unknown>);
}

function readReceiptJson(databasePath: string, jobId: string): string | null {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM import_manifest WHERE key=?").get(receiptKey(jobId)) as
      { value?: string } | undefined;
    return row?.value ?? null;
  } finally { db.close(); }
}

/** 运行时状态库的只读探测：强杀之前要能看到"任务已经进入写事务那一段"。 */
function runtimeJob(databasePath: string, jobId: string): { status: string; phase: string; message: string } | null {
  if (!existsSync(databasePath)) return null;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT status, phase, message FROM import_jobs WHERE id = ?").get(jobId) as
      { status: string; phase: string; message: string } | undefined;
    return row ?? null;
  } catch { return null; } finally { db.close(); }
}

// ===========================================================================
// 1) 协商面：能力位必须由真 HTTP 响应宣告
// ===========================================================================

test("A17 前提：/v1/handshake 必须宣告 factsAnalysisContractVersion === 1（否则 iOS 永远不会去读回执）", async () => {
  const harness = createHarness("rai-direct-sync-http-handshake-");
  await prepareDatabase(harness);
  const server = await harness.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/handshake`);
    assert.equal(response.status, 200, await response.clone().text());
    const handshake = await response.json() as HandshakeResponse;
    // 这一条就是 iOS 的**开关**：缺了它，客户端会（正确地）退回旧字段路径，
    // 于是 §10.1 的回执在真机上永远没人读 —— 服务端再正确也等于没做（§10.2）。
    assert.equal(handshake.factsAnalysisContractVersion, 1,
      "真 HTTP 响应里缺这个能力位，iOS 会静默退回旧路径，直连回执永远没人读");
    // 既有能力位一个不少：挡住"为了加能力位而重写响应对象"这类事故。取值由被钉住的身份三元组决定。
    assert.equal(handshake.syncProtocolVersion, 1);
    assert.equal(handshake.healthKitRecordSyncVersion, 2);
    assert.equal(handshake.serverId, "local");
  } finally {
    await server.stop();
    harness.dispose();
  }
});

test("A17 前提：不带能力位的老服务端形态仍然可被消费（能力位是**可选**的，不是必填）", async () => {
  // ⚠️ 这是给 iOS 判据的**输入前提**，不是 iOS 判据本身：本机没有 swiftc/Xcode，
  // `DirectSyncCursorPolicy`（"缺能力位 ⇒ 不采用回执"）跑不了，本文件也**不假装**跑了它。
  // 这里只钉住服务端事实：老形态（省略能力位）在合同上仍是合法响应，客户端能解码、能判断。
  const legacy: HandshakeResponse = {
    serverId: "local", athleteId: "athlete_1", datasetEpoch: "default",
    syncProtocolVersion: 1, apiVersion: "v1"
  };
  assert.equal("factsAnalysisContractVersion" in legacy, false,
    "老服务端形态必须能构造出来（编译期：一旦能力位改成必填，这一行就 tsc 失败）");
  assert.equal(legacy.factsAnalysisContractVersion, undefined);
  // 有能力的形态与老形态的**唯一**区别就是这个键：客户端因此可以只按它分流。
  const modern: HandshakeResponse = { ...legacy, factsAnalysisContractVersion: 1 };
  assert.deepEqual(Object.keys(modern).filter((key) => !(key in legacy)), ["factsAnalysisContractVersion"]);
});

// ===========================================================================
// 2) 一次完整真机会话 + A06 重放幂等
// ===========================================================================

test("A17/A06：真实上传→inspect→import-jobs→终态（需要分析 ⇒ queued），且同批同内容重放取回**原回执**", async () => {
  const harness = createHarness("rai-direct-sync-http-session-");
  await prepareDatabase(harness);
  const server = await harness.start();
  const api = session(server.baseUrl);
  const batchId = "device-session-batch-0001";
  const zip = healthKitZip(workoutExportXml(), syncManifest());
  try {
    // ① 上传（真 multipart，真 ZIP 解析、真解压目录）
    const upload = await api.upload(zip, batchId, "apple-health-healthkit-2026-01-02.zip");
    assert.match(upload.sourceId, /^upload_/);
    assert.equal(upload.uploadId, upload.sourceId, "uploadId 与 sourceId 必须是同一个来源的两种称呼");

    // ② inspect：真机会先看这份载荷是什么
    const inspection = await api.inspect(upload.sourceId);
    assert.equal(inspection.sourceId, upload.sourceId);
    assert.equal(inspection.exportFileName, "export.xml");

    // ③ 建任务（202 = 已持久受理）
    const created = await api.createJob(upload.sourceId);
    assert.equal(created.status, 202, JSON.stringify(created.job));
    const jobId = created.job.id;
    assert.equal(created.job.sourceId, upload.sourceId);

    // ④ 轮询到终态
    const done = await waitForTerminal(api, jobId, { what: "含 Workout 的直连批次终态" });
    assert.equal(done.status, "succeeded", describeJob(done, server.output));
    assert.equal(done.error, null);

    const direct = done.summary?.directSync;
    assert.ok(direct, `终态摘要必须带 directSync 回执（老形态缺这个键，iOS 就无从判断）：${JSON.stringify(done.summary)}`);
    // 🔴 §10.1：提交成功只说"事实已持久"，不许顺带说"分析已完成"。
    assert.equal(direct.ingestStatus, "committed");
    // 🔴 需要分析就必须写 queued：任务**已经在同一个事务里**登记完了（`direct-sync-ingest.ts` 的提交前断言）。
    // 写 not_required 会让客户端显示「健康数据已保存」而不再跟踪分析（§9.1 明令禁止）。
    assert.equal(direct.analysisStatus, "queued",
      `含 Workout 的批次必须要求分析，实际回执：${JSON.stringify(direct)}`);
    assert.equal(direct.receiptId, jobId, "回执 id 必须与任务 id 相同（这也是客户端找回原回执的钥匙）");
    assert.equal(direct.publishedReleaseId, null,
      "原始接收**不许**声称已发布分析 —— 分析任务此刻还在排队");
    assert.equal(direct.parentBatchId, null, "本批没有分片");

    // ⑤ 持久回执与终态摘要必须逐字节同源（回执是 COMMIT 时刻的凭证，之后一辈子不变）
    const persisted = readReceiptJson(harness.databasePath, jobId);
    assert.ok(persisted, "主库里必须有持久回执（丢回复时客户端靠它恢复）");
    assert.deepEqual(JSON.parse(persisted), done.summary, "终态摘要与持久回执必须是同一份结论");

    // ⑥ 事实真的落库；§14.1 的整库链路一步都没走（直连车道的核心承诺）
    const facts = readMainFacts(harness.databasePath);
    assert.deepEqual(facts.batches, [jobId], "本批必须恰好写一个批次账本行");
    assert.deepEqual(plainRows(facts.batchStatuses), [{ id: jobId, status: "succeeded" }]);
    assert.equal(facts.healthRecords, 0, "本批是纯 Workout 载荷");
    assert.equal(facts.workouts, 1);
    assert.equal(facts.trainingSessions, 1);
    assert.equal(done.performance?.stagesMs.backupCopy, undefined, "直连车道不得整库复制");
    assert.equal(done.performance?.stagesMs.stagingCopy, undefined, "直连车道不得建暂存候选库");
    assert.equal(done.performance?.stagesMs.activationSwap, undefined, "直连车道不得换库");
    assert.equal(done.summary?.backupName, null, "直连车道不产生项目备份");
    assert.ok((done.performance?.stagesMs.directSyncApply ?? 0) > 0, "统一接收器阶段必须有耗时留痕");
    assert.deepEqual(
      readdirSync(join(harness.root, "var")).filter((name) => /^(backups|rai\.importing)/.test(name)), [],
      "隔离 var/ 里不得出现项目备份或整库候选"
    );

    // ⑦ 分析任务：登记了、指向本批、绑定列与回执一致
    assert.equal(facts.recomputeJobs.length, 1, "需要分析的批次必须在同一事务里登记恰好一个分析任务");
    const analysisJobId = (done.summary as { analysisJobId?: string | null }).analysisJobId;
    assert.ok(analysisJobId, "回执必须给出分析任务 id，否则 §10.3 的「分析已更新」在真机上不可达");
    assert.equal(facts.recomputeJobs[0]!.id, analysisJobId);
    assert.equal(facts.recomputeJobs[0]!.jobType, "import");
    assert.equal(facts.recomputeJobs[0]!.status, "queued", "登记完只是排队；回执也不许说它跑完了");
    assert.equal(String(facts.recomputeJobs[0]!.dependency), direct.dependencyGeneration);
    const analysisRequest = new DatabaseSync(harness.databasePath, { readOnly: true });
    try {
      const row = analysisRequest.prepare("SELECT request_json AS request FROM recompute_jobs WHERE id=?").get(analysisJobId) as
        { request: string };
      const request = JSON.parse(row.request) as { mode?: unknown; importBatchId?: unknown };
      assert.equal(request.mode, DIRECT_SYNC_ANALYSIS_REQUEST_MODE, "载荷 mode 必须让消费者认得出这是直连分析");
      assert.equal(request.importBatchId, jobId);
    } finally { analysisRequest.close(); }

    const generationAfterFirst = facts.rawGeneration;

    // ⑧ A06：同一 `X-RAI-Sync-Batch` 重传同内容 ⇒ 幂等命中**同一条来源**（不新建上传、不新建批次）
    const reupload = await api.upload(zip, batchId, "apple-health-healthkit-2026-01-02.zip");
    assert.equal(reupload.sourceId, upload.sourceId,
      "同批同内容重传必须命中同一条来源；新建来源会让真机的重试变成第二次导入");
    const reinspect = await api.inspect(reupload.sourceId);
    assert.equal(reinspect.sourceSha256, inspection.sourceSha256, "同一来源的内容摘要必须一致");

    // ⑨ 重放同一来源 ⇒ 拿回**原任务与原回执**，不重复应用
    const replay = await api.createJob(upload.sourceId);
    assert.equal(replay.job.id, jobId, "重放必须命中同一个任务（否则真机拿不到原回执）");
    assert.equal(replay.job.status, "succeeded");
    assert.deepEqual(replay.job.summary, done.summary, "重放必须逐字段返回**原回执**，不是重新算一份");
    const afterReplay = readMainFacts(harness.databasePath);
    assert.equal(afterReplay.healthRecords, 0);
    assert.equal(afterReplay.workouts, 1, "重放不得重复应用");
    assert.equal(afterReplay.trainingSessions, 1);
    assert.equal(afterReplay.rawGeneration, generationAfterFirst, "重放不得推进代次");
    assert.deepEqual(afterReplay.batches, [jobId]);
    assert.deepEqual(afterReplay.recomputeJobs.map((job) => job.id), [analysisJobId], "重放不得再登记分析任务");
    assert.equal(readReceiptJson(harness.databasePath, jobId), persisted, "重放不得改写持久回执");

    // ⑩ 第 5 步里那条"给 iOS 判据的输入前提"：拿到的回执**含**能力位所承诺的字段。
    //    iOS 侧 `DirectSyncCursorPolicy` 据此推进游标；本机不跑 Swift，这里只说清服务端给了什么。
    //    （按**字段名集合**比较，不按插入顺序 —— JSON 对象顺序不是合同。）
    // 2026-10-18（P0-3）：回执新增可选 `records` 计数块（parsed/inserted/unchanged）。
    // 它描述**本批结果**，不改变 ingestStatus/analysisStatus 的既有语义；老服务端省略该键。
    assert.deepEqual(sortedKeys(direct),
      ["analysisStatus", "dependencyGeneration", "ingestStatus", "parentBatchId", "publishedReleaseId", "receiptId", "records"]);
  } finally {
    await server.stop();
    harness.dispose();
  }
});

test("A17：record-only 载荷必须写 not_required（不许为了省事一律写 queued），且不登记分析任务", async () => {
  const harness = createHarness("rai-direct-sync-http-record-only-");
  await prepareDatabase(harness);
  const server = await harness.start();
  const api = session(server.baseUrl);
  try {
    const xml = `<HealthData locale="en_US">${Array.from({ length: 5 }, (_, index) => stepRecordXml(index)).join("")}</HealthData>`;
    const upload = await api.upload(healthKitZip(xml, syncManifest()), "record-only-batch-0001", "apple-health-healthkit-record.zip");
    const created = await api.createJob(upload.sourceId);
    assert.equal(created.status, 202, JSON.stringify(created.job));
    const done = await waitForTerminal(api, created.job.id, { what: "record-only 批次终态" });
    assert.equal(done.status, "succeeded", describeJob(done, server.output));

    const direct = done.summary?.directSync;
    assert.ok(direct);
    assert.equal(direct.ingestStatus, "committed");
    // 🔴 两个方向都要能被区分：这条载荷**结构上碰不到分析**，所以必须写 not_required。
    // 一律写 queued 会让"分析更新中"变成永远不收敛的状态，也让 not_required 这条路失去判据。
    assert.equal(direct.analysisStatus, "not_required",
      `纯非评分记录载荷不该要求分析，实际：${JSON.stringify(direct)}`);
    const facts = readMainFacts(harness.databasePath);
    assert.equal(facts.healthRecords, 5);
    assert.deepEqual(facts.recomputeJobs, [], "not_required 就不许登记分析任务");
    assert.equal((done.summary as { analysisJobId?: string | null }).analysisJobId, null,
      "不登记分析时 analysisJobId 必须是 null（不是缺键：缺键在老服务端才有意义）");
    assert.equal(direct.publishedReleaseId, null);
    // 代次（R6 修正，2026-10-15）：record-only 快通路**要推进 raw**（0 → 1）。
    // 旧断言写 `== 0` 并把它解释成设计——但那条"设计"正是 R6 的现象①：data-only 车道
    // 更新了记录与 `dataset_version` 却不推 raw，读侧的 `analysis !== facts` 便把它
    // 读成"分析永久落后"（假 stale）。修复后本车道与直连同语义：**成功批次 ⇒ raw +1**；
    // 不推 dependency —— 本批结构上碰不到分析（`not_required`，见上）。
    assert.equal(facts.rawGeneration, 1, "record-only 快通路每个成功批次推进一次 raw 代次");
    assert.equal(facts.dependencyGeneration, 0, "record-only 更不许推进 dependency 代次");
  } finally {
    await server.stop();
    harness.dispose();
  }
});

// ===========================================================================
// 3) §5.1 / A03：删除-only 批次
// ===========================================================================

test("§5.1/A03：删除-only 批次推进（不被当成 EOF）、回执 queued、且不许误删同来源其他事实", async () => {
  const harness = createHarness("rai-direct-sync-http-delete-only-");
  await prepareDatabase(harness);
  const server = await harness.start();
  const api = session(server.baseUrl);
  try {
    // 前置：先同步一批"记录 + 训练"。删除-only 的判据只有在**有东西可删**时才有意义。
    const records = Array.from({ length: 4 }, (_, index) => stepRecordXml(index)).join("");
    const firstXml = `<HealthData locale="en_US">${records}${workoutExportXml().replace(/^<HealthData[^>]*>|<\/HealthData>$/g, "")}</HealthData>`;
    const first = await api.upload(healthKitZip(firstXml, syncManifest()), "delete-only-batch-0001", "apple-health-healthkit-a.zip");
    const firstJob = await api.createJob(first.sourceId);
    const firstDone = await waitForTerminal(api, firstJob.job.id, { what: "删除-only 的前置批次" });
    assert.equal(firstDone.status, "succeeded", describeJob(firstDone, server.output));
    const before = readMainFacts(harness.databasePath);
    assert.equal(before.healthRecords, 4);
    assert.equal(before.workouts, 1);

    // 本批：**只有删除**（`deletedSourceIds` 里点名那个 Workout），XML 里一条事实都没有。
    const deleteZip = healthKitZip(
      `<HealthData locale="en_US"></HealthData>`,
      syncManifest({ deletedWorkoutIds: [WORKOUT_UUID] })
    );
    const upload = await api.upload(deleteZip, "delete-only-batch-0002", "apple-health-healthkit-b.zip");
    const created = await api.createJob(upload.sourceId);
    assert.equal(created.status, 202, JSON.stringify(created.job));
    const done = await waitForTerminal(api, created.job.id, { what: "删除-only 批次终态" });
    assert.equal(done.status, "succeeded", describeJob(done, server.output));

    const direct = done.summary?.directSync;
    assert.ok(direct);
    // 🔴 §5.1「删除-only 页面不是 EOF」：它必须是一条**真实推进**的批次 ——
    // 有持久回执、代次前进、并且（因为动了分析）登记了分析任务。
    assert.equal(direct.ingestStatus, "committed", "删除-only 必须有持久回执，否则真机会把它当成没发生");
    assert.equal(direct.analysisStatus, "queued",
      `删除改变了训练事实 ⇒ 必须要求分析（写 not_required 会让用户看到与事实不符的当前结论）：${JSON.stringify(direct)}`);
    assert.equal(direct.receiptId, created.job.id);
    assert.equal(direct.publishedReleaseId, null);

    const after = readMainFacts(harness.databasePath);
    assert.equal(after.workouts, 0, "点名的 Workout 必须被软删");
    assert.equal(after.trainingSessions, 1, "删除不得顺手删掉会话身份（读侧靠它分辨「已删除」与「不存在」）");
    assert.equal(after.healthRecords, 4, "删除-only 不得误删同来源的其他事实");
    assert.deepEqual(after.batches, [firstJob.job.id, created.job.id], "两个批次都要有账本行");
    assert.equal(after.rawGeneration, before.rawGeneration + 1, "删除-only 也是真实批次：raw 代次必须前进");
    assert.equal(after.dependencyGeneration, before.dependencyGeneration + 1, "本批影响分析，dependency 代次必须前进");
    assert.equal(after.recomputeJobs.length, 2, "删除-only 批次必须登记自己的分析任务");
    const newest = after.recomputeJobs[1]!;
    assert.equal(newest.status, "queued");
    assert.equal(newest.id, (done.summary as { analysisJobId?: string | null }).analysisJobId);
    assert.equal(done.performance?.stagesMs.backupCopy, undefined);
    assert.equal(done.performance?.stagesMs.activationSwap, undefined);
  } finally {
    await server.stop();
    harness.dispose();
  }
});

// ===========================================================================
// 4) A05：强杀与丢回复
// ===========================================================================

test("A05：COMMIT 前强杀真子进程 ⇒ 没有半批，重启后任务重跑并恰好提交一次", async () => {
  const harness = createHarness("rai-direct-sync-http-kill-before-commit-");
  await prepareDatabase(harness);
  let server = await harness.start();
  const api = session(server.baseUrl);
  try {
    // 载荷要**足够大**：写事务得长到能在它中间取到样本。但它同时必须**留在直连上界之内**
    // （直连 xml 上界，2026-10-14 起 8 MiB）—— 收口后越界是显式失败（旧版是静默回退候选链路），
    // 两种都会让"强杀"测的变成失败路径而不是写事务。第一次写这条用例时用了 9000 条，
    // 日志里出现的是 `var/backups`（旧链路），所以上界在这里被显式钉住。
    const xml = recordOnlyLargeFixtureXml();
    assertWithinDirectSyncBounds(xml);
    const zip = healthKitZip(xml, syncManifest());
    const upload = await api.upload(zip, "kill-before-commit-0001", "apple-health-healthkit-kill.zip");
    const created = await api.createJob(upload.sourceId);
    assert.equal(created.status, 202, JSON.stringify(created.job));
    const jobId = created.job.id;

    const walPath = `${harness.databasePath}-wal`;
    const baseline = readMainFacts(harness.databasePath);
    assert.equal(baseline.healthRecords, 0);

    // 🔴 等"任务已经进入写事务那一段"，判据是两件**真实可观测**的事：任务已 running，且 WAL 在长。
    // 为什么必须**持有一个读者连接**：SQLite 在最后一个连接关闭时会 checkpoint(-wal → 主库) 并截断它，
    // 于是"读一次库"这个动作本身会把 WAL 归零 —— 那样这条判据就会永远等不到，看起来像服务端没写。
    // 读者开着 ⇒ 检查点不能截断 WAL ⇒ 字节数是单调的写入证据。
    // 同理，探测回执也不能另开连接：读写都走这一个句柄（`SELECT` 不影响写者）。
    const reader = new DatabaseSync(harness.databasePath, { readOnly: true });
    const receiptWith = (db: DatabaseSync): string | null =>
      (db.prepare("SELECT value FROM import_manifest WHERE key=?").get(receiptKey(jobId)) as { value?: string } | undefined)
        ?.value ?? null;
    try {
      // 先证明"此刻还没有提交"，避免把 COMMIT 之后的样本当成 COMMIT 之前的。
      assert.equal(receiptWith(reader), null);
      const observed = await waitForCondition(() => {
        if (receiptWith(reader) !== null) {
          throw new Error("批次在强杀之前就提交完了 —— 这次拿到的是 COMMIT 之后的样本，不是 COMMIT 之前的");
        }
        const job = runtimeJob(harness.runtimeStatePath, jobId);
        if (job === null || job.status !== "running") return null;
        const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
        return walBytes >= 256 * 1024 ? { job, walBytes } : null;
      }, {
        what: "任务进入写事务（WAL ≥ 256 KiB 且任务为 running）",
        budgetMs: POLL_BUDGET_MS,
        describe: () => JSON.stringify({
          job: runtimeJob(harness.runtimeStatePath, jobId),
          walBytes: existsSync(walPath) ? statSync(walPath).size : 0,
          walExists: existsSync(walPath),
          varEntries: readdirSync(join(harness.root, "var"))
        })
      });
      assert.equal(receiptWith(reader), null,
        "强杀之前不得已经有持久回执 —— 有就说明这次取到的是 COMMIT 后的样本");
      assert.equal(observed.job.status, "running");
    } finally { reader.close(); }

    hardKill(server);
    await delay(200); // 只等 OS 回收进程句柄，等的不是业务状态。

    // ⓐ COMMIT 前强杀：不许留半批。回执、账本行、事实、代次四样一起必须是"没发生"。
    const killed = readMainFacts(harness.databasePath);
    assert.equal(readReceiptJson(harness.databasePath, jobId), null, "COMMIT 前被强杀不得留下回执");
    assert.deepEqual(killed.batches, [], "COMMIT 前被强杀不得留下批次账本行");
    assert.equal(killed.receiptKeys.length, 0);
    assert.equal(killed.healthRecords, 0, "不得留下半批事实");
    assert.equal(killed.rawGeneration, baseline.rawGeneration, "未提交的批次不得推进代次");
    assert.equal(killed.dependencyGeneration, baseline.dependencyGeneration);

    // ⓑ 重启同一个 var/：已持久受理的任务必须自己续上（不是让用户重新导出）
    server = await harness.start();
    const restarted = session(server.baseUrl);
    const recovered = await waitForTerminal(restarted, jobId, { what: "重启后恢复的批次终态" });
    assert.equal(recovered.status, "succeeded", JSON.stringify({ error: recovered.error, message: recovered.message }));
    assert.equal(recovered.id, jobId, "恢复必须落在**同一个**任务 id 上（批次身份不能换）");
    assert.equal(recovered.summary?.directSync?.ingestStatus, "committed");
    assert.equal(recovered.summary?.directSync?.receiptId, jobId);

    const after = readMainFacts(harness.databasePath);
    assert.equal(after.healthRecords, KILL_FIXTURE_RECORDS, "事实必须**恰好**落库一次");
    assert.deepEqual(after.batches, [jobId], "整条故事线只许留下一个批次账本行");
    assert.equal(after.receiptKeys.length, 1, "只许留下一个持久回执");
    assert.equal(after.dependencyGeneration, baseline.dependencyGeneration,
      "纯非评分记录载荷不影响分析，dependency 代次不许动");
    assert.equal(after.rawGeneration, baseline.rawGeneration + 1,
      "R6（2026-10-15）起 record-only 快通路也推进 raw：成功批次恰好 +1（恢复的「恰好一次」）");
    assert.equal(after.recomputeJobs.length, 0);
    // （旧注记曾写"本车道不推进 import_generations"——那是 R6 现象①被当成设计的年代；
    //   修复后同文件 record-only 用例与这里共同钉住"成功恰好 +1"。）
  } finally {
    await server.stop();
    harness.dispose();
  }
});

test("A05：COMMIT 前强杀含 GPX 的批次 ⇒ 路线点/删除/回执均无半批，重启后恰好提交一次", { timeout: 120_000 }, async () => {
  const harness = createHarness("rai-direct-sync-http-kill-before-commit-gpx-");
  await prepareDatabase(harness);
  let server = await harness.start();
  const api = session(server.baseUrl);
  try {
    // 载荷 = 与 A05 同尺的 4500 条记录 + 一个显式引用 GPX 的 Workout。
    // 上界自检不能省：越界会走拒收/候选链路，那时"强杀写事务"就没被证明了。
    const xml = gpxLargeFixtureXml();
    assertWithinDirectSyncBounds(xml);
    assert.equal(xml.split("<Record ").length - 1, KILL_FIXTURE_RECORDS,
      "GPX 变体必须复用 A05 的记录条数（恰好一次断言的基准）");
    const zip = healthKitZip(xml, syncManifest(), [
      { name: KILL_GPX_ROUTE_RELATIVE_PATH, data: Buffer.from(killRouteGpx(), "utf8") }
    ]);
    const upload = await api.upload(zip, "kill-before-commit-gpx-0001", "apple-health-healthkit-kill-gpx.zip");
    const created = await api.createJob(upload.sourceId);
    assert.equal(created.status, 202, JSON.stringify(created.job));
    const jobId = created.job.id;

    const walPath = `${harness.databasePath}-wal`;
    const baseline = readGpxTableFacts(harness.databasePath);
    assert.equal(baseline.healthRecords, 0);
    assert.equal(baseline.importBatches, 0);

    // 与 A05 相同的窗口判据：任务已 running、WAL ≥ 256 KiB、回执尚未落库。
    // 必须持有一个常开的读者连接：最后一个连接关闭时会 checkpoint(-wal → 主库) 并截断 WAL，
    // 那样这里的字节数就永远等不到阈值。探测回执也走同一个句柄。
    const reader = new DatabaseSync(harness.databasePath, { readOnly: true });
    const receiptWith = (db: DatabaseSync): string | null =>
      (db.prepare("SELECT value FROM import_manifest WHERE key=?").get(receiptKey(jobId)) as { value?: string } | undefined)
        ?.value ?? null;
    try {
      assert.equal(receiptWith(reader), null);
      const observed = await waitForCondition(() => {
        if (receiptWith(reader) !== null) {
          throw new Error("批次在强杀之前就提交完了 —— 这次拿到的是 COMMIT 之后的样本，不是 COMMIT 之前的");
        }
        const job = runtimeJob(harness.runtimeStatePath, jobId);
        if (job === null || job.status !== "running") return null;
        const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
        return walBytes >= 256 * 1024 ? { job, walBytes } : null;
      }, {
        what: "含 GPX 的任务进入写事务（WAL ≥ 256 KiB 且任务为 running）",
        budgetMs: POLL_BUDGET_MS,
        describe: () => JSON.stringify({
          job: runtimeJob(harness.runtimeStatePath, jobId),
          walBytes: existsSync(walPath) ? statSync(walPath).size : 0,
          walExists: existsSync(walPath),
          varEntries: readdirSync(join(harness.root, "var"))
        })
      });
      assert.equal(receiptWith(reader), null,
        "强杀之前不得已经有持久回执 —— 有就说明这次取到的是 COMMIT 后的样本");
      assert.equal(observed.job.status, "running");
    } finally { reader.close(); }

    hardKill(server);
    await delay(200); // 只等 OS 回收进程句柄，等的不是业务状态。

    // ⓐ COMMIT 前强杀：GPX 相关七张表 + 批次账本 + 回执必须一起是"没发生"。
    //    这是 F01 的缺失变体：只断言 health_records 的话，路线版本/点/指纹的半批不可见。
    const killed = readGpxTableFacts(harness.databasePath);
    const killedMain = readMainFacts(harness.databasePath);
    assert.equal(readReceiptJson(harness.databasePath, jobId), null, "COMMIT 前被强杀不得留下回执");
    assert.deepEqual(killedMain.batches, [], "COMMIT 前被强杀不得留下批次账本行");
    assert.equal(killedMain.receiptKeys.length, 0);
    assert.equal(killed.healthRecords, 0, "health_records 不得留下半批");
    assert.equal(killed.workouts, 0, "workouts 不得留下半批");
    assert.equal(killed.trainingSessions, 0, "training_sessions 不得留下半批");
    assert.equal(killed.workoutRoutes, 0, "workout_routes 不得留下半批");
    assert.equal(killed.routeVersions, 0, "route_versions 不得留下半批");
    assert.equal(killed.routeVersionPoints, 0, "route_version_points 不得留下半批");
    assert.equal(killed.routeFileFingerprints, 0, "route_file_fingerprints 不得留下半批");
    assert.equal(killed.importBatches, 0, "import_batches 不得留下半批");
    assert.equal(killed.readableRoutePoints, 0, "读侧视图不得看到任何半批路线点");

    // ⓑ 重启同一个 var/：同一个任务 id 自己续上，并**恰好**提交一次（记录 + 路线都要）。
    server = await harness.start();
    const restarted = session(server.baseUrl);
    const recovered = await waitForTerminal(restarted, jobId, { what: "重启后恢复的含 GPX 批次终态" });
    assert.equal(recovered.status, "succeeded", JSON.stringify({
      error: recovered.error, message: recovered.message, summary: recovered.summary
    }));
    assert.equal(recovered.id, jobId, "恢复必须落在**同一个**任务 id 上（批次身份不能换）");
    assert.equal(recovered.summary?.directSync?.ingestStatus, "committed");
    assert.equal(recovered.summary?.directSync?.receiptId, jobId);

    const receipt = readReceiptJson(harness.databasePath, jobId);
    assert.ok(receipt, "成功批次必须有持久回执");
    assert.deepEqual(JSON.parse(receipt), recovered.summary, "终态摘要与持久回执必须是同一份结论");

    const after = readGpxTableFacts(harness.databasePath);
    assert.equal(after.healthRecords, KILL_FIXTURE_RECORDS, "记录必须**恰好**落库一次");
    assert.equal(after.workouts, 1, "Workout 必须**恰好**落库一次");
    assert.equal(after.trainingSessions, 1, "训练会话必须**恰好**一条");
    assert.equal(after.workoutRoutes, 1, "路线必须**恰好**一条");
    assert.equal(after.routeVersions, 1, "路线版本必须**恰好**一个");
    assert.equal(after.routeVersionPoints, 3, "轨迹点必须**恰好**落库一次");
    assert.equal(after.importBatches, 1, "整条故事线只许留下一个批次账本行");
    // 🔴 只读 `readable_route_points` 视图，不断言 `route_points` 表：新代码把点写进
    //    `route_versions`，旧表只在 `published_route_version_id IS NULL` 时才有行。
    assert.equal(after.readableRoutePoints, 3, "读侧必须通过 readable_route_points 看到恰好 3 个点");
    assert.equal(after.routeFileFingerprints, 1, "GPX 指纹必须**恰好**一条");

    const afterMain = readMainFacts(harness.databasePath);
    assert.deepEqual(afterMain.batches, [jobId], "只许留下一个批次账本行");
    assert.deepEqual(plainRows(afterMain.batchStatuses), [{ id: jobId, status: "succeeded" }]);
    assert.equal(afterMain.receiptKeys.length, 1, "只许留下一个持久回执");

    // ⓒ 与既有直连用例同口径的收尾体检：外键全绿、var/ 里没有整库副本/候选目录。
    const foreignKeyViolations = harness.readMain((db) => db.prepare("PRAGMA foreign_key_check").all());
    assert.deepEqual(plainRows(foreignKeyViolations as object[]), [], "提交后的库不得有外键违规");
    assert.deepEqual(
      readdirSync(join(harness.root, "var")).filter((name) => /^(backups|rai\.importing)/.test(name)), [],
      "隔离 var/ 里不得出现项目备份或整库候选"
    );
  } finally {
    await server.stop();
    harness.dispose();
  }
});

test("A05/F01：COMMIT 前确定性屏障证明删除与 GPX 同事务写入 ⇒ SIGKILL 全回滚，同 job 恰好重试一次", { timeout: 180_000, skip: PRECOMMIT_SIGKILL_ONLY }, async () => {
  const harness = createHarness("rai-direct-sync-http-p2-delete-gpx-");
  await prepareDatabase(harness);
  const markerPath = join(harness.root, "precommit-marker.json");
  const deletedUuid = sampleUuid(900);
  const controlUuid = sampleUuid(901);
  let server = await harness.start({ preCommitBarrierMarker: markerPath });
  const api = session(server.baseUrl);
  try {
    // ── 基线：先通过真实 HTTP/worker 提交两条有稳定 UUID 的事实（一条待删、一条保护对照）。
    const baselineXml = `<HealthData locale="en_US">${stepRecordXml(900)}${stepRecordXml(901)}</HealthData>`;
    const baselineUpload = await api.upload(
      healthKitZip(baselineXml, syncManifest()), "p2-delete-gpx-baseline-0001",
      "apple-health-healthkit-p2-baseline.zip");
    const baselineCreated = await api.createJob(baselineUpload.sourceId);
    assert.equal(baselineCreated.status, 202, JSON.stringify(baselineCreated.job));
    const baselineDone = await waitForTerminal(api, baselineCreated.job.id, { what: "P2 基线批次终态" });
    assert.equal(baselineDone.status, "succeeded", describeJob(baselineDone, server.output));
    const baseline = readP2Snapshot(harness.databasePath);
    const baselineMain = readMainFacts(harness.databasePath);
    assert.equal(baselineMain.healthRecords, 2);
    assert.equal(baselineMain.workouts, 0);

    // ── 确定性屏障：触发器挂在**回执 INSERT** 上。回执写入位于删除、GPX 路线版本/点、
    //    批次终态、任务登记之后，COMMIT 之前。触发器先在同一事务连接里逐条 RAISE
    //    证明“待删 UUID 已不可见 / 对照仍在 / Workout/路线版本/3 点已存在”，
    //    再把同连接读到的计数交给测试函数落盘并暂停真实子进程。
    const trigger = `CREATE TRIGGER rai_p2_precommit_barrier BEFORE INSERT ON import_manifest
      WHEN NEW.key LIKE 'rai.applied-import.%'
      BEGIN
        SELECT RAISE(ABORT, 'P2 barrier: deleted UUID still present')
          WHERE EXISTS (SELECT 1 FROM healthkit_record_sources s
            JOIN health_records r ON r.id = s.record_id
            WHERE s.sample_uuid = '${deletedUuid}');
        SELECT RAISE(ABORT, 'P2 barrier: control UUID missing')
          WHERE NOT EXISTS (SELECT 1 FROM healthkit_record_sources s
            JOIN health_records r ON r.id = s.record_id
            WHERE s.sample_uuid = '${controlUuid}');
        SELECT RAISE(ABORT, 'P2 barrier: workout missing')
          WHERE NOT EXISTS (SELECT 1 FROM workouts);
        SELECT RAISE(ABORT, 'P2 barrier: route version/3 points missing')
          WHERE NOT EXISTS (SELECT 1 FROM workout_routes route
            JOIN route_versions version ON version.id = route.published_route_version_id
            WHERE version.point_count = 3
              AND (SELECT COUNT(*) FROM route_version_points point
                WHERE point.route_version_id = version.id) = 3);
        SELECT rai_hold_before_commit(
          NEW.key,
          (SELECT COUNT(*) FROM healthkit_record_sources s
            JOIN health_records r ON r.id = s.record_id WHERE s.sample_uuid = '${controlUuid}'),
          (SELECT COUNT(*) FROM workouts),
          (SELECT COUNT(*) FROM route_versions),
          (SELECT COUNT(*) FROM route_version_points),
          (SELECT COUNT(*) FROM import_source_tombstones
            WHERE source_identifier LIKE '%${deletedUuid}%')
        );
      END`;
    const triggerDb = new DatabaseSync(harness.databasePath);
    triggerDb.exec(trigger);
    triggerDb.close();

    // ── 待强杀批次：12 条新记录 + 显式删除基线 UUID + 一个显式引用 3 点 GPX 的 Workout。
    const revisionRecords = Array.from({ length: 12 }, (_, index) => stepRecordXml(1000 + index)).join("");
    const revisionWorkout = workoutWithRouteExportXml()
      .replace(/^<HealthData[^>]*>/, "").replace(/<\/HealthData>\s*$/, "");
    const revisionXml = `<HealthData locale="en_US">${revisionRecords}${revisionWorkout}</HealthData>`;
    assertWithinDirectSyncBounds(revisionXml);
    const revisionZip = healthKitZip(
      revisionXml,
      syncManifest({ deletedRecords: [{ type: "HKQuantityTypeIdentifierStepCount", uuid: deletedUuid }] }),
      [{ name: KILL_GPX_ROUTE_RELATIVE_PATH, data: Buffer.from(killRouteGpx(), "utf8") }]
    );
    const upload = await api.upload(
      revisionZip, "p2-delete-gpx-kill-0001", "apple-health-healthkit-p2-kill.zip");
    const created = await api.createJob(upload.sourceId);
    assert.equal(created.status, 202, JSON.stringify(created.job));
    const jobId = created.job.id;

    const marker = await waitForCondition(() => {
      if (!existsSync(markerPath)) return null;
      try { return JSON.parse(readFileSync(markerPath, "utf8")) as { values: string[] }; }
      catch { return null; }
    }, {
      what: "删除与 GPX 已写入、COMMIT 未发生的确定性屏障",
      budgetMs: POLL_BUDGET_MS,
      describe: () => JSON.stringify({ job: runtimeJob(harness.runtimeStatePath, jobId), markerExists: existsSync(markerPath), serverOutput: server.output() })
    });
    assert.equal(marker.values[0], receiptKey(jobId), "屏障必须由实际导入事务的回执写入触发，并携带本 job id");
    assert.equal(marker.values[1], "1", "同一事务连接上保护对照必须仍可见");
    assert.equal(marker.values[2], "1", "同一事务连接上 Workout 必须已写入");
    assert.equal(marker.values[3], "1", "同一事务连接上路线版本必须已写入");
    assert.equal(marker.values[4], "3", "同一事务连接上路线点必须恰好 3 个");
    assert.equal(marker.values[5], "1", "同一事务连接上删除墓碑必须已写入");
    assert.equal(readReceiptJson(harness.databasePath, jobId), null,
      "屏障点必须在 COMMIT 之前：外部连接不得看到回执");
    assert.deepEqual(readP2Snapshot(harness.databasePath), baseline,
      "外部只读连接必须仍看到批次前快照（删除、GPX、批次、任务、回执都不可见）");

    // ── 真实 SIGKILL；等 OS 确认退出后直接开库逐表比较。
    const exited = once(server.child, "exit");
    hardKill(server);
    await exited;

    const clean = new DatabaseSync(harness.databasePath);
    clean.exec("DROP TRIGGER rai_p2_precommit_barrier");
    clean.close();
    assert.deepEqual(readP2Snapshot(harness.databasePath), baseline,
      "SIGKILL 后数据库必须逐表等于批次前快照（包括原删除目标仍在）");
    assert.equal(readReceiptJson(harness.databasePath, jobId), null);
    const foreignKeys = harness.readMain((db) => db.prepare("PRAGMA foreign_key_check").all());
    assert.deepEqual(plainRows(foreignKeys as object[]), []);

    // ── 同一 runtime 重启，同一 job id 恰好重试一次。
    server = await harness.start();
    const restarted = session(server.baseUrl);
    const recovered = await waitForTerminal(restarted, jobId, { what: "重启后删除+GPX 批次终态" });
    assert.equal(recovered.status, "succeeded", JSON.stringify({
      error: recovered.error, message: recovered.message, summary: recovered.summary
    }));
    assert.equal(recovered.id, jobId);
    assert.ok(recovered.summary?.directSync);
    assert.deepEqual(JSON.parse(readReceiptJson(harness.databasePath, jobId)!), recovered.summary,
      "终态摘要必须等于持久回执");

    const after = readGpxTableFacts(harness.databasePath);
    assert.equal(after.healthRecords, 13, "2 条基线 - 1 条显式删除 + 12 条新记录");
    assert.equal(after.workouts, 1);
    assert.equal(after.trainingSessions, 1);
    assert.equal(after.workoutRoutes, 1);
    assert.equal(after.routeVersions, 1);
    assert.equal(after.routeVersionPoints, 3);
    assert.equal(after.routeFileFingerprints, 1);
    assert.equal(after.importBatches, 2, "基线与本批各一行");
    assert.equal(after.readableRoutePoints, 3);
    const deletedVisible = harness.readMain((db) => Number((db.prepare(`
      SELECT COUNT(*) AS n FROM healthkit_record_sources s JOIN health_records r ON r.id=s.record_id
      WHERE s.sample_uuid = ?`).get(deletedUuid) as { n: number }).n));
    assert.equal(deletedVisible, 0, "待删 UUID 必须被正确删除");
    const controlVisible = harness.readMain((db) => Number((db.prepare(`
      SELECT COUNT(*) AS n FROM healthkit_record_sources s JOIN health_records r ON r.id=s.record_id
      WHERE s.sample_uuid = ?`).get(controlUuid) as { n: number }).n));
    assert.equal(controlVisible, 1, "未删的保护对照必须保留");
    assert.equal(harness.readMain((db) => Number((db.prepare(
      "SELECT COUNT(*) AS n FROM import_source_tombstones WHERE source_identifier LIKE ?"
    ).get(`%${deletedUuid}%`) as { n: number }).n)), 1);

    const afterMain = readMainFacts(harness.databasePath);
    assert.equal(afterMain.rawGeneration, baselineMain.rawGeneration + 1, "成功批次 raw 只推进一次");
    assert.equal(afterMain.dependencyGeneration, baselineMain.dependencyGeneration + 1,
      "本批影响分析，dependency 只推进一次");
    assert.equal(afterMain.batches.length, 2);
    assert.equal(afterMain.receiptKeys.length, 2);
    assert.equal(afterMain.recomputeJobs.length, baselineMain.recomputeJobs.length + 1);

    // ── 同批同内容重放不改变任何事实/代次/回执。
    const beforeReplay = readP2Snapshot(harness.databasePath);
    const reupload = await restarted.upload(
      revisionZip, "p2-delete-gpx-kill-0001", "apple-health-healthkit-p2-kill.zip");
    const replay = await restarted.createJob(reupload.sourceId);
    assert.equal(replay.job.id, jobId, "重放必须命中同一任务");
    assert.deepEqual(replay.job.summary, recovered.summary, "重放必须返回原回执");
    assert.deepEqual(readP2Snapshot(harness.databasePath), beforeReplay, "重放不得改变任何表");
  } finally {
    await server.stop();
    harness.dispose();
  }
});

test("A05：COMMIT 后丢回复 ⇒ 重启从**持久回执**恢复成功（不重传、不重算、不留第二个终态说法）", async () => {
  const harness = createHarness("rai-direct-sync-http-kill-after-commit-");
  await prepareDatabase(harness);
  let server = await harness.start();
  const api = session(server.baseUrl);
  try {
    // 载荷与上一条强杀用例同尺：见 `KILL_FIXTURE_RECORDS` 的说明 —— 小载荷会让"杀进窗口"
    // 变成碰运气，而碰运气的用例会红在**有意义**的断言上（那次写的是"恢复路径必须自报家门"）。
    const xml = analysisLargeFixtureXml();
    assertWithinDirectSyncBounds(xml);
    const upload = await api.upload(healthKitZip(xml, syncManifest()), "kill-after-commit-0001",
      "apple-health-healthkit-lost-reply.zip");
    const created = await api.createJob(upload.sourceId);
    assert.equal(created.status, 202, JSON.stringify(created.job));
    const jobId = created.job.id;

    // 精确捕捉"COMMIT 已经落库、但父进程还没把终态写出去"的那一刻 —— 这正是真机上
    // "服务端提交了、手机没收到响应"的时序，也是 A05 要求能恢复的那个窗口。
    //
    // 🔴 判据必须包含**运行时状态仍是 running**，不能只看回执在不在：
    // 只等回执的话，等到的那一刻父进程可能已经把 `status: succeeded` 落进 runtime.sqlite 了 ——
    // 于是重启后走的是"读回自己写下的终态"，而不是"从持久回执恢复"，本用例就在**什么都没证明**
    // 的情况下变绿（第一次跑正是这样：断言 `message` 里出现「恢复」时红在了那句正常成功文案上）。
    // 所以窗口被显式钉住：回执已落库 **且** 持久化的任务状态还不是终态。
    //
    // 🔴 而且探测**只用一个常开的读者连接**，不每次开合：
    // 实测发现每次探测都 `new DatabaseSync(path, { readOnly: true })` 再 close 时，会周期性地
    // 撞上写者的连接初始化，让接收器直接以 `database is locked` 失败（原因见文件末尾那条说明）。
    // 那既不是本用例要测的东西，也不是真机上正常的竞争强度 —— 夹具不该自己制造生产上没有的噪声。
    const reader = new DatabaseSync(harness.databasePath, { readOnly: true });
    const receiptWith = (db: DatabaseSync): string | null =>
      (db.prepare("SELECT value FROM import_manifest WHERE key=?").get(receiptKey(jobId)) as { value?: string } | undefined)
        ?.value ?? null;
    let committedJson: string;
    try {
      committedJson = await waitForCondition(() => {
        const receipt = receiptWith(reader);
        if (receipt === null) return null;
        const state = runtimeJob(harness.runtimeStatePath, jobId);
        return state !== null && (state.status === "running" || state.status === "queued") ? receipt : null;
      }, {
        what: "COMMIT 之后、终态写出去之前（回执已落库且任务仍非终态）",
        intervalMs: 2,
        describe: () => JSON.stringify({
          receiptPresent: receiptWith(reader) !== null,
          job: runtimeJob(harness.runtimeStatePath, jobId),
          // 任务先失败时，失败原因只在子进程输出里 —— 不带上它，红的信息就只有"超时"。
          serverOutput: server.output().slice(-4000)
        })
      });
    } finally { reader.close(); }
    const committedSummary = JSON.parse(committedJson) as NonNullable<ImportJobResponse["summary"]>;
    assert.equal(committedSummary.directSync?.ingestStatus, "committed");
    assert.equal(runtimeJob(harness.runtimeStatePath, jobId)?.status, "running",
      "强杀必须落在「服务端提交了、但还没向客户端宣布成功」的那一刻");
    hardKill(server);
    await delay(200);

    const afterKill = readMainFacts(harness.databasePath);
    assert.deepEqual(afterKill.batches, [jobId]);
    assert.equal(afterKill.workouts, 1);
    assert.equal(afterKill.trainingSessions, 1);
    assert.equal(afterKill.rawGeneration, 1);

    server = await harness.start();
    const restarted = session(server.baseUrl);
    const recovered = await waitForTerminal(restarted, jobId, { what: "丢回复之后重启的任务终态" });
    assert.equal(recovered.status, "succeeded", JSON.stringify({ error: recovered.error, message: recovered.message }));
    // 🔴 恢复必须**逐字节**来自持久回执：这才是 §10.1「COMMIT后回复丢失 ⇒ 查询持久 receipt，返回同一成功」。
    assert.deepEqual(recovered.summary, committedSummary,
      "重启后的终态摘要必须与 COMMIT 时刻的持久回执逐字段相同");
    // 🔴 而且必须走的是**恢复**那条路径，不是"重新跑一遍后碰巧得到了同样的数字"。
    // 这两者的区别在真机上是可见的（「健康数据已保存」vs 又一次同步），所以它是协议事实而不是文案洁癖：
    // 重启出一个新任务/重放一次解析，都会在这里以"文案没自报恢复"的形式露出来。
    assert.match(recovered.message, /恢复/, `恢复路径必须自报家门，实际：${recovered.message}`);

    // 不重传、不重复应用：事实、代次、账本、分析任务全部原地不动。
    const afterRestart = readMainFacts(harness.databasePath);
    assert.equal(afterRestart.healthRecords, afterKill.healthRecords);
    assert.equal(afterRestart.workouts, 1);
    assert.equal(afterRestart.trainingSessions, 1);
    assert.deepEqual(afterRestart.batches, [jobId], "恢复不得写入第二个批次");
    assert.equal(afterRestart.rawGeneration, 1, "恢复不得推进代次（推了就是又应用了一次）");
    assert.equal(afterRestart.recomputeJobs.length, 1, "恢复不得重复登记分析任务");
    assert.equal(readReceiptJson(harness.databasePath, jobId), committedJson, "持久回执必须一字未改");
  } finally {
    await server.stop();
    harness.dispose();
  }
});

// ===========================================================================
// 5) 真机会话顺序的形状守卫（便宜、随单文件运行）
// ===========================================================================

test("会话身份：批次标识的合法性与 scoping 是 HTTP 层事实，不是客户端约定", async () => {
  const harness = createHarness("rai-direct-sync-http-batch-id-");
  await prepareDatabase(harness);
  const server = await harness.start();
  const api = session(server.baseUrl);
  try {
    // 非法批次标识必须**明确拒绝**，不能静默忽略（忽略了就等于把重放保护关掉）。
    const bad = await fetch(`${server.baseUrl}/v1/imports/uploads`, {
      method: "POST",
      headers: { "x-rai-sync-batch": "bad batch id!" },
      body: (() => {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(healthKitZip(workoutExportXml(), syncManifest()))],
          { type: "application/zip" }), "apple-health-healthkit-bad.zip");
        return form;
      })()
    });
    // 一次读取：body 只能消费一次，先拿文本再解析，别用 clone 绕。
    const badText = await bad.text();
    assert.equal(bad.status, 400, badText);
    assert.equal((JSON.parse(badText) as { code?: string }).code, "invalid_sync_batch_id");

    // 缺 header 时仍可上传（老客户端形态）：但**不**获得幂等身份 —— 两次上传是两条来源。
    const zip = healthKitZip(workoutExportXml(), syncManifest());
    const first = await api.upload(zip, "scoped-batch-0001", "apple-health-healthkit-scoped.zip");
    const second = await api.upload(zip, "scoped-batch-0001", "apple-health-healthkit-scoped.zip");
    assert.equal(second.sourceId, first.sourceId);
    // 不同批次标识 ⇒ 不同来源（这是"重放保护按批次"而不是"按内容"的直接证据）。
    const third = await api.upload(zip, "scoped-batch-0002", "apple-health-healthkit-scoped.zip");
    assert.notEqual(third.sourceId, first.sourceId);
  } finally {
    await server.stop();
    harness.dispose();
  }
});

test("夹具自身的时区口径：本地日期必须按 DATABASE_TIMEZONE 计算（canonical 窗口与读侧同源）", () => {
  // 这不是装饰性断言：canonical 窗口用 `localCalendarFormatter(DATABASE_TIMEZONE, "day")`，
  // 而隔离夹具里没有任何环境变量会改它。若哪天夹具开始设 TZ，这条会先红，
  // 而不是让 A17 的断言以"窗口差一天"的形式变得难以解释。
  assert.equal(typeof DATABASE_TIMEZONE, "string");
  assert.ok(DATABASE_TIMEZONE.length > 0);
});

// ---------------------------------------------------------------------------
// P2-5（2026-10-15）：目录被外部删除 + 来源从未导入 ⇒ 404（不再给乐观 `ready`）。
// ---------------------------------------------------------------------------

test("P2-5：目录缺失且从未导入 ⇒ inspect 404（iOS 走 sourceGone 分支自愈重传）", async () => {
  const harness = createHarness("rai-direct-sync-http-p25-");
  await prepareDatabase(harness);
  const server = await harness.start();
  const api = session(server.baseUrl);
  try {
    const receipt = await api.upload(
      healthKitZip(stepRecordXml(0), syncManifest()),
      "p2-5-batch-0001", "apple-health-healthkit-p25.zip"
    );
    // 模拟"上传后目录被外部清理"（运维清 var/imports / 磁盘回收）：来源仍在注册表、从未导入。
    removeTree(join(harness.root, "var", "imports", receipt.sourceId));
    // 旧行为：200 + `ready`（乐观）⇒ 客户端 startImport 必然 missing_required_files，
    // 多走一步注定失败的导入。新行为：404 ⇒ iOS sourceGone 分支 ⇒ 清任务重传（自愈）。
    const response = await api.post("/v1/imports/inspect", { sourceId: receipt.sourceId });
    const text = await response.text();
    assert.equal(response.status, 404, `期望 404（目录已不存在且从未导入），实际 ${response.status}：${text}`);
  } finally {
    await server.stop();
    harness.dispose();
  }
});
