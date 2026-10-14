import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import type { HandshakeResponse } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";

const projectRoot = resolve(import.meta.dirname, "../../..");

/**
 * 本文件钉的是**协商面**，不是回执本体：iOS 侧只有在
 * `handshake.factsAnalysisContractVersion == 1` 之后才去读 `/v1/import-jobs/:id` 的
 * `summary.directSync`（回执字段由 PR1 落地，本批不改名、不新增端点）。
 *
 * 因此这里判两件互不可替代的事：
 * ①**行为**：真服务端确实宣告了这个能力位，且既有能力位一个不少、取值不变；
 * ②**结构**：它在合同上必须是**可选**的 —— 一旦改成必填，老客户端 decode 直接失败，
 *   而这种改动 `node --test`（走 tsx 剥类型）不会报错，只能靠源码级判据拦住。
 */
test("真实 /v1/handshake 宣告 factsAnalysisContractVersion=1，且既有能力位一个不少、取值不变", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-direct-sync-handshake-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  (await RaiDatabase.open(databasePath)).close();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    // 身份三元组显式钉住（它们就是 server.ts 的默认值）：下文按字面量断言取值，
    // 靠默认值兜着的话，默认值一变"取值不变"这条判据就悄悄失效了。
    env: {
      ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "",
      RAI_SERVER_ID: "local", RAI_ATHLETE_ID: "athlete_1", RAI_DATASET_EPOCH: "default"
    },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    const response = await fetch(`${url}/v1/handshake`);
    assert.equal(response.status, 200, await response.clone().text());
    const handshake = await response.json() as HandshakeResponse;

    assert.equal(handshake.factsAnalysisContractVersion, 1,
      "缺这个能力位，iOS 会（正确地）静默退回旧字段路径，直连回执就永远没人读");

    // 既有字段一个不缺、取值不变：顺带挡住"为了加能力位而重写响应对象"这类事故。
    assert.equal(handshake.serverId, "local");
    assert.equal(handshake.athleteId, "athlete_1");
    assert.equal(handshake.datasetEpoch, "default");
    assert.equal(handshake.syncProtocolVersion, 1);
    assert.equal(handshake.apiVersion, "v1");
    assert.equal(handshake.healthKitRecordSyncVersion, 2);
    assert.equal(handshake.planReceiptMetadata, true);
    assert.equal(handshake.planSnapshotContractVersion, 1);
    assert.equal(handshake.coachLoopContractVersion, 1);
    assert.equal(handshake.planReceiptContractVersion, 2);

    // 观测阶段 1（S1.2）：直连单批上界随握手暴露 —— iOS 分批版据此收敛拆批预算。
    // 数值与 `direct-sync-ingest.ts` 的常量同源；这里按**字面量**钉住，
    // 两处任意一边改了而另一边没跟，这条先红。
    assert.deepEqual(handshake.directSyncBounds, {
      maxXmlBytes: 2 * 1024 * 1024,
      maxRecords: 5000,
      maxRouteFiles: 200,
      maxRouteBytes: 32 * 1024 * 1024
    }, "directSyncBounds 必须随 /v1/handshake 暴露（缺它 iOS 只能回落保守常量）");
  } finally {
    await stopApi(child);
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("HandshakeResponse 上能力位必须声明为可选：改成必填会让老客户端 decode 失败", () => {
  const source = readFileSync(join(projectRoot, "packages/api-contracts/src/index.ts"), "utf8");
  const body = interfaceBody(source, "HandshakeResponse");
  const declarations = body.split(/\r?\n/)
    .filter((line) => /^\s*factsAnalysisContractVersion\??\s*:/.test(line));
  assert.equal(declarations.length, 1,
    `能力位应有且只有一条声明，实际：${JSON.stringify(declarations)}`);
  const [declaration] = declarations;
  assert.ok(declaration, "找不到 factsAnalysisContractVersion 的声明");
  assert.match(declaration, /^\s*factsAnalysisContractVersion\?: number;$/,
    "能力位必须是可选的 `?:`：老服务端省略它，老客户端也不会因为它而 decode 失败");
  // 观测阶段 1 的 bounds 同属"可选新增"：老服务端（收口前）省略它，iOS 走保守常量。
  assert.match(body, /directSyncBounds\?:\s*\{/,
    "directSyncBounds 必须声明为可选属性（`?:`）：省略它不能破坏任何一端的 decode");
});

test("老客户端视角：不带能力位也能构造出合法 HandshakeResponse", () => {
  // 运行期断言只是陪衬；真正的判据在**编译期** —— 能力位一旦改成必填，
  // 下面这个缺字段的对象就不再满足 HandshakeResponse，`tsc -p tsconfig.json` 直接失败。
  // `node --test` 走 tsx 剥类型、看不到这一点，所以上一条源码级判据是必须的兜底。
  const legacyHandshake: HandshakeResponse = {
    serverId: "local", athleteId: "athlete_1", datasetEpoch: "default",
    syncProtocolVersion: 1, apiVersion: "v1"
  };
  assert.equal("factsAnalysisContractVersion" in legacyHandshake, false);
});

test("能力位的字面量在服务端源码里只有一处，且就是握手响应那一处", () => {
  // 先把"扫描面本身没被悄悄收窄"钉住：否则把 roots 缩成 `apps/api/src` 一处，
  // 这条判据会继续绿着、却失去跨包覆盖 —— 本仓明确厌恶这种**静默失效**的守卫
  // （见 `packages/contracts/src/direct-sync.ts` 关于"声称有第二道守卫"的那段）。
  const scanned = productionTypeScriptFiles().map((file) => relative(projectRoot, file).replace(/\\/g, "/"));
  for (const required of ["apps/api/src/server.ts", "packages/api-contracts/src/index.ts"]) {
    assert.ok(scanned.includes(required), `扫描面必须覆盖 ${required}；实际扫了 ${scanned.length} 个文件`);
  }
  const sites = literalSites();
  assert.equal(sites.length, 1,
    `能力位的事实来源应只有一处，实际：${sites.map((site) => `${site.file}:${site.line} ${site.text}`).join(" | ")}`);
  const [only] = sites;
  assert.ok(only, "服务端源码里找不到能力位的字面量定义");
  // ⚠️ 若将来要把它抽成 `packages` 里的公共常量，**必须同时改这条判据**（改成"常量定义 + 使用点"两处）。
  // 这不是刁难：iOS 侧是按字面量对齐的，常量一旦多一处，就有两条能各自漂移的事实来源。
  assert.equal(only.file, "apps/api/src/server.ts", "能力位必须由 /v1/handshake 的响应组装处宣告");
  assert.match(only.text, /factsAnalysisContractVersion:\s*1\b/);
});

/**
 * 取 `export interface <name> { ... }` 的函数体。
 *
 * 刻意不用 ts-morph/AST：本仓对源码级判据的口径是"够用 + 有明确盲区说明"
 * （见 `packages/contracts/src/direct-sync.ts` 的 `forbiddenIdentifiers`）。
 * 盲区：重排/换行会漏判 —— 但漏判只会让判据失效，不会让它误报绿。
 */
function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name} {`);
  assert.notEqual(start, -1, `找不到 export interface ${name}`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `interface ${name} 的闭合大括号找不到`);
  // 行尾统一成 `\n`：working tree 是 CRLF（`.gitattributes` 只管仓库内的 LF），
  // 而切到 `\n}` 会把**最后一行**的 CR 留在体内 —— 于是"是不是可选"的判据恒红，
  // 且红得毫无信息量（真原因在读文件的那一步，不在声明本身）。
  return source.slice(start, end).replace(/\r\n?/g, "\n");
}

interface LiteralSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * 扫**生产源码**（不含 `test/`）里所有"能力位 + 数字"的写法：`: 1` 与 `= 1` 都算。
 *
 * 为什么不扫测试：测试里的字面量是**期望值**，天然要多处出现；
 * 判据要钉的是"实现有几份"，把期望值算进来只会让它自己先红。
 */
function literalSites(): LiteralSite[] {
  const pattern = /factsAnalysisContractVersion\s*(?::|=)\s*(\d+)/;
  const sites: LiteralSite[] = [];
  for (const file of productionTypeScriptFiles()) {
    readFileSync(file, "utf8").split(/\r?\n/).forEach((text, index) => {
      const trimmed = text.trim();
      // 注释里的示范写法不是"第二份实现"。
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
      if (pattern.test(text)) {
        sites.push({ file: relative(projectRoot, file).replace(/\\/g, "/"), line: index + 1, text: trimmed });
      }
    });
  }
  return sites;
}

function productionTypeScriptFiles(): string[] {
  const packagesRoot = join(projectRoot, "packages");
  const roots = [join(projectRoot, "apps/api/src")];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) roots.push(join(packagesRoot, entry.name, "src"));
  }
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // `encoding` 显式给：不给时 `recursive: true` 的重载会落到 `Buffer[]`，类型上就取不到字符串。
    for (const name of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (name.endsWith(".ts")) files.push(join(root, name));
    }
  }
  return files;
}

async function removeRuntimeRoot(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError;
}

// 并行全量跑时 CPU 被多个真 API 子进程分掉，窗口给足，免得慢启动被误判成失败。
async function waitForApi(child: ChildProcess, url: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output() || `API exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/v1/health`);
      if (response.ok) return;
    } catch { /* API 还在启动。 */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(output() || "API did not become ready");
}

async function waitForBoundPort(child: ChildProcess, output: () => string): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(output() || "API did not report its bound port")), 60_000);
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      reject(new Error(output() || `API exited with ${code}`));
    };
    child.once("exit", onExit);
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" && message !== null &&
        (message as { type?: unknown }).type === "rai:ready" &&
        Number.isInteger((message as { port?: unknown }).port)
      ) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolvePort((message as { port: number }).port);
      }
    });
  });
}

async function stopApi(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
  child.kill();
  // Windows 上 close 事件可能拖着不来（stdio 句柄），超时后退化成强杀，别让清理卡住整条套件。
  await Promise.race([closed, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
