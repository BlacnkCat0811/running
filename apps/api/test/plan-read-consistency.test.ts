import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RaiDatabase } from "@rai/storage-sqlite";
import { RaiReadStore } from "../src/data.js";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { PlanOperationError } from "../src/plan-publication.js";
import {
  optionalPublicationGuard,
  planReadGuard,
  readSnapshotFileIdentity,
  readStableSnapshot,
  snapshotFileReplaced
} from "../src/plan-read-consistency.js";
import { PUBLICATION_GUARD_STALE_MS } from "../src/publication-guard.js";

type Control = { revision: number; settings: string | null };

const changedError = () => new PlanOperationError(
  "coach_snapshot_changed", "教练计划状态在读取期间变化，请重新读取。", 503);
const snapshot = (revision: number): Control => ({ revision, settings: revision > 0 ? "active" : null });

test("a stable control snapshot is read twice and built once", () => {
  let reads = 0, builds = 0;
  const built: Control[] = [];
  const result = readStableSnapshot<Control, number>({
    readControl: () => { reads += 1; return snapshot(7); },
    build: control => { builds += 1; built.push(control); return control.revision * 10; },
    changedError
  });
  assert.equal(result, 70, "the first build result is returned unchanged");
  assert.equal(reads, 2, "control is read before and after the build");
  assert.equal(builds, 1, "a stable snapshot is never rebuilt");
  assert.deepEqual(built.map(control => control.revision), [7]);
});

test("one control change retries against the newer snapshot and returns its build", () => {
  let reads = 0, builds = 0;
  const built: number[] = [];
  const result = readStableSnapshot<Control, number>({
    // Reads 1-2 expose the change: build 1 saw revision 1, the store already
    // holds revision 2. Reads 3-4 both see revision 2 and settle.
    readControl: () => { reads += 1; return snapshot(reads === 1 ? 1 : 2); },
    build: control => { builds += 1; built.push(control.revision); return control.revision * 10; },
    changedError
  });
  assert.equal(result, 20, "the result from the changed control snapshot is discarded");
  assert.deepEqual(built, [1, 2], "both the stale and the fresh snapshots were built");
  assert.equal(builds, 2);
  assert.equal(reads, 4, "each attempt reads control before and after its build");
});

test("a control that keeps changing fails closed after three attempts", () => {
  let reads = 0, builds = 0;
  let thrown: unknown;
  try {
    readStableSnapshot<Control, number>({
      readControl: () => { reads += 1; return snapshot(reads); },
      build: control => { builds += 1; return control.revision; },
      changedError
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(builds, 3, "the default attempt budget is three builds");
  assert.equal(reads, 6);
  assert.ok(thrown instanceof PlanOperationError);
  assert.equal(thrown.code, "coach_snapshot_changed");
  assert.equal(thrown.statusCode, 503, "the client sees a retryable service unavailable");
});

test("attempts: 1 builds once and throws without a second attempt", () => {
  let reads = 0, builds = 0;
  assert.throws(() => readStableSnapshot<Control, number>({
    readControl: () => { reads += 1; return snapshot(reads); },
    build: control => { builds += 1; return control.revision; },
    changedError,
    attempts: 1
  }), PlanOperationError);
  assert.equal(builds, 1);
  assert.equal(reads, 2, "a single attempt still reads control twice");
});

test("the attempt budget is clamped to 1..5", () => {
  const buildsFor = (attempts: number): number => {
    let reads = 0, builds = 0;
    assert.throws(() => readStableSnapshot<Control, number>({
      readControl: () => { reads += 1; return snapshot(reads); },
      build: () => { builds += 1; return builds; },
      changedError,
      attempts
    }), PlanOperationError);
    return builds;
  };
  assert.equal(buildsFor(0), 1);
  assert.equal(buildsFor(-4), 1);
  assert.equal(buildsFor(99), 5);
});

// ---------------------------------------------------------------------------
// 跨库 publication guard 读侧（批次 B）：epoch / pending / stale / 降级
// ---------------------------------------------------------------------------

const stableGuard = () => ({ epoch: 3, pendingSince: null });
const stalePending = (nowMs: number) => ({
  epoch: 3,
  pendingSince: new Date(nowMs - PUBLICATION_GUARD_STALE_MS - 1_000).toISOString()
});
const freshPending = (nowMs: number) => ({
  epoch: 3,
  pendingSince: new Date(nowMs - 1_000).toISOString()
});

test("G: a publication that starts during the build discards the attempt and rebuilds", () => {
  const now = 1_800_000_000_000;
  const guards = [stableGuard(), { epoch: 4, pendingSince: null }, { epoch: 4, pendingSince: null }, { epoch: 4, pendingSince: null }];
  let guardReads = 0, builds = 0;
  const result = readStableSnapshot<Control, number>({
    readControl: () => snapshot(2),
    build: control => { builds += 1; return control.revision * 10; },
    changedError,
    readGuard: () => guards[Math.min(guardReads++, guards.length - 1)]!,
    now: () => now
  });
  assert.equal(result, 20, "the attempt built against the pre-publication control state is not returned");
  assert.equal(builds, 2, "the changed epoch forced exactly one rebuild");
  assert.equal(guardReads, 4, "each attempt reads the guard before and after its build");
});

test("G: a live publication marker blocks the build and fails closed after three attempts", () => {
  const now = 1_800_000_000_000;
  let builds = 0, controlReads = 0;
  assert.throws(() => readStableSnapshot<Control, number>({
    readControl: () => { controlReads += 1; return snapshot(2); },
    build: control => { builds += 1; return control.revision; },
    changedError,
    readGuard: () => freshPending(now),
    now: () => now
  }), (error: unknown) => error instanceof PlanOperationError && error.code === "coach_snapshot_changed" && error.statusCode === 503);
  assert.equal(builds, 0, "a visible publication must not spend a build");
  assert.equal(controlReads, 0, "the control snapshot is not even read while a live publication is pending");
});

test("G: a stale pending marker left by a crashed publisher no longer blocks reads", () => {
  const now = 1_800_000_000_000;
  let builds = 0;
  const result = readStableSnapshot<Control, number>({
    readControl: () => snapshot(5),
    build: control => { builds += 1; return control.revision; },
    changedError,
    readGuard: () => stalePending(now),
    now: () => now
  });
  assert.equal(result, 5);
  assert.equal(builds, 1, `a pending marker older than ${PUBLICATION_GUARD_STALE_MS} ms is a lease, not a lock`);
});

test("P3-02: an unreadable guard fails closed instead of silently disabling the cross-store check", () => {
  let reads = 0, builds = 0, guardReads = 0;
  assert.throws(() => readStableSnapshot<Control, number>({
    readControl: () => { reads += 1; return snapshot(4); },
    build: control => { builds += 1; return control.revision; },
    changedError,
    readGuard: () => { guardReads += 1; throw new Error("guard table unreadable"); }
  }), (error: unknown) => error instanceof PlanOperationError &&
    error.code === "coach_snapshot_changed" && error.statusCode === 503);
  assert.equal(guardReads, 3, "the guard is retried once per attempt before failing closed");
  assert.equal(builds, 0, "no build is spent without a provably stable snapshot");
  assert.equal(reads, 0, "the control snapshot is not even read when the guard cannot be read");
});

test("P3-02: a guard that starts failing after the build also fails closed", () => {
  const stable = { epoch: 1, pendingSince: null };
  let guardReads = 0, builds = 0;
  assert.throws(() => readStableSnapshot<Control, number>({
    readControl: () => snapshot(4),
    build: control => { builds += 1; return control.revision; },
    changedError,
    // The first read (before the build) succeeds; every later one throws.
    readGuard: () => { guardReads += 1; if (guardReads === 1) return stable; throw new Error("guard vanished"); }
  }), PlanOperationError);
  // Attempt 1 read the guard before (ok) and after the build (throws); attempts
  // 2 and 3 fail on the before-read. One build total, then fail closed.
  assert.equal(builds, 1, "only the first attempt spent a build");
  assert.equal(guardReads, 4, "two reads in the first attempt, one per retry");
});

test("P3-02: a store without any guard still degrades to the digest-only check", () => {
  let reads = 0, builds = 0;
  const result = readStableSnapshot<Control, number>({
    readControl: () => { reads += 1; return snapshot(4); },
    build: control => { builds += 1; return control.revision; },
    changedError
  });
  assert.equal(result, 4);
  assert.equal(builds, 1);
  assert.equal(reads, 2, "absent guard support is the documented pre-guard fallback");
});

test("G: optionalPublicationGuard binds a store method and is absent when unsupported", () => {
  const state = { epoch: 9, pendingSince: null };
  assert.equal(optionalPublicationGuard({}), undefined, "a store without the method must not crash the read path");
  const read = optionalPublicationGuard({ publicationGuardState: () => state });
  assert.ok(read);
  assert.equal(read!(), state);
});

test("read amplification: one successful attempt reads control twice and digests twice", () => {
  let controlReads = 0;
  let enumerations = 0;
  const counted = (): Control => ({
    get revision(): number { enumerations += 1; return 7; },
    settings: "active"
  });
  const result = readStableSnapshot<Control, number>({
    readControl: () => { controlReads += 1; return counted(); },
    build: () => 70,
    changedError
  });
  assert.equal(result, 70);
  assert.equal(controlReads, 2, "one pair per attempt: before-digest + after-digest");
  assert.equal(enumerations, 2, "exactly two control digests per successful attempt");
});

// ---------------------------------------------------------------------------
// P2-5：文件身份统计的分类（transient → null 重试；其他错误照常上抛）
// ---------------------------------------------------------------------------

test("P2-5: a transient file identity read returns null instead of throwing into the 500 handler", () => {
  assert.equal(readSnapshotFileIdentity(join(tmpdir(), `rai-missing-${randomUUID()}.sqlite`)), null);
  const root = mkdtempSync(join(tmpdir(), "rai-file-identity-"));
  try {
    const path = join(root, "facts.sqlite");
    writeFileSync(path, "not-a-database");
    const identity = readSnapshotFileIdentity(path);
    assert.ok(identity && Number.isFinite(identity.ino) && Number.isFinite(identity.mtimeMs));
    assert.throws(() => readSnapshotFileIdentity(join(path, "child.sqlite")), (error: NodeJS.ErrnoException) => error.code === "ENOTDIR",
      "a non-transient fs error is a programming/deployment fault and must still fail loudly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P2-02: only an inode change counts as a replaced database file", () => {
  const before = { ino: 42, mtimeMs: 1_000 };
  assert.equal(snapshotFileReplaced(before, { ino: 42, mtimeMs: 9_999 }), false,
    "a WAL checkpoint moves mtime without replacing the file — not a publication");
  assert.equal(snapshotFileReplaced(before, { ino: 43, mtimeMs: 9_999 }), true,
    "a rename/import publication lands on a new inode");
});

// ---------------------------------------------------------------------------
// 微基准：200 次 readStableSnapshot + guard，p50/p95 记录给修复记录
// ---------------------------------------------------------------------------

test("benchmark: 200 guarded stable-snapshot reads stay under the 50ms p95 budget", t => {
  const now = 1_800_000_000_000;
  const samples: number[] = [];
  const guard = () => ({ epoch: 1, pendingSince: null });
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now();
    const value = readStableSnapshot<Control, number>({
      readControl: () => snapshot(index % 7),
      build: control => control.revision * 2,
      changedError,
      readGuard: guard,
      now: () => now
    });
    assert.equal(value, (index % 7) * 2);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p50 = samples[Math.floor(samples.length * 0.5)]!;
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  t.diagnostic(`readStableSnapshot p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms (n=200)`);
  assert.ok(p95 < 50, `p95 ${p95.toFixed(3)}ms must stay below 50ms`);
});


// ---------------------------------------------------------------------------
// trainingPlanState 成功路径的读放大（批次 C）：control 只读 2 对，control digest 2 次
// ---------------------------------------------------------------------------

test("trainingPlanState reads one control pair before and one after the build", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-read-amplification-"));
  const path = join(root, "facts.sqlite");
  const database = await RaiDatabase.open(path);
  const store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const read = new RaiReadStore(path);
  const calls: string[] = [];
  const counted = {
    read: (options?: Parameters<MobileGoalsStore["read"]>[0]) => {
      calls.push("goals");
      return store.read(options);
    },
    planHistory: (limit?: number) => {
      calls.push("history");
      return store.planHistory(limit);
    }
  };
  try {
    const state = read.trainingPlanState(counted as unknown as MobileGoalsStore,
      () => ({ serverId: "s", athleteId: "a", datasetEpoch: "e" }));
    assert.equal(state.metadata.goalsRevision, state.goals.revision);
    assert.deepEqual(calls, ["goals", "history", "goals", "history"],
      "exactly two control pairs per successful attempt (4 queries)");
    // Digest count is structural: the control pair is hashed before and after.
    const source = readFileSync(join(import.meta.dirname, "../src/data.ts"), "utf8");
    const method = /trainingPlanState\(store[\s\S]*?\n  mobileToday\(/.exec(source)?.[0] ?? "";
    assert.equal((method.match(/digest\(\{ goals/g) ?? []).length, 2,
      "control digests must stay at two per attempt; identity is compared field by field");
  } finally {
    read.close();
    store.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3-03: planReadGuard never disables itself, even inside the store's own publication", () => {
  // `publicationGuardState()` already hides the store's own marker while keeping
  // the epoch. A reader that suppressed the guard inside the transaction would
  // additionally lose foreign-epoch detection, which is strictly weaker.
  let inFlight = true;
  const base = {
    publicationGuardState: () => inFlight
      // What MobileGoalsStore returns inside its own transaction: own pending
      // hidden, epoch preserved.
      ? { epoch: 7, pendingSince: null }
      : { epoch: 7, pendingSince: new Date().toISOString() }
  };
  const read = planReadGuard(base);
  assert.ok(read, "the guard is honored while the store publishes");
  // A foreign publication that starts during the build is still detected: the
  // hidden own-marker does not hide the epoch move.
  const guards = [
    { epoch: 7, pendingSince: null },
    { epoch: 8, pendingSince: null },
    { epoch: 8, pendingSince: null },
    { epoch: 8, pendingSince: null }
  ];
  let guardReads = 0, builds = 0;
  const result = readStableSnapshot<Control, number>({
    readControl: () => snapshot(3),
    build: control => { builds += 1; return control.revision * 10; },
    changedError,
    readGuard: () => guards[Math.min(guardReads++, guards.length - 1)]!
  });
  assert.equal(result, 30);
  assert.equal(builds, 2, "the foreign epoch change forced one rebuild instead of being ignored");
  inFlight = false;
  assert.ok(planReadGuard(base));
  // A store without the method still has no guard.
  assert.equal(planReadGuard({}), undefined);
});


// ---------------------------------------------------------------------------
// P3-14：启动时清掉崩溃发布者遗留的 pending marker
// ---------------------------------------------------------------------------

test("P3-14: a pending marker left by a killed publisher is cleared when the store opens, epoch preserved", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-guard-startup-"));
  const controlPath = join(root, "control.sqlite");
  try {
    const first = new MobileGoalsStore(root, controlPath);
    first.close();
    // Simulate the state after SIGKILL between `beginPublicationMarker` and the
    // business transaction: epoch committed, pending marker not cleared.
    const marker = new DatabaseSync(controlPath);
    try {
      marker.prepare("UPDATE mobile_publication_guard SET epoch = 11, pending_since = ? WHERE id = 1")
        .run(new Date().toISOString());
    } finally { marker.close(); }
    const reopened = new MobileGoalsStore(root, controlPath);
    try {
      assert.deepEqual(reopened.publicationGuardState(), { epoch: 11, pendingSince: null },
        "a marker from a dead process is not a live publication; the epoch must survive for readers");
    } finally { reopened.close(); }
    // Re-opening again is a no-op (idempotent startup path).
    const again = new MobileGoalsStore(root, controlPath);
    try { assert.deepEqual(again.publicationGuardState(), { epoch: 11, pendingSince: null }); }
    finally { again.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P3-15：同步重试的成本上限（不含 sleep 的既定取舍）
// ---------------------------------------------------------------------------

test("P3-15: a publication that keeps changing bounds the cost to attempts x build", t => {
  // The retry loop deliberately does not sleep between attempts (see the
  // `readStableSnapshot` docstring). The contract callers rely on is the cost
  // ceiling: at most `attempts` builds, and the whole call stays a small,
  // synchronous span.
  const now = 1_800_000_000_000;
  for (const attempts of [1, 3, 5]) {
    let epoch = 1, builds = 0, guardReads = 0;
    const started = performance.now();
    assert.throws(() => readStableSnapshot<Control, number>({
      readControl: () => snapshot(2),
      build: control => { builds += 1; return control.revision; },
      changedError,
      // Every guard read reports a new epoch: no attempt can be proven stable.
      readGuard: () => { guardReads += 1; epoch += 1; return { epoch, pendingSince: null }; },
      now: () => now,
      attempts
    }), PlanOperationError);
    const elapsedMs = performance.now() - started;
    assert.equal(builds, attempts, `attempts=${attempts}: one build per attempt, never more`);
    assert.equal(guardReads, attempts * 2, `attempts=${attempts}: guard read pair per attempt`);
    assert.ok(elapsedMs < 500, `attempts=${attempts}: synchronous retry budget stayed ${elapsedMs.toFixed(1)}ms`);
    if (attempts === 3) t.diagnostic(`3-attempt fail-closed span: ${elapsedMs.toFixed(3)}ms (no sleep by design)`);
  }
});
