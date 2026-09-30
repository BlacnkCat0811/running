# RAI 多智能体优化建议（2026-09-12，只建议不动码）

四路并行审查：后端/数据链路、iOS、Web 前端、测试与工程化。每条带证据，可逐项复核。

## 一、总览（结论先行）

| 维度 | 🔴 高 | 🟡 中 | 最值得先做的一件事 |
|---|---|---|---|
| 后端/数据 | 4 | 5 | P0-2 用 `identity_key` 列低成本修复 |
| iOS | 2 | 5 | `withRetry` 吞掉 CancellationError（两行改动） |
| Web | 3 | 5 | `useRemote` 加缓存去重 + 轮询后台暂停 |
| 工程化 | 3 | 5 | 落地 Gitee Go CI 门禁 + 部署脚本化 |

---

## 二、后端 / 数据链路

### 🔴 高优先
1. **`workout_routes.workout_id` 无索引**——规范化时相关子查询全表扫描。`canonicalize.ts:187`、`workout-read-repository.ts:154/159/214-219`。建议：`CREATE INDEX ... ON workout_routes(workout_id, point_count)`。
2. **`workout_group_members` 缺 `(workout_id)` 索引**——增量回溯按 workout_id 查成员全表扫描。`database.ts:217-223`、`canonicalize.ts:244-249`。
3. **P0-2 低成本修复路径**：不动 `workouts.id`，新增 `identity_key` 列（= 不含 sourceName 的 stableId：activityType+startAt+endAt），迁移回填后 canonicalize 先按 identity_key 精确分组，时间窗启发式仅兜底。证据：`apple-health-parser.ts:191-199`、`canonicalize.ts:73-100`。
4. **错误码丢失**：`ImportSourceNotFoundError` 只有 statusCode 没有 code，降级为通用 `request_error`。`import-sources.ts:53-59`、`api-error.ts:17-21`。建议：4xx 错误类强制携带 `code`。

### 🟡 中优先
5. 增量规范化闭环是 O(迭代×全量×已选) 三重扫描（`canonicalize.ts:251-270`）→ 按 start_at 排序 + 窗口剪枝。
6. 列表分页每页重跑 5 表 JOIN 的 COUNT（`workout-read-repository.ts:177-190`）→ 缓存 count 或 keyset 分页。
7. GET 端点无 Cache-Control/ETag（`server.ts:588-596`）→ 派生只读数据加短 TTL 头。
8. 重算 worker 重试上限 1 秒，持续失败近每秒重试（`worker.ts:146-147`）→ 放宽到 30-60s。
9. 会话匹配 O(组数×全量) 线性过滤（`canonicalize.ts:368-372`）→ 排序后二分。

### 🟢 低优先
10. `normalizeRelativePath(target).toLowerCase()` 双重小写冗余（`gpx-parser.ts:206`）。
11. `localDateTimeAt` ±16h 每 15 分钟暴力解 DST（`utils.ts:54-60`），可先估偏移再微调。
12. `/v1/health` 恒 200，恢复态可改 503 让探活方区分（`server.ts:566-578`）。

**正面确认**：staging 库 + 删除护栏、指纹幂等、tombstone 迁移 v19/v20 均完整；全库走 SQLite 读库，无 DuckDB 依赖（仅文档提及），分工无需调整。

---

## 三、iOS

### 🔴 高优先
1. **`withRetry` 吞掉 CancellationError**——取消被当可重试错误，退避后再试一次。`HealthKitSync.swift:610-614`。两行改动：先 `catch is CancellationError { throw }`。
2. **取消检查形同虚设**——同步开头 `try? Task.checkCancellation()` 丢弃错误。`HealthKitSync.swift:151`。改 `try`。

### 🟡 中优先
3. **皮肤泄漏**：共享图表 `NativeHeartRateChart` 硬编码白字/青曲线/深蓝底，科技皮肤引用中（`TechViews.swift:1373`），像素皮肤复用即穿帮。`NativeHeartRateChart.swift:11,18,26,33,75` → 颜色改由 AppSkin 注入。
4. **首页刷新串行**：refreshAll 四请求依次 await，`refreshBodyMetrics`（:336-339）已有 `async let` 示范可照搬。`NativeAppModel.swift:146-168`。
5. **上传重试窗口过长**：600s 超时 × 3 次重试 ≈ 30 分钟阻塞。`HealthKitSync.swift:479,351-353` → 上传仅重试一次。
6. **测试盲区**：`CacheStore` prune/scoping、SyncTaskState 断点续传、`StoredZip` 无回归，剥 `#if os(iOS)` 后可补进 run-model-tests.sh。
7. **错误粒度丢失**：APIClient 一切传输层错误映射 `.unavailable`（`APIClient.swift:226-228`）→ 透传 `URLError.code` 细分文案。

### 🟢 低优先
8. 缓存无 TTL：`loadCachedData` 不校验 cachedAt（`NativeAppModel.swift:574-591`）。
9. `saveGoals` 成功后 refreshAll 重复拉 goals（`NativeAppModel.swift:397-412`）。
10. `waitForJob` 把取消计入 idleFailures 重连计数（`HealthKitSync.swift:563-569`）。
11. `CacheStore.write` 忽略 sqlite3_step 返回码（`CacheStore.swift:80-83`）。

**正面确认**：WGS-84 只在渲染层转换、AMap key 不明文、上传失败 ZIP 持久化恢复链路，均符合约束。

---

## 四、Web 前端

### 🔴 高优先
1. **双 DOM 全量渲染**：桌面与移动列表同时渲染仅靠 `display:none` 隐藏，翻页时移动端节点白建。`WorkoutTable.tsx:17,32`、`styles.css:248`。
2. **后台标签页持续轮询**：`GlobalTaskStatus` 每 1.5-7s 拉 `/v1/runtime-status`，不查 `document.visibilityState`。`GlobalTaskStatus.tsx:25-85`。
3. **useEffect 依赖对象每帧重建**：依赖 `sanitizedParams`（每次渲染新对象）。`WorkoutsPage.tsx:82-85` → 改 `searchParams.toString()`。

### 🟡 中优先
4. Dashboard 最近训练无空态，与 WorkoutsPage 的 EmptyBlock 不一致（`DashboardPage.tsx:184`）。
5. `App()` 在 hooks 之前条件早退，违反 hooks 顺序规则，靠 main.tsx 分流兜底（`App.tsx:195-202`）→ 拆两个顶层组件。
6. ErrorBoundary 用 `window.location.href` 强刷丢 SPA 状态（`ErrorBoundary.tsx:34`）→ `<Navigate to="/">`。
7. `useRemote` 无缓存/去重，页面来回导航全量重请求（`hooks.ts:5-85`）→ stale-while-revalidate。
8. 改查询参数时 backgroundRefresh=false 清空旧数据闪白屏，各页不统一（`TrendsPage.tsx:32` vs `TrainingZonesPage.tsx:262`）。

### 双皮肤泄漏 🟡
9. 图表颜色全硬编码 hex 绕过 CSS 变量：`DashboardPerformanceChart.tsx:94,98,134`、`RoutePlot.tsx:109-116`、`StatisticsPage.tsx:94,135`。
10. `PixelDot` 组件名 + `#fffef8` 奶油底色硬编码（`DashboardPerformanceChart.tsx:60,73`）→ 读主题变量。

### 🟢 低优先
11. EmptyBlock 缺 `role="status"`；移动列表对读屏重复暴露数据（`Feedback.tsx:30-32`、`WorkoutTable.tsx:31`）。
12. health 请求无超时，API 挂起时首屏永远卡"正在检查本地数据库"（`App.tsx:203`）→ AbortSignal.timeout。

**正面确认**：useRemote 统一数据获取、路由懒加载、skip-link 均规范。

---

## 五、测试与工程化

### 🔴 高优先
1. **vitest 超时根因**：`apps/web/vitest.config.ts` 仅 7 行，未配 `fileParallelism`/`maxWorkers`，12 个文件并发拉满即超时。→ 加 `fileParallelism: false` 或 `--max-workers=2`。CI Windows/verify job 同样会复现。
2. **实际无生效 CI 门禁**：部署源是 Gitee（`deploy/README-UBUNTU.md:31`），`.workflow/master-ci.yml` 自述"草案、需手动开通"；`.github/workflows/ci.yml` 代码不在 GitHub 等于空转。→ 优先落地 master-ci.yml。
3. **发布全手动**：升级流程纯手敲（`deploy/README-UBUNTU.md:105-113`）→ 写 `deploy/upgrade.sh`（含 smoke:api + 回滚）。

### 🟡 中优先
4. 无 lint 门禁（无 eslint/prettier 配置，CI 仅 typecheck）。
5. 死脚本：`test:e2e:responsive` 与 `test:e2e:web` 逐字相同，区分实际靠环境变量 skip（`web-flows.test.ts:20-27`）。
6. 测试缺口：`session-structure.ts`、`weekly-plan-prompt.ts`（apps/api）无任何测试引用；packages/api-contracts 无测试。
7. 双轨测试（node:test + vitest）：**建议维持现状**——node:test 稳定、web 组件测试强依赖 jsdom，仅统一断言/夹具风格。

### 🟢 低优先
8. 依赖健康：yazl/yauzl 有真实使用，overrides 有据，无冗余依赖，无需处理。

**更正一条旧认知**：根 `package.json` 的 "test" 已用 `;` + 状态合并，node:test 失败**不会**再跳过 vitest——MEMORY 里"任一失败即短路"已过时，可更新。

---

## 六、建议执行顺序（如果要做）

1. **半天级**：iOS 两处取消 bug（#三.1/2）+ vitest 并发配置（#五.1）+ 两个索引（#二.1/2）。
2. **一天级**：identity_key 列修 P0-2（含迁移回填 + 测试）+ Gitee Go 门禁落地。
3. **按需排期**：useRemote 缓存、图表主题变量化、皮肤注入 NativeHeartRateChart、部署脚本化。
