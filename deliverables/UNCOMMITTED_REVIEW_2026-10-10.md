# 未提交改动审查（2026-10-10）

**审查对象**：`6a1de72` 之后的未提交工作区（11 改 + 2 新，`126 insertions(+) / 30 deletions(-)`）。
**改动主体**：针对「iOS 同步一直失败且真因不可见」的三条修复 ——
① iOS 去掉"每次同步都全量重扫"；② 服务端保留失败上传包；③ 导入失败诊断可观测。
**方法**：所有结论落到 `文件:行号` 或命令实测输出；门禁实跑 + **突变验证**（改坏必须变红）。

---

## 一、结论摘要

| # | 级别 | 结论 | 证据 |
|---|---|---|---|
| 1 | ✅ | **三条修复方向正确，且互相闭合**：包变小（①）→ 失败可诊断（③）→ 失败包留证据（②） | 逐项见 §2 |
| 2 | ✅ | **三次突变验证全部变红**，新增门禁/测试都真的抓得住回归 | §3，`MUTATED_EXIT=1` ×3 |
| 3 | ✅ | 诊断改 `job.error = detail` 后**无泄漏**：5 个公开出口全过 `publicJob` | §2.2 |
| 4 | 🔴 | ✅ **已修**（§10）— **漏改副本**：`database.ts:2726` 报错文案仍指引"请手动同步补读历史后重试"，而手动同步**已不补读** ⇒ 照做零效果，且与已改的文档矛盾 | §4 |
| 5 | 🟡 | ✅ **已修**（§10）— `docs/IOS_NATIVE_SYNC_PROTOCOL.md:231` 同类描述过时（第二处漏改） | §4 |
| 6 | 🟡 | 失败包保留 ⇒ iOS 恢复分支会**多跑一次全量重放**；**不会死循环**（有 `terminalJobCode` 兜底） | §5.1 |
| 7 | 🟡 | 失败包 24h 保留的磁盘峰值：约 `250 MB × 失败频次`，当前 43% used / 28 G avail 可承受 | §5.2 |
| 8 | 🟡 | `npm test` **全量未跑**（本机 load 40.89，按既有记载会 SIGKILL）；已用 6 个针对性文件 + `test:ios` 覆盖 | §6 |
| 9 | ✅ | 顺带修好一条**既有的测试假绿灯**（`worker.test.ts` 断言位置错） | §2.5 |

---

## 二、逐层验证（✅ 通过项）

### 2.1 iOS 侧 —— 去掉"每次同步都全量重扫"

| 判据 | 位置 | 实测 |
|---|---|---|
| 前台 `sync()` 不再硬编码 `manual: true` | `apps/ios/RAI/HealthKitSync.swift:452` | ✅ `performSync(to:apiToken:full:)` |
| `manual` 形参已从签名移除 | 同上 `:703` | ✅ |
| 三个调用点全部对齐（不多不少） | `:297`（后台）/ `:452`（前台）/ `:686`（观察者） | ✅ grep 全仓仅此 3 处 |
| `recordsForceRescan` 只认 `full` | 同上 `:1139` | ✅ `recordsForceRescan: full,` |
| 周期性补读保留（权限扩大兜底） | `apps/ios/RAI/HealthKitRecordCursor.swift:11` | ✅ `force \|\| now - historyReadAt >= 7 天` |

⚠️ **残留 `manual` 全部是另一个概念**，不构成漏改：`SyncCancelCause.manual`（用户取消，
`HealthSyncLifecycle.swift:16`）、`source: "manual"`（手工计划，`PlanScheduleOperationJournal.swift:38`）、
注释里的 "manual acceptance"。已逐条核对。

### 2.2 服务端可观测性 —— 失败原因不再被丢弃

| 改动 | 位置 | 核实 |
|---|---|---|
| 非成功终态把业务 `error` 打到 **stderr** | `packages/application/src/cli.ts:78-86` | ✅ 单行 JSON，可被父进程逐行解析 |
| `console.error` **提前到 staging 还在时** | `apps/api/src/import-worker.ts:729-734` | ✅ 在 catch 现场，早于 `publishTerminalState` 的清理 |
| 双管道排水 + 各自 16,384 字符上限 | 同上 `:1800-1810` | ✅ 成功路径也排空（防大导出堵管道） |
| 记录退出码与 signal | 同上 `:1837-1849` | ✅ `close(code, signal)` |
| `job.error = detail`（原始诊断） | 同上 `:746` | ✅ |

🔴 **脱敏完备性（本轮重点复核项）**：`job.error` 从"公开文案"改成"内部诊断"后，
必须确认所有对外出口仍脱敏。实测**5 个出口全部经 `publicJob()`**：

```
import-worker.ts:263  active()          → publicJob
import-worker.ts:449  get(id)           → publicJob
import-worker.ts:459  findBySourceId()  → publicJob
import-worker.ts:465  latest()          → publicJob
import-worker.ts:830  onTerminal 入参    → publicJob
```
`mobileRefreshOutcome(job)`（`mobile-sync.ts:24`）入参类型就是 `ImportJobResponse` ⇒ 已脱敏。
`/v1/runtime-status`（`server.ts:945` `active() ?? latest()`）同样安全。
⇒ **内部 `runtime.sqlite.import_jobs.error` 存原始诊断（含路径），HTTP/移动端只见通用文案**。
新测试 `import-worker-diagnostics.test.ts` 用例 6 正是钉住这一点（含重启后再验一次）。

### 2.3 失败包保留

| 判据 | 位置 | 核实 |
|---|---|---|
| 仅 `!succeeded && status==="failed"` 时保留 | `apps/api/src/import-source-finalization.ts:37-41` | ✅ cancelled 仍走 `cleanupUpload` |
| `return` 不跳过必要步骤 | 同上，该分支是函数体内**最后一段的 else-if**，其后只有 `finally { release() }` | ✅ 实读全文确认 |
| TTL 常量 = 24h | `apps/api/src/import-sources.ts:108` | ✅ `24 * 60 * 60 * 1_000` |
| **周期清理真的存在** | `apps/api/src/server.ts:497-502` | ✅ `setInterval(..., 60*60_000)` 每小时 + 启动时两次 |
| 不调 `markUsed` ⇒ `lastUsedAt` 保持 `null` ⇒ 会被 sweep 选中 | `import-sources.ts:445`（`retainImportedUpload` 才 markUsed） | ✅ 与新测试断言一致 |

⚠️ **这条是本轮最容易被误判的一条**：若只有"保留"而没有周期回收，失败包会**无限累积**。
实测回收链路完整（启动两次 + 每小时一次），且 `import-source-finalization.test.ts` 新用例
用 `cleanupAbandonedUploads(+23h)=0 / (+25h)=1` 把 24h 边界钉住了。

### 2.4 门禁接线（"判据存在 ≠ 判据被执行"）

| 门禁 | 接线路径 | 核实 |
|---|---|---|
| `check-healthkit-record-sync.py` | `run-health-sync-tests.sh:167` → `run-model-tests.sh:67` → `npm run test:ios` | ✅ **不是孤儿** |
| 新增 3 条 check + `MIN_CHECKS` 22→25 | 同上 `:59-70, :104` | ✅ 实跑 26 checks / 0 failed |
| 新增 `packages/application/test/cli.test.ts` | `scripts/run-tests.mjs:12-18` **硬扫 `packages/*/test/*.test.ts`**（不看 package.json 脚本） | ✅ 会被 `npm test` 执行 |
| 新测试的类型检查覆盖 | `tsconfig.json` include `packages/**/*.ts` | ✅ |

### 2.5 顺带修好的既有测试假绿灯（值得记）

`apps/api/test/worker.test.ts:2053-2080`：原 `--source-database` 断言写在
`if (commandCount === 1)` **之外**，于是 **recompute 分支也会执行它** ⇒ 断言失败、fixture
在到达预期的 `simulated recompute failure` **之前就中止**，而那个中止错误被**旧的通用
`job.error` 掩盖** ⇒ 该用例长期没测到它声称要测的行为。本次把它移进 parser 分支并补
`assert.ok(args.includes("recompute"))`。**这是"改了 job.error 才暴露出来的"**，属正确动作。

---

## 三、突变验证（新增门禁真的有效）

按纪律：修完一条发现，必须把实现改坏确认变红，再还原。

| # | 突变 | 预期 | 实测 | 还原 |
|---|---|---|---|---|
| 1 | `HealthKitSync.swift:1139` → `full \|\| manual` | 门禁红 | ✅ `MUTATED_EXIT=1`，两条断言命中<br>`FAIL: ordinary sync must not force full record history…`<br>`FAIL: the button/shortcut entry point must not turn incremental sync into history replay` | ✅ `RESTORED_EXIT=0` / 26 checks / 0 failed |
| 2 | 删掉 `import-source-finalization.ts` 的保留分支 | 用例 3 红 | ✅ `MUTATED_EXIT=1`，`not ok 3 - failed uploads remain inspectable…` | ✅ 3 pass / 0 fail，diff 回到 `5 +++++` |
| 3 | 删掉 `cli.ts` 的 `console.error` 诊断块 | 用例 1 红 | ✅ `MUTATED_EXIT=1`，`not ok 1 - recompute CLI emits a caught business failure…` | ✅ 2 pass / 0 fail |

✅ **还原后 `git diff --stat` 与审查开始时逐项一致**（11 files / 126+ / 30−），无突变残留。

---

## 四、🔴 必修

### P1 — `packages/storage-sqlite/src/database.ts:2726` 的指引已失效

```ts
// A v30 shared row cannot reconstruct an overwritten UUID's facts.
throw new Error("共享健康记录缺少存活来源事实，请手动同步补读历史后重试");
```

- 改动后**"手动同步"= 增量续接游标，不补读历史** ⇒ 用户照这条指引操作**零效果**，
  正确动作是「重新导入全部」。
- 而 `docs/HEALTHKIT_RECORD_SYNC_V2.md:90` **本轮已改**成"要求显式「重新导入全部」补读历史后重试"
  ⇒ **文档与代码互相矛盾**（文档描述了代码还没做的措辞）。
- 全仓仅此一处，**无测试钉住该字符串**（grep 确认）⇒ 改动安全。
- 建议文案：`共享健康记录缺少存活来源事实，请使用「重新导入全部」补读历史后重试`
- ⚠️ 该 `throw` 位于**运行时导入路径**（非历史迁移的 `up`，迁移块在 `:1607` 附近；本处 `:2726`
  是 `observeImportEntity`/`insertRecord` 流程），**不属于"不可改历史迁移"的禁区**。

### 🎯 P1 附带的一条重要线索（待验证假设，非结论）

这条错误消息的**触发条件**（v30 共享行无法重建存活事实）与线上失败**高度相关**：

- 全量重扫会带回**巨量历史记录**（250 MB ≈ 94 万条量级，远超 DB 的 18.4 万条 ⇒ 说明带回的多是
  DB 只保留 running-relevant 子集的高频样本，含大量共享 UUID 的删除/替换事件）；
- 大量 deltas ⇒ 更容易撞上"v30 遗留共享行无法重建"；
- **它抛的是 `Error` ⇒ 会让导入/重算判失败**。

⚠️ **不能据此断言根因**（本仓纪律：真因未拿到证据前不给结论）。但本轮修复**恰好让它变得可验证**：
失败包被保留 + 诊断可观测 ⇒ **下次失败即可直接读到真因**。
⇒ 这也是本轮修复最实际的价值：**先把黑盒打开，再谈根因**。

---

## 五、🟡 待决策

### 5.1 失败包保留改变 iOS 恢复分支走向（已确认**不会死循环**）

| 阶段 | 改动前 | 改动后 |
|---|---|---|
| 导入失败 | source 被删 ⇒ `inspect` **404** | source 保留 ⇒ `inspect` **200** |
| iOS 恢复分支 | 走 404 分支 ⇒ `clearTask()` | 走 `startImport` ⇒ **重放同一个包** |
| 重放结果 | — | job 再 failed ⇒ `waitForJob:1730` 抛 `code=import_job_failed` ⇒ `HealthSyncCancellation.swift:42` `disposition=.abandonTask` ⇒ `clearTask()` ⇒ 报错 |

⇒ **一次重放后自动收尾，不会循环** ✅。代价是每次失败多跑一次全量（约 9–18 min）。

⚠️ **本轮不会触发**：线上现存的 4 个失败 source 是在**旧代码**下被删的，`inspect` 仍是 404。
仅当**部署新代码之后**再出现导入失败时，才会多这一次重放。

### 5.2 磁盘

失败包按 24h 保留。最坏情形（每 10 min 失败一次）峰值 ≈ 36 GB。
当前 `df` = **43% used / 28 G available** ⇒ 可承受，但建议盯一眼 `var/imports` 体积。

### 5.3 其他漏改副本

`docs/IOS_NATIVE_SYNC_PROTOCOL.md:231`：

> …初次升级读取可见历史，**手动同步**及达到补读间隔后的后台同步重读历史以覆盖权限扩大。

⇒ 与本轮语义（"只有显式「重新导入全部」强制补读"）矛盾，应改为"显式「重新导入全部」及…"。

（`deliverables/UNCOMMITTED_REVIEW_2026-10-09.md:320` 的同类表述**不应改** —— 交付物是时点快照。）

---

## 六、验证记录（实跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查（双 tsconfig） | `npm run typecheck` | **EXIT=0**（57 s） |
| 导入诊断（新） | `node --import tsx --test apps/api/test/import-worker-diagnostics.test.ts` | **6 pass / 0 fail** |
| 来源终结（改） | `… apps/api/test/import-source-finalization.test.ts` | **3 pass / 0 fail** |
| 重算 CLI（新） | `… packages/application/test/cli.test.ts` | **2 pass / 0 fail** |
| 导入 worker（改） | `… apps/api/test/worker.test.ts` | **93 pass / 0 fail** |
| 服务端运行时（改） | `… apps/api/test/server-runtime.test.ts` | **30 pass / 0 fail**（7m25s） |
| iOS 门禁 | `npm run test:ios` | **EXIT=0**（7m4s）<br>typecheck + 101 store + 200 tech + **269 background / 0 failed** + 14 export determinism + coach field coverage |
| 健康记录同步接线 | `python3 apps/ios/tests/check-healthkit-record-sync.py` | **26 checks / 0 failed** |

⚠️ **未跑**：`npm test` 全量。原因：本机 load average **40.89**（ChatGPT 桌面端 CUA 常驻
`node` 进程），按本仓既有记载此时全量 `npm test` 会 `SIGKILL 137`。已用上表 6 个针对性文件
+ iOS 门禁覆盖全部改动面。**建议在低负载时补跑一次全量。**

⚠️ **未跑**：`run-visual-tests.sh`（需模拟器 + `var/rai.sqlite`）、`run-coordinate-sdk-check.sh`
（需 Pods）—— 本仓既定的手工验收项，本轮 iOS 改动不涉及视觉层。

---

## 七、修复顺序 + 验收标准 + 回滚

| 顺序 | 动作 | 验收标准 | 回滚 |
|---|---|---|---|
| 1 | **P1** 改 `database.ts:2726` 文案为「重新导入全部」口径 | `grep -rn "手动同步补读"` 全仓为空（除历史交付物）；`npm run typecheck` EXIT=0 | `git checkout -- packages/storage-sqlite/src/database.ts` |
| 2 | **P2** 改 `docs/IOS_NATIVE_SYNC_PROTOCOL.md:231` 同日口径 | 反向 grep 无残留 | `git checkout -- docs/IOS_NATIVE_SYNC_PROTOCOL.md` |
| 3 | 低负载时补跑 `npm test` 全量 | EXIT=0，Node 段 + Web 段都有结论 | 只读，无需回滚 |

**破坏性评估**：本轮**无数据库迁移**、**无破坏性契约变更**（`ImportJobResponse` 形状未变，
只是内部值从脱敏文案换成诊断）；线上部署只涉及 `apps/api/src` + `packages/application/src`
⇒ API 侧 `git pull --ff-only` + `systemctl restart rai-api`，**不需要 build web、不需要迁移**。
iOS 改动对已安装 App 是 **no-op**，需 Xcode 重新 build 安装。

---

## 八、清理项

- 三次突变的临时改动**已全部还原**，`shasum` / `git diff --stat` 双重核对，与审查开始时一致。
- 本轮未新增临时文件（探针脚本均写在 `/tmp`）。

---

## 九、总评

**方向对、落点准、门禁硬**。三条修复互相闭合，且**没有引入新的公开面泄漏**（这是本次改动
最容易出错的地方，已逐出口核实）。唯一实质缺口是 `database.ts:2726` 那句**指引失效** ——
它恰好是"同一句错话在别处留副本"的典型形态，而且是**本轮唯一会让用户照做白跑**的问题。

值得肯定的是：这轮改动**没有假装解决了根因**。文档里那句
「上线修复后若旧批次仍失败，需要用新的诊断确定重算拒绝原因，**不能仅凭包体变大认定根因**」
是清醒的 —— 与 §4 的线索合在一起，**下次失败就能把真因拿下来**。

---

## 十、修复记录（2026-10-10 同日）

| # | 级别 | 文件:行号 | 改动 | 结果 |
|---|---|---|---|---|
| 1 | 🔴 P1 | `packages/storage-sqlite/src/database.ts:2726` | `请手动同步补读历史后重试` → `请使用「重新导入全部」补读历史后重试` | ✅ 已修 |
| 2 | 🟡 P2 | `docs/IOS_NATIVE_SYNC_PROTOCOL.md:231` | `手动同步及达到补读间隔后…` → `显式「重新导入全部」及达到补读间隔后…` | ✅ 已修 |

### 修复后重跑

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（双 tsconfig） | **EXIT=0** |
| `npm run check:doc-refs` | **EXIT=0**（0 越界 / 0 漂移） |
| `packages/storage-sqlite/test/` **全量** | **90 pass / 0 fail / 1 skipped** |
| `v31-migration.test.ts` + `database-import.test.ts`（针对性） | **5 pass / 0 fail** |

⚠️ **`check:doc-refs` 的实际覆盖面要说清**：该脚本只扫 `ARCHITECTURE / ALGORITHM / DATA_PIPELINE / OPERATIONS`
四份文档（输出里明写其余"0 处引用"），本次改的 `IOS_NATIVE_SYNC_PROTOCOL.md` **不在其扫描范围**
⇒ 结论是"未被该门禁覆盖"，**不是"已被它验证通过"**。本次改动为同行文本替换、未增删行，不引入行号漂移。

⚠️ 那 1 个 skipped = `publication-lock.test.ts` 的进程身份探测（macOS 下 `spawnSync("ps", ...)` 被拒
⇒ 按设计 fail-safe 跳过），是本机既有形态，不是覆盖丢失。

### 反向 grep 复核（纪律 15：修完必须找全副本）

`手动同步补读` 全仓**已为空**。其余 `手动同步` 命中逐条判定为**不同语义**，不属漏改：

| 位置 | 语义 | 判定 |
|---|---|---|
| `docs/DECISIONS.md:96` | 课表撤回时提示用户手动同步 | 无关 ✅ |
| `TechPlanWatchSection.swift:26` + `run-tech-presentation-tests.sh:771` | 同上（UI 文案，且**已有门禁钉住**） | 无关 ✅ |
| `BackgroundSyncPolicy.swift:104` | "自动同步停在原地，直到…或手动同步"（触发时机） | 无关 ✅ |
| `deliverables/UNCOMMITTED_REVIEW_2026-10-09.md:320` | 历史交付物引述当时的文档措辞 | **时点快照，刻意不改** ✅ |

### 刻意未修（需你拍板的产品决策）

🟡 **P3**（§5.1）：iOS 恢复分支会多跑一次全量重放。它**不是缺陷**——`waitForJob:1730` 抛
`import_job_failed` → `disposition=.abandonTask` → `clearTask()` 会自愈；它是"保留失败包供诊断"的必然代价。
**建议先不动**：本轮不触发（线上旧 source 已删），且诊断价值 > 一次重放的时间成本。
日后若要改，两个方向都需新契约、属独立改动：
① 服务端在保留的 source 上标记"上次导入失败"，让恢复分支直接放弃；
② iOS 侧对"已知失败的 `sourceId`"不再自动 `startImport`。
