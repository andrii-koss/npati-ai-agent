# Activity & Run Trace monitoring audit

The existing runner already had durable run/turn state, write-ahead tool calls,
Replay bundles, metadata-only Activity, a persisted chat presentation observer,
terminal history, Preview lifecycle events and Browser QA reports. The chat
already supported SSE snapshots with reconnect. Activity read Company Runs only,
so these coding records did not reach the page linked from the coding chat.

The existing Activity page now lists Coding Runs and preparation failures alongside
Company Runs. The monitor reads the same persisted records, with project/workspace
authorization, stable history pagination, expandable command/file results and
filters. It polls every three seconds, retries after failure, preserves displayed
records and expansion, and skips requests while hidden. Live Activity reads current
operations across the entire run even when historical pages have not been loaded.
There is no new execution ledger or model orchestration path.

Additional fixes:

- Model requests and individual local provider attempts persist timing, selected
  model, HTTP failures and retry/fallback disposition through the existing Activity
  sink. Self-review calls are included. Original event types survive adaptation to
  the Activity family instead of being discarded.
- Activity pagination no longer silently cuts off records after 200 events.
- Logger failure cannot prevent the database insert. Terminal commands/output are
  masked before persistence, and display output remains bounded and masked.
- Nonzero exits, failed result envelopes, failed checks and Browser QA are failures
  even if tool transport succeeded. Terminal running state remains running.
- Preparation failures before a Runtime row exists retain their real process ID.
  A Preview failure after Runtime completion controls the site's displayed status.
- Legacy completed rows carrying a limit/failure stop reason display as failed,
  without rewriting the original database records.
- Repeated operations/errors without confirmed progress produce Possible Loop.
  Three attempts, pending approvals, different effective edits and dry runs are
  distinguished. No Progress and Stalled use elapsed observations; install/build
  commands get a longer stall window. Detection warns and does not change execution.
- Only successful, non-dry-run change receipts, passing tests and Preview prove
  progress. Repeated identical receipts do not reset its clock. No percentages
  are invented. Worker lease/heartbeat metadata is available when recorded.

Read-only local database audit found 21 historical Runtime rows: three were failed,
17 marked completed and one waiting for a user. Three completed rows had a budget
or step-limit stop reason. Failed recorded tools included approval_required and a
Git write-intent refusal; these are not evidence of an agent loop by themselves.
No Coding/Company Run was executing at the time of the audit. The current database
had no remaining projects or sessions: the Runtime evidence belonged to deleted
projects and must not become accessible through the authenticated project UI.

A read-only projection of eight archived runs restored 340 events, including a
recorded command, with measured projection times of 10–101 ms. This exercised the
actual PostgreSQL records and the new projection without editing historical rows.
It was not a new website build or an authenticated browser test of a current project.

Limits: provider-internal routing inside the separate OmniRoute service is visible
only to the extent its API reports it; NPATI records every local request/attempt.
Older runs cannot reconstruct inputs that were never persisted. Filters on history
apply to loaded pages; Live Activity and the summary cover the complete projection.
Browser QA projection reads up to 200 reports scoped to the run. The monitor retains
the existing immutable evidence/retention contract; it does not delete or rotate
append-only evidence tables. Operational archive rotation remains a storage-policy
concern rather than a new deletion mechanism in the UI. Output bounds and read
pagination are enforced here. No fresh real-provider website build was started.

Validation and local deployment:

- 13 backend suites / 217 tests passed, including Runtime, Activity persistence,
  provider failures/fallback, self-review, trace pagination, approvals, Browser QA,
  Preview finalization, historical status correction and company stability.
- All 23 web suites / 169 tests passed. Monitor DOM coverage checks actual command
  output, reconnect after a failed poll, retained expansion and status filtering.
- API and web builds, API/web/test TypeScript checks, lint, XSS, source-size and
  whitespace checks passed. Existing Vite chunk-size warnings remain.
- API and Company Worker were recreated in the existing local compose project
  only after confirming no executing runs. All ten services are healthy. Sandbox,
  databases, volumes and the waiting-for-user record were retained.
- The standard Docker build stalled downloading Alpine packages. The local
  deployment instead uses the existing Linux runtime dependencies (package-lock
  is unchanged) with the freshly built API/web artifacts. The reviewable Dockerfile
  and compose override are in `artifacts/code-monitor-image/`; ordinary source
  builds still use the unchanged repository Dockerfile.
- Running API and web HTML SHA-256 hashes match the checked local builds. Health
  and HTML navigation to Activity return 200. Both new monitor endpoints return
  401 without authentication. The monitor route and model event instrumentation
  are present in the running bundle. No account token was obtained or bypassed.
