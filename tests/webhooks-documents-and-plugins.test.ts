import { describe, expect, it } from "vitest";
import { OutboundWebhookDispatcher } from "../apps/agent-api/src/outbound-webhook-dispatcher";
import { DocumentIoManager } from "../apps/agent-api/src/document-io-manager";
import { PluginLifecycleSystem, type NpatiPlugin } from "../apps/agent-api/src/plugin-lifecycle-system";

describe("Outbound Webhook Dispatcher (OutboundWebhookDispatcher)", () => {
  it("dispatches HMAC-signed event payloads to subscribed endpoints", async () => {
    const dispatcher = new OutboundWebhookDispatcher();
    const companyId = "comp-webhooks-1";
    const secret = "webhook_secret_key_12345";

    await dispatcher.registerSubscription({
      companyId,
      url: "https://api.example.com/events",
      secret,
      events: ["agent.task_completed"],
    });

    const results = await dispatcher.dispatchEvent(
      companyId,
      "agent.task_completed",
      { taskId: "t-99", output: "Task done" },
      async (_url, _payload, headers) => {
        expect(headers["X-NPATI-Signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
        expect(headers["X-NPATI-Event"]).toBe("agent.task_completed");
        return 200;
      }
    );

    expect(results.length).toBe(1);
    expect(results[0].delivered).toBe(true);
    expect(results[0].statusCode).toBe(200);
  });
});

describe("Document Input/Output Manager (DocumentIoManager)", () => {
  it("parses CSV documents with structured table extraction", () => {
    const csvData = "Name,Role,Department\nAlex,Engineer,Core\nMaria,Lead,AI";
    const parsed = DocumentIoManager.parseDocument(csvData, "team.csv");

    expect(parsed.format).toBe("csv");
    expect(parsed.tables).toBeDefined();
    expect(parsed.tables?.[0].headers).toEqual(["Name", "Role", "Department"]);
    expect(parsed.tables?.[0].rows.length).toBe(2);
  });

  it("generates markdown documents with tables", () => {
    const doc = DocumentIoManager.generateDocument(
      {
        title: "Sprint Report",
        text: "Sprint 42 accomplishments:",
        table: {
          headers: ["Task", "Status"],
          rows: [
            ["OAuth 2.0 PKCE", "Done"],
            ["Webhooks", "Done"],
          ],
        },
      },
      "markdown"
    );

    expect(doc).toContain("# Sprint Report");
    expect(doc).toContain("| Task | Status |");
    expect(doc).toContain("| OAuth 2.0 PKCE | Done |");
  });
});

describe("Plugin Lifecycle System (PluginLifecycleSystem)", () => {
  it("runs plugin lifecycle hooks (beforePrompt, afterResponse)", async () => {
    const system = new PluginLifecycleSystem();

    const bannerPlugin: NpatiPlugin = {
      manifest: {
        id: "banner-plugin",
        name: "Security Banner Plugin",
        version: "1.0.0",
      },
      hooks: {
        beforePrompt: (prompt) => `[CLASSIFIED]\n${prompt}`,
        afterResponse: (response) => `${response}\n\n---\nVerified by Security Plugin`,
      },
    };

    system.registerPlugin(bannerPlugin);

    const transformedPrompt = await system.executeBeforePrompt("Hello AI", {});
    expect(transformedPrompt).toBe("[CLASSIFIED]\nHello AI");

    const transformedResponse = await system.executeAfterResponse("Analysis complete.", {});
    expect(transformedResponse).toBe("Analysis complete.\n\n---\nVerified by Security Plugin");
  });
});
