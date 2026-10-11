# 验收证据：iOS 同步不再在「盘上已落盘的 `jobId`」上坠进导出路径

- **as-of**：2026-10-11 09:09 CST（UTC+8）
- **时区**：`Asia/Shanghai`
- **代码**：`cebb0dc`（= `origin/main`）+ **本次未提交改动**（9 文件 / +340 −36）
- **行号口径**：本文所有 `文件:行号` 对齐**当前工作树**（含上述未提交改动），**不**对齐 `cebb0dc`
- **环境**：macOS 26.6.2 (25G83) / AMD 黑苹果 / Xcode 26.5 (17F42)，
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
- ⚠️ 本记录只含**聚合数字与命令**，不含原始健康数据、Token、路线、上传 ZIP 或 SQLite。

## 1. 结论

线上「App 显示*进行中 — 读取健康数据 / 正在读取心率与恢复数据*、久等不走完」是**两个独立缺陷叠加**：

| | 缺陷 | 性质 |
|---|---|---|
| ① | `SyncAtomicUnit.nextStep` 会正确派生 `.waitJob`，但 `performSync` **没有消费点** ⇒ 带 `jobId` 的任务**坠进导出路径** | 🔴 正确性缺陷（根因） |
| ② | 整轮导出里**最长**的一段（逐类型读全局记录）在界面上**一句话都不说** | 🟡 可观测性缺陷 |

①已修（新增 `.waitJob` 分支 + 15 分钟节流的同源豁免）；②已修（逐类型进度）。两者均有**结构门禁**与**突变**钉住。

**载荷逐字节未变**：进度文案只走 `onProgress`，不进 `export.xml` / manifest（`Export determinism checks: 14 checks, 0 failed`）。

## 2. 根因（可执行判据）

`SyncAtomicUnit.nextStep` 的优先级是 `jobId` > `sourceId` > 本地文件 > 导出，所以盘上有 `jobId` 时它返回 `.waitJob`（`apps/ios/RAI/SyncPhase.swift:133`）。而 `performSync` 当时**只认 `.inspect` 与 `.upload`** 两个分支。

三个后果**同时发生且全部静默**：

1. **重读一遍 HealthKit** —— 整个流程里最贵的一步，而服务端其实早算完了；
2. 紧随其后的 `saveTask` 用一份 `sourceId: nil, jobId: nil` 的新任务**盖掉旧行** ⇒ 那个还在服务端跑（或已成功）的 job **再也没人接**，来源只能靠 24h TTL 回收；
3. **界面永远停在"更新尚未完成"** —— 用户以为同步失败，其实服务端早已成功。

**这不是"漏了一个 case"，是"派生出来的步没有消费点"。**
`git log -S'unitStep == .waitJob'` 证明该分支**从未存在过**，不是某次重构弄丢的。

## 3. 改动清单

> 行号一律写成**完整 `路径:行号`**（不拆开）。拆开写会让门禁**看不见**这条引用 ——
> 它从此既不会被核对越界，也不会被列进漂移候选，等于一条没人看管的引用。

| 引用 | 内容 |
|---|---|
| apps/ios/RAI/SyncPhase.swift:144 | 新增 `Step.isServerReconciliationOnly`（**加在嵌套 `Step` 体内**，由 `nextStep` 同源派生） |
| apps/ios/RAI/HealthKitSync.swift:916 | 新增 `.waitJob` 分支：`waitForJob` → `markSuccess`；失败走 `HealthSyncResumePolicy` 与 `.inspect` **同一套**分类 |
| apps/ios/RAI/HealthKitSync.swift:303-313 | 节流新增第三种豁免：`isLedgerResume`（判据与选分支**同一个** `nextStep`，不另写一份"什么算便宜"） |
| apps/ios/RAI/HealthKitSync.swift:995-998 | 删掉 `.inspect` 分支里那段**不可达**的 `if let existing = restored.jobId` 回退 |
| apps/ios/RAI/HealthKitSync.swift:1522,1546 | `importedSummaryText` / `resumedImportMessage`（续接路径没有本轮 `HealthKitExportResult`，不替它编一句"已同步记录"） |
| apps/ios/RAI/HealthKitExport.swift:786,857 | `writeGlobalRecords` 增 `onProgress` 形参；`descriptors` 循环改成带序号上报 |
| apps/ios/tests/SyncAtomicUnitRegression.swift:139 | 新断言：`.waitJob` 在 4 种 zip/multipart 组合下均为 `isServerReconciliationOnly == true`，其余四步均 `false` |
| apps/ios/tests/check-background-capabilities.py:1826-1858 | 新增 §15d（5 条结构门禁）；`MIN_CHECKS` 268 → 273 |
| apps/ios/tests/check-healthkit-record-sync.py:86 | `recordCursors: restored.pendingRecordCursors` 计数 4 → 5 |
| apps/ios/tests/check-background-mutations.py | 新增 5 条 `[P1]` 突变（无行号引用） |
| docs/IOS_NATIVE_SYNC_PROTOCOL.md | 补「推导出来的每一步都必须有生产消费点」+ 节流豁免第二落点（无行号引用） |

**一条刻意的"不做"**：`.waitJob` 分支**不**认领后台意图（不调 `observeBackgroundIntentsForExportStart`）。
那条通道的确认点只在**导出起点**，而本分支不重新读 HealthKit、用的是早于通知生成的字节 —— 在此确认，
导出期间到达的那批新数据就再也没人导。`markSuccess` 里的确认读到的是 `nil` 观察槽，是**空操作**。
这条由 §15d 门禁以「`.waitJob` 分支内**不得**出现 `observeBackgroundIntentsForExportStart(`」钉住。

## 4. 门禁实跑

```
bash apps/ios/tests/run-ios-gates.sh          # 6m44s，EXIT=0，1024 行
  → .workbuddy/runlogs/ios-gates-2026-10-11.log
```

| 断言 | 结果 |
|---|---|
| iOS 类型检查（90 文件，跳过 3 个仅依赖高德 SDK 的） | 通过 |
| `Sync atomic unit regression tests passed` | 日志第 605 行 |
| `HealthKit record sync wiring` | **26 checks, 0 failed**（第 881 行） |
| `Background capability checks` | **274 checks, 0 failed**（第 1021 行） |
| `Export determinism checks` | **14 checks, 0 failed**（第 1022 行） |
| 收尾 | `iOS 门禁通过（类型检查 + 纯逻辑回归）`（第 1023 行） |

> 上表的「第 N 行」指 `.workbuddy/runlogs/` 下那份**未纳入版本控制**的运行日志，故不写成
> `路径:行号`（那样会被行号核对当成无法解析的引用）。

```
npm run check:doc-refs                        # EXIT=0（默认只覆盖 4 份核心 docs，0 处引用）
npm run check:docs                            # EXIT=0（34 files / 318 links / 0 problems）
node scripts/check-doc-line-refs.mjs deliverables/VERIFICATION_2026-10-11-ios-resume.md
                                              # EXIT=0，15 处引用，0 处越界/无法解析
```

⚠️ **行号核对的覆盖边界（判据 #16）**：`check:doc-refs` 的默认范围只有
`docs/{ARCHITECTURE,ALGORITHM,DATA_PIPELINE,OPERATIONS}.md` 四份，**不含本目录**。
所以上面第三条是**显式**把本文传进去跑的；它只能判「越界 / 路径不存在」，
**判不了「行号对、内容错」**（那需要基线快照，而带日期的时点快照刻意不建基线）：

- ✅ 已被机器核过：本文 §2/§3/§6 中写作**完整 `路径:行号`** 的那些
- 👁 只能人工判读：§3 表格右侧的描述文字、§5 的突变表（判词与 gate 名）

## 5. 突变验证（证明断言**有效**，不只是"跑绿"）

```
RAI_MUTATION_JSON=.workbuddy/runlogs/mutation-2026-10-11.json \
  python3 apps/ios/tests/check-background-mutations.py     # 20m26s，EXIT=0
  → .workbuddy/runlogs/mutation-2026-10-11.log
```

`baseline: exit=0 GREEN` · `restored: exit=0 GREEN` · `mutation check: 100 mutations, 0 failed`
· `verdict_distribution: {RED: 100, COMPILE-ERROR: 1}`（后者是负向对照，**独立于** 100 条）
· `partial: false`（未裁剪，全量跑） · `failures: []`

**本轮新增 5 条**（逐条实测变红）：

| 突变 | 判词 | gate | verdict |
|---|---|---|---|
| 盘上有 `jobId` 时不再续接 | 直接坠进导出路径（重读 HealthKit、旧任务行被覆盖、界面永停在未走完） | `check-background-capabilities.py` | RED `assertion_hit=True` |
| 只问一次就当成结局 | 服务端还在算时就把这一批判成功 | 同上 | RED |
| 只差对账的步被放宽成 `export` | 前台每次进入都重读一遍 HealthKit（GB 级） | `run-health-sync-tests.sh` | RED (exit 132) |
| 让 15 分钟节流吞掉 `jobId` 续接 | 回到前台不再对账已落盘的 job | `check-background-capabilities.py` | RED |
| `.waitJob` 续接不提交记录游标 | 游标停在上一批，下一轮重导一遍 | `run-health-sync-tests.sh` | RED |

第 1 条正是**线上那次的复现**：把它突变掉，门禁报出的就是用户看到的三件事。

## 6. 未纳入本轮：③「导出前短路」——协议层受阻

原议的第三处（*导出前若服务端已是最新，先短路掉整轮导出*）**本轮未做**，原因是它**不是 bug 修复而是协议变更**：

服务端「已是最新」判词来自 `inspection(source)`（apps/api/src/import-sources.ts:583-589），而它的输入 `sourceSha256`
对 HealthKit 上传走 `digestHealthKitExportContent(inputPath)` —— **解压后 `export.xml` 的内容摘要**。

现有一个写入端点与一个**必须带载体**的读端点，两者都在 `apps/api/src/routes/import-routes.ts` 里：
建来源是 `POST /v1/imports/uploads`（apps/api/src/routes/import-routes.ts:38），
而预检是 `POST /v1/imports/inspect`，其 schema 要求 body 里有 `sourceId`
（apps/api/src/routes/import-routes.ts:85）。⇒ **没有 `sourceId` 就没有预检。**
⇒ **不带载荷就问不出"你是不是最新"**。而算 `payloadHash` 又必须先有导出的字节 —— 循环。

因此要在导出前短路，只有两条路，都要单独设计：

- **(a) HealthKit 侧廉价探针**：「按游标还有没有新样本」。它必须**可结构化证明**与"整轮导出后载荷是否为空"等价，
  否则会**静默跳过导入**（放宽既有不变量的典型风险）。
- **(b) 新增端点 + 契约变更**：客户端上报"我上次成功到哪"，服务端比对自身最后成功导入窗口。两侧**必须同批进退**。

**判断**：③ 的收益在 ① 修复后被大幅吸收 —— 原先那次 GB 级重导正是 `.waitJob` 缺失直接造成的。
建议**独立一轮**做，且先做设计；本轮不夹带。

## 7. 未验证项与边界（必须明说）

1. 🔴 **iOS 侧"真的能跑"未验证**：本机只做了**类型检查 + 纯逻辑回归 + 静态结构门禁 + 突变**。
   **没有跑模拟器，也没有真机**。这两处改动都在 App 内（`HealthKitSync.swift` / `HealthKitExport.swift`），
   **必须由小唐用 Xcode 构建安装后才生效**。
2. 🟡 **`.waitJob` 分支在真实服务端上的行为未实测**：`waitForJob` 的成功/超时/`import_job_failed`/404
   四条出口只有静态门禁与纯逻辑回归覆盖，**没有对着真 `GET /v1/import-jobs/<id>` 跑过**。
3. 🟡 **②的进度文案只验证了"不进载荷"**，未验证它在真机上**读起来是否够细**（心率单类型仍是长时间停在
   同一条上 —— 本次只做到"逐类型"，没做到"逐类型内的进度"）。
4. ⚠️ **服务器侧零改动** ⇒ 本轮**不需要部署**；线上流量自 `2026-10-11 08:16` 起仍为 **0** 次
   `imports/uploads` / `imports/inspect` / `import-jobs` 请求，即手机仍在**本地导出**阶段。
5. ⚠️ `MIN_CHECKS` 的**地板语义**：`check-background-capabilities.py` 的 `check()` 是先求值参数，
   所以地板 = 印制总数 − 1（`273` 对应印制 `274`）。抬地板时要按这个口径加，别照抄打印值。
