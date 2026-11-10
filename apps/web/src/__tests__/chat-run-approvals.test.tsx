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

const settingOff = { autoAllow: false, revision: 3, canChange: true };
function server(extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  return vi.fn(async (url: string, init?: RequestInit) => extra(url, init)
    ?? (url.endsWith("/chat/data-auto-allow") ? reply(settingOff) : init?.method === "POST" ? reply({}) : reply({ approvals })));
}
const posts = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([, init]) => ["POST", "PUT"].includes(String((init as RequestInit | undefined)?.method)));

describe("approvals while the agent waits", () => {
  it("shows the database card and does not allow anything by itself", async () => {
    const fetchMock = server();
    const host = await mount(fetchMock);
    expect(posts(fetchMock)).toEqual([]);
    expect(host.querySelectorAll('[data-testid="run-approval"]')).toHaveLength(2);
    expect(host.textContent).toContain("leads");
    expect(host.textContent).toContain("code.shell.exec");
    expect(host.textContent).not.toContain("code.fs.delete");
  });

  it("describes a row change as the change itself, not a tool name", async () => {
    const update = { id: "u1", toolName: "code.data.rows.update", runId: "run-1", inputPayload: { args: { collection: "products", values: { price: 95 }, filters: [{ field: "title", operator: "eq", value: "Круасан" }] } } };
    const host = await mount(server(url => url.includes("/approvals?") ? reply({ approvals: [update] }) : undefined));
    expect(host.textContent).toContain('In products set price = 95 where title eq "Круасан".');
    expect(host.textContent).not.toContain("code.data.rows.update");
  });

  it("offers to stop asking only on a database card, and only to someone who may change the setting", async () => {
    const host = await mount(server());
    expect(host.querySelectorAll('[data-testid="run-approval-always"]')).toHaveLength(1);
    const readOnly = await (async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = "";
      return mount(server(url => url.endsWith("/chat/data-auto-allow") ? reply({ ...settingOff, canChange: false }) : undefined)); })();
    expect(readOnly.querySelectorAll('[data-testid="run-approval-always"]')).toHaveLength(0);
  });

  it("'allow and don't ask again' turns the company setting on and allows this one change", async () => {
    const fetchMock = server();
    const host = await mount(fetchMock);
    const button = host.querySelector<HTMLButtonElement>('[data-testid="run-approval-always"]')!;
    await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    const sent = posts(fetchMock);
    expect(sent.map(([url, init]) => [(init as RequestInit).method, url])).toEqual([
      ["PUT", "/api/companies/c/chat/data-auto-allow"],
      ["POST", "/api/companies/c/approvals/a1/decide"],
    ]);
    expect(JSON.parse(String((sent[0]![1] as RequestInit).body))).toEqual({ autoAllow: true, expectedRevision: 3 });
    expect(JSON.parse(String((sent[1]![1] as RequestInit).body))).toEqual({ decision: "approved" });
    expect(host.textContent).not.toContain("leads");
  });
});
