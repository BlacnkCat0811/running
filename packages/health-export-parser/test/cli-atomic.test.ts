import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { RaiDatabase } from "../src/database.js";
import { retryTransientFileOperation } from "../src/file-operations.js";

test("retries transient Windows file locks during database publication", async () => {
  let attempts = 0;
  await retryTransientFileOperation(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("locked") as NodeJS.ErrnoException;
      error.code = attempts === 1 ? "EBUSY" : "EPERM";
      throw error;
    }
  }, 4, 0);
  assert.equal(attempts, 3);

  const fatal = new Error("invalid") as NodeJS.ErrnoException;
  fatal.code = "EINVAL";
  await assert.rejects(
    retryTransientFileOperation(async () => { throw fatal; }, 4, 0),
    fatal
  );
});

test("CLI replacement keeps the original database when a post-parse stage fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-atomic-"));
  const input = join(root, "export");
  const databasePath = join(root, "rai.sqlite");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), `<HealthData>
    <ActivitySummary dateComponents="2026-01-02" activeEnergyBurned="500"/>
  </HealthData>`);
  const original = await RaiDatabase.open(databasePath);
  original.setManifest("original_marker", "preserved");
  original.close();

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx",
        resolve("packages/health-export-parser/src/cli.ts"),
        "import", "--input", input, "--database", databasePath, "--replace",
        "--report", root, "--json-report", join(root, "audit.json")
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );
    assert.notEqual(result.status, 0, result.stdout);
    const preserved = await RaiDatabase.open(databasePath);
    try {
      const marker = preserved.database.prepare(`
        SELECT value FROM import_manifest WHERE key = 'original_marker'
      `).get() as unknown as { value: string };
      assert.equal(marker.value, "preserved");
      const summaries = preserved.database.prepare(`
        SELECT COUNT(*) AS count FROM activity_summaries
      `).get() as unknown as { count: number };
      assert.equal(summaries.count, 0);
    } finally {
      preserved.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI publishes database and audit reports from one generation and retains the displaced database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-publish-"));
  const input = join(root, "export");
  const databasePath = join(root, "rai.sqlite");
  const markdownPath = join(root, "audit.md");
  const jsonPath = join(root, "audit.json");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), `<HealthData>
    <ActivitySummary dateComponents="2026-01-02" activeEnergyBurned="500"/>
  </HealthData>`);
  const original = await RaiDatabase.open(databasePath);
  original.setManifest("original_marker", "preserved-in-displaced");
  original.close();

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx",
        resolve("packages/health-export-parser/src/cli.ts"),
        "import", "--input", input, "--database", databasePath, "--replace",
        "--report", markdownPath, "--json-report", jsonPath
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);

    const active = await RaiDatabase.open(databasePath);
    let datasetVersion: string;
    try {
      datasetVersion = (active.database.prepare(`
        SELECT value FROM import_manifest WHERE key = 'dataset_version'
      `).get() as unknown as { value: string }).value;
      const summaries = active.database.prepare(`
        SELECT COUNT(*) AS count FROM activity_summaries
      `).get() as unknown as { count: number };
      assert.equal(summaries.count, 1);
    } finally {
      active.close();
    }

    const jsonAudit = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      datasetVersion: string;
    };
    assert.equal(jsonAudit.datasetVersion, datasetVersion);
    assert.match(readFileSync(markdownPath, "utf8"), new RegExp(datasetVersion));

    const displacedName = readdirSync(root).find((name) =>
      name.startsWith("rai.sqlite.replaced.")
    );
    assert.ok(displacedName);
    const displaced = await RaiDatabase.open(join(root, displacedName));
    try {
      const marker = displaced.database.prepare(`
        SELECT value FROM import_manifest WHERE key = 'original_marker'
      `).get() as unknown as { value: string };
      assert.equal(marker.value, "preserved-in-displaced");
    } finally {
      displaced.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI refuses a concurrent publisher before changing the active database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-lock-"));
  const input = join(root, "export");
  const databasePath = join(root, "rai.sqlite");
  mkdirSync(input);
  mkdirSync(`${databasePath}.import.lock`);
  writeFileSync(
    join(`${databasePath}.import.lock`, "owner.json"),
    JSON.stringify({ token: "active-test", pid: process.pid, kind: "cli", startedAt: new Date().toISOString() })
  );
  writeFileSync(join(input, "export.xml"), "<HealthData/>");
  const original = await RaiDatabase.open(databasePath);
  original.setManifest("original_marker", "locked");
  original.close();

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx",
        resolve("packages/health-export-parser/src/cli.ts"),
        "import", "--input", input, "--database", databasePath, "--replace",
        "--report", join(root, "audit.md"), "--json-report", join(root, "audit.json")
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Another cli process is using/);
    const preserved = await RaiDatabase.open(databasePath);
    try {
      const marker = preserved.database.prepare(`
        SELECT value FROM import_manifest WHERE key = 'original_marker'
      `).get() as unknown as { value: string };
      assert.equal(marker.value, "locked");
    } finally {
      preserved.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * `--database-is-staging`：调用方（web 导入 worker）给的 `--database` 已经是本次导入
 * 专用的 scratch 副本，CLI 就地改它即可。修复前 CLI 会先整库复制出
 * `*.importing.<uuid>`，改完再用 `publishDatabaseFile` 原子发布回 `--database` ——
 * 一次 506 MB 的复制（线上 `stagesMs.prepare_staging_copy` 实测 1,605 ms），
 * 而对 worker 来说纯属冗余：它收尾靠的是自己把这份库装到主库位。
 *
 * 下面两条用例各自只钉一个不变量（结果落在 `--database` 本身 / 不留副本与发布遗骸），
 * 以便"把 CLI 改回旧路径"和"去掉成品保护"这两个突变能分别打红其中一条。
 */
async function seedInPlaceStagingFixture(prefix: string): Promise<{
  root: string;
  input: string;
  databasePath: string;
}> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const input = join(root, "export");
  const databasePath = join(root, "rai.importing.inplace-job.sqlite");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), `<HealthData>
    <ActivitySummary dateComponents="2026-01-02" activeEnergyBurned="500"/>
  </HealthData>`);
  const scratch = await RaiDatabase.open(databasePath);
  scratch.setManifest("scratch_marker", "seeded-by-worker");
  scratch.close();
  return { root, input, databasePath };
}

function runInPlaceStagingImport(
  input: string,
  databasePath: string,
  root: string,
  mode: "incremental" | "full" = "incremental"
) {
  return spawnSync(
    process.execPath,
    [
      "--import", "tsx",
      resolve("packages/health-export-parser/src/cli.ts"),
      mode === "incremental" ? "incremental-import" : "import",
      "--input", input, "--database", databasePath,
      // 增量分支由 worker 传 `--batch-id`；全量分支传 `--replace`（见 `import-worker.ts`
      // 里那条 `...(currentBackupPath ? ["--batch-id", job.id] : ["--replace"])`）。
      ...(mode === "incremental" ? ["--batch-id", "inplace-job"] : ["--replace"]),
      "--database-is-staging",
      "--report", join(root, "audit.md"), "--json-report", join(root, "audit.json")
    ],
    { cwd: resolve("."), encoding: "utf8" }
  );
}

test("in-place staging writes the finished database into --database itself", async () => {
  const { root, input, databasePath } = await seedInPlaceStagingFixture("rai-cli-inplace-write-");
  try {
    const result = runInPlaceStagingImport(input, databasePath, root);
    assert.equal(result.status, 0, result.stderr);

    // 成品必须落在 `--database` 本身 —— worker 随后要拿这份库去替换主库。
    // 若 CLI 把它当成自己的临时库删掉，这里会打开到一个全新的空库（count 0）。
    const active = await RaiDatabase.open(databasePath);
    try {
      const summaries = active.database.prepare(
        "SELECT COUNT(*) AS count FROM activity_summaries"
      ).get() as unknown as { count: number };
      assert.equal(summaries.count, 1);
      const marker = active.database.prepare(
        "SELECT value FROM import_manifest WHERE key = 'scratch_marker'"
      ).get() as unknown as { value: string };
      assert.equal(marker.value, "seeded-by-worker");
    } finally {
      active.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("in-place staging leaves no whole-database copy or publish residue", async () => {
  const { root, input, databasePath } = await seedInPlaceStagingFixture("rai-cli-inplace-residue-");
  try {
    const result = runInPlaceStagingImport(input, databasePath, root);
    assert.equal(result.status, 0, result.stderr);

    // 既不留下整库副本（`*.importing.<uuid>`），也不留原子发布的遗骸
    // （`*.replaced.<uuid>`）—— 走默认"复制 + 发布"路径时后者必然出现。
    const leftovers = readdirSync(root).filter((name) =>
      /\.(?:importing|replaced)\.[0-9a-fA-F-]{36}$/.test(name)
    );
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 守卫用例：`--database-is-staging` 是承诺"这个路径上已有 scratch 副本"。承诺不成立时
 * CLI **必须报错**，绝不能"就地新建" —— 就地模式下没有原子发布，用一份空库写进去
 * 等于静默顶掉调用方指定的目标库。
 *
 * 这条正是缺陷现场的形态：标志最初被无条件传递，全量导入（`--replace`）分支的
 * `--database` 是调用方**期望 CLI 新建**的路径，于是那段导入直接失败。
 * 与另两条用例的分工：那两条钉"就地改动对不对"，这条钉"承诺不成立时会不会静默降级"。
 */
test("in-place staging refuses a --database that does not exist yet", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-inplace-missing-"));
  try {
    const input = join(root, "export");
    mkdirSync(input);
    writeFileSync(join(input, "export.xml"), `<HealthData>
    <ActivitySummary dateComponents="2026-01-02" activeEnergyBurned="500"/>
  </HealthData>`);
    // 刻意**不**创建这个库：调用方声明了 staging，但路径上没有东西。
    // 用**全量**形态（`import --replace`）—— 增量分支另有一条既有守卫
    // （`Incremental import requires a cloned active database`）会先命中，
    // 因此只有全量分支才真正考到本守卫。
    const missing = join(root, "not-created-yet.sqlite");
    const result = runInPlaceStagingImport(input, missing, root, "full");
    assert.notEqual(result.status, 0, "承诺不成立时必须以非 0 退出");
    assert.match(result.stderr, /--database-is-staging was declared but no staging database exists/);
    // 更不能"顺手"建一个出来。
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
