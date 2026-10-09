import type { MobileGoalsStore } from "./mobile-goals.js";
import type { MobilePlanOperationScope } from "@rai/api-contracts";
import { digest } from "./plan-digest.js";

export class PlanOperationError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}

export class PlanPublicationService {
  constructor(private readonly store: MobileGoalsStore, private readonly scope: () => string,
    private readonly identity?: () => MobilePlanOperationScope) {}

  publish<Result, Input extends { operationId?: string; operationScope?: MobilePlanOperationScope }>(route: string, input: Input, action: () => Result): Result {
    if (input.operationId && this.identity) {
      if (!input.operationScope) throw new PlanOperationError("plan_operation_contract_mismatch", "持久发布操作必须声明原服务和数据集身份。", 422);
      if (digest(input.operationScope) !== digest(this.identity())) throw new PlanOperationError("plan_operation_scope_mismatch", "原操作属于其他服务或数据集，不能跨域重放。");
    }
    return this.store.publicationOperation(this.scope(), input.operationId, route, input, action);
  }

  result(operationId: string): unknown {
    return this.store.publicationResult(this.scope(), operationId);
  }
}
