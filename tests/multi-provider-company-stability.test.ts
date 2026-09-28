import { performance } from "node:perf_hooks";
import type { AIModelSummary } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext, type Company, type CompanyAgent } from "@npati/workspace";
import { beforeAll, describe, expect, it } from "vitest";
import { AIPreferencesStore } from "../apps/agent-api/src/ai-preferences";

const PROVIDER_COUNT = 50;
const COMPANY_COUNT = 10;
const AGENTS_PER_COMPANY = 60;
const READ_OPERATIONS = 2_000;

const owner: AuthContext = {
  workspaceId: "stability-workspace",
  userId: "stability-owner",
  permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"],
};
const outsider: AuthContext = {
  workspaceId: "other-workspace",
  userId: "other-user",
  permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"],
};

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

describe.sequential("50-provider / 10-company / 600-agent stability", () => {
  const workspace = new InMemoryWorkspaceStore();
  const preferences = new AIPreferencesStore(workspace);
  const preferenceReplicas = Array.from({ length: 10 }, () => new AIPreferencesStore(workspace));
  const providers: AIModelSummary[] = Array.from({ length: PROVIDER_COUNT }, (_, index) => ({
    id: `provider-${index}/model-${index}`,
    upstreamId: `model-${index}`,
    providerId: `provider-${index}`,
    providerName: `Provider ${index}`,
    name: `Stability Model ${index}`,
    capabilities: ["text"],
    added: false,
    local: index % 10 === 0,
    freeStatus: "unknown",
  }));
  const companies: Company[] = [];
  const agents: CompanyAgent[] = [];
  let provisionDurationMs = 0;
  let provisionHeapDeltaMb = 0;

  beforeAll(async () => {
    await workspace.initialize(owner);
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();

    await Promise.all(providers.map((provider, index) => preferenceReplicas[index % preferenceReplicas.length]!.add(owner, provider)));
    companies.push(...await Promise.all(
      Array.from({ length: COMPANY_COUNT }, (_, companyIndex) =>
        workspace.createCompany(owner, { name: `Stability Company ${companyIndex}` }, `stability-company-${companyIndex}`),
      ),
    ));
    agents.push(...await Promise.all(companies.flatMap((company, companyIndex) =>
      Array.from({ length: AGENTS_PER_COMPANY }, (_, agentIndex) =>
        workspace.createCompanyAgent(owner, company.id, {
          name: `Agent ${companyIndex + 1}-${agentIndex + 1}`,
          role: agentIndex === 0 ? "Coordinator" : `Specialist ${agentIndex}`,
          modelId: providers[(companyIndex * AGENTS_PER_COMPANY + agentIndex) % providers.length]!.id,
          fallbackModelId: providers[(companyIndex * AGENTS_PER_COMPANY + agentIndex + 1) % providers.length]!.id,
          tools: agentIndex % 2 === 0 ? ["Web Search", "Knowledge"] : ["Files"],
          isActive: true,
        }, `stability-agent-${companyIndex}-${agentIndex}`),
      ),
    )));

    provisionDurationMs = performance.now() - startedAt;
    provisionHeapDeltaMb = Math.max(0, process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
  }, 30_000);

  it("persists all providers, companies, and agents without loss or cross-company duplication", async () => {
    const storedPreferences = await preferences.get(owner);
    expect(storedPreferences.addedModels).toHaveLength(PROVIDER_COUNT);
    expect(new Set(storedPreferences.addedModels.map((model) => model.providerId)).size).toBe(PROVIDER_COUNT);
    expect(companies).toHaveLength(COMPANY_COUNT);
    expect(agents).toHaveLength(COMPANY_COUNT * AGENTS_PER_COMPANY);
    expect(new Set(agents.map((agent) => agent.id)).size).toBe(agents.length);

    for (const company of companies) {
      const companyAgents = await workspace.listCompanyAgents(owner, company.id);
      expect(companyAgents).toHaveLength(AGENTS_PER_COMPANY);
      expect(companyAgents.every((agent) => agent.companyId === company.id)).toBe(true);
    }

    expect(provisionDurationMs).toBeLessThan(10_000);
    expect(provisionHeapDeltaMb).toBeLessThan(128);
  });

  it("serves 2,000 concurrent company reads with bounded latency and no data corruption", async () => {
    const latencies: number[] = [];
    const results = await Promise.all(Array.from({ length: READ_OPERATIONS }, async (_, index) => {
      const company = companies[index % companies.length]!;
      const startedAt = performance.now();
      const companyAgents = await workspace.listCompanyAgents(owner, company.id);
      latencies.push(performance.now() - startedAt);
      return { count: companyAgents.length, companyIsolated: companyAgents.every((agent) => agent.companyId === company.id) };
    }));

    expect(results.every((result) => result.count === AGENTS_PER_COMPANY)).toBe(true);
    expect(results.every((result) => result.companyIsolated)).toBe(true);
    // Shared CI runners execute other CPU-heavy scale files in parallel. Keep a
    // regression ceiling while allowing for scheduler contention outside the app.
    expect(percentile(latencies, 0.95)).toBeLessThan(1_500);
    expect(percentile(latencies, 0.99)).toBeLessThan(2_500);
  });

  it("keeps retries idempotent and tenant data isolated under concurrent access", async () => {
    const targetCompany = companies[0]!;
    const retried = await Promise.all(Array.from({ length: 100 }, () =>
      workspace.createCompanyAgent(owner, targetCompany.id, {
        name: "Idempotent retry agent",
        role: "Specialist",
        modelId: providers[0]!.id,
      }, "same-retried-agent"),
    ));
    await Promise.all(Array.from({ length: 100 }, (_, index) => preferenceReplicas[index % preferenceReplicas.length]!.add(owner, providers[0]!)));

    expect(new Set(retried.map((agent) => agent.id)).size).toBe(1);
    expect(await workspace.listCompanyAgents(owner, targetCompany.id)).toHaveLength(AGENTS_PER_COMPANY + 1);
    expect((await preferences.get(owner)).addedModels).toHaveLength(PROVIDER_COUNT);
    expect((await workspace.listCompanies(outsider, 100)).items).toEqual([]);
    expect((await preferences.get(outsider)).addedModels).toEqual([]);
    await expect(workspace.getCompany(outsider, targetCompany.id)).rejects.toThrow();
  });
});
