// @vitest-environment jsdom
import React, { useContext, useEffect } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFileViewerContext, ChatFileViewerProvider } from "../ChatFileViewer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.unstubAllGlobals(); document.body.innerHTML = ""; });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function Opener() {
  const open = useContext(ChatFileViewerContext)!;
  useEffect(() => open({ companyId: "c", projectId: "p", path: "src/a.ts" }), [open]);
  return null;
}
async function mount(busy = false) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<ChatFileViewerProvider busy={busy}><Opener /></ChatFileViewerProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return document.querySelector<HTMLTextAreaElement>(".chat-file-text")!;
}
async function type(area: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const save = () => document.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!;

describe("chat file panel", () => {
  it("opens in the Live Preview drawer and saves with the revision it read", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => url.includes("apply-file-changes") ? reply(200, { status: "running", rebuilt: false }) : init?.method === "POST" ? reply(200, { content: "two", revision: "r2" }) : reply(200, { content: "one\nline", revision: "r1" }));
    vi.stubGlobal("fetch", fetchMock);
    const area = await mount();
    expect(document.querySelector(".project-chat-preview-layer .project-chat-preview-drawer")).not.toBeNull();
    expect(area.value).toBe("one\nline");
    expect(document.querySelector(".chat-file-gutter")!.textContent).toBe("1\n2");
    expect(save().disabled).toBe(true);
    await type(area, "two");
    await act(async () => save().click());
    const write = fetchMock.mock.calls.find(([url]) => url.includes("files/write"))!;
    expect(JSON.parse(String(write[1]!.body))).toEqual({ path: "src/a.ts", content: "two", expectedRevision: "r1" });
    expect(save().disabled).toBe(true);
    expect(fetchMock.mock.calls.at(-1)![0]).toContain("/projects/p/preview/apply-file-changes");
  });

  it("keeps the save and says so when Preview cannot be updated", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => url.includes("apply-file-changes") ? reply(500, { error: { message: "no sandbox" } }) : init?.method === "POST" ? reply(200, { content: "two", revision: "r2" }) : reply(200, { content: "one", revision: "r1" })));
    const area = await mount();
    await type(area, "two");
    await act(async () => { save().click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(document.querySelector(".chat-file-error")!.textContent).toContain("The file is saved");
    expect(save().disabled).toBe(true);
  });

  it("tells the user instead of overwriting a newer version", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? reply(409, { error: { code: "revision_conflict", message: "Project file revision changed" } }) : reply(200, { content: "one", revision: "r1" })));
    const area = await mount();
    await type(area, "two");
    await act(async () => save().click());
    expect(document.querySelector(".chat-file-error")!.textContent).toContain("changed after you opened it");
    expect(area.value).toBe("two");
  });

  it("is read-only while the agent changes the project", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { content: "one", revision: "r1" })));
    expect((await mount(true)).readOnly).toBe(true);
  });
});

describe("chat file panel: the agent's changes", () => {
  function RunOpener() {
    const open = useContext(ChatFileViewerContext)!;
    useEffect(() => open({ companyId: "c", projectId: "p", path: "styles.css", runId: "run-1" }), [open]);
    return null;
  }
  async function mountRun(before: unknown, status = 200) {
    const fetchMock = vi.fn(async (url: string) => url.includes("files/before-run") ? reply(status, before) : reply(200, { content: "body {}\nh1 { color: red; }\np {}", revision: "r1" }));
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<ChatFileViewerProvider busy={false}><RunOpener /></ChatFileViewerProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    return fetchMock;
  }

  it("marks the lines the run changed and shows what they were", async () => {
    const fetchMock = await mountRun({ content: "body {}\nh1 { color: blue; }" });
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/projects/p/files/before-run?path=styles.css&runId=run-1"))).toBe(true);
    expect([...document.querySelectorAll(".chat-file-mark")].map(mark => mark.className)).toEqual(["chat-file-mark is-modified", "chat-file-mark is-modified"]);
    expect(document.querySelector(".chat-file-change-count")!.textContent).toBe("+2-1");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Show changes: before and after"]')!.click());
    const lines = [...document.querySelectorAll(".chat-file-diff-line")].map(line => line.className.replace("chat-file-diff-line is-", "") + ":" + line.querySelector(".chat-file-diff-text")!.textContent);
    expect(lines).toEqual(["equal:body {}", "del:h1 { color: blue; }", "add:h1 { color: red; }", "add:p {}"]);
  });

  it("shows the file without marks when the run has no checkpoint", async () => {
    await mountRun({ error: { code: "checkpoint_not_found" } }, 404);
    expect(document.querySelector(".chat-file-text")).not.toBeNull();
    expect(document.querySelector(".chat-file-mark")).toBeNull();
    expect(document.querySelector('button[aria-label="Show changes: before and after"]')).toBeNull();
  });
});
