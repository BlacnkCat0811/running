import { ISO_UTC_OFFSET } from "@rai/contracts";
import { ClientRequestError } from "./api-error.js";

export const isValidWorkoutDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

/** Shared date arithmetic only. Callers own their range limits and error semantics. */
export function workoutDateWindow(from: string, through: string): { startedFrom: string; startedBefore: string } {
  if (!isValidWorkoutDate(from) || !isValidWorkoutDate(through) || from > through) {
    throw new ClientRequestError("invalid_workout_date", "请选择有效的训练日期", 400);
  }
  return {
    startedFrom: `${from}T00:00:00${ISO_UTC_OFFSET}`,
    startedBefore: new Date(Date.parse(`${through}T00:00:00${ISO_UTC_OFFSET}`) + 86_400_000).toISOString()
  };
}
