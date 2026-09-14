import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx", "test/**/*.test.mjs"],
    clearMocks: true,
    // 本机在 CPU 竞争（与 API/worker 并行）时出现过 worker 超时；
    // 限制并发峰值并显式给出超时，换取确定性。完整套件仍可一次跑完。
    maxWorkers: 2,
    testTimeout: 20000,
    hookTimeout: 20000
  }
});
