/**
 * §5 环境与生理可比性归一化 —— adapter 契约 + 条件账本（PR 06 / 推进步 N0）。
 *
 * N0 的约定（§5.4）：**identity adapter + 状态与谱系，保持现有数值**。所以本包：
 *
 * - 只做**观测与记账**，不改任何数值，也不接入评分路径；
 * - `normalize()` 永不返回 `applied`（identity 不施加修正）；
 * - 把"我们不知道这次训练的环境"从**静默的 0 惩罚**变成**显式的 `unavailable`**。
 *
 * 后者是本包最实际的价值。现有 `performanceConditionPenaltyFraction` 在缺数据时返回 0，
 * 与"确实处于参考条件"**无法区分**；§5.3 明确要求 `not_needed` 表示"有足够证据且处于参考条件"，
 * 而不是"缺信息所以不修正"。本包把这两件事分成两个状态。
 *
 * §5.5 的环境责任账本（`defaultConditionLedger`）把"禁止同一历史热惩罚被两处各去一次"
 * 从一句文档要求变成**构造时即校验**的约束。
 */

export const NORMALIZATION_ADAPTER_VERSION = "rai-normalization-identity-v1" as const;
export const NORMALIZATION_POLICY_VERSION = "rai-normalization-policy-v1" as const;

export type NormalizationStatus = "applied" | "not_needed" | "unavailable" | "out_of_domain";

/**
 * §5.5 责任对象。允许 `historical_evidence` 与 `target_scenario` 对同一字段各施加一次
 * （过去热天去偏差 + 未来热天加情景，是两个不同对象）；禁止同一对象上施加两次。
 */
export type NormalizationObject = "historical_evidence" | "target_scenario" | "residual_input";

export type ConditionField = "temperature_c" | "humidity_percent" | "elevation_gain_meters";

export const CONDITION_FIELDS: readonly ConditionField[] = [
  "temperature_c",
  "humidity_percent",
  "elevation_gain_meters"
] as const;

export interface NormalizationContext {
  temperatureC: number | null;
  humidityPercent: number | null;
  elevationGainMeters: number | null;
}

export interface NormalizationInput {
  id: string;
  distanceMeters: number;
  durationSeconds: number;
  context: NormalizationContext;
}

export interface NormalizationTrace {
  adapterVersion: string;
  policyVersion: string;
  /** 身份标识（adapter 或 ledger 变动时变化），供"这次归一化是谁做的"追溯。 */
  configHash: string;
  status: NormalizationStatus;
  /** 输入环境上下文的指纹。上下文变了它必须变，否则谱系无法区分两次不同的观测。 */
  sourceContextHash: string;
  /** `null` = 我们没有算过修正量。绝不允许用 0 冒充"算过且为零"。 */
  correctionFraction: number | null;
  comparability: number;
  reasonCodes: string[];
}

export interface NormalizedPerformance {
  /** 中性化后的观测。`null` 表示"我们无法诚实地把它归一化"。 */
  normalized: { distanceMeters: number; durationSeconds: number } | null;
  /**
   * 原始值，**仅在 `normalized === null` 时非空**，用于低置信度解释。
   * 它不是归一化结果，字段名即为提醒（§5.3：不能谎报"已归一化"）。
   */
  rawComparableFallback: { distanceMeters: number; durationSeconds: number } | null;
  trace: NormalizationTrace;
}

export interface PerformanceNormalizationAdapter {
  readonly version: string;
  normalize(input: NormalizationInput): NormalizedPerformance;
}

export interface IdentityNormalizationConfig {
  /** 落在该窗口内即认为是 adapter 的参考条件，无需修正。 */
  readonly referenceTemperatureC: { readonly min: number; readonly max: number };
  readonly referenceHumidityPercent: { readonly min: number; readonly max: number };
  readonly referenceElevationGainMeters: { readonly max: number };
  /**
   * 环境未知时的可比性。**低于 `@rai/scoring` 的 §6.2 学习门控 0.90**，这一点是有意的：
   * 无法判断其环境的训练，在这一维度上不可比。
   * ⚠️ 把它接进 `confidenceV2.comparability` 之前必须先解决数据缺口 ——
   * 在 2026-09-28 的本地库上 **100% 的 workout 都是 `unavailable`**，
   * 直接接入会让学习门控对全部训练关闭（细则见批次报告）。
   */
  readonly comparabilityUnavailable: number;
  /**
   * 环境已知但超出参考域时的可比性。取**低于** `comparabilityUnavailable`：
   * 已知条件有实质差异，比"不知道有没有差异"更糟。
   */
  readonly comparabilityOutOfDomain: number;
}

export const defaultIdentityNormalizationConfig: IdentityNormalizationConfig = {
  referenceTemperatureC: { min: 5, max: 25 },
  referenceHumidityPercent: { min: 30, max: 70 },
  referenceElevationGainMeters: { max: 20 },
  comparabilityUnavailable: 0.8,
  comparabilityOutOfDomain: 0.7
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const assertFinite = (name: string, value: number): void => {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
};

/**
 * FNV-1a 64 位，纯 TypeScript 实现。
 * 纯包不能使用 `node:crypto`（`tsconfig.pure.json` 带 `"types": []`），
 * 而谱系指纹只需要**确定性**与**低碰撞率**，不需要密码学强度。
 */
export function stableContextHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function validateConfig(config: IdentityNormalizationConfig): void {
  const ranges: ReadonlyArray<[string, { readonly min: number; readonly max: number }]> = [
    ["referenceTemperatureC", config.referenceTemperatureC],
    ["referenceHumidityPercent", config.referenceHumidityPercent]
  ];
  for (const [name, range] of ranges) {
    assertFinite(`${name}.min`, range.min);
    assertFinite(`${name}.max`, range.max);
    if (range.min >= range.max) throw new Error(`${name}.min must be below ${name}.max`);
  }
  assertFinite("referenceElevationGainMeters.max", config.referenceElevationGainMeters.max);
  if (config.referenceElevationGainMeters.max < 0) {
    throw new Error("referenceElevationGainMeters.max must not be negative");
  }
  for (const [name, value] of [
    ["comparabilityUnavailable", config.comparabilityUnavailable],
    ["comparabilityOutOfDomain", config.comparabilityOutOfDomain]
  ] as const) {
    assertFinite(name, value);
    if (value < 0 || value > 1) throw new Error(`${name} must be within [0, 1]`);
  }
}

export function identityNormalizationConfigHash(
  config: IdentityNormalizationConfig = defaultIdentityNormalizationConfig
): string {
  return stableContextHash({
    adapterVersion: NORMALIZATION_ADAPTER_VERSION,
    policyVersion: NORMALIZATION_POLICY_VERSION,
    config
  });
}

/**
 * N0 的 identity adapter：**不施加任何修正**，只判定"这次观测的环境是可用的吗"。
 *
 * 四个状态的语义（§5.3）：
 * - `not_needed`：三个条件字段都有值**且**落在参考域内 ⇒ `normalized` 与输入逐位相同。
 * - `unavailable`：任一条件字段缺失 ⇒ `normalized = null` + `rawComparableFallback`，
 *   并且**绝不**返回 `not_needed` —— 缺数据不等于处于参考条件。
 * - `out_of_domain`：字段齐全但超出参考域 ⇒ identity 无法把它中性化。
 * - `applied`：identity **永不**返回它；出现了就说明这个 adapter 不再是 identity。
 */
export function createIdentityNormalizationAdapter(
  config: IdentityNormalizationConfig = defaultIdentityNormalizationConfig
): PerformanceNormalizationAdapter {
  validateConfig(config);
  const configHash = identityNormalizationConfigHash(config);

  return {
    version: NORMALIZATION_ADAPTER_VERSION,
    normalize(input: NormalizationInput): NormalizedPerformance {
      if (typeof input.id !== "string" || input.id.length === 0) {
        throw new Error("normalization input id must be a non-empty string");
      }
      assertFinite("distanceMeters", input.distanceMeters);
      assertFinite("durationSeconds", input.durationSeconds);
      if (input.distanceMeters <= 0 || input.durationSeconds <= 0) {
        throw new Error("distanceMeters and durationSeconds must be positive");
      }

      const context: NormalizationContext = {
        temperatureC: input.context.temperatureC,
        humidityPercent: input.context.humidityPercent,
        elevationGainMeters: input.context.elevationGainMeters
      };
      for (const [name, value] of Object.entries(context)) {
        if (value !== null) assertFinite(`context.${name}`, value as number);
      }

      const sourceContextHash = stableContextHash(context);
      const raw = { distanceMeters: input.distanceMeters, durationSeconds: input.durationSeconds };
      const base = {
        adapterVersion: NORMALIZATION_ADAPTER_VERSION,
        policyVersion: NORMALIZATION_POLICY_VERSION,
        configHash,
        sourceContextHash
      };

      const missing: string[] = [];
      if (context.temperatureC === null) missing.push("temperature_missing");
      if (context.humidityPercent === null) missing.push("humidity_missing");
      if (context.elevationGainMeters === null) missing.push("elevation_missing");
      if (missing.length > 0) {
        return {
          normalized: null,
          rawComparableFallback: raw,
          trace: {
            ...base,
            status: "unavailable",
            correctionFraction: null,
            comparability: clamp(config.comparabilityUnavailable, 0, 1),
            reasonCodes: missing
          }
        };
      }

      const temperature = context.temperatureC as number;
      const humidity = context.humidityPercent as number;
      const elevation = context.elevationGainMeters as number;
      const outside: string[] = [];
      if (temperature < config.referenceTemperatureC.min || temperature > config.referenceTemperatureC.max) {
        outside.push("temperature_out_of_reference_domain");
      }
      if (humidity < config.referenceHumidityPercent.min || humidity > config.referenceHumidityPercent.max) {
        outside.push("humidity_out_of_reference_domain");
      }
      if (elevation < 0 || elevation > config.referenceElevationGainMeters.max) {
        outside.push("elevation_out_of_reference_domain");
      }
      if (outside.length > 0) {
        return {
          normalized: null,
          rawComparableFallback: raw,
          trace: {
            ...base,
            status: "out_of_domain",
            correctionFraction: null,
            comparability: clamp(config.comparabilityOutOfDomain, 0, 1),
            reasonCodes: outside
          }
        };
      }

      return {
        // Identity: bit-identical to the input, not a recomputation that happens to agree.
        normalized: { distanceMeters: input.distanceMeters, durationSeconds: input.durationSeconds },
        rawComparableFallback: null,
        trace: {
          ...base,
          status: "not_needed",
          correctionFraction: 0,
          comparability: 1,
          reasonCodes: ["reference_conditions"]
        }
      };
    }
  };
}

// -----------------------------------------------------------------------------
// §5.5 环境责任账本
// -----------------------------------------------------------------------------

export interface ConditionCorrectionSite {
  readonly id: string;
  readonly appliesTo: NormalizationObject;
  readonly fields: readonly ConditionField[];
  /** `文件:函数` —— 供人工核对的落点，必须是真实存在的位置。 */
  readonly location: string;
  readonly note: string;
}

/**
 * 现状登记（2026-09-28 对照源码确认）。两处都对同一组字段施加修正，
 * 但**对象不同**（过去 vs 未来），正是 §5.5 明确允许的组合。
 */
export const defaultConditionLedger: readonly ConditionCorrectionSite[] = [
  {
    id: "vdot-evidence-history-debias",
    appliesTo: "historical_evidence",
    fields: ["temperature_c", "humidity_percent", "elevation_gain_meters"],
    location: "packages/physiology/src/index.ts:performanceVdotEvidence",
    note: "把过去的观测折算到中性条件：durationSeconds / (1 + penalty.total)。"
  },
  {
    id: "race-prediction-scenario",
    appliesTo: "target_scenario",
    fields: ["temperature_c", "humidity_percent", "elevation_gain_meters"],
    location: "packages/physiology/src/index.ts:predictRaceTimes",
    note: "把中性预测折算到目标比赛情景。与上一条是不同对象，允许并存。"
  }
];

export function validateConditionLedger(sites: readonly ConditionCorrectionSite[]): void {
  if (sites.length === 0) throw new Error("condition ledger must not be empty");
  const identifiers = new Set<string>();
  const claimed = new Map<string, string>();
  for (const site of sites) {
    if (site.id.length === 0) throw new Error("condition ledger site id must not be empty");
    if (identifiers.has(site.id)) throw new Error(`duplicate condition ledger site id: ${site.id}`);
    identifiers.add(site.id);
    if (site.fields.length === 0) throw new Error(`condition ledger site ${site.id} claims no fields`);
    if (site.location.length === 0) throw new Error(`condition ledger site ${site.id} has no location`);
    const seen = new Set<ConditionField>();
    for (const field of site.fields) {
      if (!CONDITION_FIELDS.includes(field)) {
        throw new Error(`condition ledger site ${site.id} lists unknown field: ${field}`);
      }
      if (seen.has(field)) {
        throw new Error(`condition ledger site ${site.id} lists ${field} twice`);
      }
      seen.add(field);
      const key = `${site.appliesTo}:${field}`;
      const owner = claimed.get(key);
      // §5.5 禁止"同一历史热惩罚被两处各去一次"。同一对象上同一字段只能有一个施加点。
      if (owner !== undefined) {
        throw new Error(
          `double correction of ${field} on ${site.appliesTo}: ${owner} and ${site.id}`
        );
      }
      claimed.set(key, site.id);
    }
  }
  // §5.5：残差只学"剩余"偏差 ⇒ 它不得再施加一次上游已经处理过的字段。
  for (const site of sites) {
    if (site.appliesTo !== "residual_input") continue;
    for (const field of site.fields) {
      for (const upstream of ["historical_evidence", "target_scenario"] as const) {
        const owner = claimed.get(`${upstream}:${field}`);
        if (owner !== undefined) {
          throw new Error(
            `residual_input site ${site.id} re-applies ${field} already handled by ${owner}`
          );
        }
      }
    }
  }
}

validateConditionLedger(defaultConditionLedger);
