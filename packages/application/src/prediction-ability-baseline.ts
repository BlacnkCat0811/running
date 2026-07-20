import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { PHYSIOLOGY_MODEL_VERSION } from "@rai/physiology";

// Bump when buildFormulaPredictionBase changes prediction semantics without a
// corresponding physiology package version change.
export const FORMULA_PREDICTION_BASE_VERSION = "rai-formula-prediction-base-v1" as const;

export function currentAbilityBaselineHash(database: DatabaseSync): string | null {
  const row = database.prepare(`
    SELECT model.id AS modelRunId,
      model.feature_run_id AS featureRunId,
      model.dataset_version AS datasetVersion,
      model.model_version AS modelVersion,
      model.model_config_hash AS modelConfigHash,
      feature.feature_schema_version AS featureSchemaVersion,
      feature.feature_config_hash AS featureConfigHash,
      feature.canonical_contract_version AS canonicalContractVersion
    FROM active_model_run active
    JOIN model_runs model ON model.id = active.model_run_id
    JOIN feature_runs feature ON feature.id = model.feature_run_id
    WHERE model.status = 'succeeded' AND feature.status = 'succeeded'
  `).get() as unknown as Record<string, string> | undefined;
  if (!row) return null;
  return createHash("sha256").update(JSON.stringify({
    modelRunId: row.modelRunId,
    featureRunId: row.featureRunId,
    datasetVersion: row.datasetVersion,
    modelVersion: row.modelVersion,
    modelConfigHash: row.modelConfigHash,
    featureSchemaVersion: row.featureSchemaVersion,
    featureConfigHash: row.featureConfigHash,
    canonicalContractVersion: row.canonicalContractVersion,
    physiologyModelVersion: PHYSIOLOGY_MODEL_VERSION,
    formulaPredictionBaseVersion: FORMULA_PREDICTION_BASE_VERSION
  })).digest("hex");
}
