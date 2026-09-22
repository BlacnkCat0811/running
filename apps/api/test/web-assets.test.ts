import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { registerWebAssets } from "../src/web-assets.js";

test("only build assets and known SPA paths are publicly served", async () => {
  const root = await mkdtemp(join(tmpdir(), "rai-static-"));
  const app = Fastify();
  try {
    await mkdir(join(root, "assets"));
    for (const [path, value] of [["index.html", "<main>RAI</main>"], ["assets/app.js", "export {}"], ["assets/app.js.map", "private map"], ["assets/.env", "secret"], ["rai.sqlite", "secret db"]]) {
      await writeFile(join(root, path!), value!);
    }
    if (process.platform !== "win32") await symlink(join(root, "rai.sqlite"), join(root, "assets/linked.js"));
    await registerWebAssets(app, root);
    for (const path of ["/", "/index.html", "/workouts", "/workouts/session-1", "/data/audit", "/assets/app.js"]) {
      assert.equal((await app.inject(path)).statusCode, 200, path);
    }
    assert.equal((await app.inject("/favicon.ico")).statusCode, 204);
    for (const path of ["/rai.sqlite", "/assets/.env", "/assets/app.js.map", "/assets/linked.js", "/assets/../rai.sqlite", "/assets/%2e%2e/rai.sqlite", "/%2e%2e/package.json", "/assets/%252e%252e%252frai.sqlite", "/var/rai.sqlite", "/src/server.ts", "/assets/nope.js"]) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 404, path);
      assert.ok(!response.body.includes("secret"), path);
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
