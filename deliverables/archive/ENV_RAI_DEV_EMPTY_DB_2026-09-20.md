# 空库跑通：API 换端口 + RAI_DATABASE 指向新库

日期：2026-09-20
范围：本机（Intel macOS 虚拟机）开发环境，不涉及仓库代码改动
结论：**空态 UI 已跑通**，App 四个页签空态全部渲染正常；`var/rai-dev.sqlite` 为全新空库（schema v22，三张主表 0 行）

---

## 1. 最终状态

| 组件 | 地址 / 路径 | 状态 |
|---|---|---|
| RAI API | `http://127.0.0.1:8899` | 运行中，`databaseReady: true`、`localOnly: true` |
| 数据库 | `var/rai-dev.sqlite` | schema v22；workouts / route_points / health_records 均 0 行 |
| 控制库 | `var/rai-control.sqlite` | 自动创建（默认随 runtimeRoot） |
| 模拟器 | `RAI Technology Acceptance`（`A2320B93-…`） | Booted |
| App | `app.rai.running.debug` | 已装、已连上 8899，落到空态首页 |
| 浏览器镜像 | `http://127.0.0.1:3200` | 运行中（serve-sim，MJPEG） |

保留原状：8787 仍被 `codex-bridge`（python pid 47411）占用，未做任何改动。

---

## 2. 复现步骤（从零重启这套环境）

```bash
cd /Users/tp/running

# 1) 建/迁移空库（幂等，已是最新时输出 "already current"）
npm run data:migrate -- --database /Users/tp/running/var/rai-dev.sqlite --apply

# 2) 起 API：换端口 + 指向新库（后台常驻）
RAI_API_PORT=8899 RAI_DATABASE=/Users/tp/running/var/rai-dev.sqlite \
  npm run start -w @rai/api

# 3) 确认后端真的活着（不是"进程在"）
curl -sS --noproxy '*' http://127.0.0.1:8899/v1/health
# → {"status":"ok","databaseReady":true,"localOnly":true,...}
```

App 侧（模拟器）：

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
D=A2320B93-3FFE-4AF9-A480-616511395C53
xcrun simctl boot "$D" 2>/dev/null; xcrun simctl bootstatus "$D" -b   # 冷启动约 3–4 分钟
xcrun simctl launch "$D" app.rai.running.debug
```

---

## 3. 阻塞项与根因：`onnxruntime-node` 没有 macOS x64 绑定

### 现象

`npm run start -w @rai/api` 在 2 秒内崩掉：

```
Error: Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'
  require stack: node_modules/onnxruntime-node/dist/binding.js
```

### 根因（已实证，非猜测）

- `binding.js` 按 `../bin/napi-v6/${process.platform}/${process.arch}/` 找绑定，
  而包内只有 `linux/x64`、`linux/arm64`、`darwin/arm64`、`win32/x64`、`win32/arm64` —— **独缺 `darwin/x64`**。
- `script/install-metadata.js` 里 `'darwin/x64': []`：没有任何可下载的补充包，不是网络/代理问题。
- 上游自 1.24.x 起不再发布 macOS x86_64 绑定；本机是 Intel（i7-12700H，原生跑 x86_64 切片），正好落在不支持的一侧。
- 触发链是**启动时**的：`server.ts` 顶层 → `@rai/application`（prediction-report / prediction-training-runner）
  → `@rai/prediction-inference` → 顶层 `import { InferenceSession, Tensor } from "onnxruntime-node"`。
  即：**空的、根本没启用预测功能的 API 进程，也要先加载这个原生 ML 运行时。**

### 处置（非侵入式）

取**最后一个仍带 darwin/x64 绑定的版本 1.23.2**（满足 `packages/prediction-inference` 声明的 `^1.22.0`），
只替换 `node_modules`，**不动 `package.json` / `package-lock.json`**（`node_modules` 已被 gitignore）：

```bash
cd /tmp && npm pack onnxruntime-node@1.23.2
mkdir -p pkg && tar -xzf onnxruntime-node-1.23.2.tgz --strip-components=1 -C pkg

cd /Users/tp/running
mv node_modules/onnxruntime-node node_modules/.onnxruntime-node.bak-1.27.0   # 备份
cp -R /tmp/ortcheck/pkg node_modules/onnxruntime-node
```

核验过的一致性是完整的：绑定与 dylib 同为 1.23.2，`file` 显示 `Mach-O … x86_64`，
`otool -L` 指向的 `@rpath/libonnxruntime.1.23.2.dylib` 就在同目录。
加载测试：`node -e "require('onnxruntime-node')"` → `InferenceSession: function`。

**回滚**：`rm -rf node_modules/onnxruntime-node && mv node_modules/.onnxruntime-node.bak-1.27.0 node_modules/onnxruntime-node`，
或直接 `npm ci`（会按 lockfile 恢复 1.27.0）。

> 注意：这是**本机 dev 专用**折中。同一台机器上只能二选一——
> 要么保留 1.27.0（Linux/Windows/Apple Silicon 可用，Intel macOS 起不来），
> 要么 1.23.2（全平台可起）。

### 建议的长期修法（未执行，需你决策）

把 `packages/prediction-inference/src/index.ts` 顶层的

```ts
import { InferenceSession, Tensor } from "onnxruntime-node";
```

改为在 `OnnxCatBoostResidualModel.load()` 内 `await import("onnxruntime-node")`（类型用 `import type`）。
收益：HTTP 进程不再需要原生 ML 运行时即可服务读路由，Intel macOS / 精简 CI 环境都能起，
且预测功能真正被调用时才报"平台不支持"——而不是整个服务启动失败。
代价：动了 inference 包的加载时序，需 `npm run typecheck` + `npm test` + `ml:test` 回归。
**这是修改发货代码路径，未经你确认我不做。**

---

## 4. App 侧配置怎么进去的

App 把服务地址存在 `UserDefaults` 的 `rai.serverURL`，且 iOS 上默认空串（只有 `macOS && DEBUG` 才有默认值），
必须手工填或走「重新发现」（Bonjour `_rai._tcp`，本轮无广播源）。无 GUI 环境下有两条路：

**A. 直接写盘（已采用，持久生效）**

```bash
D=A2320B93-3FFE-4AF9-A480-616511395C53
C=$(xcrun simctl get_app_container "$D" app.rai.running.debug data)
P="$C/Library/Preferences/app.rai.running.debug.plist"
xcrun simctl terminate "$D" app.rai.running.debug
/usr/libexec/PlistBuddy -c "Add :rai.serverURL string http://127.0.0.1:8899" "$P"
/usr/libexec/PlistBuddy -c "Add :rai.privacy.amap.state string declined" "$P"
xcrun simctl launch "$D" app.rai.running.debug
```

**B. 启动参数（一次性，用于验证）**

```bash
xcrun simctl launch "$D" app.rai.running.debug \
  -rai.serverURL "http://127.0.0.1:8899" -rai.privacy.amap.state declined
```

**踩到的坑**：`defaults write "$C/Library/Preferences/app.rai.running.debug.plist" …` 不落到沙盒文件里——
它只写进宿主机 cfprefsd 缓存，`defaults read` 能读出来（假阳性），但 App 读不到。
另外容器 `Library/Preferences/` 在 App 首次真正写盘前**一直是空目录**，别用「目录为空」判断 App 没写过偏好。

**地图隐私选择**：`rai.privacy.amap.state = declined`（只走离线轨迹）。
理由是构建产物里 `AMapApiKey` 为空（`Configs/AmapKey.xcconfig` 未填），开「同意」也只是空白底图，
且会初始化高德 SDK、向高德请求瓦片。要改回在 App「设置」里重新开启即可。

---

## 5. 验证证据

### API 侧（日志逐条实测，全部 200，无需 token）

```
GET /v1/handshake           200
GET /v1/mobile/today        200
GET /v1/mobile/statistics   200
GET /v1/mobile/trends       200
GET /v1/mobile/goals        200
GET /v1/mobile/workout-plan 200
GET /v1/workouts?limit=30&offset=0  200
```

鉴权说明（读过 `apps/api/src/local-request-security.ts:141-166`）：
token 门控整段被 `if (options.apiToken && …)` 包住，**未设 `RAI_API_TOKEN` 时不生效**，
只剩 `isTrustedUnsafeRequest` 的本地来源校验——所以本机 App 免 token 直读成立。
但启动日志会打印 `"Anonymous read disabled: every /v1 route requires the token"`（因 `publicReadHosts` 为空），
在"压根没配 token"的场景下这句措辞会误导人。低优先级，仅记录。

### 库侧

```
workouts: 0   route_points: 0   health_records: 0
schema_migrations: 22（版本 22）
foreign_key_check: ok
```

### App 侧（截图见 `var/screenshots/`，四个页签互不相同，md5 已比对）

| 页签 | 空态表现 |
|---|---|
| 今日（`empty-home.png`） | 「同步未完成」+「数据状态：还没有完成过一次健康数据同步」+ 今日 0.00 km / 0:00 / 本周 0.0 / 30.0 km 0% + 恢复状态「睡眠/静息心率/HRV 无记录」 |
| 训练（`empty-workouts.png`） | 「尚无训练记录」+「前往同步」+ 本月 0.0 km / 0 次 + 提示「数据不足时不显示评分」 |
| 统计（`empty-statistics.png`） | 总里程 0.0 km、总时长 0:00、三个月里程分布为空、心率区间分布「没有满足覆盖率要求的心率数据」、训练次数 0 |
| 趋势（`empty-trends.png`） | 里程变化（近 4 周）「数据不足」、12 周跑量柱状图为空 |

**持久化验证**：清掉全部启动参数、直接 `simctl launch`，App 仍直接进空态首页（未回退到首连页），
说明配置已落盘。

---

## 6. 遗留 / 待你定

1. `packages/prediction-inference` 的 onnxruntime 加载时序是否改为惰性（见 §3 建议）——涉及发货代码，等你点头。
2. `node_modules/.onnxruntime-node.bak-1.27.0` 是 1.27.0 的备份目录（约 300 MB），确认后可删。
3. 本机依然**没有** `var/rai.sqlite`，所以这一轮看到的是纯空态，不是真实数据的空壳。
4. API 常驻是前台 `npm run start`（本轮用后台任务托管）；要长期跑建议套 `deploy/` 里的 service 或 `nohup`。
5. 8787 的占用方 `codex-bridge` 仍未挪窝；`apps/web/vite.config.ts` 里 `/v1` 代理把 8787 写死，
   所以 Web 端要接这套 8899 服务，得改代理目标或用 `RAI_ALLOW_LAN_DEV` 那条路。
