/**
 * C5a part 2B route probe (verification aid, not a deliverable).
 *
 * Exercises the seven HTTP routes end to end with `fastify.inject()` against the real route module, the
 * real membership service and the real protected-branch service — only the storage ports are in-memory
 * fakes. This is the substitute for `vitest`, which cannot start in this sandbox (`spawn EPERM`).
 *
 *   node --experimental-transform-types --import ./.c5a-probe/part2b/register.mjs .c5a-probe/part2b/routes-probe.ts
 */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { WorkspaceAccessError, type AuthContext, type CompanyInvite, type CompanyMember } from "@npati/workspace";
import { registerCodeMembershipRoutes } from "../../apps/agent-api/src/code-membership-routes";
import { CodeMembershipService, hashInviteToken, type CodeMembershipStore } from "../../apps/agent-api/src/code-membership";
import { CodeProtectedBranchRepository, CodeProtectedBranchService } from "../../apps/agent-api/src/code-protected-branches";

let passed = 0;
function ok(label: string, condition: boolean, extra?: unknown) {
  if (!condition) throw new Error(`FAILED: ${label}${extra === undefined ? "" : ` (${JSON.stringify(extra)})`}`);
  passed += 1;
  console.log(`ok ${passed} — ${label}`);
}

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const now = () => new Date();

/** Minimal in-memory `CodeMembershipStore`; only the port is faked, the service is the real one. */
function fakeStore(): CodeMembershipStore & { members: Map<string, CompanyMember>; invites: Map<string, CompanyInvite> } {
  const members = new Map<string, CompanyMember>();
  const invites = new Map<string, CompanyInvite>();
  const key = (companyId: string, userId: string) => `${companyId}:${userId}`;
  const seed = (companyId: string, userId: string, role: CompanyMember["role"], status: CompanyMember["status"] = "active") => {
    members.set(key(companyId, userId), {
      id: `cm_${userId}`, companyId, userId, role, status, createdAt: now(), updatedAt: now(), revision: 1,
    });
  };
  seed(COMPANY, "u-owner", "owner");
  seed(COMPANY, "u-admin", "admin");
  seed(COMPANY, "u-dev", "developer");
  seed(OTHER_COMPANY, "u-other-owner", "owner");
  return {
    members,
    invites,
    async getCompanyMembership(companyId, userId) { return members.get(key(companyId, userId)) ?? null; },
    async listCompanyMembers(companyId) { return [...members.values()].filter((member) => member.companyId === companyId); },
    async countCompanyOwners(companyId) { return [...members.values()].filter((m) => m.companyId === companyId && m.role === "owner" && m.status === "active").length; },
    async createCompanyInvite(input) {
      const invite: CompanyInvite = { ...input, createdAt: input.createdAt ?? now() };
      invites.set(invite.id, invite);
      return invite;
    },
    async findCompanyInviteByTokenHash(tokenHash) { return [...invites.values()].find((invite) => invite.tokenHash === tokenHash) ?? null; },
    async acceptCompanyInvite({ invite, userId, acceptedAt }) {
      invites.set(invite.id, { ...invite, acceptedAt });
      const member: CompanyMember = {
        id: `cm_${userId}`, companyId: invite.companyId, userId, role: invite.role, status: "active",
        invitedBy: invite.createdBy, invitedAt: invite.createdAt, acceptedAt, createdAt: now(), updatedAt: now(), revision: 1,
      };
      members.set(key(invite.companyId, userId), member);
      return member;
    },
    async updateCompanyMemberRole({ companyId, userId, role, expectedRevision, updatedAt }) {
      const existing = members.get(key(companyId, userId));
      if (!existing) throw new Error("User is not a member of this company");
      if (existing.revision !== expectedRevision) {
        throw new WorkspaceAccessError("Company member changed by another request. Reload and try again.");
      }
      const member = { ...existing, role, updatedAt, revision: existing.revision + 1 };
      members.set(key(companyId, userId), member);
      return member;
    },
    async removeCompanyMember({ companyId, userId }) { members.delete(key(companyId, userId)); },
  };
}

function auditSpy() {
  const calls: Array<Record<string, unknown>> = [];
  return { calls, port: { record: async (entry: Record<string, unknown>) => { calls.push(entry); } } };
}

const CONTEXTS: Record<string, AuthContext> = {
  owner: { userId: "u-owner", workspaceId: "ws-1", companyId: COMPANY, permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"] },
  admin: { userId: "u-admin", workspaceId: "ws-1", companyId: COMPANY, permissions: ["workspace:read", "workspace:write", "business:manage"] },
  developer: { userId: "u-dev", workspaceId: "ws-1", companyId: COMPANY, permissions: ["workspace:read", "workspace:write", "business:manage"] },
  stranger: { userId: "u-stranger", workspaceId: "ws-1", companyId: COMPANY, permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"] },
  agent: { userId: "agent:runner-1", externalSubject: "agent:runner-1", workspaceId: "ws-1", companyId: COMPANY, permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"] },
  invitee: { userId: "u-invitee", workspaceId: "ws-1", companyId: COMPANY, permissions: ["workspace:read"] },
};

async function buildApp(options: { audit?: boolean } = {}) {
  const store = fakeStore();
  const audit = auditSpy();
  const membership = new CodeMembershipService({
    store,
    ...(options.audit === false ? {} : { audit: audit.port }),
  });
  const protectedBranches = new CodeProtectedBranchService({
    store: new CodeProtectedBranchRepository(),
    resolveRole: (context, companyId) => membership.resolveRoleForUser(context, companyId),
    ...(options.audit === false ? {} : { audit: audit.port }),
  });
  const app = Fastify();
  let current: AuthContext | null = null;
  await registerCodeMembershipRoutes(app, {
    service: membership,
    protectedBranches,
    getAuthContext: () => current,
    ...(options.audit === false ? {} : { audit: audit.port }),
    findInviteCompanyId: async (tokenHash) => (await store.findCompanyInviteByTokenHash(tokenHash))?.companyId ?? null,
  });
  await app.ready();
  const call = async (actor: keyof typeof CONTEXTS | null, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    current = actor ? CONTEXTS[actor]! : null;
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };
  return { app, call, store, audit, membership };
}

const base = "/companies/company-1/code";
const errorCode = (body: Record<string, unknown>) => (body.error as { code?: string } | undefined)?.code;

// ---------------------------------------------------------------------------------------------
// GET /companies/:companyId/code/members
// ---------------------------------------------------------------------------------------------
{
  const { call } = await buildApp();
  const anonymous = await call(null, "GET", `${base}/members`);
  ok("GET members without authentication -> 401", anonymous.status === 401 && errorCode(anonymous.body) === "unauthorized");

  const owner = await call("owner", "GET", `${base}/members`);
  ok("GET members as the owner -> 200 with the apiVersion envelope", owner.status === 200 && owner.body.apiVersion === "v1", owner.body.apiVersion);
  ok("GET members lists the company members", Array.isArray(owner.body.members) && (owner.body.members as unknown[]).length === 3);

  const developer = await call("developer", "GET", `${base}/members`);
  ok("GET members as a developer -> 403 permission_denied", developer.status === 403 && errorCode(developer.body) === "permission_denied", errorCode(developer.body));

  const agent = await call("agent", "GET", `${base}/members`);
  ok("GET members as an agent -> 403 agent_cannot_change_policy", agent.status === 403 && errorCode(agent.body) === "agent_cannot_change_policy", errorCode(agent.body));
  ok("the refusal carries apiVersion too", agent.body.apiVersion === "v1");

  const stranger = await call("stranger", "GET", `${base}/members`);
  ok("GET members without a membership row -> 403 (deny by default, legacy admin:all ignored)", stranger.status === 403 && errorCode(stranger.body) === "permission_denied");
}

// ---------------------------------------------------------------------------------------------
// POST invites + accept (the invitee has no company role — a deliberately different path)
// ---------------------------------------------------------------------------------------------
{
  const { call, store, audit } = await buildApp();
  const invited = await call("owner", "POST", `${base}/members/invites`, { email: "invitee@example.com", role: "developer" });
  ok("POST invites as the owner -> 201", invited.status === 201, invited.body);
  const invite = invited.body.invite as Record<string, unknown>;
  const token = invited.body.inviteToken as string;
  ok("the response carries the plaintext token exactly once and never the stored hash", typeof token === "string" && token.length >= 32 && JSON.stringify(invited.body).includes("inviteToken") && !JSON.stringify(invited.body).includes("tokenHash"));
  ok("the invite is stored as a SHA-256 hash of the returned token", store.invites.size === 1 && [...store.invites.values()][0]!.tokenHash === hashInviteToken(token));
  ok("the invite audit entry code.membership.invite was written", audit.calls.some((entry) => entry.action === "code.membership.invite"));
  ok("the invite carries the requested role and email", invite.role === "developer" && invite.email === "invitee@example.com");

  const devInvite = await call("developer", "POST", `${base}/members/invites`, { email: "x@example.com", role: "developer" });
  ok("POST invites as a developer -> 403 permission_denied", devInvite.status === 403 && errorCode(devInvite.body) === "permission_denied");
  const agentInvite = await call("agent", "POST", `${base}/members/invites`, { email: "x@example.com", role: "developer" });
  ok("POST invites as an agent -> 403 agent_cannot_change_policy", agentInvite.status === 403 && errorCode(agentInvite.body) === "agent_cannot_change_policy");
  const BAD_ROLE = await call("owner", "POST", `${base}/members/invites`, { email: "x@example.com", role: "member" });
  ok("the placeholder role `member` is refused as an unknown company role (400 invalid_company_role)", BAD_ROLE.status === 400 && errorCode(BAD_ROLE.body) === "invalid_company_role", errorCode(BAD_ROLE.body));

  const accepted = await call("invitee", "POST", `${base}/members/invites/accept`, { token });
  ok("the invited user (no owner/admin role) accepts the invite -> 201", accepted.status === 201, accepted.body);
  ok("accepting records the role that the invite named", (accepted.body.member as Record<string, unknown>).role === "developer");
  ok("accepting is audited (code.membership.accept)", audit.calls.some((entry) => entry.action === "code.membership.accept"));

  const replay = await call("invitee", "POST", `${base}/members/invites/accept`, { token });
  ok("the same token cannot be accepted twice -> 409 invite_already_accepted", replay.status === 409 && errorCode(replay.body) === "invite_already_accepted", errorCode(replay.body));

  const agentAccept = await call("agent", "POST", `${base}/members/invites/accept`, { token: "whatever-token-value" });
  ok("an agent cannot accept an invite -> 403 agent_cannot_change_policy", agentAccept.status === 403 && errorCode(agentAccept.body) === "agent_cannot_change_policy");

  const second = await call("owner", "POST", `${base}/members/invites`, { email: "other@example.com", role: "reviewer" });
  const otherToken = second.body.inviteToken as string;
  const wrongCompany = await call("invitee", "POST", `/companies/${OTHER_COMPANY}/code/members/invites/accept`, { token: otherToken });
  ok("a token posted to another company's path is refused before it is used -> 403 invite_company_mismatch", wrongCompany.status === 403 && errorCode(wrongCompany.body) === "invite_company_mismatch", errorCode(wrongCompany.body));
}

// ---------------------------------------------------------------------------------------------
// PATCH / DELETE members
// ---------------------------------------------------------------------------------------------
{
  // A fresh app: the role is re-resolved on every request, so the denial checks must run before any
  // role change of the acting principal (and that re-resolution is asserted at the end of the block).
  const denialApp = await buildApp();
  const devPatch = await denialApp.call("developer", "PATCH", `${base}/members/u-admin`, { role: "developer", expectedRevision: 1 });
  ok("PATCH as a developer -> 403 permission_denied", devPatch.status === 403 && errorCode(devPatch.body) === "permission_denied", devPatch.body);
  const devDelete = await denialApp.call("developer", "DELETE", `${base}/members/u-admin`);
  ok("DELETE as a developer -> 403 permission_denied", devDelete.status === 403 && errorCode(devDelete.body) === "permission_denied");
  const devPatchesMalformed = await denialApp.call("developer", "PATCH", `${base}/members/u-admin`, { role: "developer" });
  ok("a developer with a malformed body still learns permission_denied (authorization precedes validation)", devPatchesMalformed.status === 403 && errorCode(devPatchesMalformed.body) === "permission_denied", devPatchesMalformed.body);
  const agentInvitesMalformed = await denialApp.call("agent", "POST", `${base}/members/invites`, {});
  ok("an agent with a malformed body still learns agent_cannot_change_policy", agentInvitesMalformed.status === 403 && errorCode(agentInvitesMalformed.body) === "agent_cannot_change_policy");
  const badRole = await denialApp.call("owner", "PATCH", `${base}/members/u-dev`, { role: "viewer", expectedRevision: 1 });
  ok("PATCH to the removed placeholder role `viewer` -> 400 invalid_company_role", badRole.status === 400 && errorCode(badRole.body) === "invalid_company_role");

  const { call, audit } = await buildApp();
  const promoted = await call("owner", "PATCH", `${base}/members/u-dev`, { role: "admin", expectedRevision: 1 });
  ok("PATCH members/:userId as the owner promotes the member -> 200", promoted.status === 200 && (promoted.body.member as Record<string, unknown>).role === "admin", promoted.body);
  ok("the role change is audited (code.membership.role_change)", audit.calls.some((entry) => entry.action === "code.membership.role_change"));
  // The company role is read per request, so a promotion takes effect immediately in this same session.
  const nowAllowed = await call("developer", "PATCH", `${base}/members/u-admin`, { role: "reviewer", expectedRevision: 1 });
  ok("after being promoted the same principal passes the route (the role is re-resolved per request)", nowAllowed.status === 200, nowAllowed.body);

  const stale = await call("owner", "PATCH", `${base}/members/u-dev`, { role: "developer", expectedRevision: 1 });
  ok("a stale expectedRevision -> 409 membership_revision_conflict", stale.status === 409 && errorCode(stale.body) === "membership_revision_conflict", errorCode(stale.body));

  const missingRevision = await call("owner", "PATCH", `${base}/members/u-dev`, { role: "developer" });
  ok("PATCH without expectedRevision -> 400 invalid_arguments", missingRevision.status === 400 && errorCode(missingRevision.body) === "invalid_arguments");

  const agentPatch = await call("agent", "PATCH", `${base}/members/u-dev`, { role: "owner", expectedRevision: 2 });
  ok("PATCH as an agent -> 403 agent_cannot_change_policy", agentPatch.status === 403 && errorCode(agentPatch.body) === "agent_cannot_change_policy");

  const removed = await call("owner", "DELETE", `${base}/members/u-dev`);
  ok("DELETE members/:userId as the owner -> 200", removed.status === 200 && removed.body.deleted === true);
  ok("removal is audited (code.membership.remove)", audit.calls.some((entry) => entry.action === "code.membership.remove"));
  const lastOwner = await call("owner", "DELETE", `${base}/members/u-owner`);
  ok("removing the last owner -> 409 last_owner_protected", lastOwner.status === 409 && errorCode(lastOwner.body) === "last_owner_protected", errorCode(lastOwner.body));
  const agentDelete = await call("agent", "DELETE", `${base}/members/u-dev`);
  ok("DELETE as an agent -> 403 agent_cannot_change_policy", agentDelete.status === 403 && errorCode(agentDelete.body) === "agent_cannot_change_policy");
}

// ---------------------------------------------------------------------------------------------
// GET / PUT protected-branches
// ---------------------------------------------------------------------------------------------
{
  const { call, audit } = await buildApp();
  const read = await call("owner", "GET", `${base}/protected-branches`);
  ok("GET protected-branches as the owner -> 200", read.status === 200, read.body);
  const policy = read.body.policy as Record<string, unknown>;
  ok("an unset policy reports the built-in default branches at revision 0", policy.revision === 0 && (policy.branches as string[]).join(",") === "main,master,release");
  ok("the response reports the step-up guard configuration", typeof read.body.guard === "object");

  const devRead = await call("developer", "GET", `${base}/protected-branches`);
  ok("a developer may read the policy (workspace:read)", devRead.status === 200);
  const agentRead = await call("agent", "GET", `${base}/protected-branches`);
  ok("an agent cannot read the administrative policy route -> 403 agent_cannot_change_policy", agentRead.status === 403 && errorCode(agentRead.body) === "agent_cannot_change_policy");

  const put = await call("owner", "PUT", `${base}/protected-branches`, { branches: ["main", "release", "prod"], expectedRevision: 0 });
  ok("PUT protected-branches as the owner -> 200 at revision 1", put.status === 200 && (put.body.policy as Record<string, unknown>).revision === 1, put.body);
  const updateAudit = audit.calls.find((entry) => entry.action === "code.protected_branches.update");
  ok("the change is audited as code.protected_branches.update", Boolean(updateAudit) && updateAudit?.decision === "allow");
  const updateMetadata = (updateAudit?.metadata ?? {}) as Record<string, unknown>;
  ok("the audit records that repository content was not consulted", updateMetadata.repositoryContentConsulted === false);

  const adminPut = await call("admin", "PUT", `${base}/protected-branches`, { branches: ["main"], expectedRevision: 1 });
  ok("PUT as an admin (not owner) -> 403 protected_branches_owner_required", adminPut.status === 403 && errorCode(adminPut.body) === "protected_branches_owner_required", errorCode(adminPut.body));
  const devPut = await call("developer", "PUT", `${base}/protected-branches`, { branches: ["main"], expectedRevision: 1 });
  ok("PUT as a developer -> 403 permission_denied", devPut.status === 403 && errorCode(devPut.body) === "permission_denied", errorCode(devPut.body));
  const agentPut = await call("agent", "PUT", `${base}/protected-branches`, { branches: ["main"], expectedRevision: 1 });
  ok("PUT as an agent -> 403 agent_cannot_change_policy", agentPut.status === 403 && errorCode(agentPut.body) === "agent_cannot_change_policy");
  const strangerPut = await call("stranger", "PUT", `${base}/protected-branches`, { branches: ["main"], expectedRevision: 1 });
  ok("PUT without a membership row -> 403 permission_denied (legacy admin:all does not lift it)", strangerPut.status === 403 && errorCode(strangerPut.body) === "permission_denied");

  const contentPut = await call("owner", "PUT", `${base}/protected-branches`, { branches: ["main"], expectedRevision: 1, files: ["NPATI.md"] });
  ok("PUT with repository content in the body -> 400 protected_branch_policy_input_rejected", contentPut.status === 400 && errorCode(contentPut.body) === "protected_branch_policy_input_rejected", errorCode(contentPut.body));
  const stalePut = await call("owner", "PUT", `${base}/protected-branches`, { branches: ["main"], expectedRevision: 0 });
  ok("PUT with a stale revision -> 409 policy_revision_conflict", stalePut.status === 409 && errorCode(stalePut.body) === "policy_revision_conflict", errorCode(stalePut.body));

  const reread = await call("owner", "GET", `${base}/protected-branches`);
  ok("the policy survived the refused attempts unchanged", (reread.body.policy as Record<string, unknown>).revision === 1);
}

// ---------------------------------------------------------------------------------------------
// Fail closed without the authorization journal
// ---------------------------------------------------------------------------------------------
{
  const { call } = await buildApp({ audit: false });
  const read = await call("owner", "GET", `${base}/members`);
  ok("with no audit journal the RBAC gate refuses (503 audit_unavailable) instead of allowing", read.status === 503 && errorCode(read.body) === "audit_unavailable", errorCode(read.body));
  const put = await call("owner", "PUT", `${base}/protected-branches`, { branches: ["main"], expectedRevision: 0 });
  ok("with no audit journal a policy change is refused too", put.status === 503 && errorCode(put.body) === "audit_unavailable");
}

console.log(`\nroutes-probe: ${passed} assertions passed`);
