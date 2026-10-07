# C5a — Automations inventory (service identity)

Purpose: replace the "unattended automation runs as the owner with a fixed wide permission set" pattern
with a **service identity**, without breaking the automations that work today. The order matters: first
inventory what automations actually call, then constrain to that list.

## Finding (what was wrong)

`apps/agent-api/src/app.ts` built the execution context for every unattended automation from the owner's
account:

```
1845  const automationContext: AuthContext = {
1846    workspaceId: automation.workspaceId,
1847    userId: automation.userId,                       // <- the owner's identity
1848    permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute", "automation:execute_browser"],
1849  };
```

Consequences: every scheduled run acted with `business:manage` + browser automation rights regardless of
what the automation needed; it was indistinguishable from the owner in the audit trail; and the same
identity was reused for the browser-credential flows (`claimTargets`, `ensureTargetCredential`,
`recordTargetResult`), so an automation could touch targets beyond its own scope.

## Inventory (what unattended automations actually use)

| Call site | Permission required | Why |
| --- | --- | --- |
| `app.ts:1875`, `app.ts:1909` — `companyRuntime.execute(...)` | `workspace:read` **or** `workspace:write` **or** `business:manage` (`company-runtime.ts:286`) | the Company run itself |
| `app.ts:1851/1854` — `browserCredentials.listTargets/claimTargets` | `automation:execute_browser` (`company-runtime.ts:94`) | scoped browser campaign targets |
| `app.ts:1860` — `emailInboxRepo.getAccount` | `workspace:read` | the Company email account attached to a campaign target |
| `app.ts:1862` — `browserCredentials.ensureTargetCredential` | `automation:execute_browser` | per-target browser credential |
| `app.ts:1883/1896` — `browserCredentials.recordTargetResult` | `workspace:write` | persisting the outcome of a target |
| `app.ts:1876` — `companyRuntime.execute` with agent tools | `tools:execute` | executing the tools a run calls |
| `app.ts:1921` — `notifyAutomation` → `messagingIntegrationsRepo.listConnectedForCompany(workspaceId, userId, companyId, agentId)` | none beyond read | notification delivery; **uses the owner's id for lookup only** |

## Resulting allowlist

```
workspace:read, workspace:write, business:manage, tools:execute, automation:execute_browser
```

This is `AUTOMATION_ALLOWED_PERMISSION_DEFAULTS` in `code-service-identity.ts`, derived from
`AUTOMATION_PERMISSION_INVENTORY` (one binding per row above). Configuration
(`NPATI_CODE_AUTOMATION_ALLOWED_PERMISSIONS`) can only **narrow** it; a permission that is outside the
inventory, production-shaped, privileged (`code.prod.operate`,
`code.policy.manage`, `code.trust.manage`, `code.rbac.manage`) or a wildcard is **rejected and reported**,
never granted.

## Service identity shape

* principal: `service:automation:<automationId>`, carried in `auth.externalSubject` — `classifyPrincipal`
  reads that field **first**, so the C5a RBAC invariants (`service_cannot_approve`,
  `service_identity_cannot_operate_production`, no privileged permission) apply to the automation.
* **Tenancy caveat, verified by reading the store**: `WorkspaceStore.assertCompany`
  (`packages/workspace/src/postgres-store.ts:1400`) resolves a company with
  `workspace_id = ctx.workspaceId AND user_id = ctx.userId`, and companies are owned by that same `user_id`.
  Replacing `userId` with a synthetic principal would break every automation instead of narrowing it, so the
  context keeps the **owner in `userId` for tenancy** and carries the service principal in
  `externalSubject`. The owner id is provenance plus the key NPATI's ownership queries need; it grants no
  extra permission, because `permissions` is the allowlist and nothing else.
* role: at most `developer` (`SERVICE_IDENTITY_ROLE_CEILING`); a request for `admin`/`owner`/an unknown role
  is downgraded to `service` and `roleDowngraded` is set.
* a permission a call site needs but the allowlist lacks raises `automation_permission_not_allowed`
  (403) instead of silently widening the identity.

## Open items for the owner

1. **Notification lookup still needs a user id.** `listConnectedForCompany(workspaceId, userId, companyId,
   agentId)` is keyed by the owner's user id, so `notifyAutomation` keeps using `ownerUserId`. Moving
   notifications onto the service identity needs a repository method keyed by company + agent; that is a
   change in the messaging repository, not in the coding agent (`TODO(C5a follow-up)`).
2. **Anything outside the inventory fails loudly.** If a future automation needs `email:send` or another
   permission, the owner must add it to `AUTOMATION_PERMISSION_INVENTORY` and to the allowlist in one
   reviewable change — the runtime will refuse until then.
3. **Programmatic automations that today rely on `business:manage`** for Company management tool calls will
   lose that ability under the service identity unless `business:manage` is explicitly kept in the
   allowlist (it is, today, because `company-runtime.ts:286` accepts it for runs). Narrowing it further is
   an owner decision.
