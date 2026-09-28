import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// This executes the guard against fake commands, NOT a production system check.
test("manual runtime tool has valid syntax and rejects non-Linux before reading services", t => {
  if (process.platform === "win32") { t.skip("requires POSIX shell semantics"); return; }
  const script = resolve("deploy/check-runtime-readonly.sh");
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const root = mkdtempSync(join(tmpdir(), "rai-runtime-tool-"));
  try {
    writeFileSync(join(root, "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n", { mode: 0o700 });
    for (const name of ["systemctl", "python3", "df"]) {
      writeFileSync(join(root, name), "#!/bin/sh\necho 'UNEXPECTED_RUNTIME_ACCESS' >&2\nexit 99\n", { mode: 0o700 });
    }
    const result = spawnSync("bash", [script], { env: { ...process.env, PATH: root + delimiter + process.env.PATH }, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /no runtime was checked/);
    assert.ok(!result.stderr.includes("UNEXPECTED_RUNTIME_ACCESS"));
  } finally { rmSync(root, { force: true, recursive: true }); }
});
