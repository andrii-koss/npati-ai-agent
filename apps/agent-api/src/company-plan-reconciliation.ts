import type { StructuredChatPlan } from "./chat-task-plan";

export function reconcilePlannedCompanyArgs(args: Record<string, unknown>, plan: StructuredChatPlan): Record<string, unknown> {
  if (plan.primary_action !== "create_company") return args;
  const suppliedFields = args.fields && typeof args.fields === "object" && !Array.isArray(args.fields) ? args.fields as Record<string, unknown> : {};
  const plannedFields = plan.company_fields && typeof plan.company_fields === "object" && !Array.isArray(plan.company_fields) ? plan.company_fields : {};
  const fields: Record<string, unknown> = { ...suppliedFields };
  for (const key of ["name", "industry", "description", "website", "productsServices", "brandTone", "companyInstructions"]) {
    const value = plannedFields[key];
    if (typeof value === "string" && value.trim()) fields[key] = value.trim();
  }
  if (typeof plannedFields.languages === "string" && plannedFields.languages.trim()) fields.languages = plannedFields.languages.split(/,|;|\n/).map((item) => item.trim()).filter(Boolean);
  if (plannedFields.status === "active" || plannedFields.status === "inactive") fields.status = plannedFields.status;
  if (!fields.name && plan.entity.trim()) fields.name = plan.entity.trim();

  const plannedAgents = (plan.company_agents ?? []).filter((agent) =>
    agent && typeof agent.name === "string" && agent.name.trim() && typeof agent.role === "string" && agent.role.trim());
  if (!plannedAgents.length) return { ...args, action: "create", companyId: undefined, fields };

  const suppliedAgents = Array.isArray(args.agents) ? args.agents as Array<Record<string, unknown>> : [];
  const main = plannedAgents.find((agent) => agent.main) ?? plannedAgents[0]!;
  const rules = Array.isArray(plan.company_agent_rules) ? plan.company_agent_rules.filter((rule): rule is string => typeof rule === "string" && Boolean(rule.trim())) : [];
  const coordination = typeof plan.company_coordination === "string" ? plan.company_coordination.trim() : "";
  const agents = plannedAgents.map((agent, index) => {
    const supplied = suppliedAgents.find((item) => {
      const itemFields = item.fields && typeof item.fields === "object" && !Array.isArray(item.fields) ? item.fields as Record<string, unknown> : item;
      return String(itemFields.name ?? item.agentName ?? "").trim().toLocaleLowerCase() === agent.name.trim().toLocaleLowerCase();
    }) ?? {};
    const sourceFields = supplied.fields && typeof supplied.fields === "object" && !Array.isArray(supplied.fields) ? supplied.fields as Record<string, unknown> : {};
    const responsibilities = Array.isArray(agent.responsibilities) ? agent.responsibilities.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
    const suppliedInstruction = typeof sourceFields.systemInstruction === "string" ? sourceFields.systemInstruction.trim() : "";
    const suppliedDescription = typeof sourceFields.description === "string" ? sourceFields.description.trim() : "";
    const instructions = [
      suppliedInstruction,
      "You are " + agent.name.trim() + ", the " + agent.role.trim() + ".",
      responsibilities.length ? "Responsibilities:\n" + responsibilities.map((item) => "- " + item.trim()).join("\n") : "",
      rules.length ? "Shared agent behavior:\n" + rules.map((item) => "- " + item.trim()).join("\n") : "",
      agent.name === main.name && coordination ? "Coordination: " + coordination : "",
    ].filter(Boolean).join("\n\n");
    return {
      ...supplied,
      action: "create",
      fields: {
        ...sourceFields,
        name: agent.name.trim(),
        role: agent.role.trim(),
        ...(responsibilities.length ? { description: [suppliedDescription, responsibilities.join("; ")].filter(Boolean).join("; ") } : {}),
        systemInstruction: instructions,
        sortOrder: index,
      },
      main: agent.name === main.name,
      parentAgentName: agent.name === main.name ? null : agent.parent_name?.trim() || main.name.trim(),
    };
  });
  const companyInstructions = [String(fields.companyInstructions ?? "").trim(), coordination, ...rules].filter(Boolean).join("\n\n");
  if (companyInstructions) fields.companyInstructions = companyInstructions;
  return { ...args, action: "create", companyId: undefined, fields, agents, mainAgentName: main.name.trim() };
}