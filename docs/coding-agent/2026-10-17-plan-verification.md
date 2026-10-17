# Individual PLAN verification checkpoint — 2026-10-17

The full requested audit is incomplete. The source requirement document was read in full before implementation inspection. Current stage progress must not be confused with certification of runtime acceptance.

Source: [PLAN.md](PLAN.md). Complete addressable ledger: [verification matrix](plan-verification-matrix.md), [machine-readable matrix](plan-verification-matrix.json), [individual evidence](plan-verification-evidence.json).

## Counting and coverage

The inventory identifies27 stages,660 source statements and37 acceptance statements. The2811 addressable checks are source occurrences split at top-level independent clauses; repeated requirements remain separate. This is a transparent counting rule, not2811 independent E2E scenarios. Every leaf retains its complete original statement and source line. Unassessed entries remain Not Verified.

| Stage | Individually assessed | Verified | Partial | Broken | Missing | Not Verified | Blocked |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C0 |188|32|151|0|0|5|0|
| C1 |100|66|23|0|0|1|10|
| C1c |82|38|35|0|1|0|8|
| C1a |150|57|86|1|2|4|0|
| All other requirements |0|0|0|0|0|2291|0|
| Total |520|193|295|1|3|2301|18|

C0 assessments distinguish historical research coverage from present runtime behavior. No entire C0 topic is certified from an old report. C1/C1c/C1a Partial entries explicitly identify their unproven downstream integration boundaries.

## Real changes and regression evidence

C1 fixes:
1. Forward classification, retention, branch and toolchain through ProjectService instead of silently dropping metadata.
2. Record the project audit decision before creating project/backend state.
3. Pin the session manifest in its original insert, avoiding a fallible second update.
4. Reject a real foreign-company agent in the in-memory session store.
5. Detect Makefile typecheck targets.
6. Load the Python test-package marker through the actual manifest reader.
7. Do not mistake unrelated setup.cfg content for pytest configuration.
8. Redact credential-bearing repository import errors before HTTP output.
9. Honor empty but valid Python package markers and requirements manifests.
10. Preserve prior manual verification metadata on manifest I/O failures.
11. Select the available company in Settings when no prior choice is saved.

The inventory of12 individual defects separates the two empty-manifest cases. Exact cases and files are in C1-inspection.json and the ledger. Regression evidence includes C1-regressions-before.json, C1-detection-edge-before.json, C1-read-error-before.json, C1-ui-before.json and their passing follow-ups.

C1c fixes:
- Compare anchors with their own prefix rather than a later current head.
- Verify non-genesis ranges through their predecessor prefix.
- Never clear a known full-chain block from a clean selected range.
- Preserve the first daily external anchor.
- Verify external signed files in API and background checks.
- Verify database anchors in background checks.
- Report configured external-anchor write failures.
- Detect anchored companies whose entire journal has been deleted.
- Reject a rewritten chain with no genesis sequence1.
- Preserve an already canonical approval payload hash instead of hashing it twice.
- Resolve actual membership/principal roles in privileged adapters instead of recording everyone as owner.
- Preserve safe exclusive file writes while supporting identical signed-file retry after a DB insert failure.
- Normalize PostgreSQL bigint anchor fields to numbers; this last SQL change has a new DB test but remains blocked from real execution.

C1a fixes so far:
- Include actual allowlist values in the action hash.
- Immediately refuse effective cached access after a known audit-chain break.
- Audit global kill against a real company and suspend/clean up affected accessible companies.
- Recheck flags around model exchanges and reject returned calls after disablement.
- Reject malformed persisted schema versions and inherited format names.
- Return structured400 for unsupported API versions instead of generic500.
- Resolve all Inspector sub-flags and expose canonical tool versions with the existing UI badge style.
- Allow History export after master shutdown while retaining authorization and secret scanning.
- Honor pinned manifest schemas/tool sets and pass the pinned toolVersion to execution.
- Request local controller cancellation and lease revocation from kill cleanup.

The durable Run suspended_by_flag state is the current open defect and active implementation item. Deprecated executor coexistence, distributed kill timing, exact global event coverage and real browser behavior remain Partial where appropriate.

## Validation boundary

Artifacts: [current verification directory](../../artifacts/coding-agent-plan-verification-2026-10-17/).

- Targeted service/store/HTTP tests and the Settings React DOM regression have passing artifacts.
- The new exact requirement matrix has integrity tests and refuses stale Verified source hashes or unmatched test assertions.
- First full security gate:177 suites,2565 passed,1 failed,0 skipped. The failure was an existing forbidden any-cast in terminal wiring; the cast was repaired without changing behavior.
- The fixed gate now also includes both published-schema/versioning suites, making179 suites. The final repeat is still pending.
- An earlier complete workspace typecheck passed. Newly modified paths and test types require their final repeat after the active changes.
- The attempted isolated PostgreSQL check could not start: Docker Desktop Linux engine pipe is missing. This is not a passed or simulated DB check.
- New PostgreSQL tests cover original-insert manifest pinning and numeric anchor/range round trips; they remain unexecuted.
- No broad standalone E2E campaign has been started.
- Production infrastructure, secrets, working data and existing services were not changed.
- This installation retains ONE shared sandbox with separate project folders/processes/ports.

## Resume point

Finish the durable flag-suspension state, rerun affected tests/typechecks/lint/security gate, refresh evidence hashes, then continue to C1b in PLAN source order. Do not mark the remaining2291 unassessed requirements as reviewed merely because the generic test gate passes.
