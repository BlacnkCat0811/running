import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const bashTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, {
    skip: !canRunBash ? "bash is required for deploy script tests"
      : tarPath === "" ? "a tar executable is required for deploy script tests" : false
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
    // 绝对路径（resolveTarPath 已转成 node 可执行的格式）：绝不经 PATH —— 见文件头注释的死循环教训。
    // 参数里的 Windows 盘符路径要转回 MSYS 形式，否则 tar 把 "C:/…" 当远程主机。
    const args = process.argv.slice(2).map((arg) => {
      const match = /^([A-Za-z]):[\\\\/](.*)$/.exec(arg);
      return match === null ? arg : "/" + match[1].toLowerCase() + "/" + match[2].replaceAll("\\\\", "/");
    });
    const result = require("node:child_process").spawnSync(${JSON.stringify(tarPath)}, args, { stdio: "inherit" });
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

bashTest("whole-runtime backup defaults dry-run and rejects output inside runtime", () => {
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
      assert.match(readFileSync(join(f.output, backup, "SHA256SUMS"), "utf8"), /^[a-f0-9]{64}  runtime.tar\n$/);
    } finally { f.close(); }
  });
}

bashTest("failed backup removes partial output and restarts previously active service", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"], { TEST_FAIL_TAR: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(f.state, "utf8"), "active");
    assert.deepEqual(readdirSync(f.output), [".rai-runtime-backup.lock"]);
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
