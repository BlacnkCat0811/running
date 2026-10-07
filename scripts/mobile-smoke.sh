#!/usr/bin/env bash
# RAI mobile endpoints smoke test against the real local database.
set -u
PORT=8791
BASE="http://127.0.0.1:${PORT}"
ORIGIN="http://127.0.0.1:5173"
BEFORE_GOAL=""

echo "== boot API (RAI_DATABASE=var/rai.sqlite) =="
# Windows Node cannot resolve MSYS paths like /d/applerun; pwd -W yields D:/applerun
SMOKE_ROOT="$(pwd -W 2>/dev/null || pwd)"
RAI_DATABASE="${SMOKE_ROOT}/var/rai.sqlite" RAI_API_PORT=$PORT RAI_LOG_LEVEL=warn \
  node --import tsx apps/api/src/server.ts > var/smoke-api.log 2>&1 &
API_PID=$!

cleanup() {
  if [ -n "$BEFORE_GOAL" ]; then
    curl -s -m 2 -X PUT "$BASE/v1/mobile/goals" \
      -H "content-type: application/json" -H "Origin: $ORIGIN" \
      -d "$BEFORE_GOAL" >/dev/null || true
  fi
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

echo "== GET/PUT /v1/mobile/goals =="
curl -s "$BASE/v1/mobile/goals" -o var/smoke-goals-before.json
echo "before: $(cat var/smoke-goals-before.json)"
HTTP=$(curl -s -o var/smoke-goals-put.json -w "%{http_code}" -X PUT "$BASE/v1/mobile/goals" \
  -H "content-type: application/json" -H "Origin: $ORIGIN" \
  -d '{"easyDurationFloorFraction": 0.75}')
echo "PUT http=$HTTP body=$(cat var/smoke-goals-put.json)"
[ "$HTTP" = "200" ] && { echo "PASS: PUT returns 200"; pass=$((pass+1)); } || { echo "FAIL: PUT expected 200 got $HTTP"; fail=$((fail+1)); }
curl -s "$BASE/v1/mobile/goals" -o var/smoke-goals-after.json
node -e "const a=require('./var/smoke-goals-after.json'); console.log('after:', JSON.stringify(a)); process.exit(a.easyDurationFloorFraction === 0.75 ? 0 : 1)" && { echo "PASS: goals round-trip"; pass=$((pass+1)); } || { echo "FAIL: goals round-trip"; fail=$((fail+1)); }

echo "== validation: PUT rejects out-of-range =="
HTTP2=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/v1/mobile/goals" \
  -H "content-type: application/json" -H "Origin: $ORIGIN" -d '{"easyDurationFloorFraction": 9}')
[ "$HTTP2" = "400" ] && { echo "PASS: floor 9 rejected with 400"; pass=$((pass+1)); } || { echo "FAIL: expected 400 got $HTTP2"; fail=$((fail+1)); }

echo ""
echo "== RESULT: pass=$pass fail=$fail =="
[ "$fail" = "0" ]
