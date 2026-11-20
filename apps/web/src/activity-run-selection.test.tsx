// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { monitorCodeRun } from "@npati/shared";
import { ActivityPage } from "./ActivityPage";
import type { ActivityDetail } from "./activity-page-read";
import { I18nProvider } from "./i18n";

vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "activity-run-selection-test" }));

it("replaces the coding trace when switching between runs of one project in All companies", async () => {
  const runs = ["run-latest", "run-earlier"].map((id, index) => ({
    id, companyId: "company", projectId: "project", requestedMode: "coding", status: "completed",
    task: "Coding project", createdAt: new Date(Date.UTC(2026, 10, 20, 15, 14 - index)).toISOString(),
  }));
  function runDetail(run: typeof runs[number]): ActivityDetail {
    const events = [{ id: run.id, runId: run.id, stage: "run", title: run.id + " event", status: "completed" as const, at: run.createdAt }];
    const summary = monitorCodeRun(events, { status: run.status, startedAt: run.createdAt, finishedAt: run.createdAt });
    return {
      runId: run.id, agent: null,
      code: { run, events, summary, page: { total: 1, nextCursor: null } },
      snapshot: { snapshot: { status: "legacy_no_snapshot" }, replay: null, trust: null },
    };
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/activity/page") {
      expect(url.searchParams.has("company")).toBe(false);
      return Response.json({
        companies: [{ id: "company", name: "Company" }], items: runs, selected: runs[0], detail: runDetail(runs[0]!),
        matchingTotal: 2, nextCursor: null, counts: { total: 2, completed: 2, running: 0, failed: 0 },
      });
    }
    const run = runs.find(run => url.pathname === `/api/activity/${run.companyId}/runs/${run.id}`);
    return run ? Response.json(runDetail(run)) : new Response(null, { status: 404 });
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><ActivityPage /></I18nProvider></MemoryRouter>));
    const getDisplayedIds = () => Array.from(
      host.querySelectorAll(".activity-trace-detail .trace-card-header code"), element => element.textContent,
    );
    expect(getDisplayedIds()).toEqual(["run-latest"]);
    const rows = host.querySelectorAll<HTMLButtonElement>(".activity-run-item");
    await act(async () => rows[1]!.click());
    expect(getDisplayedIds()).toEqual(["run-earlier"]);
    await act(async () => rows[0]!.click());
    expect(getDisplayedIds()).toEqual(["run-latest"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
