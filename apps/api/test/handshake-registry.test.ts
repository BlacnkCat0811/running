import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { HANDSHAKE_KEY_REGISTRY } from "@rai/api-contracts";

/**
 * PR-05 (2026-10-21): every handshake key needs one reviewable registration.
 *
 * This test is deliberately source-level for the interface side: TypeScript
 * cannot enumerate an interface at runtime, and a hand-maintained list inside
 * the production file could drift from the wire DTO without any compiler error.
 * The registry is typed `string`, so this coverage check is what keeps it
 * honest.
 */
const projectRoot = join(import.meta.dirname, "../../..");

function interfaceBody(source: string, name: string): string {
  const marker = `export interface ${name} {`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing interface ${name}`);
  let depth = 0;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + marker.length, index);
    }
  }
  throw new Error(`unterminated interface ${name}`);
}

function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (depth === 0) {
      const match = /^([A-Za-z][A-Za-z0-9]*)\??\s*:/.exec(trimmed);
      if (match) keys.push(match[1]!);
    }
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
  }
  return keys;
}

test("handshake registry covers exactly every HandshakeResponse key", () => {
  const source = readFileSync(join(projectRoot, "packages/api-contracts/src/index.ts"), "utf8");
  const expected = topLevelKeys(interfaceBody(source, "HandshakeResponse")).sort();
  const registered = HANDSHAKE_KEY_REGISTRY.map((entry) => entry.key).sort();
  assert.deepEqual(registered, expected, "registry and wire DTO must not drift");
  assert.equal(new Set(registered).size, registered.length, "handshake keys must be unique");
});

test("every registration states semantics, precondition, consumer and old-server behaviour", () => {
  for (const entry of HANDSHAKE_KEY_REGISTRY) {
    assert.ok(entry.semantics.trim().length > 0, `${entry.key}: semantics`);
    assert.ok(entry.advertisedWhen.trim().length > 0, `${entry.key}: advertisedWhen`);
    assert.ok(entry.consumer.trim().length > 0, `${entry.key}: consumer`);
    assert.ok(entry.whenAbsent.trim().length > 0, `${entry.key}: whenAbsent`);
    if (entry.kind !== "identity") {
      assert.ok(entry.kind === "capability" || entry.kind === "parameter", `${entry.key}: kind`);
    }
  }
});

test("deferred capabilities are explicit and mirrored where the contract says", () => {
  const byKey = new Map(HANDSHAKE_KEY_REGISTRY.map((entry) => [entry.key, entry]));
  assert.match(byKey.get("factsAnalysisViewContractVersion")?.consumer ?? "", /deferred/);
  // Phase 5: the command key is now consumed by the iOS publisher in the
  // isolated candidate; it is no longer a deferred capability.
  assert.match(byKey.get("trainingPlanCommandContractVersion")?.consumer ?? "", /TrainingPlanPublisher/);
  assert.match(byKey.get("trainingPlanCommandContractVersion")?.whenAbsent ?? "", /只读/);

  // PR-05 decision: iOS mirrors the view capability but does not consume the
  // two row views. The comment is the reviewable half; the decode test is the
  // executable half (`TrainingPlanV2Regression`).
  const swift = readFileSync(join(projectRoot, "apps/ios/RAI/APIModels.swift"), "utf8");
  assert.match(swift, /factsAnalysisViewContractVersion/,
    "Swift must mirror the capability key even while consumption is deferred");
  assert.match(swift, /暂不消费/, "the deferred-consumption decision must be stated at the mirror");
});
