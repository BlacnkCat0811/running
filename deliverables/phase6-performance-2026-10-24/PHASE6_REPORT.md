# 阶段 6：性能基线与容量模型实施与验收报告（2026-10-24 修复版）

- 日期：2026-10-24（Asia/Shanghai）。
- 输入：`RAI_Phase6_Review_and_Implementation_Plan_2026-10-24.md` 与 `RAI_Phase6_Uncommitted_Review_Fix_Plan_2026-10-24.md`（用户下载目录，不入库）。
- 代码基线：审查 HEAD `732f3cf3943b0f52915fb10192f07405b0e672de` + 原运行时未提交工作树；当时记录的工具/协议/夹具哈希见 [source-manifest.json](source-manifest.json)。该清单未覆盖全部 API/package 运行源码，不能用于当前代码签收。
- 协议：[protocol.json](protocol.json)；容量公式：[CAPACITY_MODEL.md](CAPACITY_MODEL.md)；旧证据冻结：[EVIDENCE-FREEZE.json](evidence/EVIDENCE-FREEZE.json)；证据索引：[run-index.json](evidence/run-index.json)。
- 结论口径：**以下 PASS 是本报告原运行时的历史裁决。** 审查后的修复与当前代码签收状态见 [审查修复记录](REVIEW_FIXES_2026-10-24.md)及 [当前机器状态](CURRENT_STATUS.json)：旧 run 缺少运行源码哈希，S13 为纯读，当前工具不能重签这些 DEV 结果；全量 DEV 待重跑，CLOUD 容量仍 BLOCKED。

## 1. F0–F6 执行状态

| 工作包 | 状态 | 关键证据 |
|---|---|---|
| F0 冻结旧证据 | **DONE** | 296 个证据文件 SHA-256（旧 run 全部文件 + 新 run）、旧 run 只读、资源 JSONL 归档、S13 旧数据更正 |
| F1 runner 隔离与不可覆盖 | **DONE** | 纯预检、独占新根、TMPDIR/HOME 根内、删除前所有权复核、incomplete manifest |
| F2 S13 负载器与 S08 oracle | **DONE** | 在途 `Set`、双调度器、计数守恒、S08 结构化合同 + `raw/cases.jsonl` |
| F3 协议指纹与离线复算 | **DONE** | G0/G8 调用指纹校验；saved summary 与 raw 比较；篡改负例非 0 |
| F4 cgroup 采样与 G5 门禁 | **DONE（仅模拟）** | 目标 PID 归属、限额读回、模拟文件系统负例；真实 Linux G5 仍 BLOCKED |
| F5 DEV 复跑与报告更正 | **DONE** | 新 run-id/新源码指纹/新 raw；旧结果保留并标为失效或诊断 |
| F6 CLOUD G5–G7 | **BLOCKED** | 无隔离 Linux 目标；不把 macOS RSS 换算成 CLOUD 容量 |

状态规则：`PASS / FAIL / BLOCKED / NOT_RUN / NOT_APPLICABLE` 分列；机器结果同时保留 `knownFailures`、`blocked`、`notRun`，不用单一 BLOCKED 覆盖已知 FAIL。

## 2. F0：旧证据冻结与口径更正

旧证据保存在 [evidence/runs](evidence/runs)，本轮新证据在 [evidence/runs-v2](evidence/runs-v2)。旧 run 的全部文件（含新增归档的 `resources-*.jsonl`）已记录 bytes + SHA-256 + mode，并在冻结后设为只读；`treeSha256` 与逐文件清单见 [EVIDENCE-FREEZE.json](evidence/EVIDENCE-FREEZE.json)。

**S13 旧数据更正（不可改写旧 raw）：** `phase6-dev-d1-s13` 的原始[任务事件](evidence/runs/phase6-dev-d1-s13/results/S13/raw/task-events.jsonl)记录 **2 rps、30 s、warmup 5 s、offered 70、completed 65、dropped 27**；旧报告写成 0.5 rps ×60 s、0 dropped。该 run 因旧负载器把已完成 Promise 累计在 `pending` 数组中，在 64 上限后误丢请求，列为“旧负载器诊断数据”，**不能用于稳态容量判断**。D1 旧主 run 的 0.5 rps ×60 s（30 主 + 30 health、0 dropped）是另一轮，不得混同。

旧 `phase6-dev-d1`、D2、D3、S10、S08 诊断 run 保留原裁决与原始哈希，统一标为 `frozen-legacy`，不用于新 6A 签收：

- [D1 旧主 run](evidence/runs/phase6-dev-d1/report/summary.md)
- [D1 旧 S13 诊断 run](evidence/runs/phase6-dev-d1-s13/report/summary.md)
- [D2 旧读基线](evidence/runs/phase6-dev-d2/report/summary.md)
- [D3 旧读基线](evidence/runs/phase6-dev-d3/report/summary.md)
- [S10 旧重算](evidence/runs/phase6-dev-s10/report/summary.md)
- [S08 旧缺陷诊断](evidence/runs/phase6-dev-s08-diagnostic/report/summary.md)
旧交付包缺失的 `resources-*.jsonl` 已从受控实验室原样归档到各自 `raw/`，索引记录路径/大小/SHA，旧 requests/task-events 一字节未改。

## 3. 新运行与源码指纹

本轮所有 run 使用全新根 `/Users/ta/rai-phase6-lab-fix/`、新 run-id、独立主/控库、根内 `tmp`/`home`、回环 `RAI_API_PORT=0` 与新生成 Token。交付副本：

- D1 主 run：[summary](evidence/runs-v2/phase6-fix-dev-d1-main/report/summary.md) / [manifest](evidence/runs-v2/phase6-fix-dev-d1-main/manifest.json)
- D1 S13 正式热读：[summary](evidence/runs-v2/phase6-fix-dev-d1-s13/report/summary.md) / [manifest](evidence/runs-v2/phase6-fix-dev-d1-s13/manifest.json)
- D1 S08 边界复测：[summary](evidence/runs-v2/phase6-fix-dev-d1-s08/report/summary.md) / [manifest](evidence/runs-v2/phase6-fix-dev-d1-s08/manifest.json)
- D1 S10 完整重算：[summary](evidence/runs-v2/phase6-fix-dev-d1-s10/report/summary.md) / [manifest](evidence/runs-v2/phase6-fix-dev-d1-s10/manifest.json)

| Run-id | 场景 | 请求 | 结果 |
|---|---|---:|---|
| `phase6-fix-dev-d1-main-20261024-04` | S01,S02,S03,S04,S05,S06,S07,S08,S09,S12,S14 | 737 | 737 success；0 oracle 失败；S08 7/7 case 通过 |
| `phase6-fix-dev-d1-s13-20261024-04` | S13 | 990 | 660 主 + 330 health；0 dropped；0 timeout；0 oracle 失败 |
| `phase6-fix-dev-d1-s08-20261024-04` | S08 | 179 | 7/7 case 通过；P6-F05 已验证为稳定 400 |
| `phase6-fix-dev-s10-20261024-04` | S10 + 完整重算 | 4 | 99/99 features、99/99 assessments；recompute job succeeded |

### 3.1 D1 主 run 读路径（新工具，DEV 趋势）

| 路由 | n | P50 ms | P95 ms | 说明 |
|---|---:|---:|---:|---|
| `/v1/dashboard` | 1 | 83.1 | 83.1 | latestWorkout 非空 |
| `/v1/workouts`（首/中/尾页） | 3 | 12.3 | 16.9 | 分页/排序/总数 |
| `/v1/workouts/:id` | 1（+1 预期 404） | 22.9 | 22.9 | 404 单列，不进入成功分位数 |
| `/v1/mobile/today` | 1 | 71.8 | 71.8 | 时区对象 |
| `/v1/mobile/training-plan-state` | 1 | 63.0 | 63.0 | contractVersion=1 |
| `/v1/data-summary` | 1 | 104.2 | 104.2 | 行数与 manifest 对齐 |
| `/v1/data-audit` | 1 | 60.7 | 60.7 | 诊断路由单列 |
| series 小/中/大（冷+热） | 12 | 115.3 | 1,026.1 | 全部 200；heartRate 样本非空 |
| S14 series large 80 并发 | 80 | 10,058.5 | 17,362.6 | 64 成功 + 16 显式 503 `series_read_overloaded`；health 174 次全 200 |

### 3.2 S13：修复后的负载器

新负载器把在途请求放进可删除的 `Set`；主请求与 1 Hz health 使用两个独立单调时钟调度器；`scheduledAt` 由统一墙钟锚点与计划单调偏移计算。计数拆分并守恒：

| 计数 | 值 |
|---|---:|
| mainOffered / mainSent / mainCompleted / mainDropped | 660 / 660 / 660 / 0 |
| healthOffered / healthSent / healthCompleted / healthDropped | 330 / 330 / 330 / 0 |
| peakInFlight / peakMainInFlight / peakHealthInFlight | 4 / 3 / 4 |
| http503 / timeout / oracleFailure | 0 / 0 / 0 |
| warmup / steady 主请求 | 60 / 600 |
| 稳态主请求 P50 / P95 | 19.9 ms / 65.5 ms |
| 稳态 health P50 / P95 | 4.2 ms / 40.9 ms |
| P99 | `insufficient_samples`（600 < 10,000） |

计数守恒在 task event 中逐项为 true：`mainOffered = mainSent + mainDropped`、`mainSent = mainCompleted + mainCancelled + mainStillInFlight`，health 同理；收尾后 `stillInFlight=0`。旧 27 次 dropped 的原因与证据保留在旧 run，不被新结果覆盖。

### 3.3 S08：结构化合同与业务修复

每个 DX 载荷的 `contract` 固定期望车道、允许拒绝阶段、HTTP 状态/code、是否允许创建 job、预期事实增量；driver 对每个载荷写 `raw/cases.jsonl` 的独立 `caseResult`，`caseResult.ok=false` 直接进入 `correctness.oracleFailures`，driver 非 0、G4 FAIL。

| Case | 结果 | 车道 / 拒绝 | 事实增量 |
|---|---|---|---|
| 超记录上限 5001 条 | PASS | direct-sync | health_records +5,001 |
| XML 字节超 2 MiB（合法 5000 条） | PASS | direct-sync | +5,000 |
| 非法 manifest 版本 | PASS | inspect 400 `import_manifest_invalid` | 0 |
| 损坏 ZIP | PASS | upload 400 `invalid_import_archive` | 0 |
| 非法记录类型 | PASS（观测） | direct-sync 接受 1 条 | +1 |
| GPX 201 文件（超 200） | PASS | inspect 400 `direct_sync_payload_exceeds_bounds` | 0 |
| direct-sync XML 超 8 MiB | PASS | inspect 400 `direct_sync_payload_exceeds_bounds` | 0 |

**P6-F01 更正（重要）：** 旧报告把“5001 条被接受”写成 data-only 缺陷。实测 data-only 快通路按 `DATA_ONLY_MAX_RECORDS=5000` 正确拒绝 5001 条；随后 direct-sync 车道按产品合同接收并写入 5,001 条。合同依据：`docs/IOS_NATIVE_API_CONTRACT.md:67` 与 `packages/api-contracts/src/index.ts:223-229` 明确 `directSyncBounds.maxRecords` 在直连车道只约束删除配额，不约束 XML `<Record>` 条数（iOS 可发到 12,000）；`apps/api/test/phase3-import-matrix.test.ts` 的 T14 断言 5001 条在直连车道必须接收。因此这是**车道边界，不是缺陷**；S08 合同记录 `expectedLane=direct-sync` 与 +5,001 事实量，不再用“必须拒绝”的错误期望制造假 FAIL。

**P6-F05 修复：** `preflightDirectSyncPayload` 现在捕获 manifest 解析错误并返回 `manifest_invalid` 拒绝（`stage=prepare`）；`laneRefusalFailure` 映射为稳定 `import_manifest_invalid` 400。新增回归 `P6-F05：非法 manifest 版本在 preflight 返回稳定拒绝码，不抛成 500`。修复后 S08 的非法 manifest case 实测 inspect 400、零事实写入。

### 3.4 S10 完整重算

recompute job `status=succeeded`，progress `99/99`；driver 四请求全 200，`/v1/dashboard` activeModel 非空、`/v1/model-runs` 非空、`/v1/workouts` 无 failed 分析、`/v1/data-summary` assessments > 0。

## 4. 修复实现明细

### 4.1 F1 runner

- 严格参数解析；未知名、缺值、`--execute`/`--dry-run` 冲突均退出 2。
- 纯预检在创建根之前完成：profile/dataset/场景必须在冻结协议中，数值范围、硬超时、fixture manifest/载荷路径/SHA/合同全部校验。
- `createOwnedExperimentRoot` 默认独占：任何已有根（含同 run-id）在清理前 `root_exists`；`--dry-run` 不创建根/不打开数据库/不发请求。
- `TMPDIR/TMP/TEMP/HOME/XDG_CACHE_HOME/npm_config_cache` 全部指向根内；删除前复核 marker/run-id/realpath/symlink。
- SIGINT/SIGTERM/子进程超时写 `status:incomplete` manifest 并保留 raw；本轮负例见 `phase6-runner.test.mjs` 3/3。

### 4.2 F2 S13 / S08

- S13 使用 `Set<Promise>` 真实在途；主/health 分别调度；记录 `mainOffered/mainSent/mainCompleted/mainDropped` 与 health 同名字段，另记 503/timeout/oracleFailure/peakInFlight。
- 主请求保留 `maxInFlight-1` 个槽位、health 使用保留槽位；合计不超过上限；窗口过期 tick 计入 offered 并归为 `mainDroppedWindow`，不静默跳过。
- 预热与正式窗口分别计数，正式窗口不混入 warmup；open-loop 不按服务端完成时间调整下一次计划到达。
- S08 合同在 `scripts/phase6/s08-contract.mjs`（纯函数），负例覆盖“HTTP 全 2xx 但拒绝 case 被接受”“错误 code/阶段/部分事实”“5001 条 direct-sync 车道/事实匹配”。

### 4.3 F3 协议指纹与离线复算

- `fingerprintErrors()` 校验：协议文件 SHA、protocolId/version、profile/dataset/场景集合、package-lock、`scripts/phase6/*.mjs` 工具哈希、fixture SHA、fixture manifest SHA、payload manifest SHA。
- G0 与 G8 都消费该结果；测后改协议、改 manifest 身份、改 summary 数字、删 case/raw 均非 0。
- G8 读取**已保存的** `report/summary.json` 和 `correctness/*.json`，从 `raw/*.jsonl` 独立重算后比较 `n/offered/completed/businessSuccess/expectedRefusal/p50/p95/p99/p99SampleCount/timeouts/serverErrors/oracleFailed` 等字段；不再用同一函数重算再和自己比。
- `summarizeDurations` 的成功样本 = `outcome=success` 且 HTTP 2xx/3xx；超时、5xx、预期 4xx 不进入成功分位数。P99 只在成功样本 ≥10,000 时发布；超时仍留在成功率/完成率分母。

### 4.4 F4 cgroup / G5

- 新增 `scripts/phase6/cgroup.mjs`：解析 `cpu.max`（quota/period→核数）、`memory.high/max/swap.max`、`pids.max`、`memory.current/peak/events`、`cpu.stat`、`io.stat`；缺失保持 null。
- 采样器以目标 API PID 的 `/proc/<pid>/cgroup` 定位受测组，记录采样器自己的组；逐 PID 检查 API、worker child、后代归属，逃逸 PID 单列。
- 模拟文件系统负例覆盖：缺 `cpu.max`、改错 `memory.max`、`memory.swap.max=max`、API 在组 A/采样器在组 B、child 在组外；G5 对 cloud profile 无读回直接 FAIL，DEV 明确 BLOCKED。
- 真实 G5 仍需隔离 Linux 目标；本轮没有创建或伪造 CLOUD service/cgroup，因此 G5–G7 保持 BLOCKED。

## 5. 离线裁决与负例

`node scripts/phase6/verify.mjs --self-test` 通过；新增/更新的负例：

| 负例 | 结果 |
|---|---|
| 协议 SLO/场景/profile 改一字节 | G0 FAIL、G8 FAIL、非 0 |
| 改 run manifest 协议 SHA/fixture SHA/工具身份 | G0/G8 FAIL 并指出字段 |
| 改已保存 summary 的 P95 | G8 FAIL，不是“重算后和自己比” |
| 删除 raw/case/资源文件 | G3/G4/G8 按口径 FAIL、非 0 |
| 未知 scope/profile/场景 | 非 0，不落入 DEV 默认通过 |
| cloud profile 无 cgroup 读回 | G5 FAIL（DEV 为 BLOCKED） |
| 9999 成功 + 1 超时 | P99 `insufficient_samples` |
| 10000 预期 4xx | 正常读 P99 `insufficient_samples` |
| 10000 成功 + 超时 | P99 可发布、完成率 <1 |

从**交付包**与**原实验根**各运行一次离线 verify（相同原始文件哈希）均得到同一裁决；不连接 API/数据库。交付包内 `resources-*.jsonl` 已包含，verify 先校验摘要，缺文件非 0。

## 6. 场景状态（新 run）

| 场景 | 状态 | 说明 |
|---|---|---|
| S01 启动/health/handshake | PASS | 身份/ready 正确；冷启动首请求单列 |
| S02 dashboard/workouts/today/plan-state | PASS | 分页/排序/删除 404 预期拒绝单列 |
| S03 series 小/中/大 冷/热 | PASS | 非空 heartRate；伴随 health |
| S04 data-summary/data-audit/诊断 | PASS | 诊断路由单列 |
| S05 record-only 上传/inspect/job | PASS | 100/2500/4990 三档全部成功，事实增量匹配 |
| S06 重复/同内容/响应丢失路径 | PARTIAL | 同包/不同身份无重复；真正响应丢失后重试未构造 |
| S07 direct-sync + GPX | PASS | 3 文件路线、账本、analysis queued |
| S08 合法上限/超限/损坏 | PASS | 7/7 结构化 case；P6-F05 修复；5001 按 direct-sync 合同 |
| S09 导入→分析→发布→读可见 | PASS | 发布窗口内可见 published |
| S10 增量/完整重算 | PARTIAL | D1 完整重算通过；D2/D3 等价性 NOT_RUN |
| S11 预测读取/训练 | NOT_RUN | 合成数据无足量标签；不伪造 |
| S12 计划读取 | PASS（DEV 默认组） | validation 写能力 BLOCKED |
| S13 热读诊断（修复前） | PARTIAL | 2 rps ×300 s + 30 s 预热只含 GET；写入与后台任务不在此历史证据中，当前代码短时写入冒烟见审查修复记录 |
| S14 series/command 过载 | PARTIAL | series 64/503 已测；command 队列 16 NOT_RUN |
| S15–S19 故障/恢复/追赶/长跑/备份 | NOT_RUN | 无隔离 Linux/长跑环境 |
| S20 原生 iOS | NOT_RUN | 无 iOS 运行证据 |

## 7. CLOUD G5–G7

- G5：**BLOCKED**。协议 cloud profile 要求 1.5 核、1100M high、1400M max、512M swap、128 tasks、2 vCPU/2 GiB 宿主；本轮没有隔离 Linux service/cgroup，不把 DEV 的 macOS RSS 当作 `memory.current`。
- G6：**BLOCKED**。无 CLOUD 15 min 稳态 ×3 次独立重复；S13 的 5 min DEV 热读只用于工具与趋势。
- G7：**BLOCKED**。S15–S19 与 S20 未运行。

## 8. 门禁与回归

完整命令/退出码/平台/并发见 [evidence/regressions.json](evidence/regressions.json)。

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `node scripts/phase6/verify.mjs --self-test` | 0 | 所有负例被捕获 |
| `npm run phase6:test` | 0 | 41 tests / 41 pass / 0 fail |
| `npm run typecheck` | 0 | pure + full 通过 |
| `RAI_TEST_CONCURRENCY=2 npm test` | 0 | 2603 tests / 2590 pass / 13 skipped / 0 fail；1,113,008 ms（约 18m33s）；并发 2 |
| `npm run check:acceptance-matrix` | 0 | 80 cited / 0 missing |
| `npm run smoke:api` | 0 | Production API runtime smoke test passed |
| `npm run check:scripts` | 0 | 18 package.json / 116 scripts |
| `npm run check:docs` | 0 | 见回归记录；新增 summary.md 均由本报告链接 |
| `git diff --check` / `git diff --cached --check` | 0 | 无空白错误 |

G0–G9 汇总：

| Gate | 状态 | 依据 |
|---|---|---|
| G0 冻结 | PASS | 协议/源码/工具/fixture/payload 指纹全部一致 |
| G1 安全 | PASS | rootOutsideRepo/envWhitelist/isolatedTemp；raw 无 Token |
| G2 夹具 | PASS | 新 D1/DX manifest 含 databaseSha256；digest 一致 |
| G3 观测 | PASS | raw 结构/资源覆盖/无 404 假成功/S08 case 证据齐全 |
| G4 DEV 正确性 | PASS | 新 run 全部声明场景 0 oracle 失败；S08 7/7 |
| G5 CLOUD 资源 | BLOCKED | 无隔离 Linux cgroup 读回 |
| G6 CLOUD 容量 | BLOCKED | 无 15 min ×3 稳态 |
| G7 故障/长跑 | BLOCKED | S15–S20 未执行 |
| G8 统计/裁决 | PASS | saved summary 与 raw 独立复算一致；P99 门槛生效 |
| G9 回归 | PASS | 同一 codeIdentity 下记录 |

**阶段 6 总体：BLOCKED。** 本表 G0–G9 是旧代码身份下的历史裁决；当前代码的 DEV 签收待全量复跑，CLOUD G5–G7 未测。不宣告阶段 5 设备验收或 CLOUD 容量通过。

## 9. 复跑命令

```text
node scripts/phase6/runner.mjs --root <new-lab>/run-main \
  --profile dev --protocol deliverables/phase6-performance-2026-10-24/protocol.json \
  --scenario S01,S02,S03,S04,S05,S06,S07,S08,S09,S12,S14 --dataset D1 \
  --fixture <new-lab>/fixture-d1/datasets/D1/rai.sqlite \
  --fixture-manifest <new-lab>/fixture-d1/datasets/D1/manifest.json \
  --payload-manifest <new-lab>/fixture-dx/datasets/DX/manifest.json --execute

node scripts/phase6/runner.mjs --root <new-lab>/run-s13 \
  --profile dev --protocol deliverables/phase6-performance-2026-10-24/protocol.json \
  --scenario S13 --dataset D1 --rate 2 --duration-ms 300000 --warmup-ms 30000 \
  --fixture <new-lab>/fixture-d1/datasets/D1/rai.sqlite \
  --fixture-manifest <new-lab>/fixture-d1/datasets/D1/manifest.json --execute

node scripts/phase6/summarize.mjs --input <new-lab>/run-main --output <new-lab>/run-main/report
node scripts/phase6/verify.mjs --input <new-lab>/run-main \
  --protocol deliverables/phase6-performance-2026-10-24/protocol.json \
  --regressions deliverables/phase6-performance-2026-10-24/evidence/regressions.json
```

CLOUD 复跑需要先提供隔离 Linux 目标与预创建 cgroup，`--cgroup` 传 `/sys/fs/cgroup/...` 下的绝对目录；runner 将 API PID 放入该组后再启动服务，采样器留在组外。没有逐场景 `targetCgroup`/限额读回时 G5 不允许 PASS。

## 10. 未关闭项

1. 真实 CLOUD G5–G7：隔离 Linux、15 min ×3 稳态、并发/积压/故障/长跑/磁盘证据。
2. S11 预测训练、S15–S19 故障/恢复/长跑、S20 原生 iOS：NOT_RUN。
3. S06 真正响应丢失后的重试路径未构造；S10 D2/D3 等价性未跑。
4. direct-sync 5001 条是产品合同允许的车道边界；若要改成拒绝，必须走新的产品决策与合同/测试变更，不能只在性能工具里改期望。
