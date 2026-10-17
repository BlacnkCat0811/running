# 移除 Web/桌面端、保留原生 iOS + API 直连实施方案

> 日期：2026-10-17（同日复核修订）
> 前提：后端 API 已部署在云服务器；iOS 原生 App 直连该云 API；移除 Web SPA。仓库无 Electron/Tauri 客户端；但 `apps/ios` 的 Xcode 工程**同时支持 macOS destination**（`SUPPORTED_PLATFORMS` 含 `macosx`、`MACOSX_DEPLOYMENT_TARGET = 14.0`），`RootView` 的 macOS 分支走 `AppWebView`（WKWebView）。因此"移除桌面端"必须先做"保留/删除 macOS target"的显式决定，不能只删 `apps/web`。
>
> ⚠️ **与既有方案的关系**：`deliverables/WEB_DESKTOP_REMOVAL_PLAN_2026-10-15.md` 是更完整的同类方案（含 macOS 平台/WKWebView 壳移除、六大耦合面逐条行号、31 端点让渡清单、Step 0–6 与逐步回滚）。本文件是 2026-10-17 的重新立案；**两者冲突时以已评审的那份为准**，执行前先合并，别同时维护两份。

---

## 一、现状说明

- `apps/web/`：浏览器 SPA（React + Vite），含子目录 `src/ios/` 为 WKWebView UI 壳（JS↔Swift 桥接）
- `apps/api/`：Fastify Node.js API，**已按条件加载** Web 静态文件（`existsSync(webDist)` 守卫）
- `apps/ios/`：原生 SwiftUI App，**已是 iOS 主要生产路径**（iOS 分支 `RootView.swift` → `NativeRootView`）。⚠️ `AppWebView` **不是 iOS 开发回退壳**：它是 `RootView.swift` 的 **macOS 分支** UI（`#else` + `NSViewRepresentable`），Xcode 工程当前支持 `macosx` destination。
- `packages/`：全部为 API/iOS 间接依赖，无 Web 专属包
- 桌面端：Electron/Tauri **不存在**；但 macOS 构建能力存在于 `apps/ios` 工程（见上），需单独决定是否随本次一并移除。

---

## 二、移除范围与保留范围

### 可完全删除

| 路径/内容 | 说明 |
|-----------|------|
| `apps/web/` 整个目录 | SPA 全部代码、资产、E2E 测试 |
| `scripts/check-web-build.mjs` | 仅用于断言 `apps/web/dist/` 存在 |
| `node_modules` 中 `playwright-core`（根级 devDep） | 仅服务 E2E web 测试 |

> ⚠️ **删除前须确认**：`apps/web/src/ios/` 是 WKWebView 壳的 JS 侧（`native.ts` 为 JS↔Swift 桥）；`AppWebView.swift` 是 **macOS 分支**的 UI（不是 iOS 回退壳）。删除 Web 目录前先按步骤 7 决定 macOS target 去留（保留 macOS 就必须保留 Web 构建产物），并确认没有其他路径仍加载 WKWebView。

### 需修改（不删除）· 耦合面清单

除下节逐文件说明外，**至少**还有这些跨包/门禁改动（漏掉会导致 `npm test` / `check:docs` 红）：

| 路径 | 改动 | 原因 |
|---|---|---|
| `scripts/run-tests.mjs` | 删除 Web vitest 套件（或加 `existsSync` 守卫） | `main()` 无条件 `createRequire("apps/web/package.json")` 并跑 vitest；删目录后 `npm test` 必失败 |
| `apps/api/test/node-version.test.ts` | 从 workspace 列表与 lifecycle 检查里移除 `apps/web` | 该测试硬编码 `["apps/api", "apps/web"]` 并执行 `npm run predev -w @rai/web` |
| `package-lock.json` | 重新生成 | 删除 `playwright-core` / `@fastify/static` 后锁文件要同步 |
| `docs/ARCHITECTURE.md`、`README.md`、`docs/OPERATIONS.md`、`deploy/README-UBUNTU.md` 等 | 更新 Web 相关链接/说明 | `check:docs` 会校验本地链接（`docs/ARCHITECTURE.md:44` 指向 `apps/web/src/App.tsx`）；其余文件仍写 `npm run build`/web dist |
| `AGENTS.md` | 更新 Supported Product / 冻结区 | 否则后续 agent 仍按"Web 是受支持产品"维护 |
| `scripts/dev-device.mjs` | 删除或改为纯 API 调试 | 仍执行 `npm run dev:lan -w @rai/web` |

见下节逐文件说明。

---

## 三、分步实施

### 步骤 1：清理根 `package.json` 脚本

移除以下 script 条目：

```
predev:web
dev:web
dev（重定义为 dev:api 等价，或直接删除）
build
prestart（保留 check:node 部分，删除 check-web-build.mjs 调用）
test:e2e:web
test:e2e:responsive
test:e2e
test:all（移除其中的 test:e2e:web）
```

`prestart` 现在是 `"node scripts/check-node-version.mjs && node scripts/check-web-build.mjs"`，改为：

```json
"prestart": "node scripts/check-node-version.mjs"
```

移除 `devDependencies` 中 `playwright-core`（若无其他消费方）。

同时（否则删除 `apps/web` 后验收命令本身会红）：

- `scripts/run-tests.mjs`：删除 Web vitest 套件（`main()` 里 `createRequire(join(web,"package.json"))` + `vitest run`），或至少加 `existsSync` 守卫；
- `apps/api/test/node-version.test.ts`：从 `["apps/api", "apps/web"]` 与 lifecycle 检查里移除 web；
- `scripts/dev-device.mjs`：去掉 `dev:lan -w @rai/web`（或删除 `dev:device` 入口）；
- `package-lock.json`：`npm install` 重新生成。

---

### 步骤 2：修改部署服务文件（云服务器）

#### `deploy/rai-api.service`（以及 `deploy/n100/rai-api.service`）

删除以下行（阻止无 web 构建时 API 启动）：

```ini
ExecStartPre=/usr/bin/node scripts/check-web-build.mjs
```

修改后 `[Service]` 段只保留 API 启动命令。

#### `deploy/nginx-rai.conf`（主部署）

当前为 Web SPA + API 双用途配置。移除后改为纯 API 反代：

```nginx
server {
    listen 443 ssl;
    server_name <your-domain>;

    # SSL 配置保持不变
    ssl_certificate     ...;
    ssl_certificate_key ...;

    # 仅代理 API
    location /v1/ {
        proxy_pass         http://127.0.0.1:<api_port>;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # iOS 大文件上传（Apple Health ZIP）。注意两个数不是一回事：
    # - ZIP 端点上限 = API 的 RAI_IMPORT_MAX_ZIP_BYTES，默认 64 MiB（server.ts:140）；
    # - 72 MiB = direct-sync 单批 XML(8 MiB) + routes(64 MiB) 的载荷上界，不是 ZIP 端点上限。
    # 若云端把 RAI_IMPORT_MAX_ZIP_BYTES 调大，这里和 env 必须同步；当前 nginx 原值是 4g。
    location = /v1/imports/uploads {
        client_max_body_size 80m;
        proxy_pass         http://127.0.0.1:<api_port>;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_read_timeout 300s;
    }

    # 其他路径一律 404
    location / {
        return 404;
    }
}
```

**删除**：`root`（SPA 目录）、`index index.html`、所有 SPA `try_files` / `location ~` 路由匹配规则、`/assets/` 静态资产块。

#### `deploy/n100/nginx-rai.conf`

该配置已是纯透传（所有流量转发到 API 进程），改动较小：将 `location /` 改为仅匹配 `location /v1/`，非 API 路径返回 404。

---

### 步骤 3：清理 API 源码中的 Web 残留（可选，不影响功能）

以下文件/代码在 Web 移除后变为死代码，可按需清理：

**`apps/api/src/web-assets.ts`**：整个文件只做一件事：注册 `@fastify/static` 服务 `apps/web/dist`。无 web dist 时代码不执行（已有 `existsSync` 守卫），但文件本身可删除；同时删除 `apps/api/package.json` 中 `@fastify/static` 的依赖（若无其他用途）。

**`apps/api/src/server.ts`（约第 215–221 行）**：`developmentOrigins` 集合引用了 `RAI_WEB_PORT`（Vite dev server 端口），可与 CORS 配置一并清理，只保留 iOS App 直连所需的 origin（若有必要）。⚠️ 该变量与 `allowPrivateLanWebPort` **不只服务 CORS**：它们还进 `localRequestSecurityOptions`（`server.ts:396`）；清理时要连同 `server.ts:393-399` 与 `RAI_ALLOW_LAN_DEV` 一起决定。

**`apps/api/src/share-card.ts` / 路由 `/v1/workouts/:id/share-card`**：❌ **保留**。iOS 原生 App 已调用：`APIClient.swift:270` → `TechShareCardView.swift:110`；而且该文件里的
`trimRouteForShare` 还被读路径 `apps/api/src/data.ts:1910` 使用，不是"Web UI 专用"模块。只能移除 Web 侧渲染组件，
不能删这条路由/这个 helper。

以下路由中，**两条已确认 iOS 在用，不能删**：
- `/v1/workouts/:id/share-card` —— iOS 调用（`APIClient.swift:270`）
- `/v1/exports/workout-summary` —— iOS 调用（`APIClient.swift:284`，`TechWorkoutExportView.swift:68`）

其余可移除（逐条确认 iOS 不调用后）：
- `/v1/privacy-zones`
- `/v1/performance-entries`
- `/v1/label-funnel`
- `/v1/performance`

---

### 步骤 4：修改 tsconfig

**`tsconfig.json`（根）**

移除 `lib` 中的 `"DOM"` 和 `"DOM.Iterable"`（仅 Web SPA 需要，API 和纯逻辑包不需要浏览器 API）。移除 `include` 中的 `"apps/**/*.tsx"`（该 glob 只为 Web TSX 存在；iOS 是 Swift，不经根 tsconfig）。

验证方式：修改后执行 `npm run typecheck`，确认零错误。

---

### 步骤 5：修改 CI（`.github/workflows/ci.yml`）

删除以下步骤：

- `windows-runtime` job 中："Build production Web application"（`npm run build`）
- `verify` job 中："Build and test desktop Web flows"（`npm run test:e2e:web`）

`smoke:api` 与 `prestart` 无关：它走 `presmoke:api`，直接 spawn `node --import tsx apps/api/src/server.ts`，不经过 `npm start`；`server.ts` 对 web dist 本来就有 `existsSync` 守卫，所以 smoke 从未依赖 web 构建。删 `prestart` 里的检查只影响 `npm start`。

另外 CI 两个 job 都跑 `npm test`（`.github/workflows/ci.yml`）；步骤 1 若不同时修改 `scripts/run-tests.mjs`，CI 会在删除 `apps/web` 后直接失败。`verify` job 还跑 `npm run check:docs`，所以 docs 更新与 `check:docs` 必须进入验证清单。

---

### 步骤 6：iOS App 服务端地址配置

iOS 原生 App 当前通过 `ServerDiscovery.swift` 发现服务端地址。迁移到云 API 直连后，需确保以下几点：

1. **生产环境 base URL**：当前存在 `ServerSession` 的 `UserDefaults`（key `rai.serverURL`，`ServerSession.swift:7-12`），不是 Keychain（Keychain 只存 API token）。生产可以预置 URL、保留设置页输入，或加启动配置覆盖；不走 LAN 发现（`ServerDiscovery` 的 Bonjour 只适用于本地网络，且 release 只接受 `https` 候选）
2. **HTTPS 证书**：云服务器需有有效 TLS 证书，iOS ATS（App Transport Security）要求 HTTPS；如需支持开发期 HTTP，须在 `apps/ios/RAI/Info.plist` 中配置 `NSExceptionDomains`（生产不允许）
3. **上传超时**：Apple Health ZIP 的**端点**默认上限是 64 MiB（`RAI_IMPORT_MAX_ZIP_BYTES`，`server.ts:140`）；72 MiB 是 direct-sync 单批载荷上界（XML 8 + routes 64），不是 ZIP 端点上限。`BackgroundUploadSession.swift` 使用后台 URLSession；nginx 侧 `proxy_read_timeout` 建议 ≥ 300s（见步骤 2 的 uploads location）
4. **CORS**：API `server.ts` 的 `origin` 白名单如有 `localhost:*` 限制，移除 Web 相关 origin，确认云部署下允许 iOS App 直连（iOS 原生 HTTP 请求不发送 `Origin` 头，CORS 对原生 App 无需配置，但如果保留 Web 开发 origin 条目不影响功能）

---

### 步骤 7：WKWebView / macOS 分支的最终确认与清理

`AppWebView.swift` **不是 iOS 回退壳**：iOS 分支走 `NativeRootView`，`AppWebView` 服务的是 `RootView.swift` 的 **macOS 分支**（`NSViewRepresentable`）。因此先做决定：

- **A. 保留 macOS 构建**：保留 `AppWebView.swift` + `apps/web` 构建产物（不再"移除 Web"）——与本计划前提冲突，需重新评估范围；
- **B. 一并移除桌面端**：显式删除 macOS destination、`SUPPORTED_PLATFORMS` 中的 `macosx`、`MACOSX_DEPLOYMENT_TARGET` 设置，以及 `RootView`/`AppWebView` 的 `#if os(macOS)` 分支，然后再删除 `AppWebView.swift`。只删文件会破坏 macOS 构建。

无论 A/B，`apps/web/src/ios/`（WKWebView JS 桥）与 `apps/web/` 一起删除；Podfile 中如有仅 WKWebView 用的依赖一并去掉。

---

## 四、执行顺序建议

以下顺序降低风险，每步完成后可独立验证：

```
0. 先取得"移除 Web/桌面端"的明确产品授权，并更新 `AGENTS.md` 的 Supported Product / 冻结区声明（否则违反仓库约束）
1. 云服务器：修改 rai-api.service（删除 check-web-build 前置检查）→ 重启 API 验证正常启动
2. 本地：修改 package.json 脚本 → npm run typecheck && npm test 验证通过
3. 云服务器：重新部署 nginx 配置 → curl 验证 /v1/health 正常，/ 返回 404
4. iOS Xcode：先决定 macOS target 去留（步骤 7 的 A/B），更新 base URL 为云服务器域名 → 真机测试
5. 本地：删除 apps/web/ 目录，同步 scripts/run-tests.mjs、node-version 测试、dev-device、docs/AGENTS、package-lock → npm run typecheck && npm test && npm run check:docs
6. 本地：修改 tsconfig.json → npm run typecheck
7. 修改 CI workflow → 推送后验证 CI 绿
8. 可选：清理 API web 残留代码（web-assets.ts；share-card 路由**保留**）→ npm run typecheck && npm test
```

---

## 五、验证清单

移除完成后，执行以下验证：

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:ios
```

```bash
npm run smoke:api
```

```bash
npm run check:docs
```

以及在云服务器上：

```bash
curl -s https://<domain>/v1/health
# 期望：{"status":"ok"} 类似响应
curl -s -o /dev/null -w "%{http_code}" https://<domain>/
# 期望：404
```

iOS 真机测试：健康数据同步（`POST /v1/imports/uploads` → `/v1/imports/inspect` → `/v1/import-jobs`）端到端完成，回执状态 `committed`。

---

## 六、回滚（复核补充）

按执行顺序回滚，原则是"先恢复入口、再恢复代码"：

1. `package.json` / `scripts/run-tests.mjs` / CI：`git revert` 对应提交，恢复 `test`/`build`/`test:e2e:web`；
2. nginx / systemd：恢复备份的 `deploy/*` 配置并 `nginx -t && systemctl reload nginx`，必要时回退 API 进程；
3. `apps/web/` 与 `apps/web/src/ios/`：从 git 恢复目录（建议整个改动以单个 PR 提交，回滚即 `git revert`）；
4. iOS：恢复 base URL / 设置页入口与 `AppWebView`；若选了 B（移除 macOS）又要回滚，需恢复 target 与 `#if os(macOS)` 代码；
5. 验收：`npm run typecheck && npm test && npm run check:docs && npm run smoke:api`，再在云端 `curl /v1/health` 与 `/`。

---

## 七、风险点备忘

| 风险 | 缓解措施 |
|------|----------|
| WKWebView 壳仍被某路径加载，删除 JS 后 App 白屏 | 步骤 4 真机测试前不删 `apps/web/src/ios/`；先做步骤 7 的 A/B 决定 |
| nginx 改动后 API 不可达 | 先在暂存环境测试，或保留旧配置备份 |
| iOS ATS 拒绝云服务器（证书链问题） | `npm run smoke:api` 以及 Charles Proxy 抓包确认 TLS 握手 |
| 删除 `@fastify/static` 后某路由隐式依赖它 | `npm run typecheck` 会报错，可检出 |
| CI smoke 测试因 `check-web-build` 消失而行为变化 | 步骤 5 完成后跑一次本地 `npm run smoke:api` 确认 |
| 删除 `apps/web` 后 `npm test` 必失败 | 同批修改 `scripts/run-tests.mjs` 与 `apps/api/test/node-version.test.ts`，删目录前先跑一次 |
| 误删 iOS 在用的 share-card / workout-summary | 保留这两条路由与 `share-card.ts`（iOS 证据见步骤 3） |
| macOS target 与 `AppWebView` 被误删 | 先做保留/删除桌面端的决定，再删文件（步骤 7） |
