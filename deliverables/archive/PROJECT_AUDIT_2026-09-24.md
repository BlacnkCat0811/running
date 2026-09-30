# RAI 项目完整审查报告 · 2026-09-24（晚）

> **审查对象**：`/Users/ta/running` 全仓（`packages/` + `apps/api/` + `apps/ios/` + `apps/web/` + `crates/` + `deploy/`）。
> **基线**：工作树**干净**，`main` = **`49c9ef9`**（2026-09-24 18:54），远端 `origin = https://gitee.com/tpandmr/running.git`。
> **对比的上轮**：`deliverables/PROJECT_AUDIT_2026-09-23.md`（基线 `7e05285`，该哈希已因 N-3 的 filter-repo 历史重写不可寻址；语义基线 = 09-23 18:44 的 main）。
> **增量**：上轮审计之后 **12 个提交**，业务代码集中在 `e2e4110`（iOS 后台同步三项修复，+1174/−157）与 N-1/N-2/N-3 修复（`83ec794` / `378cb66` / `9e1cf13`）；其余为文档与分支清理。
> **方法**：门禁八条全量实跑（含上轮零覆盖的 Rust verify 与 smoke:api）→ 增量逐行读码 → N-2 冻结闸门**突变验证到红** → 云机只读探针（N-6 备份窗口 + 上轮 P0 线上侧一手闭环）。未改任何业务代码；未触碰用户数据；突变与探针全部在 `/tmp` worktree 与只读副本内完成。

---

## 一、总结论（先行）

**健康度：A。本轮无 🔴、无新增 P0/P1。上轮 7 项遗留中 4 项真修闭环（含两项我亲手突变/云机复测）、1 项实测大幅缓解（N-6）、2 项维持原判（N-4/N-5）；增量核心 `e2e4110` 的三处修复读码确认质量高。新发现仅 1 条 🟡（Keychain 保存失败静默）与 2 条 🔡。**

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 质量门禁 | 🟢 绿 | **8/8 全部本次实跑通过**（含上轮零覆盖的 `rust:verify` 与 `smoke:api`）；node 822/818/0/4 与 09-24 早核验逐字一致 |
| 上轮遗留闭环（N-1~N-7） | 🟢 绿 | N-1/N-2/N-3 真修（N-2 突变到红、N-3 对象账 3659==3659）；N-6 实测窗口 **5h52m**（原 46min）；N-4/N-5/N-7 维持原判 |
| 上轮 P0 线上侧 | 🟢 绿 | **一手实测**（替代上轮的二手引用）：线上 `schema_migrations` = **v22/22**、`health_records` = **130,715** |
| e2e4110 iOS 后台同步修复 | 🟢 绿 | 意图「读-不删-确认」闭环、决策全部改按目标快照、`(scope, workout_uuid)` 复合主键带一次性事务迁移——读码确认三处修复到位 |
| 仓库卫生 | 🟢 绿 | HEAD 最大文件 1.36MB（≤1.5MB 闸门）、`.git` 32MB、对象账差额 0、体积闸门在 pre-commit:12 |
| API 鉴权/路由 | 🟢 绿 | 写端点登记枚举式门禁维持；公开读 26 / token 读 12 与上轮一致（N-7 产品决策维持） |
| Web 侧（上轮零深审，本轮补抽样） | 🟢 绿 | XSS 面零命中（无 innerHTML/eval/dangerouslySetInnerHTML）；XHR 上传路径 token 已手动补齐 |
| 密钥卫生 | 🟢 绿 | 仓内仅 `.env.example` 与占位符 frp token，无真实凭据 |
| Rust 数据引擎（上轮零验证，本轮补） | 🟢 绿 | `rust:verify` = cargo test（2/2）+ node 集成 11/11（含 B1–B5 不变量用例），0 warning |

**一句话**：这一轮项目的重点是把上轮审计的发现真正关掉——N-1/N-2/N-3 的修复不是表面文章（我突变了 N-2 的闸门、对了 N-3 的对象账、上了云机读 N-6 和线上库），全部立得住；iOS 后台同步的三处修复是 HEAD 上最大的一笔业务改动，其「意图只在耐久检查点后确认、且只确认本轮观察到的代次」的设计把上一轮发现的整族「静默丢批次/白读 HealthKit」问题一次性关死。

---

## 二、质量门禁实跑（全部本次实测，非引用）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | ✅ EXIT=0 | 双 tsconfig，无诊断输出 |
| node:test 全量 | ✅ **822 项 / 818 pass / 0 fail / 4 skip** | 分 4 批跑（91+59+274+398）；4 个 skip 逐一确认：1× EPERM fail-safe（publication lock PID reuse，已知项）+ 3× Windows-only，**无覆盖丢失** |
| `npx vitest run --root apps/web` | ✅ **13 文件 / 86 tests / 0 fail** | 两段口径：9 文件 74 tests 全 ✓（进程在汇总阶段被沙箱回收）+ 4 文件 12 tests EXIT=0；合计 86/86 |
| `npm run test:ios` | ✅ EXIT=0 | typecheck 55 文件（跳 3 个高德依赖）；**Background capability checks: 252 / 0 failed**（上轮 217 ⇒ e2e4110 新增 35 条判据）；store 62 / route persistence 49 / tech presentation 52 / export determinism 14 |
| `npm run test:e2e:web` | ✅ **11 tests / 10 pass / 0 fail / 1 skip** | npm 脚本口径（390px 冻结用例按 `npm_lifecycle_event` 互斥 skip，正常形态）；无 safe-delete 拦截 |
| `node apps/web/scripts/check-bundle.mjs` | ✅ EXIT=0 | dist 23:27 重建（E2E 同轮产物） |
| `npm run rust:verify` | ✅ EXIT=0 | `cargo build --release --locked` + `cargo test`（**2/2**）+ node 侧 native-worker/native-import-worker（**11/11**，含 B1–B4 写路径不变量）；**0 编译警告** |
| `npm run smoke:api` | ✅ EXIT=0 | "Production API runtime smoke test passed" |

> ⚠️ **环境口径（如实记录）**：本轮会话沙箱资源紧张，node 全量与 vitest 整批跑多次被 SIGKILL（exit 137），**全部通过分批 + `--test-concurrency=1` / `--maxWorkers=1` 完成**。各批全绿且无 not-ok 行；唯一没有官方 EXIT 码的是 vitest 第一段（74 tests 全 ✓ 但进程在 summary 输出前被回收）。这不是代码缺陷，是本机当前状态的跑法事实——**下轮若同样遇 137，直接分批，不要反复重试整批**。

---

## 三、上轮遗留项闭环核验（逐条重测，不复用旧 ✅）

| 上轮项 | 本轮结论 | 我的复测证据 |
|---|---|---|
| 🟡 N-1 迁移冻结注释因果说反 | ✅ **真修** | `database.ts:1628-1650`：注释已重写为四组对照实验表格（当前代码 × tsx / strip-types、`342ae38^` × 两通道），明确「换通道 ⇒ 既有库打不开」是冻结**之前**的行为、真正危险的是改冻结表本身 |
| 🟡 N-2 身份算法唯一闸门是注释 | ✅ **真修 + 突变到红** | `identity-algorithm.ts:152` `FROZEN_IDENTITY_ALGORITHM` 常量 + `identity-algorithm.test.ts:21-41` 哨兵断言 + `import-worker.ts:895` 运行时折入摘要（`engine` 同时升级为 `name@version`，`import-payload-identity.ts:87-94`）。**突变验证**：干净 worktree 里给 `stableId` 的 `hash.update(kind)` 后插入 `hash.update("MUTATION")` ⇒ **2 条断言红**（哨兵 + legacy 公式），基线 6/6 绿 ⇒ 闸门真实可证伪 |
| 🟡 N-3 设计图出库 + 体积闸门 | ✅ **真修** | `git ls-tree -r -l HEAD` 最大文件 **1.36MB**（`design/ios-ui-concept-v2.png`，≤1.5MB）；`.git` = **32MB**（filter-repo 前 59MB）；**对象账**：`cat-file --batch-all-objects` 3659 == `rev-list --objects --all` 3659，**差额 0**；闸门 `scripts/check-blob-size.mjs` 在 `.githooks/pre-commit:12`，每次提交都跑、路径无关 |
| 🔡 N-4 `import.lock.stale` 墓碑目录无回收 | ❌ **未修（维持原判）** | `maintenance.ts:105-106` 模式仍为 `/\.(?:replaced\.[0-9a-fA-F-]{36}|importing\.[^/\\]+)$/`，不含墓碑目录；实测 `var/` 下仍 **16 个**（与上轮持平，未增长）⇒ 维持「记录在案，涨了再说」 |
| 🟡 N-5 CI 无执行者 | ❌ **未变（维持原判）** | `git remote -v` 仍为 gitee ⇒ `ci.yml` 依旧永不运行；实际自动门禁仍是 pre-commit 三段（typecheck + 条件 iOS + 条件迁移冻结）+ 本轮已确认的体积闸门 |
| 🟡 N-6 生产备份回滚窗口 ≈46min | ✅ **实测大幅缓解** | 云机只读（2026-09-24 23:52）：`/var/lib/rai/var/backups` **14 份**（= `RAI_BACKUP_MAX_COUNT=14` 上限生效）、每份 506MB、最旧 18:00 → 最新 23:52 ⇒ **回滚窗口 5h52m**（较 09-22 记录的 46min **改善 ~7.6×**，导入节奏已降至 ~2.4 份/h）。⚠️ 窗口仍由导入频率决定，iOS 后台同步若推高频率会再次收窄 |
| 🟡 N-7 匿名只读 26/38 | ➖ **未变（产品决策维持）** | `server.ts:225-252` 公开读 26 条（含 `/v1/workouts/:id/series`）+ `:256-269` token 读 12 条，与上轮逐条一致 |

**闭环率：4 真修 + 1 实测缓解 + 2 维持原判，无恶化。**

### 3.1 上轮 P0 的线上侧口径（本轮升为一手证据）

上轮报告 §3.1 明确写了「线上结论只能引用仓库文档，是二手证据」。本轮用云机只读探针（`node:sqlite` `readOnly:true`，base64 通道传脚本，跑完即删）闭环：

```
schema_migrations: {"v": 22, "n": 22}          ← 线上已迁移至 v22（realign_health_record_stable_ids_and_remove_duplicates）
health_records:    {"records": 130715}          ← 高于 09-21 文档记录的 114,162，数据在持续导入
```

⇒ **上轮 P0 的「本地实证 ≠ 线上实证」缺口，本轮关闭。**

---

## 四、增量核心：e2e4110 iOS 后台同步修复（读码验收）

上轮 `AUDIT_VERIFICATION_2026-09-24.md` 核验成立的三条缺陷（P1 冷启动恢复、P1 轨迹状态跨 scope、P2 意图早删）+ 其后 `LEGACY_ITEMS_VERIFICATION_2026-09-24.md` 复核的 4 项中间态，本轮对最终态逐处读码：

| 修复面 | 读码结论 | 关键证据 |
|---|---|---|
| **意图「读-不删-确认」** | ✅ 闭环设计正确 | 生产 3 处（`AppDelegate.swift:59` 真实投递 / `HealthKitSync.swift:780` 锁屏 / `:1188` databaseLocked）；观察点**唯一**在导出起点（`:1074`，注释写明为何两条恢复分支没资格背书通知）；确认仅在两个耐久检查点（`saveTask :1872` / `markSuccess :1300`，均经 `persistThenAcknowledge`——**写失败绝不确认**）；代次比对（`shouldAcknowledgeIntent`）保证导出期间新到的通知不被吞；观察槽在 `defer` 清空（`:753`）覆盖所有出口 |
| **冷启动身份恢复** | ✅ | `restoreBackgroundContext`（`:2006`）从 `rai.handshake.<urlScope>` 缓存恢复 `(activeServerURL, activeIdentity, activeScope)` 三名；`performBackgroundPass:597` 入口即调用；`taskMatches`（`HealthSyncBackgroundRecovery.swift:138-148`）逐项比对 serverId/athleteId/datasetEpoch/protocolVersion，旧任务允许空字段但**不得携带不同身份** ⇒ epoch 变化不串批 |
| **决策改按目标快照** | ✅ | `runBackgroundPass` 返回 `probePendingWork` 现读快照（`:579`，单飞被拒也按本目标重读）；`AppDelegate.swift:195-209` 重排与 `setTaskCompleted` 全用返回值，快照 `nil` 保守报**失败**；门禁钉死 `"healthSync.hasPendingTask" not in app_delegate`（`check-background-capabilities.py:687`） |
| **轨迹状态 scope 隔离** | ✅ | `sync_route_state` 改 `(scope, workout_uuid)` 复合主键（`SyncTaskStore.swift:179-189`）；迁移 `migrateRouteStateSchema`（`:131-175`）：`PRAGMA user_version` 幂等标记 + `BEGIN IMMEDIATE` 事务 + defer ROLLBACK + 旧行**安全丢弃**（不 INSERT SELECT——无可信 scope，宁触发一次全量轨迹重查）；`hasRouteTable && hasScopeColumn` 双探测兼容「未来降级再升级」形态 |
| **迁移失败原地重开** | ✅ | `reopenIfUnavailable()`（`:119-123`）在每个被接受的单飞入口前调用（`prepareJournalForExecution`）；重开安全的三条理由写在 `:110-115`（已 ROLLBACK / user_version 幂等 / 不删文件） |
| **读失败 ≠ 空队列** | ✅ | `hasTask`/`hasAnyTask` 三态（`true/false/nil`），`pendingWorkVerdict`（`HealthSyncBackgroundRecovery.swift:101-112`）把「读不出」归 `.unknown`，`unknown` 在 `hasUnfinishedWork` 里按「有」处理——保守方向是多排一轮，不是报成功 |

**残留（已知、已定级、本轮不改）**：
1. `handleEnterBackground` 未接恢复 ⇒ 展示标志在「从未恢复 + 立刻切后台」窄窗口可能偏低——`LEGACY_ITEMS_VERIFICATION` 已定级为不值得修（UI 不可见时刻的展示精度），本轮读码认同该判定。
2. **真机验收仍未做**：1 秒看门狗 × `backgroundTimeRemaining` 的两种相反失败模式（过激自杀 / 恒不触发）**靠读码无法判定**，判死判据 = `performSync` 入口打一行两个读数（见上轮核验报告 §四）。**这是当前 iOS 侧最高优先级的未验收项。**
3. 全量 77 条突变未重跑（本轮另做了 N-2 侧 TS 突变；iOS 突变维持上轮裁剪版结论）。

---

## 五、本轮新发现（分级）

### 🟡 M-1　Keychain 写失败被静默吞掉——token 保存失败无任何反馈

`apps/ios/RAI/Keychain.swift:45,53`：

```swift
SecItemDelete(query as CFDictionary)   // ← 返回值未用（这条是有意的：delete-then-add upsert，不存在=预期）
...
SecItemAdd(add as CFDictionary, nil)   // ← 返回值未用（这条不是有意的）
```

- `SecItemDelete` 忽略返回值合理（`errSecItemNotFound` 是预期路径）；
- 但 `SecItemAdd` 的 `OSStatus` 被丢弃 ⇒ 钥匙串写入失败（钥匙串满、设备恢复中、托管配置）时 `saveToken` 对调用方表现为**成功**。用户下一次打开 App 被要求重新输入 token，且**没有任何日志或提示能解释为什么**。
- 影响面：低频高困惑。数据不丢（fail-closed：没存上就是没存上），无安全后果，但这是本仓「失败态被映射到宽松分支」模式在 iOS 侧的现存样本（此前修掉的 `HKAuthorizationRequestStatus.unknown` 同族）。
- **修法（一行级）**：`saveToken` 返回 `Bool`（或 `OSStatus`），`SecItemAdd` 失败时 `NSLog` + 向调用方返回 false，SettingsPage 提示「token 未能保存到钥匙串」。**验收**：模拟 `errSecSecItemMissingValidAttr` 场景（或单测桩）⇒ 返回 false 且日志可见。**回滚**：单文件 revert。

### 🔡 M-2　`HealthSyncScopeRecoveryStore.record` 用 `try!` 编码

`HealthSyncBackgroundRecovery.swift:253`：`userDefaults.set(try! JSONEncoder().encode(request), …)`。对纯 `String` 字段的 struct 编码实践上不会抛，`try!` 可接受；但同文件 `observe`/`acknowledge` 侧全部用 `try?` 做了优雅降级，**同一存储器的写路径是硬崩路径**。风格不一致 + 若未来给 `Request` 加非 String 字段（Date 等）会变成真崩溃点。**修法**：写路径改 `if let data = try? …`，失败时 NSLog 并跳过（恢复请求丢失的代价 = 下一轮多一次全量，方向安全）。

### 🔡 M-3　上轮 N-4 维持：墓碑目录 16 个未回收

见 §三。量级 ~64KB，形态与 `.replaced.` 同族。**升级条件**（沿用上轮）：数量开始持续增长即并入 `ABANDONED_DATABASE_FILE_PATTERN`（需 `lstat` 判目录，模式加 `\.import\.lock\.stale\.[0-9a-f]{16}$`）。

### 🟢 绿区补充（Web 侧抽样——上轮零深审，本轮补）

| 项 | 结论 | 证据 |
|---|---|---|
| XSS 注入面 | 零命中 | 全 `apps/web/src` 无 `dangerouslySetInnerHTML` / `innerHTML` / `eval(`（React 默认转义生效） |
| token 传输 | 两条路径都覆盖 | fetch 封装 `api.ts:38-42` `applyApiToken`；原生 XHR 上传 `DataModelPage.tsx:145-146` 手动 `setRequestHeader`——**没有漏掉 XHR 这条常见缺口** |
| token 存储 | localStorage（既有取舍） | `api.ts:11` `rai.web.apiToken`；XSS 面为零 ⇒ 可接受；iOS 壳场景不依赖它（`:13-19` 注释写明 WKWebView 包装器在传输层补 Authorization） |
| 导入并发互斥 | 有守卫 | `DataModelPage.tsx:387` "另一个导入任务正在运行，本次提交未被接管" |
| 错误处理模式 | 完整 | catch + setError + finally 贯穿；唯一 console.error 在 ErrorBoundary（合理） |
| console 泄漏 | 无 | 全 src 仅 ErrorBoundary 一处 console 调用 |

---

## 六、行动建议（按可逆性排序，附验收与回滚）

| 序 | 项 | 改动 | 验收标准 | 回滚 |
|---|---|---|---|---|
| 1 | **真机看门狗判死**（§四残留 2，最高优先） | `performSync` 入口临时加一行日志：`backgroundTimeRemaining` 与 `backgroundTask != .invalid` 两个读数 | 一次真机后台运行 ⇒ 读数落在哪一侧直接判定模式 ①/②；若模式 ①（<5 且 valid）⇒ 看门狗在自杀，需重估 margin；若 `.invalid` ⇒ 看门狗恒不触发，本次修复的 OOM 兜底不存在 | 删日志行 |
| 2 | **M-1 Keychain 返回值** | `saveToken` 返回结果 + 失败 NSLog + UI 提示 | 模拟钥匙串失败 ⇒ 调用方拿到 false 且日志可见；正常路径行为不变 | 单文件 revert |
| 3 | **M-2 record 去 try!** | 写路径 `try?` + 失败 NSLog 跳过 | `HealthSyncBackgroundRecoveryRegression` 仍绿；人为构造编码失败不崩 | 单文件 revert |
| 4 | **N-5 CI 拍板**（需你决策） | 三选一：搬 gitee 流水线 / 自建 runner / 在 `ci.yml` 头部注明「无执行者，判据仅供参考」 | 若搬：任一次 push 能看到 822 项 node 测试的 CI 侧报告 | 删/改 workflow 文件 |
| 5 | **N-6 纳入监控** | 把「备份窗口小时数」加入 `/v1/diagnostics` 或部署巡检（`ls` 14 份的最新−最旧时间差） | 巡检输出当前窗口值；窗口 < 2h 告警 | 纯新增，revert 即可 |
| 6 | **M-3/N-4 观察** | 不动；下次审计复核墓碑数量 | 数量 > 30 或持续增长才动手 | — |

---

## 七、对辅助结论的反向复核（纠正了谁、纠了什么）

1. **确认上轮自我修订的修订本身成立**。上轮报告头部有 2026-09-24 的修订记录（5 处订正，含「仓库卫生回退」措辞撤回）。本轮实测：`.gitignore` 全历史确无图片规则的说法与闸门现状（pre-commit:12）一致——**那次修订经得起复测**。
2. **把上轮 P0 线上侧从「二手」升级为「一手」**。上轮 §3.1 明确声明「未亲验线上库，是推断的复用」；本轮云机只读实测 v22/22 + 130,715 行，**该声明可以关闭了**。
3. **确认 `LEGACY_ITEMS_VERIFICATION` 的「3 修 1 部分闭合」判定**。本轮独立读码（意图交接链、快照决策、复合主键迁移、reopenIfUnavailable），未发现该报告结论有反向错误；其「门禁全绿仍漏第 1 项」的归因（形状断言不覆盖 `activeServerURL == nil` 退化）与我在 §四的读码一致。
4. **方法自纠**：本轮一次 Bash grep 又踩了 BSD `grep "a\|b"` 静默空坑（搜 `FROZEN_IDENTITY_ALGORITHM\|identityAlgorithmFingerprint` 返回空，实际文件里两处都在）——**该坑在「我知道规则」的情况下仍复发**，佐证记忆里的判断：查符号一律走 Grep 工具，非要在 shell 里就写 `grep -E`，这不是知识问题是习惯问题。

---

## 八、未覆盖范围（如实声明）

- **真机行为**：iOS 全部结论仍是「编译级 + 纯逻辑级 + 结构判据级（252 条）+ TS 侧突变级」。锁屏时序、BGTask 下 `backgroundTimeRemaining` 真实读数、新 scope 的 GPX 端到端交付、真机冷启动续传，**均未验证**——§六第 1 项是为此开的最小判死动作。
- **模拟器视觉回归未跑**（`run-visual-tests.sh` 需 booted Simulator + `var/rai.sqlite`）；`xcodebuild` 编译本轮未单独跑（门禁已含 55 文件 typecheck + 全部纯逻辑回归）。
- **iOS 全量 77 条突变未重跑**：本轮只做了 TS 侧 N-2 的定点突变（到红）。iOS 侧突变维持上轮「裁剪版已跑、全量未跑」的记录。
- **Rust 引擎**：本轮只跑了 `rust:verify` 门禁（cargo test 2 + node 集成 11）；**未做**真数据性能实测、B1–B5 在线上数据分布下的命中率统计（`GET /v1/data-summary` 的 issues 面本轮未采样）。
- **Web 侧是抽样深审**（api.ts 全文 + DataModelPage 关键路径 + 全局 XSS/console/token 扫描），非 46 个 tsx 逐行；冻结区（<1024px）按 AGENTS.md 未触碰。
- **性能维度**：无针对性性能实测（无性能投诉输入）；埋点（stagesMs）与冷热探针既有结论沿用 `NOTES-engineering.md`。
- 审查未修改任何业务代码；探针在 `/tmp`（云机侧脚本跑完即删）；`var/` 内文件 mtime 未被触碰；worktree 已 `remove --force` + `prune`。

---

## 附：本轮探针与突变清单（可复现）

```
本地：
  分批 node:test（--test-concurrency=1 × 4 批）      822/818/0/4，逐批 EXIT=0
  vitest --maxWorkers=1（两段）                      13 文件 86/86
  npm run test:e2e:web（npm 口径）                    11/10/0/1 skip
  npm run rust:verify                                 cargo 2/2 + node 11/11，0 warning
  /tmp/rai-mut24（git worktree @ HEAD）              N-2 突变：stableId 插入 hash.update("MUTATION")
                                                      ⇒ identity-algorithm.test.ts 2 条具名 not ok（基线 6/6 绿）
云机（lhins-3gatdqed，ap-guangzhou，全部只读）：
  ls -lt /var/lib/rai/var/backups                    14 份 / 506MB each / 窗口 18:00→23:52 = 5h52m
  node:sqlite readOnly（base64 通道，跑完 rm）        schema_migrations {v:22,n:22}；health_records 130,715
```

*报告时点：2026-09-25 00:1x（Asia/Shanghai）｜基线 `49c9ef9`，工作树干净*
*审查过程未修改任何业务代码、未触碰用户数据；云机侧只读、脚本即用即删；突变在可丢弃 worktree 内完成，已清理并 `git worktree prune`。*
