/* Spreadsheet and column directives applied to chat answers.
 * Extracted verbatim from app.ts (step 2a of docs/refactoring/PLAN.md).
 */
import { detectCompanyChatLanguage } from "./company-chat-i18n";
import { extractTargetUrlOrDomain } from "@npati/web-research";

export function isSpreadsheetEditRequest(message: string): boolean {
  const edit = /(?:дод|заповн|змін|онов|редаг|встав|видал|приб|добав|заполн|измен|обнов|редакт|встав|удал|add|fill|edit|update|change|insert|append|remove|delete|modify|ajout|rempl|modif|supprim|hinzuf|bearbeit|änder|lösch|agreg|rellen|edit|elimin|aggiung|modific|rimuov|dodaj|wypeł|edyt|zmień|usuń|adicion|preench|editar|alter|exclu|voeg|bewerk|wijzig|verwijder|ekle|doldur|düzenle|değiştir|sil|添加|填写|编辑|更新|删除|追加|入力|編集|変更|削除|추가|입력|편집|수정|삭제|أضف|املأ|عدّل|حدّث|احذف|जोड़|भर|संपादित|बदल|हटा)/iu.test(message);
  const spreadsheet = /(?:xlsx|xls|csv|excel|spreadsheet|workbook|worksheet|table|column|row|cell|sheet|стовп|колон|ряд|клітин|аркуш|таблиц|файл|feuille|tableau|colonne|ligne|zelle|spalte|tabelle|hoja|tabla|columna|fila|foglio|tabella|colonna|riga|arkusz|tabela|kolumn|wiersz|planilha|coluna|linha|werkblad|tabel|kolom|rij|sayfa|tablo|sütun|satır|电子表格|表格|列|行|单元格|スプレッドシート|表|列|行|セル|스프레드시트|표|열|행|셀|جدول|عمود|صف|خلية|स्प्रेडशीट|तालिका|कॉलम|पंक्ति|सेल)/iu.test(message);
  return edit && spreadsheet;
}

/** Explicit per-turn network restriction, separate from semantic intent classification. */
export function forbidsNewWebResearch(message: string): boolean {
  return /(?:\b(?:do not|don't|without|never)\s+(?:(?:repeat|new|another|any|web|online|internet)\s+)*(?:search\w*|research\w*|brows\w*|crawl\w*|fetch\w*)|\bno\s+(?:(?:new|more|further|additional|repeated)\s+)*(?:(?:web|online|internet)\s+)?(?:search\w*|research\w*)|\bkein\w*\s+(?:(?:neue|erneute|weitere)\w*\s+)?(?:web|internet|online)?-?(?:suche|recherche)|\b(?:ninguna|sin)\s+(?:nueva\s+)?b[uú]squeda|\bnenhuma\s+(?:nova\s+)?(?:pesquisa|busca)|\bsin\s+(?:volver\s+a\s+)?(?:buscar|investigar|navegar)|\bno\s+(?:busques|investigues)|\bsem\s+(?:(?:nova|novamente)\s+)?(?:pesquis\w*|busc\w*)|\bohne\s+(?:erneut\w*\s+|neu\w*\s+)?(?:suche|recherche)|\bnicht\s+(?:erneut\s+)?(?:suchen|recherchieren)|\u0431\u0435\u0437\s+(?:\u043d\u043e\u0432\p{L}*\s+|\u043f\u043e\u0432\u0442\u043e\u0440\p{L}*\s+)?(?:\u043f\u043e\u0448\u0443\u043a\p{L}*|\u0434\u043e\u0441\u043b\u0456\u0434\p{L}*)|\u043d\u0435\s+(?:\u0448\u0443\u043a\p{L}*|\u043f\u043e\u0432\u0442\u043e\u0440\p{L}*\s+(?:\u043f\u043e\u0448\u0443\u043a\p{L}*|\u0432\u0435\u0431\p{L}*\s*\u0434\u043e\u0441\u043b\u0456\u0434\p{L}*)))/iu.test(message);
}

export function explicitlyRequestsWebResearch(message: string, options: { requireOperation?: boolean } = {}): boolean {
  if (forbidsNewWebResearch(message)) return false;
  if (options.requireOperation && !extractTargetUrlOrDomain(message)) {
    return message.split(/[.!?;\n]/u).some(clause =>
      !/^\s*(?:do not|don't|never|no |ne |nicht )/iu.test(clause)
      && /(?:\b(?:research|search|browse|crawl|fetch|competitors?|sources)\b|pesquis|recherch|busca|investig|fuentes|fontes|quellen|\u0434\u043e\u0441\u043b\u0456\u0434|\u043f\u043e\u0448\u0443\u043a|\u043f\u043e\u0440\u0456\u0432\u043d|\u0434\u0436\u0435\u0440\u0435\u043b)/iu.test(clause)
      && explicitlyRequestsWebResearch(clause));
  }
  return Boolean(extractTargetUrlOrDomain(message))
    || /(?:https?:\/\/|\bweb\b|\binternet\b|\bwebsite\b|\bonline\b|\bsearch\b|\bbrowse\b|\bcrawl\b|\bcompetitors?\b|\bcompetition\b|інтернет|веб|сайт|пошук|пошукай|конкурент|конкурентів|проскануй|интернет|сайт|поиск|найди\s+в\s+интернете|concurrents?|mitbewerber|wettbewerb|competidores?|concorrenti?|głównych\s+konkurentów|rakipler?|竞争对手|競合|경쟁사|المنافسين|प्रतिस्पर्धियों|pesquis\p{L}*|recherch\p{L}*|investig\p{L}*\s+(?:na|en|in|im)\s+(?:web|internet)|busca\p{L}*\s+(?:en|na)\s+(?:la\s+)?(?:web|internet)|(?:with|com|con|mit|avec|з|с)\s+(?:sources|fontes|fuentes|quellen|джерелами|источниками))/iu.test(message);
}

export const spreadsheetEditedCopies: Record<ReturnType<typeof detectCompanyChatLanguage>, string> = {
  en: "Done. I updated the uploaded spreadsheet and attached the edited file.",
  uk: "Готово. Я оновив завантажену таблицю та прикріпив відредагований файл.",
  fr: "Terminé. J’ai mis à jour la feuille de calcul importée et joint le fichier modifié.",
  de: "Erledigt. Ich habe die hochgeladene Tabelle aktualisiert und die bearbeitete Datei angehängt.",
  es: "Listo. Actualicé la hoja de cálculo cargada y adjunté el archivo editado.",
  it: "Fatto. Ho aggiornato il foglio di calcolo caricato e allegato il file modificato.",
  pl: "Gotowe. Zaktualizowałem przesłany arkusz i załączyłem edytowany plik.",
  pt: "Pronto. Atualizei a planilha enviada e anexei o arquivo editado.",
  nl: "Klaar. Ik heb het geüploade werkblad bijgewerkt en het bewerkte bestand bijgevoegd.",
  tr: "Tamamlandı. Yüklenen tabloyu güncelledim ve düzenlenmiş dosyayı ekledim.",
  ru: "Готово. Я обновил загруженную таблицу и прикрепил отредактированный файл.",
  zh: "完成。我已更新上传的电子表格并附上编辑后的文件。",
  ja: "完了しました。アップロードされたスプレッドシートを更新し、編集済みファイルを添付しました。",
  ko: "완료했습니다. 업로드한 스프레드시트를 수정하고 편집된 파일을 첨부했습니다.",
  ar: "تم. حدّثت جدول البيانات المرفوع وأرفقت الملف المعدّل.",
  hi: "पूरा हुआ। मैंने अपलोड की गई स्प्रेडशीट अपडेट करके संपादित फ़ाइल संलग्न कर दी है।",
};

export function spreadsheetEditedMessage(message: string): string {
  return spreadsheetEditedCopies[detectCompanyChatLanguage(message)];
}

export function addColumnDirectiveFromMarkdown(content: string, request: string) {
  const quotedHeader = /[«“"']([^»”"']{1,80})[»”"']/u.exec(request)?.[1]?.trim();
  const namedHeader = /(?:column|стовп(?:ець|ця)|колонк[ауи]|colonne|spalte|columna|colonna|kolumn[ęa]|coluna|kolom|sütun|列|열|عمود|कॉलम)\s+([\p{L}\p{N}_ -]{1,40})/iu.exec(request)?.[1]?.trim();
  const header = quotedHeader || namedHeader;
  if (!header) return undefined;
  const rows = content.split(/\r?\n/).filter((line) => /^\s*\|.*\|\s*$/.test(line));
  if (rows.length < 3) return undefined;
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const headers = cells(rows[0]!);
  const column = headers.findIndex((value) => value.toLocaleLowerCase() === header.toLocaleLowerCase());
  if (column < 0 || !/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(rows[1]!)) return undefined;
  const values = rows.slice(2).map((row) => cells(row)[column] ?? "");
  return { action: "add_column" as const, newColumn: { header, values } };
}

export function mapColumnDirectiveFromProposal(content: string, request: string) {
  const header = /[«“"']([^»”"']{1,80})[»”"']/u.exec(request)?.[1]?.trim();
  if (!header) return undefined;
  const sourceColumn = /(?:based\s+on|from|на\s+основі|из\s+поля|à\s+partir|basierend|basado|in\s+base|na\s+podstawie|com\s+base|op\s+basis|temel|基于|基づ|기반|استناد|के\s+आधार)[^\n]{0,120}[«“"`]([^»”"`\n]{1,80})[»”"`]/iu.exec(content)?.[1]?.trim();
  if (!sourceColumn) return undefined;
  const valueMap: Array<{ match: string; value: string; mode: "contains" }> = [];
  for (const line of content.split(/\r?\n/)) {
    const labelled = /^\s*[-*]\s*([^:\n]{1,80}):\s*(.+)$/u.exec(line);
    if (!labelled) continue;
    const target = labelled[1]!.replace(/[*_]/g, "").trim();
    for (const match of [...labelled[2]!.matchAll(/`([^`]{1,120})`/gu)]) {
      valueMap.push({ match: match[1]!.trim(), value: target, mode: "contains" });
    }
  }
  if (valueMap.length < 2) return undefined;
  valueMap.sort((left, right) => right.match.length - left.match.length);
  return { action: "map_column" as const, sourceColumn, newColumn: { header }, valueMap };
}

