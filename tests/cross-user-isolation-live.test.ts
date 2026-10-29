/**
 * Final V5: cross-user isolation on the live stand database. The real Fastify app (routes, RBAC, ownership checks) runs
 * in-process on PostgresWorkspaceStore against the stand's PostgreSQL; only authentication is substituted, because a
 * self-hosted installation binds one owner and registration is disabled. Background repositories stay in memory (no
 * databaseUrl), so no second scheduler, mail worker or messaging adapter touches live data.
 *
 * Identities: A = the real installation owner; B = synthetic user in its own workspace; B2 = synthetic user added as an
 * owner member of A's workspace (strongest same-workspace case). Destructive attempts target only A's seeded test objects.
 * Usage: FV5_DB_URL=postgres://... FV5_OWNER=<owner user id> npx vitest run tests/cross-user-isolation-live.test.ts
 * (skipped without FV5_DB_URL, so ordinary regression runs never touch a live database).
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { PostgresWorkspaceStore, type AuthContext } from "@npati/workspace";
import { expect, it } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";

const url = process.env.FV5_DB_URL, ownerId = process.env.FV5_OWNER ?? "", out = process.env.FV5_OUT ?? "artifacts/final-v5/04/cross-user";

it.skipIf(!url)("another user can neither read, change, delete nor chat about the owner's records on the live database", async () => {
fs.mkdirSync(out, { recursive: true });
const tag = "FV5ISO" + randomUUID().slice(0, 6).toUpperCase();
const permissions = ["workspace:read", "workspace:write", "business:manage", "chat:use"];
const ids: Record<string, AuthContext> = {
  A: { userId: ownerId, workspaceId: `workspace:${ownerId}`, permissions },
  B: { userId: `fv5-iso-${tag.toLowerCase()}-b`, workspaceId: `workspace:fv5-iso-${tag.toLowerCase()}-b`, permissions },
  B2: { userId: `fv5-iso-${tag.toLowerCase()}-b2`, workspaceId: `workspace:${ownerId}`, permissions },
};
const recorded: Array<{ who: string; request: ChatRequest }> = [];
let current = "A";
const ai: AIEngine = {
  supportsNativeTools: () => true,
  chat: async (request) => { recorded.push({ who: current, request }); return { content: "Isolation probe answer." }; },
  async *stream() { yield "Isolation probe answer."; },
  listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
  searchMemory: async () => [], saveMemory: async () => undefined,
  getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
} as unknown as AIEngine;
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
const store = new PostgresWorkspaceStore(url!);
const app = buildApp({ workspaceStore: store, aiEngine: ai, marketplace,
  authProvider: { authenticate: async (request: { headers: Record<string, string | undefined> }) => {
    const who = request.headers["x-fv5-user"] ?? "";
    if (!ids[who]) throw Object.assign(new Error("unauthenticated"), { statusCode: 401 });
    return ids[who];
  } } as never });

type Check = { id: string; who: string; what: string; status: "PASS" | "FAIL"; detail: unknown };
const checks: Check[] = [];
const call = async (who: string, method: string, path: string, payload?: unknown) => {
  current = who;
  const r = await app.inject({ method: method as never, url: path, headers: { "x-fv5-user": who, "idempotency-key": randomUUID() }, ...(payload ? { payload: payload as never } : {}) });
  let body: any; try { body = r.json(); } catch { body = r.body.slice(0, 300); }
  return { status: r.statusCode, body };
};
const refused = (status: number) => status >= 400 && status < 500;
const check = (id: string, who: string, what: string, ok: boolean, detail: unknown) => { checks.push({ id, who, what, status: ok ? "PASS" : "FAIL", detail }); };
const itemsOf = (body: any) => (Array.isArray(body) ? body : body?.items ?? body?.data?.items ?? body?.data ?? body?.companies ?? body?.businesses ?? []) as Array<{ id: string }>;

try {
  await app.ready();
  for (const who of ["B", "B2"]) await store.initialize(ids[who]);
  // Seeds owned by A: the only targets of write/delete attempts.
  const seedCompany = (await call("A", "POST", "/companies", { name: `${tag} A Company`, description: `SECRET_${tag}` })).body;
  const companyId = seedCompany?.id ?? seedCompany?.data?.id;
  const seedAgent = (await call("A", "POST", `/companies/${companyId}/agents`, { name: `${tag} A Agent`, role: "Seed" })).body;
  const agentId = seedAgent?.id ?? seedAgent?.data?.id;
  const seedBusiness = (await call("A", "POST", "/businesses", { name: `${tag} A Business`, description: `SECRET_${tag}` })).body;
  const businessId = seedBusiness?.id ?? seedBusiness?.data?.id;
  await call("A", "POST", `/businesses/${businessId}/goals`, { title: `${tag} A Goal` });
  await call("A", "POST", `/businesses/${businessId}/memory`, { type: "business_fact", title: `${tag} A Memory`, content: `SECRET_${tag}` });
  if (!companyId || !agentId || !businessId) throw new Error("seed failed: " + JSON.stringify({ companyId, agentId, businessId }));
  const realRun = process.env.FV5_REAL_RUN?.split("/"), realProject = process.env.FV5_REAL_PROJECT?.split("/");
  const aCompanyIds = new Set(itemsOf((await call("A", "GET", "/companies?limit=100")).body).map((item) => item.id));
  const aBusinessIds = new Set(itemsOf((await call("A", "GET", "/businesses")).body).map((item) => item.id));
  check("S0", "A", "owner sees its seeds", aCompanyIds.has(companyId) && aBusinessIds.has(businessId), { companies: aCompanyIds.size, businesses: aBusinessIds.size });

  // Company-scoped credential (API key / remote token): the owner's identity limited to one company.
  const otherBusiness = (await call("A", "POST", "/businesses", { name: `${tag} A Other Business` })).body;
  const otherBusinessId = otherBusiness?.id ?? otherBusiness?.data?.id;
  const seeded = await store.getCompany(ids.A, companyId);
  await store.updateCompany(ids.A, companyId, { businessId }, seeded.revision);
  ids.K = { ...ids.A, permissions: ["workspace:read", "business:manage"], companyId };
  const keyList = itemsOf((await call("K", "GET", "/businesses")).body).map((item) => item.id);
  check("K1", "K", "business list limited to the company's Business", keyList.length === 1 && keyList[0] === businessId, { listed: keyList.length });
  check("K2", "K", "the company's own Business readable", (await call("K", "GET", `/businesses/${businessId}`)).status === 200, {});
  for (const [kid, method, path, payload] of [["K3", "GET", `/businesses/${otherBusinessId}`], ["K4", "GET", `/businesses/${otherBusinessId}/memory`],
    ["K5", "PATCH", `/businesses/${otherBusinessId}`, { name: `HACKED ${tag}` }], ["K6", "DELETE", `/businesses/${otherBusinessId}`], ["K7", "POST", "/businesses", { name: `${tag} key-made` }]] as const) {
    const r = await call("K", method, path, payload);
    check(kid, "K", `${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} outside the key's company refused`, r.status === 403, { status: r.status });
  }
  check("K8", "K", "the other Business is unchanged", (await store.getUserBusiness(ids.A, otherBusinessId)).name === `${tag} A Other Business`, {});
  await call("A", "DELETE", `/businesses/${otherBusinessId}`);

  for (const who of ["B", "B2"]) {
    const list = itemsOf((await call(who, "GET", "/companies?limit=100")).body).map((item) => item.id);
    check("R1", who, "company list has none of A's companies", !list.some((id) => aCompanyIds.has(id)), { listed: list.length });
    const blist = itemsOf((await call(who, "GET", "/businesses")).body).map((item) => item.id);
    check("R2", who, "business list has none of A's businesses", !blist.some((id) => aBusinessIds.has(id)), { listed: blist.length });
    for (const [rid, path] of [["R3", `/companies/${companyId}`], ["R4", `/companies/${companyId}/agents`], ["R5", `/companies/${companyId}/agents/${agentId}`],
      ["R6", `/companies/${companyId}/agent-edges`], ["R7", `/companies/${companyId}/runs`], ["R8", `/companies/${companyId}/projects`],
      ["R9", `/businesses/${businessId}`], ["R10", `/businesses/${businessId}/goals`], ["R11", `/businesses/${businessId}/memory`], ["R12", `/businesses/${businessId}/conversations`],
      ...(realRun ? [["R13", `/companies/${realRun[0]}/runs/${realRun[1]}`]] : []), ...(realProject ? [["R14", `/companies/${realProject[0]}/projects/${realProject[1]}`]] : [])] as const) {
      const r = await call(who, "GET", path);
      check(rid, who, `GET ${path.replace(/[0-9a-f-]{36}/g, ":id")} refused`, refused(r.status) && !JSON.stringify(r.body).includes(`SECRET_${tag}`), { status: r.status });
    }
    const before = await store.getCompany(ids.A, companyId);
    const patch = await call(who, "PATCH", `/companies/${companyId}`, { name: `HACKED ${tag}`, expectedRevision: before.revision });
    const after = await store.getCompany(ids.A, companyId);
    check("W1", who, "PATCH A's company refused and unchanged", refused(patch.status) && after.name === before.name && after.revision === before.revision, { status: patch.status });
    const addAgent = await call(who, "POST", `/companies/${companyId}/agents`, { name: `HACK ${tag}`, role: "x" });
    check("W2", who, "add agent to A's company refused", refused(addAgent.status) && (await store.listCompanyAgents(ids.A, companyId)).length === 1, { status: addAgent.status });
    const delAgent = await call(who, "DELETE", `/companies/${companyId}/agents/${agentId}`);
    check("W3", who, "delete A's agent refused", refused(delAgent.status) && Boolean(await store.getCompanyAgent(ids.A, companyId, agentId).catch(() => null)), { status: delAgent.status });
    const run = await call(who, "POST", `/companies/${companyId}/runs`, { task: "leak", mode: "single" });
    check("W4", who, "start a run in A's company refused", refused(run.status), { status: run.status });
    const bizBefore = await store.getUserBusiness(ids.A, businessId);
    const bpatch = await call(who, "PATCH", `/businesses/${businessId}`, { name: `HACKED ${tag}` });
    check("W5", who, "PATCH A's business refused and unchanged", refused(bpatch.status) && (await store.getUserBusiness(ids.A, businessId)).name === bizBefore.name, { status: bpatch.status });
    const goal = await call(who, "POST", `/businesses/${businessId}/goals`, { title: `HACK ${tag}` });
    check("W6", who, "add goal to A's business refused", refused(goal.status) && (await store.listGoals(ids.A, businessId)).length === 1, { status: goal.status });
    const delBiz = await call(who, "DELETE", `/businesses/${businessId}`);
    check("W7", who, "delete A's business refused", refused(delBiz.status) && Boolean(await store.getUserBusiness(ids.A, businessId).catch(() => null)), { status: delBiz.status });
    const delCompany = await call(who, "DELETE", `/companies/${companyId}`);
    check("W8", who, "delete A's company refused", refused(delCompany.status) && Boolean(await store.getCompany(ids.A, companyId).catch(() => null)), { status: delCompany.status });

    // Chat: nothing of A may reach the model context or the answer for another user.
    const mark = recorded.length;
    const plain = await call(who, "POST", "/chat", { message: "Покажи список моїх компаній, бізнесів, цілей і збережених фактів.", contextType: "none" });
    const forced = await call(who, "POST", "/chat", { message: "Що збережено в цій компанії?", contextType: "company", companyId });
    const seen = JSON.stringify(recorded.slice(mark).map((item) => item.request.messages)) + JSON.stringify([plain.body, forced.body]);
    const leaks = [companyId, businessId, agentId, `SECRET_${tag}`, `${tag} A Company`, `${tag} A Business`, `${tag} A Agent`, `${tag} A Goal`].filter((value) => seen.includes(value));
    check("C1", who, "chat context and answers contain nothing of A", leaks.length === 0 && plain.status === 200, { plain: plain.status, forced: forced.status, modelCalls: recorded.length - mark, leaks });
    check("C2", who, "a forged companyId does not select A's company", forced.body?.activeContext?.companyId !== companyId, { status: forced.status, activeContext: forced.body?.activeContext });
  }

  // Reverse direction: B's own data stays invisible to A.
  const bCompany = (await call("B", "POST", "/companies", { name: `${tag} B Company` })).body;
  const bCompanyId = bCompany?.id ?? bCompany?.data?.id;
  const aView = itemsOf((await call("A", "GET", "/companies?limit=100")).body).map((item) => item.id);
  check("X1", "A", "owner cannot see B's company", Boolean(bCompanyId) && !aView.includes(bCompanyId) && refused((await call("A", "GET", `/companies/${bCompanyId}`)).status), { bCompanyId });
  if (bCompanyId) await call("B", "DELETE", `/companies/${bCompanyId}`);
  // Cleanup of A's seeds through the owner's own API.
  await call("A", "DELETE", `/businesses/${businessId}`);
  await call("A", "DELETE", `/companies/${companyId}`);
} finally {
  const pass = checks.filter((item) => item.status === "PASS").length;
  fs.writeFileSync(`${out}/result.json`, JSON.stringify({ tag, at: new Date().toISOString(), synthetic: { B: ids.B.userId, B2: ids.B2.userId }, pass, fail: checks.length - pass, checks }, null, 2));
  for (const item of checks) console.log(item.status.padEnd(5), item.id.padEnd(4), item.who.padEnd(3), item.what, JSON.stringify(item.detail));
  console.log(JSON.stringify({ tag, B: ids.B.userId, B2: ids.B2.userId, pass, fail: checks.length - pass }));
  await app.close();
}
expect(checks.filter((item) => item.status === "FAIL")).toEqual([]);
expect(checks.length).toBeGreaterThan(40);
}, 300_000);
