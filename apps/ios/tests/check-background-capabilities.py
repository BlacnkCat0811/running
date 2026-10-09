#!/usr/bin/env python3
"""后台同步能力的结构门禁（不依赖 Xcode）。

为什么需要它：`apps/ios/RAI/HealthKitSync.swift` 不被任何回归脚本编译，只被
`typecheck-ios.sh` 类型检查 —— 而类型检查看不见"切后台时到底调了谁"。
下面这些判据全部属于"改错了照样编译通过、肉眼也看不出来"的那一类。

跑法：`python3 apps/ios/tests/check-background-capabilities.py`
（挂在 `run-model-tests.sh` 末尾，与 `check-today-layout.py` 同一个位置。）
"""
from __future__ import annotations

import plistlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
IOS = ROOT / "apps" / "ios"
RAI = IOS / "RAI"
TESTS = IOS / "tests"

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


def tail_after(text: str, anchor: str, label: str) -> str:
    """`text` 里 `anchor` 之后的部分，并**要求锚点命中且恰好一次**。

    为什么必须有这个守卫（2026-09-23 实测的直接原因）：本文件原先一律写
    `text.split(anchor)[-1]`。锚点一旦因为改名 / 改签名而命中不到，`split` 返回单元素
    列表，`[-1]` 就**退化成整个文件**（后面再 `.split("\\n    private func ")[0]` 得到的是
    文件头，约 5300 字符）—— 于是 `check("..." in body)` 变成对文件头做子串匹配。

    实测：把 `HealthKitSync.swift` 里的 `clearTask` 做**行为等价改名**（连定义带 11 处
    调用点），`clear_body` 从 547 字符退化成文件头，而 `hasPendingTask = false` 在
    `HealthKitSync.swift:46` 的属性声明里也出现 ⇒ 该判据恒真，门禁照旧打印
    `Background capability checks: 162 checks, 0 failed`（退出码 0）。**静默跳过比没有判据
    更糟**，所以这里一律"取不到锚点就报失败"，与 `check-export-determinism.py` 里
    `check(body is not None, "could not parse the body of ...")` 是同一条纪律。

    返回值在锚点异常时是空串：下游 `check("x" in body)` 会一并变红。红得多一点是有意的 ——
    宁可吵，也不要静默。
    """
    hits = text.count(anchor)
    if hits != 1:
        check(
            False,
            "%s: anchor %r matched %d time(s), need exactly 1 — a renamed/reshaped declaration "
            "would otherwise degrade this slice to the whole file and the judgement below would "
            "become vacuously true" % (label, anchor, hits),
        )
        return ""
    return text.split(anchor)[1]


def ordered(text: str, first: str, second: str, why: str) -> None:
    """断言 `first` 在 `second` **之前**出现，且两个符号都必须存在。

    为什么不能写成 `if a in text and b in text: check(index...)`：那个形态下，任一符号
    被改名/删除，整条判据会被**静默跳过且不产生 `FAIL:` 行** —— 判据总数从 162 掉到 161，
    而门禁仍然报 0 failed（2026-09-23 实测：`performSync` / `uploadToSystem` /
    `handleEventsForBackgroundURLSession` 三处改名都会这样）。顺序判据的价值全在"谁在前"，
    而"两个符号都没有"这件事本身就该是红的。
    """
    missing = [name for name in (first, second) if name not in text]
    if missing:
        check(False, "%s: %s never appears — the ordering judgement below cannot be made" % (why, missing))
        return
    check(text.index(first) < text.index(second), why)


def phase_literals(text: str):
    """`HealthKitSync` 实际写进 phase 的**裸字符串**（赋值式与实参式两种写法）。

    P1 之后这里必须是空集：客户端只写 `SyncPhase.<case>.rawValue`，裸字符串只剩
    "读老 payload"这一条迁移路径。留着它是为了让"有人又手打一个阶段名"立刻变红。
    """
    found = set(re.findall(r'\bphase\s*=\s*"([^"]*)"', text))
    found |= set(re.findall(r'\bphase\s*:\s*"([^"]*)"', text))
    return found


def phase_enum_uses(text: str):
    """`HealthKitSync` 里 `SyncPhase.<case>` 的成员名（`.rawValue` 可省）。"""
    return set(re.findall(r"\bSyncPhase\.([a-zA-Z][A-Za-z0-9]*)", text))


def swift_string_list(text: str, name: str):
    """解析 `static let <name>: [T] = [ "a", "b" ]` 形式的字符串列表。"""
    m = re.search(re.escape(name) + r"[^=]*=\s*\[(.*?)\]", text, re.S)
    if m is None:
        return None
    return set(re.findall(r'"([^"]*)"', m.group(1)))


def swift_string_constant(text: str, name: str):
    """解析 `static let <name> = "value"`（单值常量）。"""
    m = re.search(re.escape(name) + r"\s*(?::\s*\w+\s*)?=\s*\"([^\"]*)\"", text)
    return m.group(1) if m else None


def without_comment_lines(text: str) -> str:
    """去掉**整行注释**，保留代码行。

    为什么不能直接对整个文本做 `index()`：本仓的注释里逐字提到了被检查的那些符号名
    （观察者那段的注释里就写着 `applicationState`，`SyncPhase` 的说明里写着 `cancelled`），
    于是"这个符号出现在注释里"会让行序判据**恒红或恒绿** —— 而恒红的门禁和没有门禁一样糟。
    `observers.isEmpty` 那条判据踩的就是同一个坑，它用的是"只匹配代码行"的写法。
    """
    return "\n".join(line for line in text.splitlines() if not line.strip().startswith("//"))


def parsed_plist(path: Path):
    if not path.exists():
        failures.append("missing file: %s" % path)
        return {}
    try:
        return plistlib.loads(path.read_bytes())
    except Exception as error:  # noqa: BLE001 - 解析失败本身就是结论
        failures.append("%s is not a parsable plist: %s" % (path.name, error))
        return {}


app = read(RAI / "RAIApp.swift")
sync = read(RAI / "HealthKitSync.swift")
lifecycle = read(RAI / "HealthSyncLifecycle.swift")
phase_src = read(RAI / "SyncPhase.swift")
policy = read(RAI / "BackgroundSyncPolicy.swift")

# --- 1. 切后台不得再取消一个用户没有取消的同步 -----------------------------
check(".cancelSync(" not in app, "RAIApp.swift still calls cancelSync() when entering the background")
check(".handleEnterBackground(" in app, "RAIApp.swift does not call handleEnterBackground() when entering the background")

# --- 2. 两个中止入口必须都挂在 HealthKitSync 上 -----------------------------
check(
    re.search(r"func handleEnterBackground\(\)", sync) is not None,
    "HealthKitSync is missing handleEnterBackground()",
)
check(
    re.search(r"func suspendForLifecycle\(\)", sync) is not None,
    "HealthKitSync is missing suspendForLifecycle()",
)

# --- 3. 阶段闭集只有一个来源，写出去的值跑不出它 ---------------------------
#     以前是"`HealthKitSync` 的裸字符串"、"`HealthSyncLifecycle.persistedPhases` 的手写数组"、
#     "`SyncPhase` 的枚举"三份同名单。现在只留 `SyncPhase` 一份，另外两处都是派生或引用，
#     所以判据也变了：不再配平"两份清单"，而是**要求另外两份不复存在**。
enum_body = re.search(r"enum SyncPhase: String, CaseIterable, Sendable \{(.*?)\n\}", phase_src, re.S)
check(enum_body is not None, "could not parse the SyncPhase enum body")
# 🔴 必须同时收下**带显式 rawValue** 的 case（`case deferredProtectedData = "deferred_protected_data"`）。
# 原先的正则要求 `case <name>` 之后直接是行尾，于是这类 case 被**静默漏掉** —— 而漏掉的后果不是
# "少收一个"，是 3b/3c 会反过来把合法引用报成 unknown、或者让闭集缺项而误判。
#
# 而且是**两份口径**，不是一份：
#   - `declared`         = case **名**，给 `SyncPhase.<member>` 那种写法用（3b）；
#   - `declared_values`  = **落盘值**，给 `switch phase` 与展示层的 `case "..."` 用（3c）。
# 此前"case 名 == rawValue"恰好成立，所以一份够用；V2.1 的两个阻塞阶段改用蛇形 rawValue
# 之后，混用会让判据**假红**（或更糟：为了消红而把闭集改坏）。
declared_pairs = re.findall(
    r"^\s*case ([a-z][A-Za-z0-9_]*)\s*(?:=\s*\"([^\"]*)\")?\s*$",
    enum_body.group(1) if enum_body else "",
    re.M,
)
declared = {name for name, _ in declared_pairs}
declared_values = {raw or name for name, raw in declared_pairs}
check(bool(declared), "SyncPhase declares no cases")

check(
    re.search(r"static let persistedPhases[^=]*=\s*SyncPhase\.allCases\.map", lifecycle) is not None,
    "persistedPhases is no longer derived from SyncPhase.allCases — a second phase list has appeared",
)
check(
    re.search(r"static let terminalPhases[^=]*=\s*Set\(SyncPhase\.terminal", lifecycle) is not None,
    "terminalPhases is no longer derived from SyncPhase.terminal — a second phase list has appeared",
)

# 3a. 客户端不得再手打阶段名。
bare = sorted(phase_literals(sync))
check(
    not bare,
    "HealthKitSync.swift still writes bare phase strings: %s" % bare,
)

# 3b. 用到的 `SyncPhase.<case>` 必须在闭集里（拼错一个字母编译就过不去，但**别处**的
#     字符串比较不会；这条挡的是 `.rawValue` 被当成自由文本使用）。
if declared:
    unknown = sorted(phase_enum_uses(sync) - declared - {"allCases", "terminal", "legacyOnly", "migrate"})
    check(
        not unknown,
        "HealthKitSync.swift references SyncPhase members that do not exist: %s" % unknown,
    )

# 3c. `enterBackground` 的 switch 字面量也必须落在闭集内 —— 它用的是 `phase: String`，
#     编译器不会替它检查拼写。
switch_block = re.search(r"switch phase \{(.*?)\n        \}", lifecycle, re.S)
check(switch_block is not None, "could not parse the phase switch inside enterBackground")
if switch_block is not None:
    # ⚠️ 必须剥掉注释：`switch phase` 块里的说明逐字提到了阶段名（"非终态一律 keepWorking" 这类），
    # 整段抓会把中文短语也当成阶段 —— 而那是**假红**，假红的门禁和恒绿的一样糟。
    # 口径用 `declared_values`（落盘值）：`switch phase` 比的是字符串，不是 case 名。
    switch_cases = set(re.findall(r'"([^"]*)"', without_comment_lines(switch_block.group(1))))
    check(
        switch_cases <= declared_values,
        "HealthSyncLifecycle switches on phases outside the closed set: %s"
        % sorted(switch_cases - declared_values),
    )

# --- 3d. D1 的落点：`uploaded` 与 `importing` 必须由**字段**分流 --------------
#     这条是 P1 的核心不变式。判据写成"实参配对"，因为它精确、且不依赖代码在文件里的位置：
#       - 写下 `sourceId` 的那一刻，服务端才刚收下这一批、导入还没发起 ⇒ 只能是 `uploaded`；
#       - 写 `jobId` 才意味着导入已在服务端跑 ⇒ 只能是 `importing`。
#     把两者混成同一个值，正是 2026-09-22 线上死锁的形状。
#     逐调用点解析实参，而不是整文件搜正则：`updateTask(sourceId:jobId:phase:)` 三个参数
#     同时出现是**合法**的（导入已发起那一刻），一条 `[^)]*` 会把这两种情形混起来。
update_calls = re.findall(r"updateTask\(([^)]*)\)", sync)
check(bool(update_calls), "no updateTask( call site found in HealthKitSync.swift")
seen_uploaded = False
for args in update_calls:
    if "phase: .importing" in args:
        check(
            "jobId:" in args,
            "updateTask records .importing without a jobId: the server has not started anything yet",
        )
    if "phase: .uploaded" in args:
        seen_uploaded = True
        check(
            "sourceId:" in args and "jobId:" not in args,
            "updateTask records .uploaded with the wrong fields: it means 'uploaded, no job yet'",
        )
check(
    seen_uploaded,
    "no call site records phase .uploaded — the D1 'uploaded but not started' window is gone",
)
check(
    re.search(r"\bphase\s*=\s*SyncPhase\.exported\.rawValue", sync) is not None,
    "HealthKitSync never records .exported — a batch on disk with no upload in flight is then unsayable",
)

# --- 3e. 上传用的 multipart 必须落在一个下次唤醒还读得到的地方 --------------
#     `/tmp` 会被系统清理，而"续传"的全部前提就是"字节还在"。更直接的后果：
#     `defer { removeItem }` 与"把上传交给系统"天然互斥 —— 函数一返回文件就没了。
#     切片用相邻的函数声明做锚点，而不是数花括号：后者只要有人加一层嵌套就静默截断。
upload_body = tail_after(
    sync,
    "private func upload(zipURL: URL, to serverURL: URL, payloadHash: String)",
    "upload()",
)
upload_body = upload_body.split("\n    private func ")[0]
# 判据从 `session.upload(` 换成 `uploadToSystem(`：P2-4 之后字节交给的是**系统**（background
# URLSession），前台那条 `.ephemeral` 通道只剩非 iOS 的回退分支（第 10f 节单独钉住）。
check(
    "multipartURL" in upload_body and "uploadToSystem(" in upload_body,
    "could not slice the body of HealthKitSync.upload(_:to:payloadHash:)",
)
check(
    "temporaryDirectory" not in upload_body,
    "upload() still stages its multipart in /tmp — it will be gone by the next wake",
)
check(
    "defer { try? FileManager.default.removeItem(at: multipartURL) }" not in upload_body,
    "upload() still deletes its multipart on the way out, which breaks resumable uploads",
)
check(
    "Self.multipartBoundary(for: payloadHash)" in upload_body,
    "upload() does not derive its boundary from payloadHash — a rebuilt multipart would differ byte-wise",
)
check(
    "UUID()" not in upload_body,
    "upload() still randomises its multipart name or boundary, so a rebuilt batch is a different batch",
)

# --- 4. 用户取消是唯一写 "cancelled" 的路径 ---------------------------------
#     判据已从 `HealthKitSync.swift`（不被任何回归脚本编译）搬进 `HealthSyncLifecycle`
#     的纯函数 `phaseAfterStop`（有执行者）。门禁的角色随之改变：不再检查"那一行有没有守卫"
#     （字面匹配证得了"写了什么"、证不了"算出来什么"），而是检查
#     "调用方有没有偷偷自己写" + "纯函数里那一处 return 有没有 `.manual` 前置"。
lines = sync.splitlines()
check(
    not re.search(r'\bphase\s*=\s*(SyncPhase\.cancelled\.rawValue|"cancelled")', sync),
    'HealthKitSync.swift writes phase = "cancelled" itself; it must delegate to '
    "HealthSyncLifecycle.phaseAfterStop",
)
check(
    "HealthSyncLifecycle.phaseAfterStop(" in sync,
    "finishCancelled does not delegate to HealthSyncLifecycle.phaseAfterStop",
)
check(
    re.search(r"func phaseAfterStop\(", lifecycle) is not None,
    "HealthSyncLifecycle is missing phaseAfterStop()",
)
judge_lines = lifecycle.splitlines()
cancel_returns = [i for i, line in enumerate(judge_lines) if re.search(r'return\s+"cancelled"', line)]
check(
    len(cancel_returns) == 1,
    'the pure judge should return "cancelled" exactly once, found %d' % len(cancel_returns),
)
if len(cancel_returns) == 1:
    window = "\n".join(judge_lines[max(0, cancel_returns[0] - 3) : cancel_returns[0] + 1])
    check(
        "cause == .manual" in window,
        'the "cancelled" return is not guarded by `cause == .manual`',
    )

# --- 5. beginBackgroundTask 到期只能走 lifecycle，不能冒充用户取消 ---------
background_task_lines = [i for i, line in enumerate(lines) if "beginBackgroundTask(" in line]
check(len(background_task_lines) >= 1, "no beginBackgroundTask call found in HealthKitSync.swift")
if background_task_lines:
    window = "\n".join(lines[background_task_lines[0] : background_task_lines[0] + 8])
    check(
        "suspendForLifecycle()" in window,
        "the background-task expiration handler does not call suspendForLifecycle()",
    )
    check(
        "cancelSync()" not in window,
        "the background-task expiration handler still calls cancelSync()",
    )

# --- 5b. 后台额度主动看门狗（2026-09-24 OOM 溯源新增）-----------------------
# expiration handler 只在"临近到期"才被系统回调，内存吃紧时可能来不及；
# 看门狗每秒盯剩余额度、低于安全余量就主动收尾。判据用出现次数：`backgroundTimeSafetyMargin`
# 声明 + 使用至少各一次，把"常量还在但没人拿它盯表"和"整块被删"都挡住；
# `budgetWatchdog` 在则保证 defer 里的 invalidate 接线没被摘。
check(
    sync.count("backgroundTimeSafetyMargin") >= 2,
    "the background-time watchdog margin is declared but never used (or missing)",
)
check(
    "budgetWatchdog" in sync,
    "the background-time watchdog is missing from HealthKitSync.swift",
)

# --- 6. resumablePhase 自身不得吐出 "cancelled" ----------------------------
body = re.search(
    r"static func resumablePhase\(for interrupted: String\) -> String \{(.*?)\n    \}",
    lifecycle,
    re.S,
)
check(body is not None, "could not parse the body of resumablePhase")
if body is not None:
    check(
        '"cancelled"' not in body.group(1),
        'resumablePhase contains a "cancelled" literal — a lifecycle stop must never write it',
    )

# --- 6b. 观察者只注册一次，且注册点在启动期 ---------------------------------
#     Apple 要求 HealthKit 观察者每次启动都重新注册，而原先唯一的调用点在
#     `RootView.onAppear`：视图没出现（后台唤醒、直接进别的界面）就一个观察者都没有。
#     修法是把入口搬到 `didFinishLaunching`，并**删掉** `guard observers.isEmpty`
#     （那个守卫只会让人看不见"又有人把入口挂回视图层"）。
#
#     ⇒ 因此这里钉的不是"守卫在不在"，而是**调用点恰好一处**。多一处就说明入口回去了。
app_delegate = read(RAI / "AppDelegate.swift")
call_sites = re.findall(
    r"\.startObservingHealthChanges[\s(]",
    sync + app + app_delegate + read(RAI / "RootView.swift"),
)
check(
    len(call_sites) == 1,
    "startObservingHealthChanges has %d call sites; it must have exactly one (AppDelegate, at launch)"
    % len(call_sites),
)
check(
    re.search(r"func startObservingHealthChanges\(", sync) is not None,
    "HealthKitSync is missing startObservingHealthChanges()",
)
# 只在**代码行**上找，不在注释里找：本文件与 `HealthKitSync` 的说明都逐字提到了这个守卫，
# 用 `in` 判会永远红（"恒红"的门禁和没有门禁一样糟）。
check(
    re.search(r"^[ \t]*guard observers\.isEmpty", sync, re.M) is None,
    "the observers.isEmpty guard is back — it hides a second registration site instead of preventing it",
)
check(
    "@UIApplicationDelegateAdaptor(RaiAppDelegate.self)" in app,
    "RAIApp does not install RaiAppDelegate, so nothing registers observers at launch",
)
check(
    "RaiStartup.registerSyncEntryPoints(" in app_delegate,
    "AppDelegate.swift does not call RaiStartup.registerSyncEntryPoints",
)
# `completion()` 必须早于**任何**后续动作：HealthKit 连续 3 次收不到它会**永久停掉**
# 这类样本的投递，现象是"第一次能唤醒，之后再也不唤醒"，且毫无报错。
#
# 🔴 P2 之后这条要泛化：原先只盯 `applicationState` 一个符号，而 P2 把那个门控从观察者里
# 搬到了派发方（`RaiStartup`）—— 只盯它会让这条判据**静默失效**（符号没了，`index()` 抛
# `ValueError`，或者更糟：判据在实现已经不对的情况下仍然绿）。现在对每个"出现在它后面
# 的形态"逐个判，覆盖 `Task` / `await` / `guard` / `if`。
observer_body = re.search(r"HKObserverQuery\(.*?\n            \}\n        \}", sync, re.S)
check(observer_body is not None, "could not parse the HKObserverQuery handler")
if observer_body is not None:
    handler = without_comment_lines(observer_body.group(0))
    check(
        "completion()" in handler,
        "the HKObserverQuery handler no longer calls completion() at all",
    )
    for later in ("Task {", "await ", "guard ", "if "):
        if later not in handler:
            continue
        check(
            handler.index("completion()") < handler.index(later),
            "completion() no longer precedes %r in the observer handler; "
            "HealthKit stops delivering after three misses" % later,
        )
    # 观察者自己不许再判应用状态：判在哪跑是派发方的事（`SyncDeliveryPolicy`）。
    # 留在这里等于把后台唤醒整个吞掉 —— 而 P2 的全部意义就是让后台唤醒也能干活。
    check(
        "applicationState" not in handler,
        "the observer handler gates on applicationState again — it swallows every background wake",
    )
    # 后台投递必须真的被开出来，且失败不许被吞（`success == false` 是唯一的痕迹）。
    check(
        "enableBackgroundDelivery(" in sync,
        "HealthKit background delivery is never enabled; delivery wakes will never arrive",
    )
    check(
        re.search(r"try\??\s+.*enableBackgroundDelivery|enableBackgroundDelivery[^\n]*\btry\?", sync) is None,
        "enableBackgroundDelivery is wrapped in try? — a denial would leave no trace",
    )
    delivery = re.search(r"enableBackgroundDelivery\(for:.*?\n        \}", sync, re.S)
    check(
        delivery is not None and "guard !success" in delivery.group(0),
        "the enableBackgroundDelivery completion ignores its success flag",
    )

# --- 6c. 「有待办批次」必须由进度写点维护，不能在别处另算 -------------------
#     `hasPendingTask` 是展示层区分"上次成功"与"还卡着一批"的唯一依据。它一旦与
#     `sync_tasks` 的真实内容漂移，界面就会在某一天开始撒谎，而类型检查和回归都不会响。
check(
    sync.count("hasPendingTask = true") == 5 and "if taskStore.lastError != nil" in sync and "if let journalError = taskStore.lastError" in sync
    and "guard taskStore.reopenIfUnavailable() else" in sync,
    "hasPendingTask must be set at saveTask, journal-read failures and failed database preparation",
)
#     计数必须按**行首赋值**算：属性声明 `private(set) var hasPendingTask = false`（:46）里
#     逐字含有同一个字符串。原先这里写 `sync.count("hasPendingTask = false") >= 1`，
#     于是这条判据被**声明**满足 —— 把 `clearTask` 里那行真正清标记的赋值删掉也照样绿。
#     清点必须是**日志清空点**的个数：`clearTask()`（解不开的进度）、`markSuccess()`
#     （V2.1 §4.2 之后的单事务提交）。多一处就等于界面可以凭空说"没有待办了"。
clear_assignments = [
    line
    for line in sync.splitlines()
    if re.match(r"\s*hasPendingTask = false\s*$", line)
]
check(
    len(clear_assignments) == 2,
    "hasPendingTask is cleared in %d places, need exactly 2 (clearTask + markSuccess; the "
    "declaration at the top of the type does not count): the flag is the only thing telling the UI "
    "apart from 'the journal is empty', so another writer would let the two drift"
    % len(clear_assignments),
)
save_body = tail_after(sync, "private func saveTask(", "saveTask()").split("\n    private func ")[0]
clear_body = tail_after(sync, "private func clearTask()", "clearTask()").split("\n    private func ")[0]
check("hasPendingTask = true" in save_body, "saveTask does not record that a batch is pending")
check("hasPendingTask = false" in clear_body, "clearTask does not clear the pending flag")

# --- 7. 门禁自己不能变成孤儿（本项目已经踩过不止一次） ---------------------
runner = read(TESTS / "run-health-sync-tests.sh")
for required in (
    "HealthSyncLifecycle.swift",
    "HealthSyncLifecycleRegression.swift",
    "SyncPhase.swift",
    "SyncTaskState.swift",
    "SyncAtomicUnitRegression.swift",
    "SyncTaskMigrationRegression.swift",
):
    check(
        required in runner,
        "run-health-sync-tests.sh does not compile/run %s" % required,
    )
aggregate = read(TESTS / "run-model-tests.sh")
check(
    "check-background-capabilities.py" in aggregate,
    "run-model-tests.sh does not invoke this script — it would be an orphan gate",
)
# 突变验证脚本**刻意不进** `run-ios-gates.sh`（它会改写源码、跑十几分钟），但它必须有入口：
# 否则"判据改坏了会红"这个结论谁也复现不了。两条一起钉 —— 既不许没入口，也不许进默认门禁。
package_json = read(ROOT / "package.json")
check(
    "check-background-mutations.py" in package_json,
    "package.json has no script entry for check-background-mutations.py — the harness would be an orphan",
)
check(
    "check-background-mutations.py" not in aggregate,
    "the mutation harness must not be wired into run-model-tests.sh: it rewrites sources and takes minutes",
)

# `RAI_MUTATION_FOR`（按改动范围裁剪）同样**成对**钉住 —— 它的失效方式是"静默的假绿"：
# 一次裁剪跑的产物若不带 `partial`，或者"选中 0 条"时不吭声，都会被读成"判据有效性已通过"。
# 三条都钉**源码锚点**（本文件既有手法）。宁可它脆一点，也不要它在没人注意时失效。
mutation_harness = read(TESTS / "check-background-mutations.py")
check(
    "RAI_MUTATION_FOR" in mutation_harness,
    "the mutation harness lost its scope filter (RAI_MUTATION_FOR) — every run silently goes full again",
)
check(
    '"partial": bool(selector or raw_scope)' in mutation_harness,
    "a scoped mutation run no longer marks its summary partial: the product would read as a full pass",
)
check(
    "NO MUTATION TOUCHES THE CHANGED FILES" in mutation_harness,
    "an empty scope must announce itself loudly; silence here reads as 'nothing to worry about'",
)

# --- 8. 客户端的上传失败码必须能在服务端源码里找到出处 ---------------------
#     为什么单列一节：`SyncUploadRecovery` 的第一版是凭记忆写的，四处全错
#     （`import_upload_busy` 判成 409、批次冲突的 code 编成了 `batch_conflict`、
#     漏了 507 与 `invalid_import_archive`）。这类"客户端自己发明一个服务端枚举"
#     的错法编译通过、测试也通过 —— 因为断言和常量出自同一个想象。
#     唯一能证伪它的是**把字面量拿去产出方源码里找**。
phase = read(RAI / "SyncPhase.swift")
server_sources = "\n".join(
    p.read_text(encoding="utf-8") for p in sorted((ROOT / "apps" / "api" / "src").rglob("*.ts"))
)

client_codes = set()
for name in ("busyCodes", "contentRejectionCodes"):
    parsed = swift_string_list(phase, name)
    check(bool(parsed), "could not parse %s from SyncPhase.swift" % name)
    client_codes |= parsed or set()

check(bool(client_codes), "SyncUploadRecovery declares no error codes at all")
for code in sorted(client_codes):
    check(
        '"%s"' % code in server_sources or "'%s'" % code in server_sources,
        "SyncUploadRecovery invents an error code the server never emits: %s" % code,
    )

# 反向：服务端这条端点上**真实存在**的判定码，客户端一个都不许漏。
# 服务端新增一个确定性的拒绝码时，这里会红 —— 那时要么补进上面两个集合，要么显式说明为什么不管。
UPLOAD_CONTRACT = {
    "invalid_sync_batch_id": 400,
    "invalid_import_archive": 400,
    "sync_batch_content_mismatch": 409,
    "import_upload_busy": 429,
}
for code, status in sorted(UPLOAD_CONTRACT.items()):
    check(
        '"%s"' % code in server_sources or "'%s'" % code in server_sources,
        "the pinned upload contract names %s, but the server source no longer contains it" % code,
    )
    check(
        code in client_codes,
        "the server emits %s (%d), but SyncUploadRecovery does not classify it" % (code, status),
    )

# 这批错误类的**状态码**单独钉死：判据要靠状态码兜底（5xx 的 code 会被抹掉），
# 所以"哪个 code 对应哪个状态码"是判据的一部分，不是注释的一部分。
for cls, expected in (
    ("ImportBatchConflictError", ["code = \"sync_batch_content_mismatch\"", "statusCode = 409"]),
    ("ImportUploadBusyError", ["code = \"import_upload_busy\"", "statusCode = 429"]),
    ("ImportArchiveTooLargeError", ["statusCode = 413"]),
):
    body = re.search(r"class %s extends Error \{(.*?)\n\}" % cls, server_sources, re.S)
    check(body is not None, "could not find class %s in the api sources" % cls)
    for needle in expected:
        check(
            body is not None and needle in body.group(1),
            "%s no longer declares %s — re-derive SyncUploadRecovery against the real contract" % (cls, needle),
        )

# 上传端点本身也必须还在：判据全都围着它转，端点改名而客户端不动是最容易漏的一种。
check(
    '"/v1/imports/uploads"' in server_sources,
    "the api no longer serves POST /v1/imports/uploads",
)
# 5xx 的 code 会被 `apiErrorPayload` 抹平 —— `SyncUploadRecovery` 必须靠状态码兜底，
# 这条前置一旦不成立，那边的注释与判据就同时过期了。
api_error = read(ROOT / "apps" / "api" / "src" / "api-error.ts")
check(
    "status >= 500" in api_error and "internal_error" in api_error,
    "apiErrorPayload no longer scrubs 5xx codes; SyncUploadRecovery's status-code fallback may be re-derived",
)

# --- 9. 后台三机制：注册时机、plist 与代码的跨文件一致、失败不许被吞 -------------
#     这三条的失效方式**全是静默的**，在代码里看不出任何问题：
#       - 注册晚于 `didFinishLaunching` 返回 ⇒ 之后每次 `submit` 都被系统拒绝；
#       - identifier 与 `Info.plist` 的 `BGTaskSchedulerPermittedIdentifiers` 不一致
#         ⇒ `register` 返回 false；
#       - 少 `UIBackgroundModes` 的 `processing` ⇒ `submit` 抛错；
#       - `submit` 用 `try?` 吞掉 ⇒ 后台永不执行，而日志干净得像什么都没发生。
#     前三条只能靠真机观测发现，所以在这里用**跨文件核对**把它们变成静态判据。
info_plist = parsed_plist(RAI / "Info.plist")
entitlements = parsed_plist(RAI / "RAI.entitlements")

# 9a. `BGProcessingTask` 需要 `UIBackgroundModes` 同时含 `processing`；
#     HealthKit 后台投递需要 `healthkit`。少任何一个的表现都是"机制从不被调度"。
background_modes = set(info_plist.get("UIBackgroundModes") or [])
for mode in ("healthkit", "processing"):
    check(
        mode in background_modes,
        "Info.plist UIBackgroundModes is missing %r (have %s)" % (mode, sorted(background_modes)),
    )

# 9b. identifier 只能有一个来源：`RaiBackgroundSync.taskIdentifier`。
#     这里做**双向**核对 ——
#       正方向：代码里的 identifier 必须在 plist 白名单里（否则 register 返回 false）；
#       反方向：plist 里不许留一个代码从不注册的 identifier（那种残留没有任何症状，
#               直到有人以为它生效）。
task_identifier = swift_string_constant(policy, "taskIdentifier")
check(
    task_identifier is not None,
    "RaiBackgroundSync.taskIdentifier is not a plain string constant, so it cannot be cross-checked",
)
permitted = set(info_plist.get("BGTaskSchedulerPermittedIdentifiers") or [])
if task_identifier is not None:
    check(
        task_identifier in permitted,
        "Info.plist BGTaskSchedulerPermittedIdentifiers does not list %r; register() would return false"
        % task_identifier,
    )
    check(
        permitted == {task_identifier},
        "Info.plist lists identifiers the code never registers: %s"
        % sorted(permitted - {task_identifier}),
    )

# 9c. background URLSession 的 identifier 与 BGTask 的必须不同（一个是"给几分钟 CPU"、
#     一个是"把这段字节搬完"，系统的记账单位不同；混用会让日志里两件事看起来是一件事）。
upload_identifier = swift_string_constant(policy, "uploadSessionIdentifier")
check(upload_identifier is not None, "RaiBackgroundSync.uploadSessionIdentifier is not a plain string constant")
if upload_identifier is not None and task_identifier is not None:
    check(
        upload_identifier != task_identifier,
        "the BGTask and the background URLSession share one identifier",
    )

# 9d. entitlements 必须含 HealthKit 后台投递。缺它的现象：`enableBackgroundDelivery`
#     回 `success == false`（这条有日志），但真机验收清单 A1 要求构建期就能查出来。
check(
    entitlements.get("com.apple.developer.healthkit") is True,
    "RAI.entitlements lost com.apple.developer.healthkit",
)
check(
    entitlements.get("com.apple.developer.healthkit.background-delivery") is True,
    "RAI.entitlements is missing com.apple.developer.healthkit.background-delivery; "
    "background delivery will be refused",
)

# 9e. 注册必须在 `didFinishLaunching` 返回**之前**完成，且**不能挪进 `Task { }`**。
launch_body = tail_after(app_delegate, "didFinishLaunchingWithOptions", "didFinishLaunchingWithOptions").split("\n    }\n")[0]
check(
    "RaiStartup.registerBackgroundTasks()" in launch_body,
    "didFinishLaunchingWithOptions does not call RaiStartup.registerBackgroundTasks()",
)
check(
    "Task {" in launch_body and "RaiStartup.registerBackgroundTasks()" in launch_body
    and launch_body.index("RaiStartup.registerBackgroundTasks()") < launch_body.index("Task {"),
    "BGTaskScheduler.register is now scheduled inside a Task; registering after launch completes "
    "makes every later submit fail",
)
# 注册点恰好一处：`RAIApp.swift` 被 `typecheck-ios.sh:102` 排除，逻辑写进去就没有门禁看得见。
check(
    app_delegate.count("registerBackgroundTasks()") >= 2 and "registerBackgroundTasks" not in app,
    "registerBackgroundTasks belongs in AppDelegate.swift (RAIApp.swift is excluded from type checking)",
)

# 9f. `submit` 失败必须留下痕迹（2026-09-10 项目健康审计的 P1-2 就是 `try?` 吞掉 submit 失败）。
check(
    "BGTaskScheduler.shared.submit(" in app_delegate or "shared.submit(" in app_delegate,
    "nothing ever submits a BGProcessingTaskRequest; background runs would never be scheduled",
)
check(
    re.search(r"try\?\s*[^\n]*\.submit\(", app_delegate) is None,
    "BGTaskScheduler.submit is wrapped in try? — a rejected submit would leave no trace",
)

# 9g. 报给系统的成败必须来自纯判据，不许写死；而且判据的输入必须是**这一轮按目标读到的快照**，
#     不是 `HealthKitSync` 上的展示标志（那个标志属于最后一次写它的那次同步）。
check(
    "BackgroundRunPolicy.reportedSuccess" in app_delegate,
    "setTaskCompleted(success:) is not decided by BackgroundRunPolicy.reportedSuccess",
)
check(
    "healthSync.hasPendingTask" not in without_comment_lines(app_delegate),
    "AppDelegate derives scheduling/receipt from the global display flag again — that flag belongs to "
    "whichever target wrote it last, so a single-flight-rejected round would be scored with someone "
    "else's result (and a run that could not read the journal would be reported as success)",
)
check(
    re.search(r"setTaskCompleted\(success:\s*(true|false)\s*\)", app_delegate) is None,
    "setTaskCompleted(success:) is hardcoded instead of derived from the remaining work",
)
# 9h. 收工时必须自己重排下一次：请求是一次性的，系统不会自动重试。
check(
    "BackgroundRunPolicy.shouldResubmit(" in app_delegate,
    "nothing re-submits after a background run, so an unfinished batch would wait for the user",
)
# 9i. 后台一轮必须走纯策略分流，不许直接调 `sync`。
check(
    "BackgroundRunPolicy.action(" in sync,
    "HealthKitSync.runBackgroundPass no longer consults BackgroundRunPolicy.action",
)
check(
    re.search(r"hasBackgroundUploadTask:\s*true", sync) is None,
    "HealthKitSync claims a system-owned upload while no background URLSession exists",
)
# 9i-bis. 🔴 软预算必须真的接在**后台轮询**上，而不是躺在测试里。
#     失效方式是静默的：`shouldYield` 只被回归调用时测试全绿，而生产里没人遵守预算 ——
#     报告 3.10 记的正是这一形态（"软预算被测试容易被误认为生产遵守预算"）。
#     另一半（只接在轮询上、且只在后台生效）由回归在纯函数 `shouldYieldPolling` 上分开钉住：
#     接到导出/上传会让 GB 级导出自断重来，漏掉 `isBackground` 会掐掉用户正看着的前台同步。
check(
    "BackgroundRunPolicy.shouldYieldPolling(" in sync,
    "HealthKitSync.waitForJob does not consume the background soft budget — the policy is left "
    "test-only, so production never yields inside the polling loop (audit 3.10)",
)

# 9j. 🔴 pbxproj 不许出现 `INFOPLIST_KEY_UIBackgroundModes` / `…BGTaskSchedulerPermittedIdentifiers`。
#     为什么：那两个键必须写进 **源文件** `RAI/Info.plist`。写进 pbxproj 的 `INFOPLIST_KEY_*`
#     会被 `pod install` 重写（它正是 pbxproj 的写入方），于是"加过又没了"。
pbxproj = read(IOS / "RAI.xcodeproj" / "project.pbxproj")
for key in ("INFOPLIST_KEY_UIBackgroundModes", "INFOPLIST_KEY_BGTaskSchedulerPermittedIdentifiers"):
    check(
        key not in pbxproj,
        "%s is in the pbxproj; pod install rewrites that file, so the key must live in RAI/Info.plist"
        % key,
    )

# --- 10. background URLSession（P2-4）：字节归系统之后，判据与清理都换了地方 -------
#     这一节的失效方式**全部**是静默的，而且没有一个会在编译期或类型检查里露头：
#       - 顺手写个 `defer { removeItem(multipart) }` ⇒ 函数一返回文件就没了，而"系统还要接着传"
#         这件事没有任何报错，只是某天起续传静悄悄变成重导；
#       - 顺手用 `DispatchGroup.wait()` 等 `getAllTasks` ⇒ 卡住**主线程**，卡多久由系统决定；
#       - 把"取消等结果"和"取消搬字节"合成一句 `task.cancel()` ⇒ 生命周期中止时把刚拿到手的
#         跨进程续传能力扔掉，而现象只是"后台传得慢"；
#       - 忘了 `handleEventsForBackgroundURLSession` 里的 `completionHandler()` ⇒ 系统认为这次
#         后台事件永远没处理完，**降低后续派发频率**。
#     这些都是"改错了照样编译通过、肉眼也看不出来"的形态，所以必须由静态判据钉住。
upload_session = read(RAI / "BackgroundUploadSession.swift")

# 10a. multipart 是续传的全部依据，函数返回不得删它。
reconcile_body = tail_after(
    sync,
    "private func upload(zipURL: URL, to serverURL: URL, payloadHash: String)",
    "upload() (reconcile)",
)
reconcile_body = reconcile_body.split("\n    private func ")[0]
check(
    "removeItem" not in reconcile_body,
    "upload() removes a local artifact on the way out — the system may still be sending those bytes",
)
check(
    "defer {" not in reconcile_body,
    "upload() has a defer block; the only thing it could be doing here is deleting the multipart "
    "that the background session still needs",
)

# 10b. `getAllTasks` 不许同步等：回调在 delegate 队列上，`DispatchGroup.wait()` 会卡主线程。
#      ⚠️ 判据只许看**代码行**：本文件的说明里逐字写着 `DispatchGroup.wait()`（解释为什么不用它），
#      用整段文本判会恒红 —— 恒红的门禁和没有门禁一样糟（`without_comment_lines` 的说明）。
check(
    "DispatchGroup" not in without_comment_lines(upload_session),
    "the background session waits synchronously for getAllTasks; that blocks the main thread",
)
check(
    "await withCheckedContinuation" in upload_session,
    "reattachOrphans does not await getAllTasks — a synchronous wait would block the main thread",
)

# 10c. 🔴「取消等结果」与「取消搬字节」必须是两件事。
check(
    "withTaskCancellationHandler" in upload_session,
    "upload() does not wire Task cancellation; a cancelled sync would hang on the continuation forever "
    "(performSync never returns → isBusy stays true → the single-flight gate rejects every later sync)",
)
check(
    "private func abandonWaiting(identifier: Int)" in upload_session,
    "abandonWaiting is gone; nothing would ever resume the awaiter when a sync is stopped, which is the same "
    "deadlock by another route",
)
# 切片以 `// MARK:` 收尾，不用"下一个函数声明"：`abandonWaiting` 之后紧跟的是 MARK 段，
# 用函数声明当锚点会一路吃到文件末尾，于是这条判据实际上在看整个文件（宽松到失去意义）。
abandon_body = tail_after(
    upload_session, "private func abandonWaiting(identifier: Int)", "abandonWaiting(identifier:)"
).split("\n    // MARK:")[0]
check(
    "cancel(" not in abandon_body,
    "abandonWaiting cancels the URLSessionTask; a lifecycle stop must stop *waiting*, not stop the transfer "
    "— that capability is the whole point of the background session",
)

# 10d. 重挂判据必须问「本进程还在等它吗」，不是「登记过没有」。
#     拿登记当判据，会让"生命周期中止之后重进一次同步"变成两份字节同时在传。
check(
    "BackgroundUploadReattach.disposition(" in upload_session,
    "reattachOrphans does not consult BackgroundUploadReattach.disposition",
)
check(
    "isAwaitedInThisProcess: isAwaited(" in upload_session,
    "reattachOrphans asks the wrong question: the judgement must come from `waiters` (who is still awaiting "
    "the outcome), not from `descriptions` (which the system may still be transferring after we gave up waiting)",
)

# 10e. 交付形态的判据必须住在**能被编译执行**的那一侧。`BackgroundUploadSession.swift` 被
#      `#if os(iOS)` 包住且要真实 URLSession 才跑得起来 ⇒ 判据放进它里面就只能靠人眼读。
check(
    "struct BackgroundUploadReattachReport" in policy and "struct BackgroundUploadReattachReport" not in upload_session,
    "BackgroundUploadReattachReport lives outside BackgroundSyncPolicy.swift — its derived values "
    "(foundAny) would then never be executed by any regression",
)

# 10f. 前台那条 `.ephemeral` 通道只许留在一个地方：`uploadToSystem` 的非 iOS 分支。
upload_to_system_body = tail_after(sync, "private func uploadToSystem(", "uploadToSystem(")
check(
    sync.count("session.upload(for: request, fromFile:") == 1
    and "session.upload(for: request, fromFile:" in upload_to_system_body,
    "HealthKitSync still uploads through the ephemeral foreground session somewhere other than the "
    "non-iOS fallback — that transfer dies the moment the process is suspended",
)
check(
    sync.count("uploadToSystem(") >= 2,
    "upload() no longer hands its bytes to the system",
)

# 10g. 三个调用点必须都在"推导下一步做什么"之前，且顺序不许颠倒。
perform_body = tail_after(sync, "private func performSync(", "performSync(").split("\n    private func ")[0]
check(
    "await reconcileSystemUploads(" in perform_body,
    "performSync never reconciles the system's uploads — it would then re-send bytes the system is still "
    "sending, and one of the two uploads must hit import_upload_busy (429)",
)
# 🔴 顺序判据必须先确认**两个**符号都在，否则它自己在 `index()` 上抛 `ValueError`：
# 门禁崩掉会让"这一条判据红了"变成"整个脚本没跑完"，后面所有检查一条都不执行 ——
# 而且崩溃的输出里没有 `FAIL:` 行，突变验证的 `assertion_hit` 于是永远为假。
# （这个形态是 2026-09-22 跑 `[P2-4]` 分段突变时被一条真突变暴露出来的。）
ordered(
    perform_body,
    "reconcileSystemUploads(",
    "SyncAtomicUnit.nextStep(",
    "performSync reconciles *after* deriving the next step: the derivation would see `.upload` while "
    "the system still owns those bytes",
)
background_pass = tail_after(sync, "private func performBackgroundPass(", "performBackgroundPass(").split("\n    private func ")[0]
check(
    "hasBackgroundUploadTask: systemUploadInFlight(" in background_pass,
    "runBackgroundPass no longer feeds the real 'system owns these bytes' signal into BackgroundRunPolicy",
)
enter_background = tail_after(sync, "func handleEnterBackground()", "handleEnterBackground()").split("\n    func ")[0]
check(
    "hasUploadTask:" in enter_background,
    "handleEnterBackground does not tell HealthSyncLifecycle whether the system owns the bytes",
)
# 10g-bis. 🔴 切后台时的"还有没有待办"必须来自**按目标现读的探针**，不能来自 `loadTask()`
#          —— 后者的判据是内存里的 `activeScope`，而切后台这一刻它可能还指向用户刚刚切走的
#          那个服务端（或者压根没绑定过）。
#          ⚠️ 这里**不**禁止 `loadTask()` 出现在本函数里：在飞那一趟的 `hasJobId` /
#          `hasUploadTask` 必须用它**自己**的上下文（同一函数里另取一个变量），禁掉会把
#          "正在传的这一批"判成"别的批"。所以判据是"标志必须由探针的结论赋值"。
check(
    "probePendingWork(for:" in enter_background,
    "handleEnterBackground asks the active context instead of probing the target: a switch of server "
    "URL would make the pending flag describe the previous target",
)
check(
    "pending?.hasUnfinishedWork" in enter_background,
    "handleEnterBackground no longer derives the pending flag from the probe snapshot — `.unknown` "
    "(read failure / unattributable row) would be reported as 'nothing pending'",
)
# 10g-ter. 🔴 探针本身必须是**只读**的：不改 `active*`、不迁移旧任务、不写/清日志行。
#          它一旦有副作用，"冷启动时看一眼"就会顺手改掉会话绑定。
probe_body = tail_after(sync, "func probePendingWork(", "probePendingWork(").split("\n    func ")[0]
check(
    re.search(r"\bactive(Scope|ServerURL|Identity|Token)\s*=", without_comment_lines(probe_body)) is None,
    "probePendingWork assigns an active* field — probing a target's pending work must not rebind the "
    "session to it",
)
check(
    "loadTask()" not in without_comment_lines(probe_body),
    "probePendingWork goes through loadTask(), which silently back-fills migrated task rows",
)
check(
    ".save(" not in without_comment_lines(probe_body)
    and "clearTask()" not in without_comment_lines(probe_body)
    and "removeTaskArtifacts" not in without_comment_lines(probe_body)
    and "reopenIfUnavailable()" not in without_comment_lines(probe_body),
    "probePendingWork writes, clears or deletes something — it is supposed to be a read-only snapshot",
)
# 10g-quater. 🔴 取消"有旧任务就合成新数据意图"。旧任务本身就是重试依据，而合成出来的意图
#             永远等不到确认（确认点只在导出起点），最终会变成一次多余的全量导出。
check(
    "recordBackgroundIntent" not in without_comment_lines(background_pass),
    "performBackgroundPass synthesizes a new-data intent again: an old task row is already the retry "
    "basis, and a synthesized intent can never be acknowledged by a resuming round, so it later turns "
    "into an extra export",
)

# 10h. 🔴 `uploadTaskId` 目前**没有**写入点，谁把它当判据谁就会拿到恒假 ⇒ 每轮唤醒都重传一遍。
check(
    re.search(r"\.uploadTaskId\s*==|\.uploadTaskId\s*!=\s*nil", sync) is None,
    "HealthKitSync reads uploadTaskId as a judgement; nothing ever writes it, so the answer is always "
    "'no system upload' and every wake-up re-sends the same batch",
)
check(
    "try updateTask(phase: .uploading, uploadState: .inFlight)" in sync,
    "upload() does not record 'these bytes are about to belong to the system' before handing them over",
)
ordered(
    sync,
    "try updateTask(phase: .uploading, uploadState: .inFlight)",
    "try await uploadToSystem(",
    "upload() hands the bytes over before recording that they are in flight — a kill in that window "
    "means the next wake re-sends them",
)

# 10i. 跨源重定向只能有一条判据：两条 URLSession 各写一份，等于"走了哪条路径"决定安不安全。
check(
    "RaiSameOrigin.allowsRedirection(" in upload_session,
    "the background upload session does not share RaiSameOrigin, so the two sessions can disagree",
)
check(
    "RaiSameOrigin.allowsRedirection(" in read(RAI / "APIClient.swift"),
    "RaiRedirectGuard no longer uses RaiSameOrigin — the two sessions now have separate redirect rules",
)

# 10j. 系统因为"后台上传有事发生"把 App 拉起来时，必须交出完成回调。
check(
    "handleEventsForBackgroundURLSession" in app_delegate,
    "RaiAppDelegate does not implement handleEventsForBackgroundURLSession; upload events would go unhandled "
    "and the system would reduce how often it dispatches them",
)
handle_events = tail_after(
    app_delegate,
    "handleEventsForBackgroundURLSession identifier: String,",
    "handleEventsForBackgroundURLSession",
).split("\n    /// ")[0]
# 早退分支（identifier 不对）**必须自己**回调：那条路不会建 session，所以 `urlSessionDidFinishEvents`
# 永远不会被调到 —— 把 completion 留在手里等于系统永远收不到回执。
unknown_branch = tail_after(handle_events, "guard identifier ==", "the unknown-identifier branch").split(
    "return\n"
)[0]
check(
    "completionHandler()" in unknown_branch,
    "the unknown-identifier branch of handleEventsForBackgroundURLSession returns without calling "
    "completionHandler(); the system would count this background event as never handled",
)
check(
    "storeSystemCompletion(completionHandler)" in handle_events,
    "handleEventsForBackgroundURLSession does not hand the completion to the session, so "
    "urlSessionDidFinishEvents would never fire it",
)
ordered(
    handle_events,
    "makeSession()",
    "storeSystemCompletion(",
    "the system completion is stored before the session exists — completion events would have no delegate",
)

# 10k. 门禁自己不许变成孤儿（这已经是本仓第三次同一个形态）。
# ⚠️ 2026-09-23 补：原先这份名单只有 P2 那两个文件，而后来新增的两个回归文件
# （`HealthSyncBlockedRecoveryRegression` / `SyncStateCommitRegression`）**不在里面** ——
# 也就是说"把新回归从 runner 里摘掉"是静默的：文件还在、门禁全绿、那一组不变式再没人执行。
# 判据是"被 runner 编译并执行"，所以名单必须跟着新增的回归文件一起长。
for required in (
    "BackgroundSyncPolicy.swift",
    "BackgroundSyncPolicyRegression.swift",
    "HealthSyncBlockedRecoveryRegression.swift",
    "SyncStateCommitRegression.swift",
    # 2026-09-23 补（按 workout 定频）：这两条同样是"文件在、门禁全绿、那一组判据却没人执行"
    # 的形态。`RouteSyncStateMachineTests` 守的是四态判据本身，`RouteSyncStatePersistenceRegression`
    # 守的是它唯一的住处（真库上的单事务批量写）。
    "RouteSyncStateMachineTests.swift",
    "RouteSyncStatePersistenceRegression.swift",
):
    check(
        required in runner,
        "run-health-sync-tests.sh does not compile/run %s — a regression file that exists but is "
        "never executed is the purest form of a silent pass" % required,
    )

# --- 11. 验收判据的载体自己也要有守卫 ---------------------------------------------
# 为什么要有这一节（2026-09-22 实测的直接原因）：V2/V3 的判据是「控制台里出现某一行」，
# 而在补这几行日志之前，成功路径**完全静默** —— 于是「机制没被调度」与「调度了但这一轮
# 什么都没做」在服务端看是同一件事（都没有请求），§11.3 那张归因表根本无从判起。
# ⇒ 这几行日志**就是判据本身**。没有守卫的话，谁顺手删掉一行，V2/V3 就静悄悄变回不可判，
#   而门禁、类型检查、回归会照旧全绿（同族教训："我加了门禁" ≠ "门禁盖住了每一条"）。
# 用 `without_comment_lines`：源码与本文件的注释里逐字提到了这些字符串，
# 拿整段文本判会恒绿（该助手的说明里写着这个坑）。
delegate_code = without_comment_lines(app_delegate)
sync_code = without_comment_lines(sync)
for literal, carrier, why in (
    (
        'RaiStartup.report("BGProcessingTask launched',
        delegate_code,
        "V2「系统真的把 BGTask 派发下来了」的唯一直接证据",
    ),
    (
        'RaiStartup.report("BGProcessingTask expiration fired',
        delegate_code,
        "V3「系统收走额度时不许写 cancelled」的触发点判据",
    ),
    (
        'Self.report("background pass: action=',
        sync_code,
        "区分「没被派发」与「派发了但空转」的唯一入口",
    ),
):
    check(
        literal in carrier,
        "%s 这行日志不见了 —— 它是%s的载体，删掉它会让那条真机验收静默变成不可判" % (literal, why),
    )

# --- 12. 锁屏 / 凭证阻塞（V2.1 规范 §3.3 与 §3.4）-----------------------------
#     这一节的失效方式**全部**是静默的，而且会互相掩护：
#       - 没有 `isProtectedDataAvailable` 预检查 ⇒ 要等第一次查询失败才发现，而更早的
#         `readAuthorizationState()` 在锁屏时返回 `.unknown`，于是先落一个 `failed`
#         （一次正常锁屏被报成"同步失败"，且解锁后不会自己恢复）；
#       - 没有解锁恢复 ⇒ `deferred_protected_data` 是个**死状态**：解锁后什么都不会发生；
#       - 有恢复但没有判据 ⇒ 每次解锁都白读一次 HealthKit（整个流程里最贵的一步）；
#       - 兜底 catch 覆盖更具体的结论 ⇒ 上面三条一起白做（阻塞态被抹成 `failed`）；
#       - 401 落进默认的 `keepForNextWake` ⇒ 后台每次唤醒撞一次同样的 401，永远好不了。
#     ⚠️ 判据一律看**代码行**（`sync_code` / `delegate_code`）：本次改动的注释里逐字写满了
#     这些符号名，拿整段文本判会恒绿 —— 恒绿的门禁和没有门禁一样糟（`without_comment_lines`）。

# 12a. 两个阻塞阶段的 rawValue 必须与 §3.1 状态机表逐字一致（蛇形），并收进 `SyncPhase.blocked`。
enum_text = enum_body.group(1) if enum_body else ""
for swift_case, raw in (
    ("deferredProtectedData", "deferred_protected_data"),
    ("authRequired", "auth_required"),
):
    check(
        re.search(r"case\s+%s\s*=\s*\"%s\"" % (swift_case, raw), enum_text) is not None,
        'SyncPhase does not declare `case %s = "%s"`; the blocked phase set is incomplete'
        % (swift_case, raw),
    )
check(
    re.search(r"static let blocked: Set<SyncPhase> = \[\.deferredProtectedData, \.authRequired\]", phase_src)
    is not None,
    "SyncPhase.blocked is no longer exactly the two blocked phases — a second definition of "
    "'what counts as blocked' has appeared, which is how this repository's worst defects start",
)
check(
    re.search(r"static func mayAdvanceAnchor", phase_src) is not None,
    "SyncPhase.mayAdvanceAnchor is gone; nothing then expresses 'a blocked sync must never "
    "advance the anchor' (§3.4 bans exactly that)",
)
check(
    "mayAdvanceAnchor" in read(RAI / "HealthSyncBlockedRecovery.swift"),
    "HealthSyncBlockedRecovery no longer forwards mayAdvanceAnchor — the invariant would lose "
    "its executor (HealthKitSync.swift is compiled by no regression)",
)

# 12b. 锁屏预检查：判据只有一个来源，且必须真的被用上。
check(
    "private static var isProtectedDataAvailable" in sync_code,
    "HealthKitSync has no single `isProtectedDataAvailable` source; the pre-check and the "
    "background skip could then disagree about what 'locked' means",
)
check(
    "UIApplication.shared.isProtectedDataAvailable" in sync_code,
    "nothing reads UIApplication.isProtectedDataAvailable — a locked device burns a whole "
    "HealthKit attempt before failing",
)
check(
    "if !Self.isProtectedDataAvailable" in sync_code,
    "HealthKitSync never acts on isProtectedDataAvailable; the lock-screen pre-check is gone",
)
check(
    'Self.report("background pass: skipped, waiting on an external condition' in sync_code,
    "runBackgroundPass no longer skips a blocked phase; a locked device and a stale credential "
    "would each get a doomed attempt every 15 minutes",
)

# 12c. 解锁恢复链路：缺任何一环，`deferred_protected_data` 就是死状态。
check(
    "protectedDataDidBecomeAvailableNotification" in delegate_code,
    "nothing observes protectedDataDidBecomeAvailable; a sync stopped by the lock screen would "
    "never resume on its own (§3.1's deferred_protected_data -> queued edge would be dead)",
)
check(
    "RaiStartup.observeProtectedDataAvailability()" in delegate_code,
    "observeProtectedDataAvailability is never called, so the observer is never installed",
)
check(
    "HealthSyncBlockedRecovery.shouldResume(" in delegate_code,
    "the unlock handler does not consult HealthSyncBlockedRecovery.shouldResume; every unlock "
    "would then trigger a sync and re-read HealthKit",
)

# 12d. 两个阻塞阶段都必须有**写入点**。声明了却没人写 = 这条路径不可达（回归也测不到）。
for reason in (".protectedData", ".credential"):
    check(
        "HealthSyncBlockedRecovery.phase(for: %s)" % reason in sync_code,
        "HealthKitSync never records the blocked phase for %s; that state exists in the enum but "
        "nothing produces it, so the whole path is unreachable" % reason,
    )

# 12e. 🔴 兜底 catch 不许覆盖更具体的结论（本仓复发最多的形态：兜底吃掉特例）。
check(
    ".databaseLocked" in sync_code,
    "HealthKitSync does not recognise HealthKitExportError.databaseLocked; the catch-all would "
    "overwrite the lock-screen conclusion with `failed`",
)
check(
    "SyncCredentialRequiredError" in sync_code,
    "HealthKitSync does not recognise SyncCredentialRequiredError; a 401 would be reported as `failed`",
)
check(
    "SyncUploadRecovery.isCredentialFailure(" in sync_code,
    "uploadWithRecovery no longer asks whether the failure was a credential failure; a 401 would "
    "fall through to keepForNextWake and be retried on every single wake",
)

# 12f. 「哪个错误算锁屏」必须走 `HKError.Code`，不许硬编码码元 ——
#      写死数字的失效方式是静默的，而且症状恰好是"又把它当成空数据了"（§3.4 点名禁止的形态）。
health_export = read(RAI / "HealthKitExport.swift")
check(
    "HKError.Code.errorDatabaseInaccessible" in health_export,
    "HealthKitExport does not compare against HKError.Code.errorDatabaseInaccessible; a hardcoded "
    "code would silently stop matching and the export would treat 'locked' as 'no data'",
)
check(
    "case databaseLocked" in health_export,
    "HealthKitExportError has no databaseLocked case, so callers cannot tell 'cannot read right "
    "now' apart from 'the data is broken'",
)

# 12g. 凭证失败的状态码必须与 §3.3 一致，且**不许**并进"确定性拒绝"那一组
#      （并进去会 abandonBatch 删掉一份完好的批次，用户修好凭证还得重读 HealthKit）。
credential_block = re.search(r"credentialFailureStatuses[^=]*=\s*\[(.*?)\]", phase_src, re.S)
check(credential_block is not None, "SyncPhase.swift no longer declares credentialFailureStatuses")
if credential_block is not None:
    credential_codes = set(re.findall(r"\d+", credential_block.group(1)))
    check(
        credential_codes == {"401", "403"},
        "SyncUploadRecovery.credentialFailureStatuses is %s; §3.3 pins 401/403 as the 'the channel "
        "is broken, the bytes are fine' failures" % sorted(credential_codes),
    )
    rejection_block = re.search(r"contentRejectionStatuses[^=]*=\s*\[(.*?)\]", phase_src, re.S)
    if rejection_block is not None:
        check(
            not credential_codes & set(re.findall(r"\d+", rejection_block.group(1))),
            "the credential failures are also listed as content rejections — a perfectly valid "
            "batch would be deleted on a 401",
        )

# 12h. 阻塞判据自己要有执行者（本仓第三次同一个形态：判据写在没有执行者的文件里）。
check(
    "HealthSyncBlockedRecovery.swift" in runner,
    "run-health-sync-tests.sh does not compile HealthSyncBlockedRecovery.swift — its judgements "
    "would then never be executed by any regression",
)
check(
    "HealthSyncBlockedRecoveryRegression.swift" in runner,
    "run-health-sync-tests.sh does not run HealthSyncBlockedRecoveryRegression.swift",
)

# --- 13. 门禁自己：判据的**载体**也要有守卫 ------------------------------------
# 为什么单列一节（2026-09-23 实测）：这一节修的不是"某条判据写错了"，而是"判据会静默消失"。
# 载体坏了，内容判据写得再好也读不到 —— 这正是本仓那条原始纪律的翻版：
# **静默跳过的门禁比没有门禁更糟**。

# 13a. 判据总数的下限断言在**文件末尾** —— 它必须跑在全部判据之后，否则数的是中间态。

# 13b. 门禁自己不许再出现"锚点不命中就退化成整文件"的写法。
#      `tail_after()` / `ordered()` 存在之后，任何 `<变量>.split(<字面量>)` 的**赋值**形态都是
#      回归 —— 它在锚点改名时会安静地把整份文件当成函数体。
own_source = Path(__file__).read_text(encoding="utf-8")
#      注意判据只抓**危险形态**：`= <变量>.split(<字面量>)[-1]`（取最后一段 = 不命中时退化成
#      整份文件）。`tail_after(...).split("\n    private func ")[0]` 那种"在已守卫的切片里再切
#      到下一个声明"是安全的，不能一起禁掉。
check(
    re.search(r"=\s*\w+\.split\([^\n]*\)\[-1\]", own_source) is None,
    "check-background-capabilities.py slices a body with `= <var>.split(<literal>)[-1]` again — "
    "when that literal stops matching, the slice silently becomes the whole file and every "
    "judgement made on it becomes vacuously true (use tail_after/ordered)",
)
for helper in ("def tail_after(", "def ordered("):
    check(helper in own_source, "check-background-capabilities.py lost its %s helper" % helper.strip("def ()"))

# --- 14. 「成功收尾」的单事务提交（V2.1 §2 原则 3「单状态源真相」） --------------
# 这一节钉的是**写入路径**：`SyncPhase.mayAdvanceAnchor` 此前零生产调用点（只有定义、
# 一次转发、一条自比式回归），而 anchor 写入点是一条无条件的 `UserDefaults.set`。
# 判据（`SyncStateCommitPlan.mayCommit`）与落盘（`SyncTaskStore.commitSuccess`）分居两个
# 文件是对的，但"判据有没有挂在写入点上"只能在调用侧钉住 —— 也就是这里。

store_src = read(RAI / "SyncTaskStore.swift")
plan_src = read(RAI / "SyncStateCommitPlan.swift")

# 14a. anchor 不许再直接写进 `UserDefaults`：它是两套真相的来源。
check(
    re.search(r"UserDefaults\.standard\.set\(\s*(anchor|exportEnd|lastExportEnd)", sync) is None,
    "HealthKitSync still writes the anchor / export watermark straight into UserDefaults — "
    "that is the two-sources-of-truth shape §4.2 exists to remove",
)
# 反方向也要钉：老键必须**只被删**、且在提交成功之后删 —— 迁移期回退读的正是它们。
check(
    sync.count("removeObject(forKey: scopedKey(Self.lastWorkoutAnchorKey))") == 2
    and sync.count("removeObject(forKey: scopedKey(Self.lastExportEndKey))") == 1,
    "the legacy UserDefaults keys must be removed in exactly the two migration points "
    "(full re-import + a successful commit); found %d anchor / %d watermark removals"
    % (
        sync.count("removeObject(forKey: scopedKey(Self.lastWorkoutAnchorKey))"),
        sync.count("removeObject(forKey: scopedKey(Self.lastExportEndKey))"),
    ),
)

# 14b. 唯一的读取点。锚/水位的读者必须都走 `loadCommittedState()` —— 漏改一处就静默分裂。
check(
    "UserDefaults.standard.data(forKey: scopedKey(Self.lastWorkoutAnchorKey))" in sync
    and sync.count("UserDefaults.standard.data(forKey: scopedKey(Self.lastWorkoutAnchorKey))") == 1,
    "the legacy anchor must be read in exactly one place (loadCommittedState's migration fallback)",
)
check(
    sync.count("loadCommittedState()") >= 2,
    "loadCommittedState() is defined but never consulted — the anchor/watermark readers "
    "would then still be reading UserDefaults directly",
)

# 14c. anchor 的写入必须被不变式守卫：`mayCommit` 的判断要出现在提交之前。
#      ⚠️ 这一条只钉**顺序**，不钉**语义** —— 结构门禁读不出"`mayCommit` 返回什么"。
#      语义的执行者是可跑的回归 `SyncStateCommitRegression.swift`（对 `SyncPhase.allCases`
#      逐条比 `mayCommit` 与 `isBlocked`）。2026-09-23 实测：把 `mayCommit` 的转发改成 `true`，
#      本门禁**照样绿**，而回归报
#      `Precondition failed: mayCommit disagrees with isBlocked at deferred_protected_data`。
#      ⇒ 两条都要有：少任何一条都留下一个"静默通过"的方向。
commit_body = tail_after(sync, "private func markSuccess(", "markSuccess(").split("\n    private func ")[0]
ordered(
    commit_body,
    "SyncStateCommitPlan.mayCommit(",
    "taskStore.commitSuccess(",
    "markSuccess writes the committed state before checking `mayCommit` — a blocked sync "
    "(locked screen / waiting for credentials) would then advance the export watermark and the "
    "data it never read would never be exported again",
)
check(
    "phase = SyncPhase.failed.rawValue" in commit_body,
    "markSuccess refuses a blocked commit without recording a failure state — the refusal would "
    "then be indistinguishable from 'nothing happened'",
)

# 14d. 水位只能由那一个事务写。`INSERT INTO sync_state` 只许出现一次（提交的 UPSERT），
#      且必须在 `BEGIN IMMEDIATE` 与 `COMMIT` 之间 —— 而它住在 `upsertState()` 里，
#      所以判据要分两层钉：调用方先开事务，被调方**不许自己再开一个**。
check(
    store_src.count("INSERT INTO sync_state") == 1,
    "SyncTaskStore writes sync_state from %d places; it must be exactly one (the commit's UPSERT) — "
    "a second writer reintroduces the two-step split" % store_src.count("INSERT INTO sync_state"),
)
commit_store = tail_after(store_src, "func commitSuccess(", "SyncTaskStore.commitSuccess").split(
    "\n    private func "
)[0]
upsert_store = tail_after(store_src, "private func upsertState(", "SyncTaskStore.upsertState").split(
    "\n    private func "
)[0]
ordered(
    commit_store,
    "BEGIN IMMEDIATE",
    "upsertState(",
    "commitSuccess writes the watermark before BEGIN IMMEDIATE — it would then be a separate "
    "transaction from the task-row delete, which is exactly the window §4.2 removes",
)
ordered(
    commit_store,
    "upsertState(",
    '"COMMIT"',
    "the watermark write is not committed inside the same function that deleted the task row",
)
check(
    "INSERT INTO sync_state" in upsert_store,
    "the only sync_state write no longer lives in upsertState() — this judgement would then be "
    "guarding the wrong function",
)
check(
    "BEGIN" not in upsert_store and "COMMIT" not in upsert_store,
    "upsertState() opens or commits its own transaction — the watermark write must inherit the "
    "caller's transaction, otherwise it is a separate commit again",
)
check(
    "readBackMatches(" in commit_store,
    "commitSuccess no longer reads its own write back before COMMIT — a silently ignored write "
    "would leave a stale anchor with no task row and still report success",
)
check(
    store_src.count("sqlite3_changes(") >= 2,
    "commitSuccess no longer verifies `sqlite3_changes()` — an UPSERT that touched 0 rows and a "
    "DELETE that removed 0 rows both look like success otherwise",
)
# 14d-2. 只数**调用次数**是不够的：`guard removed >= 0` 这种恒真比较同样"调用了 `changes()`"，
#        却把"删掉 0 行"重新变回成功。
#        🔴 2026-09-23 实测：把 `removed == 1` 改成 `removed >= 0`，上面那条判据**照样绿**
#        （185 checks / 0 failed）—— 所以判据必须落在**比较值**上，而不是函数名上。
check(
    re.search(r"guard removed == 1 else", commit_store) is not None,
    "the task-row DELETE in commitSuccess no longer requires exactly one removed row — a commit "
    "that deleted nothing would read as success and the watermark would advance with no task row",
)
check(
    re.search(r"guard touched == 1 else", upsert_store) is not None,
    "upsertState no longer requires exactly one touched row — `sqlite3_changes()` is still called, "
    "so a presence-only judgement cannot see this weakening",
)

# 14f. 回读断言比的是**应该写成的值**，不是"请求的值"。后者会把单调 no-op 判成写入失败：
#      请求一个更早的水位时正确结果是"提交成功、值停在更晚的那个"，拿请求值去比会让一次
#      本该成功的同步报错回滚，下次唤醒再重导一遍。
read_back = tail_after(store_src, "private func readBackMatches(", "SyncTaskStore.readBackMatches")
check(
    "guard written.workoutAnchor == expectedAnchor else" in read_back,
    "readBackMatches no longer compares the anchor it just read back against the expected value — "
    "a silently ignored anchor write would then pass the in-transaction assertion",
)
check(
    "max($0, requested)" in read_back,
    "readBackMatches compares the watermark against the requested value instead of the monotonic "
    "one — a legitimate `.advance` to an earlier date then looks like a failed write and rolls back",
)

# 14e. 「重新导入全部」必须把**两处**都清掉。只清老键 ⇒ `loadCommittedState` 会把锚读回来。
full_block = re.search(r"if full \{(.*?)\n            \}", sync, re.S)
check(full_block is not None, "could not find the `if full` re-import block in performSync")
if full_block is not None:
    check(
        "forgetState(" in full_block.group(1),
        "a full re-import clears the legacy anchor key but not the committed state row — "
        "loadCommittedState would read the old anchor straight back and the sync would keep "
        "taking only the delta while the UI claims everything was re-imported",
    )

# 14f. `clearExportWatermark()` 必须已经并进提交。留着它就还有"清空了水位、任务行没动"的窗口。
#      必须先剥注释行：本节的说明与 `markSuccess` 的文件注释里逐字写着这个名字。
check(
    "clearExportWatermark()" not in without_comment_lines(sync),
    "HealthKitSync still calls clearExportWatermark() separately from the commit — the watermark "
    "and the task row would then be written by two different steps again",
)

# 14g. §4.4 的 14 天回填窗口：数值可以改，但**必须只有一个定义、且被回填分支引用**。
#      此前 `routeBackfillWindow` 在任何测试/门禁/突变里都不出现 ⇒ 改成 30 天不会红。
#
#      ⚠️ 2026-09-23 语义变更（按 workout 定频）：这个窗口的作用从"**查询**哪些 workout 的
#      轨迹"收窄成"**发现**哪些 workout"。也就是说它现在只决定"这一轮把哪些 workout 放进
#      候选集"，真正的查询由 `RouteSyncStateMachine.shouldQuery` 逐个决定（见 14h）。
#      窗口本身**必须保留**：一条很久以前跑完、状态早已 `settled` 的老 workout 一旦滑出窗口，
#      这一轮就根本不会看到它，于是"它到底还稳不稳定"永远无从复核；留着窗口＝每轮都复核一遍
#      "这批老的还是不是 settled"，而复核本身不再花任何 HealthKit 查询。
window_defs = re.findall(r"let routeBackfillWindow: TimeInterval = ([^\n]+)", health_export)
check(
    len(window_defs) == 1,
    "the route backfill window is defined %d times; it must be one constant so the window's "
    "meaning has a single home" % len(window_defs),
)
if len(window_defs) == 1:
    check(
        "routeBackfillWindow" in health_export.split("let routeBackfillWindow")[1],
        "routeBackfillWindow is defined but never referenced — the backfill would silently "
        "stop happening while the constant still reads as if it were in force",
    )
check(
    "routeBackfillWindow" in health_export.split("if stored != nil")[-1],
    "the anchored-sync backfill branch no longer uses routeBackfillWindow; the window would then "
    "be hardcoded somewhere else and this judgement would stop covering it",
)

# 14h. Workout 伴生 Route 状态机（按 workout 定频，取代固定 14 天全量回填）。
#
#      这一节判的全是"改错了照样编译通过、肉眼也看不出来"的形状。它们每一条的失效都不会报错、
#      不会崩、回归也可能全绿，只会让**收益归零**或让**数据静默丢在服务端之外**：
#        · 状态被塞进 `UserDefaults` / 一个 JSON 文件 / 内存单例 ⇒ 又回到"两套真相"；
#        · 循环里忘了用 `shouldQuery` 过滤 ⇒ 降频收益归零，而门禁与回归全绿；
#        · 记忆在**水位提交之前**落盘 ⇒ 一次从未交付的同步也被记成"这条轨迹已经稳定"，
#          之后一路降到 `settled`，而 `settled` 只有人工重扫能唤醒 ⇒ 服务端永远收不到它；
#        · manifest 不再声明 healthkit ⇒ 省略 GPX 从"保留"变成"删除"。
#
#      这台机器自身的判据在 `RouteSyncStateMachineTests.swift`（35 条）与
#      `RouteSyncStatePersistenceRegression.swift`（35 条）；本节只判**接线**。
route_state_src = read(RAI / "RouteSyncState.swift")
route_machine_src = read(RAI / "RouteSyncStateMachine.swift")
store_src = read(RAI / "SyncTaskStore.swift")

check(
    "CREATE TABLE IF NOT EXISTS sync_route_state" in store_src,
    "sync_route_state is not created in the sync journal — a memory column that does not exist "
    "would have to live somewhere else (UserDefaults / a JSON file / an in-memory singleton), "
    "which is precisely the two-sources-of-truth shape the watermark was moved out of",
)
check(
    "CREATE INDEX IF NOT EXISTS idx_route_status_cooling" in store_src,
    "the cooling-throttle index is gone — nothing then pins the (route_status, last_checked_at) "
    "shape that the throttled lookup assumes, and the query degrades to a full scan",
)
check(
    "UserDefaults" not in route_state_src and "UserDefaults" not in route_machine_src,
    "the route state types or the state machine mention UserDefaults — the down-frequency memory "
    "must have exactly one home (the sync journal), not a second one outside it",
)
check(
    "func loadRouteStates(" in store_src,
    "the sync journal no longer exposes loadRouteStates — the pipeline could not read the memory "
    "back at all, so every workout would look like a first observation forever",
)
check(
    "func upsertRouteStates(" in store_src,
    "the sync journal no longer exposes upsertRouteStates — nothing would ever record what the "
    "state machine decided",
)
check(
    "route_hash TEXT" in store_src,
    "route_hash changed column type or vanished. If it became a BLOB, the bind must move INSIDE "
    "the withUnsafeBytes closure (ADR-004 补充 B): binding a baseAddress that escaped its scope "
    "writes indeterminate content, which surfaces as an in-transaction read-back mismatch and a "
    "rolled-back commit — not as a crash",
)

# 单事务批量写：三件护栏必须都在写入路径上（与 `commitSuccess` 同源）。
upsert_body = tail_after(store_src, "func upsertRouteStates(", "upsertRouteStates(")
upsert_body = upsert_body.split("\n    private func ")[0]
check(
    "BEGIN IMMEDIATE" in upsert_body,
    "the route state batch is no longer wrapped in BEGIN IMMEDIATE — a half-written batch makes "
    "the route set of the next payload depend on where the previous write stopped",
)
check(
    "ROLLBACK" in upsert_body,
    "the route state batch has no rollback path — a failed row would leave the earlier rows of "
    "the same batch committed",
)
check(
    "sqlite3_changes(" in upsert_body,
    "the per-row changes() check is gone from the route state batch — an UPSERT that touches zero "
    "rows reads exactly like success",
)
check(
    "loadRouteStates(scope: scope, uuids:" in upsert_body,
    "the pre-COMMIT read-back assertion is gone from the route state batch — 'I wrote it' would "
    "again be an assumption rather than something the transaction verified",
)

# 14h-2. 🔴 落盘前必须把时间点吸附到「REAL 列能逐位往返」的那一个值上。
#
#  2026-09-24 真机故障：`Date` 内部存 `timeIntervalSinceReferenceDate`，列里存
#  `timeIntervalSince1970`，两者差常量 978307200 —— 这个映射**不是双射**。实测逐 ulp 扫
#  200,000 个真实时间戳，**恰好一半在往返后丢了最低位**（整秒时间戳 0/200000 有损，
#  这也正是那批回归此前全绿的原因）。生产路径上 `exportedThrough = Date()` 与
#  `routeNow = Date()` 都带完整小数秒 ⇒ 回读断言拿**原始 Date** 去比读回来的 Date，
#  约一半概率判不等 ⇒ 一次完全成功的提交被整段回滚，用户看到
#  「同步水位写入后无法读回一致的值」。
#
#  判据必须钉在**写入路径的调用点**上：只在 `canonicalForREAL` 的定义处断言（"函数存在"）
#  是不够的 —— 把调用点删掉，定义还在，故障照样回来。
check(
    "requested.storedInREAL" in commit_store,
    "commitSuccess no longer canonicalizes the watermark before writing it — a Date that cannot "
    "survive the REAL round trip then fails its own in-transaction read-back and rolls the whole "
    "commit back, surfacing to the user as 「同步水位写入后无法读回一致的值」",
)
check(
    "canonicalForREAL" in upsert_body,
    "upsertRouteStates no longer canonicalizes the route timestamps — its read-back assertion "
    "compares whole RouteSyncRecord values, so one Date() that loses a bit in the REAL round trip "
    "fails the entire batch",
)
check(
    "var canonicalForREAL: Date" in store_src or "var canonicalForREAL: Date" in plan_src,
    "Date.canonicalForREAL is gone — the REAL round trip is not a bijection (measured: half of "
    "200,000 real timestamps lose a bit), so both read-back assertions depend on it",
)

# 管线：真的在用状态机过滤，而且**先判后查**。
route_loop = tail_after(
    health_export,
    "for (index, workout) in workouts.enumerated() {",
    "the per-workout route loop",
)
route_loop_end = 'await onProgress("正在读取心率与恢复数据")'
if route_loop_end in route_loop:
    route_loop = without_comment_lines(route_loop.split(route_loop_end)[0])
else:
    check(
        False,
        "the per-workout loop is no longer followed by the global-records progress step — the "
        "slice below would then be bigger than the loop itself and the judgements against it "
        "could pass vacuously",
    )
    route_loop = ""

check(
    "RouteSyncStateMachine.shouldQuery(" in route_loop,
    "the per-workout loop no longer consults the state machine — the 14-day backfill is "
    "unconditional again, every route is re-read on every sync, and no gate notices",
)
ordered(
    route_loop,
    "RouteSyncStateMachine.shouldQuery(",
    "routeEntries(",
    "the route query happens BEFORE the state machine is consulted — the filter has to decide "
    "first, otherwise the saving is exactly zero while every gate stays green",
)
check(
    "fetch.observation" in route_loop,
    "the observation returned by routeEntries is dropped on the floor — the state machine would "
    "never learn what it saw, so stable_check_count could never advance and nothing would ever "
    "slow down",
)
check(
    "RouteSyncStateMachine.decide(" in route_loop,
    "the loop queries routes but never asks the machine what the new state should be — the memory "
    "would stay frozen at its first value",
)
check(
    route_loop.count("routeDecisions[") == 1,
    "the loop records the decided state in %d places; there must be exactly one, so that the "
    "skip branch provably writes nothing" % route_loop.count("routeDecisions["),
)
check(
    "routeFiles = []" in route_loop,
    "the skip branch no longer explicitly produces no route files — it would fall through with "
    "whatever routeFiles held, i.e. either a stale value or a compile error",
)

# 14h-3. settled 是低频重新发现，不是永久终止；历史候选必须有界且能跨过不可读 UUID。
check(
    "(HKSeriesType.workoutRoute(), nil)" in sync,
    "route-only arrivals never reach the existing observer/background-intent pipeline",
)
check(
    "RouteSyncStateMachine.rediscoveryCandidates(" in health_export,
    "the periodic policy has no exporter caller — routes outside the recent window stay lost",
)
check(
    "rediscoveryIDs.contains(routeKey)" in route_loop,
    "recent settled workouts bypass the rediscovery batch budget",
)
check(
    route_loop.count("hasWorkoutChange: hasWorkoutChange") == 2,
    "anchored workout changes must bypass throttling both when planning and recording the observation",
)
check(
    "if let observation = fetch.observation" in route_loop,
    "a failed/partial route query must not write an empty observation or stability evidence",
)
historical_fetch = tail_after(health_export, "private static func knownRunningWorkouts(", "knownRunningWorkouts(")
historical_fetch = historical_fetch.split("\n    private static func ")[0]
check(
    "HKQuery.predicateForObjects(with: ids)" in historical_fetch
    and "predicateForSamples" not in historical_fetch,
    "historical rediscovery must fetch only planned workout UUIDs, not a date window or all history",
)
check(
    "CREATE TABLE IF NOT EXISTS sync_route_discovery" in store_src
    and "func loadRouteDiscoveryCursor(" in store_src,
    "the bounded queue has no persisted scope-local cursor; unreadable early UUIDs could starve later ones",
)
check(
    "loadRouteDiscoveryCursor(scope: activeScope)" in sync
    and "routeDiscoveryCursor: routeDiscoveryCursor" in sync,
    "the exporter never receives the persisted traversal position",
)
check(
    sync.count("routeDiscoveryCursor: exported.routeDiscoveryCursor") == 2,
    "both normal-import and unchanged success must advance the rediscovery queue",
)
check(
    "pendingRouteDiscoveryCursor: exported.routeDiscoveryCursor" in sync
    and sync.count("routeDiscoveryCursor: restored.pendingRouteDiscoveryCursor") == 4,
    "interrupted uploads must persist the traversal position and advance it in every resumed-success branch",
)
check(
    "discoveryCursor: routeDiscoveryCursor" in commit_body,
    "the cursor is not flushed with route observations after successful delivery",
)
ordered(
    upsert_body,
    "loadRouteDiscoveryCursor(scope: scope) == discoveryCursor",
    '"COMMIT"',
    "the traversal cursor is committed without an in-transaction read-back assertion",
)

# 省略 GPX 的**安全性前提**：manifest 必须声明 healthkit scope。
check(
    '"sourceScope": "healthkit"' in health_export,
    "the export manifest no longer declares sourceScope healthkit. That declaration is the ONLY "
    "reason the server reads an omitted GPX as 'not part of this partial archive' instead of as a "
    "deletion (resolvePreserveAbsent → preserveAbsent: true, import-sources.ts:203). Without it, "
    "skipping a route now DELETES its points on the server",
)

# 接线：导出前取快照（导出跑在脱离主线程的上下文里，碰不了 @MainActor 的 store）。
check(
    "taskStore.loadRouteStates(scope: activeScope)" in sync,
    "performSync no longer loads the route state snapshot — the export would see an empty memory "
    "and treat every workout as a first observation (safe, but the whole change is inert)",
)
ordered(
    sync,
    "let routeStates = taskStore.loadRouteStates(scope: activeScope)",
    "HealthKitExport.exportArchive(",
    "the route state snapshot is taken after the export is launched — the export body runs "
    "detached (HealthSyncCancellation.runDetached) and cannot reach the @MainActor store, so the "
    "snapshot has to exist before it starts",
)
check(
    "routeForceRescan: full" in sync,
    "the manual-rescan flag is not wired to `full`: `settled` routes would then have no wake-up "
    "path at all, and '重新导入全部' would keep silently skipping the very routes it promises to redo",
)
check(
    without_comment_lines(sync).count("routeStates: exported.routeStates") == 2,
    "only %d of the two success branches hand the observations to markSuccess — the branch that "
    "does not would drop the memory for every workout it processed"
    % without_comment_lines(sync).count("routeStates: exported.routeStates"),
)

# 🔴 顺序判据：记忆只能写在**水位提交之后**。
ordered(
    commit_body,
    "taskStore.commitSuccess(",
    "taskStore.upsertRouteStates(",
    "the route memory is flushed BEFORE the watermark commit. A sync that never delivered its "
    "payload would then be recorded as 'this route is stable'; it walks down to settled, and "
    "settled is only woken by a manual rescan — so the server can never receive that route. "
    "Flushing after the commit can only ever cost one extra query next round",
)

# 14i. 交叉依赖：凡编译 `SyncTaskStore.swift` 的编译单元，都必须同时编 `RouteSyncState.swift`。
#
#      为什么把它钉成判据：2026-09-23 本轮实测踩了**两次**。`SyncTaskStore` 新增对
#      `RouteSyncRecord` / `RouteSyncStatus` 的依赖之后，每个编译它的单元都各自需要那个文件；
#      而 `typecheck-ios.sh` 是**全量一起编译**的，所以"少列一个文件"这件事在类型检查里
#      完全看不出来 —— 它只在真跑 iOS 门禁时以
#      `cannot find type 'RouteSyncRecord' in scope` 的形式炸。
#      本仓已经有一份同形态的教训（`CalibrationState.swift` / `PlanReceiptMatcher.swift`：
#      "判据存在 ≠ 判据被执行"），所以这里用**扫描**代替"记得改三处"。
for script in sorted(TESTS.glob("*.sh")):
    script_body = read(script)
    if "SyncTaskStore.swift" not in script_body:
        continue
    check(
        "RouteSyncState.swift" in script_body,
        "%s compiles SyncTaskStore.swift without RouteSyncState.swift — the compile unit would "
        "fail with \"cannot find type 'RouteSyncRecord' in scope\", while the full-file type check "
        "stays green because it compiles every source at once" % script.name,
    )


# --- 15. 判据总数的下限（**必须放在全部判据之后**） -----------------------------
# 为什么单列并且必须在末尾：它数的是"这一轮到底执行了多少条判据"，放在中间只会数到中间态。
# 2026-09-23 实测三个反例（把声明改名，行为完全不变）：
#   `performSync` / `uploadToSystem` / `handleEventsForBackgroundURLSession`
# ⇒ 原来的 `if <两个锚点都在>: check(...)` 会让整条判据被**跳过**，
#   总数从 162 掉到 161，而输出里**没有一行 `FAIL:`**、退出码照样 0。
# `ordered()` / `tail_after()` 已经把那种情形变成显式失败；本行再兜一层：
# 新增判据不必改它，只有"判据被吃掉"才会红。
# 注意：打印出来的总数会比消息里的那个数**大 1** —— `check()` 的参数在调用前求值，
# 所以消息里的 `checks` 还不含这一条本身。`MIN_CHECKS` 因此是**零容忍**（少一条就红）。
# ⚠️ 已知锋利边缘：`client_codes` / `UPLOAD_CONTRACT` 这类"内容派生"的循环会随源码增减而变，
# 所以**有意删掉一个状态码**也会踩到它。那时正确的动作是把 MIN_CHECKS 往下调一格，
# 而不是把这条判据删掉。
# 2026-09-23 再补（按 workout 定频）：+26 条（§14h 的 22 条 + §14i 的 2 条 + §10k 名单新增的 2 条）。
# 2026-09-24 再补：+3 条（`RAI_MUTATION_FOR` 范围裁剪的成对守卫，见 §7）。
# ⚠️ 本次实测打印 223 条，而旧值 216 是在打印 220 时定下的 ⇒ 它一直留着 3 条余量，
# **不是**上面说的零容忍。按"打印总数 − 1"收到 222，让新加的 3 条也落进地板里。
# Cold launch recovery and durable intent handoff must remain wired to production.
ordered(background_pass, "restoreBackgroundContext(for: serverURL)", "let task = loadTask()",
        "background task lookup must follow offline identity restoration")
check("syncOwner.run" in tail_after(sync, "func runBackgroundPass(", "runBackgroundPass").split("\n    private func ")[0],
      "background recovery must acquire single-flight ownership before touching context")
check("consumeBackgroundIntent" not in without_comment_lines(sync),
      "background startup must not consume its intent before durable handoff")
check("CacheStore.loadHandshake(baseURL: serverURL)" in sync,
      "background recovery must use the existing shared handshake cache")
publisher_src = read(RAI / "HealthSyncIdentityPublisher.swift")
model_src = read(RAI / "NativeAppModel.swift")
check("HealthSyncIdentityPublisher.publish(identity, baseURL: serverURL)" in sync
      and model_src.count("HealthSyncIdentityPublisher.publish(identity, baseURL: baseURL)") == 2,
      "all three online handshake paths must share identity publication")
ordered(publisher_src, ".record(urlScope:", "save(identity, baseURL)",
        "recovery must be persisted before the shared handshake is published")
check("HealthSyncBackgroundRecovery.persistThenAcknowledge(" in save_body,
      "task persistence must use the tested durable intent handoff")
check("HealthSyncBackgroundRecovery.persistThenAcknowledge(" in commit_body,
      "sync commit must use the tested durable intent handoff")
check("PRIMARY KEY (scope, workout_uuid)" in store_src,
      "route memory must be keyed by both scope and workout UUID")
check("PRAGMA user_version = 2" in store_src and "ALTER TABLE sync_route_state RENAME" in store_src,
      "installed route schemas need an explicit versioned migration")
check(re.search(
          r"taskStore\.upsertRouteStates\(\s*Array\(routeStates\.values\),\s*scope: activeScope,"
          r"\s*discoveryCursor: routeDiscoveryCursor\s*\)", commit_body) is not None,
      "route observations must be saved under the active authoritative scope")

# --- 15b. 冷启动恢复的第二轮（2026-09-24）：调度与回执一律走"按目标读到的快照" ----------
# 这一节的失效方式全是**静默**的：标志与目标错配时没有任何报错，只是某一天起"后台跑过一次
# 之后再没人管"，或者反过来"每 15 分钟空转一次"。
#
# 15b-1. `applicationDidEnterBackground` 必须自己读快照，不能依赖 SwiftUI 的 `scenePhase`
#        回调先跑（两者之间没有先后保证）。
enter_background_delegate = tail_after(
    app_delegate, "func applicationDidEnterBackground(", "applicationDidEnterBackground"
)
check(
    "probePendingWork(for:" in enter_background_delegate
    and "BackgroundRunPolicy.shouldResubmit(" in enter_background_delegate,
    "applicationDidEnterBackground no longer probes this session's target before resubmitting — it "
    "would depend on a callback that has no ordering guarantee with it",
)
# 15b-2. 后台一轮的返回值必须带出快照，且回执用的是它（不是展示标志）。
run_pass_body = tail_after(sync, "func runBackgroundPass(", "runBackgroundPass").split("\n    private func ")[0]
check(
    "-> HealthSyncBackgroundRecovery.PendingWork?" in run_pass_body
    and "probePendingWork(for: serverURL)" in run_pass_body,
    "runBackgroundPass does not hand its caller a target-bound snapshot, so the receipt has to fall "
    "back to the global display flag (which describes another target)",
)
check(
    "pending.map(BackgroundRunPolicy.reportedSuccess)" in app_delegate
    or "BackgroundRunPolicy.reportedSuccess(pending)" in app_delegate,
    "the completion receipt does not come from the round's own snapshot",
)
# 15b-3. 🔴 统一发布入口必须**先于**发布新身份缓存落盘恢复请求。
#        反过来的崩溃窗口：新身份已发布、盘上什么都没记 ⇒ 下一轮纯后台冷启动按新 scope
#        既读不到任务行也读不到意图，于是静默 `nothingToDo`，新 scope 直到用户手动点同步才有批次。
check("HealthSyncIdentityPublisher.publish(identity, baseURL: serverURL)" in perform_body,
      "online HealthKit sync must publish through the shared recovery-aware entry")
check(
    "observeBackgroundIntentsForExportStart(for: serverURL)" in perform_body,
    "performSync no longer claims intents at the export start; a resuming round (which does not re-read "
    "HealthKit) would have to claim them, eating notifications that arrived after those bytes",
)
ordered(
    perform_body,
    "observeBackgroundIntentsForExportStart(for: serverURL)",
    "HealthKitExport.exportArchive(",
    "the intent observation point is not at the export start",
)
check(
    "clearBackgroundIntentObservations()" in sync,
    "the per-sync intent observations are never cleared, so a later sync's saveTask/commit could "
    "acknowledge a notification it never saw",
)
# 15b-4. 重开必须只在单飞接纳之后、读任务之前发生。
check(
    "taskStore.reopenIfUnavailable()" in sync and "func reopenIfUnavailable()" in store_src
    and "reopenIfUnavailable()" not in without_comment_lines(probe_body)
    and "guard self.prepareJournalForExecution() else { return }" in run_pass_body,
    "database reopen must happen under single-flight ownership, never inside the read-only probe",
)
# 15b-5. 跨文件编译单元配对（与 §14i 同一形态）：`BackgroundSyncPolicy` 的判据入参是
#        `HealthSyncBackgroundRecovery.PendingWork`，少编那个文件只在**真跑**门禁时以
#        `cannot find type ... in scope` 炸，而全量类型检查看不出来。
for script in sorted(TESTS.glob("*.sh")):
    script_body = read(script)
    if "BackgroundSyncPolicy.swift" not in script_body:
        continue
    check(
        "HealthSyncBackgroundRecovery.swift" in script_body,
        "%s compiles BackgroundSyncPolicy.swift without HealthSyncBackgroundRecovery.swift — the "
        "snapshot type used by reportedSuccess/shouldResubmit would be out of scope, while the "
        "full-file type check stays green because it compiles every source at once" % script.name,
    )
# 2026-09-24 再补（冷启动恢复第二轮：按目标读取的待办快照）：+28 条（§10g-bis/ter/quater
# 的 6 条、§15b-1..5 的 8 条，以及 §15b-5 的编译单元配对循环按脚本数展开的 14 条）。
# ⚠️ 本次实测打印 **251** 条 ⇒ 按"打印总数 − 1"把地板收到 **250**（零容忍）。

# --- 15c. 投递的「记」与「跑」必须分开：单飞与节流只限制执行 -------------------------
# 这一节的失效方式全是**静默**的：投递被丢掉时没有任何报错，只是某一天起"自动同步再也不
# 推进" —— 直到下一次投递、用户手动点同步，或者打开 App。
#
# 15c-1. 🔴 意图必须在**派发之前**记下，而不是只在某个分支里记。
#        旧形态是"`.ignore` 直接 `break`"：投递既没有代次（`shouldAcknowledgeIntent` 保护的是
#        **已经记下来**的那一代），也不会驱动任何后续轮次，于是旧批次收工清空之后，后台按快照
#        判定"无待办"。判据的载体是 `Decision.recordsTheDelivery` —— 它是"要不要记"的唯一答案，
#        而 `decide` 的返回值只回答"现在跑不跑"（两件事的配对由 `BackgroundSyncPolicyRegression`
#        的 `unboundDeliveriesAreIgnored` 逐格钉住）。
entry_body = tail_after(
    app_delegate, "static func registerSyncEntryPoints(", "registerSyncEntryPoints"
).split("\n    /// ")[0]
entry_clean = without_comment_lines(entry_body)
ordered(
    entry_clean,
    "if decision.recordsTheDelivery {",
    "switch decision {",
    "registerSyncEntryPoints must record the delivery before dispatching on the decision — recording "
    "only inside a branch (or not at all) is exactly how a real change gets dropped",
)
check(
    "case .deferToBackgroundLater:" in entry_clean
    and "submitBackgroundRun(after: BackgroundRunPolicy.resubmitDelay)" in entry_clean,
    "the 'remember this delivery, but do not run now' disposition is not wired: a delivery that "
    "arrived during a running sync or inside the throttle window would be remembered with nothing "
    "scheduled to ever run it",
)
# 15c-2. 🔴 一轮收工后必须把"这一轮没覆盖到的那一代"接过去。判据住在 `SyncFollowUp.handoff`
#        （纯函数、有执行者），这里只钉"它被生产接线用了"：留在纯函数里没人调就是孤儿门禁。
check(
    "SyncFollowUp.handoff(" in app_delegate,
    "the uncovered-generation handoff is not wired to production — the judgement has no consumer",
)
ordered(
    entry_clean,
    "await healthSync.syncIfNeeded(",
    "await handOffUncoveredGenerations(healthSync: healthSync, session: session)",
    "registerSyncEntryPoints must hand off the generations a foreground round did not cover — "
    "without it the notification stays on disk until the next background entry",
)
# 2026-10-09 再补（投递的「记」与「跑」必须分开 ⇒ P1 可达性缺陷）：+4 条（§15c 的 4 条）。
# 2026-10-09 二次修正（未提交改动审查 🟡2）：同一批改动的最终态实测打印 **269** 条，而地板
#   还停在 255 ⇒ 差 14，违反本文件自己写的"零容忍"，那 13 条新增结构判据（§14h-3：rediscovery
#   队列 / `sync_route_discovery` / `knownRunningWorkouts` 定点取 / `routeDiscoveryCursor` 续传）
#   可以被静默吃掉。按"打印总数 − 1"重设为 **268**。
#   判据：删掉 §14h-3 里任意一条 `check(...)` 必须变红。
# ⚠️ 教训：地板必须在**本文件最后一次改动之后**现跑现设 —— 沿用改动中途测到的数就会差（本次差 14）。
# 注：上面那行"实测 251 / 地板 250"是 2026-09-24 的**时点快照**，不要当当前值。
MIN_CHECKS = 268
check(
    checks >= MIN_CHECKS,
    "only %d judgements ran, floor is %d — judgements were silently dropped (an anchor stopped "
    "matching, so the slice or the branch that carries them degraded)" % (checks, MIN_CHECKS),
)

if failures:
    for item in failures:
        print("FAIL: %s" % item)
    print("Background capability checks: %d checks, %d failed" % (checks, len(failures)))
    sys.exit(1)

print("Background capability checks: %d checks, 0 failed" % checks)
