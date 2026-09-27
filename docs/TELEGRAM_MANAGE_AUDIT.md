# Telegram Manage UI Audit

Audit date: 2026-09-27

The existing `Manage` action previously opened only a channel overview with `Test` and `Remove`. It did not expose connection-level settings.

| Section | Result | Current behavior |
|---|---|---|
| General | Working | Edit connection name, inspect status/bot/activity/error, replace bot token, test, disconnect, reconnect or permanently remove the connection. Tokens and webhook secrets are never returned to the browser. |
| Access / Pairing | Partial | Shows the exact paired Telegram user and primary chat, supports new pairing and revoke. NPATI intentionally supports one paired owner identity per connection; a multi-user owner allowlist is not implemented. |
| Context | Working | Shows and changes Account/Company/Agent scope and binding. Displays active Company/Agent from the latest persistent Telegram session. |
| Groups | Working | Enable/disable groups, configure allowed chat IDs, require bot mention, select reply behavior and inspect observed chats/topics. The paired user identity remains mandatory in every allowed group. |
| Notifications | Partial | Automation results, errors and progress/status preferences are enforced. Background task preference is persisted, while generic BackgroundCompletionReporter jobs do not yet publish through the messaging gateway; direct Telegram task replies continue normally. |
| Commands | Working | Displays the native registered commands: `/companies`, `/company`, `/agents`, `/agent`, `/context`, `/account`, `/new`, `/reset`, `/stop`, `/status`, `/runs`, `/tasks`, `/approvals`, `/approve`, `/deny`. |
| Media | Working | Per-connection controls for inbound images, documents/files and voice/audio, plus outbound files/images. Existing Files, document extraction and STT services remain the implementation. |
| Advanced | Working | Typing and progressive editing controls are configurable. Long-message chunking, retry/backoff, durable deduplication, webhook transport and database session persistence are shown as read-only runtime guarantees. |

## Added

- Eight-section connection manager inside the existing provider-style drawer.
- Tenant-scoped management API for connection details, sessions and capabilities.
- Safe token replacement and re-pairing.
- Pause/reconnect without deleting the connection.
- Editable scope and Company/Agent binding.
- Group, notification, media and delivery preferences stored in `messaging_connections.settings`.
- Enforcement of group allowlists, mention policy, reply mode, media and delivery preferences in the existing Messaging Gateway.
- Migration 048 for JSONB connection settings.

The architecture remains `Telegram -> Messaging Gateway -> Scope Router -> Chat/Company Runtime`.
