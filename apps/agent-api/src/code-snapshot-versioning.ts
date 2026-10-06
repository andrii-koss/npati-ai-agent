import { createHash } from "node:crypto";

/**
 * C6b: immutable versioning for the two pieces of configuration a snapshot only references by hash.
 *
 * A snapshot records *which* system prompt and *which* model profiles were in effect; this module owns the
 * content behind those hashes. The rules are deliberately strict:
 *
 *   - identical content reuses its existing version instead of minting a new one, so the number keeps meaning
 *     "a distinct configuration" rather than "a distinct call";
 *   - a *changed* configuration always creates a new immutable version, so a historical snapshot can never be
 *     reinterpreted by a later edit (this is why the store has no update path and the table has a trigger).
 */

export interface SnapshotConfigVersionRef {
  id: string;
  version: number;
  contentHash: string;
  /** True when a new version was written; false when the identical content already had one. */
  created: boolean;
}

/** Sorted-key JSON so two structurally identical configurations hash identically. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const source = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(source[key])}`);
  }
  return `{${parts.join(",")}}`;
}

export function snapshotConfigContentHash(content: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(content)).digest("hex")}`;
}

/** The subset of the workspace store this module needs; kept narrow so a fake is trivial in tests. */
export interface SnapshotConfigVersionStore {
  createSnapshotConfigVersion(input: {
    companyId: string;
    workspaceId: string;
    kind: "system_prompt" | "model_profiles";
    content: Record<string, unknown>;
    contentHash: string;
    createdBy: string;
    now?: Date;
    id?: string;
  }): Promise<{ id: string; version: number; contentHash: string }>;
  findSnapshotConfigVersionByHash(
    companyId: string,
    kind: "system_prompt" | "model_profiles",
    contentHash: string,
  ): Promise<{ id: string; version: number; contentHash: string } | null>;
}

export interface EnsureConfigVersionInput {
  store: SnapshotConfigVersionStore;
  companyId: string;
  workspaceId: string;
  content: Record<string, unknown>;
  createdBy: string;
  now?: Date;
  id?: string;
}

async function ensure(
  kind: "system_prompt" | "model_profiles",
  input: EnsureConfigVersionInput,
): Promise<SnapshotConfigVersionRef> {
  const contentHash = snapshotConfigContentHash(input.content);
  const existing = await input.store.findSnapshotConfigVersionByHash(input.companyId, kind, contentHash);
  if (existing) {
    return { id: existing.id, version: existing.version, contentHash: existing.contentHash, created: false };
  }
  const created = await input.store.createSnapshotConfigVersion({
    companyId: input.companyId,
    workspaceId: input.workspaceId,
    kind,
    content: input.content,
    contentHash,
    createdBy: input.createdBy,
    ...(input.now ? { now: input.now } : {}),
    ...(input.id ? { id: input.id } : {}),
  });
  return { id: created.id, version: created.version, contentHash: created.contentHash, created: true };
}

/** The system prompt is addressed by content, not by "current": the caller passes the exact text it will send. */
export async function ensureSystemPromptVersion(
  input: EnsureConfigVersionInput & { promptText: string },
): Promise<SnapshotConfigVersionRef> {
  return ensure("system_prompt", {
    ...input,
    content: { ...input.content, promptText: input.promptText },
  });
}

/** Model profiles are addressed by their resolved content, so a profile edit is a new version, not a mutation. */
export async function ensureModelProfilesVersion(input: EnsureConfigVersionInput): Promise<SnapshotConfigVersionRef> {
  return ensure("model_profiles", input);
}
