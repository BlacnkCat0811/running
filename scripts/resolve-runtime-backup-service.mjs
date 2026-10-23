#!/usr/bin/env node
// Resolve the deliberately small, provable subset of systemd path configuration.
// Output contains only the three canonical paths and provenance, never other env values.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, basename, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

import { readRuntimeBackupEnvFile } from "./runtime-backup-env.mjs";

const { values } = parseArgs({ options: {
  service: { type: "string" }, runtime: { type: "string" }, "env-file": { type: "string" },
  database: { type: "string" }, "control-database": { type: "string" }
} });
const fail = (message) => { throw new Error(message); };
const keys = ["RAI_RUNTIME_ROOT", "RAI_DATABASE", "RAI_CONTROL_DATABASE"];

function canonical(path) {
  if (!isAbsolute(path) || /[\r\n]/.test(path)) fail("service paths must be absolute and single-line");
  // Do not lexically normalize `..` here: the API and the path checker use the
  // native filesystem order, so a symlink followed by `..` must stay intact.
  let current = path;
  const suffix = [];
  for (;;) {
    try { return resolve(realpathSync.native(current), ...suffix); }
    catch (error) {
      if (error?.code !== "ENOENT" || dirname(current) === current) throw error;
      suffix.unshift(basename(current));
      current = dirname(current);
    }
  }
}

function show(property) {
  const result = spawnSync("systemctl", ["show", values.service, "-p", property, "--value"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) fail(`cannot read service ${property}`);
  return result.stdout.trim();
}


try {
  if (!values.service || !values.runtime) fail("service and runtime are required");
  const envFile = values["env-file"];
  if (envFile && (values.database || values["control-database"])) {
    fail("--env-file cannot be combined with --database or --control-database");
  }
  if (!envFile && (!values.database || !values["control-database"])) {
    fail("both explicit database paths are required without --env-file");
  }
  const files = show("EnvironmentFiles");
  const direct = show("Environment");
  if (show("UnsetEnvironment")) fail("UnsetEnvironment is unsupported for backup verification");
  // RootDirectory/BindPaths can remap the paths visible to the service. Until
  // the backup can prove the effective namespace, refuse instead of treating
  // the host path as the service path.
  for (const property of ["RootDirectory", "BindPaths"]) {
    if (show(property).trim()) fail(`${property}= is unsupported for backup verification`);
  }
  const assignments = new Map();
  if (/["']/.test(direct) || (process.platform !== "win32" && direct.includes("\\"))) {
    fail("quoted or escaped Environment= is unsupported for backup verification");
  }
  for (const token of direct.split(/\s+/).filter(Boolean)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (!match) fail("unsupported Environment= syntax");
    if (keys.includes(match[1])) {
      if (assignments.has(match[1])) fail(`duplicate ${match[1]} in Environment=`);
      assignments.set(match[1], match[2]);
    }
  }
  let configured;
  let source;
  if (envFile) {
    // systemctl prints one entry as /path (ignore_errors=no). Optional files and
    // multiple files have precedence/availability semantics we cannot prove here.
    const match = /^([^\s()]+) \(ignore_errors=no\)$/.exec(files);
    if (!match) fail("service must have exactly one required EnvironmentFile");
    if (canonical(match[1]) !== canonical(envFile)) fail("backup env file differs from service EnvironmentFile");
    if (keys.some((key) => assignments.has(key))) fail("Environment= path override with EnvironmentFile is unsupported");
    configured = readRuntimeBackupEnvFile(envFile);
    source = "service-environment-file";
  } else {
    if (files) fail("service has EnvironmentFile; explicit database paths cannot prove service configuration");
    configured = assignments;
    source = "service-environment";
  }
  const expected = new Map([
    ["RAI_RUNTIME_ROOT", values.runtime], ["RAI_DATABASE", values.database],
    ["RAI_CONTROL_DATABASE", values["control-database"]]
  ]);
  for (const key of keys) {
    if (!configured.get(key)) fail(`service does not explicitly configure ${key}`);
    if (expected.get(key) && canonical(configured.get(key)) !== canonical(expected.get(key))) {
      fail(`service ${key} differs from backup configuration`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    source, envFile: envFile ? canonical(envFile) : null,
    runtime: canonical(configured.get("RAI_RUNTIME_ROOT")),
    main: canonical(configured.get("RAI_DATABASE")),
    control: canonical(configured.get("RAI_CONTROL_DATABASE")),
    configuredMain: configured.get("RAI_DATABASE"),
    configuredControl: configured.get("RAI_CONTROL_DATABASE")
  })}\n`);
} catch (error) {
  process.stderr.write(`backup service configuration: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
