#!/usr/bin/env python3
"""`HealthKitExport.swift` 导出确定性的结构门禁（不依赖 Xcode）。

为什么需要它：这个文件被 `typecheck-ios.sh` 覆盖，却**不被任何回归脚本编译** ——
整文件被 `#if os(iOS)` + `import HealthKit` 锁死，关键 helper 全是 `private static`，
所以"跑两遍断言字节相同"这条路在本机/CI 上根本走不通。它钉的是
「改错了照样编译通过、肉眼也看不出来」的那一类事实：

1. `<MetadataEntry>` 必须按键排序输出。Swift `Dictionary` 无稳定遍历序，行序一变，
   解析侧 `addMetadata` 首次见到键的顺序就变，`workouts.metadata_json` 的键序随之变，
   而整个对象都进 `stableId("workout_content", …)` —— 同一次跑步在没有任何新数据的日子
   被反复判 `updated`，模型从窗口起点整体重放。
2. 样本查询必须显式排序。不排序时 `export.xml` 的 `<Record>` 位置会抖，
   文件字节变 ⇒ `source_sha256` 变 ⇒ 服务端的 `inspection` **永远不可能**返回 `unchanged`。
3. manifest 里不许有墙钟。`createdAt = Date()` 让 ZIP 字节每次都不同，
   上传幂等键跟着变，服务端每次新建一份来源。

跑法：`python3 apps/ios/tests/check-export-determinism.py`
（挂在 `run-model-tests.sh` 末尾，与 `check-background-capabilities.py` 同一个位置。）
突变验证见 `check-background-mutations.py` 里 `[export]` 前缀的条目。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
IOS = ROOT / "apps" / "ios"
EXPORT = IOS / "RAI" / "HealthKitExport.swift"
MODEL_RUNNER = IOS / "tests" / "run-model-tests.sh"
SELF = "apps/ios/tests/check-export-determinism.py"

failures = []  # type: list[str]
checks = 0


def check(condition: bool, message: str) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(message)


def read(path: Path) -> str:
    if not path.exists():
        failures.append("missing file: %s" % path)
        return ""
    return path.read_text(encoding="utf-8")


def without_comments(text: str) -> str:
    """去掉注释，只留代码。

    ⚠️ 这一步**不是**可选的。本文件的注释里逐字写着被检查的那些形状
    （metadataXML 上方那段就写着 `for (key, value) in metadata`，
    manifest 上方那段写着旧的 `createdAt` 表达式，样本查询上方写着
    `sortDescriptors`），于是"符号出现在注释里"会让判据**恒红或恒绿** ——
    而恒红的门禁和没有门禁一样糟。`check-background-capabilities.py:71-79`
    是同一个坑的现成范式。

    块注释、行注释都要处理：manifest 那段注释里还带着 `{version, sourceScope,
    deletedSourceIds}`，它的花括号会把下面的括号配平算歪。
    """
    without_block = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return "\n".join(
        line for line in without_block.splitlines() if not line.strip().startswith("//")
    )


def function_body(text: str, name: str) -> str | None:
    """取 `func <name>(…) -> T { … }` 的函数体（括号配平）。

    声明不存在时返回 `None`，调用方**必须当成失败**：函数被改名或删掉之后，
    下面那些"不得出现 X"的判据会全部静默变绿 —— 那正是本门禁存在的意义所在。
    """
    match = re.search(r"\bfunc\s+" + re.escape(name) + r"\s*[<(]", text)
    if match is None:
        return None
    open_paren = text.find("(", match.end() - 1)
    if open_paren < 0:
        return None
    depth = 0
    index = open_paren
    while index < len(text):
        if text[index] == "(":
            depth += 1
        elif text[index] == ")":
            depth -= 1
            if depth == 0:
                break
        index += 1
    else:
        return None
    open_brace = text.find("{", index)
    if open_brace < 0:
        return None
    depth = 0
    index = open_brace
    while index < len(text):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[open_brace + 1:index]
        index += 1
    return None


raw = read(EXPORT)
code = without_comments(raw)
runner = read(MODEL_RUNNER)

# --- 1. `<MetadataEntry>` 必须按键排序输出 ---------------------------------
metadata_body = function_body(code, "metadataXML")
check(metadata_body is not None, "metadataXML is gone; every judgement below would be vacuous")
if metadata_body is not None:
    # 反向锚点：证明取到的确实是那个函数体，而不是被括号配平算歪的一小段。
    check(
        "<MetadataEntry key=" in metadata_body,
        "metadataXML body does not look like the metadata emitter",
    )
    check(
        re.search(r"for\s*\([^)]+\)\s*in\s+metadata\b", metadata_body) is None,
        "metadataXML iterates the Swift Dictionary directly, so <MetadataEntry> line order is per-process",
    )
    check(
        re.search(r"for\s+\w+\s+in\s+metadata\.keys\.sorted\(\)", metadata_body) is not None,
        "metadataXML does not iterate metadata.keys.sorted(), so the exported line order is not stable",
    )

# --- 2. 样本查询必须显式排序 ------------------------------------------------
samples_body = function_body(code, "samples")
check(samples_body is not None, "samples() is gone; the query-order judgement would be vacuous")
if samples_body is not None:
    check("HKSampleQuery(" in samples_body, "samples() body does not build an HKSampleQuery")
    check(
        re.search(r"sortDescriptors\s*:\s*nil", samples_body) is None,
        "samples() still passes sortDescriptors: nil, so export.xml bytes still drift",
    )
    check(
        "type is HKWorkoutType" not in samples_body,
        "samples() still sorts only workouts, so every other record type keeps an unspecified order",
    )
    check(
        "HKSampleSortIdentifierStartDate" in samples_body,
        "samples() does not sort by HKSampleSortIdentifierStartDate",
    )

# --- 3. manifest 不许带墙钟 -------------------------------------------------
check(
    '"createdAt"' not in code,
    'the sync manifest still carries a "createdAt" key, so the archive bytes (and the upload idempotency key) change every export',
)
check(
    "ISO8601DateFormatter().string(from: Date())" not in code,
    "the sync manifest still stamps a wall clock, so payloadHash can never repeat",
)
deleted_lines = [line for line in code.splitlines() if '"deletedSourceIds"' in line]
check(
    len(deleted_lines) == 1,
    'expected exactly one "deletedSourceIds" entry in the manifest, found %d' % len(deleted_lines),
)
for line in deleted_lines:
    check(
        ".sorted()" in line,
        'the manifest\'s "deletedSourceIds" is written unsorted, so HKAnchoredObjectQuery\'s order leaks into the ZIP',
    )

# --- 4. 门禁自己不许成孤儿 --------------------------------------------------
check(
    SELF in runner,
    "run-model-tests.sh does not call this gate, so it would be an orphan gate (a judgement nobody executes)",
)

print("Export determinism checks: %d checks, %d failed" % (checks, len(failures)))
for message in failures:
    print("FAIL: " + message)
sys.exit(1 if failures else 0)
