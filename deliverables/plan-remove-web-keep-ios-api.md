# 移除 Web 与 macOS 壳、收敛为「原生 iOS + 云 API」· 可执行实施文档

> **状态：待产品授权执行。** 本文件是执行手册，不是验收记录，也不代表已批准。
> 仓库当前把 Web 定义为受支持产品（[AGENTS.md](../AGENTS.md) §Supported Product），未取得明确授权前不得按本文改动代码。
>
> | 项 | 值 |
> |---|---|
> | 版本 | v2 · 2026-10-17（重写并取代 v1 草案；v1 见 `git show 9a1e2c8:deliverables/plan-remove-web-keep-ios-api.md`） |
> | 证据基线 | `main` @ `9a1e2c8`，工作树干净；文中所有 `文件:行号` 均为该提交实测 |
> | 合并来源 | v1 草案 + [WEB_DESKTOP_REMOVAL_PLAN_2026-10-15.md](WEB_DESKTOP_REMOVAL_PLAN_2026-10-15.md)（两份均未执行、未获授权） |
> | 适用仓库 | `/Users/tp/running`（npm workspaces：`packages/*` + `apps/*`） |
> | 生命周期 | 执行完成后按 [本目录约定](README.md) 归档或删除 |
>
> **行号保鲜**：开工前先跑附录 C 的「核对命令」；若源码已变动，以实测行号为准再改。

---

## 0. 先读这段（执行纪律）

1. **授权门禁**：D0 未完成前，B1–B7 一律不得开工。授权的最小形式是产品负责人在本文档签注，或在本轮 PR 描述里写明「批准移除 Web/macOS，按本文执行」。
2. **批次独立**：每个批次一个 PR/一组提交，独立验收、独立回滚。**跨批次合并的唯一理由是编译/测试在中间态必红**（见 §4.3 的「必须同批」清单）。
3. **先切行为 → 再解耦 → 再删除 → 最后收尾**：顺序不可交换（尤其 B2 必须先于 B3，见 §4.2）。
4. **不越界**：不裁剪算法包、不改数据库 schema/迁移、不改 iOS 业务链、不回写历史时点产物（`deliverables/` 既有快照、`output/`、`.archify/`）。
5. **证据留存**：每个批次完成时，把验收命令的实际输出（`exit code` + 关键行）贴进 PR 描述；云端变更另存 `nginx -t`、`systemctl status`、`curl` 输出。
6. **跳过 ≠ 通过**：`npm run test:ios` 在无 Xcode 的机器上打印「本次没有检查任何 iOS 源码」并 `exit 0`。在 Windows/无 Xcode 环境收口的批次（B4）必须标注「未在 macOS 上验证」，不能写成「iOS 门禁全绿」。

---

## 1. 目标与范围

### 1.1 目标形态

```
┌────────────────────────┐
│ iPhone · SwiftUI 原生   │  HealthKit 只读 → 打包 ZIP / direct-sync 批次
│ apps/ios（唯一客户端）  │  Bearer Token（Keychain，按 server 分账户）
└───────────┬────────────┘
            │ HTTPS /v1/*
┌───────────▼────────────┐
│ Nginx（云服务器 443）    │  只反代 /v1；根路径与其他路径 404；不托管静态文件
└───────────┬────────────┘
            │ 127.0.0.1:8787
┌───────────▼────────────┐
│ rai-api（Fastify）      │  全部 /v1 端点保留；无 Web 静态托管
└───────────┬────────────┘
            │
┌───────────▼───────────────────────────────────────────────┐
│ SQLite（stdio 主库 + 读副本）· 16 个 TS 包 · Rust 执行器 · ML 研究 │
└───────────────────────────────────────────────────────────┘
```

### 1.2 保留物（一个都不删）

| 保留 | 说明 | 证据 |
|---|---|---|
| `apps/ios` | SwiftUI 原生 iOS App（移除 macOS destination 与 WKWebView 壳后成为唯一客户端） | `RootView.swift:47-48`；pbxproj `:376/:430` |
| `apps/api` | Fastify API，**全部 83 条 `/v1` 路由保留**（含 36 条仅 Web 在用；见 D2） | `apps/api/src/server.ts` |
| `packages/*`（16 个） | 全部被 API 或包间引用；Web 侧只 import `@rai/api-contracts` | 附录 A.4 |
| `crates/` + Rust 工具链 | 生产导入执行器 | `npm run rust:build/verify` |
| `research/` | Python 训练脚本（`npm run ml:*`） | — |
| `scripts/`、`deploy/` | 门禁与部署链（按 B2/B3 改造后保留） | — |

### 1.3 移除物

| 移除 | 规模/证据 |
|---|---|
| `apps/web/` 整个 workspace | **92 个跟踪文件**：`src` 59（含 `src/ios/*` 11 个 WKWebView 壳 JS）、`test` 25、`e2e` 1（`web-flows.test.ts` 1973 行）、`public` 2、根配置 4、`scripts/check-bundle.mjs` 1 |
| `apps/ios` 的 macOS destination 与 WKWebView 壳 | pbxproj `SUPPORTED_PLATFORMS` 含 `macosx`（`:376/:430`）；`AppWebView.swift` 588 行；`RootView.swift:49-70` 的 `#else` 分支 |
| Web 专用构建/依赖/门禁 | `react`/`vite`/`vitest`/`jsdom`/`playwright-core`/`concurrently`；根 `build`、`test:e2e:*`、`dev:web` 等脚本；CI 两步 |
| Web 专用文档 | `docs/WEB.md`（34 行）及 `README.md:69` 入口 |

### 1.4 明确不做

- **不裁剪后端端点**（默认）：36 条仅 Web 在用的端点全部保留，裁剪必须走 D2 单独授权 + B7。
- **不改** `packages/*` 的算法/模型代码（scoring、prediction-inference、model-eval 等一字不动）。
- **不改**数据库 schema / 迁移（`packages/storage-sqlite` 零改动）。
- **不动**历史时点产物：`deliverables/` 既有快照、`output/`、`.archify/`（按仓库纪律，时点快照不回写）。
- **不改** iOS 原生业务链（HealthKit 同步、教练、计划、训练计划状态）；唯一例外是 B1 的**连接开发流**与 B4 的 macOS 分支删除。
- **不**顺手重写文档历史证据：`docs/PROJECT_REVIEW.md`（2026-09-30 时点快照）正文不改，只在顶部加时间边界（B5）。

### 1.5 「桌面端」的定义（采用旧方案已定口径）

仓库**不存在**独立桌面端产品（无 Electron/Tauri）。「桌面端」= ① Web 的桌面浏览器形态（随 `apps/web` 移除）；② **iOS 工程的 macOS 平台支持 + WKWebView 壳**（B4 移除）。Web 内部的移动皮肤（`apps/web/src/ios/*` 与 `dataset.shell='ios'` 分发）只是 Web 的一个分支，随 `apps/web` 一起消失。

> AGENTS.md 目前写作「The former WKWebView shell remains only as a development fallback」——**与代码不符**：iOS 分支从不加载 WKWebView（`RootView.swift:47-48` → `NativeRootView`），`AppWebView.swift` 是双平台遗留壳、iOS 侧为死代码。B0 必须把这句话改掉。

### 1.6 完成定义（DoD）

- [ ] `apps/web` 目录、`docs/WEB.md`、`check-web-build.mjs`、Web 专用脚本与依赖全部消失，`grep` 无悬挂引用。
- [ ] 干净克隆上：`npm ci` → `npm run typecheck` → `npm test` → `npm run test:ios`（macOS）→ `npm run check:docs` → `npm run check:doc-refs` → `npm run check:acceptance-matrix` → `npm run rust:verify` → `npm run smoke:api` 全绿。
- [ ] CI 四个 job 全绿，且 `.github/workflows/ci.yml` 与 `.workflow/master-ci.yml` 不含 Web 构建/浏览器 E2E。
- [ ] 云端：`curl https://<domain>/v1/health` 返回 `status:"ok"`；`curl https://<domain>/` 返回 **404**（来自 nginx）。
- [ ] 真机：连接 → HealthKit 同步（`POST /v1/imports/uploads` → `POST /v1/imports/inspect` → `POST /v1/import-jobs` → `GET /v1/import-jobs/{id}`）端到端完成，回执 `committed`；读路径（今日/训练/趋势/统计/分享卡/成绩摘要）全部可用。
- [ ] macOS destination 不再出现在 Xcode scheme 中；`xcodebuild -sdk iphonesimulator` 构建通过。

---

## 2. 开工前决策（D0–D9）

| 编号 | 问题 | **默认（推荐）** | 替代 | 影响 |
|---|---|---|---|---|
| D0 | 是否已获产品授权、AGENTS.md 口径是否改写 | **必须完成**：书面授权 + 改 AGENTS.md | 无（不做不得开工） | 全部批次 |
| D1 | macOS destination + WKWebView 壳 | **移除**（B4） | 保留 → 必须保留 Web 构建产物，本计划不成立 | B4 全部 |
| D2 | 36 条仅 Web 在用的端点 | **保留**（不裁剪） | 裁剪 → 追加 B7，且需补测试/schema 联动 | API 面 |
| D3 | 恢复通道 `POST /v1/backups/:name/restore`（唯一入口原为 Web 设置页） | **保留端点 + 运维 curl runbook**（B5） | 接受消失 | 运维能力 |
| D4 | 成绩录入 `performance-entries`/`label-funnel`、隐私区 `privacy-zones` | **保留端点；iOS 无入口列入后续**（§11） | 列入 iOS 排期 | 预测标签、分享卡裁剪 |
| D5 | 匿名只读 `RAI_PUBLIC_HOSTS` / CORS 开发源 | **代码保留、默认继续关闭**；`RAI_WEB_PORT`/`RAI_ALLOW_LAN_DEV` 在 B3.5 清理 | 随 B3 一起删 CORS | 安全姿态 |
| D6 | ICP 备案 / 域名根路径 | **根路径 404**（纯 API 站点） | 保留最小静态页 → nginx 多一个 `location /` | 备案合规 |
| D7 | 唯一浏览器级 E2E（`web-flows` 1973 行）的补偿 | **迁移 4 类后端语义用例到 API 级 `node --test`**（§11.1） | 全部转人工 | 回归覆盖 |
| D8 | 发布窗口与顺序 | **维护窗口内 B2 → B3**，iOS 随 B1 单独发版 | — | 线上可用性 |
| D9 | `dev:device` 入口去留 | **保留并改写为「纯 API 局域网调试」**（B1） | 删除脚本 + 同步 3 处文档 | 开发体验 |

### D0：授权与仓库口径（阻塞项）

- 需要产品负责人明确一句：「批准移除 Web 与 macOS 构建，保留原生 iOS + API」。
- 同批改 [AGENTS.md](../AGENTS.md)：重写 §Supported Product；**删除** `## Supported Web Viewport`（:26-46）与 `## Frozen Responsive Areas`（:48-61）两整节；`## Default Verification`（:62-73）删掉 `npm run build` / `test:e2e:web` / `test:e2e:responsive`。
- 把 §1.5 的「桌面端」定义写进 AGENTS.md，避免下一个 agent 又按「Web 是受支持产品」维护。

### D1：macOS target（默认移除）

理由：① iOS 生产路径早已是 `NativeRootView`；② 保留 macOS 就必须继续构建 `apps/web/dist`（`AppWebView` 加载的是 Web 页面），与本计划前提直接冲突；③ pbxproj 用 `PBXFileSystemSynchronizedRootGroup`（`:24-33`），删文件无需改编译列表，改动面可控。

若选「保留」：**停止执行本计划**，退回「仅移除 Web 的浏览器形态 + 保留 macOS 壳」的另一套方案（不在本文范围）。

### D2：仅 Web 在用的端点（默认保留）

旧方案 §1.3 已定「不裁剪任何后端端点」；v1 草案主张删 4 条，其中 `/v1/performance` **连 Web 都不调用**（运维遥测端点，`server.ts:969-972`），「Web 专用」不成立。**默认全保留**：删除后端端点不属于「移除 Web」的必要条件，且 `data.ts:1908-1917` 的分享卡裁剪依赖已存 privacy zones —— 删写入口会让 iOS 分享卡永远显示「未配置隐私区」。

若产品决定裁剪：只裁剪 `privacy-zones`、`performance-entries`、`label-funnel` 三组，且必须走 B7（含测试/schema/openapi 联动，见 B7）。

### D3：恢复通道

`POST /v1/backups/:name/restore` 是运维事故恢复的最后一道线（`docs/OPERATIONS.md:93` 明确「恢复能力必须保留」）。Web 设置页消失后，默认改为 **运维 runbook + curl 流程**（B5 写入 `docs/OPERATIONS.md`），端点保留。

### D5：CORS / 匿名只读

事实：iOS 原生请求**不发 Origin**，CORS 对它无意义；`RAI_PUBLIC_HOSTS` 匿名读是「浏览器打开即看」的姿态（`server.ts:162-172`、`local-request-security.ts:173-177`）。默认：**代码保留、环境变量保持为空**（等于关闭），仅在 B3.5 清理 `RAI_WEB_PORT`/`RAI_ALLOW_LAN_DEV` 与 CORS 注册。`local-request-security.test.ts` 显式传参，无需改。

### D4 / D6 / D7 / D8 / D9：默认值与落地位置

| 编号 | 默认 | 落地 | 备注 |
|---|---|---|---|
| D4 | 保留 `performance-entries`/`label-funnel`/`privacy-zones` 端点，iOS 入口列入后续 | 不动代码；列入 §11.2 | 删端点不在「移除 Web」的必要条件内 |
| D6 | 根路径 404（纯 API 站点） | B2 的 nginx（`location / { return 404; }`） | 若备案要求最小页：额外 `root /var/www/rai + index.html`，其余规则不变 |
| D7 | 迁移 4 类后端语义用例到 API 级 | §11.1；可在 B3 之后单独排期 | 不阻塞 B3–B6 |
| D8 | 维护窗口内 B2 → B3 | §6 runbook | iOS 发版（B1/B4）与云端变更解耦 |
| D9 | 保留 `dev:device`，改写为纯 API 调试 | B1.1 | 不改名，避免动 `docs/IOS_NATIVE_RUNBOOK.md:54`、`apps/ios/README.md:14` 的入口名 |

---

## 3. 现状事实（证据基线 `9a1e2c8`）

### 3.1 运行时与组件

| 组件 | 事实 | 证据 |
|---|---|---|
| API 监听 | 默认 `127.0.0.1:8787`（`RAI_API_HOST`/`RAI_API_PORT` 可覆盖） | `apps/api/src/server.ts:134-135`、`:2089` |
| Web 静态托管 | `server.ts:12` import + `:452-455` `existsSync(webDist)` 守卫后 `registerWebAssets` | 同上；`web-assets.ts` 36 行 |
| 上传上限 | ZIP 端点 `RAI_IMPORT_MAX_ZIP_BYTES` 默认 **64 MiB**；multipart `fileSize` 同值 | `server.ts:140`、`:236`；`deploy/rai.env.example:11` |
| direct-sync 解析上界 | XML 8 MiB、records 5000、route 文件 200、route 字节 64 MiB；manifest 也占 8 MiB | `direct-sync-ingest.ts:64,65,76,77` |
| iOS 实际可发体积 | 预算 = 上界 × 0.9；`DirectSyncBatchBudgetTests.swift:40,44` 断言 `7_549_747` / `60_397_977` | `DirectSyncBatchBudget.swift:43-61` |
| 鉴权 | `RAI_API_TOKEN`；云上**必须设置**（否则 nginx 转发的 Host 不是 loopback ⇒ 403） | `local-request-security.ts:145-152,180-189` |
| `RAI_ALLOW_REMOTE_TOKEN_AUTH` | iOS **不需要**；该 flag 只收紧「带 token 的浏览器 Origin 校验」，无 Origin 的请求两条分支都放行 | `local-request-security.ts:166-171` |
| health 响应 | `status/databaseReady/localOnly/serverId/athleteId/datasetEpoch/syncProtocolVersion/now`；`localOnly` 由 `RAI_DEPLOYMENT_MODE!=="cloud"` 决定 | `server.ts:925-937` |

> ⚠️ 更正 v1 的说法：**不存在「72 MiB = XML 8 + routes 64」这个常量**。8/64 是服务端解析上界，manifest 另占 8 MiB；真正约束一批上传的是 **64 MiB ZIP 端点上限**。

### 3.2 六大耦合面（逐条证据）

| # | 耦合面 | 证据（`9a1e2c8`） | 处置 |
|---|---|---|---|
| 1 | 运行时：API 托管 web dist | `server.ts:12`、`452-455`；`web-assets.ts`；`apps/api/package.json:15` `@fastify/static`；`apps/api/test/web-assets.test.ts` | B3 删 |
| 2 | 部署：nginx / systemd / 升级脚本 | `deploy/rai-api.service:15`、`deploy/n100/rai-api.service:15`；`deploy/nginx-rai.conf:53-54,95-104`；`deploy/upgrade.sh:105-106` | B2 改 |
| 3 | 开发流：vite 代理 5173（★ 最关键） | `apps/web/vite.config.ts:21`；`ServerDiscovery.swift:71`；`ServerSession.swift:77-79`（仅 `os(macOS)&&DEBUG`）；`TechSetupView.swift:46`、`TechViews.swift:2195`（占位符）；`scripts/dev-device.mjs:8,40,49,61,71-78`；`scripts/mobile-smoke.sh:6,19,79,88` | B1 改；B4 删 macOS 默认值 |
| 4 | 门禁与 CI | `scripts/run-tests.mjs:4,94-104`；`apps/api/test/node-version.test.ts:40,48,64`；`packages/application/test/cross-platform-scripts.test.ts:42`；`apps/api/test/deploy-cloud.test.ts:40-46`；`apps/api/test/web-assets.test.ts`；验收矩阵 B02；`scripts/check-web-build.mjs`（3 个调用方）；`ci.yml:112-113,160-161,167-170`；`.workflow/master-ci.yml:34` | B3 改 |
| 5 | macOS 壳与 pbxproj | pbxproj `:24-33`（同步组）、`:196-204`（Sources 空）、`:261/:263/:267`、`:323/:325/:328`、`:344/:348`、`:361-364`、`:374/:376/:385`、`:398/:402`、`:411/:415-418`、`:428/:430/:439`；`RootView.swift:6,15-17,46-71,73-92,94-100`；`AppWebView.swift:9-18,20-51,53-111`；`RAIApp.swift:12,50,93-95`；`ServerSession.swift:77-81`；`apps/ios/tests/typecheck-ios.sh:56` | B4 删 |
| 6 | 端点消费面 | 83 条 `/v1` 路由（方法+路径）：iOS 40、Web 61、双用 25、iOS-only 15、仅 Web 36、两边皆无 7 | 默认全保留（D2） |

### 3.3 开发流的隐藏耦合（★ 最容易被漏掉）

- **iOS 真机开发现在走的是 vite 代理**：App 填 `http://<LAN-IP>:5173`，vite 把 `/v1` 代理到 `127.0.0.1:8787`（`apps/web/vite.config.ts:21` 起的 proxy 配置）。Web 一删，这条路断了。
- **直连 API 需要 Token**：`local-request-security.ts:145-152` 在未配置 `RAI_API_TOKEN` 时只信任 `127.0.0.1:<port>`/`localhost:<port>` 的 Host；真机走 LAN IP 会被 **403**。因此 B1 的 `dev:device` 必须注入一个开发 Token 并打印给用户填写（不是可选优化，是能否连通的前提）。
- `ServerSession.swift:77-79` 的 `127.0.0.1:5173` 默认值只在 `#if os(macOS) && DEBUG` 生效；**iOS 发布构建默认空地址**，由首次连接页手填。生产预置 URL 是 D 项的独立增强（B1.4），不是必需项。
- `ServerDiscovery.swift:71` 的 Bonjour 端口兜底 5173 只在「广告方没给端口」时生效；本仓库 `dev-device` 用 `dns-sd -R ... 5173` 显式广告，所以**两处都要改**。

### 3.4 端点消费面（83 条，方法+路径）

| 分类 | 数量 | 说明 |
|---|---|---|
| iOS 在用 | **40** | 见附录 A.1；含 `/v1/mobile/*` 15 条 iOS-only、`/v1/handshake`、`/v1/workouts/:id/series`、`/v1/imports/*`、`/v1/import-jobs*`、`/v1/commands*`、`/v1/jobs/:id` |
| Web 在用 | 61 | 其中 25 条与 iOS 双用 |
| 双用 | 25 | 例如 `/v1/health`、`/v1/dashboard`、`/v1/predictions`、`/v1/recovery-trends`、`/v1/training-zones/current`、`/v1/training-statistics/overview`、`/v1/workouts*`、`/v1/mobile/{today,goals,trends,statistics,lock}` |
| 仅 Web | 36 | 见附录 A.2（备份、模型/预测管理、数据运维、审计、导入管理、深读统计、成绩录入、隐私区、`PATCH /v1/workouts/:id/override`） |
| 两边皆无 | 7 | 含 `/v1/performance`（运维遥测，测试在用）与备份/恢复的边界方法（删前逐条复核，见 A.3） |
| **必须保留** | — | `/v1/workouts/:id/share-card`（`APIClient.swift:270` → `TechShareCardView.swift:110`）、`/v1/exports/workout-summary`（`APIClient.swift:284` → `TechWorkoutExportView.swift:68`）、`share-card.ts` 与 `data.ts:94,1910` 的 `trimRouteForShare` |

> v1 把 `/v1/performance` 列为「Web 专用」不属实：Web 侧 0 引用，纯运维遥测端点（`server.ts:969-972`）。

### 3.5 门禁与 CI（现状 + 红线）

| 门禁 | 现状 | 删 Web 后 |
|---|---|---|
| `npm run typecheck` | 两个 project（`tsconfig.pure.json` + `tsconfig.json`）均 0 错 | B3 只删 `apps/**/*.tsx` 与 `jsx`；**保留 DOM lib**（见 B3 第 7 步） |
| `npm test` | `scripts/run-tests.mjs` 跑 Node 全量 + Web vitest 两套 | 必须删 Web 套件，否则抛异常 |
| `npm run test:ios` | `node scripts/run-ios.mjs gates`；无 Xcode 显式跳过 exit 0 | B4 后仍须绿（类型检查覆盖 `RAI/**` 除 3 个高德文件） |
| `npm run check:docs` | `check-doc-links.mjs`：**所有 md 必须从根 README 可达**、本地链接必须存在 | 删 `docs/WEB.md` 必须同批删 `README.md:69`；`ARCHITECTURE.md:44` 链接必须删 |
| `npm run check:doc-refs` | `check-doc-line-refs.mjs`：默认 8 份文档，138 处引用，0 漂移 | **不在 CI**，但 B5 建议跑一次 |
| `check:acceptance-matrix` | 77 条全 cited | **B02 唯一引用在 `apps/web/test/ability-chart-epoch.test.tsx:36`**，删 web 前必须先把 B02 挂到 `apps/api/test/dataset-epoch.test.ts:11` |
| `check:package-boundaries` | pre-commit 每次跑 | 不涉及 Web |
| `check:scripts` | 19 个 `package.json`/117 条 script | 改脚本写法必须仍是「`&&` / 纯命令 / `node xxx.mjs`」 |
| pre-commit | blob 上限、typecheck、check:docs、check:scripts、iOS 门禁（条件）、迁移、表分类、验收矩阵、包边界 | 中间态提交会被这些拦住，见 §4.3 |
| CI `windows-runtime` | `npm test`、**`npm run build`**、`smoke:api` | 删 build step |
| CI `verify` | `typecheck`、`check:docs && check:acceptance-matrix`、`npm test`、`ml:test`、**`test:e2e:web`**、`smoke:api`、生产依赖契约 | 删 e2e step；生产依赖契约的 `vite` 哨兵可换更强的（B3 第 9 步） |
| `.workflow/master-ci.yml` | Gitee Go 草案：`npm ci/typecheck/test/build/smoke` | 删 `npm run build`（`:34`） |

### 3.6 文档门禁的两条硬规则（决定新文档怎么放）

1. `check-doc-links.mjs` 扫描**全部已跟踪 + 未忽略的 md**（含 `deliverables/`），从 `README.md` 做可达性遍历；每份 md 必须可达，链接目标必须存在。
   - 推论：本文档必须挂在 [deliverables/README.md](README.md) 的索引里（已挂）；**正文不要用 markdown 链接指向将被删除的 `apps/web/**`**，否则执行完 `check:docs` 直接红。本文档对这类路径统一用行内代码。
2. `check-doc-line-refs.mjs` 默认只核对 8 份文档，**不含 `deliverables/`**；`.service`/`.pbxproj`/`.env.example` 不在其扩展名表内。因此本文档的 `文件:行号` 不会被自动校验，**行号保鲜靠附录 C**。

### 3.7 iOS 侧的准确事实（更正 v1）

| 结论 | 证据 |
|---|---|
| iOS 生产路径 = `NativeRootView()` | `RootView.swift:47-48`；`NativeViews.swift:41` |
| `AppWebView.swift` 是**双平台**遗留壳，iOS 侧运行时不可达但会被编译、被门禁检查 | `:53-82` iOS `UIViewRepresentable`；`:83-111` macOS；`:367-407` iOS 安全区/注入；`:417-435` iOS 配置；`:573-588` `raiShell=ios` |
| `ChromeController`（`:9-18`）定义在 `AppWebView.swift` 内，被 `RAIApp.swift:12`、`RootView.swift:6` 使用 | 删文件前必须先处理 |
| `NativeBridgeSnapshot`（`:20-51`）只被 macOS 分支的 `nativeSnapshot` 使用 | `RootView.swift:73-92` |
| 工程用文件系统同步组，**没有逐文件编译列表** | pbxproj `:24-33`、`:196-204`；`grep AppWebView project.pbxproj` 无匹配 |
| 服务地址存 `UserDefaults` 键 `rai.serverURL` | `ServerSession.swift:59`（写入 `:7-14`）；Keychain 只存 token（`Keychain.swift:6-7`） |
| Release 强制 https 的是应用自身，不是 ATS | `ServerSession.swift:106-108` |
| ATS：`NSAllowsLocalNetworking=true`、`NSAllowsArbitraryLoadsInWebContent=false`、**无 `NSExceptionDomains`** | `apps/ios/RAI/Info.plist:11-17` |
| macOS 键位 | `MACOSX_DEPLOYMENT_TARGET` `:263/:325`；`SUPPORTED_PLATFORMS` `:376/:430`；`COMBINE_HIDPI_IMAGES` `:344/:398`；`ENABLE_HARDENED_RUNTIME` `:348/:402`；`LD_RUNPATH_SEARCH_PATHS[sdk=macosx*]` `:361-364/:415-418`；`TARGETED_DEVICE_FAMILY=1`（仅 iPhone，勿动）`:385/:439` |
| Podfile 无 WKWebView 依赖，`platform :ios, '17.0'` | `apps/ios/Podfile:3` |

### 3.8 基线实测记录（2026-10-17，`9a1e2c8`）

| 命令 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.pure.json` / `-p tsconfig.json` | exit 0 / exit 0 |
| `node scripts/check-doc-links.mjs` | `Documentation: 73 files, 555 local links, 0 problems` |
| `node scripts/check-doc-line-refs.mjs` | 138 处引用，0 越界、0 漂移、7 处空行告警 |
| `node scripts/check-npm-scripts-portable.mjs` | 19 个 package.json / 117 条 script，通过 |
| `node --import tsx scripts/check-acceptance-matrix.mts` | `77 条；cited 77；missing 0` |
| `node scripts/run-ios.mjs gates` | 通过（类型检查 95 个文件，跳过 3 个高德文件） |
| `node apps/api/test/production-runtime-smoke.mjs` | **本机失败 exit 13**：`onnxruntime-node` 原生库未签名（环境问题，与 Web 无关；CI ubuntu 不受影响） |

> 本机验证环境的注意点：该机器 PATH 上没有 `npm`，上述命令用仓库自带 node（v24.21.0）直接执行命令体；在有 npm 的机器上等价。

---

## 4. 批次总览

### 4.1 批次表

| 批次 | 名称 | 改动面 | 依赖 | 可独立回退 | 预计 |
|---|---|---|---|---|---|
| **B0** | 决策冻结 + 仓库口径 | AGENTS.md、决策记录 | 授权（D0） | 是（文档） | 0.5 天 |
| **B1** | iOS 连接面切换 | `dev-device.mjs`、3 个 Swift 占位符/端口、`mobile-smoke.sh`、（可选）生产 URL 预置 | B0 | 是 | 1 天 |
| **B2** | 云部署面解耦 | 2 个 systemd、2 个 nginx、`upgrade.sh`、`README-UBUNTU.md`、env 注释、`deploy-cloud.test.ts` | B0 | 是（配置备份） | 1 天 |
| **B3** | Web 退役原子批 | 删 `apps/web` + 根脚本 + 门禁 + CI + API 静态托管 + tsconfig + docs 联动 + lock | B0、B2 | 是（单 PR revert） | 1–2 天 |
| **B4** | macOS 壳移除 | pbxproj、`ChromeController`、`RootView`、`RAIApp`、`ServerSession`、`typecheck-ios.sh` | B0 | 是 | 1 天 |
| **B5** | 文档与索引收尾 | README、AGENTS 二校、OPERATIONS、RUNBOOK、ALGORITHM、deploy README、deliverables 索引、ADR | B2/B3/B4 | 是 | 0.5 天 |
| **B6** | 发布与真机验收 | 云端发布、iOS 发版、验收矩阵 | B2、B3、B4、B5 | 按 §9 | 0.5 天 |
| **B7** | （可选）裁剪仅 Web 端点 | `server.ts` 路由 + schemas + 测试 | D2 决定 | 是 | 1–2 天 |

### 4.2 依赖关系（顺序不可交换的部分）

```
B0 ─┬─> B1 ─────────────────────────┐
    ├─> B2 ──> B3 ──> B5 ───────────┼─> B6
    └─> B4 ─────────────────────────┘
              （B7 仅在 D2 决定裁剪时，排在 B6 之后）
```

**为什么 B2 必须早于 B3**：`deploy/rai-api.service:15` 与 `deploy/n100/rai-api.service:15` 会执行 `scripts/check-web-build.mjs`。若先删脚本再改服务器，线上 `systemctl restart` 直接失败（`ExecStartPre` 非 0 ⇒ 服务起不来）。正确顺序是「先让服务器不再调用它（B2），再删脚本（B3）」。

**为什么 B3 是一个原子批**：`run-tests.mjs`、`node-version.test.ts`、`cross-platform-scripts.test.ts`、`web-assets.test.ts`、B02 引用、`deploy-cloud.test.ts` 的断言与 `apps/web` 的存在性互相咬合；拆开就会出现「要么红、要么门禁被临时调弱」的中间态。

### 4.3 必须同批的清单（漏一条就红）

| 触发改动 | 必须同批修改 | 后果 |
|---|---|---|
| 删 `apps/web` | `scripts/run-tests.mjs`（Web 套件）、`apps/api/test/node-version.test.ts:40,48,64`、`packages/application/test/cross-platform-scripts.test.ts:42` | `npm test` 红：ENOENT / MODULE_NOT_FOUND / 断言失败 |
| 删 `apps/web/test/ability-chart-epoch.test.tsx` | 先把 B02 引用挂到 `apps/api/test/dataset-epoch.test.ts:11` | `check:acceptance-matrix` missing=1，pre-commit 与 CI 红 |
| 删 `apps/api/src/web-assets.ts` | 同批删 `apps/api/test/web-assets.test.ts`、`server.ts:12,452-455`、`apps/api/package.json:15` | typecheck 红、`npm test` 加载失败 |
| 删 `docs/WEB.md` | 同批删 `README.md:69`、`docs/ARCHITECTURE.md:44` | `check:docs`：missing target + 不可达 |
| 改 `deploy/nginx-rai.conf` 删静态块 | 同批重写 `apps/api/test/deploy-cloud.test.ts:40-46` | `npm test` 红（`:43/:45` 正断言） |
| 删根 `build`/`test:e2e:web` 脚本 | `cross-platform-scripts.test.ts:42`、`ci.yml:112-113,160-161`、`.workflow/master-ci.yml:34`、`deploy/upgrade.sh:105-106`、`deploy/README-UBUNTU.md:35,153`、`README.md:30,41-42,50` | 脚本缺失 / CI 红 / 发布脚本失败 |
| 删根依赖 `playwright-core`（及可选 `concurrently`） | 同批重新生成 `package-lock.json` | `npm ci` 与 lock 不一致（CI 红） |
| 删 `apps/ios/RAI/AppWebView.swift` | 先把 `ChromeController` 处理掉；同批删 `NativeBridgeSnapshot` 与 macOS 分支 | `test:ios` 类型检查红（`ChromeController` 未定义） |

### 4.4 提交纪律

- 每个批次内允许拆多个 commit，但**每个 commit 必须过 pre-commit**（typecheck / check:docs / check:scripts / 验收矩阵 / 包边界 / 条件段）。做不到就合并成一个 commit。
- B3 的 commit message 必须写明「单批删除，回滚=revert 本提交」。
- 不要在 B3 里顺手改算法、schema 或 iOS。

---

## 5. 分步执行

> 行号均对 `9a1e2c8`。每一步给出的代码片段是**目标状态**，不是建议风格。

### B0 — 决策冻结与仓库口径（无功能改动）

**目的**：让「Web 不是受支持产品」成为仓库事实，避免后续 agent 按旧口径回滚。

**改动**：
1. 在 [AGENTS.md](../AGENTS.md) 完成 D0 列出的三段改写（§Supported Product 重写；删 `## Supported Web Viewport` 与 `## Frozen Responsive Areas`；`## Default Verification` 去掉 Web 命令）。
2. 把 §2 的 D0–D9 决策结果追加到本文档末尾（或 `docs/DECISIONS.md` 一条记录），写清「谁、何时、批准范围」。
3. 新增 ADR：`docs/adr/ADR-006-retire-web-and-macos.md`（沿用现有编号惯例，现有最新为 `ADR-005-temporal-training-labels.md`）。内容：决策、备选、影响面、回滚条件。**不要**改写 ADR-004（历史决策记录不回写）。

**验证**：`node scripts/check-doc-links.mjs`（AGENTS 改动后仍从 README 可达）。

**回滚**：revert 本批次文档提交。

---

### B1 — iOS 连接面切换（Web 仍在，随时可回退）

**目的**：把「开发真机连接」从 vite 代理（5173）切到直连 API（8787），并把生产地址预置能力准备好。此批次不删任何 Web 代码。

#### B1.1 重写 `scripts/dev-device.mjs`（只起 API）

改动要点：
- 不再用 `concurrently` 同时起 `dev:lan -w @rai/web`；只起 `npm run dev:api`。
- 子进程环境注入 `RAI_API_HOST=0.0.0.0`（局域网可达）与 `RAI_API_TOKEN=<开发令牌>`（**直连必需**，见 §3.3）。
- 打印 LAN 地址与令牌；dns-sd 广告端口改为 `RAI_API_PORT`（默认 8787）。
- 删除 `process.env.RAI_ALLOW_LAN_DEV = "1"`（Web 专属；B3.5 会从 API 侧也清掉）。

目标实现（可直接替换整个文件）：

```js
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = process.env.RAI_API_PORT ?? "8787";
// 直连 API 的局域网请求不带 Origin，而未设 RAI_API_TOKEN 时 API 只信任 loopback Host
// （local-request-security.ts:145-152）⇒ 开发调试必须带令牌，否则真机一律 403。
const devToken = process.env.RAI_API_TOKEN?.trim() || "rai-local-dev";

const lanAddresses = [];
for (const [iface, addrs] of Object.entries(networkInterfaces())) {
  for (const addr of addrs ?? []) {
    const ipv4 = addr.family === "IPv4" || addr.family === 4;
    if (!ipv4 || addr.internal) continue;
    lanAddresses.push({ iface, address: addr.address });
  }
}

const isNatAddress = (address) => address.startsWith("192.168.126.");
const ifaceRank = (item) => {
  if (isNatAddress(item.address)) return 100;
  const iface = item.iface.toLowerCase();
  if (iface === "en0") return 0;
  if (iface.includes("wi-fi") || iface.includes("wifi")) return 1;
  if (/^en\d+$/.test(iface)) return 2;
  return 10;
};
lanAddresses.sort((left, right) => ifaceRank(left) - ifaceRank(right) || left.address.localeCompare(right.address));

console.log("RAI iPhone 直连调试（API only）");
console.log("");
if (lanAddresses.length === 0) {
  console.log("没有发现局域网 IPv4，检查网络连接。");
} else {
  const preferred = lanAddresses[0];
  console.log(`在 App 里填写  http://${preferred.address}:${apiPort}`);
  if (isNatAddress(preferred.address)) {
    console.log("警告：这是 VMware NAT（192.168.126.x），手机通常访问不到。请改成 Bridged（桥接）。");
  }
  for (const item of lanAddresses.slice(1)) {
    const natNote = isNatAddress(item.address) ? "  NAT，手机通常不可达" : "";
    console.log(`  其他地址  http://${item.address}:${apiPort}    [${item.iface}]${natNote}`);
  }
}
console.log(`访问令牌（API Token）填：${devToken}`);
console.log("");
console.log("如果手机打不开这个地址：把 VMware 网卡改成 Bridged（桥接），让 iPhone 与虚拟机同网段。");
console.log("");

let advertiser = null;
if (process.platform === "darwin" && lanAddresses.length > 0) {
  advertiser = spawn("dns-sd", ["-R", "RAI", "_rai._tcp", "local.", apiPort], { stdio: "ignore" });
  advertiser.on("error", () => {});
}

const child = spawn("npm", ["run", "dev:api"], {
  cwd: projectRoot,
  env: { ...process.env, RAI_API_HOST: "0.0.0.0", RAI_API_TOKEN: devToken },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (advertiser && !advertiser.killed) advertiser.kill();
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
```

> 若团队坚持保留 `concurrently`（例如还想同时起别的东西），必须保证 `@rai/web` 不再被启动；否则 B3 删 `apps/web` 后 `dev:device` 直接失败。

#### B1.2 改 iOS 默认端口与占位符

| 文件 | 现值 | 改为 |
|---|---|---|
| `apps/ios/RAI/ServerDiscovery.swift:71` | `port.rawValue == 0 ? 5173 : Int(port.rawValue)` | `port.rawValue == 0 ? 8787 : Int(port.rawValue)` |
| `apps/ios/RAI/Skins/Technology/TechSetupView.swift:46` | 占位符 `http://192.168.1.8:5173` | `http://192.168.1.8:8787` |
| `apps/ios/RAI/Skins/Technology/TechViews.swift:2195` | 占位符 `http://192.168.x.x:5173` | `http://192.168.x.x:8787` |

> `ServerSession.swift:77-79` 的 macOS Debug 默认值不在本批次改（随 B4 一起删）。iOS 发布构建默认空地址，不受影响。

#### B1.3 改 `scripts/mobile-smoke.sh` 的 Origin

它现在用 `Origin: http://127.0.0.1:5173` 模拟网页（`:6,19,79,88`）。Web 退役后：
- 删除 `ORIGIN` 变量与全部 `-H "Origin: $ORIGIN"`（原生客户端不发 Origin）；
- 若保留 Origin 用例（验证「不可信 Origin 被拒」），单独加一条期望 403 的负例，不要混进主流程。

#### B1.4（可选，推荐）生产地址预置

现状：iOS 发布构建首次启动地址为空，用户手填（`TechSetupView`）；连上后仍可在原生设置面板改（`TechViews.swift:2190-2217`）。若希望「安装即连云」，按下面做：

1. `apps/ios/RAI/Info.plist` 增加：
   ```xml
   <key>RAIDefaultServerURL</key>
   <string>$(RAI_DEFAULT_SERVER_URL)</string>
   ```
2. pbxproj 的 Debug/Release 两处 build settings 增加（沿用 `AMapApiKey` 的构建变量套路，`Info.plist:5-6`）：
   ```
   RAI_DEFAULT_SERVER_URL = "";
   ```
   Release 配置填 `https://rai.example.com`（值必须是 https：`ServerSession.swift:106-108` 在非 DEBUG 下强制 https）。
3. `ServerSession.swift` 的 `storedURL.isEmpty` 分支改为：
   ```swift
   if storedURL.isEmpty {
       let preset = (Bundle.main.object(forInfoDictionaryKey: "RAIDefaultServerURL") as? String ?? "")
           .trimmingCharacters(in: .whitespacesAndNewlines)
       serverURLString = preset
       apiToken = ""
   } else { /* 原逻辑 */ }
   ```
   预置值非空时等价于「已连接」，用户仍可在设置里改。

**B1 验证**：
- `node scripts/check-npm-scripts-portable.mjs`（脚本改写后仍合规）。
- `npm run test:ios`（3 个 Swift 文件在类型检查覆盖内）。
- 手动：`npm run dev:device` 打印 LAN 地址 + 令牌；真机填写后 `/v1/health` 通（App 显示已连接）。

**B1 回滚**：revert；Web/vite 仍在，旧 5173 路径立即可用。

---

### B2 — 云部署面解耦（Web 仍在，线上先不引用）

**目的**：让服务器与 nginx **不再需要 web dist**，为 B3 删目录扫清前置。

#### B2.1 systemd（两个 unit 同一行）

`deploy/rai-api.service:15` 与 `deploy/n100/rai-api.service:15`：

```diff
 ExecStartPre=/usr/bin/node scripts/check-node-version.mjs
-ExecStartPre=/usr/bin/node scripts/check-web-build.mjs
 ExecStart=/usr/bin/node --import tsx apps/api/src/server.ts
```

保留 `:14` 的 Node 版本前置检查；`deploy-cloud.test.ts:7-16` 不钉这两行，删掉不会红。

#### B2.2 主 nginx（`deploy/nginx-rai.conf`）——按「减 SPA」重写，不要整份照抄 v1

**必须删除**：`:53-54`（`root`/`index`）、`:95`（`location = /index.html`）、`:96`（`location = /favicon.ico`）、`:97-100`（`/assets/` 块）、`:101-104`（SPA 深链接白名单）。`:105 location / { return 404; }` **已存在，必须保留**。

**必须保留**：`:25-26` 限速 zone、`:28-37` 80→443 + ACME、`:40` `listen 443 ssl http2`、`:49` `client_max_body_size 1m`、`:50-51` `proxy_read_timeout/send_timeout 3600s`、`:58` `X-Robots-Tag`、`:60-63` `robots.txt`、`:66-76` `/v1/`、`:80-91` uploads（`:82` `client_max_body_size 4g`）、`:105` 404。

目标文件（可直接替换 `deploy/nginx-rai.conf`）：

```nginx
# RAI 生产站点 Nginx 配置模板（v4：Web SPA 已退役，只反代 API）
#
# 拓扑要点：
#   - 后端 rai-api 只监听 127.0.0.1:8787（RAI_API_HOST/RAI_API_PORT 可覆盖）。
#   - 本模板不托管任何静态文件：站点根路径 404，只有 /v1/* 反代给后端。
#   - 客户端只有原生 iOS App（SwiftUI）：直接请求 /v1，不加载网页、不发 Origin/预检；
#     Token 由 App 以 Authorization: Bearer 携带（云上必须设 RAI_API_TOKEN）。
#   - 仅 /v1/* 反代，并透传客户端自己的 Authorization（不注入、不做 Basic Auth）。
#   - 后端 local-request-security 统一校验 Bearer 与请求上下文。
#
# 默认鉴权：每个 /v1 请求都要 Token。匿名只读（RAI_PUBLIC_HOSTS）原本为「浏览器打开即看」
# 而设，Web 退役后不再需要；无特殊需求请保持为空。
#
# 请把 `rai.example.com` 换成真实域名。

limit_req_zone $binary_remote_addr zone=rai_read:10m rate=300r/m;
limit_req_status 429;

server {
    listen 80;
    server_name rai.example.com;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name rai.example.com;

    # certbot --nginx 自动填入证书路径；手工部署时替换：
    # ssl_certificate     /etc/letsencrypt/live/rai.example.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/rai.example.com/privkey.pem;

    # 默认收紧：只有上传端点需要大 body（下面单独放宽）。
    client_max_body_size 1m;
    proxy_read_timeout 3600s;         # 导入/重算长请求
    proxy_send_timeout 3600s;

    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;

    location = /robots.txt {
        add_header Content-Type text/plain always;
        return 200 "User-agent: *\nDisallow: /\n";
    }

    # API：仅透传 /v1/*，不做 Basic Auth / Token 注入
    location /v1/ {
        limit_req zone=rai_read burst=100 nodelay;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
    }

    # Apple Health ZIP 上传（iOS 后台 URLSession）。
    # 上限必须 ≥ API 的 RAI_IMPORT_MAX_ZIP_BYTES（默认 64 MiB，deploy/rai.env.example:11）；
    # 4g 是「不小于」的宽松值，收紧时必须与 env 同步。
    location = /v1/imports/uploads {
        limit_req zone=rai_read burst=100 nodelay;
        client_max_body_size 4g;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # Web 退役后不存在任何页面/静态资源：其余路径一律 404。
    location / { return 404; }
}
```

> 上面的目标文件**省略了**原文件 `:108-155` 的注释块（备案期 IP 直连站点模板）。若运维仍要保留该模板，必须把其中的 `root /opt/rai/apps/web/dist;`、`index index.html;`、`# Copy the public build-resource and SPA allow-list locations above here.` 一并删掉，只保留 `/v1/` 与 uploads 反代 + `location / { return 404; }`。若 D6 选择「保留最小静态页」，则把 443 server 里的 `location /` 改成 `root /var/www/rai; try_files /index.html =404;` 并在该目录只放一个备案页。

#### B2.3 n100 nginx（`deploy/n100/nginx-rai.conf`）

已是纯透传（`:53-55` catch-all → API），**功能上无需改**；必须改的只有注释 `:25-26`（「API on the home VM serves the matching Web build too」）。可选收紧：把 `location /` 改成 `return 404`（不影响测试，`deploy-n100.test.ts:178-179` 只钉 `Authorization` 透传与 `proxy_request_buffering off`）。

#### B2.4 `deploy/upgrade.sh`

```diff
-# 服务器端发布脚本：把 /opt/rai 的 main 快进到远端，重建前端产物并重启 API。
+# 服务器端发布脚本：把 /opt/rai 的 main 快进到远端并重启 API。

-# --- 4. 重建前端产物（Nginx 直接读 dist）--------------------------------------
-as_user npm --prefix "$APP_DIR" run build
-
 # 显式授权后才停服迁移。失败时保持停止，不重启一个半迁移的数据库。
...
-# --- 5. 重启并验证 -----------------------------------------------------------
+# --- 4. 重启并验证 -----------------------------------------------------------
```

注意：`:31` 的 `-h` 用 `sed -n '2,14p' "$0"` 输出帮助，删掉头注释一行后帮助文本会少一行——可接受；确需精确就同步调整该 `sed` 范围。`deploy-upgrade.test.ts` 不钉 `npm run build`，删除安全，但**不要**动 `:83` 的 `backup-reminder` 文案与 `systemctl stop → data:migrate → reset-failed → restart` 顺序（否则 `deploy-upgrade.test.ts:83-90` 红）。

#### B2.5 `deploy/README-UBUNTU.md` 与 env 注释

至少改这些行（实测 web 叙述 ≥18 处）：
- `:7`（「由 Nginx 提供 HTTPS 并托管静态 Web」）、`:11`（「Nginx 直接托管 apps/web/dist」）→ 改为「Nginx 只反代 /v1，站点根路径 404」。
- `:35`、`:153` 的 `sudo -u rai npm run build` → 删除（发布流程不再构建前端）。
- `:67` 「不要把 API Token 放入 Web build 环境变量」→ 保留结论，改写理由（前端已不存在；Token 只进 iOS Keychain）。
- `:69-84` 「浏览器匿名只读（可选）」整节 → 改为「匿名只读（历史 Web 能力，默认关闭）」或删除。
- `:98-101` 「SPA 与深链接」curl 验证 → 改为「根路径应 404」验证。
- `:137-138` 「重建前端」→ 删除。
- `:197` 「先发布兼容 API，再发布 Web/iOS」→ 「先发布兼容 API，再发布 iOS」。

`deploy/rai.env.example:37,42-47` 与 `deploy/n100/rai.env.example:16-17`：更新 web/浏览器相关注释，但**不要删这几个键**：
- `RAI_PUBLIC_HOSTS=` 与 `RAI_ALLOW_REMOTE_TOKEN_AUTH=1` 被 `apps/api/test/deploy-cloud.test.ts:21-22` 逐行钉住（`deploy/n100.test.ts:176` 钉 n100 的 `RAI_PUBLIC_HOSTS=`）；即使 iOS 不需要 `RAI_ALLOW_REMOTE_TOKEN_AUTH`（见 §3.1），删它会让 `npm test` 红。要退役该 flag 得单独改测试并走安全评审。
- `RAI_ALLOWED_ORIGINS` 没有断言，可留可删；默认建议保留空值，作为将来浏览器访问的纵深。

> **行尾纪律**：`.gitattributes` 只钉了 `*.sh/*.py/*.swift/*.pbxproj` 与 `/.githooks/*`，`deploy/*.conf`、`*.service`、`*.example` **未钉 LF**。`deploy-cloud.test.ts:5` 会 normalize CRLF，但 `deploy-n100.test.ts:171` **不会**——在 Windows 上编辑 `deploy/n100/*` 后若变成 CRLF，`:176` 的 `/^RAI_PUBLIC_HOSTS=$/m` 会失败。提交前用 `git ls-files --eol deploy` 确认 `w/lf`。

#### B2.6 重写 `apps/api/test/deploy-cloud.test.ts:40-46`

现有断言钉住了待删的 SPA 行（`:43`、`:45`）。替换为「静态托管已退役」的判据：

```ts
test("static hosting is retired: nginx only proxies the API", () => {
  const nginx = read("nginx-rai.conf").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(nginx, /root\s+\/opt\/rai\/apps\/web\/dist/);
  assert.doesNotMatch(nginx, /try_files/);
  assert.doesNotMatch(nginx, /location ~ \^\/assets\//);
  assert.match(nginx, /location \/v1\/ \{/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8787/);
  assert.match(nginx, /location \/ \{ return 404; \}/);
});
```

`deploy-cloud.test.ts:7-16`（service 资源上限）、`:18-29`（env/端口）、`:31-37`（README 关键串）保持不变；注意 `:32-33` 仍要求 `README-UBUNTU.md` 同时含 `deploy/backup-runtime.sh` 与 `MemoryHigh=1100M`，改写文档时别删这两串。若 D6 选「保留最小静态页」，上面的 `doesNotMatch(/try_files/)` 要放宽为「只允许 `/index.html` 的 try_files，不允许任意 `$uri` 回退」。

**B2 验证**：
- `npm test`（deploy 三个测试；`deploy-n100`/`deploy-upgrade` 不受影响）。
- 服务器侧：`nginx -t`、`systemctl daemon-reload && systemctl restart rai-api`、`systemctl status rai-api`。
- `curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/v1/health`（期望 200 且 `status:"ok"`）；`curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/`（期望 **404**）。
- 无 `apps/web/dist` 的机器上 `npm start` 正常（`server.ts:452-455` 有 `existsSync` 守卫）。

**B2 回滚**：恢复备份的 `deploy/*` 与 `/etc/nginx/conf.d/rai.conf`、`/etc/systemd/system/rai-api.service`，`nginx -t && systemctl reload nginx`、`systemctl daemon-reload && systemctl restart rai-api`。

---

### B3 — Web 退役原子批（删目录 + 门禁 + CI + API 宿主）

**目的**：一次性把 `apps/web` 及相关引用删干净，保证每个提交在 pre-commit/CI 的门禁下自洽。

**执行顺序（同一 PR 内建议的 commit 顺序）**：

1. **预备**：`apps/api/test/dataset-epoch.test.ts:11` 标题加 `B02:`（让验收矩阵在删除前就有替代引用）：
   ```diff
   -test("persisted epochs survive reopening while an explicit namespace change takes precedence", async () => {
   +test("B02: persisted epochs survive reopening while an explicit namespace change takes precedence", async () => {
   ```
   跑 `node --import tsx scripts/check-acceptance-matrix.mts` 确认仍是 `cited 77 / missing 0`。
2. **删 API 静态托管**（可与 3 同 commit）：删 `apps/api/src/web-assets.ts`、`apps/api/test/web-assets.test.ts`；改 `apps/api/src/server.ts`：
   ```diff
   -import { registerWebAssets } from "./web-assets.js";
   ...
   -const webDist = resolve(projectRoot, "apps/web/dist");
   -if (existsSync(webDist)) {
   -  await registerWebAssets(app, webDist);
   -}
   ```
   从 `apps/api/package.json:15` 删 `@fastify/static`（唯一消费者）。
3. **删目录**：`git rm -r apps/web`（92 个跟踪文件）。
4. **根脚本**（`package.json`）：
   - 删除：`:20 prebuild`、`:23 predev:web`、`:45-47 test:e2e:web/responsive/e2e`、`:52 dev:web`、`:54 build`、`:121 concurrently`、`:122 playwright-core`。
   - `:50 dev:device` **保留**（B1 已把它改成纯 API 调试，不再消费 `concurrently`）。
   - 修改：
     ```json
     "prestart": "node scripts/check-node-version.mjs",
     "test:all": "npm run typecheck && npm test && npm run test:ios && npm run ml:test",
     "dev": "npm run dev:api",
     ```
   - 保留：`predev`/`predev:api`/`start`/`smoke:api`/`open:ios`/全部 `data:*`、`ml:*`、`rust:*`。
5. **测试运行器** `scripts/run-tests.mjs`：
   - 删 `:4` 的 `import { createRequire } from "node:module";`；
   - `main()` 改为：
     ```js
     export function main() {
       const files = nodeTestFiles();
       if (!files.length) throw new Error("No Node test files found; refuse an empty green test run");
       return executeSuites([
         { name: "Node", cwd: root, args: nodeSuiteArgs(files, testConcurrency()) }
       ]);
     }
     ```
6. **门禁测试**：
   - `apps/api/test/node-version.test.ts`：`:40` 的 `"dev:api", "dev:web"` → `"dev:api"`；`:48` 的 `["apps/api", "apps/web"]` → `["apps/api"]`；删除 `:64` 的 `["run","--silent","predev","-w","@rai/web"]`。
   - `packages/application/test/cross-platform-scripts.test.ts:42`：`["typecheck", "build", "test:e2e:web"]` → `["typecheck"]`。`:81` 的合法写法样例可以保留（它只测试语法闸门能放行，不依赖仓库里真有该脚本）。
   - `scripts/check-web-build.mjs`：删除（调用方已在 B2 清理，`prestart` 已在第 4 步改掉）。
7. **tsconfig**（`tsconfig.json`）：
   ```diff
   -    "jsx": "react-jsx",
        "lib": ["ES2023", "DOM", "DOM.Iterable"],
   ...
        "apps/**/*.ts",
   -    "apps/**/*.tsx",
   ```
   即：**只删 `jsx` 与 `apps/**/*.tsx`；`lib` 保持 `["ES2023", "DOM", "DOM.Iterable"]` 原样**。
   > ⚠️ 不要按 v1 的建议删 DOM lib：实测会让 `apps/api/test/server-runtime.test.ts` 出现 42 处 `unknown` 错误（`Response.json()` 在无 DOM 类型时返回 `unknown`）。`tsconfig.pure.json` 已证明 12 个纯逻辑包不需要 DOM，但 API 测试需要。
8. **文档联动**：`git rm docs/WEB.md`；删 `README.md:69` 的 Web 文档入口行（指向 `docs/WEB.md` 的那一行）；删 `docs/ARCHITECTURE.md:44` 的 web 行（`:18`、`:23`、`:30` 在 B5 统一改，可选本批一起）。
9. **CI**：
   - `.github/workflows/ci.yml`：删 `windows-runtime` 的 `Build production Web application`（`:112-113`）；删 `verify` 的 `Build and test desktop Web flows`（`:160-161`）。
   - 可选增强（推荐）：`:167-170` 的生产依赖契约从只查 `vite` 扩展为
     ```yaml
     npm ci --omit=dev
     test ! -e node_modules/.bin/vite
     test ! -e node_modules/react
     test ! -e node_modules/vitest
     npm run smoke:api
     ```
   - `.workflow/master-ci.yml:34`：删 `- npm run build`；`:9` 的说明同步（不再提 e2e）。
10. **lock 与依赖**：删依赖后**同提交**重新生成 `package-lock.json`（`npm install --package-lock-only` 或 `npm install`），确保 CI `npm ci`（`ci.yml:27,100,143`）一致。
11. **可选 B3.5（安全面收敛，独立小提交）**：删 `server.ts:215-221`（`RAI_WEB_PORT`/`webPort`/`allowPrivateLanWebPort`/`developmentOrigins`）与 `:228-232` CORS 回调中的相应传参、`:396,:399` 的 options 字段；保留 `configuredOrigins`/`RAI_ALLOWED_ORIGINS`（防浏览器跨源的纵深）。`local-request-security.test.ts` 显式传参，不需要改。

**B3 验证**（干净克隆上跑）：
```bash
npm ci
npm run typecheck
npm test
npm run check:scripts
npm run check:docs
node --import tsx scripts/check-acceptance-matrix.mts
node scripts/check-package-boundaries.mjs
npm run smoke:api
```
期望：全绿；`smoke:api` 在没有 web dist 的机器上通过（`server.ts:452-455` 守卫已删，API 不再找 dist）。

**B3 回滚**：单 PR revert（`git revert -m 1 <merge>` 或 revert 该批 commit）；`package-lock.json` 一并回退。**不要**只回退部分文件——门禁测试与 lock 必须与目录同生共死。

---

### B4 — macOS destination 与 WKWebView 壳移除

**目的**：Xcode 工程只保留 iPhone 平台；删除双平台遗留壳与桥接代码。

#### B4.1 pbxproj（`apps/ios/RAI.xcodeproj/project.pbxproj`，467 行）

| 行 | 现值 | 动作 |
|---|---|---|
| `:376`、`:430` | `SUPPORTED_PLATFORMS = "iphoneos iphonesimulator macosx";` | 改为 `"iphoneos iphonesimulator"`（**唯一必需项**） |
| `:263`、`:325` | `MACOSX_DEPLOYMENT_TARGET = 14.0;` | 删除 |
| `:344`、`:398` | `COMBINE_HIDPI_IMAGES = YES;` | 删除（macOS 专用） |
| `:348`、`:402` | `ENABLE_HARDENED_RUNTIME = YES;` | 删除（macOS 签名用） |
| `:361-364`、`:415-418` | `"LD_RUNPATH_SEARCH_PATHS[sdk=macosx*]" = (...)` | 整段删除 |
| `:267/:328/:374/:428` | `SDKROOT = auto;` | 可选改 `iphoneos`（不改也能工作） |
| `:385/:439`、`:261/:323`、`:377/:431` | `TARGETED_DEVICE_FAMILY = 1`、`IPHONEOS_DEPLOYMENT_TARGET = 17.0`、`SUPPORTS_MACCATALYST = NO` | **不要动** |

> 工程用 `PBXFileSystemSynchronizedRootGroup`（`:24-33`），Sources/Resources 都是空数组（`:196-204`、`:140-148`），**删 Swift 文件不需要改 pbxproj 的编译列表**。

#### B4.2 处理 `ChromeController` 与 `NativeBridgeSnapshot`

`AppWebView.swift:9-18` 的 `ChromeController` 被 `RAIApp.swift:12`、`RootView.swift:6,15-17` 使用；`NativeBridgeSnapshot`（`:20-51`）只被 `RootView.swift:73-92` 的 macOS 分支使用。

默认方案（彻底清理，推荐）：删除 `ChromeController` 与 `NativeBridgeSnapshot`，同步清理三处引用：
- `RootView.swift`：删 `@Environment(ChromeController.self)`（`:6`）、`@Bindable`（`:13`）、`.sheet`（`:15-17`）、`settingsSheet`（`:158-174`）、`nativeSnapshot`（`:73-92`）、`nativeChromeTop`（`:94-100`），以及已无引用的死代码 `chromeButtons`（`:102-124`）、`statusBanner`（`:126-141`）、`banner`（`:143-156`）。
- `RAIApp.swift`：删 `:12` 的 `let chrome = ChromeController()` 与 `:50` 的 `.environment(model.chrome)`。
- `apps/ios/tests/typecheck-ios.sh:56`：删 `let chrome = ChromeController()` 这行 stub。

保留方案（最小改动）：把 `ChromeController` 搬进新文件 `apps/ios/RAI/ChromeController.swift`，只删 `NativeBridgeSnapshot` 与 macOS 分支。**注意**：iOS 侧没有任何代码会把 `showSettings` 置真（唯一置真入口在 macOS 工具栏 `RootView.swift:63`），保留它就是保留一个不可达的 sheet——不建议。

#### B4.3 `RootView.swift` 目标形态

```swift
@ViewBuilder
private var connectedView(url: URL) -> some View {
    NativeRootView()
}
```
- 删除 `:49-70` 的 `#else` 分支（含 `AppWebView` 调用与 macOS 工具栏）。
- `connectedOrSetup` 可以直接 `NativeRootView()` / `SetupView()`，不再需要 `url` 形参。
- 文件内大量 `#if os(iOS)` 包裹在移除 macOS 后可保留（无副作用）；如要彻底扁平化，单独一个清理提交，不要与功能改动混在一起。

#### B4.4 `RAIApp.swift`、`ServerSession.swift`

- `RAIApp.swift:93-95`：删 `#if os(macOS) .defaultSize(width: 1440, height: 900) #endif`。
- `ServerSession.swift:77-81`：删除 `#if os(macOS) && DEBUG … serverURLString = "http://127.0.0.1:5173" #else … #endif`，统一为 `serverURLString = ""`（若已按 B1.4 预置，则用 B1.4 的 `Bundle` 读取版本）。
- 保留 `ServerSession.swift:132-135,165-173` 的「真机拒绝 localhost」逻辑。

#### B4.5 不需要改的

- `apps/ios/RAI.xcodeproj/xcshareddata/xcschemes/RAI.xcscheme`：不含 destination。
- `apps/ios/Podfile`：已是 `platform :ios, '17.0'`，无 WKWebView 依赖。
- `apps/ios/Configs/AmapKey.xcconfig`：与平台无关。
- `apps/ios/RAI/Info.plist`：ATS/Bonjour 与 macOS 无关。

**B4 验证**：
```bash
npm run test:ios          # 类型检查 95 个文件（跳过 3 个高德文件）+ 纯逻辑回归
RAI_MUTATION_FOR=git python3 apps/ios/tests/check-background-mutations.py   # RootView 在突变门禁输入面内
xcodebuild -workspace apps/ios/RAI.xcworkspace -scheme RAI -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
期望：类型检查 0 错；模拟器构建通过；`xcodebuild -showdestinations` 不再列出 macOS。

**B4 回滚**：单批 revert；若已发布 iOS 版本，回滚发版需重新构建旧 tag（macOS 支持随之恢复，但 Web 已删时旧 macOS 壳无法工作——这是 D1 选择 A 的必然结果）。

---

### B5 — 文档、索引与运维通道收尾

**目的**：让仓库叙述与代码一致，`check:docs` / `check:doc-refs` 全绿。

1. **`README.md`**（`:3`、`:8`、`:18`、`:23`、`:26`、`:30-31`、`:41-42`、`:50`、`:69`）：
   - 产品一句话：删「桌面 Web」，改为「iOS 原生 App + Node API/SQLite」。
   - 快速开始：`npm run dev:api` → `RAI_API_HOST=0.0.0.0 RAI_API_TOKEN=... npm run dev:api`；`npm run dev:device` 只启动 API 并打印 LAN 地址 + 令牌。
   - 检查清单：删 `npm run build`、`npm run test:e2e:web`；保留 `typecheck`/`test`/`test:ios`/`smoke:api`/`check:docs`。
   - 文档表：删 `docs/WEB.md` 行（B3 已删）。
2. **`docs/ARCHITECTURE.md`**：`:18` `API DTO → React Web / SwiftUI iOS` → `API DTO → SwiftUI iOS`；`:23` 的 WKWebView 说明改为「无 WKWebView 依赖」；`:30` `Web/API/iOS 消费的 HTTP DTO` → `API/iOS 消费的 HTTP DTO`；`:44` web 行已在 B3 删。
3. **`docs/OPERATIONS.md`**：`:15-16` 删 `npm run build`/`test:e2e:web`；`:23` 删「/Vitest」；`:43` 「首选 Web 导入 ZIP」→「首选 iOS App；CLI 导入」；`:93` 「Web 设置页因此只剩…」→ 改写为「Web 入口已退役；恢复走运维 curl 流程（见下）」。
4. **新增运维恢复流程**（D3）：在 `docs/OPERATIONS.md` 写清楚（注意恢复要求确认文字，`server.ts` 的 `restoreBodySchema` 校验 `confirmation`）：
   ```bash
   # 列出备份（需要 Token）
   curl -sS -H "Authorization: Bearer $RAI_API_TOKEN" https://<domain>/v1/backups
   # 触发恢复（会停写、可能进入 recovery_required；confirmation 必须逐字一致）
   curl -sS -X POST -H "Authorization: Bearer $RAI_API_TOKEN" -H "content-type: application/json" \
     -d '{"confirmation":"恢复此备份"}' \
     https://<domain>/v1/backups/<name>/restore
   # 轮询健康
   curl -sS -H "Authorization: Bearer $RAI_API_TOKEN" https://<domain>/v1/health
   ```
5. **`docs/IOS_NATIVE_RUNBOOK.md`**：`:10`（Node 套件 + Web vitest → 仅 Node 套件）、`:12-13`（删 build/e2e）、`:24`、`:41`；`:54` 的 `npm run dev:device` 保留（语义已变，补一句「只起 API，需填令牌」）。
6. **`docs/ALGORITHM.md:433`**：`默认 typecheck、npm test、build，桌面流程用 test:e2e:web` → `默认 typecheck、npm test；iOS 用 test:ios`。
7. **`apps/ios/README.md:5`**：「旧 Web 壳兼容代码不代表原生 App 使用 WKWebView」→ 改为「工程仅 iOS 平台，无 WKWebView 依赖」；`:14` 的 `dev:device` 说明补令牌。
8. **`docs/PROJECT_REVIEW.md`**：顶部加一行「本报告反映 2026-09-30 状态；Web 已于 <日期> 退役。」正文不改（时点快照）。
9. **`deliverables/README.md`**：更新本文档索引条目（状态从「草案」改为「v2 可执行、待授权」）；执行完成后按目录约定归档/删除本文档，并同步删除旧方案 `WEB_DESKTOP_REMOVAL_PLAN_2026-10-15.md`（其内容已并入本文档；**不要**在合并前删，以免丢失证据链）。
10. **ADR**：`docs/adr/ADR-006-retire-web-and-macos.md`（若 B0 未建）。

**B5 验证**：
```bash
node scripts/check-doc-links.mjs          # 或 npm run check:docs
node scripts/check-doc-line-refs.mjs      # 旁证：默认 8 份文档无漂移
npm run check:acceptance-matrix
```
**回滚**：revert 文档提交（不影响代码）。

---

### B6 — 发布与真机验收

见 §6（云端 runbook）、§7（iOS runbook）、§8（验收矩阵）。**顺序**：B2 先上云 → B3 上云（应用代码）→ B4 随 iOS 发版 → B1 的地址/令牌变更随同一 iOS 版本发布。

---

### B7（可选）— 裁剪仅 Web 在用的端点（仅在 D2 选择裁剪时）

**不要**只删 `server.ts` 的路由：以下联动缺一即红。

- `apps/api/test/server-runtime.test.ts:2013-2018`（`tokenRequiredReadRoutes` 每条必须真挂载 GET）、`:1974-1978`（写路由登记反查）；
- `apps/api/test/schemas.test.ts:346-349,371-373`（openapi 与写路由双向一致）；
- `apps/api/src/schemas.ts:872,896,897-905,906-911`（openapi 条目）与 `server.ts:350-352` 的写路由登记；
- 相关路由测试 `server-runtime.test.ts:2217-2225,2337-2341,2352-2395`。

建议裁剪顺序：`label-funnel` → `performance-entries` → `privacy-zones`（先删读，再删写；每步跑 `npm test`）。`/v1/performance` **不要**按「Web 清理」删——它是运维遥测端点。

---

## 6. 云端发布 runbook

> 前提：B2 已合并、B3 已合并；服务器为 Ubuntu + systemd + nginx；`/opt/rai` 为部署目录。

### 6.1 发布前（维护窗口开始）

```bash
cd /opt/rai
git status                     # 必须干净
# 路径以实际部署为准：nginx 站点文件可能在 conf.d/ 或 sites-enabled/；
# 数据库以 /etc/rai/rai.env 的 RAI_DATABASE 为准。
sudo cp -a /etc/nginx/conf.d/rai.conf /etc/nginx/conf.d/rai.conf.bak.$(date +%F)
sudo cp -a /etc/systemd/system/rai-api.service /etc/systemd/system/rai-api.service.bak.$(date +%F)
sudo cp -a /opt/rai/deploy /root/rai-deploy.bak.$(date +%F)
sqlite3 /var/lib/rai/var/rai.sqlite ".backup '/var/lib/rai/var/rai.sqlite.bak.$(date +%F)'"
```

### 6.2 应用代码与配置

```bash
cd /opt/rai
sudo bash deploy/upgrade.sh                      # 先 dry-run 看命令
sudo bash deploy/upgrade.sh --apply              # 不自动迁移
# 若 package-lock.json 变化，脚本会自动 npm ci
```

手工同步两个配置文件（仓库里的模板不自动安装；落到实际生效路径，常见为 `/etc/nginx/conf.d/` 或 `/etc/nginx/sites-enabled/`）：
```bash
sudo install -m 644 /opt/rai/deploy/nginx-rai.conf /etc/nginx/conf.d/rai.conf
sudo install -m 644 /opt/rai/deploy/rai-api.service /etc/systemd/system/rai-api.service
sudo systemctl daemon-reload
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart rai-api
```

### 6.3 验证

```bash
sudo systemctl status rai-api --no-pager
sudo journalctl -u rai-api -n 50 --no-pager
curl -sS -o /dev/null -w 'health=%{http_code}\n' https://<domain>/v1/health
curl -sS -H "Authorization: Bearer $RAI_API_TOKEN" https://<domain>/v1/health
curl -sS -o /dev/null -w 'root=%{http_code}\n' https://<domain>/          # 期望 404
curl -sS -o /dev/null -w 'assets=%{http_code}\n' https://<domain>/assets/app.js   # 期望 404
```

期望：`health=200`；带 token 的 health 返回 `status:"ok"`、`databaseReady:true`；`root=404`；`assets=404`。

### 6.4 清理

B3 上线后，服务器上的 `/opt/rai/apps/web/dist` 已无消费者，可删除（先确认 nginx 配置不再引用）：
```bash
grep -R "apps/web/dist" /etc/nginx/ || echo "nginx 已无静态引用"
sudo rm -rf /opt/rai/apps/web
```

---

## 7. iOS 运行与发布 runbook

### 7.1 开发（LAN 直连）

```bash
# 仓库根目录
npm run dev:device
# 输出：http://<LAN-IP>:8787 + 访问令牌 rai-local-dev
```
App 首次连接页填该地址与令牌。若手机打不开：VMware 改 Bridged；确认 API 确实监听在所有网卡（macOS：`lsof -nP -iTCP:8787 -sTCP:LISTEN`；Linux：`ss -lntp | grep 8787`），而不是只监听 `127.0.0.1`。

### 7.2 生产

- 服务地址：`https://<domain>`。Release 构建在应用层强制 https（`ServerSession.swift:106-108`），`Info.plist` 的 ATS 段只开了 `NSAllowsLocalNetworking`（`:11-17`，为开发期局域网服务），**没有** `NSExceptionDomains` 放行任意 HTTP 域名——所以生产必须用有效 TLS 证书。
- Token：在 App 设置页填 `RAI_API_TOKEN` 的同值；Token 存 Keychain，按 server 分账户（`ServerSession.swift:59`）。
- 若用 B1.4 预置：Release build setting `RAI_DEFAULT_SERVER_URL=https://<domain>`。

### 7.3 发布前检查

```bash
npm run test:ios
xcodebuild -workspace apps/ios/RAI.xcworkspace -scheme RAI -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
真机：连接 → HealthKit 授权 → 同步 → 训练/统计/趋势/分享卡 → 成绩摘要导出。

---

## 8. 验收矩阵

### 8.1 本地（每批次）

| 批次 | 命令 | 期望 |
|---|---|---|
| B1 | `npm run test:ios`；`node scripts/check-npm-scripts-portable.mjs` | 通过 |
| B2 | `npm test` | deploy 三个测试通过 |
| B3 | `npm ci` + `npm run typecheck` + `npm test` + `npm run check:docs` + `check:scripts` + `check:acceptance-matrix` + `check:package-boundaries` + `smoke:api` | 全绿 |
| B4 | `npm run test:ios` + `xcodebuild … build` + `check-background-mutations.py` | 全绿 |
| B5 | `npm run check:docs` + `check:doc-refs` + `check:acceptance-matrix` | 全绿 |
| 全案 | `npm run typecheck && npm test && npm run test:ios && npm run ml:test`（`test:all` 的新形态） | 全绿 |

### 8.2 CI

- 四个 job 全绿：`rust-data-worker`、`ios`、`windows-runtime`、`verify`。
- `windows-runtime` 不再有 `npm run build`；`verify` 不再有 `test:e2e:web`，且 `check:docs`、`acceptance-matrix`、`npm test` 通过。

### 8.3 云端

见 §6.3。

### 8.4 真机

见 §7.3，另加：
- 分享卡：`GET /v1/workouts/:id/share-card` 返回 200（`APIClient.swift:270`）。
- 成绩摘要：`GET /v1/exports/workout-summary?from=&through=` 返回 200（`APIClient.swift:284`）。
- 同步：`POST /v1/imports/uploads` → `/v1/imports/inspect` → `/v1/import-jobs` → `GET /v1/import-jobs/{id}`，回执 `committed`。

### 8.5 反例（必须失败，用于证明门禁还在）

```bash
# 故意在 nginx 里加回 SPA 回退 → deploy-cloud.test 必须红
# 故意把 apps/web 引用加回 package.json → check:scripts / npm test 必须红
# 故意删掉 dataset-epoch.test.ts 里的 B02 → check:acceptance-matrix 必须红
```

---

## 9. 回滚

| 批次 | 回滚动作 | 说明 |
|---|---|---|
| B0 | revert 文档提交 | 无代码影响 |
| B1 | revert；`dev:device` 恢复 5173 双起 | Web 尚在，旧开发流立即恢复 |
| B2 | 恢复 `/etc/nginx/conf.d/rai.conf`、`/etc/systemd/system/rai-api.service`、`/opt/rai/deploy`；`nginx -t && systemctl reload nginx`；`daemon-reload && restart` | 先恢复入口，再恢复代码 |
| B3 | 单 PR revert（含 lock） | 若已上云：先回退配置，再回退代码；`npm ci` 重装 |
| B4 | revert；重新构建 iOS | 旧 macOS 壳在 Web 已删后不可用（D1 选择 A 的必然结果） |
| B5 | revert 文档 | 无代码影响 |
| B6 | 按 B2/B3/B4 回滚；必要时回退 iOS 到上一个 tag | 健康检查恢复即视为回滚完成 |

**总原则**：先恢复入口（nginx/systemd）→ 再恢复代码（git revert）→ 最后恢复数据（仅在恢复操作失败时用备份）。数据库迁移**不在本计划范围**，任何 `data:migrate` 必须单独授权（`deploy/upgrade.sh` 默认不自动迁移）。

---

## 10. 风险登记

| 级别 | 风险 | 触发信号 | 缓解 |
|---|---|---|---|
| 🔴 R1 | 功能让渡是产品决策：恢复通道（D3）、成绩录入/隐私区（D4）在 iOS 无入口 | 上线后有人要「恢复备份/录成绩/改隐私区」 | D 项逐条拍板；恢复走运维 curl；其余列入 §11 |
| 🔴 R2 | 开发流从 vite 代理切直连后，真机 403 | 真机日志 `untrusted_origin` | B1 注入开发 Token 并打印；`RAI_API_HOST=0.0.0.0` |
| 🔴 R3 | 删除必须原子：门禁测试与目录同生共死 | `npm test` 在中间提交红 | §4.3 清单；不拆批 |
| 🔴 R4 | 唯一浏览器级 E2E 消失（1973 行） | 后端语义回归无自动覆盖 | D7：迁移 4 类用例到 API 级（§11.1）；其余转人工 |
| 🔴 R5 | B2 与 B3 顺序颠倒导致线上服务起不来 | `systemctl restart` 失败、`ExecStartPre` 非 0 | 严格 B2 → B3；发布前 `systemctl daemon-reload` |
| 🟡 R6 | `check:docs` 因删 `docs/WEB.md`/`ARCHITECTURE:44` 变红 | CI `verify` 文档步红 | B3 同批删 `README.md:69`、`ARCHITECTURE.md:44` |
| 🟡 R7 | 验收矩阵 B02 失去唯一引用 | `missing=1` | B3 第一步把 B02 挂到 `dataset-epoch.test.ts:11` |
| 🟡 R8 | lock 与 package.json 不一致 | CI `npm ci` 报 lock 不同步 | 删依赖与刷 lock 同提交 |
| 🟡 R9 | macOS 壳残余引用（`ChromeController` 等） | `npm run test:ios` 类型检查红 | B4 先搬/删 `ChromeController` 再删 `AppWebView.swift` |
| 🟡 R10 | nginx 改错导致 API 不可达 | 502/504、`nginx -t` 失败 | 先备份、`nginx -t` 再 reload；保留 3600s 超时，**不要**按 v1 改成 120s |
| 🟡 R11 | ICP 备案主体域名无页面 | 备案核查 | D6；必要时保留最小静态页 |
| 🟡 R12 | 契约见证面收窄（`@rai/api-contracts` 消费方从 web+api 变 api 单端） | 契约变更无 Web 侧回归 | iOS 侧对照 `docs/IOS_NATIVE_API_CONTRACT.md` 手工流程；契约变更回归纪律上移 |
| 🟢 R13 | `smoke:api` 在本机因 `onnxruntime-node` 未签名失败 | exit 13 | 环境问题，与 Web 无关；CI ubuntu 不受影响；换签名/重装依赖 |

---

## 11. 遗留与后续工作（本计划不闭环）

### 11.1 E2E 补偿（D7）

`apps/web/e2e/web-flows.test.ts` 1973 行覆盖的后端语义（反馈终态、分区冲突、导入流程、分享卡、导出）建议迁移为 `node --test` 级集成测试：
- 起 API（`node --import tsx apps/api/src/server.ts` + 临时 `RAI_RUNTIME_ROOT`/`RAI_DATABASE`）；
- 用 `fetch` 覆盖 `POST /v1/commands`、`/v1/import-jobs`、`/v1/exports/workout-summary`、`/v1/workouts/:id/share-card`；
- 先迁移 4 个最高价值用例，其余列入人工回归清单。

### 11.2 产品能力缺口（D3/D4）

- 恢复通道：已给运维 curl 流程；若产品要 App 内恢复，列入 iOS 后续（`POST /v1/backups/:name/restore` 已保留）。
- 成绩录入/撤销（`performance-entries`）：预测校准标签来源，iOS 无入口 → 列入 iOS 排期或运维 CLI。
- 隐私区编辑（`privacy-zones`）：iOS 分享卡消费裁剪结果但无编辑入口 → 列入 iOS 排期。

### 11.3 其他

- `RAI_PUBLIC_HOSTS` 匿名只读：Web 退役后默认关闭；是否保留代码由安全评审决定（D5）。
- `docs/ARCHITECTURE.md:23`、`apps/ios/README.md:5`、AGENTS.md 的 WKWebView 叙述必须在 B0/B5 改掉，否则与代码再次不符。
- `deploy/README-UBUNTU.md:67` 的 `TechSetupView.swift:45-56` 行引用：B5 改文档时顺手核对（该文件在 `check-doc-line-refs` 的漏登记清单里）。

---

## 附录 A — 端点处置清单（`9a1e2c8`，83 条方法+路径）

### A.1 iOS 在用（必须保留，40 条）

`GET /v1/health`、`GET /v1/handshake`、`POST /v1/imports/uploads`、`POST /v1/imports/inspect`、`POST /v1/import-jobs`、`GET /v1/import-jobs/active`、`GET /v1/import-jobs/{id}`、`DELETE /v1/import-sources/{id}`；
`/v1/mobile/today`、`/v1/mobile/statistics`、`/v1/mobile/trends`、`/v1/mobile/goals`（GET/PUT）、`/v1/mobile/run-coach`（GET/POST）、`/v1/mobile/coach-loop`（GET/POST）、`/v1/mobile/coach-loop/synced`、`/v1/mobile/coach-feedback`、`/v1/mobile/coach-prediction-refresh`、`/v1/mobile/workout-plan`（GET）、`/v1/mobile/workout-plan/preview`、`/v1/mobile/workout-plan/synced`、`/v1/mobile/workout-plan/confirm`、`/v1/mobile/training-plan-state`、`/v1/mobile/plan-operations/{id}`、`/v1/mobile/lock`；
`GET /v1/predictions`、`GET /v1/recovery-trends`、`GET /v1/dashboard`、`GET /v1/training-zones/current`、`GET /v1/training-statistics/overview`、`GET /v1/workouts`、`GET /v1/workouts/{id}`、`GET /v1/workouts/{id}/series`、`GET /v1/workouts/{id}/share-card`、`POST /v1/commands`、`GET /v1/commands/{id}`、`GET /v1/jobs/{id}`、`GET /v1/exports/workout-summary`。
证据：`apps/ios/RAI/APIClient.swift:105,125,134,138,143,150,154,158,168,209,213,222,226,230,234,238,257,261,265,270,274,277,280,284`；`HealthKitSync.swift:2588,2623,2647,2665,2675-2679,2777`；`ServerSession.swift:179`。

### A.2 仅 Web 在用（36 条，默认保留）

备份与恢复：`GET /v1/backups`、`GET /v1/backups/{name}`、`POST /v1/backups/{name}/restore`；
任务：`GET /v1/jobs`、`POST /v1/jobs/{id}/cancel`；
模型/预测管理：`/v1/model-runs`（GET/POST）、`POST /v1/model-runs/{id}/activate`、`POST /v1/model-runs/compare`、`GET /v1/model-snapshots`、`GET /v1/prediction-models`、`GET /v1/prediction-models/{id}`、`POST /v1/prediction-models/train`、`POST /v1/prediction-models/{id}/activate`、`POST /v1/prediction-models/{id}/cancel`；
数据运维：`GET /v1/data-summary`、`GET /v1/database`、`GET /v1/diagnostics`、`GET /v1/runtime-status`；
审计：`GET /v1/data-audit`；
导入管理：`GET /v1/import-jobs/latest`、`GET /v1/import-sources/discover`；
深读统计：`GET /v1/trends`、`GET /v1/training-statistics/history`、`GET /v1/training-statistics/load`、`GET /v1/training-zones/profile`、`GET /v1/training-zones/history`；
成绩/隐私：`/v1/performance-entries`（GET/POST/DELETE）、`GET /v1/label-funnel`、`/v1/privacy-zones`（GET/PUT）；
移动 Web 私有：`PATCH /v1/workouts/{id}/override`。

### A.3 两边皆无（7 条，含运维遥测）

其中 `GET /v1/performance`（`server.ts:969-972`）是 telemetry 快照，仅测试引用（`server-runtime.test.ts:1600,1713`），**不属于 Web 清理对象**。本组其余 6 条是备份/恢复的边界方法与运维端点：`POST /v1/backups/:name/restore` 已归入 A.2（Web 在用），删端点的判断必须逐条复核，不能按「Web 专用」名义批量删。

### A.4 packages（16 个全部保留）

`api-contracts`、`application`、`contracts`、`durability`、`dynamics`、`features`、`health-export-parser`、`model-eval`、`normalization`、`physiology`、`prediction-inference`、`readiness`、`scoring`、`storage-sqlite`、`training-load`、`training-zones`。
Web 侧只 import `@rai/api-contracts`；其余 15 个包由 API 直接或经 `application` 传递引用。

---

## 附录 B — 改动文件清单（按批次）

### B0
`AGENTS.md`（§Supported Product、删两整节、Default Verification）、`docs/adr/ADR-006-retire-web-and-macos.md`（新增）、本文档决策记录。

### B1
`scripts/dev-device.mjs`（重写）、`scripts/mobile-smoke.sh`（Origin 去掉）、`apps/ios/RAI/ServerDiscovery.swift:71`、`apps/ios/RAI/Skins/Technology/TechSetupView.swift:46`、`apps/ios/RAI/Skins/Technology/TechViews.swift:2195`；可选 `apps/ios/RAI/Info.plist`、`apps/ios/RAI/ServerSession.swift`、`apps/ios/RAI.xcodeproj/project.pbxproj`（B1.4）。

### B2
`deploy/rai-api.service:15`、`deploy/n100/rai-api.service:15`、`deploy/nginx-rai.conf`（重写）、`deploy/n100/nginx-rai.conf:25-26`（+可选 `/` 改 404）、`deploy/upgrade.sh:3,105-106,118`、`deploy/README-UBUNTU.md`（≥18 行）、`deploy/rai.env.example`、`deploy/n100/rai.env.example`、`apps/api/test/deploy-cloud.test.ts:40-46`。

### B3
删除：`apps/web/**`（92）、`apps/api/src/web-assets.ts`、`apps/api/test/web-assets.test.ts`、`scripts/check-web-build.mjs`、`docs/WEB.md`。
修改：`package.json`、`package-lock.json`、`scripts/run-tests.mjs`、`apps/api/src/server.ts:12,452-455`（可选 `:215-221,:228-232,:396,:399`）、`apps/api/package.json:15`、`apps/api/test/node-version.test.ts:40,48,64`、`apps/api/test/dataset-epoch.test.ts:11`、`packages/application/test/cross-platform-scripts.test.ts:42`、`tsconfig.json`、`README.md:69`、`docs/ARCHITECTURE.md:44`、`.github/workflows/ci.yml`、`.workflow/master-ci.yml`。

### B4
`apps/ios/RAI.xcodeproj/project.pbxproj`（`:263,:325,:344,:348,:361-364,:376,:398,:402,:415-418,:430`）、`apps/ios/RAI/AppWebView.swift`（删）、`apps/ios/RAI/RootView.swift`、`apps/ios/RAI/RAIApp.swift:12,50,93-95`、`apps/ios/RAI/ServerSession.swift:77-81`、`apps/ios/tests/typecheck-ios.sh:56`；可选新增 `apps/ios/RAI/ChromeController.swift`（仅保留方案）。

### B5
`README.md`、`docs/ARCHITECTURE.md`、`docs/OPERATIONS.md`、`docs/IOS_NATIVE_RUNBOOK.md`、`docs/ALGORITHM.md:433`、`docs/PROJECT_REVIEW.md`（顶部一行）、`apps/ios/README.md:5,14`、`deliverables/README.md`、`docs/adr/ADR-006-…`。

---

## 附录 C — 核对与验证命令

### C.1 行号核对（开工前跑一遍）

```bash
# 关键行号是否仍指向预期内容（输出应包含注释里的关键词）
sed -n '452,455p' apps/api/src/server.ts          # webDist / registerWebAssets
sed -n '215,221p' apps/api/src/server.ts          # RAI_WEB_PORT / developmentOrigins
sed -n '40,46p'  apps/api/test/deploy-cloud.test.ts
sed -n '93,105p' deploy/nginx-rai.conf            # SPA 静态块
sed -n '13,18p'  deploy/rai-api.service           # ExecStartPre
grep -n "npm run build\|test:e2e:web" .github/workflows/ci.yml .workflow/master-ci.yml
grep -n "dev:web\|prestart\|test:e2e" package.json
grep -n "SUPPORTED_PLATFORMS\|MACOSX_DEPLOYMENT_TARGET" apps/ios/RAI.xcodeproj/project.pbxproj
```

### C.2 全仓悬挂引用检查（B3/B4/B5 收尾跑）

```bash
# 应只剩 deliverables 历史快照与 .archify（按纪律不改）
grep -rn "apps/web\|@rai/web\|test:e2e:web\|playwright-core\|check-web-build\|RAI_WEB_PORT\|dev:web" \
  --include='*.json' --include='*.mjs' --include='*.ts' --include='*.tsx' --include='*.md' \
  --include='*.yml' --include='*.sh' --include='*.conf' \
  . | grep -v node_modules | grep -v '^./deliverables/' | grep -v '^./.archify/' | grep -v '^./var/'
```

### C.3 门禁命令

```bash
npm run typecheck
npm test
npm run test:ios
npm run check:docs
npm run check:doc-refs
npm run check:scripts
npm run check:acceptance-matrix
npm run check:package-boundaries
npm run smoke:api
npm run rust:verify
npm run ml:test
```

---

## 附录 D — 纠错记录（v1 / 旧方案里不可照抄的条目）

### D.1 v1 草案（`9a1e2c8` 同路径文件）的错项

| v1 位置 | 错误 | 本版修正 |
|---|---|---|
| §步骤 1、§步骤 4、§步骤 7 多处 | 只写了 `scripts/run-tests.mjs`，漏掉其余跨包门禁：`cross-platform-scripts.test.ts:42`、验收矩阵 B02、`web-assets.test.ts`、`deploy-cloud.test.ts:40-46`、`upgrade.sh:105-106`、`.workflow/master-ci.yml:34` | 已补进 §4.3 与 B3 |
| §步骤 2 nginx 替换稿 | 丢掉 `limit_req`、`robots.txt`、ACME、`proxy_request_buffering off`；把 `proxy_read_timeout` 从 3600s 收紧到 120s（会导致长导入 504）；称「原值 4g」（实际 `:49` 是 1m，4g 只在 uploads `:82`） | B2 改为「减 SPA」，保留全部非 Web 指令与 3600s |
| §步骤 3 | 称 `/v1/performance` 是 Web 专用 | 实际两边皆无（运维遥测） |
| §步骤 3 | 未提删路由所需的测试/schema/openapi 联动 | 见 B7 |
| §步骤 4 | 建议删 `lib: DOM/DOM.Iterable` | **不删**：会让 `server-runtime.test.ts` 42 处报错；只删 `jsx` 与 `apps/**/*.tsx` |
| §步骤 6 | `ServerSession.swift:7-12` 是 `rai.serverURL` 的 key 位置 | key 在 `:59`；`:7-14` 是写入逻辑 |
| §步骤 6 | 「如需开发期 HTTP 须配 `NSExceptionDomains`」 | 已有 ATS 段（`Info.plist:11-17`，`NSAllowsLocalNetworking=true`）；Release 强制 https 的是应用代码（`ServerSession.swift:106-108`） |
| §步骤 6 | 把 72 MiB 当作 ZIP/单批上界 | 无此常量；ZIP 端点 64 MiB，8/64 MiB 是解析上界 |
| §步骤 7 | 把 `AppWebView` 说成「只是 macOS 分支」 | 双平台文件，iOS 侧是死代码但仍被编译/门禁检查 |
| §步骤 7 | 假设 pbxproj 里有 `AppWebView.swift` 的 Sources 条目 | 工程用文件系统同步组，无逐文件列表 |
| §三 | 只提 `prestart` 调用 `check-web-build` | 还有两个 systemd unit `:15` |
| §四 执行顺序 | iOS 切换排在 nginx 之后 | B1 先切（Web 仍在，可回退） |
| §七 风险 | 「CI smoke 因 check-web-build 消失而行为变化」 | 不成立：`smoke:api` 走 `presmoke:api`，从不经过 `prestart` |

### D.2 旧方案（`WEB_DESKTOP_REMOVAL_PLAN_2026-10-15.md`）的错项

| 旧方案位置 | 错误 | 本版修正 |
|---|---|---|
| `:3`/README 索引 | 自称「待评审」，v1 称其「已评审」 | 两份均未授权；本版统一表述 |
| `:59` | `deploy/README-UBUNTU.md`「7 处 web 叙述」 | 实测 ≥18 行 |
| `:124` | 「`check:doc-refs` 默认 7 份文档」 | 实际 8 份（`check-doc-line-refs.mjs:79-94`） |
| `:66` | 把 `ServerSession.swift:78` 当作 iOS 默认服务地址 | 该行在 `#if os(macOS) && DEBUG`；iOS 默认空串 |
| `:51` | `RootView.swift:51` 指 `AppWebView` | 调用在 `:51-58`，`#else` 在 `:49` |
| `:56` | nginx 证据只列 `:5,53,121` | 补 `:95-104`、`:80-91` 与 n100 `:25` |
| `:232` 附录 A | 头写「≈16」但列 27 个路径 | 本版附录 B 按批次重列 |
| 全文 | 未提 n100 service `:15` | 本版 §B2.1 覆盖两个 unit |

---

## 附录 E — 执行记录（2026-10-17）

授权：用户当日指示「帮我按计划推进」，按本文档默认决策（D1 移除 macOS、D2 保留全部端点、D5 保留匿名只读代码但清掉开发源、D6 根路径 404、D9 保留并改写 dev:device）执行。回滚锚点：tag `pre-web-retirement`（B0 之前）。

| 批次 | 提交 | 内容 | 验收 |
|---|---|---|---|
| 文档 v2 | `0eda1e9` | 本实施文档合并重写 | check:docs 0 problem |
| B0 | `6f8e6ca` | AGENTS.md 口径、DECISIONS D17、ADR-006 | pre-commit 全绿 |
| B1 | `fd25f8c` | dev:device 只起 API + 开发 Token；Bonjour/占位符 8787；smoke 去掉 Origin | `test:ios` 通过 |
| B2 | `fd10daf` | 两个 systemd 去 check-web-build；nginx 纯 /v1 反代；upgrade.sh 去 build；部署文档/env；deploy-cloud.test 重写 | deploy 三个测试 14/14 |
| B3 | `c7079bb` | 删 apps/web（92 文件）与静态托管、门禁/CI/tsconfig/docs 联动、lock 重生成（429→153 包，无版本漂移） | typecheck、npm test、check:*、验收矩阵全绿 |
| B4 | `7d8e329` | pbxproj 只留 iOS；删 AppWebView/ChromeController/NativeBridgeSnapshot；RootView/RAIApp/ServerSession 收敛 | `test:ios` 通过；xcodebuild 模拟器构建成功；showdestinations 无 macOS |
| B5 | `b95993e` | README/ARCHITECTURE/OPERATIONS/RUNBOOK/ALGORITHM/PROJECT_REVIEW 与索引收尾 | check:docs / check:doc-refs / 验收矩阵 |

**B6 本地终验（2026-10-17，本机）**：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test`（全量 Node 套件） | 1969 项：**1963 通过 / 3 失败 / 3 跳过**；3 项失败均为**基线既存**（`workout-summary-export.test.ts:37` 断言的字面量在 `9e08301` 已被移除；`native-worker.test.ts` 2 项跑的是 2026-09-22 的旧 Rust 二进制，`crates/` 在 10-16/17 改过且本机无 cargo） |
| `npm run check:docs` / `check:doc-refs` | 73 文件 554 链接 0 问题；138 处行号引用 0 越界 0 漂移 |
| `check:scripts` / `check:acceptance-matrix` / `check:package-boundaries` | 18 manifest·104 script 通过；77/77 cited；包边界通过 |
| `npm run smoke:api` | **通过**（生产启动/退出契约；不再依赖 web dist） |
| `npm run test:ios` + `xcodebuild -sdk iphonesimulator` | 通过；工程 destination 已无 macOS |
| `npm ci --dry-run` | lock 与 package.json 同步（干净安装会移除 225 个旧依赖） |
| 悬挂引用 | 代码/脚本/配置/现行文档中无 `apps/web`、`@rai/web`、`check-web-build`、`test:e2e:web`；仅 AGENTS.md 的 Retired Surfaces 明确禁止重建 |

**B6 云端配置层（2026-10-17 20:54 CST，已生效）**：

| 项 | 结果 |
|---|---|
| 变更 | `/etc/nginx/sites-available/rai` 与 `rai-ip` 删除 `root/index.html/favicon/assets/SPA` 回退（保留 `/v1/`、uploads、`/wb2api/`、`/panel/`、robots、限速、TLS）；`rai-api.service` 删除 `check-web-build.mjs` 前置检查 |
| 备份 | `/root/rai-retire-backup-20261017-205451/`（两个 nginx 站点 + unit + `git-head.txt`） |
| 验证 | `nginx -t` 通过；服务 active；`/v1/health`=200 且 `databaseReady:true`；`/v1/handshake`、`/v1/mobile/today`、`/v1/workouts?limit=1` 均 200；匿名 health=200（`RAI_PUBLIC_HOSTS` 保持原值）；`/`、`/index.html`、`/assets/*`、`/settings`、`/workouts` 全部 **404**；IP 站点 `/`=404、`/v1/health`=200 |
| 重启耗时 | API 约 19s 完成启动（2.3G 主库），期间 nginx 短暂 502 |
| 未删除 | 服务器上的 `apps/web/dist`（仍被旧代码的 `check-web-build` 不再检查；保留作回滚，等代码层部署后再删） |

**B6 云端代码+数据层（2026-10-17 21:06 CST，已上线）**：

| 项 | 结果 |
|---|---|
| 代码 | 服务器 `2e7a231` → `6ed6fa4`（fast-forward 44 个提交，含 36 个未发布的同步优化与本次 8 个退役提交）；`git status` 干净 |
| 依赖 | `npm ci`（镜像 `registry.npmmirror.com`，`ONNXRUNTIME_NODE_INSTALL=skip`）新增 109 包；`vite`/`playwright-core` 已消失 |
| 备份 | ① 运维一致性备份 `/var/lib/rai/var/backups/rai.before-v45.20261017-210024.sqlite`（2.3G，`quick_check: ok`）；② 迁移 CLI 自动备份 `rai.before-v38.2026-10-17T13-05-55-774Z.sqlite`；③ 配置备份 `/root/rai-retire-backup-20261017-205451/` |
| 迁移 | v37 → **v45**（8 个迁移，纯 DDL），耗时 61s；`foreignKeyCheck: ok`；行数不变（288 训练 / 53.2 万健康记录 / 24.4 万路线点）；API 约 6s 就绪 |
| 清理 | `/opt/rai/apps/web`（仅剩 dist）已删除，`/opt/rai/apps` 只剩 api/ios |
| 验收 | `/v1/health` 200 且 `databaseReady:true`；`/v1/handshake` 已宣告 `directSyncBounds`（8 MiB XML / 5000 records / 200 route files / 64 MiB route）；`/v1/mobile/today`、`/v1/mobile/training-plan-state`、`/v1/mobile/statistics`、`/v1/predictions`、`/v1/workouts?limit=1`、`share-card`、`/v1/exports/workout-summary` 全部 **200**；`/`、`/index.html`、`/assets/*`、`/settings` 全部 **404**（部署当时匿名 health 仍 200，随后已按下方「匿名读关闭」收紧） |
| 运行证据 | 部署后 `deploy/check-runtime-readonly.sh` 曾给出 ACTION「匿名健康读取仍配置」；置空 `RAI_PUBLIC_HOSTS` 后重跑：`anonymousReadsConfigured:false`、`apiTokenConfigured:true`、ActiveState=active、无 ACTION |

**匿名读关闭（2026-10-17 21:14 CST，已生效）**：

- 变更：`/etc/rai/rai.env` 的 `RAI_PUBLIC_HOSTS` 由 `tpandmr.xyz,101.33.202.40` 改为空；备份 `.../rai-retire-backup-20261017-205451/rai.env.before-public-hosts-clear.20261017-211438`；重启后 API 约 6s 就绪。
- 验证：无 Token 的 `/v1/health`、`/v1/mobile/today`、`/v1/workouts`、`/v1/trends`、`/v1/predictions` 全部 **401**（响应 `{"code":"unauthorized",...}`）；带 Token 的同批接口与 `/v1/handshake` 全部 **200**；Web 路径仍 404。
- 容器回归：`workbuddy2api`（LLM API 面板）仍 `healthy`、`frps` 仍 Up；`/panel/` 经 nginx 200；两者本就不调用 RAI API（RAI 日志 Host 只有域名/IP/loopback，nginx `/v1` 客户端只有 iOS App、curl 与扫描器），置空不影响它们。
- 回滚：把原值写回 `RAI_PUBLIC_HOSTS=tpandmr.xyz,101.33.202.40` 并 `systemctl restart rai-api`。

**遗留**：

- 真机验收：HealthKit 同步、分享卡、成绩摘要仍需 iPhone 端跑一遍（API 侧已验证 200）。
- 回滚：停服 → 恢复 `rai.before-v45.*.sqlite` → `git reset --hard 2e7a231` → `npm ci`（旧 lock）→ 重启；配置回滚用 `/root/rai-retire-backup-20261017-205451/`。

**未完成 / 需在真实环境执行**：

- 真机验收（需 iPhone + 云端 API；云端现已是最新 API）。
- 本机环境备注（不影响仓库结论）：该机 PATH 无 npm，验证用官方 Node 24.21 + 下载的 npm CLI；`onnxruntime-node` 原生库因未签名无法加载，已用 `codesign --force --sign -` 临时签名 + 官方 Node（关闭 library validation）跑通全量 Node 套件与 smoke。

> **执行完成后的收尾**：按 [deliverables/README.md](README.md) 的约定，本文档应归档或删除；执行证据（门禁输出、云端 curl、真机截图）另存或在 PR 中引用，不要把证据回写进本文档。
