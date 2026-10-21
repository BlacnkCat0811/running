# RAI 项目架构深度审查（2026-10-20）

- **审查日期**：2026-10-20（Asia/Shanghai）。
- **审查基线**：`git HEAD = 9db450f`（`docs(training-plan): 2026-10-20 发布记录`），审查对象为**当前工作树**。
  审查开始与结束时产品代码**零改动**；工作树新增内容只有本报告目录（`deliverables/architecture-review-2026-10-20/`）与 `deliverables/README.md` 的索引行。
- **审查对象**：原生 SwiftUI iOS（`apps/ios`）、Node/Fastify API（`apps/api`）、16 个共享 TS 包（`packages/*`）、
  Rust 数据执行器（`crates/rai-data-worker`）、Python 离线训练（`research/`）、部署模板/门禁/文档（`deploy`、`scripts`、`docs`）。
- **审查方式**：**4 个并行只读 lane**（API 运行时 / 领域与持久化 / iOS 客户端 / 平台与质量系统）+ Lead 独立基线实跑、
  跨 lane 对拍与逐条复核。分 lane 原始证据（含全部 `文件:行号`）：
  [01 API 运行时](architecture-review-2026-10-20/01-api-runtime.md) ·
  [02 领域与持久化](architecture-review-2026-10-20/02-domain-data.md) ·
  [03 iOS 客户端](architecture-review-2026-10-20/03-ios-client.md) ·
  [04 平台与质量系统](architecture-review-2026-10-20/04-platform-quality.md) ·
  [共享简报](architecture-review-2026-10-20/BRIEF.md)。
- **口径**：P0 = 数据丢失/安全漏洞/生产不可用；P1 = 发布阻断或硬架构不变量被破坏；P2 = 用户可见错误或高概率结构性风险；
  P3 = 低影响/防御性/可维护性/文档。证据等级 **E1** 静态逐行阅读；**E2** 实跑命令、测试或探针；**E3** 推断（写明前提）。
  跳过不能写成通过；文档承诺不能当实现证据。
- **本轮不是缺陷清单重跑**：上一轮 `deliverables/DEEP_REVIEW_2026-10-18.md`（基线 `24aa7d8`）已逐条修掉 11 个 P2 / 42 个 P3；
  本轮回答的是**结构问题**：实际架构长什么样、和文档声称的差几代、哪些不变量由代码强制、哪些靠流程、下一次改动会在哪里失效。

---

## 0 结论摘要

**分级计数**：lane 原始合计 **P0 × 0｜P1 × 1｜P2 × 22｜P3 × 39**；按架构主题合并后
**P0 × 0｜P1 × 1（AR-1）｜P2 × 12（AR-2…AR-13）｜P3 × 14 个主题**（逐条仍见四份 lane 报告）。

**总体判断：在"单用户 + 单机 + 单写者"的产品前提下，没有发现发布阻断级的架构缺陷；系统的核心不变量大体由代码强制而非口头约定。但仓库的"架构文档、发布模型、部署形态"三者已经落后于代码一个代际，且契约/退役面的治理成本正在指数化。**

六条架构判断：

1. **实际架构已经不是文档写的那个架构。** 文档（`docs/ARCHITECTURE.md:11-16,60`、`docs/DATA_PIPELINE.md:6-7,13`、`README.md:11`）描述的是
   "私有候选库 → 全库校验 → 原子换库"；`import-worker.ts:751-760` 已把该调用链从 API 运行路径**删除**，现为
   "data-only 快通路 → direct-sync 统一接收器 → 显式失败（不回退）"。文档未写这条主线、未写控制库 v2 / 统一排课状态，
   `DATA_PIPELINE.md:6` 甚至把已上线一周的直连同步写成"设计，未上线"（Lane 2 D-02，E1）。
2. **领域包这一层是仓库最强的资产，API 的"应用层"没有对应隔离。** 16 包 / 31 条实测边 / 4 条禁线全部成立，12 个纯领域包
   实测零 `node:`/`process`/`console`/`fetch`；恢复度、CA/TA、预测公式都收敛到单一来源。但 `packages/application` 并不是 API 的
   领域层：API 直接 import `@rai/storage-sqlite` 16 处、`server.ts` 自身承担 composition root + 路由 + 后台任务 + 跨库策略（Lane 1），
   而 `apps/api` 里另有约 9k 行教练/计划/赛事政策模块。"分层"在包一级成立，在 API 内部是 hub-and-spoke。
3. **一致性模型是"应用级单写者 + 多存储分离"，总体 fail-closed。** 主库写入由五层机制叠加保证（跨进程发布锁 / 整作业 FIFO 准入 /
   请求级 MutationCoordinator / 跨线程 write-lease / 跨两库 publication guard），拿不到许可时**不写**；直连车道"恒为增量"由
   返回类型写死 `{preserveAbsent: true}`、禁止操作由多通道清单检测。真正的残余缺口是**读路径没有预算**：约 37 个读方法全部同步跑在
   主事件循环上，没有 `requestTimeout`，也没有"超预算返回可重试 503"，唯一兜底是 systemd watchdog 120 s 杀进程（Lane 1 P2-2）。
4. **演进成本的两个放大器是契约四面手写与退役面治理。** 同一个 HTTP 形状有四份手写表示（TS DTO 2293 行 / JSON Schema+OpenAPI 1239 行 /
   Swift DTO 2201 行 / Fastify 不校验响应），响应成功形状只有手写 required 名单；自 2026-09-01 的 454 个提交里，**32 个同时改 ≥3 个契约面**。
   2026-10-20 又把 7 个旧计划操作 410 退役，但**当前 iOS 仍消费其中 3 条**（手动课表入口），且新 v2 写端点没有 handshake 能力位（AR-1）。
5. **可伸缩性上限由"单机 + 同步读 + 单写者"决定，当前规模够用；真正的风险是"坏了没人知道"。** 生产是 2 vCPU / 2 GiB、单 Node 进程、
   单 SQLite 主库；资源预算（1400 MB）与两个 512 MB isolate 的算术没有余量；watchdog/OOM/启动限流触顶全部静默，`upgrade.sh`
   先 pull 后迁移且失败不回滚（Lane 4 Q1–Q4）。单用户产品里这不是数据问题，而是"同步静默失败三天"的可用性问题。
6. **质量系统是分形的，但"量具自身没被量"。** 门禁有自测、孤儿门禁会被判红、跳过要认账、迁移有冻结 checksum——这些是真资产；
   但 18 支纯 JS 门禁不在 `typecheck` 内、13 支零测试引用、5 个发布判据只出现在文档里，`check:doc-refs` 的内容漂移因无基线而
   "未核对"，文档锚点判据只覆盖 2/703（Lane 4 Q5/Q6/Q11）。

**最该先做的 5 件事**（按性价比排序，均不破坏 D5/D17 等既有硬决定）：

1. **修 AR-1 的可达性**：统一页按能力隐藏/重接"手动课表"入口；给 v2 训练合同补 handshake 能力位；加一条"客户端源码不得出现已退役路径"的结构门禁。
2. **只改文档，半天**：重写 `ARCHITECTURE.md` 发布段与 `DATA_PIPELINE.md:6-7/13/74-76`，补第四库（dataset-epoch）与备份边界；同步 `README.md:11`。
3. **契约防漂移**：把关键响应 DTO 的必填/可空集合对拍进 OpenAPI（或从 `api-contracts` 生成），并给 `HandshakeResponse`/`TrainingPlanStateResponseV2`/ImportJob 加跨语言字段 gate。
4. **可逆部署**：`deploy/upgrade.sh` 失败自动回退 `before_head` + 重启 + 复验；systemd 加 `OnFailure=` 或一条日检；导入 worker 加 `resourceLimits`。
5. **读侧可观测**：给 `withReadStore` 加按路由耗时打点与"超预算 503 + Retry-After"；这比"异步化全部读"便宜两个数量级。

---

## 1 本机基线验证（Lead 亲自执行）

环境：macOS（6 核 / 16 GB）、Node `v22.23.2` + npm `10.9.8`（nvm）、Xcode 26.5。
基线期间 load average 6.8–9.5（其它会话与四 lane 并行），`npm test` 采用 `RAI_TEST_CONCURRENCY=2`。

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| V1 | 类型检查 | `npm run typecheck` | **EXIT 0**（pure + 主 tsconfig） |
| V2 | 全量 Node 套件 | `RAI_TEST_CONCURRENCY=2 npm test` | **EXIT 0**：tests **2224** / pass **2211** / fail **0** / skipped **13**，598 s（实测日志 `.workbuddy/runlogs/arch-review-2026-10-20/npm-test.log`） |
| V3 | iOS 门禁 | `npm run test:ios` | **EXIT 0**：98 个 Swift 文件类型检查（3 个仅依赖高德 SDK 的文件显式跳过）+ 34 组纯逻辑/结构门禁全绿（1508 条 PASS；日志 `.workbuddy/runlogs/arch-review-2026-10-20/test-ios.log`） |
| V4 | §16.1 验收矩阵 | `npm run check:acceptance-matrix` | 80 条 / cited 80 / declared-gap 0 / missing 0，EXIT 0 |
| V5 | 包边界 | `npm run check:package-boundaries` | 16 包 / 31 条 src 边 / 禁线 4，EXIT 0（Lane 2 另跑 `--self-test` 8/8） |
| V6 | npm script 跨平台 | `npm run check:scripts` | 18 个 package.json / **105** 条 script，EXIT 0 |
| V7 | 仓库体积 | `node scripts/check-blob-size.mjs` | 1115 个已跟踪文件全部 ≤ 1.5 MB，EXIT 0 |
| V8 | 训练计划唯一写者结构门禁 | `npm run check:training-plan-single-writer` | 生产源 465 / 测试 122 / 违规 0，EXIT 0 |
| V9 | 生产运行时冒烟 | `npm run smoke:api` | `Production API runtime smoke test passed` |
| V10 | 文档链接/可达性 | `npm run check:docs` | 审查前 106 files / 703 links / 0 problems；lane 报告落盘后 4 个新文件"不可达"（见 AR-9/§5.4），收尾已补索引并复跑（见 §1.1） |
| V11 | 文档行号引用 | `npm run check:doc-refs` | 141 处 / 越界 0 / 内容漂移 **未核对（无基线；15 份文档均无 `.linerefs.json`）** / 锚在空行 3 处（告警） |
| V12 | 生产依赖审计 | `npm audit --omit=dev` | **4 moderate**（`sprintf-js ← roarr ← global-agent ← onnxruntime-node`），与上一轮一致；修复需越界升级，`docs/OPERATIONS.md:111-117` 已记处置边界 |
| V13 | 定向路由归类测试（Lane 1 实跑） | `node --import tsx --test --test-name-pattern "every mounted write route" apps/api/test/server-runtime.test.ts` | pass：37 条写路由 / 51 条 GET 全部恰好归类 |
| V14 | Rust 执行器 | 未跑 `rust:verify` | 全量测试中 10 条 Rust parity 用例因"二进制早于源码"显式 skip；本机有工具链（`var/cargo`），但本轮未重建，**不写成通过** |

### 1.1 iOS 门禁与文档收尾（如实记录）

- `npm run test:ios` 实跑 **EXIT 0**：Swift 类型检查 **98 个文件**（3 个仅依赖高德 SDK 的文件按门禁显式跳过）+ **34 组**
  纯逻辑/视图/计划/同步/回执/结构门禁全绿（**1508 条 PASS**，含训练计划 v2 contract 57 / 计划排期 88 / 回执 153 / 持久化 241 等；
  12 支 `check-*.py` 中聚合链内的门禁全部执行，`check-background-mutations.py` 按设计只在手工入口）。日志 `.workbuddy/runlogs/arch-review-2026-10-20/test-ios.log`。
  未做 Simulator 视觉验收与真机，见 §9。
- 文档门禁的最终状态：新增本报告目录后，`check:docs` 会要求每份未跟踪 Markdown 从 `README.md` 可达。收尾时在
  `deliverables/README.md` 的「当轮审查」节补入口，并让本报告链接四份 lane 报告与 BRIEF；
  最终 `check:docs` = **112 files / 710 local links / 2 anchors / 0 problems，EXIT 0**。
- **13 条 skip 明细**：3 条 Windows 语义（路径别名 / 进程树 / 锁定回滚）+ 10 条 Rust parity（二进制早于源码，按设计 fail-safe 跳过）。
  跳过原因来自测试自身输出，不是"没有失败就算过"。

---

## 2 方法与交叉复核

### 2.1 lane 划分

| lane | 范围 | 分级（lane 原始） |
|---|---|---|
| L1 API 运行时 | `apps/api` 路由/鉴权/任务链/worker/单写者/契约接线 | P0 0 / P1 0 / P2 4 / P3 8 |
| L2 领域与持久化 | 16 个 `packages/*`、迁移、发布模型、导入/CLI、Rust 边界 | P0 0 / P1 0 / P2 6 / P3 10 |
| L3 iOS | SwiftUI/状态所有权/同步状态机/凭证/契约消费/测试 | P0 0 / P1 1 / P2 5 / P3 9 |
| L4 平台与质量系统 | `deploy/`、`scripts/`、`.githooks`、CI、文档治理、ML/Rust 构建、供应链 | P0 0 / P1 0 / P2 7 / P3 12 |

每个 lane 只读、只写自己的报告；Lead 独立跑全部基线、复核全部 P1 与关键 P2，并处理 lane 间冲突。

### 2.2 Lead 交叉复核记录（含 2 条改判/撤回）

| 复核项 | 动作 | 结论 |
|---|---|---|
| **L3-I5 原结论"410 会锁死写路径"** | Lead 读 `NativeAppModel.swift:1692-1695,1730-1733` 与 `APIClient.swift:575-582`，要求 L3 回源码确认 | **原结论撤回**：两处泛化 4xx 分支都会清待确认账目，410 不会锁死；保留"读侧把 410 报成可重试"的 P2。报告已重写并标注"Lead 复核修正"（L3 §3 I5） |
| **L1 跨 lane 注记"旧手动编辑器在 HEAD 不可达"** | Lead 读 `TechPlanView.swift:14` 与 `:42,342-350`、`TechManualPlanView.swift:246,446` | **只对 `TechRunCoachView` 成立**：统一页 `TechUnifiedTrainingView` 仍渲染 `manualPlanEntry`，无教练计划时保存/预览/确认三动作必 410。L3-I1 成立（见 AR-1） |
| **L2-D02 "API 已删除候选发布链路"** | Lead 读 `import-worker.ts:646-760`、`publishDatabaseFile`/`activateDatabase` 全仓调用点 | 成立：API 侧 `publishDatabaseFile` 仅 CLI 调用，`activateDatabase` 零调用；两条直连车道不合格时抛 `ImportLaneRefusal`，不回退 |
| **L2-D01 "结构探针补偿前提已失效"** | Lead 读 `health-export-parser/src/cli.ts:230-236` 与 `database-structure-probe.ts:25-40` | 成立：探针自述"前提 1 = 别处仍有 quick_check 兜底"，而所指的 `activateDatabase` 已是死代码，CLI 车道只剩弱探针 |
| **L4-Q8 "check:docs 因审查产物变红"** | Lead 实跑 `npm run check:docs` | 成立（4 problems，均为未跟踪报告不可达）；本轮收尾补索引解决，摩擦本身作为 AR-9 的子项保留 |
| **路由数 88/80** | Lead 静态正则只数到 68 条，L1 提供 `/tmp/route-scan.mjs` 与运行期路由表测试 | **以 L1 为准**（运行期 dump：88 handler / 80 唯一路径 / 37 写路由），Lead 的静态正则漏计了带泛型/多行注册；不据此改结论 |
| **契约空间"32/454 提交 ≥3 面"** | Lead 自写脚本统计 `contracts`/`api-contracts`/`schemas`/`APIModels`/`APIClient`/`server.ts` 共同修改 | 成立：0 面 357、1 面 44、2 面 22、**3 面 16、4 面 5、5 面 9、6 面 1**（见 AR-5） |

### 2.3 本轮不做什么

- 不重跑上一轮问题清单；不评价模型准确率；不迁移/重建真实库；不部署；不做公网渗透；不跑真机/Simulator、Windows 运行时、n100；
  不对 325 MB 真实库做压测（这些在 §9 逐项列为未验证）。
- 不把 lane 的报告原文复制进本报告：本报告给**合并后的架构判断**与**可执行优先级**，`文件:行号` 证据保留在 lane 报告。

---

## 3 实际架构（as-built，2026-10-20）

### 3.1 系统上下文与部署拓扑

```text
Apple Watch / iPhone HealthKit（只读健康样本；WorkoutKit 仅写训练排程）
        │ HealthKit 增量导出 + 分批 ZIP/直连批次（Bearer Token）
        v
Nginx 443（只反代 /v1；限流 300r/m；默认 120s；上传/备份 600s）
        v
单 Node 进程（systemd `Type=notify`，WatchdogSec=120s，MemoryHigh=1100M/Max=1400M，CPUQuota=150%）
  ├─ Fastify：80 条唯一路由 / 88 个 handler；同步读模型（约 37 个读方法）
  ├─ worker_threads：import-database / import-analysis / recompute（写租约）
  ├─ child_process：Rust 数据执行器（可选，默认 TypeScript）、预测训练子进程、systemd-notify
  └─ SQLite：主库 rai.sqlite（v46）+ 控制库 rai-control.sqlite（v2）+ runtime.sqlite + 2 个 sidecar
        │
        ├─ 读：ReadStoreManager（只读连接缓存 + inode 失效）+ 兼容快照
        └─ 写：发布锁文件 → TaskAdmission FIFO → MutationCoordinator → write-lease → publication guard
```

第二套部署 profile：`deploy/n100/`（家庭 VM + FRP）为 `Type=simple`（无 watchdog）、`access_log off`、`proxy_read_timeout 60s`；
`docs/OPERATIONS.md:53-60` 的 hang 守护章节**只描述云端模板**（Lane 4 Q3）。

### 3.2 运行时进程/线程模型

- 单进程、单事件循环；生命周期（发布锁 → 恢复中断 → epoch → ReadStoreManager → 控制库 schema/marker → workers/queue → 路由 → READY）
  全部写在 `server.ts` 顶层 await 中（58 个顶层 import / 7 个后台定时器 / 6 个 worker·queue·store 构造）。
- 后台任务全部 `unref()`：周计划 tick、zone 回填、recompute 巡检、上传清理、废弃库清扫。
- 读与主写共享事件循环；导入/重算有线程隔离；预测训练是独立子进程（只读主库、写工件/磁盘）。
- 单写者链五层（Lane 1 §1.5）：跨进程文件锁（API 全生命周期持有）、TaskAdmission FIFO、MutationCoordinator（请求级）、
  write-lease（跨线程短事务窗口，超时撤回不写）、publication guard（跨主库/控制库的混合读检测，120 s 租约）。
- **失败方向**：上述机制拿不到许可时均"不写"或"重试后 503"，没有失败开放；例外是少数读库异常路径（`isDatabaseRestoreBusy` 等，
  为恢复能力有意 fail-open，已在 Lane 1 标注）。

### 3.3 存储拓扑与 schema 治理（本轮新增的关键事实）

| 存储 | 路径 | schema 来源 | 版本机制 | 迁移门禁 | 是否在备份边界 |
|---|---|---|---|---|---|
| 主库 | `var/rai.sqlite` | `storage-sqlite/src/database.ts` 注册表，46 条迁移 | `schema_migrations` + **冻结 checksum 表** | 迁移冻结测试 + 表分类清单双向一致 | 是（应用备份也仅此库） |
| 控制库 | `var/rai-control.sqlite` | `mobile-goals.ts:1010-1075` 基础 DDL + `training-plan-store.ts:195` | `mobile_control_schema` 表（v2），**无 checksum** | 仅一个 API 测试覆盖"追加顺序" | 仅外部冷备 |
| runtime | `var/runtime.sqlite` | `runtime-state.ts:288-299` | **无版本表**，`CREATE TABLE IF NOT EXISTS` | 无 | 仅外部冷备 |
| dataset epoch | `var/rai.sqlite.dataset-epoch.sqlite` | `dataset-epoch.ts:15-22` | 单表单行，无版本 | 无 | **不在 `DATA_PIPELINE.md:76` 的边界描述里** |
| restore journal | `<db>.restore-journal.sqlite` | `restore-journal.ts:26-35` | 单表单行，无版本 | 无 | 随整个 runtime 冷备 |

生产代码里 `new DatabaseSync` 共 **47 处**（`apps/api` 34、`packages` 13），其中 19 处只读；控制库写入集中在主线程。
`/v1/backups` 只备份主库；2026-10-13 起 API 运行期不再自动创建备份，一致性备份责任外置给
`deploy/backup-runtime.sh`（停服、整 runtime 冷备、默认 dry-run）。**"数据边界"与"应用备份边界"因此不再重合**（AR-3）。

### 3.4 导入与发布：两条直连车道 + 硬失败；CLI 仍是候选库换库

- API 入口：`data-only` 快通路（record-only 白名单 + 基线合同戳）→ 拒收则 `direct-sync` 统一接收器
  （事实 + 路线 + 变更账本 + 回执 + 分析任务登记**同一主库事务**）→ 两条都拒收 ⇒ `ImportLaneRefusal` 稳定码失败。
  **不再有"回退旧候选链路"**；`publishDatabaseFile`/`activateDatabase` 在 API 侧已无调用方（Lane 2 D-02，E1）。
- 直连不变量的强制方式：增量语义由返回类型写死 `{preserveAbsent: true}`；禁止操作（备份/整库 copy/quick_check/换库）
  由 `contracts/src/direct-sync.ts` 的多通道清单检测；表写守卫按迁移产物双向一致在 pre-commit 跑（临时库，不是 grep）。
- CLI（`npm run data:import`，README:27 仍列为一等入口）仍走"候选库 → 文件换库"，且换库前只跑结构探针
  （全库 `quick_check` 已被替换；探针自述漏检页内 64 字节翻转），其"别处仍有 quick_check 兜底"的前提因 API 链路删除而失效（Lane 2 D-01）。
- 模型发布有两条路径：V2（repository + release bundle + `model-transition-gate.ts` 三态 `passed/failed/not_evaluable`）与
  预测模型（`prediction-model-service.ts` 35 条手写 DML + 自写三段判据，无 bundle、无第三态）（Lane 2 D-04）。

### 3.5 代码分层与依赖

- 16 个包 / 31 条 src 边 / 4 条禁线全部成立；`packages` 不 import `apps`（检查器 A 类判据守）。
- 12 个纯领域包（`tsconfig.pure.json`）实测零 `node:`/`process`/`console`/`fetch`，是真正的可离线/可测试核心；
  3 处时钟默认值（`features`、`model-eval`）是重放确定性的小洞（P3）。
- 依赖形状：`contracts` 被所有包依赖；`health-export-parser → storage-sqlite`（解析包即导入写端）；
  `storage-sqlite → model-eval`；`application → 其余 13 包` 但不被 API 充分使用（API 直接 import storage 16 处）。
- API 内部：`server.ts` 是 composition root + 路由 + 后台任务 + 跨库策略（88 个 handler 中 69 个注册在此文件）；
  `mobile-goals.ts`(1612) / `data.ts`(2479) 是真正的 god file；新 `training-plan-*` 四件套（2090 行）边界清晰、不是新 god module。
- 领域逻辑分布：`apps/api` 里教练/计划/赛事政策模块合计约 **9,000 行**，与 `packages/application`（14,730 行，主要为 CLI/recompute）
  并存。"计算留在服务端"的产品决定成立，但"服务端领域层 = application 包"的文档分工不成立（见 §4）。

### 3.6 契约与演进

- 契约四面：`packages/api-contracts`（2293 行，HTTP DTO）、`apps/api/src/schemas.ts`（1239 行，请求 Schema + OpenAPI，响应成功形状是手写
  required 名单）、`apps/ios/RAI/APIModels.swift`（2201 行，Swift Codable）、以及 Fastify **不校验响应**（无 `schema.response`）。
- 能力协商：handshake 有 9 组可选版本/键（`coachLoopContractVersion` 恒 1、`planSnapshotContractVersion` 条件省略、
  `planPublicationContractVersion`、`planReceiptContractVersion`、facts/分析视图、`syncCoverageVersion`、`directSyncBounds`）；
  **统一训练 v2 读合同没有 handshake 位**，只能盲发 `X-RAI-Training-Contract: 2`（Lane 1 P2-4）。
- 退役：2026-10-20 把 `/v1/mobile/{goals,run-coach,workout-plan/{preview,confirm,generate}}` 共 5 条路径 / 7 个操作改为 410
  `legacy_surface_retired` + replacement；路由保留（D17 的"端点不随客户端退役"仍成立），OpenAPI 标 `deprecated` 且不声明 200。
- 任务模型四套：命令队列（runtime.sqlite，cap 16，202/429）、导入（maxPending 8，202/413/429/507）、重算/预测（`/v1/jobs`）、
  计划发布（同步 200 + operation 账本 + `/v1/mobile/plan-operations/:id`）；失败形状三种（`code`/`failureCode`/`error`）。

### 3.7 iOS 客户端

- 生产 Swift 101 文件 / 38.7k 行；`HealthKitSync`(3839) + `HealthKitExport`(3026) 是最大两块；
  默认隔离 `MainActor`、`@Observable` 仅 6 个、纯策略（`SyncPhase`/`PlanStatePolicy`/`DirectSyncCursorPolicy`/`RouteSyncStateMachine`/
  `BackgroundSyncPolicy`/`PlanMutationDisposition`）约 3k 行可单测。
- 读侧已收敛：`TrainingPlanStore`（`private(set)` 状态 + 单一校验入口）+ `TrainingPlanRepository`（唯一网络/缓存 IO）；
  阶段闭集与展示文案有双向配平门禁，锚点推进判据单源。
- 写侧未收敛：`NativeAppModel`(2309) 同时是发布编排者；`acknowledgePlanWrite` 8 处、`cancelInFlightPlanRefresh` 9 处、
  `refreshPlanState` 20 处按调用点重复。5 个次级视图直接 `RaiAPIClient()` + `session.apiToken` 取数，绕过缓存/失效/错误分类。
- 6.9k 行同步核心（占生产代码 17.7%）**不被任何回归脚本编译**，只有源码子串门禁；`AppDelegate` 是第二编排者。
- 契约消费：`RaiHandshake` 是 14 个可选 Int 的手抄镜像，只有 direct-sync 一对有 parity 门禁。

### 3.8 质量系统

- 测试：2224 个用例、280 个测试文件（278 个被跟踪且全部被发现）；API 测试 117 文件 / 37,961 行；iOS 回归 35 文件 + 12 支
  Python 结构门禁 + 7 个聚合 runner；pre-commit 覆盖体积/类型/文档链接/行号引用/脚本可移植/iOS 结构/迁移冻结/表分类/验收矩阵/
  计划定向/唯一写者/包边界，并有 `RAI_IOS_UNVERIFIED` 认账语义；**CI 实际未启用**（gitee 不触发 GitHub Actions）。
- 门禁自测：包边界 `--self-test` 8 条突变；单写者门禁 R1–R5；迁移冻结双断言；直连表分类双向一致；孤儿 iOS 门禁直接判红。
- 盲区：18 支 `.mjs` 门禁/运行器不在 `tsconfig` 内（13 支零测试引用）；5 个 npm 目标只在文档出现（`check:coach-release`、
  `test:coach:mutation`、`test:ios:live|mutation*`、`data:verify-v2-release`）；`check:doc-refs` 内容漂移无基线；
  `check:docs` 锚点判据只覆盖 2/703；每轮审查都会因新增报告让 `check:docs` 变红（人工索引 `deliverables/README.md` 30 天 churn 第一）。

### 3.9 文档架构与漂移地图

| 现行文档 | 声称 | 实际（HEAD） | 级别 |
|---|---|---|---|
| `docs/ARCHITECTURE.md:11-16,60` | 候选 SQLite → 原子发布 → 主库 | API 只有两条直连车道 + 硬失败；候选链路仅 CLI | P2 |
| `docs/DATA_PIPELINE.md:6-7` | 直连同步"设计，未上线" | 生产默认快通路（`RAI_IMPORT_DATA_ONLY_FAST_PATH=1`），已上线约一周 | P2 |
| `README.md:11` | "导入使用私有候选库和受控发布" | 同上 | P2 |
| `docs/ARCHITECTURE.md:52` | 三个库 | 实际四库 + restore journal；epoch sidecar 未文档化 | P2 |
| `docs/ARCHITECTURE.md:3` | 维护日期 2026-10-07 | 10-07 后 API/iOS 均有大改（v2 排课、同步 R1–R6） | P3 |
| `docs/COACH_LOOP_OPTIMIZATION_PLAN.md:1431` | 列 `npm run build` | 已随 D17 退役，命令不存在 | P3 |
| `docs/SYNC_COMPUTE_SCALING_PLAN_2026-10-17.md:4` | scope 含 `apps/web/src/ios` | Web 已删除 | P3 |
| README 文档表 | "一主题一份现行说明" | "iOS/直连同步"9 份、"训练计划"7 份 | P3 |

文档链接判据只验证"文件存在 + 可达"，不验证"命令/路径承诺仍存在"：`check-doc-links.mjs` 会剥离行内代码，
于是 209 处反引号路径中 17 处目标不存在，只有 1 处是真正无解释的漂移，而这 1 处没有任何门禁能看见（Lane 4 Q7）。

---

## 4 架构评估（七维）

评级：**强 / 中 / 弱**。评级只对"架构属性是否由结构强制"负责，不表示功能是否正确。

| 维度 | 评级 | 判断与关键证据 |
|---|---|---|
| 结构与边界 | **强（包）/ 弱（API 内部）** | 16/31/4 全部成立、纯层零 IO；但 API 内部无强制分层：`server.ts` 同时是 composition root/路由/后台任务/跨库策略，`new RaiApplicationService` 9 处、裸 SQL 10 处、`withReadStore` 49 处（L1 §2） |
| 职责与单一数据源 | **混合** | 阶段（D16）、恢复度、CA/TA、发布 guard、直连增量为单源且有结构约束；但计划状态有 legacy goals + unified 两套真相，模型发布有两套实现，鉴权有三处内联 token（AR-2/AR-11，L1 P3-6） |
| 一致性与并发 | **中** | 写侧五层互斥、失败关闭；跨两个 SQLite 文件无原子事务，靠 publication guard 检测混合读（可接受，120 s 租约）；依赖调用约定的是"控制库只在主线程写""unified state 只能经 commitState 写"（后者只有文本门禁） |
| 故障隔离与可伸缩性 | **中偏弱** | 导入/重算有线程隔离、预测训练有子进程；读与主写共享事件循环、无超时预算；单机 2 vCPU/2 GiB、单写者；无路由/队列级指标，OOM/watchdog/启动限流全部静默（AR-6/AR-7/AR-8） |
| 可演进性 | **中偏弱** | `/v1` 只增不删（410 而非 404）、能力位按可选键追加、写路由三表强制归类；但契约四面手写、响应形状无门禁、v2 无能力位、退役面没有消费者清单（AR-1/AR-5） |
| 质量系统 | **强（产品判据）/ 中（自身可维护性）** | 迁移冻结、门禁自测、跳过认账、路由/写表/OpenAPI 逐条一致；但门禁实现多不在类型检查内、5 个孤儿、文档漂移判据覆盖极低（AR-9） |
| 安全与运维边界 | **中** | 一个鉴权 hook + 一个 ZIP 解包 choke point + 恢复状态机 + 错误脱敏白名单；systemd 隔离/限权完备。反例：无告警、升级不可逆、n100 profile 无 watchdog/无耗时日志、`NotifyAccess=all` 的取舍、无 HSTS/default_server（AR-8，L4 Q21） |

**一句话**：这套系统的"正确性"比"可运行性"建设得好——算法/数据不变量有代码与门禁双保险，
而"坏了会不会有人知道、能不能回滚"仍主要靠人。

---

## 5 发现清单

### 5.1 P1（1 条）

#### AR-1（P1）统一训练排课 v2 的"退役/启用"边界未闭环：服务端已 410，客户端仍在消费

- **证据链（E2/E1）**：
  - 服务端：`apps/api/src/server.ts:1658-1659,1767-1769,1793-1794` 把 `/v1/mobile/run-coach`、`/v1/mobile/workout-plan/{preview,confirm,generate}`、
    `/v1/mobile/goals` 一律 410 `legacy_surface_retired`；新写端点是 `/v1/mobile/training-plan/commands{/preview,/refresh}`（`server.ts:1636-1644`）。
  - 客户端：`apps/ios/RAI/APIClient.swift:308` 的路由表仍含 `run-coach`/`workout-plan/confirm`/`goals`，`:314-317` 仍调 `workout-plan/preview`；
    `NativeAppModel.swift:1691` 的 `publishPlan` 仍按这些路由发布。**`apps/ios` 对 `/v1/mobile/training-plan/commands` 的 grep 命中为 0**（L3 复核）。
  - 可达路径：统一页 `TechPlanView.swift:42` 渲染 `manualPlanEntry`（`:342-350`）→ `TechManualPlanView.swift:246,446`，
    无教练计划时（正是该入口的文案场景）保存/预览/确认三动作全部命中 410。
  - 发布记录 `UNIFIED_TRAINING_PLAN_RELEASE_2026-10-20.md:101-105` 已把"手动课表入口仍会失败"列为**已知缺口**，
    但只覆盖 UI 入口，没有覆盖"客户端没有任何已退役路由清单/门禁"这一结构缺口。
- **影响**：用户可见功能失败；退出码 410 被客户端当作可重试的服务端错误（L3-I5）；新客户端无法在握手层判断"这台服务支持哪些计划写"。
  这是"退役接口是否真的没有消费者"这一硬不变量被破坏，且下一次任何新写路径都会踩同一个坑。
- **建议**（二选一 + 两条门禁）：
  1. 近期：统一页 `manualPlanEntry` 按能力位隐藏；把 `legacy_surface_retired` 加入终局错误分类（读侧 `upgradeRequired`），不再提示"稍后重试"。
  2. 正确解：客户端接入 `/v1/mobile/training-plan/commands`；服务端 handshake 增加 `trainingPlanContractVersion?: 2`（可选、字面量单源），
     `publishPlan` 的路由表由能力位派生。
  3. 门禁：新增"`apps/ios/RAI` 不得出现 `retiredLegacyRoutes` 字面量"（与服务端集合对拍）；新增"每个出站路径都有服务端路由"的跨仓对拍
     （形态可复用 `check-direct-sync-contract-parity.py`）。
- **升级条件**：若继续发布当前 iOS 构建，AR-1 保持 P1（功能失败 + 误导性错误语义）。

### 5.2 P2（12 条，按主题合并）

#### AR-2（P2）计划状态双真相：legacy goals 与 unified state 所有权未收口

- **位置/机制**：控制库同时保存 `mobile_goals(payload_json, revision)` 与 `mobile_training_state(payload_json, revision)`。
  v2 命令把配置单向镜像进 legacy goals；反过来 lock/排期回执/coach-loop 运行时/周计划历史只写 goals、不回写 unified
  （`server.ts:1796-1834` → `mobile-goals.ts:662`；v2 写 `training-plan-commands.ts:321,407`；v2 读只投影 `training-plan-routes.ts:75-135`）。
  coach-loop managed 数据集上 `/v1/mobile/training-plan-state` 的 v1+v2 同路径一起 409（`server.ts:486-500`），而迁移 source 可为 `coach_loop`
  （`training-plan-store.ts:117`）——新合同的可用性由旧合同生命周期决定。
- **影响**：当前 iOS 只把 v2 当参考、不 POST v2 命令，所以用户不可见；一旦客户端启用 v2 写，"暂停/锁课之后 v2 读仍报旧状态"会立即成为用户可见分歧。
- **建议**：先做所有权决定（unified 为唯一真相 → lock/receipt/coach-loop 同事务写 unified；或 unified 仅作迁移影子 → v2 写端点显式 409 且 handshake 不宣告）；
  再加一条"同一 scope 只能有一个计划写入口"的结构/运行时门禁。建议写成 ADR（见 §8 D21）。
- **升级条件**：iOS 开始 POST v2 命令之前必须解决，否则升 P1。

#### AR-3（P2）持久化治理与备份边界：主库之外的四套 schema 机制、零门禁、边界遗漏

- **位置/机制**：见 §3.3。主库有 46 条迁移 + 冻结 checksum + pre-commit 门禁；控制库（`mobile_control_schema` v2）、runtime.sqlite
  （无版本表）、dataset-epoch sidecar（单表单行）与 restore journal 各自"当前全量 DDL + 追加式 ALTER"，**没有冻结、没有 fresh-vs-migrated 等价断言、
  不在迁移门禁触发面**。控制库保存的是发布结果、计划历史、回执等用户状态；`DATA_PIPELINE.md:76` 的备份边界没有列 dataset-epoch，
  而 `/v1/backups` 只覆盖主库（Lane 2 D-03/D-06，Lane 4 Q4）。
- **影响**：不是当前 bug，而是长期成本与恢复风险：加一列要判断改哪个文件/哪个库；从备份恢复到半迁移状态没有等价性证明；
  运维按文档执行可能漏掉 epoch sidecar（缺失时静默回退 configuredEpoch，有意的 fail-open）。
- **建议**：① 控制库迁移加冻结 checksum；② 每个非主库一个版本表 + fresh-vs-migrated schema 快照等价断言；③ 把 4 个文件的建表/版本代码纳入迁移门禁触发面；
  ④ 明确备份清单（主库 + control + runtime + `*.dataset-epoch.sqlite` + 上传/工件），并做一次整 runtime 恢复演练。

#### AR-4（P2）发布模型代码/文档/CLI 三分叉；补偿控制成死代码

- **位置/机制**：API 运行路径已无候选库（`import-worker.ts:751-760`），CLI（`health-export-parser/src/cli.ts:204-240`）仍"候选库 + publishDatabaseFile"；
  结构探针（`database-structure-probe.ts:25-40`）自述"别处仍有 quick_check 兜底"才可替代全库校验，而所指的 `activateDatabase` 已零调用 ⇒
  CLI 换库前只剩一个自认"页内 64 字节翻转漏检"的探针。文档仍以候选库为主线（见 §3.9）。API 运行期因此也**没有任何自动备份点**。
- **影响**：同一份健康数据从哪个入口进入，会有不同的一致性/备份语义；CLI 是 README:27 的一等入口，不是弃用路径；文档推理会得出"导入失败不影响 incumbent"
  和"运行期有备份"两个错误结论。
- **建议**：纯文档修正 + 一次代码决策——① 改写 `ARCHITECTURE.md`/`DATA_PIPELINE.md`/`README` 的发布模型；② CLI 车道发布前恢复一次 `PRAGMA quick_check`
  （CLI 非热路径，成本可接受）或明确认账；③ 把"API 无自动备份、备份=外部整 runtime 冷备"写成运维第一条。

#### AR-5（P2）契约变更放大：四面手写、响应形状无门禁、任务模型四套、能力位无注册表

- **位置/机制**：TS DTO / JSON Schema+OpenAPI / Swift DTO 四面手写；Fastify 不校验响应，OpenAPI 成功响应只有手写 required 名单
  （`schemas.ts:740-790`）；v2 读合同无 handshake 位（Lane 1 P2-4）；四套任务模型/四个查询面/三种失败形状（Lane 1 P3-7）；
  Swift `RaiHandshake` 是 14 个可选 Int 的手抄镜像，只有 direct-sync 有 parity 门禁（L3-I6）。
- **放大系数（Lead 实测）**：2026-09-01 以来 454 个提交中，**32 个同时修改 ≥3 个契约面**（3 面 16、4 面 5、5 面 9、6 面 1）。
- **影响**：契约漂移的唯一发现机制是客户端运行时；每次字段演进都要人工同步 4 处，且没有门禁证明"响应仍可被旧客户端解码"。
- **建议**：① 从 `api-contracts` 生成 OpenAPI components（或至少对拍 required 集/可空性），加 `check:api-contract-shape`；
  ② Swift 侧至少给 `HandshakeResponse`、`TrainingPlanStateResponseV2`、ImportJob 三组加字段级 gate；③ 在 `api-contracts` 定义统一 `TaskStatus` 词汇；
  ④ handshake 能力位集中成服务端/客户端各一个注册表，parity 门禁覆盖全部键。

#### AR-6（P2）读路径全同步、无预算；唯一的兜底是 watchdog 杀进程

- **位置/机制**：`withReadStore/withReadDatabase`（`server.ts:748-782`）同步回调 `readStores.use`；`RaiReadStore` 约 37 个公开读方法全部同步；
  Fastify 只配 logger/ajv（`server.ts:197-200`），无 `requestTimeout`/路由级预算；一次全库扫描或大排序会阻塞所有 HTTP、后台定时器与 watchdog 心跳。
  2026-10-18 的 13.4 s 同步读挂死记录就在 `systemd-notify.ts` 注释里（Lane 1 P2-2）。
- **影响**：读放大时全站停摆；用户看到连接超时而不是"可重试"；watchdog 重启期间进行中的导入/重算靠 journal 恢复，但请求直接失败。
- **建议**：先加按路由耗时打点 + 慢读阈值日志/指标；已知慢读加行数上限/分页；"超过 N ms 的读"返回 503 `database_busy` + `Retry-After`（客户端已有该语义）。
  不要为可测性立刻上异步读 worker；先用预算把"卡死"变"可重试"。

#### AR-7（P2）内存预算算术不一致：1400 MB 上限 vs 两个 512 MB isolate + 原生内存

- **位置/机制**：`deploy/rai.env.example:57-59` 写明 `NODE_OPTIONS=--max-old-space-size=512` 是"per Node process/isolate"；
  `deploy/rai-api.service:44-50` 的 `MemoryMax=1400M` 是聚合预算；`import-worker.ts:982` 起**常驻** Worker 且全仓无 `resourceLimits`
  ⇒ 两个 V8 堆上限（main + worker）已 1024 MB，再加 tsx/undici/onnxruntime 原生内存与 Rust 子进程；`OOMPolicy=stop` 会停掉整个 cgroup（Lane 4 Q1）。
- **影响**：大包导入 + 一次全表重算是预算最窄时刻；OOM 后是否按 `Restart=on-failure` 拉起未实测（systemd 语义），但"整组停掉"本身就是风险。
- **建议**：导入 worker 显式 `resourceLimits`（256–384 MB），或在 env example 写清"isolate 数 × 512 MB ≤ MemoryMax 的 80%"并下调；
  把这条算术做成 `deploy-cloud.test.ts` 的静态断言。

#### AR-8（P2）部署/运维的失败可见性与可逆性：无告警、双 profile、升级不回滚

- **位置/机制**：`rai-api.service:5-6,23,31-33` 的 `StartLimitBurst=3`/`WatchdogSec=120`/`Restart=on-failure`；无 `OnFailure=`；
  300 s 内第 4 次失败后 unit 永久 failed 且无外部事件；`docs/OPERATIONS.md:96-98` 的判据是"人去跑 `systemctl show -p NRestarts`"。
  `deploy/upgrade.sh:91-136` 先 `git pull --ff-only` 再可选 `data:migrate --apply`，失败时 `exit 1` 把服务留在停止/半新状态，
  `before_head`（`:75`）只用于打印；仓库明确没有 restore-runtime.sh，整 runtime 恢复从未演练（`check-runtime-readonly.sh:45` 自认）。
  n100 profile 为 `Type=simple`、`access_log off`、60 s 超时，而 OPERATIONS 只描述云端模板（Lane 4 Q2/Q3/Q4）。
- **影响**：单用户产品里"服务停了三天没人知道"；一次迁移失败 = 停服 + 人工 6 步恢复；家庭 profile 上 -1001 类问题的两个放大项原样存在。
- **建议**：① `upgrade.sh` 失败自动 `git checkout before_head` + restart + 复验健康，并用 fake 环境测试钉住；② `OnFailure=` 或 systemd timer 日检
  （`is-failed` + `NRestarts` 增量）；③ OPERATIONS 明确标注"本节仅云端 profile"或给 n100 补 watchdog/日志；④ 把整 runtime 恢复演练写成发布前置项。

#### AR-9（P2）质量系统盲区：门禁自身不在类型检查内、孤儿判据、文档覆盖极低、审查流程与门禁互斥

- **位置/机制**：`tsconfig.json:24` 只含 `scripts/**/*.mts`，18 支 `.mjs` 门禁/运行器不在 typecheck 内，13 支零测试引用，仅 1 支有 `--self-test`；
  5 个 npm 目标只在文档出现（`check:coach-release`、`test:coach:mutation`、`test:ios:live|mutation*`、`data:verify-v2-release`）；
  `check:doc-refs` 因无 `.linerefs.json` 基线只打印"未核对"；`check:docs` 的锚点判据只覆盖 2/703 链接；
  每轮新增 `deliverables/` 报告都会让 `check:docs` 变红，只能人工维护 `deliverables/README.md`（30 天 47 次修改，全仓 churn 第一）。
  另有 iOS 6.9k 行同步核心不被任何回归编译（L3-I4）。
- **影响**：门的"红/绿"本身可信度不均；最需要保护的两类判据（文档承诺仍存在、跨语言响应形状）恰好覆盖最薄；
  审查流程每轮都要先修索引才能恢复绿，属于结构性摩擦。
- **建议**：① `tsconfig.scripts.json`（`allowJs`+`checkJs`）并入 `typecheck`；② 把 iOS 的孤儿门禁判据抽成通用检查（hook/CI/发布清单至少引用一次，人工入口显式豁免）；
  ③ 给 `check-doc-links.mjs` 补 `/tmp` 夹具自测，并对现行范围的反引号路径做存在性检查（软告警起步）；
  ④ `deliverables/` 当轮目录的可达性降为告警（与 `.archify/` 豁免同构）；⑤ 发布前把 `check:doc-refs --write-baseline` + `--require-baseline` 写成固定步骤。

#### AR-10（P2）iOS 写侧所有权未收敛、视图层穿透网络/凭证、同步核心不可回归编译

- **位置/机制**：`NativeAppModel.swift`(2309) 同时是发布编排者（`publishPlan`/账本守卫/取消在飞读/`acknowledgePlanWrite`×8/
  `cancelInFlightPlanRefresh`×9/`refreshPlanState`×20 按调用点重复）；5 个次级视图各自 `RaiAPIClient()` + `session.apiToken` 直接取数，
  `TechDayWorkoutsView.swift:12` 还把 token 拼进 `.task(id:)` 身份；`HealthKitSync`+`HealthKitExport` 6.9k 行（生产代码 17.7%）不被任何回归编译，
  只有源码子串门禁；`AppDelegate` 是第二编排者（Lane 3 I2/I3/I4）。
- **影响**：读侧已有的"单一所有者 + 纯函数校验 + 唯一 IO"只覆盖了一半；新增写动作必须复制 5 重判据；同步状态机的顺序与失败方向只能靠真机发现
  （历史上两次线上事故正是这一类）。
- **建议**：① 抽 `TrainingPlanPublisher`（含路由表/能力位），`NativeAppModel` 只做转发；② 5 处视图取数搬回 AppModel/repository，并加 "`Skins/` 不得出现 `RaiAPIClient(`/`session.apiToken`" 门禁；
  ③ 把 `performSync` 的分支选择逐步抽成纯函数（`SyncAtomicUnit.nextStep` + 谓词表），一次一条路径；**不要**为可测性重写/拆文件。

#### AR-11（P2）模型发布两套实现：一套有 gate/bundle，一套手写 DML

- **位置/机制**：V2：`model-release-repository.ts` + `model-run-repository.ts:235` + `model-transition-gate.ts:202`（三态），调用点
  `recompute-pipeline.ts:578/639`；预测模型：`prediction-model-service.ts:378-837`（35 条 `INSERT/UPDATE`，`activate()` :805-816，
  指针交换 :830-838，三段自写判据，无 bundle、无 `not_evaluable`）。两者都在 `BEGIN IMMEDIATE` + 同一把发布锁内，未发现可绕过写入路径（Lane 2 D-04）。
- **影响**：加一条发布不变量要改两处；第二套失败语义比 V2 弱；审计面只有 `prediction_model_events`。
- **建议**：把预测模型激活判据下沉为 `storage-sqlite` 的第二个 gate（同层、同三态语义），DML 收进 repository；不必合并成一个状态机。

#### AR-12（P2）架构文档漂移：顶层文档落后一个架构代际，且没有判据

- **位置/机制**：见 §3.9 表格；`docs/ARCHITECTURE.md` 最后内容维护 2026-10-07（此后 v2 排课、同步 R1–R6、控制库 v2 均未反映）；
  `DATA_PIPELINE.md:6` 把上线一周的直连同步写成"未上线"；README:11 仍以候选库描述导入；四库只写三库；2 处退役命令/路径留在现行文档里。
- **影响**：架构/运维/新成员按文档推理会得到错误结论（AR-3/AR-4 的很多风险都由此放大）；"文档是架构的一部分"在最高层两块失效。
- **建议**：本轮只改文档（半天）：重写发布模型段落、补第四库与备份边界、更新维护日期、清理 2 处退役命令/路径；
  并在 `check:docs` 增加"现行文档中的反引号路径存在性"软判据（AR-9）。

#### AR-13（P2）跨存储发布/备份的"责任边界"没有代码化

- **位置/机制**：`publication-guard.ts` 明确"SQLite 不能跨文件原子提交"，用 epoch/pending_since + 读侧重试来检测混合读；
  但 guard 只是**检测**，不是阻止；控制库写入只有"API 进程单写者"这一假设（控制库没有自己的 publication lock）；
  CLI 迁移脚本 `scripts/migrate-training-planner.mts` 不强制停机、不取发布锁（Lane 1 P3-4）。备份边界（AR-3）也靠外部脚本与文档。
- **影响**：读者可能把"guard 存在"理解成"跨库事务存在"；两个写者（API + 人工迁移脚本）同时工作时，控制库一致性只靠操作纪律。
- **建议**：在 ARCHITECTURE/OPERATIONS 明确"跨库一致性 = 检测 + 重试，不是原子事务"；迁移脚本加 `--require-no-live-api`（或取控制库锁）；
  把 publication guard 的 pending 窗口与备份/恢复时间窗写进运维手册。

### 5.3 已核实为强项 / 不是缺陷（防止下一轮重复排查）

- **纯领域层与包边界**：12 个纯包零 IO；16 包/31 边/4 禁线全部成立；`--self-test` 8/8；自写脚本独立复算 41 条边与白名单逐条一致（Lane 2）。
- **单写者与直连不变量**：五层互斥、write-lease 超时撤回不写、直连恒增量由返回类型写死、禁止操作多通道检测、Rust 三重 permit（Lane 1/2）。
- **直连收口的收益**：去掉两次全库 `quick_check`（占单次导入成本 71.5–76.9%），单批从分钟级降到事务级；这是本轮最大规模收益（Lane 2）。
- **跨语言契约固定方式**：ONNX 特征契约用"TS/Python 各存一个 sha256 字面量 + 各自复算"（实测 `462e2133…6aa7` 三方一致）；artifact 加载比对 hash。
- **路由/写登记/OpenAPI/退役矩阵**：运行期路由 dump 与三张登记表逐条一致（37 写路由 / 51 GET）；OpenAPI 80 paths 与 mounted 80 唯一路径逐条相等；
  退役 410 矩阵有测试（Lane 1 E2）。
- **安全边界**：匿名读收敛为 3 条无健康数据路由；ZIP 解包 magic/符号链接/`..`/大小声明/压缩比/逐条预算/`wx` 排他创建/磁盘余量齐全；
  恢复是"确认词 + 空闲检查 + 候选校验 + journal + 原子安装 + 回滚 + epoch 变更"；错误脱敏有单一入口（Lane 1）。
- **部署模板的合同测试**：`deploy/` 14 文件 983 行被 16 条文本/行为合同测试钉住（watchdog、120 s 超时、404 根路径、memory 预算），
  并已修掉上一轮 n100 catch-all（Lane 4，E2：16 pass / 0 fail / 29 s）。
- **iOS 读侧与阶段闭集**：`TrainingPlanStore` 单一所有权、`PlanStatePolicy` 纯函数校验、`SyncPhase` 闭集 ↔ 展示文案双向配平、
  锚点推进判据单源；xcodeproj 用 `PBXFileSystemSynchronizedRootGroup` 免维护（Lane 3）。

### 5.4 P3 合并主题（14 个，共 39 条，逐条见 lane 报告）

| # | 主题 | 代表位置/说明 | 来源 |
|---|---|---|---|
| P3-T1 | HTTP 500 绕过错误脱敏 | `training-plan-commands.ts:463-474` + `training-plan-routes.ts:229-231` + `server.ts:1644-1648` | L1 P3-1 |
| P3-T2 | HTTP 层持有领域判定/跨库编排 | `/synced` 证据规则、lock 决策、跨库 fingerprint、裸 SQL 10 处 | L1 P3-2 |
| P3-T3 | god file：`mobile-goals.ts`(1612)/`data.ts`(2479) | 文件 JSON 回退 + 控制库 schema + 发布账本 + 读模型混在一起 | L1 P3-3 / L2 P3-01/02 |
| P3-T4 | v2 迁移只有 CLI、无运行手册/停机约束 | `migrate-training-planner.mts` 不取发布锁、不强制停机 | L1 P3-4 |
| P3-T5 | 鉴权三处内联 token 比较 | D9 敏感路由重复校验（当前一致，属纵深防御） | L1 P3-6 |
| P3-T6 | 任务状态四套/失败形状三种 | 客户端需要四套状态机 | L1 P3-7（并入 AR-5） |
| P3-T7 | 观测性只有进程均值 | `/v1/performance` 只有 admission/pending；无按路由/队列/线程指标 | L1 P3-8 / L4 Q2 |
| P3-T8 | `application` 包内 18 文件 / 230 处手写 SQL | repository 层被架空成"可选风格" | L2 §2.1 |
| P3-T9 | 纯层 3 处 `new Date()` 默认值、测试内重实现 `canonicalJson` | 重放确定性依赖调用方显式传参 | L2 P3-06/07 |
| P3-T10 | iOS DTO god file / 手写 swiftc 编译表 / AMap 边界 | `APIModels` 2201 行 159 类型；`run-model-tests.sh` 6 组参数表 | L3 P3-1/2/3 |
| P3-T11 | iOS 原始健康 ZIP 短期落盘 / 两处同步失败文案源 | 锁屏期间可读的残余暴露面；命名不区分 | L3 P3-4/5 |
| P3-T12 | 43/105 条 npm script 只做 Node 版本检查；29 个 env 中 8 个未进运维文档 | `RAI_DEPLOYMENT_MODE` 是安全开关却无人知道 | L4 Q9/Q14/Q20 |
| P3-T13 | 供应链与 CI：audit 4 moderate、CI 实际未启用、Rust 门禁不进 pre-commit | 已有记录与处置边界 | L4 Q15/Q16/Q17 |
| P3-T14 | nginx 硬化缺项 | 无 HSTS、443 无 `default_server`、`http2` 写法未来告警 | L4 Q21 |

---

## 6 与既有审查/时点快照的变化

- **相对 `DEEP_REVIEW_2026-10-18`（基线 `24aa7d8`）**：
  - 上一轮 11 个 P2 / 42 个 P3 的修复在 HEAD 上保持成立（Lane 4 逐条复核了 F2/F5/F9/F14 等；Lane 1/3 复核了路由/回执/读一致性相关项）。
  - 新增的架构面：统一训练排课 v2（并行第二真相 AR-2）、控制库 v2（AR-3）、旧计划端点 410（AR-1）、iOS 手动课表可达性（AR-1）。
  - 测试规模从 2038 → **2224**；全量耗时 585–598 s（concurrency=2）；skip 从 3 → 13（多出的 10 条是 Rust parity 因二进制过期按设计跳过）。
- **相对 `.archify/rai-audit-20261013-160439`（基线 `60678af`，10-13 快照）**：
  - 当时指出的"分析写租约失败开放"已修为超时撤回不写（`write-lease.ts` O07/D1）；
  - "CLI 无发布锁"已修：`packages/application/src/cli.ts:46`、`model-v2-cli.ts:57`、`migrate-cli.ts:45` 都取 `acquireDatabasePublicationLock`；
  - "两把互不相通的进程内锁"仍部分存在（MutationCoordinator 与 sourceMutations），属可接受的分层；
  - "候选库是文档主线、直连是默认"**仍然成立且未修**（本轮 AR-4）；"本机库版本落后源码"不再是本机事实（本机库 v46，但本轮未读写、不作为证据）。
- **本报告是 2026-10-20 时点快照**：所有 `文件:行号` 对齐 `9db450f`。后续提交若改动这些文件，需要显式重新核验；
  不要回写成"当时就是错的"。

---

## 7 建议路线图

### 批次 A（半天–1 天，零/低风险；本轮即可做）

1. **文档修正**（AR-4/AR-12）：重写 `ARCHITECTURE.md` 发布段、`DATA_PIPELINE.md:6-7/13/74-76`、`README.md:11`；补第四库与备份边界；
   修正 `direct-sync-plan.ts:14`、`cli.ts:232` 两处失效注释；清理 2 处退役命令/路径。
2. **AR-1 的止血**：统一页按能力隐藏"手动课表"；`legacy_surface_retired` 进读侧分类与写侧终局处理；加"客户端不得出现已退役路径"结构门禁。
3. **AR-8 的最小闭环**：`upgrade.sh` 失败自动回退 HEAD + restart + 复验（用现有 fake 测试钉住"失败后 HEAD 回到 before_head"）；补 `OnFailure=` 或日检文档。
4. **AR-7 的一行**：导入 worker `resourceLimits`（256–384 MB）+ env example 的算术说明。
5. **AR-9 的索引治理**：`deliverables/` 当轮目录可达性降为告警；`check:doc-links` 对现行文档做反引号路径存在性软检查。

### 批次 B（1–2 周，需要设计决定）

6. **AR-2 所有权决定**：写 ADR（unified 唯一真相或影子模式），并实现同事务写入或显式 409 + handshake 不宣告。
7. **AR-1 的正确解**：handshake 增加 `trainingPlanContractVersion`；客户端接入 `/v1/mobile/training-plan/commands`；`publishPlan` 路由由能力位派生。
8. **AR-5 契约防漂移**：OpenAPI 响应形状从 `api-contracts` 生成或对拍；三组 Swift 字段 gate；统一 `TaskStatus` 词汇与四套任务终态矩阵。
9. **AR-3 迁移治理**：控制库冻结 checksum + fresh-vs-migrated 等价断言；4 个非主库文件进迁移门禁触发面；备份清单补 dataset-epoch；做一次整 runtime 恢复演练。
10. **AR-4 的 CLI 决策**：恢复 `quick_check`，或明确"CLI 仅离线引导、不在日常路径"并写入 README/OPERATIONS。

### 批次 C（可靠性，需压测/真机）

11. **AR-6 读预算**：按路由耗时打点 + 慢读阈值 503；对工作台/趋势/详情做行数上限或分页；在真实 325 MB 副本上量 p50/p95。
12. **AR-10 iOS 可测面**：抽 `TrainingPlanPublisher`；5 处视图取数回 AppModel + 门禁；`performSync` 分支逐步纯函数化。
13. **AR-11 模型发布**：预测激活判据下沉为第二个 gate，DML 收进 repository。

### 批次 D（长期，结构改造）

14. **`recompute-pipeline.ts`(4405) 拆"读/算/写发布"三段**；`database.ts`(4078) 把冻结表与注册表搬出（迁移正文不动，避免 checksum 漂移）；
    `server.ts` 按"装配/路由/后台任务/跨库策略"抽模块（不要重写成 clean architecture，只做职责切分）。
15. **`tsconfig.pure.json` 的包清单自动检查**（新增包漏纳即红）；控制库/runtime 的版本表统一。
16. **单机架构的上限判断**：若用户/数据量继续增长，先量"读阻塞占比 + 导入峰值内存"，再决定是否引入只读 worker/第二进程；**不要**先上 PM2 cluster（D5 明确禁止）。

---

## 8 建议新增的长期决定（ADR / DECISIONS）

- **D18 / ADR-007：API 导入只有两条直连车道 + 硬失败。** 明确"不回退候选库"是产品决定而不是临时实现；CLI 车道是离线工具、语义不同；
  候选库只用于 CLI 与隔离退役。补一条"数据入口 -> 一致性/备份语义"矩阵。
- **D19：四库 schema 治理与备份边界。** 每个 SQLite 文件必须有版本表 + 冻结 checksum + fresh-vs-migrated 等价断言；
  备份清单 = 主库 + control + runtime + `*.dataset-epoch.sqlite` + 上传/工件；恢复演练是发布前置项。
- **D20：契约变更单一流程。** 一次 HTTP 形状变更必须同时产出：TS DTO、OpenAPI（生成或对拍）、Swift 字段 gate、能力位（可选）、退役矩阵；
  禁止"只改 TS 或只改 Swift"。
- **D21：计划状态单一所有权。** 在 v2 写端点对客户端开放之前，必须书面确定 unified state 与 legacy goals 的唯一真相与退出条件；
  在此之前 v2 写端点应显式 409 且 handshake 不宣告。

---

## 9 未验证边界（不得当作已通过）

| 项 | 原因 | 本报告结论强度 |
|---|---|---|
| 真实 325 MB 库的迁移/备份/恢复演练 | 未读写 `var/`；未做整 runtime 恢复 | AR-3/AR-4 的"恢复风险"为 E1+流程推断，未现场演练 |
| 读阻塞时延与占比 | 未在真实/合成大库压测 | AR-6 的 13.4 s 是历史事故注释，不是本轮实跑 |
| 生产部署、nginx/systemd 实际行为 | 未登录服务器；未跑 `nginx -t`/`daemon-reload`/watchdog 实际触发 | AR-8 的失败可见性为 E1（模板/脚本逐行） |
| n100 / FRP 家庭 profile | 本机无该环境 | AR-8 的 profile 差异为 E1 |
| Windows 运行时 | 本机 macOS | 跨平台脚本判据只做语法检查 |
| iOS 真机：HealthKit 后台投递、BGTask、background URLSession、WorkoutKit 读回、锁屏 | 无真机/Simulator 验收 | AR-10 的"顺序不可证"为 E2 推断 |
| 旧 iOS 构建 + 新服务端的 410 组合 | 未实跑旧构建 | AR-1 的可达性为 E2（链路/路由/UI 入口逐行）；写侧清账路径已由 L3 回源码确认 |
| Rust parity | 二进制早于源码，10 条用例显式 skip；未重建 | 不写成通过 |
| 预测训练子进程跨进程交互、OOM 后 systemd 是否拉起 | 未演练 | E3 推断 |
| 模型准确率/算法有效性 | 本机零有效比赛标签；本轮不评价 | 不涉及 |

---

## 10 附录

### 10.1 本轮核验产物与原始日志

- 本报告：`deliverables/ARCHITECTURE_REVIEW_2026-10-20.md`
- 分 lane 报告：`deliverables/architecture-review-2026-10-20/01-api-runtime.md`、`02-domain-data.md`、`03-ios-client.md`、`04-platform-quality.md`
- 共享简报：`deliverables/architecture-review-2026-10-20/BRIEF.md`
- 本机日志（gitignored）：`.workbuddy/runlogs/arch-review-2026-10-20/npm-test.log`、`test-ios.log`

### 10.2 关键量化指标（命令均可复跑）

| 指标 | 值 | 口径/来源 |
|---|---|---|
| 已跟踪文件 / 体积 | 1115 / 51.8 MB | `git ls-files`、`git ls-tree -r -l` |
| 代码规模 | API src 31,277 行（92 文件）；iOS 生产 38.7k 行（101 Swift）；packages 88.2k 行（含测试）；scripts 8.2k 行 | `git ls-files \| xargs wc -l` |
| 包与边 | 16 包 / 31 src 边 / 4 禁线 | `check:package-boundaries`（E2） |
| 路由 | 88 handler / 80 唯一路径（GET 51 / POST 29 / DELETE 4 / PUT 2 / PATCH 2）；37 写路由 | 运行期路由表（L1 E2） |
| 最大文件 | recompute-pipeline 4405 / database 4078 / HealthKitSync 3839 / HealthKitExport 3026 / data 2479 / server 2366 | `wc -l` |
| SQLite 存储 | 5 个文件（主/控制/runtime/dataset-epoch/restore-journal）；47 处生产 `new DatabaseSync` | `grep` |
| 迁移 | 主库 46 条（v1–v22 内联 1538 行，v23–v46 文件）+ 46 条冻结 checksum；其余 4 库无冻结 | `database.ts:136-1697,1740-1789` |
| 契约空间 | 4 个手写面 8,189 行；2026-09-01 起 32/454 提交改 ≥3 面 | Lead 脚本 + `wc -l` |
| 测试 | 2224 用例 / 280 文件 / 0 fail / 13 skip（598 s，concurrency=2） | `npm test`（E2） |
| 门禁面 | 105 npm script（42 条 `pre*`）；18 支 `.mjs` 不在 typecheck；5 个孤儿门禁 | Lane 4 |
| 部署 | 云端 983 行模板 / 16 条合同测试；n100 第二 profile | Lane 4（E2） |
| 文档 | 106 份 md / 703 本地链接 / 2 锚点（审查前）；`deliverables/README.md` 30 天 churn 47 次 | `check:docs`、`git log` |
| churn（30 天 / 319 提交） | `apps/ios` 782、`apps/api` 676、`application` 205、`storage-sqlite` 203；文件 `deliverables/README` 47、`api-contracts` 37、`data.ts` 32、`server.ts` 31 | Lane 4 / Lead |
| 依赖审计 | 4 moderate（onnxruntime 链）；无 high/critical | `npm audit --omit=dev` |

### 10.3 结论边界

本报告是**架构审查**，不替代：真实库迁移/备份恢复演练、真机与 Simulator 验收、生产部署验证、Windows 运行时验证、模型准确率评估。
"通过"只对应 §1 中列出的命令与数字；未列出的检查一律按**未验证**处理。

**收尾核验**（四份 lane 报告 + 本报告 + 索引写入后复跑）：`npm run check:docs` **EXIT 0**（112 files / 710 local links / 2 anchors / 0 problems）；
`npm run check:doc-refs` **EXIT 0**（141 处 / 越界 0 / 内容漂移未核对（无基线）/ 锚在空行 3 处告警）；
`npm run check:scripts` **EXIT 0**（18 package.json / 105 script）；`node scripts/check-blob-size.mjs` **EXIT 0**（1115 文件）。
`typecheck` / 全量 `npm test` / `test:ios` / `smoke:api` 见 §1（均 EXIT 0）。
产品代码零改动：`git status --short` 只显示 `deliverables/architecture-review-2026-10-20/` 新增目录与 `deliverables/README.md` 的索引行。
