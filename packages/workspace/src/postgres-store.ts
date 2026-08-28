import { randomUUID } from "node:crypto";
import { assertNoSecrets } from "@npati/memory";
import { Pool } from "pg";
import migration001 from "./migration-001";
import migration002 from "./migration-002";
import migration003 from "./migration-003";
import type { AuthContext, Business, BusinessInput, BusinessOnboardingSession, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore } from "./types";
import { WorkspaceAccessError } from "./types";
import { ONBOARDING_FLOWS, onboardingBusinessPatch, onboardingPlaceholder } from "./onboarding";

const businessColumns = `id, workspace_id AS "workspaceId", owner_user_id AS "ownerUserId", name,
  business_type AS "businessType", industry, niche, country, market, website, business_stage AS "businessStage",
  team_type AS "teamType", business_model AS "businessModel", presence_type AS "presenceType", description,
  audience_summary AS "audienceSummary", products_services_summary AS "productsServicesSummary",
  activation_status AS "activationStatus", created_at AS "createdAt", updated_at AS "updatedAt"`;
const goalColumns = `id, workspace_id AS "workspaceId", business_id AS "businessId", created_by_user_id AS "createdByUserId",
  title, description, status, target_value::float AS "targetValue", target_unit AS "targetUnit",
  current_value::float AS "currentValue", target_date::text AS "targetDate", priority,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const memoryColumns = `id, workspace_id AS "workspaceId", business_id AS "businessId", user_id AS "userId",
  type, title, content, source, confidence::float, created_at AS "createdAt", updated_at AS "updatedAt"`;
const conversationColumns = `id, workspace_id AS "workspaceId", business_id AS "businessId", user_id AS "userId",
  title, created_at AS "createdAt", updated_at AS "updatedAt"`;
const onboardingColumns = 'id, workspace_id AS "workspaceId", user_id AS "userId", business_id AS "businessId", conversation_id AS "conversationId", scenario, status, current_step AS "currentStep", completed_fields AS "completedFields", skipped_fields AS "skippedFields", created_at AS "createdAt", updated_at AS "updatedAt"';

export class PostgresWorkspaceStore implements WorkspaceStore {
  private readonly pool: Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 10 }); }

  async initialize(context?: AuthContext) {
    await this.pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const [version, sql] of [["001_business_workspace", migration001], ["002_conversational_onboarding", migration002], ["003_conversation_titles", migration003]] as const) {
      const applied = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (applied.rowCount) continue;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    if (context) await this.ensureIdentity(context);
  }

  async health() {
    try { await this.pool.query("SELECT 1"); return "ok" as const; }
    catch { return "unavailable" as const; }
  }

  private async ensureIdentity(context: AuthContext) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO users(id, external_subject, display_name) VALUES ($1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET external_subject=COALESCE(EXCLUDED.external_subject,users.external_subject), updated_at=now()`, [context.userId, context.externalSubject ?? null, "Dev User"]);
      await client.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES ($1,$2,$3) ON CONFLICT(id) DO NOTHING`, [context.workspaceId, "My Workspace", context.userId]);
      await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'owner') ON CONFLICT(workspace_id,user_id) DO NOTHING`, [context.workspaceId, context.userId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async assertMember(context: AuthContext) {
    const result = await this.pool.query("SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Workspace access denied");
    return String(result.rows[0].role);
  }

  async getBusiness(context: AuthContext, businessId: string) {
    await this.assertMember(context);
    const result = await this.pool.query<Business>(`SELECT ${businessColumns} FROM businesses WHERE id=$1 AND workspace_id=$2`, [businessId, context.workspaceId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Business is not available in this workspace");
    return result.rows[0]!;
  }

  async listBusinesses(context: AuthContext) {
    await this.assertMember(context);
    return (await this.pool.query<Business>(`SELECT ${businessColumns} FROM businesses WHERE workspace_id=$1 AND activation_status='active' ORDER BY created_at`, [context.workspaceId])).rows;
  }

  async overview(context: AuthContext): Promise<WorkspaceOverview> {
    await this.ensureIdentity(context);
    const role = await this.assertMember(context);
    const businesses = await this.listBusinesses(context);
    const identity = await this.pool.query(`SELECT u.display_name, w.name, wm.current_business_id
      FROM workspace_members wm JOIN users u ON u.id=wm.user_id JOIN workspaces w ON w.id=wm.workspace_id
      WHERE wm.workspace_id=$1 AND wm.user_id=$2`, [context.workspaceId, context.userId]);
    let currentId = identity.rows[0]?.current_business_id as string | null;
    if (!currentId && businesses.length > 0) {
      currentId = businesses[0]!.id;
      await this.pool.query("UPDATE workspace_members SET current_business_id=$3 WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId, currentId]);
    }
    return {
      user: { id: context.userId, displayName: String(identity.rows[0]?.display_name ?? "Dev User") },
      workspace: { id: context.workspaceId, name: String(identity.rows[0]?.name ?? "My Workspace"), role },
      businesses,
      currentBusiness: businesses.find((business) => business.id === currentId) ?? null,
      onboarding: await this.getOnboarding(context),
    };
  }

  async setCurrentBusiness(context: AuthContext, businessId: string) {
    const business = await this.getBusiness(context, businessId);
    if (business.activationStatus !== "active") throw new Error("Complete business onboarding before selecting this business");
    await this.pool.query("UPDATE workspace_members SET current_business_id=$3 WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId, businessId]);
    return business;
  }

  async createBusiness(context: AuthContext, input: BusinessInput) {
    await this.assertMember(context);
    const id = randomUUID();
    const values = [id, context.workspaceId, context.userId, input.name.trim(), input.businessType ?? null, input.industry ?? null, input.niche ?? null, input.country ?? null, input.market ?? null, input.website ?? null, input.businessStage ?? "starting", input.teamType ?? null, input.businessModel ?? null, input.presenceType ?? null, input.description ?? null, input.audienceSummary ?? null, input.productsServicesSummary ?? null];
    if (!values[3]) throw new Error("Business name is required");
    const result = await this.pool.query<Business>(`INSERT INTO businesses(id,workspace_id,owner_user_id,name,business_type,industry,niche,country,market,website,business_stage,team_type,business_model,presence_type,description,audience_summary,products_services_summary)
      VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING ${businessColumns}`, values);
    const count = await this.pool.query("SELECT count(*)::int AS count FROM businesses WHERE workspace_id=$1 AND activation_status='active'", [context.workspaceId]);
    if (count.rows[0].count === 1) await this.setCurrentBusiness(context, id);
    return result.rows[0]!;
  }

  async updateBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>) {
    await this.getBusiness(context, businessId);
    const values = [businessId, context.workspaceId, input.name, input.businessType, input.industry, input.niche, input.country, input.market, input.website, input.businessStage, input.teamType, input.businessModel, input.presenceType, input.description, input.audienceSummary, input.productsServicesSummary];
    const result = await this.pool.query<Business>(`UPDATE businesses SET
      name=COALESCE($3,name), business_type=COALESCE($4,business_type), industry=COALESCE($5,industry), niche=COALESCE($6,niche),
      country=COALESCE($7,country), market=COALESCE($8,market), website=COALESCE($9,website), business_stage=COALESCE($10,business_stage),
      team_type=COALESCE($11,team_type), business_model=COALESCE($12,business_model), presence_type=COALESCE($13,presence_type),
      description=COALESCE($14,description), audience_summary=COALESCE($15,audience_summary),
      products_services_summary=COALESCE($16,products_services_summary), updated_at=now()
      WHERE id=$1 AND workspace_id=$2 RETURNING ${businessColumns}`, values.map((value) => value === undefined ? null : value));
    return result.rows[0]!;
  }

  async deleteBusiness(context: AuthContext, businessId: string) {
    await this.getBusiness(context, businessId);
    return Boolean((await this.pool.query("DELETE FROM businesses WHERE id=$1 AND workspace_id=$2 RETURNING id", [businessId, context.workspaceId])).rowCount);
  }

  async listGoals(context: AuthContext, businessId: string) {
    await this.getBusiness(context, businessId);
    return (await this.pool.query<Goal>(`SELECT ${goalColumns} FROM goals WHERE workspace_id=$1 AND business_id=$2 ORDER BY priority, updated_at DESC`, [context.workspaceId, businessId])).rows;
  }

  async createGoal(context: AuthContext, businessId: string, input: GoalInput) {
    await this.getBusiness(context, businessId);
    const values = [randomUUID(), context.workspaceId, businessId, context.userId, input.title.trim(), input.description ?? null, input.status ?? "active", input.targetValue ?? null, input.targetUnit ?? null, input.currentValue ?? null, input.targetDate ?? null, input.priority ?? 3];
    const result = await this.pool.query<Goal>(`INSERT INTO goals(id,workspace_id,business_id,created_by_user_id,title,description,status,target_value,target_unit,current_value,target_date,priority)
      VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING ${goalColumns}`, values);
    return result.rows[0]!;
  }

  async updateGoal(context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>) {
    await this.getBusiness(context, businessId);
    const values = [goalId, context.workspaceId, businessId, input.title, input.description, input.status, input.targetValue, input.targetUnit, input.currentValue, input.targetDate, input.priority];
    const result = await this.pool.query<Goal>(`UPDATE goals SET title=COALESCE($4,title),description=COALESCE($5,description),status=COALESCE($6,status),target_value=COALESCE($7,target_value),target_unit=COALESCE($8,target_unit),current_value=COALESCE($9,current_value),target_date=COALESCE($10,target_date),priority=COALESCE($11,priority),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING ${goalColumns}`, values.map((value) => value === undefined ? null : value));
    if (!result.rowCount) throw new WorkspaceAccessError("Goal is not available for this business");
    return result.rows[0]!;
  }

  async deleteGoal(context: AuthContext, businessId: string, goalId: string) {
    await this.getBusiness(context, businessId);
    return Boolean((await this.pool.query("DELETE FROM goals WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING id", [goalId, context.workspaceId, businessId])).rowCount);
  }

  async listMemory(context: AuthContext, businessId: string, query = "", limit = 100) {
    await this.getBusiness(context, businessId);
    const needle = `%${query.trim()}%`;
    return (await this.pool.query<MemoryItem>(`SELECT ${memoryColumns} FROM memory_items WHERE workspace_id=$1 AND business_id=$2 AND ($3='' OR type ILIKE $4 OR title ILIKE $4 OR content ILIKE $4) ORDER BY updated_at DESC LIMIT $5`, [context.workspaceId, businessId, query.trim(), needle, Math.min(limit, 100)])).rows;
  }

  async createMemory(context: AuthContext, businessId: string, input: MemoryInput) {
    await this.getBusiness(context, businessId); assertNoSecrets(input);
    const values = [randomUUID(), context.workspaceId, businessId, context.userId, input.type, input.title.trim(), input.content.trim(), input.source ?? "user", input.confidence ?? null];
    const result = await this.pool.query<MemoryItem>(`INSERT INTO memory_items(id,workspace_id,business_id,user_id,type,title,content,source,confidence) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING ${memoryColumns}`, values);
    return result.rows[0]!;
  }

  async updateMemory(context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>) {
    await this.getBusiness(context, businessId); assertNoSecrets(input);
    const values = [memoryId, context.workspaceId, businessId, input.type, input.title, input.content, input.source, input.confidence];
    const result = await this.pool.query<MemoryItem>(`UPDATE memory_items SET type=COALESCE($4,type),title=COALESCE($5,title),content=COALESCE($6,content),source=COALESCE($7,source),confidence=COALESCE($8,confidence),updated_at=now() WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING ${memoryColumns}`, values.map((value) => value === undefined ? null : value));
    if (!result.rowCount) throw new WorkspaceAccessError("Memory is not available for this business");
    return result.rows[0]!;
  }

  async deleteMemory(context: AuthContext, businessId: string, memoryId: string) {
    await this.getBusiness(context, businessId);
    return Boolean((await this.pool.query("DELETE FROM memory_items WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING id", [memoryId, context.workspaceId, businessId])).rowCount);
  }

  async listConversations(context: AuthContext, businessId: string) {
    await this.getBusiness(context, businessId);
    return (await this.pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE workspace_id=$1 AND business_id=$2 AND user_id=$3 ORDER BY updated_at DESC`, [context.workspaceId, businessId, context.userId])).rows;
  }

  async createConversation(context: AuthContext, businessId: string, title: string) {
    await this.getBusiness(context, businessId);
    const result = await this.pool.query<Conversation>(`INSERT INTO conversations(id,workspace_id,business_id,user_id,title) VALUES ($1,$2,$3,$4,$5) RETURNING ${conversationColumns}`, [randomUUID(), context.workspaceId, businessId, context.userId, title.trim().slice(0, 120) || "New conversation"]);
    return result.rows[0]!;
  }

  async getConversation(context: AuthContext, businessId: string, conversationId: string) {
    await this.getBusiness(context, businessId);
    const result = await this.pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE id=$1 AND workspace_id=$2 AND business_id=$3 AND user_id=$4`, [conversationId, context.workspaceId, businessId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Conversation is not available for this business");
    const messages = (await this.pool.query<ConversationMessage>(`SELECT id, conversation_id AS "conversationId", role, content, created_at AS "createdAt" FROM messages WHERE conversation_id=$1 ORDER BY created_at`, [conversationId])).rows;
    return { conversation: result.rows[0]!, messages };
  }

  async updateConversation(context: AuthContext, businessId: string, conversationId: string, title: string) {
    await this.getConversation(context, businessId, conversationId);
    const result = await this.pool.query<Conversation>(
      `UPDATE conversations SET title=$1,updated_at=now() WHERE id=$2 RETURNING ${conversationColumns}`,
      [title.trim().slice(0, 120) || "New conversation", conversationId],
    );
    return result.rows[0]!;
  }

  async deleteConversation(context: AuthContext, businessId: string, conversationId: string) {
    await this.getConversation(context, businessId, conversationId);
    return Boolean((await this.pool.query("DELETE FROM conversations WHERE id=$1", [conversationId])).rowCount);
  }

  async appendMessage(context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string) {
    await this.getConversation(context, businessId, conversationId);
    const result = await this.pool.query<ConversationMessage>(`INSERT INTO messages(id,conversation_id,role,content) VALUES ($1,$2,$3,$4) RETURNING id,conversation_id AS "conversationId",role,content,created_at AS "createdAt"`, [randomUUID(), conversationId, role, content]);
    await this.pool.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conversationId]);
    return result.rows[0]!;
  }

  private async hydrateOnboarding(context: AuthContext, row: Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">): Promise<BusinessOnboardingSession> {
    const flow = ONBOARDING_FLOWS[row.scenario];
    const legacy = row.currentStep > 0 && !row.completedFields.some((field) => field === "businessSnapshot" || field === "businessGoal");
    const currentStep = legacy && row.status === "active" ? 1 : row.currentStep;
    const completedFields = legacy && row.status === "active" ? ["businessSnapshot"] : row.completedFields;
    return { ...row, currentStep, completedFields, business: await this.getBusiness(context, row.businessId), totalFields: flow.length, currentField: flow[currentStep]?.field };
  }

  async getOnboarding(context: AuthContext) {
    await this.ensureIdentity(context);
    const result = await this.pool.query<Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">>(
      "SELECT " + onboardingColumns + " FROM business_onboarding_sessions WHERE workspace_id=$1 AND user_id=$2 AND status<>$3 ORDER BY updated_at DESC LIMIT 1",
      [context.workspaceId, context.userId, "completed"],
    );
    return result.rowCount ? this.hydrateOnboarding(context, result.rows[0]!) : null;
  }

  async startOnboarding(context: AuthContext, scenario: OnboardingScenario) {
    const existing = await this.getOnboarding(context);
    if (existing) return this.setOnboardingStatus(context, existing.id, "active");
    const placeholder = onboardingPlaceholder(scenario);
    const businessId = randomUUID();
    const conversationId = randomUUID();
    const sessionId = randomUUID();
    await this.pool.query(
      "INSERT INTO businesses(id,workspace_id,owner_user_id,name,business_type,business_stage,activation_status) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [businessId, context.workspaceId, context.userId, placeholder.name, placeholder.businessType, placeholder.businessStage, "draft"],
    );
    await this.pool.query(
      "INSERT INTO conversations(id,workspace_id,business_id,user_id,title) VALUES ($1,$2,$3,$4,$5)",
      [conversationId, context.workspaceId, businessId, context.userId, "Business setup"],
    );
    await this.pool.query(
      "INSERT INTO business_onboarding_sessions(id,workspace_id,user_id,business_id,conversation_id,scenario) VALUES ($1,$2,$3,$4,$5,$6)",
      [sessionId, context.workspaceId, context.userId, businessId, conversationId, scenario],
    );
    return (await this.getOnboarding(context))!;
  }

  async advanceOnboarding(context: AuthContext, sessionId: string, input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> }) {
    const current = await this.getOnboarding(context);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    const step = ONBOARDING_FLOWS[current.scenario][current.currentStep];
    if (!step) return current;
    if (!input.skip) {
      const value = input.value?.trim();
      if (!value) throw new Error("An answer is required or this step can be skipped");
      const stepPatch = step.field === "businessSnapshot" ? input.businessPatch ?? {} : step.field === "businessGoal" ? {} : onboardingBusinessPatch(step.field, value);
      if (Object.keys(stepPatch).length > 0) await this.updateBusiness(context, current.businessId, stepPatch);
    }
    const nextStep = current.currentStep + 1;
    const completedFields = input.skip ? current.completedFields : [...current.completedFields, step.field];
    const skippedFields = input.skip ? [...current.skippedFields, step.field] : current.skippedFields;
    const status = nextStep >= ONBOARDING_FLOWS[current.scenario].length ? "awaiting_confirmation" : "active";
    await this.pool.query(
      "UPDATE business_onboarding_sessions SET current_step=$4,completed_fields=$5::jsonb,skipped_fields=$6::jsonb,status=$7,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3",
      [sessionId, context.workspaceId, context.userId, nextStep, JSON.stringify(completedFields), JSON.stringify(skippedFields), status],
    );
    return (await this.getOnboarding(context))!;
  }

  async setOnboardingStatus(context: AuthContext, sessionId: string, status: "active" | "paused") {
    const current = await this.getOnboarding(context);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    await this.pool.query(
      "UPDATE business_onboarding_sessions SET status=$4,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3",
      [sessionId, context.workspaceId, context.userId, status],
    );
    return (await this.getOnboarding(context))!;
  }

  async completeOnboarding(context: AuthContext, sessionId: string): Promise<BusinessOnboardingSession> {
    const current = await this.getOnboarding(context);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE businesses SET activation_status='active',updated_at=now() WHERE id=$1 AND workspace_id=$2", [current.businessId, context.workspaceId]);
      await client.query("UPDATE workspace_members SET current_business_id=$3 WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId, current.businessId]);
      await client.query("UPDATE business_onboarding_sessions SET status='completed',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3", [sessionId, context.workspaceId, context.userId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return { ...current, business: { ...current.business, activationStatus: "active" as const }, status: "completed" as const, updatedAt: new Date().toISOString() };
  }
}
