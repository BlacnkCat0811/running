# N-1 迁移冻结注释订正 · 修复与验证报告

> **日期**：2026-09-24
> **来源**：`deliverables/PROJECT_AUDIT_2026-09-23.md` §四 N-1
> **性质**：🟡 **纯文案订正** —— 零行为变更。这是本报告要证明的第一件事。
> **改动文件**：3 个（`database.ts`、`migration-policy.test.ts`、`.githooks/pre-commit`）

---

## 一、结论先行

| 项 | 结论 |
|---|---|
| 原注释说了什么 | "换 `node --experimental-strip-types` ⇒ **全部迁移集体失配、含线上在内的所有库立刻打不开**" |
| 实际是什么 | 换通道后**现算值** 22/22 漂移，但**既有库仍然打得开**——运行时判定走 `FROZEN_MIGRATION_CHECKSUMS` 冻结表，与执行通道解耦 |
| 这个故障模式 | 只存在于 `342ae38` **冻结之前**（已在其父版本 `342ae38^` 上复现） |
| 真危险的方向 | 照门禁报错去「修复」冻结表 ⇒ 既有库行里存的是**旧**冻结值，改表才让它们**全部失配** |
| 改动性质 | **0 行代码** —— 34 + 14 行 diff 全部落在 `*` 注释块内（机检，见 §四） |
| 门禁 | `migration-policy.test.ts` **8/8 绿**（含"给 `up` 加注释不改 checksum"那条） |

---

## 二、四组对照实测（同一份 324 MB 真库副本，只换代码 / 通道）

| 代码版本 | 执行通道 | 22 个 checksum 现算值漂移 | `RaiDatabase.open(既有库, {migrationPolicy:"refuse"})` |
|---|---|---|---|
| 当前（工作树） | `node --import tsx` | **0/22** | **OK** |
| 当前（工作树） | `node --experimental-strip-types` | **22/22** | **OK** ← 关键行 |
| `342ae38^` | `node --import tsx` | —（该版本尚无冻结表） | OK |
| `342ae38^` | `node --experimental-strip-types` | — | 🔴 **THREW `Migration 1 checksum does not match the application`** |

**这张表就是订正的依据**：第 2 行与第 4 行的对比说明"库打不开"不是通道问题，而是**冻结表在不在**的问题。

### 2.1 为什么漂移了还能打开

```ts
// database.ts（冻结表优先，运行时判定与执行通道解耦）
export function migrationChecksum(migration) {
  return FROZEN_MIGRATION_CHECKSUMS[migration.version] ?? checksumOfTranspiledSource(migration);
}
```

- `FROZEN_MIGRATION_CHECKSUMS`：**22 条**（version **1..22**，机检确认）。
- 运行时判定读这张表 ⇒ 与 `up.toString()` 的转译产物**无关**。
- 漂移的是 `transpiledChecksumFor()` 的现算值，它只被**测试**用（"冻结值仍等于转译产物"那条）。

### 2.2 附带事实（同批订正）

即便真去换通道，本应用也**先起不来**，与 checksum 无关：

| 事实 | 实测值 |
|---|---|
| `apps/api/src` 的 `.js` 相对导入 | **82 处 / 27 个文件**（`./x.js` 76 处 + `../x.js` 6 处） |
| 最大的两处 | `server.ts`(24)、`import-worker.ts`(9) |
| 原生类型剥离的行为 | 不做 `.js`→`.ts` 重写 ⇒ 模块解析阶段 `ERR_MODULE_NOT_FOUND`，早于任何 checksum 判定 |
| 同族的运行时 re-export | `packages/contracts/src/index.ts:6` `export * from "./timezone.js";` |

> 🔴 **本轮自我纠错**：这条附带事实的初稿写成"**76 处** `.js` 相对导入"。76 只是 `./x.js` 的口径，
> 漏掉了 `../x.js` 的 6 处。已按 **82 处** 订正（3 个文件全部改到）。这正是"标了亲验却算错"的典型，
> 记在这里以免下次再犯。

---

## 三、改了什么（3 处同型残留）

| 文件 | 改法 |
|---|---|
| `packages/storage-sqlite/src/database.ts` | `FROZEN_MIGRATION_CHECKSUMS` 上方注释整块重写：嵌入**四组对照表**、点明"真正危险的是改冻结表"、给出**诊断顺序** (a) 历史迁移被改 → (b) 通道被换 |
| `packages/storage-sqlite/test/migration-policy.test.ts` | 同型因果订正（不再声称换通道 ⇒ 库打不开），补"本条变红时的处置顺序" |
| `.githooks/pre-commit` | 迁移段注释订正（删掉"所有既有库立刻打不开"），改述为"现算值漂移 + 第二条变红，但库仍打得开" |

> 说明：`.githooks/pre-commit` 同批还新增了体积闸门（属 N-3）。该文件只有两个 hunk，已按主题
> **拆成两个提交**（本提交只含迁移注释那个 hunk）。

`packages/storage-sqlite/src/database.ts:1713` 的 `migrationChecksum()` 实现**未改动**——
订正的只是它的说明文字。

---

## 四、验收证据

### 4.1 "纯文案"的机检断言

逐行解析 `git diff`，凡 `+`/`-` 行去掉首字符并 trim 后不以 `*`、`//`、`/*`、`*/`、`#` 开头者计为**代码行**：

```
packages/storage-sqlite/src/database.ts             改动行=34  非注释行=0
packages/storage-sqlite/test/migration-policy.test.ts 改动行=14  非注释行=0
```

⇒ **0 行代码**。这是"零行为变更"的直接证据，而不是靠人眼扫一遍注释块。

### 4.2 门禁

```
npx tsx --test packages/storage-sqlite/test/migration-policy.test.ts
# tests 8   # pass 8   # fail 0   # skipped 0
```

其中一条断言正是"给历史迁移的 `up` 加注释 → checksum 不变"——它绿着，就说明冻结值没被这次订正碰到。

---

## 五、验收标准与回滚

| | |
|---|---|
| **验收标准** | ① 机检非注释行 = 0；② `migration-policy.test.ts` 8/8 绿；③ 注释不再出现"换通道 ⇒ 库打不开"；④ 诊断顺序在注释里显式写出 |
| **回滚** | `git revert <commit>`（纯注释，无状态、无迁移、无数据影响） |
| **不可逆风险** | **无**。不触碰 `FROZEN_MIGRATION_CHECKSUMS` 的任何一个值，不改任何 `up` |

> 🔴 本条**唯一**的红线：**绝不能**"顺手更新冻结表"。本次改动一行都没碰它。
