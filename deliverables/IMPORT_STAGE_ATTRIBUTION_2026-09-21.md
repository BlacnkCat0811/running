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

---

## 11. 部署实录（2026-09-21 20:19–20:21 CST）

线上 **`8a12b6b → 577ae0e`**（3 个提交：`47d4e37` 探针模块 / `b3ff82a` 接入 + 埋点 / `577ae0e` 文档）。

| 项目 | 实测 |
| :--- | :--- |
| 闸门核对（基准 = **实测** HEAD `8a12b6b`） | `crates` **0** / `apps/web` **0** / `package*.json` **0** / `deploy/` **0** / `database.ts` **0** ⇒ 最小部署（不重编译 Rust、不装依赖、不构建 web、无迁移） |
| 部署前备份 | `rai.manual.2026-09-21T12-19-39-501Z.fcc8c06d.sqlite`（530,530,304 B），部署后**确认仍在** ✓ |
| 迁移闸门 | `version 22` + **`pending: []`** + counts `workouts 275 / route_points 110840 / health_records 114162` |
| unit | `INSTALLED_EQ_REPO true` / `HAS_EXIT78 true` |
| **停机** | 20:20:03 停 → 20:20:08 `Server listening` ≈ **5 s** |
| 服务 | `active` / `NRestarts=0` / 无迁移报错 / 启动日志 `publicReadHosts:["tpandmr.xyz","101.33.202.40"]` **26/12** |
| 引擎 | `/proc/<MainPID>/environ`：`RAI_IMPORT_ENGINE=rust` + `RAI_RUST_FALLBACK=typescript` + `RAI_RUST_BINARY=/opt/rai-native/rai-data-worker`；**死配置 `RAI_IMPORT_VALIDATION_MODE` 计数 0** |
| **CLI 可加载性** | `node --import tsx packages/health-export-parser/src/cli.ts` 抛 **usage**（而非 import 错误）⇒ 含新探针 import 的模块图能加载。**这条专门防**「CLI 只在下一次导入才被 spawn，坏了要等到那时才发现」 |
| 契约测试 | **8 tests / 8 pass / 0 skipped**（`NT_EXIT=0`）⇒ 二进制与 TS 契约对齐，B1 在线 |
| 端点 | 匿名 `/v1/health` **200**（`status:"ok"` + `databaseReady:true`）、`/v1/data-summary` **200** + **`issues: []`** |
| **云机真机探针实测** | 506 MB 真库副本上 **4 ms**，判据正确（129524 × 4096 = 530,530,304，`schemaObjects 152`）；对照 `quick_check` 热 **1050 ms** / 冷 **12108 ms** |
| 收尾 | 无 Rust 子进程残留 / 磁盘 **34%**（32 G 可用）/ 备份 **14 份 7.0 G** 稳态 / `var/backups` 侧车 **0**（先 `cp` 到 `/tmp` 再测，避开了"只读打开备份就地生成 `-shm`/`-wal`"那个坑） |

🔴 **收益尚未兑现（预期之内，不是回退）**：部署后读到 `importJob.createdAt` 仍是
`2026-09-21T09:34:00.764Z`（批次 4 那次导入），`computeStagesMs` 里**新段 0 / 7** ⇒ 这是
「上一版代码」的快照。**判据**：等**下一次真实导入**，那时应看到 7 个新段名出现，且
`validate_installed` 接近 0 ms（`activate_staging` 也应显著缩短）。

🔴 **本次又命中同一个坑，记下来**：我最初用 `69a419c..HEAD` 算闸门范围，而**实测线上 HEAD 是
`8a12b6b`** —— `69a419c` 是后来推的**纯文档**提交、从未 pull 到线上。按 skill 的硬要求
「`<线上HEAD>` 必须实测」重算后结论不变（两者都全 0），**但那是巧合**：`69a419c` 只改
`deliverables/`，恰好不改变闸门结论。若它改的是 `crates/` 或 `deploy/`，我这次就会**漏掉一个闸门**。

## 12. 首次真机读数 + 一个「修了发送端、没修接收端」的 bug（2026-09-21 20:24 CST 导入）

### 12.1 读数：批次 4 收益可复现，P1 收益兑现

小唐于 20:24 重新同步 ⇒ 任务 `14243`（`web_import_mub7vnq6_08de5d4f-…`，`succeeded`，
`4 updated / 0 inserted / 0 removed / 268 unchanged`，与 09:34 那次同类）。

| 阶段 | 07:56（基线） | 09:34（批次 4 后） | **12:24（P0/P1 后）** | 判读 |
| :--- | ---: | ---: | ---: | :--- |
| `totalMs` | 66,417 | 52,556 | **46,497** | |
| `backup` | 15,832 | 4,489 | **21,479** | ⚠️ 冷态 `quick_check` 这次落在 `backup`（见 §12.4） |
| `stagingCopy` | 1,746 | 1,717 | 1,793 | 三次几乎恒定 ⇒ 磁盘 IO 不是变量 |
| `parseImport` | 11,900 | 27,935 | 10,716 | 尾部这次是热的 |
| `recompute` | 13,003 | 10,663 | **10,621** | ✅ 批次 4 收益**可复现**（见下） |
| `activation` | 22,881 | 6,715 | **756** | ✅ **P1 兑现：−5,959 ms / −89%** |
| `cleanup` | 10 | 11 | 22 | |

**① 批次 4 的 `recompute` 收益不再是单样本。** 新代码的**两个**样本是 10,663 / 10,621 ms，
而旧代码 5 个样本是 12,717–13,003 ms ⇒ 两批之间没有重叠，−18% 稳定成立。

**② `activation` 6,715 → 756 ms 是 P1 的直接结果**（去掉了 `installDatabase` 之前那次
`isReadableDatabase` 全库扫描）。⚠️ **这一项仍是单样本**：`backup` 同期从 4,489 涨到 21,479，
说明本次的冷态运气落在 `backup` 段而不是 `activation` 段 ⇒ 方向明确，但按纪律 8
**必须等下次再复看一次**才能定论。

### 12.2 🔴 新问题：P0 的 7 个新埋点**一个都没出现**

`computeStagesMs` 里仍只有老的 8 个段名。排除法：
- 线上代码确实到位 —— `git rev-parse` = `7df51c6`，且 `grep -c validate_installed packages/health-export-parser/src/cli.ts` **= 1**；
- 任务创建于 `12:24:02Z`，晚于 API 重启（`12:20:03Z`）4 分钟，且 CLI 是**每次导入新 spawn** 的（`import-worker.ts` 用 `process.execPath --import tsx <cli.ts>`，直接吃源码）；
- `data-summary.issues` = `[]`、导入本身 `succeeded` ⇒ **没有任何报错**。

**根因**：`apps/api/src/import-worker.ts` 的 IPC 接收端有一份**硬编码 stage 白名单**：

```ts
if (payload.type === "rai:compute-performance" &&
    ["features", "trainingMetrics", "modelReplay",
      "parse_health_xml", "import_gpx_routes", "canonicalize_workouts",
      "canonicalize_nights", "stage_audit_files"].includes(payload.stage ?? "") && …)
```

我改了**发送端**（`cli.ts` 的 7 个 `timedStage`），没改**接收端** ⇒ 7 个埋点全部被**静默丢弃**。

这与契约层的声明冲突：`packages/api-contracts/src/index.ts:381` 是 `Record<string, number>`、
`apps/api/src/schemas.ts:513` 是 `additionalProperties: { type: "number" }` —— **开放字典**。

⚠️ **真正的问题不是"没人知道"，而是"知道过一次、却没升级成纪律"**：
`deliverables/SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md` 的 `:214` **明明白白贴了这段白名单**、
`:222` 还写了操作步骤「删 `shadowValidation`、加上述 5 个名字」—— 说明 09-20 那次**是同步改了接收端的**。
但紧接着 `:218` 又写「**没有白名单**」（那句指的是 schema/契约层），**前后措辞互相消解**。
结果这份耦合被记成了一次性的「一行改动」，而不是「**每次新增埋点都必须同步的接收端清单**」。
本文档 §10.5 的验收判据也因此建立在一个错误前提上。

### 12.3 修复

`import-worker.ts`：白名单 → **格式校验**，并把解析抽成可单测的纯函数。

```ts
export const COMPUTE_STAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
export function parseComputeStageMessage(message: unknown): { stage; durationMs; processMaxRssKiB } | null
```

- 去掉「每加一个埋点就要改两处」的隐藏耦合（契约本来就是开放字典）；
- 仍拒绝非法键：数字/下划线开头、含 `-`/`.`/空格、超长（>48）⇒ 子进程不能往
  `performance_json` 里注入任意键。

### 12.4 门禁与突变验证

| 项 | 结果 |
| :--- | :--- |
| `npm run typecheck` | **EXIT=0** |
| 新增 `apps/api/test/import-worker-compute-stage.test.ts` | **7 / 7 pass** |
| 全量 node | **767 tests / 764 pass / 0 fail / 3 skip**，EXIT=0（上一次记录 759/756/0/3） |
| 突变 A | 把正则临时改回**白名单形态** ⇒ 用例 2/3（「新段名必须被接受」）**变红** ✓，用例 1（旧 8 段仍被接受）保持绿 ✓ ⇒ 测试真的能检出这个 bug |
| 突变 B | 测试先抓出**实现自身**的缺陷：`processMaxRssKiB = -5` 未被拒（`durationMs` 有非负校验而它没有）⇒ 已补齐 |

### 12.5 这次的教训

**跨进程消息的"两端"必须同时改；宽容的接收方 = 静默失效。**
验收判据不能是"发送端有没有这段代码"，而必须是**"接收端有没有把它记下来"**——
这次的 7 个埋点在发送端、契约、`schemas.ts` 三处都完全合规，只有一处硬编码把它们吃掉。

⚠️ 同类耦合还剩一处：`import-worker.ts` 的 `nativeStats` 仍有一份
`["health", "gpx", "aggregate", "apply-records"]`（Rust 引擎操作名）白名单。
本次未新增操作 ⇒ **未动**，但已登记为「下一处同类耦合」。

### 12.6 部署实录（2026-09-21 21:25 CST）

线上 `7df51c6 → f6b27aa`。本批 4 个文件，其中**运行时只有** `apps/api/src/import-worker.ts`
（`apps/api/test/**` 服务器不跑，两个 `deliverables/` 是文档）。

| 项 | 实测 |
| :--- | :--- |
| 闸门 | `crates` **0** / `apps/web` **0** / `package*.json` **0** / `deploy` **0** / 迁移 **0** ⇒ 最小部署；`merge-base --is-ancestor` 确认可快进 |
| 部署前备份 | `rai.manual.2026-09-21T13-25-08-385Z.06a41a68.sqlite`（530,530,304 B），部署后**确认仍在** ✓ |
| 迁移闸门 | `version 22` + **`pending: []`**（`workouts 275 / route_points 110840 / health_records 114162`） |
| unit | `INSTALLED_EQ_REPO true` / `HAS_EXIT78 true` |
| **停机** | 21:25:26 停 → 21:25:28 `Server listening` ≈ **2 s**（不重编译 Rust、不装依赖、不构建 web） |
| 服务 | `active` / `NRestarts=0` / `publicReadHosts 26/12`（线上基准值）/ `RAI local API ready` / 无迁移报错 |
| 引擎 | `RAI_IMPORT_ENGINE=rust` + `RAI_RUST_FALLBACK=typescript` + `RAI_RUST_BINARY=/opt/rai-native/rai-data-worker`；**死配置计数 0** |
| **修复生效的当场判据** | 云机上直接 import **线上源码** `apps/api/src/import-worker.ts` 调 `parseComputeStageMessage`：**接受 10/10**（7 个新段名 + `parse_health_xml`/`trainingMetrics`/`modelReplay`）、**拒绝 5/5**（`9x`/`_x`/`a-b`/空串/49 字符）⇒ `VERDICT PASS` |
| 端点 | 匿名 `/v1/health` **200**（`status:"ok"` + `databaseReady:true`）、`/v1/data-summary` **200** + **`issues: []`**、`/` 与 `/settings` **200** |
| 收尾 | 临时脚本已删 / 无 Rust 子进程残留 / 磁盘 **34%** / 备份 **14 份 7.0 G** / `var/backups` 侧车 **0** |

🔴 **本批未跑 Rust 契约测试**（上一批跑过 8/8、0 skipped）：`crates/**` 零改动、二进制未重建，
而该测试覆盖的是 CLI↔二进制的契约，与本次改动的接收逻辑无关。⇒ **不是"忘了"，是不触发**；
但要说出来，别让"没跑"被读成"跑绿了"。

🔴 **7 个新段名此刻仍未出现在 `computeStagesMs` 里**（仍 8 段、`createdAt = 12:24:02.526Z`）——
这是**上一版代码的快照**，不是修复失败。判据：**下一次真实导入**后应看到 **15 段**（8 + 7），
且 `validate_installed` 接近 0 ms、`activate_staging` 把此前"不可见"的尾部十几秒变成可读数字。

---

## 13. 收益兑现 + 下一步：把 `quick_check` 挪到「读热之后」（2026-09-21 21:42 CST 导入）

### 13.1 §12.6 预先写下的三条判据，同时被满足

小唐 2026-09-21 21:42（CST）的这次导入（`web_import_mubao71m…`，`createdAt 13:42:13.162Z`，
`durationMs 26,216`）是**接收端修复上线后的第一次真实导入**：

| 判据（§12.6 写下） | 本次实测 | 结论 |
| :--- | :--- | :--- |
| `computeStagesMs` 应从 8 段变 **15 段** | **15 段全齐** | ✅ 白名单修复生效 |
| `validate_installed` 应接近 0 ms | **1.29 ms** | ✅ **P1 直接兑现**（该位置原本是 12.1 s 的冷 `quick_check`） |
| `activate_staging` 应把"不可见"的尾部变成可读数字 | **16.38 ms** | ✅ §5 的观测缺口闭合 |

| 阶段 | ms | 计算段 | ms |
| :--- | ---: | :--- | ---: |
| `recompute` | 11,592 | `trainingMetrics` | 9,097 |
| `parseImport` | 7,799 | `parse_health_xml` | 3,176 |
| `backup` | 3,075 | `canonicalize_nights` | 2,243 |
| `stagingCopy` | 1,556 | `prepare_staging_copy` | 1,597 |
| `changeAnalysis` | 771 | `features` | 1,530 |
| `activation` | 531 | `stage_audit_files` | 180 |
| `cleanup` | 18 | `modelReplay` | 419 |
| **`totalMs`** | **26,216** | 其余 8 段 | `open_staging_store` 92 / `import_gpx_routes` 70 / `close_store` 31.5 / `activate_staging` 16.4 / `canonicalize_workouts` 11.4 / **`validate_installed` 1.29** / `commit_audit_files` 0.22 / `locate_health_xml` 0.07 |

`parseImport` 现在**可解释**：7,799 ms = 12 段埋点合计 7,420 ms + 非埋点 379 ms
（§3 里那个"20001 ms 完全不可解释"消失了）。Rust 四个 operation 均 `rustCalls=1 / typescriptFallbacks=0`。

### 13.2 四次导入对照：那道「冷 `quick_check` 税」只是换了落点

| 导入（UTC） | `backup` | `parseImport` | `activation` | 冷税落在 | `totalMs` |
| :--- | ---: | ---: | ---: | :--- | ---: |
| 09-21 07:56 | 15,832 | 11,900 | **22,881** | `activation` | 66,417 |
| 09-21 09:34 | 4,489 | **27,935** | 6,715 | `parseImport` 尾部 | 52,556 |
| 09-21 12:24 | **21,479** | 10,716 | 756 | `backup` | 46,497 |
| **09-21 13:42** | 3,075 | 7,799 | 531 | **无处**（cache 恰好是热的） | **26,216** |

⇒ P1 砍掉了 `parseImport` 尾部与 `activation` 两处后，**只剩 `backup` 一处还在付这笔税**，
而它是**当前唯一还能差出十几秒的单项**：热 3,075 ms / 冷 21,479 ms，**同一代码、同一数据，差 18.4 s**。

### 13.3 🔴 下一步（建议，未执行）：让 `quick_check` 跑在「读热之后」

**机理**：`PRAGMA quick_check` 逐页解析 B-tree 与索引一致性，冷态下每页都要从磁盘取
（真机三次实测 **11,851 / 11,993 / 12,108 ms**，高度一致）；而**顺序读一遍全库只要 1.2 s**。

`apps/api/src/import-worker.ts:787-798` 的顺序恰好是反的：

```ts
if (!this.isReadableDatabase(this.databasePath)) { … }          // ← 冷：~12 s（cache 已被 parseImport 冲掉）
await maintenance.ensureBackupCapacity();
await this.backupDatabase(currentDatabase, stagingBackupPath);   // ← 读全库，但为时已晚：~1.2 s
```

**受控实测（云机真机、506 MB、`drop_caches` 造冷、只读副本）**：

| 步骤 | 耗时 |
| :--- | ---: |
| 冷 `quick_check` | **11,993 ms** |
| 之后顺序读全库（≈ `backup` 的读） | **1,201 ms** |
| 再 `quick_check`（紧随读全库之后） | **260 ms** |
| **现行顺序合计**（qc 冷 + backup） | **13,194 ms** |
| **拟改顺序合计**（backup + qc 热） | **1,461 ms** |
| **差** | **11,733 ms** |

⇒ 1.2 s 的顺序读，把 `quick_check` 从 12.0 s 压到 0.26 s（**46×**）。
**同一份校验、同一个强度、不换裁判**，只是换成「读热了再判」。

**⑵ 这不是发明新语义 —— 生产代码已有先例**：`apps/api/src/maintenance.ts:213-217`（`deleteDatabase`）
就是「先 `createBackup`，**失败才** `isReadableDatabase` 诊断；不可读则 `preserveCorruptDatabase`」。

**⑶ 安全性**：备份本就先写 `.partial-<uuid>`、校验通过才 `rename`（`import-worker.ts:794`）
⇒ 顺序调整**不会**产出未经验证的正式备份；损坏路径多花的只是那 1.2 s 的 partial 写入（罕见）。

**⑷ 验收**
| # | 判据 | 方法 |
| :--- | :--- | :--- |
| 1 | 冷态下 `backup` 段 ≤ 5 s | 部署后读下一次导入的 `stagesMs.backup`（当前冷 21.5 s / 热 3.1 s） |
| 2 | **校验强度不变** | 突变验证：人为让 `isReadableDatabase` 返回 false ⇒ 仍走 `preserveCorruptDatabase` 且**不产出正式备份** |
| 3 | 正常路径无行为变化 | 连续两次导入的 `importJob.summary` 逐字段一致 |
| 4 | 门禁 | `typecheck` + 全量 node 测试 |

**⑸ 回滚**：单文件、无迁移 ⇒ `git revert` + 重启。

### 13.4 🟡 次选：消除 CLI 内部那次重复的全库复制（约 1.6 s + 506 MB 写）

同一次导入里出现了**两条**复制 staging 的埋点：

| 埋点 | ms | 代码 |
| :--- | ---: | :--- |
| `stagingCopy` | 1,556 | `import-worker.ts:438` —— 把刚做的备份 `copyFile` 成 `stagingDatabase` |
| `prepare_staging_copy` | 1,597 | `cli.ts:151-163` —— CLI 又把 `stagingDatabase` 复制成 `stagingDatabase.importing.<uuid>` |

两次的**输入内容相同**（都是主库副本）⇒ 一次导入实际做了 **3 份 506 MB 全库复制**，第 3 份是纯浪费。
它还会**加重 `backup` 段的冷态**（多写 506 MB 去挤 page cache）。
⚠️ 修它需要设计（CLI 的 `prepareStagingDatabase` 是"不弄脏调用方给的库"的封装，不能直接删）——
要么加显式开关，要么让 API 把它自己要用的路径直接传给 CLI。**不是一行改**。

### 13.5 ⚪ 更远：`trainingMetrics` 9,097 ms（占 `totalMs` 35%）

批次 4 已把它从 11,724 降到 9,097（−22%）。剩余部分属"评分内核/心率配速聚合"，
按既定原则**要有性能证据才推进**，先侦察再谈。

### 13.6 为什么建议**先做 13.3、而不是**排期里的批次 2（队列护栏）

| 维度 | 13.3（`backup` 顺序） | 批次 2（OPT-5+6 队列护栏） |
| :--- | :--- | :--- |
| 痛点是否已发生 | ✅ **每次导入都在付**（12–18 s，已四次实测） | ❌ **线上 135 条导入任务全部 `succeeded`，零失败**（本日实测） |
| 风险 | 低（单文件、语句重排、有既有先例） | 🔴 高（**v23 单向门** + 需停服窗口 + 回滚脚本须先演练） |
| 可逆性 | `git revert` | 只能还原迁移前备份 |
| 收益可量化 | ✅ 已实测 11.7 s | 护栏价值，无法用数据证明当下必要 |

⇒ 判断：**先做 13.3**（拿走已发生、已实测的 11.7 s），批次 2 等真正出现"任务反复重放"的证据再排。

---

## 14. §13.3 实施与验证（2026-09-21 晚）

改动面很小：`apps/api/src/import-worker.ts`（`createCurrentBackup` 重排 + 两个私有辅助方法）
与 `apps/api/test/worker.test.ts`（+2 用例）。

### 14.1 顺序重排

| 步骤 | 旧顺序 | **新顺序** |
| :--- | :--- | :--- |
| 1 | `isReadableDatabase` → **冷** `quick_check`（~12 s） | `ensureBackupCapacity` |
| 2 | `ensureBackupCapacity` | `backupDatabase` → `.partial-<uuid>`（顺序读全库，**顺手把页缓存读热**） |
| 3 | `backupDatabase` → `.partial-<uuid>` | `isReadableDatabase` → **热** `quick_check`（~0.26 s） |
| 4 | `rename` 发布 | `rename` 发布 |

### 14.2 四个不变量

| # | 不变量 | 怎么保住的 |
| :--- | :--- | :--- |
| 1 | **校验强度不变** | 用的还是同一个 `PRAGMA quick_check`，一个字没改，只换了跑的位置。**不是**换成结构探针 |
| 2 | **发布闸门不变** | `quick_check` 未通过时 `stagingBackupPath` **直接丢弃**，绝不 `rename` 成正式名（原来也是先写 partial、再发布） |
| 3 | **损坏路径不变** | 仍 `onDatabaseError` → `preserveCorruptDatabase` → 返回 `null`（调用方因此退回 `--replace` 全量导入） |
| 4 | **备份失败语义不变** | 新增的是「能读吗」这一步**分流**：能读 ⇒ 环境故障（盘满 / 权限 / EIO），清残片后**原样上抛**；不能读 ⇒ 备份失败本就是预期结果，改走隔离 |

### 14.3 突变验证（两条断言互不重叠）

| 用例 | 断言 | 突变 | 结果 |
| :--- | :--- | :--- | :--- |
| `reads the whole database for the backup before running the integrity check` | `events === ["backup","quick_check"]`（用 stub 记录真实调用次序） | 把顺序倒回旧实现（提前调一次 `isReadableDatabase` 但**不改行为**） | **只它变红** ✅ |
| `never publishes a safety backup from a database that fails its integrity check after the copy` | 校验失败 ⇒ 返回 `null`、`rai.before-web-import.<jobId>.sqlite` **不存在**、`var/backups` 无残片、quarantine 恰 1 个 | 保留校验调用但**不据其结果决定是否发布** | **只它变红** ✅ |

两次突变的红点互不重叠 ⇒ 每一条都钉住一个真实不变量，不是恒红、也不是靠编译错误变红。

### 14.4 门禁

| 门 | 读数 |
| :--- | :--- |
| `npm run typecheck` | ✅ 0 错 |
| node 全量 | **769 / 766 pass / 0 fail / 3 skip**（基线 767；+2 = 本次两条新用例） |
| web vitest（单跑） | **13 文件 / 85 tests 全过** |

### 14.5 一个已登记的行为差异（不影响正确性）

`ensureBackupCapacity()` 从「校验之后」挪到了「`backup` 之前」—— 写备份前必须腾空间，位置上没有别的选择。
它内部是 `reclaimDisplacedDatabases()`（只删匹配 `ABANDONED_DATABASE_FILE_PATTERN` 且**超过 `maxAgeMs`** 的孤儿副本）
+ `enforceBackupPolicy()`，**现在主库损坏时也会跑一次**。已确认在飞的暂存库受 `maxAgeMs` 保护、不会被误删；
实际效果是"多一次回收孤儿副本的机会"（`maintenance.ts:642` 的注释写明它本来就可以从多处驱动）。

### 14.6 部署实录（2026-09-21 22:11 CST）

线上 HEAD `1a72207` → **`48c9ede`**。部署范围只有 `apps/api/src` + `apps/api/test` + `deliverables/`
⇒ **`pull` + `restart`，无 build、无迁移、无 Rust 重编译**。

| 项 | 读数 |
| :--- | :--- |
| 迁移闸门（restart 前） | `version: 22` / **`pending: []`**；counts workouts 276 / route_points 113870 / health_records 122369 |
| 部署前备份 | `rai.manual.2026-09-21T14-11-01-674Z.46ebdc68.sqlite`（530,530,304 B）；部署后**回头确认仍在** ✅ |
| unit 一致性 | `INSTALLED_EQ_REPO true` / `HAS_EXIT78 true`（本批未改 `deploy/`，无需同步） |
| 停机 | 22:11:33 停 → 22:11:36 `Server listening` ⇒ **约 3 s** |
| 重启后状态 | `active` / `NRestarts=0` / `MainPID=2530529` |
| 启动日志 | `RAI local API ready`；**无迁移报错**；`publicReadHosts:["tpandmr.xyz","101.33.202.40"]` / `publicReadRoutes:26` / `tokenRequiredReadRoutes:12` |
| **引擎生效**（读运行进程的 `/proc/2530529/environ`） | `RAI_IMPORT_ENGINE=rust` + `RAI_RUST_FALLBACK=typescript` + `RAI_RUST_BINARY=/opt/rai-native/rai-data-worker` |
| 端点 | 匿名 `https://tpandmr.xyz/v1/health` **200** + `status:"ok"` + `databaseReady:true`；本机 `127.0.0.1` 匿名 **401**（Host 不在白名单，**符合预期**）；`/v1/data-summary` → **`issues: []`**，counts 与迁移闸门一致 |

### 14.7 🔴 部署后受控实测：A/B 直接量出收益（云机真机、506 MB、`drop_caches` 造冷）

单测只证明「顺序对了」，**证明不了「这个顺序值 12 s」** —— 而这两者之间的间隔正是本次改动的全部赌注。
所以在云机上拿真库的**只读副本**做了新旧顺序的 A/B：同一份 506 MB 数据，每轮都先 `drop_caches` 清页缓存。

| 顺序 | `quick_check` | `backup` | 合计 |
| :--- | ---: | ---: | ---: |
| **旧**（qc → backup） | **12,835 ms**（冷） | 1,569 ms | **14,405 ms** |
| **新**（backup → qc） | **276 ms**（热） | 1,808 ms | **2,083 ms** |
| **差** | **46.5×** | +239 ms | **−12,322 ms（−85.5%）** |

**两条「产物没变坏」的附带证据**：

| 判据 | 读数 |
| :--- | :--- |
| 两个顺序各自产出的备份文件 | MD5 **完全相同**（`97befe0be5dc1c70abaf5e5ad10f62f4`），同为 530,530,304 B |
| 新顺序产物的完整性 | `PRAGMA quick_check` → **`ok`** |

⇒ **收益兑现，且备份产物逐字节不变**。`backup()` 那 +239 ms 落在噪声里（占总量 1.7%）。
实测的 12,322 ms 与 §13.3 的预估模型（12 s 冷 qc − 0.26 s 热 qc ≈ 11.7 s）**误差 5%**
⇒ 那套「冷态是 I/O 等待、热态只剩 CPU」的机理判断成立，不是巧合。

### 14.8 还没拿到的最后一个读数：**下一次真实导入的 `stagesMs.backup`**

部署完成时读到的 `importJob` 是 **`2026-09-21T13:42:13Z`（CST 21:42）** —— 本次部署**之前**的快照
（那次 `stagesMs.backup` = 3,075 ms，恰好是热态）。按既有纪律这个数字**不能**用来判本次改动。
最终判据是小唐下一次上传 Apple Health 导出后，该次导入的 `stagesMs.backup` 是否落进 **5 s** 以内
（对照 §13.2 的 热 3,075 ms / 冷 21,479 ms）。

**回滚**（若判据未兑现）：`git revert 48c9ede`（或 `b1bb84a`）+ `systemctl restart rai-api`，单文件、无迁移。

---

## 15. 第五形态耦合的**最后一处**也修掉了：`nativeStats` 白名单（2026-09-21 23:0x）

### 15.1 问题

`apps/api/src/import-worker.ts:1566`（改动前行号）与 §12 那处是**同一个形状**：

```ts
if (item.type === "rai:native-engine" && ["health", "gpx", "aggregate", "apply-records"].includes(item.operation ?? "") && …
```

这是一份**接收端硬编码白名单**，而 `native` 的契约本身就是开放字典：

| 层 | 位置 | 形态 |
| --- | --- | --- |
| 契约 | `packages/api-contracts/src/index.ts:383` | `native?: Record<string, { rustCalls; typescriptFallbacks; wallMs; peakRssKiB }>` —— **开放** |
| 响应 schema | `apps/api/src/schemas.ts:515-520` | `additionalProperties: { type: "object", … }` —— **开放** |
| 接收端 | `apps/api/src/import-worker.ts:1566` | `[…4 个名字].includes(operation)` —— **封闭** ❌ |

⇒ Rust 侧新增一个 operation 时，**唯一不会报错**的一处就是这张表：新 operation 的
`rustCalls` / `wallMs` / `peakRssKiB` 会被静默吃掉，`performance.native` 里就是没有它，
而 `/v1/data-summary` 的 `issues` 照旧是 `[]`（与 §12.2 完全同构）。

**本次并没有新增 operation** ⇒ 修的是「下一次会踩的坑」，不是当前的故障。

### 15.2 改法（与 §12.3 同款：白名单 → 格式校验）

1. **发送端**（`packages/health-export-parser/src/native-worker.ts:29-41`）把原来的字面量联合类型
   提升为可运行的权威清单，并从 `index.ts` 导出：

   ```ts
   export const NATIVE_OPERATIONS = ["health", "gpx", "aggregate", "apply-records"] as const;
   export type NativeOperation = (typeof NATIVE_OPERATIONS)[number];
   ```

   编译期约束**一点没松**（`NativeMetrics["operation"]` 仍是这 4 个之一）。
2. **接收端**（`apps/api/src/import-worker.ts:135-159`）删掉数组白名单，换成
   `NATIVE_OPERATION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/` + 纯函数 `parseNativeEngineMessage()`。
   ⇒ **「加一个 operation 要改两处」的隐藏耦合消失**，但子进程仍不能往 `performance_json`
   里注入任意键（`__proto__` / 空格 / 点 / 大小写混写 / 33 字符以上全部被拒）。
3. 顺带收紧一处：`rai:native-failure` 的 `item.code` 原来靠 `item.code ?? ""` 与一个
   `item.code!` 断言，现改为 `typeof failure.code === "string"` 守卫后再赋值（去掉 `!`）。

**字段语义逐条对齐 `parseComputeStageMessage`**：`actual` 只认 `rust` / `typescript`；
`durationMs` 必须有限非负（否则**整条消息丢弃**）；`peakRssKiB` 非法时**只降级为 `null`**
（消息本身仍被接受），与 `processMaxRssKiB` 同款。

### 15.3 🔴 刻意**不**改的一处：`rai:native-failure` 的判定表

`import-worker.ts:1613` 的 `["unavailable", "invalid_protocol"]` **留着不动**，并且加了注释说明：
它是**语义判定表**（哪些 code 意味着"引擎不可用、必须拦住回退"），与
`packages/health-export-parser/src/native-worker.ts` 里那份（`unavailable` / `unsupported_xml`）
**刻意不同**（见 `NOTES-engineering.md` 的「回退名单不重合」条）。
改它会**改变行为**，所以它不该被"格式校验化"——判别规则是：
**丢掉一条数据 = 要修；决定一个动作 = 要显式改。**

### 15.4 回归断言与突变验证（三次突变，红点三个互不重叠）

新增 `apps/api/test/import-worker-native-engine-metric.test.ts`（**8 例**）：

| # | 断言 | 它钉住什么 |
| --- | --- | --- |
| 1 | 遍历 `NATIVE_OPERATIONS`，接收端**每个都认得** | **跨端耦合**：发送端声明了新 operation 而接收端不认识时立刻红 |
| 2 | 一个接收端**从未见过的合法** operation（`route-prune` 等）被接受 | §12.2 那个事故的等价场景本体 |
| 3 | `actual` 只认 `rust` / `typescript` | 枚举不被放宽 |
| 4 | 非法名字被拒（空 / 大写 / 下划线 / 数字开头 / 带点 / 带空格 / 33 字符 / `__proto__`） | 注入面没被放开 |
| 5-8 | `durationMs` 有限非负 · `type` 不匹配被拒 · `peakRssKiB` 降级为 `null` · 额外字段不影响解析 | 与 `parseComputeStageMessage` 语义一致 |

| 突变 | 改什么 | 变红的是 | 结论 |
| --- | --- | --- | --- |
| A | 把格式校验还原成旧的 4 名字白名单 | **只有 #2** | #2 真正钉住"新 operation 不被静默丢弃" |
| B | 把格式校验放宽成 `/^.*$/` | **只有 #4** | #4 真正钉住"注入面" |
| C | 把发送端清单里的 `apply-records` 改成 `apply_records` | **只有 #1** | #1 不是恒真，跨端断言有效 |

⇒ 三条断言各自钉住**一个**不变量，三处突变红点互不重叠（排除了「恒红」与「一次突变全红」的假证据）。

### 15.5 门禁

| 项 | 读数 | 对照 |
| --- | --- | --- |
| `npm run typecheck` | **0 错**（`tsconfig.pure.json` + `tsconfig.json`） | 与基线一致 |
| node 全量 | **777 / 774 pass / 0 fail / 3 skip** | 基线 769 ⇒ **+8**（= 新文件 8 例），fail 与 skip 均未变 |
| web vitest 单跑 | **13 文件 / 85 项**全过 | 与本批前一致 |

### 15.6 还没拿到的那个读数（未变）

线上最新导入仍是 **`2026-09-21T13:42:13Z`（CST 21:42）**，即 §14.6 部署（22:11 CST）**之前**的快照。
§14.8 的判据（下一次真实导入的 `stagesMs.backup` 是否 ≤ 5 s）**仍未拿到** —— 见 §16。

---

## 16. 「我现在该做什么」

**只有一件事需要你做，而且它不可替代：再上传一次 Apple Health 导出。**

理由：§13.3 的收益（云机 A/B 实测 **−12,322 ms**）目前只有**受控实测**证据，缺**真实导入**读数。
线上最新那次导入（CST 21:42）发生在部署（22:11）**之前**，按纪律不能用来判本次改动。
而 `stagesMs.backup` 这个读数**只能由一次真实导入产生** —— 我无法从服务器侧制造（造一次就是
一次真导入，会动你线上的库，代价不对称）。

到 23:07 为止，线上三项状态确认无异常：`cdd4034` 在位、`NRestarts=0`、
启动时间 `22:11:33 CST`（即 §14.6 那次，之后没再重启过）。

**判据**（拿到读数后我按这个判）：

| 结果 | 结论 | 动作 |
| --- | --- | --- |
| `stagesMs.backup` ≤ **5 s** | 收益兑现 | 无（对照 §13.2：热 3,075 ms / 冷 21,479 ms） |
| 仍在 12 s 上下 | `backup()` 没把页缓存读热 | `git revert 48c9ede` + `restart`，并改写结论为"该路径不适用此优化" |

⇒ **你现在只需要上传；剩下我接。** 上传完说一声"同步好了"，我读线上数据出结论。

（另：`nativeStats` 白名单本次已修，但那处**本来就没坏**——本次没有新增 operation，
所以它不影响这次读数，纯属预防。）

---

## 17. 部署后首个真实导入：判据**未兑现**，但**判据本身写错了**（2026-09-21 23:18 CST）

### 17.1 读数：`stagesMs.backup` = **13,759 ms**（判据要求 ≤ 5 s）

新导入 `web_import_mube49jo_…`，`createdAt` = **15:18:41Z（CST 23:18:41）**，晚于 §14.6 的重启（23:08:50）
⇒ 确实是新代码跑的。`status=succeeded`、`/v1/data-summary` 的 `issues: []`。

| 阶段 | 本次（新码） | 13:42（旧码） |
| --- | ---: | ---: |
| `backup` | **13,759** | 3,075 |
| `stagingCopy` | 1,505 | 1,556 |
| `parseImport` | 7,379 | 7,799 |
| `recompute` | 10,459 | 11,592 |
| `activation` | 490 | 531 |
| `totalMs` | 34,678 | 26,216 |

**按 §16 预先写下的判据，这不是"兑现"，要回滚。** 但把机理查清之后，那个判据是错的（见 17.4）。

### 17.2 14 次历史导入：`backup` 段是**双峰**的

从 `runtime.sqlite`（**不是**主库）的 `import_jobs.performance_json` 取全量：

| 时段 | `stagesMs.backup` | 解释 |
| --- | ---: | --- |
| 09-19 06:08 / 06:09 / 06:38 | 8,805 / 1,945 / 11,735 | 冷热交替 |
| 09-20 五次 | 1,757–2,079 | 全部热态 |
| 09-21 07:56 / 12:24（旧码） | 15,832 / 21,479 | 冷态 |
| 09-21 13:42（旧码） | 3,075 | 热态 |
| **09-21 15:18（新码）** | **13,759** | 见 17.4 |

⇒ **`backup` 段在"冷"这一侧一直是 8–21 s**，本次 13,759 落在旧码的历史冷态区间里
⇒ **单看这一次读数，无法区分"重排没生效"和"重排生效了但别的成本项变贵了"。**
⚠️ **这就是判据的缺陷：它把整段写成"必须 ≤5 s"，而这一整段里有两个独立的成本项。**

### 17.3 受控实测：**直接调用生产函数**，把两个成本项拆开

没有端点、也不想再让用户传一次 ⇒ 在云机上直接构造 worker 并调用**真实方法**，
用 monkey-patch 给两个私有步骤计时（脚本在 `/tmp`，跑完即删；只读打开主库，备份写 `/tmp`）：

```js
const w = new ImportWorker("/var/lib/rai/var/rai.sqlite", "/opt/rai", "/tmp/probe/rt");
w.backupDatabase = /* 计时包装 */; w.isReadableDatabase = /* 计时包装 */;
await w.createCurrentBackup("probe");
```

每一轮前 `sync; echo 3 > /proc/sys/vm/drop_caches` 造冷：

| # | 条件 | `backup()`（读 506 MB + 写 530 MB） | `quick_check`（506 MB 全扫） | 合计 |
| --- | --- | ---: | ---: | ---: |
| 1 | 空闲 + 冷缓存 | 2,359 | **284（热）** | **2,667** |
| 2 | 与 4 GB 写入**并发** | 8,052 | **331（热）** | 8,418 |
| 3 | 与 4 GB 写入**并发**（另一次采样） | 10,820 | **33,286（冷）** | 44,106 |
| 4 | **旧顺序** + 4 GB 并发 | 1,680 | **39,702（冷）** | 41,381 |
| — | 旧顺序，空闲（对照） | 1,569–1,674 | 12,835–24,910 | 14,405–26,584 |

**三条结论：**

1. ✅ **重排本身是对的，而且可稳定复现**：空闲冷缓存下 `quick_check` = **274–284 ms（热）**，6/6 次。
   旧顺序在同一条件下要付 **12.8–24.9 s** 的冷扫描 ⇒ 空闲时省 **约 12–24 s**。
2. 🔴 **这一段还有第二个、与 `quick_check` 无关的成本项**：`backup()` 本身要写 530 MB。
   它与「用户刚上传的 4 GB ZIP 的**回写尾巴**」并发时，从 2.4 s 涨到 **8.1–10.8 s**（3.4–4.5×）。
   ⇒ **生产那 13,759 ms ≈ 被回写拖慢的 `backup()` + 一个热的 `quick_check`。**
3. 🔴 **页缓存 warm-up 在重度写入压力下不可靠**：#2 时 `quick_check` 还是热（331 ms），
   #3 时同一个位置变成 **33.3 s** ⇒ 取决于回写恰好处于哪个相位。
   ⇒ 而**每一次 web 导入都紧跟在一次上传之后**，所以这个压力**不是偶发**。

⚠️ **第 4 行还给出一个必须承认的事实**：在**重度并发**下，"新 vs 旧"是 44.1 s vs 41.4 s ——
**新顺序略慢，落在噪声内**（两次采样里 `quick_check` 冷热不同）。**重排不是并发场景的解药。**

### 17.4 为什么 §16 的判据（≤5 s）是错的

它隐含假设"这一段的耗时 = `quick_check` 的耗时"。实际上：

```
stagesMs.backup = ensureBackupCapacity + backup()【读 506 MB + 写 530 MB】 + quick_check【读 506 MB】 + rename + 策略清理
```

- 重排只能消掉 `quick_check` 的**冷态溢价**；
- `backup()` 的 530 MB 写**没有变小**，而它恰好撞在上传回写最凶的时候。

⇒ **正确的判据是"同条件下的旧/新对比"，不是绝对值。** 空闲条件：**2.6 s vs 14.4–26.6 s**；
并发条件：**44.1 s vs 41.4 s（噪声内）**。按这个判据，重排**兑现**。

### 17.5 🔴 决定：**不回滚**

- 回滚只会回到"必然付一次冷 `quick_check`"，**在空闲条件下明确更差（+12–24 s）**；
- 在并发条件下两者同量级（噪声内），**回滚不带来任何好处**；
- 本次改动不改变任何安全语义（§14.2 的四个不变量都没动），线上 `issues: []`、`succeeded`。

⇒ **保留 `48c9ede`。** 判据按 17.4 修正为"同条件旧/新对比"。

### 17.6 下一个真正的瓶颈：`backup` 段撞在**上传回写**上

**根因**：每次 web 导入都先接收一次多 GB 的 ZIP 上传。上传请求返回时文件已"写好"，
但**脏页还在回写**；`createCurrentBackup` 恰好在此时要读 506 MB + 写 530 MB。

已排除（都实测过，不是原因）：内存压力（1,935 MB 总内存 / `buff/cache` 880 MB）、
目的目录在同一文件系统、活库带 `-shm`/`-wal`、定时备份 `rai-backup.timer`（每 40 分钟、每次仅 2–3 s，
23:18 前后**没有**运行）、其它 node/worker 进程（只有 `rai-api.service` 一个）。

**候选修法（都未实施，待拍板）：**

| 方案 | 做法 | 代价 / 风险 |
| --- | --- | --- |
| **A**（推荐） | 把安全备份挪到 **`activateDatabase` 之前**——那时回写早已结束。需同时把 `stagingCopy` 改成直接从**活库**复制（现在是从备份文件复制，一次复制兼两用） | 单文件改动，但动的是"备份内容 = staging 源"这个隐含耦合，要重跑 §14.3 的突变验证 |
| B | 上传落盘后 **`fsync`** 一次再入队，把回写移出导入窗口 | 上传请求变慢；总时长不变，只是把成本挪到不测量的地方 —— **属"看起来变快"**，要诚实标注 |
| C | 用 `probeDatabaseStructure`（4 ms）替掉这次 `quick_check` | **已登记的降级**：覆盖文件级损坏、**不覆盖页内静默篡改**；`createCurrentBackup` 这处的 quick_check 是 `preserveCorruptDatabase` 的触发器，**代价不对称** ⇒ 不建议单独砍（见 `NOTES-engineering.md`） |

### 17.7 复现手法（可复用）

- **先跑完 `dd` 再起探针 ⇒ 复现不出来**；必须让大写入**与探针并发**（`( dd … & ); sleep 0.8; node probe`）。
  这是本次唯一能复现生产现象的方法。
- **直接调用生产函数**（构造 `ImportWorker` + 给私有方法打计时包装）是在"没有端点、也不想再要一次真实导入"
  条件下唯一能"把线上那份代码当场跑一遍并拆开计时"的手段。
- 计时包装只能在**实例上**赋值（`w.backupDatabase = …`），因为原型方法是共享的。
- `runtime.sqlite` 里有 `import_jobs.performance_json` 全量历史 ⇒ 需要"多次采样"时先查它，别只读 `runtime-status` 的最新一条。
- 跑完必须清理：本轮探针在 `/tmp` 用了 **7.4 GB**（根分区 17 G → 23 G），删完回到 16 G。

---

## 18. §17.6 的「方案 A」：**实施前先被自己的实测证否**，改做真正的冗余（2026-09-22 CST）

### 18.1 起因

小唐批准「用你推荐的 a 方案推进实施」（= §17.6 表里的 A）。我在动代码前先算了一遍 I/O 总量。

### 18.2 🔴 算术：A **不减少**总 I/O，只是搬家

回写窗口内现行顺序的 I/O：

| 步骤 | 读 | 写 |
| --- | ---: | ---: |
| `backup()`（活库 → 安全备份） | 506 MB | 530 MB |
| `copyFile`（安全备份 → 暂存） | 530 MB | 530 MB |
| **合计** | **≈ 1.04 GB** | **≈ 1.06 GB** |

A 把 `backup()` 挪到窗口外，但**它省掉的只有"窗口内"三个字**：`backup()` 读的 506 MB + 写的 530 MB 一份没少，
只是挪到了 `activateDatabase` 之前。

而且 A 还要求「`stagingCopy` 改成直接从**活库**复制」——**这一步在 WAL 下必须用 backup API，不能用 `copyFile`**
（见 18.5 的本机实测）。backup API 比 `copyFile` 慢 2.3 倍 ⇒ **省下的窗口时间被吃回去。**

**结论：A 是"看起来变快"**（把成本挪到不测量的地方），必须诚实标注 —— 和 §17.6 表里我给 B 标的同一个毛病，
我给自己推荐的 A 犯了同样的错。

### 18.3 云机受控实测：A 反而**慢 89 ms**

条件：云机真机、506 MB **只读副本**、每轮 `drop_caches` 造冷、**并发 4 GB `dd` 写**复现回写窗口。

| 步骤 | 空闲 (ms) | 并发 (ms) |
| --- | ---: | ---: |
| `backup()`（backup API） | 2,329 | **8,030** |
| `copyFile` 530 MB | — | **4,524** |
| **V0**（现况）= `backup` + `copyFile` | — | **12,554** |
| **SEED** = backup API 活库 → 暂存 | — | **10,314** |
| **A 总计** = SEED + `backup`(空闲) | — | **12,643** |

⇒ **12,643 vs 12,554，A 慢 89 ms。方案 A 被证否。**

### 18.4 🔴 同时纠正 §17.6 的一个错误定性

§17.6 我把 `backup` 段 13,759 ms 归因为「撞在上传回写尾巴上」。**这个定性站不住**：
**同一次**导入里，紧跟其后的 `stagingCopy` 只有 **1,505 ms** —— 如果磁盘当时被回写拖住，
两次同样量级的读写不可能一次 13.8 s、一次 1.5 s。⇒ 磁盘当时是正常的。

`backup` 段的真实机理**仍未定性**（已排除项见 §17.6）。n=1、单次分不出 ⇒ 改为**加诊断埋点**（见 18.6 ③）。

### 18.5 A 的一个前提被本机实验打掉：`copyFile` 复制 WAL 活库**绝对不安全**

第一次实验我中途调了 `wal_checkpoint(PASSIVE)`，把 WAL 刷干净了，于是 `copyFile` 的副本"看起来"是对的
—— **那是一次假验证**。重做（`wal_autocheckpoint=0`，全程不 checkpoint）：

| 手法 | 结果 |
| --- | --- |
| `copyFile` 主库（主库文件仅 4 KB、WAL 1 MB） | 🔴 `no such table: marker`（表还在 WAL 里） |
| backup API | ✅ 200/200 行、`quick_check: ok` |
| 只读 `ATTACH … mode=ro` | ✅ 能看到并发写入（201 行） |

⇒ 「seed 从活库产出」**只能走 backup API**，这就是 18.2 里 A 收益被吃光的根据。

### 18.6 🟢 真正可证的冗余：CLI 把 worker 刚造好的暂存库**又整库复制了一遍**

放弃 A 之后，从**线上完整分阶段读数**（job `web_import_mube49jo…`，`TOTAL 34,678 ms`）往下看：

| 阶段 | ms | 占比 |
| --- | ---: | ---: |
| `backup` | 13,759 | 39.7% |
| `recompute` | 10,459 | 30.2% |
| `parseImport` | 7,379 | 21.3% |
| **`stagingCopy`** | **1,505** | 4.3% |
| `activation` | 490 | 1.4% |
| `changeAnalysis` | 280 | 0.8% |
| `cleanup` | 37 | 0.1% |

`stagesMs` 是固定七元组，看不到 `computeStagesMs` 里的细目（同一次最大项 `trainingMetrics` = 9,262 ms）。
读 `cli.ts` 才看见：**`stagingCopy` 与 `prepare_staging_copy` 是同一份库被复制了两次。**

- `apps/api/src/import-worker.ts` 的 `stagingCopy`：把主库复制成 `var/rai.importing.<jobId>.sqlite`（**worker 造暂存库**）
- `packages/health-export-parser/src/cli.ts:262-272` 的 `prepare_staging_copy`：CLI 拿到 `--database`（**就是上面那份暂存库**）
  后，按默认语义"这可能属于用户的生产库"，**又**用 backup API 整库复制成 `--database.importing.<uuid>`（实测 1,605 ms，
  另一份样本 `stagingCopy 1,745` 同量级），改完再 `publishDatabaseFile` 原子换回来 —— 而**它的产物 CLI 用完就删**。

CLI 的两层语义（复制 + 原子发布）在服务端场景下**两层都冗余**：worker 已经复制过一次，
且 worker 收尾靠的是 `activateDatabase`（把这份改好的库装到主库位），本来就不需要 CLI 再发布一次。

### 18.7 改法：`--database-is-staging`

`cli.ts` 四处 + `import-worker.ts` 两处：

| # | 位置 | 改动 |
| --- | --- | --- |
| ① | `cli.ts` `ParsedArguments` | 新增 `databaseIsStaging: boolean` |
| ② | `cli.ts` 参数解析 | `,databaseIsStaging: argv.includes("--database-is-staging")` |
| ③ | `cli.ts:289`（J1） | `stagingDatabase = args.databaseIsStaging ? requireExistingStagingDatabase(args.database) : await timedStage("prepare_staging_copy", …)` |
| ④ | `cli.ts:420`（J2） | `activation = args.databaseIsStaging ? { displacedDatabase: null, rollback: async () => {} } : await timedStage("activate_staging", …)` |
| ⑤ | `cli.ts:467` | **保护成品**：`if (stagingDatabase !== args.database) removeDatabaseFiles(stagingDatabase)` |
| ⑥ | `import-worker.ts:526-535` | 给 CLI 传 `--database-is-staging`，**且必须与那次 `copyFile` 同条件**（`currentBackupPath`）。无条件传递是本轮踩过的坑，详见 §19 |
| ⑦ | `import-worker.ts:33-42 / 861-895` | 新增 `SLOW_BACKUP_STAGE_THRESHOLD_MS = 5_000` + `createCurrentBackup` 慢路径诊断（拆出 `copyMs` / `verifyMs`，超阈值写一行 stderr） |

🔴 **③ 与 ④ 必须成对**：只跳过复制不跳过发布 ⇒ 数据被写进 uuid 副本、既不发布又被 `finally` 删掉
⇒ `--database` 留成**空库**（静默丢数据）。**⑤ 是这条路径唯一的保护**。三个不变量都由 18.9 的用例守着。

### 18.8 语义等价性论证（为什么可以就地改）

1. **安全备份已在原位完成于导入前** —— `createCurrentBackup` 在 worker 起 CLI **之前**跑，不动。
2. **`--source-database` 只喂审计报告头部标签**，CLI 全程只读主库（`cli.ts:119`）。
3. **`analyzeDatasetChange` 的输入不含 `--database`** —— 基线仍指向 `currentBackupPath`（`import-dataset-analysis.ts:25`
   的 `ATTACH DATABASE ? AS previous`）。
4. **发布原子性由 worker 的 `activateDatabase` 承担**（它先备份主库、再把改好的库装到主库位；
   失败由 `removeDatabaseFiles` 收尾）。
5. **CLI 锁文件只是进程互斥**，不编码"文件身份"，就地持有与复制副本持有等价（`acquireImportLock`）。
6. **`displacedDatabase` 无消费方**（`DISK_CAPACITY_AUDIT_2026-09-15.md:49`）⇒ 置 `null` 无副作用。

### 18.9 突变验证：**两个红点互不重叠**

新增两条用例（`packages/health-export-parser/test/cli-atomic.test.ts`）：#5
`in-place staging writes the finished database into --database itself`；
#6 `in-place staging leaves no whole-database copy or publish residue`。原 4 条不传新标志、走旧路径，仍全绿。

| 突变 | 内容 | 期望红点 | 实测 |
| --- | --- | --- | --- |
| **A** | J1 + J2 同时走旧路径 | 只有 #6 | ✅ 只有 #6 红 |
| **B** | 去掉 ⑤ 的 `if (stagingDatabase !== args.database)` 保护 | 只有 #5 | ✅ 只有 #5 红（`0 !== 1` @ `:242`，即成品被删、`summaries.count` 归零） |

🔴 **副产物（有价值的发现）**：突变 A 第一次**只改了 J1**（漏了 J2），红点落在 **#5** 而非 #6 —— 与预期相反。
手动复现查明：`"displacedDatabase": null`、目录无 `replaced`/`importing.<uuid>` ⇒
**数据被写进 uuid 副本、既不发布又被 `finally` 删掉，`--database` 留成空库**。
这正是 18.7 那条「③④ 必须成对」的实证，而 **#5 恰好抓到了它**。补齐 `MUTATION-A2` 后红点归位。

### 18.10 门禁（本机，全绿）

| 门禁 | 读数 |
| --- | --- |
| `npm run typecheck` | **EXIT=0**（`tsc --noEmit -p tsconfig.pure.json && tsc --noEmit -p tsconfig.json`） |
| node 全量（`packages/*/test/*.test.ts apps/api/test/*.test.ts`） | **781 例 / 778 pass / 0 fail / 3 skip** |
| `cli-atomic.test.ts` | **7/7 pass** |
| web 单跑（`npm run test -w @rai/web`） | **EXIT=0 / 13 文件 / 85 tests** |

⚠️ 记忆里的旧基线「node 767」**已过期**，别再拿它比总数（跨次比较 tests 总数无意义）。
本轮起点实测 **779 / 775 pass / 1 fail**，收尾 **781 / 778 pass / 0 fail**：
`+2` = 新增两条用例；`−1 fail` = §19 修掉的那个缺陷。

### 18.11 待验（下一个读数）

`prepare_staging_copy` 段应从 `computeStagesMs` 里**消失**（该段整段不再执行），`TOTAL` 预期 −1.5 s 左右。
按 §17.4 的纪律，判据写成**「同条件下旧/新对比」**，不写绝对阈值。

---

## 19. 实施过程中发现并修掉一个**真缺陷**：新标志必须与那次 `copyFile` 同条件（2026-09-22 CST）

### 19.1 现象

§18.7 那个标志第一次是**无条件**传给 CLI 的。改完后跑 node 全量：

```
not ok 250 - accepted Rust jobs keep their engine across restart and run the actual native decoder
# tests 779 / pass 775 / fail 1
```

作业 JSON 里 `stagesMs = { backup: 0.29, parseImport: 1,346.7, cleanup: 10.5 }` —— `parseImport` 抛出，
`computeStagesMs` 只走到 `parse_html_xml`，`native.health.rustCalls = 1`。报错出口是
`import-worker.ts:1689` 的 `Rust data worker: invalid_protocol`。

⚠️ 这个表象（Rust 协议错）**很容易被误判成"本地原生二进制过期"**：本机二进制建于
**2026-09-20 21:20**，而 `crates/` 在 **2026-09-21 12:58**（`1de8e8b`）、
`native-worker.ts` 在 **2026-09-21 23:07**（`92afe29`）都改过 —— 时间线"完全对得上"。
**但它不是原因。**

### 19.2 定性：干净 worktree 对照，**不能靠推理**

按纪律 8 做受控对照。`git worktree add --detach /tmp/rai-clean HEAD` 后，
🔴 **`node_modules/@rai/*` 是相对软链**（`../../packages/…`），只软链 `node_modules` 会让干净树的
`@rai/*` 仍指向脏工作区 —— 必须给 `@rai/*` 单独建**绝对**软链指向 `/tmp/rai-clean`（已校验 13 条全部 resolve 到干净树）。

另一个关键点：`nativeBinary()` 认 **`RAI_RUST_BINARY`** 环境变量，所以干净树能**复用同一个二进制**，
把变量固定成"只有源码不同"：

| 树 | 运行方式 | 结果 |
| --- | --- | --- |
| **干净**（HEAD `945cccc`，无本轮改动） | `RAI_RUST_BINARY=<同一个二进制> node --test apps/api/test/native-import-worker.test.ts` | **3/3 绿** |
| **脏**（含本轮改动） | 同文件、隔离跑 | **1 fail** |

⇒ **同一二进制、只差源码 ⇒ 是本轮改动引入的。** 那条"二进制过期"的推理作废。

### 19.3 机理

read `cli.ts` 的 `prepareStagingDatabase` 才看清：

```ts
async function prepareStagingDatabase(target: string, incremental: boolean): Promise<string> {
  const staging = `${target}.importing.${randomUUID()}`;   // ← 全量导入返回的是**尚未存在**的新路径
  removeDatabaseFiles(staging);
  if (!incremental) return staging;
  ...backup(target → staging)
}
```

所以 HEAD 下 `stagingDatabase !== args.database` **恒真**。而 worker 侧：

```ts
await this.removeDatabaseFiles(stagingDatabase);            // ← 先删
currentBackupPath = await timing.measure("backup", …);
if (currentBackupPath) {                                     // ← 重建只在这个守卫内
  await timing.measure("stagingCopy", () => copyFile(backupPath, stagingDatabase));
}
```

⇒ **全量导入（`--replace`，主库不存在 ⇒ 无备份）分支上，`--database` 是一个"还没被创建"的路径**。
HEAD 下 CLI 会在 `<target>.importing.<uuid>` 新建、解析、再发布到 `--database`；
带上我的标志后就变成"就地改 `--database` 本身"——**改一个不存在的东西**。

触发面：该测试第一条用例正是"全新临时库 ⇒ 全量导入"，所以它稳定命中；
真实场景对应**首次导入**（`main.sqlite` 还不存在时）。

### 19.4 修法一：标志收进那次 `copyFile` 的同一条件

```ts
...(currentBackupPath ? ["--batch-id", job.id] : ["--replace"]),
...
...(currentBackupPath ? ["--database-is-staging"] : []),
```

这与 §18.7 的「③④ 必须成对」是**同一类错误的两面**：都在讲"这个标志描述的是一条**有前提**的路径"。

### 19.5 修法二：CLI 侧新增守卫，把"静默丢数据"变成"大声报错"

```ts
function requireExistingStagingDatabase(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`--database-is-staging was declared but no staging database exists at ${path}`);
  }
  return path;
}
```

就地模式下**没有原子发布**（J2 跳过了），若路径本是空的，结果就是"用一份空库顶掉调用方指定的目标库" ——
静默数据丢失。这道守卫让它变成非 0 退出。调用端已按 19.4 收窄，这层是给**未来新增的调用方**兜底。

🟢 **一个有价值的旁证**：跑守卫用例时发现——**增量分支本来就有守卫**（`cli.ts:277`
`Incremental import requires a cloned active database: …`），所以它先命中、而不是我的新守卫。
这反过来证明：新守卫只在**全量分支**起作用，而**全量分支正是当时坏掉的那条**。
⇒ 守卫用例必须用 `import --replace` 形态，用 `incremental-import` 是**测不到**的（第一版就是这么写错的）。

### 19.6 两条回归断言（都**不依赖**原生二进制，因此对所有人可跑）

| 断言 | 位置 | 突变 | 实测红点 |
| --- | --- | --- | --- |
| `declares --database-is-staging only on the incremental branch` | `apps/api/test/worker.test.ts` | **C**：`…? ["--database-is-staging"] : ["--database-is-staging"]`（改回无条件） | 红 @ `worker.test.ts:2829`，`expected false / actual true` |
| `in-place staging refuses a --database that does not exist yet` | `packages/health-export-parser/test/cli-atomic.test.ts`（#7） | **D**：`if (false as boolean)` 替掉存在性检查 | 红 @ `cli-atomic.test.ts:305`，`承诺不成立时必须以非 0 退出` |

断言 C 的写法（捕获 CLI 参数）沿用 `worker.test.ts` 里已有的 `captureCommand` 夹具；
断言 D 复用 `runInPlaceStagingImport(…, "full")` —— 为此把该 runner 参数化成 `mode: "incremental" | "full"`。

### 19.7 教训（值得进分册的）

1. 🔴 **"某失败是不是我改出来的"要用「干净树 + 隔离单跑 + 固定外部依赖」三件套**。
   本轮若只做"全量对照"或只做"看时间线推理"，都会得出**错误结论**（"二进制过期，与我无关"）。
2. 🔴 **信号指向的方向可能是"最像的那个既有坑"**：`invalid_protocol` 的第一反应是"二进制过期"（第四形态），
   而真因是"参数契约的前提被破坏"。**表象的类别不代表根因的类别。**
3. 🔴 **新增"条件性开关"时，先找它描述的那条路径的前提条件，然后把开关钉在同一个条件上**；
   再在**收方**加一道"承诺不成立就报错"。发送方收窄 + 接收方校验，两侧都要有回归断言。
4. 🟡 **测守卫用例时，先确认"没有更早的同类守卫会先命中"** —— 否则测到的是旧守卫（本轮第一版即如此）。


