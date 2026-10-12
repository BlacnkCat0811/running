# 直接增量同步 PR4 步骤 2a/2b：载荷分类与调用方持有的事务（2026-10-13）

依据：[PR4 落地设计](../docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md) §2.1/§2.2/§7（含撰写后修订 §7.1）。

**范围**：步骤 2a（载荷分类纯函数，"未知必须分析"）与 2b（解析器进入调用方持有的事务）。
**不在本轮**：写守卫分档（2c）、同事务登记分析任务（2d）、放开 `deltaMode: "full"`（2e）。

---

## 1. 2a：`classifyDirectSyncPayload`（默认方向 = 必须分析）

| 改动 | 位置 |
|---|---|
| `scoringHealthTypes` 的**唯一定义**移入共享层（原处改为转发） | `packages/contracts/src/index.ts` / `apps/api/src/health-change-plan.ts` |
| 新增 `classifyDirectSyncPayload` + 两个类型 | `packages/health-export-parser/src/record-delta-policy.ts`（经包 index 导出） |
| 新用例 9 条 | `packages/health-export-parser/test/direct-sync-payload-class.test.ts` |

判据：只有**证明了**"所有类型都在非评分白名单里，且没有 Workout / 路线 / 显式删除"才允许
`record-only`；**未知类型一律要求分析**。理由写在被测函数注释里，核心是两个方向的代价不对称 ——
"该分析却宣布 `not_required`"会让用户看到与事实不符的当前结论（§9.1 禁止），而
"不必分析却登记了分析"只是多跑一次计算。输出排序，同样输入逐字相同。

## 2. 2b：`callerOwnedTransaction`（解析器提不了提交）

- 新增选项与 `CALLER_OWNED_PARSE_SAVEPOINT`；批次边界改为 `savepoint` / `releaseSavepoint` /
  `rollbackSavepoint`，**不产生提交点**，也不调用 `flush()`/`rollback()`。
- 与 `recordDelta`、`atomic: false` **互斥**，判定在函数最前面（先于资格检查与任何写入）。
- 失败路径的收尾**不得换掉真因**（F4 的教训），且泄漏的 savepoint 会让调用方的
  `commitCallerTransaction()` **拒绝提交并点名它** —— 不存在"静默提交半批"。
- 新用例 4 条：`packages/health-export-parser/test/caller-owned-transaction.test.ts`。
  其中第 3 条是本步的核心承诺：**解析失败后，调用方失败前与失败后的写入都能提交，
  而半批事实一行不落**。

## 3. 实测

| 项 | 结果 |
|---|---|
| `tsc --noEmit`（pure + full） | EXIT=0 |
| `packages/health-export-parser/test/*` | 146/146 pass |
| 受影响 API 侧 6 个文件（data-only ×2 / direct-sync ×3 / health-incremental） | 70/70 pass |
| `packages/contracts/test/*` + `application/test/service.test.ts` | 49/49 pass |
| 新增用例 | 2a 9/9、2b 4/4 |
| 全量套件 | 见 §5（本文件写作时仍在跑） |

**突变验证（3 处，全部被精确捕获）**：

| # | 突变 | 结果 |
|---|---|---|
| A | 分类器忽略未知类型（= 默认放行） | 2a **3 条转红**（未知类型必须分析 / 白名单+未知 / 确定性） |
| B | 解析器在成功路径上自己 `commitCallerTransaction()` | 2b "commit 前第二个连接看不到"转红 |
| C | 失败路径 `rollbackSavepoint` → `releaseSavepoint`（保留半批） | 2b "半批事实一行不落"转红 |

突变全部回退，回退后复跑 13/13 绿 + `tsc` EXIT=0。

## 4. 撰写后修订（实施时发现初稿两处需要改，已写进设计文档 §7.1）

1. **分类事实的来源改为"批次账本"而不是第二遍 XML 扫描**：XML 扫描是第二套解释，
   与真正落库的解析器只要有一处不一致（大小写、属性缺失、未来新元素），分类就会与事实**静默**脱节。
   账本是本批写入的自身结果。纯函数签名不变，变的是谁喂它。
2. **写守卫的判据是"这张表属不属于本次接收"，不是"本批是不是 record-only"**：
   分类是**事后**结论（要等账本），而守卫必须在**写入之前**就位。

## 5. 如实标注的边界

- ⚠️ 全量套件结果见本轮提交信息与 `var/reports/full-test-pr4-step2ab.log`；本机无 `npm`，
  等价跑法是 `RAI_TEST_CONCURRENCY=1 node scripts/run-tests.mjs`（唯一已知环境失败项：
  `apps/api/test/node-version.test.ts` 的 npm 生命周期用例）。
- ⚠️ 2a 的分类函数**今天还没有生产调用方**（2c 才接），它现在的作用是"判据先落地、可被突变验证"。
- ⚠️ 2b 的能力同样**尚无生产调用方**：record-only 车道（`recordDelta`）与旧链路行为零变化，
  这一点由既有 146 条解析器用例与 70 条 API 用例覆盖。
- ⚠️ §14.3 P01–P06（目标云机）与 §14.5 真机验收在本环境不可达。

## 6. 下一步

2c 写守卫分档（守卫只回答"本事务允许写哪些表"：事实类允许、发布/分析类拒绝）
→ 2d 同事务登记 + 代次写入方 + 回执 `queued` → 2e 放开 `deltaMode: "full"`。

另：当轮并行完成的 **A01–A18 验收证据盘点** 见 `var/reports/acceptance-inventory-2026-10-13.md`
（逐条给出"现状判定 / 证据 / 缺口 / 阻塞于"）。
