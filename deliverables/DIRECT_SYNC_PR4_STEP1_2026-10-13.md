# 直接增量同步 PR4 步骤 1：消费者认识 `import` 分析任务（2026-10-13）

依据：[SQLITE 直接增量同步设计](../docs/SQLITE_DIRECT_SYNC_DESIGN.md) §13 PR4、
[PR2+PR3 落地设计](../docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md) 步骤 6b 的三步上线顺序、
[PR4 落地设计](../docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md)（本轮新增）。

**范围**：设计文档要求的上线顺序里**第 1 步**（消费者先认识 `import`，且只认直连分析载荷）。
**不在本轮**：登记分析任务、放开 `deltaMode: "full"`、短写调度、局部 canonical —— 见 PR4 设计 §7。

---

## 1. 改了什么（4 处产品代码 + 3 处测试/门禁）

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/index.ts` | 新增载荷判别物常量（`cli_export_import` / `direct_sync_analysis`）、`RECOMPUTE_JOB_TYPE_DISPOSITIONS`、`PAYLOAD_SCOPED_JOB_OWNERSHIP`、`recomputeRequestMode`、`isApplicationConsumableJob`；**删除**按类型一刀切的 `APPLICATION_CONSUMABLE_JOB_TYPES` / `EXTERNALLY_OWNED_JOB_TYPES` |
| `packages/storage-sqlite/src/recompute-job-repository.ts` | `recoverInterrupted()` 读 `request_json`，按 `(job_type, 载荷 mode)` 合取分派 |
| `packages/application/src/service.ts` | 消费者在分支**之前**做准入判定；`import` 分支接 `runDirectSyncAnalysis`；拒绝原因点名载荷 |
| `packages/application/src/services/recompute-pipeline.ts` | 新增 `runDirectSyncAnalysis`（复用既有 feature/metric/model 计算与全部发布 gate） |
| `packages/health-export-parser/src/cli.ts` | CLI 任务写**共享常量**，不再写字面量（防两边分叉） |
| `apps/api/test/direct-sync-analysis-registration.test.ts` | 原来的"地雷门禁"（断言 `import` 必然 failed）改写为**新状态**的四条判据 |
| `apps/api/test/direct-sync-prohibited-operations.test.ts` | 新增行为级断言：直连车道跑完 `recompute_jobs` 计数为 0 |
| `packages/storage-sqlite/test/recompute-job-recovery.test.ts` | 新增两条（直连载荷回队列 / 未知载荷不放行）+ 结构约束升级；并修掉一条**既有**测试缺陷 |

## 2. 为什么判据必须从"类型"升级为"类型 + 载荷"

`'import'` 是**两个所有者共用的类型名**：旧 CLI 导入进程在写它，新的直连分析任务也要写它
（v35 文件头明令禁止放宽 `job_type` 的 `CHECK`，所以不能靠新增类型名区分）。只按类型分派会两头误伤：

- 中断的 CLI 导入任务被放回队列 ⇒ 消费者把它当分析任务跑（本轮之前它会被判 `failed`，
  且原始中断原因被恢复流程清掉 —— 那正是 2026-10-12 修掉的缺陷）；
- 直连分析任务中断 ⇒ 没有消费者认领，`§10.1` 的"重启从 analysis jobs 恢复"落空。

现在的合取判据是**白名单**：未知/缺失载荷**默认不放行**（不是"不是 CLI 就放行"）。

## 3. 实测证据

- `tsc --noEmit`（`tsconfig.pure.json` + `tsconfig.json`）：**EXIT=0**。
- 定向用例（`node --import tsx --test --test-concurrency=1`）：
  - `apps/api/test/direct-sync-analysis-registration.test.ts`：**5/5 pass**
  - `packages/storage-sqlite/test/recompute-job-recovery.test.ts`：**6/6 pass**
  - `apps/api/test/direct-sync-prohibited-operations.test.ts`：**6/6 pass**
  - `packages/application/test/*`（5 个文件）：**36/36 pass**
- 阳性对照（"真的跑了分析"，不是"没报那个错"）：直连载荷 ⇒ 任务 `succeeded`、feature/model run
  落地、`active_model_run` 计数 1；CLI 载荷 ⇒ `failed` 且 `feature_runs`/`model_runs` **均为 0**。
- 长跑实证：空库上一条 `import` 直连分析载荷端到端跑完（probe 输出 `status: succeeded`）。

### 3.1 全量套件（本机，`RAI_TEST_CONCURRENCY=1`）

| 套件 | 结果 | 说明 |
|---|---|---|
| Node（236 个测试文件） | **1676 tests / 1672 pass / 1 fail / 3 skipped** | 唯一失败见下：**环境缺 `npm`**，不是本批回归 |
| Web（vitest，25 个文件） | 全量跑时 1 fail（`share-card-panel.test.tsx` 的 `waitFor` 超时）；**套件单独跑 184/184 pass**，该文件单独跑 17/17 | 负载下的计时抖动，不是本批改动（本批未碰任何 Web 代码） |
| `tsc --noEmit`（pure + full） | EXIT=0 | |
| `check:doc-refs` / `check:docs` | 0 处越界 / 0 problems | 含本轮新增的 PR4 设计文档 |

**唯一那条 Node 失败的环境归因（可复核）**：`apps/api/test/node-version.test.ts` 的
"every public runtime command executes the Node gate through npm lifecycle hooks" 用
`spawnSync("npm", ["run","--silent","predev:api"])` 验证生命周期钩子；本机的 Node 运行时
**只带了 `node`，没有 `npm`**（`command -v npm` 退出码 1；运行时目录下只有 `node` 与一份
`README.txt`）⇒ `status === null`（ENOENT），断言报 `npm run --silent predev:api failed: undefined`。
独立交叉验证：`predev -w @rai/web`（= `node ../../scripts/check-node-version.mjs`，**不经过 npm**）
经 pnpm 跑 **EXIT=0**；而 `predev:api`（= `npm run check:node`）正是因为要 `npm` 才失败。
本批改动**没有碰** `package.json` 或 `scripts/check-node-version.mjs`（`git diff --name-only` 可核）。

⇒ 本环境的等价门禁命令是 `node node_modules/typescript/bin/tsc --noEmit -p <tsconfig>`
与 `RAI_TEST_CONCURRENCY=1 node scripts/run-tests.mjs`；文档里的 `npm run …` 写法在**有 npm 的机器**上不变。

## 4. 突变验证（3 处，全部被精确捕获）

| # | 突变 | 结果 |
|---|---|---|
| 1 | `isApplicationConsumableJob` 的载荷白名单改成"默认放行" | 恢复文件 **3 条转红**（CLI 载荷被判给消费者 / 未知载荷不放行 / 结构约束点名 `cli_export_import` 不得放行）＋ API 侧"CLI 载荷被拒绝"转红 |
| 2 | 删掉 `RECOMPUTE_JOB_TYPE_DISPOSITIONS` 的 `import` 条目 | 结构约束转红（"新增了既没有消费者、也没有声明外部所有者的 job_type"）＋ 直连载荷恢复用例转红 |
| 3 | 删掉消费者里的准入判定 | "CLI 载荷被拒绝且不跑分析"转红 |

突变全部已回退，回退后复跑 11/11 绿 + `tsc` EXIT=0。

## 5. 同轮发现的**既有**测试缺陷（测试自身，不是产品代码）

`packages/storage-sqlite/test/recompute-job-recovery.test.ts` 原有 4 条用例的测试体写成
`() => { withJobs(...) }`：同步测试体调用异步助手、断言发生在 `await` 之后 ⇒ 失败变成
"测试结束后发生的异步活动"（unhandled rejection），**报告里那些用例仍然打印 ✔**，只有文件级失败。
突变 1 第一次跑就复现：3 条断言实际失败，输出里却只有 1 条文件级红。

已全部改为 `async () => { await withJobs(...) }`。并为此写了一次性扫描器
（`var/reports/scan-unawaited-test-helpers.mjs`，**带阳性对照**：对故意植入的同一形态命中 1 处），
全仓 236 个测试文件**命中 0 处**。

## 6. 如实标注的边界

- ⚠️ **全量 `npm test` 在本环境无法取得全绿**：本机没有 `npm`（见 §3.1 的归因），
  等价跑法是 `RAI_TEST_CONCURRENCY=1 node scripts/run-tests.mjs` + vitest 单独跑。
  终值：Node 1672/1676（唯一失败是缺 `npm` 的环境项）、Web 184/184（单独跑）。
- ⚠️ `docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md` 正文里的若干 `文件:行号` 与"消费者只认识两种类型"
  一类断言**已过时**（本轮改了它们描述的那些行）。正文不改写，逐条对照表放在该文档文末。
- ⚠️ 本轮**不**放开 `deltaMode`、**不**登记任何分析任务：`planDirectSyncLane` 恒为
  `record-only`、回执 `analysisStatus` 恒为 `not_required`，两条都由断言钉住（源码级 + 行为级）。
- ⚠️ §14.3 P01–P06（目标云机）与 §14.5 真机 HealthKit 验收在本环境**不可达**。

## 7. 下一步（按 PR4 设计 §7 的顺序）

2a 载荷分类纯函数（未知必须分析）→ 2b parser 进 caller 事务（SAVEPOINT）→ 2c 写守卫分档 →
2d 同事务登记 + 代次写入方 + 回执 `queued` → 2e 放开 `deltaMode: "full"` → 3 短写租约 → 4 局部 canonical。

PR5（读侧一致性）/PR6（客户端状态与备份入口退场）的现状盘点已完成：
`var/reports/pr5-recon.md`（191 行）、`var/reports/pr6-recon.md`（299 行，备份入口调用点 25 处）。
