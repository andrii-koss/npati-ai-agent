export type CapabilityType =
  | "runtime"
  | "tool"
  | "orchestration"
  | "security_ops"
  | "configuration"
  | "skill";

export type CapabilityDomain =
  | "ai"
  | "research"
  | "files"
  | "browser"
  | "communications"
  | "storage"
  | "security"
  | "orchestration"
  | "system"
  | "business"
  | "code";

export type CapabilityRisk = "low" | "medium" | "high" | "critical";

export interface CapabilityDefinition {
  id: string;
  inventoryIds: number[];
  type: CapabilityType;
  domain: CapabilityDomain;
  name: string;
  description: string;
  useWhen: string[];
  doNotUseWhen: string[];
  agentCallable: boolean;
  userVisible: boolean;
  risk: CapabilityRisk;
  requiresConfirmation: boolean;
  requiredConnections: string[];
  requiredPermissions: string[];
  healthCheck?: "required" | "optional" | "none";
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  version: number;
}

export interface CapabilityFilter {
  type?: CapabilityType;
  domain?: CapabilityDomain;
  agentCallable?: boolean;
  risk?: CapabilityRisk;
  userVisible?: boolean;
}

export interface RegistryValidationResult {
  valid: boolean;
  errors: string[];
  totalCapabilities: number;
  coveredInventoryCount: number;
  missingInventoryIds: number[];
  duplicateInventoryIds: number[];
  duplicateCapabilityIds: string[];
  runtimeCallableViolations: string[];
}

export class CapabilityRegistry {
  private readonly byId = new Map<string, CapabilityDefinition>();
  private readonly byInventoryId = new Map<number, CapabilityDefinition>();

  constructor(capabilities: CapabilityDefinition[] = []) {
    for (const cap of capabilities) {
      this.register(cap);
    }
  }

  register(cap: CapabilityDefinition): void {
    this.byId.set(cap.id, cap);
    for (const invId of cap.inventoryIds) {
      this.byInventoryId.set(invId, cap);
    }
  }

  get(id: string): CapabilityDefinition | undefined {
    return this.byId.get(id);
  }

  getByInventoryId(inventoryId: number): CapabilityDefinition | undefined {
    return this.byInventoryId.get(inventoryId);
  }

  list(filter?: CapabilityFilter): CapabilityDefinition[] {
    const all = Array.from(this.byId.values());
    if (!filter) return all;

    return all.filter((cap) => {
      if (filter.type !== undefined && cap.type !== filter.type) return false;
      if (filter.domain !== undefined && cap.domain !== filter.domain) return false;
      if (filter.agentCallable !== undefined && cap.agentCallable !== filter.agentCallable) return false;
      if (filter.risk !== undefined && cap.risk !== filter.risk) return false;
      if (filter.userVisible !== undefined && cap.userVisible !== filter.userVisible) return false;
      return true;
    });
  }

  listAgentCallable(): CapabilityDefinition[] {
    return this.list({ agentCallable: true });
  }

  validate(): RegistryValidationResult {
    const errors: string[] = [];
    const idSet = new Set<string>();
    const duplicateCapabilityIds: string[] = [];
    const inventoryMap = new Map<number, string[]>();
    const runtimeCallableViolations: string[] = [];

    const allCaps = Array.from(this.byId.values());

    for (const cap of allCaps) {
      // 1. Unique Capability ID
      if (idSet.has(cap.id)) {
        duplicateCapabilityIds.push(cap.id);
        errors.push(`Duplicate capability id: "${cap.id}"`);
      }
      idSet.add(cap.id);

      // 2. Safety Gating: runtime, security_ops, configuration must NOT be agent_callable
      if (cap.agentCallable && cap.type !== "tool") {
        runtimeCallableViolations.push(cap.id);
        errors.push(`Capability "${cap.id}" of type "${cap.type}" cannot be agentCallable (only type "tool" is allowed).`);
      }

      // 3. Inventory IDs mapping
      if (!cap.inventoryIds || cap.inventoryIds.length === 0) {
        errors.push(`Capability "${cap.id}" has no inventoryIds assigned.`);
      } else {
        for (const invId of cap.inventoryIds) {
          if (!inventoryMap.has(invId)) {
            inventoryMap.set(invId, []);
          }
          inventoryMap.get(invId)!.push(cap.id);
        }
      }

      // 4. Schema hygiene
      if (!cap.name?.trim()) errors.push(`Capability "${cap.id}" is missing name.`);
      if (!cap.description?.trim()) errors.push(`Capability "${cap.id}" is missing description.`);
      if (!cap.useWhen || cap.useWhen.length === 0) errors.push(`Capability "${cap.id}" has empty useWhen.`);
      if (!cap.doNotUseWhen || cap.doNotUseWhen.length === 0) errors.push(`Capability "${cap.id}" has empty doNotUseWhen.`);
    }

    // Check duplicate inventory IDs
    const duplicateInventoryIds: number[] = [];
    for (const [invId, owners] of inventoryMap.entries()) {
      if (owners.length > 1) {
        duplicateInventoryIds.push(invId);
        errors.push(`Inventory ID ${invId} is mapped to multiple capabilities: ${owners.join(", ")}`);
      }
    }

    // Check all 1..306 covered
    const missingInventoryIds: number[] = [];
    for (let i = 1; i <= 306; i++) {
      if (!inventoryMap.has(i)) {
        missingInventoryIds.push(i);
      }
    }
    if (missingInventoryIds.length > 0) {
      errors.push(`Missing coverage for ${missingInventoryIds.length} inventory IDs: ${missingInventoryIds.slice(0, 10).join(", ")}${missingInventoryIds.length > 10 ? "..." : ""}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      totalCapabilities: allCaps.length,
      coveredInventoryCount: inventoryMap.size,
      missingInventoryIds,
      duplicateInventoryIds,
      duplicateCapabilityIds,
      runtimeCallableViolations,
    };
  }
}

import { CAPABILITY_CATALOG } from "./capability-catalog";

export const defaultCapabilityRegistry = new CapabilityRegistry(CAPABILITY_CATALOG);
