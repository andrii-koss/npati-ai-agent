/**
 * The "technology selection" step of a new project, in the language of the request. The server records an English
 * reason ("HTML/CSS: Explicit user technology: HTML/CSS"), which the chat showed as is in every language (V6 step 13).
 */
type Kind = "user" | "planner" | "fallback" | "engine";

const TEXT: Record<string, Record<Kind, string>> = {
  en: { user: "{{framework}}: the technology you asked for", planner: "{{framework}}: chosen by the AI planner for this request", fallback: "{{framework}}: default technology (AI planning unavailable)", engine: "{{framework}}: named game engine, installed from npm in the project" },
  uk: { user: "{{framework}}: технологія, яку ви вказали", planner: "{{framework}}: обрано AI-планувальником для цього запиту", fallback: "{{framework}}: типова технологія (AI-планування недоступне)", engine: "{{framework}}: названий ігровий рушій, встановлюється з npm у проєкті" },
  ru: { user: "{{framework}}: технология, которую вы указали", planner: "{{framework}}: выбрано AI-планировщиком для этого запроса", fallback: "{{framework}}: технология по умолчанию (AI-планирование недоступно)", engine: "{{framework}}: указанный игровой движок, устанавливается из npm в проекте" },
  de: { user: "{{framework}}: die von Ihnen gewünschte Technologie", planner: "{{framework}}: vom KI-Planer für diese Anfrage gewählt", fallback: "{{framework}}: Standardtechnologie (KI-Planung nicht verfügbar)", engine: "{{framework}}: genannte Spiel-Engine, im Projekt aus npm installiert" },
  fr: { user: "{{framework}} : la technologie que vous avez demandée", planner: "{{framework}} : choisie par le planificateur IA pour cette demande", fallback: "{{framework}} : technologie par défaut (planification IA indisponible)", engine: "{{framework}} : moteur de jeu demandé, installé depuis npm dans le projet" },
  es: { user: "{{framework}}: la tecnología que indicaste", planner: "{{framework}}: elegida por el planificador de IA para esta solicitud", fallback: "{{framework}}: tecnología predeterminada (planificación con IA no disponible)", engine: "{{framework}}: motor de juego indicado, instalado desde npm en el proyecto" },
  it: { user: "{{framework}}: la tecnologia che hai indicato", planner: "{{framework}}: scelta dal pianificatore IA per questa richiesta", fallback: "{{framework}}: tecnologia predefinita (pianificazione IA non disponibile)", engine: "{{framework}}: motore di gioco indicato, installato da npm nel progetto" },
  pl: { user: "{{framework}}: technologia, którą wskazałeś", planner: "{{framework}}: wybrane przez planer AI dla tej prośby", fallback: "{{framework}}: technologia domyślna (planowanie AI niedostępne)", engine: "{{framework}}: wskazany silnik gry, instalowany z npm w projekcie" },
  pt: { user: "{{framework}}: a tecnologia que indicaste", planner: "{{framework}}: escolhida pelo planeador de IA para este pedido", fallback: "{{framework}}: tecnologia predefinida (planeamento de IA indisponível)", engine: "{{framework}}: motor de jogo indicado, instalado a partir do npm no projeto" },
  nl: { user: "{{framework}}: de technologie die u hebt gevraagd", planner: "{{framework}}: gekozen door de AI-planner voor dit verzoek", fallback: "{{framework}}: standaardtechnologie (AI-planning niet beschikbaar)", engine: "{{framework}}: genoemde game-engine, in het project geïnstalleerd vanuit npm" },
  tr: { user: "{{framework}}: belirttiğiniz teknoloji", planner: "{{framework}}: bu istek için yapay zekâ planlayıcısı tarafından seçildi", fallback: "{{framework}}: varsayılan teknoloji (yapay zekâ planlaması kullanılamıyor)", engine: "{{framework}}: belirtilen oyun motoru, projeye npm'den kuruldu" },
  zh: { user: "{{framework}}：你指定的技术", planner: "{{framework}}：由 AI 规划器为此请求选择", fallback: "{{framework}}：默认技术（AI 规划不可用）", engine: "{{framework}}：指定的游戏引擎，从 npm 安装到项目中" },
  ja: { user: "{{framework}}：指定された技術", planner: "{{framework}}：AI プランナーがこの依頼のために選択", fallback: "{{framework}}：既定の技術（AI プランニングは利用できません）", engine: "{{framework}}：指定されたゲームエンジン（npm からプロジェクトにインストール）" },
  ko: { user: "{{framework}}: 요청하신 기술", planner: "{{framework}}: AI 플래너가 이 요청에 맞게 선택", fallback: "{{framework}}: 기본 기술 (AI 계획을 사용할 수 없음)", engine: "{{framework}}: 지정한 게임 엔진, 프로젝트에 npm으로 설치" },
  ar: { user: "{{framework}}: التقنية التي طلبتها", planner: "{{framework}}: اختارها مخطط الذكاء الاصطناعي لهذا الطلب", fallback: "{{framework}}: التقنية الافتراضية (تخطيط الذكاء الاصطناعي غير متاح)", engine: "{{framework}}: محرك الألعاب المحدد، يُثبَّت من npm في المشروع" },
  hi: { user: "{{framework}}: आपके द्वारा बताई गई तकनीक", planner: "{{framework}}: इस अनुरोध के लिए AI प्लानर द्वारा चुनी गई", fallback: "{{framework}}: डिफ़ॉल्ट तकनीक (AI योजना उपलब्ध नहीं)", engine: "{{framework}}: बताया गया गेम इंजन, प्रोजेक्ट में npm से इंस्टॉल" },
};

/** How the technology was chosen, read from the recorded step (its result JSON, agent or English reason). */
function selectionKind(item: { title?: string; result?: string; agentId?: string }): Kind {
  let source: string | undefined;
  try { source = (JSON.parse(item.result ?? "") as { source?: string }).source; } catch { /* older steps carry no result */ }
  const title = item.title ?? "";
  if (/Named game engine/i.test(title)) return "engine";
  if (source === "user_explicit" || /Explicit user technology/i.test(title)) return "user";
  if (source === "policy_fallback" || /AI planning unavailable/i.test(title)) return "fallback";
  return "planner";
}

export function technologySelectionTitle(language: string, item: { title?: string; result?: string; agentId?: string }): string {
  const framework = (item.title ?? "").split(":")[0]!.trim() || "—";
  const text = TEXT[language.slice(0, 2)] ?? TEXT.en!;
  return text[selectionKind(item)].replace("{{framework}}", framework);
}
