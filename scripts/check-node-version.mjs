import { pathToFileURL } from "node:url";

const MINIMUM_MINOR = 12;

export function isSupportedNodeVersion(version) {
  // npm's `>=22.12.0 <23` engine range excludes prereleases unless the
  // comparator explicitly opts into them. Keep this lightweight gate aligned.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 22 && minor >= MINIMUM_MINOR;
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  if (isSupportedNodeVersion(version)) return;
  throw new Error(
    `Unsupported Node.js ${version}. RAI requires Node.js >=22.12.0 <23 (Node 22 LTS).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
