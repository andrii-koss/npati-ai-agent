import { ContextValidationError } from "@npati/shared";
import { detectCompanyChatLanguage, type CompanyChatLanguage } from "./company-chat-i18n";

/**
 * Several owned projects share the name a request uses. It is a question to the person, answered in the chat like any
 * reply, not a failed request: the error toast it used to be vanished after eight seconds and left nothing in the chat
 * (V6 step 15, V6-102).
 */
export class ProjectNameAmbiguityError extends ContextValidationError {
  constructor(readonly question: string) {
    super(question);
    this.name = "ProjectNameAmbiguityError";
  }
}

type Copy = { intro: (name: string) => string; created: string; changed: string; ask: string };
const COPY: Record<CompanyChatLanguage, Copy> = {
  en: { intro: (n) => `More than one owned project is named “${n}”:`, created: "created", changed: "changed", ask: "Which one do you mean? Open that project's chat or name it unambiguously, and I will make the change there." },
  uk: { intro: (n) => `Знайдено кілька проєктів із назвою «${n}»:`, created: "створено", changed: "змінено", ask: "Який із них ви маєте на увазі? Відкрийте чат потрібного проєкту або назвіть його однозначно, і я внесу зміну там." },
  fr: { intro: (n) => `Plusieurs de vos projets s'appellent « ${n} » :`, created: "créé", changed: "modifié", ask: "Lequel voulez-vous dire ? Ouvrez le chat de ce projet ou nommez-le sans ambiguïté, et j'y ferai la modification." },
  de: { intro: (n) => `Mehrere Ihrer Projekte heißen „${n}“:`, created: "erstellt", changed: "geändert", ask: "Welches meinen Sie? Öffnen Sie den Chat dieses Projekts oder nennen Sie es eindeutig, dann nehme ich die Änderung dort vor." },
  es: { intro: (n) => `Varios de tus proyectos se llaman «${n}»:`, created: "creado", changed: "modificado", ask: "¿Cuál de ellos quieres decir? Abre el chat de ese proyecto o nómbralo sin ambigüedad y haré el cambio allí." },
  it: { intro: (n) => `Più progetti si chiamano «${n}»:`, created: "creato", changed: "modificato", ask: "Quale intendi? Apri la chat di quel progetto o indicalo in modo univoco e farò la modifica lì." },
  pl: { intro: (n) => `Kilka Twoich projektów nazywa się „${n}”:`, created: "utworzono", changed: "zmieniono", ask: "Który z nich masz na myśli? Otwórz czat tego projektu lub nazwij go jednoznacznie, a wprowadzę tam zmianę." },
  pt: { intro: (n) => `Vários dos seus projetos se chamam «${n}»:`, created: "criado", changed: "alterado", ask: "Qual deles você quer dizer? Abra o chat desse projeto ou nomeie-o sem ambiguidade, e farei a alteração lá." },
  nl: { intro: (n) => `Meerdere van je projecten heten “${n}”:`, created: "gemaakt", changed: "gewijzigd", ask: "Welke bedoel je? Open de chat van dat project of noem het eenduidig, dan voer ik de wijziging daar uit." },
  tr: { intro: (n) => `Birden fazla projenizin adı “${n}”:`, created: "oluşturuldu", changed: "değiştirildi", ask: "Hangisini kastediyorsunuz? O projenin sohbetini açın ya da adını açıkça belirtin, değişikliği orada yapayım." },
  ru: { intro: (n) => `Найдено несколько проектов с названием «${n}»:`, created: "создан", changed: "изменён", ask: "Какой из них вы имеете в виду? Откройте чат нужного проекта или назовите его однозначно, и я внесу изменение там." },
  zh: { intro: (n) => `有多个项目名为“${n}”：`, created: "创建于", changed: "修改于", ask: "您指的是哪一个？请打开该项目的聊天或明确说明名称，我会在那里进行修改。" },
  ja: { intro: (n) => `「${n}」という名前のプロジェクトが複数あります：`, created: "作成", changed: "変更", ask: "どれのことですか？そのプロジェクトのチャットを開くか、はっきり区別できる名前で指定してください。そこで変更します。" },
  ko: { intro: (n) => `“${n}”(이)라는 이름의 프로젝트가 여러 개 있습니다:`, created: "생성", changed: "변경", ask: "어느 것을 말씀하시나요? 해당 프로젝트의 채팅을 열거나 이름을 명확히 알려 주시면 그곳에서 변경하겠습니다." },
  ar: { intro: (n) => `يوجد أكثر من مشروع باسم «${n}»:`, created: "أُنشئ", changed: "عُدّل", ask: "أيّها تقصد؟ افتح محادثة ذلك المشروع أو سمّه بوضوح، وسأُجري التغيير هناك." },
  hi: { intro: (n) => `“${n}” नाम के एक से अधिक प्रोजेक्ट हैं:`, created: "बनाया गया", changed: "बदला गया", ask: "आपका मतलब किससे है? उस प्रोजेक्ट की चैट खोलें या उसका नाम स्पष्ट रूप से बताएं, मैं वहीं बदलाव करूंगा।" },
};

export interface SameNameProject { id: string; name: string; companyId: string; framework?: string | null; createdAt?: unknown; updatedAt?: unknown }

/** The question for a name several projects share, with the company, stack, dates and short id that tell them apart. */
export function sameNameProjectQuestion(message: string, projects: SameNameProject[], companyName: (companyId: string) => string): string {
  const copy = COPY[detectCompanyChatLanguage(message)] ?? COPY.en;
  // The dates come as Date objects: String(date).slice(0, 10) gave "Fri Nov 13" for both projects, so the person could not
  // tell them apart (V6 D08-04). Minutes, the stack and a short id do.
  const when = (value: unknown) => { const date = value instanceof Date ? value : new Date(String(value ?? "")); return Number.isNaN(date.getTime()) ? "?" : date.toISOString().slice(0, 16).replace("T", " ") + " UTC"; };
  const list = projects.slice(0, 6).map((p) => `- ${p.name} — ${companyName(p.companyId)}, ${p.framework ? p.framework + ", " : ""}${copy.created} ${when(p.createdAt)}, ${copy.changed} ${when(p.updatedAt)}, id ${p.id.slice(0, 8)}`).join("\n");
  return `${copy.intro(projects[0]!.name)}\n${list}\n\n${copy.ask}`;
}
