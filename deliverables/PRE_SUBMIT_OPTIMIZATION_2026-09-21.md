# 提交前优化清单（2026-09-21）

对象：分支 `land/2026-09-21` ⇢ 目标 `main` / 部署。基准 `41c2490`；代码侧已重写为 **7 个可编译可测的提交**，
本清单文档为其后的第 8 个提交。
结论先行：**"能不能提交"这一项已经打通；"提交成什么样"与"部署前后要做什么"各有 1 项必须处理。**

---

## 1. 🔴 已修：提交节点曾经不可用（`bisect` 会撞假阳性）

### 症状（实测）

对 8 个原提交逐节点 detached checkout 后实跑：

| 原节点 | typecheck | node 测试 |
| :--- | :--- | :--- |
| `8af200f` 删影子对照 | ❌ `TS2353` ×2 | ❌ 739 项 / **4 fail** |
| `b256352` 阶段计时 | ✅ | ✅ 740/737/0/3 |
| 其余 6 个 | ✅ | ✅ |

- `TS2353`：`apps/api/test/health-incremental.test.ts:138/:218` 仍传 `validationMode`，而该字段已随影子对照被删。
- `4 fail`：`deploy-cloud.test.ts` / `deploy-n100.test.ts`（仍在断言模板含 `RAI_IMPORT_VALIDATION_MODE`）、
  `import-queue-live.test.ts`、`native-import-worker.test.ts`（仍在断言 shadow 行为）。

⇒ 即 **`apps/api` 侧的测试同步被错误地归到了「阶段计时」批**，而行为删除在「删影子」批。

### 为什么不是"逐 hunk 拆开"而是"合并"

统计两个提交里各测试文件改动的"影子相关行 / 总改动行"：

```
import-performance.test.ts    19 行改动 / 12 行影子
worker.test.ts                16 / 7
native-import-worker.test.ts  10 / 6
import-queue-live.test.ts      6 / 4
benchmark-import.test.ts      12 / 1
deploy-cloud.test.ts           4 / 2
deploy-n100.test.ts            2 / 1
import-publication.test.ts     4 / 2
import-queue.test.ts           4 / 2
import-source-finalization     2 / 1
```

**每个文件都是两个主题逐 hunk 交织**（`apps/api/src/import-worker.ts`、`server.ts` 同理）。
任一种拆法都会留下"编译或测试不通过"的中间节点 ⇒ 按硬约束（每节点必须可编译可测）**合并为一个提交**。

### 处置与验证

重写为 **7 个提交**（`backup/pre-rewrite-2026-09-21` 保命）：

| # | 提交 | 说明 |
| :--- | :--- | :--- |
| 1 | `1de8e8b` | `refactor(import): 删除 validationMode 通路并落地导入阶段计时`（原两条合并，message 并列两主题） |
| 2 | `8d044e9` | `chore: 移除 split-application-service.mjs` |
| 3 | `c6ea981` | `docs(deliverables): 2026-09-21 审查、优化方案与验证记录` |
| 4 | `ef76497` | `perf(health-export-parser): 复用 Intl 时区 formatter（OPT-1）` |
| 5 | `e004997` | `docs(plan): 批次 0 标注为已执行并回填结果` |
| 6 | `2cee611` | `fix(web): 修复 E2E 用例 9 的三处多点失败` |
| 7 | `eef658f` | `docs: 用例 9 立项闭环，并对齐引擎文档与验证口径` |

证明：
- **树的等价性**：`git diff --stat backup/pre-rewrite-2026-09-21 HEAD` **输出为空** ⇒ 最终内容逐字节不变，只改了提交边界。
- **逐节点实跑**（detached checkout，按该节点**实际存在的**测试文件清单跑）：

| 节点 | typecheck | node 测试 |
| :--- | :--- | :--- |
| `1de8e8b` | ✅ EXIT=0 | 740 / 737 pass / 0 fail / 3 skip |
| `8d044e9` | ✅ | 740 / 737 / 0 / 3 |
| `c6ea981` | ✅ | 740 / 737 / 0 / 3 |
| `ef76497` | ✅ | 747 / 744 / 0 / 3 |
| `e004997` | ✅ | 747 / 744 / 0 / 3 |
| `2cee611` | ✅ | 747 / 744 / 0 / 3 |
| `eef658f` | ✅ | 747 / 744 / 0 / 3 |

---

## 2. ✅ 已定：提交信息语言 —— 接受中文，规范已同步

小唐 2026-09-21 批复：**中英文均可**。按 **(b)** 处理。

| 项 | 处置 |
| :--- | :--- |
| 本分支 | **保留 7 条中文 message**，不重写历史 ⇒ 树仍逐字节不变 |
| 仓库惯例 | 英文为主（近 148 条里仅 21 条含中文），但"与历史一致"本身不是目标 |
| 规范文件 | ✅ 已改 `~/.workbuddy/skills/rai-commit-push/SKILL.md` §3：明确**中英文皆可** |

⇒ 之所以必须动规范：本项之所以成为"待定"，根源是 `SKILL.md` 单方面规定英文。
只改提交、不改规范，下次仍会撞同一个不一致。

---

## 3. ✅ 已定：7 处同类漏网 ⇒ 并入批次 4，本批**不动代码**

OPT-1 只修了 `packages/health-export-parser/src/utils.ts` 一处。同一模式在生产代码里还剩：

OPT-1 只修了 `packages/health-export-parser/src/utils.ts` 一处。同一模式在生产代码里还剩：

| 位置 | 是否在循环内 | 触发场景 | 量级（线上 73.4 µs/次构造） |
| :--- | :--- | :--- | :--- |
| `apps/web/src/format.ts:53` / `:62` | 每次调用 | **前端列表逐单元格渲染** | 每次渲染 N 次 |
| `apps/api/src/mobile-read.ts:627` | ✅ `for (row of rows)`，28 天窗口 ≈ 164 行/请求 | **`/v1/mobile/today`，iOS 每次刷新** | **≈ 12 ms/请求** |
| `packages/application/src/utils.ts:27` | 调用点含 `.map()` 与循环（`recompute-pipeline.ts:663/:676/:1143`） | 重算（离线） | ms 级 |
| `apps/api/src/server.ts:631` `localToday()` | 单次 | 请求内 | 极小 |
| `apps/api/src/data.ts:84` `localDateInShanghai()` | 单次 | 请求内 | 极小 |
| `packages/storage-sqlite/src/read/date-utils.ts:36` | 单次 | 请求内 | 极小 |
| `packages/training-load/src/index.ts:329` / `packages/training-zones/src/index.ts:110` | 包内多次 | 待测 | 未知 |

⚠️ **如实说明**：除前端渲染与 `/v1/mobile/today` 外，其余都是**毫秒级**，**不是性能救火**，单独立项不值。
✅ **已采纳（小唐 2026-09-21 批复）**：抽一个共享的 `timezone formatter` 工具（键 = 字段集 + 时区，
即 OPT-1 已验证的形态），**与批次 4（OPT-9a 时区入口收敛）同批**收敛 —— 不逐个打补丁。

**本批的处置 = 只登记、不改代码**：

- 上表已写入 `IMPLEMENTATION_PLAN_2026-09-21.md` 的**批次 4 范围**。
- 理由：批次 4 的前置决策「(a) 前端一起统一 / (b) 只收敛后端」尚未定，
  而表中 `apps/web/src/format.ts:53/:62` 两处**正好压在该决策的分界线上** ——
  先单独改它，会被 (a)/(b) 的选择再推翻一次，等于白做。
- ⇒ 本批**不动这 7 处**；OPT-1 的既有收益（云机真机省 18.9 s/次导入）不受影响。

---

## 4. ✅ 已授权：部署时清理线上**死配置**（并新增一条更隐蔽的闸门）

线上 `/etc/rai/rai.env`（Sep 19 14:16 写入）**仍含 `RAI_IMPORT_VALIDATION_MODE`**，
而本批代码已**彻底删除**读取它的通路（`importValidationModeFromEnvironment` 不存在）。

| 影响 | 说明 |
| :--- | :--- |
| 运行 | **无害**（无"未知变量即报错"校验），该变量现在是 no-op |
| 运维 | 🔴 **误导**：看到它还在会以为影子对照仍开着 —— 这是"配置写了 ≠ 生效"的**第四形态**（配置文件还在，读它的代码没了） |

⇒ **已授权**：部署时顺手清理该行（连同注释），让配置文件与代码一致。

### 🔴 闸门 0（本次最易漏、后果最静默）：Rust 二进制必须重编译

本批改了 `crates/rai-data-worker/src/main.rs`（+10/−2）：给 `apply-records` 新增 `canonicalDigest`
输出（`main.rs:551`、`:607`），TS 侧 `native-record-writer.ts` 用它跑 **B1 运行时写路径不变量**。

| 关键事实 | 证据 |
| :--- | :--- |
| TS 对缺失该字段**显式容忍** | `native-worker.ts:164` "deliberately absent-tolerant"；`native-record-writer.ts:91` "Older worker binary: B1 cannot run" |
| 后果 | **只部署 TS、不换二进制 ⇒ 线上不报任何错**，但 B1 静默不生效，仅在 `GET /v1/data-summary` 的 `issues` 留一条 |
| 线上正跑 Rust | `RAI_IMPORT_ENGINE=rust` + `RAI_RUST_BINARY=/opt/rai-native/rai-data-worker` |

⇒ 判据：**「TS 部署了」≠「引擎换了」** —— 比死配置更隐蔽（死配置至少摆在那里）。
必须 `git archive origin/main` 重导 `/opt/rai-native/src` → 停 API → `rust:build` → 替换二进制 → 验 `--version` 与真实 operation。

**部署前其余闸门**
1. 迁移 dry-run：`sudo -u rai npm run data:migrate -- --database /var/lib/rai/var/rai.sqlite` 必须报 `"pending": []`
   （本批**无迁移**，预期如此）。
2. 回滚：本批无迁移 ⇒ `git revert` + 重部署即可（不涉及 v23 那种单向门）。
3. 部署后验证：`GET /v1/runtime-status` 的 `performance` 块 —— `parseImport` 应从 **31.0 s 降到约 12 s**
   （云机真机实测 `canonicalizeNights` 21.3 s → 2.4 s，输出哈希一致 `375e2838de5e13e3`）。
4. 环境变量确认：**读写运行中进程** `/proc/<MainPID>/environ`，而不是配置文件（`RAI_IMPORT_ENGINE=rust` 等）。

---

## 5. ⚪ 门禁脚本自身的两个小瑕疵（可选修）

| # | 现象 | 影响 | 修法 |
| :--- | :--- | :--- | :--- |
| 1 | `test:e2e:responsive` 与 `test:e2e:web` **定义为同一条命令**（都含 `npm run build`），靠 `npm_lifecycle_event` 区分块 | `npm run test:e2e` 会**构建两次**；本机在同一轮内第二次 build 会被沙箱 safe-delete 守卫拦掉（清空 `dist/assets` 65 文件 > 单轮阈值 50）⇒ 命令失败且**测试根本没启动** | 让 responsive 那条复用 web 的产物：`"test:e2e": "npm run test:e2e:web && node --import tsx --test --test-concurrency=1 apps/web/e2e/web-flows.test.ts"` |
| 2 | `npm test` 的 web vitest 段在本机偶发 **forks worker 起不来**（资源饥饿） | "一条命令跑完门禁"在本机不可靠，必须 node 侧与 web 侧**分开报** | 给 vitest 加 `--pool=forks --maxWorkers=<n>` 上限，或接受分跑并写进规范 |

---

## 6. 尚未做的批次（原方案已排期，与"提交前"无关）

| 批次 | 内容 | 前置 |
| :--- | :--- | :--- |
| 2 | OPT-5 + OPT-6 队列护栏（**合并一次 v23，单向门**） | 需停服窗口 + **回滚脚本先演练** |
| 3 | OPT-7 控制库并入备份束（最高风险） | 需恢复演练环境 |
| 4 | OPT-9a 时区入口收敛（含上面第 3 节的 formatter 统一） | 需先定 (a) 前端一起统一 / (b) 只收敛后端 |
| 5 | OPT-4 打包预算 / OPT-10 断言 / OPT-11（撞冻结区，需授权） | — |
| — | OPT-3、OPT-2 已搁置；OPT-8 已删除（真实数据不支持） | — |

---

## 7. 我的判断与最终处置

| 优先级 | 事项 | 处置 |
| :--- | :--- | :--- |
| 🔴 已做 | 重写为 7 个可编译可测的节点 | `bisect` 可用性是硬红线，实测已破 |
| 🔴 必做 | 清掉线上 `RAI_IMPORT_VALIDATION_MODE` | ✅ 小唐已授权 ⇒ 本次部署执行 |
| 🔴 **新增** | **重编译 Rust 二进制**（第 4 节闸门 0） | 不换二进制则 B1 静默失效，**且不报错** —— 见第 4 节 |
| ✅ 已闭环 | 提交语言口径（第 2 节） | 小唐批复中英文皆可 ⇒ 保留中文 + 改规范文件 |
| ✅ 已闭环 | formatter 统一（第 3 节） | 小唐批复并入批次 4 ⇒ 本批只登记、不改代码 |
| ⚪ 未做（可选） | 第 5 节两条门禁脚本瑕疵 | 低风险，但会让"一条命令跑门禁"长期不可靠 |
