import { expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { createChatProjectIntentResolver } from "../apps/agent-api/src/chat-project-intent";

const auth: AuthContext = { workspaceId: "w", userId: "u", permissions: ["workspace:read", "workspace:write"] };

// Live V6 step 04: "виконай у терміналі: node -e … і скажи код завершення" in a project chat was classified as CHAT and
// answered without running anything. The router is told that a terminal command in the active project is a project run.
it("routes a terminal command in the active project to the coding agent", async () => {
  const chat = vi.fn(async (request: { messages: Array<{ role: string; content: unknown }> }) => {
    const system = String(request.messages[0]?.content);
    const runsCommands = /terminal command[^.]*DEBUG_PROJECT/u.test(system);
    return { content: JSON.stringify({ intent: runsCommands ? "DEBUG_PROJECT" : "CHAT", confidence: 0.95, targets: [] }) };
  });
  const resolve = createChatProjectIntentResolver({ engine: { chat } as never, getAIContext: async () => ({}) as never, log: { warn: vi.fn() } as never });
  const result = await resolve(auth, { message: "виконай у терміналі: node -e \"process.exit(3)\" і скажи код завершення", activeProjectId: "project", activeCompanyId: "company" });
  expect(result.decision.intent).toBe("DEBUG_PROJECT");
});
