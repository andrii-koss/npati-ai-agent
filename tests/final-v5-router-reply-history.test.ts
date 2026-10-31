import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { createChatProjectIntentResolver } from "../apps/agent-api/src/chat-project-intent";
const auth: AuthContext = { workspaceId: "d104", userId: "owner", permissions: ["*", "workspace:read", "workspace:write", "business:manage"] };
const message = "Antworte auf Deutsch: Nenne den Kontrollcode dieses Chats, ohne andere Chats zu lesen.";
const denial = "Ich habe keinen Zugriff auf einen Kontrollcode dieses Chats.";
const resolve = () => createChatProjectIntentResolver({ log: { warn: vi.fn() }, getAIContext: async () => ({}),
 engine: { chat: vi.fn(async () => ({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: null, coreCapability: null, coreMutation: false, assignsWorkToCompanyAgent: false, reply: denial, format: "none" }) })) } });
const turn = (role: "user" | "assistant", content: string) => ({ role, content });
describe("D104: the router answers directly only when it saw the whole conversation", () => {
 it("leaves a question about an earlier turn outside its window to the full turn", async () => {
  const history = [turn("user", "Remember only CHAT_B_PLUM_642 as this conversation checkpoint."), turn("assistant", "Noted: CHAT_B_PLUM_642."),
   turn("user", "Read the attached test document."), turn("assistant", "Marker: FILE_TANGERINE_642; count: 17."),
   turn("user", "Explica cómo separar observaciones de recomendaciones."), turn("assistant", "Primero los hechos, luego las acciones.")];
  const result = await resolve()(auth, { message, conversationHistory: history });
  expect(result.coreRoute).toBeDefined(); expect(result.coreRoute?.reply).toBeUndefined();
 });
 it("leaves the answer to the full turn when a message in the window was truncated", async () => {
  const result = await resolve()(auth, { message, conversationHistory: [turn("user", "x".repeat(2100) + " CHAT_B_PLUM_642"), turn("assistant", "Noted.")] });
  expect(result.coreRoute?.reply).toBeUndefined();
 });
 it("keeps the direct reply for a short conversation the router saw completely", async () => {
  const result = await resolve()(auth, { message: "Hallo, wie geht's?", conversationHistory: [turn("user", "Hi"), turn("assistant", "Hello!")] });
  expect(result.coreRoute?.reply).toBe(denial);
 });
});
