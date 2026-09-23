#!/usr/bin/env python3
"""Live-execution determinism checks for `HealthKitExport`, run inside a Simulator.

Why this exists, next to the structural gate
--------------------------------------------
`check-export-determinism.py` reads the source and asserts three *shapes* (sorted
`metadata` keys, explicit sample sort descriptors, no wall clock in the manifest).
That is cheap and runs everywhere, but it never executes the code: it would still
pass if someone sorted the keys into a throwaway variable, and it can say nothing
about what the emitted bytes actually are.

This script closes that gap for the one channel a simulator can genuinely
exercise. `HealthKitExport` is locked behind `#if os(iOS)`, so it cannot be
compiled for macOS — but it *can* be compiled for the iOS Simulator, and the
Simulator needs **no HealthKit entitlement** as long as nothing touches
`HKHealthStore`. Constructing an `HKWorkout`, and calling the file-private
`metadataXML`, both work (`isHealthDataAvailable()` is true; only the
authorisation/query path fails closed).

Why the comparison must span two processes
------------------------------------------
The defect is that `for (key, value) in metadata` walks a Swift `Dictionary`,
whose iteration order comes from a **per-process** hash seed. Two calls in one
process agree; two calls in two processes need not. A single-process "call it
twice and compare" test would therefore pass on the broken code and prove nothing.
So the probe is installed as an app and launched repeatedly, and the recorded
output is compared **across launches**.

The probe also re-runs itself with `.sorted()` removed, and requires that run to
disagree. A gate that cannot fail is worse than no gate.
"""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SOURCE = REPO / "apps/ios/RAI/HealthKitExport.swift"
ZIP_SOURCE = REPO / "apps/ios/RAI/StoredZip.swift"
DEVICE_NAME = "RAI Technology Acceptance"
BUNDLE_ID = "app.rai.probe"
TARGET = "x86_64-apple-ios17.0-simulator"

# Anchor for the mutation. Kept as an exact-bytes pair so a rename or a reformat
# makes this script fail loudly instead of silently skipping the self-check.
SORTED_LOOP = (
    "        for key in metadata.keys.sorted() {\n"
    "            if skip.contains(key) { continue }\n"
    "            guard let value = metadata[key] else { continue }\n"
)
UNSORTED_LOOP = (
    "        for (key, value) in metadata {\n"
    "            if skip.contains(key) { continue }\n"
)

# Appendices are compiled *into the same file* as the production source. An
# `extension HealthKitExport` is required: `private` members are visible to the
# enclosing declaration and its same-file extensions, but not to a sibling type.
PROBE = """

// ===================== probe appendix (added by check-export-determinism-live.py) =====================
// HealthKit validates metadata while the HKWorkout is being built and throws
// `_HKObjectValidationFailureException` unless HKMetadataKeySyncIdentifier comes
// with HKMetadataKeySyncVersion. Keep the pair.
extension HealthKitExport {
    static func probeMetadataXML() -> String {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let metadata: [String: Any] = [
            "RAIProbeZulu": "zulu",
            "HKMetadataKeySyncIdentifier": "sync-should-be-skipped",
            "HKMetadataKeySyncVersion": 1,
            "RAIProbeAlpha": "alpha",
            "HKIndoorWorkout": 1,
            "HKMetadataKeyWeatherTemperature": 21.5
        ]
        let workout = HKWorkout(
            activityType: .running, start: start, end: start.addingTimeInterval(1800),
            duration: 1800, totalEnergyBurned: nil, totalDistance: nil, metadata: metadata
        )
        let first = metadataXML(workout)
        let second = metadataXML(workout)
        let keys = first.split(separator: "\\n").compactMap { line -> String? in
            guard let r = line.range(of: "key=\\"") else { return nil }
            let rest = line[r.upperBound...]
            guard let end = rest.firstIndex(of: "\\"") else { return nil }
            return String(rest[..<end])
        }
        var out: [String] = []
        out.append("KEYS=" + keys.joined(separator: ","))
        out.append("SORTED=" + (keys == keys.sorted() ? "yes" : "no"))
        out.append("SKIPPED_INDOOR=" + (first.contains("HKIndoorWorkout") ? "no" : "yes"))
        out.append("SKIPPED_SYNCID=" + (first.contains("HKMetadataKeySyncIdentifier") ? "no" : "yes"))
        out.append("ENTRY_COUNT=\\(keys.count)")
        out.append("SECOND_CALL_IDENTICAL=" + (second == first ? "yes" : "no"))
        out.append("XML_BEGIN")
        out.append(first)
        out.append("XML_END")
        return out.joined(separator: "\\n")
    }
}

@main
struct ExportDeterminismProbe {
    static func main() {
        let text = HealthKitExport.probeMetadataXML()
        let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("probe-result.txt")
        try? text.write(to: url, atomically: true, encoding: .utf8)
        print(text)
    }
}
"""

RESULTS: list[str] = []
FAILURES: list[str] = []


def check(condition: bool, message: str) -> None:
    (RESULTS if condition else FAILURES).append(message)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def device_udid() -> str:
    listed = run(["xcrun", "simctl", "list", "devices", "available", "-j"])
    if listed.returncode != 0:
        print("无法列出模拟器：xcrun simctl 不可用", file=sys.stderr)
        sys.exit(1)
    import json

    for devices in json.loads(listed.stdout)["devices"].values():
        for device in devices:
            if device["name"] == DEVICE_NAME:
                return device["udid"]
    print(f"找不到名为 {DEVICE_NAME!r} 的模拟器（可用 RAI_VISUAL_DEVICE 指定）", file=sys.stderr)
    sys.exit(1)


def strip_ios_guard(text: str) -> str:
    lines = text.split("\n")
    if not lines[0].startswith("#if os(iOS)"):
        raise SystemExit("HealthKitExport.swift 的首行不再是 `#if os(iOS)`，本脚本需要更新")
    index = max(i for i, line in enumerate(lines) if line.strip() == "#endif")
    if any(line.strip() for line in lines[index + 1 :]):
        raise SystemExit("#endif 之后出现内容，本脚本需要更新")
    return "\n".join(lines[1:index])


def build(source_text: str, work: Path) -> Path:
    work.mkdir(parents=True, exist_ok=True)
    module = work / "probe.swift"
    module.write_text(source_text + PROBE, encoding="utf-8")
    binary = work / "Probe.app" / "Probe"
    binary.parent.mkdir(parents=True, exist_ok=True)
    compiled = run(
        [
            "xcrun", "-sdk", "iphonesimulator", "swiftc",
            "-disable-sandbox",
            "-target", TARGET,
            "-parse-as-library",
            "-swift-version", "5",
            str(ZIP_SOURCE), str(module),
            "-o", str(binary),
            "-lz",
        ]
    )
    if compiled.returncode != 0:
        print(compiled.stdout)
        print(compiled.stderr, file=sys.stderr)
        raise SystemExit("探针编译失败（见上）")
    with (binary.parent / "Info.plist").open("wb") as handle:
        plistlib.dump(
            {
                "CFBundleExecutable": "Probe",
                "CFBundleIdentifier": BUNDLE_ID,
                "CFBundleName": "Probe",
                "CFBundleVersion": "1",
                "CFBundleShortVersionString": "1.0",
                "CFBundlePackageType": "APPL",
                "MinimumOSVersion": "17.0",
                "UIDeviceFamily": [1],
            },
            handle,
        )
    return binary.parent


def launch_runs(device: str, app: Path, runs: int) -> list[str]:
    run(["xcrun", "simctl", "uninstall", device, BUNDLE_ID])
    installed = run(["xcrun", "simctl", "install", device, str(app)])
    if installed.returncode != 0:
        raise SystemExit(f"安装探针失败：{installed.stderr.strip()}")
    container = run(["xcrun", "simctl", "get_app_container", device, BUNDLE_ID, "data"])
    if container.returncode != 0:
        raise SystemExit(f"取不到数据容器：{container.stderr.strip()}")
    result = Path(container.stdout.strip()) / "probe-result.txt"

    outputs: list[str] = []
    for index in range(runs):
        result.unlink(missing_ok=True)
        run(["xcrun", "simctl", "launch", "--terminate-running-process", device, BUNDLE_ID])
        deadline = time.time() + 20
        while time.time() < deadline and not result.exists():
            time.sleep(0.25)
        if not result.exists():
            # Surface the crash instead of a bare "missing file". `--console-pty`
            # blocks until the app exits, so a hung launch also lands here.
            try:
                crashed = run(
                    ["xcrun", "simctl", "launch", "--terminate-running-process", "--console-pty", device, BUNDLE_ID],
                    timeout=25,
                )
                detail = f"{crashed.stdout}\n{crashed.stderr}".strip()
            except subprocess.TimeoutExpired as expired:
                detail = f"探针在 25s 内没有退出（可能启动即崩且无输出）：{expired.stdout or ''}"
            raise SystemExit(f"探针第 {index + 1} 次运行没有落盘结果：\n{detail}")
        outputs.append(result.read_text(encoding="utf-8"))
    return outputs


def probe_checks(outputs: list[str], label: str) -> None:
    first = outputs[0]
    fields = dict(
        line.split("=", 1) for line in first.split("\n") if "=" in line and not line.startswith("    ")
    )
    check(fields.get("SORTED") == "yes", f"{label}: <MetadataEntry> 按键升序输出")
    check(fields.get("SKIPPED_INDOOR") == "yes", f"{label}: HKIndoorWorkout 被跳过（与修复前一致）")
    check(fields.get("SKIPPED_SYNCID") == "yes", f"{label}: HKMetadataKeySyncIdentifier 被跳过（与修复前一致）")
    check(fields.get("ENTRY_COUNT") == "4", f"{label}: 输出条目数为 4（跳过 2 个保留键后）")
    check(fields.get("SECOND_CALL_IDENTICAL") == "yes", f"{label}: 同进程内两次调用字节一致")


def main() -> int:
    source = SOURCE.read_text(encoding="utf-8")
    body = strip_ios_guard(source)
    device = device_udid()
    run(["xcrun", "simctl", "boot", device])
    booted = run(["xcrun", "simctl", "bootstatus", device, "-b"])
    if booted.returncode != 0:
        raise SystemExit(f"模拟器启动失败：{booted.stderr.strip()}")

    work = Path(tempfile.mkdtemp(prefix="rai-export-live-"))
    try:
        # --- pass 1: the shipped code must be byte-identical across processes ---
        healthy = launch_runs(device, build(body, work / "healthy"), runs=3)
        probe_checks(healthy, "shipped")
        check(
            len(set(healthy)) == 1,
            "shipped: 三次独立启动的 <MetadataEntry> 字节完全一致",
        )
        if len(set(healthy)) != 1:
            differing = healthy[0].split("KEYS=")[1].split("\n")[0]
            others = {out.split("KEYS=")[1].split("\n")[0] for out in healthy[1:]}
            print(f"  实际顺序：{differing} vs {sorted(others)}")

        # --- pass 2: the self-check. Removing `.sorted()` MUST break it. ---
        if SORTED_LOOP not in body:
            raise SystemExit(
                "找不到 `metadata.keys.sorted()` 锚点：源码结构已变，"
                "本脚本的突变自检会变成空转，因此直接判失败。"
            )
        mutated = body.replace(SORTED_LOOP, UNSORTED_LOOP)
        broken = launch_runs(device, build(mutated, work / "broken"), runs=4)
        check(
            len(set(broken)) > 1,
            "self-check: 去掉 .sorted() 后跨进程顺序确实会变（证明本门禁不是空转）",
        )
        if len(set(broken)) == 1:
            print("  去掉 .sorted() 后四次启动仍然一致 —— 本次自检没能证伪，需人工确认。")
    finally:
        shutil.rmtree(work, ignore_errors=True)
        run(["xcrun", "simctl", "uninstall", device, BUNDLE_ID])

    print(f"Export determinism (live): {len(RESULTS)} checks, {len(FAILURES)} failed")
    for line in RESULTS:
        print(f"  ok   {line}")
    for line in FAILURES:
        print(f"  FAIL {line}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
