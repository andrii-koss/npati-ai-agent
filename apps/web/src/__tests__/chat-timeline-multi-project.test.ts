import { expect, it } from "vitest";
import { activitySlots, chatTimeline } from "../chat-timeline";
import type { DevelopmentProcess } from "@npati/shared";

// V6 step 14: a chat that built a site and an app showed only the current project's steps; and in a long chat the steps
// of a site built 150 messages earlier were stacked between two unrelated questions.
const at = (m: number) => new Date(Date.UTC(2026, 10, 15, 8, m)).toISOString();
const messages = [
  { id: "u1", role: "user", content: "Створи сайт", createdAt: at(0) },
  { id: "a1", role: "assistant", content: "Сайт створено", createdAt: at(2) },
  { id: "u2", role: "user", content: "Створи застосунок", createdAt: at(3) },
  { id: "a2", role: "assistant", content: "Застосунок створено", createdAt: at(5) },
] as never[];
const process = (id: string, runId: string, minute: number, file: string): DevelopmentProcess => ({
  id, companyId: "c", parentConversationId: "conv", conversationId: "conv", name: id, framework: "HTML/CSS", status: "completed",
  hidden: false, createdAt: at(minute), updatedAt: at(minute + 1), initialRunId: runId, runStatuses: { [runId]: "completed" }, runStartedAts: { [runId]: at(minute) },
  progress: [{ id: id + "-w", stage: "tool", title: "write", at: at(minute) + "", runId, tool: "code.fs.write", file, status: "completed", conversationId: "conv" }],
} as DevelopmentProcess);

it("shows every project's steps beside its own request", () => {
  const site = process("site", "run-site", 1, "index.html"), app = process("app", "run-app", 4, "App.tsx");
  const timeline = chatTimeline(messages, site.progress, "conv", site, false, [site, app]);
  const order = timeline.map((entry) => entry.kind === "message" ? entry.message.id : "steps:" + (entry.process?.id ?? "?"));
  expect(order).toEqual(["u1", "steps:site", "a1", "u2", "steps:app", "a2"]);
});

it("leaves steps older than the loaded window out while earlier messages are not loaded", () => {
  const old = [{ id: "old", stage: "agent", title: "write", at: new Date(Date.UTC(2026, 10, 14)).toISOString(), conversationId: "conv" }];
  expect([...activitySlots(messages, old, "conv", true).values()].flat()).toHaveLength(0);
  expect([...activitySlots(messages, old, "conv", false).values()].flat()).toHaveLength(1);
});
