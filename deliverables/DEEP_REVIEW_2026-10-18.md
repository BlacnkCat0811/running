# RAI 全项目深度审查（2026-10-18）

- 审查日期：2026-10-18（Asia/Shanghai）。
- 审查基线：git `HEAD 24aa7d8`（`fix(plan): 落地审查批次 A/B/C`），工作树干净；审查开始时与结束时产品代码均**零改动**（`git status` 仅新增本目录核验产物）。
- 审查对象：原生 SwiftUI iOS 客户端（`apps/ios`）、Node/Fastify API（`apps/api`）、16 个共享 TS 算法包（`packages/*`）、可选 Rust 数据执行器（`crates/rai-data-worker`）、Python 离线训练（`research/`）、部署模板与门禁/CI/文档。
- 审查方式：**5 个并行只读 lane**（数据管线 / 领域算法 / API 运行时与安全 / iOS 客户端 / 门禁·CI·文档）+ Lead 独立复跑关键基线 + Lead 对全部 P0/P1 与关键 P2 逐条交叉复核。分 lane 原始证据：
  [01 数据管线](deep-review-2026-10-18/01-data-pipeline.md)、
  [02 领域算法](deep-review-2026-10-18/02-domain-algorithms.md)、
  [03 API 运行时](deep-review-2026-10-18/03-api-runtime.md)、
  [04 iOS 客户端](deep-review-2026-10-18/04-ios-client.md)、
  [05 门禁·CI·文档](deep-review-2026-10-18/05-infra-gates.md)。
- 口径：P0 = 数据丢失/安全漏洞/生产不可用；P1 = 发布阻断或合同/安全语义被破坏；P2 = 用户可见错误行为或高概率边界缺陷；P3 = 低影响/防御性/文档/可维护性。每条结论标注证据等级（**E1** 已复现/已跑测试；**E2** 代码阅读并交叉核对；**E3** 代码阅读推断）。不把"跳过"写成"通过"。

---

## 0. 结论摘要

**分级计数：P0 × 0｜P1 × 0｜P2 × 11｜P3 × 42。**

**总体判断：在当前部署形态（单用户、单写者、自己的云 API + 自己的 iOS App）下，HEAD 24aa7d8 没有发现发布阻断项，可以继续按现状运行。** 上一轮训练计划专项审查的 3 个 P1 与 18 个 P2 在本轮复核中**仍然保持修复状态**；HEAD 大改（回执 v2 规范化、跨库 publication guard、读写一致性重试、Rust 增量账本 parity）在代码与实跑两层都成立，不是"测试绿但机制不存在"。

但本轮**不是"没有值得修的东西"**：发现 11 个 P2，集中在四个主题上，每个都建议排进修复批次：

1. **"未知"被悄悄替换成具体数字。** 缺失准备度被 0.7/0.6/0.45 的默认值静默惩罚（半马预测慢 6.1%），而响应仍报 `readiness=null`、证据码却写 `race_readiness_applied`（P2-04）；模型激活 gate 在分布指标全 `null` 时直接 `passed`，与 ALGORITHM §14「not_evaluable 不能按不是 failed 绕过」相反（P2-03）。这两项属于**算法合同语义被破坏**：若下一步是模型/预测发布，应在发布前按 P1 门槛处理。
2. **新机制只接在新路径上。** publication guard 只接进了 `training-plan-state` 与 coach-loop；聚合契约之外的 legacy 读路径仍未纳入（P3-01，本轮已把 Lane 1 的"iOS 仍走 legacy"判断复核纠正，见 §2.3）。同一套 `trainingPlanState` 里，inode/guard/`data_version` 检查都重试，唯独**主库 mtime** 变化直接抛 503，而 WAL checkpoint 只改 mtime —— 导入/重算期间计划读会间歇 503（P2-02，已实测 mtime 变化）。
3. **门禁的问题是"语义缺口"而不是"红绿"。** `check:doc-refs` 的内容漂移判据因仓库零基线而空转、却打印"内容漂移 0 处"（P2-07）；`check:package-boundaries` 只认双引号 import 与 `.ts/.tsx`（P2-08）；`npm test` 默认并发有作者实测的假红路径、旋钮却没进任何入口文档（P2-09）。五个门禁本身在 /tmp 突变下都能变红，**不是假绿**。
4. **文档口径滞后于两次产品变更。** 4 份现行文档仍把已删除的 `npm run build`/`test:e2e:web` 写成检查清单（P2-10）；ALGORITHM/DATA_PIPELINE 仍写「SQLite migrations 1–32」，实际已到 **v45**（P2-11）。

**修复顺序建议**：先做 5 个低风险、可当场验证的（P2-02 / P2-07 / P2-08 / P2-10 / P2-11 中的文档与门禁项，约半天）；再在下次模型/预测发布前做 P2-03 / P2-04 / P2-05（算法语义）；然后处理 P2-01（CLI 语义决策）、P2-06（iOS 补读份额）、P2-09（文档旋钮）；P3 按 §4 的表分批清理。

---

## 1. 本机基线验证（Lead 亲自执行）

环境：macOS（4 核），官方 Node `v24.21.0` + npm `11.19.0`（`onnxruntime-node` 可正常加载），Xcode 26.6，Rust 工具链在 `var/cargo`。

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| V1 | 类型检查 | `npm run typecheck` | **EXIT 0**（两个 project） |
| V2 | 全量 Node 套件 | `RAI_TEST_CONCURRENCY=2 npm test` | **EXIT 0**：tests **2038** / pass **2035** / fail **0** / skipped **3**，368 s |
| V3 | iOS 门禁（Lane 4 实跑，Lead 复核输出） | `npm run test:ios` | **EXIT 0**：94 个 Swift 文件类型检查（3 个仅依赖高德 SDK 的文件显式跳过）、**1132 条 PASS**、回归/结构门禁全绿（Lane 4 报告记 24 组，摘要另列 29 项） |
| V4 | §16.1 矩阵 | `npm run check:acceptance-matrix` | **80 条 / cited 80 / declared-gap 0 / missing 0**，EXIT 0 |
| V5 | 包边界 | `npm run check:package-boundaries` | **16 个包 / 31 条 src 边 / 禁线 4 条**，EXIT 0 |
| V6 | 文档链接 | `npm run check:docs` | **90 files / 615 links / 0 problems**（本报告与分 lane 文件、索引落盘后复跑；落盘前为 83/597） |
| V7 | 文档行号引用 | `npm run check:doc-refs` | 138 处 / 越界 0 / 漂移 0 / **锚在空行 7 处（告警）**，EXIT 0 |
| V8 | npm script 跨平台 | `npm run check:scripts` | 18 个 package.json / **104 条 script**，EXIT 0 |
| V9 | 仓库体积 | `node scripts/check-blob-size.mjs` | 1048 个已跟踪文件全部 ≤ 1 500 000 bytes |
| V10 | 生产冒烟 | `npm run smoke:api` | **Production API runtime smoke test passed** |
| V11 | Rust 执行器 | `node scripts/rust-worker.mjs verify` | **11/11 pass / 0 fail / 0 skip**，EXIT 0 |
| V12 | 生产依赖审计 | `npm audit --omit=dev` | **EXIT 1**：4 moderate（`sprintf-js` ← `roarr` ← `global-agent` ← `onnxruntime-node@1.22.0`） |
| V13 | 鉴权动态探针（隔离 API，临时库 + 随机端口，**不碰 var/**） | 无 token / 错 token / 对 token / 伪造 Host / 未鉴权写 | 无 token `/v1/health`=**401**、错 token=**401**、对 token=**200**、无 token `/v1/workouts`=**401**、`/v1/backups`=**401**、`/v1/openapi.json`=**401**、`Host: evil.example` 无 token=**401**、无 token `PUT /v1/mobile/goals`=**401**，全部符合预期 |
| V14 | WAL checkpoint 与 mtime（复核 P2-02） | 自写 `/tmp` 探针：建 WAL 库 → 插入 → `wal_checkpoint(TRUNCATE)` → `stat` | `inoSame=true`、`mtimeSame=false`（**确认 checkpoint 只改 mtime**） |
| V15 | 远端/平台边界 | `.github/workflows/ci.yml`、`git ls-files --eol` | 173 个 LF 固定文件全部 `i/lf w/lf`；仓库无 `.DS_Store`/Pods/DB 跟踪；**gitee 远端不触发 GitHub Actions**（仓库已在 README 注明） |

**关于 V2 的三点如实说明**：① 本轮用 `RAI_TEST_CONCURRENCY=2`（4 核）取得全绿，**没有**再跑一遍串行默认值；`scripts/run-tests.mjs` 头注释记录了 2026-10-12 默认并发在 6 核上出现 2 条时间预算假红的实测，该取舍仍然存在（见 P2-09）。② 3 个 skip 均为 Windows 语义（Windows 路径别名 / Windows 进程树 / 锁文件回滚），与历史记录一致。③ Lane 4 的 iOS 门禁与 Lane 1 的定向 Rust 测试是并行跑的，但两者断言均为逻辑断言，未见 flaky/重试痕迹；Lane 5 的定向门禁全部单独复跑。

---

## 2. 范围、方法与复核记录

### 2.1 lane 划分与产出

| lane | 范围 | 分 lane 报告 | 原始计数 |
|---|---|---|---|
| L1 数据管线 | health-export-parser / storage-sqlite / application 重算与发布 / import-* / direct-sync-* / Rust parity | [01-data-pipeline.md](deep-review-2026-10-18/01-data-pipeline.md) | P0 0 / P1 0 / P2 2 / P3 5 |
| L2 领域算法 | contracts / scoring / readiness / training-load / training-zones / features / physiology / normalization / durability / dynamics / prediction-inference / model-eval + transition gate | [02-domain-algorithms.md](deep-review-2026-10-18/02-domain-algorithms.md) | P0 0 / P1 0 / P2 4 / P3 6 |
| L3 API 运行时 | server.ts 路由/鉴权/错误语义/任务生命周期/读一致性/schemas↔契约↔iOS DTO | [03-api-runtime.md](deep-review-2026-10-18/03-api-runtime.md) | P0 0 / P1 0 / P2 1 / P3 8 |
| L4 iOS | Swift 并发/同步状态机/凭证/后台/缓存/WorkoutKit/UI/测试 | [04-ios-client.md](deep-review-2026-10-18/04-ios-client.md) | P0 0 / P1 0 / P2 1 / P3 9 |
| L5 门禁/CI/文档 | scripts / pre-commit / CI / deploy / docs 一致性 / 测试发现与跳过语义 | [05-infra-gates.md](deep-review-2026-10-18/05-infra-gates.md) | P0 0 / P1 0 / P2 4 / P3 11 |

### 2.2 本轮方法

- 每个 lane 只读：不改跟踪文件、不碰真实 `var/` 库与真实健康数据；合成库/探针一律在 `/tmp` 与 `mkdtemp`。
- 每项 P2 尽量给出"可重跑的命令/输出"，否则标注"代码阅读推断"；文档承诺不作为实现证据。
- Lead 独立复跑：`typecheck`、全量 `npm test`、`rust:verify`、五个文档/结构门禁、`smoke:api`、`npm audit`、鉴权动态探针、WAL mtime 探针。
- Lead 对所有 P2 逐条读对应源码/测试；对 lane 间冲突或可达性描述做**纠正性复核**（见 §2.3）。

### 2.3 Lead 交叉复核记录（含 1 条降级与 1 条重判）

| 复核项 | 复核动作 | 结论 |
|---|---|---|
| **L1-02 被降级为 P3-01** | 读 `apps/ios/RAI/TrainingPlanStore.swift:241`、`TrainingPlanRepository.swift:39-53` 与 `apps/api/src/server.ts:947-955` | 当前 iOS **优先**使用 coach-loop 契约（服务端无条件宣告 `coachLoopContractVersion: 1`），其次是 `planSnapshotContractVersion` 聚合契约；legacy 三读（goals+today+workout-plan）只在"旧服务端/未宣告新契约"时可达。Lane 1 报告称"iOS 仍走这条 legacy 对"**不成立**，故从 P2 降为 P3-01（残余兼容面），并保留"若现场仍有旧客户端则为 P2"的条件 |
| P2-02（A1/L1-06）双 lane 命中 | 读 `apps/api/src/data.ts:641-648`、`read-store-manager.ts:76-100`；跑 V14 mtime 探针 | 两个 lane 独立发现同一问题；`trainingPlanState` 对 `mtimeMs` 变化 `throw 503`（同函数 inode/guard/`data_version` 都 `continue`），且 checkpoint 实测只改 mtime ⇒ **成立，P2** |
| P2-03（D-04） | 读 `model-transition-gate.ts:197-320,345`；核对 lane 2 探针输出 | `exceeds(null, limit) === false` 且 null 不产生 `notEvaluableReason`；同标尺五项指标全 null 时 `status=passed / blocksActivation=false` ⇒ **成立，P2（高优先）** |
| P2-04（D-02） | 读 `physiology/src/index.ts:117-125,944-947,1019-1021,1053`、`prediction-report.ts:185-191,266-269`、`prediction-data.ts:581-590` | `?? defaultRaceReadiness` 会把 `null` 也替换成默认值；`readiness[distance] === undefined` 才给 `endurance_readiness_unmodeled`，而生产传的是 `{five_k:null,…}` ⇒ 证据码谎报 `race_readiness_applied`、method 变成 readiness_v2；默认值 0.7/0.6/0.45 在 docs 中无记载 ⇒ **成立，P2（高优先）** |
| P2-05（D-01） | 读 `readiness/src/index.ts:24,105,114,224,295`、`recompute-pipeline.ts:3645-3647` | streak 用硬编码 `0.8`，单夜用 `READINESS_SLEEP_RATIO_THRESHOLD=0.75`，0.8 还在 pipeline 重复一份；三夜 0.78 得到 `multiple_low_signals` 而 `sleepLow=false` ⇒ **成立，P2（口径不一致）** |
| P2-01（L1-01） | 读 `apple-health-parser.ts:221-228,596-600`、`cli.ts:363-366`、`database.ts:3508-3513` | 无 sample UUID 时 record id 含 value/unit；`preserveAbsent` 增量只写 inserted/updated、不删缺席；两条 API 直连车道强制 UUID ⇒ 只影响 CLI legacy 增量 ⇒ **成立，P2（可达性有限）** |
| P3 中的 D-03 | 读 `contracts/src/index.ts:981-1000` | `NaN < 0 || NaN > 1` 均为 false、`distanceKm`/日期完全不校验 ⇒ **成立，但按"防御性缺口"重判为 P3**（不改变建议：应补断言） |
| L5-F1 / F3 / F6 / F10 / F15 | 读 `check-doc-line-refs.mjs`、`check-package-boundaries.mjs`、`check-doc-links.mjs`、`check-node-version.mjs` 与默认文档清单；核对仓内 8 处单引号 import、0 份 `.linerefs.json` | 全部成立；门禁在 /tmp 突变下的红/绿反应与报告一致 |
| L5-F14 / P2-11 | 对比 `PROJECT_REVIEW.md:102`、`README.md:71` 与门禁输出；读 `database.ts:1648-1695` | 15/30/54 是 2026-09-30 历史值（节标题已写"历史保留"，P3）；但 ALGORITHM/DATA_PIPELINE 的「migrations 1–32」在**现行合同**里，实际 v45 ⇒ **P2** |
| L4-I7（P2-8 残留） | 读 `NativeAppModel.swift:345-359` | `decodingOnly` 只排除 `.failure`，`.validation` 被算进"契约漂移"；混合失败时先命中 validationOnly、但"部分校验失败+部分解码失败"会落到解码文案 ⇒ **成立，P3（上一轮 P2-8 的唯一残留）** |
| A8（跨 lane） | 读 `PlanMutationDisposition.swift:32-52`、`server.ts:409-421` | `coach_loop_contract_required` 是 legacy 计划写/回执在 managed 数据集可收到的 409，但不在客户端终局码集合里 ⇒ **成立，P3**（manife分数据集需新版 App 明确接管，旧版会停在"可重试"） |

**未能复核/保持未验证的项**：真机 HealthKit/后台唤醒、配对 Watch、Simulator 视觉验收、真实 325 MB 库的迁移/备份/恢复演练、Windows 运行时、线上 gitee CI、真实并发压测——均列入 §8。

---

## 3. P2 详情（11 项）

### P2-01（原 L1-01）无 sample UUID 的记录「值更正」在 `preserveAbsent` 增量下重复事实

- **位置**：`packages/health-export-parser/src/apple-health-parser.ts:221-228`（无 UUID 时 record id 含 `value`/`unit`）、`:596-600`（`shouldWrite` 只看 inserted/updated）、`packages/health-export-parser/src/cli.ts:363-366`（增量默认 `preserveAbsent: true`）、`packages/storage-sqlite/src/database.ts:3508-3513`（只有完整快照语义才删除缺席实体）。
- **证据（E1，Lane 1 合成探针）**：同一 XML 只把 `value="2000"` 改成 `"2100"`，第二次以 `incremental + preserveAbsent` 解析后：库里同一时间窗出现 **2 条 record**（`2000` 与 `2100`），账本只有 1 条 `inserted`，**没有 `removed`/`updated`**。
- **可达性**：两条生产上行车道（`direct-sync-ingest.ts:794`、`data-only-import.ts:152`）都传 `healthKitRecordIdentity: true`，无 UUID 会直接抛错，不会命中；命中的是 CLI legacy 增量（README 未把它列为常规入口，但仍是一等脚本）。
- **影响**：同一时间窗的步数/能量/心率样本被双计，且脏范围账本不知道旧行应被替换，重算后旧值仍在。不是 iOS 上行链路的缺陷。
- **建议**：三选一并写进 DATA_PIPELINE §2：① CLI 增量对"同 type/source/start/end、仅内容不同"的旧身份显式 supersede（账本 `removed` + 墓碑）；② 或把 legacy 增量限定为 `healthKitRecordIdentity`（无 UUID 导出拒绝，提示走完整重建）；③ 或明确接受该边界，并在 `data:audit` 输出"同窗重复 record"计数让运维看得见。

### P2-02（原 L1-06 / A1）`trainingPlanState` 把主库 mtime 变化直接抛 503，而 WAL checkpoint 只改 mtime

- **位置**：`apps/api/src/data.ts:641-648`（`fileIdentity.ino !== currentFile.ino || fileIdentity.mtimeMs !== currentFile.mtimeMs` ⇒ `throw PlanOperationError(..., 503)`）；对照 `apps/api/src/read-store-manager.ts:76-100`（同一仓库另一处明确只按 **inode** 判失效，注释写明 mtime 会因 checkpoint 变化）。
- **证据（E1）**：Lane 3 在 /tmp 合成库上实测 `wal_checkpoint(TRUNCATE)` 后 `ino` 不变、`mtime` 变化（Δ8.4 ms）；Lead 用独立探针复现 `inoSame=true / mtimeSame=false`。同函数里 `currentFile === null`、guard 变化、`data_version` 变化都走 `continue` 重试，唯独 mtime 分支是一次性抛错。
- **影响**：导入/重算正在写主库时，`GET /v1/mobile/training-plan-state` 会**间歇 503**（`plan_snapshot_changed`），客户端要重新退避重读；这不是发布，也不是数据不一致。因为该分支不重试，单次 checkpoint 就可能让一次读直接失败。
- **建议**：主库"是否被替换"只看 inode（与 `read-store-manager.ts` 同口径），或该分支改为 `continue` 重试；若要保留 mtime，必须区分"checkpoint 导致的 mtime 更新"与"rename 换文件"（前者 inode 不变）。

### P2-03（原 D-04）同标尺 transition gate 在分布指标全 `null` 时直接 `passed`

- **位置**：`packages/storage-sqlite/src/model-transition-gate.ts:197-320`，核心 `const exceeds = (value, limit) => value !== null && value > limit;`（`:345`）；`blocksActivation = status !== "passed"`（`:313`）。
- **证据（E1，Lane 2 探针）**：同 schema/同版本、`matchedSessions: 12`、五个分布指标全 `null` 时：`status=passed`、`blocksActivation=false`、`failureReasons=[]`、`notEvaluableReasons=[]`。可达性：`model-run-repository.ts:295-303` 的 `absDeltas` 只 join 两侧 `current_ability` 都非 NULL 的行；全部 trial/excluded 的评估会产生"配对数 >0 但 CA 差值不可算"。
- **影响**：ALGORITHM §14 明写"not_evaluable 是正式状态，不能按'不是 failed'绕过激活"。这里"算不出来"与"在阈值内"共用 `false`，等于把未评估当合格来激活同标尺模型。空数据集（`emptyCohort` 已证明）是另一条合法分支，不受影响。
- **建议**：同标尺下把"比较所需指标为 null"显式加入 `notEvaluableReasons`（保留 `emptyCohort` 例外）；为 `matchedSessions>0 + CA 全空` 补一条 gate 单测；若确实有"null = 不适用"的语义，需像 `recoveryIsolationHolds` 那样给出区分字段。

### P2-04（原 D-02）缺失准备度被默认值静默惩罚，且 trace 谎报「已应用」

- **位置**：`packages/physiology/src/index.ts:117-125`（`defaultRaceReadiness` 0.7/0.6/0.45、罚分 3/4/6 个 VDOT）、`:945-947`（`readiness[distance] ?? default`）、`:1016-1020`（`readiness[distance] === undefined` 才给 unmodeled，否则 `race_readiness_applied`）、`:1053`（method 变 `daniels_vdot_readiness_v2`）；生产装配 `packages/application/src/prediction-report.ts:185-191,266-269` 与 `prediction-data.ts:581-590`。
- **证据（E1，Lane 2 探针 + E2 生产路径）**：VDOT 50 下：`{}`（缺失）→ five_k 1215 / ten_k 2550 / half 5825，`readiness=null`、`readinessStatus=insufficient_data`，但半马比 `readiness=1` 慢 **334 s（+6.1%）**；显式 `null` 更糟——输出 `race_readiness_applied` + `race_readiness_low` + `method=daniels_vdot_readiness_v2`，数值仍是默认罚分。三个默认值在 docs 中**没有任何记载**。
- **影响**：只录成绩不记训练、受伤/停训后回来、导入历史全部超出 56 天窗口时，`current_prepared` 预测系统性偏慢且距离越长越悲观——正是 ALGORITHM §8 / D01 想禁止的"缺历史完整性当作低准备度"，只是发生在预测数值层。训练特征 `buildRaceResidualFeatureValues` 也会把 `readiness:null` 与含默认罚分的 `logPredictedSeconds` 一起喂给 ML，特征与目标口径不一致。
- **建议**：二选一并写进 ALGORITHM §11：① 缺失时按 `neutral_potential` 处理（`readinessValue=1`，只给 unmodeled 码）；② 保留默认值但显式命名/文档化，并在响应中把"默认值参与计算"作为独立字段暴露。无论哪种，`readiness===null` 时不得输出 `race_readiness_applied`/`race_readiness_low`/`daniels_vdot_readiness_v2`；并在 `assertPhysiologyPredictionSnapshot` 加不变量（`readiness===null ⇒ readinessAdjustmentSeconds===null`）。

### P2-05（原 D-01）恢复「连续坏夜」门槛 0.80 与单夜门槛 0.75 不一致且重复三处

- **位置**：`packages/readiness/src/index.ts:24`（`READINESS_SLEEP_RATIO_THRESHOLD = 0.75`）、`:105`（单夜 sleepLow 用它）、`:295`（连续夜硬编码 `>= 0.8` 即 break）、`:114`（streak 阈值 3）；`packages/application/src/services/recompute-pipeline.ts:3646-3647` 再重复一份 `* 0.8`。
- **证据（E1，Lane 2 探针）**：今天 sleep ratio 0.95，前三夜各 0.78 ⇒ `coverage=complete`、`assessment=multiple_low_signals`、`sleepStreak=true`、`signals.sleep.low=false`，`reasonCodes=[sleep_streak]`。
- **影响**：三夜 78% 睡眠（按文档口径"不算低"）即可把当天恢复判成 `strained`、下游 `physState=depleted`，而信号面板显示"睡眠不低"，结论与信号自相矛盾。方向保守（多降不升），不是安全问题；但属于用户可见的判断口径错误，且与 ALGORITHM §7「兼容阈值：sleep ratio 0.75 … 连续差睡眠 3 夜」不自洽。
- **建议**：把"连续坏夜"定义收敛到一个导出常量（复用 0.75，或新增 `READINESS_STREAK_SLEEP_RATIO_THRESHOLD` 并写进 §7）；`recompute-pipeline` 改引用同一常量；补一条 `0.75 ≤ ratio < 0.80` 的回归锁住口径（否则这次修改可能只是把行为换个方向）。

### P2-06（原 I1）iOS 跑步动态迟到样本补读不设批内份额，可吃光整批预算并饿住 anchor 流

- **位置**：`apps/ios/RAI/HealthKitExport.swift:1364-1398`（补读只用 `budget.accepts` 全量预算）；对照同文件 `:1499-1503`（窗口 pass 有 `recentWindowShare` 20% 独立份额）；`HealthKitRecordCursor.swift:242`（单类型补读上限 1500）；`DirectSyncBatchBudget.swift:52-58`（保守预算 1.8 MiB / 4500 条）。
- **证据（E2，Lane 4 代码+交叉核对；Lead 复核了执行顺序）**：补读循环排在窗口 pass 与 anchor 循环之前；4 类动态 × 1500 条可超过 4500 条批上限，一页装得下就会写出并消耗预算；装不下的页 `continue` 不记账、下一批重试。
- **影响**：高密度跑步动态用户升级后的若干批里，预算被补读吃光，心率/睡眠/步数等 anchor 流零进展并报 `.recordNone`；自限（每类型只补一次 + 14 天窗口），不丢数据，表现为"同步变慢/其它类型被饿"。
- **建议**：补读也受 `recentWindowShare` 约束，或把补读挪到 anchor/窗口循环之后；若保留"补读优先"，至少给 anchor 流保留固定比例并在 `budgetStopReason` 里区分"被补读占用"。可把 `writeGlobalRecords` 的预算裁决顺序抽成纯函数（与 `RecordReplayPlan` 同手法），否则 I2/I3 也无法被现有回归抓住。

### P2-07（原 F1）`check:doc-refs` 的「内容漂移」判据空转，却无条件打印「内容漂移 0 处」

- **位置**：`scripts/check-doc-line-refs.mjs:25-34`（自述两道硬失败）、`:203-210`（读不到 `<doc>.linerefs.json` 即 `baseline=null`）、`:238-242`（只在基线存在时比较）、`:283-289`（汇总行无条件打印）。
- **证据（E1，Lane 5 /tmp 突变）**：仓内 `git ls-files '*.linerefs.json'` = 0、`docs/*.linerefs.json` = 0、也未 ignore；夹具中写基线后改源文件行 ⇒ **EXIT=2** 且打印"🟡 内容已漂移"；删掉基线再改 ⇒ **EXIT=0** 且仍打印"内容漂移 0 处"。
- **影响**：`check:doc-refs` 全绿会被读成"行号引用已核验"。脚本头部记录的 2026-09-24 事故（`HealthKitSync.swift:506-519` 内容已漂到 `:717-726`）这类"不越界但内容换人"的漂移，**当前没有任何门禁能发现**。与"脚本跑绿 ≠ 门禁存在"是同一类问题。
- **建议**：对默认范围执行一次 `--write-baseline` 并提交生成物；或至少在汇总行区分"未核对（无基线）"与"已核对 0 漂移"，否则默认输出就是误导。

### P2-08（原 F3）`check:package-boundaries` 可被引号风格/扩展名绕过

- **位置**：`scripts/check-package-boundaries.mjs:97`（`/\.tsx?$/`）、`:121`（`from\s+"@rai\/([a-z-]+)`）、`:138`（`from\s+"[^"]*\/apps\/`）。
- **证据（E1，Lane 5 /tmp 夹具突变）**：向 `packages/scoring/src` 写同一条违反边——双引号 ⇒ 多 2 条红（具名禁线 + 未声明边）；**单引号 ⇒ 0 条新增红**；`.mts` 文件（双引号）⇒ 0 条新增红。仓内 `packages/application/src` 已有 **8 处**单引号 `from '@rai/...'`，说明单引号是现实风格。宽正则重扫全仓当前**没有**实际违反。
- **影响**：这条门禁是"scoring 不得 import readiness"等 P0 架构不变量的**唯一**执行者；用单引号写一行 import 即可让不变量失守且 typecheck/test/pre-commit 全绿。
- **建议**：正则改为匹配单/双引号 + 动态 `import()`；扩展名改为 `/\.[cm]?tsx?$/`；对 `export … from`/`import type` 无需特判（都含 `from`）。改动很小，收益是把"格式选择"从绕过手段里去掉。

### P2-09（原 F4）`npm test` 默认并发有已知假红路径，但 `RAI_TEST_CONCURRENCY` 不在任何入口文档

- **位置**：`scripts/run-tests.mjs:41-61`（头注释记录 2026-10-12 控制变量实测：同代码默认并发 EXIT=1、`--test-concurrency=1` EXIT=0；`worker` 5 s/`data-only` 30 s 墙钟预算）；`README.md:36-54`、`AGENTS.md` 的 Default Verification 只写 `npm test`。
- **证据（E1/E2）**：Lead 本轮 `RAI_TEST_CONCURRENCY=2 npm test` 全绿（2038/2035/0/3），未复现假红；脚本注释的"6 核默认并发会红"是作者 2026-10-12 的实测记录，属于已知取舍而非本轮新事实。旋钮校验本身是严格的（`"0"`/`" 2"`/`"0x2"` 全部抛错）。
- **影响**：README 让人执行的"验证"命令在 6 核机器上有明确记录的假红路径；假红的代价是**训练人不信任红**，与 F1 的"假绿"是同一枚硬币。任何人跑出红都要先怀疑环境，而不是代码。
- **建议**：README/AGENTS 的 `npm test` 行加一句"高负载/多核机器建议 `RAI_TEST_CONCURRENCY=2 npm test`（见 `scripts/run-tests.mjs` 头注释）"；发布记录写明所用并发。把默认并发有界化是项目决策，脚本注释已说明不该顺手改。

### P2-10（原 F2）4 份**现行**文档仍把已删除的 Web 门禁写成「基本检查/发布清单」

- **位置**：`docs/IOS_SYNC_PERFORMANCE_REVIEW.md:622`、`docs/IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN.md:515-516`、`docs/IOS_SYNC_RECHECK_FIX_PLAN_2026-10-17.md:376`、`docs/SQLITE_DIRECT_SYNC_DESIGN.md:587-588`。
- **证据（E1）**：`package.json` 的 104 条 script 中**不存在** `build`/`test:e2e:web`；AGENTS.md 与 DECISIONS D17 明令禁止加回；同批 D17 后的其他文档（训练计划 3 份、COACH 状态）已就地标「历史项/已删除」，这 4 处漏了。三份 fix-plan 由 README 文档表作为**现行入口**链接（`README.md:76-78`）。
- **影响**：按"基本检查/发布检查清单"逐条执行的人会撞上 "Missing script"，可能怀疑门禁缺失或自行把脚本加回（D17 明令禁止）；`check:docs`/`check:doc-refs` 不会因此变红。
- **建议**：对这 4 处做与训练计划文档相同的就地标注（一行 🔴「D17 后已删除」），或删除这两句；若要防复发，可在现有文档检查里对"现行文档中的退役脚本名"做白名单扫描（历史章节显式豁免）。

### P2-11（原 Lead L-01）ALGORITHM/DATA_PIPELINE 仍写「SQLite migrations 1–32」，实际已到 v45

- **位置**：`docs/ALGORITHM.md:19`（"本轮代码为 … SQLite migrations 1–32"）、`docs/DATA_PIPELINE.md:55`（"定义migrations 1–32"）；实际迁移注册表 `packages/storage-sqlite/src/database.ts:1690-1695`（v40–v45；数组自 v23 起连续）已到 **version 45**（HEAD 的 v41–v45 为 training_metric checkpoints / analysis job merge / readable route view / coverage evidence / batch dirty evidence）。
- **证据（E1）**：迁移数组逐项枚举；含 v36–v45 的最新 10 个版本；`docs/IOS_SYNC_RECHECK_FIX_PLAN_2026-10-17.md` 与 `deliverables` 已记录 v45 的落地。ALGORITHM.md 维护日期 2026-10-11、DATA_PIPELINE 同批，均早于 v37→v45。
- **影响**：这两份是"现行合同"文档；运维/后续审查按"1–32"判断数据库代次会得出错误结论（例如误判某个 v33+ 库"超前"），也与 D3「每迁移冻结 checksum」的现行范围不一致。
- **建议**：改为引用迁移注册表（"see database.ts MIGRATIONS；当前 45"）而不是写死数字，或在每次加迁移的同一 PR 更新；补进 `check:doc-refs`/文档一致性检查范围（数字型断言最好由测试或脚本生成）。

---

## 4. P3 汇总（42 项）

> 分组按 lane；均已在对应分 lane 报告中有详情与 file:line。P3 是低影响/防御性/文档项，不阻塞当前使用，建议按批次清理。

### 4.1 数据管线（Lane 1，5 项）

| ID | 原 ID | 结论 |
|---|---|---|
| P3-01 | L1-02（**由 P2 降级**） | `/v1/mobile/today`、`/v1/mobile/workout-plan` 先读 control 再开主库读事务，未接 guard/`readStableSnapshot`（`server.ts:1381-1387,1408-1412`）。当前 iOS 优先 coach-loop/聚合契约，legacy 三读只在旧服务端/旧客户端组合可达；若现场仍有旧客户端应升 P2 |
| P3-02 | L1-03 | guard 读取抛错时 `readSnapshotGuardSafe` 返回 null，跨库检查整体跳过（fail-open 降级）；注释与测试把它当既定契约（`plan-read-consistency.ts:88-97`） |
| P3-03 | L1-04 | 本进程处于自己发布事务时 `planReadGuard` 返回 `undefined`（epoch 检测一并关闭），对外来"已提交 marker 且已换主库"的发布者存在理论盲区（`plan-read-consistency.ts:55-86`、`mobile-goals.ts:325-343`） |
| P3-04 | L1-05 | TS↔Rust parity 测试第三次解析（`unchanged`）不带 batchId ⇒ "未变更不误报 updated"未被断言；缺 Rust 二进制时整文件静默 skip（`native-worker.test.ts:15-16,99-105`） |
| P3-05 | L1-07 | `review:model-boundaries`（R1–R3）不在 CI、不在 `npm test`；裸 `node` 跑 `.mts` 会 `ERR_MODULE_NOT_FOUND`（经管道可能看成 exit 0）；应改为用 `tsx` 并在发布清单里保留 |

### 4.2 领域算法（Lane 2，7 项）

| ID | 原 ID | 结论 |
|---|---|---|
| P3-06 | D-03（**由 P2 重判**） | `assertWorkoutFeatureVector` 放过 NaN `qualityScore`/`sourceConfidence`、Infinity `distanceKm`、非法 `workoutStartAt`（`contracts/src/index.ts:981-1000`）；属防御性缺口，上游回归时失败点离坏数据很远 |
| P3-07 | D-05 | 个人区间展示闸门 `assertPersonalIntervalPresentation` 无生产调用点（只在 model-eval 测试里），生产直接透传 `fitPersonalInterval`（`model-eval/src/index.ts:1165`、`data.ts:1889-1905`） |
| P3-08 | D-06 | `heartRateZoneFor` 接受 0/负心率（0 bpm 记为 recovery 并计入覆盖率）；`analyzeWorkoutZones` 只过滤速度样本（`training-zones/src/index.ts:364-366,706-713`） |
| P3-09 | D-07 | §16.1 N02 的"随坡度单调"在 −20%…−45% 不成立，而测试只采样 −6…10%；文档口径超出实测域（`physiology/src/index.ts` 等速配速、`grade-adjustment.test.ts`） |
| P3-10 | D-08 | TA 拒绝归因（9 种 `TrueAbilityUpdateRefusal`）未落库：生产调用方丢弃 `refusalReason`，数据库无法回答"为什么没更新 TA"（`scoring/src/model.ts:623-652`、`recompute-pipeline.ts:3897-3963`） |
| P3-11 | D-09 | 条件责任账本的 `location`（文件:函数）不校验函数是否存在，也没有"实际施加点 ⊆ 账本"的运行期检查；P02 仍靠人工评审（`normalization/src/index.ts:289-352`） |
| P3-12 | D-10 | 两套语义 JSON 排序并存：`plan-digest.ts:61-62` 用 `localeCompare(...,"en")`，`contracts/semantic-json.ts:75-84` 用码元排序；目前不互通所以不是缺陷，但给"同一内容两个摘要"留了坑 |

### 4.3 API 运行时（Lane 3，8 项）

| ID | 原 ID | 结论 |
|---|---|---|
| P3-13 | A2 | 匿名只读集合未随 D17 收敛：`/v1/mobile/{today,coach-loop,coach-execution,workout-plan,goals}` 仍在 `publicReadRoutes`，而同域的 `training-plan-state`/`run-coach` 需 token；默认空 Host + 部署模板空 ⇒ 仅 opt-in 风险，但与 `deploy/rai.env.example` "公开的只有健康数据读接口"文案不符 |
| P3-14 | A3 | guard 遗留 `pending_since` 无启动清扫：崩溃/endMarker 失败后重启最多 120 s 计划读 503（fail-closed 方向，可接受但应清除） |
| P3-15 | A4 | guard 读重试 3 次无退避（立即 3 次后 503）；`/synced` 在 control 写事务内跑整份主库快照，拉长 pending 窗口；压力夹具下 503 占比 63–69%（测试本身声明只报告不断言） |
| P3-16 | A5 | `apiErrorPayload` 把白名单外 5xx 全压成 `internal_error`：`restore_recovery_required`(503)、`plan_operation_status_unknown`(500) 的码与文案被吞，与 `plan-publication.ts:19-24`"有可诊断的码"矛盾 |
| P3-17 | A6 | OpenAPI 漂移：`GET /v1/handshake`、`GET /v1/recovery-trends` 已挂载/已分类但不在 `openapiDocument.paths`；现有门禁只覆盖写路由（`schemas.ts:828`、`server.ts:947,1583`） |
| P3-18 | A7 | `POST /v1/backups` 在 `databaseRequiredMutationRoutes` 里，无库时先 409 `database_not_ready`，到不了设计中的 410；同族 `DELETE /v1/backups/:name`（lockOnly）可达 410（`server.ts:335-353,2053-2058`） |
| P3-19 | A8 | `coach_loop_contract_required`(409) 不在 iOS `terminalPlanReceiptErrorCodes`/`terminalPlanPublicationErrorCodes` 里：managed 数据集上的 legacy 排期回执会永久"可前台重试"（服务端 `server.ts:409-421`、客户端 `PlanMutationDisposition.swift:32-52`） |
| P3-20 | A9 | 全库备份下载 `GET /v1/backups/:name` 缺 `Cache-Control: no-store`；`content-disposition` 直接拼请求参数名（`server.ts:2060-2065`） |

### 4.4 iOS 客户端（Lane 4，9 项）

| ID | 原 ID | 结论 |
|---|---|---|
| P3-21 | I2 | 空窗水位永不推进 ⇒ 重放期间每批对每个空类型重复一次 48 h 查询（无界重试，靠 30 天兜底）；方向正确，代价未在注释写明（`HealthKitExport.swift:1519-1530`、`HealthKitRecordCursor.swift:215-224`） |
| P3-22 | I3 | 补读分页下界按**当前** `now` 重算 14 天窗 ⇒ 多批补读时窗口前缘漂移，最老一小段被永久跳过却记"已完成"（`HealthKitExport.swift:1371-1372,1404,1412`） |
| P3-23 | I4 | **建议优先**：同一段代码两条矛盾注释（"空结果同样记账" vs "空页不记账"），而后者正是 2026-10-14 永久缺失事故的修复语义；后人按注释改代码会重开缺陷（`HealthKitExport.swift:1358-1359` vs `:1424-1428`） |
| P3-24 | I5 | "该有却没有"告警只在 `needsHistoryRead` 期间可达；稳态（事故当时状态）恒不触发（`HealthKitExport.swift:1467-1470,1546-1556`） |
| P3-25 | I6 | `PlanReceiptMatcher.planTimeZone` 对坏时区静默回落 UTC+8，且用于撤回残留的**身份比较**（`PlanReceiptMatcher.swift:54-56`、`PlanWatchScheduling.swift:290-291,325-326`）；建议改 Optional + fail-closed |
| P3-26 | I7 | 上一轮 P2-8 残留：`decodingOnly` 只看 `!= .failure`，未排除 `.validation` ⇒ 混合失败仍提示"请升级应用"（`NativeAppModel.swift:345-359`） |
| P3-27 | I8 | 摘要算不出时 v2 回执**静默降级** v1，无诊断码；服务端接受（`NativeAppModel.swift:1626-1631`、`mobile-goals.ts:679,690-705`） |
| P3-28 | I9 | `RaiRetryAfter` 夹取 `0...5` 也用于 429 用户文案；当前服务端只发 1/5，属潜在（`APIClient.swift:117-126,433-441`） |
| P3-29 | I10 | 游标/补读 python 判据是**源码子串**检查、`MIN_CHECKS` 自报常数；行为只由 45 条纯逻辑回归兜（`check-healthkit-record-sync.py:261-282,327`）；本轮因只读未做突变验证 |

### 4.5 门禁 / CI / 文档（Lane 5，11 项）

| ID | 原 ID | 结论 |
|---|---|---|
| P3-30 | F5 | `check:acceptance-matrix` 只按测试**标题字符串**判 cited：空断言 `test("C03 …", () => {})` 即可让新验收项变绿（`check-acceptance-matrix.mts:91-109`） |
| P3-31 | F6 | `check:doc-links` 不校验 `#anchor`；且把行内代码里的链接示例当真实链接（假阳性）（`check-doc-links.mjs:25-29`） |
| P3-32 | F7 | 测试发现只收 `packages/*/test`、`apps/api/test` **顶层** `*.test.ts`：`.test.mts/.js/.tsx` 与子目录会被静默漏跑（当前 257/257 全覆盖，但无门禁保证） |
| P3-33 | F8 | `deliverables/README.md:4-7` 的「当轮审查（未提交改动）」含 **33 份已提交**文档，多份自述"收尾后并入或删除"却跨 8 天未收尾；本轮新增条目后总数继续增加，建议按约定归档 |
| P3-34 | F9 | `deploy/n100/nginx-rai.conf:53-55` 仍 catch-all 反代 `location /`，与主模板/D17「只反代 /v1、根路径 404」不一致；`/robots.txt` 行为也不同，且无门禁钉住 n100 的 location 集合 |
| P3-35 | F10 | `check-node-version.mjs:10-12` 的放行依据仍引用已退役的 Web 证据（Web vitest 25 文件 184 条、`npm run build` 成功），D17 后不可复验 |
| P3-36 | F11 | CI 的现实覆盖为零：GH Actions 不被 gitee 触发（已明示）、`master-ci.yml` 是未启用草案、matrix 只覆盖 Node 22.x（开发机 24.x）、Windows job 跑默认并发全量 `npm test` |
| P3-37 | F12 | `npm audit --omit=dev` 报 4 moderate（`sprintf-js` ← `roarr` ← `global-agent` ← `onnxruntime-node@1.22.0`）；DoS 需攻击者控制格式串，实际可达性低；修复需越过声明依赖区间 |
| P3-38 | F13 | README「检查」段与 pre-commit 实际清单不一致：漏列**blob 体积闸门**（每次提交都跑）与 storage-sqlite 表分类门禁（`README.md:52` vs `.githooks/pre-commit:12,100-108`） |
| P3-39 | F14 | `PROJECT_REVIEW.md:102` 的历史数字（matrix 54 / 15 packages / 30 edges）与当前 80/16/31 并置，`README.md:71` 又把该文档标为"当前审查结果"；节标题虽写"历史保留"，仍易被引用旧值 |
| P3-40 | F15 | `check:doc-refs` 默认范围仍不含 `deploy/README-UBUNTU.md`（脚本自述"待补"）、`docs/DECISIONS.md`、`docs/HEALTHKIT_RECORD_SYNC_V2.md` 等现行文档；显式补跑当前 5 处 0 越界，但漂移时没有门禁变红 |

### 4.6 Lead 追加（2 项）

| ID | 结论 |
|---|---|
| P3-41 | `docs/OPERATIONS.md:115-125` 有一段 5 条 bullet 的**整块重复**（同内容出现两次），读起来像两个不同约束；建议删一份 |
| P3-42 | 口径措辞：`AGENTS.md`「HealthKit 只读」与 `apps/ios/RAI/Info.plist:25-26` 的 `NSHealthUpdateUsageDescription`（用于 WorkoutKit 排期到 Apple Watch 的「体能训练」写权限，不写健康样本）容易互相误读；建议在 AGENTS/DECISIONS D6 加一句限定"只读指健康样本；WorkoutKit 排期需要 workout 类型写授权，不写/不改健康记录"。**本轮未改代码**（该声明与行为均早于本轮，不是新违规） |

---

## 5. 已核实「无问题」清单（防止后续重复排查）

以下结论来自各 lane 的核对与实跑，本轮**没有**发现反例：

1. **恢复隔离（D4/F01–F02）成立**：`packages/scoring/src/**` 对 readiness/sleep/hrv/rhr 引用数为 0；`features/src/v4.ts` 把恢复字段置 null 并过滤 `recovery_data_missing`；端到端 `recovery-isolation-e2e.test.ts` 从原始事实装配断言。
2. **null ≠ 0 / 未校准不罚分成立**：`evaluateConfidenceV2` 区分 null（insufficient_evidence）、真实 0、非有限（抛错）；`modelConfidence/overall` 恒 null 且带 `not_calibrated`。
3. **连续学习率与负向确认成立**：`alpha(N)=0.04+0.11·e^(−N/25)` 无分段跳变；负残差需连续 2 次确认，pending 通过 checkpoint 持久化。
4. **个人/人群门槛不混用成立**：50·8 与 24·4 是两条通道，激活判据同一套；scope 随 artifact manifest/run 双向校验；旧行无 scope 按 population 解释。
5. **手工成绩标签时点成立**：`labelAvailableAt = recordedAt`，撤销是墓碑；手工成绩只作标签/校准，不生成轨迹、不改 CA/TA。
6. **个人区间禁人群词汇成立（类型层）**：`PersonalIntervalEvidence` 无 `nominalCoverage/coverageP80/P90`，`coverageClaim` 为固定字面量，低于地板返回 null（运行期闸门缺调用点见 P3-07）。
7. **ONNX 工件校验与 HEAD 懒加载成立**：manifest 强制 scope/三方 sha256/feature schema hash/特征名逐字相等/correction cap；懒加载失败抛错不静默降级；prediction-report 落显式 fallback 码。
8. **回执 v2 线格式与跨语言摘要成立**：非教练闭环也写显式 null warmup/cooldown/alert；TS/Swift 处方摘要逐字节一致（含 half-up micro、-0、1e9 边界、跨语言 fixture 回归）。
9. **publication guard 协议成立**：marker 先提交、读写前后 epoch/lease 校验、跨进程压力测试 3 次 violations=0、settled 读 400/400；`/synced` 的 matchesCurrent 与回执写入同事务。
10. **Rust 执行器边界成立**：写许可要求 `.importing.<uuid36>` 后缀 + 64 hex permit + source 只读 + output `create_new`；TS↔Rust 增量账本 parity（HEAD 刚修的 before 侧字段）经 lane 1 独立负向控制验证，能抓住 previous_type 变 NULL 的回归；`rust:verify` 11/11。
11. **iOS 凭证与网络边界成立**：Keychain 仅 `AfterFirstUnlockThisDeviceOnly`、token 不进日志；Release 强制 https、ATS 无 arbitrary loads；continuation 单次 resume、后台 upload 双表拆分正确；BGTask id 与 Info.plist 一致。
12. **鉴权矩阵成立**：读路由"公开/需 token"双向分类门禁由 `server-runtime.test.ts` 用真实 mounted route 对账；Lead 的隔离实例动态探针（V13）与 lane 5 的生产语义探针（根路径/assets/robots 404、无 token 401）均符合预期。
13. **门禁本体是真绿**：五个文档/结构门禁 + blob + smoke + rust verify 全部 EXIT=0 且有有意义计数；/tmp 突变实验证明它们在真实违例时会变红（除 F1 的第二道判据）。
14. **HEAD 大改无回归**：HEAD 95 文件 diff（09ed8d0..HEAD，+7965/−388）的核心机制（回执 v2 规范化、revision 409、幂等键 scope、publication guard、Retry-After、ONNX 懒加载、Rust parity、iOS 状态机/提醒/时区）均经 lane 3/4 的代码+定向测试复核，未发现新回归；上一轮训练计划审查的 9 项历史检查项在 HEAD 仍成立。

---

## 6. 与既有审查的关系

- **`docs/PROJECT_REVIEW.md`（2026-09-30）R1–R4**：本轮没有回退。R1（override 不匹配拒绝发布）、R2（空 cohort 合法发布）、R3（epoch 起始 receipt 保留）、R4（测试入口跨平台）均经 lane 1/3/5 抽查仍成立；R1–R3 探针 `review:model-boundaries` 本轮再跑 `violationCount=0`。
- **`deliverables/training-plan-review-2026-10-18/`（3 P1 + 18 P2 + 21 P3）**：3 个 P1（回执 v2 线格式、revision 冲突 500、coach-loop 无跨库回验）与 18 个 P2 抽样复核均**保持修复**；仅发现 1 项 P2-8 残留（P3-26）与 1 项 P3-18 B1 仍按产品决定保留（不在本轮计为缺陷）。本轮 P2-02（mtime 503）与该轮批次 C 的"WAL checkpoint 不重建读连接"是同一类问题的**另一个调用点**，说明"mtime 语义"应作为一条仓库级约定统一。
- **`deliverables/` 历史当轮报告**：作为上下文读取，未重复其已修复结论；本轮新增 11 P2 与 42 P3 均为 HEAD 当前事实，其中 P2-03/P2-04/P2-05 是**首次记录**（不是 HEAD 引入的回归）。
- **本轮唯一对既有判断的纠正**：Lane 1 L1-02 的"当前 iOS 仍走 legacy 读对"不成立 → 降级为 P3-01（见 §2.3）。
- **一条对未来的提醒**：`deliverables/README.md` 自定的"当轮审查收尾后并入或删除"约定已连续多轮未执行（33 份已提交文档仍列在"未提交改动"节），本轮报告也属于"当轮"产物；建议下一轮审查开始前先清理。

---

## 7. 发布判断与建议修复顺序

### 7.1 判断

- **P0/P1 = 0**：未发现已发布数据丢失、越过发布 gate 写主库、坏批半提交、凭证泄露或生产不可用路径。
- **可以继续按现状运行**（当前单用户部署；iOS 直连自己的云 API）。当前已知的运行期可见影响只有：导入/重算期间计划读偶发 503（P2-02，客户端会退避重读）、迟到动态补读期间同步变慢（P2-06，自限）、CLI legacy 增量下同窗重复（P2-01，仅该入口）。
- **不能宣称的事项**（如实列出）：真机 HealthKit/后台、Simulator 视觉验收、Apple Watch 排期、Windows 运行时、gitee CI、真实库迁移/备份演练、真实并发压力——见 §8；这些不能由本轮任何绿灯替代。
- **若下一步是模型/预测发布**：P2-03（gate 放行 null 指标）与 P2-04（准备度默认值+假 trace）应视同 P1 门槛先修；否则发布记录会声称"gate 通过"，而 gate 在"算不出来"时并不拦截。

### 7.2 建议批次

| 批次 | 内容 | 理由 |
|---|---|---|
| **A（半天，低风险）** | P2-02 mtime→inode/重试；P2-07 doc-refs 基线或汇总措辞；P2-08 包边界正则；P2-10 4 份文档就地标注；P2-11 迁移版本；P3-23 注释矛盾；P3-41 OPERATIONS 重复 | 均为单点、可当场验证、不改变业务语义 |
| **B（下次模型/预测发布前）** | P2-03 gate null→not_evaluable；P2-04 缺失准备度策略 + trace 不变量；P2-05 streak 阈值单源化 | 算法合同语义；会改变预测数值或激活判定，需要产品确认口径与回归 |
| **C（数据/iOS 同步）** | P2-01 CLI legacy 语义（supersede 或拒绝）；P2-06 补读份额；P3-21/22 补读窗口边界 | 需要真实数据/设备回归；P2-06 可先在模拟器/回归里验证预算分配纯函数 |
| **D（门禁与文档收尾）** | P2-09 README 并发旋钮；P3-30～P3-40；P3-42 口径措辞；deliverables 归档 | 不改变运行行为，但直接决定"下次审查是否还能相信绿灯" |

### 7.3 验证口径（修完后）

- 每个修复必须带**定向回归**（现有测试文件或新增），并优先做"改坏→变红→还原→变绿"的突变验证；门禁类修复（P2-07/P2-08）必须在 /tmp 夹具或隔离目录证明"真实违例现在会红"。
- 全量 `npm test` 重跑时记录并发设置；iOS 改动重跑 `npm run test:ios`；docs 改动重跑 `check:docs`/`check:doc-refs`；`deploy/` 改动重跑 `deploy-*` 合同测试。
- 不要为了让本轮 P2 变绿而放宽任何阈值/删除断言（与仓库既有纪律一致）。

---

## 8. 未验证边界（不得当作已通过）

1. **真机 + 配对 Apple Watch**：UUID/时刻稳定、表端可见、部分成功、跨午夜、新旧服务组合、HealthKit 后台唤醒/锁屏/传输延迟（`docs/IOS_NATIVE_RUNBOOK.md`）。
2. **Simulator 视觉验收**（`apps/ios/tests/run-visual-tests.sh`，需 booted Simulator + 隔离数据库 `var/rai.sqlite`）与 `run-coordinate-sdk-check.sh`：本机不满足条件，未运行。
3. **`test:ios:live` / `test:ios:mutation`**：前者需模拟器安装探针；后者会逐条改坏 Swift 源码，与"只读审查"约束冲突 —— 因此本轮对 iOS python 结构门禁的**有效性**未验证，只验证了"当前跑绿"。
4. **Windows 运行时**：`npm run test:ios` 的 Windows 跳过契约、`deploy-n100/deploy-upgrade` 的 Windows-only skip、默认并发下的 Windows 全量 `npm test` 均未实跑；gitee 不触发 GitHub Actions，`.workflow/master-ci.yml` 是未启用草案 ⇒ **当前没有远程 CI 兜底**。
5. **真实库演练**：真实 325 MB 库的迁移/备份/恢复、真实上传包的双引擎等价性、真实并发导入下的 guard 重试率/503 比率均未执行；D-02/D-04 的生产可达性为代码推断。
6. **线上部署**：nginx/systemd/upgrade 模板未在服务器执行；`nginx -t`、`systemctl daemon-reload` 属运维 runbook。
7. **`ml:test`**：Lane 5 只跑了 `ml:check`（venv 就绪），Python 测试套与 `rust:build` 未跑；ML 精度在零标签下仍为 not_evaluable，本轮不评价准确率。
8. **`.archify/` 架构审计目录**：2026-10-13 时点快照，本轮只做范围清点，未逐份复核（README 已声明不回写）。

---

## 9. 交付物与复现入口

- 本报告：`deliverables/DEEP_REVIEW_2026-10-18.md`。
- 分 lane 证据：`deliverables/deep-review-2026-10-18/01-data-pipeline.md` … `05-infra-gates.md`（各自含证据等级、命令输出、未验证边界）。
- 关键复现命令：
  - 基线：`npm run typecheck`；`RAI_TEST_CONCURRENCY=2 npm test`；`npm run test:ios`；`node scripts/rust-worker.mjs verify`；`npm run smoke:api`。
  - 门禁：`npm run check:docs`；`npm run check:doc-refs`；`npm run check:scripts`；`npm run check:acceptance-matrix`；`npm run check:package-boundaries`；`node scripts/check-blob-size.mjs`。
  - P2-02：`node /tmp/mtime-probe.mjs`（WAL checkpoint 后 ino 不变/mtime 变）；P2-01/P2-03/P2-04/P2-05 的纯函数探针见各 lane 报告"已复现"段。
  - P2-07/P2-08：lane 5 报告的 `/tmp` 夹具突变表（仓内零改动）。
- **审查时点**未修改任何产品代码、测试、配置或 docs 正文；审查结束后，用户要求"修复以上所有问题"，同轮修复已提交落地（提交哈希见 `git log --oneline -3`），逐项状态见 §10 与 [FIXES_2026-10-18](deep-review-2026-10-18/FIXES_2026-10-18.md)。本报告正文保持时点证据，不回写审查结论。

---

## 10. 同轮修复记录（2026-10-18，审查后立即执行）

全部 **11 P2 + 42 P3** 已处理：**50 FIXED + 3 DECISION + 0 NOT-APPLICABLE**（P3-33 由 Lead 收尾）。逐 ID 状态、每项证据与命令见 [FIXES_2026-10-18.md](deep-review-2026-10-18/FIXES_2026-10-18.md)。

修复后回归（Lead，提交前最终工作树）：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT 0** |
| `RAI_TEST_CONCURRENCY=1 npm test` | **EXIT 0**：tests **2072** / pass **2069** / fail **0** / skipped **3**（Windows 语义），496 s（基线 2038，+34 项新回归；含用户确认后的置信度先验与 diagnostics 聚合回归） |
| `npm run test:ios` | **EXIT 0**：94 文件类型检查、PASS **1169**（基线 1132）、0 FAIL（Lane 4 实跑 + Lead 复跑） |
| `npm run check:docs` | 91 files / 629 links / 2 anchors / **0 problems** |
| `npm run check:doc-refs` | 143 处 / 0 越界 / 内容漂移**未核对（无基线）** / 8 处锚空行告警（EXIT 0） |
| `check:scripts` / `check:acceptance-matrix` / `blob` / `package-boundaries` | 全 EXIT 0（矩阵 80/80；包边界 16/31；1048 文件 ≤1.5MB） |
| `npm run smoke:api` / `rust:verify` | 通过 / 11 项内建回归 0 fail |
| `npm run review:model-boundaries` | `violationCount: 0` |

修复过程中被**全量测试抓到并修掉的二次回归**：P2-03 首版"同标尺任一分布指标 null ⇒ not_evaluable"会把冷启动/标定期（两侧 CA 全 null）误判为未评估、令重算 job 失败（application 6 例红）；已改为按 `baseScoredSessions/candidateScoredSessions` 的 cohort 语义收窄，复跑全量通过。

**3 项 DECISION**（不是遗漏）：P3-15（读路径同步重试与 `/synced` 事务内快照，已注释+度量测试）、P3-21（空窗重查不降频，2026-10-14 唯一防复发通道）、P3-37（`npm audit` 4 moderate 暂不升级 onnxruntime，OPERATIONS 记录处置边界）。**用户确认后的两条口径落地**：P2-04 改为"未知只降置信度、不罚时间"（`UNMODELED_READINESS_CONFIDENCE_PRIOR = 0.5`，乘子 0.775，距离无关）；P2-01 保留墓碑（优先防乱序/重试复活），补 `DATA_PIPELINE §2` 与 `/v1/diagnostics.imports` 可见性。P3-13 与 3 项 DECISION 按接受处理并补了再评估触发条件（FIXES §6）。

**仍未验证**：真机/配对 Watch、Simulator 视觉、`test:ios:live/mutation`、Windows 运行时、gitee 侧 CI、真实库迁移/备份/恢复与真实并发压测（与 §8 相同，修复不改变这些边界）。
