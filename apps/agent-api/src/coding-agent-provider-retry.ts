/**
 * Retries a model request while a provider failure looks transient (timeout, dropped connection, 408/429/5xx, a
 * stalled or failed stream), waiting longer each time: a busy provider should not end the user's run.
 *
 * Safe by construction: tool calls are executed only after a model response arrives, so repeating the request
 * never repeats a tool call. A cancelled run, a client error (4xx other than 408/429) and the last failure are
 * returned to the caller unchanged, which then reports the provider failure as before.
 */
export function isTransientProviderFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  const shaped = error as { code?: string; httpStatus?: number; statusCode?: number; status?: number; name?: string; message?: string } | null;
  const status = shaped?.httpStatus ?? shaped?.statusCode ?? shaped?.status;
  if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
  const text = `${shaped?.code ?? ""} ${shaped?.name ?? ""} ${shaped?.message ?? ""}`;
  // A refused request stays refused: a failed stream may still carry a client error.
  if (/HTTP 4\d\d/.test(text) && !/HTTP (?:408|429)/.test(text)) return false;
  return /provider_timeout|provider_connection_error|provider_stream_error|provider_stream_idle_timeout|HTTP (?:408|429|5\d\d)|stream content stall|too busy|overloaded|TimeoutError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|terminated/i.test(text);
}

/** About nine minutes in total. */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000, 120_000, 180_000];

function waitFor(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function chatWithTransientRetry<Request extends { signal?: AbortSignal }, Result>(
  chat: (request: Request) => Promise<Result>,
  request: Request,
  options: { delaysMs?: readonly number[]; onRetry?: (error: unknown) => Promise<void> | void } = {},
): Promise<Result> {
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chat(request);
    } catch (error) {
      if (attempt >= delays.length || !isTransientProviderFailure(error, request.signal)) throw error;
      console.warn(`[code-run] model request failed, retry ${attempt + 1} of ${delays.length}: ${String((error as { message?: string }).message ?? error).slice(0, 160)}`);
      await options.onRetry?.(error);
      await waitFor(delays[attempt]!, request.signal);
      if (request.signal?.aborted) throw error;
    }
  }
}

/**
 * The runner's engine port with the retry applied to `chat` only; every other engine method (native-tool detection,
 * recorded inputs) is the original object's, so the loop is unchanged.
 */
export function withTransientModelRetry<Engine extends { chat(request: never): Promise<unknown> }>(engine: Engine): Engine {
  const wrapped = Object.create(engine) as Engine;
  (wrapped as { chat: Engine["chat"] }).chat = ((request: { signal?: AbortSignal }) =>
    chatWithTransientRetry((value: typeof request) => (engine.chat as (input: typeof request) => Promise<unknown>).call(engine, value), request)) as Engine["chat"];
  return wrapped;
}
