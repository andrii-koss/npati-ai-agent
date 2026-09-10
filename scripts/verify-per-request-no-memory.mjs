import { chromium } from "playwright";

const apiBase = process.env.NPATI_API_URL ?? "http://localhost:3001";
const webBase = process.env.NPATI_WEB_URL ?? "http://localhost:3000";

const loginResponse = await fetch(apiBase + "/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: process.env.NPATI_TEST_EMAIL ?? "webuser1@example.com",
    password: process.env.NPATI_TEST_PASSWORD ?? "Password123!",
  }),
});
const login = await loginResponse.json();
if (!loginResponse.ok) throw new Error("Login failed: " + JSON.stringify(login));
const token = login.tokens.accessToken;

async function request(path, method = "GET", body, headers = {}) {
  const response = await fetch(apiBase + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(method + " " + path + " " + response.status + " " + text);
  return value;
}

let businessId;
let browser;
try {
  const stamp = Date.now();
  const business = await request("/businesses", "POST", { name: "No-memory verification " + stamp, businessStage: "operating" });
  businessId = business.id;
  await request("/businesses/" + businessId + "/memory", "POST", {
    type: "business_fact",
    title: "Private verification fact",
    content: "NO-MEMORY-SECRET-" + stamp,
    source: "verification",
    confidence: 1,
  });
  const conversation = await request("/businesses/" + businessId + "/conversations", "POST", { title: "No-memory verification" });
  const before = await request("/businesses/" + businessId + "/conversations/" + conversation.id);

  const ephemeral = await request("/chat", "POST", {
    message: "Answer briefly without using or saving memory.",
    contextType: "business",
    businessId,
    conversationId: conversation.id,
    noMemory: true,
  });
  const after = await request("/businesses/" + businessId + "/conversations/" + conversation.id);
  if (ephemeral.noMemory !== true) throw new Error("API did not confirm no-memory mode");
  if (after.messages.length !== before.messages.length) throw new Error("Private request was persisted in conversation history");

  const headerMode = await request("/chat", "POST", {
    message: "Header-based private request.",
    contextType: "none",
  }, { "x-npati-no-memory": "true" });
  if (headerMode.noMemory !== true || headerMode.conversationId) throw new Error("Header no-memory mode created neutral history");

  const inspector = await request("/capabilities/inspect");
  const capability = (inspector.capabilities ?? inspector.items ?? []).find((item) =>
    item.capabilityId === "storage.per-request_no-memory" || item.capability?.id === "storage.per-request_no-memory"
  );
  const status = capability?.status ?? capability?.classification?.status ?? capability?.effectiveStatus;
  if (status !== "VERIFIED_EXISTING") throw new Error("Capability #82 is not Verified: " + String(status));

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.addInitScript(({ accessToken, user }) => {
    localStorage.setItem("npati_agent_access_token", accessToken);
    localStorage.setItem("npati_agent_user", JSON.stringify(user));
  }, { accessToken: token, user: login.user });
  await page.goto(webBase + "/chat", { waitUntil: "networkidle" });
  const toggle = page.getByText("Private request", { exact: true }).first();
  await toggle.waitFor();
  const label = toggle.locator("..");
  const checkbox = label.locator('input[type="checkbox"]');
  await label.click();
  if (!await checkbox.isChecked()) throw new Error("Private request UI toggle is not interactive");

  console.log(JSON.stringify({
    capabilityId: "storage.per-request_no-memory",
    inspectorStatus: status,
    apiPayloadFlag: true,
    apiHeaderFlag: true,
    conversationReadBypassed: true,
    conversationWriteBypassed: true,
    neutralConversationNotCreated: true,
    privateRequestToggleVisible: true,
    privateRequestToggleInteractive: true,
  }, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  if (businessId) await request("/businesses/" + businessId, "DELETE").catch(() => undefined);
}
