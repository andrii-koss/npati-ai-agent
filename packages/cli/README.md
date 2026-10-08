# `@npati/cli` — `npati code`

C15 (owner decision 2): *"CLI-клієнт (наприклад `npati code`) для локального терміналу: автентифікація токеном до
локального NPATI API, стрім сесії, approvals у терміналі."*

This package is that client. It is a **client and nothing else**: it sends a token to routes that already existed
(plus the one run-start route C15 adds) and the server decides everything — RBAC, feature flags, the run queue,
policy and approvals. There is no authorization vocabulary in this package, and that is deliberate: a client that
could not widen access even if it tried is a client whose "the token does not widen access" claim is checkable.

## Install / run

No dependency is installed for this package — it is plain ESM JavaScript (`node:fetch`, `AbortController`, `node:fs`)
and Node 22.22+ / 24+.

```bash
npm install                      # links node_modules/.bin/npati from this package's "bin"
npx npati code --help            # or: npm exec --workspace @npati/cli -- npati code --help
node packages/cli/bin/npati.mjs code --help   # without linking at all
```

## Token

The token comes from the environment or a file. **Never from the command line** — `--token` is refused in every
spelling, because a command line is readable by every process on the host (`ps`) and is kept in shell history.

| Source | How |
| --- | --- |
| Environment | `NPATI_API_TOKEN=<token>` |
| Token file | `--token-file <path>`, or `$NPATI_TOKEN_FILE`, or `~/.config/npati/token` (`$XDG_CONFIG_HOME/npati/token`) |

Either credential shape is accepted, and each is sent in the header `auth.ts` reads first:
`npati_live_…` → `x-api-key`, anything else (`rat_…`, a session JWT) → `Authorization: Bearer`.

Every line the CLI prints goes through a redaction pass with the resolved token, and a second pattern pass catches
credential shapes that are not this process's own. An HTTP error body that quotes the token back is redacted before
it reaches the terminal.

## Commands

```bash
npati code run "<prompt>" --project <id> [--company <id>] [--session <id>] [--read-only] [--print-run-id]
npati code "<prompt>" …                       # `code` + a prompt is an implicit `run`
npati code watch --run <runId> --company <id> [--from-seq <n>] [--poll]
npati code approvals [--company <id>] [--status pending]
npati code approvals --approval <id> --decide approved|rejected [--notes <text>] [--yes]
```

* `run` prints the run id (alone on stdout with `--print-run-id`, so `RUN=$(…)` composes) and follows the run over
  the **existing** background-run SSE route. `watch --poll` uses the JSON polling fallback (`…/background`).
* Ctrl-C detaches the viewer, it does **not** stop the run: the run keeps executing in the registry, exactly as it
  does when a browser tab is closed. Stopping is an explicit act (`…/background/abort`, the Stop route).
* `approvals` reads and decides through the **existing** `/approvals` routes. The decision is journalled before it
  is applied by the server, and the CLI asks for the decision word to be typed unless `--yes` is given, because the
  decision is irreversible.

Exit codes: `0` a completed run / a successful command, `1` a run that ended in any other state (or a cancelled
prompt), `2` a usage or configuration failure (a missing token, a refused `--token`, an unknown option).

## Limits that are boundaries, not bugs

* **An API key has permissions, not a role.** `company_api_keys` carries no role, so `CodeRoleRegistry.roleOf`
  returns `null` for a key principal and the session-mode matrix does not apply to it (`permissionsForRole(null) =
  []`). Everything rests on the key's scopes. Giving a key a role would *widen* it, which is the opposite of what a
  scope list means — the boundary and what it would take to change it are in
  [`docs/coding-agent/ide-protocol.md`](../../docs/coding-agent/ide-protocol.md) § 2.1.
* **The CLI never decides.** `code.run.start` → `workspace:write`, `decide` → `business:manage`, the master flag and
  the run queue are all enforced server-side; a key that is not scoped for a run is refused by the API, not by this
  client.
* **An agent is never an approver.** The server refuses an approval claim from any `agent:`/`service:` principal
  before any matrix is consulted.
