import type { GenerationRemovalPreview } from "@rai/storage-sqlite";

/**
 * Guard for non-preserving incremental imports.
 *
 * `preserveAbsent: false` asserts that the payload is a *complete* snapshot:
 * every entity missing from it is treated as deleted. That assertion is only
 * true when the payload really covers the whole history. When a partial export
 * (a renamed archive, a third-party exporter, a date-windowed dump) is loaded
 * under that flag, the missing entities are deleted silently — a complete
 * Apple Health export re-imports to near-zero removals because every entity
 * reappears and is re-stamped with the current generation, so a large
 * projection is a reliable signal of a partial payload rather than a real
 * deletion.
 */
export const ABSENT_REMOVAL_GUARD_MIN_ENTITIES = 50;
export const ABSENT_REMOVAL_GUARD_MAX_RATIO = 0.05;

export interface RemovalGuardEvaluation {
  /** Entities the import is allowed to remove before the guard trips. */
  allowedRemovals: number;
  /** Entities the import would remove if it ran unguarded. */
  projectedRemovals: number;
  exceeded: boolean;
}

export interface RemovalGuardPayload {
  code: "import_removal_guard";
  preview: GenerationRemovalPreview;
  existingEntities: number;
  allowedRemovals: number;
}

export function evaluateRemovalGuard(
  preview: GenerationRemovalPreview,
  existingEntities: number
): RemovalGuardEvaluation {
  const allowedRemovals = Math.max(
    ABSENT_REMOVAL_GUARD_MIN_ENTITIES,
    Math.floor(Math.max(0, existingEntities) * ABSENT_REMOVAL_GUARD_MAX_RATIO)
  );
  return {
    allowedRemovals,
    projectedRemovals: preview.total,
    exceeded: preview.total > allowedRemovals
  };
}

/**
 * Raised instead of deleting a large share of the database. The import runs
 * against a staging copy, so throwing here discards the staged database and
 * leaves the live data untouched.
 */
export class ImportRemovalGuardError extends Error {
  readonly code = "import_removal_guard";
  readonly preview: GenerationRemovalPreview;
  readonly existingEntities: number;
  readonly allowedRemovals: number;

  toPayload(): RemovalGuardPayload {
    return {
      code: this.code, preview: this.preview,
      existingEntities: this.existingEntities, allowedRemovals: this.allowedRemovals
    };
  }

  /** Rebuild only validated counts; never expose text supplied by a child process. */
  static fromPayload(value: unknown): ImportRemovalGuardError | null {
    if (!value || typeof value !== "object") return null;
    const payload = value as Partial<RemovalGuardPayload>;
    const preview = payload.preview;
    if (payload.code !== "import_removal_guard" || !preview || typeof preview !== "object") return null;
    const counts = [preview.records, preview.workouts, preview.activitySummaries, preview.total,
      payload.existingEntities, payload.allowedRemovals];
    if (!counts.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return null;
    if (preview.total !== preview.records + preview.workouts + preview.activitySummaries
      || preview.total > payload.existingEntities! || preview.total <= payload.allowedRemovals!) return null;
    return new ImportRemovalGuardError({
      records: preview.records, workouts: preview.workouts,
      activitySummaries: preview.activitySummaries, total: preview.total
    }, payload.existingEntities!, payload.allowedRemovals!);
  }

  constructor(
    preview: GenerationRemovalPreview,
    existingEntities: number,
    allowedRemovals: number
  ) {
    super(
      `Refusing to remove ${preview.total} of ${existingEntities} entities ` +
        `(records=${preview.records}, workouts=${preview.workouts}, ` +
        `activitySummaries=${preview.activitySummaries}); ` +
        `the payload does not look like a complete snapshot.`
    );
    this.name = "ImportRemovalGuardError";
    this.preview = preview;
    this.existingEntities = existingEntities;
    this.allowedRemovals = allowedRemovals;
  }

  /** Operator-facing summary with no internal paths or stack details. */
  get userMessage(): string {
    const share = this.existingEntities > 0
      ? Math.round((this.preview.total / this.existingEntities) * 100)
      : 100;
    const parts: string[] = [];
    if (this.preview.records > 0) parts.push(`${this.preview.records} 条健康记录`);
    if (this.preview.workouts > 0) parts.push(`${this.preview.workouts} 次训练`);
    if (this.preview.activitySummaries > 0) parts.push(`${this.preview.activitySummaries} 条活动摘要`);
    const detail = parts.length > 0 ? parts.join("、") : "大量数据";
    return (
      `导入已中止：该导出文件缺少 ${detail}，占现有数据的约 ${share}%。` +
      `为避免误删，系统未执行删除。请确认导出文件完整后重新上传。`
    );
  }
}
