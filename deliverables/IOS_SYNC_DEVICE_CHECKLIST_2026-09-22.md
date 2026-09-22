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
| **A4** | 手机可达服务端 | `curl -s http://<host>:<port>/v1/runtime-status` → `issues: []` |

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

### V1 启动期装配 · T

| 项 | 内容 |
| --- | --- |
| 操作 | Xcode Run，控制台过滤 `[RAI]` |
| 期望 | 观察者注册**无** `errorAuthorizationDenied`；`pending BG tasks` 列出 identifier |
| 失败常见原因 | ① Profile 缺 `background-delivery`；② 注册发生在 `didFinishLaunching` 之后；③ identifier 重复注册（**系统会杀进程**） |

### V2 BGTask 被派发 · T + S

| 项 | 内容 |
| --- | --- |
| 操作 | 退后台 → Xcode Pause → 在 lldb 里执行：<br>`e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"app.rai.running.health-sync"]` |
| 期望 | **T**：BGTask 启动日志 + 阶段推进；**S**：出现 `POST /v1/imports/uploads` |
| 失败常见原因 | ① plist 缺 `processing`（`submit` 抛 `notPermitted`）；② 忘了在 `applicationDidEnterBackground` 重新 submit（请求是一次性的）；③ identifier 与 plist 不一致 |

### V3 系统收回额度 · L

| 项 | 内容 |
| --- | --- |
| 操作 | `_simulateExpirationForTaskWithIdentifier:` |
| 期望 | **L**：`phase` **不是 `cancelled`**，而是 `exported` / `uploading` / `importing` 之一；UI **不显示**"同步已取消" |
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
| 控制台 | 无 BGTask 启动日志；`pending BG tasks` 仍列出该 identifier | 有启动日志，但 phase 进 `failed`，或 upload 完成而 inspect/startImport 报错 |
| 服务端 nginx | 该时段**完全没有** `uploads` / `inspect` / `import-jobs` | 有请求但状态码异常（404 / 409 / 429 / 5xx） |
| 系统设置 | 与"后台 App 刷新开关 / 低电量 / 充电状态"相关 | 与设置无关，重启解锁后同样失败 |
| HealthKit 侧 | 连投递日志都没有 ⇒ 查 entitlement 与 `enableBackgroundDelivery` 返回码 | 有投递日志但被 `applicationState` 门控 return |
| background session 侧 | — | 启动时看 `getAllTasks` 的日志行。**有 task 说明系统确实把 session 重新挂起来了**（持久化成立的最强证据）；列表空但任务未完成 ⇒ 是逻辑删了文件或提前 `invalidateAndCancel` |

> ⚠️ **P2-4 之后最后一行的读法变了**：`getAllTasks` 的结果会进日志，但**动作是取消**
> （没人在等结局的一律取消、由这一轮重传）。所以"有 task"不再意味着"它会被接着跑完"，
> 而意味着**持久化本身成立**。

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
