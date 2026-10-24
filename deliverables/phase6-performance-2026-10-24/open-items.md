# 阶段 6 未关闭项与阻塞

- 日期：2026-10-24（Asia/Shanghai）。
- 口径：`PASS / FAIL / BLOCKED / NOT_RUN / NOT_APPLICABLE`；skip 不等于通过。
- 本清单随实施更新；最终报告只引用这里的真实状态，不把 BLOCKED 写成 PASS。

## 1. 环境阻塞

| ID | 状态 | 事项 | 影响 | 解除条件 |
|---|---|---|---|---|
| P6-ENV-1 | **BLOCKED** | 没有隔离 Linux 目标（2 vCPU/2 GiB、cgroup v2、systemd、150% CPU/1100M high/1400M max/512M swap/128 tasks 读回） | G5 CLOUD 资源/容量、G6 稳定容量点、G7 长跑/故障资源无法签收 | 提供专用隔离 Linux 实验机/VM，按 §4.2 隔离与读回 |
| P6-ENV-2 | **BLOCKED** | CLOUD-VALIDATION 需要 `RAI_TRAINING_PLAN_COMMAND_MODE=validation` + 客户端能力头 | 阶段 5 候选写能力性能未测 | 隔离环境 + 独立数据/输出；禁止生产启用 |
| P6-ENV-3 | **NOT_RUN** | N100 profile | 不影响 CLOUD 结论 | 有 N100 目标机时单独跑 |
| P6-DEV-1 | **NOT_RUN** | 审查修复后尚未按新源码/工具身份全量重跑 DEV | 原 DEV PASS 仅为历史裁决，当前 G0/G8 不可重签旧 run | 新根重跑、保存 raw/summary、同一 `code.sourceFiles` 下完成回归与离线裁决 |

## 2. 阶段 5 遗留（不因阶段 6 通过而关闭）

| ID | 状态 | 事项 | 依据 |
|---|---|---|---|
| P5-T26 | 部分 | 原生端到端只覆盖部分用户链路 | `PHASE5_REPORT.md` §6 |
| P5-T27 | 未执行 | 配对设备/新旧 App 交错升级、回滚 | 同上 |
| P5-T30 | 部分 | 完整设备验收证据不足 | 同上 |
| P5-PROD | 未启用 | 生产 `trainingPlanCommandContractVersion` 未宣告；未部署生产 | `PHASE5_REPORT.md` §1、§9 |

## 3. 本阶段未执行/部分执行的场景

| 场景 | 状态 | 原因 / 后续 |
|---|---|---|
| S10 D2/D3 等价性 | 部分 | DEV 只对 D1 做完整重算（99 features/99 assessments）；D2/D3 尚未跑全量等价与增长曲线 |
| S11 预测读取/训练 | **NOT_RUN** | 合成数据没有足量预测标签；训练需要真实 runner 与足量样本，不能用 missing_metrics 快速失败冒充性能 |
| S13 读写并发 | 部分 | 原 2 rps ×300 s + 30 s 运行仅含读；审查修复后 D1 短时真实 API 冒烟写入 2/2 成功，完整 DEV/D2、后台任务与 CLOUD 稳态仍待测 |
| S14 command 队列 16 | 部分 | series 过载已测；command 队列需要合法 mutation 用例锁存，未在本会话构造 |
| S15 故障组 | **NOT_RUN** | series/import/recompute/prediction/API 故障注入需要独立 run 与持久回执校验；夹具钩子可复用 |
| S16 恢复/epoch | **NOT_RUN** | 需阶段 4 恢复夹具与合法库替换/epoch 变更 |
| S17 停机积压追赶 | **NOT_RUN** | 需要可控停机与持久队列；DEV 不作为容量结论 |
| S18 ≥2h/100 周期 | **NOT_RUN** | 长跑窗口不足；不伪造稳态 |
| S19 备份/归档/恢复空间 | **NOT_RUN** | 需要完整文件生命周期与解包空间实测 |
| S20 原生 iOS | **NOT_RUN** | 需真机/Simulator 与隔离 API；API 数据不代替 iOS 体验证据 |

## 4. 实测缺陷/边界观察

| ID | 状态 | 观察 | 复现 | 影响 | 后续 |
|---|---|---|---|---|---|
| P6-F01 | **不是缺陷（车道误判）** | 5001 条被 **direct-sync** 接收并写入 5001 条；data-only 快通路已按 5000 上限拒绝 | `S08` / DX `04-record-only.zip`；job `performance.lane.directSource=direct-sync`，data-summary 增量 5001 | `directSyncBounds.maxRecords` 在直连车道只约束删除配额，不约束 XML `<Record>` 条数（`docs/IOS_NATIVE_API_CONTRACT.md:67`、`packages/api-contracts:223-229`、T14）；iOS 可发 12,000 | S08 结构化合同记录 `expectedLane=direct-sync` 与 +5001 事实量；若要改为拒绝需新合同/产品决策 |
| P6-F02 | **观察** | 2–8 MiB XML 被 data-only 拒绝、direct-sync 接受（合法车道边界） | `S08` / DX `05-record-only.zip`（5000 条，>2 MiB） | 不是缺陷；说明两条车道字节边界不同 | 报告分开记录，不混为同一 64 MiB |
| P6-F03 | **观察** | 非法 `HKQuantityTypeIdentifierNotARealType` 记录被接受并写入 1 条 | `S08` / DX `08-record-only.zip` | 解析器把未知类型当原始记录；是否符合产品合同需确认 | 若产品要求拒绝未知类型，补白名单与负例；当前不冒充拒绝 |
| P6-F04 | **观察** | 损坏 ZIP 返回 `400 invalid_import_archive`；GPX 201 文件与 >8 MiB XML 返回 `400 direct_sync_payload_exceeds_bounds` | S08 | 符合 fail-closed 方向 | 保留错误码断言 |
| P6-F05 | **FIXED / PASS** | 非法 `sync-manifest.json` 版本（`version:99`）现在 inspect 返回 400 `import_manifest_invalid`，零事实写入 | 新 S08 / DX `06-record-only.zip`；`preflightDirectSyncPayload` 返回 `manifest_invalid`，`laneRefusalFailure` 映射稳定码 | 坏 manifest 的拒绝码稳定，客户端可区分“请求坏”与“服务坏了” | 修复与回归已落地：`direct-sync-ingest.ts`、`import-worker.ts`、`direct-sync-ingest.test.ts`；新 S08 case PASS |

## 5. 工具/证据限制

- DEV 的 RSS 是 `ps` 采样，不是 cgroup `memory.current/peak`；worker thread 不重复相加，但共享页仍可能重复，报告写明。
- DEV 冷启动、OS 页缓存未清理；不能写“OS 页缓存冷”。
- P99 只在单组成功样本 ≥10,000 时发布；DEV 冒烟多为 `insufficient_samples`。
- 原始证据：旧 run 在 `/Users/ta/rai-phase6-lab/`，本轮新 run 在 `/Users/ta/rai-phase6-lab-fix/`（仓库外）；交付目录保存摘要、manifest、resources 原始 JSONL 与 SHA256SUMS，大体积数据库以 manifest 哈希+索引引用。
- 旧 `phase6-dev-d1-s13` 是旧负载器诊断数据（2 rps ×30 s、offered 70、completed 65、dropped 27），不得写成 0.5 rps ×60 s、0 dropped，也不得用于稳态容量。
- G9 只在全量 `npm test` 实际退出 0 且 regressions.json 绑定同一 codeIdentity 时通过；最终报告记录实际命令/退出码/并发。
- 审查修复后的门禁、cgroup 绝对路径约定与旧证据边界见 [REVIEW_FIXES_2026-10-24.md](REVIEW_FIXES_2026-10-24.md)。
