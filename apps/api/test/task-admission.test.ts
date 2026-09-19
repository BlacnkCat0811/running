import assert from "node:assert/strict";
import test from "node:test";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";

test("all heavy workers share the mutation lease, yield fairly, and withdraw on shutdown", () => {
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  const imports = scheduler.owner("import"), compute = scheduler.owner("compute"), training = scheduler.owner("training");
  const http = mutations.acquire("HTTP");
  assert.equal(imports.acquire(), null);
  assert.equal(compute.acquire(), null);
  http();
  assert.equal(compute.acquire(), null);
  const first = imports.acquire();
  assert.ok(first);
  assert.throws(() => mutations.acquire("override"), /写操作/);
  assert.equal(training.acquire(), null);
  first(); first();
  assert.equal(imports.acquire(), null);
  const second = compute.acquire();
  assert.ok(second);
  training.withdraw();
  second();
  const third = imports.acquire();
  assert.ok(third);
  third();
  assert.deepEqual(scheduler.snapshot(), { active: null, waiting: [] });
  scheduler.blockUntilRestart("recovery");
  assert.equal(imports.acquire(), null);
  assert.equal(scheduler.isBlocked, true);
  assert.equal(scheduler.snapshot().blocked, "recovery");
});

test("cancellation pins out a following import even after its compute worker exits", () => {
  const scheduler = new TaskAdmissionScheduler(new MutationCoordinator());
  const compute = scheduler.owner("recompute"), imports = scheduler.owner("import");
  const release = compute.acquire()!;
  const control = scheduler.acquireControl("recompute");
  assert.ok(control);
  assert.equal(scheduler.acquireControl("prediction"), null);
  release();
  assert.equal(imports.acquire(), null);
  assert.equal(scheduler.hasActiveControls, true);
  control(); control();
  const imported = imports.acquire();
  assert.ok(imported);
  imported();
});
