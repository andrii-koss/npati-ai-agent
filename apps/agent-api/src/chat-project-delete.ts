import { detectCompanyChatLanguage, type CompanyChatLanguage } from "./company-chat-i18n";

/**
 * Deleting a whole website/project from chat. The Coding Agent has no project deletion tool and, asked to delete a
 * site, rewrote its source into a stub; the request is therefore handled here, with the same explicit confirmation
 * step as company deletion, and the project is removed through the existing ProjectService.
 */
const deleteVerb = /^\s*(?:(?:please|будь\s+ласка|por\s+favor|bitte)[,\s]+)?(?:видали(?:ти)?|видаліть|прибери|удали(?:ть)?|delete|remove|exclua|apague|elimina|borra|lösche|entferne|supprime)(?![\p{L}])/iu;
const projectNoun = /(?:сайт\p{L}*|проєкт\p{L}*|проект\p{L}*|\bwebsite\b|\bsite\b|\bproject\b|\bprojeto\b|\bproyecto\b|\bsitio\b|\bprojekt\b|\bwebseite\b)/iu;
/** Parts of a site ("delete the /about page", "remove the hero section") are code edits, not project deletion. */
const sitePart = /(?:сторінк\p{L}*|розділ\p{L}*|секці\p{L}*|блок\p{L}*|файл\p{L}*|кнопк\p{L}*|форм\p{L}*|компонент\p{L}*|меню|\bpages?\b|\bsection\b|\bblock\b|\bfiles?\b|\bbutton\b|\bform\b|\bcomponent\b|\bmenu\b|(?:^|\s)\/[a-z0-9-]+)/iu;

export function isProjectDeleteRequest(message: string): boolean {
  return deleteVerb.test(message) && projectNoun.test(message) && !sitePart.test(message);
}

const copy: Record<"uk" | "en" | "pt" | "es" | "de" | "ru", { ask: string; done: string; confirmWord: string }> = {
  uk: { ask: "Ви хочете видалити сайт **{name}**? Файли проєкту й Live Preview буде видалено. Для підтвердження напишіть: **Так, видали сайт {name}**.", done: "Готово, сайт **{name}** видалено.", confirmWord: "Так, видали сайт" },
  ru: { ask: "Удалить сайт **{name}**? Файлы проекта и Live Preview будут удалены. Для подтверждения напишите: **Да, удали сайт {name}**.", done: "Готово, сайт **{name}** удалён.", confirmWord: "Да, удали сайт" },
  en: { ask: "Do you want to delete the website **{name}**? Its project files and Live Preview will be removed. To confirm, write: **Yes, delete website {name}**.", done: "Done. The website **{name}** was deleted.", confirmWord: "Yes, delete website" },
  pt: { ask: "Quer excluir o site **{name}**? Os ficheiros do projeto e a Live Preview serão removidos. Para confirmar, escreva: **Sim, exclui o site {name}**.", done: "Concluído. O site **{name}** foi excluído.", confirmWord: "Sim, exclui o site" },
  es: { ask: "¿Quieres eliminar el sitio **{name}**? Se borrarán sus archivos y la Live Preview. Para confirmar, escribe: **Sí, elimina el sitio {name}**.", done: "Listo. El sitio **{name}** se eliminó.", confirmWord: "Sí, elimina el sitio" },
  de: { ask: "Soll die Website **{name}** gelöscht werden? Projektdateien und Live Preview werden entfernt. Zur Bestätigung schreiben Sie: **Ja, lösche die Website {name}**.", done: "Erledigt. Die Website **{name}** wurde gelöscht.", confirmWord: "Ja, lösche die Website" },
};
const copyFor = (language: CompanyChatLanguage) => copy[language as keyof typeof copy] ?? copy.en;

/** The confirmation question; the name in it is what a following confirmation refers to. */
export function projectDeleteQuestion(message: string, project: { name: string }): string {
  return copyFor(detectCompanyChatLanguage(message)).ask.replaceAll("{name}", project.name);
}

export function projectDeletedMessage(message: string, name: string): string {
  return copyFor(detectCompanyChatLanguage(message)).done.replaceAll("{name}", name);
}

/**
 * The project name a confirmation refers to: the previous assistant message asked to delete exactly that project, and
 * the user answers yes (a short affirmative, or the written confirmation phrase), not with a new request.
 */
export function confirmedProjectDeletion(message: string, previousAssistant: string): string | undefined {
  const prefix = Object.values(copy).map((item) => item.ask.split("**{name}**")[0]!).find((value) => previousAssistant.includes(value));
  if (prefix === undefined) return undefined;
  const name = /^\*\*(.+?)\*\*/u.exec(previousAssistant.slice(previousAssistant.indexOf(prefix) + prefix.length))?.[1];
  if (!name) return undefined;
  const yes = /^\s*(?:так|да|yes|sim|sí|si|ja|oui|ok|okay|підтверджую|confirm\p{L}*)(?![\p{L}])/iu.test(message)
    || Object.values(copy).some((item) => message.toLocaleLowerCase().includes(item.confirmWord.toLocaleLowerCase()));
  return yes ? name : undefined;
}

/** Resolve a deletion target before confirmation; a confirmation never falls back to another project. */
export function projectDeleteTarget<T extends { id: string; name: string }>(projects: T[], message: string, confirmedName?: string, activeProjectId?: string | null): T | undefined {
  if (confirmedName) return projects.find(project => project.name === confirmedName);
  const lower = message.toLocaleLowerCase();
  const named = projects.map(project => ({ project, at: project.name.length > 2 ? lower.indexOf(project.name.toLocaleLowerCase()) : -1 }))
    .filter(entry => entry.at >= 0).sort((a, b) => a.at - b.at);
  if (named.length > 1) {
    // "Delete X ... Keep Y and Z": only the one site named before the keep clause is the target; otherwise ambiguous.
    const keep = lower.search(/(?:\bkeep\b|\bpreserve\b|\bretain\b|залиш|збереж|не\s+чіпай|сохрани|оставь|mant[eé]n|conserv|behalte)/iu);
    return keep >= 0 && named[0]!.at < keep && named[1]!.at > keep ? named[0]!.project : undefined;
  }
  return named[0]?.project ?? projects.find(project => project.id === activeProjectId) ?? (projects.length === 1 ? projects[0] : undefined);
}

export function noWebsiteToChangeMessage(message: string): string {
  const messages: Record<string, string> = {
    uk: "У цієї компанії зараз немає сайту, який можна змінити (його могли видалити). Створити новий сайт?",
    ru: "У этой компании сейчас нет сайта, который можно изменить (его могли удалить). Создать новый сайт?",
    pt: "Esta empresa não tem agora nenhum site para alterar (pode ter sido excluído). Criar um site novo?",
    es: "Esta empresa no tiene ahora ningún sitio que cambiar (puede que se eliminara). ¿Creo un sitio nuevo?",
    de: "Dieses Unternehmen hat derzeit keine Website, die geändert werden kann (sie wurde womöglich gelöscht). Soll eine neue erstellt werden?",
  };
  return messages[detectCompanyChatLanguage(message)] ?? "This company has no website to change right now (it may have been deleted). Create a new one?";
}
