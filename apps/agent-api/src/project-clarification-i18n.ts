import type { ProjectIntent } from "@npati/shared";
import { detectCompanyChatLanguage, type CompanyChatLanguage } from "./company-chat-i18n";

/**
 * The "choose a project first" answers of project intents were fixed Ukrainian or English strings, so an English
 * "create a database in Data Studio …" got "Оберіть активний проєкт для додавання моделі даних." (V6 step 13). The
 * reply now follows the message language; a database request without a project also points to Data Studio, where a
 * standalone database is created.
 */
const SELECT_PROJECT: Record<CompanyChatLanguage, string> = {
  en: "Select an active project (or create one) first, then repeat the request.",
  uk: "Спершу оберіть активний проєкт (або створіть його), потім повторіть запит.",
  ru: "Сначала выберите активный проект (или создайте его), затем повторите запрос.",
  de: "Wähle zuerst ein aktives Projekt aus (oder erstelle eines) und wiederhole dann die Anfrage.",
  fr: "Sélectionnez d’abord un projet actif (ou créez-en un), puis répétez la demande.",
  es: "Primero selecciona un proyecto activo (o crea uno) y luego repite la solicitud.",
  it: "Seleziona prima un progetto attivo (o creane uno), poi ripeti la richiesta.",
  pl: "Najpierw wybierz aktywny projekt (lub utwórz go), a potem powtórz prośbę.",
  pt: "Primeiro seleciona um projeto ativo (ou cria um) e depois repete o pedido.",
  nl: "Kies eerst een actief project (of maak er een) en herhaal daarna het verzoek.",
  tr: "Önce etkin bir proje seç (veya oluştur), ardından isteği tekrarla.",
  zh: "请先选择一个活动项目（或创建一个），然后再重复请求。",
  ja: "まずアクティブなプロジェクトを選択（または作成）してから、もう一度依頼してください。",
  ko: "먼저 활성 프로젝트를 선택하거나 만든 다음 요청을 다시 보내 주세요.",
  ar: "اختر أولًا مشروعًا نشطًا (أو أنشئ واحدًا)، ثم أعد الطلب.",
  hi: "पहले एक सक्रिय प्रोजेक्ट चुनें (या बनाएँ), फिर अनुरोध दोहराएँ।",
};
const DATA_STUDIO: Record<CompanyChatLanguage, string> = {
  en: "A standalone database is created in [Data Studio](/settings/data-studio); a project's database is changed within that project.",
  uk: "Окрема база даних створюється в [Data Studio](/settings/data-studio); база проєкту змінюється в межах цього проєкту.",
  ru: "Отдельная база данных создаётся в [Data Studio](/settings/data-studio); база проекта меняется в рамках этого проекта.",
  de: "Eine eigenständige Datenbank wird im [Data Studio](/settings/data-studio) erstellt; die Datenbank eines Projekts wird in diesem Projekt geändert.",
  fr: "Une base de données autonome se crée dans [Data Studio](/settings/data-studio) ; celle d’un projet se modifie dans ce projet.",
  es: "Una base de datos independiente se crea en [Data Studio](/settings/data-studio); la de un proyecto se cambia dentro de ese proyecto.",
  it: "Un database autonomo si crea in [Data Studio](/settings/data-studio); quello di un progetto si modifica all’interno del progetto.",
  pl: "Samodzielną bazę danych tworzy się w [Data Studio](/settings/data-studio); bazę projektu zmienia się w tym projekcie.",
  pt: "Uma base de dados independente cria-se no [Data Studio](/settings/data-studio); a de um projeto altera-se nesse projeto.",
  nl: "Een losse database maak je in [Data Studio](/settings/data-studio); de database van een project wijzig je in dat project.",
  tr: "Bağımsız bir veritabanı [Data Studio](/settings/data-studio) içinde oluşturulur; bir projenin veritabanı o projede değiştirilir.",
  zh: "独立数据库在 [Data Studio](/settings/data-studio) 中创建；项目的数据库在该项目内修改。",
  ja: "単独のデータベースは [Data Studio](/settings/data-studio) で作成します。プロジェクトのデータベースはそのプロジェクト内で変更します。",
  ko: "독립 데이터베이스는 [Data Studio](/settings/data-studio)에서 만들고, 프로젝트의 데이터베이스는 해당 프로젝트 안에서 변경합니다.",
  ar: "تُنشأ قاعدة البيانات المستقلة في [Data Studio](/settings/data-studio)، وتُعدَّل قاعدة بيانات المشروع داخل ذلك المشروع.",
  hi: "अलग डेटाबेस [Data Studio](/settings/data-studio) में बनाया जाता है; प्रोजेक्ट का डेटाबेस उसी प्रोजेक्ट में बदला जाता है।",
};

export function localizedProjectClarification(intent: ProjectIntent, message: string, original?: string): string {
  const language = detectCompanyChatLanguage(message);
  const base = SELECT_PROJECT[language] ?? original ?? SELECT_PROJECT.en;
  return intent === "ADD_DATA_MODEL" || intent === "EDIT_DATA_MODEL" ? `${base} ${DATA_STUDIO[language]}` : base;
}
