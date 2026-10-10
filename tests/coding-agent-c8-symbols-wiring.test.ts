import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseCtags, symbolsOutline } from "../apps/agent-api/src/code-tools-fs";

/**
 * C8 — `code.symbols.outline` is actually connected.
 *
 * The defect this file pins is not a wrong answer, it is a **silent no-op**: the `runCtags` port was declared,
 * threaded through `allCanonicalExecutors` and fully implemented, but `app.ts` never supplied it, so the tool
 * always answered `symbols_unavailable`. It was in the canonical registry, visible in the Capability Inspector,
 * callable by the agent, and could never work — the same class as a lease reaper that is never started.
 *
 * Two independent checks, because each catches a different half:
 *  1. behaviour — a supplied runner is invoked and its output is parsed; an absent/failing runner yields the
 *     structured `symbols_unavailable` and never an exception (the model must be able to continue);
 *  2. wiring — a source guard asserts `app.ts` passes `runCtags` into the canonical executors, so deleting the
 *     connection fails the gate instead of quietly disabling a published tool.
 */

// ESM-safe: `__dirname` does not exist in module scope, and a suite that fails to load reports zero tests.
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("[C8] [security-gate] symbols.outline runner behaviour", () => {
  it("invokes the injected runner and parses its output", async () => {
    const runCtags = vi.fn(async () =>
      [
        JSON.stringify({ _type: "tag", name: "alpha", kind: "function", line: 3 }),
        JSON.stringify({ _type: "tag", name: "Beta", kind: "class", line: 12 }),
      ].join("\n"),
    );
    const result = await symbolsOutline({ port: { runCtags } as never, path: "src/a.ts" });
    expect(runCtags).toHaveBeenCalledWith("src/a.ts");
    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.symbols).toEqual([
      { name: "alpha", kind: "function", line: 3 },
      { name: "Beta", kind: "class", line: 12 },
    ]);
  });

  it("reports structured unavailability when ctags is absent from the image", async () => {
    // The runner returns null exactly as the sandbox adapter does when `ctags` is not installed.
    const result = await symbolsOutline({ port: { runCtags: async () => null } as never, path: "src/a.ts" });
    expect(result).toEqual({ available: false, reason: "symbols_unavailable", path: "src/a.ts", symbols: [], truncated: false });
  });

  it("reports structured unavailability when the runner throws, never an exception", async () => {
    const result = await symbolsOutline({
      port: {
        runCtags: async () => {
          throw new Error("sandbox unavailable");
        },
      } as never,
      path: "src/a.ts",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("symbols_unavailable");
  });

  it("reports structured unavailability when the port is unwired, which is why the wiring matters", async () => {
    const result = await symbolsOutline({ port: {} as never, path: "src/a.ts" });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("symbols_unavailable");
  });

  it("parses the classic tab-separated form as well, so an older ctags still works", () => {
    const classic = ["alpha\tsrc/a.ts\t/^function alpha()$/;\tfunction\tline:3", "Beta\tsrc/a.ts\t/^class Beta$/;\tclass\tline:12"].join("\n");
    expect(parseCtags(classic)).toEqual([
      { name: "alpha", kind: "function", line: 3 },
      { name: "Beta", kind: "class", line: 12 },
    ]);
  });
});

describe("[C8] [security-gate] symbols.outline is wired in app.ts", () => {
  const source = ["app.ts", "code-tool-runtime-wiring.ts"].map((file) => readFileSync(path.join(workspaceRoot, "apps", "agent-api", "src", file), "utf8")).join("\n");

  it("passes the ctags runner into the canonical executors", () => {
    const executorsAt = source.indexOf("allCanonicalExecutors({");
    expect(executorsAt).toBeGreaterThan(-1);
    const block = source.slice(executorsAt, source.indexOf("\n    }),", executorsAt));
    expect(block).toContain("runCtags:");
  });

  it("runs ctags through the sandbox transport, never on the host", () => {
    const executorsAt = source.indexOf("allCanonicalExecutors({");
    const block = source.slice(executorsAt, source.indexOf("\n    }),", executorsAt));
    // The single sandbox transport is the only thing allowed to start a command; a direct
    // child_process/exec call here would run repository code on the API host.
    expect(block).toContain("codeSandboxExecPort.execute(");
    expect(block).not.toContain("child_process");
    expect(block).not.toContain("execSync");
    expect(block).not.toContain("spawnSync");
  });
});
