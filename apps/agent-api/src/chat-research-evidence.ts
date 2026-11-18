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

/**
 * The research of one turn across all its searches. A turn that searched five times kept only the last search: when that
 * one found nothing, the reply lost the sources its facts came from (Minfin, ATB) and was reported as unsourced
 * (V6 step 20, zh research). Sources are kept in order without duplicates; "degraded" stays only when nothing was found.
 */
export function mergeResearchOutcomes(previous: ResearchOutcome | undefined, next: ResearchOutcome): ResearchOutcome {
  if (!previous) return next;
  const sources = [...previous.sources];
  for (const source of next.sources) if (!sources.some((known) => known.url === source.url)) sources.push(source);
  const pageCount = previous.pageCount === undefined && next.pageCount === undefined ? undefined : (previous.pageCount ?? 0) + (next.pageCount ?? 0);
  const degraded = sources.length ? undefined : next.degraded ?? previous.degraded;
  return {
    kind: next.kind,
    context: [previous.context, next.context].filter(Boolean).join("\n\n"),
    sources,
    ...(pageCount !== undefined ? { pageCount } : {}),
    ...(degraded ? { degraded } : {}),
  };
}
