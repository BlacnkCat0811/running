# Web 与 macOS 退役方案（三端收敛为「iOS + 后端」）

> **状态：待评审（未执行）** · 编制 2026-10-15 · 证据基线：工作树 `8081ed6`
> **编制方式：只读分析** —— 未修改任何代码、未运行任何门禁或测试；文中 `文件:行号` 均为基线实测值，
> 开工前若源码已变动需重新核对。
> 生命周期：属"当轮实施锚定文档"；执行完成后按 [本目录约定](README.md) 归档或删除。

## 一、目标与范围

### 1.1 目标形态（保留物）

| 保留 | 说明 |
|---|---|
| `apps/ios` | SwiftUI 原生 iOS App（唯一客户端）。**移除其 macOS 平台支持与 WKWebView 壳**（§2.5、Step 5） |
| `apps/api` | Fastify 后端。全部 `/v1` 端点保留（含现仅 Web 使用的 31 条，**不裁剪**） |
| `packages/*`（16 个） | scoring、readiness、dynamics、features、physiology、prediction-inference、training-load、training-zones、normalization、model-eval、durability、health-export-parser、application、storage-sqlite、contracts、api-contracts |
| `crates/` + Rust 工具链 | Rust 数据执行器（生产已启用，见 [RUST_DATA_ENGINE](../docs/RUST_DATA_ENGINE.md)） |
| `research/` | ML 训练脚本（Python，`npm run ml:*`） |
| `scripts/`、`deploy/` | 门禁与部署链（按 Step 2/3 改造后保留） |

### 1.2 移除物

| 移除 | 规模 |
|---|---|
| `apps/web` 工作区 | 92 个跟踪文件（59 src / 25 test / 1 e2e / 7 配置）；含桌面 SPA、移动 Web 壳（src/ios/）、Playwright E2E |
| macOS 平台与 WKWebView 壳 | `apps/ios` 的壳文件 + 视图分支 + Xcode 工程配置（§2.5） |
| Web 专用依赖与门禁 | react 系 / vite / vitest / jsdom / playwright-core / concurrently；`build`、`test:e2e:*` 等脚本；CI 两处步骤 |
| Web 专用文档 | `docs/WEB.md`（含 README 链接行） |

### 1.3 明确不做（执行期防越界）

- **不裁剪任何后端端点**：31 条 web-only 端点的后端实现全部保留（供未来 iOS 扩展或 CLI 使用）。
- **不改 `packages/*` 任何算法/模型代码**（scoring、prediction-inference、model-eval 等一字不动）。
- **不改数据库 schema / 迁移**（`packages/storage-sqlite` 零改动）。
- **不动**历史时点产物：`deliverables/`、`output/`、`.archify/`（按纪律，时点快照不回写）。
- 不改 iOS 原生业务链（HealthKit 同步、教练、计划）——唯一例外是"服务地址默认值"（Step 1）。

### 1.4 "桌面端"的定义（已拍板：含 macOS）

仓库内**不存在独立桌面端产品代码**（无 Electron/Tauri 等）。"桌面端" = ① Web 的桌面浏览器形态（随 apps/web 移除）；② **iOS 工程的 macOS 平台支持 + WKWebView 壳**（本次一并移除）。Web 内部的移动皮肤（`apps/web/src/ios/*` 与 `dataset.shell='ios'` 分发）只是 Web 的一个分支形态，随 apps/web 移除。

## 二、现状耦合面（证据 @8081ed6）

### 2.1 运行时（API ↔ Web）

| 耦合点 | 证据 | 处置 |
|---|---|---|
| API 托管 web dist | `apps/api/src/server.ts:452-454`（`webDist` + `registerWebAssets`）；`apps/api/src/web-assets.ts`（@fastify/static、SPA 回退白名单） | 删装配 + 删模块 + 删测试 |
| CORS 开发源 | `server.ts:222` 段（`RAI_WEB_PORT` 默认 5173、`developmentOrigins`、`allowPrivateLanWebPort`）；`apps/api/test/local-request-security.test.ts` 以 5173 断言 | 收敛（iOS 原生无 Origin 头，不受影响） |
| 匿名只读模式 | `server.ts` 的 `RAI_PUBLIC_HOSTS` 只读白名单（注释明确为"浏览器打开即看"而设） | 独立安全决策（§四 R6），不与删除同批 |

### 2.2 部署（nginx / systemd / 升级脚本）

| 耦合点 | 证据 | 处置 |
|---|---|---|
| nginx 托管 dist + SPA 回退 | `deploy/nginx-rai.conf:5,53,121`（root `/opt/rai/apps/web/dist`） | 重写为纯 `/v1` 反代；`location /` 改 404 或最小页（备案决策，§七） |
| systemd 前置检查 | `deploy/rai-api.service:15`（`ExecStartPre=check-web-build.mjs`） | 删除该行 |
| 升级脚本重建前端 | `deploy/upgrade.sh` 第 4 步 `npm run build` | 删除该步 |
| 部署文档 | [deploy/README-UBUNTU.md](../deploy/README-UBUNTU.md)（7 处 web 叙述） | 更新 |

### 2.3 开发流（★ 最关键的隐藏耦合）

| 耦合点 | 证据 | 处置 |
|---|---|---|
| vite 代理 | `apps/web/vite.config.ts:21,30,32`：5173 端口，`/v1` → `127.0.0.1:8787` | 随 web 移除 |
| **iOS 默认服务地址 = vite 代理端口** | `apps/ios/RAI/ServerDiscovery.swift:71`（默认 5173）、`ServerSession.swift:78`（默认 `http://127.0.0.1:5173`）、`TechSetupView.swift:46`、`TechViews.swift:2195`（占位符 `:5173`） | **Step 1**：改指 API 端口并真机验证 |
| 真机调试脚本 | `scripts/dev-device.mjs:78`（起 `dev:lan -w @rai/web`、dns-sd 广告 5173） | 改为只起 API（LAN 监听）并广告 API 端口 |
| 烟测 Origin | `scripts/mobile-smoke.sh:6`（`ORIGIN=http://127.0.0.1:5173`） | 随 CORS 收敛处理 |

> **为什么这是唯一的行为级改动**：当前 iPhone 上的 RAI App 填 `:5173` 能工作，是因为 vite dev server 把 `/v1` 代理到 API（8787）。移除 web 后 iOS 必须直连 API（`RAI_API_HOST`/`RAI_API_PORT` 可配，见 nginx 配置头注释）。注意区分"监听地址（LAN 可达）"与"CORS 白名单（浏览器跨源）"——iOS 原生只需要前者。

### 2.4 门禁与 CI

| 耦合点 | 证据 | 处置（Step 3） |
|---|---|---|
| 双测试套件 | `scripts/run-tests.mjs` 末尾 Web vitest 段（约 :97-102） | 去 Web 套件 |
| Node 版本门禁 | `apps/api/test/node-version.test.ts:40,48`（`dev:web` 列表与 `apps/web/package.json` 遍历） | 同步删改 |
| 跨平台脚本门禁 | `packages/application/test/cross-platform-scripts.test.ts:42,81`（断言 `build`/`test:e2e:web`） | 同步删改 |
| 文档门禁 | `scripts/check-doc-links.mjs:54`（全仓 md 须从 README 可达、链接有效） | 删 `docs/WEB.md` 时摘除 README 链接 |
| CI | `.github/workflows/ci.yml` 三处（windows-runtime 的 `npm run build`；verify 的 `test:e2e:web`；生产依赖契约 `test ! -e node_modules/.bin/vite`）；`.workflow/master-ci.yml:34`（`npm run build`） | 同步删改 |

### 2.5 macOS 壳与平台（apps/ios）

| 耦合点 | 证据 | 处置（Step 5） |
|---|---|---|
| 平台声明 | `RAI.xcodeproj/project.pbxproj:376,430`（`SUPPORTED_PLATFORMS` 含 `macosx`）；`:263,325`（`MACOSX_DEPLOYMENT_TARGET=14.0`）；`:361,415`（`LD_RUNPATH_SEARCH_PATHS[sdk=macosx*]`） | 去 macosx，保留 iPhone 配置（`:377,431` `SUPPORTS_MACCATALYST=NO`、`:385,439` `TARGETED_DEVICE_FAMILY=1` 不动） |
| 非 iOS 壳分支 | `RootView.swift:51`（`connectedView` 的 `#else` 编译 `AppWebView`；iOS 分支为 `NativeRootView`） | 删 `#else` 分支 |
| WKWebView 壳 | `AppWebView.swift`：`:54` iOS 版（当前无调用方）、`:84` macOS 版；`:376` 注入 `dataset.shell='ios'` | 删壳；**`ChromeController`（`RAIApp.swift:12`、`RootView.swift` 设置弹窗在用）与 `NativeBridgeSnapshot` 需甄别**——建议保留 `ChromeController`、删 `NativeBridgeSnapshot` 与 Web 桥接 |
| 类型检查覆盖 | `apps/ios/tests/typecheck-ios.sh` 覆盖 `RAI/**` 除 3 个高德依赖文件（`MapPrivacy.swift`/`RAIApp.swift`/`TechRouteView.swift`）；`AppWebView.swift` 在覆盖内（:56 为替身声明） | 删除后残余引用会被 `npm run test:ios` 类型检查抓出 |

### 2.6 端点消费面

- **Web 独有 31 条** / **共享 25 条** / **iOS 独有 12 条**（教练与计划发布链）。
- 共享 25 条由 iOS 兜底，不会出现"端点孤儿"。
- iOS 不消费 `performance-entries`、`privacy-zones`（阳性对照复核）；`training-zones` 仅只读 `current`（`APIClient.swift:234`）。
- 31 条清单来源：对 `apps/web/src` 全量 `/v1` 字面量的穷举去重（93 处），抽样亲验 3 条；执行前按 Step 0 复核。

## 三、功能让渡清单（web-only 31 条 → 处置）

| # | 功能组 | 端点 | 现兜底通道（已核实的写结论） | 处置 |
|---|---|---|---|---|
| 1 | 备份（只读） | `GET /v1/backups`、`GET /v1/backups/:name` | `deploy/backup-runtime.sh` 冷备（运维手工，[运维](../docs/OPERATIONS.md) §备份恢复删除）；`POST`/`DELETE` 已于 2026-10-13 退役为 410 | 接受消失 |
| 2 | **恢复** | `POST /v1/backups/:name/restore` | **无 CLI、无脚本，当前唯一入口是 Web 设置页**；[运维](../docs/OPERATIONS.md) 明确"恢复能力必须保留" | 🔴 保留端点 + 给出新载体（运维脚本或文档化 curl 流程） |
| 3 | 模型管理 | `model-runs`（列表/创建/激活/取消/对比）、`prediction-models`（列表/详情/训练/取消/激活）、`model-snapshots`、`GET /v1/jobs`、`POST /v1/jobs/:id/cancel` | 部分有 CLI：`data:model-v2 --action activate-prediction/rollback/review-baseline/...`（`packages/application/src/model-v2-cli.ts:28,65`）；`model-runs/:id/activate` 的 CLI 通道待确认 | 后端保留；确认/补齐 CLI（或列入 iOS 后续） |
| 4 | 导入管理 | `GET /v1/import-jobs/latest`、`GET /v1/import-sources/discover` | `data:import` CLI 覆盖导入本体；管理面（取消/发现）待确认 | 后端保留（iOS 健康同步主链不受影响） |
| 5 | 数据运维 | `data-summary`、`database`、`diagnostics`、`runtime-status` | 待确认（部分信息可由 `data:audit` CLI 替代） | 后端保留；`runtime-status` 是 iOS 侧潜在增强点 |
| 6 | 数据审计 | `GET /v1/data-audit` | `data:audit` CLI 存在 | 接受消失（CLI 兜底） |
| 7 | 深读统计 | `trends`、`training-statistics/history`、`training-statistics/load`、`training-zones/profile`、`training-zones/history` | 无 CLI（读侧） | 后端保留；iOS 已有部分只读视图，缺口列入后续 |
| 8 | 成绩录入 | `performance-entries`（列表/录入/撤销）、`label-funnel` | 无 CLI | 🔴 iOS 无录入入口（预测证据链的标签来源）；需决策 |
| 9 | 隐私区编辑 | `privacy-zones` | 无 CLI（写路径仅 `apps/api/src/server.ts`+`schemas.ts`） | 🟡 iOS 分享卡消费裁剪结果但无编辑入口（会一直显示"未配置隐私区"）；需决策 |
| 10 | 移动 Web 私有 | `PATCH /v1/workouts/:id/override` | iOS 走 `/v1/commands`（不受影响） | 接受消失 |

## 四、风险与注意事项

| 级别 | 风险 | 对策 |
|---|---|---|
| 🔴 R1 | **功能让渡是产品决策**：恢复通道（#2）、成绩录入（#8）、隐私区编辑（#9）等 iOS 无对应。 | Step 0 逐条拍板；能 CLI 化的进运维手册 |
| 🔴 R2 | **iOS 开发流踩在 vite 代理上**（§2.3）。 | Step 1 先行：切直连 + 真机验证，web 保留可随时回退 |
| 🔴 R3 | **删除必须原子批次**：`node-version.test.ts`、`cross-platform-scripts.test.ts` 等断言在 apps/web 消失瞬间变红。 | Step 3+4 同批提交；每节点须过 pre-commit + `npm test` |
| 🔴 R4 | **唯一浏览器级 E2E 消失**：`web-flows`（1973 行）覆盖反馈终态、分区冲突、导入流程等后端行为语义。 | 把与后端强相关的用例迁移为 API 级集成测试（node --test 直接起 API）；其余转人工 |
| 🟡 R5 | **macOS 壳移除的残余引用**：`ChromeController` 别删错（原生设置弹窗复用）；pbxproj 编辑点多。 | 甄别剥离 + `npm run test:ios` 类型检查兜底；另注意除工程配置外，iPhone App 在 Apple Silicon Mac 上的可运行性还受分发层控制 |
| 🟡 R6 | **CORS / 匿名只读收敛节奏**：属独立安全决策。 | 建议：随 Step 4 关闭匿名只读（`RAI_PUBLIC_HOSTS`）；CORS 保留最小或整体移除，单独评审 |
| 🟡 R7 | **ICP 备案合规**：web 的 `SiteFooter` 承载备案号展示。 | 若域名保留为备案主体，需"保留最小静态页"或处理备案（§七） |
| 🟡 R8 | **文档门禁联动**：`check:docs` 可达性、`check:doc-refs` 默认 7 份文档中的 web 引用、README/AGENTS 重写。 | Step 6 统一处理，全绿收口 |
| 🟡 R9 | **契约见证面收窄**：`@rai/api-contracts` 消费方从 web+api 变 api 单端。 | 契约变更回归纪律上移；iOS 侧对照 `IOS_NATIVE_API_CONTRACT.md` 的手工流程保持 |
| 🟡 R10 | **线上发布顺序**：先解耦上线（旧版无害）→ 再删目录；部署前先查服务器 HEAD 算影响面。 | Step 2 与 Step 4 分开发布；nginx `reload`、service 改后 `daemon-reload` |

## 五、分步实施路径

原则：**先切换行为（可回退）→ 再解耦引用 → 再删除 → 最后收尾**；每步独立提交、独立验收、可单独 revert。

### Step 0 — 决策冻结（无代码改动）

- 逐条拍板 §三 的 3 个 🔴/🟡 处置项（恢复通道、成绩录入、隐私区编辑）。
- 定 R4 的 E2E 补偿清单；定 §七 未决问题。
- **验收**：书面结论存档（可追加到本文档）。
- **回滚**：不适用。

### Step 1 — iOS 连接面切换（web 保留）

改动清单：
- `apps/ios/RAI/ServerDiscovery.swift:71`：dns-sd 默认端口 5173 → API 端口。
- `apps/ios/RAI/ServerSession.swift:78`：默认地址 `127.0.0.1:5173` → API 端口。
- `TechSetupView.swift:46`、`TechViews.swift:2195`：占位符改 API 端口。
- `scripts/dev-device.mjs`：只起 API（LAN 监听，`RAI_API_HOST=0.0.0.0` 语义）并广告 API 端口；删 web 启动行（:78）。
- 文档提示同步（`apps/ios/README.md`、[IOS_NATIVE_RUNBOOK](../docs/IOS_NATIVE_RUNBOOK.md)）。

- **验收**：真机全流程（连接 → 健康同步 → 读数据）直连 API 通过；`npm run test:ios` 类型检查绿（覆盖上述 4 个 Swift 文件的检查在覆盖范围内）。
- **回滚**：改回 5173（web 仍在）。

### Step 2 — API 与部署解耦（web 保留但不再被引用）

改动清单：
- `apps/api/src/server.ts:452-454`：删 `webDist` 装配；`:222` 段 CORS 开发源收缩（`RAI_WEB_PORT` 相关）。
- 删 `apps/api/src/web-assets.ts` 与其测试 `apps/api/test/web-assets.test.ts`。
- `scripts/check-web-build.mjs` 退役：`package.json` `prestart`、`deploy/rai-api.service:15` 同步删。
- `deploy/nginx-rai.conf`：`location /` 改 404 或最小页；删 SPA 回退与 dist root。
- `deploy/upgrade.sh`：删第 4 步 `npm run build`。
- `deploy/README-UBUNTU.md`：更新。

- **验收**：无 `apps/web/dist` 的机器上 `npm start` 与 `npm run smoke:api` 通过；`nginx -t`；`upgrade.sh` dry-run。
- **回滚**：恢复 nginx/service/脚本备份（dist 尚在，未删）。

### Step 3 — 门禁 / CI 解耦（与 Step 4 同批）

改动清单：
- `scripts/run-tests.mjs`：去 Web 套件（只留 Node）。
- `package.json`：删 `build`、`test:e2e:web`、`test:e2e:responsive`、`test:e2e`、`dev:web`、`test:all` 中的 web 项；`dev` 只起 api。
- 测试断言更新：`apps/api/test/node-version.test.ts:40,48`、`packages/application/test/cross-platform-scripts.test.ts:42,81`、`apps/api/test/local-request-security.test.ts`（5173 断言）。
- `.github/workflows/ci.yml` 三处、`.workflow/master-ci.yml:34`。
- `scripts/mobile-smoke.sh:6`。

- **验收**：`pre-commit` 全套 + `npm test` + `npm run typecheck` 绿。
- **回滚**：同批 revert。

### Step 4 — 删除 apps/web + 依赖清理

- 删 92 个跟踪文件（`git rm -r apps/web`）。
- `npm install` 更新 `package-lock.json`；根 devDeps 去 `playwright-core`、`concurrently`（确认无他用）。
- `tsconfig.json`：清 `jsx` 与 DOM lib（可选；不做也能过）。
- 文档门禁联动：`docs/WEB.md` 删除 + README 摘链接（与 Step 6 合并亦可）。

- **验收**：全新 `npm ci` + `npm test` + `npm run typecheck` + `npm run test:ios` + `npm run smoke:api` 全绿；全仓 grep 无悬挂引用。
- **回滚**：单提交 revert。

### Step 5 — 移除 macOS 支持与 WKWebView 壳

改动清单：
- `apps/ios/RAI/RootView.swift:51`：删 `#else` 分支（含 `nativeSnapshot`/`nativeChromeTop` 的壳专用部分，甄别保留原生用途）。
- `apps/ios/RAI/AppWebView.swift`：删除（含 iOS/macOS 两个壳与 `dataset.shell` 注入）；`ChromeController`/`NativeBridgeSnapshot` 按 §2.5 甄别——建议把 `ChromeController` 移入保留文件（如 `RootView.swift`），`NativeBridgeSnapshot` 删除。
- `RAIApp.swift:12`：确认 `ChromeController` 引用；`apps/ios/tests/typecheck-ios.sh:56` 替身同步。
- `RAI.xcodeproj/project.pbxproj`：删 `:376,430` 的 macosx、`:263,325`、`:361,415`（保留 iPhone 配置）。

- **验收**：`npm run test:ios` 全绿（类型检查兜底残余引用）；模拟器构建 + 真机冒烟。
- **回滚**：单提交 revert。

### Step 6 — 文档与资产收尾

- `../AGENTS.md`：重写 Supported Product；删 Supported Web Viewport / Frozen Responsive Areas 两节；Default Verification 去 web 命令。
- `../README.md`：产品描述、当前边界、快速开始（dev/import）、检查段、文档入口表。
- `docs/WEB.md` 删除收尾；`docs/PROJECT_REVIEW.md`、`docs/ALGORITHM.md`、`docs/ARCHITECTURE.md`、`docs/OPERATIONS.md` 中的 web 表述与引用修正。
- `../apps/ios/README.md`（"旧 Web 壳"段）；[deploy/README-UBUNTU.md](../deploy/README-UBUNTU.md)。
- 备案决策落地（§七）。
- **不动**：`deliverables/`、`output/`、`.archify/` 历史快照。

- **验收**：`npm run check:docs`、`npm run check:doc-refs`、`npm run check:acceptance-matrix`、`npm run check:package-boundaries` 全绿。
- **回滚**：按文档 revert。

## 六、验收矩阵（命令清单）

| Step | 命令 | 说明 |
|---|---|---|
| 1 | `npm run test:ios` + 真机手工清单 | 类型检查覆盖 §Step 1 全部 Swift 文件 |
| 2 | `npm run smoke:api`、`nginx -t`、`upgrade.sh` dry-run | 无 dist 前提 |
| 3 | `node scripts/check-npm-scripts-portable.mjs`、`npm run check:docs`、`npm test` | 与 pre-commit 同口径 |
| 4 | `npm ci` + `npm run typecheck` + `npm test` + `npm run test:ios` | 全新安装验证 |
| 5 | `npm run test:ios` + 模拟器构建（人工） | 需 macOS + Xcode |
| 6 | `npm run check:docs` + `npm run check:doc-refs` | 文档门禁 |
| 全案 | `npm run test:all` 的替换形态（typecheck + test + test:ios + ml:test） | 移除 web 后的全量门禁 |

## 七、未决问题（开工前拍板）

1. **恢复通道**（§三 #2）：`/v1/backups/:name/restore` 的新载体——运维脚本 or curl 文档流程？（运维明确"恢复必须保留"）
2. **成绩录入 / 隐私区编辑**（§三 #8/#9）：接受消失，还是列入 iOS 后续功能？
3. **ICP 备案**：域名（若为备案主体）"保留最小静态页"还是处理备案状态？
4. **匿名只读模式**（R6）：建议随 Step 4 关闭（`RAI_PUBLIC_HOSTS`）；CORS 保留最小或整体移除，单独评审。
5. **E2E 补偿**（R4）：迁移哪些 `web-flows` 用例为 API 级集成测试。
6. **发布窗口**：Step 1/2 可搭日常发布；Step 3+4 同批；nginx/service 切换建议维护窗口。

## 附录 A — 必改文件清单（代码/配置，≈16）

`package.json`、`package-lock.json`、`.github/workflows/ci.yml`、`.workflow/master-ci.yml`、`tsconfig.json`（清理）、`apps/api/src/server.ts`、`apps/api/src/web-assets.ts`（删）、`apps/api/test/web-assets.test.ts`（删）、`apps/api/test/node-version.test.ts`、`apps/api/test/local-request-security.test.ts`、`packages/application/test/cross-platform-scripts.test.ts`、`scripts/check-web-build.mjs`（删）、`scripts/run-tests.mjs`、`scripts/dev-device.mjs`、`scripts/mobile-smoke.sh`、`deploy/nginx-rai.conf`、`deploy/rai-api.service`、`deploy/upgrade.sh`、`apps/ios/RAI/AppWebView.swift`（删）、`apps/ios/RAI/RootView.swift`、`apps/ios/RAI/RAIApp.swift`、`apps/ios/RAI/ServerDiscovery.swift`、`apps/ios/RAI/ServerSession.swift`、`apps/ios/RAI/Skins/Technology/TechSetupView.swift`、`apps/ios/RAI/Skins/Technology/TechViews.swift`、`apps/ios/tests/typecheck-ios.sh`、`apps/ios/RAI.xcodeproj/project.pbxproj`。

## 附录 B — 叙述性引用清单（文档，≈15）

`AGENTS.md`（13 处，含两整节）、`README.md`（9 处）、`docs/WEB.md`（整份）、`docs/PROJECT_REVIEW.md`（≈12 处）、`docs/ARCHITECTURE.md`（4 处，含 :44 链接）、`docs/OPERATIONS.md`（3 处）、`docs/ALGORITHM.md`（2 处）、`docs/IOS_NATIVE_RUNBOOK.md`、`docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md`、`docs/SQLITE_DIRECT_SYNC_*`（3 份）、`docs/TODAY_PLAN_CARDS_REVIEW.md`、`docs/COACH_LOOP_OPTIMIZATION_PLAN.md`、`docs/RUN_COACH.md`、`deploy/README-UBUNTU.md`、`apps/ios/README.md`。

## 附录 C — web-only 31 条端点明细（来源：穷举去重，抽样亲验）

- 模型/预测管理（11）：`GET /v1/jobs`、`POST /v1/jobs/:id/cancel`、`/v1/model-runs`（GET/POST）、`POST /v1/model-runs/:id/activate`、`POST /v1/model-runs/compare`、`GET /v1/prediction-models`、`GET /v1/prediction-models/:id`、`POST /v1/prediction-models/train`、`POST /v1/prediction-models/:id/cancel`、`POST /v1/prediction-models/:id/activate`、`GET /v1/model-snapshots`
- 深读统计（5）：`GET /v1/trends`、`GET /v1/training-statistics/history`、`GET /v1/training-statistics/load`、`GET /v1/training-zones/profile`、`GET /v1/training-zones/history`
- 数据运维（4）：`GET /v1/data-summary`、`GET /v1/database`、`GET /v1/diagnostics`、`GET /v1/runtime-status`
- 备份（3）：`GET /v1/backups`、`GET /v1/backups/:name`、`POST /v1/backups/:name/restore`
- 成绩录入（3）：`/v1/performance-entries`（GET/POST/DELETE）、`GET /v1/label-funnel`
- 导入管理（2）：`GET /v1/import-jobs/latest`、`GET /v1/import-sources/discover`
- 审计（1）：`GET /v1/data-audit`
- 隐私区（1）：`/v1/privacy-zones`（GET/PUT）
- 移动 Web 私有（1）：`PATCH /v1/workouts/:id/override`

---

> 本文档为**方案**，不是验收记录；编制过程未运行任何门禁/测试。所有"待确认"项在执行前必须核实到行号或 CLI 实际通道。
