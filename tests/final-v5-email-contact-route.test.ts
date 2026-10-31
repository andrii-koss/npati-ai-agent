import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { createChatProjectIntentResolver } from "../apps/agent-api/src/chat-project-intent";
const auth: AuthContext = { workspaceId: "d107", userId: "owner", permissions: ["*", "workspace:read", "workspace:write", "business:manage"] };
const companyRoute = vi.fn(async () => ({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: null, coreCapability: "npati_company_action", coreMutation: true, assignsWorkToCompanyAgent: false }) }));
const resolve = (message: string) => createChatProjectIntentResolver({ engine: { chat: companyRoute }, getAIContext: async () => ({}), log: { warn: vi.fn() } })(auth, { message, activeCompanyId: "bakery" });

describe("D107: an email contact named in a Company keeps the email tool reachable", () => {
 it.each([
  'In company "Stress S15T Bakery", mark test contact spammer@npati.test as blacklisted and name it Stress Spammer. Do not block any other address.',
  "У компанії «Bakery» заблокуй контакт spam@npati.test.",
  'En la empresa "Bakery", bloquea el contacto spam@npati.test.',
 ])("routes %s to the email tool, keeping the Company tool", async message => {
  const result = await resolve(message);
  expect(result.coreCapability).toBe("npati_email_action");
  expect(result.coreRoute).toMatchObject({ capability: "npati_email_action", also: ["npati_company_action"], mutation: true });
 });
 it.each([
  'In company "Bakery", remember that our support email is help@bakery.test.',
  'Give agent Lead in "Bakery" the email.send tool.',
  'In company "Bakery", change the brand tone to warm.',
 ])("keeps the Company tool for %s", async message => {
  const result = await resolve(message);
  expect(result.coreRoute).toMatchObject({ capability: "npati_company_action", mutation: true });
  expect(result.coreRoute?.also ?? []).not.toContain("npati_email_action");
 });
});
