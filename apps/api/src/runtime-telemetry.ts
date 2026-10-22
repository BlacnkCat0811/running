import { monitorEventLoopDelay } from "node:perf_hooks";

/** Lightweight process metrics: no URLs, request bodies, tokens, or health samples. */
export class RuntimeTelemetry {
  private readonly started = performance.now();
  private readonly loop = monitorEventLoopDelay({ resolution: 5 });
  private requests = 0;
  private errors = 0;
  private requestMs = 0;
  private requestMaxMs = 0;
  constructor() { this.loop.enable(); }
  record(durationMs: number, statusCode: number): void {
    this.requests++;
    if (statusCode >= 500) this.errors++;
    this.requestMs += durationMs;
    this.requestMaxMs = Math.max(this.requestMaxMs, durationMs);
  }
  /** Benchmark/acceptance hook: start a fresh event-loop-delay window. */
  resetEventLoopDelay(): void { this.loop.reset(); }
  snapshot() {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      uptimeMs: performance.now() - this.started,
      requests: this.requests, serverErrors: this.errors,
      meanRequestMs: this.requests ? this.requestMs / this.requests : 0,
      maxRequestMs: this.requestMaxMs,
      eventLoopP95Ms: this.loop.count ? this.loop.percentile(95) / 1e6 : 0,
      eventLoopMaxMs: this.loop.count ? this.loop.max / 1e6 : 0,
      processRssBytes: memory.rss, processHeapUsedBytes: memory.heapUsed,
      processMaxRssKiB: process.resourceUsage().maxRSS,
      processCpuUserMicros: cpu.user, processCpuSystemMicros: cpu.system
    };
  }
  close(): void { this.loop.disable(); }
}
