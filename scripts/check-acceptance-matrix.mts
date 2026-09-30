#!/usr/bin/env node
// §16.1 验收矩阵的**可执行**覆盖检查。
//
// 为什么需要它：§16.1 是这份方案的核心验收清单，但"覆盖了多少条"此前只是一个**断言**。
// 2026-09-30 实测：矩阵共 **54** 条（不是文档里写的 53），其中只有 **19** 条在测试里
// 被按 ID 引用过 —— 而"没引用"与"没覆盖"是两件事，光看数字无法区分。
//
// 本检查把问题变成可判定的三态：
//   cited    测试里按 ID 引用了（机械可查，`\bID\b`）
//   declared 未经引用，但已在下面的 KNOWN_GAPS 里**逐个写明**理由（不许空泛写"待补"）
//   missing  既没引用也没声明 ⇒ **退出码 1**
//
// 所以新增一条 §16.1 用例而不写测试、不写理由，会让这个检查转红。
// 这是"把文档要求变成执行条件"，不是覆盖率仪表盘。
//
// 用法：node --import tsx scripts/check-acceptance-matrix.mts

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const planPath = join(root, "docs", "ALGORITHM.md");

/**
 * 未经 ID 引用、但**有意**如此的条目。每条都必须写明"哪一半有测试 / 缺的是哪一半"，
 * 而不是一句"暂未覆盖"—— 后者会让这个清单变成掩盖缺口的垃圾桶。
 */
// 2026-09-30：本表已空。§16.1 的 54 条全部由按 ID 引用的测试覆盖（cited 54 / gap 0 / missing 0）。
// 空表是有意的：缺口声明只在**确实缺**的时候存在；一旦被引用就必须删掉，
// 否则它会从"当前缺口"退化成"历史存档"。
//
// 两条已经移出的记录留在这里，因为它们各自带着一条**仍然有效的边界**：
//   F08 — 检测器已引用（packages/features/test/speed-plausibility.test.ts 与
//         deliverables/SPEED_PLAUSIBILITY_INVENTORY.json）；但"门控效果"仍属 §17.3 待回放，
//         所以 F08 作为验收项的被引用**不等于**正向异常门控已经上线。
//   P02 — §5.5 责任账本记录 object/owner/inputHash，断言"同一 (kind, object, inputHash)
//         至多应用一次"与"历史去偏差不得出现在 potentialSeconds 之后"。
//         边界：目前只有一个层（N0 identity + performanceVdotEvidence），
//         所以"两层各去一次"是构造出来的，不是线上可复现的；N2 落地后应再加一条
//         "两个真实 owner"的用例。
const KNOWN_GAPS: Record<string, string> = {};

function collectTestFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) collectTestFiles(full, found);
    else if (/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

// §16.1 的用例 ID：两个大写字母/数字前缀 + 两位数字，且**只取矩阵正文**，
// 不取附录 B 的证据索引（E01–E34）。
const plan = readFileSync(planPath, "utf8");
const matrixStart = plan.indexOf("### 16.1");
const matrixEnd = plan.indexOf("### 16.2");
if (matrixStart < 0 || matrixEnd < 0 || matrixEnd <= matrixStart) {
  process.stderr.write("Could not locate the §16.1 acceptance matrix in the plan.\n");
  process.exit(1);
}
const matrix = plan.slice(matrixStart, matrixEnd);
const ids = [...new Set([...matrix.matchAll(/^\|\s*([A-Z]\d{2})\s*\|/gm)].map((match) => match[1]!))];
if (ids.length === 0) {
  process.stderr.write("The §16.1 matrix parsed to zero IDs; the table format probably changed.\n");
  process.exit(1);
}

const sources = ["packages", "apps"]
  .map((name) => join(root, name))
  .flatMap((directory) => collectTestFiles(directory))
  .map((file) => ({ file, text: readFileSync(file, "utf8") }));

/**
 * 只认**测试标题**里的 ID。
 *
 * 🔴 第一版是 `new RegExp("\\b" + id + "\\b").test(fileText)` —— 在整个文件正文里找，
 * 于是**注释**和**任何字符串字面量**都算"被引用"。2026-09-30 的独立审计抓到了后果：
 *
 * - `T01` / `T02` 的"引用"全部来自 `${localDate}T02:00:00.000Z` 这类时间戳模板 ——
 *   `}` 与 `T` 之间是词边界，所以 `\bT02\b` 命中；而写成 `2026-07-10T02:00:00Z`
 *   （`0` 与 `T` 之间不是边界）就不会命中。两个 ID 因此凭空"被覆盖"。
 * - `F01` 只有注释提到它。
 *
 * 也就是说那份 `cited 54` 只证明"某个 ID 在某处出现过"，不证明"有断言在守它"。
 * 现在只从 `test(...)` / `it(...)` 的标题字符串里取 ID：标题里没有，就不算引用。
 * 标题里没有但断言确实存在的用例，**正确做法是给标题补上 ID**，而不是把检查放松回去。
 */
function citedIdsIn(text: string): Set<string> {
  const titles: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s;{}])(?:test|it)\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    titles.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return new Set(titles.join("\n").match(/\b[A-Z]\d{2}\b/g) ?? []);
}

const citedSet = new Set<string>();
for (const source of sources) for (const id of citedIdsIn(source.text)) citedSet.add(id);

const cited: string[] = [];
const declared: string[] = [];
const missing: string[] = [];
for (const id of ids) {
  if (citedSet.has(id)) cited.push(id);
  else if (id in KNOWN_GAPS) declared.push(id);
  else missing.push(id);
}

const staleGaps = Object.keys(KNOWN_GAPS).filter((id) => !ids.includes(id) || cited.includes(id));

process.stdout.write(
  `§16.1 矩阵：${ids.length} 条；cited ${cited.length}；declared-gap ${declared.length}；missing ${missing.length}\n`
);
for (const id of declared) process.stdout.write(`  ⚪ ${id} — ${KNOWN_GAPS[id]}\n`);
for (const id of missing) process.stdout.write(`  🔴 ${id} — 既未被测试引用，也未在 KNOWN_GAPS 中声明\n`);
for (const id of staleGaps) {
  process.stdout.write(`  🟡 ${id} — KNOWN_GAPS 里的声明已过期（现在已被引用或已不在矩阵中），请删除\n`);
}

if (missing.length > 0 || staleGaps.length > 0) {
  process.stderr.write(
    "\n验收矩阵检查失败：新增用例必须要么有按 ID 引用的测试，要么在 KNOWN_GAPS 里写明缺哪一半。\n"
  );
  process.exit(1);
}
process.stderr.write("\n验收矩阵检查通过。\n");
