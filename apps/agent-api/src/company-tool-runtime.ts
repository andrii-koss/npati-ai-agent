import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuthContext, Company, WorkspaceStore } from "@npati/workspace";
import type { DefaultWebResearchProvider } from "@npati/web-research";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mergeProjectText } from "./project-task-graph";
import { ProjectFileLeaseManager, ProjectFileLockError } from "./project-file-lock";
import path from "node:path";
import { McpScopeGuard } from "./mcp-scopes";
import type { IsolatedExecSandbox } from "./wasm-exec-sandbox";
import { CodeModePolicyController } from "./memory-import-codemode-clawhub";
import type { EmailAgentTools } from "./email-agent-tools";
import { BROWSER_TOOL_IDS, type BrowserUseClient } from "./browser-tool";
import type { ProjectWorkspace } from "./project-workspace";
import type { ProjectSandboxService, TerminalSecretReference } from "./project-sandbox-service";
import type { ProjectPreviewService } from "./project-preview-service";
import type { ProjectGitService } from "./project-git-service";
import type { ProjectDeployService } from "./project-deploy-service";
import type { DeployTargetConfig } from "./deploy-provider";
import type { ProjectBrowserQaService } from "./project-browser-qa-service";
import { isDataCapabilityPermitted } from "@npati/shared";
import type { AgentDataStudioService } from "./data-studio/agent-data-service";

export interface CompanyToolExecutor {
  canAutoApproveSandboxTerminal?(context: AuthContext, company: Company, runProjectId: string, agentId: string, tool: "project.terminal.exec" | "project.terminal.process", input: Record<string, unknown>): Promise<boolean>;
  evaluateSandboxTerminal?(context: AuthContext, company: Company, runProjectId: string, agentId: string, tool: "project.terminal.exec" | "project.terminal.process", input: Record<string, unknown>): Promise<{ allowed: boolean; reason: string; sandboxId?: string }>;
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
  async canAutoApproveSandboxTerminal(context: AuthContext, company: Company, runProjectId: string, agentId: string, tool: "project.terminal.exec" | "project.terminal.process", input: Record<string, unknown>): Promise<boolean> {
    return (await this.evaluateSandboxTerminal(context, company, runProjectId, agentId, tool, input)).allowed;
  }
  async evaluateSandboxTerminal(context: AuthContext, company: Company, runProjectId: string, agentId: string, tool: "project.terminal.exec" | "project.terminal.process", input: Record<string, unknown>): Promise<{ allowed: boolean; reason: string; sandboxId?: string }> {
    if (!this.projectSandbox) return { allowed: false, reason: "sandbox_runner_unavailable" };
    return this.projectSandbox.evaluateAutoApprovalTerminal(context, company.id, runProjectId, {
      projectId: typeof input.projectId === "string" ? input.projectId : "",
      sandboxId: typeof input.sandboxId === "string" ? input.sandboxId : undefined,
      command: typeof input.command === "string" ? input.command : undefined,
      executable: typeof input.executable === "string" ? input.executable : undefined,
      args: Array.isArray(input.args) ? input.args as string[] : undefined,
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      action: input.action as "start" | "status" | "logs" | "stop" | undefined,
      environmentReferences: input.environmentReferences as Record<string, TerminalSecretReference> | undefined,
      agentId,
    }, tool);
  }
  private readonly projectReadVersions = new Map<string, string>();
  constructor(
    private readonly ai: AIEngine,
    private readonly research?: DefaultWebResearchProvider,
    private readonly attachmentDirectory?: string,
    private readonly attachmentReader?: { authorize(context: AuthContext, fileId: string): Promise<{ originalFilename: string; mimeType: string; sizeBytes: number } | null> },
    private readonly memoryRepository?: CompanyMemoryToolRepository,
    private readonly execSandbox?: IsolatedExecSandbox,
    private readonly emailAgentTools?: EmailAgentTools,
    private readonly browserTool?: BrowserUseClient,
    private readonly projectWorkspace?: ProjectWorkspace,
    private readonly projectAgentStore?: Pick<WorkspaceStore, "getCompanyAgent">,
    private readonly projectSandbox?: ProjectSandboxService,
    private readonly projectPreview?: ProjectPreviewService,
    private readonly projectGit?: ProjectGitService,
    private readonly projectFileLeaseManager?: ProjectFileLeaseManager,
    private readonly projectDeploy?: ProjectDeployService,
    private readonly projectQa?: ProjectBrowserQaService,
    private readonly projectData?: AgentDataStudioService,
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
      if (!this.ai.mcpCall) throw new Error("NPATI AI tools are unavailable");
      const name = text(input.name ?? input.toolName, "MCP tool name", 200);
      authorizeCompanyMcp(context,name);
      return this.ai.mcpCall({ name, arguments: record(input.arguments ?? input.input), signal, timeoutMs: 30_000 });
    }
    if (tool.startsWith("project.files.")) return this.projectFiles(context, company, tool, input);
    if (tool === "project.terminal.exec" || tool === "project.terminal.process") {
      if (!this.projectSandbox) throw new Error("Project sandbox runner is not configured");
      const request = {
        projectId: typeof input.projectId === "string" ? input.projectId : "",
        sandboxId: typeof input.sandboxId === "string" ? input.sandboxId : undefined,
        command: typeof input.command === "string" ? input.command : undefined,
      executable: typeof input.executable === "string" ? input.executable : undefined,
      args: Array.isArray(input.args) ? input.args as string[] : undefined,
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
        processId: typeof input.processId === "string" ? input.processId : undefined,
        action: input.action as "start" | "status" | "logs" | "stop" | undefined,
        environmentReferences: input.environmentReferences as Record<string, TerminalSecretReference> | undefined,
        approved: input.__npatiApprovalGranted === true,
        agentId: typeof input.__npatiAgentId === "string" ? input.__npatiAgentId : "",
        runId: typeof input.__npatiTaskRunId === "string" ? input.__npatiTaskRunId : undefined,
      };
      return tool === "project.terminal.exec" ? this.projectSandbox.execute(context, company.id, request) : this.projectSandbox.process(context, company.id, request);
    }
    if (tool.startsWith("project.preview.")) return this.projectPreviewTool(context, company, tool, input);
    if (tool.startsWith("project.git.")) return this.projectGitTool(context, company, tool, input);
    if (tool.startsWith("project.deploy.")) return this.projectDeployTool(context, company, tool, input);
    if (tool.startsWith("project.qa.")) return this.projectQaTool(context, company, tool, input);
    if (tool.startsWith("project.data.") || tool.startsWith("project.auth.")) return this.projectDataTool(context, company, tool, input);
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
    if (tool === "email.send" || tool === "communications.email_send") {
      if (!this.emailAgentTools) throw new Error("Email Agent Tools runtime is not configured");
      return this.emailAgentTools.sendEmail(context, company, {
        to: text(input.to, "Recipient email", 200),
        subject: text(input.subject, "Email subject", 500),
        body: text(input.body ?? input.content ?? input.message, "Email body", 50_000),
        fromEmail: typeof input.fromEmail === "string" ? input.fromEmail : undefined,
        cc: Array.isArray(input.cc) ? input.cc.map(String) : undefined,
        taskRunId: typeof input.__npatiTaskRunId === "string" ? input.__npatiTaskRunId : undefined,
      });
    }
    if (tool === "email.read" || tool === "communications.email_read") {
      if (!this.emailAgentTools) throw new Error("Email Agent Tools runtime is not configured");
      return this.emailAgentTools.readEmail(context, company, {
        query: typeof input.query === "string" ? input.query : undefined,
        sender: typeof input.sender === "string" ? input.sender : undefined,
        limit: typeof input.limit === "number" ? input.limit : 10,
      });
    }
    if (tool === "email.extract_code" || tool === "communications.email_extract_code") {
      if (!this.emailAgentTools) throw new Error("Email Agent Tools runtime is not configured");
      return this.emailAgentTools.extractVerification(text(input.text ?? input.body ?? input.content, "Email text", 100_000));
    }
    if (tool === "email.verify_link" || tool === "communications.email_verify_link") {
      if (!this.emailAgentTools) throw new Error("Email Agent Tools runtime is not configured");
      return this.emailAgentTools.inspectLinkSecurity(
        text(input.url, "URL to inspect", 2_000),
        typeof input.sender === "string" ? input.sender : undefined
      );
    }
    if (BROWSER_TOOL_IDS.has(tool)) {
      if (!this.browserTool) throw new Error("Browser Use Worker is not configured");
      return this.browserTool.execute(context, company, tool, input, signal);
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

  private async projectFiles(context: AuthContext, company: Company, tool: string, input: Record<string, unknown>) {
    if (!this.projectWorkspace || !this.projectAgentStore) throw new Error("Project file runtime is not configured");
    const agentId = typeof input.__npatiAgentId === "string" ? input.__npatiAgentId : "";
    if (!agentId) throw new Error("Project file agent authorization is required");
    const agent = await this.projectAgentStore.getCompanyAgent(context, company.id, agentId);
    if (!agent.isActive || !agent.tools.includes(tool)) throw new Error("Agent lacks Project file permission");
    const projectId = typeof input.projectId === "string" ? input.projectId : "";
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : undefined;
    const filePath = typeof input.path === "string" ? input.path : "";
    const expectedRevision = typeof input.expectedRevision === "string" ? input.expectedRevision : "";
    const content = typeof input.content === "string" ? input.content : "";
    const scope = [context, company.id, projectId] as const;
    if (this.projectFileLeaseManager && ["project.files.write", "project.files.edit", "project.files.create", "project.files.delete", "project.files.move"].includes(tool)) {
      const lock = this.projectFileLeaseManager.isLocked(projectId, filePath, agentId);
      if (lock.locked) {
        throw new ProjectFileLockError("file_locked", `File ${filePath} is locked by agent ${lock.ownerAgentId}`, 409);
      }
    }
    switch (tool) {
      case "project.files.list": return this.projectWorkspace.listFiles(...scope, workspaceId, agentId);
      case "project.files.search": return this.projectWorkspace.searchFiles(...scope, String(input.query ?? ""), workspaceId, agentId);
      case "project.files.read": {
        const file = await this.projectWorkspace.readFile(...scope, filePath, workspaceId, agentId);
        const key = JSON.stringify([context.workspaceId, company.id, projectId, agentId, input.__npatiTaskRunId, filePath, file.revision]);
        this.projectReadVersions.set(key, file.content);
        if (this.projectReadVersions.size > 500) this.projectReadVersions.delete(this.projectReadVersions.keys().next().value!);
        return file;
      }
      case "project.files.create": {
        const result = await this.projectWorkspace.createFile(...scope, filePath, content, workspaceId, agentId);
        return { path: result.path, size: result.size, revision: result.revision };
      }
      case "project.files.write": {
        let revision = expectedRevision;
        let proposed = content;
        const key = JSON.stringify([context.workspaceId, company.id, projectId, agentId, input.__npatiTaskRunId, filePath, expectedRevision]);
        const suppliedBase = typeof input.baseContent === "string" && createHash("sha256").update(input.baseContent).digest("hex") === expectedRevision ? input.baseContent : undefined;
        const base = this.projectReadVersions.get(key) ?? suppliedBase;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const result = await this.projectWorkspace.writeFile(...scope, filePath, proposed, revision, workspaceId, agentId);
            return { path: result.path, size: result.size, revision: result.revision };
          } catch (error) {
            if ((error as { code?: string }).code !== "revision_conflict") throw error;
            const current = await this.projectWorkspace.readFile(...scope, filePath, workspaceId, agentId);
            if (base === undefined) throw new Error("revision_conflict: base content unavailable; escalate to Main Agent");
            const merged = mergeProjectText(base, current.content, content);
            if (merged === undefined) throw new Error("revision_conflict: overlapping changes; escalate to Main Agent");
            proposed = merged;
            revision = current.revision;
          }
        }
        throw new Error("revision_conflict: merge retry limit reached; escalate to Main Agent");
      }
      case "project.files.edit": {
        const find = String(input.find ?? ""), replacement = String(input.replacement ?? "");
        let revision = expectedRevision;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const result = await this.projectWorkspace.editFile(...scope, filePath, find, replacement, revision, workspaceId, agentId);
            return { path: result.path, size: result.size, revision: result.revision };
          } catch (error) {
            if ((error as { code?: string }).code !== "revision_conflict") throw error;
            const current = await this.projectWorkspace.readFile(...scope, filePath, workspaceId, agentId);
            if (!find || current.content.indexOf(find) < 0 || current.content.indexOf(find) !== current.content.lastIndexOf(find))
              throw new Error("revision_conflict: edit target changed; escalate to Main Agent");
            revision = current.revision;
          }
        }
        throw new Error("revision_conflict: edit retry limit reached; escalate to Main Agent");
      }
      case "project.files.move": {
        const result = await this.projectWorkspace.moveFile(...scope, filePath, String(input.to ?? ""), expectedRevision, workspaceId, agentId);
        return { path: result.path, size: result.size, revision: result.revision };
      }
      case "project.files.delete": {
        if (input.__npatiApprovalGranted !== true) throw new Error("Project file deletion requires approval");
        const paths = Array.isArray(input.paths) ? input.paths : [filePath];
        if (!paths.length || paths.length > 100 || paths.some((item) => typeof item !== "string")) throw new Error("Invalid project file delete paths");
        for (const item of paths as string[]) await this.projectWorkspace.deleteFile(...scope, item, workspaceId, agentId);
        return { deleted: paths.length };
      }
      default: throw new Error("Unknown Project file capability");
    }
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
  private async projectPreviewTool(context: AuthContext, company: Company, tool: string, input: Record<string, unknown>) {
    if (!this.projectPreview) throw new Error("Project preview service is not configured");
    const agentId = typeof input.__npatiAgentId === "string" ? input.__npatiAgentId : "";
    if (agentId && this.projectAgentStore) {
      const agent = await this.projectAgentStore.getCompanyAgent(context, company.id, agentId);
      if (!agent.isActive || !agent.tools.includes(tool)) throw new Error(`Agent lacks permission for tool ${tool}`);
    }
    const projectId = text(input.projectId, "Project ID", 100);
    if (tool === "project.preview.start") {
      const command = typeof input.command === "string" ? input.command : undefined;
      const port = typeof input.port === "number" ? input.port : undefined;
      return this.projectPreview.startPreview(context, company.id, projectId, { command, port, agentId });
    }
    if (tool === "project.preview.stop") {
      return this.projectPreview.stopPreview(context, company.id, projectId, { agentId });
    }
    if (tool === "project.preview.status") {
      return this.projectPreview.getPreviewStatus(context, company.id, projectId);
    }
    throw new Error(`Unknown project preview tool: ${tool}`);
  }


  private async projectGitTool(context: AuthContext, company: Company, tool: string, input: Record<string, unknown>) {
    if (!this.projectGit || !this.projectAgentStore) throw new Error("Project git runtime is not configured");
    const agentId = typeof input.__npatiAgentId === "string" ? input.__npatiAgentId : "";
    if (agentId) {
      const agent = await this.projectAgentStore.getCompanyAgent(context, company.id, agentId);
      if (!agent.isActive || !agent.tools.includes(tool)) throw new Error("Agent lacks Git permission");
    }
    const projectId = typeof input.projectId === "string" ? input.projectId : "";
    switch (tool) {
      case "project.git.status":
        return this.projectGit.status(context, company.id, projectId);
      case "project.git.diff":
        return this.projectGit.diff(context, company.id, projectId, {
          file: typeof input.file === "string" ? input.file : undefined,
          staged: input.staged === true,
        });
      case "project.git.log":
        return this.projectGit.log(context, company.id, projectId, Number(input.limit) || 20);
      case "project.git.branch":
        return this.projectGit.branch(context, company.id, projectId, {
          action: (input.action as any) || "list",
          branch: typeof input.branch === "string" ? input.branch : undefined,
        });
      case "project.git.stage":
        return this.projectGit.stage(context, company.id, projectId, Array.isArray(input.files) ? (input.files as string[]) : undefined);
      case "project.git.commit":
        return this.projectGit.commit(context, company.id, projectId, {
          message: typeof input.message === "string" ? input.message : "Agent update",
          files: Array.isArray(input.files) ? (input.files as string[]) : undefined,
          stageAll: input.stageAll === true,
        });
      case "project.git.restore":
        return this.projectGit.restore(context, company.id, projectId, {
          files: Array.isArray(input.files) ? (input.files as string[]) : [],
        });
      case "project.git.checkpoint":
        return this.projectGit.createCheckpoint(context, company.id, projectId, {
          name: typeof input.name === "string" ? input.name : "Checkpoint",
          description: typeof input.description === "string" ? input.description : undefined,
          trigger: (input.trigger as any) || "manual",
        });
      case "project.git.restore_checkpoint":
        return this.projectGit.restoreCheckpoint(context, company.id, projectId, String(input.checkpointId ?? ""), {
          approved: input.__npatiApprovalGranted === true,
        });
      case "project.git.push":
        return this.projectGit.push(context, company.id, projectId, {
          credentialId: typeof input.credentialId === "string" ? input.credentialId : undefined,
          branch: typeof input.branch === "string" ? input.branch : undefined,
          approved: input.__npatiApprovalGranted === true,
        });
      case "project.git.pr":
        return this.projectGit.createPullRequest(context, company.id, projectId, {
          title: typeof input.title === "string" ? input.title : "Website Update",
          body: typeof input.body === "string" ? input.body : undefined,
          base: typeof input.base === "string" ? input.base : undefined,
          head: typeof input.head === "string" ? input.head : undefined,
          credentialId: typeof input.credentialId === "string" ? input.credentialId : undefined,
          approved: input.__npatiApprovalGranted === true,
        });
      default:
        throw new Error(`Unsupported git tool: ${tool}`);
    }
  }

  private async projectDataTool(context: AuthContext, company: Company, tool: string, input: Record<string, unknown>) {
    if (!this.projectData) throw new Error("Project Data Studio service is not configured");
    const agentId = typeof input.__npatiAgentId === "string" ? input.__npatiAgentId : "";
    if (agentId && this.projectAgentStore) {
      const agent = await this.projectAgentStore.getCompanyAgent(context, company.id, agentId);
      if (!agent.isActive || !isDataCapabilityPermitted(agent.tools, tool)) {
        throw new Error(`Agent lacks required capability group for ${tool}`);
      }
    }
    const projectId = text(input.projectId, "Project ID", 100);
    const approved = input.__npatiApprovalGranted === true || input.confirmed === true;
    const runId = typeof input.__npatiTaskRunId === "string" ? input.__npatiTaskRunId : undefined;

    switch (tool) {
      case "project.data.schema.inspect":
        return this.projectData.inspectSchema(context, company.id, projectId);
      case "project.data.schema.apply": {
        const operation = input.operation as any;
        const dryRun = input.dryRun === true;
        const expectedFingerprint = typeof input.expectedFingerprint === "string" ? input.expectedFingerprint : undefined;
        return this.projectData.applySchema(context, company.id, projectId, operation, {
          dryRunOnly: dryRun,
          expectedFingerprint,
          runId,
          agentId,
          approved,
        });
      }
      case "project.data.rows.list": {
        const collection = text(input.collection, "Collection", 100);
        return this.projectData.listRows(context, company.id, projectId, collection, input as any);
      }
      case "project.data.rows.read": {
        const collection = text(input.collection, "Collection", 100);
        const id = text(input.id, "Row ID", 100);
        return this.projectData.readRow(context, company.id, projectId, collection, id);
      }
      case "project.data.rows.create": {
        const collection = text(input.collection, "Collection", 100);
        const row = record(input.row);
        return this.projectData.createRow(context, company.id, projectId, collection, row);
      }
      case "project.data.rows.update": {
        const collection = text(input.collection, "Collection", 100);
        const id = text(input.id, "Row ID", 100);
        const row = record(input.row);
        return this.projectData.updateRow(context, company.id, projectId, collection, id, row);
      }
      case "project.data.rows.delete": {
        const collection = text(input.collection, "Collection", 100);
        const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
        if (!ids.length) throw new Error("Row IDs are required for deletion");
        return this.projectData.deleteRows(context, company.id, projectId, collection, ids, approved);
      }
      case "project.data.migrations.list":
        return this.projectData.listMigrations(context, company.id, projectId);
      case "project.data.templates.list":
        return this.projectData.listTemplates();
      case "project.data.templates.apply": {
        const templateId = text(input.templateId, "Template ID", 100);
        const dryRun = input.dryRun === true;
        return this.projectData.applyTemplate(context, company.id, projectId, templateId, {
          dryRunOnly: dryRun,
          runId,
          agentId,
          approved,
        });
      }
      case "project.auth.inspect":
        return this.projectData.inspectAuth(context, company.id, projectId);
      case "project.auth.configure": {
        const settings = typeof input.settings === "object" ? input.settings as any : undefined;
        const policies = Array.isArray(input.policies) ? input.policies as any : undefined;
        return this.projectData.configureAuth(context, company.id, projectId, { settings, policies }, { approved });
      }
      default:
        throw new Error(`Unknown project data tool: ${tool}`);
    }
  }

  private async projectDeployTool(context: AuthContext, company: Company, tool: string, input: Record<string, unknown>) {
    if (!this.projectDeploy) throw new Error("Project deploy service is not configured");
    const projectId = typeof input.projectId === "string" ? input.projectId : undefined;
    if (!projectId) throw new Error("Deploy tool requires projectId");

    switch (tool) {
      case "project.deploy.publish": {
        const approved = input.__npatiApprovalGranted === true;
        const credentialId = typeof input.credentialId === "string" ? input.credentialId : undefined;
        const target: DeployTargetConfig = {
          provider: typeof input.provider === "string" ? input.provider : "dokploy",
          environment: (input.environment as any) || "production",
          branch: typeof input.branch === "string" ? input.branch : undefined,
          applicationId: typeof input.applicationId === "string" ? input.applicationId : undefined,
          endpoint: typeof input.endpoint === "string" ? input.endpoint : undefined,
          domain: typeof input.domain === "string" ? input.domain : undefined,
        };
        return this.projectDeploy.deploy(context, company.id, projectId, {
          target,
          credentialId,
          branch: target.branch,
          approved,
          runId: typeof input.__npatiTaskRunId === "string" ? input.__npatiTaskRunId : undefined,
        });
      }
      case "project.deploy.status": {
        const deploymentId = typeof input.deploymentId === "string" ? input.deploymentId : undefined;
        if (!deploymentId) {
          const list = await this.projectDeploy.listDeployments(context, company.id, projectId, 1);
          return { deployments: list };
        }
        const deployment = await this.projectDeploy.getDeployment(context, company.id, projectId, deploymentId);
        return { deployment };
      }
      default:
        throw new Error(`Unsupported deploy tool: ${tool}`);
    }
  }

  private async projectQaTool(context: AuthContext, company: Company, tool: string, input: Record<string, unknown>) {
    if (!this.projectQa) throw new Error("Project browser QA service is not configured");
    const projectId = typeof input.projectId === "string" ? input.projectId : undefined;
    if (!projectId) throw new Error("Browser QA tool requires projectId");

    switch (tool) {
      case "project.qa.inspect": {
        const result = await this.projectQa.inspect(context, company.id, {
          projectId,
          path: typeof input.path === "string" ? input.path : undefined,
          viewport: (input.viewport as any) || "desktop",
          checks: Array.isArray(input.checks) ? (input.checks as any) : undefined,
          timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
          maxScreenshotBytes: typeof input.maxScreenshotBytes === "number" ? input.maxScreenshotBytes : undefined,
          agentId: typeof input.__npatiAgentId === "string" ? input.__npatiAgentId : undefined,
          runId: typeof input.__npatiTaskRunId === "string" ? input.__npatiTaskRunId : undefined,
        });
        return { reportId: result.report.id, status: result.report.status, summary: result.report.summary, issues: result.issues, metrics: result.metrics };
      }
      case "project.qa.report": {
        const reportId = typeof input.reportId === "string" ? input.reportId : undefined;
        if (reportId) {
          const report = await this.projectQa.getReport(context, company.id, projectId, reportId);
          return { report: report ? { id: report.id, status: report.status, summary: report.summary, issues: report.issues, metrics: report.metrics } : null };
        }
        const report = await this.projectQa.getLatestReport(context, company.id, projectId);
        return { report: report ? { id: report.id, status: report.status, summary: report.summary, issues: report.issues, metrics: report.metrics } : null };
      }
      default:
        throw new Error(`Unsupported QA tool: ${tool}`);
    }
  }

}
