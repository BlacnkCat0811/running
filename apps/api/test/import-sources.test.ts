import assert from "node:assert/strict";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import yazl from "yazl";

import { ImportSourceManager } from "../src/import-sources.js";
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
    await manager.cleanupUpload(inspection.sourceId);
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

test("rejects ZIPs exceeding configured entry limits and removes partial extraction", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-limits-"));
  const archivePath = join(root, "health.zip");
  try {
    await zip(archivePath, [
      { name: "apple_health_export/export.xml", body: "<HealthData/>" },
      { name: "apple_health_export/extra.txt", body: "extra" }
    ]);
    const manager = new ImportSourceManager(root, root, { maxEntries: 1 });
    await assert.rejects(manager.saveUpload(createReadStream(archivePath), "health.zip"), /文件数量超过限制/);
    const imports = join(root, "var", "imports");
    const remaining = existsSync(imports) ? (await readdir(imports)).filter((item) => item !== "sources.json") : [];
    assert.deepEqual(remaining, []);
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
