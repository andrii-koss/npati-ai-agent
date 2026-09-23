import { detectCompanyChatLanguage, type CompanyChatLanguage } from "./company-chat-i18n";

export type CompositeCreationCopy = {
  businessName: string; companyName: string; goalTitle: string; goalDescription: string;
  industry: string; niche: string; country: string; market: string; description: string;
  products: string; audience: string; intro: string; businessCard: string; goalCard: string;
  next: string; businessModel: string; targetUnit: string; companyLanguage: string; brandTone: string;
  businessNameLabel: string; stageLabel: string; industryLabel: string; nicheLabel: string;
  openBusinessLabel: string; businessLabel: string; statusLabel: string; descriptionLabel: string; openGoalsLabel: string;
};

const copies: Record<CompanyChatLanguage, CompositeCreationCopy> = {
  en: {
    businessName: "Test Business Idea", companyName: "Test Company", goalTitle: "Validate the test business setup",
    goalDescription: "Validate the created business idea, goal, company, and agent team.", industry: "Testing and automation", niche: "AI tool validation",
    country: "Not specified", market: "Global", description: "A test business for validating NPATI Agent features.", products: "Process testing, analytics, and automation",
    audience: "Teams and users validating AI tools.", intro: "Done. I created the business idea, goal, and company and linked them together.", businessCard: "Business profile", goalCard: "Goal",
    next: "Would you like me to configure detailed instructions, tools, and recommended prompts for the five agents?", businessModel: "Test model", targetUnit: "successful test",
    companyLanguage: "English", brandTone: "Professional and clear", businessNameLabel: "Business name", stageLabel: "Stage", industryLabel: "Industry", nicheLabel: "Niche",
    openBusinessLabel: "Open business profile", businessLabel: "Business", statusLabel: "Status", descriptionLabel: "Description", openGoalsLabel: "Open business goals",
  },
  uk: {
    businessName: "Тестова бізнес-ідея", companyName: "Тестова компанія", goalTitle: "Перевірити роботу тестового бізнесу",
    goalDescription: "Перевірити створену бізнес-ідею, ціль, компанію та роботу команди агентів.", industry: "Тестування та автоматизація", niche: "Перевірка AI-інструментів",
    country: "Україна", market: "Глобальний", description: "Тестовий бізнес для перевірки функцій NPATI Agent.", products: "Тестування процесів, аналітика та автоматизація",
    audience: "Команди та користувачі, які перевіряють AI-інструменти.", intro: "Готово, я створив бізнес-ідею, ціль і компанію та пов’язав їх між собою.", businessCard: "Бізнес-профіль", goalCard: "Ціль",
    next: "Хочете, щоб я тепер деталізував інструкції, інструменти та рекомендовані запити для п’яти агентів?", businessModel: "Тестова модель", targetUnit: "успішний тест",
    companyLanguage: "Українська", brandTone: "Професійний і зрозумілий", businessNameLabel: "Назва бізнесу", stageLabel: "Стадія", industryLabel: "Галузь", nicheLabel: "Ніша",
    openBusinessLabel: "Відкрити бізнес-профіль", businessLabel: "Бізнес", statusLabel: "Статус", descriptionLabel: "Опис", openGoalsLabel: "Відкрити цілі бізнесу",
  },
  fr: {
    businessName: "Idée d’entreprise test", companyName: "Entreprise test", goalTitle: "Valider la configuration de l’entreprise test",
    goalDescription: "Valider l’idée d’entreprise, l’objectif, l’entreprise et l’équipe d’agents créés.", industry: "Tests et automatisation", niche: "Validation des outils d’IA",
    country: "Non précisé", market: "Mondial", description: "Une entreprise test pour valider les fonctions de NPATI Agent.", products: "Tests de processus, analyse et automatisation",
    audience: "Équipes et utilisateurs qui valident des outils d’IA.", intro: "Terminé. J’ai créé l’idée d’entreprise, l’objectif et l’entreprise, puis je les ai associés.", businessCard: "Profil d’entreprise", goalCard: "Objectif",
    next: "Souhaitez-vous que je configure les instructions, les outils et les invites recommandées pour les cinq agents ?", businessModel: "Modèle test", targetUnit: "test réussi",
    companyLanguage: "Français", brandTone: "Professionnel et clair", businessNameLabel: "Nom de l’entreprise", stageLabel: "Étape", industryLabel: "Secteur", nicheLabel: "Niche",
    openBusinessLabel: "Ouvrir le profil d’entreprise", businessLabel: "Entreprise", statusLabel: "Statut", descriptionLabel: "Description", openGoalsLabel: "Ouvrir les objectifs",
  },
  de: {
    businessName: "Test-Geschäftsidee", companyName: "Testunternehmen", goalTitle: "Testkonfiguration des Unternehmens prüfen",
    goalDescription: "Die erstellte Geschäftsidee, das Ziel, das Unternehmen und das Agententeam prüfen.", industry: "Tests und Automatisierung", niche: "Prüfung von KI-Werkzeugen",
    country: "Nicht angegeben", market: "Global", description: "Ein Testunternehmen zur Prüfung der Funktionen von NPATI Agent.", products: "Prozesstests, Analysen und Automatisierung",
    audience: "Teams und Nutzer, die KI-Werkzeuge prüfen.", intro: "Erledigt. Ich habe die Geschäftsidee, das Ziel und das Unternehmen erstellt und miteinander verknüpft.", businessCard: "Geschäftsprofil", goalCard: "Ziel",
    next: "Soll ich Anweisungen, Werkzeuge und empfohlene Prompts für die fünf Agenten detailliert konfigurieren?", businessModel: "Testmodell", targetUnit: "erfolgreicher Test",
    companyLanguage: "Deutsch", brandTone: "Professionell und klar", businessNameLabel: "Unternehmensname", stageLabel: "Phase", industryLabel: "Branche", nicheLabel: "Nische",
    openBusinessLabel: "Geschäftsprofil öffnen", businessLabel: "Unternehmen", statusLabel: "Status", descriptionLabel: "Beschreibung", openGoalsLabel: "Unternehmensziele öffnen",
  },
  es: {
    businessName: "Idea de negocio de prueba", companyName: "Empresa de prueba", goalTitle: "Validar la configuración del negocio de prueba",
    goalDescription: "Validar la idea de negocio, el objetivo, la empresa y el equipo de agentes creados.", industry: "Pruebas y automatización", niche: "Validación de herramientas de IA",
    country: "No especificado", market: "Global", description: "Un negocio de prueba para validar las funciones de NPATI Agent.", products: "Pruebas de procesos, análisis y automatización",
    audience: "Equipos y usuarios que validan herramientas de IA.", intro: "Listo. He creado la idea de negocio, el objetivo y la empresa, y los he vinculado.", businessCard: "Perfil del negocio", goalCard: "Objetivo",
    next: "¿Quieres que configure las instrucciones, herramientas y solicitudes recomendadas para los cinco agentes?", businessModel: "Modelo de prueba", targetUnit: "prueba superada",
    companyLanguage: "Español", brandTone: "Profesional y claro", businessNameLabel: "Nombre del negocio", stageLabel: "Etapa", industryLabel: "Sector", nicheLabel: "Nicho",
    openBusinessLabel: "Abrir perfil del negocio", businessLabel: "Negocio", statusLabel: "Estado", descriptionLabel: "Descripción", openGoalsLabel: "Abrir objetivos del negocio",
  },
  it: {
    businessName: "Idea imprenditoriale di prova", companyName: "Azienda di prova", goalTitle: "Validare la configurazione dell’attività di prova",
    goalDescription: "Validare l’idea imprenditoriale, l’obiettivo, l’azienda e il team di agenti creati.", industry: "Test e automazione", niche: "Validazione degli strumenti di IA",
    country: "Non specificato", market: "Globale", description: "Un’attività di prova per validare le funzioni di NPATI Agent.", products: "Test dei processi, analisi e automazione",
    audience: "Team e utenti che validano strumenti di IA.", intro: "Fatto. Ho creato l’idea imprenditoriale, l’obiettivo e l’azienda e li ho collegati.", businessCard: "Profilo aziendale", goalCard: "Obiettivo",
    next: "Vuoi che configuri istruzioni, strumenti e prompt consigliati per i cinque agenti?", businessModel: "Modello di prova", targetUnit: "test riuscito",
    companyLanguage: "Italiano", brandTone: "Professionale e chiaro", businessNameLabel: "Nome dell’attività", stageLabel: "Fase", industryLabel: "Settore", nicheLabel: "Nicchia",
    openBusinessLabel: "Apri il profilo aziendale", businessLabel: "Attività", statusLabel: "Stato", descriptionLabel: "Descrizione", openGoalsLabel: "Apri gli obiettivi",
  },
  pl: {
    businessName: "Testowy pomysł na biznes", companyName: "Firma testowa", goalTitle: "Sprawdzić konfigurację testowego biznesu",
    goalDescription: "Sprawdzić utworzony pomysł na biznes, cel, firmę i zespół agentów.", industry: "Testowanie i automatyzacja", niche: "Weryfikacja narzędzi AI",
    country: "Nie określono", market: "Globalny", description: "Testowy biznes do sprawdzania funkcji NPATI Agent.", products: "Testowanie procesów, analityka i automatyzacja",
    audience: "Zespoły i użytkownicy sprawdzający narzędzia AI.", intro: "Gotowe. Utworzyłem pomysł na biznes, cel i firmę oraz połączyłem je ze sobą.", businessCard: "Profil biznesowy", goalCard: "Cel",
    next: "Czy mam szczegółowo skonfigurować instrukcje, narzędzia i zalecane prompty dla pięciu agentów?", businessModel: "Model testowy", targetUnit: "udany test",
    companyLanguage: "Polski", brandTone: "Profesjonalny i jasny", businessNameLabel: "Nazwa biznesu", stageLabel: "Etap", industryLabel: "Branża", nicheLabel: "Nisza",
    openBusinessLabel: "Otwórz profil biznesowy", businessLabel: "Biznes", statusLabel: "Status", descriptionLabel: "Opis", openGoalsLabel: "Otwórz cele biznesowe",
  },
  pt: {
    businessName: "Ideia de negócio de teste", companyName: "Empresa de teste", goalTitle: "Validar a configuração do negócio de teste",
    goalDescription: "Validar a ideia de negócio, a meta, a empresa e a equipe de agentes criados.", industry: "Testes e automação", niche: "Validação de ferramentas de IA",
    country: "Não especificado", market: "Global", description: "Um negócio de teste para validar os recursos do NPATI Agent.", products: "Testes de processos, análise e automação",
    audience: "Equipes e usuários que validam ferramentas de IA.", intro: "Concluído. Criei a ideia de negócio, a meta e a empresa e vinculei tudo.", businessCard: "Perfil do negócio", goalCard: "Meta",
    next: "Quer que eu configure instruções, ferramentas e prompts recomendados para os cinco agentes?", businessModel: "Modelo de teste", targetUnit: "teste bem-sucedido",
    companyLanguage: "Português", brandTone: "Profissional e claro", businessNameLabel: "Nome do negócio", stageLabel: "Etapa", industryLabel: "Setor", nicheLabel: "Nicho",
    openBusinessLabel: "Abrir perfil do negócio", businessLabel: "Negócio", statusLabel: "Status", descriptionLabel: "Descrição", openGoalsLabel: "Abrir metas do negócio",
  },
  nl: {
    businessName: "Testbedrijfsidee", companyName: "Testbedrijf", goalTitle: "De testbedrijfsconfiguratie valideren",
    goalDescription: "Het gemaakte bedrijfsidee, doel, bedrijf en agententeam valideren.", industry: "Testen en automatisering", niche: "Validatie van AI-hulpmiddelen",
    country: "Niet opgegeven", market: "Wereldwijd", description: "Een testbedrijf om de functies van NPATI Agent te valideren.", products: "Procestesten, analyse en automatisering",
    audience: "Teams en gebruikers die AI-hulpmiddelen valideren.", intro: "Klaar. Ik heb het bedrijfsidee, het doel en het bedrijf gemaakt en aan elkaar gekoppeld.", businessCard: "Bedrijfsprofiel", goalCard: "Doel",
    next: "Zal ik instructies, hulpmiddelen en aanbevolen prompts voor de vijf agenten instellen?", businessModel: "Testmodel", targetUnit: "geslaagde test",
    companyLanguage: "Nederlands", brandTone: "Professioneel en duidelijk", businessNameLabel: "Bedrijfsnaam", stageLabel: "Fase", industryLabel: "Sector", nicheLabel: "Niche",
    openBusinessLabel: "Bedrijfsprofiel openen", businessLabel: "Bedrijf", statusLabel: "Status", descriptionLabel: "Beschrijving", openGoalsLabel: "Bedrijfsdoelen openen",
  },
  tr: {
    businessName: "Test iş fikri", companyName: "Test şirketi", goalTitle: "Test işletmesi kurulumunu doğrulamak",
    goalDescription: "Oluşturulan iş fikrini, hedefi, şirketi ve ajan ekibini doğrulamak.", industry: "Test ve otomasyon", niche: "AI araçlarını doğrulama",
    country: "Belirtilmedi", market: "Küresel", description: "NPATI Agent özelliklerini doğrulamak için bir test işletmesi.", products: "Süreç testi, analiz ve otomasyon",
    audience: "AI araçlarını doğrulayan ekipler ve kullanıcılar.", intro: "Tamamlandı. İş fikrini, hedefi ve şirketi oluşturdum ve birbirine bağladım.", businessCard: "İşletme profili", goalCard: "Hedef",
    next: "Beş ajanın talimatlarını, araçlarını ve önerilen istemlerini ayrıntılı olarak yapılandırmamı ister misiniz?", businessModel: "Test modeli", targetUnit: "başarılı test",
    companyLanguage: "Türkçe", brandTone: "Profesyonel ve açık", businessNameLabel: "İşletme adı", stageLabel: "Aşama", industryLabel: "Sektör", nicheLabel: "Niş",
    openBusinessLabel: "İşletme profilini aç", businessLabel: "İşletme", statusLabel: "Durum", descriptionLabel: "Açıklama", openGoalsLabel: "İşletme hedeflerini aç",
  },
  ru: {
    businessName: "Тестовая бизнес-идея", companyName: "Тестовая компания", goalTitle: "Проверить работу тестового бизнеса",
    goalDescription: "Проверить созданную бизнес-идею, цель, компанию и работу команды агентов.", industry: "Тестирование и автоматизация", niche: "Проверка AI-инструментов",
    country: "Украина", market: "Глобальный", description: "Тестовый бизнес для проверки функций NPATI Agent.", products: "Тестирование процессов, аналитика и автоматизация",
    audience: "Команды и пользователи, которые проверяют AI-инструменты.", intro: "Готово. Я создал бизнес-идею, цель и компанию и связал их между собой.", businessCard: "Бизнес-профиль", goalCard: "Цель",
    next: "Хотите, чтобы я детально настроил инструкции, инструменты и рекомендуемые запросы для пяти агентов?", businessModel: "Тестовая модель", targetUnit: "успешный тест",
    companyLanguage: "Русский", brandTone: "Профессиональный и понятный", businessNameLabel: "Название бизнеса", stageLabel: "Стадия", industryLabel: "Отрасль", nicheLabel: "Ниша",
    openBusinessLabel: "Открыть бизнес-профиль", businessLabel: "Бизнес", statusLabel: "Статус", descriptionLabel: "Описание", openGoalsLabel: "Открыть цели бизнеса",
  },
  zh: {
    businessName: "测试商业想法", companyName: "测试公司", goalTitle: "验证测试业务配置",
    goalDescription: "验证已创建的商业想法、目标、公司和智能体团队。", industry: "测试与自动化", niche: "AI 工具验证",
    country: "未指定", market: "全球", description: "用于验证 NPATI Agent 功能的测试业务。", products: "流程测试、分析和自动化",
    audience: "验证 AI 工具的团队和用户。", intro: "已完成。我创建了商业想法、目标和公司，并将它们关联起来。", businessCard: "业务档案", goalCard: "目标",
    next: "需要我为五个智能体详细配置指令、工具和推荐提示词吗？", businessModel: "测试模型", targetUnit: "成功测试",
    companyLanguage: "简体中文", brandTone: "专业且清晰", businessNameLabel: "业务名称", stageLabel: "阶段", industryLabel: "行业", nicheLabel: "细分领域",
    openBusinessLabel: "打开业务档案", businessLabel: "业务", statusLabel: "状态", descriptionLabel: "说明", openGoalsLabel: "打开业务目标",
  },
  ja: {
    businessName: "テスト用ビジネスアイデア", companyName: "テスト会社", goalTitle: "テスト事業の設定を検証する",
    goalDescription: "作成したビジネスアイデア、目標、会社、エージェントチームを検証します。", industry: "テストと自動化", niche: "AIツールの検証",
    country: "未指定", market: "グローバル", description: "NPATI Agentの機能を検証するためのテスト事業です。", products: "プロセステスト、分析、自動化",
    audience: "AIツールを検証するチームとユーザー。", intro: "完了しました。ビジネスアイデア、目標、会社を作成し、相互に関連付けました。", businessCard: "ビジネスプロフィール", goalCard: "目標",
    next: "5人のエージェントの指示、ツール、推奨プロンプトを詳しく設定しますか？", businessModel: "テストモデル", targetUnit: "成功したテスト",
    companyLanguage: "日本語", brandTone: "専門的で明確", businessNameLabel: "事業名", stageLabel: "段階", industryLabel: "業種", nicheLabel: "ニッチ",
    openBusinessLabel: "ビジネスプロフィールを開く", businessLabel: "事業", statusLabel: "ステータス", descriptionLabel: "説明", openGoalsLabel: "事業目標を開く",
  },
  ko: {
    businessName: "테스트 비즈니스 아이디어", companyName: "테스트 회사", goalTitle: "테스트 비즈니스 설정 검증",
    goalDescription: "생성된 비즈니스 아이디어, 목표, 회사 및 에이전트 팀을 검증합니다.", industry: "테스트 및 자동화", niche: "AI 도구 검증",
    country: "지정되지 않음", market: "글로벌", description: "NPATI Agent 기능을 검증하기 위한 테스트 비즈니스입니다.", products: "프로세스 테스트, 분석 및 자동화",
    audience: "AI 도구를 검증하는 팀과 사용자.", intro: "완료했습니다. 비즈니스 아이디어, 목표와 회사를 만들고 서로 연결했습니다.", businessCard: "비즈니스 프로필", goalCard: "목표",
    next: "5명의 에이전트에 대한 지침, 도구 및 추천 프롬프트를 자세히 구성할까요?", businessModel: "테스트 모델", targetUnit: "성공한 테스트",
    companyLanguage: "한국어", brandTone: "전문적이고 명확함", businessNameLabel: "비즈니스 이름", stageLabel: "단계", industryLabel: "산업", nicheLabel: "틈새시장",
    openBusinessLabel: "비즈니스 프로필 열기", businessLabel: "비즈니스", statusLabel: "상태", descriptionLabel: "설명", openGoalsLabel: "비즈니스 목표 열기",
  },
  ar: {
    businessName: "فكرة عمل تجريبية", companyName: "شركة تجريبية", goalTitle: "التحقق من إعداد العمل التجريبي",
    goalDescription: "التحقق من فكرة العمل والهدف والشركة وفريق الوكلاء التي تم إنشاؤها.", industry: "الاختبار والأتمتة", niche: "التحقق من أدوات الذكاء الاصطناعي",
    country: "غير محدد", market: "عالمي", description: "عمل تجريبي للتحقق من ميزات NPATI Agent.", products: "اختبار العمليات والتحليلات والأتمتة",
    audience: "الفرق والمستخدمون الذين يتحققون من أدوات الذكاء الاصطناعي.", intro: "تم. أنشأت فكرة العمل والهدف والشركة وربطتها معًا.", businessCard: "ملف العمل", goalCard: "الهدف",
    next: "هل تريد أن أضبط التعليمات والأدوات والمطالبات المقترحة للوكلاء الخمسة بالتفصيل؟", businessModel: "نموذج تجريبي", targetUnit: "اختبار ناجح",
    companyLanguage: "العربية", brandTone: "مهني وواضح", businessNameLabel: "اسم العمل", stageLabel: "المرحلة", industryLabel: "القطاع", nicheLabel: "المجال المتخصص",
    openBusinessLabel: "فتح ملف العمل", businessLabel: "العمل", statusLabel: "الحالة", descriptionLabel: "الوصف", openGoalsLabel: "فتح أهداف العمل",
  },
  hi: {
    businessName: "परीक्षण व्यवसाय विचार", companyName: "परीक्षण कंपनी", goalTitle: "परीक्षण व्यवसाय सेटअप सत्यापित करें",
    goalDescription: "बनाए गए व्यवसाय विचार, लक्ष्य, कंपनी और एजेंट टीम को सत्यापित करें।", industry: "परीक्षण और स्वचालन", niche: "AI उपकरण सत्यापन",
    country: "निर्दिष्ट नहीं", market: "वैश्विक", description: "NPATI Agent सुविधाओं को सत्यापित करने के लिए एक परीक्षण व्यवसाय।", products: "प्रक्रिया परीक्षण, विश्लेषण और स्वचालन",
    audience: "AI उपकरणों को सत्यापित करने वाली टीमें और उपयोगकर्ता।", intro: "पूरा हुआ। मैंने व्यवसाय विचार, लक्ष्य और कंपनी बनाई और उन्हें आपस में जोड़ा।", businessCard: "व्यवसाय प्रोफ़ाइल", goalCard: "लक्ष्य",
    next: "क्या मैं पाँच एजेंटों के निर्देश, उपकरण और सुझाए गए प्रॉम्प्ट विस्तार से सेट करूँ?", businessModel: "परीक्षण मॉडल", targetUnit: "सफल परीक्षण",
    companyLanguage: "हिन्दी", brandTone: "पेशेवर और स्पष्ट", businessNameLabel: "व्यवसाय का नाम", stageLabel: "चरण", industryLabel: "उद्योग", nicheLabel: "विशिष्ट क्षेत्र",
    openBusinessLabel: "व्यवसाय प्रोफ़ाइल खोलें", businessLabel: "व्यवसाय", statusLabel: "स्थिति", descriptionLabel: "विवरण", openGoalsLabel: "व्यवसाय लक्ष्य खोलें",
  },
};

export function compositeCreationCopy(message = ""): CompositeCreationCopy {
  return copies[detectCompanyChatLanguage(message)];
}
