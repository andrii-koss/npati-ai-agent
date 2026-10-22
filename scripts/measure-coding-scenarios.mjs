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
async function waitForRuns(companyId) {
  const deadline = Date.now() + scenarioTimeoutMs;
  let quietSince = 0;
  while (Date.now() < deadline) {
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
  return {
    runs, modelCalls: modelCalls.length, selfReviewCalls: modelCalls.filter((event) => event.p.modelPurpose === "self_review").length,
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

async function success(id, companyId, projectId, metrics, outcome) {
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
  for (const scenario of SCENARIOS) {
    if (only && !only.has(scenario.id)) continue;
    const skew = Date.now() - dbNow();
    const sinceIso = new Date(Date.now() - skew - 1_000).toISOString();
    const attachments = scenario.attach && args.reference
      ? [{ kind: "image", name: "design.png", mimeType: "image/png", dataBase64: readFileSync(args.reference).toString("base64") }] : undefined;
    let outcome;
    const requestStarted = Date.now();
    try {
      outcome = await chat(scenario.message, {
        conversationId: conversation.id, companyId,
        contextType: projectId ? "project" : "company", ...(projectId ? { projectId } : {}),
        ...(attachments ? { attachments } : {}),
      });
    } catch (error) { outcome = { started: requestStarted, sseMs: null, events: [], result: null, error: { message: error.message } }; }
    outcome.sinceIso = sinceIso;
    const settled = await waitForRuns(companyId);
    const endedAt = Date.now();
    const untilIso = new Date(endedAt - skew + 5_000).toISOString();
    if (!projectId) projectId = sql(`select to_json(id) from projects where company_id='${companyId}' order by created_at desc limit 1`);
    const metrics = collect(companyId, sinceIso, untilIso);
    const lastRunEnd = metrics.runs.map((r) => Date.parse(r.finishedAt ?? 0)).filter(Boolean).sort((a, b) => b - a)[0];
    const record = {
      id: scenario.id, projectId, settled,
      timeToFirstActionMs: metrics.firstToolAtMs === null ? null : Math.max(0, metrics.firstToolAtMs + skew - outcome.started),
      firstDeltaMs: outcome.events.find((event) => event.event === "delta")?.atMs ?? null,
      sseMs: outcome.sseMs,
      totalMs: lastRunEnd ? Math.max(outcome.sseMs ?? 0, lastRunEnd + skew - outcome.started) : outcome.sseMs,
      ...metrics,
      success: await success(scenario.id, companyId, projectId, metrics, outcome),
      error: outcome.error,
      answer: String(outcome.result?.run?.message ?? outcome.result?.message ?? "").slice(0, 600),
    };
    report.scenarios.push(record);
    writeFileSync(path.join(outDir, `${phase}-${model.replace(/[^a-z0-9]+/gi, "_")}-${scenario.id}.events.json`), JSON.stringify(outcome.events, null, 1));
    console.log(JSON.stringify({ id: record.id, ok: record.success.ok, status: record.success.status, totalMs: record.totalMs, firstAction: record.timeToFirstActionMs, modelCalls: record.modelCalls, toolCalls: record.toolCalls, writes: record.writeCalls, files: record.changedFiles }));
  }
} finally {
  if (originalDefault) { await http("PUT", "/ai/models/default", { modelId: originalDefault }).then(() => { report.originalDefaultRestored = true; }).catch(() => undefined); }
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, `${phase}-${model.replace(/[^a-z0-9]+/gi, "_")}.json`), JSON.stringify(report, null, 2));
}
