import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

import type { RoutePoint } from "@rai/contracts";
import { SaxesParser, type SaxesTagPlain } from "saxes";

import { RaiDatabase } from "./database.js";
import {
  normalizeRelativePath,
  parseFiniteNumber,
  stableId
} from "./utils.js";

interface PointDraft {
  latitude: number | null;
  longitude: number | null;
  timestamp: string | null;
  elevationMeters: number | null;
  speedMetersPerSecond: number | null;
  courseDegrees: number | null;
  horizontalAccuracyMeters: number | null;
  verticalAccuracyMeters: number | null;
}

export interface GpxImportResult {
  routeFileCount: number;
  importedRouteCount: number;
  missingRouteCount: number;
  pointCount: number;
  skippedRouteCount?: number;
  changedRouteIds?: string[];
}

function attributesOf(tag: SaxesTagPlain): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tag.attributes)) {
    result[key] = String(value);
  }
  return result;
}

function localName(name: string): string {
  return name.includes(":") ? (name.split(":").at(-1) ?? name) : name;
}

function safelyResolve(root: string, relativePath: string): string | null {
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, normalizeRelativePath(relativePath));
  const relativeCandidate = relative(rootPath, candidate);
  if (relativeCandidate.startsWith("..") || resolve(candidate) === rootPath) return null;
  return candidate;
}

async function parseGpxFile(
  path: string,
  onPoints: (points: RoutePoint[]) => void
): Promise<{ pointCount: number; sha256: string }> {
  let points: RoutePoint[] = [];
  let pointCount = 0;
  const sourceHash = createHash("sha256");
  let currentPoint: PointDraft | null = null;
  let textField: string | null = null;
  let textValue = "";
  const parser = new SaxesParser({ xmlns: false });

  parser.on("opentag", (tag) => {
    const name = localName(tag.name);
    if (name === "trkpt") {
      const attributes = attributesOf(tag);
      currentPoint = {
        latitude: parseFiniteNumber(attributes.lat),
        longitude: parseFiniteNumber(attributes.lon),
        timestamp: null,
        elevationMeters: null,
        speedMetersPerSecond: null,
        courseDegrees: null,
        horizontalAccuracyMeters: null,
        verticalAccuracyMeters: null
      };
    } else if (
      currentPoint &&
      ["time", "ele", "speed", "course", "hAcc", "vAcc"].includes(name)
    ) {
      textField = name;
      textValue = "";
    }
  });

  parser.on("text", (value) => {
    if (textField) textValue += value;
  });

  parser.on("closetag", (tag) => {
    const name = localName(tag.name);
    if (currentPoint && textField === name) {
      const value = textValue.trim();
      switch (name) {
        case "time": {
          const date = new Date(value);
          currentPoint.timestamp = Number.isNaN(date.getTime()) ? null : date.toISOString();
          break;
        }
        case "ele":
          currentPoint.elevationMeters = parseFiniteNumber(value);
          break;
        case "speed":
          currentPoint.speedMetersPerSecond = parseFiniteNumber(value);
          break;
        case "course":
          currentPoint.courseDegrees = parseFiniteNumber(value);
          break;
        case "hAcc":
          currentPoint.horizontalAccuracyMeters = parseFiniteNumber(value);
          break;
        case "vAcc":
          currentPoint.verticalAccuracyMeters = parseFiniteNumber(value);
          break;
      }
      textField = null;
      textValue = "";
    }

    if (name === "trkpt" && currentPoint) {
      if (currentPoint.latitude !== null && currentPoint.longitude !== null) {
        points.push({
          sequence: pointCount,
          timestamp: currentPoint.timestamp,
          latitude: currentPoint.latitude,
          longitude: currentPoint.longitude,
          elevationMeters: currentPoint.elevationMeters,
          speedMetersPerSecond: currentPoint.speedMetersPerSecond,
          courseDegrees: currentPoint.courseDegrees,
          horizontalAccuracyMeters: currentPoint.horizontalAccuracyMeters,
          verticalAccuracyMeters: currentPoint.verticalAccuracyMeters
        });
        pointCount += 1;
        if (points.length >= 1_000) {
          onPoints(points);
          points = [];
        }
      }
      currentPoint = null;
    }
  });

  parser.on("error", (error) => {
    throw error;
  });

  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const text = String(chunk);
    sourceHash.update(text, "utf8");
    parser.write(text);
  }
  parser.close();
  if (points.length > 0) onPoints(points);
  return { pointCount, sha256: sourceHash.digest("hex") };
}

function allGpxRelativePaths(exportRoot: string): string[] {
  const routeFolder = resolve(exportRoot, "workout-routes");
  if (!existsSync(routeFolder)) return [];
  return readdirSync(routeFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".gpx"))
    .map((entry) => `workout-routes/${entry.name}`.replaceAll("\\", "/").replace(/^\/+/, ""))
    .sort();
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function bundleHashFromFingerprints(store: RaiDatabase): string {
  const rows = store.database
    .prepare("SELECT relative_path AS relativePath, sha256 FROM route_file_fingerprints")
    .all() as unknown as Array<{ relativePath: string; sha256: string }>;
  const hash = createHash("sha256");
  for (const row of rows.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  )) {
    hash.update(row.relativePath, "utf8");
    hash.update("\0");
    hash.update(row.sha256, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function importGpxRoutes(
  exportRoot: string,
  store: RaiDatabase,
  options?: { preserveAbsent?: boolean }
): Promise<GpxImportResult> {
  const preserveAbsent = options?.preserveAbsent === true;
  const referencedTargets = new Map(
    store.routesToImport().map((target) => [
      normalizeRelativePath(target.relativePath).toLowerCase(),
      target
    ])
  );
  const allPaths = allGpxRelativePaths(exportRoot);
  // Partial archives are not evidence that omitted GPX files were deleted.
  if (!preserveAbsent) store.pruneOrphanRoutes(allPaths);
  let importedRouteCount = 0;
  let missingRouteCount = 0;
  let pointCount = 0;
  let skippedRouteCount = 0;
  const changedRouteIds: string[] = [];
  const bundleHash = createHash("sha256");

  for (const relativePath of allPaths) {
    const key = relativePath.toLowerCase();
    const referenced = referencedTargets.get(key);
    const routeId = referenced
      ? referenced.id
      : store.ensureOrphanRoute(
          stableId("route", ["orphan", relativePath]),
          relativePath,
          preserveAbsent ? { preserveAbsent: true } : undefined
        );

    const fullPath = safelyResolve(exportRoot, relativePath);
    if (!fullPath || !existsSync(fullPath)) {
      if (preserveAbsent) continue;
      store.markRouteStatus(routeId, "missing");
      changedRouteIds.push(routeId);
      missingRouteCount += 1;
      continue;
    }

    try {
      const stat = statSync(fullPath);
      const cached = store.database.prepare(`
        SELECT fingerprint.size_bytes AS sizeBytes,
               fingerprint.modified_at_ms AS modifiedAtMs,
               fingerprint.sha256,
               fingerprint.route_id AS routeId,
               fingerprint.point_count AS pointCount,
               route.file_status AS fileStatus,
               route.point_count AS routePointCount,
               (SELECT COUNT(*) FROM route_points point
                WHERE point.route_id = fingerprint.route_id) AS storedPointCount
        FROM route_file_fingerprints fingerprint
        LEFT JOIN workout_routes route ON route.id = fingerprint.route_id
        WHERE fingerprint.relative_path = ?
      `).get(relativePath) as unknown as {
        sizeBytes: number; modifiedAtMs: number; sha256: string; routeId: string;
        pointCount: number; fileStatus: string | null; routePointCount: number | null;
        storedPointCount: number;
      } | undefined;
      const currentSha256 = await hashFile(fullPath);
      if (
        cached &&
        cached.sha256 === currentSha256 &&
        cached.routeId === routeId &&
        cached.fileStatus === "imported" &&
        cached.routePointCount === cached.pointCount &&
        cached.storedPointCount === cached.pointCount
      ) {
        bundleHash.update(relativePath, "utf8");
        bundleHash.update("\0");
        bundleHash.update(cached.sha256, "utf8");
        bundleHash.update("\0");
        skippedRouteCount += 1;
        pointCount += cached.pointCount;
        continue;
      }
      store.beginRoutePointReplacement(routeId);
      const { pointCount: importedPoints, sha256 } = await parseGpxFile(
        fullPath,
        (points) => store.appendRoutePoints(routeId, points)
      );
      bundleHash.update(relativePath, "utf8");
      bundleHash.update("\0");
      bundleHash.update(sha256, "utf8");
      bundleHash.update("\0");
      store.completeRoutePointReplacement(routeId, importedPoints);
      store.database.prepare(`
        INSERT INTO route_file_fingerprints (
          relative_path, size_bytes, modified_at_ms, sha256, route_id, point_count, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(relative_path) DO UPDATE SET
          size_bytes = excluded.size_bytes, modified_at_ms = excluded.modified_at_ms,
          sha256 = excluded.sha256, route_id = excluded.route_id,
          point_count = excluded.point_count, imported_at = excluded.imported_at
      `).run(relativePath, stat.size, stat.mtimeMs, sha256, routeId, importedPoints, new Date().toISOString());
      importedRouteCount += 1;
      changedRouteIds.push(routeId);
      pointCount += importedPoints;
    } catch (error) {
      store.markRouteStatus(routeId, "invalid");
      store.database.prepare(
        "DELETE FROM route_file_fingerprints WHERE relative_path = ?"
      ).run(relativePath);
      changedRouteIds.push(routeId);
      store.insertIssue({
        severity: "warning",
        code: "INVALID_GPX",
        objectId: routeId,
        message: error instanceof Error ? error.message : "Unable to parse GPX route"
      });
    }
  }

  if (!preserveAbsent) {
    const currentPaths = new Set(allPaths.map((path) => path.toLowerCase()));
    const cachedPaths = store.database.prepare("SELECT relative_path AS relativePath FROM route_file_fingerprints")
      .all() as unknown as Array<{ relativePath: string }>;
    const deleteFingerprint = store.database.prepare("DELETE FROM route_file_fingerprints WHERE relative_path = ?");
    for (const cached of cachedPaths) {
      if (!currentPaths.has(cached.relativePath.toLowerCase())) deleteFingerprint.run(cached.relativePath);
    }

    for (const [key, target] of referencedTargets) {
      if (allPaths.some((path) => path.toLowerCase() === key)) continue;
      store.markRouteStatus(target.id, "missing");
      changedRouteIds.push(target.id);
      missingRouteCount += 1;
    }
  }

  store.setManifest("gpx_file_count", String(allPaths.length));
  store.setManifest("gpx_point_count", String(pointCount));
  // Subset archives must hash remaining fingerprints, not only files in this ZIP.
  store.setManifest(
    "source_gpx_bundle_sha256",
    preserveAbsent ? bundleHashFromFingerprints(store) : bundleHash.digest("hex")
  );
  store.flush();

  return {
    routeFileCount: allPaths.length,
    importedRouteCount,
    missingRouteCount,
    pointCount,
    skippedRouteCount,
    changedRouteIds
  };
}
