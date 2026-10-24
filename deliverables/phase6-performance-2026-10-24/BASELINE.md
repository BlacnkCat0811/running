# 阶段 6 基线（W0 冻结）

- 日期：2026-10-24（Asia/Shanghai）。
- 输入审查方案：`RAI_Phase6_Review_and_Implementation_Plan_2026-10-24.md`（用户下载目录，不入库；其输入 SHA 记录在 `source-manifest.json`）。
- 仓库：`/Users/ta/running`；审查 HEAD `732f3cf3943b0f52915fb10192f07405b0e672de`；本阶段实现是在该提交之上的未提交工作树（identity 见 [source-manifest.json](source-manifest.json)）。
- 协议：[protocol.json](protocol.json)；统计与裁决工具：[scripts/phase6](../../scripts/phase6)。
- 结论口径：**本文件冻结的是“测什么、怎么判、缺什么”，不是性能结论**。DEV 数字只证明工具与正确性，不签 CLOUD 容量。
- 审查后的工具约束与当前证据状态见 [REVIEW_FIXES_2026-10-24.md](REVIEW_FIXES_2026-10-24.md)；原 DEV PASS 不能跨源码/工具身份沿用。

## 1. 三层签收

| 签收层 | 可以证明什么 | 当前状态 |
|---|---|---|
| 测量工程完成 | 工具安全、数据/统计可复算、失败也形成报告 | 本阶段实施（见 PHASE6_REPORT） |
| 性能/容量验收 | 指定源码/数据/资源 profile/负载下满足冻结目标 | **BLOCKED**：无隔离 Linux 目标；DEV 只做冒烟与趋势 |
| 全部架构阶段/生产就绪 | 包括前序未关闭项与发布验收 | **不能由阶段 6 单独宣布** |

任何一层缺证据单独列出；不把“报告完整”写成“容量达标”。

## 2. 阶段 1–5 状态（不重写历史）

| 阶段 | 状态 | 依据 |
|---|---|---|
| 1 | 回执事务 worker 化与项目优化首批已落地 | `deliverables/phase1-main-thread-blocking/`、HEAD 历史 |
| 2 | SQLite 优化与 `/series` 读隔离已落地并发布 | `PHASE2_SQLITE_RELEASE_2026-10-22.md`、`PHASE2_FOLLOWUP_A_B_C_2026-10-22.md` |
| 3 | 双车道导入/分析边界已落地并发布 | `PHASE3_IMPORT_ANALYSIS_RELEASE_2026-10-23.md` |
| 4 | 多存储发布一致性与控制库发布锁已落地；真实生产备份/配置核验仍有未关闭项 | `PHASE4_REPORT.md`、`STORAGE_OWNERSHIP_MATRIX.md` |
| 5 | 主要修复落地；**T26 部分、T27 未执行、T30 部分**；生产命令能力关闭 | `deliverables/phase5-implementation-2026-10-23/PHASE5_REPORT.md` §6、§9 |

阶段 5 的未完成项（配对设备、交错升级/回滚、完整原生端到端）**不因阶段 6 通过而关闭**。

## 3. 资源 profile（冻结）

| Profile | 定义 | 可签范围 |
|---|---|---|
| DEV | 本机 macOS x64；Node v22.23.2；无 cgroup/systemd 限额 | G1–G4 工具/正确性、DEV 趋势、故障行为 |
| CLOUD-DEFAULT | 隔离 Linux：宿主/VM 2 vCPU/2 GiB；服务 `CPUQuota=150%`、`MemoryHigh=1100M`、`MemoryMax=1400M`、`MemorySwapMax=512M`、`TasksMax=128`；命令候选能力关闭 | 本会话 **BLOCKED**（无目标机） |
| CLOUD-VALIDATION | 同资源 + `RAI_TRAINING_PLAN_COMMAND_MODE=validation` + 客户端能力头 + 独立数据/输出 | **BLOCKED**；不得在生产启用 |
| N100 | 另一部署模板，独立结果 | **NOT_RUN**；不纳入 CLOUD 判定 |

`--max-old-space-size` 不是 RSS 上限；worker thread 共用进程 RSS，不与主进程相加；子进程/后代必须计入服务总量。

## 4. 数据矩阵（冻结 spec；实际行数以 manifest 为准）

| 数据集 | 记录 | 训练 | 跨度 | 用途 |
|---|---:|---:|---:|---|
| D0 | 3 + 最小派生 | 1 | 1 年 | 空态/启动/拒绝/身份 |
| D1 | 50,000 | 100 | 1 年 | 工具冒烟、轻量读写、生命周期 |
| D2 | 500,000 | 1,000 | 5 年 | 代表性基线 |
| D3 | 2,000,000 | 5,000 | 10 年 | 历史增长与容量上界探索 |
| DX | 0 | 0 | — | 合法上限、刚超限、损坏 ZIP、GPX 文件数/字节边界 |

数据含多来源重复、软删除训练、睡眠/HRV、时间空洞、不同长度路线；序列目标另有每秒 HR/速度与 100/500/2000 点路线。**不是生产统计**，不得称真实用户分布。

## 5. SLO 草案（建议目标，不是既存产品 SLO）

| 指标 | 目标 |
|---|---|
| health/handshake | P95 ≤100 ms、P99 ≤250 ms（CLOUD 代表性负载） |
| 轻量业务读 | P95 ≤500 ms、P99 ≤1500 ms（逐路由） |
| 热 series | P95 ≤1500 ms、P99 ≤3000 ms |
| 事件循环 | P95 ≤50 ms、P99 ≤200 ms |
| 稳定完成率 | ≥99.9%；错误内容/重复发布/错误 epoch = 0 |
| 内存 | 稳定组高水位尽量 < `MemoryHigh=1100M`；非故障组 OOM=0 |
| CPU | 稳定容量长期平均 ≤70% 配额 |
| 资源收口 | 100 周期/2 小时无无界增长；停输入 10 分钟后回稳态 |

正式业务签收前必须由产品确认；未确认时只报告实测，不签“及时/达标”。

## 6. 当前仓库审查映射（R6）

| ID | 处理 |
|---|---|
| R6-01 | 本文件 + `open-items.md` 建立当前阶段清单；不沿用旧计划状态 |
| R6-02 | 阶段 5 未完成项保留；CLOUD-VALIDATION 独立 profile，不冒充默认生产 |
| R6-03/R6-13 | 模板限额写入 profile；运行前必须 cgroup 读回；N100 独立 |
| R6-04 | 新增 driver/资源采样；服务端 `/v1/performance` 只作辅助 |
| R6-05 | 队列按持久 job/事件计数；不把 `waiting.length` 当积压 |
| R6-06 | `/series` 正常/冷/过载/故障回退分场景（S03/S14/S15） |
| R6-07 | 每请求校验状态、训练身份与非空业务结果；404 假成功判失败 |
| R6-08 | `data:benchmark` 仅局部补充，不作为 HTTP 全链路基准 |
| R6-09 | 复用安全/样本格式思路，重新定义样本数与分位数 |
| R6-10 | 唯一 PID 汇总 RSS；worker thread 不重复相加；子进程单列 |
| R6-11 | 导入边界（2 MiB/8 MiB/5000 条/200 GPX）逐项测量，见 DX/S05–S08 |
| R6-12 | 存储预算在 CAPACITY_MODEL 覆盖完整文件生命周期；本会话未实测备份 |
| R6-14 | SLO/停止条件/统计口径已写入 protocol.json |

## 7. 不变量

- 继续 SQLite、单 API/单写者、既有 worker/child process 架构。
- 保留准入、mutation coordinator、write lease、publication lock/guard、epoch、回执、账本与发布校验。
- API 导入保持 data-only → direct-sync → terminal refusal；禁止候选库回退/整库替换。
- 不新建 Web/桌面/其他移动客户端，不改写算法，不写 HealthKit 健康记录，不引入 PostgreSQL/Redis。
- 不对生产压测、重算、训练、恢复或故障注入；不自动部署监控或改生产限额。
