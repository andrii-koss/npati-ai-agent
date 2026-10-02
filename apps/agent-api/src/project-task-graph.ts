import type { CompanyAgent, CompanyAgentEdge } from "@npati/workspace";
import {
  ProjectFileLeaseManager,
  type ProjectFileLease,
  ProjectFileLockError,
  normalizeLockPath,
  pathsConflict,
  pathSetsConflict,
} from "./project-file-lock";

export {
  ProjectFileLeaseManager,
  type ProjectFileLease,
  ProjectFileLockError,
  normalizeLockPath,
  pathsConflict,
  pathSetsConflict,
};

export type ProjectTaskStatus = "queued" | "running" | "completed" | "failed" | "waiting";
export type ProjectTaskRole = "design" | "frontend" | "seo" | "qa" | "security";
export interface ProjectTask {
  id: string;
  title: string;
  role: ProjectTaskRole;
  dependsOn: string[];
  paths: string[];
  status: ProjectTaskStatus;
  agentId?: string;
  result?: string;
  error?: string;
}

const roles: ProjectTaskRole[] = ["design", "frontend", "seo", "qa", "security"];
const roleWords: Record<ProjectTaskRole, RegExp> = {
  design: /design|visual|ux|ui|brand|дизайн/i,
  frontend: /frontend|developer|engineer|web|software|код|розроб|фронтенд/i,
  seo: /seo|search engine|metadata|пошук|оптимізац/i,
  qa: /qa|quality|test|review|тест|перевір/i,
  security: /security|secure|audit|безпек/i,
};

function safeScope(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || !value || value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value)) throw new Error("Invalid task file scope");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".npati-") || /[\x00-\x1f]/.test(part))) throw new Error("Invalid task file scope");
  return parts.join("/");
}

export function parseProjectTaskPlan(content: string, fallbackPrompt: string): ProjectTask[] {
  let raw: unknown;
  try {
    const start = content.indexOf("{"), end = content.lastIndexOf("}");
    raw = JSON.parse(content.slice(start, end + 1));
  } catch { raw = undefined; }
  const candidate = raw && typeof raw === "object" && Array.isArray((raw as { tasks?: unknown }).tasks)
    ? (raw as { tasks: unknown[] }).tasks : [];
  const tasks: ProjectTask[] = [];
  for (const item of candidate.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(entry.id) || tasks.some((task) => task.id === entry.id)) continue;
    if (typeof entry.role !== "string" || !roles.includes(entry.role as ProjectTaskRole)) continue;
    const paths = Array.isArray(entry.paths) ? entry.paths.slice(0, 20).map(safeScope) : [];
    tasks.push({
      id: entry.id,
      title: typeof entry.title === "string" ? entry.title.slice(0, 200) : entry.id,
      role: entry.role as ProjectTaskRole,
      dependsOn: Array.isArray(entry.depends_on) ? entry.depends_on.filter((id): id is string => typeof id === "string").slice(0, 8) : [],
      paths,
      status: "queued",
    });
  }
  if (!tasks.length) {
    return [
      { id: "design", title: "Define page structure and visual direction", role: "design", dependsOn: [], paths: [], status: "queued" },
      { id: "frontend", title: fallbackPrompt.slice(0, 200), role: "frontend", dependsOn: ["design"], paths: [], status: "queued" },
      { id: "qa", title: "Review the implementation and report issues", role: "qa", dependsOn: ["frontend"], paths: [], status: "queued" },
    ];
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.dependsOn.includes(task.id) || task.dependsOn.some((id) => !byId.has(id))) throw new Error("Invalid project task dependency");
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Project task dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return tasks;
}

export function selectProjectTaskAgent(
  role: ProjectTaskRole,
  agents: CompanyAgent[],
  edges: CompanyAgentEdge[],
  mainAgentId: string,
): CompanyAgent | undefined {
  const active = agents.filter((agent) => agent.isActive);
  const scored = active.map((agent) => {
    const text = [agent.role, agent.description, agent.systemInstruction, agent.promptGuidelines].filter(Boolean).join(" ");
    const tools = agent.tools ?? [];
    let score = roleWords[role].test(text) ? 20 : 0;
    if (role === "frontend" && tools.some((tool) => tool.startsWith("project.files."))) score += 15;
    if (role === "qa" && tools.some((tool) => tool.startsWith("project.preview.") || tool.startsWith("project.terminal."))) score += 10;
    if (role === "security" && tools.some((tool) => tool.startsWith("project.git."))) score += 5;
    if (agent.modelId) score += 1;
    if (edges.some((edge) => edge.parentAgentId === mainAgentId && edge.childAgentId === agent.id)) score += 3;
    if (agent.id === mainAgentId) score -= 5;
    return { agent, score };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.score > 0 ? best.agent : active.find((agent) => agent.id === mainAgentId);
}

export function taskScopesConflict(left: ProjectTask, right: ProjectTask): boolean {
  if (!left.paths.length || !right.paths.length) return true;
  return left.paths.some((a) => right.paths.some((b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/")));
}

export async function executeProjectTaskGraph(
  tasks: ProjectTask[],
  execute: (task: ProjectTask, snapshot: ProjectTask[]) => Promise<string>,
  onStatus: (task: ProjectTask, snapshot: ProjectTask[]) => Promise<void>,
  maxConcurrent = 3,
  leaseManager?: ProjectFileLeaseManager,
  projectId?: string,
): Promise<ProjectTask[]> {
  const running = new Map<string, Promise<void>>();
  const capacity = Math.max(1, Math.min(3, maxConcurrent));
  while (true) {
    for (const task of tasks) {
      if (task.status !== "queued") continue;
      if (task.dependsOn.some((id) => tasks.find((item) => item.id === id)?.status === "failed")) {
        task.status = "waiting";
        await onStatus(task, tasks);
      }
    }
    for (const task of tasks) {
      if (running.size >= capacity) break;
      if (task.status !== "queued" || !task.dependsOn.every((id) => tasks.find((item) => item.id === id)?.status === "completed")) continue;
      if ([...running.keys()].some((id) => taskScopesConflict(task, tasks.find((item) => item.id === id)!))) continue;
      task.status = "running";
      await onStatus(task, tasks);
      const work = (async () => {
        let lease: ProjectFileLease | undefined;
        try {
          if (leaseManager && projectId && task.paths.length > 0) {
            lease = await leaseManager.acquire(projectId, task.agentId ?? task.id, task.paths, { taskId: task.id });
          }
          task.result = await execute(task, tasks);
          task.status = "completed";
        } catch (error) {
          task.error = error instanceof Error ? error.message.slice(0, 300) : "Task failed";
          task.status = "failed";
          if (
            (error as { code?: string }).code === "MODEL_CALL_BUDGET_EXCEEDED" ||
            (error instanceof Error && error.message.includes("model call limit reached"))
          ) {
            for (const remaining of tasks) {
              if (remaining.status === "queued") remaining.status = "waiting";
            }
          }
        } finally {
          if (leaseManager && projectId) {
            if (lease) leaseManager.release(lease.id);
            leaseManager.releaseAgentLeases(projectId, task.agentId ?? task.id);
          }
          running.delete(task.id);
          await onStatus(task, tasks);
        }
      })();
      running.set(task.id, work);
    }
    if (!running.size) {
      if (tasks.some((task) => task.status === "queued")) throw new Error("Project task graph could not make progress");
      return tasks;
    }
    await Promise.race(running.values());
  }
}

export function mergeProjectText(base: string, current: string, proposed: string): string | undefined {
  if (current === base) return proposed;
  if (proposed === base) return current;
  const baseLines = base.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const proposedLines = proposed.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let prefix = 0;
  while (prefix < baseLines.length && prefix < proposedLines.length && baseLines[prefix] === proposedLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < baseLines.length - prefix && suffix < proposedLines.length - prefix &&
    baseLines[baseLines.length - suffix - 1] === proposedLines[proposedLines.length - suffix - 1]) suffix++;
  const oldBlock = baseLines.slice(prefix, baseLines.length - suffix).join("");
  const newBlock = proposedLines.slice(prefix, proposedLines.length - suffix).join("");
  if (!oldBlock) {
    const before = prefix ? baseLines[prefix - 1] ?? "" : "";
    const after = suffix ? baseLines[baseLines.length - suffix] ?? "" : "";
    const anchor = before + after;
    if (!anchor || current.indexOf(anchor) < 0 || current.indexOf(anchor) !== current.lastIndexOf(anchor)) return undefined;
    const index = current.indexOf(anchor) + before.length;
    return current.slice(0, index) + newBlock + current.slice(index);
  }
  const index = current.indexOf(oldBlock);
  if (index < 0 || index !== current.lastIndexOf(oldBlock)) return undefined;
  return current.slice(0, index) + newBlock + current.slice(index + oldBlock.length);
}
