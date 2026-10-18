# RAI 全项目深度审查 · Lane 5：门禁 / CI / 部署 / 文档 / 测试质量

- 审查对象：`/Users/tp/running` @ `24aa7d8`（工作树干净，审查结束后复核仍为 `git status --short` 空）
- 审查方式：**只读**。仓内跟踪文件零修改、零 `git add/commit`；所有突变实验在 `/tmp/l5/**` 的独立 git 夹具上做。
- 唯一写入：本文件。
- 时间：2026-10-18（会话时区 Asia/Shanghai）

## 0 结论摘要

**分级计数：P0 × 0｜P1 × 0｜P2 × 4｜P3 × 11（合计 15）**

总体判断：**门禁家族在 HEAD 上是"真绿"而不是"假绿"**——五个文档/结构闸门、blob 体积闸门、`smoke:api`、`rust:verify` 全部实跑 EXIT=0 且输出了有意义的计数；用 /tmp 夹具对 5 个门禁做的"改坏→变红→还原→变绿"实验全部按预期反应（唯一例外是 `check:doc-refs` 的**第二道判据**，见 F1）。但门禁体系有四个**语义缺口**：文档行号引用的"内容漂移"维度因仓库内零基线而从未生效（F1）；包边界门禁只认双引号 import 与 `.ts/.tsx`（F3）；`npm test` 默认并发被脚本自己记录为会产生"全量红、单跑绿"（F4）；4 份**现行**文档仍把已删除的 Web 门禁写成"基本检查"（F2）。CI 侧的现实是：GitHub Actions 不被 gitee 触发（README/CI 已明示），`.workflow/master-ci.yml` 是**未启用的草案**，因此"门禁只在提交钩子里跑"这件事没有任何远程兜底。

### 0.1 门禁基线（本机实跑，原样摘要）

| 命令 | 结果 | 耗时 | 证据等级 |
|---|---|---|---|
| `npm run check:docs` | `Documentation: 83 files, 597 local links, 0 problems`，EXIT=0 | 0.52s | 已实测 |
| `npm run check:doc-refs` | `合计 138 处（去重后）；越界/无法解析 0 处；内容漂移 0 处；锚在空行 7 处（告警）`，EXIT=0 | 0.80s | 已实测 |
| `npm run check:scripts` | `✅ 18 个 package.json / 104 条 script`，EXIT=0 | 0.55s | 已实测 |
| `npm run check:acceptance-matrix` | `§16.1 矩阵：80 条；cited 80；declared-gap 0；missing 0`，EXIT=0 | 1.30s | 已实测 |
| `npm run check:package-boundaries` | `包边界：16 个包 / 31 条 src 边；禁线 4 条`，EXIT=0 | 0.57s | 已实测 |
| `node scripts/check-blob-size.mjs` | `1048 个已跟踪文件全部 ≤ 1500000 bytes`，EXIT=0 | <0.5s | 已实测 |
| `npm run smoke:api` | `Production API runtime smoke test passed`，EXIT=0 | 1.97s | 已实测 |
| `node scripts/rust-worker.mjs verify` | 11 项内置回归全过（`pass 11 / fail 0 / skipped 0`），EXIT=0 | ~40s | 已实测 |
| `npm run ml:check` | `Python 训练环境就绪: research/.venv/bin/python`，EXIT=0 | <1s | 已实测 |
| `npm audit --omit=dev` | **EXIT=1**，`4 moderate severity vulnerabilities`（sprintf-js ← roarr ← global-agent ← onnxruntime-node） | ~2s | 已实测 |
| `git ls-files --eol -- '*.sh' '*.py' '*.swift' '*.pbxproj' ':.githooks/*'` | 173 个文件全部 `i/lf w/lf attr/text`；`git grep -I -c -P '\r$' HEAD` 无输出 | — | 已实测 |
| `git ls-files` 卫生 | 1048 个文件；**无 `.DS_Store`、无 `apps/ios/Pods`、无 `.sqlite`/`var/`** | — | 已实测 |

全量 `npm test` **未由本 lane 重复运行**（Lead 正在后台跑，且它本身是本 lane 的审查对象，见 F4）。

## 1 范围与方法

### 1.1 实跑的命令（除上表外）

- `node -e` 导入 `scripts/run-tests.mjs` 的纯函数：`nodeTestFiles()` = **257 个**；`RAI_TEST_CONCURRENCY` 校验矩阵（见 §3 F4）；`nodeSuiteArgs()` 的 argv 生成。
- `node -e` 导入 `scripts/check-npm-scripts-portable.mjs` 的 `inspectScript()`：`node a.mjs; node b.mjs` → RED(`;`)、`RAI_X=1 node a.mjs` → RED、`test -f x` → RED、`bash foo.sh` → RED、`node a.mjs && node b.mjs` → green、`node a.mjs | node b.mjs` → green（`|`/`>`/`||` 在 cmd 下同样工作，非缺口）。
- 对默认范围**之外**的现行文档显式跑 `node scripts/check-doc-line-refs.mjs docs/DECISIONS.md deploy/README-UBUNTU.md docs/HEALTHKIT_RECORD_SYNC_V2.md docs/IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN.md`：`合计 5 处；越界 0；内容漂移 0`，EXIT=0。
- 全仓 markdown 行号引用面扫描（复用脚本的 `REF` 正则）：39 份 md 含引用；默认范围 11 份内脚本报告 **138 处**（展开行号列表并按键去重后的计数；我的原始正则匹配计数为 169，两者口径不同，以脚本输出为准）；范围外 36 份 / 2043 处（绝大多数是 deliverables 时点快照，符合脚本"时点快照不进默认范围"的判读规则）。
- 单引号 `@rai` import 清点：`packages/application/src` **8 处**（contracts×2、physiology×2、storage-sqlite×2、scoring×1、model-eval×1）。
- 生产语义探针（/tmp 脚本，`RAI_RUNTIME_ROOT` 指向 /tmp、伪造生产 env；不碰真实库）：`RAI_ALLOW_REMOTE_TOKEN_AUTH=1` + `Host: api.example.com` 时 `GET /` → **404**、`GET /assets/app.js` → **404**、`GET /robots.txt` → 404（nginx 在真实拓扑里自己回 robots 文本）、无 Token `/v1/health` → **401**、错 Host 无 Token → **401**、带 Token `/v1/backups` → 200 `[]`——与 `deploy/README-UBUNTU.md:92-96` 的验收期望一致。

### 1.2 突变实验（全部在 /tmp 夹具，仓内零改动）

| 门禁 | 实验 | 结果 |
|---|---|---|
| `check-doc-links.mjs` | 健康夹具→删目标文件→孤儿文档→坏锚点→行内代码伪链接→空仓库（无 README） | 健康=0；删目标=**红**（`missing target`）；孤儿=**红**；坏锚点=**绿（缺口，F6）**；行内代码 `[x] (missing.md)`=**红（假阳性，F6）**；无 README=**抛错（拒绝空绿）** |
| `check-doc-line-refs.mjs` | 健康引用→行号 999→写基线后改源文件行→无基线时改源文件行 | 健康=0；越界=**EXIT=1**；有基线漂移=**EXIT=2**；**无基线漂移=EXIT=0 且打印"内容漂移 0 处"（F1）** |
| `check-acceptance-matrix.mts` | 新增矩阵行无引用→补一个**空断言**同名测试→只在注释里提 ID→表格格式打坏 | 无引用=**红**；空断言测试=**绿（F5）**；注释=红（旧假阳性已修）；零 ID=**红**（解析守卫） |
| `check-package-boundaries.mjs` | 同一违反边分别用单引号/双引号/`.mts` 文件写进 `packages/scoring/src` | 双引号=**多 2 条红**（具名禁线 + 未声明边）；**单引号=0 条红**；**`.mts`=0 条红（F3）** |
| `check-acceptance-matrix.mts` 空输入 | 缺 §16.1/§16.2 → 已内建 `process.exit(1)` | 见代码 L60-69 |
| `check-blob-size.mjs` | 暂存 1500001 字节→恰好 1500000→1.6MB 但不暂存 | 超限=**红**；恰好等于上限=绿（`>` 语义）；未暂存=绿（读 index，符合设计） |

### 1.3 未跑 / 不归本 lane

- **全量 `npm test`**：Lead 在后台跑；本 lane 未重复跑（避免与 Lead 争 CPU 导致时间预算型用例假红，也避免重复消耗）。
- `npm run test:ios` / `node scripts/run-ios.mjs gates`：归 Lane 4。
- `npm run ml:test`、`rust:build`：未跑（只跑了 `ml:check` 与 `rust:verify`；Python 测试套与 Rust 构建不在本 lane 的必要基线内）。
- `nginx -t` / `systemctl daemon-reload` / 真机 Windows 入口：无此环境，未跑（见 §4）。
- `.archify/` 审计目录只做范围清点，未逐份复核（它是 2026-10-13 时点快照，README 已声明不回写）。

## 2 发现清单

| ID | 严重度 | 标题 | 位置 | 证据等级 |
|---|---|---|---|---|
| F1 | P2 | `check:doc-refs` 的第二道判据（内容漂移）**实际不生效**：仓库零份 `.linerefs.json` 基线，输出仍打印"内容漂移 0 处" | `scripts/check-doc-line-refs.mjs:30-32, 204-210, 238-242, 283-289` | 已实测（突变） |
| F2 | P2 | 4 份**现行**文档仍把已删除的 Web 门禁（`npm run build` / `test:e2e:web`）写成"基本检查/发布清单" | `docs/IOS_SYNC_PERFORMANCE_REVIEW.md:622`；`docs/IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN.md:515-516`；`docs/IOS_SYNC_RECHECK_FIX_PLAN_2026-10-17.md:376`；`docs/SQLITE_DIRECT_SYNC_DESIGN.md:587-588` | 已实测（grep + `package.json` 无此脚本） |
| F3 | P2 | `check:package-boundaries` 只识别**双引号** `from "@rai/…"`、只扫 `.ts/.tsx`：单引号 import、动态 `import()`、`.mts/.cts` 源文件全部绕过（层规则/具名禁线/声明↔实际/边白名单同时失效） | `scripts/check-package-boundaries.mjs:97, 121, 138` | 已实测（夹具突变 + 仓内 8 处单引号） |
| F4 | P2 | 全量 `npm test` 默认并发被脚本自身记录为"全量红、单跑绿"，而 README 的验证清单只写 `npm test`、未给 `RAI_TEST_CONCURRENCY` 旋钮 | `scripts/run-tests.mjs:41-61`；`README.md:38-40` | 代码+作者实测记录；本 lane 未复跑全量 |
| F5 | P3 | `check:acceptance-matrix` 只按**测试标题字符串**判定 cited：一条空断言 `test("C03 …", () => {})` 即可让新验收项变绿 | `scripts/check-acceptance-matrix.mts:91-97, 102-109` | 已实测（突变） |
| F6 | P3 | `check:doc-links` 不校验 `#anchor`；且把行内代码里的 `[x] (missing.md)` 当真实链接（假阳性） | `scripts/check-doc-links.mjs:25, 27, 29` | 已实测（突变） |
| F7 | P3 | 测试发现规则只收 `packages/*/test`、`apps/api/test` **顶层**的 `*.test.ts`：`.test.mts/.js/.tsx` 与子目录会被静默漏跑（当前 257/257 全覆盖，无实际丢失，但无门禁保证完整） | `scripts/run-tests.mjs:10-18`；`scripts/check-acceptance-matrix.mts:50` | 已实测（257/257 + 夹具） |
| F8 | P3 | `deliverables/README.md` 的「当轮审查（未提交改动）」节含 **33 份已提交**文档（工作树干净），且多份自述"收尾后并入或删除"却跨 8 天未收尾，违反自定约定 | `deliverables/README.md:4-7`；`deliverables/` 33 份 md | 已实测 |
| F9 | P3 | `deploy/n100/nginx-rai.conf` 仍 catch-all 反代 `location /`，与主模板/D17"只有 `/v1` 反代、根路径 404"不一致（退役计划已记为"可选收紧"） | `deploy/n100/nginx-rai.conf:53-55`；`deliverables/plan-remove-web-keep-ios-api.md:567-570` | 代码阅读 + 文档交叉 |
| F10 | P3 | `check-node-version.mjs` 的放行依据注释仍引用已退役的 Web 证据（`Web vitest 25 文件 184 条`、`npm run build 成功`），D17 后不可复验 | `scripts/check-node-version.mjs:10-12` | 代码阅读 |
| F11 | P3 | CI 现实：GH Actions 不被 gitee 触发（已明示）；gitee 侧 `master-ci.yml` 是**未启用草案**；matrix 只覆盖 Node 22.x（开发机 24.x）；Windows job 跑默认并发全量 `npm test` | `.github/workflows/ci.yml:7-13, 127`；`.workflow/master-ci.yml:1-9` | 代码阅读 |
| F12 | P3 | `npm audit --omit=dev` 报 **4 moderate**（`sprintf-js` ← `roarr` ← `global-agent` ← `onnxruntime-node`），修复需越过声明依赖区间（`npm audit fix --force`） | `package-lock.json`（链：onnxruntime-node） | 已实测 |
| F13 | P3 | README「检查」段与 pre-commit 实际清单不一致：漏列**blob 体积闸门**（每次提交都跑）与 storage-sqlite/表分类门禁的实现归属 | `README.md:52` vs `.githooks/pre-commit:12, 83-108` | 代码阅读 |
| F14 | P3 | 历史数字可能被误读为当前值：`PROJECT_REVIEW` 仍写"matrix 54 / 包边界 **15 packages / 30 src edges**"，当前实为 **80 / 16 / 31**；README 又把该文档标为"当前审查结果" | `docs/PROJECT_REVIEW.md:89-102`；`README.md:71` | 已实测（对比门禁输出） |
| F15 | P3 | `check:doc-refs` 默认范围仍不含 `deploy/README-UBUNTU.md`（脚本自述"待补"），也漏 `docs/DECISIONS.md`、`docs/HEALTHKIT_RECORD_SYNC_V2.md`、`docs/IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN.md` 等现行文档 | `scripts/check-doc-line-refs.mjs:75, 79-106` | 已实测（显式补跑 5 处全过） |

## 3 每项详情

### F1（P2）`check:doc-refs` 的内容漂移判据是"空转"

**证据（代码）**

- 头部把判据写成两道硬失败：越界/无法解析 → exit 1；内容与基线不符 → exit 2（`scripts/check-doc-line-refs.mjs:29-32`）。
- 基线只在 `<doc>.linerefs.json` 存在时加载，读不到就是 `baseline = null`（`:201-210`）；漂移比较只在 `baseline?.[key]` 存在时发生（`:238-242`）。
- 汇总行**无条件**打印 `内容漂移 ${drifted} 处`（`:283-287`），所以 `npm run check:doc-refs` 的当前输出 `内容漂移 0 处` 读起来像"已核对且无漂移"，实际是"没有基线，无从比对"。
- **仓库事实**：`git ls-files '*.linerefs.json'` 输出为空；`ls docs/*.linerefs.json` 无文件；`git check-ignore` 也不忽略该后缀 ⇒ 不是"被忽略"，是从来没生成/提交过。

**证据（突变）**：/tmp 夹具中写基线后改源文件行内容 → `🟡 内容已漂移 … 基线: line3 / 现在: CHANGED`，**EXIT=2**；删除同一份基线再改 → **EXIT=0** 且汇总仍打印"内容漂移 0 处"。判据本身有牙，但仓库从未给它装上牙。

**影响**：脚本头部记录的 2026-09-24 事故（`HealthKitSync.swift:506-519` 指向的 `beginBackgroundTask` 已漂到 `:717-726`）这类"行号不越界但内容已换人"的静默漂移，当前**没有任何门禁能发现**；`check:doc-refs` 全绿会被读成"行号引用已核验"。这与仓库纪律里"脚本跑绿 ≠ 门禁存在"是同一类问题，只是发生在脚本内部的一道判据上。

**建议**：对默认范围 11 份文档执行一次 `node scripts/check-doc-line-refs.mjs --write-baseline` 并提交生成物（脚本设计就是"基线落在文档旁边"）；若刻意不提交基线，则汇总行必须区分"未核对（无基线）"与"已核对 0 漂移"，否则默认输出就是误导。

### F2（P2）4 份现行文档仍要求跑已删除的 Web 门禁

**证据（原文摘录）**

- `docs/IOS_SYNC_PERFORMANCE_REVIEW.md:622`：`若触及 Web 展示或共享契约，补 `npm run build`，确有桌面交互变化再运行 `npm run test:e2e:web`。` —— 位于 §7.1「基本检查」，同段还列了 5 条现行命令。
- `docs/IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN.md:515-516`：`涉及共享契约或 Web 消费时再补 `npm run build`；确有桌面浏览器交互变化才运行 `npm run test:e2e:web`…` —— 位于 §6.2「基本检查」。
- `docs/IOS_SYNC_RECHECK_FIX_PLAN_2026-10-17.md:376`：同句（第二轮复查修复方案，README 表格里作为现行入口链接）。
- `docs/SQLITE_DIRECT_SYNC_DESIGN.md:587-588`：§14.5「发布检查清单」两个 checkbox：`npm run build` 通过 / `npm run test:e2e:web` 通过。

**证据（事实）**：`package.json` 的 104 条 script 里**不存在** `build`、`test:e2e:web`、`test:e2e:*`（`npm run check:scripts` 的 18 个 package.json 全量清单中没有它们）；`AGENTS.md:64-67` 与 `docs/DECISIONS.md:150` 明令禁止把它们加回来。

**对比**：同批 D17 之后的文档（`docs/IOS_TRAINING_PLAN_IMPLEMENTATION.md:63,84,91`、`docs/IOS_TRAINING_PLAN_STATE_V1.md:90,99,107`、`docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md:326`、`docs/COACH_LOOP_IMPLEMENTATION_STATUS.md:5-6`）都已就地加 🔴"历史项/已删除"标注——说明修复口径已有先例，只是上述 4 处漏了。**这不属于"时点快照"**：三份 fix-plan/review 由 README 文档表作为现行入口链接（`README.md:76-78`），读者会照做。

**影响**：按"基本检查/发布检查清单"逐条执行的人会撞上"Missing script"，进而可能怀疑门禁缺失或自行把脚本加回（D17 明令禁止）；同时 `check:docs`/`check:doc-refs` 都不会因此变红（它们只查链接与行号）。属于"文档口径与实现不一致"的用户可见错误。

**建议**：对 4 处做与训练计划文档相同的就地标注（一行 🔴），或删除这两句；若要防复发，可在 `check:doc-links`/新增小检查里对"现行文档中的退役脚本名"做白名单式扫描（历史章节需显式豁免）。

### F3（P2）包边界门禁的四类判据都可被"引号/扩展名"绕过

**证据（代码）**：`scripts/check-package-boundaries.mjs`

- 收集 import：`text.matchAll(/from\s+"@rai\/([a-z-]+)/g)`（`:121`）——**只认双引号**、只认 `from`；动态 `import("@rai/x")` 不匹配。
- 收集源文件：`else if (/\.tsx?$/.test(entry))`（`:97`）——`.mts` / `.cts` 被跳过。
- 分层规则同样是双引号专属：`/from\s+"[^"]*\/apps\//.test(text)`（`:138`）。

**证据（仓内现状）**：`packages/application/src/prediction-policy.ts:2-3`、`model-v2-maintenance.ts:5-8` 等 **8 处**使用单引号 `from '@rai/…'` ⇒ 单引号不是假想风格，而是仓库里已经在用的写法；一旦有人按同一风格新增依赖，这个门禁**看不见**。本 lane 用宽正则（双/单引号 + 动态 import）重扫全仓：当前**没有**出现"仅靠单引号存在、且不在 ALLOWED_EDGES/未被声明"的边 ⇒ **当前无实际违反**，这是可被绕过的门禁语义，而不是已经破掉的边界。

**证据（夹具突变）**：在 `/tmp/l5/mut-bounds` 里对 `packages/scoring/src` 写同一违反边：
- 双引号：输出**多出 2 条红**——`packages/scoring 依赖 readiness：§6.9 …` + `未声明的包边界：scoring -> readiness`；
- 单引号：**0 条新增红**；
- `.mts` 文件（双引号）：**0 条新增红**。

**影响**：这条门禁是 §7.7-5/§13.4"scoring 不得 import readiness"的**唯一**执行者（脚本头注释自己说明"不只依靠源码字符串 grep"的原始要求）。用单引号写一行 import 即可让 P0 级架构不变量失守且全绿：typecheck 过、测试过、pre-commit 过。

**建议**：正则改为 `/from\s*['"]@rai\/([a-z-]+)/g`（同时匹配 `import("@rai/x")` 与 `require`）；扩展名改为 `/\.[cm]?tsx?$/`；对 `export … from` 与 `import type` 无需特判（都含 `from`）。改动很小，收益是把"格式选择"从绕过手段里去掉。

### F4（P2）全量测试默认并发：作者实测会假红，但 README 把 `npm test` 当唯一入口

**证据（代码）**：`scripts/run-tests.mjs:41-61` 原文记录了 2026-10-12 的控制变量实验：**同一份代码、同一批文件**，默认并发 → `EXIT=1`（2 条超时失败）；`--test-concurrency=1` → `EXIT=0`（132 条 0 失败）。原因写在 `:44-50`：`worker.test.ts` 的 `waitFor` 预算 **5000 ms**、`data-only-import-queue.test.ts` 的 `wait` 预算 **30 000 ms**，而 `server-runtime` 单跑 443 s、`worker` 349 s；`node --test` 默认并发 = `os.availableParallelism()`（作者本机 6）。脚本**刻意**不给默认值（`:76-83` 说明为何不设默认，避免纯函数读取环境）。

**证据（README）**：`README.md:38-40` 的"检查"块只有 `npm run typecheck / npm test / check:*`；`RAI_TEST_CONCURRENCY` 在 README/AGENTS 中**一次都没出现**（全仓仅在 `scripts/run-tests.mjs` 注释、`docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md:502`、`docs/IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN.md:64` 与 deliverables 历史记录里）。

**本 lane 已实测的部分**（未跑全量）：`RAI_TEST_CONCURRENCY` 校验是**严格的**——`"2"→2`、`"1"→1`；`"0"`、`" 2"`、`"0x2"`、`"2.5"`、`"-1"`、`"1e3"` 全部抛错（`:62-74` 的正则把关）；不设该变量则 argv 不含 `--test-concurrency`（首字节行为不变）。

**影响**：README 让读者执行的"验证"命令在 6 核机器上有明确记录的假红路径；而 `AGENTS.md` 的 Default Verification 也只写 `npm test`。假红的代价不是噪音而是**训练人不信任红**——这与 F1 的"假绿"是同一枚硬币。属于已承认的取舍（脚本注释说"属项目决策"），但取值的**可操作提示**没有出现在任何用户入口文档里。

**建议**：README/AGENTS 的 `npm test` 行加一句"高负载/多核机器建议 `RAI_TEST_CONCURRENCY=2 npm test`（见 scripts/run-tests.mjs 头注释）"；或把默认并发有界化（这是项目决策，脚本注释已说明不该顺手改）。另外 `README.md:53` 的"发布前必须逐条执行"应同时说明：报告全量结果时必须写明所用并发。

### F5（P3）验收矩阵只认标题字符串：空断言即可"覆盖"

**证据（代码）**：`scripts/check-acceptance-matrix.mts:91-97` 从 `test(...)`/`it(...)` 的**标题**取 `\b[A-Z]\d{2}\b`；`:102-109` 只要 cited 集合命中即算通过。`:76-90` 已诚实记录旧版"全文 grep"被时间戳 `T02:00:00Z` 骗过的历史，并明确"Do not relax it back"。

**证据（突变）**：夹具里新增矩阵行 `C03` → `missing 1` **红**（证明门禁有牙）；补一行 `test("C03 untested", () => {})` → **绿**（cited 3 / missing 0）。只写注释 `// C03 …` → 仍**红**（旧假阳性确已修）。

**影响**：新增 §16.1 验收项时，一条不带任何断言、甚至不 import 被测模块的空测试就能让 `check:acceptance-matrix` 全绿，而 `cited` 的语义只是"标题里出现了 ID"。脚本注释对这一点是清楚的（cited 只是"机械可查"），但 `README.md:67` 与 `docs/ALGORITHM.md` 的"80 条…以输出为准"容易被读成"已覆盖"。当前 80/80 是真是假取决于测试内容，本 lane 未逐条读 80 条断言（见 §4）。

**建议**：不改判据（会退回旧假阳性），但在输出里加一句"cited 仅表示标题引用，不代表断言存在"，或在验收矩阵文档里要求每条 cited 测试名后附断言摘要；长期可让 `check:acceptance-matrix` 额外输出"该测试体是否含 assert"作为软告警（不是硬失败）。

### F6（P3）文档链接门禁：不校验锚点，且把行内代码当链接

**证据（代码+突变）**：`check-doc-links.mjs:25` 的正则匹配"方括号 + 圆括号"形式的行内链接（可带 `!` 前缀与引号 title），`:27` 把 `#…` 开头的链接整体跳过，`:29` 用 `split(/[?#]/, 1)[0]` 丢掉 fragment ⇒ **`docs/X.md#section` 的锚点从不校验**。夹具中一个指向不存在的 `#section` 的合法文件链接 → `0 problems` EXIT=0。同一夹具里行内代码中的伪链接 → `missing target: missing.md` **红**（`:21-23` 只剥围栏代码块，不剥行内代码）——这是**假阳性**方向，会逼作者为了绿而改写示例文本。（本报告为了不触发同一个假阳性，示例里的方括号与圆括号之间刻意留了空格；这本身就是 F6 的一个旁证。）

**影响**：597 条本地链接里，跨文档/同文档的 `#anchor` 全部未验证；docs 大量用标题锚点（`docs/OPERATIONS.md`、`docs/DECISIONS.md` 等），标题改名不会变红。同时"在正文里举例写一个 markdown 链接"会被判红，与 `check-doc-line-refs` 头注释记录的"举例要拆开写"是同类摩擦。

**建议**：先剥行内代码 `` `…` `` 再扫描；对 `target#fragment` 解析目标 md 的标题生成 slug 集合做存在性校验（GitHub 风格 slug 即可），至少对 `.md` 目标生效。

### F7（P3）测试发现规则的静默漏跑面

**证据**：`run-tests.mjs:10-18` — 只遍历 `packages/*/test` 与 `apps/api/test` 的**一层**目录，只收 `entry.name.endsWith(".test.ts")`。实测 `nodeTestFiles()` = 257，且 `git ls-files` 中匹配 `*.test.*|*.spec.*` 的 257 个文件**全部被覆盖**（当前零丢失）。夹具验证：`packages/x/test/foo.test.mts` 不被发现（返回 `[]`）；`check-acceptance-matrix.mts:50` 的 `collectTestFiles` 用 `/\.test\.tsx?$/`，口径一致地漏 `.mts`。反例保护存在：`:95` 在 `files.length===0` 时 `throw`（"refuse an empty green test run"），实测空仓库 EXIT=1。

**影响**：新增测试若命名为 `.test.mts`（仓库里 `.mts` 脚本很常见，见 `scripts/*.mts`）或放进子目录，会**永远不被执行**，且没有任何门禁会报"这个测试文件没被跑"；`npm test` 依旧是绿的。这属于"门禁覆盖面积靠约定维持"。

**建议**：把发现规则放宽为 `/\.[cm]?[jt]sx?$/` + `*test*` 或递归 `test/` 子目录；再加一条反向断言（tracked 测试文件集合 ⊆ 被发现集合），杜绝"新增文件不跑"。

### F8（P3）deliverables 的"当轮"堆积与自定约定冲突

**证据**：`deliverables/README.md:4-5` 自定约定"当轮尚未收尾的审查报告可以临时列在下方「当轮审查」一节，并在下一轮并入 `PROJECT_REVIEW` 或删除"；但 `:7` 的节标题是「当轮审查（**未提交改动**）」，而 33 份 md **全部已提交**（`git status --short` 空），标题与事实不符。目录内 33 份里包含 10-11 ~ 10-18 共 8 天的报告：`UNCOMMITTED_REVIEW_2026-10-11/12`、`API_HANG_TRIAGE_2026-10-11`、`IMPORT_PUBLICATION_REDESIGN_2026-10-11`、`DIRECT_SYNC_PR1/PR2_PR3/…`（10-12~10-13，≥12 份）、`WEB_DESKTOP_REMOVAL_PLAN_2026-10-15`（自述"已并入 v2 实施文档"）、`LATEST_WORKOUT_MISSING_DATA_2026-10-15`、`IOS_SYNC_INGEST_REVIEW_OPTIMIZATION_2026-10-15`、`SYNC_OPTIMIZATION_EXECUTION_PLAN_2026-10-16`、`TRAINING_PLAN_REVIEW_2026-10-18` 等。至少 `WEB_DESKTOP_REMOVAL_PLAN_2026-10-15.md` 按它自己的说明已可删；`UNCOMMITTED_REVIEW_2026-10-11/12` 的"未提交"前提早已不成立。`README.md:85` 又把该目录标为"固定时点、固定数据库的机器证据"入口。

**影响**：不是产品缺陷，但直接稀释"deliverables 不是第二套规范"的纪律：读者无法从 33 份里判断哪些是现行结论，而 README 的"当前审查结果"入口指向 `PROJECT_REVIEW`，两者存在两套口径。也与本任务清单里"当轮未提交文档大量堆积"的观察一致。

**建议**：把节标题改成「当轮审查（已提交，未收尾）」；按各自文末说明把"已并入/已修复完毕"的报告删除或移入 `project-review-2026-09-30/` 式的证据目录；`SYNC_OPTIMIZATION_EXECUTION_PLAN` 这类仍进行中的保留并在标题后标状态。

### F9（P3）n100 部署模板与 D17 后的主模板口径不一致

**证据**：`deploy/n100/nginx-rai.conf:53-55` 是 `location / { proxy_pass http://127.0.0.1:18787; }`（catch-all 反代），而 `deploy/nginx-rai.conf:91` 是 `location / { return 404; }`、`:59` 只反代 `location /v1/`、`:53` 由 nginx 直接回 `robots.txt`。`deliverables/plan-remove-web-keep-ios-api.md:567-570` 明确记录：n100 "已是纯透传…功能上无需改；**可选收紧**：把 `location /` 改成 `return 404`（不影响测试）"。

**影响**：可观察结果基本等价（API 无静态托管，根路径实测 404 — 见 §1.1 的生产语义探针），但两点真实差异：① `/robots.txt` 在 n100 拓扑下是 API 的 404 JSON，而不是主模板的 `Disallow: /` 文本；② 任何未来在 API 侧新增非 `/v1` 路由都会被 n100 catch-all 意外暴露到公网（主模板不会）。属"已记录的有意取舍"，但两套模板并存且不在任何门禁里（`deploy-n100.test.ts` 只钉 Authorization 透传与 `proxy_request_buffering off`，不钉 location 集合）意味着它只会继续漂移。

**建议**：按退役计划的"可选收紧"把 n100 `location /` 改成 `return 404` 并在 `deploy-n100.test.ts` 钉住 `/v1` 之外的 location 语义；或至少给 n100 补 `robots.txt` 与注释说明"catch-all 是有意保留"。

### F10（P3）Node 放行证据仍引用已退役的 Web 门禁

**证据**：`scripts/check-node-version.mjs:10-12`："Node 套件 1673 条里 1669 通过…**Web vitest 25 个文件 184 条全过；`npm run build` 成功**；v33/v34/v35 迁移…也为绿"，并写"这条改动一旦被回退，上面那些绿就没有任何东西在守了"。D17 之后 Web 套件与 `npm run build` 已删除，这半句证据**永远无法复验**；`1673` 也与当前规模（本轮 `rust:verify` 之外的 Node 套件已 2000+ 条，deliverables 有记录 2038 例）不符。

**影响**：放行 Node 24 的论证里混入了不可复验项，后来者无法判断"24 仍然是安全的"；这是历史注释而非门禁，故 P3。建议注明"Web/build 部分为 2026-10-12 历史证据，D17 后不可复跑"，并更新当前测试规模。

### F11（P3）CI 的真实覆盖为零，且 Windows/Node 24 无远程验证

**证据**：`.github/workflows/ci.yml:7-13` 注释自述"本仓库远端是 **gitee**，GitHub Actions **不会**被 push 触发…**不要**把它当成'提交已被 CI 覆盖'的证据"；`.workflow/master-ci.yml:1-9` 标题即「Gitee Go 主干门禁（**草案**）」，正文要求"先在仓库页 服务 → Gitee Go 开通"，`commands` 只有 `npm ci / typecheck / test / smoke`（无 `check:*` 家族）。`.github` 的 `verify` job 只跑 `node-version: [22.x]`（`ci.yml:127`），而 `.nvmrc`=22、本机开发=24.21.0、`engines` 允许 22/24。`windows-runtime` job 在 `windows-latest` 上直接跑 `npm test`（`:117`）——正是 F4 的默认并发路径，Windows runner 通常核数更少但磁盘/杀软更慢，时间预算型用例在 CI 上是另一个未验证面。

**影响**：README 已如实写明"不要把没有 CI 红读成已验证"，所以这不算隐瞒；但**没有任何东西守住这条说明本身**——如果将来有人把"CI 绿"写进发布记录，仓库不会有门禁反对。Node 24 的兼容性只靠提交机上的 pre-commit（typecheck+文档类门禁）兜底，而 pre-commit **不跑全量测试**。

**建议**：在 `README.md`/`docs/OPERATIONS.md` 的发布清单里加一行硬要求（"发布记录必须写明 gitee 侧未启用 CI，判据来自本机实跑"）；若 gitee Go 短期不开通，考虑把 `master-ci.yml` 明确标注为"草案，未启用"，避免读者把它当已接线门禁。

### F12（P3）生产依赖 4 个 moderate 漏洞

**证据**：`npm audit --omit=dev` → `4 moderate severity vulnerabilities`，EXIT=1；链路 `onnxruntime-node → global-agent ≤3.0.0 → roarr ≤2.15.4 → sprintf-js`（GHSA-hp3w-g68c-fv3c，DoS via unbounded precision specifiers）。`fix available via npm audit fix --force; Will install onnxruntime-node@1.30.0, which is outside the stated dependency range`。

**影响**：onnxruntime-node 属 ML 侧依赖，是否在 API 生产路径被加载取决于实现（本 lane 未追调用链，见 §4）；`sprintf-js` 的 DoS 需要攻击者控制格式串，实际可达性低。作为供应链记录保留，不阻塞发布。建议：记录为已知项；若升级 onnxruntime 不在本轮范围，用 `overrides` 固定 `sprintf-js`/`roarr` 的更高版本前先验证 onnxruntime 兼容性（项目已有 `overrides` 先例：`adm-zip`、`tsx.esbuild`）。

### F13（P3）README 检查清单与 pre-commit 实际内容不同步

**证据**：`README.md:52` 列出 pre-commit 跑"typecheck、文档链接、文档行号引用、npm 脚本跨平台语法、计划定向回归、§16.1 验收矩阵、包边界"，并说 `apps/ios/`/`packages/storage-sqlite/` 有改动时"各自再跑对应门禁"。实际 `.githooks/pre-commit` 还**每次提交都跑**：`node scripts/check-blob-size.mjs`（`:12`，1.5MB 上限）与表分类清单门禁（`:100-108`，触发面含 `.githooks/pre-commit` 自身）。漏列前者影响小（它只在超大文件时拦截），漏列后者会让"为什么我的提交被拦"缺少文档答案。

**建议**：README 那句补上"仓库体积闸门（1.5MB/文件）"与"表分类清单↔迁移产物一致性"两项。

### F14（P3）历史数字与"当前审查"入口并置，容易误读

**证据**：`docs/PROJECT_REVIEW.md:89` 标题为「修复前审查的检查结果（**历史保留**）」，`:102` 写 `matrix **54 cited / 0 declared-gap / 0 missing**，包边界 **15 packages / 30 src edges**`；当前门禁输出为 **80 / 16 packages / 31 edges**。`:77` 另有"Markdown **192 → 20 份**"的历史数字；`README.md:71` 把该文档描述为"当前审查结果与未决问题"。`docs/COACH_LOOP_IMPLEMENTATION_STATUS.md:5-6` 已按正确做法加"时点记录声明"，而 `PROJECT_REVIEW` 只在节标题写"历史保留"，表格内数字没有"此刻已变"的标注。

**影响**：把这几个数字写进新报告/PR 描述的人会引用到旧值（本轮已有先例：README 里"80 条"是对的，但 `PROJECT_REVIEW` 的 54/15/30 与之并置）。P3，因为节标题确实标了"历史保留"。

**建议**：给 `:102` 那行加"（2026-09-30；当前值以 `npm run check:acceptance-matrix` / `check:package-boundaries` 输出为准：80 / 16 / 31）"，或在 README 的链接描述里改为"审查历史与未决问题"。

### F15（P3）doc-refs 默认范围仍有"漏登记"

**证据**：`scripts/check-doc-line-refs.mjs:75` 自述 `deploy/README-UBUNTU.md`（1 处）"属于漏登记，**待补**"——HEAD 仍不在 `DEFAULT_DOCS`（`:79-106`）。同一清单外还有现行文档：`docs/DECISIONS.md` 2 处、`docs/HEALTHKIT_RECORD_SYNC_V2.md` 1 处、`docs/IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN.md` 1 处。本 lane 把 4 份显式传入补跑：`合计 5 处；越界 0；内容漂移 0`（当前无死引用），但**没有门禁**在它们漂移时变红。

**影响**：范围遗漏本身不报错（脚本头注释已警告这一点）；当前无实际死引用，属于"已知的待补项一直没补"。P3。

**建议**：把 `deploy/README-UBUNTU.md` 与 `docs/DECISIONS.md` 加入 `DEFAULT_DOCS`（DECISIONS 的 2 处引用是现行决策依据，最值得守）；`IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN` 若是时点方案则维持范围外并注明。

## 4 证据等级与未验证边界

**已实测（命令输出/夹具突变可直接复现）**：§1.1 全部命令的执行与退出码；doc-links/doc-refs/acceptance-matrix/package-boundaries/blob-size 的突变反应；`nodeTestFiles()`=257 与 tracked 测试文件逐一比对；`RAI_TEST_CONCURRENCY` 校验矩阵；`inspectScript()` 规则表；/tmp 生产语义探针（根路径/静态/assets/robots/401/410 路由存在性）；单引号 import 计数；行尾与仓库卫生清点；`npm audit` 结果。

**代码阅读推断（未跑）**：
- **全量 `npm test` 的当前红/绿**：Lead 在跑，本 lane 刻意不重复。F4 的"默认并发会假红"引用的是脚本作者 2026-10-12 的实测记录，不是本 lane 本轮复现。
- **80 条验收矩阵是否真有断言**：本 lane 只证明"空断言可满足门禁"，未逐条核对 80 个 cited 测试体的断言强度（那属于测试质量 lane 的范围）。
- **`npm audit` 的 onnxruntime-node 是否在 API 生产路径加载**：未追调用链；只记录审计结论。
- **n100 模板的实际线上行为**：未部署该拓扑；差异判断基于两份 conf 文本与退役计划的记录。
- **Windows 入口**：`npm run test:ios` 的 Windows 跳过契约、`deploy-n100/deploy-upgrade` 的 Windows-only skip 均未在本机实跑（本机 macOS）；CI 的 `windows-runtime` job 从未被触发过（gitee 不触发，F11）。
- **ml:test / rust:build**：未跑（`ml:check` 已确认 venv 就绪；`rust:verify` 11/11 绿）。

**方法边界**：突变实验均在 `/tmp/l5/**` 的独立 git 夹具上完成（`git init` + 最小输入），仓内跟踪文件全程未改（审查结束 `git status --short` 为空）；因此 F1/F3/F5/F6/F7 的结论是"门禁在等价的真实结构上会怎样反应"，而不是"仓库当前已违反"。F3 的"当前无实际违反"是用宽正则全仓重扫后的对照结论。

## 5 与既有审查关系

- **docs/PROJECT_REVIEW.md §2/§3（2026-09-30）**：其中"R4 测试入口跨平台已修"在当前 HEAD 依然成立（`run-tests.mjs` 的显式文件枚举、`shell:false`、`RAI_TEST_CONCURRENCY` 校验都在位）；本次 F4 是该修复的**代价项**（默认并发假红）而非回退。
- **deliverables/training-plan-review-2026-10-18/（P2-16/P2-17/P2-18）**：P2-17 已把三份训练计划文档加入 doc-refs 默认范围（当前实测生效，`docs/IOS_TRAINING_PLAN_*.md` 三行输出）；本轮 F15 指出同一问题在 `deploy/README-UBUNTU.md`/`DECISIONS.md` 上**仍存在**（脚本自述"待补"未补）。P2-16 的矩阵 G06-G08 与 P2-18 文档口径在 HEAD 未发现新违反。
- **deliverables/README.md「收尾后并入或删除」约定**：F8 是该约定未被执行的量化证据（33 份 md 全列在"未提交改动"节，而工作树干净）。
- 与 Lane 1–4 的边界：Rust parity/语义归 Lane 1；API 行为归 Lane 2/3；iOS 门禁实跑归 Lane 4（本 lane 只审 `run-ios.mjs`/pre-commit 的跳过与认账语义，未运行 iOS 门禁）。本报告未改任何其他 lane 的产物。
