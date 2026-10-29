export type ProjectIntent =
  | "CHAT"
  | "CREATE_PROJECT"
  | "CREATE_WEBSITE"
  | "EDIT_PROJECT"
  | "EDIT_WEBSITE"
  | "CONTINUE_PROJECT"
  | "DEBUG_PROJECT"
  | "REVIEW_PROJECT"
  | "IMPROVE_PROJECT"
  | "TEST_PROJECT"
  | "BUILD_PROJECT"
  | "PREVIEW_PROJECT"
  | "CONNECT_REPOSITORY"
  | "COMMIT_PROJECT"
  | "DEPLOY_PROJECT"
  | "ADD_DATA_MODEL"
  | "EDIT_DATA_MODEL";

export interface ProjectIntentInput {
  message?: string;
  prompt?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  activeCompanyId?: string | null;
  activeProjectId?: string | null;
  activeWorkspaceId?: string | null;
  hasWorkspace?: boolean;
  lastRunStatus?: string | null;
}

export interface ProjectIntentDecision {
  intent: ProjectIntent;
  confidence: number;
  isExecutableInStep5: boolean;
  executable: boolean;
  isProjectIntent: boolean;
  needsClarification: boolean;
  clarificationPrompt?: string;
  clarificationMessage?: string;
  unsupportedIntentMessage?: string;
  suggestedAction?: string;
  targetDetails?: {
    topic?: string;
    framework?: string;
    technologySelection?: import("./chat-development").DevelopmentTarget["technologySelection"];
    actionDescription?: string;
    entityName?: string;
    /** D6: a mobile app project shares an existing DataBackend with the website. */
    projectType?: "website" | "mobile_app" | "game";
    /** Purpose of a universal project, independent of its legacy storage type. */
    projectKind?: import("./project-kind").ProjectKind;
    dataBackendId?: string;
  };
}

/** Requests that ask for a mobile app (Expo / React Native) rather than a website. */
const MOBILE_APP_REGEX = /(?:мобільн\p{L}*|мобильн\p{L}*|mobile|android|ios|expo|flutter|react\s*native|react-native|смартфон\p{L}*|застосун\p{L}*|апп|додаток для (?:телефон|смартфон)|native app)/iu;

export function isMobileAppRequest(message: string): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  if (!MOBILE_APP_REGEX.test(text)) return false;
  // "мобільний" alone may describe a responsive website; require an app/Expo signal.
  return /(?:додаток|застосун\p{L}*|\bapp\b(?!\.)|\bexpo\b|react\s*native|\bandroid\b|\bios\b)/iu.test(text);
}

const EXPLANATION_REGEX = /^(?:що таке|як працює|поясни|розкажи про|різниця між|чому|what is|how does|how do|explain|tell me about|difference between|why is)\b/i;

const CREATE_PROJECT_REGEX = /(?:створи|зроби|розроби|створити|запусти|згенеруй|create|build|make|generate|start|new)(?:\s+[\p{L}\d_-]+){0,5}\s+(?:сайт|веб-?сайт|лендінг|проєкт|проект|додаток|застосун\p{L}*|апп|сторінк[уа]|гр[уа](?![\p{L}])|ігр\p{L}*|website|web\s*site|landing(?:\s*page)?|project|app|web\s*app|games?\b)/iu;
/** A browser game, not a mobile one: "гра", "ігри", "game" as whole words, so "програма" or "групу" never match. */
const GAME_REQUEST_REGEX = /(?:\bgames?\b|(?<![\p{L}])(?:гр[уаи]|ігр\p{L}*|игр\p{L}*)(?![\p{L}]))/iu;
export const isGameRequest = (text: string) => !isMobileAppRequest(text) && GAME_REQUEST_REGEX.test(text);

const EDIT_ACTION_REGEX = /(?:зроби|зміни|додай|видали|поправ|онови|перепиши|пофарбуй|розмісти|збільш|зменш|налаштуй|make|change|add|update|edit|modify|fix|move|enlarge|shrink|customize|color|style|darker|lighter|bigger|smaller)\s+(?:кнопк|хедер|футер|текст|шрифт|колір|секці|банер|форму|дизайн|стил|меню|лого|button|header|footer|text|font|color|section|banner|form|design|style|menu|hero|logo)/i;

const CONTINUE_REGEX = /^(?:продовжуй|продовжити|продовжуємо|рухайся далі|далі|continue|go ahead|proceed|next step|keep going)\b/i;

const DEBUG_REGEX = /(?:виправ помилк|чому падає|полагоди|полагодь|налагодь|дебаг|debug|fix error|fix bug|build failed|fix crash|solve error|troubleshoot)/i;

const REVIEW_REGEX = /(?:зроби рев['ʼ]?ю|перевір код|код рев['ʼ]?ю|review code|code review|inspect code|audit code)/i;

const IMPROVE_REGEX = /(?:покращ(?:ити)?|оптимізуй|рефакторинг|improve|optimize|refactor)\s+(?:проєкт|код|сайт|швидкість|архітектуру|project|website|code|performance)/i;

const TEST_REGEX = /(?:запусти тести|протестуй|проведи тести|run (?:the )?(?:project |website |unit )?tests?|execute tests?|test (?:the )?(?:project|site|app|suite))/i;
/** An explicit request to inspect installed runtime availability, never an explanation about SDKs. */
export function isRuntimeToolchainCheck(message: string): boolean {
  return /^(?:перевір(?:те)?|check|verify|inspect)(?=\s|$)/iu.test(message.trim())
    && /(?:\bSDK\b|\bJDK\b|\btoolchain\b|\bemulator\b|емулятор)/iu.test(message)
    && /(?:доступн|availab|installed|sandbox|toolchain)/iu.test(message);
}

const BROWSER_QA_REGEX = /(?:browser qa|headless|qa inspect|перевір (?:в )?браузері|перевір верстку|протестуй сайт|тест сторінки|check links|accessibility|a11y|broken links|audit website)/i;

const BUILD_REGEX = /(?:збери проєкт|зроби білд|запусти білд|компіляція|build (?:the )?(?:project|site|app)|npm run build|yarn build|pnpm build)/i;

const PREVIEW_REGEX = /(?:запусти (?:preview|прев['ʼ]?ю|сайт)|покажи (?:прев['ʼ]?ю|preview|сайт)|start preview|open preview|live preview|launch preview|preview project|view site)/i;

const CONNECT_REPO_REGEX = /(?:підключи(?:ти)? (?:репозиторій|гіт|github)|connect (?:repo|repository|github)|link repo)/i;

const COMMIT_REGEX = /(?:зроби коміт|закоміть|git commit|commit changes)/i;

const DEPLOY_REGEX = /(?:задеплой(?:ти)?|опублікуй(?: сайт)?|виклади на хостинг|deploy (?:(?:the |this |a )?(?:site|website|project|app)|to )|publish (?:the |this |a )?(?:site|website|project)|deploy)/i;

const EDIT_DATA_MODEL_REGEX = /(?:зміни|онови|видали|поправ|відредагуй|edit|update|modify|alter|drop|delete)(?:\s+[\p{L}\d_-]+){0,3}\s+(?:таблиц|колекці|модел|поля?|поле|зв['ʼ]?язок|стовпець|колонк[ауи]|table|collection|model|field|relation|column)/iu;
const ADD_DATA_MODEL_REGEX = /(?:додай|створи|налаштуй|зроби|add|create|setup|generate)(?:\s+[\p{L}\d_-]+){0,4}\s+(?:таблиц|колекці|модел|баз[уі]|схем|інтернет-магазин|магазин|блог|crm|saas|ecommerce|blog|store|table|collection|model|database|schema)/iu;
const ADD_FIELD_REGEX = /(?:додай|додати|створи|add|create)\s+(?:нов[\p{L}]*\s+)?(?:поле|поля|стовпець|стовпці|колонк[ауи]|field|column)/iu;
const CREATE_STORE_REGEX = /(?:створи|створити|зроби|розроби|create|build|make)(?:\s+[\p{L}\d_-]+){0,4}\s+(?:інтернет[ -]?магазин|online\s+(?:store|shop)|e-?commerce\s+(?:store|site)|магазин|store|shop)/iu;

function extractEntityName(message: string): string | undefined {
  const match = message.match(/(?:for|для|назва|called|named|під назвою)\s+["'«]?([^"'»\n.,!?]+)["'»]?/i)
    || message.match(/(?:створи(?: мені)?|зроби(?: мені)?|create(?: me)?|build)\s+(?:новий\s+)?(?:адаптивний\s+)?(?:сучасний\s+)?(?:сайт|веб-?сайт|website|landing)\s*[,:]\s*["'«]?([^"'»\n.!?]+)["'»]?/i);
  if (!match) return undefined;
  const name = match[1]?.trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : undefined;
}

/** Canonical framework names understood by project scaffolding, preview and verification. */
export const SUPPORTED_PROJECT_FRAMEWORKS = [
  "Next.js",
  "React + Vite",
  "Vue 3 + Vite",
  "Nuxt",
  "SvelteKit",
  "Astro",
  "Angular",
  "Remix",
  "Express",
  "Fastify",
  "NestJS",
  "FastAPI",
  "Django",
  "Flask",
  "Laravel",
  "HTML/CSS",
  "Expo",
  "Flutter",
  "Pygame",
] as const;
export type SupportedProjectFramework = typeof SUPPORTED_PROJECT_FRAMEWORKS[number];

/** Desktop deliverables use the existing Code/Sandbox tools, never an HTTP Preview. */
export function isDesktopProjectFramework(value: unknown): boolean { return value === "Pygame"; }
export function isMobileProjectFramework(value: unknown): boolean { return value === "Expo" || value === "Flutter"; }

/** Frameworks whose primary deliverable is an HTTP API/server, not a browser-rendered site. */
export const BACKEND_PROJECT_FRAMEWORKS = ["Express", "Fastify", "NestJS", "FastAPI", "Django", "Flask", "Laravel"] as const;
export function isBackendProjectFramework(value: unknown): boolean {
  return typeof value === "string" && (BACKEND_PROJECT_FRAMEWORKS as readonly string[]).includes(value);
}

export function isSupportedProjectFramework(value: unknown): value is SupportedProjectFramework {
  return typeof value === "string" && (SUPPORTED_PROJECT_FRAMEWORKS as readonly string[]).includes(value);
}

/**
 * Maps free-form framework spellings to the canonical name used by the project record.
 * Kept separate from `extractFramework` so callers can normalise persisted metadata without
 * re-parsing a prompt.
 */
export function canonicalFrameworkName(value: string | null | undefined): SupportedProjectFramework | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (/\bflutter\b/.test(lower)) return "Flutter";
  if (/\bpygame\b/.test(lower)) return "Pygame";
  if (lower.includes("expo") || lower.includes("react native") || lower.includes("react-native")) return "Expo";
  if (lower.includes("next")) return "Next.js";
  if (lower.includes("nuxt")) return "Nuxt";
  if (lower.includes("svelte")) return "SvelteKit";
  if (lower.includes("astro")) return "Astro";
  if (lower.includes("angular")) return "Angular";
  if (lower.includes("remix") || lower.includes("react router") || lower.includes("react-router")) return "Remix";
  if (lower.includes("nestjs") || lower.includes("nest.js") || /\bnest\b/.test(lower)) return "NestJS";
  if (lower.includes("fastify")) return "Fastify";
  if (lower.includes("express")) return "Express";
  if (lower.includes("fastapi") || lower.includes("fast api")) return "FastAPI";
  if (lower.includes("django")) return "Django";
  if (lower.includes("flask")) return "Flask";
  if (lower.includes("laravel")) return "Laravel";
  if (lower.includes("vue")) return "Vue 3 + Vite";
  if (lower.includes("react") || lower === "vite") return "React + Vite";
  if (lower.includes("html") || lower.includes("static")) return "HTML/CSS";
  return undefined;
}

export function frameworkConstraints(message: string): { positive: string; forbidden: string[]; noFramework: boolean } {
  const forbidden: string[] = [];
  const positive = message.replace(/(?:не\s+використовуй(?:те)?|не\s+використовувати|без|do\s+not\s+use|don't\s+use|must\s+not\s+use|without)\s+([^\n!?;]+?)(?=[!?;\n]|\.\s|$)/giu, (_all, clause: string) => {
    for (const part of clause.split(/,|\s+(?:or|and|або|та|і)\s+/iu)) {
      const name = canonicalFrameworkName(part.trim());
      if (name) forbidden.push(name);
    }
    return " ";
  });
  return { positive, forbidden: [...new Set(forbidden)], noFramework: /(?:без\s+фреймворк|without\s+(?:any\s+)?framework|no\s+framework)/iu.test(message) };
}

export function extractFramework(message: string): string | undefined {
  const constraints = frameworkConstraints(message);
  if (constraints.noFramework) return "HTML/CSS";
  const lower = constraints.positive.toLowerCase();
  if (/\bflutter\b/.test(lower)) return "Flutter";
  if (/\bpygame\b/.test(lower)) return "Pygame";
  if (/\b(?:fast\s*api|fastapi)\b/.test(lower)) return "FastAPI";
  if (/\bdjango\b/.test(lower)) return "Django";
  if (/\bflask\b/.test(lower)) return "Flask";
  if (/\blaravel\b/.test(lower)) return "Laravel";
  if (/\b(?:nestjs|nest\.js)\b/.test(lower)) return "NestJS";
  if (/\bfastify\b/.test(lower)) return "Fastify";
  if (/\bexpress(?:\.js)?\b/.test(lower)) return "Express";
  if (/\b(?:remix|react[\s-]*router)\b/.test(lower)) return "Remix";
  if (/\bangular\b/.test(lower)) return "Angular";
  if (/\bexpo\b|\breact[\s-]*native\b/.test(lower)) return "Expo";
  if (/\bnext(?:\.js|js)?\b/.test(lower)) return "Next.js";
  if (/\bnuxt\b/.test(lower)) return "Nuxt";
  if (/\bsvelte(?:kit)?\b/.test(lower)) return "SvelteKit";
  if (/\bastro\b/.test(lower)) return "Astro";
  if (/\bvue\b/.test(lower)) return "Vue 3 + Vite";
  if (/\breact\b/.test(lower)) return "React + Vite";
  if (/\bvite\b/.test(lower)) return "React + Vite";
  if (/\bhtml\b|\bstatic\b/.test(lower)) return "HTML/CSS";
  return undefined;
}

/** A visual reference changes the selected site unless a separate new deliverable is explicit. */
export function isWebsiteReferenceEdit(input: ProjectIntentInput): boolean {
  const text = input.message ?? input.prompt ?? "";
  return !!input.activeProjectId && /(?:зроби|зміни|перероби|онови|make|change|redesign|update)/iu.test(text)
    && /(?:вигляд|дизайн|оформлен|сайт|layout|design|appearance|look|website)/iu.test(text)
    && /(?:фото|зображен|скрин|screenshot|image|picture|reference)/iu.test(text)
    && !/(?:нов|інш|окрем|new|another|separate)[\p{L}]*\s+(?:сайт|про[єе]кт|магазин|website|site|project|store)/iu.test(text);
}

export function classifyProjectIntent(rawInput: ProjectIntentInput | string): ProjectIntentDecision {
  const input: ProjectIntentInput = typeof rawInput === "string" ? { message: rawInput } : rawInput;
  const raw = input.message ?? input.prompt ?? "";
  const text = raw.trim();
  const lower = text.toLowerCase();

  const buildDecision = (partial: Omit<ProjectIntentDecision, "executable" | "isProjectIntent" | "clarificationMessage">): ProjectIntentDecision => ({
    ...partial,
    executable: partial.isExecutableInStep5,
    isProjectIntent: partial.intent !== "CHAT",
    clarificationMessage: partial.clarificationPrompt ?? partial.unsupportedIntentMessage,
  });

  // 1. Pure explanations / questions take top precedence over keyword matches
  if (EXPLANATION_REGEX.test(text) && !CREATE_PROJECT_REGEX.test(text) && !EDIT_ACTION_REGEX.test(text)) {
    return buildDecision({
      intent: "CHAT",
      confidence: 0.95,
      isExecutableInStep5: false,
      needsClarification: false,
    });
  }

  if (isWebsiteReferenceEdit(input)) return buildDecision({ intent: "EDIT_WEBSITE", confidence: 0.98, isExecutableInStep5: true, needsClarification: false });

  // The opening request defines a new deliverable. QA, preview, schema and repair
  // steps later in a long specification must not turn it into work on an existing project.
  const opening = text.split(/\r?\n\s*\r?\n/u).slice(0, 2).join(" ")
    .replace(/[#*`]/gu, "").replace(/[,;:]/gu, " ").replace(/\s+/gu, " ").trim();
  const openingLine = text.split(/\r?\n/u)[0]!.replace(/[#*`]/gu, "").trim();
  // Company setup specifications can mention data models and testing in agent responsibilities.
  // Those incidental steps must not turn the primary Company/Business request into a project mutation.
  if (/^(?:create|make|build|створи(?:ти)?|зроби|crie|criar)(?:\s+[\p{L}\d_+-]+){0,6}\s+(?:company|business|компані\p{L}*|бізнес\p{L}*|empresa|companhia)(?!\s+(?:table|model|schema|form|page|endpoint)\b)(?=\s|[.,:;]|$)/iu.test(openingLine)
    && !CREATE_PROJECT_REGEX.test(openingLine) && !CREATE_STORE_REGEX.test(openingLine)) {
    return buildDecision({ intent: "CHAT", confidence: 0.95, isExecutableInStep5: false, needsClarification: false });
  }
  const componentRequest = Boolean(input.activeProjectId) && /^(?:create|make|build|створи|зроби|додай)(?:\s+[\p{L}]+){0,2}\s+(?:form|menu|button|page|section|header|footer|component|форм\p{L}*|меню|кнопк\p{L}*|сторінк\p{L}*|секці\p{L}*|компонент\p{L}*)(?=\s|$)/iu.test(opening);
  if (/^(?:(?:завдання|task)\s+)?(?:створи(?:ти)?|зроби|розроби|згенеруй|create|build|make|generate)\s/iu.test(opening)
    && (CREATE_PROJECT_REGEX.test(opening) || CREATE_STORE_REGEX.test(opening))
    && !componentRequest && !EXPLANATION_REGEX.test(opening)) {
    const isMobileApp = isMobileAppRequest(opening);
    const isGame = isGameRequest(opening);
    const isWebsite = !isMobileApp && /сайт|лендінг|магазин|website|web\s*site|landing|store|shop/iu.test(opening);
    // A page/component inside an existing project remains an edit.
    if (isWebsite || isMobileApp || isGame || /про[єе]кт|\bproject\b/iu.test(opening)) {
      return buildDecision({
        intent: isWebsite ? "CREATE_WEBSITE" : "CREATE_PROJECT",
        confidence: 0.96,
        isExecutableInStep5: true,
        needsClarification: false,
        targetDetails: {
          topic: text,
          framework: isMobileApp ? extractFramework(text) ?? "Expo" : extractFramework(text) ?? (isGame ? "HTML/CSS" : undefined),
          entityName: extractEntityName(text),
          projectType: isMobileApp ? "mobile_app" : isGame ? "game" : "website",
        },
      });
    }
  }

  // 2. Connect repository
  if (CONNECT_REPO_REGEX.test(text)) {
    const hasActiveProject = Boolean(input.activeProjectId);
    return buildDecision({
      intent: "CONNECT_REPOSITORY",
      confidence: 0.9,
      isExecutableInStep5: true,
      needsClarification: !hasActiveProject,
      clarificationPrompt: !hasActiveProject ? "Оберіть або створіть проєкт перед підключенням Git-репозиторію." : undefined,
      suggestedAction: "Підключити Git репозиторій до активного проєкту",
    });
  }

  // 3. Git commit
  if (COMMIT_REGEX.test(text)) {
    const hasActiveProject = Boolean(input.activeProjectId);
    return buildDecision({
      intent: "COMMIT_PROJECT",
      confidence: 0.9,
      isExecutableInStep5: true,
      needsClarification: !hasActiveProject,
      clarificationPrompt: !hasActiveProject ? "Оберіть або створіть проєкт перед створенням коміту." : undefined,
      suggestedAction: "Закомітити зміни у поточному проєкті",
    });
  }

  // 4. Deploy
  if (DEPLOY_REGEX.test(text)) {
    const hasActiveProject = Boolean(input.activeProjectId);
    return buildDecision({
      intent: "DEPLOY_PROJECT",
      confidence: 0.9,
      isExecutableInStep5: hasActiveProject,
      needsClarification: !hasActiveProject,
      clarificationPrompt: !hasActiveProject ? "Оберіть або створіть проєкт перед тим як виконати деплой сайту." : undefined,
      suggestedAction: "project.deploy.publish",
    });
  }

  // 5. Code Review
  if (REVIEW_REGEX.test(text)) {
    return buildDecision({
      intent: "REVIEW_PROJECT",
      confidence: 0.85,
      isExecutableInStep5: false,
      needsClarification: false,
      unsupportedIntentMessage: "Автономний аудит та код-рев'ю сайту будуть розширені у наступних кроках.",
    });
  }

  // 6. Improve / Refactor
  if (IMPROVE_REGEX.test(text)) {
    return buildDecision({
      intent: "IMPROVE_PROJECT",
      confidence: 0.85,
      isExecutableInStep5: true,
      needsClarification: !input.activeProjectId,
      clarificationPrompt: !input.activeProjectId ? "Select an active Project to improve." : undefined,
    });
  }

  // Creating a component inside the selected site is an edit of that workspace.
  if (input.activeProjectId && /(?:create|make|build|\u0441\u0442\u0432\u043e\u0440|\u0437\u0440\u043e\u0431|\u0434\u043e\u0434\u0430).*(?:\bform\b|\bmenu\b|\bbutton\b|\bpage\b|\bsection\b|\bheader\b|\bfooter\b|\bcomponent\b|\u0444\u043e\u0440\u043c|\u043c\u0435\u043d\u044e|\u043a\u043d\u043e\u043f\u043a|\u0441\u0442\u043e\u0440\u0456\u043d\u043a|\u0441\u0435\u043a\u0446|\u043a\u043e\u043c\u043f\u043e\u043d\u0435\u043d\u0442)/iu.test(text)
    && !/(?:\bnew\s+(?:website|site|project|store|blog|app)\b|\u043d\u043e\u0432[\u0438\u0430\u0443\u0435\u043e\u0439\u0456\u043d]*\s+(?:\u0441\u0430\u0439\u0442|\u043f\u0440\u043e\u0454\u043a\u0442|\u043c\u0430\u0433\u0430\u0437\u0438\u043d|\u0431\u043b\u043e\u0433|\u0434\u043e\u0434\u0430\u0442\u043e\u043a))/iu.test(text)) {
    return buildDecision({ intent: "EDIT_PROJECT", confidence: 0.9, isExecutableInStep5: true, needsClarification: false });
  }
  // A new site/app must win over ancillary build, preview and data requests.
  if (CREATE_PROJECT_REGEX.test(text) && (/створи|створити|зроби|розроби|згенеруй|create|generate|make|build\s+(?:a|an)\s/iu.test(text) || !PREVIEW_REGEX.test(text) && !BUILD_REGEX.test(text) && !TEST_REGEX.test(text)) || CREATE_STORE_REGEX.test(text) && !/таблиц|колекці|схем|table|collection|schema/iu.test(text)) {
    const isMobileApp = isMobileAppRequest(text);
    const isGame = isGameRequest(text);
    const isWebsite = !isMobileApp && /сайт|веб-?сайт|лендінг|магазин|website|web\s*site|landing|store|shop/iu.test(text);
    return buildDecision({
      intent: isWebsite ? "CREATE_WEBSITE" : "CREATE_PROJECT",
      confidence: 0.92,
      isExecutableInStep5: true,
      needsClarification: false,
      targetDetails: {
        topic: text,
        framework: isMobileApp ? extractFramework(text) ?? "Expo" : extractFramework(text) ?? (isGame ? "HTML/CSS" : undefined),
        entityName: extractEntityName(text),
        projectType: isMobileApp ? "mobile_app" : isGame ? "game" : "website",
      },
    });
  }

  // 7. Preview Project
  if (PREVIEW_REGEX.test(text)) {
    return buildDecision({
      intent: "PREVIEW_PROJECT",
      confidence: 0.9,
      isExecutableInStep5: true,
      needsClarification: !input.activeProjectId,
      clarificationPrompt: !input.activeProjectId ? "Будь ласка, оберіть активний проєкт для запуску Live Preview." : undefined,
      suggestedAction: "project.preview.start",
    });
  }

  // 8. Build Project
  if (BUILD_REGEX.test(text)) {
    return buildDecision({
      intent: "BUILD_PROJECT",
      confidence: 0.9,
      isExecutableInStep5: true,
      needsClarification: !input.activeProjectId,
      clarificationPrompt: !input.activeProjectId ? "Будь ласка, оберіть активний проєкт для виконання збірки." : undefined,
      suggestedAction: "project.terminal.exec",
    });
  }

  // 9. Test Project / Browser QA
  if (BROWSER_QA_REGEX.test(text) || TEST_REGEX.test(text) || isRuntimeToolchainCheck(text)) {
    const isBrowserQa = BROWSER_QA_REGEX.test(text);
    return buildDecision({
      intent: "TEST_PROJECT",
      confidence: 0.9,
      isExecutableInStep5: true,
      needsClarification: !input.activeProjectId,
      clarificationPrompt: !input.activeProjectId ? (isBrowserQa ? "Будь ласка, оберіть активний проєкт для Browser QA перевірки." : "Будь ласка, оберіть активний проєкт для запуску тестів.") : undefined,
      suggestedAction: isBrowserQa ? "project.qa.inspect" : "project.terminal.exec",
    });
  }

  // 10. Debug Project
  if (DEBUG_REGEX.test(text)) {
    return buildDecision({
      intent: "DEBUG_PROJECT",
      confidence: 0.88,
      isExecutableInStep5: true,
      needsClarification: !input.activeProjectId,
      clarificationPrompt: !input.activeProjectId ? "Будь ласка, оберіть активний проєкт для виправлення помилки." : undefined,
      suggestedAction: "project.files.edit",
    });
  }

  // 10.1. Data Model Intents (D3)
  if (EDIT_DATA_MODEL_REGEX.test(text) || ADD_FIELD_REGEX.test(text)) {
    return buildDecision({
      intent: "EDIT_DATA_MODEL",
      confidence: 0.92,
      isExecutableInStep5: true,
      needsClarification: !input.activeProjectId,
      clarificationPrompt: !input.activeProjectId ? "Оберіть активний проєкт для зміни моделі даних." : undefined,
      suggestedAction: "project.data.schema.apply",
    });
  }

  if (ADD_DATA_MODEL_REGEX.test(text) && (/таблиц|колекці|модел|баз|схем|table|collection|model|database|schema/i.test(text) || Boolean(input.activeProjectId))) {
    return buildDecision({
      intent: "ADD_DATA_MODEL",
      confidence: 0.92,
      isExecutableInStep5: true,
      needsClarification: !input.activeProjectId,
      clarificationPrompt: !input.activeProjectId ? "Оберіть активний проєкт для додавання моделі даних." : undefined,
      suggestedAction: "project.data.templates.apply",
      targetDetails: {
        topic: text,
      },
    });
  }

  // 11. Create Project / Create Website / Create Mobile App (D6)
  if (CREATE_PROJECT_REGEX.test(text)) {
    const isMobileApp = isMobileAppRequest(text);
    const isGame = isGameRequest(text);
    const isWebsite = !isMobileApp && /сайт|веб-?сайт|лендінг|website|web\s*site|landing/i.test(text);
    return buildDecision({
      intent: isWebsite ? "CREATE_WEBSITE" : "CREATE_PROJECT",
      confidence: 0.92,
      isExecutableInStep5: true,
      needsClarification: false,
      targetDetails: {
        topic: text,
        framework: isMobileApp ? extractFramework(text) ?? "Expo" : extractFramework(text) ?? (isGame ? "HTML/CSS" : undefined),
        entityName: extractEntityName(text),
        projectType: isMobileApp ? "mobile_app" : isGame ? "game" : "website",
      },
    });
  }
  // 12. Continue Project (requires context)
  if (CONTINUE_REGEX.test(text) && input.activeProjectId) {
    return buildDecision({
      intent: "CONTINUE_PROJECT",
      confidence: 0.88,
      isExecutableInStep5: true,
      needsClarification: false,
    });
  }

  // 13. Edit Project / Website (UI or content modification)
  if (EDIT_ACTION_REGEX.test(text)) {
    const isWebsite = /сайт|веб-?сайт|лендінг|website|web\s*site|landing/i.test(text);
    const hasProject = Boolean(input.activeProjectId);
    return buildDecision({
      intent: isWebsite ? "EDIT_WEBSITE" : "EDIT_PROJECT",
      confidence: 0.9,
      isExecutableInStep5: hasProject,
      needsClarification: !hasProject,
      clarificationPrompt: !hasProject
        ? "Будь ласка, вкажіть або відкрийте активний проєкт, щоб внести ці зміни."
        : undefined,
      targetDetails: {
        actionDescription: text,
      },
    });
  }

  // Default to general chat
  return buildDecision({
    intent: "CHAT",
    confidence: 0.6,
    isExecutableInStep5: false,
    needsClarification: false,
  });
}
