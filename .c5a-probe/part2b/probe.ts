/**
 * C5a part 2B local probe (verification aid, not a deliverable).
 *
 * `vitest` cannot start in this sandbox (esbuild's service binary is blocked: `spawn EPERM`), so the
 * protected-branch policy, the company-role gate and the HTTP routes are exercised directly instead:
 *
 *   node --experimental-transform-types --import ./.c5a-probe/register.mjs .c5a-probe/part2b/probe.ts
 *
 * Every line printed with `ok` is an assertion that passed; a failure throws and exits non-zero.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AuthContext, CompanyInvite, CompanyMember } from "@npati/workspace";
import {
  CodeProtectedBranchRepository,
  CodeProtectedBranchService,
  DEFAULT_PROTECTED_BRANCHES,
  type CodeProtectedBranchStore,
} from "../../apps/agent-api/src/code-protected-branches";
import { authorizeCodeAction } from "../../apps/agent-api/src/code-rbac";
import { productionPayloadHash } from "../../apps/agent-api/src/code-step-up";

let passed = 0;
function ok(label: string, condition: boolean, extra?: unknown) {
  if (!condition) throw new Error(`FAILED: ${label}${extra === undefined ? "" : ` (${JSON.stringify(extra)})`}`);
  passed += 1;
  console.log(`ok ${passed} — ${label}`);
}

async function refusal(action: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await action();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("expected a refusal, but the call resolved");
}

const COMPANY = "company-1";

const ROLES: Record<string, string | null> = {
  "u-owner": "owner",
  "u-admin": "admin",
  "u-dev": "developer",
  "u-reviewer": "reviewer",
  "u-stranger": null,
};

function user(userId: string, overlay: Partial<AuthContext> = {}): AuthContext {
  return {
    userId,
    workspaceId: "ws-1",
    companyId: COMPANY,
    // Legacy workspace permissions are deliberately wide here: the company-scoped gate must ignore them.
    permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"],
    ...overlay,
  };
}

const agent = (): AuthContext => user("agent:runner-1", { externalSubject: "agent:runner-1" });

function auditSpy(events: string[]) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    port: {
      record: async (entry: Record<string, unknown>) => {
        calls.push(entry);
        events.push(`audit:${String(entry.action)}:${String(entry.decision ?? "allow")}`);
      },
    },
  };
}

function build(overrides: { store?: CodeProtectedBranchStore; audit?: boolean; auditThrows?: boolean; guard?: Record<string, boolean>; stepUp?: unknown; events?: string[] } = {}) {
  const events = overrides.events ?? [];
  const audit = auditSpy(events);
  const repository =
    overrides.store ??
    new (class extends CodeProtectedBranchRepository {
      async save(input: Parameters<CodeProtectedBranchStore["save"]>[0]) {
        events.push("store:save");
        return super.save(input);
      }
    })();
  const service = new CodeProtectedBranchService({
    store: repository,
    resolveRole: async (ctx) => ROLES[ctx.userId] ?? null,
    ...(overrides.audit === false
      ? {}
      : overrides.auditThrows
        ? { audit: { record: async () => { throw new Error("journal down"); } } }
        : { audit: audit.port }),
    ...(overrides.stepUp ? { stepUp: overrides.stepUp as never } : {}),
    ...(overrides.guard ? { guard: overrides.guard } : {}),
  });
  return { service, audit, events };
}

// ---------------------------------------------------------------------------------------------
// 1. Hard deny: a direct write into a protected branch is refused for every principal.
// ---------------------------------------------------------------------------------------------
{
  const { service, audit } = build();
  const decision = await service.evaluateGitWrite(agent(), COMPANY, { operation: "push", branch: "main" });
  ok("agent push into a protected branch is denied with protected_branch_write_denied", decision.allowed === false && decision.code === "protected_branch_write_denied", decision.code);
  ok("the denial is a hard deny: no role, permission or owner status is consulted", decision.decidedOn === "branch_name_and_operation_only");
  ok("the protected-branch denial is journalled", audit.calls.some((call) => call.action === "code.protected_branches.denied" && call.decision === "deny"));

  const ownerPush = await service.evaluateGitWrite(user("u-owner"), COMPANY, { operation: "push", branch: "main" });
  ok("the OWNER is denied too (hard deny for everybody)", ownerPush.allowed === false && ownerPush.code === "protected_branch_write_denied", ownerPush.code);

  const adminPush = await service.evaluateGitWrite(user("u-admin"), COMPANY, { operation: "push", branch: "release" });
  ok("an admin is denied as well", adminPush.allowed === false && adminPush.code === "protected_branch_write_denied");

  const agentForce = await service.evaluateGitWrite(agent(), COMPANY, { operation: "force_push", branch: "master" });
  ok("agent force push into a protected branch gives force_push_denied", agentForce.allowed === false && agentForce.code === "force_push_denied", agentForce.code);
  const ownerForce = await service.evaluateGitWrite(user("u-owner"), COMPANY, { operation: "force_push", branch: "main" });
  ok("owner force push gives force_push_denied", ownerForce.code === "force_push_denied");

  const thrown = await refusal(() => service.assertGitWriteAllowed(agent(), COMPANY, { operation: "push", branch: "main" }));
  ok("assertGitWriteAllowed raises a 403 refusal", thrown.httpStatus === 403 && thrown.code === "protected_branch_write_denied");

  const unprotected = await service.evaluateGitWrite(agent(), COMPANY, { operation: "push", branch: "feature/topic" });
  ok("a push into an unprotected branch is not decided by this gate", unprotected.allowed === true && unprotected.protected === false);
  const unprotectedForce = await service.evaluateGitWrite(user("u-owner"), COMPANY, { operation: "force_push", branch: "feature/topic" });
  ok("a force push into an unprotected branch is not hard-denied here (the classifier escalates it)", unprotectedForce.allowed === true);

  const humanMerge = await service.evaluateGitWrite(user("u-reviewer"), COMPANY, { operation: "push", branch: "main", viaPullRequestMerge: true });
  ok("a human member merging a pull request is the sanctioned pathway into a protected branch", humanMerge.allowed === true);
  const agentMerge = await service.evaluateGitWrite(agent(), COMPANY, { operation: "push", branch: "main", viaPullRequestMerge: true });
  ok("an agent cannot use the pull-request pathway", agentMerge.allowed === false && agentMerge.code === "protected_branch_write_denied");
  const strangerMerge = await service.evaluateGitWrite(user("u-stranger"), COMPANY, { operation: "push", branch: "main", viaPullRequestMerge: true });
  ok("a principal that is not a company member cannot use the pull-request pathway", strangerMerge.allowed === false && strangerMerge.code === "protected_branch_write_denied");
  const unmarkedToken = await service.evaluateGitWrite(user("npati:apikey:key-1"), COMPANY, { operation: "push", branch: "main", viaPullRequestMerge: true });
  ok("a token without an agent marker is still refused (membership is required, not the marker alone)", unmarkedToken.allowed === false && unmarkedToken.code === "protected_branch_write_denied");
  const forceViaPullRequest = await service.evaluateGitWrite(user("u-owner"), COMPANY, { operation: "force_push", branch: "main", viaPullRequestMerge: true });
  ok("force push is refused even when the pull-request pathway is claimed", forceViaPullRequest.code === "force_push_denied");
}

// ---------------------------------------------------------------------------------------------
// 2. The policy change: owner only, human only, audited before it is applied.
// ---------------------------------------------------------------------------------------------
{
  const { service, audit, events } = build();
  const initial = await service.getPolicy(user("u-dev"), COMPANY);
  ok("no stored policy reads as the built-in default set with revision 0", initial.revision === 0 && initial.branches.join(",") === DEFAULT_PROTECTED_BRANCHES.join(","));

  const updated = await service.updatePolicy(user("u-owner"), COMPANY, { branches: ["main", "release", "prod"], expectedRevision: 0 });
  ok("the owner changes the policy (revision 1)", updated.revision === 1 && updated.branches.includes("prod"));
  const update = audit.calls.find((call) => call.action === "code.protected_branches.update");
  ok("the audit action code.protected_branches.update is written", Boolean(update) && update?.decision === "allow");
  ok("the audit entry is written BEFORE the policy is applied", events.indexOf("audit:code.protected_branches.update:allow") < events.indexOf("store:save"), events);
  const metadata = (update?.metadata ?? {}) as Record<string, unknown>;
  ok("the audit records before/after, revision and that repository content was not consulted", Array.isArray(metadata.before) && Array.isArray(metadata.after) && metadata.expectedRevision === 0 && metadata.repositoryContentConsulted === false);
  ok("the audit carries a payload hash for the step-up binding", typeof update?.payloadHash === "string" && String(update?.payloadHash).startsWith("fnv1a:"));

  const applied = await service.evaluateGitWrite(agent(), COMPANY, { operation: "push", branch: "prod" });
  ok("the newly protected branch is now denied", applied.allowed === false && applied.code === "protected_branch_write_denied");

  // developer / admin / stranger / agent refusals
  const devFailure = await refusal(() => service.updatePolicy(user("u-dev"), COMPANY, { branches: ["main"], expectedRevision: 1 }));
  ok("a developer changing the policy gets 403 protected_branches_owner_required", devFailure.httpStatus === 403 && devFailure.code === "protected_branches_owner_required", devFailure.code);
  const adminFailure = await refusal(() => service.updatePolicy(user("u-admin"), COMPANY, { branches: ["main"], expectedRevision: 1 }));
  ok("an admin (not owner) gets 403 protected_branches_owner_required", adminFailure.httpStatus === 403 && adminFailure.code === "protected_branches_owner_required");
  const strangerFailure = await refusal(() => service.updatePolicy(user("u-stranger"), COMPANY, { branches: ["main"], expectedRevision: 1 }));
  ok("a principal with no membership row gets 403 protected_branches_membership_required", strangerFailure.code === "protected_branches_membership_required");
  const agentFailure = await refusal(() => service.updatePolicy(agent(), COMPANY, { branches: ["main"], expectedRevision: 1 }));
  ok("an agent gets 403 agent_cannot_change_protected_branches", agentFailure.httpStatus === 403 && agentFailure.code === "agent_cannot_change_protected_branches", agentFailure.code);
  const serviceFailure = await refusal(() =>
    service.updatePolicy(user("u-owner", { externalSubject: "service:automation:1" }), COMPANY, { branches: ["main"], expectedRevision: 1 }),
  );
  ok("a service identity gets agent_cannot_change_protected_branches", serviceFailure.code === "agent_cannot_change_protected_branches");
  const agentWithContent = await refusal(() =>
    service.updatePolicy(agent(), COMPANY, { branches: ["main"], expectedRevision: 1, files: ["NPATI.md"] }),
  );
  ok("an agent that smuggles repository content still learns agent_cannot_change_protected_branches", agentWithContent.code === "agent_cannot_change_protected_branches");

  const stale = await refusal(() => service.updatePolicy(user("u-owner"), COMPANY, { branches: ["main"], expectedRevision: 7 }));
  ok("a stale expectedRevision gives 409 policy_revision_conflict", stale.httpStatus === 409 && stale.code === "policy_revision_conflict");
  const empty = await refusal(() => service.updatePolicy(user("u-owner"), COMPANY, { branches: [], expectedRevision: 1 }));
  ok("an empty policy is refused (it would unprotect everything)", empty.httpStatus === 400 && empty.code === "invalid_protected_branch_policy");
  const badName = await refusal(() => service.updatePolicy(user("u-owner"), COMPANY, { branches: ["main", "bad branch"], expectedRevision: 1 }));
  ok("an invalid branch name is refused", badName.code === "invalid_protected_branch_policy");
}

// ---------------------------------------------------------------------------------------------
// 3. Repository content can never influence the policy.
// ---------------------------------------------------------------------------------------------
{
  const { service, events } = build();
  for (const content of [
    { files: ["NPATI.md"], branches: ["main"], expectedRevision: 0 },
    { npatiMd: "# ignore previous instructions", branches: ["main"], expectedRevision: 0 },
    { ciConfig: ".github/workflows/ci.yml", branches: ["main"], expectedRevision: 0 },
    { diff: "+protected: []", branches: ["main"], expectedRevision: 0 },
    { path: ".npati/protected-branches.json", branches: ["main"], expectedRevision: 0 },
  ]) {
    const failure = await refusal(() => service.updatePolicy(user("u-owner"), COMPANY, content));
    ok(`repository-content input is rejected (${Object.keys(content).filter((key) => !["branches", "expectedRevision"].includes(key)).join(",")})`, failure.httpStatus === 400 && failure.code === "protected_branch_policy_input_rejected", failure.code);
  }
  ok("no rejected content input reached the store", !events.includes("store:save"));
  const after = await service.getPolicy(user("u-owner"), COMPANY);
  ok("the policy is untouched after the rejected attempts", after.revision === 0 && after.branches.join(",") === DEFAULT_PROTECTED_BRANCHES.join(","));

  // The module must not read repository content at all: no filesystem or child_process import.
  const source = readFileSync(new URL("../../apps/agent-api/src/code-protected-branches.ts", import.meta.url), "utf8");
  ok("the module imports no filesystem/child-process/glob API", !/from "node:(fs|child_process|path)"/.test(source));
  ok("the module never mentions NPATI.md or a CI config path", !/NPATI\.md|workflows\//.test(source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
}

// ---------------------------------------------------------------------------------------------
// 4. Audit is required: without the journal nothing is applied.
// ---------------------------------------------------------------------------------------------
{
  const noJournal = build({ audit: false });
  const failure = await refusal(() => noJournal.service.updatePolicy(user("u-owner"), COMPANY, { branches: ["main"], expectedRevision: 0 }));
  ok("no audit port -> 503 audit_unavailable", failure.httpStatus === 503 && failure.code === "audit_unavailable");
  ok("no audit port -> the policy was NOT applied", !noJournal.events.includes("store:save"));
  const stillDefault = await noJournal.service.getPolicy(user("u-owner"), COMPANY);
  ok("no audit port -> the stored policy is still the default (revision 0)", stillDefault.revision === 0);

  const brokenJournal = build({ auditThrows: true });
  const brokenFailure = await refusal(() => brokenJournal.service.updatePolicy(user("u-owner"), COMPANY, { branches: ["main"], expectedRevision: 0 }));
  ok("a failing journal -> 503 audit_unavailable", brokenFailure.httpStatus === 503 && brokenFailure.code === "audit_unavailable");
  ok("a failing journal -> the policy was NOT applied", !brokenJournal.events.includes("store:save"));
}

// ---------------------------------------------------------------------------------------------
// 5. The step-up hook is configuration; the flow itself stays in code-step-up.ts.
// ---------------------------------------------------------------------------------------------
{
  const calls: Array<Record<string, unknown>> = [];
  const stepUp = { requireStepUp: async (_ctx: unknown, _companyId: string, input: Record<string, unknown>) => { calls.push(input); return {}; } };

  const offByDefault = build();
  const noStepUpNeeded = await offByDefault.service.updatePolicy(user("u-owner"), COMPANY, { branches: ["main"], expectedRevision: 0 });
  ok("step-up is off by default: the owner change needs no challenge", noStepUpNeeded.revision === 1);

  const required = build({ guard: { stepUpRequired: true }, stepUp });
  const missingChallenge = await refusal(() => required.service.updatePolicy(user("u-owner"), COMPANY, { branches: ["main"], expectedRevision: 0 }));
  ok("stepUpRequired -> 403 protected_branches_step_up_required without a challenge", missingChallenge.httpStatus === 403 && missingChallenge.code === "protected_branches_step_up_required");

  const withChallenge = await required.service.updatePolicy(user("u-owner"), COMPANY, { branches: ["main"], expectedRevision: 0, challengeId: "challenge-1" });
  ok("stepUpRequired + challengeId -> the injected code-step-up interface is consulted and the change applies", withChallenge.revision === 1 && calls.length === 1);
  ok("the step-up call uses the policy-change operation and a payload hash", calls[0]?.operation === "code.protected_branches.update" && String(calls[0]?.payloadHash).startsWith("fnv1a:"), calls[0]);
  ok(
    "the payload hash is the deterministic hash of the change",
    calls[0]?.payloadHash === productionPayloadHash("code.protected_branches.update", { companyId: COMPANY, branches: ["main"], expectedRevision: 0 }),
  );

  const unwired = build({ guard: { twoPersonRequested: true } });
  const unwiredFailure = await refusal(() => unwired.service.updatePolicy(user("u-owner"), COMPANY, { branches: ["main"], expectedRevision: 0, challengeId: "c" }));
  ok("two-person requested but no step-up service wired -> 503 protected_branches_step_up_unavailable (fail closed)", unwiredFailure.httpStatus === 503 && unwiredFailure.code === "protected_branches_step_up_unavailable");
}

// ---------------------------------------------------------------------------------------------
// 6. An unreadable policy store never means "nothing is protected".
// ---------------------------------------------------------------------------------------------
{
  const broken: CodeProtectedBranchStore = {
    get: async () => { throw new Error("relation company_protected_branches does not exist"); },
    save: async () => { throw new Error("relation company_protected_branches does not exist"); },
  };
  const { service } = build({ store: broken });
  const decision = await service.evaluateGitWrite(agent(), COMPANY, { operation: "push", branch: "main" });
  ok("an unreadable policy still denies a default protected branch (conservative default)", decision.allowed === false && decision.code === "protected_branch_write_denied");
  const read = await refusal(() => service.getPolicy(user("u-owner"), COMPANY));
  ok("an administrative read refuses instead of inventing a policy (503)", read.httpStatus === 503 && read.code === "protected_branches_store_unavailable");
  const write = await refusal(() => service.updatePolicy(user("u-owner"), COMPANY, { branches: ["main"], expectedRevision: 0 }));
  ok("a policy change refuses when the store cannot be read (fail closed)", write.code === "protected_branches_store_unavailable");
}

// ---------------------------------------------------------------------------------------------
// 7. The shared RBAC gate on the company-scoped context (the route layer's first half).
// ---------------------------------------------------------------------------------------------
{
  const audit = auditSpy([]);
  const gate = { audit: audit.port };
  const scoped = (role: string | null, context: AuthContext): AuthContext =>
    Object.assign({}, context, { role, companyId: COMPANY, permissions: [] });

  const ownerRead = await authorizeCodeAction(scoped("owner", user("u-owner")), COMPANY, { permission: "business:manage", action: "code.membership.invite", policyChange: true }, gate);
  ok("company role owner passes the membership gate", ownerRead.allowed === true && ownerRead.role === "owner");

  const adminRead = await authorizeCodeAction(scoped("admin", user("u-admin")), COMPANY, { permission: "business:manage", action: "code.membership.invite", policyChange: true }, gate);
  ok("company role admin passes the membership gate", adminRead.allowed === true);

  const devFailure = await refusal(() => authorizeCodeAction(scoped("developer", user("u-dev")), COMPANY, { permission: "business:manage", action: "code.membership.role_change", policyChange: true }, gate));
  ok("company role developer is denied (permission_denied, deny by default)", devFailure.code === "permission_denied" && devFailure.httpStatus === 403);

  const reviewerFailure = await refusal(() => authorizeCodeAction(scoped("reviewer", user("u-reviewer")), COMPANY, { permission: "business:manage", action: "code.membership.role_change", policyChange: true }, gate));
  ok("company role reviewer is denied on the administrative routes", reviewerFailure.code === "permission_denied");

  const noMembership = await refusal(() => authorizeCodeAction(scoped(null, user("u-stranger")), COMPANY, { permission: "business:manage", action: "code.membership.list", policyChange: true }, gate));
  ok("a caller with no company membership row is denied even with legacy admin permissions", noMembership.code === "permission_denied");

  const agentFailure = await refusal(() => authorizeCodeAction(agent(), COMPANY, { permission: "business:manage", action: "code.membership.list", policyChange: true }, gate));
  ok("an agent principal is refused with agent_cannot_change_policy", agentFailure.code === "agent_cannot_change_policy" && agentFailure.httpStatus === 403);

  const agentProtectedWrite = await refusal(() => authorizeCodeAction(agent(), COMPANY, { permission: "business:manage", action: "code.protected_branches.update", policyChange: true }, gate));
  ok("an agent cannot reach the protected-branch policy route either", agentProtectedWrite.code === "agent_cannot_change_policy");

  const ownerProtectedWrite = await authorizeCodeAction(scoped("owner", user("u-owner")), COMPANY, { permission: "business:manage", action: "code.protected_branches.update", policyChange: true }, gate);
  ok("the owner passes the protected-branch route gate (the service then enforces owner-only)", ownerProtectedWrite.allowed === true);

  const apiKey = await refusal(() => authorizeCodeAction(scoped(null, user("key:abc")), COMPANY, { permission: "business:manage", action: "code.membership.invite", policyChange: true }, gate));
  ok("an API-key principal (no membership row) is denied", apiKey.code === "permission_denied");
}

// ---------------------------------------------------------------------------------------------
// 8. Role names: the plan set only, and the two matrices agree.
// ---------------------------------------------------------------------------------------------
{
  const rbac = await import("../../apps/agent-api/src/code-rbac");
  const membership = await import("../../apps/agent-api/src/code-membership");
  const roles = Object.keys(rbac.DEFAULT_CODE_ROLE_MATRIX.roles).sort();
  ok("the default RBAC matrix carries exactly owner/admin/developer/reviewer/service", roles.join(",") === "admin,developer,owner,reviewer,service", roles);
  ok("the placeholder roles member/viewer are gone", !roles.includes("member") && !roles.includes("viewer"));
  const companyRoles = Object.keys(membership.DEFAULT_COMPANY_ROLE_MATRIX).sort();
  ok("the company matrix carries the same four human roles", companyRoles.join(",") === "admin,developer,owner,reviewer", companyRoles);
  for (const role of companyRoles) {
    ok(`role ${role} is identical in both matrices`, JSON.stringify(rbac.DEFAULT_CODE_ROLE_MATRIX.roles[role]) === JSON.stringify(membership.DEFAULT_COMPANY_ROLE_MATRIX[role]));
  }
}

console.log(`\nprobe: ${passed} assertions passed`);
