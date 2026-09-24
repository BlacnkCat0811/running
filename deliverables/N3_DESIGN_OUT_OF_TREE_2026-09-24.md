# N-3 设计图出库 + 历史重写 · 执行与验证报告

> **日期**：2026-09-24
> **来源**：`deliverables/PROJECT_AUDIT_2026-09-23.md` §四 N-3
> **性质**：🔴 **不可逆**（重写全部提交）。用户经确认选择 **「出库并清历史」**（最彻底方案）。
> **远端**：`origin = https://gitee.com/tpandmr/running.git`

---

## 一、结论先行

| 项 | 结论 |
|---|---|
| 问题 | 6 张 4K 设计板（**4.37–4.81 MB/张，合计 27.24 MB**）进了 `apps/ios/design/technology-v1/`，由 `255a7d8` 入库；**git 历史里永久存在** |
| 为什么 `git rm` 不够 | 删掉只影响后续提交。`clone` 仍要拉全部历史 ⇒ 体积一分不降。**只有重写历史才能真降** |
| 为什么"压缩"不够 | PNG 已是 DEFLATE，二次压缩收益≈0（`git gc` 结束后 `size-pack` 仅 3.19 MiB，说明**大头全在松散对象里**：**73.76 MiB**） |
| 为什么"加 `.gitignore` 规则"不够 | 🔴 **根因不是规则太窄**——逐版本扫 `.gitignore` 全部 8 个历史提交，**从未出现过任何 `*.png`／`design`／`images` 规则**。上轮做的是一次**一次性人工清理**，没留下任何自动入口 ⇒ 换目录自然复发 |
| 采用的路径 | ① 外置备份（sha256 逐个校验）→ ② 改写全部引用 → ③ `git rm` → ④ **`git filter-repo --invert-paths` 重写全历史** → ⑤ 强推 |
| 防复发 | 新增**路径无关**的体积闸门 `scripts/check-blob-size.mjs`，挂在 `.githooks/pre-commit` **首段**（触发面**刻意不收窄**：每次提交都跑，毫秒级） |

---

## 二、修复执行（五步）

### 步骤 1 · 外置备份（在动任何东西之前）

| | |
|---|---|
| 位置 | `/Users/ta/Documents/rai-design-archive-technology-v1/` |
| 内容 | 6 张 PNG + `index.html` + `prompts.jsonl` + `README.md`，共 **27 MB** |
| 校验 | **6/6 sha256 与 `HEAD:apps/ios/design/technology-v1/*.png` 的 blob 逐字节一致** |

```
e91f6b27…  01-today-body.png
cb55c4a4…  02-workouts.png
659effed…  03-plan.png
07558ded…  04-analysis.png
a4a865b6…  05-settings-sync.png
05ba467d…  06-states-body-detail.png
```

> 🔴 备份必须放在**仓库外**：4 个 `backup/pre-rewrite-*` 分支**也含这些图**，会被同一次重写一起改写 ⇒ 仓库内分支**不能**当备份。

### 步骤 2 · 改写全部引用（先让引用不再指向被删对象）

| 文件 | 改法 |
|---|---|
| `apps/ios/design/technology-v1/README.md` | 第 3 行改为"N 张设计板原图与浏览页已于 2026-09-24 移出仓库…"；**「仓库体积」整节重写**：三路径取舍表（`git rm --cached` / LFS / **移出+重写历史**，标已采用）、`.git` 体积实测、原图新位置 |
| `apps/ios/README.md` | 引用点改完 + 相对链接 |
| `apps/ios/design/TECHNOLOGY_SKIN.md` | 2 处 |
| `acceptance/2026-09-09/visual-review/index.html` | 🔴 **6 个 `<details>` 设计板块 → 说明段落**；**49 张原生验收截图 `<img>` 全部保留** |
| `acceptance/2026-09-09/visual-review/README.md` | 引用改指向 README 的「仓库体积」 |
| `acceptance/2026-09-10-replica/README.md` | 同上 |

**改写结果的机检**：

```
visual-review/index.html：<img> 标签总数 = 49      ← 验收证据一张没少
                          指向 technology-v1 的 img = 0
                          class="board" = 0
                          <details> = 0
```

全仓残留引用只剩**两类，且都是正确的**：
- 两份**历史审计文档**（`docs/PROJECT_HEALTH_AUDIT_2026-09-10.md:63`、`deliverables/PROJECT_AUDIT_2026-09-12.md:141`）——它们是**当时状态的快照**，本就该保留原样；
- 两个 README 的**说明性引用**（指向"已移出"的事实本身）。

### 步骤 3 · 出库

`git rm` 6 张 PNG + `index.html`（7 个文件删除，已入索引）。
`README.md` 与 `prompts.jsonl` **留在仓库**（合计 <20 KB，是设计板的可检索说明与生成提示词）。

### 步骤 4 · 防复发闸门（新）

`scripts/check-blob-size.mjs`（`MAX_BLOB_BYTES = 1_500_000`）：

| 设计点 | 为什么 |
|---|---|
| 读 **`git write-tree`（索引）** 而非 `git ls-tree HEAD` | `HEAD` 晚一步——超限 blob 那时已经存在。读索引能在 **commit 对象生成之前**拦下 |
| 用**字节上限**而非 `.gitignore` 模式 | 模式必须点名路径，而"点名路径"正是**已经失败过一次**的做法。字节上限**路径无关**，换目录也守得住 |
| **不**用泛化 `*.png` 忽略 | 仓库**合法跟踪 ~100 张** 0.4–0.5 MB 验收截图。忽略扩展名会让新验收证据**静默消失**——那比大文件更糟 |

挂载点：`.githooks/pre-commit` **首段**，`node scripts/check-blob-size.mjs`，**触发面不收窄**。

### 步骤 5 · 历史重写（见 §四）

---

## 三、闸门的红→绿验证（天然突变）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 绿 | 当前索引 | `blob 体积闸门：714 个已跟踪文件全部 ≤ 1500000 bytes` / **EXIT=0** |
| 红 | 塞一个 2 MB 假 blob 进索引 | `blob 体积闸门：1 个文件超过 1.43 MB` + `2.00 MB  __n3_probe_oversized.bin` / **EXIT=1** |
| 绿 | 清理后再跑 | 回到 `714 个…≤ 1500000 bytes` / **EXIT=0** |

⇒ 闸门可证伪（不是恒绿），且**在索引层**就能拦。

> 附注：此校验现在报"714 文件全绿"，是因为 **7 个文件删除已在索引里**；而 `git ls-tree -r -l HEAD` 仍能看到那 6 张 4.81 MB 的 PNG —— 这正是"读索引而非 HEAD"的直观体现。

---

## 四、历史重写执行结果

> 工具：`git filter-repo`（本机原本没有；无 `brew`、无 `java` ⇒ BFG 不可用。已装入临时 venv：`python3 -m venv /tmp/frvenv && /tmp/frvenv/bin/pip install git-filter-repo` ⇒ `--version` = `a40bce548d2c`）

### 4.1 重写前的基线

| 指标 | 值 |
|---|---|
| `.git` 总大小 | **77 MB** |
| 松散对象 | **73.76 MiB**（2808 个） |
| pack | 3 个，`size-pack` **3.19 MiB** |
| `HEAD` 最大 blob | **4.81 MB**（`01-today-body.png`） |
| 目标路径历史对象 | **22 条**（涉及 **2 个提交**：`255a7d8`、`590f58b`） |

### 4.2 重写命令与结果

```
git filter-repo --path apps/ios/design/technology-v1 --invert-paths --force
```

> ⏳ 结果栏在重写执行后回填（见本文件末尾「重写后回填」）。

---

## 五、验收标准与回滚

| | |
|---|---|
| **验收标准** | ① 新 `clone` 体积真降 ≈27 MB；② `git log --all --objects -- apps/ios/design/technology-v1` 在**所有 ref** 上归零；③ `git cat-file` 任一历史提交的该路径 ⇒ 不存在；④ 工作树 `git status` 干净、`npm test` 全绿；⑤ 备份目录 6 张 PNG sha256 可校验 |
| **回滚** | 🟡 **仅靠备份**。`git revert` **无效**（历史已被重写，没有"上一步"）。回滚动作 = 从 `/Users/ta/Documents/rai-design-archive-technology-v1/` 重新拷回并提交（**新的 SHA，旧 SHA 回不来**） |
| **不可逆风险** | 🔴 **全部提交 SHA 改变**；既有 clone 与远端分支失配，需强推 + 其他人重新 clone；4 个本地 `backup/pre-rewrite-*` 分支也会被改写。**此路径已由用户显式确认。** |

---

## 六、重写后回填

> ⏳ 待执行。
