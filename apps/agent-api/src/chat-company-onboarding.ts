/**
 * A person with no company asks for a website. The chat offers to create a company at once; on "yes" it creates the
 * company, selects it in the chat and builds the website from the original request in the same turn, so a first test
 * site does not start with a trip to the company settings (V6 step 13, owner's request).
 */
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { CompanyChatLanguage } from "./company-chat-i18n";

type Copy = { offer: string; yes: string; defaultName: string; created: (name: string) => string };

const COPY: Record<CompanyChatLanguage, Copy> = {
  en: { offer: "To create a website you need a company first: every project belongs to one. I can create it right now. Reply \"yes\" or give its name, for example \"yes, Sunrise Bakery\". I will select it in this chat and start the website straight away.", yes: "Yes, create a company", defaultName: "My company", created: (n) => `Company «${n}» is created and selected in this chat. Starting the website.` },
  uk: { offer: "Щоб створити сайт, спершу потрібна компанія: кожен проєкт належить компанії. Я можу створити її просто зараз. Відповідайте «так» або вкажіть назву, наприклад «так, Пекарня Світанок». Я оберу її в цьому чаті й одразу почну створювати сайт.", yes: "Так, створи компанію", defaultName: "Моя компанія", created: (n) => `Компанію «${n}» створено й обрано в цьому чаті. Починаю створювати сайт.` },
  ru: { offer: "Чтобы создать сайт, сначала нужна компания: каждый проект принадлежит компании. Я могу создать её прямо сейчас. Ответьте «да» или укажите название, например «да, Пекарня Рассвет». Я выберу её в этом чате и сразу начну создавать сайт.", yes: "Да, создай компанию", defaultName: "Моя компания", created: (n) => `Компания «${n}» создана и выбрана в этом чате. Начинаю создавать сайт.` },
  de: { offer: "Für eine Website brauchen Sie zuerst eine Firma: Jedes Projekt gehört zu einer Firma. Ich kann sie sofort anlegen. Antworten Sie mit „ja“ oder nennen Sie den Namen, zum Beispiel „ja, Sonnenbäckerei“. Ich wähle sie in diesem Chat aus und beginne sofort mit der Website.", yes: "Ja, Firma anlegen", defaultName: "Meine Firma", created: (n) => `Die Firma «${n}» ist angelegt und in diesem Chat ausgewählt. Die Website wird jetzt erstellt.` },
  fr: { offer: "Pour créer un site web, il faut d'abord une entreprise : chaque projet appartient à une entreprise. Je peux la créer tout de suite. Répondez « oui » ou donnez son nom, par exemple « oui, Boulangerie Aurore ». Je la sélectionnerai dans ce chat et je commencerai le site aussitôt.", yes: "Oui, créer une entreprise", defaultName: "Mon entreprise", created: (n) => `L'entreprise «${n}» est créée et sélectionnée dans ce chat. Je commence le site.` },
  es: { offer: "Para crear un sitio web primero necesitas una empresa: cada proyecto pertenece a una. Puedo crearla ahora mismo. Responde «sí» o indica su nombre, por ejemplo «sí, Panadería Amanecer». La seleccionaré en este chat y empezaré el sitio enseguida.", yes: "Sí, crear una empresa", defaultName: "Mi empresa", created: (n) => `La empresa «${n}» está creada y seleccionada en este chat. Empiezo el sitio web.` },
  it: { offer: "Per creare un sito web serve prima un'azienda: ogni progetto appartiene a un'azienda. Posso crearla subito. Rispondi «sì» oppure indica il nome, per esempio «sì, Forno Aurora». La selezionerò in questa chat e inizierò subito il sito.", yes: "Sì, crea un'azienda", defaultName: "La mia azienda", created: (n) => `L'azienda «${n}» è stata creata e selezionata in questa chat. Inizio il sito web.` },
  pl: { offer: "Aby utworzyć stronę, najpierw potrzebna jest firma: każdy projekt należy do firmy. Mogę ją utworzyć od razu. Odpowiedz „tak” albo podaj nazwę, na przykład „tak, Piekarnia Świt”. Wybiorę ją w tym czacie i od razu zacznę tworzyć stronę.", yes: "Tak, utwórz firmę", defaultName: "Moja firma", created: (n) => `Firma «${n}» została utworzona i wybrana w tym czacie. Zaczynam tworzyć stronę.` },
  pt: { offer: "Para criar um site é preciso primeiro uma empresa: cada projeto pertence a uma. Posso criá-la agora mesmo. Responde «sim» ou indica o nome, por exemplo «sim, Padaria Aurora». Vou selecioná-la neste chat e começar o site de imediato.", yes: "Sim, criar uma empresa", defaultName: "A minha empresa", created: (n) => `A empresa «${n}» foi criada e selecionada neste chat. A começar o site.` },
  nl: { offer: "Voor een website is eerst een bedrijf nodig: elk project hoort bij een bedrijf. Ik kan het nu meteen aanmaken. Antwoord met „ja” of geef de naam, bijvoorbeeld „ja, Bakkerij Dageraad”. Ik selecteer het in deze chat en begin direct aan de website.", yes: "Ja, maak een bedrijf aan", defaultName: "Mijn bedrijf", created: (n) => `Bedrijf «${n}» is aangemaakt en geselecteerd in deze chat. De website wordt nu gemaakt.` },
  tr: { offer: "Web sitesi oluşturmak için önce bir şirket gerekir: her proje bir şirkete aittir. Şirketi hemen oluşturabilirim. «evet» yazın ya da adını verin, örneğin «evet, Şafak Fırını». Onu bu sohbette seçip web sitesine hemen başlayacağım.", yes: "Evet, şirket oluştur", defaultName: "Şirketim", created: (n) => `«${n}» şirketi oluşturuldu ve bu sohbette seçildi. Web sitesi oluşturuluyor.` },
  zh: { offer: "创建网站需要先有一个公司：每个项目都属于一个公司。我现在就可以为你创建。回复“是”，或直接给出名称，例如“是，晨光面包店”。我会在这个聊天中选中它，并立即开始创建网站。", yes: "是，创建公司", defaultName: "我的公司", created: (n) => `公司「${n}」已创建并在此聊天中选中。正在开始创建网站。` },
  ja: { offer: "ウェブサイトを作成するには、まず会社が必要です（プロジェクトは会社に属します）。今すぐ作成できます。「はい」と返信するか、「はい、朝焼けベーカリー」のように名前を指定してください。このチャットで会社を選択し、すぐにウェブサイトの作成を始めます。", yes: "はい、会社を作成", defaultName: "マイカンパニー", created: (n) => `会社「${n}」を作成し、このチャットで選択しました。ウェブサイトの作成を始めます。` },
  ko: { offer: "웹사이트를 만들려면 먼저 회사가 필요합니다. 모든 프로젝트는 회사에 속합니다. 지금 바로 만들어 드릴 수 있습니다. \"네\"라고 답하거나 \"네, 새벽 베이커리\"처럼 이름을 알려 주세요. 이 채팅에서 회사를 선택하고 바로 웹사이트를 만들기 시작하겠습니다.", yes: "네, 회사 만들기", defaultName: "내 회사", created: (n) => `회사 «${n}»를 만들고 이 채팅에서 선택했습니다. 웹사이트를 만들기 시작합니다.` },
  ar: { offer: "لإنشاء موقع ويب تحتاج أولًا إلى شركة، فكل مشروع ينتمي إلى شركة. يمكنني إنشاؤها الآن. أجب بـ «نعم» أو اذكر اسمها، مثل «نعم، مخبز الفجر». سأختارها في هذه الدردشة وأبدأ الموقع فورًا.", yes: "نعم، أنشئ شركة", defaultName: "شركتي", created: (n) => `تم إنشاء الشركة «${n}» واختيارها في هذه الدردشة. أبدأ الآن بإنشاء الموقع.` },
  hi: { offer: "वेबसाइट बनाने के लिए पहले एक कंपनी चाहिए: हर प्रोजेक्ट किसी कंपनी का होता है। मैं इसे अभी बना सकता हूँ। «हाँ» लिखें या नाम बताएं, जैसे «हाँ, सूर्योदय बेकरी»। मैं इसे इस चैट में चुनकर तुरंत वेबसाइट बनाना शुरू करूँगा।", yes: "हाँ, कंपनी बनाएं", defaultName: "मेरी कंपनी", created: (n) => `कंपनी «${n}» बनाई गई और इस चैट में चुनी गई। वेबसाइट बनाना शुरू कर रहा हूँ।` },
};

export function companyOnboardingCopy(language: CompanyChatLanguage): Copy {
  return COPY[language] ?? COPY.en;
}

/** Whether an assistant message is the offer above, in any language. */
export function isCompanyOffer(text: string | undefined): boolean {
  const value = String(text ?? "").trim();
  return Object.values(COPY).some((copy) => value.startsWith(copy.offer.slice(0, 40)));
}

const DECLINE = /^(?:no|nope|ні|нет|nein|non|nee|nie|não|nao|hayır|hayir|不|いいえ|아니|لا|नहीं|nahi)(?![\p{L}])/iu;
const CONFIRM = /^(?:sì|yes|yep|ok|okay|sure|go|так|да|ага|ок|ja|jawohl|oui|sí|si|tak|sim|evet|是|好|对|行|はい|ええ|네|예|نعم|حسنا|हाँ|हां|haan|ha)(?![\p{L}])/iu;

/**
 * The reply to the offer: undefined when it is not one (a decline or another request), otherwise the company name it
 * gives (a quoted name, or a short name after "yes,") or the default name.
 */
export function onboardingReply(message: string, language: CompanyChatLanguage): { name: string } | undefined {
  const value = message.trim();
  if (!value || DECLINE.test(value)) return undefined;
  const copy = companyOnboardingCopy(language);
  if (value === copy.yes || Object.values(COPY).some((item) => value === item.yes)) return { name: copy.defaultName };
  if (!CONFIRM.test(value)) return undefined;
  const quoted = /[«"“„'']([^«»"“”„'']{2,60})[»"”'']/u.exec(value)?.[1]?.trim();
  if (quoted) return { name: quoted };
  const rest = value.replace(CONFIRM, "").replace(/^[\s,.:;!，、。！-]+/u, "").trim();
  const words = rest.split(/\s+/u).filter(Boolean);
  return rest && rest.length <= 60 && words.length <= 5 && !/[?？]/u.test(rest) ? { name: rest } : { name: copy.defaultName };
}

/**
 * The turn that answers the offer: when the person has no company yet and the previous assistant message is the offer,
 * a confirmation creates the company and returns the original website request to run in this turn.
 */
export async function continueCompanyOnboarding(input: {
  store: WorkspaceStore; auth: AuthContext; message: string; language: CompanyChatLanguage;
  history: Array<{ role: string; content: string }>; idempotencyKey: string;
}): Promise<{ companyId: string; name: string; request: string; announcement: string } | undefined> {
  const { history } = input;
  const lastAssistant = [...history].reverse().find((item) => item.role === "assistant");
  if (!lastAssistant || !isCompanyOffer(lastAssistant.content)) return undefined;
  const offerIndex = history.lastIndexOf(lastAssistant);
  const request = [...history.slice(0, offerIndex)].reverse().find((item) => item.role === "user")?.content;
  if (!request) return undefined;
  const reply = onboardingReply(input.message, input.language);
  if (!reply) return undefined;
  const companies = (await input.store.listCompanies(input.auth, 1)).items;
  if (companies.length) return undefined;
  const company = await input.store.createCompany(input.auth, { name: reply.name }, input.idempotencyKey);
  return { companyId: company.id, name: company.name, request, announcement: companyOnboardingCopy(input.language).created(company.name) };
}
