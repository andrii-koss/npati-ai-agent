/* Chat intent detection and onboarding helpers.
 * Extracted verbatim from app.ts (step 2a of docs/audit/refactoring/PLAN.md).
 */
import { detectCompanyChatLanguage } from "./company-chat-i18n";
import { isCompanyDeleteConfirmed, isCompanyDeleteIntent } from "./company-delete-i18n";
import { Business, OnboardingScenario } from "@npati/workspace";

export function isCompositeBusinessCompanyCreation(message: string): boolean {
  // A phrase such as "delete everything you just created" contains a past-tense
  // creation word. Destructive intent must always win over creation detection.
  if (isCompanyDeleteIntent(message)) return false;
  const create = /(?:створ|созда|create|cr[eé]e|erstelle|crea|utwórz|stwórz|crie|maak|oluştur|创建|作成|만들|أنشئ|बना)/iu.test(message);
  const business = /(?:б[іи]знес[\s-]*(?:іде|иде)|business\s+idea|id[eé]e\s+d['’]?entreprise|gesch[aä]ftsidee|idea\s+de\s+negocio|idea\s+imprenditoriale|pomysł\s+na\s+biznes|ideia\s+de\s+neg[oó]cio|businessidee|iş\s+fikri|商业想法|ビジネスアイデア|비즈니스\s*아이디어|فكرة\s+عمل|व्यवसाय\s+विचार)/iu.test(message);
  const goal = /(?:ціл|цел|\bgoal|objectif|ziel|objetivo|obiettivo|cel\b|meta\b|doel|hedef|目标|目標|목표|هدف|लक्ष्य)/iu.test(message);
  const company = /(?:компан|compan|entreprise|unternehmen|empresa|azienda|firm|sp[oó]łk|bedrijf|şirket|公司|会社|회사|شركة|कंपनी)/iu.test(message);
  return create && business && goal && company;
}

export function requestsNewBusinessIdea(message: string): boolean {
  return /(?:\u0441\u0442\u0432\u043e\u0440\p{L}*|\u0441\u043e\u0437\u0434\u0430\p{L}*|create|cr[e\u00e9]e|erstelle|crea|utw[o\u00f3]rz|stw[o\u00f3]rz)\s+(?:(?:\u0449\u0435|\u043e\u0434\u043d\u0443|\u043d\u043e\u0432\p{L}*|another|new|a|an|test\p{L}*|\u0442\u0435\u0441\u0442\p{L}*)\s+){0,5}(?:\u0431[\u0456\u0438]\u0437\u043d\u0435\u0441|business(?:\s+(?:idea|profile))?|id[e\u00e9]e\s+d['\u2019]entreprise|gesch[a\u00e4]ftsidee|idea\s+de\s+negocio|idea\s+imprenditoriale|pomys\u0142\s+na\s+biznes)/iu.test(message);
}
export function normalizeNewBusinessDirective(text: string, requestMessage: string): string {
  if (!requestsNewBusinessIdea(requestMessage)) return text;
  return text.replace(/```business-action\s*([\s\S]*?)```/iu, (block, body: string) => {
    try {
      const directive = JSON.parse(body) as { action?: string; profile?: { name?: string } };
      if (directive.action !== "update" || !directive.profile?.name?.trim()) return block;
      return "```business-action\n" + JSON.stringify({ ...directive, action: "create" }) + "\n```";
    } catch { return block; }
  });
}
export function requestsBusinessMemory(message: string): boolean {
  return /(?:пам(?:'|’)?ят|памят|мемор|\bmemory\b|m[eé]moire|ged[aä]chtnis|memoria|pami[eę][ćc]|mem[oó]ria|geheugen|hafıza|记忆|メモリ|메모리|الذاكرة|मेमोरी|स्मृति)/iu.test(message);
}

export function requestsBusinessGoal(message: string): boolean {
  return /(?:\u0446\u0456\u043b|\u0446\u0435\u043b|\bgoals?\b|objectif|ziel|objetivo|obiettivo|\bcel\b|\bmeta\b|doel|hedef|\u76ee\u6807|\u76ee\u6a19|\ubaa9\ud45c|\u0647\u062f\u0641|\u0932\u0915\u094d\u0937\u094d\u092f)/iu.test(message)
    && !/(?:\u0431\u0435\u0437|without|sans|ohne|sin|senza|bez|no)\s+(?:\u0446\u0456\u043b\p{L}*|\u0446\u0435\u043b\p{L}*|goals?)/iu.test(message);
}
export function requestsCompositeCompanyDeletionIntent(message: string): boolean {
  if (!isCompanyDeleteIntent(message)) return false;
  const company = /(?:компан|compan|entreprise|unternehmen|empresa|azienda|firm|bedrijf|şirket|公司|会社|회사|شركة|कंपनी)/iu.test(message);
  const business = /(?:б[іиу]знес(?:[\s-]*(?:іде|иде))?|\bbusiness(?:\s+idea)?\b|id[eé]e\s+d['’]?entreprise|geschäftsidee|idea\s+de\s+negocio|idea\s+imprenditoriale|pomysł\s+na\s+biznes|ideia\s+de\s+negócio|businessidee|iş\s+fikri|商业构想|ビジネスアイデア|비즈니스\s*아이디어|فكرة\s+العمل|व्यवसाय\s+विचार)/iu.test(message);
  const linkedResource = /(?:ціл|цел|goals?|objectifs?|ziele?|objetivos?|obiettiv|metas?|doelen?|hedef|目标|目標|목표|هدف|लक्ष्य|пам(?:'|’)?ят|мемор|\bmemory\b|mémoire|gedächtnis|memoria|pamięć|memória|geheugen|hafıza|记忆|メモリ|메모리|الذاكرة|मेमोरी|everything|all\s+of\s+it|це\s+все|усе\s+це|все\s+це)/iu.test(message);
  return company && business && linkedResource;
}

export function requestsCompositeCompanyDeletion(message: string): boolean {
  return isCompanyDeleteConfirmed(message) && requestsCompositeCompanyDeletionIntent(message);
}

export function isShortAffirmativeReply(message: string): boolean {
  return /^(?:так|так[,!.]?|гаразд|добре|підтверджую|да|да[,!.]?|подтверждаю|yes|yes[,!.]?|confirm|oui|ja|sí|si|sì|tak|sim|evet|是|是的|はい|예|نعم|हाँ)[.!]?$/iu.test(message.trim());
}

export function resolveContextualCompanyFollowUp(message: string, previousAssistant: string): string {
  const normalizedReply = message.trim().toLocaleLowerCase().replace(/[\s,.!]+/gu, "");
  const contextualAffirmative = isShortAffirmativeReply(message) || ["\u0442\u0430\u043a", "yes", "confirm"].includes(normalizedReply);

  const offeredAgentSetup = /(?:ролі[\s\S]{0,100}інструкці|инструкци[\s\S]{0,100}модел|roles?[\s\S]{0,100}instructions?[\s\S]{0,100}models?|rôles?[\s\S]{0,100}instructions?|rollen?[\s\S]{0,100}anweisungen?|roles?[\s\S]{0,100}instrucciones?|ruoli?[\s\S]{0,100}istruzioni?|role[\s\S]{0,100}instrukc|funções?[\s\S]{0,100}instruções?|rollen?[\s\S]{0,100}instructies?|roller[\s\S]{0,100}talimat|角色[\s\S]{0,50}指令|役割[\s\S]{0,50}指示|역할[\s\S]{0,50}지침|أدوار[\s\S]{0,80}تعليمات|भूमिकाएँ[\s\S]{0,80}निर्देश)/iu.test(previousAssistant);
  const linkedCompanyCard = /\/settings\/company\?company=[0-9a-f-]{36}/iu.test(previousAssistant);
  // "Так" agrees to what the last reply offered. A company link alone ("Відкрити налаштування компанії") is in every company
  // reply, also one that offers something else ("оновити опис у бізнес-профілі?"), so only an agent-setup offer is rewritten.
  if (!offeredAgentSetup || (!contextualAffirmative && !(linkedCompanyCard && message.trim().length <= 16))) return message;
  const language = detectCompanyChatLanguage(previousAssistant);
  const commands: Record<ReturnType<typeof detectCompanyChatLanguage>, string> = {
    en: "Configure detailed roles, system instructions, prompt guidelines, and recommended prompts for every agent in this company.",
    uk: "Детально налаштуй ролі, системні інструкції, правила промптів і рекомендовані запити для всіх агентів цієї компанії.",
    fr: "Configure en détail les rôles, les instructions système, les règles de prompt et les invites recommandées pour tous les agents de cette entreprise.",
    de: "Konfiguriere detaillierte Rollen, Systemanweisungen, Prompt-Richtlinien und empfohlene Prompts für alle Agenten dieses Unternehmens.",
    es: "Configura roles detallados, instrucciones del sistema, pautas de prompts y prompts recomendados para todos los agentes de esta empresa.",
    it: "Configura ruoli dettagliati, istruzioni di sistema, linee guida dei prompt e prompt consigliati per tutti gli agenti di questa azienda.",
    pl: "Skonfiguruj szczegółowe role, instrukcje systemowe, wytyczne promptów i zalecane prompty dla wszystkich agentów tej firmy.",
    pt: "Configure funções detalhadas, instruções do sistema, diretrizes de prompts e prompts recomendados para todos os agentes desta empresa.",
    nl: "Configureer gedetailleerde rollen, systeeminstructies, promptrichtlijnen en aanbevolen prompts voor alle agenten van dit bedrijf.",
    tr: "Bu şirketteki tüm ajanlar için ayrıntılı roller, sistem talimatları, istem yönergeleri ve önerilen istemler yapılandır.",
    ru: "Детально настрой роли, системные инструкции, правила промптов и рекомендуемые запросы для всех агентов этой компании.",
    zh: "为该公司的所有智能体详细配置角色、系统指令、提示词指南和推荐提示词。",
    ja: "この会社のすべてのエージェントに、詳細な役割、システム指示、プロンプトガイドライン、推奨プロンプトを設定してください。",
    ko: "이 회사의 모든 에이전트에 대해 상세 역할, 시스템 지침, 프롬프트 가이드라인 및 추천 프롬프트를 설정하세요.",
    ar: "اضبط الأدوار وتعليمات النظام وإرشادات المطالبات والمطالبات المقترحة بالتفصيل لجميع وكلاء هذه الشركة.",
    hi: "इस कंपनी के सभी एजेंटों के लिए विस्तृत भूमिकाएँ, सिस्टम निर्देश, प्रॉम्प्ट दिशानिर्देश और सुझाए गए प्रॉम्प्ट सेट करें।",
  };
  return commands[language];
}


export function inferOnboardingScenario(message: string): OnboardingScenario {
  if (/\b(sell|selling|sale)\b|продат|продаю|продавати|продаж|sprzed/i.test(message)) return "seller";
  if (/already have|existing business|my business|running business|маю бізнес|мій бізнес|вже є бізнес|існуюч/i.test(message)) return "existing";
  return "starting";
}

export function isSimpleGreeting(message: string) {
  const normalized = message.toLocaleLowerCase().replace(/[^\p{L}]+/gu, " ").trim();
  return /^(привіт|вітаю|добрий день|добрий вечір|доброго дня|доброго вечора|hello|hi|hey|greetings)$/.test(normalized);
}

export function quickOnboardingReply(message: string) {
  const normalized = message.toLocaleLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
  if (/(поясн(?:и|іть).*npati|як працює.*npati|how does.*npati.*work|explain how.*npati)/iu.test(normalized)) {
    return /[іїєґ]/iu.test(normalized)
      ? "NPATI Agent: це AI-асистент для роботи з бізнесом. Він відповідає на запитання, допомагає досліджувати ринок, формувати цілі й планувати наступні дії, використовуючи контекст вибраної Business Idea."
      : "NPATI Agent is an AI assistant for business work. It answers questions, helps research markets, define goals, and plan next actions using the selected Business Idea as context.";
  }
  if (/(дослід.*попит|попит.*ринк|research market demand)/iu.test(normalized)) {
    return /[іїєґ]/iu.test(normalized)
      ? "Щоб перевірити попит, визначте цільового покупця, зберіть пошукові запити й відгуки конкурентів, поговоріть із 10-15 потенційними клієнтами та протестуйте просту пропозицію або передзамовлення. Реальні заявки важливіші за загальні позитивні відповіді."
      : "To test demand, define the target buyer, review search behavior and competitor feedback, interview 10-15 potential customers, and test a simple offer or preorder. Real signups matter more than general positive comments.";
  }
  if (/(business ideas|бізнес.?іде|іде.*бізнес)/iu.test(normalized) && /(brainstorm|придум|згенер|допомож)/iu.test(normalized)) {
    return /[іїєґ]/iu.test(normalized)
      ? "Почніть із трьох речей: ваші сильні навички, проблема конкретної аудиторії та спосіб швидко перевірити готовність платити. Я можу запропонувати ідеї, якщо ви напишете країну, досвід і приблизний бюджет."
      : "Start with three things: your strongest skills, a specific audience problem, and a quick way to test willingness to pay. I can suggest ideas if you share your country, experience, and approximate budget.";
  }
  return undefined;
}

export function isLikelyOnboardingAside(message: string) {
  const normalized = message.toLocaleLowerCase().trim();
  return /\?$/.test(normalized) || /^(як|що|чому|навіщо|де|коли|хто|поясн(?:и|іть)|розкаж(?:и|іть)|можеш|how|what|why|where|when|who|explain|tell me|can you|could you)\b/iu.test(normalized);
}

export function onboardingGoalQuestion(message: string) {
  return /[іїєґ]/iu.test(message)
    ? "Добре, контекст бізнесу збережено. Якої першої конкретної цілі ви хочете досягти? Наприклад: отримати перших 1 000 клієнтів."
    : "Good, the business context is saved. What is the first concrete goal you want to achieve? For example: get your first 1,000 customers.";
}

export function conversationTitle(message: string) {
  const normalized = message
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, "$1 $2")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[#*_\x60\s]+|[#*_\x60\s]+$/g, "")
    .trim();
  return Array.from(normalized).slice(0, 72).join("") || "New conversation";
}

