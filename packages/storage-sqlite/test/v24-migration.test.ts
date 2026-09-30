import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RaiDatabase, SqliteModelRunRepository, SqliteModelReleaseRepository, ModelRunActivationError, recordModelReleaseRefusal, REQUIRED_MODEL_DOMAINS, semanticHash } from "../src/index.js";
import type { ModelLineageV2 } from "@rai/contracts";

const at = "2026-09-29T00:00:00Z";

/** 一个 V4 运行 + 全领域快照；seal=false 时故意不封存 bundle。 */
function seed(db: RaiDatabase["database"], store: RaiDatabase, id: string, seal = true): void {
  const releases = new SqliteModelReleaseRepository(db);
  db.prepare(`INSERT INTO feature_runs(id,dataset_version,canonical_contract_version,feature_schema_version,feature_config_json,feature_config_hash,status)
    VALUES(?,'dataset','canonical-health-v2','workout-feature-v4','{}',?,'succeeded')`).run(`f${id}`, `hash-${id}`);
  db.prepare(`INSERT INTO model_runs(id,feature_run_id,dataset_version,model_version,model_config_json,model_config_hash,evaluated_at,status)
    VALUES(?,?,'dataset','v2','{}','hash',?,'succeeded')`).run(id, `f${id}`, at);
  db.prepare(`INSERT INTO training_metric_runs(id,model_run_id,algorithm_version,config_json,config_hash,timezone_identifier,evaluated_at,status)
    VALUES(?,?,'v5','{}','hash','Asia/Shanghai',?,'succeeded')`).run(`t${id}`, id, at);
  if (!seal) return;
  const lineage: ModelLineageV2 = {
    sourceRunId: id, datasetVersion: "dataset", factsSnapshotHash: semanticHash({}), overrideSnapshotHash: semanticHash([]),
    modelVersion: "rai-v2.0.0", featureSchemaVersion: "workout-feature-v4", configVersion: "v11", configHash: "hash",
    calibrationCohortHash: null, baselineEpochId: null, normalizationVersion: null, normalizationConfigHash: null,
    timezoneIdentifier: "Asia/Shanghai", asOf: at, dataThroughAt: null
  };
  releases.recordLineage(id, "rai-v2.0.0", "v11", lineage);
  for (const domain of REQUIRED_MODEL_DOMAINS) releases.putSnapshot(id, domain, "summary", at, { status: "no_data", lineage });
  releases.recordEvaluation({ runId: id, baseRunId: null, datasetVersion: "dataset", status: "passed", report: { status: "passed" }, createdAt: at });
  void store;
}

test("v24 widens the gate CHECK, adds engine_version / epoch columns and the refusal ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-v24-migration-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    const db = store.database;
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
    assert.ok(columns("model_runs").includes("engine_version"));
    assert.ok(columns("daily_ability_snapshots").includes("baseline_epoch_id"));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_release_refusals'").get());

    seed(db, store, "m");
    const insertGate = (version: string, status: string) => db.prepare(
      "INSERT INTO model_validation_gates(id,candidate_model_run_id,gate_version,status,metrics_json,thresholds_json,failure_reasons_json) VALUES(?,?,?,?,'{}','{}','[]')"
    ).run(`g-${version}`, "m", version, status);
    // 三态都要装得下：not_evaluable 此前只能退化成 'skipped'，会被读成"没有 base run"。
    for (const status of ["passed", "failed", "skipped", "not_evaluable"]) insertGate(`v-${status}`, status);
    // 但 CHECK 没被放宽成"什么都行"。
    assert.throws(() => insertGate("v-bogus", "bogus"), /CHECK constraint failed/);

    // 历史行不得被兜底成当前版本。
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM model_runs WHERE engine_version IS NOT NULL").get() as { n: number }).n,
      0,
      "v24 不猜历史行的引擎版本：新增列必须留 NULL"
    );
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a refused publication is auditable, but only when recorded after the rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-v24-refusal-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    const db = store.database;
    seed(db, store, "unsealed", false);
    const models = new SqliteModelRunRepository(db);
    const refusals = () => (db.prepare("SELECT stage, reason_codes_json AS codes FROM model_release_refusals").all() as Array<{ stage: string; codes: string }>);

    // ① 仓库只报告，不落库。注意：它在自己的 SAVEPOINT 里就算写了也会被自己回滚掉，
    //    所以"调用后没有审计行"这条要求由 ②③ 的顺序断言来守，而不是靠本条。
    //    本条真正要守的是**错误必须携带拒绝载荷** —— 否则调用方无从落库。
    let caught: unknown;
    try { models.activateSucceeded("unsealed", at); } catch (error) { caught = error; }
    assert.ok(caught instanceof ModelRunActivationError);
    assert.equal((caught as ModelRunActivationError).code, "release_gate");
    assert.equal((caught as ModelRunActivationError).refusal?.stage, "release_gate",
      "拒绝载荷必须随错误抛出：调用方（HTTP 路由 / 命令队列）是唯一能落库的位置");
    assert.deepEqual((caught as ModelRunActivationError).refusal?.reasonCodes, ["release_verification_failed"]);

    // ② 写在事务**内** ⇒ 被回滚掉（这正是必须放到 ROLLBACK 之后的原因）。
    db.exec("BEGIN IMMEDIATE");
    try {
      models.activateSucceeded("unsealed", at);
    } catch (error) {
      recordModelReleaseRefusal(db, { modelRunId: "unsealed", ...(error as ModelRunActivationError).refusal!, detectedAt: at });
      db.exec("ROLLBACK");
    }
    assert.deepEqual(refusals(), [], "事务内写审计行应当被回滚 —— 若这条变绿，说明下面的顺序要求已失效");

    // ③ 写在 ROLLBACK **之后** ⇒ 留得住，且原因可查。
    db.exec("BEGIN IMMEDIATE");
    try {
      models.activateSucceeded("unsealed", at);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      recordModelReleaseRefusal(db, { modelRunId: "unsealed", ...(error as ModelRunActivationError).refusal!, detectedAt: at });
    }
    const rows = refusals();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.stage, "release_gate");
    assert.deepEqual(JSON.parse(rows[0]!.codes), ["release_verification_failed"]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
