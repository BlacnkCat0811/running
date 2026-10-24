// 阶段 6 W1 安全门禁负例：拒绝必须发生在打开数据库 / 发送请求之前。
//
// 这些用例只操作临时目录，不启动 API、不接触仓库 var/ 或任何生产 runtime。
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  REPO_ROOT,
  SafetyError,
  assertDistinctDatabaseFiles,
  assertInsideRoot,
  assertLoopbackBaseUrl,
  assertOwnedCleanupTarget,
  assertSafeExperimentRoot,
  buildServerEnvironment,
  createOwnedExperimentRoot,
  scanForSecrets
} from "../../../scripts/phase6/safety.mjs";

const tempRoot = (prefix) => mkdtempSync(join(tmpdir(), prefix));

const rejects = (code, run) => {
  assert.throws(run, (error) => error instanceof SafetyError && error.code === code);
};

test("rejects the repository, its ancestors, its var/ and shallow roots", () => {
  rejects("root_is_repo", () => assertSafeExperimentRoot(REPO_ROOT));
  rejects("root_inside_repo", () => assertSafeExperimentRoot(join(REPO_ROOT, "var", "phase6")));
  rejects("root_contains_repo", () => assertSafeExperimentRoot(dirname(REPO_ROOT)));
  rejects("root_too_shallow", () => assertSafeExperimentRoot("/tmp"));
  rejects("root_not_absolute", () => assertSafeExperimentRoot("rai-phase6-lab/run-001"));
  rejects("root_required", () => assertSafeExperimentRoot(""));
});

test("rejects symlinked experiment roots and symlinked inner files", () => {
  const parent = tempRoot("phase6-safety-");
  const real = join(parent, "real");
  const link = join(parent, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  try {
    rejects("root_symlink", () => assertSafeExperimentRoot(link));
    const realDir = realpathSync(real);
    const inner = join(real, "rai.sqlite");
    writeFileSync(inner, "");
    const alias = join(real, "alias.sqlite");
    symlinkSync(inner, alias);
    rejects("path_escape", () => assertInsideRoot(realDir, join(parent, "..", "outside"), { label: "out", allowMissing: true }));
    rejects("path_symlink", () => assertInsideRoot(realDir, alias, { label: "database", regularFile: true }));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("rejects existing unowned roots but accepts an empty root and an owned re-open", () => {
  const parent = tempRoot("phase6-safety-");
  const unowned = join(parent, "unowned");
  const empty = join(parent, "empty");
  mkdirSync(unowned);
  mkdirSync(empty);
  writeFileSync(join(unowned, "user.txt"), "keep me");
  try {
    rejects("root_unowned", () => assertSafeExperimentRoot(unowned));
    assert.equal(assertSafeExperimentRoot(empty).root, empty);
    const owned = createOwnedExperimentRoot(join(parent, "run-001"), { runId: "run-001" });
    assert.equal(owned.root, join(parent, "run-001"));
    // F1：默认拒绝任何已有根，包括同 run-id 的失败重试；不存在幂等复用。
    rejects("root_exists", () => createOwnedExperimentRoot(owned.root, { runId: "run-001" }));
    rejects("root_exists", () => createOwnedExperimentRoot(owned.root, { runId: "run-002" }));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("cleanup requires the phase6 ownership marker and matching run id", () => {
  const parent = tempRoot("phase6-safety-");
  const root = join(parent, "run-001");
  try {
    rejects("cleanup_unowned", () => assertOwnedCleanupTarget(root, { runId: "run-001" }));
    createOwnedExperimentRoot(root, { runId: "run-001" });
    writeFileSync(join(root, "notes.txt"), "x");
    rejects("cleanup_run_mismatch", () => assertOwnedCleanupTarget(root, { runId: "run-002" }));
    assert.equal(assertOwnedCleanupTarget(root, { runId: "run-001" }).marker.runId, "run-001");
    writeFileSync(join(root, ".phase6-run.json"), JSON.stringify({ owner: "someone-else", runId: "run-001" }));
    rejects("cleanup_foreign_owner", () => assertOwnedCleanupTarget(root, { runId: "run-001" }));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("main and control databases must be distinct regular files, not hard links", () => {
  const root = tempRoot("phase6-safety-");
  const realRoot = realpathSync(root);
  const main = join(root, "main.sqlite");
  const control = join(root, "control.sqlite");
  const linked = join(root, "linked.sqlite");
  writeFileSync(main, "main");
  writeFileSync(control, "control");
  try {
    rejects("database_same_path", () => assertDistinctDatabaseFiles(realRoot, main, main));
    assert.deepEqual(assertDistinctDatabaseFiles(realRoot, main, control), {
      main: join(realRoot, "main.sqlite"), control: join(realRoot, "control.sqlite")
    });
    try {
      linkSync(main, linked);
      rejects("database_hardlink", () => assertDistinctDatabaseFiles(realRoot, main, linked));
    } catch (error) {
      // 某些文件系统/权限不允许建硬链接：明确跳过这一条，而不是静默当作通过。
      if (error?.code !== "EPERM" && error?.code !== "EXDEV" && error?.code !== "EACCES") throw error;
      assert.ok(true, "hard-link check skipped: filesystem refused linkSync");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("child environment is a whitelist and never inherits production RAI_* or proxies", () => {
  const saved = {
    RAI_DATABASE: process.env.RAI_DATABASE,
    RAI_TRAINING_PLAN_COMMAND_MODE: process.env.RAI_TRAINING_PLAN_COMMAND_MODE,
    HTTP_PROXY: process.env.HTTP_PROXY,
    NODE_OPTIONS: process.env.NODE_OPTIONS
  };
  process.env.RAI_DATABASE = "/production/rai.sqlite";
  process.env.RAI_TRAINING_PLAN_COMMAND_MODE = "validation";
  process.env.HTTP_PROXY = "http://proxy.invalid:3128";
  process.env.NODE_OPTIONS = "--max-old-space-size=4096";
  try {
    const { env, injectedKeys } = buildServerEnvironment({
      runtimeRoot: "/Users/ta/rai-phase6-lab/run-001",
      database: "/Users/ta/rai-phase6-lab/run-001/var/rai.sqlite",
      controlDatabase: "/Users/ta/rai-phase6-lab/run-001/var/rai-control.sqlite",
      port: 18999,
      token: "phase6-test-token-0123456789"
    });
    for (const key of ["HTTP_PROXY", "NODE_OPTIONS", "RAI_TRAINING_PLAN_COMMAND_MODE"]) {
      assert.equal(env[key], undefined, `${key} must not be inherited`);
    }
    assert.equal(env.RAI_CONTROL_DATABASE, "/Users/ta/rai-phase6-lab/run-001/var/rai-control.sqlite");
    assert.equal(env.RAI_DATABASE, "/Users/ta/rai-phase6-lab/run-001/var/rai.sqlite");
    assert.notEqual(env.RAI_DATABASE, "/production/rai.sqlite");
    assert.equal(env.RAI_RUNTIME_ROOT, "/Users/ta/rai-phase6-lab/run-001");
    assert.equal(env.RAI_DATABASE, "/Users/ta/rai-phase6-lab/run-001/var/rai.sqlite");
    assert.ok(injectedKeys.includes("RAI_API_TOKEN"));
    assert.equal(env.RAI_API_HOST, "127.0.0.1");
    assert.equal(env.TMPDIR, "/Users/ta/rai-phase6-lab/run-001/tmp");
    assert.equal(env.TMP, "/Users/ta/rai-phase6-lab/run-001/tmp");
    assert.equal(env.TEMP, "/Users/ta/rai-phase6-lab/run-001/tmp");
    assert.equal(env.HOME, "/Users/ta/rai-phase6-lab/run-001/home");
    rejects("token_weak", () => buildServerEnvironment({
      runtimeRoot: env.RAI_RUNTIME_ROOT, database: env.RAI_DATABASE,
      controlDatabase: env.RAI_CONTROL_DATABASE, port: 1, token: "short"
    }));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("API target must be an explicit loopback origin", () => {
  assert.equal(assertLoopbackBaseUrl("http://127.0.0.1:18999"), "http://127.0.0.1:18999");
  rejects("url_scheme", () => assertLoopbackBaseUrl("https://rai.example.com:443"));
  rejects("url_scheme", () => assertLoopbackBaseUrl("https://127.0.0.1:18999"));
  rejects("url_credentials", () => assertLoopbackBaseUrl("http://user:pass@127.0.0.1:18999"));
  rejects("url_path", () => assertLoopbackBaseUrl("http://127.0.0.1:18999/v1"));
  rejects("url_query", () => assertLoopbackBaseUrl("http://127.0.0.1:18999/?x=1"));
  rejects("url_port", () => assertLoopbackBaseUrl("http://127.0.0.1"));
});

test("secret scan finds tokens and headers without echoing them", () => {
  const findings = scanForSecrets("Authorization: Bearer abcdefghijklmnop\nphase6-token-0123456789", {
    token: "phase6-token-0123456789",
    paths: ["/Users/ta/rai-phase6-lab/run-001"]
  });
  assert.ok(findings.some((item) => item.kind === "api_token"));
  assert.ok(findings.some((item) => item.kind === "authorization_header"));
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("abcdefghijklmnop")));
  assert.deepEqual(scanForSecrets("clean output", { token: "phase6-token-0123456789" }), []);
});

test("resolved root cannot silently move under a symlinked parent", () => {
  const parent = tempRoot("phase6-safety-");
  const target = join(parent, "target");
  const alias = join(parent, "alias");
  mkdirSync(target);
  symlinkSync(target, alias);
  try {
    rejects("root_parent_symlink", () => assertSafeExperimentRoot(join(alias, "run-001")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
