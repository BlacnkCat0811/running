#!/usr/bin/env python3
"""B07 visual acceptance fixture: one synthetic run for one real course.

Only used by run-visual-tests.sh with an isolated runtime. It never touches the
user's var/rai.sqlite. The course is published first, then its availability is
aged so the frozen-prescription rule ("published before the run") is real; the
run itself is inserted into the isolated main database at 06:00 Shanghai time.
"""
import json
import os
import sqlite3
import urllib.request
import uuid

base = "http://127.0.0.1:8792"
token = os.environ["RAI_VISUAL_API_TOKEN"]
headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json",
           "X-RAI-Training-Contract": "2", "X-RAI-Training-Sessions": "1",
           "X-RAI-Client-Training-Session-Commands": "1"}


def call(path, value=None):
    request = urllib.request.Request(base + path, data=None if value is None else json.dumps(value).encode(),
                                     headers=headers)
    return json.load(urllib.request.urlopen(request))


state = call("/v1/mobile/training-plan-state")
today = state["businessDate"]
scope = state["scope"]
scope_key = json.dumps([scope["serverId"], scope["athleteId"], scope["datasetEpoch"]], separators=(",", ":"))
sessions = state["sessions"]["sessions"]
course = next((item for item in sessions
               if item["prescription"]["localDate"] == today and item["lifecycle"] == "pending"), None)
if course is None:
    prescription = {"localDate": today, "kind": "easy", "distanceKm": 2, "reason": "B07 synthetic execution",
                    "structure": {"warmup": None, "cooldown": None, "blocks": [{"iterations": 1,
                      "steps": [{"purpose": "work", "goal": {"type": "distance", "meters": 2000}, "alert": None}]}]}}
    draft = {"contractVersion": 1, "operationScope": scope, "expectedStateRevision": state["stateRevision"],
             "planInstanceId": state["sessions"]["planInstanceId"],
             "draft": {"action": "add", "prescription": prescription}}
    preview = call("/v1/mobile/training-plan/session-commands/preview", draft)
    saved = call("/v1/mobile/training-plan/session-commands", {**draft, "operationId": str(uuid.uuid4()),
                                                               "candidateId": preview["candidateId"]})
    course = saved["session"]
    state = call("/v1/mobile/training-plan-state")

session_id = course["sessionId"]
revision = course["sessionRevision"]
aged = "2026-10-24T03:00:00.000Z"
control = sqlite3.connect(os.path.join(os.environ["RAI_RUNTIME_ROOT"], "var", "rai-control.sqlite"), timeout=10)
try:
    payload = json.loads(control.execute("SELECT payload_json FROM mobile_training_state WHERE scope=?",
                                         (scope_key,)).fetchone()[0])
    for item in payload["sessions"]:
        if item["sessionId"] == session_id:
            item["availableAt"] = aged
    control.execute("UPDATE mobile_training_state SET payload_json=? WHERE scope=?",
                    (json.dumps(payload, separators=(",", ":")), scope_key))
    history = json.loads(control.execute(
        "SELECT payload_json FROM mobile_training_session_history WHERE scope=? AND session_id=? AND session_revision=?",
        (scope_key, session_id, revision)).fetchone()[0])
    history["availableAt"] = aged
    control.execute("""UPDATE mobile_training_session_history SET payload_json=?, available_at=?
                       WHERE scope=? AND session_id=? AND session_revision=?""",
                    (json.dumps(history, separators=(",", ":")), aged, scope_key, session_id, revision))
    control.commit()
finally:
    control.close()

run_start, run_end = today + "T06:00:00+08:00", today + "T06:25:00+08:00"
main = sqlite3.connect(os.path.join(os.environ["RAI_RUNTIME_ROOT"], "var", "rai.sqlite"), timeout=10)
try:
    main.execute("""INSERT OR REPLACE INTO workouts
        (id,activity_type,source_name,source_category,start_at,end_at,duration_seconds,
         metadata_json,raw_attributes_json,is_canonical)
        VALUES (?,?,?,?,?,?,?,?,?,1)""",
                 ("visual-execution-workout", "HKWorkoutActivityTypeRunning", "Synthetic Watch", "watchOS",
                  run_start, run_end, 1500, "{}", "{}"))
    main.execute("""INSERT OR REPLACE INTO training_sessions
        (id,activity_type,anchor_start_at,anchor_end_at,anchor_distance_km,canonical_workout_id,status)
        VALUES (?,?,?,?,?,?,'active')""",
                 ("visual-execution-run", "HKWorkoutActivityTypeRunning", run_start, run_end, 2.1,
                  "visual-execution-workout"))
    main.commit()
finally:
    main.close()
print("B07 execution fixture ready:", session_id, "run visual-execution-run", today)
