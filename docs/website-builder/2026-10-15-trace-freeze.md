# NovaShop progress freeze

Run: `a9dabc99-59cd-453f-bf26-f60b8e8ecfdf`.

The model stopped after eight turns with `budget_exhausted`. Its database row
incorrectly said `completed`; the development process correctly said `failed`.
The browser was still displaying an earlier file-editing phase.

The SSE decoder rejected unfinished frames over 64 KB. Real file diffs crossed
that size across multiple network chunks, causing repeated disconnects before
the updated files and terminal status were delivered. Each visible/hidden tab
also held a stream, and each stream reconstructed all traces every second.

Changes:

- Accept bounded, multi-chunk progress frames up to 8 MiB.
- Abort trace streams and background polling in hidden tabs; refresh on return.
- Share simultaneous projections per authenticated owner, poll streams every
  three seconds and respect socket backpressure.
- Display edited paths and line counts without opening the operation history.
  Mount detailed logs only when the user expands them.
- Publish an explicit planning activity while waiting for the model, with an
  elapsed timer rather than a stale file-editing label.
- Persist budget/step/time stops as failed instead of completed.
- Keep full write results in activity and original calls in replay, returning concise successful
  write receipts to subsequent model requests. Record factual changed-file stats.
- Replace the contradictory first-page-only execution instruction with the full
  requested deliverables and verification requirements.
- Serve cached SPA HTML directly from the navigation hook, avoiding the observed
  sendFile/not-found race that returned an invalid HTML/JSON payload and HTTP 500.

The affected historical run status was corrected to failed only when its existing
reason was `budget_exhausted` and `finished_at` was present. Metadata was backed up
locally in `artifacts/run-a9dabc99-before-status-repair.csv`; files were preserved.
The unfinished site is not reported as completed and was not silently restarted.

Regression coverage includes split frames over 64 KB, terminal delivery, visible
file summaries, hidden-tab connection release, concurrent projection sharing,
navigation/HEAD responses, durable budget-stop status, write receipts, file counts,
runner stop conditions and deterministic replay.

## Repeated source code in model requests

The eighth provider request used 109,119 input tokens. The original compactor
shortened old tool-result content but retained full source code inside historical
assistant tool-call arguments. Recent tool results were also pinned, so argument
compaction must work even when no old result can be replaced.

Successful settled write call/result pairs now become plain runtime history
with file paths. Original argument hashes and tool-call IDs remain in durable
compression artifacts and replay, outside executable examples in model history.
Failed, pending and dry-run calls remain verbatim. Mixed batches retain other
call/result pairs. The original user specification is preserved.
Successful write receipts are compacted before output truncation, which previously
could produce invalid JSON before the receipt compactor could parse it. Replay
records the exact concise receipt delivered to the model.

Reconstructing the affected run's recorded exchanges reduced serialized context
from 432,471 to 157,287 characters (64%), preserving the specification and call IDs.
This measures recorded characters, not a new provider token count or a completed
NovaShop build. Configured quota limits remain unchanged.

Known quota-stop messages now display an explanation in the request language;
the original diagnostic remains in the journal. Regression coverage includes the
runner compaction boundary with recent successful writes and localized stop copy.

## Follow-up: invalid write arguments after compaction

Run `0d1d1e0a-c62f-4340-b670-9e5dba9fc847` exposed a regression in the first
argument-compaction implementation. Turn four successfully wrote `styles.css`.
Turns five through seven emitted only `path`, `contextCompacted`, `argumentsHash`
and `note`, copying the compacted historical call instead of writing source.
The schema correctly rejected those calls because `content` was missing.

The original compactor had replaced argument objects with schema-invalid receipt
objects inside assistant tool calls. That made receipts look like examples of
invoking `code.fs.write`. The fix removes each settled call together with its
result and records its outcome as ordinary runtime data. No synthetic tool arguments
are sent to the model. Original calls remain intact in replay. The configured
validation and retry limits are unchanged.

Live-provider verification also rejected an invented assistant-history message
because DeepSeek thinking mode requires original reasoning for assistant turns.
The runtime history is therefore marked as user-role data, explicitly not a new
user request, instead of fabricating an assistant answer or reasoning payload.

The same live check exposed missing continuation in the adapter itself: chat
completion `reasoning_content` / `reasoning_text` was discarded before the next
tool turn. The adapter now carries the original provider fields on a symbol-keyed
result property, preserved through resilience spreads and excluded from public
JSON responses. The runner attaches those fields only to outgoing assistant
history; estimates include their size. No reasoning is invented or displayed.
Tests verify wire round trips, serialization privacy and runner propagation.

Completion notes stay at the chronological completion point, after all results
in a batch. The finished assistant turn's narration is removed with its final
tool call. Prepending the note while leaving "I will write X" at the end of the
history caused repeated writes of X in a live run. Incomplete batches remain
intact until every result is available. Tests pin ordering and batch pairing.

Final verification: 90 targeted adapter, runner, compaction and replay tests
passed, together with API/adapter/test typechecks and lint. An isolated live
runner using the configured `deepseek-flash` provider, official tool schemas and
the production numbered-line reader completed the Ukrainian store request in
11 turns, with nine context compactions and 137,702 provider-reported tokens.
The fixture used a six-product, three-file store and a 500,000-token test ceiling;
application quota configuration was unchanged. Earlier fixture attempts had
insufficient test budgets, an incomplete read adapter and provider errors; they
are not counted as successful completions.

The final fixture produced `index.html`, `styles.css` and `app.js`. Verification
checked source existence, JavaScript syntax and local HTML references. A separate
DOM interaction check on these same files verified cart count 0 -> 1, persisted
cart storage, and category filtering from six products to two without runtime
errors. This is an isolated runner/provider check, not a replay of the user's
failed project or an authenticated browser test of the complete chat interface.
Local API and worker images were rebuilt and recreated; both were healthy and
the running bundle contained chronological history and provider continuation,
without the old synthetic arguments. Twenty parallel HTML navigations to chat
and Activity returned HTTP 200 (maximum observed 191 ms).

Regression tests cover absent synthetic arguments, retained failed/pending/dry-run
calls, mixed batches, original transcript immutability and the runner boundary.
