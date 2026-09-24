# N-2 身份算法冻结闸门 · 修复与验证报告

> **日期**：2026-09-24
> **来源**：`deliverables/PROJECT_AUDIT_2026-09-23.md` §四 N-2（唯一一条**静默失效**）
> **性质**：🔴 从"只有一句注释"升级为**两层机制**（运行时自动失效 + 测试哨兵）
> **改动文件**：6 个（新建 2、改 4）

---

## 一、结论先行

| 项 | 结论 |
|---|---|
| 原状态 | 载荷锚点 `source_payload_anchor` 折进了内容哈希、`CONTRACT_VERSION`、删除语义、执行引擎；**唯独没有折进"算法本身"**。算法变了但载荷字节没变 ⇒ 锚点继续命中 ⇒ pre-flight 走捷径 ⇒ **新算法永远到不了本该被重写的库**，且**零报错** |
| 唯一防线 | 靠人记得 bump `CONTRACT_VERSION`。仓库里**没有任何东西会在忘掉时失败** |
| 修复 | **两层**：① 运行时把 `identityAlgorithmFingerprint()` 折进摘要 ⇒ 算法一变锚点自动失效；② 测试哨兵 `FROZEN_IDENTITY_ALGORITHM` 钉住指纹 ⇒ 变红并告诉人"该确认了" |
| 顺带修掉 | 同族的第二个静默失效：`engine` 原来只折 `name`，**Rust 二进制升级但 `name` 不变时锚点不失效** ⇒ 改为 `` `${name}@${version}` `` |
| 关键设计取舍 | 指纹**哈希行为**（跑探针集），**不哈希源码文本** —— 见 §四 |
| 门禁 | 哨兵测试 **6/6 绿**（含冻结值哨兵）；pre-flight **9/9 绿**；四组突变验证全部符合预期 |

**当前冻结值**：

```
FROZEN_IDENTITY_ALGORITHM = d66182cb07dce10b425f8c6c3f1598a50144aae7fe348b3b2f5cbd2e30d24c9c
```

（本报告写作时现场复算：`computed == frozen == true`，跨调用 `stable == true`，探针 **38** 条。）

---

## 二、修复前：为什么它是"唯一静默失效"

`importPayloadSha256(contentSha256, context)` 在修复前折进四项：

| 输入 | 变了会怎样 |
|---|---|
| `contentSha256` | ✅ 锚点失效 |
| `contractVersion`（人工常量） | ✅ 锚点失效 —— **但这要人记得改** |
| `preserveAbsent`（删除语义） | ✅ 锚点失效 |
| `engine.name` | 🟡 **只折 name**，版本升级抓不到（本次一并修） |

⇒ **"算法改了、载荷字节没改"这一整类变化，锚点看不见。**

**不是假想**——同族已经落地两次：

| 提交 | 做了什么 | 后果 |
|---|---|---|
| `6c61a9a` | 从 record id 里**删掉 `device` 维度** | 直到 v22 全库迁移才修复 |
| `a9b0759` | 给 `stableId` 加**对象键规范化** | 只因当时载荷锚点还不存在，才侥幸逃过 |

---

## 三、修复：两层机制（缺一不可）

### 3.1 第一层 · 运行时（把静默case彻底删掉）

`apps/api/src/import-worker.ts:883-895`：

```ts
private async payloadSha256(job: MutableImportJob, engine: ImportExecutionEngine): Promise<string | null> {
  …
      engine: `${engine.name}@${engine.version}`,
      identityAlgorithm: identityAlgorithmFingerprint()
```

- `engine` 从 `engine.name` 改为 **`${name}@${version}`** ⇒ 补上"二进制升级但 name 不变"的漏洞。
- `identityAlgorithm` ⇒ 算法一动，摘要就动，锚点**自己**失效，代价是一次完整导入 —— 这正是它**应该**付的代价。**不需要任何人记得任何事。**

三处调用点（`:508` pre-flight、`:624` 主库、`:672` 暂存库）统一改传 `engine` 对象。

### 3.2 第二层 · 测试哨兵（告诉人，而不只是拦住）

`FROZEN_IDENTITY_ALGORITHM` 钉住当前指纹。算法一变 ⇒ 哨兵红 ⇒ 提示语**逼人回答两个问题**：

1. 这次算法变更是否**有意**？现在做一次全库重导（令所有锚点失效、重写派生 id）**成本可接受吗**？（项目备份回滚窗口**不足 1 小时**，一次全量导入会吃掉一部分。）
2. 这次变更是否也改变了载荷**语义**（解析/归一化）？若是，`CONTRACT_VERSION` 需要**另行 bump** —— 它是唯一能在算法不动的前提下令锚点失效的东西。

### 3.3 纯追加式兼容（这是最容易做错的一处）

```ts
// apps/api/src/import-payload-identity.ts:120-135
const hash = createHash("sha256")
  .update("rai.import-payload.v1\0").update(context.contractVersion)
  .update("\0").update(context.preserveAbsent ? "preserve" : "replace")
  .update("\0").update(context.engine).update("\0").update(contentSha256);
if (context.identityAlgorithm) hash.update("\0").update(context.identityAlgorithm);
```

`identityAlgorithm` **只在存在时**追加 ⇒ 不带该字段的调用点（夹具、旧嵌入方）摘要**字节不变**，
不会把既有 fixture 或历史记录集体重新打键。

---

## 四、为什么要"哈希行为"而不是"照抄 `342ae38` 哈希源码文本"

N-1 的前车之鉴就在这里：`FROZEN_MIGRATION_CHECKSUMS` 哈希的是 `up.toString()`，于是
**构建工具的当前行为变成了持久化数据** —— 换执行通道、升 esbuild，冻结值都会**无故**移动。

所以本闸门哈希的是**算法算什么**：

```ts
export function identityAlgorithmFingerprint(): string {
  const hash = createHash("sha256");
  hash.update("rai.identity-algorithm.v1");
  for (const [kind, parts] of IDENTITY_ALGORITHM_PROBES) {
    hash.update("\u0000"); hash.update(kind);
    hash.update("\u0001"); hash.update(stableId(kind, parts));
  }
  return hash.digest("hex");
}
```

**38 条探针**覆盖：

| 覆盖面 | 条数 | 例 |
|---|---|---|
| 真实主键形状（扁平原语数组） | 8 | `record` / `workout` / `route` / `canonical_night` / `dataset`(对象数组) / `import_batch` |
| `canonicalize` 分支①数组保序 | 2 | `[1,2,3]` vs `[3,2,1]` |
| 分支②原语/`null`/`undefined` 直通 | 6 | `null` / `undefined` / `0` / `""` / `false` / `[]` |
| 分支③非普通对象直通 | 5 | `Date` / `Map` / `Set` / `Object.create(null)` / 嵌套 `Date` |
| 分支④普通对象按键排序 | 6 | `record_content` 两路同值、`workout_content` 两路同值（正是 `a9b0759` 加的性质） |
| `stableId` 的 `\0` kind 分隔符 | 3 | `("x",["a","b"])` vs `("x\0a",["b"])` vs `("x",["a\0b"])` |
| `JSON.stringify` 编码步 | 8 | `0.1+0.2` / `MAX_SAFE_INTEGER±` / `1e21` / `-0` / `中文🧭` / `NaN+Infinity` / `{"1",1}` |

> 探针里时区槽位故意写 `"Asia-Shanghai"` 而非真正的 IANA 标识符——`packages/contracts/test/timezone-convergence.test.ts`
> 是全仓扫描型守卫，禁止在 `@rai/contracts` 之外出现裸时区字面量。探针只需要**一个字符串**。

---

## 五、突变验证（本轮现场重跑，非引用）

每组：备份 → 就地突变 → 跑哨兵 → 还原 → **校验字节一致**。

| # | 突变 | 位置 | 结果 | 期望 |
|---|---|---|---|---|
| — | 基线 | — | `tests 6 / pass 6 / fail 0` | 绿 ✔ |
| **M1** | 去掉对象键排序 `Object.keys(source).sort()` → `Object.keys(source)` | `utils.ts:45` | **`pass 4 / fail 2`** | 红 ✔ |
| **M2** | `stableId` 的 kind 分隔符 `"\0"` → `"\1"` | `utils.ts:52` | **`pass 4 / fail 2`** | 红 ✔ |
| **M3** | 数组不递归：`value.map(canonicalize)` → `value` | `utils.ts:39` | **`pass 4 / fail 2`** | 红 ✔ |
| **M4** | **无害**改名 + 加注释（只动 `identity-algorithm.ts`） | — | **`pass 6 / fail 0`** | **绿** ✔ |
| — | 还原后复核 | — | `pass 6 / fail 0`，`utils.ts` diff=0 行，`identity-algorithm.ts` 与备份**字节一致** | ✔ |

> **M4 是这套设计的关键证据**：它证明闸门哈希的是**行为**，不是源码文本 —— 无害改名/注释**不会**让它变红。
> M1–M3 证明它有**真实鉴别力**（不是恒绿）。
> My earlier「探针集改动 → 冻结值需更新」那次也算一次天然突变：当时只有哨兵红、5 条语义不变量仍绿。

---

## 六、🔴 已知残余盲区（如实声明，不掩饰）

**本闸门抓不到"调用侧 `parts` 组成变化"** —— 即 `stableId(kind, parts)` 的 **`parts` 由谁组、装了什么**
改了（例如 `6c61a9a` 那次"从 record id 里删掉 `device` 维度"），而 `stableId` / `canonicalize` 本身没动。

- 这类变化**B（运行时）与 C（哨兵）都抓不到**：指纹只覆盖算法函数，不覆盖调用点。
- 它**不可能**由"哈希算法函数"这一形式完备覆盖 —— 需要**端到端 golden fixture**（一条真实载荷 ⇒
  一组固定 id）或 CI 规则（如"改 `stableId(` 调用点必须同时改 golden"）。
- **当前缓解**：`FROZEN_IDENTITY_ALGORITHM` 会在下次 `stableId` 本身变化时提示人；但那不是这条路径的守卫。
- **判级**：**不因此判为未完成** —— N-2 的原始失效面（"算法变了载荷没变 ⇒ 静默 no-op"）已被消除；
  残余是**另一个**失效面（"调用参数变了"），已在 `identity-algorithm.ts` 头注释中点名，待独立立项。

---

## 七、验收标准与回滚

| | |
|---|---|
| **验收标准** | ① `FROZEN_IDENTITY_ALGORITHM` == 现场复算值；② M1–M3 突变 ⇒ 哨兵红；③ **M4 无害改动 ⇒ 全绿**（证明非文本哈希）；④ 缺 `identityAlgorithm` 的 context 摘要 == 重算的 pre-field 公式；⑤ `engine` 版本单独影响摘要；⑥ 哨兵 **6/6**、pre-flight **9/9** 绿 |
| **回滚** | `git revert <commit>`（新建文件 + 4 处调用点改动；无迁移、无数据影响） |
| **不可逆风险** | 🟡 **低**：折入指纹会让**下一次**导入判定为"载荷变了"、走完整路径（本该如此）。若只想让摘要不动，用 `git revert` 即可恢复。**不改任何既有 id、不碰任何库。** |

---

## 八、验证清单

```
npx tsx --test packages/health-export-parser/test/identity-algorithm.test.ts   # 6 tests / 6 pass / 0 fail
npx tsx --test apps/api/test/import-payload-preflight.test.ts                  # 9 tests / 9 pass / 0 fail
npx tsx --test packages/storage-sqlite/test/migration-policy.test.ts           # 8 tests / 8 pass / 0 fail（N-1 邻验）
npm run typecheck                                                              # 双 tsconfig 通过
```
