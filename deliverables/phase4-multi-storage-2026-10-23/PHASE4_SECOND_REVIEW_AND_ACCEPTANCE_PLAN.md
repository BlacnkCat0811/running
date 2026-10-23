# 阶段 4 报告二次审查与优化验收方案

**审查日期：** 2026-10-23（Asia/Shanghai）
**审查基线：** `main`，HEAD `36d79a95f42f854d54e7dfb91e27eb21152a1fa1`；阶段 4 的代码、测试和报告仍在工作树中。
**范围：** [实施验收报告](PHASE4_REPORT.md) §13 的复验结论、[上一轮复核方案](PHASE4_REVIEW_REMEDIATION_PLAN.md)、当前备份脚本、路径检查器、归档校验器和相关测试。
**原审查性质：** §1–§3 是审查与实施方案，当时未修改业务代码。§4 记录后续修复状态；全程未部署、未读取生产配置，也未对生产数据做备份或故障注入。

## 1. 审查结论

上一轮 R1–R4 的修复、日志与隔离演练确实存在：初验和复验的 `SHA256SUMS` 均通过本次校验；复验 `full-suite.log` 末尾为 2510 tests、2497 pass、0 fail、13 skip；`rehearsal-2.json` 记录 47/47 checks。报告将真实 systemd、生产配置及生产恢复标为未执行，这一证据边界正确。**G2/T11/I1 的锁身份复验，本次没有发现足以推翻它的新证据。**

但是，当前代码仍有一个可在隔离目录复现的**备份漏库路径**。因此报告 §13.6 中 **G4/T12/I8 的“隔离环境复验通过”不能覆盖脚本当前接受的全部参数组合**，阶段 4 不宜据此进入发布评审。另有一个归档期间新增文件的漏检路径，以及一个“先拒绝危险条目再解包”的实现顺序错误。它们是潜在失效路径，不表示生产已经发生事故。

| 编号 | 优先级 | 发现 | 当前影响与结论 |
|---|---|---|---|
| N1 | **P1，发布阻断** | 同时传 `--env-file` 和 `--database` 时，检查器优先采用命令行路径；备份脚本只检查 env 文件名属于 service，没有核对该文件的实际数据库值是否被覆盖。 | 可把实际主库放在 runtime 外，却以 runtime 内的另一库生成 `closure=complete` 和成功归档。G4/T12/I8 对该参数组合应改为**待修复复验**。 |
| N2 | P2 | manifest 生成时某权威树为 `absent`，随后该路径变成符号链接并进入 tar；归档校验器仅拒绝位于已有 inventory 条目之下的链接，也没有重扫源根的树状态。 | 校验器仍返回成功，违反其“归档窗口后源文件未删改”的完整性承诺。需要独立写者或文件系统变化；在严格停写前提下不是正常路径。 |
| N3 | P2 | 归档校验器记录绝对路径或 `..` 条目为失败后，仍无条件调用 `tar -xf`。 | 与脚本说明和报告所写“拒绝危险条目后才解包”不符；不能把当前检查当作解包前的安全门。 |

### 1.1 N1：实际服务主库可以被命令行覆盖掉

源码链：[路径检查器](../../scripts/check-runtime-backup-paths.mjs) `explicitValue()`（约 292–295 行）使 CLI 值覆盖 env 值；[备份脚本](../../deploy/backup-runtime.sh) 约 51–55 行允许两者同时传入，约 139–155 行只把 `Environment=` 中显式出现的值与期望值比较。若 service 只用 `EnvironmentFile=`（仓库的两个 service 模板都是如此），`unit_env` 为空，脚本不会比较 env 文件中的 `RAI_DATABASE` 与 CLI 覆盖值。

本次隔离复现使用临时 runtime、外部 `actual.sqlite`、服务 env 文件和 `systemctl` 替身；没有访问仓库 `var/` 或生产路径：

1. env 文件声明 `RAI_DATABASE=<临时根>/external/actual.sqlite`，控制库与 runtime 根在 `<临时根>/runtime/var/`；`systemctl show EnvironmentFiles` 返回该 env 文件，`Environment` 返回空。
2. 在 runtime 内另放 `var/rai.sqlite`，调用 `backup-runtime.sh --env-file <该文件> --database <runtime>/var/rai.sqlite --apply`。
3. **实测**脚本退出 0、服务恢复 active、生成最终归档；manifest 为 `closure=complete`，其 `stores.main.configured` 是 runtime 内的覆盖值，`inventory` 不含服务实际使用的外部 `actual.sqlite`。

这直接反驳报告 §13.3 中“备份 env 与 service 环境一致即可证明路径闭包”的现有实现结论。[`deploy-n100.test.ts`](../../apps/api/test/deploy-n100.test.ts) 只测试 `Environment=` 直接覆盖为不同值（约 347–359 行），没有测试 **env 文件值与 CLI 覆盖值不一致**。多份 `EnvironmentFile`、可选文件和 unit/drop-in 覆盖的组合也尚无完整测试；在证明解析规则前应拒绝这些配置，而不能靠文件名出现在列表中就放行。

### 1.2 N2：`absent` 权威树在归档窗口可变成未受检链接

[归档校验器](../../scripts/verify-runtime-backup-archive.mjs) 约 147–156 行只对 `entryPaths` 中已有目录及其后代拒绝链接；约 195–209 行只对权威树内的**普通文件**核对额外条目；约 217–249 行的源根复核只遍历原 inventory。若 `var/imports` 原来不存在，它不在 inventory 中。

本次隔离复现：先对三份临时库生成 `closure=complete` 的 manifest（其中 `var/imports` 为 `absent`）；再把 `var/imports` 设为指向 runtime 外的符号链接；随后 tar 并运行校验器。**实测** `tar` 和校验器均退出 0，校验结果为 `passed=true`、`problems=[]`，归档有新增链接。这一窗口要求停服后仍有独立写者或其他文件系统修改，因此优先级低于 N1；但当前脚本没有机器可验证的“无 CLI 写者”门禁，且校验器的源根复核声称能发现归档窗口变化。

### 1.3 N3：危险条目检查没有挡住解包调用

[归档校验器](../../scripts/verify-runtime-backup-archive.mjs) 约 95–105 行把危险名称加入 `problems`，但约 108–113 行仍创建解包目录并执行 `tar -xf`。这是确定的控制流事实；本次未宣称在当前系统 tar 上已经成功越界写入。即使最后退出 1，“解包前拒绝”的报告陈述也不成立。

## 2. 详细实施方案

### 批次 A：让备份路径只来自已证明的 service 配置（N1，先完成）

1. 在 `deploy/backup-runtime.sh` 的 `--apply` 路径建立单一、明确的配置来源。最小安全实现：**使用 `--env-file` 时禁止同时传 `--database` / `--control-database`**；使用显式库路径时，要求 service 没有 `EnvironmentFile`，且 `Environment=` 明确包含与备份相同的 runtime、主库和控制库路径。不要把 CLI 覆盖当作 service 的实际值。
2. 对多份 `EnvironmentFile`、可选/缺失文件、unit/drop-in 的路径覆盖、`UnsetEnvironment` 或解析不支持的引号/空格形式先失败关闭。若产品确实需要这些部署形态，再实现与 service 生效值一致的解析，并为每种组合建立真实 systemd 验证；不能仅比较文件名。
3. 先完成上述 service 配置核对，再运行 preflight。把最终采用的三个规范化路径作为**同一份输入**传给停服前检查、停服后 manifest 和归档校验；manifest 记录配置来源与规范化路径，但不输出 Token。
4. 更新 `docs/OPERATIONS.md`、`deploy/README-UBUNTU.md`、`BACKUP_RESTORE_REHEARSAL.md`：明确允许的参数组合和失败方式。报告 §13 增补本次发现、修复后的新日志与结论；保留原 47/47 和全量套件日志作为历史，不能追写成“当时已覆盖”。

**批次 A 验收：** 在 `deploy-n100.test.ts` 加真实脚本编排测试。至少覆盖：（a）env 主库在根外 + CLI 主库在根内，（b）env 与 CLI 都在根内但值不同，（c）两份 env 文件，（d）unit `Environment=` 与 env 文件冲突，（e）单份 env、无 CLI 覆盖的正例，（f）只有直接 `Environment=`、无 env 文件且三路径明确一致的正例。拒绝例必须在 `systemctl stop` 之前非零退出，不产生 `rai-runtime-*` 最终归档，服务状态不变；正例 manifest 的五类路径与**服务实际生效路径**一致，归档逐项校验通过。N1 的外置主库样例必须从“当前退出 0”变为“拒绝备份”。

### 批次 B：封闭 manifest 到 tar 的变化窗口（N2）

1. `verify-runtime-backup-archive.mjs` 对 `manifest.inventory.trees` 的每棵树重新检查源根：`absent` 必须仍不存在；`present` 必须仍是普通目录。递归重扫全部后代，与 manifest 的路径、类型、大小和摘要**精确比较**，包括新增的符号链接、目录、普通文件及特殊文件。
2. 对解包后的树使用同一套精确比较：即使 manifest 中某树为 `absent`，归档中出现该根或任一后代也必须失败。不能仅以 `entryPaths` 判断链接是否属于权威树。
3. 封装“清单 → tar → 校验”结果，任何源根变化都应在最终归档 `mv` 之前失败，清理临时目录并恢复原服务状态。保留“没有独立 CLI 写者”的运维前提；源根复扫只是附加证据，不能替代停写。

**批次 B 验收：** 用受控 tar 替身在生成 manifest 后注入以下变化：`absent` 的 `var/imports` 变成外部/根内/悬空链接、新目录或普通文件；`present` 树中新增文件、删除文件、改写同大小文件。每例校验器返回非零，`problems` 点名相对路径；完整 `backup-runtime.sh --apply` 不发布最终归档，先前 active 的 service 恢复 active。无变化的正例仍通过，恢复根中每个权威项与 manifest 摘要一致。

### 批次 C：先拒绝危险归档，再解包（N3）

1. 在 `tar -xf` 前，对 `tar -tf` 失败、任何绝对路径、`..` 组件、重复/冲突名称立即退出；检查 manifest 条目路径同样只能是 runtime 根内的规范相对路径。不要先记录问题再继续解包。
2. 检查归档条目类型与链接目标。若无法在解包前可靠证明所有成员不会越出临时根，采用不跟随链接、限制成员类型的安全解包实现；至少禁止符号链接或硬链接作为后续文件的父路径。对外部归档执行校验时不能依赖 tar 的平台默认安全行为。
3. 更新校验器顶部说明及报告的“解包前拒绝”口径，使文字只描述已实际通过的门禁。

**批次 C 验收：** 构造绝对路径、`../`、链接父路径、重复名称和设备/FIFO 条目的隔离归档。用可记录调用的 tar 替身断言危险条目被发现后**没有 `-xf` 调用**；用临时目录外的标记文件确认内容与哈希不变。正常归档仍通过，归档验收的退出码和诊断稳定。

## 3. 阶段门、回归与发布判据

| 门禁 | 必需证据 | 通过条件 |
|---|---|---|
| G4/T12/I8 | N1–N3 的先红后绿隔离复现、脚本退出码、service stop/start 日志、manifest、归档条目与恢复摘要 | 所有被接受的参数组合都能证明 service 实际路径在归档内；任何权威树的新增/删除/变型在发布前失败；危险归档不触发解包。 |
| 代码回归 | `node --import tsx --test apps/api/test/deploy-n100.test.ts`、`node --import tsx scripts/phase4-backup-restore-rehearsal.mjs`、`npm run typecheck`、`RAI_TEST_CONCURRENCY=2 npm test` | 退出码 0；记录测试数、并发度与 skip 原因。保留本轮失败复现和修复后日志，生成新的 SHA256SUMS。 |
| 文档/部署门禁 | `npm run check:docs`、`npm run check:doc-refs`、`npm run check:acceptance-matrix`、`npm run check:scripts`、`npm run smoke:api`、`git diff --check` | 全部退出码 0；报告、操作手册、脚本允许的参数组合一致。 |
| 生产前人工门 | 实际 service unit/drop-in、`EnvironmentFile` 列表及脱敏后的三个生效路径；同一停写窗口的备份与隔离恢复记录 | 生产路径与 manifest 完全一致，五类库及必要工件可恢复；未执行时结论只能是“模板/隔离通过，生产待确认”。 |

**审查时裁决（实施前）：** 先保留 §13.5 既有日志与 47/47 演练结果，但将 G4/T12/I8 的整体发布判定标为**待修复复验**；G2/T11/I1 维持现有隔离结论。修复只在隔离夹具中验证，部署及真实服务停启仍按运维维护窗口执行。回滚脚本前应再次核对 service 的实际库路径和已验证的冷备，不能引用新版备份验收结果证明旧脚本安全。

## 4. 实施状态（2026-10-23）

N1–N3 的代码修复、隔离复验与最新裁决见 [PHASE4_REPORT.md](PHASE4_REPORT.md) §14；上一轮 §13.5 的日志仍保持历史状态。

| 批次 | 实施结果 | 本轮隔离证据 |
|---|---|---|
| A / N1 | 备份脚本禁止 env 与 CLI 路径混用；只接受可核对的单份必需 env 文件或无文件的直接三路径配置；先核对 service 配置再检查闭包。 | `deploy-n100.test.ts`：外置与根内错配、多份/可选 env、Environment 覆盖、UnsetEnvironment、链接路径拒绝；env 和直接配置正例。 |
| B / N2 | 源根与解包根的四棵权威树按 `present`/`absent` 重扫；新增、删除、类型或摘要变化均在发布前失败。 | 同一测试的 tar 前八类与 tar 后一类变化用例；active 服务恢复，未生成最终归档。 |
| C / N3 | 校验 tar header/清单路径，拒绝危险名称、重复/冲突、链接及特殊项；受限解包只创建普通文件/目录。 | 同一测试的绝对路径、`../`、链接父路径、重复名称、FIFO 五类负例；tar 替身确认无 `-xf`，外部标记不变。 |

定向备份测试 **41/41**，扩展恢复演练 **47/47**，typecheck 通过。另以 [service-witness.json](evidence/second-review-2026-10-23/service-witness.json) 留存隔离 systemctl stop/start 顺序、manifest、归档条目和 N1 拒绝时的空日志。全量与文档门禁的最终结果以报告 §14 和新 SHA256SUMS 为准；生产前人工门仍未执行。
