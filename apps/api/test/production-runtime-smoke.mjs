import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-smoke-"));
const databasePath = join(runtimeRoot, "var", "rai.sqlite");
const apiPackage = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
if (!apiPackage.dependencies?.tsx) throw new Error("tsx must be an @rai/api production dependency");
if (existsSync(databasePath)) throw new Error("Smoke test database path must start empty");
const port = 18787 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
  cwd: fileURLToPath(new URL("../../..", import.meta.url)),
  env: {
    ...process.env,
    RAI_RUNTIME_ROOT: runtimeRoot,
    RAI_DATABASE: databasePath,
    RAI_API_PORT: String(port),
    RAI_LOG_LEVEL: "silent"
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
  let response;
  const startupDeadline = Date.now() + 20_000;
  while (Date.now() < startupDeadline) {
    if (child.exitCode !== null) throw new Error(output || `API exited with ${child.exitCode}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { host: `127.0.0.1:${port}` } });
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!response?.ok) {
    throw new Error(output || `API health endpoint did not become ready; child exitCode=${child.exitCode}`);
  }
  const health = await response.json();
  if (health.status !== "ok" || health.localOnly !== true || health.databaseReady !== false) {
    throw new Error("API health response is invalid or the smoke database is not isolated");
  }
  if (existsSync(databasePath)) throw new Error("API unexpectedly created the isolated smoke database");
  console.log("Production API runtime smoke test passed");
} finally {
  let shutdownError;
  try {
    if (child.pid && process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
      child.kill("SIGTERM");
      let shutdownTimer;
      const timeout = new Promise((_, reject) => {
        shutdownTimer = setTimeout(() => reject(new Error("API did not shut down after SIGTERM")), 5_000);
        shutdownTimer.unref();
      });
      const result = await Promise.race([exited, timeout]).finally(() => clearTimeout(shutdownTimer));
      if (result.code !== 0) throw new Error(output || `API shutdown exited with ${result.code ?? result.signal}`);
    }
  } catch (error) {
    shutdownError = error;
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
  if (shutdownError) throw shutdownError;
}
