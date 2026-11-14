// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentExecutionTrace } from "../AgentExecutionTrace";
import { ChatThinking, useChatThinking } from "../ResearchProgress";
import type { DevelopmentProcess, DevelopmentProcessProgressItem } from "@npati/shared";
import { ChatDevelopmentProgress } from "../ChatDevelopmentProgress";
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });
async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<AgentExecutionTrace items={[{ id: "call", stage: "command", title: "Build", command: "npm run build -- token=short", result: "a".repeat(5000) + " password=p", status: "running", at: "" }]} />));
  return host;
}
describe("execution row interaction", () => {
  it("keeps creation active, transfers the dot to error recovery, and stops on terminal failure", async () => {
    const host = await mount();
    const at = new Date().toISOString();
    const setup: DevelopmentProcessProgressItem = { id:"setup",stage:"technology_selection",title:"HTML/CSS: Explicit user technology: HTML/CSS",status:"completed",at,runId:"setup-run" };
    const wait: DevelopmentProcessProgressItem = { id:"wait",stage:"model_response",title:"Waiting",status:"running",at,runId:"worker" };
    const process: DevelopmentProcess = { id:"process",companyId:"company",name:"Game",framework:"HTML/CSS",parentConversationId:"chat",conversationId:"chat",hidden:false,status:"running",createdAt:at,updatedAt:at,initialRunId:"setup-run",runId:"worker",runStatuses:{"setup-run":"completed",worker:"running"},responseLanguage:"uk",progress:[setup,wait] };
    await act(async () => root!.render(<ChatDevelopmentProgress process={process} isUk />));
    let creation = [...host.querySelectorAll<HTMLButtonElement>(".coding-run-header")].find(button => button.textContent?.includes("Створення проєкту"))!;
    expect(creation.querySelector(".research-active-text")?.textContent).toBe("Створення проєкту");
    expect(creation.querySelector(".research-progress-state")?.textContent).toBe("●");
    expect(creation.querySelector(".research-progress-state .lucide-check")).toBeNull();
    expect(host.querySelector(".chat-thinking")).toBeNull();
    await act(async () => root!.render(<AgentExecutionTrace process={process} items={[]} run={{id:"setup-after-message",runId:"setup-run",at,items:[],status:"running"}} />));
    expect(host.querySelector(".coding-run-header")).toBeNull();
    await act(async () => root!.render(<ChatDevelopmentProgress process={process} isUk />));
    const failed: DevelopmentProcessProgressItem = { id:"build",stage:"command",tool:"shell.exec",command:"npm run build",title:"Build",status:"failed",error:"Build failed",at,runId:"worker" };
    const recovering = { ...process, runId:"retry",runStatuses:{"setup-run":"completed",worker:"failed",retry:"running"},progress:[setup,failed,{...wait,id:"retry-wait",runId:"retry"}] };
    await act(async () => root!.render(<ChatDevelopmentProgress process={recovering} isUk />));
    creation = [...host.querySelectorAll<HTMLButtonElement>(".coding-run-header")].find(button => button.textContent?.includes("Створення проєкту"))!;
    expect(creation.querySelector(".research-active-text")).toBeNull();
    expect(creation.querySelector(".research-progress-state .lucide-check")).not.toBeNull();
    const error = [...host.querySelectorAll<HTMLButtonElement>(".coding-run-header")].find(button => button.textContent?.includes("Помилка"))!;
    expect(error.querySelector(".research-active-text")?.textContent).toBe("Помилка");
    expect(error.querySelector(".research-progress-state")?.textContent).toBe("●");
    await act(async () => root!.render(<ChatDevelopmentProgress process={{...process,status:"failed",runStatuses:{"setup-run":"completed",worker:"failed"},progress:[setup,failed]}} isUk />));
    expect(host.querySelector(".coding-run-header .research-active-text")).toBeNull();
    const terminal = [...host.querySelectorAll<HTMLButtonElement>(".coding-run-header")].find(button => button.textContent?.includes("Помилка"))!;
    expect(terminal.querySelector(".research-progress-state .lucide-check")).toBeNull();
    expect(terminal.querySelector(".research-progress-state svg")).not.toBeNull();
    await act(async () => root!.render(<ChatDevelopmentProgress process={process} isUk animatePending={false} />));
    expect(host.querySelector(".coding-run-header .research-active-text")).toBeNull();
    await act(async () => root!.render(<AgentExecutionTrace process={{...process,progress:[{...setup,status:"cancelled"}]}} items={[{...setup,status:"cancelled"}]} run={{id:"cancelled",runId:"setup-run",at,items:[],status:"cancelled"}} />));
    expect(host.querySelector(".research-active-text")).toBeNull();
  });
  it("owns one thinking node across locales and parallel runs, and never restarts it after an operation", async () => {
    const host = await mount();
    const old = { id: "old", stage: "command", command: "old build", title: "Old", status: "completed" as const, at: "", runId: "old-run" };
    function Harness({ items, busy = true, text = "Thinking" }: { items: DevelopmentProcessProgressItem[]; busy?: boolean; text?: string }) {
      const thinking = useChatThinking({ busy, streaming: false, text, items, events: [], runIds: ["old-run"] });
      return <><button onClick={() => thinking.start("Створи гру арканоїд")}>Send</button>{thinking.visible && <ChatThinking text={thinking.text} />}
        {["first", "parallel"].map(id => <AgentExecutionTrace key={id} items={items.filter(item => item.runId === id)} run={{ id, runId: id, status: "running", language: text === "Thinking" ? "en" : "uk", at: "", items: [] }} />)}</>;
    }
    await act(async () => root!.render(<Harness items={[old]} />));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    const node = host.querySelector(".chat-thinking .research-active-text");
    expect(node?.textContent).toBe("Думаю");
    const waits = ["first", "parallel"].map(id => ({ id, stage: "model_response", title: "Waiting", status: "running" as const, at: "", runId: id }));
    await act(async () => root!.render(<Harness text="Думаю" items={[old, ...waits]} />));
    expect(host.querySelectorAll(".chat-thinking")).toHaveLength(1);
    expect(host.querySelector(".chat-thinking .research-active-text")).toBe(node);
    const operation = { id: "new", stage: "technology_selection", title: "HTML/CSS", status: "completed" as const, at: "", runId: "first" };
    await act(async () => root!.render(<Harness items={[old, operation, ...waits]} />));
    expect(host.querySelector(".chat-thinking")).toBeNull();
    expect(host.textContent).not.toContain("Thinking"); expect(host.textContent).not.toContain("Думаю");
    await act(async () => root!.render(<Harness items={[old, ...waits]} />));
    expect(host.querySelector(".chat-thinking")).toBeNull();
    await act(async () => root!.render(<Harness busy={false} items={[]} />));
    await act(async () => root!.render(<Harness busy items={[]} />));
    expect(host.querySelector(".chat-thinking")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelectorAll(".chat-thinking")).toHaveLength(1);
    await act(async () => root!.render(<Harness busy={false} items={[]} />));
    expect(host.querySelector(".chat-thinking")).toBeNull();
  });
  it("names project setup, preserves technology details, and omits run links and model waits", async () => {
    const host = await mount();
    const items = [
      { id: "technology", stage: "technology_selection", title: "HTML/CSS: Explicit user technology: HTML/CSS", status: "completed" as const, at: "", runId: "setup-run" },
      { id: "wait", stage: "model_response", title: "Очікую відповідь моделі", status: "completed" as const, at: "", runId: "setup-run" },
    ];
    await act(async () => root!.render(<AgentExecutionTrace items={items} run={{id:"setup",runId:"setup-run",at:"",status:"completed",language:"uk",items}} />));
    expect(host.querySelector(".coding-run-header")?.textContent).toBe("Створення проєкту");
    expect(host.querySelector(".coding-run-header .lucide-blocks")).not.toBeNull();
    expect(host.querySelector(".lucide-folder-plus")).toBeNull();
    expect(host.textContent).not.toContain("Виконано операцій");
    await act(async () => host.querySelector<HTMLButtonElement>(".coding-run-header")!.click());
    // The technology step is shown in the request language, not as the English reason the server recorded (V6 step 13).
    expect(host.textContent).toContain("HTML/CSS: технологія, яку ви вказали");
    await act(async () => host.querySelector<HTMLButtonElement>(".coding-operation-history .codex-trace-row-header")!.click());
    expect(host.querySelector('a[href*="/activity?runId="]')).toBeNull();
    expect(host.textContent).not.toContain("Переглянути Run");
    expect(host.textContent).not.toContain("Очікую відповідь моделі");
  });
  it("shows the edited file and factual change counts without expanding the history", async () => {
    const host = await mount();
    const items = [{id:"edit",stage:"tool",title:"code.fs.write",tool:"code.fs.write",file:"assets/js/app.js",linesAdded:120,linesRemoved:8,diff:"large private diff",at:new Date().toISOString(),status:"completed" as const},
      {id:"thinking",stage:"planning",title:"Waiting for model",at:new Date().toISOString(),status:"running" as const}];
    await act(async()=>root!.render(<AgentExecutionTrace items={items} run={{id:"run",runId:"run",at:"",items,status:"running"}} />));
    expect(host.querySelector(".coding-changed-files")?.textContent).toContain("assets/js/app.js");
    expect(host.querySelector(".coding-changed-files")?.textContent).toContain("+120");
    expect(host.querySelector(".coding-changed-files")?.textContent).toContain("-8");
    expect(host.querySelector(".coding-run-header")?.textContent).not.toContain("Editing files");
    expect(host.querySelector(".codex-log-pre .code-line")).toBeNull();
    expect(host.querySelector(".codex-trace-duration-tag")).not.toBeNull();
    expect(host.querySelector(".coding-run-header .research-active-text")).not.toBeNull();
    const activeItems = [{ ...items[0]!, status: "running" as const }];
    await act(async () => root!.render(<AgentExecutionTrace items={activeItems} run={{id:"run",runId:"run",at:"",items:activeItems,status:"running"}} />));
    expect(host.querySelector(".coding-run-header .research-active-text")?.textContent).toContain("assets/js/app.js");
    expect(host.querySelector(".codex-trace-duration-tag")).not.toBeNull();
    await act(async () => root!.render(<AgentExecutionTrace items={items} run={{id:"run",runId:"run",at:"",items,status:"completed"}} />));
    expect(host.querySelector(".coding-run-header .research-active-text")).toBeNull();
  });
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
    expect(host.querySelector(".codex-log-pre .code-line")?.textContent?.length).toBe(4000);
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "View full recorded output")!.click());
    expect(host.querySelector(".codex-log-pre .code-line")?.textContent).toContain("password=[REDACTED]");
    writeText.mockRejectedValue(new Error("clipboard denied"));
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Copy log"]')!.click());
    expect(host.querySelector('button[title="Copy log"]')?.textContent?.trim()).toBe("Copy");
  });
});
