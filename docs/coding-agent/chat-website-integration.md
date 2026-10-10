# Website editing through Coding Agent chat

The async harness alone did not connect website creation and subsequent chat edits to the code runner. The browser's streamed chat now creates a `code_project`, prepares the existing website scaffold and optional database/auth SDK, detects its toolchain, and starts the canonical Coding Agent session. Website creation no longer uses the Company agent's visual Builder path when Coding Agent is enabled.

The authenticated conversation card records the project and session. Natural-language edits reuse that binding; selecting another website in the dashboard opens `/chat?company=…&project=…`. Explicit creation starts another project. Legacy editor routes redirect to this chat entry. Existing website projects can also receive a code session.

After a successful editing run, the shared session executor requires canonical C9 `build` verification for Next.js before starting the existing Preview runtime. A no-change build request still executes verification. Failed builds, approval requests, interrupted runs and read-only reviews cannot claim a completed build or running preview. Static HTML previews do not invent a build command. A running preview keeps its sandbox after the run and refreshes the right-hand drawer after subsequent changes; the chat composer remains available.

This change preserves the existing run admission, inbox, cancellation, RBAC, approvals and audit. It adds no tool schemas or new queue. Manifest v11 remains 43 tools and the catalogue remains 391 entries. Async rollout flags remain unchanged. The non-streaming `/chat` endpoint retains its previous orchestration; the browser uses `/chat/stream`.

Runtime fixes found by the integration checks: plain websites without a DataBackend skip optional Project API environment injection; privileged RBAC audit uses the authenticated workspace; Windows filesystems without inode counters do not report false disk exhaustion; application shutdown closes its owned MCP policy pool. Browser shared imports defer Node crypto calls until server-side approval signing is invoked.

## Verification

- `tests/coding-agent-chat-website.test.ts`: conversation binding, access isolation, real production stream routing, verified-build requirements and truthful Preview failure. Its in-memory app test explicitly expects the missing privileged audit refusal.
- `tests/coding-agent-chat-website-postgres.test.ts`: actual source read/edit tools through production chat with PostgreSQL and audit. Uses an isolated disposable database and a scripted model.
- `scripts/verify-chat-website-browser.mjs`: actual React chat in Edge with mocked HTTP/SSE. Checks right-hand Preview, usable composer, same-project edit request, refresh and history restoration.
- `scripts/verify-chat-website-runtime.mjs`: optional real local runner drill, actual dependency installation, production build and HTTP Preview; uses a scripted model and disposable PostgreSQL. Requires `DATABASE_URL` pointing to a disposable PostgreSQL server supporting pgvector.

These checks do not constitute acceptance of a live external AI provider.

## Manual check

Refresh `http://localhost:3000/chat` after deploying the updated local images. Select a company if more than one exists. Send “Створи тестовий сайт інтернет-магазин на Next.js, запусти build і Live Preview”. Wait for the run and any requested approval. Click **Preview**, then send “Зроби кнопку зеленою та додай секцію товарів” in the same chat. Confirm the project/session stays the same and the preview updates. The saved website is available under `/settings/websites` via **Редагувати в чаті**.
