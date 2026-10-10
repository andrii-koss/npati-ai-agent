import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxSubmission, inboxActive, requestCodeInbox, type CodeChatSession, type InboxSnapshot } from "./code-inbox-client";
import { CodePendingMessages } from "./CodePendingMessages";
import { streamChat } from "./chat-stream";
import { uk } from "./i18n/locales/uk";

const session: CodeChatSession = { companyId: "company/a", projectId: "p", sessionId: "session/a", inboxEnabled: true };
const snapshot: InboxSnapshot = { revision: 3, phase: "running", runId: "auth-run", lastError: null, messages: [] };
afterEach(() => vi.unstubAllGlobals());
function browser() {
  vi.stubGlobal("localStorage", { getItem: () => "token" });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
}

describe("Step 2 coding inbox transport and presentation", () => {
  it("receives a Coding Session identity before auth finishes, sends database to inbox and keeps the original stream", async () => {
    browser();
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: code_session\ndata: ${JSON.stringify(session)}\n\n`));
      finish = () => { controller.enqueue(new TextEncoder().encode('event: result\ndata: {"message":"Auth checked","conversationId":"same-chat"}\n\n')); controller.close(); };
    } });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => url === "/api/chat/stream"
      ? new Response(body) : new Response(JSON.stringify({ ...snapshot, receipt: { target: "next-step" } }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    let received!: (session: CodeChatSession) => void;
    const ready = new Promise<CodeChatSession>((resolve) => { received = resolve; });
    const original = streamChat<{ message: string; conversationId: string }>({ message: "Fix auth" }, () => {}, { onCodeSession: received });
    const identity = await ready;
    for (const mode of ["queue", "steer"] as const) {
      const next = await requestCodeInbox(identity, "POST", { requestId: mode, text: "Check database", mode });
      expect(next.receipt?.target).toBe("next-step"); // The server receipt, not the requested mode, is authoritative.
    }
    expect(fetch.mock.calls.filter(([url]) => url === "/api/chat/stream")).toHaveLength(1);
    const inboxCalls = fetch.mock.calls.filter(([url]) => url !== "/api/chat/stream");
    expect(inboxCalls.map(([, init]) => JSON.parse(String(init?.body)).mode)).toEqual(["queue", "steer"]);
    expect(inboxCalls[0]![0]).toBe("/api/companies/company%2Fa/code/sessions/session%2Fa/messages");
    expect(inboxCalls[0]![1]?.headers).toMatchObject({ authorization: "Bearer token" });
    finish();
    expect(await original).toEqual({ message: "Auth checked", conversationId: "same-chat" });
  });
  it("keeps the same request id after ambiguous failure and admits only one simultaneous submit", () => {
    const submission = new InboxSubmission();
    const first = submission.begin(session, "database", "steer")!;
    expect(submission.begin(session, "database", "steer")).toBeNull();
    submission.finish(false);
    expect(submission.begin(session, "database", "steer")?.requestId).toBe(first.requestId);
    submission.finish(true);
    expect(submission.begin(session, "database", "steer")?.requestId).not.toBe(first.requestId);
  });
  it("gives changed payload or session a new request identity", () => {
    const submission = new InboxSubmission();
    const first = submission.begin(session, "database", "queue")!;
    submission.finish(false);
    const changed = submission.begin(session, "database", "steer")!;
    expect(changed.requestId).not.toBe(first.requestId);
    submission.finish(false);
    expect(submission.begin({ ...session, sessionId: "other" }, "database", "steer")?.requestId).not.toBe(changed.requestId);
  });
  it("never clears a newer draft or applies an acknowledgement to a different chat", async () => {
    browser();
    let complete!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; })));
    for (const change of ["draft", "chat"] as const) {
      let version = 1, generation = 1;
      const apply = vi.fn(), clear = vi.fn();
      const pending = new InboxSubmission().send(session, "database", "steer", {
        version, generation, currentVersion: () => version, currentGeneration: () => generation, apply, clear,
      });
      if (change === "draft") version++;
      else generation++;
      complete(new Response(JSON.stringify(snapshot), { status: 202 }));
      expect(await pending).toBe(true);
      expect(clear).not.toHaveBeenCalled();
      expect(apply).toHaveBeenCalledTimes(change === "draft" ? 1 : 0);
    }
  });
  it("retains a failed draft and retry id, then clears only that draft after acceptance", async () => {
    browser();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, receipt: { target: "next-turn" } }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const submission = new InboxSubmission(), apply = vi.fn(), clear = vi.fn();
    const draft = { version: 1, generation: 1, currentVersion: () => 1, currentGeneration: () => 1, apply, clear };
    await expect(submission.send(session, "database", "steer", draft)).rejects.toThrow("network lost");
    expect(clear).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    await submission.send(session, "database", "steer", draft);
    expect(clear).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]![0].receipt.target).toBe("next-turn");
    const requests = fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(requests[1].requestId).toBe(requests[0].requestId);
  });
  it("reads authoritative state after reconnect and sends message revisions on edit/remove", async () => {
    browser();
    const fetch = vi.fn(async () => new Response(JSON.stringify(snapshot)));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await requestCodeInbox(session, "GET", undefined, undefined, signal);
    await requestCodeInbox(session, "PUT", { text: "new text", expectedRevision: 2 }, "message/1");
    await requestCodeInbox(session, "DELETE", { expectedRevision: 3 }, "message/1");
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![1].signal).toBe(signal);
    expect(calls[1]![0].endsWith("/messages/message%2F1")).toBe(true);
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ text: "new text", expectedRevision: 2 });
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ expectedRevision: 3 });
  });
  it("reports RBAC/claim conflicts instead of fabricating success", async () => {
    browser(); vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "inbox_conflict" } }), { status: 409 })));
    await expect(requestCodeInbox(session, "DELETE", { expectedRevision: 1 }, "claimed")).rejects.toMatchObject({ status: 409, message: "inbox_conflict" });
  });
  it("renders text as escaped content and only offers pending-message edits", () => {
    const t = (key: string) => key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], uk) as string;
    const render = (status: "pending" | "claimed") => renderToStaticMarkup(<CodePendingMessages t={t} busy={false} error="" onChange={async () => true}
      snapshot={{ ...snapshot, messages: [{ id: "m", requestId: "r", text: '<img src=x onerror="attack()">', target: "next-turn", status, revision: 1, runId: null }] }} />);
    expect(render("pending")).not.toContain("<img");
    expect(render("pending")).toContain("&lt;img");
    expect(render("pending")).toContain(uk.common.edit);
    expect(render("claimed")).not.toContain("<button");
    expect(render("claimed")).toContain(uk.codeInbox.queue);
  });
  it("continues treating queued tasks as active after the first SSE ends", () => {
    expect(inboxActive({ ...snapshot, phase: "idle", messages: [{ id: "m", requestId: "r", text: "database", target: "next-turn", status: "pending", revision: 1, runId: null }] })).toBe(true);
    expect(inboxActive({ ...snapshot, phase: "settled" })).toBe(false);
  });
  it("shows completion availability without exposing output or user edit controls", () => {
    const t = (key: string) => key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], uk) as string;
    const markup = renderToStaticMarkup(<CodePendingMessages t={t} busy={false} error="" onChange={async () => true}
      snapshot={{ ...snapshot, messages: [{ id: "completion", requestId: "completion", text: "internal result reference", target: "next-turn", status: "pending", revision: 1, runId: null,
        completion: { eventId: "event", processId: "process", resultRef: "ref", status: "completed" } }] }} />);
    expect(markup).toContain(uk.codeInbox.completion);
    expect(markup).not.toContain("internal result reference"); expect(markup).not.toContain("<button");
  });
  it("keeps legacy non-code SSE and consumers without new callbacks compatible", async () => {
    browser();
    const response = (events: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(events)));
    response('event: delta\ndata: {"delta":"hello"}\n\nevent: result\ndata: {"message":"hello"}\n\n');
    const delta = vi.fn();
    expect(await streamChat({ message: "Hello" }, () => {}, { onDelta: delta })).toEqual({ message: "hello" });
    expect(delta).toHaveBeenCalledWith("hello");
    response(`event: code_session\ndata: ${JSON.stringify(session)}\n\nevent: result\ndata: {"message":"auth"}`);
    expect(await streamChat({ message: "auth" }, () => {})).toEqual({ message: "auth" });
  });
  it("handles revision notifications split across SSE chunks and a final block without a delimiter", async () => {
    browser();
    const pieces = ['event: code_inbox\ndata: {"sessionId":"s","rev', 'ision":4}\n\nevent: result\ndata: {"message":"ok"}\n\nevent: code_inbox\ndata: {"sessionId":"s","revision":5}'];
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece)); controller.close(); } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const changed = vi.fn();
    await streamChat({ message: "auth" }, () => {}, { onCodeInbox: changed });
    expect(changed.mock.calls).toEqual([["s", 4], ["s", 5]]);
  });
});
