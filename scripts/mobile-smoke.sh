#!/usr/bin/env bash
# RAI mobile endpoints smoke test against the real local database.
set -u
PORT=8791
BASE="http://127.0.0.1:${PORT}"

echo "== boot API (RAI_DATABASE=var/rai.sqlite) =="
# Windows Node cannot resolve MSYS paths like /d/applerun; pwd -W yields D:/applerun
SMOKE_ROOT="$(pwd -W 2>/dev/null || pwd)"
RAI_DATABASE="${SMOKE_ROOT}/var/rai.sqlite" RAI_API_PORT=$PORT RAI_LOG_LEVEL=warn \
  node --import tsx apps/api/src/server.ts > var/smoke-api.log 2>&1 &
API_PID=$!

cleanup() {
  kill $API_PID 2>/dev/null
  wait $API_PID 2>/dev/null
}
trap cleanup EXIT

# Wait for readiness (up to 45s, DB is 1.9GB)
ready=""
for i in $(seq 1 90); do
  if curl -s -m 2 "$BASE/v1/health" > var/smoke-health.json 2>/dev/null; then
    if grep -q '"databaseReady":true' var/smoke-health.json; then ready=1; break; fi
  fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "FAIL: API did not become ready"; tail -20 var/smoke-api.log; exit 1
fi
echo "health: $(cat var/smoke-health.json)"

pass=0; fail=0
check() { # name JSON_file predicate_name
  local name="$1" file="$2"
  if node scripts/mobile-smoke-check.mjs "$file" "$3" 2>/dev/null; then
    echo "PASS: $name"; pass=$((pass+1))
  else
    echo "FAIL: $name"; fail=$((fail+1))
  fi
}

echo "== GET /v1/mobile/today =="
curl -s "$BASE/v1/mobile/today" -o var/smoke-today.json
node -e "const d=require('./var/smoke-today.json'); console.log('today:', JSON.stringify({date:d.today.localDate, km:d.today.distanceKm, pace:d.today.paceSecondsPerKm, kcal:d.today.energyKcal, count:d.today.workoutCount})); console.log('week:', JSON.stringify({km:d.week.distanceKm, count:d.week.workoutCount, duration:d.week.durationSeconds})); console.log('weekDaily days:', d.weekDaily.length, 'recent:', d.recentWorkouts.length)"
check "today.distanceKm is number" var/smoke-today.json "today-distance"
check "today.weekDaily length 7" var/smoke-today.json "week-daily"
check "today.recentWorkouts <= 5" var/smoke-today.json "recent-workouts"
check "today.verdict tone" var/smoke-today.json "verdict"
check "today.nextSession title" var/smoke-today.json "session-title"
check "today.weekPlan length 7" var/smoke-today.json "week-plan"
check "today.phase" var/smoke-today.json "phase"

echo "== GET /v1/mobile/statistics =="
curl -s "$BASE/v1/mobile/statistics" -o var/smoke-stats.json
node -e "const d=require('./var/smoke-stats.json'); console.log('months:', d.months.map(m=>m.month+':'+m.totalDistanceKm.toFixed(1)+'km('+(m.runningDistanceKm|0)+'r/'+(m.cyclingDistanceKm|0)+'c)').join(' | ')); console.log('totals:', JSON.stringify({km:d.totals.distanceKm.toFixed(1), pace:d.totals.averagePaceSecondsPerKm, delta:d.totals.distanceChangeFraction})); console.log('hrZones:', d.heartRateZones.map(z=>z.zone+':'+(z.fraction*100).toFixed(0)+'%').join(' | '))"
check "statistics.months <= 3" var/smoke-stats.json "months-count"
check "statistics.months oldest first" var/smoke-stats.json "months-order"
check "statistics.totals.distanceKm >= 0" var/smoke-stats.json "total-distance"

echo "== GET /v1/mobile/trends =="
curl -s "$BASE/v1/mobile/trends" -o var/smoke-trends.json
node -e "const d=require('./var/smoke-trends.json'); console.log('weeks:', d.weeks.length, 'last4:', d.weeks.slice(-4).map(w=>w.distanceKm.toFixed(1)).join('/')); console.log('ramp4w:', d.distanceChangeFraction4Weeks); console.log('records:', JSON.stringify({f5:d.records.fastest5k, longest:d.records.longestDistance && d.records.longestDistance.distanceKm, month:d.records.biggestMonth})); console.log('insights:', d.insights.map(i=>i.kind+':'+i.title).join(' | '))"
check "trends.weeks is 12 consecutive ISO weeks" var/smoke-trends.json "weeks"
check "trends.records object" var/smoke-trends.json "records"
check "trends.ability series" var/smoke-trends.json "ability"

echo "== retired legacy plan routes answer 410 =="
# Product decision 2026-10-20: the four old plan surfaces stay mounted but answer
# 410 legacy_surface_retired. The smoke check asserts the metadata, not a 404.
smoke_retired() { # name HTTP_STATUS FILE REPLACEMENT_PREFIX
  local name="$1" http="$2" file="$3" prefix="$4"
  if [ "$http" = "410" ] && node -e "
    const d=require('./' + process.argv[1]);
    process.exit(d.code === 'legacy_surface_retired' && typeof d.replacement === 'string' &&
      d.replacement.startsWith(process.argv[2]) && d.message.includes(d.replacement) ? 0 : 1);
  " "$file" "$prefix"; then
    echo "PASS: $name -> 410 legacy_surface_retired"; pass=$((pass+1))
  else
    echo "FAIL: $name expected 410 legacy_surface_retired with replacement"; fail=$((fail+1))
  fi
}

curl -s "$BASE/v1/mobile/goals" -o var/smoke-goals-get.json
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/mobile/goals")
smoke_retired "GET /v1/mobile/goals" "$HTTP" var/smoke-goals-get.json "/v1/mobile/training-plan"

HTTP=$(curl -s -o var/smoke-goals-put.json -w "%{http_code}" -X PUT "$BASE/v1/mobile/goals" \
  -H "content-type: application/json" -d '{"easyDurationFloorFraction": 0.75}')
smoke_retired "PUT /v1/mobile/goals" "$HTTP" var/smoke-goals-put.json "/v1/mobile/training-plan"

HTTP=$(curl -s -o var/smoke-preview.json -w "%{http_code}" -X POST "$BASE/v1/mobile/workout-plan/preview" \
  -H "content-type: application/json" -d '{"expectedRevision": 0}')
smoke_retired "POST /v1/mobile/workout-plan/preview" "$HTTP" var/smoke-preview.json "/v1/mobile/training-plan/commands/preview"

HTTP=$(curl -s -o var/smoke-generate.json -w "%{http_code}" -X POST "$BASE/v1/mobile/workout-plan/generate" \
  -H "content-type: application/json" -d '{}')
smoke_retired "POST /v1/mobile/workout-plan/generate" "$HTTP" var/smoke-generate.json "/v1/mobile/training-plan/commands/refresh"

echo ""
echo "== RESULT: pass=$pass fail=$fail =="
[ "$fail" = "0" ]
