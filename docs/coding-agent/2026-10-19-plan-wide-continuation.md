# PLAN-wide audit continuation — 2026-10-19

This continues the existing2960 source clauses without restarting the audit. C3 remains open; it no longer blocks independent review of other sections. Production, user data, approval/seccomp settings, automatic CI triggers and external model connections were not changed. The deployment remains one shared Sandbox with separate logical project folders.

## Implemented repairs

- C4 shell session ownership now includes workspace and user, in addition to Company/project. A foreign caller cannot inherit remembered cwd/env.
- C4 secret leases are checked against session, Company and project before consumption; foreign refusal does not consume the owner's lease.
- C4 rejects non-finite/non-positive/fractional timeouts before execution. The production adapter forwards timeoutMs and runId; foreground ProjectSandboxService honors a shorter timeout while retaining the existing command-class ceiling.
- C5a production policy wrapper reloads human Company membership on every tool call. A downgrade/revocation/failed lookup removes permissions immediately; current membership never widens the original token. Agent capability groups receive the restricted context; service identities keep their separate invariants.
- C2 native file reads preserve the raw Workspace byte size through decoding/truncation. PNG and invalid UTF-8 metadata no longer report re-encoded replacement-character sizes. A file over the unchanged1MiB Workspace limit retains file_too_large/413/retryable:false instead of generic tool_failed/500/retryable:true.
- C2 actual ripgrep searches now use --no-require-git in both production and fallback adapters. Git-free Sandbox projections previously returned ignored files despite .gitignore; independent native glob/type/regex/context/mode tests reproduced that leak and confirm the fix.
- C14 documentation distinguishes shared supervisor containment from legacy per-container settings, corrects queue defaults versus hard ceilings, and replaces a temporary artifact-based model-check command with tracked Vitest tooling.

The concrete regressions exercise real production wrapper/adapter code. Native binary tests use real disposable files and verify raw hashes, metadata-only output and unchanged bytes after oversized-read refusal. Earlier failed diagnostic artifacts are retained; the first oversized-file fixture incorrectly expected success past the canonical1MiB limit. The corrected criterion requires a413 denial and unchanged bytes, rather than increasing that limit.

## Individual review evidence

Artifacts live under artifacts/coding-agent-plan-closure-2026-10-17/.

| Review file | Requirement IDs covered |
| --- | --- |
| plan-wide-individual-review.json | 194: C4/C4a/C5/C5a/C5b/C6 |
| plan-recovery-context-review.json | 55: C6a/C7/C8 |
| plan-session-hooks-review.json | 32: C10/C13/C14 |
| plan-g1-review.json | 116: every formerly unverified G1 clause |
| plan-c2-review.json | 45: every remaining Partial/Not Verified C2 clause |

Every row preserves the source ID, prior/final status, implementation, exact named passing assertions, observation and remaining obligation. Prior source-wide certifications were not blindly reattached: sixteen unrelated changed Verified contracts were revalidated by their current exact assertions after C4 changes. C2 changes received34 further exact-assertion recertification actions. Together the two source-drift batches cover47 unique Verified contracts in50 actions, with no silent source-only restoration.

## Confirmed gaps

- Shared cleanup ownership, stale API generation fencing, legacy fork races and mutation-path TOCTOU remain open in C3.
- Shell explicit cwd/env persistence is not arbitrary command-side shell-state persistence. Provider head-only output collection does not establish end-to-end head+tail retention.
- Ordinary shared run release intentionally retains project processes; automatic session-scoped background cleanup is not universally certified.
- Optional whole-task atomic rollback is absent: C6a.L0702.05, C6a.L0702.06 and C6a.L0718.02. Journaled patch rollback is separate; a destructive automatic Git reset was not added as a substitute.
- Full authenticated UI/import/Changes/reconnect/provider/Preview acceptance is not established by generic archive, cursor or suite-list assertions.
- G1 owner risk acceptance remains OWNER_PENDING with a proposed, unconfirmed expiry. G1.L0814.03, G1.L0814.05 and G1.L0819.01 are blocked on genuine owner decisions and completion of technical gates. No owner or signature was invented.
- Automatic CI is owner-disabled. Four image build/scan/sign/publication blockers remain; local gate PASS is not merge/release enforcement or image admission.

## Actual execution and limits

Final frozen-source plan-accept- command receipts all exit0 (API/test types, root build, lint, full security gate). Gate183 suites/2779 passed/0 failed/0 skipped. Linux55/55 and shared supervisor15/15 pass; PostgreSQL suites and official DB gate each pass9/9. Matrix totals: 2057 Verified, 664 Partial, 5 Broken, 17 Missing, 210 Not Verified, 7 Blocked, 0 Unassessed.442 unique requirements rechecked;47 unique unchanged contracts recertified in50 actions. All903 open obligations and29 priority Broken/Missing/Blocked records are saved.

Docker was unavailable at the initial checkpoint, then became available again. The latest full real Linux run passes55 Workspace/Terminal checks, including the new binary and discovery assertions; the shared-supervisor fixture passes15. The earlier53/54-check receipts are historical. These are actual owned containers with the existing security profiles, not image admission or autonomous live-model acceptance.

Discovery diagnostics retain the initial fixture conflict when creating an already existing .gitignore and the actual ignored-file leak before repair. The fixture now updates .gitignore using its current revision. A full fixture run timed out under concurrent host load; the isolated case and the full55-case serial run subsequently passed under the unchanged60-second deadline. No failed attempt is counted as a pass.

A disposable pgvector PostgreSQL17 instance uses an internal Docker network, read-only root, dropped capabilities and temporary data. Docker supplied no published binding on that internal network; that failed prerequisite is retained. The successful fixture uses a loopback-only Node stream bridge through docker exec into the same owned database, without publishing Docker ports or allowing external egress. It inherits no production database URL or credentials. Exact labeled container/network cleanup is recorded.

Actual PostgreSQL suites and the official DB gate each pass9 tests across3 suites, including application-role audit UPDATE/DELETE refusal with negative controls, raw mutation detection, concurrent append integrity, inbox/store restart, and same-chat-session website source edits. The website scenario uses a scripted model and DB-only transport: no real model quality, install/build, Browser QA or Live Preview claim follows from it.

The Windows host is Node22.13.1, below the supported repository floor22.22.2. Linux OS behavior is reported separately. Final build/type/lint results do not remove that host-support limitation.

## Resume checkpoint

The audit is incomplete. The matrix, open-obligations.json and resume-state.json remain the authoritative next-work register. No mandatory unresolved clause is called Verified merely because the overall gate passes.

## Current stage ledger

| Stage | Total | Verified | Partial | Broken | Missing | Not Verified | Blocked | Unassessed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GLOBAL | 699 | 279 | 252 | 0 | 1 | 167 | 0 | 0 |
| C0 | 188 | 183 | 0 | 0 | 0 | 5 | 0 | 0 |
| C1 | 100 | 86 | 0 | 0 | 0 | 14 | 0 | 0 |
| C1c | 82 | 74 | 0 | 0 | 1 | 7 | 0 | 0 |
| C1a | 150 | 51 | 86 | 0 | 2 | 11 | 0 | 0 |
| C1b | 70 | 26 | 35 | 2 | 1 | 2 | 4 | 0 |
| C2 | 58 | 38 | 20 | 0 | 0 | 0 | 0 | 0 |
| C3 | 72 | 62 | 3 | 3 | 1 | 3 | 0 | 0 |
| C4 | 112 | 89 | 23 | 0 | 0 | 0 | 0 | 0 |
| C4a | 92 | 85 | 5 | 0 | 2 | 0 | 0 | 0 |
| C4b | 85 | 85 | 0 | 0 | 0 | 0 | 0 | 0 |
| C5 | 68 | 63 | 1 | 0 | 4 | 0 | 0 | 0 |
| C5a | 117 | 60 | 55 | 0 | 2 | 0 | 0 | 0 |
| C5b | 84 | 82 | 2 | 0 | 0 | 0 | 0 | 0 |
| C6 | 99 | 65 | 34 | 0 | 0 | 0 | 0 | 0 |
| C6a | 113 | 90 | 20 | 0 | 3 | 0 | 0 | 0 |
| C6b | 84 | 84 | 0 | 0 | 0 | 0 | 0 | 0 |
| C7 | 66 | 50 | 16 | 0 | 0 | 0 | 0 | 0 |
| G1 | 145 | 56 | 85 | 0 | 0 | 1 | 3 | 0 |
| R1 | 140 | 140 | 0 | 0 | 0 | 0 | 0 | 0 |
| C8 | 42 | 38 | 4 | 0 | 0 | 0 | 0 | 0 |
| C9 | 48 | 48 | 0 | 0 | 0 | 0 | 0 | 0 |
| C10 | 44 | 30 | 14 | 0 | 0 | 0 | 0 | 0 |
| C11 | 48 | 48 | 0 | 0 | 0 | 0 | 0 | 0 |
| C12 | 42 | 42 | 0 | 0 | 0 | 0 | 0 | 0 |
| C13 | 35 | 31 | 4 | 0 | 0 | 0 | 0 | 0 |
| C14 | 54 | 49 | 5 | 0 | 0 | 0 | 0 | 0 |
| C15 | 23 | 23 | 0 | 0 | 0 | 0 | 0 | 0 |

Remaining Not Verified distribution: {"GLOBAL":167,"C0":5,"C1":14,"C1c":7,"C1a":11,"C1b":2,"C3":3,"G1":1}. Next C1.L0244.01. These records are assessed but lack complete proof; they are not Passed. All2960 original source IDs remain unchanged.
