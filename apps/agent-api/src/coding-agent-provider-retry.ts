/**
 * One retry of a model request after a transient provider failure (timeout, dropped connection, 408/429/5xx).
 *
 * Safe by construction: tool calls are executed only after a model response arrives, so repeating the request
 * never repeats a tool call. A cancelled run, a client error (4xx other than 408/429) and a second failure are
 * returned to the caller unchanged, which then reports the provider failure as before.
 */
export function isTransientProviderFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  const shaped = error as { code?: string; httpStatus?: number; statusCode?: number; status?: number; name?: string; message?: string } | null;
  const status = shaped?.httpStatus ?? shaped?.statusCode ?? shaped?.status;
  if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
  const text = `${shaped?.code ?? ""} ${shaped?.name ?? ""} ${shaped?.message ?? ""}`;
  return /provider_timeout|provider_connection_error|TimeoutError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|terminated/i.test(text);
}

export async function chatWithTransientRetry<Request extends { signal?: AbortSignal }, Result>(
  chat: (request: Request) => Promise<Result>,
  request: Request,
  options: { delayMs?: number; onRetry?: (error: unknown) => Promise<void> | void } = {},
): Promise<Result> {
  try {
    return await chat(request);
  } catch (error) {
    if (!isTransientProviderFailure(error, request.signal)) throw error;
    await options.onRetry?.(error);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 2_000));
    if (request.signal?.aborted) throw error;
    return chat(request);
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
