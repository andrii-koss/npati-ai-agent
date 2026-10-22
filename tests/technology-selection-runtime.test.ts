import { describe, expect, it, vi } from "vitest";
import { extractFramework, planChatDevelopment } from "@npati/shared";
import { createChatProjectIntentResolver } from "../apps/agent-api/src/chat-project-intent";
const auth = { workspaceId: "audit", userId: "audit", permissions: ["admin:all"] };
const matrix = [
  ["Створи простий сайт", "HTML/CSS", "website"],
  ["Створи інтернет-магазин", "Nuxt", "store"],
  ["Створи блог", "Astro", "blog"],
  ["Створи корпоративний сайт", "HTML/CSS", "website"],
  ["Створи CRM", "React + Vite", "crm"],
  ["Створи сайт на Vue", "Vue 3 + Vite", "website"],
  ["Створи інтернет-магазин на Laravel", "Laravel", "store"],
  ["Create an online store using Next.js", "Next.js", "store"],
  ["Створи простий HTML-сайт без фреймворків", "HTML/CSS", "website"],
] as const;
function fixture(framework: string, kind: string, fail = false) {
  const chat = vi.fn(async () => { if (fail) throw new Error("offline"); return { content: JSON.stringify({ intent: "CREATE_WEBSITE", confidence: 0.99, targets: [{ name: "Test", kind, framework, reason: "Chosen from content and interaction requirements", criteria: ["content", "interaction_complexity"] }] }) }; });
  return { chat, resolve: createChatProjectIntentResolver({ engine: { chat }, getAIContext: async () => ({}), log: { warn: vi.fn() } }) };
}
describe("authoritative technology selection contract", () => {
  it.each(matrix)("preserves the decision for %s", async (message, framework, kind) => {
    const f = fixture(framework, kind), r = await f.resolve(auth, { message });
    expect(r.source).toBe("semantic");
    expect(r.targets[0]).toMatchObject({ framework, technologySelection: { source: extractFramework(message) ? "user_explicit" : "ai_planner" } });
    expect(r.targets[0]?.technologySelection?.reason).toBeTruthy();
    expect(f.chat).toHaveBeenCalledOnce();
  });
  it("allows multiple stacks for the same store kind rather than hardcoding commerce", async () => {
    for (const stack of ["Nuxt", "Next.js", "Laravel", "Vue 3 + Vite"]) expect((await fixture(stack, "store").resolve(auth, { message: "Створи магазин" })).targets[0]?.framework).toBe(stack);
  });
  it.each(["Створи сайт на Vue", "Створи проєкт на Vue"])("repairs a conflicting model choice without losing explicit Vue: %s", async message => {
    const result = await fixture("Next.js", "website").resolve(auth, { message });
    expect(result.source).toBe("deterministic");
    expect(result.targets[0]?.framework).toBe("Vue 3 + Vite");
  });
  it("never selects a forbidden framework, including when planning fails", async () => {
    expect(extractFramework("Створи простий HTML-сайт без фреймворків")).toBe("HTML/CSS");
    for (const fail of [false, true]) expect((await fixture("Next.js", "website", fail).resolve(auth, { message: "Створи сайт без Next.js" })).targets[0]?.framework).toBe("HTML/CSS");
    expect(planChatDevelopment("Створи простий HTML-сайт без фреймворків")[0]?.framework).toBe("HTML/CSS");
  });
  it("does not silently replace explicitly requested unsupported PHP scaffolding", async () => {
    const f = fixture("Next.js", "website");
    const r = await f.resolve(auth, { message: "Створи сайт на PHP" });
    expect(r.targets).toEqual([]); expect(r.decision.needsClarification).toBe(true); expect(f.chat).not.toHaveBeenCalled();
  });
  it("blocks ambiguous commerce when the planner is unavailable, rather than inventing a stack", async () => {
    const r = await fixture("Next.js", "store", true).resolve(auth, { message: "Створи магазин" });
    expect(r.targets).toEqual([]); expect(r.decision.needsClarification).toBe(true);
  });
});
