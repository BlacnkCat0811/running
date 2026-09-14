import assert from "node:assert/strict";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import yazl from "yazl";

import {
  ImportArchiveTooLargeError,
  ImportArchiveValidationError,
  ImportSourceManager,
  ImportSourceNotFoundError,
  ImportUploadBusyError,
  ImportUploadCapacityError,
  createImportSourceManager,
  digestHealthKitExportContent,
  FULL_SNAPSHOT_SOURCE_SCOPE,
  isHealthKitUploadSource,
  readSyncManifestScope,
  resolvePreserveAbsent
} from "../src/import-sources.js";
import { RuntimeStateStore } from "../src/runtime-state.js";

async function zip(path: string, entries: Array<{ name: string; body: string }>): Promise<void> {
  const archive = new yazl.ZipFile();
  for (const entry of entries) archive.addBuffer(Buffer.from(entry.body), entry.name);
  archive.end();
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(path);
    archive.outputStream.pipe(output).on("close", resolve).on("error", reject);
  });
}

function clearUtf8Flags(path: string): void {
  const bytes = readFileSync(path);
  for (let index = 0; index <= bytes.length - 10; index += 1) {
    const signature = bytes.readUInt32LE(index);
    const flagOffset = signature === 0x04034b50 ? index + 6 : signature === 0x02014b50 ? index + 8 : null;
    if (flagOffset !== null) bytes.writeUInt16LE(bytes.readUInt16LE(flagOffset) & ~0x0800, flagOffset);
  }
  writeFileSync(path, bytes);
}

test("uploads and inspects a nested Apple Health ZIP", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [
      { name: "apple_health_export/export.xml", body: "<?xml version=\"1.0\"?><HealthData/>" },
      { name: "apple_health_export/workout-routes/route_1.gpx", body: "<gpx/>" }
    ]);
    const manager = new ImportSourceManager(root, root);
    const inspection = await manager.saveUpload(createReadStream(archivePath), "导出.zip");
    assert.equal(inspection.status, "ready");
    assert.equal(inspection.exportFileName, "export.xml");
    assert.equal(inspection.routeFileCount, 1);
    assert.match(inspection.sourceSha256 ?? "", /^[a-f0-9]{64}$/);
    const source = await manager.get(inspection.sourceId);
    assert.ok(source && existsSync(join(source.inputPath, "export.xml")));

    await manager.markUsed(inspection.sourceId);
    assert.equal((await manager.recent())[0]?.id, inspection.sourceId);
    assert.equal(await manager.cleanupUpload(inspection.sourceId), true);
    assert.equal(await manager.cleanupUpload(inspection.sourceId), false);
    assert.equal(existsSync(join(root, "var", "imports", inspection.sourceId)), false);
    assert.equal(await manager.get(inspection.sourceId), null);
    assert.deepEqual(await manager.recent(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recent sources omit directories that no longer exist", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-stale-"));
  const exportRoot = join(root, "export");
  mkdirSync(exportRoot);
  writeFileSync(join(exportRoot, "export.xml"), "<HealthData/>");
  try {
    const manager = new ImportSourceManager(root, root);
    const source = await manager.registerDirectory(exportRoot);
    await manager.markUsed(source.sourceId);
    rmSync(exportRoot, { recursive: true, force: true });
    assert.deepEqual(await manager.recent(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale source discovery does not erase a newer last-used timestamp", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-last-used-"));
  const exportRoot = join(root, "export");
  mkdirSync(exportRoot);
  writeFileSync(join(exportRoot, "export.xml"), "<HealthData/>");
  try {
    const manager = new ImportSourceManager(root, root);
    const inspection = await manager.registerDirectory(exportRoot);
    const staleSource = await manager.get(inspection.sourceId);
    assert.ok(staleSource);
    await manager.markUsed(inspection.sourceId);

    new RuntimeStateStore(root).upsertSource(staleSource);

    const current = await manager.get(inspection.sourceId);
    assert.ok(current?.lastUsedAt);
    assert.equal((await manager.recent())[0]?.id, inspection.sourceId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recognizes Apple Chinese export names when ZIP omits the UTF-8 flag", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-encoding-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [
      { name: "apple_health_export/导出.xml", body: "<?xml version=\"1.0\"?><HealthData/>" }
    ]);
    clearUtf8Flags(archivePath);
    const manager = new ImportSourceManager(root, root);
    const inspection = await manager.saveUpload(createReadStream(archivePath), "导出.zip");
    assert.equal(inspection.exportFileName, "导出.xml");
    const source = await manager.get(inspection.sourceId);
    assert.ok(source && existsSync(join(source.inputPath, "导出.xml")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replays an upload with the same sync batch idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-idempotency-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [{
      name: "apple_health_export/export.xml",
      body: "<HealthData><Record type=\"workout\"/></HealthData>"
    }]);
    const manager = new ImportSourceManager(root, root);
    const first = await manager.saveUpload(createReadStream(archivePath), "apple-health-healthkit.zip", "batch-1");
    const second = await manager.saveUpload(createReadStream(archivePath), "apple-health-healthkit.zip", "batch-1");
    assert.equal(second.sourceId, first.sourceId);
    assert.equal(second.status, "ready");
    assert.equal((await manager.get(first.sourceId))?.idempotencyKey, "batch-1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects ZIPs exceeding configured entry limits and removes partial extraction", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-limits-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [
      { name: "apple_health_export/export.xml", body: "<HealthData/>" },
      { name: "apple_health_export/extra.txt", body: "extra" }
    ]);
    const manager = new ImportSourceManager(root, root, { maxEntries: 1 });
    await assert.rejects(
      manager.saveUpload(createReadStream(archivePath), "health.zip"),
      (error: unknown) => error instanceof ImportArchiveValidationError && /文件数量超过限制/.test(error.message)
    );
    const imports = join(root, "var", "imports");
    const remaining = existsSync(imports) ? (await readdir(imports)).filter((item) => item !== "sources.json") : [];
    assert.deepEqual(remaining, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleans abandoned uploads without removing used sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-abandoned-"));
  const firstArchive = join(root, "first.zip");
  const secondArchive = join(root, "second.zip");
  try {
    await zip(firstArchive, [
      { name: "apple_health_export/export.xml", body: "<HealthData first=\"true\"/>" }
    ]);
    await zip(secondArchive, [
      { name: "apple_health_export/export.xml", body: "<HealthData second=\"true\"/>" }
    ]);
    const manager = new ImportSourceManager(root, root);
    const abandoned = await manager.saveUpload(createReadStream(firstArchive), "first.zip");
    const used = await manager.saveUpload(createReadStream(secondArchive), "second.zip");
    await manager.markUsed(used.sourceId);

    assert.equal(await manager.cleanupAbandonedUploads(Date.now(), 0), 1);
    assert.equal(await manager.get(abandoned.sourceId), null);
    assert.ok(await manager.get(used.sourceId));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses explicit cleanup while an import uses the upload path", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-active-delete-"));
  const archive = join(root, "health.zip");
  try {
    await zip(archive, [{ name: "apple_health_export/export.xml", body: "<HealthData/>" }]);
    const manager = new ImportSourceManager(root, root);
    const uploaded = await manager.saveUpload(createReadStream(archive), "health.zip");
    const source = await manager.get(uploaded.sourceId);
    assert.ok(source);
    await assert.rejects(
      manager.cleanupUpload(uploaded.sourceId, [source.inputPath]),
      (error: unknown) => error instanceof ImportUploadBusyError
    );
    assert.ok(await manager.get(uploaded.sourceId));
    assert.equal(await manager.cleanupUpload(uploaded.sourceId), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps fresh and actively referenced uploads during abandoned cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-leased-"));
  const archive = join(root, "health.zip");
  try {
    await zip(archive, [{ name: "apple_health_export/export.xml", body: "<HealthData/>" }]);
    const manager = new ImportSourceManager(root, root);
    const uploaded = await manager.saveUpload(createReadStream(archive), "health.zip");
    const source = await manager.get(uploaded.sourceId);
    assert.ok(source);
    assert.equal(await manager.cleanupAbandonedUploads(), 0);

    const state = new RuntimeStateStore(root);
    state.upsertJob({
      id: "active-import", status: "running", phase: "import", message: "running",
      createdAt: new Date().toISOString(), completedAt: null, error: null,
      inputPath: source.inputPath
    });
    assert.equal(await manager.cleanupAbandonedUploads(Date.now(), 0), 0);
    state.upsertJob({
      id: "active-import", status: "failed", phase: "failed", message: "failed",
      createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: "failed",
      inputPath: source.inputPath
    });
    assert.equal(await manager.cleanupAbandonedUploads(Date.now(), 0), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sweeps expired orphan upload directories but preserves active paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-orphans-"));
  try {
    const manager = new ImportSourceManager(root, root);
    const imports = join(root, "var", "imports");
    const orphan = join(imports, "upload_orphan");
    const active = join(imports, "upload_active");
    mkdirSync(join(orphan, "extracted"), { recursive: true });
    mkdirSync(join(active, "extracted"), { recursive: true });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    utimesSync(orphan, old, old);
    utimesSync(active, old, old);
    assert.equal(
      await manager.cleanupAbandonedUploads(Date.now(), 24 * 60 * 60 * 1_000, [join(active, "extracted")]),
      1
    );
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(active), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production manager factory wires the configured archive byte limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-archive-limit-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [{ name: "apple_health_export/export.xml", body: "<HealthData/>" }]);
    const manager = createImportSourceManager(root, root, 16);
    await assert.rejects(
      manager.saveUpload(createReadStream(archivePath), "health.zip"),
      (error: unknown) => error instanceof ImportArchiveTooLargeError && error.statusCode === 413
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("serializes uploads and enforces the global stored-byte budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-global-budget-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [{ name: "apple_health_export/export.xml", body: "<HealthData/>" }]);
    const manager = new ImportSourceManager(root, root, {
      minimumFreeBytes: 1,
      maxStoredUploadBytes: 1
    });
    await assert.rejects(
      manager.saveUpload(createReadStream(archivePath), "health.zip"),
      (error: unknown) => error instanceof ImportUploadCapacityError && error.statusCode === 507
    );

    const serialManager = new ImportSourceManager(root, root, { minimumFreeBytes: 1 });
    const heldStream = new PassThrough();
    const heldUpload = serialManager.saveUpload(heldStream, "held.zip");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(
      serialManager.saveUpload(createReadStream(archivePath), "second.zip"),
      (error: unknown) => error instanceof ImportUploadBusyError && error.statusCode === 429
    );
    heldStream.end(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await assert.rejects(heldUpload, ImportArchiveValidationError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quarantines a corrupt runtime state database and rebuilds it", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-runtime-state-corrupt-"));
  try {
    mkdirSync(join(root, "var"), { recursive: true });
    writeFileSync(join(root, "var", "runtime.sqlite"), "not a sqlite database");
    const state = new RuntimeStateStore(root);
    assert.deepEqual(state.sources(), []);
    assert.equal(
      readdirSync(join(root, "var")).some((name) => name.startsWith("runtime.sqlite.corrupt-")),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers when runtime state becomes corrupt after initialization", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-runtime-state-late-corrupt-"));
  try {
    const state = new RuntimeStateStore(root);
    writeFileSync(state.path, "not a sqlite database");
    assert.deepEqual(state.sources(), []);
    assert.equal(
      readdirSync(join(root, "var")).some((name) => name.startsWith("runtime.sqlite.corrupt-")),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function corruptFirstCompressedPayload(path: string): void {
  const bytes = readFileSync(path);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const compressedSize = bytes.readUInt32LE(18);
  const payloadOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  assert.ok(compressedSize > 2);
  bytes[payloadOffset + Math.floor(compressedSize / 2)]! ^= 0xff;
  writeFileSync(path, bytes);
}

test("classifies corrupt compressed payloads as archive validation errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-corrupt-deflate-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [{
      name: "apple_health_export/export.xml",
      body: `<HealthData>${"payload".repeat(2_000)}</HealthData>`
    }]);
    corruptFirstCompressedPayload(archivePath);
    await assert.rejects(
      new ImportSourceManager(root, root).saveUpload(createReadStream(archivePath), "health.zip"),
      (error: unknown) => error instanceof ImportArchiveValidationError && error.statusCode === 400
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects duplicate archive paths before writing the second entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-duplicate-path-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [
      { name: "apple_health_export/export.xml", body: "<HealthData/>" },
      { name: "apple_health_export/export.xml", body: "<HealthData duplicate=\"true\"/>" }
    ]);
    await assert.rejects(
      new ImportSourceManager(root, root).saveUpload(createReadStream(archivePath), "health.zip"),
      (error: unknown) => error instanceof ImportArchiveValidationError && /重复路径/.test(error.message)
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects ZIP file and child-path conflicts as archive validation errors", async () => {
  for (const entries of [
    [{ name: "apple_health_export/a", body: "file" }, { name: "apple_health_export/a/export.xml", body: "<HealthData/>" }],
    [{ name: "apple_health_export/a/export.xml", body: "<HealthData/>" }, { name: "apple_health_export/a", body: "file" }]
  ]) {
    const root = mkdtempSync(join(tmpdir(), "rai-import-path-conflict-"));
    const archivePath = join(root, "health.zip");
    try {
      await zip(archivePath, entries);
      await assert.rejects(
        new ImportSourceManager(root, root).saveUpload(createReadStream(archivePath), "health.zip"),
        (error: unknown) => error instanceof ImportArchiveValidationError && error.code === "invalid_import_archive"
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("extracts a high-cardinality archive with bounded path-index work", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-many-paths-"));
  const archivePath = join(root, "health.zip");
  try {
    const entries = Array.from({ length: 1_500 }, (_, index) => ({
      name: `apple_health_export/workout-routes/route-${index}.gpx`,
      body: "<gpx/>"
    }));
    entries.push({ name: "apple_health_export/export.xml", body: "<HealthData/>" });
    await zip(archivePath, entries);

    const inspection = await new ImportSourceManager(root, root, { maxEntries: 2_000 })
      .saveUpload(createReadStream(archivePath), "health.zip");

    assert.equal(inspection.routeFileCount, 1_500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Windows strips trailing dots and spaces from file names, so `export.xml.`
// collides with `export.xml` there but is a distinct file on POSIX. The guard
// cannot be exercised off Windows, so say so rather than skipping silently.
test("rejects Windows path aliases before extraction", {
  skip: process.platform !== "win32" ? "needs Windows path-alias semantics" : false
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-windows-alias-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [
      { name: "apple_health_export/export.xml", body: "<HealthData/>" },
      { name: "apple_health_export/export.xml.", body: "alias" }
    ]);
    await assert.rejects(
      new ImportSourceManager(root, root).saveUpload(createReadStream(archivePath), "health.zip"),
      (error: unknown) => error instanceof ImportArchiveValidationError && error.statusCode === 400
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function patchUncompressedSizes(path: string, size: number): void {
  const bytes = readFileSync(path);
  for (let index = 0; index <= bytes.length - 30; index += 1) {
    const signature = bytes.readUInt32LE(index);
    // Local file header uncompressed size @ +22; central directory @ +24.
    if (signature === 0x04034b50) bytes.writeUInt32LE(size, index + 22);
    if (signature === 0x02014b50) bytes.writeUInt32LE(size, index + 24);
  }
  writeFileSync(path, bytes);
}

test("rejects ZIP entries whose actual bytes exceed the declared uncompressed size", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-size-lie-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [
      { name: "apple_health_export/export.xml", body: "<?xml version=\"1.0\"?><HealthData>payload that is larger than lie</HealthData>" }
    ]);
    // Lie: claim zero uncompressed bytes while the entry still carries data.
    patchUncompressedSizes(archivePath, 0);
    const manager = new ImportSourceManager(root, root);
    await assert.rejects(
      manager.saveUpload(createReadStream(archivePath), "health.zip"),
      /大小声明异常|实际大小超过声明/
    );
    const imports = join(root, "var", "imports");
    const remaining = existsSync(imports) ? (await readdir(imports)).filter((item) => item !== "sources.json") : [];
    assert.deepEqual(remaining, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects ZIP entries that expand past the remaining extraction budget using actual bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-budget-"));
  const archivePath = join(root, "health.zip");
  try {
    const body = "x".repeat(200);
    await zip(archivePath, [
      { name: "apple_health_export/export.xml", body }
    ]);
    const manager = new ImportSourceManager(root, root, { maxExtractedBytes: 50, maxEntryBytes: 10_000 });
    await assert.rejects(
      manager.saveUpload(createReadStream(archivePath), "health.zip"),
      /解压后大小超过限制|单个文件超过限制/
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("discovers the project export directory and remembers it as a source", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-discover-"));
  const exportRoot = join(root, "apple_health_export");
  mkdirSync(exportRoot);
  writeFileSync(join(exportRoot, "导出.xml"), "<HealthData/>");
  try {
    const manager = new ImportSourceManager(root, root);
    const sources = await manager.discover();
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.kind, "discovered");
    assert.equal(sources[0]?.exportFileName, "导出.xml");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migrates legacy source JSON once and keeps SQLite as the source of truth", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-migration-"));
  const imports = join(root, "var", "imports");
  mkdirSync(imports, { recursive: true });
  const legacy = {
    id: "local_legacy", kind: "directory", displayName: "legacy", inputPath: join(root, "export"),
    originalPath: join(root, "export"), sourceSha256: null, exportFileName: "export.xml",
    exportBytes: 42, routeFileCount: 0, modifiedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-01-02T00:00:00.000Z"
  };
  const metadata = join(imports, "sources.json");
  writeFileSync(metadata, JSON.stringify({ version: 1, sources: [legacy] }), "utf8");
  try {
    assert.equal((await new ImportSourceManager(root, root).get(legacy.id))?.displayName, "legacy");
    writeFileSync(metadata, JSON.stringify({ version: 1, sources: [{ ...legacy, displayName: "changed-json" }] }), "utf8");
    assert.equal((await new ImportSourceManager(root, root).get(legacy.id))?.displayName, "legacy");
    assert.equal(existsSync(join(root, "var", "runtime.sqlite")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rolls back a failed legacy migration and retries it on the next startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-migration-retry-"));
  const imports = join(root, "var", "imports");
  mkdirSync(imports, { recursive: true });
  const valid = {
    id: "local_valid", kind: "directory", displayName: "valid", inputPath: join(root, "export"),
    originalPath: join(root, "export"), sourceSha256: null, exportFileName: "export.xml",
    exportBytes: 42, routeFileCount: 0, modifiedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null
  };
  const metadata = join(imports, "sources.json");
  writeFileSync(metadata, JSON.stringify({ version: 1, sources: [valid, { ...valid, kind: null }] }), "utf8");
  try {
    assert.throws(() => new ImportSourceManager(root, root));
    assert.deepEqual(new RuntimeStateStore(root).sources(), []);
    writeFileSync(metadata, JSON.stringify({ version: 1, sources: [valid] }), "utf8");
    assert.equal((await new ImportSourceManager(root, root).get(valid.id))?.displayName, "valid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("HealthKit content digest ignores ExportDate and inspects matching uploads as unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-healthkit-digest-"));
  const exportRoot = join(root, "export");
  mkdirSync(join(exportRoot, "workout-routes"), { recursive: true });
  const xml = (exportDate: string) => `<?xml version="1.0"?><HealthData locale="en_US">
  <ExportDate value="${exportDate}"/>
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch"
    startDate="2026-01-02 08:00:00 +0800" endDate="2026-01-02 08:30:00 +0800" duration="30" durationUnit="min"/>
</HealthData>`;
  writeFileSync(join(exportRoot, "export.xml"), xml("2026-01-03 00:00:00 +0800"));
  writeFileSync(join(exportRoot, "workout-routes", "route_1.gpx"), "<gpx/>");
  const firstDigest = await digestHealthKitExportContent(exportRoot);
  writeFileSync(join(exportRoot, "export.xml"), xml("2026-01-04 12:34:56 +0800"));
  assert.equal(await digestHealthKitExportContent(exportRoot), firstDigest);
  writeFileSync(join(exportRoot, "workout-routes", "route_1.gpx"), "<gpx extra=\"1\"/>");
  assert.notEqual(await digestHealthKitExportContent(exportRoot), firstDigest);
  assert.equal(isHealthKitUploadSource({ kind: "upload", displayName: "apple-health-healthkit.zip" }), true);
  assert.equal(isHealthKitUploadSource({
    kind: "upload",
    displayName: "health.zip",
    originalPath: join(root, "apple-health-healthkit-local.zip")
  }), true);
  assert.equal(isHealthKitUploadSource({ kind: "directory", displayName: "apple-health-healthkit.zip" }), false);
  assert.equal(isHealthKitUploadSource({ kind: "discovered", displayName: "apple-health-healthkit.zip" }), false);

  const firstArchive = join(root, "first.zip");
  const secondArchive = join(root, "second.zip");
  const changedArchive = join(root, "changed.zip");
  const regularArchive = join(root, "regular.zip");
  try {
    await zip(firstArchive, [
      { name: "apple_health_export/export.xml", body: xml("2026-01-03 00:00:00 +0800") },
      { name: "apple_health_export/workout-routes/route_1.gpx", body: "<gpx/>" }
    ]);
    await zip(secondArchive, [
      { name: "apple_health_export/export.xml", body: xml("2026-01-04 12:34:56 +0800") },
      { name: "apple_health_export/workout-routes/route_1.gpx", body: "<gpx/>" }
    ]);
    await zip(changedArchive, [
      { name: "apple_health_export/export.xml", body: xml("2026-01-04 12:34:56 +0800").replace("duration=\"30\"", "duration=\"31\"") },
      { name: "apple_health_export/workout-routes/route_1.gpx", body: "<gpx/>" }
    ]);
    await zip(regularArchive, [
      { name: "apple_health_export/export.xml", body: xml("2026-01-03 00:00:00 +0800") }
    ]);
    const manager = new ImportSourceManager(root, root);
    const first = await manager.saveUpload(createReadStream(firstArchive), "apple-health-healthkit.zip");
    assert.equal(first.status, "ready");
    await manager.retainImportedUpload(first.sourceId);
    assert.equal((await manager.get(first.sourceId))?.lastUsedAt != null, true);
    assert.equal(existsSync(join(root, "var", "imports", first.sourceId)), false);

    const second = await manager.saveUpload(createReadStream(secondArchive), "apple-health-healthkit.zip");
    assert.equal(second.status, "unchanged");
    assert.equal(second.sourceSha256, first.sourceSha256);

    const changed = await manager.saveUpload(createReadStream(changedArchive), "apple-health-healthkit.zip");
    assert.equal(changed.status, "ready");
    assert.notEqual(changed.sourceSha256, first.sourceSha256);

    const regular = await manager.saveUpload(createReadStream(regularArchive), "health.zip");
    assert.equal(regular.status, "ready");
    assert.notEqual(regular.sourceSha256, first.sourceSha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ignores malformed legacy JSON without hiding typed source lookup errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-source-invalid-legacy-"));
  const imports = join(root, "var", "imports");
  mkdirSync(imports, { recursive: true });
  writeFileSync(join(imports, "sources.json"), "{not-json", "utf8");
  try {
    const manager = new ImportSourceManager(root, root);
    await assert.rejects(manager.inspect("upload_missing"), ImportSourceNotFoundError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function manifestDirectory(root: string, name: string, manifest: string | null): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  if (manifest !== null) writeFileSync(join(directory, "sync-manifest.json"), manifest, "utf8");
  return directory;
}

/**
 * The archive filename is caller-supplied and trivially renameable, so it must
 * never be the primary switch for a destructive import. A client that ships a
 * sync manifest has declared what the payload is; that declaration wins.
 */
test("prefers the declared source scope over the archive filename", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-preserve-absent-"));
  try {
    const declared = manifestDirectory(
      root,
      "declared",
      JSON.stringify({ version: 1, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [] })
    );
    const renamed = resolvePreserveAbsent(declared, { kind: "upload", displayName: "health.zip" });
    assert.equal(renamed.preserveAbsent, true, "a renamed sync package must not read as a full snapshot");
    assert.equal(renamed.reason, "manifest-healthkit");

    const unknown = manifestDirectory(
      root,
      "unknown",
      JSON.stringify({ version: 1, sourceScope: "garmin", sourceIds: [], deletedSourceIds: [] })
    );
    const otherSource = resolvePreserveAbsent(unknown, { kind: "upload", displayName: "garmin-export.zip" });
    assert.equal(otherSource.preserveAbsent, true, "an undeclared source range defaults to non-deleting");
    assert.equal(otherSource.reason, "manifest-declared-other");

    const full = manifestDirectory(
      root,
      "full",
      JSON.stringify({ version: 1, sourceScope: FULL_SNAPSHOT_SOURCE_SCOPE })
    );
    const fullSnapshot = resolvePreserveAbsent(full, { kind: "upload", displayName: "health.zip" });
    assert.equal(fullSnapshot.preserveAbsent, false);
    assert.equal(fullSnapshot.reason, "manifest-full-snapshot");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("treats an unreadable manifest as declared and stops deleting", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-preserve-absent-corrupt-"));
  try {
    const corrupt = manifestDirectory(root, "corrupt", "{not-json");
    const scope = readSyncManifestScope(corrupt);
    assert.equal(scope.declared, true);
    assert.equal(scope.sourceScope, null);

    const decision = resolvePreserveAbsent(corrupt, {
      kind: "upload",
      displayName: "apple-health-healthkit.zip"
    });
    assert.equal(decision.preserveAbsent, true, "an unreadable manifest must not enable deletion");
    assert.equal(decision.reason, "manifest-unreadable");

    const empty = manifestDirectory(root, "empty", JSON.stringify({ version: 1, sourceScope: "   " }));
    assert.equal(resolvePreserveAbsent(empty, { kind: "upload", displayName: "x.zip" }).preserveAbsent, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only an explicitly declared full snapshot enables deletion by absence", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-preserve-absent-fallback-"));
  try {
    const bare = manifestDirectory(root, "bare", null);
    const token = resolvePreserveAbsent(bare, {
      kind: "upload",
      displayName: "apple-health-healthkit-abc.zip"
    });
    assert.equal(token.preserveAbsent, true);
    assert.equal(token.reason, "filename-token");

    const unknown = resolvePreserveAbsent(bare, { kind: "upload", displayName: "export.zip" });
    assert.equal(
      unknown.preserveAbsent,
      true,
      "an unidentified archive is unknown, and unknown must never enable deletion"
    );
    assert.equal(unknown.reason, "untrusted-default");

    const directory = resolvePreserveAbsent(bare, { kind: "directory", displayName: "export.xml" });
    assert.equal(directory.preserveAbsent, true, "a local directory import never declares itself a sync package");
    assert.equal(directory.reason, "untrusted-default");

    const declared = manifestDirectory(
      root,
      "declared",
      JSON.stringify({ version: 1, sourceScope: FULL_SNAPSHOT_SOURCE_SCOPE })
    );
    const snapshot = resolvePreserveAbsent(declared, { kind: "upload", displayName: "renamed.zip" });
    assert.equal(snapshot.preserveAbsent, false, "an explicit full-snapshot declaration may delete by absence");
    assert.equal(snapshot.reason, "manifest-full-snapshot");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("finds a sync manifest that sits above the discovered export root", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-preserve-absent-nested-"));
  try {
    const outer = join(root, "archive");
    const inner = join(outer, "apple_health_export");
    mkdirSync(inner, { recursive: true });
    writeFileSync(
      join(outer, "sync-manifest.json"),
      JSON.stringify({ version: 1, sourceScope: "healthkit" }),
      "utf8"
    );
    const nested = resolvePreserveAbsent(inner, { kind: "upload", displayName: "renamed.zip" });
    assert.equal(nested.preserveAbsent, true);
    assert.equal(nested.reason, "manifest-healthkit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recognizes manifest-declared full snapshots as HealthKit uploads", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-healthkit-full-snapshot-"));
  try {
    writeFileSync(join(root, "sync-manifest.json"), JSON.stringify({
      version: 1, sourceScope: FULL_SNAPSHOT_SOURCE_SCOPE
    }), "utf8");
    assert.equal(isHealthKitUploadSource({
      kind: "upload", displayName: "renamed.zip"
    }, root), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("finds manifests three parent directories above the export root", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-manifest-depth-"));
  try {
    const exportRoot = join(root, "a", "b", "c");
    mkdirSync(exportRoot, { recursive: true });
    writeFileSync(join(root, "sync-manifest.json"), JSON.stringify({
      version: 1, sourceScope: "healthkit"
    }), "utf8");
    const scope = readSyncManifestScope(exportRoot);
    assert.deepEqual(scope, { declared: true, sourceScope: "healthkit" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("includes a parent manifest in the HealthKit content digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-manifest-digest-depth-"));
  try {
    const exportRoot = join(root, "a", "b", "c");
    mkdirSync(exportRoot, { recursive: true });
    writeFileSync(join(exportRoot, "export.xml"), "<HealthData/>", "utf8");
    writeFileSync(join(root, "sync-manifest.json"), JSON.stringify({
      version: 1, sourceScope: "healthkit", deletedSourceIds: ["one"]
    }), "utf8");
    const first = await digestHealthKitExportContent(exportRoot);
    writeFileSync(join(root, "sync-manifest.json"), JSON.stringify({
      version: 1, sourceScope: "healthkit", deletedSourceIds: ["two"]
    }), "utf8");
    assert.notEqual(await digestHealthKitExportContent(exportRoot), first);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("HealthKit deduplication includes deletion events but ignores manifest timestamps", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-healthkit-deletion-digest-"));
  try {
    writeFileSync(join(root, "export.xml"), "<HealthData/>");
    const manifest = (ids: string[], createdAt: string) => JSON.stringify({
      version: 1, sourceScope: "healthkit", deletedSourceIds: ids, createdAt
    });
    const manifestPath = join(root, "sync-manifest.json");
    writeFileSync(manifestPath, manifest([], "2026-01-01"));
    const initial = await digestHealthKitExportContent(root);
    writeFileSync(manifestPath, manifest(["deleted-b", "deleted-a"], "2026-01-02"));
    const deleted = await digestHealthKitExportContent(root);
    assert.notEqual(deleted, initial);
    writeFileSync(manifestPath, manifest(["deleted-a", "deleted-b", "deleted-a"], "2026-01-03"));
    assert.equal(await digestHealthKitExportContent(root), deleted);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
