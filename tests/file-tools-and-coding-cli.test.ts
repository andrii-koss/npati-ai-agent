import { describe, expect, it } from "vitest";
import {
  SecureFileToolsEngine,
  CodingCliGateway,
  OmnirouteRunRunner,
} from "../apps/agent-api/src/coding-cli-and-file-tools";

describe("Secure File Tools Engine (SecureFileToolsEngine)", () => {
  it("writes, reads sliced lines, and replaces content chunks", () => {
    const engine = new SecureFileToolsEngine();
    const filePath = "/workspace/src/app.ts";

    const content = "line 1\nline 2\nline 3\nline 4\nline 5";
    const writeRes = engine.writeFile(filePath, content);

    expect(writeRes.bytesWritten).toBeGreaterThan(0);
    expect(writeRes.sha256).toBeDefined();

    // Read range 2 to 4
    const readRes = engine.readFile(filePath, { startLine: 2, endLine: 4 });
    expect(readRes).not.toBeNull();
    expect(readRes?.content).toBe("line 2\nline 3\nline 4");
    expect(readRes?.totalLines).toBe(5);

    // Replace chunk
    const replaced = engine.replaceChunk(filePath, "line 3", "line 3 (modified)");
    expect(replaced).toBe(true);

    const checkRes = engine.readFile(filePath);
    expect(checkRes?.content).toContain("line 3 (modified)");
  });
});

describe("Coding CLI Gateway (CodingCliGateway)", () => {
  it("executes CLI commands and strips ANSI terminal color sequences", async () => {
    const result = await CodingCliGateway.executeDevTool("git", ["status", "--short"], {
      rawStdout: "\u001b[32m M apps/agent-api/src/index.ts\u001b[0m",
      exitCode: 0,
    });

    expect(result.success).toBe(true);
    expect(result.tool).toBe("git");
    expect(result.cleanStdout).toBe("M apps/agent-api/src/index.ts");
  });
});

describe("Omniroute Run Runner (OmnirouteRunRunner)", () => {
  it("executes task recipes and returns structured summary", async () => {
    const result = await OmnirouteRunRunner.runRecipe("build-and-test", {
      workspace: "agent-api",
      verbose: true,
    });

    expect(result.runId).toMatch(/^run_/);
    expect(result.recipeName).toBe("build-and-test");
    expect(result.status).toBe("completed");
    expect(result.outputSummary).toContain("build-and-test");
  });
});
