#!/usr/bin/env python3
r"""后台同步判据的**突变验证**（`npm run test:ios:mutation`）。

为什么单独一个脚本、且**刻意不**进 `run-ios-gates.sh`：

- 它**会改写源码**（逐条定点破坏 → 跑门禁 → 还原），跑一次要十几分钟，属于"验收时跑一次"，
  不属于"每次改动都跑"。
- 但它必须留在仓库里：`check-background-capabilities.py` 与 `HealthSyncLifecycleRegression`
  的**断言有效性**不是自明的。判据跑绿只说明"没红"，不说明"改坏了会红"。

判据来源（三条，缺一条这套验证就没有意义）：
  1. **定点破坏**：每条突变针对**一条具体判据**，且期望的断言消息必须出现在输出里
     —— 只看到"红了"不算，要看到**红在那一条上**。
  2. **排除"突变其实是编译错误"**：编译错误也会让门禁非零退出。分类器按
     `\.swift:\d+:\d+: error:` 之类精确匹配识别编译错，且**带一个负向对照**
     （故意制造缺右括号）证明分类器本身没坏 —— 没有负向对照的分类器等于没被验证过。
  3. **还原后必须回绿**：只在干净状态上做突变，结束必须回到基线。

跑法：`python3 apps/ios/tests/check-background-mutations.py`

调试/分段跑：`RAI_MUTATION_ONLY=<子串>` 只跑名字里含该子串的那些突变。
它**不是**验收手段（验收必须全量跑），只是为了在加一条新突变时不必等全套 ——
但此时基线检查与"还原后回绿"检查仍然会跑，所以"当前仓库是绿的"这个前提不会被跳过。

🔴 **被 SIGTERM / SIGKILL 打断会留下改坏的源码。** 这不是假想：本脚本在 2026-09-22 的一次
前台运行里被 SIGTERM 掉，`finally` 来不及跑，于是 `BackgroundSyncPolicy.swift` 里带着一条
突变留在工作区；下一次运行的基线检查才把它暴露出来。所以备份不再是临时目录：
  1. 备份落在固定的 `var/mutation-backup/`（gitignored），并写下 `IN-PROGRESS` 标记；
  2. 启动时若发现上次的标记还在 ⇒ **先从它还原**再继续（覆盖 SIGKILL 这种连信号处理
     都没机会跑的情况）；
  3. `SIGINT` / `SIGTERM` 装了处理器 → 还原后退出码 130/143。
判据是"下一次运行不会在被污染的树上做基线检查"，而不是"记得别 Ctrl-C"。
"""
from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import sys
from pathlib import Path

# 一整轮要十几分钟，而 stdout 被重定向时 Python 默认按块缓冲 —— 于是日志文件在整个
# 运行期间是**空的**，看起来像卡死，也没法判断它跑到第几条。行缓冲换回来：
# 代价是几次 write syscall，换的是"能看见进度"。
try:
    sys.stdout.reconfigure(line_buffering=True)
except AttributeError:  # pragma: no cover - 只对极老的解释器有效
    pass

ROOT = Path(__file__).resolve().parents[3]

LIFECYCLE = "apps/ios/RAI/HealthSyncLifecycle.swift"
SYNC = "apps/ios/RAI/HealthKitSync.swift"
SYNC_PHASE = "apps/ios/RAI/SyncPhase.swift"
APP = "apps/ios/RAI/RAIApp.swift"
APP_DELEGATE = "apps/ios/RAI/AppDelegate.swift"
ROOT_VIEW = "apps/ios/RAI/RootView.swift"
TECH_THEME = "apps/ios/RAI/Skins/Technology/TechTheme.swift"
TECH_PRESENTATION = "apps/ios/RAI/Skins/Technology/TechSyncPresentation.swift"
MODEL_RUNNER = "apps/ios/tests/run-model-tests.sh"
HEALTH_SYNC_RUNNER = "apps/ios/tests/run-health-sync-tests.sh"
BG_POLICY = "apps/ios/RAI/BackgroundSyncPolicy.swift"
UPLOAD_SESSION = "apps/ios/RAI/BackgroundUploadSession.swift"
API_CLIENT = "apps/ios/RAI/APIClient.swift"
# 🔴 凡是被突变**改到**的文件都必须在这里。少一个的失效方式是致命的：`restore()` 会静默跳过它
# （那个"跳过"是为信号处理器的窗口留的），于是改坏的源码留在工作区、下一轮的基线检查才炸。
SOURCES = [
    LIFECYCLE, SYNC, SYNC_PHASE, APP, APP_DELEGATE, ROOT_VIEW, TECH_THEME, TECH_PRESENTATION, MODEL_RUNNER,
    HEALTH_SYNC_RUNNER, BG_POLICY, UPLOAD_SESSION, API_CLIENT,
]

SWIFT_GATE = "bash apps/ios/tests/run-health-sync-tests.sh"
PRESENTATION_GATE = "bash apps/ios/tests/run-tech-presentation-tests.sh"
PY_GATE = "python3 apps/ios/tests/check-background-capabilities.py"
CLEAN = SWIFT_GATE + " && " + PY_GATE + " && " + PRESENTATION_GATE

# 精确到"编译器报的错"。**不能**写成 `"error:" in out` —— 运行时断言失败打的是
# `Fatal error: Error raised at top level: …`，那样会把正确的变红误判成编译错误。
COMPILE_ERROR_RE = re.compile(
    r"\.swift:\d+:\d+: error:"
    r"|error: unexpected"
    r"|error: cannot find"
    r"|linker command failed"
    r"|produced malformed response",
    re.M,
)

# 「断言红」在本仓有**四种**形态，少认一种就会把"门禁确实红了"报成"这次突变没被抓住"：
#   1. Swift `throw` 逃到顶层          → `Fatal error: Error raised at top level:`
#   2. python 门禁自己打印的 `FAIL: …`  → `FAIL:`
#   3. Swift `precondition` 失败        → `Precondition failed:` + `Illegal instruction: 4`
#      （`run-tech-presentation-tests.sh` 用的是 `precondition`，且刻意不带 `-O` 以便保留消息）
#   4. python `assert` 失败             → `AssertionError:`（traceback 打印在 stderr）
# 顺序仍由 `classify` 保证：先看编译错误，所以放宽这里不会把编译错吃成 RED ——
# 那一条由 NEGATIVE_CONTROL 每次跑一遍来证明。
ASSERTION_RE = re.compile(
    r"Fatal error: Error raised at top level:"
    r"|^FAIL: "
    r"|Precondition failed:"
    r"|AssertionError:"
    r"|^Traceback \(most recent call last\):",
    re.M,
)

backup_dir: Path = ROOT / "var" / "mutation-backup"
marker = backup_dir / "IN-PROGRESS"


def restore() -> None:
    """把 `SOURCES` 全部还原成备份的样子。**不碰标记** —— 标记只在整轮结束时清。

    对缺备份的文件静默跳过：信号可能在"备份还没来得及建"的窗口里到达，
    那种情况下工作区本来就是干净的，硬要求文件存在只会把处理器本身弄崩。
    """
    for rel in SOURCES:
        source = backup_dir / Path(rel).name
        if source.exists():
            shutil.copy2(source, ROOT / rel)


def finish() -> None:
    """整轮结束（正常或被打断）：还原 + 清掉"有现场"的标记。"""
    restore()
    marker.unlink(missing_ok=True)


def recover_leftover_backup() -> None:
    """上一次运行被 SIGKILL 掉时留下的现场：先把源码还原回基线。

    不这么做的话，下一次运行会**在被污染的树上做基线检查**，然后要么报一个假失败
    （让人去查一条根本没写过的判据），要么更糟 —— 通过基线、把上一次的残留当成自己的突变。
    """
    if not marker.exists():
        return
    missing = [rel for rel in SOURCES if not (backup_dir / Path(rel).name).exists()]
    if missing:
        raise SystemExit(
            "leftover mutation backup at %s is incomplete (%s missing); "
            "restore these files from git before running this harness:\n  %s"
            % (backup_dir, ", ".join(missing), "\n  ".join(missing))
        )
    print("recovered: a previous run was interrupted; restoring %d sources from %s"
          % (len(SOURCES), backup_dir))
    finish()


def install_signal_handlers() -> None:
    def handler(signum: int, _frame: object) -> None:
        # 还原必须在信号处理器里做，不能靠 `finally`：SIGTERM 默认直接终止进程，
        # 于是 `finally` 不跑、工作区带着一条突变留在那里（2026-09-22 实际发生过）。
        finish()
        print("\ninterrupted by signal %d; sources restored" % signum, flush=True)
        sys.exit(128 + signum)

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, handler)


def edit(rel: str, old: str, new: str) -> None:
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    hits = text.count(old)
    if hits != 1:
        raise SystemExit("[%s] pattern occurs %d times, expected exactly 1:\n%s" % (rel, hits, old))
    path.write_text(text.replace(old, new), encoding="utf-8")


def run(cmd: str) -> tuple[int, str]:
    result = subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True)
    return result.returncode, result.stdout + result.stderr


def classify(code: int, out: str) -> str:
    if code == 0:
        return "STILL-GREEN"
    if COMPILE_ERROR_RE.search(out):
        return "COMPILE-ERROR"
    if ASSERTION_RE.search(out):
        return "RED"
    return "OTHER-RED"


# (说明, 破坏动作, 用哪个门禁, 必须在输出里出现的断言消息)
MUTATIONS = [
    (
        "判据: 删掉 importing 分支 => 在飞工作被报成 doNothing",
        lambda: edit(
            LIFECYCLE,
            'case "collecting", "exported", "uploading", "uploaded", "importing", "recomputing":',
            'case "collecting", "exported", "uploading", "uploaded", "recomputing":',
        ),
        SWIFT_GATE,
        "in-flight work in importing",
    ),
    (
        "判据: 终态检查提到 hasJobId 之前 => 字段不再优先于 phase 文字",
        lambda: edit(
            LIFECYCLE,
            "        if hasJobId { return .stopResumable }\n"
            "        if terminalPhases.contains(phase) { return .doNothing }",
            "        if terminalPhases.contains(phase) { return .doNothing }\n"
            "        if hasJobId { return .stopResumable }",
        ),
        SWIFT_GATE,
        "a persisted jobId was not honoured",
    ),
    (
        "判据: resumablePhase 对未知输入回 cancelled => 生命周期中止冒充用户取消",
        lambda: edit(
            LIFECYCLE,
            "        guard persistedPhases.contains(interrupted), !terminalPhases.contains(interrupted) else {\n"
            '            return "idle"\n'
            "        }",
            "        guard persistedPhases.contains(interrupted), !terminalPhases.contains(interrupted) else {\n"
            '            return "cancelled"\n'
            "        }",
        ),
        PY_GATE,
        "resumablePhase contains",
    ),
    (
        "结构门禁: 切后台改回 cancelSync()",
        lambda: edit(APP, "model.healthSync.handleEnterBackground()", "model.healthSync.cancelSync()"),
        PY_GATE,
        "still calls cancelSync()",
    ),
    (
        "结构门禁: 后台额度到期改回 cancelSync()",
        lambda: edit(
            SYNC,
            "            self.suspendForLifecycle()\n            UIApplication.shared.endBackgroundTask(backgroundTask)",
            "            self.cancelSync()\n            UIApplication.shared.endBackgroundTask(backgroundTask)",
        ),
        PY_GATE,
        "expiration handler still calls cancelSync()",
    ),
    (
        '结构门禁: 写一个裸 phase 字符串 "starting"',
        lambda: edit(
            SYNC,
            "phase = SyncPhase.collecting.rawValue\n        activeToken = apiToken",
            'phase = "starting"\n        activeToken = apiToken',
        ),
        PY_GATE,
        "still writes bare phase strings",
    ),
    (
        "结构门禁: 纯判据去掉 .manual 前置 => cancelled 不再只属于用户取消",
        lambda: edit(
            LIFECYCLE,
            '        if cause == .manual { return "cancelled" }',
            '        if cause != .none { return "cancelled" }',
        ),
        PY_GATE,
        "is not guarded by",
    ),
    (
        "反孤儿: 从 run-model-tests.sh 摘掉本门禁",
        lambda: edit(
            MODEL_RUNNER,
            "python3 apps/ios/tests/check-background-capabilities.py",
            "true # gate removed",
        ),
        PY_GATE,
        "would be an orphan gate",
    ),
    (
        "判据（可执行）: 同一突变必须也被回归断言抓住，不能只靠 grep",
        lambda: edit(
            LIFECYCLE,
            '        if cause == .manual { return "cancelled" }',
            '        if cause != .none { return "cancelled" }',
        ),
        SWIFT_GATE,
        "impersonated a user cancel",
    ),
    (
        '结构门禁: 调用方自己写 phase = "cancelled"，绕过纯判据',
        lambda: edit(
            SYNC,
            "        lastError = nil\n        phase = next\n",
            '        lastError = nil\n        phase = "cancelled"\n',
        ),
        PY_GATE,
        'writes phase = "cancelled" itself',
    ),
    # ---- P1 · 原子单元协议（计划 §5 要求的突变验证） ----
    (
        "判据: nextStep 的 jobId 分支改成重传 => 已受理的批次会被传第二份",
        lambda: edit(
            SYNC_PHASE,
            "        if jobId != nil { return .waitJob }",
            "        if jobId != nil { return .upload }",
        ),
        SWIFT_GATE,
        "did not outrank the other recovery branches",
    ),
    (
        "结构门禁: 上传返回后直接落 importing => D1 的中间态消失",
        lambda: edit(
            SYNC,
            # 用**两行**做锚点：单行版本（12 空格）是 16 空格那行的子串，
            # `str.count` 会把两处都算上，于是"锚点不唯一"这种假失败会盖过真结论。
            "            phase = SyncPhase.uploaded.rawValue\n"
            "            try updateTask(sourceId: sourceId, phase: .uploaded, uploadState: .completed)",
            "            phase = SyncPhase.importing.rawValue\n"
            "            try updateTask(sourceId: sourceId, phase: .importing)",
        ),
        PY_GATE,
        "records .importing without a jobId",
    ),
    # ---- P1 · 上传失败码必须与服务端契约逐字一致 ----
    (
        "跨仓: 客户端发明一个服务端从不产出的错误码",
        lambda: edit(SYNC_PHASE, '"invalid_import_archive"', '"invalid_archive"'),
        PY_GATE,
        "invents an error code the server never emits",
    ),
    (
        "跨仓: 客户端漏掉服务端真实存在的拒绝码",
        lambda: edit(
            SYNC_PHASE,
            '        "sync_batch_content_mismatch" // import-sources.ts:65-69 同一批次号对应了不同内容\n',
            "",
        ),
        PY_GATE,
        "does not classify it",
    ),
    (
        "判据: 把并发占用判成 409 => 覆盖的是一个不存在的分支",
        lambda: edit(
            SYNC_PHASE,
            "        if statusCode == 429 { return .backOffAndRetry }",
            "        if statusCode == 409 { return .backOffAndRetry }",
        ),
        SWIFT_GATE,
        "a bare 429 was not treated as a busy upload",
    ),
    # ---- P1 · 本地产物必须活在下次唤醒还读得到的地方 ----
    (
        "结构门禁: multipart 回到 /tmp => 下次唤醒已经读不到字节",
        lambda: edit(
            SYNC,
            "        let multipartURL = artifactURL(named: Self.multipartName(for: payloadHash))",
            '        let multipartURL = FileManager.default.temporaryDirectory'
            '.appendingPathComponent("up.multipart")',
        ),
        PY_GATE,
        "still stages its multipart in /tmp",
    ),
    (
        "结构门禁: boundary 改回随机 => 重建的包不再逐字节一致",
        lambda: edit(
            SYNC,
            "        let boundary = Self.multipartBoundary(for: payloadHash)",
            r'        let boundary = "rai-\(UUID().uuidString)"',
        ),
        PY_GATE,
        "does not derive its boundary from payloadHash",
    ),
    # ---- P1 · 启动期注册与「有待办批次」 ----
    (
        "结构门禁: 观察者注册点挂回视图层 => 后台唤醒时一个观察者都没有",
        lambda: edit(
            ROOT_VIEW,
            "                discovery.start()\n",
            "                discovery.start()\n"
            "                healthSync.startObservingHealthChanges {}\n",
        ),
        PY_GATE,
        "must have exactly one",
    ),
    (
        "结构门禁: 把 observers.isEmpty 守卫加回去 => 掩盖第二次注册",
        lambda: edit(
            SYNC,
            "        guard HKHealthStore.isHealthDataAvailable() else { return }",
            "        guard observers.isEmpty, HKHealthStore.isHealthDataAvailable() else { return }",
        ),
        PY_GATE,
        "observers.isEmpty guard is back",
    ),
    (
        "结构门禁: saveTask 不再记录「有待办批次」",
        lambda: edit(
            SYNC,
            "        UserDefaults.standard.removeObject(forKey: scopedKey(Self.taskKey))\n"
            "        hasPendingTask = true\n",
            "        UserDefaults.standard.removeObject(forKey: scopedKey(Self.taskKey))\n",
        ),
        PY_GATE,
        "is not set exactly once",
    ),
    # ---- P1 · 展示层：「卡着一批」不得被显示成「上次成功」 ----
    (
        "展示: 有待办批次被判成上次成功",
        lambda: edit(TECH_PRESENTATION, "        if hasPendingTask { return .pending }\n", ""),
        PRESENTATION_GATE,
        "A pending batch must not be reported as a previous success",
    ),
    (
        "展示: 闭集新增一个阶段，techSyncPhase 没有对应文案",
        lambda: edit(
            SYNC_PHASE,
            "    case collecting\n",
            "    case collecting\n    case exporting\n",
        ),
        PRESENTATION_GATE,
        "has no label for",
    ),
    (
        "展示: 删掉 exported 的文案 => 落回 default 的「等待同步」",
        lambda: edit(TECH_THEME, '    case "exported": return "已准备数据"\n', ""),
        PRESENTATION_GATE,
        "has no label for",
    ),
    # ---- P2 · 后台投递策略（`BackgroundSyncPolicy.swift`） ----
    # 名字统一带 `[P2]` 前缀：分段跑靠它筛（`RAI_MUTATION_ONLY='[P2]'`）。
    (
        "[P2] 判据: 节流提到 hasPendingTask 之前 => 中断的批次要等满 15 分钟",
        lambda: edit(
            BG_POLICY,
            "        if hasPendingTask { return .deferToBackground }\n"
            "        if let lastSyncAt, now.timeIntervalSince(lastSyncAt) < throttle { return .ignore }\n",
            "        if let lastSyncAt, now.timeIntervalSince(lastSyncAt) < throttle { return .ignore }\n"
            "        if hasPendingTask { return .deferToBackground }\n",
        ),
        SWIFT_GATE,
        "an in-flight batch was held back by the fresh-delivery throttle",
    ),
    (
        "[P2] 判据: 前台也吃节流 => 用户点了同步但界面没反应",
        lambda: edit(BG_POLICY, "        if isForeground { return .syncNow }\n", ""),
        SWIFT_GATE,
        "a foreground delivery was throttled",
    ),
    (
        "[P2] 判据: jobId 让位给「系统托管的上传」=> 服务端结果永远接不回来",
        # ⚠️ 锚点必须**连闭括号一起换**。第一版只换了前三行，于是 `if hasTask {` 的闭括号
        # 变成孤儿 ⇒ 提前关掉 `BackgroundRunPolicy` ⇒ 报了一屏"static methods may only be
        # declared on a type / cannot find 'x' in scope"，看起来像判据红了，其实是编译错。
        lambda: edit(
            BG_POLICY,
            "        if let jobId, !jobId.isEmpty { return .resumeJob }\n"
            "        if hasTask {\n"
            "            if hasBackgroundUploadTask { return .awaitSystemUpload }\n"
            "            return .runAtomicUnit\n"
            "        }\n",
            "        if hasTask, hasBackgroundUploadTask { return .awaitSystemUpload }\n"
            "        if let jobId, !jobId.isEmpty { return .resumeJob }\n"
            "        if hasTask {\n"
            "            return .runAtomicUnit\n"
            "        }\n",
        ),
        SWIFT_GATE,
        "a persisted jobId lost to hasUploadTask",
    ),
    (
        "[P2] 判据: 系统托管的传输被当成可推进 => 字节归系统时又去碰它",
        lambda: edit(
            BG_POLICY,
            "            if hasBackgroundUploadTask { return .awaitSystemUpload }\n",
            "",
        ),
        SWIFT_GATE,
        "a system-owned upload was touched by a background run",
    ),
    (
        "[P2] 判据: 有任务行时放行全新导出 => 服务端多一份来源、两个 job",
        # ⚠️ 插入点必须**在 jobId 之后**。插在最前面会让 `jobResumptionOutranksEverything`
        # 先红 —— 那样验到的是"jobId 优先级"，不是"不许在未完成批次上重导出"。
        # 一条突变只能打破一条判据，否则红了也读不出是哪一条坏了。
        # 同理，`main()` 里 `systemOwnedUploadIsNotTouched` 排在它前面：本条改的是
        # `hasTask` 分支，插进去之后系统托管那一支仍然先返回，所以那一条不会被误伤。
        lambda: edit(
            BG_POLICY,
            "        if let jobId, !jobId.isEmpty { return .resumeJob }\n"
            "        if hasTask {\n",
            "        if let jobId, !jobId.isEmpty { return .resumeJob }\n"
            "        if wantsFreshSync { return .startFreshSync }\n"
            "        if hasTask {\n",
        ),
        SWIFT_GATE,
        "a task row produced startFreshSync instead of runAtomicUnit",
    ),
    (
        "[P2] 判据: reportedSuccess 改问「跑没跑起来」=> 单飞被拒也报成功",
        lambda: edit(
            BG_POLICY,
            "    static func reportedSuccess(hasPendingTask: Bool) -> Bool {\n"
            "        !hasPendingTask\n"
            "    }",
            "    static func reportedSuccess(hasPendingTask: Bool) -> Bool {\n"
            "        true\n"
            "    }",
        ),
        SWIFT_GATE,
        "a run that left an unfinished batch reported success",
    ),
    (
        "[P2] 判据: 请求是一次性的，却不自己重排 => 后台跑一次之后再没人管",
        lambda: edit(
            BG_POLICY,
            "        hasPendingTask || hasFreshIntent\n",
            "        false\n",
        ),
        SWIFT_GATE,
        "did not schedule the next background run",
    ),
    (
        "[P2] 判据: BGTask identifier 改了但 Info.plist 没跟着改 => 静默注册不上",
        lambda: edit(
            BG_POLICY,
            '    static let taskIdentifier = "app.rai.running.health-sync"',
            '    static let taskIdentifier = "app.rai.running.healthsync"',
        ),
        SWIFT_GATE,
        "the BGTask identifier changed",
    ),
    # ---- P2-4 · 字节交给系统之后，判据与清理都换了地方 ----
    (
        "[P2-4] 判据: 重挂判据恒认领 => 没人等的孤儿传输被留着，两份字节同时在传",
        lambda: edit(
            BG_POLICY,
            "        isAwaitedInThisProcess ? .keep : .cancelOrphan",
            "        true ? .keep : .cancelOrphan",
        ),
        SWIFT_GATE,
        "produced keep instead of cancelOrphan",
    ),
    (
        "[P2-4] 判据: matchesCurrentBatch 恒真 => 真机验收再也分不出「白传」与「多一份垃圾」",
        lambda: edit(
            BG_POLICY,
            "        return taskDescription == currentPayloadHash",
            "        return true",
        ),
        SWIFT_GATE,
        "matched=true instead of false",
    ),
    (
        "[P2-4] 判据: foundAny 恒真 => 「系统手上什么都没有」这条证据被抹平",
        lambda: edit(
            BG_POLICY,
            "    var foundAny: Bool { keptAwaited + cancelledCurrentBatch + cancelledOthers > 0 }",
            "    var foundAny: Bool { true }",
        ),
        SWIFT_GATE,
        "did not read as empty",
    ),
    (
        "[P2-4] 结构门禁: 放弃等结果时顺手取消传输 => 生命周期中止把跨进程续传能力一起扔掉",
        lambda: edit(
            UPLOAD_SESSION,
            "        waiter?.resume(throwing: CancellationError())\n    }",
            "        waiter?.resume(throwing: CancellationError())\n"
            "        session?.getAllTasks { $0.forEach { $0.cancel() } }\n    }",
        ),
        PY_GATE,
        "abandonWaiting cancels the URLSessionTask",
    ),
    (
        "[P2-4] 结构门禁: 忘了把系统完成回调交出去 => 系统认为后台事件永远处理不完",
        lambda: edit(
            APP_DELEGATE,
            "        session.storeSystemCompletion(completionHandler)\n",
            "        _ = completionHandler\n",
        ),
        PY_GATE,
        "does not hand the completion to the session",
    ),
    (
        "[P2-4] 结构门禁: 先交字节再记 inFlight => 那个窗口里被杀会白传一遍",
        lambda: edit(
            SYNC,
            "        try updateTask(phase: .uploading, uploadState: .inFlight)\n"
            "        let (data, response) = try await uploadToSystem(request, from: multipartURL, payloadHash: payloadHash)",
            "        let (data, response) = try await uploadToSystem(request, from: multipartURL, payloadHash: payloadHash)\n"
            "        try updateTask(phase: .uploading, uploadState: .inFlight)",
        ),
        PY_GATE,
        "hands the bytes over before recording that they are in flight",
    ),
    (
        "[P2-4] 结构门禁: 上传改回前台 ephemeral 通道 => 进程一挂起传输就没了",
        # 锚点在 `SYNC`（`uploadToSystem` 住在那里），不是 `UPLOAD_SESSION` ——
        # 第一版写错文件，报的是"pattern occurs 0 times"，也就是这条判据**根本没被验到**。
        lambda: edit(
            SYNC,
            "        return try await RaiBackgroundUploadSession.shared.upload(\n"
            "            request: request, fromFile: file, payloadHash: payloadHash\n"
            "        )",
            "        return try await session.upload(for: request, fromFile: file)",
        ),
        PY_GATE,
        "still uploads through the ephemeral foreground session",
    ),
    (
        "[P2-4] 结构门禁: 两条 URLSession 各写一份重定向判据 => 「走了哪条路径」决定安不安全",
        lambda: edit(
            UPLOAD_SESSION,
            "            RaiSameOrigin.allowsRedirection(from: task.originalRequest?.url, to: request.url) ? request : nil\n",
            "            request\n",
        ),
        PY_GATE,
        "does not share RaiSameOrigin",
    ),
    (
        "[P2-4] 结构门禁: 前台重定向守卫不再共用判据 => 两侧规则分叉",
        lambda: edit(
            API_CLIENT,
            "        completionHandler(\n"
            "            RaiSameOrigin.allowsRedirection(from: task.originalRequest?.url, to: request.url)\n"
            "                ? request\n"
            "                : nil\n"
            "        )",
            "        completionHandler(request)",
        ),
        PY_GATE,
        "RaiRedirectGuard no longer uses RaiSameOrigin",
    ),
    (
        "[P2-4] 结构门禁: getAllTasks 改回同步等 => 卡住主线程，卡多久由系统决定",
        lambda: edit(
            UPLOAD_SESSION,
            "        let urlSession = makeSession()\n"
            "        let tasks = await withCheckedContinuation { continuation in",
            "        let urlSession = makeSession()\n"
            "        let group = DispatchGroup()\n"
            "        let tasks = await withCheckedContinuation { continuation in",
        ),
        PY_GATE,
        "waits synchronously for getAllTasks",
    ),
    (
        "[P2-4] 结构门禁: performSync 不再盘点 => 会和系统手上的旧传输同时传同一批",
        lambda: edit(SYNC, "        await reconcileSystemUploads(loadTask())\n", ""),
        PY_GATE,
        "performSync never reconciles the system's uploads",
    ),
    (
        "[P2-4] 结构门禁: 后台一轮不再喂真实信号 => 「字节归谁」永远是假的",
        lambda: edit(
            SYNC,
            "            hasBackgroundUploadTask: systemUploadInFlight(payloadHash: task?.payloadHash),",
            "            hasBackgroundUploadTask: false,",
        ),
        PY_GATE,
        "no longer feeds the real",
    ),
    (
        "[P2-4] 结构门禁: 把 uploadTaskId 当判据 => 它没有写入点，答案恒假、每轮都重传",
        lambda: edit(
            SYNC,
            "        guard task.uploadState == .inFlight else { return }",
            "        guard task.uploadState == .inFlight, task.uploadTaskId != nil else { return }",
        ),
        PY_GATE,
        "reads uploadTaskId as a judgement",
    ),
    (
        "[P2-4] 结构门禁: 上传返回后顺手删掉 multipart => 系统手上的续传能力被删掉",
        lambda: edit(
            SYNC,
            "        return try JSONDecoder().decode(UploadResponse.self, from: data).sourceId\n    }",
            "        try? FileManager.default.removeItem(at: multipartURL)\n"
            "        return try JSONDecoder().decode(UploadResponse.self, from: data).sourceId\n    }",
        ),
        PY_GATE,
        "removes a local artifact",
    ),
    (
        "[P2-4] 结构门禁: 判据类型搬进 iOS-only 文件 => 派生量再没有任何执行者",
        # 用"在另一侧多出一份同名声明"来表达搬家：判据检查的是**位置**，所以这是唯一能
        # 单次编辑就让它变红的形状。它会同时造成真实的重复声明 —— 但那不影响本条的结论，
        # 因为这里跑的是静态门禁，不是编译器。
        lambda: edit(
            UPLOAD_SESSION,
            "#if os(iOS)\nimport Foundation\n",
            "#if os(iOS)\nimport Foundation\n\nstruct BackgroundUploadReattachReport {}\n",
        ),
        PY_GATE,
        "lives outside BackgroundSyncPolicy.swift",
    ),
    (
        "[P2-4] 反孤儿: 把策略回归从 run-health-sync-tests.sh 里摘掉",
        lambda: edit(
            "apps/ios/tests/run-health-sync-tests.sh",
            "  apps/ios/RAI/BackgroundSyncPolicy.swift \\\n",
            "",
        ),
        PY_GATE,
        "does not compile/run BackgroundSyncPolicy.swift",
    ),
]

# 负向对照：一个**真正的编译错误**。它必须被分成 COMPILE-ERROR 而不是 RED，
# 否则"突变其实是编译错误"这条从来没被排除过 —— 也就是说分类器本身没被验证。
NEGATIVE_CONTROL = (
    "负向对照: 制造一个真正的编译错误（数组字面量缺右括号）",
    lambda: edit(
        SYNC_PHASE,
        "    static let terminal: Set<SyncPhase> = [.idle, .succeeded, .failed, .cancelled]",
        "    static let terminal: Set<SyncPhase> = [.idle, .succeeded, .failed, .cancelled",
    ),
    SWIFT_GATE,
)


def print_tail(out: str) -> None:
    for line in [l for l in out.strip().splitlines() if l.strip()][-8:]:
        print("        " + line)


def main() -> int:
    failures: list[str] = []
    selector = os.environ.get("RAI_MUTATION_ONLY", "").strip()
    selected = [m for m in MUTATIONS if selector in m[0]] if selector else list(MUTATIONS)

    recover_leftover_backup()
    install_signal_handlers()

    if not selected:
        print("no mutation matched RAI_MUTATION_ONLY=%r; nothing to do" % selector)
        return 1

    backup_dir.mkdir(parents=True, exist_ok=True)
    for rel in SOURCES:
        shutil.copy2(ROOT / rel, backup_dir / Path(rel).name)
    marker.write_text("sources under mutation; delete only after restoring\n", encoding="utf-8")

    try:
        code, out = run(CLEAN)
        print("baseline: exit=%d %s" % (code, "GREEN" if code == 0 else "NOT GREEN"))
        if code != 0:
            print_tail(out)
            return 1
        if selector:
            print("selected: %d of %d mutations (RAI_MUTATION_ONLY=%r)" % (len(selected), len(MUTATIONS), selector))
        print()

        for name, apply, gate, needle in selected:
            restore()
            # 锚点过期（源码改过、模式不再唯一）**不能**让整个 harness 停下来：
            # 那会把"这一条没验到"伪装成"后面都没问题"。记成失败并继续。
            try:
                apply()
            except SystemExit as error:
                print("  BAD " + name)
                print("        mutation pattern is stale, so this judge was never exercised")
                print_tail(str(error))
                failures.append(name + " (stale pattern)")
                continue
            code, out = run(gate)
            verdict = classify(code, out)
            hit = needle in out
            ok = verdict == "RED" and hit
            print(("  OK  " if ok else "  BAD ") + name)
            print("        exit=%d verdict=%s assertion_hit=%s" % (code, verdict, hit))
            if not ok:
                failures.append(name)
                print_tail(out)

        name, apply, gate = NEGATIVE_CONTROL
        restore()
        try:
            apply()
        except SystemExit as error:
            # 分类器没被验证过这件事必须**显式记成失败**，而不是静默跳过 ——
            # 静默跳过会让"排除了突变其实是编译错误"这个结论失去依据。
            print("  BAD " + name)
            print_tail(str(error))
            failures.append(name + " (stale pattern)")
            code, out = 0, ""
        else:
            code, out = run(gate)
        verdict = classify(code, out)
        ok = verdict == "COMPILE-ERROR"
        print(("  OK  " if ok else "  BAD ") + name)
        print("        exit=%d verdict=%s" % (code, verdict))
        if not ok:
            failures.append(name)
            print_tail(out)

        restore()
        code, out = run(CLEAN)
        print()
        print("restored: exit=%d %s" % (code, "GREEN" if code == 0 else "NOT GREEN"))
        if code != 0:
            failures.append("restore did not return to green")
            print_tail(out)
    finally:
        finish()

    print()
    if selector:
        # 用**不同的措辞**报结论：分段跑的输出绝不能被读成"全套通过"。
        print("mutation check (PARTIAL, filter=%r): %d of %d mutations, %d failed"
              % (selector, len(selected), len(MUTATIONS), len(failures)))
    else:
        print("mutation check: %d mutations, %d failed" % (len(MUTATIONS), len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
