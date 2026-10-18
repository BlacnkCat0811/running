# 训练计划审查 §8 批次 A 修复记录（2026-10-18）

- 对应审查报告：[TRAINING_PLAN_REVIEW_2026-10-18.md](../TRAINING_PLAN_REVIEW_2026-10-18.md) §8「批次 A」
- 修复范围：P1-1（回执 v2 线格式）、P1-2（revision 冲突 500）、P1-3（coach-loop 读取无跨库回验），以及对应的 HTTP/线格式回归。
- 基线：`HEAD 09ed8d0`（审查时工作树）+ 本轮未提交改动；**未提交 git、未推送**。
- 不在本批次：P2/P3（见 §5）。真机/配对 Watch/Simulator 视觉验收不在本机范围。

---

## 1. P1-1 回执 v2 线格式与 Swift `Codable` 不兼容

**根因**：`/v1/mobile/workout-plan/synced` 与 `/v1/mobile/coach-loop/synced` 要求 `digest(normalizeSessionStructure(structure)) === digest(structure)`；Swift 合成 `Codable` 省略 nil 可选键，normalize 恒写出 `null`，两者摘要不同。缺 `warmup/cooldown` 键时 `prescriptionDigest.step()` 读到 `undefined` 直接 `TypeError → 500`。

**修复**

| 层 | 改动 |
| --- | --- |
| 服务端 | 新增 `apps/api/src/plan-receipt.ts`：`normalizePlanReceiptV2(body, identity, nowMs)` 先做必需字段/scope/日期/`verifiedAt`/摘要校验，再 `normalizeSessionStructure` 并**用规范化结构重算摘要**；返回规范结构。`apps/api/src/server.ts` 的 `/synced` v2 分支改用它并以规范化结构落库；`apps/api/src/coach-loop-device-sync.ts` 同样先规范化再比较/落库。 |
| 摘要函数 | `apps/api/src/plan-digest.ts` 的 `step()` 把 `undefined` 与 `null` 同等处理（不再 `TypeError`）。 |
| iOS | `apps/ios/RAI/APIClient.swift` 抽出 `planSyncWireBody`，对 **contractVersion==2 的所有回执**（教练闭环 + 普通手动计划）统一补 `structure.warmup/cooldown`、每 step `alert`、`alert.lower/upper` 的显式 `NSNull`；legacy 回执仍走合成 `Codable`（省略 nil），`useLegacyContract` 语义不变。 |
| 兼容性 | 服务端**两种线格式都接受**（省略 nil 或显式 null），落库身份统一为规范结构；旧客户端/旧缓存语义不变。legacy coachLoop 回执字节与修复前一致。 |

**回归**

- 新增 `apps/api/test/plan-receipt-v2.test.ts`（7 例）：Swift 形状被接受并规范化、`digest(normalized) != digest(swift)` 证明旧判据会拒绝、缺 warmup 不抛错、摘要/scope/时间/空结构拒绝、真实 `MobileGoalsStore` 落库与两种形状去重、撤回停用当前条目。
- `apps/api/test/server-runtime.test.ts`（HTTP，生产路由）：真实 `/synced` 接受“省略 nil 键”的 v2 回执且 `matchesCurrent=true`（该文件本机因 ONNX 环境无法运行，见 §4）。
- `apps/ios/tests/ModelRegression.swift`：新增非教练 v2 回执 wire 断言（warmup/cooldown/alert 为 `NSNull`、路由正确、核验字段在线）与 legacy 省略键断言。

---

## 2. P1-2 `MobileGoalsRevisionConflictError` 无 `statusCode`，coach-loop/lock 未捕获

**修复**

- `apps/api/src/mobile-goals.ts`：错误类增加 `readonly statusCode = 409`（未捕获路径不再是 `500 internal_error`）。
- `apps/api/src/coach-loop-routes.ts`：`POST /v1/mobile/coach-loop` 捕获该错误，返回 `409 + code + currentRevision`。
- `apps/api/src/server.ts`：`POST /v1/mobile/lock` 同样捕获并返回 409；其余已捕获路由不变。
- `apps/api/src/coach-loop-routes.ts` 对 `@rai/application` 改为**惰性导入**（仅预测刷新 handler 需要），使路由模块可在 ONNX 原生绑定不可加载的宿主机上被测试（对应审查 P2-15 的方向，非完整修复）。

**回归**

- 新增 `apps/api/test/plan-error-semantics.test.ts`：`apiErrorPayload` 对 revision 冲突返回 409 + 原 code；Fastify 真实路由（stub runtime 抛错）返回 409 + `currentRevision`。
- `apps/api/test/server-runtime.test.ts`：教练闭环 HTTP 测试中新增“过期 `expectedRevision` → 409 `mobile_goals_revision_conflict`”断言（该文件本机受 ONNX 环境限制，见 §4）。

---

## 3. P1-3 `GET /v1/mobile/coach-loop` 读取无跨存储域回验

**修复**

- 新增 `apps/api/src/plan-read-consistency.ts`：`readStableSnapshot({ readControl, build, changedError, attempts })` —— 每轮读 control → 取摘要 → build → 再读 control 比对；一致返回本轮结果，否则重试（默认 3 次、夹取 1..5），耗尽抛 `changedError()`。
- `apps/api/src/coach-loop-runtime.ts` 的 `read()`：control 快照改为 `{ saved, goals, history(200) }`；build 用该快照调用 `readFacts`/`evaluate`；不一致返回 `PlanOperationError("coach_snapshot_changed", …, 503)`。`command()` / `recordDeviceReceipt()` 未动。
- `apps/api/src/api-error.ts`：5xx 白名单加入 `coach_snapshot_changed`，避免客户端收到 503 但 code/message 被改写成 `internal_error`。

**回归**

- 新增 `apps/api/test/plan-read-consistency.test.ts`（5 例）：稳定快照 2 读 1 构建；先变后稳返回第二次结果；始终变化 3 次后抛 `coach_snapshot_changed`/503；`attempts: 1`；夹取边界。
- `apps/api/test/plan-error-semantics.test.ts`：`coach_snapshot_changed` 的 503 code/message 不被脱敏。

**残留（已知，未在本批次消除）**

- 无真实并发压测/HTTP 端到端；回验仍是“读前后比对”而非跨库原子事务，存在极窄窗口（方向 fail-closed）。
- 客户端对新契约 503 暂无自动重试（审查 P2-6）；iOS 只对 `plan_snapshot_changed` 有静默刷新分支。本批次先保证错误码/语义正确。
- control 读放大：每请求约 3→6 次 control 读 + 2 次 digest，未测延迟。

---

## 4. 验证结果

环境：macOS 26 / Xcode 26.6 / `node v24.21.0`（DSH 自带，无 npm）。

| # | 检查 | 结果 |
| --- | --- | --- |
| V1 | `tsc --noEmit -p tsconfig.pure.json` | **0** |
| V2 | `tsc --noEmit -p tsconfig.json` | **0** |
| V3 | 新增/受影响 TS 测试（plan-receipt-v2、plan-error-semantics、plan-read-consistency、api-error） | **21/21 通过** |
| V4 | plan/coach 定向套件（21 个非 ONNX 文件 + 3 个新文件） | **222/222 通过**（约 13.4 s） |
| V5 | `bash apps/ios/tests/run-model-tests.sh`（iOS 侧修复后） | **exit 0**；1074 条 PASS，含新增 4 条 wire 断言 |
| V6 | `bash apps/ios/tests/typecheck-ios.sh` | **exit 0**；94 个文件类型检查通过（3 个高德文件明示跳过） |
| V7 | `node scripts/run-ios.mjs gates`（全量 iOS 聚合入口，Lead 最终跑） | 见文末「最终门禁」 |
| V8 | `node scripts/check-doc-links.mjs` / `check-doc-line-refs.mjs` / `check-acceptance-matrix.mts` | 见文末「最终门禁」 |
| V9 | `apps/api/test/server-runtime.test.ts` 新增 HTTP 断言 | **未在本机执行**：导入 `@rai/application` → `onnxruntime-node` 原生绑定签名 `ERR_DLOPEN_FAILED`（审查 §9 已列为环境限制）；新增断言需在可加载 ONNX 的宿主机/CI 执行 |
| V10 | 全量 `node scripts/run-tests.mjs`、`smoke:api`、真机/配对 Watch/Simulator 视觉 | **未执行**（不在本批次自动范围） |

> 最终门禁：`node scripts/run-ios.mjs gates` = **exit 0**（94 文件类型检查、106 store 回归、200 展示检查、排期/状态机回归全过）；`check-doc-links` 82 文件 580 链接 0 问题；`check-doc-line-refs` 默认范围 0 越界；`check-acceptance-matrix` 77 条 cited 77。

---

## 5. 本批次未处理的审查项（P2/P3）

- P1 三个已修复；**P2×18 / P3×21 未处理**，仍以审查报告为准。
- 其中与 P1 修复直接相邻、建议下一批优先的：P2-6（新契约 503 自动重试/`Retry-After`）、P2-2（`matchesCurrent` 事务外计算）、P2-3（回执幂等键作用域）、P2-15（核心计划测试与 ONNX 导入链解耦）、P2-14（`plan-operations` 响应共享类型）、P2-16/P2-17/P2-18（验收矩阵与文档门禁）。
- P2-15 的**部分**缓解：本轮把 `coach-loop-routes.ts` 的预测导入改为惰性，使该模块与新增路由测试可在无 ONNX 宿主运行；`data.ts`/`mobile-read.ts` 的导入链未动。

---

## 6. 改动文件清单

**新增**

- `apps/api/src/plan-receipt.ts`
- `apps/api/src/plan-read-consistency.ts`
- `apps/api/test/plan-receipt-v2.test.ts`
- `apps/api/test/plan-error-semantics.test.ts`
- `apps/api/test/plan-read-consistency.test.ts`

**修改**

- `apps/api/src/server.ts`（回执 v2 规范化、lock 409）
- `apps/api/src/plan-digest.ts`（`undefined` 防御）
- `apps/api/src/coach-loop-device-sync.ts`（规范化后比较/落库）
- `apps/api/src/coach-loop-routes.ts`（revision 409、惰性预测导入）
- `apps/api/src/coach-loop-runtime.ts`（P1-3 `read()` 回验）
- `apps/api/src/mobile-goals.ts`（错误类 `statusCode=409`）
- `apps/api/src/api-error.ts`（5xx 白名单加 `coach_snapshot_changed`）
- `apps/api/test/server-runtime.test.ts`（HTTP 回归：Swift 形状回执、coach-loop stale revision 409）
- `apps/ios/RAI/APIClient.swift`（v2 wire 统一显式 null）
- `apps/ios/tests/ModelRegression.swift`（非教练 v2 / legacy 线格式回归）

**未提交**：以上改动均在工作树，未 `git add`/commit/push。
