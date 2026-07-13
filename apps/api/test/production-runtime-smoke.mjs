import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-smoke-"));
const apiPackage = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
if (!apiPackage.dependencies?.tsx) throw new Error("tsx must be an @rai/api production dependency");
const port = 18787 + Math.floor(Math.random() * 1000);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this smoke test through npm");
const child = spawn(process.execPath, [npmCli, "run", "start", "-w", "@rai/api"], {
  cwd: fileURLToPath(new URL("../../..", import.meta.url)),
  env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_API_PORT: String(port), RAI_LOG_LEVEL: "silent" },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
  let response;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(output || `API exited with ${child.exitCode}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { host: `127.0.0.1:${port}` } });
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!response?.ok) throw new Error(output || "API health endpoint did not become ready");
  const health = await response.json();
  if (health.status !== "ok" || health.localOnly !== true) throw new Error("API health response is invalid");
  console.log("Production API runtime smoke test passed");
} finally {
  if (child.pid && process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill();
  }
  rmSync(runtimeRoot, { recursive: true, force: true });
}
