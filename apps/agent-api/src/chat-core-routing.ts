import type { ChatRequest, ChatToolDefinition } from "@npati/omniroute-adapter";
import { extractTargetUrlOrDomain } from "@npati/web-research";
import type { CoreChatRoute, CoreChatCapability } from "./chat-project-intent";
import { explicitlyRequestsWebResearch } from "./chat-text-directives";
import { CORE_CHAT_TOOLS } from "./chat-tool-orchestrator";
import { CompanyChatActions } from "./company-chat-actions";
import { EmailChatActions } from "./email-chat-actions";
import { WorkspaceChatActions } from "./workspace-chat-actions";

/** A semantic decision narrows existing capabilities; it never grants permission. */
export function coreRouteOwns(route: CoreChatRoute | undefined, capability: CoreChatCapability): boolean {
  return !route || route.capability === capability || Boolean(route.also?.includes(capability));
}

/** Chooses among authorized tools; execution and permission checks remain with their owners. */
export function decideCoreChatRouting(message: string, tools: ChatToolDefinition[], hasAttachedEvidence = false, companyManagement = false, route?: CoreChatRoute, semanticExternalIntent = false) {
  const availableToolNames = tools.map((tool) => tool.function.name);
  const directUrl = extractTargetUrlOrDomain(message);
  const primaryInstruction = message.split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ");
  const companyManagementIntent = companyManagement || !WorkspaceChatActions.isManagementRequest(primaryInstruction) && !EmailChatActions.isManagementRequest(primaryInstruction) && CompanyChatActions.isManagementRequest(message);
  const internalManagementIntent = companyManagementIntent || availableToolNames.includes("npati_workspace_action") || availableToolNames.includes("npati_email_action") || WorkspaceChatActions.isManagementRequest(message) || EmailChatActions.isManagementRequest(message);
  const explicitWebIntent = explicitlyRequestsWebResearch(message, { requireOperation: internalManagementIntent });
  const primaryExplicitWebIntent = explicitlyRequestsWebResearch(primaryInstruction, { requireOperation: internalManagementIntent });
  // The classifier's research decision is binding: "give the agent web.search" names a capability, it is not a lookup.
  const explicitExternalIntent = route?.research === false ? false
    : Boolean(directUrl) || (internalManagementIntent ? primaryExplicitWebIntent : explicitWebIntent || (!hasAttachedEvidence && semanticExternalIntent));
  let toolChoice: ChatRequest["toolChoice"] = tools.length ? "auto" : "none";
  if (explicitExternalIntent && directUrl && availableToolNames.includes("web_fetch")) {
    toolChoice = { type: "function", function: { name: "web_fetch" } };
  } else if (explicitExternalIntent && availableToolNames.includes("web_search")) {
    toolChoice = { type: "function", function: { name: "web_search" } };
  } else if (route) {
    // Reads and ambiguous changes keep auto so the model can answer or ask for clarification.
    if (route.mutation && route.capability && availableToolNames.includes(route.capability)) toolChoice = { type: "function", function: { name: route.capability } };
  } else if (companyManagementIntent && availableToolNames.includes("npati_company_action")) {
    toolChoice = { type: "function", function: { name: "npati_company_action" } };
  } else if (availableToolNames.includes("npati_email_action")) {
    toolChoice = { type: "function", function: { name: "npati_email_action" } };
  }
  return { directUrl, semanticExternalIntent, internalManagementIntent, explicitWebIntent, primaryInstruction, primaryExplicitWebIntent,
    explicitExternalIntent, hasAttachedEvidence, availableToolNames,
    filteredOutTools: CORE_CHAT_TOOLS.map((tool) => tool.function.name).filter((name) => !availableToolNames.includes(name)), toolChoice };
}
