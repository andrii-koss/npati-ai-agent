# C3 Workspace / Terminal writer coordination — 2026-10-18

This continues the existing 2960-clause audit. It does not certify the whole Coding Agent or uncoordinated filesystem writers. Production, secrets, working project data, seccomp and approval policy were not changed. All sites still use the configured single shared supervisor with separate project folders; this patch does not allocate a container per site.

## Writer map and guarantees

Atomic below means all declared file changes at the canonical Workspace commit boundary, against participating writers, with recovery from worker termination. It does not mean an arbitrary shell command, Git operation, database write or external API call can be undone.

| Operation / source | Coordination | Guarantee and explicit boundary |
| --- | --- | --- |
| Workspace API create/write/edit/move/delete; project-file-routes.ts and project-workspace.ts | Existing project lease; Linux kernel fence; expected revision; temporary save/rename | Atomic single-file replacement / conflict-detected stale revisions. Does not certify hostile unmanaged parent-directory replacement or Windows kernel fencing. |
| code.fs.apply_patch, canonical and legacy formats; code-patch-transaction.ts | Existing Workspace transaction; complete read-set validation; protected journal; same lease | Atomic declared creates/updates/deletes among participating writers. Pending intent is recovered before sanctioned reads/writes. |
| code.fs.write/edit; code-tool-runtime-workspace.ts | Authoritative Workspace adapter; read tracker, expected revision and approval unchanged | Atomic per-file save / conflict-detected. |
| Foreground managed Terminal / build / install / shell scripts; ProjectSandboxService.run | Existing Sandbox projection, short canonical snapshot lease, full validation then one existing applyPatchTransaction | Atomic canonical batch of returned creates/updates. Command itself is non-transactional; output filtering, absent-file deletions and permission changes are not claimed as a complete filesystem mirror. |
| Tracked managed process collection; syncTrackedProcess | Original snapshot revisions/hashes, bounded returned files, full validation, one canonical transaction | Atomic returned writes / conflict-detected on stale originals. Repeated identical collected results are skipped. Actual durable DB/API-restart recovery remains a separate acceptance requirement. |
| Writable mounted foreground Terminal | Same canonical Workspace lease for foreground lifetime; no upload/copy-back | Non-transactional command, serialized with participating API/Git writers while the caller owns the lease. Necessary for direct writes; does not hold the canonical lease during managed builds. |
| Mounted / legacy background process and Live Preview | Existing process ownership, provider lifetime and C12 policies | Non-transactional. A surviving process after API-worker death is not guaranteed to participate in the canonical lease. Writable mounts expose the coordination metadata; a command that unlinks/replaces it is not fenced by an advisory lock. No claim of atomic Live Preview reads during arbitrary direct writes. |
| Git init, branch/switch, stage, commit, checkpoint, restore/reset, restorePaths, worktree creation/removal and canonical merge | Production app.ts binds the existing Workspace coordinator through ProjectGitBoundary; nested operations reuse it | Serialized against canonical Workspace writers. Git reset/checkout/merge and remote Git effects are non-transactional operations; safety checkpoints do not establish crash-atomic Git state. |
| Git status/diff | Short shared Workspace lease when wired | Coordinated canonical read; immutable Git object reads do not need a long write lease. |
| Legacy/custom GitService construction without coordinator | Explicit optional compatibility boundary | Non-transactional; not silently represented as coordinated. Production and the real C3 fixture are wired. |
| Isolated agent worktrees | Existing C12 scopes/worktree directory; canonical merge now uses canonical lease | Worktree-local commits and external commands retain their existing guarantees; no new universal multi-agent snapshot guarantee. |
| Website Builder, Project SDK generation, media file mirror | Existing Workspace create/write APIs | Participate in file coordination. Object storage, SQL metadata, deployment and media upload lifecycle are non-transactional across those resources. |
| Shared/Docker Sandbox upload/download; package scripts | Existing per-project projection and UID/namespace policy | Non-transactional projection writes. Returned managed writes are validated and committed as above. No changes to Sandbox permissions or network policy. |
| Repository/ZIP import; project-import-service.ts | Per-file Workspace API during source/context creation; later install/preview steps | Non-transactional workflow. The initial file loop is not one batch transaction and can leave a partial import on failure. |
| Project duplicate; project-routes.ts | Per-file create API | Non-transactional; existing catches can hide partial copy failures. Binary-copy correctness and honest completion remain separate unresolved work. |
| Website data scaffold; data-studio/website-bootstrap.ts | Per-file create/CAS plus schema/auth/CORS/metadata steps | Non-transactional across scaffold files and backend resources; existing files are preserved. |
| Project cleanup/purge and external local tools | Existing lifecycle authorization and destructive cleanup paths | Non-transactional. Concurrent lifecycle teardown and mounted/unmanaged writers are not certified by this batch. |
| SecureFileToolsEngine / CodingCliGateway | In-memory virtual demo only; coding-cli-and-file-tools.ts | Not a canonical disk writer and not runtime proof. |

## Implementation changes

- Managed foreground and tracked copy-back used to mutate one file at a time. They now build the whole bounded plan, validate every returned path/content first and call the existing Workspace transaction. A late revision conflict or protected result cannot commit an earlier file. A custom provider without a transaction refuses a multi-file result instead of silently degrading to sequential writes.
- Snapshot capture holds the existing short Workspace lease. Commands run outside that canonical lease in their existing project projection, so ordinary managed builds do not block canonical reads/writes for their lifetime.
- Linux extends the existing directory lease with a NOFOLLOW-opened regular-file descriptor and flock, not another transaction journal. A paused owner cannot be replaced because of heartbeat expiry. A new owner can recover a kernel-v1 abandoned lease immediately after obtaining the kernel lock. Legacy lease records keep the old bounded recovery behavior. The tested backing filesystem is local Linux/tmpfs; NFS/SMB and mixed-OS writers are not certified. Windows retains the previous coordination and is not represented as Linux kernel-fenced. A deployment must drain legacy API writers before claiming the kernel-v1 contract: old binaries do not participate in flock, and mixed versions/OSes are not certified. The source-only Docker dependency update is not a performed rollout.
- The helper executes constant infrastructure code with a minimal PATH/LC_ALL environment. It inherits no API secrets. Symlink and hardlink fence files fail closed. Missing flock has an explicit workspace_lock_unavailable diagnosis. The API Dockerfile declares util-linux; no image was deployed.
- Production Git operations and the real C3 fixture use the same coordinator. Git clean explicitly excludes .npati-* and .worktrees, protecting lease/journal files independently of repository ignore rules.
- A writable mounted foreground command holds the same lease for its lifetime. Background processes and arbitrary external effects do not acquire a fictitious rollback guarantee.
- Dispatch changes retry semantics: timeout, lost runner reply, failed output validation or failed copy-back do not advertise safe automatic replay. Both ProjectSandboxService and CodeShellRuntime now return retryable:false after uncertain/executed commands. Existing timeout assertions were updated to this analyzed contract, not removed. Pre-dispatch transient admission failures retain their appropriate retry behavior.
- Terminal trace records a failed command/workspace-sync event even when copy-back fails before the usual success/failure event. It retains the real exit code, safe error code and bounded/redacted output, with a command hash instead of its source text.
- A new HEAD integration had an unrelated as-any lint blocker in code-agent-routes.ts. Valid marketplace tabs are now narrowed to the canonical union without a lint exemption; invalid tabs retain the marketplace default.

## Actual evidence and scope

Artifacts are under artifacts/coding-agent-plan-closure-2026-10-17/. terminal-linux-acceptance-final.json passes 49 actual Linux assertions in one owned read-only, non-root, no-network, capabilities-dropped container. No Docker socket, production mount or credentials enter it. The transport fixture runs actual /bin/sh and node against owned project directories through ProjectSandboxService and LocalProjectWorkspace. It is not a live admitted SharedProjectRuntimeProvider, provider-model or PostgreSQL certification; imageAdmissionVerified remains false.

The cases include concurrent Terminal/Workspace stale output, whole-batch rollback after a replacement loses its receipt, late secret refusal with no earlier write, timeout/process kill, a Git reset during an actual command, checkout waiting for Workspace, twelve queued writers while a command waits, a writable in-place foreground command, symlink/hardlink fence refusal, worker process exits, SIGKILL, immediate recovery without aging a lease, actual Terminal copy-back worker death without command replay, and SIGSTOP with an expired heartbeat. Per-case timings are recorded where available; the twelve-writer liveness check is bounded by 5 seconds, not an unlimited fairness claim.

The first runner report was not parsed because structured terminal-policy logs preceded its JSON result. The runner now selects the exact final report kind and retains a bounded stdout tail on parse failure; policy logging and PASS criteria are unchanged. Initial failed artifacts are retained. A test fixture used an optional mountFor member through the concrete LocalProjectWorkspace type; it now uses the declared ProjectWorkspace port, without as-any or a typecheck exclusion.

Current final validation is recorded in terminal-cleanup-final-*-command.json: API typecheck, test typecheck, root build, lint, security gate and native integration all exit0. The fixed gate passes **183 suites / 2754 assertions / 0 failures / 0 pending**; native integration passes **118**; frontend regressions pass **186**. Earlier terminal-recertification.json passes299 affected backend assertions; final exact changed-source revalidation selects current individually named assertions, not inferred whole-suite coverage. All original failed reports remain as history. The host is Node22.13.1, below the repository supported floor22.22.2; local execution is not supported-host certification. No runtime image or production service was rebuilt/deployed.

## Remaining boundaries / unblock conditions

C3.L0412.02, C3.L0412.03 and C3.L0427.02 must not be promoted to unconditional Verified merely from this scoped transport fixture. Mandatory remaining work:

1. Actual admitted shared-supervisor namespace acceptance, including worker loss and surviving child processes. The current local audit image is not an officially admitted supervisor image; the existing four owner-disabled CI image publication/rescan/rebuild blockers remain unchanged.
2. Legacy durable preparation ownership: CodeAsyncProcessService.cleanupGuard persists cleanupToken without owner/execution provenance or expiry. For legacy project.terminal calls when async ownership is enabled, an API crash can leave an unsettled preparation token. Clearing it solely on a timer is unsafe because a real command may still run in the separate supervisor. Safe recovery must bind the existing preparation record to a durable runner execution outcome, then reconcile/stop the producer before releasing the fence. No production token was cleared.
3. Mounted/background or unmanaged filesystem writers that bypass the coordinator. A detected mismatch retains the journal and peer bytes; an active hostile parent-component replacement remains outside the current pathname-based data I/O guarantee. Fence NOFOLLOW tests do not certify all data-path TOCTOU races or protect an exposed writable mount from deleting/replacing the fence inode. A descriptor-relative primitive or enforced canonical-directory isolation/staging is needed before expanding the guarantee.
4. Git and external resources remain non-transactional. Guarded reset/checkout is serialized but not journaled as a crash-atomic Git transaction. Abrupt host power loss, new empty parent cleanup/orphaned staging temporaries and universally exact cross-filter/mode Git undo remain separate requirements.
5. Deletion/mode reconciliation of arbitrary Terminal output is not newly claimed. Approval-bound code.fs deletes remain the authoritative transactional delete path. No broad deletion was introduced while fixing write coordination.

The complete 2960 matrix, exact disjoint totals, individual C3 evidence and all non-Verified records are updated only after the exact current assertions pass. Classification is not full behavioral certification. Production remains unchanged.

The existing reader regression introduced during lease wiring is reproduced in terminal-git-reader-before.json: status/list on an initialized repository wrongly required write permission. The coordinator now keeps that read path available; the repository initializer enforces write permission only before actual initialization. terminal-git-reader-fixed.json verifies the correction alongside C11 approval/init regressions.

The first full gate failed 2749/2: the unrelated new HEAD as-any violation and a C7 test expecting an unprotected clean -fd. The former is fixed in code; the latter now requires exact internal metadata exclusions while still forbidding reset/clean for path-only revert. A real legacy-ignore Linux reset case proves the exclusions rather than relying only on argv text.

## Durable cleanup release regression

terminal-cleanup-release-before.json reproduces two failures: a completed command became a generic error when its durable owner could not be released, and a primary command timeout was masked by the release exception. The guarded finally now records a content-free process_cleanup_failed event, preserves a primary diagnosis, and returns a canonical nonretryable cleanup error after an otherwise completed command. It never clears the durable token by timer or reruns the command. terminal-cleanup-release-fixed.json passes30 Terminal integration assertions, including the actual native error mapper and committed-file checks. Real PostgreSQL/runner reconciliation remains an explicit separate gap.

## Exact saved audit state

The source remains **2960** clauses, all classified. Independently reassessed in the continuation series: **1055**. Disjoint totals: **1910 Verified**, **396 Partial**, **5 Broken**, **14 Missing**, **631 Not Verified**, **4 Blocked**, **0 Unassessed**. This batch revalidates 72 changed Verified records against exact current assertions and updates three Broken C3 records; it promotes no status. The source SHA and existing source anchors are unchanged. The full matrix and open-obligations.json retain every remaining individual clause.

### C3 remaining individual requirements

| ID | Status | Remaining / failure boundary |
| --- | --- | --- |
| C3.L0408.01 | Partial | Resolve full patch atomicity; verify the normal Run in the shared Sandbox. |
| C3.L0411.10 | Partial | Implement and validate encoding-preserving codecs for supported non-UTF-8 formats, or explicitly define the supported text-encoding contract. |
| C3.L0412.02 | Broken | Validate actual admitted shared-supervisor process isolation and surviving-child fencing; four owner-disabled image CI obligations remain blocked.; Bind legacy durable preparation ownership to existing runner execution receipts before recovering a crashed cleanupToken; blind timer expiry can admit a surviving command.; Enforce canonical-directory isolation or descriptor-relative data-path I/O for hostile unmanaged writers; preserve peer data on detected conflicts.; Returned Terminal writes do not mirror deletions/mode changes; Git, external resources, host power-loss and universally exact undo are not made transactional by this patch. |
| C3.L0412.03 | Broken | Validate actual admitted shared-supervisor process isolation and surviving-child fencing; four owner-disabled image CI obligations remain blocked.; Bind legacy durable preparation ownership to existing runner execution receipts before recovering a crashed cleanupToken; blind timer expiry can admit a surviving command.; Enforce canonical-directory isolation or descriptor-relative data-path I/O for hostile unmanaged writers; preserve peer data on detected conflicts.; Returned Terminal writes do not mirror deletions/mode changes; Git, external resources, host power-loss and universally exact undo are not made transactional by this patch. |
| C3.L0417.04 | Missing | Persist a protected redacted diff artifact and expose an authorized reference in Activity; preserve the metadata-only secret policy. |
| C3.L0418.01 | Not Verified | Run configured formatter and syntax hooks in the shared runtime and inspect exit codes and changed bytes. |
| C3.L0418.02 | Not Verified | Run configured formatter and syntax hooks in the shared runtime and inspect exit codes and changed bytes. |
| C3.L0420.01 | Not Verified | Exercise hostile parent-path replacement and Linux shared-runtime containment. |
| C3.L0427.02 | Broken | Validate actual admitted shared-supervisor process isolation and surviving-child fencing; four owner-disabled image CI obligations remain blocked.; Bind legacy durable preparation ownership to existing runner execution receipts before recovering a crashed cleanupToken; blind timer expiry can admit a surviving command.; Enforce canonical-directory isolation or descriptor-relative data-path I/O for hostile unmanaged writers; preserve peer data on detected conflicts.; Returned Terminal writes do not mirror deletions/mode changes; Git, external resources, host power-loss and universally exact undo are not made transactional by this patch. |
| C3.L0429.02 | Partial | Verify or eliminate .gitattributes/clean-smudge normalization and full-mode restoration before claiming unconditional exact recovery. |

### Priority unresolved register

These23 records are the existing five Broken,14 Missing and four Blocked requirements; no optional/TODO item was silently removed from the denominator. Actual shared-image admission and image CI require the owner-controlled dependency, not weaker security settings.

| ID | Status | Exact remaining action / blocker |
| --- | --- | --- |
| C1c.L0283.06 | Missing | Optional scope only: implement an external timestamp provider if explicitly required for release. |
| C1a.L0314.01 | Missing | Optional: implement configured threshold evaluation if required for release. |
| C1a.L0314.03 | Missing | Optional: wire an existing NPATI notification channel with configuration; do not send unsolicited external messages. |
| C1b.L0350.07 | Blocked | "Automatic Actions triggers are intentionally disabled by the existing owner decision recorded in the workflow. No remote build/scan/sign or publication was launched." |
| C1b.L0351.01 | Broken | The active shared supervisor is a locally built unpinned image; SharedProjectRuntimeProvider allocates folders without image attestation. Preserve ONE container and add deployment-level attestation rather than creating a container per project. |
| C1b.L0351.04 | Missing | Persist the actual shared-supervisor image identity per session and bind it to ExecutionSnapshot without creating per-project containers. |
| C1b.L0353.02 | Blocked | "Automatic Actions triggers are intentionally disabled by the existing owner decision recorded in the workflow. No remote build/scan/sign or publication was launched." |
| C1b.L0354.03 | Blocked | "Automatic Actions triggers are intentionally disabled by the existing owner decision recorded in the workflow. No remote build/scan/sign or publication was launched." |
| C1b.L0356.01 | Blocked | "Automatic Actions triggers are intentionally disabled by the existing owner decision recorded in the workflow. No remote build/scan/sign or publication was launched." |
| C1b.L0366.01 | Broken | The active shared supervisor is a locally built unpinned image; SharedProjectRuntimeProvider allocates folders without image attestation. Preserve ONE container and add deployment-level attestation rather than creating a container per project. |
| C3.L0412.02 | Broken | Validate actual admitted shared-supervisor process isolation and surviving-child fencing; four owner-disabled image CI obligations remain blocked.; Bind legacy durable preparation ownership to existing runner execution receipts before recovering a crashed cleanupToken; blind timer expiry can admit a surviving command.; Enforce canonical-directory isolation or descriptor-relative data-path I/O for hostile unmanaged writers; preserve peer data on detected conflicts.; Returned Terminal writes do not mirror deletions/mode changes; Git, external resources, host power-loss and universally exact undo are not made transactional by this patch. |
| C3.L0412.03 | Broken | Validate actual admitted shared-supervisor process isolation and surviving-child fencing; four owner-disabled image CI obligations remain blocked.; Bind legacy durable preparation ownership to existing runner execution receipts before recovering a crashed cleanupToken; blind timer expiry can admit a surviving command.; Enforce canonical-directory isolation or descriptor-relative data-path I/O for hostile unmanaged writers; preserve peer data on detected conflicts.; Returned Terminal writes do not mirror deletions/mode changes; Git, external resources, host power-loss and universally exact undo are not made transactional by this patch. |
| C3.L0417.04 | Missing | Persist a protected redacted diff artifact and expose an authorized reference in Activity; preserve the metadata-only secret policy. |
| C3.L0427.02 | Broken | Validate actual admitted shared-supervisor process isolation and surviving-child fencing; four owner-disabled image CI obligations remain blocked.; Bind legacy durable preparation ownership to existing runner execution receipts before recovering a crashed cleanupToken; blind timer expiry can admit a surviving command.; Enforce canonical-directory isolation or descriptor-relative data-path I/O for hostile unmanaged writers; preserve peer data on detected conflicts.; Returned Terminal writes do not mirror deletions/mode changes; Git, external resources, host power-loss and universally exact undo are not made transactional by this patch. |
| C4a.L0495.06 | Missing | Optional capability in PLAN; package metadata has license field, but dedicated policy engine is omitted. |
| C4a.L0495.07 | Missing | Optional capability in PLAN; image-level SBOM is in C1b, but project dependency SBOM generation is omitted. |
| C5.L0566.01 | Missing | Optional capability in PLAN; messenger approval is marked TODO. |
| C5.L0566.02 | Missing | Optional capability in PLAN; identity verification infrastructure pending. |
| C5.L0566.03 | Missing | Optional capability in PLAN; marked as TODO. |
| C5.L0566.04 | Missing | Explicitly designated as TODO in PLAN.md. |
| C5a.L0606.03 | Missing | Optional capability in PLAN; messenger integration is marked TODO. |
| C5a.L0606.04 | Missing | Optional capability in PLAN; marked as TODO. |
| GLOBAL.L1185.01 | Missing | Execute the exact remaining integration/negative/recovery acceptance for this source clause; current scoped tests and prose do not establish it. |

Full stage counts and resume instructions: [plan progress](2026-10-18-plan-progress.md). The actual admitted shared-supervisor, durable owner reconciliation and hostile unmanaged data-path guarantees prevent claiming C3 completion. The remaining396 Partial and631 Not Verified records are still open; this scoped change does not certify them.


## Final isolation continuation — latest boundary

See [current physical isolation proof and remaining work](2026-10-18-c3-final-isolation.md). Actual shared provider/launcher15/15 and Workspace Linux53/53 pass; gate2757 assertions passes. Earlier missing parent-death/observed-survivor barriers and pathname byte reads are repaired. Legacy cleanup ownership, stale API generations, hostile legacy fork races and mutation-path TOCTOU remain open; C3 status is not promoted. The full2960 matrix remains 1910 Verified, 396 Partial, 5 Broken, 14 Missing, 631 Not Verified, 4 Blocked, 0 Unassessed. No production change.


## PLAN-wide continuation — 2026-10-19

See [current report](2026-10-19-plan-wide-continuation.md).442 unique requirements across14 sections were rechecked; totals: 2057 Verified, 664 Partial, 5 Broken, 17 Missing, 210 Not Verified, 7 Blocked, 0 Unassessed. Current actual Linux55/55, shared15/15, PostgreSQL9/9 and gate2779 pass. These results supersede historical counts without claiming full audit completion or C3 universal atomicity.
