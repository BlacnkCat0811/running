# 开发与运维

入口：[README](../README.md)；云端系统配置：[Ubuntu部署](../deploy/README-UBUNTU.md)；iOS：[runbook](IOS_NATIVE_RUNBOOK.md)。
以下命令中的数据库路径必须显式核对。检查源码/生成报告不等于已迁移或发布真实库。

## 开发和门禁

Node22.x/24.x按[版本检查](../scripts/check-node-version.mjs)执行；生产TS通过tsx，不切换执行通道绕过migration校验。

```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run test:e2e:web
npm run check:docs
npm run check:doc-refs
npm run check:acceptance-matrix
npm run check:package-boundaries
```

`npm test`通过[Node入口](../scripts/run-tests.mjs)显式枚举用例并分别启动Node/Vitest，不依赖POSIX shell；两组退出码均影响最终结果。

本地hooks在[pre-commit](../.githooks/pre-commit)；[CI配置](../.github/workflows/ci.yml)存在不证明当前远端已触发它。
完整审查另跑`npm run ml:test`、`npm run test:ios`、按需要`npm run rust:verify`；缺工具/SDK应报跳过或阻塞，不自动安装大型依赖。
390px/responsive不属于默认gate。不要在排障时删除真实健康库、凭证或旧可用工件。

## 迁移：先检查，备份后才apply

```bash
npm run data:migrate -- --database /absolute/path/rai.sqlite
# 维护窗口与备份检查完成后才运行：
npm run data:migrate -- --database /absolute/path/rai.sqlite --apply
```

[迁移CLI](../packages/storage-sqlite/src/migrate-cli.ts)默认只检查；旧migration/checksum不可就地改。
不要与API导入、CLI写者或备份/恢复并行变更同库。备份包含敏感数据，须与主库同等保护。
原库有未应用migration时应明确处理，不靠删库、填伪字段或放宽模型gate让启动变绿。

## 导入、重算与事实回填

首选Web导入ZIP。CLI输入目录导入`--replace`会重建指定目标，只对明确可丢弃副本使用。

```bash
npm run data:audit -- --database /absolute/path/copy.sqlite --report /tmp/rai-audit.md
npm run data:recompute -- --database /absolute/path/copy.sqlite --evaluated-at 2026-09-30T00:00:00.000Z --timezone Asia/Shanghai
npm run data:backfill-canonical-nights -- --database /absolute/path/copy.sqlite
```

最后一个命令的写入选项以[脚本](../scripts/backfill-canonical-nights.mts)为准；先看默认预览，不把建表当历史恢复事实已回填。
重算/refresh、导入和标签更正有不同dirty范围；不能为了“立即显示新版本”修改旧run JSON。

## 只读模型核验

```bash
npm run data:model-v2 -- --database /absolute/path/rai.sqlite --action inspect
npm run data:prediction-walk-forward -- --database /absolute/path/rai.sqlite --as-of 2026-09-30T00:00:00.000Z
npm run data:load-replay -- --database /absolute/path/rai.sqlite --as-of 2026-09-30T00:00:00.000Z --out /tmp/load-replay.json
npm run data:baseline-rebase-review -- --database /absolute/path/rai.sqlite
```

[Load工具](../scripts/load-replay.mts)比较派生快照可得性，不是原始记录级as_known_then认证。
`insufficient_labeled_outcomes`/not_evaluable是正式结果，不能填0错误率或激活ML替代证据。
消融/归一化/速度盘点默认可能写报告文件，但不得写源库；报告必须标库、截止和配置。

## Rebase、校准与回滚

[维护CLI](../packages/application/src/model-v2-cli.ts)默认dry-run；`--apply`才写指定库，并要求schema已就绪。

```bash
npm run data:model-v2 -- --database /absolute/path/copy.sqlite --action review-baseline --as-of 2026-09-30T00:00:00.000Z
npm run data:model-v2 -- --database /absolute/path/copy.sqlite --action review-baseline --as-of 2026-09-30T00:00:00.000Z --apply
```

review只记录前瞻检查历史/候选请求，不发布epoch。rebase需明确更早的`--reference-start`；rollback需`--run-id`和`--expected-active`，且只能回到保留、兼容、完整的bundle。
`calibrate`、`activate-prediction`仍要通过真实标签、配置/工件/独立区间gate，不是绕过质量控制的管理员捷径。
当前已知限制先看[审查](PROJECT_REVIEW.md)，尤其删除/谱系与保留窗口边界。

## 离线发布演练

```bash
npm run data:verify-v2-release -- --database /absolute/path/rai.sqlite --as-of 2026-09-30T00:00:00.000Z --out /tmp/release-rehearsal.json
```

[演练脚本](../scripts/verify-v2-release.mts)只读源库，在临时backup副本迁移/重算/回滚并清理；检查原库hash。
它对本项目当前无校准标签的基线核验fallback。性能只比较同数据/配置下V2全量与无新事实增量的各两轮，不宣称V1→V2提速或精度提高。

## 备份、恢复、删除

Web设置提供SQLite在线备份、下载、恢复/删除确认；这不自动替代整个runtime的灾难恢复备份。
云端[backup-runtime.sh](../deploy/backup-runtime.sh)采用停服、整runtime冷备，默认dry-run；要求所有数据库/工件处于该runtime且没有独立CLI写者。
恢复前记录原版本与配置，验证备份hash/格式，在维护窗口按原目录权限恢复并检查完整性、身份与datasetEpoch。仓库没有名为restore-runtime.sh的自动整runtime恢复脚本，不应臆造命令。
备份本身含健康数据/路线/Token相关配置，离线保存、严格权限、按容量策略保留；不上传到Git或外部分析服务。

### 外部一致性备份的责任边界

目标方向见[SQLite直接增量同步](SQLITE_DIRECT_SYNC_DESIGN.md)第11节：普通同步**不做**项目级整库备份、全库完整性扫描、整库候选复制或换库，也**不等待**外部备份完成。备份由服务器运维独立负责。以下约束现在就成立，不随该改造改变：

- 活跃的WAL库**不能**只`cp rai.sqlite`当一致备份；也**不得**为“提速”删掉`-wal`/`-shm`侧车。正确做法是SQLite一致性备份API、与存储协调的快照，或暂停全部写者后完整备份相关文件。
- 要整个项目状态一致，主库、runtime/control、上传与工件、配置/身份必须落在**同一个恢复边界**内。多个库各自在线备份**不**自动等于跨库一致。
- 备份凭证与数据由运维保护；健康原文、精确轨迹与Token不进入仓库。
- 恢复或替换数据集必须显式处理schema兼容与`datasetEpoch`。旧备份还原后**不得**让客户端继续复用新游标——那会把“接收状态已丢失”伪装成没丢。
- 项目自己创建的备份/rollback文件**不**由应用删除或扫描清理；是否保留、归档、删除由运维决定。
