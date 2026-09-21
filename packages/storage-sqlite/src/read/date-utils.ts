import { localCalendarFormatter, type TrainingStatisticsGranularity } from "@rai/contracts";

export function periodStart(date: string, granularity: TrainingStatisticsGranularity): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (granularity === "week") parsed.setUTCDate(parsed.getUTCDate() - ((parsed.getUTCDay() + 6) % 7));
  if (granularity === "month") parsed.setUTCDate(1);
  if (granularity === "year") {
    parsed.setUTCMonth(0);
    parsed.setUTCDate(1);
  }
  return parsed.toISOString().slice(0, 10);
}

export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function nextPeriod(start: string, granularity: TrainingStatisticsGranularity): string {
  const value = new Date(`${start}T00:00:00Z`);
  if (granularity === "week") value.setUTCDate(value.getUTCDate() + 7);
  if (granularity === "month") value.setUTCMonth(value.getUTCMonth() + 1);
  if (granularity === "year") value.setUTCFullYear(value.getUTCFullYear() + 1);
  return value.toISOString().slice(0, 10);
}

export function previousPeriod(start: string, granularity: TrainingStatisticsGranularity): string {
  const value = new Date(`${start}T00:00:00Z`);
  if (granularity === "week") value.setUTCDate(value.getUTCDate() - 7);
  if (granularity === "month") value.setUTCMonth(value.getUTCMonth() - 1);
  if (granularity === "year") value.setUTCFullYear(value.getUTCFullYear() - 1);
  return value.toISOString().slice(0, 10);
}

export function localDateInTimezone(timeZone = "Asia/Shanghai"): string {
  return localCalendarFormatter(timeZone, "day").format(new Date());
}
