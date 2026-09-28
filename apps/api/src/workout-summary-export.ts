import type { WorkoutListResponse, WorkoutSummaryExportResponse } from "@rai/api-contracts";
import { DATABASE_TIMEZONE } from "@rai/contracts";
import { isValidWorkoutDate, workoutDateWindow } from "./workout-date-window.js";
import { ClientRequestError } from "./api-error.js";

export const workoutExportQuerySchema = {
  type: "object", additionalProperties: false, required: ["from", "through"],
  properties: {
    from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    through: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
  }
} as const;

export function exportWindow(from: string, through: string): { startedFrom: string; startedBefore: string } {
  const days = (Date.parse(through) - Date.parse(from)) / 86_400_000;
  if (!isValidWorkoutDate(from) || !isValidWorkoutDate(through) || days < 0 || days >= 366) {
    throw new ClientRequestError("invalid_export_range", "请选择有效日期，单次最多导出 366 天", 400);
  }
  return workoutDateWindow(from, through);
}

export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Quotes alone do not prevent spreadsheet formula execution.
  if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function workoutSummaryExport(from: string, through: string,
  read: (query: { limit: number; offset: number; startedFrom: string; startedBefore: string }) => WorkoutListResponse
): WorkoutSummaryExportResponse {
  const window = exportWindow(from, through);
  const result = read({ ...window, limit: 2001, offset: 0 });
  if (result.total > 2000) throw new ClientRequestError("export_too_large", "记录超过 2000 条，请缩小日期范围", 400);
  const rows: unknown[][] = [["训练开始时间", "训练类型", "距离(km)", "时长(s)", "平均配速(s/km)"]];
  for (const item of result.items) rows.push([item.startedAt, item.sessionType, item.distanceKm, item.durationSeconds, item.averagePaceSecondsPerKm]);
  return { from, through, timezone: DATABASE_TIMEZONE, count: result.items.length,
    csv: "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n" };
}
