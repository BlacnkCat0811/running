import { createHash, randomUUID, type Hash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { createReadStream, createWriteStream, existsSync, readFileSync, type Dirent } from "node:fs";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import yauzl, { type Entry, type ZipFile } from "yauzl";
import { RuntimeStateStore } from "./runtime-state.js";

export type ImportSourceKind = "upload" | "directory" | "discovered";

export interface ImportSource {
  id: string;
  kind: ImportSourceKind;
  displayName: string;
  inputPath: string;
  originalPath: string;
  sourceSha256: string | null;
  idempotencyKey: string | null;
  exportFileName: string;
  exportBytes: number;
  routeFileCount: number;
  modifiedAt: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ImportInspection {
  sourceId: string;
  status: "ready" | "unchanged";
  exportFileName: string;
  exportBytes: number;
  exportCreatedAt: string | null;
  sourceSha256: string | null;
  routeFileCount: number;
  previousImportAt: string | null;
  warnings: Array<{ code: string; message: string }>;
}

export interface ZipLimits {
  maxArchiveBytes: number;
  maxExtractedBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
  maxCompressionRatio: number;
  maxStoredUploadBytes: number;
  minimumFreeBytes: number;
}

export class ImportSourceNotFoundError extends Error {
  readonly statusCode = 404;
  // 没有 code 时 apiErrorPayload 会退化成通用 "request_error"，客户端无法区分 404 语义。
  readonly code = "import_source_not_found";

  constructor() {
    super("未找到导入来源");
  }
}

export class ImportArchiveValidationError extends Error {
  readonly statusCode = 400;
  readonly code = "invalid_import_archive";
}

export class ImportArchiveTooLargeError extends Error {
  readonly statusCode = 413;
  readonly code = "import_archive_too_large";
}

export class ImportUploadBusyError extends Error {
  readonly statusCode = 429;
  readonly code = "import_upload_busy";
}

export class ImportUploadCapacityError extends Error {
  readonly statusCode = 507;
  readonly code = "import_upload_capacity_exceeded";
}

function archiveValidationError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof ImportArchiveValidationError || error instanceof ImportUploadCapacityError) return error;
  const systemError = error as { syscall?: unknown } | null;
  if (typeof systemError?.syscall === "string") return error as Error;
  return new ImportArchiveValidationError(error instanceof Error ? error.message : fallbackMessage);
}

const DEFAULT_LIMITS: ZipLimits = {
  maxArchiveBytes: 4 * 1024 ** 3,
  maxExtractedBytes: 12 * 1024 ** 3,
  maxEntryBytes: 8 * 1024 ** 3,
  maxEntries: 100_000,
  maxCompressionRatio: 1_000,
  maxStoredUploadBytes: 16 * 1024 ** 3,
  minimumFreeBytes: 512 * 1024 ** 2
};

export const ABANDONED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
export const HEALTHKIT_UPLOAD_FILENAME_TOKEN = "apple-health-healthkit";
const EXPORT_DATE_TAG = /<ExportDate\b[^>]*\/>|<ExportDate\b[^>]*>\s*<\/ExportDate>/gi;
const EXPORT_DATE_HASH_TAIL = 1024;

export function isHealthKitUploadFilename(name: string | null | undefined): boolean {
  return (name ?? "").toLowerCase().includes(HEALTHKIT_UPLOAD_FILENAME_TOKEN);
}

/** `sourceScope` value a client writes when it uploads a complete snapshot. */
export const FULL_SNAPSHOT_SOURCE_SCOPE = "apple-health-full-snapshot";

export type SnapshotModeReason =
  | "manifest-healthkit"
  | "manifest-full-snapshot"
  | "manifest-declared-other"
  | "manifest-unreadable"
  | "filename-token"
  | "untrusted-default";

export interface SyncManifestScope {
  /** Whether a readable sync-manifest.json was found next to export.xml. */
  declared: boolean;
  sourceScope: string | null;
}

function findSyncManifestPath(inputPath: string): string | null {
  let current = resolve(inputPath);
  for (let depth = 0; depth <= 3; depth += 1) {
    const candidate = resolve(current, "sync-manifest.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Reads the client-declared `sourceScope` from sync-manifest.json.
 *
 * The manifest travels inside the archive next to export.xml, so it is
 * available on the extracted directory. A manifest that exists but cannot be
 * parsed is reported as undeclared-and-unreadable, which resolves to the
 * conservative (non-deleting) branch.
 *
 * Explicit deletion events (`deletedSourceIds`) are read separately, inside the
 * parser package, by the CLI that carries out the import.
 */
export function readSyncManifestScope(inputPath: string): SyncManifestScope {
  const manifestPath = findSyncManifestPath(inputPath);
  if (!manifestPath) return { declared: false, sourceScope: null };
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version?: unknown;
      sourceScope?: unknown;
    };
    // Only the versioned manifest contract may opt into destructive semantics.
    // A hand-written or legacy manifest remains conservative.
    if (parsed.version !== 1) return { declared: true, sourceScope: null };
    const scope = parsed.sourceScope;
    return {
      declared: true,
      sourceScope: typeof scope === "string" && scope.trim().length > 0 ? scope.trim() : null
    };
  } catch {
    return { declared: true, sourceScope: null };
  }
}

/**
 * Decides whether an import may treat absence as deletion.
 *
 * `preserveAbsent: true` means "this payload is partial; a missing entity is
 * not a deleted entity". That is the safe default and the only correct reading
 * of a client sync package, which only carries the window since the last
 * anchor. Deletion is permitted only when the payload *declares itself* a
 * complete snapshot, and even then a removal guard inspects the projection.
 *
 * Everything else — including a recognisable archive name — resolves to the
 * non-deleting branch. The archive filename is caller-supplied and trivially
 * renameable; an unrecognised archive is simply unknown, and an unknown
 * payload must never be the switch for a destructive operation.
 */
export function resolvePreserveAbsent(
  inputPath: string,
  source: ImportWorkerSourceLike
): { preserveAbsent: boolean; reason: SnapshotModeReason } {
  const scope = readSyncManifestScope(inputPath);
  if (scope.declared) {
    const declared = scope.sourceScope;
    if (declared === null) return { preserveAbsent: true, reason: "manifest-unreadable" };
    if (declared === FULL_SNAPSHOT_SOURCE_SCOPE) {
      return { preserveAbsent: false, reason: "manifest-full-snapshot" };
    }
    if (declared === "healthkit") return { preserveAbsent: true, reason: "manifest-healthkit" };
    return { preserveAbsent: true, reason: "manifest-declared-other" };
  }
  if (isHealthKitUploadSource(source)) {
    return { preserveAbsent: true, reason: "filename-token" };
  }
  return { preserveAbsent: true, reason: "untrusted-default" };
}

export interface ImportWorkerSourceLike {
  kind?: string | null;
  displayName?: string | null;
  originalPath?: string | null;
}

export function isHealthKitUploadSource(
  source: ImportWorkerSourceLike,
  inputPath?: string
): boolean {
  if (source.kind != null && source.kind !== "upload") return false;
  if (inputPath) {
    const scope = readSyncManifestScope(inputPath);
    if (scope.declared && (scope.sourceScope === "healthkit" || scope.sourceScope === FULL_SNAPSHOT_SOURCE_SCOPE)) return true;
  }
  return isHealthKitUploadFilename(source.displayName)
    || isHealthKitUploadFilename(source.originalPath ? basename(source.originalPath) : "");
}

function stripExportDate(text: string): string {
  EXPORT_DATE_TAG.lastIndex = 0;
  return text.replace(EXPORT_DATE_TAG, "");
}

async function hashXmlWithoutExportDate(path: string, hash: Hash): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  let leftover = "";
  for await (const chunk of stream) {
    leftover = stripExportDate(leftover + chunk);
    if (leftover.length > EXPORT_DATE_HASH_TAIL) {
      hash.update(leftover.slice(0, leftover.length - EXPORT_DATE_HASH_TAIL));
      leftover = leftover.slice(-EXPORT_DATE_HASH_TAIL);
    }
  }
  hash.update(stripExportDate(leftover));
}

async function hashRouteFile(path: string, hash: Hash): Promise<void> {
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
}

export async function digestHealthKitExportContent(exportRoot: string): Promise<string> {
  const xmlPath = existsSync(resolve(exportRoot, "export.xml"))
    ? resolve(exportRoot, "export.xml")
    : resolve(exportRoot, "导出.xml");
  const hash = createHash("sha256");
  await hashXmlWithoutExportDate(xmlPath, hash);
  // Deletion-only syncs can carry exactly the same XML and routes. Include
  // manifest semantics so upload deduplication cannot discard those events.
  const manifestPath = findSyncManifestPath(exportRoot);
  if (manifestPath) {
    const raw = readFileSync(manifestPath, "utf8");
    let content = raw;
    try {
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      content = JSON.stringify({
        version: manifest.version,
        sourceScope: manifest.sourceScope,
        deletedSourceIds: Array.isArray(manifest.deletedSourceIds)
          ? [...new Set(manifest.deletedSourceIds.filter((id): id is string => typeof id === "string"))].sort()
          : []
      });
    } catch { /* An invalid manifest must remain distinct and fail during import. */ }
    hash.update(`\0sync-manifest\0${content}\0`);
  }
  const routeRoot = resolve(exportRoot, "workout-routes");
  if (existsSync(routeRoot)) {
    const names = (await readdir(routeRoot, { recursive: true }))
      .map((name) => String(name).replaceAll("\\", "/"))
      .filter((name) => extname(name).toLowerCase() === ".gpx")
      .sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const info = await stat(resolve(routeRoot, name));
      hash.update(`\0${name}\0${info.size}\0`);
      await hashRouteFile(resolve(routeRoot, name), hash);
    }
  }
  return hash.digest("hex");
}

export class ImportSourceManager {
  private readonly root: string;
  private readonly metadataPath: string;
  private readonly state: RuntimeStateStore;
  private readonly limits: ZipLimits;
  private uploadInProgress = false;

  constructor(
    private readonly runtimeRoot: string,
    private readonly projectRoot: string,
    limits: Partial<ZipLimits> = {}
  ) {
    this.root = resolve(runtimeRoot, "var/imports");
    this.metadataPath = resolve(this.root, "sources.json");
    this.state = new RuntimeStateStore(runtimeRoot);
    this.state.migrateLegacySources(this.metadataPath);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async saveUpload(
    stream: NodeJS.ReadableStream,
    filename: string,
    idempotencyKey: string | null = null
  ): Promise<ImportInspection> {
    if (this.uploadInProgress) {
      throw new ImportUploadBusyError("另一项 ZIP 上传正在处理，请稍后重试");
    }
    const normalizedIdempotencyKey = idempotencyKey?.trim() || null;
    this.uploadInProgress = true;
    try {
      if (normalizedIdempotencyKey) {
        const existing = (await this.readSources()).find(
          (source) => source.idempotencyKey === normalizedIdempotencyKey
        );
        if (existing) {
          await drainStream(stream);
          return await this.inspection(existing);
        }
      }
    const id = `upload_${randomUUID()}`;
    const directory = resolve(this.root, id);
    const archivePath = resolve(directory, "source.zip");
    try {
      await mkdir(this.root, { recursive: true });
      const storedBytes = await this.directoryBytes(this.root);
      const initialAvailable = await this.availableBytes(this.root);
      const archiveBudget = Math.min(
        this.limits.maxArchiveBytes,
        this.limits.maxStoredUploadBytes - storedBytes,
        initialAvailable - this.limits.minimumFreeBytes
      );
      if (archiveBudget <= 0) {
        throw new ImportUploadCapacityError("上传空间不足，请清理旧上传或释放磁盘空间");
      }
      await mkdir(directory, { recursive: true });
      const healthKitUpload = isHealthKitUploadFilename(filename);
      const hash = healthKitUpload ? null : createHash("sha256");
      let bytes = 0;
      stream.once("limit", () => {
        (stream as NodeJS.ReadableStream & { destroy(error: Error): void })
          .destroy(new ImportArchiveTooLargeError("ZIP 文件超过大小限制"));
      });
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.limits.maxArchiveBytes) {
          (stream as NodeJS.ReadableStream & { destroy(error: Error): void })
            .destroy(new ImportArchiveTooLargeError("ZIP 文件超过大小限制"));
        } else if (bytes > archiveBudget) {
          (stream as NodeJS.ReadableStream & { destroy(error: Error): void })
            .destroy(new ImportUploadCapacityError("上传空间不足，请清理旧上传或释放磁盘空间"));
        }
        hash?.update(chunk);
      });
      await pipeline(stream, createWriteStream(archivePath, { flags: "wx" }));
      await this.assertZipMagic(archivePath);
      const extracted = resolve(directory, "extracted");
      const extractionBudget = Math.min(
        this.limits.maxExtractedBytes,
        this.limits.maxStoredUploadBytes - storedBytes - bytes,
        await this.availableBytes(this.root) - this.limits.minimumFreeBytes
      );
      if (extractionBudget < 0) {
        throw new ImportUploadCapacityError("解压空间不足，请清理旧上传或释放磁盘空间");
      }
      await this.extractZip(archivePath, extracted, extractionBudget);
      const source = await this.buildSource(
        id,
        "upload",
        filename,
        extracted,
        archivePath,
        hash ? hash.digest("hex") : null,
        normalizedIdempotencyKey
      );
      await this.upsert(source);
      return await this.inspection(source);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    } finally {
      this.uploadInProgress = false;
    }
  }

  async registerDirectory(pathValue: string, kind: ImportSourceKind = "directory"): Promise<ImportInspection> {
    const path = resolve(pathValue);
    const id = `local_${createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 20)}`;
    const source = await this.buildSource(id, kind, basename(path), path, path, null);
    await this.upsert(source);
    return await this.inspection(source);
  }

  async inspect(id: string): Promise<ImportInspection> {
    const source = await this.get(id);
    if (!source) throw new ImportSourceNotFoundError();
    return await this.inspection(source);
  }

  async get(id: string): Promise<ImportSource | null> {
    return (await this.readSources()).find((source) => source.id === id) ?? null;
  }

  async recent(): Promise<ImportSource[]> {
    return (await this.readSources())
      .filter((source) => source.lastUsedAt !== null && existsSync(source.inputPath))
      .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
      .slice(0, 10);
  }

  async markUsed(id: string): Promise<void> {
    const sources = await this.readSources();
    const source = sources.find((item) => item.id === id);
    if (!source) return;
    source.lastUsedAt = new Date().toISOString();
    await this.writeSources(sources);
  }

  async retainImportedUpload(id: string): Promise<void> {
    const source = await this.get(id);
    if (!source || source.kind !== "upload") return;
    await this.markUsed(id);
    await rm(resolve(this.root, id), { recursive: true, force: true });
  }

  async discover(): Promise<ImportSource[]> {
    const previous = await this.readSources();
    const locations = new Set<string>([
      resolve(this.projectRoot, "apple_health_export"),
      resolve(homedir(), "Downloads"),
      ...previous.filter((item) => item.kind !== "upload").map((item) => item.originalPath)
    ]);
    const candidates: string[] = [];
    for (const location of locations) {
      if (!existsSync(location)) continue;
      const info = await stat(location);
      if (info.isDirectory() && await this.hasExportXml(location)) candidates.push(location);
      if (info.isDirectory()) {
        for (const item of await readdir(location, { withFileTypes: true })) {
          const child = resolve(location, item.name);
          if (item.isDirectory() && await this.hasExportXml(child)) candidates.push(child);
        }
      }
    }
    for (const candidate of candidates) await this.registerDirectory(candidate, "discovered");
    const ids = new Set(candidates.map((path) => `local_${createHash("sha256").update(resolve(path).toLowerCase()).digest("hex").slice(0, 20)}`));
    return (await this.readSources())
      .filter((source) => ids.has(source.id))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async cleanupUpload(id: string, activeInputPaths: readonly string[] = []): Promise<boolean> {
    const source = await this.get(id);
    if (!source || source.kind !== "upload") return false;
    const directory = resolve(this.root, id);
    const active = activeInputPaths.map((path) => resolve(path)).some(
      (input) => input === directory || input.startsWith(directory + sep)
    );
    if (active) throw new ImportUploadBusyError("Upload source is in use by an active import job");
    await rm(directory, { recursive: true, force: true });
    this.state.deleteSource(id);
    return true;
  }

  async cleanupAbandonedUploads(
    now = Date.now(),
    ttlMs = ABANDONED_UPLOAD_TTL_MS,
    additionalActiveInputPaths: readonly string[] = []
  ): Promise<number> {
    await mkdir(this.root, { recursive: true });
    const activeInputs = new Set(
      [...this.state.jobs(20)
        .filter((job) => ["queued", "running"].includes(job.status))
        .map((job) => resolve(job.inputPath)), ...additionalActiveInputPaths.map((path) => resolve(path))]
    );
    const sources = await this.readSources();
    const abandoned = sources.filter(
      (source) => source.kind === "upload" && source.lastUsedAt === null &&
        !activeInputs.has(resolve(source.inputPath)) &&
        now - Date.parse(source.createdAt) >= ttlMs
    );
    for (const source of abandoned) {
      await rm(resolve(this.root, source.id), { recursive: true, force: true });
      this.state.deleteSource(source.id);
    }
    let removed = abandoned.length;
    const knownIds = new Set(sources.map((source) => source.id));
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("upload_") || knownIds.has(entry.name)) continue;
      const directory = resolve(this.root, entry.name);
      const isActive = [...activeInputs].some(
        (input) => input === directory || input.startsWith(directory + sep)
      );
      if (isActive || now - (await stat(directory)).mtimeMs < ttlMs) continue;
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  private async buildSource(
    id: string,
    kind: ImportSourceKind,
    displayName: string,
    searchRoot: string,
    originalPath: string,
    sha: string | null,
    idempotencyKey: string | null = null
  ): Promise<ImportSource> {
    const inputPath = await this.findExportRoot(searchRoot, kind === "upload");
    const exportPath = existsSync(resolve(inputPath, "export.xml")) ? resolve(inputPath, "export.xml") : resolve(inputPath, "导出.xml");
    const exportInfo = await stat(exportPath);
    const routeRoot = resolve(inputPath, "workout-routes");
    let routeFileCount = 0;
    if (existsSync(routeRoot)) routeFileCount = (await readdir(routeRoot, { recursive: true })).filter((name) => extname(String(name)).toLowerCase() === ".gpx").length;
    const old = await this.get(id);
    // Content-hash the export for any HealthKit sync payload so that re-exports
    // of unchanged data are recognised regardless of the archive filename.
    const sourceSha256 = kind === "upload"
      && isHealthKitUploadSource({ kind, displayName, originalPath }, inputPath)
      ? await digestHealthKitExportContent(inputPath)
      : sha;
    return {
      id, kind, displayName, inputPath, originalPath, sourceSha256, idempotencyKey,
      exportFileName: basename(exportPath), exportBytes: exportInfo.size, routeFileCount,
      modifiedAt: exportInfo.mtime.toISOString(), createdAt: old?.createdAt ?? new Date().toISOString(),
      lastUsedAt: old?.lastUsedAt ?? null
    };
  }

  private async findExportRoot(root: string, archiveInput = false): Promise<string> {
    const invalidInput = (message: string): Error => archiveInput
      ? new ImportArchiveValidationError(message)
      : new Error(message);
    if (!existsSync(root) || !(await stat(root)).isDirectory()) throw invalidInput("Apple Health 导出目录不存在");
    if (await this.hasExportXml(root)) return root;
    const matches: string[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 3) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = resolve(directory, entry.name);
        if (await this.hasExportXml(child)) matches.push(child);
        else await walk(child, depth + 1);
      }
    };
    await walk(root, 0);
    if (matches.length === 0) throw invalidInput("未找到 export.xml 或导出.xml");
    if (matches.length > 1) throw invalidInput("ZIP 中包含多个 Apple Health 导出目录");
    return matches[0]!;
  }

  private async hasExportXml(path: string): Promise<boolean> {
    return existsSync(resolve(path, "export.xml")) || existsSync(resolve(path, "导出.xml"));
  }

  private async inspection(source: ImportSource): Promise<ImportInspection> {
    const previous = source.sourceSha256
      ? (await this.readSources()).filter((item) => item.id !== source.id && item.sourceSha256 === source.sourceSha256 && item.lastUsedAt).sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))[0]
      : undefined;
    return {
      sourceId: source.id, status: source.lastUsedAt || previous ? "unchanged" : "ready", exportFileName: source.exportFileName,
      exportBytes: source.exportBytes, exportCreatedAt: source.modifiedAt,
      sourceSha256: source.sourceSha256, routeFileCount: source.routeFileCount,
      previousImportAt: source.lastUsedAt ?? previous?.lastUsedAt ?? null, warnings: []
    };
  }

  private async assertZipMagic(path: string): Promise<void> {
    const handle = await import("node:fs/promises").then(({ open }) => open(path, "r"));
    try {
      const buffer = Buffer.alloc(4);
      await handle.read(buffer, 0, 4, 0);
      if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(buffer[2]!)) {
        throw new ImportArchiveValidationError("上传文件不是有效 ZIP");
      }
    } finally { await handle.close(); }
  }

  private async extractZip(archive: string, destination: string, extractionBudget = this.limits.maxExtractedBytes): Promise<void> {
    await mkdir(destination, { recursive: true });
    const zip = await new Promise<ZipFile>((ok, fail) => yauzl.open(archive, { lazyEntries: true, decodeStrings: false }, (error, file) => {
      if (error || !file) fail(archiveValidationError(error, "无法打开 ZIP"));
      else ok(file);
    }));
    let entries = 0;
    let extractedBytes = 0;
    const extractionLimitError = (): Error => extractionBudget < this.limits.maxExtractedBytes
      ? new ImportUploadCapacityError("解压空间不足，请清理旧上传或释放磁盘空间")
      : new ImportArchiveValidationError("ZIP 解压后大小超过限制");
    const extractedTargets = new Set<string>();
    type ArchivePathNode = {
      kind: "file" | "directory" | null;
      children: Map<string, ArchivePathNode>;
    };
    const archiveRoot: ArchivePathNode = { kind: null, children: new Map() };
    const recordArchiveEntry = (path: string, kind: "file" | "directory"): void => {
      const parts = path.split("/").filter(Boolean);
      let node = archiveRoot;
      for (const part of parts) {
        if (node.kind === "file") throw new ImportArchiveValidationError("ZIP 包含文件与目录冲突");
        let child = node.children.get(part);
        if (!child) {
          child = { kind: null, children: new Map() };
          node.children.set(part, child);
        }
        node = child;
      }
      if (node.kind !== null || (kind === "file" && node.children.size > 0)) {
        throw new ImportArchiveValidationError("ZIP 包含文件与目录冲突");
      }
      node.kind = kind;
    };
    await new Promise<void>((ok, fail) => {
      const abort = (error: unknown) => { zip.close(); fail(error); };
      zip.on("error", (error) => abort(archiveValidationError(error, "ZIP 读取失败")));
      zip.on("end", ok);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          entries += 1;
          if (entries > this.limits.maxEntries) throw new ImportArchiveValidationError("ZIP 文件数量超过限制");
          if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw new ImportArchiveValidationError("ZIP 不允许包含符号链接");
          const rawName = entry.fileName as unknown;
          const nameBuffer = Buffer.isBuffer(rawName) ? rawName : Buffer.from(String(rawName), "binary");
          const name = (isUtf8(nameBuffer) ? nameBuffer.toString("utf8") : nameBuffer.toString("latin1"))
            .replaceAll("\\", "/");
          if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..") || name.includes("\0")) throw new ImportArchiveValidationError("ZIP 包含不安全路径");
          if (process.platform === "win32") {
            const invalidWindowsSegment = name.split("/").filter(Boolean).some((segment) =>
              /[. ]$/.test(segment) || /[<>:"|?*]/.test(segment) ||
              /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
            );
            if (invalidWindowsSegment) throw new ImportArchiveValidationError("ZIP 包含 Windows 非法或别名路径");
          }
          const declared = entry.uncompressedSize;
          if (declared > this.limits.maxEntryBytes) throw new ImportArchiveValidationError("ZIP 中单个文件超过限制");
          if (entry.compressedSize > 0 && declared > 0 && declared / entry.compressedSize > this.limits.maxCompressionRatio) {
            throw new ImportArchiveValidationError("ZIP 压缩比异常");
          }
          const remainingBudget = extractionBudget - extractedBytes;
          if (declared > remainingBudget) throw extractionLimitError();
          const target = resolve(destination, name);
          if (target !== destination && !target.startsWith(destination + sep)) throw new ImportArchiveValidationError("ZIP 包含越界路径");
          const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
          if (extractedTargets.has(targetKey)) throw new ImportArchiveValidationError("ZIP 包含重复路径");
          const entryKey = (process.platform === "win32" ? name.toLowerCase() : name).replace(/\/+$/, "");
          const entryKind = name.endsWith("/") ? "directory" : "file";
          recordArchiveEntry(entryKey, entryKind);
          extractedTargets.add(targetKey);
          if (name.endsWith("/")) await mkdir(target, { recursive: true });
          else {
            await mkdir(dirname(target), { recursive: true });
            const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => zip.openReadStream(entry, (error, value) => {
              if (error || !value) rejectStream(archiveValidationError(error, "无法读取 ZIP 条目"));
              else resolveStream(value);
            }));
            let actualBytes = 0;
            const meter = new Transform({
              transform: (chunk: Buffer, _encoding, callback) => {
                actualBytes += chunk.length;
                try {
                  if (declared > 0 && actualBytes > declared) {
                    throw new ImportArchiveValidationError("ZIP 条目实际大小超过声明");
                  }
                  // Fail-closed: declared size 0 must not yield payload bytes.
                  if (declared === 0 && actualBytes > 0) {
                    throw new ImportArchiveValidationError("ZIP 条目大小声明异常");
                  }
                  if (actualBytes > this.limits.maxEntryBytes) {
                    throw new ImportArchiveValidationError("ZIP 中单个文件超过限制");
                  }
                  if (actualBytes > remainingBudget) {
                    throw extractionLimitError();
                  }
                  callback(null, chunk);
                } catch (error) {
                  callback(error as Error);
                }
              }
            });
            try {
              await pipeline(stream, meter, createWriteStream(target, { flags: "wx" }));
            } catch (error) {
              // yauzl may reject size-lies before our meter sees bytes; map to a stable public message.
              const message = error instanceof Error ? error.message : String(error);
              if (/too many bytes in the stream/i.test(message)) {
                throw new ImportArchiveValidationError(declared === 0 ? "ZIP 条目大小声明异常" : "ZIP 条目实际大小超过声明");
              }
              if (/not enough bytes in the stream/i.test(message)) {
                throw new ImportArchiveValidationError("ZIP 条目实际大小与声明不符");
              }
              throw archiveValidationError(error, "ZIP 解压失败");
            }
            // Budget after write uses metered bytes, not the declared size alone.
            extractedBytes += actualBytes;
            if (extractedBytes > extractionBudget) throw extractionLimitError();
          }
          zip.readEntry();
        })().catch(abort);
      });
      zip.readEntry();
    });
  }

  private async upsert(source: ImportSource): Promise<void> {
    this.state.upsertSource(source);
  }

  private async readSources(): Promise<ImportSource[]> {
    return this.state.sources() as ImportSource[];
  }

  private async availableBytes(path: string): Promise<number> {
    const filesystem = await statfs(path);
    return filesystem.bavail * filesystem.bsize;
  }

  private async directoryBytes(path: string): Promise<number> {
    let total = 0;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      try {
        if (entry.isDirectory()) total += await this.directoryBytes(child);
        else if (entry.isFile()) total += (await stat(child)).size;
      } catch (error) {
        // Explicit source cleanup may race this conservative capacity scan.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return total;
  }

  private async writeSources(sources: ImportSource[]): Promise<void> {
    for (const source of sources) this.state.upsertSource(source);
  }
}

async function drainStream(stream: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    stream.once("end", resolvePromise);
    stream.once("error", rejectPromise);
    (stream as NodeJS.ReadableStream & { resume(): void }).resume();
  });
}

export function createImportSourceManager(
  runtimeRoot: string,
  projectRoot: string,
  maxArchiveBytes: number
): ImportSourceManager {
  return new ImportSourceManager(runtimeRoot, projectRoot, { maxArchiveBytes });
}
