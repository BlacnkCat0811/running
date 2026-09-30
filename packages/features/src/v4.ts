import {
  assertWorkoutFeatureVector, canonicalSemanticJson,
  type WorkoutFeatureVector, type WorkoutFeatureVectorV4, type WorkoutFeaturePayloadV4
} from "@rai/contracts";
import { createIdentityNormalizationAdapter, identityNormalizationConfigHash, stableContextHash, type PerformanceNormalizationAdapter } from "@rai/normalization";
import { SpeedWindows } from "./speed-windows.js";
import { extractWorkoutFeatureVector, FEATURE_CONFIG_VERSION, type WorkoutFeatureSource, type FeatureConfigInput } from "./index.js";

/** No clock default: source availability and execution time are caller-owned. */
export function extractWorkoutFeatureVectorV4(
  id: string, runId: string, source: WorkoutFeatureSource,
  config: FeatureConfigInput, computedAt: string,
  normalizer: PerformanceNormalizationAdapter = createIdentityNormalizationAdapter()
): WorkoutFeatureVectorV4 {
  if (!Number.isFinite(Date.parse(computedAt))) throw new Error("V4 requires explicit computedAt");
  // The frozen extractor supplies the existing signal processing and eligibility;
  // recovery facts never enter this path (not even as a dormant scoring field).
  const legacy = extractWorkoutFeatureVector(id, runId, {
    ...source, restingHeartRate: null, hrvSdnn: null, sleepDurationMinutes: null,
    recentLoadMinutes: null, recoveryBaseline: null, recoveryContext: null
  }, config, computedAt);
  const context = source.environment ?? { temperatureC: null, humidityPercent: null, elevationGainMeters: null };
  const validPerformance = source.distanceKm !== null && source.distanceKm > 0 && source.durationSeconds > 0;
  const normalization = validPerformance ? normalizer.normalize({
    id: source.id, distanceMeters: source.distanceKm! * 1000, durationSeconds: source.durationSeconds, context
  }) : null;
  if (normalization && normalization.trace.adapterVersion !== normalizer.version) throw new Error("Normalization adapter version mismatch");
  // Identity must preserve the measured speed, not silently switch from the
  // time-series mean to distance / active duration (which may differ).
  const normalizedSpeed = normalization?.normalized && legacy.signals.paceRawMetersPerSecond !== null
    ? legacy.signals.paceRawMetersPerSecond *
      (normalization.normalized.distanceMeters / (source.distanceKm! * 1000)) *
      (source.durationSeconds / normalization.normalized.durationSeconds) : null;
  const { signals, provenance: _legacyProvenance, ...metadata } = legacy;
  const paired = decoupling(source);
  return {
    ...metadata,
    missingReasons: metadata.missingReasons.filter((reason) => reason !== "recovery_data_missing"),
    provenance: {
      featureConfigVersion: FEATURE_CONFIG_VERSION,
      sourceCategory: source.sourceCategory,
      workoutEndAt: source.workoutEndAt,
      observedMaximumHeartRate: source.observedMaximumHeartRate
    },
    payload: {
      schemaVersion: "workout-feature-v4",
      raw: {
        efficiencyRaw: signals.efficiencyRaw, paceRawMetersPerSecond: signals.paceRawMetersPerSecond,
        stabilityRaw: signals.stabilityRaw, heartRateReserveFraction: signals.heartRateReserveFraction,
        heartRateCoefficientOfVariation: signals.heartRateCoefficientOfVariation,
        speedCoefficientOfVariation: signals.speedCoefficientOfVariation
      },
      normalized: {
        speedMetersPerSecond: normalizedSpeed,
        efficiencySpeedPerBpm: normalizedSpeed !== null && (legacy.averageHeartRateBpm ?? 0) > 0
          ? normalizedSpeed / legacy.averageHeartRateBpm! : null
      },
      normalization: normalization?.trace ?? {
        adapterVersion: "rai-normalization-identity-v1", configHash: identityNormalizationConfigHash(),
        sourceContextHash: stableContextHash(context), status: "unavailable", correctionFraction: null,
        comparability: 0, reasonCodes: ["invalid_distance_or_duration"]
      },
      execution: {
        pacingConsistency: signals.speedCoefficientOfVariation === null ? null : 1 - Math.min(1, signals.speedCoefficientOfVariation),
        heartRateConsistency: signals.heartRateCoefficientOfVariation === null ? null : 1 - Math.min(1, signals.heartRateCoefficientOfVariation),
        aerobicDecouplingPct: legacy.sessionType === "interval" ? null : paired.value,
        pairedCoverage: paired.coverage,
        intervalExecutionQuality: null
      },
      evidenceFlags: [
        ...(normalization?.trace.reasonCodes ?? ["invalid_distance_or_duration"]),
        ...(paired.value === null ? ["paired_steady_evidence_insufficient"] : ["raw_decoupling_not_environment_normalized"]),
        ...(legacy.sessionType === "interval" ? ["interval_not_steady_state"] : [])
      ]
    }
  };
}

function decoupling(source: WorkoutFeatureSource): { value: number | null; coverage: number } {
  const elapsed = (Date.parse(source.workoutEndAt) - Date.parse(source.workoutStartAt)) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < 30 * 60 || elapsed > 24 * 3600) return { value: null, coverage: 0 };
  const speed = new SpeedWindows(source.speedSamples ?? []);
  const heart = new SpeedWindows(source.heartRateSamples ?? []);
  const halves: Array<Array<{ speed: number; heart: number }>> = [[], []];
  for (let at = 5 * 60; at + 60 <= elapsed - 5 * 60; at += 60) {
    const s = speed.summarize(at, at + 60), h = heart.summarize(at, at + 60);
    // Paired complete windows only: no interpolation over missing sensor data.
    if (s.coveredSeconds < 60 || h.coveredSeconds < 60) continue;
    const v = s.weightedValue / s.coveredSeconds, hr = h.weightedValue / h.coveredSeconds;
    if (Number.isFinite(v) && Number.isFinite(hr) && v > 0 && hr > 0) {
      halves[at < elapsed / 2 ? 0 : 1]!.push({ speed: v, heart: hr });
    }
  }
  const coverage = Math.min(1, (halves[0]!.length + halves[1]!.length) * 60 / (elapsed - 600));
  if (coverage < 0.8 || halves.some((half) => half.length < 10)) return { value: null, coverage };
  const ef = halves.map((half) => half.reduce((n, item) => n + item.speed, 0) / half.reduce((n, item) => n + item.heart, 0));
  return { value: 100 * (ef[0]! - ef[1]!) / ef[0]!, coverage };
}

export function encodeFeaturePayloadV4(payload: WorkoutFeaturePayloadV4): string {
  assertPayload(payload);
  return canonicalSemanticJson(payload);
}

function assertPayload(payload: WorkoutFeaturePayloadV4): void {
  if (payload.schemaVersion !== "workout-feature-v4" || !payload.raw || !payload.normalized ||
      !payload.normalization || !payload.execution || !Array.isArray(payload.evidenceFlags)) {
    throw new Error("Invalid V4 feature payload");
  }
  const rawKeys = ["efficiencyRaw", "paceRawMetersPerSecond", "stabilityRaw", "heartRateReserveFraction",
    "heartRateCoefficientOfVariation", "speedCoefficientOfVariation"];
  for (const key of rawKeys) {
    const value = payload.raw[key as keyof typeof payload.raw];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Invalid V4 signal ${key}`);
  }
  if ("recoveryRaw" in payload.raw || "cardioRaw" in payload.raw) throw new Error("Recovery/cardio cannot be V4 scoring signals");
  if (!["applied","not_needed","unavailable","out_of_domain"].includes(payload.normalization.status) ||
      !Number.isFinite(payload.normalization.comparability) || payload.normalization.comparability<0 || payload.normalization.comparability>1 ||
      !Number.isFinite(payload.execution.pairedCoverage) || payload.execution.pairedCoverage<0 || payload.execution.pairedCoverage>1) throw new Error("Invalid V4 evidence metadata");
  for (const object of [payload.normalized,payload.execution]) for (const value of Object.values(object)) {
    if (value !== null && (typeof value!=="number" || !Number.isFinite(value))) throw new Error("Invalid V4 derived signal");
  }
  if ((payload.normalization.status === "unavailable" || payload.normalization.status === "out_of_domain") &&
      Object.values(payload.normalized).some((value)=>value!==null)) throw new Error("Unavailable normalization cannot fabricate values");
  canonicalSemanticJson(payload); // Reject NaN/infinity rather than silently serializing to null.
}

/** Explicit compatibility projection, never an upgrade that fabricates observations. */
export function projectFeatureV4(feature: WorkoutFeatureVectorV4): WorkoutFeatureVector {
  const { payload, ...metadata } = feature;
  assertPayload(payload);
  return {
    ...metadata,
    signals: {
      ...payload.raw,
      efficiencyRaw: payload.normalized.efficiencySpeedPerBpm ?? payload.raw.efficiencyRaw,
      paceRawMetersPerSecond: payload.normalized.speedMetersPerSecond ?? payload.raw.paceRawMetersPerSecond,
      cardioRaw: null, recoveryRaw: null, sleepDurationMinutes: null,
      restingHeartRateBpm: null, hrvSdnnMs: null, recentLoadMinutes: null
    },
    provenance: { ...feature.provenance, featureSchemaVersion: "workout-feature-v4", featurePayloadV4: payload }
  };
}

export function decodeStoredFeature(payloadJson: string, metadata: WorkoutFeatureVector): WorkoutFeatureVector {
  const raw: unknown = JSON.parse(payloadJson);
  if (!raw || typeof raw !== "object") throw new Error("Invalid stored feature");
  if ("schemaVersion" in raw) {
    if (raw.schemaVersion !== "workout-feature-v4") throw new Error("Unsupported feature schema");
    const payload = raw as WorkoutFeaturePayloadV4;
    assertPayload(payload);
    const projected = projectFeatureV4({
      ...metadata, payload,
      provenance: {
        featureConfigVersion: String(metadata.provenance.featureConfigVersion ?? "unknown"),
        sourceCategory: String(metadata.provenance.sourceCategory ?? "unknown"),
        workoutEndAt: String(metadata.provenance.workoutEndAt ?? metadata.workoutStartAt),
        observedMaximumHeartRate: typeof metadata.provenance.observedMaximumHeartRate === "number"
          ? metadata.provenance.observedMaximumHeartRate : null
      }
    });
    assertWorkoutFeatureVector(projected);
    return projected;
  }
  // §3.3: a V3 payload carries no decoupling/environment/normalization evidence. Keep the
  // legacy fields verbatim (never fabricate V4 observations) but mark the read, so the record
  // cannot be consumed as a full V4 Fitness learning sample and is distinguishable from a
  // genuine V4 read. The marker is added at read time only; nothing is written back.
  const legacy: WorkoutFeatureVector = {
    ...metadata,
    signals: raw as WorkoutFeatureVector["signals"],
    missingReasons: metadata.missingReasons.includes("unavailable_in_legacy_feature")
      ? metadata.missingReasons
      : [...metadata.missingReasons, "unavailable_in_legacy_feature"],
    provenance: { ...metadata.provenance, featureSchemaVersion: "workout-feature-v3-legacy" }
  };
  for (const key of ["efficiencyRaw", "paceRawMetersPerSecond", "cardioRaw", "stabilityRaw", "recoveryRaw",
    "heartRateReserveFraction", "heartRateCoefficientOfVariation", "speedCoefficientOfVariation",
    "sleepDurationMinutes", "restingHeartRateBpm", "hrvSdnnMs", "recentLoadMinutes"]) {
    if (!(key in legacy.signals)) throw new Error(`Legacy feature signal missing: ${key}`);
  }
  assertWorkoutFeatureVector(legacy);
  return legacy;
}

/**
 * §3.3 classification for a decoded feature. Absence of an explicit V4 stamp is treated as
 * legacy, so an unstamped record is never mistaken for full V4 evidence.
 */
export function storedFeatureSchema(feature: WorkoutFeatureVector): "workout-feature-v4" | "workout-feature-v3-legacy" {
  return feature.provenance.featureSchemaVersion === "workout-feature-v4"
    ? "workout-feature-v4" : "workout-feature-v3-legacy";
}
