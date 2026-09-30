# Rust 数据引擎 → 云服务器部署方案（2026-09-19 实测核查）

## 结论先行

| # | 结论 | 依据 |
|---|---|---|
| 1 | 🔴 **现在没有任何东西可部署。** 本地 HEAD == 线上 HEAD == `06d22d5`，全部 Rust 引擎与后端重构改动（31 文件改 / 54 文件新）**未提交、未推送** | 见 §一 |
| 2 | 🔴 **建议拆两批：先部署重构（`RAI_IMPORT_ENGINE` 保持 `typescript`），Rust 二进制单独一批。** 理由：这批改动主体是后端 worker 拆分（`apps/api/src/worker.ts` 净删 2062 行），本身就是高风险变更；同时开 Rust 会让出问题时**无法归因** | §一 改动分布 |
| 3 | 🟡 **二进制获取推荐「本机 musl 静态交叉编译」，兜底「云机就地编译（必须停 API）」。** CI 通路**不可用** | §三 |
| 4 | 🔴 **云机就地编译绝不能在 API 运行时进行** —— 服务被 cgroup 限在 `MemoryMax=1400M`，而 `rusqlite bundled` + `lto=thin` + `codegen-units=1` 是 OOM 高危组合，OOM killer 可能顺带杀掉 API | §二 C |
| 5 | 🔴 **启用顺序有硬约束：先放二进制、验二进制能跑，再改 env。** 顺序反了 API 直接起不来 | §二 B |

---

## 一、现状实测

### 线上（`lhins-3gatdqed` / ap-guangzhou）

| 项 | 实测值 | 命令 |
|---|---|---|
| HEAD | `06d22d5`（= 本地 HEAD，无落后） | `git -C /opt/rai rev-parse --short HEAD` |
| 工作树 | 干净（仅 `?? .npm/`、`?? .npmrc` 缓存噪声） | `git -C /opt/rai status --porcelain` |
| Rust 产物 | **不存在**（`/opt/rai/target` 无此目录） | `ls -d /opt/rai/target` |
| CPU / 内存 | **2 核**；1935 MB total，available 1345 MB；swap 1.9 G（已用 216 M） | `nproc` / `free -m` |
| 磁盘 | 50 G，已用 15 G，**剩 33 G**（32%） | `df -h /` |
| OS / 架构 | Ubuntu 24.04.4 LTS / `x86_64` | `sed -n 1,3p /etc/os-release` |
| Rust 工具链 | **无** `cargo` / `rustc`；但有 `cc` / `gcc`（编 rusqlite bundled 够用） | `command -v` |
| API 资源上限 | `MemoryHigh=1100M` / `MemoryMax=1400M` / `MemorySwapMax=512M` / `CPUQuota=150%` / `OOMPolicy=stop` | `deploy/rai-api.service`（被 `apps/api/test/deploy-cloud.test.ts:11-13` 钉住） |

### 本机（`/Users/ta/running`）

| 项 | 实测值 |
|---|---|
| HEAD / 远端 | `06d22d5`，`git log origin/main..HEAD` **为空**（无未推送提交） |
| 未提交改动 | **31 文件修改 + 54 文件新增** |
| 改动分布（前六） | `apps/api/src` 22 · `apps/api/test` 17 · `packages/health-export-parser/src` 6 · `deploy` 5 · `packages/application/{src,test}` 6 · `docs` 3 |
| 核心净变化 | `apps/api/src/worker.ts` **净删 2062 行**（拆成 `import-worker.ts`/`recompute-worker.ts`/`prediction-worker.ts`/`worker-process.ts`/`command-queue.ts`/`task-admission.ts` + `routes/`）；13 个核心文件合计 `+530 / −2309` |
| 本机 Rust 产物 | `target/release/rai-data-worker`（2.3 MB，**macOS 二进制，不可搬运**） |
| Docker | **未安装** |
| brew | 有（`/usr/local/bin/brew`）⇒ musl 交叉工具链可装 |
| 远端 | **只有 gitee**：`https://gitee.com/tpandmr/running.git` |
| CI | `.github/workflows/ci.yml:12-29` 是 **GitHub Actions** 语法，远端是 gitee ⇒ **这套 CI 不会运行** |

### Rust 引擎自身配置

| 项 | 值 | 位置 |
|---|---|---|
| 依赖规模 | 7 个直接依赖 / 55 个包（Cargo.lock 474 行）：`quick-xml 0.42`、`rusqlite 0.40`（**`bundled`** ⇒ 要编 sqlite3.c）、serde、serde_json、sha2、chrono、libc | `crates/rai-data-worker/Cargo.toml` |
| 工具链 | `channel = "1.98.1"`、`profile = "minimal"` | `rust-toolchain.toml` |
| release 配置 | `lto="thin"`、`codegen-units=1`、`strip=true` | `Cargo.toml` |
| 默认引擎 | `typescript`（**不开就不需要二进制**） | `packages/health-export-parser/src/native-worker.ts:47` |
| 二进制查找 | `RAI_RUST_BINARY` ?? `../../../target/release/rai-data-worker`（相对源码 ⇒ `/opt/rai/target/release/`） | `native-worker.ts:55-59` |
| 版本探测参数 | 支持 `--version` | `crates/rai-data-worker/src/main.rs:632` |

---

## 二、三个断路点

### 🔴 A. 代码还没提交 —— 一切部署的前置条件

线上 HEAD 与本地一致，意味着**这批改动一行都没上去**。按仓库既有纪律（未提交改动不代提交），必须先决定提交分组。建议按主题拆 5 组：

1. 后端 worker 拆分与队列（`apps/api/src/{worker-process,command-queue,task-admission,import-worker,recompute-worker,prediction-worker,runtime-telemetry,request-mutation-lifetime,routes/}` + 对应 test）
2. Rust 数据引擎（`Cargo.toml` / `Cargo.lock` / `rust-toolchain.toml` / `crates/` / `packages/health-export-parser/src/{native-worker,native-record-writer}` / `scripts/rust-worker.mjs` / `.gitignore` / `ci.yml` / `docs/RUST_DATA_ENGINE.md`）
3. 增量计算（`packages/application/src/services/{bounded-cache,recompute-progress}`、`pooled` 相关 test、`apps/api/src/health-change-plan.ts`）
4. iOS（`apps/ios/RAI/{HealthKitSync,HealthSyncCancellation}.swift` + 回归测试）
5. 部署与文档（`deploy/**`、`deliverables/**`、`docs/BACKEND_REFACTOR_IMPLEMENTATION.md` 等）

⚠️ 第 2 组与第 1、3 组有交叉文件（`server.ts`、`worker.ts`、`apple-health-parser.ts`、`gpx-parser.ts`、`cli.ts` 同时改了两件事）⇒ 分组提交时**不要用 `git add -p` 硬拆同一文件**，按「能独立通过 typecheck+test 的最小单元」切。

### 🔴 B. 启动期强校验 —— 顺序反了服务起不来

`apps/api/src/server.ts:109-111`：

```ts
const importExecutionEngine = { name: importEngine(), fallback: nativeFallback(), version: NATIVE_VERSION };
if (importExecutionEngine.name === "rust" && importExecutionEngine.fallback === "none" && !existsSync(nativeBinary())) {
  throw new Error("Rust worker is missing. Run npm run rust:build or configure RAI_RUST_BINARY before enabling Rust.");
}
```

⇒ **`RAI_IMPORT_ENGINE=rust` + `RAI_RUST_FALLBACK=none` + 二进制不在 `RAI_RUST_BINARY` 指向处 ⇒ 模块加载即抛错，API 起不来。**
⇒ 这不是 exit 78（迁移那条路径），是普通启动失败 ⇒ 靠 unit 里的 `StartLimitIntervalSec/Burst` 兜进 `failed`，不会无限重启。
⇒ **硬约束：改 env 之前，二进制必须已在位并被证明可执行。**

### 🔴 C. 生产机编译 = 与 API 抢资源

- 云机总内存 1935 MB，API 常驻约 590 MB，cgroup 上限 1400 MB（`OOMPolicy=stop`）。
- 编译是**在 shell 里跑**（不受 `rai-api.service` 的 cgroup 约束），会与 API 自由争抢 ⇒ 编译进程涨到 1 GB+ 时两者都可能被 OOM killer 选中。
- 压峰值手段（`CARGO_BUILD_JOBS=1 CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`）**会覆盖 `Cargo.toml` 的 `lto="thin"` / `codegen-units=1`** ⇒ 产物偏离仓库声明的发布配置。
- ⇒ **推荐先停 API 再编译**（1.3 G 可用 + 1.9 G swap = 3.2 G 预算，可尝试保守的默认 release 配置；真 OOM 再降级压峰值）。

---

## 三、二进制获取：三条路线对比

| 路线 | 停机 | 生产机风险 | 保真度 | 成本 | 判断 |
|---|---|---|---|---|---|
| **A. 本机 musl 静态交叉编译** | 无 | 零 | 中（musl 与 glibc 行为差异；本程序只用 SQLite/文件 IO/JSON，风险低） | 装 `x86_64-linux-musl-gcc`（brew）+ `rustup target add` | 🟡 **推荐先试**，成本最低，失败无损失；**未实测** |
| **B. 云机就地编译** | **需停 API 10–30 min** | 中（编译期内存争抢；已停服则风险可控） | 高（同机同 libc） | 装 rustup（+~300 MB 磁盘） | 🟡 **兜底，确定可行** |
| **C. CI 产物** | 无 | 零 | 高 | 需 GitHub 远端 | 🔴 **不可用** —— 远端只有 gitee，`.github/workflows/` 不会触发；且现有 rust 任务**只 verify、不上传 artifact**（`ci.yml:12-29`） |

⚠️ 不用 Docker：本机**未装 Docker**，为一次构建装 Docker Desktop 不划算。

---

## 四、执行步骤

### 第 0 步：提交并推送（前置，需小唐确认）

```bash
cd /Users/ta/running && git status --short && git log --oneline origin/main..HEAD
# 按 §二 A 的 5 组提交 → push 到 gitee
```

### 第 1 步：常规部署（不带 Rust，本次主体）

```bash
# 一行判定要做什么（skill rai-deploy §0）
git diff --name-only 06d22d5..<新HEAD> | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn
```

⚠️ 本次**几乎必然**命中「改依赖 + 改 web + 改 schema 校验」中的多条：

| 判据 | 命令 | 期望 |
|---|---|---|
| 依赖是否变 | `git diff --stat 06d22d5..HEAD -- package.json package-lock.json` | 非空 ⇒ 要 `npm ci` |
| web 是否变 | `git diff --stat 06d22d5..HEAD -- apps/web` | 非空 ⇒ 要 `npm run build`（nginx 直读 dist） |
| schema 是否变 | `git diff 06d22d5..HEAD -- packages/storage-sqlite/src/database.ts` | 有新 `version: N` ⇒ **restart 前必过 dry-run 迁移闸门** |

```bash
# 1) 备份（有 schema 变更则强制）
node -e "const t=require('fs').readFileSync('/etc/rai/rai.env','utf8').match(/RAI_API_TOKEN=(.*)/)[1].trim();fetch('http://127.0.0.1:8787/v1/backups',{method:'POST',headers:{Authorization:'Bearer '+t}}).then(async r=>console.log('BACKUP',r.status,await r.text()))"

# 2) 迁移闸门（只读预演，期望 "pending": []）
cd /opt/rai && sudo -u rai npm run data:migrate -- --database /var/lib/rai/var/rai.sqlite

# 3) pull
cd /opt/rai && sudo -u rai git pull --ff-only origin main; git rev-parse --short HEAD

# 4) 依赖变了才 npm ci（后台跑，避免 TAT 超时）
(setsid sh -c 'cd /opt/rai && sudo -u rai env ONNXRUNTIME_NODE_INSTALL=skip npm ci > /tmp/rai-npmci.log 2>&1; echo NPMCI_EXIT=$? >> /tmp/rai-npmci.log' &)

# 5) web 变了才 build
(setsid sh -c 'cd /opt/rai && sudo -u rai npm run build > /tmp/rai-build.log 2>&1; echo BUILD_EXIT=$? >> /tmp/rai-build.log' &)

# 6) restart + 验证
systemctl restart rai-api; sleep 8; systemctl is-active rai-api
journalctl -u rai-api --since "2 minutes ago" --no-pager | tail -30
```

⚠️ **本批 `deploy/rai-api.service` 也被改了**（未提交清单里有）⇒ restart 前复核已安装 unit 与仓库是否逐行一致（`rai-deploy` skill §3 的 `INSTALLED_EQ_REPO` 判据），不一致先同步 + `daemon-reload`。

### 第 2 步：拿二进制（路线 A，推荐先试）

```bash
# 本机
brew install filosottile/musl-cross/musl-cross      # 提供 x86_64-linux-musl-gcc
rustup target add x86_64-unknown-linux-musl
export CC_x86_64_unknown_linux_musl=x86_64-linux-musl-gcc
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-linux-musl-gcc
export AR_x86_64_unknown_linux_musl=x86_64-linux-musl-ar
npm run rust:build -- --target x86_64-unknown-linux-musl   # 注意：脚本目前不接受 target 参数，需手动执行 cargo
file target/x86_64-unknown-linux-musl/release/rai-data-worker   # 期望 statically linked
```

⚠️ `scripts/rust-worker.mjs` 现在固定跑 `cargo build --release --locked --workspace`，**不接受 `--target`** ⇒ 这一步需要手动跑 cargo 或给脚本加 target 透传（属仓库改动）。

失败则转路线 B：

```bash
# 云机
mkdir -p /opt/rai-native
export RUSTUP_HOME=/opt/rai-native/rustup CARGO_HOME=/opt/rai-native/cargo
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.98.1 --no-modify-path

pgrep -af health-export-parser          # 确认无导入在跑
systemctl stop rai-api                  # 腾内存，编译期停机
(setsid sh -c 'cd /opt/rai && sudo -u rai env RUSTUP_HOME=/opt/rai-native/rustup CARGO_HOME=/opt/rai-native/cargo PATH=/opt/rai-native/cargo/bin:$PATH cargo build --release --locked --workspace > /tmp/rai-rust.log 2>&1; echo RUST_EXIT=$? >> /tmp/rai-rust.log' &)
# 轮询 tail -20 /tmp/rai-rust.log 直到 RUST_EXIT=（OOM 时日志里是 SIGKILL / signal 9）
install -m 0755 /opt/rai/target/release/rai-data-worker /opt/rai-native/rai-data-worker
systemctl start rai-api
```

### 第 3 步：落产物到**仓库外**并验证可执行

🔴 **不要用文档建议的 `/opt/rai/target/release/...`**（`docs/RUST_DATA_ENGINE.md:88` 与 `deploy/rai.env.example:16` 都这么写）——`/opt/rai` 是 git checkout，`target/` 在 `.gitignore` 内、**无任何备份**，`/opt/rai` 一旦重建或误跑 `git clean -fdx` 产物静默消失，而 systemd 要到**下次导入**才暴露。

```bash
install -m 0755 <产物> /opt/rai-native/rai-data-worker
/opt/rai-native/rai-data-worker --version     # 🔴 期望打印版本号
# 失败特征：No such file or directory（动态链接器缺失）/ GLIBC_2.xx not found ⇒ musl/glibc 路线选错，回退路线 B
```

### 第 4 步：改 env 启用（需小唐明确同意）

```bash
cp -a /etc/rai/rai.env /root/rai.env.bak.2026-09-19
node -e "require('fs').appendFileSync('/etc/rai/rai.env','\nRAI_IMPORT_ENGINE=rust\nRAI_IMPORT_VALIDATION_MODE=shadow\nRAI_RUST_FALLBACK=none\nRAI_RUST_BINARY=/opt/rai-native/rai-data-worker\n');console.log('APPENDED')"
systemctl restart rai-api
```

⚠️ `deploy/rai.env.example:22` 被 `apps/api/test/deploy-cloud.test.ts:25` **整行精确匹配**钉住（`RAI_IMPORT_ENGINE=typescript`）⇒ **只改线上 `/etc/rai/rai.env` 不影响测试**；若想改仓库 example 必须同步改测试。

### 第 5 步：验收（缺一不可）

| # | 判据 | 命令 |
|---|---|---|
| 1 | 引擎真实生效 | 启动日志出现 `importExecutionEngine`/引擎标记；**不是** `Rust worker is missing` |
| 2 | 服务健康 | `/v1/health` 为 `status:"ok"` + `databaseReady:true`（HTTP 200 不够） |
| 3 | 双引擎对照通过 | `npm run data:benchmark -- --database <只读副本> --input <导出目录> --output /tmp/report.json --engine typescript,rust --runs 3 --work-dir /tmp --execute`；**`parity.checked=true` 且 `parity.complete=true`** |
| 4 | 一次真实导入端到端 | 通过 Web/API 上传一份真实 ZIP，看任务是否落到 rust 引擎且数据投影一致 |
| 5 | 版本/协议匹配 | 任务不进入 `waiting_engine` |

⚠️ 第 3 步在 2C2G 上**很慢**（每个试验要从备份恢复一次，共 6 次），建议放低峰期后台跑。
⚠️ 文档明确：性能结论来自**本机 6 核 + 合成 1 万条 Record**（端到端 −32%、parseImport −44%），**不能外推到云机 2 核**。要在云机下结论，第 3 步的输出才是证据。

### 回滚

```bash
# 启用层面的回滚（最快，1 行）
node -e "const f='/etc/rai/rai.env';const s=require('fs').readFileSync(f,'utf8').replace(/^RAI_IMPORT_ENGINE=rust$/m,'RAI_IMPORT_ENGINE=typescript');require('fs').writeFileSync(f,s)" && systemctl restart rai-api
# 代码层回滚：git reset --hard <旧HEAD> + systemctl restart rai-api
# 数据层回滚：只能靠第 1 步的备份（需小唐确认）
```

⚠️ 已接受的 Rust 任务**不会因回滚默认值而改回 TS**（文档 §启用与回退）⇒ 回滚后先把队列清空或用 `RAI_RUST_FALLBACK=typescript` 过渡。
⚠️ 升级/替换二进制前**必须先清空队列**，不能原地换不兼容版本。

---

## 五、文档与实现不一致的地方（建议修）

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| 1 | 🔴 建议的二进制路径在**仓库内且无备份** | `docs/RUST_DATA_ENGINE.md:88`、`deploy/rai.env.example:16` | 改为 `/opt/rai-native/rai-data-worker`，并在文档里写明"产物与源码树解耦" |
| 2 | 🔴 **部署文档零 Rust 内容** | `deploy/README-UBUNTU.md`、`deploy/README-CLOUD-2C2G.md` 全无 `rust` 字样 | 把本文 §三/§四 的精简版并入云端部署文档，否则下次部署会缺依据 |
| 3 | 🟡 **CI 通路实际不存在** | `ci.yml:12-29` 是 GitHub Actions，远端只有 gitee | 要么给 gitee 配 CI（Gitee Go 语法不同，需重写），要么在 `docs/RUST_DATA_ENGINE.md:64/183` 删掉"CI 增加原生任务"的表述，避免误以为 Linux 产物可从 CI 取 |
| 4 | 🟡 `rust:build` 不支持 `--target` | `scripts/rust-worker.mjs:21` | 若要走 musl 路线，需给脚本加 target 透传 |
| 5 | 🟡 压峰值 env 会覆盖 `Cargo.toml` 发布配置 | `docs/RUST_DATA_ENGINE.md:67`、skill `rai-deploy` | 明确"压峰值产物 ≠ 仓库声明配置"，并在部署记录里写明用了哪个档 |

**本轮已修**（未提交，待小唐审查）：

- #1 已修：`docs/RUST_DATA_ENGINE.md` 的启用示例改为 `/opt/rai-native/rai-data-worker`；
  `deploy/rai.env.example:16` 的注释补上"必须与 `RAI_IMPORT_ENGINE=rust` 同批写入"的警告与失败后果。
  注：本轮实测证明云机上 OOM 未发生，走的是仓库声明的正式发布档，**未使用压峰值档**（#5 的隐患未触发）。
- #3 已修：`docs/RUST_DATA_ENGINE.md` 构建小节明确写出"`ci.yml` 是 GitHub Actions、远端只有 gitee ⇒ 这套 CI 从不运行"，
  并把"不能引用 CI 结果当证据"写进判据。
- #2 已修一半：云端构建与验证的完整步骤已写进 `docs/RUST_DATA_ENGINE.md` 的
  「云服务器就地构建实录」；`deploy/README-*.md` 仍未并入，留待下次改动时一并处理。

---

## 六、拍板结论（已定，2026-09-19）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 未提交改动怎么提交 | ✅ 小唐已审查并授权代提交：按 5 组主题切分为 6 个 commit，已推 gitee（`06d22d5..6aca9e0`） |
| 2 | Rust 二进制走哪条路 | ⏩ 先试路线 A（本机 musl），**本机 `brew install zig` 被沙箱拦截后改判为路线 B（云机就地编译）** |
| 3 | 是否与重构同批启用 Rust | ✅ **不同批**。本次只把二进制就位，`RAI_IMPORT_ENGINE` 不动 |

---

## 七、执行实录（2026-09-19 晚，路线 B 已完成）

### 7.1 已完成动作

| 步骤 | 动作 | 证据 |
|---|---|---|
| 前置 | 源码 `git archive origin/main` 导出到 `/opt/rai-native/src` | 不触碰 `/opt/rai` 工作区，其 HEAD 仍为 `06d22d5` |
| 前置 | `POST /v1/backups` 备份主库 | `rai.manual.2026-09-19T03-38-25-833Z.013e352e.sqlite`，530,530,304 B |
| 前置 | `systemctl stop rai-api` | 编译期间必须停服，unit 的 `MemoryMax` 管不到 shell 里的 cargo |
| 工具链 | rustup 经 `rsproxy.cn` 镜像安装 | cargo/rustc **1.98.1**，装在 `/opt/rai-native/{rustup,cargo}` |
| 依赖 | `CARGO_HOME/config.toml` 配 rsproxy sparse registry | 直连 crates.io 时 `Downloaded` 停在 **41** 个包后零进展 |
| 构建 | `CARGO_BUILD_JOBS=1 cargo build --release --locked --workspace` | **1m19s，`CARGO_EXIT=0`** |
| 产物 | `install -m 0755 … /opt/rai-native/rai-data-worker` | 2,618,904 B，ELF x86-64 PIE，stripped |
| 验证 | `--version` + 真实 `health` operation + spool 只读回读 | 见 7.2 |
| 恢复 | `systemctl start rai-api` + 健康检查 | `status=ok`、`databaseReady=true` |

### 7.2 验证证据（两条链，缺一不算过）

```text
$ /opt/rai-native/rai-data-worker --version
{"protocol":1,"engine":"rust","version":"0.1.0"}
   ↑ 与 TS 侧 native-worker.ts:9/10 的 NATIVE_PROTOCOL=1 / NATIVE_VERSION="0.1.0" 逐字段对齐

$ /opt/rai-native/rai-data-worker --operation health --input smoke.xml --output /tmp/smoke-spool.sqlite
{"rows":2,"inputBytes":470,"sha256":"ec234d32…","protocol":1,"engine":"rust",
 "version":"0.1.0","operation":"health","durationMs":0.632891,"peakRssKiB":4352}
EXIT=0

# node:sqlite 只读打开产物 spool，确认写链真的落地
units=2   agg=0
```

`ldd` 输出只有 `libgcc_s` / `libm` / `libc`，**没有 `libsqlite3`** ——
`rusqlite` 的 `bundled` 特性已把 SQLite 静态链进二进制。
就地编译让 libc ABI 与运行机完全一致，musl 路线要解决的 glibc 版本问题在此不存在。

### 7.3 🔴 两个原计划没料到的坑

| 坑 | 现象 | 处置 |
|---|---|---|
| **crates.io 全链不可用** | `Updating crates.io index` 能过，但 `Downloaded` 到 41 个包后完全停住（20 s 内 cache 目录 0 MB 增长） | 必须给 `CARGO_HOME` 配 rsproxy sparse registry；配后 25 s 内即进入 `Compiling` |
| **预期 OOM 没有发生** | 担心 `rusqlite bundled` + `lto="thin"` + `codegen-units=1` 打爆 2 GiB | 实测峰值远低于 700 MiB、swap 未用 ⇒ **不需要**压峰值配置，走的是仓库声明的正式发布档（`lto=thin`+`cgu=1`），这一点比原方案更有利 |

### 7.4 🔴 启用时最容易踩的坑（本次刻意未执行）

`nativeBinary()` 的默认值是相对**仓库根**的 `target/release/rai-data-worker`。
在云机上实测解析结果为：

```text
/opt/rai/target/release/rai-data-worker     ← 该目录不存在（ls: No such file or directory）
```

而产物刻意装在 `/opt/rai-native/rai-data-worker`（仓库外，避免被下次部署覆盖）。
⇒ **只设 `RAI_IMPORT_ENGINE=rust` + `RAI_RUST_FALLBACK=none` 而不设 `RAI_RUST_BINARY`，
`server.ts` 会在模块顶层抛错，API 直接起不来**；既不是回退到 TS，也不是 exit 78。

### 7.5 当前线上状态

| 项 | 值 |
|---|---|
| `/opt/rai` HEAD | `06d22d5`（**未更新**，本轮 6 个 commit 未部署） |
| `rai-api` | `active`，健康检查 `status=ok` / `databaseReady=true` |
| 导入引擎 | `RAI_IMPORT_ENGINE` 未设置 ⇒ 实际跑 **typescript** |
| 启动日志 | `publicReadRoutes:26, tokenRequiredReadRoutes:10` |
| Rust 二进制 | 已就位并验证：`/opt/rai-native/rai-data-worker`，**未启用** |
| 磁盘 | 50 G 用 16 G；`/opt/rai-native` 占 869 MiB（工具链 664 M + 构建缓存） |

⚠️ 上表 `publicReadRoutes:26 / tokenRequiredReadRoutes:10` 是**线上旧代码**的值。
仓库已推的 6 个 commit 里含路由分类调整，部署后这个判据会变——
下次部署请以新代码的启动日志实际输出为准，不要拿 26/10 当"部署没生效"的判据。

### 7.6 下一步（待小唐拍板）

1. **部署这 6 个 commit**（普通 `pull` + `restart`；`database.ts` 未改 ⇒ 无 schema 迁移）。
2. **双引擎对照**：`npm run data:benchmark --engine typescript,rust` 在真实数据副本上跑，`fallback=none`，
   要求 `parity.checked=true && parity.complete=true`。
3. 对照通过后再改 `/etc/rai/rai.env` 启用（三个变量同批写入）。

---

## 八、部署与启用实录（2026-09-19 13:00，已完成）

### 8.1 部署前判据（实测，非推断）

| 判据 | 实测 | 结论 |
|---|---|---|
| `package-lock.json` diff | 空 | 不需要 `npm ci` |
| `package.json` diff | 只新增 scripts（`rust:build` 等） | 无依赖变化 |
| `database.ts` diff | 空 | 无 schema 迁移 |
| `apps/web/src/**` diff | 空（只改了 `e2e/web-flows.test.ts`） | **不需要 build** |
| 迁移闸门 dry-run | `"pending": []`、`version: 22` | 可直接 restart |

### 8.2 🔴 部署前发现的重大问题：线上 unit 与仓库不一致

`deploy/rai-api.service` 的安装位置是 `/etc/systemd/system/`，**不在 `/opt/rai` 里**
⇒ `git pull` **永远不会更新它**，仓库改了 unit 也不会自动生效。

| 项 | 线上实际（本次动手前） | 仓库 |
|---|---|---|
| `ExecStart` | `/usr/bin/npm run start` | `/usr/bin/node --import tsx apps/api/src/server.ts` |
| `MemoryMax` / `MemoryHigh` / `MemorySwapMax` | **infinity** | 1400M / 1100M / 512M |
| `CPUQuotaPerSecUSec` | **infinity** | 150% |
| `KillMode` | `control-group`（默认） | `mixed` |
| `UMask` / `TasksMax` / `LimitNOFILE` | 0022 / 2224 / 65536（默认） | 0077 / 128 / 16384 |
| `TimeoutStopUSec` | `1min 30s`（**systemd 默认值**） | 120s |
| `ExecStartPre` | 无 | 两条 check |
| `OOMPolicy=stop` | `stop`（默认值，巧合相同） | `stop` |

⇒ 此前记录的"线上 unit 与仓库逐行一致""线上已有 1400M cgroup 预算"**均为误记**：
那些值来自**仓库文件**，被当成了线上实测。属「把文档当实测」的同一家族 ——
这次骗人的不是脚本也不是 workflow，是**配置文件**。

⇒ 处置：`cp -a` 备份到 `/root/rai-api.service.bak.20260919` → `install -m 0644` → `daemon-reload`，
并用 `systemctl show` 逐项确认生效值（`MemoryMax=1468006400`、`CPUQuotaPerSecUSec=1.5s`、
`KillMode=mixed`、`UMask=0077`、`TasksMax=128`、`LimitNOFILE=16384`）。

### 8.3 执行顺序（刻意分两次 restart 以分离归因）

1. `pull`：`06d22d5` → `6aca9e0`
2. 迁移闸门 dry-run → `"pending": []`
3. 安装新 unit + `daemon-reload`
4. **restart #1**（引擎仍是 typescript）⇒ 单独验证 unit 变更：`active`、`NRestarts=0`、
   启动日志路由计数 `publicReadRoutes:26, tokenRequiredReadRoutes:12`（新判据命中）
5. 备份 env → 追加 4 个变量 → **restart #2** ⇒ `active`、`NRestarts=0`

### 8.4 启用后的验证判据（"API 起来了"是不够的）

🔴 `server.ts:107` 的启动期强校验**只在 `fallback === "none"` 时**才检查二进制是否存在。
用 `fallback=typescript` 时它**完全不校验** ⇒ API 能启动只能说明 env 取值合法，
**无法区分引擎是 rust 还是 typescript**；启动日志也不打印引擎。
⇒ 唯一可靠判据是读运行中进程的实际环境：

```text
$ tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value rai-api)/environ | grep -E '^RAI_(IMPORT|RUST)'
RAI_IMPORT_ENGINE=rust
RAI_IMPORT_VALIDATION_MODE=shadow
RAI_RUST_FALLBACK=typescript
RAI_RUST_BINARY=/opt/rai-native/rai-data-worker
```

同时补了一条**此前漏掉的**验证：根能跑 ≠ 服务身份能跑
⇒ `sudo -u rai /opt/rai-native/rai-data-worker --version` → `RAI_EXEC=0`。

### 8.5 `RAI_RUST_FALLBACK` 取值：经用户拍板用 `typescript`

| Rust 失败原因 | `fallback=none` | `fallback=typescript` |
|---|---|---|
| `unavailable` | `waiting_engine` 排队 | 回退 TS 参考解析器 |
| `unsupported_xml` | 🔴 任务直接 **`failed`** | 回退 TS 参考解析器 |
| `invalid_xml` / `resource_limit` | `failed` | `failed`（**不回退**，正确） |

依据：`native-worker.ts:173` 的回退名单 = `unavailable` / `unsupported_xml`，
且要求 `operation !== "apply-records"`（**应用任何解码行之前**，故不会产生半 Rust 半 TS 数据）；
而 `import-worker.ts:573` 的 `waitForEngine` 名单 = `unavailable` / `invalid_protocol`。
两个名单**不重合** ⇒ `unsupported_xml` 在 `none` 下**不进排队而是直接失败**。
由于"非 ASCII 标签名 / 带实体定义的 DTD / 非标准 GPX 日期"是文档明确预告会发生的情况，
生产用 `none` 等于把"导入中断"的概率留给真实数据。
`deploy/rai.env.example` 与 `docs/RUST_DATA_ENGINE.md` 的默认值已相应修正为 `typescript`。

### 8.6 收尾状态

| 项 | 值 |
|---|---|
| 线上 HEAD | `6aca9e0` |
| `rai-api` | `active`、`NRestarts=0`、`ExecMainStatus=0` |
| 健康检查 | `status=ok`、`databaseReady=true` |
| cgroup（实测落到进程） | `Memory: 76.2M (high 1.0G / max 1.3G / swap max 512.0M)`，`Tasks: 19 (limit 128)` |
| 导入引擎 | **rust**，回退 `typescript`，验证 `shadow` |
| 回滚素材 | unit → `/root/rai-api.service.bak.20260919`；env → `/root/rai.env.bak.20260919`；库 → `rai.manual.2026-09-19T03-38-25…` |

### 8.7 ✅ 真实验证已完成（2026-09-19 14:09，由手机同步触发）

启用后 8 分钟，小唐从手机点了同步。任务 `web_import_mu7zmg4z_2b919db4-…` 结果：

**任务级判据（`GET /v1/import-jobs/latest`）**

```json
{ "status": "succeeded", "phase": "completed", "error": null,
  "executionEngine": { "name": "rust", "fallback": "typescript", "version": "0.1.0" },
  "native": {
    "health":        { "rustCalls": 1, "typescriptFallbacks": 0, "wallMs": 252.5, "peakRssKiB": 21820 },
    "apply-records": { "rustCalls": 1, "typescriptFallbacks": 0, "wallMs": 338.8, "peakRssKiB": 31120 },
    "aggregate":     { "rustCalls": 1, "typescriptFallbacks": 0, "wallMs":  15.8, "peakRssKiB": 15544 }
  },
  "summary": { "importMode": "incremental", "insertedWorkouts": 0, "updatedWorkouts": 3,
               "removedWorkouts": 0, "unchangedWorkouts": 269,
               "featuresReused": 268, "featuresRecomputed": 4, "durationMs": 67149 } }
```

⇒ **三个 Rust operation 全部真跑通，`typescriptFallbacks` 三次都是 0** ——
真实导出里没有触发任何回退，说明数据全是 Rust 支持的标准形式。

**影子对照的证据链**

| 判据 | 值 | 含义 |
|---|---|---|
| `validationMode` | `shadow` | 对照开关是开的 |
| `computeStagesMs.shadowValidation` | **18,318 ms** | 非 0 ⇒ 参考路径**真的跑了**，不是跳过 |
| 任务 status | `succeeded` | `recompute-pipeline.ts:273` 的抛错分支**未触发** ⇒ 两边结果一致 |

**数据完整性**

`issues: []`；`workouts` 275 不变；`health_records` 113876 → **113877**；
`0 新增 + 3 更新 + 269 未变 = 272 = trainingSessions` 自洽。Rust 子进程完成后**无残留**。

**阶段耗时（首次拿到真实分布）**

`parseImport` 26.5s · `recompute` 31.4s（内含 shadow 18.3s）· `activation` 4.3s ·
`backup` 1.9s · `stagingCopy` 1.8s · 合计 67.1s。重算进程峰值 RSS ≈ 300 MiB。

### 8.7b ⚠️ 仍未做的一件事（与上条互补，不是替代）

- **离线 `data:benchmark` 双引擎对照**：云机 `/var/lib/rai/var/imports` 为空，
  该工具缺 `--input` ⇒ `parity.checked` / `parity.complete` 仍是**未通过**。
  它与运行时 shadow **互补而非替代**：shadow 只判**一致性**（已过），
  benchmark 才产出**双引擎性能对比数字**（未得）。
- ⇒ 想要性能数字，仍需把真实导出放到云机（或在本地对同一份备份）跑一次。

### 8.7c ⚠️ 容量观察（新，值得记住）

本次导入期间整个 unit 的 cgroup 峰值 **`peak: 1.0G`**，已贴到 `MemoryHigh=1100M` 软限；
`MemoryMax=1400M` **未触及**、无 OOM、无重启、`Tasks 20/128`。
⇒ 增量导入下余量约 300M。**将来做多月份的一次性全量导入前，应重新评估这个预算**——
`parseImport` 解析的是完整导出，所以峰值主要由数据规模决定。

### 8.8 回滚（任一条都是一次 restart）

```bash
# 关引擎
sed -i 's/^RAI_IMPORT_ENGINE=rust/RAI_IMPORT_ENGINE=typescript/' /etc/rai/rai.env && systemctl restart rai-api
# 回滚 unit
install -m 0644 /root/rai-api.service.bak.20260919 /etc/systemd/system/rai-api.service
systemctl daemon-reload && systemctl restart rai-api
# 回滚 env
cp -a /root/rai.env.bak.20260919 /etc/rai/rai.env && systemctl restart rai-api
# 回滚代码
sudo -u rai git -C /opt/rai reset --hard 06d22d5 && systemctl restart rai-api
```

### 8.10 变更：关闭影子对照（14:16，用户决策）

指令原文：`不要开影子对照。直接用rust`。

| 项 | 前 | 后 |
|---|---|---|
| `RAI_IMPORT_VALIDATION_MODE` | `shadow` | **`off`** |
| `RAI_IMPORT_ENGINE` / `RAI_RUST_FALLBACK` / `RAI_RUST_BINARY` | rust / typescript / `/opt/rai-native/rai-data-worker` | **不变** |

执行与验证：

- 改前确认 `GET /v1/import-jobs/active` → `null`（确保重启不会打断任务）
- 备份到 `/root/rai.env.bak.before-shadowoff.20260919`
- `sed -i` 替换后核验 `off=1` / `shadow=0`（确认无残留旧行）
- `systemctl restart rai-api` ⇒ `active`、`NRestarts=0`、`ExecMainStatus=0`
- 🔴 `/proc/<MainPID>/environ` 确认 `RAI_IMPORT_VALIDATION_MODE=off`（不看配置文件的"应该"，看进程实际环境）
- 健康检查 `status=ok` / `databaseReady=true`

**这个交换的代价（必须记下来）：**

换回约 **27% 耗时**（18.3s / 67.1s）。失去的是 **「Rust 与 TS 投影一致」的自动校验**。
⇒ §8.7 那次验证成为**历史证据**，今后不再自动产生。关掉后剩下的保护只有三层：

1. 候选库机制（Rust 仍只写私有候选库，验证通过才发布）
2. `native-worker.ts:145-163` 的**协议级校验**（行数 / sha256 / metadata 自洽）
3. `fallback=typescript`（`unsupported_xml` / `unavailable` 回退）

⚠️ **协议级校验只能证明"Rust 报的行数 = 它写进候选库的行数"，不能证明语义正确**。
例如原生爬升聚合少算某一段，关掉 shadow 后**没有任何自动机制会报警**。
⇒ `GET /v1/data-summary` 的 `issues: []` 与 `counts` 变化，从"附加核对"升为**主要防线**，
每次导入后值得扫一眼。

📌 仓库模板 `deploy/rai.env.example` **保持 `RAI_IMPORT_VALIDATION_MODE=shadow`**：
它被 `apps/api/test/deploy-cloud.test.ts:21` 整行精确匹配钉住，且作为模板应保留更安全的默认。
⇒ 仓库模板（`shadow`）与线上覆盖值（`off`）**有意不一致**，这是设计允许的（只改线上不破测试）。

📌 **建议**：下次做多月份的一次性全量导入时，临时把 `shadow` 开回来跑一轮，
确认全量路径下投影仍一致，再关回去。
