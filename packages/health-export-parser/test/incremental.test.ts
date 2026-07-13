import assert from "node:assert/strict";
import test from "node:test";

import { diffDataset, planRecompute } from "../src/incremental.js";

test("dataset fingerprints skip identical exports", () => {
  const fingerprint = { xmlSha256: "xml", routeBundleSha256: "routes" };
  assert.deepEqual(diffDataset(fingerprint, fingerprint), {
    status: "unchanged", xmlChanged: false, routesChanged: false
  });
});

test("workout-only changes produce a bounded partial plan", () => {
  assert.deepEqual(planRecompute([{
    entityKind: "workout", entityId: "session-2", changeType: "updated",
    effectiveAt: "2026-01-10T00:00:00.000Z"
  }]), {
    mode: "partial", dirtySessionIds: ["session-2"], dirtyFromAt: "2026-01-10T00:00:00.000Z",
    reasons: ["workout_or_route_change"]
  });
});

test("global recovery dependencies deliberately downgrade to full recompute", () => {
  const plan = planRecompute([{
    entityKind: "hrv", entityId: "hrv-1", changeType: "inserted",
    effectiveAt: "2026-01-08T00:00:00.000Z"
  }]);
  assert.equal(plan.mode, "full");
  assert.match(plan.reasons[0] ?? "", /global_dependency:hrv/);
});
