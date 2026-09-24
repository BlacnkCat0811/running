#!/usr/bin/env node
/**
 * Repo-hygiene gate: no single tracked blob may exceed MAX_BLOB_BYTES.
 *
 * ## Why a byte ceiling instead of a `.gitignore` pattern
 *
 * The failure this guards against is concrete: six 4.4–4.8 MB design boards
 * entered the history, and cleaning them up required rewriting every commit
 * (see `apps/ios/design/technology-v1/README.md`, "仓库体积"). A pattern would
 * have to name a path — and that exact approach is what already failed once: the
 * same boards were cleaned out of one directory and then reappeared under a
 * *new* one. A byte ceiling is path-agnostic, so it survives reorganisation.
 *
 * ## Why not a blanket `*.png` ignore
 *
 * This repository legitimately tracks ~100 UI screenshots at 0.4–0.5 MB each
 * (`apps/ios/design/acceptance/…`). Ignoring the extension would make new
 * acceptance evidence vanish **silently**, which is worse than a large file: the
 * evidence is the point of those directories.
 *
 * ## Why the index and not HEAD
 *
 * `git ls-tree HEAD` describes the previous commit, which is one step too late —
 * the oversized blob would already exist. `git write-tree` reads the index, so a
 * blob staged right now is caught before the commit object exists.
 *
 * Run directly: `node scripts/check-blob-size.mjs`
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BLOB_BYTES = 1_500_000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });

const tree = git("write-tree").trim();
const entries = git("ls-tree", "-r", "-l", "-z", tree)
  .split("\0")
  .filter((line) => line.length > 0);

const oversized = [];
for (const entry of entries) {
  // `<mode> SP <type> SP <object> SP <size> TAB <path>`
  const tab = entry.indexOf("\t");
  if (tab === -1) continue;
  const size = Number(entry.slice(0, tab).split(/\s+/)[3]);
  if (!Number.isFinite(size)) continue; // "-" for submodules
  if (size > MAX_BLOB_BYTES) oversized.push({ path: entry.slice(tab + 1), size });
}

if (oversized.length > 0) {
  oversized.sort((a, b) => b.size - a.size);
  const mb = (bytes) => (bytes / 1_048_576).toFixed(2);
  process.stderr.write(
    `blob 体积闸门：${oversized.length} 个文件超过 ${mb(MAX_BLOB_BYTES)} MB\n` +
      oversized.map((file) => `  ${mb(file.size)} MB  ${file.path}`).join("\n") +
      "\n\n位图一旦进了历史就只能靠重写全部提交来清理" +
      "（见 apps/ios/design/technology-v1/README.md 的「仓库体积」）。\n" +
      `请改为引用仓库外的资源，或把文件压到 ${MAX_BLOB_BYTES} bytes 以下。\n`
  );
  process.exit(1);
}

process.stdout.write(
  `blob 体积闸门：${entries.length} 个已跟踪文件全部 ≤ ${MAX_BLOB_BYTES} bytes\n`
);
