import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) => readFileSync(`deploy/${file}`, "utf8").replace(/\r\n/g, "\n");

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

// 2026-10-18（生产 -1001 复盘 lane C）：Restart=on-failure 只在进程退出时生效，
// 事件循环被同步查询占住时进程「活着但不响应」，此前永远不会自动恢复。
// 文本契约钉住 unit 侧的 hang 守护三件套；发送端（READY/WATCHDOG/STOPPING）在
// apps/api/src 实现，本地无 NOTIFY_SOCKET 时 no-op。
test("cloud service reports readiness and heartbeats so a hung event loop is restarted", () => {
  const unit = read("rai-api.service");
  const lines = unit.split("\n");
  for (const setting of ["Type=notify", "NotifyAccess=all", "WatchdogSec=120"]) {
    assert.ok(lines.includes(setting), setting);
  }
  // 服务器上的紧急回滚见 docs/OPERATIONS.md「hang 守护」；仓库模板必须保持完整守护，
  // 不允许只把 Type 改回 simple 却留下 WatchdogSec（没有心跳源会周期性被杀）。
  assert.match(unit, /^WatchdogSec=120$/m);
  assert.doesNotMatch(unit, /^Type=simple$/m);
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

test("cloud deployment documents generic cold backups in the single maintained guide", () => {
  assert.match(read("README-UBUNTU.md"), /deploy\/backup-runtime\.sh/);
  assert.match(read("README-UBUNTU.md"), /MemoryHigh=1100M/);
  assert.doesNotMatch(read("README-UBUNTU.md"), /README-CLOUD-2C2G\.md/);
  assert.match(read("backup-runtime.sh"), /apply=false/);
  assert.match(read("n100/backup-runtime.sh"), /exec bash .*backup-runtime\.sh/);
});


test("static hosting is retired: nginx only proxies the API", () => {
  const nginx = read("nginx-rai.conf").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(nginx, /root\s+\/opt\/rai\/apps\/web\/dist/);
  assert.doesNotMatch(nginx, /try_files/);
  assert.doesNotMatch(nginx, /location ~ \^\/assets\//);
  assert.doesNotMatch(nginx, /index index\.html/);
  assert.match(nginx, /location \/v1\/ \{/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8787/);
  assert.match(nginx, /location \/ \{ return 404; \}/);
});

// 2026-10-18（生产 -1001 复盘 lane C）：3600 s 读超时 + 默认 combined 日志把「后端无响应」
// 藏成客户端自己的 15 s 超时（-1001）：nginx 既不产生 504，access.log 里也没有耗时字段，
// 复盘只能数到 499 的条数。这里钉住可观测性字段与收紧后的超时预算。
test("cloud nginx makes slow requests visible and bounds upstream waits", () => {
  const nginx = read("nginx-rai.conf").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  // log_format 必须定义在 http 上下文（本文件被 sites-enabled 包含），即第一个 server 之前。
  const formatAt = nginx.indexOf("log_format rai");
  assert.ok(formatAt >= 0, "缺少 log_format rai");
  assert.ok(formatAt < nginx.indexOf("server {"), "log_format 必须在 http 上下文（第一个 server 之前）定义");
  const format = nginx.slice(formatAt, nginx.indexOf(";", formatAt));
  for (const field of ["$request", "$status", "$request_time", "$upstream_response_time", "$upstream_addr"]) {
    assert.ok(format.includes(field), `log_format rai 缺少 ${field}`);
  }
  // 443 站点自己写 rai-access.log：线上排障看这个文件，默认 access.log 不再有 443 请求。
  const accessAt = nginx.indexOf("access_log /var/log/nginx/rai-access.log rai;");
  assert.ok(accessAt >= 0, "443 server 块缺少 rai-access.log");
  assert.ok(accessAt > nginx.indexOf("listen 443 ssl http2;"), "access_log 必须落在 443 server 块内");

  // 默认读/写超时收紧到 120s、connect 5s：不允许退回「nginx 替 hang 一直兜底」的 3600s。
  assert.match(nginx, /^\s*proxy_connect_timeout 5s;$/m);
  assert.match(nginx, /^\s*proxy_read_timeout 120s;$/m);
  assert.match(nginx, /^\s*proxy_send_timeout 120s;$/m);
  assert.doesNotMatch(nginx, /proxy_(?:read|send)_timeout 3600s/);

  // 已知长读例外只有 uploads（ZIP 上传/导入）与 /v1/backups（下载/恢复）：两者都必须
  // 仍是 600s，而不是跟随默认的 120s。备份恢复被 504 截断会让执行方误判失败。
  const uploadsAt = nginx.indexOf("location = /v1/imports/uploads {");
  assert.ok(uploadsAt >= 0);
  const uploads = nginx.slice(uploadsAt, nginx.indexOf("\n    }", uploadsAt));
  assert.match(uploads, /proxy_read_timeout 600s;/);
  assert.match(uploads, /proxy_send_timeout 600s;/);
  const backupsAt = nginx.indexOf("location ^~ /v1/backups {");
  assert.ok(backupsAt >= 0, "缺少 /v1/backups 长读例外");
  const backups = nginx.slice(backupsAt, nginx.indexOf("\n    }", backupsAt));
  assert.match(backups, /proxy_read_timeout 600s;/);
  assert.match(backups, /proxy_send_timeout 600s;/);
});
