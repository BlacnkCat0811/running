import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("deploy/backup-runtime.sh");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rai-n100-backup-"));
  const runtime = join(root, "runtime");
  const output = join(root, "backups");
  const bin = join(root, "bin");
  for (const path of [join(runtime, "var/model-artifacts/prediction"), output, bin]) {
    mkdirSync(path, { recursive: true });
  }
  for (const name of ["rai.sqlite", "runtime.sqlite", "rai-control.sqlite"]) {
    writeFileSync(join(runtime, "var", name), `fixture ${name}`);
  }
  writeFileSync(join(runtime, "var/model-artifacts/prediction/model.onnx"), "fixture artifact");
  const state = join(root, "state");
  const log = join(root, "log");
  writeFileSync(state, "active");
  writeFileSync(log, "");
  const stub = (name: string, body: string): void => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub("systemctl", `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_LOG, args.join(" ") + "\\n");
    if (args[0] === "show") {
      console.log(args.includes("LoadState") ? "loaded" : fs.readFileSync(process.env.TEST_STATE, "utf8"));
    } else if (args[0] === "stop") fs.writeFileSync(process.env.TEST_STATE, "inactive");
    else if (args[0] === "start") {
      if (process.env.TEST_FAIL_START === "1") process.exit(1);
      fs.writeFileSync(process.env.TEST_STATE, "active");
    } else process.exit(2);
  `);
  // Platform-independent stubs: never call the host's system manager.
  stub("flock", "process.exit(0)");
  stub("sha256sum", `
    const fs = require("node:fs"), crypto = require("node:crypto");
    const name = process.argv[2];
    console.log(crypto.createHash("sha256").update(fs.readFileSync(name)).digest("hex") + "  " + name);
  `);
  stub("tar", `
    if (process.env.TEST_FAIL_TAR === "1") process.exit(1);
    const result = require("node:child_process").spawnSync("/usr/bin/tar", process.argv.slice(2), { stdio: "inherit" });
    process.exit(result.status ?? 1);
  `);
  return {
    root, runtime, output, state, log,
    run(args: string[], extraEnv: Record<string, string> = {}) {
      return spawnSync("bash", [script, "--runtime-root", runtime, "--output-dir", output, ...args], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_STATE: state, TEST_LOG: log, ...extraEnv },
        encoding: "utf8"
      });
    },
    close() { rmSync(root, { recursive: true, force: true }); }
  };
}

test("whole-runtime backup defaults dry-run and rejects output inside runtime", () => {
  const f = fixture();
  try {
    const result = f.run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN/);
    assert.equal(readFileSync(f.log, "utf8"), "");
    assert.deepEqual(readdirSync(f.output), []);
    const rejected = f.run(["--output-dir", f.runtime, "--apply"]);
    assert.equal(rejected.status, 2);
    assert.equal(readFileSync(f.log, "utf8"), "");
  } finally { f.close(); }
});

for (const state of ["active", "inactive"]) {
  test(`whole-runtime backup includes control/artifacts and restores ${state} service state`, () => {
    const f = fixture();
    try {
      writeFileSync(f.state, state);
      const result = f.run(["--apply"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(f.state, "utf8"), state);
      const log = readFileSync(f.log, "utf8");
      assert.equal(log.includes("stop rai-api.service"), state === "active");
      assert.equal(log.includes("start rai-api.service"), state === "active");
      const backup = readdirSync(f.output).find((name) => name.startsWith("rai-runtime-"));
      assert.ok(backup);
      const archive = join(f.output, backup, "runtime.tar");
      const listing = spawnSync("/usr/bin/tar", ["-tf", archive], { encoding: "utf8" });
      assert.equal(listing.status, 0, listing.stderr);
      for (const file of ["rai.sqlite", "runtime.sqlite", "rai-control.sqlite", "model.onnx"]) {
        assert.ok(listing.stdout.includes(file), `missing ${file}`);
      }
      assert.match(readFileSync(join(f.output, backup, "SHA256SUMS"), "utf8"), /^[a-f0-9]{64}  runtime.tar\n$/);
    } finally { f.close(); }
  });
}

test("failed backup removes partial output and restarts previously active service", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], { TEST_FAIL_TAR: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.deepEqual(readdirSync(f.output), [".rai-runtime-backup.lock"]);
  } finally { f.close(); }
});

test("backup reports service restart failure even when the archive was created", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], { TEST_FAIL_START: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CRITICAL/);
    assert.ok(readdirSync(f.output).some((name) => name.startsWith("rai-runtime-")));
  } finally { f.close(); }
});

test("home deployment templates keep private bind addresses and safe defaults", () => {
  const read = (name: string) => readFileSync(resolve("deploy/n100", name), "utf8");
  assert.match(read("frps.toml"), /proxyBindAddr = "127\.0\.0\.1"/);
  assert.match(read("frps.toml"), /transport\.tls\.force = true/);
  assert.match(read("frpc.toml"), /transport\.tls\.trustedCaFile/);
  assert.match(read("frpc.toml"), /transport\.useCompression = false/);
  assert.match(read("rai.env.example"), /^RAI_PUBLIC_HOSTS=$/m);
  assert.match(read("rai.env.example"), /^RAI_IMPORT_VALIDATION_MODE=shadow$/m);
  assert.match(read("nginx-rai.conf"), /proxy_set_header Authorization \$http_authorization/);
  assert.match(read("nginx-rai.conf"), /proxy_request_buffering off/);
  assert.match(read("rai-api.service"), /ExecStart=\/usr\/bin\/node --import tsx/);
  assert.ok(existsSync(script));
});
