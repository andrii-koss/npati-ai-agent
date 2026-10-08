// @ts-check
/**
 * C15 (owner decision 2) — the `npati code` commands.
 *
 * Scope, deliberately narrow: authenticate to the local NPATI API with a token, start a run, stream it, and answer
 * approvals in the terminal. Everything the CLI does goes through a route that already exists (or, for starting a
 * run, the one route this step adds), and the CLI itself holds no authorization decisions: it sends a token and the
 * server decides. That is what makes "the CLI token does not widen access" checkable rather than a promise — the
 * CLI has no code path that could widen anything.
 *
 * `--print-run-id` writes the run id **alone** to stdout and sends every human-readable line to stderr, so
 * `RUN=$(npati code --print-run-id …)` composes without parsing prose. Without it, the run's own output is what
 * stdout carries, and progress is stderr.
 */
import { ApiClient, ApiError, describeError } from "./api.mjs";
import { CliError, TOKEN_ENV_VAR } from "./token.mjs";

/** The default API base URL. Overridden with `--api-url` or `NPATI_API_URL`. */
export const DEFAULT_API_URL = "http://127.0.0.1:8787";

/** How long the CLI waits for events before it says the stream looks dead. Sized from the route's heartbeat. */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * @typedef {{
 *   stdout: (line: string) => void,
 *   stderr: (line: string) => void,
 *   prompt: (question: string) => Promise<string | null>,
 *   apiUrl: string,
 *   companyId: string | null,
 *   token: string,
 *   installSignalHandlers?: boolean,
 * }} CliIo
 */

/**
 * Parses `--flag value` and `--flag=value` into a map. Unknown flags are refused rather than ignored: a typo in
 * `--projct` that silently starts a run in a default project is the kind of failure a terminal tool must not have.
 *
 * @param {readonly string[]} args
 * @param {readonly string[]} booleanFlags
 * @param {readonly string[]} valueFlags
 * @returns {{ values: Record<string, string>, positionals: string[] }}
 */
export function parseArguments(args, booleanFlags, valueFlags) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {string[]} */
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (booleanFlags.includes(name)) {
      if (equals !== -1) values[name] = argument.slice(equals + 1);
      else values[name] = "true";
      continue;
    }
    if (valueFlags.includes(name)) {
      if (equals !== -1) {
        values[name] = argument.slice(equals + 1);
        continue;
      }
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliError("invalid_arguments", `${name} needs a value`, { details: { flag: name } });
      }
      values[name] = next;
      index += 1;
      continue;
    }
    throw new CliError("unknown_flag", `Unknown option ${name}. Run \`npati code --help\` for the accepted options.`, {
      details: { flag: name },
    });
  }
  return { values, positionals };
}

/**
 * @param {Record<string, string>} values
 * @param {string} name
 * @param {string[]} fallbackEnv
 * @returns {string}
 */
function required(values, name, fallbackEnv) {
  const fromFlag = values[name];
  if (fromFlag && fromFlag.trim()) return fromFlag.trim();
  for (const key of fallbackEnv) {
    const fromEnv = process.env[key];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  }
  throw new CliError(
    "invalid_arguments",
    `${name} is required (pass it, or set ${fallbackEnv.join(" / ")}).`,
    { details: { flag: name, env: fallbackEnv } },
  );
}

/**
 * @param {CliIo} io
 * @param {string} message
 */
function info(io, message) {
  io.stderr(message);
}

/**
 * `npati code run` — start a run and follow it.
 *
 * @param {CliIo} io
 * @param {readonly string[]} args
 * @returns {Promise<number>}
 */
export async function runCommand(io, args) {
  const { values, positionals } = parseArguments(
    args,
    ["--read-only", "--print-run-id", "--no-follow", "--help"],
    ["--project", "--session", "--company", "--api-url", "--prompt", "--message", "--token-file", "--from-seq"],
  );
  if (values["--help"]) {
    io.stdout(helpText());
    return 0;
  }
  // The prompt may be a positional (the common case: `npati code "fix the tests"`) or a flag, so that a
  // multi-line prompt from a file or a pipe is equally expressible.
  const prompt = (values["--prompt"] ?? values["--message"] ?? positionals.join(" ")).trim();
  if (!prompt) {
    throw new CliError("invalid_arguments", "A prompt is required: npati code run \"<what to do>\"");
  }
  const projectId = required(values, "--project", ["NPATI_PROJECT_ID"]);
  const companyId = required(values, "--company", ["NPATI_COMPANY_ID"]);
  const client = new ApiClient({
    baseUrl: values["--api-url"] ?? process.env.NPATI_API_URL ?? io.apiUrl,
    token: io.token,
  });

  const started = await client.startRun({
    companyId,
    projectId,
    sessionId: values["--session"] ?? null,
    prompt,
    readOnly: values["--read-only"] === "true",
  });
  const runId = started.run.runId;
  if (values["--print-run-id"] === "true") {
    // The id alone on stdout: a script may capture it, and everything human stays on stderr.
    io.stdout(runId);
  }
  info(io, `run ${runId} started (session ${started.run.sessionId}, project ${started.run.projectId})`);

  if (values["--no-follow"] === "true") {
    info(io, `follow it with: npati code watch --run ${runId} --company ${companyId}`);
    return 0;
  }
  return followRun(io, client, {
    companyId,
    runId,
    fromSeq: values["--from-seq"] ? Number(values["--from-seq"]) : 0,
  });
}

/**
 * `npati code watch` — reattach to a run that is already going (a closed terminal, a second window).
 *
 * @param {CliIo} io
 * @param {readonly string[]} args
 * @returns {Promise<number>}
 */
export async function watchCommand(io, args) {
  const { values } = parseArguments(
    args,
    ["--help"],
    ["--run", "--company", "--api-url", "--from-seq", "--token-file", "--poll"],
  );
  if (values["--help"]) {
    io.stdout(helpText());
    return 0;
  }
  const runId = required(values, "--run", ["NPATI_RUN_ID"]);
  const companyId = required(values, "--company", ["NPATI_COMPANY_ID"]);
  const client = new ApiClient({
    baseUrl: values["--api-url"] ?? process.env.NPATI_API_URL ?? io.apiUrl,
    token: io.token,
  });
  if (values["--poll"] === "true") {
    // The polling fallback over `…/background`: the same registry read without SSE, which is what a buffering
    // proxy or a restrictive corporate network needs.
    for (;;) {
      const read = await client.readBackgroundRun({ companyId, runId, fromSeq: 0 });
      info(io, `run ${runId}: ${read.status} (lastSeq ${read.run.lastSeq})`);
      if (read.status !== "live") {
        for (const event of read.events) renderEvent(io, event.event, event.data);
        return read.run.status === "completed" ? 0 : 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return followRun(io, client, { companyId, runId, fromSeq: values["--from-seq"] ? Number(values["--from-seq"]) : 0 });
}

/**
 * Subscribes to the **existing** background-run SSE route and renders it. Returns the run's exit code: `0` only
 * for a completed run, `1` for anything else, `2` never (a usage failure is thrown before this point).
 *
 * @param {CliIo} io
 * @param {ApiClient} client
 * @param {{ companyId: string, runId: string, fromSeq: number }} input
 * @returns {Promise<number>}
 */
export async function followRun(io, client, input) {
  const controller = new AbortController();
  let exitCode = 1;
  let settled = false;
  /** @type {(() => void) | null} */
  let abortFn = null;

  /** @type {Promise<void>} */
  const finished = new Promise((resolve) => {
    client
      .streamBackgroundRun({
        companyId: input.companyId,
        runId: input.runId,
        fromSeq: input.fromSeq,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.event === "terminal") {
            settled = true;
            const status = event.data && typeof event.data === "object" ? event.data.status : null;
            exitCode = status === "completed" ? 0 : 1;
            info(io, `run ${input.runId} ended: ${status ?? "unknown"}${event.data?.reason ? ` (${event.data.reason})` : ""}`);
          }
          if (event.event === "end") settled = true;
          renderEvent(io, event.event, event.data);
        },
        onError: (error) => {
          settled = true;
          info(io, `stream error — ${describeError(error, io.token)}`);
          resolve();
        },
        onEnd: () => {
          if (!settled) info(io, `stream closed before the run reported a terminal state; the run itself is unaffected.`);
          resolve();
        },
      })
      .then((abort) => { abortFn = abort; })
      .catch((error) => {
        info(io, `could not subscribe to the run stream — ${describeError(error, io.token)}`);
        resolve();
      });
    /**
     * Ctrl-C detaches the **viewer**, never the run: a run that survives a closed tab surviving a Ctrl-C is the
     * whole point of the background registry, and the CLI must not turn a lost terminal into a killed task.
     */
    if (io.installSignalHandlers !== false) {
      process.once("SIGINT", () => {
        info(io, "detached (the run keeps going; use the Stop route to stop it)");
        abortFn?.();
        controller.abort(new Error("the CLI was interrupted"));
        resolve();
      });
    }
  });

  await finished;
  return exitCode;
}

/**
 * Renders one stream event. `delta` is the model's own words, so it goes to stdout as it arrives; everything else is
 * a status line on stderr, which keeps `npati code … > answer.txt` usable.
 *
 * @param {CliIo} io
 * @param {string} event
 * @param {any} data
 */
export function renderEvent(io, event, data) {
  if (event === "delta") {
    const text = typeof data?.delta === "string" ? data.delta : typeof data?.text === "string" ? data.text : "";
    if (text) io.stdout(text);
    return;
  }
  if (event === "progress") {
    info(io, `· ${data?.routed ?? "progress"}${data?.intent ? ` ${data.intent}` : ""}`);
    return;
  }
  if (event === "result") {
    const run = data?.run;
    if (run && typeof run === "object") {
      if (typeof run.message === "string" && run.message) io.stdout(run.message);
      if (typeof run.status === "string") info(io, `result: ${run.status}`);
    }
    return;
  }
  if (event === "terminal") {
    return;
  }
  if (event === "end" || event === "state" || event === "error") {
    const shown = event === "error" ? data?.error?.message ?? data?.message ?? "error" : JSON.stringify(data);
    info(io, `${event}: ${shown}`);
    return;
  }
  info(io, `${event}: ${JSON.stringify(data)}`);
}

/**
 * `npati code approvals` — list the pending approvals of a company through the **existing** route.
 *
 * @param {CliIo} io
 * @param {readonly string[]} args
 * @returns {Promise<number>}
 */
export async function approvalsCommand(io, args) {
  const { values } = parseArguments(
    args,
    ["--help", "--yes"],
    ["--company", "--status", "--api-url", "--token-file", "--decide", "--notes", "--approval"],
  );
  if (values["--help"]) {
    io.stdout(helpText());
    return 0;
  }
  const companyId = required(values, "--company", ["NPATI_COMPANY_ID"]);
  const client = new ApiClient({
    baseUrl: values["--api-url"] ?? process.env.NPATI_API_URL ?? io.apiUrl,
    token: io.token,
  });

  const decideId = values["--approval"];
  if (values["--decide"] || decideId) {
    return decideApproval(io, client, {
      companyId,
      approvalId: decideId ?? "",
      decision: values["--decide"] ?? "",
      notes: values["--notes"] ?? null,
      assumeYes: values["--yes"] === "true",
    });
  }

  const approvals = await client.listApprovals({ companyId, status: values["--status"] ?? "pending" });
  if (approvals.length === 0) {
    info(io, "no approvals match");
    return 0;
  }
  for (const approval of approvals) {
    io.stdout(
      [
        String(approval.id ?? "(no id)"),
        String(approval.status ?? "?"),
        String(approval.riskLevel ?? "-"),
        String(approval.toolName ?? "-"),
        typeof approval.runId === "string" ? `run=${approval.runId}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    );
  }
  info(io, `${approvals.length} approval(s). Decide one with: npati code approvals --approval <id> --decide approved`);
  return 0;
}

/**
 * Decides one approval through the **existing** decide route — which audits before applying and releases a paused
 * run. The `--yes` flag exists because the decision is irreversible: without it, the CLI asks.
 *
 * @param {CliIo} io
 * @param {ApiClient} client
 * @param {{ companyId: string, approvalId: string, decision: string, notes: string | null, assumeYes: boolean }} input
 * @returns {Promise<number>}
 */
export async function decideApproval(io, client, input) {
  const approvalId = input.approvalId.trim();
  if (!approvalId) throw new CliError("invalid_arguments", "Which approval? Pass --approval <id>.");
  const decision = input.decision.trim();
  if (decision !== "approved" && decision !== "rejected") {
    throw new CliError("invalid_arguments", 'Decide with --decide approved or --decide rejected.');
  }
  const approval = await client.getApproval({ companyId: input.companyId, approvalId });
  if (!approval) throw new CliError("approval_not_found", `No approval ${approvalId} in this company.`);
  io.stdout(`#${approval.id}  ${approval.toolName ?? "-"}  risk=${approval.riskLevel ?? "-"}  status=${approval.status ?? "?"}`);
  if (approval.inputPayload !== undefined) {
    io.stdout(JSON.stringify(approval.inputPayload, null, 2));
  }
  if (!input.assumeYes) {
    const answer = await io.prompt(`Type "${decision}" to confirm: `);
    if (answer === null) throw new CliError("cancelled", "No answer on stdin; the approval was not decided.", { exitCode: 1 });
    if (answer.trim() !== decision) {
      info(io, "not confirmed; nothing was decided");
      return 1;
    }
  }
  const result = await client.decideApproval({
    companyId: input.companyId,
    approvalId,
    decision,
    notes: input.notes,
  });
  io.stdout(`decided: ${result?.status ?? decision}`);
  return 0;
}

/** @returns {string} */
export function helpText() {
  return [
    "npati code — start and follow Coding Agent runs from a terminal.",
    "",
    "  npati code run \"<prompt>\" --project <id> [--company <id>] [--session <id>] [--read-only] [--print-run-id]",
    "  npati code watch --run <runId> --company <id> [--from-seq <n>] [--poll]",
    "  npati code approvals [--company <id>] [--status pending]",
    "  npati code approvals --approval <id> --decide approved|rejected [--notes <text>] [--yes]",
    "",
    "Authentication:",
    `  the token is read from ${TOKEN_ENV_VAR} or from a token file (--token-file, $NPATI_TOKEN_FILE,`,
    "  or ~/.config/npati/token). A token on the command line is refused: it would be visible to `ps`.",
    "",
    "The server decides everything: this client sends the token and the run id, and the API applies the same",
    "RBAC, feature flags, run queue and approval rules it applies to the web UI.",
  ].join("\n");
}
