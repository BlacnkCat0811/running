import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve, sep } from "node:path";
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
}

const DEFAULT_LIMITS: ZipLimits = {
  maxArchiveBytes: 4 * 1024 ** 3,
  maxExtractedBytes: 12 * 1024 ** 3,
  maxEntryBytes: 8 * 1024 ** 3,
  maxEntries: 100_000,
  maxCompressionRatio: 1_000
};

export class ImportSourceManager {
  private readonly root: string;
  private readonly metadataPath: string;
  private readonly state: RuntimeStateStore;
  private readonly limits: ZipLimits;

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

  async saveUpload(stream: NodeJS.ReadableStream, filename: string): Promise<ImportInspection> {
    const id = `upload_${randomUUID()}`;
    const directory = resolve(this.root, id);
    const archivePath = resolve(directory, "source.zip");
    await mkdir(directory, { recursive: true });
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.limits.maxArchiveBytes) (stream as NodeJS.ReadableStream & { destroy(error: Error): void }).destroy(new Error("ZIP 文件超过大小限制"));
        hash.update(chunk);
      });
      await pipeline(stream, createWriteStream(archivePath, { flags: "wx" }));
      await this.assertZipMagic(archivePath);
      const extracted = resolve(directory, "extracted");
      await this.extractZip(archivePath, extracted);
      const source = await this.buildSource(id, "upload", filename, extracted, archivePath, hash.digest("hex"));
      await this.upsert(source);
      return await this.inspection(source);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
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
    if (!source) throw new Error("未找到导入来源");
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

  async cleanupUpload(id: string): Promise<void> {
    const source = await this.get(id);
    if (!source || source.kind !== "upload") return;
    await rm(resolve(this.root, id), { recursive: true, force: true });
    this.state.deleteSource(id);
  }

  private async buildSource(id: string, kind: ImportSourceKind, displayName: string, searchRoot: string, originalPath: string, sha: string | null): Promise<ImportSource> {
    const inputPath = await this.findExportRoot(searchRoot);
    const exportPath = existsSync(resolve(inputPath, "export.xml")) ? resolve(inputPath, "export.xml") : resolve(inputPath, "导出.xml");
    const exportInfo = await stat(exportPath);
    const routeRoot = resolve(inputPath, "workout-routes");
    let routeFileCount = 0;
    if (existsSync(routeRoot)) routeFileCount = (await readdir(routeRoot, { recursive: true })).filter((name) => extname(String(name)).toLowerCase() === ".gpx").length;
    const old = await this.get(id);
    return {
      id, kind, displayName, inputPath, originalPath, sourceSha256: sha,
      exportFileName: basename(exportPath), exportBytes: exportInfo.size, routeFileCount,
      modifiedAt: exportInfo.mtime.toISOString(), createdAt: old?.createdAt ?? new Date().toISOString(),
      lastUsedAt: old?.lastUsedAt ?? null
    };
  }

  private async findExportRoot(root: string): Promise<string> {
    if (!existsSync(root) || !(await stat(root)).isDirectory()) throw new Error("Apple Health 导出目录不存在");
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
    if (matches.length === 0) throw new Error("未找到 export.xml 或导出.xml");
    if (matches.length > 1) throw new Error("ZIP 中包含多个 Apple Health 导出目录");
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
      sourceId: source.id, status: previous ? "unchanged" : "ready", exportFileName: source.exportFileName,
      exportBytes: source.exportBytes, exportCreatedAt: source.modifiedAt,
      sourceSha256: source.sourceSha256, routeFileCount: source.routeFileCount,
      previousImportAt: previous?.lastUsedAt ?? source.lastUsedAt, warnings: []
    };
  }

  private async assertZipMagic(path: string): Promise<void> {
    const handle = await import("node:fs/promises").then(({ open }) => open(path, "r"));
    try {
      const buffer = Buffer.alloc(4);
      await handle.read(buffer, 0, 4, 0);
      if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(buffer[2]!)) throw new Error("上传文件不是有效 ZIP");
    } finally { await handle.close(); }
  }

  private async extractZip(archive: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    const zip = await new Promise<ZipFile>((ok, fail) => yauzl.open(archive, { lazyEntries: true, decodeStrings: false }, (error, file) => error || !file ? fail(error ?? new Error("无法打开 ZIP")) : ok(file)));
    let entries = 0;
    let extractedBytes = 0;
    await new Promise<void>((ok, fail) => {
      const abort = (error: unknown) => { zip.close(); fail(error); };
      zip.on("error", abort);
      zip.on("end", ok);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          entries += 1;
          if (entries > this.limits.maxEntries) throw new Error("ZIP 文件数量超过限制");
          if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw new Error("ZIP 不允许包含符号链接");
          const rawName = entry.fileName as unknown;
          const nameBuffer = Buffer.isBuffer(rawName) ? rawName : Buffer.from(String(rawName), "binary");
          const name = (isUtf8(nameBuffer) ? nameBuffer.toString("utf8") : nameBuffer.toString("latin1"))
            .replaceAll("\\", "/");
          if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..") || name.includes("\0")) throw new Error("ZIP 包含不安全路径");
          if (entry.uncompressedSize > this.limits.maxEntryBytes) throw new Error("ZIP 中单个文件超过限制");
          if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > this.limits.maxCompressionRatio) throw new Error("ZIP 压缩比异常");
          extractedBytes += entry.uncompressedSize;
          if (extractedBytes > this.limits.maxExtractedBytes) throw new Error("ZIP 解压后大小超过限制");
          const target = resolve(destination, name);
          if (target !== destination && !target.startsWith(destination + sep)) throw new Error("ZIP 包含越界路径");
          if (name.endsWith("/")) await mkdir(target, { recursive: true });
          else {
            await mkdir(dirname(target), { recursive: true });
            const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => zip.openReadStream(entry, (error, value) => error || !value ? rejectStream(error ?? new Error("无法读取 ZIP 条目")) : resolveStream(value)));
            await pipeline(stream, createWriteStream(target, { flags: "wx" }));
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

  private async writeSources(sources: ImportSource[]): Promise<void> {
    for (const source of sources) this.state.upsertSource(source);
  }
}
