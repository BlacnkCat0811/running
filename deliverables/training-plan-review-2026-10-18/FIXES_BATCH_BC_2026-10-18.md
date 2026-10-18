# 训练计划审查 §8 批次 B/C 修复记录（2026-10-18）

- 对应审查报告：[TRAINING_PLAN_REVIEW_2026-10-18.md](../TRAINING_PLAN_REVIEW_2026-10-18.md) §8「批次 B / 批次 C」与批次 A 的「残留风险」。
- 范围：批次 A 的 3 项残留风险 + **P2×18** + **P3×21**，全部带回归与验证记录。
- 基线：`HEAD 09ed8d0` + 批次 A 未提交改动；本轮改动仍**未提交 git、未推送**。
- 前置：P2-15（ONNX 惰性加载）先落地，解锁了此前本机无法执行的 9 个测试文件（含 `training-plan-state`、`mobile.test`、`server-runtime`），本记录中的 HTTP 证据因此第一次可在本机真实运行。

---

## 0. 结论

| 类别 | 数量 | 状态 |
| --- | --- | --- |
| 批次 A 残留风险 | 3 | 全部消除（见 §1） |
| P2 | 18 | 18 项全部修复（见 §2） |
| P3 | 21 | 20 项修复 + 1 项拆分：P3-18 的 A1/A2/A3/A4 已落地，**B1「计划低于量带也提示重排」按审查文档保留为产品决定**（见 §5） |

本机可执行的门禁全部通过：typecheck 0、`server-runtime` 31/31、plan/coach 定向 383 例全过、全量 Node 套件 2024/2032（5 个失败均为既有环境/既有测试问题，见 §4.3）、iOS 聚合门禁 exit 0、文档四门禁 0。真机 / 配对 Watch / Simulator 视觉与 gitee CI 仍属未验证边界（§4.4）。

---

## 1. 批次 A 残留风险

### 1.1 新契约 503 无客户端重试、无 `Retry-After`（P2-6）

- 服务端 `apps/api/src/server.ts`：`setErrorHandler` 统一走 `retryAfterSeconds(payload)`（`apps/api/src/api-error.ts`）。仅对 `503 plan_snapshot_changed` / `coach_snapshot_changed` 返回 `Retry-After: 1`；429 保持 5 秒；其余 503 不加头（通用故障不等于 1 秒后可重试）。helper 有独立单测。
- iOS `apps/ios/RAI/TrainingPlanStore.swift`：聚合契约（`planSnapshotContractVersion != nil`）下对同两个错误码做**有界退避重读**（默认 2 次、150/300 ms，`snapshotRetryDelays` 可注入）；复用同一 `requestID/epoch/scope/isValid`，`Task.sleep` 取消即放弃；只重试读，写请求从不经过该路径；旧契约仍用 `legacyRetryCount`。
- 回归：`plan-error-semantics.test.ts`（Retry-After 码表）；`TrainingPlanStoreRegression`（3 次成功、耗尽、退避中取消；旧契约行为不变）。

### 1.2 跨库读取回验不是原子事务（P2-2 类）

- 新增 `apps/api/src/publication-guard.ts`：control 库表 `mobile_publication_guard(id=1, epoch, pending_since)`。
  **协议**：发布者在**独立的 control 写事务**里先 `BEGIN IMMEDIATE + epoch++ + pending_since=now + COMMIT`，再执行 main+control 发布，最后单独事务清 marker。读取者在 build 前后各读一次 guard：`pending` 未过期或 `epoch` 变化 ⇒ 丢弃本轮、重建（≤3 次），耗尽 `503 plan_snapshot_changed`。
  因为 marker 在 main 写入之前提交，任何“新 control + 旧 main / 旧 control + 新 main”的混合读都必然在前后两次读取中暴露；崩溃留下的 marker 由 120 s lease 兜底，不会永久阻塞。
- 写入侧 `MobileGoalsStore.withPublicationTransaction` / `publicationOperation` 统一接入；`publicationGuardState()` 在**自身** publication 事务内隐藏自己的 pending（保留 epoch），避免写路径读自己导致 fail-closed；`publicationInFlight()` 为公开判定。
- 读侧 `readStableSnapshot` / `trainingPlanState` 接入 guard（缺失/损坏时降级为原有 control digest 校验）；`/v1/mobile/workout-plan/synced` 的 `matchesCurrent` 计算与回执写入放进**同一个** guarded control 写事务。
- 回归：`plan-read-consistency.test.ts`（guard 前后、epoch 变化、stale lease、自身事务豁免、降级）；`real MobileGoalsStore` 的 `plan-receipt-identity.test.ts`（marker 先提交/后清理）；HTTP：`server-runtime.test.ts` 在回执登记后读取 control 库，断言 `epoch > 0 && pending_since IS NULL`。

### 1.3 control 读放大与延迟（原：3→6 次读 + 2 次 digest，未测）

- `trainingPlanState` 成功尝试的 control 读从 **3 对（6 查询）降到 2 对（4 查询）**：预读一次 `goals + history` 同时供 controlDigest 与 build 复用，post 校验再读一对；control digest 从 4 次降到 2 次（identity 改逐字段比较）。测试直接断言查询序列 `["goals","history","goals","history"]`。
- coach-loop 读取保留 before/after 各 3 表（6 查询）：这是跨存储回验的固有成本，换来“返回的教练快照与事实同源”；其单查询成本经微基准确认可忽略。
- 实测（本机，n=200 / n=50）：`readStableSnapshot`+guard p50 **0.008 ms** / p95 **0.019 ms**；空库 `trainingPlanState` p50 **5.51 ms** / p95 **11.21 ms**。测试内置上限断言防退化。
- 顺带修复：`read-store-manager.ts` 在文件 ino/mtime 变化时关闭并重建缓存连接（P3-4），以及 `statSync` 瞬态失败分类（P2-5）。

---

## 2. P2 修复

| ID | 修复 | 主要证据 / 回归 |
| --- | --- | --- |
| P2-1 | v2 回执身份规范化：`workoutID` 大写 UUID、`scheduledAt` UTC ISO；迁移 `mobile_control_schema v1` 回填列与 payload；所有查找/去重/撤回 predicate 使用 `canonicalPlanPushIdentity`；不可解析时刻 422 | `plan-receipt-identity.test.ts`（13 例，含旧库迁移、等价时刻、跨写法去重）；coach 通道 duplicateActive 同步改用规范身份 |
| P2-2 | `/synced` 的 `matchesCurrent` 与回执写入同事务（见 §1.2） | HTTP：guard epoch/pending 断言；同事务内 `planPushIsActive` 结论 |
| P2-3 | 幂等键唯一性改为 `(scope, idempotencyKey)`；`repeated` 早退比较 scope + localDate；同条目不同 localDate 不再静默当重复 | `plan-receipt-identity.test.ts`；索引迁移用例；跨 scope 用例 |
| P2-4 | 无主库时 `weekPlan` 写入返回 `409 database_not_ready`，其他 goals 字段仍可写 | HTTP：删库后 PUT goals（weekPlan → 409；qualitySessionCap → 200） |
| P2-5 | `trainingPlanState` 两次 `statSync` 的 ENOENT/EACCES/EIO/ESTALE 归入快照变化，重试 ≤3 次后 503，不再直落 500 | `plan-read-consistency.test.ts`；`data.test.ts` |
| P2-6 | 见 §1.1 | 服务端单测 + iOS store 回归 |
| P2-7 | legacy 三 GET 置 current 前校验业务日（Asia/Shanghai）、时区、`windowDays 1..14`、逐日连续唯一且首日==today；失败不置 current | `TrainingPlanStoreRegression` 4 个负例 |
| P2-8 | 新增 `snapshotValidationFailed` 分类与 `snapshot_validation_failed` 诊断码；面板归入 `.validation`，文案不再引导升级 App | iOS 分类/文案断言；`refreshAll` 汇总文案 |
| P2-9 | 能力判定单源 `usesIntegratedPlanContract`（coachLoop 优先）；`refreshRunCoach` 统一转发；`acceptCoach` 在 coachLoop 非空时拒绝旧写入；删除死分支 | 混合能力（coachLoop=1 无 snapshot）回归；两处 UI 判断同步 |
| P2-10 | 提醒上下文改为显式 `TrainingReminderContext`：闭环只提醒“今天已发布完整课”，未来日明确为展望；设置页说明 | 纯函数 context、闭环、refreshRequired 回归 |
| P2-11 | 赛事目标日期统一按 Asia/Shanghai 业务时区格式化/比较；`today` 缺失不再用设备日期兜底 | 设备 UTC、业务日午夜的跨时区单测 |
| P2-12 | 周期化口径定为“≤24 周且含当前周”：`weeksToRace=24` → 25 行、`current=base`、无 reasonCodes；`>24` 保持向前 24 行 + `race_beyond_maximum_horizon`；`weeklyCapacity` 24 周恢复 phase | `plan-periodization.test.ts` 23/24/25 周边界；capacity 断言 |
| P2-13 | 摘要数值统一 `micro=floor(x*1e6+0.5)` 整数拼串；非有限/`|x|>1e9` 抛错；`-0→0`；kind 限定会话枚举。TS 与 Swift 逐字节一致 | TS `plan-digest.test.ts`；Swift fixture 9/9、合成输入 48/48 交叉验证 |
| P2-14 | `packages/api-contracts` 新增四状态 `MobilePlanOperationQueryResponse` 与单源状态表；`result()` 运行期严格收窄（未知状态/缺 result → 500）；OpenAPI summary 派生；路由自动获得类型 | `schemas.test.ts` parity；`plan-publication.ts` |
| P2-15 | `prediction-inference` 顶层 ONNX import 改为仅类型 + 懒加载；`import('./apps/api/src/data.ts')` 不再 DLOPEN | ONNX 惰性加载验证；原 9 个受阻文件可执行（本记录全部 HTTP/算法证据的基础） |
| P2-16 | 验收矩阵新增 G06（快照冻结/503）、G07（发布操作幂等/过期/跨域）、G08（回执 v2 生命周期），测试标题引用 | `check-acceptance-matrix` 80/80 cited |
| P2-17 | `check-doc-line-refs` 默认范围加入 3 份 plan 文档；修 `docs/WEB.md` 死引用；pre-commit 与 CI 接入 `check:doc-refs` | 门禁 138 处 / 0 越界 |
| P2-18 | 三份现行 plan 文档验证入口改 D17 后口径（typecheck/test/test:ios + 文档门禁），历史记录加时点标注 | 文档门禁 + 人工复核 |

---

## 3. P3 修复

| ID | 修复 |
| --- | --- |
| P3-1 | `/v1/mobile/*` 统一 `Cache-Control: no-store`（onSend 钩子）；coach-loop 各路由双保险；HTTP 断言覆盖 goals/today/workout-plan |
| P3-2 | `coherenceToken` 输入加入 plan-history 摘要（`historyDigest`），只改 history 不改 goalsRevision 时 token 变化；客户端只做相等比较 |
| P3-3 | coach-loop managed 时 handshake 不再宣告 `planSnapshotContractVersion`（coachLoopContractVersion 仍为 1）；HTTP 断言 |
| P3-4 | `ReadStoreManager` 记录打开时 ino/mtime，变化先 close 重建；`useDatabase` 打开后校验 ino；真实替换文件回归 |
| P3-5 | 预览容量 8→64，只在超过容量时淘汰未过期候选；容量可注入；15 分钟内第 9 个候选仍可 confirm |
| P3-6 | confirm 始终 remember 结果（原第 4 参保留但忽略）；服务端不再传反了的 `operationId === undefined` |
| P3-7 | generic `/synced` 的 `verified` 回执新增“真实处方来源”校验：必须匹配该 revision 的 plan-history 日或当前 effective 日；`operationId` 是客户端排期 journal id，服务端不拿它当发布键（避免误伤真实客户端）。HTTP 断言伪造 revision → 422 `plan_receipt_unknown_prescription` |
| P3-8 | control 连接 `busy_timeout` 5 s→2 s；SQLITE_BUSY → `503 database_busy`（白名单保留 code/message），不再 500/长阻塞；合成双连接回归 |
| P3-9 | `PlanPublicationService.identity` 必填；`run-coach.ts` 缺省时显式 500；`publish()` 不再静默跳过 scope 校验；回归覆盖“带 operationId 缺 operationScope → 422 且不落存储” |
| P3-10 | 严格 local date（拒绝 2026-02-30，闰年正常）；periodization/capacity 改用共享实现 |
| P3-11 | `prescriptionDigest` 的 kind 限定会话枚举，消除 `kind="easy|~|0"` 与空结构撞哈希 |
| P3-12 | 赛卡减量改用共享 `PRE_RACE_EXECUTION_PROTECTION_DAYS`，比赛日当天不算 taper；14/15/比赛日边界回归 |
| P3-13 | DECISIONS D13 的 `phases` 描述改为空数组（与 run-coach 实现一致） |
| P3-14 | `generateWeeklyPlan` 真正应用 `automaticDosePolicy`，`rejectedCount/clampedCount` 返回真实计数；保留默认行为 |
| P3-15 | legacy/单条缓存路径合并 `cachedAt`，离线文案显示缓存时刻 |
| P3-16 | 撤回 cleanup 同时核对 UUID 与精确 `scheduledAt` |
| P3-17 | 移除两处主线程 `as!`，改为可诊断的安全失败 |
| P3-18 | A1/A2/A4 文案分层（阶段建议量带/课表计划/已完成/“今日改为休息后本周还差 X km”）；A3 服务端 detail 去掉“当前周”越界断言；`check-today-layout.py` 断言删“量带”或“课表”即红。**B1 未实现（产品决定，见 §5）** |
| P3-19 | README “54 项验收合同”→80（以矩阵输出为准） |
| P3-20 | pre-commit 增计划定向回归（11 文件 94 例 / 6 s，空列表守卫）；CI 加 `workflow_dispatch` 与 gitee 不触发说明 + 发布前替代清单（不假装已解决） |
| P3-21 | 四份文档的 84/87/89/90 份源码、1508/1518/1522 项等历史数字统一为“2026-10-18 对齐 09ed8d0，以命令输出为准” |

---

## 4. 验证结果

### 4.1 本机真实执行（2026-10-18，macOS 26 / Xcode 26.6 / node v24.21.0）

| # | 检查 | 结果 |
| --- | --- | --- |
| V1 | `tsc --noEmit -p tsconfig.pure.json` / `-p tsconfig.json` | **0 / 0** |
| V2 | `apps/api/test/server-runtime.test.ts`（生产路由 HTTP，全文件） | **31/31 通过，exit 0**（约 86 s） |
| V3 | plan/coach 定向 39 文件 + `mobile-coach` | **347 + 36 = 383 例全过** |
| V4 | 全量 `RAI_TEST_CONCURRENCY=1 node scripts/run-tests.mjs`（环境补齐后最终） | 2038 例：**2035 通过 / 0 失败 / 3 skipped，exit 0**；3 个 skip 为平台条件跳过（§4.3） |
| V5 | `node scripts/run-ios.mjs gates`（收尾轮复跑） | **exit 0**（类型检查 94 文件；store 106、presentation 200、plan scheduling 88、TrainingPlanStore **54**、background 297、export 14、today layout、direct-sync 55+21、analysis 43；合计 **1132 条 PASS**） |
| V6 | 跨语言摘要 | Swift fixture **9/9**、合成结构 **48/48** 与 TS 逐字节一致；错误行为一致 |
| V7 | 读放大 / 延迟 | `trainingPlanState` 4 查询 / 2 digest（断言）；microbench p50 0.008 ms / p95 0.019 ms；空库 trainingPlanState p50 5.51 ms / p95 11.21 ms；收尾轮的生产规模/WAL/并发数字见 §4.5 |
| V8 | `check-doc-links` / `check-doc-line-refs` / `check-acceptance-matrix` / `check-npm-scripts-portable` | **0**（82 文件 / 592 链接）；**0**（138 处）；**80/80 cited**；18 包 / 104 script |
| V9 | pre-commit 计划定向回归（模拟触发） | **97/97 通过，约 5.5 s**；`bash -n` 通过 |
| V10 | `git diff --check` | 无空白错误 |

### 4.2 批次 A 回归复核

批次 A 的 21 例（receipt v2 / error semantics / read consistency）与 iOS wire 断言在本轮全部保持通过；`server-runtime` 的 Swift 形状回执、coach-loop stale revision、lock 409 断言在 ONNX 解耦后**首次本机执行并通过**。

### 4.3 原 5 个失败的处理（环境补齐后 0 失败）

| 原失败 | 根因 | 处理 |
| --- | --- | --- |
| `node-version.test.ts` 的 npm lifecycle 检查 | 本机无 npm | 安装官方 Node v24.21.0 + npm 11.19.0（见 §4.6） |
| `prediction-inference.test.ts` ONNX 推理 | DSH 自带 Node hardened runtime 的 Team ID 与 `onnxruntime-node` ad-hoc 签名绑定不同，dlopen 被库验证拒绝 | 同一官方 Node 可加载，推理测试通过 |
| `native-worker.test.ts` 2 例 | 本机只有 Sep 22 的旧 worker 二进制；Rust 工具链缺失，无法重建 | 安装 Rust 1.98.1 并重建；同时修复重建后暴露的**真实 parity bug**（见 §4.6） |
| `workout-summary-export.test.ts` 源码字符串断言 | 断言仍要求 `server.ts` 内联 token 检查串，该检查早已迁到 `local-request-security.ts`（HEAD 即红） | 改为断言“路由被显式分类为 token-required + 常量时间 Bearer gate 位于安全模块” |

最终全量套件：**2038 tests / 2035 pass / 0 fail / 3 skipped（平台条件）/ exit 0**（约 514 s，串行）。

### 4.4 未验证边界

1. 真机 + 配对 Apple Watch：UUID/时刻稳定、表端可见、部分成功、跨午夜、新旧服务组合（`docs/IOS_NATIVE_RUNBOOK.md`）。
2. Simulator 视觉验收（`apps/ios/tests/run-visual-tests.sh`，需已启动 Simulator 与隔离数据库）。
3. 并发压测：guard 的跨进程时序、P2-5 恢复窗口、P3-8 多进程持锁只做了单连接/双连接合成用例；真实导入并发下的重试率未测。
4. gitee 远端不会触发 GitHub Actions：已在 README/ci.yml 写明限制与发布前替代清单，未假装解决。
5. Windows 路径下的 `rename` 替换（P3-4）未实跑。
6. 真实 API 503 负载下 iOS 重试时延、`Retry-After` 未被客户端解析（任务允许）、`UNUserNotificationCenter` 真通知排队。

---

## 4.5 收尾轮（2026-10-18 下午）：验证边界关闭

### 4.5.1 iOS 遵循 `Retry-After`（P2-6 最后一块）

- `APIClient.swift` 新增 `RaiAPIClientError.retryableServer(code:message:status:retryAfterSeconds:)`：仅 `status == 503` 且 `Retry-After` 可解析时抛出，其余仍走既有三参数 `.server`，19 处既有模式匹配不受影响；`serverCode`/`httpStatus` 为两种 case 的公共取码；`errorDescription` 覆盖。
- 新增 `RaiRetryAfter` 解析：只接受**整数秒**（HTTP-date、`1.5`、非法值忽略），夹取 `0...5`；429 文案复用同一解析，行为不变。
- `TrainingPlanStore`：纯函数 `snapshotRetryDelay(serverHint:defaults:attempt:)`（提示优先并夹 `0.1...5`，缺失回退 `[0.15, 0.3]`，用尽 nil）；可注入 `sleepBeforeSnapshotRetry`；catch 同时识别 `.server`/`.retryableServer`；取消、requestID/epoch/scope/isValid、“只重读不重放写”语义不变。
- `PlanReadIssue.network` 识别新 case → `.serverUnavailable`（可重试，不归 contractMismatch）；`NativeAppModel` 回执 code 提取改用 `serverCode`。
- 服务端 `database_busy`（P3-8）也带 `Retry-After: 1`，但客户端重试白名单仍只含两个 plan 快照码（避免自动重放写）。

**回归**：iOS ModelRegression +18、TrainingPlanStoreRegression +9（整数/非法/HTTP-date/0/9、`Retry-After:1` 按 1 s、无头回退 150/300 ms、等待取消不再发请求）；`run-model-tests.sh` 与 `run-ios.mjs gates` 均 exit 0（TrainingPlanStore 54 项、合计 1132 条 PASS）。

### 4.5.2 WAL checkpoint 不再误重建读连接（P3-4 收尾）

- 原实现用 `ino + mtime` 判断重开；实测 SQLite `wal_checkpoint` 会更新主库 mtime，导致每次 checkpoint 后下一次读都重建 `RaiReadStore`。现改为**仅 inode 变化才重开**，同一 inode 只刷新记录；`useDatabase/useDatabaseAsync` 仍做打开后 ino 校验；`readSnapshotFileIdentity` 的 data.ts 快照语义未改；新增 `storeOpenCount()` 诊断计数。
- 回归（`read-store-manager.test.ts`）：`utimesSync` 只改 mtime → openCount 不变；WAL 写 + `wal_checkpoint(TRUNCATE)` → openCount 不变且缓存连接读到新提交；`renameSync` 替换 → openCount 1→2 且读到新内容；200 次 mtime 变化后仍为 1。
- 冷打开 `new RaiReadStore` n=30：p50 **0.07–0.08 ms** / p95 **0.16–0.23 ms**；same-inode mtime 路径 n=200：p50 **0.004 ms** / p95 **0.005–0.008 ms**（相对成本≈0）。
- 已知边界：同 inode 的**原地覆盖**（而非 rename）仍不重开；这是 P3-4 原有的 out-of-band 限制，协调式替换走 `beginReplace`。

### 4.5.3 生产规模延迟（近似）

- 新增 `plan-snapshot-latency.test.ts`：临时库 seed ≈42,600 行（40k health_records + 400 nights/hrv/workouts/sessions + 800 stats + 200 条 control plan history；未 seed model-run/loads/assessment 链，故为同 row-count 的**下界近似**；未读写 `var/rai.sqlite`）。
- `trainingPlanState` n=20：空库 p50 **5.5–5.9 ms** / p95 **6.7–8.5 ms**；≈42.6k 行 p50 **13.7–14.7 ms** / p95 **19.7–21.4 ms**。

### 4.5.4 publication guard 双进程不变量压测

- 新增 `plan-publication-stress.test.ts` + 两个 helper：子进程按**真实事务顺序**发布 300 次（marker 先独立提交 → 写 main `marker=epoch` → 清 marker），主进程 2000 轮读（200 settled-before + 1600 并发 + 200 settled-after）。
- 3 次结果：consistent **42.4%/48.9%/49.3%**，detected **50.7%/57.6%/51.0%**；**violations = 0**（从未出现“`publicationGuardChanged()===null` 但 `marker != guardBefore.epoch`”）、`detected_outside_concurrency = 0`、settled 读 400/400；单轮 p50 ≈ **0.019 ms** / p95 ≈ **0.058–0.070 ms**；用例 ~0.4 s，3/3 稳定。

### 4.5.5 HTTP 503 负载与重试时延

- 新增真实 API 进程用例（`server.ts`，10×20 读 `/v1/mobile/training-plan-state` + 2×25 写 `PUT /v1/mobile/goals`，另起独立跨进程发布者制造真实发布窗口）。
- 3 次：读者 200=61/63/66、503=134–139（63.5–69.5%），**所有 503 code=`plan_snapshot_changed` 且 `Retry-After: 1`**；`inconsistent_200=0`；p50 **46–54 ms** / p95 **112–149 ms**（预算 2000 ms）；写者 50/50 全 200（0 个 409/503/500）；3/3 exit 0，单次 ~10.6 s。
- 形状说明：同一 API 进程内 Fastify handler 全同步，写者不可能插进读者的两次 guard 读之间（实测 200/200 全 200）；两个 API 进程共享 DB 又被 `acquireDatabasePublicationLock` 按设计拒绝。因此用“独立发布进程 + 真实 guard/control 发布”制造跨进程窗口；进程内 import worker 的 worker_threads 并发仍不在本次范围（见 §4.4）。
- 503 比例高是压力形状导致的（发布者以 4 ms 窗口连续发布），生产发布频率下不会出现；本题按任务要求只报告、不硬断言低比例。

### 4.5.6 收尾轮后仍未关闭的边界

- 真机/配对 Watch、Simulator 视觉验收。
- gitee 不触发 GitHub Actions（文档化，未假装解决）。
- Windows 下 rename/WAL 语义与子进程 IPC。
- 生产真实 import worker 跨线程发布并发（与本轮 HTTP 压测的跨进程发布者不同形状）。
- `UNUserNotificationCenter` 真通知排队、真实 API 端到端 503+Retry-After 的 iOS 行为（本地 stub 覆盖）。

---

### 4.6 本机环境补齐（2026-10-18 下午，非产品改动）

- **Node / npm**：官方 Node v24.21.0 安装到 `~/.local/node-v24.21.0`，`~/.local/bin/{node,npm,npx}` 指向它（npm 11.19.0，已在 `PATH` 中）。选择官方发行版而不是 DSH 自带 Node 的原因：后者是 hardened runtime 且带固定 Team ID，`onnxruntime-node` 的 ad-hoc 签名绑定会被库验证拒绝（`ERR_DLOPEN_FAILED` / different Team IDs）；官方 Node 可正常加载。Node 版本仍满足 `engines >=24 <25`，`npm run check:node` 与全部 npm lifecycle 检查通过。
- **Rust**：rustup + Rust 1.98.1（与 `rust-toolchain.toml` 一致）安装到仓库 `var/cargo`、`var/rustup`（均被 `.gitignore` 忽略），`node scripts/rust-worker.mjs build` 重建 `target/release/rai-data-worker`；`node scripts/rust-worker.mjs verify` **exit 0**。
- **由此暴露并修复的两个真实仓库问题**（不是环境问题）：
  1. `crates/rai-data-worker/src/main.rs` 的增量更新账本只写 `content_hash`，未写 `previous_effective_at / previous_end_at / previous_type`，而 TS `observeImportEntity` 会写“before 侧”。重建后 TS↔Rust parity 测试稳定复现该差异；已在 Rust 侧按 TS 语义补齐（`updated` 时读取旧行 `start_at/end_at/type`，`inserted` 写 NULL），`native-worker` 11/11、`rust:verify` 全绿。
  2. `apps/api/test/workout-summary-export.test.ts` 仍断言 token 检查字符串留在 `server.ts`；该检查已迁到 `local-request-security.ts`，测试自 HEAD 起就是红的。改为断言路由显式归入 `tokenRequiredReadRoutes`，且安全模块存在常量时间 Bearer gate。
- 环境改动均在仓库外或 gitignored 目录；仓库内只新增上述 Rust parity 修复与测试修复（§7）。

---

## 5. 明确未实现 / 产品决定

- **P3-18 B1（计划低于量带时新增 `plan_below_phase_band` 建议）未实现**。`docs/TODAY_PLAN_CARDS_REVIEW.md` 将 B1 标为产品决定（会让今日页常态多一条“建议重新生成课表”），本轮只落地其推荐的 A1/A2/A3/A4 文案分层与 A3 文案纠错。需要产品明确后再做。
- **P3-7 的口径**：`operationId` 是 iOS 排期 journal 的 UUID，不是 `mobile_plan_operations` 的键；因此没有按审查原文“查已提交发布操作”实现，而是改为校验回执必须来自真实发布过的处方（history 或当前 effective day）。这是为兼容真实客户端而做的必要偏离，已在 `server.ts` 注释中说明。
- **P2-12 口径**：选定“距比赛 ≤24 自然周且含当前周”（24 周 → 25 行）。若产品未来改为“24 行 = 比赛周 + 23 周预备”，需要同步改文档/测试并拒绝 24 周。

---

## 6. 兼容性与迁移

- 旧 v1 回执、旧 coachLoop 回执字节语义不变；v2 回执两种线格式都接受，落库统一 canonical。
- control 库新增 `mobile_publication_guard` 表与 `mobile_control_schema v1` 迁移（列/索引/payload），迁移可重复执行；旧库在首次打开时原地升级。
- handshake 在 managed 数据集不再宣告 `planSnapshotContractVersion`；新 iOS 在该状态下本来就走 coach-loop 契约。旧客户端即使误用旧路由也仍会收到既有 409（行为未变）。
- 预览容量从 8 提到 64，但“未过期候选一定可 confirm”的文档承诺现在成立；服务器重启仍会使预览失效（原设计）。
- `PlanPublicationService` 构造器 identity 变为必填：仓库内所有生产调用已带 identity；测试夹具（run-coach）同步声明 identity/operationScope。

---

## 7. 改动文件

**新增（12）**

- `apps/api/src/publication-guard.ts`
- `apps/api/src/plan-read-consistency.ts`
- `apps/api/test/plan-read-consistency.test.ts`
- `apps/api/test/plan-receipt-identity.test.ts`
- `apps/api/test/plan-preview.test.ts`
- `apps/api/test/plan-digest.test.ts`
- `apps/api/test/plan-adherence.test.ts`
- `apps/api/test/weekly-plan-service.test.ts`
- `apps/api/test/plan-publication-stress.test.ts`
- `apps/api/test/plan-publication-stress-child.ts`
- `apps/api/test/plan-publication-stress-publisher.ts`
- `apps/api/test/plan-snapshot-latency.test.ts`

（另：批次 A 新增的 `plan-receipt.ts`、`plan-receipt-v2.test.ts`、`plan-error-semantics.test.ts` 仍在本工作树。）

**修改**

- API：`api-error.ts`、`coach-loop-device-sync.ts`、`coach-loop-routes.ts`、`coach-loop-runtime.ts`、`data.ts`、`local-date.ts`、`mobile-coach.ts`、`mobile-goals.ts`、`plan-adherence.ts`、`plan-digest.ts`、`plan-periodization.ts`、`plan-publication.ts`、`read-store-manager.ts`、`run-coach.ts`、`schemas.ts`、`server.ts`、`weekly-capacity.ts`、`weekly-plan-preview.ts`、`weekly-plan-service.ts`
- API 测试：`coach-loop-runtime-safety.test.ts`、`mobile-coach.test.ts`、`plan-periodization.test.ts`、`read-store-manager.test.ts`、`run-coach.test.ts`、`schemas.test.ts`、`server-runtime.test.ts`、`training-plan-state.test.ts`、`weekly-plan-preview.test.ts`
- 契约/包：`packages/api-contracts/src/index.ts`、`packages/prediction-inference/src/index.ts`
- iOS（27）：APIClient、NativeAppModel、NativeFormat、NativeViews、PlanReceiptMatcher、PlanScheduleOperationJournal、PlanStatePolicy、PlanWatchScheduling、TechPlanWatchSection、TechRaceGoalEditor、TechRunCoachView、TechTrainingReminderView、TechViews、TrainingPlanRepository、TrainingPlanStore、TrainingReminderPolicy、TrainingReminders；测试 ModelRegression、PlanWatchSchedulingRegression、StoreRegression、TrainingPlanStoreRegression、UserExperienceRegression、`check-today-layout.py`、fixtures、3 个 run 脚本
- Rust/环境相关：`crates/rai-data-worker/src/main.rs`（增量账本 previous_* parity）、`apps/api/test/workout-summary-export.test.ts`（迁移后 token 断言）
- 文档/门禁：`docs/ALGORITHM.md`、`COACH_LOOP_IMPLEMENTATION_STATUS.md`、`DECISIONS.md`、三份 plan 文档、`docs/TODAY_PLAN_CARDS_REVIEW.md`、`README.md`、`scripts/check-doc-line-refs.mjs`、`.githooks/pre-commit`、`.github/workflows/ci.yml`
- 交付：`deliverables/TRAINING_PLAN_REVIEW_2026-10-18.md`（§8 指针）、`deliverables/README.md`、本目录 `README.md`

**未提交**：以上改动均在工作树（**88 个文件** = 71 修改 + 17 新增，含未跟踪的新测试/交付文档），未 `git add`/commit/push。
