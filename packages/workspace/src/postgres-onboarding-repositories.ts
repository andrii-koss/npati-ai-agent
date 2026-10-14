import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  AcceptCompanyInviteInput,
  AuthContext,
  BusinessInput,
  BusinessOnboardingSession,
  CompanyMember,
  OnboardingScenario,
} from "./types.js";
import { companyMemberColumns, lastActiveOwnerPredicate } from "./postgres-store-schema.js";
import { onboardingPlaceholder } from "./onboarding.js";
import * as project from "./postgres-workspace-repositories.js";
import { CompanyMembershipError, WorkspaceAccessError } from "./types.js";

export async function acceptCompanyInvite(
  pool: Pool,
  input: AcceptCompanyInviteInput,
): Promise<CompanyMember> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<{ companyId: string; role: CompanyMember["role"]; createdBy: string; createdAt: Date }>(
      `UPDATE company_invites SET accepted_at=$2
       WHERE id=$1 AND accepted_at IS NULL AND expires_at > $2
       RETURNING company_id AS "companyId", role, created_by AS "createdBy", created_at AS "createdAt"`,
      [input.invite.id, input.acceptedAt],
    );
    const invite = claimed.rows[0];
    if (!invite) {
      const state = await client.query<{ acceptedAt: Date | null; expiresAt: Date }>(
        `SELECT accepted_at AS "acceptedAt", expires_at AS "expiresAt" FROM company_invites WHERE id=$1`,
        [input.invite.id],
      );
      const row = state.rows[0];
      if (!row) throw new CompanyMembershipError("invite_not_found", "Invite does not exist", { httpStatus: 404 });
      if (row.acceptedAt) {
        throw new CompanyMembershipError("invite_already_accepted", "Invite token was already used", { httpStatus: 409 });
      }
      throw new CompanyMembershipError("invite_expired", "Invite token has expired", { httpStatus: 410 });
    }

    const result = await client.query<CompanyMember>(
      `INSERT INTO company_members
        (id, company_id, user_id, role, status, invited_by, invited_at, accepted_at, created_at)
        VALUES($1,$2,$3,$4,'active',$5,$6,$7,$7)
        ON CONFLICT (company_id, user_id) DO UPDATE SET
          role=$4,
          status='active',
          accepted_at=$7,
          invited_by=COALESCE(company_members.invited_by, $5),
          invited_at=COALESCE(company_members.invited_at, $6),
          revision=company_members.revision+1,
          updated_at=$7
        WHERE NOT (company_members.status='active' AND company_members.role='owner' AND $4<>'owner'
          AND ${lastActiveOwnerPredicate("$2")})
        RETURNING ${companyMemberColumns}`,
      [
        `cm_${randomUUID()}`,
        invite.companyId,
        input.userId,
        invite.role,
        invite.createdBy,
        invite.createdAt,
        input.acceptedAt,
      ],
    );
    if (!result.rows[0]) {
      throw new CompanyMembershipError(
        "last_owner_protected",
        "Cannot demote the only owner of the company by accepting an invite",
        { httpStatus: 409, details: { operation: "demote", userId: input.userId } },
      );
    }
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function startOnboarding(
  pool: Pool,
  context: AuthContext,
  scenario: OnboardingScenario,
  options?: { forceNew?: boolean },
): Promise<BusinessOnboardingSession> {
  const existing = options?.forceNew ? null : await project.getOnboarding(pool, context);
  if (existing) {
    return project.setOnboardingStatus(pool, context, existing.id, "active") as Promise<BusinessOnboardingSession>;
  }
  const placeholder = onboardingPlaceholder(scenario);
  const businessId = randomUUID();
  const conversationId = randomUUID();
  const sessionId = randomUUID();
  await pool.query(
    "INSERT INTO businesses(id,workspace_id,owner_user_id,name,business_type,business_stage,activation_status) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [
      businessId,
      context.workspaceId,
      context.userId,
      placeholder.name,
      placeholder.businessType,
      placeholder.businessStage,
      "draft",
    ],
  );
  await pool.query(
    "INSERT INTO conversations(id,workspace_id,business_id,user_id,title) VALUES ($1,$2,$3,$4,$5)",
    [conversationId, context.workspaceId, businessId, context.userId, "Business setup"],
  );
  await pool.query(
    "INSERT INTO business_onboarding_sessions(id,workspace_id,user_id,business_id,conversation_id,scenario) VALUES ($1,$2,$3,$4,$5,$6)",
    [sessionId, context.workspaceId, context.userId, businessId, conversationId, scenario],
  );
  return (await project.getOnboarding(pool, context, businessId))!;
}

export async function completeOnboarding(
  pool: Pool,
  context: AuthContext,
  sessionId: string,
): Promise<BusinessOnboardingSession> {
  const current = await project.getOnboardingSession(pool, context, sessionId);
  if (!current || current.id !== sessionId) {
    throw new WorkspaceAccessError("Onboarding session is not available");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE businesses SET activation_status='active',updated_at=now() WHERE id=$1 AND workspace_id=$2",
      [current.businessId, context.workspaceId],
    );
    await client.query(
      "UPDATE workspace_members SET current_business_id=$3 WHERE workspace_id=$1 AND user_id=$2",
      [context.workspaceId, context.userId, current.businessId],
    );
    await client.query(
      "UPDATE business_onboarding_sessions SET status='completed',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3",
      [sessionId, context.workspaceId, context.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return {
    ...current,
    business: { ...current.business, activationStatus: "active" as const },
    status: "completed" as const,
    updatedAt: new Date().toISOString(),
  };
}
