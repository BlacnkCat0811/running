# RAI 项目健康审查报告 · 2026-09-10

> 审查基线：本地 `main` = `origin/main` = `18067cb`（工作树干净，0 未提交）。
> 运行环境：macOS (darwin)，Node 22.x（与上轮审计的 Windows 副本不同机）。
> 对比范围：上轮审计 `PROJECT_HEALTH_AUDIT_2026-09-09`（基线 `ff21730`）之后 **7 commits**，主体为 iOS「technology」皮肤与同步生命周期。
> 方法：质量门禁实跑 + 逐行核对增量 diff + 对**上轮结论做反向复核**（不以文档复述为准）。结论均附 `文件:行号` 证据。

---

## 1. 总体结论（先行）

**健康度评级：B（良好，无 P0；新增 2 项 P1 + 沿用 2 项 P1）**

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 质量门禁 | 🟡 黄 | typecheck/build 绿；`npm test` 有 **1 项并行竞态 flaky**（串行全绿）；web vitest 本机 worker 超时属环境限制 |
| 冻结区合规 | 🟢 绿 | 本次增量对 `App.tsx` / `styles.css` / 390px E2E **零改动** |
| 移动端教练语义 | 🟡 黄 | `verdict.stale` 被硬编码 `false`，服务端陈旧守卫失效 + 2 个字段变死代码 |
| iOS 后台取数 | 🔴 债务 | 新增 `BGProcessingTask` 后台健康同步，但 **未声明 `UIBackgroundModes`**，功能实际不生效；且触碰 `AGENTS.md` 边界 |
| 文档-代码一致 | 🟡 黄 | `rai-model-config` code=v4，README/DATABASE_DESIGN 仍写 v3（**连续两轮未修**） |
| 安全 | 🟡 黄 | Keychain 读取失败仍回退 `UserDefaults` 明文 token（**连续两轮未修**） |
| 仓库/数据卫生 | 🟡 黄 | 本次提交 48MB 设计资源进 Git；本机 `var/` 3.4G（较上轮 Windows 副本 23G 已大幅改善） |
| 上轮结论可信度 | 🟡 黄 | 上轮 **P1-4 经复核为误报**（详见 §5） |

---

## 2. 质量门禁实跑（本次实测）

| 门禁 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | ✅ 通过 | pure + 全量双 tsconfig，1m27s |
| `npm run build` | ✅ 通过 | `apps/web/dist` 重新生成（e2e 阶段成功进入用例阶段即证构建通过） |
| `npm test`（node 层） | ⚠️ 452 项 / 447 pass / **1 fail** / 4 skip | 失败项 `#125`，见下 |
| `npm run test -w @rai/web` | ⚠️ 环境受限 | 4/9 文件、11 用例通过；5 个 vitest forks worker 启动超时（本机资源） |
| `npm run test:e2e:web` | ⛔ 环境阻塞 | 本机无 Chrome/Edge；`web-flows.test.ts:469` 断言失败，**非代码缺陷** |

**唯一失败项定位**：`not ok 125 - runtime status includes persisted prediction work and restore recovers recompute jobs`（`apps/api/test/server-runtime.test.ts:211`）。
单独串行运行 → **10/10 全绿**。该用例 spawn 子进程服务器并使用随机端口（`20000 + random*10000`，line 246），在全仓并行 CPU 争用下就绪轮询超时。
→ **结论：并行竞态 flaky，非真实回归。** 但 `npm test` 是 CI 门禁（`.github/workflows/ci.yml` 的 `verify` job），**main 会间歇性红灯**。

---

## 3. 分级问题清单

### 🔴 P0 —— 无

### 🟡 P1（建议近期处理）

| # | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| P1-1 | **`verdict.stale` 语义坍塌**：`decideVerdict` 硬编码返回 `stale: false`，陈旧判定被整体移除 | `apps/api/src/mobile-coach.ts:292`；`mobile-coach.ts:69-70` 声明、`mobile-read.ts:134/156-157` 赋值但**无人读取**；`server.ts:732` 的 `mobile_recommendation_stale` 409 守卫**不可达**；iOS `TechLockSheet.swift:32/42`、`TechViews.swift:591/915/1449`、`NativeViews.swift:337/994` 的 `verdict.stale` 门禁全部失效 | 服务端"恢复数据非当天则拒绝锁课"的纵深防御消失；契约字段 `MobileVerdict.stale` 变成恒定假值，读它的人会被误导 | 二选一并对齐：① 恢复真实 stale 语义（推荐），或 ② 明确废弃该字段——删契约字段 + 删 `server.ts:732` 死守卫 + 删 `recoveryEvidenceStatus/Date` 死字段，并把"陈旧"统一为单一信号 `freshness.state` |
| P1-2 | **新增后台健康同步为"死功能"**：`BGProcessingTask` 已注册并调度，但未声明后台处理能力 | `apps/ios/RAI/RAIApp.swift:24-42`（register + `scheduleHealthSync`）、`Info.plist:25-28`（仅 `BGTaskSchedulerPermittedIdentifiers`）；**全仓无 `UIBackgroundModes`**（`Info.plist` / `project.pbxproj` / `RAI.entitlements` 均无 `processing`）；`scheduleHealthSync` 用 `try?` 吞掉 submit 失败 | `BGProcessingTaskRequest.submit` 在缺少 `UIBackgroundModes: [processing]` 时会抛错并被静默吞掉 → 后台同步**永不执行**，给人"已有后台同步"的错觉 | 要么补齐 `UIBackgroundModes` 再验证真机行为，要么移除该路径只保留前台同步 |
| P1-3 | **边界扩张未确认**：该后台同步触碰 `AGENTS.md` 冻结边界 | `AGENTS.md`："do not add HealthKit write, **background delivery**, or a standalone Watch/macOS/mobile product unless the user explicitly asks"；`RAIApp.swift` 在每次前台 active 时 `scheduleHealthSync()`（≥15 分钟后执行、需联网、读 HealthKit 并上传） | 若未经用户明确授权，属越界；且把"同步仅前台发生"变为"后台可自行上传健康数据"，改变隐私边界 | 请用户明确确认是否授权后台同步；未授权则回退 |
| P1-4 | **Keychain 明文回退未删**（连续两轮） | `apps/ios/RAI/Keychain.swift:25`：Keychain 读失败时 `return server == nil ? UserDefaults.standard.string(forKey: "rai.apiToken") ?? "" : ""` | token 可能随备份/迁移泄露 | 删除该回退分支（写入路径已 `removeObject`，读回退无必要） |
| P1-5 | **模型配置版本漂移**（连续两轮） | code=`packages/scoring/src/model.ts:16` `"rai-model-config-v4"`；现状文档仍写 v3：`README.md:213`、`docs/DATABASE_DESIGN.md:6` | 读者按 v3 参数假设行事 | 两处改 `v4`；全仓 grep 现状文档不再有 v3 引用（dated 文档除外） |

### 🟢 P2/P3

| # | 问题 | 证据 | 说明 |
|---|---|---|---|
| P2-1 | `npm test` 默认并行不确定 → CI 间歇红 | 失败项 `server-runtime.test.ts:211`；串行 10/10 绿 | 收敛子进程就绪轮询或固定端口池；或在 CI 对 `server-runtime` 单独串行 |
| P2-2 | **双 CI 定义并存** | `.github/workflows/ci.yml`（在用：ios / windows-runtime / verify 三 job）+ `.workflow/master-ci.yml`（Gitee 草案，未接线） | 两份定义易漂移；建议留一份并在另一份加弃用注 |
| P2-3 | 设计资源入 Git 造成仓库体积膨胀 | 本次提交 `apps/ios/design` 累计 **48MB**；单文件 `technology-v1/01-today-body.png` **4.8MB**、`03-plan.png` 4.7MB… 共 6 张大图 + 验收截图 | 视觉基线截图建议走 Git LFS 或移出仓库 |
| P2-4 | `BGTaskScheduler.register` 注册时机 | `apps/ios/RAI/RAIApp.swift:8` `static let shared = AppModel()`；register 在其实例化期间执行 | Apple 建议在 launch 早期（`didFinishLaunching`/`App.init`）注册；`static let` 首次访问时机不确定，晚于 launch 完成则注册失效 |
| P3-1 | 陈旧信号双轨（`verdict.stale` 与 `freshness.state`） | `data.ts:349-354`：`freshness.state = recoveryDate === today ? "valid" : "stale"` 仍有效 | 与 P1-1 同源；建议合并为单信号 |
| P3-2 | 断言/字段命名滞后 | `mobile-coach.ts:292` 返回固定 `stale:false`，但 `apps/api/test/mobile-coach.test.ts:91` 仍以 `recoveryEvidenceStatus:"stale"` 构造输入 | 测试仍在演练已死的输入路径 |
| P3-3 | 断点措辞冲突（文档层） | `AGENTS.md` 冻结边界写 `<1024px`；实际底部导航断点 `styles.css` `max-width:820px` | **本轮已部分处理**：`docs/WEB_IMPLEMENTATION.md:35-36` 新增调和说明（冻结区 `<1024px`、实际断点 820px） |

---

## 4. 分维度详情

### A. 基线 / 仓库（🟢）
- `main` = `origin/main` = `18067cb`，工作树干净；另有历史分支 `execute-plan/cbe06362-…`（behind 26，空实现分支）。
- 本次增量 7 commits：`6a8e0c3`（resilient HealthKit sync lifecycle）、`955e768`、`99ba667`、`7af1edf`（encode iOS API path identifiers safely）、`0f514e0`+`255a7d8`+`18067cb`（technology skin）。
- 136 files changed，+8496 / -111；**绝大多数为 iOS UI 与验收物料**。

### B. 存储层微改（🟢，合理）
- `packages/storage-sqlite/src/read/series-read-repository.ts:114-128`：下采样新增 `peak_rank = ROW_NUMBER() OVER (ORDER BY value_numeric DESC, start_at)` 并 `OR peak_rank = 1` 保留峰值点；采样步长 `(total+599)/600` → `(total+598)/599`。
- 附新单测 `test/series-read-repository.test.ts`（1200 点、峰值 191 必被保留、`points.length ≤ 601`）。改动动机（心率曲线不丢峰值）合理，实现与测试自洽。

### C. 移动端教练（🟡，见 P1-1）
- `mobile-read.ts:121-134` 把恢复事实的锚定日期从"墙钟今天"改为"最近主睡眠的实际 wakeDate"，并以其自身基线比较；`recovery.note` 前缀标注"依据 <date> 的恢复数据"。
- `decideVerdict` 将 `recoveryUnavailable` 分支从高优先级**后移**到接近末尾，并删除 `stale` 分支与 reason 追加。
- 判断：**方向可辩护**（导入常滞后于墙钟，按证据自身日期比较更诚实），但落地方式造成 P1-1 的连锁破坏——陈旧概念没有转移，而是被删除。

### D. iOS 原生（🟡）
- ✅ 本次为**纯 UI 层**：新增 `Skins/Technology/*`（`TechViews.swift` 2235 行、`TechTheme.swift` 549 行等）+ 皮肤切换（`RAIApp.swift` `@AppStorage(AppSkin.storageKey)`）。Swift 侧**无任何** CA/TA/恢复/负荷评分重算，符合 `AGENTS.md`。
- ✅ `escapedPath` 加固（`APIClient.swift:243-248`）：改用 `alphanumerics + "-._~"` 白名单，避免 `.urlPathAllowed` 含 `/` 导致路径穿越；`ServerSession.canonicalURL`（`ServerSession.swift:76-88`）统一 Keychain/缓存 scoping，并修正 Simulator 误拒 localhost（`ServerSession.swift:125`）。均为正向加固。
- ✅ 同步可取消化：`HealthKitSync.cancelSync()`、`Task.checkCancellation()` 插桩、`isIdleTimerDisabled` 状态保存/还原。
- 🟡 P1-2 / P1-3 后台任务；P2-4 注册时机。

### E. Web / 冻结区（🟢）
- `git diff --name-only ff21730..HEAD -- apps/web/src/App.tsx apps/web/src/styles.css apps/web/e2e/web-flows.test.ts` → **空**，冻结区零改动。
- `docs/WEB_IMPLEMENTATION.md` 仅加 1 行断点调和说明（P3-3 部分解决）。

### F. CI（🟡→🟢 改善）
- `.github/workflows/ci.yml` 在 `ff21730` 已存在；本轮 **+15 行新增 `ios` job**（macos-14：`xcodebuild` 构建模拟器 + `run-model-tests.sh`）→ **上轮 P1-5（ModelRegression 未入 CI）已解决**。
- 残留：`.workflow/master-ci.yml` Gitee 草案并存（P2-2）；`verify` job 跑 `npm test` 会受 P2-1 flaky 影响。

### G. 安全（🟡）
- 本机 `var/`、`*.sqlite*` 均在 `.gitignore` 内；未发现新增 secret 提交。
- P1-4（token 明文回退）仍开放。

---

## 5. 对上一轮审计的反向复核（重要）

**上轮 P1-4「iOS 增量同步缺重叠窗口谓词（协议漂移）」经复核为 ❌ 误报。**

- 上轮断言：增量路径仅在 `anchor == nil` 时叠加时间谓词，忽略 48h lowerBound，导致编辑过的旧训练漏同步。
- 实际代码：`apps/ios/RAI/HealthKitExport.swift:235-249` —— 增量（`stored != nil`）时**额外查询** `[lowerBound - 14天, now]` 窗口内的跑步并 `merged` 合并（line 246-248），这些 workout 会被完整重导出（含路线）。
- 文档一致：`docs/IOS_NATIVE_SYNC_PROTOCOL.md:29` 承诺的正是"每次 anchored 增量同步还会**回读最近 14 天的跑步**"——**代码与文档相符**。
- 误报根因：上轮把用于**非 workout 记录**的 `48h lowerBound` 误当作 workout 重叠窗口，未读到 line 235-249 的 recent-window 分支。
- 残留真实边界（远小于上轮描述）：仅"开始时间早于 14 天前、但近期被编辑"的 workout 可能漏到下次全量。

> 该复核结果印证：上轮报告存在读码遗漏，需与本次结论交叉使用，不宜单独作为行动依据。

---

## 6. 数据卫生（本机实测，较上轮大幅改善）

| 路径 | 占用 | 说明 |
|---|---|---|
| `var/backups/*.sqlite` | 1.8 GiB / 7 份 | 含 before-web-import×5、before-v17、before-dedup-recompute |
| `var/rai.importing.*.replaced.*` | ~1.3 GiB / 5 份 | displaced 旧库，仍无回收机制 |
| `var/rai.sqlite`(+wal/shm) | ~1.9 GiB | 主库 |
| `var/backups/*.sqlite-journal` | **0 个** | 上轮 Windows 副本的 36 个碎片在本机不存在 |
| **`var/` 合计** | **3.4 GiB** | 上轮 Windows 副本为 ~23 GiB |

- 本机无"23 GiB 膨胀"问题；仅 `replaced.*` 的 GC 机制仍缺（P2/P3）。
- `var/` 不入 Git，不影响仓库。

---

## 7. 行动建议（附验收标准）

1. **（P1-1）** 决定 `stale` 去留并一次对齐：恢复语义 **或** 删契约字段 + `server.ts:732` 死守卫 + `recoveryEvidenceStatus/Date` 死字段。验收：全仓 grep 无"读 `verdict.stale` 却恒为 false"的分支；`mobile_recommendation_stale` 守卫可达（或彻底删除）。
2. **（P1-2/3）** 后台同步二选一：补 `UIBackgroundModes: [processing]` 并真机验证 **或** 移除。无论哪种，**先向用户确认是否授权后台取数**。验收：真机 install 后 `BGTaskScheduler.submit` 无 error；或仓库无后台同步代码。
3. **（P1-4）** 删 `Keychain.swift:25` 回退。验收：`rai.apiToken` 读路径全仓唯一（仅 Keychain）。
4. **（P1-5）** `README.md:213`、`docs/DATABASE_DESIGN.md:6` 改 `rai-model-config-v4`。验收：现状文档无 v3 引用。
5. **（P2-1）** 消除 `server-runtime` 并行 flaky。验收：`npm test` 连续 5 次全绿。
6. **（P2-3）** 大图走 LFS 或移出仓库。验收：单提交二进制 ≤ 1MB。

---

## 8. 已核实绿区（对照既往关切）

- iOS Swift 侧未重写 TS 评分核心；HealthKit 纯只读（`toShare: []`）✅
- 冻结响应式区（`App.tsx` / `styles.css` / 390px E2E）本次零改动 ✅
- `typecheck` / `build` 通过；node 层测试除 1 项 flaky 外全绿 ✅
- 存储层改动有配套单测，且不改变既有读契约 ✅

---

*本报告为 2026-09-10 时点快照；审查过程未修改任何业务代码与用户数据。*
*环境限制：本机无 Chrome/Edge，`test:e2e:web` 未获有效结论；web vitest 因本机 forks worker 超时仅部分完成——建议在用户环境或 CI 复跑。*
