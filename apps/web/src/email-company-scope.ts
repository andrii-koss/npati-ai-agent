import { loadCompanyScopes } from "./company-scope";
import { api, type EmailAnalytics } from "./email-settings-types";

export async function readEmailCollection<T>(ids: string[], path: string, key: string): Promise<Array<T & { companyId: string }>> {
  const pages = await loadCompanyScopes(ids, async id => {
    const response = await api<Record<string, T[]>>(`/companies/${id}/${path}`);
    return (response[key] ?? []).map(item => ({ ...item, companyId: id }));
  });
  return pages.flat();
}

export function mergeEmailAnalytics(values: EmailAnalytics[]): EmailAnalytics | null {
  if (!values.length) return null;
  const sum = (key: keyof EmailAnalytics) => values.reduce((total, item) => total + (typeof item[key] === "number" ? item[key] as number : 0), 0);
  const received = sum("receivedEmails");
  const weighted = (key: "averageResponseTimeMinutes" | "averageFirstResponseTimeMinutes") => received ? values.reduce((total, item) => total + item[key] * item.receivedEmails, 0) / received : 0;
  const days = new Map<string, { date: string; received: number; sent: number }>();
  values.forEach(item => item.volumeByDay.forEach(day => {
    const current = days.get(day.date) ?? { date: day.date, received: 0, sent: 0 };
    current.received += day.received; current.sent += day.sent; days.set(day.date, current);
  }));
  return {
    receivedEmails: received, sentEmails: sum("sentEmails"), aiAnswered: sum("aiAnswered"), humanAnswered: sum("humanAnswered"),
    draftedByAi: sum("draftedByAi"), approvedByHuman: sum("approvedByHuman"), escalatedToHuman: sum("escalatedToHuman"),
    failedEmails: sum("failedEmails"), bouncedEmails: sum("bouncedEmails"), editedAiResponsesCount: sum("editedAiResponsesCount"),
    averageResponseTimeMinutes: weighted("averageResponseTimeMinutes"), averageFirstResponseTimeMinutes: weighted("averageFirstResponseTimeMinutes"),
    automationRate: sum("sentEmails") ? Math.round(sum("aiAnswered") / sum("sentEmails") * 100) : 0,
    confidenceDistribution: { high: values.reduce((n, v) => n + v.confidenceDistribution.high, 0), medium: values.reduce((n, v) => n + v.confidenceDistribution.medium, 0), low: values.reduce((n, v) => n + v.confidenceDistribution.low, 0) },
    volumeByDay: [...days.values()].sort((a,b) => a.date.localeCompare(b.date)),
    volumeByAgent: values.flatMap(item => item.volumeByAgent), volumeByAccount: values.flatMap(item => item.volumeByAccount),
  };
}
