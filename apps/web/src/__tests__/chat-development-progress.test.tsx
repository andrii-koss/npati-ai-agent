import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DevelopmentProcess, ProjectCardData } from "@npati/shared";
import { ChatDevelopmentProgress, developmentProgressEvents } from "../ChatDevelopmentProgress";
import { developmentCard, hideDevelopmentMessage } from "../chat-development-view";
const process: DevelopmentProcess = { id: "process", companyId: "company", projectId: "project", conversationId: "child", parentConversationId: "parent", name: "Online store", framework: "Next.js", status: "running", hidden: false, createdAt: "", updatedAt: "", progress: [{ id: "install", stage: "dependencies", title: "Installing dependencies", at: "" }] };
const card: ProjectCardData = { id: "project", projectId: "project", companyId: "company", name: "Online store", status: "ready", kind: "code_project" };
describe("project deployment chat", () => {
  it("renders an animated dot and actual stages only with a project process", () => {
    const markup = renderToStaticMarkup(<ChatDevelopmentProgress process={process} />);
    expect(markup).toContain('class="assistant research-progress"'); expect(markup).toContain('class="research-progress-state"'); expect(markup).toContain('class="research-progress-globe"'); expect(markup).toContain('class="research-active-text"'); expect(markup).not.toContain('chat-development-dot'); expect(markup).not.toContain('<section'); expect(markup).toContain("Installing dependencies");
    expect(renderToStaticMarkup(<ChatDevelopmentProgress />)).toBe("");
  });
  it("groups repeated file activity in the existing agent step instead of adding many rows", () => {
    const busy = { ...process, progress: [...process.progress!, ...Array.from({ length: 20 }, (_, i) => ({ id: "read-" + i, stage: "tool", title: "Reading project files", at: "" }))] };
    const markup = renderToStaticMarkup(<ChatDevelopmentProgress process={busy} />);
    expect(markup.match(/Reading project files/g)).toHaveLength(1);
    expect(markup.match(/research-page-row/g)).toHaveLength(2);
    expect(developmentProgressEvents(busy).at(-1)).toMatchObject({ stage: "agent", status: "active" });
  });
  it("hides duplicate placeholder messages and cards but retains substantive replies", () => {
    const messages = [{ content: "Coding Agent session started.", projectCard: card }, { content: "I changed the page", projectCard: card }, { content: "Stopped: A2A_TOKEN_QUOTA_EXCEEDED", projectCard: card }];
    expect(hideDevelopmentMessage(messages, 0, [process])).toBe(true);
    expect(hideDevelopmentMessage(messages, 1, [process])).toBe(false);
    const failed = { ...process, status: "failed" as const };
    expect(developmentCard(messages, 0, [failed], "child")).toBeNull();
    expect(developmentCard(messages, 2, [failed], "child")?.status).toBe("failed");
    expect(developmentCard(messages, 2, [failed], "parent")).toBeNull();
  });
  it("never calls an unbuilt template ready and shows no card while a process runs", () => {
    const messages = [{ content: "Online store", projectCard: card }];
    expect(developmentCard(messages, 0, [], "child")?.status).toBe("idle");
    expect(developmentCard(messages, 0, [process], "child")).toBeNull();
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

    const markupUk = renderToStaticMarkup(<ChatDevelopmentProgress process={nextJsProcess} isUk={true} />);
    expect(markupUk).toContain("Виконана команда: npm install");
    expect(markupUk).toContain("Виконана команда: npm run build");
    expect(markupUk).toContain("Запуск Live Preview");
    expect(markupUk).toContain("frontend-agent");
    expect(markupUk).toContain("codex-trace-row");
    expect(markupUk).toContain("codex-trace-status-pill");

    const markupEn = renderToStaticMarkup(<ChatDevelopmentProgress process={nextJsProcess} isUk={false} />);
    expect(markupEn).toContain("Executed command: npm install");
    expect(markupEn).toContain("Executed command: npm run build");
    expect(markupEn).toContain("Starting Live Preview");
  });
  it("sanitizes secrets, credentials and tokens from commands and results", async () => {
    const { sanitizeTraceSecrets, AgentExecutionTrace } = await import("../AgentExecutionTrace");
    expect(sanitizeTraceSecrets("curl -H 'Authorization: Bearer mySecretToken123456789' https://api.npati.test")).toContain("Bearer [REDACTED_TOKEN]");
    expect(sanitizeTraceSecrets("echo sk-abcdef1234567890abcdef1234567890")).toContain("[REDACTED_KEY]");
    expect(sanitizeTraceSecrets("git clone https://ghp_1234567890abcdefghijklmnopqrstuvwxyz12@github.com/repo.git")).toContain("[REDACTED_TOKEN]");
    expect(sanitizeTraceSecrets("api_key: \"super_secret_api_key_value\"")).toContain('api_key: "[REDACTED]"');

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
