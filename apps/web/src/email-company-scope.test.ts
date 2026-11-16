import { expect, it } from "vitest";
import { mergeEmailAnalytics } from "./email-company-scope";
import type { EmailAnalytics } from "./email-settings-types";

it("computes the overall automation rate from sent mail, including replies to older incoming mail", () => {
  const analytics = (received: number, sent: number): EmailAnalytics => ({
    receivedEmails: received, sentEmails: sent, aiAnswered: sent, humanAnswered: 0,
    draftedByAi: 0, approvedByHuman: 0, escalatedToHuman: 0, failedEmails: 0, bouncedEmails: 0,
    editedAiResponsesCount: 0, averageResponseTimeMinutes: 10, averageFirstResponseTimeMinutes: 5,
    automationRate: 100, confidenceDistribution: { high: 1, medium: 0, low: 0 },
    volumeByDay: [{ date: "2026-11-16", received, sent }], volumeByAgent: [], volumeByAccount: [],
  });
  const result = mergeEmailAnalytics([analytics(1, 2), analytics(2, 3)]);
  expect(result?.receivedEmails).toBe(3);
  expect(result?.sentEmails).toBe(5);
  expect(result?.automationRate).toBe(100);
  expect(result?.volumeByDay).toEqual([{ date: "2026-11-16", received: 3, sent: 5 }]);
});
