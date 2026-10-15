"""分析终态对账（§10.2「分析另行跟踪」）的结构门禁。

它守的是 §10.3 里「分析已更新」与「健康数据已保存，分析更新失败，可重试分析」两句的
**真值来源**：这两句今天不可达，因为回执的 `analysisStatus` 是服务端 COMMIT 时刻的快照
（直连车道恒写 `queued`，全仓没有更新方），所以客户端必须在收尾之后**另走一条通道**
问一次终态。这条通道有三条"改错了照样编译、肉眼也看不出来"的纪律，只能靠源码级判据兜住：

  ① 对账必须排在**游标提交之后**。反过来的话，一次对账失败会把一批评**已经成功入库**的
     事实报成同步失败，而 §14.2 A17 的"raw COMMIT 后可显示已保存"是那批事实唯一的对外结论。
  ② 对账失败**不得**把这一轮置成失败（`phase = failed`），也不得写 `lastError`。
     正确的失败表现是"这句结论暂时维持不变"（界面继续说「分析更新中」）。
  ③ 对账**不重试**、一次同步最多一次请求。对账问不到终态时唯一正确的动作是放弃，
     下一次同步收尾时自然会再问一次（§10.1 的「保存可续接」）。

外加两条防止实现悄悄漂移的断言：判据只有一份（`reconcileAnalysis`，不在这里重写映射），
以及"不改写回执"（§8.5：回执是写入时刻的凭证，消费者不得改写它）。

⚠️ 这份门禁**不能**证明对账本身能跑通：`HealthKitSync.swift` 整份锁在 `#if os(iOS)` 里，
本机（Windows / 无 swiftc）既不编译也不执行它。真正的行为判据在
`apps/ios/tests/DirectSyncReceiptRegression.swift` 的 H 节（纯 Foundation，macOS 上由
`run-model-tests.sh` 执行）。这里只钉"接线接对了没有"。

跨平台：显式 UTF-8、只读、退出码 0/1、失败逐条打印原因。
"""

# Python 3.9 兼容（D1，2026-10-15）：`tuple[int, int] | None` 这类 PEP 604 注解在
# 3.9 下会在函数定义时 TypeError（macOS 自带的 /usr/bin/python3 正是 3.9）；延迟注解
# 求值后即可在 3.9 上运行。
from __future__ import annotations

import re
import sys
from pathlib import Path

try:  # Windows 控制台默认 cp936 会把中文失败原因打成乱码，门禁的失败原因必须可读
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):  # pragma: no cover - 非标准流
    pass

ROOT = Path(__file__).resolve().parents[3]
SYNC_FILE = "apps/ios/RAI/HealthKitSync.swift"
POLICY_FILE = "apps/ios/RAI/DirectSyncCursorPolicy.swift"
STORE_FILE = "apps/ios/RAI/SyncTaskStore.swift"
AGGREGATOR_FILE = "apps/ios/tests/run-model-tests.sh"
SELF_REFERENCE = "apps/ios/tests/check-direct-sync-analysis-reconcile.py"

# 游标提交：`markSuccess` 里那一次 `commitSuccess`。判据 ①的锚点。
# 取**调用点**而不是第一次出现标识符：本文件里 `commitSuccess` 还在注释与日志里被提过。
COMMIT_CALL = "persist: { taskStore.commitSuccess("
# 对账的入口与调用点。两侧都要出现：只有定义没有调用 = 判据没有执行者（本仓既有教训）。
RECONCILE_DEF = "func reconcilePendingAnalysis("
RECONCILE_CALL = "reconcilePendingAnalysis("
# 判据本体：分析终态 → 分析状态的**唯一**映射。
DECISION_FUNC = "static func reconcileAnalysis("
# 对账槽的读写。结论必须落在一个活得比任务行（`commitSuccess` 会清掉它）长的地方。
SLOT_SAVE = "saveAnalysisReconcile("
SLOT_LOAD = "loadAnalysisReconcile("
# 被闸门拦下的一轮。它既没失败也没结，`settled` 必须排除它。
HOLD_FLAG = "cursorHoldThisRound"
# 对账只许在这一轮已经收尾时跑。
SETTLED_FLAG = "settled"

# 对账那一段里**不得出现**的东西。
# `withRetry` / `for` / `while` / `repeat` 一起查：判据 ③ 说的是"不重试"，
# 而重试可能被写成显式循环、也可能被写成既有的重试包装 —— 两种都要挡住。
FORBIDDEN_IN_RECONCILE = (
    ("phase = SyncPhase.failed.rawValue", "reconcile 里出现了把本轮置成失败 —— 对账不许让同步变红"),
    ("lastError =", "reconcile 里出现了写 lastError —— 对账失败只是诊断，不是同步结论"),
    ("withRetry", "reconcile 里出现了重试包装 —— 对账失败即放弃（§10.1「保存可续接」）"),
    ("for ", "reconcile 里出现了循环 —— 一次同步最多一次请求"),
    ("while ", "reconcile 里出现了循环 —— 一次同步最多一次请求"),
    ("repeat {", "reconcile 里出现了循环 —— 一次同步最多一次请求"),
)

# §8.5：回执是写入时刻的凭证，消费者不得改写它。对账只许写对账槽，不许写回执/任务行。
FORBIDDEN_IN_RECONCILE_WRITES = (
    "writeImportReceipt",
    "saveTask(",
    "persistPendingReceipt",
)

failures: list[str] = []
checks = 0


def check(condition: bool, reason: str) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(reason)


def read_source(relative: str) -> str:
    """只读、显式 UTF-8。缺失或非法只记一条失败，不抛 traceback。"""
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
    """去掉行注释与块注释，保留换行以便按行定位。

    必要性有实测依据：本仓的注释里逐字引用了被禁止的写法（例如"不许出现
    `phase = SyncPhase.failed.rawValue`"这句说明本身）。不剥注释的话，**把纪律写清楚**
    反而会让门禁转红 —— 那种门禁很快就会被当成噪音删掉。
    """
    without_block = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"//[^\n]*", "", without_block)


def declaration_span(source: str, header: str) -> tuple[int, int] | None:
    """`header` 命中后配对的那个声明体的 `[起始, 结束)` 偏移。

    为什么不用"下一个顶格 `}`"：`markSuccess` 体内第一个 4 空格缩进的 `}` 是
    `persistThenAcknowledge(...)` 那个**闭包**的收尾，不是方法的收尾 —— 按它切会让
    "对账在方法之外"这条正确实现被判成"在方法内"（实测踩到）。花括号计数没有这个歧义。

    ⚠️ 调用方一律用**同一个**字符串取行号：把 body 单独切出来再数 `\\n`，
    与原始字符串里的行号不是同一套坐标（本门禁第一版正是这样算出错误行号的）。
    """
    match = re.search(re.escape(header), source)
    if not match:
        return None
    start = source.find("{", match.start())
    if start == -1:
        return None
    depth = 0
    in_string = False
    index = start
    while index < len(source):
        character = source[index]
        if in_string:
            if character == "\\":
                index += 2
                continue
            if character == '"':
                in_string = False
        elif character == '"':
            in_string = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return (start, index + 1)
        index += 1
    return None


def declaration_body(source: str, header: str) -> str | None:
    span = declaration_span(source, header)
    return None if span is None else source[span[0] : span[1]]


def line_at(source: str, offset: int) -> int:
    return source.count("\n", 0, offset) + 1


sync_raw = read_source(SYNC_FILE)
policy_raw = read_source(POLICY_FILE)
store_raw = read_source(STORE_FILE)
aggregator_raw = read_source(AGGREGATOR_FILE)

sync = strip_swift_comments(sync_raw)
policy = strip_swift_comments(policy_raw)
store = strip_swift_comments(store_raw)

# --- 1. 判据本体只有一份（不在接线处重写映射） ------------------------------------
check(DECISION_FUNC in policy,
      f"{POLICY_FILE} 里没有 {DECISION_FUNC} —— 分析终态 → 分析状态的判据必须住在纯逻辑里")
policy_body = declaration_body(policy, DECISION_FUNC) or ""
check(bool(policy_body), f"{DECISION_FUNC} 的声明体读不到（门禁的锚点失效，先修门禁再谈结论）")
# 三类终态各自要有出口；少一类，"分析已更新"或"可重试分析"就会退回不可达。
check('"succeeded"' in policy_body,
      "reconcileAnalysis 里没有 succeeded 这一格 —— 「分析已更新」就没有真值来源")
check('"failed"' in policy_body,
      "reconcileAnalysis 里没有 failed 这一格 —— 「…分析更新失败，可重试分析」就没有真值来源")
check("jobFailed" in policy_body,
      "reconcileAnalysis 没有用 jobFailed 判据 —— 「取消」会被说成「失败」（§10.1）")
# 已经确认过的结论不被改写：`notRequired` / `published` / `failed` 必须在**同一个**早退
# 分支里，且 `queued` / `running` 不在其中。
#
# ⚠️ 这条判据**不能**写成 `".notRequired" in policy_body`：那样只要函数体里任何地方提到它
# 就绿，而实测过——把 `case .notRequired, .published, .failed: return nil` 改成
# `case .published, .failed: return nil` + `case .queued, .running, .notRequired: break`
# （即让一次 succeeded 把 not_required 改写成 published，§9.1 明令禁止）时，
# 那个写法**照样绿**（判据无牙）。只有钉住"谁和谁在同一个分支"才拦得住。
reconcile_guard = re.search(
    r"case\s+([^\n:]*?)\s*:\s*return\s+nil", policy_body
)
check(reconcile_guard is not None,
      "reconcileAnalysis 里找不到「已确认的结论不改写」那条早退分支（门禁的锚点失效）")
if reconcile_guard is not None:
    guarded_cases = [name.strip().lstrip(".") for name in reconcile_guard.group(1).split(",")]
    check("notRequired" in guarded_cases,
          "not_required 不在「已确认的结论不改写」那一组里 —— 一次 succeeded 会把它改写成 "
          "published，界面因此说一句关于分析的假话（§9.1）")
    check("published" in guarded_cases and "failed" in guarded_cases,
          "published / failed 不在同一条早退分支里 —— 已确认的终态会被滞后读打回去")
    check("queued" not in guarded_cases and "running" not in guarded_cases,
          "queued / running 被放进了「不改写」那一组 —— 它们永远等不到终态（两句文案再次不可达）")

# --- 2. 接线：对账接在 `markSuccess` **之外、之后**（判据 ①） ----------------------
# ⚠️ 这里刻意**不**用"提交调用点的字符位置 < 对账调用点的字符位置"来判 ①：那两者在
# 源码里分属两个方法（提交在 `markSuccess` 体内，对账在 `performSync` 的收尾），
# 而 `markSuccess` 的定义在文件里排在 `performSync` **之后** —— 于是"文本先后"与
# "执行先后"方向相反，一条正确的实现会被它判红（第一版就是这样红的）。
# 真正要钉住的是**执行顺序**，它由两件事保证，两件都能从源码结构上判定：
#   (a) 提交确实发生在 `markSuccess` 体内（`markSuccess` 是被调用的那个函数）；
#   (b) 对账调用在 `markSuccess` 的声明体**之外**，且排在收尾判据之后（见第 5 节）。
# `markSuccess` 内部、提交之前的 `.hold` 早退分支决定了"能走到函数末尾"本身就意味着
# 提交已经成功 —— (a)+(b) 合起来就是"对账只在提交之后跑"。
COMMIT_CALL_SITE = COMMIT_CALL
commit_at = sync.find(COMMIT_CALL_SITE)
reconcile_call_at = sync.find(RECONCILE_CALL)
check(commit_at != -1, f"{SYNC_FILE} 里找不到游标提交调用点 {COMMIT_CALL_SITE!r}（门禁的锚点失效）")
check(reconcile_call_at != -1,
      f"{SYNC_FILE} 里没有 {RECONCILE_CALL} 的**调用点** —— 判据存在但没有执行者")
check(RECONCILE_DEF in sync,
      f"{SYNC_FILE} 里没有 {RECONCILE_DEF} 的定义")
if commit_at != -1 and reconcile_call_at != -1:
    calls = sync.count(RECONCILE_CALL)
    check(calls == 2,  # 定义一次 + 调用一次；多出来的调用点会让"一次同步最多一次请求"失效
          f"对账入口出现 {calls} 次（应为「定义 1 + 调用 1」）—— 每多一个调用点就多一次请求")
    mark_success_body = declaration_body(sync, "private func markSuccess(") or ""
    check(COMMIT_CALL_SITE in mark_success_body,
          f"游标提交不在 `markSuccess` 体内 —— 判据 ① 的两半对不上")
    check(f"await {RECONCILE_CALL}" not in mark_success_body,
          "对账调用被放进了 `markSuccess` 体内 —— 它必须发生在该函数返回之后（提交已完成）")

sync_lines = sync.splitlines()


def line_of(needle: str) -> int:
    for index, line in enumerate(sync_lines, start=1):
        if needle in line:
            return index
    return -1


reconcile_call_line = line_of(f"await {RECONCILE_CALL}")
mark_success_span = declaration_span(sync, "private func markSuccess(")
# 执行顺序 ≠ 文件里的先后：`markSuccess` 的定义排在 `performSync` **之后**，
# 所以对账（在 `performSync` 收尾）的**行号更小**才是正确的。判据因此是"落在声明体之前"。
mark_success_start_line = -1 if mark_success_span is None else line_at(sync, mark_success_span[0])
mark_success_end_line = -1 if mark_success_span is None else line_at(sync, mark_success_span[1])
check(reconcile_call_line != -1, f"{SYNC_FILE} 里找不到 `await {RECONCILE_CALL}` 调用点")
check(mark_success_start_line != -1, f"`markSuccess` 的方法体读不到（门禁的锚点失效）")
if reconcile_call_line != -1 and mark_success_start_line != -1:
    check(reconcile_call_line < mark_success_start_line,
          "对账调用落在 `markSuccess` 声明体之内 —— 它必须在该函数返回之后才跑（那时游标已提交）")

body = declaration_body(sync, RECONCILE_DEF) or ""
check(bool(body), f"{RECONCILE_DEF} 的声明体读不到（门禁的锚点失效）")

# --- 3. 对账那一段里不许有的东西（判据 ②③ + §8.5） --------------------------------
for needle, reason in FORBIDDEN_IN_RECONCILE:
    check(needle not in body, f"{reason}（命中：{needle!r}）")
for needle in FORBIDDEN_IN_RECONCILE_WRITES:
    check(needle not in body, f"对账改写了回执/任务行（命中：{needle!r}）—— §8.5：回执不得被改写")

# 一次请求：`api.job(id:)` 恰好一次。两次就等于"问了两个东西"或"重试了一次"。
job_calls = body.count("api.job(")
check(job_calls == 1, f"对账里 api.job( 出现 {job_calls} 次（应为 1）—— 一次同步最多一次请求")

# 拿不到终态时不许编结论：`reconcileAnalysis` 的返回值必须参与判据（`guard let` / `if let`）。
check(re.search(r"(guard let|if let)\s+\w+\s*=\s*DirectSyncCursorPolicy\.reconcileAnalysis\(", body)
      is not None,
      "对账没有对 reconcileAnalysis 的返回值做判据就直接用 —— 「没问到」会被当成结论")

# --- 4. 结论落在活得比任务行长的地方（独立槽） ------------------------------------
check(SLOT_SAVE in body, "对账没有写对账槽 —— 结论会在下一次提交时随任务行一起消失")
check(SLOT_LOAD in sync, "对账没有读对账槽 —— 重启之后无从知道该问哪条任务（§10.1「重启丢进度」）")
check("    func saveAnalysisReconcile(" in store or "func saveAnalysisReconcile(" in store,
      f"{STORE_FILE} 里没有 saveAnalysisReconcile —— 对账槽的写入方不存在")
check("func loadAnalysisReconcile(" in store,
      f"{STORE_FILE} 里没有 loadAnalysisReconcile —— 对账槽的读取方不存在")
check("sync_analysis_reconcile" in store,
      f"{STORE_FILE} 里没有 sync_analysis_reconcile 表 —— 对账槽没有落地位置")
check("sync_analysis_reconcile" in sync or SLOT_SAVE in sync,
      "对账槽与接线对不上（读/写入口没有真的被用到）")

# --- 5. 只在"这一轮已经收尾"时对账（不覆盖失败态与 hold 轮） -----------------------
# 判据按**行**取，不按字符窗口：三者之间的距离随注释增长而变，写死一个字符数会在注释
# 一改就红（假警报会训练人忽略这条检查）。
settled_line = line_of("let settled =")
guard_line = -1
if reconcile_call_line != -1:
    for index in range(max(reconcile_call_line - 4, 1), reconcile_call_line):
        if f"if {SETTLED_FLAG}" in sync_lines[index - 1]:
            guard_line = index
            break

check(settled_line != -1, f"{SYNC_FILE} 里找不到 `let {SETTLED_FLAG} =` 判据（门禁的锚点失效）")
check(guard_line != -1, f"对账调用前面找不到 `if {SETTLED_FLAG}` 守卫 —— 失败/取消的一轮也会去对账")
if settled_line != -1 and reconcile_call_line != -1:
    check(settled_line < reconcile_call_line,
          "对账没有排在收尾判据之后 —— 失败/取消/被闸门拦下的一轮也会去对账")
if guard_line != -1:
    check(HOLD_FLAG in sync_lines[guard_line - 1],
          f"对账的守卫里没有 {HOLD_FLAG} —— 被游标闸门拦下的一轮（事实还没被确认）也会去对账")
check(settled_line != -1 and guard_line != -1,
      "收尾判据与对账守卫没有同时取到 —— 门禁的锚点失效，先修门禁再谈结论")

# --- 6. 本门禁不得是孤儿：必须被聚合入口真实调用 ----------------------------------
aggregator = aggregator_raw.replace("\\", "/")
check(bool(aggregator), f"聚合入口 {AGGREGATOR_FILE} 读不到")
check(SELF_REFERENCE in aggregator,
      f"本门禁是孤儿：{AGGREGATOR_FILE} 从不执行 {SELF_REFERENCE}")

# --- 结果 -------------------------------------------------------------------------
if failures:
    print(f"FAIL: {len(failures)} analysis-reconcile check(s) failed ({checks} checks):")
    for failure in failures:
        print(f"  - {failure}")
    sys.exit(1)

print(f"OK: analysis terminal-state reconciliation gate ({checks} checks).")
print("    note: this is a source-level gate. It does NOT execute the Swift reconcile path;")
print("    the behavioural assertions run on macOS via apps/ios/tests/DirectSyncReceiptRegression.swift (H).")
