import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { StructuredChatPlan } from "./chat-task-plan";

export async function verifyPlannedCompany(store: WorkspaceStore, auth: AuthContext, companyId: string, plan: StructuredChatPlan): Promise<{ complete: boolean; missing: string[] }> {
  const company = await store.getCompany(auth, companyId);
  const agents = await store.listCompanyAgents(auth, companyId);
  const edges = await store.listCompanyAgentEdges(auth, companyId);
  const missing: string[] = [];
  for (const [field, expected] of Object.entries(plan.company_fields ?? {})) {
    if (typeof expected !== "string" || !expected.trim()) continue;
    if (field === "languages") {
      const requested = expected.split(/,|;|\n/).map((item) => item.trim()).filter(Boolean);
      if (requested.some((item) => !company.languages.includes(item))) missing.push(field);
      continue;
    }
    if (!["name", "industry", "description", "website", "productsServices", "brandTone", "companyInstructions", "status"].includes(field)) continue;
    const saved = String((company as unknown as Record<string, unknown>)[field] ?? "");
    if (field === "companyInstructions" ? !saved.includes(expected.trim()) : saved.trim() !== expected.trim()) missing.push(field);
  }
  if (plan.company_agent_count && agents.length !== plan.company_agent_count) missing.push("agent count");
  const plannedAgents = Array.isArray(plan.company_agents) ? plan.company_agents : [];
  for (const expected of plannedAgents) {
    if (!expected || typeof expected.name !== "string" || typeof expected.role !== "string") continue;
    const saved = agents.find((agent) => agent.name.trim().toLocaleLowerCase() === expected.name.trim().toLocaleLowerCase());
    if (!saved) { missing.push(expected.name); continue; }
    if (saved.role.trim() !== expected.role.trim()) missing.push(expected.name + " role");
    for (const responsibility of Array.isArray(expected.responsibilities) ? expected.responsibilities : []) {
      if (typeof responsibility === "string" && responsibility.trim() && !String(saved.systemInstruction ?? "").includes(responsibility.trim())) missing.push(expected.name + " responsibility");
    }
    if (expected.main && company.mainAgentId !== saved.id) missing.push(expected.name + " main agent");
    if (expected.parent_name) {
      const parent = agents.find((agent) => agent.name.trim().toLocaleLowerCase() === expected.parent_name!.trim().toLocaleLowerCase());
      if (!parent || !edges.some((edge) => edge.childAgentId === saved.id && edge.parentAgentId === parent.id)) missing.push(expected.name + " parent");
    }
  }
  return { complete: missing.length === 0, missing: [...new Set(missing)] };
}