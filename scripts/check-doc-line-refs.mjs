#!/usr/bin/env node
/**
 * 文档行号引用核对：把 markdown 里的 `文件:行号` 全部解析出来，打印该行**当前**的内容，
 * 并可与一份基线快照比对，报出**静默漂移**。
 *
 * ## 为什么需要它
 *
 * 文档里的绝对行号会随源码结构改动漂移，而漂移是**静默**的：不报错、测试不覆盖、
 * git 也不提示。2026-09-24 实测：改 `HealthKitSync.swift`（+368/−57）与
 * `SyncTaskStore.swift`（+261/−49）之后，`docs/` 下有 6 处引用指向完全不相干的位置
 * （文档写 `HealthKitSync.swift:506-519` 的 `beginBackgroundTask`，实际已在 `:717-726`）。
 *
 * 2026-09-28 再次实测：同一批 doc 改动把 `TECHNOLOGY_SKIN.md:128` 顶到了**空行**、
 * `:140` 顶到了上一段落 —— 两者都**没有越界**，所以纯"越界检查"看不见它们。
 * 这就是下面第二道判据（基线比对）存在的理由。
 *
 * ## 用法
 *
 *   node scripts/check-doc-line-refs.mjs                      # 核对默认基线文档
 *   node scripts/check-doc-line-refs.mjs --problems-only      # 只列问题（默认也会列漂移）
 *   node scripts/check-doc-line-refs.mjs --write-baseline     # 重新生成基线快照
 *   node scripts/check-doc-line-refs.mjs <markdown 路径…>
 *
 * 基线快照落在文档旁边：`<doc>.md` → `<doc>.linerefs.json`（每处引用记 path/line/当时的行内容）。
 * 改了源文件之后重跑，就会指出"文档当初引的那行，现在写的是别的东西"。
 *
 * ## 判据（两道硬 + 一道告警）
 *
 * 1. **越界 / 路径解析不到** —— 确定的漂移，退出码 1。
 * 2. **内容与基线不符** —— 退出码 2。可能是源文件漂移，也可能是你有意改了文档；
 *    两种情况都要人看一眼，所以它**不**当硬失败、但**必须**非零，否则会被忽略。
 * 3. **锚在空行** —— 只打印告警，不影响退出码。基线里记不到文字 ⇒ 那行将来变成内容、
 *    或整段挪走，都发现不了。实测踩过：`deploy/n100/README.md` 的某处引用锚在空行上。
 * 均无问题时退出码 0。行号不越界、也没基线时，脚本判不了内容对不对（它不懂上下文），
 * 产物是"候选清单 + 当前行内容"，不是"通过/失败"。
 *
 * ## 五个已知的判读陷阱
 *
 * - **文档自己也是被解析对象**：这份脚本的说明文档若要举例说明引用格式，举例写成的
 *   `文件:行号` 会被**当真引用**解析（实测踩过：写了个 999999 的例子，脚本立刻报自己越界）。
 *   凡是举例，都要把文件名与冒号拆开写。
 * - **缩写文件名有歧义**：仓库里有两个 `database.ts`、两个 `nginx-rai.conf`。按 basename
 *   取第一个是**静默选错**，于是"引用对不上"变成**假警报**（2026-09-28 实测踩过）。
 *   `AMBIGUOUS` 是显式映射，改引用风格时同步改它。
 * - **带日期的时点快照不能用来判漂移**：审计/验收文档刻意引用**当时**的行号，回写等于
 *   伪造历史。默认核对范围只含现行基线文档，历史快照请显式传入并自行判读。
 * - **同一份文档里的行号可能分属两个修订**：「改动前后对照」表引用的是**改动前**的行号。
 *   本仓库的基线文档就是这样：§0.3 表与 §6.2 债务清单对齐 **aec32b0**（订正前），
 *   其余（§0.4 / §6.2.1 / 全部代码引用）对齐**当前工作树**。段落里必须标明它对齐哪个提交，
 *   否则任何一次订正都会把这张表变成假警报。脚本只能按当前文件解析，判不了这一点。
 * - **就地改写 ≠ 位移**：改动落在同一行号时（本仓库大量如此），引用数字不变而内容变了。
 *   基线比对会把这类也报出来 —— 那通常是你自己改的，看一眼确认即可。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_DOCS = ["deliverables/ARCHITECTURE_PRODUCT_STATUS_2026-09-28.md"];

/** 同名文件消歧：文档里的缩写写法指向哪一个。 */
const AMBIGUOUS = {
  "database.ts": "packages/storage-sqlite/src/database.ts",
  "nginx-rai.conf": "deploy/nginx-rai.conf",
  "README.md": "README.md",
  "index.ts": "packages/api-contracts/src/index.ts",
  "server.ts": "apps/api/src/server.ts",
};

const EXT = "ts|tsx|swift|sh|py|md|json|css|yml|yaml|conf|sql|toml|mjs|mts|html";
// 路径 + ':' + 逗号/短横分隔的行号列表。例：database.ts:89,1397、HealthKitSync.swift:1003-1026
const REF = new RegExp(
  `([A-Za-z0-9_./-]+\\.(?:${EXT})):((?:\\d+(?:[-–]\\d+)?)(?:\\s*,\\s*\\d+(?:[-–]\\d+)?)*)`,
  "g",
);
const TEXT_LIMIT = 120;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const problemsOnly = argv.includes("--problems-only");
const writeBaseline = argv.includes("--write-baseline");
const docs = argv.filter((a) => !a.startsWith("--"));
if (docs.length === 0) docs.push(...DEFAULT_DOCS);

const tracked = new Set(
  execFileSync("git", ["ls-files"], { cwd: root, maxBuffer: 1 << 28 })
    .toString()
    .split("\n")
    .filter(Boolean),
);
const byBase = new Map();
for (const path of tracked) {
  const list = byBase.get(basename(path)) ?? [];
  list.push(path);
  byBase.set(basename(path), list);
}

function resolveRef(file) {
  if (tracked.has(file)) return [file];
  const suffixed = [...tracked].filter((path) => path.endsWith("/" + file));
  if (suffixed.length === 1) return suffixed;
  const mapped = AMBIGUOUS[file];
  if (mapped && tracked.has(mapped)) return [mapped];
  return suffixed.length > 0 ? suffixed : (byBase.get(basename(file)) ?? []);
}

const lineCache = new Map();
function linesOf(path) {
  let lines = lineCache.get(path);
  if (lines === undefined) {
    try {
      lines = readFileSync(join(root, path), "utf8").split("\n");
    } catch {
      lines = null; // 路径来自 git ls-files，读不到只可能是工作区被删；按越界处理。
    }
    lineCache.set(path, lines);
  }
  return lines;
}

/** 取该行原文；行号越界或文件读不到时返回 null。 */
function lineAt(path, number) {
  const lines = linesOf(path);
  if (lines === null) return null;
  return number >= 1 && number <= lines.length ? lines[number - 1] : null;
}

const baselinePathOf = (doc) => doc.replace(/\.md$/, "") + ".linerefs.json";

let total = 0;
let hard = 0;
let drifted = 0;
let blank = 0;
let written = 0;

for (const doc of docs) {
  const text = readFileSync(join(root, doc), "utf8");
  const seen = new Set();
  const rows = [];
  for (const [, file, numbers] of text.matchAll(REF)) {
    for (const raw of numbers.split(",")) {
      const key = `${file}:${raw.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [from, to] = raw.trim().split(/[-–]/).map((n) => Number.parseInt(n, 10));
      rows.push({ key, file, from, to });
    }
  }

  const baselinePath = baselinePathOf(doc);
  const absoluteBaseline = join(root, baselinePath);
  let baseline = null;
  if (!writeBaseline && existsSync(absoluteBaseline)) {
    try {
      baseline = JSON.parse(readFileSync(absoluteBaseline, "utf8")).refs ?? null;
    } catch {
      baseline = null;
    }
  }

  const docProblems = [];
  const docDrift = [];
  const blankAnchors = [];
  const snapshot = {};
  for (const row of rows) {
    const candidates = resolveRef(row.file);
    if (candidates.length === 0) {
      docProblems.push(`❓ 无法解析路径   ${row.key}`);
      continue;
    }
    const [path, ...rest] = candidates;
    const head = lineAt(path, row.from);
    // row.to === undefined ⇒ tail 是 undefined（没有区间），不能和"越界返回的 null"混用同一个哨兵值。
    const tail = row.to === undefined ? undefined : lineAt(path, row.to);
    if (head === null || tail === null) {
      docProblems.push(`🚨 行号越界       ${row.key.padEnd(44)} -> ${path}`);
      continue;
    }
    const note = rest.length > 0 ? `  ⚠️ 同名 ${candidates.length} 个，取第一个` : "";
    const current = head.trim().slice(0, TEXT_LIMIT);
    snapshot[row.key] = { path, line: row.from, text: current };

    // 锚在空行上 ⇒ 基线里记不到任何文字，未来那行变成内容或整段挪走都发现不了。
    // 实测踩过（deploy/n100/README.md 的 :170 是空行）。只告警，不算硬失败。
    if (current === "") blankAnchors.push(`${row.key.padEnd(44)} -> ${path}`);

    const previous = baseline?.[row.key];
    if (previous && (previous.path !== path || previous.text !== current)) {
      docDrift.push({ key: row.key, path, previous, current });
      continue;
    }

    if (problemsOnly) continue;
    console.log(`${row.key.padEnd(44)} -> ${path}${note}`);
    console.log(`    ${row.from}: ${head.trim().slice(0, 100)}`);
    if (row.to !== undefined) console.log(`    ${row.to}: ${tail.trim().slice(0, 100)}`);
  }

  total += rows.length;
  hard += docProblems.length;
  drifted += docDrift.length;
  blank += blankAnchors.length;
  for (const problem of docProblems) console.log(problem);
  for (const entry of docDrift) {
    console.log(`🟡 内容已漂移     ${entry.key.padEnd(44)} -> ${entry.path}`);
    console.log(`     基线: ${entry.previous.text}`);
    console.log(`     现在: ${entry.current}`);
  }
  for (const key of blankAnchors) console.log(`🟠 锚在空行       ${key}`);

  const parts = [`${rows.length} 处引用`, `${docProblems.length} 处越界/无法解析`];
  if (baseline) parts.push(`${docDrift.length} 处内容漂移（对基线）`);
  if (blankAnchors.length > 0) parts.push(`${blankAnchors.length} 处锚在空行（告警）`);
  console.log(`${doc}: ${parts.join("，")}${problemsOnly ? "（--problems-only）" : ""}`);

  if (writeBaseline) {
    const keys = Object.keys(snapshot).sort();
    const ordered = {};
    for (const key of keys) ordered[key] = snapshot[key];
    const payload = {
      doc,
      note: "由 scripts/check-doc-line-refs.mjs --write-baseline 生成。行号会随源码漂移，重跑脚本可发现。",
      count: keys.length,
      refs: ordered,
    };
    writeFileSync(absoluteBaseline, JSON.stringify(payload, null, 2) + "\n");
    written += 1;
    console.log(`  ✍️  基线已写入 ${baselinePath}（${keys.length} 条）`);
  }
}

console.log(
  `\n合计 ${total} 处（去重后）；越界/无法解析 ${hard} 处；` +
    `内容漂移 ${drifted} 处；锚在空行 ${blank} 处（告警）` +
    `${written > 0 ? `；写入基线 ${written} 份` : ""}`,
);
if (hard > 0) process.exit(1);
if (drifted > 0) process.exit(2);
process.exit(0);
