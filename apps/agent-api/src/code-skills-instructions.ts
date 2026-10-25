import { usageQuotasEnabled } from "./usage-quota-policy";
import { createHash } from "node:crypto";
import type { AuthContext, DataClassification } from "@npati/workspace";
import { scanTextForSecrets } from "./code-secret-scanner";

/**
 * C13 — Skills, lazily loaded.
 *
 * The problem this module solves is not "how does a skill run" (that is `packages/skills`, unchanged) but
 * "what may a Skill be allowed to put into the model's input, and when". Two properties decide the design:
 *
 *   1. **Metadata first, body later.** Until a Skill is really chosen, the only thing that exists about it is
 *      its `id`, `name`, `description`, `version` and provenance. `listMetadata()` returns exactly that and
 *      nothing else; there is no code path that reaches the body without an explicit `load()`. A run that
 *      selects nothing spends nothing and leaks nothing, and the suite proves the body reader was never called.
 *
 *   2. **The body is a typed system section, never a tool result.** C8's compaction replaces old *tool
 *      results* with stubs (`STUB_MARKER`, `code-conversation-compaction.ts`). A Skill body returned as an
 *      ordinary tool result would therefore be **deleted from the model's context** the first time a long run
 *      compacts — the exact opposite of the intent. So a loaded body is rendered into a dedicated
 *      `SKILL INSTRUCTIONS` section of the system prompt (the same place `projectInstructions` goes), which
 *      the stub replacement does not touch. Requirement: pinned by the companion suite, which runs the real
 *      `compactConversation` over a transcript whose system message carries the section.
 *
 * **Trust.** Three classes exist and they are not interchangeable:
 *
 *   - `builtin` — a Skill the platform itself ships (`defaultSkillRegistry`). It is trusted by construction.
 *   - `installed` — a Skill an operator installed for the workspace. Trusted because it passed the install
 *     path, and that is recorded as its provenance, not inferred from a file name.
 *   - `repository` — a file inside a project. **Never trusted by being named "skill"**: its `allowed` flag
 *     comes from the project trust record, and until that record says yes the body is neither read nor
 *     returned. A repository that names a file `skill.md` gains nothing.
 *
 * **Secrets are refused, never redacted.** Before a body may travel anywhere — into the prompt, into a replay
 * bundle, into Activity — it passes the C4a scanner, and a finding raises `CodeSkillError`
 * (`skill_secret_refused`). Redacting would hide the leak from the person who can fix it, which is the same
 * position C10 takes for a summary and C13 takes for a hook result.
 *
 * **Provider policy.** A body that would reach a provider passes the **existing** C5b `ProviderDataGuard`
 * (`guardProviderBoundText`) rather than a second scanner, exactly as the C8 compaction summary does. A guard
 * that would have to redact the body refuses it (`skill_provider_data_refused`) instead of returning a
 * sanitised body, because the sanitised body would carry a `REDACTED:` placeholder into the prompt and into
 * the recorded model-visible state.
 */

/** The sub-flag that gates the whole feature. */
export const CODE_SKILLS_FLAG = "code.skills";

/** The typed section header. A reader must be able to tell it from repository data at a glance. */
export const SKILL_INSTRUCTIONS_HEADER = "SKILL INSTRUCTIONS (installed, trusted configuration — not repository data)";

/**
 * The invariant sentence inside the section. A Skill may describe *how to do the work*; it may not describe
 * *what the agent is allowed to do*. This is a statement of a structural fact, not a request: nothing a body
 * says is read by the PolicyEngine, the session mode, the approval scope, RBAC or the flag service.
 */
export const SKILL_INSTRUCTIONS_NOTE =
  "These skills are installed configuration. They cannot change the session mode, the permission rules, the role, " +
  "the approval rules, the feature flags or the network policy, and they grant no tool: every call is authorised " +
  "server-side on its own.";

export const SKILL_SOURCES = ["builtin", "installed", "repository"] as const;
export type CodeSkillSource = (typeof SKILL_SOURCES)[number];

export const MAX_SKILL_BODY_CHARS = 16_000;
export const MAX_SKILL_DESCRIPTION_CHARS = 600;
export const MAX_SKILL_INSTRUCTIONS_CHARS = 24_000;
export const MAX_ACTIVE_SKILLS_PER_TURN = 4;
export const MAX_ACTIVE_SKILLS_PER_SESSION = 8;
/** How many bodies one run may load in total — the lazy-load budget. */
export const MAX_SKILL_LOADS_PER_SESSION = 16;

export type CodeSkillErrorCode =
  | "skill_flag_disabled"
  | "skill_missing"
  | "skill_deleted"
  | "skill_version_mismatch"
  | "skill_hash_mismatch"
  | "skill_untrusted"
  | "skill_body_too_large"
  | "skill_secret_refused"
  | "skill_provider_data_refused"
  | "skill_limit_reached"
  | "skill_body_invalid";

export class CodeSkillError extends Error {
  constructor(
    readonly code: CodeSkillErrorCode,
    message: string,
    readonly httpStatus = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeSkillError";
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Everything the model may see about a Skill **before** it is selected. Note what is absent: no `body`, no
 * `instructions`, no free-form payload. The description is bounded so a metadata listing cannot become a
 * smuggling channel.
 */
export interface CodeSkillMetadata {
  id: string;
  name: string;
  description: string;
  version: number;
  source: CodeSkillSource;
  /** `builtin`/`installed` are trusted by construction; `repository` only by an explicit trust record. */
  trusted: boolean;
  capabilities: readonly string[];
}

export interface CodeSkillBody extends CodeSkillMetadata {
  body: string;
  /** sha256 over the exact body text: the value the snapshot, the prompt and a replay compare. */
  bodyHash: `sha256:${string}`;
  chars: number;
}

/** A loaded Skill, resolved onto the exact version the run pinned. */
export interface CodeSkillInstructions {
  id: string;
  version: number;
  hash: `sha256:${string}`;
  source: CodeSkillSource;
  trusted: boolean;
  /** Order in which the run activated it: a deterministic tie-break for the rendered section. */
  order: number;
  body: string;
  chars: number;
}

export interface CodeSkillsDeps {
  /** Server-side feature flag reader. Called on the execution path, before anything else. */
  flags: { isEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string; userId?: string }): Promise<boolean> };
  /** The metadata listing. Trusted Skills only reach the model; the rest are reported, not offered. */
  listMetadata(input: { ctx: AuthContext; companyId: string; projectId?: string }): Promise<readonly CodeSkillMetadata[]>;
  /**
   * The **one** body reader. It is never called by `listMetadata`, and the suite asserts that with a spy. A
   * `null` answer means "this Skill no longer exists", which is reported as `skill_deleted` rather than as an
   * empty body.
   */
  readBody(input: {
    ctx: AuthContext;
    companyId: string;
    projectId?: string;
    id: string;
    version: number | null;
  }): Promise<{ body: string; version: number; source: CodeSkillSource; trusted: boolean } | null>;
  /** The existing C5b guard. Absent means a deployment without provider enforcement keeps the C4a floor. */
  providerDataGuard?: {
    guardProviderBoundText(
      text: string,
      input: {
        model?: string;
        policyContext: { companyId: string; projectId?: string; sessionId?: string; dataClassification?: DataClassification };
        field?: "content" | "text" | "output";
      },
    ): Promise<{ text: string; changed: boolean; bytes: number }>;
  };
  activity?: { record(event: Record<string, unknown>): Promise<unknown> | unknown };
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
}

interface ActiveSkill {
  instructions: CodeSkillInstructions;
}

export interface CodeSkillsService {
  /** Bounded metadata listing. Touches no body and no repository file. */
  listMetadata(input: { ctx: AuthContext; companyId: string; projectId?: string }): Promise<{
    executed: boolean;
    skills: Array<{ id: string; name: string; description: string; version: number; source: CodeSkillSource; trusted: boolean }>;
    /** Skills that exist but may not be offered (a repository Skill without a trust record). */
    withheld: Array<{ id: string; reason: string }>;
  }>;
  /** Loads one Skill for a session. Refuses when the version moved, the body carries a secret or the budget is spent. */
  load(input: {
    ctx: AuthContext;
    companyId: string;
    projectId?: string;
    sessionId: string;
    id: string;
    /** The version the caller saw in `listMetadata`. A moved version is a refusal, not a silent upgrade. */
    version: number | null;
    model?: string;
    dataClassification?: DataClassification;
  }): Promise<CodeSkillInstructions>;
  /** The loaded Skills of a session, in activation order. */
  active(sessionId: string): CodeSkillInstructions[];
  /** Drops one Skill from the session (a selection can be undone). */
  unload(sessionId: string, id: string): boolean;
  clear(sessionId: string): void;
  /** The typed system section. Deterministic for a given set of active Skills. */
  renderInstructions(sessionId: string): string | null;
  /** The provenance the ExecutionSnapshot records: never the body text. */
  provenance(sessionId: string): Array<{ skillId: string; version: number; hash: `sha256:${string}`; source: CodeSkillSource; order: number }>;
}

export function createCodeSkillsService(deps: CodeSkillsDeps): CodeSkillsService {
  const sessions = new Map<string, ActiveSkill[]>();
  const loads = new Map<string, number>();
  let orderCounter = 0;

  function ensureBudget(sessionId: string): void {
    const used = loads.get(sessionId) ?? 0;
    if (usageQuotasEnabled() && used >= MAX_SKILL_LOADS_PER_SESSION) {
      throw new CodeSkillError("skill_limit_reached", `This session has loaded ${MAX_SKILL_LOADS_PER_SESSION} skill bodies; the lazy-load budget is spent`, 429, {
        sessionId, limit: MAX_SKILL_LOADS_PER_SESSION,
      });
    }
  }

  function activeOf(sessionId: string): ActiveSkill[] {
    return sessions.get(sessionId) ?? [];
  }

  async function recordActivity(input: {
    ctx: AuthContext;
    companyId: string;
    projectId?: string;
    sessionId: string;
    extra: Record<string, unknown>;
  }): Promise<void> {
    if (!deps.activity) return;
    try {
      await deps.activity.record({
        kind: "run_activity",
        companyId: input.companyId,
        projectId: input.projectId ?? null,
        sessionId: input.sessionId,
        runId: null,
        snapshotId: null,
        ...input.extra,
      });
    } catch {
      // Bookkeeping never changes a decision.
    }
  }

  const service: CodeSkillsService = {
    async listMetadata(input) {
      let enabled = false;
      try {
        enabled = (await deps.flags.isEnabled(input.ctx, CODE_SKILLS_FLAG, {
          companyId: input.companyId,
          userId: input.ctx.userId,
        })) === true;
      } catch {
        enabled = false;
      }
      if (!enabled) return { executed: false, skills: [], withheld: [] };

      const skills: Array<{ id: string; name: string; description: string; version: number; source: CodeSkillSource; trusted: boolean }> = [];
      const withheld: Array<{ id: string; reason: string }> = [];
      let listed: readonly CodeSkillMetadata[] = [];
      try {
        listed = await deps.listMetadata({ ctx: input.ctx, companyId: input.companyId, ...(input.projectId ? { projectId: input.projectId } : {}) });
      } catch {
        listed = [];
      }
      for (const skill of listed) {
        if (!skill.trusted) {
          // A repository Skill without a trust record is *reported*, never offered: the model must not even
          // learn that it exists as something it could ask for.
          withheld.push({ id: skill.id, reason: "skill_untrusted" });
          continue;
        }
        skills.push({
          id: skill.id,
          name: skill.name.slice(0, 120),
          description: skill.description.slice(0, MAX_SKILL_DESCRIPTION_CHARS),
          version: skill.version,
          source: skill.source,
          trusted: true,
        });
      }
      skills.sort((a, b) => a.id.localeCompare(b.id));
      return { executed: true, skills, withheld };
    },

    async load(input) {
      let enabled = false;
      try {
        enabled = (await deps.flags.isEnabled(input.ctx, CODE_SKILLS_FLAG, {
          companyId: input.companyId,
          userId: input.ctx.userId,
        })) === true;
      } catch {
        enabled = false;
      }
      if (!enabled) throw new CodeSkillError("skill_flag_disabled", "Skills are disabled for this workspace", 403);

      const already = activeOf(input.sessionId).find((entry) => entry.instructions.id === input.id);
      if (already) {
        // Re-selecting an active Skill costs nothing and does not re-read the body — but the version must
        // still match, because "same id, different version" is exactly the case the caller has to notice.
        if (input.version !== null && input.version !== already.instructions.version) {
          throw new CodeSkillError("skill_version_mismatch", `Skill ${input.id} is active at version ${already.instructions.version}, not ${input.version}`, 409, {
            id: input.id, activeVersion: already.instructions.version, requestedVersion: input.version,
          });
        }
        return already.instructions;
      }

      if (activeOf(input.sessionId).length >= MAX_ACTIVE_SKILLS_PER_SESSION) {
        throw new CodeSkillError("skill_limit_reached", `A session may keep at most ${MAX_ACTIVE_SKILLS_PER_SESSION} skills active`, 429, {
          sessionId: input.sessionId, limit: MAX_ACTIVE_SKILLS_PER_SESSION,
        });
      }
      ensureBudget(input.sessionId);

      const read = await deps.readBody({
        ctx: input.ctx,
        companyId: input.companyId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        id: input.id,
        version: input.version,
      });
      if (!read) {
        throw new CodeSkillError("skill_deleted", `Skill ${input.id} no longer exists`, 404, { id: input.id, version: input.version });
      }
      if (!read.trusted) {
        throw new CodeSkillError("skill_untrusted", `Skill ${input.id} is not trusted and its body was not used`, 403, { id: input.id, source: read.source });
      }
      if (typeof read.body !== "string" || read.body.trim().length === 0) {
        throw new CodeSkillError("skill_body_invalid", `Skill ${input.id} has no usable body`, 400, { id: input.id });
      }
      if (read.body.length > MAX_SKILL_BODY_CHARS) {
        throw new CodeSkillError("skill_body_too_large", `Skill ${input.id} body exceeds ${MAX_SKILL_BODY_CHARS} characters`, 400, {
          id: input.id, chars: read.body.length, limit: MAX_SKILL_BODY_CHARS,
        });
      }
      if (input.version !== null && read.version !== input.version) {
        // The pinned version moved between the listing and the load. Refused rather than silently upgraded:
        // the caller asked for a specific version and a different one is a different Skill.
        throw new CodeSkillError("skill_version_mismatch", `Skill ${input.id} is at version ${read.version}, not the pinned ${input.version}`, 409, {
          id: input.id, requestedVersion: input.version, actualVersion: read.version,
        });
      }

      const scan = scanTextForSecrets(read.body);
      if (scan.findings.length > 0) {
        await recordActivity({
          ctx: input.ctx, companyId: input.companyId, sessionId: input.sessionId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          extra: { skillAction: "load", skillId: input.id, skillVersion: read.version, skillSource: read.source, result: "refused", code: "skill_secret_refused" },
        });
        throw new CodeSkillError("skill_secret_refused", `Skill ${input.id} contains a value that looks like a credential`, 403, {
          id: input.id, kinds: Array.from(new Set(scan.findings.map((finding) => finding.kind))),
        });
      }

      // The body is provider-bound content (it becomes part of the system prompt on every later call), so it
      // passes the C5b ProviderDataGuard before it is used anywhere. A guard that would have to redact refuses.
      if (deps.providerDataGuard) {
        try {
          await deps.providerDataGuard.guardProviderBoundText(read.body, {
            ...(input.model ? { model: input.model } : {}),
            policyContext: {
              companyId: input.companyId,
              ...(input.projectId ? { projectId: input.projectId } : {}),
              sessionId: input.sessionId,
              ...(input.dataClassification ? { dataClassification: input.dataClassification } : {}),
            },
            field: "content",
          });
        } catch (error) {
          const code = (error as { code?: string })?.code ?? "skill_provider_data_refused";
          await recordActivity({
            ctx: input.ctx, companyId: input.companyId, sessionId: input.sessionId,
            ...(input.projectId ? { projectId: input.projectId } : {}),
            extra: { skillAction: "load", skillId: input.id, skillVersion: read.version, skillSource: read.source, result: "refused", code },
          });
          throw new CodeSkillError("skill_provider_data_refused", `Skill ${input.id} may not be sent to the provider`, 403, {
            id: input.id, providerCode: code,
          });
        }
      }

      orderCounter += 1;
      const instructions: CodeSkillInstructions = {
        id: input.id,
        version: read.version,
        hash: sha256(`v${read.version}\u0000${read.body}`),
        source: read.source,
        trusted: true,
        order: orderCounter,
        body: read.body,
        chars: read.body.length,
      };
      sessions.set(input.sessionId, [...activeOf(input.sessionId), { instructions }]);
      if (usageQuotasEnabled()) loads.set(input.sessionId, (loads.get(input.sessionId) ?? 0) + 1);
      await recordActivity({
        ctx: input.ctx, companyId: input.companyId, sessionId: input.sessionId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        extra: {
          skillAction: "load",
          skillId: instructions.id,
          skillVersion: instructions.version,
          skillSource: instructions.source,
          skillHash: instructions.hash,
          chars: instructions.chars,
          activeCount: activeOf(input.sessionId).length,
          result: "ok",
        },
      });
      return instructions;
    },

    active(sessionId) {
      return activeOf(sessionId).map((entry) => entry.instructions);
    },

    unload(sessionId, id) {
      const current = activeOf(sessionId);
      const next = current.filter((entry) => entry.instructions.id !== id);
      if (next.length === current.length) return false;
      sessions.set(sessionId, next);
      return true;
    },

    clear(sessionId) {
      sessions.delete(sessionId);
      loads.delete(sessionId);
    },

    renderInstructions(sessionId) {
      const active = activeOf(sessionId).map((entry) => entry.instructions);
      if (active.length === 0) return null;
      // Deterministic order: activation order, then id. Two runs that selected the same Skills in the same
      // order produce the same bytes — which is what makes the section part of a reproducible prompt.
      const ordered = [...active].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const sections = ordered.map((skill) =>
        [`--- skill: ${skill.id} (v${skill.version}, ${skill.source}, ${skill.hash}) ---`, skill.body].join("\n"),
      );
      const text = [SKILL_INSTRUCTIONS_HEADER, SKILL_INSTRUCTIONS_NOTE, "", sections.join("\n\n")].join("\n");
      if (text.length > MAX_SKILL_INSTRUCTIONS_CHARS) {
        throw new CodeSkillError("skill_body_too_large", `The rendered skill section exceeds ${MAX_SKILL_INSTRUCTIONS_CHARS} characters`, 400, {
          chars: text.length, limit: MAX_SKILL_INSTRUCTIONS_CHARS,
        });
      }
      return text;
    },

    provenance(sessionId) {
      return activeOf(sessionId)
        .map((entry) => ({
          skillId: entry.instructions.id,
          version: entry.instructions.version,
          hash: entry.instructions.hash,
          source: entry.instructions.source,
          order: entry.instructions.order,
        }))
        .sort((a, b) => a.order - b.order || a.skillId.localeCompare(b.skillId));
    },
  };
  return service;
}

/**
 * The **pinned-version reader**: a replay must reproduce the Skill version the run recorded, not whatever is
 * installed today. Given the recorded provenance and a body reader, this resolves the exact text — and refuses
 * when the storage cannot produce that version, instead of quietly answering with the current one.
 */
export async function readPinnedSkillBody(input: {
  recorded: { skillId: string; version: number; hash: `sha256:${string}` };
  ctx: AuthContext;
  companyId: string;
  projectId?: string;
  reader: CodeSkillsDeps["readBody"];
}): Promise<{ body: string; version: number; hash: `sha256:${string}` }> {
  const read = await input.reader({
    ctx: input.ctx,
    companyId: input.companyId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    id: input.recorded.skillId,
    version: input.recorded.version,
  });
  if (!read) {
    throw new CodeSkillError("skill_deleted", `The recorded version of skill ${input.recorded.skillId} is no longer available`, 409, {
      id: input.recorded.skillId, version: input.recorded.version,
    });
  }
  if (read.version !== input.recorded.version) {
    throw new CodeSkillError("skill_version_mismatch", `Replay asked for skill ${input.recorded.skillId} v${input.recorded.version} and was offered v${read.version}`, 409, {
      id: input.recorded.skillId, recorded: input.recorded.version, actual: read.version,
    });
  }
  const hash = sha256(`v${read.version}\u0000${read.body}`);
  if (hash !== input.recorded.hash) {
    throw new CodeSkillError("skill_hash_mismatch", `Replay found a different body for skill ${input.recorded.skillId} v${input.recorded.version}`, 409, {
      id: input.recorded.skillId, recorded: input.recorded.hash, actual: hash,
    });
  }
  return { body: read.body, version: read.version, hash };
}

/** The section the runner appends to its system prompt. Kept here so the header and the runner cannot drift. */
export function skillInstructionsSection(rendered: string | null): string | null {
  return rendered && rendered.trim().length > 0 ? rendered : null;
}
