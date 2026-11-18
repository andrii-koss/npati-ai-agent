import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { HARD_DENY_RULES, classifyShellCommand, classifyShellRisk } from "../apps/agent-api/src/code-shell-classifier";
import { CodeShellRuntime, type CodeShellSandboxPort } from "../apps/agent-api/src/code-shell-runtime";
import { PolicyEngine } from "../apps/agent-api/src/code-policy-engine";
import type { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import { buildSandboxCreateArgs, DockerSandboxProvider } from "../apps/agent-api/src/docker-sandbox-provider";
import type { SandboxScope } from "../apps/agent-api/src/sandbox-provider";

/**
 * C14 red-team — fork bombs (G1 coverage item 2a of `security-gate/PLAN.md`: "fork bomb").
 *
 * The rule existed (`code-shell-classifier.ts`, `{ id: "fork_bomb", … }` in `HARD_DENY_RULES`) and no test
 * touched it: `grep fork_bomb tests/` returned nothing, so "a fork bomb is hard-denied" was a claim about a
 * regex nobody had run. This suite is the evidence, and writing it found a real bypass: the pattern used `.`
 * between the parts of the function body, which does not cross a newline, so the multi-line spelling of the
 * same fork bomb fell back to `approval` — an approvable fork bomb. `[\s\S]` fixed it (see
 * `apps/agent-api/src/code-shell-classifier.ts`), and both spellings are pinned below.
 *
 * Asserted here:
 *  - every spelling (one-liner, spaces, tabs, newlines, `bash -c`, chained, backgrounded) is `hard_deny`, and
 *    the rule that fired is named;
 *  - the rule is *load-bearing*, proved by substituting a rule set without it (mutation evidence);
 *  - the runtime really refuses it end to end through the **real** `PolicyEngine`, with an approval claim
 *    present, and the sandbox is never entered;
 *  - the blast radius is bounded structurally: the container carries `--pids-limit` and a limit below the
 *    provider's floor cannot be configured at all.
 */

const ctx: AuthContext = {
  workspaceId: "ws-c14",
  userId: "user-c14",
  permissions: ["workspace:read", "workspace:write", "owner"],
};

/** The shell runtime's flag port: every flag answers "enabled", so the guard under test is the only refusal. */
const ALLOW_ALL_FLAGS = { assertEnabled: async () => true, isEnabled: async () => true } as unknown as FeatureFlagService;

/** Every spelling of `:(){ :|:& };:` a shell accepts. The rule must not depend on whitespace. */
const FORK_BOMB_FORMS: readonly string[] = [
  ":(){ :|:& };:",
  ": () { :|: & } ; :",
  ":(){\t:|:\t&\t};:",
  ":(){\n:|:&\n};:",
  "bash -c ':(){ :|:& };:'",
  'sh -c ":(){ :|:& };:"',
  "cd /tmp && :(){ :|:& };:",
  "nohup :(){ :|:& };: >/dev/null 2>&1 &",
];

/** A function definition that is *not* a fork bomb: it neither pipes itself nor backgrounds itself. */
const HARMLESS_FUNCTIONS: readonly string[] = [
  "f() { echo hi; }",
  "greet() { echo hello; }",
  "cleanup() { rm -rf ./tmp; }",
];

function sandbox() {
  const calls: Array<Parameters<CodeShellSandboxPort["execute"]>[0]> = [];
  const port: CodeShellSandboxPort = {
    execute: async (input) => {
      calls.push(input);
      return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 3, status: "completed", sandboxId: "sbx" };
    },
  };
  return { port, calls };
}

/**
 * The **real** engine, not a double: the fork bomb has to be refused by the component that decides in
 * production. Only the ports the engine needs are stubbed, and every one of them answers "allowed" — flags
 * on, the capability present, a session mode in which an `approval`-class command would run (`full_auto`).
 * So the refusal below can only come from the classifier phase.
 */
function engine(): PolicyEngine {
  return new PolicyEngine({
    flags: { assertEnabled: async () => true },
    capabilities: { get: (id) => ({ id, version: 1, status: "active" }) },
    classifier: (command) => classifyShellCommand(command),
    approvals: { requestApproval: async () => ({ id: "approval-1" }), consumeApproved: async () => ({}) },
    sessionMode: async () => "full_auto",
  });
}

describe("security-gate: C14 red-team — fork bomb", () => {
  it("hard-denies every spelling of a fork bomb, including the multi-line one the rule used to miss", () => {
    for (const form of FORK_BOMB_FORMS) {
      const result = classifyShellCommand(form);
      expect(result.risk, `form: ${JSON.stringify(form)}`).toBe("hard_deny");
      expect(result.matched, `form: ${JSON.stringify(form)}`).toContain("fork_bomb");
      expect(result.reasons.join(" | "), `form: ${JSON.stringify(form)}`).toContain("fork bomb");
      // The convenience reader agrees with the rich one: one verdict, not two.
      expect(classifyShellRisk(form), `form: ${JSON.stringify(form)}`).toBe("hard_deny");
    }
    // The multi-line form is the regression this suite found: with `.` instead of `[\s\S]` it was `approval`.
    const multiline = classifyShellCommand(":(){\n:|:&\n};:");
    expect(multiline.risk).toBe("hard_deny");
    expect(classifyShellCommand(":(){ :|:& };:").matched).toContain("fork_bomb");
  });

  it("is not vacuous: the named rule exists, matches the attacks, and a harmless function definition passes", () => {
    const rule = HARD_DENY_RULES.find((entry) => entry.id === "fork_bomb");
    expect(rule).toBeDefined();
    if (!rule) throw new Error("the fork_bomb rule is missing from HARD_DENY_RULES");
    expect(rule.pattern.test(":(){ :|:& };:")).toBe(true);
    expect(rule.pattern.test(":(){\n:|:&\n};:")).toBe(true);
    // The rule discriminates: ordinary function definitions are *not* fork bombs, so the assertion above is
    // not "everything containing braces is denied".
    for (const harmless of HARMLESS_FUNCTIONS) {
      expect(rule.pattern.test(harmless), `harmless: ${harmless}`).toBe(false);
      expect(classifyShellCommand(harmless).risk, `harmless: ${harmless}`).not.toBe("hard_deny");
    }
    // Every rule is named and has a pattern, which is what the catalogue guard enumerates.
    expect(HARD_DENY_RULES.length > 0).toBe(true);
    expect(HARD_DENY_RULES.every((entry) => typeof entry.id === "string" && entry.pattern instanceof RegExp)).toBe(true);
  });

  it("never reaches the sandbox for a fork bomb, even with an approval claim and a full_auto session", async () => {
    const fake = sandbox();
    const runtime = new CodeShellRuntime({ sandbox: fake.port, policy: engine(), flags: ALLOW_ALL_FLAGS });
    let failure: unknown = null;
    try {
      await runtime.exec(ctx, {
        companyId: "company-c14",
        projectId: "project-c14",
        sessionId: "session-c14",
        toolCallId: "call-c14",
        command: ":(){ :|:& };:",
        approved: true,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).not.toBe(null);
    expect((failure as { code?: string }).code).toBe("command_hard_denied");
    expect((failure as { details?: { phase?: string } }).details?.phase).toBe("hard_deny");
    // Nothing was executed: the classifier phase runs before the sandbox is consulted.
    expect(fake.calls.length).toBe(0);
  });

  it("negative control: removing the fork_bomb rule from the evaluated set really lets the command through", () => {
    const mutated = HARD_DENY_RULES.filter((rule) => rule.id !== "fork_bomb");
    // The mutation is a substitution of the rule set, in memory: the module, the file and the frozen table
    // are untouched, and the real table is used again by the very next call.
    const withoutRule = classifyShellCommand(":(){ :|:& };:", { hardDenyRules: mutated });
    expect(withoutRule.risk).not.toBe("hard_deny");
    expect(withoutRule.matched.includes("fork_bomb")).toBe(false);
    expect(HARD_DENY_RULES.length).toBe(mutated.length + 1);
    expect(HARD_DENY_RULES.every((rule) => rule.id !== "fork_bomb" || rule.pattern instanceof RegExp)).toBe(true);

    // Restored by construction: the default set is still the full table, so the denial is the rule's doing.
    expect(classifyShellCommand(":(){ :|:& };:").risk).toBe("hard_deny");
    expect(classifyShellCommand(":(){ :|:& };:").matched).toContain("fork_bomb");

    // The seam is not an off-switch: disabling hard denies wholesale is refused instead of honoured.
    expect(() => classifyShellCommand("ls", { hardDenyRules: [] })).toThrow(/must not be empty/);
  });

  it("bounds the blast radius: the sandbox carries --pids-limit and a limit below the floor cannot be configured", () => {
    const scope: SandboxScope = { workspaceId: "ws-c14", userId: "user-c14", companyId: "company-c14", projectId: "project-c14" };
    const args = buildSandboxCreateArgs({
      sandboxName: "npati-sb-c14",
      sandboxId: "c14",
      network: "npati-net-c14",
      scope,
      image: "npati/project-sandbox:local",
      cpus: "1",
      memory: "1536m",
      pids: 128,
      diskBytes: 1536 * 1024 * 1024,
    });
    const line = args.join(" ");
    // A fork bomb amplifies process count, so the container is created with a process ceiling.
    expect(line).toContain("--pids-limit 128");
    // …and the ceiling is part of the hardening set that has no host escape.
    expect(line).toContain("--cap-drop ALL");
    expect(line).toContain("--security-opt no-new-privileges");
    expect(line.includes("--privileged")).toBe(false);
    expect(line.includes("docker.sock")).toBe(false);

    // The provider refuses a ceiling that would make the limit decorative, so the arg line above can never be
    // produced with a disabled limit: this is what makes the assertion more than a string check.
    expect(() => new DockerSandboxProvider({ pids: 0 })).toThrow(/resource limits/);
    expect(() => new DockerSandboxProvider({ pids: 15 })).toThrow(/resource limits/);
    expect(() => new DockerSandboxProvider({ diskBytes: 1 })).toThrow(/resource limits/);
    expect(() => new DockerSandboxProvider({ memory: "0m" })).toThrow(/resource limits/);
    expect(() => new DockerSandboxProvider({ cpu: "0" })).toThrow(/resource limits/);
    // The positive control: a valid ceiling is accepted, so the refusals above are about the values.
    expect(() => new DockerSandboxProvider({ pids: 128 })).not.toThrow();
  });
});
