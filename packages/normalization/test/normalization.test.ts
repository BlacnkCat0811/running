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

// -----------------------------------------------------------------------------
// P02 机检：账本声明 ↔ 源码里真实的修正点
//
// The ledger used to be a declaration nobody compared against the code: adding a
// third correction site (or moving an existing one) changed nothing unless a human
// noticed. This check makes the registry executable:
//   1. every ledger id must appear as `// condition-ledger:<id>` inside the function
//      its `location` names;
//   2. every call to a correction primitive must sit in a ledger-declared function or
//      in the short allowlist of composition/read-only functions below.
// -----------------------------------------------------------------------------

const PHYSIOLOGY_FILE = "packages/physiology/src/index.ts";

/** The shared primitives that actually apply a condition correction. */
const CORRECTION_PRIMITIVES = [
  "performanceConditionPenaltyFraction(",
  "heatHumidityPenaltyFraction(",
  "elevationPenaltyFraction(",
  "createPhysiologyNormalizationAdapter("
] as const;

/**
 * Not correction sites:
 *   · the composed primitive and its two components (their definitions compose it);
 *   · the adapter factory (it is *how* a site applies the shared penalty);
 *   · `buildWorkoutEnvironmentView` (docs §5.1 read-out — it must call the same
 *     adapter so the number shown equals the number applied, but it changes nothing).
 */
const CORRECTION_PRIMITIVE_OWNERS = new Set([
  "performanceConditionPenaltyFraction",
  "heatHumidityPenaltyFraction",
  "elevationPenaltyFraction",
  "createPhysiologyNormalizationAdapter",
  "buildWorkoutEnvironmentView"
]);

/** Name of the function whose body contains `index`, or null at top level. */
function enclosingFunction(source: string, index: number): string | null {
  const before = source.slice(0, index);
  const pattern = /(?:export )?function ([A-Za-z0-9_]+)\(/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = pattern.exec(before)) !== null) last = match[1]!;
  return last;
}

function assertConditionLedgerMatchesSource(
  ledger: readonly ConditionCorrectionSite[],
  source: string
): void {
  const declared = new Map<string, string>();
  for (const site of ledger) {
    const [file, symbol] = site.location.split(":");
    assert.equal(file, PHYSIOLOGY_FILE, `${site.id}: the scanner only knows ${PHYSIOLOGY_FILE}`);
    assert.ok(symbol, `${site.id}: location must be 文件:函数`);
    declared.set(symbol, site.id);
    const marker = `condition-ledger:${site.id}`;
    const at = source.indexOf(marker);
    assert.ok(at >= 0, `${site.id} is not registered in the source: missing \`// ${marker}\``);
    assert.equal(
      enclosingFunction(source, at),
      symbol,
      `${site.id}: the marker must sit inside ${symbol}, not ${String(enclosingFunction(source, at))}`
    );
  }
  // No anonymous marker may exist without a ledger entry: that is a third site.
  for (const match of source.matchAll(/condition-ledger:([A-Za-z0-9-]+)/g)) {
    assert.ok(
      [...declared.values()].includes(match[1]!),
      `condition-ledger:${match[1]} has no entry in defaultConditionLedger`
    );
  }
  for (const primitive of CORRECTION_PRIMITIVES) {
    for (let at = source.indexOf(primitive); at >= 0; at = source.indexOf(primitive, at + 1)) {
      if (source.slice(Math.max(0, at - "function ".length), at) === "function ") continue; // definition
      const owner = enclosingFunction(source, at);
      if (owner === null) continue;
      if (owner === "performanceConditionPenaltyFraction") continue; // composed from its parts
      if (CORRECTION_PRIMITIVE_OWNERS.has(owner)) continue;
      assert.ok(
        declared.has(owner),
        `${primitive} is applied inside ${owner}, which is not in defaultConditionLedger — ` +
        "register the site (and its condition-ledger marker) or move it under a registered function"
      );
    }
  }
}

test("P02: the condition ledger and the source's correction sites agree", () => {
  const source = readFileSync(resolve(projectRoot, PHYSIOLOGY_FILE), "utf8");
  assertConditionLedgerMatchesSource(defaultConditionLedger, source);
});

test("P02: a third correction site turns the ledger check red", () => {
  const source = readFileSync(resolve(projectRoot, PHYSIOLOGY_FILE), "utf8");
  const withThirdSite = `${source}\nexport function leaksThirdCorrection(distanceMeters: number, conditions: PerformanceConditions): number {\n  return heatHumidityPenaltyFraction(conditions.temperatureC, conditions.humidityPercent);\n}\n`;
  assert.throws(
    () => assertConditionLedgerMatchesSource(defaultConditionLedger, withThirdSite),
    /leaksThirdCorrection.*not in defaultConditionLedger/
  );
  // A third marker without a ledger entry is a registration, not a silent extra site.
  assert.throws(
    () => assertConditionLedgerMatchesSource(
      defaultConditionLedger,
      source.replace("condition-ledger:race-prediction-scenario", "condition-ledger:race-prediction-scenario\n    // condition-ledger:third-site")
    ),
    /third-site.*has no entry/
  );
  // Moving a marker out of its declared function (or deleting it) is drift.
  const moved = source.replace("condition-ledger:race-prediction-scenario", "condition-ledger:moved");
  assert.throws(() => assertConditionLedgerMatchesSource(defaultConditionLedger, moved), /race-prediction-scenario/);
});
