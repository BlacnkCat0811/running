# RAI 项目完整审查报告 · 2026-09-26

> **审查对象**：`/Users/ta/running` 全仓（`packages/` + `apps/api/` + `apps/ios/` + `apps/web/` + `crates/` + `deploy/` + 脚本与钩子）。
> **基线**：`main` = **`49c9ef9`**，但**工作树不干净** —— 37 个已跟踪改动文件 + 17 个未跟踪文件（`git diff --stat` = **1487 insertions / 729 deletions**）。这与上轮（干净树）是**结构性差异**，本轮所有门禁都是在"待提交的功能改动树"上跑的。
> **对比的上轮**：`deliverables/PROJECT_AUDIT_2026-09-24.md`（基线同为 `49c9ef9`、干净树）；另核验 `IOS_MODEL_AUDIT_2026-09-25.md`、`UNCOMMITTED_REVIEW_2026-09-25.md`、`IOS_PLAN_RACE_REVIEW_2026-09-25.md` 三份专项报告。
> **方法**：门禁**八条全量前台实跑** → 未提交改动逐面读码 → 缺陷**实跑复现**（探针编译失败）→ 旧修法**在 `/tmp` 副本上迭代证伪/证实**。**未修改任何业务代码、未触碰用户数据**；探针实验全部在 `/tmp` 可丢弃副本内完成，跑完即删；工作区状态项数与开工时逐项一致（54 = 37 + 17）。

---

## 一、总结论（先行）

**健康度：A-**。八条门禁**全部本次实跑通过**；09-25 提出的 1 个 🔴 + 3 个必修项**全部真修且经我独立复测**。但本轮新发现 **1 条 🔴**：**iOS 的真执行门禁（跨进程字节确定性探针）已因一次源码演进静默失效，并使整条模拟器视觉验收链第一步即退出** —— 而自动门禁因为只跑"结构版"脚本，对此**完全无感**。

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 质量门禁 | 🟢 绿 | **8/8 本次实跑 EXIT=0**；node 836/833/0/3skip、vitest 13/86、E2E 11/10/0/1、Rust cargo 2/2 + node 11/11 |
| 上轮遗留闭环 | 🟢 绿 | 09-25 的 🔴M-01 与三个必修项（Node gate / RHR provenance / race policy）**全部真修**；09-24 的 M-1/N-4/N-5 维持原判 |
| iOS 门禁真伪 | 🔴 红 | `check-export-determinism-live.py` **编译失败**（预存在）⇒ `run-visual-tests.sh` 整链不可用；自动门禁**结构性看不见**（只跑结构版） |
| 契约演进安全 | 🟢 绿 | 服务端新增枚举值/`null` 语义，iOS 侧全部改为 optional 或字符串容器，**无解码断裂** |
| 数据层/迁移 | 🟢 绿 | `packages/storage-sqlite/src/database.ts` **未改动**（迁移冻结无风险）；M-01 三占位符三绑定 |
| API 鉴权/路由 | 🟢 绿 | 新写端点 `/v1/mobile/workout-plan/preview`、`/confirm` 已登记 `metadataOnlyMutationRoutes`（`server.ts:275-289`），schema + OpenAPI 同步 |
| 仓库与密钥卫生 | 🟢 绿 | 对象账 **3659 == 3659（差额 0）**、`.git` 32MB、`HEAD` 最大文件 1.43MB（闸门 1.5MB）、凭据扫描零命中 |
| 依赖分层 | 🟢 绿 | 底层包无向上引用（唯一命中是 `contracts/src/timezone.ts:12` 的注释文本，非 import） |
| Web 安全面 | 🟢 绿 | `dangerouslySetInnerHTML` / `innerHTML` / `eval(` 全 `apps/web/src` **零命中**；冻结区（<1024px）本轮未被触碰 |
| 测试可信度 | 🟡 黄 | 3 个 skip **全部**是 Windows-only（无覆盖丢失）；但 live 探针失效 ⇒ "跨进程字节确定性"这一族判据**实际零覆盖** |
| 增量功能覆盖 | 🟡 黄 | 新 UI 入口 `TechPlanPreviewSheet` 无回归断言；`data:prediction-walk-forward` 有 Node gate 但无测试 |

**一句话**：这一轮真正的价值是把 09-25 发现的模型层缺陷（🔴 VDOT 证据恒空）关掉了，而且是**真关**——我在真实库上看到它从 `count:0` 变成 `count:11`。但同一轮里暴露了一个更隐蔽的问题：**一个曾经被验证通过、写在 `IOS_NATIVE_RUNBOOK` 里的验收入口，已经在 3 天前被一次正常的源码演进静默废掉**。它不发出任何信号，因为自动门禁跑的是同名的**结构版**（只读源码形状），而真执行版从来没进过自动链路。

---

## 二、质量门禁实跑（全部本次实测，非引用）

| 门禁 | 结果 | 证据 / 耗时 |
|---|---|---|
| `npm run typecheck` | ✅ EXIT=0 | 双 tsconfig，无诊断输出；55s |
| node:test 全量 | ✅ **836 项 / 833 pass / 0 fail / 3 skip** | 单批直跑，**187s**，`# fail 0` |
| `npx vitest run --root apps/web` | ✅ **13 文件 / 86 tests / 0 fail** | 62s，单批跑完无 SIGKILL |
| `npm run test:ios` | ✅ EXIT=0 | **5m35s**；Background capability **252 checks / 0 failed**、store **62**、tech presentation **52**、对比度 24 组 ≥4.5:1、export determinism **14**、字段覆盖 **23/27**（4 个为设计内元数据） |
| `npm run test:e2e:web` | ✅ **11 tests / 10 pass / 0 fail / 1 skip** | **129s（含 `npm run build`）**；390px 冻结用例按 `npm_lifecycle_event` 互斥 skip，正常形态 |
| `node apps/web/scripts/check-bundle.mjs` | ✅ EXIT=0（绿时静默） | dist 为本轮 E2E 同轮产物 |
| `npm run rust:verify` | ✅ EXIT=0 | `Finished \`release\` profile` + `test result: ok. 2 passed; 0 failed` + node 侧 **11/11**（含 B1–B4 写路径不变量） |
| `npm run smoke:api` | ✅ EXIT=0 | `Production API runtime smoke test passed` |

**3 个 skip 的归属（逐一核对，非统计推断）**：`maintenance.test.ts:1150`（win32）、`import-sources.test.ts:482`（Windows 路径别名语义）、`worker.test.ts:147`（Windows 进程树语义）⇒ **全部是平台条件跳过，无覆盖丢失**。
同时确认：`native-import-worker.test.ts:13,110`（`skip: !available`）**本次未跳过** ⇒ Rust 原生解码器在门禁中**真的执行了**；`publication lock rejects PID reuse` 这条（历史上在 macOS 会 EPERM fail-safe 跳过）**本次实跑通过**，故 skip 数为 3 而非 4 —— 与记忆中"3 skip 不是稳定基线"一致，**不是覆盖变化**。

---

## 三、分级问题清单

### 🔴 S-1　iOS 真执行门禁已静默失效，并使整条模拟器视觉验收链第一步即退出

**复现（本轮实跑，非读码推断）**

```text
$ python3 apps/ios/tests/check-export-determinism-live.py
probe.swift:340: error: cannot find 'RouteSyncStateMachine' in scope
probe.swift:988: error: cannot find 'RouteObservation' in scope
探针编译失败（见上）
EXIT=1
```

**根因**：`check-export-determinism-live.py:165-176` 的 `swiftc` 调用把**源清单硬编码**为两个文件 —— `StoredZip.swift` 与拼接出来的 `probe.swift`（= `HealthKitExport.swift` 去掉 `#if os(iOS)` 外壳 + 探针附录）。而 `HealthKitExport.swift:340,938,989` 现在引用了 `RouteSyncStateMachine` 与 `RouteObservation`（定义在 `RouteSyncStateMachine.swift:9`），**清单没有跟着长**。

**影响面（比"一个脚本坏了"严重）**：
1. `run-visual-tests.sh:21` 在 `set -euo pipefail` 下**第一步**就调用它，且注释明确写着它"挂在构建之前、必须放在数据库备份之前"⇒ **整条脚本退出**：模拟器视觉验收、截图产出、跨进程字节比对**同时归零**。
2. `package.json:37` 的 `test:ios:live` 同样失败。
3. **自动门禁完全无感**：`npm run test:ios` = `run-ios-gates.sh` = `typecheck-ios.sh` + `run-model-tests.sh`，后者调用的是**结构版** `check-export-determinism.py`（只读源码形状，打印 `Export determinism checks: 14 checks`）。**同名两版，自动链路只跑不执行代码的那一版。**

**是预存在，不是本轮改动引入**（判据：参与者文件全部干净）

```text
$ git status --short apps/ios/RAI/HealthKitExport.swift apps/ios/RAI/RouteSyncStateMachine.swift \
    apps/ios/RAI/StoredZip.swift apps/ios/tests/check-export-determinism-live.py apps/ios/tests/run-visual-tests.sh
(空)
```
引入者 **`7ca2027`（2026-09-23）**「后台同步阻塞态、单事务提交与 workout 伴生 route 状态机」：同批新增 `RouteSyncStateMachine.swift`（+159）并给 `HealthKitExport.swift` 增加对它的引用（+151），**但该提交的改动清单里没有探针文件**。

**正确修法（本轮已在 `/tmp` 副本实测验证，推翻了 09-26 记录的修法）**

⚠️ **只补 `RouteSyncStateMachine.swift` 是不够的** —— 实测立刻爆出第二层错误，因为它又依赖 `RouteSyncState.swift` 里的状态枚举：

```text
RouteSyncStateMachine.swift:152:49: error: cannot infer contextual base in reference to member 'settled'
RouteSyncStateMachine.swift:155:28: error: cannot infer contextual base in reference to member 'settled'
```

**必须同时补两个文件**（在副本里改 `swiftc` 源清单后实跑）：

```text
$ python3 check-export-determinism-live.py       # 已补 RouteSyncState.swift + RouteSyncStateMachine.swift
Export determinism (live): 7 checks, 0 failed
  ok   shipped: <MetadataEntry> 按键升序输出
  ok   shipped: HKIndoorWorkout 被跳过（与修复前一致）
  ok   shipped: HKMetadataKeySyncIdentifier 被跳过（与修复前一致）
  ok   shipped: 输出条目数为 4（跳过 2 个保留键后）
  ok   shipped: 同进程内两次调用字节一致
  ok   shipped: 三次独立启动的 <MetadataEntry> 字节完全一致
  ok   self-check: 去掉 .sorted() 后跨进程顺序确实会变（证明本门禁不是空转）
EXIT=0
```
⇒ 修好后门禁**依然有效且自证非空转**（最后一条是"把 `.sorted()` 删掉必须变红"的对照）。

**验收标准**：`python3 apps/ios/tests/check-export-determinism-live.py` ⇒ EXIT=0 且 7 checks / 0 failed；`bash apps/ios/tests/run-visual-tests.sh` 能越过第 21 行进入构建阶段。
**回滚**：单文件（`check-export-determinism-live.py`）revert。
**建议加固（防同类复发）**：源清单改为**按依赖闭包推导或加哨兵断言** —— 例如在探针里断言"`HealthKitExport` 引用的每个仓库内类型都出现在 `swiftc` 输入里"，或干脆把 `apps/ios/RAI/*.swift` 全量交给 `swiftc` 后靠 `-parse-as-library` 过滤。硬编码清单必然随源码演进再次失配。

### 🟡 S-2　新 UI 入口 `TechPlanPreviewSheet` 没有任何回归断言

`apps/ios/RAI/Skins/Technology/TechPlanPreviewSheet.swift:4`（本轮新增，未跟踪）在全仓的引用只有定义点与 `TechPlanView.swift:93` 的调用点，**`apps/ios/tests/` 下零引用**（Grep 双次复核，`PreviewSheet` 仅两处命中）。
而 `run-tech-presentation-tests.sh:122` 的字段锚点清单是本轮**刚更新过**的（`+= TechPlanView.swift`、`recentPlanExecution` 锚点改为 `native.today?.recentPlanExecution`）⇒ 说明作者知道要同步门禁，但**漏了这张新 sheet**。
对照当日纪律（"验收过的 UI 行为必须进回归断言"）：未来七日预览是**本轮新增的可见入口**，其"预览不隐式确认""replacement 提示文案""过期候选提示"都只靠读码成立。
**验收**：`run-tech-presentation-tests.sh` 增加一条具名断言（例如断言 sheet 内不出现 `confirm` 调用、`previousDays` 与非空 `replacedDates` 有展示分支）；在干净 worktree 里做 1 条定点突变（删掉替换提示分支）⇒ 该断言必须变红。
**回滚**：纯测试改动，revert 即可。

### 🟡 S-3　视觉验收夹具与 `validateManualPlan` 的"历史日期冻结"语义冲突（夹具过时，服务端行为正确）

`apps/api/src/manual-plan-policy.ts:9-14` 的 `frozen()` 判定：`date < today.today.localDate || (date === today && (workoutCount>0 || lock.present))`，随后逐字比较 `previous.weekPlan` 与 `goals.weekPlan` 的冻结子集，不等即抛 `ManualPlanPolicyError`。
而 `run-visual-tests.sh` 的夹具把 `/v1/mobile/today` 返回的**整周 7 天原样回填** goals，其中含已过去日期，且 `previous.weekPlan` 为空 ⇒ `oldDays=[] ≠ newDays=[5 天]` ⇒ 必然 422。
09-26 已实测三档对照：整周回填 → **422 `plan_policy_violation`**；只提交 `localDate >= today` → **200**；复用过期 revision → **409**（revision 机制正常）⇒ **服务端拒绝改写过去日期是对的，问题在夹具**。
**本轮我未复跑该场景**（需起验收服务 + 库副本），定性依据是读码（`manual-plan-policy.ts:9-14`）+ 09-26 实测记录。
**验收**：夹具加 `if d["localDate"] >= t["today"]["localDate"]` 过滤后，脚本能走完截图流程。
**回滚**：夹具为脚本内嵌内容，revert 脚本即可。

### 🟡 S-4　`data:prediction-walk-forward` 只有 Node 生命周期门禁，没有任何测试

`package.json:67-68` 已补齐 `predata:prediction-walk-forward`（P1-1 真修 ✅），但 `packages/application/src/prediction-walk-forward-cli.ts` 在 `packages/application/test/` 与 `apps/api/test/` 中**零引用**（列目录 + 文件名 grep 双查）。
它是本轮 ML 评估的取数入口（`IOS_MODEL_WALK_FORWARD_REVIEW_2026-09-25.md` 用它产出 JSON）。无测试意味着：它的参数解析、无样本时的 `insufficient_walk_forward_samples` 分支、输出 JSON 形状都无回归保护。
**验收**：补一个最小用例（空库 ⇒ `labeledOutcomeCount=0` 且 ML candidate 为 `insufficient_walk_forward_samples`，不抛异常、不产出 NaN）。
**回滚**：纯测试新增。

### 🔡 S-5　预览候选池上限 8 且 LRU 驱逐，已生成未确认的候选可能被挤掉

`apps/api/src/weekly-plan-preview.ts:9-11`：`while (this.entries.size >= 8) this.entries.delete(最旧)`；`confirm`（`:15-23`）对找不到的 id 抛"预览已过期"。
单用户场景下要连生成 8 次才会触发，代价是"重新生成一次"，**无数据损坏**。记录在案，不改。
**升级条件**：若未来出现多设备并发预览，需改为按 `(revision, fingerprint)` 查找而非仅 candidateId。

### 🔡 S-6　上轮 🟡 M-1 维持：Keychain 写失败仍被静默吞掉

`apps/ios/RAI/Keychain.swift` 本轮**未被改动**（`git status` 空）⇒ `SecItemAdd` 的 `OSStatus` 仍被丢弃，`saveToken` 对调用方仍表现为成功。判据与影响面同 09-24 报告 §五 M-1，不再重复。

---

## 四、上轮遗留项闭环核验（逐条重测，不复用旧 ✅）

### 4.1　`IOS_MODEL_AUDIT_2026-09-25` 的八条

| 项 | 本轮结论 | 我的复测证据 |
|---|---|---|
| 🔴 M-01 training-envelope VDOT 证据恒为空 | ✅ **真修** | `prediction-data.ts:283-296`：`.all(asOf, windowStart, asOf)` 三参数对应三占位符（`historicalOverrideJoin` 的 `override.created_at`、`anchor_start_at >= ?`、`anchor_end_at <= ?`），窗口常量 `PERFORMANCE_ENVELOPE_WINDOW_DAYS = 56`（与 `loadRaceReadiness` 同口径）；注释写明"node:sqlite 静默把缺失绑定当 NULL"。旁证：`IOS_MODEL_WALK_FORWARD_REVIEW` 记录真实库 `performanceVdotEvidenceCount = 11`（原为 0）。新增回归 `prediction-data.test.ts:187-196` 断言 `evidence.length == 1` |
| 🟡 M-02 无训练时 readiness=0 被当成最大惩罚 | ✅ **真修（语义正确，未引入 NaN）** | `loadRaceReadinessEvidence` 在 `usable.length === 0` 时返回 `values: {}` + `status: "insufficient_data"`（`prediction-data.ts:499-506`）。**关键核验：`undefined` 不会往下游漏** —— `physiology/src/index.ts:827-828` 用的是 `readiness[distance] ?? config.defaultRaceReadiness[distance]`，而默认先验是 **`five_k:0.7 / ten_k:0.6 / half_marathon:0.45`**（`:115-119`），并非 0；`:898-902` 另有 `endurance_readiness_unmodeled` 证据码；报告层再加 `race_readiness_missing` guidance（`prediction-report.ts:596-598`）。`apps/api/src/mobile-read.ts:258` 也走 `?? null`。⇒ 语义从"缺测=最差"改为"缺测=中性先验+显式标注"，与报告建议一致 |
| 🟡 M-03 / P1-2 恢复 provenance 漏算 raw RHR | ✅ **真修** | `prediction-recovery-read-repository.ts`：`contributesRaw = contributesRestingHeartRate \|\| (contributesHrv && !hasCanonicalHrv)` ⇒ RHR 纳入 raw 判定；另新增 `hrvSource` / `sleepSource` / `latestObservedAt`。仅 RHR 场景不再落 `source:"canonical"` |
| 🟡 M-04 恢复与疲劳不是同一模型 | ➖ **未变**（两套口径仍在，属设计取舍，本轮无改动） | `prediction-report.ts:619-637` 新增 `explainability.recovery`（status/source/coverage/asOf）⇒ **至少现在可解释**，是向"能解释差异"走的半步 |
| 🟡 M-05 iOS 硬解码 + `try?` 静默留旧值 | ✅ **真修** | `NativeAppModel.swift:416-470`：预测刷新失败时置 `predictionLoadState = .stale(..., "预测刷新失败，当前显示的是旧结果。")`，首次无数据则 `.unavailable`；不再是"静默显示旧值"。配套 `APIModels.swift` 新增 `PredictionLoadState` 三态枚举 |
| 🟡 M-06 恢复面板进度环恒为空 | ✅ **真修** | `TechViews.swift:812` 现为 `TechGauge(progress: summary.recovery.score.map { min(max($0 / 100, 0), 1) } ?? 0, …)` —— 不再是硬编码 `0` |
| 🟡 M-07 未知恢复状态静默折叠为"基线不足" | ✅ **真修** | `APIModels.swift:190-199` 新增 `case .some: return "未识别状态"`（置于 `default` 之前，`default` 只接 `nil`）；回归见 `ModelRegression.swift` 的 `[("recovered",…),("reduced",…),("depleted",…),("unknown","未识别状态")]` 全枚举断言 |
| 🟡 M-08 iOS 四类模型无专门 DTO/失败语义回归 | ✅ **真修** | `apps/ios/tests/ModelRegression.swift` **+127/−10**：新增 prediction DTO 全量解码断言（`fatigueAdjustmentSeconds` 保留、`explainability.recovery.source == "canonical"`、**缺测 readiness 被保留而非补零**）、比赛目标时间解析（含 `1:60:00` / `1:5:00` 非法拒绝）、半马里程换算、预览 DTO 解码 |

### 4.2　`UNCOMMITTED_REVIEW_2026-09-25` 的三项必修

| 项 | 本轮结论 | 我的复测证据 |
|---|---|---|
| 🔴 P1-1 `data:prediction-walk-forward` 缺 Node gate | ✅ **真修** | `package.json:67` `"predata:prediction-walk-forward": "npm run check:node"`；node 全量中 `node-version.test.ts` 不再失败（`# fail 0`） |
| 🔴 P1-2 RHR provenance 误标 canonical | ✅ **真修** | 见 4.1 M-03 |
| 🟡 P2-1 手工计划丢弃 `applyRacePlanPolicy` 返回值 | ✅ **真修** | `manual-plan-policy.ts:28-34`：`const safeDays = applyRacePlanPolicy(days, …)` 参与 `validateWeeklyPlan`（`allowedDates` 改用 `safeDays`），并在返回时以 `safeByDate` 覆盖 `weekPlan` ⇒ 比赛日/减量期的安全变换**真的生效**，不再"产生 warning 却把原始危险输入送审" |

### 4.3　`PROJECT_AUDIT_2026-09-24` 的遗留项

| 项 | 本轮结论 | 证据 |
|---|---|---|
| 🟡 M-1 Keychain 写失败静默 | ❌ **未修**（`Keychain.swift` 未被改动） | 见 S-6 |
| 🔡 M-2 `record` 用 `try!` 编码 | ❌ **未核**（对应文件本轮未改） | 维持上轮 🔡 |
| 🔡 N-4 墓碑目录无回收 | ❌ **未修**（`maintenance.ts` 模式未变） | 维持"记录在案，涨了再说" |
| 🟡 N-5 CI 无执行者 | ❌ **未变** | `git remote -v` 仍为 gitee；`.githooks/pre-commit` 实为：blob-size 闸门 + `typecheck` + 条件 `test:ios` + 条件迁移冻结。⇒ **实际自动门禁仍是这四条，live 探针不在任何自动链路** |
| 🟡 N-6 生产备份窗口 | ➖ **本轮未测** | 本轮未上云机；维持 09-24 的 5h52m 观测值 |
| 🔴 真机看门狗判死（最高优先未验收项） | ❌ **仍未做** | 与 09-24 一致：`backgroundTimeRemaining` 与 `backgroundTask != .invalid` 两个读数没有真机采样 |

---

## 五、未提交改动的独立复核（不复述 09-25，只补本轮新验证）

| 面 | 结论 | 证据 |
|---|---|---|
| 契约演进安全性 | 🟢 **无解码断裂** | 服务端新增 guidance code `race_readiness_missing`（`contracts/src/index.ts`）与 `inputs.readiness: Record<RaceDistance, number\|null>`。iOS 侧 `APIModels.swift` 对应字段全部是 optional / 字符串容器：`guidanceCodes: [String]?`、`readiness: [String: Double?]?`、`MobileLockState.candidate: MobileNextSession? = nil`、`NativeRacePrediction` 新增 8 个字段全 optional ⇒ 旧客户端与新客户端**双向兼容**。回归已覆盖（`ModelRegression.swift` 用 `"readiness":{"five_k":null}` + `guidanceCodes:["race_readiness_missing"]` 的真实载荷解码） |
| 新写端点登记 | 🟢 | `server.ts:275-289` `metadataOnlyMutationRoutes` 含 `/v1/mobile/workout-plan/preview` 与 `/confirm`（异步模型调用不持写锁）；`schemas.ts:245-253` 有 body schema，`:736-750` 有 OpenAPI 条目 |
| 预览确认机制 | 🟢 设计正确 | `weekly-plan-preview.ts:15-23`：过期 → 抛；revision 不符 → 抛；**已提交则直接返回同一结果**（"丢失的确认不得产生第二个 revision"）；指纹不符 → 抛。指纹组成含 goals/recommendation/date/week/sync/prescription/previousWeek（`server.ts` 的 `weeklyPlanSnapshot`） |
| 周计划写入前置校验 | 🟢 | `MobileGoalsStore.write` 在持久化前调用 `options.validate`（09-25 已核，本轮改动未触及该顺序） |
| iOS 视图拆分 | 🟢 门禁同步更新 | `TechViews.swift` **−639 行**（拆出 `TechPlanView.swift` / `TechPlanPreviewSheet.swift`）。字段覆盖门禁反而**变强**：`run-tech-presentation-tests.sh:122` 把 `TechPlanView.swift` 纳入锚点扫描并加注释剥离，故 "锚点 ∪ 例外 == 契约字段全集" 仍成立（52 checks 全绿，23/27 字段有展示位） |
| Web 侧改动 | 🟢 极小 | 仅 2 行：`ios/Physiology.tsx:29` 与 `pages/PredictionsPage.tsx:49` 各加一条 `race_readiness_missing` 文案。**未触碰任何 <1024px 冻结区** |
| 交付物卫生 | 🟡 | 工作区含 17 个未跟踪文件，其中 **6 份审查/方案文档**（含 `IOS_MODEL_AUDIT_2026-09-25_副本.md` 与正本**同内容同大小**17337 字节）与 `packages/application/src/prediction-walk-forward-cli.ts`、`apps/api/src/{local-date,manual-plan-policy,race-plan-policy,weekly-plan-preview}.ts`。提交前需按主题 `git add -p` 分组；**副本文件建议删除**（重复内容会污染交付目录） |

---

## 六、绿区（本轮实测确认，非沿用）

| 项 | 证据 |
|---|---|
| 仓库对象账 | `cat-file --batch-all-objects` **3659** == `rev-list --objects --all` **3659**，差额 **0**；`.git` 32MB；无残留 worktree（`git worktree list` 仅主工作区） |
| 体积闸门 | `HEAD` 最大文件 `design/ios-ui-concept-v2.png` **1,428,042 B（1.36MB）** ≤ 1.5MB 闸门；闸门在 `.githooks/pre-commit` 每次提交都跑、路径无关 |
| 凭据卫生 | `sk-…` / `ghp_…` / `AKID…` / 长 API key 模式扫描 `apps packages deploy scripts .githooks` **零命中** |
| Web XSS 面 | `apps/web/src` 全量搜 `dangerouslySetInnerHTML` / `innerHTML` / `eval(` **零命中** |
| 依赖分层 | `packages/{physiology,features,contracts}/src` 无 `@rai/{api-contracts,application,storage-sqlite}` 的 import（唯一命中是 `contracts/src/timezone.ts:12` 注释文本） |
| 迁移冻结 | `packages/storage-sqlite/src/database.ts` 本轮**未被任何改动触及**（`git status` 无此文件）⇒ 冻结表与执行通道均无风险 |
| Rust 门禁 | `cargo test` **2 passed / 0 failed**，node 集成 **11/11**（含 B1–B4 写路径不变量），0 warning |
| 后端冒烟 | `smoke:api` 通过；API 运行时装配无回归 |

---

## 七、行动建议（按可逆性排序，附验收与回滚）

| 序 | 项 | 改动 | 验收标准 | 回滚 |
|---|---|---|---|---|
| 1 | **S-1 修复 live 探针**（本轮最高优先） | `check-export-determinism-live.py` 的 `swiftc` 源清单**补两个文件**：`RouteSyncState.swift` + `RouteSyncStateMachine.swift` | `python3 apps/ios/tests/check-export-determinism-live.py` ⇒ EXIT=0、**7 checks / 0 failed**（含 `self-check` 那条）；再手工跑一次 `run-visual-tests.sh` 确认能越过第 21 行 | 单文件 revert |
| 2 | **S-1 加固：清单不再硬编码** | 改为"断言 HealthKitExport 引用的仓库内类型都在 `swiftc` 输入里"，或全量交给 `swiftc` + `-parse-as-library` | 人为给 `HealthKitExport.swift` 加一个跨文件引用 ⇒ 门禁**在编译前**就以可读信息变红，而不是报 `cannot find … in scope` | 同上 |
| 3 | **S-2 给 `TechPlanPreviewSheet` 补断言** | `run-tech-presentation-tests.sh` 加具名断言；必要时补一条 ModelRegression | 干净 worktree 里删掉"替换提示"分支 ⇒ 断言**变红**（突变到红） | 纯测试 revert |
| 4 | **S-3 修夹具** | `run-visual-tests.sh` 夹具加 `localDate >= today` 过滤 | 脚本能走完截图流程并产出 `output/`；不改服务端 | 脚本 revert |
| 5 | **S-4 补 walk-forward CLI 最小用例** | 新增一个空库用例 | 空库不抛异常、ML candidate = `insufficient_walk_forward_samples`、无 NaN | 纯测试 revert |
| 6 | **S-6 Keychain 返回值**（沿用上轮） | `saveToken` 返回结果 + 失败 NSLog + UI 提示 | 模拟钥匙串失败 ⇒ 调用方拿到 false 且日志可见 | 单文件 revert |
| 7 | **真机看门狗判死**（仍未做，iOS 侧最高优先未验收项） | `performSync` 入口临时打两行读数 | 一次真机后台运行即可判定"看门狗自杀"还是"恒不触发" | 删日志 |
| 8 | **N-5 CI 拍板**（需你决策） | 搬 gitee 流水线 / 自建 runner / 在 `ci.yml` 头部注明"无执行者" | 任选其一并落到文件 | 删改 workflow |
| 9 | **提交前整理** | 17 个未跟踪文件按主题分组；**删掉 `IOS_MODEL_AUDIT_2026-09-25_副本.md`** | `git status` 干净且提交粒度可读 | — |

---

## 八、对辅助结论的反向复核（纠正了谁、纠了什么）

1. **纠正 09-26 工作日志的修法（S-1）**：日志写"修法：把 `RouteSyncStateMachine.swift` 加进探针 `swiftc` 源清单（若它又拖新依赖，需一并加）"。**实测证伪了前半句的充分性** —— 只加一个文件立刻爆出 `RouteSyncStateMachine.swift:152,155` 的 `settled` 枚举推断错误，**必须同时补 `RouteSyncState.swift`**。括号里的"若又拖新依赖"从"可能"变成了**确定**。这是"建议本身未经验证"的又一实例：**旧报告的修法不能直接照做，要先在副本上跑一遍。**
2. **纠正我自己的检索假阴性（方法论）**：第一轮用 `grep -rnE "^(struct|enum|final class|class) RouteObservation"` 得**零命中**，差点写成"`RouteObservation` 无定义"。换 Grep 工具后命中 `RouteSyncStateMachine.swift:9`（真实形式是 `nonisolated struct RouteObservation`）⇒ 假阴性来源是**行首锚定过严**（与记忆中"长下划线标识符要截短重搜"同族，但触发条件不同）。**"零命中必须换写法复核"这条纪律再次直接救回一个错误结论。**
3. **推翻记忆里对 skip 数的预期**：本轮 3 skip 全部是 Windows-only，`publication lock` 那条**实跑通过**（历史记录预期它会在 macOS EPERM 跳过）。⇒ 印证"3 skip 不是稳定基线、看到 skip 数变化先查这条"，**不是覆盖丢失**。
4. **确认 `run-ios-gates.sh` 的自我声明属实**：它头注释明写"刻意不含 `run-visual-tests.sh`（需模拟器 + `var/rai.sqlite`）"。我一度怀疑 `determinism` 零命中是假阴性，换写法后确认 `Export determinism checks` 来自**结构版** `check-export-determinism.py:177`（由 `run-model-tests.sh` 调用）⇒ **同名两版脚本、自动链路只跑结构版**，这正是 S-1 得以静默 3 天的机制。

---

## 附：未覆盖范围（如实声明）

- **真机行为**：iOS 结论仍是"编译级 + 纯逻辑级 + 结构判据级（252 条）+ DTO 解码级"。锁屏时序、`backgroundTimeRemaining` 真实读数、BGTask 续传、新 scope 的 GPX 端到端交付**均未验证**（S-1 修复前连模拟器验收入口都进不去）。
- **模拟器视觉回归本轮未跑**：受 S-1 阻塞；`xcodebuild` 编译未单独跑（`test:ios` 已含 55 文件类型检查 + 全部纯逻辑回归）。
- **突变验证未做**：`npm run test:ios:mutation`（74 条、十几分钟、会改写源码）与 `test:ios:mutation:scope` 本轮均未执行。S-1 的修法验证是"补文件后实跑绿"，**不是突变到红**。
- **云机 / 线上环境未采样**：本轮未上云机，N-6 备份窗口、线上库版本与行数**沿用 09-24 一手结论**，未重新取证。
- **性能维度**：无针对性性能实测（无性能投诉输入）。
- **Web 侧为抽样**（门禁全量 + 全局 XSS/凭据扫描 + 2 行改动的逐行阅读），非 46 个 tsx 逐行；冻结区（<1024px）按 `AGENTS.md` 未触碰。
- **S-3 未本轮复跑**：夹具 422 的定性依据是读码 + 09-26 实测记录（本轮未起验收服务）。
- 审查过程**未修改任何业务代码、未触碰用户数据**；探针实验在 `/tmp` 副本内完成并已 `rm -rf`；工作区状态项 54（= 37 已跟踪 + 17 未跟踪）与开工时**逐项一致**。

---

*报告时点：2026-09-26 上午（Asia/Shanghai）｜基线 `49c9ef9`，工作树含 37 + 17 项未提交改动*
