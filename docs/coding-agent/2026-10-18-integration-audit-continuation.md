# Coding Agent integration continuation — 2026-10-18

The audit remains incomplete. Continue the existing Verification Matrix; the current PLAN includes2960 source occurrences. The original2884 clauses are unchanged; integration-6 appended76 clauses (all IDs and source lines are in [the additions register](2026-10-18-plan-integration-additions.md)). This is separate from the earlier2811→2884 reconciliation.

## Confirmed defects repaired

| Problem | Correction | Evidence |
| --- | --- | --- |
| Project media authorization accessed a projectId field absent from AuthContext, breaking current API typecheck | Structural narrowing preserves optional trusted-provider scope refusal; existing ProjectService ownership lookup remains authoritative | media-authorization-fixed.json:20 passed, including actual Fastify injected foreign-company/project/ownership refusals |
| Media purge swallowed storage deletion failures and counted undeleted objects as removed | Storage errors propagate; counters advance only after successful deletion | purge-failure-before.json reproduces the failure; purge-failure-fixed.json checks rejection, retry and neighboring object preservation |
| Hard purge swallowed cleanup failures, removed project metadata and returned purged | Failed configured cleanup steps return503 cleanup_incomplete with safe step names; project remains purging for retry; state-write failures stop before cleanup | Same red/green artifacts; actual InMemoryWorkspaceStore lifecycle, injected storage/Sandbox ports |
| Authorization/storage lookup failure was misreported as already purged | Only WorkspaceNotFoundError is treated as absence | Exact failed-authorization regression passes |
| A restarted retention worker skipped interrupted purging projects | In-memory and PostgreSQL scans include due soft_deleted/purging states; an existing purging row skips the initial transition | purge-worker-restart-before.json is red; new service instance retry is green. Current real PostgreSQL execution remains unverified |
| Current gate report retained181 after adding a required purge suite | Current-size claims now track183 after adding both purge and media security suites; historical run counts/guard criteria preserved | purge-gate-size-fixed.json and post-media-security-gate-tests.json; failed evidence retained |
| Retained directories bypassed deleted-project media visibility; filesystem resolution skipped authoritative metadata | Always recheck state through the existing project store before streaming; deny soft-deleted/purging/missing state, fail closed on state outage, and use no-store against cached revocation bypass | media-state-before.json reproduces4 false200 responses; media-state-fixed.json passes actual temporary-directory/Fastify403/404/503, exact binary bytes and SVG CSP cases |

## Verification scope

Artifacts are under artifacts/coding-agent-plan-closure-2026-10-17/. The47-case purge regression run passes. Current API and test typechecks and lint/size guards pass. Root npm run build passes after cleanup changes; an additional API bundle build passes after the final media-state guard. The final expanded gate passes183 suites/2737 assertions/0 failures/0 skips; the first182-suite run failed only stale size-documentation claims (2725 passed/2 failed), and that failure is preserved. Current integration-source-coverage-checks.json passes108 assertions, media-state-fixed.json passes68, and final-source-matrix-checks.json passes21. Test typecheck also passes after the final POSIX fixture extension.

The new tests execute local services, real Fastify injection, and the in-memory store with injected object-storage/namespace ports. They are not provider/MinIO/PostgreSQL/browser E2E. Docker later became available: the existing disposable Linux C3 fixture passes17/17 actual file/Git checks as UID10001 with no network/capabilities/production mounts. Both0755/0640 edits and failed-delete recreation preserve mode/bytes; two permissions clauses are now Verified. This is an actual Linux container execution, not shared-supervisor/admitted-image certification. No production service, secret, protected working project or infrastructure setting was changed.

## Additional limits discovered

- The report docs/integration/stage-6-final-report.md explicitly distinguishes actual HTML/CSS/JS/Node execution from blocked Next.js next build. The PLAN's broader historical Next.js claim cannot inherit a PASS from it.
- The referenced scratch/run-stage-6-consolidated-suite.cjs and named preview screenshots are absent from the current tree. A prose10/10 claim is insufficient independent proof.
- PLAN's new media prefix websites/company/project differs from the existing company/project prefix and the earlier retention appendix. A storage migration must preserve existing objects; this audit does not silently rename production keys.
- Project Auth currently tests memory-hard scrypt; the new appendix names Argon2id/Bcrypt. Existing password hashes were not replaced or weakened to satisfy a wording mismatch.
- Remaining concerns include absent cleanup ports, lifecycle journal durability, cross-tenant worker context, concurrent purge/restore fencing and current real namespace/DB recovery. The bounded fixes above do not certify all of those obligations.
- C3 is62 Verified /3 Partial /3 Broken /1 Missing /3 Not Verified. Ten obsolete offline-only blockers are now Not Verified, not falsely promoted; four owner-disabled image-publication CI blockers remain. Unconditional multi-file rollback, protected Activity diffs and current shared hooks/path-race acceptance remain open.

## Saved source-coverage checkpoint

All2960 source clauses now have individual assessments; Unassessed=0. Current disjoint totals: 1910 Verified, 396 Partial, 5 Broken, 14 Missing, 631 Not Verified, 4 Blocked, 0 Unassessed. Independently reassessed in this continuation series: 1055; inherited assessments are explicitly retained as history rather than claimed as newly retested. This is complete classification, not completion of actual behavioral verification or release readiness.

All1050 non-Verified records, exact reasons, implementation paths and next checks are exported in artifacts/coding-agent-plan-closure-2026-10-17/open-obligations.json and remain individually visible in the matrix. Next priority: C3.L0412.02/C3.L0412.03/C3.L0427.02 writer-fenced multi-file rollback; then remaining mandatory live/shared-runtime and actual DB/provider/browser evidence.

Current frontend unit/DOM regressions also pass: 29 files /185 assertions /0 failures (current-web-regressions.json). This is not actual browser QA of a generated application.

## Latest continuation: coordinated C3 patch recovery

The new [C3 transaction implementation and limits](2026-10-18-c3-transaction-recovery.md) supersedes the earlier description of sequential compensation. Native Workspace patches now preflight the complete read set, hold the existing cross-process lease, persist a protected bounded intent journal, apply atomic per-file saves and restore all participating file changes after an error. Interrupted recovery keeps its journal and blocks further sanctioned access until it can succeed. Runtime receipt tracking, ordinary permissions and metadata-only Activity remain intact.

Actual isolated Linux checks now pass31/31, including three actual child process exits inside the Workspace lease (staging, first replacement, second replacement), recovery through a fresh service after expiry of only the disposable crashed lease, BOM/CRLF bytes,0755/0640 modes, delete/new-file compensation, stale revisions, foreign paths, idempotent replay and native nonretryable diagnostics. This is not an admitted shared-supervisor, provider or browser certification. No production service was changed.

C3-journal-recertification-final.json passes259 assertions across12 files;96 existing Verified records are revalidated against their exact current assertions. C3-native-diagnosis-matrix-final.json adds32 passing native/individual-matrix assertions, including the final metadata/diagnosis negative. C3-final-security-gate.json passes183 suites/2747 assertions/0 failures/0 skips; it predates that last added test case, which passes in the later targeted and Linux runs. API bundle, API/test typechecks, lint, XSS and source-size guards pass.

A later Activity test initially falsely matched the legitimate dataClassification value confidential. C3-native-diagnosis-localized.json shows only normal metadata. Exact injected peer-content and storage-error markers are absent; the corrected test does not remove or weaken the Activity policy. Both failed and successful evidence are retained.

No status promotions were made. Totals remain2960 =1910 Verified +396 Partial +5 Broken +14 Missing +631 Not Verified +4 Blocked +0 Unassessed. All source clauses are classified; only1055 have independent continuation reassessments, and classification is not completion of behavioral verification. Each stage's counts remain in the progress table.

The exact5 Broken/14 Missing and4 Blocked source IDs, dependencies and next checks are in artifacts/coding-agent-plan-closure-2026-10-17/C3-priority-open-register.json. The complete1050 non-Verified list is in open-obligations.json.

Remaining Broken:
- C1b.L0351.01 and C1b.L0366.01: actual single shared supervisor still lacks trusted deployment-level digest/signature/scan admission. Shared runtime readiness currently asserts image readiness without attesting the actual running image. Existing isolated image catalog checks do not fix that path.
- C3.L0412.02, C3.L0412.03 and C3.L0427.02: a direct filesystem/Terminal peer still bypasses the Workspace lease. The new real regression preserves that peer's bytes and fails closed; it does not satisfy unconditional all-or-none wording. Shared upload/copy-back, Git, Terminal and API writers need one fencing protocol. Existing lease-expiry behavior also requires fencing against an expired writer resuming.

Mandatory Missing:
- C1b.L0351.04: admitted shared-supervisor image identity persisted into session and ExecutionSnapshot.
- C3.L0417.04: protected redacted diff artifact plus authorized Activity reference/retrieval. The metadata-only sink is deliberately unchanged.
- GLOBAL.L1185.01: the exact named stage-6 consolidated runner and reproducible10/10 raw evidence.
The other11 Missing clauses retain their optional/TODO scope; they are not removed from the denominator.

Blocked conditions:
- C1b.L0350.07: authorize CI image build (manual dispatch or explicit changed trigger decision), provide runner/registry/signing access, retain build/scan/SBOM/digest evidence.
- C1b.L0353.02: authorize scheduled rescanning of existing pinned images; retain the separate no-rebuild rescan job and fresh scan outputs.
- C1b.L0354.03: authorize official CI image publication/signing and verify expected signer, scan, SBOM and immutable digest.
- C1b.L0356.01: authorize scheduled rebuild/sign/scan/publication and a safe digest rollout.
These depend on the explicit owner-disabled automatic Actions decision in .github/workflows/sandbox-images.yml lines10-20 and ci.yml lines3-5. No workflow, publication, secret or production deployment was changed.

Next checkpoint remains C3.L0412.02: shared-writer fencing and admitted isolated shared-runtime acceptance. The journal implementation, phase-exact validation logs and remaining counterexamples are saved; do not restart the source inventory or rerun one-shot review transformations.


## Terminal / Workspace continuation — current saved boundary

The current implementation and exact guarantees are in [Terminal/Workspace coordination](2026-10-18-terminal-workspace-coordination.md). Earlier statements that all Terminal copy-back/Git paths lack a coordinator describe the pre-fix state. Managed returned writes now reuse the existing transaction; production Git shares the existing lease; Linux adds a kernel fence and immediate crashed-owner recovery. Durable cleanup-release errors are nonretryable and retain the primary diagnosis. The real isolated Linux49/49 and current gate183 suites/2754 assertions pass; API/test types, root build and lint pass. No production changes.

The complete2960 matrix remains 1910 Verified, 396 Partial, 5 Broken, 14 Missing, 631 Not Verified, 4 Blocked, 0 Unassessed. Actual admitted shared-supervisor surviving-process isolation, durable cleanup owner recovery and hostile unmanaged data-path races remain unresolved. C3 is not universally Verified and the full behavioral audit is incomplete. See [current progress](2026-10-18-plan-progress.md) and open-obligations.json for every unresolved clause.


## Final isolation continuation — latest boundary

See [current physical isolation proof and remaining work](2026-10-18-c3-final-isolation.md). Actual shared provider/launcher15/15 and Workspace Linux53/53 pass; gate2757 assertions passes. Earlier missing parent-death/observed-survivor barriers and pathname byte reads are repaired. Legacy cleanup ownership, stale API generations, hostile legacy fork races and mutation-path TOCTOU remain open; C3 status is not promoted. The full2960 matrix remains 1910 Verified, 396 Partial, 5 Broken, 14 Missing, 631 Not Verified, 4 Blocked, 0 Unassessed. No production change.


## PLAN-wide continuation — 2026-10-19

See [current report](2026-10-19-plan-wide-continuation.md).442 unique requirements across14 sections were rechecked; totals: 2057 Verified, 664 Partial, 5 Broken, 17 Missing, 210 Not Verified, 7 Blocked, 0 Unassessed. Current actual Linux55/55, shared15/15, PostgreSQL9/9 and gate2779 pass. These results supersede historical counts without claiming full audit completion or C3 universal atomicity.
