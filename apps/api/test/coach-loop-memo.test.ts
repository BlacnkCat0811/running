import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import {
  COACH_LOOP_MEMO_TTL_MS,
  CoachLoopMemo,
  coachLoopKeyMatches,
  type CoachLoopMemoKey
} from "../src/coach-loop-memo.js";
import {
  COACH_RUNTIME_POLICY_HASH,
  CoachLoopRuntime,
  type CoachRuntimeFacts
} from "../src/coach-loop-runtime.js";
import { registerCoachLoopRoutes } from "../src/coach-loop-routes.js";
import type { SnapshotGuardRead } from "../src/plan-read-consistency.js";
import type { MobileGoalsStore } from "../src/mobile-goals.js";
import {
  coachRuntimeFixture,
  runtimeReplayScope as scope,
  runtimeReplaySettings as settings
} from "../../../scripts/coach-runtime-fixtures.mjs";

const absent: SnapshotGuardRead = { kind: "absent" };
const ready = (epoch: number, pendingSince: string | null = null): SnapshotGuardRead => ({
  kind: "ready", state: { epoch, pendingSince }
});
const failed: SnapshotGuardRead = { kind: "failed" };
const memoKey = (overrides: Partial<CoachLoopMemoKey> = {}): CoachLoopMemoKey => ({
  scope: "scope-a",
  controlDigest: "digest-a",
  mainDataVersion: "ino1:7",
  localDate: "2026-10-18",
  guard: absent,
  ...overrides
});

test("memo key: every field is load-bearing, guard failures never match", () => {
  const base = memoKey();
  assert.equal(coachLoopKeyMatches(base, memoKey()), true);
  for (const changed of [
    memoKey({ scope: "scope-b" }),
    memoKey({ controlDigest: "digest-b" }),
    memoKey({ mainDataVersion: "ino1:8" }),
    memoKey({ localDate: "2026-10-19" }),
    memoKey({ guard: ready(0) }),
    { ...base, guard: failed }
  ]) assert.equal(coachLoopKeyMatches(base, changed), false, JSON.stringify(changed));

  // guard ready 之间：同 epoch 才命中；epoch 变化或 pending 都必须重算。
  assert.equal(coachLoopKeyMatches(memoKey({ guard: ready(3) }), memoKey({ guard: ready(3) })), true);
  assert.equal(coachLoopKeyMatches(memoKey({ guard: ready(3) }), memoKey({ guard: ready(4) })), false);
  const now = Date.parse("2026-10-18T08:00:00.000Z");
  assert.equal(
    coachLoopKeyMatches(memoKey({ guard: ready(3) }), memoKey({ guard: ready(3, new Date(now).toISOString()) }), now),
    false,
    "发布进行中（pending）时不得命中"
  );
  assert.equal(coachLoopKeyMatches(memoKey({ guard: failed }), memoKey({ guard: failed })), false);
  assert.equal(coachLoopKeyMatches(memoKey({ guard: absent }), memoKey({ guard: ready(0) })), false);
});

test("memo class: TTL expiry and key changes invalidate; constant is 1s", () => {
  assert.equal(COACH_LOOP_MEMO_TTL_MS, 1_000);
  let now = 1_000;
  const memo = new CoachLoopMemo<string>(COACH_LOOP_MEMO_TTL_MS, () => now);
  memo.set(memoKey(), "value");
  assert.equal(memo.get(memoKey()), "value");
  now += 1_000;
  assert.equal(memo.get(memoKey()), "value", "TTL 边界（age == ttl）仍命中");
  now += 1;
  assert.equal(memo.get(memoKey()), undefined, "过期后失效");
  memo.set(memoKey(), "fresh");
  assert.equal(memo.get(memoKey({ mainDataVersion: "ino1:9" })), undefined);
  memo.clear();
  assert.equal(memo.get(memoKey()), undefined);
});

/**
 * 真实 control store + 冻结 facts 的 memo 集成探针：facts 读取次数就是"是否重算"的
 * 可观测判据（读一次 ~1.3 s 的那部分）。
 */
function memoizedRuntime() {
  const fixture = coachRuntimeFixture();
  let version = "ino1:1";
  let nowMs = Date.parse("2026-10-08T08:00:00.000Z");
  let factsReads = 0;
  const runtime = new CoachLoopRuntime(
    fixture.store,
    () => scope,
    () => { factsReads += 1; return fixture.facts as CoachRuntimeFacts; },
    () => true,
    { mainDataVersion: () => version, now: () => nowMs }
  );
  return {
    fixture,
    runtime,
    factsReads: () => factsReads,
    bumpVersion: (next: string) => { version = next; },
    advance: (ms: number) => { nowMs += ms; }
  };
}

test("readCached reuses one stable snapshot within the TTL, read() always recomputes", () => {
  const probe = memoizedRuntime();
  try {
    const first = probe.runtime.readCached();
    const second = probe.runtime.readCached();
    assert.equal(probe.factsReads(), 1, "TTL 内相同指纹只读一次 facts");
    assert.equal(second, first, "命中返回同一个稳定快照");
    probe.runtime.readCached();
    assert.equal(probe.factsReads(), 1);

    probe.runtime.read();
    assert.equal(probe.factsReads(), 2, "内部控制流 read() 不得复用缓存");

    probe.advance(COACH_LOOP_MEMO_TTL_MS + 1);
    probe.runtime.readCached();
    assert.equal(probe.factsReads(), 3, "TTL 过期重算");
  } finally {
    probe.fixture.close();
  }
});

test("readCached invalidates immediately on main data_version and control writes", () => {
  const probe = memoizedRuntime();
  try {
    probe.runtime.readCached();
    assert.equal(probe.factsReads(), 1);

    // 主库外部写（导入/直连增量/换文件）→ 指纹变化，立即重算。
    probe.bumpVersion("ino2:1");
    probe.runtime.readCached();
    assert.equal(probe.factsReads(), 2);

    // 控制库写（启用教练模式走真实 publication）→ control digest 变化，立即重算。
    probe.fixture.runtime.command(probe.fixture.command("enable", {
      settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH
    }));
    const afterWrite = probe.runtime.readCached();
    assert.equal(probe.factsReads(), 3);
    assert.notEqual(afterWrite.settings, null, "控制库写后的响应必须反映新状态");
  } finally {
    probe.fixture.close();
  }
});

test("readCached does not reuse a snapshot after the identity scope changes", () => {
  const fixture = coachRuntimeFixture();
  try {
    let currentScope = scope;
    let reads = 0;
    const runtime = new CoachLoopRuntime(
      fixture.store, () => currentScope,
      () => { reads += 1; return fixture.facts as CoachRuntimeFacts; }, () => true,
      { mainDataVersion: () => "ino1:1", now: () => Date.parse("2026-10-08T08:00:00.000Z") }
    );
    runtime.readCached();
    runtime.readCached();
    assert.equal(reads, 1);

    // 删库/恢复/换身份都会换 datasetEpoch：旧 memo 不得复用。
    currentScope = { ...scope, datasetEpoch: "replaced-epoch" };
    runtime.readCached();
    assert.equal(reads, 2, "scope 变化后必须重算");
  } finally {
    fixture.close();
  }
});

test("readCached fails closed while a publication guard is pending", () => {
  const fixture = coachRuntimeFixture();
  try {
    const pendingStore = new Proxy(fixture.store, {
      get(target, property): unknown {
        if (property === "publicationGuardState") {
          return () => ({ epoch: 7, pendingSince: new Date().toISOString() });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    }) as unknown as MobileGoalsStore;
    const runtime = new CoachLoopRuntime(pendingStore, () => scope,
      () => fixture.facts as CoachRuntimeFacts, () => true,
      { mainDataVersion: () => "ino1:1" });
    assert.throws(() => runtime.readCached(), /教练计划状态在读取期间变化/,
      "发布进行中必须按既有语义 fail closed，而不是返回缓存");
  } finally {
    fixture.close();
  }
});

test("without a data_version provider readCached degrades to read()", () => {
  const fixture = coachRuntimeFixture();
  try {
    let reads = 0;
    const runtime = new CoachLoopRuntime(fixture.store, () => scope,
      () => { reads += 1; return fixture.facts as CoachRuntimeFacts; });
    runtime.readCached();
    runtime.readCached();
    assert.equal(reads, 2, "给不出失效判据时不得缓存");
  } finally {
    fixture.close();
  }
});

test("GET /v1/mobile/coach-loop actually serves the memoized snapshot", async () => {
  const fixture = coachRuntimeFixture();
  let version = "ino1:1";
  let reads = 0;
  const runtime = new CoachLoopRuntime(fixture.store, () => scope,
    () => { reads += 1; return fixture.facts as CoachRuntimeFacts; }, () => true,
    { mainDataVersion: () => version });
  const app = Fastify();
  registerCoachLoopRoutes({
    app, runtime, identity: () => scope,
    openMainDatabase: async () => { throw new Error("GET must not open the writer"); }
  });
  try {
    const first = await app.inject({ method: "GET", url: "/v1/mobile/coach-loop" });
    const second = await app.inject({ method: "GET", url: "/v1/mobile/coach-loop" });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.headers["cache-control"], "no-store");
    assert.equal(reads, 1, "相同指纹的第二条 GET 命中 memo");
    assert.deepEqual(second.json(), first.json());

    version = "ino2:9";
    const third = await app.inject({ method: "GET", url: "/v1/mobile/coach-loop" });
    assert.equal(third.statusCode, 200);
    assert.equal(reads, 2, "主库指纹变化后立即重算");
  } finally {
    await app.close();
    fixture.close();
  }
});
