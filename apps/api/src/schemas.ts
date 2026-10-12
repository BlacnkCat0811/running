import { workoutExportQuerySchema } from "./workout-summary-export.js";
import { DATABASE_TIMEZONE, MOBILE_SESSION_KINDS } from "@rai/contracts";

import {
  MAX_ALERT_HEART_RATE_BPM,
  MAX_ALERT_PACE_SECONDS_PER_KM,
  MAX_BLOCK_ITERATIONS,
  MAX_BLOCKS,
  MAX_PLANNED_DISTANCE_KM,
  MAX_STEP_METERS,
  MAX_STEP_SECONDS
} from "./session-structure.js";

const identifier = { type: "string", minLength: 1, maxLength: 160 } as const;
export const planOperationScopeSchema = {
  type: "object", additionalProperties: false, required: ["serverId", "athleteId", "datasetEpoch"],
  properties: { serverId: { type: "string", minLength: 1, maxLength: 256 }, athleteId: { type: "string", minLength: 1, maxLength: 256 },
    datasetEpoch: { type: "string", minLength: 1, maxLength: 256 } }
} as const;

export const identifierParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: identifier }
} as const;

export const backupParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 8, maxLength: 240, pattern: "^[^/\\\\]+\\.sqlite$" }
  }
} as const;

export const workoutListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    localDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    limit: { type: "string", pattern: "^[0-9]{1,3}$" },
    offset: { type: "string", pattern: "^[0-9]{1,9}$" },
    status: { type: "string", enum: ["eligible", "trial", "excluded"] },
    sessionType: {
      type: "string",
      enum: ["easy", "steady", "tempo", "interval", "long_run", "race", "recovery", "unknown"]
    },
    stimulusType: {
      type: "string",
      enum: ["recovery", "aerobic_base", "marathon_pace", "lactate_threshold", "vo2max", "anaerobic_endurance", "unclassified"]
    },
    participation: { type: "string", enum: ["included", "not_included"] },
    environment: { type: "string", enum: ["outdoor", "indoor", "unknown"] },
    days: { type: "string", enum: ["28", "90", "365", "4000"] },
    sourceGroup: { type: "string", enum: ["apple_watch", "third_party", "manual"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    route: { type: "string", enum: ["available", "missing"] }
  }
} as const;

export const trendQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { days: { type: "string", pattern: "^[0-9]{1,4}$" } }
} as const;

export const recoveryTrendQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    days: { type: "string", pattern: "^(?:[1-9]|[1-9][0-9]|[12][0-9]{2}|3[0-5][0-9]|36[0-5])$" }
  }
} as const;

export const trainingStatisticsHistoryQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["granularity"],
  properties: {
    granularity: { type: "string", enum: ["week", "month", "year"] },
    limit: { type: "string", pattern: "^[0-9]{1,3}$" }
  }
} as const;

export const trainingLoadQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { days: { type: "string", pattern: "^[0-9]{1,4}$" } }
} as const;

export const trainingZonesHistoryQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { days: { type: "string", pattern: "^[0-9]{1,4}$" } }
} as const;

const mobileRaceTargetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["date", "distance"],
  properties: {
    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    distance: { type: "string", enum: ["five_k", "ten_k", "half_marathon"] },
    targetPaceSecondsPerKm: { anyOf: [{ type: "number", minimum: 150, maximum: 900 }, { type: "null" }] }
  }
} as const;

export const runCoachCommandSchema = {
  type: "object", additionalProperties: false, required: ["expectedRevision", "action"],
  properties: {
    operationId: { type: "string", format: "uuid" },
    operationScope: planOperationScopeSchema,
    expectedRevision: { type: "integer", minimum: 0 },
    action: { type: "string", enum: ["start", "update", "refresh", "pause", "resume", "end"] },
    config: { type: "object", additionalProperties: false,
      required: ["goal", "raceDate", "raceDistanceKm", "targetTimeSeconds", "runningDays", "longRunDays", "targetType", "strengthTraining"],
      properties: {
        goal: { type: "string", enum: ["fitness", "finish", "time"] },
        raceDate: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
        raceDistanceKm: { anyOf: [{ type: "number", minimum: 1.6, maximum: 1609.344 }, { type: "null" }] },
        targetTimeSeconds: { anyOf: [{ type: "number", minimum: 240, maximum: 1_500_000 }, { type: "null" }] },
        runningDays: { type: "array", minItems: 3, maxItems: 7, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 7 } },
        longRunDays: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 7 } },
        targetType: { type: "string", enum: ["pace", "heart_rate"] }, strengthTraining: { type: "boolean" },
        durationWeeks: { type: "integer", minimum: 6, maximum: 52 }
      }
    }
  }
} as const;

export const coachLoopCommandSchema = {
  type: "object", additionalProperties: false,
  required: ["contractVersion", "operationId", "operationScope", "expectedRevision", "expectedFactsHash", "action"],
  properties: {
    contractVersion: { const: 1 }, operationId: { type: "string", format: "uuid" }, operationScope: planOperationScopeSchema,
    expectedRevision: { type: "integer", minimum: 0 }, expectedFactsHash: { type: "string", minLength: 1, maxLength: 200 },
    action: { enum: ["enable", "refresh", "update", "pause", "resume", "end"] },
    acceptedPolicyHash: { type: "string", minLength: 1, maxLength: 200 },
    settings: { type: "object", additionalProperties: false,
      required: ["mode", "runningDays", "longRunDays", "availabilityMinutesByWeekday", "targetType", "race"],
      properties: {
        mode: { enum: ["daily_adaptive", "race_preparation"] },
        runningDays: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 7 } },
        longRunDays: { type: "array", maxItems: 7, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 7 } },
        availabilityMinutesByWeekday: { type: "object", additionalProperties: false,
          patternProperties: { "^[1-7]$": { anyOf: [{ type: "integer", minimum: 10, maximum: 240 }, { type: "null" }] } } },
        targetType: { enum: ["pace", "heart_rate"] },
        race: { anyOf: [runCoachCommandSchema.properties.config, { type: "null" }] }
      }
    }
  }
} as const;

/**
 * Alert bounds depend on the alert kind: pace is seconds per kilometre and heart
 * rate is beats per minute, so one shared ceiling would let a body-invalid heart
 * rate through. Both ceilings mirror `session-structure.ts`, which clamps the
 * same values again on the way into the store.
 */
const mobileStepAlertSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { const: "pace" },
        lower: {
          anyOf: [
            { type: "number", minimum: 1, maximum: MAX_ALERT_PACE_SECONDS_PER_KM },
            { type: "null" }
          ]
        },
        upper: {
          anyOf: [
            { type: "number", minimum: 1, maximum: MAX_ALERT_PACE_SECONDS_PER_KM },
            { type: "null" }
          ]
        }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { const: "heart_rate" },
        lower: {
          anyOf: [{ type: "number", minimum: 1, maximum: MAX_ALERT_HEART_RATE_BPM }, { type: "null" }]
        },
        upper: {
          anyOf: [{ type: "number", minimum: 1, maximum: MAX_ALERT_HEART_RATE_BPM }, { type: "null" }]
        }
      }
    }
  ]
} as const;

/**
 * Goals are discriminated on `type`, so `meters` belongs to `distance` and
 * `seconds` to `time` — a `time` goal carrying `meters` is rejected here rather
 * than silently normalized away downstream.
 */
const mobileStepGoalSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "meters"],
      properties: {
        type: { const: "distance" },
        meters: { type: "number", minimum: 1, maximum: MAX_STEP_METERS }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "seconds"],
      properties: {
        type: { const: "time" },
        seconds: { type: "number", minimum: 1, maximum: MAX_STEP_SECONDS }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: { type: { const: "open" } }
    }
  ]
} as const;

const mobileWorkoutStepSchema = {
  type: "object",
  additionalProperties: false,
  required: ["purpose", "goal"],
  properties: {
    purpose: { type: "string", enum: ["warmup", "work", "recovery", "cooldown"] },
    goal: mobileStepGoalSchema,
    alert: { anyOf: [mobileStepAlertSchema, { type: "null" }] }
  }
} as const;

const mobileSessionStructureSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    warmup: { anyOf: [mobileWorkoutStepSchema, { type: "null" }] },
    blocks: {
      type: "array",
      maxItems: MAX_BLOCKS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["iterations", "steps"],
        properties: {
          iterations: { type: "integer", minimum: 1, maximum: MAX_BLOCK_ITERATIONS },
          steps: { type: "array", minItems: 1, maxItems: 8, items: mobileWorkoutStepSchema }
        }
      }
    },
    cooldown: { anyOf: [mobileWorkoutStepSchema, { type: "null" }] }
  }
} as const;

const mobileWeekPlanItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["localDate", "kind"],
  properties: {
    localDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    kind: { type: "string", enum: [...MOBILE_SESSION_KINDS] },
    distanceKm: { anyOf: [{ type: "number", minimum: 0, maximum: MAX_PLANNED_DISTANCE_KM }, { type: "null" }] },
    structure: { anyOf: [mobileSessionStructureSchema, { type: "null" }] },
    reason: { anyOf: [{ type: "string", maxLength: 400 }, { type: "null" }] }
  }
} as const;

export const mobileLockBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    operationId: { type: "string", format: "uuid" },
    operationScope: planOperationScopeSchema,
    action: { type: "string", enum: ["lock", "relock"] },
    expectedRevision: { type: "string", minLength: 8, maxLength: 128 }
  }
} as const;

export const mobileWeeklyPlanGenerateBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    expectedRevision: { type: "integer", minimum: 0 }
  }
} as const;

export const mobileWeeklyPlanPreviewBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision"],
  properties: {
    expectedRevision: { type: "integer", minimum: 0 }
  }
} as const;

/**
 * Receipt for a client-verified local system workout schedule. It is not
 * proof that the physical paired Watch received the day.
 *
 * `structure` is optional because the phone may sync a day whose structure it
 * did not receive (a manually built session); the date and kind are the parts
 * the segment matcher actually needs.
 */
export const mobilePlanSyncedBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["localDate", "kind"],
  properties: {
    contractVersion: { const: 2 },
    scope: { type: "object", additionalProperties: false, required: ["serverId", "athleteId", "datasetEpoch"],
      properties: { serverId: { type: "string", minLength: 1 }, athleteId: { type: "string", minLength: 1 }, datasetEpoch: { type: "string", minLength: 1 } } },
    operationId: { type: "string", format: "uuid" },
    coherenceToken: { type: "string", pattern: "^[a-f0-9]{64}$" },
    verifiedAt: { type: "string", format: "date-time" },
    timezone: { const: DATABASE_TIMEZONE },
    prescriptionDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    lifecycleEvent: { type: "string", enum: ["verified", "withdrawn", "replaced"] },
    localDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    kind: { type: "string", enum: [...MOBILE_SESSION_KINDS] },
    revision: { type: "integer", minimum: 0, maximum: 1_000_000 },
    structure: { anyOf: [mobileSessionStructureSchema, { type: "null" }] },
    workoutID: { type: "string", format: "uuid" },
    scheduledAt: { type: "string", format: "date-time" },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
    exportNotes: { type: "array", maxItems: 16, items: { type: "string", maxLength: 256 } }
  }
} as const;

export const coachLoopSyncedBodySchema = {
  ...mobilePlanSyncedBodySchema,
  required: ["contractVersion", "scope", "operationId", "coherenceToken", "workoutID", "scheduledAt",
    "verifiedAt", "timezone", "prescriptionDigest", "lifecycleEvent", "structure", "revision", "localDate",
    "kind", "idempotencyKey", "coachLoop"],
  properties: { ...mobilePlanSyncedBodySchema.properties, coachLoop: {
    type: "object", additionalProperties: false, required: ["contractVersion", "policyHash", "decisionRef"],
    properties: { contractVersion: { const: 1 }, policyHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      decisionRef: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] } }
  } }
} as const;

const optionalFeedbackEnum = <T extends string>(values: readonly T[]) => ({
  anyOf: [{ type: "string", enum: values }, { type: "null" }]
} as const);
export const coachFeedbackFieldsSchema = {
  type: "object", additionalProperties: false,
  required: ["phase", "observedAt", "workoutId", "fatigue", "soreness", "discomfort", "requestedAction",
    "interruptionReason", "replacementReason", "rpeOverrideRef"],
  properties: {
    phase: { enum: ["pre_run", "post_run"] }, observedAt: { type: "string", format: "date-time" },
    workoutId: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
    fatigue: optionalFeedbackEnum(["usual", "elevated", "high"]),
    soreness: optionalFeedbackEnum(["none", "mild", "marked"]),
    discomfort: optionalFeedbackEnum(["none", "present"]),
    requestedAction: optionalFeedbackEnum(["none", "easy_only", "rest"]),
    interruptionReason: optionalFeedbackEnum(["time_constraint", "fatigue", "discomfort", "weather", "equipment", "other"]),
    replacementReason: optionalFeedbackEnum(["time_constraint", "preference", "fatigue", "discomfort", "other"]),
    rpeOverrideRef: { anyOf: [{ type: "object", additionalProperties: false, required: ["workoutId", "revision"],
      properties: { workoutId: { type: "string", minLength: 1 }, revision: { type: "integer", minimum: 1 } } }, { type: "null" }] }
  }
} as const;

export const mobileGoalsBodySchema = {
  type: "object",
  additionalProperties: false,
  // Nothing is required: every goal is optional and the store merges whatever it
  // is given. `weeklyDistanceKm` used to be the one mandatory field; it is gone
  // with the stored weekly goal, and a client that still sends it now fails on
  // `additionalProperties` — which is the intended signal that it no longer exists.
  properties: {
    operationId: { type: "string", format: "uuid" },
    operationScope: planOperationScopeSchema,
    expectedRevision: { type: "integer", minimum: 0 },
    easyDurationFloorFraction: { type: "number", minimum: 0.4, maximum: 0.95 },
    qualitySessionCap: { type: "integer", minimum: 0, maximum: 4 },
    raceTarget: { anyOf: [mobileRaceTargetSchema, { type: "null" }] },
    weekPlan: { type: "array", maxItems: 14, items: mobileWeekPlanItemSchema }
  }
} as const;

const automaticOrManualNumber = (minimum: number, maximum: number, valueName: string) => ({
  oneOf: [
    {
      type: "object" as const,
      additionalProperties: false,
      required: ["mode", valueName],
      properties: {
        mode: { const: "auto" },
        [valueName]: { type: "null" as const }
      }
    },
    {
      type: "object" as const,
      additionalProperties: false,
      required: ["mode", valueName],
      properties: {
        mode: { const: "manual" },
        [valueName]: { type: "number" as const, minimum, maximum }
      }
    }
  ]
});

export const trainingZoneProfileBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "restingHeartRate", "maximumHeartRate", "lactateThresholdPace"],
  properties: {
    expectedRevision: { type: "integer", minimum: 0 },
    restingHeartRate: automaticOrManualNumber(35, 110, "valueBpm"),
    maximumHeartRate: automaticOrManualNumber(120, 230, "valueBpm"),
    lactateThresholdPace: automaticOrManualNumber(150, 900, "valueSecondsPerKm")
  }
} as const;

/**
 * Privacy zones (docs/DECISIONS.md D9).
 *
 * `revision` is required, not optional: a write that does not say which version it
 * read is a write that can silently drop a zone somebody just added, and here that
 * means an unredacted card rather than a lost preference.
 */
export const privacyZonesBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["revision", "stateToken", "zones"],
  properties: {
    revision: { type: "integer", minimum: 0 },
    stateToken: { type: "string", pattern: "^[a-f0-9]{64}$" },
    zones: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "centerLatitude", "centerLongitude", "radiusMeters", "createdAt"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          label: { type: "string", minLength: 1, maxLength: 64 },
          centerLatitude: { type: "number", minimum: -90, maximum: 90 },
          centerLongitude: { type: "number", minimum: -180, maximum: 180 },
          radiusMeters: { type: "number", exclusiveMinimum: 0, maximum: 5000 },
          createdAt: { type: "string", minLength: 1, maxLength: 40 }
        }
      }
    }
  }
} as const;

/**
 * §12.10 manually entered race results.
 *
 * The bounds mirror `performance-entry-repository`: a client cannot talk the API into
 * an entry the repository would refuse, and the API cannot accept one the repository
 * would reject later (they must not disagree about what a race result can be).
 */
export const performanceEntryBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["localDate", "distance", "durationSeconds"],
  properties: {
    localDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    distance: { type: "string", enum: ["five_k", "ten_k", "half_marathon"] },
    durationSeconds: { type: "number", exclusiveMinimum: 0, maximum: 14400 },
    trainingSessionId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
    note: { type: ["string", "null"], maxLength: 200 }
  }
} as const;

export const predictionQuerySchema = {
  type: "object",
  additionalProperties: false,
  allOf: [
    {
      if: { required: ["mode"], properties: { mode: { const: "race_day_scenario" } } },
      then: { required: ["targetDate"] },
      else: { not: { required: ["targetDate"] } }
    }
  ],
  properties: {
    mode: { type: "string", enum: ["neutral_potential", "current_prepared", "race_day_scenario"] },
    targetDate: { type: "string", format: "date" },
    temperatureC: { type: "number", minimum: -40, maximum: 60 },
    humidityPercent: { type: "number", minimum: 0, maximum: 100 },
    elevationGain5k: { type: "number", minimum: 0, maximum: 10000 },
    elevationGain10k: { type: "number", minimum: 0, maximum: 10000 },
    elevationGainHalfMarathon: { type: "number", minimum: 0, maximum: 10000 }
  }
} as const;

export const predictionModelTrainBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    asOf: {
      type: "string",
      format: "date-time",
      minLength: 20,
      maxLength: 35,
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$"
    },
    // §12.12 训练范围：缺省 population（老客户端不因为升级就换成更低的门槛）。
    scope: { type: "string", enum: ["population", "personal"] }
  }
} as const;

export const predictionModelIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: {
      type: "string",
      pattern: "^prediction_model_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  }
} as const;

export const modelComparisonQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["base", "candidate"],
  properties: { base: identifier, candidate: identifier }
} as const;

export const overrideBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["eligibilityOverride", "statisticsParticipation", "sessionType", "performanceProtocol", "rpe", "conditionTags", "note"],
  properties: {
    expectedRevision: { type: "integer", minimum: 0 },
    eligibilityOverride: { anyOf: [{ type: "string", enum: ["include", "exclude"] }, { type: "null" }] },
    statisticsParticipation: { anyOf: [{ type: "string", enum: ["include", "exclude"] }, { type: "null" }] },
    sessionType: {
      anyOf: [
        { type: "string", enum: ["easy", "steady", "tempo", "interval", "long_run", "race", "recovery", "unknown"] },
        { type: "null" }
      ]
    },
    performanceProtocol: {
      anyOf: [
        {
          type: "string",
          enum: [
            "five_k_time_trial",
            "ten_k_time_trial",
            "thirty_min_threshold",
            "half_marathon_race",
            "other_race"
          ]
        },
        { type: "null" }
      ]
    },
    rpe: { anyOf: [{ type: "integer", minimum: 1, maximum: 10 }, { type: "null" }] },
    conditionTags: {
      type: "array",
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 80 }
    },
    note: { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }] }
  }
} as const;

export const importSourceBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceId"],
  properties: {
    sourceId: { type: "string", minLength: 1, maxLength: 160 }
  }
} as const;

export const commandBodySchema = {
  type: "object", additionalProperties: false,
  required: ["idempotencyKey", "kind", "payload"],
  properties: {
    idempotencyKey: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._-]+$" },
    kind: { type: "string", enum: ["workout_override", "training_zones", "recompute", "prediction_training", "activate_model", "activate_prediction"] },
    payload: { type: "object" }
  },
  allOf: [
    { if: { properties: { kind: { const: "workout_override" } } }, then: { properties: { payload: {
      ...overrideBodySchema, required: [...overrideBodySchema.required, "trainingSessionId"],
      properties: { ...overrideBodySchema.properties, trainingSessionId: identifier }
    } } } },
    { if: { properties: { kind: { const: "training_zones" } } }, then: { properties: { payload: trainingZoneProfileBodySchema } } },
    { if: { properties: { kind: { const: "prediction_training" } } }, then: { properties: { payload: predictionModelTrainBodySchema } } },
    { if: { properties: { kind: { const: "recompute" } } }, then: { properties: { payload: { type: "object", additionalProperties: false, properties: {} } } } },
    { if: { properties: { kind: { enum: ["activate_model", "activate_prediction"] } } }, then: { properties: { payload: {
      type: "object", additionalProperties: false, required: ["id"], properties: { id: identifier }
    } } } }
  ]
} as const;

const commandResponseSchema = {
  type: "object", required: ["id", "kind", "status", "createdAt", "completedAt"],
  properties: {
    id: { type: "string" }, kind: { type: "string" }, status: { type: "string" },
    createdAt: { type: "string" }, completedAt: { type: ["string", "null"] },
    result: {}, error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } }
  }
};
export const importJobBodySchema = {
  ...importSourceBodySchema
} as const;

export const deleteBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["confirmation"],
  properties: { confirmation: { type: "string", maxLength: 40 } }
} as const;

export const restoreBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["confirmation"],
  properties: { confirmation: { type: "string", maxLength: 40 } }
} as const;

const objectSchema = (...required: string[]) => ({
  type: "object" as const,
  additionalProperties: true,
  required,
  properties: Object.fromEntries(required.map((name) => [name, {}]))
});
const arraySchema = (...required: string[]) => ({
  type: "array" as const,
  items: objectSchema(...required)
});
const importJobSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "importMode", "insertedWorkouts", "updatedWorkouts", "removedWorkouts", "unchangedWorkouts",
    "routesUpdated", "featuresReused", "featuresRecomputed", "modelReplayFrom", "durationMs", "backupName"
  ],
  properties: {
    recomputeReasons: { type: "array", items: { type: "string" } },
    importMode: { type: "string", enum: ["unchanged", "incremental", "full"] },
    insertedWorkouts: { type: "integer" },
    updatedWorkouts: { type: "integer" },
    removedWorkouts: { type: "integer" },
    unchangedWorkouts: { type: "integer" },
    routesUpdated: { type: "integer" },
    featuresReused: { type: "integer" },
    featuresRecomputed: { type: "integer" },
    modelReplayFrom: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    durationMs: { type: "number", minimum: 0 },
    backupName: { anyOf: [{ type: "string" }, { type: "null" }] }
  }
} as const;
const importJobResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "status", "phase", "message", "createdAt", "completedAt", "error"],
  properties: {
    executionEngine: {
      type: "object", required: ["name", "version", "fallback"],
      properties: { name: { type: "string", enum: ["typescript", "rust"] }, version: { type: "string" }, fallback: { type: "string", enum: ["none", "typescript"] } }
    },
    id: { type: "string" },
    sourceId: { type: "string" },
    status: { type: "string" },
    phase: { type: "string" },
    message: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    completedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    error: { anyOf: [{ type: "string" }, { type: "null" }] },
    progress: { type: "number", minimum: 0, maximum: 1 },
    queuePosition: { type: "integer", minimum: 1 },
    waitingReason: { type: "string", enum: ["writer_busy"] },
    performance: {
      type: "object",
      additionalProperties: false,
      required: ["validationMode", "totalMs", "stagesMs"],
      properties: {
        validationMode: { type: "string", enum: ["shadow", "off", "not-run"] },
        totalMs: { type: "number", minimum: 0 },
        computeStagesMs: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
        computeProcessMaxRssKiB: { type: "number", minimum: 0 },
        native: { type: "object", additionalProperties: {
          type: "object", properties: {
            rustCalls: { type: "integer", minimum: 0 }, typescriptFallbacks: { type: "integer", minimum: 0 },
            wallMs: { type: "number", minimum: 0 }, peakRssKiB: { type: "number", minimum: 0 }
          }
        } },
        stagesMs: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            ["dataOnlyApply", "backupCapacity", "backupCopy", "backupVerify", "stagingCopy", "parseImport",
              "changeAnalysis", "recompute", "activationAudit", "activationSwap", "cleanup"]
              .map((stage) => [stage, { type: "number", minimum: 0 }])
          )
        }
      }
    },
    summary: importJobSummarySchema
  }
} as const;
const successSchema = (summary: string): Record<string, unknown> => {
  const objects: Record<string, string[]> = {
    "OpenAPI 3.1 契约": ["openapi", "info", "paths"],
    "本地服务健康状态": ["status", "databaseReady", "localOnly", "now"],
    "概览数据": ["generatedAt", "totals"],
    "SQLite 数据资产摘要": ["datasetVersion", "issues"],
    "导入、canonical 与特征质量审计": ["generatedAt", "canonical"],
    "导出移除路线与健康时序的本地诊断 JSON": ["generatedAt", "privacy"],
    "全局导入与重算状态": ["databaseReady", "busy", "recomputeJob", "importJob"],
    "分页训练列表": ["items", "total", "limit", "offset"],
    "同一冻结事实视图中的目标、今日、滚动执行窗口与教练摘要": ["metadata", "availability", "goals", "today", "workoutPlan", "coachSummary"],
    "查询原发布操作：committed、notFound 或 expired": ["status", "operationId"],
    "训练详情": ["workout", "dimensions"],
    "训练内时间序列": ["trainingSessionId", "series"],
    "追加训练覆盖 revision 并重算": ["overrideId", "jobId"],
    "CA、TA、Decay 与 GV 趋势": ["startDate", "endDate", "daily", "workouts"],
    "当前周、月、年及滚动负荷摘要": ["generatedAt", "week", "month", "year"],
    "周、月、年训练统计历史": ["generatedAt", "granularity", "periods"],
    "每日训练负荷与状态时间线": ["generatedAt", "days"],
    "今日心率与配速分区": ["generatedAt", "profile", "settings"],
    "历史心率与配速分区": ["generatedAt", "profiles"],
    "更新心率与配速分区设置": ["revision", "effectiveFromLocalDate"],
    "VO₂max、乳酸阈值与比赛成绩预测": ["reportVersion", "generatedAt", "snapshot"],
    "CatBoost 预测模型运行历史": ["runs"],
    "预测模型运行详情与阶段事件": ["run", "events"],
    "创建 CatBoost 训练任务；通过离线门槛后直接激活": ["runId", "status"],
    "回滚并激活验证成功的历史预测模型": ["activePredictionModelRunId"],
    "取消预测模型训练任务": ["cancelRequested", "status"],
    "量化比较两个不可变模型运行": ["base", "candidate", "metrics"],
    "创建完整重算任务": ["jobId"],
    "激活成功的历史模型运行": ["activeModelRunId"],
    "任务与阶段事件": ["id", "status", "events"],
    "请求取消任务": ["cancelRequested", "status"],
    "从已检查的 Apple Health 来源导入": ["id", "status", "phase", "message"],
    "导入任务状态": ["id", "status", "phase", "message"],
    "最近的导入任务": ["id", "status", "phase", "message"],
    "流式上传并安全解压 Apple Health ZIP": ["sourceId", "uploadId", "fileName", "sizeBytes"],
    "预检已上传或本机导入来源": ["sourceId", "status", "exportFileName", "routeFileCount"],
    "发现常用目录中的 Apple Health 导出": ["sources"],
    "最近成功使用的导入来源": ["sources"],
    "创建 SQLite 在线备份": ["name", "sizeBytes", "createdAt"],
    "校验并原子恢复本地 SQLite 备份": ["restored", "restoredBackup", "safetyBackup"],
    "备份后删除当前本地数据库": ["deleted", "preservation"]
  };
  const arrays: Record<string, string[]> = {
    "模型运行历史": ["id", "status"],
    "重算任务历史": ["id", "status"],
    "本地备份列表": ["name", "sizeBytes", "createdAt"]
  };
  if (summary === "当前运行中的导入任务" || summary === "最近的导入任务") {
    return { anyOf: [{ $ref: "#/components/schemas/ImportJobResponse" }, { type: "null" }] };
  }
  if (summary === "从已检查的 Apple Health 来源导入" || summary === "导入任务状态") {
    return { $ref: "#/components/schemas/ImportJobResponse" };
  }
  const arrayFields = arrays[summary];
  if (arrayFields) return arraySchema(...arrayFields);
  return objectSchema(...(objects[summary] ?? ["message"]));
};
const jsonResponse = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { "application/json": { schema } }
});
const errorResponse = {
  description: "请求无效或资源状态冲突",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
};
const responses = (summary: string, description = "成功") => ({
  "200": jsonResponse(description, successSchema(summary)),
  "400": errorResponse,
  "403": errorResponse,
  "404": errorResponse,
  "409": errorResponse,
  "413": errorResponse,
  "415": errorResponse,
  "422": errorResponse
});
const operation = (
  tags: string[],
  summary: string,
  extras: Record<string, unknown> = {}
) => ({ tags, summary, responses: responses(summary), ...extras });
const pathId = [{
  name: "id", in: "path", required: true,
  schema: identifier,
  description: "资源标识符"
}];
const body = (schema: unknown, description: string) => ({
  required: true,
  description,
  content: { "application/json": { schema } }
});

export const openapiDocument = {
  openapi: "3.1.0",
  info: {
    title: "RAI Local API",
    version: "0.1.0",
    description: "仅监听 127.0.0.1 的单用户跑步能力分析 API。评分结果全部来自 SQLite active 视图。"
  },
  servers: [{ url: "http://127.0.0.1:8787", description: "本机" }],
  tags: [
    { name: "Read", description: "active 数据读取" },
    { name: "Workouts", description: "训练与用户覆盖" },
    { name: "Jobs", description: "导入和重算" },
    { name: "Maintenance", description: "本地备份与删除" }
  ],
  components: {
    schemas: {
      Error: {
        type: "object", required: ["message"], additionalProperties: true,
        properties: { code: { type: "string" }, message: { type: "string" } }
      },
      ImportJobRequest: importJobBodySchema,
      ImportJobResponse: importJobResponseSchema,
      WorkoutOverride: overrideBodySchema,
      TrainingZoneProfileUpdate: trainingZoneProfileBodySchema,
      PrivacyZonesUpdate: privacyZonesBodySchema,
      PerformanceEntryCreate: performanceEntryBodySchema,
      PredictionModelTrainRequest: predictionModelTrainBodySchema,
      DeleteDatabaseRequest: deleteBodySchema,
      RestoreBackupRequest: restoreBodySchema,
      MobileGoalsUpdate: mobileGoalsBodySchema,
      MobileLock: mobileLockBodySchema,
      MobileWeeklyPlanGenerate: mobileWeeklyPlanGenerateBodySchema,
      MobilePlanSynced: mobilePlanSyncedBodySchema
    }
  },
  paths: {
    "/v1/mobile/coach-loop": {
      get: operation(["Read"], "版本化教练聚合：S/H、有效课表、反馈和执行评价；无写副作用"),
      post: operation(["Workouts"], "显式确认规则并启用、刷新、暂停或结束持续/比赛训练；原子发布追加课", {
        requestBody: body(coachLoopCommandSchema, "合同版本、数据域、规则确认及CAS/事实令牌")
      })
    },
    "/v1/mobile/coach-execution": { get: operation(["Read"], "过去28日冻结处方的观测、剂量和刺激评价") },
    "/v1/mobile/coach-loop/synced": { post: operation(["Workouts"], "核验今天新版教练授权的实际系统导出；保留失效回执与撤回账目，不代表手表收件", {
      requestBody: body(coachLoopSyncedBodySchema, "旧系统排期核验字段及新版规则/追加授权身份")
    }) },
    "/v1/mobile/coach-feedback": { post: operation(["Workouts"], "自愿提交/追加修订/撤回主观反馈，不触发Fitness重算", {
      requestBody: body({ type: "object", required: ["operationId", "operationScope", "id", "expectedRevision", "action", "consent"],
        properties: { operationId: { type: "string", format: "uuid" }, operationScope: planOperationScopeSchema,
          id: { type: "string" }, expectedRevision: { type: "integer" }, action: { enum: ["save", "retract"] },
          consent: { const: true }, fields: coachFeedbackFieldsSchema } }, "幂等操作、反馈修订和显式采集同意")
    }) },
    "/v1/mobile/coach-prediction-refresh": { post: operation(["Workouts"], "显式异步计算既有预测，提取兼容的教练摘要；GET不计算", {
      requestBody: body({ type: "object", additionalProperties: false, required: ["operationScope"],
        properties: { operationScope: planOperationScopeSchema } }, "当前数据域身份")
    }) },
    "/v1/performance": { get: operation(["Jobs"], "进程性能与调度状态", {
      responses: { ...responses("进程性能与调度状态"), "200": jsonResponse("进程性能", {
        type: "object", required: ["uptimeMs", "requests", "admission"],
        properties: { uptimeMs: { type: "number" }, requests: { type: "integer" }, admission: { type: "object" } }
      }) }
    }) },
    "/v1/openapi.json": { get: operation(["Read"], "OpenAPI 3.1 契约") },
    "/v1/health": { get: operation(["Read"], "本地服务健康状态") },
    "/v1/dashboard": { get: operation(["Read"], "概览数据") },
    "/v1/data-summary": { get: operation(["Read"], "SQLite 数据资产摘要") },
    "/v1/data-audit": { get: operation(["Read"], "导入、canonical 与特征质量审计") },
    "/v1/diagnostics": { get: operation(["Maintenance"], "导出移除路线与健康时序的本地诊断 JSON") },
    "/v1/runtime-status": { get: operation(["Jobs"], "全局导入与重算状态") },
    "/v1/exports/workout-summary": { get: operation(["Workouts"], "鉴权训练摘要 CSV（JSON 封装，无路线、备注或健康原始值）", {
      parameters: Object.entries(workoutExportQuerySchema.properties).map(([name, schema]) => ({ name, in: "query", required: true, schema }))
    }) },
    "/v1/workouts": { get: operation(["Workouts"], "分页训练列表", {
      parameters: Object.entries(workoutListQuerySchema.properties).map(([name, schema]) => ({
        name, in: "query", required: false, schema
      }))
    }) },
    "/v1/workouts/{id}": { get: operation(["Workouts"], "训练详情", { parameters: pathId }) },
    "/v1/workouts/{id}/series": { get: operation(["Workouts"], "训练内时间序列", { parameters: pathId }) },
    "/v1/workouts/{id}/share-card": { get: operation(["Workouts"], "分享卡片（服务端已按隐私区裁剪轨迹）", { parameters: pathId }) },
    "/v1/label-funnel": { get: operation(["Labels"], "标签漏斗与个人校准进度（不含区间）") },
    "/v1/performance-entries": {
      get: operation(["Labels"], "读取手工成绩条目（含已撤销，便于对账）"),
      post: operation(["Labels"], "录入手工成绩条目（仅作标签/评估证据）", {
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PerformanceEntryCreate" } } } }
      })
    },
    "/v1/performance-entries/{id}": {
      delete: operation(["Labels"], "撤销成绩条目（墓碑，不删除行）", { parameters: pathId })
    },
    "/v1/privacy-zones": {
      get: operation(["Privacy"], "读取隐私区与 revision"),
      put: operation(["Privacy"], "整体替换隐私区（expectedRevision 冲突返回 409）", {
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PrivacyZonesUpdate" } } } }
      })
    },
    "/v1/workouts/{id}/override": { patch: operation(["Workouts"], "追加训练覆盖 revision 并重算", {
      parameters: pathId,
      requestBody: body({ $ref: "#/components/schemas/WorkoutOverride" }, "完整的训练覆盖字段")
    }) },
    "/v1/trends": { get: operation(["Read"], "CA、TA、Decay 与 GV 趋势", {
      parameters: [{ name: "days", in: "query", schema: trendQuerySchema.properties.days }]
    }) },
    "/v1/training-statistics/overview": { get: operation(["Read"], "当前周、月、年及滚动负荷摘要") },
    "/v1/training-statistics/history": { get: operation(["Read"], "周、月、年训练统计历史", {
      parameters: [
        { name: "granularity", in: "query", required: true, schema: trainingStatisticsHistoryQuerySchema.properties.granularity },
        { name: "limit", in: "query", schema: trainingStatisticsHistoryQuerySchema.properties.limit }
      ]
    }) },
    "/v1/training-statistics/load": { get: operation(["Read"], "每日训练负荷与状态时间线", {
      parameters: [{ name: "days", in: "query", schema: trainingLoadQuerySchema.properties.days }]
    }) },
    "/v1/training-zones/current": { get: operation(["Read"], "今日心率与配速分区") },
    "/v1/mobile/today": { get: operation(["Read"], "iOS 首页聚合：能力主卡、今日裁决、下一堂课、恢复拆解、跑后结论与周结构") },
    "/v1/mobile/training-plan-state": { get: operation(["Read"], "同一冻结事实视图中的目标、今日、滚动执行窗口与教练摘要") },
    "/v1/mobile/plan-operations/{id}": { get: operation(["Read"], "查询原发布操作：committed、notFound 或 expired", { parameters: pathId }) },
    "/v1/mobile/statistics": { get: operation(["Read"], "iOS 统计页聚合：近 3 月分运动类型里程、滚动汇总与心率区间分布") },
    "/v1/mobile/trends": { get: operation(["Read"], "iOS 趋势页聚合：能力曲线、12 周跑量、四周增幅、个人纪录与洞察") },
    "/v1/mobile/goals": {
      get: operation(["Read"], "读取 iOS 周目标、结构目标与赛事目标"),
      put: operation(["Workouts"], "更新 iOS 周目标、结构目标与赛事目标", {
        requestBody: body({ $ref: "#/components/schemas/MobileGoalsUpdate" }, "周跑量、轻松占比、质量课上限与赛事目标")
      })
    },
    "/v1/mobile/run-coach": {
      get: operation(["Read"], "自适应跑步教练计划、阶段和补充力量安排"),
      post: operation(["Workouts"], "创建、更新偏好、自适应刷新、暂停、恢复或结束跑步教练计划", {
        requestBody: body(runCoachCommandSchema, "当前目标 revision 和教练命令；不支持逐日改期")
      })
    },
    "/v1/mobile/lock": {
      post: operation(["Workouts"], "锁定或按新裁决重锁今天的课", {
        requestBody: body({ $ref: "#/components/schemas/MobileLock" }, "lock 或 relock")
      })
    },
    "/v1/mobile/workout-plan": {
      get: operation(["Read"], "iOS 可执行周课表：今日按闸门裁决，其后按已存计划逐日给出结构、距离与时长")
    },
    "/v1/mobile/workout-plan/generate": {
      post: operation(["Workouts"], "规则教练生成并持久化未来七日课表；旧模型课表待确认时返回 409", {
        // Every field is optional — the handler reads `expectedRevision` with a
        // `?.` — so the body itself is not required, unlike the other writes.
        deprecated: true,
        requestBody: {
          required: false,
          description: "可选的期望 revision，用于并发保护",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/MobileWeeklyPlanGenerate" } }
          }
        }
      })
    },
    "/v1/mobile/workout-plan/preview": {
      post: operation(["Workouts"], "规则教练生成未来七日候选课表；不保存、不推送手表，15 分钟过期", {
        requestBody: body({ type: "object", additionalProperties: false, required: ["expectedRevision"], properties: {
          expectedRevision: { type: "integer", minimum: 0 }
        } }, "当前目标 revision")
      })
    },
    "/v1/mobile/workout-plan/confirm": {
      post: operation(["Workouts"], "确认预览；校验目标版本与训练数据快照，支持重复确认幂等", {
        requestBody: body({ type: "object", additionalProperties: false, required: ["candidateId", "expectedRevision"], properties: {
          candidateId: { type: "string", minLength: 1, maxLength: 80 }, expectedRevision: { type: "integer", minimum: 0 }, operationId: { type: "string", format: "uuid" }, operationScope: planOperationScopeSchema
        } }, "候选标识及预览基准 revision")
      })
    },
    "/v1/mobile/workout-plan/synced": {
      post: operation(["Workouts"], "登记手机已把某天的课表推送到 Apple Watch，供训练详情按课表结构还原分段", {
        requestBody: body({ $ref: "#/components/schemas/MobilePlanSynced" }, "被推送的课表日期、类型与结构")
      })
    },
    "/v1/training-zones/history": { get: operation(["Read"], "历史心率与配速分区", {
      parameters: [{ name: "days", in: "query", schema: trainingZonesHistoryQuerySchema.properties.days }]
    }) },
    "/v1/training-zones/profile": { patch: operation(["Workouts"], "更新心率与配速分区设置", {
      requestBody: body({ $ref: "#/components/schemas/TrainingZoneProfileUpdate" }, "完整设置与当前 revision")
    }) },
    "/v1/model-snapshots": { get: operation(["Read"], "当前或历史模型发布快照", {parameters:[{name:"runId",in:"query",required:false,schema:{type:"string",maxLength:200}}]}) },
    "/v1/predictions": { get: operation(["Read"], "VO₂max、乳酸阈值与比赛成绩预测", {
      parameters: Object.entries(predictionQuerySchema.properties).map(([name, schema]) => ({ name, in: "query", schema }))
    }) },
    "/v1/prediction-models": {
      get: operation(["Read"], "CatBoost 预测模型运行历史")
    },
    "/v1/prediction-models/train": {
      post: operation(["Jobs"], "创建 CatBoost 训练任务；通过离线门槛后直接激活", {
        requestBody: body({ $ref: "#/components/schemas/PredictionModelTrainRequest" }, "可选的训练数据截止时间")
      })
    },
    "/v1/prediction-models/{id}": {
      get: operation(["Read"], "预测模型运行详情与阶段事件", { parameters: pathId })
    },
    "/v1/prediction-models/{id}/activate": {
      post: operation(["Jobs"], "回滚并激活验证成功的历史预测模型", { parameters: pathId })
    },
    "/v1/prediction-models/{id}/cancel": {
      post: operation(["Jobs"], "取消预测模型训练任务", { parameters: pathId })
    },
    "/v1/model-runs": {
      get: operation(["Read"], "模型运行历史"),
      post: operation(["Jobs"], "创建完整重算任务")
    },
    "/v1/model-runs/compare": { get: operation(["Read"], "量化比较两个不可变模型运行", {
      parameters: [
        { name: "base", in: "query", required: true, schema: identifier },
        { name: "candidate", in: "query", required: true, schema: identifier }
      ]
    }) },
    "/v1/model-runs/{id}/activate": { post: operation(["Jobs"], "激活成功的历史模型运行", { parameters: pathId }) },
    "/v1/jobs": { get: operation(["Jobs"], "重算任务历史") },
    "/v1/commands": { post: operation(["Jobs"], "提交异步写操作", {
      requestBody: body(commandBodySchema, "客户端生成的幂等键与待执行操作"),
      responses: { ...responses("提交异步写操作"), "200": jsonResponse("已有任务", commandResponseSchema),
        "202": jsonResponse("已持久化排队", commandResponseSchema), "429": errorResponse }
    }) },
    "/v1/commands/{id}": { get: operation(["Jobs"], "查询异步写操作", {
      parameters: pathId, responses: { ...responses("查询异步写操作"), "200": jsonResponse("任务状态", commandResponseSchema) }
    }) },
    "/v1/commands/{id}/cancel": { post: operation(["Jobs"], "取消尚未执行的写操作", { parameters: pathId }) },
    "/v1/jobs/{id}": { get: operation(["Jobs"], "任务与阶段事件", { parameters: pathId }) },
    "/v1/jobs/{id}/cancel": { post: operation(["Jobs"], "请求取消任务", { parameters: pathId }) },
    "/v1/import-jobs": { post: operation(["Jobs"], "从已检查的 Apple Health 来源导入", {
      responses: {
        ...responses("从已检查的 Apple Health 来源导入"),
        "202": jsonResponse("已持久化排队", { $ref: "#/components/schemas/ImportJobResponse" }),
        "429": errorResponse
      },
      requestBody: body({ $ref: "#/components/schemas/ImportJobRequest" }, "已预检的导入来源标识")
    }) },
    "/v1/import-jobs/{id}": { get: operation(["Jobs"], "导入任务状态", { parameters: pathId }) },
    "/v1/import-jobs/{id}/cancel": { post: operation(["Jobs"], "取消等待或执行中的导入任务", { parameters: pathId }) },
    "/v1/import-jobs/active": { get: operation(["Jobs"], "当前运行中的导入任务") },
    "/v1/import-jobs/latest": { get: operation(["Jobs"], "最近的导入任务") },
    "/v1/imports/uploads": { post: operation(["Jobs"], "流式上传并安全解压 Apple Health ZIP", {
      requestBody: { required: true, content: { "multipart/form-data": { schema: {
        type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } }
      } } } },
      responses: {
        ...responses("流式上传并安全解压 Apple Health ZIP"),
        "429": errorResponse,
        "507": errorResponse
      }
    }) },
    "/v1/imports/inspect": { post: operation(["Jobs"], "预检已上传或本机导入来源", {
      requestBody: body(importSourceBodySchema, "待预检的来源")
    }) },
    "/v1/import-sources/{id}": { delete: operation(["Jobs"], "清理保留的失败上传来源", {
      parameters: pathId
    }) },
    "/v1/import-sources/discover": { post: operation(["Jobs"], "发现常用目录中的 Apple Health 导出") },
    "/v1/import-sources/recent": { get: operation(["Jobs"], "最近成功使用的导入来源") },
    "/v1/backups": {
      get: operation(["Maintenance"], "本地备份列表"),
      post: operation(["Maintenance"], "创建 SQLite 在线备份")
    },
    "/v1/backups/{name}": {
      get: operation(["Maintenance"], "下载本地 SQLite 备份", {
        parameters: [{ name: "name", in: "path", required: true, schema: backupParamsSchema.properties.name }],
        responses: { "200": { description: "SQLite 备份", content: { "application/x-sqlite3": { schema: { type: "string", format: "binary" } } } }, "404": errorResponse }
      }),
      delete: operation(["Maintenance"], "删除指定的本地 SQLite 备份", {
        parameters: [{ name: "name", in: "path", required: true, schema: backupParamsSchema.properties.name }]
      })
    },
    "/v1/backups/{name}/restore": { post: operation(["Maintenance"], "校验并原子恢复本地 SQLite 备份", {
      parameters: [{ name: "name", in: "path", required: true, schema: backupParamsSchema.properties.name }],
      requestBody: body({ $ref: "#/components/schemas/RestoreBackupRequest" }, "恢复确认文字")
    }) },
    "/v1/database": { delete: operation(["Maintenance"], "备份后删除当前本地数据库", {
      requestBody: body({ $ref: "#/components/schemas/DeleteDatabaseRequest" }, "删除确认文字"),
      responses: {
        ...responses("备份后删除当前本地数据库"),
        "200": jsonResponse("数据库已删除，原始数据已保存", {
          type: "object",
          required: ["deleted", "preservation"],
          properties: {
            deleted: { const: true },
            preservation: {
              oneOf: [
                {
                  type: "object", required: ["kind", "backup"], additionalProperties: false,
                  properties: {
                    kind: { const: "backup" },
                    backup: objectSchema("name", "sizeBytes", "createdAt")
                  }
                },
                {
                  type: "object", required: ["kind", "snapshot"], additionalProperties: false,
                  properties: {
                    kind: { const: "quarantine" },
                    snapshot: objectSchema("name", "sizeBytes", "createdAt")
                  }
                }
              ]
            }
          }
        })
      }
    }) }
  }
} as const;
