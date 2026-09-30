# iOS 导出确定性 — P0/P1 验证与第四条通道

> 日期：2026-09-23　范围：P0（iOS 三处确定性）与 P1（服务端 `stableId` 规范化）
> 的**独立验证**，外加验证过程中新发现的一条服务端通道。
> 承接：`IOS_EXPORT_DETERMINISM_FIX_PLAN_2026-09-22.md`、
> `IOS_EXPORT_DETERMINISM_P0P1_IMPLEMENTATION_2026-09-22.md`
>
> 结论先行：**上一轮"修完 A/B/C + stableId 就能让服务端判 unchanged"的结论是错的。**
> 实测存在第四条通道（D），它在 `ExportDate` 上，位于服务端，**不修则 `unchanged`
> 在生产上永不可达**——即使 iOS 侧变得完全确定。本轮已修 D 的最小面并留下守卫。

---

## 0. 一句话结论

| # | 结论 | 分级 | 性质 |
|---|---|---|---|
| 1 | **P0-1 已获得真执行证据**：在模拟器里编译并运行 `HealthKitExport.metadataXML`，三次独立进程输出字节完全一致；去掉 `.sorted()` 后确实随进程变化 | 🟢 已闭环 | 实测 |
| 2 | **新发现第四条通道 D**：`<ExportDate>` 墙钟 → `source_xml_sha256` → `dataset_version` 漂移 → `analyzeDatasetChange` 判 `data-only`，**`unchanged` 永不可达** | 🔴 已修（最小面） | 实测 |
| 3 | `data-only` 的代价接近"全套活"：仍会全库备份、复制 staging、完整 parseImport，并**用 staging 替换主库**；只有 `unchanged` 才早退 | 🔴 已由 #2 的修复解除 | 读代码 + 实测 |
| 4 | 上一轮的 P1 守护测试**绕过了生产路径**（不经 `cli.ts` 的 `dataset_version` 写入），因此它在 D 存在时仍然是绿的 | 🟡 已补测 | 实测 |
| 5 | `source_xml_sha256` 自身仍含导出时间，影响 `import_batches.xml_sha256`（审计）与 `model_runs.dataset_version`（版本标记）；治本需 TS+Rust 双侧剥离 | 🟡 待排期 | 读代码 |

---

## 1. 本轮验证手段

### 1.1 模拟器：真执行被 `#if os(iOS)` 锁住的代码

上一轮把 P0 的验证退化成"grep 源码形状"，理由是
（`apps/ios/tests/run-model-tests.sh:79-84` 的注释）：

> `HealthKitExport.swift` 整个文件被 `#if os(iOS)` + `import HealthKit` 锁死，
> helper 全是 `private static`，于是"跑两遍断言字节相同"在本机走不通。

**这个理由只对了一半。** 走不通的是 *macOS* 目标；**iOS 模拟器目标可以编译并执行**。
本轮实测（spike，非推测）：

```
isHealthDataAvailable: true
workoutUUID: 3640EB94-...
metadataKeysUnsorted: ["b_key", "a_key", "HKIndoorWorkout"]
sortDescriptorKeys: [Optional("startDate"), Optional("endDate")]
```

即：**模拟器上不签 HealthKit entitlement 也能构造 `HKWorkout`、读 `metadata`、
构造 `HKSampleQuery` 并读回 `sortDescriptors`**。只有触碰 `HKHealthStore`
（授权 / 查询）才会按设计 fail closed。而这恰好是 P0 关心的全部范围。

### 1.2 为什么必须跨进程比较

缺陷的机理是 `for (key, value) in metadata` 走 Swift `Dictionary`，其迭代顺序来自
**每进程**的哈希种子。同一进程内调两次结果相同；两个进程不保证相同。
**因此"同一进程调两次比较"这种测试在坏代码上也会通过，什么也证明不了。**

实现见 `apps/ios/tests/check-export-determinism-live.py`：把探针编译进一个
最小 `.app`，`simctl install` 后**反复 `launch`**（每次新进程），跨启动比字节。

两个必须记住的实现细节（都是踩过的）：

- 探针入口必须写成 **`extension HealthKitExport`**（`private` 对"enclosing
  declaration 及其同文件 extension"可见，普通顶层 struct 访问不到）；
- HealthKit 在**构造 `HKWorkout` 时**校验 metadata：给了
  `HKMetadataKeySyncIdentifier` 就必须同时给 `HKMetadataKeySyncVersion`，
  否则抛 `_HKObjectValidationFailureException`。

### 1.3 云服务器：只读取证，不写

`~/.ssh/` 不存在，`deploy/upgrade.sh` 是服务器端脚本 ⇒ **没有远程执行权**；
写接口需要 token，且**不会**为了测试往生产库写。可匿名读取的面经实测：

| 端点 | 结果 |
|---|---|
| `/v1/workouts`、`/v1/mobile/today`、`/v1/dashboard`、`/v1/data-summary`、`/v1/data-audit` | 200（可读健康数据） |
| `/v1/import-sources`、`/v1/import-jobs/*`、`/v1/backups`、`/v1/jobs`、`/v1/diagnostics` | **401** |

⇒ **导入侧状态在线上取证不到**（这是设计如此，见 `apps/api/src/server.ts:198-223`），
所以"线上现在是否在重复导入"**无法从外部直接观测**。基线见 §5。

---

## 2. 🔴 第四条通道 D（本轮最重要发现）

### 2.1 完整链条（每一环都实测过）

```
HealthKitExport.exportArchive
  └─ <ExportDate value="\(appleDate(Date()))"/>      ← 每次导出都是新的墙钟
       └─ apple-health-parser.ts:547  sourceHash.update(整个 XML 文本)
            └─ :589  setManifest("source_xml_sha256", …)   ← 含导出时间
                 └─ cli.ts:344  dataset_version = stableId("dataset", fingerprints)
                      └─ import-dataset-analysis.ts:127  auditManifestChanged
                           └─ mode = "data-only"  ← 不是 unchanged
```

`cli.ts:338-344` 是生产路径：`apps/api/src/import-worker.ts:492-496` 以子进程方式运行
`tsx packages/health-export-parser/src/cli.ts incremental-import …`，所以这一步**真的执行**。

### 2.2 实测证据

新增守卫 `metadata-order-determinism.test.ts:299`（复现生产写入），修复前：

```
not ok 5 - the production dataset_version chain: a moving <ExportDate> still
           classifies as unchanged
  dataset_version moved (dataset_2181b034f8307f5766b8b7966541aa2f
                      -> dataset_8d5b4597143c6744fbc015abd99ccde0)
  actual: 'data-only'   expected: 'unchanged'
```

诊断输出（staging 与 previous 的全部差异，逐判据实测）：

| 判据 | 差异 |
|---|---|
| `health_export_date` | 变了（不参与判定） |
| `source_xml_sha256` | 变了（不直接参与判定） |
| **`dataset_version`** | **变了 → `auditManifestChanged`** |
| `entity_inventory` / `import_issues` / `activity_summaries` / `profile` / `health_records` | **全部 0** |

⇒ 数据真的一行没变，却被判 `data-only`。

### 2.3 为什么上一轮的守护测试没抓到

`metadata-order-determinism.test.ts` 上一轮那三条测试**直接调用
`parseAppleHealthXml`**，从不经 `cli.ts` 写 `dataset_version` 那一步 ⇒ 生产链路
根本没被覆盖。**这是"测试绿而生产坏"的典型**：测试选错了入口。

### 2.4 修复

`apps/api/src/import-dataset-analysis.ts:113-136`：`auditManifestChanged`
**不再比较派生的 `dataset_version`**，只留 `record_count`。

判据是"**不该拿派生值当变更判据**"：`dataset_version` 由会漂移的
`source_xml_sha256` 派生，而它本可以去代表的一切都已被更直接、语义更明确的字段覆盖：

| 它想代表的变化 | 实际由谁抓 |
|---|---|
| route 变化 | `source_gpx_bundle_sha256` 独立比较（`:138-152`） |
| workout / record / profile / health 变化 | 各自的表 diff |
| 行数变化 | `record_count`（仍在比较列表里） |

修复后同一测试 **6/6 全绿**。

---

## 3. 验证矩阵（全部实测）

| 项 | 命令 / 方式 | 结果 |
|---|---|---|
| P0-1 真执行（模拟器，跨 3 进程） | `python3 apps/ios/tests/check-export-determinism-live.py` | **7 checks / 0 failed** |
| ↳ 自检"去掉 `.sorted()` 必须变红" | 同上内置 | ✅ 跨进程顺序确实变 ⇒ 门禁非空转 |
| D 通道守卫 | `node --import tsx --test …metadata-order-determinism.test.ts` | 修复前 fail 1 → 修复后 **6/6 pass** |
| D 修复的判别力（突变） | 把 `dataset_version` 加回比较列表 | **fail 1**，源码已还原 ✅ |
| 类型检查 | `npm run typecheck` | EXIT=0 |
| 全量 node | `packages/*/test/*.test.ts` + `apps/api/test/*.test.ts` | **800 / 797 pass / 0 fail / 3 skip** |
| 线上基线 | `GET /v1/{data-summary,data-audit,workouts}` | 见 §5 |

3 个 skip 全部是 Windows-only 语义（Rust 工具链已装，跨语言等价 8/8 实跑）。

---

## 4. 未做 / 需要你定的

1. **治本项（建议独立排期，🟡）**：`source_xml_sha256` 自身仍是"含导出时间的
   整份文件字节指纹"。它现在的危害**不在**导入判定（D 已解除），而在：
   - `import_batches.xml_sha256`（审计字段，每次导入都不同 ⇒ 失去比对意义）
   - `model_runs.dataset_version` / `feature_runs.dataset_version`（每次导入都变
     ⇒ "模型基于哪版数据"的标记失真）

   修法是把 `<ExportDate>` 从哈希输入里剥掉（`apps/api/src/import-sources.ts:231-246`
   已有 `stripExportDate` / `hashXmlWithoutExportDate` 的成熟先例，语义一致）。
   **必须 TS + Rust 双侧同改**（`crates/rai-data-worker/src/main.rs:48` 是同一份字节
   的 sha256），否则切换 `RAI_IMPORT_ENGINE` 会让 `dataset_version` 突变。
   我没有动它，因为：改动持久化字段语义 + 跨语言 + 会让下一次导入的
   `dataset_version` 一次性变化，值得你先看一眼。

2. **模拟器 App 级验收（我判断增量价值低，未做）**：P0 只触及 HealthKit 导出路径，
   不涉及 UI 或网络；而模拟器**无法**执行 HealthKit 查询（无 entitlement）。
   跑 `run-visual-tests.sh` 需要 `var/rai.sqlite`，本机不存在。若你要的是
   "用真实云端数据看一遍界面"，说一声我跑（构建约十几分钟）。

3. **真机终审**仍是唯一能把 P0 完整走通的路径（HealthKit 查询 + 导出 + 上传）。

---

## 5. 线上只读基线（2026-09-23T00:44Z）

```json
{ "datasetVersion": "dataset_5589d6b0e7b458def1ae67cad5e914b8",
  "importCompletedAt": "2026-09-22T14:17:29.569Z",
  "databaseBytes": 530530304,
  "counts": { "healthRecords": 122580, "workouts": 276, "trainingSessions": 273,
              "routePoints": 113870, "assessments": 273 },
  "syncProtocolVersion": 1 }
```

**可做的一次免费判据**：下次同步后重取这份数据——若 `importCompletedAt` 变了而
`datasetVersion` 保持不变，说明 D 的修复方向对；若两者一起变，则需要复查。
（注意：线上跑的是**部署时那一版代码**，本轮的改动尚未部署。）

---

## 6. 回滚

| 改动 | 回滚 |
|---|---|
| `apps/api/src/import-dataset-analysis.ts` | `git checkout -- apps/api/src/import-dataset-analysis.ts` ⇒ 恢复成 `data-only`（旧行为，不丢数据） |
| `apps/ios/tests/check-export-determinism-live.py`、`test:ios:live`、`run-visual-tests.sh:21` | 删除脚本 / 移除一行调用；纯门禁，无运行时影响 |
| 测试文件 `metadata-order-determinism.test.ts` | 新增文件，删除即可 |

**本轮不改任何持久化结构、不迁移、不写生产库。** 服务端改动的唯一影响是
"同一份数据重复导入时不再被判为 `data-only`"，即使判错方向也只是回到旧行为。
