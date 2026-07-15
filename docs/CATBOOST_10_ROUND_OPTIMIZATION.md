# CatBoost 直接激活链路：10 轮优化审计

> 历史验收快照：下列数量是该轮审计完成时的证据，不是当前测试清单。当前命令及覆盖范围以根目录 `README.md` 和 `AGENTS.md` 为准。

## 结论

十轮优化已完成。当前实现满足：只使用已完成的真实比赛/标准测试标签；Python walk-forward 与 TypeScript 激活门槛保持同一版本；artifact 可复现且可完整校验；worker 可从崩溃恢复并防止旧进程激活；生产只使用 Node ONNX；离线通过后直接原子激活；真实数据库零标签时稳定回退公式。

## 十轮结果

| 轮次 | 发现的问题 | 已实施改进 | 验收证据 |
|---|---|---|---|
| 1. 防未来泄漏 | 标签按开始时间可见，长时间比赛可能在结束前进入后续样本 | 标签必须在 `completedAt` 后才可见；Python walk-forward 每个目标只训练 `completedAt <= target.observedAt` 的样本；训练截止时间拒绝未完成标签 | `does not expose a labeled outcome until the workout has completed`；Python completed-before-prediction 测试 |
| 2. Artifact 可复现性 | CatBoost ONNX 包含随机 GUID 和完成时间；只校验 model 文件 | 移除非语义随机元数据并确定性序列化；manifest 增加输入文件 SHA，以及 model/schema/evaluation 三个 payload 文件 SHA；runner 逐文件验证 | Python 相同输入两次导出 hash 完全一致；13/13 Python 测试 |
| 3. 激活门槛一致性 | Python 参数包含 `thread_count=1`，TypeScript 配置快照缺失；门槛可能漂移 | Python thresholds、CatBoost 参数、修正上限、ONNX tolerance 全部由 runner 与 TS 常量逐项比对；区间修正统一为乘法 | runner contract 校验；合成数据 MAE 门槛和 ONNX parity 通过 |
| 4. 任务生命周期 | 多次提交、进程崩溃、旧 worker 返回和重试写同一目录可能造成冲突 | SQLite single-flight 唯一索引；worker token、heartbeat、30 秒租约、最多 3 次尝试；完成/取消/失败 token fencing；同输入幂等；每次重试独立 `attempt-N` artifact | 幂等、并发冲突、租约恢复、旧 worker fencing、取消、重试耗尽和 artifact 隔离测试 |
| 5. Node 推理安全 | manifest 校验较宽松；运行时重复构建公式基础并执行无用 ridge 拟合；可能将历史 bias 与 CatBoost 叠加 | 严格验证 accepted 状态、版本、SHA、枚举、重复特征、ONNX 输入输出类型和维度；缺失/非有限特征拒绝；运行时移除 ridge 候选计算并复用同一 Formula Base；CatBoost 成功时从未校准 raw baseline 修正 | manifest 单测；真实 ONNX smoke；合成 active 推理三距离成功 |
| 6. 区间与解释 | log residual 是乘法语义，但区间曾按固定秒数平移；CatBoost 与 bias calibration 解释可能混淆 | 中心值和上下界统一乘以 `1 + correctionFraction`；成功距离不再标记 bias applied；保留 ML adjustment、method、evidence code 和逐距离 fallback | 乘法区间单测；端到端三距离区间顺序检查 |
| 7. API 安全 | `asOf` 接受含糊时间；模型 ID 与未知字段限制不足；500 可能泄漏内部错误；数据任务并发判断不完整 | 只接受带时区 ISO 8601；模型路由限定生成式 ID；请求拒绝未知字段；500 返回稳定安全错误；导入、恢复、删除、模型任务统一检查持久化 in-flight 状态 | API schema/ID 测试；60/60 Node 测试 |
| 8. Web 状态体验 | 422 标签不足缺少分距离缺口；active、验证中和公式回退解释不足；键盘与进度语义不完整 | 展示总标签和三距离缺口；明确验证期间继续当前结果、通过后原子激活；区分 active/公式/逐距离回退；ARIA progressbar、live region、skip link、focus-visible 和 390px 触控优化 | Web build；浏览器 E2E 4/4；390px 无横向溢出 |
| 9. 迁移与真实库 | 旧库可能先被只读接口访问而未迁移；worker 租约字段缺失 | migration v5 新增租约字段和 single-flight；API 启动时主动迁移并调度恢复；迁移前自动生成 `before-v5` 备份 | 真实库 migration 1-5；`quick_check=ok`；0 外键错误；核心表行数不变 |
| 10. 全链路 | 单元测试不能证明 Python、worker、SQLite、ONNX 和实时 API 真正连通 | 用独立 SQLite 构造 51 个真实结构化标签，经过 API worker 完成训练、验证、artifact 发布、事务激活和 Node 推理 | run `succeeded/active`；51 标签、21 holdout；ONNX 最大误差 `3.73e-8`；三距离均为 `catboost_residual_v6` 且无 fallback |

## 最终验证矩阵

- TypeScript 类型检查：通过。
- Node 单元/集成测试：60/60。
- Python 测试：13/13。
- 浏览器 E2E：4/4。
- Web production build：通过。
- npm audit：0 vulnerabilities。
- 真实数据库：488168 health records、279 workouts、252 groups、252 sessions、1008 features、4 model runs、1008 assessments，迁移前后不变。
- 当前真实标签：0；训练 API 返回 422 `insufficient_labeled_outcomes`；三个距离均回退 `no_active_model`。

## 保持不变的产品边界

- 不使用普通训练伪造监督标签。
- 不运行或持久化 CatBoost 影子候选。
- 离线门槛未通过时不得激活。
- CA/TA 的 `rai-model-config-v2` 保持冻结。
- Python 不参与生产实时推理。
