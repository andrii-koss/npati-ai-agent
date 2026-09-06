import { describe, expect, it } from "vitest";
import {
  GeminiCliAcpAdapter,
  OpenCodeAcpAdapter,
  GeneralizedAcpHarnessRegistry,
} from "../apps/agent-api/src/acp-harnesses-and-drivers";

describe("Gemini CLI via ACP Adapter (Gemini CLI via ACP)", () => {
  it("processes prompts with multi-file context and estimates token usage", () => {
    const adapter = new GeminiCliAcpAdapter();

    const res = adapter.handleTurn("Analyze database index utilization", {
      model: "gemini-2.5-pro",
      contextFiles: ["schema.prisma", "db.ts", "indexes.sql"],
    });

    expect(res.harness).toBe("gemini-cli");
    expect(res.model).toBe("gemini-2.5-pro");
    expect(res.contextFilesCount).toBe(3);
    expect(res.response).toContain("schema.prisma");
    expect(res.tokensUsedEstimate).toBeGreaterThan(450);
  });
});

describe("OpenCode via ACP Adapter (OpenCode via ACP)", () => {
  it("executes safe commands and blocks dangerous shell exploits", () => {
    const adapter = new OpenCodeAcpAdapter();

    const safeRun = adapter.executeLoop("opencode-1", "npm test -- --filter auth");
    expect(safeRun.status).toBe("success");
    expect(safeRun.output).toContain("Command executed successfully");

    const dangerousRun = adapter.executeLoop("opencode-1", "rm -rf / --no-preserve-root");
    expect(dangerousRun.status).toBe("failed");
    expect(dangerousRun.output).toContain("rejected by ACP security sandbox policy");
  });
});

describe("Generalized ACP Harness Registry (Other ACP harnesses)", () => {
  it("registers custom harnesses and negotiates capability sets", () => {
    const registry = new GeneralizedAcpHarnessRegistry();

    const driver = registry.registerHarness({
      id: "zed-ide",
      name: "Zed Editor ACP Agent",
      transport: "websocket",
      capabilities: ["diff_apply", "diagnostics", "file_watch"],
    });

    expect(driver.id).toBe("zed-ide");
    expect(registry.listHarnesses().length).toBe(1);

    const negotiation = registry.negotiateCapabilities("zed-ide", [
      "diff_apply",
      "terminal_exec",
      "diagnostics",
    ]);

    expect(negotiation.supported).toEqual(["diff_apply", "diagnostics"]);
    expect(negotiation.missing).toEqual(["terminal_exec"]);
  });
});
