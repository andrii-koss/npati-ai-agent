# Individual PLAN verification checkpoint — 2026-10-17

The requested full audit is incomplete. PLAN.md was read in full. This continuation independently reassessed C1a, C1b and C2, repaired confirmed defects, and preserved the earlier assessment records without treating a broad green gate as proof of every requirement.

Source: [PLAN.md](PLAN.md). Full ledger: [matrix](plan-verification-matrix.md), [JSON matrix](plan-verification-matrix.json), [evidence](plan-verification-evidence.json).

## Coverage and provenance

The inventory contains 27 stages, 660 source statements, 37 acceptance statements and 2811 addressable source-clause checks. These are source occurrences with their full original context, not 2811 separate E2E cases. Repeated requirements remain individually addressable.

There are 2261 recorded assessments, including earlier work; 550 global requirements still have no individual assessment. This continuation independently reassessed 278 entries. Inherited assessments are not a claim of a fresh independent review. Changed Verified source fingerprints are left Not Verified until their exact contract is checked again.

| Status | Count |
| --- | ---: |
| Verified | 1840 |
| Partial | 140 |
| Broken | 2 |
| Missing | 12 |
| Not Verified | 813 |
| Blocked | 4 |
| Total | 2811 |

| Independently reassessed stage | Entries | Verified | Partial | Broken | Missing | Not Verified | Blocked |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C1a | 150 | 58 | 86 | 0 | 2 | 4 | 0 |
| C1b | 70 | 26 | 35 | 2 | 1 | 2 | 4 |
| C2 | 58 | 36 | 19 | 0 | 0 | 3 | 0 |
| Total | 278 | 120 | 140 | 2 | 3 | 9 | 4 |

No whole stage is certified complete. C1 and C1c have additional fresh PostgreSQL regression evidence, but their entire earlier ledgers were not recertified by one DB run.

## Confirmed repairs in this continuation

### C1a: interruption, durable state and continuation

| Problem | Change | Evidence |
| --- | --- | --- |
| Kill-switch abort during a resolving/rejecting provider call became user cancellation | Route both signal paths through suspendByFlag; do not dispatch returned calls | C1a-signal-before.json; C1a-session-resume-fixed.json |
| PostgreSQL release retained lease_owner | Clear the owner only when the releasing owner matches, in both existing SQL repositories | independent-C1-postgres/postgres-current.json (red); independent-postgres-regression/postgres-current.json (green) |
| Resume retained finishedAt | Clear the finish timestamp when the run becomes running | C1a-resume-before.json; real SQL suspension/resume case |
| HTTP resume left the session suspended after the run resumed | Relink the existing run and activate the owned session | C1a-session-resume-before.json; C1a-session-resume-fixed.json |
| Disabled resume flag produced generic500 | Preserve typed feature_disabled as403, before taking a lease | Same real-application HTTP regression |
| Shared/UI status types could not represent flag suspension | Carry suspended_by_flag through background/shared types and display a settled pause | Backend regressions and the targeted frontend suspension report |

Migration091 is additive and was exercised on fresh disposable PostgreSQL. It was not applied to production. Earlier initial-insert manifest and audit-chain fixes remain documented in the preceding audit artifacts.

### C1b: image admission and publication controls

- Refuse CRITICAL findings even with a waiver; require a complete unexpired HIGH waiver.
- Reject future scan timestamps, invalid vulnerability counters and absent SBOM metadata.
- Enforce company ownership before allow/revoke/scan/admission-check dispatch.
- Fail closed when development flag resolution is absent or unverified status cannot be stored.
- Refuse nonzero scanner exits and malformed/unknown scan reports instead of deriving zero findings.
- Apply the scan policy before signing; do not resurrect revoked images.
- Refuse a missing built-base digest instead of substituting the upstream digest.
- Clear predecessor scan/SBOM metadata on a new build.
- Keep an existing pin when rollout is enabled; distinguish explicit new-session selection.

Evidence: C1b-independent-before.json, C1b-pin-before.json, C1b-dev-before.json and C1b-independent-final.json. The final targeted report has 51 passed, no failures/skips. Publication CLI tests execute real script control flow with explicitly simulated external-tool ports; they do not claim a real Trivy, cosign or registry publication.

### C2: canonical adapters, secrets and real filesystem behavior

- Forward grep glob/type/case/fixed/context options across the canonical adapter.
- Preserve full-file hash and revision after a byte-truncated read.
- Redact complete and byte-truncated private-key blocks before slicing lines, preserving line numbers.
- Omit sensitive grep paths and redact known provider-shaped secrets in ordinary matches.
- Quote the search target as one shell argument in both execution paths.
- Parse rg JSON context records, preserve nested globs and reject execution failures.
- Use structured runtime output budgets with head/tail data, refinement hints and envelope overhead.
- Fix root-anchored and directory-only ignore rules.
- Carry actual filesystem mtimes through the read port while keeping content revisions independent of touch.
- Detect binary/image magic before lossy UTF-8 decoding, and carry metadata through the actual Workspace and runtime.

Red artifacts: C2-independent-before.json, C2-search-secret-before.json, C2-runtime-budget-before.json, C2-ignore-before.json, C2-mtime-before.json, C2-binary-before.json. Passing evidence: C2-C3-independent-final.json. The latest combined targeted report has 178 passed across10 suites, including adjacent write and evidence-retention regressions. Its History export case is additionally rerun with HTTP kill/re-enable/resume in the64-test C1a follow-up.

## Actual environment and open high-priority gaps

Docker is now available. The old missing-engine blocker is historical and must not be repeated as the current state.

A new disposable PostgreSQL run executed6 suites: 19 passed,0 failed,0 skipped. Migration checks include populated-schema coverage, audit application-role restrictions, async inbox/lifecycle regressions and the new owner-checked suspension/resume round trip. Every owned DB container was removed; no existing service/data was changed.

Read-only inspection of the existing shared supervisor confirms a read-only rootfs, no Docker socket mount, Privileged=false, resource limits and a seccomp filter. The supervisor itself runs root with management capabilities. That does not prove the effective UID/capabilities of each project process.

The installation still uses ONE shared sandbox, with separate /projects/<projectId> folders, process identities and ports. It was not converted to per-project containers or redeployed.

Open mandatory C1b gaps:

- C1b.L0351.01 and C1b.L0366.01 remain Broken: the shared supervisor is locally named, and its startup does not use equivalent signed-image/scan admission.
- C1b.L0351.04 remains Missing: no durable admitted image digest is stored on CodeSession.
- The catalog/SBOM files are explicit placeholders, not evidence of a real signed/scanned production release.
- Existing owner-disabled remote Actions schedules/build publication remain Blocked. No paid workflow or production rollout was started.

C2 remains Partial for nested ignore semantics, recursive glob discovery, complete count-mode semantics, charset support, actual ctags execution, all tenancy/race boundaries and normal-Run acceptance with a real sandbox search. These are named per leaf rather than concealed behind helper tests.

## Validation

Artifacts: [continuation directory](../../artifacts/coding-agent-plan-verification-2026-10-17/).

| Check | Result |
| --- | --- |
| Fixed security gate | 180 suites; 2667 passed,0 failed,0 skipped,0 todo |
| Real disposable PostgreSQL regression | 6 suites;19 passed,0 failed,0 skipped; owned container cleanup passed |
| C1a resume/stop regressions | 4 suites;64 passed |
| C1b admission/publication regressions | 2 suites;51 passed; scanner/signature ports explicitly simulated |
| C2 and adjacent regressions | 10 suites;178 passed |
| Workspace typecheck | Passed across14 workspaces |
| Expanded test typecheck | Final repeat pending after adding the evidence helper declaration |
| Targeted UI suspension/reload checks | Pending |
| Root build and lint | Pending |
| Diff whitespace check | Passed |
| New broad autonomous E2E | Not run; main-plan individual verification remains the priority |

One earlier expanded gate failed its cold dynamic application import path. The isolated repeat passed in11.8s; the application import was moved to collection without changing the40s test timeout or its assertions, and the full180-suite repeat passed. The gate now preserves exact assertion names/statuses/durations without payload/error contents. A subsequent type declaration/null-input hardening of this evidence helper is validated by its targeted checks.

The requirement generator caches repeated evidence reads only within one generation and checks file stamps before/after verification. Default standalone validation still rejects stale hashes. The informational PLAN footer was rebased with unchanged requirement IDs, source clauses and total2811; no requirement was marked complete by changing PLAN text.

Host Node22.13.1 remains below package.json's declared22.22.2 floor. Successful checks on this host are recorded without claiming the supported-version release gate.

## Resume point

Finish the pending verification commands and refresh their evidence. Then continue the independent audit at C3 in PLAN source order. Retain prior assessment artifacts; recheck exact source/test correspondence rather than automatically restoring changed Verified hashes. Continue through every remaining stage and the550 unassessed global clauses before the separate broad E2E campaign.
