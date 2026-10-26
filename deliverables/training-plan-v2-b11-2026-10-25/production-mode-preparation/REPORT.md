# B11 准备：生产写模式支持，实际启用延后

日期：2026-10-25（Asia/Shanghai）。**实际服务未启用、未重启、未部署、未迁移。四个部署默认开关仍为 `disabled`。**

用户先要求“启用新增写能力”，随后明确“先不开启，等部署最新版本的时候再开启”。
本轮完成生产模式的代码和部署准备，不把这条部署意图写成 G5/G6/G7 已验收；实际启用时继续核对环境、迁移、备份与运行结果。

## 改动范围

- `apps/api/src/server.ts`：配置命令、课程编辑、执行关联和自动发布各自接受 `production`；缺位/未知/`disabled` 关闭。
  所有 handshake/route/timer 使用同一组 enabled 状态，不改业务命令、处方算法、CAS、冻结历史或操作幂等。
- `production` 要求非空 `RAI_API_TOKEN` 及显式 runtime/主库/控制库路径；缺失时在打开数据库之前拒绝。
  `validation` 继续要求真实临时隔离路径和 loopback，混用 production 不能绕过它。
- `apps/api/test/phase5-training-plan.test.ts`：原 B04/B06/自动收敛场景分别在 validation、production 运行；production 使用测试新建的普通目录及合成库，验证不再依赖临时路径准入。
  增加生产无令牌、库路径缺失、validation/production 混用拒绝检查；关写后查询/重放保留且不追加业务行。
- `deploy/rai.env.example`：明确四个独立开关，全部保持默认关闭；新增生产设置及关闭说明。
- API 合同、闭环合同、实施计划、[D22](../../../docs/DECISIONS.md#d22-训练计划-v2-写能力准备生产模式实际启用随最新版本部署2026-10-25)、[运维说明](../../../docs/OPERATIONS.md#训练计划-v2-写能力部署时启用)及 B11 索引记录本轮决定和使用方法。

未修改任何实际环境文件、令牌、服务器服务或用户数据库。没有连接生产服务器。
能力注册表同步五处宣告条件/消费者文字说明；本轮不改变 API/DTO 版本和 iOS 实现；客户端继续按现有精确能力协商与持久 journal 消费。

## 启用与关闭

仅在部署最新版本并核对真实目标时使用以下设置；它们不是本轮实际执行结果：

```dotenv
RAI_TRAINING_PLAN_COMMAND_MODE=production
RAI_TRAINING_PLAN_SESSION_COMMAND_MODE=production
RAI_TRAINING_PLAN_EXECUTION_COMMAND_MODE=production
RAI_TRAINING_PLAN_AUTO_PUBLISH_MODE=production
```

各开关独立，配置/课程/关联写不隐式启用自动发布。保持默认关闭不妨碍原操作的只读查询和重放。
已有课程/覆盖/冻结历史继续读取；关闭开关不执行数据库降级。
需要课程/关联写时必须完成 payload schema 2 身份迁移、owner-ready 和 publication 支持，并有精确请求头。
配置命令的 `2` 与逐课/执行命令的 `1` 不能混用。所有旧退役路由保持 410。

部署流程和 sourceDigest 迁移要求见运维说明；不要将 `validation` 配置到实际服务，不回退到不能读新 schema 的旧二进制。

## 验证与证据

HEAD：`1b6a10b4769526b2930090e79860d2f93cc50318` / `main`，保留原有累计未提交修改。
本轮全量运行开始时的工作区及源码哈希见 [source-identity.json](source-identity.json)，不能只凭 HEAD 识别本次代码。
环境为本机 macOS x64 / Node v22.23.2；不是 Linux 2C2G。数据均为新建合成 fixture。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `node --import tsx --test --test-concurrency=1 --test-name-pattern=production apps/api/test/phase5-training-plan.test.ts` | PASS：4/4，106.74s，0 skipped | [production-http.log](logs/production-http.log) |
| `npm run typecheck` | PASS | [typecheck-final.log](logs/typecheck-final.log) |
| `npm run smoke:api` | PASS | [smoke-api.log](logs/smoke-api.log) |
| `npm run check:training-plan-single-writer` | PASS | [single-writer.log](logs/single-writer.log) |
| `npm run check:acceptance-matrix` | PASS | [acceptance.log](logs/acceptance.log) |
| `npm run check:scripts` | PASS | [scripts.log](logs/scripts.log) |
| `npm run check:package-boundaries` | PASS | [boundaries.log](logs/boundaries.log) |
| 合同注册 / 闭环合同定向回归 | PASS：8/8 | [registry-contracts-final.log](logs/registry-contracts-final.log) |
| `npm run check:ios-gates` | PASS（源码门禁，不是 Simulator/真机执行） | [ios-gates-final.log](logs/ios-gates-final.log) |
| `npm run check:docs` | PASS | [docs-final.log](logs/docs-final.log) |
| 实施计划源码行引用检查 | PASS：27 引用可解析；内容无基线 | [plan-refs-final.log](logs/plan-refs-final.log) |
| `RAI_TEST_CONCURRENCY=2 npm test` | PASS：2733 项 / 2730 通过 / 3 Windows 专属跳过 / 0 失败，1069.10s | [full-test-result.json](full-test-result.json)、[full-test.log](logs/full-test.log) |

逐命令 argv、开始/结束 UTC 与退出码见 [checks.json](checks.json)。最终合同 8/8、类型、iOS 源码门禁、文档及本文源码行引用检查均通过；引用无内容基线，未核对内容漂移。
[full-test-verification.json](full-test-verification.json)记录全量运行期间源码哈希一致；结束后仅修正注册表五处说明字段，
精确差异见 [registry-description-update.json](registry-description-update.json)，另跑合同/类型/iOS 源码门禁验证。没有改协议键、版本或执行逻辑。
最终源码哈希、全量统计、所有检查退出码及四个 disabled 默认值汇总在 [final-verification.json](final-verification.json)。
新回归在既有全量发现链中执行；未新增另一套运行器或 npm 脚本。没有远端 CI Run，未提交/推送。

生产定向的实际断言：

1. B04 六类逐课动作及拒绝不安全剂量、反复 refresh 保留用户修改、源日不复活；无令牌请求 401，缺协商头不准入。
2. B06 合成实际训练候选、人工确认、剂量/刺激分离、撤回、新进程关写后原请求仍返回原结果，逐表快照不增加。
3. 自动更新在真实服务的 60 秒 timer 下，确认关联后的输入差异收敛至 current，执行关联仍保留；不通过人工 refresh 代跑。
4. 四个 production 开关逐项无令牌时拒绝，缺少显式库路径拒绝；拒绝前后测试目录为空。
   混用 production 与绑定非 loopback 的 validation 仍触发原隔离拒绝。

首次尝试直接在普通目录生成 fixture，被原 fixture 的 temporary-only 护栏拒绝；日志保留于
[attempt-fixture-refused.log](logs/attempt-fixture-refused.log)，不算成功。最终保持 fixture 生成器护栏不变：
在系统临时目录生成且关闭合成库后，复制到测试新建的普通目录；不接收现有 runtime。
测试在成功/失败时清理这两个测试目录，不读取日常健康数据。

## 当前裁决

- 生产模式支持已经实现，定向场景通过；实际启用明确延后至最新版本部署。
- G5/G6 仍未签收：Linux/systemd/2C2G、主库分析发布窗口、真机 HealthKit/Watch、旧构建交错及回滚等缺口沿用实施计划。
- G7 不签收：没有实际部署、迁移、能力启用或线上核查结果。默认开关保持关闭。
