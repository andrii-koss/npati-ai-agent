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

const MISSING: Record<CompanyChatLanguage, (name: string) => string> = {
  en: (n) => `I could not find an active project named “${n}” in your companies. Check the name, or open that project's chat, and I will make the change there.`,
  uk: (n) => `Я не знайшов активного проєкту з назвою «${n}» у ваших компаніях. Перевірте назву або відкрийте чат цього проєкту, і я внесу зміну там.`,
  fr: (n) => `Je n'ai trouvé aucun projet actif nommé « ${n} » dans vos entreprises. Vérifiez le nom ou ouvrez le chat de ce projet, et j'y ferai la modification.`,
  de: (n) => `Ich habe in Ihren Unternehmen kein aktives Projekt namens „${n}“ gefunden. Prüfen Sie den Namen oder öffnen Sie den Chat dieses Projekts, dann nehme ich die Änderung dort vor.`,
  es: (n) => `No encontré ningún proyecto activo llamado «${n}» en tus empresas. Revisa el nombre o abre el chat de ese proyecto y haré el cambio allí.`,
  it: (n) => `Non ho trovato alcun progetto attivo chiamato «${n}» nelle tue aziende. Controlla il nome o apri la chat di quel progetto e farò la modifica lì.`,
  pl: (n) => `Nie znalazłem aktywnego projektu o nazwie „${n}” w Twoich firmach. Sprawdź nazwę lub otwórz czat tego projektu, a wprowadzę tam zmianę.`,
  pt: (n) => `Não encontrei nenhum projeto ativo chamado «${n}» nas suas empresas. Verifique o nome ou abra o chat desse projeto e farei a alteração lá.`,
  nl: (n) => `Ik heb in je bedrijven geen actief project met de naam “${n}” gevonden. Controleer de naam of open de chat van dat project, dan voer ik de wijziging daar uit.`,
  tr: (n) => `Şirketlerinizde “${n}” adlı etkin bir proje bulamadım. Adı kontrol edin ya da o projenin sohbetini açın, değişikliği orada yapayım.`,
  ru: (n) => `Я не нашёл активного проекта с названием «${n}» в ваших компаниях. Проверьте название или откройте чат этого проекта, и я внесу изменение там.`,
  zh: (n) => `在您的公司中没有找到名为“${n}”的活动项目。请检查名称或打开该项目的聊天，我会在那里进行修改。`,
  ja: (n) => `あなたの会社に「${n}」という名前の有効なプロジェクトが見つかりませんでした。名前を確認するか、そのプロジェクトのチャットを開いてください。そこで変更します。`,
  ko: (n) => `회사에서 “${n}”(이)라는 활성 프로젝트를 찾지 못했습니다. 이름을 확인하거나 해당 프로젝트의 채팅을 열어 주시면 그곳에서 변경하겠습니다.`,
  ar: (n) => `لم أجد مشروعًا نشطًا باسم «${n}» في شركاتك. تحقّق من الاسم أو افتح محادثة ذلك المشروع، وسأُجري التغيير هناك.`,
  hi: (n) => `आपकी कंपनियों में “${n}” नाम का कोई सक्रिय प्रोजेक्ट नहीं मिला। नाम जांचें या उस प्रोजेक्ट की चैट खोलें, मैं वहीं बदलाव करूंगा।`,
};

/** The answer for a quoted project name no owned company has: a question in the chat, not an English HTTP 400 (V6 step 18). */
export function namedProjectMissingQuestion(message: string, name: string): string {
  return (MISSING[detectCompanyChatLanguage(message)] ?? MISSING.en)(name);
}

const ALREADY_CREATED: Record<CompanyChatLanguage, (name: string) => string> = {
  en: (n) => `The site “${n}” has already been created in this chat, so I did not create a second copy. Ask for a change and I will make it there; if you need another site, give it a different name.`,
  uk: (n) => `Сайт «${n}» уже створено в цьому чаті, тому другу копію я не створював. Попросіть зміну — я внесу її там; якщо потрібен ще один сайт, дайте йому іншу назву.`,
  fr: (n) => `Le site « ${n} » a déjà été créé dans ce chat, je n'en ai donc pas créé une seconde copie. Demandez une modification et je la ferai ; pour un autre site, donnez-lui un autre nom.`,
  de: (n) => `Die Website „${n}“ wurde in diesem Chat bereits erstellt, daher habe ich keine zweite Kopie angelegt. Bitten Sie um eine Änderung, dann nehme ich sie dort vor; für eine weitere Website wählen Sie einen anderen Namen.`,
  es: (n) => `El sitio «${n}» ya se creó en este chat, así que no creé una segunda copia. Pide un cambio y lo haré allí; si necesitas otro sitio, dale otro nombre.`,
  it: (n) => `Il sito «${n}» è già stato creato in questa chat, quindi non ne ho creato una seconda copia. Chiedi una modifica e la farò lì; per un altro sito, dagli un nome diverso.`,
  pl: (n) => `Strona „${n}” została już utworzona w tym czacie, więc nie utworzyłem drugiej kopii. Poproś o zmianę, a wprowadzę ją tam; jeśli potrzebujesz kolejnej strony, nadaj jej inną nazwę.`,
  pt: (n) => `O site «${n}» já foi criado neste chat, por isso não criei uma segunda cópia. Peça uma alteração e eu faço-a lá; se precisar de outro site, dê-lhe outro nome.`,
  nl: (n) => `De site “${n}” is al in deze chat gemaakt, dus ik heb geen tweede kopie gemaakt. Vraag om een wijziging en ik voer die daar uit; geef een andere site een andere naam.`,
  tr: (n) => `“${n}” sitesi bu sohbette zaten oluşturuldu, bu yüzden ikinci bir kopya oluşturmadım. Bir değişiklik isteyin, orada yapayım; başka bir site gerekiyorsa ona farklı bir ad verin.`,
  ru: (n) => `Сайт «${n}» уже создан в этом чате, поэтому вторую копию я не создавал. Попросите изменение — я внесу его там; если нужен ещё один сайт, дайте ему другое название.`,
  zh: (n) => `网站“${n}”已在此聊天中创建，所以我没有再创建一个副本。请提出修改，我会在那里进行；如果需要另一个网站，请为它取一个不同的名字。`,
  ja: (n) => `サイト「${n}」はこのチャットですでに作成済みのため、2つ目のコピーは作成しませんでした。変更を依頼してください。そこで行います。別のサイトが必要なら別の名前を付けてください。`,
  ko: (n) => `“${n}” 사이트는 이 채팅에서 이미 만들어져 두 번째 사본은 만들지 않았습니다. 변경을 요청하시면 그곳에서 진행하겠습니다. 다른 사이트가 필요하면 다른 이름을 지정해 주세요.`,
  ar: (n) => `أُنشئ الموقع «${n}» بالفعل في هذه المحادثة، لذلك لم أُنشئ نسخة ثانية. اطلب تعديلًا وسأجريه هناك؛ وإن احتجت موقعًا آخر فأعطه اسمًا مختلفًا.`,
  hi: (n) => `साइट “${n}” इस चैट में पहले ही बन चुकी है, इसलिए मैंने दूसरी कॉपी नहीं बनाई। बदलाव बताइए, मैं वहीं कर दूंगा; दूसरी साइट चाहिए तो उसे अलग नाम दें।`,
};

/** The answer to a create request repeated in the chat that already made that project (V6 step 18). */
export function projectAlreadyCreatedInChat(message: string, name: string): string {
  return (ALREADY_CREATED[detectCompanyChatLanguage(message)] ?? ALREADY_CREATED.en)(name);
}

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
