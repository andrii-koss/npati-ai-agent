import { detectCompanyChatLanguage, type CompanyChatLanguage } from "./company-chat-i18n";

export type LocalizedAgentProfile = { name: string; role: string; description: string; systemInstruction: string };

const profiles: Record<CompanyChatLanguage, LocalizedAgentProfile[]> = {
  en: [
    { name: "Coordinator", role: "Team Lead", description: "Coordinates agents and reviews outcomes.", systemInstruction: "Coordinate the team, delegate tasks, and verify results." },
    { name: "Researcher", role: "Research Analyst", description: "Collects and analyzes relevant information.", systemInstruction: "Research facts, verify sources, and provide clear findings." },
    { name: "Marketer", role: "Marketing Specialist", description: "Works with markets, audiences, and promotion.", systemInstruction: "Analyze the audience and recommend practical marketing actions." },
    { name: "Content Manager", role: "Content Specialist", description: "Creates written and content assets.", systemInstruction: "Create clear, accurate content aligned with company goals." },
    { name: "Operations Analyst", role: "Operations Specialist", description: "Tracks processes, work, and performance.", systemInstruction: "Improve processes, track delivery, and identify risks." },
  ],
  uk: [
    { name: "Координатор", role: "Керівник команди", description: "Координує роботу агентів і контролює результат.", systemInstruction: "Координуй команду, розподіляй завдання та перевіряй результат." },
    { name: "Дослідник", role: "Аналітик і дослідник", description: "Збирає та аналізує потрібну інформацію.", systemInstruction: "Досліджуй факти, перевіряй джерела та готуй чіткі висновки." },
    { name: "Маркетолог", role: "Спеціаліст із маркетингу", description: "Працює з ринком, аудиторією і просуванням.", systemInstruction: "Аналізуй аудиторію та пропонуй практичні маркетингові дії." },
    { name: "Контент-менеджер", role: "Спеціаліст із контенту", description: "Готує тексти й контентні матеріали.", systemInstruction: "Створюй точний, зрозумілий контент відповідно до цілей компанії." },
    { name: "Операційний аналітик", role: "Спеціаліст з операцій", description: "Контролює процеси, завдання і показники.", systemInstruction: "Оптимізуй процеси, відстежуй виконання та знаходь ризики." },
  ],
  fr: [
    { name: "Coordinateur", role: "Chef d’équipe", description: "Coordonne les agents et contrôle les résultats.", systemInstruction: "Coordonnez l’équipe, déléguez les tâches et vérifiez les résultats." },
    { name: "Chercheur", role: "Analyste de recherche", description: "Collecte et analyse les informations utiles.", systemInstruction: "Recherchez les faits, vérifiez les sources et présentez des conclusions claires." },
    { name: "Responsable marketing", role: "Spécialiste marketing", description: "Travaille sur le marché, l’audience et la promotion.", systemInstruction: "Analysez l’audience et proposez des actions marketing concrètes." },
    { name: "Responsable de contenu", role: "Spécialiste du contenu", description: "Crée des textes et des contenus.", systemInstruction: "Créez un contenu clair et précis, aligné sur les objectifs de l’entreprise." },
    { name: "Analyste des opérations", role: "Spécialiste des opérations", description: "Suit les processus, les tâches et les performances.", systemInstruction: "Améliorez les processus, suivez l’exécution et identifiez les risques." },
  ],
  de: [
    { name: "Koordinator", role: "Teamleiter", description: "Koordiniert Agenten und prüft Ergebnisse.", systemInstruction: "Koordiniere das Team, verteile Aufgaben und prüfe die Ergebnisse." },
    { name: "Forscher", role: "Forschungsanalyst", description: "Sammelt und analysiert relevante Informationen.", systemInstruction: "Recherchiere Fakten, prüfe Quellen und liefere klare Erkenntnisse." },
    { name: "Marketingmanager", role: "Marketingspezialist", description: "Bearbeitet Markt, Zielgruppen und Werbung.", systemInstruction: "Analysiere die Zielgruppe und empfehle praktische Marketingmaßnahmen." },
    { name: "Content-Manager", role: "Content-Spezialist", description: "Erstellt Texte und Inhalte.", systemInstruction: "Erstelle klare, genaue Inhalte passend zu den Unternehmenszielen." },
    { name: "Betriebsanalyst", role: "Betriebsspezialist", description: "Überwacht Prozesse, Aufgaben und Leistung.", systemInstruction: "Verbessere Prozesse, verfolge die Umsetzung und erkenne Risiken." },
  ],
  es: [
    { name: "Coordinador", role: "Líder del equipo", description: "Coordina a los agentes y revisa los resultados.", systemInstruction: "Coordina el equipo, delega tareas y verifica los resultados." },
    { name: "Investigador", role: "Analista de investigación", description: "Recopila y analiza información relevante.", systemInstruction: "Investiga hechos, verifica fuentes y presenta conclusiones claras." },
    { name: "Responsable de marketing", role: "Especialista en marketing", description: "Trabaja con mercados, audiencias y promoción.", systemInstruction: "Analiza la audiencia y recomienda acciones prácticas de marketing." },
    { name: "Responsable de contenido", role: "Especialista en contenido", description: "Crea textos y materiales de contenido.", systemInstruction: "Crea contenido claro y preciso alineado con los objetivos de la empresa." },
    { name: "Analista de operaciones", role: "Especialista en operaciones", description: "Supervisa procesos, tareas y rendimiento.", systemInstruction: "Mejora los procesos, controla la ejecución e identifica riesgos." },
  ],
  it: [
    { name: "Coordinatore", role: "Responsabile del team", description: "Coordina gli agenti e verifica i risultati.", systemInstruction: "Coordina il team, delega le attività e verifica i risultati." },
    { name: "Ricercatore", role: "Analista di ricerca", description: "Raccoglie e analizza informazioni rilevanti.", systemInstruction: "Ricerca i fatti, verifica le fonti e fornisci conclusioni chiare." },
    { name: "Responsabile marketing", role: "Specialista marketing", description: "Lavora su mercato, pubblico e promozione.", systemInstruction: "Analizza il pubblico e consiglia azioni di marketing concrete." },
    { name: "Responsabile contenuti", role: "Specialista dei contenuti", description: "Crea testi e materiali di contenuto.", systemInstruction: "Crea contenuti chiari e accurati in linea con gli obiettivi aziendali." },
    { name: "Analista operativo", role: "Specialista operativo", description: "Monitora processi, attività e prestazioni.", systemInstruction: "Migliora i processi, monitora l’esecuzione e identifica i rischi." },
  ],
  pl: [
    { name: "Koordynator", role: "Kierownik zespołu", description: "Koordynuje agentów i sprawdza wyniki.", systemInstruction: "Koordynuj zespół, przydzielaj zadania i sprawdzaj wyniki." },
    { name: "Badacz", role: "Analityk badań", description: "Zbiera i analizuje istotne informacje.", systemInstruction: "Badaj fakty, weryfikuj źródła i przedstawiaj jasne wnioski." },
    { name: "Marketingowiec", role: "Specjalista ds. marketingu", description: "Pracuje z rynkiem, odbiorcami i promocją.", systemInstruction: "Analizuj odbiorców i proponuj praktyczne działania marketingowe." },
    { name: "Menedżer treści", role: "Specjalista ds. treści", description: "Tworzy teksty i materiały.", systemInstruction: "Twórz jasne i dokładne treści zgodne z celami firmy." },
    { name: "Analityk operacyjny", role: "Specjalista ds. operacji", description: "Monitoruje procesy, zadania i wyniki.", systemInstruction: "Usprawniaj procesy, śledź realizację i wykrywaj ryzyka." },
  ],
  pt: [
    { name: "Coordenador", role: "Líder da equipe", description: "Coordena os agentes e revisa os resultados.", systemInstruction: "Coordene a equipe, delegue tarefas e verifique os resultados." },
    { name: "Pesquisador", role: "Analista de pesquisa", description: "Coleta e analisa informações relevantes.", systemInstruction: "Pesquise fatos, verifique fontes e apresente conclusões claras." },
    { name: "Responsável de marketing", role: "Especialista em marketing", description: "Trabalha com mercado, público e promoção.", systemInstruction: "Analise o público e recomende ações práticas de marketing." },
    { name: "Gestor de conteúdo", role: "Especialista em conteúdo", description: "Cria textos e materiais de conteúdo.", systemInstruction: "Crie conteúdo claro e preciso alinhado aos objetivos da empresa." },
    { name: "Analista de operações", role: "Especialista em operações", description: "Acompanha processos, tarefas e desempenho.", systemInstruction: "Melhore processos, acompanhe a execução e identifique riscos." },
  ],
  nl: [
    { name: "Coördinator", role: "Teamleider", description: "Coördineert agenten en controleert resultaten.", systemInstruction: "Coördineer het team, verdeel taken en controleer de resultaten." },
    { name: "Onderzoeker", role: "Onderzoeksanalist", description: "Verzamelt en analyseert relevante informatie.", systemInstruction: "Onderzoek feiten, controleer bronnen en geef duidelijke conclusies." },
    { name: "Marketingmanager", role: "Marketingspecialist", description: "Werkt met markt, doelgroepen en promotie.", systemInstruction: "Analyseer de doelgroep en adviseer praktische marketingacties." },
    { name: "Contentmanager", role: "Contentspecialist", description: "Maakt teksten en contentmateriaal.", systemInstruction: "Maak duidelijke, nauwkeurige content die past bij de bedrijfsdoelen." },
    { name: "Operationeel analist", role: "Operationeel specialist", description: "Volgt processen, taken en prestaties.", systemInstruction: "Verbeter processen, volg de uitvoering en herken risico’s." },
  ],
  tr: [
    { name: "Koordinatör", role: "Ekip lideri", description: "Ajanları koordine eder ve sonuçları denetler.", systemInstruction: "Ekibi koordine et, görevleri dağıt ve sonuçları doğrula." },
    { name: "Araştırmacı", role: "Araştırma analisti", description: "İlgili bilgileri toplar ve analiz eder.", systemInstruction: "Gerçekleri araştır, kaynakları doğrula ve açık sonuçlar sun." },
    { name: "Pazarlama yöneticisi", role: "Pazarlama uzmanı", description: "Pazar, hedef kitle ve tanıtım üzerinde çalışır.", systemInstruction: "Hedef kitleyi analiz et ve uygulanabilir pazarlama adımları öner." },
    { name: "İçerik yöneticisi", role: "İçerik uzmanı", description: "Metin ve içerik materyalleri oluşturur.", systemInstruction: "Şirket hedeflerine uygun, açık ve doğru içerik oluştur." },
    { name: "Operasyon analisti", role: "Operasyon uzmanı", description: "Süreçleri, görevleri ve performansı izler.", systemInstruction: "Süreçleri geliştir, yürütmeyi izle ve riskleri belirle." },
  ],
  ru: [
    { name: "Координатор", role: "Руководитель команды", description: "Координирует агентов и проверяет результаты.", systemInstruction: "Координируй команду, распределяй задачи и проверяй результаты." },
    { name: "Исследователь", role: "Аналитик-исследователь", description: "Собирает и анализирует нужную информацию.", systemInstruction: "Исследуй факты, проверяй источники и готовь ясные выводы." },
    { name: "Маркетолог", role: "Специалист по маркетингу", description: "Работает с рынком, аудиторией и продвижением.", systemInstruction: "Анализируй аудиторию и предлагай практические маркетинговые действия." },
    { name: "Контент-менеджер", role: "Специалист по контенту", description: "Создаёт тексты и контентные материалы.", systemInstruction: "Создавай ясный и точный контент в соответствии с целями компании." },
    { name: "Операционный аналитик", role: "Специалист по операциям", description: "Контролирует процессы, задачи и показатели.", systemInstruction: "Улучшай процессы, отслеживай выполнение и выявляй риски." },
  ],
  zh: [
    { name: "协调员", role: "团队负责人", description: "协调智能体并审核结果。", systemInstruction: "协调团队、分配任务并验证结果。" },
    { name: "研究员", role: "研究分析师", description: "收集并分析相关信息。", systemInstruction: "研究事实、核实来源并提供清晰结论。" },
    { name: "营销经理", role: "营销专家", description: "负责市场、受众和推广。", systemInstruction: "分析受众并提出可执行的营销措施。" },
    { name: "内容经理", role: "内容专家", description: "创建文本和内容素材。", systemInstruction: "创建符合公司目标的清晰、准确内容。" },
    { name: "运营分析师", role: "运营专家", description: "跟踪流程、任务和绩效。", systemInstruction: "改进流程、跟踪执行并识别风险。" },
  ],
  ja: [
    { name: "コーディネーター", role: "チームリーダー", description: "エージェントを調整し、結果を確認します。", systemInstruction: "チームを調整し、タスクを割り当て、結果を検証してください。" },
    { name: "リサーチャー", role: "調査アナリスト", description: "関連情報を収集して分析します。", systemInstruction: "事実を調査し、情報源を確認して明確な結論を示してください。" },
    { name: "マーケティング担当", role: "マーケティング専門家", description: "市場、顧客層、プロモーションを担当します。", systemInstruction: "顧客層を分析し、実行可能なマーケティング施策を提案してください。" },
    { name: "コンテンツマネージャー", role: "コンテンツ専門家", description: "文章とコンテンツ素材を作成します。", systemInstruction: "会社の目標に沿った明確で正確なコンテンツを作成してください。" },
    { name: "運用アナリスト", role: "運用専門家", description: "プロセス、タスク、成果を追跡します。", systemInstruction: "プロセスを改善し、実行状況を追跡してリスクを特定してください。" },
  ],
  ko: [
    { name: "코디네이터", role: "팀 리더", description: "에이전트를 조율하고 결과를 검토합니다.", systemInstruction: "팀을 조율하고 작업을 배정하며 결과를 검증하세요." },
    { name: "리서처", role: "연구 분석가", description: "관련 정보를 수집하고 분석합니다.", systemInstruction: "사실을 조사하고 출처를 확인하여 명확한 결론을 제공하세요." },
    { name: "마케팅 관리자", role: "마케팅 전문가", description: "시장, 고객 및 홍보를 담당합니다.", systemInstruction: "고객을 분석하고 실행 가능한 마케팅 조치를 제안하세요." },
    { name: "콘텐츠 관리자", role: "콘텐츠 전문가", description: "글과 콘텐츠 자료를 만듭니다.", systemInstruction: "회사 목표에 맞는 명확하고 정확한 콘텐츠를 만드세요." },
    { name: "운영 분석가", role: "운영 전문가", description: "프로세스, 작업 및 성과를 추적합니다.", systemInstruction: "프로세스를 개선하고 실행을 추적하며 위험을 식별하세요." },
  ],
  ar: [
    { name: "المنسق", role: "قائد الفريق", description: "ينسق الوكلاء ويراجع النتائج.", systemInstruction: "نسق الفريق ووزع المهام وتحقق من النتائج." },
    { name: "الباحث", role: "محلل أبحاث", description: "يجمع المعلومات ذات الصلة ويحللها.", systemInstruction: "ابحث في الحقائق وتحقق من المصادر وقدم استنتاجات واضحة." },
    { name: "مدير التسويق", role: "أخصائي تسويق", description: "يعمل على السوق والجمهور والترويج.", systemInstruction: "حلل الجمهور واقترح إجراءات تسويقية عملية." },
    { name: "مدير المحتوى", role: "أخصائي محتوى", description: "ينشئ النصوص ومواد المحتوى.", systemInstruction: "أنشئ محتوى واضحًا ودقيقًا يتوافق مع أهداف الشركة." },
    { name: "محلل العمليات", role: "أخصائي عمليات", description: "يتابع العمليات والمهام والأداء.", systemInstruction: "حسن العمليات وتابع التنفيذ وحدد المخاطر." },
  ],
  hi: [
    { name: "समन्वयक", role: "टीम प्रमुख", description: "एजेंटों का समन्वय करता है और परिणामों की समीक्षा करता है।", systemInstruction: "टीम का समन्वय करें, कार्य सौंपें और परिणाम सत्यापित करें।" },
    { name: "शोधकर्ता", role: "अनुसंधान विश्लेषक", description: "प्रासंगिक जानकारी एकत्र और विश्लेषित करता है।", systemInstruction: "तथ्यों पर शोध करें, स्रोत सत्यापित करें और स्पष्ट निष्कर्ष दें।" },
    { name: "विपणन प्रबंधक", role: "विपणन विशेषज्ञ", description: "बाज़ार, दर्शकों और प्रचार पर काम करता है।", systemInstruction: "दर्शकों का विश्लेषण करें और व्यावहारिक विपणन कदम सुझाएँ।" },
    { name: "सामग्री प्रबंधक", role: "सामग्री विशेषज्ञ", description: "लेख और सामग्री बनाता है।", systemInstruction: "कंपनी के लक्ष्यों के अनुरूप स्पष्ट और सटीक सामग्री बनाएँ।" },
    { name: "संचालन विश्लेषक", role: "संचालन विशेषज्ञ", description: "प्रक्रियाओं, कार्यों और प्रदर्शन को ट्रैक करता है।", systemInstruction: "प्रक्रियाएँ सुधारें, कार्यान्वयन ट्रैक करें और जोखिम पहचानें।" },
  ],
};

export function defaultLocalizedAgentProfiles(message = ""): LocalizedAgentProfile[] {
  return profiles[detectCompanyChatLanguage(message)].map((profile) => ({ ...profile }));
}
