# RAI 项目完整审查报告 · 2026-09-23

> **审查对象**：`/Users/ta/running` 全仓（`packages/` + `apps/api/` + `apps/ios/` + `apps/web/` + `crates/` + `deploy/`）。
> **基线**：工作树**干净**，`main` = **`7e05285`**（2026-09-23 18:44），远端 `origin = https://gitee.com/tpandmr/running.git`。
> **对比的上轮**：`deliverables/BACKEND_IOS_AUDIT_2026-09-16.md`（基线 `b4cb6d9`）+ `deliverables/AUDIT_VERIFICATION_2026-09-21.md`。
> **增量**：`b4cb6d9..HEAD` = **129 个提交 / 385 个文件 / +57,892 −9,031**。
> **方法**：门禁六条全量实跑 → 逐条读码 → **7 个可复现探针/突变**（真库只读副本、干净 worktree、通道对照实验）→ 上轮每条结论**重新实测**，不复用任何旧 ✅。
> **未改任何业务代码；未触碰用户数据；`var/` 内文件 mtime 全部早于本次会话。**

> ### 📝 修订记录 · 2026-09-24（本报告发布后，随 N-1/N-2/N-3 修复一并订正）
>
> | 处 | 原文 | 订正为 | 依据 |
> |---|---|---|---|
> | §一 表格「仓库卫生」行 | "上轮绿区**回退**" | 删去"回退"：`.gitignore` **全历史从未有过**任何图片规则 ⇒ 不存在规则放松；根因是**上轮只有一次性人工清理、没留下闸门** | 逐版本扫 `.gitignore` 的 8 个历史提交，`grep -iE "png\|jpg\|design\|images"` 零命中 |
> | §四 N-3 正文 | 同上的"回退 / 规则太窄"暗含 | 就地插入 🔴 订正框（同上结论） | 同上 |
> | §六 行动表第 3 行 | "`git rm --cached` … 需 filter-repo 才彻底，**非本次目标**" | 升级为**已执行**的「出库并清历史」路径（用户拍板） | 见 `deliverables/N3_DESIGN_OUT_OF_TREE_2026-09-24.md` |
> | §八 未覆盖范围 | "`npm run test:e2e:web` 未整条跑" | **2026-09-24 已整条跑通**：11 项 / 10 通过 / 0 失败 / 1 跳过（390px 冻结响应式用例按设计 SKIP） | 见 `deliverables/N3_DESIGN_OUT_OF_TREE_2026-09-24.md` 门禁表 |
> | §四 N-1 / N-2 的方案行 | 方案为"照抄 342ae38 哈希源文本" | 实做改为**哈希行为**（跑探针集）而非源文本，并额外折入 `engine@version` | 见 `deliverables/N2_IDENTITY_FREEZE_2026-09-24.md`「为什么不用源文本哈希」 |
>
> **本次三份修复报告**：`deliverables/N1_MIGRATION_COMMENT_2026-09-24.md`（纯文案，机检 0 行代码）·
> `deliverables/N2_IDENTITY_FREEZE_2026-09-24.md`（两层机制 + 四组突变）·
> `deliverables/N3_DESIGN_OUT_OF_TREE_2026-09-24.md`（出库 + 历史重写）。
>
> ⚠️ 另有一处**自我纠错**记录在 N-1 报告 §2.2：本报告相关注释里写的"76 处 `.js` 相对导入"
> 只是 `./x.js` 的口径，**实测全量是 82 处**（`./x.js` 76 + `../x.js` 6）。已在 3 个文件订正。
>
> 除此之外，本报告正文（§一至§八）**其余结论与证据均未改动**——上列 5 处是措辞与状态的订正，不涉及任何分级翻转。

---

## 一、总结论（先行）

**健康度：A。本轮无 P0，09-16 审计的 🔴×1 + 🟡×7 + 🔡×2 全部实测闭环（0 遗留）；新发现集中在"门禁口径"与"捷径的唯一失效闸门仍只是注释"两处。**

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 质量门禁 | 🟢 绿 | typecheck / node 816 / vitest 86 / build+bundle 预算 / iOS 门禁 / **E2E 11-11** **全部本次实跑通过** |
| 上轮遗留闭环 | 🟢 绿 | **10/10 全部真修**（探针级复测，含 🔴 记录级重复的独立重算） |
| 记录层身份与去重 | 🟢 绿 | 本地库 160,051 → **83,380**、重复组 **0**、当前公式命中 **100%**（此前 0.00%） |
| 迁移校验和冻结 | 🟡 黄 | 机制**真·可证伪**（两条轴突变都红），但**注释把故障模式说反了**（见 N-1） |
| 导入锚点捷径 | 🟡 黄 | 唯一失效闸门 = 人工 bump `CONTRACT_VERSION`，**只有注释、没有门禁**（见 N-2） |
| iOS 后台同步 V2.1 | 🟢 绿 | 结构判据 217 条，我定点突变了 1 条 ⇒ **2 条具名 FAIL**，非恒绿 |
| API 鉴权/路由登记 | 🟢 绿 | 写端点 **24**（11/10/3 三集合互斥、枚举式门禁）；读端点 38 全部显式分类 |
| 数据层/SQL | 🟢 绿 | `json_each` 已加 `json_valid`+`CASE` 守卫；无现实注入面 |
| 仓库卫生 | 🟡 黄 | 新目录又入库 27MB / 6 张 4.4–4.8MB 设计图。**根因不是"规则太窄"**——`.gitignore` 全历史从未有过任何图片规则，上轮只是一次性人工清理、**没留下路径无关的闸门**（见 N-3） |
| CI | 🟡 黄 | `ci.yml` 判据完备，但远端是 **gitee** ⇒ GitHub Actions **永不运行**（见 N-5） |

**一句话**：这 129 个提交的质量是实的——上轮每一条我都用自己的探针重新打了一遍，包括把 76,671 行冗余的去重结果在真库副本上重算到 100% 命中；本轮最有价值的发现不是在业务逻辑里，而是**两处"以为自己有闸门"的地方：迁移冻结的注释把因果说反了，导入锚点的唯一闸门仍是一句注释**。

---

## 二、质量门禁实跑（全部本次实测，非引用）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | ✅ 通过 | 双 tsconfig，~50s，无诊断输出 |
| node:test 全量 | ✅ **816 项 / 813 pass / 3 skip / 0 fail** | 89.4s（`packages/*/test` + `apps/api/test`） |
| `npx vitest run --root apps/web` | ✅ **13 文件 / 86 pass** | 47.7s |
| `npm run build` + 体积预算 | ✅ EXIT=0 | dist 产物 22:06 重建（31 assets + index.html）；`check-bundle.mjs` EXIT=0 |
| `npm run test:ios` | ✅ 通过 | typecheck **55 文件**（跳 3 个高德依赖）；store 42 条 / tech presentation 52 条 / **background capabilities 217 条** / export determinism 14 条 全 0 failed |
| `test:e2e:web`（桌面 E2E） | ✅ **11 tests / 11 pass / 0 fail / 0 skip** | 78.9s |

> ⚠️ **E2E 的口径声明**：本轮**未整条跑** `npm run test:e2e:web`（该脚本含 `npm run build`，而本沙箱在**同一轮内第二次 build** 会触发 safe-delete 批量守卫）。改为：同轮先由该脚本构建出 dist，再对**该 dist** 直跑 `node --import tsx --test --test-concurrency=1 apps/web/e2e/web-flows.test.ts`。
> **dist 新鲜度判据**：`apps/web/dist/assets/*` mtime = **09-23 22:06**，而 `apps/web/src` 最后一次改动是 **09-22 12:30** ⇒ 产物比源码新。
> 另：`11 pass / 0 skip`（上轮记录为 10 pass / 1 skip）——390px 冻结用例此次**真的跑了并通过**，因为直跑时 `npm_lifecycle_event` 不是 `test:e2e:web`。

---

## 三、上轮遗留项闭环核验（逐条重测，不复用旧 ✅）

| 上轮项 | 本轮结论 | 我的复测证据 |
|---|---|---|
| 🔴 **P0** `health_records` 记录级重复 76,671 行 | ✅ **真修** | 真库只读副本重算：`COUNT(*)` **83,380**、唯一自然键 **83,380**、重复组 **0**、冗余 **0**；**按当前公式逐行重算 id 命中 83,380/83,380 = 100%**（09-16 实测为 **0.00%**）。孤儿 `import_entity_generations`/`tombstones` **0**；`__realign__` 残留 **0**；`schema_migrations` 22 条、v22 = `realign_health_record_stable_ids_and_remove_duplicates` |
| 🔴 P0 的第 3 步 `audit.ts:408` clamp 恒 0 | ✅ **真修** | 改为按自然键分组的**真实双向差**（`audit.ts:408-415`），不再 `Math.max(0, …)` |
| 🟡 P1-a 收据按内容匹配（假前提） | ✅ **真修** | 抽出纯函数 `PlanReceiptMatcher.confirm`；`WorkoutKitBridge.swift:276-295` 改按 `date`；**断言用的就是 09-16 报告里那个反例**——"a receipt names the day that reached the watch, not its identical twin"（`WorkoutPlanMapperRegression.swift:671-712`，含时区归一化的两个方向） |
| 🟡 P1-b 授权失败被映射成放行 | ✅ **真修** | `readAuthorizationState` 改为 `async throws`（`HealthKitExport.swift:216-240`）；查询抛错 ⇒ `nil` ⇒ 归拒绝路径；`requestAuthorization` 抛错 ⇒ `.unknown` |
| 🟡 P1-c 拒绝授权仍报"同步成功 0 条" | ✅ **真修** | `HealthKitSync.swift:1131-1138`：三类导出全 0 时给出"未读到任何健康数据…请在 设置→健康→数据访问与设备 中打开 RAI" |
| 🟡 P1-d 实测步负偏移被丢弃 | ✅ **真修** | `workout-segments.ts:205` `const startMs = Math.max(startedAtMs, rawStartMs);` |
| 🟡 P1-e 残骸无周期回收（1.22 GiB 在盘） | ✅ **真修** | `server.ts:745` `sweepAbandonedDatabases()`，启动后 **60s** 一次（`:766`）+ **每日**一次（`:763`）；`apps/api/test/maintenance.test.ts:1191-1310` 覆盖两种 staging 形态 + 在飞文件 + 畸形名 + 同名目录。**实测 `var/*.replaced.*` 已归零** |
| 🟡 P1-f CLI staging 命名不在回收模式内 | ✅ **真修** | 模式改为 `ABANDONED_DATABASE_FILE_PATTERN = /\.(?:replaced\.[0-9a-fA-F-]{36}\|importing\.[^/\\]+)$/`（`maintenance.ts:97-98`），一处模式同时覆盖两种形态 |
| 🟡 P1-g rollback 删除失败被静默吞掉 | ✅ **真修** | `import-worker.ts:1556-1570`：改为 `process.stderr.write("Failed to remove the import rollback point after commit: …")`（提交已成功，不宜再抛，但不再无痕） |
| 🔡 L-1 `json_each` 对裸字符串抛错 | ✅ **真修** | `database.ts:2726-2735`：`json_valid` + 双层 `CASE`，非数组/非 JSON 一律展开为 `[]` |
| 🔡 L-2 从不检查 `finish_reason === "length"` | ✅ **真修** | `weekly-plan-llm.ts:131` `finishReasonOf()`、`:268` 拦截 |

**闭环率：10/10。** 🔴 无遗留。

### 3.1 关于 P0 线上侧的口径（不夸大）

本轮**没有**云机通道（`lighthouse-ops` 未连接），**未亲验线上库**。线上结论只能引用仓库文档记录，且我把它标为**二手证据**：

- `deliverables/BATCH4_TIMEZONE_PLAN_2026-09-21.md:230`、`IMPORT_STAGE_ATTRIBUTION_2026-09-21.md:487`：两次部署的闸门读数均为 `version 22` + **`pending: []`**，`health_records` 114,159 → 114,162；
- `deliverables/FIX_VERIFICATION_2026-09-17.md:131`：本地迁移 160k 行实测 **44.3s** 停机窗口。

⇒ 线上**大概率**已迁移，但**这是推断的复用，不是本轮实测**。若要闭环，最小动作是云机只读一句：`SELECT MAX(version) FROM schema_migrations` + `SELECT COUNT(*) FROM health_records`。

---

## 四、分级问题清单（本轮新发现）

### 🟡 N-1　迁移冻结的注释把故障模式说反了——它描述的是**修复前**的行为

`packages/storage-sqlite/src/database.ts:1635-1636` 与 `test/migration-policy.test.ts:116-117` 都写着：

> 换 `node --experimental-strip-types` ⇒ **全部迁移集体失配、含线上在内的所有库立刻打不开**（实测抛 `Migration 1 checksum does not match the application`）

**我做了通道对照实验**（干净 worktree，同一份真库副本，只换执行通道）：

| 条件 | 22 个 checksum 与冻结值的漂移 | `RaiDatabase.open(既有库, refuse)` |
|---|---|---|
| `node --import tsx` | **0 个漂移** | **OK** |
| `node --experimental-strip-types` | **22/22 全部漂移** | **OK**（仍然打得开） |
| **修复前**的 `database.ts`（`342ae38^`）+ strip-types | — | **THREW `Migration 1 checksum does not match the application`** |

⇒ 结论：**运行时的校验值取自 `FROZEN_MIGRATION_CHECKSUMS`，与执行通道无关** —— 这正是 `342ae38` 想达到的效果，而且**达成了**。"换通道 ⇒ 所有库打不开"是**冻结之前**的真实现象（我在 `342ae38^` 上复现出来了），修复之后已不成立。

**为什么仍要改**：现在这句注释会把人往**危险方向**推。它下一条指令是"确需换通道时，必须先规划一次 checksum 重写迁移"——而**重写冻结值才真正会让既有库失配**（旧库行里存的是旧冻结值）。也就是说：注释描述的危害**不可能由换通道触发**，却**可能由照它行动触发**。

**建议改法**（纯文案，零行为变更）：
```
换执行通道 ⇒ ①门禁 `frozen checksums still match the transpiled source` 变红（这是期望的哨兵）；
②运行时不受影响（校验走冻结表）。真正会让既有库失配的是**去"修复"门禁**、把冻结值改成新通道的产物。
```

### 🟡 N-2　导入锚点捷径的唯一失效闸门**只有一句注释**，没有门禁（同型问题项目已解过）

`a974553` 的载荷级 pre-flight 用 `import_manifest['source_payload_anchor']` 做早退，其组合摘要折进四件事：载荷内容 / `CONTRACT_VERSION` / 删除语义 / 执行引擎（`import-payload-identity.ts`）。

残差风险由项目自己在 `IMPORT_PREFLIGHT_EARLY_EXIT_2026-09-23.md:28,96-107` 标为 🔴：**`stableId` / 内容哈希 / 解析规范化的算法变更，载荷一个字节都不变、`dataset_version` 也不变 ⇒ 锚点继续命中 ⇒ 新算法永远进不了库**（静默无操作）。缓解手段是"人工 bump `packages/contracts/src/index.ts:8` 的 `CONTRACT_VERSION`"。

**我查了这个约束有没有强制力**：

```
CONTRACT_VERSION 全仓引用（grep --include=*.ts packages apps）：
  contracts/src/index.ts:8          ← 定义
  apple-health-parser.ts:588        ← 写进 manifest
  recompute-pipeline.ts:323,955     ← 读 manifest 兜底
  import-worker.ts:886              ← 折进摘要
  import-payload-preflight.test.ts  ← **当"期望值"传参**
  parser.test.ts:71                 ← `assert.equal(manifest 值, CONTRACT_VERSION)`（同义反复）
⇒ 没有任何断言会在「算法改了、常量没 bump」时变红。
```

**这不是假想**——历史上有两次正是这一族变更：`6c61a9a` 删掉 `device` 维度（最后要靠 v22 全库迁移收拾）、`a9b0759` 给 `canonicalize` 加对象键序规范化。第二次没踩到，只是因为那时锚点还没上线。

**关键观察：同一个仓库在两行之外已经解过完全同型的问题。** `342ae38` 的做法就是「把**转译产物**（`up.toString()`）哈希冻结成一个常量 + 一条断言冻结值与当前产物相等」——改历史迁移立刻变红。把它套到身份算法上即可：

| 方案 | 强度 | 成本 |
|---|---|---|
| **A（推荐，照抄 342ae38）** | `FROZEN_IDENTITY_ALGORITHM` = `sha256(stableId.toString() + canonicalize.toString())`，断言之等于现算值。**任何**算法改动即红 | 常量 + 1 条断言 |
| B（弱一档） | 给两类内容哈希各钉一个 golden 值：`stableId("record_content", [fixture])` / `stableId("workout_content", [fixture])` | 2 条断言 |
| C（现状） | 只有模块注释 | 0 |

**判级说明**：不判 🔴，因为失效是**可恢复**的（bump 常量 + 一次完整导入），且项目**已经知情并写在文档里**；判 🟡 是因为按本仓纪律（记忆里第 2、3 条：*"脚本跑绿"≠"门禁存在"*、*"验收过的行为必须进回归断言"*），注释不是闸门。

### 🟡 N-3　仓库卫生：上轮清掉的同类大图在**新目录**复发，根因是**没有路径无关的闸门**（不是"规则太窄"）

- 上轮绿区结论：*"4~5MB 设计图已出库（最大残留 1.43MB）"*。
- 现状：`git ls-tree HEAD` 最大文件前六名全部是 **4.37–4.81 MB 的 PNG**，都在 `apps/ios/design/technology-v1/`，由 `255a7d8 docs(ios): include technology skin design boards and prompts` 入库。
- 实测 `du`：`apps/ios/design/` = **57 MB**（其中 `technology-v1/` = **27 MB**），`design/` = 1.4 MB。

> 🔴 **订正（2026-09-24 实测）**：本条初稿写过"卫生判据回退 / 规则太窄"，**这是错的**。
> 逐版本扫 `.gitignore` 全历史（8 个改过它的提交）确认：**从未出现过任何 `*.png`／`design`／`images` 规则**。
> 所以不存在"规则被放松"这件事——上轮做的是一次**一次性人工清理**，**没有留下任何自动入口**。
> ⇒ 这才是它在新目录复发的真实原因，也正是本仓纪律第 2 条的同型：*"脚本跑绿 ≠ 门禁存在"*，人工动作更不是门禁。

⇒ 设计稿的价值我认同（它们是皮肤改版的证据），但 27MB 二进制进 git 是不可逆的（历史里永远在）。
出库动作本身 + 路径无关的体积闸门见 `deliverables/N3_DESIGN_OUT_OF_TREE_2026-09-24.md`。

### 🟡 N-4　`import.lock.stale.<hex>` 墓碑目录无回收（🔡 量级）

`publication-lock.ts:203,213` 每次回收一个 stale lock 就 `renameSync` 出一个永久墓碑目录。实测 `var/` 下 **16 个**，每个 4KB（`owner.json`），最早 **09-01**。`ABANDONED_DATABASE_FILE_PATTERN` 只匹配**文件**、不匹配这两个名字。

总量 ~64KB，**不构成风险**；但形态是"每次抢占失败留一个永久目录"，与刚修好的 `.replaced.` 属同一族。一行正则即可并入，或不并——记录在案，等它真的开始涨再说。

### 🟡 N-5　CI 是**无执行者**的门禁

`.github/workflows/ci.yml` 判据很完整（`rust:verify` / iOS pod+model tests / `npm test` / `build` / `smoke:api` / `typecheck` / `ml:test` / `test:e2e:web`）。**但远端是 gitee**（`origin = https://gitee.com/tpandmr/running.git`）⇒ GitHub Actions **永不运行**。

实际自动门禁只有 `.githooks/pre-commit`（`core.hooksPath=.githooks`，已装）：

| pre-commit 段 | 触发面 | 内容 |
|---|---|---|
| 1 | **每次提交** | `npm run typecheck` |
| 2 | `apps/ios/**` 有改动 | `npm run test:ios` |
| 3 | `packages/storage-sqlite/**` 有改动 | 迁移冻结门禁（8 条测试） |

⇒ `ci.yml` 里的 e2e / ml / rust / smoke **目前是文档**。这是**已知情形**（pre-commit 注释自己写了"whose CI is not wired to its remote (gitee)"），但必须如实记录——它意味着 `npm test`（816 项）与 `test:e2e:web` 一样，**只在人记得时跑**。

> 附带：第 3 段的触发面**收窄到 `packages/storage-sqlite`**。而 N-1 那个"换执行通道"的动作发生在 `apps/api/package.json`（`start` 脚本）—— 那种提交**不会**触发迁移门禁，只会被下一次全量 `npm test` 抓到。考虑到 N-1 的实测结论（换通道不影响运行时），这个缺口**当前无害**，但它意味着"通道被换掉"这件事在本仓没有自动拦截。

### 🟡 N-6　生产备份回滚窗口 ≈ **46 分钟**（沿用 09-22 记录，本轮未复测）

`deploy/rai.env.example:44-46` 线上 `RAI_BACKUP_MAX_COUNT=14` / `MAX_TOTAL_BYTES=10 GiB`（与线上读到的"14 份 7.0 G"一致，策略**生效中**，非缺陷）。但项目自己在 `IOS_EXPORT_DETERMINISM_P0P1_IMPLEMENTATION_2026-09-22.md:200` 记录：**~17 次/h 导入节奏下，任意一份备份约 46 分钟后被挤掉**。

⇒ 健康数据主库的**实际可回滚窗口不到一小时**。本轮未复测（无云机通道）。若 `b91be75` 那批后台同步把导入频率推高，窗口会进一步缩短——建议下一轮把它与后台同步节奏**一起**测一次。

### 🟡 N-7　匿名只读面 26/38：全部跑步轨迹与心率序列对公网开放（**产品决策，非缺陷，必须点名**）

`server.ts:225-252` 的 `publicReadRoutes`（26 条）包含 `/v1/workouts`、`/v1/workouts/:id`、**`/v1/workouts/:id/series`**、`/v1/dashboard`、`/v1/mobile/today`、`/v1/mobile/goals`；`/v1/openapi.json` 与 `/v1/diagnostics` 留在 token 组。

**放行条件本身写得很严谨**（`local-request-security.ts:56-68`）：安全方法 ∧ 路由在清单里 ∧ Host 在清单里 ∧ **路由真的被解析过**（未匹配 URL 的 `routeUrl` 为 `undefined`，永不放行）——四者同时满足才匿名。而且有枚举式门禁：`server-runtime.test.ts:1500-1533` 会在"新挂载的 GET 既不在 public 也不在 token 列表"时**直接失败**。

⇒ 我**不建议**改。但作为风险面必须写清：**目前读侧没有任何凭据，唯一屏障是主机名 `tpandmr.xyz` 不可猜**。若要收窄，最小改动是把 `/v1/workouts/:id/series`（GPS 轨迹 + 心率时间序列）退回 token 组，其余概览页保持匿名。

---

## 五、绿区（已核实，含反证）

| 维度 | 关键证据 |
|---|---|
| **迁移冻结门禁非恒绿** | 干净 worktree 上两次突变：① 改 v1 的 SQL（`value TEXT NOT NULL DEFAULT ''`）⇒ `not ok 8 - frozen checksums still match…`；② 把 `apps/api/package.json` 的 `start` 换成 `node --experimental-strip-types` ⇒ `not ok 6 - production runs and migrates through tsx…`。两条轴**都真红** |
| **注释突变不红（符合设计）** | 给 v1 的 `up` 加一行注释 ⇒ 8/8 全绿。因为 `checksumOfTranspiledSource` 用的是 `up.toString()`，esbuild 剥注释。这不是漏网，是"钉转译产物形态"的定义 |
| **v22 迁移的自身安全性** | `database.ts:1511-1519`：id **既不等于当前公式、也不等于 legacy 公式**的行 ⇒ **整体 throw 中止**（"Refuse to guess… rewriting it would be a guess about someone's health data"）；改名用 `__realign__` 前缀 + `TEMP TABLE` 映射表中转，避免"目标 id 撞上别人的现有 id"；`health_records` 的改名**晚于**依赖表（因为依赖表按"是否在 records 里"选成员）。实测残留 0 |
| **iOS 后台结构判据非恒绿** | 我把 `HealthKitSync.swift:329` 的 `completion()` 移到 `Task { }` **之后** ⇒ `check-background-capabilities.py` 报 **2 条具名 FAIL**（"completion() no longer precedes 'Task {'…"），`217 checks, 2 failed` |
| **iOS 单事务提交** | `SyncTaskStore.commitSuccess`（`:238-293`）= `BEGIN IMMEDIATE` → 提交前回读旧值断言 → `COMMIT`；`:448-533` 的三条护栏"与 `commitSuccess` 同源（ADR-004 决策一）" |
| **突变脚本不是孤儿** | `package.json:38` 有 `test:ios:mutation`，且 `check-background-capabilities.py:477-478` **断言这个 script 条目存在**（"the harness would be an orphan"）——正是记忆里第 2 条要求的形态 |
| **路由登记完备** | 写端点 **24** = `metadataOnlyMutationRoutes` 11 + `databaseRequiredMutationRoutes` 10 + `lockOnlyMutationRoutes` 3（互斥）；`schemas.test.ts` 用**枚举式**断言"源码解析出的写路由数 == 挂载令牌数"，漏登记直接失败 |
| **读路由分类完备** | `server-runtime.test.ts:1500-1533` 三条：两集合都非空、无交集、**每个已挂载 `/v1/` GET 必居其一** |
| **写路径正字法** | 真库只读副本上按当前公式逐行重算 id：**命中 83,380 / 未命中 0**；孤儿 generations/tombstones 0；`__realign__` 残留 0 |
| **依赖方向/纯核心** | `typecheck` 双 tsconfig 全量绿 ⇒ `apps/web` 未 import API 实现、纯核心无逃逸 |
| **上轮 P1-a 的修法质量** | 用了 09-16 报告里的**原始反例**做断言，且额外覆盖"listed 时刻在 UTC 归一化后被读成计划时区的那一天"两个方向（`WorkoutPlanMapperRegression.swift:693-712`） |
| **导入预先检查的守卫三方** | pre-flight 命中需同时满足：非删除型载荷 ∧ 主库有锚点 ∧ 锚点绑定的 `dataset_version` 等于主库当前值；四类畸形锚点一律降级为"无锚点"（`import-payload-preflight.test.ts` 9 条，含"载荷读不到 ⇒ 退回完整路径而非失败"） |

---

## 六、行动建议（按"可逆性 + 收益"，附验收与回滚）

| 序 | 项 | 改动 | 验收标准 | 回滚 |
|---|---|---|---|---|
| 1 | **N-1** 迁移冻结注释订正 | 改 `database.ts:1635-1636` + `migration-policy.test.ts:116-117` 的因果描述 | 文案不再声称"换通道 ⇒ 既有库打不开"；引用本报告的三行对照实验 | 纯文档，`git checkout --` |
| 2 | **N-2** 给身份算法加冻结闸门 | 照抄 342ae38：`FROZEN_IDENTITY_ALGORITHM = sha256(stableId.toString()+canonicalize.toString())` + 一条断言；或先做金色值版（两内容哈希各 1 条） | **突变验证**：给 `canonicalize` 加一行无害逻辑（或改 `stableId` 的 `hash.update` 顺序）⇒ 断言必须红 | 单文件 revert（纯新增常量+测试） |
| 3 | **N-3** 设计图出库 | ~~`git rm --cached` + 外链~~ ⇒ **2026-09-24 已升级为「出库并清历史」**（用户拍板）：外置备份 → 引用改写 → `git rm` → `git filter-repo --invert-paths` 重写全历史 → 强推 | `git ls-tree -r -l HEAD` 最大 ≤1.5MB ∧ 新 clone 体积真降 ~27MB + pre-commit 体积闸门（先红后绿突变） | 🔴 **不可逆**：备份见 `~/Documents/rai-design-archive-technology-v1/`（6 张 PNG sha256 与 HEAD blob 逐个一致） |
| 4 | **N-6** 复测线上备份窗口 | 云机只读：`ls -l /var/backups/rai` 取份数+时间跨度；对照 `journalctl -u rai-api \| grep -c before-` 的导入频率 | 给出"当前节奏下任意一份备份的可回滚分钟数"，与 46 min 对照 | 只读，无回滚需求 |
| 5 | **N-4** 墓碑目录并入回收 | `ABANDONED_DATABASE_FILE_PATTERN` 增分支匹配 `\.import\.lock\.stale\.[0-9a-f]{16}$`（**目录**，需 `lstat` 判目录） | 手工放一个 25h 前的墓碑目录 ⇒ 一次 sweep 后被删 | 单文件 revert |
| 6 | **N-7**（可选产品决策） | 把 `/v1/workouts/:id/series` 从 public 移到 token 组 | `server-runtime.test.ts` 三条分类门禁仍绿；匿名 `GET /v1/workouts/:id/series` 得 401 | 单文件 revert |
| 7 | **N-5**（需要你拍板） | CI 要么搬到 gitee GoTo/自建 runner，要么把 `ci.yml` 明确标注"仅供参考、无执行者" | 若搬：任一次 push 能在 CI 侧看到 `npm test` 的 816 项 | 删 workflow 文件 |

---

## 七、对辅助结论的反向复核（纠正了谁、纠了什么）

1. **纠正项目自己的注释（N-1）**。`database.ts:1635-1636` 与 `migration-policy.test.ts:116-117` 称"换通道 ⇒ 所有既有库（含线上）打不开"。我在干净 worktree 上做了三组对照：tsx 通道下 `open` OK；strip-types 通道下 22 个 checksum 全漂移但 `open` **仍 OK**；把代码回退到 `342ae38^` 才复现出那句报错。⇒ **该故障模式已被本次修复消除**，注释描述的是修复前行为。**结论方向不变（不要重冻结冻结值），但因果被纠正，且它诱导的"checksum 重写迁移"才是真危险。**

2. **纠正"上轮遗留项已全部闭环"这个可能的乐观读法**。上轮 10 条确实是 10 条真修，我逐条用自己的探针打了；但其中 🔴 P0 的**线上侧**我**没有**实测（无云机通道），只引用了仓库里 09-21 两次部署的闸门读数。**本地实证 ≠ 线上实证**，这一点在报告里分开写而不是合并成"P0 已闭环"。

3. **收窄一条可能的误读**：`npm run test:ios` 输出里的 `Background capability checks: 217 checks, 0 failed` 是**结构判据**（扫源码模式），不是行为验证。我用一次定点突变证明了它**可被证伪**（移 `completion()` ⇒ 2 FAIL），但它仍然不覆盖"真机锁屏时序"——那需要真机。

4. **确认一条容易误判为缺陷的设计**：`var/*-shm` / `*-wal` 侧车存在是 WAL 模式的正常产物，且 `migration-policy.test.ts:37-38` 明确写了"refuse 保证无 schema/数据写入，不保证没有 OS 协调文件"。mtime 全部早于本次会话 ⇒ 非本轮产生。

---

## 八、未覆盖范围（如实声明）

- **真机 / 模拟器**：本轮**未跑** `xcodebuild`（未做 UI 视觉回归，`run-visual-tests.sh` 需要已启动的 Simulator + `var/rai.sqlite`）。iOS 结论是**编译级 + 纯逻辑级 + 结构判据级**。锁屏 `errorDatabaseInaccessible` 的真实抛出形态、`protectedDataDidBecomeAvailable` 的真实时序、`enableBackgroundDelivery(.hourly)` 的实际唤醒频率，**均未验证**。
- **突变套件未跑**：`npm run test:ios:mutation`（`check-background-mutations.py`，项目自述"十几分钟、会改写源码"）**本轮未执行**。替代：在干净 worktree 上做了 **1 条定点突变**（`completion()` 顺序）并取得具名 FAIL。新增判据的突变项覆盖度**未复核**。
- **线上环境**：**未接触**。N-6（备份窗口）与 P0 的线上命中率都只能引用仓库文档。
- **`npm run test:e2e:web` 未整条跑**（沙箱回收后台任务 + 同轮二次 build 会撞 safe-delete 守卫）；替代方案与 dist 新鲜度判据见 §二 的口径声明。
- **未做**：`packages/health-export-parser` / `storage-sqlite` 的逐模块深审；`crates/`（Rust 数据引擎）本轮只跑了 `npm run typecheck` 覆盖不到的部分——**Rust 引擎本轮零验证**（`RAI_IMPORT_ENGINE=rust` 的线上行为、B1–B5 不变量在真数据上的命中面，均未测）。
- **未做**：Web 侧深审（只跑门禁，未审 129 个提交里的 `apps/web` 改动）。
- 审查**未修改任何业务代码**；探针在 `/tmp/raiaudit23/`，突变在 `/tmp/rai-mut`（已 `git worktree remove --force`）；`var/` 内文件 mtime 全部早于会话开始（22:03）。

---

## 附：本轮探针与突变清单（可复现）

```
/tmp/raiaudit23/p0probe2.mjs                      真库只读副本：总数/唯一自然键/重复组/孤立 generations+tombsons/__realign__ 残留/按当前公式逐行重算命中率
/tmp/raiaudit23/channel-probe.ts + /tmp/rai-mut    通道对照：tsx vs --experimental-strip-types 的漂移数与 open() 结果 → 22/22 漂移、open 仍 OK
/tmp/rai-mut（git worktree，HEAD 7e05285）         突变 M1 注释（不红，符合设计）/ M2 改历史迁移 SQL（test 8 红）/ M3 换执行通道（test 6 红）
/tmp/rai-mut（342ae38^ 的 database.ts）            修复前代码 + 换通道 ⇒ 复现 "Migration 1 checksum does not match the application"
/tmp/rai-mut                                       突变 iOS 结构判据（completion() 移到 Task 之后）⇒ 217 checks / 2 failed
```

*报告时点：2026-09-23 23:0x（Asia/Shanghai）｜基线 `7e05285`，工作树干净*
*审查过程未修改任何业务代码、未触碰用户数据；探针与突变全部在 `/tmp` 的只读副本或可丢弃 worktree 内完成，已清理。*
