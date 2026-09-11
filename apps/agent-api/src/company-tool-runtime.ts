import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuthContext, Company } from "@npati/workspace";
import type { DefaultWebResearchProvider } from "@npati/web-research";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpScopeGuard } from "./mcp-scopes";
import type { IsolatedExecSandbox } from "./wasm-exec-sandbox";
import { CodeModePolicyController } from "./memory-import-codemode-clawhub";

export interface CompanyToolExecutor {
  execute(context: AuthContext, company: Company, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export interface CompanyMemoryToolRepository {
  memories(context:AuthContext,companyId:string):Promise<unknown[]>;
  getMemory(context:AuthContext,companyId:string,id:string):Promise<unknown>;
  searchMemories(context:AuthContext,companyId:string,query:string,limit?:number):Promise<unknown[]>;
  addMemory(context:AuthContext,companyId:string,content:string,source?:string):Promise<unknown>;
  updateMemory(context:AuthContext,companyId:string,id:string,content:string):Promise<unknown>;
  deleteMemory(context:AuthContext,companyId:string,id:string):Promise<boolean>;
}

export const SAFE_MCP_TOOLS = new Set([
  "omniroute_tool_search", "omniroute_get_health", "omniroute_list_models_catalog",
  "omniroute_agent_skills_list", "omniroute_agent_skills_get", "omniroute_agent_skills_coverage",
]);

export function authorizeCompanyMcp(context:AuthContext,name:string){
  if(!SAFE_MCP_TOOLS.has(name))throw Object.assign(new Error(`MCP tool "${name}" is not permitted for Company Agents`),{status:403,code:"MCP_TOOL_DENIED"});
  const grantedScopes=context.apiKeyId
    ? context.permissions.filter(permission=>permission==="*"||permission==="all"||permission.startsWith("mcp:"))
    : ["mcp:read"];
  const decision=McpScopeGuard.authorize({toolName:name,action:"read",grantedScopes});
  if(!decision.granted)throw Object.assign(new Error(decision.reason??"MCP scope denied"),{status:403,code:"MCP_SCOPE_DENIED",requiredScope:decision.requiredScope});
  return decision;
}

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
    private readonly memoryRepository?: CompanyMemoryToolRepository,
    private readonly execSandbox?: IsolatedExecSandbox,
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
    if (tool === "audio.speech") {
      const speechText = text(input.text ?? input.input, "Speech text", 4_096);
      return this.ai.executeTool(tool, { ...input, text: speechText });
    }
    if (tool === "mcp") {
      if (!this.ai.mcpCall) throw new Error("OmniRoute MCP runtime is unavailable");
      const name = text(input.name ?? input.toolName, "MCP tool name", 200);
      authorizeCompanyMcp(context,name);
      return this.ai.mcpCall({ name, arguments: record(input.arguments ?? input.input), signal, timeoutMs: 30_000 });
    }
    if (tool === "files") return this.files(context, company, input);
    if (tool === "storage.company_memory") return this.companyMemory(context,company,input);
    if (tool === "exec") {
      if (!this.execSandbox) throw new Error("Isolated Exec runtime is not configured");
      if (company.workspaceId !== context.workspaceId || company.userId !== context.userId) throw new Error("Exec tenant access denied");
      const canManage = context.permissions.includes("business:manage") || context.permissions.includes("owner") || context.permissions.includes("*");
      if (!canManage) throw new Error("Exec requires business:manage permission");
      const language = typeof input.language === "string" ? input.language : "javascript";
      if (typeof input.code !== "string" || !input.code.trim()) throw new Error("Exec code is required");
      const code = input.code.trim();
      const codeMode = new CodeModePolicyController();
      codeMode.enable();
      const validation = codeMode.validateExecution(code, language);
      if (!validation.allowed) throw new Error(`Code Mode blocked execution: ${validation.lintWarnings.join("; ")}`);
      const result = await this.execSandbox.execute({
        language,
        code,
        timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
      }, signal);
      return { ...result, codeMode: true, validationWarnings: validation.lintWarnings };
    }
    throw new Error(`Tool "${tool}" has no runtime adapter`);
  }

  private async companyMemory(context:AuthContext,company:Company,input:Record<string,unknown>){
    if(!this.memoryRepository)throw new Error("Company Memory runtime is not configured");
    if(company.workspaceId!==context.workspaceId||company.userId!==context.userId)throw new Error("Company Memory tenant access denied");
    const operation=typeof input.operation==="string"?input.operation.trim().toLowerCase():"search";
    if(operation==="list")return this.memoryRepository.memories(context,company.id);
    if(operation==="search")return this.memoryRepository.searchMemories(context,company.id,text(input.query,"Memory query",2_000),Math.max(1,Math.min(Number(input.limit)||20,100)));
    if(operation==="get")return this.memoryRepository.getMemory(context,company.id,text(input.id??input.memoryId,"Memory id",200));
    const canWrite=context.permissions.includes("business:manage")||context.permissions.includes("workspace:write")||context.permissions.includes("owner")||context.permissions.includes("*");
    if(!canWrite)throw new Error("Company Memory write permission is required");
    if(operation==="create")return this.memoryRepository.addMemory(context,company.id,text(input.content,"Memory content",8_000),typeof input.source==="string"?input.source.trim().slice(0,100):"agent");
    if(operation==="update")return this.memoryRepository.updateMemory(context,company.id,text(input.id??input.memoryId,"Memory id",200),text(input.content,"Memory content",8_000));
    if(operation==="delete"){const id=text(input.id??input.memoryId,"Memory id",200);if(!await this.memoryRepository.deleteMemory(context,company.id,id))throw new Error("Company memory not found");return {id,deleted:true};}
    throw new Error("Company Memory operation must be list, search, get, create, update or delete");
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
