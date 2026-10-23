/**
 * 受控的首次安装／删库恢复入口。
 *
 * P1/P2 复审（2026-10-22）之后，服务端**不会**因为“主库文件不存在”自动签发
 * 首空许可：那无法区分真正的新安装与旧库暂时缺失／runtime 状态丢失。
 *
 * 本命令的模式（全部需要显式选择）：
 *   · 默认（无 `--apply`）：**只读检查**。输出配置 epoch、生效 epoch、scope、
 *     三态可读性、持久证据与删库操作阶段；不写任何文件。
 *   · `--list-quarantine`：只读列举 `var/quarantine` 的快照、字节哈希，以及
 *     是否与删除日志的保护字节匹配（P2-5）。
 *   · `--apply --fresh-install`：仅用于没有主库、没有删库记录、没有**任何**历史
 *     证据的全新安装。在受控锁下重新检查后才写当前生效 scope 的 `pristine` 许可。
 *   · `--apply --deletion-id <id>`：恢复一笔已持久记录的删库操作。复用该操作，
 *     只为记录中的 `nextEpoch` 补写一次许可；不创建第二个 epoch。
 *   · `--apply --abandon-and-create-new-epoch --confirm-abandon <epoch>`：P1-5。
 *     写者已进入但主库从未建立的显式运维恢复：旧 scope 标记 abandoned，生成
 *     **全新** epoch 及其一次性许可，旧任务保持“结果未核实”而非伪失败。
 *   · `--apply --quarantine-unreadable-main --deletion-id <id>`：P2-5。只有
 *     删除日志保护字节匹配、主库确实不可读、运维显式确认时，才把主库字节隔离到
 *     `var/quarantine` 并推进到 `main_removed`。
 *
 * 本命令只写作用域账本、删库侧车与隔离文件，不创建主库、不迁移、不触碰健康数据。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  advanceDeletionOperation, advanceSidecarDatasetEpoch, closeDeletionOperation, readDatasetEpochState,
  type DatasetDeletionRecord, type DatasetEpochState
} from "./dataset-epoch.js";
import {
  confirmPreparedDeletionCompletion, deletionPermitProblem, listProtectionSnapshots,
  protectionSnapshotProblem, quarantineUnreadableMainDatabase
} from "./deletion-recovery.js";
import { RuntimeStateStore, type ImportScopeEvidenceRow } from "./runtime-state.js";
import { acquireDatabasePublicationLock, resolveDatabasePathIdentity } from "@rai/storage-sqlite";
import { faultPoint } from "./fault-injection.js";

const projectRoot = resolve(import.meta.dirname, "../../..");
const runtimeRoot = resolve(process.env.RAI_RUNTIME_ROOT ?? projectRoot);
const databasePath = resolveDatabasePathIdentity(
  process.env.RAI_DATABASE ?? resolve(projectRoot, "var/rai.sqlite"));
const serverId = process.env.RAI_SERVER_ID?.trim() || "local";
const athleteId = process.env.RAI_ATHLETE_ID?.trim() || "athlete_1";
const configuredEpoch = process.env.RAI_DATASET_EPOCH?.trim() || "default";
const identity = { serverId, athleteId };
const scopeFor = (epoch: string): string => JSON.stringify([serverId, athleteId, epoch]);
const sidecarPath = `${databasePath}.dataset-epoch.sqlite`;
const ledgerPath = resolve(runtimeRoot, "var/runtime.sqlite");

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const valueOf = (flag: string): string | null => {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
};

if (has("--help") || has("-h")) {
  process.stdout.write(
    "Usage: npm run data:init-scope [--list-quarantine]\n"
    + "  | --apply (--fresh-install\n"
    + "      | --deletion-id <id> [--confirm-main-removed]\n"
    + "      | --abandon-and-create-new-epoch --confirm-abandon <epoch> --reason <text>\n"
    + "      | --quarantine-unreadable-main --deletion-id <id>)\n"
    + "Environment: RAI_RUNTIME_ROOT, RAI_DATABASE, RAI_SERVER_ID, RAI_ATHLETE_ID, RAI_DATASET_EPOCH, RAI_OPERATOR\n"
    + "Default mode is a read-only inspection. It never creates the main database.\n"
  );
  process.exit(0);
}

type EvidenceRead =
  | { state: "absent" }
  | { state: "readable"; row: ImportScopeEvidenceRow | null; instanceId: string | null }
  | { state: "unreadable"; error: string };

/**
 * P1-8: distinguish "no ledger" from "ledger cannot be read".
 *
 * The old helper returned `null` for both. That made an unreadable or
 * quarantined ledger look exactly like a brand-new machine, which is precisely
 * the state `--fresh-install` must refuse. Query errors after a successful open
 * are still surfaced as errors (not silently downgraded).
 */
function readEvidenceReadOnly(scope: string): EvidenceRead {
  if (!existsSync(ledgerPath)) return { state: "absent" };
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(ledgerPath, { readOnly: true });
  } catch (error) {
    return { state: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const instanceTable = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='runtime_meta'"
    ).get() as { present: number } | undefined;
    const instanceId = instanceTable === undefined ? null
      : (database.prepare("SELECT value FROM runtime_meta WHERE key='rai.runtime-instance-id'")
        .get() as { value: string } | undefined)?.value ?? null;
    const table = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='import_scope_evidence'"
    ).get() as { present: number } | undefined;
    const row = table === undefined ? null : (database.prepare(`SELECT scope, state, first_empty_epoch AS firstEmptyEpoch,
      pristine_at AS pristineAt, permit_source AS permitSource,
      permit_revoked_at AS permitRevokedAt, writer_entered_at AS writerEnteredAt,
      dataset_established_at AS datasetEstablishedAt, detail
      FROM import_scope_evidence WHERE scope = ?`).get(scope) as ImportScopeEvidenceRow | undefined) ?? null;
    return { state: "readable", row, instanceId };
  } catch (error) {
    throw new Error(`Runtime ledger query failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally { database.close(); }
}

function mainDatabaseEvidence(): "absent" | "readable" | "unreadable" {
  if (!existsSync(databasePath)) return "absent";
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout=2000");
    const check = database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return check?.quick_check === "ok" ? "readable" : "unreadable";
  } catch {
    return "unreadable";
  } finally { database?.close(); }
}

interface HistoricalEvidence { kind: string; path: string; detail?: string }

/**
 * P1-8: every on-disk trace that means "this machine had a dataset before".
 *
 * `--fresh-install` may only run when this list is empty. A ledger file created
 * by this very command is intentionally not in the list; callers that have
 * already constructed the store check `quarantinedLedgerPath` separately.
 */
function scanHistoricalEvidence(options: { includeRuntimeLedger: boolean }): HistoricalEvidence[] {
  const found: HistoricalEvidence[] = [];
  if (existsSync(databasePath)) found.push({ kind: "main-database", path: databasePath });
  if (existsSync(sidecarPath)) found.push({ kind: "deletion-sidecar", path: sidecarPath });
  const varDirectory = resolve(runtimeRoot, "var");
  if (existsSync(varDirectory)) {
    for (const name of readdirSync(varDirectory)) {
      if (!options.includeRuntimeLedger && name === "runtime.sqlite") continue;
      if (name === "runtime.sqlite" || name.startsWith("runtime.sqlite-")
          || name.startsWith("runtime.sqlite.corrupt-")) {
        found.push({ kind: "runtime-ledger", path: resolve(varDirectory, name) });
      }
      if (name === "import-jobs.json" || name === "import-sources.json") {
        found.push({ kind: "import-history", path: resolve(varDirectory, name) });
      }
    }
  }
  return found;
}

function deletionSummary(record: DatasetDeletionRecord | null): Record<string, unknown> | null {
  if (record === null) return null;
  return {
    deletionId: record.deletionId,
    stage: record.stage,
    previousEpoch: record.previousEpoch,
    nextEpoch: record.nextEpoch,
    protectionSnapshot: record.protectionSnapshot,
    protectionKind: record.protectionKind,
    runtimeInstanceId: record.runtimeInstanceId,
    identity: record.version === 3 ? { serverId: record.serverId, athleteId: record.athleteId } : null,
    updatedAt: record.updatedAt
  };
}

function inspect(state: DatasetEpochState): void {
  const scope = scopeFor(state.epoch);
  const evidence = readEvidenceReadOnly(scope);
  const deletion = state.deletion;
  const main = mainDatabaseEvidence();
  const historical = scanHistoricalEvidence({ includeRuntimeLedger: true });
  // P3: `writer_entered` + missing main is never "none". An operator needs the
  // deletion id, the scope and the exact entry points.
  let actionRequired: string;
  if (deletion !== null && deletion.stage !== "writer_entered"
      && deletion.stage !== "rolled_back" && deletion.stage !== "superseded") {
    actionRequired = "deletion_recovery";
  } else if (deletion !== null && deletion.stage === "writer_entered") {
    actionRequired = evidence.state === "unreadable" ? "manual_review" : "database_recovery";
  } else if (evidence.state === "readable" && evidence.row?.writerEnteredAt != null
      && evidence.row.datasetEstablishedAt === null && main === "absent") {
    // P1-5/P3: writer entered, no dataset was ever established, and the main
    // file is gone. There is nothing to build on this boot: an operator must
    // either recover the original dataset or explicitly abandon the scope.
    actionRequired = "database_recovery";
  } else if (evidence.state === "unreadable") {
    actionRequired = "manual_review";
  } else if (state.epoch !== configuredEpoch || historical.length > 0) {
    actionRequired = "manual_review";
  } else if (evidence.state === "absent" && main === "absent") {
    actionRequired = "fresh_install_or_manual_review";
  } else {
    actionRequired = "none";
  }
  process.stdout.write(`${JSON.stringify({
    mode: "inspect",
    apply: false,
    configuredEpoch,
    persistedEpoch: state.epoch,
    epochSource: state.source,
    sidecarBackfillRequired: state.sidecarBackfillRequired === true,
    scope,
    databasePath,
    mainDatabaseEvidence: main,
    mainDatabaseExists: main !== "absent",
    runtimeLedgerEvidence: evidence.state,
    ...(evidence.state === "unreadable" ? { runtimeLedgerError: evidence.error } : {}),
    scopeEvidence: evidence.state === "readable" ? evidence.row : null,
    deletion: deletionSummary(deletion),
    runtimeInstanceId: evidence.state === "readable" ? evidence.instanceId : null,
    historicalEvidence: historical,
    actionRequired,
    ...(deletion !== null && deletion.stage === "writer_entered" ? {
      deletionId: deletion.deletionId,
      suggestedCommands: [
        `npm run data:init-scope -- --apply --abandon-and-create-new-epoch --confirm-abandon ${JSON.stringify(state.epoch)} --reason "<operator note>"`,
        "npm run data:init-scope -- --apply --deletion-id <id>   # only when the protection snapshot is the intended recovery"
      ]
    } : {}),
    note: "Read-only: no runtime ledger, deletion journal or main database was written."
  }, null, 2)}\n`);
}

let initializationLockDepth = 0;

/**
 * Exclusive creation of the initialization lock, with identity-bound stale
 * recovery.
 *
 * A `SIGKILL` between "ledger committed" and "sidecar written" must be
 * replayable with the same command, but the killed process cannot remove its
 * lock file. The lock therefore records pid + hostname; a **same-host** lock
 * whose pid no longer exists is stale and may be reclaimed. Unknown or
 * foreign-host contents are never removed.
 */
function acquireInitializationLockFile(lockPath: string): number {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx");
      try {
        writeSync(descriptor, JSON.stringify({
          pid: process.pid, host: hostname(), createdAt: new Date().toISOString()
        }));
        fsyncSync(descriptor);
      } catch (error) {
        closeSync(descriptor);
        try { unlinkSync(lockPath); } catch { /* best effort */ }
        throw error;
      }
      return descriptor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!reclaimStaleInitializationLock(lockPath)) {
        throw new Error(`Initialization lock ${lockPath} is held by a live or unknown process`);
      }
    }
  }
  throw new Error(`Could not acquire initialization lock ${lockPath}`);
}

function reclaimStaleInitializationLock(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    // The holder released it between our failure and this read: retry open.
    return true;
  }
  let record: { pid?: unknown; host?: unknown };
  try {
    record = JSON.parse(raw) as { pid?: unknown; host?: unknown };
  } catch {
    return false;
  }
  if (record.host !== hostname() || !Number.isInteger(record.pid) || (record.pid as number) <= 0) return false;
  try {
    process.kill(record.pid as number, 0);
    return false; // still alive
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  // Re-read before unlinking: never delete a lock a concurrent process just wrote.
  try {
    if (readFileSync(lockPath, "utf8") !== raw) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serialize every scope-initializing apply branch (fresh install, deletion
 * recovery, abandonment) on one exclusive lock.
 *
 * Re-entrant inside this process only: the CLI dispatcher holds the lock for
 * the whole apply branch, while helpers keep their own "re-check under the
 * lock" calls. Two OS processes can never both pass the pre-checks.
 */
function withInitializationLock<T>(operation: () => T): T {
  if (initializationLockDepth > 0) {
    initializationLockDepth += 1;
    try {
      return operation();
    } finally {
      initializationLockDepth -= 1;
    }
  }
  const lockPath = resolve(runtimeRoot, "var/import-scope-init.lock");
  mkdirSync(resolve(runtimeRoot, "var"), { recursive: true });
  let descriptor: number;
  try {
    descriptor = acquireInitializationLockFile(lockPath);
  } catch (error) {
    throw new Error(
      `Another scope initialization holds ${lockPath}; refusing to race it. `
      + "Inspect the process and remove the lock only after confirming it is stale.",
      { cause: error });
  }
  initializationLockDepth = 1;
  try {
    return operation();
  } finally {
    initializationLockDepth = 0;
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

function applyFreshInstall(state: DatasetEpochState): void {
  if (state.deletion !== null) {
    throw new Error(
      "A persisted dataset deletion journal exists (even if rolled back); "
      + "use --apply --deletion-id for that recorded operation instead of --fresh-install");
  }
  if (state.epoch !== configuredEpoch) {
    throw new Error(
      `The effective epoch ${JSON.stringify(state.epoch)} differs from the configured `
      + `${JSON.stringify(configuredEpoch)}; this is not a fresh install`);
  }
  const before = scanHistoricalEvidence({ includeRuntimeLedger: true });
  if (before.length > 0) {
    throw new Error(
      "Refusing --fresh-install: historical evidence exists and proves this machine is not new:\n"
      + before.map((item) => `  - ${item.kind}: ${item.path}`).join("\n")
      + "\nUse --apply --abandon-and-create-new-epoch for an operator-approved new epoch, "
      + "or restore the existing dataset.");
  }
  withInitializationLock(() => {
    // Re-check under the lock: nothing may appear between inspection and permit.
    const again = scanHistoricalEvidence({ includeRuntimeLedger: true });
    if (again.length > 0) {
      throw new Error(
        "Refusing --fresh-install: evidence appeared while acquiring the initialization lock:\n"
        + again.map((item) => `  - ${item.kind}: ${item.path}`).join("\n"));
    }
    if (existsSync(databasePath) || existsSync(sidecarPath)) {
      throw new Error("Refusing --fresh-install: the main database or deletion sidecar appeared during initialization");
    }
    const store = new RuntimeStateStore(runtimeRoot);
    if (store.quarantinedLedgerPath !== null) {
      throw new Error(
        `The runtime ledger was corrupt and has been quarantined at ${store.quarantinedLedgerPath}; `
        + "an empty rebuilt ledger is not proof of a fresh install. Manual review is required.");
    }
    const scope = scopeFor(state.epoch);
    const evidence = store.establishPristineScope(scope, "operator_first_install");
    process.stdout.write(`${JSON.stringify({
      mode: "apply",
      applied: "fresh_install",
      configuredEpoch,
      persistedEpoch: state.epoch,
      epochSource: state.source,
      scope,
      runtimeState: store.path,
      databasePath,
      state: evidence.state,
      firstEmptyEpoch: evidence.firstEmptyEpoch,
      pristineAt: evidence.pristineAt,
      permitSource: evidence.permitSource,
      note: "The permit is consumed by the next import writer and never revives."
    }, null, 2)}\n`);
  });
}

function applyDeletionRecovery(state: DatasetEpochState, deletionId: string): void {
  if (existsSync(databasePath)) {
    throw new Error(
      "Refusing deletion recovery while a main database file exists. If it is readable, restore/inspect it; "
      + "if it is unreadable, use --apply --quarantine-unreadable-main --deletion-id " + deletionId);
  }
  if (state.deletion === null) throw new Error(`No persisted deletion record matches ${deletionId}`);
  if (state.deletion.deletionId !== deletionId) {
    throw new Error(`Persisted deletion id ${state.deletion.deletionId} does not match requested ${deletionId}`);
  }
  const store = new RuntimeStateStore(runtimeRoot);
  if (state.deletion.runtimeInstanceId !== store.runtimeInstanceId()) {
    throw new Error(
      `Runtime ledger instance ${store.runtimeInstanceId()} does not match deletion record `
      + `${state.deletion.runtimeInstanceId}; refusing to reissue its permit`);
  }
  let record = state.deletion;
  if (record.stage === "prepared") {
    const problem = protectionSnapshotProblem(runtimeRoot, record);
    if (problem !== null) throw new Error(problem);
    if (!has("--confirm-main-removed")) {
      throw new Error(
        "Deletion is still at prepared but the main database is absent. Restore the protection snapshot first, "
        + "or pass --confirm-main-removed after verifying the snapshot to complete this recorded deletion.");
    }
    record = confirmPreparedDeletionCompletion({
      databasePath, configuredEpoch, runtimeRoot, serverId, athleteId, store
    }, deletionId);
  }
  if (record.stage !== "main_removed" && record.stage !== "permit_issued") {
    throw new Error(`Deletion stage ${record.stage} cannot be recovered; no permit was issued`);
  }
  if (record.stage === "main_removed") {
    // Only main_removed still needs the protection snapshot: permit_issued
    // already has its one-shot permit, and the snapshot may have been rotated
    // off-host without invalidating that permit (P2-2 / docs/OPERATIONS).
    const problem = protectionSnapshotProblem(runtimeRoot, record);
    if (problem !== null) throw new Error(problem);
  }
  const scope = scopeFor(record.nextEpoch);
  // Once the journal says permit_issued, absence is ambiguous: the writer may
  // have consumed the permit just before a crash. Only main_removed may mint it.
  const evidence = record.stage === "main_removed"
    ? store.establishDeletionPermit(scope, deletionId)
    : store.scopeEvidence(scope);
  if (record.stage === "permit_issued") {
    // Shared with the startup reconciler: the CLI and the API must accept
    // exactly the same original permit (P1-2 #3 / P2-2).
    const permitProblem = deletionPermitProblem(store, record, scope, identity);
    if (permitProblem !== null) {
      throw new Error(`The issued deletion permit is missing or consumed: ${permitProblem}`);
    }
  }
  if (evidence === null || evidence.state !== "pristine"
      || evidence.permitSource !== `explicit_database_delete:${deletionId}`
      || evidence.permitRevokedAt !== null || evidence.writerEnteredAt !== null
      || evidence.datasetEstablishedAt !== null) {
    throw new Error("The issued deletion permit is missing or consumed; refusing to mint another one");
  }
  const advanced = advanceDeletionOperation(
    databasePath, configuredEpoch, deletionId, "permit_issued", undefined, identity);
  process.stdout.write(`${JSON.stringify({
    mode: "apply",
    applied: "deletion_recovery",
    configuredEpoch,
    persistedEpoch: record.nextEpoch,
    scope,
    deletion: deletionSummary(advanced),
    runtimeState: store.path,
    databasePath,
    state: evidence.state,
    firstEmptyEpoch: evidence.firstEmptyEpoch,
    pristineAt: evidence.pristineAt,
    permitSource: evidence.permitSource,
    note: "The recorded deletion permit is issued once; the next import writer consumes it permanently."
  }, null, 2)}\n`);
}

/**
 * P1-5: the first writer persisted `writer_entered` but the main database was
 * never created. There is no safe way to revive the old permit; this operation
 * records the abandonment and mints one permit for a **new** epoch.
 *
 * `--confirm-abandon <old epoch>` is the operation identity. A retry after a
 * crash — whether the sidecar was already switched or not — must only complete
 * the persisted operation, never mint a second epoch or permit.
 */
function applyAbandonAndCreateNewEpoch(state: DatasetEpochState): void {
  const confirmed = valueOf("--confirm-abandon");
  if (confirmed === null) {
    throw new Error(
      "--abandon-and-create-new-epoch requires --confirm-abandon <epoch> "
      + "(the effective epoch printed by the read-only inspection)");
  }
  const reason = valueOf("--reason")?.trim() ?? "";
  if (reason === "") throw new Error("--abandon-and-create-new-epoch requires a non-empty --reason");
  // A *completed* operation may legitimately have a database now (the new
  // epoch was used). That case is handled below by reporting completion; a
  // first attempt must never touch existing bytes.
  const oldScope = scopeFor(confirmed);
  const store = new RuntimeStateStore(runtimeRoot);
  const operator = process.env.RAI_OPERATOR?.trim() || "operator";
  const existing = store.abandonmentFor(oldScope);

  if (existing !== null) {
    if (existing.oldEpoch !== confirmed) {
      throw new Error(
        `A recorded abandonment for ${oldScope} uses old epoch ${JSON.stringify(existing.oldEpoch)}, `
        + `not ${JSON.stringify(confirmed)}; manual review required`);
    }
    if (existing.operator !== operator || existing.reason !== reason) {
      throw new Error(
        `Abandonment ${existing.id} was recorded by ${JSON.stringify(existing.operator)} with a different `
        + "operator statement; the retry is incompatible. Manual review required.");
    }
    if (state.deletion !== null && state.deletion.runtimeInstanceId !== store.runtimeInstanceId()) {
      throw new Error(
        `Runtime ledger instance ${store.runtimeInstanceId()} does not match deletion record `
        + `${state.deletion.runtimeInstanceId}; refusing to replay on an unrelated ledger`);
    }
    if (state.epoch !== confirmed && state.epoch !== existing.newEpoch) {
      throw new Error(
        `Persisted epoch ${JSON.stringify(state.epoch)} belongs neither to the abandoned epoch `
        + `${JSON.stringify(confirmed)} nor to the recorded replacement ${JSON.stringify(existing.newEpoch)}`);
    }
    if (state.epoch === confirmed) {
      // The sidecar has not switched yet: this is still step two. The new
      // one-shot permit must be pristine; otherwise advancing the sidecar
      // would point the deployment at a scope that can never import.
      store.assertAbandonmentReplayable(existing, { oldEpoch: confirmed, operator, reason });
      // Crash after the ledger transaction committed but before the sidecar.
      // Only the second step is replayed, using the persisted new epoch.
      if (existsSync(databasePath) || existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`)) {
        throw new Error(
          "Refusing to finish the abandonment: a main database or WAL/SHM appeared after the ledger commit. "
          + "Confirm the files are absent or restore the original dataset; manual review required.");
      }
      finishAbandonSidecar(state, confirmed, existing.newEpoch, reason);
    } else {
      // The sidecar already points at the recorded replacement epoch. The
      // operation is complete even though the one-shot permit may have been
      // legitimately consumed by the first import; only report completion.
      store.assertAbandonmentCompleted(existing, { oldEpoch: confirmed, operator, reason });
    }
    process.stdout.write(`${JSON.stringify({
      mode: "apply",
      applied: "abandon_and_create_new_epoch",
      completed: true,
      replayed: true,
      configuredEpoch,
      previousEpoch: confirmed,
      persistedEpoch: existing.newEpoch,
      oldScope,
      scope: existing.newScope,
      operator,
      reason,
      runtimeState: store.path,
      databasePath,
      note: "This operator operation was already recorded; no new epoch or permit was created."
    }, null, 2)}\n`);
    return;
  }

  if (confirmed !== state.epoch) {
    throw new Error(
      `--confirm-abandon ${JSON.stringify(confirmed)} does not match the effective epoch ${JSON.stringify(state.epoch)}`);
  }
  if (existsSync(databasePath)) {
    throw new Error(
      "Refusing to abandon the scope while a main database file exists. "
      + "Confirm the original main database, WAL and SHM are absent first.");
  }
  if (existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`)) {
    throw new Error("Refusing to abandon the scope while WAL/SHM files still exist; remove or restore them first");
  }
  if (state.deletion !== null
      && state.deletion.stage !== "writer_entered"
      && state.deletion.stage !== "rolled_back"
      && state.deletion.stage !== "superseded") {
    throw new Error(
      `Deletion ${state.deletion.deletionId} is at stage ${state.deletion.stage}; `
      + "finish or roll it back with --deletion-id instead of abandoning the scope");
  }
  const evidence = readEvidenceReadOnly(oldScope);
  if (evidence.state === "unreadable") {
    throw new Error(
      `The runtime ledger is unreadable (${evidence.error}); refusing to infer writer-entered state from it`);
  }
  if (evidence.state !== "readable" || evidence.row === null) {
    throw new Error(
      `No runtime evidence exists for scope ${oldScope}; a first install is initialized with --fresh-install, `
      + "not by abandoning an unknown scope");
  }
  if (evidence.row.writerEnteredAt === null || evidence.row.datasetEstablishedAt !== null) {
    throw new Error(
      "The scope does not show 'writer entered but dataset never established'; "
      + "there is no interrupted first install to abandon");
  }
  if (state.deletion !== null && state.deletion.runtimeInstanceId !== store.runtimeInstanceId()) {
    throw new Error(
      `Runtime ledger instance ${store.runtimeInstanceId()} does not match deletion record `
      + `${state.deletion.runtimeInstanceId}; refusing to abandon the scope on an unrelated ledger`);
  }
  const at = new Date().toISOString();
  const result = store.abandonWriterEnteredScope({
    oldScope, oldEpoch: state.epoch, operator, reason, at
  });
  // Acceptance barrier: a kill here must be replayable with the **persisted**
  // epoch; the retry may only complete step two.
  faultPoint("scope-abandon:after-ledger-commit");
  finishAbandonSidecar(state, state.epoch, result.abandonment.newEpoch, reason);
  faultPoint("scope-abandon:after-sidecar-write");
  process.stdout.write(`${JSON.stringify({
    mode: "apply",
    applied: "abandon_and_create_new_epoch",
    completed: true,
    replayed: false,
    configuredEpoch,
    previousEpoch: state.epoch,
    persistedEpoch: result.abandonment.newEpoch,
    oldScope,
    scope: result.abandonment.newScope,
    operator,
    reason,
    deletion: deletionSummary(state.deletion),
    runtimeState: store.path,
    databasePath,
    state: result.evidence.state,
    firstEmptyEpoch: result.evidence.firstEmptyEpoch,
    pristineAt: result.evidence.pristineAt,
    permitSource: result.evidence.permitSource,
    note: "The old scope is abandoned (its jobs stay unverified); the new permit is consumed once by a new job identity."
  }, null, 2)}\n`);
}

/**
 * Step two of the abandonment: switch the deletion sidecar to the **persisted**
 * new epoch. Compare-before-write: old epoch → write; same new epoch → no-op;
 * anything else → refuse.
 */
function finishAbandonSidecar(
  state: DatasetEpochState, expectedEpoch: string, newEpoch: string, reason: string
): void {
  if (state.deletion !== null) {
    closeDeletionOperation(databasePath, configuredEpoch, newEpoch, {
      deletionId: state.deletion.deletionId,
      reason: `operator abandoned the interrupted first install: ${reason}`,
      supersedeConsumed: true
    });
    return;
  }
  advanceSidecarDatasetEpoch(databasePath, configuredEpoch, expectedEpoch, newEpoch);
}

function listQuarantine(state: DatasetEpochState): void {
  const listings = listProtectionSnapshots(runtimeRoot, state.deletion);
  process.stdout.write(`${JSON.stringify({
    mode: "list_quarantine",
    apply: false,
    runtimeRoot,
    quarantineDirectory: resolve(runtimeRoot, "var/quarantine"),
    deletion: deletionSummary(state.deletion),
    snapshots: listings,
    note: "Read-only listing. Matching bytes do not confirm a deletion; an operator must choose the recovery path."
  }, null, 2)}\n`);
}

function quarantineUnreadableMain(state: DatasetEpochState, deletionId: string): void {
  if (state.deletion === null || state.deletion.deletionId !== deletionId) {
    throw new Error(`No persisted deletion record matches ${deletionId}`);
  }
  if (!has("--confirm-quarantine")) {
    throw new Error(
      "Refusing to quarantine the main database without --confirm-quarantine. "
      + "Run --list-quarantine first and verify the protection snapshot bytes.");
  }
  const store = new RuntimeStateStore(runtimeRoot);
  const result = quarantineUnreadableMainDatabase({
    databasePath, configuredEpoch, runtimeRoot, serverId, athleteId, store
  }, deletionId);
  process.stdout.write(`${JSON.stringify({
    mode: "apply",
    applied: "quarantine_unreadable_main",
    configuredEpoch,
    deletion: deletionSummary(result.record),
    quarantinedSnapshot: result.name,
    quarantinedFiles: result.files,
    quarantineDirectory: resolve(runtimeRoot, "var/quarantine"),
    note: "The unreadable bytes were moved and re-hashed; the recorded deletion is now main_removed."
  }, null, 2)}\n`);
}

try {
  // 阶段 4（I1）：`--apply` 必须在**读取任何 state 之前**取得主库 publication
  // lock —— 否则 API 可以在“读 state”和“取锁”之间写库，预检看到的就不是
  // 真正要修改的快照。只读分支（检查/列举）不取锁。
  const apply = has("--apply");
  const releasePublication = apply ? acquireDatabasePublicationLock(databasePath, "cli") : null;
  try {
    const state = readDatasetEpochState(databasePath, configuredEpoch, {
      strictConfigured: true, identity
    });
    if (has("--list-quarantine")) {
      listQuarantine(state);
    } else if (!apply) {
      inspect(state);
    } else {
      // Every apply branch that may create a scope permit shares one exclusive
      // boundary: two operators cannot both pass the pre-checks. It is nested
      // inside the main-database publication lock acquired above.
      // Lock order is fixed: main DB lock → runtime initialization lock.
      withInitializationLock(() => {
        if (has("--fresh-install")) {
          applyFreshInstall(state);
        } else if (has("--abandon-and-create-new-epoch")) {
          applyAbandonAndCreateNewEpoch(state);
        } else if (has("--quarantine-unreadable-main")) {
          const deletionId = valueOf("--deletion-id");
          if (deletionId === null || deletionId.trim() === "") {
            throw new Error("--quarantine-unreadable-main requires --deletion-id <id>");
          }
          quarantineUnreadableMain(state, deletionId.trim());
        } else {
          const deletionId = valueOf("--deletion-id");
          if (deletionId === null || deletionId.trim() === "") {
            throw new Error("--apply requires --fresh-install, --deletion-id <id>, --abandon-and-create-new-epoch or --quarantine-unreadable-main");
          }
          applyDeletionRecovery(state, deletionId.trim());
        }
      });
    }
  } finally {
    releasePublication?.();
  }
} catch (error) {
  process.stderr.write(`Dataset scope initialization refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
