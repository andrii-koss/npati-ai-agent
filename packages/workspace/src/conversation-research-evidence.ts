import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AuthContext, Conversation, ConversationResearchEvidence, ConversationResearchInput } from "./types";
import { WorkspaceAccessError } from "./types";

/** Keep research evidence lossless. Reject excessive records instead of silently truncating sources or URLs. */
function normalize(input: ConversationResearchInput): ConversationResearchInput {
  if (input.sources.length > 10_000 || input.evidenceExcerpt.length > 2_000_000)
    throw new Error("Research evidence exceeds storage limits");
  if (input.sources.some(source => typeof source.url !== "string" || !/^https?:\/\//i.test(source.url)))
    throw new Error("Research sources require HTTP(S) URLs");
  if (input.pageCount !== undefined && (!Number.isSafeInteger(input.pageCount) || input.pageCount < 0))
    throw new Error("Research page count must be a nonnegative integer");
  return structuredClone(input);
}

type Row = {
  id: string; workspace_id: string; user_id: string; conversation_id: string; company_id: string | null; tool: string; kind: string;
  page_count: number | null; query: string; sources: ConversationResearchEvidence["sources"]; source_count: number; evidence_excerpt: string; degraded: string | null; created_at: Date;
};
const fromRow = (row: Row): ConversationResearchEvidence => ({
  id: row.id, workspaceId: row.workspace_id, userId: row.user_id, conversationId: row.conversation_id, companyId: row.company_id,
  tool: row.tool, kind: row.kind, query: row.query, sources: row.sources, sourceCount: row.source_count,
  evidenceExcerpt: row.evidence_excerpt, ...(row.page_count != null ? { pageCount: row.page_count } : {}), ...(row.degraded ? { degraded: row.degraded } : {}), createdAt: row.created_at.toISOString(),
});

async function assertOwnedConversation(pool: Pool, context: AuthContext, conversationId: string) {
  const owned = await pool.query("SELECT 1 FROM conversations WHERE id=$1 AND workspace_id=$2 AND user_id=$3", [conversationId, context.workspaceId, context.userId]);
  if (!owned.rowCount) throw new WorkspaceAccessError("Conversation is not available to this user");
}

export async function appendConversationResearch(pool: Pool, context: AuthContext, conversationId: string, input: ConversationResearchInput) {
  await assertOwnedConversation(pool, context, conversationId);
  const value = normalize(input);
  const result = await pool.query<Row>(`INSERT INTO conversation_research_evidence
      (id, workspace_id, user_id, conversation_id, company_id, tool, kind, query, sources, source_count, evidence_excerpt, degraded, page_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, $10,$11,$12,$13) RETURNING *`,
  [randomUUID(), context.workspaceId, context.userId, conversationId, value.companyId, value.tool, value.kind, value.query,
    JSON.stringify(value.sources), input.sources.length, value.evidenceExcerpt, value.degraded ?? null, value.pageCount ?? null]);
  return fromRow(result.rows[0]!);
}

export async function listConversationResearch(pool: Pool, context: AuthContext, conversationId: string, limit = 20) {
  await assertOwnedConversation(pool, context, conversationId);
  const result = await pool.query<Row>(`SELECT * FROM (SELECT * FROM conversation_research_evidence
      WHERE workspace_id=$1 AND user_id=$2 AND conversation_id=$3 ORDER BY created_at DESC LIMIT $4) recent ORDER BY created_at`,
  [context.workspaceId, context.userId, conversationId, Math.max(1, Math.min(limit, 100))]);
  return result.rows.map(fromRow);
}

export class InMemoryConversationResearch {
  private readonly entries: ConversationResearchEvidence[] = [];
  constructor(private readonly conversations: Map<string, Conversation>) {}
  private assertOwned(context: AuthContext, conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.workspaceId !== context.workspaceId || conversation.userId !== context.userId)
      throw new WorkspaceAccessError("Conversation is not available to this user");
  }
  async append(context: AuthContext, conversationId: string, input: ConversationResearchInput) {
    this.assertOwned(context, conversationId);
    const value = normalize(input);
    const entry: ConversationResearchEvidence = { id: randomUUID(), workspaceId: context.workspaceId, userId: context.userId, conversationId,
      companyId: value.companyId, tool: value.tool, kind: value.kind, query: value.query, sources: value.sources, sourceCount: input.sources.length,
      evidenceExcerpt: value.evidenceExcerpt, ...(value.pageCount !== undefined ? { pageCount: value.pageCount } : {}), ...(value.degraded ? { degraded: value.degraded } : {}), createdAt: new Date().toISOString() };
    this.entries.push(entry);
    return structuredClone(entry);
  }
  async list(context: AuthContext, conversationId: string, limit = 20) {
    this.assertOwned(context, conversationId);
    // A deleted conversation takes its evidence with it, as the database cascade does.
    return this.entries.filter((entry) => entry.conversationId === conversationId && entry.userId === context.userId && entry.workspaceId === context.workspaceId)
      .slice(-Math.max(1, Math.min(limit, 100))).map(entry => structuredClone(entry));
  }
}
