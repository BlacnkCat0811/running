# SQLite 直接增量同步：无项目备份、无整库校验、无临时主库、无换库

日期：2026-10-12，Asia/Shanghai。审查源码基线：`7a6408a`。

**状态：用户目标已明确；本文件是完整实施设计，不表示改造已经上线。**
  
保留 SQLite，不引入 PostgreSQL 或 Redis；不修改 TypeScript 评分算法的领域语义。
  
范围为现有服务端、桌面 Web 和原生 iOS；不扩展冻结的窄屏 Web。

## 文档使用方式

| 内容                   | 对应章节      |
| -------------------- | --------- |
| 取消哪些耗时阶段、保留哪些安全措施    | 第 1–2 节   |
| 同库接收、分页、事务、路线与后台分析设计 | 第 3–10 节  |
| 外部备份边界、WAL、故障处理      | 第 11–12 节 |
| 实施顺序与回退策略            | 第 13 节    |
| 功能验收矩阵、性能标准、证据和发布门禁  | 第 14 节    |
| 当前实现与目标设计的区别         | 第 15 节    |

**交付原则：先确认本批原始数据已经持久保存，再异步更新分析；不复制或替换主库。**
  
下列验收项均为待实施后的通过条件，不是当前版本已经通过的声明。

## 1. 不可折中的产品要求

1. 所有普通健康增量，包括心率、睡眠、HRV、训练、路线、历史更正及显式删除，
     
   均不做项目级整库备份、全库完整性扫描、整库临时副本或正式数据库文件替换。
2. 不把“数据影响评分”“尚未建立快通路资格”“包较大”当作回退旧整库流程的理由。
3. 备份由服务器独立运维负责。应用不自动创建、验证、轮换、删除备份，
     
   不检查外部备份是否完成来阻塞同步。
4. 原始事实已持久接收与分析已更新是两种结果。原始接收成功不能等到分析完成才确认。
5. 重算失败不撤销已接收事实、不要求手机重新导出同一批；读取不能把旧分析标成最新。

### 1.1 明确取消的正常同步阶段

| 当前行为                                               | 目标            |
| -------------------------------------------------- | ------------- |
| `createCurrentBackup`、备份容量/保留策略                    | 不调用           |
| 主库/新库 `quick_check`、每次 open 全库 `foreign_key_check` | 不调用           |
| 主库 → backup → `rai.importing.*.sqlite`             | 不创建这类整库副本     |
| CLI 再次暂存/发布候选                                      | 普通同步不走该入口     |
| 每批完整审计 SQL / Markdown / JSON 重建                    | 不阻塞同步，移为按需功能  |
| 移动主库为 rollback，再 rename 候选为主库                      | 不调用，不改变主库文件身份 |
| 等待强制 `wal_checkpoint(TRUNCATE)` 才返回成功              | 不要求           |
| 每次模型发布后立即做重型历史清理                                   | 不阻塞接收或分析发布    |

### 1.2 保留的写入正确性，不是全库检查

- 本批格式、类型、作用域、哈希、日期和配额检查。
- 唯一约束、外键启用、事务、幂等、删除保护和关键写入回读。
- SQLite 正常 WAL 写入、COMMIT 及所需 fsync，禁止用 `journal_mode=OFF`
    
  或 `synchronous=OFF` 换速度。WAL 不是项目备份。
- 模型业务资格、数值/覆盖、删除贡献、尺度/epoch、谱系和版本发布检查。
- 数据库损坏时停止新写入并报告，交服务器运维处理；不自动隔离主库并创建空库。

上传 ZIP/XML/GPX、当前批解析缓存可以是受保护临时文件。
  
**它们不是整份主库副本，从不替换正式 SQLite。**

## 2. 当前实现为什么不能只删两处函数

现有入口：

```text
ImportWorker.run
  → createCurrentBackup / quick_check
  → 整库 copy 到 candidate
  → CLI incremental-import
  → compare candidate 与 previous
  → 必要时重算
  → audit
  → activateDatabase / checkpoint / rename / quick_check
```

目前只有受限 `data-only` 支持主库事务；混合评分批次仍走旧路径。

直接删除 `createCurrentBackup` 并返回 null，会改变 CLI 选择，误走新库 import。
  
直接把 CLI 的 `--database` 指向正式库也不行：

- parser、GPX、canonical 各自有 flush/BEGIN/COMMIT；
- `seedImportGenerations` 有全库补种和清空 issue；
- canonical nights 当前读全量段并删除/重建整张 canonical 表；
- 评分计算和写库混在同一个长期 writer 接纳范围内；
- 活跃分析读取部分会 JOIN 当前可变 workout，直接原始 upsert 后可能混合新旧事实。

**必须一起改事务所有权、分析输入版本、读模型和客户端成功定义。**
  
切换前可保留旧代码供隔离演练；正式启用新同步后，普通同步不得静默调用它。

## 3. 目标架构

```text
iOS：分页增量 → 持久批次 → 上传
                      ↓
API/解析 Worker：只验证、归一化本批，不扫描主库
                      ↓
主 SQLite 短事务
  - 当前批 Record / Workout / 路线版本
  - UUID source / alias / fact / tombstone
  - before/after 变更账目
  - raw_generation / analysis_dependency_generation
  - 持久接收回执 + 分析任务
                      ↓ COMMIT
iOS：显示“健康数据已保存”，提交本批游标
                      ↓
后台分析：固定输入版本、局部 canonical、特征/评分/checkpoint
                      ↓
主 SQLite 短事务：业务 gate + 版本比较 + 发布指针
                      ↓
UI：“分析已更新”；旧结果保持可读但准确标记状态
```

正常接收入口改为单一 `DirectSyncIngestWorker`。
  
原 `data-only` 不是永久独立安全通道：统一原始接收器判断是否需要分析，
  
不需要分析时完成接收，有依赖变化时原子登记后续任务。

### 3.1 不做的替代方案

- 不用“关掉备份但继续 copy 主库”假装完成目标。
- 不把全库校验藏在 worker、解析尾部、重启回调或最后成功确认里。
- 不为保留同步成功原子性，把整轮评分计算塞进一个分钟级写事务。
- 不恢复生产完整 shadow 双跑。
- 不通过清空 anchor、缩短读取历史范围、抽掉重要路线点或忽略删除实现提速。

## 4. 事务边界：本批事实和回执同库提交

### 4.1 提交前准备

在写事务之外完成本批：

- 上传路径安全、类型/协议、字节/点数配额、完整 payload identity 校验。
- XML/GPX 解析和归一化；路线须解析完整后才能替换当前可用版本。
- 产生不依赖当前主库可变状态的 normalized plan。

UUID 映射、别名碰撞、旧值、删除保护及实际变更判断，必须在事务内按当前库读取；
  
不能把准备阶段读到的旧值直接当提交依据。

### 4.2 普通有界批次的一个事务

```text
BEGIN IMMEDIATE
  读/校验 scope 与 batch identity
  若已有同内容 committed receipt，返回旧回执
  登记本批所有显式 source deletions，防载荷顺序复活
  对受影响实体做点查：
    保存被替代的历史 revision
    upsert 最新事实 / UUID 身份 / 来源快照
    执行显式删除或共享来源恢复
    登记 before/after 变更
  增加 raw_generation
  若影响分析，增加 dependency generation，登记 durable analysis job
  保存本批持久 receipt 与完成信息
  回读必要的事实、删除保护、账目、版本和回执
COMMIT
```

所有内部组件不能自行 COMMIT；局部保护只用受上层控制的 SAVEPOINT。
  
关闭连接、flush 和异常收尾都不得静默提交半批。

receipt、变更账目、分析任务及其权威恢复依据放同一个主 SQLite 事务。
  
`runtime.sqlite` 可继续存日志/上传过程视图，但不是唯一任务或成功依据；
  
不假设主库、runtime、control 三个 WAL 库能跨文件原子提交。

### 4.3 旧数据不触发整库初始化

- 缺少当前内容 hash 的旧行，按“本次碰到的实体”从已有属性计算/初始化，
    
  保存旧值并比较；不全库 seed generation。
- 解析/schema 合同不支持时提示升级或维护，不在普通同步中自动迁移主库。
- 既有 `data_only_baseline_contract` 不再作为普通原始接收能否进入直接路径的门槛。
    
  派生算法旧时登记后台分析，不要求先完成一次整库候选导入来“获得资格”。
- 所有历史主键、UUID 桥接及不可得信息边界保持，不重发明 stable ID。

## 5. 大批次、首次基线与路线

### 5.1 先让客户端产生有界增量

新 iOS 不一次 drain 全部类型再生成巨大包：

- 保留每页1000的 anchored query，限制单次导出总记录数/字节预算。
- 保存已完整读取页面的候选游标，服务端确认这一批后才提交。
- 仍有下一页时持久保存 `needsContinuation`，再发下一批；不把“导出过一批”
    
  当作 HealthKit 通知已全部处理。
- 删除-only 页面不是 EOF；锁屏、取消、授权不可读及缺少合法 anchor 不推进。
- 初次基线同样分批建立；会读取可见历史，但服务端没有整库副本或换库。
- 不恢复七天全历史重读；旧游标异常不静默从 nil 重来。

### 5.2 兼容旧客户端大包

对无法客户端分片的大包，服务器持久保存稳定分片计划：

- `(parentBatchId, partitionContract, chunkIndex, chunkHash)` 定义独立原子子批。
- 每个子批事务内保存其事实、账目和回执；已提交子批重试不重复写。
- 父批全部必要子批完成才给整体 committed receipt，才允许提交父批的完整 anchor。
- 大包父批不是一个物理事务；父批失败可保留已确认子批并从未完成片继续，
    
  不假称“父批所有片已经整体回滚”。
- 父批处理中明确 `partial_ingest`；分析不将不完整父批冒充最新完整数据。
- 全父批的删除/替换关系预先归一化，不能跨片遗失共享来源语义。
    
  实现时必须给替换、删除、恢复的依赖单元相同原子分片，或采用不可见 revision
    
  并在小事务标记父批可见；不能任意按 XML 行数切断关系。

大包不会自动回退整库候选，也不会重新读全量 HealthKit 来解决恢复。

### 5.3 路线只更新本条，不能发布半条

- 按 workout / route 身份建立 immutable `route_version`；
    
  points 关联版本，不先删除正在展示的完整路线。
- 小路线在一次有界事务发布。大路线点可分片写入主库中未发布的版本；
    
  完成点数/顺序/hash检查后才更新路线版本指针。
- 这只是当前路线的增量行，不是临时主库，不拷贝其它训练/路线。
- 配额拒绝继续按 ADR-004 落 pending，不以 invalid 清掉旧 points；
    
  真坏文件拒绝该版本，旧可用路线保持。
- 回执分别说明已保存记录、路线已完成/仍待补齐。客户端不能把本地 hash
    
  当服务端路线已导入证明。
- 若服务器持久承担 route 重试，必须保护被引用的源文件不被24小时未使用上传 GC回收；
    
  未持久承担的路线不能提前当作已接收。

## 6. 有界写入，不能让后台评分继续挡住同步

SQLite 仍保持一个可写者，不增加多 API 可写实例。
  
但**单写者不等于分析 worker 持有写许可直到 CPU 算完**：

| 阶段                     | 许可                 |
| ---------------------- | ------------------ |
| 解析/读取固定版本数据            | 不持有长期写许可           |
| 计算 canonical / 特征 / 评分 | 不持有写许可，在 Worker 运行 |
| 原始提交、候选分析行分块落地、最终指针发布  | 各自短写事务             |

重构现有 `TaskAdmissionScheduler` 的长期接纳范围：
  
分析任务调度与短写互斥分开；只在真正写入时接纳，接收优先，
  
同时给分析落地最小服务份额避免饿死。不要靠无限提高 `busy_timeout` 隐藏竞争。

所有重型 SQL 和 CPU 工作离开 HTTP 主线程。空队列不启动计算 Worker。
  
目标机器先保留单分析 worker、有限待办和有界内存；磁盘/队列压力时返回可重试背压，
  
保留客户端批次，不丢事实或确认错误成功。

## 7. 历史事实版本与分析输入

原始事实先更新后，不能再让计算读取不停变化的“当前表”。

建议采用**稀疏历史**而不是每批快照整库：

- 当前行记录有效起始 generation。
- 仅更正/删除的实体把旧内容保存在 history，含 valid-from/to、事件时间与可得时间。
- 未变的百万行不复制。
- 输入 `FactsReader(G)` 从当前行和稀疏历史恢复固定 G 的事实。
- 旧数据的可得时间未知时保留 unknown/既有保守界，不用样本 creationDate
    
  伪造旧入库时间。
- workouts/statistics/events/profile/canonical 依赖及路线版本同样有明确版本关系，
    
  不能只给 health_records 加历史列就宣称分析冻结完成。
- 稳定训练身份保留。删除优先留 inactive/tombstone 身份或历史引用，
    
  不让 raw FK级联删掉不可变 release所需的证据和路线。

分析 job 必须绑定：

```text
target_raw_generation
target_dependency_generation
override/config revisions
parser/canonical/feature/model versions
timezone/asOf
expected_incumbent_release
dirty entities / before-after times
```

不长期保持一个读事务跨越几分钟 CPU计算，避免 WAL被长期读者钉住；
  
按固定逻辑版本分块加载后释放连接。

## 8. 局部 canonical 与重算

### 8.1 基于变更账目，不比较两个整库

每批记录 before/after，而不是 ATTACH previous整库做差：

- 新训练/更正/删除：重算受影响的重复组及其邻接重叠训练。
- 路线补齐：影响本训练特征、必要的后续时间线。
- 心率/跑速：根据前后区间定位相交训练与参考窗口。
- 睡眠/HRV/RHR：根据前后夜、午睡、来源切换及参考窗口更新恢复事实。
- VO2Max、校准、全局配置等依赖可触发后台全历史逻辑重算。

正常批次不会因“需要全历史模型计算”触发数据库 backup/copy/swap。

### 8.2 canonical 也不能悄悄全量做

- `canonicalizeNights` 改为受影响夜/午睡及必要相邻窗口，
    
  不再每批读取全部睡眠段、删除和重建整表。
- 保持来源优先级、跨夜并集、同内容原可得时间、HRV稀疏/缺失语义。
- 训练匹配使用当前 dirty times、稳定 ID和邻接组；不全量重建会话身份。
- 只有明确的算法升级/历史修复 job 可以后台重建较大范围，用户可看到真实原因和进度。

### 8.3 复用评分，不降低业务 gate

沿用当前 TS feature/scoring/readiness/load/zones 模块，兼容checkpoint与前缀复用。
  
不删除尺度、校准、删除贡献、数据覆盖、无效值及发布谱系检查。
  
这些检查针对当前候选分析结果，不是扫描整个主数据库文件。

## 9. 发布的是分析版本，不是数据库文件

计算结果写入同库未发布的 feature/model/metric run；
  
旧 active release保持可读。完成结果校验后，短事务只更新发布指针和任务状态。

### 9.1 解决当前“旧分数 JOIN 新训练”的读模型

现有训练读取部分 JOIN 当前 workouts/training_sessions，必须同时改造：

- 已发布分数、距离/时刻、canonical选择、route version等使用 release冻结输入或相应历史版本。
- 当前事实列表可以及时显示新增/更正，未分析字段是 null/待分析，不配上旧分数冒充一致。
- 已删除训练及时隐藏/撤销当前展示；旧run仍作为历史证据，相关汇总明确待更新。
- API 明确区分 `currentFacts` 与 `publishedAnalysis`，不能只改一个“更新中”文本，
    
  底层仍把两个版本拼在一起。
- 今日建议/锁课/手表导出必须检查依赖新鲜度，不能从旧数据授予“最新可执行”状态。

### 9.2 避免新批次让分析永久无法发布

- 原始 generation 与评分依赖 generation分开；不影响分析的变更不阻止分析发布。
- 相同作用域待办合并 dirty范围和最新目标，保留每个原始批次回执。
- 指针比较 expected active、防止迟到 worker覆盖更新 release。
- 若新相关数据已到，完成的旧目标可成为“最新已计算历史视图”，但标记仍待更新，
    
  不当成当前权威建议；继续计算新目标，不能无限丢弃所有完成结果。
- override/config改变必须重新验证适用性，不能改写历史候选的输入标签。

缓存 key包含 scope、原始/发布版本、相关控制修订和业务时点。
  
不能因候选行/进度更新频繁写入就不断重建所有昂贵读取；
  
权威失效依据是相应发布/事实版本，而非“数据库任意一页写过”。

## 10. 回执、失败与 iOS状态

### 10.1 状态合同

```text
ingestStatus: receiving | validating | applying | committed | rejected
analysisStatus: not_required | queued | running | published | failed
rawGeneration / dependencyGeneration / publishedReleaseId
receiptId / parentBatchId / routeReceipts
```

| 情况                | 行为                                       |
| ----------------- | ---------------------------------------- |
| COMMIT前解析/写入/校验失败 | 当前原子批回滚，游标不推进                            |
| COMMIT后回复丢失       | 查询同scope/batch持久receipt，返回同一成功           |
| raw已提交，分析失败       | raw保留；只重试分析，不重传HealthKit                 |
| 重启丢进度             | 从主库receipt/analysis jobs恢复，不只依赖runtime日志 |
| 提交前用户取消           | 回滚当前原子单元，保留未确认批次                         |
| raw提交后用户取消分析      | 不宣称raw已撤销；只停止分析，保留待更新提示                  |
| 系统切后台             | 保存可续接，不伪装用户取消                            |
| 同batch不同payload   | 冲突拒绝，不覆盖旧回执                              |

### 10.2 兼容升级

- handshake新增可选 raw receipt能力，不随意改变 scope或datasetEpoch。
- 新 iOS看到 durable committed receipt即可提交相应游标，分析另行跟踪。
- 老客户端的单一 succeeded不能被解释成“最新分析已完成”；
    
  保留旧等待含义或通过兼容响应等待分析终态，但存储始终走新直接路径。
- `SyncTaskState`新增字段必须 Optional、显式 decodeIfPresent；保留旧ZIP、batch和续传身份。
- 所有恢复分支都处理相同receipt规则，不能只改新建同步入口。
- 连续分页尚未 drain 完时，不清空后台待办意图。

### 10.3 用户文案

```text
正在读取健康增量
正在上传本批数据
正在保存新增与更正记录
健康数据已保存，分析更新中
分析已更新
健康数据已保存，分析更新失败，可重试分析
```

移除普通同步中的“备份并校验现有数据”“临时数据库增量同步”
  
“验证完成正在切换本地数据库”。更新的是服务器事实和分析版本，不能误导为手机换库。

（2026-10-14 实施注记）以上六句受控文案已由 iOS 的 `DirectSyncCopy` 单点落地；三句旧语义
（备份/临时库/换库）已从客户端与服务端两侧源码移除，由 `check-direct-sync-status-copy.py`
的双端哨兵钉住；服务端失败一律带稳定码（`ImportJobResponse.failureCode`），
不再存在“静默回退到慢链路”的中间态。

### 10.4 回执计数：让“这批什么也没带来”由回执自己说（2026-10-18）

2026-10-18 生产诊断（`output/diagnosis-2026-10-18-run-partial/lane-api.md` §2.5 / §3）的缺口是
**回执只承诺到批次**：一批补了 1 条 PhysicalEffort 与一批补了整条 HR 序列，回执长得一模一样，
客户端只能把“上传队列空了”读成“记录齐了”。

服务端在直连回执（`summary.directSync`，持久键 `rai.applied-import.<jobId>`）里**追加**一个可选块：

```jsonc
"records": { "parsed": 4500, "inserted": 622, "unchanged": 3878 }
```

- `parsed` = 本批 XML 的 `<Record>` 条数；`inserted` = 其中新增行数；`unchanged = parsed - inserted`。
- 显式删除（manifest `deletedRecords`）不在 `parsed` 内，三者不互相包含；`records` 描述**结果**，
  不描述成本（重复记录仍然逐条走完身份/账本管线，见 lane-api §4.3）。
- 回执仍然是**写入时刻的凭证**（§8.5：消费者不得改写）；`records` 只描述这一批。
- 老服务端/老车道省略本键；客户端必须按“未提供”处理，不得当成 `0`。

### 10.5 跨批新鲜度：`GET /v1/workouts/:id/freshness`（2026-10-18）

回执是批次的，用户看的是训练。服务端新增只读端点，把“这次训练的事实到齐了多少、分析到哪一步”
变成可查询状态（全部来自现有表，不新增存储）：

- `facts.committedAt` = 第一次写入该 workout 实体的批次完成时刻；`lastBatchAt` = 最近一次触及
  该训练窗口（workout 实体或窗口内记录账目）的批次完成时刻；`batches` = 触及批次数。
- `analysis.status` = `published`（存在指向 active model run 的评估行）/
  `failed`（最近关联分析任务终态失败）/ `pending`；关联键是
  `recompute_jobs.request_json.importBatchId`。
- `series[]` = 与 `/series` **同口径**的窗口内样本数（去重键、`source_name`、`start_at` 边界一致），
  外加 `elevation` = 可读路线点数；每项 `state ∈ {present, not_seen_yet}`。
  `not_seen_yet` 是**允许且诚实**的状态：它表示“目前没见到样本”，**不是**“设备没有该能力”。
- `completeness = complete` 的判据是显式的：**已发布** 且 `lastBatchAt` 距 `now` ≥ 24h；
  其余一律 `partial`。24h 是“手表迟到样本最晚在下一轮同步到达”的稳定性下界，
  不是“以后不会再有数据”的断言——`complete` 只是“数据已稳定”的下界证据。
- 会话不存在或事实已软删 ⇒ 404（与详情端点同一条判据）。

### 10.6 覆盖探测：`GET /v1/sync/coverage`（2026-10-18，P1-1）

```jsonc
{ "datasetEpoch": "default",
  "types": [ { "type": "HKQuantityTypeIdentifierStepCount",
               "knownFrom": "2024-01-01T00:00:00.000Z", "knownUntil": "2026-10-18T11:40:00.000Z",
               "sampleCount": 534789 } ] }
```

- `types` 查询参数（逗号分隔）可选，缺省 = 全部类型；未知名不补空行（“没有这个类型”也是信息）。
- `knownFrom` / `knownUntil` = `MIN(start_at)` / `MAX(end_at)`，是**已落库样本覆盖的端点**，
  不证明区间内没有空洞；`sampleCount` 是未去重的行数。
- `datasetEpoch` 复用 `/v1/handshake` 的权威值：数据集更换后旧 epoch 的覆盖结论立即作废。
- 服务端 `handshake.syncCoverageVersion = 1` 宣告本能力；老服务端省略该键，客户端必须回落全量重放。
- 客户端只可据此**避免重传**服务端已有历史；不得删除本地游标、不得跳过真正的待办，
  也不得把覆盖区间当成“完整”证明（§5.1：数据模型不表达“该有什么”）。

### 10.7 阶段耗时：接收器内部的四段账本（2026-10-18，P2-3）

`import-worker` 的 `performance.computeStagesMs`（开放键）新增四个观测键：
`directSync.identity` / `directSync.parse` / `directSync.ledger` / `directSync.commit`。
它们**不**进 `stagesMs` 的闭集枚举（那是公开契约的一部分）：四段回答“一批 5–8 s 花在哪”，
不是“哪条车道跑了多久”。拒收/重放批次没有完整四段，因此不带这些键。

## 11. 项目退出备份责任

目标不是只去掉UI文案，而是清理项目的自动备份入口：

- 同步worker不调用`DatabaseMaintenance`的backup/retention/quarantine流程。
- API启动、正常writer open、导入/模型更新不自动备份。
- 显式migration CLI默认不创建项目备份；schema升级仍显式进行，外部运维负责之前的保护。
- `deploy/upgrade.sh`不再POST `/v1/backups`；输出外部备份责任提示而不是代用户执行或校验。
- 项目备份/恢复常规UI入口退役；旧接口给清晰维护提示，不自动执行备份或轮换。
- 不删除已存在的项目备份/rollback文件，不扫描它们作自动清理；
    
  是否保留、归档或删除由服务器运维决定。
- 不把自动VACUUM或大规模历史清理塞进同步/最后成功收尾。

### 11.1 给外部服务器备份的必要接口约束

应用不执行备份，但文档必须提醒：

- 活跃WAL库不能仅`cp rai.sqlite`作为一致备份，也不能删除WAL“提速”。
- 外部工具采用SQLite一致性备份API、协调的存储快照，或暂停所有写者后完整备份相关文件。
- 若要整个项目状态一致，主库、runtime/control、上传/工件、配置/身份要属于同一恢复边界；
    
  独立在线备份多个库不自动意味着跨库一致。
- 备份凭证及数据由运维保护，健康原文/精确轨迹/Token不进入仓库。
- 恢复/替换数据集需显式处理schema兼容和datasetEpoch；
    
  不能旧备份还原后让客户端继续复用新游标，假称没有丢接收状态。


这只是运维合同提示，不增加应用备份、巡检备份是否成功或同步等待。

## 12. WAL、清理和错误处理

- 小批 `synchronous=FULL` COMMIT确保回执的持久性；默认不等待TRUNCATE checkpoint。
- 正常SQLite检查点属于数据库维护，不是备份。策略不挂在用户“同步完成”链上，
  避免长读事务，监测WAL增长。
- 关闭扫描式审计、代次补种、重复报告等普通接收调用。
- 成功已确认后轻量清理可以独立进行；失败清理不能把已committed receipt改成失败。
- 解析文件/路线缓存有batch所有者，任务引用保护与孤儿回收；
  不改 ADR-004的iOS“清产物后提交”顺序来掩盖服务器问题。
- 发现SQLite corruption/EIO：暂停写入、保留文件和回执依据、报告维护；
  不自动copy整库、删sidecar、改名主库或新建空库。

## 13. 实施拆分与发布

### PR1：合同、状态与测试防线

明确raw receipt、分析版本、外部备份责任和普通同步禁用旧链路。
建立验收测试骨架，现阶段不先删backup函数让null误入全量import。

### PR2：同库事务接收全部正常类型

抽出不自行提交的raw writer，覆盖混合Record、Workout、来源、删除、账目与任务；
用 SAVEPOINT替代组件私自BEGIN/COMMIT，不全库seed。
已有未知hash逐实体补齐，解析准备离开写锁，支持幂等及重启。

### PR3：版本化事实与路线

稀疏history、generation、路线版本、before/after dirty信息，稳定旧身份/FK证据；
大包分页/原子单元和客户端继续意图。只新增显式冻结migration，不修改历史checksum。

### PR4：分析输入、短写调度与局部canonical

改造`RecomputePipeline`的SQL/CPU混合流程和长期writer接纳；
固定FactsReader，按dirty计算、分块写未发布结果，保留业务gate。

### PR5：分析指针和全部读侧一致性

旧release读不混新raw，删除/更正/待分析显示明确；
原子指针发布与重算合并，今日处方检查新鲜度，缓存按版本。

### PR6：iOS/桌面状态、切路与移除备份入口

新能力receipt协议、所有续传分支、新文案；
**直接接收全覆盖和旧同步备份/换库退出在同一受控发布完成**。
普通同步路径不保留legacy fallback；不满足条件时拒绝/待维护，不悄悄复制主库。

Rust可保留解析/数学作用，但现有只允许私有SQLite候选的native `apply-records`
不能放宽permit后直接接主库。首版复用TS主写，旧已接纳engine任务要有明确兼容/迁移规则。

### 回退

有异常时暂停新接收、保留已提交receipt和旧可读release，回滚应用/分析策略。
不以恢复legacy backup/swap作为正常同步降级。
已经确认的原始事实不能通过切旧数据库丢掉；恢复由外部运维在维护窗口处理。

## 14. 验收条件与发布门禁

### 14.1 禁止操作：必须证明没有调用，而不只是没有显示

所有正常接收路径都适用，包括首次历史分页、手动同步、自动同步、
后台续传、删除-only、混合评分批次、大包分批及任务重启。
测试中以下操作一旦由正常同步触发即失败：

```text
createCurrentBackup
backupDatabase / 整库copy
isReadableDatabase的全库quick_check
activateDatabase / installDatabase / moveDatabaseFile
强制wal_checkpoint(TRUNCATE)
stageAuditReports完整构建
seedImportGenerations全库补种
全表canonical nights删除/重建
```

不能只通过函数改名或 UI 提前成功满足要求：还要记录 SQL、任务阶段和文件操作，
确认没有等价的整库复制、扫描或替换。正常批次期间主库路径和文件身份保持不变；
允许 SQLite 自身更新主库、WAL、SHM，以及本批上传/解析缓存。

### 14.2 功能与正确性验收矩阵

以下项目全部必过；“未测试”不得标成“通过”。测试使用隔离数据库，
不得在生产健康数据上注入故障。

| 编号 | 验收场景 | 通过条件 | 必须留存的证据 |
|---|---|---|---|
| A01 | 所有日常数据类型 | 心率、睡眠、HRV/RHR、Workout、GPX、非评分 Record 和混合包均直接写同一主库，无第 14.1 节禁止操作。 | 分类型及混合包集成测试；调用、SQL、文件操作追踪。 |
| A02 | 自动同步只取增量 | 有效游标继续使用；无变化时不重导历史，无周期性全历史重扫。首次无游标只允许分页初始化，不复制主库。 | 连续三轮同步的游标、导出数量、服务端变更数量。 |
| A03 | 历史更正与显式删除 | 日期移动、共享 UUID、删除先于到达、删除-only、旧 XML 桥接均保留正确身份与删除保护，不误删同来源其他事实。 | before/after、alias/source、tombstone 和账本断言。 |
| A04 | 本批事务原子性 | 原始事实、身份映射、删除保护、账本、代次、任务、成功回执同事务；任一点抛错、IGNORE 或异常改写均整批回滚。 | 各写入点故障注入；回滚后所有相关表和回执检查。 |
| A05 | 强杀与丢回复 | COMMIT 前强杀不存在半批；COMMIT 后丢回复或重启，重试返回原回执，不重复应用。 | 真实子进程强杀、重启、重放及数据库断言。 |
| A06 | 幂等与负向输入 | 同批同内容可安全重放；同批不同内容、错误作用域、无效格式或超出约定限制明确拒绝，无部分写入。 | 重放、冲突、越界和格式错误测试。 |
| A07 | 分页与持续意图 | 每页游标仅在对应持久回执后推进；5000 条/字节预算、删除-only 页、后台中断后仍继续排空未消费变化。 | iOS 纯逻辑回归和真机/Simulator 中断续传记录。 |
| A08 | 大包和旧任务恢复 | 超限包按稳定原子单元分批，可断点续传；父批未全部成功不提交最终游标、不假称全批成功；不回退整库流程。 | 分批计划、子批回执、父批状态和重启恢复测试。 |
| A09 | 路线分块与发布 | 未完成新路线不破坏旧路线；末批完成后原子发布。待处理路线及缓存不被提前清理，重试不重传已确认分块。 | 分块失败、重启、重复上传、版本指针和文件保留断言。 |
| A10 | 分析失败隔离 | raw 接收已成功仍保持成功；分析失败显示独立状态，重试只计算，不要求重新导出、不重新备份或复制库。 | 分析故障注入、原回执不变、重试调用追踪。 |
| A11 | 后台计算不长期占写锁 | CPU 分析期间仍可接收新批次；写锁仅覆盖短 SQL 事务，不能仅把旧长事务换到 Worker。 | 调度/锁时间线、并发导入及轻量 API 延迟。 |
| A12 | 旧分析与新事实一致性 | 旧 release 不混入新 workout/route；删除不泄露旧“当前”训练；待分析数据和过期处方准确标记。 | FactsReader 固定版本测试、读侧集成测试、桌面/iOS 状态截图。 |
| A13 | 发布竞争与持续更新 | 迟到任务不倒退 active 版本；新数据持续到达仍有已计算结果可读；配置/override 变化使不合格候选拒绝发布。 | 交错任务、连续变化、配置竞争及指针断言。 |
| A14 | 旧数据与兼容升级 | 无快通路资格 stamp、旧内容 hash 不导致首次整库候选；手机升级保留 pending task 和有效游标。 | 旧库/旧客户端持久状态 fixture 升级回归。 |
| A15 | 项目完全退出备份 | 同步、启动、升级脚本和维护入口均不创建、验证、轮换或删除备份；不等待外部备份。已有归档不被删除。 | 入口检查、备份操作监视、归档清单前后对比。 |
| A16 | 正常持久性与数据库故障 | 保留外键、约束、WAL 和 FULL COMMIT；corruption/EIO 明确暂停写入，不自动替换主库或创建空库。 | 配置断言、故障模拟、日志和主库身份检查。 |
| A17 | 客户端状态和领域语义 | raw COMMIT 后可显示“已保存，分析更新中”；不再显示备份/临时库/换库阶段。评分语义和业务发布 gate 不变。 | 协议兼容测试、文案/状态截图、既有评分与 gate 回归。 |
| A18 | 改动范围与迁移 | 不新增 PostgreSQL/Redis；只新增迁移，不修改历史 checksum；冻结的窄屏 Web 不修改。 | 依赖、diff、迁移校验及桌面回归报告。 |

### 14.3 性能验收标准

以下是**待目标云机实测的发布目标，不是当前已测结果**。
上传、HealthKit 首次历史读取和后台分析另行计时，不混入服务端持久接收指标。

| 编号 | 指标 | 通过标准 |
|---|---|---|
| P01 | 有界原始增量持久接收 | 每批不超过 5000 条且不超过 8 MiB 归一化原始内容、路线单独计量（xml ≤ 8 MiB / 路线 ≤ 64 MiB，2026-10-14 自 2 MiB / 32 MiB 放宽，见 §15）；从服务端接收完上传到持久回执可读取，p95 < 5 秒。包含排队、解析、锁等待和事务。 |
| P02 | 并发时轻量 API | 原始接收及后台分析运行期间，事先选定的轻量读取 API p95 < 1 秒；报告接口、请求并发和样本数。 |
| P03 | 最终分析指针发布 | 候选计算和结果准备完成后，发布写锁等待与短事务合计 p95 < 200 ms；不得只统计单条 UPDATE。 |
| P04 | 与全库规模解耦 | 在不同全库规模下运行相同增量，仍满足 P01/P02；无整库文件 I/O 或全库扫描。允许索引查找成本变化，禁止主库越大就复制/检查越久。 |
| P05 | 大包与 GPX | 单独报告记录数、字节数、轨迹点数、分块数及阶段耗时；可恢复、有真实进度、不阻塞已确认原始回执。不得用零等待或固定秒数掩盖上传/首次历史成本。 |
| P06 | 端到端可解释性 | 分别记录导出、上传、接收排队、解析、锁等待、事务、分析排队/计算/发布；同时报告 raw 已保存与分析已更新两个时间点。 |

### 14.4 性能测试口径与证据

1. 固定目标云机 CPU、内存、磁盘、Node/SQLite 版本、配置、代码 revision，
   记录并发模型、数据库总记录数/字节数、索引及 WAL 状态；不得仅用开发机空库替代。
2. 使用隔离且脱敏的数据集覆盖小库、接近实际线上规模和更大规模，
   例如 10 万、50 万、100 万条 Record；同一对比组使用相同增量和相同路线点数。
3. 覆盖无变化、小批、接近批次上限、混合评分、删除/更正、路线与分析并发；
   空批快速不能代替混合包验收。
4. 每个核心持久接收测试组至少预热 30 批、记录 200 个有效样本，
   报告 p50/p95/p99/max、错误率及超时。冷启动另列，不混入预热样本。
   重试或失败样本也要列出，不得静默剔除来改善分位数。
5. 对比相同环境下旧版本与新版本，保存原始计时、SQL/调用/文件追踪；
   同时核对事实数量、删除结果和回执，不能只用 UI 状态跳转时间证明优化。
6. 证据目录至少包含环境与 revision、各验收项结果、故障注入输出、
   性能原始样本及汇总、人工验收截图；健康原文、精确轨迹和凭证不得入库。

### 14.5 发布检查清单

- [ ] A01–A18 全部通过，逐项附测试或人工证据；没有仅限步数/体重的例外。
- [ ] P01–P06 在目标云机代表性规模下完成实测并满足标准；未测项不得宣称达标。
- [ ] `npm run typecheck`、`npm test` 通过。~~`npm run build`~~ 已随 Web/macOS 退役**删除**（[DECISIONS](DECISIONS.md) D17、[ADR-006](adr/ADR-006-retire-web-and-macos.md)），不可复跑、也不得加回 `package.json`；它不再是发布判据。
- [ ] ~~浏览器流程的 `npm run test:e2e:web`~~ 同随 D17 删除：D17 之后不存在 Web 测试面（无浏览器客户端、无 WKWebView 壳），本条**不适用**，不要按旧句子补跑或把脚本加回。
- [ ] 涉及 iOS 时，`npm run test:ios` 确实检查源文件；无 Xcode 的跳过不是通过证据。
- [ ] 真机 HealthKit 自动增量、续传、有效游标保持和新状态完成手动验收。
- [ ] 所需 schema 迁移在隔离库演练通过，历史迁移 checksum 未改变。
- [ ] 普通同步的旧 backup/candidate/swap 链路已退出；不支持的状态明确失败/维护。
- [ ] 外部备份与恢复责任交由用户运维确认；应用不创建备份，也不在同步时查询等待。
- [ ] 发布/回退步骤明确保留已经确认的原始事实、回执和可读分析版本。

任何正确性、禁止操作或持久性项失败，都不得以“性能已经改善”替代修复。
发布观察期应同时观察接收失败、分析积压、锁等待和 WAL 增长，
而不是恢复旧备份/换库同步链路作为降级。

## 15. 当前边界与需要批准的后续操作

本文件完成的是设计。实施状态（2026-10-14）：
阶段 1 观测版（`8ab8fd5`）已上生产（`directSyncBounds` 契约 + 拒因结构化 + lane 遥测）；
阶段 2 iOS 分批版已发布（`d428c7b`，含 `3831817` 的 Mac 验收阻断修复）；
阶段 3 服务端收口版（显式拒绝、删除 backup/candidate/swap 运行期调用链、文案收口、
`RAI_IMPORT_MAX_ZIP_BYTES` 默认 64 MiB、CLI 发布锁）已实现并随本仓库进入主线，
其**部署前置 = iOS 分批版全量铺开**（发布顺序 R1，避免旧客户端超界批次硬失败）。

🔴 2026-10-14 部署后事件与上界放宽（收口部署当天被真机触发）：
收口版部署当天，手机全量回填批（xml 2,411,741 B / route 34,009,725 B / 58 文件）
在 `/v1/imports/inspect` 被 `route_exceeds_bounds` + `xml_exceeds_bounds` 双拒（400，零副作用）。
它证明「分片未实现 + iOS 预算不覆盖 route」的组合缺口：`DirectSyncBatchBudget` 只含
xml/records、route 无预算维度，且停止点可超尾页 ⇒ 仅“iOS 分批版铺开”不足以让回填批过界。
同日放宽直连单批上界（xml 2 → 8 MiB、route 32 → 64 MiB，见 `direct-sync-ingest.ts` 常量注释）
以先恢复数据流。iOS 侧 route 预算维度**已补**（`DirectSyncBatchBudget` 增 maxRouteFiles / maxRouteBytes 两维；收集侧为“先判后取”闸门——`HealthKitExport.swift` 逐 workout 循环，状态与文件同进同退，余量由 rediscovery 轮转补）。

🔴 2026-10-14 尾页超额**已根治**（方案见 `deliverables/DIRECT_SYNC_TAIL_PAGE_ROOT_FIX_PLAN_2026-10-14.md`）：
「服务端 8 MiB 对『预算 ×0.9 + 尾页』留有余量」**不再是一条判据，只是兜底**。
根因是「提交单位」与「上界单位」不匹配——服务端按**字节**判上界（`statSync(export.xml).size`），
iOS 按**页**提交（`HKAnchoredObjectQuery` `limit: 1000`），而预算检查发生在页**已落盘之后**
（真机实测超 524,305 B：预算 1,887,436 → 实际 2,411,741）。四处改动：

1. **记录侧写前判定**：`HealthKitRecordCursor.drain` 的 `PageDecision` —— 整页渲染 → 判定 → 整页提交或整页不提交，
   停止时锚点回退到**页前**。`PageDecision` **没有「超预算也提交」这个 case**（类型上不可能）。
2. **自适应 limit**：放不下 ⇒ `.retryWithLimit(n)` 缩小 `limit` 重查**同一锚点**（可缩到 1 条），
   使前进粒度从「每轮 ≥1 整页」降到「每轮 ≥1 条记录」⇒ 页首回退不退化成死循环；
   夹紧规则（请求值须严格小于当前值，否则折半）保证 `limit` 单调下降、O(log n) 收敛。
3. **route 侧整文件判定**：`routeEntries` 先算字节、判定放得下再落盘，装不下则**整个 workout 的轨迹一起放弃**
   （回滚本轮已写分片）⇒ route 超额上界从「一整个 GPX 文件」降到 0。
4. **`budgetStopReason`**（`.recordPage` / `.recordNone` / `.routeFile`，两段收集取并）成为 `hasMorePages`
   的**唯一来源**（同一事实不存两份，杜绝「说没截断、其实截断了」这种类型上排除不掉的不一致）。

同批另有两条独立修复：
**本地自校验**（上传前用真实产物对比服务端硬上界，超了就缩预算重导，而不是发出去换一个 400）
与 **inspect-400 出口**（`direct_sync_payload_exceeds_bounds` 单独一档 `.convergeBudget`：收敛一档预算 + 清任务行重导，
不再落进 `.keepTask` 把同一个 `sourceId` 永远重撞 —— 与 2026-09-22 的 404 死锁同构，只是入口从 404 换成 400）。

剩余边界（如实标注）：收敛档位有上限（`DirectSyncBudgetConvergence.maxSteps = 3`），到顶后如实报维护文案、
不再自动重导；收敛记忆存在 `UserDefaults`（键 `rai.hk.budgetConvergence`，按服务端 URL 作用域），
只在显式「修复增量游标」时复位（2026-10-17 起「重新导入全部」已删除；
该复位原本是它的职责，现在归定点修复 —— 否则一次历史超界会把预算档位永久折半）。

应用不执行备份；外部备份/恢复由用户运维安排。
