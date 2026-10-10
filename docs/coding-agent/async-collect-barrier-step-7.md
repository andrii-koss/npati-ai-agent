# Step 7 — Collect barrier before verification/self-review

Implementation date: 2026-10-10. Plan:
[incremental async Coding Agent implementation plan](async-harness-implementation-plan.md).

## Behavior

The root runner now joins its required async operations before the final inbox cutoff and
the existing C9 scope/test-integrity checks, verification, and single self-review. Required
operations come from the existing durable process store, scoped by company/project/session
and parent run. Children are reconciled by their own run state; shell observation never
treats a child as a tracked shell process. A preparation cancelled before dispatch does not
create a producer to join.

Settled results must be admitted through the Step 4 collector/outbox. An explicit wait's
existing admission also satisfies the barrier. New completion input goes back through the
same model loop before the final proposal is accepted, preserving the structured failure
digest and the replay artifacts. Waiting does not spend another model turn or duplicate the
root quota.

Completion notices delivered during a parent pause or under its previous worker owner are
selectively moved from `next-turn` to `next-step` by the existing inbox transaction, fenced
by the receiving run's current lease. Notices of another parent remain queued for that
parent; the same-run C10 continuation cannot strand its own completion behind the cutoff.

An active shell process inherited by C10's replacement parent lease is observed through
Step 3's existing same-handle adoption/generation fence. Its previous owner cannot settle
under the replacement lease; adopting the existing handle fixes that without dispatching
another command. Child run ownership remains separate.

Child changes come from the trusted write tracker of their dedicated child sessions;
canonical workspace diff is the fallback after restart. Process changes are compared with
the existing pre-dispatch file hashes after workspace synchronization. New untracked files
use their actual contents against an absent baseline. Both paths use the existing path and
secret guards and feed the same C9 change set and self-review input.

Mounted processes capture a bounded hash/revision baseline before dispatch when the flag is
enabled. This is workspace snapshot **v2** (`version: 2`); legacy snapshots remain readable
by the existing process/recovery paths. No file upload into a mount, new table, migration,
tool, API, queue, runner, policy engine, or approval system is introduced. Published tool
manifest v11 remains unchanged.

## Flag and unsettled work

`code.async_collect_barrier` is off by default, including self-hosted installations. Enable
it explicitly with the existing master/inbox/process prerequisites before starting work.
The flag uses the existing resolution/administration UI and company/user isolation.

The barrier waits at most 30 seconds and never exceeds the remaining run time budget.
An interrupted child, unknown outcome, timeout, disabled dependency, or missing change
evidence withholds C9 verification/self-review and sandbox release. The parent becomes
`interrupted / async_collect_unsettled`, with no terminal timestamp, and releases its lease
for the existing C10 continuation path. It never silently resumes an uncertain write.
Cancellation uses the existing cancel/settle and sandbox cleanup fences. Turning the flag
off during a wait interrupts collection; a run started with the flag off retains the legacy
path.

Recovery is deliberately conservative: if a child's file paths/diffs cannot be reconstructed
from trusted evidence, collection remains interrupted. In particular, a durable estimate
containing a file count without paths is not treated as zero changes. A mounted process
started before snapshot v2 cannot supply a trustworthy baseline and remains interrupted
when collected with this flag. Continue does not invent missing evidence.

## Acceptance evidence

`tests/coding-agent-async-collect-barrier.test.ts` covers two children settling independently,
same-handle process synchronization, result admission before verification, review after
verification, child failure context, interrupted/unknown/timeout fences, flag rollback,
cancellation and held cleanup fences, fresh collector recovery, and C10 continuation of the
same parent. It also covers trustworthy child diffs, process/untracked/mounted changes,
missing recovered paths, secret/foreign-scope refusal, artifact exclusion, and tracker scope.

The existing PostgreSQL inbox suite additionally demonstrates snapshot v2 persistence across
pools and a fresh durable collector staying unready until the child result is admitted.
Validation (logs in `artifacts/async-step-7-*.log`):

| Check | Result |
| --- | --- |
| Step 7 suite in fixed security gate | 23 tests |
| Full hermetic security gate | 162 suites / 2370 passed / failed=0 / skipped=0 |
| PostgreSQL gate on isolated pgvector/pg17 container | 2 suites / 4 passed / failed=0 / skipped=0 |
| Web tests | 11 suites / 90 passed |
| Workspace and test TypeScript checks | passed |
| Lint and web XSS checks | passed |
| Published tools audit | 43 tools, manifest v11 unchanged |
| Capability catalogue audit | passed; 391 entries |

The PostgreSQL test container was removed after verification; the existing local stack was
left running. These checks establish the implementation, not approval for production rollout.

UI integration and recovery/rollout drills remain Step 8. Step 5's separately documented
acceptance gap is unchanged.
