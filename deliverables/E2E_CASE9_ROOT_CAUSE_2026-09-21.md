# E2E 用例 9 独立立项：根因与修复（2026-09-21）

> 对象：`apps/web/e2e/web-flows.test.ts` →「合成数据可完成首次导入、覆盖重算、模型切换和删除恢复」
> 触发：桌面 E2E 在 2026-09-21 首次于本机可运行（Chrome 就位），暴露出该用例**从未通过**。
> 结论：**不是应用缺陷，也不止一个原因** —— 是 1 处应用语义变更后 E2E 未同步 + 2 处测试自身写法缺陷。

---

## 1. 症状：不是"一个失败"，是"多点不稳定"

同一棵树、同一份代码，连跑 5 个完整样本，得到 **1 fail 与 3 fail 两种结果**：

| 样本 | 用例 9 实际失败点 | Playwright 报错 | 总耗时 |
| :--- | :--- | :--- | :--- |
| Run A | `:1529` | `strictEqual(false, true)` —— alert 出现了，焦点不在它上面 | 20.8 s |
| Run 4 | `:1553` | `locator.click: Timeout 30000ms` —— `getByRole('button',{name:'恢复'})` 找不到可点元素 | 52.4 s |
| Run 5 | `:1528` | `locator.waitFor: Timeout 30000ms` —— `alert hasText:'删除测试失败'` **从未出现** | 57.8 s |
| 昨日×2 | `:1553` | 同 Run 4 | — |

⇒ 🔴 **单样本定性一律作废**。三个失败点有**三个独立根因**，必须分别定位。

---

## 2. 根因（三项，均有代码级归属）

### A · 恢复入口不存在 —— **应用语义变更，E2E 未同步**（确定性，5 样本无一走过）

`a7e39e2`（**2026-09-18**，`feat(web): drop the token wall from the settings page`）把

```ts
const backups = useRemote<BackupDto[]>("/v1/backups");
```
改成
```ts
const backups = useRemote<BackupDto[]>("/v1/backups", tokenSaved);   // SettingsPage.tsx:120
```

该提交的原始理由（见 commit message）是合理的：**匿名访客在 `/v1/backups` 上必然 401**，让一个本来就看不到备份的页面挂红色错误块，看起来像站点坏了。

但它带来一个未被察觉的后果：

- `tokenSaved = readApiToken().length > 0`（`:116`），令牌存在 `localStorage["rai.web.apiToken"]`（`api.ts:11`）；
- E2E 用的是**全新 `browser.newContext()`**（`:1173`）⇒ localStorage 为空 ⇒ **`tokenSaved === false`** ⇒ `/v1/backups` **根本不发请求**；
- 备份列表只在 `backups.data?.length` 时渲染（`:514-558`），否则显示「配置令牌后可查看、下载与恢复备份。」（`:560`）；
- ⇒ **页面上不存在"恢复"按钮** ⇒ `restoreTrigger.click()` 30 s 超时。

🔴 **这是代码级必然，不依赖任何历史记录**：只要 E2E 不写令牌，该断言**不可能通过**。

### B · 删除失败的提示不出现 —— **测试用 500 触发了应用的"结果不确定"路径**（低频 2/5）

`SettingsPage.tsx:36-37`：

```ts
const mutationResultIsUncertain = (caught: unknown): boolean =>
  !(caught instanceof ApiError) || caught.status >= 500;
```

测试注入的是 **500**（`:1521`）⇒ `500 >= 500` ⇒ 判定为**结果不确定** ⇒ 进入 `:255-274` 的
**额外 health 二次确认**分支，它有**三个出口**：

| 出口 | 条件 | UI 表现 | `:1528` 断言 |
| :--- | :--- | :--- | :--- |
| 1 | health 成功且库仍在 | `删除测试失败` + 聚焦 | ✅ 通过 |
| 2 | health 请求失败 | `无法确认删除结果：…` | ❌ 文本不匹配，超时 |
| 3 | health 成功且 `databaseReady === false` | 「…连接中断后已通过运行状态确认」**无 alert** | ❌ 超时 |

⇒ 🔴 **用 500 去测"明确的失败提示"本身就是选错了状态码**：应用对 5xx 的语义是"结果可能已生效"，它**有意**不直接报失败。

### C · 焦点断言与 rAF 竞速（1/5）

`SettingsPage.tsx:276` 在异步 catch 里用 `requestAnimationFrame(() => deleteErrorRef.current?.focus())` 落焦点；
测试用**一次性** `evaluate(el => el === document.activeElement)` 断言（`:1529`）⇒ 与下一帧竞速。
恢复段 `:313/330/335` 是同一写法 ⇒ `:1585` 同族。

---

## 3. 修复（4 项，全部落在测试与本页一个 `id`）

| # | 位置 | 改动 |
| :--- | :--- | :--- |
| 1 | `web-flows.test.ts:1554-1561` | 删库成功后、进入恢复段之前，显式写入 `localStorage["rai.web.apiToken"]`，模拟"桌面浏览器已配置令牌 / iOS 壳已注入令牌"的真实形态 |
| 2 | `:1519-1528`、`:1592-1601` | 注入的失败状态码 **500 → 422**（确定性失败），并同步 `consumeExpectedHttpFailures(…, 422, …)` |
| 3 | `:1529-1535`、`:1572-1589`、`:1602-1607` | 三处焦点断言改为 `page.waitForFunction` **等待焦点到达**，不再一次性求值 |
| 4 | `SettingsPage.tsx:745` | 恢复确认框加 `id="restore-confirmation"`，让焦点等待有稳定锚点（与删除段 alert 已有 `id` 的风格一致） |

**关于 5xx 覆盖是否被削弱**：没有。`apps/web/test/settings-database.test.tsx:99` 与 `:118` 两个组件测试
**已覆盖**「响应丢失 → health 二次确认 → 不误报失败」的删除与恢复两条路径。E2E 只是不再拿 500 冒充"确定失败"。

**顺带补的守卫**（`:58-71`）：`does not request backups before a token is stored`
—— 断言 `useRemote` 第二参为 `false`，并把「无令牌时不能说成'还没有本地备份'」钉住。
该文件原先把 `readApiToken` 硬编码成 `() => ""`（`:17`）且用 mock 直接喂备份数据，**绕过了门控**，
导致「无令牌 ⇒ 不请求 / 不渲染恢复入口」这条行为**全项目零覆盖**。

---

## 4. 验证

| 项 | 结果 |
| :--- | :--- |
| 样本 1 · `npm run test:e2e:web` | `11 tests / 10 pass / 0 fail / 1 skip`，**EXIT=0**，85.9 s |
| 样本 2 · `npm run test:e2e:web` | `11 tests / 10 pass / 0 fail / 1 skip`，**EXIT=0** |
| 样本 3 · 直接 node（桌面块 + 响应式块**都跑**） | `11 tests / **11 pass** / 0 fail / 0 skip`，**EXIT=0** |
| 突变验证 · 去掉 `, tokenSaved` | 新守卫**变红**：`expected undefined to be false` ✅ |
| `npm run typecheck` | EXIT=0 |
| `npm run test -w @rai/web`（本文件） | **5 / 5 通过** |
| node 门禁 | 见 §6 |

- 样本 3 未设 `npm_lifecycle_event`，因此 `:16-20` 的互斥失效、**两块都执行** ⇒ 顺带证明**冻结的 390px 行为未受影响**。
- 修复前同一用例耗时被三处 30 s 超时拖到 3 m 25 s；修复后 **85.9 s**。

---

## 5. 一条判据链警告（不改历史文档）

`docs/PROJECT_HEALTH_AUDIT_2026-09-09.md:68` 记录 `npm run test:e2e:web` ✅ **10 pass / 1 skip**。
但 `89faa89`（**2026-09-14**）的 commit message 自述：

> 原先只有 Windows 与 Linux 路径，导致在 Mac 上 `npm run test:e2e:web` 必然报"未找到可用于 E2E 的本机 Chrome 或 Edge"，无法本地复现 CI 结果。

⇒ 在本机（这台 Mac）上，**9-09 时该命令不可能跑起来**。我没有修改那份历史快照，但本轮**不采信它**，
改用上面 §2A 的**代码级必然性**作为判据。若后续还要引用历史审计的 E2E 结论，建议先确认当时跑在哪台机器。

---

## 6. 环境侧两个新坑（本轮踩到）

1. 🔴 **`npm run test:e2e:web` 是 `npm run build && node --test …`** —— **含构建**。
   直接跑 `node --import tsx --test …` 时，Playwright 吃的是 **`apps/web/dist` 的已构建产物**
   （页面由 API 进程托管，见 `web-flows.test.ts:1215` 的 `firstRunApi.origin`）。
   改了 `apps/web/src` 却跳过 build，就会用**旧 dist** 验证新源码。
   （本轮 §2A 之前的几次裸跑之所以结论仍成立，是因为当时 `apps/web` 零改动，dist 与源码一致。）
2. 🔴 **沙箱的 safe-delete 守卫会拦掉同一轮内的第二次 build**：
   `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":65,"threshold":50,"scope":"turn",…targets:["apps/web/dist/assets"]}`
   ⇒ vite 清空 `dist/assets`（65 个文件 > 单轮 50 阈值）被拒，`EXIT=1` 且**测试根本没启动**。
   判据：日志里没有 `# tests` 摘要、耗时只有几秒 ⇒ 是构建失败，不是用例失败。跨轮次即恢复。
