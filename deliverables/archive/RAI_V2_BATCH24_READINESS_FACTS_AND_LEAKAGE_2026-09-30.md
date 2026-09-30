# RAI V2 批次 24 实施记录 —— Readiness 事实接口、真实库泄漏量化与主夜回填

日期：2026-09-30
对象方案：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` §4.1 / §7 / §15.3 / §15.5
上一份记录：`deliverables/archive/RAI_V2_BATCH23_R05_D03_ACCEPTANCE_2026-09-30.md`

## 0. 结论

本批把 §15.5 里**一直只有名字、没有数字**的 Readiness 指标变成可复现的数字，
并在此过程中发现三个相互独立的问题，每一个都有实测证据：

1. `replayReadinessRulings` 是纯函数、有单测，但**从未在真实数据上被调用过** —— 于是
   "freshness 泄漏率"从来没有值。本批补上 runner。
2. 🔴 **本机 `var/rai.sqlite` 的 `canonical_nights` 与 `canonical_hrv_days` 各 0 行**，
   而原始睡眠段有 **5222 行**、HRV 有 **684 行**。设计文档写明的启动期空表回填
   **从未接线**（仓库里 `canonicalizeNights` 只被 import CLI 调用）。后果：§7 的 Readiness
   在这份库上永远只能拿到 `coverage: none`。
3. 🔴 `canonicalizeNights` 的日期范围由每个睡眠段的**开始时刻**决定
   （`dates = all.map(s => localDateAt(s.start, tz))`），因此**最后一夜会落在范围之外**。
   三个合成夜只产出 2 个主夜；真实库上同理。

## 1. §4.1：先解决证据接口

`loadDatedReadiness` 之前把"装配事实"和"判定"焊在一起。回放器需要的是**事实**，
于是它只能自己再写一遍那些 SQL —— 那正是"两套恢复口径"的开端。

拆成：

```ts
loadDatedRecoveryFacts(db, asOf, tz): DatedReadinessFacts   // 只有 SQL 与到达时间口径
loadDatedReadiness(db, asOf, tz) = assessDatedReadiness(loadDatedRecoveryFacts(...))
```

**逐位等价**由一条专门的断言守住，并且夹具保证事实里**真的有信号**
（否则"两边都空"也会通过）。多组输入（发布时刻已知/未知、不同日）都要求 `deepEqual`。
突变：让包装器改掉 `localDate` ⇒ 两条用例转红。

## 2. §15.3/§15.5：真实库上的 Readiness 泄漏量化

新增 `packages/application/src/readiness-replay-coverage.ts` +
`scripts/readiness-replay-coverage.mts`（只读），产出 `deliverables/READINESS_REPLAY_COVERAGE.json`。

口径（写进报告，不允许含糊）：

- **每天以其本地日的最后一毫秒为 asOf**。取当天 00:00 会让当夜睡眠尚未观测（清晨才醒），
  所有日子都会变成"缺睡眠"；取次日 00:00 又会让事实装配器去评估次日。runner 里有断言
  防止这个假设被静默破坏。
- 日集合 = 主夜 wake_date ∪ canonical HRV 日 ∪ **静息心率的本地日**，并在窗口内**逐日填充**，
  所以 `coverage: none` 的日子也进分母。
- 回放模式固定 `event_time_reconstruction`。

### 两个被测试抓出来的定义错误（第一版都是错的）

1. **`availabilityUnknown` 把"没有读数"也算成"到达时间未知"**。
   结果是每一天都被标成 as_known_then 不可用。正确判据是
   **`value !== null && availableAt === null`** —— 没有读数就无所谓到达。
   现在两者分开报告（见下面 `unassessableReasons` 的直方图）。
2. **泄漏率的分母用错了**。第一版用"严格支可评估的日子"作分母，
   而**最典型的泄漏恰恰是"严格支什么都看不到、'观测即到达'支看到一次低睡眠"** ——
   这类日子会被整类排除，最该报警的情形反而算不进泄漏率。改为
   `comparableDays`（**至少一支**能看到东西）。

另外：n < 2 时不给比率，而是给分类状态
（`no_comparable_days` / `single_comparable_day` / `evaluated`）。
`0` 与 `null` 是两件不同的事 —— 在 1 个可比日上的 0 与在 200 个可比日上的 0 完全不同，
只报一个 `0` 会让"完全无法评估"读成"没有泄漏"。判据是算术性的，不是另编一个覆盖率下限。

### 本机实测（2026-09-30，只读）

```text
窗口            2024-06-12 .. 2026-07-20（769 天）
事实来源        主夜 0、canonical HRV 日 0、静息心率日 303
coverage        none 768 / partial 1 / complete 0
有读数天数      303
assessableDays  1        （严格支真正能判定的只有 1 天）
comparableDays  1
leakageStatus   single_comparable_day，leakageRate = null（不是 0）
asKnownThenBlockedDays  302   （有读数却无法考据到达时间的天数）
不可评估原因    无读数 466、有读数但到达时间未知 302
```

**这就是"本地库没有可用的恢复历史"的量化版本**：769 天里只有 1 天能判定，
且**没有任何一天**能充当 `as_known_then` 证据。

### 已验证：即使回填，历史日仍然不可判定

在真实库的**副本**上跑了回填（`canonicalizeNights`）：**2.65 s** 得到
**170 个主夜 + 5 个午睡 + 170 个 HRV 日**（另有 17 段仅 InBed 被拒）。再跑一遍覆盖率报告，
`coverage` 分布**完全不变**。原因不是回填失败，而是：
回填产生的每一行的 `computed_at` 都是**现在**，而基线查询也带 `computed_at <= asOf` 约束 ——
历史某天当时既没有这些读数、也没有由它们构成的基线。**这是保守口径在正确工作**，
不是缺陷；但它意味着"回填"能修的是**未来**的 Readiness，不能追溯历史。

## 3. 主夜回填：把"文档写了但从没接线"变成可执行

新增 `backfillCanonicalNights`（`packages/application`）+ `scripts/backfill-canonical-nights.mts`
（**默认只预览**，`--apply` 才写库）+ `npm run data:backfill-canonical-nights`。

三种结局都是可测试的：`not_needed`（夜表非空，不重算）、`no_sleep_records`（没有可建的事实，
不谎报成功）、`backfilled`（原样返回 canonicalizer 的计数）。
回填后若 `canonical_nights` 仍为 0，**抛错**而不是报告成功 —— 否则调用方会以为 Readiness 有事实可用。

突变验证：去掉幂等守卫 ⇒ 用例 1、3 转红；去掉 `no_sleep_records` 分支 ⇒ 用例 2 转红。

**没有接进 API 启动路径**：那条路径的失败语义是 `databaseRecoveryRequired`（整个 API 拒绝就绪），
对一次可重试的回填来说代价过高。是否接线应当单独决策 —— 这是本批**刻意留下的**决定，
不是遗漏。

## 4. 发现的 canonicalizer 边界（未修）

```ts
const dates = all.map((s) => localDateAt(s.start, timezoneIdentifier));
const minDate = dates.sort()[0]!; const maxDate = dates.sort().at(-1)!;
while (date <= maxDate) { ... }
```

日期范围由段的**开始**时刻决定，而一夜的 InBed 段开始于**前一晚**。
所以最后一段所在的那一夜永远不会被访问。合成夹具（3 夜 → 2 主夜）与真实库都可复现。

**测试刻意不写死这个数字**：断言"自洽（`after.nights` = main + nap）+ 下界"，
并在注释里写明原因 —— 否则将来修好它会先撞上一条把 bug 钉成"正确"的断言。

修它属于 import 行为变更（会影响每次导入的夜表输出），本批不动。

## 5. 变更清单

| 文件 | 改动 |
|---|---|
| `packages/application/src/model-v2-snapshots.ts` | 拆出 `loadDatedRecoveryFacts`；`loadDatedReadiness` 变成它的薄包装 |
| `packages/application/src/readiness-replay-coverage.ts` | 新增（覆盖率与泄漏量化） |
| `packages/application/src/backfill-canonical-nights.ts` | 新增（有守卫、幂等、可观察的回填） |
| `packages/application/src/index.ts` | 导出上述入口 |
| `scripts/readiness-replay-coverage.mts` | 新增（只读 CLI） |
| `scripts/backfill-canonical-nights.mts` | 新增（默认预览） |
| `package.json` | 两个新命令 + `pre` 钩子 |
| `packages/application/test/model-v2-readiness.test.ts` | 新增事实/判定等价断言 |
| `packages/application/test/readiness-replay-coverage.test.ts` | 新增 5 条 |
| `packages/application/test/backfill-canonical-nights.test.ts` | 新增 3 条 |
| `deliverables/READINESS_REPLAY_COVERAGE.json` | 新增（机器可读产物） |

## 6. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| node 侧全量 | **EXIT=0** = **1077 tests / 1059 pass / 0 fail / 18 skipped**（批次 23 后为 1068/1050，本轮 +9） |
| web 侧全量 | **EXIT=0** = 18 文件 / 111 tests（未变） |
| Python | **EXIT=0** = 26 passed（未变） |
| 两个新脚本实跑 | `readiness-replay-coverage` 与 `backfill-canonical-nights`（dry-run）均 **EXIT=0**；回填在**副本**上验证，未对 `var/rai.sqlite` 执行 `--apply` |

## 7. 复现命令

```bash
cd D:\running
npm run data:readiness-replay-coverage -- --database var/rai.sqlite --out deliverables/READINESS_REPLAY_COVERAGE.json
npm run data:backfill-canonical-nights -- --database var/rai.sqlite            # 只读预览
node --import tsx --test packages/application/test/readiness-replay-coverage.test.ts
node --import tsx --test packages/application/test/backfill-canonical-nights.test.ts
node --import tsx --test packages/application/test/model-v2-readiness.test.ts
```
