# iOS 模型离线评估记录

- 评估日期：2026-09-25（Asia/Shanghai）
- 数据库：`/Users/ta/running/var/rai.sqlite`
- 截止时间：`2026-09-25T00:00:00.000Z`
- 执行命令：
  ```bash
  node --import tsx packages/application/src/prediction-walk-forward-cli.ts \
    --database var/rai.sqlite \
    --as-of 2026-09-25T00:00:00.000Z
  ```

## 结果

当前数据库没有可用于 walk-forward 的已标记比赛/测试结果：

- `labeledOutcomeCount`: 0
- `evaluatedOutcomeCount`: 0
- 5K/10K/半马：均为 0 样本
- MAE/RMSE/MAPE：无统计值
- 区间覆盖率：无统计值
- ML candidate：`insufficient_walk_forward_samples`
- 当前没有 active CatBoost 模型

因此本次**不能得出模型准确率结论**，也不能据此激活 ML、调整校准系数或宣称预测模型已验收。

完整机器可读结果见：

`deliverables/IOS_MODEL_WALK_FORWARD_2026-09-25.json`

## 解释

这不是模型“准确率为零”，而是当前样本中没有同时满足：

1. 有明确的 race/standard-test/time-trial 标签；
2. 标签在预测时点可用；
3. 有足够历史信息进行无未来泄漏的评估。

当前真实库仍可用于验证模型输入链路。修复后已确认：

- `performanceVdotEvidenceCount = 11`
- readiness 状态为 `available`
- readiness 证据数量为 12

## 下一步

需要积累至少一批带明确协议的真实结果，建议每个距离分别达到项目既定 walk-forward 最低样本门槛后再评估。每次新增结果后重新运行上述命令，并比较：

- raw 与 calibrated 的 MAE/RMSE/MAPE；
- 5K、10K、半马分别的区间覆盖率；
- readiness 缺失与可用样本的误差差异；
- candidate 相对 baseline 是否在任一距离退化超过 5%。
