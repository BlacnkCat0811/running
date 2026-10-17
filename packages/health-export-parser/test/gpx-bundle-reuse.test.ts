import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";
import { importGpxRoutes } from "../src/gpx-parser.js";

/**
 * `source_gpx_bundle_sha256` 的复用判据。
 *
 * 它是"整表排序后求的摘要"，每批都重算等于把小批同步的成本绑在历史路线数上。
 * 但复用必须有可验证的前提：
 * - 本批没有任何指纹行被增/改/删（`changedRouteIds` / `importedRouteCount` 都为 0）；
 * - 指纹行数与上次写入时相等（防"被外部删了一行但没人记账"）。
 * 任一不满足就重算 —— 旧值停在那里会变成一条假证据。
 */
const gpx = (points: number): string => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RAI"><trk><name>t</name><trkseg>
${Array.from({ length: points }, (_, index) =>
  `  <trkpt lat="${23 + index / 1000}" lon="${113 + index / 1000}"><ele>${10 + index}</ele>`
  + `<time>2026-03-01T07:${String(index).padStart(2, "0")}:00.000Z</time></trkpt>`).join("\n")}
</trkseg></trk></gpx>
`;

function manifest(store: RaiDatabase, key: string): string | null {
  const row = store.database.prepare("SELECT value FROM import_manifest WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

test("an unchanged batch reuses the bundle hash instead of rescanning every fingerprint", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-gpx-bundle-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    mkdirSync(join(root, "workout-routes"), { recursive: true });
    const path = join(root, "workout-routes", "A.gpx");
    writeFileSync(path, gpx(3), "utf8");

    const first = await importGpxRoutes(root, store, { preserveAbsent: true });
    assert.equal(first.bundleHashSource, "recomputed");
    const firstHash = manifest(store, "source_gpx_bundle_sha256");
    assert.ok(firstHash !== null && firstHash.length > 0);
    assert.equal(manifest(store, "gpx_fingerprint_count"), "1");

    const second = await importGpxRoutes(root, store, { preserveAbsent: true });
    assert.equal(second.bundleHashSource, "reused");
    assert.equal(manifest(store, "source_gpx_bundle_sha256"), firstHash);

    // 抹掉规模证据 ⇒ 下一批必须重算；重算结果必须与"复用"给出的值相同（否则复用是错的）。
    store.database.prepare("DELETE FROM import_manifest WHERE key = 'gpx_fingerprint_count'").run();
    const third = await importGpxRoutes(root, store, { preserveAbsent: true });
    assert.equal(third.bundleHashSource, "recomputed");
    assert.equal(manifest(store, "source_gpx_bundle_sha256"), firstHash);
    assert.equal(manifest(store, "gpx_fingerprint_count"), "1");

    // 文件内容变了 ⇒ 必须重算（旧值停在那里就是假证据）。
    writeFileSync(path, gpx(4), "utf8");
    const fourth = await importGpxRoutes(root, store, { preserveAbsent: true });
    assert.equal(fourth.bundleHashSource, "recomputed");
    assert.notEqual(manifest(store, "source_gpx_bundle_sha256"), firstHash);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
