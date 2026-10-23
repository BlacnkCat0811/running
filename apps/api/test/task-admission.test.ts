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

test("recovery blocks are token-bound, additive, and never clear permanent blocks", () => {
  const scheduler = new TaskAdmissionScheduler(new MutationCoordinator());
  const imports = scheduler.owner("import");
  const first = scheduler.beginRecoveryBlock("import_publication_recovery_required", "import");
  const again = scheduler.beginRecoveryBlock("import_publication_recovery_required", "import");
  assert.equal(again.token, first.token, "the same identity must return the same token");
  assert.equal(imports.acquire(), null);

  scheduler.blockUntilRestart("restore_recovery_required");
  assert.deepEqual(scheduler.activeBlocks().map((block) => block.kind), ["recovery", "permanent"]);
  assert.equal(scheduler.snapshot().blocked, "import_publication_recovery_required");
  assert.equal(scheduler.snapshot().blocks?.length, 2, "all active reasons stay observable");

  assert.equal(scheduler.resolveRecoveryBlock({ ...first, token: "forged" }), false,
    "a mismatched token must not clear anything");
  assert.equal(scheduler.isBlocked, true);
  assert.equal(scheduler.hasBlocksOtherThan([first]), true, "the permanent block is not part of the token");

  assert.equal(scheduler.resolveRecoveryBlock(first), true);
  assert.equal(scheduler.isBlocked, true, "resolving one block must not clear another");
  assert.equal(imports.acquire(), null);
  assert.equal(scheduler.resolveRecoveryBlock(first), false, "a resolved token is stale");

  const permanent = scheduler.activeBlocks()[0]!;
  assert.equal(permanent.kind, "permanent");
  assert.deepEqual(scheduler.snapshot().blocks, [permanent]);
});

test("resolving a recovery block wakes waiting owners so they re-evaluate", () => {
  const scheduler = new TaskAdmissionScheduler(new MutationCoordinator());
  const imports = scheduler.owner("import");
  const token = scheduler.beginRecoveryBlock("import_publication_recovery_required");
  let notifications = 0;
  imports.onChange?.(() => { notifications += 1; });
  assert.equal(imports.acquire(), null);
  assert.equal(notifications, 0, "a blocked acquire is not a state change");
  assert.equal(scheduler.resolveRecoveryBlock(token), true);
  assert.equal(notifications, 1, "availability rose: waiting owners must retry");
  const release = imports.acquire();
  assert.ok(release);
  release!();
});
