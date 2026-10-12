import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workoutTypes } from "@rai/contracts";

import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { RaiDatabase } from "../src/database.js";
import { ImportRemovalGuardError } from "../src/import-guard.js";

function startOf(index: number): string {
  const date = new Date(Date.UTC(2026, 0, 1 + index));
  return `${date.toISOString().slice(0, 10)} 08:00:00 +0800`;
}

function exportXml(starts: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US"><ExportDate value="2026-06-01 00:00:00 +0800"/>
${starts.map((start) => `<Workout workoutActivityType="${workoutTypes.running}"
 sourceName="Watch" startDate="${start}" endDate="${start.replace("08:00:00", "08:30:00")}"
 duration="30" durationUnit="min"/>`).join("\n")}
</HealthData>`;
}

async function seedHistory(root: string): Promise<{ store: RaiDatabase; xmlPath: string; all: string[] }> {
  const xmlPath = join(root, "export.xml");
  const all = Array.from({ length: 60 }, (_, index) => startOf(index));
  writeFileSync(xmlPath, exportXml(all));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
  return { store, xmlPath, all };
}

/** 仍在数据集里的训练数。软删（v36）之后"行还在、事实已删"，所以只数 `deleted_at IS NULL`。 */
function workoutCount(store: RaiDatabase): number {
  return (store.database.prepare(
    "SELECT COUNT(*) AS count FROM workouts WHERE deleted_at IS NULL"
  ).get() as { count: number }).count;
}

/**
 * The dangerous path this guards: a payload that covers only a slice of history
 * loaded while absence is being read as deletion. It would silently drop every
 * session the payload happens not to mention.
 */
test("refuses a partial payload that would delete most of the history", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-removal-guard-partial-"));
  try {
    const { store, xmlPath } = await seedHistory(root);
    try {
      assert.equal(workoutCount(store), 60);
      writeFileSync(xmlPath, exportXml([startOf(59)]));

      await assert.rejects(
        parseAppleHealthXml(xmlPath, store, {
          fileSize: statSync(xmlPath).size,
          incremental: { generation: "generation-partial" }
        }),
        (error: unknown) => {
          assert.ok(error instanceof ImportRemovalGuardError, "expected the removal guard to stop the import");
          assert.equal(error.code, "import_removal_guard");
          assert.equal(error.preview.workouts, 59);
          assert.match(error.userMessage, /导入已中止/);
          return true;
        }
      );

      assert.equal(workoutCount(store), 60, "a refused import must not delete anything");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lets a complete payload through with nothing to delete", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-removal-guard-complete-"));
  try {
    const { store, xmlPath, all } = await seedHistory(root);
    try {
      // Same full history re-exported: every entity reappears under the new generation.
      await parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        incremental: { generation: "generation-complete" }
      });
      assert.equal(workoutCount(store), 60);
      assert.equal(store.previewGenerationRemoval("generation-complete").workouts, 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lets a declared incremental sync keep omitted sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-removal-guard-preserve-"));
  try {
    const { store, xmlPath } = await seedHistory(root);
    try {
      writeFileSync(xmlPath, exportXml([startOf(59)]));
      await parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        incremental: { generation: "generation-sync", preserveAbsent: true }
      });
      assert.equal(workoutCount(store), 60, "a sync payload is partial by nature and must never delete");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allows small removals without tripping the guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-removal-guard-small-"));
  try {
    const { store, xmlPath, all } = await seedHistory(root);
    try {
      // Editing away two sessions is a normal snapshot difference.
      writeFileSync(xmlPath, exportXml(all.slice(0, 58)));
      await parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        incremental: { generation: "generation-edited" }
      });
      assert.equal(workoutCount(store), 58);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allows an explicit opt-out for a deliberate full replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-removal-guard-optout-"));
  try {
    const { store, xmlPath } = await seedHistory(root);
    try {
      writeFileSync(xmlPath, exportXml([startOf(59)]));
      await parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        incremental: { generation: "generation-replace", guardAbsentRemoval: false }
      });
      assert.equal(workoutCount(store), 1, "the opt-out path keeps the documented replacement behaviour");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
