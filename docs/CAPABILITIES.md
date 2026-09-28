# NPATI Agent capabilities

This document describes the capability inventory shipped in the current source tree. It
is based on `packages/shared/src/capability-matrix.ts`, the same source used by
`GET /capabilities/inspect` and `/settings/capabilities`.

Last reviewed: 2026-09-28.

## Status meanings

- **Verified**: implementation and automated evidence exist in this repository.
- **Partial**: part of the flow exists, but the complete user-facing or production flow is
  not available in every supported configuration.
- **Not implemented**: reserved in the canonical inventory but must not be presented as a
  working feature.

Provider-dependent features can still be unavailable at runtime when their connection,
credential, local service, or permission is missing. The live inspector evaluates policy
and connection state for the current installation.

## Current inventory

| Domain | Verified | Partial | Not implemented | Total |
| --- | ---: | ---: | ---: | ---: |
| AI | 10 | 4 | 1 | 15 |
| System | 56 | 29 | 38 | 123 |
| Orchestration | 13 | 2 | 18 | 33 |
| Research | 7 | 2 | 1 | 10 |
| Browser | 6 | 9 | 4 | 19 |
| Communications | 13 | 3 | 6 | 22 |
| Security | 30 | 3 | 1 | 34 |
| Storage | 27 | 1 | 1 | 29 |
| Business | 10 | 0 | 0 | 10 |
| Files | 9 | 2 | 0 | 11 |
| **Total** | **181** | **55** | **70** | **306** |

There are 42 agent-callable catalog entries: 11 verified, 11 partial, and 20 not
implemented. The other 264 entries are internal runtime, configuration, orchestration,
or security capabilities and are not directly exposed to a model.

## Verified agent-callable functions

| Canonical ID | Function |
| --- | --- |
| `research.web_search` | Search the web through configured providers |
| `browser.web_fetch` | Fetch and normalize a supplied public URL |
| `system.text-to-speech` | Generate speech through a configured provider |
| `system.speech-to-text` | Transcribe supported audio input |
| `communications.audio_understanding` | Process audio in supported chat flows |
| `system.ocr` | Extract text from supported images and documents |
| `communications.imap_email_trigger` | Receive and route authenticated IMAP email |
| `communications.image_understanding` | Process images in supported chat flows |
| `communications.telegram` | Run Telegram messages through the shared Agent runtime |
| `storage.company_memory` | Read and write tenant-scoped Company memory |
| `storage.agent_knowledge_retrieval` | Retrieve authorized Company knowledge for an agent |

## Partially implemented agent-callable functions

| Canonical ID | Current limitation |
| --- | --- |
| `system.image_generation` | Depends on provider/runtime support and is not complete for every route |
| `files.document_inputoutput` | Supported document flows exist; format coverage is incomplete |
| `system.one-shot_reminders` | Reminder flow exists but scheduling coverage is incomplete |
| `browser.browser_tab_control` | Managed-browser coverage is incomplete |
| `communications.image_generationediting` | Provider-dependent image flows are incomplete |
| `browser.browser_clicktype` | Interaction support exists but is not a complete autonomous browser |
| `browser.browser_downloads` | Download handling exists for supported managed-browser flows |
| `browser.browser_screenshots` | Supported managed-browser paths only |
| `browser.browser_pdf_capture` | Supported managed-browser paths only |
| `system.video_generation` | Provider-dependent and incomplete |
| `communications.mobile_voice` | Mobile voice path is incomplete |

## Important verified platform functions

- Central NPATI authentication and self-hosted installation authorization.
- Tenant, user, Business, and Company isolation.
- AI-provider catalog, connection management, model synchronization, fallback, and health.
- Neutral chat, Business onboarding, goals, conversations, and Company transition.
- Company-agent CRUD, hierarchy, model/instruction/tool configuration, delegated runs,
  cancellation, audit, and recovery.
- Persistent conversation memory, user memory, Company memory, knowledge documents,
  pgvector retrieval, and private object storage.
- Web search, URL fetch, bounded crawl/research, citations, and persisted research jobs.
- API-key/OAuth boundaries, encrypted secrets, route scopes, sandboxing, approval gates,
  rate limits, credential masking, PII masking, and audit events.
- Streaming responses, background completion reporting, retries, circuit breaking,
  admission control, health checks, and usage telemetry.

## Not implemented

The inspector intentionally lists reserved capabilities that do not work yet. Examples
include X search, realtime calls, camera/location/device commands, native Codex/ACP editor
integrations, nested agents, Swarm, standing orders, and several advanced routing or
compression strategies.

Use the **Not implemented** status in `/settings/capabilities` as authoritative; do not
infer availability from the presence of a name in the catalog.

## Verify the inventory

```bash
npm run audit:capabilities
npx vitest run tests/capability-registry.test.ts tests/developer-capability-inspector.test.ts
```

For a running installation, open <http://localhost:3000/settings/capabilities>.
