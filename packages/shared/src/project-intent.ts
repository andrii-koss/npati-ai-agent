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
  | "DEPLOY_PROJECT";

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
  };
}

const EXPLANATION_REGEX = /^(?:що таке|як працює|поясни|розкажи про|різниця між|чому|what is|how does|how do|explain|tell me about|difference between|why is)\b/i;

const CREATE_PROJECT_REGEX = /(?:створи|зроби|розроби|створити|запусти|згенеруй|create|build|make|generate|start|new)(?:\s+[\p{L}\d_-]+){0,5}\s+(?:сайт|веб-?сайт|лендінг|проєкт|проект|додаток|сторінк[уа]|website|web\s*site|landing(?:\s*page)?|project|app|web\s*app)/iu;

const EDIT_ACTION_REGEX = /(?:зроби|зміни|додай|видали|поправ|онови|перепиши|пофарбуй|розмісти|збільш|зменш|налаштуй|make|change|add|update|edit|modify|fix|move|enlarge|shrink|customize|color|style|darker|lighter|bigger|smaller)\s+(?:кнопк|хедер|футер|текст|шрифт|колір|секці|банер|форму|дизайн|стил|меню|лого|button|header|footer|text|font|color|section|banner|form|design|style|menu|hero|logo)/i;

const CONTINUE_REGEX = /^(?:продовжуй|продовжити|продовжуємо|рухайся далі|далі|continue|go ahead|proceed|next step|keep going)\b/i;

const DEBUG_REGEX = /(?:виправ помилк|чому падає|полагоди|полагодь|налагодь|дебаг|debug|fix error|fix bug|build failed|fix crash|solve error|troubleshoot)/i;

const REVIEW_REGEX = /(?:зроби рев['ʼ]?ю|перевір код|код рев['ʼ]?ю|review code|code review|inspect code|audit code)/i;

const IMPROVE_REGEX = /(?:покращ(?:ити)?|оптимізуй|рефакторинг|improve|optimize|refactor)\s+(?:проєкт|код|сайт|швидкість|архітектуру|project|website|code|performance)/i;

const TEST_REGEX = /(?:запусти тести|протестуй|проведи тести|run (?:the )?(?:project |website |unit )?tests?|execute tests?|test (?:the )?(?:project|site|app|suite))/i;

const BUILD_REGEX = /(?:збери проєкт|зроби білд|запусти білд|компіляція|build (?:the )?(?:project|site|app)|npm run build|yarn build|pnpm build)/i;

const PREVIEW_REGEX = /(?:запусти (?:preview|прев['ʼ]?ю|сайт)|покажи (?:прев['ʼ]?ю|preview|сайт)|start preview|open preview|live preview|launch preview|preview project|view site)/i;

const CONNECT_REPO_REGEX = /(?:підключи(?:ти)? (?:репозиторій|гіт|github)|connect (?:repo|repository|github)|link repo)/i;

const COMMIT_REGEX = /(?:зроби коміт|закоміть|git commit|commit changes)/i;

const DEPLOY_REGEX = /(?:задеплой(?:ти)?|опублікуй сайт|виклади на хостинг|deploy (?:the )?(?:site|website|project)|publish site)/i;

function extractEntityName(message: string): string | undefined {
  const match = message.match(/(?:for|для|назва|called|named|під назвою)\s+["'«]?([^"'»\n.,!?]+)["'»]?/i);
  return match ? match[1]?.trim() : undefined;
}

function extractFramework(message: string): string | undefined {
  const lower = message.toLowerCase();
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

export function classifyProjectIntent(input: ProjectIntentInput): ProjectIntentDecision {
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
    return buildDecision({
      intent: "CONNECT_REPOSITORY",
      confidence: 0.9,
      isExecutableInStep5: false,
      needsClarification: false,
      unsupportedIntentMessage: "Підключення репозиторіїв Git/GitHub заплановане у Фазі 2 (Крок 6) та стане доступним незабаром.",
    });
  }

  // 3. Git commit
  if (COMMIT_REGEX.test(text)) {
    return buildDecision({
      intent: "COMMIT_PROJECT",
      confidence: 0.9,
      isExecutableInStep5: false,
      needsClarification: false,
      unsupportedIntentMessage: "Створення комітів та керування версіями заплановане у Фазі 2 (Крок 6).",
    });
  }

  // 4. Deploy
  if (DEPLOY_REGEX.test(text)) {
    return buildDecision({
      intent: "DEPLOY_PROJECT",
      confidence: 0.9,
      isExecutableInStep5: false,
      needsClarification: false,
      unsupportedIntentMessage: "Деплой на хостинг/сервер запланований у Фазі 3 (Крок 10).",
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
      isExecutableInStep5: false,
      needsClarification: false,
      unsupportedIntentMessage: "Складні рефакторинги будуть автоматизовані з мультиагентними командами.",
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

  // 9. Test Project
  if (TEST_REGEX.test(text)) {
    return buildDecision({
      intent: "TEST_PROJECT",
      confidence: 0.9,
      isExecutableInStep5: true,
      needsClarification: !input.activeProjectId,
      clarificationPrompt: !input.activeProjectId ? "Будь ласка, оберіть активний проєкт для запуску тестів." : undefined,
      suggestedAction: "project.terminal.exec",
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

  // 11. Create Project / Create Website
  if (CREATE_PROJECT_REGEX.test(text)) {
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
