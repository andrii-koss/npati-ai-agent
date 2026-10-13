/**
 * Runtime provider overlay stubs and hash utilities for capability auditing.
 */
import type { RuntimeProviderCapability, RuntimeProviderCapabilityOverlay } from "./capability-catalog-audit-types";
import { stableJson } from "./capability-catalog-audit-types";

export const NULL_RUNTIME_PROVIDER_ID = "null-runtime-provider-overlay";

/**
 * The only runtime overlay that exists today: MCP is not implemented (C13 is the step that will add it), so
 * this provider reports zero capabilities and the stable hash of an empty list. It is a safe stub, not a
 * placeholder that pretends to discover something.
 */
export class NullRuntimeProviderCapabilityOverlay implements RuntimeProviderCapabilityOverlay {
  readonly providerId = NULL_RUNTIME_PROVIDER_ID;

  list(): RuntimeProviderCapability[] {
    return [];
  }

  hash(): string {
    return hashRuntimeOverlayEntries([]);
  }
}

export const defaultRuntimeProviderCapabilityOverlay: RuntimeProviderCapabilityOverlay =
  new NullRuntimeProviderCapabilityOverlay();

/**
 * Stable hash of an overlay listing. FNV-1a in two lanes — deliberately not a security hash: this is a
 * change detector, and `@npati/shared` is bundled into the web app, so no Node builtin is imported here.
 */
export function hashRuntimeOverlayEntries(entries: readonly RuntimeProviderCapability[]): string {
  const canonical = stableJson(
    entries.map((entry) => ({
      id: entry.id,
      providerId: entry.providerId,
      name: entry.name,
      agentCallable: entry.agentCallable,
      risk: entry.risk,
      source: entry.source ?? null,
      // C13: the runtime record, folded in **only when the entry carries it**, so an entry written before
      // this field existed hashes exactly as it did and the null overlay keeps its pinned empty-list hash.
      ...(entry.connectionId === undefined ? {} : { connectionId: entry.connectionId }),
      ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
      ...(entry.schemaHash === undefined ? {} : { schemaHash: entry.schemaHash }),
      ...(entry.schemaVersion === undefined ? {} : { schemaVersion: entry.schemaVersion }),
      ...(entry.approvalRequired === undefined ? {} : { approvalRequired: entry.approvalRequired }),
      ...(entry.discoveredAt === undefined ? {} : { discoveredAt: entry.discoveredAt }),
      ...(entry.connectionScope === undefined ? {} : { connectionScope: entry.connectionScope }),
      ...(entry.riskSource === undefined ? {} : { riskSource: entry.riskSource }),
    })),
  );
  let laneA = 0x811c9dc5;
  let laneB = 0x7f4a7c15;
  for (let index = 0; index < canonical.length; index++) {
    const code = canonical.charCodeAt(index);
    laneA = Math.imul(laneA ^ code, 0x01000193) >>> 0;
    laneB = Math.imul(laneB ^ code, 0x85ebca6b) >>> 0;
  }
  const hex = (value: number): string => value.toString(16).padStart(8, "0");
  return `fnv1a64:${hex(laneA)}${hex(laneB)}`;
}

/**
 * A synthetic overlay used **only** to prove the checks below are not vacuous: it is never registered,
 * never merged into the static stores and never counted in any static number. It exists so the gate can
 * show, on every run, that its combined view really does consume the overlay (and that the static counts
 * really do ignore it).
 */
export function createRuntimeOverlayProbe(entryCount = 3): RuntimeProviderCapabilityOverlay {
  const entries: RuntimeProviderCapability[] = Array.from({ length: entryCount }, (_, index) => ({
    id: `c13.audit.probe.overlay_${index + 1}`,
    providerId: "c13-audit-probe",
    name: `C13 audit probe capability ${index + 1}`,
    agentCallable: true,
    risk: "low",
    source: "c13-audit-probe",
  }));
  const hashed = hashRuntimeOverlayEntries(entries);
  return {
    providerId: "c13-audit-probe",
    list: () => entries.map((entry) => ({ ...entry })),
    hash: () => hashed,
  };
}
