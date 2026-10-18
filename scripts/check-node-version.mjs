import { pathToFileURL } from "node:url";

const MINIMUM_MINOR = 12;

/**
 * 受支持的是两条 LTS 线：22.12+ 与 24.x。
 *
 * - **22.12+（22 LTS）**：仓库固定的默认开发/部署版本（见根目录 `.nvmrc`），闸门从未拒绝过它。
 * - **24.x（24 LTS）**：2026-10-12 在 Node v24.21.0 + 真实 npm 11.6.2 上实测后放行 ——
 *   `tsc --noEmit` 两个 project 退出码 0；Node 套件当时 1673 条里 1669 通过，**唯一**失败的那条
 *   正是当时尚在断言「24 必须被拒绝」的策略测试（随本改动一并放宽）；v33/v34/v35 迁移与
 *   「生产必须走 tsx」的冻结校验和也为绿。
 *   ⚠️ **历史证据边界（2026-10-18 深度审查 P3-35）**：同一段记录里还写着"Web vitest 25 个
 *   文件 / 184 条全过"与"`npm run build` 成功"——这两项已随 Web/macOS 退役（D17）**删除**，
 *   此后**不可复跑**，只能作为 2026-10-12 的时点记录，不能当作当前判据。Node 侧的证据仍可
 *   复验：2026-10-18 时 Node 套件已扩到 257 个测试文件（条数以 `npm test` 输出为准）。
 *   也就是说，放行 24 是**实测结论**，不是顺手放宽；反过来，这条改动一旦被回退，可复验的
 *   Node 侧绿就没有任何东西在守了（Web 侧那半本来就已不存在）。
 *
 * 奇/当前版本（23、25）不接受：它们既非 LTS、也未被实测。预发布版一律不接受 —— npm 的
 * `>=22.12.0 <23 || >=24.0.0 <25` engine 区间同样排除预发布，除非比较符显式选择加入。
 *
 * ⚠️ 拒绝时的报错文本被 `apps/api/test/node-version.test.ts` 钉着，改这里必须同步改那里。
 */
export function isSupportedNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 22) return minor >= MINIMUM_MINOR;
  return major === 24;
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  if (isSupportedNodeVersion(version)) return;
  throw new Error(
    `Unsupported Node.js ${version}. RAI requires Node.js >=22.12.0 <23 or >=24.0.0 <25 (Node 22/24 LTS).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
