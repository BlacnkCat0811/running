import { createReadStream, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

import type { RoutePoint } from "@rai/contracts";
import { SqliteRoutePointReader } from "@rai/storage-sqlite";
import { SaxesParser, type SaxesTagPlain } from "saxes";

import { RaiDatabase } from "./database.js";
import { prepareNative, NativeWorkerError, type NativeOptions } from "./native-worker.js";
import {
  normalizeRelativePath,
  normalizeRelativePathForFileSystem,
  parseFiniteNumber,
  stableId
} from "./utils.js";

interface PointDraft {
  latitude: number | null;
  longitude: number | null;
  timestamp: string | null;
  elevationMeters: number | null;
  speedMetersPerSecond: number | null;
  courseDegrees: number | null;
  horizontalAccuracyMeters: number | null;
  verticalAccuracyMeters: number | null;
}

export interface GpxImportResult {
  routeFileCount: number;
  importedRouteCount: number;
  missingRouteCount: number;
  pointCount: number;
  skippedRouteCount?: number;
  /** Files listed by the archive that could not be resolved on disk. */
  unresolvedRouteCount?: number;
  unresolvedRoutePaths?: string[];
  changedRouteIds?: string[];
  /** Files refused by the per-route quotas below (V2.1 §5.2). */
  oversizedRouteCount?: number;
  /**
   * `source_gpx_bundle_sha256` 是**复用**了上一批的值还是**重算**的。
   *
   * 可断言观测：本批没有任何路线变化时必须 `reused`（否则"小批同步"仍然每批扫全表）；
   * 有变化时必须 `recomputed`（否则摘要会停在旧值上，成了一条假证据）。
   */
  bundleHashSource?: "reused" | "recomputed";
}

/**
 * 单条路线的字节上限（V2.1 §5.2 的「单 GPX > 20 MB ⇒ 413」）。
 *
 * 规范给的 20 MB 不采用，理由是可核对的量级：本仓自己生成的 GPX 每点约 213 B
 * （`apps/ios/RAI/HealthKitExport.swift` 的 `gpx(_:points:)` 逐点写 8 个字段，无抽稀），
 * 而一份 24 小时越野（Apple 的路线点按 1 Hz 计约 86,400 点）≈ 18.4 MB —— **正好压在
 * 20 MB 线上**。取 64 MiB = 最坏合法值的 3.5 倍。
 *
 * 为什么阈值必须远高于合法上限：超限的处置（见 `importGpxRoutes` 的配额分支）会让
 * **该次跑步拿不到轨迹与海拔** —— 而它不可归因（用户看到的是"这次跑步没有轨迹"）。
 * 所以这条配额能成立的前提不是"处置得巧"，而是"合法数据碰不到"。
 */
export const MAX_GPX_ROUTE_BYTES = 64 * 1024 * 1024;

/**
 * 单条路线的点数上限（V2.1 §5.2 的「> 50,000 点 ⇒ 422」）。
 *
 * 规范给的 50,000 不采用：50,000 点 @1 Hz = 13.9 小时，会把 24 小时越野（≈86,400 点）判死。
 * 取 300,000（≈83 小时），同时**刻意低于字节上限能容纳的点数**
 * （64 MiB ÷ 213 B ≈ 315,000）—— 这样两个上限不会互相矛盾：对典型文件先触发的是点数上限，
 * 而字节上限挡住的是"每点字段更啰嗦"的形态。若点数上限高于字节上限能容纳的点数，
 * 它就是一个永远不会生效的摆设。
 */
export const MAX_GPX_ROUTE_POINTS = 300_000;

/**
 * 整个导入批次的点数上限。
 *
 * 🔴 **它不拒绝任何路线，只记一条 issue。** 规范要求「整批 > 200,000 点 ⇒ 422」，
 * 那个数字在本仓会把**唯一的重建路径**打死：「重新导入全部」（`full`）会导出
 * **全部**跑步及其全部路线（`HealthKitSync.swift` 的 `if full` ⇒ anchor 置空 ⇒
 * `runningWorkouts` 无日期谓词 ⇒ 全量），一个三年每周 3 小时的用户 ≈ 168 万点，
 * 超 200,000 达 8 倍以上。整包被拒 ⇒ 用户再也无法重建，且每次重试都会被拒。
 *
 * 取 2,000 万点 ≈ 4.3 GB 的路线数据 ≈ 累计跑量 5,500 小时，落在
 * `DEFAULT_LIMITS.maxExtractedBytes`（12 GiB，`import-sources.ts`）之下 ——
 * 也就是说它是**异常观测**，不是配额闸门。
 */
export const MAX_GPX_BATCH_POINTS = 20_000_000;

/** 配额超限。与"这份文件坏了"是两件事，调用方必须分开处置。 */
export class GpxQuotaExceededError extends Error {
  constructor(
    readonly kind: "bytes" | "points",
    readonly observed: number,
    readonly limit: number,
    readonly routePath: string
  ) {
    super(
      kind === "bytes"
        ? `GPX 文件 ${routePath} 有 ${observed} 字节，超过单条路线上限 ${limit} 字节`
        : `GPX 文件 ${routePath} 有 ${observed} 个轨迹点，超过单条路线上限 ${limit} 点`
    );
    this.name = "GpxQuotaExceededError";
  }
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

function safelyResolve(root: string, relativePath: string): string | null {
  const rootPath = resolve(root);
  // Case must survive here: archive names are case-sensitive and this path is
  // handed to the filesystem, not to a case-insensitive identity map.
  const candidate = resolve(rootPath, normalizeRelativePathForFileSystem(relativePath));
  const relativeCandidate = relative(rootPath, candidate);
  if (relativeCandidate.startsWith("..") || resolve(candidate) === rootPath) return null;
  return candidate;
}

async function parseGpxFile(
  path: string,
  onPoints: (points: RoutePoint[]) => void,
  nativeOptions: NativeOptions = {}
): Promise<{ pointCount: number; sha256: string }> {
  // 点数配额在这里执行（而不是在文件大小上）：点数才是库膨胀与推荐器成本的来源，
  // 而"文件多大"只是个代理。计数在**回调前**做 —— 一旦超限就抛，之后的点一个都不入库。
  let emitted = 0;
  const guardedOnPoints = (batch: RoutePoint[]): void => {
    emitted += batch.length;
    if (emitted > MAX_GPX_ROUTE_POINTS) {
      throw new GpxQuotaExceededError("points", emitted, MAX_GPX_ROUTE_POINTS, path);
    }
    onPoints(batch);
  };
  const native = await prepareNative("gpx", path, nativeOptions);
  if (native) {
    try {
      let batch: RoutePoint[] = [];
      for (const point of native.database.prepare(`SELECT sequence, timestamp, latitude, longitude,
        elevationMeters, speedMetersPerSecond, courseDegrees, horizontalAccuracyMeters, verticalAccuracyMeters
        FROM gpx_points ORDER BY sequence`).iterate() as unknown as Iterable<RoutePoint>) {
        batch.push(point);
        if (batch.length === 1000) { guardedOnPoints(batch); batch = []; }
      }
      if (batch.length) guardedOnPoints(batch);
      return { pointCount: native.result.rows, sha256: native.result.sha256! };
    } finally { await native.dispose(); }
  }
  let points: RoutePoint[] = [];
  let pointCount = 0;
  const sourceHash = createHash("sha256");
  let currentPoint: PointDraft | null = null;
  let textField: string | null = null;
  let textValue = "";
  const parser = new SaxesParser({ xmlns: false });

  parser.on("opentag", (tag) => {
    const name = localName(tag.name);
    if (name === "trkpt") {
      const attributes = attributesOf(tag);
      currentPoint = {
        latitude: parseFiniteNumber(attributes.lat),
        longitude: parseFiniteNumber(attributes.lon),
        timestamp: null,
        elevationMeters: null,
        speedMetersPerSecond: null,
        courseDegrees: null,
        horizontalAccuracyMeters: null,
        verticalAccuracyMeters: null
      };
    } else if (
      currentPoint &&
      ["time", "ele", "speed", "course", "hAcc", "vAcc"].includes(name)
    ) {
      textField = name;
      textValue = "";
    }
  });

  parser.on("text", (value) => {
    if (textField) textValue += value;
  });

  parser.on("closetag", (tag) => {
    const name = localName(tag.name);
    if (currentPoint && textField === name) {
      const value = textValue.trim();
      switch (name) {
        case "time": {
          const date = new Date(value);
          currentPoint.timestamp = Number.isNaN(date.getTime()) ? null : date.toISOString();
          break;
        }
        case "ele":
          currentPoint.elevationMeters = parseFiniteNumber(value);
          break;
        case "speed":
          currentPoint.speedMetersPerSecond = parseFiniteNumber(value);
          break;
        case "course":
          currentPoint.courseDegrees = parseFiniteNumber(value);
          break;
        case "hAcc":
          currentPoint.horizontalAccuracyMeters = parseFiniteNumber(value);
          break;
        case "vAcc":
          currentPoint.verticalAccuracyMeters = parseFiniteNumber(value);
          break;
      }
      textField = null;
      textValue = "";
    }

    if (name === "trkpt" && currentPoint) {
      if (currentPoint.latitude !== null && currentPoint.longitude !== null) {
        points.push({
          sequence: pointCount,
          timestamp: currentPoint.timestamp,
          latitude: currentPoint.latitude,
          longitude: currentPoint.longitude,
          elevationMeters: currentPoint.elevationMeters,
          speedMetersPerSecond: currentPoint.speedMetersPerSecond,
          courseDegrees: currentPoint.courseDegrees,
          horizontalAccuracyMeters: currentPoint.horizontalAccuracyMeters,
          verticalAccuracyMeters: currentPoint.verticalAccuracyMeters
        });
        pointCount += 1;
        if (points.length >= 1_000) {
          guardedOnPoints(points);
          points = [];
        }
      }
      currentPoint = null;
    }
  });

  parser.on("error", (error) => {
    throw error;
  });

  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const text = String(chunk);
    sourceHash.update(text, "utf8");
    parser.write(text);
  }
  parser.close();
  if (points.length > 0) guardedOnPoints(points);
  return { pointCount, sha256: sourceHash.digest("hex") };
}

function allGpxRelativePaths(exportRoot: string): string[] {
  const routeFolder = resolve(exportRoot, "workout-routes");
  if (!existsSync(routeFolder) || !lstatSync(routeFolder).isDirectory()) return [];
  const paths: string[] = [];
  const pending = ["workout-routes"];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(resolve(exportRoot, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      // Never follow symlinks in CLI-discovered exports either.
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gpx")) paths.push(path);
    }
  }
  return paths.sort();
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function bundleHashFromFingerprints(store: RaiDatabase): string {
  const rows = store.database
    .prepare("SELECT relative_path AS relativePath, sha256 FROM route_file_fingerprints")
    .all() as unknown as Array<{ relativePath: string; sha256: string }>;
  const hash = createHash("sha256");
  for (const row of rows.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  )) {
    hash.update(row.relativePath, "utf8");
    hash.update("\0");
    hash.update(row.sha256, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * 导出目录下的 GPX 相对路径（排序、不跟随软链）。
 *
 * 接收器要在**解析 XML 之前**快照本批路线的旧归属，而它手里只有解压后的根目录 ——
 * 这个清单就是"本批会碰哪些路线"的唯一来源。与 `importGpxRoutes` 内部用的是同一份实现，
 * 不允许接收器自己再写一遍目录遍历（两份遍历迟早会在软链/大小写上分叉）。
 */
export function listGpxRelativePaths(exportRoot: string): string[] {
  return allGpxRelativePaths(exportRoot);
}

export async function importGpxRoutes(
  exportRoot: string,
  store: RaiDatabase,
  options?: { preserveAbsent?: boolean; native?: NativeOptions }
): Promise<GpxImportResult> {
  const preserveAbsent = options?.preserveAbsent === true;
  // 全量快照（CLI）需要"库里被引用、但本批没带文件"的完整清单 ⇒ 才建全表映射。
  // 直连批次（`preserveAbsent`）只处理本批那几十个文件：逐个点查走 `relative_path` 的 UNIQUE 索引。
  const referencedTargets = preserveAbsent
    ? null
    : new Map(
        store.routesToImport().map((target) => [
          // normalizeRelativePath 内部已 toLowerCase（见 utils.ts:157），无需再调一次。
          normalizeRelativePath(target.relativePath),
          target
        ])
      );
  const allPaths = allGpxRelativePaths(exportRoot);
  // Partial archives are not evidence that omitted GPX files were deleted.
  if (!preserveAbsent) store.pruneOrphanRoutes(allPaths);
  let importedRouteCount = 0;
  let missingRouteCount = 0;
  let pointCount = 0;
  let skippedRouteCount = 0;
  let oversizedRouteCount = 0;
  const unresolvedRoutePaths: string[] = [];
  const changedRouteIds: string[] = [];
  const bundleHash = createHash("sha256");
  // 路线点只有这一个入口（视图 + 唯一判据），见 `read/route-point-reader.ts`。
  const routePointReader = new SqliteRoutePointReader(store.database);

  for (const relativePath of allPaths) {
    // 路径身份已由 `normalizeRelativePath` 规范到与落库值同形（小写、正斜杠）⇒ 点查是精确的。
    const referencedId = referencedTargets === null
      ? store.routeIdForPath(normalizeRelativePath(relativePath))
      : referencedTargets.get(relativePath.toLowerCase())?.id ?? null;
    const routeId = referencedId ?? store.ensureOrphanRoute(
          stableId("route", ["orphan", relativePath]),
          relativePath,
          preserveAbsent ? { preserveAbsent: true } : undefined
        );

    const fullPath = safelyResolve(exportRoot, relativePath);
    if (!fullPath || !existsSync(fullPath)) {
      if (preserveAbsent) {
        // `absent` means "not in this partial archive". A file that the archive
        // itself listed but that cannot be resolved on disk is NOT that case: it
        // is an anomaly (path case, encoding, escaping). Never swallow it —
        // record it so the route is not silently stuck at `pending` forever.
        unresolvedRoutePaths.push(relativePath);
        continue;
      }
      store.markRouteStatus(routeId, "missing");
      changedRouteIds.push(routeId);
      missingRouteCount += 1;
      continue;
    }

    let routeVersion: string | null = null;
    // 🔴 只把 **`parseGpxFile` 自己**的失败当作"可能是这份文件坏了"的窗口。
    // 建暂存版本之前与解析成功之后的落库阶段都属于基础设施：那些错误**绝不能**被当成
    // "文件是坏的"吞掉 —— 那会往 `import_issues` 写一条假话（`INVALID_GPX`），
    // 并把指纹删掉让下次重试，而问题根本不在文件上。
    //
    // ⚠️ 光看"错误是从 `parseGpxFile` 里抛出来的"**不足以**划出这个窗口：
    // 落库回调（`onPoints`）是由 `parseGpxFile` **在内部调用**的，它的失败同样从那里冒出来。
    // 所以回调在自己失败时打 `routeWriteFailure` 标记，下面的 catch 据此把两类分开。
    let parseWindowFailure = false;
    let routeWriteFailure = false;
    try {
      const stat = statSync(fullPath);
      // 字节配额在 `beginRouteVersion` **之前**判：那条调用会先在版本表里建行。
      // 先判就能做到"这个文件我们一个字节都不动"，而不是"先建版本、再说超限"。
      if (stat.size > MAX_GPX_ROUTE_BYTES) {
        oversizedRouteCount += 1;
        store.insertIssue({
          severity: "warning",
          code: "GPX_ROUTE_TOO_LARGE",
          objectId: routeId,
          message: new GpxQuotaExceededError("bytes", stat.size, MAX_GPX_ROUTE_BYTES, relativePath).message
        });
        continue;
      }
      // 🔴 指纹缓存命中判据里的"落库点数"改由**唯一**的路线点入口给（`readable_route_points`
      // 视图），不再直接数 `route_points` 表：O11 退役双写之后，已发布路线的点在版本表里，
      // 直接数旧表会让**每一次重导入都判定缓存未命中**（于是重解析一遍、再发布一遍），
      // 或者更糟 —— 数出 0 而把一条本来可读的轨迹当成"没有点"。
      // 判据本身的四条（摘要相同、route id 相同、`imported`、三个点数彼此相等）一条不改。
      const cached = store.database.prepare(`
        SELECT fingerprint.size_bytes AS sizeBytes,
               fingerprint.modified_at_ms AS modifiedAtMs,
               fingerprint.sha256,
               fingerprint.route_id AS routeId,
               fingerprint.point_count AS pointCount,
               route.file_status AS fileStatus,
               route.point_count AS routePointCount
        FROM route_file_fingerprints fingerprint
        LEFT JOIN workout_routes route ON route.id = fingerprint.route_id
        WHERE fingerprint.relative_path = ?
      `).get(relativePath) as unknown as {
        sizeBytes: number; modifiedAtMs: number; sha256: string; routeId: string;
        pointCount: number; fileStatus: string | null; routePointCount: number | null;
      } | undefined;
      const storedPointCount = cached === undefined
        ? 0
        : routePointReader.readablePointCountForRoute(cached.routeId);
      const currentSha256 = await hashFile(fullPath);
      if (
        cached &&
        cached.sha256 === currentSha256 &&
        cached.routeId === routeId &&
        cached.fileStatus === "imported" &&
        cached.routePointCount === cached.pointCount &&
        storedPointCount === cached.pointCount
      ) {
        bundleHash.update(relativePath, "utf8");
        bundleHash.update("\0");
        bundleHash.update(cached.sha256, "utf8");
        bundleHash.update("\0");
        skippedRouteCount += 1;
        pointCount += cached.pointCount;
        continue;
      }
      // 🔴 点先写进**未发布**的版本，完全不碰 `route_points`。
      // 旧写法是先 `DELETE FROM route_points` 再解析 —— 于是"文件坏了"会连带把
      // **已经能用的轨迹**擦掉（`parser.test.ts` 曾经就是按这个行为断言的）。
      // 现在失败只记在版本上，指针与已发布轨迹原样不动（docs §5.3）。
      routeVersion = store.beginRouteVersion(routeId);
      let parsed: Awaited<ReturnType<typeof parseGpxFile>>;
      // ⚠️ 必须在**抛出点**标记，不能在 `finally` 里翻标志再让外层 catch 去读 ——
      // `finally` 会先于外层 catch 执行，标志会在 catch 看到它之前就被改掉，
      // 于是"文件坏了"也会被当成基础设施错误上抛（实测：配额与坏文件两条路径全红）。
      try {
        parsed = await parseGpxFile(
          fullPath,
          (points) => {
            try {
              store.appendRouteVersionPoints(routeVersion!, points);
            } catch (error) {
              // 🔴 这是**我们的落库**失败，不是这份文件的问题。在**抛出点**打标记，
              // 让下面那个 catch 能把它与"文件解析失败"分开 —— 两个 catch 之间没有别的
              // 通道，靠错误类型去猜也不可靠（DB 错误可以是任何形状）。
              routeWriteFailure = true;
              throw error;
            }
          },
          options?.native
        );
      } catch (error) {
        parseWindowFailure = !routeWriteFailure;
        throw error;
      }
      const { pointCount: importedPoints, sha256 } = parsed;
      bundleHash.update(relativePath, "utf8");
      bundleHash.update("\0");
      bundleHash.update(sha256, "utf8");
      bundleHash.update("\0");
      store.publishRouteVersion(routeVersion, sha256, importedPoints);
      routeVersion = null;
      store.database.prepare(`
        INSERT INTO route_file_fingerprints (
          relative_path, size_bytes, modified_at_ms, sha256, route_id, point_count, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(relative_path) DO UPDATE SET
          size_bytes = excluded.size_bytes, modified_at_ms = excluded.modified_at_ms,
          sha256 = excluded.sha256, route_id = excluded.route_id,
          point_count = excluded.point_count, imported_at = excluded.imported_at
      `).run(relativePath, stat.size, stat.mtimeMs, sha256, routeId, importedPoints, new Date().toISOString());
      importedRouteCount += 1;
      changedRouteIds.push(routeId);
      pointCount += importedPoints;
    } catch (error) {
      if (error instanceof NativeWorkerError && error.code !== "invalid_xml") throw error;
      // 解析窗口之外的失败一律**上抛**：那些是"我们没能落库"，不是"这份文件坏了"。
      // 把它们记成 `INVALID_GPX` 是写一条假话，还会让下一个人去修解析器。
      // 与上面 `NativeWorkerError` 那条同族：只放行"确属文件问题"的错误。
      if (!parseWindowFailure) throw error;
      // 🔴 配额超限**不是**「这个文件坏了」，两者必须分开处置。
      //
      // 走 `invalid` 会做什么（实测读码）：`markRouteStatus(id, "invalid")` 先
      // `DELETE FROM route_points`、再把 `point_count` 归零；而 `recompute-pipeline.ts:751`
      // 的汇总只认 `file_status = 'imported'` ⇒ 该次跑步的**轨迹与高程增益静默消失**。
      // 用户看到的不是"同步失败"，而是"这次跑步没有轨迹"—— 不可归因、看起来像数据本身缺失。
      //
      // `pending` 是诚实的："我们知道这个文件，但我们没有导入它"。两个状态的**下游成本
      // 其实一样**（都留不下轨迹），差别只在语义与可归因性：`invalid` 断言"文件是坏的"
      // 是**假话**，而假话会让下一个人去修解析器。指纹同样删掉 ⇒ 下次导入会重试。
      //
      // 这一段成立的前提是阈值远高于合法上限（见 MAX_GPX_ROUTE_POINTS 的注释）：
      // 配额能成立靠的是"合法数据碰不到"，不是"处置得巧"。
      if (error instanceof GpxQuotaExceededError) {
        oversizedRouteCount += 1;
        if (routeVersion) store.rejectRouteVersion(routeVersion);
        // 只有在**没有**可用旧轨迹时才动路线状态：有旧轨迹时它对用户仍然可用，
        // 把它打成 `pending` 等于把一条好轨迹说成"没导入"（§5.3「旧可用路线保持」）。
        if (!store.hasUsableRoute(routeId)) store.markRouteStatus(routeId, "pending");
        store.database.prepare(
          "DELETE FROM route_file_fingerprints WHERE relative_path = ?"
        ).run(relativePath);
        changedRouteIds.push(routeId);
        store.insertIssue({
          severity: "warning",
          code: "GPX_ROUTE_TOO_MANY_POINTS",
          objectId: routeId,
          message: error.message
        });
        continue;
      }
      if (routeVersion) store.rejectRouteVersion(routeVersion);
      if (!store.hasUsableRoute(routeId)) store.markRouteStatus(routeId, "invalid");
      store.database.prepare(
        "DELETE FROM route_file_fingerprints WHERE relative_path = ?"
      ).run(relativePath);
      changedRouteIds.push(routeId);
      store.insertIssue({
        severity: "warning",
        code: "INVALID_GPX",
        objectId: routeId,
        message: error instanceof Error ? error.message : "Unable to parse GPX route"
      });
    }
  }

  if (!preserveAbsent) {
    const currentPaths = new Set(allPaths.map((path) => path.toLowerCase()));
    const cachedPaths = store.database.prepare("SELECT relative_path AS relativePath FROM route_file_fingerprints")
      .all() as unknown as Array<{ relativePath: string }>;
    const deleteFingerprint = store.database.prepare("DELETE FROM route_file_fingerprints WHERE relative_path = ?");
    for (const cached of cachedPaths) {
      if (!currentPaths.has(cached.relativePath.toLowerCase())) deleteFingerprint.run(cached.relativePath);
    }

    const targets = referencedTargets;
    if (targets !== null) {
      for (const [key, target] of targets) {
        if (allPaths.some((path) => path.toLowerCase() === key)) continue;
        store.markRouteStatus(target.id, "missing");
        changedRouteIds.push(target.id);
        missingRouteCount += 1;
      }
    }
  }

  if (unresolvedRoutePaths.length > 0) {
    store.insertIssue({
      severity: "warning",
      code: "UNRESOLVED_GPX_PATH",
      objectId: null,
      message: `${unresolvedRoutePaths.length} GPX file(s) were listed in the archive but could not be resolved on disk; the routes stay pending. First: ${unresolvedRoutePaths[0]}`
    });
  }

  // 批次级**只观测、不拒绝**。理由见 `MAX_GPX_BATCH_POINTS`：这一层的绝对上限会把
  // 「重新导入全部」这条唯一的重建路径打死，而那条路径正是用户在数据出错时的退路。
  // 它在这里的价值是让 `manifest.gpx_point_count` 第一次有消费者：
  // 此前那个值只有写方（下方 `setManifest`）、没有任何读方，于是"这一批到底有多大"
  // 在事后完全不可查。
  if (pointCount > MAX_GPX_BATCH_POINTS) {
    store.insertIssue({
      severity: "warning",
      code: "GPX_BATCH_POINT_BUDGET_EXCEEDED",
      objectId: null,
      message: `本批次共 ${pointCount} 个轨迹点，超过异常阈值 ${MAX_GPX_BATCH_POINTS}；已按原样导入（不作拒绝），仅登记以便事后核查`
    });
  }

  store.setManifest("gpx_file_count", String(allPaths.length));
  store.setManifest("gpx_point_count", String(pointCount));
  store.setManifest("gpx_unresolved_count", String(unresolvedRoutePaths.length));
  // Subset archives must hash remaining fingerprints, not only files in this ZIP.
  //
  // 🔴 但"本批一个文件都没变"时不必重算：`source_gpx_bundle_sha256` 是一个对**整表**
  // 排序后求的摘要，每批都扫一遍等于把"小批同步"的成本绑在历史路线数上。复用的两个前提
  // 各自可验证：①本批没有任何指纹行被增/改/删；②指纹行数与上次写入时相等（防"被外部删了
  // 一行但没人记账"）。任一不满足就老老实实重算。
  const fingerprintCount = Number((store.database
    .prepare("SELECT COUNT(*) AS n FROM route_file_fingerprints")
    .get() as { n: number } | undefined)?.n ?? 0);
  const previousBundle = store.database
    .prepare("SELECT value FROM import_manifest WHERE key = 'source_gpx_bundle_sha256'")
    .get() as { value: string } | undefined;
  const previousFingerprintCount = store.database
    .prepare("SELECT value FROM import_manifest WHERE key = 'gpx_fingerprint_count'")
    .get() as { value: string } | undefined;
  const routesUnchanged = changedRouteIds.length === 0
    && importedRouteCount === 0
    && missingRouteCount === 0
    && oversizedRouteCount === 0
    && unresolvedRoutePaths.length === 0;
  const bundleHashSource: "reused" | "recomputed" = preserveAbsent
    && routesUnchanged
    && previousBundle !== undefined
    && previousBundle.value.length > 0
    && Number(previousFingerprintCount?.value ?? Number.NaN) === fingerprintCount
    ? "reused"
    : "recomputed";
  store.setManifest(
    "source_gpx_bundle_sha256",
    bundleHashSource === "reused"
      ? String(previousBundle?.value)
      : (preserveAbsent ? bundleHashFromFingerprints(store) : bundleHash.digest("hex"))
  );
  // 给"复用"留下可验证的规模证据：下一次同名键对不上就重算。
  store.setManifest("gpx_fingerprint_count", String(fingerprintCount));
  // 🔴 按**所有权**提交，不是"擅自提交"：store 模式下这里就是提交自己那一段；
  // caller 模式（直连接收事务）下提交权归调用方，这里什么都不做。
  // 直接写 `store.flush()` 会让整条直连车道在**每一批**上失败（实测：解析器/路线写入器
  // 都是这么挂的），而失败原因看起来像"事务所有权配置错了"，与真因（组件擅自提交）无关。
  store.flushIfOwned();

  return {
    routeFileCount: allPaths.length,
    importedRouteCount,
    missingRouteCount,
    pointCount,
    skippedRouteCount,
    unresolvedRouteCount: unresolvedRoutePaths.length,
    // Bounded sample; `unresolvedRouteCount` is the authoritative total.
    unresolvedRoutePaths: unresolvedRoutePaths.slice(0, 10),
    changedRouteIds,
    oversizedRouteCount,
    bundleHashSource
  };
}
