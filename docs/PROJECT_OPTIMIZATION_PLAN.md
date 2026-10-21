# 项目真实状态复核与可实施优化方案

**复核日期：2026-10-21（Asia/Shanghai；末次核查 09:55）**

**基线：`9db450f1ba3ad8b74d6a91c6074336c0c330a198` + 复核开始时已有的未提交工作树。**

**状态：实施提案，不代表下述修复已经落地，也不构成生产发布许可。**

> **2026-10-21 实施进度：PR-01、PR-02、PR-10 已落地；PR-05 先落了完整 handshake 键注册表、
> facts/analysis 能力位镜像与暂不消费决定，三类 JSON fixtures/运行时 schema 对拍仍未完成。
> PR-03/04 继续被 §8 的所有权决定阻塞。详见 §13。**

**真实性核查：已完成；结论与本次修订见 §2.0。**

依据：[项目审查](PROJECT_REVIEW.md)、[2026-10-20 架构审查](../deliverables/ARCHITECTURE_REVIEW_2026-10-20.md)。
约束优先级：[AGENTS](../AGENTS.md)、[长期决策](DECISIONS.md)、[API 合同](IOS_NATIVE_API_CONTRACT.md)、
[设备排期协议](IOS_NATIVE_PLAN_SCHEDULING.md)、[算法合同](ALGORITHM.md)。

本方案只优化原生 iOS、Node API、共享包、现有 Rust/Python 工具和运维门禁；不恢复 Web/macOS，
不增加独立 Watch/Android/桌面产品，不把评分核心搬到设备，不新增健康样本写入。
本轮没有修改业务代码、迁移真实健康库、登录生产、部署或操作设备排期。

## 1. 结论与实施顺序

### 1.1 真实情况

1. **不是“架构整体失效”，而是训练计划切换未闭环。** 单写者、包边界、历史迁移冻结等保护仍在；
   服务端旧接口已经 410，iOS 仍有可达消费者。不能因为全量测试绿而发布这条交互。
2. **不能直接把 iOS 的旧 URL 改成 v2 URL。** v2 命令面当前只有 `set_race_goal / clear_race_goal / pause / resume`
   四个 action（刷新是独立端点），不支持旧手动周课表、全部训练设置和原有全部教练动作。缺的是业务映射、
   状态所有权和执行授权链，不是字符串替换。
3. **“锁课只写旧状态”和“managed 数据集的 v2 读被旧门禁挡住”已用合成库复现。**
   后者是现行 `IOS_NATIVE_API_CONTRACT.md` §1 明确规定的行为，不是实现偏离合同；但它意味着 v2 可用性
   仍被旧教练生命周期耦合。若要把 unified 作为单一真相，必须先做所有权决定并同步改合同，
   不能直接把 409 当 bug 修。双状态问题不是仅供以后考虑的抽象技术债，是启用 v2 写入前的前置阻断项。
4. **上一份报告的部分问题已由现有未提交改动处理。** 顶层架构、API/CLI 导入分流、epoch 备份边界、
   控制库迁移 runbook、n100 profile 差异已有现行说明；不再重复安排一轮“重写架构文档”。
5. **质量系统有真实盲点。** 新探针发现“managed 数据集退役测试”使用了错误的 scope 拼写，
   该测试实际没有进入其声称覆盖的状态。门禁数量、验收 ID 被引用和真实行为覆盖不是一回事。
6. **可靠性改造必须修正原建议的机制错误。** 普通请求超时不能中断同线程同步 SQLite；
   `resourceLimits` 不等于进程 RSS 上限；迁移失败后不能无条件 checkout 旧代码并重启。

本轮没有发现已复现的 P0 数据丢失；这不等于完成生产安全审计或证明没有 P0。
**当前 iOS 计划交互保持发布阻断，直到首批止血与状态闭环达到下文验收标准。**

### 1.2 推荐顺序

```text
PR-01：校正测试与错误出口
   ↓
PR-02：客户端止血、能力协商与退役治理
   ↓
PR-03：计划单一所有权、managed 路由与执行拒绝闭环
   ↓
PR-04：客户端 v2 命令编排与设备前台切换
   ↓
真机 / 旧构建兼容验收 → 小范围发布

独立可靠性支线：
PR-05 契约 → PR-06 迁移/锁/恢复 → PR-07 安全部署
PR-08 读观测/有界查询 → PR-09 内存与告警
PR-10 CLI 校验；PR-11 门禁与远端执行；PR-12 iOS 行为可测面
最后才做 PR-13 模型发布治理、PR-14 模块拆分。
```

“可独立实施”指依赖关系，不要求并行改同一文件。`server.ts`、`mobile-goals.ts`、`APIClient.swift`
等热点文件按批次串行合并，避免多项大改交叉回归。

## 2. 本轮核验方法与证据

### 2.0 真实性核查结论

本次对文档中的“当前实现 / 现有测试 / 现有文档”事实断言做了回源核查。
结论：核心事实（退役 410、iOS 仍有消费者、计划双状态、探针结果、测试/文档计数）成立；
不一致集中在 managed 409 的定性、D19 迁移锁描述、untracked 文档的空白检查口径和少数计数表述，
已在本版修正。

| 类别 | 核查结论 |
|---|---|
| 基线与工作树 | `9db450f1ba3ad8b74d6a91c6074336c0c330a198` 是当前 HEAD；工作树确有未提交改动，其来源/时序未由 Git 证明。本文档本身是新增的 untracked 文件；本轮没有修改业务代码。 |
| 代码事实 | E-01…E-15 均有源码、配置、测试或日志对应；未发现凭空构造的文件、路由或能力位。 |
| 数字与结果 | §2.2 / §12 的测试计数、文档/链接/引用计数、包边界、脚本数与 `output/project-review-2026-10-21/` 日志一致；完整 Node/iOS 套件确实没有终态，未记通过。 |
| 探针 | lock 双状态、managed scope 对照、500 原样消息、单日窗口均由 `probes.mjs` / `probes.json` 复现；worker V8 堆上限 304 / 560 MiB 与 `worker-limits.json` 一致。 |
| 现行合同 | `IOS_NATIVE_API_CONTRACT.md` §1 明确 managed 数据集对 `/v1/mobile/training-plan-state` 返回 409。原文把它称为“缺陷”不准确；本版改为“现行合同行为；对 unified 单一真相提案是前置冲突”。 |
| 迁移锁 | `DECISIONS.md` D19 与 `OPERATIONS.md` 明确 `migrate-training-planner.mts` 不参与 publication lock、需停服窗口；PR-06 若加锁，必须同步更新这两处。 |
| 未验证 | 真实健康库、生产登录/部署、真机/Simulator、Windows 运行时、Rust parity、`check:doc-refs` 内容漂移均未在本轮验证，不能读成通过。 |
| 方法边界 | 只读当前工作树与既有日志；没有重跑完整 Node/iOS 套件，也没有对真实库做故障注入。 |

### 2.1 证据等级与边界

- **E1**：当前工作树源码、现有测试、脚本与配置阅读。
- **E2**：本机重新执行命令、临时合成 SQLite 和临时 API 子进程探针。
- **E3**：风险推断或建议目标，必须经后续测量/产品决定，不能当作已发生事故。
- 原报告的测试数字、生产部署记录保留其原日期，不充当本轮实跑结果。
- 本轮未打开真实健康数据库做审计或故障注入；探针创建和清理的是系统临时目录。
- `output/project-review-2026-10-21/` 是本轮本机日志目录，已被 Git 忽略；
  不包含真实 XML/GPX、健康 SQLite 或生产 Token。正式发布证据需另按发布流程归档，不能依赖忽略目录长期存在。

### 2.2 本轮重新执行的检查

环境：macOS；Node `v22.23.2`；运行时 SQLite `3.51.3`；Fastify `5.12.5`。
完整 Node 套件固定文件并发 **2**；检查结果不代表 Windows/生产/真机通过。

| 检查 | 2026-10-21 结果 | 边界 |
|---|---|---|
| `npm run typecheck` | EXIT 0 | pure + 主 TS 配置；不含全部 `.mjs` |
| `RAI_TEST_CONCURRENCY=2 npm test` | 两次尝试均未取得套件终态，**未完成，不记通过** | 首次日志执行到 1910 个用例；不能引用 2026-10-20 数字代替 |
| `npm run test:ios` | 聚合验证**未完成**；首次日志确认 98 文件类型检查通过 | 重跑未取得终态；3 个高德依赖文件未进入此类型检查 |
| `npm run check:ios-gates` | EXIT 0；10 支实际执行，2 支按设计跳过 | 后台突变、Simulator live 导出仍为手工 |
| `npm run check:package-boundaries` | EXIT 0；16 包 / 31 边 / 4 禁线 | 包级边界，不代表 API 内部已分层 |
| 包边界 `-- --self-test` | EXIT 0；8 项 | 临时夹具突变 |
| `npm run check:training-plan-single-writer` | EXIT 0；465 生产源 / 122 测试 / 0 违规 | 源码形状，不是跨进程行为证明 |
| `npm run check:acceptance-matrix` | EXIT 0；80 cited / 0 gap / 0 missing | cited 仅为标题引用 |
| `npm run check:scripts` | EXIT 0；18 package.json / 105 scripts | 跨平台语法，不替代 Windows 运行时 |
| `npm run smoke:api` | EXIT 0 | 生产启动方式的临时环境冒烟，不是线上探活 |
| `npm audit --omit=dev --json` | 4 moderate / 0 high / 0 critical | 命令按发现漏洞返回非零；不是“审计全绿” |
| 写文档前 `npm run check:docs` | EXIT 0；49 文档 / 519 本地链接 / 2 锚点 | 与 2026-10-20 架构审查收尾时 112 files / 710 links 的统计口径不同 |
| `check:doc-refs -- --problems-only` | EXIT 0；153 引用 / 0 越界 / 3 空行告警 | 11 份文档均无基线，内容漂移**未核对** |
| 文档版本定向回归 | EXIT 0；2 pass / 0 fail / 0 skip | `apps/api/test/doc-version-consistency.test.ts` |
| 训练计划定向回归（并发 1） | EXIT 0；22 pass / 0 fail / 0 skip | legacy retirement + v2 route + commands；现有夹具盲区见 §2.4 |

原始输出：`typecheck.log`、`npm-test.log`、`test-ios.log`、`gates.json`、
`smoke-api.log`、`npm-audit.json`、`probes.json`、`worker-limits.json`、`plan-targeted.log`，
均位于上述本机日志目录。
首次长套件的部分日志另存为 `npm-test-interrupted.log`、`test-ios-interrupted.log`。
没有终态和退出码的长套件，不以“已输出的用例没有报错”推定整体成功；本轮方案交付不依赖把它们跑成绿灯。
文档写入后的检查见 §12。

### 2.3 关键证据索引

| 编号 | 当前实现证据 | 核验到的事实 |
|---|---|---|
| E-01 | `apps/api/src/server.ts`：`retiredLegacyRoutes`、`retiredLegacySurface`；`legacy-surface-retirement.test.ts` | 5 路径 / 7 方法组合保留挂载并返回 410 |
| E-02 | `APIClient.swift`：`replayPlanPublication`、`previewWeeklyPlan`；`NativeAppModel.publishPlan`；`TechPlanView.manualPlanEntry` | 旧消费者仍可达，APIClient 中 v2 commands 路径引用为 0 |
| E-03 | `MobileGoalsStore.lockSession`、`commitTrainingPlanCommandState`；`buildTrainingPlanStateV2` | 合成锁课后 legacy 有锁，unified 无锁且 revision 不变；v2 `lockedToday=false`、`current=false` |
| E-04 | `server.ts`：mobile preHandler、`coachLoopManaged`；`probes.json` | 正确 object scope + active receipt 时，v2 读仍 409 `coach_loop_contract_required`；这是现行合同 §1 的 managed 行为，不是当前合同违约 |
| E-05 | `legacy-surface-retirement.test.ts` 的 managed fixture | 夹具写 array scope，但运行时查 object scope；该夹具 handshake 仍宣告 v1 snapshot |
| E-06 | `training-plan-commands.ts`：`trainingPlanCommandError` | 合成异常 message 含假私有路径/假标记，500 映射原样返回；不是已确认真实凭证泄露 |
| E-07 | `server.ts`：`withReadStore`；`ReadStoreManager.use`；`RuntimeTelemetry` | 同步读仍在主线程；已有进程级耗时、event-loop、RSS 指标，缺路由/队列预算 |
| E-08 | `import-worker.ts`、`recompute-worker.ts` 的 Worker 创建；`rai.env.example` | 当前没有显式 worker resourceLimits，云端部署模板保留全局 old-space 512（n100 是独立 profile） |
| E-09 | `deploy/upgrade.sh`；`apps/api/test/deploy-upgrade.test.ts` | 先 pull，迁移失败保持停服是现行保护；没有代码/依赖一致的自动恢复 |
| E-10 | `migrate-training-planner.mts`、`mobile-goals.ts`、`runtime-state.ts`、`dataset-epoch.ts`、`restore-journal.ts` | 主库外的版本/冻结机制不统一；训练迁移 apply 未取 API 的发布锁；D19/OPERATIONS 明确它不参与 publication lock、需停服窗口 |
| E-11 | parser `cli.ts`：`activateStagingDatabase`；storage `database-structure-probe.ts` | CLI 安装校验依赖弱结构探针，注释中的 API quick_check 兜底已失效 |
| E-12 | `typecheck-ios.sh`、`run-ios-gates.sh`、`run-model-tests.sh` | `typecheck-ios.sh` 覆盖 `apps/ios/RAI/*.swift`（排除 3 个高德文件），HealthKitSync/Export 已在总类型检查内；不足的是 SDK 副作用行为回归，不是“从未编译” |
| E-13 | TS `HandshakeResponse`（`packages/api-contracts/src/index.ts`）、Swift `RaiHandshake`（`APIModels.swift`）；`schemas.ts` 仅在 OpenAPI 表登记 `/v1/handshake` | 能力/响应多面手写；Swift 尚无 `factsAnalysisViewContractVersion` 镜像；`trainingPlanContractVersion` / `trainingPlanCommandContractVersion` 尚未在任何一端定义（§4.2 提案），不是 Swift 单侧缺镜像；iOS **生产代码**对 `currentFacts` / `publishedAnalysis` 的消费为 0（测试/门禁另有引用） |
| E-14 | `training-plan-coordinator.ts`：`refreshDecision` | 合成窗口只剩一天时仍返回 `current`；是否应滚动补齐需先明确窗口合同 |
| E-15 | `.github/workflows/ci.yml`、`.githooks/pre-commit`、Git remote | 远端 gitee；仓库自己明确 GitHub workflow 不会被该远端提交触发 |

### 2.4 两个不能忽略的探针结果

**managed 测试的对照实验（E2，均为独立临时环境）：**

| active receipt 的 scope 拼写 | handshake 的 v1 snapshot 能力 | v2 读 | 旧 goals 读 |
|---|---|---|---|
| array（现有退役测试夹具的拼写） | `1` | 200 | 410 |
| object（运行时实际查询的拼写） | 省略 | **409 `coach_loop_contract_required`** | 410 |

因此：退役 410 本身没有失效；**失效的是 managed 分支覆盖的证据**，同时暴露出 v2 读与旧教练生命周期仍被绑在同一条 preHandler 上。边界要说清楚：现行合同 §1 明确规定 managed 数据集返回 409，所以这**不是当前实现违约**；它证明的是“若采用 unified 单一真相，必须先改合同与所有权”，不能把 409 当作可单独修的 bug。只跑 `createTrainingPlanStateRoute` 的孤立单测看不到前置 preHandler 的影响，必须测试完整 router。

**worker 内存上限对照实验（E2，Node v22.23.2）：**

| 父进程设置 | worker 请求 old-generation 256 MiB | worker V8 实际 `heap_size_limit` |
|---|---|---|
| 无全局 old-space 参数 | `resourceLimits.maxOldGenerationSizeMb=256` | 304 MiB |
| `NODE_OPTIONS=--max-old-space-size=512` | 同上；resourceLimits 回显仍为 256 | **560 MiB** |
| 父进程 CLI `--max-old-space-size=512` | 同上 | **560 MiB** |

所以原报告的“加一行 resourceLimits 即完成预算”不成立。要检查**实际 V8 上限 + 进程/cgroup 峰值**，
不能只断言配置对象里的数字。此探针没有分配大堆，也没有执行 OOM。
`output/project-review-2026-10-21/` 只保存了 `worker-limits.json`，探针源码/命令未归档；
本表数值可核验，但方法细节不能独立复跑。

## 3. 对原审查逐项复核

| 原主题 | 当前判定 | 优先级与处理 |
|---|---|---|
| AR-1：旧接口消费者、无 v2 能力位 | **仍成立**；旧读取分支仅在无 `planSnapshot` 且 coachLoop 未返回 settings 时才触达 goals，当前正常 managed 路径不经过它 | P1；PR-01/02/04 |
| AR-2：计划双真相 | **仍成立且部分已复现**；锁课镜像失配、managed v2 409（现行合同行为，对 unified 单一真相是前置冲突） | 启用 v2 写前的 P1 前置项；PR-03 |
| AR-3：多库 schema/恢复边界 | 代码治理仍欠缺；**文档列出 epoch 边界已完成** | P2；PR-06 |
| AR-4：API/CLI 分叉与 CLI 校验 | 分流已正确写入现行文档；CLI 强校验缺口仍在 | P2；PR-10 |
| AR-5：契约多面手写 | **仍成立**；能力镜像确有缺项 | P2；PR-05 |
| AR-6：同步读无预算 | **仍成立**；准确边界是“缺路由/队列级指标与告警”，不是“完全没有监控”——已有进程级 RuntimeTelemetry（mean/max、event-loop、RSS） | P2；PR-08 |
| AR-7：worker 内存 | 风险成立；实际峰值与最大活跃组合未测；一行修复建议需撤回 | P2；PR-09 |
| AR-8：不可逆升级/故障静默 | 自动恢复与通知缺口成立；停服是现行保护、不是数据损坏，但 AR-8 的升级不可逆风险仍成立，不能淡化；n100 差异已文档化 | P2；PR-07/09 |
| AR-9：量具自身、远端执行 | 核心问题成立；不建议为解决孤儿报告而放松文档门禁 | P2；PR-11 |
| AR-10：iOS 状态/网络所有权 | 写侧/视图穿透成立；“同步核心不被任何脚本编译”需纠正 | P2；PR-12 |
| AR-11：预测发布与规则发布两套实现 | **仍成立**；本轮没有复现激活绕过 | P2 结构治理；PR-13 |
| AR-12：顶层架构文档落后一代 | **主要已处理**，不重复重写；残余矛盾按 §10 清理 | P3，合并到具体 PR |
| AR-13：跨库/CLI 责任边界 | detect+retry 已写入现行文档；控制库跨进程排他仍缺 | P2；PR-06 |
| C4/C5/B/C、独立政策复核 | 未落地部分仍在；属于规则/产品决定，不能擅改阈值 | 决策前保守展示；§8 |
| 真机、Windows、Rust skip | 仍不能把缺证据写成通过；本机实际存在 `var/cargo/bin/cargo`，但本轮没有执行 `rust:verify` | 按平台/能力分开验收；§9 |

**新增/强化事项：** managed 夹具假覆盖、v2 500 原样异常映射、自动刷新窗口的合同缺口。
它们不是以“再写一份报告”结案，而是明确进入 PR-01、PR-03。

## 4. 训练计划闭环：先止血，再迁移

### 4.1 PR-01：修证据与错误出口

**改动范围：** `apps/api/test/legacy-surface-retirement.test.ts`、
`training-plan-v2-route.test.ts`、`training-plan-commands.ts`、`training-plan-routes.ts`；
iOS 的 `TrainingPlanRepository.swift`、`PlanMutationDisposition.swift`、`NativeAppModel.swift` 及回归。

实施：

1. managed 夹具按运行时 object scope 写入；在发送退役请求前增加**前置断言**：
   handshake 不宣告 legacy snapshot，legacy snapshot 路由确实返回 managed 409（后者是现行合同行为；
   本断言只证明 managed 分支可达，不把 409 当缺陷）。
2. 用真实启动的 router 测 active/paused/ended/malformed receipt、未迁移/已迁移 scope、
   header absent/1/2/未知版本。测试不得只挂载独立 handler。
3. `legacy_surface_retired` 明确归入不可重试的升级/不支持状态；未知 410 同样不进入自动重试。
   不把所有 409 当升级，不把 503、网络中断、429 当终局。
4. 消除发布 410 后仍显示“结果尚未确认”的矛盾文案。确认终局后可关闭该 pending 发布，
   但不得清除系统排期 ledger、回执历史、撤回风险和 revision 水位。
5. `trainingPlanCommandError` 及 v2 读取的未知异常统一映射为固定脱敏文案；
   已知业务错误用白名单保留 code/message，内部详情仅进脱敏日志，关联 requestId。

验收：

- 正确 managed fixture 能明确进入目标分支；将 scope 错改回 array 后，**前置断言必须变红**。
- 7 个旧操作在各 dataset 状态始终 410 且无业务修订；v2 managed 的现存 409 先用**特性回归**钉住
  （证明现行合同行为），不把它叫缺陷；只有 §8 所有权决定选择 unified 单一真相后，PR-03 才同时修改
  `IOS_NATIVE_API_CONTRACT.md` §1 与 preHandler，并把回归改成新合同允许的响应。未作决定前保持 409，
  不把合同行为当 bug 修。
- 假私有路径、假 Token 标记、SQLite 内部消息不进入 5xx 响应；现有错误码不漂移。
- 终局 410 不触发重放；请求结果未知仍保留原 operationId，不能自动制造第二次业务写入。

回退：只回退错误分类/脱敏实现，不恢复旧端点，也不删除 pending 安全元数据。

### 4.2 PR-02：能力协商与客户端止血

**改动范围：** `packages/api-contracts/src/index.ts`、`apps/api/src/server.ts`/`schemas.ts`、
`APIModels.swift`、`APIClient.swift`、`TechPlanView.swift`、对应 API/Swift/结构门禁。

实施：

1. 定义可选 `trainingPlanContractVersion`（读投影）与独立的 `trainingPlanCommandContractVersion`
   （写命令）注册项；字段名为本方案提案，落地前确认后写入 API 合同。
   **读版本不等于写可用，写可用也不等于 WorkoutKit 执行获准。**
2. 仅在路由/配置真正可用时宣告相应能力。未迁移是 scope 状态，继续返回类型化 `notMigrated`，
   不把读能力存在误读为该用户已经迁移；客户端必须处理两层条件。
3. 在 PR-03/04 验收前，写能力不宣告；隐藏或禁用仍指向退役路径的操作，
   并说明“该编辑方式尚未适配当前服务”。保留训练/历史的合法只读入口，不把错误包装成休息。
4. 旧服务端缺能力位：可按明确兼容合同做只读，但不得退回已被当前服务退役的写面。
   不能用 `coachLoopContractVersion==1` 猜测统一命令可用。
5. 退役表按 **HTTP method + 规范化 pathname** 集中管理，与服务端、OpenAPI、iOS 出站清单对拍。
   不按 `/workout-plan` 前缀一刀切；GET、`/synced` 等仍有合法用途。
6. 出站门禁只检查可执行请求和路由表，允许带理由的历史诊断文字；
   检测直接字面量、发布 route 映射和可静态求值的路径拼接。
   仅靠 grep 全文既会漏动态路径，也会误伤注释。
7. 已落盘的旧 pending 操作仍可查询原 operationId；若查询 notFound 且其出站面已退役，
   记录终局并提示重新预览，**不把旧 payload 自动转换成新命令重放**。

验收：新/旧服务、缺位/已知位/未知位、未迁移、managed、410/401/429/503 全矩阵；
生产请求清单不再产生退役 method/path，未知能力 fail-closed。
本 PR 只能关闭坏入口，不能宣称已经完成 v2 编辑。

### 4.3 PR-03：计划单一所有权与服务端可用性

**推荐架构决定（需仓库所有者确认，不在本轮自动生效）：**

- `mobile_training_state` 负责配置、运行状态、计划意图与当前锁课。
- **目标状态下** `mobile_goals` 只作为兼容投影，不能独立生成与 unified 相冲突的当前计划；
  现状仍是可独立写入的第二状态，PR-03 要消除这一点。
- `easyDurationFloorFraction` / `qualitySessionCap` 等 legacy-only 偏好当前不在 `TrainingPlanState` 中；
  若继续提供，必须纳入统一状态并新增命令，否则只能明确冻结/退役，不能继续由 `mobile_goals` 独立写。
- 回执/操作结果/每日决策保留为独立追加账本；**单一真相不是把全部历史塞进一个 JSON**。
- coach-loop 可以提供决策事实，但不能作为另一套独立配置/计划写者。
- 投影与账本相关变更在同一控制库 publication transaction 内提交；跨主库事实仍用 guard/fingerprint
  检测变化并拒绝混合读，不宣称跨文件原子提交。

**改动范围：** `mobile-goals.ts`、`training-plan-store.ts`、`training-plan-commands.ts`、
`training-plan-coordinator.ts`、`coach-loop-runtime.ts`、`server.ts`、相关执行读模型/回执入口。

实施：

1. 先列举现有全部写者：统一命令、自动刷新、lock/relock、coach-loop command/决策发布、
   回执生命周期、启动迁移、运维 apply。标清每项写配置、意图、锁还是追加证据。
2. 收敛到一个应用服务入口：核验 scope/revision/事实指纹 → 推导 next state →
   unified CAS + 兼容投影 + history + operation result，同事务成功或全部回滚。
3. lock/relock 更新当前 unified 锁和相应 goals 投影；回执只更新其拥有的事实。
   若某回执需要改变当前状态，显式派生一次状态转换，不反向用历史回执覆盖当前配置。
4. v2 协商必须先于旧 managed gate 判断（**仅在 §8 所有权决定选择 unified 单一真相后实施**）。
   已迁移 v2 请求不再因旧生命周期被整体拦住；v1、未迁移和不支持版本仍各按自身合同拒绝，
   不绕过身份/鉴权/事实新鲜度。实施时必须同步修改 `IOS_NATIVE_API_CONTRACT.md` §1 的 managed 段，
   把“v2 header 请求不适用旧 gate”写成明确合同，而不是只改代码。
5. 暂停立即撤销**服务端新的执行授权**：锁课、执行快照、设备同步预检均读取同一运行状态；
   已在物理手表上的条目只能由用户前台撤回，不能声称服务端 pause 自动删除系统日程。
6. 写入成功后，旧执行读模型不得再把旧配置视为可执行。v2 投影的 `execution.permitted=false`
   保持不变；有效执行授权仍来自既有执行快照，直到另立版本合同，不在本 PR 偷换语义。
7. 确认自动刷新窗口合同：建议“七日展示逐日有明确状态，可缺失但不能把缺失当休息”。
   当前 `refreshDecision` 仅 `some` 命中一天便视为 current；增加日期覆盖、goalsRevision/
   context 变化的明确判据。若产品接受仅余一天仍 current，文案不得承诺完整未来七天。
8. 存量迁移只在停服窗口对隔离副本演练后执行；保留原行、历史摘要、审计和墓碑。
   不在 GET、启动或恢复时静默改写已有政策/历史处方。

验收（必须为运行时断言）：

- lock → v2、v1 执行快照同一锁身份；pause → 全部授权入口拒绝新增排期；
  resume 需当前事实/预览，不能复活已结束节目。
- set/clear race goal → unified、兼容投影、自动刷新同一上下文；迟到旧读不能回滚 revision。
- active/paused/ended 的正确 managed receipt 下，**在 PR-03 修订后的合同下** v2 可按合同读取，
  不出现无条件旧门禁 409；未修订合同前保持现行 409。
- 任一写点故障注入：unified/goals/history/operation 要么全变，要么全不变。
- 导入在生成与提交之间变更事实 → 拒绝提交；重复 operationId 只返回原结果；换载荷拒绝。
- 训练/比赛模式切换不改历史回执，不产生第二个自动调度者。

退出 legacy 的条件不是“表已删”，而是：所有当前写者受统一入口约束、兼容读等价且无活跃调用；
当前阶段**不删除旧表、不删除仍保留的 `/v1` 路由**。

### 4.4 PR-04：iOS v2 命令编排，不做 URL 直替换

**改动范围：** `TrainingPlanRepository.swift`、新增 `TrainingPlanPublisher.swift`、
`NativeAppModel.swift`、`APIClient.swift`、`APIModels.swift`、训练页与排期协调器。

| 用户动作 | 当前 v2 支持 | 实施处理 |
|---|---|---|
| 设置/清除比赛目标 | `set_race_goal / clear_race_goal` | 预览 → 原 payload 确认 → 幂等查询 → 完整重读 |
| 暂停/恢复 | `pause / resume` | 接 PR-03 统一运行状态；恢复不等于自动排期 |
| 刷新计划 | refresh | 保持 expectedStateRevision / operationScope |
| easy floor、quality cap 等训练偏好 | 当前命令无对应 action | 先禁用；若继续提供，单独批准 `update_preferences` 等扩展并补全服务端验证 |
| 手工逐日周课表 | 当前命令无对应 action | 先关闭编辑；保留/退役功能需产品决定，不能把 refresh 冒充手工确认 |
| 锁课、回执、反馈 | 各有既有有效协议 | 接统一状态所有权，不擅自整体退役 |

Publisher 单一流程：

```text
能力/scope/当前 revision 检查 → preview → 用户确认
 → 持久化 operationId + 原始请求字节 → submit
 → 确认服务端提交 → 持久化确认水位 → invalidate 旧读 → 完整重读
```

- 超时/断网只查询同一 operationId；只有明确 notFound 且该命令仍允许时重放原字节。
- 预览过期、scope 变更、revision 冲突：要求重新预览，不偷偷提升 expectedRevision。
- 服务端成功而本地确认落盘失败：禁止新执行、保留诊断；不重复提交业务写入。
- v2 stateRevision 与 goalsRevision 不同义，缓存水位分字段保存，不能取一个全局 max 混用。
- 模式切换仍执行“持久 intent → 撤回旧 UUID/精确时刻 → 强读回 → 登记撤回 → 新排期”。
  新命令成功不自动触发后台 WorkoutKit 副作用。

验收：URLProtocol/fake transport 的真实编码解码测试 + Publisher 行为测试；
并发点击、重启恢复、换 Token/服务器/datasetEpoch、迟到旧请求、失败本地写；
配对真机验收通过后才宣告“v2 写可用”。

## 5. 后端可靠性与数据安全

### 5.1 PR-05：契约治理，先保护三个关键边界

范围：`packages/api-contracts`、`apps/api/src/schemas.ts`、`server.ts`、Swift DTO/回归。

第一步不做全仓生成器大迁移，先建立三组**完整 JSON fixtures**：
Handshake、TrainingPlanStateResponseV2/commands、ImportJob/直连回执。

1. fixtures 覆盖必填、可选、显式 null、缺字段、空数组、字面量枚举与错误终态；
   TS 使用 `satisfies` + 运行时 schema 验证，Swift 真实 Codable 解码和必要编码对拍。
2. 对所有 handshake 键建立注册表：版本常量、语义、宣告前提、消费者、旧服务缺位行为。
   补 `factsAnalysisViewContractVersion` 的消费决定：实现并测试，或明确暂不消费；不能只加个未使用字段称完成。
3. 成功响应 schema 不再只有 required 名单。先在测试中用完整 schema 校验真实 router 响应；
   对参数协商同一路径的 v1/v2 分别验证，避免错用 schema serializer 静默裁掉字段。
4. `schema.response` 分批启用；确认 header 协商的序列化选择方式后再接 v1/v2，
   不能为“校验响应”改变旧客户端的响应字节/必需字段。
5. 后续选共享**运行时 wire schema**为形状源，生成或核对 TS/OpenAPI；
   不宣称 TS interface 本身能在运行时做校验。Swift 先保持手写安全语义，由 fixture 约束，
   不一次替换全部 Codable 类型。
6. 四类任务先规范终态、重试、业务已提交/分析未完成等语义映射，旧 HTTP 形状继续兼容；
   统一 `TaskStatus` 不能把不同持久化保证抹平。

新增提案门禁 `check:api-contract-shape` 必须与其脚本/测试一起提交，并接真实执行入口；
当前仓库尚无该 npm 命令，不能在现有验收中声称已经执行。

验收：删必填、改 nullability、添加未知枚举、交换能力位、把分析失败改成功均有负向夹具判红；
Swift 解码通过与 TS 编译通过各自不能代替运行时校验。

### 5.2 PR-06：多存储迁移、控制库锁与恢复演练

**存储边界：** 主库 + 控制库 + runtime + dataset-epoch，另有按恢复流程存在的 restore-journal；
以及上传、模型工件和相关状态。没有的可选文件记 `absent`，不能伪造空库替代。

1. 控制库新增 migration registry/checksum；对已存在 v1/v2 先识别实际 schema 再纳管，
   不补造“过去已执行某 checksum”的历史，不就地修改主库历史 migration 或冻结值。
2. runtime 优先补版本注册与 fresh/migrated 等价测试。epoch/restore-journal 小库先加严格形状、
   版本识别与恢复测试；按各自灾难恢复职责演进，不把它们并入主库或强行统一失效语义。
3. 增加**控制库跨进程排他锁**：API 在打开并自动迁移控制库前获取，所有 apply 写者参与；
   优先复用既有 publication-lock 原语。涉及两锁时固定主库锁 → 控制库锁顺序。
   PID 存活检查或“HTTP 不通”不能代替锁。
4. `migrate-training-planner.mts` dry-run 保持只读；apply 必须持控制库锁、校验 sourceDigest，
   API 存活时拒绝。过渡期旧 API 尚不持新控制库锁，因此 apply 还需取得现有主库 publication lock：
   增加只用于锁定位的显式主库路径参数，按主库锁 → 控制库锁顺序获取，**不连接主健康库**。
   不能以“新控制库锁取得成功”断言旧 API 已停机；路径别名需与 API 使用同一规范化规则。
   **现行 D19 与 OPERATIONS 明确 apply 不参与 publication lock、需停服窗口；本 PR 若加锁，必须同步更新这两处，
   不能只改脚本。**
5. 测 fresh→latest、v1→latest、v2→latest、未知未来版本、半步失败、重启重试、并发 apply，
   比较表/索引/触发器与关键数据。把相关文件加入 pre-commit 触发面。
6. 整 runtime 冷备是运维任务：现有 `backup-runtime.sh` 不改成应用自动备份服务。
   维护清单明确 runtime 外置路径是否存在；有外置库/工件必须单独纳入，不能只 tar 默认目录。
7. 先在隔离环境恢复：核验 manifest/checksum → 停所有写者 → 隔离旧 runtime →
   恢复完整集合 → 只读检查 → 显式迁移 → 启动验活 → 核对 scope/epoch/计划/操作结果/回执/工件。
   不把“恢复一份主库成功”当作整 runtime 恢复成功。
8. 恢复/替换数据集的 epoch 变化按现行合同执行；不得让备份中的旧 sync anchor/设备账目静默变成当前授权。

建议演练目标（待首测确认）：RPO ≤24h，RTO ≤30min。
这是运维验收目标，不是当前已经实现的服务承诺；维护频率、备份目的地和保留期需所有者确认。
发布脚本继续只提示外部备份责任，不暗中代做/强制验证外部备份。

验收：API 在线时 apply 被锁拒绝；锁别名/陈旧 PID 规则与已有原语一致；恢复后完整性和跨库身份正确，
未完成操作可查询，旧设备执行缓存不能绕过 epoch，生产真实副本演练另行签字。

### 5.3 PR-07：安全部署——区分代码失败与数据库已变更

**范围：** `deploy/upgrade.sh`、相关 service 安装步骤、`apps/api/test/deploy-upgrade.test.ts`、运维手册。

现行“迁移失败保持停服”的测试必须保留。单版本事务不能保证整个迁移序列回滚，
控制库还可能在启动时追加 schema，所以**不能加一个无条件 ERR trap checkout + restart**。

实施状态机：

| 失败时点 | 自动动作 | 不允许的动作 |
|---|---|---|
| fetch/目标预检失败，未改 live 工作树 | 保持 incumbent，非零退出并报告阶段 | 先 stop 再发现依赖装不上 |
| 已切代码/依赖，但所有持久化 schema 未变化 | 恢复精确 before SHA 和匹配依赖；复验认证健康与版本；仍返回发布失败 | 只 checkout 代码、不恢复依赖 |
| 已开始迁移、启动自动 DDL 或无法证明 DB 未变化 | 停服、保留现场、输出人工恢复/前向修复指引并告警 | 自动启动旧 writer、自动删表、自动覆盖库 |
| 新版 ready 后业务冒烟失败 | 仅兼容声明明确允许时回代码；否则进入维护 | 把 HTTP 200 当完整成功 |
| 自动恢复也失败 | 清楚报告双重失败、留停服状态 | 打印“完成”或无期限重试 |

其他步骤：

1. 保存完整 SHA、lockfile 标识、schema 指纹、release 阶段；不能只记录短 SHA。
2. 先 fetch 明确目标，再预检；最小改造可在停服窗口切工作树和依赖。
   不强求立即重建发布目录体系，但禁止在线 pull 后依赖半替换。
3. schema 未变化判定覆盖主/控制/runtime/sidecar；证明不足走保守分支。
4. 启动验活继续校验 `status=ok && databaseReady=true`、匿名 401，
   另核对期望版本/身份、handshake 与关键计划只读冒烟。
5. dry-run 展示预计目标 SHA 与真实阶段，不读取旧 HEAD 假装“目标 HEAD”。
6. unit/nginx 模板变更按运维 runbook 安装、校验、reload；单跑升级脚本不代表模板已部署。

验收：fake 环境覆盖依赖失败、迁移前失败、第 N 步迁移失败、自动 DDL、健康 200 维护态、
匿名错误放行、回退依赖失败、dry-run。保持“不 POST 备份”“不自动删备份”的现有合同。

### 5.4 PR-08：读路径预算——先能量到，再真正限界

**范围：** `RuntimeTelemetry`、`withReadStore`、`ReadStoreManager`、热点 read repository 与性能测试。

明确不采用的“伪修复”：

- `requestTimeout` 控制接收请求，不是数据库查询执行期限。
- `Promise.race(setTimeout, synchronousQuery)`、查询后检查耗时，均不能在同步扫描中释放事件循环。
- SQLite busy timeout 只控制锁等待，不是扫描/排序时间上限。
- 查询执行完才丢结果回 503，既没有救可用性，还可能造成用户反复请求。

实施：

1. 扩展**已有** RuntimeTelemetry：按规范化 route 模板聚合分桶延迟、错误码类、active/pending、
   read-store reopen、worker 阶段；限制标签基数与保留窗口，不记真实 URL、Token、路线、原始样本。
2. 在合成大库及经批准的生产副本测 cold/warm、导入/重算并行、恢复换库后的 p50/p95/p99、
   单次主线程阻塞、RSS。固定硬件/版本/样本数，不能用单次耗时宣称 p95。
3. 热点逐项用 EXPLAIN QUERY PLAN 核验索引；索引走追加 migration，分页/行数/时间窗有上限。
   对确需完整结果的导出/审计保留显式任务机制，不能静默截断再标“完整”。
4. 准入拥堵/恢复/读库不可用时可在执行查询**之前**返回 503 + 合理 Retry-After；
   这属于准入，不是假装已经中断执行中的 SQL。
5. 若有界 SQL 后仍不能满足阈值，再将**一两个已证实的慢只读查询**隔离到受控 read worker：
   只读连接、有限队列、绝不写表、超时终止任务并释放连接/读租约。
   read worker 不违反单写者，但必须重新核对恢复换库 gate、inode/epoch、快照稳定性，
   并纳入 PR-09 内存预算。控制库读取和跨库 fingerprint 不能被随意挪走。
6. 主线程永久 hang 仍需外部 watchdog；不为保活改大 120 s 窗口掩盖问题。

候选验收目标（不是现有实测）：健康探活 p95≤300ms、普通移动端读 p95≤1s、
计划聚合 p95≤2s、普通路径单次同步阻塞≤200ms；
在目标服务器副本、预热后至少 100 请求并记录 cold 样本，不能达到则保留测量与下一步隔离任务，不假绿。
真实隔离超时应在既定 deadline + 清理预算内返回 503，后续健康请求仍能响应。

### 5.5 PR-09：内存预算与故障可见性

**范围：** Worker 创建、`rai.env.example`、`rai-api.service`、部署测试、运维通知/检查脚本。

内存：

1. 先清点 ingest 常驻、recompute、遗留 analysis 路径、训练子进程、Rust、ONNX 的实际可同时活跃组合。
   常驻 worker 不等于实际已经占满 512 MiB；堆上限相加也不等于 RSS 测量。
2. 决定堆参数放在哪里；若使用分 worker resourceLimits，应消除全局 old-space 覆盖，
   并用实际 `v8.getHeapStatistics().heap_size_limit` 验证每个 isolate。
   不向 worker `execArgv` 塞不支持的 V8 flags。
3. 256/384 MiB 只能当候选配置，按最大合法批次、路线、重算、模型加载校准；
   记录 V8 heap、external/ArrayBuffer、整个 cgroup memory.current/peak。
4. 全服务峰值建议留 ≥20% MemoryMax 余量；若现有主机不够，先减并发/批次/模型常驻，
   不擅改 systemd 上限超出物理预算。
5. worker 崩溃/OOM：未提交事务回滚；已提交而消息丢失从持久回执恢复；
   显式结算 pending、清理租约、后续任务能创建新线程。不能收到线程 exit 就统一报业务失败。

告警：

- 新增运维侧 `OnFailure` 或独立 timer 检查 `ActiveState/Result/NRestarts` 增量、
  认证健康、磁盘余量、备份新鲜度；watchdog、OOM、启动限流、恢复失败都有事件。
- 本地记录是第一步，但必须有所有者确认的实际通知目的地；未配置时发布清单明确不达标，
  不把“日志里有一行”写成“人会收到告警”。先不引入外部健康遥测平台。
- 通知只含服务/版本/阶段/脱敏错误码，Token 不进命令日志或消息；去重、限频并发送恢复通知。
- 云端先完成；n100 继续作为明确未启用的独立 profile，不为了对称盲改其资源/FRP 拓扑。

验收：隔离 Linux/systemd 环境实际触发 watchdog、worker 内存错误、OOM/服务失败、启动限流，
记录重启/停止语义与通知收达；不能只靠 unit 文本测试宣称通过。

### 5.6 PR-10：CLI 强校验与离线边界

范围：parser `cli.ts`、storage `database-structure-probe.ts`、发布原语测试、CLI 测试。

1. 在 CLI 私有候选库发布前执行一次 `PRAGMA quick_check`，辅以必要外键/业务身份校验；
   不把全库扫描放回 API 两条直连热路径。
2. 保留安装后的轻量校验和现有失败回滚，候选预检与安装后验证职责分开。
3. 校验失败时 incumbent 内容/指针不变；新库首次安装失败不能留下半库。
4. 删除失效“API 发布后 quick_check 兜底”的注释；结构探针明确仅检文件/schema 基本可读，
   不证明所有数据页无损。
5. 钉住 CLI 发布锁、维护窗口要求；不能把 CLI 当成在线修复导入的隐式 fallback。

验收：合成完整库、截断、schema 损坏、受控页内损坏、校验中断、安装失败；
“弱探针可能通过但 quick_check 拒绝”的夹具必须真的触发该差异。
不拿真实健康库做字节翻转；测试不得要求所有任意损坏都由 quick_check 检出。

## 6. 质量系统与 iOS 可维护性

### 6.1 PR-11：量具也要被验证，执行也要有证据

1. 优先对文档链接、npm script 检查、测试发现、iOS runner、single-writer 等关键 `.mjs`
   增加临时夹具行为/突变测试。`node --check` 只查语法，不能替代行为。
2. 新建 `tsconfig.scripts.json`（`allowJs/checkJs` + JSDoc）并接入 `typecheck`；先覆盖关键脚本再扩范围，
   不一次打开后加满 `any` 消除报错，不修改产品 TS 严格级别。
3. 建一份验证清单：命令、触发条件、执行者、平台、外部前置、允许 skip 原因、失败/跳过语义。
   `test:ios:live`、mutation、coach release、Rust verify 等可作为显式人工/发布档，
   不要求每次 commit 都跑，但必须有实际执行者与结果记录。
4. 新增门禁要做“健康夹具绿 → 改坏红 → 还原绿”；要求接入 hook/远端/发布入口中的明确一处，
   并证明该入口实际执行。不接受“脚本中出现了另一个脚本名”作为唯一接线证据。
5. **保留** `check:docs` 的孤儿/坏链接硬门禁；新增本方案只需补现行入口。
   不为审查报告方便而全局降级 warning；索引摩擦可通过确定性生成索引或专门临时目录解决。
6. 新增一项检查：当前文档的命令/路径按结构化清单或指定段落校验，历史/代码示例显式豁免；
   不 grep 所有反引号，否则必然误伤退役说明与占位符。
7. 行号基线必须在一个已审过的基准修订生成，之后比候选修订。
   在发布候选上同时 `--write-baseline` 再 `--require-baseline` 只证明自相等，
   **不能证明相对上次评审没有漂移**；长期优先用函数/符号和章节链接。
8. 从现有 Gitee Go 草案或受控 runner 选择一个所有者批准的远端执行渠道；
   先启用 Linux，再 Windows 和 macOS。本文不虚构平台已启用，也不改写远端配置。
   发布清单可作为启用前的人工约束，但不等价于服务端强制保护。
9. Linux/Windows 使用合成数据，macOS 正式构建不上传个人健康库；平台跳过记录为 skip，
   发布需要的平台缺失时阻断对应发布，而不是改用 `--no-verify`。

验收：真实远端提交/人工 dispatch 产生带准确 SHA 的结果，故意坏一次能阻断约定发布流程；
Windows 对应三条 runtime 用例不再 skip；原健康数据和 Token 不进入 CI 产物。

### 6.2 PR-12：收口 iOS IO 与同步行为测试

1. PR-04 的 Publisher 统一写侧流程后，`NativeAppModel` 保留 UI 状态转发，不重复复制发布/确认水位逻辑。
2. 把今日详情、日训练列表、睡眠历史、分享卡、训练导出的直接 `RaiAPIClient()` 调用迁到 repository，
   用请求代次/credential generation 作为身份，不把原始 Token 拼进 `.task(id:)`。
3. 门禁限制 **Skins 中构造网络客户端/Token 进入请求身份**，不禁止设置页合法编辑凭证；
   HealthKit 手动同步按钮通过应用服务转发。不能用“全目录禁止 session.apiToken”粗暴破坏设置。
4. 同步重构只抽取一个已识别的决策边界：分页/EOF、删除-only、待办合并、取消、锚点提交等。
   定义 HealthKit 查询、上传 transport、本地 journal、clock 适配协议；保留现有纯策略单源，
   不为测试另写一份同步算法。
5. 单次测试运行真实编排逻辑 + fake SDK/transport，断言副作用顺序与失败落盘；
   `AppDelegate` 与前台调用共享同一编排入口，而不是第二套同步执行器。
6. 保留 98 文件总类型检查；补完整 Pods/Xcode build 覆盖三个高德依赖文件。
   “有类型检查”“有 fake 行为回归”“有真机健康权限/后台验证”分开记录。

验收：每个锚点推进必须晚于事实持久确认；分页开关关闭、删除-only、权限变化、取消、
worker 已提交但响应丢失、锁屏/重启恢复有行为断言。fake 测试通过不能替代真机节。

## 7. 后置结构治理，不抢占发布修复

### 7.1 PR-13：预测模型发布治理

- 把预测模型激活的 allow/reject/not_evaluable 判据下沉到 storage 层独立 gate，
  DML 收入 repository；规则模型和预测模型不强行合并成一个状态机。
- 覆盖 scope、训练标签可得时间、override/label 修订、工件 hash、基线门槛与指针更新；
  拒绝/不可评估时当前指针不变。
- 先固定当前输出/事件语义，再迁移调用，继续使用既有单写者协调和事务。
- 验收是相同输入相同决策、失败不换指针，不是模型准确率提高；
  不降低证据门槛，不开放缺校准的 P80/P90。

### 7.2 PR-14：按职责切分大文件

按风险从低到高：

1. `server.ts` 提取路由注册/装配/后台任务；全 router dump、鉴权、路由分类、OpenAPI 集合保持一致。
2. `mobile-goals.ts` 提取 schema/operation repository，保留既有同步事务边界。
3. `data.ts` 按查询主题迁到 read repository，保持同一快照与缓存失效。
4. `recompute-pipeline.ts` 分“读事实 / 纯计算 / 写发布”；冻结事实与发布 gate 不改变。
5. 纯层默认时钟显式注入，新增纯包必须进入 pure 检查；不合并现有 12 个 pure 配置包（10 个领域包 + 2 个契约包）。
6. `database.ts` 的历史迁移正文及冻结值不动；需要搬注册/常量时重跑冻结门禁，
   不用“重新算 checksum”掩盖迁移语义变化。

每个 PR 只做一种结构变化，不混入数值/算法政策更新。
验收用行为等价与不变量，不以文件行数减少作为成功标准。

### 7.3 供应链与剩余 P3 的归属

这些事项不升级成“必须先大重构”，但也不因优先级低而无主：

| 项目 | 实施归属 | 可执行动作与验收 |
|---|---|---|
| onnxruntime 链 4 moderate | PR-13 的独立依赖子批次 | 记录锁定版本与 advisory、确认格式串输入可达性；在副本分支试叶子依赖 override 或受支持的 ONNX 升级，跑推理/manifest/模型加载与启动测试，比较产物尺寸/峰值内存。无可用修复则记录责任人、复查条件和剩余风险；不 `audit fix --force` |
| 训练子进程/OOM 交互 | PR-09/13 | 合成训练任务测试取消、父进程退出、子进程遗留、产物半写；确认父进程只在完整工件校验后记录/激活，错误不换指针 |
| nginx HSTS/default server | PR-07 的独立模板子批次 | 先核对真实域名/证书、IP 访问和未知 Host 行为，再决定 HSTS 范围；先不加 preload/includeSubDomains。未匹配 Host 不误转到业务站点，`nginx -t` 与现场 HTTPS/旧客户端探针一起验收 |
| 重复鉴权与 API 内部 SQL | PR-01/14 | 将敏感路由的额外 Token 验证收口到共享 helper，但保留现有纵深防御；SQL 按 repository 小步迁移，不把鉴权删除当“去重” |
| env 与 pre* 脚本维护 | PR-11 | 建安全相关 env 注册表、默认值/消费处/文档映射；Node 版本 pre-hook 先测耗时，不为减少脚本数量拆掉版本守卫 |
| 健康 ZIP 短期落盘 | PR-12 | 核对文件保护等级、后台上传/锁屏需求、失败包恢复与保留 TTL；只在成功确认或显式放弃后清理，避免一律改成锁屏不可读导致后台同步失效；不把原包送入诊断产物 |
| 手写 Swift 编译清单、DTO 大文件 | PR-11/12 | 编译集合与生产源清单双向对拍，排除项显式有理由；按合同拆 DTO 时用真实 Codable fixtures 保证缺省/null 语义不变 |

以上依赖升级和模板硬化各自独立提交、独立回归，不夹带在纯文档或纯职责拆分 PR 中。

## 8. 需要确认的产品/规则决定

| 决定 | 推荐方向 | 决定前的安全默认 | 影响 |
|---|---|---|---|
| 计划真相所有权 | unified 管配置/意图/锁；legacy 为投影；证据账本独立；若选 unified，同步修改 API 合同 §1 的 managed 段 | 不宣告 v2 写能力，关闭坏入口 | PR-03/04 前置 |
| 手动周课表/训练偏好是否继续提供 | 如保留，新增明确命令合同；如退役，正式更新决定与 UI | 只读/禁用，不复用旧 410 路由 | PR-04 功能范围 |
| 七日窗口是否必须逐日完整 | 缺失有明确原因，不能显示“完整七日 current” | 显示部分/待刷新，不填休息 | coordinator 与文案 |
| C4：负荷与里程两套指标 | 分开展示含义/来源，不把一个百分比解释为另一个 | 加说明，不混算 | 今日卡语义 |
| C5：教练每日调整后依从性 | 保留原冻结义务，另列有效决策和原因；新规则独立版本 | unknown 不视为漏课，不用后来的减量改写历史 | 算法/历史口径 |
| `plan_below_phase_band` / 阶段卡降级 | 核验预算、剂量不可行、恢复/赛前保护，再提示可行性；不为凑量加课 | 描述证据，不自动抬量 | 规则与产品签字 |
| G01–G03 独立复核 | 按既有冻结案例交独立教练/领域人员评审 | 保持已批准常量与 fail-closed，不宣称临床收益 | 非工程单测能结案 |
| 通知渠道、RPO/RTO、备份频率 | 明确所有者与收达验证 | 未验收就写未验收，不默认“有告警” | 可靠性完成标准 |

本轮不自行批准任何训练阈值变更。若采用 B/C/C5 新语义，必须 bump policy version、
补反例和 ALGORITHM 验收项、标记既有计划待刷新；不得改写历史处方/回执。
新 ADR/决定编号以 `DECISIONS.md` 的下一个可用编号为准；
原架构报告提议的 D18/D19 已被现行备份/退役决定占用，不能照抄覆盖。

## 9. 发布验证矩阵

### 9.1 自动检查分层

| 改动类型 | 必跑现有入口 |
|---|---|
| API/共享包 | `npm run typecheck`；并发 2 的 `npm test` |
| 计划状态/写路径 | 相关 training-plan、plan-publication、receipt、coach-loop 回归；single-writer；完整 router 集成 |
| iOS/契约 | `npm run test:ios`；`npm run check:ios-gates`；涉及 SDK 文件加正式 Xcode build |
| storage/schema | 历史 migration policy；表分类；fresh/migrated；锁/恢复故障注入 |
| server/deploy | `npm run smoke:api`；deploy-cloud/n100/upgrade 合同测试；现场 nginx/systemd 检查 |
| 文档/规则/测试 | docs、doc-refs、acceptance-matrix、scripts；新增 gate 的突变测试 |
| Rust 能力发布 | `npm run rust:verify`；`RAI_REQUIRE_RUST_TESTS=1` 的真实 parity，不允许 skip 冒充通过 |
| 预测/训练改动 | 相应 TS/ONNX/manifest 回归；`npm run ml:test`；不代表真实准确率 |

本方案提出的新 npm script 必须由对应 PR 新增后才能调用。
跨平台 npm script 正文仅用普通命令/`&&`/Node runner；环境设置放 shell 示例或 runner 里，不写 POSIX 专用赋值进 package.json。

本机/CI 如需同一写法控制测试并发，可用现有脚本支持的环境变量，例如：

```bash
# bash / zsh；不是 package.json script 正文
RAI_TEST_CONCURRENCY=2 npm test
```

```powershell
# PowerShell
$env:RAI_TEST_CONCURRENCY="2"
npm test
```

```bat
rem cmd
set RAI_TEST_CONCURRENCY=2
npm test
```

### 9.2 必须补的真机/现场证据

| 场景 | 必须观察的结果 | 不能替代它的东西 |
|---|---|---|
| v2 编辑、VoiceOver、动态字体 | 无退役入口；目标/暂停/失败原因可理解，布局可操作 | Swift 编译、源码 grep |
| iPhone + 配对 Watch 模式切换 | 旧 UUID/精确时刻撤回并强读回后才下发；真实表端可见独立记录 | fake scheduler 的 schedule 返回 |
| 每个 SDK 副作用后强杀重启 | 日志保留风险；只能前台核验/撤回，不自动恢复成功 | 只测正常重启 |
| 权限拒绝/撤回、部分成功、回执断网 | 无假成功；不重复业务写；可解释恢复出口 | UI 按钮禁用 |
| HealthKit 后台、锁屏、跨午夜、分页开关 | 事实/锚点/上传回执顺序与恢复均正确 | Simulator mock 数据 |
| 旧构建 + 新服务 410 | 不无限重试/不假成功；升级提示与 pending 处理可达 | 服务端 curl 410 |
| 真实健康副本多库迁移/恢复 | scope/epoch/计划/回执/工件一致，可按演练恢复 | 临时空库迁移成功 |
| Linux watchdog/OOM/限流失败 | 真实服务状态、重启策略、告警和恢复通知收达 | unit 文本断言 |
| Windows 三条 runtime skip | 在真实 Windows 成为执行并通过 | macOS/WSL 模拟 |

### 9.3 分阶段发布与回退

1. **服务端兼容增量**：先加错误分类所需稳定码/能力与门禁；仍保持退役 410。
2. **服务端状态闭环**：PR-03 与锁/迁移在副本演练后上线；写能力按完整验收结果宣告。
3. **客户端关闭坏入口版**：可先发布止血版，说明编辑暂不可用；不称“训练计划完整可用”。
4. **客户端 v2 版**：本机自动 + 签名构建 + 配对真机验收完成，先内部/小范围安装；
   观察至少一个跨午夜和完整同步/编辑/排期周期，再扩大。
5. 任何正确性失败关闭对应新写入口，保留事实/日志/回执；不恢复旧端点、不清数据绕过。
   代码回退是否允许由 schema/依赖兼容声明决定；不能用“回退版本号”代替恢复方案。
6. 发布记录固定：精确 SHA 与工作树状态、policy/contract/schema、设备/OS/build、
   测试并发/通过/失败/skip、部署后认证健康、真实通知/恢复证据、未验证项目及所有者。

## 10. 文档治理与残余修正

不新增另一套 API 或设备规范。实施后只把**已生效**结论更新到现行合同：

| 内容 | 更新位置 |
|---|---|
| 能力位、命令映射、410、错误与响应 schema | `IOS_NATIVE_API_CONTRACT.md` |
| Publisher 水位、前台排期、撤回、重启账目 | `IOS_NATIVE_PLAN_SCHEDULING.md` |
| 状态所有权、读隔离、多库边界 | `ARCHITECTURE.md` |
| API/CLI、事实/分析回执、恢复边界 | `DATA_PIPELINE.md` |
| 发布状态机、备份/迁移/告警 runbook | `OPERATIONS.md`、部署 README |
| D19 迁移锁描述、所有权与写入口变更 | `DECISIONS.md` |
| C4/C5、窗口/剂量/政策版本 | `ALGORITHM.md`、`RUN_COACH.md`、政策签字记录 |
| 当前未决项/关闭证据 | `PROJECT_REVIEW.md` |

已发现的残余表述，随相应 PR 修正：

- `DATA_PIPELINE.md` §9 把“恢复”和 CLI 并列后写“两条路径都不在 API 请求路径”，
  容易误解：应区分“API 导入不换库”与“API 的显式备份恢复可换库”，不是说恢复端点不存在。
- `ARCHITECTURE.md` 的写 commands 描述是服务端能力，必须继续保留 iOS 未完整接入的限定
  （现行文中的 AR-1 缺口段已给出该限定）。
- 原报告关于 6.9k 同步核心“从未被回归脚本编译”应在现行状态纠正为“已由 `typecheck-ios.sh`
  类型检查，缺的是 SDK 副作用行为回归”，不回写历史时点报告。
- 不把本轮**写前 49 / 写后 50 文档、153 引用**的数字回填为上轮 **112 files / 141 refs** 的“修正版”；
  只注明时点与口径。

本方案是未完成实施任务的唯一清单。收尾后把生效合同归位，在项目审查保留关闭指针，
不继续派生“再复查/再优化”多份现行方案。

## 11. 排期、交付单与停止条件

以下为**净工程人日估算**，不含设备等待、外部规则复核、生产维护窗口；
不是交付日期承诺，先做 PR-01/02/03 后再按实测校准。

| PR | 主责 | 估算 | 前置 | 完成产物 |
|---|---|---:|---|---|
| 01 测试与错误出口 | API + iOS | 1–2 | 无 | 正确 managed 夹具、错误矩阵、脱敏回归 |
| 02 能力/止血 | 契约 + iOS | 1–2 | 01 | 无坏入口、读写能力分离、退役出站 gate |
| 03 状态所有权 | API/storage | 4–7 | 所有权决定；01 | 单写状态服务、lock/managed/pause/刷新运行时证据 |
| 04 iOS v2 Publisher | iOS | 3–5 | 02/03；功能映射决定 | 命令编排、落盘/重试/真机可测构建 |
| 05 契约形状 | 契约/API/iOS | 2–4 | 与 02 字段协调 | 三类 fixtures、schema/Swift 对拍、接线 |
| 06 多库/锁/恢复 | storage/运维 | 3–5 | 与 03 schema 协调 | 迁移等价、排他锁、隔离恢复报告 |
| 07 安全部署 | 运维/API | 2–3 | 06 兼容边界 | 阶段化回退、失败保持停服、部署故障测试 |
| 08 读观测/限界 | API | 3–5 | 基准环境 | 路由分布、查询界限、必要时小范围隔离 |
| 09 内存/告警 | API/运维 | 2–4 | 峰值环境与通知决定 | 实际 heap/RSS 预算、通知收达、OOM 演练 |
| 10 CLI 校验 | parser/storage | 1–2 | 无 | 候选强校验、失败不发布、损坏夹具 |
| 11 门禁/远端执行 | 工程效能/所有者 | 2–4 | runner/权限决定 | 量具自测、入口清单、真实远端结果 |
| 12 iOS 行为可测 | iOS | 3–5 | 04 主干稳定 | repository 收口、一条真实同步编排行为链 |
| 13 模型发布 | application/storage | 2–4 | 首轮可靠性稳定 | 独立三态 gate/repository 与等价测试 |
| 14 模块职责 | API/共享包 | 4–7 | 上述主干稳定 | 小步拆分、冻结迁移不动、行为等价 |

单人顺序实施全部约 **33–59 人日**，真机/外部依赖另计；
优先 01–04 约 **9–16 人日**，不得承诺“一两天彻底修复”。
可靠性支线可在明确文件所有权后交错推进，不以总任务量相加冒充日历时间。

**阶段完成标准：**

- **G0 止血**：正确测试能命中 managed；5xx 不原样泄露；生产 UI 不产生退役出站请求。
- **G1 功能闭环**：所有权决定已签；lock/pause/managed/刷新/幂等一致；有效命令映射完整；
  设备未验收则不发布排期成功承诺。
- **G2 可运维**：隔离多库恢复、分阶段部署、读/内存指标和真实通知均有证据。
- **G3 可持续**：关键契约/量具/远端与 Windows/Rust 各有实际结果；后置拆分不改变行为。

**必须停止上线的条件：** 读写身份不一致、pause 后仍可获新执行授权、未知操作被换键重提、
旧 UUID 未撤回即下发、迁移兼容性不明、关键平台只有 skip、告警无接收人。
停止上线不等于删库或放开已退役接口；进入维护/只读/功能关闭状态并保留现场。

## 12. 本轮交付检查与后续动作

> 本节保留方案交付时点（2026-10-21 09:55）的记录；后续代码实施见 §13。

本轮仅交付该方案与项目审查入口，不实施上述业务/运维修改。
现有未提交代码、文档合并和删除保持原样，不擅自暂存、提交或恢复。

- [x] 读取原审查并回到当前源码核对全部 AR 主题。
- [x] 合成探针复现 lock 双状态、真实 managed v2 409、错误夹具假覆盖、500 原样映射。
- [x] 实测 worker 全局堆参数覆盖，纠正“一行内存限制”建议。
- [x] 区分已文档修正、未实施代码、待产品决定和待现场验收。
- [x] 记录完整 Node/iOS 套件未取得终态；保留部分日志，不冒充通过。
- [x] 文档落盘后复跑 docs/doc-refs/scripts/acceptance-matrix，均 EXIT 0；保存日志为 09:14，2026-10-21 09:55 手工复跑计数一致（未另存日志）。
- [ ] 后续实施从 PR-01 开始；产品/设备/生产授权不因本方案存在而自动取得。

| 交付检查 | 结果 |
|---|---|
| `npm run check:docs` | EXIT 0；50 文档 / 527 本地链接 / 2 锚点 / 0 problems |
| `npm run check:doc-refs -- --problems-only` | EXIT 0；153 引用 / 0 越界 / 3 空行告警；内容漂移仍未核对 |
| `npm run check:scripts` | EXIT 0；18 package.json / 105 scripts |
| `npm run check:acceptance-matrix` | EXIT 0；80 cited / 0 gap / 0 missing |
| 计划定向回归 | EXIT 0；22 pass / 0 fail / 0 skip；文件并发 1 |
| `git diff --no-index --check /dev/null docs/PROJECT_OPTIMIZATION_PLAN.md` | 无空白错误（`--check` 无输出；no-index 返回 1 仅表示文件与 `/dev/null` 不同，返回 3 才表示空白错误） |

> 口径：`check:docs` 会扫描 untracked 的本文档；`git diff --check` 只检查已跟踪改动。
> 两者不能互相替代。09:14 的 final 日志见 `output/project-review-2026-10-21/`；09:55 为本次修订后的手工复跑，未另存日志，计数与 09:14 一致。

### 12.1 外部机制核对

本轮通过公开官方文档核对机制（2026-10-21 抓取），不传仓库私有数据：

- Node v22 Worker 文档：`https://nodejs.org/docs/latest-v22.x/api/worker_threads.html`
  的 resourceLimits、old-space 覆盖及外部内存边界；本机实验结果以 §2.4 为准。
- Fastify v5 Server 文档：`https://fastify.dev/docs/v5.6.x/Reference/Server/`
  的 requestTimeout 定义（接收完整请求，不是 handler 执行期限）；
  当前安装版本为 5.12.5，还需以实现/运行时测试核对具体选项行为。

其余项目事实来自本地源码和本轮实跑，不以网络资料代替项目证据。

### 12.2 本次修订记录

- 2026-10-21 09:55：完成真实性回源核查；修正 managed v2 409 的定性（现行合同行为，不是缺陷）、AR-6 的“没有监控”表述、
  D19/OPERATIONS 迁移锁描述、untracked 文档的空白检查口径、文档计数表述；
  修正 `deploy-upgrade.test.ts` 路径与 `tsconfig.scripts.json` 的新建表述；补充
  `easyDurationFloorFraction` / `qualitySessionCap` 与统一状态字段缺口；
  并为 AR-1 旧读取 fallback、AR-8 停服保护、PR-11 现有/新增检查、PR-14 pure 包分类加上限定语。
  未修改任何业务代码。

## 13. 实施进度（2026-10-21 起）

本节只记录**已落地**的代码、测试与边界；未完成项仍是任务，不因本节存在而视为验收通过。
产品/所有权决定、真机、生产部署与真实健康库演练均未因本轮实施而取得授权。

### 13.1 PR-01（已落地）

| 计划项 | 落地证据 |
|---|---|
| managed 夹具改用运行时 object scope；退役请求前增加前置断言 | `apps/api/test/legacy-surface-retirement.test.ts`：`setCoachLoopReceipt()` 写 `{serverId, athleteId, datasetEpoch}`；先断言握手省略 `planSnapshotContractVersion` 且 legacy 快照路由 409 `coach_loop_contract_required`，再断言 7 个旧操作为 410。把 scope 改回 array 的变异运行在该前置断言处变红。 |
| 真实 router 覆盖 receipt 生命周期、未迁移/已迁移 scope、header absent/1/2/未知 | 同文件 `real router matrix`：active / paused / malformed → managed 409（含 v2 读，特征回归钉住现行合同）；ended / 无 receipt → 释放；未迁移 v2 → 409 `training_plan_not_migrated`；已迁移 v2 → 200；未知 header → 409 `training_contract_unsupported`（unmanaged）。 |
| `legacy_surface_retired` 与未知 410 终局、不自动重试 | `PlanMutationDisposition.terminalPlanPublicationErrorCodes` 收录 `legacy_surface_retired`；新增 `isTerminalPlanPublicationStatus(410)`。`NativeAppModel.publishPlan` / `resolvePendingPublication` / `resolvePlanPublication` 均按 410 清 pending 并给终局文案；`PlanReadIssue.network` 把 410 归为不可重试升级状态。 |
| 410 后不再显示「结果尚未确认」 | `publishPlan` 的 410 分支改为「该旧接口已退役，本次操作未执行…」；仅 `cache.savePublication(nil)`，不清排期 ledger / 回执 / 撤回风险 / revision 水位。`ModelRegression` 覆盖 `legacy_surface_retired` 与未知 410 两个码。 |
| 命令/读取未知异常脱敏，已知业务错误保码 | `trainingPlanCommandError(error, context)` 采用白名单：`PlanOperationError` 保码保文案；CAS 冲突固定中文文案；`TrainingPlanStateError` 与未知异常固定 5xx 文案，原始错误经 `internalErrorLogDetail` 脱敏后只进 requestId 关联日志。v2 读的 `TrainingPlanReadError` 保留业务文案，其余 503 固定文案并记录 `request.error`。 |

新增回归：`apps/api/test/training-plan-error-sanitization.test.ts`（3 项）。

### 13.2 PR-02（已落地）

| 计划项 | 状态与证据 |
|---|---|
| `trainingPlanContractVersion`（读）与 `trainingPlanCommandContractVersion`（写）注册项 | 已落地：`packages/api-contracts/src/index.ts`、`apps/ios/RAI/APIModels.swift`；服务端只在非 managed 数据域宣告读能力 `2`，**故意不宣告写能力**。 |
| 读能力 ≠ 已迁移；客户端处理两层条件 | 合同 §2/§3.1 已更新；服务端未迁移仍返回 `training_plan_not_migrated`；iOS 仍按 `RaiTrainingPlanContractError` 分类。 |
| 隐藏/禁用仍指向退役路径的操作 | `TechUnifiedTrainingView.manualPlanEntry` 改为只读说明（无 NavigationLink）；`NativeAppModel.planWritesAvailable` 在新服务缺写能力时拒绝 `persistGoals` / `createWeeklyPlanPreview` / `publishPlan` 的 `coach|confirm|goals` route，且不产生 pending 账目。 |
| 老服务端只读兼容，不退回退役写面 | 老服务两个新键都缺 ⇒ 保留其既有协议（旧页面）；新服务读能力存在而写能力缺位 ⇒ 只读。 |
| 退役表按 method + pathname 集中、出站门禁 | **已落地**：新增 `packages/api-contracts/src/retired-surfaces.ts`（7 个 method+path 行）作为唯一来源；`server.ts` 的 preHandler、410 handler 与 `schemas.ts` 的 OpenAPI 条目均从该表派生。`apps/ios/tests/check-retired-plan-outbound.py` 增补为比较共享表、服务端派生形状、OpenAPI 生成入口与 Swift 出站字面量（含 `"a" + "b"` 拼接和 `/v1/mobile/` 片段检测）；已挂进 `run-model-tests.sh` 与 `check:ios-gates`。变异（改 scope/加回 `NavigationLink`/新增拼接路径）均按预期变红。 |
| 旧 pending 查询 notFound 后终局、不转换重放 | 已按 410 终局清理；未做「outbound 面已退役」的独立静态判定。 |

### 13.3 PR-10（已落地）

| 计划项 | 落地证据 |
|---|---|
| CLI 私有候选发布前执行 `quick_check` + 外键检查 | `packages/storage-sqlite/src/database-structure-probe.ts` 新增 `quickCheckDatabase()`；`packages/health-export-parser/src/cli.ts` 的 `activateStagingDatabase` 在 `publishDatabaseFile` **之前**调用并拒绝失败候选，安装后仍保留轻量结构探针。 |
| 结构探针边界说明与失效注释清理 | 删除“API 发布后仍有 quick_check 兜底”的旧注释；`probeDatabaseStructure` 文档明确只检文件/header/schema 基本可读，不证明数据页无损；`docs/DATA_PIPELINE.md` §3/§5 同步。 |
| 失败不发布、incumbent 不变 | `activateStagingDatabase` 在换库前抛错；既有 rollback 路径保持不变；CLI 原子测试新增“强校验必须早于 `publishDatabaseFile`”的顺序断言。 |

新增/修改回归：`packages/storage-sqlite/test/database-structure-probe.test.ts`（8 项，含“弱探针通过、`quick_check` 拒绝”的页内损坏夹具）；`packages/health-export-parser/test/cli-atomic.test.ts`（8 项）。

### 13.4 PR-05（部分落地）

| 计划项 | 落地证据 |
|---|---|
| 所有 handshake 键建立注册表 | 新增 `packages/api-contracts/src/handshake-registry.ts`：17 个键逐项登记 kind/version（适用时）/语义/宣告前提/消费者/旧服务缺位行为；`apps/api/test/handshake-registry.test.ts` 从 `HandshakeResponse` 源码解析顶层键并断言与注册表完全一致，重复/漏项直接变红。 |
| `factsAnalysisViewContractVersion` 消费决定 | 明确“暂不消费”：Swift `RaiHandshake` 增加镜像字段并注明只镜像；`TrainingPlanV2Regression` 用真实 JSON decode 断言两个 facts/analysis 键分别解码、老服务端缺位为 nil；注册表 consumer 写为 deferred。 |
| 三类完整 JSON fixtures / 运行时 schema 对拍 / `check:api-contract-shape` | **未完成**：Handshake、TrainingPlanStateResponseV2/commands、ImportJob/直连回执的完整 fixtures 与运行时 schema 校验尚未新增；本 PR 只建立了可执行的键覆盖与能力位镜像。 |

### 13.5 未启动或阻塞

- **PR-05 其余**：fixtures、响应 schema、`check:api-contract-shape`。
- **PR-03**：计划单一所有权、managed preHandler 与合同 §1 的修订——等待 §8 的仓库所有者决定；
  本轮**没有**把 managed 的 v2 409 当 bug 修改。
- **PR-04**：iOS v2 命令编排 / Publisher——依赖 PR-03 与功能映射决定；因此当前构建仍不宣告写可用，
  也不把「只读」包装成完整训练编辑。
- **PR-06 至 PR-14**：未启动；其中 PR-06/07/09 涉及停服、锁与通知目的地，需所有者确认。

### 13.6 本轮验证记录

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | EXIT 0 |
| 计划/契约/CLI 定向回归（并发 1） | `legacy-surface-retirement` 3/3、`training-plan-error-sanitization` 3/3、`schemas` + `direct-sync-handshake-capability` + `database-structure-probe` + `cli-atomic` 合计 40/40 pass；`handshake-registry` 3/3 pass |
| Swift v2 合同回归 | `TrainingPlanV2Regression` 59/59 pass（含 `factsAnalysisViewContractVersion` 双能力位解码） |
| managed 夹具变异 | 将 scope 改回 array 后，前置断言按预期失败；恢复后 3/3 通过 |
| `npm run test:ios` | EXIT 0（PR-01 阶段运行；后续 APIModels 变更由 `typecheck-ios.sh` + `TrainingPlanV2Regression` 单独复跑覆盖） |
| `bash apps/ios/tests/run-model-tests.sh` | EXIT 0（含新增 410 终局与只读守卫断言） |
| `bash apps/ios/tests/typecheck-ios.sh` | EXIT 0（98 文件，跳过 3 个高德依赖文件） |
| `npm run check:ios-gates` | EXIT 0（11 支实际执行，2 支按设计跳过；含新增 `check-retired-plan-outbound.py`，623 项） |
| `npm run smoke:api` | EXIT 0（生产启动方式的临时环境冒烟） |
| `npm run check:docs` | EXIT 0；50 文档 / 528 本地链接 / 2 锚点 / 0 problems |
| `RAI_TEST_CONCURRENCY=2 npm test` | 2233 用例：2219 pass / 13 skip / 1 fail。唯一失败仍是 `packages/storage-sqlite/test/connection-contention.test.ts` 的墙钟等待用例（期望跨过持锁窗口）；单文件并发 1 重跑 2/2 pass，按既有说明属负载下时序抖动，不记为本次改动回归。 |

未验证：真机、Simulator 视觉验收、Windows 运行时、Rust parity、真实健康库/生产部署。
