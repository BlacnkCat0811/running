import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import {
  buildImportAudit, checkpointImportDatabase, databaseReadable, IMPORT_LANE_ATTEMPTS,
  type ImportDatabaseTask, type ImportLaneAttempt, type ImportLaneTimings, type ImportLanesInput,
  type ImportLanesOutcome, type IngestWorkerMessage
} from "./import-database-tasks.js";
import { applyDataOnlyImport, type DataOnlyImportInput } from "./data-only-import.js";
import { applyDirectSyncImport, isDirectSyncRejection, type DirectSyncImportInput } from "./direct-sync-ingest.js";
import { readImportIdentityInDatabase } from "./import-payload-identity.js";

/**
 * 常驻 **ingest Worker** 的线程入口（WP-41 / O12 第一、二阶段）。
 *
 * ## 为什么两条导入车道搬进同一个任务
 *
 * 从前主线程先投递 `data-only`、被拒收后再投递 `direct-sync` —— 那是**两次
 * `new Worker(...)`**，也就是两次 tsx 注册与模块加载。而两次尝试之间的顺序判据
 * （record-only 更严、必须先试）本来就是**同一条流水线里的先后**，把它放进线程内执行
 * 不改变任何闸门，也不再多付一次启动成本。
 *
 * 🔴 顺序仍然是被**校验**的，不是被相信的：{@link assertLanePlan} 只接受
 * `["data-only","direct-sync"]`，别的顺序直接抛错（fail-closed）。所以"为了少起线程而
 * 先跑宽车道"在结构上做不到，而不是靠注释提醒。
 *
 * ## 为什么线程是常驻的
 *
 * 一个 worker 线程的生命周期成本里，tsx 注册 + 模块加载是固定的大头，每批都新建一次等于
 * 每批都付一遍。常驻之后 `ready` 只发生一次，后续每批只发一条消息。
 * 代价是"线程会被复用" ⇒ 必须自己保证**任务之间不串**，见下。
 *
 * ## 任务之间如何不串（每一条都有对应测试）
 *
 * 1. **不跨任务缓存数据库连接／prepared statement**：每条车道自己 `RaiDatabase.open(...)`
 *    并在 `finally` 里关闭；本文件里没有任何模块级 `DatabaseSync`。任务抛错之后主线程还会
 *    **换掉整个线程**（retire），所以"上一批的异常"没有留在下一批的机会。
 * 2. **每个任务重新检查 scope／数据库身份／schema 与当前版本**（{@link surveyDatabase}）。
 *    四项各自落在能看见它的那一层：**scope** 是主线程的派发谓词
 *    （`ImportWorker.scheduleNext` 只挑 `queue.scope === queueOptions.scope` 的作业）；
 *    **数据库身份／schema／当前版本**在这里每个任务重读（换库／恢复由 `dev:ino` 认出来），
 *    而"有待应用迁移"由车道自己的 `RaiDatabase.open(..., { migrationPolicy: "refuse" })`
 *    直接拒绝 —— 旧 schema 不会被拿来接着写。
 * 3. **任务大数组不跨任务保留**：处理完把任务引用放掉，XML 文本这类大对象在回复之后可被
 *    回收；调查缓存**恰好一条**，不随批次数增长。
 * 4. **回复按 `taskId` 对应**：主线程不会把 A 批的结论记到 B 批头上。
 *
 * ⛔ 这个调查**刻意不含** `PRAGMA quick_check`（全库扫描是 §14.1 的禁止操作）：
 * `surveyDatabase` 只读 `import_manifest` 的几个键与文件身份。多一条"守卫看不见的全库检查"
 * 会让 `direct-sync-prohibited-operations.test.ts` 的"全 0"变成假绿 —— 那条守卫只看得到
 * 主线程投递的任务与 `RaiDatabase` 原型上的方法，看不到线程里的裸 SQL。
 *
 * ⚠️ 本文件在 worker 线程里运行；`parentPort` 为空时（被单测直接 import）只提供纯函数，
 * 不启动常驻循环。
 */

/** 车道计划校验：只允许已知的两条车道，且顺序恒为 record-only 在前。 */
export function assertLanePlan(plan: readonly ImportLaneAttempt[]): void {
  const expected = IMPORT_LANE_ATTEMPTS;
  const matches = plan.length === expected.length
    && plan.every((lane, index) => lane === expected[index]);
  if (!matches) {
    throw new Error(
      `Unsupported import lane plan: ${JSON.stringify(plan)} —— record-only 快通路的入口判据比统一接收器更严，`
      + "必须先被尝试；未知或颠倒的顺序一律拒绝执行（fail-closed）"
    );
  }
}

/**
 * 在**一个** worker 任务里跑完两条导入车道，并把「实际执行过的车道序列」带回去。
 *
 * 顺序与闸门与单车道时代逐条相同：
 *   1. `data-only`（记录白名单 + 基线合同戳 + 表写守卫 + 载荷身份复核）；
 *   2. 它返回 `null`（结构性拒收）才启动 `direct-sync`（统一接收器）；
 *   3. 接住的那条车道的结果原样回传；接收器**拒收**（非抛错）也原样回传。
 *
 * 每条车道拿到的是**各自一份**输入对象：即使某条车道就地改写自己的 `input`，
 * 也不可能把改写带给另一条车道（"不可变输入"的运行期形态）。
 */
export async function runImportLanesTask(input: ImportLanesInput): Promise<ImportLanesOutcome> {
  assertLanePlan(input.laneAttempts);
  const startedAt = performance.now();
  const laneMs: Partial<Record<ImportLaneAttempt, number>> = {};
  const laneAttempts: ImportLaneAttempt[] = [];
  /** 预检结果的不可变输入：每条车道一份，不共享可变引用。 */
  const laneInput = (): DataOnlyImportInput & DirectSyncImportInput => ({
    databasePath: input.databasePath,
    inputPath: input.inputPath,
    jobId: input.jobId,
    payloadSha256: input.payloadSha256,
    startedAtMs: input.startedAtMs
  });
  let directSyncStagesMs: Record<string, number> | undefined;
  const timings = (): ImportLaneTimings => ({
    laneMs: { ...laneMs }, taskMs: performance.now() - startedAt,
    ...(directSyncStagesMs === undefined ? {} : { directSyncStagesMs: { ...directSyncStagesMs } })
  });

  laneAttempts.push("data-only");
  const dataOnlyStarted = performance.now();
  const fast = await applyDataOnlyImport(laneInput());
  laneMs["data-only"] = performance.now() - dataOnlyStarted;
  if (fast) return { kind: "applied", lane: "data-only", laneAttempts, result: fast, timings: timings() };

  laneAttempts.push("direct-sync");
  const directStarted = performance.now();
  const direct = await applyDirectSyncImport(laneInput());
  laneMs["direct-sync"] = performance.now() - directStarted;
  // P2-3：只有提交成功的批次才带回四段账本；拒收没有"提交"这一段，如实不报。
  if (!isDirectSyncRejection(direct)) directSyncStagesMs = direct.stagesMs;
  if (isDirectSyncRejection(direct)) {
    return { kind: "rejected", laneAttempts, rejection: direct, timings: timings() };
  }
  return { kind: "applied", lane: "direct-sync", laneAttempts, result: direct, timings: timings() };
}

/** 任务分发（编译期穷尽守卫保留：给 `ImportDatabaseTask` 加了新 operation 却忘了这里 ⇒ 编译不过）。 */
export async function runImportDatabaseTask(task: ImportDatabaseTask): Promise<unknown> {
  switch (task.operation) {
    case "verify": return databaseReadable(task.path);
    case "audit": return buildImportAudit(task.path);
    case "checkpoint": return checkpointImportDatabase(task.path);
    case "import-lanes": return runImportLanesTask(task.input);
    default: {
      // 🔴 这个 default 今天不可达 —— 它守的是**将来**：`result` 保持 `undefined` 会被
      // 当作成功回传，调用方看到的是"没报错"，而不是"没执行"。下面这行 `never` 赋值让
      // 这种遗漏**编译不过**；万一有人用 `as` 绕过编译，运行期也会抛错而不是静默成功。
      const unsupported: never = task;
      throw new Error(`Unsupported import database task: ${JSON.stringify(unsupported)}`);
    }
  }
}

/** 数据库目标（换库／恢复的廉价判据：同一路径下 `dev:ino` 变了就是换了文件）。 */
interface DatabaseTarget {
  targetKey: string;
  fileSize: number;
  fileMtimeMs: number;
}

/** 每个任务重做的数据库调查：scope／身份／schema 与当前版本。 */
export interface DatabaseSurvey {
  target: DatabaseTarget | null;
  /** 同路径换了文件（恢复／换库）—— 上一批的调查结论必须作废。 */
  targetChanged: boolean;
  datasetVersion: string | null;
  contractVersion: string | null;
  identityAlgorithm: string | null;
}

function readDatabaseTarget(path: string): DatabaseTarget | null {
  try {
    const stat = statSync(path);
    return { targetKey: `${stat.dev}:${stat.ino}`, fileSize: stat.size, fileMtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * 每个任务**重新**读一遍数据库身份与 schema。
 *
 * ⛔ 这里刻意**不**做"目标没变就复用上次身份"的缓存：身份（`dataset_version`）正是每批
 * 都会推进的东西，缓存它等于把"当前版本"报成上一批的版本 —— 那正是这一步要防的。
 * 只保留**一条**上一次的调查用于"目标变了没有"的判据，且目标一变就随任务一起被替换，
 * 所以它不随批次数增长。
 */
export function surveyDatabase(path: string, previous: DatabaseSurvey | null): DatabaseSurvey {
  const target = readDatabaseTarget(path);
  const targetChanged = target !== null && previous?.target != null
    && previous.target.targetKey !== target.targetKey;
  const survey: DatabaseSurvey = {
    target, targetChanged, datasetVersion: null, contractVersion: null, identityAlgorithm: null
  };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    survey.datasetVersion = readImportIdentityInDatabase(database).datasetVersion;
    const rows = database.prepare(
      "SELECT key, value FROM import_manifest WHERE key IN ('parser_contract_version','parser_identity_algorithm')"
    ).all() as unknown as Array<{ key: string; value: string }>;
    for (const row of rows) {
      if (row.key === "parser_contract_version") survey.contractVersion = row.value;
      else if (row.key === "parser_identity_algorithm") survey.identityAlgorithm = row.value;
    }
  } catch {
    // 库不存在／尚不可读不是这个调查的失败面：车道自己会给出带码结论。
  } finally {
    database?.close();
  }
  return survey;
}

/** 常驻循环只在线程里启动（单测直接 import 本文件时 `parentPort` 为空）。 */
if (parentPort !== null && parentPort !== undefined) {
  const port = parentPort;
  /** 上一次任务的数据库调查（**恰好一条**，有界）。 */
  let previousSurvey: DatabaseSurvey | null = null;
  /** 换库／恢复被观测到的次数（诊断面）。 */
  let targetResets = 0;

  port.on("message", (message: IngestWorkerMessage) => {
    if (message.kind !== "task") return;
    const { taskId } = message;
    let task: ImportDatabaseTask | null = message.task;
    void (async () => {
      try {
        if (task.operation === "import-lanes") {
          const survey = surveyDatabase(task.input.databasePath, previousSurvey);
          if (survey.targetChanged) {
            targetResets += 1;
            process.stderr.write(
              "Ingest worker: database target changed between tasks "
              + `(${previousSurvey?.target?.targetKey ?? "none"} -> ${survey.target?.targetKey ?? "none"});`
              + " no connection, statement or survey from the previous task is carried over\n"
            );
          }
          previousSurvey = survey;
        }
        const value = await runImportDatabaseTask(task);
        port.postMessage({
          kind: "result", taskId, ok: true, value,
          rssKiB: Math.round(process.memoryUsage().rss / 1024), targetResets
        });
      } catch (error) {
        // 🔴 按 taskId 归因：绝不把"这一批失败了"做成"没人知道是哪一批"。
        const failure = error instanceof Error ? error : new Error(String(error));
        // 失败之后本线程**不再复用**（主线程收到 ok:false 会 retire 它）：上一批的异常
        // 可能留下半开的连接／锁，换一条线程比赌它干净便宜。
        port.postMessage({
          kind: "result", taskId, ok: false, error: failure.message,
          rssKiB: Math.round(process.memoryUsage().rss / 1024), targetResets
        });
      } finally {
        // 大数组（XML 文本等）由车道的局部变量持有；这里把任务引用也放掉，让它在回复
        // 之后可被回收，而不是挂在常驻线程的闭包里。
        task = null;
      }
    })();
  });

  // 🔴 第一条消息就是 `ready`：它之后主线程才开始计时——于是"启动／tsx 注册"与
  // "车道执行"在账本上是两段，省下的启动成本可以被**测量**而不是被声称。
  port.postMessage({ kind: "ready", startupMs: 0 });
}
