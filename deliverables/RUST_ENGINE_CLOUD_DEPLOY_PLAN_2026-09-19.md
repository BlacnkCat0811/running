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

---

## 六、待拍板

1. **这批未提交改动怎么提交**（我按主题分组提交 / 你先审查 / 你自己提交）？
2. **Rust 二进制走哪条路**（本机 musl 先试 / 直接云机就地编译 / 暂不做）？
3. **是否与重构同批启用 Rust**（我建议：不同批 —— 先部署重构，观察一轮真实导入后再上 Rust）？
