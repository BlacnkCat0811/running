# 核验产物

现行说明统一从 [项目README](../README.md) 进入；审查结论只维护 [PROJECT_REVIEW](../docs/PROJECT_REVIEW.md)。
本目录不是第二套产品规范/实施计划，不保存**重复批次** Markdown 或 archive 副本。当轮尚未收尾的审查
报告可以临时列在下方「当轮审查」一节，并在下一轮并入 `PROJECT_REVIEW` 或删除。

## 当轮审查（未提交改动）

已收尾批次（2026-10-09 ~ 10-11）的原文档已删除，指针见 [项目审查 §8](../docs/PROJECT_REVIEW.md)。

- [../docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md](../docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md)：**PR5 落地设计**（读侧一致性）——
  7 条决策（`currentFacts`/`publishedAnalysis` 形状、新鲜度合同、缓存五元组、删除可见性、读侧边界、
  与 PR4 的顺序、`route_points` 退役）、11 步实施顺序、每步判据与突变靶子。
  🔴 其头号发现（删除级联销毁路线版本）已由主智能体**独立实测复现**。

- [ACCEPTANCE_INVENTORY_DIRECT_SYNC_2026-10-13.md](ACCEPTANCE_INVENTORY_DIRECT_SYNC_2026-10-13.md)：**§14.1/§14.2 证据盘点（时点快照）** ——
  逐条给出 A01–A18 与十条禁止操作的「现状判定 / 证据（测试标题原文 + `文件:行号`） / 缺口 / 阻塞于」。
  基线 `d2069a4`，**只读侦察、未运行测试**。汇总：`已有行为级证据` **1** 项（A05）、
  `部分行为级` **9** 项、`只有结构/源码级证据` **6** 项、`未覆盖` **2** 项（A10 分析失败隔离、A11 短写调度）。
  另记两条**判据本身的缺口**：§14.2 **没有任何机械化覆盖门禁**（15/18 项连标题引用都没有）；
  §14.1 要求"记录 SQL"而现有守卫只有 5 个通道、**没有 SQL 追踪**（等价的整库扫描不可观测）。
  ⚠️ 这不是验收通过声明；随 PR4/PR5/PR6 落地其判定会上升，引用时以当时最新提交为准。

- [DIRECT_SYNC_PR4_2E_2026-10-13.md](DIRECT_SYNC_PR4_2E_2026-10-13.md)：**PR4 步骤 2e 的验收记录**——
  直连车道的 `deltaMode` 放开为 `"full"` **并且真的接上统一接收器**（Workout / 评分类型 /
  显式删除 / GPX）。含端到端用例（真实排队 → 真实子进程 → 真实事务：登记分析任务 + 回执 `queued`
  + 无备份/无换库/主库 inode 不变）、**full 车道上的 §14.1 全 0**、以及 `directSyncApply` 独立计时。
  🔴 同轮修掉一个**真缺陷**：接收器复核摘要只算 XML+manifest、worker 准入摘要折进 `workout-routes/**`
  ⇒ 任何带 GPX 的载荷都硬失败（"载荷已变更"）；测试夹具当年手写了同一份错配方 ⇒ 假绿。
  **3 处突变全部被精确捕获**。⚠️ P01–P06 与首次历史分页/大包分批仍未迁移。

- [DIRECT_SYNC_PR5_S1S2_2026-10-13.md](DIRECT_SYNC_PR5_S1S2_2026-10-13.md)：**PR5-S1+S2 的验收记录**（PR4-2e 的硬前置）——
  `workouts.deleted_at` 软删（迁移 **v36**，只新增可空列）+ 事实侧唯一存在性判据
  （`workoutPresentConditionSql` / `sessionFactPresentConditionSql`）覆盖全部事实侧读路径。
  含 **C7**（删训练不再级联销毁已发布路线版本的点）、**C3**（软删后事实侧 8→7、汇总恰好少 5 km，
  而**分析侧仍是 8** —— D4.3）、结构判据（全仓只有一处允许写 `deleted_at IS NULL` 字面量）与
  **3 处突变全部被精确捕获**。同轮发现并修掉三处"软删带来的新缺口"（恢复语义 /
  删除配额分母 / 直连车道账本核对）。🔴 据此 **PR4-2e 的前置清单已清空**。
  ⚠️ PR5 的其余部分（两块视图、新鲜度、缓存、路线版本消费）**均未做**。

- [DIRECT_SYNC_PR4_STEP2CD_2026-10-13.md](DIRECT_SYNC_PR4_STEP2CD_2026-10-13.md)：**直接增量同步 PR4 步骤 2c/2d 的验收记录**
  —— 统一接收器（`apps/api/src/direct-sync-ingest.ts`）：一个 caller 事务里完成解析/路线/局部规范化/
  **同事务登记分析任务**/回执；写守卫按**表**分类（派生分析表一律拒绝，未表态的新表 fail-closed）；
  回执 `queued`/`not_required` 与登记**必须一致**（提交前断言）。新用例 9/9，含"Workout 登记后由
  真消费者跑完"的闭环与"回执写入点故障注入 ⇒ 整批回滚"。含 3+1 处突变验证（其中一次发现
  **GPX 用例在突变下假绿**并已修补）。
  🔴 本轮实测确认了 [PR5 设计](../docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md) 的硬阻塞：
  物理删 workout 会**级联删掉已发布路线版本的全部点**；并据此把 **PR5-S1+S2 定为 PR4-2e 的前置**。
  ⚠️ 本模块**今天还没有生产调用方**（`deltaMode` 仍 record-only），这是设计里的顺序，不是"已上线"。

- [DIRECT_SYNC_PR4_STEP2AB_2026-10-13.md](DIRECT_SYNC_PR4_STEP2AB_2026-10-13.md)：**直接增量同步 PR4 步骤 2a/2b 的验收记录**
  —— 载荷分类纯函数（**未知类型必须分析**，默认方向由突变验证钉住）与解析器的
  `callerOwnedTransaction`（批次边界改为 SAVEPOINT，**解析器提不了提交**；失败只撤自己那一段，
  调用方的其它写入仍能提交）。含 3 处突变全部被精确捕获，以及实施时对设计初稿的两条修订
  （分类事实改从**批次账本**取；写守卫按"允许写哪些表"而不是按载荷类别）。
  ⚠️ 这两步的能力**今天都还没有生产调用方**（2c/2d 才接），这是有意的顺序，不是"已上线"。
  ⚠️ 同为**当轮**产物：收尾后并入 [运维](../docs/OPERATIONS.md) / [项目审查](../docs/PROJECT_REVIEW.md) 或删除。

- [DIRECT_SYNC_PR4_STEP1_2026-10-13.md](DIRECT_SYNC_PR4_STEP1_2026-10-13.md)：**SQLite 直接增量同步 PR4 步骤 1 的验收记录**
  （依据 [PR4 落地设计](../docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md) 与 [PR2+PR3 设计](../docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md) 步骤 6b 的三步顺序）。
  改的是"消费者先认识 `import`"这一步：判据从**按类型**升级为 **`(job_type, 载荷 mode)` 合取**
  （`'import'` 是两个所有者共用的类型名），恢复流程与消费者共用同一个函数。
  含定向用例 11/11、下游包 36/36、`tsc` EXIT=0、**3 处突变全部被精确捕获**，
  以及一条**既有测试缺陷**的发现与修复（同步测试体调异步助手 ⇒ 失败打印 ✔ 却只有文件级红；
  全仓扫描 236 个文件命中 0 处，扫描器带阳性对照）。
  🔴 **如实标注**：本机**没有 `npm`**，`npm test` 无法原样跑；等价跑法
  `RAI_TEST_CONCURRENCY=1 node scripts/run-tests.mjs` 得 Node 1672/1676（唯一失败即"缺 npm"的环境项）、
  Web 单独跑 184/184。
  ⚠️ 同为**当轮**产物：收尾后并入 [运维](../docs/OPERATIONS.md) / [项目审查](../docs/PROJECT_REVIEW.md) 或删除。

- [UNCOMMITTED_REVIEW_2026-10-12.md](UNCOMMITTED_REVIEW_2026-10-12.md)：**当轮未提交改动**（PR1 文档 + PR2/PR3 实现）
  的分级审查（**3 条 🔴 / 4 条 🟡 / 3 项 ✅**）。🔴 的三条都在**门禁真空**上：`check:doc-refs` 当时的
  默认文档集**一份引用都没有**（校验了 0 处却返回 `EXIT=0`）、对新设计文档的两处越界引用未报、
  以及同一文档多处 `database.ts:<行号>` 内容漂移而**无基线可判**。
  同轮已全部修复（§七）：门禁纳入该文档、39 处引用实跑 0 越界、Y1/Y2/Y4 三处代码改动各补断言并逐条突变验证。
  ⚠️ **如实保留**：全量 `npm test` 本轮**未跑**（6 核 load 20+，不满足"独占"前提），Y3 只核对了它引用的三个常量。
  ⚠️ 同为**当轮**产物：收尾后并入 [项目审查](../docs/PROJECT_REVIEW.md) 或删除。

- [DIRECT_SYNC_PR2_PR3_2026-10-12.md](DIRECT_SYNC_PR2_PR3_2026-10-12.md)：**SQLite 直接增量同步 PR2/PR3 的实施与验收记录**
  （依据 [设计文档](../docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md) §8 步骤 1–6）。含改动清单、
  逐步实跑证据、**20+ 处突变验证汇总**（含一条被演示两次的通则：**差分/对拍无法发现"两边同坏"，
  必须另配绝对锚**）、以及 §14.1 覆盖边界。
  🔴 **如实标注：全量 `npm test` 本次未取得 `EXIT=0`**（1667 / 1660 pass / 3 fail）——
  3 条失败已用三层独立证据归因为**门禁自身在 6-CPU 上的并发脆弱**（默认并发 6 vs 5s/30s 墙钟轮询预算），
  **不是本批回归**；要取得可验收的绿灯必须在真正独占的窗口重跑。
  ⚠️ 同为**当轮**产物：收尾后并入 [运维](../docs/OPERATIONS.md) / [项目审查](../docs/PROJECT_REVIEW.md) 或删除。

- [DIRECT_SYNC_PR1_2026-10-12.md](DIRECT_SYNC_PR1_2026-10-12.md)：**SQLite 直接增量同步 PR1 的实施与验收记录**
  （依据 [SQLite直接增量同步设计](../docs/SQLITE_DIRECT_SYNC_DESIGN.md) §13 PR1）。含改动清单、实跑证据
  （`typecheck` EXIT=0 / 守卫测试 5-5 / `check:docs` / `check:doc-refs`）、**三处突变全部被精确捕获**的记录、
  一次已归因的假失败（并行 + load 13–15 导致 30s 等待超时）、以及 §14.1 的**覆盖边界**
  （PR1 只守住「有界 record-only 增量」+「任务重启」，其余仍走旧链路）。
  同批给出两条硬判断：**PR2 不可单独交付**（最小正确单元 = PR2+PR3+PR4+PR5）、
  **§14.5 真机与 §14.3 云机验收在本环境不可达**。
  ⚠️ 这是**当轮**产物：收尾后并入 [运维](../docs/OPERATIONS.md) / [项目审查](../docs/PROJECT_REVIEW.md) 或删除。

- [IMPORT_PUBLICATION_REDESIGN_2026-10-11.md](IMPORT_PUBLICATION_REDESIGN_2026-10-11.md)：**多智能体对抗式审查**——
  「每次同步整库换文件」是否设计错误。3 个专项智能体（存储架构 / 数据口径 / 运维节奏）+ 1 个红队 + 主代理逐条复核。
  含一次被推翻的红队 top1（"提前判定后跳过发布"会丢数据，实测该批 `record inserted 18`）、
  `cli.ts:197-202` 原文证明装库后那道全库校验不能删、以及按优先级排的 3 件事（加内存 / 裁台账 / 去冗余拷贝）。
  ⚠️ 同为**当轮**产物：收尾后并入 [OPERATIONS](../docs/OPERATIONS.md) / [项目审查](../docs/PROJECT_REVIEW.md) 或删除。

- [API_HANG_TRIAGE_2026-10-11.md](API_HANG_TRIAGE_2026-10-11.md)：**当轮线上事件处置与取证手册**
  （线上 API `/v1` 整段不答 → 定位到导入管线耗时 → 拆阶段插桩 P0-a）。含 P0 抓现场+重启命令、六条取证判据、
  云机实测（磁盘直读 376 MB/s / 直写 234 MB/s；**独立进程对同一份 2.16 GB 库做在线备份只要 12.4 s，
  管线内同名阶段却报 254 s**）、两次被实测证伪并**撤回**的假设（"进程卡住"、"fsync 次数 × 延迟"），
  以及两条可复用手法：「阶段必须平铺互斥（`totalMs >= ΣstagesMs`）」与
  「改联合类型后必须扫旧名字 —— `!includes(...)` 型守卫会静默变恒真，只会红的那一半救不了」。
  ⚠️ 同为**当轮**产物：收尾后并入 [OPERATIONS](../docs/OPERATIONS.md) / [项目审查](../docs/PROJECT_REVIEW.md) 或删除。

- [UNCOMMITTED_REVIEW_2026-10-11.md](UNCOMMITTED_REVIEW_2026-10-11.md)：**最近已提交批次**
  `14bda36..5950a11`（今日 5 个提交：纯补史门禁豁免 `cebb0dc` + iOS `jobId` 前台续接 `076b8bd`
  + live 探针清单 `6ea930f` + 两份验收文档）的分级审查（**0 条 🔴 / 3 条 🟡 / 12 项 ✅**）——
  按「智能体协作」分三路并行复核（后端 / iOS / 文档）+ 主智能体亲验全部关键结论，
  附门禁实跑（`typecheck` / `npm test` / `test:ios` 全 EXIT=0）与后端门禁突变验证。
  同批**已把三条 🟡 全部处理完毕**（§八）：新增 4 条库级测试直击生产删除方法的账本写入、
  1 条「生产路径删除 + 读证据」端到端用例，并把「realign 去重不写账本」改为断言钉住 ——
  **产品代码零改动**，`npm test` 干净重跑 `1550 tests / 1547 pass / 0 fail`、3 条突变逐条变红。
  ⚠️ 这是**当轮**产物：收尾后并入 [项目审查](../docs/PROJECT_REVIEW.md) 或删除，不长期保留。

## 保留的固定时点证据

`v2-audit-2026-09-30/` 是macOS本机固定截止的算法实施核验：

- `baseline.json`：源码版本与原库聚合元数据；原库schema22、268次训练，不代表线上状态。
- `normalization.json`：该库metadata天气覆盖盘点，不是归一化精度。
- `walk-forward.json`：零有效标签、指标null，不是准确率0。
- `load-replay.json`：已发布派生负荷快照的可得性对照，不是原始记录级历史回放。
- `release-rehearsal.json`：只在临时backup副本上的schema25/V4重算、同轨迹、回滚/重开与条件明确的性能原始轮次。
- `verification.json`：命令、结果、来源文件hash和原库前后hash。

这些文件记录的是生成时的证据，含有清理前的文档路径/工作树hash；不要改写历史hash，也不要把过去检查结果当作今天重新跑过。
当前文档映射和本轮检查见[项目审查](../docs/PROJECT_REVIEW.md)。已过期Windows报告、旧行号快照及重复阶段产物从Git恢复，不保留为“当前”。

## 新产物约定

实验/临时输出优先`var/reports/`；只有用于明确验收的脱敏证据才保留到本目录。
至少记录database identity/hash、as-of、时区、代码/配置版本、复现命令、通过/失败/不可评估与原因。
不得提交原始健康数据、Token、精确路线、上传ZIP或SQLite。

## 当前项目审查证据

`project-review-2026-09-30/`保留本轮必要的两份机器文件，不增加第二份Markdown报告：

- [model-boundaries.json](project-review-2026-09-30/model-boundaries.json)：R1–R3临时合成库复现，3项违反预期不变量；不是通过报告。
- [verification.json](project-review-2026-09-30/verification.json)：文档删除/保留映射、检查结果、来源hash与明确未验证项。

解释和修复优先级统一维护在[项目审查](../docs/PROJECT_REVIEW.md)。

后续四项修复保留独立“修复后”证据，不覆盖原始失败记录：

- [model-boundaries-after.json](project-review-2026-09-30/model-boundaries-after.json)：同一组R1–R3探针，3项违反降至0项。
- [fixes-verification.json](project-review-2026-09-30/fixes-verification.json)：修复机制、源文件hash、回归结果、副本演练摘要及未验证Windows现场的边界。
