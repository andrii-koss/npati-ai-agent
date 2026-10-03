import type { ChatToolDefinition } from "@npati/omniroute-adapter";
import type { AuthContext, Business, BusinessInput, GoalInput, MemoryInput, WorkspaceStore } from "@npati/workspace";

export const profileFields = ["name", "businessType", "businessStage", "industry", "niche", "country", "market", "teamType", "presenceType", "businessModel", "website", "legalName", "contactEmail", "contactPhone", "postalAddress", "description", "productsServicesSummary", "audienceSummary", "registrationDetails"] as const;
const textFields = Object.fromEntries(profileFields.map((name) => [name, { type: "string", description: `User-supplied ${name}; preserve the exact applicable value. Never invent legal or contact values.` }]));

export function reconcilePlannedBusinessArgs(args: Record<string, unknown>, plannedFields: Record<string, string>, primaryCreation: boolean): Record<string, unknown> {
  const supplied = args.profile && typeof args.profile === "object" && !Array.isArray(args.profile) ? args.profile as Record<string, unknown> : {};
  const profile = { ...supplied };
  for (const field of profileFields) {
    const value = plannedFields[field];
    if (typeof value !== "string" || !value.trim()) continue;
    if (field === "registrationDetails" && /\b(use|do not|don't|if available|available in the system)\b/i.test(value)) continue;
    if (field === "contactEmail") {
      const email = /mailto:([^\s)]+)|([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/.exec(value);
      if (email) profile[field] = email[1] ?? email[2];
    } else if (field === "website") profile[field] = /^https?:\/\//i.test(value.trim()) ? value.trim() : "https://" + value.trim();
    else if (field === "businessStage") {
      const stage = value.trim().toLowerCase();
      if (["idea", "starting", "operating", "growing", "scaling"].includes(stage)) profile[field] = stage;
    } else if (field === "teamType") {
      const team = value.trim().toLowerCase();
      if (["solo", "team"].includes(team)) profile[field] = team;
    } else if (field === "presenceType") {
      const presence = value.trim().toLowerCase();
      if (["online", "local", "both"].includes(presence)) profile[field] = presence;
      else if (presence.includes("online") && presence.includes("local")) profile[field] = "both";
    } else profile[field] = value.trim();
  }
  if (primaryCreation && !profile.name && plannedFields.name?.trim()) profile.name = plannedFields.name.trim();
  return { ...args, action: primaryCreation ? "create" : args.action, businessId: primaryCreation ? undefined : args.businessId, profile };
}
export const BUSINESS_PROFILE_TOOL: ChatToolDefinition = {
  type: "function",
  function: {
    name: "npati_business_profile",
    description: "Create or update an NPATI Business Profile. Use when the user's primary request is to create or configure a business, business idea, or Business Profile, even when a long structured request also contains goals, memory, products, audience, registration details, or logo instructions. Preserve every supplied field. Resolve dependent goals and memories against this profile. Do not substitute a secondary memory, goal, company, or web action for this primary action. A separate AI Company with agents uses npati_company_action instead.",
    parameters: {
      type: "object", additionalProperties: false, required: ["action", "profile"],
      properties: {
        action: { type: "string", enum: ["create", "update"] },
        businessId: { type: "string", description: "Owned Business Profile ID for an update or contextual follow-up." },
        profile: { type: "object", additionalProperties: false, properties: { ...textFields, businessStage: { type: "string", enum: ["idea", "starting", "operating", "growing", "scaling"], description: "Map the user-supplied stage to this UI value." }, teamType: { type: "string", enum: ["solo", "team"], description: "Map the user-supplied team field to this UI value." }, presenceType: { type: "string", enum: ["online", "local", "both"], description: "Map the user-supplied presence field to this UI value." }, logoAttachmentName: { type: "string", description: "Exact filename of a user-attached image; omit when no matching image exists." } } },
        goals: { type: "array", description: "Goals explicitly requested as dependent steps. Find an existing matching goal before creating one; link to the profile above.", items: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" }, description: { type: "string" }, priority: { type: "integer" }, status: { type: "string", enum: ["active", "completed", "paused", "cancelled"] }, targetValue: { type: "number" }, currentValue: { type: "number" }, targetUnit: { type: "string" }, targetDate: { type: "string" } } } },
        memories: { type: "array", description: "Durable facts explicitly requested as dependent steps. Find an existing matching memory before creating one; link to the profile above.", items: { type: "object", additionalProperties: false, required: ["type", "title", "content"], properties: { type: { type: "string", enum: ["business_fact", "audience", "brand", "preference", "decision", "product", "channel", "experiment", "result", "other"] }, title: { type: "string" }, content: { type: "string" }, confidence: { type: "number" } } } },
      },
    },
  },
};

export async function executeBusinessProfileTool(input: {
  store: WorkspaceStore; auth: AuthContext; args: Record<string, unknown>;
  createRequestKey?: string;
  logoAttachments?: Array<{ name: string; mimeType: string; data: Buffer; kind?: string }>;
  persistLogo?: (auth: AuthContext, businessId: string, attachment: { name: string; mimeType: string; data: Buffer; kind?: string }) => Promise<Business>;
}) {
  const { store, auth, args } = input;
  if (!auth.permissions.includes("business:manage")) throw new Error("Business management permission is required");
  if (args.action !== "create" && args.action !== "update") throw new Error("Invalid Business Profile action");
  if (!args.profile || typeof args.profile !== "object" || Array.isArray(args.profile)) throw new Error("A structured Business Profile is required");
  const raw = args.profile as Record<string, unknown>;
  const unexpected = Object.keys(raw).filter((key) => key !== "logoAttachmentName" && !(profileFields as readonly string[]).includes(key));
  if (unexpected.length) throw new Error(`Unsupported Business Profile fields: ${unexpected.join(", ")}`);
  const profile: Record<string, string> = {};
  for (const field of profileFields) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "string") throw new Error(`Invalid ${field}`);
    profile[field] = raw[field].trim();
  }
  if (profile.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.contactEmail)) throw new Error("Invalid business contact email");
  if (profile.businessStage && !["idea", "starting", "operating", "growing", "scaling"].includes(profile.businessStage)) throw new Error("Invalid business stage");
  if (profile.teamType && !["solo", "team"].includes(profile.teamType)) throw new Error("Invalid team type");
  if (profile.presenceType && !["online", "local", "both"].includes(profile.presenceType)) throw new Error("Invalid presence type");
  const logoName = typeof raw.logoAttachmentName === "string" ? raw.logoAttachmentName.trim() : "";
  const matches = logoName ? (input.logoAttachments ?? []).filter((item) => item.name.toLocaleLowerCase() === logoName.toLocaleLowerCase()) : [];
  if (logoName && (matches.length !== 1 || !input.persistLogo)) throw new Error("Requested logo attachment is unavailable or ambiguous");
  let business: Business;
  let alreadyExisted = false;
  const owned = await store.listUserBusinesses(auth);
  if (args.action === "create") {
    if (!profile.name) throw new Error("Business name is required");
    const existing = owned.filter((item) => item.name.toLocaleLowerCase() === profile.name!.toLocaleLowerCase());
    if (existing.length > 1) throw new Error("Business name is ambiguous");
    alreadyExisted = Boolean(existing[0]);
    if (input.createRequestKey) {
      business = existing[0]
        ? await store.updateUserBusiness(auth, existing[0].id, profile as Partial<BusinessInput>)
        : await store.createBusiness(auth, profile as BusinessInput, input.createRequestKey);
    } else {
      business = existing[0]
        ? await store.updateUserBusiness(auth, existing[0].id, profile as Partial<BusinessInput>)
        : await store.createBusiness(auth, profile as BusinessInput);
    }
  } else {
    const businessId = typeof args.businessId === "string" ? args.businessId : "";
    const target = businessId ? owned.find((item) => item.id === businessId) : owned.length === 1 ? owned[0] : undefined;
    if (!target) throw new Error("Owned Business Profile target is missing or ambiguous");
    alreadyExisted = true;
    business = await store.updateUserBusiness(auth, target.id, profile as Partial<BusinessInput>);
  }
  if (matches[0] && input.persistLogo && !business.logoFileId) business = await input.persistLogo(auth, business.id, matches[0]);
  if (args.goals !== undefined && !Array.isArray(args.goals)) throw new Error("Goals must be an array");
  if (args.memories !== undefined && !Array.isArray(args.memories)) throw new Error("Memories must be an array");
  const goals = Array.isArray(args.goals) ? args.goals as GoalInput[] : [];
  const memories = Array.isArray(args.memories) ? args.memories as MemoryInput[] : [];
  for (const goal of goals) {
    if (!goal || typeof goal.title !== "string" || !goal.title.trim()) throw new Error("Invalid dependent goal");
    if (Object.keys(goal).some((key) => !["title", "description", "priority", "status", "targetValue", "currentValue", "targetUnit", "targetDate"].includes(key))) throw new Error("Unsupported goal field");
    const existing = (await store.listGoals(auth, business.id)).find((item) => item.title.toLocaleLowerCase() === goal.title.trim().toLocaleLowerCase());
    if (existing) await store.updateGoal(auth, business.id, existing.id, goal);
    else await store.createGoal(auth, business.id, goal);
  }
  for (const memory of memories) {
    if (!memory || !memory.title?.trim() || !memory.content?.trim() || !memory.type) throw new Error("Invalid dependent memory");
    if (Object.keys(memory).some((key) => !["type", "title", "content", "confidence"].includes(key))) throw new Error("Unsupported memory field");
    if (memory.confidence !== undefined && (!Number.isFinite(memory.confidence) || memory.confidence < 0 || memory.confidence > 1)) throw new Error("Invalid memory confidence");
    const existing = (await store.listMemory(auth, business.id)).find((item) => item.title.toLocaleLowerCase() === memory.title.trim().toLocaleLowerCase());
    if (existing) await store.updateMemory(auth, business.id, existing.id, memory);
    else await store.createMemory(auth, business.id, { ...memory, source: "chat:business-profile" });
  }
  const verified = await store.getUserBusiness(auth, business.id);
  const missingFields = Object.entries(profile).filter(([key, value]) => String((verified as unknown as Record<string, unknown>)[key] ?? "") !== value).map(([key]) => key);
  const savedGoals = await store.listGoals(auth, business.id);
  const savedMemories = await store.listMemory(auth, business.id);
  const missingGoals = goals.filter((goal) => !savedGoals.some((item) => Object.entries(goal).every(([key, value]) => (item as unknown as Record<string, unknown>)[key] === value))).map((goal) => goal.title);
  const missingMemories = memories.filter((memory) => !savedMemories.some((item) => Object.entries(memory).every(([key, value]) => (item as unknown as Record<string, unknown>)[key] === value))).map((memory) => memory.title);
  const complete = !missingFields.length && !missingGoals.length && !missingMemories.length && (!logoName || Boolean(verified.logoFileId));
  return { complete, action: args.action as "create" | "update", alreadyExisted, businessId: business.id, businessName: business.name, savedFields: profile, goalIds: savedGoals.filter((item) => goals.some((goal) => goal.title.toLocaleLowerCase() === item.title.toLocaleLowerCase())).map((item) => item.id), memoryIds: savedMemories.filter((item) => memories.some((memory) => memory.title.toLocaleLowerCase() === item.title.toLocaleLowerCase() && memory.content === item.content)).map((item) => item.id), logoFileId: verified.logoFileId ?? null, goalTitles: savedGoals.filter((item) => goals.some((goal) => goal.title.toLocaleLowerCase() === item.title.toLocaleLowerCase())).map((item) => item.title), memoryFacts: savedMemories.filter((item) => memories.some((memory) => memory.title.toLocaleLowerCase() === item.title.toLocaleLowerCase())).map((item) => item.content), missingFields, missingGoals, missingMemories };
}
