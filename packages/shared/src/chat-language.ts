/**
 * The language a chat message is written in, for the 16 chat languages. Moved from the API (company-chat-i18n.ts) so the
 * web chat uses the same reading: the web had its own small word lists and gave an English request naming «… EN Site»
 * Hindi card labels and an Italian question French ones (V6 step 14).
 */
export type CompanyChatLanguage = "en" | "uk" | "fr" | "de" | "es" | "it" | "pl" | "pt" | "nl" | "tr" | "ru" | "zh" | "ja" | "ko" | "ar" | "hi";

const languageSamples: Record<Exclude<CompanyChatLanguage, "zh" | "ja" | "ko" | "ar" | "hi">, string> = {
  en: "Please create a company and explain the plan clearly. Add six specialized agents, review the website, summarize the results, and continue the conversation in English. Delete everything you just created only after the user confirms the action.",
  uk: "Будь ласка, створи компанію та чітко поясни план. Додай шість спеціалізованих агентів, проаналізуй вебсайт, підсумуй результати й продовжуй розмову українською мовою. Тепер видали все, що тільки-но створив, і попроси підтвердження.",
  fr: "Veuillez créer une entreprise et expliquer clairement le plan. Ajoutez six agents spécialisés, analysez le site et résumez les résultats. Supprime tout ce que tu viens de créer seulement après avoir demandé une confirmation. Nous changeons maintenant de langue et continuons toute la discussion en français. La réponse doit rester claire, cohérente et utile pour la conversation actuelle.",
  de: "Bitte erstellen Sie ein Unternehmen und erklären Sie den Plan klar. Fügen Sie sechs spezialisierte Agenten hinzu, analysieren Sie die Website und fassen Sie die Ergebnisse zusammen. Lösche alles, was du gerade erstellt hast, erst nach einer Bestätigung.",
  es: "Por favor, crea una empresa y explica el plan con claridad. Añade seis agentes especializados, analiza el sitio web y resume los resultados. Elimina todo lo que acabas de crear solamente después de pedir confirmación.",
  it: "Per favore, crea un'azienda e spiega chiaramente il piano. Aggiungi sei agenti specializzati, analizza il sito e riassumi i risultati. Elimina tutto ciò che hai appena creato soltanto dopo la conferma.",
  pl: "Utwórz firmę i jasno wyjaśnij plan. Dodaj sześciu wyspecjalizowanych agentów, przeanalizuj stronę internetową i podsumuj wyniki. Usuń wszystko, co właśnie utworzyłeś, dopiero po potwierdzeniu.",
  pt: "Por favor, crie uma empresa e explique o plano com clareza. Adicione seis agentes especializados, analise o site e resuma os resultados. Exclua tudo o que acabou de criar somente depois da confirmação.",
  nl: "Maak een bedrijf en leg het plan duidelijk uit. Voeg zes gespecialiseerde agenten toe, analyseer de website en vat de resultaten samen. Verwijder alles wat je zojuist hebt gemaakt pas na bevestiging.",
  tr: "Lütfen bir şirket oluşturun ve planı açıkça anlatın. Altı uzman ajan ekleyin, internet sitesini analiz edin, sonuçları özetleyin ve konuşmaya Türkçe devam edin.",
  ru: "Пожалуйста, создайте компанию и ясно объясните план. Добавьте шесть специализированных агентов, проанализируйте сайт и подведите итоги. Удали всё, что только что создал, только после подтверждения.",
};

const languageCalibrationSamples: Partial<Record<keyof typeof languageSamples, string>> = {
  en: "Open and analyze the supplied URL. Scan the public website, research current competitors, and report verified external evidence.",
  pt: "Pesquise na web os concorrentes atuais de automação em Portugal e apresente fontes externas verificadas.",
};

export function normalizedLanguageText(value: string): string {
  // Quoted names ("Stress Bakery", «Пекарня») and codes (PICKUP_ORANGE_734, DS1023) are not evidence of the user's language.
  return value.normalize("NFKC")
    .replace(/"[^"\n]{1,160}"|«[^»\n]{1,160}»|“[^”\n]{1,160}”|„[^“”\n]{1,160}[“”]/gu, " ")
    .replace(/[A-Za-z0-9]*[0-9_][A-Za-z0-9_]*/g, " ")
    .toLocaleLowerCase().replace(/https?:\/\/\S+|```[\s\S]*?```|`[^`]*`/gu, " ").replace(/[^\p{L}\p{M}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function ngramProfile(value: string): Map<string, number> {
  const profile = new Map<string, number>();
  for (const word of normalizedLanguageText(value).split(" ").filter(Boolean)) {
    const padded = ` ${word} `;
    for (let index = 0; index <= padded.length - 3; index += 1) {
      const gram = padded.slice(index, index + 3);
      profile.set(gram, (profile.get(gram) ?? 0) + 1);
    }
  }
  return profile;
}

const profiles = Object.fromEntries(Object.entries(languageSamples).map(([language, sample]) => [
  language,
  ngramProfile(sample + " " + (languageCalibrationSamples[language as keyof typeof languageSamples] ?? "")),
])) as Record<keyof typeof languageSamples, Map<string, number>>;

function profileSimilarity(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0; let leftSize = 0; let rightSize = 0;
  for (const value of left.values()) leftSize += value * value;
  for (const [gram, value] of right) { rightSize += value * value; dot += value * (left.get(gram) ?? 0); }
  return leftSize && rightSize ? dot / Math.sqrt(leftSize * rightSize) : 0;
}

/** Ukrainian and Russian words without the letters that tell the languages apart ("Який код ми зберегли для X?"). */
export const cyrillicFunctionWords: Record<"uk" | "ru", Set<string>> = {
  uk: new Set(["який", "яка", "яке", "якого", "якому", "що", "щоб", "та", "або", "чи", "ще", "коли", "зараз", "хто", "вона", "вони", "воно", "треба", "щодо", "зберегли", "нагадай", "покажи", "перелічи", "створи", "додай", "видали", "зміни", "поміняй", "зроби", "знайди", "постав", "перейди", "збережи", "будь", "його", "її", "мені", "потрібно", "бізнесу", "цей", "ця", "шо", "як", "справи", "хай", "нехай", "дякую", "добре"]),
  ru: new Set(["какой", "какая", "какое", "какого", "что", "чтобы", "или", "где", "сейчас", "кто", "она", "они", "оно", "нужно", "когда", "сохранили", "напомни", "покажи", "перечисли", "создай", "добавь", "удали", "измени", "поменяй", "сделай", "найди", "поставь", "переключись", "сохрани", "пожалуйста", "его", "мне", "надо", "бизнеса", "этот", "эта", "чё", "поищи", "запомни", "какие", "новая", "привет", "как", "дела", "сегодня", "давай", "пусть", "спасибо", "хорошо"]),
};
const latinOnlyLetters: Partial<Record<CompanyChatLanguage, RegExp>> = { pl: /[ąćęłńśźż]/u, tr: /[ğış]/u, pt: /[ãõ]/u, es: /[ñ]/u, de: /[ßä]/u, fr: /[œîïû]/u };

const functionWords: Record<"en" | "fr" | "de" | "es" | "it" | "pl" | "pt" | "nl" | "tr", Set<string>> = {
  en: new Set(["the", "and", "for", "from", "with", "every", "our", "my", "your", "have", "has", "is", "are", "this", "that", "please", "show", "what", "which", "how", "me", "it", "of", "to", "by", "at", "on", "an", "its", "did", "we", "do", "does", "now", "you", "new", "be", "can", "there", "whats", "pls", "wkly", "where", "build", "make", "create", "set", "add", "write", "switch", "hi", "hello", "doing", "today", "game", "catches", "falling"]),
  fr: new Set(["le", "les", "et", "pour", "avec", "une", "est", "dans", "des", "du", "nous", "vous", "sur", "pas", "qui", "au", "aux", "chaque", "quel", "quelle", "notre", "nos", "mets", "ajoute", "crée", "nouvelle", "hebdo", "son", "sa"]),
  de: new Set(["der", "die", "das", "und", "mit", "für", "ist", "nicht", "ein", "eine", "auf", "bitte", "wir", "ich", "zu", "den", "dem", "welche", "welchen", "welcher", "dieser", "haben", "hat", "jetzt", "unser", "unsere", "zur", "zum", "firma", "wechsle", "hallo", "geht", "dir", "heute", "mir", "erstelle", "ändere", "schreib", "lass"]),
  es: new Set(["el", "los", "las", "y", "para", "con", "una", "es", "está", "por", "qué", "cómo", "del", "al", "tiene", "cada", "antes", "cuál", "hay", "ahora", "guardamos", "sus", "pon", "añade", "anade", "su", "nueva", "semanal", "informe", "cuántas", "cuántos", "hola", "estás", "hoy", "haz", "nuestro", "nuestra", "negocio", "jóvenes", "público", "investiga", "fuentes", "escribe", "cambia", "tenemos", "tienes", "pues", "vale", "solo", "muestra", "muestralas", "muéstralas", "cambies", "canbies", "dime", "dímelos", "porfa", "oye", "puedes", "quiénes", "nuestros", "nuestras", "recuerdas", "hagas", "hazme", "agrega", "hasta", "asta", "aora", "negosio", "llámalo", "acuérdate", "bicis", "línea", "nuevo"]),
  it: new Set(["il", "gli", "per", "una", "è", "che", "non", "sono", "della", "alla", "nel", "degli", "di", "dell", "nella", "alle", "ogni", "sul", "quale", "abbiamo", "delle", "dei", "c", "tramite", "suo", "sua", "nuova", "ore", "metti", "aggiungi", "progetto", "questa", "questo", "quante", "quanti", "sue", "suoi", "ciao", "stai", "oggi", "imposta", "obiettivo", "entro", "vendere", "dammi", "fonti", "ricerca", "prezzi", "tabella", "prodotti", "prezzo", "scorte", "fammi", "scrivi", "nostro", "profilo", "aziendale", "pubblico", "famiglie", "giovani"]),
  pl: new Set(["w", "z", "na", "się", "jest", "nie", "dla", "oraz", "że", "jak", "do", "to", "jaki", "jaka", "każdy", "naszego", "przez", "co", "tam", "masz", "jej", "ten", "zmień", "dodaj", "utwórz", "jakie", "ma", "ją", "codziennie"]),
  pt: new Set(["o", "os", "as", "para", "com", "uma", "é", "está", "não", "você", "do", "da", "em", "no", "na", "dos", "das", "ao", "nosso", "nossa", "toda", "até", "qual", "agora", "tem", "adicione", "crie", "dados", "dele", "dela", "olá", "hoje", "faz", "muda", "pão", "sextas", "escreve", "pesquisa", "indica", "lembra"]),
  nl: new Set(["het", "een", "van", "met", "voor", "niet", "wij", "ik", "naar", "ook", "op", "om", "elke", "welke", "je", "er", "nu", "toe", "zet", "wat", "staat", "zoek", "noem", "zijn", "wijzig"]),
  tr: new Set(["ve", "bir", "bu", "için", "ile", "çok", "gibi", "her", "olarak", "hangi", "şu", "ne", "var", "yap", "ekle", "değiştir", "oluştur", "içinde", "deki"]),
};

/**
 * Ukrainian and Russian typed in Latin letters ("na sajti zmini zagolovok", "sdelai lending sait") were answered in
 * Italian or Dutch (V6 step 13). Two words from one list decide; the reply is then in that language.
 */
const transliteratedWords: Record<"uk" | "ru" | "hi", Set<string>> = {
  uk: new Set(["zmini", "zminy", "zroby", "zrobi", "shcho", "sho", "sajti", "sajt", "sayt", "sayti", "dlya", "budlaska", "pryvit", "yak", "spravy", "dyakuyu", "svizhyj", "svizhyi", "hlib", "shchoranku", "zapamyataj", "stvory", "dodaj", "pokazhy", "potribno", "zaraz", "meni"]),
  ru: new Set(["sdelai", "sdelaj", "sdelay", "pozhaluista", "pozhaluysta", "pojaluista", "dlia", "sait", "privet", "kak", "dela", "spasibo", "svezhii", "svezhiy", "hleb", "khleb", "zapomni", "sozdai", "sozdaj", "dobav", "pokazhi", "nuzhno", "seichas", "mne", "pekarni", "lending"]),
  // Hindi written in Latin letters (Hinglish) was answered in Italian and French (V6 step 13).
  hi: new Set(["hai", "hain", "kya", "karo", "karna", "kar", "mat", "mein", "aur", "hamare", "hamara", "hamari", "tumhe", "tumhara", "yaar", "baare", "kaun", "bana", "nahi", "nahin", "jisme", "paas", "liye", "bahut", "kuch", "zara", "yaad", "mujhe", "aap", "kijiye", "chahiye", "wala", "wali"]),
};

export function detectedLanguage(message: string): { language: CompanyChatLanguage; confidence: number; letters: number } {
  const normalized = normalizedLanguageText(message);
  const letters = [...normalized].filter((character) => /\p{L}/u.test(character)).length;
  if (/[ぁ-ゟ゠-ヿ]/u.test(normalized)) return { language: "ja", confidence: 1, letters };
  if (/[가-힣]/u.test(normalized)) return { language: "ko", confidence: 1, letters };
  if (/\p{Script=Han}/u.test(normalized)) return { language: "zh", confidence: 1, letters };
  if (/\p{Script=Arabic}/u.test(normalized)) return { language: "ar", confidence: 1, letters };
  if (/\p{Script=Devanagari}/u.test(normalized)) return { language: "hi", confidence: 1, letters };
  const ukrainian = /[\u0456\u0457\u0454\u0491]/u.test(normalized);
  const russian = /[\u044b\u044d\u0451\u044a]/u.test(normalized);
  if (ukrainian && !russian) return { language: "uk", confidence: 1, letters };
  if (russian && !ukrainian) return { language: "ru", confidence: 1, letters };
  const candidates = /\p{Script=Cyrillic}/u.test(normalized)
    ? (["uk", "ru"] as const)
    : (["en", "fr", "de", "es", "it", "pl", "pt", "nl", "tr"] as const);
  if (candidates[0] === "uk") {
    const words = normalized.split(" ");
    const uk = words.filter((word) => cyrillicFunctionWords.uk.has(word)).length, ru = words.filter((word) => cyrillicFunctionWords.ru.has(word)).length;
    if (uk !== ru) return { language: uk > ru ? "uk" : "ru", confidence: 1, letters };
  }
  if (candidates[0] === "en") {
    const latinWords = normalized.split(" ");
    const translit = (["uk", "ru", "hi"] as const).map((language) => ({ language, count: latinWords.filter((word) => transliteratedWords[language].has(word)).length }))
      .sort((left, right) => right.count - left.count);
    if (translit[0]!.count >= 2 && translit[0]!.count > translit[1]!.count) return { language: translit[0]!.language, confidence: 1, letters };
    // Inverted question and exclamation marks are written only in Spanish.
    if (/[¿¡]/u.test(message)) return { language: "es", confidence: 1, letters };
    // Letters that only one supported Latin-script language uses decide what the small trigram samples misread (V5-D75).
    const lettered = Object.entries(latinOnlyLetters).filter(([, pattern]) => pattern.test(normalized)).map(([language]) => language as CompanyChatLanguage);
    if (lettered.length === 1) return { language: lettered[0]!, confidence: 1, letters };
    // Function words decide short Latin-script messages, which the small trigram samples misread
    // ("Remember for Nordic Fit: classes start every hour from 7am to 9pm." scored as French).
    const words = normalized.split(" ");
    const hits = Object.entries(functionWords).map(([language, set]) => ({ language: language as CompanyChatLanguage, count: words.filter((word) => set.has(word)).length }))
      .sort((left, right) => right.count - left.count);
    // Very short utterances may have only one distinguishing function word. Longer abbreviations still use profiles.
    if ((hits[0]!.count >= 2 || (letters < 18 && hits[0]!.count === 1)) && hits[0]!.count > hits[1]!.count) {
      return { language: hits[0]!.language, confidence: hits[0]!.count === 1 ? 0.1 : 1, letters };
    }
  }
  const input = ngramProfile(normalized);
  const ranked = candidates.map((language) => ({ language, score: profileSimilarity(input, profiles[language]) })).sort((left, right) => right.score - left.score);
  return { language: ranked[0]?.language ?? "en", confidence: Math.max(0, (ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0)), letters };
}

export function detectCompanyChatLanguage(message = ""): CompanyChatLanguage {
  return detectedLanguage(message).language;
}
