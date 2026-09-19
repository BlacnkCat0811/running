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
- CI 增加 Linux/macOS 原生测试任务，仍需以远端 CI 实际结果为准。
- 云服务器应使用匹配架构的 Linux 构建产物，不能复制本机 macOS 二进制。建议在兼容 Linux 构建机上构建，
  避免不同发行版的 libc 版本不兼容；没有启用 `target-cpu=native`。
- 内存紧张时可用 `CARGO_BUILD_JOBS=1 npm run rust:build`，不要与生产导入同时编译。

这轮本机工具链安装在被 Git 忽略的 `var/rustup`、`var/cargo`，没有修改用户全局 PATH。
构建脚本能使用该本地工具链；普通部署也可使用 PATH 中的 Cargo。

## 启用与回退

默认仍然是：

```text
RAI_IMPORT_ENGINE=typescript
RAI_IMPORT_VALIDATION_MODE=shadow
RAI_RUST_FALLBACK=none
```

副本对照通过后，在 `/etc/rai/rai.env` 设置：

```text
RAI_IMPORT_ENGINE=rust
RAI_IMPORT_VALIDATION_MODE=shadow
RAI_RUST_FALLBACK=none
RAI_RUST_BINARY=/opt/rai/target/release/rai-data-worker
```

重启 API 后生效。先做完整备份，不需要重建主库 schema。

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

**没有把 Rust 默认打开，也没有上线部署。** 先在云服务器用真实数据副本验证，
再决定开启；完整 API/评分语言迁移仍按实际性能证据决定，不为了迁移而迁移。

## 本地交付检查

- `npm run typecheck`：通过。
- `npm run rust:verify`：Release 构建、2 项 Rust 单测、9 项专用集成/对照测试通过。
- `npm test`：686 项后端/共享包测试通过，3 项按既有条件跳过；84 项 Web 测试通过。
- `npm run build`：通过。
- Linux/macOS 原生 CI 任务已配置，但远端 CI 尚未在本次本地执行中运行。
- 桌面浏览器 E2E 仍受本机缺少 Chrome/Edge 阻塞；不能宣称浏览器端到端验收通过。
- 未连接云服务器或 N100，未修改真实健康数据库，未自动启用 Rust。
