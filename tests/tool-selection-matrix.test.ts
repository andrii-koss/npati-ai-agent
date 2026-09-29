import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall } from "@npati/omniroute-adapter";
import { CHAT_TOOL_SELECTION_INSTRUCTION, CORE_CHAT_TOOLS, runChatToolLoop } from "../apps/agent-api/src/chat-tool-orchestrator";

const MODEL = "mock/native-tool-model";
const TEMPERATURE = 0;
const RUNS_PER_CASE = 3;
const TOOL_ORDER = ["npati_company_action", "web_search", "web_fetch"];

type Locale = "en" | "uk" | "fr" | "de" | "es" | "it" | "pl" | "pt" | "nl" | "tr" | "ru" | "zh" | "ja" | "ko" | "ar" | "hi";
type Scenario = "create" | "scan" | "competitors" | "document" | "image" | "audio" | "researchCreate" | "addAgents" | "duplicate" | "explain" | "capability";

const prompts: Record<Locale, Record<Scenario, string>> = {
  en: { create: "Create a company called NovaScale Labs", scan: "Scan https://npati.com and analyze the website", competitors: "Research the main competitors on the internet", document: "Analyze this attached PDF file", image: "What is shown in this attached image?", audio: "Transcribe and summarize this attached audio", researchCreate: "Research the current AI automation market and create a company based on your findings", addAgents: "Add six agents", duplicate: "Create NovaScale Labs again", explain: "Tell me how to create a company", capability: "Can you create companies?" },
  uk: { create: "Створи компанію NovaScale Labs", scan: "Проскануй https://npati.com і проаналізуй сайт", competitors: "Досліди в інтернеті головних конкурентів", document: "Проаналізуй цей прикріплений PDF-файл", image: "Що зображено на цьому прикріпленому фото?", audio: "Транскрибуй і підсумуй це прикріплене аудіо", researchCreate: "Досліди сучасний ринок автоматизації ШІ та створи компанію на основі висновків", addAgents: "Додай шість агентів", duplicate: "Знову створи NovaScale Labs", explain: "Розкажи, як створити компанію", capability: "Ти можеш створювати компанії?" },
  fr: { create: "Crée une entreprise appelée NovaScale Labs", scan: "Analyse le site https://npati.com", competitors: "Recherche les principaux concurrents sur Internet", document: "Analyse ce fichier PDF joint", image: "Que montre cette image jointe ?", audio: "Transcris et résume cet audio joint", researchCreate: "Étudie le marché actuel de l’automatisation par IA et crée une entreprise à partir des résultats", addAgents: "Ajoute six agents", duplicate: "Crée de nouveau NovaScale Labs", explain: "Explique-moi comment créer une entreprise", capability: "Peux-tu créer des entreprises ?" },
  de: { create: "Erstelle ein Unternehmen namens NovaScale Labs", scan: "Scanne und analysiere die Website https://npati.com", competitors: "Recherchiere die wichtigsten Wettbewerber im Internet", document: "Analysiere diese angehängte PDF-Datei", image: "Was ist auf diesem angehängten Bild zu sehen?", audio: "Transkribiere und fasse dieses angehängte Audio zusammen", researchCreate: "Recherchiere den aktuellen Markt für KI-Automatisierung und erstelle daraus ein Unternehmen", addAgents: "Füge sechs Agenten hinzu", duplicate: "Erstelle NovaScale Labs erneut", explain: "Erkläre mir, wie man ein Unternehmen erstellt", capability: "Kannst du Unternehmen erstellen?" },
  es: { create: "Crea una empresa llamada NovaScale Labs", scan: "Escanea y analiza el sitio https://npati.com", competitors: "Investiga en Internet a los principales competidores", document: "Analiza este archivo PDF adjunto", image: "¿Qué aparece en esta imagen adjunta?", audio: "Transcribe y resume este audio adjunto", researchCreate: "Investiga el mercado actual de automatización con IA y crea una empresa según los resultados", addAgents: "Añade seis agentes", duplicate: "Crea NovaScale Labs otra vez", explain: "Explícame cómo crear una empresa", capability: "¿Puedes crear empresas?" },
  it: { create: "Crea un’azienda chiamata NovaScale Labs", scan: "Scansiona e analizza il sito https://npati.com", competitors: "Cerca su Internet i principali concorrenti", document: "Analizza questo file PDF allegato", image: "Cosa mostra questa immagine allegata?", audio: "Trascrivi e riassumi questo audio allegato", researchCreate: "Studia il mercato attuale dell’automazione IA e crea un’azienda dai risultati", addAgents: "Aggiungi sei agenti", duplicate: "Crea di nuovo NovaScale Labs", explain: "Spiegami come creare un’azienda", capability: "Puoi creare aziende?" },
  pl: { create: "Utwórz firmę NovaScale Labs", scan: "Przeskanuj i przeanalizuj stronę https://npati.com", competitors: "Znajdź w internecie głównych konkurentów", document: "Przeanalizuj ten załączony plik PDF", image: "Co przedstawia ten załączony obraz?", audio: "Przepisz i podsumuj to załączone nagranie", researchCreate: "Zbadaj obecny rynek automatyzacji AI i utwórz firmę na podstawie wyników", addAgents: "Dodaj sześciu agentów", duplicate: "Utwórz ponownie NovaScale Labs", explain: "Powiedz mi, jak utworzyć firmę", capability: "Czy możesz tworzyć firmy?" },
  pt: { create: "Crie uma empresa chamada NovaScale Labs", scan: "Escaneie e analise o site https://npati.com", competitors: "Pesquise na internet os principais concorrentes", document: "Analise este arquivo PDF anexado", image: "O que aparece nesta imagem anexada?", audio: "Transcreva e resuma este áudio anexado", researchCreate: "Pesquise o mercado atual de automação por IA e crie uma empresa com base nos resultados", addAgents: "Adicione seis agentes", duplicate: "Crie NovaScale Labs novamente", explain: "Explique como criar uma empresa", capability: "Você pode criar empresas?" },
  nl: { create: "Maak een bedrijf genaamd NovaScale Labs", scan: "Scan en analyseer de website https://npati.com", competitors: "Onderzoek de belangrijkste concurrenten op internet", document: "Analyseer dit bijgevoegde PDF-bestand", image: "Wat staat er op deze bijgevoegde afbeelding?", audio: "Transcribeer en vat deze bijgevoegde audio samen", researchCreate: "Onderzoek de huidige markt voor AI-automatisering en maak een bedrijf op basis van de resultaten", addAgents: "Voeg zes agenten toe", duplicate: "Maak NovaScale Labs opnieuw", explain: "Vertel me hoe ik een bedrijf maak", capability: "Kun je bedrijven maken?" },
  tr: { create: "NovaScale Labs adlı bir şirket oluştur", scan: "https://npati.com sitesini tara ve analiz et", competitors: "İnternetteki ana rakipleri araştır", document: "Bu ekli PDF dosyasını analiz et", image: "Bu ekli görselde ne var?", audio: "Bu ekli sesi yazıya dök ve özetle", researchCreate: "Güncel yapay zekâ otomasyon pazarını araştır ve bulgulara göre bir şirket oluştur", addAgents: "Altı ajan ekle", duplicate: "NovaScale Labs şirketini yeniden oluştur", explain: "Bir şirketin nasıl oluşturulacağını anlat", capability: "Şirket oluşturabilir misin?" },
  ru: { create: "Создай компанию NovaScale Labs", scan: "Просканируй и проанализируй сайт https://npati.com", competitors: "Исследуй в интернете основных конкурентов", document: "Проанализируй этот прикреплённый PDF-файл", image: "Что изображено на этой прикреплённой картинке?", audio: "Расшифруй и резюмируй это прикреплённое аудио", researchCreate: "Исследуй текущий рынок автоматизации ИИ и создай компанию по результатам", addAgents: "Добавь шесть агентов", duplicate: "Снова создай NovaScale Labs", explain: "Расскажи, как создать компанию", capability: "Ты можешь создавать компании?" },
  zh: { create: "创建一家名为 NovaScale Labs 的公司", scan: "扫描并分析网站 https://npati.com", competitors: "在互联网上研究主要竞争对手", document: "分析这个附加的 PDF 文件", image: "这张附加图片中显示了什么？", audio: "转录并总结这段附加音频", researchCreate: "研究当前的人工智能自动化市场，并根据研究结果创建一家公司", addAgents: "添加六个智能体", duplicate: "再次创建 NovaScale Labs", explain: "告诉我如何创建公司", capability: "你能创建公司吗？" },
  ja: { create: "NovaScale Labs という会社を作成して", scan: "https://npati.com をスキャンして分析して", competitors: "インターネットで主要な競合他社を調査して", document: "この添付 PDF ファイルを分析して", image: "この添付画像には何が写っていますか？", audio: "この添付音声を文字起こしして要約して", researchCreate: "現在の AI 自動化市場を調査し、その結果に基づいて会社を作成して", addAgents: "6人のエージェントを追加して", duplicate: "NovaScale Labs をもう一度作成して", explain: "会社の作成方法を教えて", capability: "会社を作成できますか？" },
  ko: { create: "NovaScale Labs라는 회사를 만들어 줘", scan: "https://npati.com 사이트를 스캔하고 분석해 줘", competitors: "인터넷에서 주요 경쟁사를 조사해 줘", document: "이 첨부 PDF 파일을 분석해 줘", image: "이 첨부 이미지에 무엇이 보이나요?", audio: "이 첨부 오디오를 전사하고 요약해 줘", researchCreate: "현재 AI 자동화 시장을 조사하고 결과를 바탕으로 회사를 만들어 줘", addAgents: "에이전트 여섯 명을 추가해 줘", duplicate: "NovaScale Labs를 다시 만들어 줘", explain: "회사를 만드는 방법을 알려 줘", capability: "회사를 만들 수 있나요?" },
  ar: { create: "أنشئ شركة باسم NovaScale Labs", scan: "افحص وحلل الموقع https://npati.com", competitors: "ابحث في الإنترنت عن المنافسين الرئيسيين", document: "حلل ملف PDF المرفق", image: "ماذا يظهر في هذه الصورة المرفقة؟", audio: "انسخ ولخص هذا الصوت المرفق", researchCreate: "ابحث في سوق أتمتة الذكاء الاصطناعي الحالي وأنشئ شركة بناءً على النتائج", addAgents: "أضف ستة وكلاء", duplicate: "أنشئ NovaScale Labs مرة أخرى", explain: "اشرح لي كيفية إنشاء شركة", capability: "هل يمكنك إنشاء شركات؟" },
  hi: { create: "NovaScale Labs नाम की कंपनी बनाएँ", scan: "https://npati.com वेबसाइट को स्कैन और विश्लेषित करें", competitors: "इंटरनेट पर मुख्य प्रतिस्पर्धियों पर शोध करें", document: "इस संलग्न PDF फ़ाइल का विश्लेषण करें", image: "इस संलग्न चित्र में क्या दिख रहा है?", audio: "इस संलग्न ऑडियो को लिखें और सारांशित करें", researchCreate: "वर्तमान AI ऑटोमेशन बाज़ार पर शोध करें और निष्कर्षों के आधार पर कंपनी बनाएँ", addAgents: "छह एजेंट जोड़ें", duplicate: "NovaScale Labs फिर से बनाएँ", explain: "मुझे बताएँ कि कंपनी कैसे बनाएँ", capability: "क्या आप कंपनियाँ बना सकते हैं?" },
};

const expected: Record<Scenario, string[]> = {
  create: ["npati_company_action"],
  scan: ["web_fetch"],
  competitors: ["web_search"],
  document: [],
  image: [],
  audio: [],
  researchCreate: ["web_search", "npati_company_action"],
  addAgents: ["npati_company_action"],
  duplicate: ["npati_company_action"],
  explain: [],
  capability: [],
};

function call(name: string, index: number): ChatToolCall {
  const args = name === "web_fetch" ? { url: "https://npati.com", goal: "analyze" }
    : name === "web_search" ? { query: "current competitors and market" }
    : { action: "create", fields: { name: "NovaScale Labs" } };
  return { id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function scriptedEngine(sequence: string[], requests: ChatRequest[]): AIEngine {
  let index = 0;
  return {
    supportsNativeTools: () => true,
    chat: async (request) => {
      requests.push(request);
      const name = sequence[index++];
      return name ? { content: "", toolCalls: [call(name, index)] } : { content: "Completed in the conversation language." };
    },
    async *stream() { throw new Error("The native loop must not use prompt-only streaming"); },
    listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
    searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
  };
}

describe("tool-selection evaluation matrix", () => {
  it("selects the expected mock tool sequence in 11 scenarios × 16 languages × 3 runs", async () => {
    const locales = Object.keys(prompts) as Locale[];
    const scenarios = Object.keys(expected) as Scenario[];
    let correct = 0;
    let total = 0;

    expect(locales).toHaveLength(16);
    expect(scenarios).toHaveLength(11);

    for (const locale of locales) {
      for (const scenario of scenarios) {
        for (let run = 0; run < RUNS_PER_CASE; run += 1) {
          const requests: ChatRequest[] = [];
          const sequence = expected[scenario];
          const history = scenario === "addAgents" || scenario === "duplicate"
            ? [{ role: "assistant" as const, content: "NovaScale Labs was created and is the selected company." }]
            : [];
          const result = await runChatToolLoop({
            ai: scriptedEngine(sequence, requests),
            request: {
              model: MODEL,
              temperature: TEMPERATURE,
              messages: [
                { role: "system", content: CHAT_TOOL_SELECTION_INSTRUCTION },
                ...history,
                { role: "user", content: prompts[locale][scenario] },
              ],
            },
            tools: () => CORE_CHAT_TOOLS,
            execute: async (tool) => ({ output: { ok: true, tool: tool.function.name } }),
          });

          const selected = result.traces.filter((trace) => trace.status === "requested").map((trace) => trace.toolName);
          total += 1;
          if (JSON.stringify(selected) === JSON.stringify(sequence)) correct += 1;
          for (const request of requests) {
            expect(request.model).toBe(MODEL);
            expect(request.temperature).toBe(TEMPERATURE);
            expect(request.toolChoice).toBe("auto");
            expect(request.tools?.map((tool) => tool.function.name)).toEqual(TOOL_ORDER);
            expect(request.messages[0]?.content).toContain("Understand the user's goal");
          }
        }
      }
    }

    expect(total).toBe(528);
    expect(correct / total).toBeGreaterThanOrEqual(0.95);
    expect(correct).toBe(total);
  });
});
