import { randomUUID } from "node:crypto";
import { assertNoSecrets } from "@npati/memory";
import type { AuthContext, CompanyAgentEdge, Goal, GoalInput, MemoryInput, MemoryItem } from "./types";
import { WorkspaceAccessError } from "./types";
import { now } from "./in-memory-clock";

export interface InMemoryGoalState {
  companyEdges: any
  goals: any
  memories: any
  assertBusiness: (context: AuthContext, businessId: string) => any
  assertCompanyAgent: (context: AuthContext, companyId: string, agentId: string) => any
}

export async function setCompanyAgentParent(host: InMemoryGoalState, context: AuthContext, companyId: string, childAgentId: string, parentAgentId: string | null) {
    host.assertCompanyAgent(context, companyId, childAgentId);
    if (parentAgentId === childAgentId) throw new Error("An agent cannot be its own parent");
    if (parentAgentId) host.assertCompanyAgent(context, companyId, parentAgentId);
    const old = [...host.companyEdges.entries()].find(([, edge]) => edge.companyId === companyId && edge.childAgentId === childAgentId);
    if (old) host.companyEdges.delete(old[0]);
    if (!parentAgentId) return null;
    const children = (id: string) => [...host.companyEdges.values()].filter((edge) => edge.companyId === companyId && edge.parentAgentId === id).map((edge) => edge.childAgentId);
    const pending = [childAgentId], visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === parentAgentId) {
        if (old) host.companyEdges.set(old[0], old[1]);
        throw new Error("Circular agent relationships are not allowed");
      }
      if (!visited.has(id)) { visited.add(id); pending.push(...children(id)); }
    }
    const edge: CompanyAgentEdge = { id: randomUUID(), workspaceId: context.workspaceId, companyId,
      parentAgentId, childAgentId, relationType: "reports_to", createdAt: now() };
    host.companyEdges.set(edge.id, edge);
    return edge;
  }

export async function listGoals(host: InMemoryGoalState, context: AuthContext, businessId: string) {
    host.assertBusiness(context, businessId);
    return [...host.goals.values()].filter((goal) => goal.workspaceId === context.workspaceId && goal.businessId === businessId).sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt));
  }

export async function createGoal(host: InMemoryGoalState, context: AuthContext, businessId: string, input: GoalInput) {
    host.assertBusiness(context, businessId);
    const timestamp = now();
    const goal: Goal = { id: randomUUID(), workspaceId: context.workspaceId, businessId, createdByUserId: context.userId, status: input.status ?? "active", priority: input.priority ?? 3, createdAt: timestamp, updatedAt: timestamp, ...input, title: input.title.trim() };
    if (!goal.title) throw new Error("Goal title is required");
    host.goals.set(goal.id, goal);
    return goal;
  }

export async function updateGoal(host: InMemoryGoalState, context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>) {
    host.assertBusiness(context, businessId);
    const goal = host.goals.get(goalId);
    if (!goal || goal.workspaceId !== context.workspaceId || goal.businessId !== businessId) throw new WorkspaceAccessError("Goal is not available for this business");
    const updated = { ...goal, ...input, updatedAt: now() };
    host.goals.set(goalId, updated);
    return updated;
  }

export async function deleteGoal(host: InMemoryGoalState, context: AuthContext, businessId: string, goalId: string) {
    await updateGoal(host, context, businessId, goalId, {});
    return host.goals.delete(goalId);
  }

export async function listMemory(host: InMemoryGoalState, context: AuthContext, businessId: string, query = "", limit = 100) {
    host.assertBusiness(context, businessId);
    const needle = query.trim().toLowerCase();
    return [...host.memories.values()]
      .filter((item) => item.workspaceId === context.workspaceId && item.businessId === businessId && (!needle || `${item.type} ${item.title} ${item.content}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

export async function createMemory(host: InMemoryGoalState, context: AuthContext, businessId: string, input: MemoryInput) {
    host.assertBusiness(context, businessId); assertNoSecrets(input);
    const timestamp = now();
    const item: MemoryItem = { id: randomUUID(), workspaceId: context.workspaceId, businessId, userId: context.userId, source: input.source ?? "user", ...input, createdAt: timestamp, updatedAt: timestamp };
    host.memories.set(item.id, item);
    return item;
  }

export async function updateMemory(host: InMemoryGoalState, context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>) {
    host.assertBusiness(context, businessId); assertNoSecrets(input);
    const item = host.memories.get(memoryId);
    if (!item || item.workspaceId !== context.workspaceId || item.businessId !== businessId) throw new WorkspaceAccessError("Memory is not available for this business");
    const updated = { ...item, ...input, updatedAt: now() };
    host.memories.set(memoryId, updated);
    return updated;
  }

