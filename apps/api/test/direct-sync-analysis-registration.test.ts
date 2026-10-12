// 🔴 地雷门禁：今天把 `import` 类型任务登记进直连车道，**不是"积压"，是立刻失败**。
//
// 背景（负责人初稿把这一点写反了，见 docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md 步骤 6b）：
// 设计文档原本写"没有分析消费者，登记只会积压一堆 queued 行"。核实结果是**错的**：
//   - 消费者存在：apps/api/src/recompute-worker.ts:75 调 hasPendingJob()，
//     packages/application/src/service.ts:283 claimNext() 是真正的消费者；
//   - 但 service.ts:287-293 只认识 full_recompute / snapshot_refresh，
//     `import` 落进 `else` 抛 `Unsupported application job type: import`，
//     随后 service.ts:296 把任务置为 failed。
// ⇒ 今天登记 `'import'` 任务 = 消费者领走后**立刻置为 failed**（用户可见的失败任务）。
//
// 本文件把这个结论钉成**可执行事实**：将来谁给消费者加上 `import` 分支（= 具备了登记的前提），
// 这条测试会立刻变红，逼他**同批**改这里（并把 6b 的上线顺序接上）。
// 这不是"防止功能"，是"防止悄悄半落地"——先有消费者能处理 `import`，才允许登记。
//
// ⛔ 硬约束（今天不许真的登记）：本文件同时钉住
//   - `planDirectSyncLane` 仍只能给出 `deltaMode: "record-only"`；
//   - 直连回执的 `analysisStatus` 仍是 `"not_required"`（不是 `"queued"`）。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RaiApplicationService } from "@rai/application";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";

import { planDirectSyncLane } from "../src/direct-sync-plan.js";
import { balancedBlock, readStripped, sourceFiles } from "./source-scan.js";

test("今天 `import` 类型任务会被消费者领走并立刻置为 failed（原因：不支持的作业类型）", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-analysis-job-guard-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const repository = new RecomputeJobRepository(store.database);
    const jobId = repository.enqueue("import", null, { source: "direct-sync-probe" });
    assert.equal(repository.get(jobId)?.status, "queued");

    // 与真实 worker 同一条路径：worker 先看 hasPendingJob()，再由 runNextJob() 消费。
    assert.equal(repository.hasPending(), true, "登记后应当被识别为待处理任务");

    const service = new RaiApplicationService(store);
    const result = service.runNextJob();

    // 阳性对照：结果**必须是被这个 jobId 消费出来的**，而不是"没有任务 ⇒ 返回 null 也算通过"。
    assert.equal(result?.id, jobId, "runNextJob 必须消费到刚登记的 import 任务");
    assert.deepEqual(
      { status: result?.status, progressPhase: result?.progressPhase },
      { status: "failed", progressPhase: "failed" }
    );
    // 断言**具体的失败原因**，而不是只断言"失败了"——后者对任何 pipeline 报错都会通过。
    assert.deepEqual(result?.error, {
      message: "Unsupported application job type: import",
      name: "Error"
    });

    // 证明它**被消费者领走过**（而不是被 failOutstanding 之类的旁路置失败）。
    const phases = repository.listEvents(jobId).map(({ phase }) => String(phase));
    assert.ok(phases.includes("claimed"), `事件里应有 claimed，实际：${phases.join(",")}`);
    assert.ok(phases.includes("failed"), `事件里应有 failed，实际：${phases.join(",")}`);

    // 消费者只认识 full_recompute / snapshot_refresh，所以这条队列到此清空。
    assert.equal(repository.hasPending(), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("直连车道今天仍只能是 record-only（未接登记，故不得放开 deltaMode）", () => {
  const decision = planDirectSyncLane({
    queued: true,
    fastPathEnabled: true,
    engine: { name: "typescript", version: "1.2.3" },
    nativeVersion: "1.2.3",
    preserveAbsent: true,
    databaseExists: true
  });
  // 六条件全满足才走直连，且直连的唯一事实范围是 record-only。
  // 放开 `"full"` 必须**同批**接上分析任务登记（步骤 6b）。
  assert.deepEqual(decision, { lane: "direct", deltaMode: "record-only", reasons: [] });
});

test("直连回执的 analysisStatus 仍是 not_required（今天没有登记，就不能声称 queued）", () => {
  // ⚠️ 这是一条**源码级**守卫，不是行为级。它的用途是"便宜地钉住唯一产出直连回执的地方"：
  // applyDataOnlyImport 里那个 `directSync: { ... }` 字面量一旦被改成 `"queued"`，这里立刻红。
  // 🔴 权威的**行为级**守卫是 apps/api/test/direct-sync-prohibited-operations.test.ts:299
  //    （跑完整直连导入并断言 receipt.analysisStatus === "not_required"）。两者并存：
  //    源码守卫便宜、随单文件运行；行为守卫是真跑。谁都不替代谁。
  //
  // ⚠️ 覆盖缺口（红队 red-team-2 指出）：本守卫只扫 data-only-import.ts，行为守卫只跑 data-only
  //    这一条车道 ⇒ 二者对"**新增第二个直连回执产出方**"都是盲的。该盲区已由下一条用例
  //    （唯一产出方扫描）从"整片盲区"收窄到"必须用非 `{` 直写才能绕过"；但仍**不是**运行期结论。
  const source = readStripped(new URL("../src/data-only-import.ts", import.meta.url));
  const marker = source.indexOf("directSync:");
  assert.ok(marker >= 0, "data-only-import.ts 里找不到 directSync 回执字面量");
  // 🔴 必须要求 `{` **紧邻** `directSync:`（只隔空白）。否则一旦值被改成函数调用/变量，
  // `indexOf("{", marker)` 会锚到之后**任意**一个 `{` 块 —— 若那个块恰好含
  // `analysisStatus: "not_required"`，守卫就会**假绿**（红队复现的形态 C：
  // `directSync: buildReceipt(), other:{analysisStatus:"not_required"}`）。
  // 所以"回执必须是内联对象字面量"本身也是被断言的事实：改成函数/变量会让这条变红。
  const open = source.indexOf("{", marker);
  assert.equal(
    source.slice(marker + "directSync:".length, open).trim(),
    "",
    "`directSync:` 的值不再是内联对象字面量 —— 本源码守卫会锚错块而假绿；" +
      "请把守卫改成能解析新出处（或改为行为级断言），不要只改这里让它变绿"
  );
  const block = balancedBlock(source, open);
  assert.match(block, /analysisStatus:\s*"not_required"/);
  assert.doesNotMatch(block, /analysisStatus:\s*"queued"/);
});

test("`directSync` 直连回执今天只有一个产出方（新增第二个即红）", () => {
  // 收窄上一条用例的盲区：`\bdirectSync\s*:\s*\{` 在所有 src 里只允许命中 data-only-import.ts。
  // 为什么这条判据不误伤类型声明：`packages/api-contracts/src/index.ts` 的 `directSync?: DirectSyncReceipt;`
  // 在 `directSync` 与 `:` 之间是 `?`，正则 `\s*:` 匹配不上（红队独立核对过，我也复跑确认）。
  // 为什么加 `(?<!["'\w])`：`source-scan` 的 `stripComments` **保留字符串字面量**，所以
  // 某个 src 文件只要写一条含 `directSync: {` 的**双引号**日志串，这条门禁会无辜转红；
  // lookbehind 排除"前一字符是引号/词字符"的情况，真产出方（前接空白/`{`/换行）仍命中。
  // ⚠️ 仍是**源码级**：用非 `{` 直写（函数返回值 / 变量 / shorthand）或**反引号串**仍能绕过
  //    （`stripComments` 只跳双引号串）—— 但那是显式跳出本判据，比"整片盲区"好得多。
  //    要真闭死需要运行期"唯一来源"断言（本步不做，记为技术债）。
  const root = new URL("../../../", import.meta.url);
  const rootPath = fileURLToPath(root);
  const packageSources = readdirSync(new URL("packages/", root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => new URL(`packages/${entry.name}/src/`, root));
  const roots = [new URL("apps/api/src/", root), ...packageSources]
    .filter((candidate) => existsSync(candidate));
  const producers = new Set<string>();
  for (const file of roots.flatMap((candidate) => sourceFiles(candidate))) {
    if (/(?<!["'\w])directSync\s*:\s*\{/.test(readStripped(file))) producers.add(relative(rootPath, file));
  }
  assert.deepEqual(
    [...producers].sort(),
    ["apps/api/src/data-only-import.ts"],
    "出现了第二个 `directSync` 产出方：上一条源码守卫只会扫 data-only-import.ts，" +
      "新产出方不会被它覆盖 —— 请把新产出方一并纳入守卫（或改为运行期唯一来源断言）"
  );
});
