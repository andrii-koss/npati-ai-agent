import type { ConversationResearchEvidence, ConversationResearchInput } from "@npati/workspace";
import type { ResearchOutcome } from "@npati/web-research";

/** One research result of this turn as a conversation evidence record (exact sources, bounded excerpt). */
export function researchEvidenceInput(tool: string, query: string, outcome: ResearchOutcome, companyId: string | null): ConversationResearchInput {
  return {
    companyId, tool, kind: outcome.kind, query,
    sources: outcome.sources.map((source) => ({ ...source })),
    ...(outcome.pageCount !== undefined ? { pageCount: outcome.pageCount } : {}),
    evidenceExcerpt: outcome.context, ...(outcome.degraded ? { degraded: outcome.degraded } : {}),
  };
}

/**
 * The conversation's recorded research, verbatim, for recall turns. Long chats compact their history, and a summary can
 * lose or misstate which pages were read (A098); these records keep the exact URLs and counts out of the summary.
 */
export function researchEvidenceContext(entries: ConversationResearchEvidence[], maxChars = 6_000): string | undefined {
  if (!entries.length) return undefined;
  const blocks = entries.map((entry, index) => [
    `${index + 1}. ${entry.createdAt} ${entry.tool} (${entry.kind}) query: ${JSON.stringify(entry.query)}`,
    `   ${entry.sourceCount} source(s): ${entry.sources.map((source) => source.title ? `${source.url} (${source.title})` : source.url).join("; ") || "none"}`,
    `   Fetched pages: ${entry.pageCount ?? "unknown"}; company: ${entry.companyId ?? "none"}`,
    entry.degraded ? `   Degraded: ${entry.degraded}` : "",
    entry.evidenceExcerpt ? `   Evidence excerpt: ${entry.evidenceExcerpt.slice(0, 400)}` : "",
  ].filter(Boolean).join("\n"));
  let body = ""; let omitted = 0;
  // Preserve the earliest research as well as later records. A single oversized record must not erase the index.
  for (const block of blocks) {
    if (body.length + block.length > maxChars) { omitted++; continue; }
    body += (body ? "\n" : "") + block;
  }
  if (omitted) body += "\n" + omitted + " research record(s) omitted from this bounded context. Their full evidence remains stored; do not infer their sources or counts.";

  return "[Research evidence recorded in this conversation, verbatim; newest last. When the user asks about earlier research, "
    + "cite these exact sources and counts instead of the summary, and say what is missing rather than guessing.]\n" + body;
}
