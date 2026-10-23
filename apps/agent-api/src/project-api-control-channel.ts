import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticateRunnerRequest, signRunnerRequest } from "./runner-readiness";
import { validProjectApiRequest, validProjectApiResponse, PROJECT_API_RESPONSE_HEADERS, PROJECT_API_RESPONSE_LIMIT,
  type ProjectApiBindingRequest, type ProjectApiBindingResponse } from "./sandbox-project-api-binding.mjs";

const PREFIX = "/v1/project-api";
const unavailable = (): ProjectApiBindingResponse => ({
  status: 503, headers: { "content-type": "application/json" },
  bodyBase64: Buffer.from(JSON.stringify({ error: { code: "PROJECT_API_CONTROL_UNAVAILABLE", message: "Project API control channel is unavailable" } })).toString("base64"),
});
interface Task { id: string; request: ProjectApiBindingRequest; expiresAt: number; }
interface Pending { task: Task; finish(value: ProjectApiBindingResponse): void; }

/** Bounded transient request exchange on the existing runner control plane.
 * No database access, URL forwarding, model calls or authorization decisions. */
export function registerProjectApiControlServer(app: FastifyInstance, secret: string, seen: Map<string, number>,
  options: { enabled: boolean; timeoutMs?: number; maxPending?: number } = { enabled: false }) {
  const pending = new Map<string, Pending>();
  const queue: Task[] = [];
  const waiters = new Set<(task: Task | null) => void>();
  let lastPoll = 0;
  const status = () => ({ enabled: options.enabled, clientConnected: Date.now() - lastPoll < 10000, pending: pending.size });
  if (!options.enabled) return { status };
  const timeoutMs = options.timeoutMs ?? 15000;
  const take = () => {
    lastPoll = Date.now();
    while (queue.length) { const task = queue.shift()!; if (pending.has(task.id)) return Promise.resolve(task); }
    return new Promise<Task | null>(resolve => {
      const finish = (task: Task | null) => { clearTimeout(timer); waiters.delete(finish); resolve(task); };
      const timer = setTimeout(() => finish(null), 5000); timer.unref(); waiters.add(finish);
    });
  };
  const dispatch = (request: ProjectApiBindingRequest) => {
    if (pending.size >= (options.maxPending ?? 64) || Date.now() - lastPoll >= 10000) return Promise.resolve(unavailable());
    return new Promise<ProjectApiBindingResponse>(resolve => {
      const task = { id: randomUUID(), request, expiresAt: Date.now() + timeoutMs };
      const timer = setTimeout(() => finish(unavailable()), timeoutMs); timer.unref();
      const finish = (value: ProjectApiBindingResponse) => {
        clearTimeout(timer); pending.delete(task.id);
        const index = queue.findIndex(item => item.id === task.id); if (index >= 0) queue.splice(index, 1);
        resolve(value);
      };
      pending.set(task.id, { task, finish });
      const waiter = waiters.values().next().value; if (waiter) waiter(task); else queue.push(task);
    });
  };
  const authenticate = (request: FastifyRequest<{ Body: string }>) =>
    authenticateRunnerRequest({ headers: request.headers, body: request.body ?? "", secret, seen });
  for (const action of ["dispatch", "poll", "reply", "status"] as const) {
    app.post<{ Body: string }>(PREFIX + "/" + action, async (request, reply) => {
      const auth = authenticate(request);
      if (!auth.ok) return reply.code(auth.status).send({ error: { code: auth.code } });
      let value: unknown;
      try { value = JSON.parse(request.body); } catch { return reply.code(400).send({ error: { code: "invalid_control_body" } }); }
      if (action === "status") return status();
      if (action === "poll") return { task: await take() };
      if (action === "dispatch") {
        if (!validProjectApiRequest(value)) return reply.code(403).send({ error: { code: "project_api_request_refused" } });
        return dispatch(value);
      }
      const answer = value as { id?: unknown; response?: unknown };
      const item = typeof answer?.id === "string" ? pending.get(answer.id) : undefined;
      if (!item || item.task.expiresAt <= Date.now()) return reply.code(409).send({ error: { code: "project_api_request_expired" } });
      if (!validProjectApiResponse(answer.response)) return reply.code(400).send({ error: { code: "invalid_project_api_response" } });
      item.finish(answer.response); return { accepted: true };
    });
  }
  app.addHook("onClose", async () => {
    for (const wake of waiters) wake(null);
    for (const item of pending.values()) item.finish(unavailable());
  });
  return { status };
}

/** The API initiates all network traffic over its existing authenticated runner
 * connection. Gateway work is handled by the existing registered public routes. */
export function registerProjectApiControlClient(app: FastifyInstance, options: {
  enabled?: boolean; runnerUrl?: string; secret?: string;
} = {}) {
  const enabled = options.enabled ?? process.env.NPATI_PROJECT_API_SERVICE_BINDING === "dev";
  if (!enabled) return;
  if (process.env.NPATI_PROJECT_RUNTIME_MODE && process.env.NPATI_PROJECT_RUNTIME_MODE !== "shared")
    throw new Error("project_api_control_requires_shared_runtime");
  const base = options.runnerUrl ?? process.env.NPATI_SANDBOX_RUNNER_URL ?? "";
  const secret = options.secret ?? process.env.NPATI_SANDBOX_RUNNER_SECRET ?? "";
  if (!base || secret.length < 32) throw new Error("project_api_control_not_configured");
  const controller = new AbortController();
  const jobs: Promise<void>[] = [];
  const post = async (action: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const response = await fetch(base.replace(/\/$/, "") + PREFIX + "/" + action, {
      method: "POST", body, headers: signRunnerRequest({ secret, body }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) throw new Error("project_api_control_unavailable");
    return response.json() as Promise<{ task?: Task | null }>;
  };
  const loop = async () => {
    while (!controller.signal.aborted) {
      try {
        const { task } = await post("poll", {});
        if (!task) continue;
        if (!validProjectApiRequest(task.request) || task.expiresAt <= Date.now()) continue;
        const payload = Buffer.from(task.request.bodyBase64, "base64");
        const response = await app.inject({ method: task.request.method as "GET" | "POST" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS",
          url: task.request.path, headers: task.request.headers, ...(payload.length ? { payload } : {}) });
        const headers: Record<string, string> = {};
        for (const name of PROJECT_API_RESPONSE_HEADERS) if (typeof response.headers[name] === "string") headers[name] = response.headers[name] as string;
        const result = response.rawPayload.length <= PROJECT_API_RESPONSE_LIMIT
          ? { status: response.statusCode, headers, bodyBase64: response.rawPayload.toString("base64") } : unavailable();
        // No retry: replaying a timed-out write could duplicate a mutation.
        await post("reply", { id: task.id, response: result });
      } catch {
        if (!controller.signal.aborted) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 500); timer.unref(); controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    }
  };
  app.addHook("onReady", async () => { jobs.push(loop(), loop()); });
  app.addHook("onClose", async () => { controller.abort(); await Promise.allSettled(jobs); });
}
