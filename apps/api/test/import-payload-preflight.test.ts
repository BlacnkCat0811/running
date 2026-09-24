import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION } from "@rai/contracts";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

import {
  IMPORT_PAYLOAD_ANCHOR_KEY,
  computeImportPayloadSha256,
  importPayloadSha256,
  readDatabaseImportIdentity
} from "../src/import-payload-identity.js";
import { ImportWorker } from "../src/worker.js";

/**
 * The pre-flight short-circuit answers "did this payload change anything?" from
 * the payload alone, before the import pays for an O(database) backup, staging
 * copy, parse and diff. These tests pin both halves: that the identity is
 * sensitive to everything that changes what an import writes, and that every
 * guard which makes a short-circuit unsound actually disables it.
 */

interface PreflightSurface {
  executionEngine: { name: string; version: string; fallback: "none" | "typescript" };
  run(job: Record<string, unknown>): Promise<void>;
  command(args: string[]): Promise<void>;
  detectUnchangedPayload(
    job: Record<string, unknown>,
    engine: { name: string; version: string; fallback: "none" | "typescript" }
  ): Promise<{ sha256: string; datasetVersion: string; unchangedWorkouts: number } | null>;
}

const BASE_CONTEXT = {
  preserveAbsent: true,
  contractVersion: CONTRACT_VERSION,
  engine: "typescript"
};

/** Two exports of the same data differ only by the exporter's wall clock. */
function exportXml(exportDate: string, extra = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
 <ExportDate value="${exportDate}"/>
${extra} <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="142" startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:00:01 +0800"/>
</HealthData>`;
}

function writeExport(root: string, xml: string): string {
  const inputPath = join(root, "export");
  mkdirSync(inputPath, { recursive: true });
  writeFileSync(join(inputPath, "export.xml"), xml, "utf8");
  return inputPath;
}

async function seedDatabase(path: string): Promise<void> {
  const store = await RaiDatabase.open(path);
  try {
    store.database
      .prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES ('dataset_version', ?)")
      .run("preflight_fixture");
    for (let index = 0; index < 3; index += 1) {
      const workoutId = `preflight_workout_${index}`;
      const startedAt = new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
      const endedAt = new Date(Date.parse(startedAt) + 1_800_000).toISOString();
      store.database.prepare(`
        INSERT INTO workouts (
          id, activity_type, source_name, source_category, start_at, end_at,
          duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical
        ) VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture', 'apple_watch', ?, ?, 1800, 0, '{}', '{}', 1)
      `).run(workoutId, startedAt, endedAt);
      store.database.prepare(`
        INSERT INTO training_sessions (
          id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
          canonical_workout_id, status
        ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 5, ?, 'active')
      `).run(`preflight_session_${index}`, startedAt, endedAt, workoutId);
    }
  } finally {
    store.close();
  }
}

function queuedJob(inputPath: string, preserveAbsent: boolean): Record<string, unknown> {
  return {
    id: `web_import_preflight_${Math.random().toString(36).slice(2)}`,
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath,
    ...(preserveAbsent ? { preserveAbsent: true } : {})
  };
}

const stageNames = (job: Record<string, unknown>): string[] =>
  Object.keys((job.performance as { stagesMs: Record<string, number> } | undefined)?.stagesMs ?? {});

const anchorOf = (databasePath: string): unknown => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM import_manifest WHERE key = ?")
      .get(IMPORT_PAYLOAD_ANCHOR_KEY) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } finally {
    database.close();
  }
};

test("payload identity moves with every input that changes what an import writes", () => {
  const baseline = importPayloadSha256("content-a", BASE_CONTEXT);
  assert.equal(importPayloadSha256("content-a", BASE_CONTEXT), baseline, "same inputs must reproduce it");
  assert.notEqual(importPayloadSha256("content-b", BASE_CONTEXT), baseline, "payload content");
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, preserveAbsent: false }),
    baseline,
    "deletion semantics"
  );
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, contractVersion: "canonical-health-v3" }),
    baseline,
    "parser contract version"
  );
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, engine: "rust@0.1.0" }),
    baseline,
    "execution engine"
  );
  // The engine's *version* is part of the engine input, not decoration: a native
  // binary upgrade writes different rows under the same `name`, so it must move
  // the digest on its own.
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, engine: "rust@0.2.0" }),
    importPayloadSha256("content-a", { ...BASE_CONTEXT, engine: "rust@0.1.0" }),
    "execution engine version"
  );
  // The identity algorithm is the input a payload cannot show: identical bytes can
  // derive different ids. `import-worker` always folds the fingerprint in, so an
  // algorithm change invalidates the anchor by itself instead of being skipped.
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, identityAlgorithm: "f".repeat(64) }),
    baseline,
    "identity algorithm"
  );
  // ...and the field must be purely additive: a context that omits it reproduces
  // the pre-field digest byte-for-byte, so its existence cannot re-key a fixture or
  // an older embedder. Recomputed with the original formula rather than compared
  // against `baseline` (which would be the same call and prove nothing).
  const preFieldDigest = createHash("sha256")
    .update("rai.import-payload.v1\0")
    .update(BASE_CONTEXT.contractVersion)
    .update("\0")
    .update(BASE_CONTEXT.preserveAbsent ? "preserve" : "replace")
    .update("\0")
    .update(BASE_CONTEXT.engine)
    .update("\0")
    .update("content-a")
    .digest("hex");
  assert.equal(
    importPayloadSha256("content-a", BASE_CONTEXT),
    preFieldDigest,
    "an absent identity algorithm must not move the digest"
  );
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, identityAlgorithm: identityAlgorithmFingerprint() }),
    preFieldDigest,
    "the value production passes must move the digest"
  );
  // The value production actually passes is the frozen fingerprint; assert it is a
  // real digest rather than an empty string that would silently disable the guard.
  assert.match(identityAlgorithmFingerprint(), /^[0-9a-f]{64}$/);
});

test("payload content digest ignores the exporter wall clock but notices real data", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-identity-"));
  try {
    const first = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
    const before = await computeImportPayloadSha256(first, BASE_CONTEXT);
    // A re-export of identical data carries a new <ExportDate>; the identity must
    // survive that, otherwise the shortcut would never fire for the iOS sync path.
    writeFileSync(join(first, "export.xml"), exportXml("2026-09-24 11:22:33 +0800"), "utf8");
    assert.equal(await computeImportPayloadSha256(first, BASE_CONTEXT), before, "wall clock must not move it");
    writeFileSync(
      join(first, "export.xml"),
      exportXml("2026-09-24 11:22:33 +0800", ' <Record type="HKQuantityTypeIdentifierStepCount" value="9"/>\n'),
      "utf8"
    );
    assert.notEqual(await computeImportPayloadSha256(first, BASE_CONTEXT), before, "new data must move it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("payload anchors round-trip, and an unusable anchor reads as absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-anchor-"));
  const databasePath = join(root, "identity.sqlite");
  try {
    await seedDatabase(databasePath);
    // Nothing recorded yet: the pre-flight must have no basis to short-circuit.
    assert.deepEqual(readDatabaseImportIdentity(databasePath), { anchor: null, datasetVersion: "preflight_fixture" });

    const module = await import("../src/import-payload-identity.js");
    module.writeImportPayloadAnchor(databasePath, { sha256: "abc", datasetVersion: "preflight_fixture" });
    assert.deepEqual(readDatabaseImportIdentity(databasePath), {
      anchor: { sha256: "abc", datasetVersion: "preflight_fixture" },
      datasetVersion: "preflight_fixture"
    });

    // A corrupt anchor must read as absent rather than as "unchanged" — refusing to
    // guess is what keeps a broken row from becoming a skipped import.
    const raw = new DatabaseSync(databasePath);
    try {
      raw.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)")
        .run(IMPORT_PAYLOAD_ANCHOR_KEY, "{not json");
    } finally {
      raw.close();
    }
    assert.equal(readDatabaseImportIdentity(databasePath)?.anchor, null);
    for (const malformed of ['{"sha256":"abc"}', '{"sha256":"","datasetVersion":"x"}', '{"sha256":"a","datasetVersion":""}']) {
      const writer = new DatabaseSync(databasePath);
      try {
        writer.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)")
          .run(IMPORT_PAYLOAD_ANCHOR_KEY, malformed);
      } finally {
        writer.close();
      }
      assert.equal(readDatabaseImportIdentity(databasePath)?.anchor, null, malformed);
    }
    assert.equal(readDatabaseImportIdentity(join(root, "absent.sqlite")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an import records the payload anchor and the next identical sync skips the whole pipeline", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-hit-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const inputPath = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
  try {
    await seedDatabase(databasePath);
    const worker = new ImportWorker(databasePath, root, root) as unknown as PreflightSurface;
    const expected = await computeImportPayloadSha256(inputPath, {
      preserveAbsent: true,
      contractVersion: CONTRACT_VERSION,
      engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
      identityAlgorithm: identityAlgorithmFingerprint()
    });

    let commandCount = 0;
    worker.command = async () => { commandCount += 1; };

    // First import: no anchor yet, so it must take the full path — and then record
    // the anchor for the payload it applied. The stub command leaves staging equal
    // to the live database, so the verdict is `unchanged` and the staging copy is
    // discarded; the anchor is still recorded against the live database, because
    // that is exactly the state the payload was just proven not to change.
    const first = queuedJob(inputPath, true);
    await worker.run(first);
    assert.equal(first.status, "succeeded", String(first.error ?? ""));
    assert.equal((first.summary as { importMode: string }).importMode, "unchanged");
    assert.equal(commandCount, 1, "the first import has no anchor and must run the pipeline");
    assert.deepEqual(anchorOf(databasePath), { sha256: expected, datasetVersion: "preflight_fixture" });

    const backupsBefore = readdirSync(join(root, "var", "backups"));

    // Second import of the identical payload: nothing is backed up, copied, parsed
    // or diffed. This is the whole point of the change.
    const second = queuedJob(inputPath, true);
    await worker.run(second);
    assert.equal(second.status, "succeeded", String(second.error ?? ""));
    assert.equal(commandCount, 1, "the identical payload must not invoke the CLI");
    assert.equal((second.summary as { importMode: string }).importMode, "unchanged");
    const summary = second.summary as { unchangedWorkouts: number; backupName: string | null; recomputeReasons: string[] };
    assert.equal(summary.unchangedWorkouts, 3, "every existing session is unchanged by a no-op payload");
    assert.equal(summary.backupName, null, "no backup is produced on this path");
    assert.deepEqual(summary.recomputeReasons, ["payload_identity_unchanged"]);
    for (const skipped of ["backup", "stagingCopy", "parseImport"]) {
      assert.ok(!stageNames(second).includes(skipped), `${skipped} must not run`);
    }
    assert.deepEqual(readdirSync(join(root, "var", "backups")), backupsBefore, "no new backup file");
    assert.deepEqual(
      readdirSync(join(root, "var")).filter((name) => name.startsWith("rai.importing.")),
      [],
      "no staging database left behind"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a payload that declares absence-as-deletion never short-circuits", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-delete-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const inputPath = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
  try {
    await seedDatabase(databasePath);
    const worker = new ImportWorker(databasePath, root, root) as unknown as PreflightSurface;
    const module = await import("../src/import-payload-identity.js");
    // The anchor is recorded under deleting semantics, so the identity *would*
    // match a deleting re-import. Refusal can therefore only come from the guard.
    module.writeImportPayloadAnchor(databasePath, {
      sha256: await computeImportPayloadSha256(inputPath, {
        preserveAbsent: false,
        contractVersion: CONTRACT_VERSION,
        engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
        identityAlgorithm: identityAlgorithmFingerprint()
      }),
      datasetVersion: "preflight_fixture"
    });
    assert.equal(
      await worker.detectUnchangedPayload(queuedJob(inputPath, false), worker.executionEngine),
      null
    );

    // Sanity: the same payload under non-deleting semantics, anchored under those
    // semantics, does hit — so the refusal above is the guard and not a broken
    // identity path.
    module.writeImportPayloadAnchor(databasePath, {
      sha256: await computeImportPayloadSha256(inputPath, {
        preserveAbsent: true,
        contractVersion: CONTRACT_VERSION,
        engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
        identityAlgorithm: identityAlgorithmFingerprint()
      }),
      datasetVersion: "preflight_fixture"
    });
    const hit = await worker.detectUnchangedPayload(
      queuedJob(inputPath, true),
      worker.executionEngine
    );
    assert.ok(hit, "the non-deleting payload must short-circuit");
    assert.equal(hit.datasetVersion, "preflight_fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a database that moved since the anchor was recorded disables the short-circuit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-stale-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const inputPath = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
  try {
    await seedDatabase(databasePath);
    const worker = new ImportWorker(databasePath, root, root) as unknown as PreflightSurface;
    const expected = await computeImportPayloadSha256(inputPath, {
      preserveAbsent: true,
      contractVersion: CONTRACT_VERSION,
      engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
      identityAlgorithm: identityAlgorithmFingerprint()
    });
    const module = await import("../src/import-payload-identity.js");
    module.writeImportPayloadAnchor(databasePath, { sha256: expected, datasetVersion: "preflight_fixture" });
    assert.ok(await worker.detectUnchangedPayload(queuedJob(inputPath, true), worker.executionEngine));

    // Another import landed in between. `dataset_version` is what makes that
    // visible; without this guard a deletion-only sync would be silently undone by
    // replaying a payload that still carries the deleted row.
    const other = new DatabaseSync(databasePath);
    try {
      other.prepare("UPDATE import_manifest SET value = ? WHERE key = 'dataset_version'").run("preflight_moved");
    } finally {
      other.close();
    }
    assert.ok(readDatabaseImportIdentity(databasePath));
    assert.equal(
      await worker.detectUnchangedPayload(queuedJob(inputPath, true), worker.executionEngine),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a payload whose identity differs still runs the full pipeline", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-miss-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const inputPath = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
  try {
    await seedDatabase(databasePath);
    const worker = new ImportWorker(databasePath, root, root) as unknown as PreflightSurface;
    const module = await import("../src/import-payload-identity.js");
    module.writeImportPayloadAnchor(databasePath, { sha256: "not-this-payload", datasetVersion: "preflight_fixture" });

    let commandCount = 0;
    worker.command = async () => { commandCount += 1; };
    const job = queuedJob(inputPath, true);
    await worker.run(job);
    assert.equal(commandCount, 1, "a differing payload must go through the CLI");
    assert.ok(stageNames(job).includes("backup"), "the full path still backs up");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable payload disables the short-circuit instead of failing the import", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-unreadable-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  // The directory exists but carries no export.xml, so the identity cannot be read.
  const inputPath = join(root, "export");
  mkdirSync(inputPath);
  try {
    await seedDatabase(databasePath);
    const worker = new ImportWorker(databasePath, root, root) as unknown as PreflightSurface;
    const module = await import("../src/import-payload-identity.js");
    module.writeImportPayloadAnchor(databasePath, { sha256: "abc", datasetVersion: "preflight_fixture" });
    assert.equal(
      await worker.detectUnchangedPayload(queuedJob(inputPath, true), worker.executionEngine),
      null
    );
    // And the import still proceeds down the normal path rather than failing.
    let commandCount = 0;
    worker.command = async () => { commandCount += 1; };
    await worker.run(queuedJob(inputPath, true));
    assert.equal(commandCount, 1, "an unreadable payload must fall back to the full pipeline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the recorded anchor survives a real activation into the live database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-activate-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const inputPath = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
  try {
    await seedDatabase(databasePath);
    const worker = new ImportWorker(databasePath, root, root) as unknown as PreflightSurface;
    let commandCount = 0;
    worker.command = async (args) => {
      commandCount += 1;
      const databaseArgument = args.indexOf("--database");
      const stagingPath = args[databaseArgument + 1];
      assert.ok(stagingPath);
      if (commandCount === 1) {
        // Make the staged copy diverge so the verdict forces activation, which is
        // the path that renames staging onto the live database.
        const staging = new DatabaseSync(stagingPath);
        try {
          staging.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES ('fixture_marker', '1')").run();
        } finally {
          staging.close();
        }
        return;
      }
      assert.ok(args.includes("recompute"), "the second command must be the recompute pass");
    };
    const job = queuedJob(inputPath, true);
    await worker.run(job);
    assert.equal(job.status, "succeeded", String(job.error ?? ""));
    assert.deepEqual(anchorOf(databasePath), {
      sha256: await computeImportPayloadSha256(inputPath, {
        preserveAbsent: true,
        contractVersion: CONTRACT_VERSION,
        engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
        identityAlgorithm: identityAlgorithmFingerprint()
      }),
      datasetVersion: "preflight_fixture"
    });
    assert.equal(
      readFileSync(join(root, "var", "runtime.sqlite")).length > 0,
      true,
      "runtime state remains readable"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
