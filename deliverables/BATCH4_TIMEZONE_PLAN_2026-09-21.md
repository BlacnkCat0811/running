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
