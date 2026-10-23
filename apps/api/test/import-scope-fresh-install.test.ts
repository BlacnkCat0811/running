// P1-8（2026-10-23 复审）：`--fresh-install` 必须拒绝一切历史证据。
//
// 每个用例只跑真实 CLI（子进程），不构造 RuntimeStateStore 的内存替身：
// “文件不存在”“账本打开失败”“账本被隔离成 .corrupt-*”在旧实现里都变成
// `null`，正是这次要钉住的假“全新机器”。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = join(import.meta.dirname, "../../..");

function fixture(prefix: string): { root: string; databasePath: string; run: () => { status: number | null; stdout: string; stderr: string } } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(root, "var/rai.sqlite");
  return {
    root,
    databasePath,
    run: () => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "apps/api/src/import-scope-cli.ts", "--apply", "--fresh-install"],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            RAI_RUNTIME_ROOT: root,
            RAI_DATABASE: databasePath,
            RAI_SERVER_ID: "local",
            RAI_ATHLETE_ID: "athlete_1",
            RAI_DATASET_EPOCH: "default"
          },
          encoding: "utf8",
          timeout: 60_000
        }
      );
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
  };
}

test("P1-8: a truly empty machine initializes exactly once", () => {
  const context = fixture("rai-fresh-empty-");
  try {
    const first = context.run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /"applied": "fresh_install"/);
    const second = context.run();
    assert.notEqual(second.status, 0, "第二次 --fresh-install 必须拒绝");
    assert.match(second.stderr, /Refusing --fresh-install|already has persistent evidence/i);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});

test("P1-8: a deletion sidecar is historical evidence and refuses --fresh-install", () => {
  const context = fixture("rai-fresh-sidecar-");
  try {
    mkdirSync(join(context.root, "var"), { recursive: true });
    writeFileSync(`${context.databasePath}.dataset-epoch.sqlite`, "not a database");
    const result = context.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /deletion journal is unreadable|deletion-sidecar/);
    assert.match(result.stderr, /dataset-epoch\.sqlite/);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});

test("P1-8: a quarantined ledger (.corrupt-*) refuses --fresh-install", () => {
  const context = fixture("rai-fresh-corrupt-");
  try {
    mkdirSync(join(context.root, "var"), { recursive: true });
    writeFileSync(join(context.root, "var/runtime.sqlite.corrupt-2026-10-23.sqlite"), "quarantined bytes");
    const result = context.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime\.sqlite\.corrupt-2026-10-23\.sqlite/);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});

test("P1-8: legacy job/source history refuses --fresh-install", () => {
  for (const name of ["import-jobs.json", "import-sources.json"]) {
    const context = fixture(`rai-fresh-${name.replaceAll(".", "-")}-`);
    try {
      mkdirSync(join(context.root, "var"), { recursive: true });
      writeFileSync(join(context.root, "var", name), "[]");
      const result = context.run();
      assert.notEqual(result.status, 0, `${name} must count as history`);
      assert.match(result.stderr, new RegExp(name.replace(".", "\\.")));
    } finally { rmSync(context.root, { recursive: true, force: true }); }
  }
});

test("P1-8: an existing runtime ledger refuses --fresh-install even when empty", () => {
  const context = fixture("rai-fresh-ledger-");
  try {
    mkdirSync(join(context.root, "var"), { recursive: true });
    writeFileSync(join(context.root, "var/runtime.sqlite"), "");
    const result = context.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime-ledger|runtime\.sqlite/);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});
