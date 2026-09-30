import type { DatabaseSync } from "node:sqlite";

export interface PredictionRecoveryReadings {
  recentRestingHeartRate: number | null;
  baselineRestingHeartRate: number | null;
  recentHrv: number | null;
  baselineHrv: number | null;
  latestSleepMinutes: number | null;
  baselineSleepMinutes: number | null;
  provenance: PredictionRecoveryProvenance;
}

export interface PredictionRecoveryProvenance {
  hrvSource: "canonical" | "raw_compat" | "none";
  sleepSource: "canonical" | "none";
  source: "canonical" | "raw_compat" | "mixed" | "none";
  coverage: "full" | "partial" | "none";
  latestObservedAt: string | null;
  /**
   * 系统**何时知道**这批事实（canonical 用 `computed_at`、原始记录用 `created_at`）。
   *
   * 与 `latestObservedAt`（事实**何时发生**）是两件事：一条昨晚的睡眠可以在今天才被算出来，
   * 观测时间早于 `asOf` 而到达时间晚于 `asOf` —— 那在 `as_known_then` 下是**未来信息**。
   * 两个字段都取自**产出数值的同一批行**（同一条 SQL 的同一 WHERE），不另写一份筛选条件。
   */
  latestAvailableAt: string | null;
  /**
   * 至少有一个**参与计算**的信号拿不到到达时间（原始路径缺 `created_at`，或该源没有
   * 到达列）⇒ 它的可用性**未知**。未知不得被当作"已可用"。
   */
  availabilityUnknown: boolean;
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

  /**
   * `health_records` 的筛选条件与绑定值。
   * 数值查询与到达时间查询**共用这一份**：两处各写一遍 WHERE 迟早会分叉，
   * 而分叉的后果是"算数用了一批行、判可用性用了另一批"，且不会报错。
   */
  private rawMetricScope(
    type: string,
    startAt: string,
    endAt: string
  ): { where: string; args: Array<string> } {
    const hasCompletion = this.hasColumn("health_records", "end_at");
    return {
      where: `WHERE type = ?
          AND value_numeric IS NOT NULL
          AND start_at >= ?
          AND start_at < ?
          ${hasCompletion ? "AND end_at < ?" : ""}`,
      args: hasCompletion ? [type, startAt, endAt, endAt] : [type, startAt, endAt]
    };
  }

  private rawMetricMedian(
    type: string,
    startAt: string,
    endAt: string
  ): number | null {
    const scope = this.rawMetricScope(type, startAt, endAt);
    const rows = this.database
      .prepare(`SELECT value_numeric AS value FROM health_records ${scope.where}`)
      .all(...scope.args) as unknown as Array<{ value: number }>;
    return median(rows
      .map((row) => Number(row.value))
      .filter((value) => Number.isFinite(value)));
  }

  /** 原始记录的到达时间 = 导入时间（`created_at`）。缺列 ⇒ 可用性**未知**，不是"未到达"。 */
  private rawMetricArrival(
    type: string,
    startAt: string,
    endAt: string
  ): { latestAvailableAt: string | null; arrivalKnown: boolean } {
    if (!this.hasColumn("health_records", "created_at")) {
      return { latestAvailableAt: null, arrivalKnown: false };
    }
    const scope = this.rawMetricScope(type, startAt, endAt);
    const row = this.database
      .prepare(`SELECT MAX(created_at) AS latestAt FROM health_records ${scope.where}`)
      .get(...scope.args) as { latestAt?: string | null } | undefined;
    const latestAt = typeof row?.latestAt === "string" ? row.latestAt : null;
    return { latestAvailableAt: latestAt, arrivalKnown: latestAt !== null };
  }

  private rawMetricLatestAt(type: string, startAt: string, endAt: string): string | null {
    const hasCompletion = this.hasColumn("health_records", "end_at");
    const completionFilter = hasCompletion ? "AND end_at < ?" : "";
    const row = this.database
      .prepare(`
        SELECT MAX(start_at) AS latestAt
        FROM health_records
        WHERE type = ?
          AND value_numeric IS NOT NULL
          AND start_at >= ?
          AND start_at < ?
          ${completionFilter}
      `)
      .get(...(hasCompletion
        ? [type, startAt, endAt, endAt]
        : [type, startAt, endAt])) as { latestAt?: string } | undefined;
    return typeof row?.latestAt === "string" ? row.latestAt : null;
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
    // 到达时间与数值取自**同一条 SELECT 的同一 WHERE**：canonical 的到达时间就是 `computed_at`。
    const hrvMedian = (
      startAt: string,
      endAt: string
    ): { value: number | null; latestAvailableAt: string | null; arrivalKnown: boolean } => {
      if (!hasCanonicalHrv) {
        return { ...this.rawMetricArrival("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", startAt, endAt),
          value: this.rawMetricMedian("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", startAt, endAt) };
      }
      const rows = this.database
        .prepare(`
          SELECT hrv_sdnn_ms AS value${this.hasColumn("canonical_hrv_days", "computed_at") ? ", computed_at AS availableAt" : ", NULL AS availableAt"}
          FROM canonical_hrv_days
          WHERE timezone_identifier = ?
            AND confidence <> 'missing'
            AND hrv_sdnn_ms IS NOT NULL
            AND window_end_at IS NOT NULL
            AND window_end_at >= ?
            AND window_end_at < ?
        `)
        .all(timezoneIdentifier, startAt, endAt) as unknown as Array<{ value: number; availableAt: string | null }>;
      const available = rows
        .map((row) => row.availableAt)
        .filter((value): value is string => typeof value === "string" && value !== "")
        .sort();
      return {
        value: median(rows
          .map((row) => Number(row.value))
          .filter((value) => Number.isFinite(value))),
        latestAvailableAt: available.at(-1) ?? null,
        arrivalKnown: rows.length > 0 && available.length === rows.length
      };
    };

    const recentHrvReading = hrvMedian(sevenDaysAgo, effectiveAsOf);
    const baselineHrvReading = hrvMedian(thirtyFiveDaysAgo, sevenDaysAgo);
    const recentHrv = recentHrvReading.value;
    const baselineHrv = baselineHrvReading.value;

    let latestSleepMinutes: number | null = null;
    let baselineSleepMinutes: number | null = null;
    let sleepLatestAvailableAt: string | null = null;
    let sleepArrivalKnown = false;
    if (this.hasTable("canonical_nights")) {
      // 到达列可能不存在（精简 fixture / 更早的库）⇒ 那时可用性**未知**，不是"已可用"。
      const nightsHasComputedAt = this.hasColumn("canonical_nights", "computed_at");
      const latest = this.database
        .prepare(`
          SELECT asleep_union_minutes AS value${nightsHasComputedAt ? ", computed_at AS availableAt" : ", NULL AS availableAt"}
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
        .get(timezoneIdentifier, sevenDaysAgo, effectiveAsOf) as
        { value?: number; availableAt?: string | null } | undefined;
      latestSleepMinutes = latest?.value == null || !Number.isFinite(Number(latest.value))
        ? null
        : Number(latest.value);
      const baseline = this.database
        .prepare(`
          SELECT AVG(asleep_union_minutes) AS value,
            ${nightsHasComputedAt ? "MAX(computed_at)" : "NULL"} AS latestAvailableAt,
            ${nightsHasComputedAt ? "COUNT(computed_at)" : "0"} AS rowsWithArrival,
            COUNT(*) AS rows
          FROM canonical_nights
          WHERE kind = 'main'
            AND timezone_identifier = ?
            AND wake_at IS NOT NULL
            AND asleep_union_minutes IS NOT NULL
            AND wake_at >= ?
            AND wake_at < ?
        `)
        .get(timezoneIdentifier, thirtyFiveDaysAgo, sevenDaysAgo) as
        { value?: number; latestAvailableAt?: string | null; rows?: number; rowsWithArrival?: number } | undefined;
      // 到达时间取「参与计算的那批行」里最晚的一个：用一个可能未被用于数值的行会更保守，
      // 但也可能把"没用到的迟到数据"算成证据，所以宁可只用同一批。
      const arrivals = [latest?.availableAt ?? null, baseline?.latestAvailableAt ?? null]
        .filter((value): value is string => typeof value === "string" && value !== "")
        .sort();
      sleepLatestAvailableAt = arrivals.at(-1) ?? null;
      baselineSleepMinutes = baseline?.value == null || !Number.isFinite(Number(baseline.value))
        ? null
        : Number(baseline.value);
      // 「算出了睡眠值」的那几段都必须有到达时间，否则可用性未知；
      // 完全没算出值 ⇒ 这个信号不参与，不算未知。
      const sleepContributes = latestSleepMinutes !== null || baselineSleepMinutes !== null;
      const latestArrivalKnown = latestSleepMinutes === null || (latest?.availableAt ?? null) !== null;
      const baselineArrivalKnown = baselineSleepMinutes === null ||
        Number(baseline?.rows ?? 0) === Number(baseline?.rowsWithArrival ?? 0);
      sleepArrivalKnown = !sleepContributes || (latestArrivalKnown && baselineArrivalKnown);
    }

    const hasCanonicalNights = this.hasTable("canonical_nights");
    const hrvLatestAt = hasCanonicalHrv
      ? (this.database.prepare(`
          SELECT MAX(window_end_at) AS latestAt
          FROM canonical_hrv_days
          WHERE timezone_identifier = ?
            AND confidence <> 'missing'
            AND hrv_sdnn_ms IS NOT NULL
            AND window_end_at IS NOT NULL
            AND window_end_at >= ?
            AND window_end_at < ?
        `).get(timezoneIdentifier, thirtyFiveDaysAgo, effectiveAsOf) as { latestAt?: string } | undefined)?.latestAt ?? null
      : this.rawMetricLatestAt("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", thirtyFiveDaysAgo, effectiveAsOf);
    const sleepLatestAt = hasCanonicalNights
      ? (this.database.prepare(`
          SELECT MAX(wake_at) AS latestAt
          FROM canonical_nights
          WHERE kind = 'main'
            AND timezone_identifier = ?
            AND wake_at IS NOT NULL
            AND asleep_union_minutes IS NOT NULL
            AND wake_at >= ?
            AND wake_at < ?
        `).get(timezoneIdentifier, thirtyFiveDaysAgo, effectiveAsOf) as { latestAt?: string } | undefined)?.latestAt ?? null
      : null;
    const latestObservedAt = [
      this.rawMetricLatestAt("HKQuantityTypeIdentifierRestingHeartRate", thirtyFiveDaysAgo, effectiveAsOf),
      hrvLatestAt,
      sleepLatestAt
    ].filter((value): value is string => value !== null).sort().at(-1) ?? null;
    const availableComponents = [
      recentRestingHeartRate !== null && baselineRestingHeartRate !== null,
      recentHrv !== null && baselineHrv !== null,
      latestSleepMinutes !== null && baselineSleepMinutes !== null
    ].filter(Boolean).length;
    const contributesRestingHeartRate = recentRestingHeartRate !== null && baselineRestingHeartRate !== null;
    const contributesHrv = recentHrv !== null && baselineHrv !== null;
    const contributesSleep = latestSleepMinutes !== null && baselineSleepMinutes !== null;
    const contributesCanonical = contributesSleep || (contributesHrv && hasCanonicalHrv);
    const contributesRaw = contributesRestingHeartRate || (contributesHrv && !hasCanonicalHrv);
    // 到达时间只从**参与计算的信号**里取。不参与的信号即使迟到，也不是这批证据的一部分。
    const rhrRecentArrival = this.rawMetricArrival(
      "HKQuantityTypeIdentifierRestingHeartRate", sevenDaysAgo, effectiveAsOf);
    const rhrBaselineArrival = this.rawMetricArrival(
      "HKQuantityTypeIdentifierRestingHeartRate", thirtyFiveDaysAgo, sevenDaysAgo);
    const contributingArrivals: Array<string | null> = [];
    let availabilityUnknown = false;
    if (contributesRestingHeartRate) {
      contributingArrivals.push(rhrRecentArrival.latestAvailableAt, rhrBaselineArrival.latestAvailableAt);
      if (!rhrRecentArrival.arrivalKnown || !rhrBaselineArrival.arrivalKnown) availabilityUnknown = true;
    }
    if (contributesHrv) {
      contributingArrivals.push(recentHrvReading.latestAvailableAt, baselineHrvReading.latestAvailableAt);
      if (!recentHrvReading.arrivalKnown || !baselineHrvReading.arrivalKnown) availabilityUnknown = true;
    }
    if (contributesSleep) {
      contributingArrivals.push(sleepLatestAvailableAt);
      if (!sleepArrivalKnown) availabilityUnknown = true;
    }
    const latestAvailableAt = contributingArrivals
      .filter((value): value is string => typeof value === "string" && value !== "")
      .sort()
      .at(-1) ?? null;
    return {
      recentRestingHeartRate,
      baselineRestingHeartRate,
      recentHrv,
      baselineHrv,
      latestSleepMinutes,
      baselineSleepMinutes,
      provenance: {
        hrvSource: hasCanonicalHrv
          ? (recentHrv === null && baselineHrv === null ? "none" : "canonical")
          : (recentHrv === null && baselineHrv === null ? "none" : "raw_compat"),
        sleepSource: hasCanonicalNights && (latestSleepMinutes !== null || baselineSleepMinutes !== null)
          ? "canonical"
          : "none",
        source: availableComponents === 0
          ? "none"
          : contributesCanonical && contributesRaw
            ? "mixed"
            : contributesRaw
              ? "raw_compat"
              : "canonical",
        coverage: availableComponents === 0 ? "none" : availableComponents === 3 ? "full" : "partial",
        latestObservedAt,
        latestAvailableAt,
        availabilityUnknown
      }
    };
  }
}
