// 阶段 6 F1 runner 纯预检：失败必须发生在创建根/打开数据库/发请求之前。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { REPO_ROOT } from "../../../scripts/phase6/safety.mjs";

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function fixtureFiles(root) {
  const fixture = join(root, "pristine.sqlite");
  writeFileSync(fixture, "fixture-bytes");
  const manifest = join(root, "fixture-manifest.json");
  writeFileSync(manifest, JSON.stringify({
    dataset: "D1", rows: { health_records: 1 }, digest: "fixture-digest",
    bytes: { database: 13, databaseSha256: sha256(fixture) }
  }));
  return { fixture, manifest };
}

function protocolFile(root, overrides = {}) {
  const path = join(root, "protocol.json");
  writeFileSync(path, JSON.stringify({
    protocolVersion: 1,
    protocolId: "runner-test",
    profiles: { dev: { purpose: "test" } },
    datasets: { D1: { records: 1, workouts: 1 } },
    scenarios: { S01: { name: "startup" } },
    statistics: { percentile: "nearest-rank: sorted[ceil(p*n)-1]", minSamplesForP99: 10000 },
    stopRules: { hardTimeoutPerRoundSeconds: 1800, maxInFlight: 64 },
    ...overrides
  }));
  return path;
}

function runRunner(args) {
  return spawnSync(process.execPath, ["scripts/phase6/runner.mjs", ...args], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000
  });
}

test("dry-run 展示解析结果但不创建根/数据库", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-runner-"));
  try {
    const { fixture, manifest } = fixtureFiles(dir);
    const protocol = protocolFile(dir);
    const root = join(dir, "run-new");
    const result = runRunner([
      "--root", root, "--protocol", protocol, "--dataset", "D1", "--scenario", "S01",
      "--fixture", fixture, "--fixture-manifest", manifest
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(root), false, "dry-run must not create the experiment root");
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, "dry-run");
    assert.equal(output.rootExists, false);
    assert.equal(output.fixture.sha256, sha256(fixture));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未知参数/profile/场景与已有根在预检阶段失败，且没有副作用", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-runner-"));
  try {
    const { fixture, manifest } = fixtureFiles(dir);
    const protocol = protocolFile(dir);
    const root = join(dir, "run-new");

    const unknownArg = runRunner(["--root", root, "--protocol", protocol, "--bogus", "1"]);
    assert.equal(unknownArg.status, 2);
    assert.match(unknownArg.stderr, /unknown argument/);
    assert.equal(existsSync(root), false);

    const unknownProfile = runRunner([
      "--root", root, "--protocol", protocol, "--profile", "production", "--dataset", "D1", "--scenario", "S01"
    ]);
    assert.equal(unknownProfile.status, 2);
    assert.match(unknownProfile.stderr, /profile is not defined/);
    assert.equal(existsSync(root), false);

    const unknownScenario = runRunner([
      "--root", root, "--protocol", protocol, "--dataset", "D1", "--scenario", "S99"
    ]);
    assert.equal(unknownScenario.status, 2);
    assert.match(unknownScenario.stderr, /scenario is not defined/);
    assert.equal(existsSync(root), false);

    const tooManyInFlight = runRunner([
      "--root", root, "--protocol", protocol, "--dataset", "D1", "--scenario", "S01", "--max-in-flight", "65"
    ]);
    assert.equal(tooManyInFlight.status, 2);
    assert.match(tooManyInFlight.stderr, /stop rule limit/);
    assert.equal(existsSync(root), false);

    // 已有根（即使带 phase6 标记）必须在任何清理前拒绝；文件字节不变。
    mkdirSync(root);
    writeFileSync(join(root, "keep.txt"), "keep");
    writeFileSync(join(root, ".phase6-run.json"), JSON.stringify({ owner: "phase6", runId: "old" }));
    const before = sha256(join(root, "keep.txt"));
    const existing = runRunner([
      "--root", root, "--protocol", protocol, "--dataset", "D1", "--scenario", "S01", "--execute",
      "--fixture", fixture, "--fixture-manifest", manifest
    ]);
    assert.equal(existing.status, 2);
    assert.match(existing.stderr, /root_exists|must be a new path/);
    assert.equal(sha256(join(root, "keep.txt")), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("坏 fixture SHA / 活跃 WAL / 生产 runtime 子目录在预检失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-runner-"));
  try {
    const { fixture, manifest } = fixtureFiles(dir);
    const protocol = protocolFile(dir);
    const root = join(dir, "run-new");
    const declared = JSON.parse(readFileSync(manifest, "utf8"));
    declared.bytes.databaseSha256 = "0".repeat(64);
    writeFileSync(manifest, JSON.stringify(declared));
    const badSha = runRunner([
      "--root", root, "--protocol", protocol, "--dataset", "D1", "--scenario", "S01", "--execute",
      "--fixture", fixture, "--fixture-manifest", manifest
    ]);
    assert.equal(badSha.status, 2);
    assert.match(badSha.stderr, /fixture sha256|sha/i);
    assert.equal(existsSync(root), false);

    // 活跃 WAL：冷备快照不允许带非空 sidecar。
    writeFileSync(`${fixture}-wal`, "wal-bytes");
    const active = runRunner([
      "--root", root, "--protocol", protocol, "--dataset", "D1", "--scenario", "S01", "--execute",
      "--fixture", fixture, "--fixture-manifest", manifest
    ]);
    assert.equal(active.status, 2);
    assert.match(active.stderr, /active_wal|non-empty sidecar/);
    assert.equal(existsSync(root), false);

    // 生产 runtime 根的子目录必须拒绝（即使路径不存在、父级存在）。
    const production = join(dir, "production-runtime");
    mkdirSync(production);
    const previous = process.env.RAI_RUNTIME_ROOT;
    process.env.RAI_RUNTIME_ROOT = production;
    try {
      const productionRoot = runRunner([
        "--root", join(production, "child-run"), "--protocol", protocol, "--dataset", "D1", "--scenario", "S01"
      ]);
      assert.equal(productionRoot.status, 2);
      assert.match(productionRoot.stderr, /production runtime/);
    } finally {
      if (previous === undefined) delete process.env.RAI_RUNTIME_ROOT;
      else process.env.RAI_RUNTIME_ROOT = previous;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
