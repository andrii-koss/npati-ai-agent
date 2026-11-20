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
const duplicateDomainError = "Enter a valid additional domain different from the primary domain.";

async function view(check: (state: { host: HTMLDivElement; fetcher: ReturnType<typeof vi.fn>; releaseA: () => void }) => Promise<void>, entry = "/code/co/pr?session=s&run=r") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let approvals = [{ id: "approval-a", toolName: "code.fs.edit", command: "same command", diff: "first patch" }, { id: "approval-b", toolName: "code.fs.edit", command: "same command", diff: "second patch" }];
  let releaseA!: () => void;
  const fetcher = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/projects/pr")) return json({ name: "Production site", type: "website" });
    if (url.endsWith("/production?defaults=1")) return json({ enabled: true, release: {
      id: "release-a", runtime: "running", kind: "node", createdAt: "2026-11-19T10:00:00.000Z",
      settings: { limits: { memoryMiB: 512 } }, domains: [{ host: "sample.localhost", url: "http://sample.localhost/", primary: true, certificate: "disabled" }],
    } });
    if (url.includes("/production?metrics=")) return json({ points: [{ at: Date.now() - 1000, cpu: 23, memoryMiB: 42, networkBps: 400 }] });
    if (url.endsWith("/production") && init?.method === "PATCH") return json({ error: { message: duplicateDomainError } }, 400);
    if (url.includes("/approvals?")) return json({ approvals });
    if (url.endsWith("/decide")) { approvals = approvals.filter(a => !url.includes(a.id)); return json({}); }
    if (url.endsWith("/mode")) { const data = JSON.parse(String(init?.body)); return json({ session: { mode: data.mode === "auto_edit" ? "auto" : "full_auto", revision: data.expectedRevision + 1 } }); }
    if (url.endsWith("/sessions/s")) return json({ id: "s", status: "active", mode: "edit", revision: 7 });
    if (url.includes("/sessions?")) return json({ sessions: [{ id: "s", projectId: "pr", mode: "edit", status: "active" }] });
    if (url.endsWith("/active-context")) return json({ persisted: true });
    if (url.includes("/files/tree")) return json({ files: [{ path: "a.ts", type: "file" }, { path: "b.ts", type: "file" }, { path: "index.html", type: "file" }] });
    if (url.includes("/files/read")) {
      if (url.includes("a.ts")) return new Promise(resolve => { releaseA = () => resolve(json({ path: "a.ts", content: "LATE_A_CONTENT", revision: "a-revision" })); });
      if (url.includes("index.html")) return json({ path: "index.html", content: "<h1>Site entry point</h1>", revision: "index-revision" });
      return json({ path: "b.ts", content: "CURRENT_B_CONTENT", revision: "b-revision" });
    }
    if (url.endsWith("/files/write")) return json({ error: { code: "revision_conflict", message: "File changed by agent" } }, 409);
    return json({ events: [], files: [], status: "stopped" });
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<MemoryRouter initialEntries={[entry]}><Routes><Route path="/code/:companyId/:projectId" element={<CodeWorkspacePage />} /></Routes></MemoryRouter>); });
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

it("replaces the requested blocks and keeps the linked file and workspace tabs", async () => {
  await view(async ({ host, fetcher }) => {
    expect(host.textContent).toContain("Production site");
    expect(host.textContent).toContain("sample.localhost");
    expect(host.querySelectorAll(".workspace-resource-grid > article")).toHaveLength(3);
    expect(host.textContent).toContain("23%");
    expect(host.textContent).toContain("42 MiB");
    expect(host.textContent).toContain("400 B/s");
    expect(host.querySelector(".code-task-composer, .email-scope-toolbar, .inspector-stats-grid")).toBeNull();
    expect(host.querySelector(".code-production-bar")).toBeNull();
    expect(button(host, "Files & Code").getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".code-file-tree-item.active")?.textContent).toContain("index.html");
    expect(host.querySelector(".workspace-source-viewer")?.textContent).toContain("Site entry point");
    await act(async () => button(host, "24 hours").click());
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/production?metrics=1440"))).toBe(true);
  }, "/code/co/pr?session=s&run=r&view=files&file=index.html");
});

it("clears a domain validation error after five seconds and keeps the form open", async () => {
  await view(async ({ host, fetcher }) => {
    vi.useFakeTimers();
    try {
      await act(async () => button(host, "Add domain").click());
      const form = host.querySelector<HTMLFormElement>(".workspace-production-domain-form")!;
      const input = form.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "sample.localhost");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        button(form, "Save").click();
      });
      expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/production") && init?.method === "PATCH")).toBe(true);
      expect(form.querySelector('[role="alert"]')?.textContent).toBe(duplicateDomainError);
      await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
      expect(form.querySelector('[role="alert"]')?.textContent).toBe(duplicateDomainError);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(host.textContent).not.toContain(duplicateDomainError);
      expect(form.isConnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("ignores a stale file response and saves the selected file with its own revision", async () => {
  await view(async ({ host, fetcher, releaseA }) => {
    await act(async () => button(host, "Files & Code").click());
    const files = host.querySelectorAll<HTMLButtonElement>(".code-file-tree-item");
    await act(async () => files[0]!.click());
    await act(async () => files[1]!.click());
    await act(async () => releaseA());
    expect(host.querySelector(".workspace-source-viewer .code-line")?.textContent).toBe("CURRENT_B_CONTENT");
    expect(host.textContent).not.toContain("LATE_A_CONTENT");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!.click());
    await act(async () => button(host, "Save").click());
    const writes = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/files/write"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({ path: "b.ts", content: "CURRENT_B_CONTENT", expectedRevision: "b-revision" });
    // V6 step 16: the conflict is said plainly, not as the server's revision_conflict text.
    expect(host.textContent).toContain("The file changed after you opened it");
    expect(host.textContent).not.toContain("revision_conflict");
    expect(host.querySelector<HTMLTextAreaElement>(".project-file-browser-textarea")?.value).toBe("CURRENT_B_CONTENT");
  });
});

// V6 step 18: a reload closed the open file; the file named in the address opens again.
it("opens the file named in the address after a reload", async () => {
  await view(async ({ host, fetcher }) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/files/read") && String(url).includes("b.ts"))).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>(".project-file-browser-textarea")?.value ?? host.textContent).toContain("CURRENT_B_CONTENT");
  }, "/code/co/pr?session=s&run=r&file=b.ts");
});

it.each(["&file=index.html", ""])("opens Files & Code with the site's entry point selected (%s)", async (fileQuery) => {
  await view(async ({ host }) => {
    expect(button(host, "Files & Code").getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".code-file-tree-item.active")?.textContent).toContain("index.html");
    expect(host.querySelector(".workspace-source-viewer")?.textContent).toContain("Site entry point");
  }, `/code/co/pr?session=s&run=r&view=files${fileQuery}`);
});

it("shows the selected terminal at the top of the workspace content", async () => {
  await view(async ({ host, fetcher }) => {
    expect(button(host, "Code changes").getAttribute("aria-selected")).toBe("true");
    expect(button(host, "Terminal").getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".code-file-tree")).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/projects/pr/terminal/events"))).toBe(true);
  }, "/code/co/pr?session=s&run=r&tab=terminal");
});
