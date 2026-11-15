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

// V6 step 14 (16-language chat): a read-only question showed two answers, the agent's closing message before
// code.finish and the reply saved after the run.
it("does not repeat a run's closing message beside the reply the chat saved for it", () => {
  const q = [
    { id: "u", role: "user", content: "Qual è ora il titolo?", createdAt: at(10) },
    { id: "a", role: "assistant", content: "Il titolo del documento è POLY_EN_V1.", createdAt: at(12) },
  ] as never[];
  const p = { ...process("site", "run-q", 10, "index.html"), progress: [
    { id: "r", stage: "tool", title: "read", at: at(10), runId: "run-q", tool: "code.fs.read", status: "completed", conversationId: "conv" },
    { id: "m", kind: "assistant_message", stage: "planning", title: "Il titolo del sito è POLY_EN_V1.", at: at(11), runId: "run-q", status: "completed", conversationId: "conv" },
    { id: "f", stage: "tool", title: "finish", at: at(11) + "", runId: "run-q", tool: "code.finish", status: "completed", conversationId: "conv" },
  ] } as DevelopmentProcess;
  const texts = chatTimeline(q, p.progress, "conv", p).filter((entry) => entry.kind === "activity" && entry.item.kind === "assistant_message");
  expect(texts).toHaveLength(0);
  // While the reply is not saved yet, the closing message is what the person sees.
  expect(chatTimeline(q.slice(0, 1), p.progress, "conv", p).some((entry) => entry.kind === "activity" && entry.item.kind === "assistant_message")).toBe(true);
});
