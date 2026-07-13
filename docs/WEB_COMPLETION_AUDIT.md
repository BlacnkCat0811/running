# RAI Web 完成度审计

审计日期：2026-07-10

最终签署：2026-07-11 02:41（Asia/Shanghai）

本审计以 Web 产品边界为准：浏览器不能直接读取 HealthKit，因此数据入口是用户从 iPhone 健康 App 导出的本机目录。iOS HealthKit 授权、后台 delivery 和 App Store 发布不属于 Web 交付。

## 1. 功能闭环

| 范围 | 当前证据 | 结论 |
|---|---|---|
| Apple Health 数据导入 | XML/GPX 流式解析、canonical 去重、252 个稳定 Training Session；合成数据浏览器 E2E 完成首次导入和二次导入 | 完成 |
| 导入更新可靠性 | 临时 SQLite、在线备份、历史覆盖/模型迁移、完整重算、原子激活、任务状态落盘 | 完成 |
| 数据库 | 事务化迁移、外键、active 视图、不可变 Run、备份、删除、恢复、`quick_check`/`foreign_key_check` | 完成 |
| 跑力模型 | Feature、CA、五维、置信度、TA、负向保护、非线性增长、Decay、GV、贡献、确定性回放 | 完成并保持 `rai-model-config-v2` 冻结 |
| 概览 | TA、7 日变化、CA/TA 差、GV、校准、Decay、解释、最近训练、重算状态 | 完成 |
| 训练列表 | 八类服务端筛选、分页、未评分原因、来源/环境/路线、URL 状态保留 | 完成 |
| 训练详情 | 基础表现、能量、爬升、步频/跑姿、路线、公里点、八类时序、评分证据、Override/RPE/备注 | 完成 |
| 趋势 | 5 个时间范围、TA/CA、Decay、模型点、五维趋势、跑量/负荷图层、训练详情入口 | 完成 |
| 生理与成绩预测 | VO₂max、有效 VDOT、乳酸阈值、5K/10K/半马、区间、准备度、环境/爬升/疲劳修正与场景交互 | 完成 |
| 预测准确性治理 | 无未来泄漏 walk-forward、同距离偏差校准、Ridge 持出门槛、自动保持公式基线 | 完成；真实标签不足时明确不激活 ML |
| 数据与模型 | 导入、任务详情/取消、完整重算、不可变历史、Run 对照、active 切换、数据审计 | 完成 |
| 设置与隐私 | 数据资产、模型状态、脱敏诊断、备份/恢复/删除、时区、健康免责声明 | 完成 |
| 响应式 | 桌面侧栏、390px 底部导航、表格转列表、详情/趋势/设置无横向溢出 | 完成 |

## 2. 当前真实数据验收

- Health Record：488,168
- 原始 Workout：279
- canonical / Training Session：252
- Route：43
- Route Point：88,066
- active Model Run：唯一
- active Assessment：252
- Schema migration：v3 `structured_performance_protocol`
- SQLite `quick_check`：`ok`
- SQLite `foreign_key_check`：0 条问题

浏览器自动化对真实数据库只执行只读回归。最终收尾通过项目迁移器将真实库从 v2 升级至 v3；迁移前自动生成 `rai.before-v3.*.sqlite` 完整备份。迁移前后关键计数完全一致：488,168 条 Health Record、279 个 Workout、252 个 Group/Session、1,008 条 Feature、4 个 Model Run、1,008 条 Assessment。

## 3. 自动化证据

最终在 2026-07-11 重新执行 `npm run test:all`，退出码为 `0`，覆盖：

- TypeScript 全仓类型检查；
- 42 项单元与集成测试；
- 4 项浏览器 E2E；
- Vite 生产构建。

浏览器 E2E 包含真实数据只读路径，以及完全隔离的合成数据写入路径：首次导入、Override、重算、模型切换、二次导入历史保留、删除、备份恢复和首次启动恢复。

本次结果为 42/42 单元与集成测试通过、4/4 浏览器 E2E 通过，Vite 生产构建成功。E2E 新增预测页面、比赛场景、非法/未知查询参数、预测响应隐私和 390px `/predictions` 溢出检查。

最终重新执行 `npm audit --audit-level=moderate`，退出码为 `0`，共发现 0 个漏洞。

## 4. 运行态签署

- 已停止早于最后后端修改时间启动的旧 API 进程。
- 最新 API 于 `2026-07-11 02:39 +08:00` 重新启动。
- `GET /v1/health` 返回 `status: ok`、`databaseReady: true`、`localOnly: true`。
- `GET /v1/runtime-status` 返回 `busy: false`，没有导入或重算任务占用数据库。
- `GET /v1/predictions` 返回 `rai-physiology-report-v2`；真实基线为 VO₂max `42.59`、有效 VDOT `40.62`、阈值配速约 `4'59"/km`。
- 场景参数 `30°C / 80% / 10K 爬升 150m` 正确产生独立温湿度与爬升时间修正；非法湿度和未知参数均返回 400。
- 本地检查仅发现正式服务监听 `127.0.0.1:8787`；不存在 8790、8791、8792 临时监听器。

## 5. 隐私边界

- API 固定监听 `127.0.0.1`。
- 运行时代码只请求同源 `/v1`，没有第三方分析、遥测或地图请求。
- 精确路线只在本机 API 与浏览器间传递。
- 诊断 JSON 不包含经纬度、原始健康时间序列、来源设备名或 Windows 本机路径。
- 原始导出、SQLite 和备份均由 `.gitignore` 排除。

## 6. 后续演进但不阻塞 Web V1

- 收集更多训练类型、RPE 和标准化测试跑，进行 walk-forward 模型验证；
- 开发 iOS/Watch HealthKit 增量同步端，复用现有 contracts、features 和 scoring；
- 在真实长期数据上继续验证训练负荷定义和三维 Engine/Efficiency/Consistency 模型。

## 7. 交付结论

Web V1 在既定的单用户、本地优先和 Apple Health 导出导入边界内已完成。功能闭环、数据安全、模型回放、桌面与 390px 响应式、异常恢复和自动化验收均已达到本阶段交付条件；后续模型研究与 iOS/Watch 增量同步属于下一阶段，不阻塞本次签署。
