import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncOperationsView } from "../AsyncWorkspacePanel";
import { AsyncControlSubmission, asyncRequest, createAsyncObserver, readAsyncWorkspace, type AsyncWorkspaceSnapshot } from "../async-workspace-client";

const snapshot: AsyncWorkspaceSnapshot = { schemaVersion: 1, companyId: "company/a", projectId: "p", sessionId: "session/a",
  capabilities: { inbox: true, controls: true, resume: true, processes: true }, operations: [
    { operationId: "op", processId: "p1", runId: "root", generation: 1, kind: "subagent", state: "interrupted",
      exitCode: null, cancelRequested: false, collected: false, delivered: false, childRunId: "child", agentType: "explore" },
    { operationId: "shell", processId: "p2", runId: "root", generation: 1, kind: "process", state: "running",
      exitCode: null, cancelRequested: false, collected: false, delivered: false },
  ] };
afterEach(() => vi.unstubAllGlobals());
const render = (view = snapshot, stale = false) => renderToStaticMarkup(<AsyncOperationsView snapshot={view} stale={stale} busy={false} isUk={false} onControl={() => {}} onProcess={() => {}} />);
describe("Step 8 unified workspace observation, controls and reconnect", () => {
  it("presents shell processes and children together with their existing controls", () => {
    const html = render(); for (const text of ["child", "p2", "interrupted", "running", "Continue", "Send message", "Interrupt", "Process output", "Stop process"]) expect(html).toContain(text);
  });
  it("escapes producer metadata as text", () => {
    const html = render({ ...snapshot, operations: [{ ...snapshot.operations[0]!, childRunId: '<img src=x onerror="attack()">' }] });
    expect(html).not.toContain("<img"); expect(html).toContain("&lt;img");
  });
  it("disables every action while the authoritative observer is unavailable", () => {
    const html = render(snapshot, true); expect(html).toContain("Controls paused");
    for (const button of html.matchAll(/<button([^>]*)>/g)) expect(button[1]).toContain("disabled");
  });
  it("does not show actions whose flags have been rolled back", () => {
    const html = render({ ...snapshot, capabilities: { inbox: false, controls: false, resume: false, processes: false } });
    expect(html).not.toContain("<button"); expect(html).toContain("interrupted");
  });
  it("keeps unknown outcomes fenced instead of offering Continue", () => {
    const html = render({ ...snapshot, operations: [{ ...snapshot.operations[0]!, state: "unknown_outcome" }] });
    expect(html).toContain("Outcome unknown"); expect(html).toMatch(/disabled="">Continue/);
  });
  it("allows Continue after cooperative Interrupt but respects a parent Stop fence", () => {
    const paused = { ...snapshot, operations: [{ ...snapshot.operations[0]!, cancelRequested: true }] };
    expect(render(paused)).toContain('<button type="button">Continue</button>');
    expect(render({ ...paused, operations: [{ ...paused.operations[0]!, stopRequested: true }] })).toMatch(/disabled="">Continue/);
  });
  it("prevents overlapping polls and ignores a late reply after session change", async () => {
    let release!: (value: string) => void; const read = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const apply = vi.fn(), fail = vi.fn(), observer = createAsyncObserver(read, apply, fail);
    const first = observer.refresh(); await observer.refresh(); expect(read).toHaveBeenCalledOnce();
    observer.close(); release("old tenant"); await first; await observer.refresh(); expect(apply).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce();
  });
  it("reconnects after transport failure with reads only", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(snapshot), apply = vi.fn(), fail = vi.fn();
    const observer = createAsyncObserver(read, apply, fail); await observer.refresh(); await observer.refresh(); observer.close();
    expect(fail).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledWith(snapshot); expect(read).toHaveBeenCalledTimes(2);
  });
  it("retains a failed control request identity and serializes double clicks", () => {
    const pending = new AsyncControlSubmission(), first = pending.begin("same child continuation");
    expect(pending.begin("same child continuation")).toBeNull(); pending.finish(false);
    expect(pending.begin("same child continuation")).toBe(first); pending.finish(true);
    expect(pending.begin("same child continuation")).not.toBe(first);
  });
  it("separates retry identities between tenants and child targets", () => {
    const pending = new AsyncControlSubmission(), first = pending.begin("tenant a / child a"); pending.finish(false);
    expect(pending.begin("tenant b / child a")).not.toBe(first); pending.finish(false);
    expect(pending.begin("tenant a / child b")).not.toBe(first);
  });
  it("encodes scope, sends authenticated GET and refuses a mismatched response", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "token" }); vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(snapshot))).mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, sessionId: "foreign" })));
    vi.stubGlobal("fetch", fetch); const signal = new AbortController().signal;
    expect(await readAsyncWorkspace(snapshot, signal)).toEqual(snapshot);
    expect(fetch.mock.calls[0]).toEqual(["/api/companies/company%2Fa/projects/p/code/sessions/session%2Fa/async-workspace", expect.objectContaining({ method: "GET", signal, headers: { authorization: "Bearer token" } })]);
    await expect(readAsyncWorkspace(snapshot, signal)).rejects.toThrow("async_workspace_scope_mismatch");
  });
  it("preserves canonical policy errors without converting them into successful UI actions", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null }); vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "approval_required" } }), { status: 403 })));
    await expect(asyncRequest("/existing/tools/invoke", new AbortController().signal, { tool: "code.shell.process.stop" })).rejects.toMatchObject({ code: "approval_required", status: 403 });
  });
});
