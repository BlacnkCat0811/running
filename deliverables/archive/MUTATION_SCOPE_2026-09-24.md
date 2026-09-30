# 突变验证「按改动范围裁剪」— 实施与实测（2026-09-24）

## 一、结论先行

| # | 结论 |
|---|---|
| 1 | 新增 **`RAI_MUTATION_FOR`**（`=git` 或 `=<路径>[,<路径>]`）与 `npm run test:ios:mutation:scope`，按**改动文件落在哪个门禁的输入里**裁剪，而不是按突变名抽样。 |
| 2 | 🟢 **改前端 / 数据层 / Rust ⇒ 选中 0/76**，10m15s → ~40s（只剩基线）。 |
| 3 | 🟡 **改 iOS 后台同步核心 ⇒ 45~67/76**，收益有限（~6~9.5min）。🔴 **如实说**：因为 `check-background-capabilities.py` 读了全部 46 个 `apps/api/src/*.ts` 与多数 iOS 源，裁剪空间被它吃掉了；时间大头是 `run-health-sync-tests.sh` 名下的 22 条（13 次 `swiftc` 串行 ≈7min）。 |
| 4 | 🔴 裁剪跑**不是验收**：产物带 `partial: true` + `scope` 字段，结论行措辞与全量不同；**选中 0 条时会明说"什么都没验"**（exit 0，与过滤器拼错的 exit 1 刻意分开）。 |
| 5 | 全量路径**未变**：typecheck EXIT=0；全量 **76 mutations / 0 failed / EXIT=0**；`baseline: GREEN` + `restored: GREEN`；`npm run test:ios` EXIT=0（结构门禁 **223 checks / 0 failed**）。 |

---

## 二、为什么不是"按突变 `target` 求交集"

`target` 是"这条突变**改写**了哪个文件"。用它求交集会复发 2026-09-24 早先那个坑：新增断言会让
**指向别的文件**的突变 `assertion_hit=False`（route 的有损用例进了水位那个编译单元 ⇒ "批量写不再
BEGIN IMMEDIATE"变成红在别人的断言上）。

⇒ 正确的量是**门禁的输入面**：改动文件落在某个门禁读/编译的文件里，**该门禁名下全部突变**都要跑。

## 三、实现

`apps/ios/tests/check-background-mutations.py`：

- **输入面现场算，不存手写表**（手写表的失效方式是静默的：新增输入、表没更新 ⇒ 漏跑）：
  - bash 门禁：静态解析脚本里点名的仓库内路径（注释里的也算 —— 保守方向）；
  - python 门禁：另起子进程跑一遍，用 **`sys.addaudithook` 抓 `open` 事件**得到它真正读了哪些
    仓库内文件。子进程**清空 `RAI_MUTATION*` 环境变量**以杜绝递归，并**吞掉门禁自己的 stdout**
    （否则人的报告会和 JSON 混在一条流里）。
- 目录条目按**前缀**匹配（`git status` 对"整目录未跟踪"只报目录名，与文件路径求交集恒为空 ⇒ 静默漏选）；
  `git` 模式用 `-uall` 展开；重命名条目**两侧都收**。
- 产物：`"partial": bool(selector or raw_scope)`、新增 `"scope": {changed, gates}`；空范围时
  `restored.skipped = "no mutation was applied"`。

**成对守卫**（`apps/ios/tests/check-background-capabilities.py` §7，+3 条）：入口在 /
`partial` 由 scope 一并置位 / 空范围必发声。`MIN_CHECKS` **216 → 222**。

### 用法

```bash
npm run test:ios:mutation:scope                  # = RAI_MUTATION_FOR=git，取当前工作区改动
RAI_MUTATION_FOR=apps/ios/RAI/SyncTaskStore.swift npm run test:ios:mutation
npm run test:ios:mutation                        # 全量（验收用）
```

## 四、门禁输入面（实测，裁剪的粒度上限）

| 门禁 | 输入文件数 | 备注 |
| --- | --- | --- |
| `check-background-capabilities.py` | **75** | 含**全部 46 个 `apps/api/src/*.ts`** + 17 个 iOS 源 + `package.json` + 门禁脚本 |
| `run-health-sync-tests.sh` | 23 | 13 次 `swiftc`，串行 |
| `run-tech-presentation-tests.sh` | 15 | |
| `check-export-determinism.py` | 3 | |

## 五、裁剪效果（实测选中数；耗时按单次门禁实测单价推算）

| 改动场景 | 选中 | 命中门禁 | 预估耗时 |
| --- | --- | --- | --- |
| `apps/web/**`、`packages/**`、`crates/**` | **0/76** | （无） | ~40s |
| `apps/ios/RAI/Skins/Technology/TechTheme.swift` | 3/76 | presentation | ~2.5min |
| `apps/ios/RAI/HealthKitSync.swift` | 45/76 | capabilities | ~6min |
| `apps/api/src/server.ts` | 45/76 | capabilities | ~6min |
| `apps/ios/RAI/HealthKitExport.swift` | 51/76 | capabilities + export | ~7min |
| `apps/ios/RAI/SyncTaskStore.swift` | 67/76 | health-sync + capabilities | ~9.5min |
| **全量** | 76/76 | 全部 | **10m15s**（实测） |

## 六、验证证据

| 项 | 证据 |
| --- | --- |
| 空范围端到端 | `scope: none of the 4 mutation gates reads any of these files` → `baseline: GREEN` → `NO MUTATION TOUCHES THE CHANGED FILES` → `mutation check (PARTIAL, scope=1 changed file(s)): 0 of 76` → **EXIT=0**；产物 `partial: true`、`restored.skipped` |
| 皮肤范围端到端 | **3 of 76**；三条均 `RED` + `assertion_hit=True`；负向对照 `COMPILE-ERROR`；`restored: exit=0 GREEN`；**EXIT=0** |
| 全量（未变） | `typecheck` **EXIT=0**；**76 mutations, 0 failed**，`baseline: exit=0 GREEN`、`restored: exit=0 GREEN`，**EXIT=0** |
| iOS 全门禁 | `npm run test:ios` → `iOS 门禁通过（类型检查 + 纯逻辑回归）`，**EXIT=0**；`Background capability checks: 223 checks, 0 failed`；`Export determinism checks: 14 checks, 0 failed`；类型检查 55 文件 |
| 守卫**突变到红** | 三条各产生 **1 条具名 FAIL**、exit 1：`a scoped mutation run no longer marks its summary partial` / `lost its scope filter (RAI_MUTATION_FOR)` / `an empty scope must announce itself loudly`；还原后源码 **sha256 一致** |
| 目录/前缀匹配 | `apps/ios/RAI` → 76/76（保守，正确）；`.` → 76/76；精确路径行为不变 |
| 还原正确性 | 受管源码只剩他原本那 2 个 iOS 改动；`var/mutation-backup/IN-PROGRESS` 已清 |

⚠️ **口径说明**：全量那一次是在 `in_scope`（前缀匹配）改动**之前**启动的独立进程。
`diff` 证明 `in_scope` 只落在裁剪分支内（新增模块级函数 + `scope_changed_paths` + `if raw_scope:`
内的选门禁一行）⇒ 全量路径的结论对该改动仍然成立；裁剪路径已在改动后重跑通过。

## 七、刻意不做 / 残余

- **不做并行**：整轮串行（实测 75% cpu ≈ 单核）。受"原地改写同一棵树"制约，需 N 份 worktree，
  收益 ~4–5× 但复杂度和风险都高。**不建议**。
- 🟡 **真要再快只剩一条路**：让 `run-health-sync-tests.sh` 的 13 次 `swiftc` **内部并行**。
  那是改判据门禁本身（`set -e` 语义、失败输出交错、资源竞争都要重做），需单独确认后再动。
- 🟡 `deliverables/..._MUTATION_SUMMARY_2026-09-23.json` 的 `sources` 摘要已落后于当前源码
  （他本轮改过 `SyncStateCommitPlan.swift` / `SyncTaskStore.swift`）。要刷新锚点就带
  `RAI_MUTATION_JSON=` 跑一次全量（10min），**不是必须**。
- ⚠️ 裁剪跑**永远**不能替代验收；`partial: true` 与措辞分叉是唯一的防线，已用三条守卫钉住。
