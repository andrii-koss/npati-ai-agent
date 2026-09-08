import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.NPATI_API_URL ?? "http://localhost:3001";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loginResponse = await fetch(base + "/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "webuser1@example.com", password: "Password123!" }),
});
const login = await loginResponse.json();
if (!loginResponse.ok) throw new Error(JSON.stringify(login));
const token = login.tokens.accessToken;

async function request(path, method = "GET", body, idempotencyKey) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(method + " " + path + " " + response.status + " " + text);
  return value;
}

let companyId;
let documentId;
let memoryId;
let browser;
try {
  const stamp = Date.now();
  const company = await request("/companies", "POST", { name: "Knowledge block verification " + stamp }, "knowledge-block-company-" + stamp);
  companyId = company.id;

  const bytes = readFileSync(new URL("../tests/fixtures/company-knowledge.xlsx", import.meta.url));
  const document = await request(
    "/companies/" + companyId + "/knowledge/documents",
    "POST",
    { filename: "company-knowledge.xlsx", mimeType: "application/octet-stream", data: bytes.toString("base64") },
    "knowledge-block-xlsx-" + stamp,
  );
  documentId = document.id;

  const memory = await request("/companies/" + companyId + "/knowledge/memory", "POST", { content: "Initial verification memory" });
  memoryId = memory.id;
  const updatedMemory = await request("/companies/" + companyId + "/knowledge/memory/" + memoryId, "PUT", { content: "Edited verification memory" });
  if (updatedMemory.content !== "Edited verification memory") throw new Error("Memory edit mismatch");
  await request("/companies/" + companyId + "/knowledge/memory/" + memoryId, "DELETE");
  memoryId = undefined;

  let readyDocument;
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = await request("/companies/" + companyId + "/knowledge/documents");
    const current = result.documents.find((item) => item.id === documentId);
    if (current?.status === "failed") throw new Error("XLSX processing failed: " + current.errorMessage);
    if (current?.status === "ready") {
      readyDocument = current;
      break;
    }
    await sleep(1000);
  }
  if (!readyDocument) throw new Error("XLSX processing timed out");
  if (readyDocument.filename !== "company-knowledge.xlsx") throw new Error("Filename metadata missing");

  const download = await fetch(base + "/companies/" + companyId + "/knowledge/documents/" + documentId + "/content", {
    headers: { authorization: "Bearer " + token },
  });
  if (!download.ok || Buffer.from(await download.arrayBuffer()).length !== bytes.length) throw new Error("Downloaded file mismatch");
  await request("/companies/" + companyId + "/knowledge/documents/" + documentId, "DELETE");
  documentId = undefined;

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.addInitScript(({ accessToken, user }) => {
    localStorage.setItem("npati_agent_access_token", accessToken);
    localStorage.setItem("npati_agent_user", JSON.stringify(user));
  }, { accessToken: token, user: login.user });
  await page.goto("http://localhost:3000/company", { waitUntil: "networkidle" });
  await page.getByLabel("Select company").selectOption(companyId);

  await page.getByRole("button", { name: "+ Add Agent" }).click();
  const agentDrawer = page.locator(".agent-editor");
  await agentDrawer.waitFor();
  const agentNameField = agentDrawer.locator('input[required]').first();
  await agentNameField.focus();
  await page.waitForTimeout(200);
  const focusedFieldStyle = await agentNameField.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow, transitionDuration: style.transitionDuration };
  });
  if (focusedFieldStyle.borderColor !== "rgb(225, 29, 46)" || !focusedFieldStyle.boxShadow.includes("rgba(225, 29, 46, 0.08)")) throw new Error("Agent field focus does not match Goals");
  const agentClose = agentDrawer.getByRole("button", { name: "Close" });
  if (await agentClose.locator("svg").count() !== 1) throw new Error("Agent drawer close icon must use the Goals SVG style");
  await agentClose.hover();
  await page.waitForTimeout(220);
  const closeHoverStyle = await agentClose.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, color: style.color, transform: style.transform };
  });
  if (closeHoverStyle.backgroundColor !== "rgb(254, 226, 226)" || closeHoverStyle.color !== "rgb(225, 29, 46)" || closeHoverStyle.transform === "none") throw new Error("Agent close hover does not match Goals");
  await agentClose.click();
  await agentDrawer.waitFor({ state: "detached" });

  await page.getByRole("button", { name: "+ New Company" }).click();
  const companyDrawer = page.locator(".company-drawer:not(.agent-editor)");
  await companyDrawer.waitFor();
  const companyNameField = companyDrawer.locator('input[required]').first();
  await companyNameField.focus();
  await page.waitForTimeout(200);
  const companyFieldStyle = await companyNameField.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  if (companyFieldStyle.borderColor !== focusedFieldStyle.borderColor || companyFieldStyle.boxShadow !== focusedFieldStyle.boxShadow) throw new Error("New Company field focus does not match Add Agent/Goals");
  const companyClose = companyDrawer.getByRole("button", { name: "Close" });
  if (await companyClose.locator("svg").count() !== 1) throw new Error("New Company close icon must use the Goals SVG style");
  await companyClose.hover();
  await page.waitForTimeout(220);
  const companyCloseHoverStyle = await companyClose.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, color: style.color, transform: style.transform };
  });
  if (JSON.stringify(companyCloseHoverStyle) !== JSON.stringify(closeHoverStyle)) throw new Error("New Company close hover does not match Add Agent/Goals");
  await companyClose.click();
  await companyDrawer.waitFor({ state: "detached" });

  const connectedModels = await page.evaluate(async () => {
    const accessToken = localStorage.getItem("npati_agent_access_token");
    const response = await fetch("/api/ai/models/added", { headers: { authorization: "Bearer " + accessToken } });
    if (!response.ok) throw new Error("Could not read connected models");
    return await response.json();
  });
  if (!Array.isArray(connectedModels) || connectedModels.length === 0) throw new Error("The authenticated My Models library is unexpectedly empty");
  await page.getByRole("button", { name: "+ Add Agent" }).click();
  const modelDrawer = page.locator(".agent-editor");
  const primarySelect = modelDrawer.locator("select").nth(0);
  const fallbackSelect = modelDrawer.locator("select").nth(1);
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".agent-editor select")[0]?.querySelectorAll("option").length === expected + 1,
    connectedModels.length,
  );
  const primaryOptions = await primarySelect.locator("option").evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent })));
  const fallbackOptions = await fallbackSelect.locator("option").evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent })));
  const expectedIds = connectedModels.map((model) => model.id).sort();
  if (JSON.stringify(primaryOptions.slice(1).map((option) => option.value).sort()) !== JSON.stringify(expectedIds)) throw new Error("Primary Model mismatch: " + JSON.stringify({ primaryOptions, expectedIds, connectedModels }));
  if (JSON.stringify(fallbackOptions.slice(1).map((option) => option.value).sort()) !== JSON.stringify(expectedIds)) throw new Error("Fallback Model mismatch: " + JSON.stringify({ fallbackOptions, expectedIds, connectedModels }));
  if (primaryOptions[0]?.text?.includes("OmniRoute") || fallbackOptions[0]?.text?.includes("OmniRoute")) throw new Error("Agent Auto model still exposes the old provider name");
  const preferred = connectedModels.find((model) => model.id.includes("gpt-5.6-luna")) ?? connectedModels[0];
  const fallback = connectedModels.find((model) => model.id !== preferred.id) ?? preferred;
  await modelDrawer.locator('input[required]').nth(0).fill("Model assignment verification");
  await modelDrawer.locator('input[required]').nth(1).fill("Specialist");
  await primarySelect.selectOption(preferred.id);
  await fallbackSelect.selectOption(fallback.id);
  await modelDrawer.getByRole("button", { name: "Save Agent" }).click();
  await modelDrawer.waitFor({ state: "detached" });
  const storedAgents = await request("/companies/" + companyId + "/agents?limit=60");
  const storedAgent = storedAgents.agents.find((agent) => agent.name === "Model assignment verification");
  if (storedAgent?.modelId !== preferred.id || storedAgent?.fallbackModelId !== fallback.id) throw new Error("Selected agent models were not persisted");
  await request(
    "/companies/" + companyId + "/agents",
    "POST",
    { name: "NPATI Auto icon verification", role: "Assistant", tools: [], isActive: true },
    "npati-auto-icon-agent-" + stamp,
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Select company").selectOption(companyId);
  const modelAgentNode = page.locator(".company-agent-node").filter({ hasText: "Model assignment verification" });
  const autoAgentNode = page.locator(".company-agent-node").filter({ hasText: "NPATI Auto icon verification" });
  await modelAgentNode.waitFor();
  await autoAgentNode.waitFor();
  const modelIcon = modelAgentNode.locator(".company-agent-model-icon > img");
  const autoIcon = autoAgentNode.locator(".company-agent-model-icon > img");
  await page.waitForFunction(
    ([modelName, autoName]) => {
      const find = (name) => [...document.querySelectorAll(".company-agent-node")].find((node) => node.textContent?.includes(name));
      return find(modelName)?.querySelector("img")?.complete && find(autoName)?.querySelector("img")?.complete;
    },
    ["Model assignment verification", "NPATI Auto icon verification"],
  );
  const modelIconState = await modelIcon.evaluate((image) => ({ src: image.getAttribute("src"), width: image.naturalWidth }));
  const autoIconState = await autoIcon.evaluate((image) => ({ src: image.getAttribute("src"), width: image.naturalWidth }));
  if (!modelIconState.src?.includes("/api/ai/providers/" + encodeURIComponent(preferred.providerId) + "/icon") || modelIconState.width < 1) throw new Error("Assigned model provider icon was not rendered");
  if (autoIconState.src !== "/npati-auto.png" || autoIconState.width < 1) throw new Error("NPATI Auto favicon was not rendered");
  const agentNodes = page.locator(".company-agent-node");
  if (await page.locator(".company-agent-activity-dot").count() !== await agentNodes.count()) throw new Error("Every agent must have an activity indicator");
  if (await page.locator(".company-agent-activity-dot.idle").count() !== await agentNodes.count()) throw new Error("Agents without an active run must show idle status");
  const runsListUrl = "**/api/companies/" + companyId + "/runs?limit=20";
  const runDetailsUrl = "**/api/companies/" + companyId + "/runs/indicator-verification";
  await page.route(runsListUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ runs: [{ id: "indicator-verification", status: "running" }] }),
  }));
  await page.route(runDetailsUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      run: { id: "indicator-verification", status: "running", selectedAgentIds: [storedAgent.id] },
      steps: [{ agentId: storedAgent.id, status: "delegated" }],
      toolAudit: [],
    }),
  }));
  await modelAgentNode.locator(".company-agent-activity-dot.working").waitFor({ timeout: 7000 });
  if (!await modelAgentNode.evaluate((node) => node.classList.contains("working"))) throw new Error("Working agent card did not receive its live state");
  await page.unroute(runsListUrl);
  await page.unroute(runDetailsUrl);

  const card = page.locator(".company-knowledge-card");
  const layoutAndUploadStyle = await page.evaluate(() => {
    const chart = document.querySelector(".company-chart-card");
    const knowledge = document.querySelector(".company-knowledge-card");
    const upload = document.querySelector(".company-upload-label");
    if (!chart || !knowledge || !upload) return null;
    const style = getComputedStyle(upload);
    return {
      chartBeforeKnowledge: Boolean(chart.compareDocumentPosition(knowledge) & Node.DOCUMENT_POSITION_FOLLOWING),
      chartKnowledgeGap: Math.round(knowledge.getBoundingClientRect().top - chart.getBoundingClientRect().bottom),
      uploadBackground: style.backgroundColor,
      uploadColor: style.color,
    };
  });
  if (!layoutAndUploadStyle?.chartBeforeKnowledge) throw new Error("Organization must appear before Company Knowledge");
  if (layoutAndUploadStyle.chartKnowledgeGap !== 22) throw new Error("Organization/Knowledge gap must be 22px");
  if (layoutAndUploadStyle.uploadBackground !== "rgb(17, 17, 17)" || layoutAndUploadStyle.uploadColor !== "rgb(255, 255, 255)") throw new Error("Upload Document must be black with white text");
  const subtitle = await card.locator(".company-section-heading small").textContent();
  if (subtitle !== "Private MinIO documents, NPATI embeddings and rerank.") throw new Error("Knowledge subtitle mismatch: " + subtitle);
  if ((await card.textContent()).includes("OmniRoute")) throw new Error("Knowledge card still exposes the old provider name");
  const taskFieldStyle = await page.locator(".company-run-textarea").evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, borderRadius: style.borderRadius, boxShadow: style.boxShadow };
  });
  const memoryFieldStyle = await card.locator(".company-memory-editor-row > .company-memory-textarea").evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, borderRadius: style.borderRadius, boxShadow: style.boxShadow };
  });
  if (JSON.stringify(memoryFieldStyle) !== JSON.stringify(taskFieldStyle)) throw new Error("Memory field contour does not match the task field");

  const addMemoryButton = card.getByRole("button", { name: "+ Add Memory" });
  if (!(await addMemoryButton.isDisabled())) throw new Error("Empty memory action must start disabled");
  await card.locator(".company-memory-editor-row textarea").fill("Memory added from the Company UI");
  if (!(await addMemoryButton.isEnabled())) throw new Error("Add Memory did not become active after typing");
  await addMemoryButton.click();
  let memoryItem = card.locator(".company-memory-item").filter({ hasText: "Memory added from the Company UI" });
  await memoryItem.waitFor();
  await memoryItem.getByRole("button", { name: "Edit" }).click();
  memoryItem = card.locator(".company-memory-item").first();
  await memoryItem.locator("textarea").fill("Memory edited from the Company UI");
  await memoryItem.getByRole("button", { name: "Save" }).click();
  memoryItem = card.locator(".company-memory-item").filter({ hasText: "Memory edited from the Company UI" });
  await memoryItem.waitFor();
  const memoryDelete = memoryItem.getByRole("button", { name: "Delete" });
  if (!await memoryDelete.evaluate((element) => element.classList.contains("content-action-btn") && element.classList.contains("delete-btn"))) throw new Error("Memory Delete style is inconsistent");
  page.once("dialog", (dialog) => dialog.accept());
  await memoryDelete.click();
  await memoryItem.waitFor({ state: "detached" });

  await card.locator('input[type="file"]').setInputFiles("tests/fixtures/company-knowledge.xlsx");
  const documentItem = card.locator(".company-doc-item").filter({ hasText: "company-knowledge.xlsx" });
  await documentItem.waitFor();
  const successNotice = page.locator(".company-notice-banner.success").filter({ hasText: "document(s) uploaded" });
  await successNotice.waitFor();
  if (!await successNotice.getByText("Update completed", { exact: true }).isVisible()) throw new Error("Successful upload is still presented as a System Alert");
  const documentDelete = documentItem.getByRole("button", { name: "Delete" });
  if (!await documentDelete.evaluate((element) => element.classList.contains("content-action-btn") && element.classList.contains("delete-btn"))) throw new Error("Document Delete style is inconsistent");
  await documentItem.getByText("ready", { exact: true }).waitFor({ timeout: 90000 });
  const [downloaded] = await Promise.all([
    page.waitForEvent("download"),
    documentItem.getByRole("button", { name: "Download" }).click(),
  ]);
  if (downloaded.suggestedFilename() !== "company-knowledge.xlsx") throw new Error("Browser download filename mismatch");
  page.once("dialog", (dialog) => dialog.accept());
  await documentItem.getByRole("button", { name: "Delete" }).click();
  await documentItem.waitFor({ state: "detached" });

  console.log(JSON.stringify({
    xlsxStatus: readyDocument.status,
    chunks: readyDocument.chunkCount,
    filename: readyDocument.filename,
    memoryCreateEditDelete: true,
    documentDownloadDelete: true,
    browserUploadDownloadDelete: true,
    browserMemoryCreateEditDelete: true,
    addMemoryActivation: true,
    successNoticeStyle: true,
    memoryContourMatchesTask: true,
    deleteButtonsMatchHeader: true,
    organizationBeforeKnowledge: true,
    organizationKnowledgeGap: layoutAndUploadStyle.chartKnowledgeGap,
    uploadButtonBlackWithWhiteText: true,
    agentFieldFocusMatchesGoals: true,
    agentCloseAnimationMatchesGoals: true,
    companyFieldFocusMatchesGoals: true,
    companyCloseAnimationMatchesGoals: true,
    connectedModelCount: connectedModels.length,
    agentPrimaryAndFallbackModelsPersisted: true,
    assignedModelProviderIcon: true,
    npatiAutoUploadedIcon: true,
    everyAgentHasActivityIndicator: true,
    workingAgentIndicatorTurnsGreen: true,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (memoryId && companyId) await request("/companies/" + companyId + "/knowledge/memory/" + memoryId, "DELETE").catch(() => {});
  if (documentId && companyId) await request("/companies/" + companyId + "/knowledge/documents/" + documentId, "DELETE").catch(() => {});
  if (companyId) await request("/companies/" + companyId, "DELETE").catch(() => {});
}
