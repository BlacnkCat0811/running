import type { DatabaseSync } from "node:sqlite";

import { personalCalibrationReadiness, type PersonalCalibrationSample } from "@rai/model-eval";

import { loadLabeledRaceOutcomes } from "./prediction-data.js";
import { buildFormulaPredictionBase } from "./prediction-report.js";

/**
 * Leave-one-out personal calibration samples (docs/ALGORITHM.md §12.11).
 *
 * For every confirmed label this asks the question the residual is supposed to
 * answer: *"what would the rule have predicted for this race, using only what was
 * known at the time, with this one result held out?"*
 *
 * Two properties make that true rather than approximate:
 *
 * 1. The prediction is built by `buildFormulaPredictionBase` — the same function the
 *    production report calls — with `excludeLabelIds` carrying the held-out label.
 *    There is no second copy of the evidence chain that could disagree with it.
 * 2. Everything else known at `asOf` is used, and **only** the held-out label is
 *    withheld. That is not the same question as T01's as-known-then replay, and the
 *    difference is deliberate: a manually entered result (`§12.10`) did not exist at
 *    the time of the race, so "the prediction made back then" is not computable for
 *    exactly the runner this tier is for. What *is* computable — and what the band
 *    needs — is "how far off is the rule about me when this one result is not part of
 *    what it knows". Historical replay remains the machinery for *evaluation*; this
 *    pass exists to calibrate a band, and it never lets a label inform its own
 *    residual.
 *
 * Labels the rule cannot score are dropped, not guessed: a race with no usable
 * evidence behind it has no held-out prediction, and inventing a point estimate for
 * it would put a fabricated residual into the runner's band.
 */

export interface PersonalCalibrationPass {
  samples: PersonalCalibrationSample[];
  /** Labels examined, whether or not they produced a residual. */
  labelCount: number;
  /** Labels whose held-out prediction existed. */
  scoredCount: number;
  reasonCodes: string[];
}

export function buildPersonalCalibrationSamples(
  database: DatabaseSync,
  asOf: string
): PersonalCalibrationPass {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error("asOf must be a valid instant");
  const labels = loadLabeledRaceOutcomes(database, asOf);
  if (labels.length === 0) {
    return { samples: [], labelCount: 0, scoredCount: 0, reasonCodes: ["no_labels"] };
  }

  const samples: PersonalCalibrationSample[] = [];
  const reasonCodes = new Set<string>();
  for (const label of labels) {
    let pointSeconds: number | null = null;
    try {
      const base = buildFormulaPredictionBase(database, asOf, {
        mode: "neutral_potential",
        excludeLabelIds: [label.id, ...(label.trainingSessionIds ?? [])]
      });
      const race = base.snapshot.races.find((item) => item.distance === label.distance) ?? null;
      const value = race?.predictedSeconds ?? null;
      pointSeconds = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      // A label older than the evidence window can fail to produce a base at all.
      // That is a missing prediction, not a bad label: count it, score nothing.
      pointSeconds = null;
    }
    if (pointSeconds === null) {
      reasonCodes.add("label_without_held_out_prediction");
      continue;
    }
    samples.push({
      distance: label.distance,
      observedAt: label.completedAt,
      pointSeconds,
      actualSeconds: label.actualSeconds
    });
  }
  if (samples.length < labels.length) reasonCodes.add("some_labels_unscored");
  return { samples, labelCount: labels.length, scoredCount: samples.length, reasonCodes: [...reasonCodes] };
}

/** Readiness of the personal tier, computed from the same pass the band would use. */
export function personalCalibrationStatus(database: DatabaseSync, asOf: string): ReturnType<typeof personalCalibrationReadiness> & { labelCount: number; scoredCount: number } {
  const pass = buildPersonalCalibrationSamples(database, asOf);
  const readiness = personalCalibrationReadiness(pass.samples);
  return { ...readiness, labelCount: pass.labelCount, scoredCount: pass.scoredCount };
}
