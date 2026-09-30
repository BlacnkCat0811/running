# 核实外部审查报告（grok，2026-09-16）

**核实对象**：工作区未提交改动（相对 `HEAD`）＝ 21 文件（14 已跟踪 +699/−67，7 未跟踪），审查方报 1 bug + 3 suggestion。
**核实方式**：逐条落 `文件:行号` 读码 + **构造反例实跑**（不采信"读码推断"）+ 门禁实跑。
**核实基线**：2026-09-16 09:25，工作区（`var/rai.sqlite` 只读打开，未触碰线上）。

## 修复状态（2026-09-16 10:05，全部落地）

Issue 1 按小唐选定的**方案 A（根因法）**修；4 条全部关闭，门禁全绿。

| # | 改动 | 文件 |
|---|---|---|
| 1 | 只有「今天」的过点 slot 才滚到 `now+60s`，过去日保留自己的日期与小时 —— 代码回到它自己注释声明的意图（"today's session stays schedulable"） | `WorkoutPlanMapper.swift:148-154` |
| 1+ | 加固：`confirm` 要求 `dayKey(at) == dayKey(localDate)` 才计入（`localDate` 逐字段解析，不引入时区）⇒ 即使将来有人把跨日滚动改回来，也只会**少报**不误归属 | `PlanReceiptMatcher.swift:69-72` |
| 2 | 截断标记为**不可重试**（显式 `retryable` 覆盖位，不靠 status 猜）；并区分「重试被自己的 deadline 杀掉」与「首轮真因」，后者优先上报 | `weekly-plan-llm.ts` |
| 3 | 回收测试补 `.importing.` 两类夹具（CLI `<db>.importing.<uuid>` / worker `rai.importing.<jobId>.sqlite`）+ 新鲜在途 + 目录与残形不碰 | `maintenance.test.ts` |
| 4 | 删变更叙事：`6c61a9a` 引用、"only ever called from `ensureBackupCapacity`" 假句、"was a hardcoded constant"、`run-model-tests.sh` 的历史段 | 5 个文件 |

**实测证据（修后复跑）**

- 原反例脚本：`2026-9-14 7:00 / 09-15 7:00 / 09-16 21:31 / 09-17 7:00`，`confirmed = [09-15, 09-16, 09-17]`，`RESULT: no collision`（修前是三天同为 `09-16 21:31`、`confirmed` 含周一）。
- 截断探针：`attempts: 1 / 34ms / "模型输出被 token 上限截断"`（修前 `attempts: 2 / 8003ms / "The operation was aborted."`）。
- **突变验证**（Issue 3 的正题）：把正则收紧成 `importing\.[0-9a-fA-F-]{36}$` ⇒ 新测试立刻红（`not ok 39`）→ 夹具确实覆盖了 worker 形状。
- 门禁：`npm run typecheck` EXIT=0；`npm test` EXIT=0（node **610** / 606 pass / 4 skip / 0 fail + vitest 13 文件 84 pass）；`run-model-tests.sh` EXIT=0（**100** 条 check）；`typecheck-ios.sh` EXIT=0（37 文件）。

**唯一遗留决策**：方案 A 里过去日保留了**过去时刻**，而 `lateFloorSeconds` 的存在暗示"过去时刻不可排"。
若 WorkoutKit 确实拒收，周中同步面板会退化成「已提交 N 项，但系统未回读确认」
（`verified = confirmed.count == pending.count`，`WorkoutKitBridge.swift:245`）。
备选是**不把过去日放进 `pending`**（计数自动并入 `skipped` 的 `executable.count - pending.count`）
⇒ 面板变「已同步 4 项，跳过 3 项」。两者都需真机看一眼周中同步的文案才能定。

## 该遗留项已关闭（2026-09-16 10:35）

按备选方案落地，并补完同一条不变式的另一半：**手表只持有"还欠着"的课**（未过去 ∧ 未完成）。

| 改动 | 文件 |
|---|---|
| 新增 `upcoming`（今天及以后）/ `owed`（再排除已完成）/ `resolvedTimeZone(for:)`；`schedulableCount` 改数 `owed` | `WorkoutPlanMapper.swift` |
| `sync` / `syncRequestingAuthorization` 接收 `completedLocalDates`；`offered` 语义改为"本轮真正下发的天数"；新增 `expired` / `alreadyTrained` 与 `notOwedNote` 文案 | `WorkoutKitBridge.swift` |
| 两皮肤视图把 `native.completedWeekDates` 同时喂给面板计数与同步调用 | `NativeViews.swift` / `Skins/Technology/TechViews.swift` |

**为什么连"已完成"一起修**：面板那句「已完成的日期不会重复下发」本来就写着（`NativeViews.swift:1686`），
而 bridge 此前完全没读 completed 集合（`completedWeekDates` 只喂给了 `unofferedDays`）。这是同一条不变式的另一半，
不是新需求 —— 只修一半，面板那句话仍然是假的。

**预期面板变化**（周三、Mon–Sat 可上表、Sun 休息、今天还没跑）

- 旧：「已同步 6 项到「体能训练」」—— Mon/Tue 是假的，而且 3 个训练全被钉在今天 21:31。
- 新：「已同步 4 项，跳过 1 项。（2 天已过去，不再排期）」

`/v1/mobile/today` 拿不到数据时 `completedLocalDates` 为空集合 ⇒ **fail-open**，退回旧行为，不会因为离线而漏发。

**门禁**：`run-model-tests.sh` **112** 条全过（+5 条：`owed` 的两类排除、计数随已完成下降、整周已完成 ⇒ 计数 0、时区取"今天"）；
`typecheck-ios.sh` 37 文件通过（bridge 与两皮肤视图的**唯一**编译级通道）；TS 侧未动，仍复核 `typecheck`=0、`npm test`=0（node 610 / 606 pass / 0 fail）。

**突变验证**（两条规则各自独立被抓）：

- 把 `owed` 的"已完成"排除删掉 ⇒ 5 条新断言全红，而 `upcoming` 的断言仍绿。
- 把 `upcoming` 的日期比较改成恒真 ⇒ 7 条断言红（含面板计数与时区那条）。

**仍需真机**：bridge 在 `#if os(iOS)` 内，面板文案与实际下发行为要做一次周中同步确认。

**未改（有意）**：`audit.ts` 冗余口径与迁移口径的理论差异 —— 对齐要在审计里再抄一份 id 公式（第三份），
而两者在真实 160k 行上数值完全相同（76,671），不值当。

> **后续（2026-09-16 本轮独立审查）**：这条判断的**结论维持**（不修），但理由需要补强，因为"数值完全相同"
> 只在**当前数据**上成立，不是两者定义等价的证明。实测把 raw 写成 `"2.7"` / `"2.70"`（`value_numeric` 同为 2.7）
> 的两行放进构造库后：迁移保留 2 行（id 不同），而审计报 `exactDuplicateRecords = 1` —— 两个口径会分叉。
> 当前真实库 **恰好没有**这种写法分歧（`raw_variants > 1` 的重复组数 = 0），所以现网数值确实一致。
> 详见 `deliverables/BACKEND_IOS_FIXES_2026-09-16.md` §四·N-1（含可直接复跑的 SQL 与对 §五 验收措辞的修正）。

## 结论

| # | 审查结论 | 核实判定 | 关键证据 |
|---|---|---|---|
| 1 | 🔴 bug：receipt matcher 只按 civil day 归因，滚动的 `at` 会让周中同步给手表没持有的那天写收据 | ✅ **成立，已实测复现** | 反例脚本输出，见下 |
| 2 | 🟡 截断被当可重试，白烧 50s 预算 | ✅ **成立，且比审查说的更重** | 实测 `attempts=2 / 8003ms / 报错文案被 abort 覆盖` |
| 3 | 🟡 回收测试只覆盖 `.replaced.<uuid>` | ✅ **成立** | `maintenance.test.ts:1186-1279` 三个用例全部只造 `.replaced.` 夹具 |
| 4 | 🟡 变更叙事注释 / `maintenance.ts:639` 自相矛盾 | ✅ **成立** | 行号全部核对无误 |

**一句话**：审查本身可信，4 条全部成立；**但 Issue 1 给的修法解决不了它自己描述的场景**——
改 key 粒度（日 → 瞬时）对这个 case 无效，因为三个 `at` 是**字节相同**的（实测）。
根因在 `scheduleComponents` 的滚动范围，不在 matcher 的 key 粒度。

## Issue 1 — 成立（bug），且审查建议的修法无效

**根因**：`WorkoutPlanMapper.scheduleComponents` 对 `planned <= now` 的**每一天**（不是只有今天）
都返回 `now + lateFloorSeconds`（`WorkoutPlanMapper.swift:146-159`）；`WorkoutKitBridge.sync`
全程只取一个 `now`（`WorkoutKitBridge.swift:185`）⇒ 一周内所有过去日拿到**完全相同的 `DateComponents`**。

**实测复现**（`/tmp/rai-verify/`，`swiftc` 直编真实源文件 + `main.swift`，`now` = 周三 2026-09-16 21:30，Asia/Shanghai）：

```
计划日            ->  交给 schedule(_:at:) 的 at
2026-09-14(周一)  ->  2026-9-16 21:31
2026-09-15(周二)  ->  2026-9-16 21:31
2026-09-16(周三)  ->  2026-9-16 21:31
2026-09-17(周四)  ->  2026-9-17 7:00

listed on the watch: Tue, Wed, Thu
confirmed receipts : ["2026-09-14", "2026-09-15", "2026-09-17"]
=> 周一拿到没收据的收据；周三（真落地）丢收据
```

**与审查的差异**：审查建议"按解析出的瞬时（y/m/d/h/m）区分，而不是只按 civil day"——
在本场景**无效**，因为周一/周二/周三的 `at` 三者相同，无论取日还是取瞬时都坍缩到同一 key
（实测数据即证）。审查自己也在建议里承认了这半边，但把它降级成"remaining case"，实际它就是**唯一**的 case。

**候选修法（未定，需小唐选）**：

| 方案 | 做法 | 代价 |
|---|---|---|
| A 根因法 | `scheduleComponents` 只对**今天**滚动（`isDate(planned, inSameDayAs: now)`）；更早的日子返回原 `DateComponents` ⇒ `DayKey` 自然正确 | 改了上表行为，`dropped` / "已同步 N 项" 计数语义需一起验收（过去日要么仍可排、要么明确归入 `skipped`） |
| B 收据法 | matcher 内要求 `dayKey(at) == dayKey(localDate)` 才计入 | 宁可少报不误归属；若过去日确被滚到 today，会稳定少报该日 |
| C 不改 | 接受过去日之间收据可能张冠李戴 | 未关闭原缺陷 |

**验收标准（任一方案都要）**：造 `now` = 周中晚间 + 只列出周二/周三 ⇒ 断言 `confirmed` **不含周一且含周三**。
现有 6 条新测试的 `at` 全部是"日历日 == localDate"的常规值（`WorkoutPlanMapperRegression.swift:490-560`），
**从未传过 rolled `at`** ⇒ 审查这点也对。

## Issue 2 — 成立，且我实测出审查没提的加重项

审查说"白烧剩余 50s 预算"。实测（假 `fetchImpl`：第 1 次返回 `finish_reason:"length"`，第 2 次挂起等 abort）：

```
attempts: 2
elapsedMs: 8003
message: The operation was aborted.
=> cause LOST — 操作者看到的是 abort，截断这个原因被吃掉
```

机制：第 2 次尝试的超时是 `min(timeoutMs, remaining)`（`weekly-plan-llm.ts:163-167`），
比首次短得多 ⇒ 极易被 abort；而 `lastError` 每轮覆盖（`:193`），最后一轮的错误**替换**掉首轮的"截断"
⇒ 落到 `weekly-plan-service.ts:139` 的 warning 只剩 `模型调用失败（The operation was aborted.）`。

**验收标准补充**：不只要求"不重试"，还要"**失败文案仍是截断**"。

## Issue 3 — 成立

`maintenance.test.ts:1186 / 1220 / 1251` 三个用例只造 `.replaced.<uuid>` 夹具；新正则
(`maintenance.ts:102-103`) 新增的两类名没有夹具。实测正则对三种真实命名均正确命中：

```
true   rai.sqlite.replaced.<uuid>
true   rai.sqlite.importing.<uuid>            (cli.ts:90)
true   rai.importing.<jobId>.sqlite           (worker.ts:741)
false  rai.sqlite.replaced.not-a-uuid  /  data-audit.something.md  /  rai.sqlite
```

⇒ 是**覆盖缺口**（未来收紧正则不会被发现），不是当前 bug。审查措辞准确。

## Issue 4 — 成立

行号核对：`maintenance.ts:639` 确有 "only ever called from `ensureBackupCapacity`"（下一句就是新增的 daily timer，自相矛盾）；
`database.ts:1381` / `1449` 引 `6c61a9a`；`PlanReceiptMatcher.swift:3-17`、`WorkoutKitBridge.swift:213-220` 为变更叙事。
（审查引的 `weekly-plan-llm.ts:116` 实为 `:120`，无实质影响。）

## 审查未提、我补的两点

1. 🔴 **Issue 2 的加重项**（见上）：abort 覆盖截断原因 —— 直接影响修法的验收标准。
2. 🟡 **审计口径与迁移口径不是同一个**：`audit.ts:397-410` 的"冗余行"按
   `(type, source_name, start_at, end_at, value_text, value_numeric, unit)` 分组，
   而迁移 v22 的重复判定按**重算出的 currentId**分组（有 `HKMetadataKeySyncIdentifier` 时以它为准，
   `database.ts:1495-1501`）⇒ 两行自然键相同但 sync id 不同的记录，**迁移会保留、审计会继续报冗余**。
   当前 76,671 冗余组基本都带 sync id，所以实际影响很小；但迁移后若审计仍报冗余，先查这里，别当成迁移失败。
   （**属读码推论，未构造数据实测**，标 🟡。）

## 门禁实跑（本轮，全绿）

| 门禁 | 结果 |
|---|---|
| `npm test` | node **609**（605 pass / 4 skip / **0 fail**）+ vitest 13 文件 / **84 pass** |
| `apps/ios/tests/typecheck-ios.sh` | **37 文件通过**（含新增 `PlanReceiptMatcher.swift`） |
| `apps/ios/tests/run-model-tests.sh` | 通过（6 条新 receipt 断言在内） |
| `packages/storage-sqlite/test/health-record-id-migration.test.ts` | **2/2 通过** |

**迁移 v22 独立复核**（本次最高风险项，审查只给了"看起来正确"）：确认两条铁律都在——
依赖表（`import_entity_generations` / `import_entity_tombstones`）**先于**主表加前缀（`database.ts:1567-1575`），
且还原**所有存活行**而非只有改名行（`:1580-1597`，且 `staged !== to` 恒真，实际全量入映射）。
也不存在"哪张依赖表被漏掉"的问题：`entity_kind IN ('record','workout','activity_summary')`，
只有前两类按 record 走，已覆盖。

**只读实测（本地库现状）**：`var/rai.sqlite` **160,051 行 / 冗余 76,671**（迁移后应剩 83,380），
`schema_migrations` 只到 **18** ⇒ 下一个写入进程打开它会**连跑 19→22**。
⇒ **部署前先 `POST /v1/backups`**（迁移不可逆，回滚靠备份）；本地 `npm run dev` 同样会触发。
