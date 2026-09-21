# 批次 4 实施方案：OPT-9a 时区入口收敛 + formatter 统一

- 日期：2026-09-21
- 口径：**(b) 只收敛后端**（小唐 2026-09-21 批复）
- 状态：**方案待批 —— 本文不含任何代码改动**
- 依据：`IMPLEMENTATION_PLAN_2026-09-21.md` 批次 4；`PRE_SUBMIT_OPTIMIZATION_2026-09-21.md` §3

---

## 0. 结论先行

1. 实测生产代码（`apps/*/src` + `packages/*/src`，不含 test）`Asia/Shanghai` **共 46 处**：**后端 41 / 前端 5** —— 与计划一致，**数字可信**。
2. 46 处里**只有 3 处真正危险**：三处**完全绕过时区系统的固定偏移**（`+8 hours` / `+08:00`）。其余 38 处是"值写死"，改不改行为都一样。
3. 🔴 **文档有 3 处偏差**，其中 1 处是路径写错（`plan-execution.ts` 在 `apps/api/src/` 下，不在 `packages/application/src/`）。见 §2。
4. 建议：**一个批次、两个提交**，各自独立验收 ——
   - 提交 A：抽共享 formatter + 单一时区常量（**纯性能**，对应原 OPT-1 形态）
   - 提交 B：后端调用点收敛到该常量（**零行为变化**，对应 OPT-9a 第一步）
5. 共享落点建议：**`@rai/contracts` 新增 `src/timezone.ts`**。理由见 §3.1（它是唯一被所有包依赖的最底层包，且已有 30 个运行时导出，定位相容）。

---

## 1. 实测分布（后端 41 处，逐处）

| 类别 | 处数 | 位置 | 本次处置 |
| :--- | ---: | :--- | :--- |
| 函数默认参数 `= "Asia/Shanghai"` / 缺省回退 `?? "Asia/Shanghai"` | **14** | `application/service.ts:87`、`recompute-pipeline.ts:295/:783`、`recompute-helpers.ts:234`、`prediction-report.ts:215`、`prediction-data.ts:505`、`prediction-training-data.ts:211`、`application/cli.ts:29`、`health-export-parser/utils.ts:73/:81`、`canonicalize-nights.ts:148`、`training-load/index.ts:326`、`storage-sqlite/read/date-utils.ts:36`、`storage-sqlite/read/training-statistics-read-repository.ts:83` | 改为引用单一常量 |
| 调用点字面量 | **12** | `api/server.ts:691/:697/:1416`、`api/mobile-read.ts:160/:167/:168/:176`、`api/data.ts:308/:846/:847`、`api/import-worker.ts:489`、`health-export-parser/cli.ts:320` | 改为引用单一常量 |
| 响应字段值 `timezone: "Asia/Shanghai"` | **9** | `api/data.ts:487/:655/:806/:856/:965/:982/:991/:995`、`api/mobile-read.ts:417` | 改为引用单一常量（**对外输出值不变**） |
| `Intl.DateTimeFormat` 构造（OPT-1 漏网） | **3** | `api/data.ts:85`、`api/mobile-read.ts:628`、`api/server.ts:632` | 改为复用记忆化 formatter |
| 🔴 SQL 等值字面量 | **1** | `api/data.ts:296` | 见 §4.3（默认**不动**） |
| 🔴 契约层字面量类型 | **1** | `api-contracts/src/index.ts:298` | 🔴 **绝对不动** |
| 注释 | **1** | `api-contracts/src/index.ts:941` | 不动 |
| | **41** | | |

前端 5 处（`apps/web/src/format.ts` 2、`SettingsPage.tsx` 1、`TrainingZonesPage.tsx` 1、`ios/shared.tsx` 1）**本批全部顺延**。

---

## 2. 🔴 对文档的三处纠正

| # | 文档写法 | 实测 | 影响 |
| :--- | :--- | :--- | :--- |
| 1 | "SQL 字面量 `data.ts:296`，参数化会静默返回空" | 🔴 **张冠李戴**。`:296` 是**等值比较** `WHERE kind='main' AND timezone_identifier='Asia/Shanghai'`，参数化（`= ?`）**完全安全**。"静默返回空"说的是 `date(x, 'IANA名')` 那个形态 | 低（偏保守，不影响正确性） |
| 2 | "`plan-execution.ts:19`"（列在 `packages/application/src/` 语境下） | 实际在 **`apps/api/src/plan-execution.ts:19`**（`packages/application/src/` 下**没有**这个文件） | 中（照文档改会找错文件） |
| 3 | "3 处时钟偏移"的归类 | 归类**正确**，但 `trends-read-repository.ts:106` 的写法是 `date(mr.evaluated_at, '+8 hours')` —— 它是**SQL 修饰符**，而另两处（`mobile-read.ts:83`、`plan-execution.ts:19`）是 **JS 的 ISO 字符串偏移**。三者**修法完全不同**，不能一起改 | 中 |

---

## 3. 设计

### 3.1 共享落点：为什么是 `@rai/contracts`

实测依赖图（只列 `@rai/*` 内部依赖）：

```
@rai/contracts        -> （无内部依赖）
@rai/storage-sqlite   -> contracts
@rai/training-load    -> contracts
@rai/health-export-parser -> contracts, storage-sqlite
@rai/application      -> contracts, health-export-parser, storage-sqlite, training-load, ...
@rai/api              -> contracts, application, api-contracts, health-export-parser, storage-sqlite, training-load
```

- `storage-sqlite` 与 `training-load` **互不依赖**，二者都需要 formatter ⇒ 共享物不能放它们任一方。
- `contracts` 是唯一被**所有**包依赖的包，且**已有 30 个运行时导出**（`export const|function|class`）⇒ 它已不是纯类型包，放运行时工具**定位相容**。

**备选**：新建 `@rai/timezone` 包（职责更单一），但要动 workspace 条目、每个消费包的 `dependencies`、`node_modules/@rai/*` 软链、以及线上部署（`npm ci` 后需重建链接）⇒ **为一个小模块付出的部署面明显更大**。**不建议**。

### 3.2 提交 A：共享 formatter + 单一常量（纯性能）

新增 `packages/contracts/src/timezone.ts`：

```ts
export const DATABASE_TIMEZONE = "Asia/Shanghai" as const;
export type DatabaseTimezone = typeof DATABASE_TIMEZONE;

/** 键 = 字段集 + 时区（OPT-1 已验证形态），消除每次调用新建 Intl。 */
export function localCalendarFormatter(timezone: string, fields: ...): Intl.DateTimeFormat;
export function localDateAt(instant: string | number, timezone = DATABASE_TIMEZONE): string;
export function localDateTimeAt(value: string, timezone = DATABASE_TIMEZONE): string;
```

- 语义与 OPT-1 在 `health-export-parser/src/utils.ts:60-80` 的实现**逐字节一致**（含 `hour === "24"` 归一化与线性探测）。
- `storage-sqlite/read/date-utils.ts:36` 的 `localDateInTimezone()`（无 instant 参数、取 `new Date()`）**保留签名**，内部改为复用。
- `application/utils.ts:27` 的 `localDateAt` 与 `health-export-parser/utils.ts:73` **同名同签名，是重复实现** ⇒ 提交 A 顺带收敛为一处（**注意**：两者 `formatToParts` 的缺失回退不同，合并时必须逐字节比对）。

### 3.3 提交 B：后端调用点收敛（零行为变化）

38 处字面量 → `DATABASE_TIMEZONE`。**值不变、输出不变**，唯一目的是"隐式 → 显式单一来源"。

### 3.4 🔴 三处固定偏移：只能"收敛位置"，不能"收敛语义"

| 位置 | 形态 | 为什么不能直接换成 IANA |
| :--- | :--- | :--- |
| `storage-sqlite/.../trends-read-repository.ts:106` | SQL `date(mr.evaluated_at, '+8 hours')` | SQLite **不支持** IANA 名作 `date()` 修饰符 ⇒ 换成 `'Asia/Shanghai'` 会**静默返回 NULL**（不报错），是最危险的一类失败 |
| `apps/api/src/mobile-read.ts:83` | `` `${date}T${hour}:00:00+08:00` `` | JS 侧可以，但需要 IANA→偏移的查表；第一步没有这个能力 |
| `apps/api/src/plan-execution.ts:19` | `` `${localDate}T00:00:00+08:00` `` | 同上 |

⇒ **第一步只把它们收敛成命名常量**（`DATABASE_UTC_OFFSET_HOURS = 8` / `SQL_UTC_OFFSET_MODIFIER = "+8 hours"` / `ISO_UTC_OFFSET = "+08:00"`），
并**就地写明**"这是固定偏移，上海无夏令时故等价；真正的 IANA 支持属第二步"。
🔴 把它变成可配置 = **一次数据迁移**，必须单独立项（`canonical_nights` 的日历天归属会变，而它**没有算法版本列**）。

---

## 4. 红线（不可越）

| # | 红线 | 原因 |
| :--- | :--- | :--- |
| 1 | 🔴 **不动** `api-contracts/src/index.ts:298` 的 `timezone: "Asia/Shanghai"` | 它是**字面量类型**，改它 = 改对外契约，波及 API schema、Web 与 iOS 解码 |
| 2 | 🔴 **不把 SQL 固定偏移换成 IANA 名** | 静默返回 NULL（见 §3.4） |
| 3 | 🔴 **不动夜表的"日历天归属"** | `canonical_nights` 无算法版本列 ⇒ 换时区 = 历史数据不可追溯 |
| 4 | 🔴 **不新增写端点** | 会触发"写端点登记"规则（`metadataOnlyMutationRoutes` / `databaseRequiredMutationRoutes`） |

---

## 5. 验收

| # | 判据 | 方法 |
| :--- | :--- | :--- |
| 1 | 🔴 **逐字节比对**（最硬） | 提交 B 是零行为变化 ⇒ 夜表、日度指标、趋势切分**改动前后完全一致**。用同一份库副本跑改动前后两次，输出哈希比对 |
| 2 | 性能（提交 A） | 复用率可观测：突变守卫 —— 去掉缓存后调用计数从 1 变 N |
| 3 | 夏令时用例 | 上海无夏令时、现网覆盖不到 ⇒ **必须造**（沿用 `local-calendar.test.ts` 已有的 `America/New_York` DST 回拨用例形态） |
| 4 | 回归守卫 | 新增"时区字面量守卫"断言：`apps/*/src` + `packages/*/src` 里除授权位置外不得再出现裸 `"Asia/Shanghai"`，防复发 |
| 5 | 门禁 | typecheck 0 + node 侧 + vitest 单跑 + 桌面 E2E（注意：E2E 须先确认 `apps/web/dist` 比 src 新） |

---

## 6. 回滚

- 提交 A / B 均为**纯源码改动**：无迁移、无 schema 变更、无数据写入 ⇒ **`git revert` 即可**，不需要备份回滚。
- 部署面：本批改 `packages/**` + `apps/api/src/**` ⇒ **需重启 `rai-api`，但不改 `crates/**`（Rust 二进制无需重编译）**、不改依赖（`npm ci` 可跳）。
- ⚠️ 按 `rai-deploy` 的教训：部署前备份请**记下确切文件名**，并在部署完成后确认它**仍在**（线上有每 40 min 的定时备份会挤掉旧的）。

---

## 7. 待你决定

| # | 决策 | 我的建议 |
| :--- | :--- | :--- |
| ① | 共享落点：`@rai/contracts` 新增 `src/timezone.ts`，还是新建 `@rai/timezone` 包 | **contracts** —— 零新包、零依赖变更、零部署变更 |
| ② | `data.ts:296` 的 SQL 等值字面量要不要一并改成绑定参数 | **本批不动**（最小改动；它本身不是性能或正确性问题） |
| ③ | 提交 A 与提交 B 是否按本文拆成两个提交 | **拆** —— 各自独立验收：A 看性能、B 看零行为变化 |

批①②③后我即开工（顺序：提交 A → 门禁 → 提交 B → 逐字节比对 → 门禁）。

---

## 8. ✅ 实施结果（2026-09-21）

| 步骤 | 提交 | 判据 |
| :--- | :--- | :--- |
| 方案文档 | `7850fb3` | — |
| 提交 A：共享 formatter + 单一时区常量 | `a4131d2` | 11 文件；typecheck 0；node **751 / 748 / 0 / 3** |
| 提交 B：33 处字面量收敛 | `5e5df96` | 19 文件；typecheck 0；node **751 / 748 / 0 / 3**；web **13 文件 / 85 tests** |

分支 `land/batch4-timezone` 已 ff 合并进 `main` 并推送（`7d5298b → 5e5df96`）。

### 🔴 实施中发现的两个原方案没写到的点

1. **`= DATABASE_TIMEZONE` 与 `= "Asia/Shanghai"` 的类型推断不同。**
   默认参数写**字面量**时 TS 宽化为 `string`；写 `as const` **常量则不宽化**，参数类型被窄化成
   `"Asia/Shanghai"`，于是所有传 `"UTC"` 的既有调用点（`service.test.ts` 5 处）一起报 `TS2345`。
   **修复：给这 7 个参数显式标 `: string`，恢复原语义。** 这正是原作者不用常量的原因。
2. **`recompute_job_events` 不能进逐字节比对。**
   它的行数是**按时间节流**的（进度上报）⇒ 两次重算耗时不同则事件数不同（实测 75 vs 51，
   跨度 52.7 s vs 33.2 s）；历史 job 的事件数分毫不差（810 × 4）。

### 验收：逐字节比对（方法 + 结果）

方法：同一份本机真实库（325 MB）复制两份 → **用 `git checkout` 切分支**（**不用 `git worktree`**：
`node_modules/@rai/*` 是**相对**软链，干净 worktree 仍会指向脏工作区）→ 在 `main` 与本分支各跑一次
`npm run data:recompute -- --database <副本> --evaluated-at 2026-09-21T00:00:00.000Z --timezone Asia/Shanghai`
→ 对 45 张表逐表哈希 + 对差异表**逐列诊断**。

| 结果 | 数量 | 说明 |
| :--- | ---: | :--- |
| 字节完全相同 | **30 / 45** | 含 `canonical_nights`、`canonical_hrv_days`、`health_records`、`workouts`、`training_sessions` 等 |
| 行数相同、内容有差异 | 14 | 差异列**全部**是 `id` / `*_run_id` / `*_id` / `created_at` / `started_at` / `completed_at` / `state_json`（内含 UUID） |
| 行数不同 | 1 | `recompute_job_events`（时间节流，见上） |

⇒ 🔴 **零业务差异**：没有任何一个业务值列发生变化。

### 突变验证（四条断言都真的会红）

| 突变 | 结果 |
| :--- | :--- |
| 禁用 formatter 缓存 | `localCalendarFormatter memoises` 变红 |
| 键退化为只按时区（丢掉字段集） | `memoises` 变红 **且** `keep the pre-optimisation output` 也变红 |
| 把 `ISO_UTC_OFFSET` 改成 `"+09:00"` | `offset constants agree` 变红 |
| 在 `cli.ts` 塞一处裸字面量 | 收敛守卫变红，**精确报出 `packages/application/src/cli.ts:2`** |

### 副产品（单次样本，**不可外推**）

本机 recompute 的事件跨度 **52.7 s → 33.2 s**：`@rai/application` 的 `localDateAt` 同样在高频构造
`Intl.DateTimeFormat`，提交 A 的共享缓存顺带覆盖了重算路径。
⚠️ 这是**本机数字**（AMD 黑苹果的 `Intl.DateTimeFormat` 构造是正常值的 5–10 倍），
线上收益必须看部署后的 `importJob.performance.stagesMs.recompute`。

### 未做（按口径 (b) 顺延）

- `apps/web/src/format.ts:55/:64` —— 待前端时区口径（(a) 或另议）确定后再动；
  `timezone-convergence.test.ts` 已**显式排除** `apps/web/src` 并注明原因，避免它变成假绿。

---

## 9. ✅ 部署实录（2026-09-21 17:15 CST）

线上 `7d5298b` → **`5a44413`**（4 个 commit：本方案 + 提交 A + 提交 B + 文档回填）。

### 闸门核对（决定动作）

`git diff --name-only 7d5298b..HEAD` 全量 27 文件，按目录归类：

| 路径 | 命中 | 结论 |
| :--- | ---: | :--- |
| `crates/**` | **0** | 🔴 **闸门 0 不触发** ⇒ 不重编译 Rust 二进制 |
| `apps/web/**` | **0** | 跳过 web 构建 |
| `package*.json` | **0** | 跳过 `npm ci` |
| `deploy/**` | **0** | 无需同步 unit / env / nginx |
| 新增迁移 | **0** | 预期 `pending: []` |

⇒ **最小部署 = `git pull` + `systemctl restart rai-api`。**

### 实测

| 步骤 | 结果 |
| :--- | :--- |
| 部署前空闲确认 | `busy:false`、`pgrep` 无 `health-export-parser` / `rai-data-worker` |
| 备份 | `rai.manual.2026-09-21T09-15-07-998Z.babdf99e.sqlite`（530,530,304 B）；部署后**确认仍在** |
| 迁移 dry-run | `version 22` / **`pending: []`** / `health_records 114159`、`route_points 110840` |
| unit | `INSTALLED_EQ_REPO true` / `HAS_EXIT78 true` / `HAS_STARTLIMIT true` |
| pull | `5a44413`；工作树只剩 `?? .npm/` `?? .npmrc` |
| 重启 | `17:15:34` 停 → `17:15:36` listening ⇒ **停机 ≈2 s**；`ACTIVE=active`、`NRestarts=0`、`RAI local API ready` |
| 启动日志 | `publicReadRoutes:26` / `tokenRequiredReadRoutes:12` / `publicReadHosts:["tpandmr.xyz","101.33.202.40"]` |
| 服务验收 | 匿名 `/v1/health` **200**（`status:ok` + `databaseReady:true`）；`/v1/data-summary` 200 且 **`issues: []`**；`/`·`/settings` 200 |
| 引擎 | 进程 environ `RAI_IMPORT_ENGINE=rust` + `RAI_RUST_FALLBACK=typescript` + `RAI_RUST_BINARY=/opt/rai-native/rai-data-worker`，**无 `RAI_IMPORT_VALIDATION_MODE`** |
| 收尾 | 无 `rai-data-worker` 残留；磁盘 34%；备份 14 份 / 7.0 G |

🔴 **`crates/**` 零改动仍跑了 Rust 契约测试**（判据是 `0 skipped`，不是 `8 pass`）：

```sh
cd /opt/rai && RAI_REQUIRE_RUST_TESTS=1 RAI_RUST_BINARY=/opt/rai-native/rai-data-worker \
  timeout 240 node --import tsx --test packages/health-export-parser/test/native-worker.test.ts
# → 8 tests / 8 pass / 0 fail / 0 skipped / NT_EXIT=0
```

⇒ 线上二进制与 TS 契约对齐，**B1 在线**。

### 🔴 本方案原定的验收里漏了一处：逐字节比对**不覆盖 API 读路径**

§8 的逐字节比对跑的是 `data:recompute` 管线，而本批另改了**三处 API 读路径**的内联 formatter
（`apps/api/src/data.ts:85`、`mobile-read.ts:627`、`server.ts:631`）——管线比对**证明不了**它们的等价性。
补两步：

① **静态**：`localCalendarFieldOptions.day` = `{ year:"numeric", month:"2-digit", day:"2-digit" }` + locale `en-CA`
（`timezone.ts:52`），与被替换的三处内联写法**逐字段完全相同** ⇒ 输出字节一致。

② **动态**（真端点，专门防 off-by-one）：

| 端点字段 | 实测 |
| :--- | :--- |
| `/v1/mobile/today` → `timezone` | `Asia/Shanghai` |
| `coverage.sleep.latestDate` / `.hrv.latestDate` / `.restingHeartRate.latestDate` | 均 `2026-09-21` |
| `freshness.recoveryDate` / `recoveryAssessment.targetDate` / `.lastObservationDate` | 均 `2026-09-21` |
| `/v1/trends?days=5` → `endDate` | `2026-09-21`（= CST 当天） |

⇒ **无日期漂移。**

### 性能收益尚未兑现（需下一次真实导入）

`runtime-status` 的 `performance` 是**"最近一次导入"的快照**，此刻仍指向 `7d5298b` 那版代码跑出的
`importJob.createdAt = 2026-09-21T07:56:15Z`。**部署前基线**：

| 阶段 | `7d5298b` |
| :--- | ---: |
| `totalMs` | 66416.7 |
| `parseImport` | 11899.6 |
| **`recompute`** | **13002.7** ← 本批目标 |
| `activation` | 22880.7 |
| `backup` | 15831.7 |

⚠️ §8 记的 `52.7 s → 33.2 s` 是**本机**副产品，**不可外推**。线上收益必须等下次真实导入后的
`importJob.performance.stagesMs.recompute` 与上表对比。
