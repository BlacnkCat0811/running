#!/usr/bin/env node
// 阶段 4（G4/T12，复核 R2/R3）：整 runtime 冷备的**路径闭包**检查。
//
// 背景（E1，2026-10-23）：`deploy/backup-runtime.sh` 只归档 `--runtime-root`，
// 但 `RAI_DATABASE` / `RAI_CONTROL_DATABASE` 都可以指到该目录之外。此时 tar
// 成功、sha256 成功、服务恢复成功，**归档里却没有主库或控制库** —— 一次
// “成功”的备份不能证明整套状态可恢复。脚本本身不读 deployment env，所以
// 这个检查必须是一个独立、可测试的入口，而不是藏在 tar 成功之后的假设里。
//
// 复核 R2/R3（2026-10-23）：
//   * 不再按 `<runtime>/var/rai.sqlite` 猜默认主库。API 的缺省是
//     `<projectRoot>/var/rai.sqlite`，与检查器无关；只有部署 env / 命令行
//     显式给出两个库路径才继续。缺一个就拒绝，而不是“按模板推断”。
//   * 对 `var/imports`、`var/model-artifacts/prediction`、`var/backups`、
//     `var/quarantine` 做**递归**扫描：任何符号链接
//     （含悬空链接）、不可读文件、FIFO/设备项都拒绝备份。tar 默认把链接归档为
//     链接；恢复后若目标不在归档内，`source.zip` 之类的权威来源证据就会变成
//     不可读的悬空链接，而 manifest 仍显示 complete。
//   * 权威文件写入 `inventory`：相对路径、类型、大小、SHA-256。归档后由
//     `scripts/verify-runtime-backup-archive.mjs` 逐项比对归档条目与摘要。
//
// 本脚本只读：解析 env 文件、stat/realpath/lstat、递归列举与流式哈希。
// 不打开主库写连接，不复制文件，不读取健康内容，不输出 Token。
//
// 用法：
//   node scripts/check-runtime-backup-paths.mjs --runtime-root /var/lib/rai \
//     (--deployment-env /etc/rai/rai.env | --database PATH --control-database PATH) \
//     [--out manifest.json] [--json] [--no-digests]
//
// 退出码：0 = 闭包完整；2 = 不完整/不可读/参数错误（拒绝备份）。
// `absent` 是合法事实（例如 epoch 侧车只在删库/恢复后出现），但主库缺失
// 会被判为 problem：那说明备份对象根本不是一套可用数据集。

import { createHash } from "node:crypto";
import {
  accessSync, constants, createReadStream, existsSync, lstatSync, readdirSync,
  readlinkSync, realpathSync, statSync, writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { readRuntimeBackupEnvFile } from "./runtime-backup-env.mjs";

const USAGE =
  "Usage: node scripts/check-runtime-backup-paths.mjs --runtime-root DIR "
  + "(--deployment-env FILE | --database PATH --control-database PATH) "
  + "[--out FILE] [--json] [--no-digests]";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    "deployment-env": { type: "string" },
    database: { type: "string" },
    "control-database": { type: "string" },
    out: { type: "string" },
    json: { type: "boolean", default: false },
    "no-digests": { type: "boolean", default: false },
    "configuration-source": { type: "string" },
    "service-env-file": { type: "string" },
    "database-source": { type: "string" },
    help: { type: "boolean", default: false }
  }
});

if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (!values["runtime-root"]) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
if (values["deployment-env"] && (values.database || values["control-database"])) {
  process.stderr.write("--deployment-env cannot be combined with explicit database paths\n");
  process.exit(2);
}

let envValues = new Map();
if (values["deployment-env"]) {
  try {
    envValues = readRuntimeBackupEnvFile(resolve(values["deployment-env"]));
  } catch (error) {
    process.stderr.write(
      `cannot read env file ${resolve(values["deployment-env"])}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

const problems = [];
const runtimeRoot = resolve(values["runtime-root"]);
const digests = !values["no-digests"];

/** realpath 到最终目标；路径尚不存在时，取最深的已存在祖先再拼回尾部。 */
function resolveFinalPath(path) {
  // Preserve filesystem order for configured paths: `path.resolve()` would
  // eliminate `link/..` lexically and could inspect a different file than the
  // API now opens (the API uses the same native identity rule).
  const absolute = isAbsolute(path) ? path : resolve(path);
  const suffix = [];
  let current = absolute;
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function relativePath(absolute) {
  return relative(runtimeRootFinal, absolute).split(sep).join("/");
}

async function sha256File(path) {
  const before = statSync(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = statSync(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("file changed while it was being hashed");
  }
  return { sha256: hash.digest("hex"), sizeBytes: after.size, modifiedAt: after.mtime.toISOString() };
}

/** 从 runtime 根到目标路径的每一级都必须是普通目录；返回第一个符号链接组件。 */
function firstSymlinkComponent(absolute) {
  // The runtime root can be addressed through an OS alias (`/var` ->
  // `/private/var` on macOS). Check both the lexical root and its final
  // realpath so a symlink such as `<runtime>/alias -> .` cannot hide from the
  // final-root-only comparison.
  for (const base of [runtimeRoot, runtimeRootFinal]) {
    const rel = relative(base, absolute);
    if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    let current = base;
    for (const component of rel.split(sep)) {
      current = join(current, component);
      try {
        if (lstatSync(current).isSymbolicLink()) return relative(base, current).split(sep).join("/");
      } catch {
        return null;
      }
    }
  }
  return null;
}

function classifyTreeRoot(path, label) {
  const linkedComponent = firstSymlinkComponent(path);
  if (linkedComponent !== null) {
    problems.push(`${label}: ancestor ${linkedComponent} is a symbolic link; authoritative trees must be plain directories`);
    return { status: "external" };
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent" };
    problems.push(`${label}: cannot stat: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "unreadable" };
  }
  if (stat.isSymbolicLink()) {
    let target = "?";
    try { target = readlinkSync(path); } catch { /* reported without target */ }
    problems.push(`${label}: is a symbolic link (-> ${target}); authoritative trees must be plain directories`);
    return { status: "external" };
  }
  if (!stat.isDirectory()) {
    problems.push(`${label}: is not a directory`);
    return { status: "unreadable" };
  }
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    problems.push(`${label}: is not readable: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "unreadable" };
  }
  return { status: "present" };
}

/**
 * 递归枚举一棵权威树。任何符号链接都拒绝 —— 不区分“根内/根外”：根内链接
 * 仍会让 manifest 的相对路径与实际归档条目脱节（tar 存链接，恢复后依赖
 * 同一条目集合恰好也在归档内），而这条依赖没有被任何摘要证明。
 */
async function walkTree(absoluteRoot, relRoot, entries) {
  const root = classifyTreeRoot(absoluteRoot, relRoot);
  if (root.status !== "present") return root;
  entries.push({
    path: relRoot,
    type: "directory",
    authoritative: true,
    sizeBytes: null,
    sha256: null,
    modifiedAt: lstatSync(absoluteRoot).mtime.toISOString()
  });
  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const directory = stack.pop();
    let children;
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      problems.push(`${relativePath(directory) || relRoot}: cannot read directory: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = join(directory, child.name);
      const rel = relativePath(absolute);
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch (error) {
        problems.push(`${rel}: cannot stat: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        let target = "?";
        try { target = readlinkSync(absolute); } catch { /* report without target */ }
        let dangling = false;
        try { statSync(absolute); } catch { dangling = true; }
        problems.push(
          `${rel}: symbolic link (-> ${target}${dangling ? ", dangling" : ""}) is not allowed in an authoritative tree`);
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({
          path: rel,
          type: "directory",
          authoritative: true,
          sizeBytes: null,
          sha256: null,
          modifiedAt: stat.mtime.toISOString()
        });
        stack.push(absolute);
        continue;
      }
      if (!stat.isFile()) {
        problems.push(`${rel}: unsupported file type in an authoritative tree (only regular files and directories are allowed)`);
        continue;
      }
      try {
        accessSync(absolute, constants.R_OK);
      } catch (error) {
        problems.push(`${rel}: exists but is not readable: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!digests) {
        entries.push({
          path: rel,
          type: "file",
          authoritative: true,
          sizeBytes: stat.size,
          sha256: null,
          digestSkipped: true,
          modifiedAt: stat.mtime.toISOString()
        });
        continue;
      }
      try {
        const digest = await sha256File(absolute);
        entries.push({
          path: rel,
          type: "file",
          authoritative: true,
          ...digest
        });
      } catch (error) {
        problems.push(`${rel}: cannot hash: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { status: "present" };
}

function explicitValue(cliValue, envKey) {
  if (cliValue !== undefined) return { value: cliValue, source: "command-line" };
  if (envValues.has(envKey)) return { value: envValues.get(envKey), source: "deployment-env" };
  return { value: null, source: null };
}

const runtimeRootFinal = (() => {
  try {
    return resolveFinalPath(runtimeRoot);
  } catch (error) {
    process.stderr.write(`runtime root cannot be resolved: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
})();

const envRuntimeRoot = envValues.get("RAI_RUNTIME_ROOT") ?? null;
if (values["deployment-env"] && envRuntimeRoot === null) {
  problems.push(
    "RAI_RUNTIME_ROOT is not explicitly configured in --deployment-env. "
    + "The API default is <projectRoot>, not <runtimeRoot>; refusing to guess the runtime boundary.");
} else if (envRuntimeRoot !== null) {
  if (!isAbsolute(envRuntimeRoot)) {
    problems.push(`RAI_RUNTIME_ROOT must be an absolute path; got ${JSON.stringify(envRuntimeRoot)}.`);
  } else {
    let envRuntimeFinal = null;
    try { envRuntimeFinal = resolveFinalPath(envRuntimeRoot); } catch { /* reported below */ }
    if (envRuntimeFinal === null || envRuntimeFinal !== runtimeRootFinal) {
      problems.push(
        `RAI_RUNTIME_ROOT=${JSON.stringify(envRuntimeRoot)} does not match --runtime-root ${JSON.stringify(runtimeRoot)}`);
    }
  }
}

const mainSetting = explicitValue(values.database, "RAI_DATABASE");
const controlSetting = explicitValue(values["control-database"], "RAI_CONTROL_DATABASE");
// When the backup script resolved the paths from the service environment, the
// values arrive as explicit --database/--control-database arguments. Keep the
// manifest provenance honest: the source is the service env, not an ad-hoc CLI
// override.
if (values["database-source"]) {
  mainSetting.source = values["database-source"];
  controlSetting.source = values["database-source"];
}
for (const [key, setting] of [["RAI_DATABASE", mainSetting], ["RAI_CONTROL_DATABASE", controlSetting]]) {
  if (setting.value === null) {
    problems.push(
      `${key} is not explicitly configured: pass ${key === "RAI_DATABASE" ? "--database" : "--control-database"} `
      + `or set ${key} in --deployment-env. Implicit defaults are refused because the API's default is `
      + "<projectRoot>/var/rai.sqlite, not <runtimeRoot>/var/rai.sqlite.");
  } else if (!isAbsolute(setting.value)) {
    problems.push(`${key} must be an absolute path; got ${JSON.stringify(setting.value)}. `
      + "The checker cannot reproduce the service working directory.");
  }
}

/**
 * SQLite 存储本身必须是普通文件：不接受配置路径是符号链接，也不接受它经由
 * runtime 根内的某一级符号链接解析到别处。`resolved` 与“配置路径相对 runtime
 * 根”的相对路径必须一致；不一致说明中间有链接（根别名已在 runtimeRootFinal 归一）。
 */
function classifyStore(name, configured, { required = false } = {}) {
  const absolute = isAbsolute(configured) ? configured : resolve(configured);
  const record = { configured, resolved: null, relativePath: null, status: "unreadable", required, source: null };
  const linkedComponent = firstSymlinkComponent(absolute);
  if (linkedComponent !== null) {
    problems.push(`${name} (${absolute}): path contains symbolic link ${linkedComponent}; `
      + "authoritative SQLite files must not be reached through links");
    record.status = "external";
    return record;
  }
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      problems.push(`${name} (${absolute}): cannot stat: ${error instanceof Error ? error.message : String(error)}`);
      return record;
    }
    stat = null;
  }
  if (stat?.isSymbolicLink()) {
    let target = "?";
    try { target = readlinkSync(absolute); } catch { /* report without target */ }
    problems.push(`${name} (${absolute}): is a symbolic link (-> ${target}); authoritative SQLite files must be plain files`);
    return record;
  }
  let finalPath;
  try {
    finalPath = resolveFinalPath(absolute);
  } catch (error) {
    problems.push(`${name}: cannot resolve ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
    return record;
  }
  record.resolved = finalPath;
  if (!isInside(runtimeRootFinal, finalPath)) {
    problems.push(`${name} (${absolute}) resolves outside the runtime root ${runtimeRootFinal}`);
    record.status = "external";
    return record;
  }
  record.relativePath = relativePath(finalPath);
  // 配置路径必须能由 runtime 根的两种拼写（词法根 / realpath 根）之一直接
  // 推出；最终解析结果若偏离该相对位置，说明中间有符号链接（例如
  // var/link -> var），tar 会把链接与目标分条归档，manifest 的相对路径无法
  // 证明恢复后仍可读。根的自身别名（/var -> /private/var）不算链接。
  // 找到配置路径中“realpath 恰好等于 runtime 根”的那个前缀；即使根本身
  // 是通过 /var -> /private/var 之类的别名拼出来的，也能确定根边界。
  const findConfiguredRelative = () => {
    const suffix = [];
    let current = absolute;
    for (;;) {
      try {
        if (realpathSync.native(current) === runtimeRootFinal) {
          return suffix.join("/");
        }
      } catch (error) {
        if (error?.code !== "ENOENT") return null;
      }
      const parent = dirname(current);
      if (parent === current) return null;
      suffix.unshift(basename(current));
      current = parent;
    }
  };
  const configuredRelative = findConfiguredRelative();
  if (configuredRelative === null) {
    problems.push(`${name} (${absolute}) is not under runtime root ${runtimeRootFinal}`);
    record.status = "external";
    return record;
  }
  if (configuredRelative !== record.relativePath) {
    problems.push(
      `${name} (${absolute}) resolves through a symbolic link to ${record.relativePath}; `
      + "authoritative SQLite files must not be reached through links");
    record.status = "external";
    return record;
  }
  if (!existsSync(finalPath)) {
    if (required) problems.push(`${name} (${absolute}) is missing`);
    record.status = "absent";
    return record;
  }
  try {
    const finalStat = statSync(finalPath);
    if (!finalStat.isFile()) {
      problems.push(`${name} (${absolute}) is not a regular file`);
      record.status = "unreadable";
      return record;
    }
    accessSync(finalPath, constants.R_OK);
    record.status = "present";
    record.kind = "file";
    record.sizeBytes = finalStat.size;
    record.modifiedAt = finalStat.mtime.toISOString();
  } catch (error) {
    problems.push(`${name} (${absolute}) exists but is not readable: ${error instanceof Error ? error.message : String(error)}`);
    record.status = "unreadable";
  }
  return record;
}

/** 侧车（-wal/-shm）同样不得是链接。返回存在性与大小。 */
function sidecar(store, suffix) {
  const path = `${store.resolved}${suffix}`;
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    problems.push(`${store.relativePath}${suffix}: cannot stat: ${error instanceof Error ? error.message : String(error)}`);
    return { present: false, rejected: true };
  }
  if (stat.isSymbolicLink()) {
    problems.push(`${store.relativePath}${suffix}: symbolic link is not allowed for an authoritative sidecar`);
    return { present: false, rejected: true };
  }
  if (!stat.isFile()) {
    problems.push(`${store.relativePath}${suffix}: authoritative sidecar is not a regular file`);
    return { present: false, rejected: true };
  }
  try {
    accessSync(path, constants.R_OK);
    return { present: true, bytes: statSync(path).size };
  } catch (error) {
    problems.push(`${store.relativePath}${suffix}: exists but is not readable: ${error instanceof Error ? error.message : String(error)}`);
    return { present: false, rejected: true };
  }
}

const stores = {};
for (const [name, setting, required] of [
  ["main", mainSetting, true],
  ["control", controlSetting, true],
  ["runtime", { value: join(runtimeRootFinal, "var/runtime.sqlite"), source: "runtime-root" }, true]
]) {
  if (setting.value === null) {
    stores[name] = { configured: null, resolved: null, status: "unconfigured", required, source: null };
    continue;
  }
  stores[name] = classifyStore(name, setting.value, { required });
  stores[name].source = setting.source;
}
stores.epochSidecar = mainSetting.value === null
  ? { configured: null, resolved: null, status: "unconfigured", required: false }
  : classifyStore("epochSidecar", `${mainSetting.value}.dataset-epoch.sqlite`);
stores.restoreJournal = mainSetting.value === null
  ? { configured: null, resolved: null, status: "unconfigured", required: false }
  : classifyStore("restoreJournal", `${mainSetting.value}.restore-journal.sqlite`);

if (mainSetting.value !== null && controlSetting.value !== null
    && resolve(mainSetting.value) === resolve(controlSetting.value)) {
  problems.push("RAI_CONTROL_DATABASE must differ from RAI_DATABASE");
}
if (stores.main.resolved !== null && stores.control.resolved !== null
    && stores.main.resolved === stores.control.resolved) {
  problems.push("RAI_CONTROL_DATABASE resolves to the same physical file as RAI_DATABASE");
}

const inventory = [];
const treeEntries = [];
for (const tree of [
  "var/imports",
  "var/model-artifacts/prediction",
  "var/backups",
  "var/quarantine"
]) {
  const absolute = join(runtimeRootFinal, tree);
  const result = await walkTree(absolute, tree, inventory);
  treeEntries.push({ path: tree, status: result.status });
}
for (const [name, store] of Object.entries(stores)) {
  if (store.status !== "present") continue;
  let digest = null;
  if (digests) {
    try {
      digest = await sha256File(store.resolved);
      store.sizeBytes = digest.sizeBytes;
      store.modifiedAt = digest.modifiedAt;
    } catch (error) {
      problems.push(`${name}: cannot hash ${store.resolved}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (digest !== null) store.sha256 = digest.sha256;
  inventory.push({
    path: store.relativePath,
    type: "file",
    authoritative: true,
    role: `store:${name}`,
    sizeBytes: store.sizeBytes,
    sha256: digest?.sha256 ?? null,
    ...(digest === null ? { digestSkipped: digests === false } : {})
  });
  store.wal = sidecar(store, "-wal");
  store.shm = sidecar(store, "-shm");
  store.journal = sidecar(store, "-journal");
  store.walPresent = store.wal.present;
  store.shmPresent = store.shm.present;
  store.journalPresent = store.journal.present;
  if (store.wal.present) store.walBytes = store.wal.bytes;
  if (store.shm.present) store.shmBytes = store.shm.bytes;
  if (store.journal.present) store.journalBytes = store.journal.bytes;
}

// 侧车文件也进入权威清单（存在时）；归档后必须逐项可读。
for (const [name, store] of Object.entries(stores)) {
  if (store.status !== "present") continue;
  for (const [suffix, flag] of [["-wal", store.wal], ["-shm", store.shm], ["-journal", store.journal]]) {
    if (!flag.present) continue;
    const path = `${store.resolved}${suffix}`;
    let digest = null;
    if (digests) {
      try {
        digest = await sha256File(path);
      } catch (error) {
        problems.push(`${store.relativePath}${suffix}: cannot hash: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    inventory.push({
      path: `${store.relativePath}${suffix}`,
      type: "file",
      authoritative: true,
      role: `store:${name}${suffix}`,
      sizeBytes: digest?.sizeBytes ?? null,
      sha256: digest?.sha256 ?? null,
      ...(digest === null ? { digestSkipped: digests === false } : {})
    });
  }
}

inventory.sort((left, right) => left.path.localeCompare(right.path));

const manifest = {
  format: "rai-runtime-path-manifest-v2",
  generatedAt: new Date().toISOString(),
  runtimeRoot: runtimeRootFinal,
  configuredRuntimeRoot: runtimeRoot,
  envFile: values["deployment-env"] ? resolve(values["deployment-env"])
    : values["service-env-file"] ? realpathSync.native(values["service-env-file"]) : null,
  serviceConfiguration: values["configuration-source"] ? {
    source: values["configuration-source"],
    envFile: values["service-env-file"] ? realpathSync.native(values["service-env-file"]) : null,
    normalizedPaths: {
      runtime: runtimeRootFinal,
      main: stores.main.resolved,
      control: stores.control.resolved
    }
  } : null,
  databaseSources: { main: mainSetting.source, control: controlSetting.source },
  stores,
  artifacts: Object.fromEntries(treeEntries.map((entry) => [entry.path, { status: entry.status }])),
  inventory: {
    trees: treeEntries,
    entries: inventory,
    fileCount: inventory.filter((entry) => entry.type === "file").length,
    directoryCount: inventory.filter((entry) => entry.type === "directory").length,
    totalBytes: inventory.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    digestsIncluded: digests
  },
  closure: problems.length === 0 ? "complete" : "incomplete",
  problems
};

if (values.out) writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

if (values.json) {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} else {
  const summary = Object.entries(stores)
    .map(([name, store]) => `${name}=${store.status}`)
    .join(" ");
  process.stdout.write(
    `path-closure: ${manifest.closure} (${summary}; files=${manifest.inventory.fileCount})\n`);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`path-closure: ${problem}\n`);
  }
}
process.exitCode = problems.length === 0 ? 0 : 2;
