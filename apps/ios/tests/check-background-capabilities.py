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
declared = set(re.findall(r"^\s*case ([a-z][A-Za-z0-9_]*)\s*$", enum_body.group(1) if enum_body else "", re.M))
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
    switch_cases = set(re.findall(r'"([^"]*)"', switch_block.group(1)))
    check(
        switch_cases <= declared,
        "HealthSyncLifecycle switches on phases outside the closed set: %s" % sorted(switch_cases - declared),
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
upload_body = sync.split("private func upload(zipURL: URL, to serverURL: URL, payloadHash: String)")[-1]
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
    sync.count("hasPendingTask = true") == 1 and "hasPendingTask = true" in sync,
    "hasPendingTask is not set exactly once (it belongs in saveTask, the moment progress exists)",
)
check(
    sync.count("hasPendingTask = false") >= 1,
    "hasPendingTask is never cleared",
)
save_body = sync.split("private func saveTask(")[-1].split("\n    private func ")[0]
clear_body = sync.split("private func clearTask()")[-1].split("\n    private func ")[0]
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
launch_body = app_delegate.split("didFinishLaunchingWithOptions")[-1].split("\n    }\n")[0]
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
# 注册点恰好一处：`RAIApp.swift` 被 `typecheck-ios.sh:92` 排除，逻辑写进去就没有门禁看得见。
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

# 9g. 报给系统的成败必须来自纯判据，不许写死。
check(
    "reportedSuccess(hasPendingTask:" in app_delegate,
    "setTaskCompleted(success:) is not decided by BackgroundRunPolicy.reportedSuccess",
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
reconcile_body = sync.split("private func upload(zipURL: URL, to serverURL: URL, payloadHash: String)")[-1]
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
abandon_body = upload_session.split("private func abandonWaiting(identifier: Int)")[-1].split("\n    // MARK:")[0]
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
check(
    sync.count("session.upload(for: request, fromFile:") == 1
    and "session.upload(for: request, fromFile:" in sync.split("private func uploadToSystem(")[-1],
    "HealthKitSync still uploads through the ephemeral foreground session somewhere other than the "
    "non-iOS fallback — that transfer dies the moment the process is suspended",
)
check(
    sync.count("uploadToSystem(") >= 2,
    "upload() no longer hands its bytes to the system",
)

# 10g. 三个调用点必须都在"推导下一步做什么"之前，且顺序不许颠倒。
perform_body = sync.split("private func performSync(")[-1].split("\n    private func ")[0]
check(
    "await reconcileSystemUploads(" in perform_body,
    "performSync never reconciles the system's uploads — it would then re-send bytes the system is still "
    "sending, and one of the two uploads must hit import_upload_busy (429)",
)
# 🔴 顺序判据必须先确认**两个**符号都在，否则它自己在 `index()` 上抛 `ValueError`：
# 门禁崩掉会让"这一条判据红了"变成"整个脚本没跑完"，后面所有检查一条都不执行 ——
# 而且崩溃的输出里没有 `FAIL:` 行，突变验证的 `assertion_hit` 于是永远为假。
# （这个形态是 2026-09-22 跑 `[P2-4]` 分段突变时被一条真突变暴露出来的。）
if "reconcileSystemUploads(" in perform_body and "SyncAtomicUnit.nextStep(" in perform_body:
    check(
        perform_body.index("reconcileSystemUploads(") < perform_body.index("SyncAtomicUnit.nextStep("),
        "performSync reconciles *after* deriving the next step: the derivation would see `.upload` while "
        "the system still owns those bytes",
    )
background_pass = sync.split("func runBackgroundPass(")[-1].split("\n    private func ")[0]
check(
    "hasBackgroundUploadTask: systemUploadInFlight(" in background_pass,
    "runBackgroundPass no longer feeds the real 'system owns these bytes' signal into BackgroundRunPolicy",
)
enter_background = sync.split("func handleEnterBackground()")[-1].split("\n    func ")[0]
check(
    "hasUploadTask:" in enter_background,
    "handleEnterBackground does not tell HealthSyncLifecycle whether the system owns the bytes",
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
if "try updateTask(phase: .uploading, uploadState: .inFlight)" in sync and "try await uploadToSystem(" in sync:
    check(
        sync.index("try updateTask(phase: .uploading, uploadState: .inFlight)")
        < sync.index("try await uploadToSystem("),
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
handle_events = app_delegate.split("handleEventsForBackgroundURLSession identifier: String,")[-1].split("\n    /// ")[0]
# 早退分支（identifier 不对）**必须自己**回调：那条路不会建 session，所以 `urlSessionDidFinishEvents`
# 永远不会被调到 —— 把 completion 留在手里等于系统永远收不到回执。
unknown_branch = handle_events.split("guard identifier ==")[-1].split("return\n")[0]
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
if "storeSystemCompletion(" in handle_events and "makeSession()" in handle_events:
    check(
        handle_events.index("makeSession()") < handle_events.index("storeSystemCompletion("),
        "the system completion is stored before the session exists — completion events would have no delegate",
    )

# 10k. 门禁自己不许变成孤儿（这已经是本仓第三次同一个形态）。
for required in ("BackgroundSyncPolicy.swift", "BackgroundSyncPolicyRegression.swift"):
    check(
        required in runner,
        "run-health-sync-tests.sh does not compile/run %s" % required,
    )

if failures:
    for item in failures:
        print("FAIL: %s" % item)
    print("Background capability checks: %d checks, %d failed" % (checks, len(failures)))
    sys.exit(1)

print("Background capability checks: %d checks, 0 failed" % checks)
