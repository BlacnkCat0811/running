import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONDITION_FIELDS,
  NORMALIZATION_ADAPTER_VERSION,
  createIdentityNormalizationAdapter,
  defaultConditionLedger,
  defaultIdentityNormalizationConfig,
  identityNormalizationConfigHash,
  stableContextHash,
  validateConditionLedger,
  type ConditionCorrectionSite,
  type NormalizationContext
} from "../src/index.js";

const projectRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const adapter = createIdentityNormalizationAdapter();

const REFERENCE: NormalizationContext = {
  temperatureC: 15,
  humidityPercent: 50,
  elevationGainMeters: 5
};

const observe = (context: Partial<NormalizationContext>) =>
  adapter.normalize({
    id: "w1",
    distanceMeters: 10_000,
    durationSeconds: 3_000,
    context: { ...REFERENCE, ...context }
  });

// -----------------------------------------------------------------------------
// §5.3 四个状态。最要紧的一条：缺数据不得伪装成"处于参考条件"。
// -----------------------------------------------------------------------------

test("reference conditions report not_needed, and the values are bit-identical to the input", () => {
  const result = observe({});
  assert.equal(result.trace.status, "not_needed");
  assert.equal(result.trace.correctionFraction, 0);
  assert.equal(result.trace.comparability, 1);
  assert.deepEqual(result.trace.reasonCodes, ["reference_conditions"]);
  assert.deepEqual(result.normalized, { distanceMeters: 10_000, durationSeconds: 3_000 });
  // Identity means identity: no fallback is offered because none is needed.
  assert.equal(result.rawComparableFallback, null);
});

test("a missing condition is unavailable, never not_needed (§5.3)", () => {
  // The whole point of the split: the existing penalty returns 0 for missing data too,
  // which is indistinguishable from "measured and flat". Reporting not_needed here would
  // be exactly the lie §5.3 forbids.
  for (const [partial, code] of [
    [{ temperatureC: null }, "temperature_missing"],
    [{ humidityPercent: null }, "humidity_missing"],
    [{ elevationGainMeters: null }, "elevation_missing"]
  ] as const) {
    const result = observe(partial);
    assert.equal(result.trace.status, "unavailable", `${code} must be unavailable`);
    assert.ok(result.trace.reasonCodes.includes(code), `${code} missing from reasonCodes`);
    // No correction was computed, so none may be reported — 0 would mean "computed, and zero".
    assert.equal(result.trace.correctionFraction, null);
    assert.equal(result.normalized, null);
    // The raw observation stays available for low-confidence explanation, under a name
    // that cannot be mistaken for a normalised value.
    assert.deepEqual(result.rawComparableFallback, { distanceMeters: 10_000, durationSeconds: 3_000 });
    assert.notEqual(result.trace.comparability, 1);
  }
});

test("conditions that are present but outside the reference domain are out_of_domain", () => {
  const hot = observe({ temperatureC: 34 });
  assert.equal(hot.trace.status, "out_of_domain");
  assert.equal(hot.trace.correctionFraction, null);
  assert.equal(hot.normalized, null);
  assert.deepEqual(hot.trace.reasonCodes, ["temperature_out_of_reference_domain"]);

  const steep = observe({ elevationGainMeters: 900 });
  assert.deepEqual(steep.trace.reasonCodes, ["elevation_out_of_reference_domain"]);

  // Out-of-domain is known to differ, so it must compare worse than merely unknown.
  assert.ok(
    hot.trace.comparability < observe({ temperatureC: null }).trace.comparability,
    "known divergence must rank below unknown"
  );
});

test("the identity adapter never claims to have applied a correction", () => {
  const contexts: NormalizationContext[] = [
    REFERENCE,
    { temperatureC: null, humidityPercent: null, elevationGainMeters: null },
    { temperatureC: 34, humidityPercent: 95, elevationGainMeters: 900 },
    { temperatureC: 0, humidityPercent: 10, elevationGainMeters: 30 }
  ];
  for (const context of contexts) {
    const result = adapter.normalize({ id: "w", distanceMeters: 1, durationSeconds: 1, context });
    assert.notEqual(result.trace.status, "applied", `identity returned applied for ${JSON.stringify(context)}`);
    assert.equal(result.trace.adapterVersion, NORMALIZATION_ADAPTER_VERSION);
    // `normalized` is present exactly when the fallback is absent.
    assert.equal(result.normalized === null, result.rawComparableFallback !== null);
    if (result.normalized !== null) {
      assert.equal(result.trace.correctionFraction, 0);
    }
  }
});

// -----------------------------------------------------------------------------
// 谱系指纹
// -----------------------------------------------------------------------------

const FIELD_KEY: Record<(typeof CONDITION_FIELDS)[number], keyof NormalizationContext> = {
  temperature_c: "temperatureC",
  humidity_percent: "humidityPercent",
  elevation_gain_meters: "elevationGainMeters"
};

test("the context fingerprint is deterministic and separates every field", () => {
  const base = stableContextHash(REFERENCE);
  assert.equal(base, stableContextHash({ ...REFERENCE }));
  for (const field of CONDITION_FIELDS) {
    const changed = { ...REFERENCE, [FIELD_KEY[field]]: 99 };
    assert.notEqual(
      stableContextHash(changed),
      base,
      `changing ${field} must change the fingerprint, otherwise two different observations look identical in the lineage`
    );
  }
  // Missing is a different context from any filled value.
  assert.notEqual(stableContextHash({ ...REFERENCE, temperatureC: null }), base);
});

test("the trace actually carries the full-context fingerprint, not a subset", () => {
  // The hash function is exercised above; this is about the adapter *using* it. Asserting only
  // on `stableContextHash` let a mutation that hashed just one field survive.
  const reference = observe({}).trace.sourceContextHash;
  for (const field of CONDITION_FIELDS) {
    const key = FIELD_KEY[field];
    assert.notEqual(
      observe({ [key]: null }).trace.sourceContextHash,
      reference,
      `${field} missing must change the trace fingerprint`
    );
    assert.notEqual(
      observe({ [key]: key === "temperatureC" ? 20 : key === "humidityPercent" ? 60 : 15 }).trace.sourceContextHash,
      reference,
      `${field} changing value must change the trace fingerprint`
    );
  }
  // And it is stable when nothing changes.
  assert.equal(observe({}).trace.sourceContextHash, reference);
});

test("the config hash covers the adapter identity, not just the numbers", () => {
  assert.equal(identityNormalizationConfigHash(), identityNormalizationConfigHash());
  const loosened = identityNormalizationConfigHash({
    ...defaultIdentityNormalizationConfig,
    referenceTemperatureC: { min: 5, max: 30 }
  });
  assert.notEqual(loosened, identityNormalizationConfigHash());
});

test("invalid inputs and impossible configs fail loudly", () => {
  assert.throws(() => adapter.normalize({ id: "", distanceMeters: 1, durationSeconds: 1, context: REFERENCE }));
  assert.throws(() => adapter.normalize({ id: "w", distanceMeters: 0, durationSeconds: 1, context: REFERENCE }));
  assert.throws(() => adapter.normalize({ id: "w", distanceMeters: Number.NaN, durationSeconds: 1, context: REFERENCE }));
  assert.throws(() => adapter.normalize({ id: "w", distanceMeters: 1, durationSeconds: 1, context: { ...REFERENCE, temperatureC: Number.NaN } }));
  assert.throws(() =>
    createIdentityNormalizationAdapter({
      ...defaultIdentityNormalizationConfig,
      referenceTemperatureC: { min: 30, max: 5 }
    })
  );
  assert.throws(() =>
    createIdentityNormalizationAdapter({
      ...defaultIdentityNormalizationConfig,
      comparabilityUnavailable: 1.5
    })
  );
});

// -----------------------------------------------------------------------------
// §5.5 条件账本：把"禁止重复扣罚"变成构造时即抛的约束
// -----------------------------------------------------------------------------

test("the shipped ledger is valid, and every entry points at a real function", () => {
  validateConditionLedger(defaultConditionLedger);
  for (const site of defaultConditionLedger) {
    const [file, symbol] = site.location.split(":");
    assert.ok(file && symbol, `location must be 文件:函数 — got ${site.location}`);
    const source = readFileSync(resolve(projectRoot, file), "utf8");
    assert.ok(
      source.includes(`function ${symbol}(`),
      `${site.id} claims ${site.location}, but ${file} has no function ${symbol}`
    );
  }
});

test("a second correction of the same field on the same object is rejected", () => {
  // This is the exact failure §5.5 names: the same historical heat penalty removed twice.
  const duplicated: ConditionCorrectionSite[] = [
    ...defaultConditionLedger,
    {
      id: "adapter-also-debiases-history",
      appliesTo: "historical_evidence",
      fields: ["temperature_c"],
      location: "packages/physiology/src/index.ts:performanceVdotEvidence",
      note: ""
    }
  ];
  assert.throws(() => validateConditionLedger(duplicated), /double correction of temperature_c/);
});

test("the residual input may not re-apply a field an upstream side already handled", () => {
  const overlapping: ConditionCorrectionSite[] = [
    ...defaultConditionLedger,
    {
      id: "residual-learns-what-is-left",
      appliesTo: "residual_input",
      fields: ["elevation_gain_meters"],
      location: "packages/physiology/src/index.ts:predictRaceTimes",
      note: ""
    }
  ];
  assert.throws(
    () => validateConditionLedger(overlapping),
    /re-applies elevation_gain_meters already handled by/
  );
});

test("the ledger's stated allowance is real: history and scenario may share a field", () => {
  // §5.5 allows "past heat de-biased + future heat scenario" because they are different
  // objects. The validator must not have over-corrected that into a prohibition.
  const historical = defaultConditionLedger.find((site) => site.appliesTo === "historical_evidence");
  const scenario = defaultConditionLedger.find((site) => site.appliesTo === "target_scenario");
  assert.ok(historical && scenario);
  for (const field of CONDITION_FIELDS) {
    assert.ok(historical.fields.includes(field));
    assert.ok(scenario.fields.includes(field));
  }
});

test("malformed ledger entries are rejected rather than silently ignored", () => {
  assert.throws(() => validateConditionLedger([]));
  assert.throws(() =>
    validateConditionLedger([{ id: "a", appliesTo: "historical_evidence", fields: [], location: "x:y", note: "" }])
  );
  assert.throws(() =>
    validateConditionLedger([{ id: "a", appliesTo: "historical_evidence", fields: ["temperature_c"], location: "", note: "" }])
  );
  assert.throws(() =>
    validateConditionLedger([
      { id: "a", appliesTo: "historical_evidence", fields: ["temperature_c"], location: "x:y", note: "" },
      { id: "a", appliesTo: "target_scenario", fields: ["humidity_percent"], location: "x:y", note: "" }
    ])
  );
  assert.throws(() =>
    validateConditionLedger([
      {
        id: "a",
        appliesTo: "historical_evidence",
        fields: ["temperature_c", "temperature_c"],
        location: "x:y",
        note: ""
      }
    ])
  );
});

test("the declared unavailable comparability sits below the learning gate on purpose", () => {
  // ⚠️ Do NOT wire `comparabilityUnavailable` into `confidenceV2.comparability` before the
  // data gap is solved. `@rai/scoring`'s §6.2 gate is 0.90
  // (`defaultRaiModelConfig.minimumComparabilityForLearning`), and on the 2026-09-28 local
  // database every workout is `unavailable`, so wiring it in would stop all learning.
  // The value is intentionally below the gate; the coverage report measures the blast radius.
  assert.ok(defaultIdentityNormalizationConfig.comparabilityUnavailable < 0.9);
  assert.ok(defaultIdentityNormalizationConfig.comparabilityOutOfDomain < 0.9);
  assert.ok(defaultIdentityNormalizationConfig.comparabilityOutOfDomain < defaultIdentityNormalizationConfig.comparabilityUnavailable);
});
