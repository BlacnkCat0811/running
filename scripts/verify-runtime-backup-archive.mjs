#!/usr/bin/env node
// 阶段 4（G4/T12，复核 R2）：冷备归档的**语义闭包**校验。
//
// `tar -tf` 成功、整包 SHA-256 成功都只证明“字节被复制了”，不能证明归档
// 里每一份 manifest 标记为 present 的权威文件在恢复后仍存在、类型正确、内容
// 一致。这个脚本在 backup-runtime.sh 发布最终归档之前运行：
//
//   1. 拒绝 manifest 不完整（closure !== complete）；
//   2. 完整解析 tar header，拒绝危险名称、重复项、链接和特殊类型；
//   3. 解包到临时目录，逐项比对 manifest inventory 的：
//        - 路径存在性、类型（file/directory，符号链接一律不算 file）；
//        - 文件大小与 SHA-256（`--no-digests` 生成的 manifest 只比大小）；
//   4. 对所有权威树（包括 absent）比对路径/类型集合（多/少都失败）；
//   5. 重扫源根（`--source-root`），确认归档窗口结束后没有新增/删改；
//      归档过程中被改写的文件会因“归档字节 ≠ manifest 摘要”而失败。
//
// 恢复演练对解包后的根再跑一次同样的清单校验（`--source-root` 指向恢复根）。
//
// 用法：
//   node scripts/verify-runtime-backup-archive.mjs \
//     --archive runtime.tar --manifest path-manifest.json --source-root /var/lib/rai \
//     [--json] [--keep-extract]
//
// 退出码：0 = 通过；1 = 任一不一致（拒绝发布归档）。

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { inspectRuntimeTar, extractRuntimeTar } from "./runtime-tar-safe.mjs";

const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    manifest: { type: "string" },
    "source-root": { type: "string" },
    "extract-root": { type: "string" },
    json: { type: "boolean", default: false },
    "keep-extract": { type: "boolean", default: false },
    tar: { type: "string" }
  }
});

if (!values.archive || !values.manifest) {
  process.stderr.write(
    "Usage: node scripts/verify-runtime-backup-archive.mjs --archive runtime.tar --manifest path-manifest.json "
    + "[--source-root DIR] [--extract-root DIR] [--json] [--keep-extract]\n");
  process.exit(1);
}

const problems = [];
const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  if (!ok) problems.push(`${name}: ${detail}`);
};

function hashFile(path) {
  const hash = createHash("sha256");
  return new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

const manifestPath = resolve(values.manifest);
const archivePath = resolve(values.archive);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  process.stderr.write(`cannot read manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
if (manifest?.format !== "rai-runtime-path-manifest-v2") {
  process.stderr.write(
    `unsupported manifest format ${JSON.stringify(manifest?.format)}; expected rai-runtime-path-manifest-v2\n`);
  process.exit(1);
}
record("manifest:closure", manifest.closure === "complete",
  `closure is ${JSON.stringify(manifest.closure)}`);
const entries = Array.isArray(manifest.inventory?.entries) ? manifest.inventory.entries : [];
record("manifest:inventory", entries.length > 0, "manifest has no authoritative inventory");
record("manifest:digests", manifest.inventory?.digestsIncluded === true,
  "manifest was produced with --no-digests; archive content cannot be proven");

function canonicalRelative(path) {
  return typeof path === "string" && path !== "" && !isAbsolute(path)
    && !/^[A-Za-z]:/.test(path) && !/[\\\0\r\n]/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
const treeRecords = manifest.inventory?.trees;
const expectedTrees = ["var/imports", "var/model-artifacts/prediction", "var/backups", "var/quarantine"];
record("manifest:trees", Array.isArray(treeRecords) && treeRecords.length === expectedTrees.length
  && expectedTrees.every((path) => treeRecords.some((tree) => tree.path === path
    && ["present", "absent"].includes(tree.status))), "missing or unsupported authoritative tree");
const manifestPaths = new Set();
for (const entry of entries) {
  if (!canonicalRelative(entry.path) || !["file", "directory"].includes(entry.type)
      || manifestPaths.has(entry.path) || entry.authoritative !== true
      || (entry.type === "file" && (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0
        || !/^[a-f0-9]{64}$/.test(entry.sha256)))) {
    record(`manifest:unsafe:${String(entry.path)}`, false, "invalid or duplicate inventory path/type/digest");
  }
  manifestPaths.add(entry.path);
}

// Parse the archive with the restricted parser *before* invoking any host
// extractor. The parser is the authority for names, types and sizes; if it
// rejects the archive, no host tar command is executed.
let members = [];
const normalized = new Set();
if (problems.length === 0) {
  try {
    members = inspectRuntimeTar(archivePath);
    for (const member of members) normalized.add(member.name);
    record("archive:headers", normalized.size > 0, "archive has no validated members");
  } catch (error) {
    record("archive:headers", false, error instanceof Error ? error.message : String(error));
  }
}
record("archive:entries", normalized.size > 0, "archive is empty");

if (problems.length === 0) {
const extractBase = values["extract-root"] ? resolve(values["extract-root"]) : tmpdir();
const extractRoot = mkdtempSync(join(extractBase, "rai-archive-verify-"));
try {
  extractRuntimeTar(archivePath, members, extractRoot);
  record("archive:extract", true, "restricted file/directory extraction succeeded");

  const walk = (absolute, rel, files, directories, links) => {
    let entriesInDirectory;
    try {
      entriesInDirectory = readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      record(`restore:read:${rel}`, false, error instanceof Error ? error.message : String(error));
      return;
    }
    for (const child of entriesInDirectory) {
      const childAbs = join(absolute, child.name);
      const childRel = rel === "" ? child.name : `${rel}/${child.name}`;
      const stat = lstatSync(childAbs);
      if (stat.isSymbolicLink()) {
        links.add(childRel);
      } else if (stat.isDirectory()) {
        directories.add(childRel);
        walk(childAbs, childRel, files, directories, links);
      } else if (stat.isFile()) {
        files.add(childRel);
      } else {
        record(`restore:type:${childRel}`, false, "unsupported file type in archive");
      }
    }
  };
  const files = new Set();
  const directories = new Set();
  const links = new Set();
  walk(extractRoot, "", files, directories, links);

  const normalizedEntries = entries.slice().sort((left, right) => left.path.localeCompare(right.path));
  const entryPaths = new Set(normalizedEntries.map((entry) => entry.path));

  // `inventory.entries` only contains present files. The manifest's `stores`
  // block also records absent optional sidecars (epoch/journal and WAL/SHM), so
  // a file that appears between manifest generation and tar must be rejected
  // explicitly. Without this check, a late WAL or restore journal is just an
  // extra file outside the five trees and the archive would look complete.
  const expectedStoreNames = ["main", "control", "runtime", "epochSidecar", "restoreJournal"];
  const requiredStoreNames = new Set(["main", "control", "runtime"]);
  const stores = manifest.stores;
  record("manifest:problems", Array.isArray(manifest.problems) && manifest.problems.length === 0,
    "manifest.problems must be an empty array");
  const storePaths = stores !== null && typeof stores === "object"
    ? expectedStoreNames.map((name) => stores[name]?.relativePath).filter((path) => typeof path === "string")
    : [];
  record("manifest:stores", stores !== null && typeof stores === "object"
    && Object.keys(stores).length === expectedStoreNames.length
    && expectedStoreNames.every((name) => stores[name] && ["present", "absent"].includes(stores[name].status)
      && canonicalRelative(stores[name].relativePath)
      && (!requiredStoreNames.has(name) || stores[name].status === "present"))
    && new Set(storePaths).size === storePaths.length,
  "manifest.stores is missing, has an unsupported/required-absent store, or has duplicate relative paths");
  const storePresence = [];
  const seenStorePaths = new Set();
  const addStorePresence = (relative, name, present) => {
    if (seenStorePaths.has(relative)) {
      record(`manifest:store:${name}:duplicate`, false, `duplicate store path ${relative}`);
      return;
    }
    seenStorePaths.add(relative);
    storePresence.push({ relative, name, present });
  };
  if (stores !== null && typeof stores === "object") {
    for (const name of expectedStoreNames) {
      const store = stores[name];
      if (!store || !canonicalRelative(store.relativePath)) continue;
      const relative = store.relativePath;
      if (store.status === "present") {
        const entry = normalizedEntries.find((candidate) => candidate.path === relative && candidate.type === "file");
        record(`manifest:store:${name}`, entry?.role === `store:${name}`,
          "present store has no inventory entry with its store role");
        for (const suffix of ["wal", "shm", "journal"]) {
          const flagName = `${suffix}Present`;
          // v2 manifests produced before the journal-sidecar fix did not have
          // journalPresent. Treat the missing field as "no journal recorded";
          // a real late journal is still rejected by the presence check.
          const journalLegacy = suffix === "journal" && store[flagName] === undefined;
          const expectedSidecar = journalLegacy ? false : store[flagName] === true;
          if (!journalLegacy && typeof store[flagName] !== "boolean") {
            record(`manifest:store:${name}:${suffix}`, false, `${flagName} must be a boolean`);
          }
          const sidecarEntry = normalizedEntries.find((candidate) =>
            candidate.path === `${relative}-${suffix}` && candidate.type === "file");
          record(`manifest:store:${name}:${suffix}-inventory`,
            expectedSidecar === (sidecarEntry !== undefined),
            `${flagName} disagrees with inventory`);
          if (sidecarEntry !== undefined && sidecarEntry.role !== `store:${name}-${suffix}`) {
            record(`manifest:store:${name}:${suffix}-role`, false,
              `inventory entry for ${relative}-${suffix} has the wrong role`);
          }
          addStorePresence(`${relative}-${suffix}`, `${name}-${suffix}`, expectedSidecar);
        }
        addStorePresence(relative, name, true);
      } else if (store.status === "absent") {
        if (store.walPresent === true || store.shmPresent === true || store.journalPresent === true) {
          record(`manifest:store:${name}:sidecars`, false, "an absent store cannot record present sidecars");
        }
        const unexpected = normalizedEntries.filter((entry) => entry.path === relative
          || entry.path === `${relative}-wal` || entry.path === `${relative}-shm` || entry.path === `${relative}-journal`);
        if (unexpected.length > 0) {
          record(`manifest:store:${name}:inventory`, false, "an absent store has inventory or sidecar entries");
        }
        addStorePresence(relative, name, false);
        addStorePresence(`${relative}-wal`, `${name}-wal`, false);
        addStorePresence(`${relative}-shm`, `${name}-shm`, false);
        addStorePresence(`${relative}-journal`, `${name}-journal`, false);
      } else {
        record(`manifest:store:${name}`, false, `unsupported store status ${JSON.stringify(store.status)}`);
      }
    }
  }
  const checkStorePresence = (root, label) => {
    for (const expected of storePresence) {
      const relative = expected.relative;
      let stat;
      try {
        stat = lstatSync(join(root, relative));
      } catch (error) {
        if (error?.code === "ENOENT") {
          record(`${label}:store:${expected.name}`, !expected.present,
            expected.present ? "expected present, found absent" : "absent");
          continue;
        }
        record(`${label}:store:${expected.name}`, false,
          error instanceof Error ? error.message : String(error));
        continue;
      }
      const type = stat.isDirectory() ? "directory"
        : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "special";
      record(`${label}:store:${expected.name}`, expected.present ? type === "file" : false,
        expected.present ? `expected file, got ${type}` : `expected absent, got ${type}`);
    }
  };
  checkStorePresence(extractRoot, "archive");
  for (const link of links) {
    // 权威树内的链接已经由检查器拒绝；这里再拦截一次，防止旧 manifest 或
    // 手工修改把链接带进归档。树外的链接不参与权威闭包，但记录数量。
    if (entryPaths.has(link) || [...entryPaths].some((path) => link.startsWith(`${path}/`))) {
      record(`restore:symlink:${link}`, false, "authoritative path is a symbolic link after extraction");
    }
  }
  record("archive:symlinks", true,
    links.size === 0 ? "none" : `${links.size} non-authoritative symlink(s) outside the authoritative inventory`);

  for (const entry of normalizedEntries) {
    const target = join(extractRoot, entry.path);
    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      record(`restore:missing:${entry.path}`, false, "manifest entry is missing from the archive");
      continue;
    }
    if (entry.type === "directory") {
      record(`restore:type:${entry.path}`, stat.isDirectory(), "expected a directory");
      continue;
    }
    if (entry.type !== "file") {
      record(`restore:type:${entry.path}`, false, `unknown manifest type ${JSON.stringify(entry.type)}`);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      record(`restore:type:${entry.path}`, false, "expected a regular file");
      continue;
    }
    if (typeof entry.sizeBytes === "number" && stat.size !== entry.sizeBytes) {
      record(`restore:size:${entry.path}`, false, `expected ${entry.sizeBytes} bytes, got ${stat.size}`);
      continue;
    }
    if (typeof entry.sha256 === "string") {
      try {
        const digest = await hashFile(target);
        record(`restore:sha256:${entry.path}`, digest === entry.sha256,
          digest === entry.sha256 ? "match" : `expected ${entry.sha256}, got ${digest}`);
      } catch (error) {
        record(`restore:sha256:${entry.path}`, false, error instanceof Error ? error.message : String(error));
      }
    }
  }

  // Re-scan every tree, including roots recorded as absent. lstat detects a
  // newly created dangling link that existsSync would silently miss.
  const checkedParents = new Set();
  const checkParents = (root, path, label) => {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      const checkKey = `${label}:${parent}`;
      if (checkedParents.has(checkKey)) continue;
      let stat;
      try { stat = lstatSync(join(root, parent)); }
      catch (error) {
        if (error?.code !== "ENOENT") record(`${label}:parent:${parent}`, false, String(error));
        continue;
      }
      checkedParents.add(checkKey);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        record(`${label}:parent:${parent}`, false, `authoritative parent is not a plain directory for ${path}`);
      }
    }
  };
  const scanTrees = (root, label) => {
    for (const tree of treeRecords) {
      checkParents(root, tree.path, label);
      const known = new Map(normalizedEntries
        .filter((entry) => entry.path === tree.path || entry.path.startsWith(`${tree.path}/`))
        .map((entry) => [entry.path, entry.type]));
      const seen = new Set();
      const visit = (path) => {
        let stat;
        try { stat = lstatSync(join(root, path)); }
        catch (error) {
          if (error?.code !== "ENOENT") record(`${label}:read:${path}`, false, String(error));
          return;
        }
        seen.add(path);
        const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file"
          : stat.isSymbolicLink() ? "symlink" : "special";
        record(`${label}:tree:${path}`, known.get(path) === type,
          `expected ${known.get(path) ?? "absent"}, got ${type}`);
        if (type === "directory") {
          try {
            for (const child of readdirSync(join(root, path))) visit(`${path}/${child}`);
          } catch (error) { record(`${label}:read:${path}`, false, String(error)); }
        }
      };
      if (tree.status === "absent") {
        visit(tree.path); // Any newly created root, including a link, is extra.
      } else {
        visit(tree.path);
        for (const path of known.keys()) {
          if (!seen.has(path)) record(`${label}:missing:${path}`, false, "authoritative tree entry disappeared");
        }
      }
    }
  };
  scanTrees(extractRoot, "archive");
  // 归档条目（归一化）与磁盘解包结果互相覆盖：防止解包失败时中间态被当成通过。
  for (const name of normalized) {
    const present = files.has(name) || directories.has(name) || links.has(name);
    record(`archive:member:${name}`, present, "archive member was not extracted");
  }

  if (values["source-root"]) {
    const sourceRoot = resolve(values["source-root"]);
    scanTrees(sourceRoot, "source");
    checkStorePresence(sourceRoot, "source");
    const sourceChecks = normalizedEntries.filter((entry) => entry.type === "file" || entry.type === "directory");
    for (const entry of sourceChecks) {
      checkParents(sourceRoot, entry.path, "source");
      const sourcePath = join(sourceRoot, entry.path);
      if (!existsSync(sourcePath)) {
        record(`source:missing:${entry.path}`, false, "source entry disappeared after the archive window");
        continue;
      }
      const stat = lstatSync(sourcePath);
      if (entry.type === "directory") {
        record(`source:type:${entry.path}`, stat.isDirectory(), "expected a source directory");
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        record(`source:type:${entry.path}`, false, "source entry is no longer a regular file");
        continue;
      }
      if (typeof entry.sizeBytes === "number" && stat.size !== entry.sizeBytes) {
        record(`source:size:${entry.path}`, false,
          `source changed after the archive window: expected ${entry.sizeBytes} bytes, got ${stat.size}`);
        continue;
      }
      if (typeof entry.sha256 === "string") {
        try {
          const digest = await hashFile(sourcePath);
          record(`source:sha256:${entry.path}`, digest === entry.sha256,
            digest === entry.sha256 ? "match" : "source changed after the archive window");
        } catch (error) {
          record(`source:sha256:${entry.path}`, false, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }
} finally {
  if (!values["keep-extract"]) rmSync(extractRoot, { recursive: true, force: true });
  else process.stderr.write(`kept verification extraction: ${extractRoot}\n`);
}
}

const result = {
  format: "rai-runtime-archive-verification-v1",
  at: new Date().toISOString(),
  archive: archivePath,
  manifest: manifestPath,
  sourceRoot: values["source-root"] ? resolve(values["source-root"]) : null,
  archiveEntries: normalized.size,
  checks,
  problems,
  passed: problems.length === 0
};
if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  const summary = `${checks.filter((check) => check.ok).length}/${checks.length} checks`;
  process.stdout.write(`archive-closure: ${result.passed ? "complete" : "incomplete"} (${summary})\n`);
  for (const problem of problems) process.stderr.write(`archive-closure: ${problem}\n`);
}
process.exitCode = result.passed ? 0 : 1;
