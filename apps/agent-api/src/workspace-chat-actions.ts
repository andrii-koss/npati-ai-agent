import { createHash } from "node:crypto";
import type { AuthContext, Business, Company, CompanyAgentRunDetails, CompanyRunMode, MemoryInput, WorkspaceStore } from "@npati/workspace";
import type { CompanyAutomation, CompanyAutomationsRepository } from "./automations-repository";
import { computeNextCronDate, isValidCronExpression } from "./automation-scheduler";
import { chatLanguageInstruction, detectCompanyChatLanguage } from "./company-chat-i18n";
import { ContentLibraryStore, type ContentLibraryType } from "./content-library-store";

type WorkspaceActionKind = "activity.run" | "activity.cancel" | "automation.create" | "automation.update" | "automation.delete" | "content.create" | "content.update" | "content.delete" | "memory.create" | "memory.update" | "memory.delete";
type ContentType = "article" | "seo_blueprint" | "social_post" | "brief" | "strategy" | "other";

type WorkspaceDirective = {
  action: WorkspaceActionKind;
  companyId?: string;
  companyName?: string;
  businessId?: string;
  businessName?: string;
  automationId?: string;
  automationName?: string;
  contentId?: string;
  contentTitle?: string;
  memoryId?: string;
  memoryTitle?: string;
  intro?: string;
  followUp?: string;
  activity?: { runId?: string; title?: string; task?: string; mode?: CompanyRunMode };
  automation?: { name?: string; description?: string; prompt?: string; cronExpression?: string; timezone?: string; agentId?: string | null; status?: "active" | "paused" };
  content?: { title?: string; type?: ContentType; content?: string; task?: string; mode?: CompanyRunMode };
  memory?: { type?: MemoryInput["type"]; title?: string; content?: string; confidence?: number };
};

export type WorkspaceChatActionResult = {
  cleanText: string;
  workspaceAction?: { action: WorkspaceActionKind; resourceId: string; companyId?: string; businessId?: string };
  companyRunId?: string;
};

export type WorkspaceChatActionDependencies = {
  store: WorkspaceStore;
  automations: CompanyAutomationsRepository;
  content: ContentLibraryStore;
  runCompany: (auth: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode }, idempotencyKey: string) => Promise<CompanyAgentRunDetails>;
  cancelCompanyRun: (auth: AuthContext, companyId: string, runId: string) => Promise<CompanyAgentRunDetails>;
};

const memoryTypes = new Set<MemoryInput["type"]>(["business_fact", "audience", "brand", "preference", "decision", "product", "channel", "experiment", "result", "other"]);
const contentTypes = new Set<ContentType>(["article", "seo_blueprint", "social_post", "brief", "strategy", "other"]);
const runModes = new Set<CompanyRunMode>(["auto", "single", "pipeline", "fusion"]);

type CardCopy = { type: string; business: string; confidence: string; company: string; status: string; active: string; completed: string; schedule: string; timezone: string; nextRun: string; mode: string; steps: string; toolCalls: string; duration: string; openMemory: string; openAutomations: string; openActivity: string; openContent: string };
const cardCopies: Record<string, CardCopy> = {
  en: { type: "Type", business: "Business", confidence: "Confidence", company: "Company", status: "Status", active: "Active", completed: "Completed", schedule: "Schedule", timezone: "Timezone", nextRun: "Next run", mode: "Mode", steps: "Steps", toolCalls: "Tool calls", duration: "Duration", openMemory: "Open Business Memory", openAutomations: "Open Automations", openActivity: "Open Activity & Run Trace", openContent: "Open Content Hub" },
  uk: { type: "Тип", business: "Бізнес", confidence: "Достовірність", company: "Компанія", status: "Статус", active: "Активна", completed: "Завершено", schedule: "Розклад", timezone: "Часовий пояс", nextRun: "Наступний запуск", mode: "Режим", steps: "Кроки", toolCalls: "Виклики інструментів", duration: "Тривалість", openMemory: "Відкрити пам’ять бізнесу", openAutomations: "Відкрити автоматизації", openActivity: "Відкрити журнал активності", openContent: "Відкрити Content Hub" },
  fr: { type: "Type", business: "Entreprise", confidence: "Confiance", company: "Société", status: "Statut", active: "Active", completed: "Terminé", schedule: "Planification", timezone: "Fuseau horaire", nextRun: "Prochaine exécution", mode: "Mode", steps: "Étapes", toolCalls: "Appels d’outils", duration: "Durée", openMemory: "Ouvrir la mémoire métier", openAutomations: "Ouvrir les automatisations", openActivity: "Ouvrir l’activité et la trace", openContent: "Ouvrir le centre de contenu" },
  de: { type: "Typ", business: "Geschäft", confidence: "Vertrauen", company: "Unternehmen", status: "Status", active: "Aktiv", completed: "Abgeschlossen", schedule: "Zeitplan", timezone: "Zeitzone", nextRun: "Nächste Ausführung", mode: "Modus", steps: "Schritte", toolCalls: "Werkzeugaufrufe", duration: "Dauer", openMemory: "Geschäftsgedächtnis öffnen", openAutomations: "Automatisierungen öffnen", openActivity: "Aktivität und Ablauf öffnen", openContent: "Content Hub öffnen" },
  es: { type: "Tipo", business: "Negocio", confidence: "Confianza", company: "Empresa", status: "Estado", active: "Activa", completed: "Completado", schedule: "Programación", timezone: "Zona horaria", nextRun: "Próxima ejecución", mode: "Modo", steps: "Pasos", toolCalls: "Llamadas de herramientas", duration: "Duración", openMemory: "Abrir memoria del negocio", openAutomations: "Abrir automatizaciones", openActivity: "Abrir actividad y trazas", openContent: "Abrir Content Hub" },
  it: { type: "Tipo", business: "Attività", confidence: "Affidabilità", company: "Azienda", status: "Stato", active: "Attiva", completed: "Completato", schedule: "Pianificazione", timezone: "Fuso orario", nextRun: "Prossima esecuzione", mode: "Modalità", steps: "Passaggi", toolCalls: "Chiamate agli strumenti", duration: "Durata", openMemory: "Apri memoria aziendale", openAutomations: "Apri automazioni", openActivity: "Apri attività e traccia", openContent: "Apri Content Hub" },
  pl: { type: "Typ", business: "Firma", confidence: "Pewność", company: "Firma", status: "Status", active: "Aktywna", completed: "Ukończono", schedule: "Harmonogram", timezone: "Strefa czasowa", nextRun: "Następne uruchomienie", mode: "Tryb", steps: "Kroki", toolCalls: "Wywołania narzędzi", duration: "Czas trwania", openMemory: "Otwórz pamięć firmy", openAutomations: "Otwórz automatyzacje", openActivity: "Otwórz aktywność i ślad", openContent: "Otwórz Content Hub" },
  pt: { type: "Tipo", business: "Negócio", confidence: "Confiança", company: "Empresa", status: "Status", active: "Ativa", completed: "Concluído", schedule: "Agenda", timezone: "Fuso horário", nextRun: "Próxima execução", mode: "Modo", steps: "Etapas", toolCalls: "Chamadas de ferramentas", duration: "Duração", openMemory: "Abrir memória do negócio", openAutomations: "Abrir automações", openActivity: "Abrir atividade e rastreamento", openContent: "Abrir Content Hub" },
  nl: { type: "Type", business: "Bedrijf", confidence: "Betrouwbaarheid", company: "Bedrijf", status: "Status", active: "Actief", completed: "Voltooid", schedule: "Planning", timezone: "Tijdzone", nextRun: "Volgende uitvoering", mode: "Modus", steps: "Stappen", toolCalls: "Toolaanroepen", duration: "Duur", openMemory: "Bedrijfsgeheugen openen", openAutomations: "Automatiseringen openen", openActivity: "Activiteit en trace openen", openContent: "Content Hub openen" },
  tr: { type: "Tür", business: "İşletme", confidence: "Güven", company: "Şirket", status: "Durum", active: "Aktif", completed: "Tamamlandı", schedule: "Program", timezone: "Saat dilimi", nextRun: "Sonraki çalışma", mode: "Mod", steps: "Adımlar", toolCalls: "Araç çağrıları", duration: "Süre", openMemory: "İşletme hafızasını aç", openAutomations: "Otomasyonları aç", openActivity: "Etkinlik ve çalışma izini aç", openContent: "Content Hub’ı aç" },
  ru: { type: "Тип", business: "Бизнес", confidence: "Достоверность", company: "Компания", status: "Статус", active: "Активна", completed: "Завершено", schedule: "Расписание", timezone: "Часовой пояс", nextRun: "Следующий запуск", mode: "Режим", steps: "Шаги", toolCalls: "Вызовы инструментов", duration: "Длительность", openMemory: "Открыть память бизнеса", openAutomations: "Открыть автоматизации", openActivity: "Открыть активность и трассировку", openContent: "Открыть Content Hub" },
  zh: { type: "类型", business: "业务", confidence: "可信度", company: "公司", status: "状态", active: "启用", completed: "已完成", schedule: "计划", timezone: "时区", nextRun: "下次运行", mode: "模式", steps: "步骤", toolCalls: "工具调用", duration: "耗时", openMemory: "打开业务记忆", openAutomations: "打开自动化", openActivity: "打开活动与运行跟踪", openContent: "打开内容中心" },
  ja: { type: "種類", business: "ビジネス", confidence: "信頼度", company: "会社", status: "状態", active: "有効", completed: "完了", schedule: "スケジュール", timezone: "タイムゾーン", nextRun: "次回実行", mode: "モード", steps: "ステップ", toolCalls: "ツール呼び出し", duration: "所要時間", openMemory: "ビジネスメモリを開く", openAutomations: "自動化を開く", openActivity: "アクティビティと実行トレースを開く", openContent: "コンテンツハブを開く" },
  ko: { type: "유형", business: "비즈니스", confidence: "신뢰도", company: "회사", status: "상태", active: "활성", completed: "완료", schedule: "일정", timezone: "시간대", nextRun: "다음 실행", mode: "모드", steps: "단계", toolCalls: "도구 호출", duration: "소요 시간", openMemory: "비즈니스 메모리 열기", openAutomations: "자동화 열기", openActivity: "활동 및 실행 추적 열기", openContent: "콘텐츠 허브 열기" },
  ar: { type: "النوع", business: "النشاط التجاري", confidence: "الثقة", company: "الشركة", status: "الحالة", active: "نشطة", completed: "مكتمل", schedule: "الجدول", timezone: "المنطقة الزمنية", nextRun: "التشغيل التالي", mode: "الوضع", steps: "الخطوات", toolCalls: "استدعاءات الأدوات", duration: "المدة", openMemory: "فتح ذاكرة النشاط التجاري", openAutomations: "فتح عمليات الأتمتة", openActivity: "فتح النشاط وتتبع التنفيذ", openContent: "فتح مركز المحتوى" },
  hi: { type: "प्रकार", business: "व्यवसाय", confidence: "विश्वसनीयता", company: "कंपनी", status: "स्थिति", active: "सक्रिय", completed: "पूर्ण", schedule: "समय-सारणी", timezone: "समय क्षेत्र", nextRun: "अगला रन", mode: "मोड", steps: "चरण", toolCalls: "टूल कॉल", duration: "अवधि", openMemory: "व्यवसाय मेमोरी खोलें", openAutomations: "ऑटोमेशन खोलें", openActivity: "गतिविधि और रन ट्रेस खोलें", openContent: "कंटेंट हब खोलें" },
};

function copyFor(message = ""): CardCopy {
  return cardCopies[detectCompanyChatLanguage(message)] ?? cardCopies.en!;
}

const actionSignals = [
  /\b(?:create|add|schedule|run|start|save|remember|generate|write|prepare|configure|edit|update|change|delete|remove|pause|resume|cancel)\b/iu,
  /(?:створ|дод|заплан|запуст|почн|збереж|запам.?ят|генер|напиш|підгот|налашт|редаг|змін|онов|видал|приб|призуп|віднов|скас)/iu,
  /(?:cré\p{L}*|ajout\p{L}*|planifi\p{L}*|lanc\p{L}*|enregistr\p{L}*|mémoris\p{L}*|génér\p{L}*|écri\p{L}*|configur\p{L}*|modifi\p{L}*|mettr\p{L}* à jour|supprim\p{L}*|retir\p{L}*|suspend\p{L}*|repren\p{L}*|annul\p{L}*)/iu,
  /(?:erstell\p{L}*|hinzufüg\p{L}*|plan\p{L}*|start\p{L}*|speicher\p{L}*|merk\p{L}*|generier\p{L}*|schreib\p{L}*|konfigurier\p{L}*|bearbeit\p{L}*|aktualisier\p{L}*|änder\p{L}*|lösch\p{L}*|entfern\p{L}*|pausier\p{L}*|fortsetz\p{L}*|abbrech\p{L}*)/iu,
  /(?:crea\p{L}*|añad\p{L}*|program\p{L}*|inici\p{L}*|guard\p{L}*|record\p{L}*|gener\p{L}*|escri\p{L}*|configur\p{L}*|edit\p{L}*|actualiz\p{L}*|cambi\p{L}*|elimin\p{L}*|borr\p{L}*|paus\p{L}*|reanud\p{L}*|cancel\p{L}*)/iu,
  /(?:crea\p{L}*|aggiung\p{L}*|pianific\p{L}*|avvi\p{L}*|salv\p{L}*|ricord\p{L}*|gener\p{L}*|scriv\p{L}*|configur\p{L}*|modific\p{L}*|aggiorn\p{L}*|cambi\p{L}*|elimin\p{L}*|rimuov\p{L}*|sospend\p{L}*|riprend\p{L}*|annull\p{L}*)/iu,
  /(?:utwórz|dodaj|zaplanuj|uruchom|zapisz|zapamiętaj|wygeneruj|napisz|skonfiguruj|edytuj|zaktualizuj|zmień|usuń|wstrzymaj|wznów|anuluj)/iu,
  /(?:cri\p{L}*|adicion\p{L}*|agend\p{L}*|inici\p{L}*|salv\p{L}*|lembr\p{L}*|ger\p{L}*|escrev\p{L}*|configur\p{L}*|edit\p{L}*|atualiz\p{L}*|alter\p{L}*|exclu\p{L}*|remov\p{L}*|paus\p{L}*|retom\p{L}*|cancel\p{L}*)/iu,
  /(?:maak|maken|toevoeg\p{L}*|plan\p{L}*|start\p{L}*|opsla\p{L}*|onthoud\p{L}*|genere\p{L}*|schrijf\p{L}*|configure\p{L}*|bewerk\p{L}*|werk\p{L}* bij|wijzig\p{L}*|verwijder\p{L}*|pauzeer\p{L}*|hervat\p{L}*|annuleer\p{L}*)/iu,
  /(?:oluştur|ekle|planla|başlat|kaydet|hatırla|üret|yaz|yapılandır|düzenle|güncelle|değiştir|sil|kaldır|duraklat|sürdür|iptal)/iu,
  /(?:созда|добав|заплан|запуст|сохран|запом|сгенер|напиш|настро|редакт|измен|обнов|удал|приостанов|возобнов|отмен)/iu,
  /(?:创建|新增|添加|安排|运行|开始|保存|记住|生成|撰写|配置|编辑|更新|修改|删除|移除|暂停|恢复|取消)/u,
  /(?:作成|追加|予定|実行|開始|保存|記憶|生成|書いて|設定|編集|更新|変更|削除|一時停止|再開|キャンセル)/u,
  /(?:생성|추가|예약|실행|시작|저장|기억|작성|설정|편집|업데이트|변경|삭제|제거|일시 중지|재개|취소)/u,
  /(?:أنشئ|إنشاء|أضف|جدول|شغل|ابدأ|احفظ|تذكر|اكتب|كوّن|حرر|حدث|غيّر|احذف|أزل|أوقف|استأنف|ألغ)/u,
  /(?:बनाएं|बनाओ|जोड़ें|शेड्यूल|चलाएं|शुरू|सहेजें|याद|लिखें|कॉन्फ़िगर|संपादित|अपडेट|बदलें|हटाएं|रोकें|फिर शुरू|रद्द)/u,
];

const resourceSignals = [
  /\b(?:activit(?:y|ies)|run trace|execution trace|automation|scheduled task|cron job|content hub|article|seo blueprint|social draft|business memory|memory item|memory|brand voice|audience profile)\b/iu,
  /(?:активност|трасуван|запуск|автоматизац|запланован.*завдан|контент|статт|seo|соціальн.*допис|пам.?ят|мемор|тон.*бренд|аудитор)/iu,
  /(?:activité|trace d.exécution|automatisation|tâche planifiée|contenu|article|mémoire|voix de marque|audience)/iu,
  /(?:aktivität|ausführungsspur|automatisierung|geplante aufgabe|inhalt|artikel|gedächtnis|markenstimme|zielgruppe)/iu,
  /(?:actividad|traza de ejecución|automatización|tarea programada|contenido|artículo|memoria|voz de marca|audiencia)/iu,
  /(?:attività|traccia di esecuzione|automazione|attività pianificata|contenuto|articolo|memoria|voce del marchio|pubblico)/iu,
  /(?:aktywno\p{L}*|ślad wykonania|automatyza\p{L}*|zaplanowane zadanie|treś\p{L}*|artyku\p{L}*|pamię\p{L}*|głos marki|odbiorcy)/iu,
  /(?:atividade|rastreamento de execução|automação|tarefa agendada|conteúdo|artigo|memória|voz da marca|público)/iu,
  /(?:activiteit|uitvoeringstrace|automatisering|geplande taak|inhoud|artikel|geheugen|merkstem|doelgroep)/iu,
  /(?:etkinlik|çalıştırma izi|otomasyon|zamanlanmış görev|içerik|makale|hafıza|marka sesi|hedef kitle)/iu,
  /(?:активност|трассиров|запуск|автоматизац|запланирован.*задач|контент|стать|памят|голос.*бренд|аудитор)/iu,
  /(?:活动|运行跟踪|执行跟踪|自动化|定时任务|内容|文章|记忆|品牌语气|受众)/u,
  /(?:アクティビティ|実行トレース|自動化|スケジュール.*タスク|コンテンツ|記事|メモリ|ブランドボイス|対象者)/u,
  /(?:활동|실행 추적|자동화|예약 작업|콘텐츠|기사|메모리|브랜드 보이스|대상 고객)/u,
  /(?:نشاط|تتبع التنفيذ|أتمتة|مهمة مجدولة|محتوى|مقال|ذاكرة|صوت العلامة|الجمهور)/u,
  /(?:गतिविधि|निष्पादन ट्रेस|ऑटोमेशन|निर्धारित कार्य|सामग्री|लेख|मेमोरी|ब्रांड वॉइस|दर्शक)/u,
];

const mutationSignals = [
  /\b(?:edit|update|change|delete|remove|pause|resume|cancel)\b/iu,
  /(?:редаг|змін|онов|видал|приб|призуп|віднов|скас)/iu,
  /(?:modifi|mettre à jour|supprim|retir|suspend|repren|annul)/iu,
  /(?:bearbeit|aktualisier|änder|lösch|entfern|pausier|fortsetz|abbrech)/iu,
  /(?:edit|actualiz|cambi|elimin|borr|paus|reanud|cancel)/iu,
  /(?:modific|aggiorn|cambi|elimin|rimuov|sospend|riprend|annull)/iu,
  /(?:edytuj|zaktualizuj|zmień|usuń|wstrzymaj|wznów|anuluj)/iu,
  /(?:edit|atualiz|alter|exclu|remov|paus|retom|cancel)/iu,
  /(?:bewerk|werk.*bij|wijzig|verwijder|pauzeer|hervat|annuleer)/iu,
  /(?:düzenle|güncelle|değiştir|sil|kaldır|duraklat|sürdür|iptal)/iu,
  /(?:редакт|измен|обнов|удал|приостанов|возобнов|отмен)/iu,
  /(?:编辑|更新|修改|删除|移除|暂停|恢复|取消)/u,
  /(?:編集|更新|変更|削除|一時停止|再開|キャンセル)/u,
  /(?:편집|업데이트|변경|삭제|제거|일시 중지|재개|취소)/u,
  /(?:حرر|حدث|غيّر|احذف|أزل|أوقف|استأنف|ألغ)/u,
  /(?:संपादित|अपडेट|बदलें|हटाएं|रोकें|फिर शुरू|रद्द)/u,
];
const referenceSignals = [
  /\b(?:it|this|that|one|last|previous)\b/iu,
  /(?:її|його|це|цю|цей|останн|попередн)/iu,
  /\b(?:le|la|les|ceci|cela|dernier|précédent)\b/iu,
  /\b(?:es|dies|diese|letzte|vorherige)\b/iu,
  /\b(?:lo|la|esto|esta|últim|anterior)\b/iu,
  /\b(?:lo|la|quest|ultim|precedent)\b/iu,
  /\b(?:to|ten|ta|ostatni|poprzedni)\b/iu,
  /\b(?:isso|isto|este|esta|últim|anterior)\b/iu,
  /\b(?:het|dit|deze|laatste|vorige)\b/iu,
  /\b(?:onu|bunu|şunu|son|önceki)\b/iu,
  /(?:её|его|это|эту|этот|последн|предыдущ)/iu,
  /(?:它|这个|这条|最后|上一个)/u,
  /(?:それ|これ|この|最後|前の)/u,
  /(?:그것|이것|이 항목|마지막|이전)/u,
  /(?:إياه|إياها|هذا|هذه|الأخير|السابق)/u,
  /(?:इसे|यह|इसको|अंतिम|पिछल)/u,
];

function clean(value: unknown, max = 12_000): string {
  if (typeof value !== "string") return "";
  return value.replace(/```/g, "'''").trim().slice(0, max);
}

function fenced(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/```workspace-action\s*([\s\S]*?)```/gi)];
}

async function companies(store: WorkspaceStore, auth: AuthContext): Promise<Company[]> {
  const result: Company[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listCompanies(auth, 100, cursor);
    result.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && result.length < 500);
  return result;
}

async function resolveCompany(store: WorkspaceStore, auth: AuthContext, directive: WorkspaceDirective, selectedCompanyId?: string): Promise<Company> {
  if (directive.companyId) return store.getCompany(auth, directive.companyId);
  if (selectedCompanyId) return store.getCompany(auth, selectedCompanyId);
  const all = await companies(store, auth);
  const name = directive.companyName?.trim().toLocaleLowerCase();
  const matches = name ? all.filter((item) => item.name.toLocaleLowerCase() === name) : all;
  if (matches.length !== 1) throw new Error(matches.length ? "Specify which company to use" : "Create a company before using this action");
  return matches[0]!;
}

async function resolveBusiness(store: WorkspaceStore, auth: AuthContext, directive: WorkspaceDirective, selectedBusinessId?: string): Promise<Business> {
  if (directive.businessId) return store.getUserBusiness(auth, directive.businessId);
  if (selectedBusinessId) return store.getUserBusiness(auth, selectedBusinessId);
  const all = await store.listUserBusinesses(auth);
  const name = directive.businessName?.trim().toLocaleLowerCase();
  const matches = name ? all.filter((item) => item.name.toLocaleLowerCase() === name) : all;
  if (matches.length !== 1) throw new Error(matches.length ? "Specify which business to use" : "Create a business profile before adding memory");
  return matches[0]!;
}

function intro(directive: WorkspaceDirective): string {
  return clean(directive.intro, 500) || "✓";
}

function followUp(directive: WorkspaceDirective): string {
  return clean(directive.followUp, 700);
}

function finish(directive: WorkspaceDirective, card: string): string {
  return `${intro(directive)}\n\n${card}${followUp(directive) ? `\n\n${followUp(directive)}` : ""}`;
}

function automationSettingsUrl(_companyId: string): string {
  return "/settings/automations";
}

function idempotency(auth: AuthContext, conversationId: string, requestMessage: string, action: string): string {
  return createHash("sha256").update(`${auth.workspaceId}:${auth.userId}:${conversationId}:${requestMessage}:${action}`).digest("hex");
}

function contentType(value: ContentType): ContentLibraryType {
  if (value === "seo_blueprint") return "seo_structure";
  if (value === "social_post") return "social_post";
  if (value === "brief" || value === "strategy") return "brief";
  return "article";
}

function contentTask(task: string): { title?: string; type: ContentLibraryType } {
  const match = task.match(/^\[NPATI_CONTENT:(article|seo_blueprint|social_post|brief|strategy|other):([A-Za-z0-9_-]+)\]/);
  if (!match) return { type: "article" };
  try { return { title: Buffer.from(match[2]!, "base64url").toString("utf8"), type: contentType(match[1] as ContentType) }; }
  catch { return { type: contentType(match[1] as ContentType) }; }
}

export class WorkspaceChatActions {
  static isManagementRequest(message: string): boolean {
    return actionSignals.some((pattern) => pattern.test(message)) && resourceSignals.some((pattern) => pattern.test(message));
  }

  static isPotentialMutationRequest(message: string): boolean {
    return mutationSignals.some((pattern) => pattern.test(message)) && referenceSignals.some((pattern) => pattern.test(message));
  }

  static noActionMessage(message: string): string {
    const language = detectCompanyChatLanguage(message);
    const messages: Partial<Record<typeof language, string>> = {
      uk: "Не вдалося безпечно виконати цю дію. Уточніть компанію або бізнес і потрібні параметри.",
      fr: "Je n’ai pas pu exécuter cette action en toute sécurité. Précisez l’entreprise et les paramètres nécessaires.",
      de: "Diese Aktion konnte nicht sicher ausgeführt werden. Bitte geben Sie das Unternehmen und die erforderlichen Angaben an.",
      es: "No pude ejecutar esta acción de forma segura. Especifica la empresa y los parámetros necesarios.",
      zh: "无法安全执行此操作。请指定公司或业务以及所需参数。",
      ja: "この操作を安全に実行できませんでした。会社またはビジネスと必要な設定を指定してください。",
      ko: "이 작업을 안전하게 실행할 수 없습니다. 회사 또는 비즈니스와 필요한 설정을 지정해 주세요.",
      ar: "تعذر تنفيذ هذا الإجراء بأمان. حدد الشركة أو النشاط التجاري والإعدادات المطلوبة.",
      hi: "यह कार्रवाई सुरक्षित रूप से पूरी नहीं हो सकी। कंपनी या व्यवसाय और आवश्यक विवरण बताएं।",
    };
    return messages[language] ?? "I could not complete this action safely. Specify the company or business and the required settings.";
  }

  static async buildSystemPrompt(auth: AuthContext, store: WorkspaceStore, message: string, selectedCompanyId?: string, selectedBusinessId?: string, resources?: { automations: CompanyAutomationsRepository; content: ContentLibraryStore }): Promise<string> {
    if (!auth.permissions.includes("business:manage")) return "";
    if (!resourceSignals.some((pattern) => pattern.test(message)) && !((selectedCompanyId || selectedBusinessId) && this.isPotentialMutationRequest(message))) return "";
    const ownedCompanies = await companies(store, auth);
    const ownedBusinesses = await store.listUserBusinesses(auth);
    const companyContext = await Promise.all(ownedCompanies.slice(0, 30).map(async (company) => ({
      id: company.id,
      name: company.name,
      businessId: company.businessId,
      mainAgentId: company.mainAgentId,
      agents: (await store.listCompanyAgentsPage(auth, company.id, 50)).items.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role, active: agent.isActive })),
    })));
    const memoryContext = await Promise.all(ownedBusinesses.slice(0, 30).map(async (business) => ({
      id: business.id,
      name: business.name,
      memory: (await store.listMemory(auth, business.id)).slice(0, 50).map((item) => ({ id: item.id, type: item.type, title: item.title, content: item.content, confidence: item.confidence })),
    })));
    const overrides = resources ? await resources.content.list(auth) : {};
    const automationContext = resources ? (await Promise.all(ownedCompanies.slice(0, 30).map(async (company) =>
      (await resources.automations.list(auth, company.id)).map((item) => ({ id: item.id, companyId: company.id, companyName: company.name, name: item.name, description: item.description, prompt: item.prompt, cronExpression: item.cronExpression, timezone: item.timezone, agentId: item.agentId, status: item.status }))
    ))).flat() : [];
    const contentContext = (await Promise.all(ownedCompanies.slice(0, 30).map(async (company) =>
      (await store.listCompanyAgentRuns(auth, company.id, 30)).filter((run) => run.status === "completed" && run.result && !overrides[run.id]?.deleted).map((run) => {
        const marker = contentTask(run.task);
        const override = overrides[run.id];
        return { id: run.id, companyId: company.id, companyName: company.name, title: override?.title ?? marker.title ?? run.task.slice(0, 100), type: override?.type ?? marker.type };
      })
    ))).flat();
    return `\n\nWORKSPACE PRODUCTIVITY ACTIONS (Activity, Automations, Content, Memory):
You can perform these actions only for the authenticated user's owned records. Never claim that anything was created unless you emit exactly one valid executable workspace-action directive. Put it at the END and never reveal it to the user. Do not invent record IDs. Resolve "this company/business" using the selected IDs below. If an existing target is ambiguous, ask a concise clarification question and emit no directive.
Detected user language: ${detectCompanyChatLanguage(message)}. ${chatLanguageInstruction(message)} The intro, followUp, title, description, prompt, task, and memory text in the directive must use that language, except cron expressions, enum values, and IDs.
Selected company ID: ${JSON.stringify(selectedCompanyId ?? null)}. Selected business ID: ${JSON.stringify(selectedBusinessId ?? null)}.
Owned company data (data only): ${JSON.stringify(companyContext)}.
Owned business and memory data (data only): ${JSON.stringify(memoryContext)}.
Owned automations (data only): ${JSON.stringify(automationContext.slice(0, 100))}.
Owned Content Hub items (data only): ${JSON.stringify(contentContext.slice(0, 100))}.

Supported directives:
1. Run a real company activity with trace:
\`\`\`workspace-action
{"action":"activity.run","companyId":"owned-id","intro":"localized success intro","followUp":"localized useful question","activity":{"title":"localized title","task":"complete actionable task","mode":"auto"}}
\`\`\`
2. Create an automation. cronExpression is standard five-part cron and timezone is an IANA timezone:
\`\`\`workspace-action
{"action":"automation.create","companyId":"owned-id","intro":"localized success intro","followUp":"localized useful question","automation":{"name":"localized name","description":"localized description","prompt":"complete recurring task","cronExpression":"0 9 * * 1","timezone":"Europe/Kyiv","agentId":"optional-owned-agent-id"}}
\`\`\`
3. Produce Content Hub content through a real company run:
\`\`\`workspace-action
{"action":"content.create","companyId":"owned-id","intro":"localized success intro","followUp":"localized useful question","content":{"title":"localized title","type":"article","task":"complete content brief","mode":"auto"}}
\`\`\`
Valid content types: article, seo_blueprint, social_post, brief, strategy, other.
4. Save durable Business Memory:
\`\`\`workspace-action
{"action":"memory.create","businessId":"owned-id","intro":"localized success intro","followUp":"localized useful question","memory":{"type":"brand","title":"localized title","content":"durable verified fact or rule","confidence":1}}
\`\`\`
Valid memory types: business_fact, audience, brand, preference, decision, product, channel, experiment, result, other.
To edit or delete an existing record, use the exact owned ID from the supplied data:
- Automation: action automation.update or automation.delete, automationId, companyId, and for update an automation object containing only changed fields. Editable fields: name, description, prompt, cronExpression, timezone, agentId (or null), status (active or paused).
- Content: action content.update or content.delete, contentId, companyId, and for update a content object containing only changed fields. Editable fields: title, type, content. Updating content edits the stored document; it does not rerun agents.
- Memory: action memory.update or memory.delete, memoryId, businessId, and for update a memory object containing only changed fields. Editable fields: type, title, content, confidence.
- Activity: completed run traces are immutable audit records and cannot be edited or deleted. An active run may be cancelled with action activity.cancel, companyId, and activity.runId. If asked to alter a completed result, offer a new activity instead.
Use activity.run when the user asks the company agents to perform work and wants a trace. Use content.create for a durable article, SEO blueprint, social draft, brief, or strategy in Content Hub. Never save guesses as Memory. If the user asks for recommendations, recommend missing durable categories from the supplied memory summary (business facts, audience, brand voice, products, channels, decisions, experiments/results) in the user's language; create one only when explicitly requested. Keep intro concise, put the verified details in the server-rendered card, and end followUp with a useful next question.`;
  }

  static async buildActionPlannerPrompt(auth: AuthContext, deps: WorkspaceChatActionDependencies, message: string, selectedCompanyId?: string, selectedBusinessId?: string): Promise<string> {
    return `${await this.buildSystemPrompt(auth, deps.store, message, selectedCompanyId, selectedBusinessId, deps)}\n\nThe latest user message is an explicit request for one of the supported workspace actions. Return ONLY one complete workspace-action block. Do not state that it succeeded. Use NO_ACTION if required data is missing or the target is ambiguous.`;
  }

  static async extractAndExecute(auth: AuthContext, text: string, deps: WorkspaceChatActionDependencies, conversationId: string, options: { requestMessage?: string; selectedCompanyId?: string; selectedBusinessId?: string; onError?: (error: unknown) => void } = {}): Promise<WorkspaceChatActionResult> {
    const matches = fenced(text);
    if (!matches[0]) return /```workspace-action/i.test(text) ? { cleanText: this.noActionMessage(options.requestMessage ?? "") } : { cleanText: text };
    try {
      if (!auth.permissions.includes("business:manage")) throw new Error("Permission denied");
      if (matches.length !== 1) throw new Error("Use one action per response");
      const directive = JSON.parse(matches[0][1]!.trim()) as WorkspaceDirective;
      if (!directive || !["activity.run", "activity.cancel", "automation.create", "automation.update", "automation.delete", "content.create", "content.update", "content.delete", "memory.create", "memory.update", "memory.delete"].includes(directive.action)) throw new Error("Invalid action");
      const key = idempotency(auth, conversationId, options.requestMessage ?? matches[0][0], directive.action);
      const labels = copyFor(options.requestMessage);

      if (directive.action.startsWith("memory.")) {
        const business = await resolveBusiness(deps.store, auth, directive, options.selectedBusinessId);
        const item = directive.memory;
        if (directive.action !== "memory.create") {
          const available = await deps.store.listMemory(auth, business.id);
          const title = directive.memoryTitle?.trim().toLocaleLowerCase();
          const matches = directive.memoryId ? available.filter((entry) => entry.id === directive.memoryId) : available.filter((entry) => entry.title.toLocaleLowerCase() === title);
          if (matches.length !== 1) throw new Error("Memory target is missing or ambiguous");
          const current = matches[0]!;
          if (directive.action === "memory.delete") {
            await deps.store.deleteMemory(auth, business.id, current.id);
            const card = `\`\`\`card:${clean(current.title, 300)}\n**${labels.business}:** ${clean(business.name, 300)}\n\n[${labels.openMemory}](/settings/memory)\n\`\`\``;
            return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: current.id, businessId: business.id } };
          }
          if (!item) throw new Error("Memory changes are required");
          const patch: Partial<MemoryInput> = {};
          if (item.type !== undefined) { if (!memoryTypes.has(item.type)) throw new Error("Invalid memory type"); patch.type = item.type; }
          if (item.title !== undefined) { if (!clean(item.title, 300)) throw new Error("Invalid memory title"); patch.title = clean(item.title, 300); }
          if (item.content !== undefined) { if (!clean(item.content)) throw new Error("Invalid memory content"); patch.content = clean(item.content); }
          if (item.confidence !== undefined) { if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error("Invalid confidence"); patch.confidence = item.confidence; }
          if (!Object.keys(patch).length) throw new Error("Memory changes are required");
          const updated = await deps.store.updateMemory(auth, business.id, current.id, patch);
          const card = `\`\`\`card:${clean(updated.title, 300)}\n**${labels.type}:** ${updated.type}\n**${labels.business}:** ${clean(business.name, 300)}\n**${labels.confidence}:** ${Math.round((updated.confidence ?? 1) * 100)}%\n\n${clean(updated.content)}\n\n[${labels.openMemory}](/settings/memory)\n\`\`\``;
          return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: updated.id, businessId: business.id } };
        }
        if (!item || !memoryTypes.has(item.type as MemoryInput["type"]) || !clean(item.title, 300) || !clean(item.content)) throw new Error("Invalid memory");
        if (item.confidence !== undefined && (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) throw new Error("Invalid confidence");
        const source = `chat:${key}`;
        const created = (await deps.store.listMemory(auth, business.id)).find((entry) => entry.source === source)
          ?? await deps.store.createMemory(auth, business.id, { type: item.type!, title: clean(item.title, 300), content: clean(item.content), confidence: item.confidence ?? 1, source });
        const card = `\`\`\`card:${clean(created.title, 300)}\n**${labels.type}:** ${created.type}\n**${labels.business}:** ${clean(business.name, 300)}\n**${labels.confidence}:** ${Math.round((created.confidence ?? 1) * 100)}%\n\n${clean(created.content)}\n\n[${labels.openMemory}](/settings/memory)\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: created.id, businessId: business.id } };
      }

      const company = await resolveCompany(deps.store, auth, directive, options.selectedCompanyId);
      if (directive.action.startsWith("automation.")) {
        const item = directive.automation;
        if (directive.action !== "automation.create") {
          const available = await deps.automations.list(auth, company.id);
          const name = directive.automationName?.trim().toLocaleLowerCase();
          const matches = directive.automationId ? available.filter((entry) => entry.id === directive.automationId) : available.filter((entry) => entry.name.toLocaleLowerCase() === name);
          if (matches.length !== 1) throw new Error("Automation target is missing or ambiguous");
          const current = matches[0]!;
          if (directive.action === "automation.delete") {
            if (!await deps.automations.delete(auth, company.id, current.id)) throw new Error("Automation not found");
            const card = `\`\`\`card:${clean(current.name, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n\n[${labels.openAutomations}](${automationSettingsUrl(company.id)})\n\`\`\``;
            return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: current.id, companyId: company.id } };
          }
          if (!item) throw new Error("Automation changes are required");
          if (item.agentId) {
            const agents = await deps.store.listCompanyAgents(auth, company.id);
            if (!agents.some((agent) => agent.id === item.agentId)) throw new Error("Agent is not owned by this company");
          }
          if (item.cronExpression !== undefined && !isValidCronExpression(item.cronExpression)) throw new Error("Invalid automation schedule");
          const update = {
            ...(item.name !== undefined ? { name: clean(item.name, 300) } : {}),
            ...(item.description !== undefined ? { description: clean(item.description, 2000) } : {}),
            ...(item.prompt !== undefined ? { prompt: clean(item.prompt) } : {}),
            ...(item.cronExpression !== undefined ? { cronExpression: item.cronExpression.trim(), nextRunAt: computeNextCronDate(item.cronExpression).toISOString() } : {}),
            ...(item.timezone !== undefined ? { timezone: clean(item.timezone, 100) } : {}),
            ...(item.agentId !== undefined ? { agentId: item.agentId } : {}),
            ...(item.status !== undefined ? { status: item.status } : {}),
          };
          if (!Object.keys(update).length || (item.name !== undefined && !update.name) || (item.prompt !== undefined && !update.prompt)) throw new Error("Invalid automation changes");
          const updated = await deps.automations.update(auth, company.id, current.id, update);
          const card = `\`\`\`card:${clean(updated.name, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${updated.status}\n**${labels.schedule}:** \`${updated.cronExpression}\`\n**${labels.timezone}:** ${clean(updated.timezone, 100)}\n**${labels.nextRun}:** ${updated.nextRunAt}\n\n${clean(updated.description) || clean(updated.prompt)}\n\n[${labels.openAutomations}](${automationSettingsUrl(company.id)})\n\`\`\``;
          return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: updated.id, companyId: company.id } };
        }
        if (!item || !clean(item.name, 300) || !clean(item.prompt) || !item.cronExpression || !isValidCronExpression(item.cronExpression)) throw new Error("Invalid automation");
        if (item.agentId) {
          const agents = await deps.store.listCompanyAgents(auth, company.id);
          if (!agents.some((agent) => agent.id === item.agentId)) throw new Error("Agent is not owned by this company");
        }
        const automationName = clean(item.name, 300);
        const automationPrompt = clean(item.prompt);
        const cronExpression = item.cronExpression.trim();
        const created: CompanyAutomation = (await deps.automations.list(auth, company.id)).find((entry) =>
          entry.name === automationName && entry.prompt === automationPrompt && entry.cronExpression === cronExpression
        ) ?? await deps.automations.create(auth, company.id, {
          name: automationName, description: clean(item.description, 2000) || undefined, prompt: automationPrompt,
          cronExpression, timezone: clean(item.timezone, 100) || "Europe/Kyiv", agentId: item.agentId ?? undefined,
          nextRunAt: computeNextCronDate(cronExpression).toISOString(),
        });
        const card = `\`\`\`card:${clean(created.name, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${labels.active}\n**${labels.schedule}:** \`${created.cronExpression}\`\n**${labels.timezone}:** ${clean(created.timezone, 100)}\n**${labels.nextRun}:** ${created.nextRunAt}\n\n${clean(created.description) || clean(created.prompt)}\n\n[${labels.openAutomations}](${automationSettingsUrl(company.id)})\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: created.id, companyId: company.id } };
      }

      if (directive.action === "activity.cancel") {
        const runId = directive.activity?.runId;
        if (!runId) throw new Error("Run ID is required");
        const current = await deps.store.getCompanyAgentRun(auth, company.id, runId);
        if (["completed", "failed", "cancelled"].includes(current.run.status)) throw new Error("Completed activity traces are immutable");
        const details = await deps.cancelCompanyRun(auth, company.id, runId);
        const card = `\`\`\`card:${clean(current.run.task, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${details.run.status}\n\n[${labels.openActivity}](/settings/activity)\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: runId, companyId: company.id }, companyRunId: runId };
      }

      if (directive.action === "activity.run") {
        const item = directive.activity;
        if (!item || !clean(item.task) || (item.mode && !runModes.has(item.mode))) throw new Error("Invalid activity");
        const details = await deps.runCompany(auth, company.id, { task: clean(item.task), mode: item.mode ?? "auto" }, `chat-activity:${key}`);
        const run = details.run;
        if (run.status !== "completed") throw new Error(run.errorMessage || "Company run did not complete");
        const title = clean(item.title, 300) || clean(run.task, 300);
        const card = `\`\`\`card:${title}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${labels.completed}\n**${labels.mode}:** ${run.executionMode ?? run.requestedMode}\n**${labels.steps}:** ${details.steps.length}\n**${labels.toolCalls}:** ${details.toolAudit.length}\n**${labels.duration}:** ${run.totalDurationMs ?? 0} ms\n\n${clean(run.result) || "✓"}\n\n[${labels.openActivity}](/settings/activity)\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: run.id, companyId: company.id }, companyRunId: run.id };
      }

      const item = directive.content;
      if (directive.action === "content.update" || directive.action === "content.delete") {
        const runs = await deps.store.listCompanyAgentRuns(auth, company.id, 100);
        const overrides = await deps.content.list(auth);
        const title = directive.contentTitle?.trim().toLocaleLowerCase();
        const matches = directive.contentId ? runs.filter((run) => run.id === directive.contentId) : runs.filter((run) => {
          const marker = contentTask(run.task);
          return (overrides[run.id]?.title ?? marker.title ?? run.task.slice(0, 100)).toLocaleLowerCase() === title;
        });
        if (matches.length !== 1 || matches[0]!.status !== "completed" || !matches[0]!.result || overrides[matches[0]!.id]?.deleted) throw new Error("Content target is missing or ambiguous");
        const run = matches[0]!;
        const currentMarker = contentTask(run.task);
        const currentOverride = overrides[run.id];
        const currentTitle = currentOverride?.title ?? currentMarker.title ?? run.task.slice(0, 100);
        if (directive.action === "content.delete") {
          await deps.content.delete(auth, run.id, company.id);
          const card = `\`\`\`card:${clean(currentTitle, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n\n[${labels.openContent}](/settings/content)\n\`\`\``;
          return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: run.id, companyId: company.id } };
        }
        if (!item) throw new Error("Content changes are required");
        const update: { title?: string; type?: ContentLibraryType; content?: string } = {};
        if (item.title !== undefined) { if (!clean(item.title, 300)) throw new Error("Invalid content title"); update.title = clean(item.title, 300); }
        if (item.type !== undefined) { if (!contentTypes.has(item.type)) throw new Error("Invalid content type"); update.type = contentType(item.type); }
        if (item.content !== undefined) { if (!clean(item.content, 200_000)) throw new Error("Invalid content"); update.content = clean(item.content, 200_000); }
        if (!Object.keys(update).length) throw new Error("Content changes are required");
        const updated = await deps.content.update(auth, run.id, company.id, update);
        const card = `\`\`\`card:${clean(updated.title ?? currentTitle, 300)}\n${clean(updated.content ?? currentOverride?.content ?? run.result, 200_000)}\n\n[${labels.openContent}](/settings/content)\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: run.id, companyId: company.id } };
      }
      if (!item || !clean(item.title, 300) || !contentTypes.has(item.type as ContentType) || !clean(item.task) || (item.mode && !runModes.has(item.mode))) throw new Error("Invalid content request");
      const task = `[NPATI_CONTENT:${item.type}:${Buffer.from(clean(item.title, 300), "utf8").toString("base64url")}] ${clean(item.task)}`;
      const details = await deps.runCompany(auth, company.id, { task, mode: item.mode ?? "auto" }, `chat-content:${key}`);
      const run = details.run;
      if (run.status !== "completed" || !clean(run.result)) throw new Error(run.errorMessage || "Content generation did not complete");
      await deps.content.update(auth, run.id, company.id, { title: clean(item.title, 300), type: contentType(item.type!), content: clean(run.result, 200_000) });
      const card = `\`\`\`card:${clean(item.title, 300)}\n${clean(run.result)}\n\n[${labels.openContent}](/settings/content)\n\`\`\``;
      return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: run.id, companyId: company.id }, companyRunId: run.id };
    } catch (error) {
      options.onError?.(error);
      return { cleanText: this.noActionMessage(options.requestMessage ?? "") };
    }
  }
}
