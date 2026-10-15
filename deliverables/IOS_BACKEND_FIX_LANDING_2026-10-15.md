# RAI iOS 端后端功能修复落地记录 · 2026-10-15

> 依据：《RAI iOS 端后端功能审查报告 · 2026-10-15》（`deliverables/IOS_BACKEND_AUDIT_2026-10-15.md`）
> ＋ 修复方案（前置收尾 / P1 终局清算 / P2 门禁与失败态 / P3 契约·可观测·安全 / P4 清理）。
> 基线：`e2344dc` ＋ 工作区既有未提交改动（`publicPerformance` 白名单等 3 文件）。
> **结论：除第四节两处明示偏差外，全部批次落地并验证；零新增回归；改动未提交。**

---

## 一、批次执行总表

| 批次 | 状态 | 主要内容 | 验证（实跑） |
|---|---|---|---|
| Batch 0 服务端契约 | ✅ | `IMPORT_STAGES` 单源化（contracts）；`schemas.ts` 补 `lane` + `directSyncApply` 自动派生；`PUBLIC_PERFORMANCE_KEYS` 编译期穷尽守卫 + 嵌套浅拷贝；worker 新增"全键保留 + 拷贝隔离"用例；parity 门禁 15→21 条 | `typecheck`=0；`schemas` 14/14；`worker` 96 例 0 败；parity EXIT=0 |
| Batch 1 终局清算（P1） | ✅ | 新增 `PlanMutationDisposition.swift`（三组终局码）；`resolvePendingPublication` 对 `expired`/`scopeMismatch`/重放终局码**先清账再抛**；`resolvePlanPublication` catch 对终局码直返文案；新增 `abandonPendingPlanPublication()` + 手表区块「放弃本次未确认发布」（二次确认）；回执 catch 以终局集合**作废回执**并如实告知；反馈白名单并入 `coach_scope_mismatch` | 模型回归全过（新增 5 组场景 ~90 条判据）；**突变 A/B 均被检出** |
| Batch 2-A 测试与夹具 | ✅ | 替身 `CacheStore.clear` 与真实现对齐（保留 `publication`/`coach-feedback`/`receipt-journal`）；`StoreRegression` 新增 scope 级 clear 断言 + 损坏行 remove 断言；`PlanTestFixtures` 域外枚举值全部改契约合法值并移除退役字段；**展示门禁新增"夹具域校验"**（取值从契约解析） | `store` 106 条过；`tech-presentation` 200 条过；**突变 S 被检出** |
| Batch 2-B 门禁脚本 | ✅ | `check-direct-sync-status-copy.py` 的 `settled` 锚点相对/绝对坐标混用修正；`MIN_CHECKS` 273→**287**（= 实际判据数，零余量） | **突变 F 被检出**（289 即红） |
| Batch 2-C 失败态可区分 | ✅ | `refreshAll` 四面板结果分类（`ok`/`decoding`/`failure`）：解码失败不再冒充"离线"；分母修正为 4（`failedPanels == 4` 死分支消除）；`TechSleepHistory` 错误态 + 重试；`TechViews` 日期死分支修正；`CacheStore.remove` + `readCacheHealing`（损坏缓存自愈） | 模型回归新增"200+坏 JSON ⇒ 版本不兼容"与"全网络失败 ⇒ 全失败分支"两用例 |
| Batch 3-A 同步链 | ✅（A7 有偏差） | parity 门禁钉死 `laneRefusalFailure` 6 码全集 + inspect 可达子集对齐；`budgetStopNote` 落地 P2c 可观测；轨迹写入缺失补可见告警；**Web 上传补 `X-RAI-Sync-Batch` 内容摘要头** + 新测试 | 见第四节偏差 1；`sec`/`worker`/`web` 全绿 |
| Batch 3-B 语义修正 | ✅ | share-card note 判定顺序修正（先"有没有轨迹"）+ "配置了但参数无效"独立文案；iOS 无折线兜底修正；`MobileTodayResponse` 显式 `init(from:)` 四键降级 + 测试 | `share-card` 14/14；模型回归新增偏斜解码用例 |
| Batch 3-C 安全加固 | ✅ | 5 处 token 比较收敛为 `constantTimeTokenEquals`（SHA-256 + `timingSafeEqual`）+ 新用例；`unsafeMethods` 单源导出；`ServerDiscovery` 读 TXT 宣告、发布构建只收 TLS 候选 | `sec` 10/10；`registry` 运行时 1/1 |
| Batch 4 清理 | ✅ | 删除 4 个无调用方直发写方法（`runCoachCommand`/`confirmWeeklyPlan`/`updateGoals`/`lockSession`）；`informationLevel` 边界注释；429 `Retry-After` 折入文案；导出页静默丢弃补提示；`syncProtocolVersion` 不兼容提示（`RaiHandshake.supportedSyncProtocolVersion`） | `test:ios` 全绿（94 文件类型检查） |

## 二、验证证据（全部串行实跑，日志在 `.workbuddy/runlogs/`）

| 门禁 | 结果 | 日志 |
|---|---|---|
| `npm run typecheck`（双 tsconfig） | ✅ EXIT=0 | `fix-final-typecheck.log` |
| node 定向：security / schemas / share-card / worker 全文件 / 路由登记运行时 | ✅ 10/10、14/14、14/14、96 例 0 败、1/1 | `fix-sec.log`、`fix-schemas.log`、`fix-sharecard.log`、`fix-worker-full.log`、`fix-registry.log` |
| `run-model-tests.sh` 全链（模型/store/展示/后台能力/三支 direct-sync/今日版式/导出确定性） | ✅ EXIT=0（store 106、tech 200、background **288/0**、parity 21、reconcile 43） | `fix-final-model-tests.log` |
| `npm run test:ios` | ✅ EXIT=0（类型检查 **94 文件**；全部结构回归） | `fix-final-test-ios.log` |
| web `vitest run`（全量） | ✅ 25 文件 / **186 tests** EXIT=0 | `fix-final-web2.log` |
| `check:doc-refs`（改动后复跑） | ✅ 0 越界 / 0 内容漂移 | `fix-docrefs-1.log` |

**突变账（4/4 被检出，均在 git worktree 中做、未动工作区）**：

| 突变 | 期望红的断言（实际命中） | 日志 |
|---|---|---|
| A：移除 `expired` 分支清账 | "an expired terminal answer clears the durable ledger…" | `fix-mutationA-expired-clear.log` |
| B：短路回执终局分支 | "a terminal receipt rejection is reported as final…" | `fix-mutationB-receipt-terminal.log` |
| F：门禁地板 287→289 | "only 287 judgements ran, floor is 289…" | `fix-mutationF-gate-floor.log` |
| S：`clear(scope:)` 连安全元数据一起删 | "the scoped clear-cache path must not delete an unresolved publication ledger" | `fix-mutationS-clear-metadata.log` |

## 三、可观测/契约同步的连带更新

- `deliverables/DIRECT_SYNC_TAIL_PAGE_ROOT_FIX_PLAN_2026-10-14.md`：P2a/P2c 状态口径更正（P2a 已落地、P2c 已合入）。
- `.workbuddy/memory/NOTES-ios.md`：507 码名订正为 `import_upload_capacity_exceeded`。
- `deliverables/README.md`：本记录与审查报告均挂入「当轮审查」索引。

## 四、偏差（未按方案原文照做之处及理由）

1. **A7「直接移除 Web 端手动上传」→ 改为幂等修复**。
   已修复的**缺陷本身**：上传不带 `X-RAI-Sync-Batch` ⇒ 重传产生重复来源；现按文件字节 SHA-256 补齐幂等头（`DataModelPage.sha256Hex`，摘要失败即中止而非无幂等上传），并新增头断言测试。
   未做**移除**的理由（三条）：
   ① Web 是 `AGENTS.md` 声明的**主产品**，上传/来源管理流程有 20+ 个在跑的测试与多处产品文案，属产品范围变更；
   ② 事实核查：该流程的**导入**在当前服务端已不可行（两条车道都要求 v2 清单而 Web ZIP 无清单，见 `import-payload-preflight.test.ts` 的收口注释）——这是比"无幂等"更**独立的产品级问题**，"移除 / 替换为只读概览 / 恢复无清单支持"三条路都需要产品决策；
   ③ 按"高风险/不可逆动作先获授权"纪律，未擅自删除主产品功能。**建议单列一批处理**（推荐方案：入口替换为只读「iOS 同步状态与数据源概览」卡 + 清理关联测试与文案）。
2. **A3 未加客户端阈值熔断** → 采用方案中并列允许的**契约全集门禁**形态：`check-direct-sync-contract-parity.py` 现钉死 `laneRefusalFailure` 的 6 码全集与 inspect 可达子集，任何新码必须在同批补 iOS 处置；可选后续：若出现第二类 inspect 400 码，再补运行时熔断。
3. 其余小口径：`informationLevel` 用注释声明边界（不消费）；导出页用轻量提示（不引入独立状态机）。

## 五、遗留与未覆盖

- 🟡-C3（未登记回执的服务端可见性）：仍待实跑定性，本批未动。
- 真机项（BGTask 后台同步、后台 URLSession 续传、锁屏/冷启动）依属真机验收范围。
- 全量 `npm test`（默认并发口径不可信）与 `test:e2e:web` 未跑；本批以定向批 + web vitest 全量替代（理由见审查报告 §七）。
- `apps/ios/RAI.xcodeproj/project.pbxproj` 有 4 行 CocoaPods 生成性改动（空 `inputPaths`/`outputPaths`），**非本批改动**、未处理，属工具链噪音。

## 六、提交与回滚建议（改动全部未提交）

建议按 4 个提交分组、逐组可独立 `git revert`：
1. **服务端**：`apps/api/src/{import-worker,schemas,server,local-request-security,data}.ts` + `packages/api-contracts` + `apps/api/test/*`（含基线 3 个未提交文件一并收编）；
2. **iOS 客户端**：`apps/ios/RAI/**`（含新文件 `PlanMutationDisposition.swift`）；
3. **iOS 测试与门禁**：`apps/ios/tests/**` + 编译列表脚本；
4. **Web**：`apps/web/**`（A7 幂等修复）。

_本记录与审查报告同日成对；两文件中所有引用均经 `check:doc-refs` 核对（0 越界 / 0 漂移）。_
