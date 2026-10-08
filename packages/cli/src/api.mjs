// @ts-check
/**
 * C15 (owner decision 2) — the CLI's HTTP transport, over Node's built-in `fetch`/`AbortController` only.
 *
 * No dependency is added for this. `undici` is already in the platform, `AbortController` has been global since
 * Node 15, and the only two hard parts — an SSE frame decoder and a redaction layer — are twenty lines each and are
 * implemented here so the CLI carries no dependency tree of its own.
 *
 * Every failure path produces an `ApiError` whose `message` has already been redacted with the caller's token, so
 * there is no code path in this file that can put a credential into a terminal, a log or an exception report.
 */
import { CliError, redactText, redactUrl } from "./token.mjs";

/** A transport or protocol failure. `status` is `0` when the request never reached the server. */
export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, retryable?: boolean, details?: Record<string, unknown> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = options.status ?? 0;
    this.retryable = options.retryable === true;
    this.details = options.details ?? {};
  }
}

/**
 * @param {unknown} value
 * @param {string | null} secret
 * @returns {string}
 */
function safeMessage(value, secret) {
  return redactText(value instanceof Error ? value.message : String(value), secret);
}

/**
 * One API client. It is deliberately stateless beyond its base URL and token: every command builds one and the
 * process exits, so there is no pool to leak and no cache to invalidate.
 */
export class ApiClient {
  /**
   * @param {{ baseUrl: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
   */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    /** @type {string} */
    this.token = options.token;
    /** @type {typeof fetch} */
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (typeof this.fetchImpl !== "function") {
      throw new CliError("fetch_unavailable", "This Node build has no global fetch; Node 22 or newer is required.");
    }
  }

  /**
   * @param {Record<string, string>} headers
   * @returns {Record<string, string>}
   */
  mergeHeaders(headers) {
    return headers;
  }

  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal }} [options]
   * @returns {Promise<{ status: number, body: any }>}
   */
  async request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("request timed out")), this.timeoutMs);
    // The caller's own cancellation (Ctrl-C) must reach the request too, without replacing the timeout abort.
    const external = options.signal;
    const onAbort = () => controller.abort(external?.reason);
    if (external) external.addEventListener("abort", onAbort, { once: true });
    try {
      /** @type {RequestInit} */
      const init = {
        method: options.method ?? "GET",
        headers: this.mergeHeaders({
          accept: "application/json",
          "x-npati-api-version": "v1",
          "user-agent": "npati-cli",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.token.startsWith("npati_live_") ? { "x-api-key": this.token } : { authorization: `Bearer ${this.token}` }),
          ...(options.headers ?? {}),
        }),
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      };
      let response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        throw new ApiError("request_failed", `Could not reach ${redactUrl(url)}: ${safeMessage(error, this.token)}`, {
          retryable: true,
        });
      }
      const text = await response.text();
      /** @type {any} */
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text.length > 2000 ? `${text.slice(0, 2000)}…` : text };
        }
      }
      if (!response.ok) {
        const error = parsed && typeof parsed === "object" ? parsed.error : null;
        throw new ApiError(
          typeof error?.code === "string" ? error.code : `http_${response.status}`,
          redactText(
            typeof error?.message === "string"
              ? error.message
              : `${options.method ?? "GET"} ${redactUrl(url)} answered ${response.status}`,
            this.token,
          ),
          {
            status: response.status,
            retryable: error?.retryable === true || response.status >= 500 || response.status === 429,
            details: error && typeof error === "object" && error.details && typeof error.details === "object" ? error.details : {},
          },
        );
      }
      return { status: response.status, body: parsed };
    } finally {
      clearTimeout(timeout);
      if (external) external.removeEventListener("abort", onAbort);
    }
  }

  /**
   * `POST /companies/:companyId/code/runs` — the C15 run-start route. Answers `202` with the server-minted run id
   * and the URL of the existing background stream.
   *
   * @param {{ companyId: string, projectId: string, sessionId?: string | null, prompt: string, readOnly?: boolean, signal?: AbortSignal }} input
   * @returns {Promise<any>}
   */
  async startRun(input) {
    const { body } = await this.request(`/companies/${encodeURIComponent(input.companyId)}/code/runs`, {
      method: "POST",
      body: {
        projectId: input.projectId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        prompt: input.prompt,
        ...(input.readOnly ? { readOnly: true } : {}),
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!body || typeof body !== "object" || !body.run || typeof body.run.runId !== "string") {
      throw new ApiError("malformed_run_response", "The server accepted the request but returned no run id.", { status: 202 });
    }
    return body;
  }

  /**
   * `GET /companies/:companyId/approvals` — the **existing** approvals list, reused unchanged.
   *
   * @param {{ companyId: string, status?: string | null, signal?: AbortSignal }} input
   * @returns {Promise<any[]>}
   */
  async listApprovals(input) {
    const query = input.status ? `?status=${encodeURIComponent(input.status)}` : "";
    const { body } = await this.request(`/companies/${encodeURIComponent(input.companyId)}/approvals${query}`, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const approvals = body && typeof body === "object" ? body.approvals : null;
    return Array.isArray(approvals) ? approvals : [];
  }

  /**
   * `GET /companies/:companyId/approvals/:approvalId`.
   *
   * @param {{ companyId: string, approvalId: string, signal?: AbortSignal }} input
   * @returns {Promise<any>}
   */
  async getApproval(input) {
    const { body } = await this.request(
      `/companies/${encodeURIComponent(input.companyId)}/approvals/${encodeURIComponent(input.approvalId)}`,
      { ...(input.signal ? { signal: input.signal } : {}) },
    );
    return body && typeof body === "object" ? body.approval : null;
  }

  /**
   * `POST /companies/:companyId/approvals/:approvalId/decide` — the **existing** decision route, which records the
   * decision in the tamper-evident journal **before** applying it. The CLI adds nothing to that: it is a client.
   *
   * @param {{ companyId: string, approvalId: string, decision: "approved" | "rejected", notes?: string | null, signal?: AbortSignal }} input
   * @returns {Promise<any>}
   */
  async decideApproval(input) {
    const { body } = await this.request(
      `/companies/${encodeURIComponent(input.companyId)}/approvals/${encodeURIComponent(input.approvalId)}/decide`,
      {
        method: "POST",
        body: { decision: input.decision, ...(input.notes ? { notes: input.notes } : {}) },
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    return body;
  }

  /**
   * `GET …/code/runs/:runId/background` — the polling read over the existing background-run registry, with the
   * mandatory `expectedRunId` repeated so the answer cannot be used as an existence oracle.
   *
   * @param {{ companyId: string, runId: string, fromSeq?: number, signal?: AbortSignal }} input
   * @returns {Promise<any>}
   */
  async readBackgroundRun(input) {
    const fromSeq = Number.isFinite(input.fromSeq) ? `&fromSeq=${input.fromSeq}` : "";
    const { body } = await this.request(
      `/companies/${encodeURIComponent(input.companyId)}/code/runs/${encodeURIComponent(input.runId)}/background` +
        `?expectedRunId=${encodeURIComponent(input.runId)}${fromSeq}`,
      { ...(input.signal ? { signal: input.signal } : {}) },
    );
    return body;
  }

  /**
   * `GET …/code/runs/:runId/background-stream` — the **existing** SSE surface, opened as a stream and decoded by
   * this module. Returns the abort function so the caller can stop reading without touching the run (reading and
   * stopping are different acts, and the CLI keeps them different).
   *
   * @param {{ companyId: string, runId: string, fromSeq?: number, onEvent: (event: { id: string | null, event: string, data: any }) => void, onError?: (error: ApiError) => void, onEnd?: () => void, signal?: AbortSignal }} input
   * @returns {Promise<() => void>}
   */
  async streamBackgroundRun(input) {
    const controller = new AbortController();
    const external = input.signal;
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener("abort", () => controller.abort(external.reason), { once: true });
    }
    const fromSeq = Number.isFinite(input.fromSeq) ? `&fromSeq=${input.fromSeq}` : "";
    const url =
      `${this.baseUrl}/companies/${encodeURIComponent(input.companyId)}/code/runs/${encodeURIComponent(input.runId)}` +
      `/background-stream?expectedRunId=${encodeURIComponent(input.runId)}${fromSeq}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: this.mergeHeaders({
          accept: "text/event-stream",
          "x-npati-api-version": "v1",
          "user-agent": "npati-cli",
          ...(this.token.startsWith("npati_live_") ? { "x-api-key": this.token } : { authorization: `Bearer ${this.token}` }),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ApiError("stream_failed", `Could not open the run stream: ${safeMessage(error, this.token)}`, { retryable: true });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let code = `stream_http_${response.status}`;
      let message = `The run stream answered ${response.status}.`;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && parsed.error) {
          if (typeof parsed.error.code === "string") code = parsed.error.code;
          if (typeof parsed.error.message === "string") message = parsed.error.message;
        }
      } catch { /* a non-JSON body is reported by status only */ }
      throw new ApiError(code, redactText(message, this.token), {
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    if (!response.body) throw new ApiError("stream_unavailable", "The run stream returned no body.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const drained = drainSseBuffer(buffer);
          buffer = drained.rest;
          for (const event of drained.events) input.onEvent(event);
        }
        const tail = drainSseBuffer(`${buffer}\n\n`);
        for (const event of tail.events) input.onEvent(event);
        input.onEnd?.();
      } catch (error) {
        if (controller.signal.aborted) {
          input.onEnd?.();
          return;
        }
        input.onError?.(new ApiError("stream_interrupted", safeMessage(error, this.token), { retryable: true }));
      }
    })();
    return () => controller.abort(new Error("the CLI stopped reading"));
  }
}

/**
 * One completed SSE frame. `data` is the parsed JSON payload when the frame carried JSON, and the raw string
 * otherwise — the background stream sends JSON, but a proxy or a future version may not.
 *
 * @typedef {{ id: string | null, event: string, data: any, raw: string }} SseEvent
 */

/**
 * The SSE frame decoder, as a pure function so it can be tested without a socket: it takes whatever arrived and
 * returns the frames that are complete plus the unterminated remainder. Frames are separated by a blank line
 * (LF or CRLF), a frame with no `event:` field is a `message` (the SSE default), and a line starting with `:` is a
 * comment — which is exactly what the existing route's heartbeat is, so it must not become an event.
 *
 * @param {string} buffer
 * @returns {{ events: SseEvent[], rest: string }}
 */
export function drainSseBuffer(buffer) {
  /** @type {SseEvent[]} */
  const events = [];
  let rest = buffer;
  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match || match.index === undefined) break;
    const frame = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    const parsed = parseSseFrame(frame);
    if (parsed) events.push(parsed);
  }
  return { events, rest };
}

/**
 * @param {string} frame
 * @returns {SseEvent | null}
 */
export function parseSseFrame(frame) {
  /** @type {string | null} */
  let id = null;
  let event = "message";
  /** @type {string[]} */
  const dataLines = [];
  let sawField = false;
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    sawField = true;
    if (field === "id") id = value;
    else if (field === "event") event = value || "message";
    else if (field === "data") dataLines.push(value);
  }
  if (!sawField || (id === null && event === "message" && dataLines.length === 0)) return null;
  const raw = dataLines.join("\n");
  /** @type {any} */
  let data = raw;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  return { id, event, data, raw };
}

/**
 * @param {ApiError | CliError | Error} error
 * @param {string | null} secret
 * @returns {string}
 */
export function describeError(error, secret) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code;
  const message = safeMessage(error, secret);
  return typeof code === "string" && code ? `${code}: ${message}` : message;
}
