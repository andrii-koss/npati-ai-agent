# Shared local runtime regression — 2026-10-10

## Diagnosis before the fix

The running installation declared `NPATI_DEPLOYMENT_TYPE=self_hosted` and transport `NPATI_SANDBOX_RUNNER_MODE=local`. Its Compose labels selected `docker-compose.sandbox-isolated.yml`. The existing local update script hard-coded that override, including in HEAD before the chat integration changes. Running that script deployed the isolated runner again.

Expected provider: `SharedProjectRuntimeProvider` behind the existing runner HTTP contract, one `npati-project-runtime` container. Actual API provider: `RemoteSandboxProvider`, forwarding to `sandbox-runner-server.ts`, which instantiates `DockerSandboxProvider`. The shared provider existed, but only the `project-runtime` image target / `shared-project-runtime-server.ts` selected it. There was no execution-mode invariant on the HTTP client or Docker creation path.

Exact creation path: chat/CLI/inbox/child runner/Preview → existing canonical tools → `ProjectSandboxService.ensure()` → `RemoteSandboxProvider.createSandbox()` → isolated server `createSandbox` dispatcher → `DockerSandboxProvider.createSandboxInternal()`. That method creates `npati-net-*`, `npati-proxy-*` and `npati-sb-*`. It does not know that transport `local` was meant to preserve the shared architecture. Async Steps 3–8 do not instantiate a Docker provider directly; they reuse this same service. The regression is deployment/provider selection, not another async execution hierarchy.

Observed at diagnosis: `npati-agent-sandbox-runner` (isolated supervisor), test-owned `npati-sb-b4643fd5-8332-4d53-bc29-602abd1cc873` and `npati-proxy-b4643fd5-8332-4d53-bc29-602abd1cc873`; no shared runtime container. A retained `npati-readiness-egress` belonged to the isolated readiness path. No user project/database was used by the chat diagnostics.

## Caller classification

| Caller | Classification | Boundary |
| --- | --- | --- |
| `shared-project-runtime-provider.ts:createSandbox` | SHARED_ALLOWED | Directory, UID, port and logical state only |
| `ProjectSandboxService.ensure` / recovery | SHARED_ALLOWED | Existing provider contract; no Docker constructor or fallback |
| Canonical code tools, async processes/subagents, inbox, Preview, website orchestration | SHARED_ALLOWED | Reuse ProjectSandboxService and the same project scope |
| `docker-sandbox-provider.ts:createSandboxInternal` | ISOLATED_ONLY | Workload and egress proxy creation |
| `DockerSandboxProvider.inspectBrowser` | ISOLATED_ONLY | Temporary QA workload on the isolated network |
| `sandbox-egress-enforcement.ts:dockerEgressProbe` | ISOLATED_ONLY | Ephemeral network policy probe workload |
| `sandbox-readiness-network.ts:createReadinessNetwork` | ISOLATED_ONLY | Isolated readiness proxy/network |
| Old `update-local-async-docker.ps1` isolated override | BUG | Local default deployed wrong server implementation |

## Fix

The local update script selects `docker-compose.sandbox-runner.yml`. All shared/isolated Compose profiles explicitly declare `NPATI_PROJECT_RUNTIME_MODE`. Local/self-hosted defaults shared; explicitly isolated profiles retain the reviewed Docker backend. Transport locality remains separate.

Normal main/child/inbox/C6/CLI run completion now uses the existing service's `releaseAfterRun`: shared scopes retain their identity, files, dependencies and other project processes. Isolated scopes keep C10 teardown. Explicit project deletion, kill-switch teardown and retention still use the guarded `destroy` path. Conversation admission recovers a terminal inbox task before acquiring the next lease, while live/paused tasks remain fenced. Completion wake cannot clean a locally running Preview finalizer.

Both servers assert their provider mode. Docker creation and Docker operations reject shared mode before admission or Docker calls. The remote client checks authenticated readiness for a healthy shared implementation before any project operation, including old sandbox recovery. There is no fallback. The existing SharedProjectRuntimeProvider now accepts durable async process identities, rejects conflicting/replayed identities, exposes bounded output and retains terminal status; these are project processes, not containers.

The authoritative frozen decision is in [SHARED_PROJECT_RUNTIME.md](../website-builder/SHARED_PROJECT_RUNTIME.md). Hosted isolation and security policies remain intact.

## Acceptance status

The shared-runtime regression acceptance checks passed against the real local Docker installation on 2026-10-10. The updated local images are deployed and API, web, worker and shared runtime report healthy.

| Check | Evidence / result |
| --- | --- |
| Five simultaneous project scopes and HTTP previews | `artifacts/shared-runtime-container-count.json`: **13 containers before and after every phase**; exactly one `npati-project-runtime`, no `npati-sb-*` or `npati-proxy-*` |
| Background process, same-ID replay, bounded Unicode output and cancellation before launch | `scripts/verify-shared-runtime-regression.mjs`: passed against the authenticated shared runner |
| Reconnect, actual API container restart, identity reuse and Preview survival | Same lifecycle drill: passed; all five previews remain available |
| Delete project A while B/C/D/E continue | Same lifecycle drill: passed; diagnostic cleanup leaves the shared container running |
| Audited chat source edits, two detached child runners and canonical async shell | `artifacts/chat-website-live-runtime.log`: passed with real PostgreSQL and shared runner; **15 containers unchanged** during all phases |
| Next.js dependency installation, canonical production build and HTTP Preview | Same live chat drill: passed; no project-specific containers |
| Fresh API instance resumes the same chat/session and edits the existing site | Same live chat drill: passed, including actual HTTP response containing the new source |
| Shared scope and OS isolation | `artifacts/shared-runtime-isolation.log`: passed |
| Explicit isolated producer | `artifacts/shared-runtime-isolated-proof.log`: **1 real Docker test passed** with `NPATI_PROJECT_RUNTIME_MODE=isolated`; its owned container was removed |
| Required hermetic security gate | `artifacts/security-gate-report.json`: **165 suites / 2405 passed / 0 failed / 0 skipped** |
| Required PostgreSQL gate | `artifacts/security-gate-db-report.json`: **3 suites / 5 passed / 0 failed / 0 skipped** |
| Web and actual React browser checks | `artifacts/chat-website-web-tests.log`: **13 suites / 104 passed**; `artifacts/chat-website-browser-report.json`: **3 browser checks passed** |
| Workspace/test typechecks, lint and XSS scan | Passed; logs in `artifacts/shared-runtime-typecheck*.log` and `artifacts/shared-runtime-lint.log` |

The live chat drill uses a scripted model, real production route handlers, audited canonical tools, real child runners, project processes, build commands and HTTP previews. It verifies the application execution path; it does not claim acceptance of an external AI provider. Browser checks use real React with mocked HTTP/SSE.

The chat drill's 15-container baseline included the disposable `npati-chat-website-pg` and a retired `npati-readiness-egress`. After successful tests, only these diagnostic containers were removed. The latter was verified to have label `npati.readiness=egress` and no mounts. The final post-deployment lifecycle drill records the 13-container baseline. Existing user project scope and user databases were retained; no volumes were pruned. The temporary isolated proof creates and removes its own container separately from the shared-mode count drill.

Unit tests cover default/explicit mode selection, immediate Docker refusal, substituted/unready/unavailable runner refusal and normal main/child release across five shared scopes without teardown. Explicit deletion still tears down only its selected logical scope. No async rollout flags were enabled globally. The full repository test suite was not rerun; the separately checked business-chat duplicate-ideas failure also occurs on the original HEAD baseline.

## Deployment dependency correction after user verification

The user's actual chat exposed `GIT_COMMAND_FAILED: spawn git ENOENT` before the first model step. The previous live drill ran the API on Windows against the shared runner; host Git masked the missing binary in the deployed API/worker image. Shared runtime Git alone is insufficient: `ensureSessionBranch` delegates to `ProjectGitService`, which executes Git in the API's canonical workspace before sandbox tool execution. The earlier shared-runtime and host-run results remain valid within those limits; they did not prove deployed API chat acceptance.

The API/worker `runtime` image now installs Git and checks `git --version` during its build. Local deployment checks Git in both running services, and the host-run chat drill also checks these binaries before starting. Chat no longer shows the `Open Code Workspace` link in its composer; the pending-message panel is hidden when idle with no error. The browser drill now restores an enabled session binding and verifies that the idle panel and workspace link are absent while Preview and same-project edits work.

The corrected images are deployed. `artifacts/chat-git-final-deploy.log` records healthy services and Git 2.54.0 in API and worker. A separate compiled production-app drill executed **inside the deployed API container as its normal node user**, against a disposable PostgreSQL database and the existing shared runner. It passed session branch admission, website creation, a source edit in the same project/session and HTTP Preview containing the edit (`artifacts/chat-deployed-api-drill.log`, exit 0). This still uses a scripted model, not an external AI provider. Only the drill's own projects/database/container were removed afterward.

Follow-up web checks: **13 suites / 104 passed**, **3 browser checks passed**, web/test typechecks, lint and XSS scan passed. The temporary `chat-website-baseline-app.ts` was an untracked diagnostic copy made to compare the unrelated business-chat failure against HEAD; it was never a runtime entry point. It has no imports or references in application source and its removal did not remove `app.ts`.

## Provider tool-name correction

The next real chat request exposed an upstream HTTP 400: canonical names such as `code.fs.read` violate the provider's function-name pattern. The OmniRoute adapter now assigns bounded ASCII aliases at the HTTP boundary, rewrites definitions, assistant/tool history and explicit tool choice consistently, and restores canonical names on returned calls before the runner executes them. Tool definitions, canonical authorization and the manifest are unchanged. Responses forced tool choice also uses its required flat name field. Valid existing names retain their spelling; aliases avoid collisions and do not mutate the caller's request.

`artifacts/chat-tool-names-tests.log`: **2 suites / 36 tests passed**, including both Chat Completions and Responses round-trips, history, forced choice, long names and stable distinct aliases. Adapter and test typechecks passed. Updated local images are healthy (`artifacts/chat-tool-names-deploy.log`). A real direct `deepseek/deepseek-flash` request through the installation's authenticated OmniRoute returned `code.fs.read` after alias restoration; the subsequent tool-result history request also succeeded (`artifacts/chat-tool-names-live.log`, exit 0). This was a protocol drill with a mocked read result and no file operations, not a full website build. The initial virtual company-agent route was unsuitable for this drill because it strips caller-provided tools; the direct model drill uses the same adapter boundary as native Coding Agent calls.
