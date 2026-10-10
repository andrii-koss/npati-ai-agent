# NPATI async harness — Step 4

Process completion delivery uses the existing durable process store, session inbox, CodingAgentRunner, canonical `code.shell.process.wait` tool and C15 task dispatcher. It adds no producer or detached child execution path.

Terminal output (a bounded 64,000-character tail), absolute cursors, lossy status and the outbox notice commit atomically in the classified process-project record. The identity is `{operationId,generation,eventId}`; the notice contains metadata and a stable `resultRef`. A reconciled terminal outcome after an ambiguous spawn also creates a notice. Preparation that never reached dispatch creates none.

Delivery inserts the notice idempotently into the inbox before acknowledging `completion.delivered`. Recovery on authenticated session reads, runner boundaries and active observation retries persisted intents without spawning. Active API observation retries every second, with at most 200 authenticated session contexts. After a cold restart, an authenticated session read/wake reattaches observation; this is not an unattended startup scan using persisted credentials.

A busy parent receives the result at its next boundary, including the boundary before final sealing. An idle session reserves a new deterministic `code-inbox-*` run through the existing admission, quota and executor path. The persisted quota allows at most 10 automatic completion tasks per session per rolling hour. A blocked completion remains pending and does not block explicit user tasks.

Collection adds at most 8,000 output characters plus the envelope and reference to model context. The process store records `result.admitted` only after the runner appends the context message. The receipt is fenced by the receiving run lease and terminal operation generation. Canonical foreground/wait results record the same receipt after their tool message is appended and suppress a pending completion notice. Server-side process receipt metadata survives generic tool-result truncation.

UI reads have their own inbox revision/registry sequence and never create model admission receipts. Completion progress uses CodeBackgroundRunRegistry; whole-run terminal events remain separate. The pending-message UI displays availability and offers no user edit/delete controls for completion notices.

Replay bundles include completion context/reference artifacts in the input hash. The cassette restores those messages before context-pressure evaluation without running producers. Bundles without artifacts retain their existing hash contract. Retention preserves pending process results and their parent linkage until admission; explicit erasure remains scoped through the existing lifecycle service.

## Local Docker Desktop

Run from the repository root:

```powershell
./scripts/update-local-async-docker.ps1
```

The script rebuilds API, Company worker, web and the isolated runner, validates Compose and waits for health. It uses the existing fresh-local installation volumes and preserves the local MinIO override when present. The isolated runner uses the Docker socket; project sandboxes receive no Docker socket. Locally built images without registry digests are permitted only with the explicit development/unverified-images settings in `docker-compose.sandbox-isolated.yml`.

Web: http://localhost:3000. API: http://localhost:3001. Runner health: http://localhost:7865/health. The shared project runtime does not support durable process identity; use the isolated profile for Steps 3–4.

In the Coding Agent flags panel, select **Company** scope and enable `code.async_inbox` and `code.async_processes` for the test Company. The master flag, `code.background_runs` and `code.shell` must also allow execution. The two async flags remain off by default, including self-hosted deployments.

Test with `code.shell.exec_async`, continue the parent task, then use `code.shell.process.wait` or observe automatic collection. Check that UI reads leave results available to the model, a late result starts a new run, and output exceeding the tail/context limits retains a result reference and cursors.

## Validation

Dedicated completion tests cover atomic settlement/outbox, recovery without respawn, lost spawn response, duplicate delivery/admission, publication/ack crash, live-wait suppression, foreign scope, stale receiving owner/generation, bounded lossy output, replay input integrity, idle task identity, durable wake quota and two completions during an LLM call. PostgreSQL tests exercise competing connections and pending-result retention. UI tests verify availability without output or edit controls.

Verified: security gate **158 suites / 2301 passed / 0 failed / 0 skipped**; PostgreSQL gate **2 suites / 4 passed**; web **11 suites / 90 passed**; real Docker process acceptance **1 passed**. Workspace/API/web typechecks, backend test typecheck, lint, schema/catalog audit and Docker builds passed. Full-suite baseline failures from Step 3 are documented in [the previous report](async-process-step-3.md); a passing security gate does not claim the entire repository test suite is green.

Local Docker verification: API, Company worker, web and isolated runner healthy; HTTP localhost:3000, localhost:3001/health and localhost:7865/health return 200. Authenticated runner RPC confirms durableIdentity=true and terminalStatus=true; readiness confirms all six facts true with no reasons. Existing volumes preserved. The PowerShell update helper was executed successfully with -SkipBuild after builds, and handles Compose progress on stderr without treating successful native commands as failures.
