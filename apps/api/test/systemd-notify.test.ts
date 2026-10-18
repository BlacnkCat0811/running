import assert from "node:assert/strict";
import test from "node:test";

import {
  SYSTEMD_NOTIFY_BINARY,
  SYSTEMD_WATCHDOG_INTERVAL_MS,
  createSystemdNotifier
} from "../src/systemd-notify.js";

const socketEnv = { NOTIFY_SOCKET: "/run/systemd/notify" } as NodeJS.ProcessEnv;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("no NOTIFY_SOCKET: every method is a no-op and nothing is spawned", () => {
  const calls: string[] = [];
  for (const env of [{}, { NOTIFY_SOCKET: "" }, { NOTIFY_SOCKET: "   " }] as NodeJS.ProcessEnv[]) {
    const notifier = createSystemdNotifier({
      env,
      intervalMs: 5,
      spawnNotify: (args) => { calls.push(args.join(" ")); }
    });
    notifier.ready();
    notifier.startWatchdog();
    notifier.stopping();
    notifier.stop();
  }
  assert.deepEqual(calls, [], "本地/测试环境不得 spawn systemd-notify");
});

test("sends READY once, heartbeats repeatedly, then STOPPING once", async () => {
  const messages: string[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const notifier = createSystemdNotifier({
    env: socketEnv,
    intervalMs: 10,
    spawnNotify: (args, env) => { messages.push(args.join(" ")); envs.push(env); }
  });
  assert.equal(SYSTEMD_WATCHDOG_INTERVAL_MS, 40_000, "unit 的 WatchdogSec=120 除以 3");
  assert.equal(SYSTEMD_NOTIFY_BINARY, "/usr/bin/systemd-notify");

  notifier.ready();
  notifier.ready();
  notifier.startWatchdog();
  notifier.startWatchdog();
  await sleep(45);
  notifier.stopping();
  notifier.stopping();

  assert.equal(messages.filter((message) => message === "READY=1").length, 1);
  const heartbeats = messages.filter((message) => message === "WATCHDOG=1").length;
  assert.ok(heartbeats >= 2, `心跳至少两次，实际 ${heartbeats}`);
  assert.equal(messages.filter((message) => message === "STOPPING=1").length, 1);
  assert.equal(messages.at(-1), "STOPPING=1", "STOPPING 之后不得再发心跳");
  assert.equal(envs[0]?.NOTIFY_SOCKET, "/run/systemd/notify", "子进程必须继承 NOTIFY_SOCKET");

  // STOPPING 会清掉定时器：再等一段不应有新消息。
  const before = messages.length;
  await sleep(30);
  assert.equal(messages.length, before);
});

test("a failing notifier helper never throws and only warns once", () => {
  const warnings: string[] = [];
  const notifier = createSystemdNotifier({
    env: socketEnv,
    intervalMs: 5,
    spawnNotify: () => { throw new Error("spawn ENOENT"); },
    log: { warn: (_fields, message) => { warnings.push(message); } }
  });
  assert.doesNotThrow(() => notifier.ready());
  assert.doesNotThrow(() => notifier.startWatchdog());
  assert.doesNotThrow(() => notifier.stopping());
  notifier.stop();
  assert.equal(warnings.length, 1, "通知失败只告警一次，不刷屏");
  assert.equal(warnings[0], "systemd-notify failed");
});

test("heartbeat can be stopped without sending STOPPING", async () => {
  const messages: string[] = [];
  const notifier = createSystemdNotifier({
    env: socketEnv,
    intervalMs: 5,
    spawnNotify: (args) => { messages.push(args.join(" ")); }
  });
  notifier.ready();
  notifier.startWatchdog();
  await sleep(20);
  notifier.stop();
  const before = messages.length;
  await sleep(20);
  assert.equal(messages.length, before, "stop() 之后不再发心跳");
  assert.equal(messages.includes("STOPPING=1"), false);
});
