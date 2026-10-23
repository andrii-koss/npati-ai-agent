/** Real dev DB -> Next.js in the shared sandbox; no AI calls. Uses normal sign-in. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
const api = process.env.NPATI_API_URL ?? "http://127.0.0.1:13001";
const out = process.env.NPATI_PROJECT_API_E2E_OUT ?? "artifacts/project-api-control-20261023";
const cookieFile = process.env.NPATI_E2E_SESSION_COOKIE_FILE ?? "artifacts/step9-local/e2e-session-cookie.txt";
mkdirSync(out, { recursive: true });
const stateFile = out + "/deterministic-state.json";
const state = process.argv.includes("--resume") && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { marker: "NPATI_CONTROL_" + randomUUID().slice(0, 8) };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
const report = { status: "FAIL", llmCalls: 0, inputTokens: 0, outputTokens: 0, modelToolCalls: 0, httpCalls: 0, steps: [] };
let token, page, browser, pathBroken = false;
async function login() {
  const cookie = readFileSync(cookieFile, "utf8").trim().replace(/^npati_agent_session=/, "");
  const r = await fetch(api + "/api/auth/installation/session", { method: "POST", headers: { cookie: "npati_agent_session=" + cookie } });
  const body = await r.json(); assert.equal(r.status, 200, "Normal session renewal failed");
  token = body.data.accessToken; assert(token);
}
async function http(method, path, body) {
  report.httpCalls++;
  const r = await fetch(api + path, { method, headers: { authorization: "Bearer " + token, "idempotency-key": randomUUID(),
    ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(240000) });
  const text = await r.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
  if (!r.ok) throw new Error(method + " " + path + " -> HTTP " + r.status + " " + (value?.error?.code ?? ""));
  return value;
}
async function step(name, run) {
  const start = Date.now();
  try {
    const evidence = await run();
    const item = { name, status: "PASS", ms: Date.now() - start, evidence };
    report.steps.push(item); console.log(JSON.stringify(item)); return evidence;
  } catch (e) {
    report.steps.push({ name, status: "FAIL", ms: Date.now() - start, error: String(e.message).slice(0, 240) }); throw e;
  }
}
const projectPath = () => "/companies/" + state.companyId + "/projects/" + state.projectId;
const studioPath = () => projectPath() + "/data-studio/dev";
async function write(path, content) {
  let existing;
  try { existing = await http("GET", projectPath() + "/files/read?path=" + encodeURIComponent(path)); } catch { /* new file */ }
  return http("POST", projectPath() + "/files/write", { path, content, ...(existing ? { expectedRevision: existing.revision } : {}) });
}
async function catalog(visibleTitle, failure = false) {
  const response = await page.goto(state.previewUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByTestId(failure ? "api-error" : "product").first().waitFor({ timeout: 15000 });
  const products = await page.getByTestId("product").allTextContents();
  const errors = await page.getByTestId("api-error").allTextContents();
  if (failure) { assert.equal(products.length, 0); assert(errors.some(e => e.includes("PROJECT_API_UNAVAILABLE"))); }
  else { assert(products.some(p => p.includes(visibleTitle))); assert.equal(errors.length, 0); }
  return { httpStatus: response.status(), products, errors };
}
try {
  await login();
  await step("create-test-project-and-backend", async () => {
    if (!state.companyId) { const c = await http("POST", "/companies", { name: "Project API deterministic " + state.marker }); state.companyId = c.id ?? c.company.id; save(); }
    if (!state.projectId) { const p = await http("POST", "/companies/" + state.companyId + "/projects", { name: "Next.js API " + state.marker, type: "code_project", description: "Disposable Next.js Project API acceptance project" }); state.projectId = p.id; save(); }
    if (!state.backendId) { const b = await http("POST", "/companies/" + state.companyId + "/data-backends", { name: "Dev data " + state.marker }); state.backendId = b.id ?? b.backend.id; save(); }
    await http("PUT", projectPath() + "/data-backend", { dataBackendId: state.backendId });
    return { companyId: state.companyId, projectId: state.projectId, backendId: state.backendId, environment: "dev" };
  });
  await step("create-products-and-unique-row", async () => {
    const schema = await http("GET", studioPath());
    if (!schema.schema?.tables?.some(t => t.name === "products")) await http("POST", studioPath() + "/schema/apply", {
      expectedFingerprint: schema.environment.schemaFingerprint,
      operation: { kind: "create_collection", collection: "products", fields: [{ name: "title", type: "string", required: true }, { name: "price", type: "decimal", required: true }] },
    });
    await http("PUT", studioPath() + "/auth/policies", { policies: [{ collection: "products", rule: "public", actions: ["select"] }] });
    if (!state.rowId) {
      const { row } = await http("POST", studioPath() + "/collections/products/rows", { row: { title: state.marker, price: 123.45 } });
      state.rowId = row.id; save();
    } else await http("PATCH", studioPath() + "/collections/products/rows/" + state.rowId, { row: { title: state.marker, price: 123.45 } });
    const keys = await http("GET", studioPath() + "/api/keys");
    const key = keys.publishableKey;
    assert(/^npati_pk_dev_/.test(key));
    const valid = await fetch(api + "/v1/projects/" + state.projectId + "/data/products", { headers: { "x-project-key": key } });
    assert.equal(valid.status, 200);
    const rows = await valid.json(); assert(rows.data.some(row => row.id === state.rowId && row.title === state.marker));
    const invalid = await fetch(api + "/v1/projects/" + state.projectId + "/data/products", { headers: { "x-project-key": "npati_pk_dev_" + "0".repeat(32) } });
    assert.equal(invalid.status, 401);
    return { rowId: state.rowId, marker: state.marker, directGatewayStatus: valid.status, invalidKeyStatus: invalid.status, publicPolicy: "products SELECT only" };
  });
  await step("create-nextjs-site", async () => {
    const profile = JSON.parse(readFileSync("apps/agent-api/project-runtime-profiles.json", "utf8")).next;
    const files = {
      "package.json": JSON.stringify({ name: "npati-project-api-e2e", private: true, scripts: { dev: "next dev --hostname 0.0.0.0 --port 3000", build: "next build" }, ...profile }, null, 2),
      "next.config.js": "module.exports = { experimental: { cpus: 1 } };\n",
      "api-path.json": JSON.stringify({ collection: "products" }),
      "app/layout.jsx": 'export default function Layout({children}) { return <html lang="en"><body>{children}</body></html>; }\n',
      "lib/products.js": [
        'import { readFileSync } from "node:fs";',
        'export async function products() {',
        '  const { collection } = JSON.parse(readFileSync("api-path.json", "utf8"));',
        '  const response = await fetch(process.env.PROJECT_API_URL + "/data/" + encodeURIComponent(collection),',
        '    { headers: { "x-project-key": process.env.PROJECT_PUBLISHABLE_KEY }, cache: "no-store", signal: AbortSignal.timeout(10000) });',
        '  if (!response.ok) throw new Error("PROJECT_API_HTTP_" + response.status);',
        '  const body = await response.json(); if (!Array.isArray(body.data)) throw new Error("PROJECT_API_INVALID_RESPONSE");',
        '  return body.data;',
        '}',
      ].join("\n"),
      "app/page.jsx": [
        'import { products } from "../lib/products";',
        'export const dynamic = "force-dynamic"; export const revalidate = 0;',
        'export default async function Page() {',
        '  try { const rows = await products(); return <main><h1>Live database catalog</h1>{rows.map(row => <article data-testid="product" key={row.id}>{row.title}: {row.price}</article>)}</main>; }',
        '  catch { return <main><h1>Catalog unavailable</h1><p data-testid="api-error">PROJECT_API_UNAVAILABLE</p></main>; }',
        '}',
      ].join("\n"),
      "app/api/products/route.js": [
        'import { products } from "../../../lib/products";',
        'export const dynamic = "force-dynamic";',
        'export async function GET() { try { return Response.json({ data: await products() }); }',
        '  catch { return Response.json({ error: { code: "PROJECT_API_UNAVAILABLE" } }, { status: 503 }); } }',
      ].join("\n"),
    };
    for (const [path, content] of Object.entries(files)) await write(path, content);
    const preview = await http("POST", projectPath() + "/preview/start", {});
    const { token: previewToken } = await http("GET", projectPath() + "/preview/token");
    // Never save signed Preview URLs or authentication material.
    state.previewUrl = api + projectPath() + "/preview/proxy/?token=" + encodeURIComponent(previewToken);
    return { framework: preview.framework ?? "Next.js", status: preview.status, usesRuntimeEnvironment: true, staticFallbackProducts: false };
  });
  browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
  const context = await browser.newContext({ extraHTTPHeaders: { authorization: "Bearer " + token } });
  await context.route("**/*", route => new URL(route.request().url()).origin === new URL(api).origin ? route.continue() : route.abort());
  page = await context.newPage();
  await step("unique-row-is-visible-in-real-browser", () => catalog(state.marker));
  await step("database-update-is-visible-without-static-fallback", async () => {
    await http("PATCH", studioPath() + "/collections/products/rows/" + state.rowId, { row: { title: state.marker + "_UPDATED", price: 987.65 } });
    const visible = await catalog(state.marker + "_UPDATED");
    assert(!visible.products.some(p => p.includes(": 123.45")));
    return visible;
  });
  await step("break-only-test-api-path", async () => {
    pathBroken = true;
    await write("api-path.json", JSON.stringify({ collection: "outage_only_test_collection" }));
    await http("POST", projectPath() + "/preview/start", {}); // existing refresh synchronizes the canonical workspace
    const visible = await catalog("", true);
    const r = await page.request.get(state.previewUrl.replace("/preview/proxy/?", "/preview/proxy/api/products?"));
    assert.equal(r.status(), 503);
    return { ...visible, dataRouteStatus: r.status(), altered: "only this project's api-path.json", sharedApiStopped: false, sharedDatabaseStopped: false };
  });
  await step("restore-path-and-recheck-real-row", async () => {
    await write("api-path.json", JSON.stringify({ collection: "products" }));
    await http("POST", projectPath() + "/preview/start", {});
    pathBroken = false;
    const visible = await catalog(state.marker + "_UPDATED");
    const r = await page.request.get(state.previewUrl.replace("/preview/proxy/?", "/preview/proxy/api/products?"));
    assert.equal(r.status(), 200);
    const data = await r.json(); assert(data.data.some(row => row.id === state.rowId && row.title === state.marker + "_UPDATED"));
    return { ...visible, dataRouteStatus: r.status(), rowId: state.rowId };
  });
  report.status = "PASS";
} catch (error) {
  report.error = String(error.message).slice(0, 400);
  process.exitCode = 1;
} finally {
  if (pathBroken) await write("api-path.json", JSON.stringify({ collection: "products" })).then(() => http("POST", projectPath() + "/preview/start", {})).catch(() => undefined);
  if (browser) await browser.close();
  delete state.previewUrl; save();
  report.totalMs = report.steps.reduce((sum, step) => sum + step.ms, 0);
  report.projectId = state.projectId; report.companyId = state.companyId; report.marker = state.marker;
  writeFileSync(out + "/deterministic-e2e.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, totalMs: report.totalMs, llmCalls: 0, error: report.error ?? null }));
}
