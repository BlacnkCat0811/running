/**
 * Model access for the weekly plan generator.
 *
 * Deliberately dependency-free: every supported provider speaks the
 * OpenAI-compatible `/chat/completions` shape, so adding GPT (or any other
 * compatible endpoint) is a single entry in `PROVIDER_DEFAULTS` plus env config.
 *
 * The API key is never logged and never persisted.
 */

export interface PlanModelClient {
  readonly provider: string;
  readonly model: string;
  complete(request: { system: string; user: string; maxTokens?: number; temperature?: number }): Promise<string>;
}

export interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  /**
   * Output budget for one attempt. Optional so existing callers keep compiling;
   * raise it for a model that reasons harder than the default one does.
   */
  maxTokens?: number;
}

export interface ProviderDefaults {
  model: string;
  baseUrl: string;
}

export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  deepseek: { model: "deepseek-chat", baseUrl: "https://api.deepseek.com" },
  openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" }
};

export const DEFAULT_LLM_PROVIDER = "deepseek";
/** Ceiling for a single attempt. */
export const DEFAULT_TIMEOUT_MS = 45_000;
/**
 * Hard ceiling for the whole call, retries included.
 *
 * The generate endpoint waits on this request, so the caller's own timeout has
 * to clear this budget: if the client gave up first, the server would carry on
 * and persist a plan nobody saw. Staying under the client budget keeps "the
 * request failed" and "no plan was written" the same event.
 *
 * The only client of `POST /v1/mobile/workout-plan/generate` is the iOS app,
 * and its budget is `RaiAPIClient.generateTimeoutInterval` (60 s in
 * `apps/ios/RAI/APIClient.swift`). That is deliberately *not* the generic POST
 * default: a structured week is a long completion, so the server keeps a full
 * attempt's worth of model time instead of being trimmed under a short timeout.
 * `apps/api/test/weekly-plan.test.ts` reads the Swift constant and fails if the
 * two ever cross, which is what the earlier "clients time out at 60 s" comment
 * asserted without checking.
 */
export const DEFAULT_TOTAL_BUDGET_MS = 50_000;
const MIN_ATTEMPT_MS = 5_000;
/**
 * Ceiling for a single attempt — and because a reasoning model bills its hidden
 * tokens here too, that means the whole output budget, not just the JSON.
 *
 * `deepseek-flash` reported 2921 reasoning tokens plus ~1150 visible ones for a
 * measured week. At the previous 4096 the reasoning left roughly 400 tokens for
 * the plan, so a slightly longer deliberation truncated the JSON mid-object,
 * `parsePlanJson` found no `days` array, and the week was silently replaced by
 * the template. 8192 stops the visible output from competing with the reasoning.
 */
const DEFAULT_MAX_TOKENS = 8192;
const MAX_RETRIES = 1;

export class LlmRequestError extends Error {
  readonly code = "llm_request_failed";
  /**
   * Set when the reason itself settles the retry question and the HTTP status does
   * not. A completion cut off at `max_tokens` truncates the same way on the next
   * attempt — the budget did not change — so retrying it only spends what is left
   * of the caller's time. `undefined` falls back to the status rule.
   */
  readonly retryable: boolean | undefined;
  constructor(message: string, readonly status?: number, retryable?: boolean) {
    super(message);
    this.name = "LlmRequestError";
    this.retryable = retryable;
  }
}

/**
 * Reads LLM settings from the environment. Returns null when no key is
 * configured, which makes the caller fall back to the heuristic planner.
 */
export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const apiKey = env.RAI_LLM_API_KEY?.trim();
  if (!apiKey) return null;
  const provider = (env.RAI_LLM_PROVIDER?.trim() || DEFAULT_LLM_PROVIDER).toLowerCase();
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS[DEFAULT_LLM_PROVIDER]!;
  const requestedTokens = Number(env.RAI_LLM_MAX_TOKENS?.trim());
  return {
    provider,
    model: env.RAI_LLM_MODEL?.trim() || defaults.model,
    apiKey,
    baseUrl: (env.RAI_LLM_BASE_URL?.trim() || defaults.baseUrl).replace(/\/+$/, ""),
    // Ignore a malformed value rather than sending it upstream: `max_tokens: NaN`
    // would be rejected by the provider with a message about the wrong thing.
    maxTokens: Number.isFinite(requestedTokens) && requestedTokens > 0
      ? Math.floor(requestedTokens)
      : DEFAULT_MAX_TOKENS
  };
}

function extractContent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = first?.message?.content ?? first?.text;
  return typeof content === "string" && content.trim().length > 0 ? content : null;
}

/**
 * The provider's stop reason for the first choice, when it reports one.
 *
 * `finish_reason: "length"` means the model ran out of budget mid-JSON, and such a
 * response must not be parsed as a plan: `parsePlanJson` finds no `days` array and
 * the week is silently replaced by the conservative template. `null` when the
 * provider does not say (some gateways omit it), which is "unknown", never "fine".
 */
function finishReasonOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const reason = (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason;
  return typeof reason === "string" ? reason : null;
}

export function createPlanModelClient(
  config: LlmConfig,
  options: { timeoutMs?: number; totalBudgetMs?: number; fetchImpl?: typeof fetch } = {}
): PlanModelClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    provider: config.provider,
    model: config.model,
    async complete(request) {
      const body = JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user }
        ],
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
        response_format: { type: "json_object" }
      });

      const deadline = Date.now() + totalBudgetMs;
      let firstError: Error | null = null;
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        // A retry only happens when a whole attempt still fits in the budget;
        // starting one that must be cut short would just return a worse error.
        const remaining = deadline - Date.now();
        if (attempt > 0 && remaining < MIN_ATTEMPT_MS) break;
        const attemptTimeout = Math.max(MIN_ATTEMPT_MS, Math.min(timeoutMs, remaining));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), attemptTimeout);
        try {
          const response = await doFetch(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`
            },
            body,
            signal: controller.signal
          });
          if (!response.ok) {
            // Never echo the response body verbatim: it can contain request echoes.
            throw new LlmRequestError(`模型服务返回 ${response.status}`, response.status);
          }
          const payload = (await response.json()) as unknown;
          const content = extractContent(payload);
          if (!content) throw new LlmRequestError("模型响应缺少内容");
          // A truncated response is not a short plan. Parsing it made the caller see
          // "no days" and fall back to the template without naming the cause, so it
          // is named here instead — and marked non-retryable: the next attempt sends
          // the same `max_tokens`, so it truncates the same way.
          if (finishReasonOf(payload) === "length") {
            throw new LlmRequestError("模型输出被 token 上限截断", undefined, false);
          }
          return content;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          firstError ??= lastError;
          const retryable =
            error instanceof LlmRequestError && error.retryable !== undefined
              ? error.retryable
              : !(error instanceof LlmRequestError) ||
                error.status == null ||
                error.status >= 500 ||
                error.status === 429;
          if (attempt === MAX_RETRIES || !retryable) break;
        } finally {
          clearTimeout(timer);
        }
      }
      const failure = reportedError(firstError, lastError);
      throw failure instanceof LlmRequestError
        ? failure
        : new LlmRequestError(failure?.message ?? "模型请求失败");
    }
  };
}

/** True when our own deadline produced the error rather than the provider. */
function isDeadlineArtifact(error: Error): boolean {
  return error.name === "AbortError" || error.name === "TimeoutError";
}

/**
 * Which failure to report once every attempt has failed.
 *
 * Usually the last one, since it is the most specific. The exception is a final
 * attempt killed by our own deadline: a retry gets only what is left of the budget,
 * so it is aborted mid-flight, and reporting that replaces the cause — "the output
 * was truncated", "the service returned 500" — with "the operation was aborted",
 * which names the symptom the caller already knows about.
 */
function reportedError(first: Error | null, last: Error | null): Error | null {
  if (last === null) return first;
  if (first === null || first === last) return last;
  return isDeadlineArtifact(last) && !isDeadlineArtifact(first) ? first : last;
}
