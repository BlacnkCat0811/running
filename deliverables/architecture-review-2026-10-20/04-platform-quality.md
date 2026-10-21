# Lane 4：平台 / 质量系统 / 文档与演进架构审查

- **基线**：`/Users/ta/running` @ `9db450f`（`docs(training-plan): 2026-10-20 发布记录`），工作树唯一的未跟踪项是 `deliverables/architecture-review-2026-10-20/`。Node `v22.23.2` / npm `10.9.8`（nvm）。
- **方法**：只读。逐行阅读 `deploy/**`、`.githooks/pre-commit`、`.github/**`、`.workflow/**`、`scripts/check-*.mjs|mts`、`scripts/run-tests.mjs`、`scripts/run-ios*.mjs`、`tsconfig*.json`、根 `package.json`、`docs/**`（治理口径）、`research/**`、`crates/**`；实跑 12 条门禁与 3 条探针命令。仓内跟踪文件零修改，唯一写入是本文件。
- **覆盖范围**：部署与运行时拓扑、质量系统（门禁/测试/CI）、文档架构、跨平台与构建约束、演进风险（供应链/版本/伸缩/churn）。
- **没做什么**：未跑全量 `npm test` / `test:ios` / `smoke:api` / 部署 / 迁移（BRIEF §3 归属 Lead）；未读 `var/`；未做真机与 Windows 实测；未逐篇评 29+ 份 docs 的技术内容。

## 0 结论摘要

| 级别 | 数量 |
|---|---|
| P0 | **0** |
| P1 | **0** |
| P2 | **7** |
| P3 | **12** |

总体判断（5 句）：

1. **平台层是这套系统里工程密度最高、也是唯一"判据真的钉住产物"的一层**：`deploy/` 14 个文件合计 983 行，被 16 条文本/行为合同测试钉住（我实跑 16 pass / 0 fail / 29 s，E2），watchdog、120 s 超时、404 根路径、memory 预算都各有断言——这与"部署靠手敲"的常见形态相反。
2. **质量系统已从"门禁存在"进化到"门禁自己要有回归"**：`check:package-boundaries -- --self-test` 8 条突变、iOS 判据的"孤儿=直接红"、`run-tests.mjs:16,152` 的"写入测试但从未被跑"反向断言、以及"跳过≠通过"的 `RAI_IOS_UNVERIFIED` 认账闸门，都是上一轮审查（P2‑08/P3‑30/P3‑32）留下的**结构性修复**，在 HEAD 上逐条复核成立。
3. **但"门禁体系里最不可信的代码就是门禁本身"**：18 个 `.mjs` 门禁/运行器不在 `tsconfig` 内（`tsconfig.json:24` 只含 `scripts/**/*.mts`），13 个在全部测试文件中零引用；除包边界外没有任何一支有自己的回归。质量系统对产品的可信度 ≫ 对自身实现的可信度。
4. **文档层第一次出现"门禁与流程互相打架"的闭环**：`check:docs` 把"未跟踪但未忽略的 md 必须从 README 可达"当硬错，于是每一轮审查新增的 deliverables 文档都会让它变红；真正承担这个耦合的人肉索引 `deliverables/README.md` 是 30 天内**全仓 churn 第一名**（47 次）。
5. **演进侧的真实风险不在依赖也不在 Node 版本，而在"单机 + 无告警 + 不可逆升级"的三角**：预算 1400 MB 却允许两个 512 MB isolate 加一个无 `resourceLimits` 的导入 worker；重启/看门狗/启动限流触顶全部静默；`upgrade.sh` 先 pull 后迁移且没有自动回滚。

**最该先做的 3 件事**（都不破坏硬约束）：

- **A**（半天）把 `deploy/upgrade.sh` 变成可回滚事务：记录 `before_head`、`--migrate` 失败或健康检查失败时自动 `git checkout before_head` + `systemctl restart` + 再验健康，并在失败时打印需要人工执行的三条命令；用 `deploy-upgrade.test.ts` 的既有夹具钉住"失败后 HEAD 回到 before_head"。
- **B**（半天）给平台层加一条**只读**的失败可见性通道：`OnFailure=` 或一个 `systemctl show -p NRestarts` 的日检脚本 + `check-runtime-readonly.sh` 里已有的判据复用；不改架构，只让"被 watchdog 拉起来过"出现在某个人会看的地方。
- **C**（1 天）把 42 条 `pre*` 版本检查收敛成两处判据：`.npmrc` 里 `engine-strict=true`（管 `npm ci/install`）+ 保留 `preinstall`/`pretest`/`pretypecheck`/`prestart` 四条（管运行入口），其余 38 条删除；去掉 41% 的 npm script 面（105→63），同时缩小 `check:scripts` 的判别面。

## 1 实际架构（as-built）

### 1.1 部署拓扑（两套 profile，不是一套）

| 维度 | 云端（`deploy/`） | 家庭 VM（`deploy/n100/`，FRP 打洞） |
|---|---|---|
| systemd | `Type=notify` + `NotifyAccess=all` + `WatchdogSec=120`（`rai-api.service:21-23`） | `Type=simple`，**无 watchdog**（`n100/rai-api.service:9`） |
| 资源 | `MemoryHigh=1100M / MemoryMax=1400M / MemorySwapMax=512M / CPUQuota=150% / TasksMax=128`（`:44-50`） | `3G / 4G / 200% / 128`（`n100:32-35`） |
| nginx | 自定义 `log_format rai`（`rt=/urt=/ust=/uaddr=`，`nginx-rai.conf:35`）、默认 120 s、只有两处 600 s 长读（`:95`、`:115`）、根路径 404（`:131`） | `access_log off`、`proxy_read_timeout 60s`（`n100/nginx-rai.conf:22,37`）、无耗时字段 |
| 限流 | `rate=300r/m burst=100`（`:24`） | `rate=5r/s burst=20|60` |
| TLS | certbot（80 上 ACME webroot + 443），`listen 443 ssl http2`（`:51`） | 同构，外加 FRP TLS（`frps.toml` 已钉 `transport.tls.force`） |

进程模型：**单一 systemd unit / 单一 Node 进程**（`ExecStart=/usr/bin/node --import tsx apps/api/src/server.ts`，`rai-api.service:30`），进程内另起**常驻导入 worker 线程**（`import-worker.ts:982` 的 `new Worker(...)`），心跳通过**每 40 s spawn 一次 `/usr/bin/systemd-notify` 子进程**发出（`systemd-notify.ts:29,32`）；Rust worker 是子进程（`target/release/rai-data-worker` 或 `RAI_RUST_BINARY`）。没有 PM2 / cluster / 多写者，与 `docs/ARCHITECTURE.md:50` 一致。

与 `docs/ARCHITECTURE.md` 的差异：文档写的是"云部署使用 Nginx HTTPS、Bearer、来源/Host 限制和 systemd 资源预算"（`:65`），**没有**记录 n100 是第二套语义不同的拓扑；`docs/OPERATIONS.md:53-60` 的 hang 守护与可观测性章节也**只描述云端模板**。n100 的 `Type=simple` + `access_log off` 意味着 2026-10-18 那场 `-1001` 复盘修掉的两个放大项，在家庭 profile 上原样存在。

### 1.2 数据流与失败边界

`git pull` → （可选）`systemctl stop` → `data:migrate --apply` → `systemctl restart` → 带 Token 轮询 `/v1/health` 直到 `status=ok && databaseReady===true` 且无 Token 必须 401（`deploy/upgrade.sh:91-136`）。这是**失败关闭**的：迁移失败保持停服，不重启"半迁移的库"（`:105`），健康不真就绪则 EXIT=1。备份是完全外置责任，脚本只打印提示且**不校验**（`:77-83`，`backup-reminder` 锚点被 `deploy-upgrade.test.ts` 钉住顺序）。

## 2 架构评估（按 BRIEF §2 七维）

**(1) 结构与边界**：`packages/*` 16 包 + 1 app，依赖方向由 `check-package-boundaries`（4 类判据 + 8 条自测）守，实测 `16 packages / 31 src edges / 4 禁线`（E2）。平台层与产品层边界清晰：`deploy/` 不含业务逻辑，`scripts/` 不含产品代码。真正的结构问题在**同类判据只存在于一半的 profile 上**（§1.1）。

**(2) 职责与单一数据源**：`systemd-notify` 的实现只有一处（`apps/api/src/systemd-notify.ts`），unit 只声明期望（`rai-api.service:14-20` 的注释明确"本模板只声明期望"），`NO_IOS_SOURCE_CHECKED` 哨兵由 Node 侧导出、钩子不抄第三份字符串（`.githooks/pre-commit:77`）——这是仓库里做得最好的"单一数据源"范例。反例是 `npm` 版本检查被复制了 42 份（§3 Q9）。

**(3) 一致性与并发**：单写者 + WAL + `busy_timeout=5000` + `synchronous=NORMAL`（`storage-sqlite/src/database.ts:1890-1897`，回读校验、拒 `journal_mode=OFF`）。平台侧与之对齐：`TasksMax=128`、`LimitNOFILE=16384`、`TimeoutStopSec=120`、`KillMode=mixed`。**可接受**。

**(4) 故障隔离与可伸缩性**：见 Q1/Q2/Q3。核心判断：**单机 SQLite 的失效不是"性能下降"而是"没有第二个人会知道"**——所有失败通道（watchdog、OOM、启动限流）都收敛到"journalctl 里有一行"，而 systemd 侧没有任何 `OnFailure=`；`RAI_TEST_CONCURRENCY`、`NRestarts` 这类需要人主动查的指标，恰好是这份运维设计里唯一存在的反馈。

**(5) 可演进性**：部署 = **源码 + tsx**，没有构建产物（`rai-api.service:30`；`docs/DECISIONS.md:19` 把"tsx 执行通道"升格为冻结项）。这让"回滚 = git revert"在概念上成立，代价是：生产错误只有 `typecheck`（提交时跑，22.17 s，E2）与运行时才发现；`engines` 允许 22/24，`.nvmrc`=22，CI 只测 22（`ci.yml:134`）而开发机是 24。

**(6) 质量系统架构**：见 §3 Q5/Q6 与 §2 第 3 条判断。体系本身是**分形**的（门禁有自测、孤儿门禁判红、跳过要认账），但它对"自己看到的面积"没有总量判据：`check:docs` 的锚点判据只覆盖 **2 条链接**（703 条中），`check:doc-refs` 的 15 份文档里有**多份是 0 处引用的真空**（脚本自己打印），这两处都是"判据真实但不构成保护"。

**(7) 安全与运维边界**：`NoNewPrivileges / ProtectSystem=strict / ProtectHome / PrivateTmp / UMask=0077 / ReadWritePaths` 全套在位（`rai-api.service:37-42`），`/etc/rai/rai.env` 0600、Token 不回显（`upgrade.sh:87-89`、`check-runtime-readonly.sh:24-28`）。反例：`NotifyAccess=all`（`:22`）把 sd_notify 面开放给**所有子进程**（含导入 worker 与 Rust worker），任何子进程都能伪造 `READY=1`/`STOPPING=1`；这条是为了"spawn 子进程发心跳"的取舍，注释写清了，但它确实是安全边界的下调。另：nginx 没有 443 `default_server` 拒绝未知 Host，Host/Origin 白名单完全由应用层（`RAI_ALLOWED_ORIGINS`、`RAI_PUBLIC_HOSTS`）承担。

## 3 发现详情

### Q1（P2）资源预算算术自相矛盾：1400 MB 上限 vs 两个 512 MB isolate

- **证据等级** E1（静态）。`deploy/rai.env.example:57-59` 明确 `NODE_OPTIONS=--max-old-space-size=512`「Per Node process/isolate」；`deploy/rai-api.service:44-50` 注释写 `MemoryHigh=1100M / MemoryMax=1400M`「Aggregate API + workers + trainer」。
- **机制**：`apps/api/src/import-worker.ts:982` 用 `new Worker(new URL("./import-database-bootstrap.mjs"))` 起**常驻**导入线程，且**全仓没有 `resourceLimits`**（`git grep resourceLimits` 为空）。worker_threads 的 V8 堆上限按 isolate 计，因此单进程内至少 512 MB（main）+ 512 MB（worker）= 1024 MB JS 堆，再加 tsx/undici/onnxruntime 原生内存与 Rust 子进程，落在 1400 MB 的硬上限内。
- **影响**：大包导入 + 一次全表重算是这套预算最窄的时刻；触发 `MemoryMax` 后 `OOMPolicy=stop` 会把整组进程停掉。**"OOM 后是否会按 `Restart=on-failure` 拉起"取决于 systemd 对 OOM-stop 的判定，我未实机验证**（见 §6）。
- **建议**：给导入 worker 显式 `{ resourceLimits: { maxOldGenerationSizeMb: 256 } }`（一行），或在 env example 里把"两个 isolate 各 512 MB"写清楚并下调到 384；把 `systemd-analyze verify` 之外的这条算术做成一支文档断言（写成 `deploy-cloud.test.ts` 的注释不了，建议加一条"`NODE_OPTIONS` 里的 MB × isolate 数 ≤ MemoryMax 的 80%"的静态检查）。

### Q2（P2）失败不通知：三种死法都静默，`StartLimitBurst` 触顶后永久 failed

- **证据等级** E1。`rai-api.service:5-6`（`StartLimitIntervalSec=300` / `StartLimitBurst=3`）、`:23`（`WatchdogSec=120`）、`:31-33`（`Restart=on-failure` / `RestartSec=5` / `RestartPreventExitStatus=78`）；`docs/OPERATIONS.md:96-98` 给出的判据是**人去跑** `systemctl show -p NRestarts` 与 `journalctl | grep -i watchdog`。
- **机制**：300 s 内第 4 次失败后 systemd 放弃拉起，unit 进入 failed 且**没有任何外部事件**；watchdog 杀进程、OOM、5xx 上升都不产生通知。`deploy/check-runtime-readonly.sh:44-45` 自己也承认「Still required: deployed Git revision, TLS/nginx configuration, end-to-end device sync, whole-runtime restore rehearsal」，而它是**人工入口**（脚本头 `:1-4`）。
- **影响**：单用户产品里"服务停了三天没人知道"是可用性问题而非数据问题，但对 iOS 客户端的后果是同步静默失败；`-1001` 复盘的教训是"看得见才能修"，这条只解决了本地可见性（`rai-access.log`），没解决"有人在看"。
- **建议**：加一个不引入新服务的日检（`systemd` timer 或 cron 里 `systemctl is-failed` + `NRestarts` 增量 → 邮件/webhook）；或至少 `OnFailure=rai-alert.service` 的一行模板并写进 `deploy/README-UBUNTU.md`「验证」。

### Q3（P2）两套部署 profile 的可靠性语义不同，文档只写一套

- **证据等级** E1。`deploy/n100/rai-api.service:9` 是 `Type=simple`（无 `WatchdogSec`），`deploy/n100/nginx-rai.conf:22` 是 `access_log off`、`:37` 是 `proxy_read_timeout 60s`；云端对应位置为 `rai-api.service:21-23` 与 `nginx-rai.conf:35,65`。`docs/OPERATIONS.md:53-60`「线上可观测性与 hang 守护（2026-10-18 起）」**只描述云端模板**。
- **机制**：两条部署路径共用 `docs/OPERATIONS.md` 的运维口径，但 n100 上"事件循环 hang"既不会被自动恢复（无 watchdog），也不会留下 `rt=/urt=` 证据（无自定义日志）。
- **影响**：读者会按 OPERATIONS 的「回滚/误杀」章节处理 n100，而那套判据在 n100 上不存在（`systemctl show -p WatchdogUSec` 会是 `infinity`）。这是**文档与实现的范围不一致**，不是模板写错。
- **建议**：要么给 n100 补 `Type=notify`/`WatchdogSec`（`nginx-rai.conf` 补 `log_format`），要么在 OPERATIONS 该节开头加一行「本节仅适用云端模板；n100 为 `Type=simple`，无 watchdog、无耗时日志」。二选一都很快，别再让读者猜。

### Q4（P2）升级不可逆 + 整 runtime 恢复从未演练

- **证据等级** E1（脚本逐行）+ E2（16 条 deploy 合同测试全绿，说明现有断言只覆盖"顺序与提示"，不覆盖回滚）。`deploy/upgrade.sh:91-96` 先 `git pull --ff-only` 再取 `after_head`；`:105-110` 的 `--migrate` 在 pull 之后、无 `git checkout` 回退；`:130-133` 健康不就绪直接 `exit 1` 并把服务留在停止/半新状态。`docs/OPERATIONS.md:199` 明说「仓库没有名为 restore-runtime.sh 的自动整 runtime 恢复脚本，不应臆造命令」；`deploy/check-runtime-readonly.sh:45` 把"whole-runtime restore rehearsal"列为仍缺项。
- **机制**：代码与 schema 的推进是**单向**的：`--migrate` 一旦 commit 成功，回到旧代码需要同时满足"旧代码能打开新 schema"（未验证假设），或恢复备份（人工、冷备、无校验脚本）。`upgrade.sh` 记录了 `before_head` 却只用于**打印**（`:75`），没有用于回滚。
- **影响**：一次迁移失败 = 停服 + 人工介入；恢复的正确性完全依赖运维记得 6 条手工步骤（`deploy/README-UBUNTU.md:324-329`），而这条路径**从未被任何测试或演练触达**（`deploy-n100.test.ts` 只对备份脚本做 fake-systemctl 行为测试）。
- **建议**：最小闭环——`upgrade.sh` 在 `--migrate` 失败或健康判据失败时执行 `git -C $APP_DIR checkout $before_head` + `systemctl restart` + 再验健康，并在失败输出里给三条人工命令；`deploy-upgrade.test.ts` 已有 fake 环境，加一条"失败后 HEAD == before_head"即可钉住。整 runtime 恢复演练记为独立发布前置项，不要塞进本轮。

### Q5（P2）质量系统里最不可信的代码是门禁本身（18 支 `.mjs` 不在类型检查内，13 支零测试引用）

- **证据等级** E1 + E2。`tsconfig.json:20-24` 的 `include` 是 `packages/**/*.ts`、`apps/**/*.ts`、`scripts/**/*.mts`——**不含 `scripts/*.mjs`**。实测 `scripts/` 组成：18 `.mjs` / 37 `.mts` / 1 `.sh`；我逐支统计"是否被任何测试文件引用"：`check-blob-size.mjs`、`check-doc-links.mjs`、`check-npm-scripts-portable.mjs`、`check-training-plan-single-writer.mjs`、`run-ios.mjs`、`run-ios-python-gates.mjs`、`run-tests.mjs`、`rust-worker.mjs`、`dev-device.mjs` 等 **13 支为 0**；仅 `check-doc-line-refs.mjs`、`check-node-version.mjs`、`check-package-boundaries.mjs`、`measure-write-lease.mjs`、`mobile-smoke-check.mjs` 各 1 处引用。
- **机制**：门禁族用纯 JS 写（为跨平台零依赖），于是它既不享受 `typecheck`，除包边界外也没有 `--self-test` 式的突变回归。上一轮正是在这类"没有量具的量具"上发现了 5 处判据缺口（引号/扩展名/空断言/锚点/基线）。
- **影响**：任何一次"改门禁让它变绿"的改动都没有第二道判据；`check-doc-links.mjs` 的 145 行、`check-doc-line-refs.mjs` 的 300+ 行是**注释密度极高但执行语义无回归**的代码。
- **建议**：把 `tsconfig.pure.json` 式的第二 profile 扩成 `tsconfig.scripts.json`（`allowJs: true` + `checkJs: true`，只含 `scripts/*.mjs`）并挂进 `typecheck`；给 `check-doc-links.mjs` 补一支 8 行的 `/tmp` 夹具自测（模式照抄 `check-package-boundaries --self-test`）。

### Q6（P2）孤儿门禁仍有 5 个：判据存在、文档要求、但 hook/CI/发布清单都不执行

- **证据等级** E1（`git grep` 全仓引用面）。只在文档中出现、不在 `.githooks/pre-commit`、`.github/workflows/ci.yml`、`.workflow/master-ci.yml`、`docs/OPERATIONS.md` 发布清单中的 npm 目标：
  - `check:coach-release`（`scripts/coach-release-gate.mts`，仅 `docs/COACH_LOOP_IMPLEMENTATION_STATUS.md` 提及）
  - `test:coach:mutation`（`scripts/coach-loop-mutations.mts`，`docs/ALGORITHM.md` 提及）
  - `test:ios:live` / `test:ios:mutation` / `test:ios:mutation:scope`（`docs/IOS_NATIVE_RUNBOOK.md`、`docs/IOS_NATIVE_SYNC_PROTOCOL.md` 提及）
  - `data:verify-v2-release`（仅 `docs/OPERATIONS.md:173` 的"离线发布演练"一节）
- **机制**：与 2026-10-19 的事故（`check-pr5-facts-analysis.py` 连续 6 天零执行，见 `.githooks/pre-commit:41-44`）**完全同形态**。当时用"孤儿直接判红"修掉了 iOS 那一支，但**没有把同一判据推广到 coach 与 Rust/ML 侧**。
- **影响**：`docs/ALGORITHM.md` 与 `COACH_LOOP_*` 把 `check:coach-release` 当发布判据写，读者会以为它被执行。这属于"门禁五形态"里的第 1 形态（判据存在、无人执行），正是本仓库反复付代价的那一类。
- **建议**：把 `run-ios-python-gates.mjs` 的 `findOrphanGates()` 抽成通用小脚本（"npm 脚本里的 `check:*|test:*|review:*` 必须被 hook / CI / OPERATIONS 发布清单之一引用"），挂在 pre-commit 或 `check:scripts` 里；对确实只给人工用的入口显式加豁免表（如 `data:verify-v2-release` 是演练，写进豁免）。

### Q7（P2）"现行文档"面仍有 2 处退役残留，且没有任何门禁能看见它们

- **证据等级** E1 + E2（`node` 探针：对 `docs/*.md`、`docs/adr/*.md`、`README.md`、`AGENTS.md`、`deploy/README-UBUNTU.md` 抽取 209 处反引号仓库路径并逐条 `fs.existsSync`）。
- **实测**：209 处反引号路径中 **17 处目标不存在**，分类后：**9 处是刻意的退役叙述**（`docs/DECISIONS.md` D17 两处、`docs/adr/ADR-006` 四处的 `apps/web` 家族、`AGENTS.md:79-80` 的禁线清单三处），**2 处是刻意不入库的生成物**（`docs/DATA_PIPELINE.md:80`、`docs/PROJECT_REVIEW.md:82` 的 `docs/DATA_AUDIT.md`，`.gitignore` 显式忽略），**4 处位于已加更正说明的时点快照**（`docs/TODAY_PLAN_CARDS_REVIEW.md:82` 已就地写明 `docs/WEB.md` 随 D17 删除），**1 处是同步设计的历史叙述**（`docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md:392`）。**真正无解释的路径漂移只有 1 处**：
  - `docs/SYNC_COMPUTE_SCALING_PLAN_2026-10-17.md:4`：`- 范围：... apps/web/src/ios ...`（该文件由 `README.md:84` 作为现行入口链接，无任何更正标注）。
  另有一处**命令漂移**不在路径统计内：
  - `docs/COACH_LOOP_OPTIMIZATION_PLAN.md:1431`：§11.1「未来工程验证命令」仍列 `npm run build`（已随 D17 删除；`AGENTS.md:75-80`「Retired Surfaces」与 `docs/DECISIONS.md:151` 明令不得再加）。
- **机制**：`check-doc-links.mjs:35,40` 为了修假阳性**剥离行内代码**，于是文档里绝大多数"路径"（写成 `` `path` ``）在所有门禁里**不可见**；`check:doc-refs` 只解析 `文件:行号`。全仓 703 条链接里只有 2 条带 `#anchor`（实测：`docs/ARCHITECTURE.md:61`、`docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md:828`），所以"锚点判据"虽然在 HEAD 是真的（`check-doc-links.mjs:90,122,142` 计数、校验并在汇总行打印），**覆盖面是 0.28%**。
- **影响**：文档漂移的系统性风险不在"链接坏了"（那个有门禁），而在"承诺的路径/命令已经不存在"（无门禁）。读者照 `README.md:84` 的现行入口进去执行 `npm run build` 会拿到 `Missing script`。
- **建议**：在 `check-doc-links.mjs` 里加**第三道判据**（软告警优先）：对现行范围（`docs/` 非时点快照 + `README.md` + `AGENTS.md` + `deploy/*.md`）的反引号路径做存在性检查，豁免表显式列出 `apps/web`（D17 叙述）与 `docs/DATA_AUDIT.md`（生成物）；先出报告、红了再谈硬失败。

### Q8（P2）审查流程与 `check:docs` 互斥：每轮新增的 deliverables 文档必然让门禁变红

- **证据等级** E2（实跑）。审查开始时 `npm run check:docs` → `Documentation: 107 files, 703 local links, 2 anchors, **1 problems**`，**EXIT=1**，唯一问题是 `deliverables/architecture-review-2026-10-20/BRIEF.md: not reachable from README.md`（未跟踪、未被忽略，`check-doc-links.mjs:26` 的 `git ls-files --others` 把它算进来了）。三轮 lane 报告落盘后再跑：`110 files, 703 local links, 2 anchors, **4 problems**` —— BRIEF + `02-domain-data.md` / `03-ios-client.md` / `04-platform-quality.md` 全部不可达，**EXIT=1**。
- **机制**：门禁把"孤儿文档"当硬错（设计正确），而审查流程要求每轮把新报告放进 `deliverables/`，两者的交点只有一个人肉索引：`deliverables/README.md` 的「当轮审查」节。实测 churn：**30 天内 `deliverables/README.md` 被改 47 次，是全仓最高**（第 2 名 `packages/api-contracts/src/index.ts` 37 次，共 319 个提交）。
- **影响**：不是缺陷，是**结构性摩擦**——门禁的"可达性"判据把审计产物变成了门禁输入，于是每个 lane 都要请求 Lead 改索引，或者每次审查结束前仓库处于红状态。它同时说明 README 的"每个主题只保留一份现行说明"在这类目录上靠人工维护。
- **建议**：`check-doc-links.mjs` 对 `deliverables/` 下"当轮"目录放宽为**告警**（与 `.archify/` 的锚点豁免同构，理由同：时点产物），或把 `deliverables/README.md` 改成由目录列表自动生成的小节（`scripts/` 里已有大量同类生成能力）。二者都不降低"docs/ 下不许有孤儿"的强度。

### Q9（P3）43/105 条 npm script（41.0%）的唯一职责是跑 Node 版本检查

- **证据等级** E2（`node` 统计 18 个 `package.json`）。`package.json:18-37` 起共 **42 条 `pre*`**，全部只执行 `node scripts/check-node-version.mjs` 或 `npm run check:node`；加上 `check:node` 自身，**43 条 script 的整个 body 就是这一句**（43/105 = 41.0%）。`preinstall`/`pretypecheck`/`pretest` 与其余 39 条语义完全重复。
- **影响**：`check:scripts` 的判别面被放大 41%（105 条里 43 条是同一句），`npm run` 每次多一次进程；跨平台规则（`AGENTS.md:60-67`）要在这 43 条上逐条成立。
- **建议**：保留 `preinstall`/`pretypecheck`/`pretest`/`prestart` 四条，其余 38 条删除。注意这 42 条**确实是会触发的**（`npm run data:import` 会跑 `predata:import`），所以问题不是空转而是复制：同一句判据写 42 遍，改一次要改 42 处，且 27 个 `data:*` CLI 目标（对应 28 条 `predata:*`）本可以在 `tsx` 入口侧统一校验一次。

### P3 合并表

| ID | 级别 | 位置 | 机制与建议 |
|---|---|---|---|
| Q10 | P3 | `scripts/check-blob-size.mjs:33`（1 500 000 B）vs `design/ios-ui-concept-v2.png`（**1 428 042 B**） | 最大件占上限 95.2%：设计图重导一次就会让**每一次提交**变红。建议把该图挪到仓库外或提到 2 MB（附理由），不要等它撞线。 |
| Q11 | P3 | `scripts/check-doc-line-refs.mjs` 默认 15 份文档 | 实测汇总行已诚实打印「内容漂移 **未核对（无基线；15 份文档均无 `.linerefs.json`）**」，`.linerefs.json` 基线全仓为 0（上一轮 F1 的"假绿措辞"已修，判据本身仍未启用）。建议保持现状并在 `docs/OPERATIONS.md:48` 已有的 `--require-baseline` 说明上，把"发布前对该快照写基线"写成发布记录的一项。 |
| Q12 | P3 | `docs/` 主题分布 | 31 份 md（28 顶层 + 3 ADR）中，**单一主题"iOS/直连同步"占 9 份**（`IOS_NATIVE_SYNC_PROTOCOL`、`IOS_SYNC_PERFORMANCE_REVIEW`、`IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN`、`IOS_SYNC_RECHECK_FIX_PLAN`、`SYNC_COMPUTE_SCALING_PLAN`、`SQLITE_DIRECT_SYNC_DESIGN`+PR2/3、PR4、PR5），"训练计划"占 7 份。`docs/DECISIONS.md:85` 与 `README.md:66` 声称「一主题一份现行文档」——**该主张在同步/排课两个主题上不成立**。建议不改文档，改口径：把"设计系列（上位设计 + PR 分解）"与"审查/方案快照"在 README 表格里分成两组，并给每组一行"谁取代谁"。 |
| Q13 | P3 | `README.md:66-91` 文档表 22 行 | 31 份 docs 中 **12 份不在 README 表内**（含 3 份 ADR、`docs/IOS_NATIVE_API_CONTRACT.md`、`docs/IOS_NATIVE_SYNC_PROTOCOL.md`、`docs/COACH_LOOP_IMPLEMENTATION_STATUS.md` 等）；它们靠二级链接可达（`check:docs` 只要求可达，不要求入口）。其中 **ADR-004（HealthKit 同步四条不变式）只能经 `DECISIONS.md:36` 到达**，是硬约束里最深的入口。建议 README 表加一行「ADR / 不可变式」指向 `docs/adr/`。 |
| Q14 | P3 | 环境变量面：全仓 **29** 个 distinct `process.env.*`（24 个 `RAI_*`） | 实测 **8 个在 README/AGENTS/OPERATIONS/ARCHITECTURE/DECISIONS/deploy 文档中完全未出现**：`RAI_DEPLOYMENT_MODE`（**安全相关**：`server.ts:1032` 决定 `localOnly`）、`RAI_PYTHON`、`RAI_REQUIRE_RUST_TESTS`、`RAI_ROUTE_DUMP`，以及 4 个 `TEST_*` 夹具变量。结论：**这个配置面完全可治理**（29 个足够小），但没有一条门禁要求"新 env 必须登记"。建议加一条静态检查：`deploy/rai.env.example` ∪ 文档 ≈ 代码读取集合（`TEST_*`/`RAI_PYTHON`/`RAI_ROUTE_DUMP` 进豁免表）。 |
| Q15 | P3 | `.github/workflows/ci.yml:7-13`、`.workflow/master-ci.yml:1-3` | CI 覆盖仍为 0（gitee 不触发 GH Actions，Gitee Go 是草案）——但 `README.md:54-58` 与 `docs/OPERATIONS.md:47` 已把这件事写成硬要求（发布记录必须写明"CI 未启用、判据来自本机"），且 `.workflow/master-ci.yml:41-53` 的命令清单与 OPERATIONS 发布清单已对齐。**风险已从"隐瞒"降级为"成本"**：每次发布要在本机跑 12 条 + 分钟级全量，没有远程二次验证。 |
| Q16 | P3 | `npm audit --omit=dev`（实跑 EXIT=1） | 仍为 **4 moderate**（`sprintf-js ← roarr ← global-agent ← onnxruntime-node`，`fix` 需越界到 `onnxruntime-node@1.30.0`）。已在 `docs/OPERATIONS.md:111-117` 记录可达性与处置边界。供应链判断：**可接受**（lockfile 提交、`engines` 严格、`overrides` 有先例、无 postinstall 脚本面以外的高危链）；本轮无需动作，只需在下次 `onnxruntime` 升级时带上这条记录。 |
| Q17 | P3 | `crates/rai-data-worker/Cargo.toml` + `rust-toolchain.toml`（1.98.1） | 依赖全部 `=` 精确锁、`Cargo.lock` 已提交、CI 与 toolchain 文件一致（`ci.yml:32`）。但 `rust:verify`（11 项内置回归）**不在 pre-commit**，`rust:build` 也无人调用；改动 `crates/**` 的提交在本地没有任何 Rust 判据。建议 pre-commit 加一条"`crates/**` 或 `Cargo.*` 改动时跑 `rust:verify`"（约 40 s，可与 storage-sqlite 的 40 s 门禁同级）。 |
| Q18 | P3 | `research/pyproject.toml`（`>=3.12,<3.14`）+ `requirements.lock`（33 行全 `==`） | 环境固定、`ml:check` 实跑通过（上轮 E2），但**工件交接只靠约定**：`research/README.md`「工件目录必须是新目录，内容/manifest/hash 不可原地覆盖」没有任何门禁（`packages/application/src/prediction-model-service.ts` 侧的校验是运行时的，不是提交期的）。建议保持（属运行时不变量，归 Lane 1/3），本条只登记"研究侧无提交期判据"。 |
| Q19 | P3 | `docs/ARCHITECTURE.md:3`（维护日期 2026-10-07） | 架构文档最后维护 13 天前，而 `apps/api` 在过去 30 天被改 676 次、`packages/api-contracts/src/index.ts` 被改 37 次（churn 第 2）。`docs/ARCHITECTURE.md` 本身仍准确（我逐条核对 workspace 职责表与 16 个包一致），但**"维护日期"没有门禁**：它不会因代码漂移变红。建议把它降级为"结构摘要 + 指路"，把易漂移内容（包表）改成从 `package.json` 生成的最小清单。 |
| Q20 | P3 | `.githooks/pre-commit:14`（`npm run typecheck`，**22.17 s** 实测） | 提交成本 ≈ 22 s（typecheck）+ 约 5 s（文档/结构门禁）+ 条件项（计划定向回归 ~5 s、`storage-sqlite` 40 s、`apps/ios` 分钟级）。对小改动，"每次提交全量 typecheck"是最大的固定成本；`tsconfig.pure.json` 已存在但未被用作快速路径。建议（可选）：按暂存路径选 profile（纯包改动只跑 `pure`），收益约 10 s/次，不改判据语义。 |
| Q21 | P3 | `deploy/nginx-rai.conf:51`（`listen 443 ssl http2`）与缺失的 HSTS/default_server | nginx ≥1.25 已把 `http2` 移出 `listen`（Ubuntu 22.04/24.04 自带 1.18/1.24，当前写法安全，但升级发行版时会出 warning）；无 `Strict-Transport-Security`（`add_header` 已有 `X-Robots-Tag`，加一行即可）；443 无 `default_server` 拒绝未知 Host（Host 判据全在应用层）。三条都是防御性建议，不影响当前可用性。 |

## 4 量化指标

| 指标 | 值 | 命令/来源 |
|---|---|---|
| 门禁实跑（本轮） | `check:docs` **EXIT=1**（起始 1 problem，三轮报告落盘后 4 problem，见 Q8）；`check:doc-refs` **0**；`check:scripts` **0**（18 包 / **105** script）；`check:acceptance-matrix` **0**（80 cited）；`check:package-boundaries` **0**（16 包 / 31 边 / 4 禁线，`--self-test` 8 项过）；`check:ios-gates` **0**（10 支判据，跳过 2）；`check:training-plan-single-writer` **0**（R1–R5，465 生产文件 / 122 测试文件 / 违规 0）；`check-blob-size` **0**（**1115** 个跟踪文件）；`deploy-{cloud,n100,upgrade}.test.ts` **16 pass / 0 fail / 29 s**；`npm audit --omit=dev` **EXIT=1**（4 moderate） | 逐条实跑 |
| 门禁时长 | `typecheck` **22.17 s**（`/usr/bin/time -p`）；文档三闸 0.5–1.5 s；iOS 结构门禁 ~1 s；deploy 合同测试 29 s | E2 |
| 测试规模 | **278** 个被跟踪测试文件，全部落在发现范围内（`assertAllTrackedTestsDiscovered` 断言成立）；`test(`/`it(` 行首计数 **≈2130**（E3 估算，非执行计数）；最重 3 个文件 `worker.test.ts` 2839 行、`server-runtime.test.ts` 2517、`weekly-plan.test.ts` 1681；`apps/api/test` 117 文件为最大簇 | `git ls-files` + `grep -c` + `run-tests.mjs` 导入 |
| 门禁自身 | `scripts/` = 18 `.mjs` + 37 `.mts` + 1 `.sh`；**18 支 `.mjs` 不在 `tsconfig` 内**；13 支零测试引用；仅 1 支有 `--self-test` | `tsconfig.json:20-24` + 逐支 grep |
| npm script 面 | 105 条 / 18 个 `package.json`；**42 条 `pre*`** + `check:node` 共 43 条 body 只是一句版本检查（41.0%） | `node` 统计 + `check:scripts` |
| 文档 | `check:docs` 口径 **107** 份 md / **703** 条本地链接 / **2** 条带锚点；`docs/` 31 份、`deliverables/` 64 份；反引号仓库路径 **209** 处、**17** 处目标不存在（其中 1 处真实路径漂移 + 1 处命令漂移，见 Q7） | 实跑 + `node` 探针 |
| 仓库 | 已跟踪 **1115** 文件 / **51.8 MB**；最大 blob `design/ios-ui-concept-v2.png` **1 428 042 B**（上限 1 500 000 的 95.2%）；`.archify` 6 个 HTML 各 ~0.77 MB | `git ls-tree -r -l` |
| env 面 | **29** 个 distinct `process.env.*`，**24** 个 `RAI_*`，**8** 个未在运维文档出现 | `git grep -ho` + 文档交集 |
| churn（30 天，319 提交） | 文件前列：`deliverables/README.md` **47**、`packages/api-contracts/src/index.ts` **37**、`apps/api/src/data.ts` **32**、`apps/api/src/server.ts` **31**、`apps/ios/RAI/HealthKitSync.swift` **28**、`package.json` **22**、`README.md` **19**；目录前列：`apps/ios` 782、`apps/api` 676、`packages/application` 205、`packages/storage-sqlite` 203、`docs/` 34 | `git log --since=2026-09-20 --name-only` |
| 平台层体量 | `deploy/` 14 个文件共 **983** 行；`scripts/` **8211** 行；`research/` 2246 行；`crates/` 808 行 | `wc -l` |

## 5 建议与优先级

**第一批（本周，不改任何不变量）**

1. **Q4 回滚闭环**：`upgrade.sh` 失败自动回退 HEAD + 重启 + 复验；测试钉住。风险低（脚本在停服窗口内，且现行为就是失败停服）。不改 D3/D5。
2. **Q8 门禁与流程解耦**：`deliverables/` 的可达性降为告警（与 `.archify/` 锚点豁免同构）。收益是每轮审查不再以红状态开始/结束。不改"docs/ 不许有孤儿"的强度。
3. **Q14 env 登记闸门**：一条静态检查，`deploy/rai.env.example` ∪ 文档 ⊇ 代码读取集合（带豁免表）。先把 `RAI_DEPLOYMENT_MODE` 补进 `deploy/rai.env.example` 注释——它是安全开关却无人知道。

**第二批（两周内，小结构改动）**

4. **Q2 失败可见性**：`OnFailure=` 或 systemd timer 日检（`is-failed` + `NRestarts` 增量），一行模板 + 一段 runbook。
5. **Q5 门禁自检**：`tsconfig.scripts.json`（`allowJs`+`checkJs`）并入 `typecheck`；给 `check-doc-links.mjs` 补 `/tmp` 夹具自测 8 条。
6. **Q6 孤儿门禁通用化**：把 iOS 的 `findOrphanGates()` 抽成通用判据（`check:*|test:*|review:*` 必须被 hook/CI/发布清单引用之一），对 `data:verify-v2-release` 显式豁免。
7. **Q1 内存算术**：导入 worker 的 `resourceLimits` 一行 + env example 里写清 isolate 数 × 512 MB。

**第三批（结构性，需单独决策）**

8. **Q3 两套 profile 归一**：n100 补 watchdog 与 `log_format`，或文档显式分节并标注差异。属产品决策（家庭 VM 是否要继续维护）。
9. **Q9 npm script 收缩**（105→67）：`pre*` 从 42 条收到 4 条（+`.npmrc` 的 `engine-strict`），同时缩小跨平台判别面。
10. **Q17/Q19 churn 治理**：`rust:verify` 进 pre-commit（按路径触发）；`docs/ARCHITECTURE.md` 的包表改为最小编号清单以降低维护日期压力。

**不建议在本轮做**：`npm audit fix --force`（Q16 已记录边界）、把 `.linerefs.json` 基线无条件提交（会让无关源码行移动打红 pre-commit，`docs/OPERATIONS.md:48` 已解释）、把全量 `npm test` 搬进提交钩子（分钟级，属发布档）。

## 6 未验证边界

- **未跑全量 `npm test` / `test:ios` / `smoke:api`**（BRIEF 归属 Lead）。因此"2038+ 测试"的分级与时间预算只做了**文件级**核对（278 个文件全部被发现），没有执行级的时间分布；`≈2130` 用例数是 `grep` 估算（E3）。
- **`OOMPolicy=stop` 与 `Restart=on-failure` 的组合语义未实测**（Q1）：我确认了预算算术与 worker 线程无 `resourceLimits`，但"OOM 后是否被自动拉起"取决于 systemd 版本判定，属推断。
- **无 Linux/systemd 环境**：`nginx -t`、`systemctl daemon-reload`、`check-runtime-readonly.sh`、watchdog 实际触发均未跑；`deploy-*.test.ts` 用文本/fake-systemctl 覆盖，不代表线上行为。n100 的 FRP 拓扑未做任何实测。
- **Windows 入口未实测**（本机 macOS）：`check:scripts` 只做语法判别，`test:ios` 的 Windows 跳过契约由 `cross-platform-scripts.test.ts` 钉住但本 lane 未执行该测试文件。
- **`.archify/` 审计目录**只做了体量与豁免清点，未复核其 6 张图的内容。
- **跨 lane 待 Lead 合并**：Q1 的 worker 内存、Q16 的 `onnxruntime` 是否在 API 生产路径加载（依赖调用链）、Q18 的工件校验语义，均与 Lane 1/2/3 的领域重叠；`deploy` 侧的 16 条合同测试结果只在本报告登记一次，其它 lane 若引用请以本条为准。
