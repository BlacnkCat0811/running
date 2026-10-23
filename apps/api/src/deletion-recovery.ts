import { createHash } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, writeFileSync
} from "node:fs";
import { basename, resolve } from "node:path";

import { isStructurallyReadable, quickCheckDatabase } from "@rai/storage-sqlite";

import {
  advanceDeletionOperation,
  assertDeletionPermitIdentity,
  closeDeletionOperation,
  readDatasetEpochState,
  readDeletionOperation,
  readSidecarDatasetEpochValue,
  type DatasetDeletionIdentity,
  type DatasetDeletionRecord,
  type DatasetEpochState,
  type DatasetDeletionProtectionKind,
  type ProtectionSnapshotFile
} from "./dataset-epoch.js";
import { RuntimeStateStore } from "./runtime-state.js";

export type DatasetDeletionStartupOutcome =
  | "no-deletion"
  | "rolled-back"
  | "permit-reissued"
  | "permit-present"
  | "permit-consumed"
  | "recovery-required";

export interface DatasetDeletionStartupDecision {
  readonly epochState: DatasetEpochState;
  readonly outcome: DatasetDeletionStartupOutcome;
  /**
   * True means: the scope must **not** be allowed to create a main database on
   * this boot. The caller keeps serving maintenance/recovery routes but the
   * import worker's first-empty permit is invalidated below.
   */
  readonly recoveryRequired: boolean;
  readonly detail: string | null;
  readonly deletion: DatasetDeletionRecord | null;
}

export interface DatasetDeletionStartupInput {
  databasePath: string;
  configuredEpoch: string;
  runtimeRoot: string;
  serverId: string;
  athleteId: string;
  store: RuntimeStateStore;
}

const identityOf = (input: { serverId: string; athleteId: string }) =>
  ({ serverId: input.serverId, athleteId: input.athleteId });

/** Where `DatabaseMaintenance` keeps the snapshot named by the deletion record. */
export function protectionSnapshotPath(runtimeRoot: string, record: DatasetDeletionRecord): string {
  const directory = record.protectionKind === "quarantine" ? "var/quarantine" : "var/backups";
  return resolve(runtimeRoot, directory, record.protectionSnapshot);
}

const SNAPSHOT_SUFFIXES = ["", "-wal", "-shm"] as const;

function snapshotFile(path: string, suffix: ProtectionSnapshotFile["suffix"]): ProtectionSnapshotFile {
  const filename = `${path}${suffix}`;
  const sizeBytes = statSync(filename).size;
  const sha = createHash("sha256");
  const descriptor = openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead: number;
    let totalBytes = 0;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      sha.update(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes !== sizeBytes || statSync(filename).size !== sizeBytes) {
      throw new Error(`Protection snapshot changed while hashing: ${filename}`);
    }
  } finally { closeSync(descriptor); }
  return { suffix, sizeBytes, sha256: sha.digest("hex") };
}

/** Capture a verified, byte-bound protection set before writing `prepared`. */
export function captureProtectionSnapshot(
  runtimeRoot: string, name: string, kind: DatasetDeletionProtectionKind
): ProtectionSnapshotFile[] {
  const path = resolve(runtimeRoot, kind === "quarantine" ? "var/quarantine" : "var/backups", name);
  const files = SNAPSHOT_SUFFIXES
    .filter((suffix) => suffix === "" || (kind === "quarantine" && existsSync(`${path}${suffix}`)))
    .map((suffix) => snapshotFile(path, suffix));
  if (files[0]?.sizeBytes === 0) throw new Error(`Protection snapshot is empty: ${path}`);
  if (kind === "backup") {
    const integrity = quickCheckDatabase(path);
    if (!integrity.ok) throw new Error(`Protection snapshot failed integrity check: ${integrity.reason}`);
  }
  return files;
}

/** Human-readable reason the bound snapshot is unusable, or `null` when verified. */
export function protectionSnapshotProblem(runtimeRoot: string, record: DatasetDeletionRecord): string | null {
  const path = protectionSnapshotPath(runtimeRoot, record);
  if (!existsSync(path)) return `protection snapshot is missing: ${path}`;
  try {
    if (record.protectionFiles === undefined) {
      // Version 1 has no byte binding. Only a structurally valid SQLite backup
      // may be recovered automatically; a legacy quarantine needs operator restore.
      if (record.protectionKind === "quarantine") return `legacy quarantine snapshot has no digest: ${path}`;
      const integrity = quickCheckDatabase(path);
      return integrity.ok ? null : `protection snapshot failed integrity check: ${integrity.reason}`;
    }
    const actualSuffixes = SNAPSHOT_SUFFIXES.filter((suffix) =>
      suffix === "" || (record.protectionKind === "quarantine" && existsSync(`${path}${suffix}`)));
    if (actualSuffixes.length !== record.protectionFiles.length
        || actualSuffixes.some((suffix, index) => suffix !== record.protectionFiles?.[index]?.suffix)) {
      return `protection snapshot file set changed: ${path}`;
    }
    for (const [index, suffix] of actualSuffixes.entries()) {
      const actual = snapshotFile(path, suffix);
      const expected = record.protectionFiles[index]!;
      if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) {
        return `protection snapshot bytes changed: ${path}${suffix}`;
      }
    }
  } catch (error) {
    return `protection snapshot is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/**
 * Decide what a persisted deletion intent means **before** any worker can open or
 * create the facts database.
 *
 * The decision is intentionally stage-first, not "file exists?"-first:
 * - `prepared` + main present is a replayable rollback (old dataset wins) only
 *   when the readable epoch and the protection-snapshot identity agree.
 * - `prepared` + main absent is ambiguous and stays blocked.
 * - `main_removed` + main absent + same ledger instance may issue the one permit
 *   that the recorded operation already authorized.
 * - `main_removed` / `permit_issued` + a readable main database is **not**
 *   automatically a rollback: the explicit main epoch must equal `previousEpoch`
 *   and the protection snapshot must still match its byte binding. Any other
 *   epoch is uncredentialed and stays `recovery_required` without revoking or
 *   closing the journal.
 * - `permit_issued` may only consume the existing permit; it never mints a new one.
 * - `writer_entered` never issues a permit again, and never infers a completed
 *   explicit restore from a readable main with a different epoch. That path is
 *   finalized only from a durable, bound restore intent.
 */
export function reconcileDatasetDeletionAtStartup(
  input: DatasetDeletionStartupInput
): DatasetDeletionStartupDecision {
  const state = readDatasetEpochState(input.databasePath, input.configuredEpoch, {
    strictConfigured: true, identity: identityOf(input)
  });
  const deletion = state.deletion;
  if (deletion === null) {
    return { epochState: state, outcome: "no-deletion", recoveryRequired: false, detail: null, deletion: null };
  }

  const at = new Date().toISOString();
  const scopeFor = (epoch: string): string => JSON.stringify([input.serverId, input.athleteId, epoch]);
  const nextScope = scopeFor(deletion.nextEpoch);
  const blockedEpoch = deletion.stage === "rolled_back" || deletion.stage === "superseded"
    ? state.epoch : deletion.nextEpoch;
  const mainExists = existsSync(input.databasePath);
  // A newly built WAL database can be fully readable while the shallow probe's
  // file-size/page-count equality fails: page_count includes WAL pages that have
  // not yet been checkpointed into the main file. Resolve that case with SQLite's
  // own integrity check before treating a consumed deletion as missing data.
  const readable = mainExists && (isStructurallyReadable(input.databasePath)
    || quickCheckDatabase(input.databasePath).ok);
  const sameLedger = deletion.runtimeInstanceId === input.store.runtimeInstanceId();

  /**
   * P1-2: a boot *decision* that cannot be made (a temporarily missing
   * snapshot, a ledger-instance mismatch, a schema conflict) must not revoke an
   * already-issued permit. The persisted journal makes the next boot
   * re-adjudicate, so an in-memory refusal is enough. Only an actual
   * "main database exists and is inspected as unreadable" observation may
   * write the irreversible `unknown` scope state.
   */
  const blocked = (
    detail: string,
    options: { mainDatabaseUnreadable?: boolean; markUnreadable?: boolean; epoch?: string } = {}
  ): DatasetDeletionStartupDecision => {
    const markUnreadable = options.markUnreadable
      ?? options.mainDatabaseUnreadable === true;
    if (markUnreadable) {
      input.store.markScopeDatabaseUnreadable(
        scopeFor(blockedEpoch), at, `startup deletion recovery: ${detail}`);
    }
    return {
      epochState: { ...state, epoch: options.epoch ?? blockedEpoch, source: "deleted-sidecar" },
      outcome: "recovery-required",
      recoveryRequired: true,
      detail,
      deletion
    };
  };

  /**
   * Close the journal as a rollback **only** after proving the readable main
   * database is the previous dataset and that the deletion's protection
   * snapshot is still the byte-bound snapshot recorded with the operation.
   * A readable file with an injected/foreign epoch is not a rollback.
   */
  const originalRollbackProblem = (requireExplicitEpoch: boolean): string | null => {
    if (requireExplicitEpoch && state.mainEpochExplicit !== true) {
      return "the readable main database has no explicit persisted dataset epoch";
    }
    if (state.epoch !== deletion.previousEpoch) {
      return `the readable main database reports epoch ${JSON.stringify(state.epoch)}, not the `
        + `deletion's previous epoch ${JSON.stringify(deletion.previousEpoch)}`;
    }
    return protectionSnapshotProblem(input.runtimeRoot, deletion);
  };

  const rollbackToMain = (mainEpoch: string, reason: string): DatasetDeletionStartupDecision => {
    // P2-3: revoke the next-scope permit **before** closing the journal. A kill
    // in between re-adjudicates; the reverse order could leave a permit that
    // the already-rolled-back journal no longer authorizes.
    input.store.revokeDeletionPermit(nextScope, deletion.deletionId, at);
    closeDeletionOperation(input.databasePath, input.configuredEpoch, mainEpoch, {
      deletionId: deletion.deletionId,
      reason,
      at
    });
    input.store.markScopeDatasetEstablished(scopeFor(mainEpoch), at);
    return {
      epochState: { ...state, epoch: mainEpoch, source: "main", deletion: readDeletionOperation(
        input.databasePath, input.configuredEpoch, { strictConfigured: true, identity: identityOf(input) }) },
      outcome: "rolled-back",
      recoveryRequired: false,
      detail: reason,
      deletion
    };
  };

  const permitMatches = (): "match" | "conflict" | "missing" => {
    const evidence = input.store.scopeEvidence(nextScope);
    if (evidence === null) return "missing";
    const source = `explicit_database_delete:${deletion.deletionId}`;
    return evidence.state === "pristine"
      && evidence.permitSource === source
      && evidence.permitRevokedAt === null
      && evidence.writerEnteredAt === null
      && evidence.datasetEstablishedAt === null
      ? "match" : "conflict";
  };

  if (deletion.stage === "prepared") {
    if (readable) {
      const problem = originalRollbackProblem(true);
      if (problem !== null) {
        return blocked(
          `prepared deletion cannot be rolled back: ${problem}; refusing to guess which dataset is authoritative`);
      }
      return rollbackToMain(state.epoch, "main database survived the prepared deletion; old dataset retained");
    }
    if (mainExists) {
      return blocked(
        "prepared deletion with an unreadable main database; manual recovery required",
        { mainDatabaseUnreadable: true });
    }
    // File absence is not proof that the unlink completed. Never promote prepared
    // to main_removed from an observation; an operator must confirm it.
    return blocked(
      "prepared deletion and the main database is absent; deletion completion is unproven "
      + "(restore the protection snapshot or confirm the deletion explicitly)");
  }

  if (deletion.stage === "main_removed") {
    if (readable) {
      const problem = originalRollbackProblem(true);
      if (problem !== null) {
        return blocked(
          `main database reappeared after main_removed but ${problem}; refusing to revoke the permit or close the journal`);
      }
      return rollbackToMain(state.epoch, "the recorded previous dataset reappeared after main_removed; permit withheld");
    }
    if (mainExists) {
      return blocked("main database exists but is unreadable after main_removed", { mainDatabaseUnreadable: true });
    }
    if (!sameLedger) {
      return blocked(
        `runtime ledger instance ${input.store.runtimeInstanceId()} does not match the deletion record `
        + `${deletion.runtimeInstanceId}; refusing to reissue the permit`);
    }
    const snapshotProblem = protectionSnapshotProblem(input.runtimeRoot, deletion);
    if (snapshotProblem !== null) {
      // P1-2: the snapshot may be temporarily moved by an operator (rotation,
      // off-host copy). That is not permission to revoke the recorded permit;
      // the journal itself keeps the next boot blocked until it is back.
      return blocked(snapshotProblem, { markUnreadable: false });
    }
    try {
      assertDeletionPermitIdentity(deletion, identityOf(input));
    } catch (error) {
      return blocked(error instanceof Error ? error.message : String(error), { markUnreadable: false });
    }
    const existing = permitMatches();
    if (existing === "conflict") {
      return blocked("the next scope already has incompatible evidence; refusing to reissue the permit");
    }
    if (existing === "missing") input.store.establishDeletionPermit(nextScope, deletion.deletionId, at);
    advanceDeletionOperation(
      input.databasePath, input.configuredEpoch, deletion.deletionId, "permit_issued", at, identityOf(input));
    return {
      epochState: { ...state, epoch: deletion.nextEpoch, source: "deleted-sidecar" },
      outcome: existing === "match" ? "permit-present" : "permit-reissued",
      recoveryRequired: false,
      detail: existing === "match" ? "replayed the already-issued permit" : "issued the recorded deletion permit",
      deletion: { ...deletion, stage: "permit_issued", updatedAt: at }
    };
  }

  if (deletion.stage === "permit_issued") {
    if (readable) {
      const problem = originalRollbackProblem(true);
      if (problem !== null) {
        return blocked(
          `main database exists at permit_issued but ${problem}; refusing to revoke the permit or close the journal`);
      }
      return rollbackToMain(state.epoch, "the recorded previous dataset reappeared at permit_issued; the permit is superseded");
    }
    if (mainExists) {
      return blocked(
        "main database exists but is unreadable at permit_issued", { mainDatabaseUnreadable: true });
    }
    if (!sameLedger) {
      return blocked(
        `runtime ledger instance ${input.store.runtimeInstanceId()} does not match the deletion record `
        + `${deletion.runtimeInstanceId}; the issued permit cannot be trusted`);
    }
    // P2-2: by this stage the snapshot has already done its job (the permit was
    // issued). Requiring it to remain byte-identical would let an ordinary
    // off-host rotation turn a valid, unconsumed permit into a boot block.
    //
    // The verification is shared with the recovery CLI (P1-2 #3): both must
    // accept exactly the same permit or an operator can end up in a state where
    // startup continues and the CLI refuses (or vice versa).
    const problem = deletionPermitProblem(input.store, deletion, nextScope, identityOf(input));
    if (problem !== null) {
      return blocked(`permit_issued but ${problem}; refusing to mint a second permit`, { markUnreadable: false });
    }
    return {
      epochState: { ...state, epoch: deletion.nextEpoch, source: "deleted-sidecar" },
      outcome: "permit-present",
      recoveryRequired: false,
      detail: "the recorded permit is still pristine and may be consumed once by the first writer",
      deletion
    };
  }

  if (deletion.stage === "writer_entered") {
    if (readable) {
      if (state.epoch === deletion.nextEpoch) {
        // Without an epoch row, readDatasetEpochState derives nextEpoch from the
        // deletion sidecar. That is not evidence about these main-database bytes:
        // an older, epoch-less RAI database could have appeared at this path.
        // A first writer now persists the epoch immediately after creating the
        // database; a crash before that write must remain operator-recoverable.
        if (state.mainEpochExplicit !== true) {
          return blocked(
            "the first writer entered but the readable main database has no explicit persisted "
            + "dataset epoch; refusing to infer its identity from the deletion sidecar");
        }
        input.store.markScopeDatasetEstablished(scopeFor(state.epoch), at);
        return {
          epochState: { ...state, epoch: state.epoch, source: "main" },
          outcome: "permit-consumed",
          recoveryRequired: false,
          detail: "first writer already entered; dataset is established",
          deletion
        };
      }
      if (state.mainEpochExplicit !== true) {
        return blocked(
          "the first writer already entered but the readable main database has neither the deletion epoch "
          + "nor an explicit replacement epoch; refusing to infer that an explicit restore completed");
      }
      // Do **not** infer a completed explicit restore from "readable + a
      // different epoch". A crash-interrupted restore is finalized from the
      // durable restore intent before deletion reconciliation runs. Without
      // that record this is an uncredentialed dataset and must stay blocked.
      return blocked(
        `the first writer already entered but the readable main database reports epoch `
        + `${JSON.stringify(state.epoch)}, not the deletion epoch ${JSON.stringify(deletion.nextEpoch)}, `
        + "and no verified restore intent authorizes that epoch; refusing to close the journal");
    }
    return blocked(
      `the first writer for the deletion epoch already entered but the main database is ${mainExists ? "unreadable" : "absent"}; `
      + "no new empty database may be created",
      { mainDatabaseUnreadable: mainExists });
  }

  // rolled_back / superseded: the sidecar's final epoch is authoritative after
  // an explicit restore, not the old deletion's nextEpoch.
  if (readable) {
    const closedEpochFallback = deletion.previousEpoch;
    if (state.mainEpochExplicit !== true) {
      return blocked(
        `${deletion.stage} deletion has a readable main database without an explicit dataset epoch; `
        + "refusing to adopt an unverified dataset", { epoch: closedEpochFallback });
    }
    const mainEpoch = state.epoch;
    let sidecarEpoch: string | null;
    try {
      sidecarEpoch = readSidecarDatasetEpochValue(input.databasePath, input.configuredEpoch);
    } catch (error) {
      return blocked(
        `${deletion.stage} deletion cannot read its authoritative sidecar epoch: `
        + `${error instanceof Error ? error.message : String(error)}`, { epoch: closedEpochFallback });
    }
    if (sidecarEpoch === null || sidecarEpoch !== mainEpoch) {
      return blocked(
        `${deletion.stage} deletion records epoch ${JSON.stringify(sidecarEpoch)}, but the readable main `
        + `database reports ${JSON.stringify(mainEpoch)}; refusing to adopt the uncredentialed epoch`,
        { epoch: sidecarEpoch ?? closedEpochFallback });
    }
    input.store.markScopeDatasetEstablished(scopeFor(mainEpoch), at);
    return {
      epochState: { ...state, epoch: mainEpoch, source: "main" },
      outcome: "rolled-back",
      recoveryRequired: false,
      detail: deletion.stage === "superseded"
        ? "deletion was superseded by a restored dataset"
        : "deletion was rolled back; the existing dataset is authoritative",
      deletion
    };
  }
  return blocked(`${deletion.stage} deletion has no readable main database; manual recovery required`);
}

/**
 * Shared verification for "this permit may still be consumed".
 *
 * The startup reconciler and the recovery CLI must agree; a permit that one
 * accepts and the other refuses is an operator trap. Returns `null` when the
 * permit is the exact unconsumed permit of this deletion, otherwise a reason.
 */
export function deletionPermitProblem(
  store: RuntimeStateStore, deletion: DatasetDeletionRecord, scope: string,
  identity: DatasetDeletionIdentity
): string | null {
  if (store.runtimeInstanceId() !== deletion.runtimeInstanceId) {
    return `runtime ledger instance ${store.runtimeInstanceId()} does not match the deletion record `
      + `${deletion.runtimeInstanceId}`;
  }
  try {
    assertDeletionPermitIdentity(deletion, identity);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const evidence = store.scopeEvidence(scope);
  if (evidence === null) return "the runtime ledger has no matching permit";
  const source = `explicit_database_delete:${deletion.deletionId}`;
  if (evidence.state !== "pristine" || evidence.permitSource !== source
      || evidence.permitRevokedAt !== null || evidence.writerEnteredAt !== null
      || evidence.datasetEstablishedAt !== null) {
    return "the next scope evidence is missing, consumed or replaced";
  }
  return null;
}

/**
 * P2-5: read-only inventory of protection snapshots kept under
 * `var/quarantine`, with the hashes an operator needs before acting.
 *
 * The listing never confirms a deletion. It only answers "which bytes are
 * here, and do they match the journal's binding?".
 */
export interface ProtectionSnapshotListing {
  name: string;
  path: string;
  files: ProtectionSnapshotFile[];
  referencedByDeletionId: string | null;
  matchesProtectionBytes: boolean | null;
  unreadable: string | null;
}

export function listProtectionSnapshots(
  runtimeRoot: string, record: DatasetDeletionRecord | null
): ProtectionSnapshotListing[] {
  const directory = resolve(runtimeRoot, "var/quarantine");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sqlite") && !name.endsWith(".manifest.json"))
    .sort()
    .map((name) => {
      const path = resolve(directory, name);
      try {
        const suffixes = SNAPSHOT_SUFFIXES.filter((suffix) => existsSync(`${path}${suffix}`));
        const files = suffixes.map((suffix) => snapshotFile(path, suffix));
        const referenced = record?.protectionKind === "quarantine" && record.protectionSnapshot === name
          ? record : null;
        const matches = referenced === null || referenced.protectionFiles === undefined
          ? null
          : files.length === referenced.protectionFiles.length
            && files.every((file, index) => file.suffix === referenced.protectionFiles?.[index]?.suffix
              && file.sizeBytes === referenced.protectionFiles[index]?.sizeBytes
              && file.sha256 === referenced.protectionFiles[index]?.sha256);
        return {
          name, path, files,
          referencedByDeletionId: referenced?.deletionId ?? null,
          matchesProtectionBytes: matches,
          unreadable: null
        };
      } catch (error) {
        return {
          name, path, files: [], referencedByDeletionId: null, matchesProtectionBytes: null,
          unreadable: error instanceof Error ? error.message : String(error)
        };
      }
    });
}

/**
 * Explicitly quarantine an unreadable main database for a recorded deletion.
 *
 * This is the only path that turns "a file exists but SQLite cannot read it"
 * into `main_removed`. It is intentionally an operator action: the bytes are
 * copied out (renamed) under `var/quarantine`, each file's size+sha256 is
 * recorded in a sidecar manifest, the moved bytes are re-verified, and the
 * recorded protection snapshot must still match its journal binding. Nothing
 * here treats mere file presence as proof of deletion.
 */
export function quarantineUnreadableMainDatabase(
  input: DatasetDeletionStartupInput, deletionId: string
): { name: string; files: ProtectionSnapshotFile[]; record: DatasetDeletionRecord } {
  const record = readDeletionOperation(input.databasePath, input.configuredEpoch, {
    strictConfigured: true, identity: identityOf(input)
  });
  if (record === null || record.deletionId !== deletionId) {
    throw new Error(`No deletion operation ${deletionId} matches the persisted journal`);
  }
  if (record.stage !== "prepared" && record.stage !== "main_removed") {
    throw new Error(`Deletion ${deletionId} is at stage ${record.stage}; quarantine is only valid before the permit`);
  }
  if (!existsSync(input.databasePath)) {
    throw new Error("The main database is absent; there is nothing to quarantine");
  }
  if (isStructurallyReadable(input.databasePath) || quickCheckDatabase(input.databasePath).ok) {
    throw new Error("The main database is readable; restore or inspect it instead of quarantining it");
  }
  const problem = protectionSnapshotProblem(input.runtimeRoot, record);
  if (problem !== null) throw new Error(problem);
  assertDeletionPermitIdentity(record, identityOf(input));
  const directory = resolve(input.runtimeRoot, "var/quarantine");
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const name = `${stamp}-unreadable-main.sqlite`;
  const target = resolve(directory, name);
  const files: ProtectionSnapshotFile[] = [];
  const before = SNAPSHOT_SUFFIXES
    .filter((suffix) => existsSync(`${input.databasePath}${suffix}`))
    .map((suffix) => snapshotFile(input.databasePath, suffix));
  for (const file of before) {
    const source = `${input.databasePath}${file.suffix}`;
    renameSync(source, `${target}${file.suffix}`);
    const moved = snapshotFile(target, file.suffix);
    if (moved.sizeBytes !== file.sizeBytes || moved.sha256 !== file.sha256) {
      throw new Error(`Quarantined bytes changed while moving ${basename(source)}; manual review required`);
    }
    files.push(moved);
  }
  writeFileSync(`${target}.manifest.json`, JSON.stringify({
    kind: "unreadable-main",
    deletionId,
    configuredEpoch: input.configuredEpoch,
    serverId: input.serverId,
    athleteId: input.athleteId,
    quarantinedAt: new Date().toISOString(),
    files
  }, null, 2));
  const advanced = record.stage === "prepared"
    ? advanceDeletionOperation(
      input.databasePath, input.configuredEpoch, deletionId, "main_removed", undefined, identityOf(input))
    : record;
  return { name, files, record: advanced };
}

/** Used by the CLI when an operator explicitly confirms a prepared deletion. */
export function confirmPreparedDeletionCompletion(
  input: DatasetDeletionStartupInput, deletionId: string
): DatasetDeletionRecord {
  const record = readDeletionOperation(input.databasePath, input.configuredEpoch, {
    strictConfigured: true, identity: identityOf(input)
  });
  if (record === null || record.deletionId !== deletionId) {
    throw new Error(`No deletion operation ${deletionId} matches the persisted journal`);
  }
  if (existsSync(input.databasePath)) {
    throw new Error("Refusing to confirm deletion completion while the main database exists");
  }
  if (record.stage !== "prepared") return record;
  if (record.runtimeInstanceId !== input.store.runtimeInstanceId()) {
    throw new Error("Runtime ledger instance does not match the deletion record");
  }
  const problem = protectionSnapshotProblem(input.runtimeRoot, record);
  if (problem !== null) throw new Error(problem);
  assertDeletionPermitIdentity(record, identityOf(input));
  return advanceDeletionOperation(
    input.databasePath, input.configuredEpoch, deletionId, "main_removed", new Date().toISOString(),
    identityOf(input));
}
