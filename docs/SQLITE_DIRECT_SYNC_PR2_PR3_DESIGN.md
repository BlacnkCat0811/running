# 直接增量同步：PR2 + PR3 落地设计

日期：2026-10-12，Asia/Shanghai。基线：`7a6408a` + PR1 改动（未提交）。
上位设计：[SQLITE_DIRECT_SYNC_DESIGN.md](SQLITE_DIRECT_SYNC_DESIGN.md) §4–§7、§13 PR2/PR3、§14。
本文件只覆盖 **PR2（同库事务接收全部正常类型）** 与 **PR3（版本化事实与路线）**；
PR4（分析输入与短写调度）、PR5（读侧一致性）、PR6（客户端与切路）另出。

**状态：设计，未实施。** 本文所有"现状"断言都落到 `文件:行号`，可逐条复核。

---

## 0. 本文档要回答的三件事

1. 把"整库副本上的分析"换成"主库上的分析"，缺的**版本化基础**具体长什么样（DDL）。
2. 组件私自 `BEGIN`/`COMMIT` 怎么变成**结构上不可能**，而不是靠约定。
3. 迁移怎么加、怎么回退，以及**哪些验收本环境给不了**。

---

## 1. 现状锚点（设计必须绕着走的事实）

| 事实 | 位置 | 对设计的影响 |
|---|---|---|
| 写入器自动攒批：非原子模式下每 5000 个对象自行 `COMMIT` | `packages/storage-sqlite/src/database.ts:2117-2121`（`markObject()`） | 组件会**自己提交**，必须做成结构性禁止 |
| `flush()` 直接 `exec("COMMIT")`；`rollback()` 直接 `ROLLBACK` | `database.ts:2143-2157` | 事务所有权目前只有"自动 / 原子"两种，没有"调用方持有" |
| `beginAtomicImport()` 只置标志 + `BEGIN`；`commitAtomicImport()` 调 `flush()` | `database.ts:2123-2135` | 原子模式下**仍然是组件提交**，不是调用方提交 |
| 全库补种只在 `incremental` 且**非** `preserveAbsent`（即 `removalDetection`）时发生 | `packages/health-export-parser/src/apple-health-parser.ts:336-345` | 直连车道恒为 `preserveAbsent`（资格检查强制，`:309-312`）⇒ 补种对它**结构上不可能**；推广到全部类型要靠这个开关 |
| `preserveAbsent` 时 `finalizeImportGeneration` **直接早退返回 0 删除** | `database.ts:3324-3337` | ⇒ **增量的补种是无用功**：删除判定根本不会跑。这是"不全库 seed"安全的**根据**，不是节省 |
| `import_entity_generations.entity_kind` 有 `CHECK IN ('record','workout','activity_summary')` | `database.ts:1037`（v12 的建表语句） | 🔴 想加 `'route'` 必须**重建表** ⇒ 改历史迁移。**不要在它上面加路线**，另开表 |
| `healthkit_record_facts` 有 `UNIQUE(sample_type, sample_uuid)`，只存**当前**事实 | `packages/storage-sqlite/src/v31-migration.ts:39-48` | 历史版本**不能**塞进这张表，必须新表 |
| `workout_routes.relative_path TEXT UNIQUE`、`file_status DEFAULT 'pending'` | `database.ts:209-222` | 路线版本不能复用同一 `relative_path`；`file_status` 可作为"未发布"标记复用 |
| `recompute_jobs` 在主库，`job_type CHECK IN ('import','full_recompute','snapshot_refresh')`，`status CHECK IN (queued…cancelled)` | `database.ts:482-498` | 分析任务可与 raw 同事务落库（§4.2 要求）；要加绑定列只能 `ALTER TABLE ADD COLUMN` |
| `canonicalizeNights` 每次 `DELETE FROM canonical_hrv_days; DELETE FROM canonical_nights;` 再全量重建 | `packages/health-export-parser/src/canonicalize-nights.ts:333` | 局部化必须改成按窗口 `DELETE ... WHERE`，且夜间日期范围由段的**开始与结束**共同决定（见同文件注释 `canonicalize-nights.ts:10` 与实现 `canonicalize-nights.ts:259-261`） |
| 迁移注册表 `migrations` 到 v33 为止；`FROZEN_MIGRATION_CHECKSUMS` 按版本冻结；门禁在 `test/migration-policy.test.ts` | `database.ts:123`（注册表；v33 条目在 `database.ts:1673`）、`database.ts:1718`（冻结值）；`MIGRATION_VERSIONS`/`transpiledChecksumFor` 在 `1757/1769`（同文件） | 新增迁移必须补冻结值，否则门禁转红 |
| 守卫观测口：`databaseTask` 是唯一线程投递口，`task.operation` ∈ {verify, audit, checkpoint, data-only} | `apps/api/src/import-worker.ts:948-966`；`import-database-tasks.ts:6-10` | PR2 扩展车道要**新增 operation**，否则守卫看不见新通道 |

---

## 2. PR2 设计：同库事务接收全部正常类型

### 2.1 事务所有权：把"调用方持有"做成一次执行模式，而不是一个约定

现在 `RaiDatabase` 有两种模式（自动攒批 / 原子），两种都由组件提交。新增第三种，并让**非法提交在构造上抛错**：

```ts
// packages/storage-sqlite/src/database.ts
export type TransactionOwner = "store" | "caller";

// open() 新增选项：transactionOwner?: TransactionOwner  （默认 "store"，保持既有行为）
// 当 transactionOwner === "caller"：
//   - open() 不 BEGIN；
//   - flush() 抛 new Error("This store does not own its transaction")；
//   - rollback() 抛同错；
//   - 只暴露 savepoint/releaseSavepoint/rollbackToSavepoint 与 owner 自己的
//     beginCallerTransaction/commitCallerTransaction/rollbackCallerTransaction。
```

要点（每条都要有对应断言，否则就是"约定"不是"约束"）：

- **类型上不可能**：`flush()`/`rollback()` 在 `caller` 模式下抛错 —— 组件哪怕照旧调用也拿不到提交。
- **构造即抛**：`open({ transactionOwner: "caller" })` 时若检测到 `journal_mode` 不是 WAL 或
  `synchronous` 被降级，直接抛错（文档 §1.2 禁止用 `journal_mode=OFF`/`synchronous=OFF` 换速度）。
- **局部保护只用 SAVEPOINT**：组件内部想"要么全成要么全退"就 `SAVEPOINT sp_x` / `RELEASE` /
  `ROLLBACK TO`，**不产生新的提交点**。这是 §4.2「所有内部组件不能自行 COMMIT」的机械实现。

### 2.2 车道扩展与分派

把现有的窄车道（`apps/api/src/data-only-import.ts`）推广为一个统一的原始接收器
`DirectSyncIngestWorker`（文档 §3 命名）：

```
载荷判定（事务外，§4.1）
  ├─ 路径安全 / 类型 / 字节与点数配额 / payload identity        ← 复用现有 import-payload-identity
  ├─ XML/GPX 解析与归一化（不读主库可变状态，产生 normalized plan） ← 复用 apple-health-parser 的 SAX 层
  └─ 决定 lane：
        analysis_required = payload 触及 scoringHealthTypes（heartRate/runningSpeed/
                            restingHeartRate/sleepAnalysis/hrvSdnn/vo2Max）
                          或 workoute/route/删除 或 全局依赖（VO2Max/校准/配置）
```

分派后**同一个**事务（§4.2）：

```text
BEGIN IMMEDIATE                     ← 由 DirectSyncIngestWorker 持有
  读/校验 scope 与 batch identity
  已有同内容 committed receipt ？ → 返回旧回执（幂等）
  登记本批全部显式 source deletions（防载荷顺序复活）
  逐受影响实体点查并写入：历史 revision / 最新事实 / UUID 身份 / 来源快照 / 显式删除
  登记 before/after（import_entity_changes）
  raw_generation += 1
  if analysis_required:
      dependency_generation += 1
      INSERT INTO recompute_jobs(..., target_raw_generation, target_dependency_generation,
                                 expected_incumbent_release_id, dirty_json)
  写持久 receipt（含 §10.1 directSync 字段）
  回读必要事实 / 删除保护 / 账目 / 版本 / 回执
COMMIT                              ← 只有这里，且只由 worker 提交
```

对外契约（§10.1）：`ingestStatus: "committed"`；
`analysisStatus`: 不触及分析 ⇒ `"not_required"`；触及 ⇒ `"queued"`（**不是** `published`）。

### 2.3 逐实体代次，替代全库补种

文档 §4.3 要"按本次碰到的实体从已有属性计算/初始化"。结合 §1 的事实（`preserveAbsent` 下删除判定不跑），
正确做法是：

- 增量载荷**不再调用** `seedImportGenerations`（现在靠 `recordDelta` 开关跳过；推广时把开关泛化为
  `deltaMode: "record-only" | "full"`，**两个值都跳过补种**）。
- 遇到没有 `import_entity_generations` 行的实体时，**只给这一个实体**按当前行属性算 `content_hash`，
  写 `generation = "<batch>:previous"`，再走 `observeImportEntity` 的正常比较路径
  （`database.ts:~2808` 已有 `SEED_CONTENT_HASH` 哨兵逻辑可复用）。
- ⚠️ **必须补的断言**：证明"推广到 full 车道后，`finalizeImportGeneration` 仍不会被以
  `preserveAbsent: false` 调用"。一旦被调用，`import_entity_generations` 里**只有本批碰到的实体**，
  其余实体全部被判为"缺失 ⇒ 删除" —— 那是一次静默全库数据删除。这是本设计**最危险的失效模式**，
  必须用"结构上不可能"实现（见 §2.6）。

### 2.4 路线：只更新本条，不发布半条

- 新表 `route_versions` + `route_version_points`（见 §3.2），`workout_routes` 继续当**当前指针**。
- 小路线：一次有界事务写 points 并把 `route_versions.status` 置 `complete`，再更新
  `workout_routes.published_route_version_id`。
- 大路线：points 分片写入 `status='pending'` 的版本；**点数/顺序/hash 全部校验通过后**才翻 `complete`
  并移动指针。未完成的版本对读侧不可见 ⇒ 旧路线保持可用。
- 配额拒绝按 ADR-004 落 pending，不写 invalid；真坏文件拒绝**该版本**，旧可用路线保留。
- 回执分别说明"已保存记录数"与"路线已完成/仍待补齐"。

### 2.5 幂等与重启

- `receipt` 与 `import_batches.summary_json` 同事务写入；重放先查 receipt（现有逻辑保留）。
- 同 batch id 不同 payload ⇒ 冲突拒绝，**不覆盖旧回执**（现有断言保留）。
- 新增 `databaseTask` operation `"direct-sync"`，让 §14.1 守卫能看见这条车道（现在只认 `data-only`）。

### 2.6 让"误用"在结构上不可能（三条硬约束）

| 风险 | 结构约束 |
|---|---|
| 组件私自 COMMIT | `transactionOwner: "caller"` 下 `flush()`/`rollback()` 抛错；只有 worker 持有 commit 句柄 |
| 全库删除（§2.3 的失效模式） | full 载荷走直连时，`preserveAbsent` **恒为 true** 由类型保证：直连入口的参数类型不含 `preserveAbsent` 字段，只接受 `deltaMode: "record-only" \| "full"`，两者在实现里都映射到 `preserveAbsent: true`。**没有可以传 `false` 的路径** |
| 未发布路线被读到 | 读侧只 JOIN `status='complete'` 的版本；`published_route_version_id` 为指针。指针未动 ⇒ 读不到半条 |

---

## 3. PR3 设计：版本化事实与路线（迁移 v34 / v35）

### 3.1 v34 `sparse_fact_history_and_generations`

```sql
-- 稀疏历史：只存被更正/删除的实体，未变的百万行不复制（§7）
CREATE TABLE import_fact_history (
  entity_kind        TEXT    NOT NULL CHECK (entity_kind IN ('record','workout')),
  entity_id          TEXT    NOT NULL,
  valid_from_generation INTEGER NOT NULL CHECK (valid_from_generation >= 0),  -- 该内容自哪个 raw_generation 起生效
  valid_to_generation   INTEGER CHECK (valid_to_generation IS NULL OR valid_to_generation > valid_from_generation), -- NULL = 仍然生效
  content_hash       TEXT    NOT NULL,
  effective_at       TEXT,                      -- 事件时间
  available_at       TEXT,                      -- 可得时间；未知时保留既有保守界，不伪造
  payload_json       TEXT    NOT NULL,          -- 终止版本需要恢复的旧内容
  superseded_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entity_kind, entity_id, valid_from_generation)
);
CREATE INDEX idx_import_fact_history_valid_to ON import_fact_history(entity_kind, entity_id, valid_to_generation);

-- 版本计数器（单行；raw 与 dependency 分离，§9.2）
CREATE TABLE import_generations (
  singleton            INTEGER PRIMARY KEY CHECK (singleton = 1),
  raw_generation       INTEGER NOT NULL CHECK (raw_generation >= 0),
  dependency_generation INTEGER NOT NULL CHECK (dependency_generation >= 0),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO import_generations (singleton, raw_generation, dependency_generation) VALUES (1, 0, 0);

-- 当前行记录"自哪个代次起有效"
ALTER TABLE health_records ADD COLUMN valid_from_generation INTEGER;
ALTER TABLE workouts      ADD COLUMN valid_from_generation INTEGER;
```

🔴 为什么**不**给 `healthkit_record_facts` 加历史列：它有 `UNIQUE(sample_type, sample_uuid)`，
加历史行会撞唯一约束；改唯一约束 = 重建表 = 动历史迁移（`v31-migration.ts:39-48`）。
`import_fact_history.payload_json` 承担恢复职责，与那张表并存不冲突。

### 3.2 v35 `route_versions_and_analysis_bindings`

```sql
-- 路线版本：workout_routes 仍是"当前指针"，版本表承载不可变内容
CREATE TABLE route_versions (
  id             TEXT PRIMARY KEY,
  route_id       TEXT NOT NULL REFERENCES workout_routes(id) ON DELETE CASCADE,
  content_sha256 TEXT NOT NULL,               -- points 序列 + 元数据的摘要
  point_count    INTEGER NOT NULL CHECK (point_count >= 0),
  status         TEXT NOT NULL CHECK (status IN ('pending','complete','rejected')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at   TEXT,
  UNIQUE (route_id, content_sha256)
);
CREATE TABLE route_version_points (
  route_version_id TEXT    NOT NULL REFERENCES route_versions(id) ON DELETE CASCADE,
  sequence         INTEGER NOT NULL,
  timestamp        TEXT, latitude REAL NOT NULL, longitude REAL NOT NULL,
  elevation_meters REAL, speed_mps REAL, course_degrees REAL,
  horizontal_accuracy_meters REAL, vertical_accuracy_meters REAL,
  PRIMARY KEY (route_version_id, sequence)
);
ALTER TABLE workout_routes ADD COLUMN published_route_version_id TEXT REFERENCES route_versions(id);

-- 大包分片（§5.2）：父批不是一个物理事务
CREATE TABLE import_batch_partitions (
  parent_batch_id   TEXT NOT NULL,
  partition_contract TEXT NOT NULL,
  chunk_index       INTEGER NOT NULL CHECK (chunk_index >= 0),
  chunk_hash        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','committed')),
  receipt_json      TEXT,
  PRIMARY KEY (parent_batch_id, partition_contract, chunk_index),
  UNIQUE (parent_batch_id, chunk_hash)
);

-- 分析任务绑定（§7）：加列，不改 job_type 的 CHECK
ALTER TABLE recompute_jobs ADD COLUMN target_raw_generation INTEGER;
ALTER TABLE recompute_jobs ADD COLUMN target_dependency_generation INTEGER;
ALTER TABLE recompute_jobs ADD COLUMN expected_incumbent_release_id TEXT;
ALTER TABLE recompute_jobs ADD COLUMN dirty_json TEXT;
```

### 3.3 实施偏差（撰写设计后、写码前修正的两处）

1. **代次列由 `TEXT` 改为 `INTEGER`。** 设计初稿把 `valid_from_generation` / `raw_generation` 等写成 `TEXT`。
   实施时改为 INTEGER，理由是 `valid_from_generation <= G` 是**比较**而不是等值：
   若用 TEXT，比较退化成字典序，`'10' < '9'` 会**静默**给出错误的版本视图。用 INTEGER 让这个陷阱不存在。
   对外（§10.1 回执）仍以十进制字符串呈现：`String(n)`。
   ⚠️ 与 `import_entity_generations.generation` 的区别：那一列存的是 `delta:<jobId>` 这类**批次 token**
   （"这行由哪一批产生"），两套语义不同，所以类型不同是刻意的。
   已按此实现：`packages/storage-sqlite/src/v34-migration.ts`、`v35-migration.ts`。

2. **`published_route_version_id` 用外键默认动作（NO ACTION），明确不用 `ON DELETE SET NULL`。**
   判据来自实测（`packages/storage-sqlite/test/direct-sync-migrations.test.ts` 用例 4）：
   被指针引用的版本**删不掉**。若用 `SET NULL`，删版本会**静默取消发布**当前路线 ——
   客户端看到路线消失却查不到原因。修剪版本的正确顺序是"**先移指针、再删版本**"，由调用方显式做。
   与项目一贯偏好一致：**拒绝优于静默**。

### 3.4 迁移的硬规矩

- **只新增**，不修改任何历史 `up`（`database.ts:123-1673` 是 v1–v33 那一段，一行不动；v34/v35 追加在 `database.ts:1674-1675`）。
- 新迁移必须在 `FROZEN_MIGRATION_CHECKSUMS`（`database.ts:1718`）补 v34/v35 的冻结值，
  否则 `test/migration-policy.test.ts` 的 `every migration has a frozen checksum` 转红。
- 部署闸门不变：`npm run data:migrate -- --database <path>` 必须报 `"pending": []`。
- **不提供反向迁移**。回退是应用级 + 外部恢复（见 §6）。

### 3.4 canonical 局部化（PR3 边界内只做"可局部"的部分）

`canonicalizeNights` 现在无条件整表删重建（`canonicalize-nights.ts:333`）。本 PR 只做：

- 新增 `canonicalizeNightsForWindow(database, timezone, fromLocalDate, toLocalDate)`：
  把 `DELETE FROM canonical_nights` 换成 `DELETE ... WHERE wake_date BETWEEN ? AND ?`（`canonical_hrv_days` 同理），
  扫描范围 `all` 由 `loadSegments` 的全量改为按时间窗过滤。
- **不改** 来源优先级、跨夜并集、同内容原可得时间、HRV 稀疏/缺失语义（§8.2 明令保留）。
- 算法文本变了必须 bump `CANONICAL_NIGHT_ALGORITHM_VERSION`（现有做法，见 `canonicalize-nights.ts:7-15`）。
- 全局重算（VO2Max/校准/配置升级）仍走整表路径，但**不再**触发 backup/copy/swap。

---

## 4. FactsReader 契约（PR3 定，PR4 用）

```ts
// packages/storage-sqlite/src/read/facts-reader.ts（PR3 只定接口 + 最小只读实现）
export interface FactsReader {
  /** 本 reader 固定的 raw 代次。所有方法都只返回该代次的事实。 */
  readonly generation: string;
  records(filter: { types?: readonly string[]; fromAt?: string; toAt?: string }): Iterable<CanonicalHealthRecord>;
  workouts(filter: { fromAt?: string; toAt?: string }): Iterable<Workout>;
  routeFor(workoutId: string): Route | null;
  close(): void;
}
```

恢复一条记录的内容：`import_fact_history` 中 `(entity_kind, entity_id)` 满足
`valid_from_generation <= G AND (valid_to_generation IS NULL OR valid_to_generation > G)` 的那一行；
没有历史行时退化为"当前行且 `valid_from_generation <= G`"。

🔴 **不许长读事务**（§7）：实现按 `(type, 时间窗)` 分块加载，每块一个短只读连接，读完即关。
`close()` 必须在 CPU 计算前调用 —— 断言方式：在 reader 存活期间不允许存在打开的 read transaction
（用 `PRAGMA` 或连接计数断言，PR4 落地时补）。

---

## 5. 验收标准（照这个跑，未测的必须标"未测"）

### 5.1 结构判据（编译期/构造期）

1. `transactionOwner: "caller"` 下调用 `flush()` / `rollback()` **抛错**（不是静默无害）。
2. 直连入口的参数类型**不含** `preserveAbsent`，也不含任何可传 `false` 的等价字段。
3. `recompute_jobs.job_type` 的 `CHECK` 未被放宽（新增绑定列只用 `ALTER TABLE ADD COLUMN`）。

### 5.2 行为判据

4. §14.1 守卫扩展到新车道：Workout、评分类型、删除-only、混合包各一条，
   断言 10 条禁止操作全 0、主库 inode 不变、`var/backups` 与 `rai.importing.*` 不出现。
5. 删除保护：删除先于到达 / 共享 UUID / 旧 XML 桥接 / 删除-only 四种都保留正确身份，
   不误删同来源其他事实。
6. 本批原子性：在写入点逐点故障注入 ⇒ 事实、身份映射、账本、代次、任务、回执**全部回滚**。
7. 强杀：COMMIT 前强杀无半批；COMMIT 后丢回复或重启 ⇒ 返回原回执、不重复应用。
8. 版本正确性：`FactsReader(G_old)` 在 G_new 提交后仍返回**旧**事实；
   `FactsReader(G_new)` 返回新事实；两者都不返回混合结果。
9. 路线：未完成的版本对读侧不可见；末批完成后指针原子移动；重复上传不重复写点。
10. 局部 canonical：窗口外的 canonical 行**逐字节不变**（比对整行，含 `computed_at` 语义）。
11. 迁移：`migration-policy.test.ts` 绿；`pending: []`；历史 33 个 checksum **逐个未变**。

### 5.3 突变验证（每条判据都要能变红，缺一不算数）

至少覆盖：①把 `transactionOwner` 改回 `"store"` ⇒ 4 号判据红；②给直连入口加一个
`preserveAbsent?: boolean` 字段 ⇒ 2 号判据红；③把 `import_fact_history` 的窗口条件
`>` 改成 `>=` ⇒ 8 号判据红；④把局部 canonical 的 `WHERE` 去掉 ⇒ 10 号判据红。

### 5.4 本环境给不了的（必须在报告里标"未测"）

- §14.3 P01–P06：需要**目标云机**，文档禁止用开发机空库替代。
- §14.5 真机 HealthKit 自动增量 / 续传 / 游标保持：需要真机。
- 与旧链路的**同环境对比计时**：本机 load 长期 12–15（6 核），计时不可信。

---

## 6. 回滚方案

| 层 | 回滚手段 | 代价 |
|---|---|---|
| 应用 | 关闭直连车道（沿用现有 `dataOnlyFastPath` 式的开关），退回旧候选链路 | 立刻，零数据风险 |
| 迁移 | **不提供反向迁移**。v34/v35 全部是"新增表 + 可空列"，旧代码路径不读它们 | 旧代码可继续跑，新表留空 |
| 数据 | 需要时由**外部运维**在维护窗口用一致性备份恢复（§11） | 应用不自动备份、不自动恢复 |
| 已确认事实 | **不得**通过切旧数据库丢掉；切库前必须确认目标库包含已 committed 的 receipt | — |

🔴 明确不做：`DROP TABLE` 式的反向迁移。历史 `up` 不可改，反向迁移也要自己的冻结校验和，
而收益只是"表少两张"，与风险不成比例（纪律：为微小收益放宽既有不变量 ⇒ 默认作废该方案）。

---

## 7. 风险与未决项

| 级别 | 项 | 处置 |
|---|---|---|
| 🔴 | full 载荷被以 `preserveAbsent: false` 送进直连 ⇒ **静默全库删除** | 用 §2.6 的类型约束封死；补一条断言（"参数类型里不存在这个字段"） |
| 🔴 | `canonicalizeNightsForWindow` 的窗口边界算错 ⇒ 夜间事实丢失或重复 | 复用 `canonicalize-nights.ts:250-261` 的"开始与结束都算"口径；合成用例钉住跨界夜 |
| 🟡 | 新增两个迁移不可逆 | 先隔离库演练 + 冻结校验和；API 以 `refuse` 开库，pending 直接 exit 78（现有机制） |
| 🟡 | `workout_routes.relative_path UNIQUE` 与版本表并存会不会冲突 | 版本表不写 `relative_path`；待实施时用一条断言钉住 |
| ⚪ | ~~未决：`route_version_points` 与既有 `route_points` 是否长期双写~~ | **已定（步骤 5）**：过渡期双写（发布时点写两处），PR5/PR6 让读侧改走版本表后 `route_points` 退役 |

---

## 8. 实施顺序（每步都能单独跑绿）

1. **v34 + v35 迁移骨架**（纯 DDL + 冻结校验和）→ 只验迁移门禁。
2. **`transactionOwner` 模式 + SAVEPOINT API** → 只验结构判据 1、`worker.test.ts` 不回归。
3. **`DirectSyncIngestWorker` 分派 + `databaseTask` 新 operation** → 守卫测试扩展。
4. **逐实体代次，替换补种** → 判据 5、6。
5. **路线版本** → 判据 9。
6. **局部 canonical + `FactsReader`** → 判据 8、10。

PR4/PR5/PR6 在此之后另出设计。

---

## 9. 实施进度

| 步骤 | 状态 | 证据 |
|---|---|---|
| 1. v34 + v35 迁移骨架（纯 DDL + 冻结校验和） | ✅ 已完成 | 见下 |
| 2. `transactionOwner` 模式 + SAVEPOINT API | ✅ 已完成 | 见下 |
| 3. `DirectSyncIngestWorker` 分派 + `databaseTask` 新 operation | ✅ 已完成（见下，含一处偏差） | 见下 |
| 4. 逐实体代次，替换补种 | ✅ 已完成（结论：**不需要**"逐实体代次"；见下） | 见下 |
| 5. 路线版本 | ✅ 已完成（含两处对初稿的修正 + 红队 F1/NEW-1/NEW-2 修复） | 见下 |
| 6. 局部 canonical + `FactsReader` | ✅ 已完成（多智能体并行 + 红队交叉复核） | 见下 |
| 6b. 分析任务登记（切路前提） | ⛔ **未做，切路前必须做** | 见下 |

### 步骤 1 的实测证据（2026-10-12）

- `npm run typecheck` → `EXIT=0`。
- `packages/storage-sqlite/test/direct-sync-migrations.test.ts`（新增 5 条）+ `migration-policy.test.ts`（8 条）
  → **13/13 pass**。新增用例覆盖：表/列形状、`entity_kind` 白名单与版本区间**确实拒绝非法值**、
  分片表 `UNIQUE` 生效、路线版本外键语义、老库补迁移不丢行。
- 冻结校验和：v33 的**现算值与其已冻结值逐位一致**（`bf321666…`）—— 这是"计算通道正确"的阳性对照，
  然后才冻结 v34=`36798b39…` / v35=`de0d2cda…`。
- 迁移 CLI（隔离库）：全迁移态 `pending: []`、`version=35`；
  降级到 v33 后干跑报 `pending=[34,35]`；`--apply` 后 `before.version=33 → after.version=35`、
  `pending: []`、`foreignKeyCheck: "ok"`、`counts` 不变、`elapsedMs=72`。
- **突变验证（3 处，全部精确捕获）**：①删掉 v34 的冻结值 → 门禁 12 红
  （`新增迁移必须同时在 FROZEN_MIGRATION_CHECKSUMS 里补一条冻结值`）；
  ②把 v34 的 `valid_to > valid_from` 改成 `>=` → 约束用例 2 红 **且** 漂移门禁 13 点名 `[34]`
  （证明"改历史迁移的 `up` 会被发现"这条能力对新增迁移同样有效）。突变已全部回退，复跑 13/13 绿。

⚠️ 步骤 1 **尚未**跑全量 `npm test`（按约定留到最后统一跑）。受影响包 `storage-sqlite` 的回归已单独跑，见当轮报告。

### 步骤 2 的实测证据（2026-10-12）

新增 `packages/storage-sqlite/test/transaction-owner.test.ts`（8 条）。

- 新增公开 API：`beginCallerTransaction` / `commitCallerTransaction` / `rollbackCallerTransaction` /
  `savepoint` / `releaseSavepoint` / `rollbackSavepoint`；`RaiDatabaseOpenOptions.transactionOwner`。
- **"组件提不了"是机械保证，不是约定**：caller 模式下 `flush()` / `rollback()` /
  `beginAtomicImport()` / `rollbackAtomicImport()` 一律抛错；`markObject()` 的 5000 对象攒批提交点
  在 caller 模式下被**结构性地**关掉（`this.transactionOwner === "store"` 前置条件）。
- **caller 模式的默认值本身就把危险动作堵死**：`migrationPolicy` 默认 `"refuse"`、
  `createMigrationBackup` 默认 `false`、`foreignKeyValidation` 默认 `"after-migration"`；
  显式传入冲突值（`apply` / `true`）**抛错而不是静默忽略**。这与文档 §1.1 逐条对应。
- **提交前断言 SAVEPOINT 栈为空**：泄漏的 savepoint 会让提交被拒 —— 静默提交会把某个组件
  没做完的半成品一起落库。
- **SAVEPOINT 强制 LIFO**：只允许释放/回滚最内层。SQLite 的 `RELEASE name` 会连带释放
  其后创建的 savepoint，允许任意名字就等于允许一个组件误放另一个组件未完成的工作。
- 子进程/连接层复核：提交后的值在**换一个连接**后仍可读，回滚后的值在两个连接里都不存在
  （证明不是"同一连接内看不见"）。
- **突变验证（2 处，全部精确捕获）**：①把 `assertStoreOwnsTransaction` 短路 → 用例 4 红
  （`Missing expected exception.`）；②去掉 `requireInnermostSavepoint` 的最内层检查 →
  用例 7 红（同形态）。突变已回退。
- 回归：`packages/storage-sqlite/test/*.test.ts` **115 条 / 114 pass / 0 fail / 1 skip**
  （+8 条新增）。那 1 条 skip 是既有已知项：`publication lock rejects PID reuse`，
  本机 `ps` 身份探测被沙箱拒（EPERM）⇒ 按设计 fail-safe 跳过，**不是覆盖丢失**。

⚠️ 未覆盖、不得当成已保证：`journal_mode` 非 WAL 时构造抛错那条分支需要一块不支持 WAL 的存储，
本机造不出来；代码里那条断言只能靠评审。已在测试文件头注明。

### 步骤 3 的实测证据（2026-10-12）

新增 `apps/api/src/direct-sync-plan.ts`（车道判定 + 形状约束）与 `apps/api/test/direct-sync-plan.test.ts`（6 条）。

**① 判定抽成纯函数，与原内联六条件逐条等价。** `ImportWorker.run` 里原本是一个六条件 `if`；
现在改成 `planDirectSyncLane({...})`，六条否决各有 `reason`（`not_queued` / `fast_path_disabled` /
`engine_rust` / `engine_version_mismatch` / `payload_is_a_complete_snapshot` / `no_existing_database`）。
行为等价的判据不是"看起来一样"，而是**既有直连测试全绿**（见下）。

**② `preserveAbsent` 的保证是结构性的，不是约定。** 两条：
- `directSyncParserOptions()` **不接受参数、返回类型写死字面量 `true`** —— `false` 在类型上无法表达；
  单测还断言 `directSyncParserOptions.length === 0`（有参数就等于有了传 `false` 的入口）。
  `data-only-import.ts` 里那处 `preserveAbsent: true` 字面量已改为引用它（单一来源）。
- `assertDirectSyncRequestShape(input)` 在 `applyDataOnlyImport` 入口、**读任何文件之前**执行。
  它拦的是**类型挡不住**的写法：TypeScript 的多余属性检查只作用于对象字面量，
  `{ ...request, preserveAbsent: false }` 会静默通过类型检查 —— 而那恰好是最容易写出来的写法。

**③ 补上一个会静默成功的洞（偏差说明）。** 设计里把步骤 3 写成"`databaseTask` 加新 operation"，
但那会往 `import-database-thread.ts` 的裸 `switch` 里加分支：**漏加分支时 `result` 保持 `undefined`
并被当作成功回传**，调用方看到的是"没报错"而不是"没执行"。
所以本步**没有**加新 operation（避免造一个没有实现的分支），改成了两件事：
- 给那个 `switch` 加 `default` 分支 + `const unsupported: never = task` ⇒ 漏加分支**编译不过**，
  运行期也抛错而不是静默成功；
- 用一次突变证明"新增 operation 无法静默落地"（结果见下）。

**④ 突变验证（3 处，全部精确捕获）**
1. 删掉 `planDirectSyncLane` 里 `preserveAbsent` 那条否决 ⇒ 用例 2、3 红（完整快照能进直连）。
2. 让 `assertDirectSyncRequestShape` 收到空对象（等于关掉兜底）⇒ 用例 6 红（`Missing expected rejection.`）。
3. 往 `ImportDatabaseTask` 加一个 `probe-mutation` 成员、不加任何分支 ⇒ **`npm run typecheck` EXIT=2**，两条报错同时点名：
   `import-database-thread.ts(17,11): Type '{ operation: "probe-mutation"; }' is not assignable to type 'never'`
   与 `direct-sync-prohibited-operations.test.ts(51,7): Property '"probe-mutation"' is missing in type ... Record<...>`。
   即：**新车道操作会让分发器与 §14.1 守卫同时转红**，不可能静默落地。

突变已全部回退。

**回归**：`npm run typecheck` `EXIT=0`；
`apps/api` 六个相关测试文件（含 `worker.test.ts`）**149 条 / 148 pass / 0 fail / 1 skip**。
那 1 条 skip 仍是 `publication lock rejects PID reuse`（本机 `ps` 身份探测被沙箱拒）。

### 步骤 4 的实测证据（2026-10-12）

**结论先行：设计里写的"逐实体代次补齐"是错的方向，实际要做的是"把两处条件化合并成一个"。**

设计初稿说"遇到没有 generation 行的实体，只给这一个实体补一行"。实测后不成立，理由有两条，
都在代码里：
1. 逐实体补种能写进去的只有 `SEED_CONTENT_HASH` 这个哨兵（内容哈希由**解析器**从载荷算出，
   存储层拿不到），而哨兵的判定结果是 `updated = false` —— 与"没有代次行"**完全等价**。
   所以逐实体补种是个 no-op，不是修复。
2. 补种的真正用途是 `finalizeImportGeneration` 的**删除检测**（`where generation <> 当前代次`）。
   而删除检测只在 `!preserveAbsent` 时生效，此时载荷是完整快照，**补种本来就会跑**。

**真正的问题（本次发现）：补种与删除判定是两处独立条件写成的。**
`apple-health-parser.ts` 里：
- 补种：`incremental && !recordDelta`
- 删除判定：`incremental && !preserveAbsent`

今天两者恰好等价（`recordDelta ⇒ preserveAbsent`），但**两处独立条件意味着只改一处就有两种坏法**：
- 补种了却不判删除 ⇒ 每次增量白做一次整库 `INSERT OR IGNORE ... SELECT`（文档 §1.1 明确要取消的阶段）；
- **判删除却没补种 ⇒ 上一批盖的代次相对本批全部"陈旧" ⇒ 误判整库删除**。

**改动**：合成单一判据 `removalDetection = Boolean(incremental && !incremental.preserveAbsent)`，
补种 / 删除闸门 / `finalizeImportGeneration` 三处都从它取值；并加一条断言把
"`recordDelta` ⇒ 不判删除"这条蕴含钉住（违反时抛 `RecordDeltaNotEligibleError`，
调用方按"不算本车道"回退旧链路，而不是变成误判删除）。

**副作用（这是本步的真实收益）**：`preserve-absent` 的增量批**不再做那次整库补种**。
这正是文档 §1.1 列出的待取消阶段之一，且此前**每次**增量导入都在跑。

**新增 `packages/health-export-parser/test/generation-seeding-pairing.test.ts`（3 条）**，
刻意做成**正反两面**（只测一面是没有意义的 —— 把补种整段删掉，只测"增量不补种"照样绿）：
1. 增量不补种：先删掉 beta 的代次行，跑一批只含 alpha 的增量，断言 beta **仍然没有**代次行
   （出现即说明跑了整库补种）；同时断言 alpha 的代次被更新到本批（防止"代次写入整体坏掉"也被算通过）。
2. 完整快照仍补种：把两条的代次行都删掉，跑一批只含 alpha 的完整快照，断言 beta **被判删除**
   （若补种被跳过，beta 找不到陈旧代次 ⇒ **静默留下**，正是最危险的失效方向）。
3. 直连恒为增量：`recordDelta` 缺 `preserveAbsent`、或显式 `false`，都必须不合格；
   且正面用例断言"完整资格**不会**被资格门拒绝"（否则上面两条可能只是"这个门什么都拒"）。

**突变验证（两个方向各一次，全部精确捕获）**
- A：跳过补种 ⇒ 用例 2 红（`完整快照必须把载荷里没有的训练判为删除 / 0 !== 1`）—— 即漏删方向。
- B：恢复成未配对写法（增量也补种）⇒ 用例 1 红（`增量载荷不得补种：beta … 代次行不该出现`）
  —— 即"白做整库写入"方向。

**另一处实测发现（归类为 v34 的连带影响，已修）**：v34 给 `health_records` 加列，
打破了用**位置参数**写死列的测试 fixture（`health-export-parser/test/healthkit-record-sync.test.ts`
的 `INSERT INTO health_records SELECT …`）。已改为显式列名（以后再加列不会再断）。
全库扫描确认：**生产代码全部使用带列名的写法**，中招的只有 test fixture。

**回归**：`npm run typecheck` `EXIT=0`；
`health-export-parser` + `storage-sqlite` 全包 **231 条 / 230 pass / 0 fail / 1 skip**；
`application` + API 导入链（8 个文件）**266 条 / 266 pass / 0 fail**。
1 条 skip 仍是 `publication lock rejects PID reuse`（本机 `ps` 被沙箱拒）。

### 步骤 5 的实测证据（2026-10-12）

**先说缺陷本身（这是本步存在的理由）。** 旧实现是「先 `DELETE FROM route_points` 再解析」
（`beginRoutePointReplacement` → `parseGpxFile` → `completeRoutePointReplacement`）。
于是**把一份已成功导入的路线文件改坏**，会连带擦掉那条**正在展示的轨迹**：
`point_count` 归零、`file_status` 变 `invalid`，`recompute-pipeline` 的汇总只认 `imported` ⇒
该次跑步的轨迹与高程增益静默消失。用户看到的是"这次跑步没有轨迹"，像数据本身缺失。

⚠️ 这不是推断：`parser.test.ts` 原来就**按这个行为断言**（`{ fileStatus: "invalid", pointCount: 0 }`）。
本步把那三条断言改成新契约，并同时断言"旧轨迹的点仍然读得到"与"失败留下可检索证据"。

**存储层新增四个方法**（`RaiDatabase`）：

| 方法 | 作用 |
|---|---|
| `beginRouteVersion(routeId)` | 开**未发布**暂存版本；**完全不碰** `route_points` |
| `appendRouteVersionPoints(versionId, points)` | 分片写候选点 |
| `publishRouteVersion(versionId, sha256, count)` | **一个短事务**：自证 → 换点 → 移指针 → 置 `imported` |
| `rejectRouteVersion(versionId)` | 只标记版本；路线状态/指针/已发布轨迹一字不动 |
| `hasUsableRoute(routeId)` | 「有没有一份正在展示的可用轨迹」——失败分支据此决定要不要改路线状态 |

**发布前自证的两条**（只数行数是不够的）：
1. 点数必须等于调用方声明的数量；
2. 序号必须从 0 连续到 n−1 —— 分片少写一片、或片内顺序错乱时**行数可能照样对得上**，
   那会发布出一条中间断掉的轨迹而无人察觉。

**两处对设计初稿的修正（都是实测逼出来的）**

1. **版本 id 必须确定性，一条 route 一行。** 初稿用随机 id 建"每次内容一条不可变版本"。
   实测报红：`published_route_version_id` 落在 `workout_routes` 里，而 `importEquivalence`
   对那张表**所有列**求摘要 ⇒ TS 与 Rust 两次导入因随机 id 而摘要不同，
   `native-worker.test.ts` 的导入等价性失败。改为由 **route 身份**推出确定性 id。
   代价：这条路线不留内容历史。收益：结果可复现，且**版本行数被路线数封顶**
   （初稿里"版本表会无限增长"这条风险随之消失，§7 的 ⚪ 项可以划掉）。
2. **失败分支要判「有没有可用旧轨迹」**，不能无条件 `markRouteStatus`。
   有旧轨迹时把它打成 `pending`/`invalid` 等于把一条好轨迹说成"没导入"。
   无旧轨迹时保留今日行为（`invalid` / `pending`），既有用例因此不受影响。

**新增 `packages/storage-sqlite/test/route-version.test.ts`（5 条）**：点数不足拒绝、序号不连续拒绝、
完整发布后产物与候选点数一致、同路线复用版本行且残留暂存点不拼入、被拒版本不动任何已发布状态。

**突变验证（3 处，全部精确捕获）**
- A：去掉发布前的完整性校验 ⇒ 用例 1、2 红（`Missing expected exception.`）。
- B：失败分支恢复无条件 `markRouteStatus` ⇒ `parser.test.ts` 红，实际值退回
  `{ fileStatus: 'invalid', pointCount: 0 }` —— 即**旧的破坏性行为回归**。
- C：版本 id 改回非确定性 ⇒ `native-worker.test.ts`（TS/Rust 等价性）**与**
  `route-version.test.ts` 用例 4 同时红。

**回归**：`npm run typecheck` `EXIT=0`；
`health-export-parser` + `storage-sqlite` 全包 **236 条 / 235 pass / 0 fail / 1 skip**；
`application` + API 导入链（10 个文件）**275 条 / 275 pass / 0 fail**。
1 条 skip 仍是 `publication lock rejects PID reuse`（本机 `ps` 被沙箱拒）。

**⚠️ 本步的过渡代价（必须在 PR5/PR6 收口）**：发布时点被写进 `route_points` **两处**
（版本表 + 当前表）。读侧仍然只读 `route_points`，所以这正是"不发布半条路线"的代价；
PR5/PR6 让读侧改走版本表之后，`route_points` 与这次的双写一起退役。

### 步骤 6 的实测证据（2026-10-12）

本步**由多智能体并行完成并交叉复核**（两条写入线 + 一条只读红队），结论以"复核者独立复跑"为准。

**6a — `canonicalizeNightsForWindow`（局部 canonical）**
- 新增导出 `canonicalizeNightsForWindow(database, tz, fromLocalDate, toLocalDate)`；
  `canonicalizeNights()` 全量版保持逐行等价（抽出内部 `rebuildCanonicalNights` 共享）。
- **验收判据是"窗口不变性"**：对任意窗口 `[a,b]`，窗口内各行必须与全量重建**逐列（含
  id/provenance）相同**，且窗口外各行（**含 `computed_at`**）一个字节不改。
  测试用 3 种 fixture 形状 × 全部 28 个 `a ≤ b` 子窗口做**整表逐字节**对拍（共 14 条）。
- 🔴 **必须配绝对锚**：差分/对拍**差不出"两边同坏"**。实测演示过 —— 把决胜排序写反 ⇒
  全量与窗口化同时挑错来源 ⇒ 差分全绿，唯一红的是"该形状确实走到目标分支"的前置断言；
  把 `sourceRank` 改错 ⇒ 差分同样全绿，红的是手算 golden。所以另有手算 golden 与
  "确实走到目标分支"的前置断言（形状 B 钉 rank/段数/名字三级决胜；形状 C 把 90min
  切分阈值钉在 `[89,91)` 并同时断言 `main=4/nap=3` 以防"某晚一行都没产出"的假阳）。
- 一道**拒跑式守卫**：`canonical_hrv_days.night_id → canonical_nights(id) ON DELETE CASCADE`
  意味着"窗口外的 hrv 行指向窗口内 night"时，删窗口内 night 会级联删掉窗口外行。
  正常库该不变量恒成立但**无约束守护**，故在 `BEGIN` 之前做只读探测，命中即抛错、零写入。

**6b — `FactsReader` 契约 + 最小只读实现**
- 新增 `packages/storage-sqlite/src/read/facts-reader.ts`（只读连接、按 `(type, 时间窗)` 分块 +
  主键 keyset 翻页、全程无 `BEGIN`），并从包桶导出。
- 恢复规则：历史行优先（`valid_from_generation <= G AND (valid_to_generation IS NULL OR > G)`），
  否则退化为当前行；两条都不满足 ⇒ 不可见。🔴 **`valid_from_generation` 为 NULL 必须解释为
  "自古以来有效"** —— v34 之前的老行全是 NULL，当成不可见会让 reader 在任何老库上返回空集。
- ⚠️ **已知边界，见下方裁决 D1**：本实现**只覆盖 update、不覆盖 delete**（被删除的实体在任何
  代次都读不到）。这不是漏测，是**明写口径**，并有一条边界用例钉住（谁将来补 union，那条会先红）。
- ⚠️ **今天没有生产调用方**，且 `import_fact_history` / `import_generations` 的**写入方也还没落地**
  （v34 只有 schema）。所以它现在能读到的实质只有"当前行"。这是契先行的有意安排，不是"已可用"。
- `fromAt`/`toAt` 收紧为**带显式偏移的绝对时刻**：拒绝只写日期（会被按 UTC 解释而静默漏 8 小时）、
  拒绝无法解析、并拒绝**可解析却不存在的时刻**（`2026-02-30` → 被 SQLite 静默归一化成 `03-02`、
  `24:00:00`、非闰年 `02-29`）。三类都是"参数写错 → 看起来像没有数据"的静默失效。

### 红队复核的发现与处置（2026-10-12）

独立只读红队对步骤 1–5 做对抗式复核，命中 7 条。**逐条处置如下**（全部有复现证据）：

| # | 严重度 | 问题 | 处置 |
|---|---|---|---|
| F1 | 🔴 | `published_route_version_id` 会指向一条 `rejected` 版本：一条行同时当"暂存"与"已发布记录"用，一次失败的重导把**正被引用**的那条打成 `rejected` ⇒ 读侧（PR5 起 JOIN `complete`）读不到轨迹 | **已修**：拆成 staging / published 两个**确定性**槽位；`begin` 永不碰 published 行；`rejectRouteVersion` 加"拒绝去动被引用版本"的兜底断言 |
| NEW-1 | 🔴 | 发布"换点"遇瞬时错误 ⇒ `route_points` 被清空，而元数据仍说 `imported`/`point_count=2`（非原子，且 `gpx-parser` 吞错继续） | **已修**：发布段包 `SAVEPOINT`（全有或全无）；并且只把 `parseGpxFile` 那一小段当"文件可能坏了"的窗口，**其余阶段的错误一律上抛**，不再写假话 `INVALID_GPX` |
| NEW-2 | 🟡 | published 版本行**没有内容**（`point_count=2` 却 0 行点），设计 §3.2/§7 的"过渡期双写"被静默丢掉 ⇒ PR5 切读侧会丢轨迹 | **已修（选 B：真双写）**：发布时把点同时写进 published 版本的 `route_version_points` |
| F3 | 🟡 | §14.1 的 `seed-import-generations` 只有子命令通道，而直连车道不跑子进程 ⇒ 该守卫在那条车道上**构造性真空**（"全 0"什么都没证明） | **已修**：给清单加**进程内**通道 `storeMethod` 并包 `RaiDatabase.prototype`；另加**能响**的阳性对照。仍真空的 `canonical-nights-full-rebuild` 用 `vacuousOnDirectLane` **显式声明**，并把真空清单写死断言 |
| F4 | 🟡 | caller 模式下内部提交点直接用公开 `flush()` ⇒ 一条现成写入路径抛错，且 `catch` 里的 `rollback()` 把真错误换掉；`close()` 抛错导致 `database.close()` 永不执行（**句柄泄漏**） | **已修**：新增内部 `flushIfOwned()` / `rollbackIfOwned()`（commit 权不在自己就什么都不做）；`close()` 用 `try/finally` 保证句柄必关。公开 `flush()/rollback()` 在 caller 模式下**仍然抛错**（对外保证不变） |
| F6 | ⚪ | `direct-sync.ts` 注释声称 "`packages/contracts/test` 与 API 守卫测试都会断言这个不变量" —— 前者**不存在** | **已修**：改成"唯一执行者是 API 守卫测试"，并点明"声称有第二道守卫、实际只有一道"比只有一道更危险 |
| F2 | 🔴→撤回 | `facts-reader.ts` 的 `>=` | 经复核是**作者突变验证窗口期的中间态**，已回退；按"作者停手后冻结 md5 + 连跑多次一致"结案 |

### 三条裁决（2026-10-12，由我拍定）

**D1 — §5.2 判据 8 是否覆盖 delete：裁 (a) 只覆盖 update，写成明写口径。**
理由：补 union 在 SQL 上做得到（`import_fact_history.effective_at` 可做窗口谓词），真正的阻塞是
**v34 没有任何写入方** —— 没有东西保证 `effective_at` 会被填、更没保证它与当前表 `start_at` 语义对齐。
所以现在既不能声称覆盖、也不该为它引入第二套时间比较（那正是"同一判据两处写法"的坑）。
⇒ **PR4 的验收要求**：真接写入方时，必须同时定掉"删除是否要在旧代次可见"，并把这条边界用例改掉。

**D2 — 回执的 `rawGeneration`：删除，而不是改名。**
它装的是批次 token `delta:<jobId>`，①与 `receiptId` 重复 ②名字让人以为能喂给要 `number` 的
`FactsReader`。改个名会留下"看起来有版本号、实际没有"的第二种过度承诺。同时把"版本号还不存在"
（`import_generations` 计数器 + `valid_from_generation` 打标**全仓无写入方**）写进契约文件；
其余三个恒 `null` 的字段保留（它们的 null 语义是**准确的**："本批不影响分析/没发布新分析/未分片"）。
⇒ 数值版本号连同写入方一起在 PR4 回归。

**D3 — `fromAt`/`toAt` 的收紧：接受。**
红队全仓核对确认**零生产调用方**，且桶尚未导出时它**结构性不可达** ⇒ 零兼容风险；
而收紧掉的正是"参数写错 → 看起来像没有数据"这一类静默失效。
⇒ 文件名里已有的代表集足够（4 条 reject + 3 条 accept）；红队探针里更宽的矩阵**不进文件**，
以免为覆盖面反复换冻结基线。

**D4 — canonical 门禁规模：接受收敛，不另开 CI 门禁。**
3 形状 × 整表 sweep（14 条）已覆盖"窗口内=全量 / 窗口外不变 / 基准自身 / rank 决胜 /
会话切分 / HRV 边界"，且它随 `npm test` 运行。再加的是更大随机 fixture，而随机 fixture 会撞既有
`CHECK`（实测到"nap 无 onset"的偶发红灯），**不进仓**。

### 红队第二轮：`recoverInterrupted` 把一个既有缺陷翻出来了（2026-10-12）

结论先行：**我原以为"6b 现在做没意义"的那个前提本身错了，而且错得比想象中严重 ——
它不是一个待办，是一个今天就能触发的缺陷。**

**缺陷链条**（每一环都由我逐条读码 + 探针亲验）：
1. `packages/health-export-parser/src/cli.ts:321` 无条件生成 `importJobId`，
   `:334-340` 为**每次** CLI 导入插入 `job_type='import', status='running'` 的任务；
2. CLI 进程崩溃 / 掉电后该任务停在 `running`；
3. API 下次启动在 `server.ts:568` 调 `recoverInterruptedJobs()`；
4. `packages/storage-sqlite/src/recompute-job-repository.ts:181-191` 的 SELECT **不过滤 `job_type`**，把所有 `running`
   一律写回 `queued`、`progress_phase='recovered'`，并**把 `error_json` 清空**；
5. 唯一那个消费者（`application/src/service.ts:283 runNextJob`）只认
   `full_recompute` / `snapshot_refresh`，`import` 落进 `else` 抛错，`:296` 置为 **failed**。

**实测**（探针，非推断）：
```
before recover : {"status":"running","ph":"prepare","err":null}
recovered count: 1
after recover  : {"status":"queued","ph":"recovered","err":null}   ← 原始中断原因被清掉
claimNext      : import                                            ← 被消费者领走
最终            : failed / "Unsupported application job type: import"
```
用户看到的是一条**原因错误**的失败任务，而真因（拥有它的进程崩了）已被恢复流程抹掉。

**修法（按"谁能执行"分派，而不是按"是不是 running"）**：
- `packages/contracts/src/index.ts` 新增两个**共享常量**（共享常量放 contracts，双方都依赖）：
  - `APPLICATION_CONSUMABLE_JOB_TYPES` —— 消费者真正能执行 `["full_recompute","snapshot_refresh"]`；
  - `EXTERNALLY_OWNED_JOB_TYPES` —— 有自己所有者进程、**不得**交给消费者，含 `"import"` 与原因。
- `recoverInterrupted()` 据此分派：可消费 ⇒ 仍回 `queued`（既有行为不变）；
  外部所有者 ⇒ 判 `failed` + `progress_phase='interrupted'` + **保留中断原因**。
- 🔴 中断文案按类型分：外部所有者类型用自己的 `InterruptedExternalJob` /
  "Job was interrupted before its owning process completed it"，**不复用 recompute 那句**
  ——"API 在 recompute 完成前重启"对一条导入任务是**假话**。本轮修的就是"用户看到错误原因"，
  文案层不能又把错因写回去（红队第二轮当场抓到这一点，并指出**我写的测试把错文案钉成了期望值**）。

**新增 `packages/storage-sqlite/test/recompute-job-recovery.test.ts`（4 条）**，含**两条负向对照**
（可消费类型仍回队列 / 已请求取消仍走 cancelled）—— 只断言"import 不再被放回队列"是无法区分的：
把整段恢复逻辑删掉、或让它把一切判失败，都能让那条通过。另有一条**结构约束**：从**生产 DDL**
（`database.ts:484` 的 `CHECK (job_type IN (...))`）解出类型清单，断言每个类型要么在
`APPLICATION_CONSUMABLE_JOB_TYPES`、要么在 `EXTERNALLY_OWNED_JOB_TYPES`
⇒ 新增一个"既没消费者、也没声明所有者"的 job_type 会被判红，恢复流程不可能再不知道拿它怎么办。

**同轮修掉的其它 ⚪（都是我引入的不一致）**：
- `unobservableProhibitedOperations()` 忘算新增的 `storeMethod` 通道 ⇒ 会把
  `seed-import-generations` 误报成"没人守的孤儿"。**通道加一处，判据就得跟着加一处。**
- 我在 `direct-sync.ts` 注释里写"`packages/contracts/test` 不存在" —— 该目录**存在**（5 个文件），
  缺的是"断言该不变量的测试"。把"目录里有测试"说成"那里守住了"，正是我那句注释在批的毛病。
- 6b 交付里那条**文本级**守卫（在源码里找 `directSync:` 后面必须跟 `{`）有假绿：后面若是函数调用
  而非内联字面量就检测不到。已由作者修成"找不到 `{` 即判红"；但该守卫的**权威版本仍是行为级断言**
  （`direct-sync-prohibited-operations.test.ts`），文本级只是便宜的早期警报。

**仍未修（记录在案，不声称已守）**：`packages/health-export-parser/src/cli.ts:421-432` 把任务置 succeeded 时**不带
`AND status='running'`**，理论上会覆盖并发的状态变化。红队标注"未证实、可达性低"，我同意 ——
本轮不修，因为它属既有 CLI 路径、又没有复现路径；要动它得先能构造出那个竞争窗口。

### 🔴 步骤 6b：分析任务登记（切路前**必须**做；本步只落地"能力 + 门禁"，**登记本身仍未做**）

`planDirectSyncLane` 把车道限定为 `"record-only"` 是有前提的：record-only 载荷
**结构上不可能**触及分析，所以可以不登记分析任务。一旦 `deltaMode` 扩到 `"full"`
（Workout / 评分类型 / 删除），**必须同批**接上登记，否则会出现"原始已存、分析不更新"，
直接违反文档 §1.5（读取不能把旧分析标成最新）。

落地点已经确认（读码得到，不是推测）：

| 项 | 位置 |
|---|---|
| 登记入口 | `packages/storage-sqlite/src/recompute-job-repository.ts:46` `enqueue(jobType, datasetVersion, request, bindings?)`（`bindings` 为本步新增的可选参数） |
| 它**不自开事务** | 同上（只有裸 `INSERT` + `logEvent`）⇒ 正好能在 §4.2 要求的**同一个**主库事务里落库 |
| 绑定列已就位 | `recompute_jobs.target_raw_generation` / `target_dependency_generation` / `expected_incumbent_release_id` / `dirty_json`（v35 加的） |
| 代次来源 | `import_generations(singleton=1, raw_generation, dependency_generation)`（v34 加的） |

要做的三件事：
1. `enqueue` 增加可选的绑定参数（或新增 `enqueueDirectSync`），把四个绑定列写进去；
   ⛔ 不放宽 `job_type` 的 `CHECK`（仍是 `'import'`）。
   （**本步已落地"能力"部分**：`bindings` 可选参数已加，见下方"本步已落地"。）
2. `applyDataOnlyImport` 的 `beforeCommit` 里，在**同一个事务**内：
   递增 `import_generations.dependency_generation`、登记任务、并把
   §10.1 回执的 `analysisStatus` 写成 `"queued"`（**不是** `"published"`）。
3. `planDirectSyncLane` 的 `deltaMode` 放开到 `"full"` —— 这一步与上面两件**同批**，
   并由一条断言钉住："`deltaMode === "full"` 时回执里必须存在已登记的任务"。

#### ⚠️ 前提纠正（2026-10-12，本步核实）

初稿这里写的是"在没有分析消费者（PR4）之前登记任务，只会积压一堆永远不跑的 queued 行"。
**这句话是错的。** 核实证据（`文件:行号`）：

| 断言 | 证据 |
|---|---|
| 分析消费者**存在** | `apps/api/src/recompute-worker.ts:75` 调 `hasPendingJob()`；`packages/application/src/service.ts:283` 的 `claimNext()` 是真正的消费者 |
| 消费者**只认识两种类型** | `service.ts:287-293`：只处理 `full_recompute` / `snapshot_refresh`，其余落进 `else` 抛 ``Unsupported application job type: ${jobType}`` |
| 未知类型被**置为失败**（不是留在队列里） | `service.ts:296` 调 `this.jobs.fail(job.id, error)`；`RecomputeJobRepository.fail` 把 `status` 置 `failed` 并写 `error_json` |

实跑（临时库：`enqueue("import", null, {})` → `service.runNextJob()`）：

```text
status before run:   queued
runNextJob returned: <job id>
final status:        failed
final progressPhase: failed
final error:         {"message":"Unsupported application job type: import","name":"Error"}
```

⇒ **今天把 `import` 类型登记进直连车道，比"积压"更糟**：它会被消费者**领走并立刻置为
`failed`**，成为一条**用户可见的失败任务**。初稿"消费者先行"的方向是对的，但把
"没有消费者"当成了前提 —— 真正的阻塞是**消费者不认 `import` 这个类型**。

#### 🔴 正确的上线顺序（三步，缺一不可）

1. **消费者先认识 `import`**：给 `service.runNextJob()` 加 `import` 分支（真正跑分析），
   让 `import` 不再落进 `Unsupported`。这一步属 PR4。
2. **再在直连车道同批登记**：同事务内 `enqueue` 写四个绑定列 + 递增
   `dependency_generation` + 回执 `analysisStatus: "queued"`（**不是** `"published"`）。
3. **最后才放开 `deltaMode: "full"` 切路。**

🔴 三步之间的门禁：`apps/api/test/direct-sync-analysis-registration.test.ts` 断言
"今天 `import` 被消费者**失败**，原因恰为 `Unsupported application job type: import`"。
第 1 步一旦落地，这条测试会**变红** —— 逼改动者同批接上第 2、3 步，而不是只让消费者"不再报错"。

#### ⚠️ 步骤 1 的隐藏坑：`job_type='import'` 今天**已经有两种语义**（红队 red-team-2 指出，已独立复现）

`'import'` 不是分析任务专用的：**旧 CLI 导出导入**就在写它 ——
`packages/health-export-parser/src/cli.ts:334-340` 以 `job_type='import'`、`status='running'`、
`request_json={"mode":"cli_export_import"}` 建任务；而 `packages/health-export-parser/src/cli.ts:505-512` 的
`finally` **只 `store.close()`，不标失败**。

⇒ **（修复前）** 一次被强杀/失败的 CLI 导入，会在库里留下一条 `running` 的 `import` 任务；API 启动时
`server.ts:568` 调 `recoverInterruptedJobs()` ⇒ `packages/storage-sqlite/src/recompute-job-repository.ts` 的
`recoverInterrupted()` 把它退回 `queued` ⇒ 消费者领走并置 `failed`。

实跑（修复前；临时库，逐列复刻 CLI 写入）：

```text
1) CLI 中断后:            running
2) recoverInterruptedJobs() 返回 1 → queued import
3) runNextJob() → recompute_job_cli_probe failed {"message":"Unsupported application job type: import","name":"Error"}
```

🔴 **所以步骤 1 不是"给 `import` 加个分支"这么简单**：一旦分支能跑分析，上面那条**被复活的 CLI
导入任务**会被当成分析任务去执行。分支入口**必须先把 CLI 导入任务排除**——判别物已经就绪：
`request.mode === "cli_export_import"`（见 `packages/health-export-parser/src/cli.ts:340`）。建议在分支内**写死拒绝**该载荷，并配一条
"期望被拒绝"的测试。更彻底的做法是给分析任务独立 `job_type`，但那要改 `CHECK`
（= **放宽**，v35 文件头明令禁止），需要单独的迁移 + 门禁，**本步不做**。

（红队在同一轮指出这一点后，已有**并行修复落地**：`packages/contracts/src/index.ts:564-579` 引入
`APPLICATION_CONSUMABLE_JOB_TYPES`（只含 `full_recompute` / `snapshot_refresh`）与
`EXTERNALLY_OWNED_JOB_TYPES`（把 `import` 声明为 CLI 进程所有），`recoverInterrupted()` 据此把
非消费者类型的中断任务**直接判为 `interrupted` 失败**、不再放回 `queued`。⇒ 上面这条"复活"路径
**已被关闭**，本节把它记为当时的事实。但**步骤 1 的判别要求不变**：一旦 `import` 被列入
`APPLICATION_CONSUMABLE_JOB_TYPES`，被恢复的 CLI 导入任务就会重新进入新加的 `import` 分析分支 ——
所以登记前仍必须让分支入口拒绝 `request.mode === "cli_export_import"`。）

⚠️ **随该修复而来的文案要求**（红队 red-team-2 指出）：非消费者类型中断时复用了 recompute 的那条
`failure`（`{"name":"InterruptedRecompute","message":"Local API restarted before the recompute completed"}`），
对 CLI 导入任务**语义是错的**，而 `packages/storage-sqlite/test/recompute-job-recovery.test.ts` 又把它钉成期望。
⇒ 若步骤 1 的实现或 UI 要读这类中断任务的原因，**必须先给外部所有者类型一条中立的失败文案**，
否则会把"重算被重启打断"这句错误结论展示给用户。（该文案归 `EXTERNALLY_OWNED_JOB_TYPES` / 恢复流程的所有者处理，不在 6b。）

#### 本步（安全形态）已落地

- `RecomputeJobRepository.enqueue` 增加可选 `bindings` 参数（`target_raw_generation` /
  `target_dependency_generation` / `expected_incumbent_release_id` / `dirty_json`）。
  **不传时执行与历史逐字节相同的 SQL**（四列保持 NULL）⇒ 既有调用方 `service.ts:304` 行为不变。
  ⛔ 未放宽 `job_type` / `status` 的 `CHECK`。
- 门禁测试（见上）+ 两条"今天不许登记"的断言：`planDirectSyncLane` 恒为 `deltaMode: "record-only"`、
  直连回执 `analysisStatus` 恒为 `"not_required"`。
- ⛔ **本步有意未做**：不真的登记任何分析任务，`planDirectSyncLane` 的 `deltaMode` 不放开到 `"full"`。
