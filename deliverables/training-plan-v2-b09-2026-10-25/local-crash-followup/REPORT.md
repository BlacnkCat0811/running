# B09 续推：本机真实进程退出与恢复

日期：2026-10-25（Asia/Shanghai）。范围：S05-01 / T22、T28 的本机补充。

**16/16 真实子进程 SIGTERM/SIGKILL 用例通过；G5 仍阻塞。** 用户确认暂时没有隔离 Linux 环境。
本轮没有修改生产业务源码、执行生产迁移、部署或启用能力。真机、配对 Watch、systemd、2C2G 和分析发布后的崩溃窗口不在本轮通过范围内。

## 代码与环境

- HEAD：`1b6a10b4769526b2930090e79860d2f93cc50318`，分支 `main`；工作区已有 B01–B10 累计未提交修改，全部保留。
- 源码身份见 [code-identity.json](code-identity.json)：全量后端回归启动时的 API、测试、contracts、存储包逐文件 SHA256 与 dirty 清单；HEAD 不能单独代表本轮源码。
- 本轮新增：`apps/api/test/training-plan-closed-loop-crash.test.ts`、`apps/api/test/helpers/training-plan-crash-child.ts`；文档仅更新实施计划及 B09 记录。
- 环境：macOS x64（6 核 / 16GiB）、Node v22.23.2、SQLite `node:sqlite`；详细版本见 [environment.json](environment.json)。不是隔离 2C2G 主机，没有使用 Linux/systemd 替身来签收 G5。
- 隔离：每例仅在系统临时目录 `rai-b09-crash-*` 新建控制库，使用固定合成课程及实际跑步摘要；测试结束关闭子进程并清理。未打开用户 `var/rai.sqlite`，不依赖任何 API 地址、token 或健康数据库环境变量。

## 任务 → 文件 → 断言

| 任务 / 问题 | 测试落点 | 实际通过的断言 |
| --- | --- | --- |
| S05-01 / T22：真实退出后的业务原子性 | 新 crash test + child driver | 在全部业务写点和 operation result 落入事务后、真实 COMMIT 前停住；父进程杀子进程；新进程逐表比较种子快照，业务行完整回滚，原操作 `notFound` |
| S05-01 / T28：COMMIT 成功后断响应 | 同上 | 真正执行 COMMIT 后、业务结果返回和 guard 清理前停住并杀进程；新进程查询得到 `committed` 及原结果；全部业务行等于提交时快照；原请求重放零写 |
| C01/H01：课程改期恢复 | `session` lane | 同一 sessionId 移到 10 月 29 日、保留用户保护；未提交旧预览因进程密钥变化而拒绝，重新预览后重试；已提交旧预览按原 operationId 重放 |
| H03/H04：执行关联恢复 | `execution` lane | 同一合成跑步只关联当前课，completed/confirmed；8.2km 对 8km 剂量 met，刺激 not_assessable；冻结处方 revision 1、执行历史只追加一次 |
| H02：计划刷新及持久评估 | `refresh`、`evaluation` lanes | 内容刷新：state/历史/投影/评估游标/operation 一起提交；no-change：只推进评估游标及 operation，不增加课程或内容历史，不增加 stateRevision |
| S05-01：快速重启与 WAL | 全 16 例 | SQLite integrity_check 为 ok；退出遗留已提交 pending marker；新进程启动立即清理 marker，保留 epoch；提交结果重放不触发新 publication |

四条 lane × COMMIT 前/后 × SIGTERM/SIGKILL = 16 项。子进程的测试专用 `DatabaseSync.exec` 包装只插入屏障，仍调用原始 COMMIT。
父进程等待屏障文件后向具体子 PID 发信号，并断言 OS 实际退出信号；未使用概率延迟猜测 COMMIT 时机。
屏障只写入合成数据的临时文件；30 秒内未被终止会明确失败，不会自动放行提交。

新进程恢复与查询直接调用现有 store/command 服务，使用真实磁盘 SQLite/WAL；本轮不是 HTTP 断链或完整 API 启停测试，
也没有证明主库分析发布与控制库计划发布之间的 T27 窗口。真实 server/systemd、文件替换、2C2G 多轮稳态仍需目标环境。

## 执行与结果

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node --import tsx --test --test-concurrency=1 apps/api/test/training-plan-closed-loop-crash.test.ts` | PASS：16/16，46.36s，0 skipped | [crash-tests.log](logs/crash-tests.log)，含每例 operationId、stateRevision、逐表行数及恢复前后快照 SHA256 |
| `npm run typecheck` | PASS：exit 0 | [typecheck.log](logs/typecheck.log) |
| `RAI_TEST_CONCURRENCY=2 npm test` | PASS：2729 项 / 2726 通过 / 3 Windows 专属跳过 / 0 失败，2000.55s | [full-test-result.json](full-test-result.json)、[full-npm-test.log](logs/full-npm-test.log) |
| `npm run check:training-plan-single-writer` | PASS | [single-writer.log](logs/single-writer.log) |
| `npm run check:acceptance-matrix` | PASS | [acceptance.log](logs/acceptance.log) |
| `npm run check:scripts` | PASS | [scripts.log](logs/scripts.log) |
| `npm run check:package-boundaries` | PASS | [boundaries.log](logs/boundaries.log) |
| `npm run check:docs` | PASS：118 文档 / 932 本地链接 / 0 问题 | [docs.log](logs/docs.log) |
| `node scripts/check-doc-line-refs.mjs docs/TRAINING_PLAN_V2_CLOSED_LOOP_IMPLEMENTATION_PLAN.md --problems-only` | PASS：27 引用可解析 / 未越界；无内容基线，未核对内容漂移 | [plan-line-refs.log](logs/plan-line-refs.log) |

小门禁原始 argv、开始/结束 UTC 和退出码见 [checks.json](checks.json)。引用检查无内容基线，不能读作内容零漂移。
[discovery.json](discovery.json)确认现有 `npm test` 发现 328 个文件并包含新 crash test，child driver 不被当作测试单独运行；不新增第二套清单。Windows 明确跳过真实 POSIX 信号测试并说明原因；macOS/Linux 实际执行。
全量命令时间为 2026-10-25 21:45:14–22:18:37（Asia/Shanghai），文件并发 2。三项跳过分别为 Windows 路径别名、锁定文件的重命名、进程树终止，均保留原因，未算通过。
[verification-result.json](verification-result.json)汇总最终统计及 361 个源码文件哈希复核，运行期间无源码变化。
本轮没有 iOS 或合同改动，没有重复 Simulator/Watch 测试。远端 CI 未运行、未提交推送，不能把本机通过写成远端验证。

## 中间失败与修正

保留 [初始化失败](logs/attempt-1-fixture-fail.log)及 [快照比较失败](logs/attempt-2-snapshot-fail.log)，不作为成功证据。
构建 driver 时误用了移动后 revision 2 的 fixture，并过早绑定 owner，导致种子历史单调性校验拒绝；
改为初始 revision 1、完成受控迁移后绑定。跨进程 JSON 比较还暴露 SQLite 行对象的 null prototype 与普通 JSON 对象不同，
快照统一为普通对象后做逐字段比较，未删除字段或放宽业务断言。类型检查同时发现合成事实摘要缺少 updatedAt，已补齐。
这些均为测试夹具/驱动修正，未据此修改生产事务或绕过门禁。

## 验收与后续

- S05-01 的本机真实进程退出证据已补充，16 例通过。覆盖范围以本报告为准，不将其扩展为所有闭环故障窗口已完成。
- G5 仍阻塞：隔离 Linux 2C2G、真实 systemd、主库分析后退出与重启收敛、文件锁/替换及持续资源负载未验收。
- G6 仍阻塞：真机 HealthKit、iPhone 12 Pro Max/Instruments、配对 Watch、真实旧构建交错及兼容回滚未验收。
- G7/B11 未执行：需要 G6 及后续明确生产授权；本轮没有任何生产动作。
- 回滚边界：本轮仅新增测试与记录，无数据库 schema 或运行时行为变更；原 B01–B10 累计实现继续保留。
