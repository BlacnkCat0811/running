import type { DatabaseSync } from "node:sqlite";

/**
 * v40：给恢复（canonical 夜）维的**范围读**一条能真正 seek 的索引（O10 / WP-31，2026-10-16）。
 *
 * ## 为什么需要（以及为什么列顺序不能靠猜）
 *
 * `canonicalizeNightsForWindow` 把睡眠段的谓词下推到 SQL：
 *
 * ```sql
 * SELECT MIN(id) … FROM health_records
 *  WHERE type = ? AND end_at > ? AND start_at < ?     -- 与窗口相交
 *  GROUP BY source_name, source_category, value_text, start_at, end_at
 * ```
 *
 * 既有索引 `idx_health_records_type_time(type, start_at, end_at)` 只能把 **一个**范围条件当 seek
 * 约束（普通 B-tree 的第二列之后无法同时做两个范围 seek）。实测（合成库，程序生成，非真实健康数据；
 * 每晚 20 段 / 每天 60 个 HRV 样本，窗口为"历史末端的一天"）：
 *
 * | 库规模 | 计划（既有索引） | seek 走过的索引项 | 单次查询中位耗时 |
 * |---|---|---|---|
 * | 3 年 / 87,600 行 | `SEARCH … USING INDEX idx_health_records_type_time (type=? AND start_at<?)` | 21,860 | **9.8 ms** |
 * | 10 年 / 292,000 行 | 同上 | 72,960 | **33.1 ms** |
 *
 * ⇒ 走 `start_at < ?` 这个 seek 要扫过**几乎整段历史**（窗口在时间轴末端时，`start_at < U` 覆盖全部旧行），
 * 而窗口本身只有一天。这正是 O10 要消灭的"读取随全历史增长"。
 *
 * 新索引把 seek 交给另一个条件：
 *
 * | 库规模 | 计划（新索引） | seek 走过的索引项 | 单次查询中位耗时 |
 * |---|---|---|---|
 * | 3 年 | `SEARCH … USING INDEX idx_health_records_type_end (type=? AND end_at>?)` | 60 | **0.17 ms** |
 * | 10 年 | 同上 | 60 | **0.19 ms** |
 *
 * `(type, end_at, start_at)` 的列序是**实测选出来的**，不是按直觉排的：
 * - 第二列 `end_at` 是"与窗口相交"里**在近期窗口上更有选择性**的那一侧（只有刚刚结束的那几段
 *   `end_at > L`；而 `start_at < U` 在时间轴末端几乎是全表）。两列都在索引里 ⇒ 命中后的
 *   `start_at < ?` 残余过滤是**索引内**的（覆盖索引，不回表）。
 * - 反向的 `(type, start_at, end_at)` 已经存在，本迁移**不重复**造它。
 * - 计划器有两套 seek 可选（无 `ANALYZE` 时亦然，实测 B/C/D 三种变体计划相同），
 *   于是"窗口在历史末端"这条热路径（每次增量同步都走）能选到 60 条的那一条；
 *   历史**中段**的窗口两侧各要走约一半历史（实测偏移 500 天时两者都约 4–5 ms）——
 *   这是 B-tree 的固有下界，本索引不承诺改善，实测也没有回退（新索引进场后同一查询仍 4.1 ms）。
 *
 * ## HRV 为什么不建索引
 *
 * HRV 的谓词是 `start_at >= ? AND start_at < ?` —— **同一列的双侧范围**，既有
 * `idx_health_records_type_time` 已经能把它当作 `type=? AND start_at>? AND start_at<?` 的 seek
 * （实测计划如此，单次 0.2–0.3 ms，且 10 年规模下不随时间增长）。新索引在那条谓词上的计划与耗时
 * 均无变化（计划器仍选 `type_time`）⇒ **不**为 HRV 追加索引，避免白付写入与体积。
 *
 * ## 运维口径
 *
 * 一次性受控维护（O10 步骤 6）：索引只在迁移期构建一次，**不**混进每次同步、**不**触发整库备份。
 * 既有库补跑时 `CREATE INDEX IF NOT EXISTS` 幂等；历史迁移与其冻结 checksum 一律不动。
 *
 * ## 附：为什么读路径不做"全表形状证明"
 *
 * 谓词下推的前提是"文本序 == 时间序"（列值为 `normalizeAppleDate` 的定宽 UTC 形状）。
 * 读路径用**窗口邻域 + 索引两端**的形状普查来发现异构格式（`O(窗口 + log n)`）。
 * 之所以不做全表证明：实测 10 年库上一条 `start_at NOT GLOB <规范形状> OR end_at NOT GLOB …`
 * 的覆盖索引普查要 **60 ms（sleep）+ 160 ms（hrv）**，比它保护的这次优化（0.19 ms + 0.09 ms）
 * 贵三个数量级，等于把 O10 的效果原地抵消。取舍与残留风险写在
 * `packages/health-export-parser/src/canonicalize-nights.ts` 的 `scopedReadLiterals` 注释里。
 */
export function migrateModelV40(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_health_records_type_end
      ON health_records(type, end_at, start_at);
  `);
}
