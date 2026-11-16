import { expect, it } from "vitest";
import { codingActivityStages } from "../chat-timeline";
import type { DevelopmentProcess } from "@npati/shared";

// V6 step 15: a run the person stopped showed "Error" because its last step was broken off and recorded as failed.
it("shows a stopped run as stopped, not as an error", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 16, 8, 0, s)).toISOString();
  const process = { id: "p", companyId: "c", parentConversationId: "conv", conversationId: "conv", name: "Site", framework: "HTML/CSS", status: "cancelled", hidden: false,
    createdAt: at(0), updatedAt: at(5), runId: "r", initialRunId: "r", runStatuses: { r: "cancelled" },
    progress: [{ id: "a", stage: "tool", tool: "code.fs.read", title: "read", status: "completed", at: at(1), runId: "r" }, { id: "b", stage: "tool", tool: "code.fs.edit", title: "edit", status: "failed", at: at(2), runId: "r" }] } as unknown as DevelopmentProcess;
  expect(codingActivityStages(process.progress, process).at(-1)?.status).toBe("cancelled");
  // A failed step in a run that was not stopped is still an error.
  const failed = { ...process, status: "failed", runStatuses: { r: "failed" } } as DevelopmentProcess;
  expect(codingActivityStages(failed.progress, failed).at(-1)?.status).toBe("failed");
});
