// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ChatRunApprovals, SHOW_DATA_APPROVAL_CARDS } from "../ChatRunApprovals";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.unstubAllGlobals(); document.body.innerHTML = ""; });
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const approvals = [
  { id: "a1", toolName: "code.data.policies.apply", runId: "run-1", inputPayload: { args: { policies: [{ collection: "leads", rule: "public", actions: ["insert"] }] } } },
  { id: "shell", toolName: "code.shell.exec", runId: "run-1" },
  { id: "other", toolName: "code.fs.delete", runId: "run-2" },
];
async function mount(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<I18nProvider><ChatRunApprovals companyId="c" runId="run-1" /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return host;
}

describe("approvals while the agent waits", () => {
  it("keeps the database card switched off for now", () => {
    expect(SHOW_DATA_APPROVAL_CARDS).toBe(false);
  });

  it("allows this run's database change without showing a card, and records it as an approval", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? reply({ approval: { id: "a1" } }) : reply({ approvals }));
    const host = await mount(fetchMock);
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts.map(([url]) => url)).toEqual(["/api/companies/c/approvals/a1/decide"]);
    expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toEqual({ decision: "approved" });
    expect(host.textContent).not.toContain("leads");
  });

  it("still shows a card for a request that is not a database change, and only for this run", async () => {
    const host = await mount(vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? reply({}) : reply({ approvals })));
    expect(host.querySelectorAll('[data-testid="run-approval"]')).toHaveLength(1);
    expect(host.textContent).toContain("code.shell.exec");
  });
});
