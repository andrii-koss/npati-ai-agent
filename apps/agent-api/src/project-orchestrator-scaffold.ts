import type { AuthContext, CompanyAgent, CompanyAgentRunDetails, Project, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import type { ProjectWorkspace } from "./project-workspace";
import type { DataBackendService } from "./data-studio/service";
import type { ProjectRedirectRepository } from "./data-studio/redirect-repository";
import {
  WEBSITE_FILE_TOOLS,
  PROJECT_PREVIEW_TOOLS,
  canBuildWebsite,
  canBuildMobileApp,
} from "./project-agent-capabilities";
import {
  createDefaultWebsiteDocument,
  getWebsiteAdapter,
  createMobileAppScaffold,
  defaultAppScheme,
  slugifyProjectName,
  isDataCapabilityPermitted,
  DATA_CAPABILITY_GROUPS,
} from "@npati/shared";
import { ProjectOrchestrationError } from "./project-orchestrator-types";

/**
 * Selects an agent for project development tasks based on capabilities, role, and instructions.
 * NEVER checks agent.name. Only agents with the website file tools are eligible.
 */
export async function selectProjectAgent(
  workspaceStore: WorkspaceStore,
  ctx: AuthContext,
  companyId: string,
  requiredCapabilities: string[] = [...WEBSITE_FILE_TOOLS],
): Promise<CompanyAgent | undefined> {
  const company = await workspaceStore.getCompany(ctx, companyId);
  if (!company) throw new ProjectOrchestrationError("COMPANY_NOT_FOUND", `Company ${companyId} not found`, 404);

  const agents = await workspaceStore.listCompanyAgents(ctx, companyId);
  const activeAgents = agents.filter((a) => a.isActive && requiredCapabilities.every((cap) => a.tools?.includes(cap)));

  const DEVELOPER_KEYWORDS = /(?:developer|engineer|frontend|fullstack|software|web|coder|programmer|розробник|програміст|верстальник|фронтенд)/i;

  let bestAgent: CompanyAgent | undefined;
  let highestScore = -1;

  for (const agent of activeAgents) {
    let score = 0;
    const tools = agent.tools ?? [];

    // Capability score
    for (const cap of requiredCapabilities) {
      if (tools.includes(cap) || tools.includes("*")) score += 10;
    }
    if (tools.some((t) => t.startsWith("project.terminal."))) score += 5;
    if (tools.some((t) => t.startsWith("project.preview."))) score += 5;
    if (tools.some((t) => t.startsWith("project.git."))) score += 5;
    if (tools.some((t) => t.startsWith("project.deploy."))) score += 5;
    if (tools.some((t) => t.startsWith("project.qa."))) score += 5;

    // Role and instruction semantic relevance (NOT agent.name)
    const roleText = `${agent.role} ${agent.description ?? ""} ${agent.systemInstruction ?? ""}`;
    if (DEVELOPER_KEYWORDS.test(roleText)) score += 20;

    if (score > highestScore) {
      highestScore = score;
      bestAgent = agent;
    }
  }

  return bestAgent;
}

export async function ensureWebsiteAgent(workspaceStore: WorkspaceStore, ctx: AuthContext, companyId: string): Promise<CompanyAgent> {
  const existing = await selectProjectAgent(workspaceStore, ctx, companyId);
  if (existing) return existing;
  const company = await workspaceStore.getCompany(ctx, companyId);
  const main = company.mainAgentId
    ? await workspaceStore.getCompanyAgent(ctx, companyId, company.mainAgentId)
    : undefined;
  const agent = await workspaceStore.createCompanyAgent(ctx, companyId, {
    name: "Website Builder",
    role: "Frontend developer",
    description: "Builds and repairs websites requested in chat.",
    systemInstruction: "Inspect the project files, implement the requested website, and verify the result.",
    modelId: main?.modelId,
    tools: [...WEBSITE_FILE_TOOLS, ...PROJECT_PREVIEW_TOOLS, ...DATA_CAPABILITY_GROUPS["data.read"], ...DATA_CAPABILITY_GROUPS["data.schema"], ...DATA_CAPABILITY_GROUPS["data.write"], ...DATA_CAPABILITY_GROUPS["auth.admin"]],
    isActive: true,
  }, "website-builder-agent-v1");
  if (!canBuildWebsite(agent) || !agent.isActive) {
    throw new ProjectOrchestrationError("NO_QUALIFIED_AGENT", "No active agent has the required website project tools.", 400);
  }
  return agent;
}

export async function ensureDataAgent(workspaceStore: WorkspaceStore, ctx: AuthContext, companyId: string): Promise<CompanyAgent> {
  const required = ["project.data.schema.inspect", "project.data.schema.apply"];
  const agents = await workspaceStore.listCompanyAgents(ctx, companyId);
  const existing = agents.find(agent => agent.isActive && required.every(tool => isDataCapabilityPermitted(agent.tools, tool)));
  if (existing) return existing;
  const company = await workspaceStore.getCompany(ctx, companyId);
  const main = company.mainAgentId ? await workspaceStore.getCompanyAgent(ctx, companyId, company.mainAgentId) : undefined;
  return workspaceStore.createCompanyAgent(ctx, companyId, {
    name: "Data Builder", role: "Database developer", isActive: true, modelId: main?.modelId,
    systemInstruction: "Inspect the active project's schema before proposing structured schema changes. Use add_field for new columns; do not reapply a template to add a field. Work only in dev and respect migration approvals.",
    tools: [...DATA_CAPABILITY_GROUPS["data.read"], ...DATA_CAPABILITY_GROUPS["data.schema"], ...DATA_CAPABILITY_GROUPS["data.write"], ...DATA_CAPABILITY_GROUPS["auth.admin"]],
  }, "data-builder-agent-v1");
}

/** Mobile projects (D6) get an Expo-focused agent with the same file and preview tools. */
export async function ensureMobileAppAgent(workspaceStore: WorkspaceStore, ctx: AuthContext, companyId: string): Promise<CompanyAgent> {
  const existing = await selectProjectAgent(workspaceStore, ctx, companyId);
  if (existing) return existing;
  const company = await workspaceStore.getCompany(ctx, companyId);
  const main = company.mainAgentId
    ? await workspaceStore.getCompanyAgent(ctx, companyId, company.mainAgentId)
    : undefined;
  const agent = await workspaceStore.createCompanyAgent(ctx, companyId, {
    name: "Mobile App Builder",
    role: "Mobile app developer",
    description: "Builds Expo (React Native) apps that use the project Project API and Project Auth.",
    systemInstruction: "Inspect the mobile project files, implement the requested screens with the vendored SDK, and verify the Expo Web preview.",
    modelId: main?.modelId,
    tools: [...WEBSITE_FILE_TOOLS, ...PROJECT_PREVIEW_TOOLS],
    isActive: true,
  }, "mobile-app-builder-agent-v1");
  if (!canBuildMobileApp(agent) || !agent.isActive) {
    throw new ProjectOrchestrationError("NO_QUALIFIED_AGENT", "No active agent has the required mobile project tools.", 400);
  }
  return agent;
}

/**
 * Resolves the DataBackend a mobile project must share with the website (D6).
 * Never copies a database: one backend, several projects.
 */
export async function resolveMobileDataBackend(
  dataBackends: DataBackendService | undefined,
  ctx: AuthContext,
  companyId: string,
  requested: { dataBackendId?: string; prompt?: string },
): Promise<{ backendId?: string; choices?: Array<{ id: string; name: string }> }> {
  if (!dataBackends) return { backendId: undefined };
  const backends = await dataBackends.list(ctx, companyId);
  const usable = backends.filter((backend) => backend.status === "ready");
  if (!usable.length) {
    throw new ProjectOrchestrationError(
      "DATA_BACKEND_REQUIRED",
      "This Company has no DataBackend yet. Create Data and a schema for the website first (Data Studio), then the mobile app can share them.",
      400,
    );
  }
  if (requested.dataBackendId) {
    const match = usable.find((backend) => backend.id === requested.dataBackendId);
    if (!match) throw new ProjectOrchestrationError("DATA_BACKEND_NOT_FOUND", "The requested DataBackend is not available for this Company", 404);
    return { backendId: match.id };
  }
  if (usable.length === 1) return { backendId: usable[0]!.id };
  const prompt = (requested.prompt ?? "").toLowerCase();
  const named = usable.filter((backend) => backend.name && prompt.includes(backend.name.toLowerCase()));
  if (named.length === 1) return { backendId: named[0]!.id };
  return { choices: usable.map((backend) => ({ id: backend.id, name: backend.name })) };
}

/** Registers the app deep link so verification and reset links can return to the app (D6). */
export async function registerMobileRedirects(
  authRedirects: ProjectRedirectRepository | undefined,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  scheme: string,
): Promise<void> {
  if (!authRedirects) return;
  const url = `${scheme}://auth/callback`;
  for (const environment of ["dev", "prod"] as const) {
    await authRedirects.replace(ctx, companyId, projectId, environment, [url]).catch(() => undefined);
  }
}

export async function scaffoldMobileAppProject(
  projectWorkspace: ProjectWorkspace,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  projectName: string,
  scheme: string,
): Promise<void> {
  const scaffold = createMobileAppScaffold({ name: projectName, slug: slugifyProjectName(projectName), scheme });
  for (const [filePath, content] of Object.entries(scaffold.files)) {
    try { await projectWorkspace.readFile(ctx, companyId, projectId, filePath); }
    catch { await projectWorkspace.createFile(ctx, companyId, projectId, filePath, content); }
  }
}

export async function scaffoldWebsiteProject(
  projectWorkspace: ProjectWorkspace,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  projectName: string,
  framework: "nextjs" | "static",
  prompt?: string,
): Promise<void> {
  const template = /hosting|хост|vps|сервер|domain|домен/iu.test(`${projectName} ${prompt ?? ""}`) ? "hosting" : "landing";
  const doc = createDefaultWebsiteDocument(projectName, framework, { template });
  const adapter = getWebsiteAdapter(framework);
  const files = adapter.scaffoldProject(doc);
  for (const [filePath, content] of Object.entries(files)) {
    try { await projectWorkspace.readFile(ctx, companyId, projectId, filePath); }
    catch { await projectWorkspace.createFile(ctx, companyId, projectId, filePath, content); }
  }
}

/**
 * Initializes or updates the shared PROJECT.md context in the workspace root.
 */
export async function initSharedProjectContext(
  projectWorkspace: ProjectWorkspace,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  details: { name: string; description?: string; framework?: string; purpose?: string; projectType?: "website" | "mobile_app" | "code_project" },
): Promise<string> {
  const isMobileApp = details.projectType === "mobile_app";
  const content = isMobileApp
    ? [
        `# ${details.name}`,
        "",
        "## Purpose & Overview",
        details.purpose || details.description || "AI-generated mobile app (Expo / React Native).",
        "",
        "## Architecture & Tech Stack",
        `- Framework: ${details.framework || "Expo (React Native)"} with TypeScript`,
        "- Preview: Expo Web export served in the sandbox (Live Preview); store builds are not part of this step.",
        "",
        "## Backend Rules (Project API & Project Auth)",
        "- This app shares the DataBackend of its website: same collections, same end users, same access policies and RLS. Never create or copy a database.",
        "- Use only PROJECT_PUBLISHABLE_KEY (public). PROJECT_SECRET_KEY, DATABASE_URL and any database role credentials must never appear in the app code, bundle, logs or prompts.",
        "- Import the client SDK from `./npati-client` (already generated in the project root) and pass the deep link redirect from `./src/config`.",
        "- Refresh tokens stay in expo-secure-store; never fall back to plain AsyncStorage.",
        "",
        "## Engineering Mandate & Guidelines",
        "- **Targeted Edits Rule**: always search and inspect relevant files before modifying. Make surgical, targeted edits.",
        "- **No Blind Rewrites**: do NOT recreate the whole project or overwrite unchanged screens.",
        "- **Preserve Stability**: keep navigation, auth state and API wiring intact across iterations.",
        "",
        "## Project Status",
        `- Initialized: ${new Date().toISOString()}`,
        "- Mode: Active development",
      ].join("\n")
    : [
        `# ${details.name}`,
        "",
        "## Purpose & Overview",
        details.purpose || details.description || "Modern AI-generated web project.",
        "",
        "## Architecture & Tech Stack",
        `- Framework: ${details.framework || "Vite + React"}`,
        "- Language: TypeScript / JavaScript",
        "",
        "## Engineering Mandate & Guidelines",
        details.projectType === "code_project"
          ? "- Source files are the source of truth. Edit this website in the Coding Agent workspace; preserve the attached database/auth SDK and existing routes."
          : "- **Single Source of Truth**: website.config.json defines all pages, blocks, components, styles, and content. When modifying or creating sections, keep website.config.json synchronized so the visual editor and live preview stay in sync.",
        "- **Targeted Edits Rule**: Always search and inspect relevant files before modifying. Make surgical, targeted edits.",
        "- **No Blind Rewrites**: Do NOT recreate the entire project or overwrite unchanged components.",
        "- **Preserve Stability**: Ensure configuration, routing, and functional components remain intact across iterations.",
        "",
        "## Project Status",
        `- Initialized: ${new Date().toISOString()}`,
        "- Mode: Active development",
      ].join("\n");

  try {
    const existing = await projectWorkspace.readFile(ctx, companyId, projectId, "PROJECT.md");
    await projectWorkspace.writeFile(ctx, companyId, projectId, "PROJECT.md", content, existing.revision);
  } catch {
    await projectWorkspace.createFile(ctx, companyId, projectId, "PROJECT.md", content);
  }
  return content;
}

export async function getSharedProjectContext(
  projectWorkspace: ProjectWorkspace,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
): Promise<string | undefined> {
  try {
    const file = await projectWorkspace.readFile(ctx, companyId, projectId, "PROJECT.md");
    return file.content;
  } catch {
    return undefined;
  }
}

export async function recordScaffoldFallback(
  workspaceStore: WorkspaceStore,
  ctx: AuthContext,
  companyId: string,
  project: Project,
  idempotencyKey: string,
): Promise<CompanyAgentRunDetails> {
  const result = `Створено стартовий сайт "${project.name}" на базі ${project.framework}. AI-персоналізацію не завершено; базовий сайт доступний для перегляду й редагування.`;
  const { run } = await workspaceStore.createCompanyAgentRun(ctx, companyId, {
    task: `Create starter website: ${project.name}`, requestedMode: "single", projectId: project.id,
  }, `${idempotencyKey}:scaffold-fallback`);
  await workspaceStore.updateCompanyAgentRun(ctx, companyId, run.id, {
    status: "completed", executionMode: "single", selectedAgentIds: [], result,
  });
  return workspaceStore.getCompanyAgentRun(ctx, companyId, run.id);
}
