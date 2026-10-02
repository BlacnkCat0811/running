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

**裁剪必须切断穿越**：只删区内的点会留下一条穿过隐私区的弦 —— 卡片上就是一条直穿家门口的直线。
圆-线段求交把线段切在圆上，`gaps` 报告断了几处（不是"多少段压到圆"，那个数对读者没有意义）。

分享卡路由**需要令牌**（轨迹几何 + 裁剪元数据）；隐私区读路由同样需要令牌（家/公司坐标）。

## D7. 设计资产、文档和隐私

大设计图已出库，不再次搬回仓库；[blob size检查](../scripts/check-blob-size.mjs)按路径无关的文件体积守卫，不能换目录绕过。
图片展示/验收资产与生产代码分开；保留有用途的视觉文件，不把旧截图视为当前构建已通过。
一主题一份现行文档；历史记录从Git查阅。核验证据必须保留库/时点/版本边界，不复制多台机器报告成多个“当前状态”。
真实XML/GPX/健康SQLite/Token、上传与备份不入库，也不向外部搜索或日志泄露。
