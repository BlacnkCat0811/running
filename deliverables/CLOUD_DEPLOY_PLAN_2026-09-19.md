# 云服务器部署方案（取代 N100 迁移）

日期：2026-09-19 ｜ 状态：**待确认，未执行任何改动**
决策依据：小唐 09:48 指示「不要部署到 n100 上，把方案改成还是部署到当前云服务器上」。

---

## 0. 结论

决策落地后，原 N100 方案里的**迁移部分全部作废**，本次任务降级为**一次常规发布**——
但因为原方案把「发布新代码」和「搬家」两件事捆在了一起，作废搬家这一步**并不会自动降低发布风险**。

本批改动含后端大重构（`apps/api/src/worker.ts` 从 2062 行砍到 5 行），
风险集中在**导入链路**，不在部署动作本身。

**部署动作极简**（已逐条核实，见 §2）：

```text
提交推送 → 云端 pull → 只读迁移闸门 → restart rai-api → 验证
```

**不 build、不 npm ci、不停服迁移。**

---

## 1. 作废清单（原方案里不再需要的部分）

| 原方案项 | 现在 |
|---|---|
| 云端新增第二个 frps 实例（7001）+ 专用证书 | ❌ 不需要——API 仍在 8787，nginx 上游不变 |
| nginx 插入式改造（`/`、`/v1/` → 18787） | ❌ 不需要 |
| 飞牛 VM 内第二个 frpc 实例 | ❌ 不需要 |
| 停写 → 冷备份整 runtime → 跨机搬迁 → 解包 chown | ❌ 不需要（常规备份即可） |
| 云端 `stop`/`disable` rai-api 与 rai-backup.timer | ❌ 不需要 |
| PVE `cpulimit`、软路由 CPU 争抢、存储盘 SSD 红线 | ❌ 与本机无关 |
| `deploy/n100/` 模板（含 `deploy-n100.test.ts` 门禁） | 保留在仓库，**本次不安装**；将来要迁可复用 |

原 N100 方案（`N100_MIGRATION_PLAN_2026-09-19.md`）已就地标注作废，保留作背景。

---

## 2. 本次部署定级（已核实，非推测）

| 判据 | 实测结果 | 决定 |
|---|---|---|
| `package-lock.json` | **未变** | 跳过 `npm ci` |
| `packages/storage-sqlite/src/database.ts` | **未变** | 🔴 **无 schema 迁移** ⇒ 不需要停服迁移 |
| `apps/web` 源码 | **未变**（只改了 1 行 `e2e/web-flows.test.ts`） | **不需要 `npm run build`** |
| `apps/api/**`、`packages/**` | 大量变更 | tsx 直跑 TS ⇒ **只需 `systemctl restart rai-api`** |
| 线上当前 HEAD | `fda35e8` | 本次目标 = 把未提交改动推上去 |

⇒ 动作收敛为：**提交推送 + pull + 闸门 + restart + 验证**。

---

## 3. 新端点与路由分类（逐条核实）

新增端点：

| 端点 | 方法 | 归属清单 |
|---|---|---|
| `/v1/commands` | POST | `metadataOnlyMutationRoutes` |
| `/v1/commands/:id` | GET | `tokenRequiredReadRoutes` |
| `/v1/commands/:id/cancel` | POST | `metadataOnlyMutationRoutes` |
| `/v1/import-jobs/:id/cancel` | POST | `metadataOnlyMutationRoutes` |
| `/v1/performance` | GET | `tokenRequiredReadRoutes` |

核实结果：

- ✅ `POST /v1/imports/uploads` **路径未变**（拆分到 `apps/api/src/routes/import-routes.ts:38`）
  ⇒ nginx 里 `location = /v1/imports/uploads` 的 4g 上传放宽仍然匹配，**不需要改 nginx**。
- ✅ 四张清单已全部登记，新读端点**没有**被塞进匿名白名单（安全姿态正确）：
  `metadataOnlyMutationRoutes` 11、`databaseRequiredMutationRoutes` 10、
  `publicReadRoutes` 26、`tokenRequiredReadRoutes` **12**。

🔴 **启动日志判据变了**：`tokenRequiredReadRoutes` 从线上实测的 **10** 变成 **12**。
新的判据行是 26/12 —— 若仍按 2026-09-18 记录的 `publicReadRoutes:26, tokenRequiredReadRoutes:10`
去核对，会误判成「部署没生效」。

---

## 4. 唯一的真风险区：导入链路

| 变更 | 风险 |
|---|---|
| `worker.ts` 2062 行 → 5 行（仅兼容重导出），拆成 import / recompute / prediction 三个 worker | 🔴 导入主链路重构，出问题会直接卡住手机同步 |
| 新增 **Worker 线程**做增量依赖分析（`import-analysis-thread.ts` + `import-analysis-bootstrap.mjs`） | 🟡 写法正确（显式 `register()` tsx 后再 import `.ts`），但**只在 macOS 上测过**，Linux 首次运行要实测 |
| 上传/队列语义变化：同 `sourceId` 复用任务、新来源返回 **202**、新增 cancel 端点、发布意图 + 重启恢复 | 🟡 行为契约变了，旧 iOS 客户端的忙碌等待被保留作兼容 |
| 增量重算（从最早受影响时间起）+ 速度窗口共享时间线 | 🟡 计算正确性靠 shadow 对照兜底（默认开） |

⇒ **验收必须打真实小批导入**。「`/v1/health` 返回 200」不构成任何证据。

---

## 5. 执行顺序（确认后按此走）

```text
0  本地闸门（必须亲跑，作者自述不算）：
     npm run typecheck && npm test            期望：全绿
1  部署前备份：POST /v1/backups            期望：200 + rai.manual.<ISO>.sqlite
2  本地提交改动 + 推送（gitee）
3  云端：cd /opt/rai && sudo -u rai git pull --ff-only origin main
     再跑只读迁移闸门（默认 dry-run、只读）：
     sudo -u rai npm run data:migrate -- --database /var/lib/rai/var/rai.sqlite
     期望输出含 "pending": []
4  systemctl restart rai-api
     日志必须出现：Anonymous read enabled … publicReadRoutes:26, tokenRequiredReadRoutes:12
5  按 §6 逐项验证
6  异常则按 §8 回滚
```

🔴 绝不在 API 运行时跑迁移 `--apply`（CLI 与 API 共用 publication lock）。

---

## 6. 验证清单

| 探测 | 期望 |
|---|---|
| 匿名 `GET /v1/health` | 200 + `status:"ok"` + `databaseReady:true` |
| 匿名 `GET /v1/performance` | **401**（新增端点归入需令牌读，匿名读不到） |
| 带令牌 `GET /v1/performance` | 200（累计请求时间、事件循环延迟、RSS/CPU） |
| `GET /v1/import-jobs/latest` | 200，且新任务带 `performance.stagesMs` 字段 |
| 真实小批同步（手机发一包） | 202/accepted → 增量分析线程起来 → 发布成功、无重启循环 |
| 重复提交同一 `sourceId` | 返回**原任务**而非新建（复用语义） |
| `GET /wb2api/healthz` | 200 + `healthy≥1`（确认没连带影响网关） |
| `/` 与 `/settings` | 200 |
| `journalctl -u rai-api` | `NRestarts=0`，无迁移报错 |

---

## 7. 本次明确不做

1. 🔴 **不在云机上构建 Rust**（本轮）。保持代码默认 `RAI_IMPORT_ENGINE=typescript`、
   `RAI_RUST_FALLBACK=none`，不需要 `RAI_RUST_BINARY`；`crates/` 与 `rust-toolchain.toml`
   留在仓库对运行无影响。

   ### 构建位置核实（2026-09-19，五条候选路径只有一条通）

   | 路径 | 结论 |
   |---|---|
   | **云机原地构建** | ✅ **唯一环境完全一致的路径**（云机 = Ubuntu 24.04.4 / glibc 2.39） |
   | 本机 macOS 构建 | ❌ 产物是 Mach-O，Linux 用不了；且本机工具链在 git 忽略的 `var/rustup`、`var/cargo` |
   | 本机 Docker 构建 | ❌ 本机**无 Docker CLI / daemon**（已实测） |
   | GitHub CI 构建 | 🟡 `ubuntu-latest` 现在同为 24.04（glibc 一致 ✅），但 `ci.yml` 只有 `npm run rust:verify`、**没有 `upload-artifact`** ⇒ 拿不到产物 |
   | 本机交叉编译 | 🟡 需自装交叉链接器，glibc 版本仍需匹配，复杂度不值 |

   ### 若将来要在云上构建：2C2G 的风险已定位到两处根因

   - `crates/rai-data-worker/Cargo.toml` 的 `rusqlite = { features = ["bundled"] }`
     ⇒ 要连**整个 SQLite3 的 C 源码**一起编译（最重的一项）；
   - 根 `Cargo.toml` 的 `[profile.release]` 是 **`lto = "thin"` + `codegen-units = 1`**
     ⇒ codegen 单线程不可并行，LTO 把整个 crate graph 的 IR 压进内存 ⇒ 峰值内存被显著放大。

   ⇒ 不加约束直接跑 `npm run rust:build`（脚本内是 `cargo build --release --locked --workspace`，
   默认并行度 = CPU 核数 = 2）**OOM 概率很高**，且会连带威胁同机的 nginx / wb2api（swap 已被用过）。

   压低峰值（环境变量覆盖，**不改仓库文件**）：

   ```bash
   CARGO_BUILD_JOBS=1 \
   CARGO_PROFILE_RELEASE_LTO=false \
   CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
   npm run rust:build
   ```

   前置：`rustup` + `1.98.1`（`profile minimal`）+ C 工具链（bundled SQLite3 需要 gcc/make）；
   窗口：**确认没有导入任务在跑**；预计 15–30 分钟；磁盘约 1–2 GB（云机余 33 G，够）。

   🔴 **云上只跑 `rust:build`，不要跑 `rust:verify`** —— 后者会跑 `cargo test --release`
   加两个需要**真实导入**的 Node 测试，在 2C2G 上代价过高。

   🟡 **本轮建议不开**：文档给出的 32% 提速来自 **macOS + 合成数据**，不是云机 + 真实数据；
   而原定的验证场景（N100）已随迁移否决而消失。先用 TS 版部署，把 Rust 留作
   「将来要省云机 CPU 时再评估」的选项。

   **若确定要启用，两条路优先选 CI，别在 2 G 上冒险编译**：
   把 `.github/workflows/ci.yml` 的 `runs-on` 从 `ubuntu-latest` **固定为 `ubuntu-24.04`**
   （否则将来滚到 26.04 时 glibc 升高，产物在云机上跑不起来），并补一步 `actions/upload-artifact`
   ——这样构建完全不占云机内存，且可重复、有 CI 缓存。
   当前 `ci.yml` 只有 `npm run rust:verify`，**没有 `upload-artifact`**，所以现在是拿不到产物的。
   云机原地构建只作为「不想动 CI 配置」时的兜底，且必须按上面的环境变量压峰值。

   ### 编译频率：一次，不是每次部署

   🔴 **不需要每次部署都编译。** 产物落在 `.gitignore` 覆盖的 `/target/` 下，
   `git pull` 不会碰它，所以**一次编译长期有效**。只有下列情况才要重编译：

   | 触发条件 | 要重编译吗 |
   |---|---|
   | `apps/api/**`、`packages/**`（日常改动） | ❌ 不用 |
   | `crates/**` 源码改动 | ✅ 要 |
   | `Cargo.toml` / `Cargo.lock` 依赖变化 | ✅ 要 |
   | `rust-toolchain.toml` 的 channel 变化 | ✅ 要（还需先装新工具链） |
   | 云机 OS 大版本升级（24.04 → 26.04） | ✅ 要（二进制动态链接 glibc） |
   | 换机器 | ✅ 要（不能跨发行版复制产物） |

   ⚠️ **产物是个脆弱点**：它在仓库目录内、被 gitignore、**没有任何备份** ⇒ `/opt/rai`
   一旦重建（或误跑 `git clean -fdx`）产物就没了，而报错只在**下次真实导入**时才暴露。
   ⇒ 启用时建议把二进制**复制到仓库外**（如 `/opt/rai-native/rai-data-worker`），
   让 `RAI_RUST_BINARY` 指过去，与源码树解耦，也让「重编译」不再与「重新部署」绑定。
2. **不改 `/etc/rai/rai.env`**：新增的 `RAI_IMPORT_VALIDATION_MODE` / `RAI_IMPORT_ENGINE` /
   `RAI_RUST_FALLBACK` 代码侧都有默认值（`shadow` / `typescript` / `none`），不设即等于当前安全姿态。
   （该文件含密钥，改动需单独授权。）
3. 不跑桌面 E2E（本机无 Chrome/Edge）。
4. **iOS 改动对手机零效果**：`apps/ios/**` 的 `HealthKitSync.swift` / 新增
   `HealthSyncCancellation.swift` 需小唐在 Xcode 重新 build 并安装到手机才生效。
5. 不删 `deploy/n100/`。

---

## 8. 回滚

| 层 | 动作 |
|---|---|
| 代码 | `git reset --hard fda35e8` + `systemctl restart rai-api`（当前线上 HEAD） |
| 数据 | 本次**无 schema 迁移**，主库结构不变；导入流程异常 ⇒ 停写 + 用第 1 步备份恢复 |
| 边界 | 不混跑两个版本的 API；回滚后 `tokenRequiredReadRoutes` 数字回到 10 |

---

## 9. 待确认

1. **是否授权把 `POST /v1/commands`（`kind=recompute`）打进真库** —— 它会触发一次**全量重算**且排队不去重。
   我的建议：**不打**，改用「真实小批同步」来验收导入链路，避免无谓的全量重算。
2. `RAI_IMPORT_VALIDATION_MODE` 是否要显式写进 `/etc/rai/rai.env`（默认已是 `shadow`）。
3. 何时执行（部署本身不需要停服务窗口；但第 5 步的真实小批同步验收需要手机侧配合）。
