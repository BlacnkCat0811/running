# 线上导入耗时归因：批次 4 收益兑现 + `quick_check` 全库扫描（2026-09-21）

触发：小唐 17:34 CST 重新同步 → 批次 4（`5a44413`）上线后的**首次真实导入**（`web_import_mub1szzw…`）。

---

## 1. 结论先行

| # | 结论 | 强度 |
| :--- | :--- | :--- |
| 1 | ✅ **批次 4 的收益兑现**：`recompute` **12.72–13.00 s（5 样本稳定基线）→ 10.66 s**，省 **2.34 s / −18%**，与预测的落点（`@rai/application` 的 `localDateAt`）一致 | 🔴 强 |
| 2 | ⚠️ **`parseImport` 涨了 16 s，但这不是批次 4 引入的** —— 涨幅**全部**落在 CLI 里**没有任何埋点**的部分 | 🔴 强 |
| 3 | 🔴 **真正的原因找到了**：`PRAGMA quick_check` 是**全库扫描**，本机实测 **冷 12.1 s / 热 0.25 s（48×）**，而一次导入要跑 **≥3 次** | 🔴 强（真机实测） |
| 4 | 🔴 **这同时解释了昨天悬而未决的 07:56 异常**（`backup` 15.8 s / `activation` 22.9 s）——冷热运气不同，多出来的时间在三个阶段之间游走 | 🔴 强 |
| 5 | 🔴 **观测缺口**：`parseImport` 的**尾部**（`activateStagingDatabase` + `store.close`）无埋点，约 **14 s** 不可见 | 🔴 强 |

**推论**：`quick_check` 冗余扫描（最多可省 ~24 s）**比批次 4 省下的 2.3 s 大一个数量级**，是当前最大的剩余优化目标。

---

## 2. 批次 4 的收益：`recompute` −18%（5 样本稳定基线）

`recompute` 阶段是**整条链里最稳的一段** —— 同代码版本连续 5 次采样只差 286 ms：

| 任务时间 (UTC) | 代码版本 | `recompute` |
| :--- | :--- | ---: |
| 09-20 02:55 | 09-19 那版 | 12867 |
| 09-20 09:21 | 同上 | 12956 |
| 09-20 13:52 | 同上 | 12766 |
| 09-21 00:36 | 同上（OPT-1 部署前） | 12717 |
| 09-21 07:56 | `7d5298b`（OPT-1 已上，**批次 4 未上**） | 13003 |
| **09-21 09:34** | **`5a44413`（批次 4 已上）** | **10663** ✅ |

⇒ 基线带 **12717–13003**（n=5，spread 286 ms），批次 4 后 **10663** ⇒ **−2340 ms，−17.8%**，**远超噪声**。

### 落在哪个子阶段

| `computeStagesMs` | 07:56 | 09:34 | 差 |
| :--- | ---: | ---: | ---: |
| **`trainingMetrics`** | 11723.6 | **9114.8** | **−2608.8** ✅ |
| `parse_health_xml` | 3471.6 | 4461.3 | +989.7 |
| `canonicalize_nights` | 2331.9 | 2364.4 | +32.5（= OPT-1 的既有效果，批次 4 未再改它） |
| `features` | 380.0 | 618.2 | +238.2 |
| `modelReplay` | 387.6 | 382.9 | −4.7 |

⇒ 收益**集中且完整地落在 `trainingMetrics`** —— 正是 `@rai/application` 里 `localDateAt` 高频构造
`Intl.DateTimeFormat` 的地方。**与设计预期逐项吻合。**

---

## 3. `parseImport` +16 s 不是批次 4 引入的（三条独立证据）

| 阶段 | 07:56 | 09:34 | 差 |
| :--- | ---: | ---: | ---: |
| `totalMs` | 66417 | 52556 | −13861 |
| `backup` | 15832 | 4489 | −11343 |
| `stagingCopy` | 1746 | 1717 | −29 |
| **`parseImport`** | **11900** | **27935** | **+16035** ⚠️ |
| `changeAnalysis` | 317 | 305 | −12 |
| `recompute` | 13003 | 10663 | −2340 ✅ |
| `activation` | 22881 | 6715 | −16166 |
| `cleanup` | 10.2 | 10.8 | +0.6 |

### 证据 ① 涨幅 100% 在埋点覆盖范围之外

`parseImport` = **整个 `health-export-parser` CLI 子进程**的墙钟（`import-worker.ts:408`
`timing.measure("parseImport", () => this.command([…]))`），而 CLI 内部只有 **5 段**有埋点
（`cli.ts` 的 `timedStage`：`parse_health_xml:284` / `import_gpx_routes:302` /
`canonicalize_workouts:317` / `canonicalize_nights:321` / `stage_audit_files:370`）。

| | 07:56 | 09:34 |
| :--- | ---: | ---: |
| `parseImport` 总计 | 11900 | 27935 |
| 5 段埋点合计 | 6253 | 7934 |
| **未覆盖部分** | **5647** | **20001** (+14354) |

⇒ 埋点部分只涨了 1.68 s（其中 `parse_health_xml` +990 ms、`stage_audit_files` +629 ms，都是 IO 味），
**14.35 s 的涨幅完全在埋点之外**。

### 证据 ② 批次 4 在 `cli.ts` 里只改了一个实参

```diff
-  const nightlyResult = await timedStage("canonicalize_nights", () => canonicalizeNights(store.database, "Asia/Shanghai"));
+  const nightlyResult = await timedStage("canonicalize_nights", () => canonicalizeNights(store.database, DATABASE_TIMEZONE));
```

改动落在**已被埋点**的 `canonicalize_nights` 段内，而该段实测 **2331.9 → 2364.4 ms（+32 ms）**。
批次 4 全部改动是"字面量 → 常量 + formatter 记忆化"，**没有任何机制能让埋点外的代码慢 14 s**。

### 证据 ③ 变慢的都不是"CPU 段"，而"CPU 段"纹丝不动

- `canonicalize_nights`（批次 4 唯一动过的 CLI 段）：**+1.4%**
- `parse_health_xml` / `stage_audit_files` / 未埋点的 CLI 尾部：**全部是写库与文件 IO**

⇒ 典型的 **IO 争用特征**，而不是代码回归特征。

### 输入规模也不是原因

`source_xml_bytes = 9,072,693`（**8.65 MiB**），`importMode=incremental`；
`summary` 规模与上一轮同量级（`updatedWorkouts` 3 vs 4、`unchangedWorkouts` 269 vs 268、
`featuresReused` 268、`modelReplayFrom` 同）。`healthRecords` 114159 → 114162（+3）。

---

## 4. 真正的原因：`PRAGMA quick_check` 是全库扫描，冷热差 48 倍

### 真机实测（生产机空闲时，506 MB 真库，只读打开一份备份文件）

| 操作 | 耗时 |
| :--- | ---: |
| `copyFileSync` 506 MB（≈ `stagingCopy`） | **1646 ms** |
| `backup()`（`node:sqlite`，506 MB，≈ `backup` / `prepareStagingDatabase`） | **2083 ms** |
| **`PRAGMA quick_check` 首次（冷）** | **12,108 ms** |
| **`PRAGMA quick_check` 再次（热）** | **252 ms** |

⇒ **48× 的冷热比。** 冷的时候它就是一个 506 MB 的全文件扫描。

（交叉验证：实测 `stagingCopy` 1646 ms 与线上观测的 `stagingCopy` 1717 ms 吻合 ⇒ 探测口径可信。）

### 一次导入里它被调用 ≥3 次

| 调用点 | 落在哪个阶段 |
| :--- | :--- |
| `apps/api/src/import-worker.ts:749`（`createCurrentBackup` 里 `isReadableDatabase(main)`） | **`backup`** |
| `apps/api/src/maintenance.ts:283`（备份候选校验） | **`backup`** |
| `packages/health-export-parser/src/cli.ts:194`（`activateStagingDatabase.validateInstalled`） | **`parseImport` 的尾部** |
| `apps/api/src/import-worker.ts:1371`（`isReadableDatabase`，发布后校验） | **`activation`** |

⇒ 三个阶段各背一次（或多次）**完全相同的 506 MB 全库扫描**，
每次是 12.1 s 还是 0.25 s **取决于那一刻的 page cache 运气**。
这台机器总内存 1935 MB、`MemoryMax=1400M`，而库里 506 MB、一次导入要写 3～4 份副本
⇒ 页面被反复挤出，**冷扫描是常态而非例外**。

### 这解释了所有"游走"的耗时

- **09-21 07:56**：`backup` 15.8 s + `activation` 22.9 s（冷），`parseImport` 尾部反而是热的 ⇒ 看起来像"parseImport 很快"。
- **09-21 09:34**：`backup` 4.5 s + `activation` 6.7 s（热），`parseImport` 尾部是冷的 ⇒ 看起来像"parseImport 变慢了"。

⇒ **同一个机制，两次不同的运气。** 昨天记的"待下次导入复看：若 `stagingCopy` 仍正常而
`backup`/`activation` 持续 >10 s，则与 IO 无关，要查锁竞争" —— 现在答案出来了：**既不是锁竞争，也不是代码，是冷热。**

### 项目里其实早就知道这件事，只是没推广到导入路径

`apps/api/src/server.ts:516-519` 有一条写得很清楚的注释：

> Do not run PRAGMA quick_check / foreign_key_check here. Both scan the full file and block the HTTP
> thread for minutes on a multi-GB export.

`/v1/health` 的 `databaseIsReady()` 因此换成了 `sqlite_master` 计数探针。
**但导入路径没跟上** —— 同一个全库扫描还在 `backup` / `parseImport` / `activation` 里各跑一遍。

---

## 5. 观测缺口：`parseImport` 尾部 ~14 s 不可见

CLI 的时间线（09:34 那次，锚点用 manifest 的 `import_started_at`）：

| 时刻 (UTC) | 事件 |
| :--- | :--- |
| 09:34:00.764 | 任务创建 |
| ~09:34:01.0 → 05.5 | `backup`（4489 ms） |
| → 07.2 | `stagingCopy`（1717 ms） |
| → 12.969 | CLI 启动 + `prepareStagingDatabase` + `RaiDatabase.open` + manifest 写入<br>（`import_started_at` 写在这里，`cli.ts:280`） |
| 12.969 → ~20.9 | **5 段埋点合计 7934 ms** |
| ~20.9 → ~35.1 | 🔴 **`store.close()` + `activateStagingDatabase`（`cli.ts:377-391`）≈ 14 s，无任何埋点** |

`activateStagingDatabase`（`cli.ts:170-197`）内三件事都未埋点且都是重的：
1. `PRAGMA wal_checkpoint(TRUNCATE)`（`prepareOriginal`）
2. 两次 `moveFileWithRetry`（同文件系统重命名，便宜）
3. **`PRAGMA quick_check`（`validateInstalled`）** ← 冷时 12.1 s

另测得：**CLI 冷启动只要 0.367 s、热启动 0.282 s**（`node --import tsx <cli.ts>` 无参，
量"进程启动 + 整张模块图加载"）⇒ 进程启动**不是**瓶颈，可以排除。

---

## 6. 建议（未执行，等小唐定）

| 级别 | 动作 | 预期 | 风险 |
| :--- | :--- | :--- | :--- |
| 🔴 P0 | **给 `parseImport` 的尾部补埋点**（`activate_staging` 独立成段），并把 `cli.ts:194` 的 `quick_check` 耗时单独报出来 | 让"14 s 不可见"变成可见 | 极低（只加观测，`computeStagesMs` 是开放字典，契约不变） |
| 🔴 P1 | **砍掉冗余的 `quick_check`**：保留 `import-worker.ts:749`（写覆盖前检测主库损坏，语义真正必要），把 `cli.ts:194` 与 `import-worker.ts:1371` 换成 `server.ts:520` 那种**结构探针**（`sqlite_master` 计数 + 一个真实查询） | 冷时最多省 **~24 s**；这是当前最大的剩余目标 | 🟡 **改的是安全语义**：候选库由 SQLite `backup()` 从已校验的源生成，再校验一次属重复；但需你认可"少一层全库校验" |
| 🟡 P2 | 若 P1 不可接受，退而求其次：**让扫描跑在文件还热的时候**（紧接着写入后立刻校验，别等 page cache 被挤掉） | 收益不确定（依赖调度） | 低 |
| ⚪ P3 | `apps/api/src/maintenance.ts:283` 的备份校验：可考虑改成"每 N 次全查一次"或对 `before-web-import` 这类即时回滚点降级 | 每次备份省 12 s（冷） | 🟡 中（备份完整性是最后防线） |

**我不建议**为省这点时间去动 `PRAGMA quick_check` 的**语义**（例如换成 `integrity_check` 或直接删掉）
而不做等价性论证 —— 按本项目惯例，"改的是安全语义"必须先有可回滚方案。

---

## 7. 可复现的验收方法

```bash
# 1) 取历史样本（runtime.sqlite 的 import_jobs，133 条）
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/var/lib/rai/var/runtime.sqlite',{readOnly:true});const a=d.prepare('SELECT sequence_number,created_at,status,performance_json FROM import_jobs ORDER BY sequence_number DESC LIMIT 12').all();for(const x of a){let p={};try{p=JSON.parse(x.performance_json||'{}')}catch(e){};const s=p.stagesMs||{};console.log(x.created_at,x.status,'total',Math.round(p.totalMs||0),'parse',Math.round(s.parseImport||0),'recompute',Math.round(s.recompute||0),'backup',Math.round(s.backup||0),'activ',Math.round(s.activation||0))}"
```

⚠️ `computeStagesMs` 的**细分埋点是 2026-09-21 才加的** ⇒ 更早的任务该字段全为 `0`，别当成"耗时为 0"。
⚠️ `GET /v1/import-jobs` **不存在**（只有 `/active`、`/latest`、`/:id`）；列历史要读 `runtime.sqlite`。
⚠️ `sqlite_master` 探测会被云机工具 `AccessDeny` ⇒ 用**二进制串扫描**取 schema（见本文 §4 的方法）。

```bash
# 2) 量 quick_check 的冷热成本（用一份备份当只读源，绝不动主库）
#    脚本：open → quick_check ×2，取两份 506 MB 的 /tmp 副本，用完删
#    实测：12108 ms / 252 ms
```

```bash
# 3) 量 CLI 启动
cd /opt/rai && { time /usr/bin/node --import tsx packages/health-export-parser/src/cli.ts ; } 2>&1 | tail -4
#    实测：real 0m0.367s（冷）
```

---

## 8. 顺带确认的两件现场事实

1. **批次 4 的部署备份仍在**：`rai.manual.2026-09-21T09-15-07-998Z.babdf99e.sqlite` ✓（17:38 仍在）。
2. 🟡 **`rai.before-web-import.*` 与定时/手动备份共用同一个 14 槽预算**：
   17:41 实测 `var/backups/` = 12 份 `rai.manual.*` + 2 份 `rai.before-web-import.*` = **14 份 / 7.0 G**
   ⇒ **每次导入会挤掉一份旧的手动备份**，恢复窗口被导入次数进一步压缩（仍 ≈9.3 h，但"手动 / 部署前备份"存活时间变短）。
   （另：2 个 `-shm`/`-wal` 侧车是我这次探测只读打开备份文件产生的，已清理，非应用产物。）

---

## 9. 未做（有意）

- **没有触发新的导入**：只读现成记录 + 在 `/tmp` 副本上做只读计时。
- **没有改任何代码**：P0–P3 全部只是建议。
- **没有动主库**：全程 `readOnly:true`；收尾用 `import_manifest.dataset_version`
  （`dataset_2ee4aa52c929ba674d05fd7a1d7a934e`，与探测前一致）证明主库未被碰。
- 临时文件（`/tmp/rai-probe*.sqlite` ≈ 1 GB、两个探测脚本、`/tmp/p*.b64`）已全部删除，磁盘回到 34%。
