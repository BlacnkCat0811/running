# 架构与数据计算模型实施记录

实施角色：Luna（high）。范围为桌面 Web、API 和共享包；未修改原生客户端、冻结响应式 CSS、实际用户数据库或 active 模型。

## 已实施

- `trueAbilityAfterInactivity` 现在对 0-100 的有效能力值单调不增；20 分以上保留原有 20 分下限，20 分以下不再被停跑衰减抬高，并拒绝非有限输入。
- 评分信号的 `NaN`/无穷值按不可用证据处理。模型配置和个人基线会校验有限值、非负权重及正尺度，避免非有限结果写入评分结果。
- 校准与模型回放按实际时间戳排序，等时按 `trainingSessionId` 和 feature ID 稳定排序；无效时间显式失败。评分配置版本由 v3 升至 v4，因此旧 checkpoint 不会被增量复用。
- 预测公式恢复度读取抽取到 `SqlitePredictionRecoveryReadRepository`。canonical HRV 表存在时优先使用 canonical 值；canonical 睡眠只使用 `asOf` 前 7 天内的已完成主睡眠，基线保持原有平均值窗口。旧库只在 canonical 表缺失时使用原始 HRV，缺表兼容不再吞掉其他 SQL 错误。所有查询使用规范化 `asOf` 和传入时区。
- 预测报告可显式传入时区；当前 API、canonical 化和重算入口均沿用已配置的 `Asia/Shanghai` 默认，避免读取时区与 canonical 写入时区脱节。
- 删除恢复度读取中未参与最终结果的训练负荷查询。保留原有恢复度平均公式，未引入未经验证的权重。
- 公式预测基线版本由 v1 升至 v2，现有 prediction model 的能力基线 hash 因版本变化而失配，旧残差模型不会静默复用。

## 验证覆盖

新增测试覆盖低能力停跑边界、非有限原始信号、坏基线/配置、混合时区和等时排序，以及恢复读取中的 canonical 与原始 HRV 冲突、过期睡眠、未来完成样本、旧库缺表和坏 schema 传播。

已执行并通过：

- `node --import tsx --test packages/scoring/test/scoring.test.ts packages/storage-sqlite/test/prediction-recovery-read-repository.test.ts packages/application/test/prediction-data.test.ts`
- `npm run typecheck`
- `npm test`（446 个 Node/API/包测试，Web 59 个测试）
- `npm run build`

根任务随后执行了桌面 Web E2E：10 个通过，0 个失败，1 个冻结移动用例跳过。

## 剩余关注

本轮没有重新拟合恢复或比赛预测权重，也没有重新计算真实数据。`prediction-data.ts` 仍包含其他预测证据 SQL，后续可按同一 repository 边界继续拆分；重算 pipeline 的职责拆分也保留为后续架构阶段。
