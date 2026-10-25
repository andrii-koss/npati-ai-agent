// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../business-workspace-shared", () => ({ api: mocks.api }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ language: "en" }) }));
import { ChatApprovalCard } from "../chat-approval-card";
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.clearAllMocks(); });
const props = { companyId: "company", runId: "run", approvalId: "approval", toolName: "project.data.rows.delete" };
async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<ChatApprovalCard {...props} />)); return host;
}
it("decides the exact request then resumes its bound run once", async () => {
  const approval = { id: "approval", status: "pending", runId: "run", toolName: props.toolName, actionSummary: "Delete scratch row-1" };
  mocks.api.mockImplementation(async (url: string) => url.endsWith("/decide") ? { approval: { ...approval, status: "approved" } } : url.endsWith("/resume") ? { run: { id: "run", status: "completed", result: "Deleted exactly row-1" } } : url.includes("/approvals/") ? { approval } : { run: { id: "run", status: "awaiting_approval" } });
  const host = await mount();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  const mutations = mocks.api.mock.calls.filter(call => call[1]?.method === "POST");
  expect(mutations.map(call => call[0])).toEqual(["/companies/company/approvals/approval/decide", "/companies/company/runs/run/resume"]);
  expect(JSON.parse(mutations[1]![1].body)).toEqual({ approvalId: "approval" });
  expect(host.textContent).toContain("Deleted exactly row-1");
  expect(host.querySelector("button")).toBeNull();
});
it.each(["another-run", "expired", "consumed"])("offers no decision for %s", async invalid => {
  mocks.api.mockImplementation(async (url: string) => url.includes("/approvals/") ? { approval: { id: "approval", status: "pending", runId: invalid === "another-run" ? "other" : "run", toolName: props.toolName, expiresAt: invalid === "expired" ? "2000-01-01T00:00:00Z" : undefined, consumedAt: invalid === "consumed" ? "2026-10-24T00:00:00Z" : undefined } } : { run: { id: "run", status: "awaiting_approval" } });
  const host = await mount(); expect(host.querySelector("button")).toBeNull();
});
it("continues an approved unused request after reloading without deciding it again", async () => {
 mocks.api.mockImplementation(async (url: string) => url.includes("/approvals/") ? { approval: { id: "approval", status: "approved", runId: "run", toolName: props.toolName } } : { run: { id: "run", status: url.endsWith("/resume") ? "completed" : "awaiting_approval" } });
 const host = await mount();
 await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
 expect(mocks.api.mock.calls.filter(call => call[1]?.method === "POST").map(call => call[0])).toEqual(["/companies/company/runs/run/resume"]);
});
