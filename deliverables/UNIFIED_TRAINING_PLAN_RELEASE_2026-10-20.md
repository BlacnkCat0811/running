# 统一训练排课 v2 发布记录（2026-10-20）

- **发布提交**：`2f5f2b8`（`2f5f2b8ac6fb1c09b2462199e79c18271af5692d`）；本记录为紧随其后的文档提交。
- **上一生产版本**：`958e8f4`。
- **生产实例**：`101.33.202.40`（`VM-0-12-ubuntu`）；仓库 `/opt/rai`，服务 `rai-api`，nginx 反代 `https://tpandmr.xyz`。
- **范围**：`958e8f4..2f5f2b8`，80 个文件 / +11203 / -1584。内容为
  [统一训练排课核实与 PR1–PR7](UNIFIED_TRAINING_PLAN_VERIFY_2026-10-20.md) 的落地：唯一模式解析、
  剂量政策 v2、按自然周重新分配、F01–F06 修复、v2 协商读取/命令/事务内发布、自动协调器、
  旧接口 410 退役、iOS 统一入口与 Watch 撤回协议。
- **性质**：**有 schema 变化**（控制库 `mobile_control_schema` v1→v2，加表；主健康库仍是 v46，未变）、
  **有数据迁移**（控制库 `mobile_training_state`，已执行，见 §4）、`package-lock.json` 未变。
- 口径提醒：本记录只覆盖**本机判据 + 服务器侧实测**；iOS 未做签名构建/真机/Simulator 验收，
  不能读成端到端验收。

## 1. 提交内容

提交说明见 `2f5f2b8`。要点：

- API：`training-mode-policy`（唯一模式解析）、`training-plan-store`（统一状态 CAS + 迁移读侧）、
  `training-plan-commands`（配置命令，与旧 goals 镜像同事务）、`training-plan-routes`（v2 协商
  读取 + 命令/预览/刷新）、`training-plan-coordinator`（唯一自动重排判定）、`pre-race-activation`
  （G01-B）。
- 剂量政策 `v1→v2`（不可证明的边界不再落成数值）、F01/F02/F03/F04/F06 修复、按自然周
  「先义务、后候选」分配。
- 退役 `/v1/mobile/{goals, run-coach, workout-plan/{preview,confirm,generate}}`：路由保留、
  一律 410 `legacy_surface_retired`；删除不可达旧实现；`/lock` 保留。
- 控制库 schema 迁移 2（`mobile_training_state` / `_history` / `_migration_audit`，加表不改历史行）
  与 `scripts/migrate-training-planner.mts`（默认 dry-run；`--apply` 必须带 `sourceDigest`；只开控制库）。
- iOS：统一训练入口 + v2 客户端（`TrainingPlanStore` v2 快照、`PlanStatePolicy`、无 v1 回退）、
  Watch「先撤回再下发」协议；新增 `TrainingPlanV2Regression` / `PlanWatchContextRegression`。
- 测试与门禁：10 个新 API 测试文件、`check:training-plan-single-writer`（R1–R5）、
  `legacy-surface-retirement` 410 矩阵；本记录同时把 single-writer 门禁**接进 `.githooks/pre-commit`**
  （此前"判据存在但不在任何提交/CI 执行"，属于审查发现的执行缺口）。
- 一并提交了工作树既有的 6 个 iOS health-sync 改动（此前未提交；与统一排课无功能耦合）。

## 2. 本机判据（macOS 26.5 / Xcode 26.5 / Node v22.23.2）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（tsconfig.pure + tsconfig） |
| `RAI_TEST_CONCURRENCY=2 npm test` | **2224 tests / 2211 pass / 0 fail / 13 skipped**，耗时 585 s（并发 2） |
| `.githooks/pre-commit`（随提交实跑） | 通过：blob 体积上限、typecheck、`check:docs`、`check:doc-refs`、`check:scripts`、`check:ios-gates`、`npm run test:ios`（Xcode 26.5：Swift 类型检查 + 纯逻辑回归 + 10 支 python 门禁）、验收矩阵、计划定向回归、包边界 |
| `npm run check:docs` | 通过（105 files / 699 links / 0 problems） |
| `npm run check:doc-refs` | 通过（141 refs / 0 越界；内容漂移无基线未核对，见 §5） |
| `npm run check:scripts` | 通过（18 package.json / 105 scripts） |
| `npm run check:acceptance-matrix` | 通过（80 cited / 0 declared-gap / 0 missing） |
| `npm run check:package-boundaries` | 通过（16 包 / 31 src 边） |
| `npm run check:training-plan-single-writer` | 通过（违规 0，生产源 465 / 测试 122） |
| `npm run smoke:api` | 通过 |

skipped：13 条（Rust parity 用例，本机无 `cargo` / `rai-data-worker` 产物；生产 `RAI_IMPORT_ENGINE=typescript`）。

## 3. 部署与生产验证（2026-10-20 18:46 CST）

方式：`cd /opt/rai && sudo bash deploy/upgrade.sh --apply`（拉取 → `package-lock` 未变故跳过 `npm ci` → 重启 → 认证健康检查）。
**未使用 `--migrate`**：主健康库 schema 未变（v46），本批没有主库迁移文件。

- `HEAD=2f5f2b8`；`git status`（已跟踪文件）干净；`schema_migrations` 最新 version = **46**（未变）。
- 脚本健康检查：`GET /v1/health` 带令牌 `status=ok` 且 `databaseReady=true`；无令牌 = **401**。
- 控制库 schema：`mobile_control_schema` 出现 `version=2`（`2026-10-20T10:46:40Z`），
  新表 `mobile_training_state` / `mobile_training_state_history` / `mobile_training_migration_audit` 建好，
  旧表与旧行未改写（`mobile_goals` revision 仍 27、history 仍 28 行）。
- systemd：`Type=notify`、`WatchdogUSec=2min`、`NRestarts=0`；重启后 journal 无 error/exception/watchdog。
- 外部（本机 → `https://tpandmr.xyz` → nginx → API）：`/` = 404、`/assets/app.js` = 404、
  `/v1/health` 无令牌 = 401、`/v1/mobile/training-plan-state` 无令牌 = 401；`rai-access.log` 正常记录。

部署后（迁移前）接口矩阵实测：

| 请求 | 结果 |
|---|---|
| `GET /v1/mobile/training-plan-state`（v1） | 200（旧读取保持） |
| `GET /v1/mobile/training-plan-state` + `X-RAI-Training-Contract: 2` | 409 `training_plan_not_migrated`（预期，迁移前） |
| `GET /v1/mobile/goals`、`GET/POST /v1/mobile/run-coach` | 410 `legacy_surface_retired`（含 replacement） |
| `POST /v1/mobile/workout-plan/{preview,confirm,generate}` | 410 `legacy_surface_retired` |

（`GET` 对这些 POST-only 路由返回 404 是 Fastify 的方法不匹配，不是退役失效。）

## 4. 控制库数据迁移（2026-10-20 18:56 CST，经所有者会话确认）

迁移前置：控制库一致性在线备份
`/var/lib/rai/var/backups/rai-control-2026-10-20-pre-training-plan-v2.sqlite`（192 KB，schema v1）。

`scripts/migrate-training-planner.mts`（`--control-db /var/lib/rai/var/rai-control.sqlite
--server-id local --athlete-id athlete_1 --dataset-epoch default`）：

- **dry-run**：`source=run_coach` / `sourceStatus=active` / `derivedMode=race`（`race_goal_upcoming`，
  daysToRace 73，半马 2027-01-01）/ `goalsRevision=27` / `conflicts=[]` / `applyAllowed=true`，
  `sourceDigest=38549b1c…`。
- **apply**（停 `rai-api` → `--apply --expect-source-digest 38549b1c…` → 启动）：
  `status=applied`、`revision=1`、`readBackRevision=1`、`stateDigest=be2d0fd2…`、
  审计 1 行 / 历史 1 行；`mobile_goals` 未改写。
- 重启后（60 s 启动探针）协调器按 `plan_missing` 自动刷新：`stateRevision=2`（18:57:17 CST），
  `plan.days` 为 2026-10-20…10-26 的七日窗口（easy/rest/easy/easy/rest/easy/easy），
  v2 读取为 200 且 `plan.current=true`。
- 迁移后复查：`/v1/mobile/training-plan-state`（v2）= 200（contractVersion 2）；v1 = 200；
  410 矩阵不变；`/v1/health` 认证 200/无令牌 401；服务 `active`、`NRestarts=0`。

## 5. 跳过 / 未执行 / 已知缺口（不得并入"通过"）

- **iOS 端到端**：未做签名构建、真机安装、Simulator 与 `run-visual-tests.sh`；仅 `test:ios` 静态与纯逻辑判据。
- **旧客户端兼容**：旧 `/v1/mobile/*` 计划读写已按产品决定退役（410）。已安装的旧 iOS 构建**无法再编辑计划**；
  必须重新构建/安装本提交的 iOS 版本才能使用统一页面。
- **已知功能缺口（本批未修）**：统一页仍保留"手动课表"入口
  （`apps/ios/RAI/Skins/Technology/TechPlanView.swift:343` → `TechManualPlanView` → `saveGoals`），
  而 `PUT /v1/mobile/goals` 已 410；该入口在重新构建的 App 里仍会失败，需要后续用统一命令/读取重接或隐藏。
- **策略文档一致性**：`docs/TRAINING_PLAN_POLICY_REVIEW.md` 头部/§0.1 仍保留"G01–G03 阻断、等待签字"的
  旧状态，而 §4 签字表与代码（`pre-race-activation.ts`、`capacity-restart-v2`）已按批准候选落地；
  同一文档"三项批准均为零行为变化"的表述与 G01-B 新增赛前激活课不符。发布不改变这些代码，
  但后续评审应以 §4 签字表与实测为准。
- **行为变化**：`SESSION_DOSE_POLICY_VERSION` v1→v2 改变 policy hash，迁移后的 scope 由协调器自动重排；
  本次已在迁移后自动完成一次（state revision 2）。生成课表内容与旧版不同属预期。
- `check:doc-refs` 内容漂移未做：按日常提交口径（无 `.linerefs.json` 基线；输出"未核对（无基线）"）。
- `npm run ml:test`、`npm run rust:verify` 未执行：本批未修改 `research/`，本机无 Rust 工具链。

## 6. 回滚

- **代码**：`sudo -u rai git -C /opt/rai reset --hard 958e8f4 && sudo systemctl restart rai-api`。
  控制库 schema v2 是**加表**，旧代码打开 v2 控制库会跳过已记录迁移，不需要回滚数据库；
- **数据**（需要撤销迁移时）：停服 → 用 §4 的备份替换
  `/var/lib/rai/var/rai-control.sqlite`（连同 `-wal`/`-shm` 一并移走）→ 启动；
- 注意：备份只覆盖"迁移前"的控制库；迁移后产生的新回执/历史行会随备份恢复丢失，按运维判断取舍。

## 7. 结论

`2f5f2b8` 已推送 gitee 并部署生产（无主库迁移），控制库数据迁移与协调器自动刷新已完成并通过实测；
旧接口 410 与 v2 读取/命令端点在真实实例上均按合同工作。iOS 真机/Simulator 验收与 §5 的功能缺口
不在本次发布判据内，不得读成端到端验收。
