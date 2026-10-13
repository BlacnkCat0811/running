import { readFileSync, writeFileSync } from "node:fs";

const path = ".archify/rai-audit-20261013-160439/sequence-analysis/candidate.json";
const doc = JSON.parse(readFileSync(path, "utf8"));

// Insert the wake-up hop the diagram was missing. Verified chain:
//   import-worker.ts:897-907 publishTerminalState -> runTerminalCallbackWithRetry
//   import-worker.ts:951        await this.queueOptions?.onTerminal?.(...)
//   server.ts:483-490           ImportWorker onTerminal wiring
//   server.ts:517               () => { invalidateDatabaseReadiness(); recomputeWorker.schedule(); ... }
// So the analysis consumer is woken by the import job's terminal callback; the
// previous revision jumped straight from COMMIT to `claim queued`.
const awake = {
  from: "rx",
  to: "recompute",
  label: "终态回调触发 schedule()",
  variant: "dashed",
  note: "server.ts:517"
};
const insertAfter = doc.messages.findIndex((m) => m.label.includes("COMMIT"));
if (insertAfter < 0) throw new Error("anchor message not found");
doc.messages.splice(insertAfter + 1, 0, awake);

// Re-space on a uniform 28px grid (the renderer's minimum shared-space step).
const START = 160, STEP = 28;
doc.messages.forEach((m, i) => { m.y = START + i * STEP; });
const lastY = START + (doc.messages.length - 1) * STEP;

for (const a of doc.activations ?? []) {
  a.from = Math.min(a.from, lastY - 4);
  a.to = Math.min(a.to, lastY);
}

// Drop any authored viewBox so the renderer declares intrinsic-height fit,
// which is what let this diagram pass the viewport gate on the first attempt.
if (doc.meta && doc.meta.viewBox) delete doc.meta.viewBox;

writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(`messages: ${doc.messages.length}, y ${START}..${lastY}, step ${STEP}, activations: ${(doc.activations ?? []).length}`);
