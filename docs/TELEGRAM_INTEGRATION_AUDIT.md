# NPATI Telegram Integration Audit

Audit date: 2026-09-27

Architecture retained: `Telegram -> Messaging Gateway -> Scope Router -> existing Chat/Company Runtime -> OmniRoute`.

No Telegram-specific agent runtime was introduced. Telegram continues to reuse NPATI authentication bindings, tenant-scoped WorkspaceStore access, Chat and Company runtimes, Memory, Files, Automations, approvals, capability policy and Run Trace.

## Reference baseline

- Hermes Agent Telegram documentation: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md
- Hermes gateway streaming configuration: https://github.com/hermes-agent-org/hermes/blob/main/website/docs/user-guide/configuration.md
- OpenClaw Telegram documentation: https://docs.openclaw.ai/channels/telegram
- OpenClaw access-control documentation: https://docs.openclaw.ai/channels/telegram/access-control
- OpenClaw Telegram reliability invariants: https://github.com/openclaw/openclaw/blob/main/extensions/telegram/AGENTS.md

The useful baseline patterns are: adapter isolation, pairing/allowlists, per-chat/topic session keys, typing state, progressive message editing, platform message-size handling, rate-limit-aware delivery, durable inbound deduplication, reply context and shared core permission/runtime enforcement.

## Capability matrix

| # | Capability | Status after audit | Evidence / notes |
|---|---|---|---|
| 1 | Text, Memory, persistent sessions | Working | Uses the existing neutral/Company conversation and memory paths. Session IDs are persisted per connection, chat and topic. `/new` preserves the old conversation; `/reset` deletes the active conversation. |
| 2 | Account, Company and Agent scopes | Working | Account scope has mutable per-session context. Company and Agent scopes remain fixed and cannot escape their binding. |
| 3 | Company/Agent CRUD and switching | Working | CRUD is handled by existing Chat action services. Explicit `/companies`, `/company`, `/agents`, `/agent`, `/context`, `/account` routing is supported for account scope. |
| 4 | Images, PDF, DOCX, TXT, Excel and files | Working | Telegram photos, documents, audio, voice and video are normalized to gateway attachments. Existing document extraction supports PDF, Word, Excel, CSV/TSV, text/code and ZIP. Telegram Bot API inbound download is capped at 20 MB. |
| 5 | Voice to existing STT | Working | Telegram voice/audio enters the same `prepareChatAttachments` and `AIEngine.transcribeAudio` path as NPATI Chat. No Telegram STT implementation exists. |
| 6 | Agent sends files/images back | Fixed | NPATI attachment markers are resolved through the existing ChatFileService and sent with `sendPhoto` or `sendDocument`; authorization remains tenant scoped. |
| 7 | Typing, long text, progressive responses | Partial | Typing refresh, safe 3900-character chunks, progressive `sendMessage`/`editMessageText`, and a progress preview are implemented. Neutral Chat streams text deltas. Company Runtime currently provides progress/typing plus final output, not token-level deltas. |
| 8 | Required slash commands | Fixed | `/new`, `/reset`, `/stop`, `/status`, `/companies`, `/company`, `/agents`, `/agent`, `/context`, `/account` are supported and registered in the native bot menu. Commands with `@botname` suffix are normalized. |
| 9 | `/runs` or `/tasks` | Fixed | Lists recent Company runs and configured Automations for the active Company using existing repositories. |
| 10 | Automatic Automation/background results | Working | Scheduler completion/failure notifications use connected account/company/agent bindings. Normal Company tasks deliver their final result through the originating Telegram session. |
| 11 | Approval/deny | Fixed | `/approvals`, `/approve ID`, `/deny ID` use CompanyApprovalsRepository and the same user/company ownership checks. Inline Telegram approval buttons are not implemented. |
| 12 | Groups, topics, reply context | Partial | Secure single-owner group binding works; topics have isolated persistent sessions and outbound replies preserve `message_thread_id`; replied text/caption is added as context. Configurable multi-user group allowlists, mention gating and replied-file hydration are not implemented. |
| 13 | Pairing/allowlist and inbound authorization | Fixed | One-time expiring pairing code binds exact Telegram user and chat. Every inbound message checks constant-time webhook secret plus connection status, user ID and chat ID. Unauthorized attachments are not downloaded. |
| 14 | Multiple connections/bots | Working | Connection ID is part of every session/dedup key, so bots cannot mix conversations. Multiple distinct bot tokens are supported. Reusing one Telegram bot token for multiple NPATI connections is unsupported because Telegram permits one active webhook per bot. |
| 15 | Retry/backoff and duplicate protection | Fixed | Telegram `429 retry_after` is honored; bounded exponential retry is used for safe/idempotent API calls and server failures. Persistent `(connection_id,event_id)` dedup prevents repeated runtime execution; old keys are pruned after 30 days. Non-idempotent send network failures are not blindly replayed, avoiding duplicate user-visible messages. |
| 16 | Restart recovery | Fixed | Database-backed session conversation IDs and active Company/Agent context survive restart. In-memory development mode does not. An already accepted in-flight turn is not durably resumed after a process crash; only its stored session/context survives. |
| 17 | Shared permissions/capabilities/runtime | Working | Inbound context retains workspace/user/permissions and all Company accesses still pass WorkspaceStore ownership checks. Company runtime retains capability allowlist, guardrail, approval and Run Trace behavior. |
| 18 | Integration/E2E coverage | Fixed | Tests cover migrations, tenant isolation, account scope, topic isolation, pairing, sender/chat authorization, dedup, media parsing, reply context, long messages, retry-after, outbound documents, status/new/stop commands and shared-runtime dispatch. Related suites cover STT, Files, documents, spreadsheets, approvals, Automations, Memory and Run Trace. |

## Changes made during this audit

- Added migration 047 for durable per-topic sessions and inbound event deduplication.
- Added Telegram API retry/backoff with `retry_after` support and conservative non-idempotent send behavior.
- Added constant-time webhook verification and authorization-before-download ordering.
- Added per-topic active context and conversation persistence.
- Added typing, progress preview, progressive edits and long-message splitting.
- Added native outbound image/document delivery through existing Files storage.
- Added reply context and video/file normalization.
- Added session, status, cancellation, runs/tasks and approval commands.
- Added native Telegram command registration.

## Remaining parity gaps versus Hermes/OpenClaw

These are not blockers for the requested single-user NPATI integration, but remain visible differences from the mature gateways:

1. No durable inbound work spool. OpenClaw persists updates before acknowledging and can resume unadopted work after restart. NPATI durably deduplicates the update and preserves the session, but an in-flight process crash can still lose that turn.
2. No configurable group policy UI for multiple allowed Telegram users, group IDs, mention requirements or per-topic tool policy. NPATI is intentionally fail-closed to the one paired user/chat.
3. Company Runtime does not expose token deltas, so its Telegram delivery is typing/progress plus final edit rather than true token streaming.
4. Approvals use secure slash commands rather than Telegram inline callback buttons.
5. No same-token multi-account arbitration. Each NPATI connection should use a distinct bot token.

## Verification

- Targeted Telegram/runtime/security test suite: passed.
- Related Memory, Files, document, spreadsheet, voice, approval, Automation and Run Trace suites: passed.
- Agent API TypeScript typecheck: passed.
- Production builds and diff validation should remain deployment-gate checks.
