# 核验产物

现行说明统一从 [项目README](../README.md) 进入；审查结论只维护 [PROJECT_REVIEW](../docs/PROJECT_REVIEW.md)。
本目录不是第二套产品规范/实施计划，不保存**重复批次** Markdown 或 archive 副本。当轮尚未收尾的审查
报告可以临时列在下方「当轮审查」一节，并在下一轮并入 `PROJECT_REVIEW` 或删除。

## 当轮审查（未提交改动）

- [UNCOMMITTED_REVIEW_2026-10-09.md](UNCOMMITTED_REVIEW_2026-10-09.md)：HealthKit 记录同步 v2
  （v30/v31 迁移 + 逐类型变更游标 + 类型作用域 UUID 删除）等 44 项未提交改动的分级审查
  （1 条 🔴 部署动作 / 8 条 🟡 / 12 项 ✅），附门禁实跑与突变验证。
  ⚠️ 这是**当轮**产物：收尾后并入 [项目审查](../docs/PROJECT_REVIEW.md) 或删除，不长期保留。

- [UNCOMMITTED_REVIEW_2026-10-10.md](UNCOMMITTED_REVIEW_2026-10-10.md)：iOS 数据同步失败修复
  （普通同步不再全量重扫记录 + 导入失败诊断可见 + 失败上传包保留）的分级审查与**同批修复记录**
  （1 条 🔴 / 3 条 🟡 / 9 项 ✅），附门禁实跑、三次突变验证与四项排除测试。
  ⚠️ 这是**当轮**产物：收尾后并入 [项目审查](../docs/PROJECT_REVIEW.md) 或删除，不长期保留。

- [VERIFICATION_2026-10-11-source-backfill.md](VERIFICATION_2026-10-11-source-backfill.md)：线上
  iOS 同步失败（纯补史导入被资格漂移门禁死锁）的**修复验收证据**——同库同码同基线的 A/B 对照、
  真实库导出的门禁判定载荷、4 条突变验证与未验证项边界。
  ⚠️ 这是**当轮**产物：收尾后并入 [项目审查](../docs/PROJECT_REVIEW.md) 或删除，不长期保留。

- [VERIFICATION_2026-10-11-ios-resume.md](VERIFICATION_2026-10-11-ios-resume.md)：iOS 同步「带
  `jobId` 的任务坠进导出路径」+「最长一段无进度」两个缺陷的**修复验收证据**——根因判据、改动落点、
  门禁实跑（274/26/14 checks 全 0 failed）、5 条新增突变逐条变红，以及**未验证项**（含 iOS 侧未跑
  模拟器/真机、③「导出前短路」因协议层受阻未纳入本轮的说明）。
  ⚠️ 这是**当轮**产物：收尾后并入 [项目审查](../docs/PROJECT_REVIEW.md) 或删除，不长期保留。

## 保留的固定时点证据

`v2-audit-2026-09-30/` 是macOS本机固定截止的算法实施核验：

- `baseline.json`：源码版本与原库聚合元数据；原库schema22、268次训练，不代表线上状态。
- `normalization.json`：该库metadata天气覆盖盘点，不是归一化精度。
- `walk-forward.json`：零有效标签、指标null，不是准确率0。
- `load-replay.json`：已发布派生负荷快照的可得性对照，不是原始记录级历史回放。
- `release-rehearsal.json`：只在临时backup副本上的schema25/V4重算、同轨迹、回滚/重开与条件明确的性能原始轮次。
- `verification.json`：命令、结果、来源文件hash和原库前后hash。

这些文件记录的是生成时的证据，含有清理前的文档路径/工作树hash；不要改写历史hash，也不要把过去检查结果当作今天重新跑过。
当前文档映射和本轮检查见[项目审查](../docs/PROJECT_REVIEW.md)。已过期Windows报告、旧行号快照及重复阶段产物从Git恢复，不保留为“当前”。

## 新产物约定

实验/临时输出优先`var/reports/`；只有用于明确验收的脱敏证据才保留到本目录。
至少记录database identity/hash、as-of、时区、代码/配置版本、复现命令、通过/失败/不可评估与原因。
不得提交原始健康数据、Token、精确路线、上传ZIP或SQLite。

## 当前项目审查证据

`project-review-2026-09-30/`保留本轮必要的两份机器文件，不增加第二份Markdown报告：

- [model-boundaries.json](project-review-2026-09-30/model-boundaries.json)：R1–R3临时合成库复现，3项违反预期不变量；不是通过报告。
- [verification.json](project-review-2026-09-30/verification.json)：文档删除/保留映射、检查结果、来源hash与明确未验证项。

解释和修复优先级统一维护在[项目审查](../docs/PROJECT_REVIEW.md)。

后续四项修复保留独立“修复后”证据，不覆盖原始失败记录：

- [model-boundaries-after.json](project-review-2026-09-30/model-boundaries-after.json)：同一组R1–R3探针，3项违反降至0项。
- [fixes-verification.json](project-review-2026-09-30/fixes-verification.json)：修复机制、源文件hash、回归结果、副本演练摘要及未验证Windows现场的边界。
