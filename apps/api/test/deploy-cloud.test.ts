import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) => readFileSync(`deploy/${file}`, "utf8");

test("default cloud service budgets the entire worker group for a 2GiB host", () => {
  const unit = read("rai-api.service");
  for (const setting of [
    "ExecStart=/usr/bin/node --import tsx apps/api/src/server.ts",
    "RestartPreventExitStatus=78", "KillMode=mixed", "OOMPolicy=stop",
    "MemoryHigh=1100M", "MemoryMax=1400M", "MemorySwapMax=512M",
    "CPUQuota=150%", "TasksMax=128", "UMask=0077"
  ]) assert.ok(unit.includes(setting), setting);
  assert.doesNotMatch(unit, /ExecStart=.*npm|MemoryMax=4G/);
});

test("cloud configuration preserves authentication, engine selection and bounded heaps", () => {
  const env = read("rai.env.example");
  for (const setting of [
    "RAI_API_HOST=127.0.0.1", "RAI_PUBLIC_HOSTS=",
    "RAI_IMPORT_ENGINE=typescript", "NODE_OPTIONS=--max-old-space-size=512",
    "RAI_ALLOW_REMOTE_TOKEN_AUTH=1", "OMP_NUM_THREADS=1", "OPENBLAS_NUM_THREADS=1",
    "MKL_NUM_THREADS=1", "NUMEXPR_NUM_THREADS=1"
  ]) assert.ok(env.split("\n").includes(setting), setting);
  const nginx = read("nginx-rai.conf");
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8787/);
  assert.doesNotMatch(nginx, /18787/);
});

test("cloud deployment uses generic cold backups and retains the old entry point", () => {
  assert.match(read("README-UBUNTU.md"), /README-CLOUD-2C2G\.md/);
  assert.match(read("README-CLOUD-2C2G.md"), /deploy\/backup-runtime\.sh/);
  assert.match(read("backup-runtime.sh"), /apply=false/);
  assert.match(read("n100/backup-runtime.sh"), /exec bash .*backup-runtime\.sh/);
});


test("direct static hosting never falls back to arbitrary dist files", () => {
  const nginx = read("nginx-rai.conf").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(nginx, /try_files \$uri \$uri\//);
  assert.match(nginx, /location = \/index\.html \{ disable_symlinks on; try_files \/index\.html =404;/);
  assert.match(nginx, /location \/ \{ return 404; \}/);
  assert.match(nginx, /disable_symlinks on;\s+try_files \$uri =404;/);
});
