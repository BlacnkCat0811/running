#!/usr/bin/env node
// Verify that the paths the backup is about to archive match the environment of
// the *running* service process, not just the current EnvironmentFile contents.
//
// `systemctl show EnvironmentFiles` names a file, but systemd reads that file
// only when the unit starts. Editing the file without restarting the service
// can make a backup look complete while it archives a different database than
// the one the running process is using. On Linux, /proc/<MainPID>/environ is
// the authoritative view.
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    pid: { type: "string" },
    runtime: { type: "string" },
    database: { type: "string" },
    "control-database": { type: "string" }
  }
});

const fail = (message) => {
  process.stderr.write(`live service environment: ${message}\n`);
  process.exit(2);
};

function canonical(path) {
  if (!isAbsolute(path) || /[\r\n]/.test(path)) throw new Error(`path must be absolute and single-line: ${path}`);
  let current = path;
  const suffix = [];
  for (;;) {
    try { return resolve(realpathSync.native(current), ...suffix); } catch (error) {
      if (error?.code !== "ENOENT" || dirname(current) === current) throw error;
      suffix.unshift(basename(current));
      current = dirname(current);
    }
  }
}

try {
  if (process.platform !== "linux") fail("live process environment verification is only available on Linux");
  else {
    const pid = Number(values.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) fail("MainPID is missing or invalid");
    else if (!values.runtime || !values.database || !values["control-database"]) fail("all three paths are required");
    else {
      const environment = readFileSync(`/proc/${pid}/environ`)
        .toString("utf8").split("\0").filter(Boolean);
      const found = new Map();
      for (const item of environment) {
        const separator = item.indexOf("=");
        if (separator > 0) found.set(item.slice(0, separator), item.slice(separator + 1));
      }
      const expected = new Map([
        ["RAI_RUNTIME_ROOT", values.runtime],
        ["RAI_DATABASE", values.database],
        ["RAI_CONTROL_DATABASE", values["control-database"]]
      ]);
      for (const [key, value] of expected) {
        const actual = found.get(key);
        if (!actual) fail(`running service does not define ${key}; refusing a backup whose closure is only on paper`);
        else if (canonical(actual) !== canonical(value)) {
          fail(`running service ${key}=${actual} differs from the backup configuration ${value}; restart the service or fix the env file before backing up`);
        }
      }
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
