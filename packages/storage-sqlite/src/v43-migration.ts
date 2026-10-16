import type { DatabaseSync } from "node:sqlite";

/**
 * v43：把「此刻可读的路线点」定义成**一个**关系（O11 / WP-50，2026-10-16）。
 *
 * ## 这个视图存在的唯一理由
 *
 * 今天「这条路线现在能不能读、读哪张表」在**每一个读者**里各写一遍：
 * 有的判 `file_status = 'imported' AND point_count > 0`，有的完全不判，
 * 有的读 `route_points`、有的读 `route_version_points`。四份判据、四种口径，
 * 分叉是迟早的（`recompute-pipeline.ts` 的 `loadRouteQuality` 判 `file_status='imported'`
 * 而隔壁 `loadElevationGain` 一个字都不判，就是已经分叉的那一处：同一次训练能贡献高程、
 * 却给不出一个点）。写成**一个视图**之后，"哪些点此刻可读"只有一处定义，
 * 任何读者都不可能忘掉判据 —— 忘掉也没用，视图里已经没有那些点了。
 *
 * ## 两条分支，按**指针**互斥（不是按"有没有数据"）
 *
 * - 指针非空（v35 之后发布过的路线）：点只可能来自 `route_version_points`
 *   里**指针指向的那一条**版本。`UPDATE` 搬行之后，`route_points` 里**不该再有**这条
 *   路线的点，"双写"就此退役。
 * - 指针为 NULL（v35 之前在库里的老路线，以及 `replaceRoutePoints()` 直接落的行）：
 *   它们的点仍在 `route_points` 表里 —— 这是**保留 legacy 分支**的落地形态。
 *   删掉这张表 = 老库的轨迹集体读空（`docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md` §6「明确不做」
 *   就是这么定的：退役 = 新版本不再写，不是删表）。
 *
 * 两条分支由 `route.published_route_version_id IS NULL` 切开 ⇒ **结果集天然不相交**，
 * 一条路线的点不可能既从版本表来、又从旧表来（那正是双写期"同一份点两处真相"的形态）。
 *
 * ## 为什么不把 `route_points` 改名再让视图接管这个名字
 *
 * 那样会多出一张**新表**（legacy 行必须落在某张真实表里 —— SQLite 的视图不存数据，
 * 而 `route_version_points` 里没有老路线的点，回填它们就是"全库复制轨迹"，
 * `docs/IOS_SYNC_PERFORMANCE_REVIEW.md` §O11 步骤 3 明令不做）。本仓的直连写守卫是
 * **失败关闭**的（`apps/api/src/direct-sync-ingest.ts` 的 `INGEST_TABLE_DISPOSITIONS`）：
 * 库里出现一张没表过态的表，**每一次**直连接收都会被整体拒绝。为一个纯读侧的统一
 * 去动那条车道不划算，所以这里只**追加**一个视图，`route_points` 这张表原地保留、
 * 语义收窄成"只装指针为 NULL 的路线点"。
 *
 * ## 判据为什么在视图里**字面**重复一遍
 *
 * 判据本体是 `sql/fragments.ts` 的 `usableRouteConditionSql()`
 * （`file_status = 'imported' AND point_count > 0`，与写侧 `RaiDatabase.hasUsableRoute()` 同源）。
 * 迁移的 `up` 一旦冻结就不能再引用会变的字符串（改了函数、校验和不变 ⇒ 新库与老库
 * 建出不同的 schema，而账本说"同一个迁移"）。所以这里写字面量，
 * 并由 `test/route-point-reader.test.ts` 的结构判据把两者钉死：
 * 视图 SQL 必须**逐字包含** `usableRouteConditionSql("route")` 的输出。
 * 判据漂移 ⇒ 那条测试红，而不是某个读端静默读空。
 *
 * ## 索引决策
 *
 * 两条分支都按主键点查：分支①`workout_routes` 走 PK → `route_version_points`
 * 走 `(route_version_id, sequence)` 的 PK 前缀；分支②`route_points` 走
 * `(route_id, sequence)` 的 PK 前缀。全表 `COUNT(*)`（审计／覆盖率工具用）两条分支各扫一次。
 * 现有索引已经覆盖全部访问路径 ⇒ **不新建索引**，也不加 `workout_routes(published_route_version_id)`
 * 索引（它只在"按指针反查"时才用得上，而今天没有任何查询那样写）。
 *
 * 历史迁移与其冻结校验和一律不得修改；本迁移的冻结值在同一次提交里追加。
 */
export function migrateModelV43(database: DatabaseSync): void {
  database.exec(`
    CREATE VIEW readable_route_points AS
      SELECT route.id AS route_id,
             point.sequence AS sequence,
             point.timestamp AS timestamp,
             point.latitude AS latitude,
             point.longitude AS longitude,
             point.elevation_meters AS elevation_meters,
             point.speed_mps AS speed_mps,
             point.course_degrees AS course_degrees,
             point.horizontal_accuracy_meters AS horizontal_accuracy_meters,
             point.vertical_accuracy_meters AS vertical_accuracy_meters
        FROM workout_routes route
        JOIN route_version_points point ON point.route_version_id = route.published_route_version_id
       WHERE route.file_status = 'imported' AND route.point_count > 0
      UNION ALL
      SELECT point.route_id AS route_id,
             point.sequence AS sequence,
             point.timestamp AS timestamp,
             point.latitude AS latitude,
             point.longitude AS longitude,
             point.elevation_meters AS elevation_meters,
             point.speed_mps AS speed_mps,
             point.course_degrees AS course_degrees,
             point.horizontal_accuracy_meters AS horizontal_accuracy_meters,
             point.vertical_accuracy_meters AS vertical_accuracy_meters
        FROM route_points point
        JOIN workout_routes route ON route.id = point.route_id
       WHERE route.published_route_version_id IS NULL
         AND route.file_status = 'imported' AND route.point_count > 0
  `);
}
