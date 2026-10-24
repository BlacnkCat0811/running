// 阶段 6 实验安全门禁：路径、身份、环境白名单、回环目标与清理所有权。
//
// 这个模块只回答“能不能开始”，不启动服务、不打开业务库对外写入、不发请求。
// 所有检查都必须在**任何副作用之前**完成：runner 的 dry-run 与 execute 都先过
// 这里，负例回归（apps/api/test/phase6-safety.test.mjs）逐条钉住拒绝路径。
//
// 设计约束（来自阶段 6 实施方案 §4.2 / W1）：
//   1. 实验根必须显式给出，位于仓库之外；仓库、仓库祖先、仓库 var/、系统根、
//      生产 runtime 根一律拒绝。
//   2. 规范路径、父级链接、文件身份与硬链接都核验；主/控库必须是不同的普通文件。
//   3. 子进程环境是白名单，不展开 process.env；显式设置 runtime/main/control/tmp/
//      输出/身份/Token，派生路径逐一解析并断言在实验根内。
//   4. 默认只连接 runner 自己启动并验证身份的回环 API；任意公网目标拒绝。
//   5. 清理只作用于带本次 run-id 所有权标记的实验目录；失败保留原始证据。

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件位于 <repo>/scripts/phase6/safety.mjs）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 所有权标记文件名；没有它就没有资格被清理或复用。 */
export const RUN_MARKER = ".phase6-run.json";

export class SafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SafetyError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new SafetyError(code, message);
};

/** path 是否等于 parent 或位于其下（按路径分量，不做字符串前缀比较）。 */
export function pathContains(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * 解析“目标路径此刻真实的落点”。
 *
 * 不存在的尾段保留词法名字，但父级必须真实存在并解析：这样“尚不存在的
 * run-001”仍能验证它不会落在符号链接后面。与 phase2-http-bench 的实现同口径。
 */
export function realTarget(path) {
  let current = resolve(path);
  const suffix = [];
  while (!existsSync(current)) {
    suffix.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(realpathSync(current), ...suffix);
}

/**
 * 实验根校验。返回 { root, realRoot }；不创建任何东西。
 *
 * `mustNotExist` 是 F1 的默认：新实验只能落在尚不存在的新根上。任何已有目录
 * （包括同 run-id 的旧根）都必须在创建/清理之前拒绝，避免失败重试覆盖证据。
 *
 * @param {string} rootArg 用户显式给出的绝对路径
 * @param {{ repoRoot?: string, allowExisting?: boolean, mustNotExist?: boolean, productionRoot?: string }} [options]
 */
export function assertSafeExperimentRoot(rootArg, options = {}) {
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
  if (typeof rootArg !== "string" || rootArg.trim() === "") {
    fail("root_required", "experiment root is required (an explicit absolute path outside the repository)");
  }
  if (!isAbsolute(rootArg)) fail("root_not_absolute", `experiment root must be absolute: ${rootArg}`);
  const root = resolve(rootArg);
  const segments = root.split(sep).filter(Boolean);
  if (root === sep || segments.length < 2) {
    fail("root_too_shallow", `refusing unsafe experiment root: ${root}`);
  }
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    fail("root_symlink", `refusing symlinked experiment root: ${root}`);
  }
  // 父级链接：根尚不存在时，最容易发生的逃逸是“父目录其实指向别处”。
  // 只查直接父级；更深的链接由 realTarget 的仓库/生产根包含判定兜底。
  if (existsSync(dirname(root)) && lstatSync(dirname(root)).isSymbolicLink()) {
    fail("root_parent_symlink", `refusing experiment root under a symlinked parent: ${dirname(root)}`);
  }
  const repoReal = realpathSync(repoRoot);
  const realRoot = realTarget(root);
  // 仓库本身、仓库祖先（例如 /Users/ta）、仓库内任何位置（含 var/）都拒绝。
  if (realRoot === repoReal) fail("root_is_repo", `experiment root must not be the repository: ${realRoot}`);
  if (pathContains(realRoot, repoReal)) {
    fail("root_contains_repo", `experiment root must not contain the repository: ${realRoot} contains ${repoReal}`);
  }
  if (pathContains(repoReal, realRoot)) {
    fail("root_inside_repo", `experiment root must be outside the repository: ${realRoot} is inside ${repoReal}`);
  }
  const home = process.env.HOME ? realTarget(process.env.HOME) : null;
  if (home !== null && realRoot === home) fail("root_is_home", `refusing home directory as experiment root: ${realRoot}`);
  const productionRootValue = options.productionRoot ?? process.env.RAI_RUNTIME_ROOT;
  if (productionRootValue) {
    const productionRoot = realTarget(productionRootValue);
    // 生产 runtime 根**及其任何子目录**都拒绝：把实验库放进生产目录旁边
    // 等同于把生产数据卷当成实验卷。
    if (pathContains(productionRoot, realRoot)) {
      fail("root_is_production_runtime",
        `experiment root must not be the production runtime or inside it: ${realRoot} is under ${productionRoot}`);
    }
  }
  if (options.mustNotExist === true && existsSync(realRoot)) {
    fail("root_exists", `experiment root must be a new path; refusing to reuse ${realRoot}`);
  }
  if (existsSync(root)) {
    if (!statSync(root).isDirectory()) fail("root_not_directory", `experiment root is not a directory: ${root}`);
    const markerPath = join(root, RUN_MARKER);
    if (existsSync(markerPath)) {
      let marker;
      try {
        marker = JSON.parse(readFileSync(markerPath, "utf8"));
      } catch {
        fail("root_marker_invalid", `experiment root marker is not valid JSON: ${markerPath}`);
      }
      if (marker?.owner !== "phase6" && options.allowExisting !== true) {
        fail("root_foreign_owner", `experiment root is owned by ${String(marker?.owner)}; refusing to reuse: ${root}`);
      }
    } else if (options.allowExisting !== true && readdirSync(root).length > 0) {
      // 已有内容但没有所有权标记：可能是生产 runtime、别人的证据或用户文件。
      fail("root_unowned", `existing experiment root has no ${RUN_MARKER}; refusing to reuse or overwrite: ${root}`);
    }
  }
  return { root, realRoot };
}

/**
 * 独占创建实验根并写入所有权标记。只允许在 assertSafeExperimentRoot 之后调用。
 *
 * F1 语义：默认拒绝**任何**已有根（包括同 run-id 的失败重试）。恢复中断 run
 * 必须另有显式 `--resume` 与逐文件完整性检查，不能沿用 `--execute` 覆盖语义。
 */
export function createOwnedExperimentRoot(rootArg, { runId, now = new Date().toISOString(), repoRoot } = {}) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9._-]{3,80}$/.test(runId)) {
    fail("run_id_invalid", `run id must match [A-Za-z0-9._-]{3,80}: ${String(runId)}`);
  }
  const checked = assertSafeExperimentRoot(rootArg, { repoRoot, mustNotExist: true });
  const { root } = checked;
  try {
    // 非 recursive：父级必须已存在；目录已存在（含并发抢占）由 EEXIST 失败关闭。
    mkdirSync(root);
  } catch (error) {
    if (error?.code === "EEXIST") fail("root_exists", `experiment root already exists; refusing to reuse: ${root}`);
    throw error;
  }
  // 目录创建后再解析一次：父级链接可能在检查与创建之间变化（fail closed）。
  const realRoot = realpathSync(root);
  if (realRoot !== checked.realRoot) {
    fail("root_moved", `experiment root changed while resolving: ${checked.realRoot} -> ${realRoot}`);
  }
  const marker = {
    owner: "phase6",
    runId,
    createdAt: now,
    repoRoot: realpathSync(resolve(repoRoot ?? REPO_ROOT)),
    host: process.platform
  };
  takeRunMarker(root, marker);
  return { root, realRoot, marker };
}

/** 以排他方式写所有权标记（`wx`）；并发写同一根时失败关闭。 */
export function takeRunMarker(root, marker) {
  const markerPath = join(root, RUN_MARKER);
  try {
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") fail("root_marker_exists", `experiment root already has an ownership marker: ${markerPath}`);
    throw error;
  }
  return marker;
}

/** 清理/删除前的所有权复核：标记、run-id、realpath 与 inode 都必须指向本次根。 */
export function assertOwnedDeletionPath(rootReal, target, { runId } = {}) {
  const marker = readRunMarker(rootReal);
  if (marker === null) fail("cleanup_unowned", `refusing deletion: ${rootReal} has no ${RUN_MARKER}`);
  if (marker.owner !== "phase6") fail("cleanup_foreign_owner", `refusing deletion: owner is ${String(marker.owner)}`);
  if (typeof runId === "string" && marker.runId !== runId) {
    fail("cleanup_run_mismatch", `refusing deletion: marker run ${String(marker.runId)} != ${runId}`);
  }
  if (typeof target !== "string" || !isAbsolute(target)) fail("deletion_not_absolute", `deletion target must be absolute: ${String(target)}`);
  const resolved = resolve(target);
  const realParent = realTarget(dirname(resolved));
  const real = resolve(realParent, basename(resolved));
  if (!pathContains(rootReal, real)) fail("deletion_escape", `refusing deletion outside run root: ${resolved} -> ${real}`);
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    fail("deletion_symlink", `refusing deletion of a symlink: ${resolved}`);
  }
  return { real, marker };
}

/** 写入标记（root 已由 createOwnedExperimentRoot 建立时用）。 */
export function readRunMarker(root) {
  const markerPath = join(root, RUN_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 断言某个路径位于实验根内，返回解析后的真实路径。
 * 默认要求存在；allowMissing 用于“即将创建”的输出目录（父级仍需存在）。
 */
export function assertInsideRoot(rootReal, candidate, { label = "path", allowMissing = false, regularFile = false } = {}) {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    fail("path_not_absolute", `${label} must be an absolute path: ${String(candidate)}`);
  }
  const resolved = resolve(candidate);
  if (!allowMissing && !existsSync(resolved)) fail("path_missing", `${label} does not exist: ${resolved}`);
  const real = allowMissing ? realTarget(resolved) : realpathSync(resolved);
  if (!pathContains(rootReal, real)) fail("path_escape", `${label} escapes the experiment root: ${resolved} -> ${real}`);
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    fail("path_symlink", `${label} must not be a symlink: ${resolved}`);
  }
  if (regularFile && existsSync(real) && !statSync(real).isFile()) {
    fail("path_not_file", `${label} must be a regular file: ${real}`);
  }
  return real;
}

/**
 * 外部 pristine 夹具：必须是仓库外、非符号链接、非硬链接的普通文件；
 * 主库旁不得有未合并的活跃 WAL/SHM（那说明它仍是活动库，不是冷备快照）。
 * 可选的 declared sha/bytes 必须与文件一致。
 */
export function assertExternalFixture(path, { expectedSha256 = null, expectedBytes = null, label = "fixture" } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("fixture_not_absolute", `${label} path must be absolute: ${String(path)}`);
  }
  if (!existsSync(path)) fail("fixture_missing", `${label} does not exist: ${path}`);
  const linkStat = lstatSync(path);
  if (linkStat.isSymbolicLink()) fail("fixture_symlink", `${label} must not be a symlink: ${path}`);
  if (!linkStat.isFile()) fail("fixture_not_file", `${label} must be a regular file: ${path}`);
  if (linkStat.nlink > 1) fail("fixture_hardlink", `${label} must not be a hard link (nlink=${linkStat.nlink}): ${path}`);
  const real = realpathSync(path);
  const repoReal = realpathSync(REPO_ROOT);
  if (pathContains(repoReal, real)) fail("fixture_in_repo", `${label} must not be inside the repository: ${real}`);
  for (const sidecar of [`${real}-wal`]) {
    if (existsSync(sidecar) && statSync(sidecar).size > 0) {
      fail("fixture_active_wal", `${label} has a non-empty WAL; take a cold backup before copying: ${sidecar}`);
    }
  }
  const bytes = statSync(real).size;
  if (expectedBytes !== null && Number(expectedBytes) !== bytes) {
    fail("fixture_bytes_mismatch", `${label} bytes ${bytes} != declared ${expectedBytes}`);
  }
  const sha256 = sha256File(real);
  if (expectedSha256 !== null && expectedSha256 !== sha256) {
    fail("fixture_sha_mismatch", `${label} sha256 ${sha256} != declared ${expectedSha256}`);
  }
  return { path: real, bytes, sha256 };
}

/**
 * 夹具 manifest 的闭合校验：dataset 对齐、声明字节/哈希对齐、digest 存在。
 * 旧 manifest 没有 databaseSha256 时明确返回 `declaredSha256: null`（限制，
 * 不默认“已核验”）；新夹具生成器会写该字段。
 */
export function assertFixtureManifest(path, { dataset, fixturePath, fixtureSha256, fixtureBytes } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("fixture_manifest_not_absolute", `fixture manifest must be absolute: ${String(path)}`);
  if (!existsSync(path)) fail("fixture_manifest_missing", `fixture manifest missing: ${path}`);
  if (lstatSync(path).isSymbolicLink()) fail("fixture_manifest_symlink", `fixture manifest must not be a symlink: ${path}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("fixture_manifest_invalid", `fixture manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.dataset !== dataset) fail("fixture_dataset_mismatch", `fixture manifest dataset ${String(manifest.dataset)} != ${dataset}`);
  if (manifest.digest === undefined || manifest.rows === undefined) {
    fail("fixture_manifest_incomplete", "fixture manifest must declare digest and rows");
  }
  const declaredBytes = manifest.bytes?.database ?? null;
  const declaredSha256 = manifest.databaseSha256 ?? manifest.bytes?.databaseSha256 ?? null;
  if (declaredBytes !== null && Number(declaredBytes) !== fixtureBytes) {
    fail("fixture_manifest_bytes_mismatch", `fixture manifest database bytes ${declaredBytes} != ${fixtureBytes}`);
  }
  if (declaredSha256 !== null && declaredSha256 !== fixtureSha256) {
    fail("fixture_manifest_sha_mismatch", `fixture manifest database sha256 ${declaredSha256} != ${fixtureSha256}`);
  }
  return {
    path: realpathSync(path),
    sha256: sha256File(path),
    dataset: manifest.dataset,
    digest: manifest.digest,
    declaredSha256,
    declaredBytes
  };
}

/**
 * 载荷 manifest 的闭合校验：每个条目必须是登记过的普通文件，路径在 manifest
 * 所在目录（payload 根）之内，SHA 与声明一致。拒绝未登记的外部路径/路径逃逸。
 */
export function assertPayloadManifest(path, { requireContracts = false } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("payload_manifest_not_absolute", `payload manifest must be absolute: ${String(path)}`);
  if (!existsSync(path)) fail("payload_manifest_missing", `payload manifest missing: ${path}`);
  if (lstatSync(path).isSymbolicLink()) fail("payload_manifest_symlink", `payload manifest must not be a symlink: ${path}`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const declaredRoot = typeof manifest.payloadRoot === "string" && isAbsolute(manifest.payloadRoot)
    ? realTarget(manifest.payloadRoot) : realpathSync(dirname(path));
  const root = declaredRoot;
  if (!existsSync(root)) fail("payload_root_missing", `payload root does not exist: ${root}`);
  // 声明根必须落在夹具根（manifest 的上两级）内；不接受任意外部目录。
  const fixtureRoot = realTarget(join(dirname(path), "..", ".."));
  if (!pathContains(fixtureRoot, root)) {
    fail("payload_root_escape", `payload root escapes the fixture root ${fixtureRoot}: ${root}`);
  }
  const entries = Array.isArray(manifest.payloads) ? manifest.payloads : [];
  if (entries.length === 0) fail("payload_manifest_empty", "payload manifest declares no payloads");
  const checked = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry.path !== "string" || !isAbsolute(entry.path)) {
      fail("payload_path_not_absolute", `payload#${index} path must be absolute: ${String(entry.path)}`);
    }
    const real = realTarget(entry.path);
    if (!pathContains(root, real)) {
      fail("payload_path_escape", `payload#${index} escapes the payload root ${root}: ${entry.path}`);
    }
    if (!existsSync(entry.path)) fail("payload_missing", `payload#${index} missing: ${entry.path}`);
    if (lstatSync(entry.path).isSymbolicLink()) fail("payload_symlink", `payload#${index} must not be symlink: ${entry.path}`);
    if (lstatSync(entry.path).nlink > 1) fail("payload_hardlink", `payload#${index} must not be hard link: ${entry.path}`);
    if (!statSync(entry.path).isFile()) fail("payload_not_file", `payload#${index} must be a regular file: ${entry.path}`);
    const sha256 = sha256File(entry.path);
    if (entry.sha256 !== sha256) fail("payload_sha_mismatch", `payload#${index} sha256 mismatch: ${entry.path}`);
    if (requireContracts && (entry.contract === undefined || typeof entry.contract !== "object")) {
      fail("payload_contract_missing", `payload#${index} (${entry.label ?? entry.name ?? "?"}) has no structured contract`);
    }
    checked.push({ ...entry, path: real, sha256 });
  }
  return { path: realpathSync(path), sha256: sha256File(path), root, entries: checked };
}

/** 实验根内的隔离目录：TMPDIR/TMP/TEMP/HOME 都指向这里，不继承外部可写目录。 */
export function isolatedChildDirectories(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)) {
    fail("env_path_not_absolute", "runtime root must be absolute");
  }
  return {
    temp: join(runtimeRoot, "tmp"),
    home: join(runtimeRoot, "home"),
    cache: join(runtimeRoot, "home", ".cache"),
    npmCache: join(runtimeRoot, "home", ".npm")
  };
}


/** 主/控库必须是不同的普通文件、不能互为硬链接、且都在实验根内。 */
export function assertDistinctDatabaseFiles(rootReal, mainPath, controlPath) {
  const main = assertInsideRoot(rootReal, mainPath, { label: "main database", allowMissing: true });
  const control = assertInsideRoot(rootReal, controlPath, { label: "control database", allowMissing: true });
  if (main === control) fail("database_same_path", `main and control database resolve to the same path: ${main}`);
  if (existsSync(main) && existsSync(control)) {
    const a = statSync(main);
    const b = statSync(control);
    if (!a.isFile() || !b.isFile()) fail("database_not_file", "main and control databases must be regular files");
    if (a.nlink > 1 || b.nlink > 1) fail("database_hardlink", `database files must not be hard links: ${a.nlink}/${b.nlink}`);
    if (a.dev === b.dev && a.ino === b.ino) fail("database_same_inode", `main and control database are the same inode: ${main}`);
  }
  return { main, control };
}

/** 运行时派生路径：全部落在实验根内，逐一断言。 */
export function derivedRuntimePaths(rootReal) {
  const paths = {
    runtimeRoot: rootReal,
    var: join(rootReal, "var"),
    database: join(rootReal, "var", "rai.sqlite"),
    controlDatabase: join(rootReal, "var", "rai-control.sqlite"),
    imports: join(rootReal, "var", "imports"),
    backups: join(rootReal, "var", "backups"),
    modelArtifacts: join(rootReal, "var", "model-artifacts"),
    predictionArtifacts: join(rootReal, "var", "model-artifacts", "prediction"),
    runtimeState: join(rootReal, "var", "runtime.sqlite"),
    temp: join(rootReal, "tmp"),
    home: join(rootReal, "home"),
    cache: join(rootReal, "home", ".cache"),
    npmCache: join(rootReal, "home", ".npm"),
    results: join(rootReal, "results"),
    logs: join(rootReal, "logs")
  };
  for (const [label, path] of Object.entries(paths)) {
    assertInsideRoot(rootReal, path, { label, allowMissing: true });
  }
  return paths;
}

/** 允许透传的系统环境键；其余（尤其 RAI_*、代理、NODE_OPTIONS）一律不继承。 */
const PASSTHROUGH_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "WINDIR", "APPDATA", "LOCALAPPDATA", "ProgramData", "NUMBER_OF_PROCESSORS"
];

/** 继承键里必须显式清除的危险项（即使未来有人把它们加回白名单）。 */
const FORBIDDEN_INHERITED = [
  "RAI_DATABASE", "RAI_CONTROL_DATABASE", "RAI_RUNTIME_ROOT", "RAI_TRAINING_PLAN_COMMAND_MODE",
  "RAI_PHASE1_BENCH_RESET", "RAI_ROUTE_DUMP", "RAI_NOTIFY_SOCKET", "RAI_RUST_BINARY",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
  "NODE_OPTIONS", "NODE_PATH"
];

/**
 * 构造受测 API 的子进程环境：白名单 + 显式 RAI_* + 根内 TMPDIR/HOME。
 *
 * 不展开 process.env；TMPDIR/TMP/TEMP 与 HOME 一律指向实验根内的受控目录，
 * 调用方负责创建这些目录并逐一断言 realpath 在根内。
 *
 * @param {{
 *   runtimeRoot: string, database: string, controlDatabase: string,
 *   port: number|string, token: string, serverId?: string, athleteId?: string,
 *   datasetEpoch?: string, logLevel?: string, extras?: Record<string,string>
 * }} input
 * @returns {{ env: Record<string,string>, injectedKeys: string[], inheritedKeys: string[] }}
 */
export function buildServerEnvironment(input) {
  const { runtimeRoot, database, controlDatabase, port, token } = input;
  if (!isAbsolute(runtimeRoot) || !isAbsolute(database) || !isAbsolute(controlDatabase)) {
    fail("env_path_not_absolute", "runtime/database/control paths must be absolute");
  }
  if (typeof token !== "string" || token.length < 16) fail("token_weak", "API token must be at least 16 characters");
  const portValue = String(port);
  if (!/^\d+$/.test(portValue) || Number(portValue) < 0 || Number(portValue) > 65535) {
    fail("port_invalid", `invalid API port: ${portValue}`);
  }
  const isolated = isolatedChildDirectories(runtimeRoot);
  /** @type {Record<string,string>} */
  const env = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (FORBIDDEN_INHERITED.includes(key)) continue;
    if (["TMPDIR", "TEMP", "TMP", "HOME"].includes(key)) continue;
    const value = process.env[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  const injected = {
    RAI_RUNTIME_ROOT: runtimeRoot,
    RAI_DATABASE: database,
    RAI_CONTROL_DATABASE: controlDatabase,
    RAI_API_PORT: portValue,
    RAI_API_HOST: "127.0.0.1",
    RAI_API_TOKEN: token,
    RAI_SERVER_ID: input.serverId ?? "phase6",
    RAI_ATHLETE_ID: input.athleteId ?? "athlete_1",
    RAI_DATASET_EPOCH: input.datasetEpoch ?? "phase6",
    RAI_LOG_LEVEL: input.logLevel ?? "warn",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    TMPDIR: isolated.temp,
    TMP: isolated.temp,
    TEMP: isolated.temp,
    HOME: isolated.home,
    XDG_CACHE_HOME: isolated.cache,
    npm_config_cache: isolated.npmCache,
    ...(input.extras ?? {})
  };
  for (const [key, value] of Object.entries(injected)) {
    if (FORBIDDEN_INHERITED.includes(key) && !key.startsWith("RAI_")) {
      fail("env_forbidden_override", `refusing to inject forbidden environment key: ${key}`);
    }
    if (typeof value !== "string") fail("env_value_invalid", `environment value for ${key} must be a string`);
    env[key] = value;
  }
  return {
    env,
    injectedKeys: Object.keys(injected),
    inheritedKeys: Object.keys(env).filter((key) => !(key in injected)),
    isolated
  };
}

/**
 * driver/collector/重算子进程的隔离环境：与 API 同一套白名单与根内 TMPDIR/HOME，
 * 只额外带一个本 run 的随机 Token。`RAI_PHASE6_TOKEN` 不进命令行。
 */
export function buildChildEnvironment({ runtimeRoot, token = null, extras = {} } = {}) {
  if (!isAbsolute(runtimeRoot)) fail("env_path_not_absolute", "runtime root must be absolute");
  const isolated = isolatedChildDirectories(runtimeRoot);
  /** @type {Record<string,string>} */
  const env = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (FORBIDDEN_INHERITED.includes(key)) continue;
    if (["TMPDIR", "TEMP", "TMP", "HOME"].includes(key)) continue;
    const value = process.env[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  Object.assign(env, {
    TMPDIR: isolated.temp,
    TMP: isolated.temp,
    TEMP: isolated.temp,
    HOME: isolated.home,
    XDG_CACHE_HOME: isolated.cache,
    npm_config_cache: isolated.npmCache,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ...(token === null ? {} : { RAI_PHASE6_TOKEN: token }),
    ...extras
  });
  for (const key of FORBIDDEN_INHERITED) {
    if (!key.startsWith("RAI_") && key in env) delete env[key];
  }
  return { env, isolated };
}


/** 只接受 runner 自己启动的回环 API；拒绝公网、代理、凭据、路径与查询串。 */
export function assertLoopbackBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("url_invalid", `invalid API base URL: ${String(value)}`);
  }
  if (url.protocol !== "http:") fail("url_scheme", `only plain http loopback is allowed: ${url.protocol}`);
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    fail("url_not_loopback", `API target must be loopback, got ${url.hostname}`);
  }
  if (url.username || url.password) fail("url_credentials", "API URL must not embed credentials");
  if (url.pathname !== "/" && url.pathname !== "") fail("url_path", `API URL must not contain a path: ${url.pathname}`);
  if (url.search || url.hash) fail("url_query", "API URL must not contain a query or fragment");
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("url_port", `API URL must carry an explicit port: ${value}`);
  return url.origin;
}

/**
 * 清理目标校验：只允许带本次 runId 所有权标记的实验根。
 * 返回 realRoot；调用方随后才能 rm -rf（不带 glob、不带进程名）。
 */
export function assertOwnedCleanupTarget(rootArg, { runId, repoRoot } = {}) {
  const { root, realRoot } = assertSafeExperimentRoot(rootArg, { repoRoot, allowExisting: true });
  const marker = readRunMarker(root);
  if (marker === null) fail("cleanup_unowned", `refusing cleanup: ${root} has no ${RUN_MARKER}`);
  if (marker.owner !== "phase6") fail("cleanup_foreign_owner", `refusing cleanup: ${root} owner is ${String(marker.owner)}`);
  if (typeof runId === "string" && marker.runId !== runId) {
    fail("cleanup_run_mismatch", `refusing cleanup: marker run ${String(marker.runId)} != ${runId}`);
  }
  if (realRoot === sep || pathContains(realRoot, realpathSync(resolve(repoRoot ?? REPO_ROOT)))) {
    fail("cleanup_unsafe", `refusing cleanup of unsafe target: ${realRoot}`);
  }
  return { root, realRoot, marker };
}

/** 生成 runner 自用的随机 Token；只写入子进程环境，不写日志、不进 dry-run 输出。 */
export function generateRunToken() {
  return randomBytes(24).toString("hex");
}

/** 对文件做 SHA-256（用于源码/配置冻结清单）。 */
export function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

export function phase6ToolHashes(repoRoot = REPO_ROOT) {
  const directory = join(repoRoot, "scripts", "phase6");
  return Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith(".mjs")).sort()
    .map((name) => [`scripts/phase6/${name}`, sha256File(join(directory, name))]));
}

/** Freeze every API/package runtime source, including untracked source files. */
export function runtimeSourceHashes(repoRoot = REPO_ROOT) {
  const files = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:ts|tsx|mts|mjs|js|json)$/.test(entry.name)) files.push(path);
    }
  };
  visit(join(repoRoot, "apps", "api", "src"));
  const packages = join(repoRoot, "packages");
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      visit(join(packages, entry.name, "src"));
      const packageJson = join(packages, entry.name, "package.json");
      if (existsSync(packageJson)) files.push(packageJson);
    }
  }
  for (const path of [join(repoRoot, "package.json"), join(repoRoot, "apps", "api", "package.json")]) {
    if (existsSync(path)) files.push(path);
  }
  return Object.fromEntries(files.sort().map((path) => [relative(repoRoot, path).split(sep).join("/"), sha256File(path)]));
}

/**
 * 证据脱敏扫描：Token、Authorization 头、本机数据库绝对路径。
 * 返回命中项（不含原文），供 runner 在任何交付复制前失败关闭。
 */
export function scanForSecrets(text, { token, paths = [] } = {}) {
  const findings = [];
  if (typeof token === "string" && token.length >= 8 && text.includes(token)) {
    findings.push({ kind: "api_token", match: "token literal" });
  }
  const authPattern = /authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
  if (authPattern.test(text)) findings.push({ kind: "authorization_header", match: "Bearer ..." });
  for (const path of paths) {
    if (typeof path === "string" && path.length > 8 && text.includes(path)) {
      findings.push({ kind: "absolute_path", match: path });
    }
  }
  return findings;
}


