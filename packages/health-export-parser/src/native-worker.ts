import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const NATIVE_PROTOCOL = 1;
export const NATIVE_VERSION = "0.1.0";
export type ImportEngine = "typescript" | "rust";
export interface NativeOptions {
  engine?: ImportEngine;
  fallback?: "none" | "typescript";
  binary?: string;
  version?: string;
  spoolRoot?: string;
  signal?: AbortSignal;
  /** Set only by the import CLI for its isolated candidate, never the active DB. */
  stagingDatabase?: string;
  /**
   * `"replay"` marks the B3 idempotence re-run. It is deliberately excluded from the
   * `rai:native-engine` metrics so the reported `rustCalls` / `wallMs` keep describing
   * the real import rather than an internal self-check that doubles the call count.
   */
  purpose?: "replay";
  permit?: string;
}
/**
 * `rai:native-engine` 上报的 operation 全集 —— **发送端**的权威声明（编译期类型 + 运行期清单）。
 *
 * 🔴 接收端（`apps/api/src/import-worker.ts`）**不再持有同一份名单**：那边走
 * `NATIVE_OPERATION_NAME_PATTERN` 格式校验。这是 2026-09-21 修掉的第五形态耦合 ——
 * 与 `computeStagesMs` 的 7 个埋点在接收端被硬编码白名单静默吃掉是同一个坑。
 *
 * 本数组只被两处消费：下面的 `NativeOperation` 类型，以及
 * `apps/api/test/import-worker-native-engine-metric.test.ts` 的跨端兼容断言
 * （保证「这里新加一个 operation 时接收端一定认得」）。
 */
export const NATIVE_OPERATIONS = ["health", "gpx", "aggregate", "apply-records"] as const;
export type NativeOperation = (typeof NATIVE_OPERATIONS)[number];

export interface NativeMetrics {
  operation: NativeOperation;
  requested: ImportEngine;
  actual: ImportEngine;
  durationMs: number;
  peakRssKiB?: number;
  fallbackReason?: string;
  version?: string;
}
interface NativeResult {
  protocol: number;
  engine: string;
  version: string;
  operation: NativeMetrics["operation"];
  rows: number;
  inputBytes?: number;
  sha256?: string;
  durationMs: number;
  peakRssKiB: number;
  insertedRecords?: number;
  tombstonedRecords?: number;
  observedRecords?: number;
  /** B1: sha256 over `"{n}|{id}|{content_hash}\n"` for every canonical row READ. */
  canonicalDigest?: string;
}

export function importEngine(value = process.env.RAI_IMPORT_ENGINE ?? "typescript"): ImportEngine {
  if (value !== "typescript" && value !== "rust") throw new Error("RAI_IMPORT_ENGINE must be typescript or rust");
  return value;
}
export function nativeFallback(value = process.env.RAI_RUST_FALLBACK ?? "none"): "none" | "typescript" {
  if (value !== "none" && value !== "typescript") throw new Error("RAI_RUST_FALLBACK must be none or typescript");
  return value;
}
export function nativeBinary(): string {
  return process.env.RAI_RUST_BINARY ?? fileURLToPath(
    new URL(`../../../target/release/rai-data-worker${process.platform === "win32" ? ".exe" : ""}`, import.meta.url)
  );
}

/**
 * 本机 Rust worker 是否可用于 parity 验证 / `RAI_IMPORT_ENGINE=rust`。
 *
 * ## 为什么需要它（2026-10-19）
 *
 * 仓库不提交 `target/`。一个旧的 debug/release 产物可能**早于** Rust 源码的 parity 修复
 * 存在（本机实测：产物 10-16，`c644c49`（10-18）才修好 TS↔Rust 账本差异）。此时
 * `native-worker.test.ts` 会把"产物过期"报成"产品 parity 坏了"，而机器上没有 cargo
 * 又无法重建 —— 失败信息指向错误方向。
 *
 * 判据：产物存在 + **不早于** Rust 源文件/Cargo 清单的最新 mtime。源码树不存在（打包部署
 * 只带二进制）时无法判断新旧，按"可用"处理（不制造假跳过）。
 */
export interface NativeWorkerAvailability {
  binary: string;
  exists: boolean;
  stale: boolean;
  ready: boolean;
  /** 不可用原因（`ready=false` 时必为非空，供测试 skip/异常消息使用）。 */
  reason: string | null;
}

/** Rust 源文件/清单的最新 mtime；源码树不存在 ⇒ `null`（打包部署）。 */
export function newestNativeSourceMtimeMs(root?: string): number | null {
  const projectRoot = root ?? fileURLToPath(new URL("../../../", import.meta.url));
  const candidates = [
    join(projectRoot, "Cargo.toml"),
    join(projectRoot, "Cargo.lock"),
    join(projectRoot, "crates", "rai-data-worker", "Cargo.toml")
  ];
  let newest: number | null = null;
  const consider = (path: string) => {
    try {
      const stat = statSync(path);
      if (stat.isFile()) newest = Math.max(newest ?? 0, stat.mtimeMs);
    } catch {
      // 不存在/不可读：源码树可能没随部署包分发。
    }
  };
  for (const candidate of candidates) consider(candidate);
  const walk = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".rs")) consider(path);
    }
  };
  walk(join(projectRoot, "crates", "rai-data-worker", "src"));
  return newest;
}

/** 纯判据：产物是否存在、是否早于源码。`newestSourceMtimeMs == null` ⇒ 不判过期。 */
export function nativeArtifactState(
  binary: string,
  newestSourceMtimeMs: number | null
): { exists: boolean; stale: boolean; reason: string | null } {
  if (!existsSync(binary)) {
    return {
      exists: false,
      stale: false,
      reason: "Rust worker binary is not built; run npm run rust:build (cargo build --release)"
    };
  }
  if (newestSourceMtimeMs !== null) {
    try {
      const binaryMtime = statSync(binary).mtimeMs;
      if (binaryMtime < newestSourceMtimeMs) {
        return {
          exists: true,
          stale: true,
          reason: "Rust worker binary is older than its Rust sources; rebuild with npm run rust:build "
            + "(a stale binary reports the pre-parity-fix behaviour as a product failure)"
        };
      }
    } catch {
      // stat 失败按"无法判断"处理（不制造假跳过）。
    }
  }
  return { exists: true, stale: false, reason: null };
}

export function nativeWorkerAvailability(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot?: string
): NativeWorkerAvailability {
  const binary = env.RAI_RUST_BINARY ?? nativeBinary();
  const state = nativeArtifactState(binary, newestNativeSourceMtimeMs(projectRoot));
  return {
    binary,
    exists: state.exists,
    stale: state.stale,
    ready: state.exists && !state.stale,
    reason: state.reason
  };
}
export class NativeWorkerError extends Error {
  constructor(readonly code: string) { super(`Rust data worker: ${code}`); }
}

function report(metrics: NativeMetrics): void {
  if (process.send && process.connected) process.send({ type: "rai:native-engine", ...metrics }, () => {});
}

export class NativeSpool {
  readonly database: DatabaseSync;
  private disposed = false;
  constructor(readonly directory: string, readonly result: NativeResult) {
    this.database = new DatabaseSync(join(directory, "data.sqlite"), { readOnly: true });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.database.close();
    await rm(this.directory, { recursive: true, force: true });
  }
}

/** No business DB is writable by this protocol: output must be a fresh spool. */
export async function prepareNative(
  operation: NativeMetrics["operation"], input: string, options: NativeOptions
): Promise<NativeSpool | null> {
  if (options.engine !== "rust") return null;
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(options.spoolRoot ?? tmpdir(), "rai-native-"));
  const output = join(directory, "data.sqlite");
  const started = performance.now();
  let spool: NativeSpool | undefined;
  try {
    const binary = resolve(options.binary ?? nativeBinary());
    if (!existsSync(binary)) throw new NativeWorkerError("unavailable");
    const data = await new Promise<string>((done, reject) => {
      // Pass only execution basics: never pass the API token or the main DB path.
      const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "TZ"]
        .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
      const args = ["--operation", operation, "--input", resolve(input), "--output", output];
      if (operation === "apply-records") {
        if (!options.stagingDatabase || !options.permit) return reject(new NativeWorkerError("invalid_protocol"));
        args.push("--staging-database", resolve(options.stagingDatabase), "--permit", options.permit);
      }
      const child = spawn(binary, args, {
        env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "", stderr = "", failure: Error | undefined;
      let force: NodeJS.Timeout | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill("SIGTERM");
        force ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
        force.unref();
      };
      const abort = () => stop(new NativeWorkerError("cancelled"));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const timeout = setTimeout(() => stop(new NativeWorkerError("timeout")), 30 * 60_000);
      timeout.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stdout) + chunk.length > 64 * 1024) stop(new NativeWorkerError("protocol_limit"));
        else stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
      child.on("error", () => { failure ??= new NativeWorkerError("unavailable"); });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (force) clearTimeout(force);
        options.signal?.removeEventListener("abort", abort);
        if (failure) return reject(failure);
        if (code !== 0) {
          let reason = "native_failure";
          try {
            const payload = JSON.parse(stderr) as { code?: string };
            if (payload.code === "resource_limit" || payload.code === "unsupported_xml" || payload.code === "invalid_xml") reason = payload.code;
          } catch { /* stderr is never a trusted public message */ }
          return reject(new NativeWorkerError(reason));
        }
        done(stdout);
      });
    });
    let result: NativeResult;
    try { result = JSON.parse(data) as NativeResult; }
    catch { throw new NativeWorkerError("invalid_protocol"); }
    if (result.protocol !== NATIVE_PROTOCOL || result.version !== (options.version ?? NATIVE_VERSION) ||
        result.engine !== "rust" || result.operation !== operation ||
        !Number.isSafeInteger(result.rows) || result.rows < 0 ||
        !Number.isFinite(result.durationMs) || result.durationMs < 0 ||
        !Number.isFinite(result.peakRssKiB) || result.peakRssKiB < 0 ||
        (["health", "gpx"].includes(operation) && (!/^[a-f0-9]{64}$/.test(result.sha256 ?? "") ||
          !Number.isSafeInteger(result.inputBytes) || result.inputBytes! < 0))) {
      throw new NativeWorkerError("invalid_protocol");
    }
    if (operation === "apply-records" && [result.insertedRecords, result.tombstonedRecords, result.observedRecords]
      .some((value) => !Number.isSafeInteger(value) || value! < 0)) throw new NativeWorkerError("invalid_protocol");
    // B1: `canonicalDigest` is deliberately absent-tolerant. A worker built before the
    // invariant existed must NOT brick the import queue — that would turn a
    // deploy-order mistake into an outage. The parent records the missing digest as an
    // issue instead. A digest that is PRESENT but malformed is a protocol violation.
    if (operation === "apply-records" && result.canonicalDigest !== undefined
      && !/^[a-f0-9]{64}$/.test(result.canonicalDigest)) {
      throw new NativeWorkerError("invalid_protocol");
    }
    spool = new NativeSpool(directory, result);
    const metadata = spool.database.prepare("SELECT payload FROM worker_metadata WHERE id=1").get() as { payload: string } | undefined;
    if (!metadata || JSON.stringify(JSON.parse(metadata.payload)) !== JSON.stringify(result)) {
      throw new NativeWorkerError("invalid_protocol");
    }
    const table = operation === "health" ? "xml_units" : operation === "gpx" ? "gpx_points" : "route_aggregates";
    const count = spool.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    if (count.n !== result.rows) throw new NativeWorkerError("invalid_protocol");
    if (options.purpose !== "replay") {
      report({ operation, requested: "rust", actual: "rust", version: result.version,
        durationMs: performance.now() - started, peakRssKiB: result.peakRssKiB });
    }
    return spool;
  } catch (error) {
    if (spool) spool.database.close();
    await rm(directory, { recursive: true, force: true });
    const reason = error instanceof NativeWorkerError ? error.code : "native_failure";
    // Fallback is ONLY before any decoded rows are applied. Never bypass a
    // resource limit, cancellation, protocol mismatch, or partial consumption.
    if (operation !== "apply-records" && options.fallback === "typescript" && ["unavailable", "unsupported_xml"].includes(reason)) {
      report({ operation, requested: "rust", actual: "typescript", fallbackReason: reason, durationMs: performance.now() - started });
      return null;
    }
    if (process.send && process.connected) process.send({ type: "rai:native-failure", code: reason }, () => {});
    throw error instanceof NativeWorkerError ? error : new NativeWorkerError("native_failure");
  }
}

export async function nativeElevationGains(databasePath: string, options: NativeOptions): Promise<ReadonlyMap<string, number | null> | undefined> {
  const spool = await prepareNative("aggregate", databasePath, options);
  if (!spool) return undefined;
  try {
    const values = new Map<string, number | null>();
    for (const row of spool.database.prepare("SELECT workout_id, elevation_gain FROM route_aggregates").iterate() as Iterable<{ workout_id: string; elevation_gain: number | null }>) {
      values.set(row.workout_id, row.elevation_gain);
    }
    return values;
  } finally { await spool.dispose(); }
}
