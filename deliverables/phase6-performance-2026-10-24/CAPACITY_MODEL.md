# 阶段 6 容量模型与实测包络

- 日期：2026-10-24（Asia/Shanghai）。
- 口径：本文件只把**实测**与**可计算**的部分写成容量结论；缺失的 CLOUD 资源读回一律 `unavailable/BLOCKED`，不用 macOS 数字换算。
- 输入：`/Users/ta/rai-phase6-lab/phase6-dev-d1|d2|d3|s10` 的 manifest/summary；协议见 [protocol.json](protocol.json)。

## 1. CPU 与并发

窗口内服务树 CPU 消耗 `C_cpu`（core-seconds），配额利用率：

`U_cpu = C_cpu / (窗口秒数 × 1.5)`

- CLOUD 需要 `cgroup cpu.stat` 的 `usage_usec` 差分与 `cpu.stat nr_throttled/throttled_usec`；本会话无 cgroup，**`C_cpu` 与 `U_cpu` 均 unavailable**。
- DEV 只记录 `ps` 采样 `cpuPercentSum` 峰值：D1 131.4%、D2 166.7%、D3 122.5%。这是宿主多核百分比，不是 1.5 核配额占用，不能代入公式。
- 单任务 CPU 服务需求：S09 单训练 + 50 记录导入 1.18 s；S07 3 GPX 导入 1.59 s；S05 4,990 条 data-only 9.71 s。只能作为初始负载点的粗估，不能代替混合负载实测。
- 调度器仍只允许一个重型写者；这不表示读请求互斥，也不表示所有 worker 计算阶段完全互斥。

## 2. 内存（主判据是同时刻服务总量）

- 主判据：`M_service_peak = max_t(cgroup.memory.current(t))`，可用时同时记录内核 `memory.peak`。
- 本会话 `cgroup` 不可用，只有唯一 PID 的 RSS 采样：
  - D1 峰值 **349.0 MB**（S09 导入/分析窗口；S08 330.5 MB、S14 342.6 MB）；
  - D2 峰值 **295.3 MB**；D3 峰值 **276.1 MB**（短读窗口，采样 1 s，可能漏峰）。
- Node 主进程 RSS 已包含同进程 worker thread，未相加；预测/训练子进程 S11 未运行，未计入。
- `MemoryHigh=1100M` / `MemoryMax=1400M` 的 CLOUD 判定需要 cgroup 读回；DEV 的 349 MB 不可当作 CLOUD 余量结论。
- 采样分辨率 1 s；短于 1 s 的峰值可能漏采，报告不声称捕获所有峰值。

## 3. 队列与故障追赶

按任务类型 `i`：

`ρ_writer = Σ λ_i × E[S_i] < 1`

- 本会话没有 CLOUD 后台任务到达率/单写者服务时间样本，`ρ_writer` **不可计算**。
- DEV 观察：S05 三档 data-only 导入 1.26/5.28/9.71 s；S09 分析 8.9 s 发布；S10 完整重算 99 个 features/assessments。它们只说明单任务成本，不能外推混合到达。
- 追赶公式：`T_catchup_est ≈ B0/(μ-λ)`；S17 未执行，不能用 S13 的读延迟代替。
- 合并/重试：S06 证明同包重放与不同上传身份都无重复事实；no-op 成本单列（见 S06 原始 raw）。

## 4. 磁盘与保留

`D_required = D_live + D_WAL_peak + D_upload_peak + D_extract_peak + D_model_artifacts + D_protection + D_backups + D_verify_restore_temp + D_logs + D_margin`

| 项 | 本会话实测/状态 |
|---|---|
| D_live（主库） | D1 35.8 MB、D2 276.7 MB、D3 1,079.6 MB（fixture manifest） |
| D_WAL_peak | 仅在**夹具生成**观察到 D3 WAL 峰值 ~1.09 GB；不是服务生命周期 WAL，不纳入 D_required |
| D_upload_peak / D_extract_peak | 导入临时目录未做完整生命周期计量；NOT_RUN |
| D_model_artifacts | 仅 S10 模型工件，未单独测量；NOT_RUN |
| D_protection / D_backups | 模板 14 份/10 GiB 为起点，真实 profile 未读回；NOT_RUN |
| D_verify_restore_temp | 按解包后实际大小预算；本会话未执行 S19；NOT_RUN |
| D_logs / D_margin | 未计 |
| **结论** | 只能确认 D3 数据库本体 1.08 GB；完整 D_required **不可计算**，不得用压缩包大小代替解包空间 |

## 5. 实测容量表（DEV）

| profile | dataset | 场景/路由 | offered | served | P50 ms | P95 ms | P99 | memoryPeak(RSS) | CPU 采样峰值 | verdict |
|---|---|---|---:|---:|---:|---:|---|---:|---:|---|
| dev | D1 | S02 dashboard | 1 | 1 | 123.8 | 123.8 | insufficient_samples | 349 MB（run 峰值） | 131.4% | 趋势 |
| dev | D1 | S02 workouts 列表 | 3 | 3 | 27.8 | 33.7 | insufficient_samples | 同上 | 同上 | 趋势 |
| dev | D1 | S03 series 冷/热 | 12 | 12 | 173.0 | 1635.1 | insufficient_samples | 295 MB（S03） | 115.4% | 趋势 |
| dev | D1 | S13 混合 **2 rps ×300 s（新工具，30 s 预热）** | 660 主 + 330 health | 990 | 主 19.9 / health 4.2 | 主 65.5 / health 40.9 | insufficient_samples | 见新 run resources | 见新 run resources | 0 dropped；计数守恒 |
| dev（旧） | D1 | S13 混合 0.5 rps ×60 s（旧主 run） | 30 主 + 30 health | 60 | — | health 264.4 / today 466.3 / series 1071.5 | insufficient_samples | 269 MB | 129.5% | 历史趋势 |
| dev | D1 | S14 80 并发 series | 80 | 64（16×503） | 8567.9 | 21649.5 | insufficient_samples | 331 MB | 128.3% | 过载边界 |
| dev | D2 | S02 dashboard | 1 | 1 | 137.6 | 137.6 | insufficient_samples | 295 MB（run） | 166.7% | 趋势 |
| dev | D2 | S02 mobile today | 1 | 1 | 451.7 | 451.7 | insufficient_samples | 同上 | 同上 | 趋势 |
| dev | D2 | S04 data-audit | 1 | 1 | 521.8 | 521.8 | insufficient_samples | 168 MB（S04） | — | 诊断单列 |
| dev | D3 | S02 mobile today | 1 | 1 | 15700.3 | 15700.3 | insufficient_samples | 276 MB（run） | 122.5% | 超预算 |
| dev | D3 | S04 data-summary | 1 | 1 | 7853.8 | 7853.8 | insufficient_samples | 168 MB（S04） | — | 超预算 |
| dev | D3 | S04 data-audit | 1 | 1 | 34669.2 | 34669.2 | insufficient_samples | 168 MB（S04） | — | 诊断单列/超预算 |
| cloud-default | — | — | — | — | — | — | — | — | — | **BLOCKED** |
| cloud-validation | — | — | — | — | — | — | — | — | — | **BLOCKED** |
| n100 | — | — | — | — | — | — | — | — | — | NOT_RUN |

### 5.1 最高通过点与首个失败点

- **DEV 读**：旧 `phase6-dev-d1-s13` 的 2 rps ×30 s 出现 27 dropped，是旧负载器把已完成 Promise 累计在 `pending` 数组造成的工具缺陷（原始 task-events：offered 70、completed 65、dropped 27），不是服务端容量结论。修复后新 run 2 rps ×300 s（30 s 预热）为 660 主 + 330 health、0 dropped、计数守恒；DEV 的 2 rps 不再被判为“失败点”。这些仍是 DEV 现象，不是 CLOUD 容量。
- **DEV series**：80 并发触达 64 个在途准入，16 个显式 503；这是“第 65 个起拒绝”的合同证据，不是“最多支持 64 并发用户”。
- **无 CLOUD 通过点**：没有 cgroup 资源读回，不能给出 1、2、5、10、20 rps 的 CLOUD 阶梯结论。

### 5.2 告警建议（仅建议）

- 持续探活超时；`/v1/health` P95 连续超阈值。
- `memory.high` 持续触发或 cgroup `memory.events high` 增长；`MemoryMax` 接近。
- 持久队列最老年龄超过冻结期限；导入/重算/prediction job `failed` 增长。
- 磁盘剩余低于本轮临时需求 + 2 GiB 安全储备；WAL/备份/解包目录异常增长。
- 发布校验失败/重启次数/worker generation 变更。**不自动安装或改生产阈值。**

## 6. 误差与不可外推项

- DEV 与 CLOUD 的 CPU 单核性能、磁盘、虚拟化、cgroup 限额不同；不能把 macOS 毫秒换算成云容量。
- 采样 1 s、无内核 peak；短峰值可能漏采。
- P99 在单组 <10,000 成功样本时一律 `insufficient_samples`；本会话所有 DEV 路由均未达到该门槛。
- D3 的 `mobile/today`、`data-summary`、`data-audit` 慢值是**真实测量**，但需判断是否由合成数据的分布（5,000 sessions、无真实计划历史）放大；在 CLOUD 复测前不当作生产结论。
- 没有后台任务混合到达率，`ρ_writer` 与 `T_catchup` 不可计算；S17/S18/S19 未执行。
