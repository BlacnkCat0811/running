# PR3a/PR3b 生产级实施与验收

## 设计边界

- canonical_nights/canonical_hrv_days 是睡眠与 HRV 唯一事实源；`InBed` 不计入睡眠，午睡不替代主夜。
- 每次 workout 的 recovery 只使用 workout 开始前已完成的数据：主夜 `wake_at < workout_start`，HRV 必须关联该夜，RHR 使用前 36 小时 Watch 优先样本。
- 个人基线按本地日计算：先取前 28 天中位数，少于 7 个有效日时回退前 60 天；严格排除当天及未来样本。
- recovery 权重固定为睡眠 35%、RHR 25%、HRV 25%、负荷 15%，按可用信号归一化；只有负荷时返回 null，平常负荷不扣分，仅超出基线部分扣分。
- 训练状态使用每个本地日的 `PhysState`（三夜窗口为 D、D-1、D-2）；`recovery_evidence` 仅为兼容字段并保持 null。

## 发布流程

1. 导入或变更健康数据后先运行 canonicalization，再创建候选 feature/model run。
2. 以当前 `active_model_run` 为 incumbent，候选重算完成后执行 `rai-shadow-gate-v1`（有 incumbent 时强制执行）。门禁检查空值率、可评估 session 数、CA 均值/P95、最终 TA、状态变化率、恢复饱和率及数值范围。
3. 门禁结果写入 `model_validation_gates`。失败时候选标记失败且 incumbent 保持不变；通过（或无 incumbent 时 skipped）才允许激活。
4. 激活模型会清理 active prediction model，要求重新训练与当前 feature/model fingerprint 一致的预测模型。

## 验收阈值

| 指标 | 阈值 |
| --- | ---: |
| recovery null-rate 增量 | <= 0.10 |
| eligible session 相对变化 | <= 5% |
| current ability 平均绝对变化 | <= 8 |
| current ability P95 绝对变化 | <= 15 |
| final true ability 绝对变化 | <= 10 |
| assessment status 变化率 | <= 10% |
| recovery 饱和率 | <= 20% |
| 非法值 | 0 |

## 回滚

门禁失败不会更新 `active_model_run`。已激活模型可通过现有 model-run 激活接口回切到最近的 succeeded run；预测模型需按 fingerprint 重新训练。
