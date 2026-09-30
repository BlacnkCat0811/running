import type { DatabaseSync } from "node:sqlite";
import { canonicalSemanticJson } from "@rai/contracts";
import { evaluateIntervalArtifact, empiricalIntervalBounds, validateIntervalArtifact, assertIntervalPublicationPolicy, assertIntervalPresentation, type IntervalArtifact, type EvaluationCase } from "@rai/model-eval";
import { semanticHash } from "./model-release-repository.js";

export class SqliteCalibrationRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(artifact: IntervalArtifact, baselineHash: string, test: readonly EvaluationCase[], asOf: string): string {
    if (!/^[a-f0-9]{64}$/i.test(baselineHash)) throw new Error("Calibration requires the real baseline fingerprint");
    if (!Number.isFinite(Date.parse(asOf))) throw new Error("Invalid calibration timestamp");
    asOf = new Date(asOf).toISOString();
    const evaluation=evaluateIntervalArtifact(artifact,test,asOf);
    assertIntervalPublicationPolicy(artifact.policy);
    if(test.some((row)=>Date.parse(row.predictedAt)<=Date.parse(artifact.calibrationAvailableThrough)+86_400_000))throw new Error("Calibration publication requires a 24-hour embargo");
    const hash=semanticHash(artifact), id=semanticHash({hash,baselineHash,test,asOf});
    this.db.prepare(`INSERT OR IGNORE INTO prediction_calibration_artifacts
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id,artifact.predictorVersion,baselineHash,artifact.distance,asOf,
        canonicalSemanticJson(artifact),hash,canonicalSemanticJson({
          ...evaluation,evaluationCohortHash:semanticHash(test)
        }),evaluation.status);
    return id;
  }
  select(predictorVersion:string,baselineHash:string,distance:string,asOf:string,point:number) {
    if (!Number.isFinite(Date.parse(asOf))) throw new Error("Invalid calibration selection timestamp");
    asOf = new Date(asOf).toISOString();
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='prediction_calibration_artifacts'").get()) return null;
    const row=this.db.prepare(`SELECT * FROM prediction_calibration_artifacts
      WHERE predictor_version=? AND baseline_hash=? AND distance=? AND available_at<=? AND status='passed'
      ORDER BY available_at DESC,id DESC LIMIT 1`).get(predictorVersion,baselineHash,distance,asOf) as Record<string,unknown>|undefined;
    if (!row) return null;
    try {
      const artifact=JSON.parse(String(row.artifact_json)) as IntervalArtifact;
      validateIntervalArtifact(artifact);
      assertIntervalPublicationPolicy(artifact.policy);
      const evaluation=JSON.parse(String(row.evaluation_json)) as ReturnType<typeof evaluateIntervalArtifact> & {
        evaluationCohortHash?: string
      };
      if (semanticHash(artifact)!==row.artifact_hash || artifact.predictorVersion!==predictorVersion ||
        artifact.distance!==distance || evaluation.blocksPublication || evaluation.status!=="passed") return null;
      const bounds=empiricalIntervalBounds(artifact,point);
      for (const key of ["p80","p90"] as const) {
        assertIntervalPresentation({kind:"calibrated",evidence:{
          ...evaluation[key],...bounds[key],status:"empirically_evaluated",domainMatch:"matched",
          evaluationCohortHash:evaluation.evaluationCohortHash??null,calibrationVersion:artifact.version
        }});
      }
      return {artifactId:String(row.id),bounds,evaluation};
    } catch { return null; }
  }
}
