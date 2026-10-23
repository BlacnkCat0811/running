// 连接初始化在**并发写锁**下的两条确定性判据。
//
// 背景（本机实测，不是推测）：`PRAGMA journal_mode = WAL` **不经过** busy handler ——
// 只要另一个连接持有写锁，它在 0–1 ms 内直接抛 `database is locked`，把 `busy_timeout`
// 设成 3000/5000 也一样；而同情形下普通 INSERT 会等满 3334 ms。所以"让 SQLite 自己去等"
// 对 mode 切换这条路不通，只能在 `RaiDatabase` 里显式、有界地重试。
//
// 🔴 这个布局是踩过坑才定下来的，两个坑都会让用例**假绿**：
//   ① 库必须是 **delete 模式**（还没进 WAL）。对已是 WAL 的库那条语句是 no-op、不加锁，
//      拿已 WAL 的库造竞争会得到"8–9 ms 就成功"的假绿。
//   ② **持锁方必须在独立进程**。被测的 `RaiDatabase` 构造是同步的，测试主进程一旦用
//      `spawnSync` 等子进程就被阻塞，主进程里的 `setTimeout` 根本不会触发 ⇒
//      "在重试窗口内释放锁"永远不成立，成功用例必然失败（实测：THREW_MS=4574）。
//      所以用 **detached 的子进程持锁**，由它自己按时间松手。
//
// 两条用例都不靠概率：持锁方先就位（ready 文件），等待方才启动。

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "../../..");
// 与 `ensureWalMode()` 的上限对齐：10 次 × 500 ms。
const RETRY_BUDGET_MS = 5_000;
const CHILD_TIMEOUT_MS = 30_000;

/** 等待方：开头一个**还没进 WAL** 的库，报告成功耗时或原始错误。 */
const OPENER_SCRIPT = `
  const { RaiDatabase } = await import("@rai/storage-sqlite");
  const started = Date.now();
  try {
    const store = await RaiDatabase.open(process.argv[1], { createMigrationBackup: false });
    try {
      process.stdout.write("OPENED_MS=" + (Date.now() - started) + " MODE=" +
        String(store.database.prepare("PRAGMA journal_mode").get()?.journal_mode));
    } finally { store.close(); }
  } catch (error) {
    process.stdout.write("THREW_MS=" + (Date.now() - started) + " MSG=" + error.message);
  }
`;

/** 持锁方：独立进程持写锁；`holdMs > 0` 时自己松手，否则一直持到被杀。 */
const holderScript = (holdMs: number): string => `
  const { DatabaseSync } = await import("node:sqlite");
  const { writeFileSync } = await import("node:fs");
  const [path, readyFile] = process.argv.slice(1);
  const holder = new DatabaseSync(path, { timeout: 0 });
  holder.exec("BEGIN IMMEDIATE");
  holder.exec("INSERT INTO marker VALUES ('hold')");
  writeFileSync(readyFile, "ready");
  ${holdMs > 0
    ? `setTimeout(() => { try { holder.exec("COMMIT"); } catch {} holder.close(); }, ${holdMs});`
    : "setInterval(() => {}, 1000);"}
`;

/** 造一个 `delete` 模式（默认）的库，带一张表。 */
function makeDeleteModeDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE marker (value TEXT NOT NULL)");
    const mode = String((db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown }).journal_mode).toLowerCase();
    assert.equal(mode, "delete", "前置条件：本文件的用例必须用还没进 WAL 的库");
  } finally { db.close(); }
}

/** 起一个 detached 持锁进程，并等它真的拿到锁（ready 文件就位）。 */
function startHolder(root: string, path: string, holdMs: number): { child: ChildProcess; readyFile: string } {
  const readyFile = join(root, `holder-ready-${holdMs}-${Date.now()}`);
  const child = spawn(process.execPath,
    ["--import", "tsx", "-e", holderScript(holdMs), path, readyFile],
    { cwd: projectRoot, detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 20_000;
  // 主进程**同步**等 ready（`Atomics.wait` 不阻塞持锁方自己的定时器，它在独立进程里）。
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(readyFile)) {
    if (Date.now() > deadline) throw new Error("持锁方没有就位（ready 文件未出现）");
    Atomics.wait(sleeper, 0, 0, 50);
  }
  return { child, readyFile };
}

/**
 * 杀掉持锁进程，并等它**真的放开 `rai.sqlite`** 再返回。
 *
 * 为什么不能只看 `child.exitCode`：持锁方是 `detached` + `unref()` 的，父进程不会收到它的
 * 退出通知，那个字段永远不会更新。而 Windows 上进程没退干净时 `rmSync` 会抛
 * `EBUSY: resource busy or locked`（实测踩到过）。
 * 所以这里**直接探资源**：能拿到写连接就说明锁已经放开。
 */
function killHolder(child: ChildProcess, path: string): void {
  try { child.kill("SIGKILL"); } catch { /* 可能已经自己退出了。 */ }
  const deadline = Date.now() + 10_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    let opened: DatabaseSync | null = null;
    try {
      opened = new DatabaseSync(path, { timeout: 100 });
      opened.exec("PRAGMA busy_timeout = 100");
      opened.prepare("SELECT 1").get();
    } catch { /* 还锁着。 */ } finally { try { opened?.close(); } catch { /* 忽略。 */ } }
    if (opened) return;
    Atomics.wait(sleeper, 0, 0, 25);
  }
}

/** 删除临时目录，容忍 Windows 上"句柄刚放开还没落盘"的瞬时 EBUSY（先例：import-worker 的 removeFileWithRetry）。 */
function removeRoot(root: string): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      if (attempt === 8) throw error;
      Atomics.wait(sleeper, 0, 0, 100 * attempt);
    }
  }
}

test("open() retries past a concurrent writer and reaches WAL once the lock is released", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-wal-retry-"));
  const path = join(root, "rai.sqlite");
  makeDeleteModeDatabase(path);

  // 2000 ms > 10 次重试中的单次窗口；并发跑全量时 tsx/子进程启动可能超过 600 ms，
  // 旧值会让“等待方启动时锁已经释放”造成假红（实测 148 ms）。这是测试夹具的
  // 启动开销，不是 RaiDatabase.open 的行为变化。
  const holder = startHolder(root, path, 2_000);
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "-e", OPENER_SCRIPT, path],
      { cwd: projectRoot, encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;

    // 关键判据：**没有**把锁竞争当成终态失败抛出去。
    assert.doesNotMatch(output, /THREW_MS/,
      `open() 在写锁被释放后仍然失败了 —— 有界重试没生效\n${output}`);
    const matched = /OPENED_MS=(\d+) MODE=wal/.exec(output);
    assert.ok(matched, `等待方没有报告成功切到 WAL：${output}`);
    // 它必须**真的等过**：立刻成功说明根本没去要独占锁（那是"库已 WAL"，前置条件已排除）。
    // 阈值刻意低于持锁窗口（2000 ms）：子进程的 tsx/import 启动开销会吃掉前一段时间。
    const waited = Number(matched[1]);
    assert.ok(waited >= 200,
      `open() 只用了 ${waited} ms —— 没有在锁上等过（期望跨过持锁窗口）`);
  } finally {
    killHolder(holder.child, path);
    removeRoot(root);
  }
});

test("open() gives up after the bounded window and rethrows the original lock error", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-wal-retry-exhausted-"));
  const path = join(root, "rai.sqlite");
  makeDeleteModeDatabase(path);

  // holdMs = 0 ⇒ 持锁方一直不松手，重试必然耗尽。
  const holder = startHolder(root, path, 0);
  try {
    const started = Date.now();
    const child = spawnSync(process.execPath, ["--import", "tsx", "-e", OPENER_SCRIPT, path],
      { cwd: projectRoot, encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
    const elapsed = Date.now() - started;
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;

    // 判据：仍然是**原始的** SQLite 错误，而不是自造文案 —— 那是运维唯一的线索。
    assert.match(output, /THREW_MS=\d+ MSG=database is locked/,
      `耗尽重试后必须原样上抛 database is locked：${output}`);
    assert.doesNotMatch(output, /OPENED_MS/, "写锁从未释放，open() 不可能成功");
    // 判据：不是无限等。耗时应当落在"有界窗口"附近，而不是子进程超时。
    assert.ok(elapsed < CHILD_TIMEOUT_MS,
      `open() 等待 ${elapsed} ms，接近子进程超时 —— 重试上限没生效`);
    assert.ok(elapsed >= RETRY_BUDGET_MS - 1_500,
      `open() 只等了 ${elapsed} ms 就放弃 —— 重试窗口太短，窄情形没被真正覆盖`);
  } finally {
    killHolder(holder.child, path);
    removeRoot(root);
  }
});
