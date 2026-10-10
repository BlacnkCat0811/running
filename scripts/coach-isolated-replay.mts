import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { backup } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { RaiDatabase } from "../packages/storage-sqlite/src/database.js";
import { RaiReadStore } from "../apps/api/src/data.js";
import { MobileGoalsStore } from "../apps/api/src/mobile-goals.js";
import { CoachLoopRuntime, COACH_RUNTIME_POLICY_HASH } from "../apps/api/src/coach-loop-runtime.js";
import { assessSessionDose } from "../apps/api/src/coach-session-dose.js";
import { digest } from "../apps/api/src/plan-digest.js";
import { coachReplaySourceIdentity } from "./coach-replay-provenance.mjs";
import { runtimeReplaySettings } from "./coach-runtime-fixtures.mjs";

async function fileHash(path: string) {
  if (!existsSync(path)) return null;
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

/** Explicit target only; backup from a read-only SQLite connection, including
 * committed WAL state. All migrations/commands target a disposable copy.
 * Output contains hashes/counts, never raw health facts or workout identifiers. */
export async function isolatedCoachReplay(sourcePath: string, outputPath: string) {
  const source = resolve(sourcePath), before = [await fileHash(source), await fileHash(`${source}-wal`)];
  if (!before[0]) throw new Error("An existing explicit source database is required");
  const temporary = mkdtempSync(join(tmpdir(), "rai-coach-isolated-"));
  let read: RaiReadStore | null = null;
  try {
    const path = join(temporary, "main.sqlite"), sourceConnection = RaiDatabase.openReadonly(source);
    try { await backup(sourceConnection, path); } finally { sourceConnection.close(); }
    const pending = RaiDatabase.pendingMigrations(path);
    (await RaiDatabase.open(path, { migrationPolicy: "apply", createMigrationBackup: false })).close();
    read = new RaiReadStore(path);
    const scope = { serverId: "isolated-replay", athleteId: "isolated-athlete", datasetEpoch: "isolated-copy" };
    const probe = new MobileGoalsStore(join(temporary, "probe"), join(temporary, "probe.sqlite"));
    const asOf = new Date().toISOString();
    let facts: ReturnType<RaiReadStore["coachLoopFacts"]>;
    try { facts = read.coachLoopFacts(probe.read(), [], scope, asOf); } finally { probe.close(); }
    const rounds = [1, 2].map(round => {
      const store = new MobileGoalsStore(join(temporary, `round-${round}`), join(temporary, `control-${round}.sqlite`));
      const runtime = new CoachLoopRuntime(store, () => scope, () => structuredClone(facts));
      try {
        const command = { contractVersion: 1 as const, operationId: "12000000-0000-4000-8000-000000000001",
          operationScope: scope, expectedRevision: 0, expectedFactsHash: facts.factsHash,
          action: "enable" as const, settings: runtimeReplaySettings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH };
        const started = performance.now(), published = runtime.command(command), elapsedMs = performance.now() - started;
        assert.deepEqual(runtime.command(command), published, "isolated real-facts operation must be idempotent");
        const revision = store.read().revision;
        let getMs = 0;
        for (let i = 0; i < 10; i++) {
          const start = performance.now(), current = runtime.read(); getMs += performance.now() - start;
          for (const day of current.days.filter(row => row.executable)) {
            const dose = assessSessionDose({ kind: day.day.kind, structure: day.day.structure ?? null,
              zones: facts.inputs.prescription, allowColdStartEstimate: true });
            assert.equal(dose.status, "feasible", "AC0-06 isolated final dose");
            assert.ok(dose.durationSeconds!.lower >= 1800);
          }
        }
        assert.equal(store.read().revision, revision, "real-facts GET must not write goals");
        const refreshed = runtime.command({ ...command, operationId: "12000000-0000-4000-8000-000000000002",
          action: "refresh", expectedRevision: revision });
        assert.equal(refreshed.revision, revision, "AC3-01 real-facts unchanged refresh");
        return { round, elapsedMs, meanGetMs: getMs / 10,
          outputHash: digest({ days: published.days, volume: published.volumePolicy, revision: published.revision }),
          executableCount: published.days.filter(row => row.executable).length };
      } finally { store.close(); }
    });
    assert.equal(rounds[0]!.outputHash, rounds[1]!.outputHash);
    const after = [await fileHash(source), await fileHash(`${source}-wal`)];
    assert.deepEqual(after, before, "source DB/WAL changed; cannot certify isolation");
    const report = { schemaVersion: 1, purpose: "behavior_reliability_not_training_effect", ...coachReplaySourceIdentity(),
      status: "passed", scope: "read_only_real_facts_disposable_control_not_user_plan",
      replayMode: "frozen_current_projection_not_historical_as_known_then",
      sourceDatabaseHash: before[0], sourceWalHash: before[1], sourceUnchanged: true,
      migratedCopyVersions: pending.map(row => row.version), factsHash: facts.factsHash,
      asOf, workoutCount: facts.facts.length, rounds,
      limitations: ["fresh_isolated_coach_config_not_existing_user_plan_or_device_schedule", "no_deployment_or_live_migration",
        "single_current_snapshot_not_longitudinal_as_known_then_or_training_effect"] };
    const output = resolve(outputPath); mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify({ ...report, reportHash: digest(report) }, null, 2)}\n`);
    console.log(`Isolated real-facts replay passed; source unchanged, disposable copies removed. ${output}`);
    return report;
  } finally { read?.close(); rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { database: { type: "string" }, output: { type: "string" } } });
  if (!values.database || !values.output) throw new Error("Usage: data:coach-isolated-replay --database PATH --output PATH");
  await isolatedCoachReplay(values.database, values.output);
}
