#!/usr/bin/env node
/**
 * Live measurement of the six Coding Agent chat scenarios against a running local stack.
 *
 *   NPATI_E2E_TOKEN_FILE=<file with a legitimately issued access token> \
 *   node scripts/measure-coding-scenarios.mjs --phase baseline --model deepseek/deepseek-flash --out <dir> [--reference <png>]
 *
 * - Authentication: only a token issued through the normal sign-in flow, read from a file. It is never printed or
 *   written to the output. No token is minted here.
 * - Isolation: every invocation creates its own Company; scenarios 1-6 run in one conversation of that Company.
 * - The default model is switched with PUT /ai/models/default and restored afterwards.
 * - Metrics come from SSE timing (client side) and from Activity / replay / migration rows read with SELECT only
 *   (`docker exec <postgres> psql`, read-only transaction).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const api = process.env.NPATI_API_URL ?? "http://127.0.0.1:13001";
const tokenFile = process.env.NPATI_E2E_TOKEN_FILE;
const sessionCookieFile = process.env.NPATI_E2E_SESSION_COOKIE_FILE;
if (!tokenFile && !sessionCookieFile) throw new Error("NPATI_E2E_TOKEN_FILE or NPATI_E2E_SESSION_COOKIE_FILE is required (from the normal sign-in flow)");
const stripBearer = (value) => value.trim().replace(/^bearer\s+/i, "");
let token = tokenFile ? stripBearer(readFileSync(tokenFile, "utf8")) : "";
let tokenRenewedAt = 0;
/**
 * Access tokens of an installation session live 15 minutes. A long measurement renews them exactly the way the web UI
 * does: POST /api/auth/installation/session with the browser's `npati_agent_session` cookie (from the normal sign-in).
 */
async function renewToken(force = false) {
  if (!sessionCookieFile || (!force && Date.now() - tokenRenewedAt < 10 * 60_000)) return;
  const cookie = readFileSync(sessionCookieFile, "utf8").trim().replace(/^npati_agent_session=/, "");
  const response = await fetch(api + "/api/auth/installation/session", { method: "POST", headers: { cookie: "npati_agent_session=" + cookie } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data?.accessToken) throw new Error("Session renewal failed: HTTP " + response.status + " " + (payload?.error?.code ?? ""));
  token = payload.data.accessToken;
  tokenRenewedAt = Date.now();
}
const pg = process.env.NPATI_MEASURE_PG_CONTAINER ?? "npati-isolated-source-20261011-postgres-1";
const phase = args.phase ?? "baseline";
const model = args.model ?? "deepseek/deepseek-flash";
const outDir = args.out ?? path.resolve("artifacts", "measure");
const only = args.only ? new Set(args.only.split(",")) : null;
const scenarioTimeoutMs = Number(args.timeout ?? 900_000);
mkdirSync(outDir, { recursive: true });

const WRITE_TOOLS = /^code\.(fs\.(write|edit|apply_patch|move|delete)|deps\.add|data\.(schema\.(apply|modify)|rows\.(seed|transfer)|policies\.apply|backend\.(create|attach)))$/;
const redact = (value) => JSON.parse(JSON.stringify(value ?? null, (key, item) => (/token|authorization|secret/i.test(key) ? "[redacted]" : typeof item === "string" ? item.replace(/([?&]token=)[^&\s"]+/g, "$1REDACTED") : item)));

async function http(method, url, body) {
  await renewToken();
  const response = await fetch(api + url, {
    method,
    headers: { authorization: "Bearer " + token, ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!response.ok) throw Object.assign(new Error(`${method} ${url} -> ${response.status}: ${String(text).slice(0, 300)}`), { status: response.status });
  return json;
}

/** Read-only SQL; returns parsed JSON of the single value selected. */
function sql(query) {
  const script = `BEGIN TRANSACTION READ ONLY;\n\\pset tuples_only on\n\\pset format unaligned\nSELECT coalesce((${query})::text, 'null');\nROLLBACK;\n`;
  const output = execFileSync("docker", ["exec", "-i", pg, "sh", "-c", 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f -'], { input: script, encoding: "utf8" });
  const line = output.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry && !/^(BEGIN|ROLLBACK|Tuples only|Output format)/.test(entry)).at(-1);
  return JSON.parse(line ?? "null");
}
const dbNow = () => Date.parse(sql("select to_json(now())"));

async function chat(message, extra) {
  const started = Date.now();
  const events = [];
  let result = null; let error = null;
  await renewToken();
  const response = await fetch(api + "/chat/stream", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ streamId: crypto.randomUUID(), message, ...extra }),
    signal: AbortSignal.timeout(scenarioTimeoutMs),
  });
  if (!response.ok) throw new Error("chat HTTP " + response.status + ": " + (await response.text()).slice(0, 300));
  let pending = ""; const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = pending.indexOf("\n\n")) >= 0) {
      const frame = pending.slice(0, index); pending = pending.slice(index + 2);
      let event = "message"; let data = "";
      for (const line of frame.split("\n")) { if (line.startsWith("event:")) event = line.slice(6).trim(); if (line.startsWith("data:")) data += line.slice(5).trim(); }
      if (!data) continue;
      let payload; try { payload = JSON.parse(data); } catch { payload = data; }
      events.push({ atMs: Date.now() - started, event, payload: redact(payload) });
      if (event === "result") result = payload; if (event === "error") error = payload;
    }
  }
  return { started, sseMs: Date.now() - started, events, result: redact(result), error: redact(error) };
}

/**
 * Background runs continue after the stream closes, and a run with a reference image creates its state row only after
 * the image analysis: wait until no run of the Company is active and the Company stayed quiet for 30 s.
 */
let approvedSampleData = 0;
let declinedApprovals = 0;
let approving = false;
async function approveSampleDataOnce(companyId) {
  if (approving) return;
  approving = true;
  try {
    // An attentive user: approves sample-data inserts, declines everything else (e.g. shell commands) so no run waits
    // for a decision that never comes.
    const pending = sql(`select json_agg(json_build_object('id',id,'tool',tool_name)) from company_approvals where company_id='${companyId}' and status='pending'`) ?? [];
    for (const item of pending) {
      const approve = item.tool === "code.data.rows.seed";
      await http("POST", `/companies/${companyId}/approvals/${item.id}/decide`, { decision: approve ? "approved" : "rejected", notes: approve ? "E2E user approval" : "E2E user declined" }).catch(() => undefined);
      if (approve) approvedSampleData += 1; else declinedApprovals += 1;
    }
  } finally { approving = false; }
}
async function waitForRuns(companyId, approveSampleData = false) {
  const deadline = Date.now() + scenarioTimeoutMs;
  let quietSince = 0;
  while (Date.now() < deadline) {
    // The storefront user approves sample-data inserts in the approval dialog while the run waits; nothing else.
    if (approveSampleData) await approveSampleDataOnce(companyId);
    const running = sql(`select count(*) from code_run_states where company_id='${companyId}' and status in ('running','waiting_for_user')`);
    if (running === 0) { if (!quietSince) quietSince = Date.now(); if (Date.now() - quietSince > 30_000) return true; } else quietSince = 0;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

function collect(companyId, sinceIso, untilIso) {
  const runs = sql(`select json_agg(json_build_object('runId',run_id,'status',status,'stopReason',details->>'stopReason','startedAt',started_at,'finishedAt',finished_at,'turns',details->'estimate'->'turns','tokens',details->'estimate'->'tokenCount') order by started_at) from code_run_states where company_id='${companyId}' and started_at >= '${sinceIso}'`) ?? [];
  const events = sql(`select json_agg(json_build_object('at',created_at,'kind',kind,'p',payload) order by created_at) from code_activity_events where company_id='${companyId}' and created_at >= '${sinceIso}' and created_at <= '${untilIso}'`) ?? [];
  const calls = sql(`select json_agg(tc) from code_replay_bundles b join code_replay_bundle_steps s on s.bundle_id=b.id and s.kind='model_step', jsonb_array_elements(s.payload->'response'->'toolCalls') tc where b.company_id='${companyId}' and s.created_at >= '${sinceIso}' and s.created_at <= '${untilIso}'`) ?? [];
  const runActivity = events.filter((event) => event.kind === "run_activity");
  const modelCalls = runActivity.filter((event) => event.p.eventType === "model_call" && event.p.phase === "completed" && !("attempt" in event.p));
  const toolCalls = runActivity.filter((event) => event.p.eventType === "tool_call");
  const firstTool = toolCalls.map((event) => Date.parse(event.at) - (Number(event.p.durationMs) || 0)).sort((a, b) => a - b)[0] ?? null;
  const writeCalls = toolCalls.filter((event) => WRITE_TOOLS.test(String(event.p.tool)));
  const files = new Set();
  for (const call of calls) {
    if (!WRITE_TOOLS.test(call.name) || !call.name.startsWith("code.fs.")) continue;
    let parsed = {}; try { parsed = JSON.parse(call.arguments); } catch { /* truncated arguments */ }
    for (const key of ["path", "from", "to"]) if (typeof parsed[key] === "string") files.add(parsed[key]);
    if (typeof parsed.patch === "string") for (const match of parsed.patch.matchAll(/^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ b\/)(.+)$/gm)) files.add(match[1].trim());
  }
  const reads = calls.filter((call) => call.name === "code.fs.read").map((call) => { try { return JSON.parse(call.arguments).path ?? ""; } catch { return ""; } });
  const sumBy = (items, key) => Object.fromEntries([...items.reduce((map, event) => map.set(key(event), (map.get(key(event)) ?? 0) + (Number(event.p.durationMs) || 0)), new Map())]);
  return {
    modelMs: modelCalls.reduce((sum, event) => sum + (Number(event.p.durationMs) || 0), 0),
    toolMs: toolCalls.reduce((sum, event) => sum + (Number(event.p.durationMs) || 0), 0),
    toolMsByName: sumBy(toolCalls, (event) => event.p.tool),
    repeatedReads: reads.length - new Set(reads).size,
    runs, tokens: runs.reduce((sum, run) => sum + (Number(run.tokens) || 0), 0),
    visualRepairs: runs.filter((run) => String(run.runId).includes(":visual-repair:")).length,
    screenshots: toolCalls.filter((event) => event.p.tool === "code.preview.screenshot").length,
    modelCalls: modelCalls.length, selfReviewCalls: modelCalls.filter((event) => event.p.modelPurpose === "self_review").length,
    toolCalls: toolCalls.length, writeCalls: writeCalls.length, failedToolCalls: toolCalls.filter((event) => event.p.ok === false).length,
    toolsByName: Object.fromEntries([...toolCalls.reduce((map, event) => map.set(event.p.tool, (map.get(event.p.tool) ?? 0) + 1), new Map())]),
    firstToolAtMs: firstTool, changedFiles: [...files].sort(),
    reminders: runActivity.filter((event) => event.p.eventType === "reminder").map((event) => event.p.reason),
    visibility: runActivity.filter((event) => event.p.eventType === "tool_visibility").map((event) => ({ offered: event.p.offeredCount, catalog: event.p.catalogCount })),
  };
}

const SCENARIOS = [
  { id: "s1-create", message: "Створи новий сайт кав'ярні «Ранок» на Next.js: головна сторінка з героєм, коротким меню з трьох напоїв, контактами і кнопкою «Замовити». Без бази даних." },
  { id: "s2-color", message: "Зміни колір кнопки «Замовити» на зелений #16a34a. Більше нічого не змінюй." },
  { id: "s3-photo", message: "Ось фото дизайну. Зроби дизайн цього сайту таким, як на фото: темна навігація, великий заголовок у героїні, помаранчева кнопка, три картки внизу.", attach: true },
  { id: "s4-analyze", message: "Проаналізуй зовнішній сайт https://example.com і коротко скажи, що в ньому можна покращити. Нічого не змінюй у моєму проєкті." },
  { id: "s5-table", message: "Створи в базі даних цього проєкту таблицю orders з полями customer_name (текст), total (число) і status (текст)." },
  { id: "s6-page", message: "Додай у цей Next.js сайт нову сторінку /about із заголовком «Про нас» і коротким описом кав'ярні, та посилання на неї в навігації." },
];

/**
 * Every model request of the window as OmniRoute logged it (chat routing, planning, research synthesis, Coding Agent,
 * vision review): `[USAGE] PROVIDER | in=N | out=N` and `[STREAM] PROVIDER | model | Nms`. Read-only `docker logs`.
 */
function omnirouteUsage(sinceIso, untilIso) {
  let text = "";
  try { text = execFileSync("docker", ["logs", "--since", sinceIso, "--until", untilIso, process.env.NPATI_MEASURE_OMNIROUTE_CONTAINER ?? "npati-isolated-source-20261011-omniroute-1"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }); } catch (error) { text = String(error.stdout ?? "") + String(error.stderr ?? ""); }
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const usage = [...clean.matchAll(/\[USAGE\] (\S+) \| in=(\d+) \| out=(\d+)/g)].map((m) => ({ provider: m[1], input: Number(m[2]), output: Number(m[3]) }));
  const streams = [...clean.matchAll(/\[(?:STREAM|NON-STREAM|REQUEST)\] \S+ \| ([^|]+) \| (\d+)ms/g)].map((m) => ({ model: m[1].trim(), ms: Number(m[2]) }));
  return { llmRequests: usage.length, inputTokens: usage.reduce((s, u) => s + u.input, 0), outputTokens: usage.reduce((s, u) => s + u.output, 0), llmMs: streams.reduce((s, x) => s + x.ms, 0), llmTimed: streams.length };
}

/** GETs a Preview page through the authenticated proxy; `{ status, html }`. */
async function previewPage(companyId, projectId, pagePath) {
  try {
    const { token } = await http("GET", `/companies/${companyId}/projects/${projectId}/preview/token`);
    const response = await fetch(`${api}/companies/${companyId}/projects/${projectId}/preview/proxy${pagePath === "/" ? "/" : pagePath}?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(60_000) });
    return { status: response.status, html: await response.text() };
  } catch (error) { return { status: 0, html: "", error: error.message }; }
}

async function projectFiles(companyId, projectId) {
  const tree = await http("GET", `/companies/${companyId}/projects/${projectId}/files/tree`).catch(() => []);
  return (Array.isArray(tree) ? tree : tree.entries ?? tree.files ?? []).map((entry) => entry.path ?? "").filter(Boolean);
}

const STOREFRONT = [
  { id: "f1-create", message: "Створи сучасний інтернет-магазин на Next.js із головною сторінкою, каталогом товарів і сторінкою контактів. Запусти Live Preview." },
  { id: "f2-research", message: "Знайди в інтернеті три інтернет-магазини з подібними товарами. Проаналізуй їхній дизайн і запропонуй покращення для мого сайту. Поки нічого не змінюй." },
  { id: "f3-database", message: "Створи для мого інтернет-магазину базу даних із таблицями products, categories та orders." },
  { id: "f3-retry", message: "Створи для мого інтернет-магазину базу даних із таблицями products, categories та orders." },
  { id: "f4-connect", message: "Підключи створену базу даних до мого Next.js-магазину. Зроби відображення товарів із бази." },
  // A user approves the pending sample-data writes in the UI and tells the agent to continue; only run when needed.
  { id: "f4-approve", message: "Підтверджую додавання товарів у базу. Продовжуй.", approvePending: true },
  { id: "f5-design", message: "Зміни дизайн мого магазину відповідно до прикріпленого референсного фото. Збережи функціональність сайту та підключення до бази.", attach: true },
  { id: "f6-recall", message: "Використай результати попереднього аналізу конкурентів і покращи головну сторінку магазину." },
];
const SECRET_IN_CLIENT = /(postgres(?:ql)?:\/\/[^\s"'`]+|service_role|sk_live_|npati_sk_[A-Za-z0-9]|SECRET_KEY\s*[:=]\s*["'`][^"'`]{8,})/i;

async function storefrontSuccess(id, companyId, projectId, metrics, outcome, state) {
  const run = outcome.result?.run;
  const status = run?.status ?? metrics.runs.at(-1)?.status ?? null;
  const progress = outcome.events.filter((event) => event.event === "progress").map((event) => event.payload?.type).filter(Boolean);
  const projects = sql(`select count(*) from projects where company_id='${companyId}'`);
  const migrations = projectId ? sql(`select json_agg(json_build_object('op',operation,'env',environment,'status',status,'sql',left(up_sql,4000)) order by created_at) from data_backend_migrations where backend_id=(select data_backend_id from projects where id='${projectId}')`) ?? [] : [];
  if (id === "f1-create") {
    const files = await projectFiles(companyId, projectId);
    const pages = { home: await previewPage(companyId, projectId, "/") };
    const catalogPath = files.find((file) => /^app\/(catalog|products|shop)\/page\.(t|j)sx?$/.test(file));
    const contactPath = files.find((file) => /^app\/(contacts?|kontakty)\/page\.(t|j)sx?$/.test(file));
    if (catalogPath) pages.catalog = await previewPage(companyId, projectId, "/" + catalogPath.split("/")[1]);
    if (contactPath) pages.contacts = await previewPage(companyId, projectId, "/" + contactPath.split("/")[1]);
    const qa = await http("POST", `/companies/${companyId}/projects/${projectId}/qa/inspect`, {}).catch((error) => ({ error: error.message }));
    const ok = projects === 1 && Boolean(catalogPath && contactPath) && Object.values(pages).every((page) => page.status === 200) && metrics.runs.some((r) => r.status === "completed");
    return { ok, status, projects, catalogPath, contactPath, pageStatus: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.status])), qaSuccess: qa?.success ?? qa?.report?.status ?? qa?.error ?? null };
  }
  if (id === "f2-research") {
    const sources = outcome.result?.research?.sources ?? [];
    const fetched = progress.filter((type) => type === "page_fetch_completed").length;
    const external = sources.filter((source) => /^https?:\/\//.test(source.url ?? "") && !/127\.0\.0\.1|localhost/.test(source.url));
    state.researchAnswer = String(outcome.result?.message ?? "");
    const newMigrations = migrations.length - (state.migrationCount ?? 0);
    return { ok: metrics.writeCalls === 0 && newMigrations === 0 && external.length >= 1 && fetched >= 1, status, sources: external.map((s) => s.url), pagesFetched: fetched, writeCalls: metrics.writeCalls, routed: outcome.result?.routed ?? "chat", degraded: outcome.result?.research?.degraded ?? null };
  }
  if (id === "f3-database" || id === "f3-retry") {
    const creates = migrations.filter((m) => /create/i.test(JSON.stringify(m.op)));
    const tableNames = creates.flatMap((m) => [...String(m.sql).matchAll(/create table (?:if not exists )?"?(?:\w+"?\.)?"?(\w+)"?/gi)].map((x) => x[1].toLowerCase()));
    const required = ["products", "categories", "orders"].every((table) => tableNames.some((name) => name === table || name.endsWith("_" + table)));
    const duplicates = tableNames.filter((name, index) => tableNames.indexOf(name) !== index);
    const overview = { dev: await http("GET", `/companies/${companyId}/projects/${projectId}/data-studio/dev`).catch((e) => ({ error: e.message })), prod: await http("GET", `/companies/${companyId}/projects/${projectId}/data-studio/prod`).catch((e) => ({ error: e.message })) };
    const collections = (o) => (o.collections ?? o.overview?.collections ?? []).map((c) => c.name ?? c.id ?? c);
    const relations = migrations.some((m) => /references/i.test(m.sql));
    return { ok: required && duplicates.length === 0, status, tables: [...new Set(tableNames)], duplicates, relations, environments: [...new Set(migrations.map((m) => m.env))], devCollections: collections(overview.dev), prodCollections: collections(overview.prod), migrations: migrations.length };
  }
  if (id === "f4-connect" || id === "f4-approve" || id === "f5-design") {
    const files = await projectFiles(companyId, projectId);
    const sources = await Promise.all(files.filter((file) => /\.(t|j)sx?$/.test(file) && !file.startsWith("node_modules/")).slice(0, 80).map(async (file) => {
      try { const r = await http("GET", `/companies/${companyId}/projects/${projectId}/files/read?path=${encodeURIComponent(file)}`); return { file, text: String(r.content ?? r.file?.content ?? "") }; } catch { return { file, text: "" }; }
    }));
    const clientLeaks = sources.filter((s) => /^\s*["']use client["']/m.test(s.text) && SECRET_IN_CLIENT.test(s.text)).map((s) => s.file);
    const dataAccess = sources.filter((s) => /data-studio|npati|fetch\(|process\.env\.[A-Z_]*(DATA|DB|API)/i.test(s.text) && /product/i.test(s.text)).map((s) => s.file);
    const rows = await http("POST", `/companies/${companyId}/projects/${projectId}/data-studio/dev/collections/products/rows/query`, { limit: 20 }).catch((e) => ({ error: e.message }));
    const names = (rows.rows ?? rows.items ?? []).map((row) => row.name ?? row.title).filter((v) => typeof v === "string" && v.length > 2);
    const catalog = files.find((file) => /^app\/(catalog|products|shop)\/page\.(t|j)sx?$/.test(file));
    const page = await previewPage(companyId, projectId, catalog ? "/" + catalog.split("/")[1] : "/");
    const shown = names.filter((name) => page.html.includes(name));
    const base = { status, clientLeaks, dataAccess, productRows: names.length, rowsShown: shown.length, pageStatus: page.status, projects };
    // Connecting is judged on the wiring; showing rows needs rows, which may wait for the user's approval (f4-approve).
    if (id === "f4-connect") return { ...base, ok: page.status === 200 && clientLeaks.length === 0 && dataAccess.length > 0 && (names.length === 0 || shown.length > 0), pendingApprovals: sql(`select count(*) from company_approvals where company_id='${companyId}' and status='pending'`) };
    if (id === "f4-approve") return { ...base, ok: page.status === 200 && clientLeaks.length === 0 && names.length > 0 && shown.length > 0, approved: state.approved ?? 0 };
    const root = metrics.runs.find((r) => !String(r.runId).includes(":visual-repair:"));
    return { ...base, ok: root?.status === "completed" && page.status === 200 && clientLeaks.length === 0 && (names.length === 0 || shown.length > 0), visualAcceptance: run?.visualAcceptance?.status ?? null, major: run?.visualAcceptance?.differences?.length ?? null };
  }
  if (id === "f6-recall") {
    const searched = progress.some((type) => /search|page_fetch/.test(type)) || Object.keys(metrics.toolsByName).some((name) => /^code\.web\./.test(name));
    const touchedHome = metrics.changedFiles.some((file) => /^app\/page\.(t|j)sx?$|(^|\/)(Hero|Home)[A-Za-z]*\.(t|j)sx?$/.test(file));
    return { ok: projects === 1 && !searched && touchedHome && metrics.runs.some((r) => r.status === "completed"), status, projects, searchedAgain: searched, changedFiles: metrics.changedFiles };
  }
  return { ok: false, status };
}

async function success(id, companyId, projectId, metrics, outcome, state = {}) {
  if (id.startsWith("f")) return storefrontSuccess(id, companyId, projectId, metrics, outcome, state);
  const run = outcome.result?.run;
  const status = run?.status ?? metrics.runs.at(-1)?.status ?? null;
  const read = async (file) => { try { const r = await http("GET", `/companies/${companyId}/projects/${projectId}/files/read?path=${encodeURIComponent(file)}`); return String(r.content ?? r.file?.content ?? ""); } catch { return ""; } };
  if (id === "s1-create") return { ok: Boolean(projectId) && metrics.runs.some((r) => r.status === "completed"), status };
  if (id === "s2-color") {
    const contents = await Promise.all(metrics.changedFiles.map(read));
    return { ok: contents.some((text) => /16a34a/i.test(text)), status, changedFiles: metrics.changedFiles.length };
  }
  if (id === "s3-photo") {
    // The root run (not a visual repair) carries the visual acceptance verdict: failed acceptance fails the root run.
    const root = metrics.runs.find((r) => !String(r.runId).includes(":visual-repair:"));
    return { ok: root?.status === "completed", status: root?.status ?? status, rootStopReason: root?.stopReason ?? null, visualAcceptance: run?.visualAcceptance?.status ?? null };
  }
  if (id === "s4-analyze") return { ok: metrics.writeCalls === 0 && metrics.changedFiles.length === 0, status, writeCalls: metrics.writeCalls };
  if (id === "s5-table") {
    const migrations = projectId ? sql(`select json_agg(operation::text) from data_backend_migrations where backend_id=(select data_backend_id from projects where id='${projectId}') and created_at >= '${outcome.sinceIso}'`) ?? [] : [];
    return { ok: migrations.some((op) => /orders/.test(op)), status, migrations: migrations.length };
  }
  if (id === "s6-page") {
    const tree = await http("GET", `/companies/${companyId}/projects/${projectId}/files/tree`).catch(() => []);
    const paths = (Array.isArray(tree) ? tree : tree.entries ?? tree.files ?? []).map((entry) => entry.path ?? "");
    return { ok: paths.some((file) => /(^|\/)about\/(page|index)\.(t|j)sx?$|(^|\/)about\.(t|j)sx?$|about\.html$/.test(file)), status };
  }
  return { ok: false, status };
}

await renewToken(true);
const routing = await http("GET", "/ai/routing");
const originalDefault = routing?.defaultModelId ?? routing?.routing?.defaultModelId ?? null;
await http("PUT", "/ai/models/default", { modelId: model });
const report = { phase, model, api, startedAt: new Date().toISOString(), originalDefaultRestored: false, scenarios: [] };
try {
  const company = await http("POST", "/companies", { name: `Measure ${phase} ${model.split("/").pop()} ${new Date().toISOString().slice(0, 16)}` });
  const companyId = company.id ?? company.company?.id;
  const conversation = await http("POST", "/conversations", { title: `Measure ${phase} ${model}` });
  report.companyId = companyId;
  let projectId = null;
  const state = {};
  for (const scenario of args.suite === "storefront" ? STOREFRONT : SCENARIOS) {
    if (only && !only.has(scenario.id)) continue;
    // The approval dialog is answered while the run waits (waitForRuns); this follow-up only runs if one is still open.
    if (scenario.approvePending && !(sql(`select count(*) from company_approvals where company_id='${companyId}' and status='pending' and tool_name='code.data.rows.seed'`) > 0)) continue;
    const skew = Date.now() - dbNow();
    const sinceIso = new Date(Date.now() - skew - 1_000).toISOString();
    const attachments = scenario.attach && args.reference
      ? [{ kind: "image", name: "design.png", mimeType: "image/png", dataBase64: readFileSync(args.reference).toString("base64") }] : undefined;
    let outcome;
    const requestStarted = Date.now();
    // While the request streams, answer sample-data approval dialogs promptly (the run waits about a minute for them).
    const approver = args.suite === "storefront" ? setInterval(() => { approveSampleDataOnce(companyId).catch(() => undefined); }, 2_000) : null;
    try {
      outcome = await chat(scenario.message, {
        conversationId: conversation.id, companyId,
        contextType: projectId ? "project" : "company", ...(projectId ? { projectId } : {}),
        ...(attachments ? { attachments } : {}),
      });
    } catch (error) { outcome = { started: requestStarted, sseMs: null, events: [], result: null, error: { message: error.message } }; }
    finally { if (approver) clearInterval(approver); }
    outcome.sinceIso = sinceIso;
    const approvedBefore = approvedSampleData;
    const settled = await waitForRuns(companyId, args.suite === "storefront");
    state.approved = approvedSampleData - approvedBefore;
    const endedAt = Date.now();
    const untilIso = new Date(endedAt - skew + 5_000).toISOString();
    if (!projectId) projectId = sql(`select to_json(id) from projects where company_id='${companyId}' order by created_at desc limit 1`);
    const metrics = collect(companyId, sinceIso, untilIso);
    const lastRunEnd = metrics.runs.map((r) => Date.parse(r.finishedAt ?? 0)).filter(Boolean).sort((a, b) => b - a)[0];
    const firstEvent = outcome.events[0];
    const record = {
      id: scenario.id, projectId, settled,
      firstEventMs: firstEvent?.atMs ?? null, firstEvent: firstEvent ? (firstEvent.payload?.routed ?? firstEvent.payload?.type ?? firstEvent.event) : null,
      routed: outcome.events.find((event) => event.payload?.routed)?.payload?.routed ?? (outcome.result?.routed ?? "chat"),
      ...omnirouteUsage(new Date(outcome.started - 1_000).toISOString(), new Date(endedAt + 1_000).toISOString()),
      timeToFirstActionMs: metrics.firstToolAtMs === null ? null : Math.max(0, metrics.firstToolAtMs + skew - outcome.started),
      firstDeltaMs: outcome.events.find((event) => event.event === "delta")?.atMs ?? null,
      sseMs: outcome.sseMs,
      totalMs: lastRunEnd ? Math.max(outcome.sseMs ?? 0, lastRunEnd + skew - outcome.started) : outcome.sseMs,
      ...metrics,
      success: await success(scenario.id, companyId, projectId, metrics, outcome, state),
      error: outcome.error,
      answer: String(outcome.result?.run?.message ?? outcome.result?.message ?? "").slice(0, 600),
    };
    report.scenarios.push(record);
    writeFileSync(path.join(outDir, `${phase}-${model.replace(/[^a-z0-9]+/gi, "_")}-${scenario.id}.events.json`), JSON.stringify(outcome.events, null, 1));
    if (args.suite === "storefront") state.migrationCount = sql(`select count(*) from data_backend_migrations where backend_id=(select data_backend_id from projects where id='${projectId}')`) ?? 0;
    console.log(JSON.stringify({ id: record.id, ok: record.success.ok, status: record.success.status, totalMs: record.totalMs, firstEvent: record.firstEventMs, firstAction: record.timeToFirstActionMs, routed: record.routed, llm: record.llmRequests, inTok: record.inputTokens, outTok: record.outputTokens, modelCalls: record.modelCalls, toolCalls: record.toolCalls, writes: record.writeCalls, repairs: record.visualRepairs, screenshots: record.screenshots, files: record.changedFiles }));
  }
} finally {
  if (originalDefault) { await http("PUT", "/ai/models/default", { modelId: originalDefault }).then(() => { report.originalDefaultRestored = true; }).catch(() => undefined); }
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, `${phase}-${model.replace(/[^a-z0-9]+/gi, "_")}.json`), JSON.stringify(report, null, 2));
}
