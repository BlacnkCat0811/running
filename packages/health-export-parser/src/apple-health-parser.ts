import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

import type {
  CanonicalHealthRecord,
  CanonicalRouteReference,
  CanonicalWorkout,
  CanonicalWorkoutEvent,
  CanonicalWorkoutStatistic,
  MetadataMap
} from "@rai/contracts";
import { CONTRACT_VERSION } from "@rai/contracts";
import { SaxesParser, type SaxesTagPlain } from "saxes";

import { RaiDatabase } from "./database.js";
import { evaluateRemovalGuard, ImportRemovalGuardError } from "./import-guard.js";
import { prepareNative, type NativeOptions } from "./native-worker.js";
import { NativeRecordWriter } from "./native-record-writer.js";
import {
  addMetadata,
  classifySource,
  durationToSeconds,
  lastMetadataValue,
  metadataBoolean,
  normalizeAppleDate,
  normalizeRelativePath,
  parseFiniteNumber,
  stableId
} from "./utils.js";

interface RecordDraft {
  attributes: Record<string, string>;
  metadata: MetadataMap;
}

interface RouteDraft {
  attributes: Record<string, string>;
  metadata: MetadataMap;
  relativePath: string | null;
}

interface WorkoutDraft {
  attributes: Record<string, string>;
  metadata: MetadataMap;
  statistics: CanonicalWorkoutStatistic[];
  events: CanonicalWorkoutEvent[];
  routes: RouteDraft[];
}

interface InventoryItem {
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  units: Set<string>;
  sourceCategories: Set<string>;
}

export interface AppleHealthParseResult {
  recordCount: number;
  workoutCount: number;
  activitySummaryCount: number;
  issueCount: number;
  insertedRecordCount?: number;
  insertedWorkoutCount?: number;
  removedRecordCount?: number;
  removedWorkoutCount?: number;
  /** Entities the payload carried but that stayed deleted via a tombstone. */
  tombstonedCount?: number;
  dirtyWorkoutTimes?: string[];
}

export interface ParseProgress {
  bytesRead: number;
  totalBytes: number;
  recordCount: number;
  workoutCount: number;
}

export interface AppleHealthParseOptions {
  fileSize: number;
  native?: NativeOptions;
  onProgress?: (progress: ParseProgress) => void;
  incremental?: {
    generation: string;
    batchId?: string;
    preserveAbsent?: boolean;
    /**
     * When `preserveAbsent` is false the payload is asserted to be a complete
     * snapshot. Set this to false only to bypass the removal guard that refuses
     * to delete a large share of the database on a partial payload.
     */
    guardAbsentRemoval?: boolean;
  };
  atomic?: boolean;
  /** Explicit HealthKit deletion events. Absence never implies deletion. */
  deletedWorkoutIds?: readonly string[];
}

function attributesOf(tag: SaxesTagPlain): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tag.attributes)) {
    result[key] = String(value);
  }
  return result;
}

function localName(name: string): string {
  return name.includes(":") ? (name.split(":").at(-1) ?? name) : name;
}

function updateInventory(
  inventory: Map<string, InventoryItem>,
  type: string,
  startAt: string | null,
  unit: string | null,
  sourceCategory: string
): void {
  const item = inventory.get(type) ?? {
    count: 0,
    firstAt: null,
    lastAt: null,
    units: new Set<string>(),
    sourceCategories: new Set<string>()
  };
  item.count += 1;
  if (startAt) {
    item.firstAt = item.firstAt === null || startAt < item.firstAt ? startAt : item.firstAt;
    item.lastAt = item.lastAt === null || startAt > item.lastAt ? startAt : item.lastAt;
  }
  if (unit) item.units.add(unit);
  item.sourceCategories.add(sourceCategory);
  inventory.set(type, item);
}

function buildRecord(draft: RecordDraft): CanonicalHealthRecord | null {
  const attributes = draft.attributes;
  const type = attributes.type;
  const sourceName = attributes.sourceName ?? "unknown";
  const startAt = normalizeAppleDate(attributes.startDate);
  const endAt = normalizeAppleDate(attributes.endDate);
  if (!type || !startAt || !endAt) return null;

  const numericValue = parseFiniteNumber(attributes.value);
  const syncIdentifier = lastMetadataValue(
    draft.metadata,
    "HKMetadataKeySyncIdentifier"
  );
  // Device is metadata, not identity: Apple Health can export the same sample
  // once with a device attribute and once without it.
  const id = syncIdentifier
    ? stableId("record", [type, sourceName, syncIdentifier])
    : stableId("record", [
        type,
        sourceName,
        startAt,
        endAt,
        attributes.value ?? null,
        attributes.unit ?? null
      ]);

  return {
    id,
    type,
    sourceName,
    sourceVersion: attributes.sourceVersion ?? null,
    device: attributes.device ?? null,
    unit: attributes.unit ?? null,
    numericValue,
    textValue: numericValue === null ? (attributes.value ?? null) : null,
    startAt,
    endAt,
    createdAt: normalizeAppleDate(attributes.creationDate),
    metadata: draft.metadata
  };
}

function buildWorkout(draft: WorkoutDraft): CanonicalWorkout | null {
  const attributes = draft.attributes;
  const activityType = attributes.workoutActivityType;
  const sourceName = attributes.sourceName ?? "unknown";
  const startAt = normalizeAppleDate(attributes.startDate);
  const endAt = normalizeAppleDate(attributes.endDate);
  if (!activityType || !startAt || !endAt) return null;

  const durationSeconds =
    durationToSeconds(attributes.duration, attributes.durationUnit) ??
    Math.max(0, (Date.parse(endAt) - Date.parse(startAt)) / 1000);
  const syncIdentifier = lastMetadataValue(
    draft.metadata,
    "HKMetadataKeySyncIdentifier"
  );
  // Identity fields only (PARSER_DESIGN §4.4). Statistics/events/routes and duration
  // belong in the content hash so duration corrections keep the same workout id.
  const id = syncIdentifier
    ? stableId("workout", [activityType, sourceName, syncIdentifier])
    : stableId("workout", [
        activityType,
        sourceName,
        startAt,
        endAt,
        attributes.device ?? null
      ]);

  const routes: CanonicalRouteReference[] = draft.routes.map((route) => ({
    id: stableId("route", [id, route.relativePath ?? route.attributes.startDate ?? "route"]),
    sourceName: route.attributes.sourceName ?? null,
    sourceVersion: route.attributes.sourceVersion ?? null,
    startAt: normalizeAppleDate(route.attributes.startDate),
    endAt: normalizeAppleDate(route.attributes.endDate),
    createdAt: normalizeAppleDate(route.attributes.creationDate),
    relativePath: route.relativePath,
    metadata: route.metadata
  }));

  return {
    id,
    activityType,
    sourceName,
    sourceVersion: attributes.sourceVersion ?? null,
    device: attributes.device ?? null,
    startAt,
    endAt,
    createdAt: normalizeAppleDate(attributes.creationDate),
    durationSeconds,
    indoor: metadataBoolean(draft.metadata, "HKIndoorWorkout"),
    metadata: draft.metadata,
    statistics: draft.statistics,
    events: draft.events,
    routes
  };
}

export async function parseAppleHealthXml(
  xmlPath: string,
  store: RaiDatabase,
  options: AppleHealthParseOptions
): Promise<AppleHealthParseResult> {
  // The native worker writes only a disposable spool before the import transaction starts.
  const native = await prepareNative("health", xmlPath, options.native ?? {});
  let nativeRecords: NativeRecordWriter | undefined;
  try {
  const atomic = options.atomic !== false;
  if (atomic) store.beginAtomicImport();
  const entityGeneration = options.incremental?.generation ?? "full-import";
  if (native && options.atomic === false && options.native?.stagingDatabase) {
    nativeRecords = new NativeRecordWriter(native.directory, entityGeneration, options.incremental?.batchId, Boolean(options.incremental));
  }
  if (options.incremental) {
    store.seedImportGenerations(
      options.incremental.generation,
      options.incremental.preserveAbsent ? { preserveAbsent: true } : undefined
    );
  }
  let currentRecord: RecordDraft | null = null;
  let currentWorkout: WorkoutDraft | null = null;
  let currentWorkoutEvent: CanonicalWorkoutEvent | null = null;
  let currentRoute: RouteDraft | null = null;
  let recordCount = 0;
  let workoutCount = 0;
  let activitySummaryCount = 0;
  let issueCount = 0;
  let insertedRecordCount = 0;
  let insertedWorkoutCount = 0;
  // Entities the payload still carries but that a tombstone keeps deleted.
  let tombstonedCount = 0;
  const insertedWorkoutTimes: string[] = [];
  let bytesRead = 0;
  let lastProgressAt = 0;
  const recordInventory = new Map<string, InventoryItem>();
  const workoutInventory = new Map<string, InventoryItem>();
  const sourceHash = createHash("sha256");

  const parser = new SaxesParser({ xmlns: false });

  const openTag = (tag: { name: string; attributes: Record<string, string> }) => {
    const name = localName(tag.name);
    const attributes = tag.attributes;

    switch (name) {
      case "Me":
        if (options.incremental?.preserveAbsent) {
          store.setProfile(attributes, { merge: true });
        } else {
          store.setProfile(attributes);
        }
        break;
      case "ExportDate":
        if (attributes.value) store.setManifest("health_export_date", attributes.value);
        break;
      case "Record":
        currentRecord = { attributes, metadata: {} };
        break;
      case "Workout":
        currentWorkout = {
          attributes,
          metadata: {},
          statistics: [],
          events: [],
          routes: []
        };
        break;
      case "WorkoutStatistics":
        if (currentWorkout) {
          currentWorkout.statistics.push({
            type: attributes.type ?? "unknown",
            startAt: normalizeAppleDate(attributes.startDate),
            endAt: normalizeAppleDate(attributes.endDate),
            unit: attributes.unit ?? null,
            sum: parseFiniteNumber(attributes.sum),
            average: parseFiniteNumber(attributes.average),
            minimum: parseFiniteNumber(attributes.minimum),
            maximum: parseFiniteNumber(attributes.maximum)
          });
        }
        break;
      case "WorkoutEvent":
        if (currentWorkout) {
          currentWorkoutEvent = {
            type: attributes.type ?? "unknown",
            date: normalizeAppleDate(attributes.date),
            durationSeconds: durationToSeconds(
              attributes.duration,
              attributes.durationUnit
            ),
            metadata: {}
          };
          currentWorkout.events.push(currentWorkoutEvent);
        }
        break;
      case "WorkoutRoute":
        if (currentWorkout) {
          currentRoute = { attributes, metadata: {}, relativePath: null };
        }
        break;
      case "FileReference":
        if (currentRoute && attributes.path) {
          currentRoute.relativePath = normalizeRelativePath(attributes.path);
        }
        break;
      case "MetadataEntry":
        if (currentRoute) {
          addMetadata(currentRoute.metadata, attributes.key, attributes.value);
        } else if (currentWorkoutEvent) {
          addMetadata(currentWorkoutEvent.metadata, attributes.key, attributes.value);
        } else if (currentRecord) {
          addMetadata(currentRecord.metadata, attributes.key, attributes.value);
        } else if (currentWorkout) {
          addMetadata(currentWorkout.metadata, attributes.key, attributes.value);
        }
        break;
      case "ActivitySummary":
        if (!options.incremental) {
          store.insertActivitySummary(attributes);
        } else {
          const normalized = Object.fromEntries(
            Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))
          );
          const contentHash = createHash("sha256")
            .update(JSON.stringify(normalized))
            .digest("hex");
          const observation = store.observeImportEntity(
            "activity_summary",
            attributes.dateComponents ?? stableId("activity_summary", [attributes]),
            options.incremental.generation,
            normalizeAppleDate(attributes.dateComponents),
            options.incremental.batchId,
            contentHash
          );
          if (observation.tombstoned) tombstonedCount += 1;
          else if (observation.inserted || observation.updated) store.insertActivitySummary(attributes);
        }
        activitySummaryCount += 1;
        break;
    }
  };

  const closeTag = (tag: { name: string }) => {
    const name = localName(tag.name);

    if (name === "WorkoutEvent") {
      currentWorkoutEvent = null;
    } else if (name === "Record" && currentRecord) {
      const record = buildRecord(currentRecord);
      if (record) {
        const category = classifySource(record.sourceName, record.device, record.metadata);
        const contentHash = stableId("record_content", [currentRecord.attributes, currentRecord.metadata]);
        if (nativeRecords) {
          nativeRecords.capture(record, category, currentRecord.attributes, contentHash);
        } else {
        const observation = store.observeImportEntity(
          "record", record.id, entityGeneration, record.startAt,
          options.incremental?.batchId, contentHash
        );
        const shouldWrite = !observation.tombstoned
          && (!options.incremental || observation.inserted || observation.updated);
        if (shouldWrite) {
          store.insertRecord(record, category, currentRecord.attributes);
          if (!options.incremental || observation.inserted) insertedRecordCount += 1;
        }
        if (observation.tombstoned) tombstonedCount += 1;
        }
        updateInventory(
          recordInventory,
          record.type,
          record.startAt,
          record.unit,
          category
        );
        recordCount += 1;
      } else {
        store.insertIssue({
          severity: "warning",
          code: "INVALID_RECORD",
          objectId: null,
          message: "A Health record was skipped because required type or date fields were invalid."
        });
        issueCount += 1;
      }
      currentRecord = null;
    } else if (name === "WorkoutRoute" && currentRoute && currentWorkout) {
      currentWorkout.routes.push(currentRoute);
      currentRoute = null;
    } else if (name === "Workout" && currentWorkout) {
      const workout = buildWorkout(currentWorkout);
      if (workout) {
        const category = classifySource(workout.sourceName, workout.device, workout.metadata);
        const contentHash = stableId("workout_content", [
          currentWorkout.attributes, currentWorkout.metadata, currentWorkout.statistics,
          currentWorkout.events, currentWorkout.routes
        ]);
        const observation = store.observeImportEntity(
          "workout", workout.id, entityGeneration, workout.startAt,
          options.incremental?.batchId, contentHash,
          ["HKMetadataKeySyncIdentifier", "RAIHealthKitWorkoutUUID"]
            .map((key) => lastMetadataValue(workout.metadata, key))
            .filter((value): value is string => Boolean(value))
        );
        const shouldWrite = !observation.tombstoned
          && (!options.incremental || observation.inserted || observation.updated);
        if (shouldWrite) {
          store.insertWorkout(
            workout,
            category,
            currentWorkout.attributes,
            options.incremental?.preserveAbsent ? { preserveAbsent: true } : undefined
          );
          if (!options.incremental || observation.inserted) insertedWorkoutCount += 1;
          insertedWorkoutTimes.push(workout.startAt);
        }
        if (observation.tombstoned) tombstonedCount += 1;
        updateInventory(
          workoutInventory,
          workout.activityType,
          workout.startAt,
          null,
          category
        );
        workoutCount += 1;
      } else {
        store.insertIssue({
          severity: "warning",
          code: "INVALID_WORKOUT",
          objectId: null,
          message: "A workout was skipped because required activity or date fields were invalid."
        });
        issueCount += 1;
      }
      currentWorkout = null;
      currentWorkoutEvent = null;
      currentRoute = null;
    }
  };

  parser.on("opentag", (tag) => openTag({ name: tag.name, attributes: attributesOf(tag) }));
  parser.on("closetag", closeTag);
  parser.on("error", (error) => {
    throw error;
  });

  try {
    if (native) {
        for (const row of native.database.prepare("SELECT kind, payload FROM xml_units ORDER BY sequence").iterate() as Iterable<{ kind: string; payload: string }>) {
          const value = JSON.parse(row.payload);
          if (row.kind === "record") {
            // Keep JavaScript normalization/JSON.stringify as the single identity
            // contract. Native parsing never guesses equivalent cross-language IDs.
            currentRecord = { attributes: attributesOf({ attributes: value.attributes } as SaxesTagPlain), metadata: {} };
            for (const entry of value.metadata as Array<{ key?: string; value?: string }>) {
              addMetadata(currentRecord.metadata, entry.key, entry.value);
            }
            closeTag({ name: "Record" });
          } else {
            for (const [kind, name, attributes] of value as Array<[string, string, Record<string, string>]>) {
              if (kind === "open") openTag({ name, attributes: attributesOf({ attributes } as SaxesTagPlain) });
              else closeTag({ name });
            }
          }
        }
        options.onProgress?.({ bytesRead: native.result.inputBytes!, totalBytes: options.fileSize, recordCount, workoutCount });
    } else {
      const stream = createReadStream(xmlPath, { encoding: "utf8" });
      for await (const chunk of stream) {
        const text = String(chunk);
        sourceHash.update(text, "utf8");
        bytesRead += Buffer.byteLength(text, "utf8");
        parser.write(text);
        if (options.onProgress && bytesRead - lastProgressAt >= 16 * 1024 * 1024) {
          lastProgressAt = bytesRead;
          options.onProgress({
            bytesRead,
            totalBytes: options.fileSize,
            recordCount,
            workoutCount
          });
        }
      }
      parser.close();
    }

    let explicitDeletionTimes: string[] = [];

    if (nativeRecords) {
      const written = await nativeRecords.apply(store, options.native!);
      insertedRecordCount += written.inserted;
      tombstonedCount += written.tombstoned;
    }

    if (!options.incremental?.preserveAbsent) {
      for (const [type, item] of recordInventory) {
        store.upsertInventory("record", type, item.count, item.firstAt, item.lastAt, {
          units: [...item.units].sort(),
          sourceCategories: [...item.sourceCategories].sort()
        });
      }
      for (const [type, item] of workoutInventory) {
        store.upsertInventory("workout", type, item.count, item.firstAt, item.lastAt, {
          sourceCategories: [...item.sourceCategories].sort()
        });
      }
      store.setManifest("record_count", String(recordCount));
      store.setManifest("workout_count", String(workoutCount));
      store.setManifest("activity_summary_count", String(activitySummaryCount));
    }
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("source_xml_sha256", native?.result.sha256 ?? sourceHash.digest("hex"));
    if (
      options.incremental
      && !options.incremental.preserveAbsent
      && options.incremental.guardAbsentRemoval !== false
    ) {
      const preview = store.previewGenerationRemoval(options.incremental.generation);
      const existingEntities = store.countImportableEntities();
      const evaluation = evaluateRemovalGuard(preview, existingEntities);
      if (evaluation.exceeded) {
        throw new ImportRemovalGuardError(
          preview,
          existingEntities,
          evaluation.allowedRemovals
        );
      }
    }
    const finalized = options.incremental
      ? store.finalizeImportGeneration(
        options.incremental.generation,
        options.incremental.batchId,
        options.incremental.preserveAbsent ? { preserveAbsent: true } : undefined
      )
      : { removedRecords: 0, removedWorkouts: 0, dirtyWorkoutTimes: [] as string[] };
    if (atomic) store.commitAtomicImport();
    else store.flush();
    if (options.deletedWorkoutIds?.length) {
      explicitDeletionTimes = store.removeWorkoutsBySyncIdentifiers(options.deletedWorkoutIds, options.incremental?.batchId);
    }
    return {
      recordCount, workoutCount, activitySummaryCount, issueCount,
      insertedRecordCount, insertedWorkoutCount,
      removedRecordCount: finalized.removedRecords,
      removedWorkoutCount: finalized.removedWorkouts,
      tombstonedCount,
      dirtyWorkoutTimes: [...insertedWorkoutTimes, ...explicitDeletionTimes, ...finalized.dirtyWorkoutTimes]
    };
  } catch (error) {
    if (atomic) store.rollbackAtomicImport();
    else store.rollback();
    throw error;
  }

  return { recordCount, workoutCount, activitySummaryCount, issueCount };
  } finally { nativeRecords?.close(); await native?.dispose(); }
}
