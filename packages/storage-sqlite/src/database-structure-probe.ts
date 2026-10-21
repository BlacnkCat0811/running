import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * 「库结构可用吗」的**低成本**判据，用来替代导入热路径上的 `PRAGMA quick_check`。
 *
 * ## 为什么需要它
 *
 * `PRAGMA quick_check` 会**遍历整个文件的每一页**做 btree 结构校验。在 506 MB 的生产库上
 * 2026-09-21 真机（腾讯云 Lighthouse，2 GB 内存）实测：
 *
 * | 操作 | 冷 page cache | 热 page cache |
 * | :--- | ---: | ---: |
 * | `PRAGMA quick_check` | **12,108 ms** | 252 ms |
 * | 本探针（10 项结构读取） | **0 ms** | 0 ms |
 *
 * 冷热差 **48×**，而一次导入要写 3–4 份 506 MB 副本、总内存装不下（1935 MB），
 * 所以「扫谁谁冷」是常态。四次调用叠加起来是导入里最大的一块可省时间。
 *
 * ## 检出能力（这是**降级**，必须知情）
 *
 * 真机实测（对同一份 506 MB 库人为制造损坏，比较 quick_check 与本探针）：
 *
 * | 损坏类型 | `quick_check` | 本探针 |
 * | :--- | :--- | :--- |
 * | 文件被截断 5% | 抛错 ✓ | **检出** ✓ |
 * | header 的 page_count 被改坏 | 抛错 ✓ | **检出** ✓ |
 * | 单个数据页被翻转 64 字节 | 报错 ✓ | ❌ **漏检** |
 * | 10 个数据页各翻转 64 字节 | 报错 ✓ | ❌ **漏检** |
 *
 * ⇒ 本探针覆盖「文件级损坏」（不可打开 / header 坏 / 被截断 / schema 不可读），
 * **不覆盖「页内字节被静默篡改但页数与 schema 完好」**。
 *
 * ## 因此允许使用它的场合
 *
 * 只在**同时满足**下面两条时可以替换 `quick_check`：
 * 1. 调用方已在**发布前**对私有候选执行过强校验（CLI 的
 *    `activateStagingDatabase` 会在换库前跑一次 `PRAGMA quick_check`）；
 * 2. 被检查的文件是**本进程刚刚写完**的（内容正确性在写入时就已确定，
 *    发布后再全库扫描属于重复校验）。
 *
 * 2026-10-21（PR-10）：不再声称“API 发布后还有 quick_check 兜底”。运行期候选
 * 链路已退役，`import-worker.activateDatabase` 的旧方法没有生产调用者；CLI 是
 * 唯一仍会换库的导入路径，因此强校验必须在 CLI 候选发布前完成。
 *
 * 不满足这两条（例如「即将对主库做破坏性动作前的检测」）就**不要**换 —— 那里的误判代价不对称。
 */
export interface DatabaseStructureReport {
  readonly readable: boolean;
  /** 判为不可读时的原因，用于诊断输出。 */
  readonly reason?: string;
  readonly sizeBytes?: number;
  readonly pageSize?: number;
  readonly pageCount?: number;
  readonly freelistCount?: number;
  readonly schemaObjects?: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readInteger(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${pragma} did not return a number`);
  }
  return value;
}

/**
 * 只读探测，**不修改**目标文件。注意：只读打开一个 WAL 模式的库仍可能就地生成
 * `-shm` 侧车（`PRAGMA quick_check` 同样如此），清理是调用方的责任。
 */
export function probeDatabaseStructure(path: string): DatabaseStructureReport {
  let sizeBytes: number;
  try {
    sizeBytes = statSync(path).size;
  } catch (error) {
    return { readable: false, reason: `stat failed: ${describe(error)}` };
  }
  if (sizeBytes === 0) {
    return { readable: false, reason: "database file is empty", sizeBytes };
  }

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const pageSize = readInteger(database, "page_size");
    const pageCount = readInteger(database, "page_count");
    const freelistCount = readInteger(database, "freelist_count");
    // 读 schema 会真正走 page 1 及其延伸页，而不是只看 header。
    const schemaRow = database
      .prepare("SELECT COUNT(*) AS total FROM sqlite_master")
      .get() as { total?: unknown } | undefined;
    const schemaObjects = typeof schemaRow?.total === "number" ? schemaRow.total : Number.NaN;

    const report: DatabaseStructureReport = {
      readable: true,
      sizeBytes,
      pageSize,
      pageCount,
      freelistCount,
      schemaObjects
    };
    if (pageSize <= 0 || pageCount <= 0) {
      return { ...report, readable: false, reason: "non-positive page geometry" };
    }
    // SQLite 主文件恒为整数页；不等说明文件被截断或膨胀。
    if (pageCount * pageSize !== sizeBytes) {
      return {
        ...report,
        readable: false,
        reason: `size mismatch: ${pageCount} pages x ${pageSize} B != ${sizeBytes} B`
      };
    }
    if (!Number.isFinite(schemaObjects) || schemaObjects <= 0) {
      return { ...report, readable: false, reason: "schema is empty or unreadable" };
    }
    return report;
  } catch (error) {
    return { readable: false, reason: describe(error), sizeBytes };
  } finally {
    try { database?.close(); } catch { /* 探测失败时连接可能已不可用。 */ }
  }
}

/** 探针的布尔投影，方便替换 `isReadableDatabase` 风格的调用点。 */
export function isStructurallyReadable(path: string): boolean {
  return probeDatabaseStructure(path).readable;
}

/**
 * 发布前的强完整性检查（PR-10，2026-10-21）。
 *
 * `probeDatabaseStructure` 只回答“文件/header/schema 基本可读”，**不**遍历
 * 数据页；页内静默损坏会被它漏掉。CLI 的候选库在公开前是唯一一次可以安全承受
 * 全库扫描的时机（它不是 API 热路径），因此在这里跑一次 `PRAGMA quick_check`，
 * 并附带 `PRAGMA foreign_key_check` 的计数作为结构一致性信号。
 *
 * 这不能证明“所有数据页无损”（`quick_check` 自身也有边界），但能把
 * “弱结构探针通过、quick_check 拒绝”的候选挡在发布之外。
 */
export interface DatabaseIntegrityReport {
  readonly ok: boolean;
  /** 失败时的可诊断原因；成功时不出现。 */
  readonly reason?: string;
}

export function quickCheckDatabase(path: string): DatabaseIntegrityReport {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const row = database.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined;
    if (row?.quick_check !== "ok") {
      return { ok: false, reason: `quick_check: ${String(row?.quick_check)}` };
    }
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    if (foreignKeyViolations > 0) {
      return { ok: false, reason: `foreign_key_check: ${foreignKeyViolations} violation(s)` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `quick_check failed: ${describe(error)}` };
  } finally {
    try { database?.close(); } catch { /* 连接可能已不可用。 */ }
  }
}
