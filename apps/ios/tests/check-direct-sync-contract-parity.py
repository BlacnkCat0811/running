"""Direct-sync contract parity: iOS enums vs the shared TypeScript contract.

The two languages cannot import each other, so the only thing that keeps
`DirectSyncIngestStatus` / `DirectSyncAnalysisStatus` from silently drifting away
from `packages/contracts/src/direct-sync.ts` is a text-level comparison. This gate
does exactly that comparison, verbatim and order-sensitive, and prints the actual
values from both sides when it fails.

Cross-platform by construction: explicit UTF-8, read-only, exit code 0/1, one
printed reason per failure.
"""

import re
import sys
from pathlib import Path

try:  # Windows 控制台默认 cp936 会把中文失败原因打成乱码，门禁的失败原因必须可读
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):  # pragma: no cover - 非标准流
    pass

ROOT = Path(__file__).resolve().parents[3]

# 服务端契约的位置按**探测**取，不写死单一猜测：本仓同时存在 packages/contracts
# 与 packages/api-contracts，钉错路径会让门禁检查一个不存在的文件然后"通过"。
SERVER_CONTRACT_CANDIDATES = [
    "packages/contracts/src/direct-sync.ts",
    "packages/api-contracts/src/direct-sync.ts",
]
SERVER_STATUS_CONSTANTS = {
    "DirectSyncIngestStatus": "INGEST_STATUSES",
    "DirectSyncAnalysisStatus": "ANALYSIS_STATUSES",
}
IOS_SOURCE_ROOT = "apps/ios/RAI"
IOS_ENUM_NAMES = {
    "DirectSyncIngestStatus": "DirectSyncIngestStatus",
    "DirectSyncAnalysisStatus": "DirectSyncAnalysisStatus",
}
VERSION_SYMBOL = "factsAnalysisContractVersion"
TS_SCAN_ROOTS = ["packages/contracts/src", "packages/api-contracts/src", "apps/api/src"]
AGGREGATOR_FILE = "apps/ios/tests/run-model-tests.sh"
SELF_REFERENCE = "apps/ios/tests/check-direct-sync-contract-parity.py"

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


def parse_ts_list(text: str, const_name: str) -> list[str] | None:
    match = re.search(
        rf"export const {const_name}\s*=\s*\[(.*?)\]\s*as const", text, re.S
    )
    if not match:
        return None
    return re.findall(r'"([^"]*)"', match.group(1))


def swift_enum_cases(text: str, enum_name: str) -> list[str] | None:
    """取 Swift enum 的 case 名（含顺序）。带 rawValue 时以 rawValue 为准。"""
    header = re.search(rf"\benum {enum_name}\b[^{{]*\{{", text)
    if not header:
        # 也接受 case 直接写在 extension 里的形态：退化为全文按 enum 名分块。
        return None
    body = text[header.end() :]
    end = body.find("\n}")
    body = body[: end if end != -1 else len(body)]
    cases: list[str] = []
    for line in body.splitlines():
        match = re.match(r"\s*case\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*\"([^\"]*)\")?", line)
        if match:
            cases.append(match.group(2) if match.group(2) is not None else match.group(1))
    return cases


def collect_version_values(text: str) -> list[str]:
    return re.findall(rf"{VERSION_SYMBOL}\s*[:=]\s*(\d+)", text)


# --- 1. 服务端契约：先探测到真实路径 -------------------------------------------

server_relative = next(
    (path for path in SERVER_CONTRACT_CANDIDATES if (ROOT / path).is_file()), None
)
check(
    server_relative is not None,
    "server contract file not found; probed " + ", ".join(SERVER_CONTRACT_CANDIDATES),
)
server_text = read_source(server_relative) if server_relative else ""
if server_relative:
    print(f"server contract: {server_relative}")

# --- 2. 状态取值集合：逐字、含顺序 ---------------------------------------------

ios_files: dict[str, str] = {}
ios_root = ROOT / IOS_SOURCE_ROOT
if not ios_root.is_dir():
    failures.append(f"iOS source root is missing: {IOS_SOURCE_ROOT}")
else:
    for path in sorted(ios_root.rglob("*.swift")):
        relative = str(path.relative_to(ROOT)).replace("\\", "/")
        try:
            ios_files[relative] = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            failures.append(f"iOS source is not valid UTF-8: {relative} ({error})")

for server_const, ios_enum in ((v, k) for k, v in SERVER_STATUS_CONSTANTS.items()):
    server_values = parse_ts_list(server_text, server_const) if server_text else None
    check(
        server_values is not None,
        f"could not parse `export const {server_const} = [...] as const` from {server_relative}",
    )

    holders = [
        (name, swift_enum_cases(text, ios_enum))
        for name, text in ios_files.items()
        if re.search(rf"\benum {ios_enum}\b", text)
    ]
    if not holders:
        check(
            False,
            f"iOS enum {ios_enum} was not found anywhere under {IOS_SOURCE_ROOT} "
            f"(server side: {server_values})",
        )
        continue
    check(
        len(holders) == 1,
        f"iOS enum {ios_enum} must be declared exactly once, found in "
        + ", ".join(name for name, _ in holders),
    )
    ios_values = holders[0][1]
    if not ios_values:
        check(False, f"iOS enum {ios_enum} in {holders[0][0]} declares no cases")
        continue
    if server_values is None:
        continue
    check(
        ios_values == server_values,
        f"{ios_enum} drifted from {server_const}: "
        f"iOS {ios_values} != server {server_values} (verbatim order matters)",
    )
    print(f"  {ios_enum} == {server_const}: {ios_values}")

# --- 3. factsAnalysisContractVersion 两边一致 ----------------------------------

server_version_text = "\n".join(
    read_source(str(path.relative_to(ROOT)).replace("\\", "/"))
    for root in TS_SCAN_ROOTS
    for path in sorted((ROOT / root).rglob("*.ts"))
    if path.is_file()
)
ios_version_text = "\n".join(ios_files.values())
server_versions = sorted(set(collect_version_values(server_version_text)))
ios_versions = sorted(set(collect_version_values(ios_version_text)))

check(
    bool(server_versions),
    f"server side never declares {VERSION_SYMBOL} (scanned {', '.join(TS_SCAN_ROOTS)})",
)
check(
    bool(ios_versions),
    f"iOS side never reads or declares {VERSION_SYMBOL} (scanned {IOS_SOURCE_ROOT})",
)
if server_versions and ios_versions:
    check(
        len(server_versions) == 1,
        f"server declares more than one {VERSION_SYMBOL} value: {server_versions}",
    )
    check(
        ios_versions == server_versions,
        f"{VERSION_SYMBOL} drifted: iOS {ios_versions} != server {server_versions}",
    )
    print(f"  {VERSION_SYMBOL}: server {server_versions}, iOS {ios_versions}")

# --- 3b. P2-7（2026-10-15）：inspect 预检 400 的「确定性输入拒绝」码两端逐字一致 -----------
#
# 服务端 inspect 的 400 出口（`import-routes.ts` 的预检分支）经 `laneRefusalFailure`
# （`apps/api/src/import-worker.ts`）折码。preflight 可产出的 reason 只有两族：
#   bounds 族（xml/manifest/deletions/route_exceeds_bounds）→ `direct_sync_payload_exceeds_bounds`
#     ⇒ iOS `.convergeBudget`（预算收敛后重导）；
#   输入族（missing_required_files / input_tree_not_allowed / missing_record_identity /
#     payload_identity_invalid）→ `direct_sync_input_not_allowed`
#     ⇒ iOS `.abandonTask`（清任务重传，自愈）—— 2026-10-15 起生效，此前落 `.keepTask`
#     活锁（sourceId 保留、重撞同 400、nginx 再无 uploads）。
# 本判据把输入族 code 在**两端**钉成逐字一致：服务端改码而 iOS 未跟时，这里先红，
# 而不是在线上以"每次同步重撞 400"的形态暴露。

server_import_worker = read_source("apps/api/src/import-worker.ts")
ios_cancellation = read_source("apps/ios/RAI/HealthSyncCancellation.swift")

check(
    '"direct_sync_input_not_allowed"' in server_import_worker,
    "the server laneRefusalFailure mapping no longer emits direct_sync_input_not_allowed "
    "(apps/api/src/import-worker.ts) — the iOS disposition pins this exact code",
)
check(
    'inputNotAllowedCode = "direct_sync_input_not_allowed"' in ios_cancellation,
    "the iOS disposition no longer pins direct_sync_input_not_allowed "
    "(apps/ios/RAI/HealthSyncCancellation.swift) — a server inspect 400 with this code would "
    "fall back to .keepTask and livelock the sync",
)

# --- 4. 本门禁不得是孤儿 -------------------------------------------------------

aggregator = read_source(AGGREGATOR_FILE)
check(bool(aggregator), f"the aggregator gate entry {AGGREGATOR_FILE} is missing")
if aggregator:
    check(
        SELF_REFERENCE in aggregator.replace("\\", "/"),
        f"this gate is an orphan: {AGGREGATOR_FILE} never runs {SELF_REFERENCE}",
    )

# --- 结果 ---------------------------------------------------------------------

if failures:
    for reason in failures:
        print(f"FAIL: {reason}")
    print(f"Direct-sync contract parity checks: {checks} checks, {len(failures)} failed")
    sys.exit(1)

print(
    f"Direct-sync contract parity checks passed ({checks} checks: status enums verbatim "
    f"and in order, {VERSION_SYMBOL} identical, gate is mounted)"
)
