import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { posixOnlyReason } from "./posix-only.js";

const canRunBash = spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;

/**
 * 本文件**四条用例全部是** `deploy/upgrade.sh` 的行为级判据（bash + PATH 替身），所以整文件
 * 统一在 Windows 上显式跳过，而不是逐条挑。
 *
 * 🔴 CI 2026-10-25（`windows-latest`）：4 条全部红在 `scenario()` 的
 * "deploy/upgrade.sh recorded no command — it died before the first stub ran"，
 * `status=128`、stderr 是真实 git 的两行 `fatal: not a git repository`。机制是平台性的：
 * 夹具把替身目录用 POSIX 的 `:` 拼进 `PATH`，而 Windows 的 `PATH` 是 `;` 分隔且条目带盘符，
 * 拼出来的条目既不是 MSYS 形态也不是 Windows 形态，`git`/`systemctl`/`npm` 替身因此
 * 命中不了（脚本直接用到宿主机的真实 `git`，在夹具目录里当然"不是 git 仓库"）。
 * 升级脚本本身只面向 Linux systemd，它要证明的顺序（stop → migrate → reset-failed → restart）
 * 在 Windows 上没有可复现的服务管理器语义。
 */
const UPGRADE_SCRIPT_ONLY = posixOnlyReason(
  "deploy/upgrade.sh 的判据靠 bash + PATH 替身记录 systemctl/git/npm 的调用序列；Windows 的 PATH 是 "
  + "\";\" 分隔且带盘符，夹具用 \":\" 拼进去的替身目录命中不了，脚本在第一个替身记录命令之前就以 "
  + "status=128 退出（CI 2026-10-25：stderr 是真实 git 的 `fatal: not a git repository`，"
  + "`recorded no command`）。因此『迁移必须落在停服与重启之间 / 发布脚本不得代做备份 / 迁移失败必须"
  + "让服务保持停止 / HTTP 200 但未就绪必须拒绝』这四条判据在 Windows 上没有被检查；"
  + "Linux systemd 语义另立工单。"
);

const bashTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, {
    skip: !canRunBash ? "bash is required for deploy script tests" : UPGRADE_SCRIPT_ONLY
  }, fn);

/**
 * `upgrade.sh` 用 `/*` 判"绝对路径"（与生产 Linux 语义一致）；Windows 盘符路径（`C:\…`）
 * 不满足，脚本会在参数检查处退出 2 —— 看起来像"脚本坏了"，其实是路径方言不同。
 * 这里把盘符路径转成 Git Bash 的 MSYS 形式（`/c/…`）；POSIX 平台原样返回。
 */
function shellAbsolutePath(value: string): string {
  if (process.platform !== "win32") return value;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  return match === null ? value : `/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}`;
}

function scenario(options: { failMigration?: boolean; recovery?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rai-upgrade-test-"));
  const bin = join(root, "bin");
  const app = join(root, "app");
  const log = join(root, "commands");
  mkdirSync(bin);
  mkdirSync(join(app, ".git"), { recursive: true });
  writeFileSync(join(root, "rai.env"), "RAI_API_TOKEN=test-token\n");
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("sudo", 'if [ "$1" = "-u" ]; then shift 2; fi\nexec "$@"');
  stub("git", 'case "$*" in *rev-parse*) echo fixed-revision ;; esac');
  stub("npm", 'echo "npm $*" >> "$TEST_COMMANDS"\ncase "$*" in *data:migrate*) [ "$TEST_FAIL_MIGRATION" != "1" ] || exit 17 ;; esac');
  stub("systemctl", 'echo "systemctl $*" >> "$TEST_COMMANDS"');
  stub("sleep", "exit 0");
  // `post` 分支的日志行是 §11 的判据：脚本里唯一的 POST 曾是备份调用，
  // 所以这行只在"又有人在发布脚本里代做备份"时出现。
  stub("curl", `
output=""; authenticated=0; post=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -H) authenticated=1; shift 2 ;;
    -X) post=1; shift 2 ;;
    *) shift ;;
  esac
done
if [ "$post" -eq 1 ]; then
  echo backup >> "$TEST_COMMANDS"; echo 201
elif [ "$authenticated" -eq 1 ]; then
  printf '%s' "$TEST_HEALTH" > "$output"; echo 200
else echo 401
fi`);
  try {
    const result = spawnSync("bash", [resolve("deploy/upgrade.sh"), "--apply", "--migrate", "--database", shellAbsolutePath(join(root, "rai.sqlite"))], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAI_APP_DIR: app,
        RAI_ENV_FILE: join(root, "rai.env"), RAI_SERVICE: "rai-test", TEST_COMMANDS: log,
        TEST_FAIL_MIGRATION: options.failMigration ? "1" : "0",
        TEST_HEALTH: JSON.stringify({ status: options.recovery ? "recovery_required" : "ok", databaseReady: !options.recovery }) }
    });
    // A missing log means the script died before the first stub could record anything;
    // surface why instead of reporting a misleading ENOENT from readFileSync.
    if (!existsSync(log)) {
      assert.fail(
        "deploy/upgrade.sh recorded no command — it died before the first stub ran."
        + ` status=${String(result.status)} signal=${String(result.signal)}`
        + ` error=${result.error?.message ?? "none"}`
        + ` stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
      );
    }
    return { ...result, commands: readFileSync(log, "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

bashTest("explicit upgrade migration runs between service stop and restart", () => {
  const result = scenario();
  assert.equal(result.status, 0, result.stderr);
  // backup-reminder 是 `say` 的 **stdout** 提示，不进命令替身日志 —— 原断言把它写进
  // `commands` 的行为级匹配是笔误，且本仓从未在有 bash 的环境跑过这一条（本机历来 SKIP），
  // 直到今天补上 Windows 路径方言后才现形。按下述三段分开钉：
  assert.match(result.stdout, /backup-reminder/, "backup-reminder 提示必须输出");
  assert.match(result.commands, /systemctl stop rai-test[\s\S]*data:migrate[\s\S]*systemctl reset-failed rai-test[\s\S]*systemctl restart rai-test/);
  // "提示先于停服"的顺序判据只能源码级：stdout 与命令日志是两条流，行为级拿不到跨流相对顺序。
  const upgradeSource = readFileSync(resolve("deploy/upgrade.sh"), "utf8");
  const reminderAt = upgradeSource.indexOf('say "backup-reminder');
  const stopAt = upgradeSource.indexOf('run systemctl stop "$SERVICE"');
  assert.ok(reminderAt >= 0 && stopAt >= 0 && reminderAt < stopAt,
    "backup-reminder 提示必须排在停服命令之前（顺序本身是判据：先动库后提醒备份是错的）");
});

// §11「项目退出备份责任」＋ §14.2 A15：发布脚本**不再** POST /v1/backups。
//
// 为什么必须有一条行为级用例，而不是只 grep 源码：这条守卫此前的失效模式正是
// "看着没调用、实际在调用" —— 升级脚本曾经 POST /v1/backups 并把非 2xx 当成
// "备份失败，中止发布"。只对源码做文本匹配的话，换个变量拼接就能绕过；
// 这里让脚本**真的跑一遍**（bash + PATH 上的 curl 替身），再断言替身没被 POST 过。
//
// ⚠️ 同时钉住"不是静默失败"：§11 要求输出**外部备份责任提示**，所以光断言
// "没有 POST" 是不够的 —— 把备份闸门整段删掉也能让上面那条通过。
bashTest("upgrade publishes an external-backup notice and never POSTs a backup", () => {
  const result = scenario();
  assert.equal(result.status, 0, result.stderr);

  // 行为级：curl 替身只在被 POST 时记 `backup`。脚本里唯一的 POST 就是备份调用，
  // 所以这一行同时钉住"没有 POST /v1/backups"与"没有别的写请求混进来"。
  assert.doesNotMatch(result.commands, /backup\b/,
    "发布脚本仍在执行备份调用：§11 要求它把备份责任交给运维，而不是代做");

  // 行为级（另一半）：必须**说出**责任在运维，且不校验外部备份是否完成。
  assert.match(result.stdout, /备份责任：应用不创建备份/,
    "§11 要求输出外部备份责任提示，而不是静默跳过备份");
  assert.match(result.stdout, /不代做、不校验/, "提示必须说清应用不校验外部备份是否完成");
  assert.match(result.stdout, /§11\.1/,
    "提示必须指向文档 §11.1 的对外备份约束（活跃 WAL 库不能只 cp）");

  // 源码级（与上一条独立）：连备份端点都不该再出现在**可执行**代码里。
  // ⚠️ 必须先剥掉注释行：脚本头部要写明"本脚本不再 POST /v1/backups"（§11 的要求），
  // 直接对全文匹配会把这个说明本身判红，于是判据逼着人删掉解释 —— 那是错的取舍。
  const code = readFileSync(resolve("deploy/upgrade.sh"), "utf8")
    .split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /v1\/backups/, "deploy/upgrade.sh 不得在可执行代码里引用 /v1/backups");
  assert.doesNotMatch(code, /-X POST/, "deploy/upgrade.sh 不得再发任何 POST");
});

bashTest("failed migration leaves the service stopped", () => {
  const result = scenario({ failMigration: true });
  assert.equal(result.status, 17, result.stderr);
  assert.match(result.commands, /systemctl stop rai-test/);
  assert.doesNotMatch(result.commands, /systemctl restart|systemctl reset-failed/);
});

bashTest("upgrade rejects HTTP 200 maintenance state", () => {
  const result = scenario({ recovery: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /未真实就绪/);
});
