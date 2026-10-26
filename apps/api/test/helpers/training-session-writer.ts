/** Isolated two-process CAS probe, launched only by the session-command test. */
import { randomUUID } from "node:crypto";
import { MobileGoalsStore } from "../../src/mobile-goals.js";
import { TrainingPlanSessionCommandService } from "../../src/training-plan-session-commands.js";
const [root, control, target] = process.argv.slice(2);
if (!root || !control || !target || !process.send) throw new Error("CAS probe requires an isolated parent process");
const identity = () => ({ serverId: "synthetic-server", athleteId: "synthetic-athlete", datasetEpoch: "synthetic-epoch" });
const key = JSON.stringify(Object.values(identity()));
const store = new MobileGoalsStore(root, control);
store.bindTrainingPlanOwner(identity, () => "2026-10-25");
const service = new TrainingPlanSessionCommandService(store, identity, () => "2026-10-25",
  () => ({ fingerprint: "facts-1", prescription: null, validate: () => {} }), () => Date.parse("2026-10-25T03:00:00.000Z"));
const row = store.currentTrainingPlan()!;
if (row.state.schemaVersion !== 2) throw new Error("schema 2 required");
const session = row.state.sessions[0]!;
const draft = { contractVersion: 1 as const, operationScope: identity(), expectedStateRevision: row.revision,
  planInstanceId: row.state.planInstanceId, draft: { action: "move" as const, sessionId: session.sessionId,
    sessionRevision: session.sessionRevision, localDate: target } };
const preview = service.preview(draft);
process.on("message", message => {
  if (message !== "commit") return;
  try { process.send!({ outcome: service.submit({ ...draft, candidateId: preview.candidateId, operationId: randomUUID() }).outcome }); }
  catch (error) { process.send!({ error: (error as { code?: string }).code ?? "unexpected" }); }
  finally { store.close(); process.disconnect?.(); }
});
process.send({ ready: true });
