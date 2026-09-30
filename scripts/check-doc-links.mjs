#!/usr/bin/env node
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
const graph = new Map(documents.map((path) => [path, new Set()]));
const problems = [];
let checked = 0;
for (const document of documents) {
  const text = readFileSync(resolve(root, document), "utf8").replace(
    /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, ""
  );
  // Markdown local links/images. Remote URLs are not fetched or certified.
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
    let target;
    try { target = decodeURIComponent(raw.split(/[?#]/, 1)[0]); }
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
    } else if (statSync(full).isFile() && graph.has(gitPath)) {
      graph.get(document).add(gitPath);
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
console.log(`Documentation: ${documents.length} files, ${checked} local links, ${problems.length} problems`);
for (const problem of problems) console.error(problem);
process.exitCode = problems.length ? 1 : 0;
