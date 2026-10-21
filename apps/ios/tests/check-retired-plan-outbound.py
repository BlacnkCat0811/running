"""Retired plan-surface outbound gate (PR-02, 2026-10-21).

What this gate proves
---------------------
1. The five server paths retired by the 2026-10-20 product decision are still
   declared as retired and answer with the stable `legacy_surface_retired` code.
2. The iOS production tree only spells the retired **request** paths inside
   `APIClient.swift` (the compatibility transport), never in views or models.
   Comments are stripped first: historical diagnostics may name the old paths.
3. The unified training page no longer links to the legacy manual-plan editor;
   it shows the explicit "not adapted yet" explanation instead.
4. `NativeAppModel` refuses the retired write routes before encoding/persisting
   a publication when the server advertises the unified read capability but not
   the write command capability.
5. `PlanMutationDisposition` treats `legacy_surface_retired` and any HTTP 410 as
   terminal, so a stale pending publication cannot be retried forever.
6. This gate is not an orphan: the aggregate iOS runner executes it.

What it does NOT prove
----------------------
This is a source-shape gate. It does not prove that a Swift call graph is
unreachable at runtime, nor does it replace `ModelRegression`'s fake-transport
behavioural tests. The route table and the real server are pinned by
`apps/api/test/legacy-surface-retirement.test.ts`.

Exit code: 0 when every check passes, 1 with one line per failure.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:  # Windows consoles default to cp936; failure reasons must stay readable.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):  # pragma: no cover - non-standard stream
    pass

ROOT = Path(__file__).resolve().parents[3]
IOS_ROOT = ROOT / "apps" / "ios" / "RAI"
SERVER = "apps/api/src/server.ts"
SCHEMAS = "apps/api/src/schemas.ts"
CONTRACT = "packages/api-contracts/src/retired-surfaces.ts"
API_CLIENT = "apps/ios/RAI/APIClient.swift"
MODEL = "apps/ios/RAI/NativeAppModel.swift"
DISPOSITION = "apps/ios/RAI/PlanMutationDisposition.swift"
PLAN_VIEW = "apps/ios/RAI/Skins/Technology/TechPlanView.swift"
LEGACY_PLAN_VIEW = "apps/ios/RAI/Skins/Technology/TechRunCoachView.swift"
AGGREGATOR = "apps/ios/tests/run-model-tests.sh"
SELF_REFERENCE = "apps/ios/tests/check-retired-plan-outbound.py"

# Canonical contract expectation: five paths / seven method+path operations
# retired on 2026-10-20. Method is part of the identity:
# `/v1/mobile/workout-plan` (GET) and `/synced` stay live. The shared table must
# match this set exactly; `RETIRED_PATHS` below is derived from the table so the
# Swift scan cannot drift from it.
EXPECTED_RETIRED = {
    ("GET", "/v1/mobile/goals"),
    ("PUT", "/v1/mobile/goals"),
    ("GET", "/v1/mobile/run-coach"),
    ("POST", "/v1/mobile/run-coach"),
    ("POST", "/v1/mobile/workout-plan/preview"),
    ("POST", "/v1/mobile/workout-plan/confirm"),
    ("POST", "/v1/mobile/workout-plan/generate"),
}

# Paths the iOS transport currently spells. `/generate` is deliberately absent:
# the app never called it; the replacement is the refresh command.
IOS_TRANSPORT_PATHS = {
    "/v1/mobile/goals": 2,          # goals() + replayPlanPublication map
    "/v1/mobile/run-coach": 2,      # runCoach() + replayPlanPublication map
    "/v1/mobile/workout-plan/preview": 1,
    "/v1/mobile/workout-plan/confirm": 1,
}

failures: list[str] = []
checks = 0


def check(condition: bool, reason: str) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(reason)


def read_source(relative: str) -> str:
    path = ROOT / relative
    if not path.is_file():
        failures.append(f"source file is missing: {relative}")
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        failures.append(f"source file is not valid UTF-8: {relative} ({error})")
        return ""


def strip_swift_comments(source: str) -> str:
    """Remove line/block comments while preserving newlines.

    Deliberately not a Swift parser: the paths this gate looks for are ordinary
    string literals and cannot be split by a `//` inside them in practice.
    """
    without_block = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"//[^\n]*", "", without_block)


def declaration_body(source: str, header: str) -> str | None:
    match = re.search(header, source)
    if not match:
        return None
    start = source.find("{", match.start())
    if start < 0:
        return None
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    return None


# --- 1. Shared method+path table ------------------------------------------------
contract = read_source(CONTRACT)
surface_block = re.search(
    r"RETIRED_TRAINING_PLAN_SURFACES\s*=\s*\[(.*?)\]\s*as const", contract, re.S)
check(surface_block is not None, f"{CONTRACT}: RETIRED_TRAINING_PLAN_SURFACES table is missing")
declared = set()
if surface_block:
    declared = {
        (method, path)
        for method, path in re.findall(
            r'\{\s*method:\s*"(GET|POST|PUT)",\s*path:\s*"([^"]+)"', surface_block.group(1))
    }
check(declared == EXPECTED_RETIRED,
      f"{CONTRACT}: retirement table drifted: {sorted(declared)} != {sorted(EXPECTED_RETIRED)}")
RETIRED_PATHS = sorted({path for _, path in declared})

server = read_source(SERVER)
check("retiredLegacyRoutes = new Set(RETIRED_TRAINING_PLAN_SURFACES.map" in server,
      f"{SERVER}: retiredLegacyRoutes must derive from the shared table, not a second list")
check("retiredTrainingPlanSurface(method, routeUrl)" in server,
      f"{SERVER}: the preHandler must match method+pathname, not a path-only set")
check('retiredLegacySurfaceFor("GET", "/v1/mobile/goals")' in server
      and 'retiredLegacySurfaceFor("PUT", "/v1/mobile/goals")' in server
      and 'retiredLegacySurfaceFor("POST", "/v1/mobile/workout-plan/preview")' in server,
      f"{SERVER}: retired handlers must resolve their replacement through the shared table")
check('legacy_surface_retired' in server,
      f"{SERVER}: the 410 response must keep the stable legacy_surface_retired code")

# OpenAPI is generated from the same table; a second handwritten paths block
# would let the document keep advertising what the router already retired.
schemas = read_source(SCHEMAS)
check("...retiredPlanPaths" in schemas
      and "RETIRED_TRAINING_PLAN_SURFACES" in schemas,
      f"{SCHEMAS}: OpenAPI retired paths must be generated from the shared table")

# --- 2. iOS transport literals --------------------------------------------------
api_client = strip_swift_comments(read_source(API_CLIENT))
for path, expected_count in IOS_TRANSPORT_PATHS.items():
    actual = api_client.count(f'"{path}"')
    check(actual == expected_count,
          f"{API_CLIENT}: expected {expected_count} literal(s) of {path}, found {actual}")
check('"coach": "/v1/mobile/run-coach"' in api_client
      and '"confirm": "/v1/mobile/workout-plan/confirm"' in api_client
      and '"goals": "/v1/mobile/goals"' in api_client,
      f"{API_CLIENT}: replayPlanPublication route map lost a retired route (the guard cannot know it)")

for swift in sorted(IOS_ROOT.rglob("*.swift")):
    relative = swift.relative_to(ROOT).as_posix()
    if relative == API_CLIENT:
        continue
    source = strip_swift_comments(read_source(relative))
    # A simple `"a" + "b"` split must not evade the literal check. This is not
    # a Swift parser; it deliberately only folds adjacent string literals.
    normalized = re.sub(r'"\s*\+\s*"', "", source)
    for path in RETIRED_PATHS:
        check(f'"{path}"' not in normalized,
              f"{relative}: executable code spells a retired plan path {path}; move it behind APIClient")
    check('"/v1/mobile/' not in source,
          f"{relative}: mobile API path fragments must live in APIClient.swift (outbound surface)")

# --- 3. Unified page kill switch -------------------------------------------------
plan_view = strip_swift_comments(read_source(PLAN_VIEW))
check("TechManualPlanView" not in plan_view,
      f"{PLAN_VIEW}: the unified page must not link to the retired manual-plan editor")
check("training.manual-plan.retired" in plan_view and "尚未适配当前服务" in plan_view,
      f"{PLAN_VIEW}: the unified page must explain that manual editing is not adapted yet")
legacy_view = strip_swift_comments(read_source(LEGACY_PLAN_VIEW))
check(legacy_view.count("NavigationLink { TechManualPlanView() }") == 1,
      f"{LEGACY_PLAN_VIEW}: the old-server page keeps exactly one manual-plan entry")

# --- 4. Model write guard --------------------------------------------------------
model = strip_swift_comments(read_source(MODEL))
check("var planWritesAvailable: Bool" in model,
      f"{MODEL}: planWritesAvailable is the single read/write capability split")
check(re.search(r'retiredPlanWriteRoutes:\s*Set<String>\s*=\s*\["coach",\s*"confirm",\s*"goals"\]', model) is not None,
      f"{MODEL}: retiredPlanWriteRoutes must cover coach/confirm/goals")
persist = declaration_body(model, r"private func persistGoals\(") or ""
check("guard planWritesAvailable else" in persist,
      f"{MODEL}: persistGoals must fail closed before sending a retired write")
preview = declaration_body(model, r"func createWeeklyPlanPreview\(") or ""
check("guard planWritesAvailable else" in preview,
      f"{MODEL}: createWeeklyPlanPreview must fail closed before sending a retired write")
publish = declaration_body(model, r"private func publishPlan<") or ""
check("Self.retiredPlanWriteRoutes.contains(route)" in publish,
      f"{MODEL}: publishPlan must refuse the retired route names before persisting")

# --- 5. Terminal 410 classification ---------------------------------------------
disposition = read_source(DISPOSITION)
check('"legacy_surface_retired"' in disposition,
      f"{DISPOSITION}: legacy_surface_retired must be in the terminal publication set")
check("static func isTerminalPlanPublicationStatus(_ status: Int) -> Bool" in disposition
      and "status == 410" in disposition,
      f"{DISPOSITION}: any HTTP 410 must be terminal, including unknown codes")

# --- 6. The gate itself must execute --------------------------------------------
check(SELF_REFERENCE in read_source(AGGREGATOR).replace("\\", "/"),
      f"this gate is an orphan: {AGGREGATOR} never runs {SELF_REFERENCE}")

if failures:
    for reason in failures:
        print(f"FAIL: {reason}")
    print(f"retired-plan outbound gate: {len(failures)} failed / {checks} checks")
    sys.exit(1)

print(f"retired-plan outbound gate passed ({checks} checks)")
