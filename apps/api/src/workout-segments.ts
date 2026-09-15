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

/**
 * Segment assembly for one run.
 *
 * The detail page used to show kilometre splits and nothing else, because the
 * only segmentation the pipeline could express was `nextBoundary = 1000`. Two
 * producers can describe what was actually run:
 *
 * 1. the Watch's own `HKWorkoutEvent` lap/segment boundaries — the same record
 *    the Fitness app renders as 间歇;
 * 2. the stored weekly plan, replayed onto the measured speed track.
 *
 * A is authoritative when present (it is a measurement, not a replay); B is the
 * fallback that covers the "sync tomorrow's plan, run it today" habit, where the
 * run's date cannot match the plan's date. When neither is available the caller
 * keeps the kilometre splits and says why.
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

/** The plan step covering the most of `[startMs, endMs)`, if any step covers half of it. */
const dominantStep = (
  steps: PlannedStepLayout[],
  startMs: number,
  endMs: number
): PlannedStepLayout | null => {
  const duration = endMs - startMs;
  if (duration <= 0) return null;
  let best: PlannedStepLayout | null = null;
  let bestOverlap = 0;
  for (const step of steps) {
    const overlap = Math.min(endMs, step.endMs) - Math.max(startMs, step.startMs);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = step;
    }
  }
  return best && bestOverlap / duration >= 0.5 ? best : null;
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
 * Decide the segment boundaries for one run and describe each of them.
 *
 * Order of authority: Watch events first, plan replay second, nothing third.
 * Returning `[]` plus a `note` is the third case — the detail page must say
 * why there are no segments rather than quietly falling back to kilometres.
 */
export const resolveSegmentation = (input: {
  startedAtMs: number;
  endedAtMs: number;
  events: StoredWorkoutEventInterval[];
  plan: MatchedPlanDay | null;
  track: SegmentTrack;
}): Segmentation => {
  const { startedAtMs, endedAtMs, events, plan, track } = input;
  const layout = plan ? layoutStructure(plan.structure, track, startedAtMs, endedAtMs) : null;

  const eventBoundaries = eventBoundariesOf(events, startedAtMs, endedAtMs);
  if (eventBoundaries.length >= 3 && layout) {
    let assigned = 0;
    const descriptors: SegmentDescriptor[] = [];
    for (let index = 0; index < eventBoundaries.length - 1; index += 1) {
      const startMs = eventBoundaries[index]!;
      const endMs = eventBoundaries[index + 1]!;
      const step = dominantStep(layout.steps, startMs, endMs);
      if (step) assigned += endMs - startMs;
      descriptors.push({
        label: step?.label ?? UNPLANNED_LABEL,
        purpose: step?.purpose ?? "unplanned",
        goal: step?.goal ?? null,
        alert: step?.alert ?? null
      });
    }
    const explained = (endedAtMs - startedAtMs) > 0 ? assigned / (endedAtMs - startedAtMs) : 0;
    return {
      boundaries: eventBoundaries,
      descriptors,
      plan: planMatch(plan!, explained, "手表 lap/segment 事件与课表步骤匹配"),
      note: `分段取自手表记录的 lap/segment 事件（${eventBoundaries.length - 1} 段）`
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
      note: `分段取自手表记录的 lap/segment 事件（${eventBoundaries.length - 1} 段），未匹配到课表`
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
      note: `分段由课表结构（${plan!.localDate} 第 ${plan!.revision} 版）回放到实测配速得到`
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
