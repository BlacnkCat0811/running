import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
  permit?: string;
}
export interface NativeMetrics {
  operation: "health" | "gpx" | "aggregate" | "apply-records";
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
    spool = new NativeSpool(directory, result);
    const metadata = spool.database.prepare("SELECT payload FROM worker_metadata WHERE id=1").get() as { payload: string } | undefined;
    if (!metadata || JSON.stringify(JSON.parse(metadata.payload)) !== JSON.stringify(result)) {
      throw new NativeWorkerError("invalid_protocol");
    }
    const table = operation === "health" ? "xml_units" : operation === "gpx" ? "gpx_points" : "route_aggregates";
    const count = spool.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    if (count.n !== result.rows) throw new NativeWorkerError("invalid_protocol");
    report({ operation, requested: "rust", actual: "rust", version: result.version,
      durationMs: performance.now() - started, peakRssKiB: result.peakRssKiB });
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
