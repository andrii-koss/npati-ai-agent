import type { AuthContext, WorkspaceStore } from "@npati/workspace";

export interface CodePreferences {
  activeAgentId: string;
  activeAgentName: string;
  activeModelId?: string | null;
  enabledAgentIds: string[];
}

const SETTINGS_KEY = "code.preferences";
const MAX_CONCURRENT_UPDATE_RETRIES = 64;

export const DEFAULT_CODE_PREFERENCES: CodePreferences = Object.freeze({
  activeAgentId: "npati",
  activeAgentName: "Npati Code",
  activeModelId: null,
  enabledAgentIds: ["npati"],
});

function normalizeCodePreferences(value: unknown): CodePreferences {
  const parsed = value && typeof value === "object" ? (value as Partial<CodePreferences>) : {};
  const enabled = Array.isArray(parsed.enabledAgentIds)
    ? parsed.enabledAgentIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : ["npati"];
  const uniqueEnabled = [...new Set(enabled)];

  let activeAgentId = typeof parsed.activeAgentId === "string" && parsed.activeAgentId.trim()
    ? parsed.activeAgentId.trim()
    : (uniqueEnabled[0] ?? "");
  if (activeAgentId && !uniqueEnabled.includes(activeAgentId)) {
    activeAgentId = uniqueEnabled[0] ?? "";
  }

  const activeAgentName = typeof parsed.activeAgentName === "string" && parsed.activeAgentName.trim()
    ? parsed.activeAgentName.trim()
    : (activeAgentId === "npati" ? "Npati Code" : activeAgentId);
  const activeModelId = typeof parsed.activeModelId === "string" && parsed.activeModelId.trim()
    ? parsed.activeModelId.trim()
    : null;

  return {
    activeAgentId,
    activeAgentName,
    activeModelId,
    enabledAgentIds: uniqueEnabled,
  };
}

export class CodePreferencesStore {
  private readonly updateQueues = new Map<string, Promise<void>>();

  constructor(private readonly workspace: WorkspaceStore) {}

  async get(scope: AuthContext): Promise<CodePreferences> {
    const stored = await this.workspace.getUserSetting(scope, SETTINGS_KEY);
    return stored ? normalizeCodePreferences(stored.value) : { ...DEFAULT_CODE_PREFERENCES };
  }

  private update(scope: AuthContext, operation: (current: CodePreferences) => CodePreferences | Promise<CodePreferences>) {
    const queueKey = `${scope.workspaceId}:${scope.userId}`;
    const previous = this.updateQueues.get(queueKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.updateWithRetry(scope, operation));
    const tail = current.then(() => undefined, () => undefined);
    this.updateQueues.set(queueKey, tail);
    return current.finally(() => {
      if (this.updateQueues.get(queueKey) === tail) this.updateQueues.delete(queueKey);
    });
  }

  private async updateWithRetry(scope: AuthContext, operation: (current: CodePreferences) => CodePreferences | Promise<CodePreferences>) {
    for (let attempt = 0; attempt < MAX_CONCURRENT_UPDATE_RETRIES; attempt += 1) {
      const stored = await this.workspace.getUserSetting(scope, SETTINGS_KEY);
      const current = stored ? normalizeCodePreferences(stored.value) : { ...DEFAULT_CODE_PREFERENCES };
      const next = normalizeCodePreferences(await operation(current));
      if (stored && JSON.stringify(next) === JSON.stringify(current)) return current;
      const written = await this.workspace.setUserSetting(scope, SETTINGS_KEY, next, stored?.revision ?? 0);
      if (written) {
        return normalizeCodePreferences(written.value);
      }
      if (attempt + 1 < MAX_CONCURRENT_UPDATE_RETRIES) {
        const backoffMs = Math.min(2 ** attempt, 32) + Math.floor(Math.random() * 5);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    throw new Error("Code preferences changed concurrently; retry the request");
  }

  set(scope: AuthContext, patch: Partial<CodePreferences>) {
    return this.update(scope, (current) => {
      const activeAgentId = patch.activeAgentId ?? current.activeAgentId;
      const activeAgentName = patch.activeAgentName ?? (activeAgentId === current.activeAgentId ? current.activeAgentName : activeAgentId);
      const activeModelId = patch.activeModelId !== undefined ? patch.activeModelId : current.activeModelId;
      const enabledAgentIds = patch.enabledAgentIds ?? current.enabledAgentIds;
      return {
        activeAgentId,
        activeAgentName,
        activeModelId,
        enabledAgentIds,
      };
    });
  }

  setActiveAgent(scope: AuthContext, agentId: string, agentName?: string, modelId?: string | null) {
    return this.update(scope, (current) => {
      const enabledAgentIds = current.enabledAgentIds.includes(agentId)
        ? current.enabledAgentIds
        : [...current.enabledAgentIds, agentId];
      return {
        ...current,
        activeAgentId: agentId,
        activeAgentName: agentName ?? (agentId === "npati" ? "Npati Code" : agentId),
        activeModelId: modelId ?? null,
        enabledAgentIds,
      };
    });
  }

  toggleAgent(scope: AuthContext, agentId: string, enabled: boolean) {
    return this.update(scope, (current) => {
      let enabledAgentIds = [...current.enabledAgentIds];
      if (enabled) {
        if (!enabledAgentIds.includes(agentId)) enabledAgentIds.push(agentId);
      } else {
        enabledAgentIds = enabledAgentIds.filter((id) => id !== agentId);
      }
      let activeAgentId = current.activeAgentId;
      let activeAgentName = current.activeAgentName;
      if (!enabled && activeAgentId === agentId) {
        const fallbackId = enabledAgentIds[0] ?? "";
        activeAgentId = fallbackId;
        activeAgentName = fallbackId === "npati" ? "Npati Code" : fallbackId;
      }
      if (enabled && !activeAgentId) {
        activeAgentId = agentId;
        activeAgentName = agentId === "npati" ? "Npati Code" : agentId;
      }
      return {
        ...current,
        activeAgentId,
        activeAgentName,
        enabledAgentIds,
      };
    });
  }
}
