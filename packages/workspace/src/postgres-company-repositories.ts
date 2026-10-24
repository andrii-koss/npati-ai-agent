import { Pool } from "pg";
import { assertCompany, ensureIdentity, getBusiness } from "./postgres-store-support";
import { randomUUID } from "node:crypto";
import type { AuditAnchor, AuditChainState, AuditChainVerification, AuditEntry, AuditEntryInput, AuthContext, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyInvite, CompanyInviteInput, CompanyMember, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, RemoveCompanyMemberInput, UpdateCompanyMemberRoleInput } from "./types";
import { auditEntryHash, verifyAuditEntries } from "./audit-chain";
import { auditAnchorColumns, auditEntryColumns, companyAgentColumns, companyEdgeColumns, companyInviteColumns, companyMemberColumns, companyRunColumns, companyRunEventColumns, companyRunStepColumns, companyToolAuditColumns, conversationColumns, lastActiveOwnerPredicate, memoryColumns } from "./postgres-store-schema";
import { assertNoSecrets } from "@npati/memory";
import { CompanyMembershipError, WorkspaceAccessError, WorkspaceNotFoundError, isCompanyRole } from "./types";
import { companyPageLimit, decodeBusinessCursor, encodeBusinessCursor } from "./pagination";
import { assertMember } from "./postgres-store-support";
import type { Business, BusinessToCompanyInput, CompanyInput } from "./types";
import { companyColumns } from "./postgres-store-schema";

export async function appendAuditEntry(pool: Pool, context: AuthContext, companyId: string, input: AuditEntryInput): Promise<AuditEntry> {
    await assertCompany(pool, context, companyId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`audit:${companyId}`]);
      const head = await client.query<{ sequence: string; entry_hash: string }>(
        "SELECT sequence, entry_hash FROM audit_log WHERE company_id=$1 ORDER BY sequence DESC LIMIT 1",
        [companyId],
      );
      const prevHash = head.rows[0]?.entry_hash ?? null;
      const sequence = head.rows[0] ? Number(head.rows[0].sequence) + 1 : 1;
      const createdAt = new Date().toISOString();
      const id = randomUUID();
      const metadata = input.metadata ?? {};
      const entryHash = auditEntryHash(prevHash, {
        id, companyId, sequence, createdAt, actor: input.actor, actorRole: input.actorRole,
        requestId: input.requestId ?? null, correlationId: input.correlationId ?? null, snapshotId: input.snapshotId ?? null,
        action: input.action, resourceType: input.resourceType, resourceId: input.resourceId ?? null,
        projectId: input.projectId ?? null, decision: input.decision, payloadHash: input.payloadHash, metadata,
      });
      const inserted = await client.query<AuditEntry>(`INSERT INTO audit_log
        (id, workspace_id, company_id, sequence, created_at, actor, actor_role, request_id, correlation_id, snapshot_id,
         action, resource_type, resource_id, project_id, decision, payload_hash, prev_hash, entry_hash, metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING ${auditEntryColumns}`,
        [id, context.workspaceId, companyId, sequence, createdAt, input.actor, input.actorRole,
          input.requestId ?? null, input.correlationId ?? null, input.snapshotId ?? null,
          input.action, input.resourceType, input.resourceId ?? null, input.projectId ?? null,
          input.decision, input.payloadHash, prevHash, entryHash, JSON.stringify(metadata)]);
      await client.query("COMMIT");
      return inserted.rows[0]!;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

export async function listAuditEntries(pool: Pool, context: AuthContext, companyId: string, filters: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: number; fromSequence?: number } = {}): Promise<AuditEntry[]> {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<AuditEntry>(`SELECT ${auditEntryColumns} FROM audit_log
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::text IS NULL OR actor=$3)
        AND ($4::text IS NULL OR request_id=$4)
        AND ($5::text IS NULL OR correlation_id=$5)
        AND ($6::text IS NULL OR action=$6)
        AND ($7::bigint IS NULL OR sequence >= $7)
      ORDER BY sequence ASC LIMIT $8`,
      [context.workspaceId, companyId, filters.actor ?? null, filters.requestId ?? null, filters.correlationId ?? null,
        filters.action ?? null, filters.fromSequence ?? null, Math.max(1, Math.min(filters.limit ?? 200, 1000))]);
    return result.rows;
  }

export async function verifyAuditChain(pool: Pool, context: AuthContext, companyId: string, range: { fromSequence?: number; toSequence?: number } = {}): Promise<AuditChainVerification> {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<AuditEntry>(`SELECT ${auditEntryColumns} FROM audit_log
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::bigint IS NULL OR sequence <= $3)
      ORDER BY sequence ASC`,
      [context.workspaceId, companyId, range.toSequence ?? null]);
    return { ...verifyAuditEntries(result.rows), companyId,
      entryCount: result.rows.filter(entry => range.fromSequence === undefined || entry.sequence >= range.fromSequence).length };
  }

export async function auditChainState(pool: Pool, context: AuthContext, companyId: string): Promise<AuditChainState> {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<{ entry_count: string; head_sequence: string | null; head_hash: string | null }>(
      "SELECT count(*)::text AS entry_count, max(sequence)::text AS head_sequence, (array_agg(entry_hash ORDER BY sequence DESC))[1] AS head_hash FROM audit_log WHERE company_id=$1",
      [companyId]);
    const row = result.rows[0];
    return {
      companyId,
      entryCount: Number(row?.entry_count ?? 0),
      headSequence: Number(row?.head_sequence ?? 0),
      headHash: row?.head_hash ?? null,
    };
  }

export async function listAuditAnchors(pool: Pool, context: AuthContext, companyId: string, limit = 90): Promise<AuditAnchor[]> {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<AuditAnchor>(`SELECT ${auditAnchorColumns} FROM audit_anchors
      WHERE workspace_id=$1 AND company_id=$2 ORDER BY day DESC LIMIT $3`,
      [context.workspaceId, companyId, Math.max(1, Math.min(limit, 365))]);
    return result.rows;
  }

export async function auditCompanies(pool: Pool, context: AuthContext): Promise<string[]> {
    const result = await pool.query<{ company_id: string }>(
      "SELECT DISTINCT company_id FROM audit_log WHERE workspace_id=$1 ORDER BY company_id", [context.workspaceId]);
    return result.rows.map((row) => row.company_id);
  }

export async function systemAuditChains(pool: Pool, workspaceId: string) {
    const companies = await pool.query<{ company_id: string }>(
      "SELECT company_id FROM audit_log WHERE workspace_id=$1 UNION SELECT company_id FROM audit_anchors WHERE workspace_id=$1 ORDER BY company_id", [workspaceId]);
    const result: Array<{ companyId: string; state: AuditChainState; verification: AuditChainVerification; anchor: AuditAnchor | null; anchorVerification?: AuditChainVerification }> = [];
    for (const row of companies.rows) {
      const entries = await pool.query<AuditEntry>(`SELECT ${auditEntryColumns} FROM audit_log
        WHERE workspace_id=$1 AND company_id=$2 ORDER BY sequence ASC`, [workspaceId, row.company_id]);
      const verification = verifyAuditEntries(entries.rows);
      const last = entries.rows[entries.rows.length - 1];
      const anchors = await pool.query<AuditAnchor>(
        `SELECT ${auditAnchorColumns} FROM audit_anchors WHERE workspace_id=$1 AND company_id=$2 ORDER BY day DESC LIMIT 1`, [workspaceId, row.company_id]);
      const anchor = anchors.rows[0] ?? null;
      result.push({
        companyId: row.company_id,
        state: { companyId: row.company_id, entryCount: entries.rows.length, headSequence: last?.sequence ?? 0, headHash: last?.entryHash ?? null },
        verification: { ...verification, companyId: row.company_id }, anchor,
        anchorVerification: anchor ? { ...verifyAuditEntries(entries.rows.filter(entry => entry.sequence <= anchor.sequence)), companyId: row.company_id } : undefined,
      });
    }
    return result;
  }
import { listGoals } from "./postgres-goal-repositories";
export { listGoals, createGoal, updateGoal, deleteGoal } from "./postgres-goal-repositories";

export async function listMemory(pool: Pool, context: AuthContext, businessId: string, query = "", limit = 100) {
    await getBusiness(pool, context, businessId);
    const needle = `%${query.trim()}%`;
    return (await pool.query<MemoryItem>(`SELECT ${memoryColumns} FROM memory_items WHERE workspace_id=$1 AND business_id=$2 AND ($3='' OR type ILIKE $4 OR title ILIKE $4 OR content ILIKE $4) ORDER BY updated_at DESC LIMIT $5`, [context.workspaceId, businessId, query.trim(), needle, Math.min(limit, 100)])).rows;
  }

export async function createMemory(pool: Pool, context: AuthContext, businessId: string, input: MemoryInput) {
    await getBusiness(pool, context, businessId); assertNoSecrets(input);
    const values = [randomUUID(), context.workspaceId, businessId, context.userId, input.type, input.title.trim(), input.content.trim(), input.source ?? "user", input.confidence ?? null];
    const result = await pool.query<MemoryItem>(`INSERT INTO memory_items(id,workspace_id,business_id,user_id,type,title,content,source,confidence) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING ${memoryColumns}`, values);
    return result.rows[0]!;
  }

export async function updateMemory(pool: Pool, context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>) {
    await getBusiness(pool, context, businessId); assertNoSecrets(input);
    const values = [memoryId, context.workspaceId, businessId, input.type, input.title, input.content, input.source, input.confidence];
    const result = await pool.query<MemoryItem>(`UPDATE memory_items SET type=COALESCE($4,type),title=COALESCE($5,title),content=COALESCE($6,content),source=COALESCE($7,source),confidence=COALESCE($8,confidence),updated_at=now() WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING ${memoryColumns}`, values.map((value) => value === undefined ? null : value));
    if (!result.rowCount) throw new WorkspaceAccessError("Memory is not available for this business");
    return result.rows[0]!;
  }

export async function deleteMemory(pool: Pool, context: AuthContext, businessId: string, memoryId: string) {
    await getBusiness(pool, context, businessId);
    return Boolean((await pool.query("DELETE FROM memory_items WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING id", [memoryId, context.workspaceId, businessId])).rowCount);
  }

export async function listConversations(pool: Pool, context: AuthContext, businessId: string) {
    await getBusiness(pool, context, businessId);
    return (await pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE workspace_id=$1 AND business_id=$2 AND user_id=$3 ORDER BY updated_at DESC`, [context.workspaceId, businessId, context.userId])).rows;
  }

export async function createConversation(pool: Pool, context: AuthContext, businessId: string, title: string) {
    await getBusiness(pool, context, businessId);
    const result = await pool.query<Conversation>(`INSERT INTO conversations(id,workspace_id,business_id,user_id,title) VALUES ($1,$2,$3,$4,$5) RETURNING ${conversationColumns}`, [randomUUID(), context.workspaceId, businessId, context.userId, title.trim().slice(0, 120) || "New conversation"]);
    return result.rows[0]!;
  }

export async function getConversation(pool: Pool, context: AuthContext, businessId: string, conversationId: string) {
    await getBusiness(pool, context, businessId);
    const result = await pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE id=$1 AND workspace_id=$2 AND business_id=$3 AND user_id=$4`, [conversationId, context.workspaceId, businessId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Conversation is not available for this business");
    const messages = (await pool.query<ConversationMessage>(`SELECT id, conversation_id AS "conversationId", role, content, created_at AS "createdAt" FROM messages WHERE conversation_id=$1 ORDER BY created_at,id`, [conversationId])).rows;
    return { conversation: result.rows[0]!, messages };
  }

export async function updateConversation(pool: Pool, context: AuthContext, businessId: string, conversationId: string, title: string) {
    await getConversation(pool, context, businessId, conversationId);
    const result = await pool.query<Conversation>(
      `UPDATE conversations SET title=$1,updated_at=now() WHERE id=$2 RETURNING ${conversationColumns}`,
      [title.trim().slice(0, 120) || "New conversation", conversationId],
    );
    return result.rows[0]!;
  }

export async function deleteConversation(pool: Pool, context: AuthContext, businessId: string, conversationId: string) {
    await getConversation(pool, context, businessId, conversationId);
    return Boolean((await pool.query("DELETE FROM conversations WHERE id=$1", [conversationId])).rowCount);
  }

export async function appendMessage(pool: Pool, context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string) {
    await getConversation(pool, context, businessId, conversationId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize appends and use millisecond precision so JSON/JS retains the guaranteed order.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["chat:" + conversationId]);
      const result = await client.query<ConversationMessage>(`INSERT INTO messages(id,conversation_id,role,content,created_at)
        SELECT $1,$2,$3,$4,GREATEST(date_trunc('milliseconds',clock_timestamp()), COALESCE(MAX(created_at) + interval '1 millisecond',clock_timestamp()))
        FROM messages WHERE conversation_id=$2 RETURNING id,conversation_id AS "conversationId",role,content,created_at AS "createdAt"`, [randomUUID(), conversationId, role, content]);
      await client.query("UPDATE conversations SET updated_at=clock_timestamp() WHERE id=$1", [conversationId]);
      await client.query("COMMIT");
      return result.rows[0]!;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

export async function listNeutralConversations(pool: Pool, context: AuthContext) {
    await ensureIdentity(pool, context);
    return (await pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE workspace_id=$1 AND business_id IS NULL AND user_id=$2 ORDER BY updated_at DESC`, [context.workspaceId, context.userId])).rows;
  }

export async function createNeutralConversation(pool: Pool, context: AuthContext, title: string) {
    await ensureIdentity(pool, context);
    const result = await pool.query<Conversation>(`INSERT INTO conversations(id,workspace_id,business_id,user_id,title) VALUES ($1,$2,NULL,$3,$4) RETURNING ${conversationColumns}`, [randomUUID(), context.workspaceId, context.userId, title.trim().slice(0, 120) || "New conversation"]);
    return result.rows[0]!;
  }

export async function getNeutralConversation(pool: Pool, context: AuthContext, conversationId: string) {
    await ensureIdentity(pool, context);
    const result = await pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE id=$1 AND workspace_id=$2 AND business_id IS NULL AND user_id=$3`, [conversationId, context.workspaceId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Conversation is not available to this user");
    const messages = (await pool.query<ConversationMessage>(`SELECT id, conversation_id AS "conversationId", role, content, created_at AS "createdAt" FROM messages WHERE conversation_id=$1 ORDER BY created_at`, [conversationId])).rows;
    return { conversation: result.rows[0]!, messages };
  }

export async function updateNeutralConversation(pool: Pool, context: AuthContext, conversationId: string, title: string) {
    await getNeutralConversation(pool, context, conversationId);
    const result = await pool.query<Conversation>(`UPDATE conversations SET title=$1,updated_at=now() WHERE id=$2 RETURNING ${conversationColumns}`, [title.trim().slice(0, 120) || "New conversation", conversationId]);
    return result.rows[0]!;
  }

export async function deleteNeutralConversation(pool: Pool, context: AuthContext, conversationId: string) {
    await getNeutralConversation(pool, context, conversationId);
    return Boolean((await pool.query("DELETE FROM conversations WHERE id=$1", [conversationId])).rowCount);
  }

export async function appendNeutralMessage(pool: Pool, context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string) {
    await getNeutralConversation(pool, context, conversationId);
    const result = await pool.query<ConversationMessage>(`INSERT INTO messages(id,conversation_id,role,content) VALUES ($1,$2,$3,$4) RETURNING id,conversation_id AS "conversationId",role,content,created_at AS "createdAt"`, [randomUUID(), conversationId, role, content]);
    await pool.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conversationId]);
    return result.rows[0]!;
  }
export async function listCompanyAgents(pool: Pool, context: AuthContext, companyId: string) {
    await assertCompany(pool, context, companyId);
    return (await pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE workspace_id=$1 AND company_id=$2 ORDER BY sort_order,created_at,id`, [context.workspaceId, companyId])).rows;
  }

export async function listCompanyAgentsPage(pool: Pool, context: AuthContext, companyId: string, requestedLimit = 50, cursor?: string) {
    await assertCompany(pool, context, companyId);
    const limit = companyPageLimit(requestedLimit), after = decodeBusinessCursor(cursor);
    const result = await pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::timestamptz IS NULL OR (created_at,id) > ($3::timestamptz,$4::text))
      ORDER BY created_at,id LIMIT $5`, [context.workspaceId, companyId, after?.createdAt ?? null, after?.id ?? "", limit + 1]);
    const items = result.rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: result.rows.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

export async function assertProjectAgent(pool: Pool, context: AuthContext, companyId: string, agentId?: string) {
    if (!agentId) return;
    const result = await pool.query("SELECT 1 FROM company_agents WHERE id=$1 AND workspace_id=$2 AND company_id=$3", [agentId, context.workspaceId, companyId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Agent does not belong to this company");
  }

export async function getCompanyAgent(pool: Pool, context: AuthContext, companyId: string, agentId: string) {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3`, [agentId, context.workspaceId, companyId]);
    if (!result.rowCount) throw new WorkspaceNotFoundError("Agent was not found in this company");
    return result.rows[0]!;
  }

export async function createCompanyAgent(pool: Pool, context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string) {
    await assertCompany(pool, context, companyId);
    const name = input.name?.trim(), role = input.role?.trim();
    if (!name || !role) throw new Error("Agent name and role are required");
    const values = [randomUUID(), context.workspaceId, companyId, name, role, input.description ?? null,
      input.systemInstruction ?? null, input.promptGuidelines ?? null, JSON.stringify(input.recommendedPrompts ?? []),
      input.modelId ?? null, input.fallbackModelId ?? null, JSON.stringify(input.tools ?? []), input.isActive ?? true,
      input.positionX ?? null, input.positionY ?? null, input.sortOrder ?? 0, idempotencyKey];
    const result = await pool.query<CompanyAgent>(`INSERT INTO company_agents(
      id,workspace_id,company_id,name,role,description,system_instruction,prompt_guidelines,recommended_prompts,
      model_id,fallback_model_id,tools_json,is_active,position_x,position_y,sort_order,create_request_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)
      ON CONFLICT (workspace_id,company_id,create_request_key) WHERE create_request_key IS NOT NULL DO NOTHING
      RETURNING ${companyAgentColumns}`, values);
    const agent = result.rows[0] ?? (await pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE workspace_id=$1 AND company_id=$2 AND create_request_key=$3`, [context.workspaceId, companyId, idempotencyKey])).rows[0];
    if (!agent) throw new Error("Could not create company agent");
    return agent;
  }

export async function updateCompanyAgent(pool: Pool, context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number) {
    await getCompanyAgent(pool, context, companyId, agentId);
    if (input.name !== undefined && !input.name.trim()) throw new Error("Agent name is required");
    if (input.role !== undefined && !input.role.trim()) throw new Error("Agent role is required");
    const patch = JSON.stringify(input);
    const result = await pool.query<CompanyAgent>(`UPDATE company_agents SET
      name=CASE WHEN $4::jsonb ? 'name' THEN trim($4::jsonb->>'name') ELSE name END,
      role=CASE WHEN $4::jsonb ? 'role' THEN trim($4::jsonb->>'role') ELSE role END,
      description=CASE WHEN $4::jsonb ? 'description' THEN NULLIF($4::jsonb->>'description','') ELSE description END,
      system_instruction=CASE WHEN $4::jsonb ? 'systemInstruction' THEN NULLIF($4::jsonb->>'systemInstruction','') ELSE system_instruction END,
      prompt_guidelines=CASE WHEN $4::jsonb ? 'promptGuidelines' THEN NULLIF($4::jsonb->>'promptGuidelines','') ELSE prompt_guidelines END,
      recommended_prompts=CASE WHEN $4::jsonb ? 'recommendedPrompts' THEN $4::jsonb->'recommendedPrompts' ELSE recommended_prompts END,
      model_id=CASE WHEN $4::jsonb ? 'modelId' THEN NULLIF($4::jsonb->>'modelId','') ELSE model_id END,
      fallback_model_id=CASE WHEN $4::jsonb ? 'fallbackModelId' THEN NULLIF($4::jsonb->>'fallbackModelId','') ELSE fallback_model_id END,
      tools_json=CASE WHEN $4::jsonb ? 'tools' THEN $4::jsonb->'tools' ELSE tools_json END,
      is_active=CASE WHEN $4::jsonb ? 'isActive' THEN ($4::jsonb->>'isActive')::boolean ELSE is_active END,
      position_x=CASE WHEN $4::jsonb ? 'positionX' THEN ($4::jsonb->>'positionX')::double precision ELSE position_x END,
      position_y=CASE WHEN $4::jsonb ? 'positionY' THEN ($4::jsonb->>'positionY')::double precision ELSE position_y END,
      sort_order=CASE WHEN $4::jsonb ? 'sortOrder' THEN ($4::jsonb->>'sortOrder')::integer ELSE sort_order END,
      revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND revision=$5 RETURNING ${companyAgentColumns}`,
      [agentId, context.workspaceId, companyId, patch, expectedRevision]);
    if (!result.rowCount) throw new Error("Agent was changed by another request. Reload and try again.");
    return result.rows[0]!;
  }

export async function listCompanyAgentEdges(pool: Pool, context: AuthContext, companyId: string, agentIds?: string[]) {
    await assertCompany(pool, context, companyId);
    const filter = agentIds?.length ? [...new Set(agentIds)] : null;
    return (await pool.query<CompanyAgentEdge>(`SELECT ${companyEdgeColumns} FROM company_agent_edges
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::text[] IS NULL OR parent_agent_id=ANY($3::text[]) OR child_agent_id=ANY($3::text[]))
      ORDER BY created_at,id`, [context.workspaceId, companyId, filter])).rows;
  }

export async function createCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, input: { task: string; requestedMode: "auto" | "single" | "pipeline" | "fusion"; projectId?: string }, idempotencyKey: string) {
    const company = await assertCompany(pool, context, companyId);
    if (!company.mainAgentId) throw new Error("Select an active Main Agent before running the company");
    const mainAgent = await getCompanyAgent(pool, context, companyId, company.mainAgentId);
    if (!mainAgent.isActive) throw new Error("The Main Agent is inactive");
    const task = input.task?.trim();
    if (!task) throw new Error("Company task is required");
    const timestamp = new Date().toISOString();
    const snapshot = {
      contextType: "company",
      workspaceId: context.workspaceId,
      userId: context.userId,
      companyId,
      businessId: null,
      agentId: mainAgent.id,
      companyRevision: company.revision,
      capturedAt: timestamp,
    };
    const result = await pool.query<CompanyAgentRun>(`INSERT INTO company_agent_runs(
      id,workspace_id,company_id,project_id,user_id,main_agent_id,idempotency_key,task,requested_mode,context_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (workspace_id,company_id,user_id,idempotency_key) DO NOTHING
      RETURNING ${companyRunColumns}`,
      [randomUUID(), context.workspaceId, companyId, input.projectId ?? null, context.userId, mainAgent.id, idempotencyKey, task, input.requestedMode, JSON.stringify(snapshot)]);
    if (result.rows[0]) return { run: result.rows[0], created: true };
    const existing = await pool.query<CompanyAgentRun>(`SELECT ${companyRunColumns} FROM company_agent_runs
      WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND idempotency_key=$4`,
      [context.workspaceId, companyId, context.userId, idempotencyKey]);
    if (!existing.rows[0]) throw new Error("Could not create company agent run");
    return { run: existing.rows[0], created: false };
  }

export async function listCompanyAgentRuns(pool: Pool, context: AuthContext, companyId: string, limit = 50, filter?: { projectId?: string }) {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<CompanyAgentRun>(
      `SELECT ${companyRunColumns} FROM company_agent_runs
       WHERE workspace_id=$1 AND company_id=$2 AND ($4::text IS NULL OR project_id=$4)
       ORDER BY created_at DESC LIMIT $3`,
      [context.workspaceId, companyId, Math.max(1, Math.min(100, limit)), filter?.projectId ?? null]
    );
    return result.rows;
  }

export async function getCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, runId: string) {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<CompanyAgentRun>(`SELECT ${companyRunColumns} FROM company_agent_runs
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`, [runId, context.workspaceId, companyId, context.userId]);
    if (!result.rows[0]) throw new WorkspaceAccessError("Agent run is not available in this company");
    const [steps, toolAudit, backgroundEvents] = await Promise.all([
      pool.query<CompanyAgentRunStep>(`SELECT ${companyRunStepColumns} FROM company_agent_run_steps
        WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 ORDER BY step_order,lane,id`, [context.workspaceId, companyId, runId]),
      pool.query<CompanyAgentToolAudit>(`SELECT ${companyToolAuditColumns} FROM company_agent_tool_audit
        WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 ORDER BY created_at,id`, [context.workspaceId, companyId, runId]),
      pool.query<CompanyAgentRunEvent>(`SELECT ${companyRunEventColumns} FROM company_agent_run_events
        WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 ORDER BY created_at,id`, [context.workspaceId, companyId, runId]),
    ]);
    const run = result.rows[0];
    const completionStatus = run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? run.status : undefined;
    return { run, steps: steps.rows, toolAudit: toolAudit.rows, backgroundEvents: backgroundEvents.rows,
      completionReport: completionStatus && run.completedAt ? { runId: run.id, companyId: run.companyId, status: completionStatus,
        result: run.result, errorCode: run.errorCode, errorMessage: run.errorMessage, workerId: run.workerId,
        attemptCount: run.attemptCount, totalCost: run.totalCost ?? 0, totalTokens: run.totalTokens ?? 0,
        totalDurationMs: run.totalDurationMs ?? 0, completedAt: run.completedAt } : undefined };
  }

export async function getCompanyRunPendingPlan(pool: Pool, context: AuthContext, companyId: string, runId: string): Promise<unknown | null> {
    await getCompanyAgentRun(pool, context, companyId, runId);
    const result = await pool.query<{ pending_plan: unknown }>("SELECT pending_plan FROM company_agent_runs WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4", [runId, context.workspaceId, companyId, context.userId]);
    return result.rows[0]?.pending_plan ?? null;
  }

export async function setCompanyRunPendingPlan(pool: Pool, context: AuthContext, companyId: string, runId: string, plan: unknown | null): Promise<void> {
    await getCompanyAgentRun(pool, context, companyId, runId);
    await pool.query("UPDATE company_agent_runs SET pending_plan=$5::jsonb,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4", [runId, context.workspaceId, companyId, context.userId, plan === null ? null : JSON.stringify(plan)]);
  }

export async function updateCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, runId: string, patch: Partial<CompanyAgentRun>) {
    await getCompanyAgentRun(pool, context, companyId, runId);
    const value = JSON.stringify(patch);
    const result = await pool.query<CompanyAgentRun>(`UPDATE company_agent_runs SET
      status=CASE WHEN $5::jsonb ? 'status' THEN $5::jsonb->>'status' ELSE status END,
      execution_mode=CASE WHEN $5::jsonb ? 'executionMode' THEN NULLIF($5::jsonb->>'executionMode','') ELSE execution_mode END,
      selected_agent_ids=CASE WHEN $5::jsonb ? 'selectedAgentIds' THEN $5::jsonb->'selectedAgentIds' ELSE selected_agent_ids END,
      omniroute_task_id=CASE WHEN $5::jsonb ? 'omnirouteTaskId' THEN NULLIF($5::jsonb->>'omnirouteTaskId','') ELSE omniroute_task_id END,
      omniroute_combo_name=CASE WHEN $5::jsonb ? 'omnirouteComboName' THEN NULLIF($5::jsonb->>'omnirouteComboName','') ELSE omniroute_combo_name END,
      result=CASE WHEN $5::jsonb ? 'result' THEN $5::jsonb->>'result' ELSE result END,
      error_code=CASE WHEN $5::jsonb ? 'errorCode' THEN NULLIF($5::jsonb->>'errorCode','') ELSE error_code END,
      error_message=CASE WHEN $5::jsonb ? 'errorMessage' THEN NULLIF($5::jsonb->>'errorMessage','') ELSE error_message END,
      cancel_requested=CASE WHEN $5::jsonb ? 'cancelRequested' THEN ($5::jsonb->>'cancelRequested')::boolean ELSE cancel_requested END,
      total_cost=CASE WHEN $5::jsonb ? 'totalCost' THEN ($5::jsonb->>'totalCost')::numeric ELSE total_cost END,
      total_tokens=CASE WHEN $5::jsonb ? 'totalTokens' THEN ($5::jsonb->>'totalTokens')::bigint ELSE total_tokens END,
      total_duration_ms=CASE WHEN $5::jsonb ? 'totalDurationMs' THEN ($5::jsonb->>'totalDurationMs')::int ELSE total_duration_ms END,
      started_at=CASE WHEN ($5::jsonb->>'status') IN ('planning','running') THEN COALESCE(started_at,now()) ELSE started_at END,
      completed_at=CASE WHEN ($5::jsonb->>'status') IN ('completed','failed','cancelled') THEN now() WHEN ($5::jsonb->>'status') IN ('planning','running','awaiting_approval') THEN NULL ELSE completed_at END,
      updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4
      RETURNING ${companyRunColumns}`, [runId, context.workspaceId, companyId, context.userId, value]);
    if (!result.rows[0]) throw new WorkspaceAccessError("Agent run is not available in this company");
    return result.rows[0];
  }

export async function replaceCompanyAgentRunSteps(pool: Pool, context: AuthContext, companyId: string, runId: string, steps: Array<Pick<CompanyAgentRunStep, "agentId" | "stepOrder" | "lane" | "role" | "status" | "modelId">>) {
    await getCompanyAgentRun(pool, context, companyId, runId);
    const uniqueAgentIds = [...new Set(steps.map((step) => step.agentId))];
    if (uniqueAgentIds.length !== steps.length) throw new Error("A run cannot contain the same agent twice");
    for (const agentId of uniqueAgentIds) await getCompanyAgent(pool, context, companyId, agentId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [runId]);
      await client.query("DELETE FROM company_agent_run_steps WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3",
        [context.workspaceId, companyId, runId]);
      const rows: CompanyAgentRunStep[] = [];
      for (const step of steps) {
        const result = await client.query<CompanyAgentRunStep>(`INSERT INTO company_agent_run_steps(
          id,workspace_id,company_id,run_id,agent_id,step_order,lane,role,status,model_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${companyRunStepColumns}`,
          [randomUUID(), context.workspaceId, companyId, runId, step.agentId, step.stepOrder, step.lane, step.role, step.status, step.modelId]);
        rows.push(result.rows[0]!);
      }
      await client.query("COMMIT");
      return rows;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

export async function appendCompanyAgentToolAudit(pool: Pool, context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentToolAudit, "agentId" | "toolName" | "decision" | "status" | "inputSummary" | "errorMessage"> & Partial<Pick<CompanyAgentToolAudit, "latencyMs" | "cost" | "tokens" | "reasonCode" | "sequenceNumber">>) {
    await getCompanyAgentRun(pool, context, companyId, runId);
    await getCompanyAgent(pool, context, companyId, entry.agentId);
    const result = await pool.query<CompanyAgentToolAudit>(`INSERT INTO company_agent_tool_audit(
      id,workspace_id,company_id,run_id,agent_id,tool_name,decision,status,input_summary,error_message,
      latency_ms,cost,tokens,reason_code,sequence_number,completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,CASE WHEN $8 IN ('succeeded','failed','blocked') THEN now() END)
      RETURNING ${companyToolAuditColumns}`,
      [randomUUID(), context.workspaceId, companyId, runId, entry.agentId, entry.toolName, entry.decision,
        entry.status, JSON.stringify(entry.inputSummary ?? {}), entry.errorMessage ?? null, entry.latencyMs ?? null,
        entry.cost ?? null, entry.tokens ?? null, entry.reasonCode ?? null, entry.sequenceNumber ?? null]);
    return result.rows[0]!;
  }

export async function appendCompanyAgentRunEvent(pool: Pool, context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentRunEvent, "eventKey" | "eventType" | "runStatus" | "message"> & Partial<Pick<CompanyAgentRunEvent, "workerId" | "attemptCount" | "details">>) {
    const { run } = await getCompanyAgentRun(pool, context, companyId, runId);
    const values = [randomUUID(), context.workspaceId, companyId, runId, entry.eventKey, entry.eventType, entry.runStatus,
      entry.workerId ?? null, entry.attemptCount ?? run.attemptCount, entry.message.slice(0, 1000), JSON.stringify(entry.details ?? {})];
    const inserted = await pool.query<CompanyAgentRunEvent>(`INSERT INTO company_agent_run_events(
      id,workspace_id,company_id,run_id,event_key,event_type,run_status,worker_id,attempt_count,message,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (run_id,event_key) DO NOTHING RETURNING ${companyRunEventColumns}`, values);
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await pool.query<CompanyAgentRunEvent>(`SELECT ${companyRunEventColumns} FROM company_agent_run_events
      WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 AND event_key=$4`, [context.workspaceId, companyId, runId, entry.eventKey]);
    if (!existing.rows[0]) throw new Error("Could not append Company background run event");
    return existing.rows[0];
  }

export async function claimCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) {
    await assertCompany(pool, context, companyId);
    const result = await pool.query(`UPDATE company_agent_runs SET worker_id=$5,
      lease_expires_at=now()+($6::text||' milliseconds')::interval,last_heartbeat_at=now(),attempt_count=attempt_count+1,
      status='planning',error_code=NULL,error_message=NULL,completed_at=NULL,started_at=COALESCE(started_at,now()),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND cancel_requested=false
        AND attempt_count < max_attempts AND next_attempt_at <= now()
        AND (status='queued' OR (status IN ('planning','running') AND lease_expires_at < now()))`,
      [runId, context.workspaceId, companyId, context.userId, workerId, leaseMs]);
    return Boolean(result.rowCount);
  }

export async function heartbeatCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) {
    const result = await pool.query(`UPDATE company_agent_runs SET
      lease_expires_at=now()+($6::text||' milliseconds')::interval,last_heartbeat_at=now(),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND worker_id=$5
        AND status IN ('planning','running') AND cancel_requested=false`,
      [runId, context.workspaceId, companyId, context.userId, workerId, leaseMs]);
    return Boolean(result.rowCount);
  }

export async function requeueCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, runId: string, workerId: string, delayMs: number) {
    const result = await pool.query(`UPDATE company_agent_runs SET status='queued',worker_id=NULL,lease_expires_at=NULL,
      next_attempt_at=now()+($6::text||' milliseconds')::interval,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND worker_id=$5
        AND cancel_requested=false AND attempt_count < max_attempts`,
      [runId, context.workspaceId, companyId, context.userId, workerId, delayMs]);
    return Boolean(result.rowCount);
  }

export async function listRecoverableCompanyAgentRuns(pool: Pool, limit = 200) {
    const safeLimit = Math.max(1, Math.min(1000, limit));
    const result = await pool.query<{ workspaceId: string; userId: string; companyId: string; runId: string }>(`SELECT
      workspace_id AS "workspaceId",user_id AS "userId",company_id AS "companyId",id AS "runId"
      FROM company_agent_runs WHERE cancel_requested=false AND attempt_count < max_attempts AND next_attempt_at <= now()
        AND (status='queued' OR (status IN ('planning','running') AND lease_expires_at < now()))
      ORDER BY created_at LIMIT $1`, [safeLimit]);
    return result.rows.map((row) => ({ context: { workspaceId: row.workspaceId, userId: row.userId,
      permissions: ['workspace:read','business:manage'] }, companyId: row.companyId, runId: row.runId }));
  }

export async function getCompanyMembership(pool: Pool, companyId: string, userId: string): Promise<CompanyMember | null> {
    const result = await pool.query<CompanyMember>(`SELECT ${companyMemberColumns} FROM company_members
      WHERE company_id=$1 AND user_id=$2`, [companyId, userId]);
    return result.rows[0] ?? null;
  }

export async function listCompanyMembers(pool: Pool, companyId: string): Promise<CompanyMember[]> {
    const result = await pool.query<CompanyMember>(`SELECT ${companyMemberColumns} FROM company_members
      WHERE company_id=$1 ORDER BY created_at, id`, [companyId]);
    return result.rows;
  }

export async function countCompanyOwners(pool: Pool, companyId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM company_members
      WHERE company_id=$1 AND role='owner' AND status='active'`, [companyId]);
    return Number(result.rows[0]?.count ?? 0);
  }

export async function createCompanyInvite(pool: Pool, input: CompanyInviteInput): Promise<CompanyInvite> {
    if (!isCompanyRole(input.role)) {
      throw new CompanyMembershipError("invalid_company_role", `Unknown company role: ${String(input.role)}`, { httpStatus: 400 });
    }

    const duplicate = await pool.query("SELECT 1 FROM company_invites WHERE token_hash=$1", [input.tokenHash]);
    if (duplicate.rowCount) {
      throw new CompanyMembershipError("invite_token_conflict", "An invite with this token hash already exists", { httpStatus: 409 });
    }
    const result = await pool.query<CompanyInvite>(`INSERT INTO company_invites
      (id, company_id, email, role, token_hash, expires_at, created_by, accepted_at, created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (token_hash) DO NOTHING
      RETURNING ${companyInviteColumns}`,
      [input.id, input.companyId, input.email, input.role, input.tokenHash, input.expiresAt, input.createdBy,
        input.acceptedAt ?? null, input.createdAt ?? new Date()]);
    if (!result.rows[0]) {

      throw new CompanyMembershipError("invite_token_conflict", "An invite with this token hash already exists", { httpStatus: 409 });
    }
    return result.rows[0];
  }

export async function findCompanyInviteByTokenHash(pool: Pool, tokenHash: string): Promise<CompanyInvite | null> {
    const result = await pool.query<CompanyInvite>(`SELECT ${companyInviteColumns} FROM company_invites
      WHERE token_hash=$1`, [tokenHash]);
    return result.rows[0] ?? null;
  }

export async function updateCompanyMemberRole(pool: Pool, input: UpdateCompanyMemberRoleInput): Promise<CompanyMember> {
    if (!isCompanyRole(input.role)) {
      throw new CompanyMembershipError("invalid_company_role", `Unknown company role: ${String(input.role)}`, { httpStatus: 400 });
    }
    const result = await pool.query<CompanyMember>(`UPDATE company_members
      SET role=$3, revision=revision+1, updated_at=$5
      WHERE company_id=$1 AND user_id=$2 AND revision=$4
        AND NOT (status='active' AND role='owner' AND $3<>'owner'
          AND ${lastActiveOwnerPredicate("$1")})
      RETURNING ${companyMemberColumns}`,
      [input.companyId, input.userId, input.role, input.expectedRevision, input.updatedAt]);
    if (result.rows[0]) return result.rows[0];

    const current = await getCompanyMembership(pool, input.companyId, input.userId);
    if (!current) {
      throw new CompanyMembershipError("membership_not_found", "User is not a member of this company", { httpStatus: 404 });
    }
    if (current.revision !== input.expectedRevision) {
      throw new CompanyMembershipError(
        "membership_revision_conflict",
        "Company member changed by another request. Reload and try again.",
        {
          httpStatus: 409,
          details: { expectedRevision: input.expectedRevision, actualRevision: current.revision },
        },
      );
    }
    const owners = await countCompanyOwners(pool, input.companyId);
    throw new CompanyMembershipError(
      "last_owner_protected",
      "Cannot demote the only owner of the company",
      { httpStatus: 409, details: { operation: "demote", owners } },
    );
  }

export async function removeCompanyMember(pool: Pool, input: RemoveCompanyMemberInput): Promise<void> {
    const result = await pool.query(`DELETE FROM company_members
      WHERE company_id=$1 AND user_id=$2
        AND NOT (status='active' AND role='owner' AND ${lastActiveOwnerPredicate("$1")})`,
      [input.companyId, input.userId]);
    if (result.rowCount) return;

    const current = await getCompanyMembership(pool, input.companyId, input.userId);
    if (!current) return;
    const owners = await countCompanyOwners(pool, input.companyId);
    throw new CompanyMembershipError(
      "last_owner_protected",
      "Cannot remove the only owner of the company",
      { httpStatus: 409, details: { operation: "remove", owners } },
    );
  }

export async function listCompanies(pool: Pool, context: AuthContext, requestedLimit = 20, cursor?: string) {
    await assertMember(pool, context);
    const limit = companyPageLimit(requestedLimit), after = decodeBusinessCursor(cursor);
    const result = await pool.query<Company>(`SELECT ${companyColumns} FROM companies
      WHERE workspace_id=$1 AND user_id=$2 AND ($3::text IS NULL OR id=$3)
        AND ($4::timestamptz IS NULL OR (created_at,id) > ($4::timestamptz,$5::text))
      ORDER BY created_at,id LIMIT $6`, [context.workspaceId, context.userId, context.companyId ?? null, after?.createdAt ?? null, after?.id ?? "", limit + 1]);
    const items = result.rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: result.rows.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }
export async function getCompany(pool: Pool, context: AuthContext, companyId: string) { return assertCompany(pool, context, companyId); }
export async function createCompany(pool: Pool, context: AuthContext, input: CompanyInput, idempotencyKey: string) {
    if (context.companyId) throw new WorkspaceAccessError("Company-scoped API keys cannot create companies");
    await assertMember(pool, context);
    const name = input.name?.trim();
    if (!name) throw new Error("Company name is required");
    if (input.businessId) await getBusiness(pool, context, input.businessId);
    const values = [randomUUID(), context.workspaceId, context.userId, input.businessId ?? null, name, input.website ?? null,
      input.industry ?? null, input.description ?? null, input.productsServices ?? null, JSON.stringify(input.languages ?? []),
      input.brandTone ?? null, input.companyInstructions ?? null, JSON.stringify(input.knowledge ?? []),
      JSON.stringify(input.memory ?? {}), input.status ?? "active", idempotencyKey];
    const result = await pool.query<Company>(`INSERT INTO companies(
      id,workspace_id,user_id,business_id,name,website,industry,description,products_services,languages,
      brand_tone,company_instructions,knowledge,memory,status,create_request_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb,$15,$16)
      ON CONFLICT (workspace_id,user_id,create_request_key) WHERE create_request_key IS NOT NULL DO NOTHING
      RETURNING ${companyColumns}`, values);
    const company = result.rows[0] ?? (await pool.query<Company>(`SELECT ${companyColumns} FROM companies
      WHERE workspace_id=$1 AND user_id=$2 AND create_request_key=$3`, [context.workspaceId, context.userId, idempotencyKey])).rows[0];
    if (!company) throw new Error("Could not create company");
    // Persist real ownership, including an idempotent retry after an interrupted creation.
    await pool.query(`INSERT INTO company_members (id, company_id, user_id, role, status, accepted_at)
      SELECT $1, $2, $3, 'owner', 'active', now()
      WHERE NOT EXISTS (SELECT 1 FROM company_members WHERE company_id = $2)
      ON CONFLICT (company_id, user_id) DO NOTHING`, [randomUUID(), company.id, company.userId]);
    return company;
  }
export async function convertBusinessToCompany(pool: Pool, context: AuthContext, businessId: string, input: BusinessToCompanyInput, idempotencyKey: string): Promise<{ company: Company; created: boolean }> {
    const business = await getBusiness(pool, context, businessId);
    const existing = (await pool.query<Company>(`SELECT ${companyColumns} FROM companies
      WHERE workspace_id=$1 AND user_id=$2 AND create_request_key=$3`, [context.workspaceId, context.userId, idempotencyKey])).rows[0];
    if (existing) {
      return { company: existing, created: false };
    }

    const memory: Record<string, unknown> = {};
    if (input.includeConfirmedMemory) {
      const memories = await listMemory(pool, context, businessId);
      memory["confirmed_business_facts"] = memories.map((m) => m.content);
    }
    if (input.includeGoals) {
      const goals = await listGoals(pool, context, businessId);
      memory["transferred_goals"] = goals.map((g) => ({ title: g.title, description: g.description, status: g.status }));
    }

    const instructionParts: string[] = [];
    if (input.includeInstructions) {
      if (business.description) instructionParts.push(`Business Description: ${business.description}`);
      if (business.businessModel) instructionParts.push(`Business Model: ${business.businessModel}`);
    }
    if (input.includeResearchSummary) {
      if (business.audienceSummary) instructionParts.push(`Target Audience: ${business.audienceSummary}`);
      if (business.market) instructionParts.push(`Market & Niche: ${business.market} / ${business.niche ?? ""}`);
    }

    const companyInput: CompanyInput = {
      name: input.companyName?.trim() || business.name,
      businessId: business.id,
      website: business.website,
      industry: business.industry,
      description: business.description,
      productsServices: business.productsServicesSummary,
      knowledge: business.logoFileId ? [{ attachmentId: business.logoFileId, kind: "image", name: "Company logo", source: "linked_business" }] : [],
      companyInstructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
      memory,
      languages: ["Ukrainian", "English"],
      status: "active",
    };

    const company = await createCompany(pool, context, companyInput, idempotencyKey);

    const mainAgent = await createCompanyAgent(pool, context, company.id, {
      name: "Main Agent",
      role: "Coordinator",
      description: `Primary executive agent for ${company.name}`,
      tools: ["web.search", "files", "knowledge"],
      isActive: true,
    }, `${idempotencyKey}:main-agent`);

    await setCompanyMainAgent(pool, context, company.id, mainAgent.id, company.revision);
    const updatedCompany = await getCompany(pool, context, company.id);

    return { company: updatedCompany, created: true };
  }
export async function updateCompany(pool: Pool, context: AuthContext, companyId: string, input: Partial<CompanyInput>, expectedRevision: number) {
    await assertCompany(pool, context, companyId);
    if (input.businessId) await getBusiness(pool, context, input.businessId);
    if (input.name !== undefined && !input.name.trim()) throw new Error("Company name is required");
    const patch = JSON.stringify(input);
    const result = await pool.query<Company>(`UPDATE companies SET
      business_id=CASE WHEN $4::jsonb ? 'businessId' THEN NULLIF($4::jsonb->>'businessId','') ELSE business_id END,
      name=CASE WHEN $4::jsonb ? 'name' THEN trim($4::jsonb->>'name') ELSE name END,
      website=CASE WHEN $4::jsonb ? 'website' THEN NULLIF($4::jsonb->>'website','') ELSE website END,
      industry=CASE WHEN $4::jsonb ? 'industry' THEN NULLIF($4::jsonb->>'industry','') ELSE industry END,
      description=CASE WHEN $4::jsonb ? 'description' THEN NULLIF($4::jsonb->>'description','') ELSE description END,
      products_services=CASE WHEN $4::jsonb ? 'productsServices' THEN NULLIF($4::jsonb->>'productsServices','') ELSE products_services END,
      languages=CASE WHEN $4::jsonb ? 'languages' THEN $4::jsonb->'languages' ELSE languages END,
      brand_tone=CASE WHEN $4::jsonb ? 'brandTone' THEN NULLIF($4::jsonb->>'brandTone','') ELSE brand_tone END,
      company_instructions=CASE WHEN $4::jsonb ? 'companyInstructions' THEN NULLIF($4::jsonb->>'companyInstructions','') ELSE company_instructions END,
      memory=CASE WHEN $4::jsonb ? 'memory' THEN $4::jsonb->'memory' ELSE memory END,
      status=CASE WHEN $4::jsonb ? 'status' THEN $4::jsonb->>'status' ELSE status END,
      revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND revision=$5 RETURNING ${companyColumns}`,
      [companyId, context.workspaceId, context.userId, patch, expectedRevision]);
    if (!result.rowCount) throw new Error("Company was changed by another request. Reload and try again.");
    return result.rows[0]!;
  }
export async function deleteCompany(pool: Pool, context: AuthContext, companyId: string) {
    await assertCompany(pool, context, companyId);
    return Boolean((await pool.query("DELETE FROM companies WHERE id=$1 AND workspace_id=$2 AND user_id=$3 RETURNING id", [companyId, context.workspaceId, context.userId])).rowCount);
  }
export async function setCompanyMainAgent(pool: Pool, context: AuthContext, companyId: string, agentId: string | null, expectedRevision: number) {
    await assertCompany(pool, context, companyId);
    if (agentId) await getCompanyAgent(pool, context, companyId, agentId);
    const result = await pool.query<Company>(`UPDATE companies SET main_agent_id=$4,revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND revision=$5 RETURNING ${companyColumns}`,
      [companyId, context.workspaceId, context.userId, agentId, expectedRevision]);
    if (!result.rowCount) throw new Error("Company was changed by another request. Reload and try again.");
    return result.rows[0]!;
  }
export async function deleteCompanyAgent(pool: Pool, context: AuthContext, companyId: string, agentId: string, expectedRevision: number) {
    await assertCompany(pool, context, companyId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [companyId]);
      const current = await client.query<{ revision: number }>(`SELECT revision FROM company_agents
        WHERE id=$1 AND workspace_id=$2 AND company_id=$3 FOR UPDATE`, [agentId, context.workspaceId, companyId]);
      if (!current.rowCount) { await client.query("COMMIT"); return false; }
      if (current.rows[0]!.revision !== expectedRevision) throw new Error("Agent was changed by another request. Reload and try again.");
      await client.query(`DELETE FROM company_agent_edges
        WHERE workspace_id=$1 AND company_id=$2 AND (parent_agent_id=$3 OR child_agent_id=$3)`, [context.workspaceId, companyId, agentId]);
      await client.query(`UPDATE companies SET main_agent_id=NULL,revision=revision+1,updated_at=now()
        WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND main_agent_id=$4`, [companyId, context.workspaceId, context.userId, agentId]);
      await client.query("DELETE FROM company_agents WHERE id=$1 AND workspace_id=$2 AND company_id=$3", [agentId, context.workspaceId, companyId]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
