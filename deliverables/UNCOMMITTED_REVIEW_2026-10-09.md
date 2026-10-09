# 未提交改动审查（2026-10-09）

## 审查对象与方法

- **工作区**：`/Users/ta/running`，分支 `main`，起点 `6f5faac`（= 远程 HEAD）。
- **规模**：30 个已跟踪文件改动（+1930 / −322），14 个新增未跟踪文件；共 44 项。
  主体是 **HealthKit 记录同步 v2**（v30/v31 迁移 + 逐类型变更游标 + 类型作用域 UUID 删除）
  加上前两轮已做的 **P1 投递可达性修复**、**3.9 web 默认超时**、**3.10 后台软预算**。
- **方法**：结论一律落到 `文件:行号` 或命令输出。所有门禁**实跑**；新增门禁另做单点突变验证
  （改坏 → 期望变红 → 还原 → `shasum` 校验逐位一致）。
- **本审查对工作区做过的写操作**（透明起见全部列出，均已还原）：
  1. 还原了上一次突变运行遗留的**改坏源码** `apps/ios/RAI/SyncPhase.swift`（详见 §六.1）；
  2. 为验证两个新门禁非空转，各做一次单点突变（`HealthSyncArchive.swift`、`apple-health-parser.ts`），
     `shasum -a 256` 前后一致，工作区条目数回到 44。

## 门禁实跑

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | **EXIT=0** |
| `npm test`（node 侧） | **1443 tests / 1440 pass / 0 fail / 3 skipped** |
| `npm test`（web 侧） | **25 files / 184 tests passed** |
| `npm run build` | **EXIT=0**（本轮未撞 safe-delete 护栏） |
| `npm run test:ios` | **EXIT=0**（类型检查 89 文件 / 跳 3；capability **269 checks / 0 failed**；record wiring 21；store 101；export determinism 14） |
| `migration-policy.test.ts` | **8/8 pass**（含「每个迁移都有冻结值」+「冻结值仍匹配转译源」） |
| `npm run check:doc-refs` | EXIT=0（0 处引用 / 0 越界） |
| `npm run check:docs` | EXIT=0（27 文件 / 227 链接 / 0 问题） |
| `RAI_MUTATION_ONLY='[P1]'` | **13 条全 RED + `assertion_hit=True`**，还原后 GREEN |
| `RAI_MUTATION_ONLY='[P3]'` | **2 条全 RED + `assertion_hit=True`**，还原后 GREEN |
| `RAI_MUTATION_FOR=git`（全量） | **92 / 92, 0 failed**（同日实现阶段实跑；代码此后未变 ⇒ 对本工作区成立，见下注） |

> ⚠️ **上表是 2026-10-09 21:14 那一轮的时点快照**，不是最终态。两处已过期：
> ①`RAI_MUTATION_FOR=git` 的总数在本轮修完后**从 92 变成 95**（`HealthKitExport.swift` 进了输入面，见 §七）；
> ②`test:ios` 的 record wiring 从 21 变成 **23**（该门禁被重写为运行时计数，见 §八 序 3）。
> **最终态数字见 §八「收尾回归实跑」。**

三条 skipped 全是 **Windows-only** 用例（`rejects Windows path aliases…` /
`keeps a genuinely locked rollback…` / `cancelling prediction training terminates the Windows process tree`），
不是覆盖丢失。⚠️ 全量突变（`RAI_MUTATION_FOR=git`）**本次审查试图独立复跑时被会话边界杀掉了**
（见 §六.1），故只在本轮新跑了 `[P1]`/`[P3]` 子集。**但全量结论本身是有据的**：同日实现阶段的
`.workbuddy/memory/2026-10-09.md` §13 记录了一次完整实跑 —— **92 of 92 / 0 failed**，负向对照
`COMPILE-ERROR`，还原后 `exit=0 GREEN`；该次跑完后源码未再变动（本次审查只把被自己杀掉的突变遗留
还原回工作区态，见 §六.1）⇒ **对当前工作区仍然成立**。本报告 🟡1 里"实为 92 条"即以此为准。

> ⚠️ **skip 数不是稳定量**：上表那一轮是 3 条；同日 22:59 的一轮是 **4 条**，多出来的那条是
> `publication lock rejects PID reuse when the process identity differs`。它靠 `spawnSync("ps", ["-o","lstart=",…])`
> 探测进程身份，node 子进程被沙箱拒（`EPERM`）时按设计**fail-safe 跳过**（`apps/api/test/…`），
> 不是覆盖丢失；**看到 skip 数变化先查这一条**。22:59 那轮同时还出了 1 条**假红**（非本次改动所致），
> 完整定性见 §八「收尾回归实跑」。

---

## 一、结论摘要

| # | 级别 | 结论 | 证据 |
| --- | --- | --- | --- |
| D1 | 🔴 动作 | 本次含 **v30 / v31 两个迁移**，部署必须先迁移再重启，否则 API 以 `exit 78` 拒启 | `database.ts:1643-1644`；`v31-migration.test.ts:54-55` 实测 `pendingMigrations == [31]` + `refuse` 抛 `PendingMigrationsError` |
| 1 | 🟡 | ADR-004 自称 2026-10-09 实测的数字与本次最终态不符：capabilities 实为 **269**（写 256）、mutations 实为 **92 条**（写 90） | `ADR-004:362-363` vs `.workbuddy/runlogs/review-ios.log:996`、突变输出 `2 of 92` |
| 2 | 🟡 | `MIN_CHECKS = 255` 与实测 269 差 **14**，违反该文件自己写明的「地板 = 打印总数 − 1（零容忍）」 | `check-background-capabilities.py:1809-1812` |
| 3 | 🟡 | `check-healthkit-record-sync.py` 打印「21 checks」但实际 **22 条 assert**；两个新门禁都**没有计数地板** | 该文件 `:18-40`；`MIN_CHECKS` 零命中 |
| 4 | 🟡 | 两个新门禁**没有突变覆盖**（没有一条突变是为它们设计的）；断言有效性未纳入第三层 | `check-background-mutations.py` 对二者零引用（阳性对照：对其他门禁 7 处引用） |
| 5 | 🟡 | `anchoredRecords` 把 `next == nil` 当硬错误抛出，而同文件 workout 版本把 nil 兜成 `HKQueryAnchor(fromValue: 0)`；抛错**不被**授权/无数据分支接住 ⇒ 会长成整批记录同步永久失败 | `HealthKitExport.swift:928-930` vs `:1294`；`:886-895` 的 catch 只认授权/无数据 |
| 6 | 🟡 | `useRemote` 的 15s 默认超时一次性套到全部 40+ 调用点，未按端点实测 | `hooks.ts:22`；可疑端点 `/v1/workouts/:id/share-card`、`/v1/training-statistics/load?days=180` |
| 7 | 🟡 | v31 在缺失 generation 行时把 `row.id` 当 `content_hash` 写库（哨兵值冒充摘要） | `v31-migration.ts:75` |
| 8 | 🟡 | `project.pbxproj` 带进 CocoaPods 生成物抖动（空的 `inputPaths`/`outputPaths`），与功能无关 | `git diff apps/ios/RAI.xcodeproj/project.pbxproj` |
| — | ✅ | 迁移冻结闸门、原子性修复、契约可选新增、manifest fail-closed、摘要去重、游标同事务+回读、大文件离主线程、P1 修复三层判据 —— 共 12 项（§四） | — |

**没有任何 🔴 代码缺陷被判成立。** 唯一 🔴 是**部署动作**（D1）。

---

## 二、🔴 必修

### D1. 部署前必须执行 v30/v31 迁移（否则线上 API 起不来）

本次新增两个 schema 版本：

```
database.ts:1643-1644
  { version: 30, name: "healthkit_record_source_identity", up: migrateModelV30 },
  { version: 31, name: "healthkit_record_aliases_and_source_facts", up: migrateModelV31 }
```

仓库里 API/worker 以 `migrationPolicy:"refuse"` 打开主库，有 pending 即拒启。这一点由本次新增的
测试**实测钉住**：

```
v31-migration.test.ts:54  assert.deepEqual(RaiDatabase.pendingMigrations(path).map(m => m.version), [31]);
v31-migration.test.ts:55  await assert.rejects(RaiDatabase.open(path, { migrationPolicy: "refuse" }), PendingMigrationsError);
```

⇒ **部署动作**（不可省）：

```sh
sudo -u rai npm run data:migrate -- --database /var/lib/rai/var/rai.sqlite
# 期望输出 pending: []
```

`docs/HEALTHKIT_RECORD_SYNC_V2.md:39-45` 已写明这一步，与既有部署纪律一致；这里只是把它提到 🔴，
因为它在这个 changeset 里是**新增的前置条件**（此前部署不需要）。

⚠️ 回滚注意：**迁移是前向单向的**（`database.ts:1607-1611` 禁止改历史迁移的 `up`）。若部署后又回滚代码，
库将停在 v31 而代码不认识该版本；`v30` 还是**表重建**（`INSERT … SELECT *` + DROP + RENAME），
不是加列。回滚方案只能是"代码回到 HEAD + 接受库已是 v31"。

---

## 三、🟡 待决策（8 条，按建议优先级）

### 🟡1. ADR-004 里"2026-10-09 实测"的数字自己就是过期的

```
ADR-004:362  2026-10-09 实测：`check-background-capabilities.py` **256 checks / 0 failed**、
ADR-004:363  `check-background-mutations.py` **90 条**。这两处此前写的 220 / 76 是更早的快照，而那两行当时
             没有任何日期口径 ⇒ 照它读会以为"门禁条数没变"，把真实增量读成零。
```

这段是**本次改动为了修"无日期口径的旧数字"而新写的**，但它写下的数字在最终态是错的：

- capabilities 实跑 **269 checks / 0 failed**（`.workbuddy/runlogs/review-ios.log:996`），不是 256；
  同一份副本还留在 `check-background-capabilities.py:1809`（"本次实测打印 **256** 条"）。
- mutations 实为 **92 条**（`2 of 92` / `13 of 92` 两次运行的机器计数），不是 90。

**建议**：这两处改成不写具体条数（或写成"以当次运行的输出为准"）。理由不是"数字难看"，而是
**同一天、同一批改动里写下的"实测值"就已经不等于最终态**，那它就不具备它自称的"日期口径可信"性质。
若保留数字，必须写清"打印于哪一步之后"。修完记得反向 grep `256`, `90 条`, `220 / 76` 找全副本。

### 🟡2. `MIN_CHECKS = 255` 与实测 269 差 14，地板事实上失效

```
check-background-capabilities.py:1808-1812
# ⚠️ 本次实测打印 **256** 条 ⇒ 地板收到 **255**（零容忍）。
MIN_CHECKS = 255
```

该文件自己规定"地板 = 打印总数 − 1（零容忍），少一条就红"（同文件 `:1655-1664` 的注释）。
本次新增了 §14h-3 的 13 条判据（`:1520-1583`）却没有跟着抬地板 ⇒ **现在最多可以静默掉 14 条判据**。
这 13 条正是本次改动最关键的结构判据（rediscovery 队列、`sync_route_discovery`、`knownRunningWorkouts`
只按 UUID 定点取、`routeDiscoveryCursor` 的四处续传推进）。

**验收标准**：`MIN_CHECKS` 改为 **268**；判据 = 删掉 §14h-3 里任意一条 `check(...)` 必须变红。

### 🟡3. 新门禁的计数是硬编码文案，且没有地板

```
check-healthkit-record-sync.py:40  print("HealthKit record sync wiring: 21 checks passed")
```

实际 `assert` 行数为 **22**（`:18`-`:39`）。`check-health-sync-archive.py` 同理（18 条 assert，
只打印一句话，不带数字）。两者都**没有** `MIN_CHECKS` 这类地板，而 `check-background-capabilities.py`
有 —— 于是"改写脚本时静默少跑一条判据"在它们身上不可检测。capabilities 的注释把这条纪律写得很清楚
（`:1655-1664`），照搬即可。

### 🟡4. 两个新门禁没有突变覆盖（第三层缺失）

```
$ grep -nE "record sync wiring|21 checks|check-healthkit-record-sync|check-health-sync-archive|\
HealthSyncArchiveRegression|HealthKitRecordCursorRegression" apps/ios/tests/check-background-mutations.py
（无输出）
$ grep -cE "check-background-capabilities|check-export-determinism" apps/ios/tests/check-background-mutations.py
7        ← 阳性对照：套件确实引用别的门禁
```

它们的**执行**是有的（`SWIFT_GATE = bash apps/ios/tests/run-health-sync-tests.sh`，而该脚本
`:25-28` / `:70` / `:164` 会跑到这两个 python 门禁），但**没有任何一条突变是为它们的断言设计的** ——
也就是说"改坏了它们会红"这件事没有被任何常驻机制证明过。这正是 ADR-004 三层表里
「突变验证 = 上面两层的**断言有效性**本身」缺了一角。

我**临时**验证过（见开头"写操作"）：把 `HealthSyncArchive.swift:5` 的 `nonisolated enum HealthSyncArchive {`
改成 `enum HealthSyncArchive {` ⇒ 门禁 `EXIT=1` + `AssertionError: file helper inherits MainActor isolation`；
把 `apple-health-parser.ts` 的 `removedHealthKitRecords` 全改名 ⇒ 门禁 `EXIT=1` +
`AssertionError`（`check-healthkit-record-sync.py:38`）。**两者都非空转**，但这次验证不进仓库、下次不算数。

**建议**：给 `[P3]` 组再补 2–3 条突变，`target` 分别指向上述两个 token、`gate=SWIFT_GATE`。

### 🟡5. `next == nil` 的处置在同一文件里自相矛盾（潜在永久失败）

```
HealthKitExport.swift:913-932   （新的记录查询；nil 的硬错误在 :928-930）
    let query = HKAnchoredObjectQuery(type: type, predicate: nil, anchor: anchor, limit: 1000) {
        _, samples, deleted, next, error in
        if let error { box.resume(throwing: error); return }
        guard let next else {                                   // :928
            box.resume(throwing: HealthKitExportError.missingRecordAnchor); return   // :929
        }                                                       // :930
        box.resume(returning: (samples ?? [], deleted ?? [], next))
    }

HealthKitExport.swift:1294      （既有的 workout 查询，同一个 API）
        next: newAnchor ?? HKQueryAnchor(fromValue: 0)
```

同一个 `HKQueryAnchor` 参数，一条路径把 nil 当硬错误，另一条兜成"无锚点、下次全量重读"。
而且 `missingRecordAnchor` **不在** `writeGlobalRecords` 的容错分支里：

```
HealthKitExport.swift:886-895
    } catch {
        if isAuthorizationError(error) || isNoDataError(error) { … continue }
        if isDatabaseInaccessible(error) { throw HealthKitExportError.databaseLocked }
        throw error                      ← missingRecordAnchor 落到这里
    }
```

⇒ 若 HealthKit 真的会在"该类型零样本"时回 nil，后果是**整批记录同步永久失败**，用户看到的文案是
「健康记录查询未返回可恢复游标，请重试同步。」而重试必然同样失败 —— 这正是本次改动在别处
（P1 投递可达性）刚修掉的那一类"自动同步停在原地"。空的跑步指标类型（`runningPower` /
`runningStrideLength` / `runningVerticalOscillation` / `runningGroundContactTime` /
`appleSleepingWristTemperature`）在多数人身上都是空的，所以暴露面不小。

**我无法离线确证 Apple 的行为**（Apple 文档只说 anchor "represents a specific point in time"，
没写零结果时的取值；Apple 自己的示例 `myAnchor = newAnchor` 两种解释都成立）。
故不列为 🔴，但按"同文件另一条路径已经专门兜过 nil"推断，**我倾向这是缺陷**。

**判据（可执行的判定）**：真机或模拟器上对一个零样本类型跑一次导出，记录 `next == nil` 是否出现
（在 `anchoredRecords` 加一行 `NSLog`，或写一个最小 `HKAnchoredObjectQuery` 探针）。
出现 ⇒ 升级 🔴，改法二选一并补齐测试；不出现 ⇒ 删掉 workout 侧的 `?? HKQueryAnchor(fromValue: 0)`
（否则留下一个误导性的先例），或在 `missingRecordAnchor` 处写清"为何 nil 不可达"。

### 🟡6. web 的 15 秒默认超时是"参数"，但它的作用面没有实测

```
hooks.ts:22   const DEFAULT_REMOTE_TIMEOUT_MS = 15_000;
hooks.ts:29   timeoutMs: number | null = DEFAULT_REMOTE_TIMEOUT_MS,
```

改动本身是对的（此前 `null` = 无界等待，页面可永久停在 loading），注释也自觉写了
"**这是参数，不是验收标准**"。但 40+ 个 `useRemote` 调用点里，本次没有对任何一个做时限实测。
按注释自己的标准，可疑的是服务端要干活而非只读表的端点：

- `ShareCardPanel.tsx:222` → `/v1/workouts/:id/share-card`（服务端渲染 PNG + 折线）
- `StatisticsPage.tsx:197` → `/v1/training-statistics/load?days=180`
- `PredictionsPage.tsx:174` → `/v1/predictions`

**验收标准**：对上述三个端点各取 20 次 p95；p95 < 15s 则保留默认，否则该调用点显式传 `timeoutMs`。
（`DataModelPage.tsx:125-153` 的导入/导出走自己的 `XMLHttpRequest.timeout=0`，不受影响，已确认。）

### 🟡7. `v31-migration.ts:75` 把 `row.id` 当 `content_hash`

```
v31-migration.ts:74-75
    fact.run(owner.type, owner.uuid, JSON.stringify(record), row.source_category, row.raw_attributes_json,
      row.content_hash ?? row.id);
```

`content_hash` 列在运行期是被当作摘要用的（`saveHealthKitRecordFact` 存真摘要，
`removeHealthKitRecords` 把它喂给 `observeImportEntity`）。迁移在 `import_entity_generations` 缺行时
**退化成把主键 id 写进这一列**。当前无实害（该路径随后无条件写一条 `updated` 变更，激活重算），
但这是"哨兵值冒充摘要"的形状：任何将来"比对 `content_hash` 是否相等"的逻辑都会把它当摘要。
**建议**：写 `NULL` 并在消费侧显式判空，或加注释钉死该列允许哨兵值。

### 🟡8. `project.pbxproj` 带进 CocoaPods 生成物抖动

```
+			inputPaths = (
+			);
...
+			outputPaths = (
+			);
```

加在 `[CP] Copy Pods Resources` 脚本阶段上，与本次功能零关系（`pod install` 的产物）。
不是缺陷，但它是 44 项改动里唯一一项"读的人会问为什么"的内容。**建议**：提交时在消息里说明，
或单独剔除（`git add -p`）。

---

## 四、✅ 通过项（做对了的地方）

1. **迁移冻结闸门真的有效**：新增 v30/v31 后 `migration-policy.test.ts` 8/8 通过，含
   「every migration has a frozen checksum」与「frozen checksums still match the transpiled source」。
   即 `FROZEN_MIGRATION_CHECKSUMS[30/31]` 不是抄来的数字。
2. **v30 的表重建没有列序陷阱**：新表 `(entity_kind, source_identifier, batch_id, deleted_at)`
   （`v30-migration.ts:7-13`）与原表（`database.ts:1374-1380`）**列序完全一致**，`SELECT *` 拷贝安全；
   重建的正当理由（CHECK 从 `= 'workout'` 放宽到 `IN ('workout','record')`）也成立。
3. **原子性修复正确**：`database.ts:3085` 把 `removeWorkoutsBySyncIdentifiers` 收尾的 `flush()` 改成
   `if (!this.atomicImport) this.flush()` —— 原先它会在 atomicImport 中途 COMMIT，破坏整批原子性。
   三个新写入函数（`markHealthKitRecordDeletions` / `removeHealthKitRecords` /
   `removeWorkoutsBySyncIdentifiers`）**唯一调用点是 parser**，且顺序是
   `mark → 扫描 → remove → commitAtomicImport`（`apple-health-parser.ts:298, 654, 656`），
   与 `removeHealthKitRecords` 内部的重算变更同批提交；回滚有专门用例
   （`healthkit-record-sync.test.ts:293-307`：强制 DELETE 触发器 ⇒ 记录/映射/别名/变更全部回滚）。
4. **契约新增是可选、且能力缺失时"停"而不是"忽略"**：`HandshakeResponse.healthKitRecordSyncVersion?`
   （`api-contracts/src/index.ts:162-163`）为可选；客户端在**新导出**与**已保存 v2 批次恢复**两处都
   `guard >= 2 else throw`（`HealthKitSync.swift:853-859` 与 `:1106-1108`），并有结构判据钉住两处都在
   （`check-healthkit-record-sync.py:31-33`）。方向正确：宁可不同步，也不静默丢掉删除语义。
5. **v2 manifest 解析 fail-closed**：未知版本 / 坏 v2 / `sourceScope ≠ "healthkit"` / 缺合法 UUID
   一律抛错（`sync-manifest.ts:24, 28-37`），且 `resolvePreserveAbsent` 对 v2 恒为 `preserveAbsent: true`
   （`import-sources.ts:204`，有用例断言 `reason === "manifest-healthkit"`）。
   ⚠️ 顺带记一条**已知且刻意**的两层差异：同样一个坏 v2 manifest，服务端 `readSyncManifestScope`
   是"降级为 manifest-unreadable"，parser 的 `readHealthSyncManifest` 是"抛错" ⇒ 最终表现为**导入失败**
   而不是"保守导入"。这是 `sync-manifest.ts:15-16` 注释里写明的意图（"Reject unsupported protocols
   rather than acknowledge an ignored deletion"），且只影响客户端从不产出的输入，**接受**。
6. **删除-only 批次不再被误判/误去重**：摘要把 `deletedRecords` 规范化（按 type+小写 uuid 去重排序）
   后并入（`import-sources.ts:269-283`），用例断言 `digest([one]) != digest([])`（删除-only ≠ 空同步）；
   并加了 `deletedRecords: records.deleted` 到 manifest、`deletionCount` 纳入"不可读空导出"判据
   （`HealthKitSync.swift:1473-1474`）。这两处是同一个 bug 的两半（一个在服务端去重、一个在客户端提示），**成对修**了。
7. **记录游标与水位、任务删除同一事务 + COMMIT 前回读**：`SyncTaskStore.swift:388-431`
   （`BEGIN IMMEDIATE` → upsert → `readBackMatches` → `writeRecordCursors` + `loadRecordCursors == 输入`
   → `DELETE FROM sync_tasks` + `changes()==1` → `COMMIT`），失败 `defer` 里 ROLLBACK。
   回归用 `CREATE TRIGGER … RAISE(ABORT)` 造真失败，断言"整段回滚、旧游标保留、待同步批次还在"
   （`SyncStateCommitRegression.swift:261-272`）。
8. **大文件的执行边界有真回归**：`HealthSyncArchive.swift` 全程 `runDetached`（2 处，`:28 / :41`），
   分块 `read(upToCount:)` + `autoreleasepool` 逐块释放，原子替换（`replaceItemAt`）而**不先删旧档**
   （`:97-102`），取消后的产物由 `onCancelledResult` 回收且只回收"本轮新建"（`isNewFile`）。
   回归**不用"文件够大"这种计时猜测**判离主线程，而是用 `ChunkGate` 在 worker 里阻塞回调、
   同时在 MainActor 上断言自己可被调度（`HealthSyncArchiveRegression.swift:44-74`）—— 这条判据的
   构造方式值得保留。
9. **P1 修复的三条判据是纯函数 + 有接线 + 有突变**：`Decision.recordsTheDelivery`（"要不要记"）
   与 `decide`（"现在跑不跑"）分离、`deferToBackgroundLater`、`SyncFollowUp.handoff`
   （`maxForegroundRounds = 1` 硬上限防前台自旋）、`hasUncoveredGeneration` 与 `needsAnotherRound`
   刻意分开。实跑 `[P1]` **13/13 RED + `assertion_hit=True`**，负向对照正确分类为 `COMPILE-ERROR`，
   还原后 GREEN。
10. **3.10 的软预算接在"零代价"的那一段上**：只接 `waitForJob` 轮询（放弃走 `suspendForLifecycle()`
    落回可续接阶段），不接导出/上传（中断要从头再来），且只在后台生效（`guard isBackground`）。
    `[P3]` 两条突变（前台也让出 / 退回只剩测试）实跑 RED + `assertion_hit=True`。
11. **六个 `sync(...)` 调用点全部是用户主动触发**（`RootView.swift:108` 按钮、`SyncHealthIntent.swift:17`
    Siri、`TechSyncStatus.swift:20/111`、`TechViews.swift:2300`、`AppWebView.swift:288` 的 `syncHealth` 消息），
    所以 `performSync(manual: true)` 不会变成"每次前台同步都全量重读历史"，与
    `docs/HEALTHKIT_RECORD_SYNC_V2.md:28` 的"手动同步立即补读历史"一致。
12. **新增门禁不是孤儿**：`check-health-sync-archive.py` / `check-healthkit-record-sync.py` 由
    `run-health-sync-tests.sh:28 / :164` 调用，而该脚本由 `run-model-tests.sh:67` 调用，
    即 `npm run test:ios`（AGENTS.md 规定 pre-commit 在 `apps/ios/` 有暂存时运行）。
13. **契约取值域类错误（§3.1）本次零新增**：`git diff -U0 | grep '^+'` 里没有任何新增的
    `status/state/kind == "字面量"` 比较。

---

## 五、修复顺序 / 验收标准 / 回滚

| 序 | 动作 | 验收标准 | 回滚 |
| --- | --- | --- | --- |
| 0 | **部署时**先跑 `data:migrate`，确认 `pending: []` 再重启 API | 迁移输出无 pending；API 日志无 `exit 78`；`/v1/handshake` 出现 `healthKitRecordSyncVersion: 2` | 无法"迁回去"（前向单向）；只能接受库为 v31 |
| 1 | 修 🟡1 的 ADR 数字（或去掉具体条数）+ 反向 grep `256` / `90 条` / `220 / 76` | `grep -rn "256 checks\|90 条\|220 / 76" docs/` 只余必要的时点标注 | `git checkout -- docs/adr/ADR-004-*.md` |
| 2 | `MIN_CHECKS` 255 → 268 | 删掉 §14h-3 任一条 `check(...)` ⇒ 门禁非 0 退出 | 改回 255 |
| 3 | 给两个新 python 门禁补计数地板 / 让打印数字来自计数 | 删掉任一 `assert` ⇒ 门禁非 0 退出 | 还原脚本 |
| 4 | 补 2–3 条针对新门禁的突变（`[P3]` 组，`gate=SWIFT_GATE`） | `RAI_MUTATION_ONLY='[P3]'` 全 RED 且 `assertion_hit=True` | 删除新增突变块 |
| 5 | 用真机/模拟器探针判定 🟡5 | 记录 `next == nil` 是否出现；据此对齐两条路径或写清不可达理由 | 仅加日志，随探针删除 |
| 6 | 三个可疑读端点取 p95 决定是否显式 `timeoutMs` | p95 < 15s 或该调用点显式传值 | 还原 `hooks.ts` 默认值 |
| 7 | 🟡7 / 🟡8 视口味处理（可留到下一次相关改动） | — | — |

> ⚠️ **本表是"计划"。实际执行结果（每项改了什么、验收输出、哪项判废、哪项无法本机判定）见 §八。**

**整体回滚**：`git checkout -- <30 个已跟踪文件>` **并删除 14 个新增未跟踪文件**
（`git clean -n` 先看清单再执行；其中 `packages/storage-sqlite/src/v30-migration.ts` / `v31-migration.ts`
若已部署过则**不能删**——库已是 v31，删掉定义会让主库打不开）。
**无破坏性契约变更**（`HandshakeResponse` 只加可选字段）。本机 `var/rai.sqlite`
**未被本次任何操作改动**（mtime 仍是 2026-10-08 00:35，`-wal` 0 字节）。

---

## 六、清理项 / 环境

1. **⚠️ 上一轮突变运行留下的污染（已由我修好，务必知情）**：
   本机 `var/mutation-backup/IN-PROGRESS` 标记仍在，且 `apps/ios/RAI/SyncPhase.swift` 里多了一行
   `case exporting`（`git diff` 显示 1 处新增）。这是后台突变脚本被 **SIGKILL**（会话边界把后台进程杀掉，
   `finally` 来不及跑）留下的。我按脚本自己的设计从 `var/mutation-backup/` 还原：
   20 个备份文件里**只有** `SyncPhase.swift` 与工作区不一致，`cp` 还原后 `git diff` 该文件为空，
   随后删掉 `IN-PROGRESS`。工作区条目数回到 44（= 30 个已跟踪改动 + 14 个新增源码，**不含本报告**），
   与审查开始时一致；连同本报告共 45 条未跟踪/改动。
   ⇒ 这验证了脚本 README 里那段"被 SIGTERM/SIGKILL 打断会留下改坏的源码"不是假想，
   **`IN-PROGRESS` 标记就是判据**（不是"目录空不空"）。
   ⚠️ 另注：**把突变脚本放后台跑有被会话边界杀掉的风险**，验收请前台跑或分段跑
   （`RAI_MUTATION_ONLY`，但产物带 `partial: true`，不是验收形态）。
2. `var/mutation-backup/` 正常结束后会留备份文件（`finish()` 只还原 + 清标记），**这是预期**。
   ⚠️ 别把条数写死：**条数 == `SOURCES` 的条目数**——审查开始时是 20，本轮 🟡4 往 `SOURCES` 里加了
   `HealthSyncArchive.swift` + `apple-health-parser.ts` ⇒ 收尾态是 **22**（`find var/mutation-backup -type f | wc -l`）。
   判据是 `IN-PROGRESS` **不存在**（不是"目录里有没有文件"）。
   ⚠️ 一个已知的无害错位：`var/mutation-backup/HealthKitExport.swift` 是 17:15 那次的快照（早于 🟡5 注释），
   但**没有 `IN-PROGRESS` ⇒ 任何 restore 路径都不会碰它**，所以不会把注释"还原掉"。
3. 本次运行产生的日志都在 `.workbuddy/runlogs/`：`review-typecheck.log`、`review-npmtest.log`、
   `review-build.log`、`review-ios.log`、`review-mut-p1.log`、`review-mut-p3.log`、
   `review-docrefs.log`、`review-doclinks.log`，以及被杀掉的那次 `review-mutations.log`。
4. `npm run build` 已把 `apps/web/dist` 重建（gitignored）；`var/` 侧车未新增。

---

## 七、方法学备注（这次踩到的坑，记下来）

- 🔴 **BSD grep 的 `\|` 会静默返回空** —— 我这次实际踩到：用
  `grep -n "unboundDeliveriesAreIgnored\|aDelivery…" <file>` 得到**空 + exit 1**，
  于是差点把"ADR 点名的四个回归用例不存在"写成结论；换 `grep -E` 后它们都在
  （`BackgroundSyncPolicyRegression.swift:67-69, 87, 97, 142, 168, 550`）。
  **凡是要拿"空结果"当结论的 grep，一律 `-E`，并配一个阳性对照。**
- 🔴 **后台长任务会被会话边界杀掉**：本次全量突变（`RAI_MUTATION_FOR=git`）就是这样死的，
  留下污染。跑突变/全量门禁要么前台，要么分批。
- ✅ **"IN-PROGRESS 标记"确实是可用的判据**：靠它 + 逐文件 `cmp` 定位到唯一被改坏的文件，
  而不是靠"退出码"或"目录里有没有文件"。
- ✅ **还原靠备份而不是 `git checkout --`**：`SyncPhase.swift` 恰好在 HEAD 上（可 checkout），
  但 `HealthSyncArchive.swift` 是**未跟踪新文件**，checkout 救不了它 —— 所以 `cp` + `shasum` 校验
  是唯一可靠做法。
- ✅ **报告行号做了两道校验**：①用脚本把全文 31 个 `文件:行号` 引用解析成真实路径并查越界 —— 无越界、无倒序；
  ②对 load-bearing 的引用逐条回源码核读。本轮共修正 8 处行号（`HealthKitSync.swift:853-859 / :1106-1108`、
  `:1473-1474`、`api-contracts/src/index.ts:162-163`、`database.ts:1643-1644`、
  `SyncStateCommitRegression.swift:261-272`；🟡5 的 `HealthKitExport.swift:913-932`（guard 在 `:928-930`）
  与 catch 块 `:886-895`）。**教训同纪律 16：越界检查全绿 ≠ 引用没错**，机械校验只能兜住"位置"，语义仍须回源码。
- 🔴 **`check:doc-refs` 只认 `git ls-files`** ⇒ 本报告里指向**本轮新增、尚未入库**文件的引用，提交前**必然**报
  `❓ 无法解析路径`。这不是"引用写错了"，而是目标还没进索引；反过来说，
  **拿它的报错当结论会把"目标未入库"误判成"引用失效"**。核这类引用只能改直读磁盘（把 `git ls-files`
  的结果与 `--others --exclude-standard` 合起来解析）：判定式是 **`❓` 的条数 == 目标未入库的条数、且越界 0**，
  本轮两者逐处对上 ⇒ 全部 18 处 `❓` 都是同一类（目标未入库），**没有一处是真引用错误**。
  ⚠️ 这里刻意**不写总数**：报告引用总数会随我改报告而变（加一句带 `文件:行号` 的话就 +1），写死必然过期。
  另一处坑：本仓库有**两个 `database.ts`**（`packages/storage-sqlite/src/` 与 `packages/health-export-parser/src/`），
  脚本内部有 `AMBIGUOUS` 表消歧，自己写解析器时若漏抄这张表，会凭空造出 4 处"越界"假阳性。
- 🔴 **插进 12 行注释，把同文件 ≥916 的行号整体顶了 +12** ⇒ 报告里指向 `HealthKitExport.swift` 的两处引用
  立刻漂移（`913-920 → 913-932`、`1282 → 1294`）。**区间引用的起点是否跟着变，取决于插入点是否早于起点** ——
  我第一遍正是把起点也当成"整体后移"，写成 `925-932`（错），回读源码才发现 `:913` 仍是 `let query = …`。
  ⇒ 教训扩充纪律 16：**行号漂移是"分段函数"**，不能对整条区间一律加同一个偏移量。
- 🔴 **全量突变总数从 92 变成 95**（`HealthKitExport.swift` 进了 `RAI_MUTATION_FOR=git` 的输入面）。
  ⇒ 本轮之后**不得再引用"92/92 全绿"**，正确总量是 **95**。这正是 🟡1 那一类"写死的数字"，只不过受害者换成了我自己。
- ⚠️ **我自己的报告曾把 `check:docs` 弄红**：报告落在 `deliverables/` 而没人从 `README.md` 链到它 ⇒
  `deliverables/UNCOMMITTED_REVIEW_2026-10-09.md: not reachable from README.md`、`EXIT=1`；
  而 `check:docs` **在 `.githooks/pre-commit` 里**（会挡提交）。修法是给 `deliverables/README.md` 加一节
  「当轮审查（未提交改动）」链到本报告。**这是本轮唯一一处由我引入、且会挡别人提交的缺陷**，记在这里。
- 🟡 **`check-doc-line-refs.mjs` 的 `AMBIGUOUS` 表漏了一个真的同名文件**（本轮实测踩到）：
  仓里有**两份** `recompute-job-repository.ts` —— `packages/application/src/`（**7 行**，只是个
  `export … from "@rai/storage-sqlite"` 兼容再导出）与 `packages/storage-sqlite/src/`（464 行，真实现）。
  脚本消歧表（`scripts/check-doc-line-refs.mjs:63-69`）只列了 5 个名字，**不含这一个** ⇒ 后缀匹配到 2 个候选时
  按排序取前者，于是任何 `recompute-job-repository.ts:<行号>` 引用都被判 **`🚨 行号越界`**（指向那个 7 行文件）。
  我自己的报告就吃了一次假警报。两种收口都可，**但本轮不改**（属工具层，需独立提交，且改它要连 `AMBIGUOUS`
  注释一起改）：
  ① 给消歧表加 `"recompute-job-repository.ts": "packages/storage-sqlite/src/recompute-job-repository.ts"`；
  ② 引用一律写全路径（本轮采用的就是这一种 —— 见 §八「收尾回归实跑」）。
  ⇒ 教训与纪律 16 同族：**"越界/无法解析"要先问"它解析到了哪一份"**，别直接当成引用写错。

---

## 八、本轮修复执行记录（2026-10-09 收尾）

按 §五 的顺序**实际执行**。逐项：改了什么 / 验收证据 / 回滚。状态以**实测**为准，不以"我改过了"为准。

| 序 | 状态 | 改动 | 验收证据 | 回滚 |
| --- | --- | --- | --- | --- |
| 0 | ⏸ **未执行** | 部署 + `data:migrate` | 未做（见下「为什么 0 没执行」） | — |
| 1 | ✅ 完成 | `docs/adr/ADR-004-healthkit-sync-invariants.md`：删掉"2026-10-09 实测：capabilities **256** / mutations **90**"（实为 269 / 92+3），改为"本文件因此不写具体条数" | `check:doc-refs` EXIT=0；`check:docs` EXIT=0（28 files / 229 links / 0 problems）；反向 grep `docs/` 无副本 | `git checkout -- docs/adr/ADR-004-healthkit-sync-invariants.md` |
| 2 | ✅ 完成 | `check-background-capabilities.py`：`MIN_CHECKS` 255 → **268**（本轮最终态实测打印 269），并重写上方注释（旧注释写"实测 256 ⇒ 地板 255"，与最终态差 14） | 删掉 §14h-3 一条 `check(...)` ⇒ `FAIL: only 267 judgements ran, floor is 268 — judgements were silently dropped…` + `EXIT=1`；还原后 `shasum` 逐位一致（`b581362685b25464ae66a5452e1b4a96c1961b74bd9baa8485be3fa26d73d2e4`） | 改回 255 |
| 3 | ✅ 完成 | 两个新 python 门禁重写为**运行时计数 + 地板**：`check-healthkit-record-sync.py`（`MIN_CHECKS=22`，印制 23）与 `check-health-sync-archive.py`（`MIN_CHECKS=18`，印制 19）；并把原先会抛 traceback 的 `str.index` 顺序判据换成 `find`/`ordered` | 各删一条判据 ⇒ `only 21 judgements ran, floor is 22` / `only 17 judgements ran, floor is 18` + `EXIT=1`；还原后逐字节一致。地板 = 印制数 − 1（`check()` 实参先求值） | 两文件均为未跟踪新文件 ⇒ 删除即回滚 |
| 4 | ✅ 完成 | `check-background-mutations.py` 新增 `[P4]` 三条突变；`HEALTH_ARCHIVE` / `HEALTH_PARSER` 两个常量登记进 `SOURCES` | `RAI_MUTATION_ONLY='[P4]'` ⇒ `3 of 95 mutations, 0 failed`；三条均 `verdict=RED` + `assertion_hit=True`；负向对照 `verdict=COMPILE-ERROR`；`restored: exit=0 GREEN` | 删掉三条突变块与两个常量 |
| 5 | ⚠️ **本机无法判定** | 把未决前提写进代码注释 `HealthKitExport.swift:916-927`（guard 在 `:928-930`），并写进 `docs/IOS_NATIVE_SYNC_PROTOCOL.md` 的「仍需真机验收的边界」 | 两处文本已落盘；**没有**任何"nil 可达/不可达"的实测结论（见下） | 删掉该注释块与 doc 那一行 |
| 6 | ✅ 完成 | `apps/web/src/hooks.ts`：**默认值 `DEFAULT_REMOTE_TIMEOUT_MS = 15_000` 不动**，只把 p95 实测结论回填到注释 | p95 实测见下表；本机 `var/` 逐行比对 VAR-UNCHANGED，主库 mtime 未变 | `git checkout -- apps/web/src/hooks.ts` |
| 7 | ✅ 完成 | 🟡7：`packages/storage-sqlite/src/v31-migration.ts` **只加注释、不改逻辑**；🟡8：删掉 `project.pbxproj` 的 CocoaPods 生成噪声 4 行 | 🟡7：`transpiledChecksumFor(31) === FROZEN_MIGRATION_CHECKSUMS[31]` ⇒ `MATCH: true`（注释不进校验和）；🟡8：`git diff -- project.pbxproj` 为空 | 分别见 §三·🟡7 / 🟡8 |

### 为什么 0 没执行

部署是**生产变更**，且 `lighthouse-ops` MCP 在某个会话里"配置存在 ≠ 本会话可用"（判据是它有没有进本会话工具索引，
不是 `~/.mcp.json` 的内容）。本轮没有对小唐确认过的窗口做线上改动，也没重启 API。
⇒ **D1 的风险原样保留**：线上库若仍低于 v30，重新部署会因 `migrationPolicy:"refuse"` 起不来。
本轮的副产物给了它**真实证据**：用生产库副本演练 v29→v31 迁移（271 workouts / 204284 route_points / 83380 health_records，
计数前后不变、`pending: []`、`foreignKeyCheck: ok`）；线上 `/v1/handshake` 至今**没有**
`healthKitRecordSyncVersion`，印证线上仍是改动前版本。

### 为什么 5 本机不能判定

- `HKAnchoredObjectQuery` 的 completion 是否会在"本次没返回任何对象"时给 `newAnchor = nil`，
  **只有 Apple 文档一句话**可读（"an anchor object corresponding to the last object returned by this query"），
  它读得出 nil 可达，但**读不出必然可达**。
- 唯一的判定手段是**在真机上**挑一个零样本记录类型跑一次导出；HealthKit 读授权必须走 UI 弹窗批准
  （`simctl` 不支持 health），所以模拟器 + headless 都做不了。
- 也**不能反向**用"门禁全绿"当证据：`check-healthkit-record-sync.py:54` 钉的是**这个决定**
  （此处必须存在抛错分支），不是决定的前提。⇒ 本轮把结论落成"未决 + 判定手段"，
  **而不是**改成兜 nil（兜零会让游标归零 ⇒ 每轮全量重读，且违反"绝不把读不到当空数据推进 anchor"）。

### p95 实测（🟡6 的依据）

只读 GET，本机对 `/tmp` 副本库起 API（n=30），线上 `https://tpandmr.xyz`（n=10，匿名）：

| 端点 | 本机 p50 | 本机 p95 | 线上 p50 | 线上 p95 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `/v1/training-statistics/load?days=180` | ~6ms | **15ms** | 91ms | 1700ms | 远在 15s 预算内 |
| `/v1/workouts/:id/share-card` | — | **294ms** | 被 token 门控（匿名测不到） | — | 远在预算内 |
| `/v1/predictions?mode=current_prepared` | — | **2275ms** | — | **5512ms** | 仍在预算内，但**最紧**（线上余量约 2.7×） |

⇒ 报告点名的两个端点**都不是瓶颈**，而**没被点名**的 `predictions` 才是（原报告的怀疑方向偏了，这里订正）。
⇒ 决定：默认值不动，把口径写进注释；下一步若要收紧，应先在**真机 + 线上**对 `predictions` 取分布，而不是拍一个绝对值。

### 🟡4 前三条突变为何作废（留档，别再加回来）

两个 python 门禁跑在 `SWIFT_GATE` 的**末尾**，而该脚本是 `set -e` ⇒ 突变必须满足
「Swift 部分照样绿、只有 python 门禁能抓」，否则 Swift 回归先红、脚本走不到 python 门禁
（`assertion_hit=False` ⇒ harness 正确判为 BAD）。实测排除的三个：

1. 拿掉 `HealthSyncArchive` 的 `nonisolated` ⇒ Swift 归档回归先红（`Fatal error: … file work blocked MainActor until the worker timed out`）；
2. `read(upToCount: chunkSize)` 换成常量 ⇒ Swift 回归先红（`ZIP was not processed in complete chunks`）；
3. parser 里 `store.removeHealthKitRecords(` 改名 ⇒ **STILL-GREEN**：因为 `"store.removeHealthKitRecords"` 是
   `"...Later("` 的**子串**，判据照样命中 —— 这是**我的设计错误**（把"改名"当成了"改行为"）。

### 收尾回归实跑（最终态，2026-10-09 23:11）

| 门禁 | 结果 | 日志 |
| --- | --- | --- |
| `npm run typecheck` | **EXIT=0** | `r-typecheck.log` |
| `npm test`（node 侧） | **1443 tests / 1440 pass / 0 fail / 3 skipped** | `r-npmtest2.log:9118-9125` |
| `npm test`（web 侧） | **25 files / 184 tests passed** | `r-npmtest2.log:9164-9167` |
| `npm run test:ios` | **EXIT=0**（capability **269 checks / 0 failed**；record wiring **23**；archive **19**；export determinism **14**） | `r-testios.log` |
| `npm run check:docs` | **EXIT=0**（28 files / 229 links / 0 problems） | `r-checkdocs.log` |
| `npm run check:doc-refs` | **EXIT=0**。⚠️ 默认集不含任何文档 = **空转**，故另对 4 份改动文档显式跑 ⇒ 0 problem；报告本体经磁盘解析复核 = **越界 0**，全部 `❓` 都是"目标未入库"一类（条数与未入库目标数相等） | `r-docrefs.log`、`r-docrefs-touched.log` |
| `check-blob-size` / `check-package-boundaries` / `check-acceptance-matrix` | 均为 **EXIT=0** | `r-blob.log`、`r-pkgbound.log`、`r-accept.log` |
| `RAI_MUTATION_ONLY='[P4]'` | **3 of 95 mutations / 0 failed**；三条 `verdict=RED` + `assertion_hit=True`；负向对照 `COMPILE-ERROR`；还原后 `exit=0 GREEN` | `fix-mut-p4b.log` |

（日志均在 `.workbuddy/runlogs/`。）

#### 一次假红的定性（22:59 那一轮，不是本次改动引起）

中间有一轮 `npm test` 报 **1 fail / 4 skipped**，失败用例是
`runtime status includes persisted prediction work and restore recovers recompute jobs`
（`apps/api/test/server-runtime.test.ts:386`，断言在 `:499-500`）。三条判据说明它与本次改动无关：

| 判据 | 证据 |
| --- | --- |
| **同一份代码、两轮不同结果** | 代码未改的前提下，21:14 那轮是 `ok 416`（`review-npmtest.log:2625-2626`），22:59 那轮是 `not ok 416`（`r-npmtest.log:2626`） |
| **耗时被拖 7 倍，恰好吃满它自己的 10s 轮询预算** | `duration_ms` 5279.8 → **38523.4**；38.5s ≈ 该文件正常基线 ~28s + 轮询上限（`:483`）的 10s。该用例**单独跑**只要 **3481ms**（`flake-1.log` 实测 `ok 1 / 1 pass`）；整轮 node 侧从 **137.7s** 涨到 **772s**（5.6×） |
| **改动不在该代码路径上** | 本轮只动了 iOS 的 python 门禁、文档、以及两处**纯注释**（`v31-migration.ts` 冻结校验和 `MATCH: true`、`hooks.ts` 默认值未动）；该用例走的是 `server.ts` + `recompute-job-repository.ts` 的恢复路径，**一个字节没碰** |

**机械根因**：那一轮跑在一台**即将重启**的机器上 —— `kern.boottime` = **23:01:03**，即测试结束后
2 分钟系统重启；同一时刻 `WindowServer` 占 120% CPU、Spotlight 全家（`mds` / `mds_stores` /
`mdbulkimport`）在重建索引，`uptime` 报 load **23.6**。而该用例要求在
`POST /v1/backups/:name/restore` 返回后 **10 秒内**让后台 worker 把 recovered 的 job 从 `queued`
推到终态（`packages/storage-sqlite/src/recompute-job-repository.ts:105-162` 把它置回 `queued`，再由 worker 拾起）。
⇒ **该用例对 CPU 争抢敏感，10s 预算只留约 3× 余量** —— 这是**测试脆弱性**（记账用），不是产品缺陷。

**对报告结论的影响：无。** D1–🟡8 的判据都不依赖这条用例；`npm test` 的验收以 **23:11 那轮
EXIT=0 / 0 fail** 为准。

> 🟡 **新增观察（记账，本轮不修）**：`server-runtime.test.ts:467`（15s）、`:483`（10s）、
> `:502`（10s）三个预算都是**拍定阈值**（纪律 6：阈值只能当参数，不得当验收标准）。
> 真要收口应把"等恢复完成"改成**事件驱动**（等 job 事件或轮询 `runtime-status`）而非固定墙钟；
> 本轮不改 —— 它是既有代码、与本次未提交改动无关，且收紧/放宽预算都会改变它对真实卡死的检出能力。

> ⚠️ **skip 数也是环境量**：最终态是 **3**（全是 Windows-only 用例）；22:59 那轮是 **4**，
> 多出的那条 `publication lock rejects PID reuse when the process identity differs` 是按设计的
> fail-safe 跳过（`ps` 探测进程身份被沙箱拒）。**别看 skip 数变化就以为覆盖丢了。**

---

## 九、状态更新（提交与部署，2026-10-10 00:45 CST 收口）

> 本节为**追加**，不改写上文任何一行。上文 §八 序 0 的「⏸ 未执行」与「D1 的风险原样保留」
> 是 **2026-10-09 当时的时点结论**；下面记录这批改动此后发生的事实，并列出被事实推翻的条目。

### 9.1 提交与推送

- 起点 `6f5faac` → 终点 **`e05f59e`**：**7 个主题化 commit**，**45 文件 / +4145 / −323**。
  删除行数与提交前**逐字节一致（323）**；insertions 算术闭合（2033 已跟踪 + 1580 新增源文件 + 532 本报告）
  ⇒ 无内容丢失。
- **顺序即依赖**（后组建立在前组的新 API 上）：

  | # | commit | 主题 | 关键产物 |
  | --- | --- | --- | --- |
  | 1 | `915230b` | feat(storage) | v30/v31 迁移：`healthkit_record_sources` / `healthkit_record_aliases` / `healthkit_record_facts` |
  | 2 | `b91bf89` | feat(parser) | 导出清单 v2 + HealthKit 记录身份（sample UUID） |
  | 3 | `d1ab7b6` | feat(api) | 握手声明 `healthKitRecordSyncVersion=2`、接受 v2 导出清单 |
  | 4 | `6774a3e` | feat(ios) | 记录级变更游标 / 归档 / 后台恢复接入 v2（24 项：18 M + 6 A） |
  | 5 | `65d51a9` | fix(web) | 常规读取默认套 15 秒 deadline（审计 3.9） |
  | 6 | `3320dc0` | docs | 记录同步 v2 协议、ADR-004 与升级边界 |
  | 7 | `e05f59e` | docs(deliverables) | 本报告 |

- **逐节点独立可用（不是只看最终态）**：先 `git stash push -u --keep-index -- <后续组路径>` 把工作区
  摆成节点态，再实跑门禁 —— 这样 pre-commit hook 的结论才落在真节点态上。实测：
  1 storage `typecheck EXIT=0` + 定向 **133/131/0/2**；2 parser **201/200/0/1**；3 api **135/133/0/2**；
  4 ios `test:ios EXIT=0`（archive 19 / cursor 8 / record sync 23 / capabilities 269 / determinism 14）；
  5 web hooks **9/9 pass**；6 docs `check:docs` **28 files / 229 links / 0 problems**；7 `git status --short` 变空。
- **推送**：`6f5faac..e05f59e  main -> main`；`git log -1 origin/main` = `e05f59e`；
  `git status -sb` 无 ahead / behind。

### 9.2 线上部署（腾讯云轻量 `lhins-3gatdqed`，2026-10-10 00:45 CST）

| 步骤 | 实测证据 |
| --- | --- |
| 影响面 | `package.json` / `package-lock.json` / `deploy/` **均未变** ⇒ 跳过 `npm ci` |
| 迁移前基线 | `/v1/data-summary`：`healthRecords 183556 / workouts 285 / trainingSessions 282 / routePoints 135192 / assessments 282`，`issues: []` |
| 备份 | `POST /v1/backups` ⇒ `rai.manual.2026-10-09T16-44-39-103Z.b7747ad4.sqlite`（614862848 B）；远程 `ls \| fgrep -c b7747ad4` = **1** |
| 迁移预演（只读） | `version: 29`、`pending: [30, 31]`、counts 与基线逐项一致 ⇒ 确认**必须停服迁移** |
| build | `npm run build` ⇒ `BUILD_EXIT=0`（12.23s），新 index chunk **`index--S1o6fi6.js`** |
| 迁移 | `systemctl stop rai-api` → `data:migrate --apply` ⇒ **v29 → v31**、counts **285 / 135192 / 183556 逐项不变**、`pending: []`、`foreignKeyCheck: ok`、`elapsedMs 3625`、`APPLY_EXIT=0` |
| 起服 | `ACTIVE=active`、`NRestarts=0`、`MemoryMax=1468006400`、`ActiveEnterTimestamp=Sat 2026-10-10 00:45:28 CST` |
| 握手 | `/v1/handshake` ⇒ **`healthKitRecordSyncVersion: 2`**（此前该字段缺失正是"线上是旧版"的判据，现已闭合） |
| 数据 | `/v1/data-summary` 与迁移前**逐项相同**、`issues: []`；`schema_migrations` 含 **v1…v31** |
| 新表 | `healthkit_record_facts` 存在、**0 行**（`healthkit_record_sources` 尚无映射 ⇒ v31 无回填，符合设计；同时证明新表真建上了） |
| 服务定义 | `/etc/systemd/system/rai-api.service` 与仓库 `deploy/rai-api.service` **逐字节相同**，含 `RestartPreventExitStatus=78` |
| 匿名面 | `/v1/backups`、`/v1/diagnostics`、`/v1/import-sources/recent` **全 401**；`/v1/health` ⇒ `{"status":"ok","databaseReady":true}` |
| SPA | `/`、`/settings`、`/workouts` 全 **200**；站点 chunk = `index--S1o6fi6.js`（与 dist 一致），旧 chunk `index--8bVyjH7i.js` **404** |
| 冷路径用例 | 在**线上那份代码**上跑 `apps/api/test/healthkit-record-changes.test.ts` ⇒ `EXIT=0`、2 tests / 2 pass / 0 fail / 0 skipped |

启动日志另确认：`publicReadRoutes: 27 / tokenRequiredReadRoutes: 20`、`databasePath: /var/lib/rai/var/rai.sqlite`、
`RAI local API ready`；环境 `RAI_IMPORT_ENGINE=rust` / `RAI_RUST_FALLBACK=typescript` / `RAI_RUST_BINARY=/opt/rai-native/rai-data-worker`
（`RAI_IMPORT_VALIDATION_MODE` 已不在），无导入进程在跑。本机 `var/rai.sqlite` mtime 仍 `2026-10-08 00:35`（未被本次部署触碰）。

### 9.3 被本次事实推翻的上文条目（只列这些）

| 位置 | 原文（时点结论） | 现状 |
| --- | --- | --- |
| §八 序 0 | `⏸ **未执行**`：部署 + `data:migrate` | **已执行**（见 9.2），线上库 v29 → **v31** |
| §八「为什么 0 没执行」 | 「**D1 的风险原样保留**：线上库若仍低于 v30，重新部署会因 `migrationPolicy:"refuse"` 起不来」 | **已消除**：线上库现为 **v31**，重部署不会再因 `refuse` 拒启 |
| 门禁实跑表 | 表上方已标「时点快照」；申报过期项为 突变 92→95、record wiring 21→23 | 以 §八「收尾回归实跑（最终态，2026-10-09 23:11）」为准 |

**仍然未决、且不因本次部署而改变**：🟡5「`anchoredRecords` 的 `next == nil` 是否可达」——
**只能真机判定**（HealthKit 读授权必须走真机 UI 弹窗，`simctl` 不支持 health）；报告与源码注释只落了
「未决 + 判定手段」，**未改成兜 nil**。其余 🟡2 / 🟡3 / 🟡4 / 🟡6 / 🟡7 / 🟡8 与 §七 全部方法学备注均属**记账项**，本轮未改。

