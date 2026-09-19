import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  RaiApplicationService, PredictionModelService,
  type AppendWorkoutOverrideInput
} from "@rai/application";
import { RaiDatabase, SqliteModelRunRepository } from "@rai/storage-sqlite";
import type { CommandRequest, CommandResponse, UpdateTrainingZoneProfileInput } from "@rai/api-contracts";
import type { TaskAdmission } from "./task-admission.js";
import { RuntimeStateStore } from "./runtime-state.js";

export type { CommandKind, CommandRequest } from "@rai/api-contracts";
export interface DurableCommand extends CommandRequest, CommandResponse {
  scope: string;
  fingerprint: string;
  attempts: number;
}

/** Stable across JSON object key order; array order remains meaningful. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export class CommandConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "command_content_mismatch";
  constructor() { super("同一个操作标识不能用于不同内容"); }
}
export class CommandCapacityError extends Error {
  readonly statusCode = 429;
  readonly code = "command_queue_full";
  constructor() { super("写操作队列已满，请稍后重试"); }
}

function commandError(error: unknown): { code: string; message: string } {
  const messages: Record<string, string> = {
    workout_not_found: "训练已不存在，请刷新列表",
    training_zone_profile_revision_conflict: "训练分区设置已更新，请刷新后重新提交",
    invalid_training_zone_profile: "训练分区设置无效",
    insufficient_labeled_outcomes: "训练标签不足，暂时不能训练预测模型",
    prediction_training_in_progress: "已有不同的预测训练任务，请等待它完成",
    prediction_ability_baseline_unavailable: "请先完成跑力模型计算",
    invalid_prediction_training_input: "预测训练参数无效，请刷新后重新提交",
    prediction_model_incompatible: "预测模型与当前数据或算法不兼容",
    command_content_mismatch: "该操作标识已经用于不同内容"
  };
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && Object.hasOwn(messages, code)
    ? { code, message: messages[code]! }
    : { code: "command_failed", message: "写操作未完成，请刷新数据后检查服务日志" };
}

export class CommandQueue {
  private readonly path: string;
  private timer: NodeJS.Timeout | null = null;
  private executing: Promise<void> | null = null;
  private closing = false;
  private failures = 0;
  constructor(
    runtimeRoot: string, private readonly scope: string, private readonly admission: TaskAdmission,
    private readonly apply: (command: DurableCommand) => Promise<unknown>,
    private readonly afterApply: () => void = () => {}
  ) {
    this.path = new RuntimeStateStore(runtimeRoot).path;
    this.use((db) => db.exec(`CREATE TABLE IF NOT EXISTS mutation_commands (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      scope TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_mutation_commands_pending ON mutation_commands(status, sequence)`));
    for (const command of this.pending()) {
      if (command.scope !== scope) {
        command.status = "failed";
        command.error = { code: "dataset_scope_changed", message: "数据集已更换，旧操作未执行" };
        command.completedAt = new Date().toISOString();
        this.save(command);
      }
    }
  }
  private use<T>(operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path);
    try { db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL"); return operation(db); }
    finally { db.close(); }
  }
  private save(command: DurableCommand): void {
    this.use((db) => db.prepare(`INSERT INTO mutation_commands (id, scope, status, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload`)
      .run(command.id, command.scope, command.status, JSON.stringify(command)));
  }
  get(id: string): DurableCommand | null {
    return this.use((db) => {
      const row = db.prepare("SELECT payload FROM mutation_commands WHERE id=? AND scope=?").get(id, this.scope) as { payload: string } | undefined;
      return row ? JSON.parse(row.payload) as DurableCommand : null;
    });
  }
  private pending(): DurableCommand[] {
    return this.use((db) => (db.prepare("SELECT payload FROM mutation_commands WHERE status IN ('queued','running') ORDER BY sequence")
      .all() as { payload: string }[]).map((row) => JSON.parse(row.payload) as DurableCommand));
  }
  get hasPending(): boolean { return this.pending().length > 0 || this.executing !== null; }
  enqueue(request: CommandRequest): DurableCommand {
    const id = `command_${createHash("sha256").update(JSON.stringify([this.scope, request.idempotencyKey])).digest("hex")}`;
    const fingerprint = createHash("sha256").update(canonical({ kind: request.kind, payload: request.payload })).digest("hex");
    const previous = this.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new CommandConflictError();
      return previous;
    }
    if (this.pending().length >= 16) throw new CommandCapacityError();
    const command: DurableCommand = {
      ...request, id, scope: this.scope, fingerprint, createdAt: new Date().toISOString(),
      completedAt: null, status: "queued", attempts: 0
    };
    this.save(command);
    this.resume();
    return command;
  }
  cancel(id: string): "not_found" | "busy" | "cancelled" {
    const command = this.get(id);
    if (!command) return "not_found";
    if (command.status !== "queued") return "busy";
    command.status = "cancelled"; command.completedAt = new Date().toISOString();
    this.save(command);
    return "cancelled";
  }
  resume(): void {
    if (this.closing || this.timer || this.executing) return;
    if (!this.pending().length) { this.admission.withdraw(); return; }
    this.timer = setTimeout(() => {
      this.timer = null;
      const release = this.admission.acquire();
      if (!release) { this.resume(); return; }
      this.executing = this.executeNext().then(() => { this.failures = 0; }).catch((error) => {
        // A failed acknowledgement must stay pending: the effect may already be committed.
        console.error("Command acknowledgement/execution unavailable", error);
        this.failures++;
      }).finally(() => {
        this.executing = null; release(); this.resume();
      });
    }, Math.min(30_000, 250 * (2 ** Math.min(this.failures, 7))));
    this.timer.unref();
  }
  private async executeNext(): Promise<void> {
    const command = this.pending().find((item) => item.scope === this.scope);
    if (!command) return;
    command.status = "running"; command.attempts++;
    this.save(command);
    let result: unknown;
    try { result = await this.apply(command); }
    catch (error) {
      console.error(`Command ${command.id} failed`, error);
      command.status = "failed"; command.completedAt = new Date().toISOString();
      command.error = commandError(error);
      this.save(command);
      return;
    }
    command.result = result;
    command.status = "succeeded"; command.completedAt = new Date().toISOString();
    // If this write fails, next execution reads the receipt instead of applying twice.
    this.save(command);
    this.afterApply();
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.admission.withdraw();
    await this.executing;
  }
}

/** Business effect and idempotency receipt share ONE main-database transaction. */
export async function applyMutationCommand(
  databasePath: string, artifactRoot: string, command: DurableCommand
): Promise<unknown> {
  if (!existsSync(databasePath)) throw new Error("Database unavailable; import data before executing commands");
  const store = await RaiDatabase.open(databasePath, { migrationPolicy: "refuse" });
  const db = store.database;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const key = `rai.applied-command.${command.id}`;
      const receipt = db.prepare("SELECT value FROM import_manifest WHERE key=?").get(key) as { value: string } | undefined;
      if (receipt) {
        const prior = JSON.parse(receipt.value) as { fingerprint: string; result: unknown };
        if (prior.fingerprint !== command.fingerprint) throw new CommandConflictError();
        db.exec("COMMIT");
        return prior.result;
      }
      const service = new RaiApplicationService(store, "savepoint");
      const prediction = () => new PredictionModelService(store, artifactRoot, "savepoint");
      let result: unknown;
      switch (command.kind) {
        case "workout_override":
          result = service.appendWorkoutOverride(command.payload as unknown as AppendWorkoutOverrideInput); break;
        case "training_zones": {
          const settings = service.appendTrainingZoneProfileSettings(command.payload as unknown as UpdateTrainingZoneProfileInput);
          result = { settings, jobId: service.enqueueSnapshotRefresh() }; break;
        }
        case "recompute":
          result = { jobId: service.enqueueFullRecompute({ evaluatedAt: command.createdAt }) }; break;
        case "prediction_training":
          result = { runId: prediction().enqueue(command.payload as { asOf?: string }) }; break;
        case "activate_model":
          new SqliteModelRunRepository(db).activateSucceeded(String(command.payload.id), new Date().toISOString());
          result = { activeModelRunId: command.payload.id }; break;
        case "activate_prediction":
          result = { activePredictionModelRunId: prediction().activate(String(command.payload.id)).id }; break;
        default: throw new Error("Unsupported command kind");
      }
      db.prepare("INSERT INTO import_manifest (key,value) VALUES (?,?)")
        .run(key, JSON.stringify({ fingerprint: command.fingerprint, result }));
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  } finally { store.close(); }
}
