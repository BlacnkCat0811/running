"""PR5 读侧一致性（S3–S6）的源码级判据。

依据 `docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md`：
  * §2 D1 —— `currentFacts` / `publishedAnalysis` 两块：顶层**可空**字段、块内不许跨域；
  * §2 D2 —— 新鲜度只派生、不新增存储；
  * §4 C2 —— 事实块的行**键集**不含任何分析来源字段（键集断言，不是值断言）；
  * §4 C9 —— 旧字段语义未变（本脚本负责它能在本机跑的那一半）。

## 为什么需要这支脚本（而不是靠测试）
三件"改错了照样编译通过、测试也可能仍然绿"的事：
1. C2 是**键集**约束。JSON 序列化是按需拼装 `apps/api/src/data.ts` 的响应对象的，
   多塞一个 `currentAbility` 不会有类型错误（行类型允许可选字段），只会在**用户面前**
   把旧分数和当前事实混在一起 —— §9.1 点名的正是这个形态。
2. C9 的"旧字段逐字节不变"里，**可选性**是承重的：把某个 `?:` 改成 `:`
   **键集完全不变**，纯键集判据照样绿，而老客户端 `decodeIfPresent` 换成必填即 decode 失败
   （§1.2 锚点 21 已为此付过一次代价）。
3. 能力位**命名**：两块视图的能力位若复用 `factsAnalysisContractVersion`（已被直连原始
   回执占用），客户端的 guard 就会保护错东西 —— 一个标识符承担两种协商含义。

## 本机可跑
纯文本、只读、显式 UTF-8、退出码 0/1、失败逐条打印。**不执行 Swift、不连数据库。**
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

try:  # Windows 控制台默认 cp936 会把中文失败原因打成乱码，失败原因必须可读
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):  # pragma: no cover - 非标准流
    pass

ROOT = Path(__file__).resolve().parents[3]

CONTRACTS = "packages/api-contracts/src/index.ts"
# 🔴 两块视图的**形状住在 `@rai/contracts`**（包边界：`storage-sqlite` 不依赖 `api-contracts`，
# 所以形状不能留在 API 层）。`api-contracts` 只做转发。判据因此必须**两个文件都扫**，
# 而且要把"同名接口在两处各声明一次"当成失败 —— 那正是本次搬迁最容易留下的形态。
SHARED_VIEWS = "packages/contracts/src/facts-analysis-view.ts"
# 🔴 基线必须**入库**（2026-10-19 修复）：旧路径 `var/reports/pr5-c9-baseline-keys.json`
# 被 `.gitignore` 的 `var/` 忽略，于是干净树永远缺基线 ⇒ 这支判据从未在干净树上绿过，
# 还被当成"预存在失败"。基线是判据的输入，输入不入库等于判据不存在。
# 重新生成用同一支脚本（不要手改）：`python3 apps/ios/tests/check-pr5-facts-analysis.py --write-baseline`
BASELINE = "apps/ios/tests/fixtures/pr5-c9-baseline-keys.json"

# C9 覆盖的三个响应（`docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md` §4 C9）：
# today / workouts / training-plan-state。清单写死在脚本里，基线缺一个 interface 就是失败 ——
# 否则"删掉一条基线"就能把 C9 静默削弱。
C9_INTERFACES = ("WorkoutListResponse", "TrainingPlanStateResponse", "MobileTodayResponse")
SERVER = "apps/api/src/server.ts"
DATA = "apps/api/src/data.ts"

# 直连原始回执能力位：**只能出现在握手响应里，且只有一处字面量**。
# 两块视图的能力位必须是**另一个**名字 —— 见文件头第 3 条。
RECEIPT_CAPABILITY = "factsAnalysisContractVersion"
VIEW_CAPABILITY = "factsAnalysisViewContractVersion"

# C2：事实块的行类型**不许**出现的字段（分析来源那一侧）。
# 取值口径见 §4 C2 与 §2 D5：事实行未分析时显式给 "pending"，
# **不用 null 分数**（null 已表示"分析过但没有值"）。
ANALYSIS_SIDE_KEYS = {
    "currentAbility", "qualityScore", "stimulusType", "stimulusConfidence",
    "confidence", "trueAbilityDelta", "assessmentStatus", "eligibilityStatus",
    "missingReasons", "heartRateZones", "paceZones", "ability",
}
# C2 的另一半：分析块的行类型**不许**出现的当前可变事实字段（§2 D5）。
CURRENT_FACT_KEYS = {
    "indoor", "sourceCategory", "deletedAt", "syncedAt", "importedAt",
    "isCanonical", "canonicalGroupId", "sourceId",
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


def interface_body(text: str, name: str) -> str | None:
    """取 `export interface <name> { ... }` 的**顶层**花括号内容（跳过嵌套）。"""
    match = re.search(r"export interface " + re.escape(name) + r"\s*\{", text)
    if not match:
        return None
    index = match.end()
    depth = 1
    while index < len(text) and depth:
        character = text[index]
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return text[match.end():index]
        index += 1
    return None


def top_level_fields(body: str | None) -> list[tuple[str, bool]]:
    """(字段名, 是否可选)。只收顶层，嵌套对象与内联字面量的键不算。"""
    if body is None:
        return []
    fields: list[tuple[str, bool]] = []
    seen: set[str] = set()
    for line in body.splitlines():
        match = re.match(r"[ \t]*([A-Za-z_][A-Za-z0-9_]*)([ \t]*\??)[ \t]*:", line)
        if not match:
            continue
        name = match.group(1)
        if name in seen:
            continue
        seen.add(name)
        fields.append((name, match.group(2).strip() == "?"))
    return fields


def fields_digest(fields: dict) -> str:
    """基线字段表的内容摘要。

    为什么需要它：C9 的循环只检查"基线里的字段在源码里还在" —— **从基线里删一行**
    就等于静默减少覆盖（本脚本第一版实测：删掉 `WorkoutListResponse.limit` 后仍然全绿）。
    `fieldsSha256` 让"手工删字段"与"重建基线"可区分：重建会重算摘要，手删不会。
    """
    canonical = json.dumps(fields, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def write_baseline() -> None:
    """用**已提交**的契约重建基线（唯一合法来源，不手工编辑 JSON）。

    记录的 `commit` 回答"这份基线来自哪个 revision"，`contractsSha256` 回答"它冻结的是哪份
    TS 字节"——两者都是溯源信息，**不是**每次运行都要相等的判据（合法的新增字段会改字节，
    C9 只允许"加"、不允许"删/改可选性"）。`fieldsSha256` 是**完整性**判据：每次运行都会核对，
    防止"删掉基线里一行"这种静默弱化。
    """
    contracts_path = ROOT / CONTRACTS
    if not contracts_path.is_file():
        sys.exit(f"无法生成基线：找不到 {CONTRACTS}")
    dirty = subprocess.run(
        ["git", "status", "--porcelain", "--", CONTRACTS],
        cwd=ROOT, capture_output=True, text=True,
    ).stdout.strip()
    if dirty:
        sys.exit(f"无法生成基线：{CONTRACTS} 有未提交改动（{dirty}）—— 先提交再生成，"
                 f"否则基线记录的 commit 与内容不符")
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True
    ).stdout.strip()
    if not revision:
        sys.exit("无法生成基线：`git rev-parse HEAD` 失败 —— C9 基线必须来自已提交的 revision")
    text = contracts_path.read_text(encoding="utf-8")
    fields: dict = {}
    for name in C9_INTERFACES:
        body = interface_body(text, name)
        if body is None:
            sys.exit(f"无法生成基线：{CONTRACTS} 里找不到 {name}")
        fields[name] = [[field, optional] for field, optional in top_level_fields(body)]
    payload = {
        "commit": revision,
        "contractsSha256": hashlib.sha256(contracts_path.read_bytes()).hexdigest(),
        "fieldsSha256": fields_digest(fields),
        "fields": fields,
    }
    target = ROOT / BASELINE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {BASELINE} @ {revision}（{len(fields)} 个 interface：{', '.join(sorted(fields))}）")


if "--write-baseline" in sys.argv[1:]:
    write_baseline()
    sys.exit(0)


# --- 1. C9：旧字段的键集**与可选性**都必须与基线一致 ---------------------------

baseline_text = read_source(BASELINE)
baseline: dict = {}
if baseline_text:
    try:
        baseline = json.loads(baseline_text)
    except json.JSONDecodeError as error:
        failures.append(f"{BASELINE} is not valid JSON: {error}")

contracts_text = read_source(CONTRACTS)
views_text = read_source(SHARED_VIEWS)
baseline_fields: dict = baseline.get("fields", {}) if isinstance(baseline, dict) else {}
if not isinstance(baseline_fields, dict):
    # 坏 JSON 形状要**说出来**，不能让后面的 `.items()` 直接抛栈（栈追踪读起来像脚本坏了，
    # 而不是像"基线坏了"）。
    failures.append(f"{BASELINE} 的 fields 必须是对象（实际是 {type(baseline_fields).__name__}）")
    baseline_fields = {}
check(
    bool(baseline_fields),
    f"{BASELINE} carries no baseline fields; regenerate it before trusting C9",
)
# 基线缺一条 interface 就等于 C9 少覆盖一个端点 —— 删基线比删判据更容易被忽略。
check(
    set(C9_INTERFACES) <= set(baseline_fields),
    f"{BASELINE} 缺少 C9 必须覆盖的 interface：{sorted(set(C9_INTERFACES) - set(baseline_fields))}",
)
# 基线被**手工删一行**与"重建基线"必须可区分：前者只是静默减少覆盖，本脚本第一版
# 实测删掉 `WorkoutListResponse.limit` 后仍然全绿。重建（`--write-baseline`）会重算摘要。
check(
    isinstance(baseline, dict) and baseline.get("fieldsSha256") == fields_digest(baseline_fields),
    f"{BASELINE} 的 fieldsSha256 不匹配 —— 基线被手工改过（删字段/改可选性会静默削弱 C9）。"
    f"用 `python3 apps/ios/tests/check-pr5-facts-analysis.py --write-baseline` 重建",
)

for interface_name, expected in sorted(baseline_fields.items()):
    actual = top_level_fields(interface_body(contracts_text, interface_name))
    actual_map = dict(actual)
    expected_map = {name: optional for name, optional in expected}

    missing = [name for name in expected_map if name not in actual_map]
    check(
        not missing,
        f"C9: {interface_name} lost legacy field(s) {missing} — old fields may only be added to",
    )
    # 🔴 可选性：把 `?:` 改成 `:` 时键集**完全不变**，只有这一步抓得住。
    flipped_to_required = [
        name for name, optional in expected_map.items()
        if optional and name in actual_map and not actual_map[name]
    ]
    check(
        not flipped_to_required,
        f"C9: {interface_name} turned optional field(s) {flipped_to_required} into required — "
        f"old clients decode with decodeIfPresent and will fail (PR5 §1.2 anchor 21)",
    )
    flipped_to_optional = [
        name for name, optional in expected_map.items()
        if (not optional) and name in actual_map and actual_map[name]
    ]
    check(
        not flipped_to_optional,
        f"C9: {interface_name} turned required field(s) {flipped_to_optional} into optional — "
        f"that silently changes the response contract",
    )

# 基线必须来自**已提交**的 revision，否则它只是"我今天的快照"。
check(
    isinstance(baseline, dict) and bool(baseline.get("commit")),
    f"{BASELINE} must record the commit it was extracted from",
)

# --- 2. C2：两块的行类型键集不许跨域 ------------------------------------------

for block in ("currentFacts", "publishedAnalysis"):
    # 块本身是**可空顶层字段**（§2 D1：默认 null，不是空对象占位）。
    declared_optional = re.search(
        r"\b" + block + r"\s*\??\s*:", contracts_text
    )
    check(
        declared_optional is not None,
        f"S4 未落地或形状变了：{CONTRACTS} 里找不到 {block} 顶层字段",
    )

facts_rows = [
    name for name in re.findall(r"export interface ([A-Za-z0-9_]+)", views_text)
    if re.search(r"\bFactsView\b|\bFactsRow\b|\bCurrentFacts", name)
]
analysis_rows = [
    name for name in re.findall(r"export interface ([A-Za-z0-9_]+)", views_text)
    if re.search(r"\bAnalysisView\b|\bAnalysisRow\b|\bPublishedAnalysis", name)
]

# 🔴 形状**只许有一个家**：同名接口不得在 shared 与 API 层各声明一次。搬迁最容易留下的
# 就是"两边都留着" —— 那样两边会各自演化，而两边都能编译、都能通过上面那些键集判据。
for name in facts_rows + analysis_rows:
    check(
        not re.search(r"export interface " + re.escape(name) + r"\b", contracts_text),
        f"{name} is declared twice（{SHARED_VIEWS} 与 {CONTRACTS}）—— "
        f"两块视图的形状只许有一个家，重复声明会让两边各自演化",
    )

for name in facts_rows:
    keys = {key for key, _ in top_level_fields(interface_body(views_text, name))}
    leaked = sorted(keys & ANALYSIS_SIDE_KEYS)
    check(
        not leaked,
        f"C2: facts row {name} carries analysis-side key(s) {leaked} — "
        f"the two blocks must have an empty field intersection (PR5 §2 D5)",
    )

for name in analysis_rows:
    keys = {key for key, _ in top_level_fields(interface_body(views_text, name))}
    leaked = sorted(keys & CURRENT_FACT_KEYS)
    check(
        not leaked,
        f"C2: analysis row {name} carries current-fact key(s) {leaked} — "
        f"analysis distances/times must come from the frozen feature rows, not current facts",
    )

# 两块都落地时必须有行类型可查，否则上面的循环是空转。
check(
    bool(facts_rows) or "currentFacts" not in contracts_text,
    "C2: currentFacts is declared but no facts row type could be located — the key-set check is vacuous",
)
check(
    bool(analysis_rows) or "publishedAnalysis" not in contracts_text,
    "C2: publishedAnalysis is declared but no analysis row type could be located — the key-set check is vacuous",
)

# --- 3. 能力位命名：两种协商**不许**共用一个标识符 -----------------------------

literal_sites = [
    (path, index + 1)
    for path in (SERVER, DATA)
    for index, line in enumerate(read_source(path).splitlines())
    if re.search(r"\b" + RECEIPT_CAPABILITY + r"\s*(?::|=)\s*\d", line)
]
check(
    len(literal_sites) == 1,
    f"the direct-sync receipt capability {RECEIPT_CAPABILITY} must have exactly one numeric "
    f"literal site (found {len(literal_sites)}: {literal_sites})",
)
required_declaration = re.search(
    # ⚠️ 名字与类型注解之间**隔着一条 doc 注释**（本仓的 `HandshakeResponse` 就是这样），
    # 所以中间必须是 `[\s\S]{0,400}?` 而不是 `\s*` —— 用 `\s*` 会让这条判据在任何带注释的
    # 字段上**恒绿**（永远匹配不到），而恒绿与恒红一样没有信息量。
    # `[^?]` 是这条判据的全部要点：真有 `?` ⇒ 可选 ⇒ 不命中。
    r"\b" + RECEIPT_CAPABILITY + r"([^?]{0,400}?):\s*number\b(?!\s*\|)",
    read_source(CONTRACTS),
)
check(
    required_declaration is None,
    f"{CONTRACTS} 的 {RECEIPT_CAPABILITY} 必须保持**可选** —— "
    f"改成必填（`?:` → `:`）会让老客户端握手解码失败（PR5 §1.2 锚点 21 的同一条纪律）",
)
check(
    VIEW_CAPABILITY != RECEIPT_CAPABILITY,
    "两块视图的能力位必须另取名字：一个标识符承担两种协商含义会让客户端 guard 保护错东西",
)

print(f"contracts: {CONTRACTS}")
print(f"  C9 baseline: {BASELINE} @ {baseline.get('commit') if isinstance(baseline, dict) else '?'}"
      f"（{len(baseline_fields)} 个 interface，含**可选性**）")
print(f"  C2 rows: facts={facts_rows or '（未落地）'} analysis={analysis_rows or '（未落地）'}")
print(f"  capability: {RECEIPT_CAPABILITY} literal sites={literal_sites}"
      f"；view capability={VIEW_CAPABILITY}")

if failures:
    for reason in failures:
        print(f"FAIL: {reason}")
    print(f"PR5 facts/analysis checks: {checks} checks, {len(failures)} failed")
    sys.exit(1)

print(f"PR5 facts/analysis checks passed ({checks} checks: C9 key set **and optionality**, "
      f"C2 block disjointness, capability naming)")
