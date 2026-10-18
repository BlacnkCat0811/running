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
// 🔴 2026-10-18（深度审查 P2-08）修掉了一类**可绕过**：
//   第一版只匹配双引号静态 `from "@rai/x"`，且只扫 `.ts/.tsx`。于是同一行 import
//   只要写成单引号（仓内 `packages/application/src` 已有 8 处这种写法）、动态
//   `import("@rai/x")`、`require("@rai/x")`，或把文件改成 `.mts`，四类判据就全部
//   失明——"用引号风格/扩展名绕过 P0 不变量"变成一行 diff 的事。现在：
//     · 静态 `from` 同时匹配单/双引号（含 `export … from`）；
//     · 额外匹配动态 `import("@rai/x")` 与 `require("@rai/x")`；
//     · 源文件扩展名放宽到 `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`；
//     · A 分层规则同源放宽（引号、动态 import、扩展名）。
//
// 用法：
//   node scripts/check-package-boundaries.mjs              # 检查工作树
//   node scripts/check-package-boundaries.mjs --self-test  # /tmp 夹具突变回归（CI/发布清单用）
//
// `--self-test` 在 os.tmpdir() 下现建夹具并清理，验证"双引号红 / 单引号红 / `.mts` 红 /
// 动态 import 红 / require 红 / 跨层红 / 声明未用红 / 健康夹具绿"，不需要 commit 任何夹具。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 允许存在的 workspace→workspace 边（只统计 `src/` 下的 import）。
 * 这份清单是**当前实测状态**的快照 + 有意声明，不是从某个理论分层推出来的。
 * 增删这一行就是一次边界决策，请在提交信息里说明理由。
 */
export const ALLOWED_EDGES = new Set([
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
  // 2026-10-02 §19：跑姿动态读侧是纯逻辑包，只吃 contracts —— 它**不得**变成第二个
  // 修正所有者（§5.5），也不得进入 CA/TA，所以刻意不给它 features/scoring 的边。
  "dynamics -> contracts",
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
export const FORBIDDEN_EDGES = [
  { from: "scoring", to: "readiness", why: "§6.9 禁止负向学习条件读取 readiness；scoring 一旦能 import readiness，这条禁令就只能靠自觉" },
  { from: "scoring", to: "storage-sqlite", why: "§13.4：模型领域包不访问数据库" },
  { from: "scoring", to: "application", why: "§13.4：领域包不得依赖编排层（会形成循环）" },
  { from: "scoring", to: "model-eval", why: "§15.1：评估不得回流入被评估的领域包" }
];

/** 源文件扩展名：TS 的四种 `.ts/.tsx/.mts/.cts` 都要看，`.js/.mjs/.cjs/.jsx` 一并纳入。 */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
/** 静态 import / export … from（单双引号）。 */
const STATIC_RAI = /from\s*['"]@rai\/([a-z-]+)['"]/g;
/** 动态 import("@rai/x")（类型位置也用它）。 */
const DYNAMIC_RAI = /\bimport\s*\(\s*['"]@rai\/([a-z-]+)['"]/g;
/** CommonJS require("@rai/x")（保留兼容，仓内当前没有）。 */
const REQUIRE_RAI = /\brequire\s*\(\s*['"]@rai\/([a-z-]+)['"]/g;
/** 分层规则：任何形式的 `from "../../apps/…"`、`import("../../apps/…")`。 */
const APP_TARGET = /(?:from|import\s*\(|require\s*\()\s*['"][^'"]*\/apps\//;

export function sourceFiles(directory, found = []) {
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
    else if (SOURCE_FILE.test(entry)) found.push(full);
  }
  return found;
}

/** 一份源码文本里对 `@rai/<name>` 的全部依赖（静态 + 动态 + require），不含自引用。 */
export function raiImportsIn(text, selfName) {
  const imported = new Set();
  for (const pattern of [STATIC_RAI, DYNAMIC_RAI, REQUIRE_RAI]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== selfName) imported.add(match[1]);
    }
  }
  return imported;
}

/**
 * 纯分析函数（不打印、不退出）：`--self-test` 与工作树检查共用同一段判据，
 * 避免"测试测的是另一份实现"。
 */
export function analyze(base, options = {}) {
  const {
    allowedEdges = ALLOWED_EDGES,
    forbiddenEdges = FORBIDDEN_EDGES,
    enforceLiveEdges = true
  } = options;
  const problems = [];
  const workspaces = [];
  for (const scope of ["packages", "apps"]) {
    const groupDir = join(base, scope);
    let names;
    try {
      names = readdirSync(groupDir);
    } catch {
      continue; // 夹具/裁剪仓库可能没有 apps/；不把"目录不存在"当成边界问题。
    }
    for (const name of names) {
      const directory = join(groupDir, name);
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
      const files = sourceFiles(join(directory, "src"));
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const dependency of raiImportsIn(text, name)) imported.add(dependency);
        // A 分层：**包**不得依赖 app（只查 src）。对所有源码文件检查，与扩展名无关。
        if (scope === "packages" && APP_TARGET.test(text)) {
          problems.push(
            `${scope}/${name}: src 不得 import app 实现（${file.replace(base, ".")}）—— apps 是消费者，不是依赖`
          );
        }
      }
      workspaces.push({ scope, name, declared, imported });
    }
  }

  for (const workspace of workspaces) {
    const { scope, name, declared, imported } = workspace;

    // B 具名禁线。
    for (const rule of forbiddenEdges) {
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
        if (!allowedEdges.has(edge)) {
          problems.push(`未声明的包边界：${edge}（若属有意新增，请加进 ALLOWED_EDGES 并在提交信息里说明理由）`);
        }
      }
    }
  }

  // 反向：白名单里已不存在的边要删掉，否则它会变成永久豁免。
  const liveEdges = new Set(
    workspaces.filter((w) => w.scope === "packages").flatMap((w) => [...w.imported].map((d) => `${w.name} -> ${d}`))
  );
  if (enforceLiveEdges) {
    for (const edge of allowedEdges) {
      if (!liveEdges.has(edge)) problems.push(`ALLOWED_EDGES 里的 ${edge} 已不存在，请删除（否则清单会失去意义）`);
    }
  }
  return {
    problems,
    packageCount: workspaces.filter((w) => w.scope === "packages").length,
    edges: liveEdges
  };
}

export function main() {
  const { problems, packageCount, edges } = analyze(root);
  process.stdout.write(`包边界：${packageCount} 个包 / ${edges.size} 条 src 边；禁线 ${FORBIDDEN_EDGES.length} 条\n`);
  for (const problem of problems) process.stdout.write(`  🔴 ${problem}\n`);
  if (problems.length > 0) {
    process.stderr.write(`\n包边界检查失败：${problems.length} 处。\n`);
    return 1;
  }
  process.stderr.write("包边界检查通过。\n");
  return 0;
}

/**
 * 突变自测：每个用例一个 /tmp 夹具，直接调用 `analyze()`（与工作树检查同一实现）。
 * 任何一条"改坏却仍绿"都算失败——这正是不变量门禁最危险的失效方式。
 */
export function selfTest() {
  const cases = [];
  const runCase = (title, setup, assertProblems, options = {}) => {
    const base = mkdtempSync(join(tmpdir(), "rai-boundary-self-test-"));
    try {
      mkdirSync(join(base, "apps"), { recursive: true });
      setup(base);
      const result = analyze(base, options);
      const problemList = result.problems;
      const failure = assertProblems(problemList);
      cases.push({ title, ok: failure === null, failure, problemList });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
  const writePackage = (base, name, deps, files) => {
    mkdirSync(join(base, "packages", name, "src"), { recursive: true });
    writeFileSync(
      join(base, "packages", name, "package.json"),
      JSON.stringify({
        name: `@rai/${name}`,
        dependencies: Object.fromEntries(deps.map((dependency) => [`@rai/${dependency}`, "*"]))
      })
    );
    for (const [file, text] of Object.entries(files)) writeFileSync(join(base, "packages", name, "src", file), text);
  };
  // 夹具白名单：只允许健康夹具里真实存在的边，避免反向检查制造噪音。
  const edges = (...pairs) => new Set(pairs);
  const healthyEdges = edges("scoring -> contracts");
  const expectProblem = (needle) => (problems) => {
    const hit = problems.some((problem) => problem.includes(needle));
    return hit ? null : `期望出现包含「${needle}」的问题，实际：${JSON.stringify(problems)}`;
  };

  const healthy = (base) => {
    writePackage(base, "contracts", [], { "index.ts": "export const x = 1;\n" });
    writePackage(base, "scoring", ["contracts"], { "index.ts": 'import { x } from "@rai/contracts";\nexport const y = x;\n' });
  };
  const forbiddenFile = (deps = ["contracts", "readiness"]) => ({
    "index.ts": 'import { y } from "@rai/contracts";\nimport { r } from "@rai/readiness";\nexport const y2 = y + r;\n'
  });
  const healthyOptions = { allowedEdges: healthyEdges, enforceLiveEdges: true };
  const mutationOptions = { allowedEdges: healthyEdges, enforceLiveEdges: false };

  runCase(
    "健康夹具（scoring → contracts，声明↔实际一致）",
    healthy,
    (problems) => (problems.length === 0 ? null : `期望 0 处问题，实际：${JSON.stringify(problems)}`),
    healthyOptions
  );
  runCase(
    '双引号单引号都拦：from "@rai/readiness"',
    (base) => {
      writePackage(base, "contracts", [], { "index.ts": "export const x = 1;\n" });
      writePackage(base, "readiness", ["contracts"], { "index.ts": "export const r = 1;\n" });
      writePackage(base, "scoring", ["contracts", "readiness"], forbiddenFile());
    },
    expectProblem("依赖 readiness"),
    mutationOptions
  );
  runCase(
    "单引号 from '@rai/readiness'（第一版会漏）",
    (base) => {
      writePackage(base, "contracts", [], { "index.ts": "export const x = 1;\n" });
      writePackage(base, "readiness", ["contracts"], { "index.ts": "export const r = 1;\n" });
      writePackage(base, "scoring", ["contracts", "readiness"], {
        "index.ts": "import { y } from '@rai/contracts';\nimport { r } from '@rai/readiness';\nexport const y2 = y + r;\n"
      });
    },
    expectProblem("依赖 readiness"),
    mutationOptions
  );
  runCase(
    ".mts 源文件（第一版只扫 .ts/.tsx）",
    (base) => {
      writePackage(base, "contracts", [], { "index.ts": "export const x = 1;\n" });
      writePackage(base, "readiness", ["contracts"], { "index.ts": "export const r = 1;\n" });
      writePackage(base, "scoring", ["contracts", "readiness"], {
        "index.mts": 'import { r } from "@rai/readiness";\nexport const y = r;\n'
      });
    },
    expectProblem("依赖 readiness"),
    mutationOptions
  );
  runCase(
    '动态 import("@rai/readiness")',
    (base) => {
      writePackage(base, "contracts", [], { "index.ts": "export const x = 1;\n" });
      writePackage(base, "readiness", ["contracts"], { "index.ts": "export const r = 1;\n" });
      writePackage(base, "scoring", ["contracts", "readiness"], {
        "index.ts": 'export const r = import("@rai/readiness");\n'
      });
    },
    expectProblem("依赖 readiness"),
    mutationOptions
  );
  runCase(
    'require("@rai/readiness")',
    (base) => {
      writePackage(base, "contracts", [], { "index.ts": "export const x = 1;\n" });
      writePackage(base, "readiness", ["contracts"], { "index.ts": "export const r = 1;\n" });
      writePackage(base, "scoring", ["contracts", "readiness"], {
        "index.cjs": 'const r = require("@rai/readiness");\nmodule.exports = r;\n'
      });
    },
    expectProblem("依赖 readiness"),
    mutationOptions
  );
  runCase(
    "跨层：包不得 import apps 实现（单引号 + 相对路径）",
    (base) => {
      writePackage(base, "contracts", [], { "index.ts": "export const x = 1;\n" });
      writePackage(base, "scoring", ["contracts"], {
        "index.ts": "import { y } from '@rai/contracts';\nexport const y2 = y;\n",
        "leak.mts": "import { server } from '../../../apps/api/src/server.js';\nexport const s = server;\n"
      });
    },
    expectProblem("不得 import app 实现"),
    mutationOptions
  );
  runCase(
    "声明了但从未使用（C 方向）",
    (base) => {
      writePackage(base, "contracts", [], { "index.ts": "export const x = 1;\n" });
      writePackage(base, "scoring", ["contracts"], { "index.ts": "export const y = 1;\n" });
    },
    expectProblem("声明比实际宽"),
    mutationOptions
  );

  const failed = cases.filter((entry) => !entry.ok);
  process.stdout.write("包边界自测（/tmp 夹具突变回归）：\n");
  for (const entry of cases) {
    process.stdout.write(`${entry.ok ? "  ✅" : "  🔴"} ${entry.title}\n`);
    if (!entry.ok) process.stdout.write(`     ${entry.failure}\n`);
  }
  if (failed.length > 0) {
    process.stderr.write(`\n包边界自测失败：${failed.length}/${cases.length} 项。\n`);
    return 1;
  }
  process.stderr.write(`\n包边界自测通过：${cases.length} 项（含单引号/动态 import/require/.mts/跨层/声明未用）。\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = process.argv.includes("--self-test") ? selfTest() : main();
}
