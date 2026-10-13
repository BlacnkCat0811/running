import { readFileSync, statSync } from "node:fs";

const diagrams = [
  "architecture-system",
  "dataflow-core",
  "sequence-analysis",
  "architecture-database",
  "architecture-modules",
  "architecture-risks"
];
const root = ".archify/rai-audit-20261013-160439/";
let failures = 0;
for (const d of diagrams) {
  const htmlPath = `${root}${d}/${d}.html`;
  const html = readFileSync(htmlPath, "utf8");
  const bytes = statSync(htmlPath).size;
  const svgs = (html.match(/<svg\b/g) ?? []).length;
  const remote = (html.match(/(?:src|href)="https?:\/\//g) ?? []).length;
  const hasDoctype = /^<!DOCTYPE html>/i.test(html.trimStart());
  const hasViewport = html.includes('name="viewport"');
  const hasTheme = html.includes("prefers-color-scheme") || html.includes("data-theme");
  const offline = remote === 0;
  const ok = svgs >= 1 && hasDoctype && hasViewport && offline;
  if (!ok) failures += 1;
  console.log(
    d.padEnd(22),
    `${bytes}`.padStart(7),
    "svg=" + svgs,
    "doctype=" + hasDoctype,
    "viewport=" + hasViewport,
    "theme=" + hasTheme,
    "remoteRefs=" + remote,
    ok ? "OK" : "SUSPECT"
  );
}
console.log(failures ? `\n${failures} artifact(s) failed the standalone check` : "\nAll six artifacts are standalone (no remote refs) and contain inline SVG");
