# C3 final isolation continuation — 2026-10-18

This continues the existing2960-clause matrix and [Terminal/Workspace coordination](2026-10-18-terminal-workspace-coordination.md). **C3 and the complete behavioral audit remain incomplete.** Production, secrets, existing project data, Compose policy, network restrictions and image CI were not changed. One shared runtime still hosts separate project directories/UIDs; no container per project was introduced.

## Confirmed defects and implementation

1. **Supervisor-only restart incorrectly implied process termination.** SharedProjectRuntimeProvider previously marked persisted running processes stopped without proving the old tree was gone. It now owns a lifetime kernel lease in protected /runtime-state (the existing lease helper), validates durable project identities, checks /proc for runnable members of each allocated project UID, and refuses admission with runtime_recovery_required if any remain. The check is read-only: it never signals a discovered PID or UID.
2. **Launcher could survive its supervisor.** project-runtime-guard.c captures and checks the trusted supervisor identity before path validation, arms PR_SET_PDEATHSIG(SIGKILL), and re-arms it after dropping UID/GID (setuid clears the signal). The provider supplies an overriding expected-parent identity, removed by the guard before executing project code. Missing/spoofed identity is refused, including the pre-main orphan race. The existing bubblewrap --die-with-parent and private PID namespace tear down descendants, including detached process groups, when the launcher dies. This extends the existing launcher; it does not rely on a saved PID or timeout.
3. **Terminal status preceded confirmed closure.** Tracked timeout records now become terminal after the child close boundary; preview cancellation keeps its stopped outcome even when the async close handler races; stopProcess waits for close with a bounded failure diagnosis. An unconfirmed termination cannot masquerade as stopped. Foreground shared timeout results are nonretryable because their effects already happened.
4. **Supervisor generations were absent and state was not fsynced.** The existing projects.json array retains backward compatibility with optional generation fields. Generation advances only after exclusive ownership and a successful runnable-process observation; project/process records retain it. Persistence fsyncs a unique protected temporary, renames it and syncs the state directory. Server startup awaits provider readiness and emits a content-free startup error code on refusal.
5. **Canonical reads had a check-then-read race.** Linux reads now walk every parent through a live directory descriptor with O_DIRECTORY|O_NOFOLLOW, then open the leaf with O_NOFOLLOW|O_NONBLOCK. A descriptor stat rejects non-regular/multiply linked files; bounded reads enforce the size limit even if a file grows. Tree content hashing uses the same reader. Temporary-file chmod uses its open handle rather than a replaceable pathname. Multi-link files remain listable as metadata without a revision; isolated package managers are unchanged. The first final gate correctly caught the former C15 expectation of ordinary external hardlink reads; isolation-hardlink-fixed.json separately verifies link refusal, ordinary single-link reads, unchanged external bytes and private-key content refusal. Windows retains its existing compatibility path and is not certified by the Linux descriptor assertions.
6. Concurrent createSandbox callers now wait for the same initialization promise and recheck tenant identity before receiving a result. Previously a second caller could observe the reserved entry before directories and durable state were ready, allowing premature dispatch/UID reuse if initial creation failed. The actual shared test issues12 parallel creations and checks completed home-directory and durable identity at every reply.
7. New runtime_recovery_required, runtime_state_invalid and process_termination_unconfirmed diagnoses survive native mapping as nonretryable failures.

Implementation: project-runtime-guard.c; src/shared-project-runtime-provider.ts; src/shared-runtime-process-fence.ts; src/shared-project-runtime-server.ts; src/project-file-descriptor.ts; src/project-workspace.ts; src/code-tool-runtime-errors.ts, all under apps/agent-api.

## Real Linux evidence

All raw/normalized reports live in artifacts/coding-agent-plan-closure-2026-10-17/. The Linux Workspace report isolation-workspace-accepted.json passes **53 assertions**, including hardlink metadata listing without byte reads. The actual shared runtime report isolation-shared-final.json passes **15 assertions**, using the real SharedProjectRuntimeProvider, compiled current C guard, bubblewrap, PID/user/network namespaces, seccomp and slirp. Both are authored acceptance fixtures, not autonomous agent E2E.

The shared fixture uses the existing Compose security profile exactly: cap_drop ALL; only the existing CHOWN, DAC_OVERRIDE, SETUID, SETGID, KILL, NET_ADMIN capabilities; existing project-runtime-seccomp.json, AppArmor/systempaths settings and /dev/net/tun. Outer network is none; root filesystem and audit-code bind are read-only; /projects and /runtime-state are private disposable tmpfs. No host PID/network namespace, Docker socket, external service, production volume or credential enters the fixture. Native compilation happens in a separate owned build fixture; all project isolation checks share one test container.

The first attempt to execute the compiled guard in /tmp failed EACCES. No executable tmpfs permission or seccomp relaxation was added. The runner compiles only into its owned artifact directory, then mounts that artifact read-only. This failed prerequisite is retained as isolation-prerequisite-diagnosed.json. Subsequent current guard namespace checks pass.

| Requested case | Actual evidence | Exact scope / remainder |
| --- | --- | --- |
| Worker SIGKILL during multi-file write | Workspace: worker crash recovery kill-after-first; terminal-after-first | Actual worker/process/file operations; managed Terminal projection fixture |
| Surviving detached child after supervisor death | Shared: supervisor SIGKILL physically ends detached namespace descendants | Actual guard and namespace tree, without new UID killing |
| Terminal plus Workspace writer | Workspace: concurrent real Terminal and Workspace reject entire stale output batch | Canonical transaction boundary; no arbitrary external rollback claim |
| Supervisor restart during unfinished work | Shared: SIGKILL followed by new provider, quiescence and generation2 | Process restart inside the disposable container; not a persistent-volume/container restart certificate |
| Durable ownership after restart | Shared: fsynced generation, exclusive supervisor, no replay respawn | Supervisor ownership; not yet API cleanupToken ownership |
| Stale writer | Shared: same process ID cannot respawn; second supervisor refused; unmanaged writer blocks admission | Stale API requests are not yet required to present the new supervisor generation |
| Symlink swap | Workspace: post-validation leaf and parent swaps refused | Real OS swaps and descriptor reads; mutation paths remain separately open |
| Hardlink / rename | Workspace: post-validation hardlink refusal; parent directory renamed before symlink swap | Does not certify arbitrary Git/save/delete rename races |
| Crash during rollback | Workspace: worker crash recovery kill-during-rollback | Actual SIGKILL after first compensation; fresh worker finishes recovery immediately |
| Preserve peer changes | Workspace: peer mismatch retains journal; Shared: surviving unmanaged writer is not signaled or modified | Observed conflicts preserve bytes; active mutation races remain outside universal guarantees |
| Timeout / cancellation | Shared: tracked timeout, foreground timeout, stopProcess | Actual detached descendant markers stop; no early terminal acknowledgement or unsafe replay |
| Connection loss | Shared: lost audit client channel | Actual IPC client disconnect; not authenticated HTTP/API crash/DB acceptance |

Bounded waiting is covered separately: queued canonical writers complete while a real managed build waits, a paused canonical owner retains its kernel fence despite heartbeat expiry, and actual competing supervisors cannot publish a second generation. The existing flock wait is10s (helper handshake12s); explicit process-close acknowledgment is bounded to5s and reports process_termination_unconfirmed instead of waiting forever. These are targeted contention/recovery checks, not a throughput or long-duration load benchmark.

The lifetime-fence test waits for the existing bounded flock timeout; it does not poll a PID and call that ownership. The unmanaged-writer negative control proves admission refusal while the peer continues writing; the harness later stops only the exact ChildProcess it created. A persisted PID is deliberately set to the live audit parent, and restart never signals it.

## Guarantee boundaries

| Operation | Guarantee | Boundary |
| --- | --- | --- |
| Journaled Workspace patch and managed returned write batch | atomic among participating canonical writers | Existing full-batch validation, recovery and lease; worker crash proofs pass |
| Linux canonical byte reads / tree content hashes | conflict-detected unsafe links / descriptor-confined traversal | Every parent and leaf is opened without following caller path symlinks; no Windows claim |
| Shared supervisor replacement | conflict-detected / fail-closed admission | Protected lifetime kernel lease; no new admission when an old project UID is observed runnable |
| New launcher descendants after supervisor loss | isolated and kernel-terminated | Parent-death signal plus existing private PID namespace; actual detached descendants verified |
| Managed API worker loss while supervisor lives | non-transactional bounded projection execution | The shared command may continue in its project projection; it has no canonical API storage mount |
| Git/reset/checkout, mounted commands and arbitrary shell external effects | non-transactional | Serialization/checkpoints do not make Git/database/network effects crash-atomic |

## Mandatory remaining work

- **Legacy durable preparation is not fixed by a supervisor generation.** cleanupToken in the existing CodeProcessProjectState still lacks execution/generation provenance. No token was force-cleared or expired. Safe recovery must bind it to the existing durable process receipt, reconcile/terminate/isolate the actual producer, then release by a fenced transaction. Current generations do not yet fence every stale API request.
- **Mutation TOCTOU remains open.** save rename, delete/move, Git and journal paths still include pathname-based operations. Descriptor reads and handle chmod reduce concrete attacks but are not a descriptor-relative write/delete/rename protocol. Active external writers, fence inode replacement on a writable mount, directory metadata enumeration races, metadata races and same-byte inode replacement are not universally certified.
- **Legacy hostile fork races are not fenced by a /proc observation.** A finite process listing can miss a child forked while its old parent exits. The probe catches observed survivors but is not a cgroup freeze/kill or a trusted cold-container epoch certificate. Kernel namespace death secures new guard descendants; universal legacy recovery remains Broken.
- **Legacy launchers may survive.** New launchers are kernel-bound; a legacy or unmanaged survivor causes refusal rather than unsafe termination. Owner-controlled restart/isolation of that old environment is required before new admission. No production process was terminated.
- **Actual admitted HTTP/DB/storage acceptance is not claimed.** The IPC test instantiates the actual provider/launcher and OS boundary; imageAdmissionVerified remains false. The four owner-disabled image CI requirements are unchanged. No authenticated production endpoint or production database was touched.
- Terminal deletion/mode mirroring, host power-loss durability and universally exact Git undo remain outside this batch.

A proposed new pkill-by-UID recovery path was rejected by automatic approval review because UID ownership was not sufficient proof for terminating unrelated processes. That proposal was not applied. The implemented restart barrier is read-only and fail-closed; it needs no broader kill authorization.

## Retained failures and validation scope

The initial full gate reported2756 passes and one failed C15 hardlink assertion; the stronger link-provenance contract and independent content controls above fix that regression. A later full run, isolation-complete-security-gate-tests.json, reported2756 passes and one Website Builder stream test reaching its existing10000ms limit. The unchanged Website suite then passed12/12 in isolation-website-recheck.json, including the affected case in3451ms. This records an observed timing failure, not a silently discarded result. Final frozen-source checks run sequentially, without concurrent Linux fixture load.

An earlier shared fixture command reached its1000ms timeout during namespace cold start, before producing its first marker. The retained isolation-shared-startup-timeout.json shows a timed-out process with no writes. The fixture now uses3000ms within the unchanged supervisor timeout ceiling and still requires real marker writes, terminal timeout status after closure, and no surviving writes. No runtime ceiling, agent step limit, assertion or security profile was weakened.

The Windows host uses Node22.13.1, below the repository supported floor22.22.2. Host build/typecheck/test evidence is reported with this limitation; Linux OS behavior is verified separately with the fixture runtime. Neither substitutes for admitted image/HTTP/database acceptance.

## Resume environment — 2026-10-19

At this checkpoint Docker could not be queried: the dockerDesktopLinuxEngine named pipe is absent. The saved53/53 and15/15 reports are retained actual Linux runs of this implementation, not reruns performed at this checkpoint. A fresh Linux run and current container inventory are blocked until the local Linux daemon is available. No Docker service, production infrastructure or container was started/restarted to bypass this. The runners clean their exact owned names in finally; no current zero-container inventory is claimed. Host regression validation continues independently.

## Verification ledger

Final isolation-release-*-command.json reports all exit0: API/test types, root build, lint, security gate and native regressions. Gate183 suites/2757 passed/0 failed/0 skipped; native121 passed. The earlier failed gate2756/1 is retained in isolation-final-security-gate-tests.json; the hardlink contract and independent content controls are recorded above. 41 changed Verified records were individually recertified, with no promotions. Matrix: 1910 Verified, 396 Partial, 5 Broken, 14 Missing, 631 Not Verified, 4 Blocked, 0 Unassessed. Source IDs and denominator remain2960. All1050 open obligations and exact C3 boundaries are saved in the matrix, open-obligations.json and resume-state.json. C3 remains incomplete.


Post-update matrix integrity: isolation-matrix-integrity.json passes5/5. Strict inventory regeneration validates every2960 source ID, seven disjoint status totals, unchanged PLAN source, current Verified implementation fingerprints and exact named assertions. git diff --check exits0; Git reports only configured LF/CRLF conversion warnings. isolation-checkpoint.json records all six successful validation commands and the current Docker availability blocker.
