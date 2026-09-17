# 今日页「当前跑力」卡片与跑步能力详情页（2026-09-16）

## 本轮范围

按参考截图（外部跑步 App 的「跑步能力」页）改造科技风 iOS 今日页：

1. 今日页移除原「关键指标」面板（效率 / 心肺 / 稳定性三格）。
2. 新增可点开的「当前跑力」入口卡，点击进入 `TechAbilityDetailView`（标题「跑步能力」）。
3. 详情页按参考图组织：跑步能力量程弧 → 能力分析（五维）→ 基础指标 → 成绩预测 → 评估趋势 → 配速区间。不展示近期跑力评估列表与数据依据说明卡。
4. 视觉沿用现有科技风令牌，未照搬参考图的橙色。

「荣耀指标」（心率 / 训练负荷 / 步频 / 触地时间）按用户选择保留：它描述最近一次训练的生理与机械事实，与能力分解不重复。

## 数据来源与边界

| 页面元素 | 接口 | 说明 |
| --- | --- | --- |
| 真实跑力、近 7 天、增长速度、衰减、快照日期、解释 | `/v1/mobile/today` → `ability` | 直接展示，不重算 |
| 校准进度标签 | `/v1/mobile/today` → `calibration.status` | `completed` / `calibrating` / `not_started` |
| VO₂ Max、VDOT、乳酸阈配速/心率、置信度、成绩预测区间 | `/v1/predictions` | 预测快照 |
| 评估趋势 | `/v1/mobile/trends` | 真实跑力曲线 |
| 配速区间 | `/v1/training-zones/current` | 分区快照 |

刻意未做：不补零缺失维度、不推断接口未提供的置信区间、不把等分刻度当作观测值、不承诺比赛成绩。

## 改动文件

- `RAI/Skins/Technology/TechAbilityDetailView.swift`：详情页重写。
- `RAI/Skins/Technology/TechCharts.swift`：新增 `TechAbilityGauge` 量程弧。
- `RAI/Skins/Technology/TechViews.swift`：今日页新增 `abilityCard`；删除 `abilityPanel` 与其在折叠区的引用。
- `RAI/Skins/Technology/TechTodayMetrics.swift`：只保留「荣耀指标」。
- `RAI/Skins/Technology/TechTheme.swift`：新增 `techCalibrationName`、`techValue`；`TechProgressBar` 的 `fraction` 改为可选。
- `RAI/APIModels.swift`：`NativeDashboardResponse` 补 `dimensions`。
- `RAI/NativeFormat.swift`：`nativeStatusName` 补 `not_started` / `calibrating`，避免英文原值上屏。
- `tests/VisualAcceptance.swift`：`test01TodayAndBody` 增加跑力入口与详情页断言与截图。
- `design/TECHNOLOGY_SKIN.md`：更新结构说明与本轮记录。

像素风（`Pixel*`、`NativeViews.swift`）未改动。

## 缺值呈现（审查后修正）

首版把缺值渲染成了「看起来像真数据」的形态，已修正：

- 缺失维度不再用 `(value ?? 0) / 100` 填进度条——`TechProgressBar.fraction` 改为 `Double?`，缺值时只画轨道、不画填充、不报百分比，与 0 分区分开。
- 增长速度缺值不再显示 `--/周`（新增 `techValue(_:digits:unit:)`，缺值保持 `--` 且不加单位）。
- `techCalibrationName(nil)` 返回「暂无数据」，与 `techStatusName` 一致；`nil` 是载荷缺失，不是未知状态。

## 验证

- `bash apps/ios/tests/typecheck-ios.sh`：37 文件通过。
- `bash apps/ios/tests/run-model-tests.sh`：模型回归全部通过。
- 模拟器 Debug 编译通过（Xcode 26.5 / iOS Simulator 26.5）。构建日志中的 4 条 `WorkoutPlanMapper.swift` actor 隔离警告在改动前即存在，本轮未触碰该文件。
- `bash apps/ios/tests/run-visual-tests.sh`：审查修正后的最终代码上 10 项原生 UI 回归全部通过（含 `test01TodayAndBody` / `test04Analysis` 定向复核）。
- 数据为隔离数据库副本（`var/rai.sqlite` 的备份），API 跑在 8853/8792 临时端口，未触碰生产或开发中的服务。
- VoiceOver：`today.ability` 的最终 label 为「当前跑力 45.5，满分 100，近 7 天 -0.2，已校准」，7 日变化与校准状态不再被覆盖式 label 丢掉（从 UI 测试的 accessibility dump 核对）。

### 两个环境注意点

1. 全新模拟器上首次启动会弹出高德底图隐私门控，该面板会拦截手势，使依赖滚动的 UI 用例失败（与本次改动无关）。预置同意状态后再跑即可：

```sh
xcrun simctl spawn <device> defaults write app.rai.running.debug rai.privacy.amap.state -string declined
```

2. `run-visual-tests.sh` 给隔离 API 的就绪等待是 40 秒（`seq 1 80` × 0.5 秒），而冷缓存下这个 300 MB 数据库实测需要约 43 秒，偶发 `Isolated API did not start`。重跑或先 `cat var/rai.sqlite > /dev/null` 预热即可；本轮未改该脚本的等待参数。

两处都没有通过修改 App 行为来迁就测试。

## 截图

`01-today-top.png` 今日页首屏；`02-today-ability-and-metrics.png` 跑力入口卡与保留的「荣耀指标」（原「关键指标」已消失）；`07-ability.png` 详情页顶部量程弧；`07-ability-dimensions.png` 能力分析五维；`07-ability-missing-dimensions.png` 五维缺值形态（分数渲染 `--`、只画轨道不画填充）；`07-ability-trend.png` 评估趋势。

> 2026-09-17 修正：本清单此前引用了并不存在的 `07-ability-metrics.png`，同时第 3 条写着"不展示能力分析五维卡"，与当时的实现（`TechAbilityDetailView.swift` 的 `dimensionsPanel`）、本页第 33 行（为五维补 `dimensions` 字段）以及 `design/TECHNOLOGY_SKIN.md` 的"跑步能力量程弧 → 能力分析（五维）→ 基础指标"三处互相矛盾。此处按**实现**对齐；截图中确实存在五维面板，因此那两张图是有效证据，不是残留。

## 验收边界

- 参考图是外部 App 的截图，字体、设备比例与信息层级不完全一致；本轮复刻的是结构与信息关系，不是逐像素描摹。
- 参考图的橙色量程弧、分段配色未采用，统一到科技风青蓝令牌。
- 参考图的「成绩预测」在此为服务端区间 + 准备度，不显示参考图中的单一目标值。
- 验收数据库健康数据截至 8/25、今日无训练，空态与缺失值会影响页面高度与呈现。
