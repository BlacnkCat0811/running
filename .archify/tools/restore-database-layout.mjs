import { readFileSync, writeFileSync } from "node:fs";

const path = ".archify/rai-audit-20261013-160439/architecture-database/candidate.json";
const doc = JSON.parse(readFileSync(path, "utf8"));

// Restore the authored positions/sizes from the revision that passed all four
// gates, and apply the single sublabel shortening that unblocked
// composition/desktop-readability (the previous blocker).
const layout = {
  main_facts: [40, 120],
  main_derived: [60, 420],
  main_publish: [80, 720],
  main_jobs: [100, 1020],
  import_write: [400, 120],
  req_write: [420, 420],
  analysis_write: [440, 720],
  read_path: [460, 1020],
  runtime_db: [760, 120],
  control_db: [780, 420],
  candidate_files: [800, 720],
  artifact_store: [820, 1020]
};

let moved = 0;
for (const c of doc.components) {
  const next = layout[c.id];
  if (!next) continue;
  c.pos = next;
  c.size = [220, 84];
  moved += 1;
}
const jobs = doc.components.find((c) => c.id === "main_jobs");
if (jobs) jobs.sublabel = "recompute_jobs · import_batches";

writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(`restored ${moved} component position(s); main_jobs.sublabel = ${jobs?.sublabel}`);
