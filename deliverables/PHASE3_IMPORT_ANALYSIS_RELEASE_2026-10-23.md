# 阶段 3 导入分析与恢复修复发布记录（2026-10-23）

- **发布提交**：`d03f4ae`（本记录为紧随其后的文档提交）。
- **上一生产版本**：`16a1229`。
- **生产实例**：`101.33.202.40`（`VM-0-12-ubuntu`）；仓库 `/opt/rai`，服务 `rai-api`，Nginx 反代 `https://tpandmr.xyz`。
- **范围**：`16a1229..d03f4ae`，174 个文件（含阶段 3 证据日志），阶段 3 双车道导入/分析边界、
  导入恢复复审 P1/P2/P3 修复与对应文档/证据。
- **性质**：主健康库**无 schema 迁移**（v47 → v47，`pending: []`），`package-lock.json` 未变；
  `runtime.sqlite` 由新 API 启动时自动追加 `import_scope_evidence`、`scope_abandonments`
  与 `idx_scope_abandonments_old_unique`；主库首次启动时按新逻辑回填显式 dataset epoch 行
  （`datasetEpoch=default`，预期行为）。
- **测试口径**：按用户要求**未运行任何测试/类型检查**（`npm test`、`npm run typecheck`、
  iOS 门禁、`smoke:api` 均未执行）；本记录只包含发布前备份、部署脚本健康检查与只读端点冒烟，
  不得读成完整验收。阶段 3 研发验收证据见
  [PHASE3_REPORT](phase3-import-analysis-2026-10-22/PHASE3_REPORT.md) 与
  [导入恢复修复记录](IMPORT_RECOVERY_REVIEW_FIX_2026-10-23.md)。

## 1. 发布前备份

维护窗口内用 `deploy/backup-runtime.sh` 做整 runtime 冷备（停服 → tar → sha256 → 恢复原服务状态）：

```bash
sudo install -d -m 700 /var/backups/rai
cd /opt/rai
sudo bash deploy/backup-runtime.sh --output-dir /var/backups/rai --apply
```

- 备份目录：`/var/backups/rai/rai-runtime-20261023T055121Z-2136552`
- 大小：4.6 GiB；`runtime.tar` SHA-256：
  `505ca1a281da03f69c8982725f086748eaab7ebd019be31c4a227e31a4e0294e`
- 备份含私有健康数据，未加密；按主库同等安全等级保管。备份完成后服务已恢复 `active`，
  根分区剩余 26 GiB。

## 2. 部署（2026-10-23 13:52 CST）

```bash
cd /opt/rai
sudo bash deploy/upgrade.sh --apply
```

未加 `--migrate`：部署前只读预演确认主库 v47 且 `pending: []`，本次无主库迁移。
脚本关键输出：

```
目标 HEAD：d03f4ae
package-lock.json 未变化 → 跳过 npm ci
+ systemctl restart rai-api
GET /v1/health 已认证且 status=ok、databaseReady=true；无令牌=401
HEAD=d03f4ae
schema_migrations 最新 version：
  47
```

工作区保持干净（`git status --porcelain --untracked-files=no` 为空）。

## 3. 部署后验证

- 服务：`active`，`Type=notify`、`WatchdogUSec=2min`、`NRestarts=0`。
- 启动日志：注册导入作用域证据（`scopeState=established`）、回填主库 dataset epoch
  （`outcome=written`），随后 `RAI local API ready`；无 error/exception/5xx。
  首次启动 13:52:12 → 13:52:35（约 23 s，含 epoch 回填），此后正常监听。
- `GET /v1/health`（带令牌）= 200，`status=ok`、`databaseReady=true`、`localOnly=false`、
  `datasetEpoch=default`；无令牌 = 401。
- 只读冒烟（本机 loopback，带 Bearer Token）：
  `GET /v1/runtime-status` = 200（`busy=false`，最近一次导入重算作业 `succeeded`）；
  `GET /v1/workouts?limit=1` = 200。
- `runtime.sqlite`：`import_scope_evidence` / `scope_abandonments` 已存在，
  `idx_scope_abandonments_old_unique` 已建立，`PRAGMA quick_check` = `ok`；
  作用域状态为 `established`。
- 主库计数（部署后）：`workouts` 289、`health_records` 543,386、
  `readable_route_points` 246,142；`schema_migrations` 最新 = 47。
  （`route_points` 原始表为 243,615，差额 2,527 是已发布路线点位于
  `route_version_points`；可读视图总数与部署前一致。）

## 4. 启动期持久状态变化

1. `runtime.sqlite` 追加 `import_scope_evidence`、`scope_abandonments` 和唯一索引——
   属新代码的幂等启动维护，无独立迁移 CLI。
2. 主库写入显式 dataset epoch 行（`default`）。这是 P1-1 的存量库回填路径：
   升级前库没有显式 epoch 行时，启动时 compare-before-write 回填，失败则保持写入阻断。
3. 本次没有创建、删除或切换数据集，没有签发首次空库许可。

## 5. 回滚

- **仅代码回滚**：`cd /opt/rai && sudo -u rai git checkout 16a1229 && sudo systemctl restart rai-api`。
  主库 schema 仍为 v47，旧代码可启动；`runtime.sqlite` 多出的表/索引为纯增量。
- **完整回滚到部署前状态**：停服 → 将 `/var/lib/rai` 移开 → 解包
  `/var/backups/rai/rai-runtime-20261023T055121Z-2136552/runtime.tar` → 恢复 `rai:rai` 属主 →
  启动并核对健康。冷备包含主库、控制库、runtime、epoch 侧车与上传工件，必须整体恢复，
  不能只替换单个 SQLite 文件。
- `deploy/upgrade.sh` 只做 `--ff-only` 快进，不能用于回滚。

## 6. 未执行项

- 按用户要求未运行 `npm test`、`npm run typecheck`、iOS 门禁与 `smoke:api` 等测试/门禁。
- 未做 iOS 签名构建、真机验收或生产负载/压测。
- 未进入阶段 4。
