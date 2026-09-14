# RAI 项目完整审查报告 · 2026-09-12

> **修复状态（同日 22:15 更新）**：§三 的 **2 项 🔴、5 项 🟡、3 项 🔡 已全部修复并验证**；仅 §3 P2-2（设计图体积）改为**记录 + 待决策**，理由见 §九.2（它不是技术缺陷，取消跟踪会破坏设计交接物，且不减 `.git` 体积）。
>
> **修复后门禁**：`typecheck` ✅ EXIT=0 ｜ node:test **535 项（531 pass / 0 fail / 4 skip）** ｜ vitest **78** ｜ `build` ✅ ｜ `run-model-tests.sh` ✅ ｜ `smoke:api` ✅ ｜ `typecheck-ios.sh` **EXIT=1 + 环境诊断**（见 §九.1）。

> **审查对象**：`/Users/ta/running`（RAI Running Ability Intelligence）
> **基线**：本地 `main` = `origin/main` = **`8d74a24`**，工作树 **36 项未提交**（23 已跟踪改动 + 13 新文件）。
> **对比基线**：上轮健康审计 `docs/PROJECT_HEALTH_AUDIT_2026-09-10.md`（`18067cb`）之后 **10 commits**。
> **方法**：质量门禁全量实跑 → 逐维度读源码 → **写探针实测可疑点**（不只看码、不复述文档）→ 对子代理结论与既有报告做**反向复核**。
> 所有结论落到 `文件:行号` 或命令实测输出。**审查过程未修改任何业务代码与用户数据**（探针置于 `/tmp`）。

---

## 一、总结论（先行）

**健康度：B−（良好，但存在 1 项 P0 功能缺陷 + 1 项 P0 测试盲区）**

上一轮报告的 5 项 P1 **全部闭环**，双 CI 已收敛——**技术债偿还得很好**。但本轮的周课表生成链暴露了一个**已存在、此前未被量化的量控缺陷**：未配置 LLM 密钥的部署（默认状态）在中小周目标下会给出 **3.6～5.8 倍**于目标的课表。

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 质量门禁 | 🟢 绿 | typecheck / node:test 531 / vitest 78 / build / iOS 模型测试 **全绿** |
| 冻结区合规 | 🟢 绿 | `App.tsx` / `styles.css` / e2e **零改动** |
| 依赖与分层 | 🟢 绿 | 依赖单向无环，纯核心无平台依赖，iOS 未重写评分 |
| 周课表量控 | 🔴 红 | **fallback 模板在小周目标下超目标 3.6～5.8 倍**（实测） |
| API 鉴权 | 🟡 黄 | 实现正确，但**唯一的访问控制零测试** |
| iOS 验证通道 | 🟡 黄 | `typecheck-ios.sh` 本机 **EXIT=1**（环境限制，非代码） |
| 契约强制力 | 🟡 黄 | `/v1/health`、`/v1/handshake` 服务端无类型注解 |
| 仓库卫生 | 🟡 黄 | 6 张 4.4–4.8MB 设计图入库，`.git` 55MB |

**一句话**：**架构与安全姿态依旧是对的，上轮债务清得干净；问题出在"新增功能的边界测试覆盖"——修复本身都验证过了，但修复的**反面场景**（小目标、无密钥、鉴权分支）系统性缺测。**

---

## 二、质量门禁实跑（本次实测，非引用）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | ✅ **EXIT=0** | pure + 全量双 tsconfig，46s |
| node:test（全量） | ✅ **531 项 / 527 pass / 0 fail / 4 skip** | 4m37s |
| vitest（web，分 5 批） | ✅ **78 项全通过** | 11+26+27+10+4 |
| `npm run build` | ✅ **EXIT=0** | `✓ built in 21.36s` |
| `apps/ios/tests/run-model-tests.sh` | ✅ 全绿 | 含新增 6 条 `structureSummary` 断言 |
| `apps/ios/tests/typecheck-ios.sh` | ❌ **EXIT=1（203 error）** | 见 §3.4，**环境限制** |
| 冻结区改动 | ✅ 零改动 | `git diff --name-only -- apps/web/src/App.tsx apps/web/src/styles.css apps/web/e2e/` → 空 |

> 注：上轮 P2-1 的 `server-runtime` 并行 flaky **本轮未复现**（`968afbf test(api): 运行时测试改用临时端口并等待实际绑定` 已修）。

---

## 三、分级问题清单

### 🔴 P0-1　回退模板在小周目标下超目标 3.6～5.8 倍

**这是本轮最重要的发现，且此前所有报告都未量化。**

`buildFallbackWeekPlan` 的注释声明：

```ts
// weekly-plan-validate.ts:362-365
 * Conservatively spreads one or two quality sessions across the week
 * and sizes every day from its structure, so the template cannot exceed the
 * weekly goal it was derived from.        ← 实测为假
```

**实测（探针 `/tmp/rai-probe-fallback.ts`，7 天窗口、qualitySessionCap=2）**：

| 周目标 | fallback 实际总量 | 倍率 | 判定 |
|---|---|---|---|
| **5 km** | **28.80 km** | **5.76×** | 🔴 超 |
| **8 km** | **28.80 km** | **3.60×** | 🔴 超 |
| **15 km** | **28.80 km** | **1.92×** | 🔴 超 |
| 30 km | 29.80 km | 0.99× | ✅ |
| 40 km | 39.80 km | 1.00× | ✅ |
| 80 km | 79.80 km | 1.00× | ✅ |

**根因**（`weekly-plan-validate.ts:387-400`）：

```ts
const measuredKm = measureStructure(structure, kind, paces).distanceKm;  // 393 质量课固定量
qualityKm += measuredKm;                                                  // 394
...
const budgetKm = Math.max(0, args.weeklyDistanceKm - qualityKm);          // 399 → 小目标时为 0
const perEasyKm = easyCount > 0
  ? roundKm(Math.max(MIN_EASY_DISTANCE_KM, budgetKm / easyCount)) : null; // 400 → 退化为地板
```

质量课结构由 `buildSessionStructure(kind, args.prescription, {})` 决定（`:391`），**与周目标无关**：interval ≈ 7.5 km + tempo ≈ 8.8 km = **16.3 km 固定量**。当 `weeklyDistanceKm < 16.3` 时 `budgetKm = 0`，6 个 easy 日各退到 `MIN_EASY_DISTANCE_KM = 2`（`:60`）经结构放大为 2.5 km → 15 km。合计 28.8 km。

**触发条件是默认部署状态**：`weekly-plan-service.ts:139-141` 在未配置 `RAI_LLM_API_KEY` 时**必然**走 fallback。⇒ 一个设了 10 km 周目标、没配密钥的用户，每次生成都会拿到近 3 倍的课表，并经 `PUT /v1/mobile/goals` 持久化、由 `WorkoutKitBridge` 上表执行。

**测试盲区坐实**：`buildFallbackWeekPlan` 仅在 `weekly-plan.test.ts:266,277,599` 被测，周目标分别为 **35 / 35 / 50** —— 全部 ≥ 30 km，**小目标从未覆盖**，故 09-12 报告的"验收标准②总量 ≤ 周目标×1.02"在大目标下成立、小目标下失效。

---

### 🔴 P0-2　API Token 鉴权分支零测试

`installLocalRequestSecurity`（`apps/api/src/local-request-security.ts:85-108`）是全服务**唯一的访问控制**（Nginx 只透传 Bearer，后端自校验）：

```ts
// local-request-security.ts:86-97
if (options.apiToken && (request.url.split("?", 1)[0] ?? "").startsWith("/v1/")) {
  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${options.apiToken}`) { ... return; }
  return reply.code(401).send({ code: "unauthorized", ... });   // ← 零覆盖
}
```

**实测证据**：`local-request-security.test.ts` 共 5 个用例（`:12,52,72,88,115`）——**全部不传 `apiToken`**，且请求路径全部是 `/write`、`/read`（**非 `/v1/` 前缀**）。因此 `:86-97` 的整个分支在测试中**从未被执行**。

全仓交叉验证（含 `.mjs`）：

```
grep -rn "apiToken|RAI_API_TOKEN|allowAuthenticatedRemote|trustedOrigins" \
  apps/api/test apps/web/test apps/web/e2e packages/*/test   →  0 匹配
```

**代码本身我逐行读过，逻辑是正确的**（`split("?",1)[0]` 正确取路径；所有数据端点均在 `/v1/` 下，`server.ts:564-1339`；`/` 前缀仅静态资源 + SPA fallback，不泄露数据）。**问题不在实现，在于这道门没有回归保护**——token 比较写错、前缀判断被改、`allowAuthenticatedRemote` 分支被误动，测试都会全绿。

> 附带发现：`allowAuthenticatedRemote` 相关分支（`:66-70`）同样零覆盖；该分支在"非 `/v1/` 路径 + 无 Origin"时直接放行，是语义最微妙的一段。

---

### 🟡 P1 级

| # | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| **P1-1** | **fallback 不受 ramp 约束** | `buildFallbackWeekPlan` 签名（`weekly-plan-validate.ts:367-373`）无 `previousWeekDistanceKm`；`weekly-plan-service.ts:143-149` 直接调用，`args.previousWeekDistanceKm` 未传入（LLM 路径在 `:119` 传了） | 伤病复出后即使 LLM 不可用，回退模板也按用户长期目标满量排课，"上周+30%"防线在 fallback 路径缺失 | 与 P0-1 同源，一并修：fallback 产出后过 `validateWeeklyPlan` 或补传上周量 |
| **P1-2** | **iOS 编译级验证通道本机失效** | `bash apps/ios/tests/typecheck-ios.sh` → **EXIT=1 / 203 error**；首行 `sandbox-exec: sandbox_apply: Operation not permitted`；错误全为 `ObservationMacros.ObservableMacro ... malformed response`，集中在 `AppWebView.swift` / `HealthKitSync.swift` / `ServerSession.swift` 三个 `@Observable` 类；关闭沙箱重跑**结果相同** | **09-12 报告声称的"✅ typecheck-ios.sh 36 文件通过"在本机不可复现**，故本轮 iOS 改动（含新增 `WorkoutKitBridge.swift`、`WorkoutPlanMapper.swift`）目前**无编译级验证**，仅 `run-model-tests.sh`（纯逻辑）通过 | 非代码问题，勿改码；在装有 Pods 的机器或 CI（`ci.yml` 的 `ios` job 走 `pod install` + `xcodebuild`）上复跑确认 |
| **P1-3** | **契约对健康端点无强制力** | 服务端 `server.ts:564-576` 返回**匿名对象**、`:577-583` 同样；`HealthResponse` 定义在 `api-contracts/src/index.ts:91-100` | 字段名若漂移，服务端不报错、Web 端静默拿 `undefined` | 给两个 handler 标注返回类型；**注意当前形状是逐字段一致的（8/8），非现存缺陷** |
| **P1-4** | **测试盲区集合**（详见 §5） | 见下表 | 若干部位"看着有测试实则没验" | 按下表逐项补 |

---

### 🟡 P2 / 🔡 级

| # | 问题 | 证据 | 说明 |
|---|---|---|---|
| P2-1 | **鉴权测试用错路径** | `local-request-security.test.ts:18,55,95` 用 `/write`、`/read` | 与 P0-2 同源：改成 `/v1/write` 才会走 token 分支 |
| P2-2 | 设计资源入库 | `git ls-tree -r -l HEAD`：`technology-v1/01-today-body.png` **4.81MB**、`03-plan.png` 4.65MB 等 6 张；`.git` 55MB | 上轮 P2-3 **连续两轮未修**；建议 LFS 或移出 |
| P2-3 | `hasColumn(table)` 接受任意表名拼进 SQL | `prediction-recovery-read-repository.ts:34-37` `` PRAGMA table_info(${table}) `` | 当前**唯一调用点为硬编码常量** `:46`，**不可达**；属防御性缺陷 |
| P2-4 | clamped 告警文案与实际落库值偏差 | 实测：文案"已缩减至 **27.6**km"，最终落库 **27.30**km | `weekly-plan-validate.ts:354` 用循环内 `totalPlanned`，后续步骤仍会改动；差 0.3km，不影响判定 |
| P2-5 | XHR 缩进格式回归 | `apps/web/src/pages/DataModelPage.tsx:125,144` | `const request` / `request.open` 多缩进 2 空格（同类问题 09-12 已修过一处） |
| 🔡-1 | Windows-only / 环境跳过用例 | `import-sources.test.ts:401`、`worker.test.ts:101`、`prediction-model-service.test.ts:479`（junction 逃逸） | 路径别名安全、进程树取消、junction 逃逸在 Linux/mac **永久 skip，零覆盖** |
| 🔡-2 | 415 仅有 schema 声明 | `schemas.test.ts:46` `assert.ok("415" in ...)` | 声明 ≠ 行为测试（413/429/507 都测了，唯独 415 没测） |
| 🔡-3 | 随机端口 smoke | `production-runtime-smoke.mjs:12` `18787 + random()*1000` | 并发 CI 可能撞端口假失败 |

---

## 四、上轮（09-10）遗留项闭环核验

**结论：5 项 P1 全部真修复，且修复方式正确（不是掩盖）。**

| 上轮项 | 现状 | 证据 |
|---|---|---|
| **P1-1** `verdict.stale` 语义坍塌 | ✅ **已恢复** | `mobile-coach.ts:185` `const stale = input.recoveryEvidenceStatus === "stale" \|\| input.recoveryEvidenceDate !== input.today;`；`:283,303-307` 参与判定与 triggers；守卫 `server.ts:829,832` 恢复可达；测试 `mobile-coach.test.ts:109-113` 覆盖 3 种输入 |
| **P1-2** 后台同步死功能 | ✅ **已移除** | 全仓 grep `UIBackgroundModes` → 0 匹配；commit `4801c2e fix: restore stale-recovery guard and remove unusable background sync` |
| **P1-3** 边界扩张未确认 | ✅ 随 P1-2 一并消除 | 同上 |
| **P1-4** Keychain 明文回退 | ✅ **已删** | `Keychain.swift` 仅剩 `removeObject`（`:16,47,54`），**无任何读取回退** |
| **P1-5** 模型配置版本漂移 | ✅ **已对齐 v4** | `README.md:213`、`docs/DATABASE_DESIGN.md:6` 均为 `rai-model-config-v4`，与 `packages/scoring/src/model.ts:16` 一致 |
| **P2-2** 双 CI 并存 | ✅ **已收敛** | `.workflow/` 目录已不存在，仅 `.github/workflows/ci.yml`（ios / windows-runtime / verify 三 job） |
| **P2-1** `npm test` 并行 flaky | ✅ 本轮未复现 | commit `968afbf` 改临时端口 + 等待实际绑定 |

---

## 五、未提交改动独立复核（36 项）

> 方法论：**不复述** `deliverables/UNCOMMITTED_REVIEW_2026-09-12.md`，而是写探针独立复测其"已修复"声明。

### 5.1 声明为"已修复"的项——独立实测结果

**全部成立 ✅**，且证据是实测值而非代码阅读：

| 报告声明 | 我的独立实测 | 判定 |
|---|---|---|
| #1 LLM 路径 `distanceKm` 改由 `measureStructure` 反推 | 探针：LLM 自称 1 km、结构 6300m → **落库 7.8 km**（`clamped = []`） | ✅ 真修 |
| #2 30% ramp 接线 | 探针：上周 8 km / 目标 40 km → 上限 **27.30**（= max(8, 40×0.5)×1.3×1.05），实际落 **27.30**，有告警 | ✅ 真修 |
| 乐观锁（无 goals 快照时先取 revision） | `NativeAppModel.swift:507-515` 先 `api.goals()` 取 revision；`:531-537` 冲突时重新拉取并提示 | ✅ 真修 |
| 距离反推的**顺序**（先 clamp 后 measure） | `weekly-plan-validate.ts:267-276` clampIntervalReps → `:282-283` measure，注释解释了"先量后夹会高估" | ✅ 逻辑正确 |
| 冻结区零改动 | `git diff` 对 `App.tsx`/`styles.css`/`e2e` 为空 | ✅ |
| `uploadExport` 补 Bearer 头 | `DataModelPage.tsx:145-146` `readApiToken()` + `setRequestHeader("authorization", ...)` | ✅ |

**`rampCeiling` 的 `null` 陷阱已避开**：`:329-333` 用 `Number.POSITIVE_INFINITY` 而非 `null`——若写成 `null`，`Math.min(baseCeiling, null)` 会因 JS 强制转换变成 `Math.min(base, 0) = 0`，导致**无历史数据时全部课表被压到 0**。实现是对的，但这是该表达式唯一致命的分支，值得加一条测试锁住。

### 5.2 报告**未覆盖**的新发现

1. **🔴 P0-1（§3.1）**：报告 §三.1 曾建议"fallback 产出后过一遍同一套钳制（至少量上限）"；§七 的修复记录**未列此项**，实现也只做到"内部预算分摊"。我把它量化了：**不是"绕过校验"这么轻——是 3.6～5.8 倍超目标**，且触发条件是默认部署。
2. **🟡 P1-1**：`previousWeekDistanceKm` 只接到 LLM 路径（`weekly-plan-service.ts:119`），**fallback 路径没接**——同一文件内两个分支，一个有一个没有。
3. **路由登记复核**：`/v1/mobile/goals`（PUT）与 `/v1/mobile/workout-plan/generate`（POST）**都写 `mobile_goals` 表却都不持 mutation lock**（同在 `metadataOnlyMutationRoutes`，`server.ts:154-160`）。缓解在于 `writeControlGoals(stored, expectedRevision)` 有 revision 乐观锁（`mobile-goals.ts:263-284`）——**当前安全，但双写共用一张表却互不串行**这一点值得记一笔。

---

## 六、绿区（已核实无问题）

| 维度 | 结论 | 关键证据 |
|---|---|---|
| **依赖方向** | 单向、无环、无反向依赖 | 包依赖图 A→B 无环；底层包（storage/scoring/physiology）import 上层包 **0 处** |
| **纯评分核心** | 无平台依赖、无 IO | `packages/scoring` + `physiology` 仅 import `@rai/contracts`；`tsconfig.pure.json:8-16` 全量 include 且 `types: []` ⇒ **无文件逃逸** |
| **iOS 未越界** | 未重写评分核心 | `apps/ios/RAI` 全域无 CTL/ATL/TSB/TRIMP 公式（`exp/log/pow/ewma` 零命中）；命中项均为**展示层格式转换**（`NativeFormat.swift:17-38,175-183`） |
| **web 未越界** | 只依赖契约 | `apps/web/package.json:16` 仅 `@rai/api-contracts`；无 `@rai/application` 等实现依赖 |
| **坐标分层** | WGS-84 存储、仅渲染层转 GCJ-02 | `CoordinateConversion.swift:22` `nonisolated enum GCJ02`；`:29` 境外直通；DB/API 不转换 |
| **高德合规门控** | 先同意后初始化 | `MapPrivacy.swift`：`configureIfAgreed()` 守卫 `mapEnabled`，未同意不创建 `MAMapView`；Key 走 gitignored xcconfig |
| **SQL 注入** | 无用户输入拼接 | `database.ts:2110-2112` 的 `${table}`/`${key}` 由 `kind` 经**三元白名单**派生；其余全部 `?` 参数化或 `placeholders()` |
| **路由登记** | 写端点齐全 | `server.ts:154-166` 两集合；`/v1/mobile/workout-plan`（GET）明确不登记且注释说明理由（`:732-733`） |
| **周一自动生成** | 有启动兜底 | `server.ts:533-562` hourly tick + 启动后 60s 首跑 + `unref()` + `onClose` 清理 |
| **备份与迁移** | 零迁移 | 新存储走 `payload_json` blob，`weekPlanAudit` 无需 migration |
| **数据卫生** | `var/` 正确忽略 | `.gitignore:4` `var/`；`git ls-files var/` 为空；本机 3.4 GiB 不入库 |

---

## 七、行动建议（按优先级，附验收标准与回滚）

| 序 | 项 | 改动 | 验收标准 | 回滚 |
|---|---|---|---|---|
| 1 | **🔴 P0-1** | 在 `buildFallbackWeekPlan` 内：`budgetKm` 为 0 时（`qualityKm ≥ weeklyDistanceKm`）**先缩质量课时长/组数**再排 easy；`perEasyKm` 不得低于由剩余预算反推的值 | 新增测试：`weeklyDistanceKm ∈ {5, 8, 15}` ⇒ 7 天实测总量 ≤ 目标 ×1.05；`npm test` 全绿 | 单函数改动，`git checkout -- apps/api/src/weekly-plan-validate.ts` |
| 2 | **🔴 P0-2** | 在 `local-request-security.test.ts` 增加 `apiToken` 用例，路径用 **`/v1/...`** | 覆盖：正确 Bearer → 200；错误 token → 401 `unauthorized`；无 header → 401；`allowAuthenticatedRemote` + 受信 Origin → 放行 | 纯新增测试 |
| 3 | **🟡 P1-1** | `weekly-plan-service.ts:143-149` 传 `previousWeekDistanceKm` 进 fallback，或在 fallback 后过一遍 ramp 上限 | 上周 8 km / 目标 40 km / 无密钥 ⇒ fallback 总量 ≤ 27.3×1.05 | 恢复不传参 |
| 4 | **🟡 P1-3** | 给 `server.ts:564`、`:577` 标注 `HealthResponse` / `HandshakeResponse` 返回类型 | `npm run typecheck` 通过；契约与实现绑定 | 去掉注解 |
| 5 | **🟡 P2-2** | 6 张 design 图移出仓库或转 LFS | 单提交二进制 ≤ 1MB | 需历史重写，单独评估 |
| 6 | **🔡** | §3 P2 表 + 测试盲区（415 行为测试、`hasColumn` 白名单、缩进、文案） | 无行为变更 | 独立小改 |

**修正"注释即契约"的坏习惯**：P0-1 的根因是一条**写在注释里的错误承诺**（`:362-365`"cannot exceed the weekly goal"）。建议本次一并在 `buildFallbackWeekPlan` 补上可执行的断言式测试，让注释的说法有测试背书。

---

## 八、对辅助结论的反向复核（两处纠偏）

1. **"`HealthResponse` 全仓零引用" —— ❌ 误判。**
   实测 `grep -n "HealthResponse"` 命中 **7 处**：`apps/web/src/App.tsx:3,203`、`SettingsPage.tsx:8,254,256,304,306`。真实情况恰好相反——**客户端在用这个类型消费，服务端不用它约束返回**。问题从"契约无人用"降级为"契约对服务端无强制力"（即 P1-3），严重度下降一档。
2. **"本轮 iOS 改动已通过编译级验证" —— ⚠️ 不可复现。**
   09-12 报告的 `typecheck-ios.sh ✅` 在本机无法重现（EXIT=1，见 P1-2）。这是**环境限制**（`sandbox_apply: Operation not permitted` 拒绝 `swift-plugin-server`），不是代码回归；但结论必须是"**未验证**"而非"已通过"。

---

## 附：审查未覆盖的范围（如实声明）

- **真机 / 模拟器行为**：本机无 CocoaPods、`xcodebuild` 不可用，WorkoutKit 实际上表、AMap 底图渲染、HealthKit 同步均**未做运行时验证**。
- **浏览器 E2E**：本机无 Chrome/Edge，`test:e2e:web` 未执行；Web 侧结论来自 vitest（78 项）。
- **线上环境**：未接触 `tpandmr.xyz` 服务器与 `/etc/rai/rai.env`，运维链路按 `deploy/README-UBUNTU.md` 静态核对。
- **Python / ML 层**：`research/` 未审查（本轮范围聚焦 TS + iOS + Web 主链路）。

---

*报告时点：2026-09-12 21:00（Asia/Shanghai）｜基线 `8d74a24` + 36 项未提交改动*
*审查过程未修改任何业务代码、未触碰用户数据；探针脚本置于 `/tmp/rai-probe-*.ts`。*
