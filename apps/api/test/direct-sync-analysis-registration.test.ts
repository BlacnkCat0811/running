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
