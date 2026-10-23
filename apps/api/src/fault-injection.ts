import { appendFileSync } from "node:fs";

/**
 * Deterministic fault barrier for crash-consistency acceptance tests.
 *
 * Production leaves `RAI_FAULT_POINT` unset: every call is a no-op. Tests spawn a
 * real API child with `RAI_FAULT_POINT=<point>:sigkill` or `:throw`; the barrier
 * fires exactly once per named point so a retry cannot silently skip it.
 *
 * This is intentionally tiny and auditable: no timers, no random windows, no
 * production reads. A crash point that is not named in the review plan never
 * exists in the code.
 *
 * P3 (2026-10-23): firing additionally requires **both** an explicit
 * `RAI_FAULT_INJECTION=1` switch and a test environment marker. A stray
 * `RAI_FAULT_POINT` in a production shell can no longer kill the process;
 * deployment templates set neither variable, and the acceptance harness sets
 * both.
 */
export function faultPoint(point: string): void {
  if (process.env.RAI_FAULT_INJECTION !== "1") return;
  if (process.env.NODE_ENV !== "test" && process.env.RAI_FAULT_TEST_ENV !== "1") return;
  const raw = process.env.RAI_FAULT_POINT?.trim();
  if (!raw) return;
  // Comma-separated specs allow one run to exercise two consecutive barriers
  // (for example: install fails, then the rollback fails too). A single spec
  // keeps the historical `name:action` format.
  for (const spec of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const separator = spec.lastIndexOf(":");
    if (separator <= 0) continue;
    const name = spec.slice(0, separator);
    const action = spec.slice(separator + 1);
    if (name !== point) continue;
    const marker = process.env.RAI_FAULT_MARKER?.trim();
    if (marker) {
      try { appendFileSync(marker, `${new Date().toISOString()} ${point}\n`); } catch { /* marker is diagnostic only */ }
    }
    if (action === "sigkill") {
      process.kill(process.pid, "SIGKILL");
      return;
    }
    if (action === "throw") throw new Error(`Injected fault at ${point}`);
  }
}
