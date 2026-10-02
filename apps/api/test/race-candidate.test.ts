import assert from "node:assert/strict";
import test from "node:test";

import {
  DISTANCE_TOLERANCE_FRACTION,
  candidateEntryKey,
  findRaceCandidates,
  nearestStandardDistance,
  type RaceCandidateSession
} from "../src/race-candidate.js";

/**
 * T06: the candidate list may only propose entries the write path will accept, and it
 * must say why each one was proposed.
 *
 * The failure this guards is a suggestion the runner cannot act on: an 8 km run
 * proposed as a 10K label, or a "race" that is really their ordinary Tuesday. A
 * candidate the API then refuses teaches the runner to distrust the list.
 */

const session = (overrides: Partial<RaceCandidateSession> = {}): RaceCandidateSession => ({
  trainingSessionId: "session_1",
  completedAt: "2026-09-06T01:30:00.000Z",
  localDate: "2026-09-06",
  distanceMeters: 10_050,
  durationSeconds: 2_400,
  labelled: false,
  ...overrides
});

test("T06: distance must sit within tolerance of a standard distance", () => {
  assert.deepEqual(nearestStandardDistance(10_000), { distance: "ten_k", deviation: 0 });
  assert.equal(nearestStandardDistance(10_000 * (1 + DISTANCE_TOLERANCE_FRACTION * 0.9))?.distance, "ten_k");
  assert.equal(nearestStandardDistance(8_300), null, "an 8.3 km run cannot become a label");
  assert.equal(nearestStandardDistance(21_000)?.distance, "half_marathon");
  // 5 km sits far closer to 5K than to 10K: the nearest standard wins.
  assert.equal(nearestStandardDistance(5_100)?.distance, "five_k");
});

test("T06: a hard run at a standard distance is proposed, with its reasons", () => {
  const candidates = findRaceCandidates([
    session({ trainingSessionId: "easy_1", distanceMeters: 10_100, durationSeconds: 3_000 }),
    session({ trainingSessionId: "easy_2", distanceMeters: 10_000, durationSeconds: 3_050 }),
    session({ trainingSessionId: "race_1", distanceMeters: 10_020, durationSeconds: 2_400 })
  ]);
  const race = candidates.find((item) => item.trainingSessionId === "race_1")!;
  assert.equal(race.distance, "ten_k");
  assert.equal(race.confidence, "likely");
  assert.equal(race.localDate, "2026-09-06");
  assert.ok(race.reasons.some((reason) => reason.includes("中位配速")), "why it was proposed travels with it");
  assert.ok(race.reasons[0]!.includes("10.02 km"));
});

test("T06: an ordinary run is still offered, but marked possible", () => {
  const candidates = findRaceCandidates([
    session({ trainingSessionId: "a", durationSeconds: 2_400 }),
    session({ trainingSessionId: "b", durationSeconds: 2_410 }),
    session({ trainingSessionId: "c", durationSeconds: 2_420 })
  ]);
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((item) => item.confidence === "possible"));
});

test("T06: already-labelled sessions are never proposed again", () => {
  const candidates = findRaceCandidates([
    session({ trainingSessionId: "done", labelled: true }),
    session({ trainingSessionId: "open" })
  ]);
  assert.deepEqual(candidates.map((item) => item.trainingSessionId), ["open"]);
});

test("T06: a confirmed candidate stops being proposed", () => {
  const sessions = [session({ trainingSessionId: "race_1", localDate: "2026-09-06" })];
  assert.equal(findRaceCandidates(sessions).length, 1);

  // Confirmation writes a manual entry; the session itself stays unlabelled. Keyed by
  // date *and* distance, so a 5K shakeout on race morning is still offered.
  const confirmed = new Set([candidateEntryKey("2026-09-06", "ten_k")]);
  assert.deepEqual(findRaceCandidates(sessions, { existingEntryKeys: confirmed }), []);
  assert.equal(
    findRaceCandidates(sessions, { existingEntryKeys: new Set([candidateEntryKey("2026-09-06", "five_k")]) }).length,
    1
  );
});

test("T06: the same bounds the write path enforces are applied here", () => {
  const candidates = findRaceCandidates([
    // 10 km in 20 minutes: refused by the repository, so it must not be proposed.
    session({ trainingSessionId: "impossible", durationSeconds: 1_200 }),
    // 10 km in 5 hours: outside the duration bounds.
    session({ trainingSessionId: "walk", durationSeconds: 5 * 3_600 }),
    session({ trainingSessionId: "fine", durationSeconds: 2_400 })
  ]);
  assert.deepEqual(candidates.map((item) => item.trainingSessionId), ["fine"]);
});

test("T06: the baseline is this runner's own median, not a population pace", () => {
  // A runner whose every 10K is around 6:00/km: a 5:50/km effort is *their* hard day.
  const slowRunner = findRaceCandidates([
    session({ trainingSessionId: "s1", durationSeconds: 3_600 }),
    session({ trainingSessionId: "s2", durationSeconds: 3_620 }),
    // 3 300 s against a 3 600 s median is 8.3% faster — their hard day, not a jog.
    session({ trainingSessionId: "s3", durationSeconds: 3_300 })
  ]);
  assert.equal(slowRunner.find((item) => item.trainingSessionId === "s3")!.confidence, "likely");

  // The same three sessions for a 40-minute 10K runner are ordinary training.
  const fastRunner = findRaceCandidates([
    session({ trainingSessionId: "f1", durationSeconds: 2_400 }),
    session({ trainingSessionId: "f2", durationSeconds: 2_420 }),
    session({ trainingSessionId: "f3", durationSeconds: 2_380 })
  ]);
  assert.equal(fastRunner.find((item) => item.trainingSessionId === "f3")!.confidence, "possible");
});
