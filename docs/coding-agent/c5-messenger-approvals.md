# C5 — Audit: approvals over messengers (Telegram / WhatsApp / Slack / Discord / email)

Scope: can a human approve a privileged Coding Agent action from a messenger, and is that safe enough
to implement now? This is a **read-only audit** written during C5; nothing was implemented.

## What already exists in NPATI

| Capability | Evidence |
|---|---|
| Messenger channels | `apps/agent-api/src/{telegram,whatsapp,slack,discord}-messaging.ts`, `email-messaging-adapter.ts`, `messaging-gateway.ts`, `messaging-integrations-repository.ts` |
| Account/agent pairing | `MessagingConnection` carries `pairingCodeHash` + `pairingExpiresAt` (15-minute code) and stores the pairing user's `permissions` snapshot |
| Approval commands | `messaging-commands.ts` exposes `/approvals`, `/approve <id>`, `/deny <id>`; `messaging-inbound-dispatcher.ts` recognises `^/?(approve|deny) <id>` |
| One channel with a hard identity check | email: `message.authenticatedSender !== true` → 403 `EMAIL_AUTHENTICATION_REQUIRED` |
| Untrusted-content marking | non-control messenger text is wrapped as `[external_untrusted_content]` with an anti-injection preamble |

So a delivery path and an approval command path **exist**. The missing piece is not transport — it is
identity assurance for the *approval decision itself*.

## Gaps that block using messenger approvals for `code.*`

1. **No per-decision identity evidence.** A messenger approval would consume an approval through the
   paired connection, but nothing records *which* external identity decided, nor binds that identity to
   the workspace user for that specific decision. WhatsApp/Slack/Discord rely on the channel's own
   account identity; only email asserts `authenticatedSender`.
2. **No dedicated audit entry.** The C1c AuditLog requirement for privileged actions expects
   `actor`, `request_id`, `correlation_id`, `payload_hash`. A chat decision has no request/correlation
   binding today, so the pending approval could be consumed without a tamper-evident record naming the
   approver.
3. **Replay and forwarding risk.** An approval id pasted into another chat (or forwarded) is
   indistinguishable from the intended approver; there is no nonce/challenge bound to the decision.
4. **Stale authority.** The connection snapshots the pairer's permissions at pairing time; a role change
   (or removal) does not necessarily invalidate the ability to approve.
5. **Group/thread exposure.** Approvals arriving in a shared thread would disclose the action and let a
   non-approver answer first; the approval system is per-user, not per-thread.

## Decision

**Do not implement messenger approvals for the Coding Agent in C5. Keep a `TODO(C5a)`** and require
messengers to stay *notification-only* until the following exist:

- approval decisions resolved against RBAC (C5a) with the approver's live role, not the pairing snapshot;
- an AuditLog entry per messenger decision (fail closed: no journal, no decision), carrying the external
  identity plus `request_id`/`correlation_id`/`payload_hash`;
- a challenge bound to the decision (short-lived, single-use, tied to the message) so a pasted or
  forwarded id cannot approve anything;
- explicit confirmation of which project/session the approval belongs to, since a chat has no session
  context.

Until then: `/approve`/`/deny` must not be able to satisfy a `code.*` approval, and the engine's rule
that **an agent principal can never be an approver** (`agent_cannot_approve`) plus the payload-hash check
(`approval_invalid`) remain the only guarantees — they are proven by
`tests/coding-agent-c5-approval-bypass.test.ts`.

## What would be verified before enabling it (not now)

- a messenger decision is refused when the paired user lacks the live role/permission;
- a messenger decision is refused when the audit journal is unavailable (fail closed);
- a replayed, forwarded or expired approval id is refused;
- an approval for another project/session is refused;
- the AuditLog entry names the external identity and correlates with the decision.
