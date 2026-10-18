# 训练计划功能审查（2026-10-18）

- 总报告：[TRAINING_PLAN_REVIEW_2026-10-18.md](../TRAINING_PLAN_REVIEW_2026-10-18.md)
- 分 lane 详细证据（只读审查产物，未提交改动）：
  - [01-api-read.md](01-api-read.md)：API 读路径、快照一致性、错误映射
  - [02-api-write.md](02-api-write.md)：写路径、发布操作幂等、回执 v2、并发
  - [03-domain-algorithms.md](03-domain-algorithms.md)：周期化、依从性、剂量、跨语言摘要
  - [04-ios-client.md](04-ios-client.md)：iOS 状态机、缓存、WorkoutKit 排期、回执、UI
  - [05-docs-contracts-tests.md](05-docs-contracts-tests.md)：文档/契约单源、测试覆盖、门禁与本机验证
- 批次 A 修复记录：[FIXES_BATCH_A_2026-10-18.md](FIXES_BATCH_A_2026-10-18.md)（3 个 P1 的代码改动、回归与验证结果）
- 批次 B/C 修复记录：[FIXES_BATCH_BC_2026-10-18.md](FIXES_BATCH_BC_2026-10-18.md)（3 项残留风险 + P2×18 + P3×21 的修复、回归、全量套件与 iOS 门禁结果）
- 口径：本目录是 2026-10-18 的审查证据，不是产品规范或实施计划；结论、严重度与修复顺序以总报告为准。
  分 lane 报告保留各自审查员的分级，与总报告分级不一致处以总报告为准（总报告 §1.3 说明重判规则）。
