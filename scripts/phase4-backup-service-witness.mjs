#!/usr/bin/env node
// Isolated service-stop witness for the phase 4 backup acceptance record.
// All paths and database bytes are synthetic; no host service is contacted.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const evidencePath = process.argv[2];
if (!evidencePath) throw new Error("pass an output JSON path");
const root = mkdtempSync(join(tmpdir(), "rai-phase4-service-witness-"));
const runtime = join(root, "runtime");
const output = join(root, "backups");
const rejectedOutput = join(root, "rejected-backups");
const bin = join(root, "bin");
const envFile = join(root, "rai.env");
const state = join(root, "service-state");
const log = join(root, "systemctl.log");
const archiveScript = resolve("deploy/backup-runtime.sh");

try {
  for (const path of [join(runtime, "var/model-artifacts/prediction"), output, rejectedOutput, bin]) {
    mkdirSync(path, { recursive: true });
  }
  for (const name of ["rai.sqlite", "rai-control.sqlite", "runtime.sqlite"]) {
    writeFileSync(join(runtime, "var", name), `synthetic ${name}\n`);
  }
  writeFileSync(join(runtime, "var/model-artifacts/prediction/model.onnx"), "synthetic model\n");
  writeFileSync(envFile, [
    `RAI_RUNTIME_ROOT=${runtime}`,
    `RAI_DATABASE=${join(runtime, "var/rai.sqlite")}`,
    `RAI_CONTROL_DATABASE=${join(runtime, "var/rai-control.sqlite")}`
  ].join("\n") + "\n");
  writeFileSync(state, "active");
  writeFileSync(log, "");
  const stub = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub("systemctl", `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.WITNESS_LOG, args.join(" ") + "\\n");
    if (args[0] === "show") {
      const property = args[args.indexOf("-p") + 1];
      if (property === "EnvironmentFiles") console.log(process.env.WITNESS_ENV + " (ignore_errors=no)");
      else if (property === "Environment" || property === "UnsetEnvironment") console.log("");
      else if (property === "MainPID") console.log(process.env.WITNESS_MAIN_PID ?? "0");
      else if (property === "RootDirectory" || property === "BindPaths") console.log("");
      else if (property === "LoadState") console.log("loaded");
      else if (property === "ActiveState") console.log(fs.readFileSync(process.env.WITNESS_STATE, "utf8"));
      else process.exit(2);
    } else if (args[0] === "stop") fs.writeFileSync(process.env.WITNESS_STATE, "inactive");
    else if (args[0] === "start") fs.writeFileSync(process.env.WITNESS_STATE, "active");
    else process.exit(2);
  `);
  stub("flock", "process.exit(0)");
  stub("node", `
    const args = process.argv.slice(2);
    if (args[0]?.endsWith("/verify-live-service-env.mjs")) {
      require("node:fs").appendFileSync(process.env.WITNESS_LOG, "verify-live-service-env\\n");
      process.exit(0);
    }
    const result = require("node:child_process").spawnSync(process.execPath, args, { stdio: "inherit" });
    process.exit(result.status ?? 1);
  `);
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    WITNESS_ENV: envFile, WITNESS_LOG: log, WITNESS_STATE: state,
    WITNESS_MAIN_PID: String(process.pid) };
  const successful = spawnSync("bash", [archiveScript, "--runtime-root", runtime,
    "--output-dir", output, "--env-file", envFile, "--apply"],
  { env: environment, encoding: "utf8" });
  const archiveName = readdirSync(output).find((name) => name.startsWith("rai-runtime-"));
  if (successful.status !== 0 || !archiveName) {
    throw new Error(`positive witness failed: ${successful.stderr}`);
  }
  const archiveDir = join(output, archiveName);
  const manifest = JSON.parse(readFileSync(join(archiveDir, "path-manifest.json"), "utf8"));
  const tarPath = join(archiveDir, "runtime.tar");
  const tarList = spawnSync("tar", ["-tf", tarPath], { encoding: "utf8" });
  if (tarList.status !== 0) throw new Error(tarList.stderr);
  const positiveLog = readFileSync(log, "utf8").trim().split("\n");

  // N1's original external-database/CLI-override combination must be rejected
  // before even querying systemctl, with the service still active.
  const external = join(root, "external/actual.sqlite");
  mkdirSync(join(root, "external"));
  writeFileSync(external, "synthetic external database\n");
  writeFileSync(envFile, [
    `RAI_RUNTIME_ROOT=${runtime}`, `RAI_DATABASE=${external}`,
    `RAI_CONTROL_DATABASE=${join(runtime, "var/rai-control.sqlite")}`
  ].join("\n") + "\n");
  writeFileSync(log, "");
  const rejected = spawnSync("bash", [archiveScript, "--runtime-root", runtime,
    "--output-dir", rejectedOutput, "--env-file", envFile,
    "--database", join(runtime, "var/rai.sqlite"), "--apply"],
  { env: environment, encoding: "utf8" });

  const result = {
    format: "rai-phase4-service-witness-v1",
    environment: "isolated temporary files and systemctl/flock stubs; no production service",
    positive: {
      exitCode: successful.status, serviceStateAfter: readFileSync(state, "utf8"),
      systemctlLog: positiveLog, closure: manifest.closure,
      serviceConfiguration: manifest.serviceConfiguration,
      stores: Object.fromEntries(Object.entries(manifest.stores).map(([key, value]) =>
        [key, { status: value.status, relativePath: value.relativePath, sha256: value.sha256 ?? null }])),
      archiveEntries: tarList.stdout.trim().split("\n"),
      archiveSha256: createHash("sha256").update(readFileSync(tarPath)).digest("hex")
    },
    rejectedOverride: {
      exitCode: rejected.status, stderr: rejected.stderr.trim(),
      serviceStateAfter: readFileSync(state, "utf8"),
      systemctlLog: readFileSync(log, "utf8").trim(),
      finalArchives: readdirSync(rejectedOutput).filter((name) => name.startsWith("rai-runtime-"))
    }
  };
  if (result.positive.serviceStateAfter !== "active"
      || !positiveLog.some((line) => line.startsWith("stop "))
      || !positiveLog.some((line) => line.startsWith("start "))
      || !positiveLog.includes("verify-live-service-env")
      || result.rejectedOverride.exitCode !== 2
      || result.rejectedOverride.systemctlLog !== ""
      || result.rejectedOverride.finalArchives.length !== 0) {
    throw new Error("service witness assertions failed");
  }
  writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write("phase4 service witness passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
