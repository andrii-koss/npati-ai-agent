import { describe, expect, it } from "vitest";
import {
  OmnirouteConfigureWizard,
  CursorAcpAdapter,
  GithubCopilotAcpAdapter,
} from "../apps/agent-api/src/cli-configure-and-acp-editors";

describe("Omniroute Configure Wizard (omniroute configure)", () => {
  it("generates and validates CLI configuration profile", () => {
    const profile = OmnirouteConfigureWizard.generateConfig({
      defaultProvider: "openai",
      apiKey: "sk-ant-api03-test-key-12345",
      routingStrategy: "lowest-latency",
      activeChannels: ["telegram", "web", "discord"],
    });

    expect(profile.version).toBe("3.8.50");
    expect(profile.defaultProvider).toBe("openai");
    expect(profile.hasApiKey).toBe(true);
    expect(profile.activeChannels.length).toBe(3);

    const isValid = OmnirouteConfigureWizard.validateProfile(profile);
    expect(isValid).toBe(true);
  });
});

describe("Cursor via ACP Adapter (Cursor via ACP)", () => {
  it("manages Cursor ACP sessions and generates instruction diffs", () => {
    const adapter = new CursorAcpAdapter();

    const session = adapter.createSession("cursor-sess-1", "/workspace/npati");
    expect(session.status).toBe("connected");

    const edit = adapter.streamCodeEdit(
      "cursor-sess-1",
      "src/index.ts",
      "Add healthcheck route"
    );

    expect(edit.modifiedFile).toBe("src/index.ts");
    expect(edit.diff).toContain("[Cursor ACP] Add healthcheck route");
  });
});

describe("GitHub Copilot via ACP Adapter (GitHub Copilot via ACP)", () => {
  it("processes Copilot context and generates completion suggestions", () => {
    const adapter = new GithubCopilotAcpAdapter();

    const res = adapter.handleCopilotTurn("Refactor memory lookup into async function", {
      currentFile: "apps/agent-api/src/memory.ts",
      cursorLine: 42,
      repoRoot: "/npati",
    });

    expect(res.completion).toContain("[GitHub Copilot ACP]");
    expect(res.completion).toContain("apps/agent-api/src/memory.ts:42");
    expect(res.citations).toContain("apps/agent-api/src/memory.ts");
  });
});
