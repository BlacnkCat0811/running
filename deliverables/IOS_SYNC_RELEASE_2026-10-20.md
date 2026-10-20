# iOS 同步 R1–R6 发布记录（2026-10-20）

- **发布提交**：`62f490b`（`62f490b3fd173423b3b5b4bf6b498ba769493163`）；本记录为紧随其后的文档提交。
- **上一生产版本**：`33f79fe`。
- **生产实例**：`lhins-3gatdqed` / `101.33.202.40` / ap-guangzhou；仓库 `/opt/rai`，服务 `rai-api`。
- **范围**：`33f79fe..62f490b`，含 `5333895`（P2 批次）、`67028e1`（10-19 记录）、`62f490b`（R1–R6 工作树落地 + 门禁补链）。
- **性质**：服务端为**读侧 + 启动校验**改动；**无 schema 迁移**（本地与生产 `schema_migrations` 均为 v46），`package-lock.json` 未变。
- 口径提醒：本记录只覆盖**本机判据 + 服务器侧实测**。iOS 未做签名构建/真机安装，不能读成端到端验收。

## 1. 提交内容

见 `62f490b` 提交说明与 [IOS_SYNC_REREVIEW_2026-10-19.md](IOS_SYNC_REREVIEW_2026-10-19.md) §7–11。要点：

- iOS：R1 统一待办（`HealthSyncWorkPlanner`）、R2 observer 原子意图（`HealthSyncIntentJournal`，本地 schema v5）、R3 窗口 anchored 分页（`WorkoutWindowPaging`，默认关闭）、R5 三态展示。
- 服务端/共享包：R4 读侧补账本新旧并集（v37 `previous_*`）与 v45 批次持久脏证据（路线-only 批次）；`nativeWorkerAvailability` 拒绝缺失/过期 Rust 产物；新增 `batch-analysis-dirty-evidence` 只读严格解析。
- 门禁：`check:ios-gates` 挂进 pre-commit/CI + 孤儿门禁直接判红；pr5 C9 基线入库；Python 3.9 下限统一。
- 测试夹具：`workout-visibility-freshness` 的“刚有新批次”夹具改为墙钟相对时刻（原写死 2026-10-18T13:10Z，24h 后按日历变红，产品代码未变）。

对 10-19 各记录中“未提交 / 未部署”状态的更新：本记录发布后，上述工作树已提交为 `62f490b` 并部署到生产；那些记录仍保留当时的时点结论。

## 2. 本机判据（macOS 26.5 / Node v22.23.2 / Python 3.9.6）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（tsconfig.pure + tsconfig） |
| `RAI_TEST_CONCURRENCY=2 npm test` | 见 §2.1；**产品断言无失败** |
| `npm run check:docs` | 通过（101 files / 670 links / 0 problems） |
| `npm run check:doc-refs` | 通过（143 refs / 0 越界；内容漂移无基线未核对，见 §3） |
| `npm run check:scripts` | 通过（18 package.json / 104 scripts） |
| `npm run check:acceptance-matrix` | 通过（80 cited / 0 declared-gap / 0 missing） |
| `npm run check:package-boundaries`（+`--self-test`） | 通过（16 包 / 31 src 边；自测 8 项） |
| `node scripts/check-blob-size.mjs` | 通过（1076 tracked files ≤ 1.5 MB） |
| `npm run check:ios-gates` | 通过（10 支跨平台判据；2 支按声明的外部条件跳过） |
| `npm run test:ios` | 通过（pre-commit 钩子实跑：98 文件类型检查 + 纯逻辑回归；见 §2.2） |
| `npm run smoke:api` | 通过 |
| `npm run review:model-boundaries` | 通过（violationCount = 0） |

### 2.1 全量 `npm test`（三次完整跑，`RAI_TEST_CONCURRENCY=2`）

| 轮次 | 结果 | 唯一失败 |
|---|---|---|
| 第 1 轮（修夹具前） | 2163 tests / 2149 pass / **1 fail** | `workout-visibility-freshness.test.ts` 的夹具时间炸弹（`not ok 1032`：`settling→stable`）；**已修为墙钟相对，单文件复跑 10/10 通过** |
| 第 2 轮（修夹具后） | 2163 / 2149 pass / **1 fail** | `connection-contention.test.ts` 计时用例（open() 只等 170 ms，未跨过持锁窗口）；**隔离复跑 3/3 通过**，该文件本批未改 |
| 第 3 轮（修夹具后） | 2163 / 2149 pass / **1 cancelled** | `recompute-worker.test.ts`：`cancelledByParent`（Promise 未决但事件循环已结束）；**隔离复跑 1 次复现、2 次通过**，该文件本批未改 |

三轮的失败都是**时间/调度敏感**的既有用例或已修的夹具问题，没有任何产品断言失败；每轮其余用例全绿。
这与 `docs/OPERATIONS.md` 对重文件 5 s / 30 s 墙钟预算在负载下会假红的既有说明一致。
**未为了变绿改动这些用例的预算或断言。**

skipped：13 条（Rust parity 用例，见 §3）。

### 2.2 `npm run test:ios`（pre-commit 钩子内实跑）

- `typecheck-ios.sh`：98 个文件真实类型检查通过（3 个仅依赖高德 SDK 的文件按既有口径跳过）。
- 纯逻辑回归全部通过，含新增 71 条 intent journal、122 条窗口分页、241 条 route state、106 条 store、
  266 条 Tech 展示，以及 10 支 `check-*.py`；钩子结论行：`iOS 门禁通过（类型检查 + 纯逻辑回归）`。
- 真机相关未执行，见 §3。

## 3. 跳过 / 未执行的检查（不得并入“通过”）

- **Rust**：本机无 `cargo`、无 `rai-data-worker` 产物 ⇒ 13 条 Rust parity 用例按产物状态 skip（打印原因）；
  `npm run rust:verify` 未执行。生产 `RAI_IMPORT_ENGINE=typescript`，新启动校验不触发。
- `apps/ios/tests/run-visual-tests.sh`（需 Simulator + `var/rai.sqlite`）、`check-export-determinism-live.py`、
  `check-background-mutations.py`（逐条改坏源码）未执行。
- `npm run ml:test`（research Python 环境）未执行：本批未修改 `research/`。
- `check:doc-refs` 的内容级漂移核对未做：按日常提交口径（无 `.linerefs.json` 基线；输出“未核对（无基线）”）。
- iOS 签名构建 / 真机安装 / HealthKit 端到端未执行（需要签名与设备）。

## 4. 部署与生产验证（2026-10-20 08:13 CST）

方式：`cd /opt/rai && sudo bash deploy/upgrade.sh --apply`（拉取 → lockfile 未变故跳过 `npm ci` → 重启 → 认证健康检查）。
**未使用 `--migrate`**：本地与生产 schema 均为 v46，本批无迁移文件。

- `HEAD=62f490b`；`git status`（已跟踪文件）干净；`schema_migrations` 最新 version = **46**。
- 脚本健康检查：`GET /v1/health` 带令牌 `status=ok` 且 `databaseReady=true`；无令牌 = **401**。
- 追加实测（本机 → `https://tpandmr.xyz` → nginx → API）：
  - `/v1/health` 无令牌 401、带令牌 200；`/v1/workouts` 无令牌 401、带令牌 200；
  - `/` = 404、`/assets/app.js` = 404（静态站点仍按 D17 退役）；
  - `/v1/workouts?limit=5` 200（total=286，返回含 `analysisPublishStatus` / `analysisAvailable`）；
  - `/v1/workouts/<recent>` 200（0.32 s）；`.../freshness` 200（`delivery=delivered`、`analysis=published`、`stability=settling`、8 条 series）；
  - `/v1/handshake` 200（`syncCoverageVersion=1`、`factsAnalysisContractVersion=1`）；
  - `/v1/sync/coverage?types=HKQuantityTypeIdentifierHeartRate` 200（112084 samples，knownUntil `2026-10-19T11:36:36Z`）。
- systemd：`Type=notify`、`WatchdogUSec=2min`、`NRestarts=0`；watchdog timeout / SIGABRT / 非零退出计数 = 0；
  重启后 journal 无 error/exception/5xx；`RAI local API ready` 与 `Server listening at http://127.0.0.1:8787` 均正常。
- 性能：`freshness` 首次请求（重启后）10.0 s，暖态稳定 1.4 s；同端点**在部署前的旧版本上**日志实测 10.48 s / 1.57 s
  ⇒ 属既有行为，**不是本批回归**；`/v1/workouts` 列表 25–29 ms、详情 0.32 s。

## 5. 回滚

本批**无数据/schema 变更**，回滚只需代码：

```bash
cd /opt/rai && sudo git checkout 33f79fe   # 上一生产版本
sudo systemctl restart rai-api
# 然后按 §4 的 health / 401 / journal 判据复核
```

`deploy/upgrade.sh` 只做 `--ff-only` 快进，不能用于回滚。

- iOS：窗口分页开关默认关闭，旧任务按原路径跑完；本次未安装新 App 构建。
- 备份责任（运维）：本批**未创建**新冷备（runtime 12 G、磁盘剩余 11 G，不足以在保留历史备份的前提下再冷备一份；
  删除旧备份属于运维决定）。服务器已有 `2026-10-14`（8.4 G）与 `2026-10-18`（9.1 G）两套 `/srv/rai-backups` 冷备。
  本批无迁移，因此这些备份只作为代码/数据整体回退的兜底。

## 6. CI 现实

远端是 gitee，**不会**触发 GitHub Actions（`.github/workflows/ci.yml` 仅在 GitHub 生效；`.workflow/master-ci.yml` 是未启用草案）。
本记录的判据全部来自**本机实跑 + 生产服务器实测**；本文件随 `main` 推送后，远端仍不会自动给出绿灯。

## 7. 仍未完成（下一轮）

- iOS 签名构建与真机安装、HealthKit 分页开关的真机门（T01/T02/T16/T20 等）未做。
- Rust 产物重建与 `rust:verify`（需 cargo 环境）。
- §2.1 的两条既有时间敏感用例（`connection-contention`、`recompute-worker`）值得单独收口为确定性判据，本批不改。
