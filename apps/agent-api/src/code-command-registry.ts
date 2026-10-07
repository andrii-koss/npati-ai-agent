import type { AuthContext } from "@npati/workspace";
import { createHash } from "node:crypto";
import {
  CODE_COMMANDS_DIRECTORY,
  CODE_COMMANDS_FLAG,
  CODE_COMMAND_FILE_EXTENSION,
  CodeCommandError,
  MAX_SESSION_COMMANDS,
  buildCommandExpansion,
  expandCodeCommand,
  parseCodeCommandDeclaration,
  parseCommandArguments,
  parseCommandPrompt,
  resolveCodeCommands,
  validateCommandArguments,
  type CodeCommandCandidate,
  type CodeCommandExpansion,
  type CodeCommandResolution,
  type CodeCommandScope,
  type CodeCommandSource,
  type ParsedCodeCommand,
} from "./code-commands";
import { scanTextForSecrets } from "./code-secret-scanner";

/**
 * C13 — the slash-command registry.
 *
 * **One mechanism, reused.** The registry owns no file reading of its own: it asks the *existing* C8
 * instructions loader (which in turn uses the one workspace read path the application already had) for
 * `.npati/commands/*` — the loader was extended to collect them, exactly as C13 extended it for nothing else.
 * There is no second workspace reader, no second trust check and no second feature-flag evaluator.
 *
 * **The gate order is the hook order, because it is the same problem**: a repository file must not be read
 * before somebody trusted the repository. So:
 *
 *   1. the `code.commands` sub-flag (server-side, on the execution path) — off means the loader is not called;
 *   2. project trust — an untrusted repository's command files are **not read at all**, which the test suite
 *      proves with a spy that was never called plus a read counter that stayed at zero;
 *   3. only then the files are read, parsed and offered.
 *
 * `system`/`user`/`session` commands are not repository content, so trust does not apply to them — but they go
 * through the *same* declaration parser, so the closed vocabulary is enforced identically for all four sources.
 * A user-level command does not become authorised by being a user-level command, and a repository file does not
 * become authorised by being named `review.md`.
 *
 * **Commands cannot do anything.** `resolve` returns candidates; `expand` returns text plus provenance. Neither
 * value has a member the PolicyEngine, the session-mode service, the approval scope, RBAC or the flag service
 * reads — see `code-commands.ts` for the shape argument and the test suite for the source-level assertion.
 */

/** One command file as the loader returned it. `path` is repository-relative and uses `/`. */
export interface CodeCommandFile {
  path: string;
  content: string;
}

export interface CodeCommandLoaderPort {
  /**
   * Collects the command files of this project. The loader asks for trust itself and, when the project is not
   * trusted, performs **zero** reads — the registry never reads a file on its own initiative.
   */
  collectCommands(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    targetPaths?: readonly string[];
    /** Command ids to probe for. Bounded by the caller; the loader never invents a name. */
    ids?: readonly string[];
  }): Promise<{ files: CodeCommandFile[]; readsAttempted: number; trusted: boolean }>;
}

export interface CodeCommandSystemEntry {
  declaration: Record<string, unknown>;
  template: string;
}

export interface CodeCommandUserEntry {
  declaration: Record<string, unknown>;
  template: string;
}

export interface CodeCommandActivityEvent {
  kind: "code_tool_activity" | "run_activity";
  companyId: string;
  projectId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  snapshotId?: string | null;
  [key: string]: unknown;
}

export interface CodeCommandRegistryDeps {
  /** The extended C8 loader. Its absence means "this deployment has no repository commands", not "read freely". */
  loader?: CodeCommandLoaderPort;
  /** Server-side feature flag reader. Called on the execution path, before anything else. */
  flags: { isEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string; userId?: string }): Promise<boolean> };
  /** Platform defaults (source `system`). Declarations are validated by the same parser as everything else. */
  systemCommands?: readonly CodeCommandSystemEntry[];
  /**
   * The command ids the **platform** knows about, used to probe `.npati/commands/<id>.{md,json}`.
   *
   * This is the bounded-discovery half of the trust story: the loader never lists a directory, so a repository
   * cannot make the harness read an arbitrary number of files. The ids come from configuration (platform, user
   * and system commands), never from repository content. Absent means `systemCommands` are the only names.
   */
  knownCommandIds?(): readonly string[];
  /** The user's own commands from `/settings`. Absent means none. */
  userCommands?(input: { ctx: AuthContext; companyId: string }): Promise<readonly CodeCommandUserEntry[]>;
  /**
   * The text a slash command expands into, if the prompt is one. Injected so this module owns the *registry* and
   * nothing else: the application passes the one implementation, which expands through the pure builder
   * (`buildCommandExpansion`) so a `/name` typed in the chat box and a command invoked through the API produce
   * the same bytes.
   */
  expandPrompt?(input: {
    prompt: string;
    resolve(id: string): CodeCommandCandidate | null;
  }): { text: string; provenance: Record<string, unknown>; refusals: readonly string[] } | null;
  /** Activity sink (metadata only). Absent records nothing; a failure never changes the outcome. */
  activity?: { record(event: CodeCommandActivityEvent): Promise<unknown> | unknown };
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
  now?: () => Date;
}

export type CodeCommandSkip = "flag_disabled" | "project_untrusted" | "no_commands";

export interface CodeCommandListResult {
  executed: boolean;
  skipped: CodeCommandSkip | null;
  commands: Array<{
    id: string;
    description: string;
    version: number;
    hash: `sha256:${string}`;
    source: CodeCommandSource;
    scope: CodeCommandScope;
    argumentHint: string;
    arguments: Array<{ name: string; type: string; required: boolean; description: string }>;
  }>;
  collisions: CodeCommandResolution["collisions"];
  /** Codes of the claims that were refused (`command_injection_refused`, …). Never template text. */
  refusals: string[];
  /** How many files the loader was asked to read. Zero is the proof of the trust gate. */
  readsAttempted: number;
}

export interface CodeCommandExpandResult {
  executed: boolean;
  skipped: CodeCommandSkip | null;
  expansion: CodeCommandExpansion | null;
  refusals: string[];
  /** The resolved command's own tool narrowing, surfaced for the caller. Still not a grant. */
  allowedTools: readonly string[];
  forbiddenTools: readonly string[];
  readsAttempted: number;
}

export interface RegisteredSessionCommand {
  declaration: Record<string, unknown>;
  template: string;
}

const COMMAND_PATH_PATTERN = new RegExp(`^${CODE_COMMANDS_DIRECTORY.replace(".", "\\.")}/([a-z][a-z0-9:_-]{0,63})\\.(md|json)$`);

/** The command id a repository path declares, or `null` when the path is not a command file. */
export function commandIdFromPath(path: string): string | null {
  const normalized = String(path ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
  const match = COMMAND_PATH_PATTERN.exec(normalized);
  return match ? match[1]! : null;
}

/** Parses the two accepted command-file shapes: a `json` declaration, or Markdown with a `---` JSON header. */
export function parseCommandFile(file: CodeCommandFile): { declaration: Record<string, unknown>; template: string } {
  const id = commandIdFromPath(file.path);
  if (!id) {
    throw new CodeCommandError("command_declaration_invalid", `Not a command file: ${file.path}`, 400, { path: file.path });
  }
  const text = String(file.content ?? "");
  if (file.path.endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CodeCommandError("command_declaration_invalid", `Command file ${file.path} is not valid JSON`, 400, { path: file.path });
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new CodeCommandError("command_declaration_invalid", `Command file ${file.path} must contain an object`, 400, { path: file.path });
    }
    const body = parsed as Record<string, unknown>;
    if (typeof body.template !== "string") {
      throw new CodeCommandError("command_declaration_invalid", `Command file ${file.path} declares no template`, 400, { path: file.path });
    }
    const { template, ...declaration } = body;
    // The file name is the id unless the declaration states one, and a declared id that disagrees with the file
    // name is a refusal: the two names would otherwise differ between the listing and the expansion.
    if (declaration.id !== undefined && declaration.id !== id) {
      throw new CodeCommandError("command_declaration_invalid", `Command file ${file.path} declares the id ${String(declaration.id)}`, 400, {
        path: file.path, id: declaration.id, expected: id,
      });
    }
    return { declaration: { id, ...declaration }, template };
  }

  // Markdown: an optional `---`-fenced JSON header, then the template. A file without a header is accepted as a
  // template with a minimal declaration, which keeps the common case (one file, a body) usable without a
  // second file format.
  const headerMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!headerMatch) return { declaration: { id }, template: text };
  let header: unknown;
  try {
    header = JSON.parse(headerMatch[1]!);
  } catch {
    throw new CodeCommandError("command_declaration_invalid", `Command file ${file.path} has an unparseable header`, 400, { path: file.path });
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new CodeCommandError("command_declaration_invalid", `Command file ${file.path} header must be an object`, 400, { path: file.path });
  }
  const body = text.slice(headerMatch[0].length);
  return { declaration: { id, ...(header as Record<string, unknown>) }, template: body };
}

/** A candidate is built only from a successfully parsed declaration; a refusal never yields a half-command. */
function candidateFrom(input: {
  source: CodeCommandSource;
  scope: CodeCommandScope;
  parsed: ParsedCodeCommand;
  path?: string;
  trusted?: boolean | null;
}): CodeCommandCandidate {
  return {
    source: input.source,
    scope: input.scope,
    version: input.parsed.declaration.version,
    hash: input.parsed.hash,
    template: input.parsed.template,
    declaration: input.parsed.declaration,
    ...(input.path ? { path: input.path } : {}),
    ...(input.trusted === undefined ? {} : { trusted: input.trusted }),
  };
}

function assertNoSecretInTemplate(id: string, template: string): void {
  const scan = scanTextForSecrets(template);
  if (scan.findings.length > 0) {
    // Refused, never redacted: the same position C10 takes for a summary and C13 takes for a hook result. A
    // redacted template would hide the leak from the person who can fix the file.
    throw new CodeCommandError("command_secret_refused", `Command ${id} template contains a value that looks like a credential`, 403, {
      id, kinds: Array.from(new Set(scan.findings.map((finding) => finding.kind))),
    });
  }
}

export interface CodeCommandRegistry {
  resolve(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    sessionId?: string;
    targetPaths?: readonly string[];
  }): Promise<CodeCommandListResult>;
  expand(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    sessionId?: string;
    id: string;
    arguments?: Record<string, unknown> | null;
    targetPaths?: readonly string[];
  }): Promise<CodeCommandExpandResult>;
  /** Session-scoped commands. The only source that appears at run time; bound and duplicate-checked. */
  registerSessionCommand(input: {
    ctx: AuthContext;
    companyId: string;
    sessionId: string;
    declaration: Record<string, unknown>;
    template: string;
  }): Promise<{ registered: boolean; id: string }>;
  /**
   * C13: the prompt the model will see, plus the provenance that produced it.
   *
   * This is the surface the run loop consumes, and it exists so the loop never has to know what a slash command
   * is: the registry resolves the name against the same precedence as `expand`, expands through the same pure
   * builder, and answers with the text and the recorded provenance. A prompt that is not a slash command is
   * returned **unchanged** with empty provenance, so wiring this port cannot alter any existing run.
   *
   * A refusal (unknown command, invalid arguments, a refused template) is reported as a code and the caller's own
   * text is returned: the user's message is never silently replaced by something else, and the refusal is
   * visible rather than swallowed.
   */
  resolvePrompt(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    sessionId?: string;
    prompt: string;
  }): Promise<{ text: string; provenance: Record<string, unknown>[]; refusals: string[] }>;
  clearSession(sessionId: string): void;
}

export function createCodeCommandRegistry(deps: CodeCommandRegistryDeps): CodeCommandRegistry {
  const sessionCommands = new Map<string, Map<string, RegisteredSessionCommand>>();

  async function enabled(input: { ctx: AuthContext; companyId: string }): Promise<boolean> {
    try {
      return (await deps.flags.isEnabled(input.ctx, CODE_COMMANDS_FLAG, {
        companyId: input.companyId,
        userId: input.ctx.userId,
      })) === true;
    } catch {
      // Dark launch: a flag that cannot be read is `false`.
      return false;
    }
  }

  function listSession(sessionId: string | undefined): Map<string, RegisteredSessionCommand> {
    if (!sessionId) return new Map();
    return sessionCommands.get(sessionId) ?? new Map();
  }

  /**
   * Builds every candidate this invocation can see, refusing individually.
   *
   * A single broken project file does not take the other commands down — which is the *opposite* of the hook
   * config rule, and deliberately so: a hooks config is one file whose author meant one thing, while a command
   * directory is many independent files, and refusing `review` because an unrelated `deploy.md` is malformed
   * would make the feature unusable for no security gain. Every refusal is reported as its code.
   */
  async function collect(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    sessionId?: string;
    targetPaths?: readonly string[];
    /**
     * Extra ids to probe beside the platform's declared ones. The one place this is used is a `/slash` prompt,
     * which names its own command: the hint is still probed **by name** (never by listing a directory) and the
     * trust gate inside the loader is unchanged.
     */
    ids?: readonly string[];
  }): Promise<{ candidates: CodeCommandCandidate[]; refusals: string[]; readsAttempted: number; trusted: boolean; skipped: CodeCommandSkip | null }> {
    const candidates: CodeCommandCandidate[] = [];
    const refusals: string[] = [];
    let readsAttempted = 0;
    let trusted = false;

    const add = (source: CodeCommandSource, scope: CodeCommandScope, entry: { declaration: Record<string, unknown>; template: string }, path?: string): void => {
      try {
        assertNoSecretInTemplate(String(entry.declaration.id ?? "unknown"), entry.template);
        const parsed = parseCodeCommandDeclaration(entry.declaration, entry.template);
        candidates.push(candidateFrom({ source, scope, parsed, ...(path ? { path } : {}), ...(source === "project" ? { trusted } : {}) }));
      } catch (error) {
        const code = error instanceof CodeCommandError ? error.code : "command_declaration_invalid";
        refusals.push(code);
        log({ code, source, ...(path ? { path } : {}) }, "code_command_refused");
      }
    };

    for (const entry of deps.systemCommands ?? []) add("system", "platform", entry);
    if (deps.userCommands) {
      try {
        for (const entry of await deps.userCommands({ ctx: input.ctx, companyId: input.companyId })) add("user", "user", entry);
      } catch {
        // User settings that cannot be read yield no user commands; they never fall back to the repository's.
      }
    }

    if (deps.loader) {
      const declared = deps.knownCommandIds?.() ?? [];
      const extra = (input.ids ?? []).filter((id) => !declared.includes(id));
      const repository = await collectRepositoryCommands({ ...input, ids: [...declared, ...extra] });
      readsAttempted = repository.readsAttempted;
      refusals.push(...repository.refusals);
      trusted = repository.trusted;
      // A repository that is not trusted contributes **nothing** — not even its parsed declarations — because
      // `collectRepositoryCommands` returned before reading a byte. `trusted` travels on so the caller can tell
      // "the project is untrusted" from "the project declares no commands".
      if (trusted) candidates.push(...repository.candidates);
      else if (!deps.systemCommands?.length && !listSession(input.sessionId).size) {
        return { candidates, refusals, readsAttempted, trusted, skipped: "project_untrusted" };
      }
    }

    for (const entry of listSession(input.sessionId).values()) add("session", "session", entry);
    return { candidates, refusals, readsAttempted, trusted, skipped: candidates.length === 0 ? "no_commands" : null };
  }

  /**
   * The repository half of `collect`, called twice at most: once for the platform's declared command names, and
   * once for the single name a `/slash` prompt actually named. Splitting it out is what keeps the *trust gate*
   * in one place: both callers go through the loader, which asks trust before its first read, so a hinted name
   * is subject to exactly the same gate as a declared one.
   */
  async function collectRepositoryCommands(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    targetPaths?: readonly string[];
    ids: readonly string[];
  }): Promise<{ candidates: CodeCommandCandidate[]; refusals: string[]; readsAttempted: number; trusted: boolean }> {
    const candidates: CodeCommandCandidate[] = [];
    const refusals: string[] = [];
    if (!deps.loader) return { candidates, refusals, readsAttempted: 0, trusted: false };
    try {
      const collected = await deps.loader.collectCommands({
        ctx: input.ctx,
        companyId: input.companyId,
        projectId: input.projectId,
        ...(input.targetPaths === undefined ? {} : { targetPaths: input.targetPaths }),
        ids: input.ids,
      });
      if (!collected.trusted) {
        // The loader answered "not trusted" with zero reads. Nothing below ran, and the count says so.
        return { candidates, refusals, readsAttempted: collected.readsAttempted, trusted: false };
      }
      for (const file of collected.files) {
        try {
          const entry = parseCommandFile(file);
          assertNoSecretInTemplate(String(entry.declaration.id ?? commandIdFromPath(file.path) ?? "unknown"), entry.template);
          const parsed = parseCodeCommandDeclaration(entry.declaration, entry.template);
          candidates.push(candidateFrom({ source: "project", scope: "repository", parsed, path: file.path, trusted: true }));
        } catch (error) {
          const code = error instanceof CodeCommandError ? error.code : "command_declaration_invalid";
          refusals.push(code);
          log({ code, path: file.path }, "code_command_file_refused");
        }
      }
      return { candidates, refusals, readsAttempted: collected.readsAttempted, trusted: true };
    } catch {
      return { candidates, refusals: [...refusals, "command_declaration_invalid"], readsAttempted: 0, trusted: false };
    }
  }

  function log(payload: Record<string, unknown>, message: string): void {
    deps.logger?.warn({ ...payload, commandSubsystem: "code_commands" }, message);
  }

  /**
   * Activity: **what happened**, never what was said. Command ids, sources, versions, hashes, counts — no
   * template text, no argument values, and therefore no secret. The companion suite writes these through the
   * real sink to prove that claim rather than asserting it.
   */
  async function recordActivity(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    sessionId?: string;
    runId?: string | null;
    snapshotId?: string | null;
    extra: Record<string, unknown>;
  }): Promise<void> {
    const activity = deps.activity;
    if (!activity) return;
    try {
      await activity.record({
        kind: "run_activity",
        companyId: input.companyId,
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        snapshotId: input.snapshotId ?? null,
        ...input.extra,
      });
    } catch {
      // Bookkeeping never changes a decision and never breaks a run.
    }
  }

  return {
    async resolvePrompt(input) {
      const untouched = { text: input.prompt, provenance: [] as Record<string, unknown>[], refusals: [] as string[] };
      const parsed = parseCommandPrompt(input.prompt);
      if (!parsed) return untouched;
      if (!(await enabled(input))) return { ...untouched, refusals: ["command_flag_disabled"] };
      // The id the user typed is also a discovery hint: a project command may exist that no platform default
      // named. The loader probes it by name (never by listing) and the trust gate inside it still applies.
      const collected = await collect({ ...input, ids: [parsed.id] });
      const resolution = resolveCodeCommands(collected.candidates);
      const winner = resolution.resolved.find((candidate) => candidate.declaration.id === parsed.id);
      if (!winner) {
        await recordActivity({
          ...input,
          extra: { commandAction: "resolve_prompt", commandId: parsed.id, result: "not_found", refusalCount: collected.refusals.length },
        });
        return { ...untouched, refusals: [...collected.refusals, "command_not_found"] };
      }
      try {
        // The **same** validator the API path uses: the grammar only produces `name=value` pairs, and this call
        // is what enforces the declared types, enum membership, patterns and value bounds.
        const values = validateCommandArguments(winner.declaration, parseCommandArguments(winner.declaration, parsed.rest));
        const built = buildCommandExpansion({
          declaration: winner.declaration,
          template: winner.template,
          allowedTools: winner.declaration.allowedTools,
          forbiddenTools: winner.declaration.forbiddenTools,
          values,
          provenanceLine: `source: ${winner.source}, scope: ${winner.scope}, version: ${winner.version}, hash: ${winner.hash}`,
        });
        const provenance = {
          id: winner.declaration.id,
          commandSource: winner.source,
          commandScope: winner.scope,
          commandVersion: winner.version,
          commandHash: winner.hash,
          contentHash: `sha256:${createHash("sha256").update(built.text, "utf8").digest("hex")}`,
          argumentNames: built.argumentNames,
          chars: built.text.length,
        };
        await recordActivity({
          ...input,
          extra: {
            commandAction: "resolve_prompt",
            commandId: provenance.id,
            commandSource: provenance.commandSource,
            commandScope: provenance.commandScope,
            commandVersion: provenance.commandVersion,
            commandHash: provenance.commandHash,
            contentHash: provenance.contentHash,
            argumentCount: built.argumentNames.length,
            chars: built.text.length,
            readsAttempted: collected.readsAttempted,
            result: "ok",
          },
        });
        return { text: built.text, provenance: [provenance], refusals: [...collected.refusals] };
      } catch (error) {
        const code = error instanceof CodeCommandError ? error.code : "command_arguments_invalid";
        await recordActivity({
          ...input,
          extra: { commandAction: "resolve_prompt", commandId: parsed.id, result: "refused", code },
        });
        // The user's own text is returned unchanged: a refused expansion must never silently become a different
        // prompt. The refusal code travels with the run so the caller can report it.
        return { ...untouched, refusals: [...collected.refusals, code] };
      }
    },

    async resolve(input) {
      if (!(await enabled(input))) {
        return { executed: false, skipped: "flag_disabled", commands: [], collisions: [], refusals: [], readsAttempted: 0 };
      }
      const collected = await collect(input);
      const resolution = resolveCodeCommands(collected.candidates);
      const commands = resolution.resolved
        .map((candidate) => ({
          id: candidate.declaration.id,
          description: candidate.declaration.description,
          version: candidate.version,
          hash: candidate.hash,
          source: candidate.source,
          scope: candidate.scope,
          argumentHint: candidate.declaration.argumentHint,
          arguments: candidate.declaration.args.map((arg) => ({ name: arg.name, type: arg.type, required: arg.required, description: arg.description })),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      await recordActivity({
        ...input,
        extra: {
          commandAction: "resolve",
          commandCount: commands.length,
          collisionCount: resolution.collisions.length,
          refusalCount: collected.refusals.length,
          readsAttempted: collected.readsAttempted,
        },
      });
      return {
        executed: true,
        skipped: collected.skipped === "project_untrusted" && commands.length === 0 ? "project_untrusted" : collected.skipped,
        commands,
        collisions: resolution.collisions,
        refusals: collected.refusals,
        readsAttempted: collected.readsAttempted,
      };
    },

    async expand(input) {
      if (!(await enabled(input))) {
        return { executed: false, skipped: "flag_disabled", expansion: null, refusals: [], allowedTools: [], forbiddenTools: [], readsAttempted: 0 };
      }
      const collected = await collect(input);
      const resolution = resolveCodeCommands(collected.candidates);
      const winner = resolution.resolved.find((candidate) => candidate.declaration.id === input.id);
      if (!winner) {
        await recordActivity({
          ...input,
          extra: { commandAction: "expand", commandId: input.id, result: "not_found", refusals: collected.refusals.length },
        });
        throw new CodeCommandError("command_not_found", `No slash command named /${input.id} is available`, 404, {
          id: input.id,
          sources: resolution.resolved.map((candidate) => candidate.source),
        });
      }
      const expansion = expandCodeCommand({
        command: winner,
        ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
      });
      await recordActivity({
        ...input,
        extra: {
          commandAction: "expand",
          commandId: expansion.id,
          commandSource: expansion.provenance.source,
          commandScope: expansion.provenance.scope,
          commandVersion: expansion.provenance.version,
          commandHash: expansion.provenance.hash,
          contentHash: expansion.contentHash,
          argumentsHash: expansion.argumentsHash,
          argumentCount: expansion.argumentNames.length,
          chars: expansion.chars,
          result: "ok",
        },
      });
      return {
        executed: true,
        skipped: null,
        expansion,
        refusals: collected.refusals,
        allowedTools: winner.declaration.allowedTools,
        forbiddenTools: winner.declaration.forbiddenTools,
        readsAttempted: collected.readsAttempted,
      };
    },

    async registerSessionCommand(input) {
      const id = typeof input.declaration.id === "string" ? input.declaration.id : "";
      assertNoSecretInTemplate(id || "unknown", input.template);
      const parsed = parseCodeCommandDeclaration(input.declaration, input.template);
      const existing = sessionCommands.get(input.sessionId);
      if (!existing && sessionCommands.size >= 1_000) {
        throw new CodeCommandError("command_not_allowed", "Too many sessions hold registered commands", 429);
      }
      const bucket = existing ?? new Map<string, RegisteredSessionCommand>();
      if (bucket.size >= MAX_SESSION_COMMANDS && !bucket.has(parsed.declaration.id)) {
        throw new CodeCommandError("command_not_allowed", `A session may register at most ${MAX_SESSION_COMMANDS} commands`, 429, {
          sessionId: input.sessionId, limit: MAX_SESSION_COMMANDS,
        });
      }
      bucket.set(parsed.declaration.id, { declaration: input.declaration, template: input.template });
      sessionCommands.set(input.sessionId, bucket);
      return { registered: true, id: parsed.declaration.id };
    },

    clearSession(sessionId) {
      sessionCommands.delete(sessionId);
    },
  };
}
