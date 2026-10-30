import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  sendChatStream,
  defaultConfig,
  assertNoSecretsLeaked,
  testLivePreviewDom,
  testLivePreviewResetDom,
} from "./e2e-client.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE_URL = defaultConfig.baseUrl;
let COMPANY_ID = "";
const WORKSPACE_ID = process.env.NPATI_E2E_WORKSPACE_ID ?? "";
const USER_ID = process.env.NPATI_E2E_USER_ID ?? "";
const API_CONTAINER = process.env.NPATI_E2E_API_CONTAINER ?? "";
const POSTGRES_CONTAINER = process.env.NPATI_E2E_POSTGRES_CONTAINER ?? "";

let testProjectId = "";
let initialFileRevision = "";
let updatedFileRevision = "";
let activeConversationId = "";
let e2eProjectId = "";

function runInContainer(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", API_CONTAINER, "node"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Container exec exit ${code}: ${stderr}`));
    });
    child.stdin.write(code);
    child.stdin.end();
  });
}

async function callSandboxRunner(operation: string, payload: any): Promise<any> {
  const script = `
    const crypto = require("node:crypto");
    const secret = process.env.NPATI_SANDBOX_RUNNER_SECRET;
    if (!secret) throw new Error("Runner secret is unavailable in the isolated API");
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const body = JSON.stringify({ operation: ${JSON.stringify(operation)}, payload: ${JSON.stringify(payload)} });
    const sig = crypto.createHmac("sha256", secret).update(timestamp + "." + nonce + "." + body).digest("hex");
    
    fetch("http://sandbox-runner:7865/v1/sandbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-npati-timestamp": timestamp,
        "x-npati-nonce": nonce,
        "x-npati-signature": sig,
      },
      body,
    })
    .then(r => r.json())
    .then(data => console.log(JSON.stringify(data)))
    .catch(err => { console.error(err); process.exit(1); });
  `;
  const raw = await runInContainer(script);
  return JSON.parse(raw);
}


async function authorizedPreviewUrl(projectId: string, token: string): Promise<string> {
  const endpoint = BASE_URL + "/companies/" + COMPANY_ID + "/projects/" + projectId + "/preview";
  const response = await fetch(endpoint + "/token", { headers: { authorization: "Bearer " + token } });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(typeof data.token).toBe("string");
  expect(data.token.length).toBeGreaterThan(0);
  return endpoint + "/proxy/?token=" + encodeURIComponent(data.token);
}

function queryPostgres(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        POSTGRES_CONTAINER,
        "psql",
        "-U",
        "npati",
        "-d",
        process.env.NPATI_E2E_DATABASE ?? "npati",
        "-t",
        "-A",
        "-F",
        "\t",
        "-c",
        sql,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`psql exit ${code}: ${stderr}`));
    });
  });
}

describe("Coding Agent E2E Smoke Suite (Stage 2 Extended)", () => {
  let validToken = process.env.NPATI_E2E_ACCESS_TOKEN ?? "";
  const sessionCookieFile = process.env.NPATI_E2E_SESSION_COOKIE_FILE;
  async function renewTestSession() {
    if (!sessionCookieFile) return;
    const cookie = readFileSync(sessionCookieFile, "utf8").trim().replace(/^npati_agent_session=/, "");
    const response = await fetch(BASE_URL + "/api/auth/installation/session", { method: "POST", headers: { cookie: "npati_agent_session=" + cookie }, signal: AbortSignal.timeout(20_000) });
    const session = await response.json();
    if (!response.ok || !session.data?.accessToken || session.data.user?.id !== USER_ID) throw new Error("BLOCKED: normal test-user installation sign-in failed");
    validToken = session.data.accessToken;
  }

  beforeAll(async () => {

    const target = new URL(BASE_URL);
    const v5Stand = target.port === "13001" && API_CONTAINER === "npati-isolated-source-20261011-agent-api-1"
      && POSTGRES_CONTAINER === "npati-isolated-source-20261011-postgres-1";
    if (process.env.NPATI_E2E_ISOLATED !== "true" || !["localhost", "127.0.0.1"].includes(target.hostname)
      || !(v5Stand || /^npati-stress-v2-(?:stage-a|final)-[0-9]+-agent-api-1$/.test(API_CONTAINER)
        && /^npati-stress-v2-(?:stage-a|final)-[0-9]+-postgres-1$/.test(POSTGRES_CONTAINER))
      || !USER_ID || !WORKSPACE_ID) throw new Error("BLOCKED: explicit isolated E2E fixture configuration is required");
    await renewTestSession();
    if (!validToken) throw new Error("BLOCKED: live smoke requires a legitimate test-user session via NPATI_E2E_ACCESS_TOKEN; manually signed test JWTs are not accepted for this local audit.");
    const created = await fetch(BASE_URL + "/companies", { method: "POST", headers: { authorization: "Bearer " + validToken, "content-type": "application/json", "idempotency-key": "v2-live-smoke-company" }, body: JSON.stringify({ name: "E2E Smoke V2 disposable" }) });
    expect([200, 201]).toContain(created.status);
    const company = await created.json();
    COMPANY_ID = company.id ?? company.company?.id;
    expect(COMPANY_ID).toBeTruthy();
    // Preflight health check
    const healthRes = await fetch(`${BASE_URL}/health`);
    expect(healthRes.status).toBe(200);
    const health = await healthRes.json();
    expect(health.status).toBe("ok");
    expect(health.services?.omniroute).toBe("ok");
    expect(health.services?.database).toBe("ok");
  });

  beforeEach(renewTestSession);

  // ==========================================
  // Category 1: API Integration (Direct REST)
  // ==========================================
  describe("Category 1: API Integration", () => {
    // T001: chat-auth-real
    it("T001: chat-auth-real - rejects unauthorized requests and accepts valid JWT", async () => {
      // 1. Missing auth
      const noAuthRes = await fetch(`${BASE_URL}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(noAuthRes.status).toBe(401);
      const noAuthBody = await noAuthRes.json();
      expect(noAuthBody.error?.code).toBe("UNAUTHORIZED");

      // 2. Tampered / invalid token signature
      const badToken = validToken.slice(0, -6) + "badsig";
      const badAuthRes = await fetch(`${BASE_URL}/chat/stream`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${badToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(badAuthRes.status).toBe(401);

      // 3. Valid token authorization
      const validRes = await fetch(`${BASE_URL}/companies`, {
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(validRes.status).toBe(200);
      const companies = await validRes.json();
      expect(Array.isArray(companies.companies)).toBe(true);
    });

    // T003: create-isolated-project-api
    it("T003: create-isolated-project-api - creates isolated project and verifies persistence", async () => {
      const idempotencyKey = `e2e-project-smoke-${Date.now()}`;
      const createRes = await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${validToken}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          name: `Smoke Project ${Date.now()}`,
          type: "website",
          description: "Small test website for E2E smoke verification",
        }),
      });

      expect([200, 201]).toContain(createRes.status);
      const project = await createRes.json();
      expect(project.id).toBeDefined();
      expect(project.companyId).toBe(COMPANY_ID);
      testProjectId = project.id;

      // Verify project can be retrieved
      const getRes = await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}`, {
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.id).toBe(testProjectId);
      expect(fetched.type).toBe("website");
    });

    // T004: write-read-files-api
    it("T004: write-read-files-api - direct REST file write and read (API check, not agent autonomy)", async () => {
      expect(testProjectId).toBeTruthy();

      const htmlContent = "<!doctype html><html><head><title>Smoke App</title></head><body><h1>Smoke App Initial</h1></body></html>";
      const writeRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/files/write`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${validToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            path: "index.html",
            content: htmlContent,
          }),
        },
      );
      expect(writeRes.status).toBe(201);
      const writeData = await writeRes.json();
      expect(writeData.path).toBe("index.html");
      expect(writeData.revision).toBeDefined();
      initialFileRevision = writeData.revision;

      // Verify read returns identical content
      const readRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/files/read?path=index.html`,
        {
          headers: { authorization: `Bearer ${validToken}` },
        },
      );
      expect(readRes.status).toBe(200);
      const readData = await readRes.json();
      expect(readData.content).toBe(htmlContent);
      expect(readData.revision).toBe(initialFileRevision);
    });

    // T005: edit-existing-file-cas-api
    it("T005: edit-existing-file-cas-api - validates CAS conflict protection on concurrent writes", async () => {
      expect(testProjectId).toBeTruthy();
      expect(initialFileRevision).toBeTruthy();

      // 1. Conflict rejection on mismatched revision
      const badConflictRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/files/write`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${validToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            path: "index.html",
            content: "<h1>Unsafe Overwrite</h1>",
            expectedRevision: "0000000000000000000000000000000000000000000000000000000000000000",
          }),
        },
      );
      expect(badConflictRes.status).toBe(409);

      // 2. Success with matched revision
      const updatedContent = "<!doctype html><html><head><title>Smoke App v2</title></head><body><h1>Smoke App v2 Updated</h1></body></html>";
      const okUpdateRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/files/write`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${validToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            path: "index.html",
            content: updatedContent,
            expectedRevision: initialFileRevision,
          }),
        },
      );
      expect(okUpdateRes.status).toBe(200);
      const okData = await okUpdateRes.json();
      updatedFileRevision = okData.revision;
      expect(updatedFileRevision).not.toBe(initialFileRevision);
    });

    // T007: project-files-tree-api
    it("T007: project-files-tree-api - adds package.json build script and verifies file tree", async () => {
      expect(testProjectId).toBeTruthy();

      const pkgContent = JSON.stringify(
        {
          name: "smoke-test-project",
          version: "1.0.0",
          private: true,
          scripts: {
            build: 'node -e "process.stdout.write(\'build-ok\')"',
          },
        },
        null,
        2,
      );

      const writePkgRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/files/write`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${validToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            path: "package.json",
            content: pkgContent,
          }),
        },
      );
      expect([200, 201]).toContain(writePkgRes.status);

      const treeRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/files/tree`,
        {
          headers: { authorization: `Bearer ${validToken}` },
        },
      );
      expect(treeRes.status).toBe(200);
      const treeData = await treeRes.json();
      expect(Array.isArray(treeData.files)).toBe(true);
      const filePaths = treeData.files.map((f: any) => f.path);
      expect(filePaths).toContain("index.html");
      expect(filePaths).toContain("package.json");
    });

    // T010: runs-and-changes-api
    it("T010: runs-and-changes-api - activity and run trace recorded, zero secret leakage", async () => {
      const runsRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/runs`,
        {
          headers: { authorization: `Bearer ${validToken}` },
        },
      );
      expect(runsRes.status).toBe(200);
      const runsData = await runsRes.json();
      expect(Array.isArray(runsData.runs)).toBe(true);

      const changesRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/changes`,
        {
          headers: { authorization: `Bearer ${validToken}` },
        },
      );
      expect(changesRes.status).toBe(200);
      const changesData = await changesRes.json();
      expect(changesData.summary).toBeDefined();

      assertNoSecretsLeaked(runsData);
      assertNoSecretsLeaked(changesData);
    });
  });

  // ==========================================
  // Category 2: Component Integration
  // ==========================================
  describe("Category 2: Component Integration", () => {
    // T002: chat-streaming-lifecycle
    it("T002: chat-streaming-lifecycle - SSE delta events and clean terminal lifecycle", async () => {
      const outcome = await sendChatStream({
        message: "Привіт! Скільки буде 3 + 4? Напиши тільки одне число.",
        companyId: COMPANY_ID,
        baseUrl: BASE_URL,
        token: validToken,
        timeoutMs: 60_000,
      });

      expect(outcome.events.length).toBeGreaterThan(0);
      expect(outcome.progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(outcome.resultEvent).toBeDefined();
      expect(outcome.errorEvent).toBeUndefined();

      const fullText = outcome.text || outcome.resultEvent?.message || "";
      expect(fullText.length).toBeGreaterThan(0);
      expect(outcome.durationMs).toBeGreaterThan(50);
      assertNoSecretsLeaked(outcome.events);
    }, 70_000);

    // T006: safe-terminal-api
    it("T006: safe-terminal-api - queries terminal logs/events endpoint availability", async () => {
      expect(testProjectId).toBeTruthy();

      const logsRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/terminal/logs`,
        {
          headers: { authorization: `Bearer ${validToken}` },
        },
      );
      expect(logsRes.status).toBe(200);

      const eventsRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/terminal/events`,
        {
          headers: { authorization: `Bearer ${validToken}` },
        },
      );
      expect(eventsRes.status).toBe(200);
    });

    // T008: preview-http-proxy
    it("T008: preview-http-proxy - starts preview server, tests proxy HTTP 200, and stops preview", async () => {
      expect(testProjectId).toBeTruthy();

      const startRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/preview/start`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${validToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            command: "npx --yes serve -p 3000 .",
          }),
        },
      );
      expect(startRes.status).toBe(200);
      const startData = await startRes.json();
      expect(startData.status).toBe("running");

      const statusRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/preview/status`,
        {
          headers: { authorization: `Bearer ${validToken}` },
        },
      );
      expect(statusRes.status).toBe(200);
      const statusData = await statusRes.json();
      expect(["running", "previewing"]).toContain(statusData.status);

      const proxyPath = statusData.previewUrl.replace("/api/", "/");
      const proxyRes = await fetch(`${BASE_URL}${proxyPath}`);
      expect(proxyRes.status).toBe(200);
      const htmlText = await proxyRes.text();
      expect(htmlText).toContain("Smoke App v2 Updated");

      const stopRes = await fetch(
        `${BASE_URL}/companies/${COMPANY_ID}/projects/${testProjectId}/preview/stop`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${validToken}` },
        },
      );
      expect(stopRes.status).toBe(200);
    }, 30_000);

    // T009: conversation-multi-turn-memory
    it("T009: conversation-multi-turn-memory - multi-turn conversation retains memory and project context", async () => {
      const turn1 = await sendChatStream({
        message: "Мене звати Тестер. Запам'ятай кодове слово: СТРІЛА-99. Відповідай коротко.",
        companyId: COMPANY_ID,
        projectId: testProjectId,
        baseUrl: BASE_URL,
        token: validToken,
        timeoutMs: 60_000,
      });
      expect(turn1.events.length).toBeGreaterThan(0);
      expect(turn1.resultEvent).toBeDefined();
      activeConversationId = turn1.resultEvent?.conversationId;
      expect(activeConversationId).toBeTruthy();

      const turn2 = await sendChatStream({
        message: "Яке кодове слово я назвав? Напиши тільки його.",
        conversationId: activeConversationId,
        companyId: COMPANY_ID,
        projectId: testProjectId,
        baseUrl: BASE_URL,
        token: validToken,
        timeoutMs: 60_000,
      });
      expect(turn2.events.length).toBeGreaterThan(0);
      expect(turn2.resultEvent).toBeDefined();
      const replyText = (turn2.text || turn2.resultEvent?.message || "").toLowerCase();
      expect(replyText).toMatch(/стріла|99/);

      assertNoSecretsLeaked([turn1.events, turn2.events]);
    }, 120_000);
  });

  // ==========================================
  // Category 3: Real Agent E2E (Full Chain)
  // ==========================================
  describe("Category 3: Real Agent E2E", () => {
    // T011: autonomous-website-creation-chat
    it("T011: autonomous-website-creation-chat - full chain Chat -> AI -> Tool Calls -> Sandbox -> Playwright DOM", async () => {
      const prompt = "Створи простий адаптивний сайт на HTML, CSS і JavaScript. Додай заголовок NPATI Test, кнопку Click Me та лічильник натискань. Створи всі файли у Sandbox, перевір код і запусти Live Preview.";

      const outcome = await sendChatStream({
        message: prompt,
        companyId: COMPANY_ID,
        baseUrl: BASE_URL,
        token: validToken,
        timeoutMs: 90_000,
      });

      expect(outcome.events.length).toBeGreaterThan(0);
      const conversationId = outcome.resultEvent?.conversationId;
      expect(conversationId).toBeTruthy();
      activeConversationId = conversationId;

      const capturedProjectId = outcome.resultEvent?.projectCard?.projectId ?? outcome.resultEvent?.projectCard?.id
        ?? outcome.resultEvent?.activeContext?.projectId ?? outcome.resultEvent?.projectId;
      expect(capturedProjectId).toMatch(/^[0-9a-f-]{36}$/i);
      // Verify this request's project, never another chat's most recent trace.
      const recentTrace = await queryPostgres(
        `SELECT kind, payload->>'eventType' as ev_type, payload->>'tool' as tool, project_id FROM code_activity_events WHERE company_id = '${COMPANY_ID}' AND project_id = '${capturedProjectId}' AND created_at > now() - interval '3 minutes' ORDER BY created_at DESC LIMIT 10;`
      );
      expect(recentTrace.length).toBeGreaterThan(0);

      e2eProjectId = capturedProjectId;

      // Start preview and verify via Playwright
      let previewProxyUrl = "";
      const pStatusRes = await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${capturedProjectId}/preview/status`, {
        headers: { authorization: `Bearer ${validToken}` },
      });
      const pStatus = await pStatusRes.json();
      if (pStatus?.previewUrl) {
        previewProxyUrl = await authorizedPreviewUrl(e2eProjectId, validToken);
      } else {
        const startRes = await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${capturedProjectId}/preview/start`, {
          method: "POST",
          headers: { authorization: `Bearer ${validToken}`, "content-type": "application/json" },
        });
        const started = await startRes.json();
        if (started?.previewUrl) previewProxyUrl = await authorizedPreviewUrl(e2eProjectId, validToken);
      }

      expect(previewProxyUrl).toBeTruthy();
      if (previewProxyUrl) {
        const domResult = await testLivePreviewDom(previewProxyUrl);
        expect(domResult.buttonFound).toBe(true);
        expect(domResult.headerText).toContain("NPATI Test");
        expect(domResult.afterClickCounterText).not.toBe(domResult.initialCounterText);
        const initialCount = domResult.initialCounterText.match(/\d+/g)?.at(-1);
        const clickedCount = domResult.afterClickCounterText.match(/\d+/g)?.at(-1);
        expect(initialCount).toBeDefined();
        expect(clickedCount).toBeDefined();
        expect(Number(clickedCount)).toBe(Number(initialCount) + 1);
      }
    }, 120_000);

    // T012: autonomous-website-continuation-edit
    it("T012: autonomous-website-continuation-edit - multi-turn edit in same conversation, Playwright red button & reset", async () => {
      expect(activeConversationId).toBeTruthy();
      expect(e2eProjectId).toBeTruthy();

      const prompt2 = "Зміни колір кнопки на червоний, додай кнопку Reset та перевір, що лічильник працює правильно.";

      const turn2Res = await sendChatStream({
        message: prompt2,
        conversationId: activeConversationId,
        companyId: COMPANY_ID,
        projectId: e2eProjectId,
        baseUrl: BASE_URL,
        token: validToken,
        timeoutMs: 90_000,
      });

      expect(turn2Res.events.length).toBeGreaterThan(0);

      let previewProxyUrl = "";
      const pStatusRes = await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${e2eProjectId}/preview/status`, {
        headers: { authorization: `Bearer ${validToken}` },
      });
      const pStatus = await pStatusRes.json();
      if (pStatus?.previewUrl) {
        previewProxyUrl = `${BASE_URL}${pStatus.previewUrl.replace("/api/", "/")}`;
      } else {
        const startRes = await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${e2eProjectId}/preview/start`, {
          method: "POST",
          headers: { authorization: `Bearer ${validToken}`, "content-type": "application/json" },
        });
        const started = await startRes.json();
        if (started?.previewUrl) previewProxyUrl = `${BASE_URL}${started.previewUrl.replace("/api/", "/")}`;
      }

      expect(previewProxyUrl).toBeTruthy();
      if (previewProxyUrl) {
        const domResult = await testLivePreviewResetDom(previewProxyUrl);
        expect(domResult.buttonFound).toBe(true);
        expect(domResult.resetButtonFound).toBe(true);
      }
    }, 120_000);

    // T013: real-sandbox-terminal-execution
    it("T013: real-sandbox-terminal-execution - executes command in bubblewrap/sandbox runner", async () => {
      const getProj = await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${e2eProjectId || testProjectId}`, {
        headers: { authorization: `Bearer ${validToken}` },
      });
      const proj = await getProj.json();
      const sandboxId = proj.sandboxId;

      const scope = {
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        companyId: COMPANY_ID,
        projectId: e2eProjectId || testProjectId,
      };

      const cmdRes = await callSandboxRunner("executeCommand", {
        scope,
        sandboxId,
        command: "echo NPATI_TERMINAL_E2E_VERIFIED && node -v",
        options: { timeoutMs: 15_000, outputLimitBytes: 4096 },
      });

      const res = cmdRes.result;
      expect(res).toBeDefined();
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("NPATI_TERMINAL_E2E_VERIFIED");
      expect(res.durationMs).toBeGreaterThan(0);
    });

    // T014: real-sandbox-vite-build-execution
    it("T014: real-sandbox-vite-build-execution - executes Vite build in sandbox container and verifies dist/", async () => {
      // Create dedicated Vite project for clean isolated build
      const pRes = await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects`, {
        method: "POST",
        headers: { authorization: `Bearer ${validToken}`, "content-type": "application/json", "idempotency-key": "vite-vitest-" + Date.now() },
        body: JSON.stringify({ name: "Vite E2E Vitest Project", type: "website", framework: "Vite" }),
      });
      const viteProj = await pRes.json();
      const projectId = viteProj.id;

      // Write Vite project structure
      await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${projectId}/files/write`, {
        method: "POST",
        headers: { authorization: `Bearer ${validToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          path: "index.html",
          content: "<!doctype html><html><head><title>Vite E2E</title></head><body><h1>Vite E2E App</h1><script type='module' src='/src/main.js'></script></body></html>",
        }),
      });

      await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${projectId}/files/write`, {
        method: "POST",
        headers: { authorization: `Bearer ${validToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          path: "src/main.js",
          content: "console.log('NPATI_VITE_PRODUCTION_BUILD_VERIFIED');",
        }),
      });

      await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${projectId}/files/write`, {
        method: "POST",
        headers: { authorization: `Bearer ${validToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          path: "package.json",
          content: JSON.stringify(
            {
              name: "vite-e2e-project",
              version: "1.0.0",
              type: "module",
              scripts: { build: "npx --yes vite build" },
            },
            null,
            2,
          ),
        }),
      });

      // Start preview to initialize sandbox workspace
      await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${projectId}/preview/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${validToken}`, "content-type": "application/json" },
        body: JSON.stringify({ command: "npx --yes serve -p 3000 ." }),
      });

      const getProj = await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${projectId}`, {
        headers: { authorization: `Bearer ${validToken}` },
      });
      const proj = await getProj.json();
      const sandboxId = proj.sandboxId;

      const scope = {
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        companyId: COMPANY_ID,
        projectId,
      };

      const buildRes = await callSandboxRunner("executeCommand", {
        scope,
        sandboxId,
        command: "npx --yes vite build",
        options: { timeoutMs: 60_000, outputLimitBytes: 8192 },
      });

      const res = buildRes.result;
      expect(res).toBeDefined();
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/(built in|dist\/index\.html)/);

      // Verify output assets in dist/
      const distCheck = await callSandboxRunner("executeCommand", {
        scope,
        sandboxId,
        command: "ls -la dist",
        options: { timeoutMs: 15_000, outputLimitBytes: 4096 },
      });
      const distOutput = distCheck.result?.stdout || "";
      expect(distOutput).toContain("index.html");
      expect(distOutput).toContain("assets");

      await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${projectId}/preview/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${validToken}` },
      });
    }, 90_000);

    // T015: activity-and-run-trace-deep-audit
    it("T015: activity-and-run-trace-deep-audit - audits PostgreSQL trace and /runs endpoint", async () => {
      const rowsRaw = await queryPostgres(
        `SELECT id, kind, payload->>'eventType' as event_type, payload->>'tool' as tool, data_classification FROM code_activity_events WHERE created_at > now() - interval '10 minutes' ORDER BY created_at DESC LIMIT 15;`
      );
      expect(rowsRaw.length).toBeGreaterThan(0);

      const runsRes = await fetch(`${BASE_URL}/companies/${COMPANY_ID}/projects/${e2eProjectId || testProjectId}/runs`, {
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(runsRes.status).toBe(200);
      const runs = await runsRes.json();
      assertNoSecretsLeaked(runs);
    });
  });
});
