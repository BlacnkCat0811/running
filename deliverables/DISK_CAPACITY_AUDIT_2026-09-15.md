# 线上磁盘容量诊断 · tpandmr.xyz（lhins-3gatdqed）

日期：2026-09-15 17:30（Asia/Shanghai）
结论：**磁盘不是被日志或备份吃掉的，是被"导入回滚点"孤儿文件吃掉的 —— 89 个文件、36 GB、无任何回收机制。属于代码缺陷，不是运维疏忽。**

---

## 1. 现场数据

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda2        50G   46G  1.1G  98% /
```

| 路径 | 占用 | 判定 |
|---|---|---|
| `/var/lib/rai/var/*.replaced.*` | **36 G / 89 份** | 🔴 根因，纯孤儿 |
| `/var/lib/rai/var/backups/` | 3.0 G / 6 份 | 🟢 正常，有保留策略 |
| `/var/lib/rai/var/rai.sqlite` | 506 M | 🟢 活跃库，正常 |
| `/opt/rai` | 787 M | 🟢 代码 + dist + node_modules |
| `/var/log`（journal 135 M） | 178 M | 🟢 正常 |
| `/tmp` | 11 M | 🟢 正常 |

`/var/lib/rai` 合计 40 G ⇒ **其中 90% 是导入残留**。

## 2. 残留清单（模式化，同一形态 89 份）

```
/var/lib/rai/var/rai.importing.web_import_<jobId>.sqlite.replaced.<uuid>
```

- 单个 100 M – 506 M，合计 **36 G**
- 时间跨度 2026-09-04 → 09-15
- 9/12–9/14 三天新增 16 份（约 8 G）；9/15 单日新增 5 份（约 2.5 G）
- 每份大小 ≈ 全库体积（staging 是整库副本）

另有 2 个 8 K 的 `rai.sqlite.import.lock.stale.<uuid>/` 残留目录（同类问题的伴生垃圾，非容量问题）。

## 3. 根因链（每步带证据）

| # | 环节 | 证据 |
|---|---|---|
| 1 | worker 把当前库整库复制成 staging：`var/rai.importing.<jobId>.sqlite` | `apps/api/src/worker.ts:741` + `:757`（`copyFile(currentBackupPath, stagingDatabase)`） |
| 2 | worker 调 CLI，`--database` 指向该 staging | `apps/api/src/worker.ts:764-784` |
| 3 | CLI 内部再用 `<target>.importing.<uuid>` 做真正导入 | `packages/health-export-parser/src/cli.ts:90` |
| 4 | CLI 激活新库时，把**旧 staging** rename 成回滚点 `<target>.replaced.<uuid>` | `packages/health-export-parser/src/cli.ts:116`（`activateStagingDatabase`） |
| 5 | CLI 的 `finally` **只删** `<target>.importing.<uuid>`，不删 displaced | `packages/health-export-parser/src/cli.ts:354-361` |
| 6 | displaced 路径被写进 stdout JSON 返回 | `packages/health-export-parser/src/cli.ts:348` |
| 7 | **worker 全文没有任何代码读取或删除 `displacedDatabase`** —— 只有 `finally` 删自己的 staging | `apps/api/src/worker.ts:904-910`（且 `displacedDatabase` 在 worker.ts 中零匹配） |
| 8 | 对比：`var/backups/` 有 `enforceBackupPolicy` 兜底，`*.replaced.*` **没有任何机制** | `apps/api/src/worker.ts:1293`（`maintenance.enforceBackupPolicy`） |

⇒ **每次 web 导入遗留一份全库体积的孤儿副本，无上界。**

## 4. 为什么可以安全判定为"孤儿"

1. **无进程持有** —— `find /proc -maxdepth 3 -lname "*replaced*"` 零匹配。
2. **其对应的 target 已不存在** —— `rai.importing.web_import_<jobId>.sqlite` 本身已被 worker 的 finally 删除 ⇒ 该回滚点**不可达**（回滚需要 target 参与 move 操作）。
3. **导入前状态另有正规副本** —— `var/backups/rai.before-web-import.<jobId>.sqlite`（worker.ts:1272）。
4. **与活跃库无关** —— 当前 `rai.sqlite`（506 M，09-15 16:55）独立存在。
5. 服务健康：`rai-api` / `nginx` 均 `active`。

## 5. 紧迫性

磁盘剩余 **1.1 G**；单次导入的临时峰值占用约 1.0–1.5 G（staging + `.importing` + `.replaced`）。

🔴 **再导入 1–2 次即可能写满** ⇒ SQLite 写入失败、导入作业失败、API 报错。属应当立即处置的容量红线。

## 6. 处置方案

### 6.1 立即回收 —— ✅ 已于 2026-09-15 17:3x 执行

动手前的前置检查（都通过才执行）：
- `pgrep -af health-export-parser` 无匹配 ⇒ 没有导入作业在跑，`find -delete` 不会误删在途回滚点；
- `journalctl -u rai-api` 最近 12 行只有健康检查与只读 GET，无导入作业。

实际命令：

```bash
# 1) 先留档清单（字节数 + 文件名）
find /var/lib/rai/var -maxdepth 1 -name "rai.importing.web_import_*.sqlite.replaced.*" \
  -printf "%s\t%f\n" > /tmp/rai-replaced-manifest.txt
# 2) 再删除
find /var/lib/rai/var -maxdepth 1 -name "rai.importing.web_import_*.sqlite.replaced.*" -delete
```

结果：

| 项 | 前 | 后 |
|---|---|---|
| `df -h /` | 50G / **46G used (98%)** / 1.1G avail | 50G / **11G used (22%)** / 37G avail |
| `*.replaced.*` 数量 | 89 | **0** |
| `rai-api` / `nginx` | active | active |
| `/v1/health` | — | 无 token **401** / 带 token **200** `databaseReady:true` |

释放 **35 G**。删除清单留档于 `deliverables/DISK_CLEANUP_MANIFEST_2026-09-15.txt`。

🟡 **`rai.sqlite.import.lock.stale.*` 两个目录（8 K）特意没删** —— 不是容量问题，且 "stale lock" 可能承载锁状态语义；
为 8 K 冒语义风险不划算（风控原则：不做无收益的破坏性操作）。

可选顺带（约 85 M，本次未做）：`journalctl --vacuum-size=50M`。

回滚：删除不可逆，但删的是无引用孤儿（判据见 §4）；数据恢复依赖 `var/backups/` 与 `POST /v1/backups` 产物。

### 6.2 代码层修复（已实施）

⚠️ 规划期的第一版想法是「让 `cli.ts` 在提交成功后自删 displaced」，**动手时被现有测试否决**：
`packages/health-export-parser/test/cli-atomic.test.ts:80` 的用例名就写着
*"…and **retains** the displaced database"*，并断言该文件存在且内容可读
⇒ **"保留回滚点"是 CLI 的公开契约，不能单方面推翻。**
修复因此改在两处：既守住契约，又断掉堆积。

**A（断源）· `apps/api/src/worker.ts`**
导入的 `finally` 中回收**本轮**的 displaced：`reclaimDisplacedImportDatabases(stagingDatabase)`
按 `<staging>.replaced.` 前缀精确匹配（前缀含 `web_import_<jobId>`，不会误伤其他导入），
**仅当 `terminalSucceeded` 时执行**。
- 为什么 worker 有权删：它在导入开始前已写下 `var/backups/rai.before-web-import.<jobId>.sqlite`，
  与该回滚点内容等价 ⇒ 对本轮而言是纯冗余副本。
- 为什么不删失败路径：那时 displaced 可能是唯一可用的恢复点，必须留给人工。
- 落点：`worker.ts:910`（调用点）、`worker.ts:1915+`（方法本体）。

**B（防复发）· `apps/api/src/maintenance.ts`**
新增 `reclaimDisplacedDatabases()`，清扫 `<db>.replaced.<uuid>`
（正则 `\.replaced\.[0-9a-fA-F-]{36}$`），在 `ensureBackupCapacity()` 开头调用，
**只删 mtime 超过 24 h 的**（`DEFAULT_DISPLACED_DATABASE_MAX_AGE_MS`），
删目录/删错一律不动（`isFile()` 兜底），失败只写 stderr、不打断备份流程。
- 覆盖范围：进程被 SIGKILL（`finally` 不执行）、CLI 直跑（本机 `var/` 同样在堆）、其他忘记回收的调用方。
- 触发点：每次导入前、每次 `POST /v1/backups` 前（两者都必经 `ensureBackupCapacity`）。
- 取舍：**未**改 CLI 的保留契约；**未**加服务启动钩子（正常路径已被 A 覆盖，边际收益小）。

**测试与突变验证**（按项目纪律，突变必须看到 `not ok` 才算抓住）：

| 改动 | 新增测试 | 突变 | 结果 |
|---|---|---|---|
| worker 回收 | `worker.test.ts`「reclaims…committed import」「keeps…when an import fails before activation」 | 把 `terminalSucceeded ?` 改成 `false ?` | `not ok 85` ✅ |
| sweep 调用点 | `maintenance.test.ts`「reclaims…during backup capacity preparation」 | 调用点换成 `Promise.resolve()` | `not ok 40` ✅ |
| 24 h 窗口 | `maintenance.test.ts`「keeps fresh ones」 | 去掉 `mtimeMs > cutoff` 判断 | `not ok 39` ✅ |

全量：`npm run typecheck` 通过；`maintenance.test.ts` 40 pass / 1 skip / **0 fail**；
`worker.test.ts` 85 pass / 1 skip / **0 fail**。

⚠️ 改动落在 `apps/api/**` ⇒ 部署只需 `git pull --ff-only origin main` + `systemctl restart rai-api`
（tsx 直跑 TS，**不需要 build、无迁移**）。
**未部署前线上仍是旧行为**，每次导入继续遗留 ≈500 MB；剩余 37 G 可撑约 70 次导入，不紧急但有窗口期。

### 6.3 若要加监控（可选）

`/v1/health` 或运维侧加一条磁盘水位告警（如 `>80%` 即告警）。本次 98% 是**主动发现**的，说明缺这层保护。

---

## 7. 部署记录（2026-09-15 17:47–17:54）

| 步骤 | 结果 |
|---|---|
| 提交 | `492907f` `fix(api): reclaim displaced import rollback points`（4 文件 / +299）· `b95b404` `docs: record the online disk exhaustion and its cleanup`（2 文件 / +256） |
| 推送 | gitee `6e77d74..b95b404`，`origin/main` 已收，无 ahead/behind |
| 门禁 | `npm test` **EXIT=0**（node:test **599 / 595 pass / 0 fail / 4 skip** + vitest **13 文件 / 84 pass**） |
| 部署范围 | 仅 `apps/api/**` + `deliverables/**` ⇒ **无迁移、无依赖变更、无 web 变更** |
| 线上动作 | `git pull --ff-only`（`PULL_EXIT=0`）→ `systemctl restart rai-api`（**不需要 build**） |
| 线上 HEAD | `b95b404`；工作树仅 `?? .npm/` `?? .npmrc` 缓存噪声（非报错） |
| 启动 | journal 出现 `RAI local API ready`，**无迁移报错** |
| 接口 | `/v1/health` 无 token **401** / 带 token **200** + `databaseReady:true` |
| 站点 | `https://tpandmr.xyz/` **200**、`/settings` **200** |
| 磁盘 | **26%**（13G / 50G）—— 比清理后的 22% 高出的部分是本次新建的备份 |

**新代码在线上真被跑过，且验证了行为本身（不只是"没报错"）：**

- `POST /v1/backups` → 200。该路径必经 `ensureBackupCapacity() → reclaimDisplacedDatabases()`
  ⇒ 新代码在线上执行无异常，journal 里没有任何 reclamation 报错。
- 🔴 **期间出现一个意外样本**：17:44（清理之后、部署之前）网页端发生了一次导入
  （job `web_import_mu2hjmdi`，`status: succeeded`、`importMode: incremental`、271 条 workout 全部未变化）
  —— **旧代码为一次「数据无变化」的导入照样遗留了 506 M**。这既印证缺陷在真实使用中持续发生，
  也正好成为验证样本：
  1. **17:52 打备份**时，该文件（8 分钟前）**未**被删除 ⇒ **24 h 保护生效**（不会误删在途/近期回滚点）；
  2. 把它 `touch -d "2 days ago"` 后再打一发备份 ⇒ **被回收**，`find *.replaced.*` 归零
     ⇒ **sweep 确实在删，而非空转**。

---

## 8. 一句话总结

> 每次网页导入都会把旧库改名留一份"回滚点"，但成功提交后没人回收 —— 9 天累积 89 份、36 G，
> 把 50 G 的盘吃到 98%。根因是 `cli.ts:116` 造回滚点、`cli.ts:348` 只把路径写进 stdout、
> 而 `worker.ts:904-910` 从不消费它。
> **已执行**：删除 89 个孤儿，98% → 22%（释放 35 G）。
> **已修复并部署**（线上 HEAD `b95b404`）：worker 提交后回收本轮（`worker.ts:910`）+ maintenance 24 h 兜底清扫
> （`maintenance.ts`），守住 CLI「保留 displaced」的既有契约；3 组突变验证 + 线上双向实证（保留新鲜 / 回收超期）均通过。
