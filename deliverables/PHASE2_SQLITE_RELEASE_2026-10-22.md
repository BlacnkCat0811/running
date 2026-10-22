# 阶段 2 SQLite 优化发布记录（2026-10-22）

- **发布提交**：`9364270`（本记录为紧随其后的文档提交）。
- **上一生产版本**：`cfc5ba4`。
- **生产实例**：`101.33.202.40`；仓库 `/opt/rai`，服务 `rai-api`。
- **范围**：`cfc5ba4..9364270`，含阶段 2 SQLite 查询/事务/连接优化、v47 索引迁移、
  checkpoint 严格/可延后语义、`/series` 专属读 worker、overlap 统计请求外重建与
  speedTrack/区间均值请求内复用。
- **性质**：**有 schema 迁移**（主健康库 v46 → v47），`package-lock.json` 未变。
- **测试口径**：按用户要求**未运行测试套件/类型检查**；本记录只包含部署健康检查与只读端点冒烟，
  不得读成完整验收。阶段 2 的研发验收证据见
  [阶段 2 报告](phase2-sqlite-2026-10-21/PHASE2_SQLITE_QUERY_TRANSACTION_CONNECTION_2026-10-21.md)
  与 [A/B/C 剩余问题报告](phase2-followup-2026-10-21/PHASE2_FOLLOWUP_A_B_C_2026-10-22.md)。

## 1. 发布前备份

维护窗口内先用 `deploy/backup-runtime.sh` 做整 runtime 冷备（停服 → tar → sha256 → 恢复原服务状态）：

```bash
sudo install -d -m 700 /var/backups/rai
cd /opt/rai
sudo bash deploy/backup-runtime.sh --output-dir /var/backups/rai --apply
```

- 备份目录：`/var/backups/rai/rai-runtime-20261022T040647Z-1723229`
- 大小：2.3 GiB；`runtime.tar` SHA-256：
  `b7d2fbc46967730df9c24ba4e8186561713482a702cf67e39c19df482654e68d`
- 备份含私有健康数据，未加密；按主库同等安全等级保管。

## 2. 部署与迁移（2026-10-22 12:07 CST）

```bash
cd /opt/rai
sudo bash deploy/upgrade.sh --apply --migrate --database /var/lib/rai/var/rai.sqlite
```

脚本按顺序执行：`git pull --ff-only` → `package-lock.json` 未变故跳过 `npm ci` → 停服 →
`data:migrate --apply` → `reset-failed` → 重启 → 认证健康检查。

迁移结果（`data:migrate` 输出）：

| 项 | 部署前 | 部署后 |
|---|---:|---:|
| schema version | 46 | **47** |
| workouts | 289 | 289 |
| health_records | 543,046 | 543,046 |
| route_points | 246,142 | 246,142 |

- `pending`：`[47 ability_assessment_session_lookup]` → `[]`
- `foreignKeyCheck`：`ok`
- 迁移耗时：34,081 ms
- 生产库已确认存在索引
  `idx_ability_assessments_session ON ability_assessments(training_session_id, model_run_id)`。

## 3. 部署后验证

- `HEAD=9364270`；服务 `active (running)`，`Type=notify`、`WatchdogUSec=2min`、`NRestarts=0`。
- 脚本健康检查：带令牌 `GET /v1/health` = 200，`status=ok` 且 `databaseReady=true`；无令牌 = 401。
- 只读冒烟（本机 loopback，带 Bearer Token）：
  - `GET /v1/workouts?limit=1` = 200；
  - `GET /v1/workouts/training_session_2aac5780f95010e0e0af1be6966f0c1b/series` = 200，
    响应 11 个 segments、308,500 bytes、930.6 ms（重启后首次请求，含专属读 worker 冷启动）。
- journal：启动后无 error/exception/5xx；`request completed` 记录齐全。

## 4. 回滚

- **代码回滚**：`cd /opt/rai && sudo git checkout cfc5ba4 && sudo systemctl restart rai-api`。
- **数据回滚**：v47 只新增兼容索引，但旧版 v46 代码遇到 `schema_migrations` 中的未知版本 47 会拒绝启动；
  如需回到 v46 代码，必须同时恢复本记录 §1 的冷备（或等价的一致性备份），不能只 checkout 代码。
- `deploy/upgrade.sh` 只做 `--ff-only` 快进，不能用于回滚。

## 5. 未执行项

- 按用户要求未运行 `npm test`、`npm run typecheck`、iOS 门禁、`smoke:api` 等测试/门禁。
- 未做生产负载/压测；未执行阶段 3 启动决策。
- 未对 iOS 客户端做签名构建或真机验收。
