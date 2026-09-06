import { describe, expect, it } from "vitest";
import {
  MemoryImportPipeline,
  CodeModePolicyController,
  ClawHubRegistryClient,
} from "../apps/agent-api/src/memory-import-codemode-clawhub";

describe("Memory Import Pipeline (Memory import)", () => {
  it("imports structured markdown notes into searchable memory records", () => {
    const pipeline = new MemoryImportPipeline();
    const md = `
# System Architecture
Use PostgreSQL pgvector with int8 quantization.

# Deployment Standards
Always verify mutual TLS on edge relays.
`;

    const result = pipeline.importArchive("markdown_notes", md);
    expect(result.importedCount).toBe(2);
    expect(result.memories[0]!.content).toContain("PostgreSQL pgvector");
    expect(result.memories[1]!.content).toContain("mutual TLS");
  });

  it("imports JSON chat exports", () => {
    const pipeline = new MemoryImportPipeline();
    const json = JSON.stringify([
      { role: "user", content: "How does OmniRoute Radar work?" },
      { role: "assistant", content: "It calculates a rolling average of provider latency." },
    ]);

    const result = pipeline.importArchive("chatgpt_json", json);
    expect(result.importedCount).toBe(2);
    expect(result.memories[0]!.author).toBe("user");
    expect(result.memories[1]!.author).toBe("assistant");
  });
});

describe("Code Mode Policy Controller (Code Mode)", () => {
  it("enables code mode directives and blocks dangerous eval calls", () => {
    const controller = new CodeModePolicyController();

    const activation = controller.enable();
    expect(activation.active).toBe(true);
    expect(activation.promptDirective).toContain("CODE_MODE_ACTIVE");

    // Block dangerous eval
    const badCode = "const fn = eval('process.exit(1)');";
    const badRes = controller.validateExecution(badCode, "typescript");
    expect(badRes.allowed).toBe(false);
    expect(badRes.securityClearance).toBe("blocked");

    // Allow safe code
    const safeCode = "interface Config { port: number; } const c: Config = { port: 3000 };";
    const safeRes = controller.validateExecution(safeCode, "typescript");
    expect(safeRes.allowed).toBe(true);
    expect(safeRes.securityClearance).toBe("approved");
  });
});

describe("ClawHub Registry Client (ClawHub)", () => {
  it("searches and installs community skills and tool packs", () => {
    const hub = new ClawHubRegistryClient();

    const searchResults = hub.search("kubernetes");
    expect(searchResults.length).toBe(1);
    expect(searchResults[0]!.name).toContain("Kubernetes");

    const installRes = hub.install("pkg-k8s-operator");
    expect(installRes.success).toBe(true);
    expect(installRes.package?.installed).toBe(true);

    const installedList = hub.listInstalled();
    expect(installedList.length).toBe(1);
    expect(installedList[0]!.id).toBe("pkg-k8s-operator");
  });
});
