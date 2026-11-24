// @vitest-environment jsdom
import React, { useContext } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChatFileViewerContext, ChatFileViewerProvider, preloadChatFile, type ChatFileTarget } from "../ChatFileViewer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.unstubAllGlobals(); document.body.innerHTML = ""; });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const files: Record<string, string> = { "index.html": "<h1>index</h1>", "styles.css": "body { color: red; }", "app.js": "console.log('app');" };
const before: Record<string, string> = { "index.html": "<h1>old</h1>", "styles.css": "body {}", "app.js": "// old" };
let openFile: ((target: ChatFileTarget) => void) | null = null;
function Grab() { openFile = useContext(ChatFileViewerContext); return null; }
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

// Opening one file after another from the chat showed the same code in every file.
it("shows each opened file's own code, also after hovering every file first", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = decodeURIComponent(/path=([^&]+)/.exec(url)![1]!);
    return url.includes("before-run") ? reply(200, { content: before[path] }) : reply(200, { content: files[path], revision: "r-" + path });
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<ChatFileViewerProvider busy={false}><Grab /></ChatFileViewerProvider>));
  for (const path of Object.keys(files)) preloadChatFile({ companyId: "c", projectId: "p", path });
  await flush();
  for (const path of ["styles.css", "app.js", "index.html", "styles.css"]) {
    await act(async () => openFile!({ companyId: "c", projectId: "p", path, runId: "run-1" }));
    await flush();
    expect(document.querySelector<HTMLTextAreaElement>(".chat-file-text")!.value).toBe(files[path]);
    expect(document.querySelector(".preview-header-project-name")!.textContent).toBe(path);
  }
});
