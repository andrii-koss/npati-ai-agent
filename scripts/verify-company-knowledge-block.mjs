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

  const card = page.locator(".company-knowledge-card");
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
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (memoryId && companyId) await request("/companies/" + companyId + "/knowledge/memory/" + memoryId, "DELETE").catch(() => {});
  if (documentId && companyId) await request("/companies/" + companyId + "/knowledge/documents/" + documentId, "DELETE").catch(() => {});
  if (companyId) await request("/companies/" + companyId, "DELETE").catch(() => {});
}
