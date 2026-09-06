import type { ActiveContext } from "./index";
import {
  type CapabilityDefinition,
  type CapabilityRegistry,
  defaultCapabilityRegistry,
} from "./capabilities";

export type ResolutionStatus = "allowed" | "denied" | "unavailable";

export type AllowedReasonCode =
  | "agent_allowlist"
  | "company_override"
  | "platform_default"
  | "skill_allowlist";

export type DeniedReasonCode =
  | "platform_policy"
  | "plan_tier"
  | "tenant_permissions"
  | "context_boundary"
  | "company_override"
  | "agent_allowlist"
  | "skill_policy";

export type UnavailableReasonCode =
  | "missing_connection"
  | "unhealthy_runtime"
  | "not_agent_callable";

export type ReasonCode = AllowedReasonCode | DeniedReasonCode | UnavailableReasonCode;

export interface CapabilityResolutionDetail {
  capabilityId: string;
  status: ResolutionStatus;
  reasonCode: ReasonCode;
  message: string;
}

export interface EffectiveCapabilityResolution {
  allowedIds: string[];
  allowedCapabilities: CapabilityDefinition[];
  details: Record<string, CapabilityResolutionDetail>;
  cacheKey: string;
  evaluatedAt: string;
}

export interface ResolutionContext {
  auth: {
    workspaceId: string;
    userId: string;
    permissions: string[];
  };
  activeContext: ActiveContext;
  company?: {
    id: string;
    revision: number;
    disabledCapabilities?: string[];
    enabledCapabilities?: string[];
  };
  agent?: {
    id: string;
    revision: number;
    tools: string[];
    disabledCapabilities?: string[];
  };
  skill?: {
    id: string;
    requiredCapabilities?: string[];
    forbiddenCapabilities?: string[];
  };
  activeConnections?: string[];
  platformPolicy?: {
    disabledCapabilities?: string[];
  };
  planTier?: "free" | "pro" | "enterprise";
}

function computeCacheKey(ctx: ResolutionContext): string {
  const ws = ctx.auth.workspaceId;
  const user = ctx.auth.userId;
  const cType = ctx.activeContext.contextType;
  const cId = ctx.activeContext.companyId ?? "none";
  const bId = ctx.activeContext.businessId ?? "none";
  const compRev = ctx.company ? `${ctx.company.id}:${ctx.company.revision}` : "none";
  const compDis = ctx.company?.disabledCapabilities ? [...ctx.company.disabledCapabilities].sort().join(",") : "";
  const compEna = ctx.company?.enabledCapabilities ? [...ctx.company.enabledCapabilities].sort().join(",") : "";
  const agRev = ctx.agent ? `${ctx.agent.id}:${ctx.agent.revision}` : "none";
  const agTools = ctx.agent ? [...ctx.agent.tools].sort().join(",") : "";
  const agDis = ctx.agent?.disabledCapabilities ? [...ctx.agent.disabledCapabilities].sort().join(",") : "";
  const perms = [...ctx.auth.permissions].sort().join(",");
  const conns = ctx.activeConnections ? [...ctx.activeConnections].sort().join(",") : "all";
  const plat = ctx.platformPolicy?.disabledCapabilities ? [...ctx.platformPolicy.disabledCapabilities].sort().join(",") : "";
  const tier = ctx.planTier ?? "free";
  const skill = ctx.skill ? `${ctx.skill.id}:${(ctx.skill.forbiddenCapabilities ?? []).sort().join(",")}` : "none";

  return `ws:${ws}:u:${user}:ctx:${cType}:${cId}:${bId}:cRev:${compRev}:${compDis}:${compEna}:aRev:${agRev}:${agTools}:${agDis}:p:${perms}:c:${conns}:plat:${plat}:tier:${tier}:s:${skill}`;
}

export class EffectiveCapabilityResolver {
  private readonly cache = new Map<string, EffectiveCapabilityResolution>();
  private readonly maxCacheEntries = 1000;

  constructor(private readonly registry: CapabilityRegistry = defaultCapabilityRegistry) {}

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  resolve(ctx: ResolutionContext): EffectiveCapabilityResolution {
    const key = computeCacheKey(ctx);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const details: Record<string, CapabilityResolutionDetail> = {};
    const allowedCapabilities: CapabilityDefinition[] = [];
    const allCapabilities = this.registry.list();

    const platformDisabled = new Set(ctx.platformPolicy?.disabledCapabilities ?? []);
    const companyDisabled = new Set(ctx.company?.disabledCapabilities ?? []);
    const companyEnabled = new Set(ctx.company?.enabledCapabilities ?? []);
    const agentDisabled = new Set(ctx.agent?.disabledCapabilities ?? []);
    const skillForbidden = new Set(ctx.skill?.forbiddenCapabilities ?? []);
    const userPermissions = new Set(ctx.auth.permissions);
    const activeConns = ctx.activeConnections ? new Set(ctx.activeConnections) : null;

    // Normalizing agent tools for matching (e.g. "web.search", "files", "mcp")
    const agentToolPatterns = ctx.agent?.tools.map((t) => t.trim().toLowerCase()) ?? [];

    for (const cap of allCapabilities) {
      const id = cap.id;

      // 1. Safety rule: Only tools can be agentCallable
      if (!cap.agentCallable) {
        details[id] = {
          capabilityId: id,
          status: "unavailable",
          reasonCode: "not_agent_callable",
          message: `Capability "${id}" is runtime or system infrastructure and not agent callable.`,
        };
        continue;
      }

      // 2. Precedence Level 1: Platform Policy (Explicit Deny Wins)
      if (platformDisabled.has(id)) {
        details[id] = {
          capabilityId: id,
          status: "denied",
          reasonCode: "platform_policy",
          message: `Capability "${id}" is disabled by platform security policy.`,
        };
        continue;
      }

      // 3. Precedence Level 2: Plan / Tier limits
      if (cap.risk === "critical" && ctx.planTier === "free") {
        details[id] = {
          capabilityId: id,
          status: "denied",
          reasonCode: "plan_tier",
          message: `Capability "${id}" requires Pro or Enterprise tier subscription.`,
        };
        continue;
      }

      // 4. Precedence Level 3: Tenant Permissions
      const isManagerOrOwner =
        userPermissions.has("owner") ||
        userPermissions.has("*") ||
        userPermissions.has("business:manage") ||
        userPermissions.has("workspace:write");

      const missingPerm = cap.requiredPermissions.find(
        (perm) => !userPermissions.has(perm) && !isManagerOrOwner
      );
      if (missingPerm) {
        details[id] = {
          capabilityId: id,
          status: "denied",
          reasonCode: "tenant_permissions",
          message: `Tenant lacks required permission "${missingPerm}" for capability "${id}".`,
        };
        continue;
      }

      // 5. Precedence Level 4: Active Context Boundary
      if (ctx.activeContext.contextType === "none") {
        // Neutral context cannot invoke company-specific tools or storage
        if (cap.domain === "storage" || id.startsWith("company.") || id.startsWith("files.")) {
          details[id] = {
            capabilityId: id,
            status: "denied",
            reasonCode: "context_boundary",
            message: `Capability "${id}" is denied in neutral context to prevent data leakage.`,
          };
          continue;
        }
      } else if (ctx.activeContext.contextType === "business") {
        if (id.startsWith("company.")) {
          details[id] = {
            capabilityId: id,
            status: "denied",
            reasonCode: "context_boundary",
            message: `Capability "${id}" is company-specific and cannot be called from business context.`,
          };
          continue;
        }
      }

      // 6. Precedence Level 5: Company Overrides (Explicit Deny Wins)
      if (companyDisabled.has(id)) {
        details[id] = {
          capabilityId: id,
          status: "denied",
          reasonCode: "company_override",
          message: `Capability "${id}" is explicitly disabled for this company.`,
        };
        continue;
      }

      // 7. Precedence Level 6: Agent Allowlist / Overrides
      if (agentDisabled.has(id)) {
        details[id] = {
          capabilityId: id,
          status: "denied",
          reasonCode: "agent_allowlist",
          message: `Capability "${id}" is explicitly disabled for agent "${ctx.agent?.id}".`,
        };
        continue;
      }

      if (ctx.agent) {
        const matchesAgent = agentToolPatterns.some((pattern) => {
          const normPat = pattern.trim().toLowerCase();
          const capId = id.toLowerCase();
          if (normPat === "*" || normPat === capId) return true;
          if (normPat.endsWith(".*") && capId.startsWith(normPat.slice(0, -1))) return true;
          if (normPat === cap.domain || capId.startsWith(`${normPat}.`)) return true;

          const cleanPat = normPat.replace(/[^a-z0-9]/gi, "");
          const cleanId = capId.replace(/[^a-z0-9]/gi, "");
          const cleanName = cap.name.toLowerCase().replace(/[^a-z0-9]/gi, "");
          if (cleanPat === cleanId || cleanPat === cleanName) return true;

          const idSeg = capId.split(".").at(-1)?.replace(/[^a-z0-9]/gi, "");
          if (idSeg && (cleanPat === idSeg || cleanPat === `web${idSeg}`)) return true;
          return false;
        });

        // Company enabled can grant if agent does not restrict, but if agent has an allowlist, agent rules apply
        const companyGranted = companyEnabled.has(id);
        if (!matchesAgent && !companyGranted) {
          details[id] = {
            capabilityId: id,
            status: "denied",
            reasonCode: "agent_allowlist",
            message: `Capability "${id}" is not in the agent's tool allowlist.`,
          };
          continue;
        }
      }

      // 8. Precedence Level 7: Skill Directives
      if (skillForbidden.has(id)) {
        details[id] = {
          capabilityId: id,
          status: "denied",
          reasonCode: "skill_policy",
          message: `Capability "${id}" is forbidden by active skill "${ctx.skill?.id}".`,
        };
        continue;
      }

      // 9. Precedence Level 8: Active Connections / Environment Health
      if (activeConns !== null && cap.requiredConnections.length > 0) {
        const missingConn = cap.requiredConnections.find((c) => !activeConns.has(c));
        if (missingConn) {
          details[id] = {
            capabilityId: id,
            status: "unavailable",
            reasonCode: "missing_connection",
            message: `Capability "${id}" requires connection "${missingConn}" which is not configured or active.`,
          };
          continue;
        }
      }

      // Specific connection requirements by domain
      if (cap.id.includes("crawl") && activeConns !== null && !activeConns.has("crawler")) {
        details[id] = {
          capabilityId: id,
          status: "unavailable",
          reasonCode: "missing_connection",
          message: `Crawler capability requires active "crawler" connection.`,
        };
        continue;
      }

      // If all checks pass: ALLOWED
      details[id] = {
        capabilityId: id,
        status: "allowed",
        reasonCode: ctx.agent ? "agent_allowlist" : "platform_default",
        message: `Capability "${id}" is permitted.`,
      };
      allowedCapabilities.push(cap);
    }

    const resolution: EffectiveCapabilityResolution = {
      allowedIds: allowedCapabilities.map((c) => c.id),
      allowedCapabilities,
      details,
      cacheKey: key,
      evaluatedAt: new Date().toISOString(),
    };

    if (this.cache.size >= this.maxCacheEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, resolution);

    return resolution;
  }

  findCapability(idOrAlias: string): CapabilityDefinition | undefined {
    const direct = this.registry.get(idOrAlias);
    if (direct) return direct;

    const norm = idOrAlias.trim().toLowerCase();
    if (norm === "files") {
      const fileTool = this.registry.list({ type: "tool", domain: "files" })[0];
      if (fileTool) return fileTool;
    }
    if (norm === "mcp") {
      const mcpTool = this.registry.list({ type: "tool" }).find((c) => c.id.includes("mcp"));
      if (mcpTool) return mcpTool;
    }

    const clean = norm.replace(/[^a-z0-9]/gi, "");

    return this.registry.list().find((cap) => {
      const capId = cap.id.toLowerCase();
      if (capId === norm) return true;
      if (capId.startsWith(`${norm}.`) || capId.endsWith(`.${norm}`) || capId.endsWith(`_${norm}`)) return true;
      const cleanCapId = capId.replace(/[^a-z0-9]/gi, "");
      const cleanName = cap.name.toLowerCase().replace(/[^a-z0-9]/gi, "");
      if (cleanCapId === clean || cleanName === clean) return true;
      const idSeg = capId.split(".").at(-1)?.replace(/[^a-z0-9]/gi, "");
      if (idSeg && (clean === idSeg || clean === `web${idSeg}`)) return true;
      return false;
    });
  }

  canExecute(
    ctx: ResolutionContext,
    capabilityId: string
  ): { allowed: boolean; reason: string; detail?: CapabilityResolutionDetail } {
    const cap = this.findCapability(capabilityId);
    if (!cap) {
      return {
        allowed: false,
        reason: `Capability "${capabilityId}" does not exist in registry.`,
      };
    }
    const resolution = this.resolve(ctx);
    const detail = resolution.details[cap.id];
    if (!detail) {
      return {
        allowed: false,
        reason: `Capability "${capabilityId}" could not be evaluated.`,
      };
    }
    return {
      allowed: detail.status === "allowed",
      reason: detail.message,
      detail,
    };
  }
}

export const defaultEffectiveCapabilityResolver = new EffectiveCapabilityResolver();
