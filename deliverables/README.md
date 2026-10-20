# 核验产物

现行说明统一从 [项目README](../README.md) 进入；审查结论只维护 [PROJECT_REVIEW](../docs/PROJECT_REVIEW.md)。
本目录不是第二套产品规范/实施计划，不保存**重复批次** Markdown 或 archive 副本。当轮尚未收尾的审查
报告可以临时列在下方「当轮审查」一节，并在下一轮并入 `PROJECT_REVIEW` 或删除。

## 当轮审查（未收尾；含已提交与未提交文档）

> 状态口径（2026-10-18 修正）：本节报告可能**已提交**，也可能仍只存在于工作树；一律按文末「新产物约定」在下一轮并入 `PROJECT_REVIEW` 或删除，不能把本节标题读成"这些文件还没提交"。

- [UNIFIED_TRAINING_PLAN_VERIFY_2026-10-20.md](UNIFIED_TRAINING_PLAN_VERIFY_2026-10-20.md)：
  **统一训练排课方案的真实性核实与 PR1/F01 落地** —— 逐条核对方案文档的 E01–E15 与 F01–F06（F01–F06
  全部复现），给出四处必须修正的表述（F02 机制与标准案例、F06 的 `end` 把未来窗口写成 rest、E07 的
  guard 归属、iOS 入口数量），并记录本轮落地：`training-mode-policy.ts` 纯函数模式解析（16 条断言）、
  剂量政策 `v1→v2` 的逐维度修复（5 条回归，质量课从不可评估恢复为可行、轻松课成本从伪造 5 km 改为
  实测上界 5.217 km）、契约与受限脚本的失败关闭改造。**F02/F03 未修，PR3–PR7 未开始，G01–G03 仍阻断；
  未迁移数据、未部署、未做真机验收。**

- [IOS_DEVICE_LOG_TRIAGE_2026-10-20.md](IOS_DEVICE_LOG_TRIAGE_2026-10-20.md)：
  **iOS 真机日志分诊（当轮）** —— 结论"未发现 P0 功能故障"：健康同步的两行通道计数是历史重放期
  单批打满上限的正常指纹，`BGTaskScheduler` 注册与重排正常；按性价比给出 P1–P3 改进项（日志补
  `source`/`anchorTypes`、`keep` 行窗口聚合、Chart overlay 顺序、键盘 toolbar 按需安装、高德 SDK
  懒初始化等）。**修复项未实施；本文只记录分诊结论，真机复测未做。**

- [IOS_SYNC_RELEASE_2026-10-20.md](IOS_SYNC_RELEASE_2026-10-20.md)：
  **R1–R6 发布记录（已提交 + 已部署）** —— `62f490b` 已推送 gitee，并经 `deploy/upgrade.sh --apply`
  部署到生产（`101.33.202.40`；无 schema 迁移，v46 不变）；记录本机全部发布判据（含三次 `npm test`
  的既有时间敏感 flake 与已修的夹具时间炸弹、13 条 Rust parity skip）、生产实测（health/401/读路径/
  watchdog/无 5xx）、既有 freshness 延迟基线与代码回滚边界。**iOS 签名构建与真机验收仍未做；
  gitee 侧不会给出 CI 绿灯。**

- [IOS_SYNC_DEFECT_FIX_EXECUTION_2026-10-19.md](IOS_SYNC_DEFECT_FIX_EXECUTION_2026-10-19.md)：
  **同步残余缺陷修复记录（第二轮）** —— 修掉核实报告列出的 4 条残余风险：R6 修复轮接线
  （双重重放）、R6 边缘（坏锚点+旧 floor 整批失败）、B1 前台触发点无门禁（`RAIApp.swift`
  被类型检查排除）、B2 helper 唯一性无门禁；并完成 B6 P1 第一片（公式文本锚去格式敏感、
  与 122 条预算行为判据交叉验证）。附 6 组定向突变（改坏→红、还原→绿）与边界；
  **产品代码仅 1 文件 1 处判定；B6 P1 剩余批次与 P2 视觉快照仍未做（附理由）。**

- [IOS_SYNC_B6_FIX_EXECUTION_2026-10-19.md](IOS_SYNC_B6_FIX_EXECUTION_2026-10-19.md)：
  **B6 门禁执行链修复记录（P0 止损）** —— 修复 `check-pr5-facts-analysis.py` 三重缺陷：
  Python 3.9 上 PEP 604 导入即崩（0 条判据执行）、C9 基线放在 gitignored 的 `var/` 从不入库、
  且该门禁只挂在不被 pre-commit/CI 调用的 `check:ios-gates`（连续 6 天零执行）。
  落地：基线入库 + `--write-baseline` + `fieldsSha256` 完整性判据、孤儿门禁直接判红、
  解释器下限统一 3.9、挂进 `test:ios`/pre-commit/CI；附三组 C9 突变验证与实跑结果。
  **未改产品代码；P1/P2（抽测试缝）未做，理由与顺序见文末。**

- [IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md](IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md)：
  **五项未实施项（B3/B4/B5/B6/C1）实际情况核实与优化建议** —— 逐项给出代码事实与结论：
  B3/B4/B5/C1 维持暂缓（附触发条件与对计划步骤的勘误）、B6 判“需要优化”；另报三处残余风险
  （R6 修复轮接线与注释/回归不一致导致双重重放、B1 前台触发点无门禁且 `RAIApp.swift` 被类型检查
  排除、B2 helper 唯一性无门禁）。**只读核实，未改代码、未部署、未真机验收。**

- [HEALTHKIT_SYNC_REPORT_VERIFICATION_AND_PLAN_2026-10-19.md](HEALTHKIT_SYNC_REPORT_VERIFICATION_AND_PLAN_2026-10-19.md)：
  **外部HealthKit架构报告核验与可实施优化方案** —— 逐项区分成立、误报和未验证主张；
  真实SQLite复现约6.23秒同步等待，纠正“无压缩”与正常初始化的WAL判断，厘清类型/运行覆盖，
  补充公平分页未接生产调用的缺口，并给出文件级分批任务、验收、兼容与回滚边界。
  **仅本地核验与文档；未改产品代码、未部署，不代表真机验收。**

- [IOS_SYNC_FOLLOWUP_PLAN_2026-10-19.md](IOS_SYNC_FOLLOWUP_PLAN_2026-10-19.md)：
  **第二轮后续项核验与可实施优化方案** —— 核实 R6 旧覆盖下界（git 全历史证据）、
  `npm test` Rust parity 失败根因（HEAD 同样失败 / 过期产物 / 无 cargo）；实施 R6 防御性
  逐类型修复、Rust 产物新旧判据、B1 启动/前台分析对账、B2 游标更新集中化；B3–B6/C1 给出
  文件级步骤、验收与回滚。**未部署、未真机验收。**

- [IOS_SYNC_OPTIMIZATION_EXECUTION_2026-10-19.md](IOS_SYNC_OPTIMIZATION_EXECUTION_2026-10-19.md)：
  **R1–R5 代码实施记录（工作树，未部署）** —— 统一待办计划与前后台执行、SQLite 原子意图确认、
  独立窗口 anchored 分页与回执同事务提交、服务端分析脏证据读取、客户端三态展示；附文件清单、
  验证结果、R6 未实施理由与回滚边界。**不代表真机端到端验收或已发布。**

- [IOS_SYNC_REREVIEW_2026-10-19.md](IOS_SYNC_REREVIEW_2026-10-19.md)：
  **优化后复审（本地 `67028e1`，生产 `33f79fe`）** —— SSH 只读核实目标 6.0125 km 跑步、缺失指标、102.510 秒事实/分析间隔及部署差异；发现 3 项 P1、3 项 P2，含待办与执行脱节、observer 并发确认、尚未实现的分页及分析影响范围漏判。附生产证据、合成复现、验证结果与下一步顺序；不代表真机完整同步已验收。
  **第 7–11 节为 R1–R3 详细实施方案（待实施）**：统一待办执行/重排、SQLite 原子意图确认、独立窗口 anchored 分页与回执同事务提交；含文件级任务、四个提交、26 项验收用例及回滚边界。

- [IOS_SYNC_INGEST_AUDIT_2026-10-19.md](IOS_SYNC_INGEST_AUDIT_2026-10-19.md)：
  **iOS 同步与解析入库审查（2026-10-19）** —— 针对 10 月 18 日晚约 6 km 训练多次同步、时序后补的反馈，在 `d037fc7` 上核查完整链路；发现 5 项 P1 与 3 项 P2，包含训练窗口同批接线、分页收敛、补齐调度及完整性/分析新鲜度问题。附本地合成复现、优化方案、验收标准及只读生产探针说明。**生产 SSH 在认证前断开，未取得生产数据库；不是线上根因已确认或修复已发布的报告。**

- [IOS_SYNC_VERIFY_AND_PLAN_2026-10-19.md](IOS_SYNC_VERIFY_AND_PLAN_2026-10-19.md)：
  **iOS 健康同步：生产核实与可实施优化方案（2026-10-19）** —— 经 Lighthouse TAT 只读取证（生产库 + nginx + 作业账本），逐条核实上一份审查：事故数字全部属实，但主因是线上 `8efdb99` 落后于审查基线 `d037fc7`（读侧 `INNER JOIN active_ability_assessments` ⇒ 分析发布前列表无行、详情 404；`dirty-range.ts:178` 对 VO2Max 置 `full=true` ⇒ 286 场全量重算）。给出 P0（发版闸门 A7 + 部署）→ P1（A1/A4）→ P2（A2/A3/A5/A6）→ P3（去重/埋点）的执行顺序与验收断言。**成文时仅只读，未改生产数据、未部署。**
  执行状态见 [IOS_SYNC_EXECUTION_2026-10-19.md](IOS_SYNC_EXECUTION_2026-10-19.md)：P0 已部署并验收，P1 已随 `33f79fe` 落地，P2 的 A3/A5/A6/A8 代码完成、待与下一版 App 同批上线。

- [IOS_SYNC_EXECUTION_2026-10-19.md](IOS_SYNC_EXECUTION_2026-10-19.md)：
  **方案执行记录（2026-10-19 当天）** —— 生产部署 `8efdb99 → 33f79fe`（服务端代码 = `d037fc7`）+ v46 迁移（停服、36 s、2.3 G 一致性备份、`pending:[]`、FK ok）；逐条验收：列表事实驱动且 `analysisPublishStatus` 可用、`/freshness` 与 `/sync/coverage` 由 404 变 200、事故三时刻（`12:29:38.755` / `12:30:23.066` / `12:31:21.265`）可由端点直接读出。另含 P2 的 A3/A5/A6/A8 实现与判据（未部署）、A2 分页的排期边界、回滚锚点与真机验收步骤。

- [DEEP_REVIEW_2026-10-18.md](DEEP_REVIEW_2026-10-18.md)：
  **全项目深度审查（2026-10-18）** —— 5 个并行只读 lane（数据管线 / 领域算法 / API 运行时与安全 / iOS 客户端 / 门禁·CI·文档）在 `HEAD 24aa7d8` 上的复核 + Lead 交叉验证；结论 **P0 0 / P1 0 / P2 11 / P3 42**，含本机基线（typecheck、全量 `npm test` 2038/2035/0 fail/3 skip、iOS 门禁 1132 PASS、`rust:verify` 11/11、五个文档/结构门禁、`npm audit`）与未验证边界。分 lane 证据见 [deep-review-2026-10-18/](deep-review-2026-10-18/README.md)（按 lane 直接打开 01–05 五份文件）。
  **全部 11 P2 + 42 P3 已同轮修复/决策**：[FIXES_2026-10-18](deep-review-2026-10-18/FIXES_2026-10-18.md)（逐 ID 状态、修复后全量验证、3 项 DECISION 与遗留风险；代码/文档改动已随同轮提交落地）。

- [TRAINING_PLAN_REVIEW_2026-10-18.md](TRAINING_PLAN_REVIEW_2026-10-18.md)：
  **训练计划功能详细审查（2026-10-18）** —— 服务端读取/发布/回执、iOS 状态机与 WorkoutKit 排期、周期化/依从性/摘要协议、文档契约与门禁；结论 **3 项 P1（回执 v2 线格式、revision 冲突 500、coach-loop 读取无跨库回验）+ 18 项 P2**，附本机验证（typecheck / iOS 门禁 / 207 例计划测试）与未验证边界。分 lane 证据见 [training-plan-review-2026-10-18/](training-plan-review-2026-10-18/README.md)。
  **批次 A（3 个 P1）已修复并落地回归**：[FIXES_BATCH_A_2026-10-18](training-plan-review-2026-10-18/FIXES_BATCH_A_2026-10-18.md)。
  **批次 B/C（3 项残留风险 + P2×18 + P3×21）已修复**：[FIXES_BATCH_BC_2026-10-18](training-plan-review-2026-10-18/FIXES_BATCH_BC_2026-10-18.md)（含 `server-runtime` 31/31、全量 Node 套件与 iOS 门禁结果、未验证边界）。

已收尾批次（2026-10-09 ~ 10-11）的原文档已删除，指针见 [项目审查 §8](../docs/PROJECT_REVIEW.md)。

- [RUNNING_POWER_GCT_MISSING_2026-10-17.md](RUNNING_POWER_GCT_MISSING_2026-10-17.md)：
  **10-14 跑步详情缺「跑步功率 / 触地时间」时序 —— 定位报告 + 修复落地（2026-10-17 晚）** ——
  结论不是读/渲染或服务端丢数据：该窗口这两类记录**库里零行**，最后一次入库是 10-13T13:11Z（上一次跑步），
  详情页如实显示空。10-16T01:35/01:36Z 的窗口批已把该次跑步其余类型全部补齐（4252 + 1155 条），
  同一窗口对 power/gct 返回空；服务端同链在 10-13 实测写入 790/389 条、当前 HEAD 合成载荷实测无损，
  故缺口在手机端未上交（手机健康 App 里已有逐样本时序 ⇒ 数据源不缺，是样本晚到 + 窗口过期）。
  空窗口仍推进 `recentWindowReadAt`（+6h 重叠）使窗口下界越过 10-14 ⇒ 不会自愈。
  **修复已落地**（apps/ios 导出侧，过 `test:ios` + 9 条突变的验证，独立对抗评审后补了分页/空页语义）：
  按日期的跑步动态补读（`LateDynamicsBackfill`：近 14 天、有界、最新优先、**截断分页**、
  **空页不记账**、30 天再武装）、空窗不再推进水位（`RecentWindowAccounting`）、
  窗口 pass 轮转公平调度、"该有却没有"可见告警。
  手机端 15 秒判定（读权限开关）与真机重装步骤见文。

- [review-ios-sync-data-ingest.md](review-ios-sync-data-ingest.md)：
  **iOS 同步与数据解析入库审查 + 复核与实施状态** —— 8 项候选（P1×2 / P2×4 / P3×2）；
  二次核对判定 **2 项与代码事实不符**（P2-2 目标函数无生产调用方、P3-1 的建议无效），
  **1 项由"事实错误"降级为取舍**（P1-2：服务端不限制记录条数，第二次 apply 按批有界但总成本随批数增长），
  **4 项已在工作树实现（未提交）**（P1-1 去掉冗余全量读 / P2-1 白名单↔迁移双向门禁 /
  P2-3 spool 检查间隔 512 且可测 / P2-4 升级协议与钉版本）。§4.4 列出未跑完的项目与环境边界
  （全量 `npm test` 中止、application 套件受当时沙箱 TMPDIR 限制且当前不可复现、native-worker 2 红为旧二进制既存）。

- [plan-remove-web-keep-ios-api.md](plan-remove-web-keep-ios-api.md)：
  **移除 Web 与 macOS 壳、收敛为「原生 iOS + 云 API」· 可执行实施文档（v2，B0–B5 已执行；云端已全量上线）** ——
  合并原草案与旧版退役方案，按 B0–B7 批次给出逐文件逐行改动、每批验收命令与回滚；实测基线 `9a1e2c8`。
  关键纠错：nginx 须保留 3600s 超时/限速/robots（不可收紧到 120s）、删 `DOM` lib 会让 API 测试 42 处报错、
  验收矩阵 B02 的唯一引用在 `apps/web` 测试、`check-web-build.mjs` 有 3 个调用方、iOS 直连 API 需要开发 Token。
  执行记录见附录 E：本地提交 `6f8e6ca`…`15b68bb`；云端 `2e7a231 → 6ed6fa4`、主库 v37 → v45（61s，纯 DDL，
  已做 2.3G 一致性备份）、Web 全路径 404、iOS 读写/分享卡/导出全 200；`RAI_PUBLIC_HOSTS` 已置空
  （匿名读 401、带 Token 200，`workbuddy2api`/`frps` 两个容器不受影响）。
  回滚锚点 tag `pre-web-retirement` + 服务器备份 `/root/rai-retire-backup-20261017-205451/` 与
  `/var/lib/rai/var/backups/rai.before-v45.20261017-210024.sqlite`。遗留：真机同步验收待 iPhone 端执行。
  旧方案 [WEB_DESKTOP_REMOVAL_PLAN_2026-10-15.md](WEB_DESKTOP_REMOVAL_PLAN_2026-10-15.md)
  的内容已并入本文件；真机验收完成后两者一并按本目录约定归档。

- [SYNC_OPTIMIZATION_EXECUTION_PLAN_2026-10-16.md](SYNC_OPTIMIZATION_EXECUTION_PLAN_2026-10-16.md)：
  **同步与计算优化 · 落地方案（O01–O12 → 16 工作包 / S0–S5）· S0+S1 执行中** —— 把
  [审查文档](../docs/IOS_SYNC_PERFORMANCE_REVIEW.md) 的 12 项优化转成可执行、可验证、可回滚的工作包：
  三方只读核实全部与审查一致 + 唯一失败门禁亲验（1 fail / 6 pass，第三 `directSync` 产出方）、
  16 包依赖拓扑与关键路径、8 项决策点、5 大风险与缓解、每包门禁/突变/回滚纪律。
  S1 执行序 = WP-12(O03) → WP-10(O01) → WP-13(O05) → WP-11(O02)（O03 为共同底座）。
  执行完成后按本目录约定归档或删除。

- [IOS_SYNC_INGEST_REVIEW_OPTIMIZATION_2026-10-15.md](IOS_SYNC_INGEST_REVIEW_OPTIMIZATION_2026-10-15.md)：
  **iOS 数据同步 / 解析与入库 外部审查及优化方案** —— 4 项 P1（后台待续页能发现却不执行 / 无变化成功缺持久回执致
  客户端永久 hold / 删除事件不计导出预算 / 预算收缩无符号下溢）+ 3 项 P2（历史回填挤占近期 / 代次语义错配 /
  更新只记新时间），附解析与入库的性能优化机会与四批落地建议。**本仓库逐条只读核实：R1–R7 全部成立**；
  修复按 A→B→C→D 分批推进。

- [LATEST_WORKOUT_MISSING_DATA_2026-10-15.md](LATEST_WORKOUT_MISSING_DATA_2026-10-15.md)：
  **最新跑步「训练详情缺数据」线上只读排查** —— 根因 = iOS 记录「全史重放」积压（52.6 万条从旧到新重发、
  4 批 0 插入、剩余 ~113 批），10-13 21:11 之后新记录（含该次跑步心率）仍在队尾；直接链 =
  无逐条心率样本 → 统计占位 `sampleCount:1` → 覆盖率 3% → `heart_rate_coverage_low` → trial。
  含事件时间线（回执确认卡住 / 全量回填批被 400 双拒 / 上传 499 中断 / 次日补传）、已证伪与未排除清单、
  P0/P1/P2 修复建议。🔴 运维铁律：勿点「重新导入全部」。

- [WEB_DESKTOP_REMOVAL_PLAN_2026-10-15.md](WEB_DESKTOP_REMOVAL_PLAN_2026-10-15.md)：
  **Web 与 macOS 退役方案（三端收敛为「iOS + 后端」）· 待评审（未执行）· 已并入 v2 实施文档** —— 只读编制（未改代码、未跑门禁），
  证据基线 `8081ed6`。范围：移除 `apps/web`（92 跟踪文件）与 `apps/ios` 的 macOS 平台 + WKWebView 壳；
  保留 iOS / API / 16 个算法包 / Rust 引擎 / ML 研究。六大耦合面逐条落行号（API 静态托管 `server.ts:452-454`、
  nginx `:53`、systemd `:15`、**iOS 默认地址踩在 vite 代理 5173 上的隐藏耦合**、门禁与 CI、pbxproj 五组行号）。
  含 web-only 31 端点让渡清单（🔴 恢复通道 / 成绩录入 / 隐私区编辑待拍板）、🔴×4 + 🟡×6 风险、
  Step 0–6 分步（每步改动/验收/回滚）、未决问题 6 条。执行完成后按本目录约定归档或删除。

- [IOS_BACKEND_FIX_LANDING_2026-10-15.md](IOS_BACKEND_FIX_LANDING_2026-10-15.md)：
  **iOS 端后端功能修复落地记录** —— 对上一条审查的 5 批修复：Batch 0 服务端契约闭环 /
  P1 终局清算（🔴-1 + C1 + C4，含「放弃未确认发布」逃生阀）/ P2 门禁与失败态可区分 / P3 语义·安全
  加固 / P4 清理。验证：typecheck=0、test:ios=0（94 文件类型检查 + 288 条结构判据）、node 五批定向
  全绿、web vitest 25 文件/186 用例全绿、**突变 4/4 被检出**。**两处偏差已明示**：Web 上传保留并补
  幂等头（移除属产品级决策，待专项批次）、A3 采用契约全集门禁而非客户端熔断。

- [IOS_BACKEND_AUDIT_2026-10-15.md](IOS_BACKEND_AUDIT_2026-10-15.md)：
  **iOS 端全部后端功能审查（多智能体协作 · 只读）** —— 4 路并行子审查（同步上传链剩余面 / 读取契约 /
  计划·教练写路径 / 连接鉴权安全＋路由登记）＋ 主智能体逐条复核（🔴/🟡 全部亲验到行号）＋ 门禁实跑
  （test:ios EXIT=0·288/0、typecheck=0、定向 worker 1/1、路由登记运行时对账 1/1）。结论：无 P0；
  **🔴×1**（计划发布账目在 `expired`/`scopeMismatch` 终局答复下无法清除 ⇒ 同 scope 计划写与手表排期
  永久楔死，`clearCache` 碰不到 `app_metadata`）、**🟡×19**（performance 白名单失默 / inspect 未知 400
  保险丝缺失 / P2c 截断无可观测 / 解码失败折叠成"离线" / 回执终局码无作废分支 / share-card 无轨迹错报 /
  结构门禁地板余量 15 条 / 测试夹具用契约域外枚举值 …）、**🔡×19**；**证伪 0 条，数值修正 1、口径限定 3**（§四）。
  与同日两份同步/落库报告的增量关系已在范围声明中写明（不重复）。

- [SYNC_DATA_PIPELINE_AUDIT_2026-10-15.md](SYNC_DATA_PIPELINE_AUDIT_2026-10-15.md)：
  **同步数据与数据处理链路审查（多智能体协作 · 只读）** —— 4 路并行子审查（服务端直连 / iOS 同步端 /
  导入落库 / 派生计算）＋ 1 路补充独立审查 ＋ 主智能体逐项抽样复核（含 1 项 git worktree 定点突变实证：
  收敛门禁"**接线全拆 284/0 绿、函数改名才 2 红**" ⇒ 假绿成立）。结论：无 P0；**P1×1**（data-only
  准入死键 `data_only_baseline_contract` 无生产写入方、夹具自写键 ⇒ 测试绿/生产死）、**P2×8**
  （门禁假绿已实证 / P2b 耗尽不落档 / 单条超大轨迹静默不同步 / (2,8] MiB 窗口无正向测试 / inspect
  乐观 ready / `recoveryIsolationHolds` 恒真 / inspect 未知 400 无保险丝 / data-only 单测摘要不对齐）、
  P3×6；**主智能体证伪 1 条、修正 2 条**（§四复核记录）。门禁实跑：typecheck=0、http-acceptance
  9/9、direct-sync 定向 43/44（1 例资源型超时、隔离复验绿）。**零代码改动**（仅新增本文档）。
  **→ 修复已于同日落全部落地**（§八：P1-1 删门槛 / P2-1 逐接线判据突变红 / P2-2 耗尽落档 /
  P2-3 可见化 / P2-5 inspect 404 / P2-6 属性测试 / P2-7 abandonTask / P3-c 全面清理；
  验收：typecheck=0、test:ios EXIT=0（288 checks）、G4 定向批串行复验 107/106、
  doc-refs 越界 0 漂移 0；1 处 G4 期真回归（漏网 CommandSurface 用例）已当场删修）。

- [INGEST_PERSIST_CHAIN_REVIEW_2026-10-15.md](INGEST_PERSIST_CHAIN_REVIEW_2026-10-15.md)：
  **导入与落库链补充独立审查**（同批多智能体协作的独立第 5 路）—— 🟡×2 + 🔡×1：data-only 单测用
  「实现自己的摘要函数」算载荷身份（跨层契约靠远处闸门兜着，一旦放宽即硬失败）/ `payloadSha256`
  方法文档与 S3.1 后行为矛盾 / `unchangedWorkouts` 全表 `COUNT(*)` 语义挪用；并含任务回执：死代码
  现状两族归类（静态有引用/运行期不可达 vs 强死码）、`data_only_baseline_contract` 零写入方证实。
  其结论经主报告抽查并入（P2-8 / P3-c/d/e）。**→ P2-8 / P3-b/d/e 已同日修复**（P3-e 仅留口径注记，
  O(N) 修正待体量测量）；死代码两族已按 P3-c 全面退役（17 符号残留断言全零）。

- [INCREMENTAL_SYNC_IMPLEMENTATION_PLAN_2026-10-14.md](INCREMENTAL_SYNC_IMPLEMENTATION_PLAN_2026-10-14.md)：
  **纯增量原地同步改造 · 实施方案（可执行版 v2）** —— 本轮的**实施锚定文档**（非审查报告）。
  基线 `51b19cf`（= origin/main = 生产 HEAD），目标：回退率降 0 + 消灭两次全库校验成本，不动 DB 引擎、
  不加 schema 迁移。含 5 阶段逐步操作（含输入/输出/验收/回滚）、C1–C8 前置条件（唯一硬阻断 = 带校验冷备 +
  副本恢复验证）、T1–T21 验收用例、R-01~R-10 风险登记册、L1–L5 分级回滚、行号索引。
  关键决策 R1：**iOS 分批版先行（阶段 2）→ 服务端收口版后行（阶段 3）**（收口版 × 旧 iOS = 超界批次永久 400）。
  实施完成后本文档应归档/删除（符合本目录"不长期保留实施计划"的约定）。

- [DIRECT_SYNC_TAIL_PAGE_ROOT_FIX_PLAN_2026-10-14.md](DIRECT_SYNC_TAIL_PAGE_ROOT_FIX_PLAN_2026-10-14.md)：
  **直连同步「尾页超额」根治：方案 + 实施与验收记录** —— 根因是**提交单位（页）与上界单位（字节）不匹配**：
  服务端按 `statSync(export.xml).size` 判上界，iOS 按 `HKAnchoredObjectQuery limit: 1000` 整页提交，而预算检查写在
  **页已落盘之后** ⇒ 每批最后一个页整体越界（真机实测预算 1,887,436 B → 实际 2,411,741 B，超 524,305 B，被 400 硬拒并卡死同步链）。
  修法 = **写前判定（S2.5）**（整页渲染 → 判定 → 整页提交或整页不提交，停止时锚点退回页前）+ **自适应 query limit**
  （前进粒度从「≥1 整页」降到「≥1 条记录」，夹紧规则 `requested < limit ? max(1, requested) : max(1, limit/2)`）。
  同批连带三条：route 维度的**先判后取**缺口、`direct_sync_payload_exceeds_bounds` 的**零消费方**（预算收敛 `.convergeBudget`）、
  上传前**本地自校验** `exceedsServerBounds`（比的是服务端硬上界，`deletions` ↔ manifest 删除配额而非 XML 记录数）。
  §11 记实跑证据与预存在失败（`check-pr5-facts-analysis.py` 缺 `var/reports/pr5-c9-baseline-keys.json`，干净树复现、与本批无关）。

- [DIRECT_SYNC_ANALYSIS_WAKE_FIX_2026-10-13.md](DIRECT_SYNC_ANALYSIS_WAKE_FIX_2026-10-13.md)：
  **直连车道「登记了分析任务，但没人唤醒消费者」的定位与修复** ——
  `direct-sync-ingest.ts` 在同一个主库事务里登记了 `recompute_jobs`，而 import 终态回调
  `onTerminal` 只做导入源清理、不含 `recomputeWorker.schedule()`；旧链路靠 CLI 子进程内联
  `runNextJob()` 自我消化，快车道**不 spawn CLI** ⇒ 唯一的唤醒点消失。
  🔴 **后果不是"分析慢"而是"写通道被封"**：`isDatabaseWriteBusy()` 把 `queued` 算作忙 ⇒
  线上实测 11 个写端点全部 409、滞留 8 分钟以上（`started_at` 恒 null、事件表无 `claimed`）。
  修复 = `onTerminal` 补唤醒 + `wakeIfPending()` 60 s 兜底巡检；守卫两条（行为级 + 源码级），
  断言逐条**突变到红**（含"方法仍在、逻辑失效"那次）。⚠️ 同批另记两个**既有红**
  （`deploy-upgrade` 的 `backup-reminder` 断言、`connection-contention` 的锁等待窗口），
  三次复现稳定、均不在本批 diff 内；并如实标注全量 `npm test` 的失败形态与降并发复验结果。

- [DIRECT_SYNC_PR6_A15_A17_AND_PR5_S3S6_2026-10-13.md](DIRECT_SYNC_PR6_A15_A17_AND_PR5_S3S6_2026-10-13.md)：
  **批量 A+B 验收：真机等价 HTTP 夹具、§11 备份入口退场、PR5 S3→S6 读侧一致性** ——
  ① **A1**：新 HTTP 夹具走完真机会话顺序（上传 → inspect → import-jobs → 终态），把 A17「文案/状态截图」
  的**协议半边**机械化：`committed`/`queued`/`not_required`/`receiptId` 一致/`publishedReleaseId: null`
  + 重放取原回执 + COMMIT 前强杀 + COMMIT 后丢回复 + 删除-only，**9/9**（Lead 独立复跑）；
  ② **A2**：`POST`/`DELETE /v1/backups` 退役为 410（**不是 501** —— `apiErrorPayload` 会吞掉 5xx 文案），
  `deploy/upgrade.sh` 不再 POST 备份，`deploy/README-UBUNTU.md` 那份"每 40 分钟打一个已退役接口"的
  运维指引已改；**恢复能力与已有备份文件一律不动**（隔离 `var/` 逐字节断言 + 既有恢复用例真跑）；
  ③ **B1**：PR5 S3→S6 —— `currentFacts`/`publishedAnalysis` 两块在一个 `BEGIN DEFERRED` 里读齐、
  行键**交集为空**、旧字段**键集与可选性**逐字节不变；详情路线走 `route_versions`（老库指针 `NULL` 退化并标注）。
  🔴 本批修掉**三条真缺陷**：直连接收器 `journal_mode=WAL` 早于 `busy_timeout` 导致竞争下整批失败
  （**Lead 给的第一版修法被实测否掉**：该 PRAGMA 不走 busy handler）、备份约定与代码不一致、
  以及**三处门禁自身的无牙/假绿**（其中两处是本批刚写的新判据，靠突变探针逼出来）。
  ⚠️ P01–P06 未测、真机观感未验、A12/A13 真并发不可达；`deploy-upgrade` 4 条在本机 SKIP —— 逐条见报告 §5。

- [DIRECT_SYNC_PR6_DEVICE_VERIFICATION_2026-10-13.md](DIRECT_SYNC_PR6_DEVICE_VERIFICATION_2026-10-13.md)：
  **PR6「需真机验证的实施项」落地与证据分界**（iOS 侧协议/状态/文案）——
  ① iOS 持久回执协议：`DirectSyncIngestStatus`/`DirectSyncAnalysisStatus`/`DirectSyncReceipt`
  与服务端 `INGEST_STATUSES`/`ANALYSIS_STATUSES` **逐字逐序**一致（新增跨语言 parity 门禁，本机真跑 13 条）；
  ② 游标闸门 `DirectSyncCursorPolicy.decision`：每页候选游标只在**对应 durable committed 回执**之后提交，
  老服务端/`unchanged` 收尾由 `requiresReceipt` 表达（§10.2「保留旧等待含义」）；
  ③ §10.3 六句文案集中在 `DirectSyncCopy`，旧三句在 iOS 源码树缺席（反向哨兵）；
  ④ 分析终态对账：回执只记 COMMIT 快照，`analysisJobId` + `GET /v1/jobs/:id` 让「分析已更新」**真的可达**。
  本机实测：`npm run typecheck` EXIT=0、全量套件 **1735→1738 tests / 0 fail** + Web 184、`npm run build` EXIT=0、
  三支新门禁 48/13/43 全绿、**19 个突变探针**。⚠️ **Swift 一行未编译未执行**（本机无 Xcode，
  `npm run test:ios` 是显式跳过）；真机清单 D1–D4 与「不可达清单」（P01–P06、A12/A13 真并发）在文内。
  另记三处**本批发现并修掉的真缺陷**：receipt-less 成功路径 × 游标闸门**自锁**、`.hold` 把已提交批次显示成失败、
  `npm run typecheck` 在制品期 EXIT=2。

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

- [DIRECT_SYNC_PR4_STEP3_WRITE_LEASE_2026-10-13.md](DIRECT_SYNC_PR4_STEP3_WRITE_LEASE_2026-10-13.md)：
  **PR4 步骤 3 落地记录（§14.2 A11）**。写许可从"整轮 drain 持有"改成**只在单个 SQL 语句期间**持有：
  连接代理 `withWriteGate` 覆盖所有写、读不取许可；主线程用 `Atomics.waitAsync` 事件驱动授权
  （实测 **0.070 ms/窗口**，轮询版 7.1 ms ⇒ 逐语句租约才可行）；worker 退出/崩溃必须 `dispose()` 释放。
  含 **A11 时间线用例**（真线程跑真分析：分析期间能拿到写许可、最长连续占用 ≤500 ms）、
  协议/覆盖/结构判据、以及实施中撞到并修掉的两个真缺陷（漏 `notify`、服务器只试一次导致死锁）。
  忠实还原旧行为的突变 1.8 s 内转红。⚠️ 读侧仍不取许可，输入稳定性依赖"固定 FactsReader"（未做）。
  ⇒ §14.2 `未覆盖` 由 1 项减为 **0 项**。

- [DIRECT_SYNC_PR4_STEP3_REVISION_2026-10-13.md](DIRECT_SYNC_PR4_STEP3_REVISION_2026-10-13.md)：
  **PR4 步骤 3（短写租约 / A11）动工前的实测修订**。独立审计推翻了设计里"整轮持锁 = 一个长事务"
  的前提：**分析根本没有长事务**（每句自动提交，第二条连接实测可见中间态）⇒ 要改的是"何时持写许可"；
  另有三处必须补：窗口顺序要按**代码顺序**（`createModelRun` 早于 `createTrainingMetricRun`，外键会炸）、
  发布窗口内部不可再切、以及**不许引入阶段间全有全无**（两条既有用例依赖候选行残留）。
  握手成本用可复现脚本实测：**每窗口 7.1 ms** ⇒ 逐语句租约不可行（10³ 句 ≈ 7 s），
  必须按有界阶段窗口 + 显式让路点。⚠️ 本轮**只做修订**，租约机制未实现（A11 仍未覆盖）。

- [DIRECT_SYNC_A10_ANALYSIS_ISOLATION_2026-10-13.md](DIRECT_SYNC_A10_ANALYSIS_ISOLATION_2026-10-13.md)：
  **§14.2 A10「分析失败隔离」的行为级证据**（验收清单里原本是"未覆盖"的两项之一）。
  真实故障注入（`BEFORE INSERT ON model_runs` 触发器）⇒ ①原回执逐字段不变（两批都查）、
  ②失败通过 `recompute_jobs` 与 `/v1/jobs` **独立可见**而旧 release 仍可读、③重试走 API 真实入口
  且只计算（批次/事实/回执不变、无备份、指针移到新 release）。**4 处突变逐个跑**，
  其中 1 处如实记录为"选错靶子"（注入点早于 `setJobRunIds`，突变体是空操作），另外 3 处按预期转红。
  ⚠️ 读侧派生投影（`freshness`）属 PR5 S3/S4。⇒ §14.2 `未覆盖` 由 2 项减为 1 项（只剩 A11）。

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
