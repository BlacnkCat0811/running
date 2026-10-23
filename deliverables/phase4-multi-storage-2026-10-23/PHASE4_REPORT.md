# 阶段 4 多存储与发布一致性——实施与验收报告

**日期：** 2026-10-23（Asia/Shanghai）
**基线：** `/Users/ta/running`，`main`，HEAD `36d79a95f42f854d54e7dfb91e27eb21152a1fa1`；实施开始时 `git status --porcelain` 仅有 `deliverables/README.md` 的既有修改与阶段 4 方案文件（E2）。
**依据：** [阶段 4 实施方案](../../deliverables/PHASE4_MULTI_STORAGE_PUBLICATION_IMPLEMENTATION_PLAN_2026-10-23.md)、[阶段 3 状态合同](../phase3-import-analysis-2026-10-22/STATE_CONTRACT.md)、[阶段 3 发布记录](../PHASE3_IMPORT_ANALYSIS_RELEASE_2026-10-23.md)、[项目优化 PR-06](../../docs/PROJECT_OPTIMIZATION_PLAN.md)。
**性质：** 研发验收完成，**停在阶段门**；没有生产部署、没有对生产库执行备份/恢复/故障注入。
**证据口径：** E1 源码/schema；E2 本会话隔离执行；E3 未执行/推断。初验原始日志见 [evidence/SHA256SUMS](evidence/SHA256SUMS)；上一轮复核复验日志见 [evidence/remediation-2026-10-23/SHA256SUMS](evidence/remediation-2026-10-23/SHA256SUMS)；二次审查与本轮裁决见 §14。

## 1. 交付物

| 交付物 | 位置 | 状态 |
|---|---|---|
| 存储所有权矩阵 | [STORAGE_OWNERSHIP_MATRIX.md](STORAGE_OWNERSHIP_MATRIX.md) | 完成：五类库 92 张表逐表 + 8 视图 + 跨库边 + 文件级清单 |
| 一致性窗口图 | [CONSISTENCY_WINDOWS.md](CONSISTENCY_WINDOWS.md) | 完成：启动/导入/分析发布/计划发布/删库/恢复/CLI/关闭 8 条路径 + W1–W8 窗口 |
| 故障矩阵 | [FAULT_MATRIX.md](FAULT_MATRIX.md) | 完成：T01–T12 全部有当前 HEAD 证据；未执行项单列 |
| 冷备/恢复演练 | [BACKUP_RESTORE_REHEARSAL.md](BACKUP_RESTORE_REHEARSAL.md) | 完成：初验 29/29；复核后扩展演练 47/47（§13.5）；生产覆盖待确认 |
| 原始日志/清单 | [evidence/](evidence/SHA256SUMS) | 完成：套件日志、schema dump、baseline、rehearsal JSON、SHA256SUMS |
| 实施方案原文 | [PHASE4_MULTI_STORAGE_PUBLICATION_IMPLEMENTATION_PLAN_2026-10-23.md](../../deliverables/PHASE4_MULTI_STORAGE_PUBLICATION_IMPLEMENTATION_PLAN_2026-10-23.md) | 保留为方案，不改写其历史口径 |

## 2. 步骤 0：冻结基线（G0）

| 项 | 值 | 证据 |
|---|---|---|
| HEAD | `36d79a95f42f854d54e7dfb91e27eb21152a1fa1` | E2 `git rev-parse HEAD` |
| 工作树初始 | `M deliverables/README.md` + 未跟踪方案文件；无业务代码改动 | E2 `git status --porcelain` |
| Node / SQLite | v22.23.2 / 3.51.3 | E2 `process.versions` |
| 主库 schema | `schema_migrations` 最新 v47（47 条，冻结 checksum） | E2 `evidence/baseline-five-stores.json`、`evidence/schema-current-head.sql` |
| 控制库 schema | `mobile_control_schema` v1–v2 | 同上 |
| runtime schema | 无版本表；8 张表，启动幂等 DDL | 同上 |
| 本机五类存储 | 主库 present（324,943,872 B）、控制库 present（24,576 B）、runtime present（49,152 B）、epoch 侧车 **absent**、restore journal **absent** | E2 `ls var/*.sqlite*`；`absent` 不推断首次安装 |
| 实际部署配置 | **未读取**（本机无生产 `/etc/rai/rai.env`） | E3；路径结论只覆盖模板/隔离环境 |

**G0 判定：通过（生产路径结论待确认）。**

基线对齐：阶段 3 发布记录 `d03f4ae` 已部署；本阶段开始时 HEAD `36d79a9` 仅多一个文档提交。阶段 3 发布当次未跑测试的历史口径已过期，本阶段重新执行了适用套件（见 §7）。

## 3. 步骤 1：存储所有权（G1）

- 五类存储定义、路径规则、版本识别、正常存在性、写者、丢失裁决：见矩阵 §1。
- 主库 71 表 + 8 视图、控制库 10 表、runtime 8 表、epoch 侧车 2 表、restore journal 1 表：逐表在矩阵 §2–§5；机器核对见 `evidence/storage-table-coverage.json`（`missingFromMatrix: []`）。
- 跨库边 13 条（导入回执、发布意图、分析任务、模型 active、计划 revision/幂等、删库许可、epoch、恢复意图/epoch、来源、预测工件、迁移备份）：矩阵 §6。
- 非库文件：上传 ZIP/解压目录、`sources.json`、reports、预测工件、`var/backups`、quarantine、锁文件、临时文件：矩阵 §7。
- 未知项：生产实际配置、生产备份是否含五类库、PR-06 控制库 registry、legacy committed journal：矩阵 §9，均列为阻断/人工步骤，没有留空白“可重建”。

**G1 判定：通过（生产文件存在性未知项已显式列出）。**

## 4. 步骤 2：协调机制与窗口（G2）

- 机制清单与逐路径顺序：见 [CONSISTENCY_WINDOWS](CONSISTENCY_WINDOWS.md) §1–§2。
- 跨文件窗口 W1–W8：每个窗口的“最后持久点 → 下一持久点 → 重启裁决者”见 §3。
- 同库事务 / 跨库 detect+retry / 冷备恢复三种原子性分开写：§4。
- 可写 CLI 枚举 7 类 + 锁顺序：§2.7；锁顺序固定 **主库 → 控制库 → runtime 初始化锁**，无反向路径。
- **实测缺口与修复：** 控制库原先没有跨进程锁，`migrate-training-planner --apply` 只开控制库、不参与主库锁，API 在线时可以同时写控制库。本阶段新增控制库 publication lock（API 启动持有 + planner apply 取同一把锁），并用进程级测试证明在线时拒绝、离线时成功。
- 其余可写 CLI 审计：`data:init-scope --apply` 与 `data:backfill-canonical-nights --apply` 原先不取主库锁，本阶段补上；`data:migrate`/`data:import`/`data:recompute` 已有锁；报告型 CLI 只读，不需锁。
- 没有把 PID 存活或 HTTP 不通当作唯一互斥证据：锁冲突由真实 CLI/API 子进程与 SQLite 状态断言。

**G2 判定：通过（2026-10-23 初验）；复核 R1 发现符号链接别名可取得第二把锁，修复后于 §13.5 复验通过。**

## 5. 步骤 3：故障矩阵（G3）

T01–T12 的测试名、屏障、断言、日志：见 [FAULT_MATRIX](FAULT_MATRIX.md)。摘要：

| 场景族 | 结果 | 关键证据 |
|---|---|---|
| T01/T02 导入未提交/已提交丢响应 | PASS | `data-only-import.test.ts` SIGKILL；`import-worker-reuse.test.ts`；`import-restart-receipt-recovery.test.ts` |
| T03/T04 分析候选/模型发布 | PASS | `phase3-analysis-publication.test.ts`；新增 `phase4-model-release-crash.test.ts`（COMMIT 前 SIGKILL） |
| T05 控制库发布 | PASS | 双真实进程 guard 压测 + 20 例读一致性 |
| T06 读库替换 | PASS | 9 例 inode/mtime/WAL/租约 |
| T07/T08 删库/账本侧车 | PASS | 36 例删库恢复（强杀/损坏/错配/许可重放） |
| T09/T10 恢复三阶段/失败 | PASS | 8 例 restore journal + 43 例 maintenance |
| T11 CLI 互斥 | PASS（§13.5 复验） | 物理身份锁：23 例 publication lock + 10 例 phase4 进程级测试（含别名/硬链接/主控同文件） |
| T12 路径/冷备 | 见 §15 最新裁决 | §13.5 的 18 例与 47/47 是上一轮历史；二次审查发现 N1–N3 |

**未执行项：** 生产真实故障注入、systemd 停服/恢复、Windows 分支、真实训练 HTTP 全链路、跨机文件系统。已在 FAULT_MATRIX §“未执行项”单列，不以源码推断替代。

**G3 判定：通过（未执行项明确，不宣称生产通过）。**

## 6. 步骤 4：冷备、整套恢复、外置路径（G4）

- 路径闭包：新增 `scripts/check-runtime-backup-paths.mjs`；`deploy/backup-runtime.sh` 停服前检查、停服后生成 `path-manifest.json`、与 `runtime.tar` 一起 SHA-256。
- 外置主库/控制库/侧车：**拒绝**（exit 2），不再产生“成功但漏库”的归档。
- 缺侧车：`absent` 是合法状态，manifest 记录，不创建空文件。
- 活跃 WAL：manifest 记录 `walPresent/walBytes/shmPresent`；冷备仍要求停写。
- 隔离整套恢复：主/控/runtime/epoch 侧车 + 工件 + scope + 计划 revision/operation receipt + 导入回执全部一致；29/29 checks；归档 SHA-256 `4bb89f1e…`；隔离 RTO 4,899 ms（不是生产 SLA）。

**G4 最新判定见 §15。** §13.5 的隔离通过是历史记录，不能覆盖二次审查发现的 N1–N3；生产实际配置/备份覆盖仍待确认。

## 7. 步骤 5：最小修复与回归（G5）

### 7.1 代码改动

| # | 文件/符号 | 改动前 | 改动后 | 违反的不变量 | 负例/测试 |
|---|---|---|---|---|---|
| C1 | `apps/api/src/server.ts:223-247` `releaseControlDatabasePublicationLock` | 只持主库 publication lock；控制库可被在线 planner apply 交叉 | API 启动取主库锁后再取控制库锁，退出/`onClose` 一并释放；同路径配置显式拒绝 | I1 | `phase4-storage-locks.test.ts`：planner 持锁 → API 启动失败；API 在线 → planner 拒绝 |
| C2 | `scripts/migrate-training-planner.mts` `acquireControlLockOrFail` | `--apply` 不取锁；在线 API 时仍可写 | `--apply` 在打开控制库前取 `<control>.import.lock`，冲突 → `control_database_locked`；dry-run 不取锁 | I1 | `phase4-storage-locks.test.ts` ok 2/3；`training-plan-migration.test.ts` 11 例回归 |
| C3 | `apps/api/src/import-scope-cli.ts` `--apply` 分支 | 只取 runtime 初始化锁；主库文件移动/epoch 写无主库锁 | 先取主库 publication lock，再取 `var/import-scope-init.lock`；在读取 state 前取锁 | I1/I3 | 结构门禁 + 36 例删库恢复回归（含 `scope-abandon` 强杀） |
| C4 | `scripts/backfill-canonical-nights.mts` `--apply` | 直接开写连接 | `--apply` 取主库 publication lock | I1 | `phase4-storage-locks.test.ts` 可写 CLI 审计断言 |
| C5 | `deploy/backup-runtime.sh` + `scripts/check-runtime-backup-paths.mjs` | 只 tar runtime；不验证主库/控制库在根内 | 路径闭包检查、`--env-file`/显式路径、外置拒绝、`path-manifest.json` + SHA256SUMS | I8 | `deploy-n100.test.ts` 8/8；`phase4-storage-locks.test.ts` 路径闭包 |
| C6 | 文档：`docs/ARCHITECTURE.md`、`DATA_PIPELINE.md`、`OPERATIONS.md`、`DECISIONS.md` D19、`deploy/README-UBUNTU.md`、`README.md`、`deploy/rai.env.example` | “四个存储/四库”；控制库“无跨进程锁”；planner“不参与 publication lock” | 五类持久 SQLite、WAL/SHM、restore journal 可选出现、控制库锁与停服窗口 | F2/I1/I8 | `check:docs`、`check:doc-refs`、全文 grep 无残留“四库”口径 |

**没有 schema 迁移、没有数据迁移、没有新增写者、没有弱化既有锁/guard/epoch/回执。** C1–C4 只增加互斥与锁顺序；C5 只增加拒绝与 manifest；C6 是文档修正。

### 7.2 新增测试

- `apps/api/test/phase4-storage-locks.test.ts`（5 例）：控制库锁、API 启动拒绝、主库 CLI 锁、可写 CLI 审计、路径闭包/Token 不回显/WAL 记录。
- `apps/api/test/phase4-model-release-crash.test.ts` + 子进程（1 例）：T04 COMMIT 前 SIGKILL。
- `apps/api/test/deploy-n100.test.ts` 扩展：外置路径拒绝、manifest/SHA、无 env 拒绝。
- `scripts/phase4-backup-restore-rehearsal.mjs`：可复跑的整套恢复演练。

**旧数据兼容：** 无 schema 变更；控制库锁只创建 `<control>.import.lock`，不写控制库表；旧控制库 schema v1 仍由 `ensureControlSchema` 追加 v2；旧主库 v47 读取路径未改。回归套件含 `migration-policy.test.ts`、`dataset-epoch-legacy.test.ts`、`training-plan-migration.test.ts`、`dataset-deletion-recovery.test.ts`。

**G5 判定：通过。** 每个代码改动都有先红后绿的有效用例；没有把异常吞掉、清空账本、换随机 epoch 或把错误改 200 作为修复。

## 8. 不变量 I1–I8 对照

| ID | 状态 | 证据 | 边界 |
|---|---|---|---|
| I1 单写者/控制库不交叉 | **PASS（§13.5 复验）** | 物理路径身份锁：`publication-lock.test.ts` 23 例；`phase4-storage-locks.test.ts` 10 例（含 symlink/parent-alias/硬链接/主控同物理文件） | 生产停服窗口未实测；硬链接数据库被显式拒绝 |
| I2 任务持久/导入回执 | **PASS** | T01/T02；`import-restart-receipt-recovery.test.ts` 14 例 | worker 线程 vs 进程崩溃分开覆盖 |
| I3 deletion/scope/epoch 绑定 | **PASS** | T07/T08；`dataset-deletion-recovery.test.ts` 36 例 | 生产真实删库未执行 |
| I4 restore 幂等重放 | **PASS** | T09/T10；`restore-journal.test.ts` 8 例 | legacy committed 只能人工 |
| I5 跨库稳定读 | **PASS** | T05；`plan-publication-stress.test.ts` 双进程；`plan-read-consistency.test.ts` 20 例 | 跨机文件系统未测 |
| I6 active 指针只指通过 gate 的 run | **PASS** | T04；`model-release-v2.test.ts` S01；`model-run-repository.test.ts` | 真实训练 HTTP 全链路未注入 |
| I7 旧 inode/epoch 缓存 | **PASS** | T06；`read-store-manager.test.ts` 9 例 | inode 复用极端场景未注入 |
| I8 归档覆盖/整套恢复 | **见 §15 最新裁决** | §13.5 的 47/47 与 18 例为历史；N1–N3 修复证据在 §14 | 生产配置/备份覆盖待确认；归档校验需额外解包空间 |

**P0 违例：无。** **P1 发现并处理：** 文档四库口径（C6）、冷备路径前提（C5）、控制库在线 apply 空档（C1/C2）、scope/backfill CLI 缺主库锁（C3/C4）。**P2 保留：** 控制库 schema registry/checksum（PR-06 后续），不影响本阶段 I1–I8。

## 9. 门禁执行记录（2026-10-23）

| 命令 | 结果 | 日志 |
|---|---|---|
| `npm run typecheck` | EXIT 0 | `evidence/typecheck.log` |
| `RAI_TEST_CONCURRENCY=2 npm test` | **EXIT 0**：2486 tests / 2473 pass / 0 fail / 13 skip（856 s） | `evidence/full-suite.log` |
| `npm run check:docs` | EXIT 0（78 文档 / 627 链接 / 2 锚点） | `evidence/check-docs.log` |
| `npm run check:doc-refs` | EXIT 0（153 引用 / 0 越界；8 空行告警） | `evidence/check-doc-refs.log` |
| `npm run check:acceptance-matrix` | EXIT 0（80 cited / 0 gap / 0 missing） | `evidence/check-acceptance.log` |
| `npm run check:scripts` | EXIT 0（18 package.json / 108 scripts） | `evidence/check-scripts.log` |
| `npm run check:package-boundaries` | EXIT 0（16 包 / 31 边 / 4 禁线） | `evidence/check-package-boundaries.log` |
| `npm run check:training-plan-single-writer` | EXIT 0（499 生产源 / 145 测试 / 0 违规） | `evidence/check-training-plan-single-writer.log` |
| `npm run smoke:api` | EXIT 0 | `evidence/smoke-api.log` |
| `git diff --check` | EXIT 0 | `evidence/git-diff-check.log` |
| `npm run test:ios` | **未执行**（本阶段未触及 `apps/ios`；无 Xcode 时只会跳过） | — |

### 9.1 全量套件（初验，修复前代码状态）

以下 §9 的日志是**复核修复前**的初验记录，按复核要求原样保留；修复后的门禁与复验结果见 §13.5，不覆盖本表。

`RAI_TEST_CONCURRENCY=2 npm test`（2026-10-23，macOS x86_64，6 核）：

```
# tests 2486
# pass 2473
# fail 0
# cancelled 0
# skipped 13
# duration_ms 856129.552281
EXIT=0
```

13 个 skip 均为环境/平台原因，不是静默通过：3 个 Windows-only（路径别名、锁定的回滚文件、Windows 进程树），10 个 Rust worker 二进制比源码旧（测试明确要求 `npm run rust:build`，本阶段不重建 Rust 工件）。原始日志：`evidence/full-suite.log`。修复前的同一命令曾出现 3 个失败（P2-3/P2-10/P2-12 在 API 在线时调用 CLI `--apply`，被新的控制库/主库锁提前拒绝）；已把这三例的业务判据移到停服后验证，最终全量 0 失败。修复前日志保留为 `evidence/full-suite-pre-fix.log`，不作为最终结论。

## 10. 风险、未执行项与回滚

### 10.1 残留风险

1. **生产路径覆盖未验证**：生产 `/etc/rai/rai.env` 未读取。只读核对不再依赖“dry-run 会生成 manifest”这一错误前提（R4）；在维护窗口运行：
   ```bash
   sudo node scripts/check-runtime-backup-paths.mjs --runtime-root /var/lib/rai \
     --deployment-env /etc/rai/rai.env --out /root/rai-path-manifest.json --json
   # 等价：sudo bash deploy/backup-runtime.sh --output-dir /var/backups/rai \
   #   --env-file /etc/rai/rai.env --manifest-out /root/rai-path-manifest.json
   ```
   核对五类存储与 `inventory`；manifest 含部署路径（不含 Token），放受控位置。真实 service 环境/停服与生产恢复仍未执行，不能据此写“生产验收通过”。
2. **控制库锁的误伤**：若 operator 在 API 异常退出后看到 `control_database_locked`，按锁文件 owner/PID 检查；不要手工删除活锁。锁 liveness 规则与主库锁一致。
3. **备份脚本仍不是恢复脚本**：仓库没有 `restore-runtime.sh`；整套恢复是运维按 [BACKUP_RESTORE_REHEARSAL](BACKUP_RESTORE_REHEARSAL.md) §3.2 手工执行，不能把备份成功当恢复成功。
4. **PR-06 未做**：控制库没有 schema registry/冻结 checksum，未来控制库结构变更仍需独立批次。
5. **全量套件已终态**：`full-suite.log` 为 0 fail；修复前 3 个失败保留在 `full-suite-pre-fix.log`，仅用于说明测试前置条件变化。

### 10.2 回滚

- **代码回滚：** revert C1–C5。C1/C2 回滚后 API/planner 恢复“无控制库锁”的行为；C3/C4 回滚后 scope/backfill CLI 恢复无主库锁；C5 回滚后 backup script 恢复只 tar runtime（但**不要**在生产回滚 C5 后再用旧脚本做“成功”备份；必须保留路径检查或显式人工清单）。回滚不涉及 schema/数据迁移。
- **数据回滚：** 本阶段没有数据写入；控制库只新增锁文件（协调证据），可安全删除 stale 锁但需确认无活主。若生产已部署 C1 后需要回退，先停 API，删除 `<control>.import.lock` 的陈旧文件再启动旧版本。
- **单库恢复：** 必须生成新 dataset epoch 并重裁决其他库；不得声称控制库/runtime 一起回退。
- **整套冷备恢复：** 按 §3.2；移开旧根保留回退点，核对 `path-manifest.json` 与 SHA-256 后再启动。

## 11. 阶段停止点

- 本阶段交付物只处于工作树；**没有提交、没有推送、没有部署生产**。
- 下一个动作是人工评审本报告与四个分册；评审通过后再决定是否形成提交/发布批次。
- 不自动进入阶段 5（训练计划入口）或阶段 6（容量模型），不修改 iOS，不改变任何 `/v1` 合同或退役路由 `410` 语义。

## 12. 文件清单（本阶段改动）

**新增：**
- `scripts/check-runtime-backup-paths.mjs`（复核后重写为 manifest v2 / 递归闭包 / 显式路径）
- `scripts/verify-runtime-backup-archive.mjs`（复核 R2 新增）
- `scripts/phase4-backup-restore-rehearsal.mjs`（复核后扩展为 47 checks）
- `apps/api/test/phase4-storage-locks.test.ts`
- `apps/api/test/phase4-model-release-crash.test.ts`
- `apps/api/test/phase4-model-release-crash-child.mjs`
- `deliverables/phase4-multi-storage-2026-10-23/**`

**修改：**
- `apps/api/src/server.ts`（控制库锁）
- `scripts/migrate-training-planner.mts`（控制库锁）
- `apps/api/src/import-scope-cli.ts`（主库锁）
- `scripts/backfill-canonical-nights.mts`（主库锁）
- `deploy/backup-runtime.sh`（路径闭包/manifest）
- `apps/api/test/deploy-n100.test.ts`（扩展）
- `apps/api/test/dataset-deletion-recovery.test.ts`（P2-3/P2-10/P2-12：把 CLI `--apply` 的业务判据移到停服后执行，适配新的“CLI apply 必须先取主库锁”；断言本身不弱化）
- `docs/ARCHITECTURE.md`、`docs/DATA_PIPELINE.md`、`docs/OPERATIONS.md`、`docs/DECISIONS.md`、`deploy/README-UBUNTU.md`、`deploy/rai.env.example`、`README.md`、`deliverables/README.md`


## 13. 复核发现与修复复验（R1–R4，2026-10-23）

**性质：** 回应 [复核与优化实施方案](PHASE4_REVIEW_REMEDIATION_PLAN.md)。§1–§12 的初验统计与原始日志保留；本节用修复后的代码、新的定向日志与新的演练 JSON 重新裁决，不覆盖旧证据。复核前 G2/T11/I1 与 G4/T12/I8 一度标为“待复验”；本节给出复验结论。

### 13.1 复核发现

| 编号 | 发现 | 处置 |
|---|---|---|
| R1 | 锁文件由词法 `resolve(databasePath)` 派生；`alias.sqlite -> main.sqlite` 可取得第二把锁；主/控同文件判断也只比词法路径 | 批次 A：物理路径身份（见 §13.2） |
| R2 | 路径检查只检查列举的顶层目录，不递归；`tar` 默认把链接存成链接，恢复后权威来源可能悬空而 manifest 仍 `complete` | 批次 B：递归闭包 + 归档逐项摘要（见 §13.3） |
| R3 | 检查器在 `RAI_DATABASE` 缺省时按 `<runtime>/var/rai.sqlite` 猜；API 的缺省却是 `<projectRoot>/var/rai.sqlite` | 批次 B：两个库路径必须显式；service env 必须与备份 env 一致 |
| R4 | 报告 §10.1 要求用 backup dry-run 核对 `path-manifest.json`，但旧 dry-run 不生成该文件 | 批次 C：dry-run 新增 `--manifest-out`；§10.1 改为真正生成 JSON 的只读命令 |

### 13.2 批次 A：物理库锁身份（R1）

- `packages/storage-sqlite/src/publication-lock.ts` 新增 `resolveDatabasePathIdentity()`：
  - 存在的库：`realpathSync.native` 解析真实文件；锁名为 `<真实路径>.import.lock`，文件替换前后稳定（不用 inode）。
  - 首次安装（库缺失）：最深已存在祖先的 realpath + 剩余组件；两个父目录别名收敛到同一把锁。
  - 悬空链接、链接环（ELOOP）、不可解析路径、非普通文件：抛 `DatabasePathIdentityError`，**不回退词法路径**。
  - 硬链接：`nlink > 1` 的库文件显式拒绝（稳定错误），不声称“同一物理库”已被一把锁覆盖。
- `apps/api/src/server.ts` 启动时用同一身份函数比较主库/控制库；同物理文件时在取锁前拒绝启动。锁顺序保持主库 → 控制库，释放保持控制库 → 主库。
- `scripts/migrate-training-planner.mts` 的 `--apply` 仍在打开控制库写连接前取锁；身份错误翻译为 `control_database_locked`。
- 复验覆盖（真实子进程）：直达路径、文件符号链接双向、父目录链接、`link/..` 按文件系统顺序解析、缺失库首次安装双别名、硬链接拒绝、悬空链接、链接环、目录、文件替换后锁名稳定。每个拒绝例断言非零退出、锁 owner 未被覆盖、SQLite 行与文件 SHA-256 不变；释放后按同一别名重试成功。

### 13.3 批次 B：冷备路径闭包与配置来源（R2/R3）

- `scripts/check-runtime-backup-paths.mjs` 重写为 `rai-runtime-path-manifest-v2`：
  - **显式路径**：`--database`/`--control-database` 或 `--deployment-env` 中的 `RAI_DATABASE`/`RAI_CONTROL_DATABASE`；缺一个即 exit 2。相对路径也拒绝（检查器无法复现 service 工作目录）。
  - **递归闭包**：`var/imports`、`var/model-artifacts/prediction`、`var/backups`、`var/quarantine` 逐项 `lstat`；`var/reports` 仍随整根归档，但属于可重建报告，不参与权威闭包；任何符号链接（外部/悬空/根内）、不可读、FIFO/设备项都写入 `problems` 并以相对路径点名。五类 SQLite 及 `-wal`/`-shm`/`-journal` 必须是普通文件。
  - **inventory**：每个权威文件记录相对路径、类型、大小、mtime、SHA-256；目录记录类型。`--no-digests` 只用于停服前 preflight。
- 新增 `scripts/verify-runtime-backup-archive.mjs`：解包归档（先拒绝绝对路径/`..` 条目），逐项比对 manifest 的路径/类型/大小/SHA-256，比对权威树条目集合，并重读源根确认归档窗口后未删改。`deploy/backup-runtime.sh` 在发布最终归档前调用；失败则清理临时目录、恢复原服务状态、不产生 `rai-runtime-*` 最终归档。
- `deploy/backup-runtime.sh`：
  - `--apply` 读取 `systemctl show <unit> -p EnvironmentFiles -p Environment`；备份 env 不是 service 的 EnvironmentFile，或 unit/drop-in 声明的 `RAI_RUNTIME_ROOT`/`RAI_DATABASE`/`RAI_CONTROL_DATABASE` 与备份配置不同，停服前 exit 2。service 既无 EnvironmentFile 也无库路径声明时同样拒绝。
  - dry-run 新增 `--manifest-out FILE`，写出同一份 v2 manifest（R4）。
  - preflight 用 `--no-digests` 只判闭包；停服后生成带摘要的权威 manifest。
- 负例表（`deploy-n100.test.ts`，18/18）：仅 runtime root、外置主库、顶层/嵌套外部链接、悬空链接、库/WAL 链接、不可读文件、service env 不同、归档窗口后源文件变化、tar 失败清理/服务恢复、重启失败保留归档；每例在发布归档前非零退出，且服务保持原状态/无最终归档。

### 13.4 批次 C：报告与操作说明（R1–R4）

- 本报告新增本节；§10.1 的 dry-run 核对改成真正生成 JSON 的只读命令；旧日志与旧统计保留。
- [BACKUP_RESTORE_REHEARSAL.md](BACKUP_RESTORE_REHEARSAL.md) 更新路径闭包边界、覆盖表和 47 checks 结果，并保留初验 29/29 作为历史。
- [FAULT_MATRIX.md](FAULT_MATRIX.md) T11/T12、[STORAGE_OWNERSHIP_MATRIX.md](STORAGE_OWNERSHIP_MATRIX.md) §7、[CONSISTENCY_WINDOWS.md](CONSISTENCY_WINDOWS.md) 锁表同步物理身份与链接策略。
- `docs/OPERATIONS.md`、`deploy/README-UBUNTU.md`、`deploy/rai.env.example` 写明显式库路径、service env 核对、递归链接拒绝、归档校验与只读 manifest 命令；生产路径仍标“待确认”。

### 13.5 复验证据（2026-10-23）

| 命令 | 结果 | 日志 |
|---|---|---|
| `node --import tsx --test packages/storage-sqlite/test/publication-lock.test.ts` | 23 tests / 23 pass / 0 fail / 0 skip | `evidence/remediation-2026-10-23/publication-lock.log` |
| `node --import tsx --test apps/api/test/phase4-storage-locks.test.ts` | 10 tests / 10 pass / 0 fail / 0 skip | `evidence/remediation-2026-10-23/phase4-storage-locks.log` |
| `node --import tsx --test apps/api/test/deploy-n100.test.ts` | 18 tests / 18 pass / 0 fail / 0 skip | `evidence/remediation-2026-10-23/deploy-n100.log` |
| `node --import tsx scripts/phase4-backup-restore-rehearsal.mjs` | **47/47 checks pass**；RTO 12,416 ms（隔离）；归档 SHA-256 `8dcae82bd3ee…` | `evidence/remediation-2026-10-23/rehearsal-2.json` |
| `npm run typecheck` | EXIT 0 | `evidence/remediation-2026-10-23/typecheck.log` |
| `RAI_TEST_CONCURRENCY=2 npm test` | **EXIT 0**：2510 tests / 2497 pass / 0 fail / 13 skip（853,596 ms，并发 2） | `evidence/remediation-2026-10-23/full-suite.log` |
| `npm run check:docs` / `check:doc-refs` / `check:acceptance-matrix` / `check:scripts` / `check:package-boundaries` / `check:training-plan-single-writer` | 全部 EXIT 0（79 文档 / 648 链接 / 0 problems；验收矩阵 80 cited / 0 gap） | `evidence/remediation-2026-10-23/check-*.log`、`gates.exit` |
| `npm run smoke:api`（`deploy/` + `server.ts` 变化） | EXIT 0 | `evidence/remediation-2026-10-23/smoke-api.log` |
| `git diff --check` | EXIT 0 | `evidence/remediation-2026-10-23/git-diff-check.log` |

全量套件复跑记录：`connection-contention.test.ts` 在并发负载下两次出现时序抖动（持锁 600 ms 窗口被 tsx/子进程启动开销吃掉，实测等待 148 ms < 200 ms）。把该测试夹具的持锁窗口从 600 ms 提高到 2000 ms（断言 `waited >= 200 ms`、错误形态和被测生产代码均未改），隔离重跑 2/2 通过，最终完整套件 EXIT 0。失败日志保留为 `evidence/remediation-2026-10-23/full-suite-run2-flake.log` 与 `full-suite-run3-flake.log`。

扩展演练新增覆盖：restore journal **实际存在**（prepared，API 启动时走到终态并清空 intent）、未终态 source/job 原样恢复、保护快照、active model release bundle、非空 WAL 样例（SIGKILL 保留 `-wal`）、外部/悬空/根内链接三类拒绝裁决、恢复后 manifest 每项可读性与摘要复核。旧演练 `rehearsal-1.json` 的 29/29 保留为初验证据。

### 13.6 复验结论

以下是上一轮 R1–R4 完成时的历史裁决；二次审查 N1–N3 发现其 G4/T12/I8 覆盖不足，最新裁决见 §14。

| 阶段门 | 复验结论 | 边界 |
|---|---|---|
| G2 / I1 / T11 | **PASS**：同一物理库无法被两个路径并发取锁；主/控同物理文件拒绝启动；锁顺序无环 | 生产停服窗口未实测；硬链接库被显式拒绝；旧版锁协议切换需先停所有旧写者 |
| G4 / I8 / T12 | **PASS（隔离）**：递归闭包；归档条目/类型/摘要一致；链接负例全部拒绝；含 journal/WAL/未终态任务的恢复演练 47/47 | 生产 `/etc/rai/rai.env`、真实 systemd、生产规模 RTO/RPO 未执行；归档校验需要额外解包空间（约 1×归档大小） |
| 全仓门禁 | 见 §13.5（typecheck / 定向测试 / 文档门禁） | Windows 链接与进程身份分支本机未执行 |

**结论：** R1–R4 的代码与隔离验收已完成，G2/T11/I1 与 G4/T12/I8 从“待复验”改为“隔离环境复验通过”。生产前人工门仍未完成，不能写“生产验收通过”。

### 13.7 残余风险

1. **锁协议切换窗口**：新锁名是物理身份。部署必须先停所有旧 API/CLI 写者，再切新版；不得把旧版 stale 锁清理当成活锁判断。
2. **硬链接策略是排他的**：`nlink > 1` 的数据库文件一律拒绝取锁；若未来需要多硬链接名，必须另行设计并验证单一锁身份，不能只修符号链接。
3. **TOCTOU**：主/控身份比较与取锁之间若有人恶意改链接，取锁会重新解析并失败关闭，但比较本身不是原子操作。
4. **归档校验成本**：`verify-runtime-backup-archive.mjs` 解包到临时目录逐项哈希；需要约 1×归档大小的额外磁盘与相应 IO，属于停服窗口成本。
5. **Windows 未执行**：符号链接、硬链接、`realpathSync.native` 分支只在 macOS 验证；Windows 对应测试会在该平台执行/跳过，不宣称跨平台通过。

## 14. 二次审查 N1–N3 修复与重新验收（2026-10-23）

依据 [二次审查与验收方案](PHASE4_SECOND_REVIEW_AND_ACCEPTANCE_PLAN.md)。本节覆盖 §13 的 G4/T12/I8 旧裁决；§13.5 的 18 例、47/47 与全量日志保持原样，不能倒写为当时已经覆盖 N1–N3。G2/T11/I1 的上一轮隔离结论不变。

### 14.1 代码修复

| 发现 | 修复 | 失败关闭位置 |
|---|---|---|
| N1：env 文件与 CLI 覆盖值可不一致 | `backup-runtime.sh` 禁止混用；新增 `resolve-runtime-backup-service.mjs`，只接受单份必需 EnvironmentFile 且无路径覆盖，或无文件且 `Environment=` 直接明确三路径。多份/可选文件、`UnsetEnvironment`、重复键和不支持的路径写法拒绝；服务实际配置的同一组三路径传给 preflight 与停服后 manifest，由检查器规范化并拒绝链接。manifest 的 `serviceConfiguration` 记录来源、env 文件和规范化路径，不含 Token。 | `systemctl stop` 之前；错误不生成最终归档 |
| N2：`absent` 权威树在归档窗口变型 | 校验器重扫四棵权威树的源根与解包根；`absent` 必须仍不存在，`present` 的路径和类型集合与 manifest 完全一致；已有文件继续核对大小与 SHA-256。 | 最终 `mv` 之前；清理临时目录并恢复原 active 状态 |
| N3：记录危险 tar 名称后仍解包 | 校验 manifest 的规范相对路径；解析 tar header 和成员类型，拒绝绝对/父路径、重复或冲突名称、链接、特殊类型和不支持的扩展；然后仅创建普通文件/目录进行受限解包，不调用 `tar -xf`。 | 解包目录创建之前；不会触碰目录外标记文件 |

macOS tar 默认可能加入 AppleDouble `._` 成员而不在 `tar -tf` 显示；备份与隔离演练创建 tar 时设置 `COPYFILE_DISABLE=1`，确保 header 与可见清单一致。校验器对其他来源中无法证明的成员直接拒绝。

### 14.2 隔离复验与证据

新证据目录为 [evidence/second-review-2026-10-23/](evidence/second-review-2026-10-23/SHA256SUMS)。二次审查文档 §1 保留 N1/N2 的修复前隔离复现和 N3 控制流事实；本轮定向 TAP 是修复后证据，不把审查记录伪装成原始终端日志。

| 检查 | 本轮结果 | 证据 |
|---|---|---|
| `node --import tsx --test apps/api/test/deploy-n100.test.ts` | 41/41 pass：N1 两种 env/CLI 错配、多份/可选 env、UnsetEnvironment、链接库路径及直接配置正例；N2 八类 tar 前变化和两类 tar 后变化（含父目录链接）、late WAL/`-journal` sidecar 与 CLI publication lock 拒绝；N3 五类危险 tar。N1 停服前、N2 发布前失败；正例校验 manifest。 | `deploy-n100.log` |
| `node scripts/phase4-backup-service-witness.mjs <证据 JSON>` | 隔离 systemctl/flock 替身：正例 exit 0，stop→start、状态回到 active，`closure=complete`，归档 8 项；N1 原错配例 exit 2，未调用 systemctl、无最终归档。JSON 含五类存储状态/摘要、三路径、tar 条目及归档 SHA-256。 | `service-witness.json` |
| `node --import tsx scripts/phase4-backup-restore-rehearsal.mjs` | 47/47 pass；恢复根的权威项按 manifest 摘要复核。 | `rehearsal-3.json` |
| `npm run typecheck` | exit 0 | 本轮执行记录 |
| `node --import tsx --test apps/api/test/dataset-deletion-recovery.test.ts` | 36/36 pass；只读断言等待恢复中的短暂 SQLite 写锁。 | `dataset-deletion-recovery.log` |
| `RAI_TEST_CONCURRENCY=2 npm test` | 2534 tests / 2521 pass / 0 fail / 13 skip（并发 2） | `full-suite.log` |

前两次全量回归（并发 2）分别在原有恢复测试 P2-17、P2-3 的只读 SQLite 断言处遇到瞬时 `database is locked`，于第 210/185 例中断；日志保留为 `full-suite-interrupted-lock.log` 和 `full-suite-interrupted-lock-2.log`。本轮给这些只读辅助查询设置 `PRAGMA busy_timeout = 5000` 等待恢复中的短暂写锁，且单独重跑该文件 36/36 通过；最终全量结果在本节门禁表补录。

### 14.3 最新裁决与边界

G4/T12/I8 在 N1–N3 的**模板与隔离环境**范围内已修复，生产前人工门仍待执行：检查实际 unit/drop-in、EnvironmentFile 列表与脱敏后的生效三路径，并在同一停写窗口保存备份、隔离恢复记录。无独立 CLI 写者仍是冷备前提；源根复扫提供变化证据，不能代替停写。当前未访问生产配置、未操作真实 systemd、未做生产规模 RTO/RPO 验证，因此不宣称生产验收或发布完成。

## 15. 未提交改动评审后的修复（2026-10-23）

本节记录 §14 之后发现的两个边界；§14 的 41 例与全量套件日志仍是当时的历史结果，不把本次修复倒写进旧证据。

| 发现 | 修复与回归判据 |
|---|---|
| 导入 CLI 在物理身份解析前对 `--database` 做词法 `resolve()`；路径含“符号链接后接 `..`”时可能与 API 选择不同的库 | 保留原始路径供 `resolveDatabasePathIdentity` 使用；API-owned 候选库仍在身份解析前做别名校验，默认 native spool 根随最终物理库路径。新增真实双库/符号链接测试：持有 API 所指库的锁时 CLI 被拒绝，释放后同一命令成功。 |
| active service 的 `MainPID` 缺失或无效时，冷备只告警并继续 | `backup-runtime.sh --apply` 在停服前 exit 2，不生成最终归档；集成测试断言 PID=0 与运行环境校验失败都不能停服或发布。隔离 service witness 改为提供 PID 并证明校验器被调用。 |

本轮执行：`cli-atomic.test.ts` **9/9**、`deploy-n100.test.ts` **43/43**、隔离 service witness、`npm run typecheck`、`npm run check:docs`、`npm run check:acceptance-matrix`、`npm run smoke:api`、`bash -n deploy/backup-runtime.sh` 和 `git diff --check` 均通过。未重跑全量 `npm test`，未操作真实 systemd 或生产存储；生产前人工门与 §14.3 一致。
