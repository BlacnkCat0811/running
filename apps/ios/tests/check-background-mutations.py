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

🔴 **按改动范围裁剪：`RAI_MUTATION_FOR`。** 全量一轮十分钟，而其中绝大多数突变跟你这次改的文件
毫无关系。用法：`RAI_MUTATION_FOR=git`（取当前工作区改动）或 `RAI_MUTATION_FOR=<路径>[,<路径>]`。

它的粒度是**门禁的输入面**，不是"按名字抽样"：改动文件落在某个门禁读/编译的文件里 ⇒ 该门禁
名下的**全部**突变都要跑。**不能**按"突变改了哪个文件"（`target`）求交集 —— 新断言会让**指向别的
文件**的突变 `assertion_hit=False`。2026-09-24 真实踩过：route 的有损用例进了水位那个编译单元，
于是"批量写不再 BEGIN IMMEDIATE"那条变成红在**别人的**断言上。
门禁输入面是**现场算的**（bash 门禁静态解析它点名的仓库内文件；python 门禁用 audit hook 抓它实际
`open` 了哪些仓库内文件），**不存手写表** —— 手写表会漂移，而漂移就是静默漏跑。
它同样**不是**验收手段：产物带 `partial: true`、结论行措辞与全量不同；选中 0 条时**绝不**宣称
"判据有效性已被验证"。

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

import datetime
import hashlib
import json
import os
import re
import runpy
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
HEALTH_EXPORT = "apps/ios/RAI/HealthKitExport.swift"
TECH_THEME = "apps/ios/RAI/Skins/Technology/TechTheme.swift"
TECH_PRESENTATION = "apps/ios/RAI/Skins/Technology/TechSyncPresentation.swift"
MODEL_RUNNER = "apps/ios/tests/run-model-tests.sh"
HEALTH_SYNC_RUNNER = "apps/ios/tests/run-health-sync-tests.sh"
BG_POLICY = "apps/ios/RAI/BackgroundSyncPolicy.swift"
RECOVERY = "apps/ios/RAI/HealthSyncBackgroundRecovery.swift"
IDENTITY_PUBLISHER = "apps/ios/RAI/HealthSyncIdentityPublisher.swift"
UPLOAD_SESSION = "apps/ios/RAI/BackgroundUploadSession.swift"
API_CLIENT = "apps/ios/RAI/APIClient.swift"
SYNC_STATE_PLAN = "apps/ios/RAI/SyncStateCommitPlan.swift"
SYNC_TASK_STORE = "apps/ios/RAI/SyncTaskStore.swift"
ROUTE_SYNC_MACHINE = "apps/ios/RAI/RouteSyncStateMachine.swift"
STORE_RUNNER = "apps/ios/tests/run-store-tests.sh"
HEALTH_ARCHIVE = "apps/ios/RAI/HealthSyncArchive.swift"
HEALTH_PARSER = "packages/health-export-parser/src/apple-health-parser.ts"
# S3.5（2026-10-14）：服务端同步文件也成了哨兵扫描面（`check-direct-sync-status-copy.py` 的 2c 节），
# 反例夹具要往它里面写旧文案 —— 它必须进 SOURCES，否则 restore() 会静默跳过、把改坏的文件留在工作区。
IMPORT_WORKER = "apps/api/src/import-worker.ts"
# 🔴 凡是被突变**改到**的文件都必须在这里。少一个的失效方式是致命的：`restore()` 会静默跳过它
# （那个"跳过"是为信号处理器的窗口留的），于是改坏的源码留在工作区、下一轮的基线检查才炸。
SOURCES = [
    LIFECYCLE, SYNC, SYNC_PHASE, APP, APP_DELEGATE, ROOT_VIEW, TECH_THEME, TECH_PRESENTATION, MODEL_RUNNER,
    HEALTH_SYNC_RUNNER, BG_POLICY, RECOVERY, IDENTITY_PUBLISHER, UPLOAD_SESSION, API_CLIENT, HEALTH_EXPORT,
    SYNC_STATE_PLAN, SYNC_TASK_STORE, ROUTE_SYNC_MACHINE, STORE_RUNNER,
    HEALTH_ARCHIVE, HEALTH_PARSER, IMPORT_WORKER,
]

SWIFT_GATE = "bash apps/ios/tests/run-health-sync-tests.sh"
PRESENTATION_GATE = "bash apps/ios/tests/run-tech-presentation-tests.sh"
PY_GATE = "python3 apps/ios/tests/check-background-capabilities.py"
RECORD_GATE = "python3 apps/ios/tests/check-healthkit-record-sync.py"
EXPORT_GATE = "python3 apps/ios/tests/check-export-determinism.py"
# S2.4 的反例夹具用：status-copy 门禁是纯 python、可独立跑（与 PY_GATE 同风格）。
COPY_GATE = "python3 apps/ios/tests/check-direct-sync-status-copy.py"
CLEAN = SWIFT_GATE + " && " + PY_GATE + " && " + EXPORT_GATE + " && " + PRESENTATION_GATE

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

# ---------------------------------------------------------------- 门禁输入面
# 突变是**按门禁**分组的（每条突变指定一个 gate），所以"改动范围"必须换算成门禁集合。
# 换算的媒介 = 每个门禁会读取/编译的**仓库内文件**集合。这个集合**现场算**，不手写：
# bash 门禁静态解析它点名的仓库内路径；python 门禁（`check-*.py`）用 audit hook 抓它真正
# `open` 了哪些仓库内文件。手写表的失效方式是静默的（新加一个输入、表没更新 ⇒ 漏跑）。
MUTATION_GATES = [SWIFT_GATE, PRESENTATION_GATE, PY_GATE, EXPORT_GATE]

# 只认仓库内的路径字面量。门禁脚本**注释**里提到的路径也算输入 —— 那是刻意的保守方向：
# 多算只会多跑几条，少算会让"改坏的判据没被验到"。
REPO_PATH_RE = re.compile(
    r"\b(?:apps|packages|scripts|deploy|research)/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+"
)


def normalize_path(raw: str) -> str | None:
    """把 `raw` 归一到仓库相对路径；不在仓库内（或已不可解析）时返回 None。"""
    candidate = Path(raw)
    absolute = candidate if candidate.is_absolute() else ROOT / candidate
    try:
        return str(absolute.resolve().relative_to(ROOT))
    except (ValueError, OSError):
        return None


def in_scope(candidate: str, changed: list[str]) -> bool:
    """`candidate`（一个门禁输入文件）是否落在改动范围内。

    **目录条目按前缀算**，不能只做相等比较：`git status` 对"整目录未跟踪"只报目录名
    （`?? apps/ios/newdir/`），而门禁输入是**文件**路径 ⇒ 相等比较恒为假 ⇒ 那条改动被静默
    漏掉。用户也可能直接传一个目录。多算只会多跑几条，少算会让"没验到"伪装成"没事"。
    """
    for entry in changed:
        if entry in (".", ""):
            return True
        if candidate == entry or candidate.startswith(entry.rstrip("/") + "/"):
            return True
    return False


def scope_changed_paths(raw: str) -> list[str]:
    """解析 `RAI_MUTATION_FOR`。`git` = 取当前工作区的全部改动（含未跟踪）。"""
    if raw.strip() == "git":
        # `-uall`：未跟踪的**目录**默认只报目录名，展开成文件才谈得上"改的是哪个文件"。
        result = subprocess.run(
            ["git", "status", "--porcelain", "-uall"], cwd=ROOT, capture_output=True, text=True
        )
        if result.returncode != 0:
            raise SystemExit("git status --porcelain -uall failed:\n%s" % result.stderr)
        entries = []
        for line in result.stdout.splitlines():
            path = line[3:].strip() if len(line) > 3 else ""
            if " -> " in path:
                # 重命名：`R  old -> new`。**两侧都要** —— 门禁读的是新路径，
                # 但旧路径从门禁输入里消失本身也会改变门禁的行为。
                old, path = path.split(" -> ", 1)
                if old.strip():
                    entries.append(old.strip().strip('"'))
            if path:
                entries.append(path.strip('"'))
    else:
        entries = [item.strip() for item in re.split(r"[,\n]", raw) if item.strip()]

    resolved: list[str] = []
    for entry in entries:
        normalized = normalize_path(entry)
        if normalized is None:
            print("scope: ignoring %r (not inside the repository)" % entry)
            continue
        if normalized not in resolved:
            resolved.append(normalized)
    return sorted(resolved)


def python_gate_opens(script: str) -> set[str]:
    """跑一次 `script`，返回它 `open` 过的**仓库内**文件集合。

    必须另起进程：`sys.addaudithook` 只能累加、不能卸载，同进程里探第二个门禁会被前一个污染。
    环境里清掉 `RAI_MUTATION*` 是为了**杜绝递归** —— 子进程不会再去做一次范围裁剪。
    """
    environment = {k: v for k, v in os.environ.items() if not k.startswith("RAI_MUTATION")}
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--dump-gate-inputs", script],
        cwd=ROOT, capture_output=True, text=True, env=environment,
    )
    if result.returncode != 0:
        raise SystemExit(
            "could not determine the inputs of %s (exit=%d):\n%s"
            % (script, result.returncode, result.stderr[-2000:])
        )
    # 取**最后一行**：万一将来有东西漏进 stdout，也不能让一行噪声把裁剪静默变成"0 条命中"。
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise SystemExit("no input list came back from %s" % script)
    return set(json.loads(lines[-1]))


def gate_inputs(gate: str) -> set[str]:
    """一个门禁会读取/编译的仓库内文件集合（含门禁脚本自身）。"""
    found: set[str] = set()
    for command in gate.split("&&"):
        tokens = command.split()
        if not tokens:
            continue
        script = tokens[-1]
        if not (ROOT / script).exists():
            raise SystemExit("gate script not found while scoping: %s" % script)
        found.add(script)
        if script.endswith(".py"):
            found |= python_gate_opens(script)
        else:
            found |= set(REPO_PATH_RE.findall((ROOT / script).read_text(encoding="utf-8")))
    return found


def dump_gate_inputs(script: str) -> int:
    """`--dump-gate-inputs <脚本>`：`python_gate_opens()` 的子进程入口。"""
    opened: list[str] = []

    def hook(event: str, args: tuple) -> None:
        if event != "open" or not args:
            return
        candidate = args[0]
        if isinstance(candidate, (str, bytes, os.PathLike)):
            opened.append(os.fspath(candidate))

    sys.addaudithook(hook)
    sys.argv = [script]
    # 门禁自己的 stdout 必须**吞掉**：它是给人看的报告（`… checks, 0 failed`），
    # 与这里的 JSON 混在一条流里会让调用方解析到人的报告上去。stderr 不吞，失败时还能看。
    real_stdout = sys.stdout
    sys.stdout = open(os.devnull, "w")
    try:
        runpy.run_path(str(ROOT / script), run_name="__main__")
    except SystemExit:
        pass
    finally:
        sys.stdout.close()
        sys.stdout = real_stdout

    relative: set[str] = set()
    for raw in opened:
        normalized = normalize_path(raw)
        if normalized is not None:
            relative.add(normalized)
    print(json.dumps(sorted(relative)))
    return 0


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


# 本轮**已经**被 `edit()` 改写过的文件，由 main 在每次 `apply()` 前清空。
# 存在的唯一理由是让 JSON 摘要能写明"这条突变炸的是哪个文件" ——
# 光有突变名的话，跨轮 diff 看到"某条从 RED 变成 STILL-GREEN"时还得回去读源码才知道碰的是哪儿。
_edited: list[str] = []


def edit(rel: str, old: str, new: str) -> None:
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    hits = text.count(old)
    if hits != 1:
        raise SystemExit("[%s] pattern occurs %d times, expected exactly 1:\n%s" % (rel, hits, old))
    # 记在精确性检查**之后**：模式过期时这条突变根本没被施加，不该声称它改过谁。
    if rel not in _edited:
        _edited.append(rel)
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
        "[第三轮] 判据: 首次读取失败不再登记待办 => 迟到训练在 anchor 越过后永久不可发现",
        lambda: edit(
            HEALTH_EXPORT,
            "                        pageNewTodos[routeKey] = unreadable",
            "                        // dropped",
        ),
        RECORD_GATE,
        "a FIRST route read failure must register a persistent todo",
    ),
    (
        "[第三轮] 判据: 定点修复不再复位预算档位 => 历史超界后预算永久折半，没有任何回满额的路",
        lambda: edit(SYNC, "self.clearBudgetConvergence()", "// convergence kept"),
        PY_GATE,
        "the explicit repair must also reset the budget convergence step",
    ),
    (
        "[第三轮] 判据: 修复改成整行删除（或绕过窄原语）=> 「禁止全量同步」退回成 UI 约定",
        lambda: edit(SYNC, "self.taskStore.clearWorkoutAnchor(scope: self.activeScope)",
                     "self.taskStore.clearWorkoutAnchorRenamed(scope: self.activeScope)"),
        PY_GATE,
        "the repair must clear the stored anchor through the narrow primitive",
    ),
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
        "结构门禁: 后台额度到期改回 cancelSync()（2026-09-24 锚点随防御性配对更新："
        "expiration handler 现在带 `backgroundTask != .invalid` 守卫，且看门狗里有同形代码，"
        "锚点必须带上 handler 独有的注释行才唯一）",
        lambda: edit(
            SYNC,
            "            // `checkCancellation()` 把系统的决定当成用户意图，从此永久卡死。\n"
            "            self.suspendForLifecycle()\n"
            "            if backgroundTask != .invalid {\n"
            "                UIApplication.shared.endBackgroundTask(backgroundTask)",
            "            // `checkCancellation()` 把系统的决定当成用户意图，从此永久卡死。\n"
            "            self.cancelSync()\n"
            "            if backgroundTask != .invalid {\n"
            "                UIApplication.shared.endBackgroundTask(backgroundTask)",
        ),
        PY_GATE,
        "expiration handler still calls cancelSync()",
    ),
    (
        "结构门禁: 看门狗不再盯表（额度阈值改成永假）=> endBackgroundTask 的时机重新"
        "交给系统回调的准时性（2026-09-24 OOM 溯源新增，判据见 capabilities 5b）",
        lambda: edit(
            SYNC,
            "                  UIApplication.shared.backgroundTimeRemaining < Self.backgroundTimeSafetyMargin",
            "                  UIApplication.shared.backgroundTimeRemaining < -1",
        ),
        PY_GATE,
        "the background-time watchdog margin is declared but never used",
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
    # ---- P1 · `.waitJob` 的生产消费点（2026-10-11）------------------------------------
    # 缺陷形态：`SyncAtomicUnit.Step.waitJob` 有纯函数回归（证明 `nextStep` **会**返回它），
    # 却**没有任何生产消费点** —— `performSync` 只认 `.inspect` / `.upload`，于是带 `jobId`
    # 的任务坠进导出路径。三个后果全部静默，2026-10-11 线上实测（job 08:06:01 已 succeeded，
    # 而 App 回到前台重新开始读健康数据）。
    # 这五条各自针对 §15d 的一条判据，且都改**行为**（不是改名/换写法）。
    (
        "[P1] 结构门禁: 盘上有 jobId 时不再续接 => 直接坠进导出路径（重读 HealthKit、"
        "旧任务行被覆盖、界面永停在未走完）",
        # 还原成"分支从不匹配 .waitJob"的形状：`unitStep == .waitJob` 这个符号随之消失，
        # 于是"有没有消费点"这条判据变红。（不是改名：分支本身还在，只是再也接不上那一步。）
        lambda: edit(
            SYNC,
            "        if let restored = restoredTask, unitStep == .waitJob, let jobId = restored.jobId {",
            "        if let restored = restoredTask, unitStep == .inspect, let jobId = restored.jobId {",
        ),
        PY_GATE,
        "never consumes the `.waitJob` step",
    ),
    (
        "[P1] 结构门禁: 只问一次就当成结局 => 服务端还在算时就把这一批判成功",
        # 2026-10-14 去歧义：`let finished = try await waitForJob(id: jobId, on: serverURL)`
        # 在 HealthKitSync 里有**两个文本完全相同**的站点（`.waitJob` 与 `.inspect` 分支各一）。
        # `edit()` 要求旧文本恰好 1 处，两个命中 ⇒ 整条以 `stale pattern` 失败、什么都没验到。
        # 锚点带上 `.waitJob` 分支独有的上一行注释后唯一；且门禁切片只看 `.waitJob` 分支 ——
        # 改这一处正是它该抓的（改 `.inspect` 那个文本被切成切片之外，抓不到）。
        lambda: edit(
            SYNC,
            "                // 那批新数据就再也没人导。（`markSuccess` 里的确认会读到 `nil` 观察槽，是空操作。）\n"
            "                let finished = try await waitForJob(id: jobId, on: serverURL)",
            "                // 那批新数据就再也没人导。（`markSuccess` 里的确认会读到 `nil` 观察槽，是空操作。）\n"
            "                let finished = try await getJob(id: jobId, on: serverURL)",
        ),
        PY_GATE,
        "does not wait for the persisted jobId",
    ),
    (
        "[P1] 判据: 只差对账的步被放宽成 export => 前台每次进入都重读一遍 HealthKit（GB 级）",
        lambda: edit(
            SYNC_PHASE,
            "        var isServerReconciliationOnly: Bool { self == .waitJob }",
            "        var isServerReconciliationOnly: Bool { self == .export }",
        ),
        SWIFT_GATE,
        "was not recognised as a server-only reconciliation",
    ),
    (
        "[P1] 结构门禁: 让 15 分钟节流吞掉 jobId 续接 => 回到前台不再对账已落盘的 job",
        lambda: edit(
            SYNC,
            "            if !force, !isBlocked, !isLedgerResume {",
            "            if !force, !isBlocked {",
        ),
        PY_GATE,
        "lets the 15-minute throttle swallow",
    ),
    (
        "[P1] 结构门禁: `.waitJob` 续接不提交记录游标 => 游标停在上一批，下一轮重导一遍",
        # 锚点必须带上 `resumedImportMessage`：`recordCursors: restored…` 与
        # `routeDiscoveryCursor: restored…` 这两行在**每条**恢复分支里都有，单行锚点不唯一。
        lambda: edit(
            SYNC,
            "                    message: resumedImportMessage(job: finished),\n"
            "                    exportEnd: restored.exportEnd,\n"
            "                    workoutCount: restored.workoutCount,\n"
            "                    advanceWatermark: restored.exportEnd != nil,\n"
            "                    clearWatermark: restored.exportEnd == nil,\n"
            "                    anchor: restored.pendingAnchor,\n"
            "                    recordCursors: restored.pendingRecordCursors,\n",
            "                    message: resumedImportMessage(job: finished),\n"
            "                    exportEnd: restored.exportEnd,\n"
            "                    workoutCount: restored.workoutCount,\n"
            "                    advanceWatermark: restored.exportEnd != nil,\n"
            "                    clearWatermark: restored.exportEnd == nil,\n"
            "                    anchor: restored.pendingAnchor,\n",
        ),
        SWIFT_GATE,
        "every resume success must commit the saved cursors",
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
        # ⚠️ 期望文案必须与 `check-background-capabilities.py` 里那条 `check(...)` 的**当前**
        # 措辞逐字一致：这里曾是旧版文案（"...and the three journal-read failure paths"），
        # 而那条判据的措辞改过、这一份副本没跟着改 ⇒ 门禁其实红了（`verdict=RED`），
        # 但 `assertion_hit=False`，于是这条突变在报告里长期记成"没被抓住"（2026-10-09 实测）。
        "hasPendingTask must be set at saveTask, journal-read failures and failed database preparation",
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
            "        if let lastSyncAt, now.timeIntervalSince(lastSyncAt) < throttle { return .deferToBackgroundLater }\n",
            "        if let lastSyncAt, now.timeIntervalSince(lastSyncAt) < throttle { return .deferToBackgroundLater }\n"
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
        "[R1] 判据: 有待续页却不认 => 后台发现待续页后仍收工，BGTask 反复重排空转（活锁）",
        # 锚点是**单行**（BackgroundSyncPolicy.swift 的最终形态），命中恰好一次。
        lambda: edit(
            BG_POLICY,
            "        return wantsContinuation ? .resumeContinuation : .nothingToDo\n",
            "        return .nothingToDo\n",
        ),
        SWIFT_GATE,
        "a persisted continuation with nothing else on disk started nothing",
    ),
    (
        "[P2] 判据: reportedSuccess 改问「跑没跑起来」=> 单飞被拒也报成功",
        lambda: edit(
            BG_POLICY,
            "    static func reportedSuccess(_ pending: HealthSyncBackgroundRecovery.PendingWork) -> Bool {\n"
            "        pending.reportsSuccess\n"
            "    }",
            "    static func reportedSuccess(_ pending: HealthSyncBackgroundRecovery.PendingWork) -> Bool {\n"
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
            "        pending.needsAnotherRound\n",
            "        false\n",
        ),
        SWIFT_GATE,
        "did not schedule the next background run",
    ),
    # ---- P3 · 后台软预算的接线（2026-10-09，审计 3.10）--------------------------------
    # 缺陷形态：`shouldYield` 有实现、有测试、**没有生产调用者** ⇒ 测试全绿而生产从不遵守预算
    # （"软预算被测试容易被误认为生产遵守预算"）。下面两条分开钉两件事：
    # 一条钉"接在哪"（只接轮询、且只在后台 —— 纯判据），一条钉"到底接没接"（结构门禁）。
    (
        "[P3] 判据: 软预算对前台也让出 => 用户正看着的那次同步被拍出来的参数掐掉",
        lambda: edit(
            BG_POLICY,
            "        guard isBackground, let backgroundStartedAt else { return false }\n",
            "        guard let backgroundStartedAt else { return false }\n",
        ),
        SWIFT_GATE,
        "the soft budget yielded a foreground sync",
    ),
    (
        "[P3] 结构门禁: 软预算退回只剩测试 => 生产再不遵守预算，而门禁全绿（审计 3.10）",
        # 把调用名换掉即可：capabilities 9i-bis 是**文本**检查（`HealthKitSync.swift` 没有任何
        # 回归编译它，所以这里不能靠"编译不过"来变红）。
        lambda: edit(
            SYNC,
            "            if BackgroundRunPolicy.shouldYieldPolling(\n",
            "            if BackgroundRunPolicy.disabledPollingYield(\n",
        ),
        PY_GATE,
        "does not consume the background soft budget",
    ),
    # ---- P1 · 投递的可达性（2026-10-09）：单飞与节流只限制"执行"，不限制"记忆" ----------
    # 缺陷形态：`.ignore` 既写代次也不驱动任何后续轮次 ⇒ 旧批次收工清空之后，后台按快照判定
    # "无待办"，自动同步停在原地。下面四条分别钉判据（`decide` 的两个成因 + "要不要记"）、
    # 额度（`SyncFollowUp`）与接线（AppDelegate），另加两条**结构门禁**钉接线本身。
    #
    # ⚠️ 顺序与 `BackgroundSyncPolicyRegression.main()` 一一对应：每条突变只允许被它自己那一条
    # 断言抓住（`assertion_hit` 指认的必须是"被改坏的那条判据"，不是一个碰巧先跑到的邻居）。
    (
        "[P1] 判据: 运行中的投递仍被直接忽略 => 导出起点之后的变化没有代次，自动同步停在原地",
        lambda: edit(
            BG_POLICY,
            "        guard !isSyncRunning else { return .deferToBackgroundLater }\n",
            "        guard !isSyncRunning else { return .ignore }\n",
        ),
        SWIFT_GATE,
        "a delivery that arrived while a sync was running was ignored",
    ),
    (
        "[P1] 判据: 节流窗口内的投递被丢掉 => 这一代既没有代次也没人排下一轮",
        lambda: edit(
            BG_POLICY,
            "        if let lastSyncAt, now.timeIntervalSince(lastSyncAt) < throttle { return .deferToBackgroundLater }\n",
            "        if let lastSyncAt, now.timeIntervalSince(lastSyncAt) < throttle { return .ignore }\n",
        ),
        SWIFT_GATE,
        "a delivery inside the throttle window was dropped instead of being remembered",
    ),
    (
        "[P1] 判据: 未绑定的投递也记意图 => 往一个不存在的目标上写永远没人消费的意图",
        lambda: edit(
            BG_POLICY,
            "        var recordsTheDelivery: Bool { self != .ignore }",
            "        var recordsTheDelivery: Bool { true }",
        ),
        SWIFT_GATE,
        "a delivery for a target that does not exist was recorded as a pending intent",
    ),
    (
        "[P1] 判据: 前台补跑没有上限 => 大批导入期间前台自旋，每轮都是 GB 级导出",
        # 2026-10-14（S2.3）改写：handoff 增加"待续页"维度与分额度后，旧锚点行不存在了。
        # 判据不变（"上限被删掉"必须被它自己那一条抓住），锚点换成新实现里的额度分支：
        # 突变 = 新代次分支里的上限条件被删（回到"只要前台就再来一轮"的旧形态）。
        lambda: edit(
            BG_POLICY,
            "        if hasUncoveredGeneration { return foregroundRoundsLeft > 0 ? .runAgain : .scheduleBackground }\n",
            "        if hasUncoveredGeneration { return .runAgain }\n",
        ),
        SWIFT_GATE,
        "foreground follow-up rounds are unbounded",
    ),
    (
        "[P1] 结构门禁: 只在 defer 分支里记意图 => 运行中/节流窗口内的投递又被丢掉",
        lambda: edit(
            APP_DELEGATE,
            "            if decision.recordsTheDelivery {\n"
            "                healthSync.recordBackgroundIntent(for: session.serverURL)\n"
            "            }\n"
            "            switch decision {\n",
            "            switch decision {\n",
        ),
        PY_GATE,
        "registerSyncEntryPoints must record the delivery before dispatching on the decision",
    ),
    (
        "[P1] 结构门禁: 收工后不接没覆盖到的那一代 => 通知一直躺在盘上，自动同步停在原地",
        # 锚点带上后一行（`case .deferToBackground:`）：`handOffUncoveredGenerations` 在
        # `observeProtectedDataAvailability` 里也有一处调用，只锚调用行会命中两次而拒绝施加。
        lambda: edit(
            APP_DELEGATE,
            "                await handOffUncoveredGenerations(healthSync: healthSync, session: session)\n"
            "            case .deferToBackground:\n",
            "            case .deferToBackground:\n",
        ),
        PY_GATE,
        "registerSyncEntryPoints must hand off the generations a foreground round did not cover",
    ),
    (
        "[P1] 结构门禁: 忘了给 deferToBackgroundLater 排执行 => 记下来了却永远没人跑",
        lambda: edit(
            APP_DELEGATE,
            "                submitBackgroundRun(after: BackgroundRunPolicy.resubmitDelay)\n"
            "            case .ignore:\n",
            "            case .ignore:\n",
        ),
        PY_GATE,
        "the 'remember this delivery, but do not run now' disposition is not wired",
    ),
    # ---- 冷启动恢复第二轮（2026-09-24）：调度与回执一律走"按目标读到的快照" ----
    # 全部是"改错了照样编译通过、肉眼也看不出来"的形态，所以每一条都要有自己的执行者。
    (
        "[P1] 判据: 探针顺手绑定 active* => 「看一眼」把会话改绑到那个目标",
        lambda: edit(
            SYNC,
            "        let urlScope = Self.urlScope(for: serverURL)\n"
            "        let authoritativeScope = identity.map { Self.syncScope(for: serverURL, identity: $0) }\n",
            "        let urlScope = Self.urlScope(for: serverURL)\n"
            "        activeScope = urlScope\n"
            "        let authoritativeScope = identity.map { Self.syncScope(for: serverURL, identity: $0) }\n",
        ),
        PY_GATE,
        "probePendingWork assigns an active* field",
    ),
    (
        "[P1] 判据: 又合成了「有新数据」的意图 => 续传走完之后多导一次全量",
        lambda: edit(
            SYNC,
            "        let hasNotification = backgroundIntentObservation(for: serverURL) != nil\n",
            "        if task != nil, backgroundIntentObservation(for: serverURL) == nil {\n"
            "            recordBackgroundIntent(for: serverURL)\n"
            "        }\n"
            "        let hasNotification = backgroundIntentObservation(for: serverURL) != nil\n",
        ),
        PY_GATE,
        "performBackgroundPass synthesizes a new-data intent again",
    ),
    (
        "[P1] 判据: 探针重开数据库 => 单飞拒绝时仍执行迁移",
        lambda: edit(
            SYNC,
            "        guard let serverURL else { return nil }\n        #if os(iOS)\n",
            "        guard let serverURL else { return nil }\n        _ = taskStore.reopenIfUnavailable()\n        #if os(iOS)\n",
        ),
        PY_GATE,
        "probePendingWork writes, clears or deletes something",
    ),
    (
        "[P1] 判据: 身份缓存先发布 => 中断后新 scope 丢失恢复依据",
        lambda: edit(
            IDENTITY_PUBLISHER,
            "        let nextScope = syncScope(for: baseURL, identity: identity)\n",
            "        let nextScope = syncScope(for: baseURL, identity: identity)\n"
            "        save(identity, baseURL)\n",
        ),
        PY_GATE,
        "recovery must be persisted before the shared handshake is published",
    ),
    (
        "[P1] 判据: 后台一轮不把快照交出去 => 回执只能用别的目标的展示标志",
        lambda: edit(
            SYNC,
            "        return probePendingWork(for: serverURL)\n",
            "        return nil\n",
        ),
        PY_GATE,
        "does not hand its caller a target-bound snapshot",
    ),
    (
        "[P1] 判据: 读盘失败被当成「确认空」=> 盘上那一批再也没人管",
        lambda: edit(
            RECOVERY,
            "        if readFailed { return .unknown }\n",
            "        if readFailed { return .empty }\n",
        ),
        SWIFT_GATE,
        "a read failure outranks a found row",
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
    (
        "判据载体: 删掉 V2 的派发日志 => 那条真机验收静默变回不可判",
        lambda: edit(
            APP_DELEGATE,
            '            RaiStartup.report("BGProcessingTask launched (\\(RaiBackgroundSync.taskIdentifier))")\n',
            "",
        ),
        PY_GATE,
        "BGProcessingTask launched",
    ),
    # ---- 导出确定性（`HealthKitExport.swift`）--------------------------------
    # 名字统一带 `[export]` 前缀：分段跑靠它筛（`RAI_MUTATION_ONLY='[export]'`）。
    # 这四条对应 `check-export-determinism.py` 的四组判据，一条只能打破一条：
    # 每条都还原成**真实的旧写法**（而不是随便删一行），否则验到的是"门禁会红"，
    # 而不是"这个缺陷会被抓住"。
    (
        "[export] 结构门禁: <MetadataEntry> 改回遍历 Dictionary => 行序随进程变、content hash 变",
        lambda: edit(
            HEALTH_EXPORT,
            "        for key in metadata.keys.sorted() {\n"
            "            if skip.contains(key) { continue }\n"
            "            guard let value = metadata[key] else { continue }\n",
            "        for (key, value) in metadata {\n"
            "            if skip.contains(key) { continue }\n",
        ),
        EXPORT_GATE,
        "does not iterate metadata.keys.sorted()",
    ),
    (
        "[export] 结构门禁: 样本查询改回只排 workout => export.xml 字节抖动，source_sha256 永不重复",
        lambda: edit(
            HEALTH_EXPORT,
            "                    sortDescriptors: [\n"
            "                        NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true),\n"
            "                        NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: true)\n"
            "                    ]\n",
            "                    sortDescriptors: type is HKWorkoutType\n"
            "                        ? [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]\n"
            "                        : nil\n",
        ),
        EXPORT_GATE,
        "still sorts only workouts",
    ),
    (
        "[export] 结构门禁: manifest 重新带上 createdAt => Zip 字节每次不同、幂等键每次都换",
        lambda: edit(
            HEALTH_EXPORT,
            '            "sampleTypes": ["workout", "sleep", "heart_rate", "hrv", "resting_heart_rate"]\n',
            '            "sampleTypes": ["workout", "sleep", "heart_rate", "hrv", "resting_heart_rate"],\n'
            '            "createdAt": ISO8601DateFormatter().string(from: Date())\n',
        ),
        EXPORT_GATE,
        'still carries a "createdAt" key',
    ),
    (
        "[export] 结构门禁: manifest 的 deletedSourceIds 去掉排序 => 查询返回序漏进 ZIP",
        lambda: edit(
            HEALTH_EXPORT,
            '            "deletedSourceIds": workoutBatch.deleted.map { $0.uuid.uuidString }.sorted(),\n',
            '            "deletedSourceIds": workoutBatch.deleted.map { $0.uuid.uuidString },\n',
        ),
        EXPORT_GATE,
        "is written unsorted",
    ),
    (
        "[export] 反孤儿: 从 run-model-tests.sh 摘掉导出确定性门禁",
        lambda: edit(
            MODEL_RUNNER,
            "python3 apps/ios/tests/check-export-determinism.py",
            "true # gate removed",
        ),
        EXPORT_GATE,
        "would be an orphan gate",
    ),
    (
        "[export] 判据非空转: 把 metadataXML 改名 => 门禁必须报「判据变成空转」，而不是静默变绿",
        # 这条不是回归，是**门禁自身的有效性**：判据里那些"不得出现 X"的形状断言，
        # 一旦锚点函数被改名就会变成"什么都没检查"的绿灯。必须让它红在那条显式断言上。
        lambda: edit(HEALTH_EXPORT, "func metadataXML(", "func metadataXMLLines("),
        EXPORT_GATE,
        "every judgement below would be vacuous",
    ),
    # --- S2「分批与续传」（2026-10-14）：三条反例，覆盖 S2.3/S2.4 的新接线 --------------
    # ① phase 兜底写回（S2.4 要求的反例夹具）；② hasMorePages 写回恒假（S2.3 的断链）；
    # ③ 待续标记不经 commitSuccess（提交后剩下的页没人读）。
    # ⚠️ 三条都必须满足"Swift 部分照样绿、只有门禁能抓"（见本节开头 :1480 的纪律）：
    #   ① 只删/加 UI 文案分支（HealthKitSync 不被任何 Swift 回归编译）；
    #   ② 只是把参数写死 false（编译过、行为变化无 Swift 回归覆盖）；
    #   ③ 删掉一个带默认值的实参（编译过）。
    (
        "[S2] 反例夹具: waitForJob 的 phase 兜底写回来 => 英文阶段 token 直出用户（S2.4）",
        lambda: edit(
            SYNC,
            "                if !job.message.isEmpty {\n"
            "                    message = job.message\n"
            "                }\n",
            "                if !job.message.isEmpty {\n"
            "                    message = job.message\n"
            "                } else if !job.phase.isEmpty {\n"
            "                    message = job.phase\n"
            "                }\n",
        ),
        COPY_GATE,
        "must not be shown to the user",
    ),
    (
        "[S2] 结构门禁: continuationNeeded 的 hasMorePages 写回恒假 => 预算截断的待续标记永远不写",
        lambda: edit(
            SYNC,
            "            hasMorePages: hasMorePages,\n",
            "            hasMorePages: false,\n",
        ),
        SWIFT_GATE,
        "the real hasMorePages must reach continuationNeeded",
    ),
    (
        "[S2] 结构门禁: commitSuccess 不再写待续槽 => 提交后剩下的页没人读（前台续跑与后台唤醒都失去判据）",
        # 2026-10-16（WP-12）重锚点：R3b 在 `recordCursors:` 与 `continuationPending:` 之间插入了
        # `pendingDeletions:` 参数，旧两段式锚点失配（stale pattern ⇒ 整条什么都没验到）。
        # 本批按当前文本重锚；本突变的意图不变（拿掉待续标记的写入）。
        lambda: edit(
            SYNC,
            "recordCursors: recordCursors, pendingDeletions: pendingDeletions, continuationPending: needsContinuation) },",
            "recordCursors: recordCursors, pendingDeletions: pendingDeletions) },",
        ),
        SWIFT_GATE,
        "markSuccess must persist the continuation flag through commitSuccess",
    ),
    (
        "[S3] 反例夹具: 服务端写回「正在创建项目级备份并校验现有数据」=> 旧语义经 job.message 上屏（S3.5 哨兵）",
        # 插入一行**合法 TS 语句**（不改变编译结果类别）：门禁只扫文本，而这条要证明
        # "服务端文案回潮"被哨兵抓住。锚点选 S3.3 收口注释（候选链路删除点），
        # 插入位置在 `else` 块内（`job` 在作用域内，类型检查也过）。
        lambda: edit(
            IMPORT_WORKER,
            "      // S3.3 收口：两条直连车道都不合格",
            "      job.message = \"维护路径：正在创建项目级备份并校验现有数据（该批次未走直连车道）\";\n"
            "      // S3.3 收口：两条直连车道都不合格",
        ),
        COPY_GATE,
        "removed legacy status copy is back in server sync source",
    ),
    # --- 2026-09-23：§14「成功收尾的单事务提交」+ §10k 孤儿守卫 + §15 判据下限 --------------
    # 这 8 条的名字都带 `[本轮新增]` 前缀，便于 `RAI_MUTATION_ONLY=本轮新增` 单独复跑。
    (
        "[本轮新增] 判据非空转: 把 clearTask 的声明改名 => `tail_after` 的锚点必须显式报失败，"
        "而不是把整片源码当成函数体（旧门禁在这里是**静默绿**）",
        lambda: edit(SYNC, "private func clearTask()", "private func clearTaskRenamed()"),
        PY_GATE,
        "clearTask(): anchor",
    ),
    (
        "[本轮新增] 判据非空转: 把 performSync 的声明改名 => 依赖它的判据必须显式报失败"
        "（旧形态是整条判据被跳过，总数少一而输出里没有 FAIL:）",
        lambda: edit(SYNC, "private func performSync(", "private func performSyncRenamed("),
        PY_GATE,
        "performSync(: anchor",
    ),
    (
        "[本轮新增] 判据: 提交前回读断言整段删掉 => 静默失败的写入会留下旧锚 + 没有任务行，还报成功",
        lambda: edit(
            SYNC_TASK_STORE,
            "        guard readBackMatches(scope: scope, before: before, anchor: anchor, watermark: watermark) else {\n"
            '            lastError = "同步水位写入后无法读回一致的值，本次提交已回滚。"\n'
            "            return false\n"
            "        }\n",
            "        // read-back assertion removed by mutation\n",
        ),
        PY_GATE,
        "no longer reads its own write back before COMMIT",
    ),
    (
        "[本轮新增] 判据: 把 `removed == 1` 改成恒真的 `>= 0` => 只数 `sqlite3_changes(` 调用次数"
        "看不出来（实测过：那条旧判据照样绿）",
        lambda: edit(
            SYNC_TASK_STORE,
            "guard removed == 1 else {",
            "guard removed >= 0 else {",
        ),
        PY_GATE,
        "no longer requires exactly one removed row",
    ),
    (
        "[本轮新增] 判据: 回读断言改成比「请求的水位」而不是单调值 => 合法的一次向前提交被判成失败回滚",
        lambda: edit(
            SYNC_TASK_STORE,
            "let expected = before?.exportEnd.map { max($0, requested) } ?? requested",
            "let expected = requested",
        ),
        PY_GATE,
        "requested value instead of the monotonic one",
    ),
    (
        "[本轮新增3] 🔴 回归: 取消水位落盘前的 REAL 规范化（拿掉 `storedInREAL`）=> "
        "一次**完全成功的**提交被自己的回读断言判失败并整段回滚 —— 2026-09-24 真机故障的形状。"
        "注意结构门禁也会红（它钉了调用点），这里要的是**可跑的回归**也红得起",
        lambda: edit(
            SYNC_TASK_STORE,
            "let watermark = requested.storedInREAL",
            "let watermark = requested",
        ),
        SWIFT_GATE,
        "a watermark that cannot survive the REAL round trip still commits",
    ),
    (
        "[本轮新增3] 🔴 回归: 取消 route 状态落盘前的 REAL 规范化 => 整批 route 状态被回读断言"
        "判失败（同一根因的另一半：`routeNow = Date()` 一样带小数秒）",
        lambda: edit(
            SYNC_TASK_STORE,
            "                workoutEndDate: record.workoutEndDate.canonicalForREAL,",
            "                workoutEndDate: record.workoutEndDate,",
        ),
        SWIFT_GATE,
        "a route state whose dates cannot survive the REAL round trip still commits",
    ),
    (
        "[本轮新增] 回归: mayCommit 恒真 => 阻塞态会推进 anchor。**结构门禁在这里是绿的**"
        "（它只钉调用顺序），红的必须是可跑的那条回归",
        lambda: edit(SYNC_STATE_PLAN, "SyncPhase.mayAdvanceAnchor(phase)", "true"),
        SWIFT_GATE,
        "mayCommit disagrees with isBlocked",
    ),
    (
        "[本轮新增] 反孤儿: 从 run-health-sync-tests.sh 摘掉 SyncStateCommitRegression => "
        "文件还在、门禁全绿，而那一组不变式再没人执行",
        # ⚠️ 必须替换**不带扩展名**的那一段：判据用的是子串匹配（`required in runner`），
        # 改成 `…Regression.swift.disabled` 照样含 `.swift` 子串 ⇒ 那条突变根本无效（实测过，绿）。
        lambda: edit(
            HEALTH_SYNC_RUNNER,
            "SyncStateCommitRegression",
            "SyncStateCommitRegressionDisabled",
        ),
        PY_GATE,
        "does not compile/run SyncStateCommitRegression.swift",
    ),
    # --- 2026-09-23 第二批：Workout 伴生 Route 状态机（按 workout 定频） --------------------
    # 名字统一带 `[本轮新增2]` 前缀，便于 `RAI_MUTATION_ONLY=本轮新增2` 单独复跑。
    #
    # 这一批挑的都是"**收益归零**"或"**数据静默丢在服务端之外**"两类失效 —— 它们都不会报错、
    # 不会崩、也大多不会让现有回归变红，只会让这次改造白做，或者少一批轨迹。
    (
        "[第三轮] 判据: 在最终闸门之前插一次 routeEntries => 过滤晚于查询，节省归零而全部门禁照绿",
        lambda: edit(
            HEALTH_EXPORT,
            "            let queryDecision = RouteQueryPolicy.decide(",
            "            _ = routeEntries\n            let queryDecision = RouteQueryPolicy.decide(",
        ),
        PY_GATE,
        "the route query happens BEFORE the final gate is consulted",
    ),
    (
        "[B01] 判据: 把路线结算挪到 commitSuccess **之前** => 一次从未交付的同步也会被记成"
        "「这条轨迹已经稳定」，之后一路降到 settled，错过及时补齐窗口",
        lambda: edit(
            SYNC,
            "        let routeSettlement = routeCommit.flatMap { try? JSONEncoder().encode($0) }",
            "        _ = settlePendingRouteCommit()\n"
            "        let routeSettlement = routeCommit.flatMap { try? JSONEncoder().encode($0) }",
        ),
        PY_GATE,
        "the route settlement must run AFTER the durable commit",
    ),
    (
        "[B02] 最终闸门不再喂入待办（`todo: nil`）=> blocked-size / 未到期 retry-wait 对任何"
        "发现来源都不再生效：近期回填或正式页变更一到就重读同一份装不下的 GPX",
        lambda: edit(
            HEALTH_EXPORT,
            "                todo: pendingTodoByUUID[routeKey],",
            "                todo: nil,",
        ),
        PY_GATE,
        "the final gate must be fed the persisted todo for this UUID",
    ),
    (
        "[本轮新增2] 判据: manifest 的 sourceScope 改成 full-snapshot => 服务端对省略的 GPX "
        "从「不在这一份增量里」变成「已被删除」，跳过一条 route 就等于把它删掉",
        lambda: edit(HEALTH_EXPORT, '"sourceScope": "healthkit",', '"sourceScope": "full-snapshot",'),
        PY_GATE,
        "no longer declares sourceScope healthkit",
    ),
    (
        "[本轮新增2] 判据: 导出前不再读伴生状态快照 => 每个 workout 都被当成首查，整个改动静默失效",
        lambda: edit(
            SYNC,
            "let routeStates = taskStore.loadRouteStates(scope: activeScope)",
            "let routeStates: [String: RouteSyncRecord] = [:]",
        ),
        PY_GATE,
        "no longer loads the route state snapshot",
    ),
    (
        "[本轮新增2] 判据: 删掉批量写的事务内回读断言 => 「我写进去了」又只是一句假设",
        lambda: edit(
            SYNC_TASK_STORE,
            "        let written = loadRouteStates(scope: scope, uuids: records.map(\\.workoutUUID))\n",
            "        let written: [String: RouteSyncRecord] = [:]\n",
        ),
        PY_GATE,
        "pre-COMMIT read-back assertion is gone from the route state batch",
    ),
    (
        "[本轮新增2] 回归: 跳过的那一轮也把 lastCheckedAt 盖上「现在」=> 12 小时的节流窗口被一轮轮"
        "往后推，而「这一次没读」被记成了「查过、而且没变化」",
        lambda: edit(
            ROUTE_SYNC_MACHINE,
            "            return Decision(shouldQuery: needsQuery, nextState: existing)",
            "            var carried = existing\n"
            "            carried.lastCheckedAt = now\n"
            "            return Decision(shouldQuery: needsQuery, nextState: carried)",
        ),
        SWIFT_GATE,
        "a skipped round carries the record over byte for byte",
    ),
    (
        "[本轮新增2] 回归: cooling 的 12 小时节流改成恒真 => 冷却期每次同步都查，降频收益全部作废",
        lambda: edit(
            ROUTE_SYNC_MACHINE,
            "return now.timeIntervalSince(existing.lastCheckedAt) >= coolingInterval",
            "return true",
        ),
        SWIFT_GATE,
        "just under 12h the cooling route is skipped",
    ),
    (
        "[本轮新增2] 回归: 批量写不再 BEGIN IMMEDIATE => 半批落盘成为可能。**它红在第一条断言上**"
        "（`upsertRouteStates` 直接返回 false）而不是「回滚」那一条，这一点本身值得记：没有事务时"
        "`COMMIT` 会自己报「no transaction is active」，于是这次写入**报失败、行却已经落下** —— "
        "正是这个形态让「我以为没写」和「其实写了」分不开（本仓 2026-09-23 实测）",
        lambda: edit(
            SYNC_TASK_STORE,
            'guard SQLiteSupport.execute("BEGIN IMMEDIATE", database: database) else {\n'
            '            fail("route state begin"); return false\n'
            "        }",
            'guard SQLiteSupport.execute("SELECT 1", database: database) else {\n'
            '            fail("route state begin"); return false\n'
            "        }",
        ),
        SWIFT_GATE,
        "a batch of three distinct workouts writes in one transaction",
    ),
    (
        "[本轮新增2] 反孤儿: 从 run-health-sync-tests.sh 摘掉 RouteSyncStatePersistenceRegression "
        "=> 文件还在、门禁全绿，而「跨进程记得住 / 单事务 / NULL 与空串分得开」再没人执行",
        # 同上一批的教训：判据是子串匹配，改成 `….swift.disabled` 照样含 `.swift` ⇒ 突变无效。
        lambda: edit(
            HEALTH_SYNC_RUNNER,
            "RouteSyncStatePersistenceRegression",
            "RouteSyncStatePersistenceRegressionDisabled",
        ),
        PY_GATE,
        "does not compile/run RouteSyncStatePersistenceRegression.swift",
    ),
    (
        "[本轮新增2] 反孤儿: 从 run-health-sync-tests.sh 摘掉 RouteSyncStateMachineTests => "
        "四态判据（含「跳过不产生稳定证据」那条不变式）再没人执行",
        lambda: edit(
            HEALTH_SYNC_RUNNER,
            "RouteSyncStateMachineTests",
            "RouteSyncStateMachineTestsDisabled",
        ),
        PY_GATE,
        "does not compile/run RouteSyncStateMachineTests.swift",
    ),
    (
        "[本轮新增2] 判据: 从 run-store-tests.sh 摘掉 RouteSyncState.swift => 那个编译单元会炸在"
        "「cannot find type 'RouteSyncRecord' in scope」上，而**全量类型检查照样绿**"
        "（本轮实测踩过两次，所以这条判据是被真实故障逼出来的）",
        lambda: edit(STORE_RUNNER, "  apps/ios/RAI/RouteSyncState.swift \\\n", ""),
        PY_GATE,
        "run-store-tests.sh compiles SyncTaskStore.swift without RouteSyncState.swift",
    ),
    # ---- [P4] 门禁有效性：HealthKit 记录同步 v2 的两个新门禁（2026-10-09，审查 🟡4）--------
    # 缺陷形态：`check-health-sync-archive.py` / `check-healthkit-record-sync.py` 的**执行**有
    # （`run-health-sync-tests.sh:28 / :164`），但**没有任何一条突变是为它们的断言设计的** ⇒
    # “改坏了它们会红”从未被任何常驻机制证明过（ADR-004 三层表里“突变验证”缺的一角）。
    #
    # ⚠️ 选 mutation 的约束（2026-10-09 实测踩过）：这两个 python 门禁跑在 `SWIFT_GATE` 的**末尾**，
    # 而该脚本是 `set -e`。所以突变必须满足「**Swift 部分照样绿**、只有 python 门禁能抓」——
    # 否则 Swift 回归先失败，脚本根本走不到 python 门禁，`assertion_hit=False`（这类突变在报告里
    # 是 BAD，不能留）。反例（都已实测排除，别再加回来）：
    #   · 拿掉 `HealthSyncArchive` 的 `nonisolated` ⇒ Swift 归档回归先红
    #     （`file work blocked MainActor until the worker timed out`）；
    #   · 把 `read(upToCount: chunkSize)` 换成常量 ⇒ Swift 归档回归先红
    #     （`ZIP was not processed in complete chunks`）。
    # 下面三条都改**行为**（不是改名/换写法）而 Swift 侧不覆盖：
    (
        "[P4] 结构门禁: 归档写进 iCloud 备份 => 大 ZIP 被备份拖走",
        lambda: edit(
            HEALTH_ARCHIVE,
            "isExcludedFromBackup = true",
            "isExcludedFromBackup = false",
        ),
        SWIFT_GATE,
        "persistent archive entered backups",
    ),
    (
        "[P4] 结构门禁: 记录删除挪到原子提交之后 => 删除不再落在同一个原子导入事务里",
        # 改的是 TS；`run-health-sync-tests.sh` **不编译 TS**，所以只有 python 记录同步门禁
        # 能抓它（断言是"删除必须出现在原子提交之前"）。
        #
        # 2026-10-14 重锚点：旧形态把"删除块整体下移"写成一段**跨到提交行的旧文本**，而这段
        # 区间此后长出了 recordDelta 预提交断言与 callerOwned 分支（7a6408a / 6ee6b8c），
        # 旧文本失配 ⇒ 这条突变以 `stale pattern` 失败、什么都没验到（harness 会继续跑，
        # 但整轮结论不干净）。两处小 edit 实现**同一次搬移**：单段锚点在这里不可行 ——
        # 欲搬移的两端相距 50 行，一段 50 行的旧文本只会更脆、更容易再次失配。
        #   ① 原调用点换成占位计数（保住 `removedHealthKitRecords` 的后续引用）；
        #   ② 提交语句之后补上真正的删除调用（此刻它在文本上落在提交之后 ⇒ 门禁该红）。
        # 本机实证（2026-10-14）：应用后 `check-healthkit-record-sync.py` 43 checks 恰 1 红
        # 且命中下方断言；`npm run typecheck` 0 错（语义型突变，非编译型）。
        lambda: (
            edit(
                HEALTH_PARSER,
                "    const removedHealthKitRecords = recordDeletions.length\n"
                "      ? store.removeHealthKitRecords(recordDeletions, options.incremental?.batchId, entityGeneration,\n"
                "        options.recordDelta ? { currentBatchOnly: true } : undefined) : 0;\n",
                "    const removedHealthKitRecords = 0;\n",
            ),
            edit(
                HEALTH_PARSER,
                "    } else if (atomic) store.commitAtomicImport();\n"
                "    else store.flush();\n",
                "    } else if (atomic) store.commitAtomicImport();\n"
                "    else store.flush();\n"
                "    if (recordDeletions.length) {\n"
                "      store.removeHealthKitRecords(recordDeletions, options.incremental?.batchId, entityGeneration,\n"
                "        options.recordDelta ? { currentBatchOnly: true } : undefined);\n"
                "    }\n",
            ),
        ),
        SWIFT_GATE,
        "record deletions must be applied before the atomic import commits",
    ),
    (
        "[P4] 结构门禁: 导出清单退回 version 1 => 服务端按旧协议读 v2 载荷",
        lambda: edit(
            HEALTH_EXPORT,
            '"version": 2,',
            '"version": 1,',
        ),
        SWIFT_GATE,
        "the export manifest must be v2 and carry the record deletions",
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


def source_digests() -> list[dict[str, str]]:
    """`SOURCES` 的**跑前**字节摘要，取自 `var/mutation-backup/`，供 JSON 摘要跨轮 diff。

    取备份、不取工作区：整轮运行期间工作区是脏的（正在被突变改写），只有备份代表
    "这一轮开始时源码长什么样"。下一轮把这些摘要和自己比，就能发现
    "某个受管文件在两次运行之间被动过" —— 那是所有判据结论的前提条件。
    """
    out: list[dict[str, str]] = []
    for rel in SOURCES:
        candidate = backup_dir / Path(rel).name
        out.append({
            "path": rel,
            "sha256": hashlib.sha256(candidate.read_bytes()).hexdigest() if candidate.exists() else None,
        })
    return out


def emit_json(path: Path, payload: dict[str, object]) -> None:
    """把机器可读摘要写到 `path`（路径由 `RAI_MUTATION_JSON` 指定）。

    为什么要有它：`deliverables/` 需要一份**可 diff** 的回归锚点。日志是给人看的
    （几千行、含 tail 片段），JSON 是给下一轮比的 —— 少了它，"这次和上次哪里不一样"
    只能靠肉眼逐行比日志。
    `indent=2` / 不排序键 / 末尾换行：让 diff 逐行可读、且不出现"只有换行差异"的噪音。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    print("json summary written: %s" % path)


def print_tail(out: str) -> None:
    for line in [l for l in out.strip().splitlines() if l.strip()][-8:]:
        print("        " + line)


def main() -> int:
    failures: list[str] = []
    selector = os.environ.get("RAI_MUTATION_ONLY", "").strip()
    raw_scope = os.environ.get("RAI_MUTATION_FOR", "").strip()
    changed = scope_changed_paths(raw_scope) if raw_scope else []
    if raw_scope and not changed:
        # 「范围是空的」绝不能变成"全跳过、然后退出 0" —— 那是一条静默的假绿。
        print("RAI_MUTATION_FOR=%r resolved to no file inside the repository; refusing to scope"
              % raw_scope)
        return 1
    scope_gates: list[str] = []
    if raw_scope:
        print("scope: %d changed file(s): %s" % (len(changed), ", ".join(changed)))
        # 取**并集**，不是按 `target` 求交集：改动文件落在这个门禁的输入里，该门禁名下的
        # **全部**突变都可能被它改变判定，必须一起跑。
        scope_gates = [
            gate for gate in MUTATION_GATES
            if any(in_scope(entry, changed) for entry in gate_inputs(gate))
        ]
        for gate in scope_gates:
            print("scope:     %s" % gate)
        if not scope_gates:
            print("scope: none of the %d mutation gates reads any of these files"
                  % len(MUTATION_GATES))
    selected = [
        mutation for mutation in MUTATIONS
        if (not selector or selector in mutation[0])
        and (not raw_scope or mutation[2] in scope_gates)
    ]

    raw_json = os.environ.get("RAI_MUTATION_JSON", "").strip()
    json_target: Path | None = None
    if raw_json:
        candidate = Path(raw_json)
        json_target = candidate if candidate.is_absolute() else (ROOT / candidate)

    records: list[dict[str, object]] = []
    control: dict[str, object] | None = None
    baseline: dict[str, object] = {"exit": None, "green": False}
    restored: dict[str, object] = {"exit": None, "green": False}
    pristine: list[dict[str, str]] = []

    def emit() -> None:
        """写机器可读摘要。

        `partial` 与 `filter` 必须显式出现在产物里：分段跑的命令行与全套**一模一样**，
        只有输出末尾一行措辞不同。若 JSON 里不带这个字段，一份 `RAI_MUTATION_ONLY` 的产物
        与全套产物在机器眼里毫无区别 —— 那正是"分段跑被读成全套通过"的复发路径。
        按改动裁剪（`RAI_MUTATION_FOR`）走的是同一条纪律：`partial` 必须由它**一并**置位，
        另加 `scope` 记下"这次凭什么只跑了这些条"（改了哪些文件、命中哪些门禁）。
        """
        if json_target is None:
            return
        # 分布覆盖**每一条跑过的条目**（含负向对照），这样它与日志里 `verdict=` 的行数
        # 逐一对得上；否则"74 mutations"和 75 行 verdict 会被读成互相矛盾。
        distribution: dict[str, int] = {}
        for entry in records + ([control] if control is not None else []):
            key = str(entry.get("verdict"))
            distribution[key] = distribution.get(key, 0) + 1
        emit_json(json_target, {
            "schema": "rai.mutation-summary/1",
            "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "harness": "apps/ios/tests/check-background-mutations.py",
            "command": "RAI_MUTATION_JSON=%s python3 apps/ios/tests/check-background-mutations.py"
                       % (raw_json,),
            "filter": selector or None,
            "scope": ({"changed": changed, "gates": scope_gates} if raw_scope else None),
            "partial": bool(selector or raw_scope),
            "baseline": baseline,
            "restored": restored,
            "totals": {
                "mutations_defined": len(MUTATIONS),
                "mutations_selected": len(selected),
                "failed": len(failures),
                "verdict_distribution": distribution,
            },
            "mutations": records,
            "negative_control": control,
            "sources": pristine,
            "failures": failures,
        })

    def partial_label() -> str:
        """裁剪/分段跑时结论行里那串限定语。两处出口共用，措辞不许分叉。"""
        return ", ".join(
            item for item in (
                "filter=%r" % selector if selector else "",
                "scope=%d changed file(s)" % len(changed) if raw_scope else "",
            ) if item
        )

    recover_leftover_backup()
    install_signal_handlers()

    # 「过滤器拼错了」与「这次改动确实与这些判据无关」是两件事，退出码必须分开：
    # 前者是用户错误（1）；后者不是失败，但也**不是通过** —— 它会跑基线、然后明说"什么都没验"。
    scope_empty = False
    if not selected:
        if not raw_scope or selector:
            print("no mutation matched RAI_MUTATION_ONLY=%r; nothing to do" % selector)
            return 1
        scope_empty = True

    backup_dir.mkdir(parents=True, exist_ok=True)
    for rel in SOURCES:
        shutil.copy2(ROOT / rel, backup_dir / Path(rel).name)
    marker.write_text("sources under mutation; delete only after restoring\n", encoding="utf-8")
    pristine = source_digests()

    try:
        code, out = run(CLEAN)
        baseline = {"exit": code, "green": code == 0}
        print("baseline: exit=%d %s" % (code, "GREEN" if code == 0 else "NOT GREEN"))
        if code != 0:
            print_tail(out)
            emit()
            return 1
        if selector:
            print("selected: %d of %d mutations (RAI_MUTATION_ONLY=%r)" % (len(selected), len(MUTATIONS), selector))
        if raw_scope:
            print("selected: %d of %d mutations (scope: %d changed file(s) fell into %d gate(s))"
                  % (len(selected), len(MUTATIONS), len(changed), len(scope_gates)))

        if scope_empty:
            # 基线照跑（"当前仓库是绿的"这个前提不能被跳过），但没有任何突变会被施加，
            # 所以负向对照与"还原后回绿"都没有对象 —— 不跑，也不假装跑过。
            print()
            print("NO MUTATION TOUCHES THE CHANGED FILES — nothing was verified in this run.")
            print("  This does not say the judges still catch regressions; it only says these")
            print("  changes cannot have invalidated any of the %d mutations." % len(MUTATIONS))
            restored = {"exit": None, "green": False, "skipped": "no mutation was applied"}
            print()
            print("mutation check (PARTIAL, %s): 0 of %d mutations, 0 failed"
                  % (partial_label(), len(MUTATIONS)))
            print("  ^^^ 这一行不是「通过」：本次一条突变都没施加，判据有效性未被验证。")
            emit()
            return 0
        print()

        for index, (name, apply, gate, needle) in enumerate(selected, start=1):
            restore()
            # 记录壳先建好再 `append`：`base` 是可变字典，随后就地更新即可同步进 records。
            base: dict[str, object] = {
                "index": index, "name": name, "target": [], "gate": gate,
                "verdict": None, "exit": None, "assertion_hit": None, "ok": False,
                "expected_assertion": needle,
            }
            records.append(base)
            _edited.clear()
            # 锚点过期（源码改过、模式不再唯一）**不能**让整个 harness 停下来：
            # 那会把"这一条没验到"伪装成"后面都没问题"。记成失败并继续。
            try:
                apply()
            except SystemExit as error:
                base["note"] = "stale pattern: this judge was never exercised"
                print("  BAD " + name)
                print("        mutation pattern is stale, so this judge was never exercised")
                print_tail(str(error))
                failures.append(name + " (stale pattern)")
                continue
            base["target"] = list(_edited)
            code, out = run(gate)
            verdict = classify(code, out)
            hit = needle in out
            ok = verdict == "RED" and hit
            base.update({"verdict": verdict, "exit": code, "assertion_hit": hit, "ok": ok})
            print(("  OK  " if ok else "  BAD ") + name)
            print("        exit=%d verdict=%s assertion_hit=%s" % (code, verdict, hit))
            if not ok:
                failures.append(name)
                print_tail(out)

        nc_name, nc_apply, nc_gate = NEGATIVE_CONTROL
        restore()
        control = {
            "name": nc_name, "target": [], "gate": nc_gate, "verdict": None,
            "exit": None, "resolved_by": None, "ok": False, "expected_verdict": "COMPILE-ERROR",
        }
        _edited.clear()
        try:
            nc_apply()
        except SystemExit as error:
            # 分类器没被验证过这件事必须**显式记成失败**，而不是静默跳过 ——
            # 静默跳过会让"排除了突变其实是编译错误"这个结论失去依据。
            control["note"] = "stale pattern: the classifier was never exercised"
            control["resolved_by"] = "stale-pattern"
            print("  BAD " + nc_name)
            print_tail(str(error))
            failures.append(nc_name + " (stale pattern)")
            code, out = 0, ""
        else:
            control["target"] = list(_edited)
            control["resolved_by"] = "ran"
            code, out = run(nc_gate)
        verdict = classify(code, out)
        ok = verdict == "COMPILE-ERROR"
        control.update({"verdict": verdict, "exit": code, "ok": ok})
        print(("  OK  " if ok else "  BAD ") + nc_name)
        print("        exit=%d verdict=%s" % (code, verdict))
        if not ok:
            failures.append(nc_name)
            print_tail(out)

        restore()
        code, out = run(CLEAN)
        restored = {"exit": code, "green": code == 0}
        print()
        print("restored: exit=%d %s" % (code, "GREEN" if code == 0 else "NOT GREEN"))
        if code != 0:
            failures.append("restore did not return to green")
            print_tail(out)
    finally:
        finish()

    print()
    if selector or raw_scope:
        # 用**不同的措辞**报结论：分段跑的输出绝不能被读成"全套通过"。
        scope_note = partial_label()
        print("mutation check (PARTIAL, %s): %d of %d mutations, %d failed"
              % (scope_note, len(selected), len(MUTATIONS), len(failures)))
    else:
        print("mutation check: %d mutations, %d failed" % (len(MUTATIONS), len(failures)))
    emit()
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--dump-gate-inputs":
        sys.exit(dump_gate_inputs(sys.argv[2]))
    sys.exit(main())
