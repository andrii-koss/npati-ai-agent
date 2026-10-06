import { describe, expect, it } from "vitest";
import {
  CODE_TOOL_CALLING_MODES,
  CONSERVATIVE_CODE_MODEL_PROFILE,
  CONSERVATIVE_CODE_MODEL_PROFILE_ID,
  CodeModelProfileError,
  DEFAULT_CODE_MODEL_PROFILES,
  FALLBACK_CONTEXT_WINDOW,
  MAX_PARALLEL_TOOL_CALLS,
  MIN_CONTEXT_WINDOW,
  MIN_PARALLEL_TOOL_CALLS,
  conservativeCodeModelProfile,
  matchesModelPattern,
  modelProfileTrace,
  profileMatchSpecificity,
  resolveEffectiveToolCallingMode,
  resolveModelProfile,
  validateCodeModelProfile,
  type CodeModelProfile,
} from "../apps/agent-api/src/code-model-profiles";

function profile(overrides: Partial<CodeModelProfile> & { id: string }): CodeModelProfile {
  return {
    match: {},
    toolCallingMode: "native",
    maxParallelToolCalls: 2,
    contextWindow: 128_000,
    ...overrides,
  } as CodeModelProfile;
}

describe("security-gate: C6 model profiles — conservative defaults for unknown models", () => {
  it("gives an unknown model the conservative profile, field by field", () => {
    const resolved = resolveModelProfile({ provider: "some-new-vendor", model: "mystery-1" });

    expect(resolved.matchedBy).toBe("default");
    expect(resolved.profile.id).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
    expect(resolved.profile.toolCallingMode).toBe("auto");
    expect(resolved.profile.maxParallelToolCalls).toBe(MIN_PARALLEL_TOOL_CALLS);
    expect(resolved.profile.maxParallelToolCalls).toBe(1);
    expect(resolved.profile.contextWindow).toBe(
      Math.min(...DEFAULT_CODE_MODEL_PROFILES.map((entry) => entry.contextWindow)),
    );
    // No opinion is expressed on temperature, and no edit tool is guessed for a model we know nothing about.
    expect(resolved.profile.temperature).toBeUndefined();
    expect(resolved.profile.preferredEditTool).toBeUndefined();
    expect(resolved.profile.knownLimitations ?? []).toContain("unknown_model");
    expect(resolved.warnings.some((warning) => warning.startsWith("unknown_model_conservative_default"))).toBe(true);
    expect(resolved.subject).toEqual({ provider: "some-new-vendor", model: "mystery-1" });
  });

  it("keeps the conservative context window at the smallest known one and falls back when a registry is empty", () => {
    const tiny = profile({ id: "tiny", match: { models: ["a"] }, contextWindow: 4_000 });
    const large = profile({ id: "large", match: { models: ["b"] }, contextWindow: 500_000 });

    expect(conservativeCodeModelProfile([tiny, large]).contextWindow).toBe(4_000);
    expect(conservativeCodeModelProfile([]).contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
    // An invalid window cannot drag the conservative value below the sane floor.
    expect(conservativeCodeModelProfile([profile({ id: "broken", match: { models: ["c"] }, contextWindow: 10 })]).contextWindow).toBe(
      FALLBACK_CONTEXT_WINDOW,
    );
  });

  it("never assumes native tool calling in auto mode, and returns text without a native call", () => {
    expect(resolveEffectiveToolCallingMode({ toolCallingMode: "auto" })).toBe("text");
    expect(resolveEffectiveToolCallingMode({ toolCallingMode: "auto" }, { sawNativeToolCalls: false })).toBe("text");
    expect(resolveEffectiveToolCallingMode({ toolCallingMode: "auto" }, { sawNativeToolCalls: true })).toBe("native");
    expect(resolveEffectiveToolCallingMode({ toolCallingMode: "native" })).toBe("native");
    expect(resolveEffectiveToolCallingMode({ toolCallingMode: "text" }, { sawNativeToolCalls: true })).toBe("text");
  });

  it("ships only valid default profiles, and every preferred edit tool is a plausible code tool", () => {
    for (const entry of DEFAULT_CODE_MODEL_PROFILES) {
      expect(() => validateCodeModelProfile(entry)).not.toThrow();
    }
    const preferred = DEFAULT_CODE_MODEL_PROFILES.map((entry) => entry.preferredEditTool).filter(
      (value): value is string => typeof value === "string",
    );
    // Kept as an assertion on shape rather than importing the schema JSON: the profiles must never point at
    // a tool outside the canonical `code.*` surface (the runner re-checks against the manifest at wiring).
    for (const tool of preferred) expect(tool).toMatch(/^code\.[a-z_]+(\.[a-z_]+)*$/);
    expect(preferred.every((tool) => tool === "code.fs.edit" || tool === "code.fs.apply_patch")).toBe(true);
  });
});

describe("security-gate: C6 model profiles — the registry is data, not code", () => {
  it("resolves the same logic against a different registry (no code change required)", () => {
    const registry = [
      profile({ id: "exact", match: { models: ["model-x"] }, toolCallingMode: "text", maxParallelToolCalls: 3, contextWindow: 32_000 }),
      profile({ id: "pattern", match: { patterns: ["vendor-*"] }, toolCallingMode: "text", maxParallelToolCalls: 1, contextWindow: 16_000 }),
      profile({ id: "provider", match: { providers: ["acme"] }, toolCallingMode: "native", maxParallelToolCalls: 5, contextWindow: 64_000 }),
    ];

    const exact = resolveModelProfile({ provider: "acme", model: "model-x", profiles: registry });
    expect(exact.profile.id).toBe("exact");
    expect(exact.matchedBy).toBe("model");

    const patterned = resolveModelProfile({ provider: "acme", model: "vendor-9", profiles: registry });
    expect(patterned.profile.id).toBe("pattern");
    expect(patterned.matchedBy).toBe("pattern");

    const byProvider = resolveModelProfile({ provider: "acme", model: "other-1", profiles: registry });
    expect(byProvider.profile.id).toBe("provider");
    expect(byProvider.matchedBy).toBe("provider");

    const unknown = resolveModelProfile({ provider: "acme", model: "zzz", profiles: [] });
    expect(unknown.matchedBy).toBe("default");
  });

  it("ranks a model match above a pattern and a pattern above a provider", () => {
    const entry = profile({ id: "p", match: { providers: ["acme"], models: ["m"], patterns: ["m*"] } });
    expect(profileMatchSpecificity(entry, "acme", "m")).toBe(3);
    expect(profileMatchSpecificity(entry, "acme", "m2")).toBe(2);
    expect(profileMatchSpecificity(profile({ id: "q", match: { providers: ["acme"] } }), "acme", "m3")).toBe(1);
    expect(profileMatchSpecificity(profile({ id: "r", match: { providers: ["acme"] } }), "other", "m4")).toBe(0);
  });

  it("lets an explicit override win, including an override that matches nothing", () => {
    const override = profile({ id: "operator-override", match: {}, maxParallelToolCalls: 2, contextWindow: 8_000 });
    const resolved = resolveModelProfile({ provider: "anthropic", model: "claude-x", overrides: [override] });
    expect(resolved.profile.id).toBe("operator-override");
    expect(resolved.matchedBy).toBe("override");

    const conditional = profile({ id: "only-for-m", match: { models: ["m"] } });
    const other = resolveModelProfile({ provider: "acme", model: "nope", overrides: [conditional] });
    expect(other.matchedBy).toBe("default");
  });

  it("skips an invalid registry entry or override instead of applying half of it", () => {
    const broken = profile({ id: "broken-registry", match: { models: ["m"] }, maxParallelToolCalls: -2 });
    const resolved = resolveModelProfile({ provider: "acme", model: "m", profiles: [broken] });
    expect(resolved.matchedBy).toBe("default");
    expect(resolved.warnings.some((warning) => warning.startsWith("invalid_profile_skipped:broken-registry"))).toBe(true);

    const brokenOverride = profile({ id: "broken-override", match: {}, contextWindow: 1 });
    const withOverride = resolveModelProfile({ provider: "acme", model: "m", overrides: [brokenOverride] });
    expect(withOverride.matchedBy).toBe("default");
    expect(withOverride.warnings.some((warning) => warning.startsWith("invalid_override_skipped:broken-override"))).toBe(true);
  });

  it("honours the enabled-profile list, and reports ids that do not exist", () => {
    const registry = [profile({ id: "one", match: { providers: ["acme"] } })];
    const disabled = resolveModelProfile({ provider: "acme", model: "m", profiles: registry, enabledProfileIds: [] });
    expect(disabled.matchedBy).toBe("default");

    const enabled = resolveModelProfile({ provider: "acme", model: "m", profiles: registry, enabledProfileIds: ["one", "ghost"] });
    expect(enabled.profile.id).toBe("one");
    expect(enabled.warnings).toContain("enabled_profile_unknown:ghost");
  });

  it("reports an ambiguous match instead of hiding it", () => {
    const registry = [
      profile({ id: "first", match: { providers: ["acme"] } }),
      profile({ id: "second", match: { providers: ["acme"] } }),
    ];
    const resolved = resolveModelProfile({ provider: "acme", model: "m", profiles: registry });
    expect(resolved.profile.id).toBe("first");
    expect(resolved.warnings.some((warning) => warning.startsWith("ambiguous_profile_match:first,second"))).toBe(true);
  });
});

describe("security-gate: C6 model profiles — validation refuses broken profiles", () => {
  it("rejects every invalid field with a structured error", () => {
    const cases: Array<[string, () => void]> = [
      ["invalid_profile_id", () => validateCodeModelProfile(profile({ id: "  ", match: { models: ["m"] } }))],
      ["invalid_tool_calling_mode", () => validateCodeModelProfile(profile({ id: "x", match: { models: ["m"] }, toolCallingMode: "magic" as never }))],
      ["invalid_parallel_tool_calls", () => validateCodeModelProfile(profile({ id: "x", match: { models: ["m"] }, maxParallelToolCalls: 0 }))],
      ["invalid_parallel_tool_calls", () => validateCodeModelProfile(profile({ id: "x", match: { models: ["m"] }, maxParallelToolCalls: MAX_PARALLEL_TOOL_CALLS + 1 }))],
      ["invalid_context_window", () => validateCodeModelProfile(profile({ id: "x", match: { models: ["m"] }, contextWindow: MIN_CONTEXT_WINDOW - 1 }))],
      ["invalid_temperature", () => validateCodeModelProfile(profile({ id: "x", match: { models: ["m"] }, temperature: 9 }))],
      ["invalid_preferred_edit_tool", () => validateCodeModelProfile(profile({ id: "x", match: { models: ["m"] }, preferredEditTool: " " }))],
      ["invalid_profile_match", () => validateCodeModelProfile(profile({ id: "x", match: {} }))],
      ["invalid_profile_match", () => validateCodeModelProfile(profile({ id: "x", match: { models: [] } }))],
      ["invalid_profile_match", () => validateCodeModelProfile(profile({ id: "x", match: { patterns: ["  "] } }))],
      ["invalid_profile_pattern", () => validateCodeModelProfile(profile({ id: "x", match: { patterns: ["*"] } }))],
      ["invalid_profile_lines", () => validateCodeModelProfile(profile({ id: "x", match: { models: ["m"] }, knownLimitations: [""] }))],
    ];

    for (const [code, run] of cases) {
      let thrown: unknown;
      try {
        run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `expected ${code} to be thrown`).toBeInstanceOf(CodeModelProfileError);
      expect((thrown as CodeModelProfileError).code).toBe(code);
      expect((thrown as CodeModelProfileError).status).toBe(400);
    }
  });

  it("only the conservative profile may match nothing", () => {
    expect(() => validateCodeModelProfile(CONSERVATIVE_CODE_MODEL_PROFILE, { allowEmptyMatch: true })).not.toThrow();
    expect(() => validateCodeModelProfile(CONSERVATIVE_CODE_MODEL_PROFILE)).toThrow(CodeModelProfileError);
  });

  it("anchors pattern matching so a lookalike vendor cannot borrow a profile", () => {
    expect(matchesModelPattern("claude-3-5", "claude-*")).toBe(true);
    expect(matchesModelPattern("evil-claude-3-5", "claude-*")).toBe(false);
    expect(matchesModelPattern("evil-claude-3-5", "*claude*")).toBe(true);
    expect(matchesModelPattern("gpt-4o-mini", "gpt-?o-*")).toBe(true);
    expect(matchesModelPattern("", "*")).toBe(false);
    expect(matchesModelPattern("anything", "  ")).toBe(false);
  });

  it("exposes a stable trace for Activity", () => {
    const resolved = resolveModelProfile({ provider: "anthropic", model: "claude-3-5-sonnet" });
    const trace = modelProfileTrace(resolved);
    expect(Object.keys(trace).sort()).toEqual(["matchedBy", "maxParallelToolCalls", "profileId", "toolCallingMode"]);
    expect(CODE_TOOL_CALLING_MODES).toContain(trace.toolCallingMode);
  });
});
