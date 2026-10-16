// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { CodeWorkspacePage } from "../CodeWorkspacePage";

vi.mock("../i18n", () => ({ useTranslation: () => ({ language: "en" }) }));
vi.mock("../code-workspace/AsyncWorkspacePanel", () => ({ AsyncWorkspacePanel: () => null }));
vi.mock("../code-workspace/CodeMetricsPanel", () => ({ CodeMetricsPanel: () => null }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

async function view(check: (state: { host: HTMLDivElement; fetcher: ReturnType<typeof vi.fn>; releaseA: () => void }) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let approvals = [{ id: "approval-a", toolName: "code.fs.edit", command: "same command", diff: "first patch" }, { id: "approval-b", toolName: "code.fs.edit", command: "same command", diff: "second patch" }];
  let releaseA!: () => void;
  const fetcher = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/approvals?")) return json({ approvals });
    if (url.endsWith("/decide")) { approvals = approvals.filter(a => !url.includes(a.id)); return json({}); }
    if (url.endsWith("/mode")) { const data = JSON.parse(String(init?.body)); return json({ session: { mode: data.mode === "auto_edit" ? "auto" : "full_auto", revision: data.expectedRevision + 1 } }); }
    if (url.endsWith("/sessions/s")) return json({ id: "s", status: "active", mode: "edit", revision: 7 });
    if (url.includes("/sessions?")) return json({ sessions: [{ id: "s", projectId: "pr", mode: "edit", status: "active" }] });
    if (url.endsWith("/active-context")) return json({ persisted: true });
    if (url.includes("/files/tree")) return json({ files: [{ path: "a.ts", type: "file" }, { path: "b.ts", type: "file" }] });
    if (url.includes("/files/read")) {
      if (url.includes("a.ts")) return new Promise(resolve => { releaseA = () => resolve(json({ path: "a.ts", content: "LATE_A_CONTENT", revision: "a-revision" })); });
      return json({ path: "b.ts", content: "CURRENT_B_CONTENT", revision: "b-revision" });
    }
    if (url.endsWith("/files/write")) return json({ error: { code: "revision_conflict", message: "File changed by agent" } }, 409);
    return json({ events: [], files: [], status: "stopped" });
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<MemoryRouter initialEntries={["/code/co/pr?session=s&run=r"]}><Routes><Route path="/code/:companyId/:projectId" element={<CodeWorkspacePage />} /></Routes></MemoryRouter>); });
    await check({ host, fetcher, releaseA: () => releaseA() });
  } finally { await act(async () => root.unmount()); }
}

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => (b.textContent?.trim() === label || b.getAttribute("role") === "tab" && b.textContent?.trim().startsWith(label)))!;

it("approves exactly the selected card and leaves another same-command approval visible", async () => {
  await view(async ({ host, fetcher }) => {
    await act(async () => button(host, "Task & Stream").click());
    expect(host.querySelectorAll(".code-approval-card")).toHaveLength(2);
    await act(async () => button(host, "Approve once").click());
    const decisions = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/decide"));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.[0]).toContain("approval-a/decide");
    expect(JSON.parse(String(decisions[0]?.[1]?.body))).toEqual({ decision: "approved" });
    expect(host.querySelectorAll(".code-approval-card")).toHaveLength(1);
    expect(host.textContent).toContain("second patch");
  });
});

it("sends the observed session revision and normalizes persisted modes on every change", async () => {
  await view(async ({ host, fetcher }) => {
    const mode = host.querySelector<HTMLSelectElement>(".composer-options select")!;
    expect(mode.value).toBe("ask");
    for (const value of ["auto_edit", "full_auto_sandbox"]) await act(async () => { mode.value = value; mode.dispatchEvent(new Event("change", { bubbles: true })); });
    const changes = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/mode"));
    expect(changes.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ mode: "auto_edit", expectedRevision: 7 }, { mode: "full_auto_sandbox", expectedRevision: 8 }]);
    expect(mode.value).toBe("full_auto_sandbox");
  });
});

it("uses the creation API mode spelling when starting a new session from a loaded session", async () => {
  await view(async ({ host, fetcher }) => {
    await act(async () => button(host, "+ New session").click());
    const creations = fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/code/sessions") && init?.method === "POST");
    expect(creations).toHaveLength(1);
    expect(JSON.parse(String(creations[0]?.[1]?.body))).toEqual({ mode: "edit" });
  });
});
it("ignores a stale file response and saves the selected file with its own revision", async () => {
  await view(async ({ host, fetcher, releaseA }) => {
    await act(async () => button(host, "Files & Code").click());
    const files = host.querySelectorAll<HTMLButtonElement>(".code-file-tree-item");
    await act(async () => files[0]!.click());
    await act(async () => files[1]!.click());
    await act(async () => releaseA());
    expect(host.querySelector(".project-file-browser-pre")?.textContent).toBe("CURRENT_B_CONTENT");
    expect(host.textContent).not.toContain("LATE_A_CONTENT");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!.click());
    await act(async () => button(host, "Save").click());
    const writes = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/files/write"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({ path: "b.ts", content: "CURRENT_B_CONTENT", expectedRevision: "b-revision" });
    expect(host.textContent).toContain("File changed by agent");
    expect(host.querySelector<HTMLTextAreaElement>(".project-file-browser-textarea")?.value).toBe("CURRENT_B_CONTENT");
  });
});
