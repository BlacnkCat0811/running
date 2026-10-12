// `recoverInterrupted()` 必须按「**谁能执行**」分派，而不是按「是不是 running」。
//
// 🔴 这条缺陷是 2026-10-12 红队发现的，且**不依赖任何新功能就能触发**：
//   `packages/health-export-parser/src/cli.ts:336-340` 为每次 CLI 导入创建一条
//   `job_type='import', status='running'` 的任务；CLI 进程崩溃（或机器掉电）后该任务停在
//   `running`；API 下次启动在 `server.ts:568` 调 `recoverInterrupted()`，它**不过滤 job_type**，
//   一律把 running 放回 `queued` 并**清掉 `error_json`**；
//   随后唯一那个消费者（`DatasetService.runNextJob`，只认 full_recompute / snapshot_refresh）
//   把 `import` 领走，从 `else` 分支抛错并置为 failed。
//   实测的最终状态：`{status:'failed', progress_phase:'failed', error:{message:"Unsupported application job type: import"}}`
//   —— 用户看到的是一条**原因错误**的失败任务，而真正的中断原因已被恢复流程擦掉。
//
// ⇒ CLI 导入任务没有第二个消费者，中断即终态。恢复应把它判为失败并**保留**中断原因。
//
// ⚠️ 本文件刻意带一条**负向对照**（可消费类型必须仍回到队列）：只断言"import 不再被放回队列"
// 是无法区分的 —— 把整段恢复逻辑删掉、或让它把一切都判失败，都能让那条断言通过。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPLICATION_CONSUMABLE_JOB_TYPES, EXTERNALLY_OWNED_JOB_TYPES } from "@rai/contracts";
import { RaiDatabase } from "../src/database.js";
import { RecomputeJobRepository } from "../src/recompute-job-repository.js";

async function withJobs(run: (jobs: RecomputeJobRepository, store: RaiDatabase) => void) {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-recovery-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try { run(new RecomputeJobRepository(store.database), store); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

/** 造一条"崩溃时停在 running"的任务，与 CLI 建的那条同形。 */
function insertRunning(store: RaiDatabase, id: string, jobType: string, cancelRequested = 0): void {
  store.database.prepare(`
    INSERT INTO recompute_jobs (
      id, job_type, status, request_json, progress_phase, started_at, cancel_requested
    ) VALUES (?, ?, 'running', '{"mode":"cli_export_import"}', 'prepare', ?, ?)
  `).run(id, jobType, "2026-10-12T00:00:00.000Z", cancelRequested);
}

function jobState(store: RaiDatabase, id: string): { status: string; phase: string; errorJson: string | null } {
  return store.database.prepare(
    "SELECT status, progress_phase AS phase, error_json AS errorJson FROM recompute_jobs WHERE id = ?"
  ).get(id) as { status: string; phase: string; errorJson: string | null };
}

test("中断的 CLI 导入任务被判为失败，并保留中断原因（不再被放回没人能跑的队列）", () => {
  withJobs((jobs, store) => {
    insertRunning(store, "cli-import", "import");
    assert.equal(jobs.recoverInterrupted(), 1);

    const state = jobState(store, "cli-import");
    assert.equal(state.status, "failed", "外部所有者类型的中断任务不得被放回 queued");
    assert.equal(state.phase, "interrupted");
    // 原因必须是**这件事的真因**，而不是消费者那句 "Unsupported application job type"
    // （那是"队列里混进了没人能跑的活"，把真因说丢了），
    // 也不能是 recompute 的文案（"API 在 recompute 完成前重启" —— 这条任务不是 recompute）。
    assert.ok(state.errorJson, "中断原因必须留下，不得像旧实现那样把它清成 null");
    const reason = JSON.parse(state.errorJson!) as { name: string; message: string };
    assert.equal(reason.name, "InterruptedExternalJob",
      "外部所有者类型的中断原因必须有**自己的**名字，不能借用 InterruptedRecompute");
    assert.match(reason.message, /owning process/i);
    assert.doesNotMatch(reason.message, /recompute/i, "导入任务的中断原因里不该出现 recompute");

    // 端到端后果：恢复之后，那个消费者再也拿不到这条任务。
    assert.equal(jobs.claimNext(), null, "恢复后队列里不该还有可被消费者领走的任务");
  });
});

test("负向对照：可消费类型的中断任务仍然回到队列（既有行为不许被改坏）", () => {
  withJobs((jobs, store) => {
    insertRunning(store, "recompute", "full_recompute");
    store.database.prepare(
      "UPDATE recompute_jobs SET cancel_requested = 0 WHERE id = ?"
    ).run("recompute");
    assert.equal(jobs.recoverInterrupted(), 1);

    const state = jobState(store, "recompute");
    assert.equal(state.status, "queued");
    assert.equal(state.phase, "recovered");
    assert.equal(state.errorJson, null, "回到队列的任务不应带上失败原因");
    // 🔴 逐列钉住"可消费类型**零行为变化**"：只断言 `status='queued'` 是不够的 ——
    // 分段改动完全可能顺手把 `completed_at` / `started_at` 写坏，而那会让"回到队列"的任务
    // 看起来已经收尾（`completed_at` 非空）或正在跑（`started_at` 非空）。
    // 这条也解释了为什么全量门禁里 `server-runtime.test.ts` 那条恢复用例**不可能**是本次改动引起的：
    // 它用的正是 `full_recompute`，而这条分支与旧代码逐列相同。
    const full = store.database.prepare(`
      SELECT started_at AS startedAt, completed_at AS completedAt,
             progress_current AS current, progress_total AS total, cancel_requested AS cancelRequested
      FROM recompute_jobs WHERE id = 'recompute'
    `).get() as { startedAt: string | null; completedAt: string | null; current: number; total: number; cancelRequested: number };
    assert.deepEqual({ ...full },
      { startedAt: null, completedAt: null, current: 0, total: 0, cancelRequested: 0 });
    assert.equal(jobs.claimNext()?.jobType, "full_recompute", "它必须仍然可被消费者领取");
  });
});

test("负向对照：已请求取消的中断任务仍走 cancelled 分支", () => {
  withJobs((jobs, store) => {
    insertRunning(store, "cancelled-import", "import", 1);
    assert.equal(jobs.recoverInterrupted(), 1);

    const state = jobState(store, "cancelled-import");
    assert.equal(state.status, "cancelled");
    assert.equal(state.phase, "cancelled");
  });
});

test("结构约束：DDL 里声明的每个 job_type 都必须有意表态（可消费 / 有外部所有者）", () => {
  withJobs((_jobs, store) => {
    // 从**生产 DDL** 取类型清单，而不是从 TypeScript 联合类型（后者运行时不存在，
    // 且改了类型不改 DDL 的情况正是要抓的）。
    const ddl = (store.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recompute_jobs'"
    ).get() as { sql: string }).sql;
    const declared = [...(/job_type\s+IN\s*\(([^)]*)\)/.exec(ddl)?.[1] ?? "").matchAll(/'([^']+)'/g)]
      .map((match) => match[1] ?? "");
    assert.ok(declared.length >= 3, `没能从 DDL 解出 job_type 取值：${ddl}`);

    const covered = new Set<string>([
      ...APPLICATION_CONSUMABLE_JOB_TYPES,
      ...EXTERNALLY_OWNED_JOB_TYPES.map((entry) => entry.jobType)
    ]);
    assert.deepEqual(
      declared.filter((jobType) => !covered.has(jobType)),
      [],
      "新增了既没有消费者、也没有声明外部所有者的 job_type —— 恢复流程不知道该拿它怎么办：" +
      "要么给 DatasetService.runNextJob 加分支并加进 APPLICATION_CONSUMABLE_JOB_TYPES，" +
      "要么在 EXTERNALLY_OWNED_JOB_TYPES 里写明谁拥有它"
    );
    // 两边的声明不许重叠：一个类型不可能既"消费者能跑"又"消费者跑不了"。
    const overlap = APPLICATION_CONSUMABLE_JOB_TYPES.filter((jobType) =>
      EXTERNALLY_OWNED_JOB_TYPES.some((entry) => entry.jobType === jobType));
    assert.deepEqual(overlap, [], "同一个 job_type 不得同时出现在两个清单里");
  });
});
