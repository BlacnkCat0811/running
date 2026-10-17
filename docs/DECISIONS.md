# 长期工程决策

本文件保留过期批次报告中仍有效的约束；历史讨论通过Git查阅，不再保留逐次“修复/再审/再订正”副本。
范围优先级：[AGENTS](../AGENTS.md)；算法合同：[ALGORITHM](ALGORITHM.md)；实施问题：[项目审查](PROJECT_REVIEW.md)。

## D1. 不恢复常驻shadow双跑

2026-09-20已取消导入时独立完整shadow重放和对应开关。不得为了验证一项修改在生产每次导入中偷偷增加第二次全量计算。
保留版本gate、数据完整性、原子发布与回滚；需要对照时显式运行离线副本/固定事实回放。
“去掉shadow”不是“可以去掉验证”，名称仍带shadow的历史表/兼容方法也不等于后台仍双跑。

## D2. 身份算法是兼容合同

[identity fingerprint](../apps/api/src/import-payload-identity.ts)使用行为探针，而非源码文本hash；运行时使旧载荷锚点失效，冻结测试要求人工确认有意的身份变更。
引擎必须同时区分name和version；解析语义变更还要考虑canonical contract bump，不能只改identity常量。

## D3. 冻结历史迁移与执行通道

[迁移策略测试](../packages/storage-sqlite/test/migration-policy.test.ts)要求每个migration都有冻结checksum，现行部署执行路径为tsx。
新migration追加新冻结值；不得为了绕过迁移错误覆盖旧值。改TS执行通道需单独验证，不把transpiled文本差异误当数据库损坏。

## D4. 恢复不是Fitness评分维度

当日睡眠/HRV/RHR只能经独立Readiness改变安排和适用预测情景；不能借课型、置信度或学习率隐式写回TA。
未校准状态、modelConfidence和缺证据保持null/unknown。精度和医学有效性必须独立证明。

## D5. 发布原子性与单写者

数据库变更、导入切换、模型激活与回滚通过既有mutation/publication协调；不要增加多实例写者或跨runtime目录共用一套状态库。
预测/规则更新不能复写原始健康事实；候选失败不能半发布。

## D6. iOS边界与后台机制

现有SwiftUI App通过API使用TS计算，只读HealthKit。已授权HealthKit background delivery、BGProcessingTask及background URLSession；未授权独立Watch/macOS产品或HealthKit写入。
四条容易被“优化”破坏的同步不变式及后续补充保留在 [ADR-004](adr/ADR-004-healthkit-sync-invariants.md)。真机检查见 [iOS runbook](IOS_NATIVE_RUNBOOK.md)。

## D9. 隐私区在主库，分享卡的裁剪在服务端

**主库而非控制库**：备份/恢复只覆盖主库（`DatabaseMaintenance(databasePath, runtimeRoot)`）。
隐私区若住在控制库，恢复后它会静默消失 —— 而用户正好在重建之后分享的第一张卡片就是没裁剪的。

**裁剪只在服务端发生一次**（[share-card](../apps/api/src/share-card.ts)）：客户端只画 `polylines`，
拿不到被移除的坐标。两个"藏起我家"的实现就是两次泄漏机会。
`polylines` 是**数组的数组**而不是带洞的一条线：断开是数据结构里的，不是绘制代码要记得遵守的标志位。

隐私区写入同时携带 `revision` 和 GET 返回的 `stateToken`（完整集合的内容哈希）。数据库恢复可能复用同一 revision，因此不能只比较整数；前端保留草稿原状态令牌并阻止旧草稿保存，服务端在写事务中再次校验，不匹配返回 409。

**裁剪必须切断穿越**：只删区内的点会留下一条穿过隐私区的弦 —— 卡片上就是一条直穿家门口的直线。
圆-线段求交把线段切在圆上，`gaps` 报告断了几处（不是"多少段压到圆"，那个数对读者没有意义）。

分享卡路由**需要令牌**（轨迹几何 + 裁剪元数据）；隐私区读路由同样需要令牌（家/公司坐标）。

训练详情的原始轨迹只在正确令牌下返回；未配置令牌时默认隐藏，只有显式 `RAI_ALLOW_ANONYMOUS_ROUTES=1` 才允许本地匿名原始轨迹，生产检查必须提示处置。

## D12. 训练范围是"人群/个人"，不是"更低的人群门槛"

单个跑者到不了 50 条标签，但把 50 改成 24 会让"人群模型"变成假话。
因此新增的是**范围**（`population` 缺省 / `personal` 显式请求）：个人范围的两个数字就是 artifact
自己的门槛（24 / 4），且**激活判据完全相同**——优于规则基线 ≥5%。降低的是需要多少数据，
不是必须多好。旧行没有 scope 字段一律按 `population` 解释。

产物 manifest 必须记录 scope，并与 run 在训练、激活及推理边界一致。监督训练的历史基线不能借用个人校准的当前证据留一法，见 [ADR-005](adr/ADR-005-temporal-training-labels.md)。

## D11. 个人自校准是另一条通道，不是降门槛

单个跑者永远到不了 50 条标签，但把人群门槛降下来只会让一句假话更容易说出口。
[个人层](../packages/model-eval/src/index.ts)因此是**并存**的第二条通道：标签 ≥8、距离 ≥2、跨度 ≥120 天，
给的是自己留一法残差的分位区间，**禁止** P80/P90 词汇，低于地板不给区间。
人群门槛与 M03 一个字不动。

## D10. 手工成绩只作标签，且按录入时刻起算

[手工成绩条目](../packages/storage-sqlite/src/performance-entry-repository.ts)（迁移 27）解决"成绩都在手表之前 ⇒ 零标签"。
两条不能被"优化"掉的规则：`labelAvailableAt = recordedAt`（今天录入的历史成绩不得进入此前的预测），
撤销写墓碑而不是删除（否则 T03 的失效传播失去时间戳）。
手工成绩**只作标签与评估证据**：不生成轨迹、不参与 CA/TA，也不因录入而改变任何既有评分。
没有赛前证据的补录成绩只作为个人校准候选，不计入监督训练样本；同日同距离的未撤销条目不能重复录入。
迁移 28 将候选确认绑定到真实训练事件；纯日期成绩使用本地午夜作为特征截止，整事件留出且跨来源去重。撤销/覆盖修订的失效版本进入规则基线哈希，并原子清除活跃残差指针；旧模型与区间保留审计但不得继续发布或重新激活。

## D7. 设计资产、文档和隐私

大设计图已出库，不再次搬回仓库；[blob size检查](../scripts/check-blob-size.mjs)按路径无关的文件体积守卫，不能换目录绕过。
图片展示/验收资产与生产代码分开；保留有用途的视觉文件，不把旧截图视为当前构建已通过。
一主题一份现行文档；历史记录从Git查阅。核验证据必须保留库/时点/版本边界，不复制多台机器报告成多个“当前状态”。
真实XML/GPX/健康SQLite/Token、上传与备份不入库，也不向外部搜索或日志泄露。

## D13. 周课表只由规则教练生成

2026-10-06 移除大模型排课、提示词和模型通信；`RAI_LLM_*` 配置不再生效。评分及预测模型不受影响。
保留规则七日排课、preview/confirm、手工编辑、每日教练建议和手动手表同步；新课表审计为 `heuristic`，模型及提示词版本为 `null`。

启动时把旧 `llm` 来源课表的未来日期停用，包括随后手工修改的日期；今日处方、锁定安排、历史修订与推送回执不变。控制库迁移和修订记录同一事务提交，文件兼容路径先备份。
服务端持久化只读 `weekPlanReplanRequired`：待确认期间跳过周一自动排课、禁止直接生成和逐日课表保存（409），但允许不带 `weekPlan` 的训练设置更新。
预览、取消、设置保存和重启不能清除该状态；仅显式确认规则预览后解除。另持久化服务端只读 `weekPlanPreservedDate`，保留迁移当日处方；确认、手工编辑、重新生成及重启都不能改写该日，按上海本地日期跨日失效。今日建议与 WorkoutKit 不因新推导容量而缩短保留处方，但仍执行恢复、负荷、校准及赛前减量闸门。未来课表先预留今日预算、使用正常容量，不继承今日豁免；确认后恢复其余自动排课与手工编辑。已停用未来课表但尚未确认的旧 payload 可幂等补齐当日保护。

`llm` 仅用于读取旧来源，不把旧课表伪装成规则生成。服务端停用不会自动撤回手表旧排期，客户端提示用户手动同步撤回或替换，不新增自动设备操作。

旧 `llm` 课表若只有今日及历史日期，也记录今日保护，但不新增未来课表待确认状态；没有今日处方的历史课表保持不变。

2026-10-10完整剂量基础实现：新自动生成改用[完整课分配器](../apps/api/src/coach-complete-plan.ts)，先构造有目标的完整结构，再决定次数；预算不足时先减少整堂课，而不是均分剩余日或缩成短课。生成、阶段/预算裁剪后及明确为`heuristic`的有效读取复核普通自动课至少1800秒与工作剂量。人工短课、历史及锁定文本不被改写；恢复/赛前保护使完整剂量不可行时休息。新生成尚不使用候选H填满周量，追加发布未启用；完整实施边界见[实施状态](COACH_LOOP_IMPLEMENTATION_STATUS.md)。

公开人工保存明确改为`manual`审计，不能继承旧自动来源后误套30分钟下限；现有`manual/heuristic/llm`枚举不扩展，设置更新不改审计。旧来源无法逐日区分的历史仍不声称完成新保证迁移。

## D14. 周容量是推导值，不再由用户设置

2026-10-06 退役「每周跑量」目标。它一度同时是**展示口径**（今日页目标环、本周完成度）和**排课容量**（`weeklyPlanVolumeCeiling` 的基线），而这两者本来就该同源；更糟的是生成路径把"用户手填的目标"当成"近期实际训练量"喂进周期化，展示路径用的却是真实 4 周均值 —— 同一周，两条路径的基线不同。

容量改由 [weekly-capacity](../apps/api/src/weekly-capacity.ts) 推导，三档优先级：比赛目标（`RACE_WEEKLY_BASELINE_KM` × 阶段系数，再被 `max(5, 近期实测量 ×1.3)` 封顶）> `max(5, 近期实测周跑量)` > 5 km 重启基线。[ALGORITHM](ALGORITHM.md) 记了完整口径。

重启连续性：首周完成 5 km 后不能因四周均值被空周稀释而连续停课。重启底托保留在小样本阶段，实际四周均值仍按原口径计算；上周斜坡和恢复闸门继续生效，漏练或缺失导入不增加补课量。教练参考佳明的自适应计划方向，不将本项目政策常量称为佳明算法。

契约与存储：`PUT /v1/mobile/goals` 不再接受该字段（`additionalProperties: false` 会拒绝仍在发送它的客户端）；存储层读旧 payload 时**忽略**该键而不是报错，迁移探针从"`weeklyDistanceKm` 有限"换成"`revision` 是非负整数"。

两条容易被"优化"掉的规则：**上限与基线不能混用**（`weeklyPlanVolumeCeiling` 对输入不幂等，把已收敛的数再喂回去会复合收紧）；**没有比赛目标也照出正式 7 天课表**，只是基线换成实测值，不因为"没有目标"就停止排课。

2026-10-10续作已将`buildCoachCapacityAnchor/coachCapacityEnvelope`接入**显式选择的新合同**`/v1/mobile/coach-loop`：S只规划常规课，H限制自然周与滚动7/14日；满足资格时可发布30分钟低强度追加。控制库同事务保存课表、授权槽位、锚点和决策收据，操作键重试不重复执行。旧`weeklyCapacityKm`语义不变，旧客户端不会被静默升级；新合同需明确接受当前policy hash，尚未对现有用户数据集启用。常数仍为项目政策，不能将低于H称为个体训练安全保证。

## D15. iOS 对齐新版 Garmin Run Coach 流程

原生默认计划入口改为自适应跑步教练，不采用旧版 Jeff/Greg/Amy 专家计划的手工改期。支持体能、完赛、时间目标，跑步日和长距离日偏好、配速/心率目标、补充力量训练，以及暂停、恢复、结束。公开功能和本地边界见 [RUN_COACH](RUN_COACH.md)。

用户点击开始即授权该计划的日常自适应：原生进入教练或全量刷新时，以 CAS 命令触发服务端刷新，事实未变化不写新修订。此模式不要求每次未来调整都 preview/confirm；D13 的预览确认继续用于独立手动课表。开始计划也算显式确认规则排课，但不能解除迁移当日保护。读取 API 不产生排课写入。

2026-10-10继续实施：旧`refresh`的相等出口保留；新合同接入有界最小修补，变化身份包含结构、可执行状态与授权引用。相同事实/有效内容不制造修订，窗口外课仍参与约束。暂停/结束或规则版本变化不能借无赛事默认值自动重启；新版本需要重新确认，安全停止命令不被版本不匹配阻挡。服务端接口实现不等于旧iOS已适配该新合同。

进行中和暂停的教练计划禁止旧编辑器直接修改目标和逐日课表，也禁止旧生成/预览接口改排；用户通过跑步日偏好表达未来可用时间。暂停及结束令所有未完成的未来跑步处方不可执行，跨周也不能回退到默认跑步。恢复按当前证据生成，不积累补课债务。结束后显式保存或确认手动课表才退出教练管理。

算法留在 TypeScript 服务端，Swift 只管理视图、缓存和命令。佳明内部算法、Firstbeat 指标及成绩信心值不可复刻，不编造这些数值；本项目政策常量不称为佳明算法。力量训练仅在原生展示，尚不导出为 WorkoutKit 力量训练。手表仍需用户显式同步，暂停或结束不代表已从手表撤回。

## D16. 周期化阶段只有一个来源

2026-10-07 合并两套 phase 推导。[plan-periodization](../apps/api/src/plan-periodization.ts) 的 `PHASE_BOUNDARIES` 是阶段边界的**唯一**归属，[run-coach-policy](../apps/api/src/run-coach-policy.ts) 的 `runCoachPhase` 降级为适配器：骨架窗口内取今天页那一行（`current.phase`），窗口外（比赛已过、或超过 24 周）用同一张表与同一个周对齐（`periodizationWeeksToRace`）直接回答，`past` 因此仍然可达。

被替换的是 2026-10-07 教练接入时新写的 `floor(daysBetween / 7)` 配固定 `taper + 5`，三条可实测的后果：同一自然周内阶段会从 `peak` 跳到 `taper`（周计划与「第 N 周 · 强化期」在周中自己变）；5K 得到 5 周专项期而半马 4 周（方向相反）；对自定义距离返回 `"base"`，假装有一套不存在的骨架。三条由 [run-coach-phase.test.ts](../apps/api/test/run-coach-phase.test.ts) 锁住，并做过突变验证（`five_k.build` 2→3 时 5K 长度断言变红）。

`weeklyCapacity` 不再按「有计划 / 只有赛事目标」在 `runCoachPhase` 与 `currentPeriodizationWeek` 之间二选一——那种结构本身就是漂移的温床；现在只选择询问哪个赛事目标，phase 的语义只剩一个：当前自然周所在的周期化阶段。`runCoachWeeklyBudget` 的「本周量带上限」直接取自今天页渲染的 `periodization.current.volumeBandKm.upper`，不再按阶段重算一份（重算正是 33 与 31.5 同屏的成因）。

2026-10-10将原按天的14天规则统一命名为`raceExecutionProtection`，每日与周计划消费同一函数；`racePlanPhase`只留弃用兼容适配。`executionPolicy`只读元数据分别返回骨架phase与赛前/比赛日保护，不是新增放行能力；支持距离的phase仍取唯一骨架，无骨架距离仍为null。保留14天旧执行限制；联合完整剂量政策时不足30分钟转休息，不通过延长剂量绕过保护。

无骨架赛事保持原两天质量/长课兼容保护，未扩大为14天距离模型；共享函数同时用于生成和有效读取，元数据按真实兼容约束解释。原存储、人工文本及锁课保持；有效限制可阻止旧结构执行。

新教练合同在正常base/build/peak以量带指导S，而用历史独立H做追加保护；减量、比赛周、14天附加保护仍禁止超S追加。这一版本化差异仅作用于已选择新合同者，不将旧量带字段改名后继续交给旧客户端。

契约影响：`MobileRunCoachResponse.phase` 对自定义距离由 `"base"` 变为 `null`，界面落到既有的「持续训练」文案，iOS 无需改动。同批**未**处理、留待单独决定：`phases` 区间数组对无骨架计划仍以 `"base"` 填充，与 `phase: null` 的语义不自洽。

## D17. 客户端收敛为原生 iOS + API（Web 与 macOS 退役）

2026-10-17 产品决定：移除浏览器 SPA（`apps/web`）与 `apps/ios` 的 macOS destination / WKWebView 壳，仓库只保留两个可交付物——原生 SwiftUI iOS App 与它直连的 Node API。执行手册与逐批验收见 [Web/macOS 退役实施计划](../deliverables/plan-remove-web-keep-ios-api.md)，决策记录见 [ADR-006](adr/ADR-006-retire-web-and-macos.md)。

**这不是"暂停维护"，而是删除**：不得重建浏览器客户端、WebView 壳、macOS/桌面 target，也不得用 `npm run build`/`test:e2e:*`/`check-web-build.mjs` 把旧门禁偷偷加回来。`AGENTS.md` 同步改写为该口径。

**后端端点不随客户端退役**：全部 `/v1` 路由保留，包括 36 条此前只有 Web 在用的端点（备份、模型/预测管理、数据运维、审计、导入管理、手工成绩、隐私区）。裁剪端点属于独立产品决策，且必须连同 `server-runtime`/`schemas`/OpenAPI 断言一起改，不能按「Web 清理」名义批量删。`/v1/performance` 是运维遥测端点，两边客户端都不调用，尤其不要误删。

**服务地址与鉴权边界**：iOS 首次连接手填 HTTPS 地址（Release 在应用层强制 https），Token 存 Keychain；API 必须配置 `RAI_API_TOKEN`——否则经 nginx 转发后 Host 不是 loopback，原生请求会被 local-request-security 判 403。`RAI_ALLOW_REMOTE_TOKEN_AUTH` 对 iOS 不是必需（无 Origin 的请求在两条分支都放行），但 `deploy-cloud` 测试钉住了该 env 行，退役它要单独改测试并走安全评审。

**开发流**：`npm run dev:device` 只启动 API（`RAI_API_HOST=0.0.0.0`）并注入/打印开发用 `RAI_API_TOKEN`；旧的「vite 代理 5173」路径随 `apps/web` 一起消失。`RAI_WEB_PORT`/`RAI_ALLOW_LAN_DEV` 仅服务浏览器跨源，已随 Web 退役清理。

**部署**：API 不再托管静态文件，nginx 只反代 `/v1`，站点根路径与 `/assets/*` 一律 404；systemd 前置检查删掉 `check-web-build.mjs`，发布脚本不再构建前端。回滚 = revert 退役批次 + 恢复备份的 nginx/systemd 文件；数据库 schema 未改动。

