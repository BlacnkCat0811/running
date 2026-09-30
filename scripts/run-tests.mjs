#!/usr/bin/env node
import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Explicit paths, not shell globs: identical test discovery on cmd and POSIX. */
export function nodeTestFiles(directory = root) {
  const packages = readdirSync(join(directory, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => join("packages", entry.name, "test"));
  const folders = [...packages, join("apps", "api", "test")];
  return folders.flatMap((folder) => existsSync(join(directory, folder))
    ? readdirSync(join(directory, folder), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => join(folder, entry.name)) : []).sort();
}

/** Both suites run after ordinary failures; signals/startup errors never pass. */
export function executeSuites(suites, spawn = spawnSync) {
  let failed = false;
  for (const suite of suites) {
    let result;
    try {
      result = spawn(process.execPath, suite.args, {
        cwd: suite.cwd, stdio: "inherit", shell: false, env: process.env
      });
    } catch (error) {
      console.error(`${suite.name} could not start: ${String(error)}`);
      failed = true;
      continue;
    }
    if (result.error) console.error(`${suite.name} could not start: ${String(result.error)}`);
    if (result.error || result.signal || result.status !== 0) failed = true;
    if (result.signal === "SIGINT" || result.signal === "SIGTERM") return result.signal === "SIGINT" ? 130 : 143;
  }
  return failed ? 1 : 0;
}

export function main() {
  const files = nodeTestFiles();
  if (!files.length) throw new Error("No Node test files found; refuse an empty green test run");
  const web = join(root, "apps", "web");
  const requireWeb = createRequire(join(web, "package.json"));
  const vitest = join(dirname(requireWeb.resolve("vitest/package.json")), "vitest.mjs");
  return executeSuites([
    { name: "Node", cwd: root, args: ["--import", "tsx", "--test", ...files] },
    { name: "Web", cwd: web, args: [vitest, "run"] }
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
