import { describe, expect, it } from "vitest";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { CodeSessionRunExecutor } from "../apps/agent-api/src/code-session-run-executor";

const ctx: AuthContext = { userId: "owner", workspaceId: "workspace", permissions: ["workspace:write"] };

describe("a coding run that fails before it starts", () => {
  it("keeps the user-facing text of a missing vision model, and nothing else", async () => {
    const run = async (error: Error) => new CodeSessionRunExecutor({
      runner: { run: async () => { throw error; } },
      control: { clearSession: () => {}, registerController: () => {}, unregisterController: () => {} },
    }).execute({ ctx, session: { id: "session" } as unknown as CodeSession, prompt: "redesign from this photo", cancelRequested: () => false });
    const vision = await run(new Error("vision_model_unavailable: Для роботи з фото потрібна підключена модель із підтримкою зображень."));
    expect(vision.terminalStatus).toBe("failed");
    expect((vision.result as { message?: string }).message).toBe("Для роботи з фото потрібна підключена модель із підтримкою зображень.");
    const other = await run(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    expect((other.result as { message?: string }).message).toBeUndefined();
  });
});
