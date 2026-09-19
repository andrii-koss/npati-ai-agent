import type { AIModelSummary } from '@npati/omniroute-adapter';
import type { AuthContext, WorkspaceStore } from '@npati/workspace';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type AIMode = 'automatic' | 'manual';
export type AICompressionMode = 'stacked' | 'off';
export interface AIRoutingPreferences {
  mode: AIMode;
  defaultModelId: string | null;
  automaticModel: string;
  preferFree: boolean;
  fallbackOnFailure: boolean;
  balanceQualityCost: boolean;
  compression: AICompressionMode;
  monthlyBudgetUsd: number;
  warningPercent: number;
  stopPaidWhenLimitReached: boolean;
}
export interface AIPreferences {
  addedModels: AIModelSummary[];
  routing: AIRoutingPreferences;
}

const SETTINGS_KEY = 'ai.preferences';
const MAX_CONCURRENT_UPDATE_RETRIES = 8;

function automaticModel(preferFree: boolean, balanceQualityCost: boolean) {
  if (preferFree) return 'auto/chat';
  return balanceQualityCost ? 'auto' : 'auto/smart';
}

const defaultRouting = (): AIRoutingPreferences => ({
  mode: 'automatic',
  defaultModelId: null,
  automaticModel: 'auto',
  preferFree: true,
  fallbackOnFailure: true,
  balanceQualityCost: true,
  compression: 'stacked',
  monthlyBudgetUsd: 20,
  warningPercent: 80,
  stopPaidWhenLimitReached: true,
});

const initialPreferences = (): AIPreferences => ({ addedModels: [], routing: defaultRouting() });

function normalize(value: unknown): AIPreferences {
  const parsed = value && typeof value === 'object' ? value as Partial<AIPreferences> : {};
  const models = Array.isArray(parsed.addedModels) ? parsed.addedModels : [];
  const mode = parsed.routing?.mode === 'manual' ? 'manual' : 'automatic';
  const defaultModelId = typeof parsed.routing?.defaultModelId === 'string' ? parsed.routing.defaultModelId : null;
  const defaults = defaultRouting();
  const preferFree = typeof parsed.routing?.preferFree === 'boolean' ? parsed.routing.preferFree : defaults.preferFree;
  const balanceQualityCost = typeof parsed.routing?.balanceQualityCost === 'boolean' ? parsed.routing.balanceQualityCost : defaults.balanceQualityCost;
  const monthlyBudgetUsd = Number.isFinite(parsed.routing?.monthlyBudgetUsd) ? Math.max(0, Number(parsed.routing?.monthlyBudgetUsd)) : defaults.monthlyBudgetUsd;
  const warningPercent = Number.isFinite(parsed.routing?.warningPercent) ? Math.min(100, Math.max(1, Number(parsed.routing?.warningPercent))) : defaults.warningPercent;
  return { addedModels: models, routing: {
    ...defaults,
    mode,
    defaultModelId,
    preferFree,
    balanceQualityCost,
    automaticModel: automaticModel(preferFree, balanceQualityCost),
    fallbackOnFailure: typeof parsed.routing?.fallbackOnFailure === 'boolean' ? parsed.routing.fallbackOnFailure : defaults.fallbackOnFailure,
    compression: parsed.routing?.compression === 'off' ? 'off' : 'stacked',
    monthlyBudgetUsd,
    warningPercent,
    stopPaidWhenLimitReached: typeof parsed.routing?.stopPaidWhenLimitReached === 'boolean' ? parsed.routing.stopPaidWhenLimitReached : defaults.stopPaidWhenLimitReached,
  } };
}

export class AIPreferencesStore {
  private readonly legacyFile?: string;

  constructor(private readonly workspace: WorkspaceStore, legacyDataDirectory?: string) {
    this.legacyFile = legacyDataDirectory ? path.join(legacyDataDirectory, 'ai-preferences.json') : undefined;
  }

  private async migrateLegacyLocalPreferences(scope: AuthContext) {
    if (!this.legacyFile || scope.workspaceId !== 'dev-workspace' || scope.userId !== 'dev-user') return null;
    try {
      const legacy = normalize(JSON.parse(await readFile(this.legacyFile, 'utf8')));
      return await this.workspace.setUserSetting(scope, SETTINGS_KEY, legacy, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async get(scope: AuthContext): Promise<AIPreferences> {
    const stored = await this.workspace.getUserSetting(scope, SETTINGS_KEY);
    if (stored) {
      const normalized = normalize(stored.value);
      if (normalized.addedModels.length > 0 || (scope.workspaceId === 'dev-workspace' && scope.userId === 'dev-user')) {
        return normalized;
      }
    }
    if (scope.workspaceId === 'dev-workspace' && scope.userId === 'dev-user') {
      const migrated = await this.migrateLegacyLocalPreferences(scope);
      if (migrated) return normalize(migrated.value);
    }
    return stored ? normalize(stored.value) : initialPreferences();
  }

  private async update(scope: AuthContext, operation: (current: AIPreferences) => AIPreferences | Promise<AIPreferences>) {
    for (let attempt = 0; attempt < MAX_CONCURRENT_UPDATE_RETRIES; attempt += 1) {
      let stored = await this.workspace.getUserSetting(scope, SETTINGS_KEY);
      if (!stored && scope.workspaceId === 'dev-workspace' && scope.userId === 'dev-user') {
        stored = await this.migrateLegacyLocalPreferences(scope);
      }
      const current = stored ? normalize(stored.value) : initialPreferences();
      const next = await operation(current);
      if (stored && JSON.stringify(next) === JSON.stringify(current)) return current;
      const written = await this.workspace.setUserSetting(scope, SETTINGS_KEY, next, stored?.revision ?? 0);
      if (written) {
        return normalize(written.value);
      }
    }
    throw new Error('AI preferences changed concurrently; retry the request');
  }

  add(scope: AuthContext, model: AIModelSummary) {
    return this.update(scope, (current) => current.addedModels.some((item) => item.id === model.id)
      ? current
      : {
          addedModels: [...current.addedModels, { ...model, added: true }],
          routing: {
            ...current.routing,
            defaultModelId: current.routing.defaultModelId ?? model.id,
          },
        });
  }

  remove(scope: AuthContext, modelId: string) {
    return this.update(scope, (current) => ({
      addedModels: current.addedModels.filter((model) => model.id !== modelId),
      routing: {
        ...current.routing,
        defaultModelId: current.routing.defaultModelId === modelId ? null : current.routing.defaultModelId,
        mode: current.routing.defaultModelId === modelId ? 'automatic' : current.routing.mode,
      },
    }));
  }

  removeProvider(scope: AuthContext, providerId: string) {
    return this.update(scope, (current) => {
      const removedIds = new Set(current.addedModels
        .filter((model) => model.providerId === providerId || model.id.startsWith(`${providerId}/`))
        .map((model) => model.id));
      if (removedIds.size === 0) return current;
      const defaultRemoved = current.routing.defaultModelId !== null && removedIds.has(current.routing.defaultModelId);
      return {
        addedModels: current.addedModels.filter((model) => !removedIds.has(model.id)),
        routing: {
          ...current.routing,
          defaultModelId: defaultRemoved ? null : current.routing.defaultModelId,
          mode: defaultRemoved ? 'automatic' : current.routing.mode,
        },
      };
    });
  }

  setDefault(scope: AuthContext, modelId: string) {
    return this.update(scope, (current) => {
      if (!current.addedModels.some((model) => model.id === modelId)) throw new Error('Model must be added before it can be the default');
      return { ...current, routing: { ...current.routing, mode: 'manual', defaultModelId: modelId } };
    });
  }

  setRouting(scope: AuthContext, mode: AIMode, defaultModelId?: string | null, policy: Partial<Omit<AIRoutingPreferences, 'mode' | 'defaultModelId' | 'automaticModel'>> = {}) {
    return this.update(scope, (current) => {
      const selected = defaultModelId ?? current.routing.defaultModelId ?? current.addedModels[0]?.id ?? null;
      if (mode === 'manual' && (!selected || !current.addedModels.some((model) => model.id === selected))) {
        throw new Error('Manual mode requires a default model from My Models');
      }
      const preferFree = policy.preferFree ?? current.routing.preferFree;
      const balanceQualityCost = policy.balanceQualityCost ?? current.routing.balanceQualityCost;
      return { ...current, routing: {
        ...current.routing,
        ...policy,
        mode,
        defaultModelId: mode === 'manual' ? selected : current.routing.defaultModelId,
        automaticModel: automaticModel(preferFree, balanceQualityCost),
        preferFree,
        balanceQualityCost,
      } };
    });
  }
}
