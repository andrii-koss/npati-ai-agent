import { detectCompanyChatLanguage, type CompanyChatLanguage } from "./company-chat-i18n";

/**
 * The chat line written when the Coding Agent creates a project database. It existed only in Ukrainian and English and
 * followed the language the project was created in, so a Hindi request about an English site got
 * "Created database: …" (V6 step 14). It now follows the language of the person's latest message.
 */
const CREATED: Record<CompanyChatLanguage, (name: string) => string> = {
  en: (n) => `Created database «${n}» for this project.`,
  uk: (n) => `Створено базу даних «${n}» для цього проєкту.`,
  ru: (n) => `Создана база данных «${n}» для этого проекта.`,
  de: (n) => `Datenbank «${n}» für dieses Projekt erstellt.`,
  fr: (n) => `Base de données «${n}» créée pour ce projet.`,
  es: (n) => `Base de datos «${n}» creada para este proyecto.`,
  it: (n) => `Database «${n}» creato per questo progetto.`,
  pl: (n) => `Utworzono bazę danych «${n}» dla tego projektu.`,
  pt: (n) => `Base de dados «${n}» criada para este projeto.`,
  nl: (n) => `Database «${n}» aangemaakt voor dit project.`,
  tr: (n) => `Bu proje için «${n}» veritabanı oluşturuldu.`,
  zh: (n) => `已为此项目创建数据库«${n}»。`,
  ja: (n) => `このプロジェクトのデータベース«${n}»を作成しました。`,
  ko: (n) => `이 프로젝트의 데이터베이스 «${n}»을(를) 만들었습니다.`,
  ar: (n) => `تم إنشاء قاعدة البيانات «${n}» لهذا المشروع.`,
  hi: (n) => `इस प्रोजेक्ट के लिए डेटाबेस «${n}» बनाया गया।`,
};

export function databaseCreatedMessage(name: string, latestUserMessage: string | undefined, fallbackLanguage?: string): string {
  const language = latestUserMessage?.trim() ? detectCompanyChatLanguage(latestUserMessage)
    : (fallbackLanguage && fallbackLanguage in CREATED ? fallbackLanguage as CompanyChatLanguage : "en");
  return CREATED[language](name);
}
