// 🔴 门禁：直连车道的「登记分析任务」与「放开 deltaMode」必须**同批**落地。
//
// 背景（2026-10-12，设计文档步骤 6b）：把 `import` 类型任务登记进直连车道**不是"积压"，是立刻失败** ——
// 消费者（`DatasetService.runNextJob`）当时只认识 full_recompute / snapshot_refresh，
// `import` 落进 `else` 抛 `Unsupported application job type: import`，随后被置为 failed（用户可见的失败任务）。
// 当时本文件把这条结论钉成可执行事实，用来逼"步骤 1"落地时**同批**接上步骤 2、3。
//
// 现状（2026-10-13）：设计文档那三步上线顺序的**第 1 步已落地** ——
// 消费者认识 `import` 了，但只认**直连分析载荷**（`isApplicationConsumableJob` 按
// `(job_type, 载荷 mode)` 合取判别）。所以本文件改为钉住**新的**四件事，
// 继续防止"只让消费者不再报错"式的半落地：
//   1. 消费者对直连分析载荷**真的跑分析**；对 CLI 载荷**说清原因地拒绝**（不再是 Unsupported）；
//   2. 直连车道**今天仍然不登记**任何分析任务（行为级，见 direct-sync-prohibited-operations.test.ts）；
//   3. `planDirectSyncLane` 仍只能给出 `deltaMode: "record-only"`；
//   4. 直连回执的 `analysisStatus` 仍是 `"not_required"`（没有登记，就不能声称 queued）。
// 谁要放开 3 或 4，必须同批把 1、2 一起做完（登记 + 代次绑定 + 读侧一致性），而不是只改判据。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLI_OWNED_IMPORT_REQUEST_MODE,
  DIRECT_SYNC_ANALYSIS_REQUEST_MODE
} from "@rai/contracts";
import { RaiApplicationService } from "@rai/application";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";

import { planDirectSyncLane } from "../src/direct-sync-plan.js";
import { balancedBlock, readStripped, sourceFiles } from "./source-scan.js";

async function withStore<T>(run: (store: RaiDatabase) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rai-analysis-job-guard-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    return await run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function counts(store: RaiDatabase): { featureRuns: number; modelRuns: number } {
  return {
    featureRuns: Number(store.database.prepare("SELECT COUNT(*) AS n FROM feature_runs").get()!.n),
    modelRuns: Number(store.database.prepare("SELECT COUNT(*) AS n FROM model_runs").get()!.n)
  };
}

test("步骤 1：消费者认识 `import`，直连分析载荷会被**真正执行**（不再是 Unsupported）", async () => {
  await withStore(async (store) => {
    const repository = new RecomputeJobRepository(store.database);
    const jobId = repository.enqueue("import", null, { mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE });
    assert.equal(repository.get(jobId)?.status, "queued");
    assert.equal(repository.hasPending(), true, "登记后应当被识别为待处理任务");

    const result = new RaiApplicationService(store).runNextJob();
    // 阳性对照：结果必须是被这个 jobId 消费出来的，而不是"没有任务 ⇒ 返回 null 也算通过"。
    assert.equal(result?.id, jobId, "runNextJob 必须消费到刚登记的 import 任务");
    assert.notDeepEqual(result?.error, {
      message: "Unsupported application job type: import",
      name: "Error"
    }, "步骤 1 已落地：消费者不得再把 `import` 当成不支持的作业类型");
    // 🔴 判据是"**真的跑完了分析**"，不是"没报那个错"：只断言 notDeepEqual 的话，
    // 把失败原因换成任何别的字符串都能通过。所以断言终态成功 + 分析产物落地 + 发布指针被移动。
    assert.equal(result?.status, "succeeded", JSON.stringify(result?.error));
    assert.equal(result?.progressPhase, "completed");
    assert.ok(counts(store).featureRuns > 0 && counts(store).modelRuns > 0,
      "分析必须真的产出 feature/model run");
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS n FROM active_model_run").get()!.n), 1,
      "跑完分析必须移动活跃发布指针（旧 release 仍可读）");
  });
});

test("步骤 1 的边界：CLI 载荷被消费者**拒绝**，且不会跑分析（原因说清，不是 Unsupported）", async () => {
  await withStore(async (store) => {
    const repository = new RecomputeJobRepository(store.database);
    const jobId = repository.enqueue("import", null, { mode: CLI_OWNED_IMPORT_REQUEST_MODE });

    const result = new RaiApplicationService(store).runNextJob();
    assert.equal(result?.id, jobId);
    assert.equal(result?.status, "failed");
    const message = String((result?.error as { message?: unknown } | null)?.message ?? "");
    assert.match(message, /not consumable by the application service/i,
      `失败原因必须说清"这条活不属于这个消费者"，实际：${message}`);
    assert.match(message, /cli_export_import/i, "失败原因必须点名是哪种载荷");
    assert.doesNotMatch(message, /Unsupported application job type/i,
      "`import` 现在是已知类型；再报 Unsupported 就是把「不属于这个消费者」说成「没人实现」");
    // "不会跑分析"必须是可观测的：一个 feature run 都不许产生。
    assert.deepEqual(counts(store), { featureRuns: 0, modelRuns: 0 },
      "CLI 载荷被拒绝时不得产生任何分析产物");
  });
});

test("直连车道的事实范围是 full，且 worker **真的**有调用方（放开判据 ≠ 接上车道）", () => {
  const decision = planDirectSyncLane({
    queued: true,
    fastPathEnabled: true,
    engine: { name: "typescript", version: "1.2.3" },
    nativeVersion: "1.2.3",
    preserveAbsent: true,
    databaseExists: true
  });
  // 六条件全满足才走直连；事实范围是 full（Workout / 评分类型 / 显式删除 / GPX 都能装下）。
  assert.deepEqual(decision, { lane: "direct", deltaMode: "full", reasons: [] });

  // 🔴 只有上面这一条是不够的：把判据改成 "full" 而 worker 仍然只投递 `data-only`，
  // 行为上等于"车道窄了但标签宽了" —— 一个 Workout 载荷会被 record-only 车道拒收并掉回
  // 旧候选链路（整库备份 + 换库）。所以这里同时钉住**调用方存在**与**顺序**：
  // 先 record-only（它的入口判据更严），拒收之后必须走统一接收器，最后才允许回退旧链路。
  const worker = readStripped(new URL("../src/import-worker.ts", import.meta.url));
  const dataOnly = worker.indexOf('operation: "data-only"');
  const directSync = worker.indexOf('operation: "direct-sync"');
  assert.ok(dataOnly >= 0, "import-worker.ts 里找不到 data-only 车道的投递点");
  assert.ok(directSync >= 0,
    "import-worker.ts 里找不到 `direct-sync` 的投递点 —— deltaMode 放开了却没有调用方，" +
    "接收器（direct-sync-ingest.ts）就是死代码，Workout 载荷仍会掉回旧候选链路");
  assert.ok(dataOnly < directSync,
    "顺序反了：record-only 车道的入口判据（白名单 + 基线合同戳）比统一接收器更严，" +
    "必须先试它；反过来会让那两道闸门失去意义");
  assert.match(worker.slice(directSync), /fastPathAttempted = false/,
    "两条直连车道都拒收之后才允许回退旧链路 —— `fastPathAttempted` 清零的位置是这条顺序的证据");
});

test("两条车道的回执各守各的：record-only 恒 not_required；统一接收器按分类取 queued/not_required", () => {
  // 🔴 2e 之后"回执必须是 not_required"不再是**车道级**事实 —— 它变成**批次级**事实：
  //   · record-only 快通路（data-only-import.ts）：入口就证明了载荷碰不到分析 ⇒ 恒 not_required；
  //   · 统一接收器（direct-sync-ingest.ts）：按账本分类取 queued / not_required，且
  //     "声称 not_required 却登记了任务"会在提交前直接抛错（下一条用例钉住那两句断言）。
  // 所以本用例只继续守第一条车道，第二条交给行为级用例（direct-sync-ingest.test.ts 两种分类各一条）。
  // ⚠️ 这是一条**源码级**守卫，不是行为级。它的用途是"便宜地钉住 record-only 回执的产出点"：
  // applyDataOnlyImport 里那个 `directSync: { ... }` 字面量一旦被改成 `"queued"`，这里立刻红。
  // 🔴 权威的**行为级**守卫是 apps/api/test/direct-sync-prohibited-operations.test.ts
  //    （跑完整直连导入并断言 receipt.analysisStatus === "not_required"，以及
  //     `recompute_jobs` 里没有新任务）。两者并存：源码守卫便宜、随单文件运行；行为守卫是真跑。
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

test("统一接收器：回执的 analysisStatus 与登记**在同一个事务里互相印证**（半落地即红）", () => {
  // 这一条守的是"deltaMode full ⇒ 回执不许说假话"。判据不是"文本里有 queued"，
  // 而是**提交前的双向断言真的存在**：
  //   · 需要分析 ⇒ 必须存在 queued 任务、绑定列与载荷 mode 逐项相符；
  //   · 不需要分析却存在任务 ⇒ 直接抛错（"声称 not_required 却登记了任务"）。
  // 3 条都要在，缺任何一条都会留下一种半落地：登记了却写 not_required（§9.1 的假新鲜）、
  // 或者声称 queued 却没有任务（用户看到永远不跑的分析）。
  const source = readStripped(new URL("../src/direct-sync-ingest.ts", import.meta.url));
  assert.match(source, /analysisStatus:\s*analysisRequired\s*\?\s*"queued"\s*:\s*"not_required"/,
    "统一接收器的回执必须由 classification 推导，不得写死字面量");
  assert.match(source, /Direct sync analysis job failed its pre-commit assertion/,
    "缺少\"需要分析时任务必须存在且绑定相符\"的提交前断言");
  assert.match(source, /Direct sync batch registered an analysis job while claiming not_required/,
    "缺少\"声称 not_required 却登记了任务\"的反向断言 —— 少了它，回执可以与登记脱钩");
  assert.match(source, /Direct sync receipt failed its pre-commit assertion/,
    "缺少\"持久回执必须与本次 summary 一致\"的断言");
});

test("`directSync` 直连回执今天只有两个产出方（新增第三个即红）", () => {
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
  // 两个产出方：
  //   · `data-only-import.ts` —— record-only 快通路，回执恒为 `not_required`（源码守卫 + 行为守卫）；
  //   · `direct-sync-ingest.ts` —— 统一接收器（PR4 2c/2d），回执按分类取 `queued` / `not_required`
  //     （**行为**守卫在 `apps/api/test/direct-sync-ingest.test.ts`，两种分类各一条）。
  // ⚠️ 上一条源码守卫**只扫第一个**：第二个的判据是行为级的，不是文本级的。
  // 新增第三个产出方时，必须同时说清它的回执语义由谁守 —— 否则这里只是让它变绿。
  assert.deepEqual(
    [...producers].sort(),
    ["apps/api/src/data-only-import.ts", "apps/api/src/direct-sync-ingest.ts"],
    "出现了第三个 `directSync` 产出方：上一条源码守卫只会扫 data-only-import.ts，" +
      "新产出方不会被它覆盖 —— 请把新产出方一并纳入守卫（或改为运行期唯一来源断言）"
  );
});
