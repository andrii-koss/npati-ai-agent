# C3 independent verification continuation — 2026-10-17

The full PLAN audit is **incomplete**. This checkpoint independently reviews all 72 C3 clauses, fixes confirmed code defects and records remaining obligations. A general passing gate does not certify every clause.

## PLAN reconciliation and coverage

The current committed PLAN adds 73 clauses in its appended Stage 6 lifecycle/E2E section. All 2811 earlier clause IDs, source statements and obligations remain unchanged; none were removed. The new denominator is 2884 clauses across 27 stages and 696 source statements. The added clauses remain Not Verified. Evidence: C3-plan-additions-rebase.json.

The ledger has 2261 assessment records; 352 are marked independently reassessed in this continuation series (C1a, C1b, C2, C3, one C4 clause and the specifically failed C14 calibration clause). The 623 global clauses without assessments remain individually visible. Source changes invalidated inherited Verified fingerprints; those claims were downgraded instead of silently rehashed.

## Repairs and regression evidence

| ID | Confirmed defect | Repair | Evidence before / after |
| --- | --- | --- | --- |
| C3-F01 | Single string replacement interprets JavaScript replacement tokens and corrupts requested code | Shared literal replacement used by canonical edit, legacy patch edits and real Workspace edit | C3-literal-before.json: 11 failures across literal/EOL cases; C3-current-final.json |
| C3-F02 | LF replacement text introduces mixed newlines into a CRLF file | Normalize inserted text to the existing dominant convention while preserving BOM | Same regression reports; real filesystem BOM/CRLF assertion |
| C3-F03 | Atomic save replaces executable/group-readable files with mode0600 | Preserve ordinary existing permission bits on the temporary file before rename; do not copy privilege bits | C3-linux-mode-before.json; C3-linux-reproducible.json |
| C3-F04 | Move uses a fresh revision after checkpoint and can move a concurrently changed file | Pass the session tracker's revision to the authoritative move port | C3-concurrency-before.json: stale move/delete/patch all fail; C3-current-final.json |
| C3-F05 | Delete discards expectedRevision before reaching the actual filesystem | Carry the revision through canonical executor, runtime port, application wiring and Workspace; check under the write lock | Same concurrency reports plus real filesystem adapter stale-delete regression |
| C3-F06 | Canonical patch computes changes from a new read after the session freshness check | Validate planned targets against trusted session revisions before committing | Same checkpoint-time concurrency regression |
| C3-F07 | Conflicts on one file exhaust another file's budget | Key single-file retry counts by normalized file path | C3-retry-before.json; C3-current-final.json |
| C3-F08 | Successful writes do not reset conflict counters because increment/reset keys differ | Use the same path key for increment and successful-write reset | Same retry reports |

Code: code-text-format.ts, code-tools-write.ts, code-tool-executors-write.ts, code-tools-patch.ts, code-tool-runtime-write-guard.ts, project-workspace.ts and the existing canonical Workspace ports/wiring. No alternate editing engine or per-site sandbox was introduced.

New/updated tests: coding-agent-c3-write-engine.test.ts, coding-agent-c3-runtime.test.ts and project-terminal-integration.test.ts. The POSIX case is reproducible with:

    node scripts/coding-agent-workspace-posix-check.mjs --image <existing-local-node-image> --output artifacts/workspace-posix-check.json

This uses an exact inspected local image ID, UID10001, no network, a read-only rootfs and only the generated fixture directory mounted read-only. It does not mount project data, secrets or Docker socket. The owned UUID container and fixture directory are cleaned. The locally built test image is explicitly not certified for production admission. This is a real Linux filesystem functional check, not autonomous agent E2E.

## C3 limitations retained per clause

- Cross-file patch commit uses compensating rollback rather than transaction isolation. A real simulated commit failure restores prior writes; a concurrent edit is retained and returns rollbackIncomplete. Unconditional all-or-none behavior is not certified.
- Deleted-file mode restoration through the canonical rollback adapter remains unverified.
- Encoding preservation is limited to UTF-8/BOM; arbitrary encodings are not certified.
- Checkpoint/undo acceptance passes its specified runtime harness with fake checkpoint/filesystem ports. A real Git-backed full round trip is still required.
- Formatter/syntax wiring exists, but no real formatter command ran in this review.
- Turn diffs concatenate change records; net diff and unique file statistics after repeated edits remain unverified.
- Activity metadata omits secrets, but the required redacted diff body is not emitted by the inspected Activity event.
- Model preference resolver has no runtime caller found by repository search.
- Single-file retry isolation/reset is repaired. Batch per-file accounting and pre-dispatch enforcement after exhaustion remain open.
- Workspace path checks reject observed symlinks; all external-writer filesystem races are not certified.
- Complete real project/user substitution checks and approved secret-file writes remain unverified.

## Validation and release blockers

Artifacts are under artifacts/coding-agent-plan-verification-2026-10-17/.

- C3 targeted report: C3-current-final.json —106 passed,0 failed,0 skipped across5 files. Final combined C3/adjacent/matrix-integrity check:163 passed across10 files (C3-final-targeted.json).
- Real Linux permission report: C3-linux-reproducible.json; modes0755,0640,0700 survive both write and edit.
- API, frontend and expanded test typechecks passed after C3/adjacent changes. API/test repeats after the C4 environment-name repair are recorded in C4-final-*-typecheck.json.
- Prior UI checks:46 passed; audit evidence integrity:14 passed. These belong to the preceding checkpoint.
- Initial lint failed on existing unregistered as-any casts in media/lifecycle. Replace them with explicit structural types and runtime narrowing; existing media/lifecycle tests pass. Root lint, XSS and source-size guards now pass without baseline changes. Lifecycle SQL was extracted verbatim to postgres-project-lifecycle-repository.ts and re-exported; SQL behavior is unchanged.
- The host Node22.13.1 is below the declared supported minimum22.22.2.
- First full security gate after C3:2686 passed,4 failed,0 skipped. Retained in C3-security-gate-before-lint-fix.json and its exact assertion evidence. Three failures were repaired with targeted verification: lint casts, hand-built file URLs in extracted website cards, and a source guard inspecting the old component location. The source guard still requires the real card code link and adapter; no exemption was added. The eval/SLO mismatch remains reproducibly failed: measured10 steps times4 proposes40, shipped default60. This is Broken at C14.L1012.06; four inherited claims citing that failed assertion are Not Verified. No default or assertion was weakened to hide the mismatch.
- Root build passed (C3-final-build-command.json/log); the API bundle was rebuilt successfully after the last C4 change. Existing frontend bundle-size/browser-external warnings remain limitations.
- Final repeated fixed security gate:180 suites,2694 passed,1 failed,0 skipped,0 todo. Its only failure is the preserved SLO40/60 mismatch. All6 environment-name regressions passed inside this full gate. Exact evidence: C3-final-security-gate.json and C3-final-security-gate-tests.json. The gate remains FAILED.
- No new broad autonomous E2E campaign, production change, signed-image release or deployment was performed. All websites still use ONE shared sandbox with separate project folders/process identities/ports.

## First C4 security repair

C4.L0446.01 remains Partial. Six malformed environment identifiers were forwarded into shell export syntax. The canonical shell runtime now requires POSIX identifiers and string values before dispatch or session persistence. Before:16 passed/6 failed. After:58 passed/0 failed/0 skipped across4 related suites. Actual command execution is simulated at the sandbox port; no host exploit was attempted. See C4-start-inspection.json and C4-environment-name-fixed.json. The runtime implementation and C4 PLAN section were read fully; classifier and lease internals still need full independent inspection. The full C4 stage is not certified.

## Resume point

Continue at C4 in PLAN order. Its shell runtime and current clauses were read; the environment-name defect above was repaired. Remaining C4 clauses still need independent assessment. Continue through remaining stage clauses and the623 unassessed global clauses, including all73 newly appended obligations, before the separate broad E2E campaign.

## Current ledger totals

- Verified: 1648
- Partial: 166
- Broken: 3
- Missing: 12
- Not Verified: 1051
- Blocked: 4

Total: 2884. These are individual statuses, not a declaration of completed audit.

| Stage | Clauses | Verified | Partial | Broken | Missing | Not Verified | Blocked |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GLOBAL | 623 | 0 | 0 | 0 | 0 | 623 | 0 |
| C0 | 188 | 183 | 0 | 0 | 0 | 5 | 0 |
| C1 | 100 | 86 | 0 | 0 | 0 | 14 | 0 |
| C1c | 82 | 74 | 0 | 0 | 1 | 7 | 0 |
| C1a | 150 | 52 | 86 | 0 | 2 | 10 | 0 |
| C1b | 70 | 26 | 35 | 2 | 1 | 2 | 4 |
| C2 | 58 | 24 | 19 | 0 | 0 | 15 | 0 |
| C3 | 72 | 47 | 25 | 0 | 0 | 0 | 0 |
| C4 | 112 | 80 | 1 | 0 | 0 | 31 | 0 |
| C4a | 92 | 85 | 0 | 0 | 2 | 5 | 0 |
| C4b | 85 | 85 | 0 | 0 | 0 | 0 | 0 |
| C5 | 68 | 63 | 0 | 0 | 4 | 1 | 0 |
| C5a | 117 | 28 | 0 | 0 | 2 | 87 | 0 |
| C5b | 84 | 82 | 0 | 0 | 0 | 2 | 0 |
| C6 | 99 | 38 | 0 | 0 | 0 | 61 | 0 |
| C6a | 113 | 87 | 0 | 0 | 0 | 26 | 0 |
| C6b | 84 | 84 | 0 | 0 | 0 | 0 | 0 |
| C7 | 66 | 50 | 0 | 0 | 0 | 16 | 0 |
| G1 | 145 | 29 | 0 | 0 | 0 | 116 | 0 |
| R1 | 140 | 140 | 0 | 0 | 0 | 0 | 0 |
| C8 | 42 | 33 | 0 | 0 | 0 | 9 | 0 |
| C9 | 48 | 48 | 0 | 0 | 0 | 0 | 0 |
| C10 | 44 | 30 | 0 | 0 | 0 | 14 | 0 |
| C11 | 48 | 48 | 0 | 0 | 0 | 0 | 0 |
| C12 | 42 | 42 | 0 | 0 | 0 | 0 | 0 |
| C13 | 35 | 35 | 0 | 0 | 0 | 0 | 0 |
| C14 | 54 | 46 | 0 | 1 | 0 | 7 | 0 |
| C15 | 23 | 23 | 0 | 0 | 0 | 0 | 0 |
