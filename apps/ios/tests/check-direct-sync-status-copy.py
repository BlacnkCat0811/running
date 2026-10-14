"""Direct-sync iOS status copy (§10.3) and background-intent wiring (§10.2) checks.

Source-level gate. It does not replace device or Simulator review: it pins the
things that "compile fine even when wrong" — which sentence the user is shown,
whether all six sentences come from one entry point, whether the cursor gate is
consulted before the commit, and whether the background intent survives a
still-continuing page.

Two deliberate measurement choices, both learned from false positives observed
while writing this file:

* §10.3 copy is matched as a **quoted Swift string literal** in code with
  comments stripped. Plain substring matching counted
  `if job.status == "succeeded" { message = "反馈已保存，分析已更新。" }`
  as a hit for `分析已更新`, and a doc comment quoting the copy counted as a
  second "entry point". Neither is the copy the user sees.
* The removed-legacy-copy sentinel is matched against the **raw** file text
  (comments included): a comment that reintroduces the old wording is cheap to
  notice and expensive to leave lying around.

Scope boundary: this gate pins the `markSuccess` commit path and the copy table.
It deliberately says nothing about `saveTask`'s `.taskPersisted` acknowledgement
(a pre-existing, documented checkpoint with its own reasoning) — that path is
**not** covered here.

Cross-platform by construction: explicit UTF-8 on every read and on stdout,
read-only, exit code 0/1, one printed reason per failure.
"""

import re
import sys
from pathlib import Path

try:  # Windows 控制台默认 cp936 会把中文失败原因打成乱码，门禁的失败原因必须可读
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):  # pragma: no cover - 非标准流
    pass

ROOT = Path(__file__).resolve().parents[3]
IOS_ROOT = ROOT / "apps" / "ios" / "RAI"
SYNC_FILE = "apps/ios/RAI/HealthKitSync.swift"
AGGREGATOR_FILE = "apps/ios/tests/run-model-tests.sh"
SELF_REFERENCE = "apps/ios/tests/check-direct-sync-status-copy.py"

# §10.3 六句文案，逐字（docs/SQLITE_DIRECT_SYNC_DESIGN.md §10.3 第 356-363 行）。
STATUS_COPY = [
    "正在读取健康增量",
    "正在上传本批数据",
    "正在保存新增与更正记录",
    "健康数据已保存，分析更新中",
    "分析已更新",
    "健康数据已保存，分析更新失败，可重试分析",
]

# §10.3 明令移除的旧语义（同节第 365-366 行）。今天 iOS 源码树里确实没有 ——
# 这是**反向哨兵**：将来有人把 Web 的「手机换库」三句抄进同步路径，这里必须红。
#
# ⚠️ 已知盲区（如实记录，不在本批写范围）：这三句在**服务端**仍然存在
# （`apps/api/src/import-worker.ts:627,641,642`），而 `HealthKitSync.waitForJob`
# 会把 `job.message` 原样写进界面文案（`:2066-2067`）。所以本判据证明的是
# "iOS 源码里没有"，**不是**"用户永远看不到"。
LEGACY_COPY = [
    "备份并校验现有数据",
    "临时数据库增量同步",
    "验证完成正在切换本地数据库",
]

# 与 T3（ios-status-copy）/ T2（ios-receipt-protocol）对齐后的真实标识符。
COPY_ENTRY_NAME = "DirectSyncCopy"
GATE_CALL = "DirectSyncCursorPolicy.decision("
COMMIT_CALL = "taskStore.commitSuccess("
ACKNOWLEDGE_CALL = "acknowledgeBackgroundIntent"
# §10.2 的"仍需续接 ⇒ 不认领"必须钉**保护形态**，不是"某段文本里不许出现这个字符串"：
# 后者会把正确写法判红（2026-10-13 实测：窗口取法把 `guard ... { return }` 后面紧邻的
# 正确调用圈进了"分支"，Lead 与 T4 各自独立复现了这次假红）。两种保护形态都算：
#   1. `guard !needsContinuation else { return }` 紧邻调用点（早返回保护）；
#   2. `if !needsContinuation { ... acknowledge ... }`（条件内保护）。
ACKNOWLEDGE_GUARDS = [
    re.compile(
        r"guard\s+!needsContinuation\s+else\s*\{\s*return\s*\}\s*\n\s*" + ACKNOWLEDGE_CALL + r"\("
    ),
    re.compile(
        r"if\s+!needsContinuation\s*\{\s*\n?\s*(?://[^\n]*\n\s*)*" + ACKNOWLEDGE_CALL + r"\("
    ),
]
# 闸门必须真的被告知"有没有候选游标"、"要不要等回执"，以及拿到的是哪一份回执。
# `requiresReceipt` 是 2026-10-13 那次自锁复核之后的形状：缺了它，`unchanged` 收尾那类
# "没有导入作业、因此永远没有回执"的成功路径会被判成 `.hold(no_receipt)` 并自锁。
GATE_REQUIRED_ARGS = (
    "serverContractVersion:",
    "receipt:",
    "pendingCursorsPresent:",
    "requiresReceipt:",
    "phase:",
)
# §10.1「保存可续接」：被闸门拦下的一轮**既没失败、也没结**，收尾兜底必须能表达这件事，
# 否则它会清掉任务行与候选游标、界面改口"同步成功"。
HOLD_FLAG = "cursorHoldThisRound"

failures: list[str] = []
checks = 0


def check(condition: bool, reason: str) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(reason)


def read_source(relative: str) -> str:
    """只读、显式 UTF-8。缺失或不合法只记一条失败，不抛 traceback。"""
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
    """去掉行注释与块注释，保留换行以便按行定位。字符串字面量里的 `//` 不常见，忽略。"""
    without_block = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"//[^\n]*", "", without_block)


def declaration_body(source: str, header: re.Pattern[str]) -> str | None:
    """取 `header` 命中后 `{` 到下一个顶格 `}` 之间的声明体。"""
    match = header.search(source)
    if not match:
        return None
    start = source.find("{", match.start())
    if start == -1:
        return None
    end = source.find("\n}", start)
    return source[start : end if end != -1 else len(source)]


def ios_swift_sources() -> dict[str, str]:
    if not IOS_ROOT.is_dir():
        failures.append(f"iOS source root is missing: {IOS_ROOT.relative_to(ROOT)}")
        return {}
    sources: dict[str, str] = {}
    for path in sorted(IOS_ROOT.rglob("*.swift")):
        relative = str(path.relative_to(ROOT)).replace("\\", "/")
        try:
            sources[relative] = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            failures.append(f"iOS source is not valid UTF-8: {relative} ({error})")
    return sources


# --- 1. §10.3 六句文案逐字存在，且全部来自同一个集中入口 ------------------------

sources = ios_swift_sources()
check(len(sources) >= 50, f"expected to read the iOS source tree, only got {len(sources)} Swift files")
code_sources = {name: strip_swift_comments(text) for name, text in sources.items()}


def literal_holders(phrase: str) -> list[str]:
    """把 §10.3 句子当成**代码里的完整字符串字面量**来找。"""
    needle = f'"{phrase}"'
    return [name for name, text in code_sources.items() if needle in text]


for phrase in STATUS_COPY:
    holders = literal_holders(phrase)
    check(
        bool(holders),
        f"§10.3 status copy is not a string literal in iOS source: {phrase!r} (expected in {SYNC_FILE})",
    )
    # 只在**字面量**层面唯一：任何人都不能另抄一份，改文案必须改集中入口。
    total = sum(text.count(f'"{phrase}"') for text in code_sources.values())
    check(
        total <= 1,
        f"§10.3 status copy {phrase!r} is written {total} times; it must live only in the copy table",
    )

copy_owners = {name: [p for p in STATUS_COPY if f'"{p}"' in text] for name, text in code_sources.items()}
copy_owners = {name: hits for name, hits in copy_owners.items() if hits}
check(
    len(copy_owners) == 1,
    "§10.3 copy must live in exactly one file, found in "
    + ", ".join(f"{name} ({len(hits)}/6)" for name, hits in sorted(copy_owners.items())),
)

sync_source = read_source(SYNC_FILE)
sync_code = strip_swift_comments(sync_source) if sync_source else ""
entry_body = declaration_body(sync_code, re.compile(rf"\benum {COPY_ENTRY_NAME}\b")) if sync_code else None
check(
    entry_body is not None,
    f"the centralised copy entry point `enum {COPY_ENTRY_NAME}` was not found in {SYNC_FILE}",
)
if entry_body is not None:
    missing = [phrase for phrase in STATUS_COPY if f'"{phrase}"' not in entry_body]
    check(
        not missing,
        "§10.3 copy must all come from one entry point; missing from it: "
        + ", ".join(repr(phrase) for phrase in missing),
    )
    check(
        len(entry_body) < 4000,
        "the copy entry point must stay a small copy table, not swallow the sync path",
    )
    # 判据载体必须真的被用：只声明不引用的文案表 = 用户看不到的文案。
    uses = sum(text.count(COPY_ENTRY_NAME) for text in code_sources.values()) - 1
    check(
        uses >= 1,
        f"`{COPY_ENTRY_NAME}` is declared but never referenced: the copy table is dead code",
    )

# --- 2. §10.3 旧语义反向哨兵：整个 iOS 源码树里都不许出现 -----------------------

for phrase in LEGACY_COPY:
    holders = [name for name, text in sources.items() if phrase in text]
    check(
        not holders,
        f"removed legacy status copy is back in iOS source: {phrase!r} in {', '.join(holders)}",
    )

# 2b（S2.4，2026-10-14 新增）：**英文阶段 token 不得作为兜底直出**。
# 旧的 `else if !job.phase.isEmpty { message = job.phase }` 会把服务端内部维护语义
# （`activate` / `backup` / `import` …）原样送上界面。反例夹具在
# `check-background-mutations.py` 的 `[copy]` 组：把那段兜底写回来，本断言转红。
check(
    "message = job.phase" not in sync_code,
    "the raw English `job.phase` token must not be shown to the user "
    "(§10.3: no internal maintenance wording — keep the previous message instead)",
)

# 2c（S3.5，2026-10-14 新增）：**同一哨兵扩到服务端同步文件**。
#
# 为什么扫服务端：这三句文案原本也住在 `import-worker.ts` 的候选链路里，而 `job.message`
# 会被 iOS 原样上屏（§10.3）—— 服务端把旧语义写回来，用户看到的是同一句假话。
# 为什么用**原始文本**（含注释）而不是剥注释后的代码：注释里"重新引入旧措辞"是廉价且
# 危险的重构前兆；剥注释会让它静默通过。这正是本脚本顶部的分工 —— 文案**持有者**判定
# 必须剥注释（避免引用误报），**移除哨兵**必须不剥（宁误报不漏报）。
SERVER_LEGACY_SCAN_FILES = [
    "apps/api/src/import-worker.ts",
    "apps/api/src/direct-sync-ingest.ts",
]
for relative in SERVER_LEGACY_SCAN_FILES:
    server_source = read_source(relative)
    for phrase in LEGACY_COPY:
        check(
            phrase not in server_source,
            f"removed legacy status copy is back in server sync source: {phrase!r} in {relative}",
        )

# --- 3. §10.2 成功路径上的顺序与后台意图 ---------------------------------------

mark_success = declaration_body(sync_code, re.compile(r"func markSuccess\s*\(")) if sync_code else None
check(mark_success is not None, f"private func markSuccess was not found in {SYNC_FILE}")
if mark_success is not None:
    gate_at = mark_success.find(GATE_CALL)
    commit_at = mark_success.find(COMMIT_CALL)
    check(gate_at != -1, f"the cursor gate `{GATE_CALL}` is not on the markSuccess path")
    check(commit_at != -1, f"`{COMMIT_CALL}` is not on the markSuccess path")
    if gate_at != -1 and commit_at != -1:
        check(
            gate_at < commit_at,
            f"the cursor gate must be evaluated before {COMMIT_CALL} on the markSuccess path "
            "— otherwise the cursor advances on a batch no durable receipt has confirmed (§10.1)",
        )
        # 闸门必须拿到全部四个入参：少一个（尤其 pendingCursorsPresent / receipt）
        # 就等于把闸门"接通但接错线"，而它照样编译通过。
        call = mark_success[gate_at : gate_at + 400]
        absent_args = [label for label in GATE_REQUIRED_ARGS if label not in call]
        check(
            not absent_args,
            "the cursor gate call is missing argument labels " + ", ".join(absent_args),
        )

    # §10.2「连续分页尚未 drain 完时，不清空后台待办意图」：
    # 正确形状是"认领调用点被 `!needsContinuation` 保护"，而不是"这个分支里不许出现
    # acknowledgeBackgroundIntent" —— 后者会把正确写法判红。
    check(
        any(pattern.search(mark_success) for pattern in ACKNOWLEDGE_GUARDS),
        "§10.2: the acknowledgement call must be protected by `!needsContinuation` "
        "(either `guard !needsContinuation else { return }` right before it, or an "
        "`if !needsContinuation { ... }` around it) — otherwise a still-continuing page clears "
        "the background intent and nobody sends the next page",
    )

    # `.hold` 分支必须什么都不提交：既不推进游标，也不认领意图。
    hold_match = re.search(r"if case let \.hold\(reason\) = cursorDecision\s*\{", mark_success)
    check(hold_match is not None, "the `.hold` early-return branch was not found on the markSuccess path")
    if hold_match is not None:
        after = mark_success[hold_match.end() :]
        end = after.find("SyncStateCommitPlan.watermark(")
        hold_branch = after[: end if end != -1 else 600]
        for forbidden in (COMMIT_CALL, ACKNOWLEDGE_CALL):
            check(
                forbidden not in hold_branch,
                f"the `.hold` branch must not call {forbidden}: holding means nothing is committed "
                "and the pending intent stays",
            )

    # §10.1「保存可续接」：拦下的一轮必须被收尾兜底看见，否则它会当成"结清了" ⇒ 清任务行、
    # 清候选游标、界面改口"同步成功"（而游标其实一个字没写）。
    settled_at = mark_success.find("let settled")
    if settled_at == -1:
        settled_at = sync_code.find("let settled")
    check(settled_at != -1, "the `let settled` wrap-up predicate was not found in the sync file")
    if settled_at != -1:
        settled_window = sync_code[settled_at : settled_at + 300]
        check(
            f"!{HOLD_FLAG}" in settled_window,
            f"the wrap-up predicate `let settled` must include `!{HOLD_FLAG}`: a round stopped by "
            "the cursor gate is neither failed nor finished, and treating it as finished clears the "
            "task row and the candidate cursors",
        )
    resets = [m.start() for m in re.finditer(rf"\b{HOLD_FLAG} = false\b", sync_code)]
    sets = [m.start() for m in re.finditer(rf"\b{HOLD_FLAG} = true\b", sync_code)]
    check(bool(resets), f"`{HOLD_FLAG}` is never reset: one hold would suppress every later round's wrap-up")
    check(bool(sets), f"`{HOLD_FLAG}` is never set: the wrap-up predicate can never see a held round")
    if resets and sets:
        check(
            min(resets) < min(sets),
            f"`{HOLD_FLAG} = false` must be reset per round before it is ever set to `true`",
        )

# --- 4. §10.2 requiresReceipt 的 7 个调用点必须逐点显式取值 ---------------------
#
# `DirectSyncCursorPolicy.decision` / `continuationNeeded` 把"这一轮适不适用回执协议"
# 交给**调用点**决定。纯逻辑回归只能钉住"传 false 会怎样"，钉不住"哪一类收尾该传 false"——
# 那是一个逐点映射表，而 Swift 的默认值（`requiresReceipt: Bool = true`）会让新调用点
# **静默编译通过**。所以这里逐点枚举，按语义分类断言，不按行号。


def mark_success_call_sites(source: str) -> list[tuple[int, str]]:
    """返回 (起始行号, 实参文本)。跳过声明本身与注释行。"""
    lines = source.splitlines()
    sites: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        if "markSuccess(" not in line:
            continue
        stripped = line.lstrip()
        if stripped.startswith("//") or stripped.startswith("*") or "private func markSuccess" in line:
            continue
        body: list[str] = []
        cursor = index + 1
        while cursor < len(lines) and cursor < index + 45:
            body.append(lines[cursor])
            if re.match(r"^\s*\)\s*$", lines[cursor]):
                break
            cursor += 1
        sites.append((index + 1, "\n".join(body)))
    return sites


if sync_source:
    call_sites = mark_success_call_sites(sync_source)
    check(
        len(call_sites) >= 4,
        f"expected to enumerate the markSuccess call sites, only found {len(call_sites)}",
    )
    receipt_backed = 0
    receipt_free = 0
    for line_number, body in call_sites:
        has_receipt = re.search(r"receipt:\s*[^\n,]+", body) is not None
        requires = re.search(r"requiresReceipt:\s*([^\n,]+)", body)
        if requires is None:
            check(
                False,
                f"markSuccess call at line {line_number} does not pass `requiresReceipt:` — "
                "it silently inherits the default `true`, and a receipt-free wrap-up that waits for "
                "a receipt it can never get holds forever (the 2026-10-13 self-lock)",
            )
            continue
        value = requires.group(1).strip()
        if has_receipt:
            receipt_backed += 1
            check(
                value != "false",
                f"markSuccess call at line {line_number} ran an import job (it passes a receipt) "
                f"but declares `requiresReceipt: {value}` — a batch really was submitted, so this "
                "wrap-up must wait for the durable receipt before advancing the cursor",
            )
        else:
            receipt_free += 1
            check(
                value == "false",
                f"markSuccess call at line {line_number} has no receipt to wait for (the server "
                f"answered \"nothing to import\") but declares `requiresReceipt: {value}` — waiting "
                "for a receipt that will never exist holds this successful wrap-up forever",
            )
    # 两类都必须真的存在：全被改成一类说明分类本身失效了（例如 receipt 实参被删光）。
    check(receipt_backed >= 1, "no receipt-backed markSuccess call site was found")
    check(receipt_free >= 1, "no receipt-free markSuccess call site was found")

    # markSuccess 自己必须把这一位**转发**给两个判据。
    forwarded = mark_success.count("requiresReceipt: requiresReceipt")
    check(
        forwarded >= 2,
        f"markSuccess must forward `requiresReceipt` to both policy calls, forwarded {forwarded} time(s)",
    )

# --- 5. 本门禁不得是孤儿：必须被聚合入口真实调用 --------------------------------

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
    print(f"Direct-sync status copy checks: {checks} checks, {len(failures)} failed")
    sys.exit(1)

print(
    f"Direct-sync status copy checks passed ({checks} checks: §10.3 copy verbatim from one entry, "
    "legacy copy absent, §10.2 gate order and intent acknowledgement, gate is mounted)"
)
