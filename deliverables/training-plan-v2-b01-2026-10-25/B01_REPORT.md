# B01：训练计划 V2 合同与基线记录

日期：2026-10-25（Asia/Shanghai）。当前状态：**B01 / G0 已验收**；S00-01–04 已验收，B02–B11 未开始。

## 范围与代码身份

- HEAD `1b6a10b4769526b2930090e79860d2f93cc50318`，分支 main，未提交、未推送。
- 开始时已有 README.md 修改和未跟踪的实施方案；保留原改动。原始身份/源码 SHA256 见 baseline-identity.json。
- 本批仅 S00-01–04 / B01。新合同是后续实现规范；未实施 B02 新存储/迁移、B04 路由或原生编辑、关联/自动发布。
- 生产迁移/能力启用/部署：未执行。新增能力在 production 和 validation 均未宣告。

## 实现与映射

| 任务 | 文件与结果 | 验证 |
| --- | --- | --- |
| S00-01 | 闭环合同 §7 列当前入口的 owner/scope/事务/能力/重放；基线源码身份已归档，特别区分主库反馈事务与控制库发布 | 全量 2626 tests：2623 PASS / 3 SKIPPED / 0 FAIL；single-writer 0 违规 |
| S00-02 | training-plan-closed-loop.ts + 闭环合同 + D21；固定身份/保护/完成/关联/候选窗口/null/迁移；不改变午夜依从性 | 最新合同/registry/真实 API 定向 13/13 PASS |
| S00-03 | HandshakeResponse、registry、RaiHandshake；四个能力精确判断、缺位/未知关闭且不放行 legacy | 22 组 TS/Swift 能力矩阵 PASS；真实 validation/disabled 即使精确请求也不宣告新能力；Swift 统一读合同 118 项通过，含 GET method/path/header/无写 body |
| S00-04 | server/TS/Swift 过时注释与 API/RUN_COACH 文档口径；方案状态更新 | 链接 0 问题、26 个行号 0 越界/空行；无内容基线，内容漂移未核对 |

新路由的 method/path/body 当前由合同和 fixture 固定；**没有实现新 transport 请求或运行新路由**，不能当 B04/B05 API 贯通。
旧 Swift v2 解码器忽略可选扩展的测试不等于新 DTO 字段已接入缓存/序列化，后者仍属 B02。
旧偏好 fixture 证明保存/读取，不证明生成消费等价，B03 仍须实现并验证。

## 环境与隔离

macOS 26.6.2 / x86_64，6 个逻辑 CPU、16 GiB 内存，Node 22.23.2，SQLite 3.51.3，Xcode 26.5（17F42）。
所有新增 fixture 均为 synthetic 身份/处方/跑步。新增测试仅内存解析，无数据库/网络；
既有全量套件沿用各测试的临时 runtime/主库/控制库/epoch/随机端口隔离。
未打开用户日常 var 主库/控制库，未执行同步。Linux/Simulator UI/真机/Watch 本批未验收。

## 执行记录

- `RAI_TEST_CONCURRENCY=2 npm test` → baseline-tests.log，退出 0；2626 tests / 2623 pass / 0 fail / 3 skipped，1145.173 秒。
  三个跳过均为 Windows 专属：path aliases、locked rollback、prediction process tree；macOS 未验证这些平台语义。
  本次运行采用开始时发现的既有测试集合。
  测试期间仅追加合同/fixture、能力判定与文档/注释；这是 dirty 工作区回归，不能只以 HEAD 声称为干净提交基线。
  新增测试不在开始时发现集合，另由下述定向运行补验。
- `node --import tsx --test --test-concurrency=2 apps/api/test/training-plan-closed-loop-contract.test.ts apps/api/test/handshake-registry.test.ts`
  → contracts-tests.log，8 tests / 8 pass，退出 0。首轮 test 源码换行导致 TS transform 失败，修正后重跑；失败日志保留为 contracts-tests-attempt1.log。
- `npm run typecheck` → typecheck.log，退出 0（新增测试前）；最终版本另跑 typecheck-final.log。
- `npm run test:ios` → ios-tests.log，冻结源码后完整聚合重跑退出 0。
  2026-10-25 10:32:56–10:46:11（Asia/Shanghai，日志创建/最终写入时间）。
  99 个 iOS 源码通过类型检查；MapPrivacy.swift、RAIApp.swift、TechRouteView.swift 因高德 SDK 按现有规则排除，未以本次检查验收。
  模型、Publisher、统一读合同 118 项、排期 88 项、设备上下文 35 项、TrainingPlanStore 60 项、
  同步/恢复/缓存/展示及聚合结构门禁通过。这里的设备上下文是纯逻辑，不是物理 Watch 送达证据。
  首轮类型检查已通过，但纯逻辑编译期间我又修正 APIModels.swift 注释，编译器以 input modified 拒绝；
  原始失败保留在 ios-tests-attempt1.log。冻结全部源码后从聚合入口完整重跑，不能把首轮记成通过。
- `npm run check:ios-gates` → ios-gates.log，退出 0；11 支跨平台判据通过，2 支需 mutation/Simulator 条件的入口明确跳过。
- 最新 `npm run typecheck`、`check:training-plan-single-writer`、`check:acceptance-matrix`、
  `check:package-boundaries`、`check:scripts`、`git diff --check` → final-gates.log，退出 0。
  单写者 0 违规；矩阵 80/80 引用（仅标题覆盖）；16 包/31 src 边；18 package.json / 117 script。
- `contracts-final-tests.log`：Node + tsx，文件并发 2，13 tests / 13 pass / 0 fail / 0 skipped，退出 0，135.630 秒。
  包含真实认证 API、managed 生命周期、重启/关闭准入及新增能力不宣告；原 410/404 区分、已提交操作重放仍通过。
- `verification-source-freeze.json`：冻结 996 个源码/测试/script 文件 SHA256；最终验收前再次校验。
  `baseline-discovered-tests.json`：基线入口实际发现的 313 个既有文件；新增合同测试单独运行并由正常发现链覆盖未来全量。
  `current-discovered-tests.json`：当前发现链含新增合同文件，共 314 个；`change-manifest.json` 标记原有用户文件并记录实际改动摘要。
- 冻结源码后的合同复核 `frozen-contract-tests.log`：8 tests / 8 pass，退出 0；未重复运行没有新增行为变化的 API 进程场景。
- `docs-final-check.log`：107 文档 / 817 本地链接 / 3 锚点，0 问题；方案行号 26 处、0 越界/无法解析、0 空行。
  没有 linerefs 内容基线，故内容漂移未核对；未生成/覆盖历史基线来制造通过。
- `verification-index.json` 保存关键原始命令、日志创建/最后写入 UTC 与上海时间、退出码、并发、Node 统计和日志 SHA256。
  文件系统时间包含 wrapper 开销，Node duration_ms 为测试运行器测量；不是高精度逐测试性能验收。
- 最终 996 个冻结源码/测试/script 文件 SHA256 全匹配；两份修改的 Swift 为 i/lf w/lf。

## 验收与后续

G0 已签收：合同冻结、旧合同区别、单位/null、共享夹具、当前测试及平台边界均具备证据。
这不是 C01/H01–H07 的业务关闭：稳定 ID、未来保护、迁移、编辑、实际关联、自动发布仍按后续批次实现。
Linux、Simulator UI、iPhone 12 Pro Max、配对 Watch、新旧真实构建交错和回滚演练未执行，G1–G7 未签收。
GitHub CI Run/job：本批未推送、未触发远端运行，未验证。性能、2C2G 资源和收敛预算未实测。
按文档 B01 停止点收口，下一批 B02（S01-01/03/05），不提前做 B03/B04 或生产操作。
回滚本批只涉及声明/客户端能力判定/文档，没有数据库升级或新格式数据；已知/未知 pending 的既有操作恢复路径未改。
