# 未提交改动审查（2026-09-21）

**审查对象**：工作区未提交改动（审查时 31 个已跟踪文件 + 2 个未跟踪交付物；**修复完成后实测为 39 个已跟踪改动 + 4 个未跟踪文件**），`HEAD` = `41c2490`。
**改动主体**：影子对照（shadow full-replay）删除三阶段实施 —— 阶段 A 删影子重放、阶段 B 新增运行时不变量 B1–B5、阶段 C 细分计时；连带文档与部署模板同步。
**方法**：结论一律落到 `文件:行号` 或命令输出。数值一致性用只读探针在真库（`var/rai.sqlite`，324 MB / 83,380 `health_records` / 204,284 `route_points`）实测；反例假设逐一证伪后才下判断。本轮**推翻了上一轮我自己写下的两处结论**（见 R1、✅8）。

| | 级别 | 结论 | 证据 |
|---|---|---|---|
| R1 | 🔴 **✅ 已修** | **B5 的性能声称不成立**：新排序键在本机热缓存下**净退化 19%**（5,790 → 6,919 ms），"21.7 s → 3.0 s（约 6×）"无法复现；该数字已写进代码注释与两份文档 | 探针 3 轮中位数；`import-equivalence.ts:43`、`RUST_DATA_ENGINE.md:229`、方案文档 `:175` |
| R2 | 🔴 **✅ 已修** | **`--replace` 下 B3 的幂等断言近乎失效**，而注释声称它是"mode-independent"；且重放开销被 `purpose:"replay"` 从指标里完全抹掉 | 探针 `incremental=false … replay.inserted=2 ledger=0->0`；`native-record-writer.ts:117/137`、`main.rs:574/582` |
| R3 | 🟡 **✅ 已修** | **B4 缺少"实际比对行数为 0"的守卫**：尾部样本全落空时静默通过（"断言恒真"形态） | `native-record-writer.ts` 新增 `compared === 0` 守卫；回归用例 + 突变 `if (false)` ⇒ `not ok 8` |
| Y1 | 🟡 **✅ 已修** | **同一概念三处三种名字，本次只改了一处**：用户可见文案仍叫 "shadow model 门禁" | 5 处统一为"模型版本门禁"；`rai-shadow-gate-v1` 为持久化标识**刻意保留**；残留 grep 清零 |
| Y2 | 🟡 **✅ 已修** | `docs/DATABASE_DESIGN.md:168` 仍把已删的 `recompute_validations` 机制描述为生效 | 已改为"**已废弃（2026-09-20）**…表恒为空"并指向 B1–B5 |
| Y3 | 🟡 **✅ 已修** | `scripts/split-application-service.mjs` 是孤儿生成器，内嵌已删字段的旧模板，重跑会把 `validationMode` 注回 `service.ts` | 已 `rm`（`git status` 为 `D`）；删前确认零引用 |
| G1 | 🔴 **✅ 已修** | **本机门禁 5 个 flaky 用例**（🔴 本轮新发现）：根因是 `RecomputeWorker.drain()` 对**空队列**也持有全局写锁 **2 456 ms**（spawn 线程重跑 `tsx register`）> `acquireWhenAvailable` 的 2 000 ms 租约 ⇒ 写路由全被 `409 mutation_conflict` 顶掉 | 探针 `active="recompute"` 持续 2 456 ms；`recompute-worker.ts:62`、`task-admission.ts:22`、`server.ts:357` |
| ✅ | — | 阶段 A 删除彻底、真闸门保留且区分清楚、阶段 C 接缝逐字对上、B1/B2/B3/B4 关键判据成立、门禁全绿 | 见 §四 |

---

## 一、🔴 必修

### R1. B5 的性能声称不成立，且新排序键净退化 —— 数字已扩散到 3 处

`apps/api/src/import-equivalence.ts:40-48` 的注释写：

> The previous code sorted column NAMES alphabetically … **measured 21.7 s vs 3.0 s on the 310 MB database**.

同一数字出现在 `docs/RUST_DATA_ENGINE.md:229` 与 `deliverables/SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md:175`（"实测 **21.7 s → 3.0 s**（约 6×）"）。

**实测（本机 324 MB 库，同一域清单，隔离"排序键"单一变量）**：

| 条件 | OLD（字母序列名） | NEW（主键优先） | 差异 |
|---|---|---|---|
| 冷缓存首跑 | 21,708 ms | 11,516 ms | −47% |
| 预热后 3 轮中位数 | **5,790 ms** | **6,919 ms** | **+19%（退化）** |

分表中位数（热态，仅列差异 >15%）：

| 表 | 行数 | OLD | NEW | 差异 |
|---|---|---|---|---|
| `route_points` | 204,284 | 2,383 ms | 1,898 ms | **−20%（唯一改善）** |
| `import_entity_changes` | 83,370 | 661 ms | 1,200 ms | **+82%** |
| `import_entity_generations` | 83,651 | 589 ms | 1,184 ms | **+101%** |

**根因（有索引证据）**：`import_entity_changes` 上存在 `idx_import_entity_changes_effective(batch_id, effective_at)`，`import_entity_generations` 有 PK autoindex。新 `orderBy` 以 **PK 首列**开头，SQLite 因而选择走索引 —— 但索引的次级序与 `ORDER BY` 不匹配，于是变成「索引扫描 + 回表 + 仍要排序」，比原来的「全表扫描 + 排序」更贵。

已**证伪**的替代解释：不是"排序列重复"。探针 `new-dedup`（去重后 1,190 ms）vs `new`（1,189 ms）**无差异**。

**回答"21.7 s 从哪来"**：冷缓存首跑 OLD = 21,708 ms —— 与 21.7 s 吻合；而 3.0 s 在冷态（11.5 s）与热态（6.9 s）**都不出现**。该数字是跨条件拼接的结果。

**实际影响比"没变快"更重**：旧域清单 20 个域，新域清单 **22 个**（多 `import_entity_changes` / `route_file_fingerprints`，两表各 8 万余行）⇒ 旧代码实测口径 ≈ 5,162 ms，新代码 6,919 ms ⇒ **新代码整体比旧代码慢约 34%**。

⚠️ **必须同时讲清的一点**：B5 的**正确性价值完全成立** —— 补域让比较面第一次覆盖 Rust 实际改动的写路径；PK 打头的排序键也让"行序不再依赖非唯一列"，消除了 `health_records` 以 `created_at` 打头时同值行的 tie 导致的 hash 不稳定（假分歧）。**错的只是性能叙述与"改按主键打头"这个具体取舍**，不是 B5 本身。

### R2. `--replace` 模式下 B3 的幂等断言近乎失效，注释却称其"mode-independent"

`packages/health-export-parser/src/native-record-writer.ts:115-117` 的注释：

> Under `--replace` the worker counts every row it WRITES … **the change-ledger delta is the mode-independent assertion.**

**实测（探针，已清除）**：

```
PROBE incremental=false count=2 first.observed=2 replay.inserted=2 replay.tombstoned=0 ledger=0->0
PROBE incremental=true  count=2 first.observed=2 replay.inserted=0 replay.tombstoned=0 ledger=1->1
PROBE incremental=true  count=2 first.observed=2 replay.inserted=0 replay.tombstoned=0 ledger=0->0
```

三条推论：

1. **ledger 断言在 replace 下恒真**。`this.batchId` 为 `undefined`（`apple-health-parser.ts:289` 只在 incremental 下取 `options.incremental?.batchId`）⇒ `ledgerCount()` 提前 `return 0`（`:70`）；而 Rust 侧 `if let Some(batch) = &batch`（`main.rs:574`）**根本不写 ledger** ⇒ 0 === 0。
2. **`inserted === 0` 断言对 replace 关闭**（`:137` 的 `this.incremental &&`）—— 这是**必须的**，因为 replace 下第二遍**必然**重写全行：`main.rs:582` 的 `if !incremental || !exists || updated` 对 `!incremental` 恒真，且随后 `inserted += 1`。探针确认 `replay.inserted = 2 = count`。
3. ⇒ replace 模式下 B3 **只剩 `observed` 与 digest 两条输入侧断言**，而 B1 已经覆盖同一件事（输入流的行数、顺序、内容摘要）。

**成本侧**：replace 下 B3 会真实重写全部行（探针 `replay.inserted = count`），而 `native-worker.ts:177-183` 的 `if (options.purpose !== "replay")` 让这次调用**完全不上报** `rai:native-engine` 指标 ⇒ 真实导入的 wall time 增长在 `rustCalls` / `wallMs` / `computeStagesMs` 里**都看不见**。

**附带实测结论**（比注释更宽）：`incremental=true` 也可能 `ledger=0->0` —— 当本批所有行都 `exists && !updated` 时 Rust 不写 change。即 ledger 断言在**"无变化的增量同步"**下同样无检测能力；不过此场景下 `inserted === 0` 断言仍有效（探针第 2、3 行）。⇒ **缺口精确地只在 replace 模式**。

### R3. B4 缺少"实际比对行数为 0"的守卫

`native-record-writer.ts:196-209`：

```ts
for (const row of sample) {
  const actual = stored.get(row.id) as … | undefined;
  if (!actual) continue;                    // ← 落空即跳过
  for (const column of columns) { if (actual[column] !== row[column]) divergences.push(…); }
  …
}
if (divergences.length) { throw … }         // ← compared === 0 时永远不进入
```

若尾部 64 行**全部**不在候选库（都是被墓碑的行，或候选库为空），`divergences` 为空 ⇒ **静默通过**。上轮探针实测样本规模仅 `sampled=2 compared=2`（当时的夹具只有 2 行）⇒ 样本量本身可能极小，无守卫时 B4 会在"零比对"下宣称通过。这正是「断言恒真（写了等于没写）」形态，与 B3 的墓碑断言同类。

**修法**：统计 `compared`，在 `compared === 0` 时 `insertIssue({ code: "invariant.b4.no_rows_compared" })` —— 与 B2 同风格（记录、不阻断）。

---

## 二、🟡 待决策（本轮已全部处理，见 §六）

### Y1. 同一概念三处三种名字，本次只改了一处

本次改动的**明确意图**是消除混淆（`docs/RUST_DATA_ENGINE.md:162`：*"从 `Shadow model gate failed` 改为 `Model-version gate failed`，以免继续被混为一谈"*）。但只改了一处：

| 位置 | 现状 | 可见性 |
|---|---|---|
| `recompute-pipeline.ts:220` | `Model-version gate failed` | ✅ 本次已改 |
| `model-run-repository.ts:121` | `Model run failed the shadow validation gate…` | 内部错误消息 |
| `apps/api/src/server.ts:1442` | `"该模型运行未通过 shadow model 门禁，不能激活"` | 🔴 **直接呈现给用户**（HTTP 409） |

🔴 **不要连带改错**：`model-run-repository.ts:140` 的 `gateVersion = "rai-shadow-gate-v1"` 是**持久化版本标识**（写进 `model_validation_gates`，且被 `README.md:42/83`、`DATABASE_DESIGN.md:122`、`PR3_PRODUCTION_READINESS.md:14` 引用）—— 改了会与既有数据库记录不一致。**只改文案，不改标识**。

### Y2. `docs/DATABASE_DESIGN.md:168` 描述已删机制

> `recompute_validations`：局部结果与独立完整回放的 hash 对照，不一致时拒绝切换 active 数据库。

实测该表 **0 行**且无任何写入者（`grep` 仅剩建表 DDL `database.ts:1046` 与文档）。该文件**不在本次改动清单**，属漏改。修法：改为"表保留以兼容历史迁移；对照机制已于 2026-09-20 移除，恒空"。

注：同文件 `:192` 的 v13 迁移描述（"引入 `recompute_validations`（兼容 checkpoint + shadow 校验）"）是**历史事实记录**，建议保留不动。

### Y3. `scripts/split-application-service.mjs` 是孤儿生成器

内嵌 `validationMode: "off" | "shadow"` 旧模板（`:76`/`:84`），全库零引用（仅出现在自身）。本次删除了 `validationMode` 字段，却留下这个**会把已删字段重新注回 `service.ts`** 的脚本。修法：删除，或至少加显式弃用标注。

### Y4. B3/B4 的错误归因边界（低优先）

`apply()` 里 `assertSampleMatches` 紧随 `assertIdempotent`（`:233-234`），因此 B4 比对的是**重放之后**的状态。若重放把某行写坏，B4 会报 `Native write diverged from the canonical input`，文案指向不了 replay，排查会绕一圈。

### Y5. `apps/api/test/worker.test.ts:1378` 的死循环壳

`for (const validationMode of ["off"] as const)` —— 单元素循环，注释已说明保留是为了不动 fixture 缩进。无害，属清理项。

---

## 三、✅ 通过项

1. **阶段 A 删除彻底**：`validationMode`（除契约的历史兼容 enum）、`shadowValidation`、`--shadow-validate`、`importValidationModeFromEnvironment`、`ImportValidationMode` 全库零残留。仅 `api-contracts/src/index.ts:378` 与 `schemas.ts:511` **刻意保留**三值 enum —— 与方案 §2.2 一致（历史 job 出参里存在 `"shadow"`，收窄 enum 会让带该值的历史记录在出参校验时被拒）。
2. **真闸门被保住且已区分命名**：`evaluateValidationGate` 调用点 `recompute-pipeline.ts:218-221` 保留；`model_validation_gates` 表未动。这是"删 shadow 顺手删掉真防线"的高危点，处理正确。
3. **阶段 C 的 stage 名与 IPC 白名单逐字一致**（最易静默失效的字符串接缝）：
   `cli.ts:283` `parse_health_xml` / `:296` `import_gpx_routes` / `:316` `canonicalize_workouts` / `:320` `canonicalize_nights` / `:369` `stage_audit_files`
   ↔ `import-worker.ts:1485-1487` 白名单 —— 5 个名字逐个核对通过。
4. **B1 两侧公式可证一致**：TS `${this.count}|${record.id}|${hash}\n`（`count++` 在 update 之前 ⇒ 1-based）↔ Rust `format!("{}|{}|{}\n", observed, id, hash)`（`observed += 1` 在 update 之前）✓；Rust `row.get(14)` 对应 `SELECT` 第 15 列 `content_hash` ✓；顺序均为 `ORDER BY sequence` ✓；`use sha2::{Digest, Sha256}` 已 import（`main.rs:5`）、`sha2 = "0.10"` 已在 `Cargo.toml:12` ✓。旧二进制**容忍**（缺摘要只写 `invariant.b1.digest_unavailable` 警告）、摘要存在但非法仍按协议违规 ✓ —— 这个取舍正确：把部署顺序错误变成导入中断是更坏的选择。
5. **B2 不会误报**：不等式方向正确；`generation = stableId("import_generation", [batchId, new Date().toISOString()])`（`cli.ts:289`）**每批唯一** ⇒ `WHERE generation = 本批值` 不会累积历史行；`previewGenerationRemoval(options.incremental.generation)`（`apple-health-parser.ts:595`）使用同一值，印证该语义 ✓。
6. **B3 的上一轮修复保留且确有检测力**：不再断言 `tombstoned === 0`；探针显示 `incremental=true` 时 `replay.inserted=0` —— 该断言真的在跑，不是恒真。
7. **B4 尾部采样 + 按 id 去重**的论证正确（DESC 窗口内某 id 首次出现即其全局最后写入），且有真正能变红的回归用例：`packages/health-export-parser/test/native-worker.test.ts` "a record id carried twice keeps the last occurrence…"（断言存活行 `device === null`；上一轮已突变验证过改回头部采样会报 `<id>.device`）。
8. **测试删减与实现同步，未留悬挂断言**（此处**修正我中途的初判**）：
   - `import-performance.test.ts` 删的是**被删函数自身**的测试 ✓
   - `worker.test.ts` 把 `--shadow-validate` 的断言从"等于 shadow"改为 `assert.equal(args.includes("--shadow-validate"), false, "the removed shadow flag must never be passed")` —— **比直接删除更强** ✓
   - `import-replay.test.ts` 删除的 mismatch 场景确属 shadow 专属（它写 `recompute_validations`，该表只由 shadow 写）。我一度判断这造成"真闸门失去端到端覆盖"，**该判断被推翻**：`packages/storage-sqlite/test/model-run-repository.test.ts:161-186` 已断言"闸门失败 ⇒ 拒绝激活且不替换 incumbent"（`assert.throws(… /shadow validation gate/)` + `activeSummary()?.id === "base"`）✓ **不构成覆盖缺口**。
9. **部署与文档同步到位**：两份 env 模板移除该变量并**保留"模型闸门不受影响、仍始终生效"的说明**；`deploy/n100/README.md` 把"先开 shadow 验证一轮 / 异常时切回 shadow"标注为**不再可执行**（而非静默删除），并给出替代信号（`/v1/data-summary` 的 `issues` + 不变量结果）；`docs/RUST_DATA_ENGINE.md` 新增 B1–B5 章节（代码注释原本就引用该文档、此前指向空），含 B3/B4 两条"会把正常导入判死"的陷阱说明，与实现一致。
10. **门禁本次独立复跑全绿**：`npm run typecheck` ✔（双 tsconfig）· node **736 / 733 pass / 0 fail / 3 skip** · web **13 文件 / 84 pass** · `npm run rust:verify` **10/10** · `npm run test:ios` ✔（含"23/27 字段有展示位 + 9 组闭集枚举映射已接线"）。
11. **工作区卫生**：逐文件扫描无 ESC/控制字符、`git diff --check` 无告警、`git diff --summary` 无文件模式变更、探针零残留（`PROBE` 计数 0，`native-record-writer.ts` diff 规模回到 187/12）。

---

## 四、修复顺序 + 验收标准 + 回滚

按**可逆性**排序（不按严重度）。

| 序 | 项 | 改动 | 验收标准 | 回滚 |
|---|---|---|---|---|
| 1 | **R3** | `native-record-writer.ts:196` 统计 `compared`，为 0 时写 `invariant.b4.no_rows_compared` issue | 把 `sampleSize` 临时传 0 ⇒ 必须出现该 issue；还原后消失；`native-worker.test.ts` 7/7 绿 | `git checkout -- packages/health-export-parser/src/native-record-writer.ts` |
| 2 | **R2** | `apply()` 里仅在 `this.incremental` 时调用 `assertIdempotent`（replace 下跳过重放） | 探针复现：`incremental=false` 时不再出现 replay 行；全量测试绿；`--replace` 导入一次，`rustCalls` 与写入量回到单遍 | 同上 |
| 3 | **R1(a)** | 更正 `import-equivalence.ts:43`、`RUST_DATA_ENGINE.md:229`、方案文档 `:175` 的数字为本次实测（冷 21.7→11.5 s；热 5.79→6.92 s；`route_points` −20%；补域另 +1.9 s） | 三处数字一致；无其他文件仍写"3.0 s"或"6×" | 文档改动 `git checkout --`；`import-equivalence.ts` 同上 |
| 4 | **Y1** | 统一文案：`server.ts:1442`、`model-run-repository.ts:121` → "模型版本门禁 / model-version gate"；同步 `model-run-repository.test.ts:181` 与 API 测试断言。🔴 **不动** `rai-shadow-gate-v1` | `grep -rn "shadow validation gate\|shadow model 门禁"` 仅剩历史文档；测试绿 | `git checkout --` 相应文件 |
| 5 | **Y2/Y3** | 更新 `DATABASE_DESIGN.md:168`；删除或标注弃用 `scripts/split-application-service.mjs`（先确认 CI 无引用） | 文档不再声明已删机制；脚本删除后 `typecheck` + 全量测试绿 | `git checkout --`（脚本删除用 `git checkout -- scripts/…` 恢复） |

**R1(b) 另论**：若要让新排序键真正快起来，需要避免"PK 打头诱导走索引"。把 PK 列挪出首位会**破坏"PK 唯一 ⇒ 无 tie"**这一 hash 稳定性论证 ⇒ **不推荐**。建议先做 (a)（零风险），(b) 另行立项实验。

**破坏性声明**：本次修复**无数据库迁移、无破坏性契约变更**（三值 enum 刻意保留）。新交付物为未跟踪文件，`rm` 即回滚。

---

## 五、清理项

- `apps/api/test/worker.test.ts:1378` 单元素循环壳（Y5）。
- `deliverables/gstack/raw/investigation-rai-2026-09-04.md:21/114` 仍把"`recompute_validations` 影子 hash 对照"列为项目强项 —— 历史 raw 稿，建议保留不改。
- 未跟踪：`deliverables/RUST_REFACTOR_PHASE2_PLAN_2026-09-20.md`、`deliverables/SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md`（本报告为第三个）。

---

## 六、修复记录（2026-09-21，同日）

**九项全部处理完毕**（R1/R2/R3 + Y1/Y2/Y3/Y5 + 门禁 flaky；Y4 被 R2 顺带消解）。
每条都配了可复现证据或可突变到红的回归断言；未做的两项在文末列明并附理由。

### R1 —— 更正被推翻的性能叙述（3 处，纯文本）

| 文件 | 改动 |
|---|---|
| `apps/api/src/import-equivalence.ts:40-55` | 注释重写：把"measured 21.7 s vs 3.0 s"换成实测（**慢约 19%**，5,790 → 6,919 ms），并写明**这是正确性修复、不是提速**；给出根因（主键打头 ⇒ 走索引 ⇒ 索引扫描 + 回表 + 排序）与分表数据；保留"每个 hash 都变了、旧基线作废"的告警 |
| `docs/RUST_DATA_ENGINE.md`（B5 行 + 新增段） | B5 行的理由从"强制全表 temp B-tree"改为"**同值行的顺序未定义** ⇒ 两侧可能 hash 不同"；表后新增 ⚠️ 段记录原数字的来历（"21.7 s" 出自冷首跑）与判据（**性能声称必须同条件对照**） |
| `deliverables/SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md`（§实施结果表） | 追加 B5 行：计划理由"实测 21.7 s → 3.0 s（约 6×）"标注为**被推翻**，并记录实测与根因（**不改原计划正文**，保持审计轨迹） |

**未做的 (b)**：把 PK 列挪出 `ORDER BY` 首位只能靠破坏"主键唯一 ⇒ 无 tie"的论证来换速度，**不值得**，仍按报告建议另立实验。

### R2 —— B3 改为仅增量批次运行（3 处代码）

| 位置 | 改动 |
|---|---|
| `native-record-writer.ts:242-244`（`apply()`） | `await this.assertIdempotent(...)` → `if (this.incremental) await this.assertIdempotent(...)`，附一行说明 |
| `native-record-writer.ts:106-126`（注释） | 整段重写：逐条列出 replace 下三条断言为何全部失效（`tombstoned` 读取侧 / `inserted` 因 worker 重写每行而等于全行数 / 台账无 batch id 不写），并**明确撤回**"the change-ledger delta is the mode-independent assertion"这句错误表述 |
| `native-record-writer.ts:147` | `if (this.incremental && replay.inserted !== 0)` → `if (replay.inserted !== 0)` —— 消除一个**恒真条件**（假守卫），并把"仅增量调用"写进注释 |

**验收证据（探针，已清除）**：
```
PROBE runApply purpose=first  incremental=false      ← replace：只有一遍 apply
PROBE runApply purpose=first  incremental=true
PROBE runApply purpose=replay incremental=true       ← 增量：first + replay 两遍
PROBE runApply purpose=first  incremental=true
PROBE runApply purpose=replay incremental=true
PROBE runApply purpose=first  incremental=false
```
⇒ `--replace` 的 apply 写入量由 **2× 降到 1×**；增量批次的幂等断言**保留**。`native-worker.test.ts` 7/7 绿，探针计数归 0。

**副作用（正向）**：B4 现在总是比对**第一遍**写入后的落盘行，不再受重放影响 ⇒ 报告 §Y4 的"错误归因指向不了 replay"问题一并消失。

### 同步的文档

`docs/RUST_DATA_ENGINE.md` B3 行改为「**仅增量批次**…`--replace` 不跑」并新增 🔴 段说明理由；
方案文档 §实施结果表追加 B3 行（"每次导入都重放" → "仅增量批次重放"）。

### R3 —— B4 补「实际比对行数为 0」的守卫（1 处代码 + 1 个回归用例）

`native-record-writer.ts` 的 `assertSampleMatches()` 原来只统计 `divergences`：抽样到的行若**一条都不在候选库里**
（全被 tombstone，或候选库为空），循环体一次都不进 ⇒ `divergences === 0` ⇒ 断言**看起来通过了**，而
"写路径内容检查"对本次导入**实际没生效**。改法：新增 `sampled` / `compared` 两个计数器，在 `divergences`
判定**之前**插入守卫，比对数为 0 时写一条 issue：

```
code: "invariant.b4.no_rows_compared"   severity: "warning"
message: B4 compared 0 of <N> sampled canonical row(s): none of them is held by the
         candidate database ... The write-path content check is inactive for this import.
```

**为什么是 warning 而不是失败**：与 B2 同档——"没比对成功"不等于数据错，但必须留痕（`GET /v1/data-summary`
的 `issues` 是主要观察口，见 `NOTES-engineering.md`）。

**突变验证**：把守卫条件改成 `if (false)` ⇒ `native-worker.test.ts` **`not ok 8`**，断言消息精确
指向新用例（"a sample that compared zero rows must not look like a passed check"）；还原后 **8/8 绿**、
`if (false)` 计数归 0。⇒ 断言**有效**，不是恒绿。

### Y1 —— 模型版本门禁的三处文案统一（5 处）

| 位置 | 改动 |
|---|---|
| `apps/api/src/server.ts:1441` | 用户可见 409 文案：`该模型运行未通过 shadow model 门禁…` → `该模型运行未通过模型版本门禁，不能激活` |
| `packages/storage-sqlite/src/model-run-repository.ts:121` | 错误消息 → `Model run failed the model-version gate and cannot become active` |
| `packages/storage-sqlite/src/model-run-repository.ts:110` | 注释里的 "shadow 门禁" 改为 "production model-version gate" |
| `packages/storage-sqlite/test/model-run-repository.test.ts:158` | 用例名 → `persists a failed model-version gate and rejects activation without replacing incumbent` |
| `packages/storage-sqlite/test/model-run-repository.test.ts:181` | 断言 → `/model-version gate/` |

🔴 **刻意未改**：`model-run-repository.ts:140` 的 `const gateVersion = "rai-shadow-gate-v1";` —— 这是
**已写入历史行的持久化版本标识**，改名会让既有行的版本对不上。残留 grep 已清零；
`model-run-repository.test.ts` **3/3 绿**。

### Y2 —— 文档漂移（1 处）

`docs/DATABASE_DESIGN.md:168` 的 `recompute_validations` 描述改写为「**已废弃（2026-09-20）**…表**保留仅为
兼容历史迁移且恒为空**，写入路径的替代防线是运行时不变量 B1–B5，见 `docs/RUST_DATA_ENGINE.md`」。

### Y3 —— 删除孤儿生成器（1 个文件）

`scripts/split-application-service.mjs` 已 `rm`（`git status` 显示 `D`）。删前确认**零引用**：除记忆与本报告
外无任何 `package.json` / CI / 文档 / 代码引用它（按 `NOTES-engineering.md` 的「脚本跑绿 ≠ 门禁存在」判据反查）。

### Y5 —— 收缩单元素循环壳（1 处）

`apps/api/test/worker.test.ts` 原来在 `for (const validationMode of ["shadow", "off"])` 里只套**一个** `test(...)`，
整个 fixture 体缩进一级、用例跑两遍。改为直接 `test("recomputes and activates a training session that
becomes ambiguous (off)", …)`，并把三处随参数变化的断言改成固定值：

- 构造 `ImportWorker` 时不再传第 7 个参数 `validationMode`
- `args.includes("--shadow-validate")` → `assert.equal(…, false, "the removed shadow flag must never be passed")`
- `timing.validationMode` → `"not-run"`

`git diff --stat` = **4 insertions / 6 deletions**。该文件 **88 tests / 87 pass / 0 fail / 1 skip**（个数 89→88，
因为双份用例收缩为一份）。

### 🔴 门禁异常：5 个 flaky 用例 —— 根因定位 + 修复（含推翻我自己的初判）

修复后跑完整门禁，`typecheck` ✔，但 `npm test` 得 **736 / 727 pass / 5 fail / 4 skip**（审查阶段同一门禁为 736/733/0/3）。

| 失败的用例 | 所在文件 | 形态 |
|---|---|---|
| API exits 78 on pending migrations without changing the main database | `migration-startup.test.ts:11` | `null !== 78`，耗时 15.2 s ⇒ 子进程未按预期退出 |
| restore and deletion reject a committed import whose acknowledgement is still pending | `server-runtime.test.ts:21` | `Error: write EPIPE`，栈指向 `broker-ipc-client.cjs`（**WorkBuddy 沙箱 IPC**） |
| prediction training reports a missing active ability baseline as a conflict | `server-runtime.test.ts:215` | `mutation_conflict` ≠ `prediction_ability_baseline_unavailable` |
| dynamic-port startup reports readiness and workout overrides preserve service result | `server-runtime.test.ts:899` | `409 !== 404`（`另一项写操作正在执行：recompute`） |
| training-zone HTTP errors expose only typed client failures | `server-runtime.test.ts:1265` | `409 !== 400`（同上） |

**证明与本次修复无关（对照实验）**：

| 代码状态 | 结果 |
|---|---|
| **R2 临时还原**（行为 == 本次审查之前） | 单跑 `server-runtime.test.ts`：**同样这 4 个红**（`not ok 1/2/10/13`，11 pass） |
| **R2 生效**（当前工作区） | 全量 `npm test`：**同样 5 个红**（TAP 编号 153/263/264/272/275） |

⇒ 两种状态下**失败集合逐条相同** ⇒ **R2 零影响**。R1 只增加注释（`git diff -U0` 可验：`import-equivalence.ts` 本次新增行**全部是 `//` 注释**）。
⇒ 而同样的行为代码在审查阶段跑出 **0 fail**、现在跑出 **5 fail** ⇒ 结论是**非确定性**，由代码之外的变量决定。

#### 根因 —— 分三类，互不相关

**(1) 后 4 个（`recompute` 写锁）：启动期一次*空* drain 把全局写锁握了 2.5 s**

⚠️ 我上一版写的"新建空库判为数据缺失 ⇒ 启动期自动重算"**是猜测，已被实测推翻**。真实机制：

1. `server.ts:722` 只要 DB 在启动时可用就**无条件** `recomputeWorker.schedule()`。
2. `RecomputeWorker.drain()`（`recompute-worker.ts:62`）一进来就 `admission.acquire()` —— 即
   `TaskAdmissionScheduler.owner("recompute").acquire()` → `mutationCoordinator.acquire("recompute")`
   （`task-admission.ts:22`）⇒ **整个 drain 期间全局写锁的 `activeOperation` 就是 `"recompute"`**。
3. 接着 `runOneInWorkerThread()` 起的线程 bootstrap 要做 `tsx register()`
   （`recompute-worker-bootstrap.mjs`），**队列为空也要付这笔钱**。
4. `waitForApi`（`server-runtime.test.ts:121-134`）**只探 `/v1/health`**：它 ok 时端口已绑、可 drain 才刚起步。
   写请求进来后 `preHandler`（`server.ts:357`）的 `acquireWhenAvailable` **只等 2 000 ms** ⇒ 超时抛
   `MutationConflictError("recompute")` ⇒ `409 mutation_conflict` **取代了用例真正要断言的 404 / 400 / 业务 409**。

**实测（受控探针，已清除）** —— 空库（0 workout、0 排队 job）启动 API，每 30 ms 打 `/v1/runtime-status`：

```
PROBE t=+   72ms i=  0 status=true/true/{"active":"recompute","waiting":["prediction"]}
...
PROBE t=+ 2528ms i= 61 status=true/false/{"active":null,"waiting":[]}
PROBE lock-held window: active@+72ms .. idle@+2528ms => 2456ms
```

⇒ 一次**无事可做**的启动握锁 **2 456 ms**；窗口（2.5 s）> 租约（2.0 s）⇒ 必然 409。
这不是测试问题，是**产品缺陷**：每次 API 重启都会无事禁写约 2.5 s（`POST /restore`、`DELETE /database`、
`PATCH /v1/workouts/:id/override`、`PATCH /v1/training-zones/profile` 全被挡）。

**修复（根因，不是测试补丁）**：

| 文件 | 改动 |
|---|---|
| `packages/storage-sqlite/src/recompute-job-repository.ts:38-43` | 新增 `hasPending()`：`SELECT 1 FROM recompute_jobs WHERE status IN ('queued','running') LIMIT 1`（与 `server.ts:598-602` 既有查询同口径） |
| `apps/api/src/recompute-worker.ts:71-76` | `drain()` 在 `recoverInterruptedJobs()` **之前**插入 `if (!this.hasPendingJob()) return;` |
| `apps/api/src/recompute-worker.ts:131` | `withJobRepository` 泛型化以返回值（`<T>(action: (jobs) => T): T`） |

安全性论证：**每个入队点都在入队后紧跟 `schedule()`**（`server.ts:704` 训练区回填 / `:973` override /
`:1418` enqueueFullRecompute / `:1526` restore / `:440` commandQueue 回调）⇒ 跳过空 drain **不会丢任务**。
`recoverInterrupted()` 对空队列本就是纯 no-op（`recompute-job-repository.ts:116-119`）；而**陈旧 `running`
任务算 pending**，崩溃恢复路径因此不受影响。

**验收**：同一探针复测，`active` 自第一次采样即为 `null`，全程 **0 次**出现 `recompute`；
`server-runtime.test.ts` 从 **12/15 → 15/15 pass / 0 fail**。

**回归测试（新增 `apps/api/test/recompute-worker.test.ts`，3 用例）** —— 沿用 `worker.test.ts` 既有做法，
stub `runOneInWorkerThread` 计次（它是唯一的 spawn 点）：

| 状态 | 结果 |
|---|---|
| 原样 | **3/3 绿** |
| 突变 A：`if (!this.hasPendingJob()) return;` → `if (false) return;` | **`not ok 2`**（an idle drain never spawns a worker thread） |
| 突变 B：`hasPending()` 恒 `return false` | **`not ok 1` + `not ok 3`** |

🔴 **连带影响（已处理）**：新契约"空队列不 spawn"使 `apps/api/test/worker.test.ts:277`
"recompute worker wakeups while draining are not dropped" **变红**——该用例原来在**空库**上用 stub 制造
"drain 进行中"的窗口，现在 drain 根本走不到 stub。已给它播一个 `queued` 任务（同文件其余同类用例本来都播了），
语义不变 ⇒ **88 / 87 pass / 0 fail**。

**(2) `migration-startup.test.ts:11`：与写锁无关，是硬编码 15 s 预算**

`:28` 的 `setTimeout(() => child.kill("SIGKILL"), 15_000)` 对"子进程要加载整个 `tsx` 模块图"给的预算太紧；
失败耗时 **15.2 s** 正是这个计时器打的。被 SIGKILL 时 `exit` 的 `code` 为 `null` ⇒ 报出费解的 `null !== 78`。
**修复**：预算提到 **60 s**（与 `waitForApi` / `waitForBoundPort` 既有 60 s 窗口同口径），并把 `exit` 的
`signal` 一并捕获进断言消息 —— 再超时能一眼区分"被计时器杀了"与"退出码真的不对"。

⚠️ **未做且不建议做**：把 `waitForApi` 改成"等到 `!busy`"。同文件 `:362` 有
`assert.equal(runtimeStatus.busy, true)`，且 `:289` 用例启动时库里就有 `running` 的 recompute + prediction
任务 ⇒ 等 `!busy` 会等到**真实重算跑完**，反而制造新的超时。残留的 prediction 空闲 drain 只开一次库
（`prediction-worker.ts:170`，不 spawn 线程），持有时间远小于 2 000 ms 租约，不构成 409。

**(3) `write EPIPE`（沙箱相关，低置信 —— 诚实标注未复现）**

同文件 `stopApi` 的 `if (child.connected) child.send("rai:shutdown")` **没给 callback**：`connected` 可能在
**检查与发送之间**翻转，而 Node 在无 callback 时会把"发不出去"变成 child 上的 **`error` 事件**（无人监听
⇒ 未捕获异常），形态与观察到的 EPIPE 一致。已改为 `child.send("rai:shutdown", () => {})`——把失败路由进
callback，语义仍是 fire-and-forget，后面还有 SIGTERM/SIGKILL 兜底。
🟡 但原栈指向 `broker-ipc-client.cjs`（WorkBuddy 沙箱 IPC broker），**本次未复现**，故这条只算"顺手加固"，
**不作为已验证的根因**。

**web 侧的 2 个文件没被收集 —— 机制已查明，是资源饥饿而非竞态**：全量那次 vitest 的尾部是

```
Error: [vitest-pool]: Failed to start forks worker for test files apps/web/test/workout-segments-panel.test.tsx.
Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond
 Test Files  11 passed (11)   Tests  79 passed (79)   Errors  2 errors   Duration 259.86s
npm error Lifecycle script `test` failed
```

⇒ 不是"漏收集"，而是 **forks worker 起不来**（`import 74.10s` / `environment 281.34s`，机器已被 node:test
那 740 个用例（大量真实 API 子进程 + worker 线程）压满）。**这与 `NOTES-engineering.md:8` 记录的既有本机问题
同一条**（`apps/web` vitest"≥5 文件必 worker 超时"，疑 CPU 竞争，已加 `maxWorkers: 2` 治标、根因未证实）。
**与本轮改动无关**：单独运行 `npm run test -w @rai/web` 得 **13 文件 / 84 tests / 0 errors，EXIT=0**（与基线一致）。

**判定**：修复后本机门禁 **0 fail**（数字见文末「最终门禁」）。5 个 flaky 的根因已分别落到
**产品代码**（recompute 空 drain）、**测试预算**（15 s 计时器）、**沙箱 IPC**（EPIPE，未复现）三处，
不再是笼统的"非确定性"；且前两类各配了可突变到红的回归断言。

### ✅ 最终门禁（2026-09-21 复测）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | ✔（**每条改动后都复跑**） |
| `npm test`（node:test 侧） | **740 tests / 736 pass / 0 fail / 4 skip** ✔ |
| `npm test`（web vitest 侧，**单跑**） | **13 文件 / 84 tests / 0 errors**，`EXIT=0` ✔ |
| `npm run rust:verify` | **11 tests / 11 pass / 0 fail** ✔ |
| `npm run test:ios` | ✔「iOS 门禁通过（类型检查 + 纯逻辑回归）」 |

🔴 **两个必须一起说的前提**：

1. **合并脚本 `npm test` 仍 `EXIT=1`，但失败点不在 node 侧**：web vitest 的 2 个 forks worker 起不来
   （见上文）。这是本机既有的资源饥饿问题（`NOTES-engineering.md:8`），**必须单跑 web 才能拿到真实结论**。
2. **跨次比较 tests 总数没有意义**（并行收集本身不稳定，11 vs 13 文件就是证据）⇒ **只看 fail 数与单文件计数**。

### 完成度

| 项 | 状态 | 证据 |
|---|---|---|
| R1 B5 性能叙述更正 | ✅ | 3 处纯文本；受控探针（旧 5,790 ms → 新 6,919 ms） |
| R2 `--replace` 下 B3 失效 | ✅ | 3 处代码 + 探针（`replace` 写入量 2×→1×） |
| R3 B4 空比对守卫 | ✅ | 1 处代码 + 回归用例；突变 `if (false)` ⇒ `not ok 8` |
| Y1 门禁文案统一 | ✅ | 5 处；残留 grep 清零，`rai-shadow-gate-v1` 刻意保留 |
| Y2 文档漂移 | ✅ | `docs/DATABASE_DESIGN.md:168` |
| Y3 孤儿生成器 | ✅ | `scripts/split-application-service.mjs` 已删（`git status` 为 `D`） |
| Y4 B3/B4 错误归因边界 | ✅ 顺带消解 | R2 使 B4 总比对第一遍落盘行 |
| Y5 单元素循环壳 | ✅ | `worker.test.ts` 4 增 6 删；88 / 87 pass / 0 fail |
| 门禁 5 个 flaky | ✅ | 产品修复 + 预算修正 + 沙箱 IPC 加固；新增 `recompute-worker.test.ts`（3 用例，双向突变到红） |

**未做（明确不做，附理由）**：R1(b) 让 B5 排序键真正变快（会破坏"主键唯一 ⇒ 无 tie"的论证）；
把 `waitForApi` 改成"等 `!busy`"（会让 `:289` 用例等到真实重算跑完，反造新超时）。

**仍未提交**：39 个已跟踪改动（38 修改 + 1 删除）+ 4 个未跟踪文件（`recompute-worker.test.ts` 与 3 份交付物）；`HEAD` 仍为 `41c2490`。
