# RAI V2 批次 25 实施记录 —— 夜表日期范围截断修复（canonical-night-v1 → v2）

日期：2026-09-30
对象方案：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` §7（事实来源）/ §15.3
上一份记录：`deliverables/archive/RAI_V2_BATCH24_READINESS_FACTS_AND_LEAKAGE_2026-09-30.md`

## 0. 结论

批次 24 定位到 `canonicalizeNights` 的日期范围只看段的**开始**时刻。本批修掉它，
并把算法版本 bump 到 `canonical-night-v2`（产出行集合的算法文本改了，provenance 必须能区分）。

**同时必须订正批次 24 的一句话**：我当时写的是"**每次导入都会丢掉最近的那一夜**"。
这是**过强**的表述。实测口径（本机 3 年真实库的副本）：

```text
v1（只看开始）  170 主夜 / 5 午睡 / 170 HRV 日
v2（开始+结束） 170 主夜 / 5 午睡 / 170 HRV 日   ← 0 差异
```

真实库的末夜恰好有午夜之后的段（只要这一夜里**任何一段**开始于本地午夜之后，
v1 的范围就已经覆盖它的 wake date），所以这次修复对**这份**数据是 0 差异。
它是**范围截断**：只有"这一夜的**所有**段都开始于午夜之前"（数据在这一夜中途结束，
或这一夜很短）才会整夜丢失。合成用例正是钉这一类边界。

## 1. 修复

```ts
// 之前
const dates = all.map((s) => localDateAt(s.start, timezoneIdentifier));
// 之后
const dates = all.flatMap((s) => [
  localDateAt(s.start, timezoneIdentifier),
  localDateAt(s.end, timezoneIdentifier)
]);
```

扩展上界只会多出"其窗口内确有 asleep 段"的日子：`candidates` 仍按
`[d-1 18:00, d 14:00)` 本地窗口过滤，`sourceGroups` 仍要求至少一段 Asleep。
所以它不会造出凭空的夜，只是不再因为范围截断而漏掉最后一段。

`CANONICAL_NIGHT_ALGORITHM_VERSION`：`canonical-night-v1` → `canonical-night-v2`。
`canonicalizeNights` 本来就是 `DELETE` + 全量重建，与 `docs/SLEEP_HRV_DESIGN.md:786`
的 bump 政策（忽略 dirty，全量重建）一致，所以不产生 v1/v2 混排状态。

## 2. 测试（新增 4 条）

`packages/health-export-parser/test/canonicalize-nights-range.test.ts`

| 用例 | 断言 |
|---|---|
| 三个合成夜 | 三夜**全部**入表（v1 下只有两夜） |
| 单夜、无后续段 | 仍然入表且 `asleep_union_minutes = 480` |
| 版本戳 | 每行 provenance 写的是 `canonical-night-v2` |
| 全量替换 | 重跑两次结果逐位相同（幂等） |

突变验证：把范围改回"只看开始" ⇒ **用例 1、2、3 转红**。

## 3. 一个必须记下来的过程错误

第一次做突变验证时，我用 PowerShell here-string 做替换，**替换静默没有生效**
（缩进/换行不匹配），于是得到"4 条全绿"的结果。如果我据此写下
"突变未转红"，就会得出**"这些断言没有牙齿"的错误结论** —— 而事实恰恰相反。

改用 `edit` 工具重新施加同一条突变后，3 条立刻转红。

**判据（加入本项目的验证纪律）**：突变验证里"没有转红"**首先**要怀疑的是
"突变是否真的施加了"，而不是"断言没有牙齿"。两者必须用一次
`git diff` 或等价手段区分开，再下结论。

## 4. 变更清单

| 文件 | 改动 |
|---|---|
| `packages/health-export-parser/src/canonicalize-nights.ts` | 日期范围开始+结束；版本 bump 到 v2，并写明实测差异为 0 |
| `packages/health-export-parser/test/canonicalize-nights-range.test.ts` | 新增 4 条 |

## 5. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| node 侧全量 | **EXIT=0** = **1081 tests / 1063 pass / 0 fail / 18 skipped**（批次 24 后为 1077/1059，本轮 +4） |
| web 侧全量 | **EXIT=0** = 18 文件 / 111 tests（未变） |
| Python | **EXIT=0** = 26 passed（未变） |
| `npm run check:doc-refs` | 越界 3 / 漂移 98 / 空行锚 7（未变） |
| 真实库副本上重跑回填 | 2740 ms，`canonical-night-v2`，170 主夜（与 v1 同） |

**未对 `var/rai.sqlite` 执行任何写操作**：全部在副本上验证。

## 6. 仍然挂着

- `recoverDatabaseJobs` 的空表回填**仍未接线**（批次 24 记录的理由：那条路径的失败语义是
  `databaseRecoveryRequired`）。是否接线需要单独决策。
- 本机 Readiness 仍然只有 1 个可评估日（批次 24 §2），原因与本次修复无关：
  到达时间只有数据集发布上界，且回填行的 `computed_at` 是现在。

## 7. 复现命令

```bash
cd D:\running
node --import tsx --test packages/health-export-parser/test/canonicalize-nights-range.test.ts
npm run data:backfill-canonical-nights -- --database var/rai.sqlite        # 只读预览
```
