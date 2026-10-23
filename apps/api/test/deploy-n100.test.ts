import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * Windows 盘符路径 → MSYS 形式（`C:/x` → `/c/x`）。
 *
 * 🔴 为什么必需：bash 向 node stub 传参时，MSYS 会把脚本内的 POSIX 路径
 * （`/c/...`）**自动转换**成 Windows 形式（`C:/...`）；node 不做反向转换，
 * 于是 stub 收到的参数带盘符。而 tar 会把 `C:/...` 解读为 `host:path`
 * （`Cannot connect to C: resolve failed`）。给 tar 喂回 MSYS 形式即可。
 */
function toMsysPath(value: string): string {
  if (process.platform !== "win32") return value;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  return match === null ? value : `/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}`;
}

const script = resolve("deploy/backup-runtime.sh");
const canRunBash = spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;

/**
 * tar 的可执行路径（node 可直接 spawn 的形式）。
 *
 * 🔴 两个反面教材，都实测踩过：
 * - 直接写 `/usr/bin/tar` 给 node：Windows 上 node 不做 MSYS 路径映射 ⇒ ENOENT，
 *   stub 静默退出 1，脚本看起来像"拒绝备份"；
 * - 让 bash 去 PATH 上找 `tar`（`bash -c 'exec tar "$@"'`）：fixture 把 stub 目录放在 PATH
 *   首位（bash 脚本必须优先命中替身），`tar` 于是又解析成 stub 自己 ⇒ **无限递归 fork 炸弹**。
 *
 * 所以：用 cygpath 把 bash 视角的路径转成 node 能执行的绝对路径（POSIX 平台原样返回）。
 * 探测失败时整套测试**响亮地跳过**，不静默地跑成假绿。
 */
function resolveTarPath(): string {
  const probe = spawnSync("bash", ["-c", 'cygpath -w "$(command -v tar)" 2>/dev/null || command -v tar'],
    { encoding: "utf8" });
  return (probe.stdout ?? "").trim();
}
const tarPath = canRunBash ? resolveTarPath() : "";
const windowsSymlinkSkip = process.platform === "win32"
  ? "symbolic-link fixtures need privileges on Windows" : false;
const bashTest = (name: string, fn: () => void | Promise<void>, extraSkip: boolean | string = false) =>
  test(name, {
    skip: !canRunBash ? "bash is required for deploy script tests"
      : tarPath === "" ? "a tar executable is required for deploy script tests" : extraSkip
  }, fn);

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
  // 阶段 4：脚本必须能证明主库/控制库都在 runtime 根内。部署真实来源是
  // systemd 的 /etc/rai/rai.env；夹具用同格式文件，避免测试靠“默认路径”假绿。
  const envFile = join(root, "rai.env");
  writeFileSync(envFile, [
    `RAI_RUNTIME_ROOT=${runtime}`,
    `RAI_DATABASE=${join(runtime, "var/rai.sqlite")}`,
    `RAI_CONTROL_DATABASE=${join(runtime, "var/rai-control.sqlite")}`,
    "RAI_API_TOKEN=fixture-token-not-printed"
  ].join("\n") + "\n");
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
      const property = args[args.indexOf("-p") + 1];
      if (property === "LoadState") console.log("loaded");
      else if (property === "ActiveState") console.log(fs.readFileSync(process.env.TEST_STATE, "utf8"));
      else if (property === "EnvironmentFiles") console.log(process.env.TEST_SERVICE_ENV_FILES ?? "");
      else if (property === "Environment") console.log(process.env.TEST_SERVICE_ENV ?? "");
      else if (property === "UnsetEnvironment") console.log(process.env.TEST_SERVICE_UNSET_ENV ?? "");
      else if (property === "MainPID") console.log(process.env.TEST_SERVICE_MAIN_PID ?? "0");
      else if (property === "RootDirectory" || property === "BindPaths") console.log("");
      else process.exit(2);
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
    // 绝对路径（resolveTarPath 已转成 node 可执行的格式）：绝不经 PATH —— 见文件头注释的死循环教训。
    // 参数里的 Windows 盘符路径要转回 MSYS 形式，否则 tar 把 "C:/…" 当远程主机。
    const args = process.argv.slice(2).map((arg) => {
      const match = /^([A-Za-z]):[\\\\/](.*)$/.exec(arg);
      return match === null ? arg : "/" + match[1].toLowerCase() + "/" + match[2].replaceAll("\\\\", "/");
    });
    const mutate = () => {
      const fs = require("node:fs");
      if (process.env.TEST_MUTATE_FILE) fs.appendFileSync(process.env.TEST_MUTATE_FILE, "changed-after-archive");
      if (!process.env.TEST_MUTATION) return;
      const target = process.env.TEST_MUTATE_PATH;
      switch (process.env.TEST_MUTATION) {
        case "link": fs.symlinkSync(process.env.TEST_MUTATE_TARGET, target); break;
        case "directory": fs.mkdirSync(target); break;
        case "file": fs.writeFileSync(target, "new file"); break;
        case "delete": fs.unlinkSync(target); break;
        case "rewrite": fs.writeFileSync(target, "x".repeat(fs.readFileSync(target).length)); break;
        case "parent-alias": fs.renameSync(target, target + "-real"); fs.symlinkSync(target + "-real", target); break;
      }
    };
    if (args.includes("-cf") && process.env.TEST_MUTATION_STAGE === "before") mutate();
    const result = require("node:child_process").spawnSync(${JSON.stringify(tarPath)}, args, { stdio: "inherit" });
    if (process.env.TEST_TAR_LOG) require("node:fs").appendFileSync(process.env.TEST_TAR_LOG, args.join(" ") + "\\n");
    if (args.includes("-cf") && process.env.TEST_MUTATION_STAGE !== "before") mutate();
    process.exit(result.status ?? 1);
  `);
  // The production checker reads Linux /proc. Keep the shell integration test
  // portable while proving the script requires a PID and invokes that checker.
  stub("node", `
    const args = process.argv.slice(2);
    if (args[0]?.endsWith("/verify-live-service-env.mjs")) {
      require("node:fs").appendFileSync(process.env.TEST_LOG, "verify-live-service-env\\n");
      process.exit(process.env.TEST_LIVE_ENV_CHECK === "fail" ? 2 : 0);
    }
    const result = require("node:child_process").spawnSync(process.execPath, args, { stdio: "inherit" });
    process.exit(result.status ?? 1);
  `);
  return {
    root, runtime, output, state, log, envFile,
    run(args: string[], extraEnv: Record<string, string> = {}) {
      return spawnSync("bash", [script, "--runtime-root", runtime, "--output-dir", output, "--env-file", envFile, ...args], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_STATE: state,
          TEST_LOG: log,
          TEST_SERVICE_ENV_FILES: `${envFile} (ignore_errors=no)`,
          TEST_SERVICE_ENV: "",
          TEST_SERVICE_MAIN_PID: String(process.pid),
          ...extraEnv
        },
        encoding: "utf8"
      });
    },
    close() { rmSync(root, { recursive: true, force: true }); }
  };
}

function makeTar(members: Array<{ name: string; type?: string; link?: string; data?: string }>): Buffer {
  const chunks: Buffer[] = [];
  const octal = (header: Buffer, offset: number, length: number, value: number) => {
    header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
  };
  for (const member of members) {
    const data = Buffer.from(member.data ?? "");
    const header = Buffer.alloc(512);
    header.write(member.name, 0, 100, "utf8");
    octal(header, 100, 8, 0o600);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, data.length);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(member.type ?? "0", 156, 1, "ascii");
    if (member.link) header.write(member.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    octal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

bashTest("whole-runtime backup defaults dry-run and rejects output inside runtime", () => {
  const f = fixture();
  try {
    const result = f.run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN/);
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
    assert.deepEqual(readdirSync(f.output), []);
    const rejected = f.run(["--output-dir", f.runtime, "--apply"]);
    assert.equal(rejected.status, 2);
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
  } finally { f.close(); }
});

for (const state of ["active", "inactive"]) {
  bashTest(`whole-runtime backup includes control/artifacts and restores ${state} service state`, () => {
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
      const listing = spawnSync(tarPath, ["-tf", toMsysPath(archive)], { encoding: "utf8" });
      assert.equal(listing.status, 0, listing.stderr);
      for (const file of ["rai.sqlite", "runtime.sqlite", "rai-control.sqlite", "model.onnx"]) {
        assert.ok(listing.stdout.includes(file), `missing ${file}`);
      }
      const sums = readFileSync(join(f.output, backup, "SHA256SUMS"), "utf8");
      assert.match(sums, /^[a-f0-9]{64}  runtime\.tar$/m);
      assert.match(sums, /^[a-f0-9]{64}  path-manifest\.json$/m);
    } finally { f.close(); }
  });
}

bashTest("active service without a MainPID is refused before stopping or publishing", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], { TEST_SERVICE_MAIN_PID: "0" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /MainPID is unavailable/);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

bashTest("active service live environment failure is refused before stopping", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], { TEST_LIVE_ENV_CHECK: "fail" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(readFileSync(f.log, "utf8"), /verify-live-service-env/);
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

bashTest("external authoritative database path is refused before stopping the service", () => {
  const f = fixture();
  try {
    const external = join(f.root, "elsewhere");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "rai.sqlite"), "not in runtime");
    const result = spawnSync("bash", [
      script, "--runtime-root", f.runtime, "--output-dir", f.output,
      "--database", join(external, "rai.sqlite"),
      "--control-database", join(f.runtime, "var/rai-control.sqlite"), "--apply"
    ], {
      env: { ...process.env, PATH: `${join(f.root, "bin")}:${process.env.PATH}`, TEST_STATE: f.state, TEST_LOG: f.log,
        TEST_SERVICE_ENV_FILES: "", TEST_SERVICE_ENV: `RAI_RUNTIME_ROOT=${f.runtime} RAI_DATABASE=${join(external, "rai.sqlite")} RAI_CONTROL_DATABASE=${join(f.runtime, "var/rai-control.sqlite")}` },
      encoding: "utf8"
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /outside the runtime root/);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

bashTest("backup records a five-store path manifest and refuses unverifiable apply", () => {
  const f = fixture();
  try {
    const missingPaths = spawnSync("bash", [
      script, "--runtime-root", f.runtime, "--output-dir", f.output, "--no-default-env", "--apply"
    ], {
      env: { ...process.env, PATH: `${join(f.root, "bin")}:${process.env.PATH}`, TEST_STATE: f.state, TEST_LOG: f.log },
      encoding: "utf8"
    });
    assert.equal(missingPaths.status, 2);
    assert.match(missingPaths.stderr, /both explicit database paths are required/);

    const result = f.run(["--apply"]);
    assert.equal(result.status, 0, result.stderr);
    const backup = readdirSync(f.output).find((name) => name.startsWith("rai-runtime-"));
    assert.ok(backup);
    const manifest = JSON.parse(readFileSync(join(f.output, backup, "path-manifest.json"), "utf8"));
    assert.equal(manifest.format, "rai-runtime-path-manifest-v2");
    assert.equal(manifest.serviceConfiguration.source, "service-environment-file");
    assert.equal(manifest.serviceConfiguration.envFile, realpathSync(f.envFile));
    assert.equal(manifest.serviceConfiguration.normalizedPaths.main, realpathSync(join(f.runtime, "var/rai.sqlite")));
    for (const name of ["main", "control", "epochSidecar", "restoreJournal", "runtime"]) {
      assert.ok(manifest.stores[name], `missing store ${name}`);
      assert.match(manifest.stores[name].status, /^(present|absent)$/);
    }
    assert.equal(manifest.closure, "complete");
    assert.ok(Array.isArray(manifest.inventory.entries));
    assert.ok(manifest.inventory.entries.some((entry: { path: string; type: string; sha256: string | null }) =>
      entry.path === "var/rai.sqlite" && entry.type === "file" && /^[a-f0-9]{64}$/.test(entry.sha256 ?? "")));
    const sums = readFileSync(join(f.output, backup, "SHA256SUMS"), "utf8");
    assert.match(sums, /^[a-f0-9]{64}  runtime\.tar$/m);
    assert.match(sums, /^[a-f0-9]{64}  path-manifest\.json$/m);
  } finally { f.close(); }
});

bashTest("archive verifier rejects a store sidecar that appears after the manifest", () => {
  const f = fixture();
  try {
    const manifest = join(f.root, "late-path-manifest.json");
    const dryRun = f.run(["--manifest-out", manifest]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    writeFileSync(join(f.runtime, "var/rai.sqlite-wal"), "late WAL");
    writeFileSync(join(f.runtime, "var/rai.sqlite-journal"), "late rollback journal");
    writeFileSync(join(f.runtime, "var/rai.sqlite.dataset-epoch.sqlite-journal"), "late sidecar journal");
    writeFileSync(join(f.runtime, "var/rai.sqlite.restore-journal.sqlite"), "late journal");
    const archive = join(f.root, "late-runtime.tar");
    const tarResult = spawnSync(tarPath, ["-C", toMsysPath(f.runtime), "-cf", toMsysPath(archive), "."], {
      encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" }
    });
    assert.equal(tarResult.status, 0, tarResult.stderr);
    const verify = spawnSync(process.execPath, [
      resolve("scripts/verify-runtime-backup-archive.mjs"),
      "--archive", archive, "--manifest", manifest, "--source-root", f.runtime,
      "--extract-root", f.output
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(verify.status, 1, verify.stdout);
    assert.match(verify.stderr, /expected absent, got file/);
    assert.match(verify.stderr, /store:main-wal|store:restoreJournal/);
  } finally { f.close(); }
});

bashTest("active CLI publication lock is refused after stopping the service", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.runtime, "var/rai.sqlite.import.lock"), JSON.stringify({
      token: "test-cli-lock", pid: process.pid, kind: "cli", startedAt: new Date().toISOString()
    }));
    const result = f.run(["--apply"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /active CLI publication lock/);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

bashTest("failed backup removes partial output and restarts previously active service", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], { TEST_FAIL_TAR: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

bashTest("backup reports service restart failure even when the archive was created", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], { TEST_FAIL_START: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CRITICAL/);
    assert.ok(readdirSync(f.output).some((name) => name.startsWith("rai-runtime-")));
  } finally { f.close(); }
});

bashTest("dry-run writes an explicit read-only path manifest", () => {
  const f = fixture();
  try {
    const manifestOut = join(f.root, "dry-run-manifest.json");
    const result = f.run(["--manifest-out", manifestOut]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Path manifest written/);
    const manifest = JSON.parse(readFileSync(manifestOut, "utf8"));
    assert.equal(manifest.format, "rai-runtime-path-manifest-v2");
    assert.equal(manifest.closure, "complete");
    for (const name of ["main", "control", "epochSidecar", "restoreJournal", "runtime"]) {
      assert.ok(manifest.stores[name], `missing store ${name}`);
    }
    assert.equal(readFileSync(f.log, "utf8"), "", "dry-run must not call systemctl");
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

bashTest("runtime-only env without explicit database paths is refused", () => {
  const f = fixture();
  try {
    const env = join(f.root, "runtime-only.env");
    writeFileSync(env, `RAI_RUNTIME_ROOT=${f.runtime}\n`);
    const result = spawnSync("bash", [
      script, "--runtime-root", f.runtime, "--output-dir", f.output, "--env-file", env, "--apply"
    ], {
      env: { ...process.env, PATH: `${join(f.root, "bin")}:${process.env.PATH}`, TEST_STATE: f.state, TEST_LOG: f.log,
        TEST_SERVICE_ENV_FILES: `${env} (ignore_errors=no)`, TEST_SERVICE_ENV: "" },
      encoding: "utf8"
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /service does not explicitly configure RAI_DATABASE/);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

for (const [name, link] of [
  ["top-level external file link", (runtime: string, outside: string) => {
    mkdirSync(join(runtime, "var/imports"), { recursive: true });
    symlinkSync(join(outside, "source.zip"), join(runtime, "var/imports/source.zip"));
  }],
  ["authoritative tree root link", (runtime: string, outside: string) => {
    symlinkSync(outside, join(runtime, "var/imports"));
  }],
  ["nested external directory link", (runtime: string, outside: string) => {
    mkdirSync(join(runtime, "var/imports/job1"), { recursive: true });
    symlinkSync(outside, join(runtime, "var/imports/job1/extracted"));
  }],
  ["dangling link", (runtime: string) => {
    mkdirSync(join(runtime, "var/imports/job1"), { recursive: true });
    symlinkSync(join(runtime, "does-not-exist.zip"), join(runtime, "var/imports/job1/source.zip"));
  }],
  ["database WAL link", (runtime: string, outside: string) => {
    symlinkSync(join(outside, "wal"), join(runtime, "var/rai.sqlite-wal"));
  }]
] as Array<[string, (runtime: string, outside: string) => void]>) {
  bashTest(`symbolic link in an authoritative path is refused before stopping: ${name}`, () => {
    const f = fixture();
    try {
      const outside = join(f.root, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "source.zip"), "outside bytes");
      writeFileSync(join(outside, "wal"), "outside wal");
      link(f.runtime, outside);
      const result = f.run(["--apply"]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /symbolic link/);
      assert.equal(readFileSync(f.state, "utf8"), "active");
      assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
      assert.deepEqual(readdirSync(f.output), []);
    } finally { f.close(); }
  }, windowsSymlinkSkip);
}

bashTest("unreadable authoritative file is refused before stopping", () => {
  if (process.platform === "win32") return;
  if (process.getuid?.() === 0) {
    return; // root bypasses mode bits; the case would pass without testing anything.
  }
  const f = fixture();
  const target = join(f.runtime, "var/imports/unreadable.zip");
  try {
    mkdirSync(join(f.runtime, "var/imports"), { recursive: true });
    writeFileSync(target, "secret");
    chmodSync(target, 0o000);
    const result = f.run(["--apply"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not readable/);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.deepEqual(readdirSync(f.output), []);
  } finally {
    try { chmodSync(target, 0o600); } catch { /* fixture may be gone */ }
    f.close();
  }
});

bashTest("service env different from the backup env is refused before stopping", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], {
      TEST_SERVICE_ENV: "RAI_DATABASE=/srv/other/rai.sqlite"
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Environment= path override/);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

for (const [name, override] of [
  ["outside actual main database", "external"],
  ["different inside main database", "inside"]
] as const) {
  bashTest(`env file plus CLI override is refused before stop: ${name}`, () => {
    const f = fixture();
    try {
      const actual = override === "external" ? join(f.root, "external/actual.sqlite")
        : join(f.runtime, "var/actual.sqlite");
      mkdirSync(join(actual, ".."), { recursive: true });
      writeFileSync(actual, "actual service database");
      writeFileSync(f.envFile, [
        `RAI_RUNTIME_ROOT=${f.runtime}`, `RAI_DATABASE=${actual}`,
        `RAI_CONTROL_DATABASE=${join(f.runtime, "var/rai-control.sqlite")}`
      ].join("\n"));
      const result = f.run(["--database", join(f.runtime, "var/rai.sqlite"), "--apply"]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /cannot be combined/);
      assert.equal(readFileSync(f.state, "utf8"), "active");
      assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
      assert.deepEqual(readdirSync(f.output), []);
    } finally { f.close(); }
  });
}

bashTest("multiple and optional EnvironmentFiles are rejected before stop", () => {
  const f = fixture();
  try {
    const second = join(f.root, "second.env");
    writeFileSync(second, "RAI_DATABASE=/other.sqlite\n");
    for (const files of [
      `${f.envFile} (ignore_errors=no) ${second} (ignore_errors=no)`,
      `${f.envFile} (ignore_errors=yes)`
    ]) {
      const result = f.run(["--apply"], { TEST_SERVICE_ENV_FILES: files });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /exactly one required EnvironmentFile/);
      assert.equal(readFileSync(f.state, "utf8"), "active");
      assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
      assert.deepEqual(readdirSync(f.output), []);
    }
  } finally { f.close(); }
});

bashTest("UnsetEnvironment and quoted path syntax are rejected before stop", () => {
  const f = fixture();
  try {
    for (const extra of [
      { TEST_SERVICE_UNSET_ENV: "RAI_DATABASE" },
      { TEST_SERVICE_ENV: `RAI_DATABASE=\"${join(f.runtime, "var/rai.sqlite")}\"` }
    ]) {
      const result = f.run(["--apply"], extra);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /UnsetEnvironment|Environment= path override|quoted or escaped/);
      assert.equal(readFileSync(f.state, "utf8"), "active");
      assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
      assert.deepEqual(readdirSync(f.output), []);
    }
  } finally { f.close(); }
});

bashTest("service database path through a symlink is refused", () => {
  const f = fixture();
  try {
    const link = join(f.runtime, "var/alias.sqlite");
    symlinkSync(join(f.runtime, "var/rai.sqlite"), link);
    writeFileSync(f.envFile, [
      `RAI_RUNTIME_ROOT=${f.runtime}`, `RAI_DATABASE=${link}`,
      `RAI_CONTROL_DATABASE=${join(f.runtime, "var/rai-control.sqlite")}`
    ].join("\n"));
    const result = f.run(["--apply"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /symbolic link/);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
}, windowsSymlinkSkip);

bashTest("direct Environment configuration matching three paths produces a verified archive", () => {
  const f = fixture();
  try {
    const result = spawnSync("bash", [script, "--runtime-root", f.runtime, "--output-dir", f.output,
      "--no-default-env", "--database", join(f.runtime, "var/rai.sqlite"),
      "--control-database", join(f.runtime, "var/rai-control.sqlite"), "--apply"], {
      env: { ...process.env, PATH: `${join(f.root, "bin")}:${process.env.PATH}`,
        TEST_STATE: f.state, TEST_LOG: f.log, TEST_SERVICE_ENV_FILES: "",
        TEST_SERVICE_MAIN_PID: String(process.pid),
        TEST_SERVICE_ENV: `RAI_RUNTIME_ROOT=${f.runtime} RAI_DATABASE=${join(f.runtime, "var/rai.sqlite")} RAI_CONTROL_DATABASE=${join(f.runtime, "var/rai-control.sqlite")}` },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const backup = readdirSync(f.output).find((name) => name.startsWith("rai-runtime-"));
    assert.ok(backup);
    const manifest = JSON.parse(readFileSync(join(f.output, backup, "path-manifest.json"), "utf8"));
    assert.equal(manifest.serviceConfiguration.source, "service-environment");
    assert.equal(manifest.serviceConfiguration.normalizedPaths.main, realpathSync(join(f.runtime, "var/rai.sqlite")));
    assert.equal(manifest.stores.main.configured, join(f.runtime, "var/rai.sqlite"));
    assert.equal(manifest.closure, "complete");
  } finally { f.close(); }
});

bashTest("source change during the archive window refuses to publish the archive", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], {
      TEST_MUTATE_FILE: join(f.runtime, "var/rai.sqlite")
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source changed after the archive window|archive-closure/);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

for (const [name, mutation, relative, target] of [
  ["absent tree becomes external link", "link", "var/imports", "external"],
  ["absent tree becomes internal link", "link", "var/imports", "internal"],
  ["absent tree becomes dangling link", "link", "var/imports", "dangling"],
  ["absent tree becomes directory", "directory", "var/imports", ""],
  ["absent tree becomes file", "file", "var/imports", ""],
  ["present tree gains file", "file", "var/model-artifacts/prediction/added.onnx", ""],
  ["present tree loses file", "delete", "var/model-artifacts/prediction/model.onnx", ""],
  ["present tree rewrites same-size file", "rewrite", "var/model-artifacts/prediction/model.onnx", ""]
] as const) {
  const mutationSymlinkSkip = process.platform === "win32" && mutation === "link"
    ? "symbolic-link mutations need privileges on Windows" : false;
  bashTest(`archive window rejects ${name}`, () => {
    const f = fixture();
    try {
      const path = join(f.runtime, relative);
      const linkTarget = target === "external" ? join(f.root, "outside")
        : target === "internal" ? join(f.runtime, "var")
          : join(f.root, "missing");
      if (target === "external") mkdirSync(linkTarget);
      const result = f.run(["--apply"], {
        TEST_MUTATION: mutation, TEST_MUTATION_STAGE: "before",
        TEST_MUTATE_PATH: path, TEST_MUTATE_TARGET: linkTarget
      });
      assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
      assert.match(result.stderr, new RegExp(relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(readFileSync(f.state, "utf8"), "active");
      assert.match(readFileSync(f.log, "utf8"), /stop rai-api\.service/);
      assert.match(readFileSync(f.log, "utf8"), /start rai-api\.service/);
      assert.deepEqual(readdirSync(f.output), []);
    } finally { f.close(); }
  }, mutationSymlinkSkip);
}

bashTest("post-tar creation of an absent tree is caught by source rescan", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], {
      TEST_MUTATION: "link", TEST_MUTATE_PATH: join(f.runtime, "var/imports"),
      TEST_MUTATE_TARGET: join(f.root, "dangling")
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source:tree:var\/imports/);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
}, windowsSymlinkSkip);

bashTest("post-tar symlink replacement of a tree parent is caught", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], {
      TEST_MUTATION: "parent-alias", TEST_MUTATE_PATH: join(f.runtime, "var/model-artifacts")
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source:parent:var\/model-artifacts/);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
}, windowsSymlinkSkip);

for (const [name, members] of [
  ["absolute path", [{ name: "/tmp/rai-danger", data: "unsafe" }]],
  ["parent traversal", [{ name: "../rai-danger", data: "unsafe" }]],
  ["link parent", [{ name: "var/imports", type: "2", link: "../../outside" },
    { name: "var/imports/child", data: "unsafe" }]],
  ["duplicate name", [{ name: "var/duplicate", data: "first" }, { name: "var/duplicate", data: "second" }]],
  ["FIFO member", [{ name: "var/pipe", type: "6" }]]
] as const) {
  bashTest(`unsafe tar is rejected before extraction: ${name}`, () => {
    const f = fixture();
    try {
      const manifest = join(f.root, "manifest.json");
      const archive = join(f.root, "unsafe.tar");
      const tarLog = join(f.root, "tar.log");
      const marker = join(f.root, "marker");
      writeFileSync(marker, "unchanged");
      assert.equal(f.run(["--manifest-out", manifest]).status, 0);
      writeFileSync(archive, makeTar(members.map((member) => ({ ...member }))));
      writeFileSync(tarLog, "");
      const result = spawnSync(process.execPath, [resolve("scripts/verify-runtime-backup-archive.mjs"),
        "--archive", archive, "--manifest", manifest, "--source-root", f.runtime,
        "--extract-root", f.output], {
        env: { ...process.env, PATH: `${join(f.root, "bin")}:${process.env.PATH}`,
          TEST_TAR_LOG: tarLog }, encoding: "utf8"
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /archive:(unsafe|headers|list)/);
      assert.doesNotMatch(readFileSync(tarLog, "utf8"), /-xf/);
      assert.equal(readFileSync(marker, "utf8"), "unchanged");
      assert.deepEqual(readdirSync(f.output), []);
    } finally { f.close(); }
  });
}

test("home deployment templates keep private bind addresses and safe defaults", () => {
  const read = (name: string) => readFileSync(resolve("deploy/n100", name), "utf8");
  assert.match(read("frps.toml"), /proxyBindAddr = "127\.0\.0\.1"/);
  assert.match(read("frps.toml"), /transport\.tls\.force = true/);
  assert.match(read("frpc.toml"), /transport\.tls\.trustedCaFile/);
  assert.match(read("frpc.toml"), /transport\.useCompression = false/);
  assert.match(read("rai.env.example"), /^RAI_PUBLIC_HOSTS=$/m);
  assert.doesNotMatch(read("rai.env.example"), /RAI_IMPORT_VALIDATION_MODE/);
  assert.match(read("nginx-rai.conf"), /proxy_set_header Authorization \$http_authorization/);
  assert.match(read("nginx-rai.conf"), /proxy_request_buffering off/);
  // 2026-10-18（深度审查 P3-34）：n100 模板与主模板 deploy/nginx-rai.conf 对齐——
  // 只有 /v1（含 uploads 特例）反代到 API；站点根路径与任何静态资源一律 404；
  // robots.txt 由 nginx 直接回答。此前 `location /` 是 catch-all 透传，任何未来新增的
  // 非 /v1 路由都会被意外暴露到公网。
  const nginx = read("nginx-rai.conf");
  assert.match(nginx, /location = \/robots\.txt \{/);
  assert.match(nginx, /location \/ \{ return 404; \}/);
  assert.equal((nginx.match(/proxy_pass /g) ?? []).length, 2, "只允许 uploads 与 /v1/ 两处反代");
  assert.doesNotMatch(nginx, /location \/ \{\s*\n\s*proxy_pass/);
  assert.match(read("rai-api.service"), /ExecStart=\/usr\/bin\/node --import tsx/);
  assert.ok(existsSync(script));
});
