import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { WorkoutListResponse } from "@rai/api-contracts";
import { csvCell, exportWindow, workoutSummaryExport } from "../src/workout-summary-export.js";

test("export dates are real, inclusive Shanghai days, capped at 366", () => {
  assert.deepEqual(exportWindow("2026-09-28", "2026-09-28"), {
    startedFrom: "2026-09-28T00:00:00+08:00", startedBefore: "2026-09-28T16:00:00.000Z"
  });
  for (const [from, to] of [["2026-02-29", "2026-03-01"], ["2026-10-01", "2026-09-28"], ["2025-01-01", "2026-01-02"], ["", "2026-09-28"]]) {
    assert.throws(() => exportWindow(from!, to!), /有效日期/);
  }
});
test("CSV neutralizes formulas and escapes quoted multiline values", () => {
  for (const text of ["=1+1", " +cmd", "@SUM(A1)", "-1+2", "\t=1", "\n=1"]) assert.ok(csvCell(text).startsWith('"\''));
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(csvCell(null), '""');
});
test("export is an explicit allowlist, bounded and never includes notes, HR or route", () => {
  const read = (query: unknown) => {
    assert.equal((query as { limit: number }).limit, 2001);
    return { items: [{ startedAt: "2026-09-28T01:00:00Z", sessionType: "easy", distanceKm: 5,
      durationSeconds: 1500, averagePaceSecondsPerKm: 300, note: "PRIVATE", averageHeartRateBpm: 150,
      route: [{ latitude: 31, longitude: 121 }], id: "PRIVATE" }], total: 1, limit: 2001, offset: 0 } as unknown as WorkoutListResponse;
  };
  const result = workoutSummaryExport("2026-09-28", "2026-09-28", read);
  assert.equal(result.count, 1);
  assert.equal(result.csv.split("\r\n")[1], '"2026-09-28T01:00:00Z","easy","5","1500","300"');
  assert.ok(!result.csv.includes("PRIVATE") && !result.csv.includes("latitude"));
  assert.throws(() => workoutSummaryExport("2026-09-28", "2026-09-28", () => ({ ...read({ limit: 2001 }), total: 2001 })), /缩小日期/);
});
test("export route is never in the anonymous read list and explicitly requires a configured token", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const publicRoutes = server.slice(server.indexOf("const publicReadRoutes"), server.indexOf("const tokenRequiredReadRoutes"));
  assert.ok(!publicRoutes.includes("/v1/exports/"));
  // The route is classified as token-required, and the token gate itself lives in
  // `local-request-security.ts` (it moved out of `server.ts`; this assertion used
  // to pin the old inline string and had been red since that refactor).
  const tokenRequiredStart = server.indexOf("const tokenRequiredReadRoutes");
  const tokenRequiredRoutes = server.slice(tokenRequiredStart, server.indexOf("]);", tokenRequiredStart));
  assert.ok(tokenRequiredRoutes.includes('"/v1/exports/workout-summary"'),
    "the export route must be explicitly classified as token-required");
  const security = readFileSync(new URL("../src/local-request-security.ts", import.meta.url), "utf8");
  assert.ok(security.includes("constantTimeTokenEquals(authorization, `Bearer ${options.apiToken}`)"),
    "the token gate must compare a bearer token in constant time");
});
