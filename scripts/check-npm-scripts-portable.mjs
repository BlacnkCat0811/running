#!/usr/bin/env node
/**
 * npm script 的"双方言"闸门（`npm run check:scripts`）。
 *
 * 🔴 每一条规则都是**本机（Windows）实测坏过的**，不是风格偏好：
 *   · `npm test` 曾是 `… ; node_status=$?; … test … -a …`：cmd 下 `;` 不是分隔符，
 *     `node_status=$?` 被当作 argv 塞给 node，`test` 被判"不是内部或外部命令" ⇒ Windows 上直接坏。
 *   · `test:ios` 曾是 `bash apps/ios/tests/run-ios-gates.sh`：本机 `bash` 解析到
 *     `C:\Windows\System32\bash.exe`（WSL 启动器，不是 Git Bash），没装分发版时 exit 1。
 *   · `test:ios:mutation:scope` 曾是 `RAI_MUTATION_FOR=git python3 …`：cmd 报
 *     `'RAI_MUTATION_FOR' is not recognized as an internal or external command`。
 *   · `open:ios` 曾是裸 `open …`：macOS 专属，Windows 上 `'open' is not recognized`。
 *
 * 三条硬规则（进闸门，而不是停留在口头约定）：
 *   1. 正文只允许双方言都认的语法：`&&`、纯命令、`node xxx.mjs`。
 *      禁用 `;`、`$?`、`$VAR`/`$(…)`、`VAR=x cmd`、`test`、`[ ]`、`uname`、依赖 shell 展开的 `*`。
 *   2. 平台判定只在脚本内部：Node 用 `process.platform`，bash 用 `uname -s`。
 *   3. `.sh` 一律 `bash <path>` 调用，不写 `./x.sh`（Windows 的 git 默认不记录 +x 位）；
 *      能用 .mjs 就 .mjs，`.sh` 只留"必须在 macOS 跑"的部分。
 *      注意这条的**适用层级**：`bash <path>` 是 .mjs/.sh **内部**的调用形式；
 *      npm script 正文里连裸 `bash` 都不许出现 —— 那里只能取 PATH 上的 bash，
 *      而 Windows 的 PATH 上放的是 WSL 启动器（本机实测 exit 1）。
 *
 * 为什么值得单独一个闸门：上面四条**每一条都真的坏过一次**，而坏法都是"Mac 上好好的、
 * Windows 上是红的"。判据存在 ≠ 判据被执行 —— 只有人记得时才检查，等于不检查。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 出现在正文任何位置都不合法的写法。 */
export const BODY_RULES = [
  {
    token: ";",
    pattern: /;/,
    why: "cmd 不把 `;` 当分隔符，它会被当作参数塞给前一个命令（实测 `node_status=$?` 被当成 node 的 argv）"
  },
  {
    token: "$?",
    pattern: /\$\?/,
    why: "`$?` 只有 POSIX shell 有；子进程退出码在 Node 里读 spawnSync 的 status"
  },
  {
    token: "$VAR / $(…)",
    pattern: /\$(?!\?)[A-Za-z_{(]/,
    why: "依赖 shell 展开；改成在脚本内部读 process.env，给子进程传参用 spawnSync 的 env"
  },
  {
    token: "*",
    pattern: /\*/,
    why: "`*` 依赖 shell 展开，cmd 不展开；在 Node 里显式枚举文件名（样板见 scripts/run-tests.mjs）"
  }
];

/** 每条命令段（按 `&&` 切分）的**段首**禁令。 */
export const SEGMENT_RULES = [
  {
    token: "VAR=x cmd",
    pattern: /^[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+\S/,
    why: "命令前置赋值是 POSIX 专属，cmd/PowerShell 都不认；env 交给 spawnSync 的 env（见 scripts/run-ios.mjs）"
  },
  {
    token: "test",
    pattern: /^test(\s|$)/,
    why: "`test` 在 cmd 下不是命令（实测被判\"不是内部或外部命令\"）；判定放进 Node/Python 脚本"
  },
  {
    token: "[ … ]",
    pattern: /^\[(\s|$)/,
    why: "`[ … ]` 是 POSIX 内建；npm script 里不做条件判断"
  },
  {
    token: "uname",
    pattern: /^uname(\s|$)/,
    why: "平台判定只能在脚本内部：Node 用 process.platform，bash 用 uname -s"
  },
  {
    token: "bash（PATH 上的）",
    pattern: /^bash(\s|$)/,
    why: "npm script 里的 `bash` 只能取 PATH 上的那个；Windows 上它解析到 C:\\Windows\\System32\\bash.exe"
      + "（WSL 启动器，不是 Git Bash，实测 exit 1）。.sh 交给 node 包装去挑解释器（见 scripts/run-ios.mjs）"
  },
  {
    token: "python3 / python / py",
    pattern: /^(python3?|py)(\s|$)/,
    why: "解释器名三端不一致（本机 Windows 只有 python / py，没有 python3）；用 node 包装，解释器选择放进脚本"
  },
  {
    token: "open",
    pattern: /^open(\s|$)/,
    why: "`open` 是 macOS 专属；用 node 包装（样板见 scripts/open-ios.mjs）"
  },
  {
    token: "./x",
    pattern: /^\.\//,
    why: "以 `./x` 调用依赖可执行位（Windows 的 git 默认不记录 +x 位）；写 `node <path>` 或 `bash <path>`"
  }
];

/** `&&` 切分出的命令段。 */
export function segments(body) {
  return body.split("&&").map((part) => part.trim()).filter((part) => part !== "");
}

/** `.sh` 必须由 `bash` 调用（规则 3）：段首不是 bash 就违规。 */
export function shellScriptViolation(segment) {
  const tokens = segment.split(/\s+/).filter((token) => token !== "");
  const scripts = tokens.filter((token) => token.endsWith(".sh"));
  if (scripts.length === 0 || tokens[0] === "bash") return null;
  return {
    token: scripts.join(" "),
    why: "`.sh` 一律用 `bash <path>` 调用（不写 ./x.sh：Windows 的 git 默认不记录 +x 位）"
  };
}

/** 纯函数：一条 script 正文 ⇒ 违规清单（空数组 = 合法）。 */
export function inspectScript(body) {
  const violations = [];
  for (const rule of BODY_RULES) {
    if (rule.pattern.test(body)) violations.push({ token: rule.token, why: rule.why });
  }
  for (const segment of segments(body)) {
    for (const rule of SEGMENT_RULES) {
      if (rule.pattern.test(segment)) violations.push({ token: rule.token, why: rule.why, segment });
    }
    const shell = shellScriptViolation(segment);
    if (shell) violations.push({ ...shell, segment });
  }
  return violations;
}

/** 根 + 各 workspace（npm workspaces = packages/* + apps/*）的 package.json。 */
export function workspaceManifests(base = root) {
  const files = [join(base, "package.json")];
  for (const group of ["apps", "packages"]) {
    const directory = join(base, group);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(directory, entry.name, "package.json");
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

export function auditWorkspace(base = root) {
  const manifests = workspaceManifests(base);
  const findings = [];
  let scriptCount = 0;
  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const [name, body] of Object.entries(manifest.scripts ?? {})) {
      scriptCount += 1;
      for (const violation of inspectScript(body)) {
        findings.push({ file: relative(base, file).replaceAll("\\", "/"), name, body, ...violation });
      }
    }
  }
  return { findings, scriptCount, manifestCount: manifests.length };
}

export function main() {
  const { findings, scriptCount, manifestCount } = auditWorkspace();
  if (findings.length === 0) {
    console.log(`✅ npm script 跨平台语法检查通过：${manifestCount} 个 package.json / ${scriptCount} 条 script。`);
    return 0;
  }
  console.error(`❌ npm script 跨平台语法检查失败：${findings.length} 处（这些写法在 cmd / PowerShell 下会坏）。`);
  for (const finding of findings) {
    console.error(`\n  ${finding.file} → "${finding.name}"`);
    console.error(`      正文：${finding.body}`);
    console.error(`      违规：${finding.token}`);
    console.error(`      原因：${finding.why}`);
  }
  console.error("\n规则：正文只用 `&&`、纯命令、`node xxx.mjs`；平台判定、env 与解释器选择全部放进脚本内部。");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
