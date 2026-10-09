import type {
  MobileSessionKind,
  MobileSessionStructure,
  MobileStepAlert,
  MobileStepGoal,
  MobileStepPurpose,
  WorkoutSegment,
  WorkoutSegmentPlanMatch,
  WorkoutSegmentPurpose
} from "@rai/api-contracts";
import type { StoredMeasuredSegment, StoredWorkoutEventInterval } from "@rai/storage-sqlite";

import type { PlanHistoryRevision, PlanPushRecord } from "./mobile-goals.js";

/**
 * Segment assembly for one run.
 *
 * The detail page used to show kilometre splits and nothing else, because the
 * only segmentation the pipeline could express was `nextBoundary = 1000`. Three
 * producers can describe what was actually run, in this order of authority:
 *
 * 1. **the steps the Watch itself recorded** — `HKWorkoutActivity`, one per
 *    prescription step, read back out of the workout's metadata. This is a
 *    measurement, and it is what settles the boundaries;
 * 2. **the stored weekly plan, replayed onto the measured speed track** — the
 *    source of the labels and goals, and the only producer available for runs
 *    the Watch recorded without a step layer (an older build, an import that
 *    never carried the entry, a multisport session we decline);
 * 3. **the Watch's own `HKWorkoutEvent` lap/segment boundaries** — the last
 *    resort, because real exports show those events are auto-lap partitions
 *    (see {@link resolveSegmentation}), not steps.
 *
 * The panel is titled 课表分段, so what it owes the reader is the
 * prescription's steps with measured numbers. Producers 1 and 2 split that job:
 * the measurement says *where* each step ended, the plan says *what it was*.
 * When neither is available the caller keeps the kilometre splits and says why.
 */

/** A speed-track sample reduced to what segment arithmetic needs. */
export interface SegmentTrackSample {
  startMs: number;
  endMs: number;
  meters: number;
}

export interface SegmentTrack {
  samples: SegmentTrackSample[];
  officialMeters: number;
}

/** A stored plan day the run may have executed. */
export interface MatchedPlanDay {
  localDate: string;
  kind: MobileSessionKind;
  revision: number;
  matchedBy: WorkoutSegmentPlanMatch["matchedBy"];
  plannedDistanceKm: number | null;
  structure: MobileSessionStructure;
}

/** A plan day that could explain a run, with where the candidate came from. */
export interface PlanCandidateDay {
  validUntil?: string;
  localDate: string;
  kind: MobileSessionKind;
  revision: number;
  matchedBy: WorkoutSegmentPlanMatch["matchedBy"];
  structure: MobileSessionStructure;
  distanceKm: number | null;
  /** When the phone handed this day to the Watch; `null` for plan-history days. */
  pushedAt: string | null;
}

export interface SegmentDescriptor {
  label: string;
  purpose: WorkoutSegmentPurpose;
  goal: MobileStepGoal | null;
  alert: MobileStepAlert | null;
}

export interface Segmentation {
  /** Ascending boundaries; `boundaries.length - 1` segments are described. */
  boundaries: number[];
  descriptors: SegmentDescriptor[];
  plan: WorkoutSegmentPlanMatch | null;
  note: string | null;
}

export interface PlannedStepLayout {
  startMs: number;
  endMs: number;
  label: string;
  purpose: MobileStepPurpose;
  goal: MobileStepGoal;
  alert: MobileStepAlert | null;
}

const STEP_LABELS: Record<MobileStepPurpose, string> = {
  warmup: "热身",
  work: "训练",
  recovery: "恢复",
  cooldown: "整理放松"
};

/** The stretch past the last planned step — 小唐's "结束后又跑了一段". */
const UNPLANNED_LABEL = "自由训练";

/**
 * Boundaries closer than this are dropped: a 200 ms sliver is measurement
 * noise (HealthKit event timestamps are not exact), and showing it as a row
 * would be worse than showing nothing.
 */
const MIN_SEGMENT_MS = 5_000;

/** One step the Watch recorded, on the run's own timeline. */
export interface MeasuredStep {
  startMs: number;
  endMs: number;
}

/**
 * The metadata key the iOS export writes its activity layer under.
 *
 * `HKWorkoutActivity` covers the whole workout for an ordinary run and gains
 * one entry per prescription step once a structured session is on the Watch, so
 * this entry *is* the measured step layout. The name still says `Diag` because
 * that is what it was called when it shipped (`810acd4`) and renaming it would
 * cost another app build; it is a contract field now.
 */
export const STRUCTURE_METADATA_KEY = "RAIWorkoutStructureDiagV1";

const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Pull the raw payload out from under `STRUCTURE_METADATA_KEY`.
 *
 * 🔴 A metadata value is a `MetadataMap` entry, i.e. `Record<string, string[]>`
 * (`packages/contracts/src/index.ts:43`): the parser *appends* on every
 * `MetadataEntry` rather than overwriting (`health-export-parser/src/utils.ts:91`),
 * so a key written once still arrives as a one-element array. The first version
 * of this reader tested the entry with `typeof inner !== "string"`, a condition
 * that could never hold, so it returned `[]` on every real workout and the
 * measured path never ran in production (`965cd54`). Both shapes are accepted
 * now; a repeated key takes its last entry, mirroring `lastMetadataValue`.
 */
const structurePayloadOf = (metadataJson: string): unknown => {
  let metadata: Record<string, unknown> | null;
  try {
    metadata = JSON.parse(metadataJson) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  const entry = metadata?.[STRUCTURE_METADATA_KEY];
  const raw = Array.isArray(entry) ? entry[entry.length - 1] : entry;
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

/**
 * Read the Watch's recorded steps out of a workout's metadata.
 *
 * Offsets in the entry are milliseconds from the workout's start, so they are
 * re-anchored onto the caller's timeline here — no date parsing, and a session
 * whose start drifts a fraction from the workout row still lines up.
 *
 * Everything about this function is "decline rather than guess": a payload that
 * does not parse, an activity missing a field, steps that overlap, or activities
 * of differing types (a multisport session puts different sports in one
 * workout, and labelling them as run steps would be a lie) all return `[]`,
 * which sends the caller to the replay it used before.
 */
export const measuredStepsOf = (
  metadataJson: string | null,
  startedAtMs: number,
  endedAtMs: number
): MeasuredStep[] => {
  if (metadataJson === null) return [];
  const payload = structurePayloadOf(metadataJson);
  const activities = (payload as { activities?: unknown } | null)?.activities;
  if (!Array.isArray(activities)) return [];

  const activityTypes = new Set<number>();
  const steps: MeasuredStep[] = [];
  for (const activity of activities) {
    const record = activity as Record<string, unknown>;
    const offsetMs = numberOf(record.startMs);
    const durationMs = numberOf(record.durationMs);
    const activityTypeRaw = numberOf(record.activityTypeRaw);
    if (offsetMs === null || durationMs === null || activityTypeRaw === null) return [];
    activityTypes.add(activityTypeRaw);
    // Step offsets are measured from the workout start, and the Watch can place
    // the first step a few hundred milliseconds *before* it (the workout start
    // comes from the first sample, the step from the activity record). Dropping
    // such a step shifts every later step one slot left in `planned[index]`,
    // which silently relabels "恢复" as "训练" while still producing a
    // plausible-looking panel — a wrong answer that reads like a right one.
    // Clamp to the workout start instead, keeping the measured duration so the
    // step's own end boundary stays where the Watch put it.
    const rawStartMs = startedAtMs + offsetMs;
    if (rawStartMs >= endedAtMs) continue;
    const startMs = Math.max(startedAtMs, rawStartMs);
    const endMs = Math.min(endedAtMs, rawStartMs + durationMs);
    if (endMs - startMs < MIN_SEGMENT_MS) continue;
    steps.push({ startMs, endMs });
  }
  if (activityTypes.size > 1) return [];

  steps.sort((left, right) => left.startMs - right.startMs);
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index]!.startMs < steps[index - 1]!.endMs) return [];
  }
  return steps;
};

/**
 * Turn Watch lap/segment events into ascending time boundaries.
 *
 * Nonzero durations are real segments (`HKWorkoutEventTypeLap`: "newer lap
 * events use the date interval to mark the start and the duration of the lap").
 * Legacy zero-duration laps mark the *end* of a lap, and "laps fill the entire
 * workout completely", so their timestamp alone is a boundary. Markers are
 * points in time and contribute the same way. Pause/resume never reach here.
 */
export const eventBoundariesOf = (
  events: StoredWorkoutEventInterval[],
  startedAtMs: number,
  endedAtMs: number
): number[] => {
  const points = new Set<number>();
  for (const event of events) {
    if (event.endMs > event.startMs) {
      for (const point of [event.startMs, event.endMs]) {
        if (point > startedAtMs && point < endedAtMs) points.add(point);
      }
    } else if (event.startMs > startedAtMs && event.startMs < endedAtMs) {
      points.add(event.startMs);
    }
  }
  const boundaries: number[] = [startedAtMs];
  for (const point of [...points].sort((left, right) => left - right)) {
    const previous = boundaries[boundaries.length - 1]!;
    if (point - previous < MIN_SEGMENT_MS) continue;
    if (endedAtMs - point < MIN_SEGMENT_MS) continue;
    boundaries.push(point);
  }
  boundaries.push(endedAtMs);
  return boundaries;
};

const stepLabel = (purpose: MobileStepPurpose, iteration: number | null, iterations: number): string => {
  const base = STEP_LABELS[purpose];
  return iteration !== null && iterations > 1 ? `${base} ${iteration}/${iterations}` : base;
};

/** Flatten warmup + repeated blocks + cooldown into the order they are run. */
export const flattenStructure = (
  structure: MobileSessionStructure
): Array<{ step: { purpose: MobileStepPurpose; goal: MobileStepGoal; alert: MobileStepAlert | null }; label: string }> => {
  const steps: Array<{
    step: { purpose: MobileStepPurpose; goal: MobileStepGoal; alert: MobileStepAlert | null };
    label: string;
  }> = [];
  if (structure.warmup) steps.push({ step: structure.warmup, label: stepLabel(structure.warmup.purpose, null, 1) });
  for (const block of structure.blocks) {
    const iterations = Math.max(1, Math.floor(block.iterations));
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      for (const step of block.steps) {
        steps.push({ step, label: stepLabel(step.purpose, iteration, iterations) });
      }
    }
  }
  if (structure.cooldown) steps.push({ step: structure.cooldown, label: stepLabel(structure.cooldown.purpose, null, 1) });
  return steps;
};

/**
 * Milliseconds at which the scaled track has travelled `meters` past `fromMs`.
 * Returns the end of the track when the distance is never reached, so the
 * caller can tell "plan outran the run" from "plan finished inside it".
 */
export const timeAtMeters = (track: SegmentTrack, fromMs: number, meters: number): number => {
  if (meters <= 0) return fromMs;
  let travelled = 0;
  let cursor = fromMs;
  for (const sample of track.samples) {
    if (sample.endMs <= cursor) continue;
    const startMs = Math.max(sample.startMs, cursor);
    const span = sample.endMs - sample.startMs;
    if (span <= 0) continue;
    const sampleMeters = sample.meters * ((sample.endMs - startMs) / span);
    if (travelled + sampleMeters >= meters) {
      const fraction = sampleMeters > 0 ? (meters - travelled) / sampleMeters : 0;
      return startMs + (sample.endMs - startMs) * fraction;
    }
    travelled += sampleMeters;
    cursor = sample.endMs;
  }
  return track.samples[track.samples.length - 1]?.endMs ?? fromMs;
};

/**
 * Replay a plan structure onto the measured speed track.
 *
 * Distance goals are resolved through the track (so a 2 600 m step ends where
 * 2 600 m was actually run, not where the plan hoped it would be); time goals
 * are exact; `open` goals absorb the remainder, matching how the Watch treats
 * a free step.
 */
export const layoutStructure = (
  structure: MobileSessionStructure,
  track: SegmentTrack,
  startedAtMs: number,
  endedAtMs: number
): { steps: PlannedStepLayout[]; truncated: boolean } => {
  const planned = flattenStructure(structure);
  const steps: PlannedStepLayout[] = [];
  let cursorMs = startedAtMs;
  for (const item of planned) {
    if (cursorMs >= endedAtMs) break;
    const goal = item.step.goal;
    const endMs =
      goal.type === "distance"
        ? Math.min(endedAtMs, timeAtMeters(track, cursorMs, goal.meters))
        : goal.type === "time"
          ? Math.min(endedAtMs, cursorMs + goal.seconds * 1000)
          : endedAtMs;
    if (endMs <= cursorMs) break;
    steps.push({
      startMs: cursorMs,
      endMs,
      label: item.label,
      purpose: item.step.purpose,
      goal,
      alert: item.step.alert
    });
    cursorMs = endMs;
  }
  return { steps, truncated: steps.length < planned.length };
};

/**
 * Build the candidate list `matchPlanDay` chooses from.
 *
 * Two sources, and the order they are read in *is* the precedence:
 *
 * 1. **push receipts** — the only record of the day the phone actually handed a
 *    session to the Watch, which is the only thing that survives the runner's
 *    real habit (sync tomorrow's session, run it tonight: the run's own local
 *    date points at a rest day);
 * 2. **plan history**, newest revision first — for everything else.
 *
 * A revision is one edit of the whole week, so it answers for every date it
 * covers. That includes its **rest** days: a newer revision that replaced a
 * session with rest means that session is no longer what the runner was asked to
 * run, so it must not resurface from an older revision. Skipping rest days
 * without claiming their date did exactly that — on 2026-09-14 it resurrected a
 * stale 2.4 km easy day out of revision 3 after revisions 4–6 had turned the day
 * into rest, and the segment panel then replayed the wrong prescription.
 *
 * Everything here is a *candidate*; choosing one is {@link matchPlanDay}'s job,
 * which keeps the guess explainable instead of spread across two layers.
 */
export const assemblePlanCandidates = (
  pushes: ReadonlyArray<PlanPushRecord>,
  history: ReadonlyArray<PlanHistoryRevision>
): PlanCandidateDay[] => {
  const candidates: PlanCandidateDay[] = pushes.flatMap((push) =>
    push.structure == null || (push.lifecycleEvent !== undefined && push.lifecycleEvent !== "verified")
      ? []
      : [
          {
            localDate: push.localDate,
            kind: push.kind,
            revision: push.revision,
            matchedBy: "push_record" as const,
            structure: push.structure,
            distanceKm: null,
            pushedAt: push.verifiedAt ?? push.pushedAt,
            ...(() => {
              const end = pushes.filter(event => event.workoutID === push.workoutID && event.scheduledAt === push.scheduledAt &&
                event.lifecycleEvent !== undefined && event.lifecycleEvent !== "verified")
                .map(event => event.verifiedAt ?? event.pushedAt).sort()[0];
              return end ? { validUntil: end } : {};
            })()
          }
        ]
  );
  /** Dates some revision has already answered for. */
  const claimed = new Set<string>();
  for (const revision of history) {
    const days: PlanCandidateDay[] = [];
    const locked = revision.lockedSession;
    // The lock is the session the app actually told the runner to run today, so
    // it outranks the same date in the week plan.
    if (locked?.session.structure) {
      days.push({
        localDate: locked.localDate,
        kind: locked.session.kind,
        revision: revision.revision,
        matchedBy: "plan_history",
        structure: locked.session.structure,
        distanceKm: locked.session.distanceKm,
        pushedAt: null
      });
    }
    for (const day of revision.weekPlan) {
      if (!day.structure || day.kind === "rest") continue;
      days.push({
        localDate: day.localDate,
        kind: day.kind,
        revision: revision.revision,
        matchedBy: "plan_history",
        structure: day.structure,
        distanceKm: day.distanceKm,
        pushedAt: null
      });
    }
    // Newest revision first, so the first day seen for a date is the freshest.
    for (const day of days) {
      if (claimed.has(day.localDate)) continue;
      claimed.add(day.localDate);
      candidates.push(day);
    }
    // Rest days contribute no candidate, but they do answer for their date.
    for (const day of revision.weekPlan) {
      if (!day.structure || day.kind === "rest") claimed.add(day.localDate);
    }
  }
  return candidates;
};

const planMatch = (
  plan: MatchedPlanDay,
  explainedFraction: number,
  reason: string
): WorkoutSegmentPlanMatch => ({
  localDate: plan.localDate,
  kind: plan.kind,
  revision: plan.revision,
  matchedBy: plan.matchedBy,
  plannedDistanceKm: plan.plannedDistanceKm,
  explainedFraction,
  reason
});

/**
 * How long before a run a push receipt still counts as "this is the session I
 * ran". Generous on purpose — the phone pushes tomorrow's plan and the runner
 * may not start until the next morning — but far short of a week, so an old
 * receipt cannot claim a later run.
 */
export const PLAN_MATCH_WINDOW_MS = 36 * 60 * 60 * 1000;

/** Naive-date arithmetic on `YYYY-MM-DD`; the date is a calendar label, not an instant. */
const shiftDate = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const asMatched = (candidate: PlanCandidateDay): MatchedPlanDay => ({
  localDate: candidate.localDate,
  kind: candidate.kind,
  revision: candidate.revision,
  matchedBy: candidate.matchedBy,
  plannedDistanceKm: candidate.distanceKm,
  structure: candidate.structure
});

const bestOf = (candidates: PlanCandidateDay[]): PlanCandidateDay | null =>
  candidates.length === 0 ? null : [...candidates].sort((left, right) => right.revision - left.revision)[0]!;

/**
 * Pick the plan day a run most likely executed.
 *
 * Order of authority, and why:
 *
 * 1. **a push receipt inside the window** — the only rule that survives the
 *    runner's actual habit: sync tomorrow's session, run it tonight. The run's
 *    own local date points at a *rest* day in that case, so date matching alone
 *    can never work here;
 * 2. **plan history on the run's own date** — covers "run it the next morning",
 *    and any day the runner ran as scheduled;
 * 3. **plan history one day either side** — same habit as (1) but without a
 *    receipt (an older build, or a re-run after the fact). Constrained to a
 *    single day, to a known run distance, and to a plan that does not ask for
 *    more distance than the run contains, because this rule guesses.
 *
 * The numbers shown never come from the plan: the plan only supplies the
 * boundaries, and every distance/pace/heart-rate value is measured off the
 * track. A wrong guess therefore mislabels segments rather than inventing them,
 * which is why (3) is allowed to exist at all.
 */
export const matchPlanDay = (input: {
  candidates: PlanCandidateDay[];
  startedAtMs: number;
  localDate: string;
  distanceKm: number | null;
}): MatchedPlanDay | null => {
  const { candidates, startedAtMs, localDate, distanceKm } = input;
  const pushes = candidates
    .filter((candidate) => candidate.matchedBy === "push_record" && candidate.pushedAt !== null)
    .flatMap((candidate) => {
      const pushedAtMs = Date.parse(candidate.pushedAt!);
      if (!Number.isFinite(pushedAtMs)) return [];
      if (candidate.validUntil && startedAtMs >= Date.parse(candidate.validUntil)) return [];
      if (pushedAtMs > startedAtMs || startedAtMs - pushedAtMs > PLAN_MATCH_WINDOW_MS) return [];
      return [candidate];
    })
    .sort((left, right) => Date.parse(right.pushedAt!) - Date.parse(left.pushedAt!));
  if (pushes.length > 0) return asMatched(pushes[0]!);

  const history = candidates.filter((candidate) => candidate.matchedBy === "plan_history");
  const sameDay = bestOf(history.filter((candidate) => candidate.localDate === localDate));
  if (sameDay) return asMatched(sameDay);

  // The neighbour rule guesses, and the run's own distance is the only thing that
  // keeps the guess checkable — it rejects a plan asking for more than the run
  // contains. With no distance there is nothing to check against, so the rule
  // declines rather than labelling an arbitrary nearby day. The same-day match
  // above is unaffected: that one is an identity, not a guess.
  if (distanceKm === null) return null;

  for (const date of [shiftDate(localDate, 1), shiftDate(localDate, -1)]) {
    const neighbour = bestOf(
      history
        .filter((candidate) => candidate.localDate === date)
        .filter(
          (candidate) =>
            candidate.distanceKm !== null &&
            candidate.distanceKm > 0 &&
            candidate.distanceKm <= distanceKm * 1.05 + 0.2
        )
    );
    if (neighbour) return asMatched(neighbour);
  }
  return null;
};

/**
 * Say, in the note the phone renders, that the Watch recorded events this panel
 * deliberately did not use.
 *
 * Without it "the panel shows the plan's steps" and "the panel shows the Watch's
 * laps" look identical from the phone. That ambiguity is what turned one wrong
 * sentence into a whole afternoon of looking in the wrong place.
 */
const eventFootnote = (segments: number): string =>
  segments === 0 ? "" : `；手表另有 ${segments} 段 lap/segment 事件未参与分段`;

/**
 * Describe the measured branch's provenance, and say so when the Watch recorded
 * a different number of steps than the plan asked for — that gap is real (the
 * runner stopped early, or added an interval) and the reader should see it
 * rather than have it papered over by a replay.
 */
const measuredNote = (
  measured: number,
  plan: MatchedPlanDay | null,
  plannedSteps: number,
  eventSegments: number
): string => {
  if (plan === null) {
    return `分段由手表记录的 ${measured} 个步骤实测得到${eventFootnote(eventSegments)}`;
  }
  const mismatch = measured === plannedSteps ? "" : `；课表为 ${plannedSteps} 步`;
  return `分段由手表记录的 ${measured} 个训练步骤实测得到（课表 ${plan.localDate} 第 ${
    plan.revision
  } 版）${mismatch}${eventFootnote(eventSegments)}`;
};

/**
 * Decide the segment boundaries for one run and describe each of them.
 *
 * Order of authority: the Watch's own measured steps first, the plan's steps
 * replayed onto the speed track second, the Watch's lap/segment events third,
 * nothing fourth. Returning `[]` plus a `note` is the fourth case — the detail
 * page must say why there are no segments rather than quietly falling back to
 * kilometres.
 *
 * **Why the measurement leads.** The panel is 课表分段, and a measured boundary
 * beats a replayed one whenever both exist. 2026-09-14 is the proof: the Watch's
 * recorded steps end at 300.000 s / 1 283.456 s / 1 583.075 s against a
 * prescription of warmup 300 s + work 2 600 m + cooldown 300 s, while the replay
 * puts those ends at 300 s / 1 281 s / 1 581 s — right to within 2.5 s, but
 * derived from the plan instead of from what the Watch saw, and only as good as
 * whichever revision of the plan happens to be on file. The measurement also
 * removes that dependency from this panel entirely.
 *
 * **Why the events are last.** `HKWorkoutEventTypeSegment` looks like the more
 * authoritative record — a measurement instead of a replay — and this code used
 * to rank it first. Real exports do not support that reading: the events for
 * 2026-09-14 are *two overlapping partitions of the whole workout*, seven of
 * ≈1 km and four of ≈1.6 km, which is what the Watch's own lap settings produce,
 * not what a prescription asks for. The prescription's boundaries (300 s and
 * ≈1 281 s) appear nowhere in that event set. Ranking the events first therefore
 * turned a four-step session into ten rows, and re-labelled the kilometre splits
 * — already rendered under this panel — as 课表 step names. They remain the
 * fallback for runs no stored plan explains, where a rough segmentation beats
 * none.
 */
export const resolveSegmentation = (input: {
  startedAtMs: number;
  endedAtMs: number;
  events: StoredWorkoutEventInterval[];
  /** Omit when the run carries no measured step layer (see {@link measuredStepsOf}). */
  steps?: MeasuredStep[];
  plan: MatchedPlanDay | null;
  track: SegmentTrack;
}): Segmentation => {
  const { startedAtMs, endedAtMs, events, plan, track } = input;
  const steps = input.steps ?? [];
  const layout = plan ? layoutStructure(plan.structure, track, startedAtMs, endedAtMs) : null;
  const eventBoundaries = eventBoundariesOf(events, startedAtMs, endedAtMs);
  /** What the Watch's events *would* have drawn, had they been used. */
  const eventSegments = eventBoundaries.length >= 3 ? eventBoundaries.length - 1 : 0;

  if (steps.length >= 2) {
    const planned = plan ? flattenStructure(plan.structure) : [];
    // The first measured step starts where the run starts; anchoring on
    // `startedAtMs` keeps the head of the run inside step one even if the entry's
    // own origin drifts by a fraction.
    const boundaries = [startedAtMs, ...steps.slice(1).map((step) => step.startMs)];
    const descriptors: SegmentDescriptor[] = steps.map((_step, index) => {
      const plannedStep = planned[index];
      // More measured steps than the plan has: the extra ones are real rows the
      // plan cannot name. Say "第 N 步" rather than borrow a label.
      if (plannedStep === undefined) {
        return { label: `第 ${index + 1} 步`, purpose: "unplanned" as const, goal: null, alert: null };
      }
      return {
        label: plannedStep.label,
        purpose: plannedStep.step.purpose,
        goal: plannedStep.step.goal,
        alert: plannedStep.step.alert
      };
    });
    const lastStep = steps[steps.length - 1]!;
    // "结束后又跑了一段" is a real segment, not noise: emit it explicitly.
    if (endedAtMs - lastStep.endMs >= MIN_SEGMENT_MS) {
      boundaries.push(lastStep.endMs);
      descriptors.push({ label: UNPLANNED_LABEL, purpose: "unplanned", goal: null, alert: null });
    }
    boundaries.push(endedAtMs);
    const explained = Math.min(1, (lastStep.endMs - startedAtMs) / (endedAtMs - startedAtMs));
    return {
      boundaries,
      descriptors,
      plan: plan
        ? planMatch(
            plan,
            explained,
            steps.length < planned.length ? "手表记录的步骤少于课表步骤" : "按手表记录的步骤实测"
          )
        : null,
      note: measuredNote(steps.length, plan, planned.length, eventSegments)
    };
  }

  if (layout && layout.steps.length >= 2) {
    const boundaries = layout.steps.map((step) => step.startMs);
    const descriptors: SegmentDescriptor[] = layout.steps.map((step) => ({
      label: step.label,
      purpose: step.purpose,
      goal: step.goal,
      alert: step.alert
    }));
    const lastStep = layout.steps[layout.steps.length - 1]!;
    // "结束后又跑了一段" is a real segment, not noise: emit it explicitly.
    if (endedAtMs - lastStep.endMs >= MIN_SEGMENT_MS) {
      boundaries.push(lastStep.endMs);
      descriptors.push({ label: UNPLANNED_LABEL, purpose: "unplanned", goal: null, alert: null });
    }
    boundaries.push(endedAtMs);
    const explained = Math.min(1, (lastStep.endMs - startedAtMs) / (endedAtMs - startedAtMs));
    return {
      boundaries,
      descriptors,
      plan: planMatch(
        plan!,
        explained,
        layout.truncated ? "课表未跑完，按实测配速回放剩余步骤" : "按课表结构回放"
      ),
      note: `分段由课表结构（${plan!.localDate} 第 ${plan!.revision} 版）回放到实测配速得到${eventFootnote(eventSegments)}`
    };
  }

  if (eventBoundaries.length >= 3) {
    return {
      boundaries: eventBoundaries,
      descriptors: eventBoundaries.slice(0, -1).map((_startMs, index) => ({
        label: `第 ${index + 1} 段`,
        purpose: "unplanned" as const,
        goal: null,
        alert: null
      })),
      plan: null,
      note: `分段取自手表记录的 lap/segment 事件（${eventBoundaries.length - 1} 段），${
        plan ? "课表步骤不足两段" : "未匹配到课表"
      }`
    };
  }

  return { boundaries: [], descriptors: [], plan: null, note: null };
};

/** Merge measured numbers with the descriptors that describe them. */
export const toWorkoutSegments = (
  measured: StoredMeasuredSegment[],
  descriptors: SegmentDescriptor[],
  startedAtMs: number
): WorkoutSegment[] =>
  measured.slice(0, descriptors.length).map((segment, index) => {
    const descriptor = descriptors[index]!;
    const goal = descriptor.goal;
    const alert = descriptor.alert;
    return {
      index: index + 1,
      label: descriptor.label,
      purpose: descriptor.purpose,
      goalType: goal?.type ?? null,
      goalMeters: goal?.type === "distance" ? goal.meters : null,
      goalSeconds: goal?.type === "time" ? goal.seconds : null,
      alertKind: alert?.kind ?? null,
      alertLower: alert?.lower ?? null,
      alertUpper: alert?.upper ?? null,
      startOffsetSeconds: Math.max(0, (segment.startMs - startedAtMs) / 1000),
      durationSeconds: segment.durationSeconds,
      distanceMeters: segment.distanceMeters,
      averagePaceSecondsPerKm: segment.averagePaceSecondsPerKm,
      averageHeartRateBpm: segment.averageHeartRateBpm,
      averageCadenceSpm: segment.averageCadenceSpm
    };
  });
