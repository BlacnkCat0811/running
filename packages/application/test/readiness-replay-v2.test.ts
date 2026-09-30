import assert from "node:assert/strict";
import test from "node:test";
import { replayReadinessRulings, type ReadinessReplayFacts } from "../src/index.js";
import type { DatedRecoverySignal } from "@rai/readiness";
import type { ReplayDescriptorV2 } from "@rai/contracts";

const asOf = "2026-09-29T08:00:00Z";
const localDate = "2026-09-29";

const descriptor = (overrides: Partial<ReplayDescriptorV2> = {}): ReplayDescriptorV2 => ({
  caseId: "readiness-case",
  asOf,
  timezoneIdentifier: "Asia/Shanghai",
  replayMode: "event_time_reconstruction",
  factsSnapshotHash: "facts",
  overrideSnapshotHash: "overrides",
  availabilityUnknown: false,
  ...overrides
});

const signal = (overrides: Partial<DatedRecoverySignal> = {}): DatedRecoverySignal => ({
  value: 100,
  baseline: 100,
  observedAt: "2026-09-29T00:00:00Z",
  availableAt: "2026-09-29T01:00:00Z",
  localDate,
  ...overrides
});

const facts = (overrides: Partial<ReadinessReplayFacts["signals"]> = {}, nights: DatedRecoverySignal[] = []): ReadinessReplayFacts => ({
  localDate,
  signals: {
    sleep: signal({ value: 400, baseline: 480 }),
    hrv: signal({ value: 60, baseline: 60 }),
    rhr: signal({ value: 50, baseline: 50 }),
    ...overrides
  },
  nights
});

test("two branches agree when every fact arrived before asOf", () => {
  const replay = replayReadinessRulings({ descriptor: descriptor(), facts: facts() });
  // 两个分支调用的是同一个生产函数，只有到达时间假设不同 ⇒ 到达时间没用上时**裁决**必须相同。
  // 断言的是 rulingEqual 而不是 semanticEqual：后者会被回显的到达时间戳弄成恒 false。
  assert.equal(replay.rulingEqual, true);
  assert.deepEqual(replay.arrivalSensitiveReasonCodes, []);
  assert.equal(replay.base.version, "observation_only_counterfactual");
  assert.equal(replay.candidate.version, "rai-readiness-ruleset-v1");
  assert.equal(replay.accuracyStatus, "not_evaluable");
});

test("a fact that arrived after asOf is what the counterfactual branch would have used", () => {
  // 今天的 HRV：窗口 06:00 结束、但 09:00 才算出来，而 asOf 是 08:00 ⇒ 观测早、到达晚。
  const late = {
    hrv: signal({
      observedAt: "2026-09-29T06:00:00Z",
      availableAt: "2026-09-29T09:00:00Z"
    })
  };
  const replay = replayReadinessRulings({ descriptor: descriptor(), facts: facts(late) });
  assert.equal(replay.rulingEqual, false, "到达时间改变了裁决 ⇒ 两支的裁决必须不同");
  assert.ok(
    replay.arrivalSensitiveReasonCodes.includes("hrv_unavailable_at_assessment"),
    `严格支必须给出到达时间理由码，实际=${JSON.stringify(replay.arrivalSensitiveReasonCodes)}`
  );
  // 反事实支看不到这个理由码：它假装事实已到达。
  assert.equal(replay.base.output.reasonCodes.includes("hrv_unavailable_at_assessment"), false);
});

test("an unknown arrival time also separates the branches and blocks as_known_then certification", () => {
  const unknownArrival = { hrv: signal({ availableAt: null }) };
  const reconstructed = replayReadinessRulings({ descriptor: descriptor(), facts: facts(unknownArrival) });
  assert.equal(reconstructed.rulingEqual, false, "到达时间未知时两支的裁决必须不同");

  // 框架自己的规则：到达时间未知就不能声称 as_known_then（这条不属于本模块，但要确认它确实生效）。
  assert.throws(
    () => replayReadinessRulings({
      descriptor: descriptor({ replayMode: "as_known_then", availabilityUnknown: true }),
      facts: facts(unknownArrival)
    }),
    /as-known-then/
  );
});

test("the same frozen facts always produce the same pair", () => {
  const run = () => replayReadinessRulings({ descriptor: descriptor(), facts: facts() }).candidate.semantic;
  assert.equal(run(), run());
});
