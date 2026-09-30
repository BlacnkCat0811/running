# RAI V2 实施记录与剩余项 — 2026-09-29

## 结论

**本轮已交付可运行、已接入部分真实路径的改动，但没有完成整份 V2 方案。**
不能将此报告理解为 V4 特征上线、数据库升级、发布 bundle 完成或预测精度验收通过。
实施开始时工作区已经包含批次 1–15 的未提交改动；本轮在其上继续开发，没有重置或覆盖这些成果。

## 本轮新增实现

| 项目 | 实际落点 | 实施边界 |
|---|---|---|
| 标签漏斗 | application 的 `buildLabelFunnel`；walk-forward 报告；预测 API 和 Web 预测页 | 同一个 outcome loader 为训练与漏斗提供有效标签，未复制标签标准 |
| 标签排除/更正 | 用户排除不再进入 race outcome；协议必须匹配实际距离；历史 revision 按 as-of 读取 | 标注时间不能倒灌进此前预测；threshold-only 不凑比赛标签数 |
| 标签 UI | 复用已有训练详情标注入口；预测页展示确认、质检与评估数量以及主拒绝原因 | 未自动标记任何用户训练，未诱导新增极限测试 |
| 恢复规则归属 | training-load 的 phys-state 与 prediction 的恢复背景算式委托 `@rai/readiness` | 保留并明确标注 legacy background 语义，不伪称它是今日已校准恢复分 |
| 状态 heuristic 标记 | readiness 统一元数据函数、mobile today API 的 additive 字段 | 不改变现有客户端必需字段；未修改 iOS 代码 |
| 独立 freshness 入口 | `assessDatedReadiness`；每项信号校验 localDate、observedAt、availableAt；连续夜按日期检验 | 纯入口已实现；所有现有 API assembler 尚未统一切到严格日期合同 |
| RHR 隐性通道修复 | 长期参考排除当天，按每日中位数计独立日；基线不足时不回退今日 RHR | 原先“薄历史 fallback 到当天”的边界现已去掉，并增加原始 DB 入口回归 |
| 双基线诊断 | 固定长期基线 + 同课型 28/42 日 adaptive baseline；写入 assessment explanation | 当前 CA/TA 仍使用长期参考，adaptive 不直接重置标尺 |
| Epoch 指纹 | 基于稳定训练身份、配置与 Fitness 维度；不使用含 runId 的 featureId | 同输入重新计算不会仅因新 runId 伪造一次 rebase |
| Rebase 检查 | `reviewBaselineRebase`：检查周期、冷却、独立样本、连续饱和判据 | 只生成候选结论，未实现整套重建发布及历史曲线 UI |
| 权重覆盖 | 最低可用权重按“可用权重 / 配置总权重”计算 | 避免删维度消融仅因剩余权重未归一就全部变 trial |
| 消融回放纠偏 | 复用 live history assembler；恢复停跑衰减和 eligible N 计数；删维度不重新引入 recovery | `v1_current` 只是旧权重在新引擎下的控制组，**不是真正旧引擎回放** |
| 分层报告 | 按 stratum、课型、source category 汇总正负机会/接受；相关性按 stratum 输出 | source category 不等于物理设备身份；天气未知不伪造分组 |
| 无 VO₂ prior 的阈值路径 | 高质量、足够时长、明确协议 threshold test 可独立产出 pace/HR estimate | 普通持续跑、弱证据、未来证据不能救活估计；缺 HR 保持 null |
| 统一评估纯包 | `@rai/model-eval`：同样本三方比较、事件独立性、时间/embargo、经验 log 区间、覆盖与宽度联合检查 | 接入现有评估报告；尚未替换 Python/CatBoost 的完整发布 runner |
| 预测模式 | API 支持 `neutral_potential/current_prepared/race_day_scenario` 和明确 targetDate | 旧默认路径保留；V2 模式不自动使用今日恢复惩罚未来比赛 |
| 预测修正账本 | V2 模式逐项记录 preparation/environment/elevation/acute_readiness 前后秒数 | 逐项重建最终值；暂不应用旧 bias/ML 到新 policy |
| 区间产品边界 | Web 明示参考区间非 P80/P90 保证、可靠性为规则估计；null 准备度不显示为 0% | 经验区间尚未生产激活，未宣传统计保证 |
| Workspace 集成 | 新本地 workspace、依赖与 lockfile 同步；纯 TypeScript 检查覆盖 model-eval | 离线安装，未新增外部依赖库 |

源码版本变更：

- `MODEL_CONFIG_VERSION`：`rai-model-config-v11`。
- `FEATURE_CONFIG_VERSION`：`feature-config-v10`。
- `PHYSIOLOGY_MODEL_VERSION`：`rai-physiology-v1.8.0`。
- 这些是源码版本，不是本地或线上已经激活的模型版本。

## 必须保留的未通过结论

### 1. Bounded comparability 候选未获准启用

对本地 268 条已存 V3 特征回放，28/42 日合格同类训练窗口使 V2-A 的学习更新次数降为 **0**。
因此新增 `comparabilityHistoryMode`：

- `legacy`：默认，明确保留既有累计同类历史政策。
- `bounded`：可离线评估的候选，**没有默认启用**。
- Adaptive baseline 在默认模式下仍作为近期诊断输出；不伪称 bounded 学习门控已通过验收。

同一次报告中，legacy 模式下 V2-A 为 31 次更新、正机会 33/接受 31、负机会 6/接受 0。
这不能证明“已经解决只升不降”，也不能在没有独立真实退步标签时直接认定六次负机会都是应接受的真实退步。
需要继续校准门槛、报告拒绝原因与检测延迟，不按目标接受率强行制造能力下降。

机器可读证据：

- `/Users/ta/running/deliverables/RAI_V2_ABLATION_2026-09-29.json`
- `/Users/ta/running/deliverables/RAI_V2_BOUNDED_CANDIDATE_2026-09-29.json`

### 2. 标签仍不足，真实精度不可验收

固定回放时点：`2026-09-29T06:00:00.000Z`（北京时间 14:00）。

- 训练：268。
- 已确认有效比赛/测试：0。
- 标签漏斗主要拒绝原因：`not_confirmed`，268 条。
- CatBoost 历史 out-of-sample challenger：未提供；比较 gate 为 `not_evaluable`，禁止激活。
- 经验区间：无 calibration/test 标签，未激活。
- 历史健康事实可得时间不完整，报告明确为 `event_time_reconstruction`，不是 as-known-then 认证。

证据：
`/Users/ta/running/deliverables/RAI_V2_EVALUATION_2026-09-29.json`。

### 3. 本地数据库和激活状态没有改变

本轮只读复核：

- SQLite migration 最大版本仍为 **22**。
- active model 仍为 **rai-model-config-v3**。
- active feature schema 仍为 **workout-feature-v3**。
- active model evaluated_at 仍为 `2026-09-04T08:53:46.059Z`。
- prediction_model_runs 为 0，active_prediction_model 为 0。

没有执行本地真实库 migration、全量 recompute、模型激活或生产部署。测试使用临时库。

## 仍未完成的工程项

这些是**尚未完成的代码/接入工作**，不能全部归因于“没有标签”：

1. **V4 特征契约、独立 decoder/encoder 和生产提取/存储/读取全链路**；目前还是 V3 schema，不能只改字符串冒充 V4。
2. **工程版本/配置版本落库彻底分离、新 lineage 与独立 Readiness/Durability 快照迁移**。
3. **transition gate v2 实际发布接入、持久化 not_evaluable、完整 bundle 原子发布、保留依赖与回滚演练**。
4. **所有 assembler 的逐信号 freshness/availability 统一**，以及 Coach 完整 snapshot-only 合同与各消费端展示。
5. **Rebase 发布流程与按 epoch 分段的长期曲线 UI**；纯检查函数不等于用户可用重建。
6. **环境 adapter 的生产统一、V4 可比信号及时间线配对的 decoupling**；未知天气不能用默认值补成实测。
7. **专项耐久、负荷向量、zone 来源/一致性快照贯穿实际 API 与发布 bundle**；此前批次中部分仍是领域函数或诊断字段。
8. **Ridge/CatBoost 同样本三方对比接入 Python runner、artifact/hash 合同、真实激活 gate 与 V4 residual schema**。
9. **区间 calibration artifact 持久化、domain-match 与生产选择器接入**；经验分位数纯函数不等于生产 P80/P90 已上线。
10. **完整跨领域 V1/V2 replay framework 与正式发布报告**；当前复用了预测回放并扩展评估，不能冒充所有领域已可独立回放。
11. **候选参数的实证效果及真实连续退步验收**；本项确实受真实标签/独立案例不足约束。

## 验证

本轮最终验证汇总及各产物 hash 见：

`/Users/ta/running/deliverables/archive/RAI_V2_IMPLEMENTATION_2026-09-29.verification.json`。

验证命令：

```bash
cd /Users/ta/running
npm run typecheck
npm test
npm run test:e2e:web
```

`test:e2e:web` 包含 Web build。390px 响应式用例按项目规则跳过，未修改其测试/基线或窄屏 CSS。
本轮未执行 Python 训练、iOS 测试或线上部署，未创建 Git 提交。

**交付口径：本轮实现和修复有效，但“完成方案中所有未完成项”的总目标仍未达成。**
