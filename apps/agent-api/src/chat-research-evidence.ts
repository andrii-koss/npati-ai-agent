import type { ConversationResearchEvidence, ConversationResearchInput } from "@npati/workspace";
import type { ResearchOutcome } from "@npati/web-research";

/** One research result of this turn as a conversation evidence record (exact sources, bounded excerpt). */
export function researchEvidenceInput(tool: string, query: string, outcome: ResearchOutcome, companyId: string | null): ConversationResearchInput {
  return {
    companyId, tool, kind: outcome.kind, query,
    sources: outcome.sources.map((source) => ({ url: source.url, ...(source.title ? { title: source.title } : {}) })),
    evidenceExcerpt: outcome.context.replace(/\s+/g, " ").trim(), ...(outcome.degraded ? { degraded: outcome.degraded } : {}),
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
    entry.degraded ? `   Degraded: ${entry.degraded}` : "",
    entry.evidenceExcerpt ? `   Evidence excerpt: ${entry.evidenceExcerpt.slice(0, 400)}` : "",
  ].filter(Boolean).join("\n"));
  let body = "";
  for (const block of blocks.reverse()) {
    if (body.length + block.length > maxChars) break;
    body = block + (body ? "\n" + body : "");
  }
  return "[Research evidence recorded in this conversation, verbatim; newest last. When the user asks about earlier research, "
    + "cite these exact sources and counts instead of the summary, and say what is missing rather than guessing.]\n" + body;
}
