import { detectCompanyChatLanguage, type CompanyChatLanguage } from "./company-chat-i18n";
import { PROJECT_FILE_REFERENCE } from "./chat-project-intent";

/**
 * An edit asked in a company chat where no project is chosen (V6 step 17: "add to index.html the address saved in
 * company memory" answered "choose an active project first", or went to the memory tools). The chat picks the project a
 * person would: the company's only project, or the only one that has the file the request names. Otherwise it asks, and
 * each choice is the same request naming its project, so one click runs the edit with its steps.
 */
export const EDIT_INTENTS = new Set(["EDIT_PROJECT", "EDIT_WEBSITE", "IMPROVE_PROJECT"]);

export interface EditTargetProject { id: string; name: string }

export async function pickEditProject<P extends EditTargetProject>(input: {
  projects: readonly P[];
  message: string;
  hasFile(projectId: string, path: string): Promise<boolean>;
}): Promise<{ project: P } | { choices: P[] } | null> {
  const { projects, message } = input;
  if (!projects.length) return null;
  if (projects.length === 1) return { project: projects[0]! };
  const file = PROJECT_FILE_REFERENCE.exec(message.replace(/https?:\/\/\S+/giu, " "))?.[0];
  if (file) {
    const withFile = (await Promise.all(projects.map(async (project) => (await input.hasFile(project.id, file).catch(() => false)) ? project : null)))
      .filter((project): project is Awaited<P> => project !== null) as P[];
    if (withFile.length === 1) return { project: withFile[0]! };
    if (withFile.length > 1) return { choices: withFile };
  }
  return { choices: [...projects] };
}

const IN_PROJECT: Record<CompanyChatLanguage, string> = {
  en: "In project", uk: "У проєкті", ru: "В проекте", de: "Im Projekt", fr: "Dans le projet", es: "En el proyecto", it: "Nel progetto",
  pl: "W projekcie", pt: "No projeto", nl: "In project", tr: "Projede", zh: "在项目", ja: "プロジェクト", ko: "프로젝트", ar: "في المشروع", hi: "प्रोजेक्ट में",
};

const WHICH_PROJECT: Record<CompanyChatLanguage, (file?: string) => string> = {
  en: f => f ? `${f} is in several projects of this company. Which one should I change?` : "This company has several projects. Which one should I change?",
  uk: f => f ? `${f} є в кількох проєктах цієї компанії. У якому зробити зміну?` : "У цієї компанії кілька проєктів. У якому зробити зміну?",
  ru: f => f ? `${f} есть в нескольких проектах этой компании. В каком сделать изменение?` : "У этой компании несколько проектов. В каком сделать изменение?",
  de: f => f ? `${f} gibt es in mehreren Projekten dieses Unternehmens. In welchem soll ich es ändern?` : "Dieses Unternehmen hat mehrere Projekte. Welches soll ich ändern?",
  fr: f => f ? `${f} existe dans plusieurs projets de cette entreprise. Lequel dois-je modifier ?` : "Cette entreprise a plusieurs projets. Lequel dois-je modifier ?",
  es: f => f ? `${f} está en varios proyectos de esta empresa. ¿En cuál hago el cambio?` : "Esta empresa tiene varios proyectos. ¿En cuál hago el cambio?",
  it: f => f ? `${f} è in più progetti di questa azienda. In quale faccio la modifica?` : "Questa azienda ha più progetti. In quale faccio la modifica?",
  pl: f => f ? `${f} jest w kilku projektach tej firmy. W którym wprowadzić zmianę?` : "Ta firma ma kilka projektów. W którym wprowadzić zmianę?",
  pt: f => f ? `${f} existe em vários projetos desta empresa. Em qual faço a alteração?` : "Esta empresa tem vários projetos. Em qual faço a alteração?",
  nl: f => f ? `${f} staat in meerdere projecten van dit bedrijf. In welk project moet ik het wijzigen?` : "Dit bedrijf heeft meerdere projecten. Welk project moet ik wijzigen?",
  tr: f => f ? `${f} bu şirketin birkaç projesinde var. Hangisinde değişiklik yapayım?` : "Bu şirketin birkaç projesi var. Hangisinde değişiklik yapayım?",
  zh: f => f ? `${f} 存在于该公司的多个项目中。要修改哪一个？` : "该公司有多个项目。要修改哪一个？",
  ja: f => f ? `${f} はこの会社の複数のプロジェクトにあります。どれを変更しますか？` : "この会社には複数のプロジェクトがあります。どれを変更しますか？",
  ko: f => f ? `${f} 파일이 이 회사의 여러 프로젝트에 있습니다. 어느 프로젝트를 변경할까요?` : "이 회사에는 프로젝트가 여러 개 있습니다. 어느 프로젝트를 변경할까요?",
  ar: f => f ? `${f} موجود في عدة مشاريع لهذه الشركة. في أي مشروع أُجري التغيير؟` : "لدى هذه الشركة عدة مشاريع. في أي مشروع أُجري التغيير؟",
  hi: f => f ? `${f} इस कंपनी के कई प्रोजेक्ट में है। बदलाव किस प्रोजेक्ट में करूँ?` : "इस कंपनी के कई प्रोजेक्ट हैं। बदलाव किस प्रोजेक्ट में करूँ?",
};

/** The question when the project cannot be told, in the request's language, naming the file when the request does. */
export function whichProjectQuestion(message: string, choices: readonly EditTargetProject[]): string {
  const file = PROJECT_FILE_REFERENCE.exec(message.replace(/https?:\/\/\S+/giu, " "))?.[0];
  const ask = (WHICH_PROJECT[detectCompanyChatLanguage(message)] ?? WHICH_PROJECT.en)(file ? `\`${file}\`` : undefined);
  return ask + "\n\n" + choices.map((project) => `- **${project.name}**`).join("\n");
}

/** The request as it would be written with the project named, in the request's language; the chat binds a named project. */
export const editChoiceAction = (projectName: string, message: string) =>
  `${IN_PROJECT[detectCompanyChatLanguage(message)] ?? IN_PROJECT.en} «${projectName}»: ${message.trim()}`;

/**
 * The person's answer to the which-project question ("Game", "у Shared API Site"): the project it names among the ones
 * the question listed, and the request that question was about. Nothing when the last answer was not that question,
 * the reply names no listed project or names more than one.
 */
export function answeredProjectChoice<P extends EditTargetProject>(message: string, history: ReadonlyArray<{ role: string; content: string }>, projects: readonly P[]):
  { project: P; request: string } | null {
  const lastAssistant = [...history].map((item, index) => ({ item, index })).reverse().find(({ item }) => item.role === "assistant");
  if (!lastAssistant) return null;
  const listed = [...lastAssistant.item.content.matchAll(/^- \*\*(.+)\*\*$/gmu)].map((match) => match[1]!.trim());
  if (listed.length < 2) return null;
  const request = [...history.slice(0, lastAssistant.index)].reverse().find((item) => item.role === "user")?.content.trim();
  if (!request) return null;
  const reply = message.toLocaleLowerCase().replace(/[«»"'“”„]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!reply || reply.length > 160) return null;
  const offered = projects.filter((project) => listed.includes(project.name));
  // The whole name in the reply wins; otherwise a distinctive word of a name ("game" for "V6TEST16 Game").
  const whole = offered.filter((project) => reply.includes(project.name.toLocaleLowerCase()));
  const named = whole.length ? whole : offered.filter((project) =>
    reply.split(" ").some((word) => word.length >= 3 && project.name.toLocaleLowerCase().split(/\s+/u).includes(word)));
  return named.length === 1 ? { project: named[0]!, request } : null;
}

/** The which-project question this module asks: a plain question followed by a list of two or more project names. */
export const isWhichProjectQuestion = (content: string) => /\n\n- \*\*.+\*\*(?:\n- \*\*.+\*\*)+\s*$/u.test(content);
