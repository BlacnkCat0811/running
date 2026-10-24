// CLOUD API waits here until runner moves this PID into the target cgroup.
// The sampler stays in the runner's observer cgroup.
process.once("message", async (message) => {
  if (message !== "phase6:start") return;
  try {
    await import("../../apps/api/src/server.ts");
  } catch (error) {
    process.stderr.write(`phase6-server-entry: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
});
