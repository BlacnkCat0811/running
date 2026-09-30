# 分支审计与清理 · 2026-09-24

> **背景**：N-3 历史重写（`deliverables/N3_DESIGN_OUT_OF_TREE_2026-09-24.md`）把**所有 ref**都改写了，
> 于是 4 个 `backup/pre-rewrite-*` 分支**自己也被重写** —— 名字里的"pre-rewrite"已经失真：
> 它们既不再含设计图，也不再是"重写前的快照"。
> **用户指令**：「检查下，没有重要东西就清理」。
> **结论**：✅ **6 个分支全部无独有内容，已删除。**

---

## 一、为什么不能直接看「独有提交数」

```
$ git rev-list --count main..<branch>
backup/pre-rewrite               独有=7   落后 main=156
backup/pre-rewrite-2026-09-17    独有=4   落后 main=125
backup/pre-rewrite-2026-09-19    独有=5   落后 main=92
backup/pre-rewrite-2026-09-21    独有=8   落后 main=76
land/2026-09-21                  独有=0   落后 main=67
land/batch4-timezone             独有=0   落后 main=63
```

🔴 **这 7 / 4 / 5 / 8 一个都不能直接当"有独有工作"**：历史重写后**所有 SHA 都变了**，
一个内容与 main 完全等价的提交，仅因 SHA 不同就会被 `main..branch` 算作"独有"。

## 二、三道递进的判据（缺一不可，逐级收窄）

### 判据 1 · patch-id（`git cherry`）—— 只能当**粗筛**

```
+ 917f486 feat(contracts): describe a run's executed segments
- 6f7975f perf(storage): read lap and segment events…
```

`+` 表示"补丁内容未在 main 中找到"。⚠️ **但它会误判**：项目记忆明确记载
「影子对照已彻底删除、改用 B1–B5」，而那个提交（`7338176`）仍被标成 `+` ——
说明**补丁因上下文/顺序不同而 patch-id 不同，内容其实早已落地**。

### 判据 2 · 行级内容比对（本轮自建脚本）—— 主力判据

取该提交补丁的**有效新增行**（`trim()` 后长度 ≥ 12、且非纯符号/短注释），
检查 `main:<path>` 是否包含这些行：

| 分支 | 提交 | 有效新增行在 main 中的命中率 |
|---|---|---|
| `backup/pre-rewrite` | `917f486 feat(contracts): describe a run's executed segments` | **100.0%**（49/49） |
| | `0260f0a feat(api): match a run to the plan it executed…` | **91.0%**（1047/1150） |
| | `fd58a18 docs: record the segment work…` | **93.9%**（322/343） |
| `…-2026-09-17` | `8ce3b06 fix(api): fail closed when weekly plan generation is already running` | **98.5%**（382/388） |
| `…-2026-09-19` | `c5cf065 refactor(api): split import execution, queueing and publication` | **97.8%**（3761/3844） |
| | `0065631 feat(parser): add the optional Rust data worker` | **97.8%**（1740/1779） |
| `…-2026-09-21` | `7338176 refactor(rust-engine): 删除影子对照，改用运行时写路径不变量 B1-B5` | **99.9%**（852/853） |
| | `1be20f5 perf(import): 导入阶段计时 timedStage 与性能口径` | **97.7%**（172/176） |

**未命中的那 9% / 6% 是什么？** 逐行看过，全部是**重构前的旧写法**。以 `0260f0a` 为例：

- 漏的是 `server.ts` 里内联的 `const candidates: PlanCandidateDay[] = …` / `matchedBy: "push_record"` 等；
- 而 main 里这些逻辑**已整体移进 `apps/api/src/workout-segments.ts`**：
  ```ts
  // main:apps/api/src/workout-segments.ts
  export interface PlanCandidateDay { … }        // :62
  export const assemblePlanCandidates = (        // :367
  // main:apps/api/src/server.ts
  import { assemblePlanCandidates, type PlanCandidateDay } from "./workout-segments.js";  // :96
  ```
- 符号存在性核对：`PlanCandidateDay`(4 文件) / `matchPlanDay`(3) / `missingSegmentsNote`(1) /
  `speedTrack`(2) / `segmentation`(2) —— **全部命中**。

### 判据 3 · 新增文件路径 + 分支独有文件集 —— 收尾

**（a）每个 `+` 提交的"新增文件"在 main 中是否存在 ⇒ 全部存在**，包括：

- `backup/pre-rewrite`：`apps/api/src/workout-segments.ts`、两个测试、两份 deliverables 文档
- `…-09-17`：`apps/api/src/try-acquire-gate.ts` + 其测试
- `…-09-19`：**整个后端重构文件集**（`command-queue.ts` / `import-worker.ts` /
  `import-publication.ts` / `import-equivalence.ts` / `task-admission.ts` / `worker-process.ts` …共 28 个）
  与 `Cargo.toml` / `Cargo.lock`
- `…-09-21`：`apps/api/test/recompute-worker.test.ts`

**（b）`<branch>` 有、main 没有的文件** —— 只有两份分支出现，且**全部是 main 主动删除的**：

| 文件 | main 删除它的提交 |
|---|---|
| `apps/ios/RAI/PixelTheme.swift`（+ `PixelCharts` / `PixelIcons` / `PixelTabBar` / `NativeHeartRateChart` / `Skins/AppSkin.swift` 共 6 个） | `1172dfb refactor(ios): drop the pixel skin and keep one native look` |
| `scripts/split-application-service.mjs` | `6cc30a8 chore: 移除 split-application-service.mjs 迁移脚手架` |

⇒ 它们留在分支上，只是因为**分支 tip 早于这两次删除**，不是"独有工作"。

**（c）`land/*` 两个分支独有提交为 0** ⇒ 提交是 main 的祖先，纯落后。

---

## 三、执行与结果

### 删除前留档（可回溯）

```
refs/heads/backup/pre-rewrite               fd58a18b5207ea566ccf1cd122cd70d54c23578f
refs/heads/backup/pre-rewrite-2026-09-17    14ec7ec5f0a0ae5910402707000f535ffca9eeca
refs/heads/backup/pre-rewrite-2026-09-19    0a44eaa3fa362ae6c9f9f0acd80ca64fbb00cb3a
refs/heads/backup/pre-rewrite-2026-09-21    5f9f11554435e0a8f495c902de25eb7fe8c42702
refs/heads/land/2026-09-21                  24809e7804a27361d383f99a6d657f28ea9e9abb
refs/heads/land/batch4-timezone             606234ededceb388d73005a9c4d41342339a9dfb
```

### 执行

```bash
git branch -D backup/pre-rewrite backup/pre-rewrite-2026-09-17 \
              backup/pre-rewrite-2026-09-19 backup/pre-rewrite-2026-09-21 \
              land/2026-09-21 land/batch4-timezone
git reflog expire --expire=now --all && git gc --prune=now
```

> ⚠️ 这 6 个分支**从未推送到远端**（`git ls-remote --heads origin` 只有 `refs/heads/main`）
> ⇒ 删除只影响本地。

### 结果

| 指标 | 删除前 | 删除后 |
|---|---|---|
| 库内总对象 | 3651 | **3600** |
| 可达对象 | 3651 | **3600** |
| **差额（必须 0）** | 0 | **0** ✔ |
| `.git` | 32 MB | **32 MB** |
| `git fsck --full` | 干净 | **零输出** |
| 提交数（main） | 216 | **216** |
| 分支 | 7 | **1（main）** |

> 📌 `.git` 体积几乎没动（32 MB → 32 MB）：这 51 个对象都是小 delta，体积大头是 main
> 历史里 30 MB 的验收截图 —— 它们**本来就该在**，与本次清理无关。

---

## 四、回滚

🟡 **`git branch` 删掉后 `git revert` 无效**（没有"上一步"）。恢复方式：

| 要恢复什么 | 从哪里 |
|---|---|
| 6 个分支（**重写后**形态） | ❌ 仓库内**无副本**（已被 `gc --prune=now` 剪除），只能凭下方 6 个 SHA 去别处找 |
| 6 个分支（**重写前**形态，含设计图） | `/Users/ta/Documents/rai-git-mirror-2026-09-24/`（77 MB 全量镜像，refs 齐全） |
| 设计图原图 | `~/Documents/rai-design-archive-technology-v1/` |
| 单提交内容（若只想取回某次改动） | `git show <sha>` 已不可用 ⇒ 改从镜像里 `git log --all --oneline --grep=<标题>` 定位 |

> 🔴 **如实说明**：重写后形态的分支 tip（上表 6 个 SHA）**已经取不回来了**。
> 但这是**可接受的**，因为本报告的判据 2+3 已证明这些 tip 的**全部内容都在 main 里**；
> 若真要审计历史形态，镜像里的重写前版本内容等价（仅多出已被 main 删除的文件与设计图）。

---

## 五、遗留

- 🟡 **远端只有 `main` 一个 ref**，与本地一致。若日后需要"重写前快照"作长期备份，
  应把镜像搬到**仓库外的持久位置**（现在在 `~/Documents/`，已在仓库外 ✔），
  **不要**以分支形式放回仓库 —— 那会让对象重新可达，抵消 N-3 的体积收益。
