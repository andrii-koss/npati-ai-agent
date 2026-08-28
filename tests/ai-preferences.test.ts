import { AIPreferencesStore } from "../apps/agent-api/src/ai-preferences";
import type { AIModelSummary } from "@npati/omniroute-adapter";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let directory: string;
let store: AIPreferencesStore;
const model: AIModelSummary = { id: "openai/gpt-test", upstreamId: "gpt-test", providerId: "openai", providerName: "OpenAI", name: "GPT Test", capabilities: ["text"], added: false, local: false, freeStatus: "unknown" };

beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "npati-ai-test-")); store = new AIPreferencesStore(directory); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("NPATI AI preferences", () => {
  it("13. adds a model once", async () => {
    await store.add(model); await store.add(model);
    expect((await store.get()).addedModels).toHaveLength(1);
  });

  it("14. removes a model", async () => {
    await store.add(model); await store.remove(model.id);
    expect((await store.get()).addedModels).toEqual([]);
  });

  it("15. selects one default model", async () => {
    await store.add(model); await store.setDefault(model.id);
    expect((await store.get()).routing).toMatchObject({ mode: "manual", defaultModelId: model.id });
  });

  it("16. stores Automatic mode using the verified auto model", async () => {
    await store.setRouting("automatic");
    expect((await store.get()).routing).toMatchObject({
      mode: "automatic",
      defaultModelId: null,
      automaticModel: "auto/chat:free",
      preferFree: true,
      fallbackOnFailure: true,
      balanceQualityCost: true,
      compression: "stacked",
      monthlyBudgetUsd: 20,
      warningPercent: 80,
      stopPaidWhenLimitReached: true,
    });
  });

  it("17. requires an added default for Manual mode", async () => {
    await expect(store.setRouting("manual", model.id)).rejects.toThrow("My Models");
    await store.add(model);
    await expect(store.setRouting("manual", model.id)).resolves.toMatchObject({ routing: { mode: "manual", defaultModelId: model.id } });
  });

  it("18. persists production routing and budget policies", async () => {
    await store.setRouting("automatic", null, {
      preferFree: false,
      fallbackOnFailure: false,
      balanceQualityCost: false,
      compression: "off",
      monthlyBudgetUsd: 35,
      warningPercent: 75,
      stopPaidWhenLimitReached: false,
    });
    expect((await store.get()).routing).toMatchObject({
      automaticModel: "auto/smart",
      preferFree: false,
      fallbackOnFailure: false,
      compression: "off",
      monthlyBudgetUsd: 35,
      warningPercent: 75,
      stopPaidWhenLimitReached: false,
    });
  });
});
