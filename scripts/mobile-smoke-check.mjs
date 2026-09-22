import { readFileSync } from "node:fs";
const checks = Object.freeze({
  "today-distance": (d) => d.today.distanceKm >= 0,
  "week-daily": (d) => d.weekDaily.length === 7,
  "recent-workouts": (d) => d.recentWorkouts.length <= 5,
  "verdict": (d) => ['green','yellow','red'].includes(d.verdict.tone),
  "session-title": (d) => typeof d.nextSession.title === 'string' && d.nextSession.title.length > 0,
  "week-plan": (d) => Array.isArray(d.weekPlan) && d.weekPlan.length === 7,
  "phase": (d) => ['need_sync','morning_open','locked','post_run','rest_done'].includes(d.phase),
  "months-count": (d) => d.months.length <= 3,
  "months-order": (d) => d.months.length < 2 || d.months[0].month < d.months[d.months.length - 1].month,
  "total-distance": (d) => d.totals.distanceKm >= 0,
  "weeks": (d) => d.weeks.length === 12 && d.weeks.every((w,i)=> i===0 || (Date.parse(w.periodStart)-Date.parse(d.weeks[i-1].periodStart)===7*864e5)),
  "records": (d) => typeof d.records === 'object' && d.records !== null,
  "ability": (d) => Array.isArray(d.ability),
});
try {
  const [file, name] = process.argv.slice(2);
  if (!Object.hasOwn(checks, name)) throw new Error("Unknown smoke predicate");
  process.exitCode = checks[name](JSON.parse(readFileSync(file, "utf8"))) ? 0 : 1;
} catch {
  process.exitCode = 1;
}
