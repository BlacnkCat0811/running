import { MutationConflictError, MutationCoordinator } from "./mutation-coordinator.js";

export interface TaskAdmission {
  acquire(): (() => void) | null;
  withdraw(): void;
}

/** One CPU-heavy writer across all executors. Pending owners keep FIFO priority. */
export class TaskAdmissionScheduler {
  private readonly waiting = new Set<string>();
  private active: string | null = null;
  private blocked: string | null = null;
  private controls = 0;
  constructor(private readonly mutations: MutationCoordinator) {}

  owner(name: string): TaskAdmission {
    return {
      acquire: () => {
        this.waiting.add(name);
        if (this.blocked || this.active || this.controls > 0 || this.waiting.values().next().value !== name) return null;
        let release: () => void;
        try { release = this.mutations.acquire(name); }
        catch (error) {
          if (error instanceof MutationConflictError) return null;
          throw error;
        }
        this.waiting.delete(name);
        this.active = name;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active = null;
          release();
        };
      },
      withdraw: () => { this.waiting.delete(name); }
    };
  }

  blockUntilRestart(reason: string): void { this.blocked = reason; }
  get isBlocked(): boolean { return this.blocked !== null; }
  get hasActiveControls(): boolean { return this.controls > 0; }

  /** Allow cancellation of the current compute job, but pin out a following import. */
  acquireControl(owner: string): (() => void) | null {
    if (this.blocked || this.active !== owner) return null;
    this.controls++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.controls--;
    };
  }

  snapshot(): { active: string | null; waiting: string[]; blocked?: string } {
    return { active: this.active, waiting: [...this.waiting], ...(this.blocked ? { blocked: this.blocked } : {}) };
  }
}
