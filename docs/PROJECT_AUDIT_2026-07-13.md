# RAI 全项目多智能体审查与优化报告

> 日期：2026-07-13  
> 范围：数据库、导入、任务队列、Feature、RAI、训练负荷、预测、API、Web、E2E

## 已修复的高优先级问题

1. 心率区间被截成 30 秒，长区间训练负荷严重低估。
2. Feature 心率和速度记录等权平均，覆盖率忽略中间空洞。
3. 生理预测可能读取尚未结束训练的最终数据。
4. active 指针切换与任务完成不原子，可能指向 failed Run。
5. 手动激活可选择没有成功 Training Metric Run 的旧模型。
6. active 视图未防御 failed Model Run。
7. 导入更新遗漏 `statistics_participation`、负荷历史和 active Prediction Model。
8. 新来源副本改变 Session 哈希后，覆盖和历史关联丢失。
9. 中断的 recompute job 永久停留在 running。
10. 重算阻塞 Fastify 主线程，取消和进度查询无法及时响应。
11. 统计概览对每条路线重复查询，接口耗时约 0.7～1.1 秒。
12. Web 快速切换周期存在旧响应覆盖新响应。
13. 重算失败或取消仍显示为“进行中”。
14. 历史图时间方向倒序，移动端更多子页面无 active 状态。
15. 覆盖抽屉缺少 Dialog 语义、焦点约束、Esc 关闭和焦点恢复。

## 关键优化结果

- 统计概览热请求约从 700～1100 ms 降至 11～18 ms。
- 重算迁移到 Worker Thread，API 主线程保持可响应。
- 启动时恢复中断任务；未取消任务重新排队，部分 Run 标记失败并保留诊断。
- 历史导入通过时间重叠、距离和一对一约束恢复稳定 Session ID。
- active 切换、job 完成和完成事件合并为单事务。
- Feature 与负荷算法升级为 v2，旧 Run 保留。
- 两条不合理训练被可逆隔离，最大单次负荷从 1222.23 降至 387.29。

## 验证

- TypeScript：73 项通过。
- Python research：13 项通过。
- Web E2E：4 条通过，覆盖真实数据、390px、导入、覆盖重算和模型切换。
- SQLite：`quick_check=ok`，外键错误 0。
- 真实数据：252 Session 完整保留，active v2 成功回放。

## 后续仍建议处理

1. 数据库导入/恢复使用 rollback 文件实现更强的进程级原子替换。
2. 恢复备份时校验完整 schema、migration checksum 和关键行数。
3. Prediction Python 训练使用 Windows Job Object，确保取消时终止整个进程树。
4. CatBoost 获得足够标签后加入配对 bootstrap 改善下界和分距离最小 holdout。
5. 间歇跑识别升级为快慢段结构检测，速度 CV 只作为候选信号。
6. 为图表补键盘点选和读屏替代表格。
7. migration checksum 纳入迁移正文并在启动时检查 drift。
