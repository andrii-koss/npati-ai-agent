import React from "react";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DevelopmentProcess, ProjectCardData } from "@npati/shared";
import { ChatDevelopmentProgress, ChatDevelopmentPreview } from "../ChatDevelopmentProgress";
import { AgentExecutionTrace } from "../AgentExecutionTrace";
import { developmentCard, hideDevelopmentMessage, projectConversationUrl } from "../chat-development-view";
const process: DevelopmentProcess = { id: "process", companyId: "company", projectId: "project", conversationId: "child", parentConversationId: "parent", name: "Online store", framework: "Next.js", status: "running", hidden: false, createdAt: "", updatedAt: "", progress: [{ id: "install", stage: "dependencies", title: "Installing dependencies", status: "running", at: "" }] };
const card: ProjectCardData = { id: "project", projectId: "project", companyId: "company", name: "Online store", status: "ready", kind: "code_project" };
describe("project deployment chat", () => {
  it("renders an animated dot and actual stages only with a project process", () => {
    const markup = renderToStaticMarkup(<ChatDevelopmentProgress process={process} />);
    expect(markup).toContain('class="assistant research-progress coding-run-activity"'); expect(markup).toContain('class="research-progress-state"'); expect(markup).toMatch(/class="[^"]*research-progress-globe/); expect(markup).toContain('class="research-active-text"'); expect(markup).not.toContain('chat-development-dot'); expect(markup).not.toContain('<section'); expect(markup).toContain("Installing dependencies");
    expect(renderToStaticMarkup(<ChatDevelopmentProgress />)).toBe("");
  });
  it("keeps separate tool calls and deduplicates only the same execution identity", () => {
    const busy = { ...process, progress: [...process.progress!, ...Array.from({ length: 20 }, (_, i) => ({ id: "read-" + i, stage: "tool", title: "Reading project files", at: "" }))] };
    const markup = renderToStaticMarkup(<ChatDevelopmentProgress process={busy} />);
    expect(markup.match(/research-page-row/g)).toHaveLength(1);
    expect(markup).toContain('aria-expanded="false"');
    const details = renderToStaticMarkup(<AgentExecutionTrace process={busy} nested />);
    expect(details.match(/Reading project files/g)).toHaveLength(20);
  });
  it("preserves waiting, failure and cancellation without animating completed operations", async () => {
    const { AgentExecutionTrace } = await import("../AgentExecutionTrace");
    const items = ["completed", "waiting_for_approval", "failed", "cancelled", "running", "running"].map((status, i) => ({ id: "call-" + i, stage: "build", title: "Building project", at: "", status: status as "running", agentId: i === 5 ? "worker-2" : "worker-1" }));
    const markup = renderToStaticMarkup(<AgentExecutionTrace process={{ ...process, progress: items }} />);
    expect(markup.match(/class="research-active-text"/g)).toHaveLength(2);
    expect(markup).toContain('data-status="waiting_for_approval"'); expect(markup).toContain('data-status="failed"'); expect(markup).toContain('data-status="cancelled"');
    expect(markup).not.toContain("codex-trace-status-pill");
    expect(markup).toContain('aria-controls="trace-detail-call-0"'); expect(markup).toContain('inert=""');
    expect(markup).not.toContain("worker-2");
    const duplicates = renderToStaticMarkup(<AgentExecutionTrace items={[items[0]!, { ...items[0]!, status: "failed" }]} />);
    expect(duplicates.match(/research-page-row/g)).toHaveLength(1); expect(duplicates).toContain('data-status="failed"');
  });
  it("hides duplicate placeholder messages and cards but retains substantive replies", () => {
    // Since projects-5 a placeholder bubble is hidden when it has no card; one with a card renders as that card.
    const messages = [{ content: "Online store" }, { content: "I changed the page", projectCard: card }, { content: "Stopped: A2A_TOKEN_QUOTA_EXCEEDED", projectCard: card }];
    expect(hideDevelopmentMessage(messages, 0, [process])).toBe(true);
    expect(hideDevelopmentMessage(messages, 1, [process])).toBe(false);
    expect(hideDevelopmentMessage(messages, 2, [process])).toBe(false);
    const failed = { ...process, status: "failed" as const };
    // Only a project's latest card shows, with the process's real status; a child chat's card stays out of the parent.
    expect(developmentCard(messages, 1, [failed], "child")).toBeNull();
    expect(developmentCard(messages, 2, [failed], "child")?.status).toBe("failed");
    expect(developmentCard(messages, 2, [failed], "parent")).toBeNull();
    // While the process still runs, the card reads it as a build in progress, never as a running Preview.
    expect(developmentCard(messages, 2, [process], "child")?.status).toBe("building");
  });
  it("shows only Preview beneath the completed trace and retains substantive replies", () => {
    const completed = { ...process, status: "completed" as const, previewUrl: "/preview/project", progress: [{ ...process.progress![0]!, status: "completed" as const }] };
    const html = renderToStaticMarkup(<MemoryRouter><ChatDevelopmentProgress process={completed} /><ChatDevelopmentPreview process={completed} /></MemoryRouter>);
    expect(html.indexOf("chat-development-preview")).toBeGreaterThan(html.indexOf("codex-trace-row"));
    // ChatProjectPreviewCard (projects-10) replaced the old "Preview" button markup: still exactly one trigger.
    expect(html.match(/coding-preview-trigger/g)).toHaveLength(1);expect(html).not.toContain("Code ");expect(html).not.toContain("Edit in chat");expect(html).not.toContain("Live Preview Active");
    expect(hideDevelopmentMessage([{ content: process.name }], 0, [completed])).toBe(true);
    expect(hideDevelopmentMessage([{ content: "I changed the button", projectCard: card }], 0, [completed])).toBe(false);
    expect(developmentCard([{ content: "I changed the button", projectCard: card }], 0, [completed], "child")?.status).toBe("completed");
  });
  it("preserves project and parent-chat identity after a coding reply", () => {
    const search = new URLSearchParams("company=c&project=p&developmentRoot=parent");
    expect(projectConversationUrl("child", {companyId:"c",projectId:"p"},search)).toBe("/c/child?company=c&project=p&developmentRoot=parent");
    expect(projectConversationUrl("other", {companyId:"c",projectId:"other"},search)).not.toContain("developmentRoot");
  });
  it("never calls an unbuilt template ready or a working agent a running Preview", () => {
    const messages = [{ content: "Online store", projectCard: card }];
    expect(developmentCard(messages, 0, [], "child")?.status).toBe("idle");
    // The chat offers no Preview trigger meanwhile (chat-created-project-preview.test.tsx).
    expect(developmentCard(messages, 0, [process], "child")?.status).toBe("building");
  });
  it("renders Codex execution trace for Next.js website creation, dependencies, build, and preview", () => {
    const nextJsProcess: DevelopmentProcess = {
      id: "proc-nextjs",
      companyId: "company-1",
      projectId: "proj-nextjs",
      conversationId: "conv-1",
      parentConversationId: "parent-1",
      name: "Next.js Store",
      framework: "Next.js",
      status: "running",
      hidden: false,
      createdAt: "2026-10-13T10:00:00Z",
      updatedAt: "2026-10-13T10:02:00Z",
      progress: [
        {
          id: "step-scaffold",
          stage: "scaffold",
          title: "Preparing project template",
          tool: "workspace.scaffold",
          cwd: "/workspace/projects/nextjs-store",
          at: "2026-10-13T10:00:01Z",
          status: "completed",
        },
        {
          id: "step-deps",
          stage: "dependencies",
          title: "Installing dependencies",
          tool: "deps.install",
          command: "npm install",
          cwd: "/workspace/projects/nextjs-store",
          at: "2026-10-13T10:00:10Z",
          status: "completed",
          durationMs: 4500,
          exitCode: 0,
        },
        {
          id: "step-edit",
          stage: "tool",
          title: "Editing file: app/page.tsx",
          tool: "file.write",
          file: "app/page.tsx",
          command: "write app/page.tsx",
          cwd: "/workspace/projects/nextjs-store",
          agentId: "frontend-agent",
          at: "2026-10-13T10:00:25Z",
          status: "completed",
          durationMs: 120,
        },
        {
          id: "step-build",
          stage: "build",
          title: "Building project",
          tool: "project.build",
          command: "npm run build",
          cwd: "/workspace/projects/nextjs-store",
          at: "2026-10-13T10:00:30Z",
          status: "completed",
          durationMs: 8200,
          exitCode: 0,
        },
        {
          id: "step-preview",
          stage: "preview",
          title: "Starting Live Preview",
          tool: "preview.start",
          cwd: "/workspace/projects/nextjs-store",
          at: "2026-10-13T10:00:40Z",
          status: "active",
        },
      ],
    };

    const markupUk = renderToStaticMarkup(<AgentExecutionTrace process={nextJsProcess} isUk={true} nested />);
    expect(markupUk).toContain("Виконана команда: npm install");
    expect(markupUk).toContain("Виконана команда: npm run build");
    expect(markupUk).toContain("Запуск Live Preview");
    expect(markupUk).not.toContain("frontend-agent");
    expect(markupUk).toContain("codex-trace-row");
    expect(markupUk).not.toContain("codex-trace-status-pill");

    const markupEn = renderToStaticMarkup(<AgentExecutionTrace process={nextJsProcess} isUk={false} nested />);
    expect(markupEn).toContain("Executed command: npm install");
    expect(markupEn).toContain("Executed command: npm run build");
    expect(markupEn).toContain("Starting Live Preview");
  });
  it("sanitizes secrets, credentials and tokens from commands and results", async () => {
    const { sanitizeTraceSecrets, AgentExecutionTrace } = await import("../AgentExecutionTrace");
    expect(sanitizeTraceSecrets("curl -H 'Authorization: Bearer mySecretToken123456789' https://api.npati.test")).toContain("Bearer [REDACTED]");
    expect(sanitizeTraceSecrets("echo sk-abcdef1234567890abcdef1234567890")).toContain("[REDACTED]");
    expect(sanitizeTraceSecrets("git clone https://ghp_1234567890abcdefghijklmnopqrstuvwxyz12@github.com/repo.git")).toContain("[REDACTED]");
    expect(sanitizeTraceSecrets("api_key: \"super_secret_api_key_value\"")).toContain('api_key: [REDACTED]');

    const itemWithSecret = {
      id: "trace-secret",
      stage: "command",
      title: "Executed echo command",
      tool: "shell.exec",
      command: "echo sk-abcdef1234567890abcdef1234567890",
      result: "Logged token Bearer secret_access_token_abcdef12345",
      cwd: "/workspace/app",
      status: "completed" as const,
      at: "",
    };
    const markup = renderToStaticMarkup(<AgentExecutionTrace items={[itemWithSecret]} />);
    expect(markup).not.toContain("sk-abcdef1234567890abcdef1234567890");
  });
});

it("does not offer an old or template Preview while coding or parallel work is still active",()=>{
  const process:DevelopmentProcess={id:"p",companyId:"c",projectId:"project",parentConversationId:"parent",name:"Site",framework:"Next.js",status:"running",hidden:false,createdAt:"",updatedAt:"",previewUrl:"/existing-preview",runId:"current",initialRunId:"current"};
  const html=(p:DevelopmentProcess)=>renderToStaticMarkup(<MemoryRouter><ChatDevelopmentPreview process={p}/></MemoryRouter>);
  // The trigger markup is ChatProjectPreviewCard's (projects-10); the rule is unchanged.
  for(const status of ["preparing","running","stopping","awaiting_approval","failed","cancelled"] as const)expect(html({...process,status})).not.toContain('coding-preview-trigger');
  expect(html({...process,status:"completed"})).toContain('coding-preview-trigger');
  expect(html({...process,status:"completed",runStatuses:{current:"completed",child:"running"}})).not.toContain('coding-preview-trigger');
});

it("labels a searched directory as search rather than a modified file",()=>{
 const html=renderToStaticMarkup(<AgentExecutionTrace isUk items={[{id:"grep",stage:"tool",tool:"code.fs.grep",title:"grep",file:"components",status:"waiting_for_approval",at:"",errorCode:"approval_required"}]}/>);
 expect(html).not.toContain("Файл змінено");expect(html).toContain('data-status="waiting_for_approval"');
});

it("hides technical coding cards even when no development process has arrived yet",()=>{
 expect(developmentCard([{content:"Waiting for the user to answer question q.",projectCard:{...card,status:"waiting_for_user"}}],0,[],"chat")).toBeNull();
});

it("never attaches a previous stop reason to an old run or a recovered operation phase", () => {
 const run={id:"phase",runId:"new-run",at:"",items:[],status:"failed"};
 const stale={...process,runId:"new-run",status:"completed" as const,detail:"Stopped by request"};
 expect(renderToStaticMarkup(<AgentExecutionTrace process={stale} run={run}/>)).not.toContain("Stopped by request");
 expect(renderToStaticMarkup(<AgentExecutionTrace process={{...stale,status:"failed",runId:"another-run"}} run={run}/>)).not.toContain("Stopped by request");
 expect(renderToStaticMarkup(<AgentExecutionTrace process={{...stale,status:"failed",detail:"Actual current failure"}} run={run}/>)).toContain("Actual current failure");
});

it("never renders routing cards on user/system messages or hides a user's matching project name",()=>{
 const ready={...card,status:"completed",previewUrl:"/preview/project",lastBuildStatus:"ready"};
 for(const role of ["user","system"] as const){
  const messages=[{role,content:process.name,projectCard:ready}];
  expect(developmentCard(messages,0,[],"child")).toBeNull();
  expect(developmentCard(messages,0,[{...process,status:"completed"}],"child")).toBeNull();
  expect(hideDevelopmentMessage(messages,0,[process])).toBe(false);
 }
 const messages=[{role:"assistant" as const,content:"Ready",projectCard:ready},{role:"user" as const,content:"Edit this site",projectCard:ready}];
 expect(developmentCard(messages,0,[],"child")).toMatchObject({id:card.id});
});

it("leaves thinking to the chat owner during blank HTML startup and preserves real queue waits", () => {
  const startup: DevelopmentProcess = { ...process, framework: "HTML/CSS", status: "preparing", progress: [], runId: undefined, initialRunId: undefined };
  const markup = renderToStaticMarkup(<ChatDevelopmentProgress process={startup} />);
  expect(markup).toBe("");
  const queued = renderToStaticMarkup(<ChatDevelopmentProgress process={{ ...startup, status: "queued" }} />);
  expect(queued).toContain(">Queued<");
  expect(queued).not.toContain("research-active-text");
  const restored = renderToStaticMarkup(<ChatDevelopmentProgress process={{ ...startup, status: "completed", progress: [{id:"registration",stage:"project",tool:"code.workspace",title:"Project workspace prepared",status:"completed",at:""}] }} />);
  expect(restored).toBe("");
  const failed = renderToStaticMarkup(<ChatDevelopmentProgress process={{ ...startup, status: "failed", progress: [{id:"registration",stage:"project",tool:"code.workspace",title:"Project setup failed",status:"failed",at:""}] }} />);
  expect(failed).toContain(">Failed<");
});


it("does not create thinking or model lifecycle rows inside run traces", () => {
 const event={id:"model",stage:"model_response",title:"Waiting for model",status:"running" as const,at:""};
 const waiting=renderToStaticMarkup(<ChatDevelopmentProgress process={{...process,progress:[event]}} />);
 expect(waiting).toBe("");
 const generating=renderToStaticMarkup(<ChatDevelopmentProgress process={{...process,progress:[{...event,stage:"model_generation"}]}} />);
 expect(generating).toBe("");
});

it("hides completed model-wait-only history without hiding provider failures", () => {
 const event={id:"model",stage:"model_response",title:"Waiting for the model response",status:"completed" as const,at:""};
 expect(renderToStaticMarkup(<ChatDevelopmentProgress process={{...process,status:"completed",progress:[event]}} />)).toBe("");
 const failed=renderToStaticMarkup(<AgentExecutionTrace items={[{...event,status:"failed",error:"Provider unavailable"}]} />);
 expect(failed).toContain('data-status="failed"');
});
