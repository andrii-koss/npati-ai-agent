# NPATI Coding Agent — IDE protocol (specification)

**Status: specification only. No VS Code extension is implemented in this step (C15).**

Owner decision 3 (verbatim): *"Протокол для IDE (VS Code-розширення) як окремий наступний етап; зараз лише
специфікація API."* This document is that specification: it describes the HTTP surface an IDE extension will drive,
the transport it will use, the authorization it will inherit and the limits it must respect. Everything it names
already exists or is added in C15; nothing here needs a new server mechanism, and nothing here is a description of
work that has been done.

> **What is implemented today:** `npati code` (the CLI, `packages/cli`) — the exact same protocol, driven from a
> terminal. The CLI is the reference implementation of this document and the reason it can be trusted: every route,
> header, event name and refusal code below is one the CLI already uses, so the protocol is not a proposal but a
> description of a working client.

---

## 1. Versioning

| | |
| --- | --- |
| Current version | `v1` (`apps/agent-api/src/api-versioning.ts:9`) |
| Request header | `x-npati-api-version: v1` (also accepted: `accept-version`) |
| Response field | `apiVersion: "v1"` on **every** code response, including errors |
| Deprecation window | 90 days after a successor is announced (`DEPRECATION_WINDOW_DAYS`) |
| Discovery | `apiVersionInfo()` — `apiVersion`, `supported`, `deprecationWindowDays`, `header`, `asOf` |

An unsupported version is a structured `400 unsupported_api_version`; it is never silently downgraded. The
run-start response embeds the discovery block (`version`) so a client learns the window without a second call.

An extension **must** send the header and **must** read `apiVersion`. A response whose `apiVersion` is not in the
client's supported set is a hard stop, not a warning.

Where the header is *validated* today: on the run-start route, on the C1a `code-routes.ts` surface and on
`code-tool-routes.ts` — each calls `resolveApiVersion(request.headers)` before it does anything else. The rest of
the code surfaces advertise `apiVersion` on the response (an `onSend` hook adds `x-npati-api-version`) without
refusing an unknown request header, so a client should still treat the response field, not its own request, as the
authority on what it received.

## 2. Authentication

The IDE authenticates exactly like the CLI and the web UI: one credential, no second token class.

| Source | Header | Notes |
| --- | --- | --- |
| API key `npati_live_…` | `x-api-key` (checked first) or `Authorization: Bearer` | scopes → permissions, deny-by-default |
| Remote access token `rat_…` | `Authorization: Bearer` | scoped, company-bound |
| Dashboard session (OIDC / JWT) | `Authorization: Bearer` | the interactive extension case |

Rules an extension must follow:

1. **Never put the token in a URL.** `auth.ts` accepts `?token=` for backwards compatibility; an extension must not
   use it. Query strings end up in proxy logs, `Referer`-style leaks and crash reports.
2. **Store the token in the editor's secret storage** (`context.secrets` in VS Code), never in
   `settings.json`, never in a workspace file, never in `argv`.
3. **Send one credential, in one header.** A token is not sent in both `x-api-key` and `Authorization`.
4. **Treat `403` as a scope answer, not as a bug.** `permission_denied` names the missing permission; a client that
   retries it with a different header is not going to succeed.

### 2.1 Known boundary: an API key carries permissions, not a role

`company_api_keys` has `ownerUserId` but **no role column**, so `NpatiBackendAuthProvider` builds the API-key
`AuthContext` without `role` (`auth.ts:152-159`). `CodeRoleRegistry.roleOf` therefore returns `null` for an
API-key principal, `permissionsForRole(null)` is `[]`, and the **session-mode matrix does not apply to a key**:
everything rests on `ctx.permissions`.

This is a **deliberate boundary, documented rather than silently worked around**, for two reasons:

* A scoped key *is* the grant. Giving it a role would *widen* it — the owner's requirement is that the CLI/IDE token
  does not extend access, and "the key is an owner" would do exactly that.
* The alternative (look the owner up and take their role) would make a narrow key inherit everything its creator
  holds, which is the opposite of what a scope list means.

What follows for a client, stated plainly so it is not a surprise:

| Surface | API-key principal | Why |
| --- | --- | --- |
| `code.run.start` | allowed iff the key has `workspace:write` | action → permission, ordinary vocabulary |
| session-mode change (`PUT …/sessions/:id/mode`) | **refused** unless the caller's own role names the mode | `sessionModesFor(null) = []` — fail closed |
| approval `decide` | allowed iff the key has `business:manage` | the route checks that permission |
| approval `decide` by an agent/service principal | **always refused** | `classifyPrincipal` hard invariant |

**Next step (not this one):** if operators want key principals to change session modes, the decision is where a
key's *role* comes from — a new column with its own grant semantics and an owner decision about whether a key may
ever hold a mode that `full_auto_sandbox` names. It is not a change to make silently inside a client step.

## 3. Start a run

```
POST /companies/:companyId/code/runs
x-npati-api-version: v1
```

```jsonc
{
  "projectId": "…",        // required; the project must be a code_project
  "prompt": "…",           // required; `message` is accepted as an alias
  "sessionId": "…",        // optional; omitted => a session is created in the project
  "readOnly": false        // optional; true narrows the run (review/explain), never widens it
}
```

`202 Accepted`:

```jsonc
{
  "apiVersion": "v1",
  "status": "accepted",
  "run": {
    "runId": "<sessionId>:<uuid>",  // server-minted, random, the handle every later call needs
    "sessionId": "…", "projectId": "…", "companyId": "…",
    "status": "running", "live": true,
    "startedAt": "…", "heartbeatMs": 15000, "readOnly": false
  },
  "stream": { "kind": "sse", "method": "GET", "path": "…/background-stream",
              "expectedRunId": "<runId>", "fromSeqParam": "fromSeq" },
  "poll":   { "method": "GET", "path": "…/background", "expectedRunId": "<runId>" },
  "apiVersionHeader": "x-npati-api-version",
  "version": { "apiVersion": "v1", "supported": ["v1"], "deprecationWindowDays": 90, "header": "…", "asOf": "…" }
}
```

**Guarantees, in the order they are enforced** (a client may rely on each):

1. **Flag** — `coding_agent.enabled` is read server-side. Off, or a flag store that throws, answers
   `403 code_runs_disabled` (the body names the flag). A client cannot bypass it and must not try.
2. **RBAC** — action `code.run.start`, permission `workspace:write`, through the shared gate. A caller-supplied
   label may only *confirm* the derived permission; a mismatch is `403 permission_action_mismatch` and an unmapped
   action is `403 action_not_mapped`.
3. **Tenant** — `companyId` is the only tenant source. A project of another company is
   `404 project_not_found` with empty details, indistinguishable from a nonexistent project.
4. **Admission** — the run queue of the deployment. A full queue is refused **before** the `202`
   (`429 queue_timeout`, `retryable: true`), never after it.
5. **Registration** — the run is registered in the background-run registry **before** the response is written, so
   the id in the body already names a readable, streamable run, and the first event cannot slip past a client that
   subscribes immediately.

The run then executes **detached from the request**. Losing the connection does not stop it; that is the point of
the registry and the reason the client must follow it by id rather than by socket.

## 4. Follow a run

Two transports over one registry. Neither can disagree with the other about a run's state, because both read the
same record.

### 4.1 SSE (primary)

```
GET /companies/:companyId/code/runs/:runId/background-stream?expectedRunId=<runId>&fromSeq=<n>
```

* `expectedRunId` is **mandatory** and must equal the path id. A mismatch, an unknown run and a foreign tenant all
  answer the same `404 background_run_not_found` with no ids — the surface cannot be used as an existence oracle.
* Frames: `event: state` (the snapshot) → missed events after `fromSeq`, in `seq` order → live events →
  `event: end` (`{"reason":"run_finished"}`) when the run already finished, or `event: terminal` when it finishes
  live.
* Every event carries `seq` (monotonic, starting at 1) and `at` (ISO); `id:` is the `seq`. A client that
  reconnects with `fromSeq=<last seen seq>` receives exactly the tail it missed.
* `: heartbeat` comments arrive every `heartbeatMs`. A client whose idle timeout is shorter than that will
  disconnect from a healthy run.
* A finished run's response ends after its terminal event instead of holding the socket open.

### 4.2 Polling (fallback)

```
GET /companies/:companyId/code/runs/:runId/background?expectedRunId=<runId>&fromSeq=<n>
```

The same snapshot and the same events as JSON. This is what an extension behind a buffering proxy uses; it is not a
second source of truth.

### 4.3 Event payloads

| `event` | `data` | Rendering guidance |
| --- | --- | --- |
| `state` | `{ run }` | the snapshot: `status`, `live`, `lastSeq`, `reason` |
| `progress` | `{ routed, intent, projectId, background, runId }` | status line / spinner label |
| `delta` | `{ delta }` (or `{ text }`) | append to the answer buffer — this is the model's own text |
| `result` | `{ routed, run }` where `run.status` is the runner's own status | the settled result; a `delta` stream never replaces it |
| `error` | `{ error: { code, message } }` | terminal error, distinct from a failed run |
| `terminal` | `{ runId, sessionId, status, reason }` | the run ended; `status` ∈ `completed \| failed \| cancelled` |

A `stopped` run is reported as `failed`, never as a completion: the registry normalises the runner's five statuses
onto its three, so a client cannot mistake a stop for a success.

## 5. Approvals and questions

A run that needs a human parks in `waiting_for_user`. The client learns it from the terminal event
(`status: "waiting_for_user"`), from `result.run.code === "approval_required"`, or from the run's verification
summary. Then, over routes that already existed:

| Need | Route | Permission |
| --- | --- | --- |
| List | `GET /companies/:companyId/approvals?status=pending` | `workspace:read` |
| Show one | `GET /companies/:companyId/approvals/:approvalId` | `workspace:read` |
| Decide | `POST /companies/:companyId/approvals/:approvalId/decide` `{ decision, notes? }` | `business:manage` |
| Agent's own question | `GET …/code/runs/:runId/question`; `POST …/code/sessions/:sessionId/questions/:questionId/answer` | `code.question.read` / `code.question.answer` → `workspace:read` / `workspace:write` |

Two properties an extension must not paper over:

* **The decision is journalled before it is applied.** `approvals-routes.ts` writes the audit entry (with the hash
  of the exact payload the approver saw) *first*; an audit outage refuses the decision rather than losing it. A
  client can therefore rely on "decided" meaning "recorded".
* **An agent can never be the approver.** `classifyPrincipal` classifies any `agent:`/`service:` principal before
  the matrix is consulted and `CodeRbac` refuses an approval claim from it. An extension that runs under an agent
  identity can request and display approvals; it cannot decide them.

The extension should show the payload the human is approving (`inputPayload`, `payloadHash`, `toolName`,
`riskLevel`) and require an explicit confirmation. The CLI's `npati code approvals --approval <id> --decide …`
prompts for the decision word for exactly this reason; `--yes` is the explicit opt-out.

## 6. Other commands an extension will want

| Operation | Route | Action → permission |
| --- | --- | --- |
| Stop a run | `POST /companies/:companyId/code/runs/:runId/background/abort` (`expectedRunId`) | `code.session.stop` → `workspace:write` |
| Stop a session | `POST /companies/:companyId/code/sessions/:sessionId/stop` | `code.session.stop` → `workspace:write` |
| Set session mode | `PUT /companies/:companyId/code/sessions/:sessionId/mode` | role matrix (see §2.1) |
| Resume / rewind / fork | `…/code/sessions/:sessionId/resume`, `…/rewind`, `…/fork` | `workspace:write` |
| Transcript (paged JSON) | `GET /companies/:companyId/code/runs/:runId/turns?limit=&cursor=` | `code.changes.read` → `workspace:read` |
| Project list / session list | `GET …/code/projects`, `GET …/code/sessions` | `workspace:read` |

`…/turns` is **cursor pagination, not SSE**: it is the right call for "load the transcript of a finished run",
and the wrong one for "show me what is happening now".

## 7. Limits a client must respect

| Limit | Value | Client obligation |
| --- | --- | --- |
| Event buffer per run | 500 events (`CODE_BACKGROUND_RUN_EVENT_LIMIT`) | keep your own cursor (`fromSeq`); the server may have dropped older events |
| Tracked runs | 200, oldest **finished** first (`CODE_BACKGROUND_RUN_TRACKED_LIMIT`) | a run id can expire; **do not** use it as durable storage |
| Heartbeat | 15 s | idle timeout > 15 s |
| Transcript page | 50 default, 200 max | paginate with `nextCursor`, never assume the whole transcript fits |
| Prompt | 100 000 characters (`CODE_CLI_MAX_PROMPT_CHARS`) | refuse locally rather than uploading a repository |
| Run concurrency | deployment's `NPATI_CODE_RUN_MAX_CONCURRENT_PER_USER` / `…_PER_COMPANY` | a `429` is retryable; do not spin |
| Version window | 90 days | read `apiVersion` on every response |

Runs are **not** durable in the registry: the durable record is the run state and the replay bundle behind
`…/turns`, `…/snapshot` and `…/activity`. An extension that shows history reads those, not the registry.

## 8. What the extension step still has to decide (not decided here)

Listed so the next step starts from an explicit list rather than from rediscovery:

1. **Editor surface.** Which parts are a webview (the transcript) versus native (diagnostics, quick picks for
   approvals). The protocol above is transport-neutral; this is a UI decision.
2. **Secret storage and sign-in flow.** Device-code/OIDC against the dashboard, or a pasted API key. The API needs
   no new route for either; the choice is about what the extension offers.
3. **Reconnect policy.** How aggressively to re-subscribe with `fromSeq` after a network drop, and whether to fall
   back to `…/background` polling automatically.
4. **Multi-root workspaces.** One company/project per workspace folder, and what happens when two folders name two
   projects — the protocol has no notion of "the active workspace", so this maps onto `projectId` per request.
5. **Diff and review surface.** The changes/revert routes exist; deciding how a review is presented (and whether the
   extension ever offers `revert`) is a product decision with destructive consequences.
6. **Whether a key may hold a session mode** (§2.1) — an owner decision about keys and roles, not an extension
   implementation detail.

## 9. Reference client

`packages/cli` (`npati code`) implements §3–§6 today: `run`, `watch` (SSE and `--poll`), `approvals`,
`approvals --decide`, token resolution from the environment or a token file, and redaction of the token on every
output path. It is deliberately small and dependency-free, and it is the executable proof that this document
describes a real protocol rather than an aspiration.
