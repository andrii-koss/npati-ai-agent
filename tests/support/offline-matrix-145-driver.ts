import { managedWorkspaceBaseResolver } from "../../apps/agent-api/src/workspace-base-resolver";
import fs from "node:fs";
import path from "node:path";
import type { AIEngine, ChatRequest, ChatResult, ChatToolCall } from "@npati/omniroute-adapter";
import type { WebResearchService, ResearchOutcome, ResearchProgressListener } from "@npati/web-research";
import type { AuthContext, InMemoryWorkspaceStore, Project } from "@npati/workspace";
import { SUPPORTED_PROJECT_FRAMEWORKS, type ProjectIntentDecision } from "@npati/shared";

export interface MatrixAction {
  id: string;
  chat: string;
  area: string;
  language: string;
  prompt: string;
  confirm?: boolean;
  document?: boolean;
  expect: Record<string, any>;
}

export interface DataTableState {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface ProjectDataState {
  tables: Record<string, DataTableState>;
  foreignKey: boolean;
}

export function createOfflineMatrixDriver(input: {
  tag: string;
  store: InMemoryWorkspaceStore;
  tempDir: string;
  auth: AuthContext;
}) {
  const { tag, store, tempDir, auth } = input;
  const cBakery = `Stress ${tag} Bakery`;
  const cStudio = `Stress ${tag} Studio`;
  const cUniversal = `Stress ${tag} Universal`;
  const bName = `Stress ${tag} Business`;
  const pNext = `Stress ${tag} Next Shop`;
  const pVite = `Stress ${tag} Vite`;
  const pAstro = `Stress ${tag} Astro`;
  const gLaunch = `Stress ${tag} Launch`;
  const gTemp = `Stress ${tag} Temp Goal`;
  const mRecipe = `Stress ${tag} Recipe`;
  const mDelivery = `Stress ${tag} Delivery`;
  const aWeekly = `Stress ${tag} Weekly`;
  const aWeeklyRev = `${aWeekly} Revised`;
  const hHook = `Stress ${tag} Hook`;
  const mailAddr = `stress-${tag.toLowerCase()}@npati.test`;
  const tReply = `Stress ${tag} Reply`;
  const cStrategy = `Stress ${tag} Strategy`;

  let currentAction: MatrixAction | null = null;
  let currentTurn = 0;
  let llmCalls = 0;
  const dataStudio = new Map<string, ProjectDataState>();
  const pageState = new Map<string, Record<string, string>>();

  function setAction(action: MatrixAction, turn = 0) {
    currentAction = action;
    currentTurn = turn;
  }

  function ensureDataState(projectName: string): ProjectDataState {
    let state = dataStudio.get(projectName);
    if (!state) {
      state = { tables: {}, foreignKey: false };
      dataStudio.set(projectName, state);
    }
    return state;
  }

  function writeProjectFiles(companyId: string, projectId: string, files: Record<string, string>) {
    const root = managedWorkspaceBaseResolver(path.join(tempDir, "project-workspaces")).managedBase(companyId, projectId);
    fs.mkdirSync(root, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
  }

  function readProjectFiles(companyId: string, projectId: string): Record<string, string> {
    const root = managedWorkspaceBaseResolver(path.join(tempDir, "project-workspaces")).managedBase(companyId, projectId);
    if (!fs.existsSync(root)) return {};
    const out: Record<string, string> = {};
    const walk = (dir: string, prefix = "") => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else out[rel] = fs.readFileSync(path.join(dir, entry.name), "utf8");
      }
    };
    walk(root);
    return out;
  }

  async function findCompanyByName(name: string) {
    let cursor: string | undefined;
    do {
      const page = await store.listCompanies(auth, 100, cursor);
      const found = page.items.find((c) => c.name === name);
      if (found) return found;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return undefined;
  }

  async function findBusinessByName(name: string) {
    const list = await store.listUserBusinesses(auth);
    return list.find((b) => b.name === name);
  }

  function classifyCurrentAction(action: MatrixAction) {
    const id = action.id;
    const base = {
      intent: "CHAT",
      confidence: 0.99,
      targets: [] as Array<Record<string, unknown>>,
      entityRead: null as Record<string, string> | null,
      coreCapability: null as string | null,
      coreMutation: false,
      assignsWorkToCompanyAgent: false,
      externalResearch: false,
      reply: null as string | null,
      format: "none",
    };

    if (["A001", "A005", "A016", "A033", "A066", "A078", "A095"].includes(id)) {
      return { ...base, coreCapability: "npati_company_action", coreMutation: true };
    }
    if (["A002", "A017", "A067"].includes(id)) {
      return { ...base, coreCapability: "npati_business_profile", coreMutation: true };
    }
    if (["A004", "A010", "A022", "A039", "A054", "A070", "A081", "A094"].includes(id)) {
      return { ...base, coreCapability: "npati_goal_action", coreMutation: true };
    }
    if (["A003", "A012", "A014", "A019", "A023", "A034", "A035", "A043", "A053", "A060", "A061", "A072", "A077", "A084", "A086", "A088", "A093"].includes(id)) {
      return { ...base, coreCapability: "npati_workspace_action", coreMutation: true };
    }
    if (["A008", "A018", "A038", "A045", "A056", "A064", "A082"].includes(id)) {
      return { ...base, coreCapability: "npati_email_action", coreMutation: true };
    }
    if (["A007", "A055", "B005"].includes(id)) {
      return { ...base, externalResearch: true };
    }
    if (["A041", "A075"].includes(id)) {
      return { ...base, assignsWorkToCompanyAgent: true };
    }
    if (["A025", "A058"].includes(id)) {
      return { ...base, coreCapability: "npati_company_action", coreMutation: false };
    }
    if (["A011", "A020", "A026", "A028", "A042", "A046", "A062", "A074", "A097", "A099"].includes(id)) {
      return { ...base, coreCapability: "npati_workspace_action", coreMutation: false };
    }
    if (["A032", "A071"].includes(id)) {
      return { ...base, coreCapability: "npati_email_action", coreMutation: false };
    }
    if (["A049", "A083"].includes(id)) {
      return { ...base, coreCapability: "npati_business_profile", coreMutation: false };
    }
    if (["A091", "P040", "P030"].includes(id)) {
      return base;
    }
    if (id === "P012") return { ...base, intent: "PREVIEW_PROJECT" };
    if (id === "P013") return { ...base, intent: "REVIEW_PROJECT" };
    if (id === "P035") {
      return {
        ...base,
        intent: "CREATE_PROJECT",
        targets: [
          { name: "V3 Switch Site", kind: "website", framework: "HTML/CSS", reason: "Static site", criteria: ["html"] },
          { name: "V3 Switch Game", kind: "game", framework: "HTML/CSS", reason: "Canvas game", criteria: ["game"] },
          { name: "V3 Switch Mobile", kind: "mobile_app", framework: "Expo", reason: "Mobile app", criteria: ["expo"] },
        ],
      };
    }

    const createMap: Record<string, { name: string; kind: string; framework: string }> = {
      A006: { name: pNext, kind: "store", framework: "Next.js" },
      A027: { name: pVite, kind: "website", framework: "React + Vite" },
      A044: { name: pAstro, kind: "website", framework: "Astro" },
      P001: { name: "V3 HTML", kind: "website", framework: "HTML/CSS" },
      P002: { name: "V3 React", kind: "website", framework: "React + Vite" },
      P003: { name: "V3 Shop", kind: "store", framework: "Next.js" },
      P004: { name: "V3 Pages", kind: "website", framework: "HTML/CSS" },
      P009: { name: "V3 Snake", kind: "game", framework: "HTML/CSS" },
      P010: { name: "V3 TicTacToe", kind: "game", framework: "React + Vite" },
      P011: { name: "V3 Phaser", kind: "game", framework: "HTML/CSS" },
      P017: { name: "V3 Pygame", kind: "game", framework: "Pygame" },
      P021: { name: "V3 Expo Tasks", kind: "mobile_app", framework: "Expo" },
      P022: { name: "V3 Flutter", kind: "mobile_app", framework: "Flutter" },
      P023: { name: "V3 Android Notes", kind: "mobile_app", framework: "Expo" },
      P031: { name: "V3 Node API", kind: "api", framework: "Express" },
      P032: { name: "V3 FastAPI", kind: "api", framework: "FastAPI" },
    };
    if (createMap[id]) {
      const t = createMap[id]!;
      const framework = (SUPPORTED_PROJECT_FRAMEWORKS as readonly string[]).includes(t.framework) ? t.framework : "HTML/CSS";
      return {
        ...base,
        intent: "CREATE_WEBSITE",
        targets: [{ name: t.name, kind: t.kind, framework, reason: "Requested by user", criteria: ["explicit"] }],
      };
    }
    if (action.area === "coding" || action.area === "data" || id.startsWith("P")) {
      return { ...base, intent: "EDIT_WEBSITE" };
    }
    return base;
  }

  async function buildToolCallForAction(action: MatrixAction): Promise<ChatToolCall | null> {
    const id = action.id;
    const call = (name: string, args: Record<string, unknown>): ChatToolCall => ({
      id: `call-${id}-${currentTurn}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });

    const bakery = await findCompanyByName(cBakery);
    const studio = await findCompanyByName(cStudio);
    const biz = await findBusinessByName(bName);

    switch (id) {
      case "A001":
        return call("npati_company_action", {
          action: "create",
          fields: { name: cBakery, industry: "Craft Bakery", description: "Лише тестові дані STRESS_BAKERY, Київ." },
          agents: [
            { action: "create", fields: { name: "Lead", role: "Coordinator", systemInstruction: "Координує роботу пекарні." }, main: true },
            { action: "create", fields: { name: "Researcher", role: "Market Researcher", systemInstruction: "Досліджує відкриті джерела." }, parentAgentName: "Lead" },
          ],
          mainAgentName: "Lead",
        });
      case "A002":
        return call("npati_business_profile", {
          action: "create",
          profile: {
            name: bName,
            businessStage: "operating",
            market: "Kyiv",
            country: "Ukraine",
            productsServicesSummary: "sourdough bread and coffee",
            audienceSummary: "local families",
          },
        });
      case "A003":
        return call("npati_workspace_action", {
          action: "memory.create",
          businessId: biz?.id,
          businessName: bName,
          memory: { type: "product", title: mRecipe, content: "Код рецепта RECIPE_LIME_731, без арахісу." },
        });
      case "A004":
        return call("npati_goal_action", {
          action: "create",
          businessId: biz?.id ?? "",
          goal: { title: gLaunch, description: "Launch a real-data product catalog", priority: 2, status: "active" },
        });
      case "A005":
        return call("npati_company_action", {
          action: "update",
          companyId: bakery?.id,
          companyName: cBakery,
          fields: { brandTone: "acolhedor e profissional", description: "STRESS_BAKERY — tom acolhedor e profissional" },
        });
      case "A008":
        return call("npati_email_action", {
          action: "account.create",
          companyId: bakery?.id,
          fields: { emailAddress: mailAddr, displayName: "Stress Inbox", testMode: true },
        });
      case "A010": {
        const goals = biz ? await store.listGoals(auth, biz.id) : [];
        const g = goals.find((x) => x.title === gLaunch);
        return call("npati_goal_action", {
          action: "update",
          businessId: biz?.id ?? "",
          goalId: g?.id,
          goal: { title: gLaunch, description: "Catálogo con datos reales y navegación accesible" },
        });
      }
      case "A012":
        return call("npati_workspace_action", {
          action: "automation.create",
          companyId: bakery?.id,
          companyName: cBakery,
          automation: {
            name: aWeekly,
            cronExpression: "0 9 * * 1",
            timezone: "Europe/Kyiv",
            prompt: "Report STRESS_WEEKLY_OK without external actions",
            status: "paused",
          },
        });
      case "A014":
        return call("npati_workspace_action", {
          action: "webhook.create",
          companyId: bakery?.id,
          companyName: cBakery,
          webhook: { name: hHook, promptTemplate: "Summarize test payload as STRESS_HOOK_OK", isActive: false },
        });
      case "A016":
        return call("npati_company_action", {
          action: "create",
          fields: { name: cStudio, industry: "Design Studio", description: "STRESS_STUDIO" },
          agents: [
            { action: "create", fields: { name: "Designer", role: "Lead Designer", systemInstruction: "Lead design" }, main: true },
            { action: "create", fields: { name: "Reviewer", role: "QA Reviewer", systemInstruction: "Review quality" }, parentAgentName: "Designer" },
          ],
          mainAgentName: "Designer",
        });
      case "A017":
        return call("npati_business_profile", {
          action: "update",
          businessId: biz?.id,
          profile: { audienceSummary: "famílias locais e pequenos escritórios" },
        });
      case "A018":
        return call("npati_email_action", {
          action: "inbox.compose",
          companyId: bakery?.id,
          fields: {
            toAddresses: ["receiver@npati.test"],
            subject: "STRESS_ORDER_731",
            bodyText: "Please reserve one loaf. TEST ONLY.",
            isDraft: true,
          },
        });
      case "A019": {
        const mems = biz ? await store.listMemory(auth, biz.id) : [];
        const m = mems.find((x) => x.title === mRecipe);
        return call("npati_workspace_action", {
          action: "memory.update",
          businessId: biz?.id,
          memoryId: m?.id,
          memoryTitle: mRecipe,
          memory: { content: "Recipe code RECIPE_LIME_732; peanut-free; keep original history" },
        });
      }
      case "A022": {
        const goals = biz ? await store.listGoals(auth, biz.id) : [];
        const g = goals.find((x) => x.title === gLaunch);
        return call("npati_goal_action", {
          action: "update",
          businessId: biz?.id ?? "",
          goalId: g?.id,
          goal: { assignedAgent: "Lead", assignedCompany: cBakery },
        });
      }
      case "A023":
        return call("npati_workspace_action", {
          action: "automation.update",
          companyId: bakery?.id,
          automationName: aWeekly,
          automation: { cronExpression: "0 10 * * 2", status: "paused" },
        });
      case "A033":
        return call("npati_company_action", {
          action: "update",
          companyId: studio?.id,
          companyName: cStudio,
          agents: [
            { action: "create", fields: { name: "Accessibility Reviewer", role: "QA", systemInstruction: "Accessibility QA" }, parentAgentName: "Designer" },
          ],
        });
      case "A034":
        return call("npati_workspace_action", {
          action: "automation.run",
          companyId: bakery?.id,
          automationName: aWeekly,
        });
      case "A035":
        return call("npati_workspace_action", {
          action: "content.create",
          companyId: bakery?.id,
          businessId: biz?.id,
          content: {
            title: cStrategy,
            type: "strategy",
            task: "Strategy for audience (local families and small offices), offer (sourdough & coffee) and two measurable experiments.",
          },
        });
      case "A038":
        return call("npati_email_action", {
          action: "contact.upsert",
          companyId: bakery?.id,
          contactEmail: "spammer@npati.test",
          fields: { email: "spammer@npati.test", name: "Stress Spammer", isBlacklisted: true },
        });
      case "A039": {
        const goals = biz ? await store.listGoals(auth, biz.id) : [];
        const g = goals.find((x) => x.title === gLaunch);
        return call("npati_goal_action", {
          action: "update",
          businessId: biz?.id ?? "",
          goalId: g?.id,
          goal: { currentValue: 1, status: "active" },
        });
      }
      case "A043":
        return call("npati_workspace_action", {
          action: "webhook.update",
          companyId: bakery?.id,
          webhookName: hHook,
          webhook: { isActive: true },
        });
      case "A045":
        return call("npati_email_action", {
          action: "inbox.compose",
          companyId: bakery?.id,
          fields: {
            toAddresses: ["receiver@npati.test"],
            subject: "STRESS_ORDER_731",
            bodyText: "Please reserve one loaf. TEST ONLY.",
            isDraft: false,
          },
        });
      case "A053":
        return call("npati_workspace_action", {
          action: "webhook.update",
          companyId: bakery?.id,
          webhookName: hHook,
          webhook: { isActive: false },
        });
      case "A054": {
        const goals = biz ? await store.listGoals(auth, biz.id) : [];
        const g = goals.find((x) => x.title === gLaunch);
        return call("npati_goal_action", {
          action: "update",
          businessId: biz?.id ?? "",
          goalId: g?.id,
          goal: { priority: 1, description: "Catálogo con datos reales y navegación accesible; database updates must appear on the website" },
        });
      }
      case "A056":
        return call("npati_email_action", {
          action: "template.create",
          companyId: bakery?.id,
          fields: {
            title: tReply,
            category: "support",
            subjectTemplate: "Re: test order",
            bodyTemplate: "Thank you for the test order; no payment required.",
          },
        });
      case "A060":
        return call("npati_workspace_action", {
          action: "automation.update",
          companyId: bakery?.id,
          automationName: aWeekly,
          automation: { name: aWeeklyRev, status: "paused" },
        });
      case "A061":
        return call("npati_workspace_action", {
          action: "memory.create",
          businessId: biz?.id,
          businessName: bName,
          memory: { type: "business_fact", title: mDelivery, content: "Pickup window 10:00-14:00; code PICKUP_ORANGE_734" },
        });
      case "A064":
        return call("npati_email_action", {
          action: "template.update",
          companyId: bakery?.id,
          templateTitle: tReply,
          fields: { bodyTemplate: "Thank you for the test order; no payment required. Pickup: PICKUP_ORANGE_734" },
        });
      case "A066":
        return call("npati_company_action", {
          action: "update",
          companyId: studio?.id,
          companyName: cStudio,
          agents: [
            { action: "update", agentName: "Accessibility Reviewer", fields: { name: "Accessibility Reviewer", role: "Senior QA" }, parentAgentName: "Designer" },
          ],
        });
      case "A067":
        return call("npati_business_profile", {
          action: "update",
          businessId: biz?.id,
          profile: { productsServicesSummary: "sourdough bread, coffee, office catering" },
        });
      case "A070":
        return call("npati_goal_action", {
          action: "create",
          businessId: biz?.id ?? "",
          goal: { title: gTemp, description: "Disposable test", priority: 3, status: "active" },
        });
      case "A072":
        return call("npati_workspace_action", {
          action: "webhook.update",
          companyId: bakery?.id,
          webhookName: hHook,
          webhook: { isActive: false },
        });
      case "A077":
        return call("npati_workspace_action", {
          action: "automation.run",
          companyId: bakery?.id,
          automationName: aWeeklyRev,
        });
      case "A078":
        return call("npati_company_action", {
          action: "update",
          companyId: studio?.id,
          companyName: cStudio,
          agents: [{ action: "delete", agentName: "Accessibility Reviewer" }],
        });
      case "A081": {
        const goals = biz ? await store.listGoals(auth, biz.id) : [];
        const g = goals.find((x) => x.title === gTemp);
        return call("npati_goal_action", {
          action: "delete",
          businessId: biz?.id ?? "",
          goalId: g?.id,
        });
      }
      case "A082":
        return call("npati_email_action", {
          action: "template.delete",
          companyId: bakery?.id,
          templateTitle: tReply,
        });
      case "A084":
        return call("npati_workspace_action", {
          action: "webhook.delete",
          companyId: bakery?.id,
          webhookName: hHook,
        });
      case "A086": {
        const mems = biz ? await store.listMemory(auth, biz.id) : [];
        const m = mems.find((x) => x.title === mDelivery);
        return call("npati_workspace_action", {
          action: "memory.delete",
          businessId: biz?.id,
          memoryId: m?.id,
          memoryTitle: mDelivery,
        });
      }
      case "A088":
        return call("npati_workspace_action", {
          action: "automation.update",
          companyId: bakery?.id,
          automationName: aWeeklyRev,
          automation: { status: "paused" },
        });
      case "A093":
        return call("npati_workspace_action", {
          action: "automation.delete",
          companyId: bakery?.id,
          automationName: aWeeklyRev,
        });
      case "A094": {
        const goals = biz ? await store.listGoals(auth, biz.id) : [];
        const g = goals.find((x) => x.title === gLaunch);
        return call("npati_goal_action", {
          action: "update",
          businessId: biz?.id ?? "",
          goalId: g?.id,
          goal: { status: "completed", currentValue: 1 },
        });
      }
      case "A095":
        return call("npati_company_action", {
          action: "delete",
          companyId: studio?.id,
          companyName: cStudio,
        });
      default:
        return null;
    }
  }

  function buildAnswerForAction(action: MatrixAction): string {
    const id = action.id;
    switch (id) {
      case "A007":
        return "Навігація [Apple](https://www.apple.com) фокусується на категоріях продуктів, [Samsung](https://www.samsung.com) поєднує мега-меню з промо-блоками, а [Google Store](https://store.google.com) використовує мінімалістичну сітку з фільтрами. Для нашого магазину варто зробити 1) чітку шапку з каталогом і кошиком, 2) швидкий перехід до популярних хлібів і кави, 3) просту сторінку доставки та FAQ без перевантаження меню. Це дає прозору структуру навігації, зменшує кількість кліків до покупки та підтримує доступність з клавіатури.";
      case "A011":
        return "Der gespeicherte Rezeptcode lautet RECIPE_LIME_731.";
      case "A020":
        return `Activity & Run Trace для «${cBakery}»: останній запуск (run) завершено, фактичні інструменти виконані без помилок.`;
      case "A025":
        return `Active company switched to ${cStudio}. Agents: Designer, Reviewer.`;
      case "A026":
        return `${cStudio} has no private recipe memory of its own.`;
      case "A028":
        return `Webhook ${hHook} in ${cBakery} is currently inactive (false).`;
      case "A031":
        return "Segun el analisis anterior de Apple, Samsung y Google: observacion - navegacion limpia; recomendacion - menu directo al catalogo.";
      case "A032":
        return "Draft STRESS_ORDER_731 is addressed to receiver@npati.test.";
      case "A042":
        return "Актуальний код рецепта: RECIPE_LIME_732.";
      case "A046":
        return "Last execution of Stress Weekly returned STRESS_WEEKLY_OK with status completed and no failure.";
      case "A049":
        return "Das Profil hat den Markt Kyiv und die Zielgruppe Familien und kleine escritórios (Büro / office).";
      case "A050":
        return `Checkpoint saved: CHAT_A_LIME_731, company ${cBakery}, recipe RECIPE_LIME_732, product STRESS_PRODUCT_UPDATED_732. Unfinished goal: ${gLaunch}.`;
      case "B001":
        return "Checkpoint recorded for Chat B: CHAT_B_PLUM_642.";
      case "B002":
        return "Attachment inventory marker: FILE_TANGERINE_642, count: 17.";
      case "B003":
        return "Las observaciones describen hechos verificados, mientras que las recomendaciones proponen acciones futuras.";
      case "B004":
        return "Der Kontrollcode dieses Chats ist CHAT_B_PLUM_642.";
      case "B005":
        return "The page title of [Example Domain](https://example.com) is Example Domain.";
      case "A051":
        return "Контрольний код Chat A: CHAT_A_LIME_731, рецепт: RECIPE_LIME_732, товар: STRESS_PRODUCT_UPDATED_732.";
      case "A055":
        return "The page [Example Domain](https://example.com) has title Example Domain and serves as an illustrative documentation domain.";
      case "A058":
        return `Empresa activa: ${cBakery}. Su agente principal es Lead.`;
      case "A062":
        return `Activity & Run Trace for ${pNext}: no failed tool calls recorded (0 errors).`;
      case "A068":
        return "Aus der Analyse von Apple, Samsung und Google empfehlen wir eine klare Kopfzeile und einen direkten Link zum Katalog.";
      case "A071":
        return "Suspicious inbound email thread identified from spammer@npati.test.";
      case "A074":
        return "Los códigos actuales en la memoria son RECIPE_LIME_732 y PICKUP_ORANGE_734.";
      case "A083":
        return `Business ${bName} operates in Kyiv with sourdough bread, coffee, and office catering for local families and small offices.`;
      case "A089":
        return "The exact Chat A checkpoint is CHAT_A_LIME_731.";
      case "A090":
        return `Company ${cStudio} has project ${pVite} and agents Designer and Reviewer.`;
      case "A092":
        return `Project ${pVite} was deleted and no longer exists. No replacement project was selected.`;
      case "A096":
        return `Die Firma ${cStudio} wurde gelöscht und existiert nicht mehr.`;
      case "A097":
        return "Remaining memory recipe code: RECIPE_LIME_732.";
      case "A098":
        return "Fontes iniciais: apple.com, samsung.com, google.com. Aplicamos navegação direta para o catálogo.";
      case "A099":
        return `Підсумок Activity для «${cBakery}»: помилок немає, каталог активний, статус завдань перевірено.`;
      case "A100":
        return `Final summary: ${cBakery}, Business ${bName}, projects ${pNext} and ${pAstro}, recipe RECIPE_LIME_732, product STRESS_PRODUCT_UPDATED_732. ${cStudio} and ${pVite} were deleted.`;
      case "P030":
        return "Перевірка Sandbox toolchain: Android SDK, JDK, Gradle, Flutter SDK, Android emulator та iOS Xcode не встановлені (відсутні / unavailable) у цьому оточенні.";
      default:
        return `Completed ${id}: ${action.expect.name ?? action.expect.kind ?? "ok"}`;
    }
  }

  const aiEngine: AIEngine = {
    supportsNativeTools: () => true,
    async chat(request: ChatRequest): Promise<ChatResult> {
      llmCalls += 1;
      const action = currentAction;
      if (!action) return { content: "ok" };
      if (request.tools?.[0]?.function.name === "npati_classify_chat_intent") {
        const decision = classifyCurrentAction(action);
        return {
          content: "",
          toolCalls: [{ id: `route-${action.id}`, type: "function", function: { name: "npati_classify_chat_intent", arguments: JSON.stringify(decision) } }],
        };
      }
      const hasToolResult = request.messages.some((m) => m.role === "tool");
      if (request.tools?.length && !hasToolResult) {
        if (["A007", "A055", "B005"].includes(action.id)) {
          const url = action.id === "A007" ? "https://www.apple.com" : "https://example.com";
          return {
            content: "",
            toolCalls: [{ id: `fetch-${action.id}`, type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url, goal: action.prompt }) } }],
          };
        }
        const toolCall = await buildToolCallForAction(action);
        if (toolCall) return { content: "", toolCalls: [toolCall] };
      }
      return { content: buildAnswerForAction(action) };
    },
    async *stream(request: ChatRequest) {
      llmCalls += 1;
      yield currentAction ? buildAnswerForAction(currentAction) : "ok";
      void request;
    },
    listModels: async () => [],
    getModel: async () => undefined,
    executeTool: async () => undefined,
    searchMemory: async () => [],
    saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"],
    healthCheck: async () => ({ status: "ok" }),
  } as unknown as AIEngine;

  const webResearch: WebResearchService = {
    shouldResearch: (q: string) => /https?:\/\//i.test(q),
    async run(query: string, _opts?: unknown, _refresh?: boolean, progress?: ResearchProgressListener): Promise<ResearchOutcome> {
      const hosts = currentAction?.id === "A007"
        ? ["https://www.apple.com", "https://www.samsung.com", "https://store.google.com"]
        : ["https://example.com"];
      for (const url of hosts) {
        progress?.({ type: "page_fetch_started", url, domain: new URL(url).hostname, title: url });
        progress?.({ type: "page_fetch_completed", url, domain: new URL(url).hostname, title: url });
      }
      return {
        kind: "web_search",
        context: `Verified evidence for ${query}: Example Domain and navigation patterns for ${hosts.join(", ")}.`,
        sources: hosts.map((url) => ({ url, title: url.includes("example") ? "Example Domain" : url, accessedAt: "2026-01-01T00:00:00.000Z" })),
      };
    },
  } as unknown as WebResearchService;

  return {
    aiEngine,
    webResearch,
    setAction,
    getCurrentAction: () => currentAction,
    getLlmCalls: () => llmCalls,
    dataStudio,
    pageState,
    ensureDataState,
    writeProjectFiles,
    readProjectFiles,
    findCompanyByName,
    findBusinessByName,
    names: { cBakery, cStudio, cUniversal, bName, pNext, pVite, pAstro, gLaunch, gTemp, mRecipe, mDelivery, aWeekly, aWeeklyRev, hHook, mailAddr, tReply, cStrategy },
  };
}
export type OfflineMatrixDriver = ReturnType<typeof createOfflineMatrixDriver>;
export type { Project, ProjectIntentDecision };