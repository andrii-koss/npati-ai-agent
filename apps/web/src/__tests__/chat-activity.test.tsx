// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DevelopmentProcess } from "@npati/shared";
import { I18nProvider } from "../i18n";
import { conversationActivity, publishChatProcesses, registerChatTurn, stopConversationActivity, useChatActivity } from "../chat-activity";
import { ConversationRow } from "../shell/SidebarItemRows";

let root: Root;
let host: HTMLDivElement;
let reportedProcesses: DevelopmentProcess[] = [];
const opened = vi.fn();
const process = (id: string, chat: string, status: DevelopmentProcess["status"] = "running"): DevelopmentProcess => ({ id, conversationId: chat, parentConversationId: "root-" + chat, companyId: "company", name: id, framework: "HTML/CSS", status, hidden: true, createdAt: "", updatedAt: "" });
const publish = (processes: DevelopmentProcess[]) => { reportedProcesses = processes; publishChatProcesses(processes); };
const fetchMock = () => vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === "POST") {
    const id = decodeURIComponent(String(url).split("/").at(-2)!);
    reportedProcesses = reportedProcesses.map(process => process.id === id ? { ...process, status: "stopping" } : process);
  }
  return new Response(JSON.stringify({ processes: reportedProcesses }));
});
function Harness() {
  const state = useChatActivity();
  return <>{["alpha", "beta", "idle", "root-alpha"].map(id => <ConversationRow key={id}
    conversation={{ id, title: id, updatedAt: "2026-11-02", businessId: null, businessName: "" }}
    isActive={false} isPinned={false} isMenuOpen={false} onOpen={opened} onTogglePin={vi.fn()} onOptionsClick={vi.fn()}
    activity={conversationActivity(state, id)} onStop={() => { void stopConversationActivity(id); }} />)}</>;
}
const button = (chat: string) => [...host.querySelectorAll<HTMLButtonElement>(".sidebar-chat-activity")].find(button => button.getAttribute("aria-label")?.endsWith(": " + chat));
async function render() { await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>)); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  publish([]); opened.mockClear();
  vi.stubGlobal("fetch", fetchMock());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows only active work, including hidden tasks, and stops the clicked chat without navigation", async () => {
  const a = process("job/a", "alpha"), b = process("job-b", "beta");
  publish([a, b, process("done", "idle", "completed"), process("binding", "idle", "idle")]);
  await render();
  expect(button("alpha")).toBeDefined(); expect(button("beta")).toBeDefined(); expect(button("idle")).toBeUndefined();
  expect(button("alpha")?.querySelector(".sidebar-chat-spinner")).not.toBeNull();
  expect(button("alpha")?.querySelector(".sidebar-chat-stop")).not.toBeNull();
  await act(async () => button("alpha")!.click());
  expect(fetch).toHaveBeenCalledWith("/api/chat/development/processes/job%2Fa/stop", expect.objectContaining({ method: "POST" }));
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(opened).not.toHaveBeenCalled();
  expect(button("alpha")?.disabled).toBe(true); expect(button("beta")?.disabled).toBe(false);
  await act(async () => publish([{ ...a, status: "cancelled" }, b]));
  expect(button("alpha")).toBeUndefined(); expect(button("beta")).toBeDefined();
});

it("keeps failed stops visible and allows retry", async () => {
  publish([process("failed-job", "alpha")]); await render();
  vi.mocked(fetch).mockResolvedValueOnce(new Response("failed", { status: 500 }));
  await act(async () => button("alpha")!.click());
  expect(button("alpha")?.disabled).toBe(false);
  expect(button("alpha")?.title).toMatch(/Try again|ще раз/);
  await act(async () => button("alpha")!.click());
  expect(button("alpha")?.disabled).toBe(true);
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
});

it("stops every associated task in a parent chat and preserves an unrelated chat", async () => {
  publish([process("first", "alpha"), { ...process("second", "child"), parentConversationId: "root-alpha" }, process("foreign", "beta")]);
  await render(); await act(async () => button("root-alpha")!.click());
  const stopped = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => url);
  expect(stopped.sort()).toEqual(["/api/chat/development/processes/first/stop", "/api/chat/development/processes/second/stop"]);
  expect(button("beta")?.disabled).toBe(false);
});

it("does not stop a task added after the user clicked Stop", async () => {
  const a = process("original", "alpha"); publish([a]); await render();
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => button("alpha")!.click());
  expect(button("alpha")?.disabled).toBe(true);
  await act(async () => { publish([a, process("new", "alpha")]); release(new Response("{}")); });
  expect(button("alpha")?.disabled).toBe(false);
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("shows an ordinary streaming reply and invokes only that chat's cancellation", async () => {
  const stopA = vi.fn(async () => {}), stopB = vi.fn(async () => {});
  const unregisterA = registerChatTurn("alpha", stopA), unregisterB = registerChatTurn("beta", stopB);
  try {
    await render(); await act(async () => button("alpha")!.click());
    expect(stopA).toHaveBeenCalledOnce(); expect(stopB).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await act(async () => unregisterA());
    expect(button("alpha")).toBeUndefined(); expect(button("beta")).toBeDefined();
  } finally { await act(async () => { unregisterA(); unregisterB(); }); }
});

it("refreshes metadata only when chat snapshots are stale and ignores older responses", async () => {
  vi.useFakeTimers(); await render();
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(fetch).toHaveBeenCalledWith("/api/chat/development/processes?conversationId=", expect.anything());
  await act(async () => { publish([process("newer", "beta")]); release(new Response(JSON.stringify({ processes: [] }))); });
  expect(button("beta")).toBeDefined();
});
