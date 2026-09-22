# 同步「未找到导入来源」死锁定性（2026-09-22）

> 现象：`--database-is-staging` 回滚已生效，iOS 仍报「未找到导入来源」，点同步无效。
> 结论：**这是第二个、独立于本次改动的既有缺陷**——服务端把失败任务的来源记录永久删除，
> 而 iOS 的恢复分支在收到 404 时**不清除持久化任务**，于是永远从同一入口重试、永远不重传。

---

## 1. 取证链（全部只读，未改任何代码）

| 事实 | 证据 |
| --- | --- |
| 客户端是 **iOS App**，不是 Web 页面 | nginx access log：UA `RAI/1 CFNetwork/3896.100.1.2.1 Darwin/27.0.0`，来源 IP `183.6.122.28` |
| Web 页面不可能是这条循环 | `apps/web/src/pages/DataModelPage.tsx:555-561` 的 `inspect` 只在**选文件 / 上传后**调用一次，没有轮询 |
| 08:57:57 那次是**唯一一次**上传 | `POST /v1/imports/uploads` 200 → `POST /v1/import-jobs` 202 → 轮询 job `web_import_mubyt7ir_5a27cc64-…` → 08:58:04 变 `failed` |
| 此后**再没有出现过任何 uploads** | `grep 'imports/uploads\|import-jobs' /var/log/nginx/access.log` 只有上面那 6 条 |
| 客户端在反复重试 `inspect` 且恒 404 | 08:58:25 / 08:58:39–40 / 08:59:03 / 09:21:25–36（7 次）/ 09:23:22，全部 `404 35` |
| 失败任务的来源记录**已被永久删除** | `/var/lib/rai/var/runtime.sqlite`：最新 job `source_id = upload_6e6149eb-…`、`status = failed`、`message = 导入失败，原始导出文件未被修改`；该 id 在 `import_sources` 里 **`COUNT(*) = 0`**；`import_sources` 最新一条停在 **2026-09-21T15:18:41Z**（= 09-21 23:18 那次成功导入） |
| 服务已恢复、与回滚前等价 | `git diff 49f393f HEAD -- 'apps/*/src' 'packages/*/src'` = **0 行**；线上 `active` / `NRestarts=0` / `issues: []` |

---

## 2. 机理：两侧各一半，缺一不成环

| 侧 | 位置 | 行为 |
| --- | --- | --- |
| **服务端** | `apps/api/src/import-source-finalization.ts:35-39` | 任务**失败**时 `if (succeeded && isHealthKitUploadSource(...))` 为假 ⇒ 走 else ⇒ `cleanupUpload` ⇒ `state.deleteSource(id)`：**来源记录被永久删除**（`import-sources.ts:469-480`） |
| **iOS** | `apps/ios/RAI/HealthKitSync.swift:174-224` | 恢复分支 `if !full, let task = loadTask(), let sourceId = task.sourceId` 先 `inspect`；404 在 `:217-223` 只设 `phase = "failed"` 后 **`return`，不清 task** |
| **触发器** | `apps/ios/RAI/RootView.swift:22` | 每次 HealthKit observer 变化都 `syncIfNeeded(…, force: true)`；`force` 绕过 `HealthKitSync.swift:74-77` 的 15 min 间隔，且失败时 `markSuccess` 不执行 ⇒ `lastAutoSyncKey` **永不更新** ⇒ App 只要在前台就持续 404 |

**⇒ 不可自愈**：App 永远先走恢复分支，永远不重传；服务端那条记录再也回不来。

---

## 3. 出路

### 🟢 立即解锁（用户侧，当场可用，无需改代码）

设置 → **健康数据** → **「重新导入全部」**
（`apps/web/src/ios/Settings.tsx:122-129`，`postNative({action:"syncHealth", full:true})`）

- `full` 为真 ⇒ `HealthKitSync.swift` 的 `:174` / `:249` / `:345` 三个恢复分支**全被跳过** ⇒ 全新导出 + 上传。
- 成功后 `clearTask()` ⇒ **死锁状态被清除**，后续增量同步恢复正常。
- 代价：**全量重传 + `--replace` 全量导入**（最重的一条路，预期数分钟）。

### ✅ 代码修复（**2026-09-22 已实施并验证**）

改了四处：

| 文件 | 改动 |
| --- | --- |
| `apps/ios/RAI/HealthSyncCancellation.swift` | 新增纯判据 `HealthSyncResumePolicy`：`404`（暂存上传已消失）或 `code == "import_job_failed"`（任务已终结）⇒ `abandonTask`；其余 ⇒ `keepTask` 保留 task |
| `apps/ios/RAI/HealthKitSync.swift`（恢复分支 catch，`:217-247`） | `keepTask` ⇒ 照旧报错返回；`abandonTask` ⇒ `clearTask()`。**终结的任务** ⇒ 报出真实错误后返回（不在同一次点击里偷偷再跑一遍导入）；**404** ⇒ 不 `return`，**落到常规增量路径**，当场重新导出 + 上传 |
| `apps/ios/RAI/HealthKitSync.swift`（`waitForJob`，`:734-737`） | 终结态抛错时附上 `code = HealthSyncResumePolicy.terminalJobCode`，让恢复分支能把"任务已终结"与"瞬时读不到"分开 |
| `apps/ios/tests/HealthSyncResumeRegression.swift` + `run-health-sync-tests.sh` | 新增回归可执行（4 组用例），已挂进 `npm run test:ios` |

- **为什么 404 直接落到常规路径**：`lastExportEnd` 水位线未动 ⇒ 只会重导窗口内的小包、走**增量**导入；
  且 `clearTask()` 之后 `loadTask()` 已是 nil，中间那两个恢复分支会自己跳过，不会重复进入。
- **验收判据**：下载后 404 只出现一次，随后必须出现 `uploads 200 → inspect 200 → import-jobs 202`。
- **已跑的证据**：

  | 检查 | 结果 |
  | --- | --- |
  | `npm run test:ios`（类型检查 44 文件 + 全部纯逻辑回归） | **EXIT=0**，`iOS 门禁通过`；两条 health sync 回归均 passed |
  | `npm run typecheck`（TS 全仓） | **EXIT=0** |
  | **突变验证**：把 `disposition` 改成恒 `return .keepTask`（= 复现旧行为） | `MUTANT EXIT=132`，红在正确那句：`a 404 from inspect must abandon the task — the staging upload is gone for good` |
  | 还原后 | `RESTORED EXIT=0`，恢复为绿 |
- **回滚**：纯客户端分支 + 一个纯函数，`git revert` 即回到今天之前的行为；无服务端/数据副作用。
- ⚠️ **要生效必须先构建安装到手机**：`xcrun devicectl list devices` 当前 `unavailable`、
  `IPHONEOS_DEPLOYMENT_TARGET = 17.0`。在装机之前，「重新导入全部」仍是唯一的解锁手段。

---

## 4. 归属（用 `git blame`，不用时间线邻近）

```
$ git blame -L 174,224 --date=short apps/ios/RAI/HealthKitSync.swift
cd8d2662 (tp 2026-09-07) 174  if !full, let task = loadTask(), …
cd8d2662 (tp 2026-09-07) 217  } catch {
cd8d2662 (tp 2026-09-07) 222      return
```

⇒ 该分支自 **2026-09-07** 起就如此，**先于 2026-09-21/22 的全部改动**。
`--database-is-staging` **不是它的原因**，只是第一次让导入失败、从而第一次把它**引爆**。

🔴 **教训**：一个**只在失败路径上才走到**的缺陷，会被任何一次新的失败引爆。
排查时该问的是「**这条路以前被走到过吗**」，而不是「这是不是我改的」。

---

## 5. 顺带产出

- **代码修复**：`apps/ios/RAI/HealthSyncCancellation.swift`、`apps/ios/RAI/HealthKitSync.swift`、
  新增 `apps/ios/tests/HealthSyncResumeRegression.swift`（并挂进 `run-health-sync-tests.sh` / `npm run test:ios`）。
- 新 skill 章节：`rai-live-diagnosis` §1.5「同步失败 / 未找到导入来源」排查
  （含 UA 分辨法、journal 请求序列还原、`runtime.sqlite` 三表查法）。
- 分册：`.workbuddy/memory/NOTES-ios.md`「同步恢复死锁」。
- ⚠️ 手机 `xcrun devicectl list devices` 当前为 `unavailable`，
  `IPHONEOS_DEPLOYMENT_TARGET = 17.0` ⇒ 上述 iOS 修复需小唐**自己重新构建安装**才生效。
