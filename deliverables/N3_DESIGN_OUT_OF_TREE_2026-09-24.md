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
| **结果（实测）** | 全新 `clone` **77 MB → 33 MB（-57%）**；`.git` 本地 **77 MB → 32 MB**；历史中设计图 **6 → 0**；提交数 **239 不变**；`git fsck --full` **零输出** |
| 🔴 过程中的坑 | filter-repo 报"完成"**不等于**对象真没了。第一次清理后 `in-pack` 仍是 **3659**（可达只有 3647）⇒ 差额 12 个对象 = 27.34 MiB 全都还在。根因是一个**残留 linked worktree 的 stale index cache-tree**（详见 §四点五）——`git worktree prune` 一行解决 |
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

### 4.2 重写命令

🔴 **不能用 `--path apps/ios/design/technology-v1 --invert-paths`**（整目录）——那会连
`README.md` 与 `prompts.jsonl` 一起从历史里删掉，而这两个文件我们**明确要保留**。
必须逐个点名：

```bash
git filter-repo --force --invert-paths \
  --path apps/ios/design/technology-v1/01-today-body.png \
  --path apps/ios/design/technology-v1/02-workouts.png \
  --path apps/ios/design/technology-v1/03-plan.png \
  --path apps/ios/design/technology-v1/04-analysis.png \
  --path apps/ios/design/technology-v1/05-settings-sync.png \
  --path apps/ios/design/technology-v1/06-states-body-detail.png \
  --path apps/ios/design/technology-v1/index.html
```

（`--force` 是必需的：filter-repo 默认只接受"新 clone"。）

### 4.3 先在副本上试跑（不碰真库）

```
git clone --mirror /Users/ta/Documents/rai-git-mirror-2026-09-24 /tmp/rai-rewrite-test
/tmp/frvenv/bin/git-filter-repo --force --invert-paths --path … （同上）
```

| 副本指标 | 试跑前 | 试跑后 |
|---|---|---|
| 体积 | 77 M | **31.63 MiB** |
| 提交数 | 239 | **239** |
| `technology-v1` 下的 `.png` | 6 | **0** |
| tip 树里该目录 | 9 项 | **`README.md` + `prompts.jsonl`** |

⇒ 参数正确、结果可预期，才动真库。

### 4.4 真库重写结果

`HEAD` = **`09f9ffb`** —— 与副本试跑**完全一致**（重写是确定性的，可作互校证据）。

| 指标 | 重写前 | 重写后 |
|---|---|---|
| `.git` | 77 MB | **32 MB** |
| 松散对象 | 73.76 MiB（2808） | **0** |
| `size-pack` | 58.97 MiB | **31.7 MiB** |
| in-pack 对象数 | 3659 | **3647**（= 可达对象数，一个不多） |
| 历史中 `technology-v1` 的 `.png` | 6 | **0** |
| 提交数（`--all`） | 239 | **239** |
| `git fsck --full` | — | **无任何输出** |

**SHA 映射（旧 → 新）**：

| 旧 | 新 | 提交 |
|---|---|---|
| `7e05285` | `950462a` | pre-commit 迁移冻结门禁（基线） |
| `342ae38` | `31c58ea` | 迁移校验和冻结 |
| `41a2e61` | `9e1cf13` | **N-3 设计板出库 + 体积闸门** |
| `a65293b` | `83ec794` | **N-1 注释订正** |
| `dbe2951` | `378cb66` | **N-2 身份算法闸门** |
| `d2a7f0d` | `09f9ffb` | **docs：三份修复报告** |

### 4.5 远端与全新 clone 验收（决定性证据）

```
git push --force -u origin main
  → + 7e05285...09f9ffb main -> main (forced update)

git clone https://gitee.com/tpandmr/running.git /tmp/rai-fresh-clone
```

| 指标 | 重写前 | 重写后 |
|---|---|---|
| 全新 clone 的 `.git` | **77 MB** | **33 MB** |
| `size-pack` | — | **33,101 KB** |
| 历史中 `technology-v1` 的 `.png` | 6 | **0** |
| `cat-file -t d28cee4d`（4.81 MB 那张） | blob | **`fatal: Not a valid object name`** |
| 提交数（`main`） | 215（重写前同数） | **215** |
| `HEAD` | — | `09f9ffb` ✔ 与本地一致 |

⇒ **降 44 MB（-57%）**。其中设计板本体 **27.24 MB**，其余是那 22 个历史对象在多个分支上的重复副本与打包开销。
（新 clone 3596 个对象 < 本地 3647，差额是**只存在于本地**的 `backup/*`、`land/*` 分支——它们**没有**被推送到远端。）

---

## 四点五、🔴 清理未生效的真相：残留 linked worktree 的 stale cache-tree

**这一步比重写本身更值得记录。**

filter-repo 报"Completely finished"，`git log` 也正确 —— 但 `git count-objects` 显示
**in-pack 3659**，而 `git rev-list --objects --all` 只有 **3647**。
差额 **12 个不可达对象 ≈ 27.34 MiB**，正是那 7 个文件 + 5 个旧树 —— **目标没达成**。

### 试过的、全部无效的清理手段

| 命令 | 结果 |
|---|---|
| `git repack -a -d -f` | in-pack 仍 3659 |
| `git repack -A -d` + `git prune --expire=now` | 仍 3659 |
| `git repack -a -d --no-keep-unreachable` | 仍 3659 |
| `git -c gc.cruftPacks=false gc --prune=now` | 仍 3659 |
| `git repack -a -d --cruft` | 仍 3659 |
| `git reflog expire --expire=now --all`（reflog 本来就已 0 条） | 无变化 |

`git repack -h` 给出线索：`-k, --[no-]keep-unreachable   with -a, repack unreachable objects`
⇒ `-a` 家族**默认就会把不可达对象一起重打包**，所以从"打包策略"这一侧怎么调都没用。

### 真正的根因（`git fsck` 一句话点破）

```
error: 840267aaa101ad88483eecfb267b8f48eb22203b:
       invalid sha1 pointer in cache-tree of .git/worktrees/rai-n2/index
```

🔴 **`.git/worktrees/rai-n2/` 是本次会话早先建的 linked worktree**（工作目录 `/private/tmp/rai-n2`
**早已不存在**，记录还在，被 git 标为 `prunable`）。

- filter-repo **重写了这个 worktree 的 `HEAD`**（`950462a`，与重写后一致）；
- 但**没有重写它 `index` 里的 `cache-tree`** —— 那个陈旧 cache-tree 仍指着重写前的根树 `840267a`；
- 而 **git 的 gc/repack 会把 linked worktree 的 index 也当作可达性根** ⇒ 旧根树 + 6 张图被一路保活。

### 修法（一行）

```bash
git worktree prune      # Removing worktrees/rai-n2: gitdir file points to non-existent location
```

⇒ 立刻 `git fsck --full` **零输出**，in-pack 从 3659 掉到 **3647**，`.git` 从 59 MB 掉到 **32 MB**。

### 为什么副本试跑是干净的

`git clone --mirror` 出来的副本**没有 worktree 记录**，所以同一个 filter-repo 在副本上
一次就干净。⇒ **"副本上干净"不能替代"真库上干净"**，两者差的就是这类**仓库外挂状态**
（linked worktree / reflog / `.keep` pack / 伪 ref）。

> 📌 这条已写进项目记忆：**"filter-repo 跑完 ≠ 对象真没了"**，判据必须是
> `in-pack == rev-list --objects --all 的对象数`，不是"命令退出码为 0"。

---

## 五、验收标准与回滚

| | |
|---|---|
| **验收标准** | ① 全新 `clone` 体积真降（实测 **77 MB → 33 MB**）；② `git rev-list --all --objects` 中 `technology-v1` 的 `.png` **归零**；③ `git cat-file -t <blob>` ⇒ not a valid object；④ 工作树干净、`git fsck --full` **零输出**、`in-pack == rev-list --objects --all` 计数；⑤ 提交数不变（239 / main 215）；⑥ 备份目录 6 张 PNG sha256 可校验 |
| **回滚** | 🟡 **仅靠备份**。`git revert` **无效**（历史已被重写，没有"上一步"）。回滚动作 = 从 `/Users/ta/Documents/rai-design-archive-technology-v1/`（设计图）或 `/Users/ta/Documents/rai-git-mirror-2026-09-24`（重写前完整镜像，含 `.git`）恢复，**但旧 SHA 回不来** |
| **不可逆风险** | 🔴 **全部提交 SHA 改变**；既有 clone 与远端失配，需强推 + 其他人重新 clone；4 个本地 `backup/pre-rewrite-*` 分支也被改写（已在重写后逐一确认仍可解析）。**此路径已由用户显式确认。** |

---

## 六、补充：删除 `index.html` 的理由

`index.html`（3.5 KB）本身不是体积问题，但它**整个文件就是那 6 张图的浏览页**（`<img>` 全指向
`technology-v1/*.png`）。图出库后它已无对象可指向 ⇒ 与图同批出库，引用改由
`acceptance/2026-09-09/visual-review/index.html` 的说明段落承担。
仓库外的归档里同时保留了它（`~/Documents/rai-design-archive-technology-v1/index.html`）。

