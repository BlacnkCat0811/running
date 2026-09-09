# RAI 项目深度健康审查报告 · 2026-09-09

> 审查基线：本地 `main` = `origin/main` = `ff21730`（2026-09-09 12:04，工作树干净）。
> 对比范围：文档对齐点 `e3ee648` 之后 9 commits；上轮全仓审计 `PROJECT_HEALTH_AUDIT_2026-09-04`（`5c966ce`）之后 15 commits，主体为 iOS 原生应用。
> 方法：质量门禁实跑 + 双端（iOS/Web）后台代码审查 + 人工复核存储/API/安全/部署/数据卫生层。所有结论附 `文件:行号` 证据。

---

## 1. 总体结论（先行）

**健康度评级：B+（良好，无 P0，有 5 项 P1 待处理）**

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 质量门禁 | 🟢 绿 | typecheck / 449 单测 / 59 Web 测试 / e2e:web 全部通过 |
| 冻结区合规 | 🟢 绿 | `6c61a9a..HEAD` 对 App.tsx、styles.css、390px E2E 零改动 |
| 文档-代码一致 | 🟡 黄 | 契约常量整体对齐；`rai-model-config` 已升 v4，README/DATABASE_DESIGN 仍标 v3 |
| 存储/契约层 | 🟢 绿 | migrations v1–v18 与文档一致；FK 删除链自洽；shadow gate 完备 |
| iOS 原生 | 🟡 黄 | 边界合规、无评分重写、HealthKit 只读；token 回退/增量谓词/CI 三处 P2 |
| Web 前端 | 🟢 绿 | 双 UI 与文档吻合；发现 2 处口径/文档断点小瑕疵 |
| 安全/部署 | 🟢 绿 | Bearer 校验闭环、secret 扫描干净、Nginx 模板正确 |
| 数据卫生 | 🔴 红（债务） | `var/` 占 23 GiB：backups 16G + 已 replaced staging 5.4G 无回收 + 36 个垃圾 journal |

---

## 2. 分级问题清单

### 🔴 P0 —— 无

### 🟡 P1（建议近期处理）

| # | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| P1-1 | **`var/` 磁盘膨胀 23 GiB，含不可再生风险** | `var/backups` 11 份 16G（2026-07 遗留大文件为主）；`var/rai.importing.*.replaced.*` 3 个 5.4G（2026-07-20 导入 staging，rename-aside 发布后的 displaced 旧库）；backups 内 36 个 1KB `*.sqlite-journal` 垃圾 | 本地磁盘损耗；displaced staging 无对应 GC 机制，会持续累积；journal 碎片说明 v10/v11 时代的"迁移前备份"只留下空壳 | 审计**只列不删**。建议确认后：a) 归档/清理 3 个 replaced staging 与 36 个 journal 碎片；b) 检查 publish 流程对 displaced 文件的保留策略是否应改为"保留最近 1 份 + 迁移期后清理" |
| P1-2 | **模型配置版本漂移：code=v4，现状文档=v3** | `packages/scoring/src/model.ts:16` `MODEL_CONFIG_VERSION = "rai-model-config-v4"`；`docs/DATABASE_DESIGN.md:6` 与 `README.md:213` 仍写 `v3` | 文档读者会按 v3 参数假设行事；上轮记忆同样过期 | 同步 README/DATABASE_DESIGN 两处为 v4（dated 文档如 FIGMA_HIFI_SPEC 的 v2 引用属历史稿，不动） |
| P1-3 | **iOS token 明文回退** | `apps/ios/.../Keychain.swift:25`：Keychain 读取失败时回退读 `UserDefaults "rai.apiToken"` | token 可能随备份/迁移泄露 | 删除该回退路径（写入已 `removeObject`，读回退无存在必要） |
| P1-4 | **iOS 增量同步缺"重叠窗口补查"谓词（协议漂移）** | `docs/IOS_NATIVE_SYNC_PROTOCOL.md` 承诺 anchor+时间窗口重叠补查；`HealthKitExport.swift:222` 仅 `anchor==nil` 时叠加 startDate 谓词，增量路径忽略 `HealthKitSync.swift:298-302` 计算的 48h lowerBound | 重叠窗口内被编辑/回填的旧训练可能漏同步至下次全量 | 增量查询也叠加时间窗口谓词（跑步查询现只做 anchor+14 天路线回补） |
| P1-5 | **iOS ModelRegression 测试未接入 CI** | `apps/ios/tests/ModelRegression.swift`（122 行，覆盖 10 项 NativeAppModel 并发场景）仅 `run-model-tests.sh` 手动运行；`.workflow/master-ci.yml` 为 Gitee Go 草案（fd311ac 自注"草案"） | 回归保护缺失，仓库实际无 CI 门禁 | 接入任一 CI（Gitee Go 开通或 GitHub Actions），跑 typecheck+test+build+ModelRegression |

### 🟢 P2/P3（建议/轻微）

| # | 问题 | 证据 | 说明 |
|---|---|---|---|
| P2-1 | iOS `HKObserverQuery` 未在 `onDisappear` 停止 | `HealthKitSync.swift:80-103` 注册；`RootView.swift:28-31` 未停 | 仅前台触发、未见 enableBackgroundDelivery，但属后台交付机制残留，建议补 stopObserver() |
| P2-2 | iOS manifest `sampleTypes` 声明 5 类，实际导出约 15 类 | `HealthKitExport.swift:152` | 契约清单与实际不一致，影响服务端类型面判断 |
| P3-1 | Web 端时区口径不统一 | `apps/web/src/ios/shared.tsx:34/42/48` 用本地时区 + `toLocaleDateString`，`:53` 才显式 Asia/Shanghai | 契约承诺 Asia/Shanghai 本地日；用户设备时区非 +08:00（旅游/海外）时 iOS 壳日期显示偏移。建议统一走 `shanghaiDate` |
| P3-2 | 训练列表筛选天数与趋势页口径不一 | `WorkoutsPage.tsx:42` 为 `{"28","90","365"}`，`TrendsPage.tsx:19/21` 暴露 180 天 | 非契约破坏，体验口径不一致，建议补 180 |
| P3-3 | 断点描述冲突（文档层，非代码） | `docs/WEB_IMPLEMENTATION.md:35` 写"820px 以下底部导航"；`AGENTS.md` 冻结边界写 `<1024px`；实际 `styles.css:1050 @media (max-width:820px)` | 代码未越界（本次零改动），但两份文档断点描述不一致，建议统一措辞 |
| P3-4 | `removeWorkoutsBySyncIdentifiers` 用 `LIKE %id%` 匹配 | `packages/storage-sqlite/src/database.ts:2066-2069` | metadata_json/raw_attributes_json 上无索引全表扫 + `%`/`_` 未转义。HealthKit UUID 十六进制无特殊字符，当前无实际风险；量大可换 JSON 专用匹配或专用列 |
| P3-5 | 记忆层过期 | `.workbuddy/memory/MEMORY.md` 原记 goals 为 `mobile-goals.json` 文件持久化、模型配置 v3 | 已随本审查修正为控制库 + v4（见文末） |

---

## 3. 分维度详情

### A. 基线 / 仓库状态（🟢）

- 本地与 `origin/main` 一致（ff21730），工作树干净；`.git` 在 `/d/applerun/.git` 正常（`git -C` 路径解析异常是 Git Bash 行为，非仓库损坏）。
- 近 15 commits：iOS 原生同步（110aa9e/20d8f3a/f25bd9c/392fb18…）、pace 单位归一化（ff21730）、health records 动力学回读等，与 docs/IOS_NATIVE_* 文档节奏吻合。

### B. 质量门禁实跑（🟢，全部实测）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（pure + 全量双 tsconfig） | ✅ 通过 |
| `npm test`（包级 node:test） | ✅ 449 pass / 0 fail |
| `npm run test -w @rai/web`（vitest） | ✅ 59 pass / 0 fail（9 文件） |
| `npm run test:e2e:web`（含 build + Playwright） | ✅ 10 pass / 1 skip |

- 390px 冻结测试的 skip 为**设计行为**：`web-flows.test.ts:17-20` 按 `npm_lifecycle_event` 互斥（web 跑桌面块、responsive 跑 390 块），两脚本命令串虽相同但行为不同。
- 未经用户授权未运行 `test:e2e:responsive`（AGENTS.md 要求，冻结区零改动前提下不属默认验收）。

### C. 文档-代码一致性（🟡）

- **版本常量核对（通过）**：canonical-health-v2 ✅ / workout-feature-v3 ✅ / feature-config-v8 ✅ / training-load-config-v4 ✅ / training-zone-config-v3 ✅ / physiology `rai-physiology-v1.7.0` ✅ —— 全部与 `packages/contracts`、`packages/features`、`packages/physiology` 实际常量一致。
- **漂移（P1-2）**：`rai-model-config-v4`（model.ts:16）vs DATABASE_DESIGN.md:6 / README.md:213 的 v3。
- dated 文档分层正确：FIGMA_HIFI_SPEC（v2）、CATBOOST_*、MODEL_DISTRIBUTION_REPORT（v2）、WEB_COMPLETION_AUDIT 等均自注为历史稿/点位记录，未发现被误当现状改写的情况；MODEL_ACCURACY_MULTIAGENT_AUDIT_2026-09-07 已正确引用 v4（dated 审计，正常）。
- 架构关键声明与实际一致：移动端 goals 持久化在 `var/rai-control.sqlite`（mobile_goals/mobile_goals_history 实测存在，迁移标记 `.migration-complete` 已写）；backups 保留策略文档与 env 模板一致（生产 14 份/10GiB/1GiB，代码默认 10/20GiB/512MiB）。

### D. 存储 / API 契约层（🟢）

- migrations v1–v18（v11 占位无 SQL）与 DATABASE_DESIGN.md 完全对应；v17 睡眠/HRV canonical、v18 `model_validation_gates`（rai-shadow-gate-v1）落地。
- FK 删除链自洽：v2 起 `training_sessions.canonical_workout_id` 为 `ON DELETE SET NULL`（database.ts:207），workout 删除路径（含 iOS 删除同步 `removeWorkoutsBySyncIdentifiers`）不会因 RESTRICT 失败；group 经 membership 级联清理。
- API 路由面：58 个唯一 `/v1/*` 路径前缀、约 66 方法组合，与 WEB_IMPLEMENTATION 清单及记忆吻合。
- 激活门禁：`SqliteModelRunRepository.activateSucceeded()` 统一执行，失败 gate 不替换 incumbent（单测 389-390 覆盖）。
- 预测恢复读数重构（prediction-data.ts → `SqlitePredictionRecoveryReadRepository`）改用 canonical 睡眠/HRV 事实并按 Asia/Shanghai 日窗口，替代 raw records 中位数，方向正确（单测 392-395 覆盖含"未来完成排除"）。

### E. iOS 原生（🟡，边界合规）

- ✅ 默认走 SwiftUI 原生（RootView.swift:51-53），WKWebView 仅非 iOS 回退；Swift 侧**无任何** CA/TA/恢复/负荷评分重算（NativeAppModel 仅拉取+缓存）——符合 AGENTS.md 与架构决策。
- ✅ HealthKit 纯只读（`toShare:[]`）、release 强制 https（ServerSession.swift:71-73）、Keychain `AfterFirstUnlockThisDeviceOnly`、同步幂等（X-RAI-Sync-Batch=SHA256(zip)、3 次退避重试、4xx 除 429 不重试）、删除走 manifest.deletedSourceIds → 服务端 removeWorkouts。
- ✅ ff21730 pace/日期修复核对通过：18 处 nativePace 全部 `/km`；nativeDay `prefix(10)` 修正 `.000Z` 误显（纯显示层）。
- 🟡 P1-3 token 回退、P1-4 增量重叠窗口谓词缺失、P1-5 测试未入 CI；P2-1 observer 未停；P2-2 manifest 类型清单不符。

### F. Web 前端 / 冻结区（🟢）

- ✅ **冻结区零越界**：`6c61a9a..HEAD` 对 `App.tsx`（mobileNavigation 行 101-107 / mobile-nav-links 行 180）、`styles.css`（.mobile-nav-links 行 59/1065、.workout-mobile-list 行 245/1135）、390px `responsiveTest`（行 1109）均无改动；e2e 桌面块改动仅为等待/幂等加固。
- ✅ 双 UI 启用与路由与文档一致（main.tsx:9-19、ios/App.tsx:109-119）；`latestDataDate` 服务端锚定 MAX(local_date)，页面用它判断陈旧而非墙钟。
- ✅ 页面-API 抽查（Dashboard/Trends/iOS mobile 四端点）与契约一致；ios-pixel.css 删 3 行均为 text-shadow 视觉属性，无引用残留。
- 🟡 P3-1 时区口径、P3-2 180 天筛选缺失、P3-3 断点描述冲突。

### G. 安全 / 部署（🟢）

- `local-request-security.ts`：配置 token 后 `/v1/*` 一律要求精确 `Bearer`（401），未授权 POST/PUT/PATCH/DELETE 无 Origin 即 403；allowAuthenticatedRemote 模式校验 trustedOrigins。逻辑闭环。
- `deploy/nginx-rai.conf` 与线上拓扑一致：托管 dist、仅 `/v1/` 反代 127.0.0.1:8787、**透传客户端 Bearer、不注入、无 auth_basic**（WKWebView 无法处理 Basic Auth）；`rai.env.example` 备份参数与 README 一致。
- secret 扫描：全仓提交文件（排除 lockfile）未发现 Bearer/API key/已知 token 泄漏；.gitignore 覆盖 var/、*.sqlite*、output/、.workbuddy/。
- 注意（非代码缺陷）：记忆提及生产 token 强度弱可轮换，仍待处理。

### H. 数据卫生（🔴 债务，只列不删）

| 路径 | 占用 | 说明 |
|---|---|---|
| `var/backups/*.sqlite` | 16 GiB / 11 份 | 主为 2026-07-17/18 迁移前与 web-import 前备份（1.46G/份）；2026-09-04 before-v17 1 份 |
| `var/rai.importing.*.replaced.*` | ~5.4 GiB / 3 份 | 2026-07-20 导入发布时的 displaced 旧库（rename-aside 保留），无回收机制 |
| `var/rai.sqlite` | 1.9 GiB | 主库（含 WAL） |
| `var/backups/*.sqlite-journal` | 36 × 1KB | 垃圾碎片（v10/v11 迁移期备份空壳，无对应 .sqlite） |
| `var/rq-sync` | 15 MiB | 旧运行时目录，未在文档出现 |
| **合计** | **~23 GiB** | |

处置需要你显式确认后我再执行（涉及备份与历史数据，不属于自动清理范围）。

---

## 4. 行动建议（附验收标准）

1. **（P1-1）磁盘处置**：确认后执行——归档 `replaced.*` 至冷存储或删除；清理 36 个 journal 碎片；确认本地备份保留策略（默认 10 份/20GiB）。验收：`var/` ≤ 8 GiB；备份目录仅含完整 .sqlite。
2. **（P1-2）文档同步**：README.md:213 与 DATABASE_DESIGN.md:6 改 `rai-model-config-v4`。验收：全仓 grep 现状文档不再有 v3 引用（dated 文档除外）。
3. **（P1-3）Keychain 回退删除**。验收：`rai.apiToken` 读路径全仓唯一（仅 Keychain）。
4. **（P1-4）增量重叠窗口谓词**：HealthKitExport 增量查询叠加 lowerBound 窗口。验收：真机/单元验证编辑 48h 内旧训练可被下次增量捕获。
5. **（P1-5）CI 接线**：Gitee Go（草案已备于 .workflow/master-ci.yml）或 GitHub Actions 接入 typecheck+test+build+e2e:web+ModelRegression。验收：main 推送即跑且红灯拦合。
6. 顺手项：P2-1 stopObserver、P2-2 manifest 清单对齐、P3-1~P3-3 口径统一。

## 5. 已核实绿区（对照既往关切）

- iOS 未重写 TS 评分核心、HealthKit 无写入/无后台 delivery、无 Watch/macOS 独立产品 ✅
- 冻结响应式区零改动 ✅
- 预测模型训练/激活/取消与跑力模型激活互斥（激活清理 active prediction model）✅
- 备份恢复走 staging + quick_check + 外键校验 + 原子改名，读闸门保护 ✅
- 恢复趋势 API 固定 Asia/Shanghai 且返回 asOf/latestDataDate/timezone 三件套 ✅

---

*本报告为 2026-09-09 时点快照；审计过程未修改任何业务代码与用户数据。随附：`.workbuddy/memory/MEMORY.md` 已修正 goals 持久化（rai-control.sqlite）与模型配置版本（v4）两项过期记录。*
