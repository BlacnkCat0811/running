# RAI Web 实现

## 1. 运行边界

RAI 是单用户、本地优先的个人运动分析产品：

- Fastify 只监听 `127.0.0.1:8787`（`RAI_API_HOST` / `RAI_API_PORT` 可覆盖）；生产由 Nginx 托管静态产物并仅反代 `/v1/*`。
- React 页面只通过 `/v1` API 读取数据。
- CA、TA、Decay、GV、数据质量与恢复状态不在页面计算。
- SQLite、Apple Health XML、GPX、睡眠/HRV 序列不会上传第三方。
- 路线由浏览器使用本地坐标绘制，不调用第三方地图服务。

Web 同时包含两套 UI：

- **桌面 Web**（`src/App.tsx` + `src/pages/*`）：完整数据与模型工作台，默认路由。
- **iOS 壳像素界面**（`src/IosMobileApp.tsx` + `src/ios/*`）：在 URL 带 `?raiShell=ios` 或 `data-shell=ios` 时启用（iOS 调试壳 WKWebView 加载即此界面）；清新像素风，与 `apps/ios/design/ios-app-design.html` 设计稿对应。

## 2. 页面

### 桌面 Web

| 页面 | 路由 | 主要功能 |
|---|---|---|
| 概览 | `/` | TA、7 日变化、最新 CA/TA 差、GV、校准状态、解释、四周趋势、最近训练 |
| 训练 | `/workouts` | 模型参与、资格、环境、时间、来源、置信度、路线和类型筛选；URL 保存筛选状态 |
| 训练详情 | `/workouts/:id` | 表现、能量、爬升、跑姿、公里路线、八类同步时间序列、五维评分、TA 更新、解释、质量与覆盖编辑 |
| 训练分区 | `/zones` | 分区设置（心率/配速）、当前分区与历史 |
| 运动统计 | `/statistics` | 周/月/年与滚动周期统计、训练负荷与状态 |
| 能力趋势 | `/trends` | 4 周、12 周、6 月、1 年、全部范围；TA、CA、Decay、模型点、五维趋势、跑量与负荷 |
| 成绩预测 | `/predictions` | `/v1/predictions` 只读预测 + `/v1/prediction-models` 训练/激活/取消 |
| 数据与模型 | `/data` | Apple Health 导入、任务记录、完整重算、模型历史、active 切换与 Run 对照 |
| 数据审计 | `/data/audit` | 健康记录范围、Workout 收敛、来源、路线、Feature 质量、缺失原因和导入问题 |
| 设置 | `/settings` | 数据资产、模型/校准状态、脱敏诊断导出、SQLite 备份/下载/恢复、数据删除、免责声明 |

桌面宽度使用固定侧边导航，820px 以下切换到底部导航；训练表切换为紧凑列表，质量与模型状态不隐藏。

### iOS 壳像素界面

| 页面 | 路由 | 主要功能 |
|---|---|---|
| 首页 | `/` | 今日裁决/恢复卡（昨夜睡眠、过夜 HRV、RHR 与基线）、今日教练课表（`nextSession`）、本周进度、最近训练、`latestDataDate` 数据滞后提示 |
| 本周活动 | `/week` | 周内逐日柱与详情 |
| 身体指标 | `/body` | 生理/预测摘要 |
| 训练 | `/workouts`, `/workouts/:id` | 列表与详情（复用 Web 详情数据） |
| 统计 | `/statistics` | 月度柱、指标格、心率区间 |
| 趋势 | `/trends` | 阶梯折线、洞察与个人纪录（数据不足占位） |
| 设置 | `/settings` | 周目标编辑、服务器/同步状态 |

聚合窗口均按数据最新日期（`MAX(local_date)`）锚定而非墙钟；周分组按整数日差整除对齐 ISO 周。

## 3. API

`packages/api-contracts` 是前后端共享 DTO；`/v1/openapi.json` 为接口索引。以下清单与当前路由注册一致（2026-09）：

```text
GET    /v1/health                    健康状态（databaseReady）
GET    /v1/openapi.json              OpenAPI 索引
GET    /v1/runtime-status            应用壳任务/导入状态轮询

# 概览、统计、训练
GET    /v1/dashboard                 概览聚合
GET    /v1/data-summary              数据资产摘要
GET    /v1/data-audit                数据审计聚合
GET    /v1/diagnostics               脱敏诊断 JSON
GET    /v1/training-statistics/overview|history|load   统计与负荷
GET    /v1/training-zones/current|history              分区
PATCH  /v1/training-zones/profile                      分区设置（多 revision）

# 训练与时间序列
GET    /v1/workouts                  分页训练列表（筛选）
GET    /v1/workouts/:id              训练详情
GET    /v1/workouts/:id/series       训练内时间序列（确定性下采样）
PATCH  /v1/workouts/:id/override     追加覆盖 revision 并重算

# 趋势与恢复
GET    /v1/trends                    能力趋势
GET    /v1/recovery-trends?days=N    恢复事实趋势（睡眠/HRV/RHR，默认 28 天；桌面图表待接入，移动端恢复卡走 /v1/mobile/today）

# 预测与模型
GET    /v1/predictions               比赛场景预测（只读，可带温度/湿度/爬升参数）
GET    /v1/prediction-models         预测模型 Run 列表
POST   /v1/prediction-models/train   触发预测模型训练
POST   /v1/prediction-models/:id/activate|cancel   激活/取消
GET    /v1/model-runs                跑力 Model Run 历史
GET    /v1/model-runs/compare        两个不可变 Run 对照
POST   /v1/model-runs                创建完整重算 Model Run
POST   /v1/model-runs/:id/activate   切换 active Run（过 shadow gate）

# 导入与任务
POST   /v1/imports/uploads           上传 Apple Health ZIP
POST   /v1/imports/inspect           解压前预检
POST   /v1/import-jobs               创建导入任务（目录导入等）
GET    /v1/import-jobs/:id|active|latest
POST   /v1/import-sources/discover   发现本机导出目录
GET    /v1/import-sources/recent
DELETE /v1/import-sources/:id        删除导入来源
GET    /v1/jobs                      重算任务列表
GET    /v1/jobs/:id
POST   /v1/jobs/:id/cancel           取消任务

# 备份与数据删除
GET    /v1/backups                   备份列表
POST   /v1/backups                   创建一致性备份
GET    /v1/backups/:name             下载备份
POST   /v1/backups/:name/restore     恢复备份
DELETE /v1/database                  删除数据库（确认文字 + before-delete 备份）

# 移动端聚合（iOS 壳）
GET    /v1/mobile/today              今日卡 + 恢复/教练裁决 + 本周目标进度
GET    /v1/mobile/statistics         近 3 月 + 28 天滚动统计/环比/心率区间
GET    /v1/mobile/trends             12 周阶梯 + 4 周增幅 + 个人纪录
GET    /v1/mobile/goals              读取周目标
PUT    /v1/mobile/goals              写入周目标（1–500km，文件持久化）
POST   /v1/mobile/lock               锁定/重新锁定今日课表
```

查询、路径参数和写入 body 均在 Fastify 路由入口使用 JSON Schema 校验；非法分页、趋势范围、训练类型、RPE、导入确认、删除确认结构和备份文件名会在进入业务层前返回 `400`。

模型对照使用 `Training Session` 稳定身份连接两个不可变 Run，返回共同训练数、平均 CA 差、平均绝对 CA 差、平均置信度差、最终 TA 差、资格状态变化数和 CA 变化最大的训练；对照是只读操作，不会移动 `active_model_run` 指针。模型激活会先执行 `rai-shadow-gate-v1`（记录于 `model_validation_gates`），失败时 incumbent 保持不变。

数据审计页直接聚合 SQLite canonical 层和当前 active Feature，展示健康记录时间范围、原始/canonical Workout 收敛、Workout Group 与 Training Session 数、路线资产、来源类别、Session 状态、主要 HealthKit 记录类型、心率覆盖范围、结构化缺失原因和 `import_issues`。页面不展示来源设备原名、原始对象 ID 或精确路线。

训练时间序列接口按 Training Session 的 canonical Workout 时间窗读取 Record。心率、跑速、步频、海拔、跑步功率、步幅、垂直振幅和触地时间在服务端确定性下采样后返回；图表共享偏移时间轴，只用于训练解释，不参与页面端评分。缺失序列显示明确不可用态。

移动端聚合端点与契约见 `packages/api-contracts` 的 `Mobile*` 类型；设计稿↔端点映射见 `apps/ios/README.md`。

## 4. 导入与重算

Web 导入（ZIP 拖入或目录导入）执行：

1. 对当前 SQLite 创建在线备份，并以该备份克隆 staging 数据库；首次导入则创建空 staging 数据库。
2. 按 entity generation 增量同步 XML，按文件指纹更新 GPX，并只重建受影响的 canonical 分组；随后运行睡眠/HRV canonicalization（`canonical_nights` / `canonical_hrv_days`）。
3. 比较数据指纹；无变化直接结束，只有非评分数据变化时跳过模型重算。
4. 对评分相关变化从兼容 checkpoint 增量重放 Feature、训练负荷（含恢复子信号与每日生理状态）和模型；无法安全界定时降级为完整重放。
5. 校验 staging 数据库、外键和回放结果，必要时与完整回放 hash 对照。
6. 关闭当前读连接后原子切换数据库；任何失败都删除 staging 并保留当前 active 数据库。

训练覆盖会追加新的 revision，并排入完整重算。Web 在新 Run 成功前继续展示旧 active Run；候选 Run 必须先通过 `model_validation_gates` 门禁。

应用壳会轮询 `/v1/runtime-status`：空闲时降低频率，导入或重算期间提高频率。用户切换页面后仍能看到任务阶段与进度；任务成功时触发统一的 active 数据刷新事件，各页面重新读取 API，不在浏览器中推演模型状态。

导入任务与来源元数据持久化到 `RAI_RUNTIME_ROOT/var/runtime.sqlite`。旧 `import-jobs.json` 和来源 JSON 只在首次启动时迁移一次。服务重启时，未完成任务会被标记为 `interrupted/failed` 并提供重新提交路径，不会消失或被误报为成功。

## 5. 首次启动与恢复

- `/v1/health` 返回 `databaseReady`，应用壳以此判断当前 SQLite 是否可用。
- 没有数据库时，概览、训练、训练详情、趋势和数据审计统一显示首次导入引导。
- "数据与模型"仍开放 Apple Health 导入，但禁用完整重算和模型对照。
- "设置"仍允许查看和下载已有备份，但禁用创建备份和删除数据库。
- 导入成功或删除完成后派发统一数据更新事件，应用壳重新读取健康状态，不要求用户手动刷新页面。
- 首次导入仍采用临时数据库、完整验证、原子切换流程，不会直接在目标数据库上半成品写入。
- API 支持用 `RAI_RUNTIME_ROOT` 覆盖临时数据库、报告和备份根目录；本地默认仍为项目 `var/`，自动化测试使用独立临时目录，避免污染真实资产。

## 6. 备份与删除

- 在线备份使用 Node SQLite `backup()`，会读取主数据库及已提交的 WAL 内容，避免直接复制 `.sqlite` 时遗漏数据。
- 备份存放在 `var/backups/`，文件名只允许单个 `.sqlite` basename，下载接口拒绝路径穿越。
- 保留策略默认 10 份 / 总量 20 GiB / 最少剩余 512 MiB（`RAI_BACKUP_MAX_COUNT`、`RAI_BACKUP_MAX_TOTAL_BYTES`、`RAI_BACKUP_MIN_FREE_BYTES` 可覆盖；生产 `rai.env.example` 预置 14 份 / 10 GiB）。
- 导入或重算执行期间，创建备份、切换 active Run 和删除数据库都会返回 `409`。
- 删除必须提交精确确认文字 `删除我的 RAI 数据`。
- 删除前先创建 `before-delete` 备份，再移除当前 `.sqlite`、`-wal` 和 `-shm`；Apple Health 原始导出不在删除范围内。
- 设置页不会计算资产数字，记录、训练、Session、路线点与 Assessment 数量均来自 `/v1/data-summary`。
- 恢复备份要求精确确认文字 `恢复此备份`，并先在 staging 副本上执行正式数据库迁移、完整 Schema 校验、`quick_check` 和外键检查。
- 当前数据库存在时，恢复前先创建 `before-restore` 在线安全快照；恢复采用临时文件和原子改名。
- 恢复发布失败时读闸门保持关闭，安全快照也通过临时文件原子回滚，避免请求读到缺失或半复制的 SQLite。
- `/v1/diagnostics` 默认移除经纬度、健康时间序列、来源设备名和本机路径。

## 7. 验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e:web
bash scripts/mobile-smoke.sh   # 真实库冒烟：起 API 校验移动端四端点 + goals 往返
```

桌面浏览器回归固定在 1440 x 900。390px 冻结兼容测试通过 `npm run test:e2e:responsive` 独立执行，不属于普通 Web 修改的默认验收。

单元/集成测试另包含小型 Apple Health fixture，完整验证 XML 导入、canonical Session、睡眠/HRV canonicalization、Feature Run、CA/TA 回放、Daily Snapshot、active Model Run、导入历史迁移、任务状态恢复、备份恢复与移动端聚合锚定。

## 8. 启动

开发：

```powershell
npm run dev                # 同时起 API(8787) 与 Vite(5173)
npm run dev:device         # 局域网调试（iOS 壳真机用，打印本机地址）
```

生产：

```powershell
npm run build
npm start                  # 由 Fastify 提供 dist 静态 + API
```

`npm run build` 使用 Vite 生成 `apps/web/dist`；`npm start` 只运行该构建产物（缺产物立即报错），并由 Fastify 提供静态页面、SPA 深链接和本地 API。公网部署时由 Nginx 托管该 dist 并仅反代 `/v1/`（见 `deploy/README-UBUNTU.md`）。iOS 壳入口：`apps/ios/RAI.xcodeproj`（真机运行步骤见 `apps/ios/README.md`）。
