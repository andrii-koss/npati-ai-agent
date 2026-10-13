import type { AuthContext } from "@npati/workspace";
import {
  RoutingStrategiesManager,
  type RoutingStrategyName,
} from "./routing-strategies";
import { LkgpStrategyManager } from "./lkgp-router";
import {
  A2ASmartRouter,
  A2AHealthRegistry,
  OmniConductor,
} from "./a2a-smart-conductor";
import {
  A2AQuotaManager,
  A2AProviderDiscovery,
  A2ACostAnalyzer,
} from "./a2a-protocol-extensions";
import { MultiAgentMessageBus } from "./multi-agent-message-bus";
import {
  ContextLifecycleManager,
  NestedSubagentManager,
} from "./context-and-subagent-lifecycle";
import { SwarmOrchestrator } from "./swarm-audio-translation-video";

export const globalRoutingManager = new RoutingStrategiesManager();
export const globalLkgpManager = new LkgpStrategyManager();
export const globalSmartRouter = new A2ASmartRouter();
export const globalHealthRegistry = new A2AHealthRegistry();
export const globalOmniConductor = new OmniConductor(globalSmartRouter, globalHealthRegistry);
export const globalQuotaManager = new A2AQuotaManager();
export const globalProviderDiscovery = new A2AProviderDiscovery();
export const globalCostAnalyzer = new A2ACostAnalyzer();
export const globalMessageBus = new MultiAgentMessageBus();
export const globalContextManager = new ContextLifecycleManager();
export const globalSubagentManager = new NestedSubagentManager();
export const globalSwarmOrchestrator = new SwarmOrchestrator();

export const SUPPORTED_STRATEGIES: RoutingStrategyName[] = [
  "cost-optimized",
  "context-optimized",
  "cache-optimized",
  "priority",
  "fill-first",
  "weighted",
  "round-robin",
  "p2c",
  "least-used",
  "random",
  "strict-random",
  "headroom",
  "reset-window",
  "reset-aware",
  "context-relay",
  "lkgp",
];

export function hasPermission(scope: AuthContext, permission: string): boolean {
  if (
    scope.permissions.includes("*") ||
    scope.permissions.includes("admin:all") ||
    scope.permissions.includes("owner")
  ) {
    return true;
  }
  if (scope.permissions.includes(permission)) return true;
  if (permission === "workspace:read") {
    return (
      scope.permissions.includes("workspace:read") ||
      scope.permissions.includes("workspace:write") ||
      scope.permissions.includes("business:manage")
    );
  }
  return false;
}
