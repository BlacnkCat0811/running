// `transactionOwner` 模式（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §2.1）。
//
// 这个文件要证明的不是"我们约定组件不提交"，而是**组件提不了**：
// 在 `"caller"` 模式下 `flush()` / `rollback()` / `beginAtomicImport()` 全部抛错，
// 而且默认值本身就把自动迁移与自动备份堵死了。
//
// 🔴 每条约束都要有一次"期望抛错"的调用。只断言"正常路径能走通"无法区分
// "约束生效"与"约束被删掉了" —— 后者下正常路径一样能走通。
//
// ⚠️ 未覆盖（不要当成已保证）：`journal_mode` 非 WAL 时构造抛错这条分支。
// 它需要一块不支持 WAL 的存储，本机造不出来；代码里那条断言只能靠评审。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PendingMigrationsError, RaiDatabase } from "../src/database.js";

async function withPaths(run: (ctx: { path: string; root: string }) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "rai-transaction-owner-"));
  try { await run({ root, path: join(root, "rai.sqlite") }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function manifest(store: RaiDatabase, key: string): string | null {
  const row = store.database.prepare("SELECT value FROM import_manifest WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * 真实顺序：**启动时**由 store 模式建立 schema，**热路径**再以 caller 模式打开。
 * 直接对全新库开 caller 模式会被默认的 `refuse` 拒掉 —— 那是正确行为，不是测试顺序问题。
 */
async function migrated(path: string): Promise<void> {
  const store = await RaiDatabase.open(path, { createMigrationBackup: false });
  store.close();
}

test("默认模式行为不变：store 自己管事务，setManifest 立即可见", async () => {
  await withPaths(async ({ path }) => {
    const store = await RaiDatabase.open(path, { createMigrationBackup: false });
    try {
      store.setManifest("probe", "value");
      assert.equal(manifest(store, "probe"), "value");
      // store 模式下既有的两条通道仍在，且不抛错。
      store.flush();
      store.rollback();
    } finally { store.close(); }
  });
});

test("caller 模式默认 refuse：空库不被自动迁移，也不创建项目备份", async () => {
  await withPaths(async ({ path, root }) => {
    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    // 退回"还没有迁移账本"的状态：pendingMigrations 会返回全部。
    const downgrade = new DatabaseSync(path);
    downgrade.exec("DROP TABLE schema_migrations");
    downgrade.close();

    await assert.rejects(RaiDatabase.open(path, { transactionOwner: "caller" }), (error: unknown) => {
      assert.ok(error instanceof PendingMigrationsError, String(error));
      return true;
    });
    // refuse 的含义是"一行都不写"：迁移账本没被重建，备份目录也没出现。
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='schema_migrations'").get()!.n, 0);
    } finally { probe.close(); }
    assert.equal(existsSync(join(root, "backups")), false, "caller 模式不得创建项目备份");
  });
});

test("caller 模式拒绝与之冲突的显式选项，而不是静默忽略", async () => {
  await withPaths(async ({ path }) => {
    await assert.rejects(RaiDatabase.open(path, { transactionOwner: "caller", migrationPolicy: "apply" }),
      /cannot apply migrations/);
    await assert.rejects(RaiDatabase.open(path, { transactionOwner: "caller", createMigrationBackup: true }),
      /cannot create a migration backup/);
  });
});

test("caller 模式下 store 不能自己开事务，也不能自己提交", async () => {
  await withPaths(async ({ path }) => {
    await migrated(path);
    const store = await RaiDatabase.open(path, { transactionOwner: "caller" });
    try {
      // 事务外：store 想让 `setManifest` 自己 BEGIN —— 被拒。
      assert.throws(() => store.setManifest("outside", "1"), /does not own its transaction/);
      assert.throws(() => store.beginAtomicImport(), /does not own its transaction/);

      // 事务内：写入走得通，但**组件提交不了**。
      store.beginCallerTransaction();
      store.setManifest("inside", "1");
      assert.equal(manifest(store, "inside"), "1");
      assert.throws(() => store.flush(), /does not own its transaction/);
      assert.throws(() => store.rollback(), /does not own its transaction/);
      assert.throws(() => store.beginAtomicImport(), /does not own its transaction/);

      store.rollbackCallerTransaction();
      assert.equal(manifest(store, "inside"), null, "caller 回滚后写入必须消失");
    } finally { store.close(); }
  });
});

test("flushIfOwned 是**按所有权**提交：store 模式提交、caller 模式什么都不做", async () => {
  // 解析器与路线写入器（`@rai/health-export-parser`）在两种所有权下都要能跑：
  // store 模式下它们确实要提交自己那一段，caller 模式下提交权归调用方。
  // 🔴 它们此前直接调 `flush()`，于是直连车道**每一批**都在这里失败 —— 而报错看起来像
  // "事务所有权配置错了"，与真因（组件擅自提交）无关。这条用例把两种语义都钉住。
  await withPaths(async ({ path }) => {
    await migrated(path);
    const owner = await RaiDatabase.open(path, { createMigrationBackup: false });
    try {
      owner.setManifest("owned_by_store", "1");
      owner.flushIfOwned(); // store 模式：等价于 flush()
      owner.setManifest("owned_by_store_2", "2");
      owner.beginAtomicImport();
      owner.flushIfOwned();
      owner.commitAtomicImport();
    } finally { owner.close(); }
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(reader.prepare("SELECT value FROM import_manifest WHERE key='owned_by_store'").get()?.value, "1");
      assert.equal(reader.prepare("SELECT value FROM import_manifest WHERE key='owned_by_store_2'").get()?.value, "2");
      assert.equal(reader.prepare("SELECT value FROM import_manifest WHERE key='owned_by_caller'").get(), undefined,
        "caller 模式下 flushIfOwned 不得替调用方提交");
    } finally { reader.close(); }

    const caller = await RaiDatabase.open(path, { transactionOwner: "caller" });
    try {
      caller.beginCallerTransaction();
      caller.setManifest("owned_by_caller", "c");
      caller.flushIfOwned(); // caller 模式：静默无事发生（提交权不归它）
      assert.equal(manifest(caller, "owned_by_caller"), "c", "同一连接内仍然可见");
      caller.rollbackCallerTransaction();
      caller.rollbackIfOwned(); // 同上：不得抛错、也不得做别的事
      assert.equal(manifest(caller, "owned_by_caller"), null);
    } finally { caller.close(); }
  });
});

test("caller 事务：提交后落库，回滚后消失，且不会留下半批", async () => {
  await withPaths(async ({ path }) => {
    await migrated(path);
    const store = await RaiDatabase.open(path, { transactionOwner: "caller" });
    store.beginCallerTransaction();
    store.setManifest("committed", "a");
    store.commitCallerTransaction();
    assert.equal(manifest(store, "committed"), "a");

    store.beginCallerTransaction();
    store.setManifest("aborted", "b");
    store.rollbackCallerTransaction();
    assert.equal(manifest(store, "aborted"), null);
    assert.equal(manifest(store, "committed"), "a", "回滚不得影响已提交的前一批");
    store.close();

    // 换一个连接复核：不是"同一个连接里看不见"，而是真的没写盘。
    const reopened = await RaiDatabase.open(path, { transactionOwner: "caller" });
    try {
      assert.equal(manifest(reopened, "committed"), "a");
      assert.equal(manifest(reopened, "aborted"), null);
    } finally { reopened.close(); }
  });
});

test("savepoint 只保护一小段：撤销它，外层已完成的部分保留", async () => {
  await withPaths(async ({ path }) => {
    await migrated(path);
    const store = await RaiDatabase.open(path, { transactionOwner: "caller" });
    try {
      store.beginCallerTransaction();
      store.setManifest("outer", "kept");

      store.savepoint("try_route");
      store.setManifest("route", "half-written");
      store.rollbackSavepoint("try_route");
      assert.equal(manifest(store, "route"), null, "被回滚的 savepoint 内的写入必须消失");
      assert.equal(manifest(store, "outer"), "kept", "savepoint 之前的写入必须保留");

      store.savepoint("commit_route");
      store.setManifest("route2", "complete");
      store.releaseSavepoint("commit_route");
      assert.equal(manifest(store, "route2"), "complete");

      store.commitCallerTransaction();
    } finally { store.close(); }
  });
});

test("savepoint 的错误用法全部抛错：事务外 / 非最内层 / 泄漏 / 重名 / 非法名", async () => {
  await withPaths(async ({ path }) => {
    await migrated(path);
    const store = await RaiDatabase.open(path, { transactionOwner: "caller" });
    try {
      assert.throws(() => store.savepoint("outside"), /requires an active caller transaction/);

      store.beginCallerTransaction();
      assert.throws(() => store.savepoint("bad name"), /Invalid savepoint name/);
      store.savepoint("s1");
      assert.throws(() => store.savepoint("s1"), /already active/);
      store.savepoint("s2");
      // 🔴 LIFO：`RELEASE s1` 会连带释放 s2，所以必须先收 s2 —— 否则一个组件能误放另一个组件未完成的工作。
      assert.throws(() => store.releaseSavepoint("s1"), /must target the innermost savepoint/);
      assert.throws(() => store.rollbackSavepoint("s1"), /must target the innermost savepoint/);
      store.releaseSavepoint("s2");

      // 泄漏的 savepoint 让提交被拒 —— 静默提交会把别人没做完的半成品一起落库。
      assert.throws(() => store.commitCallerTransaction(), /unreleased savepoint/);
      store.releaseSavepoint("s1");
      store.commitCallerTransaction();

      // rollbackSavepoint 之后该 savepoint 不再存在。
      store.beginCallerTransaction();
      store.savepoint("once");
      store.rollbackSavepoint("once");
      assert.throws(() => store.releaseSavepoint("once"), /without an active savepoint/);
      store.rollbackCallerTransaction();
    } finally { store.close(); }
  });
});

test("store 模式下 savepoint 不可用；caller 生命周期方法在无事务时行为明确", async () => {
  await withPaths(async ({ path }) => {
    const store = await RaiDatabase.open(path, { createMigrationBackup: false });
    try {
      assert.throws(() => store.savepoint("s"), /requires transactionOwner="caller"/);
      assert.throws(() => store.beginCallerTransaction(), /requires transactionOwner="caller"/);
      assert.throws(() => store.commitCallerTransaction(), /requires transactionOwner="caller"/);
      assert.throws(() => store.rollbackCallerTransaction(), /requires transactionOwner="caller"/);
    } finally { store.close(); }

    const caller = await RaiDatabase.open(path, { transactionOwner: "caller" });
    try {
      // 提交必须有活动事务；回滚必须能在 `finally` 里安全调用（无事务时静默）。
      assert.throws(() => caller.commitCallerTransaction(), /No caller transaction is active/);
      assert.doesNotThrow(() => caller.rollbackCallerTransaction());
      caller.beginCallerTransaction();
      assert.throws(() => caller.beginCallerTransaction(), /already active/);
      caller.rollbackCallerTransaction();
    } finally { caller.close(); }
  });
});

// ── 内部提交点 vs 公开 flush()（2026-10-12 红队 F4）──────────────────────────────
//
// 公开的 `flush()` / `rollback()` 在 caller 模式下抛错，这是**对外**的保证（组件不得自提交）。
// 但 store **内部**的提交点也用了它们，于是：
//   · 一条现成的写入路径在 caller 模式下直接抛错；
//   · 失败路径的 `catch { this.rollback() }` 再抛一次，**把真错误换成了 rollback 的错误**；
//   · `close()` 只在 `inTransaction` 为真时才会踩到，所以只有"事务未收尾就关闭"才暴露 ——
//     那时 `database.close()` 永不执行，句柄泄漏。
// 内部提交点改为 `flushIfOwned()` / `rollbackIfOwned()` 之后，这三条一起消失。

test("caller 模式：内部写入路径不再抛错，且不会替调用方提交", async () => {
  await withPaths(async ({ path }) => {
    await migrated(path);
    const store = await RaiDatabase.open(path, { transactionOwner: "caller" });
    try {
      store.beginCallerTransaction();
      // 走的是 `removeWorkoutsBySyncIdentifiers` 末尾那个内部提交点。
      // 旧代码在这里抛 "flush() requires the transactionOwner=store mode"。
      assert.deepEqual(store.removeWorkoutsBySyncIdentifiers(["does-not-exist"]), []);
      // 关键：内部提交点**没有**提交 —— 回滚之后本次写入必须一起消失，证明还在调用方事务里。
      store.setManifest("inside", "1");
      store.rollbackCallerTransaction();
      assert.equal(manifest(store, "inside"), null, "caller 回滚后这次写入必须消失");
    } finally { store.close(); }
  });
});

test("caller 模式：事务未收尾时 close() 响亮报错，且句柄仍被关掉（不泄漏）", async () => {
  await withPaths(async ({ path }) => {
    await migrated(path);
    const store = await RaiDatabase.open(path, { transactionOwner: "caller" });
    store.beginCallerTransaction();
    store.setManifest("uncommitted", "1");
    // 🔴 两条必须**同时**成立，缺一不可：
    //   · 不许静默：关连接会让 SQLite 回滚掉这一整批已写入未提交的改动，而调用方毫无提示
    //     ⇒ 必须报错，让调用方先去 commit/rollback。
    //   · 不许泄漏：报错也不能让 `database.close()` 跳过（旧写法正是那样泄漏了句柄）。
    assert.throws(() => store.close(), /caller transaction is still open/);
    assert.throws(() => store.database.prepare("SELECT 1").get(),
      "close() 之后连接必须不可用 —— 否则说明句柄泄漏了");
  });
});

test("caller 模式：事务收尾之后 close() 不抛错", async () => {
  await withPaths(async ({ path }) => {
    await migrated(path);
    const store = await RaiDatabase.open(path, { transactionOwner: "caller" });
    store.beginCallerTransaction();
    store.setManifest("committed", "1");
    store.commitCallerTransaction();
    assert.doesNotThrow(() => store.close());
    // 提交确实落库了，不是"被 close 丢掉"。
    const reopened = await RaiDatabase.open(path, { transactionOwner: "caller" });
    try { assert.equal(manifest(reopened, "committed"), "1"); }
    finally { reopened.close(); }
  });
});
