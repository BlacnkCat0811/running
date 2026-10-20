#!/usr/bin/env node
// 统一训练排课「唯一写者」结构门禁（`npm run check:training-plan-single-writer`）。
//
// ## 这个门禁证明什么，不证明什么
//
// 它是**源码形状回归门禁**，不是运行时唯一写者的证明。它把「今天成立、且一旦
// 被新代码破坏就会重新长出第二个排课/第二个迁移写入口」的 import 与调用形状固定
// 成可执行判据：新增一个 import、把状态感知的托管判定换回「有收据就算托管」、
// 或在别处手写 `mobile_training_state` 的 INSERT/UPDATE，都会让这里变红。
//
// 它**不**检查：并发锁、事务隔离、两个进程同时写同一张表、HTTP 路由是否真的可达、
// iOS 侧是否存在第二入口、数据正确性。这些属于运行时测试/验收，不由本文件证明。
//
// ## 五条判据（R1–R5）
//
// R1 完整剂量分配器 `buildCompleteCoachWeekPlan` 只能被唯一排课入口
//    `apps/api/src/weekly-plan-service.ts` 导入。PR7 已退役旧
//    `/v1/mobile/run-coach` 路由并删除只服务该路由的旧模板 builder，因此历史遗留的
//    `run-coach.ts` 适配器豁免不再存在。新增的第二个排课入口（例如新的 coach-loop
//    运行时或另一个 service）必须显式改这份白名单，于是 review 时一定看得见。
// R2 `generateWeeklyPlan` 只允许出现在 `weekly-plan-service.ts`（定义）、
//    `run-coach.ts`、`data.ts`、`server.ts`、`apps/api/src/training-plan-*`
//    以及测试/脚本里；其它生产文件 import 或 `.generateWeeklyPlan()` 成员访问即红。
// R3 `apps/api/src/server.ts` 只能有一处 `coachLoopState(`，且必须包在
//    `coachLoopReceiptManaged(...)`（状态感知：ended 收据不再算托管）里；
//    旧计划路由的托管前缀清单仍在、仍用 `const managed = coachLoopManaged()`；
//    `coachLoopReceiptManaged` 只在 `coach-loop-runtime.ts` 定义一次；
//    `coachLoopManaged` 只在 `server.ts` 定义。
// R4 `mobile_training_state*` 的 SQL 写入（INSERT/UPDATE/DELETE/REPLACE）和
//    `applyMigration` 符号只能出现在 `training-plan-store.ts`、`training-plan-*`、
//    `scripts/migrate-training-planner.mts`；别处手写 SQL 即红。
// R5 白名单自检：每条白名单指向的文件必须存在、glob 必须至少命中一个文件。
//    文件改名后规则不会静默失效（否则「宁可漏报」会变成「静默不查」）。
//
// ## 正则门禁的已知边界（必须在 review 时一起读）
//
//   · 只做文本形状匹配，不做 TS AST：注释里的示例代码不会被识别，字符串拼接的
//     import 说明符（`import(p + "/x.js")`）、`m[name]()` 计算成员访问、
//     `eval`/`Function` 构造、以及把符号 re-export 成另一个名字后再从允许文件
//     间接导入，都可能绕过。绕过需要**刻意**写不寻常的代码，普通新增文件/新增
//     import 会被拦住。
//   · 文本匹配包含注释：在被禁位置**注释里**写出同样的 import/调用形状也会变红。
//     这是刻意的保守噪声（宁可让人改注释，也不让注释成为规则说明的唯一载体）。
//   · 测试（`apps/api/test/**`）与 `var/` 离线探针不在扫描范围：测试合法地直接
//     import 分配器/写临时表，探针不进入产品路径。脚本只对 R2 整体豁免；R1/R4
//     仍检查 scripts（防止 CLI 之外出现第二个迁移写入口）。
//   · 本文件自身从扫描中排除（判据里必然出现被查符号的字面量）。
//   · 它不判断「哪个入口在运行时先执行」；R3 只保证标志位判定走统一谓词，不证明
//     两个写者在时间上互斥。
//
// 用法：
//   node scripts/check-training-plan-single-writer.mjs               # 检查工作树
//   node scripts/check-training-plan-single-writer.mjs --root <dir>  # 检查一棵拷贝（突变验证用）
//
// 退出码：全部通过 0；任何一条判据违反 1（逐条打印规则号与文件相对路径）。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "..");

const { values } = parseArgs({
  options: {
    root: { type: "string" }
  }
});
const root = resolve(values.root ?? DEFAULT_ROOT);

/** 判据只关心 JS/TS 家族；`.d.ts` 也匹配（声明文件不能成为第二个入口）。 */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git", "var", "coverage"]);

/** 生产源码根：R1/R4 在这里判；R2 在这里判但 scripts 豁免；R3 只看 apps/api/src。 */
const PRODUCTION_ROOTS = ["apps/api/src", "packages", "scripts"];
/** 测试根：R1/R2/R4 豁免（测试合法直接调用分配器/写临时 SQLite）。 */
const TEST_ROOTS = ["apps/api/test"];

const GATE_RELATIVE_PATH = "scripts/check-training-plan-single-writer.mjs";

// ---------------------------------------------------------------------------
// R1 白名单：唯一排课入口 + 登记在案的旧模板适配器
// ---------------------------------------------------------------------------
const ALLOCATOR_MODULE = "coach-complete-plan";
const ALLOCATOR_ALLOWED_IMPORTERS = new Set([
  // 定义自己的模块（不会 import 自己，保留是为了让 R5 检查文件本身仍在）。
  "apps/api/src/coach-complete-plan.ts",
  // 唯一自动排课入口。
  "apps/api/src/weekly-plan-service.ts"
]);
const ALLOCATOR_SYMBOL = "buildCompleteCoachWeekPlan";

// ---------------------------------------------------------------------------
// R2 白名单：`generateWeeklyPlan` 可以出现的生产文件
// ---------------------------------------------------------------------------
const WEEKLY_PLAN_MODULE = "weekly-plan-service";
const WEEKLY_PLAN_SYMBOL = "generateWeeklyPlan";
const WEEKLY_PLAN_ALLOWED_FILES = new Set([
  "apps/api/src/weekly-plan-service.ts",
  "apps/api/src/data.ts",
  "apps/api/src/server.ts"
]);
/** `apps/api/src/training-plan-*` 按前缀整体允许（统一计划模块族）。 */
const WEEKLY_PLAN_ALLOWED_PREFIXES = ["apps/api/src/training-plan-"];

// ---------------------------------------------------------------------------
// R3 托管判定
// ---------------------------------------------------------------------------
const SERVER_FILE = "apps/api/src/server.ts";
const RUNTIME_FILE = "apps/api/src/coach-loop-runtime.ts";
const STORE_FILE = "apps/api/src/mobile-goals.ts";
const MANAGED_HELPER = "coachLoopReceiptManaged";
const MANAGED_PREDICATE = "coachLoopManaged";
// The retired surfaces (/run-coach, /goals, /workout-plan/preview|confirm|generate)
// answer 410 before any managed-dataset decision, so they are deliberately absent;
// the managed gate must keep covering the still-live legacy reads.
const REQUIRED_LEGACY_PLAN_ROUTES = [
  "/v1/mobile/today",
  "/v1/mobile/training-plan-state",
  "/v1/mobile/workout-plan",
  "/v1/mobile/lock"
];

// ---------------------------------------------------------------------------
// R4 统一状态写入白名单
// ---------------------------------------------------------------------------
const TRAINING_STORE_FILE = "apps/api/src/training-plan-store.ts";
const MIGRATION_CLI_FILE = "scripts/migrate-training-planner.mts";
const TRAINING_STATE_WRITE_ALLOWED_FILES = new Set([TRAINING_STORE_FILE, MIGRATION_CLI_FILE]);
const TRAINING_STATE_WRITE_ALLOWED_PREFIXES = ["apps/api/src/training-plan-"];

// ---------------------------------------------------------------------------
// 扫描工具
// ---------------------------------------------------------------------------
function walk(directory, found = []) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(full, found);
    else if (SOURCE_FILE.test(entry)) found.push(full);
  }
  return found;
}

/** 扫描根不存在时直接失败：--root 指错目录不能变成「全部通过」。 */
function scannedFiles(scanRoots) {
  const files = [];
  for (const scanRoot of scanRoots) {
    const full = resolve(root, scanRoot);
    if (!existsSync(full)) {
      throw new Error(`扫描根不存在：${scanRoot}（--root 是否指错了？）`);
    }
    files.push(...walk(full));
  }
  return files;
}

const toRelative = (file) => relative(root, file).split(sep).join("/");
const readSource = (file) => readFileSync(file, "utf8");

/**
 * 找出文件里的 import/export-from/动态 import/require 语句（文本形状，不是 AST）。
 * 返回 `{ clause, module }`：`clause` 是 `from` 前的绑定子句（可能为空）。
 */
function importStatements(text) {
  const statements = [];
  // 静态 import / export … from（绑定子句里不允许出现分号，避免跨语句误配）。
  for (const match of text.matchAll(/\b(import|export)\b([^;]*?)\bfrom\s*(['"])([^'"]+)\3/g)) {
    statements.push({ kind: match[1], clause: match[2], module: match[4] });
  }
  // 副作用 import "./x.js"。
  for (const match of text.matchAll(/\bimport\s*(["'])([^"']+)\1/g)) {
    statements.push({ kind: "import", clause: "", module: match[2] });
  }
  // 动态 import("…") 与 require("…")。
  for (const match of text.matchAll(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g)) {
    statements.push({ kind: "dynamic-import", clause: "", module: match[2] });
  }
  for (const match of text.matchAll(/\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g)) {
    statements.push({ kind: "require", clause: "", module: match[2] });
  }
  return statements;
}

/** 模块说明符的 basename（去掉相对路径与 `.js`/`.mjs` 后缀）。 */
function moduleBasename(specifier) {
  const withoutSuffix = specifier.replace(/(?:\.(?:[cm]?js|tsx?|mts|cts))$/, "");
  return withoutSuffix.split("/").at(-1) ?? withoutSuffix;
}

/** 绑定子句里的具名绑定（支持 `a as b`；返回原始名与本地别名两端）。 */
function bindingNames(clause) {
  const names = new Set();
  const braces = /\{([^}]*)\}/g;
  for (const match of clause.matchAll(braces)) {
    for (const piece of match[1].split(",")) {
      const cleaned = piece.trim().replace(/^type\s+/, "");
      if (!cleaned) continue;
      const [original, local] = cleaned.split(/\s+as\s+/).map((part) => part.trim());
      if (original) names.add(original);
      if (local) names.add(local);
    }
  }
  return names;
}

function isTest(file) {
  return TEST_ROOTS.some((testRoot) => file.startsWith(`${testRoot}/`));
}
function isScript(file) {
  return file.startsWith("scripts/");
}
function inAllowed(file, allowedFiles, allowedPrefixes) {
  return allowedFiles.has(file) || allowedPrefixes.some((prefix) => file.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------
const problems = [];
const fail = (rule, message) => problems.push(`[${rule}] ${message}`);

function checkR1(productionFiles) {
  for (const file of productionFiles) {
    const relativePath = toRelative(file);
    if (isTest(relativePath)) continue;
    const text = readSource(file);
    const allowed = ALLOCATOR_ALLOWED_IMPORTERS.has(relativePath);

    // 具名 import 该分配器符号（含 `as` 别名）、namespace import 该模块
    // （`* as x` 之后可以 `x.<symbol>()`），或对符号做成员访问，都是第二个入口。
    // 只 import 模块里的其它函数（例如 `enforceAutomaticSessionDose`）不算：
    // 本判据针对的是**完整剂量分配器**，不是整个模块的所有导出。
    const statements = importStatements(text);
    const importsAllocatorSymbol = statements.some(
      (statement) => bindingNames(statement.clause).has(ALLOCATOR_SYMBOL)
    );
    const namespaceImportsAllocator = statements.some(
      (statement) => moduleBasename(statement.module) === ALLOCATOR_MODULE &&
        /\*\s+as\s+\w+/.test(statement.clause)
    );
    const memberAccess = new RegExp(`\\.${ALLOCATOR_SYMBOL}\\b`).test(text);
    if ((importsAllocatorSymbol || namespaceImportsAllocator || memberAccess) && !allowed) {
      const reason = importsAllocatorSymbol ? `import 了符号 ${ALLOCATOR_SYMBOL}`
        : namespaceImportsAllocator ? `以 namespace import 引入了 ${ALLOCATOR_MODULE}`
          : `出现 .${ALLOCATOR_SYMBOL} 成员访问`;
      fail("R1", `${relativePath} ${reason}；完整剂量分配器只允许 ${[...ALLOCATOR_ALLOWED_IMPORTERS].join("、")} 导入`);
    }
  }
}

function checkR2(productionFiles) {
  for (const file of productionFiles) {
    const relativePath = toRelative(file);
    if (isTest(relativePath) || isScript(relativePath)) continue;
    if (inAllowed(relativePath, WEEKLY_PLAN_ALLOWED_FILES, WEEKLY_PLAN_ALLOWED_PREFIXES)) continue;
    const text = readSource(file);

    const importsScheduler = importStatements(text).some((statement) =>
      bindingNames(statement.clause).has(WEEKLY_PLAN_SYMBOL) ||
      (/\*\s+as\s+\w+/.test(statement.clause) &&
        moduleBasename(statement.module) === WEEKLY_PLAN_MODULE));
    const memberAccess = new RegExp(`\\.${WEEKLY_PLAN_SYMBOL}\\b`).test(text);
    if (importsScheduler) {
      fail("R2", `${relativePath} import 了 ${WEEKLY_PLAN_SYMBOL}；旧周生成器只允许白名单文件引用（新排课入口应走统一计划模块）`);
    } else if (memberAccess) {
      fail("R2", `${relativePath} 出现 .${WEEKLY_PLAN_SYMBOL} 成员访问；旧周生成器只允许白名单文件引用`);
    }
  }
}

function checkR3() {
  const serverPath = resolve(root, SERVER_FILE);
  const storePath = resolve(root, STORE_FILE);
  const server = readSource(serverPath);
  const srcFiles = scannedFiles(["apps/api/src"]).filter((file) => !isTest(toRelative(file)));

  // 3a. `coachLoopState(` 只允许出现在：mobile-goals.ts 的方法定义、
  //     coach-loop-runtime.ts 的收据读取、server.ts 的托管谓词内部。
  for (const file of srcFiles) {
    const relativePath = toRelative(file);
    if (relativePath === STORE_FILE) continue; // 方法定义在下面单独查
    const text = readSource(file);
    const calls = [...text.matchAll(/\.coachLoopState\s*[<(]/g)];
    if (calls.length === 0) continue;
    if (relativePath === SERVER_FILE) {
      if (calls.length !== 1) {
        fail("R3", `${SERVER_FILE} 出现 ${calls.length} 处 .coachLoopState；托管判定必须恰好一处且走 ${MANAGED_HELPER}`);
        continue;
      }
      const managedBlock = new RegExp(
        `${MANAGED_HELPER}\\s*\\([\\s\\S]{0,600}?\\.coachLoopState\\s*<`
      );
      if (!managedBlock.test(text)) {
        fail("R3", `${SERVER_FILE} 的 .coachLoopState 没有包在 ${MANAGED_HELPER}(...) 里；ended 收据不得继续算托管`);
      }
    } else if (relativePath !== RUNTIME_FILE) {
      fail("R3", `${relativePath} 直接检查 .coachLoopState 存在性；路由/服务必须用状态感知的 ${MANAGED_PREDICATE}()`);
    }
  }

  // 3b. 状态感知谓词必须是导入的纯函数，且只定义一次。
  const runtimeImport = new RegExp(
    `import\\s*\\{[^}]*\\b${MANAGED_HELPER}\\b[^}]*\\}\\s*from\\s*["']\\.\\/coach-loop-runtime\\.js["']`
  );
  if (!runtimeImport.test(server)) {
    fail("R3", `${SERVER_FILE} 没有从 ${RUNTIME_FILE} 导入状态感知谓词 ${MANAGED_HELPER}`);
  }
  let helperDefinitions = 0;
  let helperDefinitionFile = null;
  for (const file of srcFiles) {
    const text = readSource(file);
    const count = [...text.matchAll(new RegExp(`\\bfunction\\s+${MANAGED_HELPER}\\b`, "g"))].length;
    helperDefinitions += count;
    if (count > 0) helperDefinitionFile = toRelative(file);
  }
  if (helperDefinitions !== 1 || helperDefinitionFile !== RUNTIME_FILE) {
    fail("R3", `${MANAGED_HELPER} 必须只在 ${RUNTIME_FILE} 定义一次（当前 ${helperDefinitions} 处，${helperDefinitionFile ?? "无"}）`);
  }

  // 3c. `coachLoopManaged` 只允许定义/导入在 server.ts。
  const managedDefinition = new RegExp(`(?:function|const|let|var)\\s+${MANAGED_PREDICATE}\\b`);
  for (const file of srcFiles) {
    const relativePath = toRelative(file);
    if (relativePath === SERVER_FILE) continue;
    const text = readSource(file);
    const duplicateDefinition = managedDefinition.test(text);
    const importedPredicate = importStatements(text).some(
      (statement) => bindingNames(statement.clause).has(MANAGED_PREDICATE)
    );
    if (duplicateDefinition || importedPredicate) {
      fail("R3", `${relativePath} 定义/导入了第二个 ${MANAGED_PREDICATE}；托管判定只允许 ${SERVER_FILE} 定义并调用`);
    }
  }
  if (!new RegExp(`const\\s+${MANAGED_PREDICATE}\\s*=`).test(server)) {
    fail("R3", `${SERVER_FILE} 缺少统一托管谓词 ${MANAGED_PREDICATE}`);
  }
  // 3d. 旧计划路由前缀清单仍在，且由 `const managed = coachLoopManaged()` 判定。
  if (!new RegExp(`const\\s+managed\\s*=\\s*${MANAGED_PREDICATE}\\(\\s*\\)\\s*;`).test(server)) {
    fail("R3", `${SERVER_FILE} 的旧计划路由门禁没有使用 const managed = coachLoopManaged()`);
  }
  if (!/\bif\s*\(\s*managed\s*&&/.test(server)) {
    fail("R3", `${SERVER_FILE} 的 managed && 路由判定形状缺失`);
  }
  for (const route of REQUIRED_LEGACY_PLAN_ROUTES) {
    if (!server.includes(`"${route}"`) && !server.includes(`'${route}'`)) {
      fail("R3", `${SERVER_FILE} 缺少受托管门禁的旧计划路由 ${route}`);
    }
  }

  // 3e. 握手能力位也必须由同一谓词决定，不能按收据存在直接宣告。
  if (!new RegExp(`${MANAGED_PREDICATE}\\(\\)\\s*\\?\\s*\\{\\}\\s*:\\s*\\{\\s*planSnapshotContractVersion`).test(server)) {
    fail("R3", `${SERVER_FILE} 的 planSnapshotContractVersion 能力位没有由 ${MANAGED_PREDICATE}() 决定`);
  }

  // 3f. 方法定义仍存在于 mobile-goals.ts（否则 R3 的收据读取没有对象）。
  const store = readSource(storePath);
  if (!/\bcoachLoopState\s*</.test(store)) {
    fail("R3", `${STORE_FILE} 不再提供 coachLoopState 读取入口，收据生命周期判据失效`);
  }
}

const TRAINING_STATE_WRITE_PATTERN =
  /\b(?:INSERT\s+(?:OR\s+[A-Za-z]+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["'`]?mobile_training_state/i;

function checkR4(productionFiles) {
  for (const file of productionFiles) {
    const relativePath = toRelative(file);
    if (isTest(relativePath)) continue;
    const allowed = inAllowed(relativePath, TRAINING_STATE_WRITE_ALLOWED_FILES, TRAINING_STATE_WRITE_ALLOWED_PREFIXES);
    const text = readSource(file);
    if (TRAINING_STATE_WRITE_PATTERN.test(text) && !allowed) {
      fail("R4", `${relativePath} 手写了 mobile_training_state 的写入 SQL；统一状态只能经 ${TRAINING_STORE_FILE} 的事务写`);
    }
    if (/\bapplyMigration\b/.test(text) && !allowed) {
      fail("R4", `${relativePath} 直接调用 applyMigration；统一状态迁移只允许 ${TRAINING_STORE_FILE} 与迁移 CLI`);
    }
  }
}

function expandGlob(prefix) {
  const directory = resolve(root, prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : ".");
  const namePrefix = prefix.slice(prefix.lastIndexOf("/") + 1);
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(namePrefix) && SOURCE_FILE.test(entry) &&
      statSync(join(directory, entry)).isFile())
    .map((entry) => `${prefix.slice(0, prefix.lastIndexOf("/") + 1)}${entry}`);
}

function checkR5() {
  const explicitFiles = [
    ...ALLOCATOR_ALLOWED_IMPORTERS,
    ...WEEKLY_PLAN_ALLOWED_FILES,
    SERVER_FILE,
    RUNTIME_FILE,
    STORE_FILE,
    TRAINING_STORE_FILE,
    MIGRATION_CLI_FILE
  ];
  for (const relativePath of new Set(explicitFiles)) {
    if (!existsSync(resolve(root, relativePath))) {
      fail("R5", `白名单指向的文件不存在：${relativePath}（改名会让判据静默失效，必须同步改门禁）`);
    }
  }
  const globPrefixes = [...WEEKLY_PLAN_ALLOWED_PREFIXES, ...TRAINING_STATE_WRITE_ALLOWED_PREFIXES];
  for (const prefix of globPrefixes) {
    if (expandGlob(prefix).length === 0) {
      fail("R5", `白名单前缀 ${prefix}* 一个文件都没命中（改名会让判据静默失效）`);
    }
  }
  for (const scanRoot of [...PRODUCTION_ROOTS, ...TEST_ROOTS]) {
    if (!existsSync(resolve(root, scanRoot))) {
      fail("R5", `扫描根不存在：${scanRoot}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
function main() {
  let productionFiles;
  let testFiles;
  try {
    productionFiles = scannedFiles(PRODUCTION_ROOTS).filter(
      (file) => toRelative(file) !== GATE_RELATIVE_PATH
    );
    testFiles = scannedFiles(TEST_ROOTS);
  } catch (error) {
    process.stderr.write(`single-writer 结构门禁无法开始：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // 先做 R5 白名单/根目录自检：文件被改名时，后面的规则读取会直接 ENOENT；
  // 先报"白名单指向的文件不存在"比抛栈更容易读懂。
  checkR5();
  if (problems.length === 0) {
    checkR1(productionFiles);
    checkR2(productionFiles);
    checkR3();
    checkR4(productionFiles);
  }

  const summary = `single-writer 结构门禁：R1–R5 / 生产源文件 ${productionFiles.length} / 测试文件 ${testFiles.length}（R1/R2/R4 豁免）/ 违规 ${problems.length}`;
  process.stdout.write(`${summary}\n`);
  if (problems.length === 0) {
    process.stderr.write("single-writer 结构门禁通过。\n");
    return 0;
  }
  for (const problem of problems) process.stdout.write(`  🔴 ${problem}\n`);
  process.stderr.write(`\nsingle-writer 结构门禁失败：${problems.length} 处。\n`);
  return 1;
}

process.exitCode = main();
