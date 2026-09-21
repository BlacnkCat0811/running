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

### 一次导入里它被调用 **4 次**（行号 = 本文写作时，`2026-09-21` 傍晚实施前）

| 调用点 | 落在哪个阶段 | 扫的是谁 |
| :--- | :--- | :--- |
| `apps/api/src/import-worker.ts:749`（`createCurrentBackup` 里的 `isReadableDatabase`） | **`backup`** | 主库 |
| `packages/health-export-parser/src/cli.ts:194`（`activateStagingDatabase` 的 `validateInstalled`） | **`parseImport` 的尾部** | CLI 刚交付的库 |
| `apps/api/src/import-worker.ts:1196`（`activateDatabase` 里，`installDatabase` **之前**） | **`activation`** | 旧主库 |
| `apps/api/src/import-worker.ts:1215`（`activateDatabase` 里，`installDatabase` **之后**） | **`activation`** | 新主库 |

🔴 **修正**：本表初稿把 `apps/api/src/maintenance.ts:283` 也列了进来 —— **那处不在导入路径上**：
它在 `restoreBackup` 里，只有手动恢复备份时才执行。导入路径上真正被扫的是上表这四次。
（另：`maintenance.ts` 里同名私有方法 `isReadableDatabase` 的调用点全部落在
删除 / 恢复 / 回滚路径，同样不在导入热路径。）

⇒ 这四次里，每一次都是**完全相同的 506 MB 全库扫描**，
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

## 6. 建议（**同日傍晚已实施**；P1 的实际范围有收窄，见 §10）

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

---

## 10. 优化实施结果（2026-09-21 傍晚，小唐批准「按建议优化实施」）

### 10.1 实施范围与 P1 的收窄

初版建议把 P1 写成「保留 `import-worker.ts:749`，把另两处换成结构探针（最多省 ~24 s）」。
**实施前重新侦察后收窄了范围** —— 原措辞有两处不准确：

1. 导入路径上真正被扫的是 **4 次**（不是 3 次），见 §4 修正后的表。
2. 「换成结构探针」**不是等强度替换，是降级** —— 实测证据见 10.2。

最终改动 **2 处 / 保留 2 处**：

| 调用点 | 处理 | 理由 |
| :--- | :--- | :--- |
| `import-worker.ts` `createCurrentBackup` | **保留 `quick_check`** | 它的结果会触发 `preserveCorruptDatabase`（**破坏性**动作）。弱探针若漏检，紧随其后的 `backup()` 会抛错 ⇒ 导入直接失败**且丢掉隔离快照**，语义比「自动转全量重建」更差。误判代价不对称 ⇒ 值这个 12 s。 |
| `cli.ts` `activateStagingDatabase.validateInstalled` | **换结构探针** | 校验的库是本进程刚写完的（`store.flush()` + `close()` 已确定内容）；发布后再全库扫描属重复校验。 |
| `import-worker.ts` `activateDatabase`（`installDatabase` **之前**） | **换结构探针** | 与 `createCurrentBackup` 里那次**扫的是同一份主库**，而它的结果只用来决定「要不要 checkpoint」与回滚路径判断。 |
| `import-worker.ts` `activateDatabase`（`installDatabase` **之后**） | **保留 `quick_check`** | 这是**发布闸门 + 自动回滚触发器**。上面两处降级后，页内损坏仍会在这一道被拦下并回滚 ⇒ 它就是降级的兜底。 |

### 10.2 等价性证据（P1 是**有登记的降级**，不是等价替换）

对同一份 506 MB 库人为制造损坏，比较两者（本机实测，与机器无关）：

| 损坏类型 | `PRAGMA quick_check` | 结构探针 |
| :--- | :--- | :--- |
| 文件被截断 5% | 抛错 ✓ | **检出** ✓ |
| header 的 `page_count` 被改坏 | 抛错 ✓ | **检出** ✓ |
| 单个数据页被翻转 64 字节 | 报错 ✓ | ❌ **漏检** |
| 10 个数据页各翻转 64 字节 | 报错 ✓ | ❌ **漏检** |

⇒ 覆盖「文件级损坏」（不可打开 / header 坏 / 截断 / schema 不可读），
**不覆盖「页内字节被静默篡改而页数与 schema 完好」**。

**这条降级已钉成回归断言**：`packages/storage-sqlite/test/database-structure-probe.test.ts`
最后一条用例**故意断言「探针漏检、而 quick_check 检出」**。将来若有人加强探针，该用例会失败并提醒他：
等价性口径变了，「必须留一道 quick_check 兜底」这个前提要重新论证。

### 10.3 新增模块与成本

`packages/storage-sqlite/src/database-structure-probe.ts` → `probeDatabaseStructure()`
（`@rai/storage-sqlite` 已被 `health-export-parser` 与 `apps/api` 同时依赖，不必新开包）。

| 场景 | `quick_check` | 结构探针 |
| :--- | ---: | ---: |
| 506 MB 真库（云机，**冷** page cache） | **12,108 ms** | 0 ms |
| 506 MB 真库（云机，热） | 252 ms | 0 ms |
| 310 MB 真库（本机开发机，热） | 624 ms | **5 ms** |

判据：能打开 → 读 `page_size` / `page_count` / `freelist_count` / `schema_version` →
`SELECT COUNT(*) FROM sqlite_master`（真正走 page 1 及其延伸页）→
**`page_count × page_size === 文件大小`**（检出截断/膨胀）→ schema 非空。

### 10.4 P0 埋点：`parseImport` 从此可完整分解

`packages/health-export-parser/src/cli.ts` 新增 **7 个段**（`computeStagesMs` 是开放数字字典，
`schema.ts` 里是 `additionalProperties:number` ⇒ **零契约变更**）：

| 新段名 | 覆盖的代码 | 此前 |
| :--- | :--- | :--- |
| `locate_health_xml` | `importCommand` 开头定位导出文件 | 不可见 |
| `prepare_staging_copy` | 增量导入那次 506 MB 复制 | 不可见（≈1.6–2.1 s） |
| `open_staging_store` | `RaiDatabase.open` | 不可见 |
| `close_store` | `store.close()` | 不可见 |
| `activate_staging` | `activateStagingDatabase`（含发布后校验） | 不可见（冷态十几秒） |
| `validate_installed` | 发布后校验内部 | 不可见 ← **P1 收益的直接度量** |
| `commit_audit_files` | `stagedAudit.commit() + finalize()` | 不可见 |

⇒ 配合原有的 5 段，`parseImport` 的**每一毫秒现在都有归属**，§5 那个「~14 s 不可见」的缺口被填平。

### 10.5 预期收益与验收判据

| 场景 | 预期 |
| :--- | :--- |
| **冷** page cache（线上常态） | 省 **最多 2 × 12.1 s ≈ 24 s** |
| 热 page cache | 省 ~0.5 s |

**验收判据（必须用部署后的下一次真实导入）**：

```bash
# 期望看到新增的 7 个段名出现在 computeStagesMs 里，且 validate_installed 接近 0 ms
node -e "fetch('https://tpandmr.xyz/v1/runtime-status').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.importJob.performance.computeStagesMs)))"
```

⚠️ **部署后立刻读到的仍是「上一版代码」的快照**（`importJob` 指向最近一次已完成任务）——
这是本项目的老坑，必须等**重新同步触发一次真实导入**才有效。

### 10.6 门禁与突变验证

| 项 | 结果 |
| :--- | :--- |
| `npm run typecheck` | **EXIT=0** |
| 探针单测 | **8 / 8 pass** |
| 全量 node 测试 | **759 tests / 756 pass / 0 fail / 3 skip**，EXIT=0（上一次记录 751/748/0/3，本次 +8 = 新增探针用例 7 条 + 尾部追加用例 1 条） |
| 突变 A | 临时停用 `page_count x page_size === 文件大小` 判据 ⇒「尾部被追加垃圾」用例**变红** ✓ 断言有效，不是恒绿 |
| 突变 B | 同一突变下「被截断」用例**仍然绿** ⇒ 证实它靠 SQLite 自身读 header 时报错通过，与上述判据无关 —— 两个判据不混为一谈 |
| 真机真库 | 310 MB 生产库副本上探针 **5 ms**，判据正确（79332 × 4096 = 324,943,872 = 文件大小，`schemaObjects 152`） |
| 对照 | 同一真库 `PRAGMA quick_check` 624 ms（本机热态）；云机 506 MB **冷态 12,108 ms** |

⚠️ web 侧与桌面 E2E 本次**未跑**（未触碰 `apps/web`）；按项目惯例 node 侧与 web 侧分开报。

### 10.7 回滚方案

改动全部在 TypeScript 层，**不触碰持久化、不新增迁移、不改依赖**：

```bash
# 回滚 = revert 两个提交 + 重启（无需重新编译 Rust，因为 crates/ 零改动）
cd /opt/rai && git revert --no-edit <探针提交> <埋点提交> && sudo systemctl restart rai-api
```

或直接 `git reset --hard <部署前 HEAD>` + 重启（线上部署前的备份仍在 `var/backups/`）。
**没有数据库结构变更** ⇒ 回滚不需要动数据。

### 10.8 未动（有意）

- **`isReadableDatabase` 的其余 10 处调用点**（`maintenance.ts` 6 处 + `import-worker.ts` 4 处）：
  全部落在删除 / 恢复 / 回滚路径，**不在导入热路径**，改它们只有风险没有收益。
- **`maintenance.ts` 的 `restoreBackup`**：本文初稿把它当成「备份校验」（P3），
  实为**手动恢复**路径才走 —— 每次备份省 12 s 的收益描述**不成立**，撤回该建议。
- `apps/web/src/format.ts` 的前端时区口径（批次 4 顺延项）。
