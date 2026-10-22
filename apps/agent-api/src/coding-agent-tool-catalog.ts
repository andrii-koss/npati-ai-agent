import type {
  ChatToolDefinition,
} from "@npati/omniroute-adapter";
import type { CodeSession } from "@npati/workspace";
import type { CodeAgentLimits } from "./code-agent-config";
import {
  resolveCodeSubagentLimits,
  type CodeRunCapabilityScope,
  type ResolvedCodeSubagentLimits,
} from "./code-subagent-limits";
import { isPlanSafeTool } from "./code-policy-engine";
import { resolveToolVisibility, type CodeModelProfile } from "./code-model-profiles";
import { selectVisibleTools, type CodeToolVisibilityDecision } from "./code-tool-visibility";
import { CODE_TOOL_SCHEMAS, resolveManifestForSession, schemasForToolManifest } from "./code-tool-registry";
import {
  isReadOnlyRunTool,
  REVIEW_SAFE_RUN_GIT_TOOLS,
  type CodeRunToolDescriptor,
  type CodeRunRuntimeToolDescriptor,
  type CodeRunToolSchemaLike,
  type CodingAgentRunnerPorts,
  type CodingAgentRunInput,
} from "./coding-agent-runner-contracts";

export interface ToolCatalogOptions {
  readOnlyIntent?: boolean;
  capabilityScope?: CodeRunCapabilityScope;
  runtimeTools?: readonly CodeRunRuntimeToolDescriptor[];
  asyncProcessesEnabled?: boolean;
  asyncSubagentsEnabled?: boolean;
  asyncAgentControlsEnabled?: boolean;
}

export class CodingAgentToolCatalog {
  constructor(
    private readonly ports: CodingAgentRunnerPorts,
    private readonly limits: CodeAgentLimits,
  ) {}

  get subagentLimits(): ResolvedCodeSubagentLimits {
    return resolveCodeSubagentLimits(this.limits);
  }

  publishedTools(): CodeRunToolDescriptor[] {
    return this.ports.toolRuntime.listTools().filter((tool) => tool.status === "active" && tool.available !== false);
  }

  toolDescriptors(
    session: CodeSession,
    options: ToolCatalogOptions = {},
  ): CodeRunToolDescriptor[] {
    const scope = options.capabilityScope;
    const mayDelegate = scope ? scope.mayDelegate : this.subagentLimits.delegationAllowed;
    const pinned = session.toolManifestVersion == null ? null : resolveManifestForSession(session.toolManifestVersion);
    const staticTools = this.publishedTools().filter(tool => !pinned
      || pinned.tools.some(candidate => candidate.name === tool.name && candidate.version === tool.version));
    const staticNames = new Set(staticTools.map((tool) => tool.name.toLowerCase()));

    const runtimeTools = [...(options.runtimeTools ?? [])]
      .filter((tool) => !staticNames.has(tool.name.toLowerCase()))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map<CodeRunToolDescriptor>((tool) => ({
        name: tool.name,
        version: tool.version,
        status: tool.status,
        description: tool.description,
        write: tool.write,
      }));
    let available = [...staticTools, ...runtimeTools];
    if (!options.asyncProcessesEnabled) {
      available = available.filter((tool) => !["code.shell.exec_async", "code.shell.process.wait"].includes(tool.name));
    }
    if (!options.asyncSubagentsEnabled) {
      available = available.filter((tool) => tool.name !== "code.agent.spawn_async");
    }
    if (!options.asyncAgentControlsEnabled) {
      available = available.filter((tool) => !["code.agent.continue", "code.agent.send_message", "code.agent.interrupt"].includes(tool.name));
    }

    if (!mayDelegate) available = available.filter((tool) => !tool.name.startsWith("code.agent."));
    if (scope?.tools) {
      const allowed = new Set(scope.tools.map((tool) => tool.toLowerCase()));
      available = available.filter((tool) => allowed.has(tool.name.toLowerCase()));
    }
    if (options.readOnlyIntent === true) {
      return available.filter((tool) => isReadOnlyRunTool(tool.name) || isPlanSafeTool(tool.name) || REVIEW_SAFE_RUN_GIT_TOOLS.has(tool.name));
    }
    if (session.mode === "plan") {
      return available.filter((tool) => isReadOnlyRunTool(tool.name) || isPlanSafeTool(tool.name));
    }
    return available;
  }

  private get schemas(): readonly CodeRunToolSchemaLike[] {
    return this.ports.schemas ?? CODE_TOOL_SCHEMAS;
  }

  chatToolDefinitions(
    tools: readonly CodeRunToolDescriptor[],
    runtimeTools: readonly CodeRunRuntimeToolDescriptor[] = [],
    session?: CodeSession,
  ): ChatToolDefinition[] {
    const byName = this.toolSchemaByName(runtimeTools, session);
    const definitions: ChatToolDefinition[] = [];
    for (const tool of tools) {
      const schema = byName.get(tool.name);
      if (!schema) continue;
      definitions.push({
        type: "function",
        function: { name: schema.name, description: schema.description, parameters: schema.inputSchema },
      });
    }
    return definitions;
  }

  toolSchemaByName(
    runtimeTools: readonly CodeRunRuntimeToolDescriptor[] = [],
    session?: CodeSession,
  ): Map<string, CodeRunToolSchemaLike> {
    const schemas = session?.toolManifestVersion == null ? this.schemas : schemasForToolManifest(session.toolManifestVersion);
    const byName = new Map<string, CodeRunToolSchemaLike>(schemas.map((schema) => [schema.name, schema]));
    for (const tool of runtimeTools) {
      if (byName.has(tool.name)) continue;
      byName.set(tool.name, {
        name: tool.name,
        version: tool.version,
        status: tool.status,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    return byName;
  }

  async resolveCommandPrompt(input: CodingAgentRunInput, sessionId: string): Promise<{
    text: string;
    provenance: readonly Record<string, unknown>[];
    refusals: readonly string[];
  }> {
    const port = this.ports.commandExpansion;
    if (!port) return { text: input.prompt, provenance: [], refusals: [] };
    try {
      const resolved = await port.resolvePrompt({
        ctx: input.ctx,
        companyId: input.session.companyId,
        projectId: input.session.projectId,
        sessionId,
        prompt: input.prompt,
      });
      if (!resolved) return { text: input.prompt, provenance: [], refusals: [] };
      if (typeof resolved.text !== "string" || resolved.text.length === 0) {
        return { text: input.prompt, provenance: [], refusals: ["command_expansion_empty"] };
      }
      return {
        text: resolved.text,
        provenance: resolved.provenance ?? [],
        refusals: resolved.refusals ?? [],
      };
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "command_expansion_failed";
      this.ports.logger?.warn("code_command_expansion_failed", { code, sessionId });
      return { text: input.prompt, provenance: [], refusals: [code] };
    }
  }
}

/**
 * Applies the model profile's tool tiers to the catalogue tools of one run (see `code-tool-visibility.ts`).
 * Returns the offered subset (input order kept) and the decision for a metadata-only Activity record.
 */
export async function offeredToolsForRun(input: {
  tools: readonly CodeRunToolDescriptor[];
  profile: CodeModelProfile;
  run: Pick<CodingAgentRunInput, "toolContext" | "prompt" | "readOnlyIntent" | "websiteEdit" | "requireImplementation" | "images">;
  sessionMode: string;
  dataStudioEnabled: boolean;
}): Promise<{ tools: CodeRunToolDescriptor[]; decision: CodeToolVisibilityDecision }> {
  const decision = selectVisibleTools(input.tools.map((tool) => tool.name), resolveToolVisibility(input.profile), {
    userMessage: input.run.toolContext?.userMessage ?? input.run.prompt,
    sessionMode: input.sessionMode,
    readOnlyIntent: input.run.readOnlyIntent === true,
    websiteEdit: input.run.websiteEdit === true,
    requireImplementation: input.run.requireImplementation === true,
    imageCount: input.run.images?.length ?? 0,
    dataBackendAttached: input.run.toolContext?.dataBackendAttached === true,
    dataStudioEnabled: input.dataStudioEnabled,
  });
  const visible = new Set(decision.visible);
  return { tools: input.tools.filter((tool) => visible.has(tool.name)), decision };
}
