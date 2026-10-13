# 直连增量同步 PR6：本机可执行判据、真机验收清单与对抗性复核

- 日期：2026-10-13（Asia/Shanghai）。**验收与证据**角色（task-4，owner `verification`）。
- 基线 commit：`89011f4`（工作树含未提交在制品：T1/T2/T3 本轮交付，T5 进行中）。
- 本机：Windows 11（`MINGW64_NT-10.0-26100`）、Node **v22.23.1**、npm **10.9.8**、Python **3.12.10**。
- ⛔ **本机没有 `swiftc`、没有 Xcode、没有 iPhone/Simulator、没有 `python3`（只有 `python`）**。
- 上位文档：`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §10.1（324–342）、§10.2（344–352）、§10.3（354–366）、
  §14.2 A07（487）、§14.5（530–544）。

> ⚠️ **本文件不是"验收通过"声明。** 它只回答：**哪一部分在今天这台机器上真的被证明了，
> 哪一部分只能到 macOS 或真机上才能证明。** 每个"通过"都附命令与真实输出；没跑过的一律写
> **未执行**。本机没有设备 ⇒ **不存在任何"真机已验收"的结论**。

## 0. 一句话结论

| 判据通道 | 本机能不能跑 | 今天的实测结果 |
|---|---|---|
| `npm run typecheck` | ✅ | **EXIT=0**（中途一度 EXIT=2：T5 在制品里的类型错误，T5 修复后复跑到绿，§2.1） |
| `node scripts/run-tests.mjs`（`RAI_TEST_CONCURRENCY=1`） | ✅ | **EXIT=0**：`# tests 1735 / # pass 1715 / # fail 0 / # skipped 20` + Web `184 passed`（§2.2） |
| `npm run build` | ⚠️ 能跑，但**默认 `%TEMP%` 下环境性失败** | 默认：EXIT=1（esbuild 临时文件 `Access is denied`）；把 `TEMP` 指到工作区内：**EXIT=0，`✓ built in 8.42s`**（§2.3） |
| T1 定向：`direct-sync-handshake-capability.test.ts` | ✅ | **4/4 ok，EXIT=0**（§2.4） |
| `write-lease.test.ts`（定向复跑） | ✅ | **6/6 pass，EXIT=0**（§2.5） |
| `check-export-determinism.py` | ✅ | **14 checks / 0 failed，EXIT=0** |
| `check-background-capabilities.py` | ✅ | **274 checks / 1 failed，EXIT=1**（既有失败，§8.1） |
| 新增 `check-direct-sync-status-copy.py` | ✅ | **48 checks / 0 failed，EXIT=0**（§3.1） |
| 新增 `check-direct-sync-contract-parity.py` | ✅ | **13 checks / 0 failed，EXIT=0**（§3.2） |
| T5 新增 `check-direct-sync-analysis-reconcile.py` | ✅ | **43 checks / 0 failed，EXIT=0**（§3.3，本机真跑；T5 的交付） |
| T5 服务端用例 `direct-sync-analysis-reconcile.test.ts` | ✅ | **3/3 pass，EXIT=0**（§2.5） |
| `direct-sync-ingest.test.ts`（T5 改动后复跑） | ✅ | **11/11 pass，EXIT=0**（§2.5） |
| `check-today-layout.py` / `check-healthkit-record-sync.py` | ❌ **本机崩溃** | `UnicodeDecodeError`（GBK），见 §8.2 |
| `npm run test:ios` | ⚠️ **显式跳过** | EXIT=0 + "本次没有检查任何 iOS 源码"（§5.1）——**跳过不是通过** |
| iOS 纯逻辑回归（T2 的 `DirectSyncReceiptRegression.swift`） | ❌ 只有 macOS | **未执行**（§5.2） |
| 真机 HealthKit 增量/续传/文案 | ❌ 无设备 | **未执行**（§6 人工清单） |
| P01–P06、A12/A13 真并发时序 | ❌ 不可达 | **未执行，且本批次不宣称**（§7） |

**本轮新增的执行者**：两支新门禁把 §14.2 **A07 / A17** 中此前"只有文档、或只有一条源码文本门禁"
的部分，变成了在**本机真被执行**的判据（逐条见 §3）。

## 1. 方法（如何复跑）

根目录 `D:\running`；Windows 上的 `python` 即本仓 macOS 脚本里的 `python3`。
突变探针跑在**仓库的临时镜像副本**上（`%TEMP%\pr6-mirror`），**全程未改动任何实现文件**；
每次探针前镜像与真实树的基线与真实树输出一致（同一条命令、同一个失败数），探针后立即还原并复跑基线。
脚本级证据落盘在 `var/reports/`（`pr6-node-tests.log`、`pr6-build*.log`）。

## 2. 本机已实测的命令

### 2.1 `npm run typecheck`

**会话开始时（T5 的文件尚未落地）—— EXIT=0**：

```
> rai-running-intelligence@0.1.0 typecheck
> tsc --noEmit -p tsconfig.pure.json && tsc --noEmit -p tsconfig.json

TYPECHECK_EXIT=0
```

**本轮取证结束时（工作树含 T5 的在制品）—— 一度 EXIT=2**：

```
apps/api/test/direct-sync-analysis-reconcile.test.ts(192,11): error TS2769: No overload matches this call.
  Overload 1 of 2, '(...anonymousParameters: SQLInputValue[]): Record<string, SQLOutputValue> | undefined',
  gave the following error.
    Argument of type 'string | null | undefined' is not assignable to parameter of type 'SQLInputValue'.
      Type 'undefined' is not assignable to type 'SQLInputValue'.
TYPECHECK_EXIT=2
```

**成因与处置（完整链条，不省略）**：`apps/api/test/direct-sync-analysis-reconcile.test.ts:111` 的
`const jobId = applied.summary.analysisJobId` 类型是 `string | null | undefined`
（合同 `packages/api-contracts/src/index.ts:587` 是 `analysisJobId?: string | null`），
`:190-192` 直接把它喂给 `.get(jobId)` ⇒ `tsc` 拒绝。
**这条只有 `tsc` 看得见**：`node --import tsx --test` 走 tsx **剥类型**（同一文件 3/3 绿，§2.5），
python 结构门禁只读源码文本 —— 两类"看起来在验证"的通道都看不见它。
**已上报 T5（owner）并同时报 Lead；T5 修复后我复跑到 EXIT=0。**

**最终冻结态**：

```
> npm run typecheck
（无 error TS 输出）
TYPECHECK_EXIT=0
```

⇒ §14.5 的 typecheck 项在**冻结时点**成立；这次红灯的价值在于它证明
**"跑了测试"与"过了类型检查"是两条独立的判据**，少跑一条就会漏掉一个真实回归。

### 2.2 `node scripts/run-tests.mjs`

```
$env:RAI_TEST_CONCURRENCY="1"; node scripts/run-tests.mjs
# tests 1735
# pass 1715
# fail 0
# cancelled 0
# skipped 20
 Test Files  25 passed (25)
      Tests  184 passed (184)
TESTS_EXIT=0
```

⚠️ **如实记录同一命令的两次结果**：第一次全量 **EXIT=1**，但我当时用 `Select-Object -Last 40`
只留了尾部（Web 段），**具体失败项没有留存**——这是我取证方法的缺陷，不是"本来就没失败"。
随后用同一并发口径（`RAI_TEST_CONCURRENCY=1`）复跑并全量落盘，得到上面的 **EXIT=0 / fail 0**。
两条都写在报告里；**不宣称**"第一次的失败已归因"。

### 2.3 `npm run build`（环境性失败，与代码无关）

**默认环境**：

```
> npm run build
vite v7.3.6 building client environment for production...
✓ 763 modules transformed.
✗ Build failed in 7.30s
error during build:
[vite:esbuild-transpile] remove C:\Users\Administrator\AppData\Local\Temp\esbuild-92049e77...: Access is denied.
BUILD_EXIT=1
```

**把 `TEMP`/`TMP` 指到工作区内**（`D:\running\var\tmp`）：

```
$env:TEMP="D:\running\var\tmp"; $env:TMP="D:\running\var\tmp"; npm run build
✓ 763 modules transformed.
✓ built in 8.42s
BUILD_WITH_WORKSPACE_TEMP_EXIT=0
```

**归因证据（三步）**：①失败点是 esbuild 删除**它自己刚写的临时文件**，不是编译错误（763 模块已转换完成）；
②清空 `%TEMP%\esbuild-*` 后重跑，换成新的 hash 文件仍然 `Access is denied` ⇒ 不是陈旧文件；
③Node 自己能在 `%TEMP%` 创建并删除文件（`node create+unlink OK`）⇒ 不是整个用户临时目录被禁，
而是**esbuild 子进程**的删除被拒。**结论：构建产物本身没问题，失败是本机临时目录权限/进程环境问题。**

**边界**：我**没有**做改动前的基线对照，因此**只**说"失败形态与代码无关"（失败点在无关目录的临时文件删除），
**不宣称**"证明与代码完全无关"。任何人在这台机器上跑 `npm run build` 都会看到同一现象，
复跑时按上面的 `TEMP` 重定向即可拿到真实构建结论。

### 2.4 T1 的握手能力位用例（定向）

```
node --import tsx --test --test-concurrency=1 apps/api/test/direct-sync-handshake-capability.test.ts

ok 1 - 真实 /v1/handshake 宣告 factsAnalysisContractVersion=1，且既有能力位一个不少、取值不变
ok 2 - HandshakeResponse 上能力位必须声明为可选：改成必填会让老客户端 decode 失败
ok 3 - 老客户端视角：不带能力位也能构造出合法 HandshakeResponse
ok 4 - 能力位的字面量在服务端源码里只有一处，且就是握手响应那一处
# tests 4 / # pass 4 / # fail 0
HANDSHAKE_EXIT=0
```

### 2.5 三方直连相关用例的定向复跑（**最终冻结态**，本机真跑）

```
node --import tsx --test --test-concurrency=1 apps/api/test/write-lease.test.ts
# tests 6 / # pass 6 / # fail 0 / # skipped 0        EXIT=0

apps/api/test/direct-sync-analysis-reconcile.test.ts   # 3 / 3 pass   EXIT=0   ← T5 新增
apps/api/test/direct-sync-handshake-capability.test.ts # 4 / 4 pass   EXIT=0   ← T1 的用例，T5 改过该文件后仍绿
apps/api/test/direct-sync-ingest.test.ts               # 11 / 11 pass EXIT=0   ← T5 改 analysisJobId 后复跑
apps/api/test/import-worker-direct-sync.test.ts        # 2 / 2 pass   EXIT=0
apps/api/test/data-only-import.test.ts                 # 29 / 29 pass EXIT=0   ← T5 补过 2 条断言（见 §3.3 末尾）
```

**关于 `write-lease.test.ts` 的如实口径**：本机**单跑 6/6 绿**、并发=1 的全量 **fail 0**；
Lead 的并发全量里它曾报红（`write-lease.test.ts:229` 墙钟时序判据）。我这边**没有**取得
"改动前基线"的对照，因此只能说：**这是本仓已知的负载抖动形态，本次证据未显示与本批的因果链，
但不宣称"证明无关"。**

### 2.6 两条既有 python 门禁

```
> python apps/ios/tests/check-export-determinism.py
Export determinism checks: 14 checks, 0 failed          EXIT=0

> python apps/ios/tests/check-background-capabilities.py
FAIL: package.json has no script entry for check-background-mutations.py — the harness would be an orphan
Background capability checks: 274 checks, 1 failed       EXIT=1
```

**结论**：那 1 条是**既有**的（T2 独立跑出同一结果），本批次**未新增失败项**；
它同时证明这条门禁在本机**真的会红**（不是恒绿）。

### 2.7 任务书锚点与实际代码的偏离（Lead 裁定 B）

T1 按**实际代码**落地，并点名三处任务书锚点过期。我逐条复核：

1. `/v1/handshake` 的响应组装：任务书写 `server.ts:906-916`；实测路由声明在 **`:906`**，
   能力位字面量在 **`:918`**（`app.get("/v1/handshake", …)` 的响应体比任务书多两行）⇒ **偏离成立**。
2. **`packages/api-contracts/test/` 目录不存在**（实测该包下只有 `src/` 与 `package.json`，
   `Test-Path` 返回 `False`）⇒ 任务书里点名的这个路径是**空集**。
   **后果（重要）**：`@rai/api-contracts` 的覆盖**只能**来自 `tsc`（§2.1）与 `apps/api/test/*`（§2.4）——
   不要以为那个包里有一层自己的测试。
3. `apps/api/test/server-runtime.test.ts` 对 `/v1/handshake` 用的是**子进程 + fetch**，不是 fastify `inject`
   ⇒ T1 因此另建了独立用例文件（§2.4 的那 4 条）。

**未改任务书**（按 Lead 裁定），仅记录。

## 3. 本轮新增的两支跨平台门禁

两支都是：只读、**显式 `encoding="utf-8"`**、退出码 0/1、失败**逐条**打印原因、
`sys.stdout` 重设为 UTF-8（否则 Windows 控制台 cp936 会把中文失败原因打成乱码）、
并**自带"我不是孤儿"的自检**。

### 3.1 `apps/ios/tests/check-direct-sync-status-copy.py`（§10.3 文案 + §10.2 接线）

```
> python apps/ios/tests/check-direct-sync-status-copy.py
Direct-sync status copy checks passed (48 checks: §10.3 copy verbatim from one entry, legacy copy absent,
§10.2 gate order and intent acknowledgement, gate is mounted)
EXIT=0
```

**48 条全绿**（挂载前的最后一次运行是 `48 checks, 1 failed`，唯一红的是"我还没被挂载"——那是**正确报警**，
`EXIT=1`；补挂载后转绿，见 §5.3 与 §4 的 Q4 探针）。

它钉住的事实：

1. §10.3 六句文案**逐字**存在，**每一句在整个 iOS 源码树里只出现 1 次**；
2. 六句全部来自**同一个集中入口** `enum DirectSyncCopy`（`apps/ios/RAI/HealthKitSync.swift:23`），
   该入口必须被引用（不是死代码）、有体积上界；
3. 三句**旧语义**在整个 `apps/ios/RAI/**` 里都不出现（**反向哨兵**，含注释）；
4. `markSuccess` 上 `DirectSyncCursorPolicy.decision(` 出现在 `taskStore.commitSuccess(` **之前**，
   且闸门调用**五个入参齐全**（`serverContractVersion:` / `receipt:` / `pendingCursorsPresent:` /
   `requiresReceipt:` / `phase:`）；
5. **§10.2 的认领保护**：`acknowledgeBackgroundIntent` 必须被 `!needsContinuation` **保护**
   （`guard !needsContinuation else { return }` 紧邻，或 `if !needsContinuation { … }` 包住）；
6. `.hold` 分支里**不得**出现 `commitSuccess` 或 `acknowledgeBackgroundIntent`；
7. **§10.1「保存可续接」**：收尾兜底 `let settled` 必须含 `!cursorHoldThisRound`，
   且该字段每轮**先重置后置位**（`= false` 必须出现在 `= true` 之前）；
8. **`requiresReceipt` 的逐点映射（Lead 指定为验收项）**：枚举 `markSuccess` 的**全部 7 个调用点**，
   按语义分类逐点断言——**跑过导入作业的收尾（传了 receipt）不得写 `false`**；
   **`inspection.status == "unchanged"` 那类没有回执可等的收尾必须写 `false`**；
   且**任何一个调用点都不许省略 `requiresReceipt:`**（Swift 默认值 `= true` 会让新调用点静默编译通过
   —— 这正是"新增第 8 个调用点 ⇒ 转红"的那条反向判据）。
   失败原因里写明"这一点属于哪一类、为什么"。

> **一处我自己修掉的假红（有据可查）**：第一版把"仍需续接分支"定义成"`needsContinuation` 那行 `{`
> 之后的 800 字符"，把**正确写法**（紧邻的认领调用）判成红。Lead 独立复现了同一次假红
> （`match at 4081 -> 'needsContinuation else {'`）。修法不是调窗口大小，而是把判据改成**保护形态**
> （两种形态都认），并补了反向突变（§4 P-A2）。

### 3.2 `apps/ios/tests/check-direct-sync-contract-parity.py`（跨语言契约一致性）

```
> python apps/ios/tests/check-direct-sync-contract-parity.py
server contract: packages/contracts/src/direct-sync.ts
  DirectSyncIngestStatus == INGEST_STATUSES: ['receiving', 'validating', 'applying', 'committed', 'rejected']
  DirectSyncAnalysisStatus == ANALYSIS_STATUSES: ['not_required', 'queued', 'running', 'published', 'failed']
  factsAnalysisContractVersion: server ['1'], iOS ['1']
Direct-sync contract parity checks passed (13 checks: status enums verbatim and in order,
factsAnalysisContractVersion identical, gate is mounted)
EXIT=0
```

**13 条全绿**（挂载前的最后一次运行是 `13 checks, 1 failed`，唯一红的是孤儿自检）。
Lead 也独立复跑过同一条命令，得到同样的三条实质结论。

- `DirectSyncIngestStatus`（`DirectSyncReceiptState.swift:15-21`）与 `direct-sync.ts:21` 的
  `INGEST_STATUSES` **逐字、含顺序**一致；
- `DirectSyncAnalysisStatus`（同文件 `:27-33`）与 `:30` 的 `ANALYSIS_STATUSES` 一致
  （`notRequired = "not_required"` 是**显式 rawValue**，判据读 rawValue 而不是 case 名）；
- `factsAnalysisContractVersion`：`apps/api/src/server.ts:918` 与 iOS
  `DirectSyncReceipt.factsAnalysisContractVersion` 都是 **1**。

**服务端路径先探测再断言**：`packages/contracts/src/direct-sync.ts` 与
`packages/api-contracts/src/direct-sync.ts` 都探，命中即用；都不命中就红并打印实际探测结果。
**健壮性实测**（拷到缺文件的空树里跑）：10 条 FAIL 逐条打印、`EXIT=1`、**没有 traceback**。

### 3.3 `apps/ios/tests/check-direct-sync-analysis-reconcile.py`（T5 的交付，本机真跑）

T5 的交付**不是我的写范围**，但 Lead 要求把它纳入我的对抗性复核，且它的挂载行由我落笔，所以本机实跑如下：

```
> python apps/ios/tests/check-direct-sync-analysis-reconcile.py
OK: analysis terminal-state reconciliation gate (43 checks).
    note: this is a source-level gate. It does NOT execute the Swift reconcile path;
    the behavioural assertions run on macOS via apps/ios/tests/DirectSyncReceiptRegression.swift (H).
EXIT=0
```

**它能红的实证见 §4 的 Q3′/Q6**（去掉对账守卫 → `FAIL: 2 analysis-reconcile check(s) failed`）。
**它看不见的**：Q5（把 `needsReconcile` 改成恒 `true`）时它仍绿 —— 那条的红只能由 macOS 上的
Swift 回归给出（`DirectSyncReceiptRegression.swift:662` 有 `check(!settledRecord.needsReconcile, …)`，
本机**未执行**）。这一条我写成"门的牙在 macOS 那一侧"，不替它圆场。

> **我在取证途中实际撞到过它两次红，两次都不是它的判据错**，如实记下来备查：
> ①`FAIL: reconcile 里出现了重试包装 …（命中：'withRetry'）` —— 那是 **T5 自己的突变探针**（第 5 个），
> 它随后 revert；②更早的 `对账调用前面找不到 if settled 守卫` —— 同一段正在被编辑的"移动靶"。
> 树冻结后我按**当前**这棵树重取基线（43 checks 绿，mtime 见 §14）。
> 这提醒一件事：**并发取证的读数必须带 mtime**，否则会把别人的中间态当成结论。

**我独立复核 T5 服务端改动的结果**（本机真跑，§2.5）：`analysisJobId` 是
`packages/api-contracts/src/index.ts:587` 的**可选**键 `analysisJobId?: string | null`；
`apps/api/src/direct-sync-ingest.ts:564` 写入、且与批次账本
`import_batches.summary_json.analysisJobId` **同源**（`:582` 同一变量）；`data-only-import.ts:201`
显式写 `null`（不是缺键）；iOS 侧读的是 `job?.summary?.analysisJobId`（`HealthKitSync.swift:1802`）
—— **回执字段路径两侧一致**。T5 的 3 条新用例与 `direct-sync-ingest.test.ts` 11 条本机全绿。

**必须记一笔的写范围例外（T5 主动申报，我复核成立）**：T5 修改了一个**既有**测试文件
`apps/api/test/data-only-import.test.ts`（在其 `:125` 之后补了 2 条断言：键必须存在 + 值必须 `null`），
该文件**不在** T5 的任务书写范围内。理由成立且我已复跑确认：T5 的第一个版本只在"统一接收器"的
record-only 用例里断言 `analysisJobId === null`，而**只有 `data-only-import.test.ts` 的夹具真的走
`applyDataOnlyImport` 快通路** —— 把 `null` 改成任意字符串，原来那条断言**照样绿**（T5 的探针 #2
实测到的无牙写法）。补断言后该突变转红。本机复跑 `data-only-import.test.ts` **29/29 pass，EXIT=0**。
⇒ 这是一次**判据挂错车道**的修复，不是顺手改测试；但"改了自己写范围外的文件"这件事本身需要 Lead 知悉。

### 3.4 跨平台可用性的实测（不是声称）

```
check-direct-sync-status-copy.py: bytes=9654  CRLF=0  bare_LF=235   utf-8 decode: OK
check-direct-sync-contract-parity.py: bytes=7806 CRLF=0 bare_LF=213 utf-8 decode: OK
```

两支脚本**只有 LF、无 CRLF**（`.gitattributes` 对 `*.py` 的要求），并且都显式 UTF-8 读写。

## 4. 对抗性复核：突变探针（改坏 → 跑 → 看到红 → 改回）

**全部跑在镜像副本上，未改动任何实现文件。** 每一行都是"改坏后门禁真的红了"的实测，不是推演。

| 编号 | 改坏什么 | 门禁 | 实测红在哪（真实输出片段） |
|---|---|---|---|
| P-A | 删掉 `guard !needsContinuation else { return }` | status-copy | `FAIL: §10.2: the acknowledgement call must be protected by !needsContinuation …` |
| P-A2 | `guard !needsContinuation` → `guard needsContinuation`（只去掉 `!`） | status-copy | 同上一条 ⇒ 判据认的是**否定语义**，不是字符串存在 |
| P-B | 文案表里 `"正在上传本批数据"` 加一个句号 | status-copy | 2 条红：`§10.3 status copy is not a string literal…` + `…missing from it` |
| P-C | 在 `markSuccess` 开头插入一次 `commitSuccess`（提交早于闸门） | status-copy | `FAIL: the cursor gate must be evaluated before taskStore.commitSuccess( …` |
| P-D | 闸门调用里删掉 `receipt: receipt,` | status-copy | `FAIL: the cursor gate call is missing argument labels receipt:` |
| P-E | `.hold` 分支里插入一次 `commitSuccess` | status-copy | `FAIL: the .hold branch must not call taskStore.commitSuccess( …` |
| P-F | 某个 unchanged 调用点 `requiresReceipt: false` → `true` | status-copy | `FAIL: markSuccess call at line 1057 has no receipt to wait for (the server answered "nothing to import") but declares requiresReceipt: true …` |
| P-G | 删掉某个导入路径的 `requiresReceipt:` 实参（模拟第 8 个调用点漏传） | status-copy | `FAIL: markSuccess call at line 997 does not pass requiresReceipt: — it silently inherits the default true …` |
| P-H | 导入路径 `requiresReceipt: directSyncNegotiated` → `false` | status-copy | `FAIL: markSuccess call at line 997 ran an import job (it passes a receipt) but declares requiresReceipt: false …` |
| M1 | `DirectSyncAnalysisStatus` 把 `queued`/`running` **换序**（集合不变、顺序变） | parity | `iOS ['not_required','running','queued',…] != server ['not_required','queued','running',…]` |
| M2 | `case notRequired = "not_required"` → `"notRequired"` | parity | `iOS ['notRequired',…] != server ['not_required',…]` |
| M3 | iOS `factsAnalysisContractVersion = 1` → `2` | parity | `factsAnalysisContractVersion drifted: iOS ['1','2'] != server ['1']` |
| M4 | 服务端 `server.ts` 的 `factsAnalysisContractVersion: 1` → `2` | parity | `factsAnalysisContractVersion drifted: iOS ['1'] != server ['2']` |
| M5a | 把两支门禁挂进 `run-model-tests.sh` | 两支 | parity/status-copy **全绿** ⇒ 孤儿判据**两个方向都有牙** |
| M5b | 往 `HealthKitSync.swift` 插一句 `"验证完成正在切换本地数据库"` | status-copy | `removed legacy status copy is back in iOS source: … HealthKitSync.swift` |
| Q4 | **删掉 `run-model-tests.sh` 里那一行挂载** | status-copy | `FAIL: this gate is an orphan: … never runs …` ⇒ **挂载行本身是承重的**，不是装饰 |
| Q3 | 去掉 `let settled =` 里的 `!cursorHoldThisRound &&` | status-copy | `FAIL: the wrap-up predicate let settled must include !cursorHoldThisRound …` |
| Q3′ | 去掉**对账守卫行**里的 `!cursorHoldThisRound`（T5 指定的靶子） | T5 的 reconcile | `FAIL: 2 analysis-reconcile check(s) failed`（T5 门禁红；**我的门禁不覆盖这一行**） |
| Q6 | 把对账守卫的 `settled` / hold 条件整个去掉 | T5 的 reconcile | `FAIL: 2 analysis-reconcile check(s) failed`（条数由 40 降到 39：一条断言随之不可达） |
| Q5 | `needsReconcile` 改成恒 `true`（T5 指定的靶子②） | T5 的 reconcile | ⚠️ **仍然是绿**（探针时该门禁为 `40 checks` 全绿）⇒ 这条的牙只在 macOS 的 Swift 回归（见 §3.3），**如实记为覆盖缺口** |

**Q3 与 Q3′ 是一组互补证据**：同一轮收尾有两个不同的 `!cursorHoldThisRound`
（`let settled =` **定义**处、以及 `if settled, …, !cursorHoldThisRound,` **对账守卫**处），
**我的门禁钉定义、T5 的门禁钉守卫，各自都只在对方那个靶子上保持绿**。两条都留下，不要合并。

**扫描口径复核过两次**：§10.3 比对先剥注释、只认**带引号的完整字面量**。朴素子串匹配在本仓会
**假绿/假红**：`NativeAppModel.swift:1699` 的 `"反馈已保存，分析已更新。"` 会被当成 `分析已更新` 的命中，
而 `DirectSyncReceiptState.swift:38` 的**注释**里引用了同一句，会被当成"第二个集中入口"。

## 5. macOS 才能跑（本机是**显式跳过**，不是通过）

### 5.1 `npm run test:ios` 在本机的原话

```
> npm run test:ios
> node scripts/run-ios.mjs gates

⚠️  跳过 iOS 门禁：当前系统是 MINGW64_NT-10.0-26100，iOS 类型检查与回归只能在 macOS 上跑。
    本次没有检查任何 iOS 源码。
TEST_IOS_EXIT=0
```

**EXIT=0 是"显式跳过"，不是"通过"**（§14.5 原文："无 Xcode 的跳过不是通过证据"）。

### 5.2 macOS 上的确切命令

```
bash apps/ios/tests/run-model-tests.sh        # 聚合入口（npm run test:ios 在 macOS 上的执行体）
```

T2 的纯逻辑回归已挂在 `run-model-tests.sh:80-81`（编译行 + 执行行），编译单元为
`SyncPhase.swift` + `DirectSyncReceiptState.swift` + `DirectSyncCursorPolicy.swift` +
`SyncTaskState.swift` + `DirectSyncReceiptRegression.swift`。**本机未执行**（无 `swiftc`）。

### 5.3 三支 python 门禁已挂进 `run-model-tests.sh`（本次已完成）

按 Lead 的裁定（"一次性做完，排在 task-5 complete 之后"），在 T5 的
`check-direct-sync-analysis-reconcile.py` 落地后，我**一次挂了三行**，
锚在既有 `python3 apps/ios/tests/check-export-determinism.py` 之后（该文件本轮只有 T2 与我写过，
T5 的写范围不含它，因此没有并发覆盖）：

```bash
python3 apps/ios/tests/check-direct-sync-status-copy.py
python3 apps/ios/tests/check-direct-sync-contract-parity.py
python3 apps/ios/tests/check-direct-sync-analysis-reconcile.py
```

**挂载后的三支实测**（§3.1 / §3.2 / §3.3，本机真跑）：`48 checks` ✅ / `13 checks` ✅ / `43 checks` ✅（T5 随后把它的门禁从 40 条扩到 43 条，冻结态见 §14）。
**挂载前**三支各报一条"我是孤儿"（`EXIT=1`）—— 那不是假红，是**正确报警**；
Q4 探针证明把挂载行删掉就会重新变红 ⇒ 这三行是**承重**的。

⚠️ 本机没有 `python3`（只有 `python`），**不要**因此改成 `python`：`run-model-tests.sh` 只在 macOS 上跑，
既有脚本一律写 `python3`。本机手工验证用 `python <path>`。
**仍未验证的**：`bash apps/ios/tests/run-model-tests.sh` 整体在 macOS 上的执行（本机无 `swiftc`，
该脚本会在 `xcrun swiftc` 处失败）——三支 python 门禁在 macOS 上的**执行**同样**未在本机复现**，
我只是在本机用等价命令 `python <path>` 逐支跑过。

## 6. 真机才能验收（§14.5 第七项 + §14.2 A07）—— 可执行人工清单

> 本节**全部未执行**（本机无设备）。对应文档：§14.2 **A07**（487 行，证据要求原文"iOS 纯逻辑回归和
> **真机/Simulator 中断续传记录**"）、§14.5 **第七项**（537 行）、§10.2、§10.3。

### 6.0 先抄记录字段（缺一项这次验收就不算数）

设备型号 / iOS 版本 ｜ App 版本 + build（commit `______`）｜ API 地址 / `serverId` / `athleteId` /
`datasetEpoch` ｜ 服务端是否宣告 `factsAnalysisContractVersion`（新服务端=1 / 老服务端=缺失）｜
数据 scope ｜ 起始游标（`sync_tasks.record_cursors` 有无 + 水位时间）｜
数据来源：**只允许合成/脱敏**样本，不得使用真实健康原文。

### 6.1 D1 自动增量与"有效游标保持"

1. 完整同步到成功，记录游标与水位。
2. **不新增任何数据**再触发一轮同步。
   **预期**：不重导全历史；服务端回答"已是最新"；**游标与水位不得回退**。
   ⚠️ **必须单独盯**：这一轮若反复失败，**不要**当成"UI 文案没生效"——那是
   §10.3 那条"receipt-less 成功路径"接线问题在真机上的样子（§10.1 已修，仍需真机确认）。
3. **新增**一条合成跑步记录，再同步一轮。
   **预期**：只上传新增；界面依次出现 §10.3 前三句（读取增量 → 上传本批数据 → 保存新增与更正记录）；
   **不得**出现 `备份并校验现有数据` / `临时数据库增量同步` / `验证完成正在切换本地数据库`。
4. 对照服务端实际收到的批次数与条数（`/v1/import-jobs` 或 worker 日志）。

### 6.2 D2 后台中断后续传（A07 的"真机/Simulator 中断续传记录"）

1. 制造较大增量（几百条合成样本）并开始同步。
2. 上传/导入中途切后台或锁屏 ~30 s 再回前台。
   **预期**：可续接，**不伪装成用户取消**（不得出现"同步已取消"）。
   留证：`sync_tasks` 行的 `phase` / `jobId` / `payloadHash` / `needsContinuation` + 同一 `jobId` 的终态。
3. 强杀 App 后重开再同步。
   **预期**：从持久状态恢复，**不重复导入已确认批**；同 scope 重试返回**同一份回执**（§10.1）。
4. 必留字段（脱敏）：`receiptId`、`ingestStatus`、`analysisStatus`、`dependencyGeneration`、
   `publishedReleaseId`、`parentBatchId`，以及游标 blob **是否**推进。

### 6.3 D3 §10.3 文案的两个阶段（含 T5 的对账边界）

**第一段（raw COMMIT 之后，今天可达）**：完成接收后，**预期 `健康数据已保存，分析更新中`**
（回执 `ingestStatus: committed` + `analysisStatus: queued`）；**不得**说"分析已更新"（`queued ≠ published`，§9.1）。

**第二段（分析终态，依赖 task-5 的**对账动作**）**：分析 `succeeded` ⇒ **预期 `分析已更新`**；
分析 `failed` ⇒ **预期 `健康数据已保存，分析更新失败，可重试分析`**。

> 🔴 **必须如实写明**：这两条**终态**文案依赖 T5 落地的有界 `GET /v1/jobs/:id` 对账。
> **T5 落地前，真机上只能观测到"分析更新中"**——那时**不得**把"没观测到终态文案"写成
> "文案没生效"或"验收失败"，因为回执是**写入时刻的快照**（§9）。

### 6.4 D4 老服务端不会被新客户端卡死（§10.2「保留旧等待含义」）

把 App 指向**未宣告** `factsAnalysisContractVersion` 的服务端。
**预期**：仍是旧行为——游标正常推进、同步整体能成功；**不得**每轮 hold、更不得永远同步不完。
**失败判据**：任一轮以"缺回执/契约缺失"结尾且游标不推进 ⇒ **本次验收失败**（比文案更重要）。

### 6.5 失败判据（任一命中即失败；不得用"性能改善了"替代）

1. 正常批次期间出现 §14.1 任何禁止操作的可见痕迹；
2. 无新增数据的一轮**反复失败**或游标回退；
3. 切后台被说成"用户取消"；
4. COMMIT 后重启/丢回复导致重复导入，或重试拿到**不同**回执；
5. 用户看到三句旧语义中的任何一句；
6. `analysisStatus: queued` 被显示成"分析已更新"。

**留证**：脱敏截图（只截文案区）、`sync_tasks` 行与回执字段文本、服务端同一 `jobId` 的状态与时间线。
**不得**提交原始健康数据、精确路线、上传 ZIP 或 SQLite（`deliverables/README.md`「新产物约定」）。

## 7. 明确不宣称（不可达清单）

- **P01–P06（§14.3 性能）**：需目标云机 + 代表性规模库 + 每组 ≥30 批预热 / 200 有效样本（§14.4）。
  **本机一个条件都不满足 ⇒ 未执行、不宣称任何性能结论。**
- **A12/A13 真并发时序**：需真并发交错与读侧集成。**未执行、不宣称。**
- **任何"真机已验证 / 生产已验证 / 已上线"**：本机无设备、无生产环境。
- **§14.5 整表勾选**：A01–A18 逐项状态以
  [`ACCEPTANCE_INVENTORY_DIRECT_SYNC_2026-10-13.md`](ACCEPTANCE_INVENTORY_DIRECT_SYNC_2026-10-13.md)
  为准；本文件只补它缺的那一半——**执行**。

## 8. 能力位命名与已知同名分歧（Lead 裁定 A）

**本批定义**：`factsAnalysisContractVersion == 1` ⇒ **直连原始回执能力**
（`summary.directSync` 会带 `ingestStatus` / `analysisStatus`）。iOS 侧 guard 之后用它**只**决定
"这份持久回执可不可信"（判据在 `apps/ios/RAI/DirectSyncCursorPolicy.swift` 的
`decision(serverContractVersion:…)`）。

**已知同名分歧**：`docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md:101` 用**同一个标识符**描述 PR5-S3 的
`currentFacts` / `publishedAnalysis` **两块视图**能力。语义确实分叉了。本批**不改名**
（避免在三个 in-flight 任务上做跨文件改名），但**必须显式消歧**。

**未落地**：PR5-S3 的两块视图能力**尚未实现**（该文档 §5 的 S3–S11 全部未做）。

> 🔴 **约束（可检索）**：`factsAnalysisContractVersion` 只表示**直连原始回执能力**；将来两块视图
> 落地时**必须另取名字**（例如 `factsAnalysisViewContractVersion`），**不得**复用本标识符 ——
> 一个标识符承担两种协商含义，等于让客户端的 guard 保护错东西。

**真机口径**：真机要观测的是"回执被采用 / 被拒绝"的行为，**不是**"两块视图出现了"。

另记一处**文档与实现的差异**（未被裁定改名，但影响读者）：
同一文档 `:102` 写的是 `guard handshake?.factsAnalysisContractVersion == 1`（**相等**），
而 iOS 落地的是 `version >= DirectSyncReceipt.factsAnalysisContractVersion`（**下界**）。
两者在"服务端把版本抬到 2"时期望相反。**未改**（见 §10.2 的注释问题）。

## 9. 本批已知的服务端语义边界（Lead 要求单列）

**直连回执是"写入时刻的凭证"，不随分析推进而变。**

服务端在接收事务里写下的 `analysisStatus` 是**当时**的快照（今天真正会写出的只有
`queued` / `not_required`，`apps/api/src/direct-sync-ingest.ts`），落盘后**全仓没有更新方**。因此：

- `健康数据已保存，分析更新中` 是 raw COMMIT 之后**唯一可达**的终态文案；
- `分析已更新` / `健康数据已保存，分析更新失败，可重试分析` 必须靠**独立通道对账**才能说出口
  （task-5：回执追加可选 `analysisJobId` + iOS 侧一次有界 `GET /v1/jobs/:id`，
  **在 `markSuccess` 之后、不得让同步变红、不得改写回执**）；
- 给将来的读者：**不要把"回执没变"读成"分析没跑"**，也不要把"分析状态推进"实现成**改写凭证**。

**T2 的一处语义收窄（如实标注为前瞻性，不是行为变更）**：`requiresReceipt == false` **只豁免回执
那一条**判据，`hasMorePages` / `deletionOnlyPage` 两条 §5.1 分页判据仍在最前（删掉任一都会被
T2 的穷举格与 ⑨b/⑨c 抓住）。今天这两个实参**恒为 false**，所以它**不是行为变更**，而是把语义
提前收紧，避免将来接分页时"豁免"被误当成"整函数豁免"。

## 10. 复核中发现并已上报的实现问题（未改任何实现文件）

### 10.1 🔴 receipt-less 成功路径 × 游标闸门 ⇒ 自锁（已报 T3 + Lead，**已修**，并被本标准钉住）

**原始发现**：`markSuccess` 把"这一页有候选游标"（`pendingCursorsPresent: recordCursors != nil`）
当成了"这一页在等服务端回执"，于是**不传 receipt 的成功路径会永久 hold 并自锁**。
我用脚本枚举了全部 7 个调用点：`:997/:1079/:1172/:1394` 传 receipt；
`:1053`/`:1150`（恢复路径）、`:1372`（`inspection.status == "unchanged"` 分支，`advanceWatermark: true`）
**不传 receipt 却传了游标**。判据链：`HealthKitExport.swift:32 let recordCursors: Data`（非可选 ⇒ 恒非 nil）
⇒ `pendingCursorsPresent == true` ⇒ `receipt == nil` ⇒ `DirectSyncCursorPolicy` 返回 `.hold(no_receipt)`
⇒ `.hold` 分支 `phase = failed` + `return`，`commitSuccess` 从不执行 ⇒ 下一轮同一分支 ⇒ 自锁。
**证据强度**：本机无 `swiftc`，这是**源码判读**；但 T2 的回归②已把
`pendingCursorsPresent: true, receipt: nil ⇒ .hold("no_receipt")` 钉死，"策略那一半"在 macOS 上被测过，
争议只在**接线**。

**修法（Lead 裁定，T2/T3 已落地）**：把"适不适用回执协议"做成**显式入参**
`requiresReceipt:`（`DirectSyncCursorPolicy.decision` / `continuationNeeded`），
由调用点逐点决定：4 个跑过导入作业的收尾传 `directSyncNegotiated`
（= `activeIdentity` 宣告了能力位，老服务端为 `false`），3 个 `unchanged` 收尾显式传 `false`；
`markSuccess` 形参默认 `= true`（安全侧），并把这一位转发给两个判据。
另加 `cursorHoldThisRound`：被闸门拦下的一轮**既没失败也没结**，收尾兜底 `let settled` 必须含
`!cursorHoldThisRound`，否则会清掉任务行与候选游标、界面改口"同步成功"。

**我的独立复核**：7 个调用点现在分别是
`4 × directSyncNegotiated` + `3 × false`（§3.1 第 8 条逐点断言），且 §4 的 P-F/P-G/P-H
三个探针证明这条判据**有牙**（改错任一类、或漏传实参都会红）。

### 10.2 `DirectSyncReceiptState.swift:72-73` 的注释与实现/回归相反（已报 T2）

- **注释**：「判据是 `>=` …… 服务端把版本往上抬意味着新合同带来了客户端没实现的语义，
  那时正确的动作是**继续 hold**，不是照旧放行。」
- **实现**：`DirectSyncCursorPolicy.swift` `guard version >= DirectSyncReceipt.factsAnalysisContractVersion`
  ⇒ 版本 **2** 时返回 **`.advance`**（放行）。
- **回归**：`DirectSyncReceiptRegression.swift:190-196` 断言 `version + 1 ⇒ .advance`，标题原文
  *"a newer capability is still accepted (>= floor) — the floor is a lower bound, not equality"*。

⇒ **实现与回归一致，是那句注释的论证与它们相反**。**未改**，已请 T2 对齐注释（或改判据并配回归）。

## 11. 覆盖缺口 / "无牙"清单（如实写，不圆场）

1. **挂载已完成，但"在 macOS 上被聚合入口执行"仍未被本机复现**：三行已写进
   `run-model-tests.sh:112-121`（含注释），三支门禁在本机**逐支手工跑过且全绿**；
   但 `bash apps/ios/tests/run-model-tests.sh` 整体在本机**不可能**跑完（无 `swiftc`），
   所以"它们会在 macOS 的聚合入口里被真的执行"这一点**只有 macOS 能证明**（Q4 只证明了挂载行承重）。
2. **`saveTask` 的 `.taskPersisted` 认领点不在本门禁覆盖内**：§10.2 的认领点有两处
   （`markSuccess` 的 `.syncCommitted` 与 `saveTask` 的 `.taskPersisted`），我的判据只钉前者。
   后者是既有、有成文理由的写入点（`check-background-capabilities.py` 按**写入点个数**钉死那条计数），
   **不要为了凑断言去动它**。
3. **"iOS 源码里没有旧文案" ≠ "用户看不到旧文案"**（§12.3）：服务端 `job.message` 会原样上屏。
4. **两处 python 崩溃未被任何判据发现**（§12.2）：它们是"门禁自己坏了"，而门禁坏了没有门禁。
5. **跨语言一致性只覆盖取值与版本号**：回执**字段名/可选性**（`receiptId` / `dependencyGeneration` /
   `publishedReleaseId` / `parentBatchId` / `routeReceipts` 的取舍）**不在** parity 脚本里——
   iOS 侧由 `DirectSyncReceiptRegression.swift` 的编解码用例覆盖（仅 macOS），服务端侧由
   `packages/contracts/src/direct-sync.ts` 的接口定义覆盖，**两侧之间没有自动化判据**。
6. **§10.1 的"raw COMMIT 后查同 scope/batch 持久回执返回同一成功"**：不在本轮两支新门禁里
   （服务端行为），本机**未执行**。
7. **`npm run build` 的默认环境失败**会让下一个人误判（§2.3）：本机需要重定向 `TEMP` 才能拿到真实结论。
8. **T5 门禁对 `needsReconcile` 恒 `true` 无牙**（§4 Q5）：那一条的红只能由 macOS 上的 Swift 回归
   （`DirectSyncReceiptRegression.swift:662`）给出，本机**未执行**。另外我**没有**逐一复核 T5
   门禁的 40+ 条断言各自的突变靶子，只按 Lead 要求打了两处（Q3′、Q6）——**不要**把这两处通过
   读成"T5 的 43 条全都验证过"。
9. **`npm run typecheck` 曾在本批次中途变红**（EXIT=2，§2.1，T5 的在制品）：
   T5 修复后我复跑到 EXIT=0，**冻结时点成立**。留这条记录的原因是它示范了
   "跑了测试"与"过了类型检查"是两条独立判据 —— 只跑 `node --import tsx --test` 会漏掉它。

## 12. 发现但未改（如实记录，不在本批写范围）

### 12.1（并入 §8.1）`check-background-capabilities.py` 的 1 条既有失败

`FAIL: package.json has no script entry for check-background-mutations.py — the harness would be an orphan`
（`274 checks, 1 failed`）。T2 独立跑出同一结果。**未修**——它属于另一件事，且红线要求我不动别人的门禁。

### 12.2 两支既有 python 门禁在 Windows 上直接崩溃（新发现，实证）

**未修**（红线：不改这两个文件）。这不是"平台判据的显式跳过"，而是**未捕获的崩溃**，
退出码 1、无逐条原因、无跳过说明：

```
> python apps/ios/tests/check-today-layout.py
Traceback (most recent call last):
  File "D:\running\apps\ios\tests\check-today-layout.py", line 6, in <module>
    views = (root / "TechViews.swift").read_text()
  File "C:\Users\Administrator\AppData\Local\Programs\Python\Python312\Lib\pathlib.py", line 1028, in read_text
    return f.read()
UnicodeDecodeError: 'gbk' codec can't decode byte 0xad in position 1622: illegal multibyte sequence
EXIT=1

> python apps/ios/tests/check-healthkit-record-sync.py
Traceback (most recent call last):
  File "D:\running\apps\ios\tests\check-healthkit-record-sync.py", line 13, in <module>
    export = (root / "apps/ios/RAI/HealthKitExport.swift").read_text()
  File "...\pathlib.py", line 1028, in read_text
    return f.read()
UnicodeDecodeError: 'gbk' codec can't decode byte 0xac in position 246: illegal multibyte sequence
EXIT=1
```

**成因**：`read_text()` 不带 `encoding` 时用**本机默认编码**（Windows = cp936/GBK），而这两个文件含
非 GBK 字节。**影响面**：`check-today-layout.py` 挂在 `run-model-tests.sh:83`（**聚合入口**！），
`check-healthkit-record-sync.py` 挂在 `run-health-sync-tests.sh:167`。这两条链只在 macOS 上跑
（macOS 默认 UTF-8）⇒ **在 macOS 上不会红**，于是形成
**"本仓在 Windows 上开发、却在 Windows 上跑不了自己的门禁"** 的缺口。
**修法（留给下一批）**：两处 `read_text()` 各加 `encoding="utf-8"`。

### 12.3 §14.1 三条旧语义在服务端仍在，且会经 iOS 显示给用户

T3 报告、**T4 独立复核成立**：

- `apps/api/src/import-worker.ts:627` `job.message = "正在备份并校验现有数据，准备增量导入";`
- `apps/api/src/import-worker.ts:641` `? "正在临时数据库中增量同步 Apple Health 数据"`
- `apps/api/src/import-worker.ts:642` `: "正在临时数据库中解析 Apple Health 导出文件";`
- 而 `apps/ios/RAI/HealthKitSync.swift:2066-2067`：

  ```swift
  if !job.message.isEmpty {
      message = job.message
  ```

⇒ §10.3 的"移除旧语义"**today 在 iOS 源码树里成立、在用户可见层面不成立**。
我的反向哨兵（§3.1 第 3 条）只证明前者，**不证明后者**——这句边界必须跟着判据一起读。
服务端属 T1/Lead 写范围，**未改**。

## 13. 复现命令汇总（本机）

```powershell
npm run typecheck
$env:RAI_TEST_CONCURRENCY="1"; node scripts/run-tests.mjs
$env:TEMP="D:\running\var\tmp"; $env:TMP=$env:TEMP; npm run build   # 默认 %TEMP% 会环境性失败（§2.3）
node --import tsx --test --test-concurrency=1 apps/api/test/direct-sync-handshake-capability.test.ts
node --import tsx --test --test-concurrency=1 apps/api/test/write-lease.test.ts
npm run test:ios                                  # 显式跳过（不是通过）
python apps/ios/tests/check-export-determinism.py
python apps/ios/tests/check-background-capabilities.py
python apps/ios/tests/check-direct-sync-status-copy.py
python apps/ios/tests/check-direct-sync-contract-parity.py
python apps/ios/tests/check-direct-sync-analysis-reconcile.py
python apps/ios/tests/check-today-layout.py            # 本机 UnicodeDecodeError（§12.2）
python apps/ios/tests/check-healthkit-record-sync.py   # 本机 UnicodeDecodeError（§12.2）
```

**未在本机执行的**（需 macOS / 真机）：`bash apps/ios/tests/run-model-tests.sh`（会在 `xcrun swiftc`
处失败）、`bash apps/ios/tests/run-ios-gates.sh`、`bash apps/ios/tests/run-health-sync-tests.sh`、
`npm run test:ios:live`，以及全部真机用例 D1–D4 与 T5 的 Swift H 节断言。
**T5 的 43 条门禁**已在本机真跑（§3.3），**T5 的服务端用例**已在本机复跑（§2.5）；
**T5 的 Swift 纯逻辑与 `SyncTaskStore` 新表**在本机**未编译、未执行**。

## 14. 冻结时点（本报告所有"通过"对应的那一棵树）

**冻结时的 mtime**（用来判定"这份读数属于哪一版"）：

```
apps/ios/RAI/HealthKitSync.swift               2026-10-13 13:17:51
apps/ios/tests/run-model-tests.sh              2026-10-13 13:11:45
apps/ios/tests/check-direct-sync-status-copy.py 2026-10-13 13:02:55
```

**冻结时点的实测汇总（逐条都是本机真跑）**：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0**（无 `error TS`） |
| `python apps/ios/tests/check-direct-sync-status-copy.py` | `48 checks passed`，**EXIT=0** |
| `python apps/ios/tests/check-direct-sync-contract-parity.py` | `13 checks passed`，**EXIT=0** |
| `python apps/ios/tests/check-direct-sync-analysis-reconcile.py` | `43 checks passed`，**EXIT=0**（T5 的交付） |
| `python apps/ios/tests/check-export-determinism.py` | `14 checks, 0 failed`，**EXIT=0** |
| `python apps/ios/tests/check-background-capabilities.py` | `274 checks, 1 failed`，**EXIT=1**（既有失败，§12.1） |
| `bash -n apps/ios/tests/run-model-tests.sh`（Git Bash） | **EXIT=0** |
| 四个定向服务端套件（§2.5） | `3/3`、`4/4`、`11/11`、`2/2`、`29/29` 全绿 |
| `npm run build`（`TEMP` 指向工作区内） | **EXIT=0**，`✓ built in 8.42s` |
| `node scripts/run-tests.mjs`（`RAI_TEST_CONCURRENCY=1`） | **EXIT=0**，`# tests 1735 / # pass 1715 / # fail 0 / # skipped 20` + Web `184 passed` |
| `npm run test:ios` | **显式跳过**（EXIT=0 + "本次没有检查任何 iOS 源码"） |

**仍然"未执行"的**：所有 Swift 编译与执行；`bash apps/ios/tests/run-model-tests.sh` 的完整跑通；
真机用例 D1–D4；P01–P06 与 A12/A13 的真并发时序。
**本报告不包含、也不支持任何"真机已验收 / 生产已验证"的结论。**
