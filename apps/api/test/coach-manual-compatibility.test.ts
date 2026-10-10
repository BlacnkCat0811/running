import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RaiDatabase } from "@rai/storage-sqlite";
import { manualPlanWriteInput } from "../src/manual-plan-policy.js";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { RaiReadStore } from "../src/data.js";
import { buildCompleteEasyStructure } from "../src/coach-session-dose.js";
import { digest } from "../src/plan-digest.js";

test("manual writes cannot retain a heuristic provenance; settings-only writes retain their existing audit", () => {
  const input = { expectedRevision: 1, weekPlan: [{ localDate: "2026-10-08", kind: "easy" as const, distanceKm: 3 }],
    weekPlanAudit: { generatedBy: "heuristic" as const, model: null, promptVersion: null, generatedAt: null } };
  const original = digest(input);
  const result = manualPlanWriteInput(input, "2026-10-07T04:00:00Z");
  assert.equal(result.weekPlanAudit?.generatedBy, "manual");
  assert.equal(result.weekPlanAudit?.generatedAt, "2026-10-07T04:00:00Z");
  assert.equal(digest(input), original);
  const settings = { expectedRevision: 1, qualitySessionCap: 1 };
  assert.equal(manualPlanWriteInput(settings, "2026-10-07T04:00:00Z"), settings);
});

test("AC0-10 partial: explicit 20-minute manual structure is retained in storage and effective exports, not certified as automatic", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-coach-manual-short-"));
  const path = join(root, "rai.sqlite");
  (await RaiDatabase.open(path)).close();
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  try {
    const structure = buildCompleteEasyStructure("easy", null);
    structure.blocks[0]!.steps[0]!.goal = { type: "time", seconds: 600 };
    const input = { weekPlan: [{ localDate: "2026-10-07", kind: "easy" as const, distanceKm: 3.3, structure, reason: "manual short" }],
      weekPlanAudit: { generatedBy: "heuristic" as const, model: null, promptVersion: null, generatedAt: null } };
    const written = store.write(manualPlanWriteInput(input, "2026-10-07T04:00:00Z"));
    const original = digest(store.read());
    assert.equal(written.weekPlanAudit?.generatedBy, "manual");
    assert.deepEqual(written.weekPlan[0]?.structure, structure);
    const today = read.mobileToday(written);
    assert.equal(today.nextSession.kind, "easy");
    assert.equal(today.nextSession.durationMinutes, 20);
    assert.deepEqual(today.nextSession.structure, structure);
    const exported = read.mobileWorkoutPlan(written);
    assert.equal(exported.days[0]?.source, "manual");
    assert.equal(exported.days[0]?.executable, true);
    assert.equal(exported.days[0]?.durationMinutes, 20);
    assert.equal(digest(store.read()), original, "reading a manual exception never rewrites history or its audit");
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
