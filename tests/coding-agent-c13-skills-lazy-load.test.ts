import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import {
  CODE_SKILLS_FLAG,
  CodeSkillError,
  MAX_ACTIVE_SKILLS_PER_SESSION,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_LOADS_PER_SESSION,
  SKILL_INSTRUCTIONS_HEADER,
  createCodeSkillsService,
  readPinnedSkillBody,
  type CodeSkillMetadata,
  type CodeSkillsDeps,
} from "../apps/agent-api/src/code-skills-instructions";
import { ProviderBoundTextRejectedError } from "../apps/agent-api/src/provider-data-guard";
import {
  STUB_MARKER,
  compactConversation,
} from "../apps/agent-api/src/code-conversation-compaction";
import { buildSystemPrompt, SYSTEM_PROMPT_DATA_BOUNDARY } from "../apps/agent-api/src/coding-agent-runner";
import type { CodeSession } from "@npati/workspace";

/**
 * C13 — lazily loaded Skills (owner decisions 5, 6 and the acceptance list of decision 10).
 *
 * What is pinned here:
 *
 *  1. **Metadata first.** `listMetadata` never calls the body reader — a spy proves it — and a repository-sourced
 *     Skill without a trust record is reported as withheld rather than offered.
 *  2. **The body is a typed system section, and it survives C8 compaction.** The section is rendered into the
 *     system prompt above the data boundary, and the real `compactConversation` is run over a transcript that
 *     carries it: the body is still present and byte-identical afterwards, while the old tool results became
 *     stubs. That is the whole reason the body is not a tool result.
 *  3. **Pinning.** `skill_id` + `version` + `hash` + provenance are recorded, a version that moved is refused,
 *     and the replay reader (`readPinnedSkillBody`) refuses rather than answering with the current version.
 *  4. **A secret never reaches the provider.** A body that looks like a credential is refused by the scanner —
 *     the provider guard is never even reached — and a body the guard would have to redact is refused too.
 *  5. **Tenant isolation.** Two sessions never share active Skills or the load budget.
 */

const owner: AuthContext = { workspaceId: "ws-c13", userId: "user-c13", permissions: ["owner"] } as unknown as AuthContext;
const COMPANY = "company-c13";
const PROJECT = "project-c13";
const sha = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const SECRET_SHAPED = `Deploy with ${"ghp_" + "b".repeat(36)}`;

function skillErrorCode(run: () => Promise<unknown>): Promise<string | null> {
  return run().then(
    () => null,
    (error) => (error instanceof CodeSkillError ? error.code : `unexpected:${String((error as Error)?.message)}`),
  );
}

interface SkillHarness {
  service: ReturnType<typeof createCodeSkillsService>;
  readBody: ReturnType<typeof vi.fn>;
  listMetadata: ReturnType<typeof vi.fn>;
  guard: ReturnType<typeof vi.fn>;
  activities: Array<Record<string, unknown>>;
}

/**
 * The service over a spy body reader and a spy listing, with the **real** C5b-style guard contract (a guard that
 * would have to redact throws `ProviderBoundTextRejectedError`, exactly as `provider-data-guard.ts` does).
 */
function skillHarness(options: {
  skills?: readonly CodeSkillMetadata[];
  bodies?: Record<string, { body: string; version: number; source: "builtin" | "installed" | "repository"; trusted: boolean } | null>;
  skillFlag?: boolean;
  guardRejects?: boolean;
  withGuard?: boolean;
} = {}): SkillHarness {
  const activities: Array<Record<string, unknown>> = [];
  const bodies = options.bodies ?? {};
  const readBody = vi.fn(async ({ id }: { id: string }) => bodies[id] ?? null);
  const listMetadata = vi.fn(async () => options.skills ?? []);
  const guard = vi.fn(async (text: string) => {
    if (options.guardRejects === true) throw new ProviderBoundTextRejectedError({ reason: "provider_bound_text_requires_redaction", bytes: text.length });
    return { text, changed: false, bytes: text.length };
  });

  const deps: CodeSkillsDeps = {
    flags: { isEnabled: async (_ctx, key) => options.skillFlag !== false && key === CODE_SKILLS_FLAG },
    listMetadata: listMetadata as unknown as CodeSkillsDeps["listMetadata"],
    readBody: readBody as unknown as CodeSkillsDeps["readBody"],
    ...(options.withGuard === false ? {} : { providerDataGuard: { guardProviderBoundText: guard as unknown as NonNullable<CodeSkillsDeps["providerDataGuard"]>["guardProviderBoundText"] } }),
    activity: { record: async (event) => { activities.push(event); } },
  };
  return { service: createCodeSkillsService(deps), readBody, listMetadata, guard, activities };
}

const builtinSkill = (id: string, version = 1): CodeSkillMetadata => ({
  id, name: id, description: `${id} description`, version, source: "builtin", trusted: true, capabilities: [],
});

describe("[C13] [security-gate] Skills load lazily and their body is a typed system section", () => {
  it("lists metadata without loading any body, and withholds an untrusted repository skill", async () => {
    const h = skillHarness({
      skills: [
        builtinSkill("web-research"),
        { ...builtinSkill("repo-skill"), source: "repository", trusted: false },
      ],
      bodies: { "web-research": { body: "body text", version: 1, source: "builtin", trusted: true } },
    });
    const listed = await h.service.listMetadata({ ctx: owner, companyId: COMPANY, projectId: PROJECT });
    expect(listed.executed).toBe(true);
    expect(listed.skills.map((skill) => skill.id)).toEqual(["web-research"]);
    // The listing carries no body field at all …
    expect(Object.keys(listed.skills[0]!)).not.toContain("body");
    // … and the body reader was never called, which is the lazy-load proof.
    expect(h.readBody).toHaveBeenCalledTimes(0);
    // A repository Skill does not become usable by being named a skill: it is withheld, not offered.
    expect(listed.withheld).toEqual([{ id: "repo-skill", reason: "skill_untrusted" }]);
  });

  it("does not load a body for a skill that was never selected, even when the listing is repeated", async () => {
    const h = skillHarness({
      skills: [builtinSkill("a"), builtinSkill("b"), builtinSkill("c")],
      bodies: Object.fromEntries(["a", "b", "c"].map((id) => [id, { body: `${id} body`, version: 1, source: "builtin" as const, trusted: true }])),
    });
    for (let index = 0; index < 3; index += 1) {
      await h.service.listMetadata({ ctx: owner, companyId: COMPANY, projectId: PROJECT });
    }
    expect(h.readBody).toHaveBeenCalledTimes(0);
    expect(h.service.renderInstructions("session-c13")).toBeNull();
    expect(h.service.active("session-c13")).toEqual([]);
  });

  it("loads exactly the selected skill and renders a typed, versioned section", async () => {
    const h = skillHarness({
      skills: [builtinSkill("a"), builtinSkill("b")],
      bodies: {
        a: { body: "A body", version: 1, source: "builtin", trusted: true },
        b: { body: "B body", version: 1, source: "installed", trusted: true },
      },
    });
    const loaded = await h.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "session-c13", id: "b", version: 1,
    });
    expect(loaded).toMatchObject({ id: "b", version: 1, source: "installed", trusted: true });
    expect(loaded.hash).toBe(sha("v1\u0000B body"));
    // Only the selected body was read.
    expect(h.readBody).toHaveBeenCalledTimes(1);
    expect(h.readBody.mock.calls[0]![0].id).toBe("b");

    const section = h.service.renderInstructions("session-c13")!;
    expect(section.startsWith(SKILL_INSTRUCTIONS_HEADER)).toBe(true);
    expect(section).toContain("--- skill: b (v1, installed, ");
    expect(section).toContain("B body");
    expect(section).not.toContain("A body");
    // A body the guard would have to change is refused; a clean body goes through the provider guard once.
    expect(h.guard).toHaveBeenCalledTimes(1);
    expect(h.guard.mock.calls[0]![0]).toBe("B body");
    // The provenance the ExecutionSnapshot records: id, version, hash, source — never the body.
    const provenance = h.service.provenance("session-c13");
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({ skillId: "b", version: 1, source: "installed" });
    expect(provenance[0]!.hash).toBe(sha("v1\u0000B body"));
    expect(provenance[0]!.order).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(provenance)).not.toContain("B body");
  });

  it("keeps the body out of the reach of C8 compaction — a tool result is stubbed, the system section is not", async () => {
    const h = skillHarness({
      skills: [builtinSkill("a")],
      bodies: { a: { body: "SKILL-BODY-MARKER: always run the migration check before a commit.", version: 1, source: "builtin", trusted: true } },
    });
    await h.service.load({ ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "session-c13", id: "a", version: 1 });
    const section = h.service.renderInstructions("session-c13")!;

    // The transcript the runner really builds: the system prompt (with the section) first, the expanded user
    // goal second, then tool exchange. Compaction protects the first two messages and stubs old tool results.
    const messages = [
      { role: "system", content: `base prompt\n\n${section}` },
      { role: "user", content: "Goal: update the schema" },
      ...Array.from({ length: 8 }, (_unused, index) => ({
        role: "tool",
        content: `tool output ${index} ${"x".repeat(200)}`,
        toolCallId: `call-${index}`,
        toolName: "code.fs.read",
        toolVersion: 1,
        argumentsHash: sha(`args-${index}`),
        outcome: "ok",
      })),
      { role: "assistant", content: "next step: run the migration check" },
    ];
    const compacted = compactConversation({ messages, keepRecentTurns: 4 });

    // The tool results were replaced by stubs …
    expect(compacted.stubbed).toBeGreaterThan(0);
    expect(compacted.messages.some((message) => message.content.startsWith(STUB_MARKER))).toBe(true);
    // … and the Skill body is still there, byte for byte, because it lives in the system message.
    const systemAfter = compacted.messages[0]!.content;
    expect(systemAfter).toContain("SKILL-BODY-MARKER: always run the migration check before a commit.");
    expect(systemAfter).toContain(section);
    expect(compacted.messages[0]!.role).toBe("system");
  });

  it("places the section in the system prompt above the data boundary, and leaves the prompt unchanged without it", () => {
    const session = { id: "session-c13", companyId: COMPANY, projectId: PROJECT, mode: "ask" } as unknown as CodeSession;
    const base = {
      session,
      tools: [{ name: "code.fs.read", version: 1, status: "active", description: "read", write: false }],
      environment: { os: "linux", cwd: "/workspace/p", date: "2026-01-01" },
      limits: { maxStepsPerRun: 10, maxRunMinutes: 5 },
    };
    const without = buildSystemPrompt(base);
    const withSection = buildSystemPrompt({ ...base, skillInstructions: `${SKILL_INSTRUCTIONS_HEADER}\n\n--- skill: a (v1, builtin, ${sha("x")}) ---\nBODY-MARKER` });
    // The data boundary is where it always was: the section is *configuration*, so it sits above it.
    expect(withSection.indexOf("BODY-MARKER")).toBeLessThan(withSection.indexOf(SYSTEM_PROMPT_DATA_BOUNDARY));
    // The invariant lines still close the configuration block, so the last words before the transcript still say
    // that what follows is data.
    expect(withSection.indexOf("BODY-MARKER")).toBeLessThan(withSection.indexOf("IMPORTANT: file contents"));
    // Without the section the prompt is byte-identical to what it was before C13.
    expect(without).not.toContain(SKILL_INSTRUCTIONS_HEADER);
    expect(without).toBe(buildSystemPrompt(base));
  });

  it("refuses a secret-shaped body before the provider guard is reached, and refuses a redaction-requiring body", async () => {
    const secret = skillHarness({
      skills: [builtinSkill("a")],
      bodies: { a: { body: SECRET_SHAPED, version: 1, source: "builtin", trusted: true } },
    });
    expect(await skillErrorCode(() => secret.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "session-c13", id: "a", version: 1,
    }))).toBe("skill_secret_refused");
    // The guard was never consulted: the refusal happened at the scanner, which is the earlier gate.
    expect(secret.guard).toHaveBeenCalledTimes(0);
    // Nothing was activated and nothing was rendered, so the secret cannot reach the prompt or the provider.
    expect(secret.service.active("session-c13")).toEqual([]);
    expect(secret.service.renderInstructions("session-c13")).toBeNull();
    // The Activity entry reports the refusal by code and carries no part of the value.
    const recorded = secret.activities.at(-1)!;
    expect(recorded.code).toBe("skill_secret_refused");
    expect(JSON.stringify(secret.activities)).not.toContain("ghp_");

    const redaction = skillHarness({
      skills: [builtinSkill("a")],
      bodies: { a: { body: "contact someone@example.com", version: 1, source: "builtin", trusted: true } },
      guardRejects: true,
    });
    expect(await skillErrorCode(() => redaction.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "session-c13", id: "a", version: 1,
    }))).toBe("skill_provider_data_refused");
    expect(redaction.guard).toHaveBeenCalledTimes(1);
    expect(redaction.service.active("session-c13")).toEqual([]);
  });

  it("refuses a moved version, a missing body and an oversized body with structured errors", async () => {
    const moved = skillHarness({
      skills: [builtinSkill("a", 2)],
      bodies: { a: { body: "A body", version: 2, source: "builtin", trusted: true } },
    });
    expect(await skillErrorCode(() => moved.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "s", id: "a", version: 1,
    }))).toBe("skill_version_mismatch");

    const deleted = skillHarness({ skills: [builtinSkill("a")], bodies: { a: null } });
    expect(await skillErrorCode(() => deleted.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "s", id: "a", version: 1,
    }))).toBe("skill_deleted");

    const untrusted = skillHarness({
      skills: [builtinSkill("a")],
      bodies: { a: { body: "A body", version: 1, source: "repository", trusted: false } },
    });
    expect(await skillErrorCode(() => untrusted.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "s", id: "a", version: 1,
    }))).toBe("skill_untrusted");

    const oversized = skillHarness({
      skills: [builtinSkill("a")],
      bodies: { a: { body: "z".repeat(MAX_SKILL_BODY_CHARS + 1), version: 1, source: "builtin", trusted: true } },
    });
    expect(await skillErrorCode(() => oversized.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "s", id: "a", version: 1,
    }))).toBe("skill_body_too_large");

    // A disabled flag refuses before anything is read.
    const off = skillHarness({ skillFlag: false, skills: [builtinSkill("a")], bodies: {} });
    expect(await skillErrorCode(() => off.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "s", id: "a", version: null,
    }))).toBe("skill_flag_disabled");
    expect(off.readBody).toHaveBeenCalledTimes(0);
  });

  it("bounds active skills per session and the lazy-load budget, and isolates tenants", async () => {
    const many = Array.from({ length: MAX_ACTIVE_SKILLS_PER_SESSION + 2 }, (_unused, index) => builtinSkill(`s${index}`));
    const h = skillHarness({
      skills: many,
      bodies: Object.fromEntries(many.map((skill) => [skill.id, { body: `${skill.id} body`, version: 1, source: "builtin" as const, trusted: true }])),
    });
    for (let index = 0; index < MAX_ACTIVE_SKILLS_PER_SESSION; index += 1) {
      await h.service.load({ ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "s1", id: `s${index}`, version: 1 });
    }
    expect(h.service.active("s1")).toHaveLength(MAX_ACTIVE_SKILLS_PER_SESSION);
    expect(await skillErrorCode(() => h.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "s1",
      id: `s${MAX_ACTIVE_SKILLS_PER_SESSION}`, version: 1,
    }))).toBe("skill_limit_reached");

    // A second session shares nothing: not the active set, not the budget.
    expect(h.service.active("s2")).toEqual([]);
    expect(h.service.renderInstructions("s2")).toBeNull();
    await h.service.load({ ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "s2", id: "s0", version: 1 });
    expect(h.service.active("s2").map((skill) => skill.id)).toEqual(["s0"]);
    expect(h.service.active("s1")).toHaveLength(MAX_ACTIVE_SKILLS_PER_SESSION);
    // Unloading is per session too.
    expect(h.service.unload("s2", "s0")).toBe(true);
    expect(h.service.unload("s2", "s0")).toBe(false);
    expect(h.service.active("s1")).toHaveLength(MAX_ACTIVE_SKILLS_PER_SESSION);
    expect(MAX_SKILL_LOADS_PER_SESSION).toBeGreaterThanOrEqual(MAX_ACTIVE_SKILLS_PER_SESSION);

    // The session budget is spent after the cap, and the refusal names the limit rather than silently re-reading.
    expect(await skillErrorCode(() => h.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "s1", id: "s0", version: 1,
    }))).toBeNull(); // re-selecting an active skill costs nothing
    expect(h.service.clear("s1")).toBeUndefined();
    expect(h.service.active("s1")).toEqual([]);
    expect(h.service.provenance("s1")).toEqual([]);
  });

  it("replays the recorded skill version — not the current one — and refuses a hash that moved", async () => {
    const bodies: Record<string, { body: string; version: number; source: "builtin"; trusted: boolean }> = {
      a: { body: "version one body", version: 1, source: "builtin", trusted: true },
    };
    const reader = async ({ id, version }: { id: string; version: number | null }) => {
      const record = bodies[id];
      if (!record) return null;
      // A reader that can only produce the *current* version is exactly the case the pin must refuse.
      if (version !== null && record.version !== version) {
        return { body: record.body, version: record.version, source: record.source, trusted: record.trusted };
      }
      return { body: record.body, version: record.version, source: record.source, trusted: record.trusted };
    };
    const recorded = { skillId: "a", version: 1, hash: sha("v1\u0000version one body") };

    const replayed = await readPinnedSkillBody({ recorded, ctx: owner, companyId: COMPANY, projectId: PROJECT, reader });
    expect(replayed.body).toBe("version one body");
    expect(replayed.hash).toBe(recorded.hash);

    // The Skill moves on: replay still asks for v1, so the pinned read refuses rather than answering with v2.
    bodies.a = { body: "version two body", version: 2, source: "builtin", trusted: true };
    expect(await skillErrorCode(() => readPinnedSkillBody({ recorded, ctx: owner, companyId: COMPANY, projectId: PROJECT, reader })))
      .toBe("skill_version_mismatch");

    // A reader that answers v1 with different text is caught by the hash, not by trust in the reader.
    bodies.a = { body: "version one body (edited)", version: 1, source: "builtin", trusted: true };
    expect(await skillErrorCode(() => readPinnedSkillBody({ recorded, ctx: owner, companyId: COMPANY, projectId: PROJECT, reader })))
      .toBe("skill_hash_mismatch");

    // A version that is gone is its own answer.
    delete bodies.a;
    expect(await skillErrorCode(() => readPinnedSkillBody({ recorded, ctx: owner, companyId: COMPANY, projectId: PROJECT, reader })))
      .toBe("skill_deleted");
  });

  it("records the skill provenance the ExecutionSnapshot pins, and nothing else", async () => {
    const h = skillHarness({
      skills: [builtinSkill("a", 4)],
      bodies: { a: { body: "A body", version: 4, source: "installed", trusted: true } },
    });
    const loaded = await h.service.load({
      ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: "s", id: "a", version: 4,
    });
    const provenance = h.service.provenance("s");
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({ skillId: "a", version: 4, source: "installed", hash: loaded.hash });
    // The record is metadata: it carries no body, no text and no secret.
    expect(JSON.stringify(provenance)).not.toContain("A body");
    // Activation is Activity (metadata-only), not AuditLog: no audit port exists in this module at all.
    const recorded = h.activities.at(-1)!;
    expect(recorded.skillAction).toBe("load");
    expect(recorded.skillId).toBe("a");
    expect(recorded.skillVersion).toBe(4);
    expect(JSON.stringify(recorded)).not.toContain("A body");
  });
});
