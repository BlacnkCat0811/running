import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function scenario(options: { failMigration?: boolean; recovery?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rai-upgrade-test-"));
  const bin = join(root, "bin");
  const app = join(root, "app");
  const log = join(root, "commands");
  mkdirSync(bin);
  mkdirSync(join(app, ".git"), { recursive: true });
  writeFileSync(join(root, "rai.env"), "RAI_API_TOKEN=test-token\n");
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("sudo", 'if [ "$1" = "-u" ]; then shift 2; fi\nexec "$@"');
  stub("git", 'case "$*" in *rev-parse*) echo fixed-revision ;; esac');
  stub("npm", 'echo "npm $*" >> "$TEST_COMMANDS"\ncase "$*" in *data:migrate*) [ "$TEST_FAIL_MIGRATION" != "1" ] || exit 17 ;; esac');
  stub("systemctl", 'echo "systemctl $*" >> "$TEST_COMMANDS"');
  stub("sleep", "exit 0");
  stub("curl", `
output=""; authenticated=0; post=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -H) authenticated=1; shift 2 ;;
    -X) post=1; shift 2 ;;
    *) shift ;;
  esac
done
if [ "$post" -eq 1 ]; then
  echo backup >> "$TEST_COMMANDS"; echo 201
elif [ "$authenticated" -eq 1 ]; then
  printf '%s' "$TEST_HEALTH" > "$output"; echo 200
else echo 401
fi`);
  try {
    const result = spawnSync("bash", [resolve("deploy/upgrade.sh"), "--apply", "--migrate", "--database", join(root, "rai.sqlite")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAI_APP_DIR: app,
        RAI_ENV_FILE: join(root, "rai.env"), RAI_SERVICE: "rai-test", TEST_COMMANDS: log,
        TEST_FAIL_MIGRATION: options.failMigration ? "1" : "0",
        TEST_HEALTH: JSON.stringify({ status: options.recovery ? "recovery_required" : "ok", databaseReady: !options.recovery }) }
    });
    // A missing log means the script died before the first stub could record anything;
    // surface why instead of reporting a misleading ENOENT from readFileSync.
    if (!existsSync(log)) {
      assert.fail(
        "deploy/upgrade.sh recorded no command — it died before the first stub ran."
        + ` status=${String(result.status)} signal=${String(result.signal)}`
        + ` error=${result.error?.message ?? "none"}`
        + ` stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
      );
    }
    return { ...result, commands: readFileSync(log, "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("explicit upgrade migration runs between service stop and restart", () => {
  const result = scenario();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.commands, /backup[\s\S]*systemctl stop rai-test[\s\S]*data:migrate[\s\S]*systemctl reset-failed rai-test[\s\S]*systemctl restart rai-test/);
});

test("failed migration leaves the service stopped", () => {
  const result = scenario({ failMigration: true });
  assert.equal(result.status, 17, result.stderr);
  assert.match(result.commands, /systemctl stop rai-test/);
  assert.doesNotMatch(result.commands, /systemctl restart|systemctl reset-failed/);
});

test("upgrade rejects HTTP 200 maintenance state", () => {
  const result = scenario({ recovery: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /未真实就绪/);
});
