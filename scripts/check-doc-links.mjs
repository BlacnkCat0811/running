#!/usr/bin/env node
// 文档门禁（`npm run check:docs`）：
//   1. 所有 tracked/未跟踪但未忽略的 `.md/.mdx` 都必须从 README.md 可达（孤儿文档 = 错误）；
//   2. 本地链接（含图片）目标必须存在、不得逃出仓库；
//   3. `target.md#fragment` 的 fragment 必须是目标文档真实存在的标题 slug（GitHub 风格）。
//
// 2026-10-18（深度审查 P3-31）修掉两处：
//   · **行内代码里的伪链接**：此前只剥围栏代码块，行内 `` `[x](missing.md)` `` 会被当成
//     真链接报红（假阳性），而"在正文里举例写一个链接"是最常见的文档写法。现在先剥行内代码。
//   · **锚点从不校验**：`docs/X.md#section` 此前只查文件存在，`#section` 改名/删掉都不红。
//     现在按 GitHub 风格 slug 集合校验（标题 + 显式 HTML anchor），并跳过 `#L12` 这类行号锚。
//
// 锚点校验的**范围例外**（写明理由，不静默）：`deliverables/` 与 `.archify/` 是**时点快照**，
// 刻意引用当时的标题与行号；回写等于伪造历史，所以从这些文档出发的锚点不做硬校验
// （链接目标存在性仍校验）。同理，`target.md` 不在仓库内或不是 `.md/.mdx` 时只查存在性。
//
// 远端 URL 不抓取、不认证（离线门禁）。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string" } } });
const root = resolve(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root, maxBuffer: 16 * 1024 * 1024
}).toString().split("\0");
const documents = [...new Set(listed)].filter((path) =>
  /\.(md|mdx)$/.test(path) && existsSync(resolve(root, path))
).sort();
if (!documents.includes("README.md")) throw new Error("Documentation root README.md is missing");

const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;
/** 时点快照：锚点刻意引用当时的标题，不做硬校验（理由见文件头）。 */
const ANCHOR_EXEMPT_PREFIXES = ["deliverables/", ".archify/"];

/** 去掉围栏代码块与行内代码，只留会渲染成链接的正文。 */
const visibleMarkdown = (text) => text.replace(FENCE, "").replace(INLINE_CODE, "");

/**
 * GitHub 风格 slug：小写、去 HTML/markdown 标记、去标点（保留 Unicode 字母/数字/下划线/−）、
 * 空白转 `-`。重复标题由调用方加 `-1/-2` 后缀。
 */
function slugify(heading) {
  return heading
    .replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

const slugCache = new Map();
/** 目标 markdown 文件里所有可跳转锚点（标题 slug + 显式 `<a id/name>`）。 */
function anchorsOf(file) {
  let anchors = slugCache.get(file);
  if (anchors) return anchors;
  const text = visibleMarkdown(readFileSync(file, "utf8"));
  anchors = new Set();
  const occurrences = new Map();
  const add = (raw) => {
    const base = slugify(raw);
    if (!base) return;
    const seen = occurrences.get(base) ?? 0;
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
    occurrences.set(base, seen + 1);
  };
  for (const match of text.matchAll(/^#{1,6}[ \t]+(.*)$/gm)) {
    add(match[1].replace(/[ \t]+#+[ \t]*$/, ""));
  }
  // Setext 标题（`Title` + `===`/`---`）。
  const lines = text.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1].trim();
    if (previous && /^[=-]{2,}$/.test(lines[index].trim()) && !previous.startsWith("#")) add(previous);
  }
  for (const match of text.matchAll(/<a[^>]*(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(match[1]);
  slugCache.set(file, anchors);
  return anchors;
}

const graph = new Map(documents.map((path) => [path, new Set()]));
const problems = [];
let checked = 0;
let anchorsChecked = 0;
for (const document of documents) {
  // 先把围栏代码块与行内代码剥掉：两者都是"示例文本"，不是活动链接。
  const text = visibleMarkdown(readFileSync(resolve(root, document), "utf8"));
  // Markdown local links/images. Remote URLs are not fetched or certified.
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
    const hashIndex = raw.indexOf("#");
    const pathPart = (hashIndex >= 0 ? raw.slice(0, hashIndex) : raw).split("?")[0];
    const fragmentPart = hashIndex >= 0 ? raw.slice(hashIndex + 1).split("?")[0] : "";
    let target;
    try { target = decodeURIComponent(pathPart); }
    catch { problems.push(`${document}: invalid URL encoding: ${raw}`); continue; }
    if (!target) continue;
    checked++;
    const full = isAbsolute(target) ? target : resolve(root, dirname(document), target);
    const local = relative(root, full);
    // git ls-files uses '/' on every platform; path.relative uses '\\' on Windows.
    const gitPath = local.split(sep).join("/");
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      problems.push(`${document}: link leaves repository: ${raw}`);
    } else if (!existsSync(full)) {
      problems.push(`${document}: missing target: ${raw}`);
    } else {
      if (statSync(full).isFile() && graph.has(gitPath)) graph.get(document).add(gitPath);
      // 锚点校验：只对仓库内 markdown 目标、非时点快照、非 `#L12` 行号锚生效。
      const lineAnchor = /^(?:L\d+(?:-L?\d+)?|top)$/i.test(fragmentPart);
      const exemptSnapshot = ANCHOR_EXEMPT_PREFIXES.some((prefix) => document.startsWith(prefix));
      if (fragmentPart && !lineAnchor && !exemptSnapshot && /\.(md|mdx)$/i.test(gitPath)) {
        let fragment;
        try { fragment = decodeURIComponent(fragmentPart); } catch { fragment = fragmentPart; }
        anchorsChecked++;
        if (!anchorsOf(full).has(fragment)) {
          problems.push(`${document}: missing anchor: ${raw}`);
        }
      }
    }
  }
}
const reachable = new Set();
const visit = (path) => {
  if (reachable.has(path)) return;
  reachable.add(path);
  for (const next of graph.get(path) ?? []) visit(next);
};
visit("README.md");
for (const document of documents) {
  if (!reachable.has(document)) problems.push(`${document}: not reachable from README.md`);
}
console.log(
  `Documentation: ${documents.length} files, ${checked} local links, ` +
  `${anchorsChecked} anchors, ${problems.length} problems`
);
for (const problem of problems) console.error(problem);
process.exitCode = problems.length ? 1 : 0;
