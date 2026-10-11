# 项目审查

审查日期：2026-09-30（Asia/Shanghai）。基线提交：`f33ec708802d4b7cc4f6284af7e84efa4b5800cd`，对象为包含前一轮算法改动的**当前未提交工作树**，不是只审HEAD。
范围：文档、TS领域与数据/发布边界、API安全/命令、Web、现有iOS同步/凭证、Python训练、Rust执行器、部署与测试入口。
**当前结论：文档清理完成，R1–R4代码修复及本机相关回归已完成；原始边界探针从3项违反变为0项。真实Windows运行时、真机和线上部署未在本轮执行，不扩大验收结论。**

入口：[README](../README.md)；现行合同：[算法](ALGORITHM.md)、[数据管线](DATA_PIPELINE.md)、[决策](DECISIONS.md)。

## 1. 问题与修复（保留原审查证据）

以下问题描述是修复前行为；每项的“已完成修复”说明当前实现。修复后的验证见§7，不将原始失败证据覆盖成通过。

### R1 · P1（已修复）：旧bundle激活不检查当前override，可恢复已排除训练的评分

**位置**：[release repository](../packages/storage-sqlite/src/model-release-repository.ts) `verifyAndPoint`；[application service](../packages/application/src/service.ts) `appendWorkoutOverride`。

- `verifyAndPoint`只验证已存lineage自身hash、快照hash、datasetVersion和active关系，没有把lineage的overrideSnapshotHash与当前有效override比较。
- 保存反馈/排除覆盖不会修改datasetVersion，因此旧已发布bundle仍能通过激活。HTTP模型切换与命令队列都调用这一路径。
- **合成复现**：先建立模型A → 把一条训练设为exclude并重算B → 再激活A。当前override仍为`exclude`，active assessment却从`excluded`回到`eligible`，没有拒绝。
- **影响**：当前用户设置与当前评分结果矛盾；“回滚算法”实际上回滚了派生结果使用的事实修订，却没有让用户确认这个区别。
- **建议修复**：激活时同时验证当前facts/override语义版本；不兼容旧run仅允许历史比较，或按目标旧政策在最新事实/override上生成新的受控bundle。新增API/CLI两入口的失败不换指针回归。

**已完成修复**：V4发布/激活/回滚对当前有效override ID序列计算语义hash，与捕获的lineage hash比较；V3兼容路径对照training metric config中的overrideSnapshotIds，不能借旧schema绕过。发生中途revision变化时保留计算时的冻结事实，但拒绝发布，旧active/bundle指针不动；按最新覆盖重算后才可发布。不同覆盖的旧run仍可历史查看，不可成为当前。真实桌面HTTP流程验证409、明确错误提示与指针不变；同事实rollback仍有成功回归。

### R2 · P1（已修复）：训练全部删除后，空结果重放被gate挡住，旧派生结果仍active

**位置**：[transition gate](../packages/storage-sqlite/src/model-transition-gate.ts) `evaluateModelTransitionGateV2`；[recompute pipeline](../packages/application/src/services/recompute-pipeline.ts) 发布分支。

- 前一轮已修复部分训练删除和校准证据删除，但`matchedSessions===0`仍无条件进入`not_evaluable`。
- **合成复现**：10条训练已发布 → 全部明确设为inactive、清canonical关联、更新dataset版本 → 完整重算。job失败，报`Model-version gate failed: not_evaluable`，active派生评估仍有10行。
- **影响**：合法的“删除最后一条/全部训练”无法完成新空结果发布；不能继续声称T02覆盖全部删除边界。这里复现的是派生结果发布阻塞，不声称原始记录被复活。
- **建议修复**：增加“所有来源均已明确删除、候选确实为空”的可审计空状态转换，不全局放宽no-matched保护；验证无解释候选漏行仍被挡住、空状态所有下游一致及失败回退。

**已完成修复**：新增由数据库现场计数生成的emptyCohort证据，要求旧训练全部明确inactive、没有仍active/ambiguous的来源、候选feature/assessment/load/daily/checkpoint与训练domain快照为空，并保持恢复隔离和其余硬gate。只对这种已证明的空转换免除no-matched；未知scale、缺证明、NaN/残留行、仍有来源的历史空截止仍拒绝。回归覆盖全部删除、空→空重算、正常部分删除、无解释丢行与失败不换指针。没有把5%阈值调大。

### R3 · P2（已修复）：正常保留清理会丢失当前epoch的生效日期

**位置**：[baseline review](../packages/application/src/baseline-rebase-review.ts) `buildBaselineRebaseReview`；[release repository](../packages/storage-sqlite/src/model-release-repository.ts) `retireOldReleases`。

- 检查器从创建该epoch的release evaluation读取effectiveAt；后续相同epoch的run不携带这份独立生命周期信息。
- 保留策略只保留当前及有限历史release，会清理epoch起始收据。检查器随后静默退回checkpoint中的历史校准训练日期。
- **生产路径合成复现**：显式rebase后，同配置完整重算3次触发正常清理；epoch ID不变，起始收据已删除，`startedAt`从`2026-01-31T04:00:00.000Z`变为`2026-01-19T00:00:00.000Z`。
- **影响**：epoch年龄/90日冷却会按错误日期计算，审计链不完整；这会提前允许候选请求，但不等于系统已经自动rebase（自动发布仍关闭）。
- **建议修复**：epoch生命周期元数据独立持久化，或在所有依赖的epoch/run退役前pin起始记录；加多轮重算+清理后的日期/冷却恒定测试，而不只测“某个旧bundle暂时还在”。

**已完成修复**：不另建重复epoch表或新迁移；将当前及保留rollback版本依赖的epoch起始release列为清理依赖，按dataset+epoch保留它。原有run pruning因此也保留其run/工件；最后一个依赖epoch版本退役后，起始receipt可正常清理，不永久pin全部历史。读端按相同dataset定位effectiveAt。多次真实重算/清理后日期与epoch不变，另测跨epoch退役后的正常回收。此前已经被删除的历史元数据无法凭空恢复，本修复不会伪造effectiveAt。

### R4 · P2（已修复）：根npm test使用POSIX语法，与声明的Windows CI入口不兼容

**位置**：[package.json](../package.json) `scripts.test`；[CI](../.github/workflows/ci.yml) `windows-runtime` job。

- 脚本用`;`、`node_status=$?`、`test ... -eq ...`组合Node和Web测试；这是POSIX shell语法。
- Windows job直接运行`npm test`，仓库未配置Windows npm script-shell；npm默认Windows命令解释器不提供这些语法。外层CI步骤使用PowerShell也不会把npm内部脚本变成POSIX。
- **证据等级**：源码/配置确认，**本机macOS未执行Windows运行时复现**；macOS测试通过不能证明Windows gate有效。
- **建议修复**：用Node脚本分别启动两组测试、汇总退出码，或明确且验证跨平台shell依赖；在真实Windows环境验证故意失败的子测试会传递非零退出码。

**已完成修复**：[Node测试入口](../scripts/run-tests.mjs)直接用process.execPath与shell:false运行Node及Vitest；显式枚举TS测试文件，不依赖shell glob、分号、$?或npm.cmd。任一子组失败/无法启动均返回非零，普通失败后另一组仍运行；SIGINT/SIGTERM中断不继续下一组。真实Node子进程回归验证四种成功/失败组合、带空格路径、启动错误和取消传播；package入口与Windows CI接线有断言。实机Windows未在本机执行，不能把这些测试改述成Windows现场验收。

### 可复现探针

[R1–R3探针](../scripts/review-model-boundaries.mts)只创建并清理临时合成SQLite/XML，不碰真实数据库：

```bash
npm run review:model-boundaries -- --out /tmp/rai-model-boundaries.json
```

原始审查产物：[model-boundaries.json](../deliverables/project-review-2026-09-30/model-boundaries.json)，当时exit=1、violationCount=3。修复后产物：[model-boundaries-after.json](../deliverables/project-review-2026-09-30/model-boundaries-after.json)，exit=0、violationCount=0；exit=2仍表示探针前置失败，不能当缺陷证据。
R1两次重算使用同一当日时间窗口，避免把数月停跑衰减误当override问题；R3通过真实重算触发保留清理，非仅手工删收据。

后续已按用户明确要求修复四项；没有为获得全绿放宽原模型阈值，也没有取消override或rebase保护。

## 2. 文档整理结果

| 项 | 结果 |
|---|---|
| Markdown | **192 → 20份**（减少约89.6%）；删除179份旧Markdown，新建7份整合入口/说明 |
| 已跟踪过期文件 | 删除198份：179份Markdown及19份旧核验JSON/行号快照等；可通过Git历史恢复 |
| 顶层现行说明 | README + 架构/算法/数据/运维/决策/Web/本报告；平台专用合同、同步ADR、部署、研究与视觉说明保留 |
| 重复时点报告 | 删除旧PRD、V2批次、多个状态/审计及未立项Watch/N100计划，不继续复制archive |
| 视觉资产 | 保留原截图/HTML资产，合并批次README并修复HTML入口；旧截图不宣称本轮验收 |
| 运行时数据审计 | `docs/DATA_AUDIT.md`取消跟踪并忽略；仍可由导入/审计命令生成，不再当产品规范 |
| 检查入口 | 新增`check:docs`并接入pre-commit与CI配置；算法54项矩阵迁到[现行合同](ALGORITHM.md) |

**不是删除检测来掩盖漂移**：废弃的逐行位置快照随旧文档移除，现行说明采用文件路径/函数名；`check:doc-refs`仍保留。该默认检查本轮有0条数字行号引用，不据此声称语义正确；真正的本地链接和孤立文档检查由`check:docs`负责。
新检查验证当前Markdown内联本地链接/文档可达性，不拉取远程URL、不认证自然语言与源码一致性、不检查所有HTML资源和heading fragment。
清理明细、保留映射和本轮检查摘要见[verification.json](../deliverables/project-review-2026-09-30/verification.json)。

## 3. 修复前审查的检查结果（历史保留）

| 命令/层级 | 本轮结果 |
|---|---|
| `npm run typecheck` | 通过，包含scripts及纯领域边界 |
| `npm test` | Node **1154项 / 1151通过 / 0失败 / 3跳过**；Web **18文件 / 111项通过** |
| `npm run build` | 通过，由桌面E2E前置执行，包含bundle检查 |
| `npm run test:e2e:web` | **10通过 / 0失败 / 1跳过**；跳过390px冻结用例 |
| `npm run test:ios` | 类型检查67个Swift文件通过（3个高德依赖文件按现有gate排除）；纯逻辑/DTO/同步/展示回归通过 |
| `npm run ml:test` | **26通过** |
| `CARGO_NET_OFFLINE=true npm run rust:verify` | 现有工具链离线构建通过；Rust **2项**、TS/原生导入 **11项**通过，无skip |
| `npm run smoke:api` | 隔离临时runtime启动/关闭检查通过 |
| `npm audit --omit=dev --json` | registry报告production依赖已知漏洞 **0**；不代表完整安全审计无风险 |
| 文档 / matrix / package boundaries | 通过；matrix **54 cited / 0 declared-gap / 0 missing**，包边界 **15 packages / 30 src edges** |
| 文档检查器回归+部署文档合同 | **5项通过**，包含坏链接/孤立文档/越界目标拒绝 |
| 新增边界审查 | **未通过：R1、R2、R3均已复现**；不隐藏在上面的通过数中 |

Node的3个skip属于Windows路径别名、锁定文件回滚、Windows进程树语义；未在macOS假装验证。
最初全量运行曾发现部署测试仍读取已删除的重复说明，现已将测试目标改为唯一部署文档并保留安全断言，重跑全量通过。

## 4. 审查覆盖与限制

| 层 | 本轮动作与结论边界 |
|---|---|
| 领域/ML | 核对恢复隔离、缺失/可得时间、残差/区间门槛与版本合同；跑Node/Python回归，不在零标签时评价准确率 |
| 数据/发布 | 审核身份、tombstone、override、checkpoint、generation、bundle、保留和回滚；3个额外合成探针暴露R1–R3 |
| API/安全 | 检查Bearer/Host/Origin、公开路由边界、异步命令revision/idempotency、备份/导入、CSV输出；现有集成与启动冒烟通过，未做公网渗透测试 |
| Web | 核对请求取消/旧响应、反馈与任务终态、桌面入口和契约；桌面E2E通过，不修改/运行窄屏验收 |
| iOS | 核对生产SwiftUI路径、同步事务/作用域、凭证隔离和后台机制合同，运行自动gate；没有真机HealthKit/后台调度/地图/视觉验收 |
| Rust/部署 | 验证私有候选写许可、取消/失败与合同parity；核对systemd/Nginx/env/备份方案，未登录线上服务器 |
| CI/跨平台 | 核对实际远端为Gitee；GitHub workflow存在不代表已触发；Windows入口R4代码已修复，实际Windows运行时仍未验证 |

“完整审查”指覆盖上述组件与关键风险路径，不等于穷尽每条执行路径或证明没有其它缺陷。
未安装新大型SDK/依赖、未跑responsive/full E2E、未开启常驻shadow、未修改iOS业务源码或冻结Web代码。

## 5. 原库与前一轮证据

本机原库：schema22、268条training session、active config/feature v3、零有效比赛/测试标签；不代表线上状态。
前一轮曾在独立副本完成schema25/V4重算、轨迹对照及保留bundle回滚/重开，固定时点证据保留在[产物目录](../deliverables/README.md)。这些结果不覆盖本轮新发现的override/全部删除/epoch保留边界。
原库SHA-256仍为`cef127be078031b66072eda5d0ecc4552d1d70a5d95898ebd9ff1420aa4b957d`；本轮未迁移、重算、删除或激活原库模型。
天气/独立标签不足时，拟合归一化、Durability数值罚分、ML/经验P80/P90继续关闭；工程通过不等于已经部署或准确率改善。

## 6. 剩余部署边界

四项代码修复完成不等于真实主库已经迁移或线上发布。Windows现场验证仍交由真实Windows CI/主机；原库升级需独立维护窗口、备份和迁移审查。未校准ML/耐久罚分/经验区间仍不启用。

## 7. 四项修复后的验证

| 检查 | 修复后实跑结果 |
|---|---|
| 类型检查 | `npm run typecheck`通过 |
| 新Node入口全量测试 | Node **1163项 / 1160通过 / 0失败 / 3项Windows-only跳过**；Web **18文件 / 111通过** |
| 定向修复回归 | **28通过 / 0失败**：覆盖旧override拒绝/同事实允许、空数据正反例、epoch依赖保留与回收、测试入口错误码传播 |
| 桌面E2E（含build） | **10通过 / 0失败 / 1项390px跳过**；旧覆盖模型激活现在必须真实返回409并保持指针，而不是沿用旧不安全的成功断言 |
| 原始R1–R3边界探针 | **exit=0 / violationCount=0** |
| 真实数据副本发布演练 | schema25/V4、全量/增量轨迹、保留bundle回滚与重开通过；源库hash仍未变 |
| 原有迁移/阈值 | 本轮无新迁移，不修改历史migration/checksum，不放宽既有数值阈值 |

本轮未修改iOS业务代码/Python/Rust实现，未重新运行其平台门禁；§3的结果明确属于此前完整审查。只修改了桌面E2E用例，未改390px冻结块。
新的机器核验摘要：[fixes-verification.json](../deliverables/project-review-2026-09-30/fixes-verification.json)。此前的失败产物和审查摘要保持原样，避免重写历史证据。

## 8. 后续批次收尾索引（2026-10-09 ~ 10-11）

§1–§7 是 2026-09-30 那次审查的时点快照。其后三个批次已提交并部署，各留过一份「当轮」审查/验收文档；
按 [核验产物目录](../deliverables/README.md) 的约定「收尾后并入本文件或删除」，**原文档已删除**。
**本节只记指针，不重述结论**；需要原文时按下表路径从 Git 取回。

| 批次（主题） | 收尾提交 | 原文档（已删，可用 Git 恢复） |
|---|---|---|
| HealthKit 记录同步 v2：v30/v31 迁移 + 逐类型变更游标 + 类型作用域 UUID 删除 | `e05f59e` → `308fee9`（已提交并部署） | `deliverables/UNCOMMITTED_REVIEW_2026-10-09.md` |
| iOS 数据同步失败修复：普通同步不再全量重扫 + 导入失败诊断可见 + 失败上传包保留 | `0c01f7d` → `14bda36`（已同步并部署） | `deliverables/UNCOMMITTED_REVIEW_2026-10-10.md` |
| 纯补史导入被资格漂移门禁永久死锁的修复 | `cebb0dc` → `f2e5da0`（验收证据） | `deliverables/VERIFICATION_2026-10-11-source-backfill.md` |
| iOS `jobId` 前台续接 + 逐类型进度文案 + live 探针陈旧源文件清单 | `076b8bd` / `6ea930f` → `5950a11` | `deliverables/VERIFICATION_2026-10-11-ios-resume.md` |

取回单份原文：`git show <收尾提交>:<原文档路径>`，或用 `git log --follow -- <路径>` 定位。
`UNCOMMITTED_REVIEW_2026-10-11.md` **不在**本表：它是尚未收尾的当轮批次，仍留在核验产物目录。
