import type { CommandResponse, OverrideWorkoutInput } from "@rai/api-contracts";
import { ApiError, api, readApiToken } from "./api.js";

export interface FeedbackSubmission {
  idempotencyKey: string;
  kind: "workout_override";
  payload: OverrideWorkoutInput & { trainingSessionId: string };
}
/** Only an enqueue payload validation refusal permits discarding that attempt. */
export class FeedbackSubmissionRejected extends Error {}
export class FeedbackCredentialsChanged extends Error {
  constructor() { super("连接凭证已变化，请回到原连接检查保存结果"); }
}
export class FeedbackAuthenticationRequired extends Error {
  constructor() { super("当前连接无法验证此操作，请检查访问令牌与权限后再查询原操作"); }
}
/** Retain this object for uncertain results; never mint a second key on network retry. */
export async function submitFeedbackCommand(submission: FeedbackSubmission): Promise<CommandResponse> {
  const token = readApiToken();
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  let result: CommandResponse;
  try {
    result = await api<CommandResponse>("/v1/commands", { method: "POST", body: JSON.stringify(submission), ...(headers ? { headers } : {}) });
  } catch (error) {
    if (readApiToken() !== token) throw new FeedbackCredentialsChanged();
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw new FeedbackAuthenticationRequired();
    if (error instanceof ApiError && (error.status === 400 || error.status === 422)) throw new FeedbackSubmissionRejected(error.message);
    throw error;
  }
  for (let count = 0; count < 20 && (result.status === "queued" || result.status === "running"); count++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (readApiToken() !== token) throw new FeedbackCredentialsChanged();
    try {
      result = await api<CommandResponse>(`/v1/commands/${encodeURIComponent(result.id)}`, headers ? { headers } : undefined);
    } catch (error) {
      if (readApiToken() !== token) throw new FeedbackCredentialsChanged();
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw new FeedbackAuthenticationRequired();
      // A lookup error says nothing about an already accepted command's effect.
      throw error;
    }
  }
  if (readApiToken() !== token) throw new FeedbackCredentialsChanged();
  return result;
}
