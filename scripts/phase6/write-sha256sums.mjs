// 交付包 SHA256SUMS 生成：递归列出文件，排除 SHA256SUMS 自身，按路径排序。
// 用法：node scripts/phase6/write-sha256sums.mjs --deliverable <dir>
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const index = args.indexOf("--deliverable");
const deliverable = resolve(index >= 0 ? args[index + 1] : "deliverables/phase6-performance-2026-10-24");
if (!existsSync(deliverable)) {
  process.stderr.write(`write-sha256sums: missing deliverable ${deliverable}\n`);
  process.exit(2);
}

const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && entry.name !== "SHA256SUMS") files.push(path);
  }
}
walk(deliverable);

const lines = files.map((path) => {
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return `${hash}  ${relative(deliverable, path).split(sep).join("/")}`;
});
writeFileSync(resolve(deliverable, "SHA256SUMS"), `${lines.join("\n")}\n`);
process.stdout.write(`${JSON.stringify({ deliverable, files: lines.length }, null, 2)}\n`);
