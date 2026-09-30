# RAI · Phase 2 T1 变异验证证据包（2026-09-23）

> **这是什么**：`deliverables/RAI_HK_BACKGROUND_V21_PHASE2_T1_2026-09-23.md` §7.2 / §7.3 的**证据附件**。
> 主报告给结论，本文件给"结论赖以成立的那一份读数"——判决分布、逐条期望断言、还原证明，以及
> 一条**反直觉的实测发现**（§5）。
>
> **本文件刻意不含**：全量原始日志（约 12 KB、含各门禁 tail 片段）。理由见 §7。
>
> 配套机器可读产物：`deliverables/RAI_HK_BACKGROUND_V21_PHASE2_T1_MUTATION_SUMMARY_2026-09-23.json`

---

## 0. 结论先行

| 结论 | 读数 | 证据强度 |
| :--- | :--- | :--- |
| 全量突变 | `mutation check: 74 mutations, 0 failed` | **实测**（本轮复跑，`FULL_EXIT=0`） |
| 判决分布 | `{RED: 74, COMPILE-ERROR: 1}` | **实测** |
| 断言命中 | `assertion_hit=True` × 74 | **实测** |
| 负向对照 | `verdict=COMPILE-ERROR`（`resolved_by="ran"`，非模式过期跳过） | **实测** |
| 跑前基线 | `baseline: exit=0 GREEN` | **实测** |
| 跑后还原 | `restored: exit=0 GREEN`；18 个受管文件 **18/18 逐字节一致**（两路独立验证） | **实测** |
| 本轮新增突变 | **12** 条（`[本轮新增2]`） | **实测** |
| 门禁条数 | `217 checks, 0 failed`——**新增交付文件之前与之后各跑一次** | **实测** |
| 突变总数 | 62 → **74**（+12） | **实测** |
| 反直觉发现 | 去掉 `BEGIN IMMEDIATE` 后**报失败、行却已落盘**（§5） | **实测 + 代码级追踪** |

---

## 1. 命令、耗时与产物

```bash
# 本轮实际执行的命令（含 JSON 摘要输出）
RAI_MUTATION_JSON=/tmp/rai-mutation-summary-2026-09-23.json \
  python3 apps/ios/tests/check-background-mutations.py
```

| 项 | 值 |
| :--- | :--- |
| 退出码 | `0` |
| 宿主机耗时 | **6m 54s**（留档产物来自的这一次；前一次同命令为 6m 25s，差异在 30s 级属正常抖动） |
| 判决行数 | 75（74 条突变 + 1 条负向对照） |
| `BAD` 行 | **0** |
| 产物 | 本文件 + `…_MUTATION_SUMMARY_2026-09-23.json`（**37,868 字节**） |

**产物指纹**（用于日后确认"手里这份就是这份"）：

```
sha256(deliverables/RAI_HK_BACKGROUND_V21_PHASE2_T1_MUTATION_SUMMARY_2026-09-23.json)
  = 02f478d55b3d1dcf7dfefa979a2b8d8eaf06676a004c1ab840acbe38d6d52e18
```

JSON 里的 `command` 字段记录的是**实际执行过的那条命令**（相对路径形态），
与 §9 的复现命令逐字一致——这是刻意的：留档的命令必须是你照着能跑通的那一条。

> 📌 这条 JSON 是由 harness **原生**产出的（不是事后从日志改写），因为脚本此前**没有**
> 任何机器可读输出。为此给 `check-background-mutations.py` 加了 `RAI_MUTATION_JSON=<路径>`
> 开关（约 90 行，见 §10 回滚表）：**不设该变量时行为与改动前完全一致**。
> 为验证这一点，本轮跑了**两次完整的全量**（各 6 分半）：
> ① 带绝对路径 `/tmp/...`（验证绝对路径分支）；② 带相对路径写入交付目录（验证相对路径分支，
> 即本次留档的产物）。此外还有**一次未跑完**的运行被信号强杀——它不算证据，只意外验证了
> 中断恢复路径（见 §6.4）。

> 🔴 这个脚本**原地改写源码再还原**，且**没有 `--help`**：任何未知参数会被忽略并启动全套。
> 输出必须重定向到文件（**不要接 `head`**，管道关闭会打断它并留下被污染的源码）。

---

## 2. 判决分布：为什么有 75 行而"突变数"是 74

两个数字都对，但**口径不同**，混读会得出"数字对不上"的错误结论：

- `MUTATIONS` = **74** 条 → 末尾那行 `mutation check: 74 mutations, 0 failed` 只数它；
- `NEGATIVE_CONTROL` = **1** 条 → 它同样以 `OK` 前缀打印，也占一行 `verdict=`；
- 所以日志里 `verdict=` 共 **75** 行：`RED × 74` + `COMPILE-ERROR × 1`。

JSON 里把两者**分开表达**，避免下一轮再产生同样的歧义：

```json
"totals": {
  "mutations_defined": 74,
  "mutations_selected": 74,
  "failed": 0,
  "verdict_distribution": { "RED": 74, "COMPILE-ERROR": 1 }
}
```

`verdict_distribution` 覆盖**每一条跑过的条目**（含负向对照），因此与日志 `verdict=` 行数逐一对得上。

---

## 3. 负向对照：为什么它必须在

`classify()` 的顺序是「先看编译错误，再看断言」。如果它把编译错误吃成 `RED`，
"这 74 条突变里没有一条其实是编译错误"这个结论就**从未被排除**——分类器本身没被验证。

对照动作：把 `SyncPhase.terminal` 的数组字面量删掉右括号，制造一个**真正的语法错误**。
期望：`COMPILE-ERROR`，**不是** `RED`。

本轮读数（JSON `negative_control`）：

```json
{
  "name": "负向对照: 制造一个真正的编译错误（数组字面量缺右括号）",
  "target": ["apps/ios/RAI/SyncPhase.swift"],
  "gate": "bash apps/ios/tests/run-health-sync-tests.sh",
  "verdict": "COMPILE-ERROR",
  "exit": 1,
  "resolved_by": "ran",
  "ok": true,
  "expected_verdict": "COMPILE-ERROR"
}
```

`resolved_by="ran"` 是刻意加的字段：对照也可能**因为模式过期而被跳过**，那种情况下
`verdict` 会由 `code=0, out=""` 兜底算出，看着一样是 `COMPILE-ERROR`，但其实什么都没验证。
把它与"真的跑了"分开，是这条对照唯一可能静默失效的地方。

---

## 4. 本轮新增的 12 条（`[本轮新增2]`，逐字）

"期望红在哪条断言"一列是脚本里 `needle` 的**逐字原文**（不是转述）——
判据是"输出里必须出现这句话"，所以它必须可复制粘贴。

| # | 破坏动作 | 目标文件 | 门禁 | 期望命中的断言消息（逐字） | 实测 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 63 | 每 workout 循环里去掉 `shouldQuery` 过滤（写成 `if true`） | `RAI/HealthKitExport.swift` | PY | `no longer consults the state machine` | RED / hit |
| 64 | 把降频记忆挪到 `commitSuccess` **之前** | `RAI/HealthKitSync.swift` | PY | `the route memory is flushed BEFORE the watermark commit` | RED / hit |
| 65 | manifest `sourceScope` 改成 `full-snapshot` | `RAI/HealthKitExport.swift` | PY | `no longer declares sourceScope healthkit` | RED / hit |
| 66 | 导出前不再读伴生状态快照 | `RAI/HealthKitSync.swift` | PY | `no longer loads the route state snapshot` | RED / hit |
| 67 | `routeForceRescan` 不再接 `full` | `RAI/HealthKitSync.swift` | PY | ``the manual-rescan flag is not wired to `full` `` | RED / hit |
| 68 | 删掉批量写的事务内回读断言 | `RAI/SyncTaskStore.swift` | PY | `pre-COMMIT read-back assertion is gone from the route state batch` | RED / hit |
| 69 | 跳过的那一轮也把 `lastCheckedAt` 盖上「现在」 | `RAI/RouteSyncStateMachine.swift` | SWIFT | `a skipped round carries the record over byte for byte` | RED / hit |
| 70 | `cooling` 的 12 小时节流改成恒真 | `RAI/RouteSyncStateMachine.swift` | SWIFT | `just under 12h the cooling route is skipped` | RED / hit |
| 71 | 批量写不再 `BEGIN IMMEDIATE` | `RAI/SyncTaskStore.swift` | SWIFT | `a batch of three distinct workouts writes in one transaction` | RED / hit |
| 72 | 反孤儿：从 `run-health-sync-tests.sh` 摘掉 `RouteSyncStatePersistenceRegression` | `tests/run-health-sync-tests.sh` | PY | `does not compile/run RouteSyncStatePersistenceRegression.swift` | RED / hit |
| 73 | 反孤儿：从 `run-health-sync-tests.sh` 摘掉 `RouteSyncStateMachineTests` | `tests/run-health-sync-tests.sh` | PY | `does not compile/run RouteSyncStateMachineTests.swift` | RED / hit |
| 74 | 判据：从 `run-store-tests.sh` 摘掉 `RouteSyncState.swift` | `tests/run-store-tests.sh` | PY | `run-store-tests.sh compiles SyncTaskStore.swift without RouteSyncState.swift` | RED / hit |

**门禁代号**：`PY` = `python3 apps/ios/tests/check-background-capabilities.py`；
`SWIFT` = `bash apps/ios/tests/run-health-sync-tests.sh`。

**这 12 条为什么挑它们**：它们覆盖的是两类**不报错、不崩溃、却让改造白做**的失效——
① 降频收益归零（63/66/70）；② 数据静默丢在服务端之外或永久不再被唤醒（65/67/69）；
③ 判据自身变成空转（68/72/73/74）。第 64 条最凶：它会造出一个**不可自愈**的窗口。

---

## 5. 🔴 一处反直觉实测：报失败，但行已经落盘

这是本轮最值得留档的一条，因为**只有跑过才知道**，读代码时极容易推出相反结论。

### 5.1 期望与实际的偏差

我最初预期的红点是「整批回滚」那一条断言。**实际红在"写入是否报成功"那一条上。**

逐字输出（单条复现，`exit=132`）：

```
[RAI] SQLite sync journal route state commit failed (code 1)
main/RouteSyncStatePersistenceRegression.swift:25: Precondition failed: a batch of three distinct workouts writes in one transaction
```

> `:25` 是 `check()` 内部的 `precondition(condition(), name)` 那一行——**所有**断言都从这一行红出来，
> 所以报出的行号是助手函数，不是调用点。对应调用点在
> `RouteSyncStatePersistenceRegression.swift:71`。

### 5.2 为什么（代码级追踪，`SyncTaskStore.upsertRouteStates`）

把 `:455` 的 `BEGIN IMMEDIATE` 换成 `SELECT 1` 之后，实际发生的是：

| 步骤 | 位置 | 行为 |
| :--- | :--- | :--- |
| 1 | `:455` | "开启事务"变成一条无害查询 ⇒ **根本没有事务在跑** |
| 2 | `:476-509` | 3 条 `UPSERT` 各自在 autocommit 下**逐条提交** ⇒ **行已经落盘** |
| 3 | `:518-532` | 事务内回读——读到的是自己刚写下的行 ⇒ **通过**（日志里没有 `read-back mismatch`） |
| 4 | `:533` | `COMMIT` 失败：SQLite 报 `no transaction is active` ⇒ `fail("route state commit")` ⇒ **`return false`** |
| 5 | `:459-461` | `defer` 里的 `ROLLBACK` 同样失败（没有事务可回滚），静默 |

**关键证据**：日志里出现的**唯一**一条 report 是 `route state commit failed (code 1)`。
第 3 步如果回读失败会打 `route state read-back mismatch`；第 2 步若 `sqlite3_changes` 不为 1
会打 `route state upsert touched N row(s)`。两条都没出现 ⇒ **回读成功 ⇒ 行确实已经在盘上**。

⇒ 于是 `return false` 的含义被污染了：它同时可能是
（a）"什么都没写"，也可能是（b）"**全写了，只是最后一句 COMMIT 没成功**"。
调用方无法区分。

### 5.3 这对**现有代码**意味着什么（不是缺陷，但要写下来）

`HealthKitSync.markSuccess` 对这条返回值的处理是"打日志、不让同步变红"：

```swift
if !routeStates.isEmpty, !taskStore.upsertRouteStates(Array(routeStates.values)) {
    NSLog("[RAI] route state flush after commit failed: %@", taskStore.lastError ?? "unknown")
}
```

两种世界下的后果**都安全**，所以这不是缺陷：

- 情形（b）行已落盘：下一轮会读到这些行并按 `cooling` / `settled` 正常降频——只是日志说"失败"，
  与实际不符（**假阴性**，无功能后果）；
- 情形（a）行未落盘：下一轮把这些 workout 当首查，多查一次——安全方向。

⇒ 结论：**返回值的语义弱于它的字面**。将来若有人把 `false` 当作"这次写入已回滚、可以安全重放"
的依据（例如据此决定要不要重传载荷），就会踩坑。本文件的作用就是在那一刻之前留下证据。

### 5.4 处置

突变条目的**描述与期望消息已按实测改正**（`assertion_hit=True`），并且把上面这段原因
逐字写进了脚本里那条突变的说明——它现在也随 `…_SUMMARY_2026-09-23.json` 的
`mutations[70].name` 一起进入仓库，下一轮 diff 得到。

---

## 6. 还原证明：18/18 逐字节一致（两路独立）

### 6.1 方法

harness 在跑之前把 `SOURCES`（**18** 个文件）复制到 `var/mutation-backup/`，跑完 `restore()` 再写回。
于是"还原是否完整"是一个可判定的字节问题，而不是一句自我报告。

> ⚠️ `var/` 在 `.gitignore` 里 ⇒ 备份目录**不随仓库走**。所以除"当场比对"之外，
> 本轮把跑前哈希写进了 JSON 的 `sources[]`（18 条），让**仓库自身**也能承担这条证明。

### 6.2 实测（跑完立即执行，两路独立）

| 路 | 比对对象 | 读数 |
| :--- | :--- | :--- |
| **(A)** | 当前工作区 18 个文件 vs `var/mutation-backup/`（harness 自己的跑前副本） | **18 / 18 一致** |
| **(B)** | 当前工作区 18 个文件 vs JSON `sources[]` 里的跑前 sha256 | **18 / 18 一致** |

(B) 的意义：**不需要备份目录**也能复核——把仓库里的 JSON 拿出来，逐条 `sha256sum` 当前文件即可。
下一轮若 (B) 出现非零差异，说明"某个受管文件在两次运行之间被动过"，
所有跨轮结论（"从 RED 变 STILL-GREEN"之类）在那之前都不可比。

### 6.3 一条**被更正**的旧断言（时效性）

主报告 §7.3 写着「18 个受管文件与跑前备份的 SHA-256 逐一比对：`mismatch: 0 of 18`」。
那句**对它的时间点（15:52 还原那一刻）成立**，但三小时后再比会出现 **2 处差异**：

| 文件 | 原因 |
| :--- | :--- |
| `RAI/HealthKitExport.swift` | 15:52 之后补的 `routeCount` 语义文档注释 |
| `RAI/HealthKitSync.swift` | 同上（消费点处的说明） |

逐行 `diff` 已核对：**全部差异行都是注释行**（`///` / `//`），**无一行可执行代码**。
⇒ 还原本身是逐字节完整的；工作区相对跑前基线的全部偏差，来自这次有意的注释补充。

处置：主报告 §7.3 **保留原文不改写**（那句对它的时间点是对的），只在其下补一段时效性说明，
指向本文件的 §6。

### 6.4 辅助判据（同一轮内）

- `var/mutation-backup/IN-PROGRESS` 标记已清（`finish()` 的职责）；
- 关键锚点复位：`RouteSyncStateMachine.shouldQuery(` ×1、`routeForceRescan: full,` ×1、
  `RouteSyncState.swift` 出现在 store runner 内 ×1；
- 还原后 `check-background-capabilities.py` → `217 checks, 0 failed`。
- 🟢 **中断-恢复路径实测通过**（非刻意构造，是意外获得的证据）：撰写本文件期间有一次运行被
  信号强杀（退出码 137 = SIGKILL ⇒ 信号处理器**没有**机会执行），源码树理应停在污染态。
  下一次启动时 harness 的输出是：

  ```
  recovered: a previous run was interrupted; restoring 18 sources from /Users/tp/running/var/mutation-backup
  no mutation matched RAI_MUTATION_ONLY='无匹配过滤器'; nothing to do
  ```

  随后 `IN-PROGRESS` 被清、18/18 文件与跑前哈希一致 ⇒ **SIGKILL 场景下"下一次运行不会在
  被污染的树上做基线检查"这条判据成立**（它此前只是设计意图）。

---

## 7. 为什么不把原始全文日志放进仓库

日志的价值在于"每一步的原文可复现"，而它的成本是：约 12 KB、内容逐轮刷新（
`generated_at`、tail 片段里的绝对路径与行号都会变）⇒ **每轮都是一次全量 diff**，
却几乎不携带跨轮可比的信号。

所以拆开：**能跨轮比的**进仓库（本文件 §0-§6 的读数 + JSON），**逐字原文**留在本地／CI artifact。
如果哪天真出现"证据必须逐字可复现"的合规要求，再补一次归档即可——
harness 本身没有随机性（无网络、无时间依赖），重跑就能原样复现。

---

## 8. 提交前的判据排查（本次新增文件是否会影响门禁）

> 上一轮刚在"锚点计数"上吃过亏，所以这一步按纪律做完才提交。

| 排查项 | 方法 | 结论 |
| :--- | :--- | :--- |
| 门禁是否遍历 `deliverables/` | 全库 grep `deliverables` / `docs/` / `rglob` / `glob` | **零引用**。门禁只遍历 `apps/api/src/**/*.ts`（`:493`）与 `apps/ios/tests/*.sh`（`:1456`） |
| 是否有"未预期文件"类判据 | 同上 + 人工读 §10k / §14i / §15 | 无。判据总数由**固定断言 + `.sh` 迭代**决定，本次未新增 `.sh` |
| 门禁条数是否变动 | 新增文件**前后各跑一次** | 两次均 `217 checks, 0 failed` |
| 是否会撞上变异锚点 | 本次未改任何 `SOURCES` 内的可执行行（仅 §5 的临时复现已还原并验证哈希） | **不撞** |
| 是否有脚本读该目录 | 全仓 grep `deliverables` | 仅 2 处**注释**（`apps/api/test/native-import-worker.test.ts:63`、`packages/application/src/services/recompute-pipeline.ts:212`） |

---

## 9. 复现步骤

```bash
cd /Users/tp/running

# 1) 全量变异 + 原生 JSON 摘要（约 6.5 分钟，原地改写源码后自动还原）
RAI_MUTATION_JSON=deliverables/RAI_HK_BACKGROUND_V21_PHASE2_T1_MUTATION_SUMMARY_2026-09-23.json \
  python3 apps/ios/tests/check-background-mutations.py | tee /tmp/mutation.log

# 2) 判据：末行必须是
#    mutation check: 74 mutations, 0 failed
#    restored: exit=0 GREEN          ← 并且 FULL_EXIT=0

# 3) 还原复核（路 B：只依赖仓库内容）
python3 - <<'PY'
import json, hashlib, pathlib
d = json.load(open("deliverables/RAI_HK_BACKGROUND_V21_PHASE2_T1_MUTATION_SUMMARY_2026-09-23.json"))
bad = [s["path"] for s in d["sources"]
       if hashlib.sha256(pathlib.Path(s["path"]).read_bytes()).hexdigest() != s["sha256"]]
print("mismatch:", bad or "0 of %d" % len(d["sources"]))
PY

# 4) 分段跑只用于加新条目时省时间；**不是验收手段**（输出会打印 PARTIAL）
RAI_MUTATION_ONLY='本轮新增2' python3 apps/ios/tests/check-background-mutations.py
```

---

## 10. 回滚

| 对象 | 回滚方式 |
| :--- | :--- |
| 本文件 + JSON | 直接删除（纯新增，无其他文件引用） |
| 突变脚本的 JSON 输出能力 | 删除 `emit_json` / `source_digests` / `_edited` 与 `RAI_MUTATION_JSON` 分支；**不设该环境变量时行为与改动前完全一致**（默认路径不写文件、不打印） |
| 源码被突变污染 | `cp -a var/mutation-backup/. <对应目录>`，或按 JSON `sources[]` 的 sha256 逐个核对 |
| 卡在污染态无法启动 | `var/mutation-backup/IN-PROGRESS` 存在时 harness 会先自还原；也可手工删掉该标记后从 git 恢复 |

---

## 11. 明确无法确认的事

1. **真机行为**：本包全部读数为 macOS 宿主机上的 `xcrun swiftc` 编译 + 运行结果。
   模拟器/真机的 HealthKit 投递、后台唤醒、`HKWorkoutRouteQuery` 的实际节流行为**不在覆盖范围内**。
2. **`assertion_hit` 是子串判定**：它证明"输出里出现了预期那句话"，
   不证明"只出现了那一句"。同一句被别处顺带打印出来的可能性存在（本轮未观测到）。
3. **逻辑错误的覆盖上限**：74 条突变只覆盖**被显式写下的**失效模式。
   "两条判据相互掩盖"（单改一条各自都不红）这类**组合失效**不在覆盖内——
   本包不能声称"改坏了就一定红"。
4. **§5.3 的安全结论是推理**：`returns false` 的两种世界下后果都安全，是**读调用点 + 读实现**推出来的，
   没有构造"行已落盘但返回 false 之后紧接着再同步一次"的端到端实验。
