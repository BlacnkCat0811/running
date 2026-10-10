import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../apps/api/src/plan-digest.js";

/** Include untracked implementation/assertions: HEAD alone is not this candidate. */
export function coachReplaySourceIdentity() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
    "apps/api/src", "apps/api/test", "packages/api-contracts/src", "packages/contracts/src",
    "packages/storage-sqlite/src", "packages/application/src", "apps/ios/RAI", "apps/ios/tests", "scripts", "package.json"],
  { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  return {
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceTreeHash: digest([...new Set(paths)].sort().map(path => [path, digest(readFileSync(resolve(root, path), "utf8"))]))
  };
}
