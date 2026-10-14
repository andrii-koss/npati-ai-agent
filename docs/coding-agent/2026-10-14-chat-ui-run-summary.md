# Chat UI: one activity row per Coding Run

## Audit

The chat inserted every operation as a separate assistant article, inheriting ordinary message spacing. AgentExecutionTrace added agent-name and Completed badges. The composer mounted CodePendingMessages and queue/steer buttons whenever the inbox became active (including verification). Coding creation, regular editing and queued execution omitted the language instruction already used by ordinary chat.

## Changes

- Group operations by durable Run identity. Setup uses a stable initial-run alias until the real ID exists. Run status and start time come from existing run records; completed older runs remain independent. One row updates its current operation and icon, with a localized operation-count summary on completion. A known running Run is visible before its first tool call, without fabricated commands or logs. Its anchor remains stable when the first tool arrives.
- History is collapsed by default and lazily mounted on click. Existing per-operation details, copy controls, red dot/text animation, native keyboard buttons, mobile chevrons and grid expand/collapse are reused. History remains mounted for the collapse transition, then unmounts. View Run links use that group's actual Run rather than the project's newest Run.
- Remove agent and status badges from activity rendering; metadata remains intact. Scoped CSS sets a 32px compact header and removes coding-article spacing. Other chat layout, project tiles, Preview and composer styling are unchanged.
- Remove the pending panel and queue/steer buttons from the main composer. The normal Send path still uses the existing queue. During coding, a nonempty draft exposes Send; an empty draft retains Stop. Queue errors use the existing notice. Accepted user messages and actual replay replies are projected from durable inbox/replay records into the chronological message feed, including after refresh, with stable IDs and author filtering. No extra queue or message ledger was created.
- Reuse the existing conversation-language resolver with coding-specific exclusion of command/path vocabulary. Append its existing mandatory language instruction at creation, regular edits and queued-run orchestration boundaries. Short requests use user-message history; assistant logs and the English orchestration wrapper do not determine language. Run labels use request language independently of the UI preference. Dictionaries cover the 16 languages supported by the existing detector; commands, paths and terminal output are preserved.

The CodingAgentRunner, executor, tool implementations, command admission, approval rules, cancellation, sandbox isolation, package installation, build and preview implementations were not modified. API changes are presentation projections and language context at existing orchestration entry points. No tables or event channels were added.

## Changed files

- apps/agent-api/src/chat-development-service.ts
- apps/agent-api/src/chat-stream-routes.ts
- apps/agent-api/src/code-route-runs.ts
- apps/agent-api/src/company-chat-i18n.ts
- apps/web/src/AgentExecutionTrace.tsx
- apps/web/src/BusinessWorkspace.tsx
- apps/web/src/ChatDevelopmentProgress.tsx
- apps/web/src/business-workspace-composer.tsx
- apps/web/src/chat-timeline.ts
- apps/web/src/code-inbox-client.ts
- apps/web/src/i18n/index.tsx
- apps/web/src/i18n/locales/en.ts, uk.ts, de.ts, fr.ts, es.ts, it.ts, pl.ts
- apps/web/src/i18n/locales/request-execution.ts
- apps/web/src/styles/29-chat-development.css
- packages/shared/src/chat-development.ts
- apps/web/src/__tests__/chat-development-progress.test.tsx
- apps/web/src/__tests__/chat-timeline.test.ts
- apps/web/src/__tests__/coding-chat-followup.test.tsx
- apps/web/src/__tests__/coding-run-activity.test.tsx
- tests/chat-development.test.ts
- tests/coding-chat-language.test.ts
- tests/coding-agent-async-inbox.test.ts

## Validation

- Web: 21 suites / 154 tests passed. Covers one stable row through Sandbox, editing, install and build; default collapse; nested details; independent runs; request-language labels against English UI; all 16 dictionaries; actual queue submission through normal Send; three successive edits; Preview continuity; history scrolling; malformed events and existing chat/UI regressions.
- Backend: 8 selected suites / 102 tests passed. Covers language resolution/instruction, original Ukrainian request propagation into the actual executor input, durable queue/replay presentation, author boundaries, refresh, existing install/build/Preview lifecycle, actual inbox/runner integration, pause fences, verification and routing.
- API TypeScript, web TypeScript/build, lint/XSS/source-size and diff checks passed. Docker builds also compiled the final source.
- The old inbox test expected self-hosted inbox defaults to be off, contradicting the previously implemented self-hosted configuration. Its assertion was updated to match configured defaults, and disabled installations remain tested. Feature-flag implementation was not changed.

Model/tool integration tests use controlled responses. They validate prompt language propagation and UI behavior, not a newly executed remote-model website deployment or a guarantee that every external model obeys language instructions. Streaming uses the existing persisted snapshot/change-hint transport.
