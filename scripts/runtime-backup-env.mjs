// Strict reader for the small, provable subset of systemd EnvironmentFile
// syntax used by the runtime cold-backup path.
//
// This module is shared by the read-only path checker and the service
// configuration resolver so a dry-run manifest cannot be produced from an env
// file that `--apply` would reject. It deliberately does not execute shell
// syntax: no `export`, no command substitution, no escapes, no quoting.
import { readFileSync } from "node:fs";

export const RUNTIME_BACKUP_ENV_KEYS = [
  "RAI_RUNTIME_ROOT",
  "RAI_DATABASE",
  "RAI_CONTROL_DATABASE"
];

const PATH_KEY_PATTERN = /RAI_(RUNTIME_ROOT|DATABASE|CONTROL_DATABASE)/;

function unsupported(key, detail) {
  return new Error(`unsupported ${key} ${detail} in EnvironmentFile`);
}

/**
 * Read only the three path variables this backup path accepts. Unknown keys
 * are ignored, but any malformed line that mentions one of the three path
 * variables is a hard error: silently ignoring it is how a backup ends up
 * pointing at a different database than the service.
 */
export function readRuntimeBackupEnvFile(path) {
  const values = new Map();
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.endsWith("\\")) {
      throw new Error("continued EnvironmentFile assignments are unsupported");
    }
    if (line.startsWith("export ")) {
      if (PATH_KEY_PATTERN.test(line)) {
        throw new Error("unsupported EnvironmentFile path assignment (export is not systemd syntax)");
      }
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) {
      if (PATH_KEY_PATTERN.test(line)) {
        throw new Error("unsupported EnvironmentFile path assignment");
      }
      continue;
    }
    const [, key, value] = match;
    if (!RUNTIME_BACKUP_ENV_KEYS.includes(key)) continue;
    if (values.has(key)) throw new Error(`duplicate ${key} in EnvironmentFile`);
    if (value === "" || /[\s'"]/.test(value)
        || (process.platform !== "win32" && value.includes("\\"))) {
      throw unsupported(key, "quoting, whitespace, or escapes");
    }
    values.set(key, value);
  }
  return values;
}
