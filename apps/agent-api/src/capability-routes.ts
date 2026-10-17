
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { DEFAULT_CODE_MODEL_PROFILES, resolveEnabledModelProfileIds } from "./code-model-profiles";
import { createCoreServices } from "./core-services";
import { currentToolManifest } from "./code-tool-registry";
import { FeatureFlagService, CODE_AGENT_MASTER_FLAG, CODE_AGENT_SUB_FLAGS } from "./feature-flags";
import { McpRuntimeCapabilityStore } from "./mcp-runtime-capabilities";
import { CapabilityInspectorService, buildCombinedCapabilityView, defaultCapabilityRegistry, defaultEffectiveCapabilityResolver, validateActiveContext } from "@npati/shared";
import type { AuthContext } from "@npati/workspace";
import { createMcpRuntimeRunPath } from "./mcp-run-path";

export interface CapabilityRouteDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  agent: ReturnType<typeof createCoreServices>["agent"];
  authProvider: ReturnType<typeof createCoreServices>["authProvider"];
  discoverRuntimeMcpCapabilities: (ctx: AuthContext, companyId: string) => ReturnType<ReturnType<typeof createMcpRuntimeRunPath>["discover"]>;
  featureFlagService: FeatureFlagService;
  mcpRuntimeCapabilities: McpRuntimeCapabilityStore;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
}

export function registerCapabilityRoutes(app: FastifyInstance, deps: CapabilityRouteDeps): void {
  const { agent, authProvider, discoverRuntimeMcpCapabilities, featureFlagService, mcpRuntimeCapabilities, workspaceStore } = deps;
  app.get<{ Querystring: { type?: string; domain?: string; callable?: string } }>("/capabilities", async (request) => {
    const callable = request.query.callable !== undefined ? request.query.callable === "true" : undefined;
    return defaultCapabilityRegistry.list({
      type: request.query.type as any,
      domain: request.query.domain as any,
      agentCallable: callable,
    });
  });

  const capabilityInspector = new CapabilityInspectorService(defaultEffectiveCapabilityResolver);

  app.get<{ Querystring: { slice?: string; companyId?: string; agentId?: string; includeRuntime?: string } }>("/capabilities/inspect", async (request) => {
    const auth = await authProvider.authenticate(request);
    let resolutionContext;
    if (request.query.companyId) {
      const company = await workspaceStore.getCompany(auth, request.query.companyId).catch(() => undefined);
      resolutionContext = {
        auth,
        activeContext: validateActiveContext({ contextType: "company", companyId: request.query.companyId }),
        company: company ? { id: company.id, revision: company.revision } : undefined,
        agent: request.query.agentId ? { id: request.query.agentId, revision: 1, tools: ["*"] } : undefined,
      };
    }

    let flagStates: Record<string, boolean> | undefined;
    let flagSourceAvailable = false;
    if (featureFlagService) {
      try {
        const options = { companyId: request.query.companyId, userId: auth.userId };
        const keys = [CODE_AGENT_MASTER_FLAG, ...CODE_AGENT_SUB_FLAGS];
        flagStates = Object.fromEntries(await Promise.all(keys.map(async key =>
          [key, await featureFlagService.isEnabled(auth, key, options)] as const)));
        flagSourceAvailable = true;
      } catch {
        flagStates = undefined;
        flagSourceAvailable = false;
      }
    }
    const report = capabilityInspector.inspect((request.query.slice as any) || "all", resolutionContext, { flagStates, flagSourceAvailable });

    const versions = new Map<string, number>();
    for (const tool of currentToolManifest().tools) {
      if (tool.version > (versions.get(tool.name) ?? 0)) versions.set(tool.name, tool.version);
    }
    const versionedReport = { ...report, items: report.items.map(item => ({
      ...item, ...(versions.has(item.capabilityId) ? { toolVersion: versions.get(item.capabilityId) } : {}),
    })) };

    const registryProfileIds = DEFAULT_CODE_MODEL_PROFILES.map((profile) => profile.id);
    let modelProfiles: {
      registryProfileIds: string[];
      enabledProfileIds: string[];
      enabledProfileIdsIsEmpty: boolean;
      flagSourceAvailable: boolean;
      fallbackReason: "profile_flag_disabled" | null;
      note: string;
    } = {
      registryProfileIds,
      enabledProfileIds: [],
      enabledProfileIdsIsEmpty: true,
      flagSourceAvailable: false,
      fallbackReason: "profile_flag_disabled",
      note: "No flag source is available, so no profile is enabled and every run resolves to the conservative profile (fail closed).",
    };
    if (featureFlagService) {
      try {
        const enabled = await resolveEnabledModelProfileIds({
          flags: featureFlagService,
          ctx: auth,
          ...(request.query.companyId ? { companyId: request.query.companyId } : {}),
        });
        const empty = enabled.length === 0;
        modelProfiles = {
          registryProfileIds,
          enabledProfileIds: [...enabled],
          enabledProfileIdsIsEmpty: empty,
          flagSourceAvailable: true,
          fallbackReason: empty ? "profile_flag_disabled" : null,
          note: empty
            ? "No code.model_profile.<id> flag is enabled for this context, so every run uses the conservative profile (fail closed) until a rollout enables one."
            : "These profiles are eligible for a run; a model that matches none of them still falls back to the conservative profile (no_matching_profile).",
        };
      } catch {

      }
    }

    if (request.query.includeRuntime === "true" && request.query.companyId) {
      const tenant = { workspaceId: auth.workspaceId, companyId: request.query.companyId };
      const discovery = await discoverRuntimeMcpCapabilities(auth, request.query.companyId);
      const combined = buildCombinedCapabilityView(mcpRuntimeCapabilities.overlayFor(tenant), capabilityInspector);
      return {
        ...report,
        modelProfiles,
        runtime: {
          discovery,
          counts: combined.counts,
          sources: combined.sources,
          items: combined.overlayItems,
        },
      };
    }
    return { ...versionedReport, modelProfiles };
  });
}
