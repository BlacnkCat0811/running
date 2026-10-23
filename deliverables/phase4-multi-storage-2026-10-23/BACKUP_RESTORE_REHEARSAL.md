# 阶段 4 冷备、整套恢复与外置路径演练

**基线：** HEAD `36d79a95f42f854d54e7dfb91e27eb21152a1fa1`（2026-10-23）；本文件在复核修复批次后更新，代码改动仍在工作树。
**结论：** 上轮隔离演练 **47/47 checks 通过**，初验 29/29 也保留为历史证据；二次审查发现的 N1–N3 修复与本轮证据见 [PHASE4_REPORT.md](PHASE4_REPORT.md) §14。生产实际配置、真实 systemd 停服/恢复、生产规模 RTO **未执行**，不能把本文读成生产恢复已验收。
**证据：** [evidence/rehearsal-1.json](evidence/rehearsal-1.json)（初验 29/29）、[evidence/remediation-2026-10-23/rehearsal-2.json](evidence/remediation-2026-10-23/rehearsal-2.json)（复验 47/47）、`deploy-n100.log`、`phase4-storage-locks.log`。

## 1. 路径闭包（F3 / G4 / R2 / R3）

### 1.1 事实（为什么初验不够）

`deploy/backup-runtime.sh` 只做 `tar -C "$runtime"`，不读取 `RAI_DATABASE`/`RAI_CONTROL_DATABASE`。模板 `deploy/rai.env.example` 的默认值都在 `/var/lib/rai` 内，但 env 可覆盖：

- 主库外置 ⇒ 归档缺主库；
- 控制库外置 ⇒ 归档缺控制库；
- 主库外置时，`<main>.dataset-epoch.sqlite` 与 `<main>.restore-journal.sqlite` 也一起在外；
- 迁移备份写在 `dirname(main)/backups`，同样外置。

复核又发现两个初验没有覆盖的边界：

- **R2：** 旧检查器只 `classify(var/imports)` 等顶层路径，不递归；`tar` 默认把符号链接存成链接。`var/imports/job1/source.zip -> <runtime 外>` 时检查器仍 `complete`，恢复后 `source.zip` 是悬空链接，而它正是来源证据。
- **R3：** 旧检查器在 `RAI_DATABASE` 缺省时按 `<runtime>/var/rai.sqlite` 推断；API 的代码缺省却是 `<projectRoot>/var/rai.sqlite`。只设置 `RAI_RUNTIME_ROOT` 的合法配置会让检查器对错库报 `complete`。

### 1.2 修复（manifest v2）

[scripts/check-runtime-backup-paths.mjs](../../scripts/check-runtime-backup-paths.mjs)：

- **显式路径**：`--database/--control-database`，或 `--deployment-env` 中的 `RAI_DATABASE`/`RAI_CONTROL_DATABASE`；缺一个即 exit 2。相对路径也拒绝（无法复现 service 工作目录）。不再提供 `<runtime>/var/rai.sqlite` 默认值。
- **递归枚举**：`var/imports`、`var/model-artifacts/prediction`、`var/backups`、`var/quarantine` 逐项 `lstat`；`var/reports` 仍随整根归档，但属于可重建报告，不参与权威闭包；任何符号链接（外部/悬空/根内）、不可读文件、FIFO/设备项都以相对路径写入 `problems` 并 exit 2。五类 SQLite 及 `-wal`/`-shm`/`-journal` 必须是普通文件；配置路径经由链接解析到别处也拒绝。
- **inventory**：每个权威文件记录 `path`（相对 runtime 根）、`type`（file/directory）、`sizeBytes`、`mtime`、`sha256`；目录记录类型。`--no-digests` 只给停服前 preflight 用。
- **manifest 格式**：`rai-runtime-path-manifest-v2`，包含 `runtimeRoot`、`envFile`、`databaseSources`、`stores`（五类 + `walPresent/walBytes/shmPresent`）、`inventory`、`closure`、`problems`。不输出 Token。

[scripts/verify-runtime-backup-archive.mjs](../../scripts/verify-runtime-backup-archive.mjs)（R2 新增）：

1. manifest 必须是 v2 且 `closure=complete`、带摘要；
2. 先完整校验 tar header，拒绝绝对路径、`..`、重复项、链接和特殊类型，再用仅创建普通文件/目录的受限解包器读取归档；
3. 逐项比对 manifest 的路径存在性、类型（符号链接不算 file）、大小与 SHA-256；
4. 对四棵权威树重扫解包根和源根；`absent` 必须仍不存在，`present` 的路径及类型集合与 manifest 完全一致（多/少都失败）；
5. 重新核对 `--source-root` 中每项大小和摘要，确认归档窗口结束后没有被删改；
6. 任一不一致 exit 1。备份脚本在发布 `rai-runtime-*` 最终归档前调用。

`deploy/backup-runtime.sh` 的接入：

1. 参数：`--env-file`、`--database`、`--control-database`、`--manifest-out`、`--no-default-env`；默认在 `/etc/rai/rai.env` 存在时读取它。
2. `--apply` 读取 `systemctl show` 的 `EnvironmentFiles`/`Environment`/`UnsetEnvironment`：env 模式仅接受单份必需文件，禁止与 CLI 库路径混用或 `Environment=` 路径覆盖；直接路径模式要求没有 EnvironmentFile 且 `Environment=` 明确声明一致的三个路径。多份/可选文件、UnsetEnvironment 和不支持的路径写法在停服前 exit 2。
3. 停服前 preflight（`--no-digests`）只判闭包；停服后生成带摘要的权威 `path-manifest.json`，tar 后运行归档校验。
4. dry-run 加 `--manifest-out FILE` 会生成同一份 manifest（R4；旧版 dry-run 不生成文件，报告 §10.1 的核对步骤已随之修正）。
5. 失败路径：清理临时目录、恢复原服务状态、不留下看起来完整的最终归档。

### 1.3 覆盖

| 场景 | 结果 | 证据 |
|---|---|---|
| 显式主/控/runtime 均在根内 | `closure=complete`，inventory 带 SHA-256 | `phase4-storage-locks.test.ts` ok 5；`deploy-n100.test.ts` |
| 缺 `RAI_DATABASE`/`RAI_CONTROL_DATABASE` | exit 2，服务未停、无归档 | `deploy-n100.test.ts` “runtime-only env…”；`phase4-storage-locks.test.ts` |
| 主库外置 | exit 2，服务未停、无归档 | `deploy-n100.test.ts` “external authoritative database path…” |
| 权威树根（`var/imports` 本身）是链接 | exit 2 | `deploy-n100.test.ts` 链接表 |
| 顶层外部文件链接 | exit 2，诊断点名 `var/imports/...` | `deploy-n100.test.ts` 链接表 |
| 嵌套外部目录链接 | exit 2 | 同上 |
| 悬空链接 | exit 2 | 同上 |
| 根内链接 | exit 2（最小安全策略，不依赖“目标也在归档里”） | `phase4-storage-locks.test.ts` 链接负例 |
| 库文件/WAL 是链接 | exit 2 | `deploy-n100.test.ts` “database WAL link” |
| 不可读权威文件 | exit 2 | `deploy-n100.test.ts` “unreadable authoritative file” |
| service env 与备份 env 不同 | exit 2，停服前 | `deploy-n100.test.ts` “service env different…” |
| 归档窗口后源文件变化 | exit 2，清理临时目录并恢复服务 | `deploy-n100.test.ts` “source change during the archive window…” |
| 缺 epoch/restore 侧车 | manifest 记 `absent`，不创建空文件 | `phase4-storage-locks.test.ts`；rehearsal |
| 活跃 WAL | manifest 记录 `walPresent/walBytes`，并进入 inventory 摘要 | `phase4-storage-locks.test.ts`；rehearsal `wal:sample_nonempty` |
| Token 泄露 | 检查器输出不含 Token | `phase4-storage-locks.test.ts` |

**未覆盖：** 生产 `/etc/rai/rai.env` 实际值、`systemctl` 真实停服/恢复、`tar` 之外的压缩/加密/异机复制、Windows 链接分支。按计划 G4，不给出生产覆盖结论。

### 1.4 二次审查 N1–N3

上表是上一轮 R1–R4 的测试口径。新一轮 `deploy-n100.test.ts` 41/41 覆盖 env 与 CLI 路径冲突、多份/可选 env 文件、unit 路径覆盖、UnsetEnvironment、直接 `Environment=` 正例、权威树在 manifest 后的新增/删除/同大小改写，以及绝对路径、`../`、链接父路径、重复名和 FIFO tar 条目的解包前拒绝。新的 47/47 恢复演练见 `evidence/second-review-2026-10-23/rehearsal-3.json`；所有新裁决与全仓门禁见 [PHASE4_REPORT.md](PHASE4_REPORT.md) §14。

## 2. 隔离整套恢复演练

### 2.1 方法

脚本：[scripts/phase4-backup-restore-rehearsal.mjs](../../scripts/phase4-backup-restore-rehearsal.mjs)。全程在 `mkdtempSync(tmpdir())` 下，自带“根必须在 tmpdir”守卫；不读取仓库 `var/`，不访问生产。

1. 用真实 `RaiDatabase` / `MobileGoalsStore` / `RuntimeStateStore` 建五类存储：
   - 主库：1 条 workout + statistics + training_session、`dataset_version`、显式 epoch 行、1 条导入回执；
   - 控制库：`mobile_goals.revision=7`、1 条 `mobile_plan_operations` 回执；
   - runtime：1 个 succeeded job/source、**1 个 running/importing 未终态 job + source**、scope `established`；
   - epoch 侧车：`epoch-2026-10-23-rehearsal-a`；
   - **restore journal：真实存在**（`prepared` + 指向保护快照）；API 启动时走到终态并清空 intent（journal 文件保留）；
   - **保护快照**：`var/backups/rehearsal-protection.sqlite`（主库停写副本）；
   - **active model release bundle**：`model_runs`/`model_v2_runs`/域快照/release bundle/active pointer 一整组。
2. 工件：`var/model-artifacts/prediction/model.onnx`、`var/imports/upload_rehearsal/source.zip`、`extracted/export.xml`、`var/reports/rehearsal.json`、pending 来源文件。
3. **非空 WAL 样例**：子进程打开 `var/quarantine/wal-sample.sqlite`、写 WAL 后 SIGKILL，`-wal` 保留非空帧；归档/恢复后逐字节可读。
4. 链接裁决：另建三套隔离根，分别放外部/悬空/根内链接，运行检查器并断言 exit 2（全部拒绝）。
5. 停写：本演练没有常驻写者；种子连接全部关闭后才归档（等价于停服后的冷备窗口）。
6. 路径检查（v2，带摘要）→ `tar` 整根 → 归档语义校验 → 移开原根 → 解包到新根。
7. 恢复后逐项复核 manifest 的权威文件可读性/类型/大小/摘要；对每个实际存在的 SQLite（含 journal、WAL 样例、保护快照）做 `PRAGMA quick_check`；启动真实 API，核对健康/epoch/workout/计划 revision/operation receipt/scope/未终态任务/active bundle/导入回执/工件字节；启动后核对 journal 已被恢复流程清除。

### 2.2 结果（复验，47 checks）

| 项 | 值 |
|---|---|
| 执行时间 | 见 `evidence/remediation-2026-10-23/rehearsal-2.json` |
| 归档 | `runtime.tar`，SHA-256 `8dcae82bd3ee…`（完整值在 JSON） |
| 检查总数 | **47/47 pass** |
| 五类文件 | 主/控制/runtime/epoch 侧车/restore journal **present** |
| `quick_check` | 主/控/runtime/epoch/journal/WAL 样例/保护快照全部 `ok` |
| 控制库 | `mobile_goals.revision=7`；`op-rehearsal-1` 回执字节一致 |
| runtime | scope `established`；succeeded job 保持；**running/importing job 原样恢复** |
| restore journal | 归档前 `prepared`；恢复后可读；API 启动后走到终态并清空 intent（文件保留、0 行） |
| active bundle | `active_model_release.model_run_id = run_rehearsal_active`，启动前后一致 |
| API | `/v1/health` 200 `status=ok databaseReady=true`；`datasetEpoch=epoch-2026-10-23-rehearsal-a`；`/v1/workouts?limit=5` 返回 1 条 |
| 工件/来源 | `model.onnx`、`source.zip`、pending source 字节一致 |
| 归档闭包 | manifest 每项可读；归档条目/类型/摘要与源根、恢复根均一致 |
| 链接裁决 | 外部/悬空/根内三类均 `reject`（exit 2） |
| RTO（解包开始 → API 健康核对完成） | **12,416 ms**（隔离小库；不是生产 SLA） |
| RPO | 停写窗口内 0；归档开始后不接收写 |

### 2.3 初验 29/29 的处置

`evidence/rehearsal-1.json` 的 29/29 只使用普通文件、没有 restore journal/WAL/未终态任务/链接负例，因此**不能**证明 R2 边界。原日志保留，不重写为“当时已覆盖”；复核结论以 47/47 为准。

### 2.4 失败回滚

演练脚本在任一 check 失败时 exit 1 并删除临时根（`--keep` 可保留现场）；归档/恢复过程不触碰原根（原根被移开而非删除，恢复失败可移回）。生产脚本的失败路径由 `deploy-n100.test.ts` 覆盖：tar 失败清理临时目录并恢复原服务状态；归档校验失败同样清理并恢复；重启失败返回 `CRITICAL` 且保留已经验证的归档。

## 3. 两套操作手册必须分开

### 3.1 单库恢复（API `POST /v1/backups/:name/restore`）

适用范围：只把**主健康库**替换为某个 `var/backups` 内的备份；控制库/runtime 仍保持当前时点。

1. 备份必须已复制到 `<runtime>/var/backups/<basename>.sqlite`（接口只按 basename 查找）。
2. 调用 `POST /v1/backups/:name/restore`，`confirmation` 逐字为“恢复此备份”。
3. 恢复流程：preflight → `before-restore` 快照 → restore journal prepared → 原库移开 → staging 安装 → installed → checkpoint/fsync → committed（`mainSha256`）→ 收口 sidecar/scope/publication → 清 journal。
4. 成功后主库获得**新 dataset epoch**；控制库的 plan revision 与 runtime 的任务/来源**没有**回到备份时点。旧设备同步游标/请求幂等键必须按新 epoch 重放，不能假设控制库也回退。
5. 失败：原库回滚并复核；不可证明时保持 `recovery_required`，不要手工清 journal 或建空库。

### 3.2 整套 runtime 冷备恢复（运维手工）

适用范围：五类库 + 工件 + 配置身份必须回到**同一时点**。

1. 停 `rai-api` 与所有 CLI 写者；确认无活 `*.import.lock`。
2. 按 [deploy/README-UBUNTU.md](../../deploy/README-UBUNTU.md) 的冷备流程归档。**只读核对**用：
   ```bash
   sudo node scripts/check-runtime-backup-paths.mjs --runtime-root /var/lib/rai \
     --deployment-env /etc/rai/rai.env --out /root/rai-path-manifest.json --json
   ```
   核对五类存储与 `inventory`；manifest 含部署路径（不含 Token）。
3. 归档时确认 `--apply` 已通过 service env 核对、递归链接检查、归档逐项摘要校验；核对 `SHA256SUMS` 与 `path-manifest.json`。
4. 恢复时把旧 runtime 根移开（不要 `rm -rf`，保留回退点），解包到原路径，恢复 owner/权限。
5. 对每个实际存在的 SQLite 跑 `quick_check`；保持 absent 的侧车为 absent。用 manifest 逐项核对恢复根的可读性与 SHA-256。
6. 启动 API；核对 `/v1/health` `status=ok databaseReady=true`、datasetEpoch、runtime scope、控制库 revision/operation receipt、active bundle、未终态任务与上传/工件。
7. 旧设备游标/幂等状态：整套恢复会把控制库/runtime 也带回旧时点，客户端可能重放旧请求；必须按“新 epoch + 旧 operation receipt”重裁决，不能把重放当成新写入。
8. 回滚：恢复失败时移回旧根；不要用旧二进制打开新 schema（先确认 `schema_migrations` 版本与代码兼容）。

## 4. 未执行项与风险

| 项 | 状态 | 说明 |
|---|---|---|
| 生产 `/etc/rai/rai.env` 读取 | 未执行 | 本机不是部署机；路径闭包只对模板与隔离环境成立 |
| `systemctl stop/start` 实际行为 | 未执行 | `deploy-n100.test.ts` 用 stub 覆盖脚本编排与 env 核对；真实服务未停 |
| 生产规模 RTO/RPO | 未测量 | 隔离库约 1.2 MB；生产 4.6 GiB 级归档的耗时未测量，不能引用本值当产能承诺 |
| 异机复制/加密 | 未执行 | 脚本明确提示明文私有健康数据；压缩/加密是运维步骤 |
| 归档校验的磁盘/IO | 已知成本 | 校验会解包到临时目录并逐项哈希，需要约 1×归档大小的额外空间 |
| 外置控制库的独立备份方案 | 未提供 | 当前策略是**拒绝**外置路径；若未来需要外置，必须新增同停写窗口的额外归档清单并扩展 manifest |
| Windows 链接/硬链接分支 | 未执行 | 本机 macOS；对应测试在 Windows 执行或按平台跳过，不宣称跨平台通过 |

**本轮结论见 [实施验收报告](PHASE4_REPORT.md) §14：** N1–N3 修复后的模板与隔离范围复验另行记录；本节原 47/47 仍是上一轮演练历史。生产覆盖结论为**待确认**，不得写成已验收。
