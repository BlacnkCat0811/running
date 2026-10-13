/**
 * 分析写窗口的**同步**闸门（`docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md` §3.2.1）。
 *
 * 为什么是同步接口：pipeline 全程同步（`runFullRecompute` 不是 async），而租约的授予方在
 * **另一个线程**上 —— 只有同步接口才能让 pipeline 在每个写窗口的开闭处真的取/放许可。
 * 默认实现是**无操作**：CLI、单测、以及任何没有租约的场景行为逐字节不变。
 */
/**
 * 分析链路**真正用到**的 store 成员（审计结论：只有这两个）。
 *
 * 为什么要收窄：worker 线程要把数据库连接换成一个"每个写语句都经过租约闸门"的代理对象
 * （`apps/api/src/recompute-thread.ts`），而 `RaiDatabase` 是个大接口。收窄到实际用到的成员之后，
 * 代理对象**不需要**伪装成完整 store —— 少一个成员就是编译错误，而不是运行期悄悄绕过闸门。
 */
export interface AnalysisStore {
  readonly database: import("node:sqlite").DatabaseSync;
  pruneSupersededModelRuns(options?: { keepRecent?: number }): unknown;
}

export interface WriteGate {
  /** 在写窗口内持有许可；`fn` 抛错也会释放。 */
  scope<T>(fn: () => T): T;
  /** 长计算里的让路点：持有超时就把许可交回去（等待中的接收方先走），随后重取。 */
  yieldIfStale(maxHoldMs?: number): void;
}

/** 无闸门：不取任何许可（默认）。 */
export const NO_WRITE_GATE: WriteGate = {
  scope: (fn) => fn(),
  yieldIfStale: () => {}
};
