import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TrainingPlanExecutionCommandRequest, TrainingPlanScope } from "@rai/api-contracts";

import { MobileGoalsStore } from "../../src/mobile-goals.js";
import { TrainingPlanExecutionCommandService, type ExecutionCommandFacts } from "../../src/training-plan-execution-commands.js";
import type { ExecutionFact } from "../../src/training-plan-execution-match.js";

/**
 * One side of the two-process B06 link race. The parent seeds the control
 * database and a shared JSON config, then starts two of these processes with
 * different courses and writes both `go` files together. This helper is not a
 * test file; it is spawned by training-plan-closed-loop-faults.test.ts.
 */

interface RaceConfig {
  root: string;
  controlPath: string;
  scope: TrainingPlanScope;
  businessDate: string;
  now: string;
  planInstanceId: string;
  runFact: ExecutionFact;
  sessions: Array<{ sessionId: string; sessionRevision: number }>;
}

const [configPath, sessionId, operationId, expectedRevision, readyFile, goFile, resultFile] = process.argv.slice(2);
if (!configPath || !sessionId || !operationId || !expectedRevision || !readyFile || !goFile || !resultFile) {
  throw new Error("race child: missing arguments");
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as RaceConfig;
const session = config.sessions.find(item => item.sessionId === sessionId);
if (!session) throw new Error(`race child: unknown session ${sessionId}`);

const goals = new MobileGoalsStore(config.root, config.controlPath);
try {
  goals.bindTrainingPlanOwner(() => config.scope, () => config.businessDate);
  const provider: ExecutionCommandFacts = {
    fingerprint: () => "race-facts",
    candidates: () => [config.runFact],
    workout: () => null
  };
  const service = new TrainingPlanExecutionCommandService(goals, () => config.scope, () => config.businessDate,
    () => provider, () => Date.parse(config.now));
  const request: TrainingPlanExecutionCommandRequest = {
    contractVersion: 1, operationId, operationScope: config.scope,
    expectedStateRevision: Number(expectedRevision), planInstanceId: config.planInstanceId,
    sessionId, sessionRevision: session.sessionRevision, executionRevision: 0,
    draft: { action: "confirm", trainingSessionId: config.runFact.trainingSessionId,
      sourceFactDigest: config.runFact.sourceFactDigest }
  };

  writeFileSync(readyFile, "ready", "utf8");
  // Both processes spin here until the parent writes both go files.
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 60_000;
  while (!existsSync(goFile)) {
    if (Date.now() > deadline) throw new Error("race child: go file never appeared");
    Atomics.wait(sleeper, 0, 0, 5);
  }
  try {
    const result = service.submit(request);
    writeFileSync(resultFile, JSON.stringify({ ok: true, result }), "utf8");
  } catch (error) {
    const value = error as { code?: string; message?: string };
    writeFileSync(resultFile, JSON.stringify({ ok: false, code: value.code ?? null, message: value.message ?? String(error) }), "utf8");
  }
} finally {
  goals.close();
}
