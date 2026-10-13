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
});
