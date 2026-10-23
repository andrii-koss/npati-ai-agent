# NPATI Agent architecture follow-up - 2026-10-23

> Update: the earlier network BLOCKED status is superseded for the local shared runtime. Sandbox -> Project API and the deterministic real DB/Next.js/outage/recovery test now PASS. The completed S1-S6 conversation is FAIL, with photo design BLOCKED by provider credentials. See [current E2E report](npati-agent-project-api-e2e-2026-10-23.md). Earlier measurements below remain historical.


Overall result: **BLOCKED** for the full six-step single-chat acceptance scenario. The user confirmed that no existing egress-reachable test Project API endpoint is available. No paid model reruns were made. Deterministic fixes and live component evidence are separate from product E2E acceptance.

## Scope and constraints

Local source changes only. No production deployment/schema writes, RBAC edits, approval-policy edits, sandbox-isolation changes, push or merge. Local live probes create one disposable runtime workspace and destroy it in finally. The PostgreSQL check uses connection-local temporary tables and rolls back.

The running stack is named npati-isolated-source-20261011, but **its actual runtime mode is shared**, using bubblewrap + slirp4netns. The stack name must not be interpreted as the Docker-per-project runtime. The source fixes cover both providers. The deployed API/runner image was not rebuilt; the live browser probe uploads the changed runner and diagnostics helper into a disposable workspace. The native proxy comparison explicitly enables the flag in its child process. This verifies the mechanism, not deployment of the complete patch.

## Architecture audit

| Existing component | Finding | Decision |
|---|---|---|
| Chat Runtime / Chat Orchestrator | chat-stream-routes.ts owns SSE, admission, context resolution, project/session selection; chat-turn.ts and chat-tool-orchestrator.ts own neutral conversation/tool execution. A project-context neutral message still lacks project name/description. | Keep this entry point and its conversation ownership. Do not add a Main Agent class, router or transcript store. |
| Company Runtime | company-runtime.ts already owns company-scoped planning, capability/risk evaluation, execution, memory retrieval and synthesis. company-tool-runtime.ts already adapts web/project/data/code delegation. It requires an authorized, active company main agent. Planning uses a2aSend, followed by execution/synthesis; blanket delegation adds calls. | Reuse its authorized tool execution and lifecycle for company/project work. Do not silently create an agent or bypass company flags to route a neutral message. |
| Coding Agent | CodingAgentRunner + CodeSessionRunExecutor already implement tool iterations, session pinning, verification, cancellation, replay and sandbox access. | Keep it as the bounded coding executor behind the coordinator; retain its own policy and approval checks. |
| Routers | chat-project-intent.ts performs a semantic request on most messages, then code-intent-routing.ts classifies code intent. Creation also contains technology selection; a question about creation must remain conversational. | No broad regex replacement. Move ordinary tool selection into the existing coordinator loop; reserve semantic classification for genuinely ambiguous creation/modality/technology choices. |
| Capability Registry | Global capability guidance, immutable versioned tool schemas, effective capability resolution and model-visible tool filtering are different layers. Tools are currently selected from intent once per run. | Keep one registry and existing adapters. Capability discovery/reselection during a task is a remaining gap; adding another agent would not repair it. |
| Shared context | Existing neutral conversation history, company memory, PROJECT.md, replay/compaction and websiteConversationContext exist. Website runs receive history, but this is not a unified authorization-scoped handoff across all executors. | Resolve authorized context once per turn, then pass the same bounded project metadata/history/research references to the selected executor. Reuse current storage and NoMemory gates. |
| Web providers | Neutral/coding research use the validated research provider. Company web.fetch still tries OmniRoute before the validated crawler. | Remaining security consistency gap: route Company fetch through the same validator before any provider call. No allowlists were relaxed in this patch. |

Recommendation: **one logical coordinator, existing runtime components**. Chat Orchestrator remains the transport and context owner. Within a valid company context it invokes the existing Company Runtime/tool executor, with Coding Agent as its coding tool/run. In neutral context it uses the existing chat tool loop. Both must consume the same authorized context projection and capability decisions. This is a consolidation of existing paths, not a fourth executor.

A blind replacement with Company Runtime is not recommended: it introduces company-agent prerequisites and can retain the same routing call plus a planning call. Consolidation should eliminate duplicated intent selection before the executor, rather than wrap every current path in an additional LLM call. No measured reduction in routing LLM latency is claimed here; routing behavior was audited, not refactored in this patch. Ukrainian/English/Portuguese semantic behavior must remain covered by the existing routing suites.

## Changes implemented

### Data Studio: schema.apply@2

- Existing Data Studio provider already compiles create_relation, including a constraint on an existing UUID field.
- Added code.data.schema.apply@2 to manifest v16. The v1 canonical schema and all manifests through v15 remain available; a frozen v15 fixture checks its exact checksum.
- Current capability guidance uses v2. Model tool selection deduplicates by name **after** session pinning, so old sessions receive v1 and new sessions receive v2.
- v2 requires expectedBackendId and expectedFingerprint and verifies the attachment before calling the existing AgentDataStudioService. Nested relation arguments use existing validation, including cardinality, identifiers and unexpected fields.
- Reuses the same policy, dev-only service, migration compiler, stale-schema check and dry-run behavior. The adapter grants no database approval. No raw SQL tool or production environment parameter was added.
- Real local PostgreSQL acceptance: generated FK SQL accepts a valid child and rejects an orphan. This is a compiler/database check, not a claim that the full agent-driven migration/UI scenario passed.

### Browser QA: safe diagnostics and separate acceptance

- Runner emits at most five canonical diagnostic entries: cause category, fixed message, allowlisted source label and bounded numeric line/column.
- Original console/error text, identifier names, arbitrary filenames, URLs, query values, credentials, stacks and browser-controlled instructions are not returned. Unknown filenames are reported as preview-script; precise original paths and source-map mapping are intentionally unavailable.
- Runner parser, QA service and coding preview tool normalize the structured entries again. Diagnostics enter the existing untrusted tool-result envelope.
- code.preview.screenshot now requests console/link checks and returns sanitized diagnostics and the functional QA outcome, so the Coding Agent can inspect causes rather than an error count alone.
- A functional QA failure produces functionalAcceptance=failed and blocks visual inference/repair. No vision reviewer call is made on the broken page. Functional repair can use the existing coding loop/tools; no new autonomous repair loop or agent was introduced.
- A passing Browser QA check still does not prove business behavior or database binding.

### Sandbox ? Project API

Confirmed independent causes:

1. API configuration is http://127.0.0.1:13001. In the project namespace this points to the project itself; live result: ECONNREFUSED.
2. Native Node fetch was not consuming HTTP_PROXY automatically. In the actual shared sandbox, the same allowed registry request failed with EAI_AGAIN when NODE_USE_ENV_PROXY=0, and returned HTTP 200 with NODE_USE_ENV_PROXY=1.
3. Docker service names are not an alternate route: the runner is on sandbox-control/egress networks, and the existing proxy rejects internal service/database destinations and custom port 13001. Proxy/network guards were not changed.
4. The API process itself is healthy (HTTP 200 from its own network namespace). Local Project API HTTP tests cover key validation, cross-project denial and gateway behavior. Successful authentication from the project namespace cannot be established while connectivity is blocked.
5. The API container has the Project API URL, while the deployed shared runner does not have that URL in its environment. A future reachable hostname must also be present in the runner's existing egress configuration.
6. Current sites can catch API errors and display static content. The existing website data scaffold reports errors, but arbitrary generated site code is not a trustworthy acceptance signal.

Fixes: enable native proxy use in the shared launcher and both provider environments (with NO_PROXY scoped to the already-fenced own Preview socket, preserving existing localhost entries); fail early with PROJECT_API_UNREACHABLE_CONFIGURATION when shared/isolated sandbox environment generation receives an incompatible loopback/IP/internal/custom-port URL. Static preflight is not a DNS security decision: existing DNS pinning/address validation stays authoritative.

The end-to-end data path remains BLOCKED. No new private-IP exception, Docker network attachment, public API listener, tunnel or database exposure was created.

## Evidence and metrics

Final machine-readable evidence is under artifacts/architecture-followup/ and artifacts/architecture-followup-final-tests.json. These local artifacts are not committed.

The latest live smoke run:
- Total: 13,310 ms; 11 signed runtime requests before cleanup, one cleanup request.
- Allowed native fetch: proxy disabled ? EAI_AGAIN in 5,390 ms; enabled ? HTTP 200 in 1,196 ms. These are single observations, not medians.
- Loopback Project API: ECONNREFUSED in 188 ms. Internal agent-api and postgres-projects requests were rejected; undici reported numeric cause code 0. No HTTP 200 was accepted as connectivity.
- Live Chromium diagnostics: 3,928 ms; preview HTTP 200; two deliberate JS errors; canonical ReferenceError at preview-script:1:157; control secret absent from output.
- Real model LLM calls: 0; model input/output tokens: 0; model tool calls: 0. Runtime RPCs are counted separately from model tool calls.
- Local PostgreSQL FK acceptance: 567 ms in the first dedicated run, six tests passed; 297 ms in the final full suite. Temporary tables were rolled back.
- Supported-runtime native proxy compatibility: PASS in 195 ms on Node 24.22.1; the port-scoped own Preview request returned HTTP 200, a different port was rejected through the proxy. Artifact: artifacts/architecture-followup/native-proxy-port-bypass.json.
- API typecheck and test typecheck passed in initial verification; final rerun results recorded below.
- The initial broad regression run passed 198/199 tests. The capability HTTP test timed out during concurrent TypeScript work; its isolated recheck passed 10/10 in 30,358 ms. The final suite uses two workers.
- Lint and XSS scanning pass. Full npm run lint is FAIL because the unchanged, already-present apps/web/src/DataStudioSettingsPage.tsx exceeds the source-size baseline. No allowance was added to hide it.

Final regression verification: **PASS ? 210/210 tests across 19 files, 51,909 ms** (two workers), including real PostgreSQL FK enforcement in 297 ms. Artifact: artifacts/architecture-followup-final-tests.json. The earlier 198/199 run and isolated recheck are retained as execution history, not merged into the final count. Final API typecheck and test typecheck: **PASS**.

The local test host is Node 22.13.1, below the repository engines floor of 22.22.2 for Node 22. The actual live shared runner is Node 24.22.1. Local passing tests do not replace validation on the supported deployment runtime.

## Six-step single-chat acceptance

These are **new-run** statuses; historical numbers in npati-agent-architecture-audit.md remain historical and are not relabeled as post-fix results.

| Scenario | New-run result | Elapsed / LLM / tokens / tools / errors | Acceptance evidence |
|---|---|---|---|
| 1. Create Next.js shop | BLOCKED / not run | N/A / 0 / 0 / 0 / N/A | Full scenario held behind deterministic configuration gate. |
| 2. Real web research | BLOCKED / not run | N/A / 0 / 0 / 0 / N/A | No current six-step chat/research run; historical evidence remains in prior report. |
| 3. Tables and relations | BLOCKED at full-chat level | N/A / 0 / 0 / 0 / N/A | Component FK/schema/compatibility tests pass; real temporary PostgreSQL FK check passes. |
| 4. DB data on the site | BLOCKED | N/A / 0 / 0 / 0 / connectivity blocker | No reachable Project API endpoint; no claim that a DB row appeared in the Sandbox site. |
| 5. Design by photo | BLOCKED / not run | N/A / 0 / 0 / 0 / N/A | Safe browser diagnostics pass live; functional/visual gate passes regression tests. No fresh vision acceptance. |
| 6. Return to earlier research | BLOCKED / not run | N/A / 0 / 0 / 0 / N/A | No fresh conversation continuity acceptance; context unification is still required. |

## Remaining acceptance gate

Before the next paid single-chat run: provide an existing approved endpoint reachable through the existing proxy, configure that hostname consistently in API/worker/runner, install the source fixes in the local test stack, verify native server-side requests with real publishable-key authorization, then verify a unique dev row through the website. Interrupt that API request path only in the disposable test project and assert an explicit error/non-success state with no static substitute. Restore it and verify a subsequent row change appears. Do not stop the shared API/database to simulate an outage.

Only after those deterministic checks pass should the six-step harness run once in one conversation with per-scenario SSE timing, provider usage, model/tool activity, error and acceptance evidence. The provider logging undercount for some neutral Gemma calls remains a measurement limitation; missing usage must be reported as unknown, never zero. Repeat expensive DeepSeek runs only after those gates and account/model availability checks pass.

Remaining architecture work is not presented as complete: neutral project metadata, shared context projection, Company fetch validation consistency, per-task capability reselection, routing consolidation and live research recall/design acceptance still need implementation or validation.
