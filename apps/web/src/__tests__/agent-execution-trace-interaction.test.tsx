// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentExecutionTrace } from "../AgentExecutionTrace";
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });
async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<AgentExecutionTrace items={[{ id: "call", stage: "command", title: "Build", command: "npm run build -- token=short", result: "a".repeat(5000) + " password=p", status: "running", at: "" }]} />));
  return host;
}
describe("execution row interaction", () => {
  it("keeps expansion and DOM identity across live completion, failed parallel operations and malformed payloads", async () => {
    const host=await mount();const header=host.querySelector<HTMLButtonElement>(".codex-trace-row-header")!;
    await act(async()=>header.click());
    await act(async()=>root!.render(<AgentExecutionTrace items={[null as never,{id:"call",stage:"command",title:"Build",status:"completed",at:"",result:"built",command:"npm run build"},{id:"other",stage:"tool",title:"Tests",status:"failed",at:"",error:"test failed"}]} />));
    expect(host.querySelector(".codex-trace-row-header")).toBe(header);expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll(".codex-trace-row")).toHaveLength(2);expect(host.querySelector('[data-status="failed"]')).not.toBeNull();
    expect(host.querySelector(".research-active-text")).toBeNull();expect(host.textContent).toContain("built");
  });
  it("expands on click without hover, collapses, and retains live details", async () => {
    const host = await mount(); const header = host.querySelector<HTMLButtonElement>(".codex-trace-row-header")!;
    expect(header.tagName).toBe("BUTTON"); expect(header.getAttribute("aria-expanded")).toBe("false");
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("true"); expect(host.querySelector(".codex-trace-collapse")?.hasAttribute("inert")).toBe(false);
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false"); expect(host.querySelector(".codex-trace-collapse")?.hasAttribute("inert")).toBe(true);
  });
  it("copies sanitized data, expands bounded output and handles clipboard failure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const host = await mount();
    await act(async () => host.querySelector<HTMLButtonElement>(".codex-trace-row-header")!.click());
    const commandCopy = host.querySelector<HTMLButtonElement>('button[title="Copy command"]')!;
    await act(async () => commandCopy.click());
    expect(writeText).toHaveBeenCalledWith("npm run build -- token=[REDACTED]");
    expect(host.querySelector(".codex-log-pre")?.textContent?.length).toBe(4000);
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "View full recorded output")!.click());
    expect(host.querySelector(".codex-log-pre")?.textContent).toContain("password=[REDACTED]");
    writeText.mockRejectedValue(new Error("clipboard denied"));
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Copy log"]')!.click());
    expect(host.querySelector('button[title="Copy log"]')?.textContent?.trim()).toBe("Copy");
  });
});
