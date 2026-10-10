/* The capability catalogue and its inspector, extracted from app.ts
 * (step 2c-7 of docs/refactoring/PLAN.md).
 *
 * Moved verbatim; the only edits are the closure locals that became deps
 * (app.log -> log) and the module import for the code that moved with it.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { DEFAULT_CODE_MODEL_PROFILES, resolveEnabledModelProfileIds } from "./code-model-profiles";
import { createCoreServices } from "./core-services";
import { FeatureFlagService } from "./feature-flags";
import { McpRuntimeCapabilityStore } from "./mcp-runtime-capabilities";
import { CODE_READ_FLAG, CODE_WRITE_FLAG, CapabilityInspectorService, buildCombinedCapabilityView, defaultCapabilityRegistry, defaultEffectiveCapabilityResolver, validateActiveContext } from "@npati/shared";
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
    // C2/C3: expose the Coding Agent feature-flag state per capability. Read-only tools are gated by
    // `code.read`, mutating tools by `code.write`, so both are resolved here. A missing flag service (or
    // a failed lookup) degrades to "unknown" instead of pretending the feature is enabled.
    let flagStates: Record<string, boolean> | undefined;
    let flagSourceAvailable = false;
    if (featureFlagService) {
      try {
        const options = { companyId: request.query.companyId, userId: auth.userId };
        flagStates = {
          [CODE_READ_FLAG]: await featureFlagService.isEnabled(auth, CODE_READ_FLAG, options),
          [CODE_WRITE_FLAG]: await featureFlagService.isEnabled(auth, CODE_WRITE_FLAG, options),
          // C4: command execution hangs off its own sub-flag, so the Inspector reports the flag that
          // actually governs `code.shell.*` instead of assuming the write flag.
          ["code.shell"]: await featureFlagService.isEnabled(auth, "code.shell", options),
        };
        flagSourceAvailable = true;
      } catch {
        flagStates = undefined;
        flagSourceAvailable = false;
      }
    }
    const report = capabilityInspector.inspect((request.query.slice as any) || "all", resolutionContext, { flagStates, flagSourceAvailable });
    /**
     * C14 (owner decision 2): the **model-profile rollout state** of this context, added to the report.
     *
     * The conservative profile stays the fail-closed answer, and C14 deliberately does **not** turn an empty
     * `enabledProfileIds` into pattern matching — that would hand every deployment the behaviour the
     * `code.model_profile.<id>` flags are supposed to gate. What was missing is that the degradation was
     * *invisible*: an operator could not tell "no profile is enabled yet" from "the registry broke". This
     * section says which ids the deployment allows, whether that list is empty, and whether the flag store
     * could be read at all; `fallbackReason` is `profile_flag_disabled` exactly when the list is empty, because
     * then **every** run falls back whatever model it asks for. A non-empty list carries `null` here: whether a
     * run falls back then depends on its model, and that is recorded per run in the ExecutionSnapshot.
     */
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
        // Fail closed and say so: a flag store that cannot be read enables nothing, which is what the defaults above state.
      }
    }
    /**
     * C13 (owner decision 5 and 8): the **combined** view, when asked for. `includeRuntime=true` first runs a
     * discovery pass for the requested Company (so the runtime list is current rather than whatever the process
     * happened to hold) and then returns the static Inspector report plus the tenant's runtime overlay, each with
     * its own count (`buildCombinedCapabilityView`). The static numbers are the ones the Inspector just produced,
     * so a runtime tool can never be counted as static — and an unauthenticated or missing `companyId` answers
     * the plain static report, because a runtime overlay is tenant data.
     */
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
    return { ...report, modelProfiles };
  });
}
