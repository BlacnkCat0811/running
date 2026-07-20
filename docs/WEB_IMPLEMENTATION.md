# RAI Web 实现

## 1. 运行边界

RAI Web 是单用户、本地优先的个人运动分析产品：

- Fastify 只监听 `127.0.0.1:8787`。
- React 页面只通过 `/v1` API 读取数据。
- CA、TA、Decay、GV 和数据质量不在页面计算。
- SQLite、Apple Health XML 和 GPX 不会上传。
- 路线由浏览器使用本地坐标绘制，不调用第三方地图服务。

## 2. 页面

| 页面 | 主要功能 |
|---|---|
| 概览 | TA、7 日变化、最新 CA/TA 差、GV、校准状态、解释、四周趋势、最近训练 |
| 训练 | 模型参与、资格、环境、时间、来源、置信度、路线和类型筛选；URL 保存筛选状态 |
| 训练详情 | 表现、能量、爬升、跑姿、公里路线、八类同步时间序列、五维评分、TA 更新、解释、质量与覆盖编辑 |
| 趋势 | 4 周、12 周、6 月、1 年、全部范围；TA、CA、Decay、模型点、五维趋势、跑量与负荷 |
| 数据与模型 | Apple Health 导入、任务记录、完整重算、模型历史、active 切换与 Run 对照 |
| 数据审计 | 健康记录范围、Workout 收敛、来源、路线、Feature 质量、缺失原因和导入问题 |
| 设置 | 数据资产、模型/校准状态、脱敏诊断导出、SQLite 备份/下载/恢复、数据删除、免责声明 |

桌面宽度使用固定侧边导航。820px 以下切换到底部导航；训练表切换为紧凑列表，质量与模型状态不隐藏。

## 3. API

```text
GET    /v1/health
GET    /v1/openapi.json
GET    /v1/dashboard
GET    /v1/data-summary
GET    /v1/data-audit
GET    /v1/diagnostics
GET    /v1/runtime-status
GET    /v1/workouts
GET    /v1/workouts/:id
GET    /v1/workouts/:id/series
PATCH  /v1/workouts/:id/override
GET    /v1/trends
GET    /v1/model-runs
GET    /v1/model-runs/compare
POST   /v1/model-runs
POST   /v1/model-runs/:id/activate
GET    /v1/jobs
GET    /v1/jobs/:id
POST   /v1/jobs/:id/cancel
POST   /v1/import-jobs
GET    /v1/import-jobs/:id
GET    /v1/backups
POST   /v1/backups
GET    /v1/backups/:name
POST   /v1/backups/:name/restore
DELETE /v1/database
```

`packages/api-contracts` 是前后端共享 DTO，避免前端手写第二套字段语义。

查询、路径参数和写入 body 均在 Fastify 路由入口使用 JSON Schema 校验。非法分页、趋势范围、训练类型、RPE、导入确认、删除确认结构和备份文件名会在进入业务层前返回 `400`。`/v1/openapi.json` 提供本地接口索引；它不改变 API 仅监听 localhost 的边界。

模型对照使用 `Training Session` 稳定身份连接两个不可变 Run，返回共同训练数、平均 CA 差、平均绝对 CA 差、平均置信度差、最终 TA 差、资格状态变化数和 CA 变化最大的训练。对照是只读操作，不会移动 `active_model_run` 指针。

数据审计页直接聚合 SQLite canonical 层和当前 active Feature，展示健康记录时间范围、原始/ canonical Workout 收敛、Workout Group 与 Training Session 数、路线资产、来源类别、Session 状态、主要 HealthKit 记录类型、心率覆盖范围、结构化缺失原因和 `import_issues`。页面不展示来源设备原名、原始对象 ID 或精确路线。

训练时间序列接口按 Training Session 的 canonical Workout 时间窗读取 Record。心率、跑速、步频、海拔、跑步功率、步幅、垂直振幅和触地时间在服务端确定性下采样后返回；图表共享偏移时间轴，只用于训练解释，不参与页面端评分。缺失序列显示明确不可用态。

## 4. 导入与重算

Web 导入需要本机 Apple Health 导出目录。用户确认后执行：

1. 对当前 SQLite 创建在线备份，并以该备份克隆 staging 数据库；首次导入则创建空 staging 数据库。
2. 按 entity generation 增量同步 XML，按文件指纹更新 GPX，并只重建受影响的 canonical 分组。
3. 比较数据指纹；无变化直接结束，只有非评分数据变化时跳过模型重算。
4. 对评分相关变化从兼容 checkpoint 增量重放 Feature、训练负荷和模型；无法安全界定时降级为完整重放。
5. 校验 staging 数据库、外键和回放结果，必要时与完整回放 hash 对照。
6. 关闭当前读连接后原子切换数据库；任何失败都删除 staging 并保留当前 active 数据库。

训练覆盖会追加新的 revision，并排入完整重算。Web 在新 Run 成功前继续展示旧 active Run。

应用壳会轮询 `/v1/runtime-status`：空闲时降低频率，导入或重算期间提高频率。用户切换页面后仍能看到任务阶段与进度；任务成功时触发统一的 active 数据刷新事件，各页面重新读取 API，不在浏览器中推演模型状态。

导入任务与来源元数据持久化到 `RAI_RUNTIME_ROOT/var/runtime.sqlite`。旧 `import-jobs.json` 和来源 JSON 只在首次启动时迁移一次。服务重启时，未完成任务会被标记为 `interrupted/failed` 并提供重新提交路径，不会消失或被误报为成功。

## 5. 首次启动与恢复

- `/v1/health` 返回 `databaseReady`，应用壳以此判断当前 SQLite 是否可用。
- 没有数据库时，概览、训练、训练详情、趋势和数据审计统一显示首次导入引导。
- “数据与模型”仍开放 Apple Health 导入，但禁用完整重算和模型对照。
- “设置”仍允许查看和下载已有备份，但禁用创建备份和删除数据库。
- 导入成功或删除完成后派发统一数据更新事件，应用壳重新读取健康状态，不要求用户手动刷新页面。
- 首次导入仍采用临时数据库、完整验证、原子切换流程，不会直接在目标数据库上半成品写入。
- API 支持用 `RAI_RUNTIME_ROOT` 覆盖临时数据库、报告和备份根目录；生产默认仍为项目目录，自动化测试使用独立临时目录，避免污染真实资产。

## 6. 备份与删除

- 在线备份使用 Node SQLite `backup()`，会读取主数据库及已提交的 WAL 内容，避免直接复制 `.sqlite` 时遗漏数据。
- 备份存放在 `var/backups/`，文件名只允许单个 `.sqlite` basename，下载接口拒绝路径穿越。
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
```

桌面浏览器回归固定在 1440 x 900。390px 冻结兼容测试通过 `npm run test:e2e:responsive` 独立执行，不属于普通 Web 修改的默认验收。

单元/集成测试另包含小型 Apple Health fixture，完整验证 XML 导入、canonical Session、Feature Run、CA/TA 回放、Daily Snapshot、active Model Run、导入历史迁移、任务状态恢复和备份恢复。

## 8. 启动

开发：

```powershell
npm run dev
```

生产：

```powershell
npm run build
npm start
```

`npm run build` 使用 Vite 生成 `apps/web/dist`；`npm start` 只运行该构建产物，并由 Fastify 提供静态页面、SPA 深链接和本地 API。生产部署可在构建后执行 `npm ci --omit=dev`，启动过程不依赖 Vite。
