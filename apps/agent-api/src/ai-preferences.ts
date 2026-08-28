import type { AIModelSummary } from "@npati/omniroute-adapter";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AIMode = "automatic" | "manual";
export type AICompressionMode = "stacked" | "off";
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

function automaticModel(preferFree: boolean, balanceQualityCost: boolean) {
  if (preferFree) return "auto/chat:free";
  return balanceQualityCost ? "auto" : "auto/smart";
}

const defaultRouting = (): AIRoutingPreferences => ({
  mode: "automatic",
  defaultModelId: null,
  automaticModel: "auto/chat:free",
  preferFree: true,
  fallbackOnFailure: true,
  balanceQualityCost: true,
  compression: "stacked",
  monthlyBudgetUsd: 20,
  warningPercent: 80,
  stopPaidWhenLimitReached: true,
});

const initialPreferences = (): AIPreferences => ({
  addedModels: [],
  routing: defaultRouting(),
});

export class AIPreferencesStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory?: string) {
    this.file = path.join(dataDirectory || path.join(process.cwd(), "data"), "ai-preferences.json");
  }

  async get(): Promise<AIPreferences> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<AIPreferences>;
      const models = Array.isArray(parsed.addedModels) ? parsed.addedModels : [];
      const mode = parsed.routing?.mode === "manual" ? "manual" : "automatic";
      const defaultModelId = typeof parsed.routing?.defaultModelId === "string" ? parsed.routing.defaultModelId : null;
      const defaults = defaultRouting();
      const preferFree = typeof parsed.routing?.preferFree === "boolean" ? parsed.routing.preferFree : defaults.preferFree;
      const balanceQualityCost = typeof parsed.routing?.balanceQualityCost === "boolean" ? parsed.routing.balanceQualityCost : defaults.balanceQualityCost;
      const monthlyBudgetUsd = Number.isFinite(parsed.routing?.monthlyBudgetUsd) ? Math.max(0, Number(parsed.routing?.monthlyBudgetUsd)) : defaults.monthlyBudgetUsd;
      const warningPercent = Number.isFinite(parsed.routing?.warningPercent) ? Math.min(100, Math.max(1, Number(parsed.routing?.warningPercent))) : defaults.warningPercent;
      return { addedModels: models, routing: {
        ...defaults,
        mode,
        defaultModelId,
        preferFree,
        balanceQualityCost,
        automaticModel: automaticModel(preferFree, balanceQualityCost),
        fallbackOnFailure: typeof parsed.routing?.fallbackOnFailure === "boolean" ? parsed.routing.fallbackOnFailure : defaults.fallbackOnFailure,
        compression: parsed.routing?.compression === "off" ? "off" : "stacked",
        monthlyBudgetUsd,
        warningPercent,
        stopPaidWhenLimitReached: typeof parsed.routing?.stopPaidWhenLimitReached === "boolean" ? parsed.routing.stopPaidWhenLimitReached : defaults.stopPaidWhenLimitReached,
      } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialPreferences();
      throw error;
    }
  }

  private update(operation: (current: AIPreferences) => AIPreferences | Promise<AIPreferences>) {
    const task = this.queue.then(async () => {
      const next = await operation(await this.get());
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
      return next;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  add(model: AIModelSummary) {
    return this.update((current) => current.addedModels.some((item) => item.id === model.id)
      ? current
      : { ...current, addedModels: [...current.addedModels, { ...model, added: true }] });
  }

  remove(modelId: string) {
    return this.update((current) => ({
      addedModels: current.addedModels.filter((model) => model.id !== modelId),
      routing: {
        ...current.routing,
        defaultModelId: current.routing.defaultModelId === modelId ? null : current.routing.defaultModelId,
        mode: current.routing.defaultModelId === modelId ? "automatic" : current.routing.mode,
      },
    }));
  }

  setDefault(modelId: string) {
    return this.update((current) => {
      if (!current.addedModels.some((model) => model.id === modelId)) throw new Error("Model must be added before it can be the default");
      return { ...current, routing: { ...current.routing, mode: "manual", defaultModelId: modelId } };
    });
  }

  setRouting(mode: AIMode, defaultModelId?: string | null, policy: Partial<Omit<AIRoutingPreferences, "mode" | "defaultModelId" | "automaticModel">> = {}) {
    return this.update((current) => {
      const selected = defaultModelId ?? current.routing.defaultModelId;
      if (mode === "manual" && (!selected || !current.addedModels.some((model) => model.id === selected))) {
        throw new Error("Manual mode requires a default model from My Models");
      }
      const preferFree = policy.preferFree ?? current.routing.preferFree;
      const balanceQualityCost = policy.balanceQualityCost ?? current.routing.balanceQualityCost;
      return { ...current, routing: {
        ...current.routing,
        ...policy,
        mode,
        defaultModelId: mode === "manual" ? selected : current.routing.defaultModelId,
        automaticModel: automaticModel(preferFree, balanceQualityCost),
        preferFree,
        balanceQualityCost,
      } };
    });
  }
}
