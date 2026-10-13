# 批量 A+B 验收报告：真机等价 HTTP 夹具、备份入口退场、PR5 S3→S6 读侧一致性

- 日期：2026-10-13（Asia/Shanghai）。基线 `89011f4`（工作树含上一批未提交在制品）。
- 上位判据：[SQLite 直接增量同步设计](../docs/SQLITE_DIRECT_SYNC_DESIGN.md) §11 / §12 / §14.2（A12/A15/A17）、§14.5；
  [PR5 落地设计](../docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md) §2 D1–D5、§3 清单、§4 C1–C10、§5 S3–S6。
- 上一批（PR6 iOS 侧协议/状态/文案）：[DIRECT_SYNC_PR6_DEVICE_VERIFICATION_2026-10-13.md](DIRECT_SYNC_PR6_DEVICE_VERIFICATION_2026-10-13.md)。

> ⚠️ **这不是发布放行声明。** 本批把三条验收项的**协议半边**机械化了，但
> **P01–P06 未测、真机观感未验、A12/A13 的真并发时序不可达**。逐条边界见 §5。

## 1. 本批交付

| 批次 | 交付 | 文件 |
|---|---|---|
| A1 | 真机等价 HTTP 验收夹具（9 用例，真实子进程 + 真实 multipart + 真实 HTTP） | [direct-sync-http-acceptance.test.ts](../apps/api/test/direct-sync-http-acceptance.test.ts) |
| A2 | §11 备份入口退场（应用不再自动创建/删除备份；**恢复能力保留**） | `deploy/upgrade.sh`、`deploy/README-UBUNTU.md`、`docs/OPERATIONS.md`、`apps/api/src/{server,schemas,api-error,import-worker}.ts`、`apps/web/src/pages/{SettingsPage,DataModelPage}.tsx` |
| A2 | 直连接收器在竞争下整批失败的真缺陷修复 | `packages/storage-sqlite/src/database.ts`、新建 [connection-contention.test.ts](../packages/storage-sqlite/test/connection-contention.test.ts) |
| A2 | 本机跑不了的 iOS 结构门禁（4 文件 / 11 处裸 `read_text()`） | `apps/ios/tests/{check-today-layout,check-healthkit-record-sync,check-fresh-skin,check-health-sync-archive}.py` |
| B1 | PR5 S3→S6 读侧一致性 | 新建 [fact-read-view.ts](../packages/storage-sqlite/src/read/fact-read-view.ts)、`packages/contracts/src/{direct-sync,index}.ts`、`packages/storage-sqlite/src/{read/*,recompute-job-repository}.ts`、`apps/api/src/{data,server,mobile-read}.ts`、新建 [pr5-read-side.test.ts](../apps/api/test/pr5-read-side.test.ts) |
| V（Lead） | 跨平台门禁统一入口 + C9 基线 + 本报告 | 新建 [run-ios-python-gates.mjs](../scripts/run-ios-python-gates.mjs)、新建 [check-pr5-facts-analysis.py](../apps/ios/tests/check-pr5-facts-analysis.py)、`var/reports/pr5-c9-baseline-keys.json` |

## 2. 本机（Windows，无 Xcode）实测 —— 全部真跑

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | `tsconfig.pure.json` **EXIT=0**、`tsconfig.json` **EXIT=0** |
| `npm run build` | **EXIT=0**（`✓ built in 9.25s`；需把 `TEMP`/`TMP` 指到工作区内，见 §5.6） |
| `npm run check:ios-gates`（新建） | **10 支跨平台判据全绿**，2 支需外部条件显式跳过 |
| `npm run check:docs` | 50 files / **397 links / 0 problems** |
| `npm run check:doc-refs` | 139 处引用 / **0 越界 / 0 漂移** |
| `npm run check:scripts` | 19 个 package.json / 116 条 script **通过** |
| `direct-sync-http-acceptance.test.ts` | **9/9**（Lead 独立复跑一次，非仅作者自报） |
| `pr5-read-side.test.ts` + `workout-presence` + `recompute-job-bindings` | **39/39**（Lead 独立复跑） |
| `connection-contention.test.ts` | **2/2**，且**退化到修复前形态时 2/2 全红**（见 §3.3） |
| 全量 `node scripts/run-tests.mjs`（`RAI_TEST_CONCURRENCY=1`） | **EXIT=0**：Node **1782 tests / 1761 pass / 0 fail / 21 skipped** ＋ Web **185 passed (25 files)** |

> 上面每一行都是 **Lead 在冻结树上自己跑的**（不是转述作者结论）。全量日志留档：
> `var/reports/lead-final-node-tests.log`。21 条 skip 全部是 `# SKIP bash is required for
> deploy script tests`（本机 `bash` 是 WSL 启动器、无发行版），见 §5.7。

### 2.1 全量套件（Lead 冻结树复跑，原始日志留档）

```
> node scripts/run-tests.mjs          # RAI_TEST_CONCURRENCY=1
# tests 1782
# pass 1761
# fail 0
# skipped 21
      Tests  185 passed (185)        # Web vitest，25 个文件
SUITE_EXIT=0
```
日志：`var/reports/lead-final-node-tests.log`。作者侧同期独立数字一致
（A2：`1782 / 1761 / 0 / 21`，Web 185/185，storage-sqlite 156/156）。

## 3. 三条真缺陷（本批发现并修掉，都是"偶发且无定位线索"的形态）

### 3.1 直连接收器在竞争下整批失败（用户可见）
`RaiDatabase` 构造函数把 `PRAGMA journal_mode = WAL`（**需要独占锁**）放在
`busy_timeout` 之前 ⇒ 只要有另一个连接正好持锁，整批 `applyDirectSyncImport` 抛
`database is locked`，终态 `failed`，且**没有任何线索**说明那是锁竞争。

修法（A2 实现）：`busy_timeout` 前置 → `ensureWalMode()` 先读（已是 `wal` 就不拿锁）→
否则**有界重试**（10 × 500 ms），耗尽后**原样上抛最初的 SQLite 错误**。
⚠️ **Lead 给的第一版修法（只重排 pragma）被 A2 用实测否掉**：
`PRAGMA journal_mode = WAL` **不走 busy handler** —— `busy_timeout=3000` 下 mode 切换
**0–1 ms** 就返回 `SQLITE_BUSY`，而普通 INSERT 会等满 **3334 ms**。这条更正保留了：
"让 SQLite 自己去等"对 mode 切换不成立。

### 3.2 备份约定与代码不一致（会让运维打一个已退役的接口）
`deploy/README-UBUNTU.md` 教运维装一个每 40 分钟 `POST /v1/backups` 的 systemd timer ——
接口退役后它会每 40 分钟拿到一次 410。已改为指向 `deploy/backup-runtime.sh`（停服冷备）
＋ §11.1 的在线备份约束。

### 3.3 门禁自身的三处"无牙/恒红"（本批用突变探针逐个逼出来的）
1. `check-background-capabilities.py` 的突变脚本入口判据**恒红**：它查
   `package.json` 里有没有 `check-background-mutations.py` 字面量，而该入口早已按
   跨平台规则搬进 `scripts/run-ios.mjs`（npm script 正文不许写 `VAR=x cmd`）。
2. 修它的第一版**假绿**：写成 `"run-ios.mjs mutation" in package_json`，被
   `node scripts/run-ios.mjs mutation-scope` 那条 script 满足（**子串**）—— 删掉
   `test:ios:mutation` 之后照样绿。
3. 修它的第二版**仍然假绿**：`^  mutation:\s*\{.*?^    file:` 的 `.*?` 会跨过 `mutation`
   块自己的 `}`，跑到后面 `mutation-scope` 的 `file: MUTATION_FILE` 上 —— 把 `mutation`
   的 file 改成别的照样绿。最终用 `[^}]*?` 把匹配限制在本块之内。
   **三个突变探针（删 script / 重指目标 / 重指文件）现在逐个转红**，实测记录见 §4。

> 教训与本仓既有纪律同源：**"判据存在"与"判据有牙"是两件事**，而"改坏了仍然绿"只有
> 突变探针能发现 —— 本批三处都是这么发现的，其中两处是**我们自己刚写的**新判据。

## 4. 突变探针（改坏 → 跑 → 见红 → 改回）

| # | 改坏什么 | 转红的是 |
|---|---|---|
| A1-1 | `server.ts` 的 `factsAnalysisContractVersion: 1` → `2` | handshake 断言 |
| A1-2 | `classification.payloadClass === "analysis-required"` → `false` | 终态 `analysisStatus === "queued"` **且**提交前断言 |
| A1-3 | 路由层 + worker 层**同时**去掉 `findBySourceId` 去重 | "重放必须命中同一个任务"（**单改任一层不红**，见 §5.4） |
| A1-4 | `classifyDirectSyncPayload` 直接返回 `record-only` | 删除-only ⇒ `queued` |
| A1-5 | 删掉 `store.commitCallerTransaction()` | 持久回执 / 恰好提交一次 |
| A2-1 | `deploy/upgrade.sh` 加回 `POST /v1/backups` | 行为级 + 源码级 |
| A2-2 | `server.ts` POST 路由退回 `maintenance.createBackup(...)` | 隔离 `var/` 的"不创建任何文件" |
| A2-3 | `maintenance.ts` 的 `backupStream` 读完顺手删文件 | 只读清单/下载判据 |
| A2-4 | `ensureWalMode` 的 `attempts = 1` / `= ∞` | 用例 1 / 用例 2（**两条互补**） |
| B1-1..6 | `map()` 不透传绑定列 / 事实块填 `currentAbility` / 不 `BEGIN DEFERRED` / 分析块读当前 `route_points` / `versions` 写进 metadata 字面量 / `workoutPresentConditionSql → 1=1` | C10 / C2 / C1 / C8 / C9 / C3 |
| V-1..3 | 删 `test:ios:mutation` script / 重指 `mutation.file` / 重指 `MUTATION_FILE` | 三条入口断言逐个转红 |

## 5. 边界与不可达（不许被读成通过）

1. **§14.3 P01–P06 未测**：本批没有任何计时口径。A1 夹具里的 5000 条 / 2 MiB 只是**上界自检**
   （越界会静默掉回旧链路），不是性能结论。
2. **真机观感未验**：A17 剩下的人肉一半（界面确实显示了 §10.3 那句话）本机无法产出。
   A1 夹具只保证"服务端给出的字段能支撑那句话"。
3. **iOS 判据未跑**：`DirectSyncCursorPolicy` 在 `apps/ios`，本机无 swiftc。A1 用例 2 只断言
   **服务端事实**（老形态可解码），并把它写成"给 iOS 判据的输入前提"，**没有**假装测了 Swift。
4. **HTTP 层的"重放取原回执"由两层守卫提供**（路由 `findBySourceId` + 接收器
   `readImportReceiptInDatabase`）⇒ 单改任一层不红，必须两层同改。**本文件不覆盖接收器内部的重放**
   （那是 `direct-sync-ingest.test.ts` / `import-worker-direct-sync.test.ts` 的地盘）。
5. **A05 有一条约 140 ms 的时序窗口**：夹具把 kill 判据收紧成"回执已落库**且** runtime 里任务
   仍非终态"，并把载荷放大到 4500 条才把窗口拉到可复现宽度。它是**时序窗口，不是结构保证**。
6. **`npm run build` 在本机默认 `%TEMP%` 下环境性失败**（`[vite:esbuild-transpile] remove
   …Temp\esbuild-…: Access is denied`）：把 `TEMP`/`TMP` 指到工作区内即 EXIT=0。
   归因已做（Node 自己能删、esbuild 子进程不能），**未做改动前基线对照**，故只写"失败形态与代码无关"。
7. **`apps/api/test/deploy-upgrade.test.ts` 的 4 条在本机全部 SKIP**：PATH 上的 `bash` 是
   `C:\Windows\System32\bash.exe`（WSL 启动器），本机没装任何 WSL 发行版 ⇒ `bashTest` 守卫如实跳过。
   行为级证据由 A2 的独立 Git Bash 探针提供。**未把它改成绿。**
8. **C1 是本线程内的同步交错，不是真并发**：第二条连接确实在事务进行中提交了
   `raw_generation + 1`，事务内后续读仍是旧快照 —— 性质被证明了，但**不是"真并发已验证"**。
9. **S6 未产出"清单 6–10 逐条 × 行号"对照表**：实际做法是结构性核对 + C3 在四个端点直接判绿。
   清单里 S7–S11 **未执行**（S11 的判据依赖 A1 夹具，留给下一批）。
10. **`factsAnalysisViewContractVersion` 目前只声明在类型层，未接进 `/v1/handshake`**；
    Lead 的门禁只钉了"没复用 `factsAnalysisContractVersion`"这条命名约束。
11. **410 而不是 501（备份入口）**：`apiErrorPayload` 把**所有** 5xx 的 message 压成
    "本地服务处理请求失败" ⇒ 501 会把运维提示吞掉，正是 §11 禁止的静默失败。

## 6. §14.2 矩阵更新（A12 / A15 / A17）

| 编号 | 本批之后 | 证据 | 仍缺 |
|---|---|---|---|
| **A12** 旧分析与新事实一致性 | 由「只有结构/源码级证据」升为**部分行为级** | 两块视图 + 一次 `BEGIN DEFERRED` 读齐（C1）、键集不跨域（C2）、旧字段逐字节不变（C9）；Lead 门禁另钉 C9 的**可选性**（把 `?:` 改成 `:` 时键集不变，只有它能抓） | 桌面/iOS 状态截图；**A12/A13 的真并发时序不可达**；C4/C5/C6 属 S7–S11（未做） |
| **A15** 项目完全退出备份 | 由「只有结构/源码级证据」升为**行为级（自动创建那一半）** | 升级脚本不再 POST；POST/DELETE 退役为 410 且**用隔离 `var/` 断言一个文件都没动**；已存在备份 sha256 前后一致；**恢复路径仍可用**（既有恢复用例真跑 42/42 + 31/31） | 全量 4 条 `deploy-upgrade` 用例在本机 SKIP（见 §5.7）；`import-worker` 里旧候选链路的备份函数**刻意保留**（§13 允许） |
| **A17** 客户端状态和领域语义 | 由「部分行为级」升为**协议半边已机械化** | 新 HTTP 夹具走完真机会话顺序：`committed` / `queued` / `not_required` / `receiptId` 一致 / `publishedReleaseId === null`；弱能力位形态可解码 | **真机"界面确实显示了那句话"仍未验**；`apps/ios` 一行未编译 |

## 7. 本机可执行判据的覆盖变化（本批最结构性的一项）

改前：`apps/ios/tests/` 的 Python 结构门禁**只在 macOS 上被执行**（挂在 `run-*-tests.sh` 里，
而那条链在非 Darwin 上显式跳过），且其中 4 支因裸 `read_text()` 依赖宿主默认编码，
在 Windows 上直接 `UnicodeDecodeError`。

改后：新建 `npm run check:ios-gates`（`scripts/run-ios-python-gates.mjs`）**自动发现**
`apps/ios/tests/check-*.py` 并逐个执行，跨平台；排除表只留 2 支确实需要 macOS/模拟器的，**逐条写明原因**。
⇒ 新加一支门禁**自动进入本入口**，不再需要谁记得改一行挂载；本机从"0 支可跑"变成"10 支可跑"。

## 8. 冻结时点复核结论

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（两道 tsconfig） | EXIT=0 / EXIT=0 |
| `npm run build` | EXIT=0 |
| `node scripts/run-tests.mjs` | EXIT=0（1782 / 1761 pass / 0 fail / 21 skipped + Web 185） |
| `npm run check:ios-gates` | 10 支全绿，2 支显式跳过 |
| `npm run check:docs` / `check:doc-refs` / `check:scripts` | 0 problems / 0 越界 / 通过 |

**本批结束时的状态**：批量 A、B 的实施项全部落地并各自有实测证据；三条真缺陷修掉；
门禁从"macOS 才有执行者"变成"两边都执行"。
**仍未做**：S7–S11、P01–P06、真机验收（§14.5 第七项与 A07 的"真机记录"仍未勾选）、
`apps/ios` 的 Swift 编译。
