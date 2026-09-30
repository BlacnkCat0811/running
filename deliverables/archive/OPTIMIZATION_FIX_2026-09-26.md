# 待优化项修复与验证实录（2026-09-26）

> 范围：09-26 两份报告（`PROJECT_AUDIT_2026-09-26.md` / `UNCOMMITTED_CHANGES_2026-09-26.md`）里
> 的 🟡 待优化清单，小唐选定四组全做（A 一致性+覆盖 / B 视觉夹具 / C 性能 / D iOS Keychain）。
> **未改动任何业务语义**；每一项都做了「改前取证 → 改后验证」，能突变的都突变到了红。
> HEAD 起点 = `aec32b0`（线上也是它）。改动面 **11 个文件 +180/−22**，另 1 个未跟踪新测试文件。

---

## 一、结论先行

| 项 | 改了什么 | 改后判据 | 突变验证 | 判定 |
|---|---|---|---|---|
| **A1** | 3 处 `?? 30` → `DEFAULT_WEEKLY_DISTANCE_KM` | `typecheck EXIT=0`；mobile 相关 132/132 | 字面量本就是 `30` ⇒ **值等价**（不需突变） | ✅ 完成 |
| **A2** | 新增 walk-forward CLI 测试（3 条） | 3/3 绿；进 `npm test` ⇒ 839/836 | **2 条独立突变各自变红** | ✅ 完成 |
| **A3** | `run-tech-presentation-tests.sh` 补 5 组预览断言 | 52 checks + 新具名行；进 `test:ios` | **2 条突变各精确变红** | ✅ 完成 |
| **A4** | 重复副本移入废纸篓 | 目录内无副本、正本哈希未变 | — | ✅ 完成 |
| **B** | 视觉夹具只回填「今天及以后」 | 真实夹具块 `FIXTURE_EXIT=0`（写入 `09-26/09-27`）+ **整链路 `VISUAL_EXIT=0`，13/13 UI 用例通过** | 改前实跑复现 **422** | ✅ 完成 |
| **C** | `executableMobilePlan` 去重（同一次结果外传） | before/after JSON **仅 `generatedAt` 不同** | 实测收益仅 **1.3%**（见 §六，非性能理由） | ✅ 完成 |
| **D** | `SecItemAdd` 状态上报 + 界面提示 | 关键链 + Session 回归全绿；**告警 4→0** | **2 条突变变红（EXIT 132 / EXIT 1）** | ✅ 完成 |

**全局门禁**：`typecheck` / `npm test` / `test:ios` / `build` / `check-bundle` / `smoke:api` **全部 EXIT=0**。

🔴 **本轮最值得单独说的两件事**：

1. **我引入了一条真回归，并被既有断言抓住**（D 项）：`apiToken.isEmpty || saveToken(...)` 的短路让
   「清空 token」不再调用 `saveToken`，钥匙串条目没被删除 ⇒ 重启后旧 token 复活。
   → 修法：先调后判（`const persisted = saveToken(...)`）。**教训**：写「或」短路前先问
   「被跳过的副作用里有没有必要的写操作」。
2. **`git checkout -- <file>` 回退突变会把要保留的改动一起还原**（D 项实测被打回 HEAD，只能重写整文件）。
   → 已写进 `MEMORY.md` 工具坑：**回退突变优先用 `Edit` 反向改**。

---

## 二、A1　兜底周跑量常量同源

### 改前

```
apps/api/src/data.ts:546        goals: { weeklyDistanceKm: goalDistanceKm ?? 30, ...
apps/api/src/data.ts:556        weeklyDistanceKm: goalDistanceKm ?? 30,
apps/api/src/mobile-read.ts:421 applyRacePlanPolicy(args.storedPlan, args.raceTarget, args.weeklyDistanceKm ?? 30, ...)
apps/api/src/mobile-goals.ts:32 export const DEFAULT_WEEKLY_DISTANCE_KM = 30;   ← 既有常量，未被这三处使用
```

（`server.ts:890` 的 `?? 30` 是分页 `limit`，与周跑量无关，**不动**。）

### 改后

三处全部改用常量；`data.ts` 的 `import type` 改为同时引入值。

⚠️ **动手前查出的一步**：`data.ts` 此前对 `mobile-goals.js` **只有 type-only 导入**（编译后被擦除），
改成值导入会建立**运行时依赖** ⇒ 先查闭包：
`mobile-goals` → `mobile-coach` / `session-structure` / `local-date`，**三者均无本地相对导入**
⇒ 无运行时环，安全。

### 验证

| 判据 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| mobile 相关 4 个测试文件 | **132 / 132 pass / 0 fail** |
| 等价性 | 常量字面量就是 `30` ⇒ **值逐字节相同**，零行为变化 |
| 残留检查 | `grep -rnE '\?\? 30\b' apps/api/src/` 只剩 `server.ts:890`（分页，无关） |

**回滚**：`git checkout -- apps/api/src/data.ts apps/api/src/mobile-read.ts`

---

## 三、A2　`data:prediction-walk-forward` 补回归

### 改前

- `packages/application/src/prediction-walk-forward-cli.ts` 在 `packages/application/test/` 与
  `apps/api/test/` 中**零引用**（全仓只有 `README.md:130` 提到用法）。
- 手工跑一次空库留档，作为"目前只有一次观测、无任何回归保护"的基线：

```
status                insufficient_labeled_outcomes
labeledOutcomeCount   0
evaluatedOutcomeCount 0
ml.status             insufficient_walk_forward_samples
CLI_EXIT=0
```

### 改后

新增 `packages/application/test/prediction-walk-forward-cli.test.ts`（3 条）：

1. 空库降级：`status`/`reportVersion`/`labeledOutcomeCount`/`ml.status`/`trainedExampleCount` 逐项断言；
2. **序列化前**无数值异常；
3. 缺库文件 → 非 0 退出 + `Database not found`；`--database` 缺值 → 非 0 退出 + `requires a value`。

### 🔴 关键发现：审计给的验收标准写在了会被"洗掉"的那一层

原验收标准是「空库 ⇒ 不产出 NaN」。但 **`JSON.stringify` 会把 `NaN`/`Infinity` 静默写成 `null`**
⇒ 在**打印出来的 JSON** 上查 NaN 是**假断言**。实测：往 `calibrationAppliedCount` 注入 `Number.NaN` 后，

```
ok     1 - CLI degrades ...                       ← 子进程那条（查 stdout）仍然全绿！
not ok 2 - no non-finite number ...               ← 只有进程内遍历器抓到
  error: '$.calibrationAppliedCount is not a finite number: NaN'
```

**判据必须写在序列化之前的对象上。** 该测试因此分成两层：子进程（验参数解析 + JSON 形状）+
进程内（验数值有限性）。

### 突变验证

| 突变 | 结果 |
|---|---|
| `buildPredictionEvaluationReport` 注入 `Number.NaN` | 第 2 条 **变红**（第 1 条仍绿 ⇒ 证明第 1 条**不能**替代第 2 条） |
| CLI `optionValue` 缺值改为静默回退 | 第 3 条 **变红** |

`MUTANT_EXIT=1`；两处突变已回退（`git diff --stat` 为空），重跑 **3/3 绿**。

**回滚**：删除该测试文件即回到改前覆盖。

---

## 四、A3　`TechPlanPreviewSheet` 补回归断言

### 改前

```
git show HEAD:apps/ios/tests/run-tech-presentation-tests.sh | grep -c TechPlanPreviewSheet  →  0
git grep -c TechPlanPreviewSheet HEAD -- apps/ios/tests/                                     →  （空 = 零引用）
```

### 🔴 修正：审计建议的断言形式是错的

审计建议「断言 sheet 内不出现 `confirm` 调用」。实读源码：`TechPlanPreviewSheet.swift:53`
**本来就有** `await native.confirmPlanPreview(preview)`（在「确认替换」按钮里）—— 用户本来就该显式确认。
按该建议写会**误报**（把正常实现判红）。

**真正的不变量是「打开预览不得写入」**，因此断言改为形态级：

| 断言 | 理由 |
|---|---|
| 文件内不含 `.task` / `.onAppear` / `.onChange` | 预览是提议；生命周期钩子会自动落库 |
| `count("confirmPlanPreview(") == 1` | 确认只允许一处 |
| `Button(... "确认替换") { Task {` 形态存在 | 确认必须由显式按钮触发 |
| `preview.revision != native.goals?.revision` 存在 | 过期候选守卫（按钮 disabled + 红字提示） |
| 替换日期 **两态**、既有处方 **两态** 都在 | 单边分支会静默隐藏「有东西被替换」 |

### 验证

```
Technology presentation: 52 checks passed
Plan preview gate: confirm-only, with both replaced-date and previous-prescription branches present.
TECH_PRESENT_EXIT=0
```

并且该行出现在聚合门禁 `npm run test:ios` 的日志里（`:613`）⇒ 真的被自动链路执行，不是孤儿脚本。

### 突变验证

| 突变 | 结果 |
|---|---|
| 加 `.task { await native.confirmPlanPreview(preview) }` | **EXIT=1**，`gained .task ... would save a plan nobody agreed to` |
| 把替换日期提示塌成单态 | **EXIT=1**，`lost the replaced-date empty branch ...` |

两次回退后重跑 **EXIT=0**。

**回滚**：`git checkout -- apps/ios/tests/run-tech-presentation-tests.sh`

---

## 五、A4　清理重复副本

### 改前

```
633de19cfefd70098ccf08ff45d1d124b660987bcdb3e15bac6d4c3dfa82fee0  IOS_MODEL_AUDIT_2026-09-25.md
633de19cfefd70098ccf08ff45d1d124b660987bcdb3e15bac6d4c3dfa82fee0  IOS_MODEL_AUDIT_2026-09-25_副本.md
均 17337 bytes；cmp 无输出 ⇒ 逐字节相同
```

### 处置

⚠️ `osascript` 走 Finder **在本沙箱被拒**：`execution error: “Finder”遇到一个错误：AppleEvent已超时。(-1712)`。
改用 `mv ~/.Trash/`（同样是废纸篓，**可逆**，未使用 `rm`）。

### 改后

- `deliverables/` 内已无副本；
- 正本 SHA256 **未变**（`diff` 与改前哈希一致 ⇒ `PRIMARY_UNCHANGED`）；
- `git status --ignored` 无副本残留。
- ℹ️ `ls ~/.Trash` 会被沙箱拒读（`Operation not permitted`），**不影响移动结果**。

**回滚**：从废纸篓拖回 `deliverables/` 即可。

---

## 六、B　视觉验收夹具（S-3）

### 改前复现（起隔离 API + 真库副本，跑**原版**夹具逻辑）

```
today.weekPlan 日期: ['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26','2026-09-27']
其中早于 today 的日期: 5 天（09-21 … 09-25）
PUT_STATUS 422 BODY {"code":"plan_policy_violation","message":"历史、已完成或已锁定日期不能通过周计划编辑改写。请保留原日期内容。"}
```

⇒ `run-visual-tests.sh` 在 `set -euo pipefail` 下**夹具这一步就死**，后面的代理启动、模拟器构建、
截图、跨进程字节比对**全部跑不到**。**服务端拒绝改写历史日期是对的，过时的是夹具。**

### 改后验证（**抽取真实脚本里的夹具块**执行，不照着重写）

```bash
awk '/^import json, urllib.request$/{f=1} /^PY$/{if(f) exit} f{print}' apps/ios/tests/run-visual-tests.sh
```

```
FIXTURE_EXIT=0
回填后 goals.weekPlan 日期: ['2026-09-26', '2026-09-27']    ← 只有今天及以后
回填后 goals.revision: 1                                     ← PUT 成功（200）
```

📌 用「抽取真实块」而不是「按新逻辑另写一遍」，是为了避免**两套实现的偏差**——
后者验的是我重写的那份，不是仓库里的那份。

### 整链路验证

`bash apps/ios/tests/run-visual-tests.sh`（`RAI_XCODEBUILD_SWIFT_FLAGS=-disable-sandbox`）：

- 第一步 live 探针：**`Export determinism (live): 7 checks, 0 failed`**（同时复核 S-1 修复仍在）；
- 脚本**越过了夹具**：`api.log` / `simulator.log` / `state-proxy.log` / `build.log` / `derived/` 全部生成，
  而这些步骤都在夹具之后 ⇒ **夹具不再中断链路**（改前会在这里死）；
- 后续 `xcodebuild` 进入真实编译（iPhoneSimulator26.5 SDK）→ 安装 → 启动 App → 跑完 **13/13 UI 用例**：

| 用例 | 结果 | 用时 |
|---|---|---|
| `test01TodayAndBody` | passed | 140.6s |
| `test02Workouts` | passed | 139.4s |
| `test03Plan` | passed | 94.2s |
| `test04Analysis` | passed | 67.0s |
| `test05Settings` | passed | 42.8s |
| `test06Setup` | passed | 33.4s |
| `test07LargeText` | passed | 53.1s |
| `test08FaultStates` | passed | 185.1s |
| `test10RevisionConflict` | passed | 58.9s |
| `test11NativeBackGestureAndSafeArea` | passed | 68.9s |
| `test12LargeAbilityAndKeyboard` | passed | 282.9s |
| `test13SeriesInteractionDoesNotStealScroll` | passed | 70.4s |
| `test14ScrollPerformanceBaseline` | passed | 79.5s |

⇒ **`** TEST SUCCEEDED **`（passed 13 / failed 0，导出 60 张截图），`VISUAL_EXIT=0`。**
**对照改前**：夹具 422 ⇒ 脚本在 `set -euo pipefail` 下**第一步之后即中止**，这条链路整体跑不到。
（UI 截图**不能**当视觉验收证据 —— 本机是 AMD 黑苹果，部分图标渲染为灰块，见 §十.3。）

**回滚**：`git checkout -- apps/ios/tests/run-visual-tests.sh`（夹具为脚本内嵌内容）

---

## 七、C　`executableMobilePlan` 重复计算

### 改前实测（临时探针，`// PROBE` 标记，测完已清）

| 指标 | 实测值 |
|---|---|
| `executableMobilePlan` 单次耗时 | **1.52 ms**（n=24 次调用） |
| `/v1/mobile/today` 中位延迟（**1 次**调用） | 121.6 ms（min 91.6 / max 248.8） |
| `/v1/mobile/workout-plan` 中位延迟（**2 次**调用） | 118.4 ms（min 94.5 / max 199.1） |

调用点：`data.ts:511`（`mobileToday` 内部，用于改写 `weekPlan`）与 `data.ts:533`
（`mobileWorkoutPlan` 又调一次）。⇒ 冗余的那一次 = **1.5 ms ≈ 1.3%**。

### 改后实测

| 指标 | 实测值 |
|---|---|
| `/v1/mobile/today` 中位 | 114.4 ms（min 103.6 / max 140.0） |
| `/v1/mobile/workout-plan` 中位 | 146.8 ms（min 100.3 / max **238.0**） |

🔴 **端点级噪声带 ~100 ms，根本分辨不出 1.5 ms 的改动。**
⇒ 本机的端点对比**不能**用作收益证据；收益只能由**单调用探针**给出（1.52 ms/次）。
这正是纪律 #9 要求的写法：**判据是同条件旧/新对比，而这里连对比都被噪声淹掉**。

### 等价性证明（这是本项唯一站得住的判据）

对改前/改后两个端点的响应做**递归深比对**：

```
### today: 1 处差异
    $.generatedAt: '2026-09-26T13:02:43.380Z' -> '2026-09-26T13:04:23.856Z'
### plan: 1 处差异
    $.generatedAt: '2026-09-26T13:02:43.524Z' -> '2026-09-26T13:04:24.020Z'
```

**唯一差异是时间戳**；整周 `weekPlan` 改写、`days`、`structure`、`warnings` 全部**逐字节相同**。

### 为什么还是改了（以及为什么不以性能为理由）

1.5% 以下的收益**不足以**成为改动理由。真正的理由是：第二次调用拿到的是**同一个对象、但
`result.weekPlan` 已被改写成执行版**的输入 —— 两次结果今天相同，是因为 `executableMobilePlan`
**恰好从不读** `today.weekPlan`（已核实：`constrainUpcomingPlan` 只读
today / week / nextSession / lock / weekStructure / injuryFlags）。一旦有人让它读 `weekPlan`，
第二次就会去读**自己上一轮的输出**。把同一次结果显式传出去，比让它被重算更安全。

实现：拆出 `mobileTodayWithExecutablePlan()` 返回 `{ today, effective }`，
`mobileToday` 取 `.today`、`mobileWorkoutPlan` 取 `.effective`，`executableMobilePlan` 每请求只跑一次。

⚠️ **残留风险（如实记录）**：该等价性依赖「`executableMobilePlan` 不读 `today.weekPlan`」这条
**结构性假设**，目前**靠代码注释守护，没有门禁**。理由：把它变成编译期约束需要收窄
`constrainUpcomingPlan` 的参数类型（它会整体收下 `today`），改动面远超收益。
既有行为覆盖：`mobile-coach.test.ts:532`「today's card matches the executable week」仍在守护
「三个读者一个数」，我的改动后 148/148 全绿。

**回滚**：`git checkout -- apps/api/src/data.ts`（注意会同时回退 A1 在该文件的两处）

---

## 八、D　Keychain 写失败显式上报（S-6 / M-1，自 09-24 起维持未修）

### 改前（HEAD）

```
apps/ios/RAI/Keychain.swift:53     SecItemAdd(add as CFDictionary, nil)      ← OSStatus 被丢弃
apps/ios/RAI/ServerSession.swift:32  private let saveToken: @MainActor (String, String?) -> Void
apps/ios/RAI/ServerSession.swift:53  saveToken: ... -> Void = { Keychain.saveToken($0, for: $1) }
git grep -c credentialStorageError HEAD -- apps/ios/   →  0
```

⇒ 钥匙串写入失败（钥匙串满 / 设备恢复中 / 托管配置 / 授权被拒）时，调用方一律**表现为成功**；
用户下次启动被要求重新输入，且**没有任何日志能解释**。

### 改后

| 层 | 改动 |
|---|---|
| `Keychain.saveToken` | 返回 `Bool`（"钥匙串现在就是你要的状态"）；`SecItemAdd` 失败 ⇒ `NSLog("... OSStatus %d ...")` |
| `Keychain.saveToken` 的 `SecItemDelete` | 显式 `_ =`（有意忽略，注释说明）⇒ **编译告警 4 行 → 0** |
| `ServerSession` | 新增 `private(set) var credentialStorageError: String?`；closure 类型改 `-> Bool` |
| `TechSetupView` / `TechViews` | 各加一处展示（`key.slash` / 红字） |
| 三个替身（`KeychainRegression` 的 `SecItemAdd` 桩、`ServerSessionRegression`、`StoreRegression`） | 同步签名 |

🔴 **为什么必须独立于 `lastError`**：探针每次 2xx 都会执行 `lastError = nil`，
凭证存储失败在那里**留不住** —— 而这恰是一次"看起来成功、实际没存上"的失败，最需要被看见。

### 🔴 我引入并被既有断言抓住的回归

第一版写成：

```swift
credentialStorageError = (apiToken.isEmpty || saveToken(apiToken, serverURLString)) ? nil : "..."
```

`||` **短路**：清空 token 时 `saveToken` **根本没被调用**，而删除钥匙串条目正是靠它
⇒ 「清空」只清了内存，重启后旧 token 复活。既有断言当场变红：

```
FAIL: clearing B's token does not revive the legacy A token
```

修法（先调后判，无条件调用）：

```swift
let persisted = saveToken(apiToken, serverURLString)
credentialStorageError = (persisted || apiToken.isEmpty) ? nil : "凭证未能保存到钥匙串；..."
```

⇒ **教训已写进当日日志**：写「或」短路前先问「被跳过的副作用里有没有必要的写操作」。

### 突变验证

| 突变 | 退出码 | 断言消息 |
|---|---|---|
| `Keychain.saveToken` 末尾 `return true`（恒报成功） | **132**（SIGILL） | `Precondition failed: a rejected add must not report success` |
| `ServerSession` 的 `credentialStorageError = nil`（回到静默吞） | **1** | `FAIL: a rejected keychain write must be surfaced…` + `FAIL: a successful probe must not clear the credential storage error` |

两处突变已回退（`grep -rn MUTANT apps/ios/` 无残留），重跑全绿。

**回滚**：`git checkout -- apps/ios/RAI/Keychain.swift apps/ios/RAI/ServerSession.swift apps/ios/RAI/Skins/Technology/TechSetupView.swift apps/ios/RAI/Skins/Technology/TechViews.swift apps/ios/tests/`

---

## 九、全局回归（全部前台实跑）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| `npm test` | **EXIT=0**；node **839 / 836 pass / 0 fail / 3 skip**（基线 836/833/0/3，**+3 恰好是新增用例**，无其他变化）；web **13 文件全绿** |
| `npm run test:ios` | **EXIT=0**（**252** 后台 checks / 0 failed；**52** 技术呈现；**62** store；**14** 导出确定性；类型检查） |
| `npm run build` | EXIT=0（21.68s） |
| `check-bundle.mjs` | EXIT=0 |
| `npm run smoke:api` | EXIT=0 |
| `run-visual-tests.sh` 全链路 | **EXIT=0**（live 探针 7/0 → 夹具通过 → 构建 → 安装 → **13/13 UI 用例通过** → `** TEST SUCCEEDED **`，60 张截图） |

3 个 skip 仍是 Windows-only，**无覆盖丢失**。
本轮新增断言**确实进了聚合链路**（`test:ios` 日志 `:140 / :314 / :316 / :317 / :613`），不是孤儿脚本。

---

## 十、未覆盖 / 残留风险（如实声明）

1. **C 项的结构性假设无门禁**：见 §七。等价性靠一次性快照证明 + 代码注释，不靠自动门禁。
2. **D 项未在真机验证**：`NSLog` 与界面提示只在 mac 纯逻辑回归 + 模拟器构建层面验证过；
   真机上「钥匙串真的失败」这一路径没有手工复现（需要真实被拒场景）。
3. **B 项的 XCUITest 结果不评测 UI 视觉**：本机是 AMD 黑苹果，部分图标渲染为灰块（已知图形栈瑕疵），
   截图**不能**当作视觉验收证据；本项只主张"链路不再被夹具中断"。
4. **C 项的收益只在本机测得**（AMD Ryzen 5 3600X / macOS 26.6.2）。线上是 N100，
   未在目标机器复测；但由于改动是**纯去重、输出等价**，风险与收益都与机器无关。
5. **未做的事**：真机行为验收、性能压测、`N-5`（CI 无执行者，属基础设施决策）、真机看门狗采样。

---

## 十一、提交建议

改动跨 3 个主题域，**同一文件内不同主题混杂**（`data.ts` 同时含 A1 与 C）⇒ 建议分 3 组、用 `git add -p`：

| 组 | 主题 | 文件 | 验收 |
|---|---|---|---|
| 1 | `fix(ios-test): 恢复视觉验收夹具的未来日期过滤` | `run-visual-tests.sh` | `run-visual-tests.sh` 越过夹具 |
| 2 | `fix(ios): 钥匙串写入失败必须上报` | `Keychain.swift`、`ServerSession.swift`、2 个视图、3 处替身 | `test:ios` 绿 + 突变到红 |
| 3 | `chore: 常量同源、补覆盖、去重复计算` | `data.ts`、`mobile-read.ts`、`run-tech-presentation-tests.sh`、新测试文件 | `npm test` 839/836 + `test:ios` 52 checks |

**共同验收**：`typecheck` + `npm test` + `test:ios` 三条 EXIT=0。
**整体回滚**：`git checkout -- <组内文件>`；无 SQL 迁移、无破坏性契约变更、无数据写入。
