import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { auditTrainingPlanStateCopy } from "../apps/api/src/training-plan-state-audit.js";

try {
  const { values } = parseArgs({ options: { "control-db-copy": { type: "string" }, help: { type: "boolean" } }, strict: true });
  if (values.help) {
    process.stdout.write("Read-only A-01 audit of an independent, consistent SQLite control database copy.\nUsage: node --import tsx scripts/audit-training-plan-state.mts --control-db-copy /absolute/offline/control.sqlite\nExit 0: no conflicts/issues; 1: conflicts or incomplete audit. No apply mode.\n");
  } else if (!values["control-db-copy"]?.trim()) {
    process.stdout.write(`${JSON.stringify({ ok: false, issues: [{ code: "control_db_copy_required" }] })}\n`);
    process.exitCode = 1;
  } else {
    const report = auditTrainingPlanStateCopy(resolve(values["control-db-copy"]));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }
} catch {
  process.stdout.write(`${JSON.stringify({ ok: false, issues: [{ code: "invalid_arguments" }] })}\n`);
  process.exitCode = 1;
}
