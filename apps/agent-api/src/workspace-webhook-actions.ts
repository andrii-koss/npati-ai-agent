import type { AuthContext, Company, WorkspaceStore } from "@npati/workspace";
import type { IntegrationsRepository } from "./integrations-repository";

export type WebhookDirective = {
  action: "webhook.list" | "webhook.create" | "webhook.update" | "webhook.delete";
  webhookId?: string;
  webhookName?: string;
  webhook?: { name?: string; promptTemplate?: string; agentId?: string | null; isActive?: boolean };
};

type WebhookRepository = Pick<IntegrationsRepository, "listWebhooks" | "createWebhook" | "deleteWebhook" | "setWebhookActive">;
type WebhookLabels = { status: string; active: string; company: string };

// Webhooks are the company's inbound integrations; they are managed like automations.
export const webhookResourceSignal = /(?:webhook|вебхук|веб-хук|інтеграц\p{L}*|integration|integraç\p{L}*|integraci\p{L}*|integrationen)/iu;

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/```/g, "'''").trim().slice(0, max);
}

/** Webhook secrets never enter the prompt: name, state and target agent only. */
export async function webhookPromptContext(auth: AuthContext, webhooks: Pick<WebhookRepository, "listWebhooks">, companies: Company[]) {
  return (await Promise.all(companies.map(async (company) =>
    (await webhooks.listWebhooks(auth, company.id).catch(() => [])).map((item) => ({ id: item.id, companyId: company.id, companyName: company.name, name: item.name, isActive: item.isActive, agentId: item.agentId ?? null, lastTriggeredAt: item.lastTriggeredAt ?? null }))
  ))).flat();
}

export async function executeWebhookAction(
  auth: AuthContext,
  deps: { store: WorkspaceStore; webhooks: WebhookRepository },
  company: Company,
  directive: WebhookDirective,
  labels: WebhookLabels,
  intro: string,
  finish: (card: string) => string,
): Promise<{ text: string; resourceId: string }> {
  const available = await deps.webhooks.listWebhooks(auth, company.id);
  const settings = "/integrations?company=" + encodeURIComponent(company.id);
  const agents = await deps.store.listCompanyAgents(auth, company.id);
  const details = (item: { isActive: boolean; agentId?: string | null }) =>
    "**" + labels.status + ":** " + (item.isActive ? labels.active : "inactive") + "\n**Agent:** " + clean(agents.find((agent) => agent.id === item.agentId)?.name || "main agent", 200);
  const card = (name: string, body: string) => "```card:" + clean(name, 200) + "\n" + body + "\n\n[Settings > Integrations](" + settings + ")\n```";
  if (directive.action === "webhook.list") {
    const lines = available.length ? available.map((item) => "### " + clean(item.name, 200) + "\n" + details(item)).join("\n\n") : "No webhooks are configured.";
    return { text: intro + "\n\n" + lines + "\n\n[Settings > Integrations](" + settings + ")", resourceId: company.id };
  }
  if (directive.action === "webhook.create") {
    const item = directive.webhook;
    const name = clean(item?.name, 200), promptTemplate = clean(item?.promptTemplate, 4000);
    if (!name || !promptTemplate) throw new Error("A webhook name and the task for the incoming data are required");
    if (item?.agentId && !agents.some((agent) => agent.id === item.agentId)) throw new Error("Agent is not owned by this company");
    let created = available.find((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())
      ?? await deps.webhooks.createWebhook(auth, company.id, { name, promptTemplate, agentId: item?.agentId ?? undefined, isActive: item?.isActive });
    if (typeof item?.isActive === "boolean" && created.isActive !== item.isActive) {
      const updated = await deps.webhooks.setWebhookActive(auth, company.id, created.id, item.isActive);
      if (!updated) throw new Error("Webhook not found");
      created = updated;
    }
    return { text: finish(card(created.name, details(created))), resourceId: created.id };
  }
  const name = directive.webhookName?.trim().toLocaleLowerCase();
  const matches = directive.webhookId ? available.filter((entry) => entry.id === directive.webhookId)
    : name ? available.filter((entry) => entry.name.toLocaleLowerCase() === name) : available.length === 1 ? available : [];
  if (matches.length !== 1) throw new Error("Webhook target is missing or ambiguous");
  const current = matches[0]!;
  if (directive.action === "webhook.delete") {
    if (!await deps.webhooks.deleteWebhook(auth, company.id, current.id)) throw new Error("Webhook not found");
    return { text: finish(card(current.name, "**" + labels.company + ":** " + clean(company.name, 300))), resourceId: current.id };
  }
  if (typeof directive.webhook?.isActive !== "boolean") throw new Error("Only enabling or disabling a webhook is supported from chat");
  const updated = await deps.webhooks.setWebhookActive(auth, company.id, current.id, directive.webhook.isActive);
  if (!updated) throw new Error("Webhook not found");
  return { text: finish(card(updated.name, details(updated))), resourceId: updated.id };
}
