# 开发与运维

入口：[README](../README.md)；云端系统配置：[Ubuntu部署](../deploy/README-UBUNTU.md)；iOS：[runbook](IOS_NATIVE_RUNBOOK.md)。
以下命令中的数据库路径必须显式核对。检查源码/生成报告不等于已迁移或发布真实库。

## 开发和门禁

Node22.x/24.x按[版本检查](../scripts/check-node-version.mjs)执行；生产TS通过tsx，不切换执行通道绕过migration校验。

```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run check:docs
npm run check:doc-refs
npm run check:acceptance-matrix
npm run check:package-boundaries
```

`npm test`通过[Node入口](../scripts/run-tests.mjs)显式枚举用例并启动Node套件，不依赖POSIX shell；退出码即最终结果。
`npm test` 的默认并发 = 本机可用并行度；多核/高负载机器上重文件会互相挤占，测试内 5 s / 30 s 墙钟预算可能被压红（**假红**，原理见脚本头注释）。要一份可复现的独占结果用 `RAI_TEST_CONCURRENCY=2 npm test`（非法值会响亮报错，不会静默回落）；发布记录必须写明所用并发。
`.githooks/pre-commit` 每次都跑 typecheck、**仓库体积闸门**（单文件 1.5 MB 上限）、文档/包边界检查与文档引用检查；`packages/storage-sqlite/` 有改动时跑迁移冻结门禁，触发面含表分类清单一致性（见钩子注释）。

本地hooks在[pre-commit](../.githooks/pre-commit)；[CI配置](../.github/workflows/ci.yml)存在不证明当前远端已触发它。`.workflow/master-ci.yml` 是**未启用的 Gitee Go 草案**。
完整审查另跑`npm run ml:test`、`npm run test:ios`、按需要`npm run rust:verify`；缺工具/SDK应报跳过或阻塞，不自动安装大型依赖。
本仓库**没有** Web/responsive/390px 门禁或测试套件；不要按退役前的说法去找它们，也不要把它们加回 `package.json`。不要在排障时删除真实健康库、凭证或旧可用工件。

## 环境变量（生产）

变量的事实来源是代码读取点与 `deploy/rai.env.example`；**新增或改名 env 时必须同时更新本表与模板**。仓库不保存任何真实 Token/密钥。

| 变量 | 默认 | 作用与边界 |
|---|---|---|
| `RAI_API_HOST` / `RAI_API_PORT` | `127.0.0.1` / `8787` | 监听地址。云端由 nginx 反代，不直接暴露端口 |
| `RAI_API_TOKEN` | 无 | Bearer 令牌；云上**必须**配置，否则经 nginx 后 Host 非 loopback，请求被判 403 |
| `RAI_DEPLOYMENT_MODE` | 未设置=本地 | **安全相关**：`/v1/health` 的 `localOnly` 字段由 `!== "cloud"` 决定。云端应设为 `cloud`，让客户端/探针能把「本地开发」与受管部署区分开；不写它不会关闭鉴权，但会一直报告 `localOnly=true` |
| `RAI_ALLOW_REMOTE_TOKEN_AUTH` | `0` | 允许非 loopback Host 携带 Token 访问；云端示例为 `1` |
| `RAI_ALLOWED_ORIGINS` | 空 | 仅浏览器跨源用；iOS 不发 Origin，保持空或只列已知源 |
| `RAI_PUBLIC_HOSTS` | 空 | 匿名只读 Host 白名单；2026-10-18 起匿名范围只有 `GET /v1/health`、`/v1/handshake`、`/v1/runtime-status`，业务读/写一律要 Token |
| `RAI_ALLOW_ANONYMOUS_ROUTES` | `0` | 仅本地匿名原始轨迹；生产不得设置 |
| `RAI_LOG_LEVEL` | `info` | 调成 `warn` 会丢掉 Fastify 的 `incoming request`/`request completed` 证据 |
| `RAI_RUNTIME_ROOT` | 仓库根 | 整 runtime 根；云端 `/var/lib/rai`，备份以它为边界 |
| `RAI_DATABASE` | `<runtime>/var/rai.sqlite` | 主健康库 |
| `RAI_CONTROL_DATABASE` | `<runtime>/var/rai-control.sqlite` | 控制库（计划/目标/回执）；schema v2 在 API 启动时自动追加 |
| `RAI_SERVER_ID` / `RAI_ATHLETE_ID` / `RAI_DATASET_EPOCH` | `local` / `athlete_1` / `default` | 同步身份三元组；升级时必须沿用旧值，否则客户端 anchor/cache scope 变化 |
| `RAI_IMPORT_MAX_ZIP_BYTES` | `67108864`（64 MiB） | 单批上传 ZIP 上界；与 nginx `/v1/imports/uploads` 的 `client_max_body_size` 成对 |
| `RAI_IMPORT_ENGINE` | `typescript` | **API 的两条导入车道要求 `engine.name === "typescript"`**：设成 `rust` 会被车道判定以 `engine_<name>` 拒绝（客户端稳定码 `direct_sync_unavailable`，终态失败且只退避重试）。它只对 **CLI `data:import` / benchmark** 的解析引擎有意义 |
| `RAI_RUST_BINARY` / `RAI_RUST_FALLBACK` | 仓库 `target/release` / `none` | 启用 Rust CLI 路径时必填/受控；缺二进制且 fallback=none 会让 API 启动失败 |
| `RAI_IMPORT_DATA_ONLY_FAST_PATH` | `1` | `0`（并重启）会暂停直连同步入口：以 `fast_path_disabled` → 稳定码 `direct_sync_unavailable` 显式失败，**不会**回退候选/换库链路 |
| `RAI_ANALYSIS_INPUT_MAX_ROWS` / `_BYTES` / `_READ_ROWS` / `_READ_MS` | 代码默认 | 事实物化预算；只接受正整数（非法/非正数退回默认），不存在「关掉预算」的取值——调小会收紧预算，超预算路径走分段校验读 |
| `RAI_BACKUP_MAX_COUNT` / `_TOTAL_BYTES` / `_MIN_FREE_BYTES` | 10 份 / 20 GiB / 512 MiB | 现在只约束**恢复/删库安全快照**与已有备份的容量：常规备份创建已退役 |
| `RAI_ROUTE_DUMP` | 空 | 诊断：设为文件路径后，启动时把 Fastify 实际挂载路由写成 JSON；只读排障用 |
| `RAI_REQUIRE_RUST_TESTS` | 空 | `scripts/rust-worker.mjs verify` 内部置 1；手动验证 Rust parity 时让缺产物变红，而不是跳过 |
| `RAI_TEST_CONCURRENCY` / `RAI_DOC_REFS_REQUIRE_BASELINE` | 空 | 测试并发 / 文档引用必须带基线；属发布与 CI 开关 |
| `RAI_PYTHON` | 受管环境 | 仅 `research/` 训练栈选 Python 解释器；不是 `npm start` 前置 |

## 发布检查清单

发布前在能跑全量的机器上逐条执行（`npm test` 是分钟级，不在提交钩子内）：

```bash
npm run typecheck
RAI_TEST_CONCURRENCY=2 npm test
npm run check:docs
npm run check:doc-refs
npm run check:scripts
npm run check:acceptance-matrix
npm run check:package-boundaries
npm run check:package-boundaries -- --self-test
node scripts/check-blob-size.mjs
npm run review:model-boundaries
npm run smoke:api
```

- **CI 现实**：本仓库远端是 gitee，GitHub Actions **不会**被 gitee 的 push 触发；`.workflow/master-ci.yml` 是**未启用的草案**。因此发布记录必须写明「gitee 侧 CI 未启用、判据来自本机实跑」，以及 `RAI_TEST_CONCURRENCY` 取值与被跳过的检查（缺 Xcode / 缺平台 / 缺 Rust 工具链导致的跳过不得合并进“通过”）。
- **文档行号引用的内容漂移**：`npm run check:doc-refs` 默认只做“越界/无法解析”硬校验；**内容漂移**需要 `.linerefs.json` 基线，日常提交**不要求**基线（缺基线时输出写“未核对（无基线）”）。要对本次发布快照做内容级核对时：先 `node scripts/check-doc-line-refs.mjs --write-baseline` 生成基线并随快照归档，再用 `node scripts/check-doc-line-refs.mjs --require-baseline`（或 `RAI_DOC_REFS_REQUIRE_BASELINE=1`）判定；基线文件不要无条件提交（无关源码行移动会把它变成噪音）。现行文档尽量写符号/文件引用而不是绝对行号。
- **`.mts` 脚本**（如 `review:model-boundaries`、`verify-v2-release`）是 TypeScript：必须走 `npm run` / `tsx`，裸 `node scripts/xxx.mts` 会 `ERR_MODULE_NOT_FOUND`。
- **模型边界对抗探针**（`npm run review:model-boundaries`，R1–R3）只读、用合成库并在 finally 清理；`violationCount > 0` 时 exit 1，不得用“这次没改”跳过它。
- **deploy/ 模板变更**：仓库里改完不等于线上生效。服务器上 `nginx -t` 通过后 `systemctl reload nginx`；unit 复制后用 `systemctl daemon-reload` → `restart` → 核对 `Type`/`NRestarts`/`WatchdogUSec`（见下节「线上可观测性与 hang 守护」）。
- **控制库/主库**：主库迁移走 `data:migrate`；控制库 schema 由 API 自动追加，控制库**数据**迁移走 `scripts/migrate-training-planner.mts`（见「控制库训练计划迁移」）。两者都必须在维护窗口内、先做一致性备份。

## 部署 profile：云端（现行）与 n100（固定的备选）

- **云端是唯一现行生产拓扑**：2 核 2 GiB 单机，[systemd unit](../deploy/rai-api.service) 用 `Type=notify` + `NotifyAccess=all` + `WatchdogSec=120`；[nginx](../deploy/nginx-rai.conf) 只反代 `/v1`（`/v1/`、`^~ /v1/backups`、`= /v1/imports/uploads` 三个 location），默认 120 s、备份/上传 600 s，443 访问日志写 `rai-access.log`（自定义 `rt=/urt=` 格式），其余路径 404。回滚/误杀边界见下文。
- **`deploy/n100/` 仍是仓库钉住的备选 profile**（家庭 VM），由 `apps/api/test/deploy-n100.test.ts` 保持文本契约。差异是真实存在的：unit 是 `Type=simple`（**没有 watchdog**），nginx `access_log off`（**没有 `rt=/urt=`**）、`proxy_read_timeout 60s`，并带 FRP 模板（`frp@.service`/`frpc.toml`/`frps.toml`）。历史上的 nginx `18787` 与 env `8787` 不一致已于 2026-10-20 在模板中统一为 `8787`；其余差异是有意的 profile 边界，不是可照抄云端的配置。
- 本页其余「hang 守护/可观测性」结论**只适用于云端 profile**。不要按云端 runbook 升级 n100，也不要把 n100 模板复制到云端；n100 不迁移、不安装 FRP 仍是产品现状。

## 线上可观测性与 hang 守护

2026-10-18 生产 `-1001` 事故复盘出的两个运维放大项已修：nginx 的 3600 s 读超时把「后端无响应」变成客户端自己 15 s 超时（-1001），nginx 既不产生 504、日志也没有耗时字段；systemd 只有 `Restart=on-failure`，「进程活着但不响应」永远不会自动恢复。云端模板现在是：

- nginx：自定义 `log_format rai`（含 `$status $request_time $upstream_response_time $upstream_status $upstream_addr $request`），443 站点写 `/var/log/nginx/rai-access.log`；默认 `proxy_read_timeout`/`proxy_send_timeout` **120s**、`proxy_connect_timeout 5s`；已知长读只有两处例外，均为 **600s**：`location = /v1/imports/uploads`（ZIP 上传/导入）与 `location ^~ /v1/backups`（备份下载/恢复——504 不会中止服务器上的恢复，只会让执行方误判失败）。
- systemd：`Type=notify` + `NotifyAccess=all` + `WatchdogSec=120`。API 侧契约：listen 后 `READY=1`、每 40 s `WATCHDOG=1`、关闭时 `STOPPING=1`；无 `NOTIFY_SOCKET` 时 no-op，发送走 `/usr/bin/systemd-notify` 子进程。

**为什么默认是 120 s 而不是压到 15 s 以下**：客户端 15 s 先超时的形态已经能靠 `499 + rt≈15` 复盘，而把 nginx 压到 12 s 只是把一次失败从 `-1001` 换成 `504`，并不能减少用户可见失败；反而会误伤合法的长写（导入 inspect、ONNX 预测刷新、备份恢复）。hang 的**恢复**由 systemd watchdog 负责，nginx 侧只负责**可观测**与「不无限占连接」。

### 看 rt=/urt= 与 499/504

自定义格式后，**443 请求不再写入 `/var/log/nginx/access.log`**，排障只看新文件：

```bash
sudo tail -n 20 /var/log/nginx/rai-access.log
# 状态码分布（组合格式前 10 个字段未变，$9 仍是 status）
sudo awk '$9==499||$9==504||$9==502{n[$9]++} END{for(k in n) printf "%s=%d\n", k, n[k]}' /var/log/nginx/rai-access.log
# 最近挂过的请求：rt= 看得见「挂了多久」，这是本次复盘最缺的东西
sudo awk '$9==499||$9==504' /var/log/nginx/rai-access.log | tail -20
```

判读：

- **499 + `rt≈15`** = 客户端自己先超时（iOS 是 15 s）⇒ 就是 `-1001` 在服务端的对应事件；499 + `rt<1` = 用户切页/取消，不是事故。
- **`urt=-`** = 上游一个字节都没回（hang 的典型形态）；有 `urt=` 说明后端确实回了，只是慢。
- **504** = nginx 等满默认 120 s 才放弃（不再是 3600 s）：真 hang 和确实超过 2 分钟的慢请求都会被截断。
- **502** = 进程死了/正在重启（不是 hang）；**429** = 限流（`limit_req`）。
- 日志轮转沿用发行版默认的 `/etc/logrotate.d/nginx`（glob `/var/log/nginx/*.log`），部署后顺手确认它覆盖到新文件。
- 首次 `reload` 后若 `error.log` 报新日志文件 `Permission denied`，检查 `/var/log/nginx` 的属主/权限（Ubuntu 默认 `www-data` 可写）；`nginx -t` 只测语法，不测运行期文件权限。

服务端耗时看 API 自己的日志（`RAI_LOG_LEVEL=info` 是默认值，调成 `warn` 会丢掉这条证据）。`incoming request`/`request completed` 来自 Fastify 的默认请求日志，本项目没有另写一份：升级 Fastify 或打开 `disableRequestLogging` 之前要保留这两个事件。

```bash
sudo journalctl -u rai-api --since '-10 min' | grep 'request completed' | tail -20
# 有 jq 时直接量化 responseTime
sudo journalctl -u rai-api --since '-20 min' -o cat | jq -R 'fromjson? | select(.msg=="request completed") | .responseTime' \
  | awk '{n++; if($1>m)m=$1; if($1>1000)a++; if($1>5000)b++} END{printf "n=%d max=%.0fms >1s=%d >5s=%d\n", n, m, a, b}'
```

有 `incoming request` 但没有 `request completed`（或十几秒后才补上）就是事件循环被占住的直接证据。

### hang 守护：判据、误杀与回滚

- 判据：**事件循环心跳** 120 s 没更新 ⇒ systemd 发 SIGABRT 并按 `Restart=on-failure` 重启；`NRestarts` +1，journal 出现 `Watchdog timeout`。判据不是「请求慢」：慢请求只在 nginx 记 `rt=`，不会杀进程。
- 误杀边界：**任何 >120 s 的事件循环同步阻塞都会被判 hang** —— 大导入、长事务、全表扫描、同步重算、GC 风暴都在内。可能超 2 分钟的维护/导入/重算要在停服窗口、CLI 或 worker 子进程里跑；不要放大 `WatchdogSec` 来回避（那等于关掉守护）。
- 核对：`sudo systemctl show rai-api -p Type -p NRestarts -p WatchdogUSec`（期望 `Type=notify`、`WatchdogUSec=2min`；`NRestarts` 只统计自动重启，人工 restart 不 +1）；`sudo journalctl -u rai-api -b | grep -i watchdog`。
- 回滚：把服务器上 unit 的 `Type=notify` 改回 `Type=simple`，**同时删掉** `NotifyAccess=all` 与 `WatchdogSec=120`，然后 `sudo systemctl daemon-reload && sudo systemctl restart rai-api`，再用 `systemctl show rai-api -p Type -p WatchdogUSec` 确认 `Type=simple` 且 `WatchdogUSec` 不再是 `2min`。只改 `Type` 而留 `WatchdogSec` 会让服务没有心跳源却仍在计时。
- 安装/更新顺序（Nginx：`nginx -t` → `reload`；unit：安装 → `daemon-reload` → `restart` → 核对）见[Ubuntu部署](../deploy/README-UBUNTU.md)「运维模板更新」。

### coach-loop 只读 memo（陈旧上界 ≤1 s）

`GET /v1/mobile/coach-loop` 是全同步计算（生产实测 ~1.4 s/条，单事件循环内不存在两条在飞，因此**没有**「并发请求合并」意义上的单飞）。现在的做法是可证明失效的短 TTL memo（[实现](../apps/api/src/coach-loop-memo.ts)），命中必须同时满足：identity scope 相同、控制库稳定快照 digest 相同（saved receipt + goals + plan history）、主库 `<inode>:PRAGMA data_version` 指纹相同、本地日期相同、publication guard 未变化且无 pending、TTL ≤1 s。

- 失效是**立即**的：导入/直连增量/重算发布会推进 `data_version`；控制库写会改变 digest；发布/恢复换库文件会改变 inode。
- 陈旧上界只有 1 s，且只影响响应里的 `asOf`；写路径仍用 `factsHash` 乐观校验（`command()` 拒绝过期 facts），不会让旧快照被当成写依据。
- 内部控制流（设备回执、命令内的事实重读）**不读缓存**，始终走 `read()`。
- 排查：memo 命中不会出现在 journal 的耗时里；要看真实计算频率，重启进程后观察 `coach-loop` 的 `responseTime` 分布，或在压测里对比首条与 TTL 内第二条。

## 已知依赖风险

`npm audit --omit=dev`（2026-10-18）报告 **4 个 moderate**，链路为 `onnxruntime-node → global-agent → roarr → sprintf-js`（GHSA-hp3w-g68c-fv3c：`sprintf-js` 在格式串精度无界时可被 DoS）。处置边界：

- 可达性低：DoS 需要攻击者控制传入 `sprintf` 的格式串；本项目没有把用户输入当格式串用的路径（依赖链在 ML/ONNX 侧）。
- **本轮不做** `npm audit fix --force`：它会把 `onnxruntime-node` 升到声明依赖区间之外，需独立评估模型推理兼容性与工件尺寸。
- 若后续升级，优先在 `overrides` 里固定 `sprintf-js`/`roarr`（项目已有 `adm-zip`、`tsx.esbuild` 的 overrides 先例），再跑 `rust:verify` 与 ONNX 相关回归；升级前保留本记录。

## 迁移：先检查，备份后才 apply

四个持久化文件的边界（备份/迁移/恢复都要一起考虑）：

| 文件 | 内容 | 迁移方式 |
|---|---|---|
| `<runtime>/var/rai.sqlite` | 主健康库（事实、路线、Fitness、模型发布） | `data:migrate` 显式 `--apply`；API 发现待迁移会退出 78 |
| `<runtime>/var/rai-control.sqlite` | 控制库（目标、计划/历史、回执、操作幂等） | schema 由 API 启动时自动追加（当前 v2）；**数据**迁移走 `migrate-training-planner.mts` |
| `<runtime>/var/runtime.sqlite` | 导入来源/任务/运行时状态 | 无独立迁移 CLI；随 API 启动维护 |
| `<rai.sqlite>.dataset-epoch.sqlite` | 删库后的 dataset epoch 侧车 | 恢复/删库路径自动维护；备份时不得漏 |

```bash
npm run data:migrate -- --database /absolute/path/rai.sqlite
# 维护窗口与一致性备份完成后才运行：
npm run data:migrate -- --database /absolute/path/rai.sqlite --apply
```

[迁移CLI](../packages/storage-sqlite/src/migrate-cli.ts)默认只检查；`--apply` 默认会在 `dirname(database)/backups` 生成迁移备份（`--no-backup` 才关闭）。旧migration/checksum不可就地改；迁移按单个版本事务提交，不是全序列事务。
不要与API导入、CLI写者或备份/恢复并行变更同库。备份包含敏感数据，须与主库同等保护。
原库有未应用migration时应明确处理，不靠删库、填伪字段或放宽模型gate让启动变绿。

## 控制库训练计划迁移（2026-10-20 起）

- **schema 自动、数据显式**：控制库 schema 到 v2（`mobile_training_state`/`_history`/`_migration_audit`）由 API 启动时幂等追加；旧 `mobile_goals` 行不改写。控制库**数据**迁移（legacy goals/run_coach/coach_loop → 统一状态）只由运维 CLI 执行，不随启动自动跑。
- 工具：[scripts/migrate-training-planner.mts](../scripts/migrate-training-planner.mts)。**默认 dry-run**；只打开 `--control-db` 指定的控制库，**从不打开主健康库**；不参与 API 的 publication lock，因此**必须在停服窗口执行**。
- 流程：先做控制库一致性备份 → dry-run 记录 `sourceDigest` 与分类/conflicts → 停 `rai-api` → `--apply --expect-source-digest <sha256>` → 启动 API → 核对 v2 读取/状态 revision 与 410 矩阵。详细实测见[统一训练排课 v2 发布记录](../deliverables/UNIFIED_TRAINING_PLAN_RELEASE_2026-10-20.md) §4。

```bash
# 从仓库根目录运行；参数按实际 scope 填写
node --import tsx scripts/migrate-training-planner.mts \
  --control-db /var/lib/rai/var/rai-control.sqlite \
  --server-id local --athlete-id athlete_1 --dataset-epoch default
# 确认 sourceDigest 后，停服再 apply：
node --import tsx scripts/migrate-training-planner.mts \
  --control-db /var/lib/rai/var/rai-control.sqlite \
  --server-id local --athlete-id athlete_1 --dataset-epoch default \
  --apply --expect-source-digest <dry-run 输出的 sha256>
```

## 导入、重算与事实回填

首选 iOS App 的「同步健康」（HealthKit 导出 → ZIP/直连批次）。**API 运行期只有两条导入车道**：`data-only`（严格白名单+基线合同戳）在前、`direct-sync`（统一接收器）在后；两条都不合格时以 `ImportLaneRefusal` **终态失败**（稳定 failureCode），不回退候选库、不做文件换库。[架构](ARCHITECTURE.md)与[数据管线](DATA_PIPELINE.md)描述同一事实。

**CLI 是另一条离线车道**：`npm run data:import -- --input <目录> --database <库> --replace` 走候选暂存 → 发布前 `quick_check` + 外键校验 → 换库 → 安装后轻量结构探针，只对明确可丢弃的副本或维护窗口使用；它不是 API 的回退路径，也不能用来「修一下线上」。CLI 输入目录导入 `--replace` 会重建指定目标，只对明确可丢弃副本使用。

```bash
npm run data:audit -- --database /absolute/path/copy.sqlite --report /tmp/rai-audit.md
npm run data:recompute -- --database /absolute/path/copy.sqlite --evaluated-at 2026-09-30T00:00:00.000Z --timezone Asia/Shanghai
npm run data:backfill-canonical-nights -- --database /absolute/path/copy.sqlite
```

最后一个命令的写入选项以[脚本](../scripts/backfill-canonical-nights.mts)为准；先看默认预览，不把建表当历史恢复事实已回填。
重算/refresh、导入和标签更正有不同dirty范围；不能为了“立即显示新版本”修改旧run JSON。

## 只读模型核验

```bash
npm run data:model-v2 -- --database /absolute/path/rai.sqlite --action inspect
npm run data:prediction-walk-forward -- --database /absolute/path/rai.sqlite --as-of 2026-09-30T00:00:00.000Z
npm run data:load-replay -- --database /absolute/path/rai.sqlite --as-of 2026-09-30T00:00:00.000Z --out /tmp/load-replay.json
npm run data:baseline-rebase-review -- --database /absolute/path/rai.sqlite
```

[Load工具](../scripts/load-replay.mts)比较派生快照可得性，不是原始记录级as_known_then认证。
`insufficient_labeled_outcomes`/not_evaluable是正式结果，不能填0错误率或激活ML替代证据。
消融/归一化/速度盘点默认可能写报告文件，但不得写源库；报告必须标库、截止和配置。

## Rebase、校准与回滚

[维护CLI](../packages/application/src/model-v2-cli.ts)默认dry-run；`--apply`才写指定库，并要求schema已就绪。

```bash
npm run data:model-v2 -- --database /absolute/path/copy.sqlite --action review-baseline --as-of 2026-09-30T00:00:00.000Z
npm run data:model-v2 -- --database /absolute/path/copy.sqlite --action review-baseline --as-of 2026-09-30T00:00:00.000Z --apply
```

review只记录前瞻检查历史/候选请求，不发布epoch。rebase需明确更早的`--reference-start`；rollback需`--run-id`和`--expected-active`，且只能回到保留、兼容、完整的bundle。
`calibrate`、`activate-prediction`仍要通过真实标签、配置/工件/独立区间gate，不是绕过质量控制的管理员捷径。
当前已知限制先看[审查](PROJECT_REVIEW.md)（时点快照），尤其删除/谱系与保留窗口边界。

## 离线发布演练

```bash
npm run data:verify-v2-release -- --database /absolute/path/rai.sqlite --as-of 2026-09-30T00:00:00.000Z --out /tmp/release-rehearsal.json
```

[演练脚本](../scripts/verify-v2-release.mts)只读源库，在临时backup副本迁移/重算/回滚并清理；检查原库hash。
它对本项目当前无校准标签的基线核验fallback。性能只比较同数据/配置下V2全量与无新事实增量的各两轮，不宣称V1→V2提速或精度提高。

## 备份、恢复、删除

**边界（2026-10-13 起，2026-10-20 修订）**：

- API 在**导入、重算、升级、普通同步**中不再创建项目级整库备份；`POST /v1/backups` 与 `DELETE /v1/backups/:name` 已退役为 **410 Gone**（`backup_creation_retired`/`backup_deletion_retired`），两者都不碰任何文件。
- **但恢复与删库仍会写安全快照**：`POST /v1/backups/:name/restore` 在替换前生成 `before-restore` 快照；`DELETE /v1/database` 在删除前生成 `before-delete` 快照。它们落在 `<runtime>/var/backups`，由 `RAI_BACKUP_*` 约束容量/保留。**不要把这些快照当成可再生的**——它们是恢复/删库失败时的唯一回退点。
- 常规一致性备份是**运维责任**：用 [backup-runtime.sh](../deploy/backup-runtime.sh) 冷备或 SQLite 一致性备份 API。升级脚本只打印责任提示，不代做、也不校验外部备份是否完成。

恢复入口保留为运维 curl 流程（Web 前端已于 2026-10-17 退役）：

```bash
# 列出备份；下载单个备份（原始 SQLite 字节流）
curl -fsS -H "Authorization: Bearer $RAI_API_TOKEN" https://<domain>/v1/backups
curl -fsS -H "Authorization: Bearer $RAI_API_TOKEN" -o /srv/rai-backups/<name> \
  https://<domain>/v1/backups/<name>
# 触发恢复。confirmation 必须逐字为「恢复此备份」；恢复期间会停写，可能进入 recovery_required
# 🔴 restore 只按 basename 在 RAI_RUNTIME_ROOT/var/backups 内找文件：
#    如果备份只存在 /srv 或异机，必须先复制回 <runtime>/var/backups/<name> 再调用。
curl -fsS -X POST -H "Authorization: Bearer $RAI_API_TOKEN" -H "content-type: application/json" \
  -d '{"confirmation":"恢复此备份"}' \
  https://<domain>/v1/backups/<name>/restore
# 轮询健康；必须同时 status=ok 且 databaseReady=true
curl -fsS -H "Authorization: Bearer $RAI_API_TOKEN" https://<domain>/v1/health
```

云端[backup-runtime.sh](../deploy/backup-runtime.sh)是现成的外部备份工具：停服、整runtime冷备，默认dry-run；要求所有数据库/工件处于该runtime且没有独立CLI写者。
恢复前记录原版本与配置，验证备份hash/格式，在维护窗口按原目录权限恢复并检查完整性、身份与datasetEpoch。仓库没有名为restore-runtime.sh的自动整runtime恢复脚本，不应臆造命令。
备份本身含健康数据/路线/Token相关配置，离线保存、严格权限、按容量策略保留；不上传到Git或外部分析服务。

### 外部一致性备份的责任边界

普通同步/导入/重算**不做**项目级整库备份、全库完整性扫描、整库候选复制或换库，也**不等待**外部备份完成；**升级脚本同样不再代做备份**，只打印责任提示且不校验运维是否已完成。备份由服务器运维独立负责。以下约束现在就成立：

- 活跃的WAL库**不能**只`cp rai.sqlite`当一致备份；也**不得**为“提速”删掉`-wal`/`-shm`侧车。正确做法是SQLite一致性备份API、与存储协调的快照，或暂停全部写者后完整备份相关文件。
- 要整个项目状态一致，主库、控制库、runtime、dataset-epoch 侧车、上传与工件、配置/身份必须落在**同一个恢复边界**内。多个库各自在线备份**不**自动等于跨库一致；跨库一致性靠 API 的 publication guard + detect/retry 在运行期保证，不靠备份事务。
- 备份凭证与数据由运维保护；健康原文、精确轨迹与Token不进入仓库。
- 恢复或替换数据集必须显式处理schema兼容与`datasetEpoch`。旧备份还原后**不得**让客户端继续复用新游标——那会把“接收状态已丢失”伪装成没丢。
- 项目自己创建的备份/rollback/安全快照**不**由应用删除或扫描清理；是否保留、归档、删除由运维决定。

## 排障硬规则（来自事故复盘，适用于所有导入/重算路径）

- **耗时必须是平铺且互斥的**：`totalMs` 必须 ≥ 各 `stagesMs` 之和（允许未计入的尾部），`computeStagesMs` 不得与 wall-clock 阶段重复计时。发布/排障时先核对 `stagesMs` 的键集合与加和；任何「看起来变快」都要先排除阶段被漏计或重复计。对公开性能对象增加字段时，`PUBLIC_PERFORMANCE_KEYS` 的编译期穷尽守卫必须同步；**静默的 `!includes(...)` 守卫**（例如配置项改名后 `some(...)` 恒真/恒假）会让判据变成真空通过——检查守卫本身要有正例断言，不能只靠「没红」。
- **不要用「重新导入全部」修一条缺失的训练**：全量重导会导出全部历史并生成全历史 replay 队列，既不会更快也不会更准，还会把真实缺失原因（导入车道拒绝、任务失败、游标/cursor、路线状态、磁盘/权限）埋掉。正确顺序：先看 `/v1/import-jobs/latest`、`/v1/import-sources/recent` 与 job 的 `failureCode`/lane；核对 iOS 同步游标与批次；需要重建时只在**副本/停服窗口**用 CLI 离线车道，并按「离线发布演练」验证。
- **先区分「没观测」与「没练」**：缺失记录不是 0，也不是删除；不要为了补一条数据修改旧 run/历史工件，也不要删库重来。
