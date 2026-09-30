#!/usr/bin/env node
// 包边界检查：把 §7.7-5 与 §13.4 的**依赖约束**变成可执行条件。
//
// 方案在两处要求同一条不变量：
//   §7.7-5  "静态依赖检查阻止 scoring 引入 readiness"
//   §13.4   "依赖约束：scoring 不 import readiness、API、storage"
// 并且明确写了"**不只依靠源码字符串 grep**；应增加类型编译和行为测试"。
//
// 实测（2026-09-30）：这条不变量**今天成立**，但**没有任何东西在守**。
// `@rai/scoring` 目前只 import `@rai/contracts`；而 workspace 依赖是允许写
// `"@rai/readiness": "*"` 的 —— 一旦有人加上，编译照过、测试照绿，
// 而"恢复不再影响 Fitness"这条 P0 不变量已经被悄悄破坏。
//
// 所以这里有四类判据，各自拦住一种真实的漂移：
//   A 分层：packages/*/src 不得 import apps/*（apps 是消费者）。**只查 src，不查 test** ——
//     仓库既有先例是包级测试可以 import app 实现（见 recovery-isolation-e2e.test.ts 的说明）。
//   B 具名不变量：scoring 不得触达 readiness / storage-sqlite / application / model-eval。
//     §6.9 禁止负向学习条件读取 readiness；一旦 scoring 能 import readiness，
//     这条禁令就只能靠自觉。
//   C 声明↔实际：package.json 里声明的 workspace 依赖必须与 src 实际 import 的一致，
//     两个方向都查。声明了却不用，会让"这个包允许依赖谁"的读数偏宽；
//     用了却没声明，在干净安装下会直接崩。
//   D 边集白名单：workspace→workspace 的边必须逐条列在下面的 ALLOWED_EDGES 里。
//     新增一条边必须**有意识地**改这个文件，于是 review 时一定看得见。
//
// 用法：node scripts/check-package-boundaries.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 允许存在的 workspace→workspace 边（只统计 `src/` 下的 import）。
 * 这份清单是**当前实测状态**的快照 + 有意声明，不是从某个理论分层推出来的。
 * 增删这一行就是一次边界决策，请在提交信息里说明理由。
 */
const ALLOWED_EDGES = new Set([
  "api-contracts -> contracts",
  "application -> contracts",
  "application -> durability",
  "application -> features",
  "application -> health-export-parser",
  "application -> model-eval",
  "application -> normalization",
  "application -> physiology",
  "application -> prediction-inference",
  "application -> readiness",
  "application -> scoring",
  "application -> storage-sqlite",
  "application -> training-load",
  "application -> training-zones",
  "durability -> contracts",
  "features -> contracts",
  "features -> normalization",
  "health-export-parser -> contracts",
  "health-export-parser -> storage-sqlite",
  "model-eval -> contracts",
  "physiology -> contracts",
  "prediction-inference -> contracts",
  "readiness -> contracts",
  "scoring -> contracts",
  "storage-sqlite -> contracts",
  "storage-sqlite -> model-eval",
  "training-load -> contracts",
  "training-load -> readiness",
  "training-zones -> contracts",
  "training-zones -> training-load"
]);

/**
 * §7.7-5 / §13.4 的具名禁线。写成"从哪到哪 + 为什么"，而不是一句正则 ——
 * 这样报错信息本身就是设计理由。
 */
const FORBIDDEN_EDGES = [
  { from: "scoring", to: "readiness", why: "§6.9 禁止负向学习条件读取 readiness；scoring 一旦能 import readiness，这条禁令就只能靠自觉" },
  { from: "scoring", to: "storage-sqlite", why: "§13.4：模型领域包不访问数据库" },
  { from: "scoring", to: "application", why: "§13.4：领域包不得依赖编排层（会形成循环）" },
  { from: "scoring", to: "model-eval", why: "§15.1：评估不得回流入被评估的领域包" }
];

function sourceFiles(directory, found = []) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const problems = [];
const workspaces = [];
for (const scope of ["packages", "apps"]) {
  for (const name of readdirSync(join(root, scope))) {
    const directory = join(root, scope, name);
    try {
      statSync(join(directory, "src"));
    } catch {
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const declared = new Set(
      Object.keys(manifest.dependencies ?? {})
        .filter((dependency) => dependency.startsWith("@rai/"))
        .map((dependency) => dependency.slice("@rai/".length))
    );
    const imported = new Set();
    for (const file of sourceFiles(join(directory, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+"@rai\/([a-z-]+)/g)) {
        if (match[1] !== name) imported.add(match[1]);
      }
    }
    workspaces.push({ scope, name, declared, imported });
  }
}

for (const workspace of workspaces) {
  const { scope, name, declared, imported } = workspace;

  // A 分层：**包**不得依赖 app（只查 src）。
  // 注意别把 `@rai/api-contracts` 当成 app —— 它是合法的契约包，
  // 第一版用一个过宽的正则（`@rai/api`）把它误判成 app 依赖，报了 57 处假阳性。
  if (scope === "packages") {
    for (const file of sourceFiles(join(root, scope, name, "src"))) {
      const text = readFileSync(file, "utf8");
      if (/from\s+"[^"]*\/apps\//.test(text)) {
        problems.push(
          `${scope}/${name}: src 不得 import app 实现（${file.replace(root, ".")}）—— apps 是消费者，不是依赖`
        );
      }
    }
  }

  // B 具名禁线。
  for (const rule of FORBIDDEN_EDGES) {
    if (rule.from === name && imported.has(rule.to)) {
      problems.push(`${scope}/${name} 依赖 ${rule.to}：${rule.why}`);
    }
  }

  // C 声明↔实际（两个方向）。
  for (const dependency of imported) {
    if (!declared.has(dependency)) {
      problems.push(`${scope}/${name}: src 里 import 了 @rai/${dependency}，但 package.json 没有声明它（干净安装会崩）`);
    }
  }
  for (const dependency of declared) {
    if (!imported.has(dependency)) {
      problems.push(`${scope}/${name}: package.json 声明了 @rai/${dependency}，但 src 从未使用 —— 声明比实际宽，会让人误判这个包允许依赖谁`);
    }
  }

  // D 边集白名单。
  if (scope === "packages") {
    for (const dependency of imported) {
      const edge = `${name} -> ${dependency}`;
      if (!ALLOWED_EDGES.has(edge)) {
        problems.push(`未声明的包边界：${edge}（若属有意新增，请加进 ALLOWED_EDGES 并在提交信息里说明理由）`);
      }
    }
  }
}

// 反向：白名单里已不存在的边要删掉，否则它会变成永久豁免。
const liveEdges = new Set(
  workspaces.filter((w) => w.scope === "packages").flatMap((w) => [...w.imported].map((d) => `${w.name} -> ${d}`))
);
for (const edge of ALLOWED_EDGES) {
  if (!liveEdges.has(edge)) problems.push(`ALLOWED_EDGES 里的 ${edge} 已不存在，请删除（否则清单会失去意义）`);
}

const packageCount = workspaces.filter((w) => w.scope === "packages").length;
process.stdout.write(
  `包边界：${packageCount} 个包 / ${liveEdges.size} 条 src 边；禁线 ${FORBIDDEN_EDGES.length} 条\n`
);
for (const problem of problems) process.stdout.write(`  🔴 ${problem}\n`);
if (problems.length > 0) {
  process.stderr.write(`\n包边界检查失败：${problems.length} 处。\n`);
  process.exit(1);
}
process.stderr.write("包边界检查通过。\n");
