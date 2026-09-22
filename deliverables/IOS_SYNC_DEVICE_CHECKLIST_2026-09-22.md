# RAI iOS 后台同步 —— 真机验收清单

日期：2026-09-22 ｜ 对应改动：P0（止血）+ P1（原子单元）+ P2（三机制后台同步）
代码状态：**已落地，尚未 `git commit`**（工作区 25 个 M + 13 个 ??）

> 🔴 **这是唯一终审。** 本机静态门禁（135 条结构判据 + 47 条突变，全绿）只证明**代码调了哪个方法**，
> 证不了**iOS 真的把这些机制调度起来了**。后者只有真机能回答 —— 系统派发是平台行为，不是代码属性。

---

## 0. 先看这一节：你需要回传什么

其余的都可以不填，但下面这四项缺一项，验收就无法闭环。

| # | 回传内容 | 取自 |
| --- | --- | --- |
| **R1** | V1–V12 的**逐条结果**（通过 / 未通过 / 未触发）+ 每次的 `phase` 轨迹 | Xcode 控制台过滤 `[RAI]` |
| **R2** | 服务端那段时间的 `uploads` / `inspect` / `import-jobs` 请求列表（含状态码与 `X-RAI-Sync-Batch` 头） | nginx access log |
| **R3** | V11 / V12 里出现的 `reattached system uploads: …` 那一行原文 | 控制台 |
| **R4** | 任何 `failed` 状态的完整报错原文（不要只说"失败了"） | 控制台 |

**最省事的取证方式**：开好 Xcode 控制台后，用一个终端跑下面这条，全程不用切窗口。

```bash
# 控制台（Xcode）
#   Product → Scheme → Edit Scheme → Run → Arguments → Environment Variables
#   加一条：OS_ACTIVITY_MODE = disable   ← 只为压掉系统噪声，[RAI] 不受影响

# 服务端（在服务器上）—— 路径按你的实际 nginx 配置（本仓线上配置未显式设 access_log）
ssh <你的服务器> 'sudo tail -f /var/log/nginx/access.log' | grep -E 'uploads|inspect|import-jobs'
# 拿不到 access log 就退一步看 API 日志：
ssh <你的服务器> 'sudo journalctl -u rai-api -f'
```

---

## 1. 前置条件（A1–A4，不做完后面全白测）

| # | 事项 | 检查方式 |
| --- | --- | --- |
| **A1** | Apple Developer 后台为 App ID `app.rai.running.debug` 打开 **HealthKit** 与 **HealthKit Background Delivery** | `security cms -D -i <built>.app/embedded.mobileprovision \| plutil -p - \| grep -i background-delivery` |
| **A2** | 真机被 Xcode 认到 | `xcrun devicectl list devices` |
| **A3** | iPhone → 设置 → 通用 → **后台 App 刷新 = 开**；**低电量模式 = 关** | 否则 BGTask **永不调度**（V2/V5 会全灭） |
| **A4** | 手机可达服务端 | `curl -s https://<host>/v1/data-summary` → `issues: []`<br>⚠️ 2026-09-22 修正：原来写的是 `/v1/runtime-status` → `issues: []`，**错的**。`runtime-status` 顶层只有 `databaseReady / busy / recomputeJob / importJob / taskAdmission / predictionModelJob`，**没有 `issues`**；`issues` 在 `data-summary`（`apps/api/src/data.ts:1228`）。按旧写法查会拿到 `undefined`，看着像"没有 issues"，其实根本没读到。 |

> ⚠️ A1 最容易漏。少了 `background-delivery`，`enableBackgroundDelivery` 会抛 `errorAuthorizationDenied`，
> 表现为 **V5 完全无反应**，而且以前会被 `try?` 吞掉 —— 现在会记错误码（见 V5 的失败原因①）。

---

## 2. 构建期检查（装真机前）

```bash
bash apps/ios/tests/run-ios-gates.sh          # 期望 EXIT=0 + "iOS 门禁通过"
cd apps/ios && pod install

xcodebuild -workspace apps/ios/RAI.xcworkspace -scheme RAI -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath /tmp/rai-device build

plutil -p /tmp/rai-device/Build/Products/Debug-iphoneos/RAI.app/Info.plist \
  | grep -A3 -E 'UIBackgroundModes|BGTaskSchedulerPermittedIdentifiers'

codesign -d --entitlements :- /tmp/rai-device/Build/Products/Debug-iphoneos/RAI.app
```

**期望**

- `UIBackgroundModes` ⊇ `{healthkit, processing}`
- `BGTaskSchedulerPermittedIdentifiers` ⊇ `app.rai.running.health-sync`
- entitlements ⊇ `{com.apple.developer.healthkit, ...background-delivery}`

> 🔴 若 `UIBackgroundModes` 里**没有** `processing`，不要去改 pbxproj 的 `INFOPLIST_KEY_*` ——
> 那两个键必须写进**源文件** `RAI/Info.plist`，pbxproj 会被 `pod install` 重写（门禁 §9j 已钉住这一点）。
> 若这里看不到键，说明打包时不是从源文件读的，先查 `pod install` 有没有中途改动工程文件。

---

## 3. 逐条验收

记号：**T** = 机制被调度的证据 ｜ **L** = 逻辑正确的证据 ｜ **S** = 服务端对账

**建议执行顺序**（按"出结论的效率"排，不是按编号）：

| 轮次 | 条目 | 耗时 | 为什么排这里 |
| --- | --- | --- | --- |
| **1** | **V1 → V2 → V3** | ~5 min | 一条 lldb 命令就能定性"系统到底会不会派发"，**信息量最大**；三者共用同一次 Xcode 连接 |
| **2** | **V4** | ~1 min | 只需"点同步 + 立刻切走"，顺手就做 |
| **3** | **V9** | ~2 min | 全量重传，验证 `full: true` 跳过三个恢复分支 |
| **4** | **V5** | **≥30 min × 3 次** | 唯一需要"等"的一项。建议**并行于日常**：戴上表正常生活，隔几小时看一次 |
| **5** | **V6 → V7** | ~5 min + 15 min 等待 | 需要 Xcode Stop / 锁屏 |
| **6** | **V11 → V12** | ~30 min | P2-4 专属：锁屏 25 min + 上滑强杀 |
| — | **V8** | ~2 min | 需要先删服务端的一条来源（**让小满配合执行**） |
| — | **V10** | ~1 min | 反例，只需记一笔 |

⚠️ **全程让 Xcode 与真机保持连接**：控制台的 `[RAI]` 日志、lldb 的 `_simulate…` 命令都依赖它。
断开重连后 `pending BG tasks` 仍可读，但**已经错过的派发事件不会补发**。

🔴 **做第 1 轮之前先确认 A3**（设置 → 通用 → 后台 App 刷新 = 开、低电量模式 = 关）——
这两项没开，V2 会直接失败，而失败现象与"plist 缺 processing"、"identifier 不一致"**长得一模一样**，
会白耗一轮排查。同样先确认 **A1**（Provisioning Profile 含 `background-delivery`），
否则 V5 会完全无反应。

### V1 启动期装配 · T

| 项 | 内容 |
| --- | --- |
| 操作 | Xcode Run，控制台过滤 `[RAI]` |
| 期望 | 控制台出现 `[RAI] BGTaskScheduler.register ok for app.rai.running.health-sync`；观察者注册**没有** `enableBackgroundDelivery failed` |
| 失败常见原因 | ① Profile 缺 `background-delivery` ⇒ 打 `enableBackgroundDelivery failed … errorAuthorizationDenied`；② 注册发生在 `didFinishLaunching` 之后；③ identifier 与 `Info.plist` 不一致 ⇒ 打 `register returned false`；④ 重复注册（**系统会杀进程**） |

> ⚠️ **2026-09-22 修正**：原先写的判据是"`pending BG tasks` 列出 identifier" —— **看不到了**，
> 代码里没有这个观察面（`BGTaskScheduler` 没有公开的 pending 列表 API，我们也没打）。
> 现在改看 `register ok` 这一行：它是**本轮新补的**（此前成功路径完全静默）。

### V2 BGTask 被派发 · T + S

| 项 | 内容 |
| --- | --- |
| 操作 | 退后台 → Xcode Pause → 在 lldb 里执行：<br>`e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"app.rai.running.health-sync"]` |
| 期望 | **T**：控制台出现 `[RAI] BGProcessingTask launched (app.rai.running.health-sync)`，紧跟着 `[RAI] background pass: action=…`；**S**：出现 `POST /v1/imports/uploads`（或 `inspect` —— 若盘上已有可复用的来源） |
| 失败常见原因 | ① plist 缺 `processing`（`submit` 抛 `notPermitted`）；② 忘了在 `applicationDidEnterBackground` 重新 submit（请求是一次性的）；③ identifier 与 plist 不一致 |

### V3 系统收回额度 · L

| 项 | 内容 |
| --- | --- |
| 操作 | `_simulateExpirationForTaskWithIdentifier:` |
| 期望 | **L**：控制台出现 `[RAI] BGProcessingTask expiration fired`，并且 `phase` **不是 `cancelled`**（应为 `exported` / `uploading` / `importing` 之一）；UI **不显示**"同步已取消" |
| 失败常见原因 | ① expiration handler 还走旧的 `cancelSync()`；② `finishCancelled()` 无条件写 `cancelled`；③ `checkCancellation` 仍以 phase 判定 |

> 这条是 P0 的核心：**系统决定**（收额度）与**用户意图**（点了取消）以前都写 `phase = "cancelled"`，
> 于是下次同步会把系统决定当用户意图 ⇒ **永久卡死**，同时 UI 会告诉用户"同步已取消"而他没点过。

### V4 点同步后立刻切走 · L + S

| 项 | 内容 |
| --- | --- |
| 操作 | 点「同步健康数据」→ 立刻切到别的 App 停 10 s → 回来 |
| 期望 | **L**：无"同步已取消"；**S**：只有**一次** `uploads` |
| 失败常见原因 | ① `RAIApp` 仍在 cancel；② 30 s 额度不够且 `exported` 未落盘；③ 导出产物被 `onCancelledResult` 删掉 |

### V5 HealthKit 后台投递 · T + S

| 项 | 内容 |
| --- | --- |
| 操作 | 制造 3–5 次健康数据变化（手表记一次短跑，或健康 App 手加一条），**每次**退后台锁屏 30 min |
| 期望 | **T**：投递唤醒 + BGTask 启动；**S**：新的 `uploads` 与 `import-jobs` |
| 失败常见原因 | ① `enableBackgroundDelivery` 抛错被吞；② `completion()` 未调，**3 次后被停投递**（现象：**只成功过第一次**）；③ 后台 App 刷新被关 / 低电量模式 |

### V6 上传中 Stop → 重开 · L + S

| 项 | 内容 |
| --- | --- |
| 操作 | `phase = uploading` 时 Xcode **Stop**（**不要**上滑强杀）→ 重开 App |
| 期望 | **L**：从持久化 multipart 续传，**不重读 HealthKit**；**S**：第二次 `uploads` 且 `X-RAI-Sync-Batch` **与第一次相同** ⇒ 命中幂等、`sourceId` 不变 |
| 失败常见原因 | ① multipart 仍在 `/tmp` 且已删；② `isCurrentTask` 因 `datasetEpoch` 变化判定为非当前任务；③ 重传时 batchId 变了导致建成第二份 source |

> ⚠️ **修正常见原因**：方案原文写的"② 未持久化 `uploadTaskId` ⇒ 恢复时不会重挂" **已作废** ——
> `uploadTaskId` 最终**没有写入点**，判据改成问"本进程还在不在等这条上传的结局"。这条不会以那个形式失败。
> 真正的风险换成了"**两份字节同时在传**"，判据见 V11。

### V7 导入中退后台 15 min · L

| 项 | 内容 |
| --- | --- |
| 操作 | `phase = importing` 时退后台锁屏 15 min → 打开 |
| 期望 | **L**：按 `jobId` 续接并显示结果；**不产生第二次 `uploads`** |
| 失败常见原因 | ① `waitForJob` 后台未提前收手；② `clearTask` 被误调；③ `jobId` 未持久化 |

### V8 服务端来源被删 · L + S

| 项 | 内容 |
| --- | --- |
| 操作 | 在服务端 `delete from import_sources where id='<id>'`，然后点同步 |
| 期望 | **L**：`inspect` 404 **只出现一次**，随后必须 `uploads 200 → inspect 200 → import-jobs 202` |
| 失败常见原因 | ① 恢复策略退回 `keepTask`；② `clearTask()` 失败但没报错；③ 重传时 batchId 变了导致建成第二份 source |

> 这是 2026-09-22 那个**恢复死锁**的验收判据：服务端的 404 不清掉 iOS 的持久化任务 ⇒ 每次同步都在 inspect 一个
> 永远不存在的来源。判据是"404 之后**必须**自己重传"，而不是"404 之后没崩"。

### V9 重新导入全部（`full: true`） · L + S

| 项 | 内容 |
| --- | --- |
| 操作 | 点「重新导入全部」 |
| 期望 | **L**：跳过三个恢复分支，全量重传；**S**：`uploads` 仅一次、body 明显更大 |
| 失败常见原因 | ① `full` 被条件短路；② 超 4 GiB / 磁盘预算不足；③ 全量包撞 600 s 超时 |

### V10 反例：应用切换器上滑强杀 · 记录

| 项 | 内容 |
| --- | --- |
| 操作 | 同步中在应用切换器**上滑强杀** |
| 期望 | **不会**后台续传，直到用户下次手动打开 |
| 说明 | **这不是缺陷。** 若这里"恢复了"，反而要查是否被误判成 V6 |

### V11 生命周期中止后的重入 · L + S（P2-4 专属）

| 项 | 内容 |
| --- | --- |
| 操作 | 点同步 → 等到 `phase = uploading` → 退后台 → 锁屏 25 min → 回到 App，然后**再点一次同步** |
| 期望 | **L**：第二次同步从盘上 multipart 续传；nginx 上**同一 batchId 只出现一次活跃 `uploads`**，且**没有** `import_upload_busy`（**429**）；若第一次传输已跑完 ⇒ 命中幂等、`sourceId` 与第一次相同 |
| 失败常见原因 | ① `reconcileSystemUploads` 没被调用（它应该在「推导下一步」**之前**）；② 判据用了"谁在搬字节"而不是"**谁在等结局**" ⇒ 中止后重进会变成**两份同时在传**；③ `handleEnterBackground` 拿不到真实值，落进了 `stopResumable` |

### V12 强杀后系统重挂 session · T + L（P2-4 专属）

| 项 | 内容 |
| --- | --- |
| 操作 | `phase = uploading` 时从应用切换器**上滑强杀** → 重开 App（别等太久） |
| 期望 | **L**：控制台出现 `reattached system uploads: …` 一行（系统按 identifier 重挂了 session = 持久化成立）；随后那一批以自己的 batchId 重传 |
| 失败常见原因 | ① 一行都没有 ⇒ 系统没重挂（查 `uploadSessionIdentifier` 与 `UIBackgroundModes`）；② `cancelled … from other batches` 恒 > 0 而 `for the current batch` 恒 0 ⇒ `persistZip` 的字节一致性可疑（服务端幂等会失手，多出一份来源）；③ `foundAny == false` 而 nginx 有 `uploads` ⇒ 事件被别的路径接走了 |

**V12 那一行的读法**

```
reattached system uploads: kept <n> awaited, cancelled <m> for the current batch, <k> from other batches
```

| 数字 | 含义 |
| --- | --- |
| `<n> > 0` | 这个进程自己还在等它 ⇒ **保留**（正常） |
| `<m> > 0` | 系统重挂了**当前这批**字节，但本进程没在等 ⇒ 取消、本轮重传；重传会命中服务端幂等、`sourceId` 不变 |
| `<k> > 0` | 其它批次留下的孤儿 ⇒ 取消；服务端会多出一份**没人来取**的来源（24h TTL 自动回收） |
| 三者全 0 | 系统**没有**重挂任何任务 → 查 session identifier 与 `UIBackgroundModes` |

---

## 4. 怎么区分「系统根本没调度」与「逻辑失败」

| 判据 | 系统没调度 | 逻辑失败 |
| --- | --- | --- |
| 控制台 | **没有** `[RAI] BGProcessingTask launched` 这一行 | **有** `launched` 这一行，但 phase 进 `failed`，或 upload 完成而 inspect/startImport 报错 |
| 服务端 nginx | 该时段**完全没有** `uploads` / `inspect` / `import-jobs` | 有请求但状态码异常（404 / 409 / 429 / 5xx） |
| 系统设置 | 与"后台 App 刷新开关 / 低电量 / 充电状态"相关 | 与设置无关，重启解锁后同样失败 |
| HealthKit 侧 | 连投递日志都没有 ⇒ 查 entitlement 与 `enableBackgroundDelivery` 返回码 | 有投递日志但被 `applicationState` 门控 return |
| background session 侧 | — | 启动时看 `getAllTasks` 的日志行。**有 task 说明系统确实把 session 重新挂起来了**（持久化成立的最强证据）；列表空但任务未完成 ⇒ 是逻辑删了文件或提前 `invalidateAndCancel` |

> ⚠️ **P2-4 之后最后一行的读法变了**：`getAllTasks` 的结果会进日志，但**动作是取消**
> （没人在等结局的一律取消、由这一轮重传）。所以"有 task"不再意味着"它会被接着跑完"，
> 而意味着**持久化本身成立**。

### 判据载体：现在能在 `[RAI]` 里看到的行（2026-09-22 补）

此前**成功路径完全静默**，只有失败才打日志。后果是 V2/V3 一旦失败就**无法归因** ——
"系统没派发"与"派发了但这一轮什么都没做"在服务端看都是"没有请求"（上表因此形同虚设）。
本轮补了 4 行，现在完整清单是：

| 日志行 | 出现时机 | 服务于 |
| --- | --- | --- |
| `BGTaskScheduler.register ok for app.rai.running.health-sync` | 启动 `didFinishLaunching` | **V1** |
| `BGTaskScheduler.submit ok (delay=Ns)` | 切后台（`delay=0`）/ 后台收工重排（`delay=900`） | 判断"一次性请求"有没有被重排 |
| `BGProcessingTask launched (…)` | **系统真的把 BGTask 派发下来时** | **V2**、V5 |
| `BGProcessingTask expiration fired` | **系统收走额度时** | **V3** |
| `background pass: action=…` | 后台一轮做出决策后 | 区分"没被派发"与"派发了但空转"（活锁的唯一入口） |
| `reattached system uploads: kept … cancelled …` | 启动时盘点系统任务 | **V12** |

🔴 **这 6 行就是判据本身**，所以它们自己也有守卫：`check-background-capabilities.py` 第 11 节
（138 条判据里的最后 3 条）会在任何一行消失时立刻变红，并有一条突变验证这条守卫**真的会红**
（`assertion_hit=True`）。没有这层守卫的话，删掉一行日志 ⇒ 门禁/类型检查/回归全绿，
而那条真机验收静默变回不可判。

---

## 5. 已知的、有意接受的一处行为

**生命周期中止（约 30 s 额度耗尽 / 退后台）发生在传输途中时，那次上传的结局会被丢弃，
下一次同步会把整批字节重传一遍**（幂等，不会在服务端多出来源）。

- 真机上这是**常见路径**而非罕见路径：`beginBackgroundTask` 约 30 秒，而全量导出可以是几个 GB。
- 消掉它需要一条新的持久化不变式（把孤儿结局写回 `sync_tasks`），收益只是省一次带宽
  ⇒ 按"为微小收益放宽既有不变量就是作废该方案"的纪律**先不做**。
- **V11 就是用来量它的**：请顺便记一下这个现象出现的频率与那次的重传体积。

---

## 6. 结果回传模板

```
环境：iPhone 型号 / iOS 版本 / App 构建号
A1-A4：逐项通过？
构建期：UIBackgroundModes = ? ；BGTaskSchedulerPermittedIdentifiers = ? ；entitlements = ?

V1  [通过/未通过/未触发]  phase 轨迹：_____  证据：_____
V2  ...
V3  ...
V4  ...
V5  ...
V6  ...
V7  ...
V8  ...
V9  ...
V10 ...
V11 ...
V12 [通过/未通过]  reattached 那一行原文：_____
     顺便：重传现象出现了 ___ 次 / 占 ___ 次同步

失败项的完整报错原文：
_____
```

---

## 7. 本轮代码验收实况（本机，2026-09-22）

给你一个"交到你手上时代码是什么状态"的基准线，便于判断真机问题是否来自代码本身。

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 + 纯逻辑回归 | `bash apps/ios/tests/run-ios-gates.sh` | **EXIT=0**（2m48s）｜类型检查 **51** 个文件｜结构门禁 **135 checks, 0 failed**｜store 回归 **42**｜展示 **52** |
| 突变验证（全量） | `npm run test:ios:mutation` | **47 mutations, 0 failed**；负向对照正确分类为编译错；`restored: exit=0 GREEN`；每条都被它自己那条断言抓住 |
| TS 侧 | `npm run typecheck` | EXIT=0 |
| 突变残留 | `var/mutation-backup/` vs 源码 | 逐文件一致，`IN-PROGRESS` 标记不存在 |

**这些数字能证明什么、不能证明什么**

- ✅ 能证明：每条判据都**会因为对应的错而被抓住**（突变验证的核心结论）；结构判据覆盖了计划要求的每一条。
- ❌ 不能证明：iOS **真的会调度** BGTask / 后台投递；也不能证明 `BGProcessingTask` 在真机上的续期额度够用。
  这两件事**只能由你这次的真机结果回答**。

---

## 8. 真机实测进度（滚动更新）

### 2026-09-22 21:26–21:29 · 用户主动点同步 ×4

**结论：全链路成功，零失败。但只覆盖"用户主动同步"这一条路径，后台调度尚未验证。**

| 判据 | 实测值 |
| --- | --- |
| 客户端 | UA `RAI/1 CFNetwork/3896.100.1.2.1 Darwin/27.0.0` ⇒ **iOS 真机**（不是 Web 页面） |
| 同步时间 | 21:26:54 / 21:27:14 / 21:27:22 / **21:29:53**（北京时间，共 4 次） |
| 请求链（每次） | `POST /v1/imports/uploads 200` → `POST /v1/imports/inspect 200` → `POST /v1/import-jobs 202` → `GET /v1/import-jobs/<id>` 轮询到终态 `200` |
| job 结果 | 4 条全 `succeeded`，`message: "导入与模型重算完成"` |
| 数据变化 | `healthRecords` 122571 → **122580**（+9）；`workouts` 276 不变 |
| 引擎 | `{name: "rust", fallback: "typescript", version: "0.1.0"}` ⇒ Rust 生效 |
| 写路径不变量 | `GET /v1/data-summary` → **`issues: []`** |
| iOS 侧状态 | `freshness.state: "valid"`、`recoveryDate: "2026-09-22"`（= 今天）、`lastSyncedAt: 21:30:11` |
| 最后一次耗时 | 33.0 s（`backup` 5.0 / `parseImport` 11.6 / `recompute` 12.3 / `stagingCopy` 1.5 / `activation` 1.3） |

**这条证据能证明什么**

- ✅ **P1 原子单元在真机上走通了**：`upload → inspect → startImport` 三步在同一次请求序列内完成、中间没有中断重来（正是 D1 决策要求的行为）。
- ✅ A4 前置条件成立（手机可达服务端）；服务端导入链与 Rust 引擎在线；写路径不变量无告警。
- ✅ iOS 端解析服务端响应正常（`freshness` 拿到 `valid`，说明客户端没把数据状态读错）。

**这条证据不能证明什么**

- ❌ **不能证明后台调度**。这 4 次是**主动点同步**触发的（三次挤在 2 分钟内、第四次隔 2.5 分钟，符合"刚装完在试"），请求发起时 App 在前台。
  ⇒ **V2（BGTask 被派发）与 V5（HealthKit 后台投递唤醒）仍未被验证**。
- ❌ **不能证明 V6 / V11 / V12**（进程被杀、生命周期中止后的重挂与续传）—— 需要 Xcode Stop / 上滑强杀 / 锁屏 25 min 这类操作。
- ❌ 不能证明"两份字节同时在传"没发生。判据是**同一 batchId 出现两次并发 `uploads`** 或 `import_upload_busy`(429)；
  ⚠️ nginx 默认**不记** `X-RAI-Sync-Batch` 头，要看这个得查 `import_sources.idempotency_key`。

> 4 次都是**完整链路**（每次都带 `uploads`）⇒ 走的都是"全新导出 + 上传"，**不是恢复分支**。
> 恢复分支要等 V6/V8 那类"中途被打断"的场景才会出现。
