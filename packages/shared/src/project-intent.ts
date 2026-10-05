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
    actionDescription?: string;
    entityName?: string;
    /** D6: a mobile app project shares an existing DataBackend with the website. */
    projectType?: "website" | "mobile_app";
    dataBackendId?: string;
  };
}

/** Requests that ask for a mobile app (Expo / React Native) rather than a website. */
const MOBILE_APP_REGEX = /(?:мобільн\p{L}*|мобильн\p{L}*|mobile|android|ios|expo|react\s*native|react-native|смартфон\p{L}*|застосун\p{L}*|апп|додаток для (?:телефон|смартфон)|native app)/iu;

export function isMobileAppRequest(message: string): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  if (!MOBILE_APP_REGEX.test(text)) return false;
  // "мобільний" alone may describe a responsive website; require an app/Expo signal.
  return /(?:додаток|застосун\p{L}*|app|expo|react\s*native|android|ios)/iu.test(text);
}

const EXPLANATION_REGEX = /^(?:що таке|як працює|поясни|розкажи про|різниця між|чому|what is|how does|how do|explain|tell me about|difference between|why is)\b/i;

const CREATE_PROJECT_REGEX = /(?:створи|зроби|розроби|створити|запусти|згенеруй|create|build|make|generate|start|new)(?:\s+[\p{L}\d_-]+){0,5}\s+(?:сайт|веб-?сайт|лендінг|проєкт|проект|додаток|застосун\p{L}*|апп|сторінк[уа]|website|web\s*site|landing(?:\s*page)?|project|app|web\s*app)/iu;

const EDIT_ACTION_REGEX = /(?:зроби|зміни|додай|видали|поправ|онови|перепиши|пофарбуй|розмісти|збільш|зменш|налаштуй|make|change|add|update|edit|modify|fix|move|enlarge|shrink|customize|color|style|darker|lighter|bigger|smaller)\s+(?:кнопк|хедер|футер|текст|шрифт|колір|секці|банер|форму|дизайн|стил|меню|лого|button|header|footer|text|font|color|section|banner|form|design|style|menu|hero|logo)/i;

const CONTINUE_REGEX = /^(?:продовжуй|продовжити|продовжуємо|рухайся далі|далі|continue|go ahead|proceed|next step|keep going)\b/i;

const DEBUG_REGEX = /(?:виправ помилк|чому падає|полагоди|полагодь|налагодь|дебаг|debug|fix error|fix bug|build failed|fix crash|solve error|troubleshoot)/i;

const REVIEW_REGEX = /(?:зроби рев['ʼ]?ю|перевір код|код рев['ʼ]?ю|review code|code review|inspect code|audit code)/i;

const IMPROVE_REGEX = /(?:покращ(?:ити)?|оптимізуй|рефакторинг|improve|optimize|refactor)\s+(?:проєкт|код|сайт|швидкість|архітектуру|project|website|code|performance)/i;

const TEST_REGEX = /(?:запусти тести|протестуй|проведи тести|run (?:the )?(?:project |website |unit )?tests?|execute tests?|test (?:the )?(?:project|site|app|suite))/i;

const BROWSER_QA_REGEX = /(?:browser qa|headless|qa inspect|перевір (?:в )?браузері|перевір верстку|протестуй сайт|тест сторінки|check links|accessibility|a11y|broken links|audit website)/i;

const BUILD_REGEX = /(?:збери проєкт|зроби білд|запусти білд|компіляція|build (?:the )?(?:project|site|app)|npm run build|yarn build|pnpm build)/i;

const PREVIEW_REGEX = /(?:запусти (?:preview|прев['ʼ]?ю|сайт)|покажи (?:прев['ʼ]?ю|preview|сайт)|start preview|open preview|live preview|launch preview|preview project|view site)/i;

const CONNECT_REPO_REGEX = /(?:підключи(?:ти)? (?:репозиторій|гіт|github)|connect (?:repo|repository|github)|link repo)/i;

const COMMIT_REGEX = /(?:зроби коміт|закоміть|git commit|commit changes)/i;

const DEPLOY_REGEX = /(?:задеплой(?:ти)?|опублікуй(?: сайт)?|виклади на хостинг|deploy (?:(?:the |this |a )?(?:site|website|project|app)|to )|publish (?:the |this |a )?(?:site|website|project)|deploy)/i;

const EDIT_DATA_MODEL_REGEX = /(?:зміни|онови|видали|поправ|відредагуй|edit|update|modify|alter|drop|delete)(?:\s+[\p{L}\d_-]+){0,3}\s+(?:таблиц|колекці|модел|поля?|поле|зв['ʼ]?язок|стовпець|колонк[ауи]|table|collection|model|field|relation|column)/iu;
const ADD_DATA_MODEL_REGEX = /(?:додай|створи|налаштуй|зроби|add|create|setup|generate)(?:\s+[\p{L}\d_-]+){0,4}\s+(?:таблиц|колекці|модел|баз[уі]|схем|інтернет-магазин|магазин|блог|crm|saas|ecommerce|blog|store|table|collection|model|database|schema)/iu;

function extractEntityName(message: string): string | undefined {
  const match = message.match(/(?:for|для|назва|called|named|під назвою)\s+["'«]?([^"'»\n.,!?]+)["'»]?/i)
    || message.match(/(?:створи(?: мені)?|зроби(?: мені)?|create(?: me)?|build)\s+(?:новий\s+)?(?:адаптивний\s+)?(?:сучасний\s+)?(?:сайт|веб-?сайт|website|landing)\s*[,:]\s*["'«]?([^"'»\n.!?]+)["'»]?/i);
  if (!match) return undefined;
  const name = match[1]?.trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : undefined;
}

export function extractFramework(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (lower.includes("expo") || lower.includes("react native") || lower.includes("react-native")) return "Expo";
  if (lower.includes("next.js") || lower.includes("nextjs") || lower.includes("next")) return "Next.js";
  if (lower.includes("vite")) return "Vite";
  if (lower.includes("astro")) return "Astro";
  if (lower.includes("nuxt")) return "Nuxt";
  if (lower.includes("remix")) return "Remix";
  if (lower.includes("svelte")) return "SvelteKit";
  if (lower.includes("react")) return "React";
  if (lower.includes("vue")) return "Vue";
  if (lower.includes("html") || lower.includes("static")) return "HTML/CSS";
  return undefined;
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

  // Creation takes precedence when the same request also asks for preview
  if (CREATE_PROJECT_REGEX.test(text) && PREVIEW_REGEX.test(text)) {
    const isWebsite = /сайт|веб-?сайт|лендінг|website|web\s*site|landing/i.test(text);
    return buildDecision({
      intent: isWebsite ? "CREATE_WEBSITE" : "CREATE_PROJECT",
      confidence: 0.92,
      isExecutableInStep5: true,
      needsClarification: false,
      targetDetails: {
        topic: text,
        framework: extractFramework(text),
        entityName: extractEntityName(text),
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
  if (BROWSER_QA_REGEX.test(text) || TEST_REGEX.test(text)) {
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
  if (EDIT_DATA_MODEL_REGEX.test(text)) {
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
    const isWebsite = !isMobileApp && /сайт|веб-?сайт|лендінг|website|web\s*site|landing/i.test(text);
    return buildDecision({
      intent: isWebsite ? "CREATE_WEBSITE" : "CREATE_PROJECT",
      confidence: 0.92,
      isExecutableInStep5: true,
      needsClarification: false,
      targetDetails: {
        topic: text,
        framework: isMobileApp ? "Expo" : extractFramework(text),
        entityName: extractEntityName(text),
        projectType: isMobileApp ? "mobile_app" : "website",
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
