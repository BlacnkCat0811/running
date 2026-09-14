import type { DatabaseSync } from "node:sqlite";

export interface PredictionRecoveryReadings {
  recentRestingHeartRate: number | null;
  baselineRestingHeartRate: number | null;
  recentHrv: number | null;
  baselineHrv: number | null;
  latestSleepMinutes: number | null;
  baselineSleepMinutes: number | null;
}

/**
 * SQLite cannot bind identifiers, so a few statements interpolate a table or
 * column name. Every caller passes a literal; this keeps that a requirement
 * instead of an assumption, so a future caller passing user input fails closed.
 */
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (upper === undefined) return null;
  return sorted.length % 2 === 0 && lower !== undefined
    ? (lower + upper) / 2
    : upper;
}

export class SqlitePredictionRecoveryReadRepository {
  constructor(private readonly database: DatabaseSync) {}

  private hasTable(name: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { present?: number } | undefined;
    return row?.present === 1;
  }

  private hasColumn(table: string, name: string): boolean {
    if (!SAFE_SQL_IDENTIFIER.test(table)) return false;
    const columns = this.database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as Array<{ name: string }>;
    return columns.some((column) => column.name === name);
  }

  private rawMetricMedian(
    type: string,
    startAt: string,
    endAt: string
  ): number | null {
    const hasCompletion = this.hasColumn("health_records", "end_at");
    const completionFilter = hasCompletion ? "AND end_at < ?" : "";
    const rows = this.database
      .prepare(`
        SELECT value_numeric AS value
        FROM health_records
        WHERE type = ?
          AND value_numeric IS NOT NULL
          AND start_at >= ?
          AND start_at < ?
          ${completionFilter}
      `)
      .all(...(hasCompletion
        ? [type, startAt, endAt, endAt]
        : [type, startAt, endAt])) as unknown as Array<{ value: number }>;
    return median(rows
      .map((row) => Number(row.value))
      .filter((value) => Number.isFinite(value)));
  }

  load(asOfIso: string, timezoneIdentifier: string): PredictionRecoveryReadings {
    const asOfMs = Date.parse(asOfIso);
    if (!Number.isFinite(asOfMs)) throw new Error("asOfIso must be a valid date-time");
    if (!timezoneIdentifier) throw new Error("timezoneIdentifier is required");
    const effectiveAsOf = new Date(asOfMs).toISOString();
    const sevenDaysAgo = new Date(asOfMs - 7 * 86_400_000).toISOString();
    const thirtyFiveDaysAgo = new Date(asOfMs - 35 * 86_400_000).toISOString();

    const recentRestingHeartRate = this.rawMetricMedian(
      "HKQuantityTypeIdentifierRestingHeartRate", sevenDaysAgo, effectiveAsOf
    );
    const baselineRestingHeartRate = this.rawMetricMedian(
      "HKQuantityTypeIdentifierRestingHeartRate", thirtyFiveDaysAgo, sevenDaysAgo
    );

    const hasCanonicalHrv = this.hasTable("canonical_hrv_days");
    const hrvMedian = (startAt: string, endAt: string): number | null => {
      if (!hasCanonicalHrv) {
        return this.rawMetricMedian("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", startAt, endAt);
      }
      const rows = this.database
        .prepare(`
          SELECT hrv_sdnn_ms AS value
          FROM canonical_hrv_days
          WHERE timezone_identifier = ?
            AND confidence <> 'missing'
            AND hrv_sdnn_ms IS NOT NULL
            AND window_end_at IS NOT NULL
            AND window_end_at >= ?
            AND window_end_at < ?
        `)
        .all(timezoneIdentifier, startAt, endAt) as unknown as Array<{ value: number }>;
      return median(rows
        .map((row) => Number(row.value))
        .filter((value) => Number.isFinite(value)));
    };

    const recentHrv = hrvMedian(sevenDaysAgo, effectiveAsOf);
    const baselineHrv = hrvMedian(thirtyFiveDaysAgo, sevenDaysAgo);

    let latestSleepMinutes: number | null = null;
    let baselineSleepMinutes: number | null = null;
    if (this.hasTable("canonical_nights")) {
      const latest = this.database
        .prepare(`
          SELECT asleep_union_minutes AS value
          FROM canonical_nights
          WHERE kind = 'main'
            AND timezone_identifier = ?
            AND wake_at IS NOT NULL
            AND asleep_union_minutes IS NOT NULL
            AND wake_at >= ?
            AND wake_at < ?
          ORDER BY wake_at DESC
          LIMIT 1
        `)
        .get(timezoneIdentifier, sevenDaysAgo, effectiveAsOf) as { value?: number } | undefined;
      latestSleepMinutes = latest?.value == null || !Number.isFinite(Number(latest.value))
        ? null
        : Number(latest.value);
      const baseline = this.database
        .prepare(`
          SELECT AVG(asleep_union_minutes) AS value
          FROM canonical_nights
          WHERE kind = 'main'
            AND timezone_identifier = ?
            AND wake_at IS NOT NULL
            AND asleep_union_minutes IS NOT NULL
            AND wake_at >= ?
            AND wake_at < ?
        `)
        .get(timezoneIdentifier, thirtyFiveDaysAgo, sevenDaysAgo) as { value?: number } | undefined;
      baselineSleepMinutes = baseline?.value == null || !Number.isFinite(Number(baseline.value))
        ? null
        : Number(baseline.value);
    }

    return {
      recentRestingHeartRate,
      baselineRestingHeartRate,
      recentHrv,
      baselineHrv,
      latestSleepMinutes,
      baselineSleepMinutes
    };
  }
}
