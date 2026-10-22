import { spawn as spawnChild } from "node:child_process";

/**
 * systemd readiness/watchdog 发送端（2026-10-18 事故复盘 P1）。
 *
 * ## 为什么需要
 *
 * 服务是 `Type=simple` + `Restart=on-failure`：事件循环被同步 SQLite 读整段占住时，
 * 进程还"活着"（systemd 看不到退出），但所有请求都不再推进。2026-10-18 的 13.4 s
 * 同步读就是这样把全站挂住的，而 systemd 永远不会重启一个"活着但不响应"的进程。
 *
 * 现在 unit 用 `Type=notify` + `WatchdogSec=120`：API 在 listen 成功后发 `READY=1`，
 * 之后每 40 s 发 `WATCHDOG=1`。心跳是**普通定时器**，事件循环被阻塞时它发不出去；
 * 超过 WatchdogSec 没有任何心跳，systemd 就会判定 hang、杀掉并按 `Restart=on-failure`
 * 重启。误杀边界（任何 >120 s 的同步阻塞都会被判 hang）写在
 * [Ubuntu 部署](../../../deploy/README-UBUNTU.md) 与 [运维](../../../docs/OPERATIONS.md)。
 *
 * ## 为什么走 `/usr/bin/systemd-notify` 子进程
 *
 * Node 的 `dgram` 只有 udp4/udp6，没有 AF_UNIX 数据报；systemd 的 `$NOTIFY_SOCKET`
 * 正是一个 unix datagram socket。要么引第三方原生依赖，要么用 systemd 自带的
 * `systemd-notify(1)`。这里选后者：它是 systemd 包的一部分（Ubuntu 默认安装），
 * 消息内容与 `sd_notify(3)` 等价，且失败时只影响心跳、不会让 API 启动失败。
 *
 * 子进程必须以 `NotifyAccess=all` 才被接受（默认 `main` 只认主进程）；unit 模板里
 * 已显式设置。心跳发送是 fire-and-forget：spawn 失败只告警一次，不抛异常、不阻塞
 * 事件循环，也不会把一次通知失败放大成 API 故障。
 */
export const SYSTEMD_NOTIFY_BINARY = "/usr/bin/systemd-notify";

/** WatchdogSec=120 的三分之一：容一次偶发延迟，又不至于让 hang 检测太迟钝。 */
export const SYSTEMD_WATCHDOG_INTERVAL_MS = 40_000;

export type SystemdNotifySpawn = (args: readonly string[], env: NodeJS.ProcessEnv) => void;

/** Fastify/Pino logger 的最小形状；测试可传一个只记录告警的对象。 */
export interface SystemdNotifyLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface SystemdNotifierOptions {
  /** Defaults to `process.env`; injectable for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to spawning `/usr/bin/systemd-notify`; injectable for tests. */
  readonly spawnNotify?: SystemdNotifySpawn;
  readonly log?: SystemdNotifyLogger;
  /** Watchdog heartbeat period; tests use a small value. */
  readonly intervalMs?: number;
  readonly binary?: string;
}

export interface SystemdNotifier {
  /** `READY=1`：只在 listen 成功后调用一次。 */
  ready(): void;
  /** 启动 WATCHDOG=1 心跳；重复调用无副作用。 */
  startWatchdog(): void;
  /** `STOPPING=1`：进入关闭流程时调用一次。 */
  stopping(): void;
  /** 仅停止定时器（不再发送），用于关闭收尾。 */
  stop(): void;
}

const noopNotifier: SystemdNotifier = {
  ready: () => {},
  startWatchdog: () => {},
  stopping: () => {},
  stop: () => {}
};

/** Child-process spawn that swallows async errors into a one-shot warning. */
function defaultSpawn(binary: string, warn: (message: string, error: unknown) => void): SystemdNotifySpawn {
  return (args, env) => {
    const child = spawnChild(binary, [...args], { env, stdio: "ignore", windowsHide: true });
    child.on("error", (error) => warn("systemd-notify spawn failed", error));
    // Do not keep the API process alive waiting for the helper.
    child.unref();
  };
}

/**
 * Builds the notifier for this process.
 *
 * Without `$NOTIFY_SOCKET` (local dev, tests, a plain `node` run) every method is a
 * no-op: nothing is spawned and the timer never exists.
 */
export function createSystemdNotifier(options: SystemdNotifierOptions = {}): SystemdNotifier {
  const env = options.env ?? process.env;
  const notifySocket = env.NOTIFY_SOCKET?.trim();
  if (!notifySocket) return noopNotifier;

  const log = options.log;
  const intervalMs = options.intervalMs ?? SYSTEMD_WATCHDOG_INTERVAL_MS;
  let warnedFailure = false;
  const warnOnce = (message: string, error: unknown): void => {
    if (warnedFailure) return;
    warnedFailure = true;
    log?.warn({ err: error instanceof Error ? error.message : String(error) }, message);
  };
  const spawnNotify = options.spawnNotify ??
    defaultSpawn(options.binary ?? SYSTEMD_NOTIFY_BINARY, warnOnce);

  let readySent = false;
  let stoppingSent = false;
  let timer: NodeJS.Timeout | null = null;

  const send = (message: string): void => {
    try {
      spawnNotify([message], env);
    } catch (error) {
      // 注入的 spawn 在测试里可以同步抛错；生产实现已把异步错误转成告警。
      warnOnce("systemd-notify failed", error);
    }
  };

  return {
    ready() {
      if (readySent) return;
      readySent = true;
      send("READY=1");
    },
    startWatchdog() {
      if (timer !== null) return;
      timer = setInterval(() => send("WATCHDOG=1"), intervalMs);
      // 心跳不能单独让进程活着：API 关闭时不需要等一个 tick。
      timer.unref?.();
    },
    stopping() {
      if (stoppingSent) return;
      stoppingSent = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      send("STOPPING=1");
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}
