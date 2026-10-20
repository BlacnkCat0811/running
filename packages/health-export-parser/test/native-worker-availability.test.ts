import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeArtifactState, newestNativeSourceMtimeMs } from "../src/native-worker.js";

/**
 * 2026-10-19：`native-worker` parity 测试在本机失败的真实原因是**过期产物**（二进制早于
 * Rust parity 修复），不是产品语义坏了。这条回归钉住"如何判定过期"，避免下次又把
 * "环境产物旧"报成"产品失败"，也避免把真实缺失静默跳过。
 */
test("native artifact staleness: missing, older-than-source, newer-than-source, packaged", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-native-artifact-"));
  try {
    const binary = join(root, "rai-data-worker");
    const sourceDirectory = join(root, "crates", "rai-data-worker", "src");
    mkdirSync(sourceDirectory, { recursive: true });
    const source = join(sourceDirectory, "main.rs");
    writeFileSync(source, "fn main() {}");
    writeFileSync(join(root, "Cargo.toml"), "[workspace]");
    writeFileSync(join(root, "Cargo.lock"), "");
    writeFileSync(join(root, "crates", "rai-data-worker", "Cargo.toml"), "[package]");
    const sourceTime = 1_800_000_000;
    utimesSync(source, sourceTime, sourceTime);
    utimesSync(join(root, "Cargo.lock"), sourceTime, sourceTime);

    // 源码树存在：最新 mtime 可判定。
    assert.equal(newestNativeSourceMtimeMs(root), sourceTime * 1000, "source mtime is discoverable");
    // 缺失。
    assert.deepEqual(nativeArtifactState(binary, sourceTime * 1000), {
      exists: false,
      stale: false,
      reason: nativeArtifactState(binary, sourceTime * 1000).reason
    });
    assert.match(nativeArtifactState(binary, sourceTime * 1000).reason ?? "", /rust:build/);

    // 旧产物 ⇒ stale，且原因指向重建（不是产品 parity）。
    writeFileSync(binary, "stale");
    utimesSync(binary, sourceTime - 10, sourceTime - 10);
    const stale = nativeArtifactState(binary, sourceTime * 1000);
    assert.equal(stale.exists, true);
    assert.equal(stale.stale, true);
    assert.match(stale.reason ?? "", /older than its Rust sources/);

    // 新产物 ⇒ ready。
    utimesSync(binary, sourceTime + 10, sourceTime + 10);
    assert.deepEqual(nativeArtifactState(binary, sourceTime * 1000), {
      exists: true,
      stale: false,
      reason: null
    });

    // 打包部署（源码树不存在）：无法判断新旧 ⇒ 只要产物在就按可用处理，不制造假跳过。
    const packagedRoot = join(root, "package-only");
    mkdirSync(packagedRoot, { recursive: true });
    assert.equal(newestNativeSourceMtimeMs(packagedRoot), null, "packaged root has no Rust sources");
    assert.equal(nativeArtifactState(binary, null).stale, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
