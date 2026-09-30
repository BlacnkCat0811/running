# iOS 审查与 Sol 执行方案

日期：2026-09-16  
审查基线：`bd1ee25` + 开始审查时已有的未提交 iOS 改动  
分工：当前会话模型主审、制定方案和复核；`gpt-5.6-sol` 执行三个互不重叠的修复包。

## 结论

本轮应优先修复**取消是否真正生效、写请求的版本保护、服务身份隔离**，而不是继续扩展皮肤或重写架构。现有 SwiftUI + Node API + TypeScript 评分核心的分工保留。

这是风险导向的源码审查，重点覆盖 API、NativeAppModel、ServerSession、Keychain、缓存、HealthKit 导出/同步、WorkoutKit 桥接、入口生命周期及测试脚本；不等于所有视图逐行审计或真机验收。已有的能力卡、校准状态和视觉验收改动不回滚，不将其计为本轮成果。

## 本轮执行结果

| 问题 | 结果 |
|---|---|
| F1：健康同步取消 | 已由 Sol 修复；真实任务所有权、查询停止、后台导出取消、瞬态 ZIP 清理、压缩循环中断及场景状态修正 |
| F2：无版本生成 | 已由 Sol 修复；读取失败不生成，写入前验证请求归属 |
| F3：旧请求清理新状态 | 已由 Sol 修复；三个课表操作使用独立请求 ID，配置切换清理旧状态 |
| F4：探测结果跨配置 | 已由 Sol 修复；配置/监控代次与取消状态共同守卫 |
| F5：遗留 Token 跨服务 | 已由 Sol 修复；不再自动使用无来源证据的遗留 token |

**兼容性提醒**：仅保存旧版无作用域 Token 的安装需要重新输入凭据。已有按服务保存的 Token 保持可用；遗留 Keychain 项未被删除。这个取舍是为了避免在无法判断原服务时将凭据发给错误服务器。

变更尚未提交。后文“后续优化路线”是下一轮建议，不包含在本轮已完成项内。

## 已确认的问题与验收要求

### F1 · P1：健康同步“取消”没有取消实际工作

**原始证据**

- `HealthKitSync.swift` 声明 `syncTask`，但从未将实际同步任务赋给它。
- `cancelSync()` 调用的是这个空句柄，随后只改 `phase/message`。
- 导出与 multipart 制作使用独立 `Task.detached`，未建立取消传播。
- HealthKit 查询通过 continuation 桥接，没有取消时停止查询的连接。

**影响**：场景退出或用户取消后，读取/导出可能继续，后续还可能上传或发起导入；界面给出的承诺与实际行为不一致。

**执行方案**

1. 由同步对象持有真实任务；保持单任务运行，取消清理完成前不放行下一次。
2. 调用方取消、显式取消、后台退出都传递到实际任务及导出工作。
3. 在上传、导入和成功水位推进前检查取消；已发送的服务端工作不声称能够撤回。
4. 保留取消时的可恢复 ZIP/任务记录，迟到进度不能覆盖“已取消”。
5. `RAIApp` 只在 `.background` 取消，不因授权弹窗引起的 `.inactive` 误取消。
6. 使用可在 macOS 上运行的生产取消辅助逻辑测试；真机验证另列。

### F2 · P1：获取目标版本失败后仍生成课表

**原始证据**

- `NativeAppModel.regenerateWeeklyPlan()` 用 `try?` 获取 goals；失败后仍发送 `expectedRevision: nil`。
- 等待 goals 时若更换配置，`isCurrent()` 不成立只会跳过赋值，原逻辑仍继续 POST 到原服务。
- `apps/api/src/server.ts` 的 `runWeeklyPlanGeneration` 仅在 `expectedRevision != null` 时比较客户端版本。

**影响**：绕过客户端看到的目标版本校验；在用户已经切换服务器后仍可能向旧服务器发起生成。服务端自身写入阶段的版本保护仍在，不应描述为“服务端完全没有并发保护”。

**执行方案**

- 无有效 revision 不写入；读取失败提供可重试提示。
- 读取后、写入前检查请求所属配置及取消状态。
- 测试断言：读取失败、取消、切服都不产生 POST；正常请求体必须带 revision，409 仍正确呈现。
- 修正原测试中“goals 返回 503 但生成成功”的错误成功前提。

### F3 · P2：旧请求结束会清掉新请求的忙碌状态

**原始证据**

- `lockNextSession`、`refreshWorkoutPlan`、`regenerateWeeklyPlan` 使用无条件 `defer` 清理布尔标志。
- `clearPresentation` 重置部分 loading，但未重置锁定状态与课表提示。

**影响**：切服后新请求正在运行，旧请求结束却让按钮提前恢复可点；另一条路径则可能继承旧请求的忙碌状态。

**执行方案**

- 忙碌状态归具体请求/配置所有，旧请求不能释放新请求的状态。
- 清理展示时同步清理旧配置提示。
- 用延迟响应复现新旧请求交错，而非只检查最终返回值。

### F4 · P2：旧服务器探测污染新配置的连接状态

**原始证据**

- `ServerSession.probe()` 在 `await session.data` 后直接更新 `isReachable`、失败计数、`lastError` 和 `reloadToken`。
- 没有校验探测发起时的配置；监控停启也未建立结果代次隔离。

**影响**：切换 URL/token 后，旧请求的成功或失败可覆盖当前服务状态；A→B→A 也不能只靠 URL 相等识别。

**执行方案**

- 配置变更与监控停启引入代次失效。
- 对成功和失败都校验归属，取消不显示网络故障。
- 注入独立 URLSession/UserDefaults，以 URLProtocol 和 Keychain 替身验证，不访问用户凭据。

### F5 · P1：遗留 Token 可在重启后迁移到另一个服务

**原始证据**

- `ServerSession.init()` 在当前服务的 scoped token 为空时回退 `Keychain.loadToken()`，再保存到当前 URL。
- 旧的无作用域 token 没有退休或绑定一次性的迁移目标。

**复现条件**：存在旧版无作用域 token；首次在 A 迁移；切到 B（其 token 为空）；重启。旧逻辑会把 A 的遗留凭据复制给 B。新安装没有该遗留凭据时不触发。

**执行方案**

- 遗留迁移只能绑定有可信证据的原始 origin，不可重复向当前任意 URL 迁移。没有来源证据时应停止自动迁移、要求重新输入；不能将“升级时当前配置的 URL”冒充凭据来源。
- 用户清空 token 后不能被遗留值复活。
- 迁移保存失败不得误删唯一凭据；用替身测试失败和重启分支。

## 已下发给 Sol 的修复包

| 包 | 文件边界 | 验收 |
|---|---|---|
| A：取消链路 | HealthKitSync、HealthKitExport、RAIApp、必要的取消辅助类和独立测试 | 单任务、取消传播、停止后不推进后续阶段 |
| B：模型并发 | NativeAppModel、ModelRegression | revision 必填；迟到请求无越权写入/状态覆盖 |
| C：服务身份 | ServerSession、独立 session 回归 | 配置代次、监控停启、遗留 token 单 origin 迁移 |

共同限制：不修改 Web 响应式代码、不重写评分算法、不新增 HealthKit 写入/后台投递，不操作真实健康数据或生产数据库，不自动提交。

## 后续优化路线（不与本轮修复混在一起）

### 1. 同步持久化一致性

`SyncTaskStore.save` 出错仅记录日志；`HealthKitSync.loadTask` 优先读取 SQLite，其次 UserDefaults。若 SQLite 保留旧任务而备用副本更新成功，可能选中较旧阶段。下一轮应让写入返回结果，为任务加递增版本并统一选择最新有效副本，做写入故障/重启恢复测试。不要只增加一条日志就宣称恢复可靠性已闭环。

### 2. 首屏与缓存性能

`CacheStore` 在 MainActor 上进行 JSON 编解码、SQLite 读写和淘汰。大路线/时序数据存在主线程负担，但本轮未测得具体卡顿数值，不给出虚构的性能提升比例。

建议先用 Instruments 测首屏、长跑路线打开、缓存恢复；再把缓存 I/O 和编解码移入独立 actor，主线程只发布展示状态。验收需比较冷/热启动、峰值内存、主线程耗时，并保留作用域隔离。

`refreshAll` 的可执行课表和训练列表在核心四面板之后依次请求，可在测量后改为有界并发/独立呈现，避免单个慢面板延迟其他成功数据。不能以“并发更多”替代逐面板错误和新鲜度说明。

### 3. 缓存新鲜度与离线语义

目前 `lastCacheUpdate` 取多个缓存中的最新时间，且写缓存的返回时间不代表持久化成功。下一轮把“服务已获取”“缓存已保存”“各面板更新时间”分开；训练列表单点失败不应直接等同于所有业务数据离线。

### 4. 课表映射完整性

`WorkoutKitBridge.customWorkout` 对不支持的步骤采用 `compactMap`；告警不支持时也可静默丢弃。需要制定明确的“整日拒绝”或“可解释降级”规则，避免部分恢复步骤被去掉后仍把整个课表报为完整成功。先通过 SDK 能力替身构造不支持分支，再决定策略；本轮没有真机证据证明正常课表实际触发。

### 5. 视图拆分与可访问性

两个主要视图文件各约 2,500 行。按 Today / Workouts / Plan / Analysis / Settings 拆分视图，保留现有皮肤和共享业务规则；先建立原生视觉基线，再进行纯结构重构。对较大的辅助字体、VoiceOver 图表摘要和错误重试路径单独验收，不以 Web 窄屏测试替代原生 iOS 验证。

## 验证记录

- 审查开始时 `bash apps/ios/tests/run-model-tests.sh` 通过；其通过不代表上述未覆盖问题不存在。
- 本机检测到 Xcode 26.5 与已有 Pods，可进行完整 workspace 编译；不能沿用旧文档里“只能替身类型检查”的环境结论。
- 第一轮完整 workspace Debug 模拟器构建通过。已有高德 umbrella header 与 WorkoutPlanMapper actor-isolation 警告，不能表述为“零警告”；后者建议在开启更严格 Swift 并发检查前集中治理。
- 主审反向验证：将新增 ModelRegression 与 HEAD 原版 NativeAppModel 在临时目录编译运行，确实在 `generation fails closed when the goals revision cannot be read` 断言失败（退出 132）。没有改回工作区文件；证明新增测试能抓到旧行为，而非仅与修复一起变绿。
- 主审反向验证：在临时副本移除 `isCurrentProbe` 守卫，新 session 测试对迟到成功/失败、A→B→A 与取消后发布均报失败（退出 1）。
- 主审额外验证：正常 StoredZip 生成后用 Python `zipfile` 解包，内容、CRC 和中文 ZIP 条目名通过；没有只测取消而遗漏正常压缩路径。
- `run-model-tests.sh` 已追加 session 与健康同步回归入口，新增测试不再是需要手动发现的孤立脚本。
- 健康取消自动测试覆盖的是生产任务所有权/取消辅助类与 StoredZip；“上传/水位闸门”用辅助逻辑测试加调用点源码复核，不是实际 HealthKit 上传端到端测试。
- 主审整合后 `bash apps/ios/tests/run-model-tests.sh` 全部通过，包含原有四组回归与新增 session/健康同步回归。
- `bash apps/ios/tests/typecheck-ios.sh` 通过：39 个文件；4 个高德相关文件由下面的完整 workspace 构建覆盖。
- 最后一次完整 workspace 构建 `BUILD SUCCEEDED`：Debug、generic iOS Simulator、`CODE_SIGNING_ALLOWED=NO`。完整构建发现的本轮凭据闭包 actor 隔离警告已退回 Sol 修正并重新构建验证；不改变前述第三方/基线警告的记录。
- `git diff --check` 通过。没有改动 API、共享 TypeScript 包或 Web，因此未运行 Web/响应式 E2E。
- 真机授权、锁屏中断、HealthKit 读取/恢复上传、Apple Watch 排期未在本轮自动执行；不能以编译或模拟器替代这些验收。

本机验证日志目录：`/tmp/rai-ios-review-20260916/`。重点文件：`regressions-final.log`、`session-verified.log`、`typecheck-verified.log`、`build-verified.log`、`model-mutation.log`、`session-mutation.log`。
