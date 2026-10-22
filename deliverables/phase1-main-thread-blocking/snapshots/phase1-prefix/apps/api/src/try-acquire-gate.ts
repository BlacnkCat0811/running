/**
 * Single-process fail-fast concurrency gate.
 *
 * Contention is reported as `null`, rather than MutationCoordinator's conflict
 * exception, so a route can return its own stable domain-specific busy response.
 */
export class TryAcquireGate {
  private held = false;

  tryAcquire(): (() => void) | null {
    if (this.held) return null;
    this.held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held = false;
    };
  }
}
