import type { AuthContext, Business, BusinessInput, Goal, GoalInput, WorkspaceStore } from "@npati/workspace";

export interface BusinessActionDirective {
  action: "create" | "update" | "delete";
  businessId?: string;
  businessName?: string;
  profile?: {
    name?: string;
    businessType?: string;
    businessStage?: string;
    industry?: string;
    niche?: string;
    country?: string;
    market?: string;
    teamType?: string;
    presenceType?: string;
    businessModel?: string;
    website?: string;
    description?: string;
    productsServicesSummary?: string;
    audienceSummary?: string;
    legalName?: string;
    contactEmail?: string;
    contactPhone?: string;
    postalAddress?: string;
    registrationDetails?: string;
    logoAttachmentName?: string;
  };
}

export interface BusinessLogoAttachment {
  name: string;
  mimeType: string;
  data: Buffer;
  kind?: string;
}

export interface BusinessActionOptions {
  logoAttachments?: BusinessLogoAttachment[];
  persistBusinessLogo?: (context: AuthContext, businessId: string, attachment: BusinessLogoAttachment) => Promise<Business>;
}

export interface GoalActionDirective {
  action: "create" | "update" | "delete";
  businessId?: string;
  businessName?: string;
  goalId?: string;
  goal?: {
    title?: string;
    description?: string;
    priority?: number | string;
    status?: "active" | "completed" | "paused" | "cancelled";
    targetValue?: number | string;
    currentValue?: number | string;
    targetUnit?: string;
    targetDate?: string;
  };
}

function normalizeBusinessStage(val?: string): "idea" | "starting" | "operating" | "growing" | "scaling" {
  const s = String(val || "").toLowerCase().trim();
  if (s.includes("idea") || s.includes("іде")) return "idea";
  if (s.includes("start") || s.includes("старт") || s.includes("запуск")) return "starting";
  if (s.includes("operat") || s.includes("діюч") || s.includes("робоч")) return "operating";
  if (s.includes("grow") || s.includes("рост") || s.includes("зрост")) return "growing";
  if (s.includes("scal") || s.includes("масштаб")) return "scaling";
  return "starting";
}

function normalizeTeamType(val?: string): "solo" | "team" {
  const s = String(val || "").toLowerCase().trim();
  if (s.includes("team") || s.includes("команд") || s.includes("партнер")) return "team";
  return "solo";
}

function normalizePresenceType(val?: string): "online" | "local" | "both" {
  const s = String(val || "").toLowerCase().trim();
  if (s.includes("both") || (s.includes("онлайн") && s.includes("локал")) || s.includes("обидва") || s.includes("гібрид")) return "both";
  if (s.includes("local") || s.includes("локал") || s.includes("офлайн") || s.includes("фізич")) return "local";
  return "online";
}

function normalizeGoalPriority(val?: unknown): number {
  if (val === 1 || val === "1" || String(val).toLowerCase().includes("high") || String(val).toLowerCase().includes("висок")) return 1;
  if (val === 3 || val === "3" || String(val).toLowerCase().includes("low") || String(val).toLowerCase().includes("низьк")) return 3;
  return 2;
}

function normalizeGoalStatus(val?: string): "active" | "completed" | "paused" | "cancelled" {
  const s = String(val || "").toLowerCase().trim();
  if (s.includes("complete") || s.includes("викон") || s.includes("досяг")) return "completed";
  if (s.includes("pause") || s.includes("пауз") || s.includes("зупин")) return "paused";
  if (s.includes("cancel") || s.includes("скас")) return "cancelled";
  return "active";
}

export class BusinessActionHandler {
  static buildSystemPrompt(
    userBusinesses: Business[],
    goalsByBusiness: Array<{ businessId: string; businessName: string; goals: Goal[] }> = []
  ): string {
    const businessList = userBusinesses.length > 0
      ? userBusinesses.map((b) => `- ID: "${b.id}", Name: "${b.name}", Stage: "${b.businessStage || 'starting'}", Industry: "${b.industry || '-'}", Niche: "${b.niche || '-'}", Legal name: "${b.legalName || '-'}", Contact email: "${b.contactEmail || '-'}", Contact phone: "${b.contactPhone || '-'}", Postal address: "${b.postalAddress || '-'}", Logo file ID present: ${Boolean(b.logoFileId)}`).join("\n")
      : "(No existing business profiles for this user yet)";

    const goalsList = goalsByBusiness.length > 0 && goalsByBusiness.some((entry) => entry.goals.length > 0)
      ? goalsByBusiness
          .flatMap((entry) =>
            entry.goals.map(
              (g) =>
                `- [Business: "${entry.businessName}", BusinessID: "${entry.businessId}"] Goal ID: "${g.id}", Title: "${g.title}", Status: "${g.status}", Priority: P${g.priority}${g.targetValue ? `, Target: ${g.currentValue ?? 0}/${g.targetValue} ${g.targetUnit || ''}` : ''}${g.targetDate ? `, Due: ${g.targetDate.slice(0, 10)}` : ''}`
            )
          )
          .join("\n")
      : "(No existing goals for this user yet)";

    return `\n\nCRITICAL BUSINESS PROFILE & GOAL MANAGEMENT RULES:
You have native, automated capabilities to CREATE, EDIT, and DELETE both Business Profiles AND Goals directly in the user's workspace.
When you output a \`\`\`business-action\`\`\` or \`\`\`goal-action\`\`\` code block, the platform's backend engine immediately intercepts it and executes the actual database write/update/delete.
THEREFORE:
- NEVER state that you cannot edit settings, cannot save changes, cannot delete items, lack tools, or lack access. You DO have write and delete access through these directive blocks.
- Whenever the user asks to create, edit, or delete a business idea or goal, you MUST output the corresponding directive block.
- A long structured request headed by Business Profile creation remains one business-creation task. Populate every supplied applicable field first, then complete requested goals and memory linked to that Business Profile. Never treat a secondary memory or goal write as completion of the primary business request.
- Always confirm to the user that their business or goal has been recorded, updated, or deleted in the system.

USER'S CURRENT BUSINESSES (YOU CAN ONLY ACCESS, MODIFY OR DELETE THESE):
${businessList}

USER'S EXISTING GOALS:
${goalsList}

USER ISOLATION & SECURITY:
- You are STRICTLY RESTRICTED to accessing, creating, modifying, or deleting businesses and goals belonging to this authenticated user.
- Goals MUST ALWAYS be linked to a business owned by this user (via businessId or businessName).
- Never access, modify, or delete any other user's business or goal.

==================================================
STEP 1 - BUSINESS PROFILE (CREATION, EDITING & DELETION):
==================================================
When the user asks to create or edit a business idea:
1. Formulate the relevant profile fields:
   - name: Distinctive business name
   - businessType: User-supplied business type or category
   - businessStage: "idea" | "starting" | "operating" | "growing" | "scaling"
   - industry: e.g. E-commerce, Консалтинг, HoReCa, IT / SaaS, тощо.
   - niche: Precise market niche
   - country: Primary country (e.g. Україна)
   - market: "Local", "National", "Global", тощо.
   - teamType: "solo" | "team"
   - presenceType: "online" | "local" | "both"
   - businessModel: Business model & monetization
   - website: URL or https://...
   - description: What does the business do? Value proposition.
   - productsServicesSummary: Core products or services
   - audienceSummary: Target audience, customer pain points
   - legalName: Registered legal company name
   - contactEmail: Public business contact email
   - contactPhone: Public business contact phone
   - postalAddress: Company postal address
   - registrationDetails: User-supplied registration numbers, tax details, or filing notes. Never invent legal identifiers.
   - logoAttachmentName: exact filename of a PNG, JPEG, or WebP image attached to the latest user message. Never invent or accept a logoFileId.
For an update, include only fields the user explicitly supplied or asked to change. Never guess legal or contact details.

2. Emit an executable directive at the end of your message:
\`\`\`business-action
{
  "action": "create",
  "profile": {
    "name": "...",
    "businessStage": "idea",
    "industry": "...",
    "niche": "...",
    "country": "...",
    "market": "...",
    "teamType": "team",
    "presenceType": "both",
    "businessModel": "...",
    "website": "https://...",
    "description": "...",
    "productsServicesSummary": "...",
    "audienceSummary": "...",
    "legalName": "...",
    "contactEmail": "company@example.com",
    "contactPhone": "+380...",
    "postalAddress": "...",
    "logoAttachmentName": "company-logo.png"
  }
}
\`\`\`
(For editing an existing business: use "action": "update", "businessId": "<ID-from-list-above>", and provide updated fields).

3. Wrap the summary in an interactive card:
\`\`\`card:Бізнес-профіль: <Назва>
**Назва бізнесу:** <Назва>
**Стадія:** <Стадія>
**Галузь:** <Галузь>
**Ніша:** <Ніша>
**Країна:** <Країна>
**Ринок:** <Ринок>
**Команда:** <Команда>
**Присутність:** <Присутність>
**Бізнес-модель:** <Бізнес-модель>
**Вебсайт:** <Вебсайт>

### Чим займається бізнес
<Опис>

### Продукти або послуги
<Продукти/послуги>

### Цільова аудиторія
<Цільова аудиторія>

[Відкрити в налаштуваннях бізнесу →](/settings/business/{{businessId}})
\`\`\`

4. DELETING A BUSINESS IDEA:
When the user asks to delete, remove, or erase a business idea (e.g., "видали бізнес", "видали бізнес-ідею <назва>", "видалити цей бізнес", "delete business", etc.):
Identify the target business by ID or name from the list above. Emit an executable delete directive at the end of your message:
\`\`\`business-action
{
  "action": "delete",
  "businessId": "<ID-from-list-above>",
  "businessName": "<Name of business>"
}
\`\`\`
Confirm clearly in your message that the business idea and its related data have been deleted from their workspace. Do not include an interactive card when deleting.

5. AFTER CREATING A BUSINESS:
Proactively prompt the user for **Крок 2 (Step 2)**: setting measurable Goals & Objectives for this business! (e.g. 'Наступний крок 2: давай визначимо конкретну ціль для цього бізнесу (наприклад, залучити перших 50 клієнтів або запустити сайт за 30 днів). Яку ціль поставимо?'). If the user already specified their goal in their request, create the business AND the goal immediately!

==================================================
STEP 2 - GOALS & OBJECTIVES (CREATION, EDITING & DELETION):
Business Goals currently have no agent-assignment field or assignment API. If the user asks to assign a Goal to a Company agent, explain this limitation in the user's language; do not emit a fake assignment directive or claim an assignee was saved. Preserve the Goal and its Business link. Delegating a Company task is a separate operation and does not create a Goal assignee.
==================================================
When the user asks to create, add, or edit a Goal (e.g., "поставити ціль", "створи ціль", "додай ціль", "зміни ціль", "відредагуй ціль", "познач ціль як виконану", etc.):
1. Each goal belongs to a business. Determine the target business from context, name, or businessId (if none specified, use the user's active/latest business).
2. Formulate the goal fields:
   - title: Clear, action-oriented milestone title (e.g., "Залучити перших 50 платних клієнтів")
   - description: Success criteria and what success looks like
   - priority: 1 (High P1) | 2 (Normal P2) | 3 (Low P3)
   - status: "active" | "completed" | "paused" | "cancelled"
   - targetValue: Numeric metric target (optional, e.g. 50, 100, 100000)
   - currentValue: Numeric metric current progress (optional, e.g. 0)
   - targetUnit: Metric unit (e.g. "клієнтів", "грн", "замовлень", "користувачів", "$")
   - targetDate: Target deadline in format YYYY-MM-DD (optional)

3. Emit an executable directive at the end of your response:
\`\`\`goal-action
{
  "action": "create",
  "businessId": "<ID or name of business>",
  "goal": {
    "title": "...",
    "description": "...",
    "priority": 2,
    "status": "active",
    "targetValue": 50,
    "currentValue": 0,
    "targetUnit": "клієнтів",
    "targetDate": "2026-11-30"
  }
}
\`\`\`
(For editing an existing goal: use "action": "update", "businessId": "<ID>", "goalId": "<ID or title of goal>", "goal": { ...changed fields... }).

4. DELETING A GOAL:
When the user asks to delete or remove a Goal (e.g., "видали ціль", "видалити ціль <назва>", "зняти ціль", "delete goal", etc.):
Identify the target business and target goal by ID or title. If the user refers to a goal without a title and exactly one owned goal exists across all businesses, use that goal's exact ID and business ID. If several goals could match, ask which one. Emit an executable delete directive at the end of your response:
\`\`\`goal-action
{
  "action": "delete",
  "businessId": "<ID or name of business>",
  "goalId": "<ID or title of goal>"
}
\`\`\`
Confirm clearly in your message that the goal has been deleted. Do not include an interactive card when deleting.

5. Wrap active/created goal summary in an interactive card:
\`\`\`card:Ціль: <Назва цілі>
**Ціль:** <Назва цілі>
**Бізнес:** <Назва бізнесу>
**Опис / Критерії успіху:** <Опис>
**Пріоритет:** <P1 (Високий) | P2 (Нормальний) | P3 (Низький)>
**Статус:** <Активна | Виконана | Призупинена>
**Цільовий показник:** <currentValue> / <targetValue> <targetUnit>
**Дедлайн:** <targetDate>

[Відкрити в цілях бізнесу →](/settings/goals)
\`\`\`

You can emit BOTH \`\`\`business-action\`\`\` and \`\`\`goal-action\`\`\` in the same turn if the user requested to create both the idea and the goal simultaneously!`;
  }

  static async extractAndExecute(
    auth: AuthContext,
    text: string,
    workspaceStore: WorkspaceStore,
    log?: { warn(obj: unknown, msg?: string): void },
    beforeDeleteBusiness?: (context: AuthContext, businessId: string) => Promise<void>,
    options: BusinessActionOptions = {}
  ): Promise<{
    cleanText: string;
    businessAction?: { action: "create" | "update" | "delete"; business?: Business; businessId?: string };
    goalAction?: { action: "create" | "update" | "delete"; goal?: Goal; goalId?: string; businessName?: string };
  }> {
    let currentText = text;
    let businessAction: { action: "create" | "update" | "delete"; business?: Business; businessId?: string } | undefined;
    let goalAction: { action: "create" | "update" | "delete"; goal?: Goal; goalId?: string; businessName?: string } | undefined;

    // 1. Process business-action if present
    const bMatch = currentText.match(/```(?:business-action|business-profile)\s*([\s\S]*?)```/i);
    if (bMatch && bMatch[1]) {
      const rawBlock = bMatch[0];
      try {
        const directive = JSON.parse(bMatch[1].trim()) as BusinessActionDirective;
        if (directive && (directive.action === "create" || directive.action === "update" || directive.action === "delete")) {
          if (directive.action === "delete") {
            const userBusinesses = await workspaceStore.listUserBusinesses(auth);
            let targetId = directive.businessId?.trim();
            let targetBusiness: Business | undefined;

            if (targetId) {
              targetBusiness = userBusinesses.find((b) => b.id === targetId);
              if (!targetBusiness) throw new Error(`Business "${targetId}" not found or not owned by user.`);
            } else {
              const searchName = (directive.businessName || (directive.profile as any)?.name || "").toLowerCase().trim();
              if (searchName) {
                targetBusiness = userBusinesses.find(
                  (b) => b.name.toLowerCase() === searchName ||
                         b.name.toLowerCase().includes(searchName) ||
                         searchName.includes(b.name.toLowerCase())
                );
              }
              if (!targetBusiness && !searchName && userBusinesses.length === 1) {
                targetBusiness = userBusinesses[0];
              }
            }

            if (!targetBusiness) {
              throw new Error(`Business "${directive.businessName || directive.businessId || ""}" not found or not owned by user.`);
            }

            if (beforeDeleteBusiness) {
              await beforeDeleteBusiness(auth, targetBusiness.id).catch((err) => log?.warn({ err }, "beforeDeleteBusiness error"));
            }
            await workspaceStore.deleteBusiness(auth, targetBusiness.id);

            businessAction = { action: "delete", business: targetBusiness, businessId: targetBusiness.id };
            currentText = currentText.replace(rawBlock, "").trim();
          } else {
            const p = directive.profile || {};
            const name = String(p.name || directive.businessName || "").trim() || "Нова бізнес-ідея";

            const logoName = p.logoAttachmentName?.trim();
            const logoAttachment = logoName
              ? options.logoAttachments?.filter((item) => item.name.toLocaleLowerCase() === logoName.toLocaleLowerCase())
              : undefined;
            if (logoName && (!options.persistBusinessLogo || logoAttachment?.length !== 1)) {
              throw new Error("The requested logo attachment is missing or ambiguous");
            }
            if (p.contactEmail !== undefined) {
              const email = String(p.contactEmail).trim();
              if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid business contact email");
            }
            const input: Partial<BusinessInput> = {
              ...(directive.action === "create" || p.name !== undefined ? { name } : {}),
              ...(directive.action === "create" || p.businessStage !== undefined ? { businessStage: normalizeBusinessStage(p.businessStage) } : {}),
              businessType: p.businessType ? String(p.businessType).trim() : undefined,
              industry: p.industry ? String(p.industry).trim() : undefined,
              niche: p.niche ? String(p.niche).trim() : undefined,
              country: p.country ? String(p.country).trim() : undefined,
              market: p.market ? String(p.market).trim() : undefined,
              ...(directive.action === "create" || p.teamType !== undefined ? { teamType: normalizeTeamType(p.teamType) } : {}),
              ...(directive.action === "create" || p.presenceType !== undefined ? { presenceType: normalizePresenceType(p.presenceType) } : {}),
              businessModel: p.businessModel ? String(p.businessModel).trim() : undefined,
              website: p.website ? String(p.website).trim() : undefined,
              description: p.description ? String(p.description).trim() : undefined,
              productsServicesSummary: p.productsServicesSummary ? String(p.productsServicesSummary).trim() : undefined,
              audienceSummary: p.audienceSummary ? String(p.audienceSummary).trim() : undefined,
              ...(p.legalName !== undefined ? { legalName: String(p.legalName).trim().slice(0, 300) } : {}),
              ...(p.contactEmail !== undefined ? { contactEmail: String(p.contactEmail).trim().slice(0, 320) } : {}),
              ...(p.contactPhone !== undefined ? { contactPhone: String(p.contactPhone).trim().slice(0, 100) } : {}),
              ...(p.postalAddress !== undefined ? { postalAddress: String(p.postalAddress).trim().slice(0, 1000) } : {}),
              ...(p.registrationDetails !== undefined ? { registrationDetails: String(p.registrationDetails).trim() } : {}),
            };

            let business: Business;
            if (directive.action === "create") {
              business = await workspaceStore.createBusiness(auth, input as BusinessInput);
            } else {
              const userBusinesses = await workspaceStore.listUserBusinesses(auth);
              let targetId = directive.businessId?.trim();
              if (targetId && !userBusinesses.some((b) => b.id === targetId)) {
                throw new Error(`Business "${targetId}" not found or not owned by user.`);
              }
              if (!targetId) {
                const matched = userBusinesses.find(
                  (b) => b.name.toLowerCase() === name.toLowerCase() ||
                         (directive.businessName && b.name.toLowerCase() === directive.businessName.toLowerCase())
                );
                if (matched) targetId = matched.id;
                else if (!directive.businessName && p.name === undefined && userBusinesses.length === 1) targetId = userBusinesses[0]!.id;
                else throw new Error(`Business "${name}" not found or not owned by user.`);
              }
              business = await workspaceStore.updateUserBusiness(auth, targetId, input);
            }
            if (logoName && logoAttachment?.[0] && options.persistBusinessLogo) {
              business = await options.persistBusinessLogo(auth, business.id, logoAttachment[0]);
            }

            businessAction = { action: directive.action, business, businessId: business.id };
            currentText = currentText.replace(rawBlock, "").trim();
            currentText = currentText.replace(/\{\{businessId\}\}/g, business.id);
          }
        }
      } catch (err) {
        log?.warn({ err }, "Failed to execute business action");
        currentText = currentText.replace(rawBlock, "").trim();
      }
    }

    // 2. Process goal-action if present
    const gMatch = currentText.match(/```(?:goal-action|goal-profile)\s*([\s\S]*?)```/i);
    if (gMatch && gMatch[1]) {
      const rawBlock = gMatch[0];
      try {
        const directive = JSON.parse(gMatch[1].trim()) as GoalActionDirective;
        if (directive && (directive.action === "create" || directive.action === "update" || directive.action === "delete")) {
          // Determine target business
          const userBusinesses = await workspaceStore.listUserBusinesses(auth);
          let targetBusinessId = directive.businessId?.trim();
          if (directive.action === "delete" && !targetBusinessId && !directive.businessName && !businessAction?.business) {
            const ownedGoals = await workspaceStore.listUserGoals(auth);
            const requested = (directive.goal?.title || directive.goalId || "").toLocaleLowerCase().trim();
            const matches = requested
              ? ownedGoals.filter((goal) => goal.id.toLocaleLowerCase() === requested || goal.title.toLocaleLowerCase() === requested)
              : ownedGoals.length === 1 ? ownedGoals : [];
            if (matches.length !== 1) throw new Error("Goal target is missing or ambiguous");
            targetBusinessId = matches[0]!.businessId;
          }

          if (targetBusinessId === "{{businessId}}" && businessAction?.business) {
            targetBusinessId = businessAction.business.id;
          } else if (targetBusinessId && !userBusinesses.some((b) => b.id === targetBusinessId)) {
            // Check if matches by name
            const matched = userBusinesses.find(
              (b) => b.name.toLowerCase() === targetBusinessId!.toLowerCase() ||
                     (directive.businessName && b.name.toLowerCase() === directive.businessName.toLowerCase())
            );
            if (matched) targetBusinessId = matched.id;
            else if (directive.action === "delete") throw new Error("Target business not found for goal");
            else if (businessAction?.business) targetBusinessId = businessAction.business.id;
            else if (userBusinesses.length > 0) targetBusinessId = userBusinesses[0]!.id;
            else throw new Error("No available business found to link this goal to.");
          } else if (!targetBusinessId) {
            if (directive.businessName) {
              const matched = userBusinesses.find(
                (b) => b.name.toLowerCase() === directive.businessName!.toLowerCase()
              );
              targetBusinessId = matched ? matched.id : directive.action === "delete" ? undefined : (businessAction?.business?.id || userBusinesses[0]?.id);
            } else if (businessAction?.business) {
              targetBusinessId = businessAction.business.id;
            } else if (userBusinesses.length > 0) {
              targetBusinessId = userBusinesses[0]!.id;
            } else {
              throw new Error("No business available to attach goal to.");
            }
          }

          if (!targetBusinessId) throw new Error("Target business not found for goal.");

          // Validate ownership
          const targetBusiness = await workspaceStore.getUserBusiness(auth, targetBusinessId);

          if (directive.action === "delete") {
            const existingGoals = await workspaceStore.listGoals(auth, targetBusinessId);
            let targetGoalId = directive.goalId?.trim();
            const searchTitle = (directive.goal?.title || targetGoalId || "").toLowerCase().trim();
            let targetGoal: Goal | undefined;

            if (targetGoalId && existingGoals.some((eg) => eg.id === targetGoalId)) {
              targetGoal = existingGoals.find((eg) => eg.id === targetGoalId);
            } else if (searchTitle) {
              const exact = existingGoals.filter((goal) => goal.title.toLowerCase() === searchTitle);
              const partial = existingGoals.filter((goal) => goal.title.toLowerCase().includes(searchTitle) || searchTitle.includes(goal.title.toLowerCase()));
              targetGoal = (exact.length === 1 ? exact : partial.length === 1 ? partial : [])[0];
            }
            if (!targetGoal && !searchTitle && existingGoals.length === 1) {
              targetGoal = existingGoals[0];
            }

            if (!targetGoal) {
              throw new Error(`Goal "${searchTitle || directive.goalId}" not found for business "${targetBusiness.name}".`);
            }

            await workspaceStore.deleteGoal(auth, targetBusinessId, targetGoal.id);
            goalAction = { action: "delete", goal: targetGoal, goalId: targetGoal.id, businessName: targetBusiness.name };
            currentText = currentText.replace(rawBlock, "").trim();
          } else {
            const g = directive.goal || {};
            const title = String(g.title || "").trim();
            if ((directive.action === "create" || g.title !== undefined) && !title) throw new Error("Goal title is required");

            const goalInput: Partial<GoalInput> = {
              ...(title ? { title } : {}),
              ...(g.description !== undefined ? { description: String(g.description).trim() } : {}),
              ...(g.priority !== undefined ? { priority: normalizeGoalPriority(g.priority) } : {}),
              ...(g.status !== undefined ? { status: normalizeGoalStatus(g.status) } : {}),
              ...(g.targetValue !== undefined && g.targetValue !== null && g.targetValue !== "" ? { targetValue: Number(g.targetValue) } : {}),
              ...(g.currentValue !== undefined && g.currentValue !== null && g.currentValue !== "" ? { currentValue: Number(g.currentValue) } : {}),
              ...(g.targetUnit !== undefined ? { targetUnit: String(g.targetUnit).trim() } : {}),
              ...(g.targetDate !== undefined ? { targetDate: String(g.targetDate).trim() } : {}),
            };

            let goal: Goal;
            if (directive.action === "create") {
              goal = await workspaceStore.createGoal(auth, targetBusinessId, { ...goalInput, title });
            } else {
              // Update existing goal
              const existingGoals = await workspaceStore.listGoals(auth, targetBusinessId);
              const requested = directive.goalId?.trim() || title;
              const exact = existingGoals.filter(item => item.id === requested || item.title.toLowerCase() === requested.toLowerCase());
              const target = exact.length === 1 ? exact[0] : !requested && existingGoals.length === 1 ? existingGoals[0] : undefined;
              if (!target) throw new Error("Goal target is missing or ambiguous for the selected Business");
              const targetGoalId = target.id;
              goal = await workspaceStore.updateGoal(auth, targetBusinessId, targetGoalId, goalInput);
            }

            goalAction = { action: directive.action, goal, goalId: goal.id, businessName: targetBusiness.name };
            currentText = currentText.replace(rawBlock, "").trim();
          }
        }
      } catch (err) {
        log?.warn({ err }, "Failed to execute goal action");
        currentText = currentText.replace(rawBlock, "").trim();
      }
    }

    // Clean up any stray placeholders
    if (businessAction?.business) {
      currentText = currentText.replace(/\{\{businessId\}\}/g, businessAction.business.id);
    }

    return {
      cleanText: currentText,
      businessAction,
      goalAction,
    };
  }
}
