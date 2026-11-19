import type { CompanyEmailAccount, CompanyEmailMessage, CompanyEmailThread, EmailAnalytics } from "./email-inbox-types";

export type AnalyticsThread = Pick<CompanyEmailThread, "id" | "companyId" | "status" | "isHumanTakeover" | "aiConfidenceScore" | "assignedAgentId" | "lastMessageAt">;
export type AnalyticsMessage = Pick<CompanyEmailMessage, "id" | "companyId" | "threadId" | "emailAccountId" | "direction" | "isDraft" | "deliveryStatus" | "isAiGenerated" | "aiDraftApprovedBy" | "createdAt" | "sentByAgentId">;

export function calculateEmailAnalytics(threads: AnalyticsThread[], accounts: CompanyEmailAccount[], messages: AnalyticsMessage[], editedAiResponsesCount: number): EmailAnalytics {
  const receivedEmails = messages.filter((message) => message.direction === "inbound").length;
  const completedOutbound = messages.filter((message) =>
    message.direction === "outbound"
    && !message.isDraft
    && (message.deliveryStatus === "sent" || message.deliveryStatus === "delivered"));
  const sentEmails = completedOutbound.length;
  const aiAnswered = completedOutbound.filter((message) => message.isAiGenerated).length;
  const humanAnswered = completedOutbound.filter((message) => !message.isAiGenerated).length;
  const draftedByAi = messages.filter((message) => message.direction === "outbound" && message.isAiGenerated && message.isDraft).length;
  const approvedByHuman = completedOutbound.filter((message) => Boolean(message.aiDraftApprovedBy)).length;
  const failedEmails = messages.filter((message) => message.deliveryStatus === "failed" || message.deliveryStatus === "rejected").length;
  const bouncedEmails = messages.filter((message) => message.deliveryStatus === "bounced").length;
  const escalatedToHuman = threads.filter((thread) => thread.status === "waiting_human" || thread.isHumanTakeover).length;
  let highConf = 0;
  let medConf = 0;
  let lowConf = 0;

  for (const t of threads) {
    if (t.aiConfidenceScore !== null && t.aiConfidenceScore !== undefined) {
      if (t.aiConfidenceScore >= 0.85) highConf++;
      else if (t.aiConfidenceScore >= 0.6) medConf++;
      else lowConf++;
    }
  }

  const messagesByThread = new Map<string, AnalyticsMessage[]>();
  for (const message of messages) {
    const group = messagesByThread.get(message.threadId);
    if (group) group.push(message);
    else messagesByThread.set(message.threadId, [message]);
  }
  const sentIds = new Set(completedOutbound.map(message => message.id));
  const responseTimes: number[] = [];
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  for (const thread of threads) {
    const threadMessages = messagesByThread.get(thread.id) ?? [];
    const firstInbound = threadMessages.find((message) => message.direction === "inbound");
    const firstResponse = firstInbound && threadMessages.find((message) =>
      message.direction === "outbound"
      && !message.isDraft
      && (message.deliveryStatus === "sent" || message.deliveryStatus === "delivered")
      && new Date(message.createdAt) >= new Date(firstInbound.createdAt));
    if (firstInbound && firstResponse) {
      responseTimes.push((new Date(firstResponse.createdAt).getTime() - new Date(firstInbound.createdAt).getTime()) / 60_000);
    }
  }
  const averageResponse = responseTimes.length
    ? Math.round((responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length) * 10) / 10
    : 0;
  const automationRate = sentEmails > 0 ? Math.round((aiAnswered / sentEmails) * 100) : 0;
  const dayMap = new Map<string, { received: number; sent: number }>();
  const accountMap = new Map<string, number>();
  const agentMap = new Map<string, number>();
  for (const message of messages) {
    const day = new Date(message.createdAt).toISOString().slice(0, 10);
    const entry = dayMap.get(day) || { received: 0, sent: 0 };
    if (message.direction === "inbound") entry.received++;
    else if (!message.isDraft && (message.deliveryStatus === "sent" || message.deliveryStatus === "delivered")) entry.sent++;
    dayMap.set(day, entry);
    if (message.emailAccountId) accountMap.set(message.emailAccountId, (accountMap.get(message.emailAccountId) || 0) + 1);
    const creditedAgentId = message.sentByAgentId || (message.isAiGenerated ? threadById.get(message.threadId)?.assignedAgentId : undefined);
    if (creditedAgentId && sentIds.has(message.id)) {
      agentMap.set(creditedAgentId, (agentMap.get(creditedAgentId) || 0) + 1);
    }
  }

  return {
    receivedEmails,
    sentEmails,
    aiAnswered,
    humanAnswered,
    draftedByAi,
    approvedByHuman,
    escalatedToHuman,
    failedEmails,
    bouncedEmails,
    averageResponseTimeMinutes: averageResponse,
    averageFirstResponseTimeMinutes: averageResponse,
    editedAiResponsesCount,
    automationRate,
    confidenceDistribution: {
      high: highConf,
      medium: medConf,
      low: lowConf,
    },
    volumeByDay: Array.from(dayMap.entries()).sort(([a], [b]) => a.localeCompare(b))
      .map(([date, volume]) => ({ date, ...volume })),
    volumeByAgent: Array.from(agentMap.entries()).map(([agentId, count]) => ({
      agentId,
      agentName: accounts.find((account) => account.agentId === agentId)?.displayName || agentId,
      count,
    })),
    volumeByAccount: accounts.map((a) => ({
      accountId: a.id,
      email: a.emailAddress,
      count: accountMap.get(a.id) || 0,
    })),
  };
}
