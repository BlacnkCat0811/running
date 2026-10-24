/**
 * 只能在 POSIX 上执行的判据在 Windows 上必须**显式跳过**，并且跳过理由必须说清
 * "这条判据没有被检查"——不许静默放过（仓库规则见 `scripts/run-ios.mjs` 头注释、
 * `.githooks/pre-commit` 与 `apps/ios/tests/run-ios-gates.sh`：a skip must be loud
 * and must say what was not checked）。
 *
 * 为什么需要这个文件：`windows-latest` 上的 `npm test`（2026-10-25，node 22.x，
 * `RAI_TEST_CONCURRENCY=2`）实测 2539 pass / 52 fail / 1 cancelled。那 52 条都不是
 * 计时抖动，而是**结构性**的 POSIX 假设，分三类：
 *
 *   1. 故障注入靠信号：Windows 没有信号，`process.kill(pid, "SIGKILL")` 由 libuv 映射成
 *      `TerminateProcess`（无 handler、无 flush、无 finally），于是 `child.signalCode`
 *      恒为 `null`、`exitCode` 变成 1 —— `assert.equal(child.signalCode, "SIGKILL")`
 *      在 Windows 上永远不成立。
 *   2. `deploy/*.sh` 由 bash 替身驱动：`systemctl`/`git` 这类替身在 Windows 上要么命中不了
 *      （node 的 `spawnSync` 只解析 `.exe/.cmd/.bat`，无扩展名的 shebang 脚本起不来），
 *      要么与 Windows 形态的 PATH 混拼，脚本在第一个替身记录前就退出。
 *   3. 文件系统语义：Windows 不允许 rename/unlink **仍被打开**的文件（EPERM/EBUSY），
 *      权限位不阻止读取，`realpathSync.native` 与 JS 版 `realpathSync` 对同一文件给出
 *      不同拼写（长名 vs 8.3 短名）。
 *
 * 这三类都**不是**"这条判据在 Windows 上成立/不成立"，而是"这条判据在这里做不出来"。
 * 真正的 Windows 兼容性是另一个工作包；本函数只负责把"没检查"这件事说出来。
 *
 * 用法（必须作为 node:test 的第二个参数，与既有 `{ timeout }`/`{ skip }` 合并而不是覆盖）：
 *
 *   test("…", { skip: posixOnlyReason("…理由…") }, async () => { … });
 *   test("…", { timeout: 180_000, skip: posixOnlyReason("…理由…") }, async () => { … });
 *
 * 理由里必须写平台机制与 CI 证据日期（2026-10-25），不要写 "not supported on Windows"。
 *
 * ⚠️ `.mjs` 测试文件不能 import `.ts`：那两处内联同样的三行常量（见
 * `phase6-safety.test.mjs` / `phase6-driver.test.mjs` 的 `POSIX_ONLY`），不要为了 DRY
 * 去建第二套加载路径。
 */
export function posixOnlyReason(why: string): string | false {
  return process.platform === "win32" ? why : false;
}
