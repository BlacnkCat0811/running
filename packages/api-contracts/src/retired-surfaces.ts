/**
 * Retired legacy training-plan surfaces (product decision 2026-10-20).
 *
 * One table for every consumer that must agree on the retirement:
 * - `apps/api/src/server.ts` answers exactly these method/path pairs with
 *   `410 legacy_surface_retired` and derives the replacement text from here;
 * - `apps/api/src/schemas.ts` generates the OpenAPI entries (deprecated, only a
 *   410 response) from the same rows;
 * - the iOS outbound gate (`apps/ios/tests/check-retired-plan-outbound.py`)
 *   compares this table with the Swift transport literals.
 *
 * Method is part of the identity on purpose. `/v1/mobile/workout-plan` (GET)
 * and `/v1/mobile/workout-plan/synced` (POST) remain live; a prefix rule would
 * retire legitimate routes. A path-only rule would also hide a future method
 * added to one of these paths.
 */
export type RetiredPlanMethod = "GET" | "POST" | "PUT";
export type RetiredPlanTag = "Read" | "Workouts";

export interface RetiredPlanSurface {
  readonly method: RetiredPlanMethod;
  readonly path: string;
  /** The replacement surface named in the 410 body and the OpenAPI description. */
  readonly replacement: string;
  /** OpenAPI tag used only for the generated retired operation. */
  readonly tag: RetiredPlanTag;
  /** OpenAPI summary before the `（已退役）` suffix. */
  readonly summary: string;
}

export const RETIRED_TRAINING_PLAN_SURFACES = [
  {
    method: "GET",
    path: "/v1/mobile/goals",
    replacement: "/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands",
    tag: "Read",
    summary: "读取 iOS 周目标、结构目标与赛事目标"
  },
  {
    method: "PUT",
    path: "/v1/mobile/goals",
    replacement: "/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands",
    tag: "Workouts",
    summary: "更新 iOS 周目标、结构目标与赛事目标"
  },
  {
    method: "GET",
    path: "/v1/mobile/run-coach",
    replacement: "/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands",
    tag: "Read",
    summary: "自适应跑步教练计划、阶段和补充力量安排"
  },
  {
    method: "POST",
    path: "/v1/mobile/run-coach",
    replacement: "/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands",
    tag: "Workouts",
    summary: "创建、更新偏好、自适应刷新、暂停、恢复或结束跑步教练计划"
  },
  {
    method: "POST",
    path: "/v1/mobile/workout-plan/preview",
    replacement: "/v1/mobile/training-plan/commands/preview",
    tag: "Workouts",
    summary: "规则教练生成未来七日候选课表；不保存、不推送手表"
  },
  {
    method: "POST",
    path: "/v1/mobile/workout-plan/confirm",
    replacement: "/v1/mobile/training-plan/commands",
    tag: "Workouts",
    summary: "确认预览并发布课表；支持重复确认幂等"
  },
  {
    method: "POST",
    path: "/v1/mobile/workout-plan/generate",
    replacement: "/v1/mobile/training-plan/commands/refresh",
    tag: "Workouts",
    summary: "规则教练生成并持久化未来七日课表"
  }
] as const satisfies readonly RetiredPlanSurface[];

/** Exact method+path lookup. Unknown pairs return `null`; never a prefix match. */
export function retiredTrainingPlanSurface(method: string, path: string): RetiredPlanSurface | null {
  const normalizedMethod = method.toUpperCase();
  return RETIRED_TRAINING_PLAN_SURFACES.find(
    (surface) => surface.method === normalizedMethod && surface.path === path
  ) ?? null;
}
