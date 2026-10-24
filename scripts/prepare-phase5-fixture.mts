/** Offline synthetic fixture; never accepts or reads a production database. */
import { mkdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { RaiDatabase } from "@rai/storage-sqlite";
import { MobileGoalsStore } from "../apps/api/src/mobile-goals.js";
import { coachLocalDate } from "../apps/api/src/coach-loop-facts.js";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || ![tmpdir(), "/tmp"].filter(existsSync).some(parent => realpathSync(root).startsWith(realpathSync(parent) + sep))) {
  throw new Error("Fixture requires a dedicated existing temporary directory");
}
mkdirSync(join(root, "var"), { recursive: true });
const database = join(root, "var/rai.sqlite");
const control = join(root, "var/rai-control.sqlite");
if (existsSync(database) || existsSync(control)) throw new Error("Fixture refuses to overwrite existing databases");
(await RaiDatabase.open(database)).close();
const date = coachLocalDate(new Date().toISOString());
const goals = new MobileGoalsStore(root, control);
try {
  goals.write({ weekPlan: [] }, { runCoach: { id: "synthetic-phase5", goal: "fitness", raceDate: null,
    raceDistanceKm: null, targetTimeSeconds: null, runningDays: [1,2,3,4,5,6,7], longRunDays: [7],
    targetType: "pace", strengthTraining: false, durationWeeks: 12, startedOn: date, status: "active",
    pausedOn: null, endedOn: null, adaptationKey: null, adaptedAt: null } });
} finally { goals.close(); }
const args = ["--import", "tsx", "scripts/migrate-training-planner.mts", "--control-db", control,
  "--server-id", "phase5-validation", "--athlete-id", "athlete_1", "--dataset-epoch", "phase5-synthetic", "--business-date", date];
const run = (extra: string[]) => {
  const result = spawnSync(process.execPath, [...args, ...extra], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  return JSON.parse(result.stdout);
};
const dryRun = run([]);
const applied = run(["--apply", "--expect-source-digest", dryRun.sourceDigest]);
const repeated = run(["--apply", "--expect-source-digest", dryRun.sourceDigest]);
process.stdout.write(JSON.stringify({ synthetic: true, database, control, dryRun, applied, repeated }, null, 2) + "\n");
