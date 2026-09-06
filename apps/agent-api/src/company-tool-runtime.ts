import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuthContext, Company } from "@npati/workspace";
import type { DefaultWebResearchProvider } from "@npati/web-research";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CompanyToolExecutor {
  execute(context: AuthContext, company: Company, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

const SAFE_MCP_TOOLS = new Set([
  "omniroute_tool_search", "omniroute_get_health", "omniroute_list_models_catalog",
  "omniroute_agent_skills_list", "omniroute_agent_skills_get", "omniroute_agent_skills_coverage",
]);

function text(value: unknown, field: string, max = 2_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim().slice(0, max);
}
function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class CompanyToolRuntime implements CompanyToolExecutor {
  constructor(
    private readonly ai: AIEngine,
    private readonly research?: DefaultWebResearchProvider,
    private readonly attachmentDirectory?: string,
    private readonly attachmentReader?: { authorize(context: AuthContext, fileId: string): Promise<{ originalFilename: string; mimeType: string; sizeBytes: number } | null> },
  ) {}

  async execute(context: AuthContext, company: Company, tool: string, input: Record<string, unknown>, signal: AbortSignal) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (tool === "web.search") {
      const q = typeof input.query === "string" && input.query.trim()
        ? input.query.trim()
        : typeof input.q === "string" && input.q.trim()
        ? input.q.trim()
        : typeof input.topic === "string" && input.topic.trim()
        ? input.topic.trim()
        : typeof input.term === "string" && input.term.trim()
        ? input.term.trim()
        : company.name || "general news";
      return this.ai.executeTool(tool, { ...input, query: q });
    }
    if (tool === "web.fetch") {
      try {
        return await this.ai.executeTool(tool, input);
      } catch (err) {
        if (this.research && typeof input.url === "string" && input.url.trim()) {
          return await this.research.crawl({
            url: text(input.url, "Crawler URL", 4_096),
            maxPages: 1,
            maxDepth: 0,
            deep: false,
          });
        }
        throw err;
      }
    }
    if (tool === "web.crawl") {
      if (!this.research) throw new Error("Crawler runtime is not configured");
      return this.research.crawl({
        url: text(input.url, "Crawler URL", 4_096),
        query: typeof input.query === "string" ? input.query.slice(0, 2_000) : undefined,
        maxPages: Math.max(1, Math.min(Number(input.maxPages) || 5, 10)),
        maxDepth: Math.max(0, Math.min(Number(input.maxDepth) || 1, 2)),
        deep: input.deep !== false,
        refresh: input.refresh === true,
      });
    }
    if (tool === "mcp") {
      if (!this.ai.mcpCall) throw new Error("OmniRoute MCP runtime is unavailable");
      const name = text(input.name ?? input.toolName, "MCP tool name", 200);
      if (!SAFE_MCP_TOOLS.has(name)) throw new Error(`MCP tool "${name}" is not permitted for Company Agents`);
      return this.ai.mcpCall({ name, arguments: record(input.arguments ?? input.input), signal, timeoutMs: 30_000 });
    }
    if (tool === "files") return this.files(context, company, input);
    throw new Error(`Tool "${tool}" has no runtime adapter`);
  }

  private async files(context: AuthContext, company: Company, input: Record<string, unknown>) {
    const operation = typeof input.operation === "string" ? input.operation : "list";
    const entries = company.knowledge.map((value, index) => ({ index, value, item: record(value) }));
    if (operation === "list") return entries.map(({ index, value, item }) => ({
      key: String(item.attachmentId ?? item.id ?? index),
      name: String(item.name ?? item.title ?? (typeof value === "string" ? `Knowledge ${index + 1}` : `Document ${index + 1}`)),
      type: item.attachmentId || item.id ? "attachment" : "inline",
    }));
    if (operation !== "read") throw new Error("Files operation must be list or read");
    const key = text(input.key ?? input.attachmentId, "File key", 200);
    const found = entries.find(({ index, item }) => String(item.attachmentId ?? item.id ?? index) === key);
    if (!found) throw new Error("File is not linked to this Company");
    if (typeof found.value === "string") return { key, content: found.value.slice(0, 80_000) };
    const inline = found.item.content ?? found.item.text;
    if (typeof inline === "string") return { key, name: found.item.name, content: inline.slice(0, 80_000) };
    const attachmentId = String(found.item.attachmentId ?? found.item.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw new Error("Company file content is unavailable");
    if (this.attachmentReader) {
      const file=await this.attachmentReader.authorize(context,attachmentId);
      if(!file)throw new Error("Company file content is unavailable");
      return { id:attachmentId,name:file.originalFilename,mimeType:file.mimeType,size:file.sizeBytes };
    }
    if (!this.attachmentDirectory) throw new Error("Company file content is unavailable");
    const metadata = JSON.parse(await readFile(path.join(this.attachmentDirectory, `${attachmentId}.json`), "utf8")) as Record<string, unknown>;
    if (metadata.workspaceId !== context.workspaceId || metadata.userId !== context.userId) throw new Error("File tenant access denied");
    return {
      id: attachmentId, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size,
      transcript: typeof metadata.transcript === "string" ? metadata.transcript.slice(0, 80_000) : undefined,
    };
  }
}
