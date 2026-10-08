// @ts-check
/**
 * C15 (owner decision 2) — `npati` entry point: argument dispatch, token resolution and the one place a process
 * exit code is decided.
 *
 * `main` takes its IO as a parameter so the whole command surface is exercisable without a terminal, a process or a
 * network: the suite drives it with a recording `stdout`/`stderr` and a `fetch` stand-in. The binary is a three-line
 * shim that imports this module and exits with what `main` returned, so there is no second copy of the dispatch.
 *
 * Dispatch is deliberately small and total:
 *
 *   `npati help`                       → help, exit 0
 *   `npati code run "<prompt>" …`      → start a run and follow it
 *   `npati code "<prompt>" …`          → the same, because `code` + a prompt is unambiguous
 *   `npati code watch …`               → reattach to a run
 *   `npati code approvals …`           → list or decide an approval
 *   `npati <anything else>`            → a prompt for `run`
 */
import { approvalsCommand, DEFAULT_API_URL, helpText, runCommand, watchCommand } from "./commands.mjs";
import { CliError, redactText, refuseTokenArgument, resolveToken, TOKEN_ENV_VAR } from "./token.mjs";

/** The sub-commands of `npati code`. Anything else after `code` is a prompt. */
export const CODE_COMMANDS = ["run", "watch", "approvals"];

/**
 * @typedef {{
 *   stdout: (line: string) => void,
 *   stderr: (line: string) => void,
 *   apiUrl: string,
 *   companyId: string | null,
 *   token: string,
 *   prompt: (question: string) => Promise<string | null>,
 *   installSignalHandlers: boolean,
 * }} CliIo
 */

/**
 * @param {{
 *   argv?: readonly string[],
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   stdin?: { read: () => Promise<string | null> },
 *   env?: NodeJS.ProcessEnv,
 *   installSignalHandlers?: boolean,
 * }} [options]
 * @returns {Promise<number>} the process exit code
 */
export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const env = options.env ?? process.env;
  /** @type {string | null} */
  let token = null;
  try {
    if (argv.includes("--version") || argv[0] === "version") {
      stdout("npati-cli 0.1.0");
      return 0;
    }

    // Order matters: a token on the command line is refused *before* anything resolves a token, so the refusal is
    // about the argument itself and never about a credential this process has already loaded.
    refuseTokenArgument(argv);

    // `npati code …` and `npati …` are the same command surface: `code` is the product's name for it, not a verb.
    const args = argv[0] === "code" ? argv.slice(1) : [...argv];
    const first = args[0] ?? "help";
    if (first === "help" || first === "--help" || first === "-h") {
      stdout(helpText());
      return 0;
    }

    /** @type {"run" | "watch" | "approvals"} */
    let command;
    /** @type {string[]} */
    let commandArgs;
    if (first === "run" || first === "watch" || first === "approvals") {
      command = first;
      commandArgs = args.slice(1);
    } else {
      // Everything else is a prompt. `npati code run …` was handled above, so this covers `npati code "…"` and a
      // bare `npati "…"`, which is what makes the shortest useful invocation the obvious one.
      command = "run";
      commandArgs = args;
    }

    const tokenFile = readOption(commandArgs, "--token-file");
    const resolved = resolveToken({ env, ...(tokenFile ? { tokenFile } : {}) });
    token = resolved.token;
    const io = {
      stdout,
      stderr,
      apiUrl: readOption(commandArgs, "--api-url") ?? env.NPATI_API_URL ?? DEFAULT_API_URL,
      companyId: readOption(commandArgs, "--company"),
      token,
      prompt: options.stdin ? () => /** @type {{ read: () => Promise<string | null> }} */ (options.stdin).read() : defaultPrompt,
      installSignalHandlers: options.installSignalHandlers ?? true,
    };
    if (command === "run") return await runCommand(io, commandArgs);
    if (command === "watch") return await watchCommand(io, commandArgs);
    return await approvalsCommand(io, commandArgs);
  } catch (error) {
    const known = error instanceof CliError ? error : null;
    const code = known?.code ?? "cli_failed";
    // The message is redacted with the token this process holds, so no error path can print a credential.
    const message = redactText(error instanceof Error ? error.message : String(error), token);
    stderr(`${code}: ${message}`);
    if (known?.code === "token_missing" || known?.code === "token_empty") {
      stderr(`hint: export ${TOKEN_ENV_VAR}=<token>, or write it to the file named above.`);
    }
    return known?.exitCode ?? 1;
  }
}

/**
 * @param {readonly string[]} args
 * @param {string} name
 * @returns {string | null}
 */
function readOption(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === name) return args[index + 1] ?? null;
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
  }
  return null;
}

/**
 * Reads one line from the terminal, for the approval confirmation. A closed stdin answers `null`, which the caller
 * treats as "not confirmed" rather than as consent.
 *
 * @param {string} question
 * @returns {Promise<string | null>}
 */
function defaultPrompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(chunk.toString("utf8").trim());
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
    process.stdin.once("end", () => resolve(null));
    process.stdin.once("error", () => resolve(null));
  });
}
