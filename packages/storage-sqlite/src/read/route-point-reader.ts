import type { DatabaseSync } from "node:sqlite";

import { usableRouteConditionSql } from "../sql/fragments.js";
import { nullableNumber } from "./read-utils.js";

/**
 * **唯一**的路线点读取入口（O11 / WP-50，`docs/IOS_SYNC_PERFORMANCE_REVIEW.md` §O11）。
 *
 * ## 为什么必须只有一个入口
 *
 * 2026-10-16 实测的读端有**四份**"这条路线有没有点"的判据，分布在
 * `read/facts-reader.ts`、`read/series-read-repository.ts`（两处**一个字都不判**）、
 * `read/workout-read-repository.ts`、`read/audit-read-repository.ts`、
 * `recompute-pipeline.ts`（`loadRouteQuality` 判 `file_status='imported'`、
 * 隔壁 `loadElevationGain` 不判）、`health-export-parser`（指纹校验与审计计数）、
 * `migrate-cli.ts`、`scripts/normalization-coverage.mts`，以及 Rust 侧的 `aggregate()`。
 * 判据多写一遍不会立刻出错，它只是**等**一个"只有一边被改"的提交 ——
 * `loadRouteQuality` / `loadElevationGain` 的不对称就是已经发生的那一次：
 * 同一次训练能贡献高程、却给不出一个点。
 *
 * 本模块把两件事收成一处：
 *
 * 1. **取数关系**：只读 `readable_route_points` 视图（v43）。视图按
 *    `workout_routes.published_route_version_id` 把两条分支切开 ——
 *    有指针的路线读 `route_version_points`（指针指向的那条 `complete` 版本），
 *    指针为 NULL 的老路线读 `route_points`。**判据（`file_status='imported' AND
 *    point_count>0`）写在视图里**，所以任何调用方都不可能"忘了过滤"：
 *    忘了也只是读到同一份可读集合。
 * 2. **判据本体**：`usableRouteConditionSql()`（`sql/fragments.ts`）—— 与写侧
 *    `RaiDatabase.hasUsableRoute()` 同源。视图 SQL 逐字包含它，结构判据在
 *    `test/route-point-reader.test.ts` 里把两者钉死。
 *
 * ## legacy 路线答的是什么
 *
 * **指针为 NULL 的路线仍然可读，而且读的就是 `route_points` 那张表。** 退役双写
 * ≠ 删表：`docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md` §6 明确定过这一条。老路线在
 * **下一次真实更正**到达（`publishRouteVersion`）时逐条转换：搬行 + 排空旧副本 ⇒
 * 之后它的点只由版本行承载。不做全库回填、也不需要"单条路线更新就动全库"的迁移。
 *
 * ## 分析块与事实块读的**不是**同一件事（不要合并这两个方法）
 *
 * - {@link pointsForWorkout} / {@link sampledPointsForWorkout} 等事实块读法：
 *   "**此刻**这条训练能看到的轨迹"，按可读性过滤。
 * - {@link pointsForPublishedVersion}：分析块读法 —— "**那次发布**的输入是什么"，
 *   按版本 id + `status='complete'` 读，**不**按当前可读性过滤（一条 `missing` 的路线
 *   仍然可以有"它当初发布时的内容"，两块视图本来就在回答不同的问题）。
 */
export interface StoredRoutePoint {
  latitude: number;
  longitude: number;
  elevationMeters: number | null;
  speedMetersPerSecond: number | null;
  timestamp: string | null;
}

/** 事实块轨迹的**默认**采样上界（与改造前的 `routePoints()` 逐字一致）。 */
export const ROUTE_POINT_SAMPLE_LIMIT = 500;
/** 高程序列的默认采样上界（与改造前的 `routeElevationSeries()` 逐字一致）。 */
export const ROUTE_ELEVATION_SAMPLE_LIMIT = 600;

interface PointRow extends Record<string, unknown> {
  latitude: unknown;
  longitude: unknown;
  elevation_meters: unknown;
  speed_mps: unknown;
  timestamp: unknown;
}

function mapPoint(row: PointRow): StoredRoutePoint {
  return {
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    elevationMeters: nullableNumber(row.elevation_meters),
    speedMetersPerSecond: nullableNumber(row.speed_mps),
    timestamp: typeof row.timestamp === "string" ? row.timestamp : null
  };
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 这个连接上**没有**任何能提供"已发布路线点"的关系时抛出的错误。
 *
 * 唯一已知的触发形态是 O06-A 的分析输入快照（`materializeFactSnapshot`，`:memory:`）：
 * 它按 `PINNED_FACT_TABLES` 逐表重放 DDL，而那份清单里**只有 `route_points`**
 * （双写还在时它确实装着已发布路线的点）。退役双写之后，快照里没有任何一处装着
 * 已发布路线的点 ⇒ 读端只有两种选择：**静默读空**（= 把"这条训练有轨迹"说成"没有"，
 * 而且 routeQuality/高程会跟着变），或者**响亮地拒绝**。这里选后者：
 * 静默读空会改变已发布的特征值，且从行数、门禁与日志上都看不出来。
 *
 * 修法（不在本工作包的写范围内，必须由整合方落地）：
 * `packages/application/src/services/analysis-fact-view.ts` 的
 * `PINNED_FACT_TABLES` 追加 `"route_version_points"`，
 * `PINNED_FACT_VIEWS` 追加 `"readable_route_points"`。
 * 只加表也够（本模块会退化成等价的 inline union），加视图则直接走视图。
 */
export class RoutePointSourceUnavailableError extends Error {
  constructor(scope: string) {
    super(
      `这个连接上没有可用的路线点关系（${scope}）：已发布路线的点只存在于 route_version_points / ` +
      "readable_route_points 里，而它们不在 O06-A 分析输入快照的钉住清单里。" +
      "拒绝静默读空（那会把「有轨迹」算成「没有轨迹」并改变已发布的分析值）——" +
      "请在 analysis-fact-view.ts 的 PINNED_FACT_TABLES 里加上 route_version_points。" 
    );
    this.name = "RoutePointSourceUnavailableError";
  }
}

export class SqliteRoutePointReader {
  /** 解出来的取数关系（只解一次：一个连接的生命周期里 schema 不会变）。 */
  private pointSource: string | null = null;

  constructor(private readonly database: DatabaseSync) {}

  /**
   * 取数关系：优先用 v43 视图，其次退化成**同一个判据**拼出来的内联 union。
   *
   * 为什么需要第二条路：视图是 v43 迁移建的，而迁移只在 `RaiDatabase.open()` 时跑。
   * O06-A 的分析输入快照（`:memory:`，按钉住清单重放 DDL）里**没有**这个视图 ——
   * 那份清单归 `analysis-fact-view.ts` 所有（本工作包不得改）。于是：
   * - 视图在 ⇒ 直接用（正常库、测试库都走这条）；
   * - 视图不在但 `route_version_points` 在 ⇒ 用内联 union，判据来自
   *   `usableRouteConditionSql()`（**不是**手抄一遍），所以语义与视图逐字一致；
   * - 两者都没有 ⇒ 只剩 legacy 分支。**一旦这个库里存在已发布路线，就抛错**
   *   （{@link RoutePointSourceUnavailableError}）：读空会让"有轨迹"变成"没有轨迹"。
   */
  private source(): string {
    if (this.pointSource !== null) return this.pointSource;
    const hasObject = (type: string, name: string): boolean =>
      this.database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?"
      ).get(type, name) !== undefined;
    const columns = `
      point.sequence AS sequence, point.timestamp AS timestamp,
      point.latitude AS latitude, point.longitude AS longitude,
      point.elevation_meters AS elevation_meters, point.speed_mps AS speed_mps,
      point.course_degrees AS course_degrees,
      point.horizontal_accuracy_meters AS horizontal_accuracy_meters,
      point.vertical_accuracy_meters AS vertical_accuracy_meters`;
    const publishedBranch = `
      SELECT route.id AS route_id, ${columns}
      FROM workout_routes route
      JOIN route_version_points point ON point.route_version_id = route.published_route_version_id
      WHERE ${usableRouteConditionSql("route")}`;
    const legacyBranch = `
      SELECT point.route_id AS route_id, ${columns}
      FROM route_points point
      JOIN workout_routes route ON route.id = point.route_id
      WHERE route.published_route_version_id IS NULL AND ${usableRouteConditionSql("route")}`;

    if (hasObject("view", "readable_route_points")) {
      this.pointSource = "readable_route_points point";
      return this.pointSource;
    }
    if (hasObject("table", "route_version_points")) {
      this.pointSource = `(${publishedBranch} UNION ALL ${legacyBranch}) point`;
      return this.pointSource;
    }
    // 只剩 legacy 分支。若库里真有已发布路线，这里必须响亮地拒绝，而不是读空。
    const published = this.database.prepare(
      "SELECT 1 FROM workout_routes WHERE published_route_version_id IS NOT NULL LIMIT 1"
    ).get();
    if (published !== undefined) {
      throw new RoutePointSourceUnavailableError("既没有 readable_route_points，也没有 route_version_points");
    }
    this.pointSource = `(${legacyBranch}) point`;
    return this.pointSource;
  }

  /**
   * 这条训练**当前可读**的全部路线点（多行 `workout_routes` 时按
   * `(start_at, route_id, sequence)` 拼接）。没有可读轨迹时返回 `null`。
   *
   * 判据与取数**合成一次查询**：分两步就要把条件写两遍，而"COUNT 说有、取点却一行都没有"
   * 会返回 `[]` —— 它既不是"有点"也不是 `null`，落在契约的两种取值之外。
   */
  pointsForWorkout(workoutId: string): StoredRoutePoint[] | null {
    const rows = this.database.prepare(`
      SELECT point.latitude, point.longitude, point.elevation_meters, point.speed_mps, point.timestamp
      FROM ${this.source()}
      JOIN workout_routes route ON route.id = point.route_id
      WHERE route.workout_id = ?
      ORDER BY COALESCE(route.start_at, point.timestamp), route.id, point.sequence
    `).all(workoutId) as PointRow[];
    if (rows.length === 0) return null;
    return rows.map(mapPoint);
  }

  /**
   * 采样后的路线点（默认 ≤ {@link ROUTE_POINT_SAMPLE_LIMIT} 条，**末条恒保留**）。
   *
   * 与 {@link pointsForWorkout} 的差别只有"采样"这一件事：API 的坐标响应有上界，
   * 而"最后一个点"是终点语义，任何采样都必须保留它。
   */
  sampledPointsForWorkout(
    workoutId: string,
    limit: number = ROUTE_POINT_SAMPLE_LIMIT
  ): StoredRoutePoint[] {
    // 🔴 `CAST(? AS INTEGER)` 不能省：`node:sqlite` 把 JS number **一律**绑成 REAL
    // （实测 `SELECT typeof(?)` → `real`），而采样步长必须是**整数**除法 ——
    // 绑成 REAL 之后 `1200 / 500` 变成 `3.398`，取模只在第 1 条上命中，
    // 于是"每 500 条留一条"退化成"只留首尾两条"，而且**不报错**。
    const rows = this.database.prepare(`
      WITH numbered AS (
        SELECT point.latitude, point.longitude, point.elevation_meters, point.speed_mps, point.timestamp,
          ROW_NUMBER() OVER (ORDER BY COALESCE(route.start_at, point.timestamp), route.id, point.sequence) AS sample_number,
          COUNT(*) OVER () AS total_samples
        FROM ${this.source()}
        JOIN workout_routes route ON route.id = point.route_id
        WHERE route.workout_id = ?
      )
      SELECT latitude, longitude, elevation_meters, speed_mps, timestamp
      FROM numbered
      WHERE (sample_number - 1) % MAX(1, (total_samples + CAST(? AS INTEGER)) / CAST(? AS INTEGER)) = 0
        OR sample_number = total_samples
      ORDER BY sample_number
    `).all(workoutId, limit - 1, limit) as PointRow[];
    return rows.map(mapPoint);
  }

  /**
   * 某个训练会话的**高程序列**（含 `total_samples`，供调用方报"总数 vs 采样数"）。
   *
   * 与改造前逐字同源：`timestamp` 与 `elevation_meters` 任一为 NULL 的点不参与
   * （高程序列上没有海拔就没有纵轴），`offsetSeconds` 由调用方按 `anchor_start_at` 换算。
   */
  elevationSeriesForSession(
    trainingSessionId: string,
    limit: number = ROUTE_ELEVATION_SAMPLE_LIMIT
  ): { anchorStartAt: string | null; totalSamples: number; points: Array<{ timestamp: unknown; elevationMeters: unknown }> } {
    const rows = this.database.prepare(`
      WITH numbered AS (
        SELECT session.anchor_start_at, point.timestamp, point.elevation_meters,
          ROW_NUMBER() OVER (ORDER BY COALESCE(route.start_at, point.timestamp), route.id, point.sequence) AS sample_number,
          COUNT(*) OVER () AS total_samples
        FROM training_sessions session
        JOIN workout_routes route ON route.workout_id = session.canonical_workout_id
        JOIN ${this.source()} ON point.route_id = route.id
        WHERE session.id = ? AND point.timestamp IS NOT NULL AND point.elevation_meters IS NOT NULL
      )
      SELECT anchor_start_at, timestamp, elevation_meters, total_samples
      FROM numbered
      WHERE (sample_number - 1) % MAX(1, (total_samples + CAST(? AS INTEGER)) / CAST(? AS INTEGER)) = 0
        OR sample_number = total_samples
      ORDER BY sample_number
    `).all(trainingSessionId, limit - 1, limit) as Array<Record<string, unknown>>;
    return {
      anchorStartAt: typeof rows[0]?.anchor_start_at === "string" ? rows[0].anchor_start_at : null,
      totalSamples: Number(rows[0]?.total_samples ?? 0),
      points: rows.map((row) => ({ timestamp: row.timestamp, elevationMeters: row.elevation_meters }))
    };
  }

  /**
   * **已发布版本**的点（分析块口径）：只认 `status = 'complete'` 的版本，按 `sequence` 排序。
   *
   * 🔴 三个取值都是刻意的，改任何一个都会让它退化成"读当前轨迹"：
   * 1. **不按可读性过滤**：这里回答的是"那次发布的输入是什么"，与"此刻能不能读"无关。
   * 2. **按 `sequence` 排序**：发布时自证过"序号从 0 连续到 n-1"，`sequence` 是那份自证的载体。
   * 3. **不回落**：版本不存在、状态不是 `complete`、或它一行点都没有 ⇒ `null`。
   *    "老库指针为 NULL"的退化读由**调用方**决定并标注 `routeVersionId: null` ——
   *    本方法不猜，因为"没有版本"与"有版本但读不到"是两件事。
   */
  pointsForPublishedVersion(routeVersionId: string): StoredRoutePoint[] | null {
    const version = this.database.prepare(
      "SELECT status FROM route_versions WHERE id = ?"
    ).get(routeVersionId) as { status?: unknown } | undefined;
    if (version === undefined || String(version.status) !== "complete") return null;
    const rows = this.database.prepare(`
      SELECT latitude, longitude, elevation_meters, speed_mps, timestamp
      FROM route_version_points
      WHERE route_version_id = ?
      ORDER BY sequence
    `).all(routeVersionId) as PointRow[];
    // 版本行存在但点为空 ⇒ `null`（"没有轨迹"），不是 `[]`：契约里 `[]` 与 `null` 是两种取值。
    if (rows.length === 0) return null;
    return rows.map(mapPoint);
  }

  /**
   * 这条训练的高程增益（GPS 尖峰过滤：单段上升 < 30 m 才计入，与 Rust 侧 `aggregate()` 同源）。
   *
   * 采样少于 2 个点时返回 `null`（增益在只有一个点的序列上没有定义）。
   */
  elevationGain(workoutId: string): number | null {
    const rows = this.database.prepare(`
      SELECT point.elevation_meters
      FROM ${this.source()}
      JOIN workout_routes route ON route.id = point.route_id
      WHERE route.workout_id = ? AND point.elevation_meters IS NOT NULL
      ORDER BY point.sequence
    `).all(workoutId) as Array<Record<string, unknown>>;
    if (rows.length < 2) return null;
    let gain = 0;
    let previous = nullableNumber(rows[0]?.elevation_meters);
    for (const row of rows.slice(1)) {
      const current = nullableNumber(row.elevation_meters);
      if (current !== null && previous !== null) {
        const delta = current - previous;
        if (delta > 0 && delta < 30) gain += delta;
      }
      if (current !== null) previous = current;
    }
    return gain;
  }

  /**
   * 路线**质量证据**：点数与水平精度均值（`loadRouteQuality` 的取数）。
   *
   * 🔴 存在的理由是修一处**已发生的分叉**：`recompute-pipeline.ts` 里 `loadRouteQuality`
   * 判 `route.file_status = 'imported'`（而点来自不判状态的 `route_points`），
   * 隔壁 `loadElevationGain` 一个字都不判。同一次训练因此可以"贡献高程、却给不出点"，
   * 两个数字喂给同一行特征却来自两个不同的世界。
   *
   * `LEFT JOIN` 的形态**刻意保留**：没有可读点的路线要留下**一行**（`pointCount = 0`、
   * 精度均值 `null`），而不是让整条训练从结果里消失 —— 那会把"这条路线没有点"
   * 说成"这条训练没有路线"。对**两种判据下都可读**的路线，本方法的返回值与改造前逐位相同
   * （`test/route-point-reader.test.ts` 的对照金标按这一条写）。
   *
   * ⚠️ 这里**不再**手写 `route.file_status` 的可读性判据（改造前那一句）：可读性已经由
   * {@link source} 给出的关系承担，写第二遍就是把"同一件事两处写法"重新引进来 —— 而
   * `loadRouteQuality` 与 `loadElevationGain` 的不对称正是那样长出来的。数值不变：
   * 不可读的路线在那个关系里一行点都没有，`COUNT`/`AVG` 对它的贡献恒为 0/NULL。
   */
  routeQualityForWorkout(workoutId: string): { pointCount: number; averageHorizontalAccuracy: number | null } {
    const row = this.database.prepare(`
      SELECT COUNT(point.sequence) AS pointCount,
             AVG(point.horizontal_accuracy_meters) AS averageHorizontalAccuracy
      FROM workout_routes route
      LEFT JOIN ${this.source()} ON point.route_id = route.id
      WHERE route.workout_id = ?
    `).get(workoutId) as { pointCount?: unknown; averageHorizontalAccuracy?: unknown } | undefined;
    return {
      pointCount: Number(row?.pointCount ?? 0),
      averageHorizontalAccuracy: asNumber(row?.averageHorizontalAccuracy)
    };
  }

  /**
   * 该训练**已发布路线版本的指针**（`workout_routes` 的第一行，按 `(start_at, id)` 排序）。
   *
   * 返回 `null` 有两层含义，调用方**必须**自己区分：
   * - 行不存在（这条训练没有轨迹）⇒ 两块视图都没有路线；
   * - 行存在但 `published_route_version_id IS NULL` ⇒ **老库**（v35 之前发布的路线），
   *   此时分析块**允许退化**读当前轨迹并标 `routeVersionId: null`。
   *
   * `usable` 用的就是本模块那条唯一判据（`usableRouteConditionSql()`）：只看指针会把
   * "有指针但轨迹不可用（`file_status = 'pending'`）"当成"有轨迹"。
   */
  routePointer(workoutId: string): { routeId: string; publishedRouteVersionId: string | null; usable: boolean } | null {
    const row = this.database.prepare(`
      SELECT route.id AS routeId, route.published_route_version_id AS publishedRouteVersionId,
        CASE WHEN ${usableRouteConditionSql("route")} THEN 1 ELSE 0 END AS usable
      FROM workout_routes route
      WHERE route.workout_id = ?
      ORDER BY COALESCE(route.start_at, route.created_at), route.id
      LIMIT 1
    `).get(workoutId) as { routeId?: unknown; publishedRouteVersionId?: unknown; usable?: unknown } | undefined;
    if (row === undefined) return null;
    return {
      routeId: String(row.routeId),
      publishedRouteVersionId: typeof row.publishedRouteVersionId === "string"
        ? row.publishedRouteVersionId : null,
      usable: Number(row.usable) === 1
    };
  }

  /**
   * 该路线**此刻可读**的点数。
   *
   * 指纹缓存命中判据用它（`gpx-parser.ts`）："文件摘要没变 + 路线仍是 `imported` +
   * 声明点数 == 落库点数 == 此刻读得到的点数"四条同时成立才跳过重解析。
   * 改造前那句是 `COUNT(*) FROM route_points`（**不看**状态），但同一条判据里已经
   * 单独要求了 `file_status = 'imported'`，所以两条在可读集合上等价 ——
   * 而"读得到的点数"正是缓存命中想保证的东西。
   */
  readablePointCountForRoute(routeId: string): number {
    const row = this.database.prepare(
      `SELECT COUNT(*) AS n FROM ${this.source()} WHERE point.route_id = ?`
    ).get(routeId) as { n?: unknown } | undefined;
    return Number(row?.n ?? 0);
  }

  /** 全库可读点数（审计／`data:migrate` 计数用）。 */
  countReadablePoints(): number {
    return asNumber((this.database.prepare(
      `SELECT COUNT(*) AS n FROM ${this.source()}`
    ).get() as { n?: unknown } | undefined)?.n) ?? 0;
  }

  /** 覆盖率工具用的三个计数：点数、带海拔的点、带速度的点。 */
  readablePointCounts(): { points: number; elevationPoints: number; speedPoints: number } {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS points,
             COUNT(point.elevation_meters) AS elevation_points,
             COUNT(point.speed_mps) AS speed_points
      FROM ${this.source()}
    `).get() as { points?: unknown; elevation_points?: unknown; speed_points?: unknown } | undefined;
    return {
      points: asNumber(row?.points) ?? 0,
      elevationPoints: asNumber(row?.elevation_points) ?? 0,
      speedPoints: asNumber(row?.speed_points) ?? 0
    };
  }
}
