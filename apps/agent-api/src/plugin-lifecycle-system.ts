export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  permissions?: string[];
}

export interface PluginHooks {
  onInit?: (context: { companyId: string }) => Promise<void> | void;
  beforePrompt?: (prompt: string, context: Record<string, any>) => Promise<string> | string;
  afterResponse?: (response: string, context: Record<string, any>) => Promise<string> | string;
}

export interface NpatiPlugin {
  manifest: PluginManifest;
  hooks?: PluginHooks;
}

export class PluginLifecycleSystem {
  private readonly plugins = new Map<string, NpatiPlugin>();
  private readonly initializedCompanies = new Set<string>();

  /**
   * 1. Register and validate a plugin
   */
  registerPlugin(plugin: NpatiPlugin): void {
    if (!plugin.manifest?.id || !plugin.manifest?.version) {
      throw new Error("INVALID_PLUGIN_MANIFEST: Plugin must have an id and version.");
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  /**
   * 2. Initialize plugins for a company tenant
   */
  async initializePluginsForCompany(companyId: string): Promise<void> {
    const key = companyId;
    if (this.initializedCompanies.has(key)) return;

    for (const plugin of this.plugins.values()) {
      if (plugin.hooks?.onInit) {
        try {
          await plugin.hooks.onInit({ companyId });
        } catch (err: any) {
          console.error(`[PluginLifecycle] Error in plugin '${plugin.manifest.id}' onInit:`, err.message);
        }
      }
    }

    this.initializedCompanies.add(key);
  }

  /**
   * 3. Execute beforePrompt hooks pipeline
   */
  async executeBeforePrompt(prompt: string, context: Record<string, any>): Promise<string> {
    let currentPrompt = prompt;

    for (const plugin of this.plugins.values()) {
      if (plugin.hooks?.beforePrompt) {
        try {
          currentPrompt = await plugin.hooks.beforePrompt(currentPrompt, context);
        } catch (err: any) {
          console.error(`[PluginLifecycle] Error in plugin '${plugin.manifest.id}' beforePrompt:`, err.message);
        }
      }
    }

    return currentPrompt;
  }

  /**
   * 4. Execute afterResponse hooks pipeline
   */
  async executeAfterResponse(response: string, context: Record<string, any>): Promise<string> {
    let currentResponse = response;

    for (const plugin of this.plugins.values()) {
      if (plugin.hooks?.afterResponse) {
        try {
          currentResponse = await plugin.hooks.afterResponse(currentResponse, context);
        } catch (err: any) {
          console.error(`[PluginLifecycle] Error in plugin '${plugin.manifest.id}' afterResponse:`, err.message);
        }
      }
    }

    return currentResponse;
  }

  getLoadedPlugins(): PluginManifest[] {
    return Array.from(this.plugins.values()).map((p) => p.manifest);
  }
}
