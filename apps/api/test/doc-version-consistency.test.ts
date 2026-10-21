import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FORMULA_PREDICTION_BASE_VERSION } from "@rai/application";
import {
  CATBOOST_PREDICTION_MODEL_VERSION,
  FEATURE_SCHEMA_VERSION,
  TRAINING_LOAD_CONFIG_VERSION,
  TRAINING_ZONE_CONFIG_VERSION
} from "@rai/contracts";
import { PHYSIOLOGY_MODEL_VERSION } from "@rai/physiology";
import { SCORING_MODEL_VERSION } from "@rai/scoring";

import { SESSION_DOSE_POLICY_VERSION } from "../src/coach-session-dose.js";
import { PLAN_ADHERENCE_POLICY_VERSION, REPLAN_POLICY_VERSION } from "../src/plan-adherence.js";
import { PERIODIZATION_POLICY_VERSION } from "../src/plan-periodization.js";
import { RACE_CANDIDATE_POLICY_VERSION } from "../src/race-candidate.js";

/**
 * 现行合同文档里抄写的版本号必须等于代码常量。
 *
 * 2026-10-18 的实例：`docs/ALGORITHM.md` 写 `rai-formula-prediction-base-v5`，而
 * `FORMULA_PREDICTION_BASE_VERSION` 在同一提交里已经是 `-v6`。两个值都由同一批
 * 改动写就，却没有任何门禁发现：`check:docs` 只查链接可达性，`check:doc-refs`
 * 只核对 `文件:行号`，类型检查看不见字符串。于是文档安静地滞后了一版。
 *
 * 只核**现行合同文档**（下面的白名单）。带日期的状态/计划/审查文档记录的是某个
 * 时点的说法（已完成的批次见 `docs/PROJECT_REVIEW.md` 的收尾索引），
 * 版本升版后回写它们等于改写历史，因此有意排除。
 *
 * 每个版本常量是一"族"匹配形态：完整常量串 + 文档实际使用过的简写（§1 那一行）。
 * 两条硬规则：
 *   1. 每一族**至少命中一次** —— 否则文档改述后正则静默失效，守卫会在没人察觉时变成空转；
 *   2. 所有命中必须逐字等于该形态的期望值 —— 命中不到不罚，但提到就必须是当前值。
 * 简写前面加 `(?<![A-Za-z0-9-])`，否则 `download config v5` 里的 `load config v5`
 * 会被当成一回事。`config v11` / `config v12` 无法区分归属，不做匹配。
 */
const CURRENT_DOCUMENTS = [
  "README.md",
  "AGENTS.md",
  "docs/ALGORITHM.md",
  "docs/ARCHITECTURE.md",
  "docs/DECISIONS.md",
  "docs/DATA_PIPELINE.md",
  "docs/OPERATIONS.md",
  "docs/RUN_COACH.md",
  "docs/IOS_NATIVE_API_CONTRACT.md"
] as const;

interface CitableForm {
  readonly pattern: RegExp;
  /** 该形态在文档里必须逐字写成什么样。 */
  readonly expected: string;
}

const exact = (pattern: RegExp, constant: string): CitableForm => ({ pattern, expected: constant });

/** `rai-physiology-v1.8.0` → 简写 `physiology v1.8.0`（取最后一个 `-v` 之后的部分）。 */
const abbreviated = (label: string, constant: string): CitableForm => {
  const version = constant.slice(constant.lastIndexOf("-v") + 2);
  return {
    pattern: new RegExp(`(?<![A-Za-z0-9-])${label} v\\d+(?:\\.\\d+)*`, "g"),
    expected: `${label} v${version}`
  };
};

interface VersionFamily {
  /** Only used in failure messages. */
  readonly name: string;
  /** The live constant, quoted in failure messages. */
  readonly constant: string;
  readonly forms: readonly CitableForm[];
}

const FAMILIES: readonly VersionFamily[] = [
  {
    name: "规则预测基线",
    constant: FORMULA_PREDICTION_BASE_VERSION,
    forms: [exact(/rai-formula-prediction-base-v\d+/g, FORMULA_PREDICTION_BASE_VERSION), abbreviated("公式基线", FORMULA_PREDICTION_BASE_VERSION)]
  },
  {
    name: "CatBoost 产物家族",
    constant: CATBOOST_PREDICTION_MODEL_VERSION,
    forms: [exact(/race-residual-catboost-v\d+/g, CATBOOST_PREDICTION_MODEL_VERSION), abbreviated("CatBoost family", CATBOOST_PREDICTION_MODEL_VERSION)]
  },
  { name: "周期骨架", constant: PERIODIZATION_POLICY_VERSION, forms: [exact(/rai-periodization-v\d+/g, PERIODIZATION_POLICY_VERSION)] },
  { name: "周依从性", constant: PLAN_ADHERENCE_POLICY_VERSION, forms: [exact(/rai-plan-adherence-v\d+/g, PLAN_ADHERENCE_POLICY_VERSION)] },
  { name: "重排建议", constant: REPLAN_POLICY_VERSION, forms: [exact(/rai-replan-v\d+/g, REPLAN_POLICY_VERSION)] },
  { name: "比赛候选", constant: RACE_CANDIDATE_POLICY_VERSION, forms: [exact(/rai-race-candidate-v\d+/g, RACE_CANDIDATE_POLICY_VERSION)] },
  { name: "课剂量", constant: SESSION_DOSE_POLICY_VERSION, forms: [exact(/rai-coach-session-dose-v\d+/g, SESSION_DOSE_POLICY_VERSION)] },
  {
    name: "特征 schema",
    constant: FEATURE_SCHEMA_VERSION,
    forms: [exact(/workout-feature-v\d+/g, FEATURE_SCHEMA_VERSION), abbreviated("feature", FEATURE_SCHEMA_VERSION)]
  },
  { name: "评分引擎", constant: SCORING_MODEL_VERSION, forms: [abbreviated("scoring", SCORING_MODEL_VERSION)] },
  {
    name: "生理模型",
    constant: PHYSIOLOGY_MODEL_VERSION,
    forms: [exact(/rai-physiology-v\d+\.\d+\.\d+/g, PHYSIOLOGY_MODEL_VERSION), abbreviated("physiology", PHYSIOLOGY_MODEL_VERSION)]
  },
  {
    name: "负荷配置",
    constant: TRAINING_LOAD_CONFIG_VERSION,
    forms: [exact(/training-load-config-v\d+/g, TRAINING_LOAD_CONFIG_VERSION), abbreviated("load config", TRAINING_LOAD_CONFIG_VERSION)]
  },
  {
    name: "分区配置",
    constant: TRAINING_ZONE_CONFIG_VERSION,
    forms: [exact(/training-zone-config-v\d+/g, TRAINING_ZONE_CONFIG_VERSION), abbreviated("zone config", TRAINING_ZONE_CONFIG_VERSION)]
  }
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function contractDocuments(): string[] {
  const missing = CURRENT_DOCUMENTS.filter((relative) => !existsSync(join(root, relative)));
  assert.deepEqual(missing, [], "白名单里的文档不存在，守卫会静默失效");
  return CURRENT_DOCUMENTS.map((relative) => readFileSync(join(root, relative), "utf8"));
}

test("现行合同文档里的版本串等于代码常量", () => {
  const texts = contractDocuments();
  const mismatches: string[] = [];
  const unmatched: string[] = [];

  for (const family of FAMILIES) {
    let hits = 0;
    for (const text of texts) {
      for (const { pattern, expected } of family.forms) {
        for (const match of text.matchAll(pattern)) {
          hits += 1;
          if (match[0] !== expected) {
            mismatches.push(`${family.name}：文档写 ${match[0]}，应为 ${expected}（常量 ${family.constant}）`);
          }
        }
      }
    }
    if (hits === 0) unmatched.push(`${family.name}（${family.constant}）`);
  }

  assert.deepEqual(mismatches, [], "文档版本号滞后于代码；改文档或改常量，但不要留下两个值");
  assert.deepEqual(
    unmatched,
    [],
    "这些版本族在现行文档里一次都没命中：文档改述后请更新匹配形态，不要让守卫空转"
  );
});

test("公式基线版本在正文里有个正向引用（删掉提法也算漂移）", () => {
  const algorithm = readFileSync(join(root, "docs/ALGORITHM.md"), "utf8");
  assert.ok(
    algorithm.includes(FORMULA_PREDICTION_BASE_VERSION),
    `docs/ALGORITHM.md 应引用 ${FORMULA_PREDICTION_BASE_VERSION}`
  );
  assert.ok(
    !algorithm.includes("rai-formula-prediction-base-v5"),
    "docs/ALGORITHM.md 仍保留已过期的 v5 提法"
  );
});
