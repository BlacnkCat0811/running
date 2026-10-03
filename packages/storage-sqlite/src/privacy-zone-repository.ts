import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

/**
 * Privacy zones for shared route cards (docs/WEB.md, docs/DECISIONS.md D9).
 *
 * Lives in the main database so it survives the backup/restore path — see
 * `v26-migration.ts` for why that matters more here than for ordinary settings.
 *
 * The write path is a whole-collection replace guarded by `expectedRevision`,
 * the same concurrency contract the mobile goals use: a second writer that read a
 * stale list is rejected instead of silently dropping a zone somebody just added.
 */

export interface StoredPrivacyZone {
  id: string;
  label: string;
  centerLatitude: number;
  centerLongitude: number;
  radiusMeters: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a caller supplies. `updatedAt` is deliberately absent: the write stamps it,
 * so a client cannot backdate a zone and a retry cannot look like a new edit.
 */
export type PrivacyZoneInput = Omit<StoredPrivacyZone, "updatedAt">;

export class PrivacyZoneRevisionConflictError extends Error {
  readonly code = "privacy_zone_revision_conflict";
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(expectedRevision === actualRevision
      ? "Privacy zone contents changed after a restore or another write; reload before saving"
      : `Privacy zones changed: expected revision ${expectedRevision}, found ${actualRevision}`);
  }
}

export class PrivacyZoneValidationError extends Error {
  readonly code = "privacy_zone_invalid";
}

const MAXIMUM_ZONES = 20;
const MAXIMUM_RADIUS_METERS = 5000;

function assertZone(zone: PrivacyZoneInput): void {
  if (typeof zone.id !== "string" || zone.id.length === 0) {
    throw new PrivacyZoneValidationError("privacy zone id must be a non-empty string");
  }
  if (typeof zone.label !== "string" || zone.label.trim().length === 0) {
    throw new PrivacyZoneValidationError("privacy zone label must not be empty");
  }
  if (!Number.isFinite(zone.centerLatitude) || zone.centerLatitude < -90 || zone.centerLatitude > 90) {
    throw new PrivacyZoneValidationError("privacy zone latitude out of range");
  }
  if (!Number.isFinite(zone.centerLongitude) || zone.centerLongitude < -180 || zone.centerLongitude > 180) {
    throw new PrivacyZoneValidationError("privacy zone longitude out of range");
  }
  if (!Number.isFinite(zone.radiusMeters) || zone.radiusMeters <= 0 || zone.radiusMeters > MAXIMUM_RADIUS_METERS) {
    throw new PrivacyZoneValidationError(`privacy zone radius must be within (0, ${MAXIMUM_RADIUS_METERS}] metres`);
  }
}

export class SqlitePrivacyZoneRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(): StoredPrivacyZone[] {
    const rows = this.database
      .prepare("SELECT * FROM privacy_zones ORDER BY created_at, id")
      .all() as unknown as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      centerLatitude: Number(row.center_latitude),
      centerLongitude: Number(row.center_longitude),
      radiusMeters: Number(row.radius_meters),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }

  revision(): number {
    const row = this.database
      .prepare("SELECT revision FROM privacy_zone_revisions WHERE singleton = 1")
      .get() as { revision?: unknown } | undefined;
    return Number(row?.revision ?? 0);
  }

  /** Revision alone can repeat after a restore; bind writes to the exact state read. */
  stateToken(): string {
    return createHash("sha256").update(JSON.stringify({ revision: this.revision(), zones: this.list() })).digest("hex");
  }

  /**
   * Replaces the whole collection. Returns the new revision.
   *
   * Idempotent per revision: repeating a write with the same `expectedRevision`
   * after it succeeded is rejected, which is what makes a client retry safe to
   * surface (the caller re-reads instead of guessing).
   */
  replace(zones: readonly PrivacyZoneInput[], expectedRevision: number, expectedStateToken?: string): number {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new PrivacyZoneValidationError("expectedRevision must be a non-negative integer");
    }
    if (zones.length > MAXIMUM_ZONES) {
      throw new PrivacyZoneValidationError(`at most ${MAXIMUM_ZONES} privacy zones are supported`);
    }
    for (const zone of zones) assertZone(zone);
    const unique = new Set(zones.map((zone) => zone.id));
    if (unique.size !== zones.length) {
      throw new PrivacyZoneValidationError("privacy zone ids must be unique");
    }

    this.database.exec("SAVEPOINT rai_privacy_zones");
    try {
      const current = this.revision();
      if (current !== expectedRevision || (expectedStateToken !== undefined && expectedStateToken !== this.stateToken())) {
        throw new PrivacyZoneRevisionConflictError(expectedRevision, current);
      }
      const now = new Date().toISOString();
      this.database.prepare("DELETE FROM privacy_zones").run();
      const insert = this.database.prepare(`
        INSERT INTO privacy_zones (id, label, center_latitude, center_longitude, radius_meters, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const zone of zones) {
        insert.run(
          zone.id,
          zone.label,
          zone.centerLatitude,
          zone.centerLongitude,
          zone.radiusMeters,
          zone.createdAt,
          now
        );
      }
      const next = current + 1;
      this.database
        .prepare("UPDATE privacy_zone_revisions SET revision = ?, updated_at = ? WHERE singleton = 1")
        .run(next, now);
      this.database.exec("RELEASE rai_privacy_zones");
      return next;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK TO rai_privacy_zones; RELEASE rai_privacy_zones");
      } catch {
        // Preserve the original error if SQLite already closed the transaction.
      }
      throw error;
    }
  }
}
