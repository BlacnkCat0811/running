import type { MobilePlanOperationQueryResponse, MobilePlanOperationScope } from "@rai/api-contracts";
import { MOBILE_PLAN_OPERATION_QUERY_STATUSES } from "@rai/api-contracts";

import type { MobileGoalsStore } from "./mobile-goals.js";
import { digest } from "./plan-digest.js";

export class PlanOperationError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}

/**
 * 把 `MobileGoalsStore.publicationResult()` 的 `unknown` 收窄成契约联合类型。
 *
 * 为什么不是裸 `as`：`publicationResult()` 返回 `unknown` 是因为它跨越了
 * "控制库行 → JSON" 的边界，而 `/v1/mobile/plan-operations/:id` 是**对外契约**
 * （`MobilePlanOperationQueryResponse`）。如果哪天存储层多出一个状态（比如
 * `quarantined`），`as` 会把它原样发给客户端 —— iOS 侧只会得到一句
 * "未知的发布操作状态，原操作不会重放"（`NativeAppModel.resolvePendingPublication`），
 * 既没有服务端日志也没有可诊断的码。所以这里做一次**真实校验**：
 * 状态必须是共享单源里的四个之一，`committed` 必须带 `result` 键。
 *
 * 违反时抛 500（`plan_operation_status_unknown`）：这是服务端不变量被破坏，
 * 不该伪装成客户端可重试的 4xx。
 */
export function narrowPlanOperationResult(value: unknown): MobilePlanOperationQueryResponse {
  if (!value || typeof value !== "object") {
    throw new PlanOperationError("plan_operation_status_unknown", "发布操作查询返回了非对象结果。", 500);
  }
  const record = value as { status?: unknown; operationId?: unknown; result?: unknown };
  if (typeof record.operationId !== "string" || record.operationId.length === 0) {
    throw new PlanOperationError("plan_operation_status_unknown", "发布操作查询缺少 operationId。", 500);
  }
  const statuses: readonly unknown[] = MOBILE_PLAN_OPERATION_QUERY_STATUSES;
  if (!statuses.includes(record.status)) {
    throw new PlanOperationError("plan_operation_status_unknown",
      `发布操作查询返回了未知状态 ${JSON.stringify(record.status)}；契约只允许 ${MOBILE_PLAN_OPERATION_QUERY_STATUSES.join("/")}。`, 500);
  }
  if (record.status === "committed" && !("result" in record)) {
    throw new PlanOperationError("plan_operation_status_unknown", "已提交的发布操作缺少原结果。", 500);
  }
  return value as MobilePlanOperationQueryResponse;
}

export class PlanPublicationService {
  /**
   * `identity` 是**必填**构造参数（审查 P3-9）。
   *
   * 它此前是 `identity?`，于是"忘记传"在类型上完全合法，而后果是
   * `publish()` 里的 `if (input.operationId && this.identity)` 整段被跳过 ——
   * **跨数据域重放校验静默消失**：一个属于旧 datasetEpoch 的 operationId
   * 会被当前数据集直接执行。那不是"少一道日志"，而是把 §发布操作 的
   * "即使原意图从未到达服务端，也不能在更换数据集之后被执行"变成空话。
   *
   * 现在没有默认值也没有兜底：所有发布入口（server / run-coach / coach-loop）
   * 必须在构造时声明身份，编译期就能发现遗漏。`scope()` 是存储分区键，
   * `identity()` 是**业务身份**，两者不可互相替代 —— 这也是保留两个参数的唯一理由。
   */
  constructor(private readonly store: MobileGoalsStore, private readonly scope: () => string,
    private readonly identity: () => MobilePlanOperationScope) {}

  publish<Result, Input extends { operationId?: string; operationScope?: MobilePlanOperationScope }>(route: string, input: Input, action: () => Result): Result {
    if (input.operationId) {
      if (!input.operationScope) throw new PlanOperationError("plan_operation_contract_mismatch", "持久发布操作必须声明原服务和数据集身份。", 422);
      if (digest(input.operationScope) !== digest(this.identity())) throw new PlanOperationError("plan_operation_scope_mismatch", "原操作属于其他服务或数据集，不能跨域重放。");
    }
    return this.store.publicationOperation(this.scope(), input.operationId, route, input, action);
  }

  /**
   * `GET /v1/mobile/plan-operations/:id` 的响应体。
   *
   * 返回**契约类型**而不是 `unknown`：此前该路由是训练计划链路里唯一没有共享类型
   * 兜底的对外契约（审查 P2-14），服务端加状态/改字段不会有任何编译期或门禁失败。
   */
  result(operationId: string): MobilePlanOperationQueryResponse {
    return narrowPlanOperationResult(this.store.publicationResult(this.scope(), operationId));
  }
}
