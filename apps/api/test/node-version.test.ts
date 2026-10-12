import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { assertSupportedNodeVersion, isSupportedNodeVersion } from "../../../scripts/check-node-version.mjs";

test("Node version gate accepts the supported Node 22 and Node 24 ranges", () => {
  assert.equal(isSupportedNodeVersion("22.12.0"), true);
  assert.equal(isSupportedNodeVersion("22.23.1"), true);
  // 24.x 于 2026-10-12 实测放行：这里钉住"它被接受"，回退本行就会红。
  assert.equal(isSupportedNodeVersion("24.0.0"), true);
  assert.equal(isSupportedNodeVersion("24.21.0"), true);
});

test("Node version gate rejects unsupported releases", () => {
  assert.equal(isSupportedNodeVersion("22.11.0"), false);
  assert.equal(isSupportedNodeVersion("23.0.0"), false);
  // 25 未被实测，也不是 LTS：放行 24 不等于放行"更大的号"。
  assert.equal(isSupportedNodeVersion("25.0.0"), false);
  assert.equal(isSupportedNodeVersion("22.12.0-rc.1"), false);
  assert.equal(isSupportedNodeVersion("22.23.1-nightly.20260717"), false);
  assert.equal(isSupportedNodeVersion("24.21.0-rc.1"), false);
  assert.equal(isSupportedNodeVersion("22.23.1+build.7"), true);
  assert.equal(isSupportedNodeVersion("v22.23.1"), false);
  assert.equal(isSupportedNodeVersion("v24.21.0"), false);
  assert.throws(
    () => assertSupportedNodeVersion("25.1.0"),
    /requires Node\.js >=22\.12\.0 <23 or >=24\.0\.0 <25/
  );
});

test("every public runtime command executes the Node gate through npm lifecycle hooks", () => {
  const projectRoot = resolve(import.meta.dirname, "../../..");
  const rootPackage = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const publicScripts = [
    "dev:api", "dev:web",
    ...Object.keys(rootPackage.scripts).filter((name) => name.startsWith("data:") || name.startsWith("ml:"))
  ];
  for (const script of publicScripts) {
    const hook = `pre${script}`;
    assert.equal(rootPackage.scripts[hook], "npm run check:node", `${script} must have a Node gate`);
  }

  for (const workspace of ["apps/api", "apps/web"]) {
    const manifest = JSON.parse(readFileSync(resolve(projectRoot, workspace, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const entry of Object.keys(manifest.scripts).filter((name) => name === "dev" || name === "start")) {
      assert.equal(
        manifest.scripts[`pre${entry}`],
        "node ../../scripts/check-node-version.mjs",
        `${workspace} ${entry} must have a Node gate`
      );
    }
  }

  const lifecycleChecks = [
    ["run", "--silent", "predev:api"],
    ["run", "--silent", "predev", "-w", "@rai/api"],
    ["run", "--silent", "predev", "-w", "@rai/web"]
  ];
  for (const args of lifecycleChecks) {
    const result = spawnSync("npm", args, {
      cwd: projectRoot,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    assert.equal(result.status, 0, `npm ${args.join(" ")} failed: ${result.stderr}`);
  }
});
