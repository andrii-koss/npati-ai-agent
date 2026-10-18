# C3 coordinated transaction and worker recovery — 2026-10-18

The audit is incomplete. This extends the existing 2960-clause matrix; no previous Verified status is promoted or downgraded on file presence alone.

## Implemented boundary

The canonical and legacy patch commit paths retain path, approval, mass-operation, placeholder and byte-budget validation. A full read-set check rejects stale later targets before any side effect. An optional internal transaction capability passes through the existing runtime receipt wrapper and Workspace adapters; published tool schemas do not change.

LocalProjectWorkspace now uses its existing project-wide cross-process lease for an entire patch. It captures original bytes/modes, rechecks revisions, writes a protected, fsynced pending journal, and applies each file through the existing temporary-file/rename save. Failed mutations, including a rename followed by a missing receipt, restore existing files, recreate deleted files and remove new files. Successful commits publish a committed marker before journal cleanup. Existing Workspace reads and writes recover a pending journal under the same lease; nested Workspace calls share the lease through AsyncLocalStorage.

The journal is capped at32MiB, created exclusively with0600, excluded from agent file listing and inaccessible through protected-path APIs. Recovery validates its shape and every target, refuses symlinks/traversal, never prints content, preserves a conflicting external writer and fails closed with transaction_recovery_required. Incomplete recovery retains the journal; a subsequent attempt can recover after storage availability returns. Configured file count/size limits and ordinary permission bits remain enforced.

Implementation: apps/agent-api/src/project-file-transaction.ts, project-workspace.ts, code-patch-transaction.ts, code-tool-runtime.ts, code-tool-runtime-ports.ts, code-tool-runtime-workspace.ts, code-tool-executors-write.ts and code-tools-write.ts.

## Actual checks

- C3-journal-recertification-final.json: exact current assertions for affected existing Verified clauses; status changes are recorded in C3-journal-revalidation-changes.json. Fingerprints only protect freshness.
- C3-native-diagnosis-linux-fixed.json:31/31 real file/Git/transaction checks, UID10001, network none, read-only root, dropped capabilities and only an owned bundle mount. The same pre-existing local image is pinned by its inspected local image ID; imageAdmissionVerified remains false.
- Three child processes execute the actual Workspace transaction and terminate with73/74 while holding its lease: staging, first replacement and second replacement before receipt. The parent deliberately ages only the disposable crashed lease past the unchanged60-second timeout, then instantiates a fresh Workspace and verifies original BOM/CRLF bytes,0640 mode and journal removal. This is actual process death and recovery after lease expiry; it does not prove immediate recovery of a live/unexpired lease.
- Additional checks cover0755/0640 deleted-file recreation, new-file removal, late revision conflict with zero writes, readers and an independent Workspace instance waiting for the complete lease, failed compensation and retry, raw unsupported bytes, invalid privilege bits, native capability/receipt forwarding, Activity metadata and preserved peer edits.
- C3-journal-real-linux.json and C3-coordinated-transaction.json retain the initial failures. One exposed an unstructured error from recovery, now corrected in implementation. The other fault-injection wrapper retained a new transaction capability and bypassed its injected single-file fault; the legacy-adapter fixture now explicitly omits that capability. New independent native-transaction fault tests cover the authoritative path.
- API bundle, API/test typechecks and lint/source-size checks pass. C3-final-security-gate.json passes183 suites/2747 assertions/0 failures/0 skips before the additional native-diagnosis assertion; that final additional assertion is covered by the later isolated Linux and native/matrix targeted suites. No production deploy or shared-supervisor certification occurred.

## Remaining mandatory work

C3.L0412.02, C3.L0412.03 and C3.L0427.02 remain Broken against the unconditional PLAN wording. A direct filesystem/Terminal writer does not acquire the Workspace lease. A regression demonstrates that such a peer can change an already patched target; recovery preserves its bytes, retains the journal and blocks access. This is a safe diagnosis, not full rollback.

A complete fix needs one fencing protocol spanning the existing shared supervisor, Terminal operations, upload/copy-back, API writes and Git mutations. It must preserve the single shared sandbox and project directories. Stopping or migrating production writers was not performed. Current tests also do not establish host power-loss durability, cleanup of new empty parent directories or orphaned per-file staging temporaries, hostile parent-symlink races, peer mode changes, actual shared-runtime hooks or protected Activity diff artifacts.

C3 stage-local exclusions are unchanged: no new shell capability, agent loop/planner or UI is added by this patch. Child processes exist only in owned audit fixtures.

The remaining5 Broken/14 Missing items are tracked individually in C3-priority-open-register.json; four CI blockers retain the explicit owner-disabled trigger decision. Optional features remain Missing rather than being silently removed from the denominator.

The additional native-diagnosis test initially matched the generic word confidential in legitimate dataClassification metadata. C3-native-diagnosis-localized.json proves the false positive. The test now checks the exact injected peer-content and storage-error markers, while retaining the required nonretryable code and unchanged-peer-byte assertions. No Activity policy or implementation was weakened.
