// 从阶段 2 证据 JSON 生成报告表格片段（避免手工抄写数字）。
//
//   node scripts/phase2-report-tables.mjs --root <experiment-root> --out <markdown>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const root = resolve(readArg("--root", "."));
const out = readArg("--out");

const files = ["d0", "d1", "d2", "d3"].map((key) => ({
  key,
  path: join(root, `phase2-evidence-${key}.json`)
})).filter((entry) => existsSync(entry.path));

const evidence = Object.fromEntries(files.map((entry) => [entry.key, JSON.parse(readFileSync(entry.path, "utf8"))]));

const f = (value, digits = 2) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—");
const delta = (baseline, candidate) => {
  if (typeof baseline !== "number" || typeof candidate !== "number" || baseline === 0) return "—";
  return `${(((candidate - baseline) / baseline) * 100).toFixed(1)}%`;
};

const lines = [];
for (const [key, data] of Object.entries(evidence)) {
  const experiment = data.indexExperiment?.[key];
  if (!experiment) continue;
  lines.push(`### ${key.toUpperCase()}`);
  lines.push("");
  lines.push("| 查询 | baseline p50 | baseline p95 | 窄索引 p50 | 窄索引 p95 | 覆盖索引 p50 | 覆盖索引 p95 | v47 p50 | v47 p95 |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  const names = new Set([
    ...Object.keys(experiment.measurements.baseline ?? {}),
    ...Object.keys(experiment.measurements.narrow ?? {}),
    ...Object.keys(experiment.measurements.cover ?? {})
  ]);
  for (const name of names) {
    const b = experiment.measurements.baseline?.[name]?.summary;
    const n = experiment.measurements.narrow?.[name]?.summary;
    const c = experiment.measurements.cover?.[name]?.summary;
    const a = experiment.measurements.ability?.[name]?.summary;
    lines.push(`| ${name} | ${f(b?.p50)} | ${f(b?.p95)} | ${f(n?.p50)} | ${f(n?.p95)} | ${f(c?.p50)} | ${f(c?.p95)} | ${f(a?.p50)} | ${f(a?.p95)} |`);
  }
  lines.push("");
  lines.push("| 完整端点 | baseline p50 | baseline p95 | v47 p50 | v47 p95 | p50 变化 | p95 变化 |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const name of Object.keys(experiment.endpoints?.baseline ?? {})) {
    const b = experiment.endpoints.baseline[name].summary;
    const a = experiment.endpoints.ability[name].summary;
    lines.push(`| ${name} | ${f(b.p50)} | ${f(b.p95)} | ${f(a.p50)} | ${f(a.p95)} | ${delta(b.p50, a.p50)} | ${delta(b.p95, a.p95)} |`);
  }
  lines.push("");
  lines.push(`索引体积：baseline ${data.manifests[key]?.bytes?.total ?? "—"} B；窄 ${experiment.narrow?.bytes?.total ?? "—"} B；覆盖 ${experiment.cover?.bytes?.total ?? "—"} B；v47 ${experiment.ability.bytes.total} B。`);
  lines.push(`索引构建：窄 ${f(experiment.narrow?.buildMs, 1)} ms；覆盖 ${f(experiment.cover?.buildMs, 1)} ms；v47 ${f(experiment.ability.buildMs, 1)} ms。`);
  lines.push("");
  lines.push("差分：");
  for (const variant of ["narrow", "cover", "ability"]) {
    const diff = data.differential?.[key]?.[variant];
    if (!diff || Object.keys(diff).length === 0) { lines.push(`- ${variant}: 未测`); continue; }
    const failures = Object.entries(diff).filter(([, value]) => !value.equal).map(([name]) => name);
    lines.push(`- ${variant}: ${failures.length === 0 ? "全部相等" : `不相等：${failures.join(", ")}`}`);
  }
  lines.push("");
  const audit = data.auditAndConnection?.[key];
  if (audit) {
    lines.push("| 审计/连接/端点 | p50 | p95 | 样本 |");
    lines.push("|---|---:|---:|---:|");
    for (const [name, value] of Object.entries(audit)) {
      const summary = value.summary ?? value;
      if (summary?.p50 !== undefined) lines.push(`| ${name} | ${f(summary.p50)} | ${f(summary.p95)} | ${summary.samples} |`);
    }
    lines.push("");
  }
  const overlap = data.overlapCache?.[key];
  if (overlap) {
    lines.push("| 重叠统计 | p50 | p95 | 样本 |");
    lines.push("|---|---:|---:|---:|");
    for (const [name, value] of Object.entries(overlap)) {
      const summary = value.summary ?? value;
      if (summary?.p50 !== undefined) lines.push(`| ${name} | ${f(summary.p50)} | ${f(summary.p95)} | ${summary.samples} |`);
    }
    lines.push("");
  }
}

const markdown = lines.join("\n");
if (out) writeFileSync(resolve(out), `${markdown}\n`);
console.log(markdown);
