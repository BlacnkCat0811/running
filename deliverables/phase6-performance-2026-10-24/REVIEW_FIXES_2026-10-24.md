# 阶段 6 未提交改动审查修复（2026-10-24）

本记录接续 [阶段 6 报告](PHASE6_REPORT.md)，当前机器状态另见 [CURRENT_STATUS.json](CURRENT_STATUS.json)。原 `evidence/runs-v2/` 的 raw、manifest 和 acceptance 保持原样，代表修复前的历史运行。其工具哈希与本次实现不同，且缺少 API/package 运行源码哈希；**不得把原 DEV PASS 当作当前代码的签收**。当前代码需要全量 DEV 重跑，CLOUD 仍等待隔离 Linux 目标。

## 修复与裁决口径

| 审查项 | 修复 | 防回归证据 |
|---|---|---|
| 原始 HTTP 失败被 correctness 漏记 | G4/G8 从 `raw/requests.jsonl` 重建 outcome 计数与失败明细，并与 correctness 逐项对账 | 伪造 `server_error` 原始样本、保留空 `oracleFailures` 时 G4/G8 FAIL |
| 未提交 API 源码未绑定 | runner 对 `apps/api/src`、`packages/*/src` 及运行相关 package.json 的文件集合和 SHA-256 逐项冻结；G0/G8 对当前源码复核，G9 对回归记录复核 | 改一项源码哈希时 G0/G8 FAIL |
| CLOUD cgroup 路径格式冲突 | `--cgroup` 接收 `/sys/fs/cgroup/...` 下已存在的绝对目录，runner 转成 `/proc/<pid>/cgroup` 使用的 `/...` 身份；API 在启动前由 runner 放入目标组，采样器留在观察组 | 模拟 cgroup 根路径归一化与越界负例；真实 Linux G5 仍待测 |
| 中断运行可误签 | G4 要求 `manifest.status=complete`、每个 runner 场景结果退出码 0 且 `incomplete=false`，driver correctness 也必须完整 | 中断 manifest/场景负例 G4 FAIL |
| G5 只检查第一份资源 | G5 对每个声明场景要求恰好一份可用资源文件，逐份核对归属、限额、OOM 与宿主读回 | 第二场景资源缺失或逃逸时 G5 FAIL |
| S13 名为读写但仅发送 GET | 固定主请求每五个 tick 发一个隔离库内 `POST /v1/performance-entries`，校验返回的写入 ID/日期；G4 要求原始 POST、成功数和负载计数一致 | 假 API 负载测试与短时真实 API 冒烟；旧纯读 S13 证据 G4 FAIL |

## 当前验证与证据边界

- `npm run phase6:test`：47/47 通过；`npm run typecheck`、`npm run check:scripts`、`npm run check:docs`、`npm run check:acceptance-matrix` 均通过。最终独占全量回归 `RAI_TEST_CONCURRENCY=2 npm test`：退出码 0，2609 tests / 2596 pass / 13 skipped / 0 fail，耗时 947,675 ms。完整日志保存在仓库外 `/tmp/rai-phase6-review-full-test-20261024.log`；旧 `evidence/regressions.json` 保留历史身份，不覆盖。本次全量回归不替代 DEV 场景重跑的 G9 证据。
- 隔离真实 API 冒烟根：`/Users/ta/rai-phase6-review-s13-smoke-v4-20261024`，D1、2 rps、3 秒；S13 6 个主请求与 3 个 health 请求，2 个写请求全部成功，0 oracle 失败，计数守恒。离线裁决 G0–G4/G8 PASS，G9 因此轮未生成同身份完整回归记录而 NOT_RUN，DEV 总签收 FAIL。该根在仓库外，**不构成 5 分钟 DEV 基线**。
- 原 `phase6-fix-dev-d1-s13` 的 990 请求均为读请求，现归类为修复前的热读诊断数据。S13 的后台任务混合仍未运行；本次短时写入冒烟也不证明 D2 或 CLOUD 稳态。
- [旧证据冻结清单](evidence/EVIDENCE-FREEZE.json) 和 [SHA256SUMS](SHA256SUMS) 用于保全历史文件，不能替代新代码的 run manifest。不要改写旧 raw 或旧 acceptance 来制造 PASS。

## 新运行要求

1. 用新 run 根重跑 DEV 场景，先生成 `report/summary.json`，再用当前 `verify.mjs` 离线裁决。新的 run manifest 必须含 `code.sourceFiles`；回归记录的 `codeIdentity.sourceFiles` 要与该 run 完全一致。旧运行的 G0/G8 失败是正确结果。
2. S13 完整重跑须包含读与写，并按协议目标补足 D2、后台任务和时长证据。当前 D1 短时结果仅用于实现冒烟。
3. CLOUD 目标须预建专用 cgroup 并设置冻结限额；传入其绝对目录，例如 `--cgroup /sys/fs/cgroup/rai/phase6-api`。runner 必须有写该组 `cgroup.procs` 的权限；API PID 进入目标组后才启动服务，采样器留在组外。G5 对每个场景资源文件裁决，不能以单场景读回替代整轮。
