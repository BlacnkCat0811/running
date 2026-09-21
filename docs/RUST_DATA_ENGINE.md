# Rust 数据执行器：部署、验证与边界

## 实际交付范围

这是 **Node API/调度 + Rust 数据执行器 + TypeScript 身份/评分契约** 的混合实现，
不是把所有后端代码改写成 Rust。没有改写设备端评分，也没有改动 iOS/Web 的导航或窄屏布局。

| 部分 | 执行位置 |
|---|---|
| HTTP、鉴权、持久化队列、幂等、数据库发布/回退 | 现有 Node 后端 |
| Health XML 事件解码、GPX 解码与标准坐标数值/时间读取 | Rust `quick-xml` |
| Record 身份、JS 数值/日期兼容、metadata、来源分类 | 复用 TypeScript 契约 |
| 大批 Record 去重/更新判断、generation/change ledger、记录写入 | Rust `rusqlite`，只写 CLI 私有候选库 |
| Workout、事件、路由关联、删除保护、睡眠/HRV 规范化 | 现有 TypeScript |
| 单路由训练的爬升聚合 | Rust；多路由排序存在歧义时保留 TS 路径 |
| 特征、训练负荷、跑力时间线与模型门禁 | TypeScript；额外 shadow reference 不使用原生聚合缓存 |
| 预测模型训练 | 原有 Python/CatBoost |

保留 TS 的 `JSON.stringify`、`stableId`、时间规范化是**刻意的兼容边界**：
不在 Rust 里猜测 JS 的对象键顺序、数字序列化和日期行为，不生成另一套训练 ID。

目前没有迁移完整评分内核、心率/配速全部聚合函数或 API。它们属于后续有性能证据才推进的部分，
不能因已经增加 Rust 就宣称“全后端原生化”。

## 数据链路

1. 既有服务完成上传、ZIP 安全检查、解压和来源持久化。
2. Rust 流式解码到私有 SQLite 中转文件；不是逐条把记录发成 JSON IPC。
3. TS 顺序读取中转数据，通过原契约生成 canonical Record 和稳定 ID。
4. CLI 的私有候选库获得随机一次性写许可，Rust 用缓存语句执行 Record 热循环。
5. Rust 每 4096 个非 tombstone Record 提交一个候选库批次，限制 WAL 增长。
6. 现有 TS 完成其他规范化和重算，验证候选库，再由父进程发布。

Rust 的写入入口同时检查：

- 目标必须是 `.importing.<UUID>` 候选库，不能是活动库文件名；
- 库内一次性许可必须匹配；许可不来自上传文件，也不来自公共 API；
- 父进程只传入其实际打开的候选库路径，比较真实路径，兼容 macOS `/var`→`/private/var` 别名；
- 输入与输出通过本地私有文件交接，输出文件必须是新文件；
- 失败候选库整体废弃，不能把一部分 Rust 批次与另一部分 TS 重试拼起来。

Node 不把 API Token、主库路径等环境变量传给 Rust。唯一例外是显式传入经许可的候选库路径。
中转文件与候选库放在同一运行数据盘，不把大文件默认写入系统 tmpfs。
队列每次执行使用独立 attempt 路径，旧孤儿进程不能覆盖新尝试的暂存库。
正常完成/失败/取消会清理本次原生中转；超过一天且不属于待执行任务的旧中转由维护清理回收。

## 构建

依赖版本由 `Cargo.lock` 固定，工具链由 `rust-toolchain.toml` 固定。
在目标系统的构建用户下安装 Rust 和 C 编译工具，然后：

```bash
npm ci
npm run rust:build
npm run rust:verify
npm run typecheck
npm test
npm run build
```

- `rust:build` 用 `--release --locked` 生成 `target/release/rai-data-worker`。
- `rust:verify` 构建二进制、运行 Rust 单测、强制运行 Node/Rust 对照与真实导入测试；缺少二进制不是跳过。
- 普通 `npm test` 在没有原生二进制时允许跳过 Rust 专用测试，纯 TS 开发不强制安装 Rust。
- 仓库里的 `.github/workflows/ci.yml` 是 **GitHub Actions** 配置，而远端只有 gitee，
  这套 CI **实际从不运行**。原生构建与测试必须在目标机上人工执行，
  不能把"CI 跑过原生任务"当作证据（此前文档与部署方案都据此写过结论，是错的）。
- 云服务器必须使用匹配架构与本机 libc 的构建产物，不能复制本机 macOS 二进制。
  最省事的做法是**直接在云服务器上就地编译**（见下节），ABI 天然匹配；
  没有启用 `target-cpu=native`。
- 内存紧张时可用 `CARGO_BUILD_JOBS=1 npm run rust:build`，不要与生产导入同时编译。
- 编译期间**必须停掉 API**：生产机 unit 的 `MemoryMax` 只约束 cgroup 内的服务进程，
  管不到从 shell 起的 `cargo`/`rustc`，不停服会让内存预算的算法彻底失效。

这轮本机工具链安装在被 Git 忽略的 `var/rustup`、`var/cargo`，没有修改用户全局 PATH。
构建脚本能使用该本地工具链；普通部署也可使用 PATH 中的 Cargo。

### 云服务器就地构建实录（2026-09-19，已实测）

生产机 2 vCPU / 1935 MiB RAM / 1987 MiB swap。工具链与源码都放在仓库之外，
避免被下次部署覆盖或 `git clean` 清掉：

```bash
# 1. 导出与线上 HEAD 一致的源码，不触碰 /opt/rai 的工作区
mkdir -p /opt/rai-native/src
git -C /opt/rai archive origin/main | tar -x -C /opt/rai-native/src

# 2. 装工具链。官方源在国内基本拉不动，必须走镜像
export RUSTUP_HOME=/opt/rai-native/rustup CARGO_HOME=/opt/rai-native/cargo
RUSTUP_DIST_SERVER=https://rsproxy.cn RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup \
  sh -c "$(curl -sSf https://rsproxy.cn/rustup-init.sh)" -y --no-modify-path

# 3. crates.io 直连同样不可用，给 CARGO_HOME 配 sparse 镜像
cat > /opt/rai-native/cargo/config.toml <<'EOF'
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[net]
git-fetch-with-cli = true
EOF

# 4. 构建（步骤 2/3 缺一不可，否则卡在下载阶段）
cd /opt/rai-native/src && CARGO_BUILD_JOBS=1 cargo build --release --locked --workspace
install -m 0755 target/release/rai-data-worker /opt/rai-native/rai-data-worker
```

实测结果：

| 项 | 实测值 |
|---|---|
| 构建耗时 | 1m19s（工具链安装约 3 分钟，产物 869 MiB 含工具链） |
| 退出码 | `CARGO_EXIT=0` |
| 产物 | 2,618,904 B，ELF x86-64 PIE，stripped |
| 链接 | glibc 动态：只依赖 `libgcc_s` / `libm` / `libc`，**无 `libsqlite3`**（`rusqlite` 的 `bundled` 已静态进二进制） |
| 内存 | **未 OOM**，峰值占用远低于 700 MiB，swap 未被使用 |

**预期的 OOM 没有出现**：`rusqlite bundled` + `lto="thin"` + `codegen-units=1` 这套
高危组合在 2 GiB 机器上编译 50 余个 crate 并未触顶，因此**不需要**降级到
`CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16` 的压峰值配置，
该配置仅作为内存更紧张时的备用方案保留。

验证顺序（缺一步都不算通过）：

```bash
/opt/rai-native/rai-data-worker --version
# {"protocol":1,"engine":"rust","version":"0.1.0"}
#   必须分别等于 TS 侧的 NATIVE_PROTOCOL=1 与 NATIVE_VERSION="0.1.0"

/opt/rai-native/rai-data-worker --operation health --input smoke.xml --output /tmp/spool.sqlite
# {"rows":2,"inputBytes":470,"sha256":"ec23...","protocol":1,"engine":"rust",
#  "version":"0.1.0","operation":"health","durationMs":0.63,"peakRssKiB":4352}
```

`--version` 只证明动态链接器能用，不能证明 `rusqlite` 那条链是活的。
必须再跑一次**真实 operation**：用 470 字节合成 Apple Health XML 实测得到 `rows:2`、`EXIT=0`，
再用 `node:sqlite` 只读打开产出的 spool 确认 `xml_units=2`。
这一步同时消掉"链接到了错误的 libc/SQLite"这一类只在运行期才暴露的故障。

## 启用与回退

默认仍然是：

```text
RAI_IMPORT_ENGINE=typescript
RAI_RUST_FALLBACK=none
```

在生产启用 Rust 数据引擎时，在 `/etc/rai/rai.env` 设置下面 3 行 —— **必须同批写入，缺一不可**：

```text
RAI_IMPORT_ENGINE=rust
RAI_RUST_FALLBACK=typescript
RAI_RUST_BINARY=/opt/rai-native/rai-data-worker
```

> **决策记录（2026-09-20，小唐）**：`RAI_IMPORT_VALIDATION_MODE` **已彻底移除**。
> 影子对照（跑第二遍完整重算再与候选比对）不再存在——`runShadowValidation` / `compareRunOutputs`
> 已从代码删除，**没有"临时开回"这个选项了**。
> 删掉的只是"额外跑一遍"；**模型激活的版本闸门不受影响，始终启用**（那是另一套机制，其错误文案
> 从 `Shadow model gate failed` 改为 `Model-version gate failed`，以免继续被混为一谈）。
> 替代防线见 `deliverables/SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md` §3。

🔴 **生产用 `RAI_RUST_FALLBACK=typescript`，不要照抄上面「默认」块里的 `none`。**
回退条件是有界的（`native-worker.ts:173`）：只在 `unavailable` 或 `unsupported_xml`
**两种原因**、且**在应用任何解码行之前**（要求 `operation !== "apply-records"`）才回退到参考解析器，
所以不会产生半 Rust 半 TS 的混合数据；真坏数据（`invalid_xml`）与资源超限仍然报错，不被掩盖。

反过来 `none` 的后果比"排队等人工"更硬：`unsupported_xml` **不在**
`import-worker.ts:573` 的 `waitForEngine` 名单里（该名单只有 `unavailable` / `invalid_protocol`）
⇒ 任务直接 **`failed`**，而不是进 `waiting_engine`。而"非常规非 ASCII 标签名 /
带实体定义的 DTD / 非标准 GPX 日期"正是下文明确预告**会发生**的输入
⇒ 用 `none` 等于把"导入中断"的概率留给真实数据。`none` 的正当用途只有一个：
双引擎基准，避免把 fallback 的 TS 性能误算成 Rust。

🔴 **`RAI_RUST_BINARY` 在云机上不是可选项。** `nativeBinary()` 的默认值是相对仓库根的
`target/release/rai-data-worker`；仓库跑在 `/opt/rai` 时它解析成
`/opt/rai/target/release/rai-data-worker`，而该目录在云机上**不存在**
（产物刻意放在仓库外，避免被下次部署覆盖）。此时若只设 `RAI_IMPORT_ENGINE=rust`，
`server.ts:107` 会在模块顶层抛错——**API 直接起不来**，既不是回退到 TS，也不是 exit 78。

重启 API 后生效。先做完整备份，不需要重建主库 schema。

🔴 **启用后怎么证明"引擎真的生效了"？"API 起来了"是不够的。**
`server.ts:107` 的启动期强校验**只在 `fallback === "none"` 时**才检查二进制是否存在 ——
用 `fallback=typescript` 时它完全不校验，API 能启动只说明 env 取值合法（rust 或 typescript 之一），
**无法区分是哪一种**；启动日志也不打印引擎。唯一可靠的判据是读运行中进程的实际环境：

```bash
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value rai-api)/environ | grep -E '^RAI_(IMPORT|RUST)'
```

必须看到 `RAI_IMPORT_ENGINE=rust` 与 `RAI_RUST_BINARY=/opt/rai-native/rai-data-worker`。
另建议以**服务身份**实跑一次二进制：`sudo -u rai /opt/rai-native/rai-data-worker --version` ——
root 能跑不代表 `rai` 能跑，这能消掉"目录不可进入 / 属主不可执行"这类只在服务身份下暴露的权限故障。

新任务保存执行器名称、版本和回退策略。修改默认引擎只影响新任务：

- 已接受的 Rust 任务不会因为重启时默认值变成 TS 而被偷偷改成 TS。
- 旧版本没有执行器标记的任务继续用 TS。
- Rust 版本/协议不匹配或执行器不可用，已接受任务进入 `waiting_engine`，保留来源；
  安装匹配版本后重启，或取消该任务后以新策略重新提交。
- 升级二进制前先清空队列，或者保留原版本；不能原地换成不兼容二进制并期待旧任务自动改用它。

`RAI_RUST_FALLBACK=typescript` 可允许**应用任何解码行之前**，对执行器不可用、
不支持的 XML/时间形式使用参考解析器；指标明确记录 TS fallback。
资源超限、取消、协议损坏、已经应用行后的失败不允许自动 fallback。
批量写入阶段也不做原地 fallback，失败必须放弃整个候选库。
为了避免把 fallback 的 TS 性能误算成 Rust，双引擎基准始终使用 `fallback=none`。

原生快速路径支持标准 UTF-8 Apple Health/GPX；非常规非 ASCII 标签名、
带实体定义的 DTD、非标准 GPX 日期等可能需要显式参考路径。
普通 Apple Health 的无实体 DTD 支持。非法 GPX 仍使用既有 `INVALID_GPX` 策略，
但执行器崩溃或资源不足不能被伪装成“坏路线”而静默丢数据。

## 运行时写路径不变量（B1–B5）

影子对照删除后，写路径的自动防线由五项不变量承担（设计依据见
`deliverables/SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md` §3）。四项在
`packages/health-export-parser/src/native-record-writer.ts`，全部只读派生、不改契约：

| # | 断言 | 违反时 |
|---|---|---|
| **B1** | Rust 回传 `canonicalDigest` = `sha256("{序号}|{id}|{content_hash}\n")` 逐行折叠；TS 侧 `capture()` 同一公式累计。序号 1-based 两侧都无空洞（**不用 `sequence`**，Rust 的 SELECT 不取它） | 抛错，导入失败 |
| **B2** | `import_entity_generations`（`entity_kind='record'`，本 generation）行数 **不得多于** `observed − tombstoned`；且 `inserted`/`tombstoned` 不得大于 `observed`。刻意用不等式：同一 id 重复出现时合法地产生更少行（`apple-health-parser.ts`） | 写 `import_issues` 的 `invariant.b2.*`，**不阻断** |
| **B3** | **仅增量批次**：原地重跑一次 `apply-records`（重跑前重新签发 permit）：`observed` 与摘要必须与首遍一致、`import_entity_changes` 增量为 0、`inserted` 必须为 0。`--replace` **不跑**（理由见下） | 抛错，导入失败 |
| **B4** | 从 canonical 中转**取尾部** 64 行、按 id 去重后逐列比对候选库实际落盘的行（13 列含 `metadata_json` / `raw_attributes_json`），并校验 generation 台账行存在 | 抛错，导入失败 |
| **B5** | `importEquivalence`：① 排序键改按**主键**（原字母序列名对 `health_records` 首排 `created_at`，**同值行的顺序未定义** ⇒ 数据相同的两侧也可能 hash 不同；主键打头使顺序成为全序）——**这是正确性修复，不是提速**；② 域清单补 `import_entity_changes` / `route_file_fingerprints` | 离线工具，不参与导入 |

🔴 **B3 只在增量批次运行（2026-09-21 更正）**：`--replace` 下 B3 **没有信号可给**，而重放会**重写全部行**：
① `tombstoned` 是读取侧计数，两遍必然相同；② `inserted` 计的是 worker **写**了多少行，而 `--replace` 下
worker 对每行都重写（`if !incremental || !exists || updated`）⇒ 第二遍合法地等于全行数；
③ 无 batch id 时 Rust 侧 `if let Some(batch)` **根本不写 change 台账** ⇒ 增量为 `0 === 0`。
⇒ 剩下的 `observed` 与摘要都是**输入侧**性质，B1 已经证过。原注释称台账增量是 "mode-independent assertion"，
**该说法不成立**。实测（探针）：`--replace` 只有一遍 `apply`，增量批次为 `first` + `replay` 两遍。

⚠️ **B5 的耗时变化曾被误记为一次提速（2026-09-21 更正）**：早期注释与方案文档写的是
"实测 21.7 s → 3.0 s（约 6×）"。**该数字不成立** —— 受控探针（本机 324 MB 库、预热缓存、3 轮中位数、
隔离排序键单一变量）得 OLD（字母序列名）**5,790 ms** → NEW（主键优先）**6,919 ms**，即**慢约 19%**。
"21.7 s" 来自**冷缓存首跑**（实测 21,708 ms），"3.0 s" 冷热条件下都不出现 ⇒ 是跨条件拼接的结果。
分表：`route_points`(204k 行) **−20%（唯一改善）**；`import_entity_changes` **+82%**；
`import_entity_generations` **+101%**。**根因**：`ORDER BY` 以主键（有索引的列）打头，SQLite 于是选择该索引，
但索引的次级序与完整 `ORDER BY` 不匹配 ⇒ 执行计划变成「索引扫描 + 回表 + 排序」，比「全表扫描 + 排序」更贵。
叠加域清单 20 → 22（多两张 ~83k 行表，约 +1.9 s）后，**工具整体比改动前更慢，不是更快**。
⇒ 判据：**删除或校验"性能声称"必须与功能改动分开测，且必须同条件对照**（同一缓存状态、同一域清单）。

🔴 **两条"看着可以简化、实则会把正常导入判死"的约束**，改 B3/B4 前必须读：

- **B3 不得断言 `tombstoned === 0`。** `tombstoned` 是**读取侧**计数：被墓碑的行两遍都会被跳过，值必然相同。
  断言为 0 会在"载荷重新引入一条曾被删除的记录"这个**合法输入**上失败。只有 `inserted`（真正写入的行数）才承载幂等语义。
- **B4 必须取尾部并按 id 去重，且不得改用头部采样。** 记录 id 由
  `[type, sourceName, startAt, endAt, value, unit]` 派生，**刻意不含 `device`**
  （`apple-health-parser.ts:191`：Apple 会把同一采样分别"带 device / 不带 device"导出两次）⇒ 同一 id 在一个中转里
  可以出现多次，而 upsert 保留**最后一次**。取头部（或保留重复行）会拿被覆盖的旧行去比对，报出
  `<id>.device` 假分歧并**让导入失败**。窗口取尾部时，晚于窗口起点的出现必然仍在窗口内，故 `DESC` 顺序下
  某 id 首次出现即其**全局最后一次写入**。回归用例：
  `packages/health-export-parser/test/native-worker.test.ts` 的
  "a record id carried twice keeps the last occurrence…"。

B1 对**旧二进制**是**容忍**的（缺 `canonicalDigest` 不报错，只写一条 `invariant.b1.digest_unavailable` 警告）：
把部署顺序错误变成导入中断是更坏的选择。**摘要存在但格式非法**（非 64 位小写 hex）仍按协议违规处理。

## 资源与协议

- 单计算任务的全局调度保持不变；Rust 未默认开启并行线程池。
- 原生令牌上限 1 MiB、实体上限 8 MiB、XML 嵌套上限 256。
- 解码中转和 canonical 中转各有 8 GiB 上限；它们不包含主库、备份和候选库空间。
  大导入必须预留额外 SSD 空间，不能仅按 ZIP 或主库大小估算。
- 原生进程超时 30 分钟，父进程支持终止；控制输出限制为 64 KiB，不传原始健康样本。
- 原生进度目前是阶段级；没有为每个 Record 发送进度事件。
- 原生 RSS 指标是单个 Rust 子进程峰值，**不能当作整个服务峰值**。Linux 服务组峰值看 cgroup/systemd。
- 中转库是可丢弃的私有文件，因此使用 OFF 日志/同步；业务库没有改成 synchronous=OFF。

## 双引擎验收

```bash
# 默认预演，不处理数据
npm run data:benchmark -- \
  --database /path/to/baseline.sqlite \
  --input /path/to/export-directory \
  --output /path/to/new-report.json \
  --engine typescript,rust \
  --runs 3 \
  --work-dir /path/to/local-ssd

# 确认基线/输入固定、磁盘空间充足后加 --execute
```

每个试验都从同一次只读备份恢复，固定 evaluatedAt，交替引擎顺序。
比较稳定原始表、ID、规范化表、输入 manifest 与 active 结果投影；
任务 UUID、运维时间戳等非业务字段不参与比较。
只要有任务失败或数据投影不一致，命令返回非零。
`parity.checked=false` 或 `parity.complete=false` 都不能称为对照通过。

本地额外对照包含：

- 中文/emoji、BOM、metadata 重复键/整数键、`__proto__` 属性；
- Record 更新、generation/change ledger、显式删除和 tombstone 保留；
- GPX 时间精度、负零、无效点、路线关联；
- 一次性写许可、活动库拒写、输出不覆盖；
- 协议不匹配、资源限制、取消及队列跨重启保留；
- 增量 Rust 导入触发独立 TS shadow 重放。

## 已测到的结果及其限制

本机合成负载：10,000 条心率 Record、1 次训练、同一个空基线，两个引擎各 4 次，
固定计算时间；不是用户健康数据，也不是 N100 测试。
概要见 `docs/benchmarks/rust-synthetic-10000.json`。

先仅替换解码时，Rust 中转路径更慢；下沉 Record SQL 热循环后：

| 中位数 | TypeScript | Rust 路径 |
|---|---:|---:|
| 整个导入任务 | 4882.5 ms | 3301.5 ms |
| parseImport 阶段 | 3594.7 ms | 2010.0 ms |

此样本端到端耗时下降约 32%，parseImport 耗时下降约 44%，数据投影一致。
收益来自 **Rust 实现、缓存语句和批处理共同作用**，不是“语言本身必然快 32%”；
在 TS 中实施相同 SQL 优化也可能缩小差距。

该负载实际触发 full 重算，配置的 shadow/off 分组没有触发额外增量 shadow；
不能拿它证明增量对照开销。真正的增量 shadow 已由单独的真实链路测试覆盖。
磁盘缓存未清空，样本和次数有限，不能承诺真实大数据、上传链路或 N100 的同等收益。

**Rust 已于 2026-09-19 在线上启用，并已在真实健康数据上跑通。**

首次真实导入（手机同步的完整导出，增量模式）的运行时证据：

| Rust 操作 | `rustCalls` | `typescriptFallbacks` | `wallMs` | `peakRssKiB` |
|---|---:|---:|---:|---:|
| `health`（XML 事件解码） | 1 | **0** | 252.5 | 21,820 |
| `apply-records`（Record 热循环写候选库） | 1 | **0** | 338.8 | 31,120 |
| `aggregate`（单路由爬升聚合） | 1 | **0** | 15.8 | 15,544 |

任务 `succeeded`、`error: null`；数据投影 `issues: []`；`workouts` 275 不变、
`health_records` 113876 → 113877；`0 新增 + 3 更新 + 269 未变 = 272 = trainingSessions` 自洽。
Rust 子进程峰值 RSS 只有 15–31 MiB（流式解码 + 只写候选库的设计生效），完成后无残留进程。

🔴 **这次走的是运行时影子对照，不是离线 `data:benchmark`。**
`validationMode: "shadow"`、`computeStagesMs.shadowValidation = 18,318 ms`（非 0 ⇒ 确实执行了），
而**任务没有失败** ⇒ `recompute-pipeline.ts:273` 的抛错分支未触发
⇒ Rust 结果与 TS 参考路径一致。证据强度**不低于**离线对照：用的是真实数据、走的是生产路径、
且参考路径刻意不使用原生聚合缓存（所以 Rust 聚合算错会被抓到）。
但两者**互补而非替代** —— 离线 benchmark 能给出双引擎**性能对比**，运行时 shadow 不产出这个。
⇒ `parity.checked` / `parity.complete` 仍是**未通过**状态（云机没有独立 `--input` 输入目录）；
要性能数字仍需把真实导出放到云机（或在本地对同一份备份）跑 `npm run data:benchmark`。

⚠️ **容量观察**：本次导入期间整个 unit 的 cgroup 峰值 **1.0G**，已贴到 `MemoryHigh=1100M` 软限
（`MemoryMax=1400M` 未触及、无 OOM、服务全程未重启）。增量导入下余量约 300M
⇒ **将来做多月份的一次性全量导入前，应先重新评估这个内存预算**。

⚠️ **开 shadow 的代价有数字了**：`shadowValidation` 占 18.3s / 总 67.1s ≈ **27%**。
真实导入的阶段分布：`parseImport` 26.5s、`recompute` 31.4s（内含 shadow 18.3s）、
`activation` 4.3s、`backup` 1.9s、`stagingCopy` 1.8s。重算进程峰值 RSS 约 300 MiB。

🔴 **2026-09-20 决策：影子对照已从代码中彻底删除**（比 09-19 14:16 的 `off` 配置更彻底）。
该变量、`runShadowValidation`、`compareRunOutputs` 均已不存在 ⇒ **"临时开回 shadow"已不可执行**。
**这个交换的代价必须说清**：上表那次"Rust 与 TS 投影一致"的验证是**历史证据**，今后不会再自动产生。
删除后剩下的保护只有：候选库机制（Rust 仍只写私有候选库）、协议级校验、以及 `fallback=typescript`。

⚠️ **协议级校验有一个必须知道的空洞：它不覆盖 `apply-records`。**
`crates/rai-data-worker/src/main.rs` 对该 operation 返回 `rows: 0`；而 `native-worker.ts:161-163`
比对的是 spool 里的 `route_aggregates`——`apply-records` 写的是 `--staging-database` 指定的候选库，
**从不写那张表** ⇒ 比较退化成 `0 === 0`，**恒真**。
即：**真正改数据的那个 operation，今天没有任何内容级或行数级的断言。**
（行数 / sha256 / metadata 自洽只覆盖 `health`、`gpx` 两条只读解码路径。）

⇒ 因此 `GET /v1/data-summary` 的 `issues: []` 与 `counts` 变化，是当前**主要防线**，值得每次导入后扫一眼。
⇒ 写路径的自动化不变量（输入流摘要 / 输出守恒 / 幂等重放 / 抽样重派生）见
`deliverables/SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md` §3，按该文 §5 的批次上线。

## 本地交付检查

- `npm run typecheck`：通过。
- `npm run rust:verify`：Release 构建、2 项 Rust 单测、9 项专用集成/对照测试通过。
- `npm test`：686 项后端/共享包测试通过，3 项按既有条件跳过；84 项 Web 测试通过。
- `npm run build`：通过。
- 该轮检查在本机执行，未连接云服务器或 N100，未修改真实健康数据库，未自动启用 Rust。
- 2026-09-19 云机侧的部署与启用**不在本机执行**，且经用户明确授权：`pull` 到 `6aca9e0`、
  安装新的 `deploy/rai-api.service`、写入 4 个 `RAI_*` 变量并重启。
  证据是云机上 `/proc/<MainPID>/environ` 与启动日志的路由计数，不是本机结论的推断。
- Linux/macOS 原生 CI 任务已配置，但远端 CI 尚未在本次本地执行中运行。
- 桌面浏览器 E2E 仍受本机缺少 Chrome/Edge 阻塞；不能宣称浏览器端到端验收通过。
- 云服务器侧的构建与验证结果另见「云服务器就地构建实录」与
  `deliverables/RUST_ENGINE_CLOUD_DEPLOY_PLAN_2026-09-19.md`。
