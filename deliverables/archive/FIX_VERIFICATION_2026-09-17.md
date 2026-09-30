# 审查问题复核与修复验证（2026-09-17）

> 对象：`deliverables/UNCOMMITTED_REVIEW_2026-09-17.md` 列出的 10 条问题（P0×2 / P1×5 / P2×3）。
> `HEAD = bd1ee25`（未提交，工作区仍为改动状态）。
> 方法：每条**先独立复核**（读实现 / 跑探针 / 手算 / 对照项目既有惯例），确认成立后才动手；修完对每条做**突变或反实验**证明修复真的能拦住回归。
> 所有突变都已还原，关键文件 `shasum -a 256` 校验一致，被触碰文件的 `mtime` 也已复原。

---

## 一、复核结论：8 条成立，1 条部分驳回，1 条待决策

| 编号 | 原判 | 复核 | 决定性证据 | 处置 |
|---|---|---|---|---|
| P0-1 | 展示逻辑门禁是孤儿 | ✅ **成立** | `run-model-tests.sh` 末尾只挂 session + health-sync；全仓 `grep -rn run-tech-presentation-tests` 只命中 `*.md` | 已修 + 突变验证 |
| P0-2 | 文档无数据源 / 线上状态未知 | ✅ **成立**（文档侧） | `docs/DATA_AUDIT.md` 头部只有生成时间/数据集版本/隐私，`grep "数据源\|本地\|线上"` 返回**空** | 已修生成器 + 已重生成文档；**线上探测需授权** |
| P1-1 | 科技风 5 字段零入口且未声明 | ✅ **成立** | 10 个字段逐个 grep：`data.phase`/`race.note`/`shapeScore`/`taper`/`postRun` **各 0 处**，与报告列的 5 个完全吻合；其余字段另有入口 | 已声明（补入口是产品决策，见 §4） |
| P1-2 | ability-card 验收材料与代码矛盾 | ✅ **成立，但修法被推翻** | README:9「不展示五维」vs `TECHNOLOGY_SKIN.md:37`「→ 能力分析（五维）→」；而代码 `TechAbilityDetailView.swift:107` 确有 `dimensionsPanel`，README 自己第 33 行还写着"为五维补 `dimensions`" ⇒ **错的是文字，不是图** | 已修文档；**图未删**（见 §1.1） |
| P1-3 | 判定图标用第二份 tone 列表、未知落"安抚" | ✅ **成立，且证据升级** | 同一字段两个皮肤**行为相反**：像素风 `NativeViews.swift:312` 是白名单（`tone == "green"` 才对勾），科技风 `TechViews.swift:220` 是黑名单 | 已修 + 加断言 + 突变验证 |
| P1-4 | 对比度断言名不符实 | ✅ **成立，但性质需澄清** | 手算：旧算式 `lum(fill) vs lum(background)` = 11.53 / 7.32，与"background 文字压填充"**数值恰好相同**（background 最暗、填充最亮）⇒ 不是配色不合格，而是**公式不引用文字色** | 已修 + 反实验证明（见 §3.1-C） |
| P1-5 | `default` 直出英文，与相邻注释矛盾 | ⚠️ **部分驳回** | `NativeFormat.swift` 三个同类函数**全部**直出原值（`nativeSessionName:126`、`nativeStimulusName:266`、`nativeStatusName:347`）⇒ 那是**像素风既定惯例**，不该改；真正矛盾只在科技风内部（`techPaceZoneName:290` 不直出 vs `techRaceDistanceName:305` 直出） | 只修科技风内部矛盾 |
| P2-1 | 最终 UI 回归非全绿、`/tmp` 证据消失 | ✅ **成立** | `ls /tmp \| grep rai-tech` 只剩 6 项；README 引用的 5 个结果目录全不存在 | 已更正文档表述；**重跑待时间窗**（见 §4） |
| P2-2 | `-O` 吞掉断言名 | ✅ **成立**，且排除了更坏的可能 | 复现：带 `-O` 只输出 `Illegal instruction: 4`；去掉后 `Precondition failed: Retain endpoints`。同时确认断言用的是 `precondition`（**不是** Swift `assert`），`-O` 下仍会执行（EXIT 132 为证）⇒ 只是丢消息，不是断言消失 | 已修 |
| P2-3 | UI 验收用例不在 CI | ⏸ **待决策** | `ci.yml` 的 `ios` job 从不构建 `VisualAcceptance.xcodeproj` | 未动，等拍板 |

### 1.1 被推翻的一条：P1-2 该改的是文档，不是删图

原报告建议"删两张过期图 + 改 README"。复核后**只采纳后半句**：

- `07-ability-dimensions.png` / `07-ability-missing-dimensions.png` 展示的正是**实现的形态**（五维面板与缺值形态），代码与 `TECHNOLOGY_SKIN.md` 都支持它存在 ⇒ 图是**有效证据**。
- 矛盾的一侧是 `README.md:9`，而且该 README 的 mtime（09-16 15:56）早于实现定稿（22:03），属**过期描述**。
- 若按原建议删图，反而会删掉唯一能证明"五维确实做了"的视觉证据。

⇒ 处置：改 `README.md:9` 与截图清单（顺带修正引用不存在的 `07-ability-metrics.png`），并在该 README 内写明这次修正的依据。同时把该文件权限从 `600` 改为 `644`（同目录其他 README 都是 `644`）。

---

## 二、修复清单（15 个文件）

| # | 文件 | 改动 | 对应 |
|---|---|---|---|
| 1 | `apps/ios/tests/run-model-tests.sh` | 末尾挂载 `run-tech-presentation-tests.sh` | P0-1 |
| 2 | `apps/ios/RAI/VerdictPresentation.swift` | **新增**纯 Foundation 判据 `verdictIconName(tone:)`（白名单） | P1-3 |
| 3 | `apps/ios/RAI/Skins/Technology/TechViews.swift` | 判定图标改用 `verdictIconName`，删掉硬编码的第二份 tone 名单 | P1-3 |
| 4 | `apps/ios/RAI/Skins/Technology/TechAbilityDetailView.swift` | `techRaceDistanceName` 的 `default` 改中文兜底（与相邻 `techPaceZoneName` 对齐） | P1-5 |
| 5 | `apps/ios/tests/run-tech-presentation-tests.sh` | 去掉 `-O`；纳入新文件；**重写对比度断言**（从源码提取"文字色 / 填充色"配对） | P1-4 / P2-2 |
| 6 | `apps/ios/tests/TechPresentationRegression.swift` | 新增 5 条判定图标断言；微基准措辞标注"非优化构建" | P1-3 / P2-2 |
| 7 | `packages/health-export-parser/src/audit.ts` | `DataAudit` 加 `sourceDatabase`；模板头部加"数据源"行；三个写出函数透传 | P0-2 |
| 8 | `packages/health-export-parser/src/cli.ts` | 新增 `--source-database`；默认取 `--database` 的相对路径，工作区外只留文件名 | P0-2 |
| 9 | `apps/api/src/worker.ts` | 调 CLI 时传 `--source-database this.databasePath`（主库，而非暂存副本） | P0-2 |
| 10 | `apps/api/test/worker.test.ts` | 加断言：审计命令必须带 `--source-database` 且等于主库路径 | P0-2 |
| 11 | `docs/DATA_AUDIT.md` | 按新模板**重新生成**，头部出现 `> 数据源：var/rai.sqlite` | P0-2 |
| 12 | `apps/ios/design/TECHNOLOGY_SKIN.md` | 新增"科技风不展示的字段"一节（5 字段逐条 + 可复核命令）；同步 41/24/46 文件等数字 | P1-1 |
| 13 | `apps/ios/design/acceptance/2026-09-16-ability-card/README.md` | 修正五维表述与截图清单、加修正说明、权限 644 | P1-2 |
| 14 | `apps/ios/design/acceptance/2026-09-16-tech-polish/README.md` | 同步 41 条 / 24 组 / 46 文件；`/tmp` 证据不可复核的更正 | P1-4 / P2-1 |
| 15 | `apps/ios/README.md` | `run-model-tests.sh` 从"跑三组"更正为**七组**（原文已过时，本次挂载后差距更大） | P0-1 连带 |

> 第 15 项是复核过程中**顺手发现**的同类缺陷：文档说"三组"、实际早已五组，本次挂载后为七组。属"文档-代码不同步"的同族问题，一并修掉。

---

## 三、验证

### 3.1 突变 / 反实验：4 处全部真红

| # | 突变 | 命令 | 结果 | 结论 |
|---|---|---|---|---|
| A | `TechPlotData.swift` 删掉 `result.append(valid[valid.count - 1])`（端点保留） | `bash apps/ios/tests/run-model-tests.sh` | **EXIT=132** + `main/TechPresentationRegression.swift:8: Precondition failed: Retain endpoints` | **P0-1 的验收标准达成**——修复前这条聚合命令必然 EXIT=0（它压根不跑该脚本），现在会拦下 |
| B | `VerdictPresentation.swift` 改回旧的黑名单实现 | 展示逻辑脚本 | **EXIT=132** + `Precondition failed: Unknown tone fails closed, not open` | P1-3 修复有效；且断言名可见，**同时证明 P2-2 已修**（若仍有 `-O`，这里只会看到 `Illegal instruction: 4`） |
| C | `TechTheme.swift` 把主按钮文字 `background` → `ink` | 展示逻辑脚本 | **EXIT=1** + `AssertionError: Primary button label (ink on action): 1.55 < 4.5` | **P1-4 的验收标准达成**。关键对照：**旧公式对同一突变会算出 11.53 并照样通过**——因为它不引用文字色 |
| D | 上述每一次突变后 | `shasum -a 256` | `TechPlotData`=`fe934c0c7adca2d5`、`TechSyncPresentation`=`8de4fdb4a2eda389`、`TechTheme`=`20873ead0f5fb12e`、`VerdictPresentation`=`7bfbc0e3978141ca` 全部与突变前一致 | 无残留突变 |

### 3.2 修复前后对比（同一突变，行为不同）

| 突变 | 修复前 | 修复后 |
|---|---|---|
| 删端点保留（A） | `run-model-tests.sh` **EXIT=0**（脚本不在调用链上） | **EXIT=132**，指名 `Retain endpoints` |
| 按钮文字改 `ink`（C） | 旧断言算 `lum(action) vs lum(background)` = **11.53，通过** | **EXIT=1**，指名 `ink on action: 1.55 < 4.5` |
| 域外 tone | 黑名单 ⇒ 渲染成"对勾 + 青色"（看起来一切正常） | 白名单 ⇒ 感叹号，且断言拦下 |

### 3.3 门禁实跑（全部本机执行）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT 0**（双 tsconfig） |
| `npm test` | **628 tests / 625 pass / 0 fail / 3 skip**；vitest **13 文件全过**；EXIT 0 |
| `node --import tsx --test apps/api/test/worker.test.ts` | **88 tests / 87 pass / 0 fail** |
| `npm run build` | **`✓ built in 13.15s`**，0 error |
| `bash apps/ios/tests/typecheck-ios.sh` | **EXIT 0** — `类型检查 46 个文件`（45→46，新文件由 glob 自动纳入） |
| `bash apps/ios/tests/run-model-tests.sh` | **EXIT 0** — 七组全过，含 **`Technology presentation: 41 checks passed`** 与 **`24 foreground/background pairs`**；`PASS:` 121 条 |
| `git diff --check` | 仅报 `DATA_AUDIT.md` 头部与模板的**行尾两空格** —— 已核对 `git show HEAD` 版：这是**既有 markdown 硬换行风格**，非本次引入 |
| `npm run test:e2e:web` | 本机仍不可运行（无 Chrome/Edge），与既有记录一致 |

### 3.4 数据源修复的端到端验证

```bash
# ① 本地库（工作区内）——重新生成后的头部
$ head -5 docs/DATA_AUDIT.md
> 生成时间：2026-09-17T04:32:53.902Z
> 数据源：var/rai.sqlite          ← 新增
> 数据集版本：dataset_03e90c69d86a52330a8677744818d423

# ② 与修复前逐行 diff：除"生成时间"外**只有**新增的数据源行
$ diff /tmp/data-audit-before.md docs/DATA_AUDIT.md
3c3,4
< > 生成时间：2026-09-17T03:20:46.182Z
---
> > 生成时间：2026-09-17T04:32:53.902Z
> > 数据源：var/rai.sqlite
```

⇒ 除时间戳外**所有数字完全一致**（`health_records = 83380` 等），说明重新生成没有改变数据，只补上了溯源信息。

```bash
# ③ 工作区之外的库（模拟"线上库被复制出来"的情形）：不泄露绝对路径
$ npx tsx packages/health-export-parser/src/cli.ts audit --database /tmp/audit-probe.sqlite ...
> 数据源：(工作区外) audit-probe.sqlite
```

### 3.5 工作区状态

- 复核前：已跟踪改动 **39** + 未跟踪 **25** = 64 项
- 复核修复后：已跟踪改动 **41**（+`audit.ts`、+`cli.ts`）+ 未跟踪 **26**（+`VerdictPresentation.swift`）= 67 项
- `HEAD` 未变（`bd1ee25`，本轮只改工作区，未提交）

---

## 四、未闭环 / 待你决定（3 项）

### 4.1 P0-2 的线上侧：只能你来拍板

本地已迁完（`health_records = 83380`、`schema_migrations = 22`、`applied_at = 2026-09-17T00:46:14Z`，自动备份 324 MB 在 `var/backups/`），但**线上是否同构从未实测**。而 `server.ts:400` 的 `openMainDatabase` 不传 `createMigrationBackup` ⇒ 走默认 `true` ⇒ **线上下次 `systemctl restart rai-api` 会自己跑同一条迁移**（本地 160k 行实测 44.3s 停机窗口）。

我不会在未经你同意的情况下去读生产库。需要的话给我一句话，我按这个顺序执行（全部只读，除备份）：

```bash
# 1) 线上只读计数（判断是否真的要跑删除）
sudo -u rai sqlite3 /var/lib/rai/rai.sqlite \
  "SELECT (SELECT COUNT(*) FROM health_records) AS rows,
          (SELECT MAX(version) FROM schema_migrations) AS migration;"
# 2) 若要重启：先 POST /v1/backups，再确认停机窗口，最后 restart
```

**验收标准**：线上 `rows` 与文档数字一致，或文档明确写出差异。

### 4.2 P1-1：我选了"显式声明"，补入口是产品决策

`data.phase` / `race.note` / `race.shapeScore` / `race.taper` / `postRun` 这 5 个字段在科技风**确实没有展示位**（实测零引用）。我做的是**在 `TECHNOLOGY_SKIN.md` 里显式声明 + 记录原展示位 + 给出建议补入口位置**，把"静默丢失"变成"已声明的取舍"。

**没有动代码**，理由：这一批科技风改版是照着参考图重排的，移除旧上下文面板看起来是有意为之；擅自补回去可能与设计意图冲突。若你要补，我的建议是——`race.note`/`daysUntil` 并入比赛目标卡副标题（那里已有 `race.target`），`postRun` 并入训练详情页；`shapeScore`/`taper` 更适合放进「训练目标」编辑页。

### 4.3 P2-3：UI 回归是否进 CI

`ci.yml` 的 `ios` job 至今不构建 `VisualAcceptance.xcodeproj`，本批新增的 5 个用例（`test11`–`test14`）只有本机通道验证过。另外**本次改了 Swift 源**（新增 1 个、修改 2 个）⇒ 09-17 08:58 那一轮的 UI 回归证据按项目的冻结规则**已失效**，要重新建立。全量 14 项在 iPhone 12 Pro Max 上耗时约 26 分钟。

---

## 五、回滚

| 项 | 回滚方式 |
|---|---|
| 全部代码/文档改动 | `git checkout -- <file>`；新增文件删掉 `apps/ios/RAI/VerdictPresentation.swift` 即可 |
| `docs/DATA_AUDIT.md` | `git checkout -- docs/DATA_AUDIT.md`（重跑 `npm run data:audit` 也会重新生成） |
| 本地数据库 | 本轮**未写库**（`schema_migrations` 已是 22，无待执行迁移）；如需回退用 `var/backups/rai.before-v22.*.sqlite` |
| 线上 | **未触碰**，无需回滚 |

**无新增数据库迁移、无破坏性契约变更。** 唯一新增的载荷字段是 `DataAudit.sourceDatabase`（审计报告内部结构，不对外）；iOS 侧只新增了一个纯函数文件。

---

## 六、方法记录（可复用的判定）

1. **"断言名不符实"要分两种**：数值是否也错，决定了它是"配色缺陷"还是"覆盖缺口"。本次手算发现旧公式与正解**数值恰好相等**（因为 background 最暗、填充最亮），所以真问题是"改文字色时门禁不动"——修法也就从"改配色"变成"让断言跟着源码取 token"。
2. **修断言时要断言"提取成功"**：新对比度断言从源码取 token，正则取不到就 `assert` 失败。否则源码一改写，门禁会**静默失效**——那正是本轮 P0-1 的同类失效模式。
3. **"与相邻代码矛盾"不等于"要与相邻代码一致"**：`nativeStatusName` 的直出看着像疏漏，但对照 `NativeFormat.swift` 三个同类函数后可知那是**像素风惯例**，改它反而是破坏一致性。判据必须落到"该文件所在层的约定"，不能只看相邻两行。
4. **`chmod` 也是仓库状态**：`600` 的 README 提交后会在仓库里留下不一致的文件模式，和内容错误一样要修。
5. **复核既有结论要 grep 承载它的东西**：本轮用"逐字段计数"而不是"读文档描述"来确认 P1-1 的 5 个字段，结果与原判完全吻合；反过来也说明原判不是靠印象写的。
