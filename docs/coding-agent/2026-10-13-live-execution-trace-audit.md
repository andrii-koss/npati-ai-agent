# Chat execution trace audit

The chat already had AgentExecutionTrace and the ResearchProgress red dot/text animation. The runtime already persisted write-ahead tool calls, Replay bundles, Activity metadata, terminal events and background-run state. No new execution ledger or command permission has been introduced.

## Findings and changes

- Completed last rows were inferred as running. Explicit call states now determine animation and status; legacy rows without a state say Recorded.
- Waiting for approval was styled as Completed. Approval-required calls remain waiting, including settled approval responses.
- Consecutive calls sharing a title were merged, hiding different files and parallel operations. Deduplication now uses run/call IDs.
- Template stages claimed success before execution and invented npm commands and paths. ProjectPreviewService now reports the selected package-manager command and its actual result around sandbox execution.
- Clipboard copied unredacted strings and claimed success before the clipboard resolved. Server projection and rendering/copy now mask credentials; clipboard errors do not claim success.
- Projection read the original run before discovering the latest session run. It now selects the current tenant/project/session run before reading its write-ahead calls, Replay and Activity. Existing terminal repository reads enforce user/workspace/project isolation.
- Polling alone was used. An authenticated SSE transport now signals changes in the existing persisted projection, with reconnect and GET fallback. This transport samples persisted records each second; it does not fabricate events or store another execution history.
- Details now use native buttons, mobile-visible chevrons, an inert collapsed panel and a grid transition. Long output is scrollable, initially bounded and expandable to the full recorded result. Runtime truncation is explicitly marked.

## Verification scope

Tests cover projection states, parallel calls, stable identities, reload, tenant boundaries, secret masking, real DOM expand/collapse and clipboard behavior, SSE framing/reconnect, and the existing development/preview lifecycle. Model execution in lifecycle tests uses controlled ports; these tests do not prove a remote configured model created a real website. Docker Desktop is updated separately using the existing compose project and volumes.

## Local validation results

- Web: 18 suites, 122 passing tests (including jsdom interactions and SSE reconnect).
- Backend: 4 selected suites, 53 passing tests; includes a real HTTP SSE connection, disconnect and reconnect over persisted runtime state. Model responses in these lifecycle tests are controlled.
- API TypeScript check, API build, web TypeScript/build, lint/XSS/source-size guards and diff whitespace check passed.
- Docker Desktop: rebuilt/restarted the existing agent-api, company-worker and sandbox-runner in npati-isolated-source-20261011. All 10 existing services are healthy; project volumes and the one shared sandbox are retained.
- Local HTTP smoke checks passed at http://127.0.0.1:13001. Both development snapshot and SSE endpoints return 401 without authentication.

## 2026-10-14: missing project history regression

The local database contained six saved development bindings, five referencing projects that no longer existed. The terminal history authorization correctly refused those reads, but the aggregate Promise.all propagated one refusal through the whole list and then through startOwned, preventing an unrelated new creation request. The earlier timestamp-only fix did not cover this failure.

The list now authorizes each referenced project before reading its trace and omits missing/inaccessible entries, including removal during a terminal-log read. Unexpected infrastructure errors still propagate. Admission counts use the validated current views, so stale running entries do not consume the four-project limit. The persisted history is retained; no production rows were deleted.

Validation: 58 selected backend tests passed, including deleted history followed by a new creation request, four stale running bindings, and access/infrastructure error separation. API typecheck, lint and HTTP smoke checks passed. A read-only invocation of ChatDevelopmentService.list with the actual PostgreSQL store and terminal repository succeeded against the existing local data: six saved bindings, one accessible process, three historical operations. Local API and worker images were rebuilt/restarted and are healthy. This validates history loading and the creation admission regression; it does not claim a new real-model website build was completed.

## 2026-10-14: follow-up chat rendering and project continuity

The production coding stream sent a progress frame containing routing metadata without a presentation type. The chat accepted it as ChatProgressEvent and rendered event.type.startsWith(...), causing React to fail. The SSE client and progress hook now admit only known presentation event types; routing metadata is ignored while replies and Coding Session frames continue normally. Both delimited and final untyped frames have regression coverage.

The deployment placeholder and full project card are hidden in the dedicated project chat. Its existing execution trace is followed by the existing Preview drawer in preview-only mode. Preview no longer activates editing or emits the misleading Editing... notice. The preview component remains mounted across subsequent messages, so sending another change does not close its drawer. Meaningful agent replies are retained, with the current trace before the final reply and Preview below it. The unused legacy progress-to-research adapter was removed.

Project identity is recovered from the persisted conversation binding when entering from the chat list, even without URL parameters. Reply navigation retains company/project identity. Component creation inside an active site (for example a contact form) is classified as an edit, and both frontend and production stream tests keep the same project/session. Explicit independent creation still creates a new project through the parent development chat.

Validation: all 126 web tests and 73 selected backend tests passed, along with web build, API typecheck, lint and HTTP smoke checks. The full React chat tests send three consecutive edits, consume realistic coding routing and Coding Session SSE frames, check the absence of duplicate cards and the false editing notice, preserve project URL identity, and verify an open Preview survives another edit. These are controlled SSE/model-port tests, not a claim that a new real-model website build was run. Docker Desktop was found stopped after image building; it was restarted, then the updated existing API/worker containers were deployed. All 10 containers are healthy.

## 2026-10-14: chronological chat and live coding observer

Audit found three independent presentation problems: coding requests were appended only after execution (completion order replaced admission order), the entire project trace was relocated before the newest reply, and repeated scrollIntoView calls overrode readers in history. Child chats persisted a placeholder card instead of the initiating request and discarded the actual final text. Activity is metadata-only by design; its sink explicitly rejects command/content/output, and Replay bundles are committed only on completion. Adding those fields to Activity would violate the existing storage contract.

Requests now persist before the executor starts and return durable message IDs/timestamps for optimistic reconciliation. Neutral PostgreSQL appends are serialized per conversation with a transaction/advisory lock; monotonic millisecond timestamps preserve order through JSON/JS, with id as the legacy tie breaker. The in-memory implementation mirrors this guarantee. Child chats store the initial request before setup and the real final response; routing metadata attaches to the existing request instead of creating an extra card bubble.

The existing runner/executor has an optional best-effort presentation observer at actual model-public commentary, tool start/result, verification and Preview boundaries. It does not change policy, command execution, concurrency, model selection, approval or sandbox isolation. Redacted presentation updates use the existing per-owner process binding and existing SSE change hints; durable write-ahead/Replay/terminal records remain authoritative. There is no second runtime or channel. Per-owner update serialization avoids CAS starvation when four jobs report concurrently; CAS remains for other API instances.

The UI merges messages and trace operations into a single keyed sibling list at operation start time, so adding a new reply does not reparent all historical rows or lose expansion state. Unknown/malformed payloads are normalized before rendering. SSE rejects malformed JSON, non-text deltas and invalid session/progress fields. Rows use Lucide and the existing research red-dot/text animation, native keyboard buttons, mobile-visible chevrons, bounded/copyable logs, real diff/test details when supplied by tools, and all seven existing locale dictionaries. Scroll follows only within 96px of the end; the obsolete top-alignment spacer is reduced.

Limits: the existing SSE snapshot transport samples persisted changes each second; very short operations can first appear completed. No private reasoning is read or displayed. File diff and structured test counts are shown only if the actual tool result supplies them; missing counts are never fabricated. Older runs without recorded arguments cannot reconstruct commands. Tests use controlled model/tool ports and realistic SSE, not a claim of a new remote-model website deployment.

Changed files in this audit increment (in addition to preserved previous workspace changes):

- API: app.ts, chat-stream-routes.ts, chat-development-routes.ts, chat-development-service.ts, chat-development-trace.ts, code-session-run-executor.ts, coding-agent-runner-contracts.ts, coding-agent-runner.ts, coding-agent-review-phases.ts, code-chat-website.ts.
- Web: BusinessWorkspace.tsx, AgentExecutionTrace.tsx, ChatDevelopmentProgress.tsx, chat-timeline.ts, chat-stream.ts, use-chat-development.tsx, styles/29-chat-development.css, i18n/types.ts and all seven i18n/locales/*.ts dictionaries, apps/web/package.json.
- Shared/storage: packages/shared/src/chat-development.ts, packages/shared/src/index.ts, packages/workspace/src/in-memory-store.ts, packages/workspace/src/postgres-company-repositories.ts, package-lock.json.
- Regressions: chat-timeline.test.ts, agent-execution-trace-interaction.test.tsx, chat-development-progress.test.tsx, tests/chat-development.test.ts, tests/coding-agent-c6-runner.test.ts, tests/coding-agent-chat-website.test.ts, tests/web-chat-stream-client.test.ts.

Validation for this increment: 20 web suites / 133 tests passed; 7 selected backend suites / 96 tests passed (runner, verification, chronological persistence, development lifecycle, trace projection, malformed SSE and existing routing). The final native-commentary guard also passed all 29 runner tests. API TypeScript, web TypeScript/build, lint/XSS/source-size and diff checks passed. Full React chat coverage includes three successive edits, stable expanded row DOM across new replies, reader-controlled scrolling, and an open Preview surviving another edit.

Docker Desktop: rebuilt and restarted the same agent-api and company-worker services in npati-isolated-source-20261011; all 10 existing services are healthy. The shared sandbox and volumes were retained. HTTP smoke checks passed at http://127.0.0.1:13001. Two builds hit npm ECONNRESET while downloading Lucide; local validation used a temporary Dockerfile/compose override under artifacts/docker-validation-source with the exact archive from the local npm cache, verified against package-lock.json SHA-512. The repository Dockerfile was unchanged.

The final read-only PostgreSQL check succeeded against the user's current local data: 7 saved bindings, 2 accessible processes, 64 historical operations. No rows were changed by this check.
