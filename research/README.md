# CatBoost 残差研究与发布合同

生产 API 只需要 Node（iOS 是唯一客户端，不再有 Web 构建产物）；Python用于用户明确发起的离线训练/评估，不是`npm start`的前置。
整体语义见[算法](../docs/ALGORITHM.md)，运行边界见[架构](../docs/ARCHITECTURE.md)。

## 环境

Python3.12为参考环境，3.13用于本地开发；依赖由[requirements.lock](requirements.lock)固定。

```bash
npm run ml:bootstrap
npm run ml:check
npm run ml:test
```

`RAI_PYTHON`可选择受管环境；不要为运行API自动安装/启动训练栈。

## 数据

[contract.py](rai_ml/contract.py)当前为`race-residual-feature-v4`；特征顺序、schema hash必须与TS导出器完全一致。
UTF-8 JSONL按真实时间/事件稳定排序。null是唯一合法数值缺失标记，不能填0制造样本。
监督标签仅限已确认且合格的5K/10K/半马标准测试/比赛；普通训练、CA/TA不是标签。
事件结束、标签可得时间和locked cutoff必须满足防泄漏约束；更正、撤销与重复事件不能悄悄污染holdout。

```text
targetLogResidual = log(actualSeconds / baselinePredictedSeconds)
```

## 训练与工件

```bash
npm run ml:train -- --input /absolute/path/dataset.jsonl --output /absolute/path/new-artifact-dir --data-through-at 2026-09-30T00:00:00.000Z
```

参数以[训练入口](rai_ml/train.py)和[Python环境工具](scripts/python-env.mjs)为准。工件目录必须是新目录，内容/manifest/hash不可原地覆盖。
输出包括ONNX、manifest、feature schema、evaluation、ONNX golden及三方challenger证据。

## 发布不是训练成功

[TS模型服务](../packages/application/src/prediction-model-service.ts)与[Python pipeline](rai_ml/pipeline.py)执行样本数、事件时间切分、embargo、独立holdout、分距离退化、paired bootstrap、原生/ONNX/Node parity和工件hash检查。
残差限制±12%；最终point policy不叠加多个校准器。无active/不兼容/推理失败时逐距离回退公式并给原因码。
CatBoost须与同样本公式基线、Ridge公平比较，并满足独立区间calibration/test闸门。不能用重复holdout调参后继续称“独立”。
**进程exit0或model run succeeded不等于已满足所有active选择条件**；以发布服务和选择器为准。
无真实标签时完整工程合同仍可测试，但准确率指标必须null，不激活ML/经验P80/P90。
