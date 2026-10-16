import { DatabaseSync } from "node:sqlite";

import type { CanonicalHealthRecord, CanonicalWorkout } from "@rai/contracts";

import type { StoredRoutePoint } from "./series-read-repository.js";
import { nullableNumber, parseJson } from "./read-utils.js";
import { SqliteRoutePointReader } from "./route-point-reader.js";
import { workoutPresentConditionSql } from "../sql/fragments.js";

/**
 * 固定版本的事实读取器（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §4）。
 *
 * **只读、且只返回一个 raw 代次 `G` 的事实。** 用在"分析输入"这类必须在稳定快照上
 * 跑 CPU 的计算里：调用方先 `openFactsReader(path, G)` 取到事实，在跑 CPU 前 `close()`，
 * 于是计算期间不存在任何打开的读事务（§7 禁止"跨分钟 CPU 计算还开着读事务"）。
 *
 * ### 恢复规则（§4，逐条对应）
 *
 * 对某个 `(entity_kind, entity_id)`：
 * 1. `import_fact_history` 里存在 `valid_from_generation <= G AND (valid_to_generation IS NULL
 *    OR valid_to_generation > G)` 的行 ⇒ 用**那一行**的 `payload_json`（稀疏历史里保存的那一版）。
 * 2. 否则退化为"当前行"：`health_records` / `workouts` 里该行存在，**且**它的
 *    `valid_from_generation IS NULL OR valid_from_generation <= G`。
 * 3. 两条都不满足 ⇒ **不可见**（不回落、不猜）。
 *
 * 🔴 **NULL 是"自古以来有效"，不是"未定义/不可见"。**
 * `valid_from_generation` 是 v34 才加的列，既有库里**所有老行的这个值是 NULL**。
 * 把 NULL 当成"未定义"会让本 reader 在任何老库上返回空集。见 `currentRowVisible()`。
 *
 * ### 枚举口径：**只覆盖"更正"，不覆盖"删除"**（一处必须写明的边界）
 *
 * 枚举以**当前表**（`health_records` / `workouts`）为全集，再对每个实体套上面的恢复规则。
 * 于是：**只在 `import_fact_history` 里、当前表没有对应行的实体不会被返回**。
 *
 * ⚠️ 这等价于把 §5.2 判据 8（"`FactsReader(G_old)` 在 `G_new` 提交后仍返回旧事实"）
 * **限定为 update，不覆盖 delete**。被删除的实体在**任何**代次下都不可见。
 * 本仓库的删除路径确实会物理删掉当前行（`database.ts:3086-3087` 同时删
 * `import_entity_generations` 与 `health_records`，`entity_id` 就是 `health_records.id`），
 * 所以这不是一个假想的场景。**如果 PR3 的验收要求判据 8 覆盖删除，本实现不达标**，
 * 必须显式扩展，见下。
 *
 * 为什么不顺手补上：**在写方契约确定之前，历史行的时间语义是未定的。**
 * 窗口谓词本身技术上完全可以留在 SQL 里 —— `import_fact_history` 就有 `effective_at`
 * 列（§3.1 注明"事件时间"），所以"单一实现做不到"这个说法是错的，不要拿它当理由。
 * 真正的阻塞是：v34 至今**没有写入方**，没有任何东西保证 `effective_at` 会被填、更没保证
 * 它与当前表的 `start_at` 语义对齐。用这样一个没人保证的列做窗口，会让"某个实体在代次 G
 * 是否可见"依赖一个未定义的字段 —— 那比"看不见"更难查。（另一条路是让写方保证"删除也留
 * 一条当前行墓碑"，同样要先定契约。）所以这里不猜：保持单一窗口谓词，把缺口写在明处，
 * 并请 PR3 的验收方明确判据 8 是否覆盖 delete。
 *
 * 补充：`import_fact_history` 对 record 没有 `type` 列，所以"带 `types` 的查询"确实需要
 * 解析 payload；但这不是上面这个缺口的理由（不带 `types` 时并不需要 type 列）。
 *
 * ### 性能与资源
 *
 * - **不持有读事务**：只读连接一律处于 autocommit，每个分块的查询自成一次短读；全程无 `BEGIN`。
 * - **分块加载**：按 `(type, 时间窗)` 用主键 keyset（`id > cursor`）分页，每页上限
 *   {@link CHUNK_SIZE} 行，逐页产出，从不把整表读进内存。keyset 直接走主键索引，总量 O(n)。
 * - **路线不走版本表**：v34 的 `import_fact_history` 的 `entity_kind` 只允许 `record`/`workout`，
 *   路线版本（v35 `route_versions`）改由读侧消费是 PR5/PR6 的事。所以 `routeFor()` 读的是
 *   **当前**可读的那份轨迹（`readable_route_points` 视图：有指针的路线读指针指向的
 *   已发布版本，老库指针为 NULL 的路线读 `route_points`），`generation` 对它不生效。
 *   这是刻意的，见 §7。
 */

/** 每页读取的行数上界。同时也约束了 history 查询里 `IN (...)` 的绑定变量个数。 */
const CHUNK_SIZE = 500;

/** 只读连接的打开选项：`readOnly: true` 是"只读打开"的机械实现，不是注释里的约定。 */
const READ_ONLY_OPTIONS = { readOnly: true } as const;

/**
 * 合法的 `fromAt` / `toAt` 形态：`YYYY-MM-DDTHH:MM[:SS[.fff…]]` 后跟 `Z` 或 `±HH:MM`。
 * 字段全部捕获，供 {@link existsOnCalendar} 做日历 round-trip。
 * 它挡的是"省略偏移/只写日期"这类**歧义**输入；"语法合法但不存在"（月 30、24:00、非闰年 02-29）
 * 与"语法合法但 SQLite 解析不了"（月 13、偏移 +99:00、分钟 60）分别由 `existsOnCalendar()`
 * 与 `validateWindow()` 的 `julianday` 真解析兜住。
 */
const ABSOLUTE_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

type Row = Record<string, unknown>;

export interface FactsRecordFilter {
  /** 只返回这些 `type` 的记录；省略或空数组表示不按 type 过滤。 */
  types?: readonly string[];
  /** 事件时间下界（含），对 `start_at` 比较。 */
  fromAt?: string;
  /** 事件时间上界（含），对 `start_at` 比较。 */
  toAt?: string;
}

export interface FactsWorkoutFilter {
  /** 事件时间下界（含），对 `start_at` 比较。 */
  fromAt?: string;
  /** 事件时间上界（含），对 `start_at` 比较。 */
  toAt?: string;
}

export interface FactsReader {
  /**
   * 本 reader 固定的 raw 代次；所有方法只返回该代次的事实。
   *
   * 🔴 **这里刻意是 `number`，与设计 §4 代码块里的 `readonly generation: string` 不一致** ——
   * 那一行是 v34 之前写的，已被 §3.3 的实施偏差取代：代次列由 `TEXT` 改为 `INTEGER`，
   * 因为 `valid_from_generation <= G` 是比较而不是等值，TEXT 会让 `'10' < '9'` 静默成立。
   * `import_generations.raw_generation` 与 `import_fact_history.valid_from_generation`
   * 在库里都是 INTEGER（`v34-migration.ts:30,45`）。
   *
   * ⚠️ 回执里**没有**任何可以喂给这个参数的字段 —— 这是 2026-10-12 拍定的口径，
   * 不要以为"找找就有"。曾经有个 `DirectSyncReceipt.rawGeneration: string`，装的是批次
   * token `delta:<jobId>`（与 `import_entity_generations.generation` 同源，语义是
   * "这行由哪一批产生"），与这个参数的"单调递增版本号"同名不同义、混用会静默给出错误的
   * 版本视图；它已作为"用不了的承诺"被删除（见 `packages/contracts/src/direct-sync.ts`
   * 的 `DirectSyncReceipt` 说明）。数值版本号要等 `import_generations` 计数器有写入方之后
   * 才会回到回执里（设计文档步骤 6b）。
   * 对外呈现仍用 `String(n)`（§10.1）。
   */
  readonly generation: number;
  records(filter: FactsRecordFilter): Iterable<CanonicalHealthRecord>;
  workouts(filter: FactsWorkoutFilter): Iterable<CanonicalWorkout>;
  /**
   * 该 workout 当前可用轨迹的点；没有可用轨迹时为 `null`。
   *
   * 「可用」不是本文件自己的定义，而是 `sql/fragments.ts` 的 `usableRouteConditionSql()`
   * （`file_status = 'imported' AND point_count > 0`）—— 与写侧 `hasUsableRoute()` 同一份判据；
   * 取数走**唯一**的路线点入口 `read/route-point-reader.ts`。一个 workout 下有多条
   * `workout_routes` 行时，只拼接**可用**那些行的点。
   */
  routeFor(workoutId: string): StoredRoutePoint[] | null;
  /** 关闭底层连接。幂等；关闭后再调用任何读取方法都会抛错。 */
  close(): void;
}

/**
 * 只读打开一个库，并把返回的 reader 固定在代次 `generation` 上。
 *
 * 为什么单独开入口而不是从 `RaiDatabase` 取连接：`RaiDatabase` 是可写 store，
 * 复用它的连接会让"只读"退化成约定。这里每个 reader 有自己的只读连接。
 */
export function openFactsReader(path: string, generation: number): FactsReader {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error(`FactsReader 的代次必须是非负整数，收到 ${String(generation)}`);
  }
  return new SqliteFactsReader(new DatabaseSync(path, READ_ONLY_OPTIONS), generation);
}

class SqliteFactsReader implements FactsReader {
  readonly generation: number;
  private closed = false;
  /** 路线点只有这一个入口（视图 + 唯一判据），见 `read/route-point-reader.ts`。 */
  private readonly routePointReader: SqliteRoutePointReader;

  constructor(private readonly database: DatabaseSync, generation: number) {
    this.generation = generation;
    this.routePointReader = new SqliteRoutePointReader(database);
  }

  records(filter: FactsRecordFilter): Iterable<CanonicalHealthRecord> {
    // 在"调用时"就抛错，而不是等迭代器被推进 —— 否则 `close()` 之后 `records()` 会
    // 返回一个安静的空迭代器，那正是"静默返回空"这一失效形态。
    this.assertOpen();
    this.validateWindow(filter);
    return this.iterateRecords(filter);
  }

  workouts(filter: FactsWorkoutFilter): Iterable<CanonicalWorkout> {
    this.assertOpen();
    this.validateWindow(filter);
    return this.iterateWorkouts(filter);
  }

  routeFor(workoutId: string): StoredRoutePoint[] | null {
    this.assertOpen();
    // 🔴 "可用"的判据与写侧 `RaiDatabase.hasUsableRoute()` **同源**（`sql/fragments.ts` 的
    // `usableRouteConditionSql()`），取数关系是**唯一**的路线点入口
    // （`read/route-point-reader.ts` → `readable_route_points` 视图）。
    // 这里曾经只判 `point_count > 0`、不看 `file_status`，于是同一行 `workout_routes`
    // 会被读侧说成"有轨迹"、被写侧说成"没有"；后来又会直接 `JOIN route_points` ——
    // 那条路在 O11 退役双写之后对**已发布**的路线是空的（点只剩 published 版本那一份），
    // 于是"读空"会伪装成"这条训练没有轨迹"。判据与取数都收进 reader 之后，
    // 本方法不再需要知道点存在哪张表。
    return this.routePointReader.pointsForWorkout(workoutId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private *iterateRecords(filter: FactsRecordFilter): Generator<CanonicalHealthRecord> {
    // 指定 type 时逐个 type 分块（走 idx_health_records_type_time 的过滤）；不指定时
    // 一次 keyset 扫描全部 type。两种写法都不持有事务、都不整表进内存。
    const types = normalizeTypes(filter.types);
    for (const type of types ?? [null]) {
      let cursor: string | null = null;
      for (;;) {
        this.assertOpen();
        const rows = this.recordChunk(type, filter, cursor);
        if (rows.length === 0) break;
        const history = this.historyForPage("record", rows.map((row) => String(row.id)));
        for (const row of rows) {
          const id = String(row.id);
          const payload = history.get(id);
          if (payload !== undefined) {
            yield parseRecordPayload(payload, id);
          } else if (currentRowVisible(row.valid_from_generation, this.generation)) {
            yield rowToRecord(row);
          }
        }
        const last = rows.at(-1);
        if (!last || rows.length < CHUNK_SIZE) break;
        cursor = String(last.id);
      }
    }
  }

  private *iterateWorkouts(filter: FactsWorkoutFilter): Generator<CanonicalWorkout> {
    let cursor: string | null = null;
    for (;;) {
      this.assertOpen();
      const rows = this.workoutChunk(filter, cursor);
      if (rows.length === 0) break;
      const ids = rows.map((row) => String(row.id));
      const history = this.historyForPage("workout", ids);
      const children = this.workoutChildren(ids);
      for (const row of rows) {
        const id = String(row.id);
        const payload = history.get(id);
        if (payload !== undefined) {
          yield parseWorkoutPayload(payload, id);
        } else if (currentRowVisible(row.valid_from_generation, this.generation)) {
          yield rowToWorkout(
            row,
            children.statistics.get(id) ?? [],
            children.events.get(id) ?? [],
            children.routes.get(id) ?? []
          );
        }
      }
      const last = rows.at(-1);
      if (!last || rows.length < CHUNK_SIZE) break;
      cursor = String(last.id);
    }
  }

  private recordChunk(type: string | null, filter: FactsRecordFilter, cursor: string | null): Row[] {
    const params: Array<string> = [];
    const clauses = timeWindowClauses(filter, params);
    if (type !== null) {
      clauses.push("type = ?");
      params.push(type);
    }
    return this.pageClause("health_records", clauses, params, cursor);
  }

  private workoutChunk(filter: FactsWorkoutFilter, cursor: string | null): Row[] {
    const params: Array<string> = [];
    const clauses = timeWindowClauses(filter, params);
    // 软删行不属于**任何**代次的输入：本读取器的枚举以当前表为全集（见文件头），
    // 而软删行在当前表里的语义就是"不在"。这条同时把文件头那句"被删除的实体在任何代次下
    // 都不可见"的边界（D1）**继续成立** —— 判据与读侧同源，不在这里另写一遍。
    clauses.push(workoutPresentConditionSql());
    return this.pageClause("workouts", clauses, params, cursor);
  }

  /** keyset 分页：`ORDER BY id LIMIT CHUNK_SIZE`，只靠主键索引，不做整表排序。 */
  private pageClause(table: string, clauses: string[], params: string[], cursor: string | null): Row[] {
    const effective = clauses.length > 0 ? clauses : ["1 = 1"];
    if (cursor !== null) {
      effective.push("id > ?");
      params.push(cursor);
    }
    return this.database
      .prepare(`SELECT * FROM ${table} WHERE ${effective.join(" AND ")} ORDER BY id LIMIT ?`)
      .all(...params, CHUNK_SIZE) as Row[];
  }

  /**
   * 分块内一次性解析历史行：`entity_id IN (...)` 用完即弃，不留任何跨块状态。
   *
   * 同一实体理论上只应有一行满足窗口（`valid_to` 与前一行首尾相接）。若历史被写坏出现重叠，
   * 取 `valid_from_generation` **最大**的那一行 —— 即"在 G 处最新的那一版"，确定性优先，
   * 不做静默的随机择一。
   */
  private historyForPage(kind: "record" | "workout", ids: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.database
      .prepare(`
        SELECT entity_id, payload_json
        FROM import_fact_history
        WHERE entity_kind = ?
          AND entity_id IN (${placeholders})
          AND valid_from_generation <= ?
          AND (valid_to_generation IS NULL OR valid_to_generation > ?)
        ORDER BY entity_id, valid_from_generation DESC
      `)
      .all(kind, ...ids, this.generation, this.generation) as Row[];
    for (const row of rows) {
      const id = String(row.entity_id);
      if (!result.has(id)) result.set(id, String(row.payload_json));
    }
    return result;
  }

  private workoutChildren(ids: readonly string[]): {
    statistics: Map<string, CanonicalWorkout["statistics"]>;
    events: Map<string, CanonicalWorkout["events"]>;
    routes: Map<string, CanonicalWorkout["routes"]>;
  } {
    const statistics = new Map<string, CanonicalWorkout["statistics"]>();
    const events = new Map<string, CanonicalWorkout["events"]>();
    const routes = new Map<string, CanonicalWorkout["routes"]>();
    if (ids.length === 0) return { statistics, events, routes };
    const placeholders = ids.map(() => "?").join(", ");

    const statisticRows = this.database
      .prepare(`
        SELECT workout_id, type, start_at, end_at, unit,
               sum_value, average_value, minimum_value, maximum_value
        FROM workout_statistics
        WHERE workout_id IN (${placeholders})
        ORDER BY workout_id, ordinal
      `)
      .all(...ids) as Row[];
    for (const row of statisticRows) {
      push(statistics, String(row.workout_id), {
        type: String(row.type),
        startAt: nullableString(row.start_at),
        endAt: nullableString(row.end_at),
        unit: nullableString(row.unit),
        sum: nullableNumber(row.sum_value),
        average: nullableNumber(row.average_value),
        minimum: nullableNumber(row.minimum_value),
        maximum: nullableNumber(row.maximum_value)
      });
    }

    const eventRows = this.database
      .prepare(`
        SELECT workout_id, type, event_at, duration_seconds, metadata_json
        FROM workout_events
        WHERE workout_id IN (${placeholders})
        ORDER BY workout_id, ordinal
      `)
      .all(...ids) as Row[];
    for (const row of eventRows) {
      push(events, String(row.workout_id), {
        type: String(row.type),
        date: nullableString(row.event_at),
        durationSeconds: nullableNumber(row.duration_seconds),
        metadata: parseJson<CanonicalHealthRecord["metadata"]>(row.metadata_json, {})
      });
    }

    const routeRows = this.database
      .prepare(`
        SELECT id, workout_id, source_name, source_version, start_at, end_at, created_at,
               relative_path, metadata_json
        FROM workout_routes
        WHERE workout_id IN (${placeholders})
        ORDER BY workout_id, start_at, id
      `)
      .all(...ids) as Row[];
    for (const row of routeRows) {
      push(routes, String(row.workout_id), {
        id: String(row.id),
        sourceName: nullableString(row.source_name),
        sourceVersion: nullableString(row.source_version),
        startAt: nullableString(row.start_at),
        endAt: nullableString(row.end_at),
        createdAt: nullableString(row.created_at),
        relativePath: nullableString(row.relative_path),
        metadata: parseJson<CanonicalHealthRecord["metadata"]>(row.metadata_json, {})
      });
    }

    return { statistics, events, routes };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("FactsReader 已关闭：关闭后不得再读取事实。请重新 openFactsReader。");
    }
  }

  /**
   * 时间边界**拒绝**而不是静默。见 {@link assertAbsoluteInstant} 的两条失效形态；
   * 第二条用**真的把值交给 SQLite**来判，而不是靠正则代理 —— 实测正则挡不住
   * `2026-13-01T00:00:00Z`（月 13）、`2026-01-01T00:00:00+99:00`（偏移 99 小时）、
   * `2026-01-01T00:60:00Z`（分钟 60）这三种：它们都匹配正则，但 `julianday()` 仍是 NULL，
   * 于是整条时间谓词变成 NULL ⇒ **一行都不返回**。只有真解析一次才能挡住。
   */
  private validateWindow(filter: { fromAt?: string; toAt?: string }): void {
    for (const field of ["fromAt", "toAt"] as const) {
      const value = filter[field];
      if (value === undefined) continue;
      assertAbsoluteInstant(value, field);
      const row = this.database.prepare("SELECT julianday(?) AS value").get(value) as Row;
      if (row.value === null || row.value === undefined) {
        throw new Error(
          `FactsReader 的 ${field} 无法被 SQLite 解析为时刻：${JSON.stringify(value)}。` +
          "保留它会让时间谓词整体变成 NULL，静默返回空集。"
        );
      }
    }
  }
}

/**
 * 时间边界必须是**带显式偏移的绝对时刻**（`…Z` 或 `…±HH:MM`），且该时刻必须**真实存在**。
 * 三条静默失效形态，任一条都会让"参数写错"看起来像"查了别的时间"或"没有数据"：
 *
 * 1. **无法解析 ⇒ 空集**：`julianday('2026-1-1')`（月日未补零）、`julianday('20260101')`、
 *    `julianday('not a date')` 都返回 `NULL`，于是 `julianday(start_at) >= julianday(?)`
 *    整体是 `NULL` ⇒ 不报错、一行都不返回。`'2026-1-1'` 这种写法极容易写出来（手写或
 *    日期库的宽松输出）。这与本文件"`close()` 后必须抛错，而不是安静的空迭代器"自相矛盾。
 * 2. **无偏移 ⇒ 按 UTC 解释**：`'2026-02-01'` 会被当作 **UTC** 午夜，而本库时区是
 *    Asia/Shanghai，`toAt: '2026-02-01'` 会静默漏掉本地 02-01 00:00–08:00 的数据。
 * 3. **能解析但不存在 ⇒ 被静默归一化**：`julianday('2026-02-30T00:00:00Z')` **不是 NULL**，
 *    它等于 `julianday('2026-03-02T00:00:00Z')`（实测）；`'2026-04-31…'` → 05-01、
 *    `'2026-01-01T24:00:00Z'` → 次日、非闰年的 `'2026-02-29…'` → 03-01 同理。
 *    即查询**落到另一个时间段上**而不报错 —— 比空集更坏，因为结果看起来是"有数据的"。
 *    这一条由 {@link existsOnCalendar} 的日历字段 round-trip 挡，与
 *    `apps/api/src/workout-date-window.ts:4-6` 是同一路线（靠 `toISOString()` 回比日期，
 *    而不是只信 `Date.parse()`）；**不是**第二套时间比较实现，只是"解析后是否还是同一个时刻"。
 *
 * 三层都在，但**各自的独特职责要写准**（我第一版把它们的覆盖面写宽了，是错的）：
 * - 正则 `ABSOLUTE_INSTANT`：挡形态与"缺偏移/只有日期"的歧义（形态 2）。
 * - `existsOnCalendar()`：挡日历字段越界 —— 月 13、2 月 30、24:00、00:60、非闰年 02-29
 *   （形态 3 与部分形态 1）。
 * - `validateWindow()` 里的 `julianday` 真解析：**唯一**挡住"偏移越界"（`+99:00`）的一层，
 *   更重要的价值是它直接对着**真正的消费方** SQLite 验证，而不是对着我这份可能不全的
 *   枚举（今天就证明过两次：先漏了"正则放行但 julianday 为 NULL"，又漏了归一化）。
 *
 * 正面控制（证明问题只在"输入不合法"，不在 `julianday` 本身）：
 * `julianday('2026-01-01T08:00:00.000+08:00') = 2461041.5`，与
 * `julianday('2026-01-01T00:00:00.000Z')` 相等 —— 带偏移的写法被正确折算成绝对时刻，
 * 所以这里**继续用 `julianday` 比较而不是字符串比较**：库里的 `start_at` 可能是带偏移的
 * 字符串（`insertRecord` 不归一化偏移），字典序比较在那时会静默给错结果。
 */
function assertAbsoluteInstant(value: string, field: "fromAt" | "toAt"): void {
  const fields = ABSOLUTE_INSTANT.exec(value);
  if (fields === null) {
    throw new Error(
      `FactsReader 的 ${field} 必须是带显式偏移的绝对时刻（如 2026-01-01T00:00:00.000Z 或 ` +
      `2026-01-01T08:00:00+08:00），收到 ${JSON.stringify(value)}。` +
      "只写日期（2026-02-01）或省略偏移会按 UTC 解释、静默漏掉本地时区的数据；" +
      "无法解析的值会让时间谓词变成 NULL、静默返回空集。"
    );
  }
  if (!existsOnCalendar(fields)) {
    throw new Error(
      `FactsReader 的 ${field} 是一个不存在的时刻：${JSON.stringify(value)}。` +
      "SQLite 不会报错，而是把它静默归一化成另一个时刻（2026-02-30 → 03-02、" +
      "2026-04-31 → 05-01、24:00:00 → 次日、非闰年的 02-29 → 03-01），" +
      "于是查询落到别的时间段上 —— 比返回空集更难发现。"
    );
  }
}

/**
 * 年月日时分秒必须真实存在（round-trip 思路）。
 * 偏移等号本身由 `ABSOLUTE_INSTANT` / `julianday` 真解析覆盖，这里只管日历字段。
 */
function existsOnCalendar(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12) return false;
  // Date.UTC(year, month, 0) = 该月的最后一天（month 是 1-based，故 day 0 落在月末）。
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * 🔴 NULL 必须解释为"自古以来就有效"（`<= 任何 G`），**不是**"未定义/不可见"。
 * 既有库里 v34 之前写入的行 `valid_from_generation` 全是 NULL；把 NULL 当作不可见
 * 会让本 reader 在任何老库上返回空集。这一条由 `facts-reader.test.ts` 的老库用例钉死。
 */
function currentRowVisible(validFromGeneration: unknown, generation: number): boolean {
  if (validFromGeneration === null || validFromGeneration === undefined) return true;
  return Number(validFromGeneration) <= generation;
}

function normalizeTypes(types: readonly string[] | undefined): readonly string[] | null {
  return types !== undefined && types.length > 0 ? types : null;
}

function timeWindowClauses(filter: { fromAt?: string; toAt?: string }, params: string[]): string[] {
  const clauses: string[] = [];
  if (filter.fromAt !== undefined) {
    clauses.push("julianday(start_at) >= julianday(?)");
    params.push(filter.fromAt);
  }
  if (filter.toAt !== undefined) {
    clauses.push("julianday(start_at) <= julianday(?)");
    params.push(filter.toAt);
  }
  return clauses;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function rowToRecord(row: Row): CanonicalHealthRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    sourceName: String(row.source_name),
    sourceVersion: nullableString(row.source_version),
    device: nullableString(row.device),
    unit: nullableString(row.unit),
    numericValue: nullableNumber(row.value_numeric),
    textValue: nullableString(row.value_text),
    startAt: String(row.start_at),
    endAt: String(row.end_at),
    createdAt: nullableString(row.created_at),
    metadata: parseJson<CanonicalHealthRecord["metadata"]>(row.metadata_json, {})
  };
}

function rowToWorkout(
  row: Row,
  statistics: CanonicalWorkout["statistics"],
  events: CanonicalWorkout["events"],
  routes: CanonicalWorkout["routes"]
): CanonicalWorkout {
  return {
    id: String(row.id),
    activityType: String(row.activity_type),
    sourceName: String(row.source_name),
    sourceVersion: nullableString(row.source_version),
    device: nullableString(row.device),
    startAt: String(row.start_at),
    endAt: String(row.end_at),
    createdAt: nullableString(row.created_at),
    durationSeconds: Number(row.duration_seconds),
    indoor: row.indoor === null || row.indoor === undefined ? null : Number(row.indoor) === 1,
    metadata: parseJson<CanonicalHealthRecord["metadata"]>(row.metadata_json, {}),
    statistics,
    events,
    routes
  };
}

/** 历史 payload 的格式契约：JSON 编码的 `CanonicalHealthRecord` / `CanonicalWorkout`。 */
function parseRecordPayload(json: string, id: string): CanonicalHealthRecord {
  const parsed = parsePayload(json, "record", id);
  if (typeof parsed.id !== "string") {
    throw new Error(`import_fact_history 中 record ${id} 的 payload_json 缺少字符串 id`);
  }
  return parsed as unknown as CanonicalHealthRecord;
}

function parseWorkoutPayload(json: string, id: string): CanonicalWorkout {
  const parsed = parsePayload(json, "workout", id);
  if (typeof parsed.id !== "string") {
    throw new Error(`import_fact_history 中 workout ${id} 的 payload_json 缺少字符串 id`);
  }
  return parsed as unknown as CanonicalWorkout;
}

/**
 * 坏 payload **抛错而不是静默回落**：历史行的存在本身就意味着"这一版的内容在这里"，
 * 悄悄换成当前行会让版本视图静默出错，与项目"拒绝优于静默"的取向相反。
 */
function parsePayload(json: string, kind: string, id: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`import_fact_history 中 ${kind} ${id} 的 payload_json 不是合法 JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`import_fact_history 中 ${kind} ${id} 的 payload_json 不是对象`);
  }
  return parsed as Record<string, unknown>;
}
