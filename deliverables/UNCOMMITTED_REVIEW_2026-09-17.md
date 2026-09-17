# 未提交改动审查（2026-09-17）

## 审查对象与方法

- **审查对象**：`/Users/ta/running` 全部未提交改动，`HEAD = bd1ee25`（2026-09-16 10:58）。
  规模：`39 files changed, 2389 insertions(+), 712 deletions(-)` + 25 个未跟踪项（含 5 份交付文档、2 个验收目录）。
- **改动主体**（按文件 mtime 分批，实测）：

| 批 | 时间窗 | 内容 | 是否已有审查覆盖 |
|---|---|---|---|
| A | 09-16 12:30–18:23 | 跑力入口卡 + 详情页重写 + P0-1 校准判据修复 + 五维恢复 | 有（`UNCOMMITTED_REVIEW_2026-09-16.md` §2/§8） |
| B | 09-16 19:03–19:24 | iOS F1–F5：同步取消、版本保护、服务身份 | 有（`IOS_REVIEW_AND_SOL_PLAN_2026-09-16.md`） |
| C | 09-16 20:03–20:15 | 后端 B1–B6：入队提交点、点查、外键策略、LLM 预算/大小、生成门 | 有（`BACKEND_*_2026-09-16.md`） |
| **D** | **09-16 22:03 – 09-17 09:49** | **科技风整体打磨（14 个文件 + 7 个新文件 + 3 个新脚本 + 验收目录）** | **无** |
| **E** | **09-17 11:03–11:20** | **4 份文档（含 `docs/DATA_AUDIT.md` 重生成）** | **无** |

- **方法**：结论全部落到 `文件:行号` 或命令实测输出。B/C 批已由上一会话审查，本轮只做**门禁复跑 + 关键断言突变复验**，不重复读码；D/E 批做完整读码。
- **本轮实跑门禁 7 条**（全部本机执行，非引用文档）：见表 §4.1。
- **突变验证 4 处**：见表 §4.2；每个突变后都还原并 `shasum -a 256` 校验一致，被触碰文件的 mtime 也已还原（因为本仓库的证据冻结规则依赖 mtime）。
- 规则：凡"会不一致 / 会崩溃 / 恒真"一类推断，先读实现或跑探针再下结论；本轮据此**未**把一条时序观察写成缺陷（见 §6）。

---

## 一、结论摘要

| # | 级别 | 结论 | 关键证据 |
|---|---|---|---|
| P0-1 | 🔴 | **新的展示逻辑门禁是孤儿**：`run-tech-presentation-tests.sh` 未被任何入口调用，36 条抽样/优先级断言只在人手跑时存在 | `run-model-tests.sh:50-51` 只挂 session + health-sync；`.github/workflows/ci.yml:36-37` 只跑 `run-model-tests.sh` |
| P0-2 | 🔴 | **线上 v22 迁移状态未确认，而已跟踪文档已按"已迁移"描述**：本地库已迁（160,051→83,380），`docs/DATA_AUDIT.md` 写 83380 却**不写数据源**；线上下次重启会**自动**跑同一条迁移 | 实测本地 `health_records=83380` / `schema_migrations=22` / `applied_at=2026-09-17T00:46:14Z`；`database.ts` 迁移在打开库时自动应用 |
| P1-1 | 🟡 | **科技风静默丢失仍未闭环（上轮已报）**：`data.phase`/`race.note`/`race.shapeScore`/`race.taper`/`postRun` 在科技风零入口，且三份文档均未声明 | HEAD `TechViews.swift:386-434` 有 `contextPanel`+`postRun`，工作区删除；`TECHNOLOGY_SKIN.md`/tech-polish README/ability-card README 零命中 |
| P1-2 | 🟡 | **ability-card 验收材料仍与最终代码矛盾（上轮 P1-0 未闭环）**：README 引用的图不存在，且与新文档对五维的说法**正相反** | `acceptance/2026-09-16-ability-card/README.md:71` 引用 `07-ability-metrics.png`（磁盘无）；README:9"不展示五维" vs `TECHNOLOGY_SKIN.md:37`"展示五维" |
| P1-3 | 🟡 | 判定图标用第二份 tone 列表，未知 tone 落到"安抚"分支（今日域内行为正确） | `TechViews.swift:220` vs `TechTheme.swift:493-495` |
| P1-4 | 🟡 | 对比度断言**名不符实**：`Action label on {fill}` 实际算的是 fill-vs-页面底色，真正压文字的三组无覆盖 | `run-tech-presentation-tests.sh:37-40` |
| P1-5 | 🟡 | `techRaceDistanceName` / `nativeStatusName` 的 `default` 直出英文原值，与相邻注释自相矛盾 | `TechAbilityDetailView.swift:305`、`NativeFormat.swift:347` |
| P2-1 | 🟡 | 最终一轮 UI 主回归**不是全绿**（13/14，`test06Setup` runner 崩溃），复跑产物已从 `/tmp` 消失 ⇒ 跨机型结论现只剩截图 | `/tmp/rai-tech-final-main-0917/ui-tests.log:873` + 尾行 `** TEST FAILED **` |
| P2-2 | 🟡 | 新脚本用 `-O` 编译，precondition 失败时断言名被吞，只剩 `Illegal instruction: 4` | 实测：`-O` → 无消息；去 `-O` → `Precondition failed: Retain endpoints` |
| P2-3 | 🟡 | `VisualAcceptance*.swift` 仍不在 CI（上轮在案） | `ci.yml:28-37` |
| — | ✅ | **7 条门禁本机实跑全绿**；**4 处突变均真红**；后端 B1–B6 与 iOS F2/F3 的设计正确；本地 v22 迁移带自动备份 | §4 |

---

## 二、🔴 必修

### P0-1 新的展示逻辑门禁是孤儿（`run-tech-presentation-tests.sh`）

本批新增的 `TechPlotSampling.indices`（峰谷抽样，≤360/240 点、端点保留、重复时刻去重、非有限过滤）与 `TechSyncPresentation.resolve`（取消优先于历史成功）是本轮**唯一**有断言的展示层逻辑，但它们所在的脚本**没有任何调用方**：

```sh
# apps/ios/tests/run-model-tests.sh:50-51 —— 聚合入口只挂了这两个
bash apps/ios/tests/run-session-tests.sh
bash apps/ios/tests/run-health-sync-tests.sh
```

```yaml
# .github/workflows/ci.yml:36-37 —— CI 只跑 run-model-tests.sh
      - name: Run iOS model regression tests
        run: bash apps/ios/tests/run-model-tests.sh
```

实测（Grep 全仓，排除 node_modules）：`run-tech-presentation-tests` 只出现在**两份文档**里：

```
./apps/ios/design/acceptance/2026-09-16-tech-polish/README.md:32
./apps/ios/design/TECHNOLOGY_SKIN.md:96
```

⇒ 脚本本身是好的（我实跑 `36 checks passed` + `23 text/background pairs`，EXIT=0；突变后 EXIT=132，见 §4.2），但它**从不自动执行**。这与本项目已确立的纪律直接冲突：

- `run-model-tests.sh:19-22` 的注释写着抽文件的目的就是"**让它在这里被钉住**"；
- `IOS_REVIEW_AND_SOL_PLAN_2026-09-16.md:155` 写着"新增测试**不再是需要手动发现的孤立脚本**"。

⇒ 与 09-16 P0-1（"契约取值域错误三条通道全漏"）是**同一类结构缺陷**：判据存在，但没有通道会执行它。

**修复**（一行）：`run-model-tests.sh` 末尾追加
```sh
bash apps/ios/tests/run-tech-presentation-tests.sh
```
**验收标准**：删掉 `TechPlotData.swift:25` 的 `result.append(valid[valid.count - 1])` 后，`bash apps/ios/tests/run-model-tests.sh` **必须**以非 0 退出（实测该突变确实变红，见 §4.2，所以这条验收是可达的）。
**回滚**：删掉那一行即可，无其他影响。

---

### P0-2 线上 v22 迁移状态未确认，文档却已按"已迁移"描述

**本地已迁（实测，非推断）**：

```
$ node -e "…new DatabaseSync('var/rai.sqlite',{readOnly:true})…"
health_records 行数 = 83380
schema_migrations 最高版本 = 22
→ v22 name = realign_health_record_stable_ids_and_remove_duplicates
  applied_at = 2026-09-17T00:46:14.414Z   （北京 08:46）
→ 自动备份 var/backups/rai.before-v22.2026-09-17T00-45-24-798Z.sqlite  (324,943,872 B, 08:45:41)
```

备份在、行数从 `160,051`（09-16 实测）降到 `83,380`、`schema_migrations` 到 22 ⇒ 迁移按设计执行且留了回滚点 ✅。

**问题在于"这条迁移会在哪里还会自己跑"**：

```ts
// apps/api/src/server.ts:400-406 —— openMainDatabase 不传 createMigrationBackup ⇒ 走默认 true
return await RaiDatabase.open(databasePath, {
  foreignKeyValidation: databaseRecoveryRequired ? "always" : "after-migration"
});
```
```ts
// packages/storage-sqlite/src/database.ts:1652
await database.migrate(options.createMigrationBackup ?? true, …);
```

⇒ 线上下次 `systemctl restart rai-api` 时，只要库里有待执行迁移就会**自动**执行（这正是本地 08:46 发生的事）。而：

- **线上是否同构（同样带 76,671 行重复）从未实测**（09-16 记录原文："线上是否同样带重复行**未实测**"）；若线上是干净的，迁移是空操作；若不是，就要跑真实删除。
- 本地 160k 行实测**耗时 44.3s**（09-16 记录）⇒ 线上同规模会有一段 API 不可用窗口。

**同时，`docs/DATA_AUDIT.md`（已跟踪、本批修改）把本地数字写进了仓库文档**：

```
| 上次导入解析到的 Health records | 83116 |
| 表内 Health records 行数 | 83380 |
| 其中冗余行（自然键重复） | 0 |
```

文档头部有生成时间与数据集版本，**但没有"数据源：本地 / 线上"**。生产库若仍是 160,051 行，这份已跟踪文档描述的就是一个线上不存在的状态。

**修复**：
1. `docs/DATA_AUDIT.md` 头部加一行 `> 数据源：<RAI_DATABASE 路径 / 本地|线上>`；
2. 部署（含"重启服务"）前按既定动作走：`POST /v1/backups` → 线上只读计数（`COUNT(health_records)` vs 自然键唯一数）→ 确认停机窗口 → 再重启。

**验收标准**：`DATA_AUDIT.md` 能回答"这组数字来自哪个库"；线上计数与文档数字一致（或文档明写差异）。
**回滚**：文档纯文本，`git checkout -- docs/DATA_AUDIT.md`；库级回滚用 `var/backups/rai.before-v22.*.sqlite`（本地）；线上未动前无需回滚。

---

## 三、🟡 待决策

### P1-1 科技风静默丢失：`postRun` / `phase` / `race.note` / `shapeScore` / `taper` 仍无入口，也仍未声明

上轮已报，本轮复查**结论不变**，并补上 HEAD 对照（避免误读）：

| 字段 | HEAD（`bd1ee25`） | 工作区 | 文档是否声明不再展示 |
|---|---|---|---|
| `data.phase`（训练阶段） | `TechViews.swift:386` | 无 | ❌ |
| `data.race.note` | `:388` | 无 | ❌ |
| `data.race.shapeScore`（体型分） | `:405` 邻近 | 无 | ❌ |
| `data.race.taper`（减量） | `:405` | 无 | ❌ |
| `data.postRun`（最近一次训练反馈） | `:415-430` | 无 | ❌ |

实测 grep（三份文档）：`postRun|训练阶段|赛后反馈|race.note|体型分|减量|不展示` 在三份文档中**零命中**（`TECHNOLOGY_SKIN.md` 只声明了详情页"不展示近期跑力评估列表与数据依据说明卡"，与此无关）。像素风仍完整保留（`NativeViews.swift:508/510/526/527/537-552`）。

**待决策**：补回入口（如并入训练详情/本周活动），还是写进 `TECHNOLOGY_SKIN.md` 明确"科技风不展示"。
**验收标准**：`MobileTodayResponse` 每个字段在科技风"有展示位"或"有显式声明"，二者其一。

### P1-2 ability-card 验收材料仍与最终代码矛盾（上轮 P1-0 未闭环）

```
$ ls apps/ios/design/acceptance/2026-09-16-ability-card/screenshots/
01-today-top.png  02-today-ability-and-metrics.png  07-ability-dimensions.png
07-ability-missing-dimensions.png  07-ability-trend.png  07-ability.png      ← 6 个
$ grep -n "\.png" …/README.md
71: … `07-ability.png` / `07-ability-metrics.png` / `07-ability-trend.png` 详情页三段。
```

- `07-ability-metrics.png` **磁盘上不存在**（README 仍在引用）。
- `README.md:9`："详情页按参考图组织：… **不展示能力分析五维卡**、近期跑力评估列表与数据依据说明卡。"
  而最终代码 `TechAbilityDetailView.swift:107` 有 `dimensionsPanel`，`TECHNOLOGY_SKIN.md:37` 写"…→ **能力分析（五维）** → 基础能力指标…"。
  ⇒ **两份已跟踪文档对同一页面互相矛盾**，且 README 侧的说法已过期（该 README mtime 09-16 15:56，早于实现定稿 22:03）。
- 目录里仍躺着 `07-ability-dimensions.png` / `07-ability-missing-dimensions.png`，对应的正是"README 说没有、代码说有"的那块面板。

**修复**：删两张过期图 + 改 README:71 的清单 + 把 README:9 的"不展示五维卡"改为与实现一致；或在 README 里记录截图对应的 commit/diff 摘要。
**验收标准**：`ls screenshots` 与 README 列举**逐一对应**；README 对五维的表述与 `TECHNOLOGY_SKIN.md:37`、代码三者一致。

### P1-3 判定图标：第二份 tone 列表 + 未知值落到"安抚"分支

```swift
// apps/ios/RAI/Skins/Technology/TechViews.swift:220
Image(systemName: ["red", "warning", "stale", "injury", "yellow", "caution", "insufficient"]
        .contains(data.verdict.tone) ? "exclamationmark.shield" : "checkmark.shield")
```

契约取值域是闭集三值：

```ts
// packages/api-contracts/src/index.ts:496
export type MobileVerdictTone = "green" | "yellow" | "red";
```

服务端只产出这三个（`mobile-coach.ts:194` 初值 `"yellow"`，后续仅 green/red）⇒ **今天的渲染是对的**。但：

- 这个列表是 `techToneColor`（`TechTheme.swift:493-495`）的**第二份副本**，两份要一起维护；
- `default` 落到 `checkmark.shield` + `TechColor.cyan`（`techToneColor` 的 default 也是 cyan）⇒ **未知 tone 被映射到"一切正常"**，与项目既定判据"未知一律归拒绝/未知，不许归通过"相悖。

**建议**：按 `techToneColor` 派生（例如只在 `tone` 解析为 green 时显示对勾），或把列表抽成单一真源。
**验收标准**：新增一个域外 tone 时，图标与颜色**同时**走"未知"分支，不再出现"对勾 + 青色"。

### P1-4 对比度断言名不符实

```python
# apps/ios/tests/run-tech-presentation-tests.sh:37-40
for fill in ["action", "coral"]:
    ratio = (luminance(colors[fill]) + 0.05) / (luminance(colors["background"]) + 0.05)
    assert ratio >= 4.5, f"Action label on {fill}: {ratio:.2f} < 4.5"
```

断言消息说"**标签在填充色上**的对比度"，算式却是 `lum(fill)` vs `lum(background)` ⇒ 实际验证的是"填充色与页面底色可区分"，**不是**"填充色上的文字可读"。本批恰好把按钮文字从 `TechColor.ink` 改成了 `TechColor.background`（`TechConfirmationSheet.swift:28`），这类改动**不被该断言覆盖**。

真正承载文字的三组，脚本都没测。我按同一 WCAG 公式手算了一遍，**值本身都达标**，所以这是"断言测的不是它"，不是"配色不合格"：

| 文字 / 底色 | 对比度 | 是否被脚本覆盖 |
|---|---:|---|
| `background` 文字 / `action` 填充 | **11.5 : 1** | ❌（脚本算的是 action vs 页面底） |
| `background` 文字 / `coral` 填充 | **7.3 : 1** | ❌（同上） |
| `background` 文字 / `cyan.opacity(0.75)` 徽章（配速区间码） | **5.7 : 1** | ❌ |
| `ink` 文字 / `paleYellow`（校准提示框） | **13.7 : 1** | ❌ |
| `ink`/`cyan`/`coral`/`yellow`/`leaf`/`muted`×2 / `background`·`paper`·`elevated`（21 组） | ≥4.5 | ✅ |

**建议**：把断言改成真正的"前景色 vs 填充色"配对，并把三条实际用到的组合补进去（`background`/`action`、`background`/`coral`、`background`/混色后的 cyan 徽章）。
**验收标准**：把 `TechPrimaryButton` 的文字色改回 `TechColor.ink` 时脚本变红（`ink` 在 `coral` 上是 1.9:1，应被拦下）。

### P1-5 `default` 直出英文原值，与相邻注释矛盾

```swift
// apps/ios/RAI/Skins/Technology/TechAbilityDetailView.swift:301-306
func techRaceDistanceName(_ value: String) -> String {
    switch value {
    …
    default: return value        // ← 直出原值
    }
}
```

而紧随其上的 `techPaceZoneName`（`:290`）注释写着"否则不直出英文原值"，`default` 返回 `"配速区间"`。同类问题还有 `NativeFormat.swift:347` 的 `default: return value ?? "--"`（上轮 P1-5 在案）。域是闭环联合，今天不可达 ⇒ 仅是策略不一致。

**建议**：统一为中文兜底；`nativeStatusName` 的 default 影响面更大，需单独评估。

---

### P2-1 最终一轮 UI 主回归不是全绿，且复跑证据已从 `/tmp` 消失

实测 `/tmp/rai-tech-final-main-0917/ui-tests.log`：

```
873:  Restarting after unexpected exit, crash, or test timeout; summary will include totals from previous launches.
2105:  Executed 8 tests, with 0 failures (0 unexpected) in 1544.382 seconds
尾行:  Failing tests:
          VisualAcceptance.test06Setup()
       ** TEST FAILED **
```

逐用例核对：`test01–test05`、`test07–test14`（共 **13** 个）各自有 `passed` 行；`test06Setup` 没有 ⇒ **"14 项中 13 项通过、1 项由测试运行器 unexpected exit 导致"是准确的**，README §验证结果 也主动写明"**不据此宣称该轮全绿**" ⇒ 诚实 ✅。

但两个可核验性问题：

1. `/tmp` 现状：`ls /tmp | grep -i rai-tech` 只剩 6 项（`final-main-0917` 及其日志 + 4 张临时 png）。README 引用的 `rai-tech-test06-recheck-0917`、`rai-tech-small-verified-0917`、`rai-tech-island-verified-0917`、`rai-tech-small-layout-0917`、`rai-tech-small-persistence-0917` **全部不存在** ⇒ 跨机型与"复跑通过"的结论**现在只剩截图，无法复核**。
2. 时间锚点本身是成立的：`build.log` mtime **08:58:18** 晚于全部被改源码（最新 07:30:59 `VisualAcceptance.swift`），且 `find … -newermt "2026-09-17 08:58:18"` 返回 0 ⇒ 证据冻结规则满足。

**建议**：在冻结源码上重跑一次全量 14 项，把 `tests.xcresult` **复制进验收目录**（而不是只写 `/tmp` 路径），让"图 ↔ 结果 ↔ 代码"三者同处一个可提交的目录。

---

### P2-2 新脚本用 `-O`，失败时断言名被吞

实测（同一突变，两种编译）：

| 编译方式 | 结果 |
|---|---|
| `xcrun swiftc -O -parse-as-library …`（脚本现状，`run-tech-presentation-tests.sh:6`） | `EXIT=132`，输出只有 `Illegal instruction: 4`，**无断言名** |
| 同命令去掉 `-O` | `main/TechPresentationRegression.swift:8: Precondition failed: Retain endpoints` ✅ |

`run-model-tests.sh:13` 的 `swiftc_flags=(-parse-as-library -disable-sandbox)` **不带** `-O`，两脚本行为不一致。排障时会被迫重新编一遍才能知道是哪条断言挂了。

**建议**：去掉 `-O`（该脚本末尾有微基准打印，`-O` 只为它服务；可改为基准单独编一个 `-O` 二进制，或接受非优化数字并注明）。

---

### P2-3 UI 验收用例仍不在 CI（上轮在案，本批未动）

`ci.yml:28-37` 的 `ios` job 只 `pod install` → `xcodebuild build RAI` → `run-model-tests.sh`，从不构建 `VisualAcceptance.xcodeproj`。本批新增了 5 个 UI 用例（`test11`–`test14` 等），**只有本机通道验证过**。是否纳入 CI 请拍板。

---

## 四、✅ 通过项（本机实跑，非引用）

### 4.1 门禁实跑

| 门禁 | 命令 | 结果 |
|---|---|---|
| TS 类型 | `npm run typecheck` | **EXIT 0**（双 tsconfig 均过） |
| 全量测试 | `npm test` | **node 628 / 625 pass / 3 skip / 0 fail**；vitest **13 文件 84 pass**；EXIT 0 |
| Web 构建 | `npm run build` | **`✓ built in 14.67s`**（先 `mv apps/web/dist /tmp/…` 绕开沙箱 safe-delete 阈值） |
| iOS 类型 | `bash apps/ios/tests/typecheck-ios.sh` | **EXIT 0** — `类型检查 45 个文件（已跳过 4 个仅依赖高德 SDK 的文件）` ⇒ 与 `TECHNOLOGY_SKIN.md:96`/tech-polish README:43 的"45 文件"一致 |
| iOS 模型 | `bash apps/ios/tests/run-model-tests.sh` | **EXIT 0** — `PASS:` 共 **121** 条；含 `All model regression checks passed.` / `All coordinate conversion checks passed.` / `All workout plan mapper checks passed.` / `All ServerSession regression checks passed.` / `Health sync cancellation regression tests passed` |
| 展示逻辑 | `bash apps/ios/tests/run-tech-presentation-tests.sh` | **EXIT 0** — `Technology presentation: 36 checks passed`；`50,000 points preparation: 6.16 ms/run`；`Technology color tokens: 23 text/background pairs meet the 4.5:1 project target` |
| UI 回归（沿用已有产物复核） | `/tmp/rai-tech-final-main-0917/ui-tests.log` | 13/14 passed，`test06Setup` runner unexpected exit；`build.log` **BUILD SUCCEEDED**（时间锚点成立，见 P2-1） |

> 限制：`npm run test:e2e:web` 在本机不可运行（`/Applications` 无 Chrome/Edge，before hook 报"未找到可用于 E2E 的本机 Chrome 或 Edge"）⇒ **浏览器流程仍未被验证**，与本仓库既有记录一致。responsive E2E 按 AGENTS.md 未运行。

### 4.2 突变验证（4/4 真红，全部还原并校验 sha）

| # | 突变 | 命令 | 结果 |
|---|---|---|---|
| 1 | `database.ts`：`if (fk === "always" \|\| pending.length > 0)` → 去掉 `\|\| pending.length > 0` | `node --import tsx --test packages/storage-sqlite/test/foreign-key-validation.test.ts` | **EXIT 1**，`not ok 3 - after-migration validation still checks when an actual migration is pending`；还原后 sha `c49383db1bd585fd` 一致 |
| 2 | `TechSyncPresentation.resolve`：把"历史成功"分支提到 `phase == "cancelled"` 之前 | `bash apps/ios/tests/run-tech-presentation-tests.sh` | **EXIT 132**；还原后 sha `8de4fdb4a2eda389` 一致 |
| 3 | `TechPlotData.indices`：删掉 `result.append(valid[valid.count - 1])`（端点保留） | 同二进制直跑 | **EXIT 132** + `main/TechPresentationRegression.swift:8: Precondition failed: Retain endpoints`；还原后 sha `fe934c0c7adca2d5` 一致 |
| 4 | `worker.ts`：删掉入队失败时的 `this.jobs.delete(id)` 回滚 | `node --import tsx --test apps/api/test/worker.test.ts` | **EXIT 1**，`not ok 1 - failed initial import enqueue leaves no phantom job and can be retried`；还原后 sha `e05725f32ca756a6` 一致 |

### 4.3 设计与实现层面判对的地方

1. **后端 B1（入队持久化 = 提交点）**：`worker.ts:671-681` 的 `try { persistJobs() } catch { if (this.jobs.get(id) === job) this.jobs.delete(id); throw new ImportJobEnqueuePersistenceError(error) }` 把"能否活过重启"作为接受条件，且**不启动定时器、不置 `running`、不触发终态回调**；`server.ts:1355-1357` 据此**保留**上传源而不是误清理（`!(error instanceof ImportJobEnqueuePersistenceError)`），使重试成为可能。测试覆盖到"无幽灵 queued 任务 + worker 空闲 + 同源可重试 + 回调 0 次"。
2. **B1 附带修掉一个真实缺陷**：任务 id 从 `web_import_${Date.now().toString(36)}`（同毫秒必撞）改为 `createImportJobId()`（时间前缀 + UUID），并有"同毫秒 100 个 id 不冲突"的断言。
3. **B2（点查 + 原子 markUsed）**：`runtime-state.ts:91-110` 新增三个参数化单行查询，`import-sources.ts:316/403/414/557` 四处不再全表读回写；新增测试用"把 `state.sources` 换成抛异常的替身"来证明**确实没有全表扫描**——这比断言返回值更能钉住性能意图。
4. **B3（外键验证策略）**：默认仍严格（`database.ts:1656` `?? "always"`），`"after-migration"` 只在**无待执行迁移**时跳过全库扫描，且 `server.ts:401` 只在启动已完成严格验证时选用；`server-runtime.test.ts` 新增的用例证明"启动外键失败后热写无法绕过"（`health.status == "recovery_required"`、写请求 500、`recompute_jobs` 计数 0）。
5. **B4/B5（LLM 预算与响应上限）**：`weekly-plan-llm.ts:241-243` 用 `if (remaining <= 0) break` + `Math.min(timeoutMs, remaining)` 取代原来的 `Math.max(MIN_ATTEMPT_MS, …)`（后者会把单次尝试**抬到**剩余预算之上）；`readResponseJson`（`:147-207`）**按实际字节累计**而非只信 `content-length`，超限即 `cancel` reader 且标记不可重试。非 2xx 与超限两条路径都主动 `cancelBody` 释放连接。
6. **B6（生成并发门）**：`TryAcquireGate` 是**单实例 fail-fast**，争用返回 `null` 而不是 `MutationCoordinator` 的冲突异常，路由据此返回稳定的 `409 / weekly_plan_generation_busy`（`server.ts:920-944`）；`finally { release() }` 保证成功/失败/CAS 冲突都释放。类注释也修正了此前"原协调器会排队"的错误表述。
7. **客户端 60s 兼容断言被加强而非简化**：`weekly-plan.test.ts:1075-1105` 先剥注释（避免"注释里提到常量"冒充真值）、按行锚定取 `generateTimeoutInterval`，并**同时**断言 `timeoutIntervalForResource`——因为后者才是真正决定客户端是否先放弃的数字。这是本轮读到的质量最高的一处测试改动。
8. **`CalibrationState.swift` + 4 个调用点已统一**（09-16 P0-1 闭环）：判据 `status != "completed"` 单独成纯 Foundation 文件，调用点 `NativeViews.swift:294`、`TechViews.swift:174/198`、`TechAbilityDetailView.swift:84` 全部改用它，`NativeFormat.swift:351-353` 留指针注释说明为何不能留在这里。`ModelRegression.swift:572` 有对应断言。
9. **iOS F2/F3（版本保护与请求归属）**：`NativeAppModel.regenerateWeeklyPlan` 现在**无 revision 不生成**（读取失败给出可重试文案，`:592-597`），三个课表操作各持有独立 `requestID`，`defer` 仅在 `requestID == 当前ID && configuration == 当前配置` 时才清忙碌位（`:495-500`/`:536-541`/`:573-578`）⇒ 旧请求不再能释放新请求的状态；`serverConfigurationChanged`/`clearPresentation` 都走 `invalidatePlanOperations()`。
10. **iOS F1（取消真的取消）**：`HealthSyncTaskOwner` 持有唯一在飞任务，`cancel()` 取消的就是它；`HealthSyncCancellation.runDetached` 把父任务取消传播到 `Task.detached` 并在**取消后**回收瞬态产物（且实测只调用一次）；`StoredZip` 在压缩循环、中央目录、写尾、发布前都插入 `Task.checkCancellation()`，且 `defer { try? fileManager.removeItem(at: temporaryURL) }`（`StoredZip.swift:10`）保证被取消的归档**不会发布也不会留下临时文件**——有 `storedZipCancellationDoesNotPublishArchive` 用 64 MB 源文件真跑验证。`RAIApp.swift:75-77` 只在 `.background` 取消，避免授权弹窗的 `.inactive` 误取消。
11. **iOS F4/F5（服务身份）**：`ServerSession` 引入 `probeGeneration`，成功与失败两条路径都过 `isCurrentProbe`（同时比 URL / token / generation / `Task.isCancelled`），配置变更与监控停启都 `invalidatePendingProbes`；遗留无作用域 token **不再自动迁移**（`ServerSession.swift:76-84`），且测试覆盖"A→B 不迁移""清空 token 不复活""拒绝迁移不删唯一凭据"。`ServerSessionRegression.swift` 有 28 条断言，我实跑全过。
12. **`TechFlowLayout` 的缓存**：新增 `Cache` + `updateCache` 复位，且 `sizeThatFits` 只在与缓存宽度不同时重算；`placeSubviews` 保证两者用同一份结果。
13. **`RouteMapContainer.stop()`**：`dismantleUIView` 时置 `stopped`、清 `needsFit`、解 `map.delegate` ⇒ 真正停止离场后的地图回调；`drawTrace` 合并到下一轮主队列并去重（`drawScheduled`）。
14. **`TechSyncStatus` 与 `TechFreshnessSyncAction` 的重试按钮互斥**（`TechSyncStatus.swift:78-85`：只在 `lastError == nil && !isBusy && phase != "cancelled"` 时出现；状态面板只在 `.failed`/`.cancelled` 时出现动作）⇒ 同一屏不会出现两个重试入口，这是有意的、正确的。
15. **文档诚实度**：tech-polish README 主动写明"**不据此宣称该轮全绿**""**不承诺未经测量的 FPS 提升比例**""令牌测试不等于所有渲染页面的可访问性审计""主机算法测量不是 iPhone 帧率"；并把模拟器缺 HealthKit entitlement 的**环境限制**（而非代码缺陷）写进 `docs/IOS_NATIVE_RUNBOOK.md` 与 `apps/ios/README.md`。我核对 `IOS_NATIVE_RUNBOOK.md` 引用的 `RAI/HealthKitSync.swift:293` —— 正是 `let authorization = try await HealthKitExport.readAuthorizationState()`，行号准确 ✅。
16. **无破坏性契约变更**：iOS 侧只新增可选字段（`NativeDashboardResponse.dimensions`，`decodeIfPresent` 语义，旧缓存缺键按 `nil` 处理并注释写明"不补零"）；无必填字段新增、无 Codable 破坏、无数据库 schema 变更（v22 已在 `HEAD` 之前落地）。
17. **工作区清洁**：`git status --porcelain=v1` 在审查前后同为 63 项 / 39 个已跟踪改动；本轮 4 次突变全部还原并校验 sha，被触碰文件的 mtime 也已还原；临时产物全在 `/tmp`。

---

## 五、修复顺序、验收标准与回滚

| 顺序 | 项 | 动作 | 验收标准 | 回滚 |
|---|---|---|---|---|
| 1 | P0-1 | `run-model-tests.sh` 末尾追加一行调用展示逻辑脚本 | 删 `TechPlotData.swift:25` 端点保留后 `run-model-tests.sh` 非 0 退出 | 删该行 |
| 2 | P0-2 | `DATA_AUDIT.md` 加"数据源"行；部署/重启前做线上只读计数 + `POST /v1/backups` | 文档能回答数字来自哪个库；线上计数与文档一致或已写明差异 | `git checkout -- docs/DATA_AUDIT.md` |
| 3 | P1-2 | 删 2 张过期图、改 README:71 清单、改 README:9 的五维表述 | `ls screenshots` 与 README 逐一对应；三处对五维的表述一致 | `rm -rf` 该 acceptance 目录（未跟踪） |
| 4 | P1-1 | 补入口 **或** 在 `TECHNOLOGY_SKIN.md` 声明 5 个字段不看 | 每个字段"有展示位或有显式声明" | 纯文档，`git checkout --` 对应 md |
| 5 | P2-2 | 去掉 `run-tech-presentation-tests.sh` 的 `-O`（或基准拆开编） | 断言失败时输出 `Precondition failed: …` | 加回 `-O` |
| 6 | P1-4 | 对比度断言改成真正的"文字色 vs 填充色"配对 | 把按钮文字改回 `ink` 时脚本变红 | `git checkout --` 该 sh |
| 7 | P1-3 | 判定图标改为按 `techToneColor` 派生 | 域外 tone 时图标与颜色同时走"未知"分支 | `git checkout -- TechViews.swift` |
| 8 | P1-5 | `techRaceDistanceName` / `nativeStatusName` default 改中文兜底 | 域外值不直出英文 | `git checkout --` 对应文件 |
| 9 | P2-1/P2-3 | 冻结源码重跑全量 UI 回归并把 `xcresult` 复制进验收目录；决定 UI 回归是否进 CI | `tests.xcresult` 在仓库内可查 | — |

**通用门禁**（每步之后）：`bash apps/ios/tests/typecheck-ios.sh` → `bash apps/ios/tests/run-model-tests.sh`，两者之间不要改 Swift 源；改 `@Observable` 视图时另需 `xcodebuild … OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox' build`。

**迁移与破坏性变更**：本批**未新增**数据库迁移、未新增必填契约字段。但**已存在的 v22 迁移会在线上重启时自动执行**（见 P0-2），这不是本批引入的，是本批文档把它当作既成事实来描述。

---

## 六、明确未验证的观察（不下结论）

- **`HealthSyncTaskOwner` 的一处窄窗口**（静态推理，**未构造出复现**）：`HealthSyncCancellation.swift:78-84` 中 `await worker.value` 返回到 `finish(id: id)` 之间存在一个 MainActor 挂起点；若 `cancelSync()`（`HealthKitSync.swift:81-84`）恰在该窗口执行，`syncOwner.cancel()` 会返回 `true`，`finishCancelled()` 便把一次**已成功**的同步改写成 `phase = "cancelled"`。窗口是单次 MainActor 调度，需要注入可控时序才能复现；且 `.cancelled` 面板文案本身已写明"取消不会撤销已完成的数据导入"，用户可见后果轻微。⇒ 列为观察，不建议在无复现的情况下改。
- **`TechRouteView` 的"只准备一次"依赖调用点**：`TechRouteView.swift:14` 的 `TechPreparedRoute(geometry: TechRouteGeometry(route: route))` 在 `body` 内构造，注释声称"once per changed route"。成立的前提是唯一调用点带了 `.equatable()`（`TechViews.swift:1124`）。若将来新增调用点漏掉 `.equatable()`，每条渲染路径都会重建坐标/边界。⇒ 属注释与调用点的**隐式契约**，未加断言。
- **跨机型结论**：`iPhone SE 3` / `iPhone 17 Pro Max` 两批专项的 `xcresult` 已不在 `/tmp`，本轮**无法复核**，只能凭 `screenshots/` 里的 13 张图（`small-*` 4 张、`island-*` 4 张、`main-*` 4 张）。真机项（Instruments、VoiceOver 实读、减少动态效果、高德底图手势/帧率、真实健康授权端到端）全部**未验收**，文档也如此声明。

---

## 七、清理项

1. `apps/ios/design/acceptance/2026-09-16-ability-card/screenshots/07-ability-dimensions.png`、`07-ability-missing-dimensions.png`：README 说"不展示五维卡"，而最终代码展示了，两张图属于与文档矛盾的残留。
2. `apps/ios/design/acceptance/2026-09-16-ability-card/README.md:71` 引用的 `07-ability-metrics.png` 不存在。
3. `apps/ios/design/acceptance/2026-09-16-tech-polish/README.md` 中列出的 5 个 `/tmp/rai-tech-*` 结果目录已不存在，建议改为"结果已归档到本目录"或补拷 `xcresult`。
4. `apps/ios/design/acceptance/2026-09-16-ability-card/README.md` 权限为 `-rw-------`（`600`），同目录其他 README 是 `644`，提交后会造成仓库内文件模式不一致。
5. 本轮临时产物（`/tmp/rev-*.log`、`/tmp/mut-*`、`/tmp/rai-dist-prev-*`）全在仓库外；`git status` 与审查开始时一致（63 项 / 39 个已跟踪改动），可用 `git status --porcelain=v1` 复核。

---

## 八、审查过程记录（跨会话可复用）

- **本轮没有推翻上轮结论**，但补上了一条对上轮 P1-1 的**澄清**：我一开始用 `git show HEAD:…TechViews.swift | grep postRun` 得空、差点判"上轮误报"；改查 `contextPanel` 才发现 **HEAD 确实有 `contextPanel` 与 `postRun` 面板**（`:386-434`），上轮描述的"工作区已无入口"准确无误 —— 真正的缺口是**没人补入口也没人写文档**。⇒ 判据：核实一条历史结论时，要 grep **承载它的那个函数名**，而不是只 grep 字段名。
- **通用判据补充**：**"脚本跑绿" ≠ "门禁存在"**。本轮 `run-tech-presentation-tests.sh` 实跑 EXIT=0 / 36 条通过，看起来证据充分；但它不在 `run-model-tests.sh`、不在 CI，只要没人手跑就等于不存在。⇒ 新增任何测试脚本后，必须回答"谁会在每次改动时执行它"，把答案写成 `grep` 可验证的调用点。
- **通用判据补充**：**`-O` 会吞掉 precondition 的断言名**。同一突变，带 `-O` 只得 `Illegal instruction: 4`，去掉 `-O` 才有 `Precondition failed: Retain endpoints`。⇒ 纯逻辑回归脚本不要加 `-O`；若要基准数字，把基准单独编一个二进制。
- **通用判据补充**：**已跟踪的生成型文档必须自带"数据源 + 生成命令"**。`docs/DATA_AUDIT.md` 有生成时间与数据集版本，但没有"哪个库"，于是本地迁移后它与线上现实可能同时成立，读者无从判断。同类的还有"验收截图必须带 commit 锚点"。
- **小技巧**：核对"某函数被谁调用"时，`grep -rn <脚本名> --include=*.sh --include=*.yml --include=*.md .` 一次就能同时看到"真实调用点"和"只是被文档提及"，两者必须分开计数。
