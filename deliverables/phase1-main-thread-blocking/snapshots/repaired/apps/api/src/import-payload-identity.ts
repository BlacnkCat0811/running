import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { digestHealthKitExportContent } from "./import-sources.js";

/**
 * Payload identity — the "did this payload change anything?" question, answered
 * *before* the import pays for a backup, a staging copy, or a parse.
 *
 * ## Why a separate identity, and why it cannot reuse `dataset_version`
 *
 * `dataset_version` (and `source_xml_sha256` beneath it) is a derived value over
 * the *raw* `export.xml`, which carries `<ExportDate>` — the wall clock the
 * exporter stamps on every export. It therefore moves on every sync of a dataset
 * that did not change by a single row. That made it useless as a change
 * judgement, which is why `analyzeDatasetChange` stopped comparing it.
 *
 * The identity computed here is the opposite: it is derived only from things a
 * *re-export of the same data* reproduces exactly (see
 * `digestHealthKitExportContent`), so an unchanged payload keeps an unchanged
 * identity.
 *
 * ## What the anchor is bound to
 *
 * An identity alone is not enough to skip work, because "this payload is the same
 * bytes as last time" does not imply "applying it now changes nothing": another
 * source may have imported in between and moved rows this payload also carries.
 * The anchor therefore also records the `dataset_version` the database carried
 * once this payload had been applied, and a pre-flight hit requires the database
 * to *still* report that same version. Any later import rewrites
 * `dataset_version`, so it invalidates the anchor — which is exactly the intended
 * direction, because `dataset_version` drifting too eagerly can only cost an
 * optimisation, never correctness.
 *
 * The composite also folds in the parser contract version, the deletion
 * semantics, and the execution engine, because each of those changes what the
 * same payload would write.
 *
 * ## What the anchor still cannot notice by itself
 *
 * A change that the payload cannot show — one that alters the ids or content
 * hashes *derived from* the same rows. `stableId` is the live example:
 * canonicalising its object keys rewrote `record_content` / `workout_content`
 * for every row while leaving the payload bytes (and therefore
 * `dataset_version`) untouched.
 *
 * Two mechanisms now cover that, and they cover different halves:
 *
 *  1. `identityAlgorithm` folds `identityAlgorithmFingerprint()` into this
 *     digest, so an algorithm change invalidates the anchor **by itself** and
 *     costs one full import — which is exactly what it should cost. Nothing has
 *     to be remembered. See `identity-algorithm.ts` in
 *     `@rai/health-export-parser`.
 *  2. `CONTRACT_VERSION` stays the *manual* half, for a change to what the
 *     payload **means** (parsing or normalisation rules) that leaves every
 *     derived id where it was. No function can compute that one, so it remains a
 *     human decision — but the algorithm half is no longer silent about it: the
 *     sentinel in `identity-algorithm.test.ts` fails and names both.
 */

/** `import_manifest` key holding the identity of the payload behind the database. */
export const IMPORT_PAYLOAD_ANCHOR_KEY = "source_payload_anchor";

/** `import_manifest` key holding the dataset version the anchor was recorded against. */
export const IMPORT_DATASET_VERSION_KEY = "dataset_version";

export interface ImportPayloadAnchor {
  /**
   * Composite payload identity; see {@link importPayloadSha256}. Never the raw
   * file hash — two re-exports of identical data must agree.
   */
  sha256: string;
  /** `dataset_version` the database carried once this payload had been applied. */
  datasetVersion: string;
}

export interface ImportPayloadContext {
  /**
   * Whether absence from the payload may be read as deletion. A deleting payload
   * is never allowed to short-circuit: replaying an identical complete snapshot
   * after another source imported *does* remove that other source's rows.
   */
  preserveAbsent: boolean;
  /** `CONTRACT_VERSION` of the parser that would apply the payload. */
  contractVersion: string;
  /**
   * Execution engine as `<name>@<version>` (`typescript@0.1.0`, `rust@0.1.0`).
   *
   * The version is not decoration: the engine decides *what gets written*, so a
   * native binary upgrade that leaves `name` alone must still move this digest.
   * Folding in the bare name is what would let an upgraded worker re-apply its
   * old results with the anchor still matching.
   */
  engine: string;
  /**
   * `identityAlgorithmFingerprint()` of the parser that would apply this payload.
   *
   * Folding it in is what makes "the algorithm changed while the payload bytes
   * did not" self-correcting: the anchor misses, the full path runs, and the new
   * algorithm reaches the database. Optional so a caller with no algorithm to
   * report (a fixture, an older embedder) hashes exactly as it did before this
   * field existed.
   */
  identityAlgorithm?: string;
}

export interface DatabaseImportIdentity {
  anchor: ImportPayloadAnchor | null;
  datasetVersion: string | null;
}

/**
 * Canonical composite of everything that decides whether the same payload bytes
 * would write the same rows.
 *
 * Pure and total, so both the recording and the comparing side can be exercised
 * without a database or a payload directory.
 */
export function importPayloadSha256(contentSha256: string, context: ImportPayloadContext): string {
  const hash = createHash("sha256")
    .update("rai.import-payload.v1\0")
    .update(context.contractVersion)
    .update("\0")
    .update(context.preserveAbsent ? "preserve" : "replace")
    .update("\0")
    .update(context.engine)
    .update("\0")
    .update(contentSha256);
  // Appended rather than interleaved, so a context without an `identityAlgorithm`
  // hashes exactly as it did before the field existed. Only a caller that
  // actually reports an algorithm moves its digest — which is the point: an
  // algorithm change must invalidate the anchor by itself, not be remembered.
  if (context.identityAlgorithm) hash.update("\0").update(context.identityAlgorithm);
  return hash.digest("hex");
}

/**
 * Identity of the payload sitting at `exportRoot`, computed by reading the
 * payload — never by reading the database. This is the whole point of the
 * pre-flight: the work is proportional to the payload, not to the 506 MB
 * database behind it.
 */
export async function computeImportPayloadSha256(
  exportRoot: string,
  context: ImportPayloadContext
): Promise<string> {
  return importPayloadSha256(await digestHealthKitExportContent(exportRoot), context);
}

function parseAnchor(value: string | undefined): ImportPayloadAnchor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as { sha256?: unknown; datasetVersion?: unknown };
    const sha256 = parsed.sha256;
    const datasetVersion = parsed.datasetVersion;
    // A malformed anchor must read as "no anchor": the pre-flight then falls back
    // to the full path, which is always correct. Refusing to guess is the whole
    // contract here.
    if (typeof sha256 !== "string" || sha256.length === 0) return null;
    if (typeof datasetVersion !== "string" || datasetVersion.length === 0) return null;
    return { sha256, datasetVersion };
  } catch {
    return null;
  }
}

/**
 * Reads the anchor and the current dataset version from an **already-open**
 * connection. Split out of `readDatabaseImportIdentity` (2026-10-15, R2) so a
 * caller that owns a write transaction can re-verify "the database still
 * corresponds to this payload" **inside** that transaction — the no-op receipt
 * writer does exactly that between its verification and its commit.
 */
export function readImportIdentityInDatabase(database: DatabaseSync): DatabaseImportIdentity {
  const rows = database
    .prepare("SELECT key, value FROM import_manifest WHERE key IN (?, ?)")
    .all(IMPORT_PAYLOAD_ANCHOR_KEY, IMPORT_DATASET_VERSION_KEY) as unknown as Array<{
      key: string;
      value: string;
    }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    anchor: parseAnchor(values.get(IMPORT_PAYLOAD_ANCHOR_KEY)),
    datasetVersion: values.get(IMPORT_DATASET_VERSION_KEY) ?? null
  };
}

/**
 * Reads the anchor and the current dataset version from one connection.
 *
 * Returns `null` only when the database is absent or unreadable — which the
 * caller must treat as "no basis for a short-circuit". Anything unexpected
 * degrades to `null` rather than throwing, because a pre-flight that cannot prove
 * its case must not be able to fail an import.
 */
export function readDatabaseImportIdentity(databasePath: string): DatabaseImportIdentity | null {
  if (!existsSync(databasePath)) return null;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    return readImportIdentityInDatabase(database);
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
