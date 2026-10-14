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

## Local Docker validation

- Existing Docker Desktop installation updated in place; API and company-worker image IDs match the built images. All 10 existing containers are healthy. The single shared sandbox and existing volumes remain in place.
- HTTP smoke checks: 13/13 passed, including application assets, health, authentication boundaries and missing-asset handling. Local entry point: http://127.0.0.1:13001/chat.
- Read-only PostgreSQL presentation check completed without errors: 13 saved bindings, 0 accessible processes in the sampled contexts, 0 historical operations. This confirms the read path did not throw, but does not independently validate recovery of a populated real history; that scenario is covered by regression tests.
- Local build used an ignored validation Dockerfile to seed npm cache with the lockfile-verified Lucide archive. Repository Dockerfiles and deployment configuration were not changed.

## Follow-up: execution detail width and missing commands

The screenshots exposed a CSS and data-projection regression that the earlier unit tests did not catch. Research rows inherit align-items:center, which made the nested collapse panel shrink to its content width. The composer retained a 785px cap. Coding activity now stretches its children and occupies the normal assistant width; the standard chat composer uses the available width.

The user's saved Run was examined read-only. Its verification report was present in durable public progress, wrapped in the canonical tool-result data envelope. Sparse Activity/replay entries contained the placeholder skipped and overrode that report. The projection now preserves factual public results, unwraps canonical envelopes, reads numbered source lines, extracts verification raw output, and retains the old Run's own progress during history reconstruction. Metadata without a tool-call identity is deduplicated against the corresponding timed operation. Untagged verification terminal records are associated only when both the recorded output and execution interval match. No command is guessed from a tool name.

Existing detail panels now expose sanitized replay arguments, readable file content, diff and real command output. Recorded results are not hidden merely because file metadata is present. Inputs/file content use the existing 128KB server limit and bounded, copyable UI log viewer. The Coding Runtime, tool executors, permissions and sandbox architecture remain unchanged.

Files changed in this follow-up:
- apps/agent-api/src/chat-development-trace.ts
- apps/agent-api/src/chat-development-service.ts
- apps/web/src/AgentExecutionTrace.tsx
- apps/web/src/chat-timeline.ts
- apps/web/src/styles/29-chat-development.css
- packages/shared/src/chat-development.ts
- apps/web/src/__tests__/coding-run-activity.test.tsx
- tests/chat-development-trace.test.ts
- this report

Validation:
- 5 targeted web suites: 42 tests passed.
- 2 targeted backend suites: 36 tests passed, including canonical envelopes, sparse metadata, skipped placeholders, readable source, replay/edit details and terminal/run association.
- API and web TypeScript passed; final Docker images built successfully.
- Chrome desktop (1440px) and mobile (390px): real sanitized saved execution data rendered through the production activity component and styles. Input width equals available width, nested history width equals its row, command/output sections are present and there is no horizontal overflow or React exception. The saved data exposes 7 source reads and 2 diffs. Artifacts: artifacts/chat-ui-browser/results.json and trace-1440.png / trace-390.png.
- Lint and XSS checks passed. The full lint command fails the separate source-size guard on existing files outside this change: WebsiteBuilderDashboard.tsx growth and website-renderer.ts exceeding the baseline. Those files were not modified by this fix.
- No fresh external-model deployment was started. Browser validation used actual saved data, not invented terminal logs.

Final local deployment: updated API and company-worker images are running and match the built image IDs. All 10 containers are healthy; 13 HTTP smoke checks passed on http://127.0.0.1:13001. Existing sandbox and volumes were retained.

## Follow-up: Preview readiness versus active animation

The Preview trigger previously depended only on previewUrl. The template and previous successful version can retain that URL while a new Coding Run is still executing. This made a ready-looking button coexist with real active activity. Activity animation itself is state-driven; there is no artificial completion delay.

ChatDevelopmentPreview now offers its button only when the process is completed and no displayed run remains pending, running or awaiting approval. The existing ProjectChatCard stays mounted; only its optional preview-only trigger is suppressed during work. An already open iframe/drawer remains intact during the next edit. Normal project cards elsewhere keep their existing behavior. No runtime or preview execution logic changed.

Files: apps/web/src/ChatDevelopmentProgress.tsx, business-workspace-cards.tsx, __tests__/chat-development-progress.test.tsx and __tests__/coding-run-activity.test.tsx, plus this report.

Validation: 3 web suites / 17 tests passed. Includes an existing preview URL during running/preparing/stopping/error states, active parallel work, synchronous completed-row/button transitions, repeat edits and preservation of the same opened iframe. Web TypeScript passed. Docker build/deployment validation follows below.

Preview readiness deployment: Docker build and deployment both completed successfully. All 10 existing containers are healthy; the 13 HTTP smoke checks passed. Updated API and worker contain the new web UI.

## Follow-up: chronological phases within each Run

This replaces the earlier one-row-per-Run presentation according to the latest requested behavior. A Run now contains compact phases separated by real public assistant updates. Operation IDs, Run IDs, timestamps and sequences remain the runtime's own records.

Root cause of the screenshot: rendering a single assistant progress event invoked the full process Run projection again, creating completed rows with zero operations. Meanwhile all genuine operations were anchored to the first Run row. A commentary-only render now emits only that commentary. The existing timeline partitions each Run's real operations at its public messages; each operation appears in one phase, and completed empty phases are omitted. Completed earlier phases stop animating; current work/approval remains tied to actual execution state. Concurrent operations retain their own statuses. Phase identity survives status updates and JSON reload. Commentary precedes its next phase even when timestamps coincide, using the existing server sequence.

The Preview trigger still requires a completed process with no active Run. Its existing button now includes a Lucide monitor icon and the recorded Framework (for example Next.js beside Preview). Existing drawer behavior is preserved.

Creation, direct editing and queued editing prompts now request one short public progress sentence and a 2-4 sentence final answer covering actual changes, verification and actionable blockers. Detailed reports remain allowed when explicitly requested. Existing stored model answers are preserved; no synthetic summary or fabricated command is substituted for them.

Additional changed files: apps/web/src/chat-timeline.ts, ChatDevelopmentProgress.tsx, business-workspace-cards.tsx, styles/29-chat-development.css; apps/agent-api/src/company-chat-i18n.ts, chat-development-service.ts, chat-stream-routes.ts, code-route-runs.ts; the timeline/activity/progress web tests and tests/chat-development.test.ts.

Validation: 4 web suites / 45 tests passed; 5 backend suites / 73 tests passed; API and web TypeScript, lint guard and XSS checks passed. Regression cases cover five chronological phases, exact operation membership, old-phase animation stopping, zero-row removal, identical timestamps, replay, Framework identity and Preview lifecycle. Chrome desktop/mobile rendered the actual saved execution data as five nonempty phases with 7, 8, 2, 3 and 3 operations. No horizontal overflow or React error occurred. Runtime executors and sandbox architecture were not changed. No new external-model task was started; concise-copy instruction propagation is tested at the orchestration boundary.

Phase UI deployment completed successfully: both images rebuilt and deployed to the existing Docker Desktop installation. All 10 containers healthy; all 13 HTTP smoke checks passed. Existing shared sandbox and volumes retained.
