# 开发过程尝试记录（非最终验收）

这些日志来自阶段 5 实施过程中的失败/中间运行，保留用于说明缺陷曾被复现、修复后由最终日志取代：

- `f1-before.log` / `f1-after.log`：F1 handler 重放缺陷的前后定向探针。
- `f2-before.log`：F2 能力组合检查的失败前记录。
- `f7-before.log` / `f1-before.log`：F7 latch 与 F1 的失败前证据。
- `phase5-current*.log`、`commands-after.log`、`server-in-progress.log`：实施中的定向测试迭代。
- `model-*.log`、`ios-*.log`、`publisher-*.log`：iOS 编译/回归迭代；其中失败行是**当时**的缺陷，不以本目录日志作为最终通过证据。
- `initial.diff`：审查基线上的初始变更快照。

最终通过证据在上一级目录：`full-suite.log`、`targeted-api.log`、`test-ios.log`、`visual-run.log` 等。
