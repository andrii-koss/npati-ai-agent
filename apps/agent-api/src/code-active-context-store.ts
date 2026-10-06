import type { AuthContext, WorkspaceStore } from "@npati/workspace";

/**
 * C7: the persisted "active code project/session" that chat continues in.
 *
 * Storage is deliberately the EXISTING per-user settings mechanism (`getUserSetting`/`setUserSetting`), the same
 * one the chat project cards already use. The step forbids inventing a second settings/context system, and a
 * new table would also mean a new retention decision for data that is really one pointer per user.
 *
 * The payload is versioned because it is persisted JSON (rule 13). A payload written by a newer version is
 * treated as absent rather than guessed at: reading an unknown shape and acting on it would point chat at a
 * workspace the user never selected.
 */
export const CODE_ACTIVE_CONTEXT_VERSION = 1;

const settingKey = (companyId: string) => `code-active-context:${companyId}`;

export interface StoredCodeActiveContext {
  schemaVersion: number;
  contextType: string;
  projectId: string | null;
  sessionId: string | null;
  updatedAt: string;
}

export interface CodeActiveContextInput {
  contextType: string;
  projectId: string | null;
  sessionId: string | null;
}

/** Reads without throwing: an unreadable or future-version payload is "no active context", never a guess. */
export async function readCodeActiveContext(
  store: WorkspaceStore,
  context: AuthContext,
  companyId: string,
): Promise<StoredCodeActiveContext | null> {
  const stored = await store.getUserSetting(context, settingKey(companyId));
  const value = stored?.value as Record<string, unknown> | undefined | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schemaVersion !== CODE_ACTIVE_CONTEXT_VERSION) return null;
  const projectId = typeof value.projectId === "string" && value.projectId ? value.projectId : null;
  const sessionId = typeof value.sessionId === "string" && value.sessionId ? value.sessionId : null;
  const contextType = typeof value.contextType === "string" && value.contextType ? value.contextType : "project";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString();
  return { schemaVersion: CODE_ACTIVE_CONTEXT_VERSION, contextType, projectId, sessionId, updatedAt };
}

/**
 * Compare-and-set write, so two tabs cannot silently overwrite each other's active context. The caller has
 * already validated the context (ownership, archived project/session) through the existing resolver.
 */
export async function writeCodeActiveContext(
  store: WorkspaceStore,
  context: AuthContext,
  companyId: string,
  input: CodeActiveContextInput,
  now: () => Date = () => new Date(),
): Promise<StoredCodeActiveContext> {
  const key = settingKey(companyId);
  const value: StoredCodeActiveContext = {
    schemaVersion: CODE_ACTIVE_CONTEXT_VERSION,
    contextType: input.contextType,
    projectId: input.projectId,
    sessionId: input.sessionId,
    updatedAt: now().toISOString(),
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await store.getUserSetting(context, key);
    if (await store.setUserSetting(context, key, value, existing?.revision ?? 0)) return value;
  }
  throw new Error("Could not persist the active code context");
}

/** Clearing is a write of an empty context, not a delete: the revision still advances, so readers see it. */
export async function clearCodeActiveContext(
  store: WorkspaceStore,
  context: AuthContext,
  companyId: string,
  now: () => Date = () => new Date(),
): Promise<StoredCodeActiveContext> {
  return writeCodeActiveContext(store, context, companyId, { contextType: "company", projectId: null, sessionId: null }, now);
}
