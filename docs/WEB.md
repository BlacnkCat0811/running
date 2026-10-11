# Web 页面与交互合同

生产入口：[App](../apps/web/src/App.tsx)——按 `document.documentElement.dataset.shell === "ios"` 分发两套皮肤：桌面 SPA（`BrowserApp`）与 iOS 移动壳（[IosMobileApp](../apps/web/src/ios/App.tsx)）。桌面1440×900，最低主动支持1024px；820/480媒体查询、mobileNavigation及390px用例冻结，见[范围](../AGENTS.md)。

## 页面责任

| 页面 | 责任 |
|---|---|
| 概览/今日 | 展示能力、覆盖和训练安排；状态缺失不伪装成正常 |
| 训练/详情 | 筛选/分页、同步时序与路线、反馈revision、任务后续分析状态；环境只读视图（原始温湿度/爬升、修正量、等效配速与理由码）、分段坡度/等强配速、跑姿动态、分享卡片 |
| 趋势/统计 | 个人同版本轨迹、负荷/分区/记录；模型标尺切换不能冒充体能变化 |
| 计划/目标 | **仅 iOS 移动壳**：周计划只读详情（`/week`，[Week.tsx](../apps/web/src/ios/Week.tsx)）、周目标（轻松跑时长下限、质量课上限、比赛目标，`/v1/mobile/goals`，[Settings.tsx](../apps/web/src/ios/Settings.tsx)）、今日安排的锁定与重锁（`/v1/mobile/lock`，`action` 取 `lock`/`relock` 并带 `expectedRevision`，[Home.tsx](../apps/web/src/ios/Home.tsx)）。**桌面 Web 无该页**。所处阶段/本周量带/依从性/重排属服务端 §20 契约（`MobileTodayResponse` 的 `periodization`/`adherence`/`replan`），仅由**原生 iOS**（[TechCoachWeekSection.swift](../apps/ios/RAI/Skins/Technology/TechCoachWeekSection.swift)）呈现，**Web 两侧均不渲染**；周计划生成受阶段量带约束（超量按比例压缩并给说明）在服务端（[coach-loop-runtime.ts](../apps/api/src/coach-loop-runtime.ts)） |
| 成绩预测 | 情景、方法、证据、fallback；未校准参考区间不标P80/P90；手工成绩录入与撤销（按录入时刻起算）；比赛候选的一键确认（理由随候选显示，确认走同一写入路径）；个人自校准进度（还差哪些门槛，未达标不给区间） |
| 数据与模型 | 导入、任务取消/终态、只读模型比较与受控训练/激活；数据审计页显示环境字段可得率（键存在但读不出数值不算可得） |
| 设置 | 连接、分区、备份/恢复/删除确认与数据覆盖；隐私区编辑（分享卡片的裁剪依据） |

## 写请求

服务端合同：[api-contracts](../packages/api-contracts/src/index.ts)、[schemas](../apps/api/src/schemas.ts)。
异步命令202/queued不是成功；客户端读终态。idempotencyKey用于同次重试，expectedRevision用于拒绝并发覆盖，二者不能互相替代。
409保留草稿并要求读取新版本，不静默覆盖；退出页面/网络取消不等于服务端取消已接受命令。
反馈保存与派生重算是两项状态：重算失败不抹掉已保存反馈，也不能显示为分析已更新。

## 新鲜度与缺失

分别显示响应生成时间、训练截至日期、健康样本截至时间、同步状态、恢复覆盖。
今天没有恢复读数是覆盖缺口；不能自动变红、低分、阻止所有安排。网络错误不是“数据积累中”。
备份/恢复/删除需明确确认；脱敏CSV仍可能暴露训练习惯，应先预览再导出。

## 验收

[单元测试](../apps/web/package.json)覆盖请求/状态及呈现（含 iOS 移动壳 [ios-mobile-app.test.tsx](../apps/web/test/ios-mobile-app.test.tsx)），[桌面E2E](../apps/web/e2e/web-flows.test.ts)覆盖导航、1024px约束、1440px流程、反馈/分区冲突。
`npm run test:e2e:web`排除390px；不因修改共享合同顺手改冻结窄屏。
没有截图/浏览器证据时不能仅凭build成功宣称视觉完成。
