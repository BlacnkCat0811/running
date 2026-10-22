import { publicationGuardChanged } from "./publication-guard.js";
import type { SnapshotGuardRead } from "./plan-read-consistency.js";

/**
 * coach-loop 只读 memo（2026-10-18 事故复盘 P1）。
 *
 * ## 为什么不是"单飞"
 *
 * `CoachLoopRuntime.read()` 是**全同步**计算：主库读、评估、响应组装都在一次事件
 * 循环 tick 内完成。同一个 Node 主线程上不可能有两条 read 同时在飞，所以"并发请求
 * 合并为一条在飞 Task"（客户端 P0-3 那种单飞）在这里**结构上没有意义**。真正的
 * 等价物是：证明"这次读用的快照现在仍然成立"时直接复用上一次稳定快照，省掉
 * ~1.3 s 的重复计算（生产实测 coach-loop 1.4 s/条）。
 *
 * ## 凭什么可以复用
 *
 * 命中必须同时满足（缺一不可，任何一项只能证明"可能没变"不算）：
 *
 * 1. **scope 相同**：`serverId/athleteId/datasetEpoch` 任一变化（删库/恢复/换身份）
 *    都可能让同一个 control digest 指向不同数据；
 * 2. **control digest 相同**：saved receipt + goals + plan history 三项；这是
 *    `readStableSnapshot` 用来证明"build 前后控制库没被写"的同一个 digest；
 * 3. **主库 data_version 指纹相同**：`<inode>:<PRAGMA data_version>`。`data_version`
 *    只在**其他连接提交**后变化，导入/直连增量/重算发布都会推进它；`inode` 变化
 *    表示发布换了库文件（读连接会被重开）。memo 只在 build 前后指纹一致时才写入，
 *    所以缓存的响应确实对应这个指纹；
 * 4. **本地日期相同**：评估按 `coachLocalDate` 切日，跨午夜必须重算；
 * 5. **publication guard 未变**：`pending` 时不命中（保持现有 503 重试语义），
 *    epoch 变化视为控制库发生了发布，必须重算；
 * 6. **TTL 未过期**：`COACH_LOOP_MEMO_TTL_MS` 只是兜底，不是主要失效手段。
 *
 * 因此命中的响应与"此刻重算"在**数据与计划状态**上等价；唯一差异是响应里的
 * `asOf` 最多旧 TTL（1 s）。这不扩大既有语义风险：客户端对写回执用 `factsHash`
 * 做乐观校验（`command()` 会拒绝过期 facts），1 s 的旧快照最多让客户端多一次
 * 重读，不会让写被错误接受。
 *
 * 注意：本 memo 只服务 `GET /v1/mobile/coach-loop`（`CoachLoopRuntime.readCached`）。
 * 内部控制流（`recordDeviceReceipt`、`command`）仍走 `read()`，永远不读缓存——
 * 回执匹配必须看到当下事实。
 */

/** 兜底 TTL；数据/计划状态变化由指纹与 digest 立即失效，不依赖它。 */
export const COACH_LOOP_MEMO_TTL_MS = 1_000;

export interface CoachLoopMemoKey {
  readonly scope: string;
  readonly controlDigest: string;
  /** `<inode>:<data_version>`，见 `ReadStoreManager.dataVersionFingerprint`。 */
  readonly mainDataVersion: string;
  /** `coachLocalDate(now)`：跨日必须重算。 */
  readonly localDate: string;
  /** build 之后读取的 publication guard（`failed` 永不命中）。 */
  readonly guard: SnapshotGuardRead;
}

/**
 * 两份 key 是否等价——即缓存响应是否仍然可证明成立。
 *
 * guard 的 `failed` 必须当成"不可证明"（与 `readStableSnapshot` 的 fail-closed 一致），
 * 不能因为读不到 guard 就降级命中。
 */
export function coachLoopKeyMatches(
  stored: CoachLoopMemoKey,
  current: CoachLoopMemoKey,
  nowMs: number = Date.now()
): boolean {
  if (stored.scope !== current.scope) return false;
  if (stored.controlDigest !== current.controlDigest) return false;
  if (stored.mainDataVersion !== current.mainDataVersion) return false;
  if (stored.localDate !== current.localDate) return false;
  if (stored.guard.kind !== current.guard.kind) return false;
  if (stored.guard.kind === "failed" || current.guard.kind === "failed") return false;
  if (stored.guard.kind === "absent") return true;
  if (current.guard.kind !== "ready") return false;
  // 两边 ready：pending（含当前正在发布）或 epoch 变化都必须重算；
  // `publicationGuardChanged` 自己处理 pending 租约与 malformed 时间戳。
  return publicationGuardChanged(stored.guard.state, current.guard.state, nowMs) === null;
}

/**
 * 只保存**一条**响应的短 TTL memo（identity 在 server 内固定，请求之间没有分片意义；
 * 多条 entry 只会增加失效面）。类保持纯函数式失效判断，便于单测。
 */
export class CoachLoopMemo<T> {
  private entry: { readonly key: CoachLoopMemoKey; readonly storedAt: number; readonly value: T } | null = null;

  constructor(
    private readonly ttlMs: number = COACH_LOOP_MEMO_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** 是否还没有可用条目（首次请求不必先做 control digest 校验）。 */
  isEmpty(): boolean {
    return this.entry === null;
  }

  /** 命中时返回缓存响应；TTL 过期或 key 不等价都返回 `undefined`。 */
  get(key: CoachLoopMemoKey): T | undefined {
    const entry = this.entry;
    if (entry === null) return undefined;
    const age = this.now() - entry.storedAt;
    // 时钟回拨（age < 0）不当作过期：TTL 只是一道兜底，真正的失效靠 key。
    if (age > this.ttlMs) {
      this.entry = null;
      return undefined;
    }
    return coachLoopKeyMatches(entry.key, key, this.now()) ? entry.value : undefined;
  }

  set(key: CoachLoopMemoKey, value: T): void {
    this.entry = { key, storedAt: this.now(), value };
  }

  clear(): void {
    this.entry = null;
  }
}
