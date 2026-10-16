import { MutationConflictError, MutationCoordinator } from "./mutation-coordinator.js";

export interface TaskAdmission {
  acquire(): (() => void) | null;
  withdraw(): void;
  /**
   * **可选**的状态变化通知（O08 步骤 2）：许可的可得性可能变化时回调一次，返回退订函数。
   *
   * 🔴 为什么必须是"可选"：`acquire()` 是"试一次"语义，等待方（`write-lease.ts` 的授权循环）
   * 此前只能靠**定时器**重试 —— 拿到许可的人一放，等待方仍要空转到下一个 tick 才发现。
   * 有了通知就能"状态一变就重判"。老调用方（`import-worker` / `command-queue` /
   * `prediction-worker`）不实现它 ⇒ 行为一个字节都不变，通知是**纯增益**不是新契约。
   */
  onChange?(listener: () => void): () => void;
  /**
   * **可选**的诊断归因：此刻拿不到许可的原因（持有者名字 / `restart` / `control` / `fifo:<owner>`）。
   *
   * 只用于计数（"哪些窗口在等谁"），不参与任何调度判定 —— 判定错了最多是诊断数字不准。
   */
  blocker?(): string;
}

/** One CPU-heavy writer across all executors. Pending owners keep FIFO priority. */
export class TaskAdmissionScheduler {
  private readonly waiting = new Set<string>();
  private active: string | null = null;
  private blocked: string | null = null;
  private controls = 0;
  /** 状态变化监听器（O08）。空集合时 `notifyChanged()` 是纯粹的几次判断，无副作用。 */
  private readonly listeners = new Set<() => void>();
  constructor(private readonly mutations: MutationCoordinator) {}

  owner(name: string): TaskAdmission {
    const blocker = (): string => {
      if (this.blocked) return "restart";
      if (this.active) return this.active;
      if (this.controls > 0) return "control";
      const head = this.waiting.values().next().value;
      return head === undefined || head === name ? "unknown" : `fifo:${head}`;
    };
    return {
      acquire: () => {
        this.waiting.add(name);
        // 🔴 这里**刻意不通知**：进队列 / 拿不到许可都不是"别人更可能拿到许可"的变化。
        // 通知必须只发给"可得性上升"的迁移，否则一个 blocked 的等待方每次重试都会唤醒另一个
        // blocked 的等待方，两者互相叫醒去失败一次 —— 那正是 O08 要消灭的空转轮询。
        if (this.blocked || this.active || this.controls > 0 || this.waiting.values().next().value !== name) {
          return null;
        }
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
          // 许可交回去了 ⇒ 排队的等待方现在就可能拿得到：这是**必须**通知的那一类迁移。
          this.notifyChanged();
        };
      },
      withdraw: () => {
        // 🔴 "真的删掉了"才算状态变化：队首空出来会让下一个人拿得到许可（可得性上升），
        // 而撤销一个不存在的排队位不是变化 —— 否则"请求消失 ⇒ withdraw"这条路径会给
        // 所有等待方白送一轮唤醒。
        if (this.waiting.delete(name)) this.notifyChanged();
      },
      onChange: (listener: () => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
      },
      blocker
    };
  }

  /**
   * 通知所有监听器"许可可得性可能变了"。
   *
   * ⚠️ 监听器抛错**不得**打断调度状态本身（状态已经改了，抛出去只会让调用方看到一个
   * 与事实不符的失败）。通知是延迟优化，不是正确性契约：漏一次通知最多让等待方多等一个退避。
   */
  private notifyChanged(): void {
    if (this.listeners.size === 0) return;
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* 见上：通知失败不影响调度状态 */ }
    }
  }

  blockUntilRestart(reason: string): void {
    if (this.blocked === reason) return;
    this.blocked = reason;
    this.notifyChanged();
  }
  get isBlocked(): boolean { return this.blocked !== null; }
  get hasActiveControls(): boolean { return this.controls > 0; }

  /** Allow cancellation of the current compute job, but pin out a following import. */
  acquireControl(owner: string): (() => void) | null {
    if (this.blocked || this.active !== owner) return null;
    // `controls++` 是**收紧**可得性（把它钉住），没有等待方需要因此醒来 —— 与 `acquire()`
    // 拿不到许可同理，这里不通知。
    this.controls++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.controls--;
      // `controls` 归零就是"后面的导入可以拿许可了" —— 等待方必须能立刻重判。
      this.notifyChanged();
    };
  }

  snapshot(): { active: string | null; waiting: string[]; blocked?: string } {
    return { active: this.active, waiting: [...this.waiting], ...(this.blocked ? { blocked: this.blocked } : {}) };
  }
}
