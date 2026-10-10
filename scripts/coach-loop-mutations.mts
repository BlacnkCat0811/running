import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { coachReplaySourceIdentity } from "./coach-replay-provenance.mjs";
import { digest } from "../apps/api/src/plan-digest.js";
import { COACH_MUTATION_ASSERTIONS as assertions } from "./coach-mutation-contract.mjs";

/**
 * Compile each semantic mutant in an isolated source copy, then require a
 * named behavior assertion to fail. Compilation failures are NOT kills.
 * Never edits the workspace, real databases, policy pointers or receipts.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = resolve(root, "node_modules/typescript/bin/tsc");
const args = process.argv.slice(2);
if (args.length && (args[0] !== "--output" || args.length !== 2)) throw new Error("Usage: test:coach:mutation [--output PATH]");
const sourceIdentity = coachReplaySourceIdentity();
const temporary = mkdtempSync(join(tmpdir(), "rai-coach-mutations-"));
const probe = `
import assert from "node:assert/strict";
import { assessSessionDose, buildCompleteEasyStructure } from "../apps/api/src/coach-session-dose.js";
import { buildCoachLoopCandidate } from "../apps/api/src/coach-loop-decision.js";
import { buildCoachCapacityAnchor } from "../apps/api/src/weekly-capacity.js";
import { executionPolicyContext } from "../apps/api/src/race-plan-policy.js";
import { coachReplayInput, replayRun } from "./coach-replay-scenarios.mjs";
import { executionFixture } from "./coach-execution-fixtures.mjs";
import { assessWorkoutExecution } from "../apps/api/src/coach-execution-assessment.js";
import { repairCoachPlan, type CoachRepairDay } from "../apps/api/src/coach-plan-repair.js";
import { buildSubjectiveFeedback, effectiveSubjectiveFeedback } from "../apps/api/src/coach-subjective-feedback.js";
import { coachGoalGap, type CoachPredictionIdentity } from "../apps/api/src/coach-goal-gap.js";
import type { CoachPredictionSummary } from "@rai/api-contracts";
import { coachRuntimeFixture, runtimeReplaySettings, runtimeReplayScope } from "./coach-runtime-fixtures.mjs";
import { COACH_RUNTIME_POLICY_HASH, type CoachRuntimeReceipt } from "../apps/api/src/coach-loop-runtime.js";
import { prescriptionDigest } from "../apps/api/src/plan-digest.js";
const source = coachReplayInput();
const input = { ...source, facts: [...source.facts, replayRun("monday", "2026-10-05", 20)] };
const mode = process.argv[2] ?? "";
if (mode.startsWith("runtime-") || mode === "device-token") {
  const f = coachRuntimeFixture();
  try {
    const enable = f.command("enable", { settings: runtimeReplaySettings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH });
    if (mode === "runtime-policy") {
      assert.throws(() => f.runtime.command({...enable,acceptedPolicyHash:"not-accepted"}),"AC0-21-policy");
    } else if (mode === "runtime-cas") {
      assert.throws(() => f.runtime.command({...enable,expectedRevision:123}),"AC0-22-cas");
    } else if (mode === "runtime-facts") {
      assert.throws(() => f.runtime.command({...enable,expectedFactsHash:"old"}),"AC0-22-facts");
    } else if (mode === "runtime-rollback") {
      f.store.appendCoachLoopReceipt = () => { throw new Error("injected"); };
      assert.throws(() => f.runtime.command(enable),/injected/);
      assert.equal(f.store.read().revision,0,"AC0-22-rollback");
    } else {
      const published = f.runtime.command(enable);
      if (mode === "runtime-completion") {
        f.facts.facts.push(replayRun("actual-extra","2026-10-08",5)); f.facts.factsHash="after";
        f.runtime.command(f.command("refresh"));
        const saved=f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(runtimeReplayScope))!;
        assert.equal(saved.reservations[0]?.status,"completed","AC0-17-completed-slot");
      } else if (mode === "runtime-identity") {
        const saved=f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(runtimeReplayScope))!;
        f.store.publicationOperation(JSON.stringify(runtimeReplayScope),"mutant-fixture","fixture",{},()=>{
          f.store.appendCoachLoopReceipt(JSON.stringify(runtimeReplayScope),"mutant-fixture",{...saved,effectiveDigest:"different-authority"});
          return true;
        });
        assert.ok(f.runtime.command(f.command("refresh")).revision>published.revision,"AC0-21-authority-identity");
      } else {
        const out=f.runtime.recordDeviceReceipt({contractVersion:2,scope:runtimeReplayScope,
          operationId:"10000000-0000-4000-8000-000000000003",workoutID:"10000000-0000-4000-8000-000000000004",
          idempotencyKey:"device-token",localDate:published.today.day.localDate,kind:published.today.day.kind,
          structure:published.today.day.structure!,revision:published.revision,timezone:"Asia/Shanghai",
          scheduledAt:"2026-10-08T05:00:00Z",verifiedAt:"2026-10-08T04:01:00Z",
          coherenceToken:"f".repeat(64),prescriptionDigest:prescriptionDigest(published.today.day.kind,published.today.day.structure!),
          lifecycleEvent:"verified",coachLoop:{contractVersion:1,policyHash:published.policyHash,decisionRef:published.today.decisionRef}});
        assert.equal(out.matchesCurrent,false,"AC0-12-device-token");
      }
    }
  } finally { f.close(); }
} else if (mode === "minimum") {
  const structure = buildCompleteEasyStructure("easy", source.zones);
  structure.cooldown!.goal = { type: "time", seconds: 299 };
  assert.equal(assessSessionDose({kind:"easy",structure,zones:source.zones}).status,"not_feasible","AC0-05");
} else if (mode === "suggestion") {
  assert.equal(buildCoachLoopCandidate(input).allocation,"extension","AC0-13-candidate");
} else if (mode === "rolling") {
  const out = buildCoachLoopCandidate({...input,facts:[...input.facts,replayRun("sunday","2026-10-04",10)]});
  assert.equal(out.allocation,"rest","AC0-16");
} else if (mode === "anchor") {
  const before = buildCoachCapacityAnchor({...source,revision:1});
  const after = buildCoachCapacityAnchor({...input,revision:1});
  assert.equal(after.factsHash,before.factsHash,"AC0-15");
} else if (mode === "single") {
  const out = buildCoachLoopCandidate({...input,facts:input.facts.filter(fact=>fact.id!=="prior-long")});
  assert.ok(out.reasons.some(reason=>reason.code==="recent_single_run_spike"),"AC0-19");
} else if (mode === "protection") {
  const context = executionPolicyContext({localDate:"2026-10-18",raceTarget:{date:"2026-11-01",distance:"five_k",targetPaceSecondsPerKm:null},weeklyDistanceKm:20});
  assert.equal(context.protections.length,1,"AC1-02");
} else if (mode === "work") {
  const structure = buildCompleteEasyStructure("easy",source.zones);
  structure.warmup!.goal = {type:"time",seconds:1740};
  structure.cooldown = null;
  structure.blocks[0]!.steps[0]!.goal = {type:"time",seconds:60};
  assert.equal(assessSessionDose({kind:"tempo",structure,zones:source.zones}).status,"not_feasible","AC4-11");
} else if (mode.startsWith("execution-")) {
  const fixture = executionFixture();
  const evaluate = (workouts = [fixture.workout]) => assessWorkoutExecution({
    asOf:"2026-10-08T04:00:00Z",prescription:fixture.prescription,workouts,associations:[fixture.association]
  });
  if (mode === "execution-unknown") {
    assert.equal(evaluate([]).completion,"unconfirmed","AC2-02");
  } else if (mode === "execution-reconstructed") {
    fixture.workout.evidenceLevel = "reconstructed_segments";
    assert.equal(evaluate().completion,"unconfirmed","AC2-04");
  } else if (mode === "execution-coverage") {
    fixture.workout.signalIntervals = fixture.workout.signalIntervals.map(interval=>({...interval,durationSeconds:interval.durationSeconds*0.799}));
    assert.equal(evaluate().stimulus.status,"not_assessable","AC2-05");
  } else if (mode === "execution-retroactive") {
    fixture.prescription.createdAt = "2026-10-08T02:00:00Z";
    assert.equal(evaluate().association.status,"unmatched","AC2-08");
  } else throw new Error("Unknown execution mutation probe");
} else if (mode.startsWith("repair-")) {
  const structure = buildCompleteEasyStructure("easy",source.zones);
  const row: CoachRepairDay = {day:{localDate:"2026-10-08",kind:"easy",distanceKm:5,structure,reason:"frozen"},
    executable:true,authorizedDecisionRef:null};
  const rest: CoachRepairDay = {day:{localDate:row.day.localDate,kind:"rest",distanceKm:null,structure:null},
    executable:false,authorizedDecisionRef:null};
  const basic = {previous:[row],windowDates:[row.day.localDate],affectedDates:[row.day.localDate],protectedDates:[],
    requiredIntentDates:[],candidates:{},maximumEvaluations:100,inputDigest:"synthetic-input",reasonsByDate:{}};
  if (mode === "repair-lock") {
    const out=repairCoachPlan({...basic,protectedDates:[row.day.localDate],validate:()=>({feasible:true,effectiveDays:[rest],reasons:[]})});
    assert.deepEqual(out.storedDays[0],row.day,"AC3-04");
  } else if (mode === "repair-feasibility") {
    const out=repairCoachPlan({...basic,candidates:{[row.day.localDate]:[{...rest,originDate:null,templateId:"safe-rest",preferenceRank:1}]},
      validate:days=>({feasible:days.every(day=>day.kind==="rest"),effectiveDays:days.map(day=>({day,executable:day.kind!=="rest",authorizedDecisionRef:null})),reasons:[]})});
    assert.equal(out.effectiveDays[0]?.day.kind,"rest","AC3-09");
  } else if (mode === "repair-authorization") {
    row.executable=false;
    const out=repairCoachPlan({...basic,validate:days=>({feasible:true,effectiveDays:days.map(day=>({day,executable:true,authorizedDecisionRef:"synthetic-auth"})),reasons:[]})});
    assert.equal(out.status,"patched","AC0-21/AC3-no-change");
  } else if (mode === "repair-exhaustion") {
    const out=repairCoachPlan({...basic,maximumEvaluations:1,candidates:{[row.day.localDate]:[{...rest,originDate:null,templateId:"safe-rest",preferenceRank:1}]},
      validate:days=>({feasible:true,effectiveDays:days.map(day=>({day,executable:day.kind!=="rest",authorizedDecisionRef:null})),reasons:[]})});
    assert.equal(out.status,"not_evaluable","AC3-search-budget");
  } else if (mode === "repair-intent") {
    const out=repairCoachPlan({...basic,previous:[rest],requiredIntentDates:[row.day.localDate],
      candidates:{[row.day.localDate]:[{...row,originDate:null,templateId:"selected-easy",preferenceRank:1}]},
      validate:days=>({feasible:true,effectiveDays:days.map(day=>({day,executable:day.kind!=="rest",authorizedDecisionRef:null})),reasons:[]})});
    assert.equal(out.effectiveDays[0]?.day.kind,"easy","AC0-21/AC3-intent");
  } else throw new Error("Unknown repair mutation probe");
} else if (mode.startsWith("feedback-")) {
  const scope={athleteId:"synthetic",datasetEpoch:"synthetic-v1"};
  const fields={phase:"pre_run" as const,workoutId:null,observedAt:"2026-10-08T01:00:00Z",
    fatigue:null,soreness:null,discomfort:null,requestedAction:mode==="feedback-skip"?null:"rest" as const,
    interruptionReason:null,replacementReason:null,rpeOverrideRef:null};
  const row=buildSubjectiveFeedback({fields,id:"synthetic-feedback",revision:1,scope,
    recordedAt:"2026-10-08T05:00:00Z",availableAt:"2026-10-08T05:00:00Z",knownWorkoutIds:[],knownRpeOverrides:[]});
  if(mode==="feedback-skip")assert.equal(row,null,"AC5-01");
  else if(mode==="feedback-late")assert.equal(effectiveSubjectiveFeedback({scope,asOf:"2026-10-08T04:00:00Z",revisions:[row!]}).restRequested,false,"AC5-03");
  else if(mode==="feedback-expiry")assert.equal(effectiveSubjectiveFeedback({scope,asOf:"2026-10-09T04:00:00Z",revisions:[row!]}).restRequested,false,"AC5-02");
  else throw new Error("Unknown feedback mutation probe");
} else if (mode.startsWith("gap-")) {
  const currentIdentity:CoachPredictionIdentity={athleteId:"synthetic",bundleId:"bundle",bundleHash:"bundle-hash",
    datasetEpoch:"dataset",factsHash:"facts",overrideHash:"overrides",labelCohortHash:null,
    activePredictionArtifactId:"model",predictionPolicyVersion:"synthetic-v1",scenario:"current_prepared"};
  const summary:CoachPredictionSummary={...currentIdentity,schemaVersion:1,id:"synthetic-summary",
    asOf:"2026-10-10T01:00:00Z",publishedAt:"2026-10-10T02:00:00Z",availableAt:"2026-10-10T02:00:00Z",
    dataThroughAt:mode==="gap-freshness"?"2026-10-02T01:00:00Z":"2026-10-09T01:00:00Z",
    entries:[{distance:"ten_k",status:"available",referenceSeconds:3000,method:"synthetic",
      calibrationStatus:"uncalibrated",range:null,evidenceRefs:[],limitationCodes:[]}]};
  const out=coachGoalGap({asOf:"2026-10-10T04:00:00Z",distance:"ten_k",targetSeconds:2700,summary,
    currentIdentity:mode==="gap-compatibility"?{...currentIdentity,factsHash:"changed-facts"}:currentIdentity});
  if(mode==="gap-sign")assert.equal(out.gapSeconds,300,"AC6-01");
  else if(mode==="gap-freshness")assert.equal(out.status,"stale","AC6-04");
  else if(mode==="gap-compatibility")assert.equal(out.status,"incompatible","AC6-05");
  else throw new Error("Unknown goal-gap mutation probe");
} else throw new Error("Unknown mutation probe");
`;

const mutants = [
  { id: "runtime-policy", file: "coach-loop-runtime.ts",
    before: "command.acceptedPolicyHash !== COACH_RUNTIME_POLICY_HASH || !command.settings", after: "!command.settings" },
  { id: "runtime-cas", file: "coach-loop-runtime.ts",
    before: "if (goals.revision !== command.expectedRevision)", after: "if (false)" },
  { id: "runtime-facts", file: "coach-loop-runtime.ts",
    before: "if (before.factsHash !== command.expectedFactsHash)", after: "if (false)" },
  { id: "runtime-completion", file: "coach-loop-runtime.ts",
    before: 'status: ids.length ? "completed" as const :', after: 'status: ids.length ? "revoked" as const :' },
  { id: "runtime-identity", file: "coach-loop-runtime.ts",
    before: "previous?.effectiveDigest !== effectiveDigest;", after: "false;" },
  { id: "runtime-rollback", file: "mobile-goals.ts",
    before: 'this.controlDatabase.exec("ROLLBACK");\n      this.cached = null;',
    after: '/* rollback removed by semantic probe */\n      this.cached = null;' },
  { id: "device-token", file: "coach-loop-device-sync.ts",
    before: "body.coherenceToken === current.executionToken", after: "true" },
  { id: "minimum", file: "coach-session-dose.ts", before: "MINIMUM_SESSION_DURATION_SECONDS = 1800", after: "MINIMUM_SESSION_DURATION_SECONDS = 1200" },
  { id: "suggestion", file: "coach-loop-decision.ts",
    before: "const needsExtension = cost > suggestedRemainingKm + 1e-9;",
    after: "const needsExtension = cost > suggestedRemainingKm + 1e-9; if (actualWeekKm >= envelope.suggestedWeeklyKm) envelope.weeklyProtectionKm = envelope.suggestedWeeklyKm;" },
  { id: "rolling", file: "coach-loop-decision.ts",
    before: "passed: actualKm + reservedKm + cost <= ceilingKm + 1e-9",
    after: 'passed: code !== "natural_week" || actualKm + reservedKm + cost <= ceilingKm + 1e-9' },
  { id: "anchor", file: "weekly-capacity.ts",
    before: "coachLocalDate(run.startedAt) < weekStart",
    after: "coachLocalDate(run.startedAt) <= coachLocalDate(input.asOf)" },
  { id: "single", file: "coach-extension-eligibility.ts",
    before: "Date.parse(item.startedAt) < Date.parse(run.startedAt)",
    after: "Date.parse(item.startedAt) <= Date.parse(run.startedAt)" },
  { id: "protection", file: "race-plan-policy.ts",
    before: "PRE_RACE_EXECUTION_PROTECTION_DAYS = 14", after: "PRE_RACE_EXECUTION_PROTECTION_DAYS = 13" },
  { id: "work", file: "coach-session-dose.ts",
    before: 'if (input.kind === "interval" ? repetitions < 4 || workMeters < 3200 :\n    input.kind === "tempo" ? workSeconds < 1440 : workSeconds < 1200)',
    after: "if (false)" },
  { id: "execution-unknown", file: "coach-execution-assessment.ts",
    before: 'completion: day.kind === "rest" ? "not_applicable" : "unconfirmed", reasons',
    after: 'completion: day.kind === "rest" ? "not_applicable" : "known_not_met", reasons' },
  { id: "execution-reconstructed", file: "coach-execution-assessment.ts",
    before: 'const measured = workout.evidenceLevel === "measured_steps" && segmentsUsable;',
    after: 'const measured = workout.evidenceLevel !== "summary_only" && segmentsUsable;' },
  { id: "execution-coverage", file: "coach-execution-assessment.ts",
    before: "EXECUTION_SIGNAL_COVERAGE_FRACTION = 0.8", after: "EXECUTION_SIGNAL_COVERAGE_FRACTION = 0.7" },
  { id: "execution-retroactive", file: "coach-execution-assessment.ts",
    before: "Date.parse(prescription.createdAt) <= Date.parse(workout.startedAt)", after: "true" },
  { id: "repair-lock", file: "coach-plan-repair.ts",
    before: "if (protectedDates.has(row.day.localDate) || original && !affected.has(row.day.localDate)) return row;",
    after: "if (original && !affected.has(row.day.localDate)) return row;" },
  { id: "repair-feasibility", file: "coach-plan-repair.ts",
    before: "if (!validation.feasible) return;", after: "if (false) return;" },
  { id: "repair-authorization", file: "coach-plan-repair.ts",
    before: "executable: row.executable, authorizedDecisionRef: row.authorizedDecisionRef",
    after: "executable: false, authorizedDecisionRef: null" },
  { id: "repair-exhaustion", file: "coach-plan-repair.ts",
    before: "if (exhausted) return { ...base, reasons:", after: "if (false && exhausted) return { ...base, reasons:" },
  { id: "repair-intent", file: "coach-plan-repair.ts",
    before: "const requiredIntents = new Set(input.requiredIntentDates);", after: "const requiredIntents = new Set<string>();" },
  { id: "feedback-late", file: "coach-subjective-feedback.ts",
    before: "Date.parse(revision.availableAt) > Date.parse(input.asOf)", after: "false" },
  { id: "feedback-expiry", file: "coach-subjective-feedback.ts",
    before: "revision.localDate === today && Date.parse(input.asOf) < Date.parse(revision.validUntil) &&",
    after: "true &&" },
  { id: "feedback-skip", file: "coach-subjective-feedback.ts",
    before: 'if ([fields.fatigue, fields.soreness, fields.discomfort, fields.requestedAction,\n    fields.interruptionReason, fields.replacementReason, fields.rpeOverrideRef].every(value => value === null)) return null;',
    after: "if (false) return null;" },
  { id: "gap-sign", file: "coach-goal-gap.ts",
    before: "result.gapSeconds = entry.referenceSeconds - input.targetSeconds;",
    after: "result.gapSeconds = input.targetSeconds - entry.referenceSeconds;" },
  { id: "gap-freshness", file: "coach-goal-gap.ts",
    before: "const throughDate = coachLocalDate(summary.dataThroughAt);",
    after: "const throughDate = coachLocalDate(summary.asOf);" },
  { id: "gap-compatibility", file: "coach-goal-gap.ts",
    before: "digest(identity(summary)) !== digest(identity(input.currentIdentity))", after: "false" }
];

try {
  if (digest(mutants.map(m => m.id).sort()) !== digest(Object.keys(assertions).sort()))
    throw new Error("Mutation definitions do not match the required compile/behavior inventory");
  cpSync(resolve(root, "apps/api/src"), resolve(temporary, "apps/api/src"), { recursive: true });
  mkdirSync(resolve(temporary, "scripts"), { recursive: true });
  for (const name of ["coach-replay-core.mts", "coach-replay-scenarios.mts", "coach-execution-fixtures.mts", "coach-runtime-fixtures.mts"]) {
    cpSync(resolve(root, "scripts", name), resolve(temporary, "scripts", name));
  }
  symlinkSync(resolve(root, "node_modules"), resolve(temporary, "node_modules"), "dir");
  writeFileSync(resolve(temporary, "package.json"), '{"type":"module"}\n');
  const config = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8"));
  config.include = ["apps/api/src/**/*.ts", "scripts/**/*.mts"];
  writeFileSync(resolve(temporary, "tsconfig.json"), JSON.stringify(config));
  writeFileSync(resolve(temporary, "scripts/probe.mts"), probe);
  const run = (args: string[]) => spawnSync(process.execPath, args, { cwd: temporary, encoding: "utf8", timeout: 120_000 });
  // Each mutant is type-checked. The isolated incremental cache tracks content
  // changes; it does not treat compilation failures as semantic kills.
  const compileArgs = [tsc, "--noEmit", "--incremental", "--tsBuildInfoFile", resolve(temporary, "typecheck.tsbuildinfo"), "-p", "tsconfig.json"];
  const baselineCompile = run(compileArgs);
  if (baselineCompile.status !== 0) throw new Error(`Mutation baseline did not compile:\n${baselineCompile.stdout}${baselineCompile.stderr}`);
  const results: Array<{ id: string; assertionId: string; compiled: true; status: "killed" }> = [];
  for (const mutant of mutants) {
    const path = resolve(temporary, "apps/api/src", mutant.file);
    const original = readFileSync(path, "utf8");
    if (!original.includes(mutant.before) || original.indexOf(mutant.before) !== original.lastIndexOf(mutant.before)) {
      throw new Error(`Mutation anchor not unique: ${mutant.id}`);
    }
    const baseline = run(["--import", "tsx", "scripts/probe.mts", mutant.id]);
    if (baseline.status !== 0) throw new Error(`Behavior baseline failed: ${mutant.id}\n${baseline.stdout}${baseline.stderr}`);
    writeFileSync(path, original.replace(mutant.before, mutant.after));
    try {
      const compile = run(compileArgs);
      if (compile.status !== 0) throw new Error(`NOT KILLED (compile failure): ${mutant.id}\n${compile.stdout}${compile.stderr}`);
      const behavior = run(["--import", "tsx", "scripts/probe.mts", mutant.id]);
      if (behavior.status === null || behavior.signal || behavior.status === 0 || !behavior.stderr.includes("AssertionError") ||
        !behavior.stderr.includes(assertions[mutant.id]!)) {
        throw new Error(`NOT KILLED by behavior: ${mutant.id}\n${behavior.stdout}${behavior.stderr}`);
      }
      console.log(`KILLED (compiled, named behavior assertion): ${mutant.id}`);
      results.push({ id: mutant.id, assertionId: assertions[mutant.id]!, compiled: true, status: "killed" });
    } finally { writeFileSync(path, original); }
  }
  console.log(`Coach loop mutations: ${mutants.length}/${mutants.length} compiled semantic mutants killed. Candidate evidence only.`);
  if (sourceIdentity.sourceTreeHash !== coachReplaySourceIdentity().sourceTreeHash) throw new Error("Source changed during coach mutation validation");
  const report = { schemaVersion: 1, purpose: "compiled_behavior_mutations_not_training_effect",
    ...sourceIdentity, status: "passed", mutationCount: mutants.length, results };
  if (args[1]) {
    const path = resolve(args[1]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...report, reportHash: digest(report) }, null, 2)}\n`);
    console.log(`Mutation evidence: ${path}`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
