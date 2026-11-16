// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeProjectsTable, CodeSessionsTable } from "./CodeRecordsTables";
import { promptModal } from "../ConfirmDialog";
import type { CodeProject, CodeSession } from "./types";
vi.mock("../ConfirmDialog", () => ({ promptModal: vi.fn() }));
let host: HTMLDivElement, root: Root;
const projects: CodeProject[] = Array.from({ length: 12 }, (_, index) => ({
  id: `project-${index}`, name: `Project ${index}`, revision: index + 1, status: "ready",
}));
const sessions: CodeSession[] = projects.map((project, index) => ({ id: `session-${index}`, projectId: project.id, status: "active" }));
const api = vi.fn(), changed = vi.fn(), open = vi.fn(), archive = vi.fn();
const common = () => ({ companyId: "company-a", isUk: false, readOnly: false, busyId: null, api, onChanged: changed });
beforeEach(() => {
  vi.clearAllMocks(); api.mockResolvedValue({ status: "deleted" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(items = projects, readOnly = false) {
  await act(async () => root.render(<CodeProjectsTable {...common()} readOnly={readOnly} items={items}
    onDetails={open} onDetect={open} onSessions={open} onArchive={archive} />));
}
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const masterCheckbox = () => host.querySelector<HTMLInputElement>('.code-records-toolbar input[type="checkbox"]')!;
const rows = () => host.querySelectorAll("tbody tr");
async function click(element: HTMLElement) { expect(element).toBeTruthy(); await act(async () => element.click()); }

describe("Code project and session table controls", () => {
  it("routes mixed-company bulk actions to each record's owner", async () => {
    await render(projects.slice(0, 2).map((item, index) => ({ ...item, companyId: index === 0 ? "owner-a" : "owner-b" })));
    await click(masterCheckbox());
    vi.mocked(promptModal).mockResolvedValueOnce("delete");
    await click(button("Delete selected"));
    expect(api.mock.calls.map(call => call[0])).toEqual(["/companies/owner-a/code/projects/project-0", "/companies/owner-b/code/projects/project-1"]);
  });
  it("paginates by five, preserves selection across pages and selects all twelve records", async () => {
    await render();
    expect(rows()).toHaveLength(5);
    expect(host.querySelectorAll('.code-records-toolbar input[type="checkbox"]')).toHaveLength(1);
    expect(host.querySelector('thead input[type="checkbox"]')).toBeNull();
    expect(masterCheckbox().checked).toBe(false);
    await click(host.querySelector<HTMLInputElement>('input[aria-label="Select Project 0"]')!);
    expect(masterCheckbox().indeterminate).toBe(true);
    await click(button("Next page"));
    expect(rows()).toHaveLength(5);
    expect(rows()[0]?.textContent).toContain("Project 5");
    await click(button("Previous page"));
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Select Project 0"]')?.checked).toBe(true);
    await click(masterCheckbox());
    expect(masterCheckbox().checked).toBe(true);
    expect(masterCheckbox().indeterminate).toBe(false);
    expect(host.querySelector(".code-records-count")?.textContent).toBe("12 / 12");
    await click(button("Next page")); await click(button("Next page"));
    expect(rows()).toHaveLength(2);
    expect(button("Next page").disabled).toBe(true);
    await click(masterCheckbox());
    expect(host.querySelector(".code-records-count")?.textContent).toBe("12");
    expect(masterCheckbox().checked).toBe(false);
    expect([...host.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')].every(input => !input.checked)).toBe(true);
    await click(button("Previous page")); await click(button("Previous page"));
    expect([...host.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')].every(input => !input.checked)).toBe(true);
  });

  it("collapses, expands, opens fullscreen and restores document scrolling on Escape", async () => {
    await render();
    await click(button("Collapse table"));
    expect(host.querySelector<HTMLElement>(".code-records-content")?.hidden).toBe(true);
    await click(button("Fullscreen"));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelector<HTMLElement>(".code-records-content")?.hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("fits fullscreen rows to available height and restores five rows on exit", async () => {
    let availableHeight = 680;
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("automations-table-container") ? availableHeight : 0;
    });
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 900, 40));
    try {
      await render();
      expect(rows()).toHaveLength(5);
      await click(host.querySelector<HTMLInputElement>('input[aria-label="Select Project 0"]')!);
      await click(button("Fullscreen"));
      expect(rows()).toHaveLength(12);
      expect(button("Next page").disabled).toBe(true);
      availableHeight = 400;
      await act(async () => window.dispatchEvent(new Event("resize")));
      expect(rows()).toHaveLength(8);
      expect(button("Next page").disabled).toBe(false);
      await click(button("Exit fullscreen"));
      expect(rows()).toHaveLength(5);
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Select Project 0"]')?.checked).toBe(true);
    } finally { height.mockRestore(); bounds.mockRestore(); }
  });

  it("cancels deletion, then deletes all selected projects using confirmed scoped requests", async () => {
    await render(); await click(masterCheckbox());
    vi.mocked(promptModal).mockResolvedValueOnce(null);
    await click(button("Delete selected"));
    expect(api).not.toHaveBeenCalled();
    vi.mocked(promptModal).mockResolvedValueOnce("delete");
    await click(button("Delete selected"));
    expect(api).toHaveBeenCalledTimes(12);
    expect(api).toHaveBeenCalledWith("/companies/company-a/code/projects/project-0", {
      method: "DELETE", body: JSON.stringify({ confirm: true }),
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(host.querySelector(".code-records-count")?.textContent).toBe("12");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Completed: 12 / 12.");
  });

  it("retains failed selections and does not report partial erasure as success", async () => {
    api.mockImplementation(async (path: string) => path.endsWith("project-1") ? { status: "partial", verified: false } : { status: "deleted" });
    await render(projects.slice(0, 3)); await click(masterCheckbox());
    vi.mocked(promptModal).mockResolvedValueOnce("delete");
    await click(button("Delete selected"));
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Select Project 1"]')?.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Select Project 0"]')?.checked).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Completed: 2 / 3.");
  });

  it("archives selected projects with each project's own revision", async () => {
    await render(projects.slice(0, 2)); await click(masterCheckbox());
    vi.mocked(promptModal).mockResolvedValueOnce("archive");
    await click(button("Archive selected"));
    expect(api).toHaveBeenNthCalledWith(1, "/companies/company-a/projects/project-0/archive", { method: "POST", body: JSON.stringify({ expectedRevision: 1 }) });
    expect(api).toHaveBeenNthCalledWith(2, "/companies/company-a/projects/project-1/archive", { method: "POST", body: JSON.stringify({ expectedRevision: 2 }) });
  });

  it("uses the session erasure endpoint and keeps the project source outside its deletion scope", async () => {
    await act(async () => root.render(<CodeSessionsTable {...common()} items={sessions.slice(0, 2)} projects={projects} onOpen={open} onArchive={archive} />));
    await click(masterCheckbox()); vi.mocked(promptModal).mockResolvedValueOnce("delete");
    await click(button("Delete selected"));
    expect(api).toHaveBeenNthCalledWith(1, "/companies/company-a/code/sessions/session-0/data", { method: "DELETE", body: JSON.stringify({ confirm: true }) });
    expect(api).toHaveBeenCalledTimes(2);
    expect(host.querySelector("button")?.textContent).toBe("");
  });

  it("selects and clears every session across pages using one master checkbox", async () => {
    await act(async () => root.render(<CodeSessionsTable {...common()} items={sessions} projects={projects} onOpen={open} onArchive={archive} />));
    expect(host.querySelectorAll('.code-records-toolbar input[type="checkbox"]')).toHaveLength(1);
    expect(host.querySelector('thead input[type="checkbox"]')).toBeNull();
    await click(masterCheckbox());
    expect(host.querySelector(".code-records-count")?.textContent).toBe("12 / 12");
    await click(button("Next page"));
    expect([...host.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')].every(input => input.checked)).toBe(true);
    await click(masterCheckbox());
    expect(host.querySelector(".code-records-count")?.textContent).toBe("12");
    await click(button("Previous page"));
    expect([...host.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')].every(input => !input.checked)).toBe(true);
    expect(api).not.toHaveBeenCalled();
  });

  it("honors read-only mode and never sends mutation requests", async () => {
    await render(projects, true); await click(masterCheckbox());
    expect(button("Delete selected").disabled).toBe(true);
    expect(button("Archive selected").disabled).toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(button("Fullscreen").disabled).toBe(false);
  });
});
