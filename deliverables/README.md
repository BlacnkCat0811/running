# 核验产物

现行说明统一从 [项目README](../README.md) 进入；审查结论只维护 [PROJECT_REVIEW](../docs/PROJECT_REVIEW.md)。
本目录不是第二套产品规范/实施计划，不保存**重复批次** Markdown 或 archive 副本。当轮尚未收尾的审查
报告可以临时列在下方「当轮审查」一节，并在下一轮并入 `PROJECT_REVIEW` 或删除。

## 当轮审查（未提交改动）

已收尾批次（2026-10-09 ~ 10-11）的原文档已删除，指针见 [项目审查 §8](../docs/PROJECT_REVIEW.md)。

- [IMPORT_PUBLICATION_REDESIGN_2026-10-11.md](IMPORT_PUBLICATION_REDESIGN_2026-10-11.md)：**多智能体对抗式审查**——
  「每次同步整库换文件」是否设计错误。3 个专项智能体（存储架构 / 数据口径 / 运维节奏）+ 1 个红队 + 主代理逐条复核。
  含一次被推翻的红队 top1（"提前判定后跳过发布"会丢数据，实测该批 `record inserted 18`）、
  `cli.ts:197-202` 原文证明装库后那道全库校验不能删、以及按优先级排的 3 件事（加内存 / 裁台账 / 去冗余拷贝）。
  ⚠️ 同为**当轮**产物：收尾后并入 [OPERATIONS](../docs/OPERATIONS.md) / [项目审查](../docs/PROJECT_REVIEW.md) 或删除。

- [API_HANG_TRIAGE_2026-10-11.md](API_HANG_TRIAGE_2026-10-11.md)：**当轮线上事件处置与取证手册**
  （线上 API `/v1` 整段不答 → 定位到导入管线耗时 → 拆阶段插桩 P0-a）。含 P0 抓现场+重启命令、六条取证判据、
  云机实测（磁盘直读 376 MB/s / 直写 234 MB/s；**独立进程对同一份 2.16 GB 库做在线备份只要 12.4 s，
  管线内同名阶段却报 254 s**）、两次被实测证伪并**撤回**的假设（"进程卡住"、"fsync 次数 × 延迟"），
  以及两条可复用手法：「阶段必须平铺互斥（`totalMs >= ΣstagesMs`）」与
  「改联合类型后必须扫旧名字 —— `!includes(...)` 型守卫会静默变恒真，只会红的那一半救不了」。
  ⚠️ 同为**当轮**产物：收尾后并入 [OPERATIONS](../docs/OPERATIONS.md) / [项目审查](../docs/PROJECT_REVIEW.md) 或删除。

- [UNCOMMITTED_REVIEW_2026-10-11.md](UNCOMMITTED_REVIEW_2026-10-11.md)：**最近已提交批次**
  `14bda36..5950a11`（今日 5 个提交：纯补史门禁豁免 `cebb0dc` + iOS `jobId` 前台续接 `076b8bd`
  + live 探针清单 `6ea930f` + 两份验收文档）的分级审查（**0 条 🔴 / 3 条 🟡 / 12 项 ✅**）——
  按「智能体协作」分三路并行复核（后端 / iOS / 文档）+ 主智能体亲验全部关键结论，
  附门禁实跑（`typecheck` / `npm test` / `test:ios` 全 EXIT=0）与后端门禁突变验证。
  同批**已把三条 🟡 全部处理完毕**（§八）：新增 4 条库级测试直击生产删除方法的账本写入、
  1 条「生产路径删除 + 读证据」端到端用例，并把「realign 去重不写账本」改为断言钉住 ——
  **产品代码零改动**，`npm test` 干净重跑 `1550 tests / 1547 pass / 0 fail`、3 条突变逐条变红。
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
