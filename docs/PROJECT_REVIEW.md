# 项目审查（现行状态与未决问题）

**as-of：2026-10-20（Asia/Shanghai）**。审查基线：`git HEAD = 9db450f`，审查对象为当前工作树。
本文件只维护**当前状态、未决问题与证据指针**；2026-09-30 与更早的审查原文按 as-of 保留在 §6，数字不改写。
已收尾批次与已删除文档只留指针（§5），全文可从 Git 取回。

入口：[README](../README.md)；现行合同：[算法](ALGORITHM.md)、[架构](ARCHITECTURE.md)、
[数据管线](DATA_PIPELINE.md)、[决策](DECISIONS.md)、[运维](OPERATIONS.md)、
[iOS API 契约](IOS_NATIVE_API_CONTRACT.md)、[iOS 计划排期协议](IOS_NATIVE_PLAN_SCHEDULING.md)。

**2026-10-21 复核与实施提案**：[项目真实状态复核与优化方案](PROJECT_OPTIMIZATION_PLAN.md)。
该方案基于当前工作树重新核验，包含已修正文档项、合成探针新增证据及分批验收/回退步骤；
不改写本文 2026-10-20 的历史验证数字，也不表示方案中的业务修复已实施。

**2026-10-21 实施进度**：PR-01（测试证据与 5xx 脱敏、客户端 410 终局）、PR-02（读写能力分离、
统一页止血、客户端只读守卫、共享 method+path 退役表与出站门禁）、PR-10（CLI 候选发布前
`quick_check` + 外键检查）已落地；PR-05 先落了 handshake 键注册表与 facts/analysis 能力位镜像/暂不消费决定；
PR-03/04 仍待所有者做计划所有权决定。证据见 [优化方案 §13](PROJECT_OPTIMIZATION_PLAN.md)。

## 1. 当前状态

| 面 | 状态 | 证据 |
|---|---|---|
| 客户端/部署 | 原生 SwiftUI iOS + 直连 Node API；Web/macOS 已于 2026-10-17 退役（D17/ADR-006） | [决策](DECISIONS.md) D17；[ADR-006](adr/ADR-006-retire-web-and-macos.md) |
| 生产 | `101.33.202.40`；训练排课 v2 `2f5f2b8`（2026-10-20 部署 + 控制库迁移）；iOS 同步 R1–R6 `62f490b`（同日部署）；阶段 2 SQLite 优化 `9364270`（2026-10-22 部署） | [训练排课发布](../deliverables/UNIFIED_TRAINING_PLAN_RELEASE_2026-10-20.md)、[iOS 同步发布](../deliverables/IOS_SYNC_RELEASE_2026-10-20.md)、[阶段 2 发布](../deliverables/PHASE2_SQLITE_RELEASE_2026-10-22.md) |
| 存储 | 主健康库 schema v47（2026-10-22 生产已迁移 v46 → v47）；控制库 `mobile_control_schema` v2（`mobile_training_state`）；另有 runtime / dataset-epoch / restore-journal 三个 SQLite 文件 | [阶段 2 发布](../deliverables/PHASE2_SQLITE_RELEASE_2026-10-22.md)、[架构审查](../deliverables/ARCHITECTURE_REVIEW_2026-10-20.md) |
| 训练计划 | 统一训练排课 v2：单一模式（coach/race）、剂量政策 v2、控制库 v2、v2 读/命令/预览/刷新；旧计划写面 5 路径 / 7 操作 410 `legacy_surface_retired` | [API 契约](IOS_NATIVE_API_CONTRACT.md)、[排期协议](IOS_NATIVE_PLAN_SCHEDULING.md)、[发布记录](../deliverables/UNIFIED_TRAINING_PLAN_RELEASE_2026-10-20.md) |
| 策略政策 | G01-B / G02-C / G03-A 已由仓库所有者（产品/规则所有者）2026-10-20 方向性批准并实现；**无独立临床/教练领域复核** | [政策评审](TRAINING_PLAN_POLICY_REVIEW.md) |
| 健康同步 | 直连增量 + 硬失败（不回退候选库）；R1–R6 已发布；真机验收未做 | [iOS 同步发布](../deliverables/IOS_SYNC_RELEASE_2026-10-20.md) |

### 1.1 本轮（2026-10-20）实际验证基线

来自 2026-10-20 架构审查（基线 `9db450f`，4 条只读 lane + Lead 独立实跑）：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | EXIT 0 |
| `RAI_TEST_CONCURRENCY=2 npm test` | **2224 tests / 2211 pass / 0 fail / 13 skipped**（598 s，并发 2） |
| `npm run test:ios` | EXIT 0：**98 个 Swift 文件**类型检查（3 个仅依赖高德 SDK 的文件显式跳过）+ 34 组纯逻辑/结构门禁（**1508 PASS**） |
| `npm run check:acceptance-matrix` | 80 条 / cited 80 / declared-gap 0 / missing 0 |
| `npm run check:package-boundaries` | 16 包 / 31 条 src 边 / 4 条禁线 |
| `npm run check:training-plan-single-writer` | 生产源 465 / 测试 122 / 违规 0 |
| `npm run check:scripts` | 18 个 package.json / 105 条 script |
| `npm run check:docs` | 收敛前实测 112 files / 710 links / 0 problems；本轮删除/改写后以命令输出为准 |
| `npm run smoke:api` | 通过 |
| `npm audit --omit=dev` | 4 moderate（onnxruntime 链），无 high/critical |

13 条 skip 明细：3 条 Windows 语义（路径别名 / 进程树 / 锁定回滚）+ 10 条 Rust parity
（本机无 `cargo`/产物早于源码，按设计 fail-safe 跳过；**不写成通过**）。

### 1.2 本轮明确**未**验证（不得读成通过）

- **真机与 Simulator**：训练排课 v2、WorkoutKit 强读回、先撤回再下发、HealthKit 后台投递、
  锁屏/跨午夜、旧构建 410 组合——均未执行。
- **生产库迁移/备份恢复演练**（真实 325 MB 主库）未做；生产部署行为按发布记录实测，未登录服务器复跑 `nginx -t`/watchdog。
- **Rust parity** 未重建工具链；**Windows 运行时**未验证。
- **gitee CI 未启用**：远端为 gitee，GitHub workflow 存在不代表已触发；门禁只在本机 pre-commit/手工执行有效。
- 预测模型训练子进程交互、OOM 后 systemd 拉起、模型准确率均未评估。

## 2. 当前未决问题

口径：P0 = 数据丢失/安全/生产不可用；P1 = 发布阻断或硬架构不变量被破坏；P2 = 用户可见错误或高概率结构性风险；
P3 = 低影响/防御性/可维护性/文档。细节与逐行证据见
[架构审查 2026-10-20](../deliverables/ARCHITECTURE_REVIEW_2026-10-20.md) 及其 4 份 lane 报告。

### P1（1 条）

**AR-1 训练排课 v2 的“退役/启用”边界未闭环：服务端已 410，iOS 仍在消费旧写路由。**
`server.ts` 的 `retiredLegacyRoutes` 覆盖 `/v1/mobile/goals`、`/v1/mobile/run-coach`、
`/v1/mobile/workout-plan/{preview,confirm,generate}`；但 iOS `APIClient` 仍保留这些路径，
`NativeAppModel.publishPlan` 仍按旧路由发布，统一训练页仍渲染“手动课表”入口
（`TechPlanView.swift` 的 `manualPlanEntry`），无教练计划时保存/预览/确认必命中 410。
`apps/ios` 对 `/v1/mobile/training-plan/commands` 的引用为 **0**；握手也没有
`trainingPlanContractVersion` 能力位，客户端无法在能力层判断“这台服务支持哪些计划写”。
另外 410 被读侧当作可重试错误，而不是终局升级提示。
**不做什么**：不在客户端硬编码“忽略 410 当成功”；不把旧路由重新打开。
**收口条件**：客户端接入 v2 写端点或按能力隐藏手动入口；补 handshake 能力位；
新增“客户端源码不得出现已退役路径”的结构门禁。

### P2（主题合并；逐条见 lane 报告）

1. **AR-2 计划状态双真相**：控制库同时保存 legacy `mobile_goals` 与 `mobile_training_state`；
   v2 配置单向镜像进 goals，而 lock/排期回执/教练闭环只写 goals、不回写 unified。
   coach-loop managed 数据集上 `/v1/mobile/training-plan-state` 的 v1+v2 一起 409，
   新合同可用性仍由旧合同生命周期决定。**未决产品/架构决定**：唯一真相与退出条件。
2. **契约四面手写漂移**：同一 HTTP 形状有 TS DTO / JSON Schema+OpenAPI / Swift DTO / Fastify 四处手写，
   响应成功形状只有手写 required 名单；2026-09-01 起 454 个提交中 32 个同时改 ≥3 面。
3. **读路径无预算**：约 37 个读方法同步跑在主事件循环，无 `requestTimeout`、无“超预算 503 + Retry-After”，
   唯一兜底是 systemd watchdog 120 s 杀进程。
4. **部署/可观测**：`deploy/upgrade.sh` 先 pull 后迁移且失败不自动回滚；watchdog/OOM/启动限流触顶全部静默，
   `OnFailure=` 与日检缺失；导入 worker 无 `resourceLimits`。
5. **策略独立复核缺失**：G01–G03 只有所有者方向性批准，没有独立临床/教练复核；
   `TRAINING_PLAN_POLICY_REVIEW` 的标准案例与常量已由测试钉住，但不得据此声称训练收益或风险下降。
6. **今日页计划卡（C4/C5）**：C1–C3 与 A1–A4 已在 2026-10-18 修复（量带/完成度措辞、replan 窗口文案、
   两卡串联），但“强度加权负荷”与“里程依从性”两套口径仍无交叉核对（C4），
   `buildPlanAdherence` 仍不读教练每日决策（C5）；`plan_below_phase_band` 判据（方案 B）未实现，
   阶段卡降级（方案 C）未做。属于产品/规则决定，不只是技术债。
7. **真机证据缺口**：训练排课 v2 的视觉/无障碍、WorkoutKit 读回与撤回顺序、HealthKit 分页开关、
   签名构建与安装——见各发布记录“跳过/未执行”节。
8. **gitee CI 未启用**：门禁的“存在”依赖本机 pre-commit；远端不产出绿灯，不能把“本地通过”读成“CI 通过”。
9. **13 条 skip**：3 Windows + 10 Rust parity；修复前提是真实 Windows 主机与 Rust 工具链。
10. **文档-计划一致性**：本轮已收敛“训练计划 7 份文档 + deliverables 当轮堆积”的问题（§5），
    并新增 [iOS 计划排期协议](IOS_NATIVE_PLAN_SCHEDULING.md)；
    防回归靠两条：新结论只写进**现行文档**；`check:docs` 只验证链接/可达，
    需在评审时人工确认“命令/路径承诺仍存在”（AR-9 的已知盲区）。

## 3. 当前门禁入口

普通改动：`npm run typecheck`、`RAI_TEST_CONCURRENCY=2 npm test`、`npm run test:ios`；
文档改动另跑 `npm run check:docs`、`npm run check:doc-refs`、`npm run check:acceptance-matrix`、
`npm run check:scripts`；服务启动/部署模板另跑 `npm run smoke:api`。
训练计划结构变更另跑 `npm run check:training-plan-single-writer`。
iOS 源文件门禁见 `npm run check:ios-gates`（无 Xcode 也可跑；孤儿门禁直接判红）。
模拟器视觉验收与 AMap 坐标交叉检查仍为手工项，需要 booted Simulator 与 `var/rai.sqlite`。

“脚本跑绿 ≠ 门禁存在”：已知盲区包括 18 支 `.mjs` 门禁不在 `typecheck` 内、13 支零测试引用、
5 个发布判据只出现在文档里、`check:doc-refs` 无基线时内容漂移“未核对”、文档锚点判据覆盖面低。
新增判据必须做突变验证（改坏→红，还原→绿）。

## 4. 证据分级

E1 = 静态逐行阅读；E2 = 实跑命令/测试/探针；E3 = 推断（写明前提）。
“跳过”“未执行”“文档承诺”都不能当实现证据；数字只对标注的 as-of 日期与并发口径成立。

## 5. 已收尾批次与已删除文档（指针）

本轮（2026-10-20 文档收敛）把“训练计划”主题从 7 份现行文档收敛为 2 份
（[API 契约](IOS_NATIVE_API_CONTRACT.md) + [计划排期协议](IOS_NATIVE_PLAN_SCHEDULING.md)），
政策评审保留为签字记录；同步/教练主题中已完成的 5 份时点方案/状态文档一并删除；
`deliverables/` 从 63 份 tracked md 收敛为 8 份当前证据 + 固定 JSON 证据。
**删除不等于丢失**：全部可按 `git show <收尾提交>:<路径>` 取回；精确的“最后改动提交”用
`git log -1 --format=%h -- <路径>` 查询。

### 5.1 docs/ 本轮删除

| 主题 | 收尾提交 | 已删除文档 | 现在看哪里 |
|---|---|---|---|
| 训练计划架构方案（2026-10-09） | `24aa7d8` | `docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md` | [API 契约](IOS_NATIVE_API_CONTRACT.md)、[排期协议](IOS_NATIVE_PLAN_SCHEDULING.md)、§2 未决问题 |
| 训练计划实施记录（2026-10-09） | `24aa7d8` | `docs/IOS_TRAINING_PLAN_IMPLEMENTATION.md` | [排期协议](IOS_NATIVE_PLAN_SCHEDULING.md) §1–§6 |
| 训练计划状态 V1（2026-10-09） | `24aa7d8` | `docs/IOS_TRAINING_PLAN_STATE_V1.md` | [API 契约](IOS_NATIVE_API_CONTRACT.md)（回执 v2 / 90 天操作）、[排期协议](IOS_NATIVE_PLAN_SCHEDULING.md)（日志/撤回） |
| 今日页计划卡审查（2026-10-06） | `24aa7d8` | `docs/TODAY_PLAN_CARDS_REVIEW.md` | §2 未决问题第 6 条（C4/C5/B/C） |
| 教练闭环实施状态（2026-10-10） | `24aa7d8` | `docs/COACH_LOOP_IMPLEMENTATION_STATUS.md` | [教练闭环方案](COACH_LOOP_OPTIMIZATION_PLAN.md) §0/§11（5 类外部签收）、[算法](ALGORITHM.md) |
| 佳明教练研究（背景资料，非规范） | `1f6e58e` | `docs/GARMIN_COACH_RESEARCH.md` | [跑步教练](RUN_COACH.md) 对齐对象/未复刻边界、[决策](DECISIONS.md) D15 |
| 同步优化后七项修复方案（2026-10-16/17） | `0a8cef8` | `docs/IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN.md` | [数据管线](DATA_PIPELINE.md)（覆盖/裁剪边界）、[同步优化审查](IOS_SYNC_PERFORMANCE_REVIEW.md) |
| 第二轮复查修复方案（2026-10-17） | `0a8cef8` | `docs/IOS_SYNC_RECHECK_FIX_PLAN_2026-10-17.md` | [数据管线](DATA_PIPELINE.md)、[同步优化审查](IOS_SYNC_PERFORMANCE_REVIEW.md) |
| 第三轮扩展性优化记录（2026-10-17） | `63c2050` | `docs/SYNC_COMPUTE_SCALING_PLAN_2026-10-17.md` | [运维](OPERATIONS.md)、[iOS 同步发布](../deliverables/IOS_SYNC_RELEASE_2026-10-20.md) |

### 5.2 deliverables/ 本轮删除（已收尾批次，按主题归组）

| 主题 | 收尾提交 | 已删除文档 | 当前证据在哪 |
|---|---|---|---|
| 直接增量同步 PR1–PR6（2026-10-12 ~ 10-15，16 份） | `60678af`（PR6）、`9e08301`（尾页根治）等 | `ACCEPTANCE_INVENTORY_DIRECT_SYNC_2026-10-13`、`DIRECT_SYNC_A10_ANALYSIS_ISOLATION_2026-10-13`、`DIRECT_SYNC_ANALYSIS_WAKE_FIX_2026-10-13`、`DIRECT_SYNC_PR1_2026-10-12`、`DIRECT_SYNC_PR2_PR3_2026-10-12`、`DIRECT_SYNC_PR4_2E_2026-10-13`、`DIRECT_SYNC_PR4_STEP1_2026-10-13`、`DIRECT_SYNC_PR4_STEP2AB_2026-10-13`、`DIRECT_SYNC_PR4_STEP2CD_2026-10-13`、`DIRECT_SYNC_PR4_STEP3_REVISION_2026-10-13`、`DIRECT_SYNC_PR4_STEP3_WRITE_LEASE_2026-10-13`、`DIRECT_SYNC_PR5_S1S2_2026-10-13`、`DIRECT_SYNC_PR6_A15_A17_AND_PR5_S3S6_2026-10-13`、`DIRECT_SYNC_PR6_DEVICE_VERIFICATION_2026-10-13`、`DIRECT_SYNC_TAIL_PAGE_ROOT_FIX_PLAN_2026-10-14` | [数据管线](DATA_PIPELINE.md)、`docs/SQLITE_DIRECT_SYNC_*_DESIGN.md` |
| 2026-10-18 全项目深度审查（8 份） | `2f98ac9` | `DEEP_REVIEW_2026-10-18` + `deep-review-2026-10-18/{README,01-data-pipeline,02-domain-algorithms,03-api-runtime,04-ios-client,05-infra-gates,FIXES_2026-10-18}` | 问题已同轮修复；现行结论看 [架构审查 2026-10-20](../deliverables/ARCHITECTURE_REVIEW_2026-10-20.md) |
| 2026-10-18 训练计划审查（9 份） | `24aa7d8` | `TRAINING_PLAN_REVIEW_2026-10-18` + `training-plan-review-2026-10-18/{README,01-api-read,02-api-write,03-domain-algorithms,04-ios-client,05-docs-contracts-tests,FIXES_BATCH_A,FIXES_BATCH_BC}` | 3 P1 + 18 P2 已修复；v2 已替换其描述的写面，见 §1/§2 |
| iOS 同步 2026-10-19/20 执行与复审（9 份） | `62f490b`（发布）、`67028e1` | `IOS_SYNC_B6_FIX_EXECUTION_2026-10-19`、`IOS_SYNC_DEFECT_FIX_EXECUTION_2026-10-19`、`IOS_SYNC_EXECUTION_2026-10-19`、`IOS_SYNC_FOLLOWUP_PLAN_2026-10-19`、`IOS_SYNC_INGEST_AUDIT_2026-10-19`、`IOS_SYNC_OPTIMIZATION_EXECUTION_2026-10-19`、`IOS_SYNC_REREVIEW_2026-10-19`、`IOS_SYNC_VERIFY_AND_PLAN_2026-10-19`、`HEALTHKIT_SYNC_REPORT_VERIFICATION_AND_PLAN_2026-10-19` | [iOS 同步发布](../deliverables/IOS_SYNC_RELEASE_2026-10-20.md)、[未实施项核实](../deliverables/IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md) |
| Web/macOS 退役旧方案（1 份） | `91dbed9` | `WEB_DESKTOP_REMOVAL_PLAN_2026-10-15` | [退役实施手册](../deliverables/plan-remove-web-keep-ios-api.md)、D17/ADR-006 |
| 2026-10-11 ~ 10-17 当轮审查/事故记录（13 份） | `694b5f1` / `91dbed9` / `9e08301` / `09ed8d0` 等 | `API_HANG_TRIAGE_2026-10-11`、`IMPORT_PUBLICATION_REDESIGN_2026-10-11`、`LATEST_WORKOUT_MISSING_DATA_2026-10-15`、`RUNNING_POWER_GCT_MISSING_2026-10-17`、`INCREMENTAL_SYNC_IMPLEMENTATION_PLAN_2026-10-14`、`UNCOMMITTED_REVIEW_2026-10-11`、`UNCOMMITTED_REVIEW_2026-10-12`、`INGEST_PERSIST_CHAIN_REVIEW_2026-10-15`、`IOS_BACKEND_AUDIT_2026-10-15`、`IOS_BACKEND_FIX_LANDING_2026-10-15`、`IOS_SYNC_INGEST_REVIEW_OPTIMIZATION_2026-10-15`、`SYNC_DATA_PIPELINE_AUDIT_2026-10-15`、`review-ios-sync-data-ingest` | 结论已落地到代码/测试；运维铁律进 [运维](OPERATIONS.md)，产品决定进 [决策](DECISIONS.md) |

取回单份原文：`git show <收尾提交>:<原路径>`；定位历史：`git log --follow -- <原路径>`。
删除清单与理由见 [deliverables/README](../deliverables/README.md)。

## 6. 历史审查（as-of 保留，不改写）

> 以下 §6.1–§6.5 是 **2026-09-30** 审查原文/要点与后续批次记录，数字只对当时成立。
> 保留原因：这些是已发生的缺陷、修复证据与文档删除决策的记录；回写等于伪造历史。
> 现行结论只看 §1/§2 与 [架构审查 2026-10-20](../deliverables/ARCHITECTURE_REVIEW_2026-10-20.md)。

### 6.1 2026-09-30 审查：问题与修复（原文）

审查日期：2026-09-30。基线提交 `f33ec708802d4b7cc4f6284af7e84efa4b5800cd`，对象为包含前一轮算法改动的当前未提交工作树。
**当时结论**：文档清理完成，R1–R4 代码修复及本机相关回归已完成；原始边界探针从 3 项违反变为 0 项。
真实 Windows 运行时、真机和线上部署未在本轮执行。

#### R1 · P1（已修复）：旧 bundle 激活不检查当前 override，可恢复已排除训练的评分

**位置**：`packages/storage-sqlite/src/model-release-repository.ts` 的 `verifyAndPoint`；
`packages/application/src/service.ts` 的 `appendWorkoutOverride`。

- `verifyAndPoint` 只验证已存 lineage 自身 hash、快照 hash、datasetVersion 和 active 关系，
  没有把 lineage 的 overrideSnapshotHash 与当前有效 override 比较。
- 保存反馈/排除覆盖不会修改 datasetVersion，因此旧已发布 bundle 仍能通过激活。HTTP 模型切换与命令队列都调用这一路径。
- **合成复现**：先建立模型 A → 把一条训练设为 exclude 并重算 B → 再激活 A。当前 override 仍为 exclude，
  active assessment 却从 `excluded` 回到 `eligible`，没有拒绝。
- **影响**：当前用户设置与当前评分结果矛盾；“回滚算法”实际上回滚了派生结果使用的事实修订，却没有让用户确认这个区别。
- **建议修复**：激活时同时验证当前 facts/override 语义版本；不兼容旧 run 仅允许历史比较，
  或按目标旧政策在最新事实/override 上生成新的受控 bundle。新增 API/CLI 两入口的失败不换指针回归。

**已完成修复**：V4 发布/激活/回滚对当前有效 override ID 序列计算语义 hash，与捕获的 lineage hash 比较；
V3 兼容路径对照 training metric config 中的 overrideSnapshotIds，不能借旧 schema 绕过。
发生中途 revision 变化时保留计算时的冻结事实，但拒绝发布，旧 active/bundle 指针不动；按最新覆盖重算后才可发布。
不同覆盖的旧 run 仍可历史查看，不可成为当前。同事实 rollback 仍有成功回归。

#### R2 · P1（已修复）：训练全部删除后，空结果重放被 gate 挡住，旧派生结果仍 active

**位置**：`packages/storage-sqlite/src/model-transition-gate.ts` 的 `evaluateModelTransitionGateV2`；
`packages/application/src/services/recompute-pipeline.ts` 的发布分支。

- 前一轮已修复部分训练删除和校准证据删除，但 `matchedSessions===0` 仍无条件进入 `not_evaluable`。
- **合成复现**：10 条训练已发布 → 全部明确设为 inactive、清 canonical 关联、更新 dataset 版本 → 完整重算。
  job 失败，报 `Model-version gate failed: not_evaluable`，active 派生评估仍有 10 行。
- **影响**：合法的“删除最后一条/全部训练”无法完成新空结果发布；这里复现的是派生结果发布阻塞，不声称原始记录被复活。
- **建议修复**：增加“所有来源均已明确删除、候选确实为空”的可审计空状态转换，不全局放宽 no-matched 保护。

**已完成修复**：新增由数据库现场计数生成的 emptyCohort 证据，要求旧训练全部明确 inactive、
没有仍 active/ambiguous 的来源、候选 feature/assessment/load/daily/checkpoint 与训练 domain 快照为空，
并保持恢复隔离和其余硬 gate。只对这种已证明的空转换免除 no-matched；未知 scale、缺证明、NaN、残留行仍拒绝。

#### R3 · P2（已修复）：正常保留清理会丢失当前 epoch 的生效日期

**位置**：`packages/application/src/baseline-rebase-review.ts` 的 `buildBaselineRebaseReview`；
`packages/storage-sqlite/src/model-release-repository.ts` 的 `retireOldReleases`。

- 检查器从创建该 epoch 的 release evaluation 读取 effectiveAt；后续相同 epoch 的 run 不携带这份独立生命周期信息。
- 保留策略只保留当前及有限历史 release，会清理 epoch 起始收据；检查器随后静默退回 checkpoint 中的历史校准训练日期。
- **生产路径合成复现**：显式 rebase 后，同配置完整重算 3 次触发正常清理；epoch ID 不变，起始收据已删除，
  `startedAt` 从 `2026-01-31T04:00:00.000Z` 变为 `2026-01-19T00:00:00.000Z`。
- **影响**：epoch 年龄/90 日冷却会按错误日期计算，审计链不完整。
- **建议修复**：epoch 生命周期元数据独立持久化，或在所有依赖的 epoch/run 退役前 pin 起始记录。

**已完成修复**：将当前及保留 rollback 版本依赖的 epoch 起始 release 列为清理依赖，按 dataset+epoch 保留它；
最后一个依赖 epoch 版本退役后，起始 receipt 可正常清理。读端按相同 dataset 定位 effectiveAt。
此前已被删除的历史元数据无法凭空恢复，本修复不会伪造 effectiveAt。

#### R4 · P2（已修复）：根 npm test 使用 POSIX 语法，与声明的 Windows CI 入口不兼容

**位置**：`package.json` 的 `scripts.test`；`.github/workflows/ci.yml` 的 `windows-runtime` job。

- 脚本用 `;`、`node_status=$?`、`test ... -eq ...` 组合 Node 和 Web 测试；这是 POSIX shell 语法。
- Windows job 直接运行 `npm test`，仓库未配置 Windows npm script-shell。
- **证据等级**：源码/配置确认，**本机 macOS 未执行 Windows 运行时复现**；macOS 测试通过不能证明 Windows gate 有效。

**已完成修复**：`scripts/run-tests.mjs` 直接用 `process.execPath` 与 `shell:false` 运行 Node；
显式枚举 TS 测试文件，不依赖 shell glob、分号、`$?` 或 `npm.cmd`。实机 Windows 未在本机执行。

#### 可复现探针

`scripts/review-model-boundaries.mts` 只创建并清理临时合成 SQLite/XML，不碰真实数据库：

```bash
npm run review:model-boundaries -- --out /tmp/rai-model-boundaries.json
```

原始审查产物：[model-boundaries.json](../deliverables/project-review-2026-09-30/model-boundaries.json)（当时 exit=1、violationCount=3）；
修复后：[model-boundaries-after.json](../deliverables/project-review-2026-09-30/model-boundaries-after.json)（exit=0、violationCount=0）；
`exit=2` 仍表示探针前置失败，不能当缺陷证据。清理明细与保留映射见
[verification.json](../deliverables/project-review-2026-09-30/verification.json)，
修复摘要见 [fixes-verification.json](../deliverables/project-review-2026-09-30/fixes-verification.json)。

### 6.2 2026-09-30 的文档整理结果（原文要点）

- Markdown **192 → 20 份**（减少约 89.6%）；删除 179 份旧 Markdown，新建 7 份整合入口/说明。
- 已跟踪过期文件删除 198 份（179 份 Markdown + 19 份旧核验 JSON/行号快照等），可通过 Git 历史恢复。
- 删除旧 PRD、V2 批次、多个状态/审计及未立项 Watch/N100 计划，不继续复制 archive。
- 运行时数据审计 `docs/DATA_AUDIT.md` 取消跟踪并忽略；算法 54 项矩阵迁到 [现行合同](ALGORITHM.md)。
- 新增 `check:docs` 并接入 pre-commit/CI；**不是删除检测来掩盖漂移**：废弃的逐行位置快照随旧文档移除，
  现行说明采用文件路径/函数名；真正的本地链接和孤立文档检查由 `check:docs` 负责。

### 6.3 2026-09-30 的检查结果（as-of，数字不改）

- `npm run typecheck` 通过；`npm test` Node 1154 / 1151 通过 / 0 失败 / 3 跳过，Web 18 文件 / 111 项通过；
  `npm run build`、`test:e2e:web` 当时存在（**D17 后已删除，不是“本轮未运行”而是“不存在”**）。
- `npm run test:ios` 类型检查 67 个 Swift 文件（3 个高德依赖文件按 gate 排除）；`npm run ml:test` 26 通过；
  `rust:verify` 2 项 + TS/原生导入 11 项通过；`smoke:api` 通过；`npm audit --omit=dev` 0 个已知 production 漏洞。
- 文档/矩阵/包边界：matrix 54 cited / 0 gap / 0 missing，包边界 15 packages / 30 src edges
  （**当前值：matrix 80、16 packages / 31 edges**，以命令输出为准）。
- 当时新增边界审查**未通过**：R1、R2、R3 均已复现；不隐藏在上面的通过数中。

### 6.4 2026-09-30 的覆盖与边界（原文要点）

- 领域/ML、数据/发布、API/安全、Web、iOS、Rust/部署、CI/跨平台各层均只读核对；未做公网渗透测试、
  未登录线上服务器、未做真机 HealthKit/后台/地图/视觉验收、未在真实 Windows 运行。
- “完整审查”指覆盖上述组件与关键风险路径，不等于穷尽每条执行路径或证明没有其它缺陷。
- 本机原库：schema22、268 条 training session、零有效比赛/测试标签；不代表线上状态。
  原库 SHA-256 仍为 `cef127be078031b66072eda5d0ecc4552d1d70a5d95898ebd9ff1420aa4b957d`，本轮未迁移/重算/删除/激活原库模型。
- 天气/独立标签不足时，拟合归一化、Durability 数值罚分、ML/经验 P80/P90 继续关闭；工程通过不等于已部署或准确率改善。
- 剩余部署边界：四项修复完成不等于真实主库已迁移或线上发布；Windows 现场验证交由真实 Windows CI/主机；
  原库升级需独立维护窗口、备份和迁移审查。

### 6.5 2026-10-09 ~ 10-11 批次收尾（原文 §8）

当时三个批次已提交并部署，按“收尾后并入本文件或删除”的约定删除原文；下表为历史记录：

| 批次（主题） | 收尾提交 | 原文档（已删，Git 可恢复） |
|---|---|---|
| HealthKit 记录同步 v2：v30/v31 迁移 + 逐类型变更游标 + 类型作用域 UUID 删除 | `e05f59e` → `308fee9` | `deliverables/UNCOMMITTED_REVIEW_2026-10-09.md` |
| iOS 数据同步失败修复：普通同步不再全量重扫 + 导入失败诊断可见 + 失败上传包保留 | `0c01f7d` → `14bda36` | `deliverables/UNCOMMITTED_REVIEW_2026-10-10.md` |
| 纯补史导入被资格漂移门禁永久死锁的修复 | `cebb0dc` → `f2e5da0` | `deliverables/VERIFICATION_2026-10-11-source-backfill.md` |
| iOS `jobId` 前台续接 + 逐类型进度文案 + live 探针陈旧源文件清单 | `076b8bd` / `6ea930f` → `5950a11` | `deliverables/VERIFICATION_2026-10-11-ios-resume.md` |

### 6.6 更早的审查与证据入口

- 2026-10-18 深度审查：已删除，取回指针见 §5.2；同轮 11 P2 + 42 P3 全部修复。
- 固定时点机器证据（不改写、不删除）：[project-review-2026-09-30](../deliverables/project-review-2026-09-30/)、
  [v2-audit-2026-09-30](../deliverables/v2-audit-2026-09-30/)，说明见 [核验产物目录](../deliverables/README.md)。
- 现行架构与发布模型：[架构](ARCHITECTURE.md)、[数据管线](DATA_PIPELINE.md)、[运维](OPERATIONS.md)。
