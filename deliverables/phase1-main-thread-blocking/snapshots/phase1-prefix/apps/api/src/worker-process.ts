import { spawn, type ChildProcess } from "node:child_process";

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onExit);
      resolvePromise(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    child.once("error", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

export function waitForShutdown<T>(promise: Promise<T> | null, timeoutMs: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for worker shutdown")), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      const taskkillExited = await waitForProcessExit(killer, 1_500);
      if (taskkillExited && killer.exitCode === 0 && await waitForProcessExit(child, 1_500)) return;
    }
    throw new Error("Failed to terminate Windows worker process tree");
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    if (!await waitForProcessExit(child, 1_500)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  if (!await waitForProcessExit(child, 1_500)) throw new Error("Timed out terminating worker process tree");
}

