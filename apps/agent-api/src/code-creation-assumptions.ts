import type { CompanyChatLanguage } from "./company-chat-i18n";

const notices: Record<CompanyChatLanguage, string> = {
  uk: "Припущення для короткого запиту: створюю базовий робочий сайт. Згенеровані назва, тексти й бізнес-дані, яких ви не надали, є прикладами для заміни на ваші дані.",
  en: "Assumptions for this brief request: a basic working website. Generated names, copy and business details you did not provide are examples to replace with your own data.",
  ru: "Предположения для краткого запроса: базовый рабочий сайт. Созданные название, тексты и данные бизнеса, которые вы не указали, — примеры для замены на ваши данные.",
  fr: "Hypothèses pour cette demande courte : un site fonctionnel de base. Les noms, textes et informations commerciales générés que vous n’avez pas fournis sont des exemples à remplacer.",
  de: "Annahmen für diese kurze Anfrage: eine einfache funktionsfähige Website. Nicht von Ihnen angegebene, generierte Namen, Texte und Geschäftsdaten sind Beispiele zum Ersetzen.",
  es: "Supuestos para esta solicitud breve: un sitio web básico funcional. Los nombres, textos y datos comerciales generados que no proporcionaste son ejemplos para reemplazar.",
  it: "Ipotesi per questa richiesta breve: un sito di base funzionante. Nomi, testi e dati aziendali generati che non hai fornito sono esempi da sostituire.",
  pl: "Założenia dla krótkiej prośby: podstawowa działająca strona. Wygenerowane nazwy, teksty i dane firmy, których nie podano, są przykładami do zastąpienia.",
  pt: "Premissas para este pedido breve: um site básico funcional. Nomes, textos e dados comerciais gerados que você não forneceu são exemplos para substituir.",
  nl: "Aannames voor dit korte verzoek: een eenvoudige werkende website. Gegenereerde namen, teksten en bedrijfsgegevens die u niet heeft verstrekt, zijn voorbeelden om te vervangen.",
  tr: "Bu kısa istek için varsayımlar: temel bir çalışan web sitesi. Sağlamadığınız, üretilen adlar, metinler ve işletme bilgileri değiştirilecek örneklerdir.",
  zh: "本次简短请求的假设：创建一个基本可用的网站。您未提供而由系统生成的名称、文案和商家信息均为示例，需替换为您的实际资料。",
  ja: "この短い依頼での前提：基本的に動作するウェブサイトを作成します。未提供の名称、文章、事業情報を生成した場合、それらは実際の情報に置き換えるための例です。",
  ko: "이 짧은 요청의 가정: 기본적으로 작동하는 웹사이트를 만듭니다. 제공하지 않은 이름, 문구, 사업 정보를 생성한 경우 실제 정보로 교체할 예시입니다.",
  ar: "افتراضات هذا الطلب المختصر: موقع أساسي يعمل. الأسماء والنصوص وبيانات النشاط التي يتم إنشاؤها ولم تقدمها هي أمثلة لاستبدالها ببياناتك.",
  hi: "इस छोटे अनुरोध के लिए धारणाएँ: एक बुनियादी कार्यशील वेबसाइट। आपके द्वारा न दिए गए जनरेट किए गए नाम, पाठ और व्यावसायिक विवरण उदाहरण हैं जिन्हें अपने डेटा से बदलना है।",
};

/** The notice as the closing note of the final reply: the result comes first, the assumption is a quoted aside. */
export function assumptionsNote(notice: string): string {
  const split = notice.match(/^([^:：]+[:：])\s*(.+)$/su);
  return split ? `> **${split[1]}** ${split[2]}` : `> ${notice}`;
}

/** Only the creation lifecycle uses this notice; it never grants permission to expand an edit. */
export function briefCreationAssumptions(message: string, language: CompanyChatLanguage = "en"): string | null {
  const brief = message.trim();
  return brief.length > 0 && brief.length <= 120 && !brief.includes("\n") ? notices[language] ?? notices.en : null;
}
