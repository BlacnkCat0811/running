# 直连同步「尾页超额」根治方案（待审批）

- 日期：2026-10-14
- 基线：`634b97f`（工作区干净）
- 相关设计文档：`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §15
- 现状定性：**不是事故，是结构性缺口的已知边界**。当前靠服务端 8 MiB 上界留出的 6.2 MB 余量兜着；
  一旦服务端上界被调回 2 MiB（历史上是 2 MiB），或某一记录类型的单页体积增大，**立刻复发并卡死同步链**。
- 本文只出方案，**未改任何代码**。批准后再实施。

---

## 1. 结论先行

1. **根因是"提交单位"与"上界单位"不匹配**：服务端按**字节**判上界，iOS 按**页**（`limit: 1000`）提交，
   而预算检查发生在**页已写完盘之后**（`HealthKitRecordCursor.swift:64-69`）⇒ 每批最后一个页整体越界。
   实测越界量 524,305 B（`f7b2bc3` 部署前的真机批：预算 1,887,436 B → 实际 2,411,741 B）。
   预算里的 `× 0.9` 是**比例**余量，无法抵消**绝对值**的页超额 —— 两者不可相加。
2. **唯一根治形态 = 「整页渲染到内存 → 判定 → 整页提交或整页不提交」**（写前判定）。
   "只看当前 offset 再决定要不要读下一页"**无效**（1.86 MB < 1.887 MB 时照样会读下一页并超额）。
3. **写前判定会打破既有"每轮至少前进一整页"的不变式**（`HealthKitRecordCursorRegression.swift:82-83`
   与 `apps/ios/tests/check-healthkit-record-sync.py:140-143` 明文钉住）。**必须同时引入"自适应 query limit"**，
   把前进粒度从"≥1 页"降级为"**≥1 条记录**"，否则自己造出死循环。
   这是本方案最关键、也最容易被漏掉的一环。
4. **不新增任何握手字段、不放宽任何服务端上界**。服务端只做 2 处语义/审计级小修（P3，可单独提交）。
5. 交付分 3 层：**P0 根修（必做）／P1 同族缺口与防死循环（建议同批）／P2 收敛与可观测（可下一批）**。

---

## 2. 多智能分歧与裁决

| # | 视角 | 主张 | 冲突点 | 裁决 |
|---|---|---|---|---|
| 1 | **正确性（上界不可破）** | 必须写前判定：页放不下就整页不提交、锚点回退到**页前** | 与 #2 的"必须前进"直接冲突 | **采纳**。上界是服务端契约，不能靠余量 |
| 2 | **活性（不许死循环）** | 现有设计**故意**接受页超额，就是为了保证"每轮至少推进一页"（`HealthKitRecordCursor.swift:41-46` 明文）；写前判定 + 页前锚点会退化成"永远停在同一处" | 见 #1 | **采纳其约束，不接受其解法**：前进性必须保留，但粒度改为"**≥1 条记录**"（见 §3 的新不变量） |
| 3 | **门禁（不许静默改语义）** | 有 2 条文本判据 + 4 条 Swift 断言**精确钉住**旧语义（`consume` 在 `shouldStop` 之前、`limit: 1000` 字面量、"停止时 anchor = 该页 next"） | 改语义必破 | **采纳**：判据必须**同批改写**成新语义，且新判据要能**突变到红**（纪律 #4） |
| 4 | **协议（契约已承诺）** | `api-contracts/src/index.ts:682` 明文承诺"`direct_sync_payload_exceeds_bounds` ⇒ 收敛拆批预算后重传"，iOS **零实现** | 契约与实现分叉 | **采纳，但降级到 P2**：P0 落地后该路径近乎不可达；它仍是"防卡死"的保险 |
| 5 | **服务端（别加断崖）** | 直连车道的 `maxRecords` **只约束 deletions**（`direct-sync-ingest.ts:440-442`），不约束 XML 记录数；`manifest_exceeds_bounds` 的响应 `bounds` 键错配成 `{maxXmlBytes}` | 客户端 4 个预算维度里 1 个是"单边自律" | **采纳为 P3 知识性修正**，**不新增拒绝路径**（收口刚加过硬拒并被真机引爆过一次） |
| 6 | **范围（最小改动）** | 加握手第 5 个键（如 `maxRecordBytes`）能让客户端算得更准 | `direct-sync-handshake-capability.test.ts:69-74` 用 `deepEqual` **冻结 4 键**，加键即红；且能让 iOS 动到 `DirectSyncBounds`（非 optional 的 `let`） | **否决**：收益小、跨端面大。#3 的自适应 limit 已不需要该字段 |

**裁决后的一句话**：做写前判定，同时把"每轮前进"的粒度从**页**降到**记录**，用一个**自适应 query limit** 同时满足两个约束。

---

## 3. P0 —— 记录侧写前判定 + 自适应 limit（根治本体）

### 3.1 新不变量（替代旧的"每轮至少 1 整页"）

- **I1（有界）**：单批 `export.xml` 字节 `≤ maxXmlBytes`；
  退化态（单条记录本身放不进剩余额度）允许 `≤ maxXmlBytes + 单条记录字节`。
- **I2（前进）**：每轮游标推进 **≥ 1 条记录**（不再是 ≥ 1 整页）。
- 二者可同时成立，因为 `HKAnchoredObjectQuery` 的 `limit` 可缩到 1，且其返回的 anchor 是"**最后一条被返回样本之后**"的锚点 ⇒ 可精确续读。
- **超额上界从"一整页（实测 524 KB）"降到"单条记录（实测均值 359 B）"——约 3 个数量级的改进。**

### 3.2 改动点

| 文件 | 改什么 |
|---|---|
| `apps/ios/RAI/HealthKitRecordCursor.swift` | `drain` 的 `consume` 拆成**两段**：`render(page) -> Bytes` 与 `commit(Bytes)`；判定闭包 `shouldAccept(pageBytes:records:) -> Bool` 在**提交之前**调用；`shouldStop` 不再用于"页末尾停止"。停止时返回**页前锚点**（未提交的页不推进锚点）。新增 `limit` 供应闭包（默认 1000，退化时由调用方收缩） |
| `apps/ios/RAI/HealthKitExport.swift` | `writeGlobalRecords`：页渲染进内存 `Data`（复用现有 `recordXML` / sleep 分支，**逐字节等价**），判定通过才 `write(xml, buffer)`；维护"上一页实测 B/条"用于估算收缩后的 limit；退化提交时记 warning |
| `apps/ios/RAI/DirectSyncBatchBudget.swift` | 只加**判定辅助**（`accepts(xmlBytes:records:adding:)`）与"剩余额度"派生；**不加 stored 字段**（加无默认值字段会撞 `DirectSyncBatchBudgetTests.swift:33-38`（`DirectSyncBounds` 四字段字面量）/ `:48-50`（`DirectSyncBatchBudget` 四字段字面量）的成员逐一初始化） |

### 3.3 算法（伪码，顺序即判据）

```
offset = xml.offsetInFile ; count = 0 ; pageBytesPerRecord = nil
limit = 1000
loop:
  page = query(anchor, limit)                       // limit 可被收缩
  buffer = render(page)                             // 内存，不落盘
  if offset + buffer.count <= maxXmlBytes && count + page.count <= maxRecords:
      commit(buffer) ; offset += buffer.count ; count += page.count
      anchor = page.next ; pageBytesPerRecord = buffer.count / max(1,page.count)
      if 空页: return (anchor, hasMorePages: false)
      limit = 1000 ; continue                       // 本页装下了，回到满页
  else if limit > 1:
      // 本页装不下且还没到底：收缩 limit 重查同一锚点（不提交、不推进锚点）
      limit = clamp(1, floor((maxXmlBytes - offset) / pageBytesPerRecord))
      continue                                      // limit 严格下降 ⇒ 有限步终止
  else:
      // 退化：连 1 条都放不进剩余额度 ⇒ 提交它（保证 I2），额度略微超出
      commit(buffer) ; anchor = page.next ; count += 1
      warning("单批预算不足以容纳单条记录，已按单条提交")   // 必须可观测
      return (anchor, hasMorePages: true)
```

- **终止性证明**：分支 2 每次让 `limit` 严格下降且 ≥1 ⇒ 至多 4 次（1000→估算值→1）；分支 3 必定提交并推进锚点。
- **确定性**：收缩值由**实测** `pageBytesPerRecord` 算出，同输入同结果（`check-export-determinism.py` 的前提不变）。
- **性能**：收缩只在**每批每个类型的最后一页**发生 ⇒ 每批最多多 1–2 次 query。

### 3.4 必须同批改的门禁与测试（不改就会红 / 或改完变假绿）

| 位置 | 现状 | 必须改成 |
|---|---|---|
| `apps/ios/tests/check-healthkit-record-sync.py:142-143` | `ordered(cursor,"try consume(...)","if shouldStop()")` —— **钉住"先消费后判定"** | 改成钉"**先渲染+判定、后提交**"的顺序，并**新增**三条判据：①提交前有判定；②停止时不推进锚点（返回页前锚点）；③存在 `limit` 收缩路径 |
| `apps/ios/tests/check-healthkit-record-sync.py:58` | 钉字面量 `limit: 1000` | 钉"满页上限 1000 且**可被收缩**"，而不是钉死字面量 |
| `apps/ios/tests/HealthKitRecordCursorRegression.swift:67-71` | `stopped.anchor == 2`（= 该页 next）、`budgetConsumed == ["p1","d2"]` | 断言改为"装不下 ⇒ 零提交 + anchor = 页前锚点"；补"装得下 ⇒ 提交 + 前进" |
| `apps/ios/tests/HealthKitRecordCursorRegression.swift:82-83` | `extreme.anchor == 1 && extremeQueried == [nil]` —— 钉住"**永远超预算也每轮前进一页**" | **不要删这条不变式**，改为"**永远超预算也每轮前进 ≥1 条**"（`extremeQueried == [nil, nil]` 且最终提交 1 条）。**它是 I2 的守卫，删了就是自己造死循环** |
| `apps/ios/tests/DirectSyncBatchBudgetTests.swift` | 4 字段构造 | 补：`accepts(...)` 边界（恰好等于上界 / 超 1 B / 记录数维度） |
| `apps/ios/tests/check-background-mutations.py:1277-1296` | 锚点改 `HealthKitSync.swift` 的 `hasMorePages` / `continuationPending` 两行 | **只要不动这两行就不受影响**；一旦动到必须同步改锚点 |
| `apps/ios/tests/check-export-determinism-live.py:183-189` | 手工编译清单 | 若 P0 新增 `.swift` 文件，**必须加进该清单**（否则探针编译失败） |

- 🔴 **突变验证是交付条件**：新增/改写的每条判据必须能**突变到红**（含"方法仍在、逻辑失效"那一次，避免红的只是 `ReferenceError`）。
- 🔴 `npm run test:ios` 必须**真检查了源码**（无 Xcode 的"跳过"不是通过证据；pre-commit 有认账哨兵）。

### 3.5 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| 同一 anchor 下不同 `limit` 的结果集合**不是前缀关系** | 中 | 正确性不依赖前缀（重查时**整页丢弃**，只用同锚点重取后的结果）；仅影响"这一批包含哪几条"的确定性。**必须真机验证**：断言"收缩重查后不丢记录、不重复记录"（比对 `healthkit_record_facts` 计数与 uuid 集合） |
| 内存峰值 +1 页（典型 ≈360 KB，最坏 = 满页 × 单条最坏字节） | 低 | 单页 buffer 由 `limit` 收缩自然封顶；退化态 limit=1 ⇒ 峰值 = 单条 |
| `HKAnchoredObjectQuery` 对 `limit=1` 的行为与性能 | 中 | 只在退化态触发（每批极罕见）；真机实测一次 1000 条 → 断言 query 次数与 wall time |

---

## 4. P1 —— route 同族缺口 + 防死循环（建议同批）

### 4.1 P1a：route 整文件判定（同族，不是可选项）

- 现状：`HealthKitExport.swift:388-406` 的闸门是"**先判后取**"（预算满则不 fetch），但**一个 workout 的 GPX 一旦 fetch 就直接落盘**（`HealthKitExport.swift:397`）⇒ 超额上界 = **一个 GPX 文件**（本次实测 34,009,725 B / 58 文件 ≈ 586 KB 均值，最坏可达数 MB）。
- 改法：`routeEntries` 渲染到**临时文件**→ 判定 `routeBytes + 本次字节 ≤ maxRouteBytes && routeFiles + n ≤ maxRouteFiles` → 通过才 move 进载荷目录；不通过则**不写、不改状态**（与"状态与文件同进同退"同一纪律）。超额从"一个 GPX"降到 0。
- 🔴 会撞 `apps/ios/tests/check-background-capabilities.py:1504-1572` 的 route 循环**冻结串**（`routeDecisions[` 只出现 1 次、`hasWorkoutChange: hasWorkoutChange` 恰好 2 次、`routeFiles = []`、`fetch.observation` 等）⇒ **必须同批改该门禁**，否则新增一条失败。
- ⚠️ 该循环的**结束定界符**是整行 `await onProgress("正在读取心率与恢复数据")`（`HealthKitExport.swift:446`，注释 :441-445 已声明它是定界符）⇒ **一个字都不能改**。

### 4.2 P1b：修掉"inspect 400 → 死循环"（与 P0 独立，即使 P0 到位也应修）

- 现状（三处叠加）：
  1. `HealthKitSync.swift:2424` 的 `withRetry` 对 4xx **不重试**、直接抛；
  2. inspect 的 400 **不经过** `SyncUploadRecovery.contentRejectionStatuses`（那套是 **upload** 端点的 400），只进了 catch ⇒ 只改**内存** phase；
  3. `SyncPhase.swift:163` 的 `nextStep` 只看 `sourceId != nil` ⇒ 恒 `.inspect`；磁盘行仍是 `uploaded` ⇒ **重启也重撞同一批**。
- 改法（最小）：inspect 失败时把"本批已确定性失败"**落盘**（`SyncTaskStore` 写 phase/失败码），并让 `nextStep` 对"已失败且无收敛路径"的批次给出**显式出口**（清 `sourceId` 走重导，或明示维护文案），而不是无限 `.inspect`。
- 判据：真机或单测断言"同一批 400 之后**不会第 2 次**发 inspect"。

---

## 5. P2 —— 收敛与可观测（**状态更正 2026-10-15**：P2a 已于 10-14 落地、P2c 已合入；正文保留为设计记录）

| 项 | 内容 | 判据 |
|---|---|---|
| **P2a** | 兑现契约承诺（`packages/api-contracts/src/index.ts:682`）：`direct_sync_payload_exceeds_bounds` ⇒ **收敛拆批预算后重传**。落点 = **inspect 的 catch**（不是 `SyncUploadRecovery`）。在 `SyncPhase.disposition` 的**状态码判断之前**新增 code 分支 ⇒ 新 `Action.convergeBudget`（Swift 穷尽 switch 会在编译期逼出所有消费点）；收敛标记**必须持久化**（否则下次同步又用满预算重撞） | 单测：给定该失败码 ⇒ 下一轮 `DirectSyncBatchBudget` 确实变小；且**不会删除已成功的批次** |
| **P2b** | 导出后、上传前**本地产物自校验**：用本地实际 `export.xml` 大小 + route 字节数 + 文件数，对比**服务端上界**（不是 ×0.9 的预算，留安全垫）⇒ 超界则**不发** inspect/upload，就地收敛。这是"接收端之外的第二个守卫"，把 400 变成**本地可判定** | 单测：造一个"略超界"的产物 ⇒ 断言**没有发生网络请求** |
| **P2c** | 可观测：`budgetExceeded`（现仅成为 `sync_continuation` 哨兵，`HealthKitExport.swift:44`、**不上屏、不落日志**）、停止原因、收敛事件 —— 至少要能回答"这批为什么被截断/为什么卡住" | 用**阳性对照**：人为造一次截断 ⇒ 断言能在状态/日志里看到可区分的信号。**✅ 2026-10-15 已落地**：`HealthKitSync.exportMessage` 的尾注携带 `budgetStopReason` 的三种形态文案（`budgetStopNote`）；`HealthKitExport.swift` 的"轨迹写入后未找到"也补了可见告警 |

> P2b 的可行性已核实：服务端判据用的就是**真实产物**（`export.xml` 的 `statSync().size` 与 route 的磁盘字节累加），
> 而这两个数客户端**本来就有** ⇒ 自校验是精确的，不需要新增协议。
> ⚠️ 但 **不能**把"上传前 dry-run"寄托在服务端：`/v1/imports/inspect` 需要先上传 ZIP（`sourceId` 是必填），
> 上传那一刻就已经把产物送出去了 ⇒ 服务端侧没有"先验大小再决定收不收"的通道。
> 但服务端的**意图**是明确的：`apps/api/src/direct-sync-ingest.ts:390-395` 的注释明写 inspect 的 400 是
> "**不建 job、零副作用**；客户端可据此拆批" ⇒ 契约与设计意图一致，缺的只是 iOS 那一半实现。
> 同时 `:368` 证实 route 字节口径 = `statSync().size`（磁盘字节），与 iOS 累计口径一致。

---

## 6. P3 —— 服务端语义/审计小修（可单独提交、单独回滚）

| 项 | 位置 | 内容 | 风险 |
|---|---|---|---|
| P3a | `apps/api/src/direct-sync-ingest.ts:424,430` | `manifest_exceeds_bounds` 的响应 `bounds` 被写成 `{ maxXmlBytes }` ⇒ manifest 的判据**复用了 xml 的上界常量**，响应键名却报成 `maxXmlBytes` ⇒ 审计时无法区分"manifest 超了"还是"xml 超了"。改成语义正确的键，或显式标注"共用同一上界" | 🔴 改前必须 grep 该 key 的消费方；`direct-sync-handshake-capability.test.ts:69-74` 冻结的是**握手**四键，不受影响 |
| P3b | `apps/api/src/direct-sync-ingest.ts:439-443`（拒因码是 `deletions_exceed_bounds`，已正确映射到
`direct_sync_payload_exceeds_bounds`，见 `apps/api/src/import-worker.ts:128-132` —— 这条链路是完整的，别误报成缺口） | `DIRECT_SYNC_MAX_RECORDS` 在直连车道**只约束 deletions**，不约束 XML 记录数 ⇒ 客户端 `maxRecords` 维度是"客户端单边自律"。**建议只在契约注释里注明**，**不**新增服务端拒绝路径 | 新增断崖 = 又一次"收口后 400 卡死"风险 |

---

## 7. 明确不做（被否决的替代方案）

| 方案 | 否决理由 |
|---|---|
| 在客户端**预留"一整页"的常量**再从预算里扣 | 启发式：页字节随记录类型变（心率 1000 条 ≈ 100 KB，带大 metadata 的样本可大得多）⇒ 要么留得太保守浪费容量，要么仍被超大页击穿。**不是根治** |
| 只把"预算再放宽一点"或继续靠服务端 8 MiB 余量 | 纪律 #13：为微小收益放宽既有不变量 ⇒ 默认作废。余量是**兜底**，不是**判据** |
| 加握手第 5 个键（`maxRecordBytes` 等） | 撞 `direct-sync-handshake-capability.test.ts` 的 `deepEqual` 四键冻结，且 iOS `DirectSyncBounds` 是非 optional `let` ⇒ 跨端面大；P0 的自适应 limit 已不需要 |
| 把页大小从 1000 改成 200（单行改动） | 只把超额上界从 ~524 KB 缩到 ~105 KB，**缺口仍在**；且 query 次数 ×5。**仅在 P0 真机验证失败时作为降级备选** |
| 服务端接受"轻微超额"的批 | 削弱硬上界 ⇒ 与 §14 的"有界写入"直接冲突 |

---

## 8. 验收标准（分级，缺一不可）

**本机可验（必做）**
- `npm run test:ios` **EXIT=0**，且日志里**确实检查了 iOS 源码**（不是"跳过"）。
- `npm run check:ios-gates`（Windows 侧也能跑的那条）EXIT=0。
- 新增/改写的判据**逐条突变到红**（`npm run test:ios:mutation`，或手工突变 + 回读）。
- `npm run typecheck` 与 `npm test`（node 侧）EXIT=0；typecheck **单独**跑并单独报。

**真机必验（唯一有效证据，本机沙箱无法验证 HealthKit）**
1. 造一个"剩余额度 < 一页"的批 ⇒ 断言 `export.xml` **严格 ≤** 预算（当前会超出 524 KB 量级）。
2. 造一个 **>8 MiB** 的历史回填批 ⇒ 每批 ≤ 8 MiB，**且水位持续推进**（不卡在同一批）。
3. **不丢不重**：停止/续批前后 `healthkit_record_facts` 的 uuid 集合与条数一致；`route_points` 只增不丢。
4. `import_manifest` 的 `rai.applied-import.*` **不带 `backupName`**（= 确实走的直连车道，唯一线上信号）。

**报告口径**：写清"哪台机器 + 等价性证据 + 数据口径"；性能类结论只写"同条件下旧/新对比"，不写绝对阈值。

---

## 9. 回滚方案

- P0/P1/P2 全部是 **iOS 源码 + 门禁 + 文档**：无迁移、无数据变更、无服务端行为变化
  ⇒ 回滚 = `git revert <commit>`（逐项独立提交，便于只回滚某一层）。
  ⚠️ **实施后修正**：iOS 侧**不可按 P 拆分**（P0 与 P1a 在 `HealthKitExport.swift` 的返回值上
  编译期耦合）⇒ 实际分组见 §11.6。
- P3 是**服务端独立提交**，可单独 `revert` + pull + restart（无 build、无迁移）。
- **不加"条件性开关"**（纪律 #14：加开关前要 grep 所有会拒绝它的检查；这里回滚成本本来就很低，开关只增加失效面）。

---

## 10. 待小唐决策的三点

1. **范围**：只做 P0（根治本体），还是 P0+P1 同批（连带修 route 同族缺口与死循环）？
   我的建议：**P0+P1 同批**。P1b 的死循环与 P0 无关，且它是"收口后遗症"的最后一块，单独留着迟早再被真机引爆。
2. **节奏**：P2a/P2b 是否本批做？我的建议：**P2b（本地产物自校验）成本最低、价值最高，建议并入 P1**；P2a/P2c 下一批。
3. **P3 是否动服务端**：动则多一次部署；不动则留一条"审计键错配"的注记。我的建议：**只做 P3a（遥测键修正）**，且先 grep 消费方。

---

## 附：本方案的关键证据索引

| 事实 | 证据 |
|---|---|
| 预算检查在页末尾、页已写盘 | `apps/ios/RAI/HealthKitRecordCursor.swift:64-69` |
| 页粒度 = `limit: 1000` | `apps/ios/RAI/HealthKitExport.swift:1013` |
| 单条记录均值 359 B / 一页 ≈ 359 KB（XML 压缩前） | `.workbuddy/memory/2026-10-14.md` §「实测压缩率」 |
| 真机超额量 524,305 B | 同上，§「🔴 2 MiB 硬上界 vs iOS 页边界停止」 |
| 服务端 xml 判据 = `statSync(export.xml).size` | `apps/api/src/direct-sync-ingest.ts:417-421`（另 :456-461 二次按 `Buffer.byteLength` 校验） |
| 服务端判据顺序：route **先于** xml | `apps/api/src/direct-sync-ingest.ts:370` vs `:419` |
| 握手四键的单一来源 = 顶层常量 | `apps/api/src/server.ts:958-963` ← `direct-sync-ingest.ts` 常量 |
| 握手四键被 `deepEqual` 冻结 | `apps/api/test/direct-sync-handshake-capability.test.ts:69-74` |
| `maxRecords` 只约束 deletions | `apps/api/src/direct-sync-ingest.ts:439-443`（拒因码是 `deletions_exceed_bounds`，已正确映射到
`direct_sync_payload_exceeds_bounds`，见 `apps/api/src/import-worker.ts:128-132` —— 这条链路是完整的，别误报成缺口） |
| `manifest_exceeds_bounds` 的 bounds 键错配 | `apps/api/src/direct-sync-ingest.ts:424,430` |
| 契约承诺"收敛拆批"但 iOS 零实现 | `packages/api-contracts/src/index.ts:682`；全仓无 `direct_sync_payload_exceeds_bounds` 消费分支 |
| inspect 400 走 withRetry 直接抛（不重试 4xx） | `apps/ios/RAI/HealthKitSync.swift:2424` |
| 400 进 `contentRejectionStatuses` 的那套是 **upload** 端点 | `apps/ios/RAI/SyncPhase.swift:232,271` |
| 死循环：nextStep 只看 `sourceId != nil` | `apps/ios/RAI/SyncPhase.swift:163` |
| 预算每轮同步新建、来自新鲜握手（无缓存） | `apps/ios/RAI/HealthKitSync.swift:1352` |
| 导出后**无任何**本地字节自校验 | 全仓无对应实现（已 grep 确认） |
| `budgetExceeded` 不上屏/不落日志 | `apps/ios/RAI/HealthKitExport.swift:44-50`、`apps/ios/RAI/SyncTaskStore.swift:537-546` |
| route 闸门"先判后取"但 fetch 后直接落盘 | `apps/ios/RAI/HealthKitExport.swift:388-406` |
| 旧语义被文本判据钉住 | `apps/ios/tests/check-healthkit-record-sync.py:58,142-143` |
| "永不死循环"不变式被断言钉住 | `apps/ios/tests/HealthKitRecordCursorRegression.swift:82-83` |
| route 循环冻结串 | `apps/ios/tests/check-background-capabilities.py:1504-1572` |

---

## 11. 实施与验收记录（2026-10-14 20:00–21:xx，**时点快照**）

> ⚠️ 本节是**某个时点**的实跑输出，不是"当前值"。行号与计数都会随提交漂移；
> 复核时请以「同一命令 + 同一提交」为准，不要照抄数字。

### 11.1 改动清单（14 文件 + 1 新增文档）

| 层 | 文件 | 内容 |
|---|---|---|
| P0 | `apps/ios/RAI/HealthKitRecordCursor.swift` | `drain` 改「渲染 → `decide` → `commit`」，`PageDecision{accept, retryWithLimit}`，收缩夹紧 |
| P0 | `apps/ios/RAI/DirectSyncBatchBudget.swift` | `accepts(...)` 取代 `exceeded(...)`，新增 `shrinkLimit(...)` |
| P0/P1a/P2b | `apps/ios/RAI/HealthKitExport.swift` | `budgetStopReason` / `xmlBytes` / `routeBytes` 上产物；route 调用点写前判定 |
| P1b | `apps/ios/RAI/HealthSyncCancellation.swift` | 新增 `.convergeBudget` + `batchExceedsBoundsCode`，**先判 code 后判状态码** |
| P1b/P2b | `apps/ios/RAI/HealthKitSync.swift` | `budgetConvergence` 持久化 / 有界重导循环 / `clearBudgetConvergence` 进 `if full {` 块 |
| P3a | `apps/api/src/direct-sync-ingest.ts` | 两处 `manifest_exceeds_bounds` 的 `bounds` 键 → `maxManifestBytes` |
| P3b | `packages/api-contracts/src/index.ts` | `directSyncBounds` 注释（8/64 MiB、`maxRecords` 只约束 deletions） |
| P3c | `docs/SQLITE_DIRECT_SYNC_DESIGN.md` | §15「已知边界」→「已根治」 |
| 门禁 | `check-healthkit-record-sync.py`（49）· `check-background-capabilities.py`（284）· `check-healthkit-record-sync.py` 的 S2.5 四条 | 新增结构判据 |
| 回归 | `HealthKitRecordCursorRegression.swift`（32）· `DirectSyncBatchBudgetTests.swift`（42）· `HealthSyncResumeRegression.swift` | 新增行为判据 |
| 服务端测试 | `apps/api/test/direct-sync-ingest.test.ts` | 新增源码级判据（含反向对照） |

### 11.2 门禁实跑

| 命令 | EXIT | 判据 / 输出 |
|---|---|---|
| `npm run test:ios` | **0** | `iOS 门禁通过（类型检查 + 纯逻辑回归）`；内含 `typecheck-ios.sh`（**93 文件**）与 `run-health-sync-tests.sh`（record sync `49/0`、route state persistence `66`、TrainingPlanStore `34`） |
| `npm run typecheck` | **0** | `tsc --noEmit`（**单独跑、单独报**） |
| `npm run check:ios-gates` | 1 | 10 支里 **9 支绿 / 1 支红**；唯一红是**预存在**的 `check-pr5-facts-analysis.py`（见 11.4） |
| `apps/ios/tests/check-healthkit-record-sync.py` | 0 | `49 checks, 0 failed`（新增 S2.5 四条） |
| `apps/ios/tests/check-background-capabilities.py` | 0 | `284 checks, 0 failed`（新增 14h-9 / 14h-10 共 7 条） |
| `apps/ios/tests/check-health-sync-archive.py` | 0 | `19 checks, 0 failed` |
| `npm run check:doc-refs` | 0 | 139 处引用、越界 0、漂移 0（**只含 `DEFAULT_DOCS`**） |
| `npm run check:doc-refs -- deliverables/…PLAN….md` | 0 | **41** 处引用、越界 0、漂移 0（新文档**必须显式传路径**才有覆盖） |
| `npm run check:doc-refs -- docs/SQLITE_DIRECT_SYNC_DESIGN.md` | 0 | **0 处引用** ⇒ 门禁如实报 `NOT CHECKED`（该文档不用 `文件:行号` 写法；**不是**假绿） |
| `npm run check:docs` | 0 | 430 条局部链接、0 问题（修掉了本轮引入的「新交付文档不可达」） |
| node 套件（**223 / 224** 文件，排除 `deploy-n100.test.ts`） | 1 | **pass 1782 / fail 1**（墙钟 1513 s）；唯一失败见 11.4b |

> `npm test` **原样跑在本沙箱跑不完**（`deploy-n100.test.ts` 永久阻塞，见 11.5）⇒ 上表用
> 「同一份文件清单减去 1 个文件」的等价跑法。**仓库未改、测试未调弱。**
> 本批改动的 node 侧判据在全量运行中实测通过：`ok 179`（握手能力位冻结）、
> `ok 183`（A17 前提）、`ok 196`（P3a 源码级判据）、`ok 197`（超限载荷带码拒收）。

### 11.2b web 侧（vitest，**与 node 侧分开报**）

| 命令 | EXIT | 判据 |
|---|---|---|
| `node <vitest.mjs> run`（cwd = `apps/web`） | **0** | `Test Files 25 passed (25)` / `Tests 185 passed (185)` / `Duration 428.12s` |


### 11.3 突变证据（纪律 #4：跑绿 ≠ 断言有效）

6 处定点突变 **6/6 全部红** —— 但脚本自身标了 `BAD` 两处，原因是**脚本的 `expect` 字符串写错**
（不是突变没被抓住）。回读日志确认两条都红在**目标断言**上：

| # | 突变 | 结果 | 红在哪（原文） |
|---|---|---|---|
| M1 | 去掉 `drain` 的收缩夹紧（`requested` 不再被用） | ✅ 抓住 | `Precondition failed: the rejected page is re-queried from the same anchor (once at the full limit, once shrunk), never skipped` |
| M2 | route 改成"先落盘再判预算" | ✅ 抓住 | `ordered` 判据（写盘先于 `routeBudgetExhausted`） |
| M3 | 删掉 inspect catch 的 `.convergeBudget` 分支 | ✅ 抓住 | `FAIL: the inspect catch no longer handles .convergeBudget — …` |
| M4 | `halved()` 允许落到 0 | ✅ 抓住 | 地板判据 |
| M5 | `disposition` 把 code 判据挪到状态码之后 | ✅ 抓住 | policy 分支判据 |
| M6 | 把 manifest 的 `bounds` 键改回 `maxXmlBytes` | ✅ 抓住 | 源码级判据 + 反向对照 |

六个文件**均逐字节还原**（`restored=True`）；日志在 `.workbuddy/runlogs/mutation-0*.log`。

### 11.4 预存在失败（**不是本批引入**）

`npm run check:ios-gates`：**10 支里 9 支绿，1 支红** —— `check-pr5-facts-analysis.py`
（13 checks / 3 failed），失败原因全部指向缺生成物
`var/reports/pr5-c9-baseline-keys.json`（`var/` 被 `.gitignore:4` 忽略，是手工产物）。

**证明它与我无关的三个证据**：
1. **干净树对照**（纪律 #8）：`git worktree add … HEAD --detach` 后同一条门禁输出**逐字一致**
   （含 `@ None（0 个 interface）`）⇒ 在未改动的 HEAD 上同样红。
2. 该门禁**不引用**本批改动的任何字段；我对 `packages/api-contracts/src/index.ts` 的改动
   **全是注释行**（`git diff -U0` 的 11 个新增行全部以 `*` 开头）。
3. 该 baseline **无生成脚本入库**（全仓只有门禁与一份 2026-10-13 交付文档提到这个路径），
   重建需要当初那批决定的接口清单 ⇒ 不擅自伪造基线。

### 11.4b 第二条预存在失败（node 套件里的 `fail 1`，**不是本批引入**）

`packages/storage-sqlite/test/connection-contention.test.ts`
→ `not ok 1553 - open() retries past a concurrent writer and reaches WAL once the lock is released`
（`open() 只用了 109 ms —— 没有在锁上等过`）。

**判据要落在这三处**：

1. **已记录的既有红**：`deliverables/README.md:38` 明写
   「（`deploy-upgrade` 的 `backup-reminder` 断言、`connection-contention` 的锁等待窗口），
   三次复现稳定、均不在本批 diff 内」—— 这是 2026-10-13 那批就已经登记过的。
2. **不在本批 diff 内**：`git diff --name-only | grep storage-sqlite` 为空；
   `git status --porcelain packages/storage-sqlite/` 为空（该目录逐字节等于 HEAD）。
3. 🔴 **它的输入集里没有任何我能影响的东西**（比"干净树对照"更硬）：该文件
   **只 import Node 内置模块**（`node:assert/strict`、`node:child_process`、`node:fs`、
   `node:os`、`node:path`、`node:sqlite`、`node:test`），连仓库自己的包都不引；被测行为
   由**内联 `-e` 子进程 + 时序**决定（`:146` 断言 `waited >= 200ms`，而持锁窗口只有 600 ms，
   子进程 tsx 启动开销吃掉大部分窗口）。
   ⇒ **隔离单跑同样红**（`pass 1 / fail 1`），且与并发无关。


### 11.5 本沙箱的环境坑（一次真实踩坑，值得记）

**现象**：`npm test` 跑不完 —— 日志墙钟无限增长、零新增（两次实测：13 分 29 秒、14 分 51 秒，
日志停在 1070 行）。逐用例定位到 **`apps/api/test/deploy-n100.test.ts` 的 3 个用例永久阻塞**：

| 用例 | 结果 |
|---|---|
| `whole-runtime backup defaults dry-run …` | ✅ pass |
| `whole-runtime backup includes control/artifacts and restores **active** service state` | 🔴 永久阻塞 |
| 同上（**inactive**） | 🔴 永久阻塞 |
| `failed backup removes partial output …`（`TEST_FAIL_TAR=1`） | ✅ pass |
| `backup reports service restart failure …`（`TEST_FAIL_START=1`） | 🔴 永久阻塞 |
| `home deployment templates keep private bind addresses …` | ✅ pass |

**根因**（不是 tar 二进制的问题，也不在本批 diff 内）：

1. 该文件用 **`bash -c 'cygpath … || command -v tar'`** 经 PATH 解析 `tar`（`:38` 的 `resolveTarPath()`，
   注释里原来就是为了防 Windows 的 fork 炸弹）；阻塞的 3 个用例恰好都走到
   `deploy/backup-runtime.sh:69` 的 **成功创建 tar** 那一步（失败的 tar 用例反而通过）。
2. 本会话环境设了 **`BASH_ENV`/`CODEBUDDY_BROKERED_SHELL_ENV`**，bash 启动时会把沙箱 shim 目录
   **重新前置到 PATH 首位**。实测：

   ```
   $ PATH="/tmp/rai-realbin:/usr/bin:/bin" bash -c 'echo $PATH | tr ":" "\n" | head -4'
   …/cli/vendor/shim/brokered-bin     ← 被重新前置
   /tmp/rai-realbin
   /usr/bin
   /bin
   $ PATH="/tmp/rai-realbin:/usr/bin:/bin" command -v tar   # zsh 内建，不经 bash 启动文件
   /tmp/rai-realbin/tar
   ```

   ⇒ **任何经 `bash -c` 解析可执行文件的仓库测试都会拿到沙箱 shim，与调用方设的 PATH 无关**。
   `command -v tar` 于是恒为 `…/brokered-bin/tar -> zip`（需 broker 批准）。
3. 替身 tar 再以 **`stdio: "inherit"`** 去 spawn 这个 shim（`:97`），在 node 测试子进程里阻塞。

**这与本批改动无关的三条证据**（纪律 #8）：

1. 该测试文件与其全部输入（`deploy/backup-runtime.sh`、`deploy/n100/*`）**与 HEAD 逐字节相同**
   （`git status --porcelain apps/api/test/deploy-n100.test.ts deploy/` 为空）；
2. 其输入集 **完全不相交** 于本批 diff（`git diff --name-only | grep '^deploy/'` 为空）；
3. 它用到的沙箱原语单独跑都正常（`bash -c true` 36 ms、brokered tar 创建归档 92 KB / EXIT=0、
   列出归档 EXIT=0、`rm -rf` EXIT=0）⇒ 阻塞是**嵌套 spawn + stdio inherit** 的交互，不是某个工具坏了。

**可验收的替代跑法**：节点套件 **排除** `deploy-n100.test.ts` 后跑（文件发现仍用
`scripts/run-tests.mjs` 的 `nodeTestFiles()`，只过滤一个文件），见 §11.2。**仓库不改、测试不调弱。**


### 11.6 提交分组（**偏离 §9 的"逐项独立提交"，附证据**）

§9 原写"逐项独立提交，便于只回滚某一层"，实施后发现**iOS 侧不可按 P 拆分**：

- `HealthKitExport.swift` 的 P0 与 P1a 改动块**在编译上互相依赖** —— 返回值同时含
  `budgetStopReason`(P0) 与 `routeStopReason`(P1a)，`HealthKitExport.swift:554` 的
  `records.budgetStopReason ?? routeStopReason` 把两者绑在同一个表达式里。
- 拆成"只编译 P0"的中间节点必须**手工构造中间版本** ⇒ 正是纪律 #10 说的
  「最终态绿 ≠ 每个提交可用」的雷区（而且那个中间态从未被真机验证过）。

⇒ 采纳的分组：**① iOS 全部（P0+P1a+P1b+P2b）② 服务端 P3a ③ 契约 P3b ④ 设计文档 P3c
⑤ 本方案 + `deliverables/README.md` 索引**。
iOS 侧天然原子：它随同一个 app 构建发布，回滚粒度本就不必细于"一次构建"。

### 11.7 未验项（如实标注）

- **真机 4 条**（§8）本机沙箱**无法验证**（HealthKit 不可用）⇒ 唯一有效证据仍待真机。
- P2a / P2c 按批准**留待下一批**（本批只做 P2b）。 ⚠️ **2026-10-15 口径更正**：P2a（`convergeBudget` +
  持久化收敛档）实际已于 10-14 随尾页根治同批落地；P2c（截断原因尾注 + 轨迹缺失告警）于 10-15 审查后合入。
  两处状态以 `deliverables/IOS_BACKEND_AUDIT_2026-10-15.md` 的修复记录为准。
- node 侧与 web 侧（vitest）**分开报**（见 11.2 / 11.2b），不合并成一个"全绿"。

