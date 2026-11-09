// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ChatRunApprovals } from "../ChatRunApprovals";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.unstubAllGlobals(); document.body.innerHTML = ""; });
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const approvals = [
  { id: "a1", toolName: "code.data.policies.apply", runId: "run-1", inputPayload: { args: { policies: [{ collection: "leads", rule: "public", actions: ["insert"] }] } } },
  { id: "other", toolName: "code.fs.delete", runId: "run-2" },
];
async function mount(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<I18nProvider><ChatRunApprovals companyId="c" runId="run-1" /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 0)); });
  return host;
}

describe("approvals while the agent waits", () => {
  it("shows only this run's request, in plain words", async () => {
    const host = await mount(vi.fn(async () => reply({ approvals })));
    expect(host.querySelectorAll('[data-testid="run-approval"]')).toHaveLength(1);
    expect(host.textContent).toContain("leads");
    expect(host.textContent).toContain("insert");
    expect(host.textContent).toContain("anyone");
  });

  it("sends the decision and removes the request", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => init?.method === "POST" ? reply({ approval: { id: "a1" } }) : reply({ approvals }));
    const host = await mount(fetchMock);
    await act(async () => { host.querySelector<HTMLButtonElement>(".chat-approval-card-actions button")!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(call[0]).toBe("/api/companies/c/approvals/a1/decide");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ decision: "approved" });
    expect(host.querySelector('[data-testid="run-approval"]')).toBeNull();
  });
});
