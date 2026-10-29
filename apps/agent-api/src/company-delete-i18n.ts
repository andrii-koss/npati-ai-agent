import type { CompanyChatLanguage } from "./company-chat-i18n";

type CompanyDeleteCopy = {
  selected: string;
  none: string;
  choose: string;
  command: string;
  completedAll?: string;
};

const copies: Record<CompanyChatLanguage, CompanyDeleteCopy> = {
  en: { selected: "Do you want to delete the selected company **{name}**? This action cannot be undone. To confirm, write: **Yes, delete company {name}**.", none: "You do not have any companies to delete.", choose: "Which company do you want to delete?", command: "Write: **Delete company <name>**. I will then ask for confirmation.", completedAll: "Done. I deleted company **{company}**, business idea **{business}**, its goals ({goals}), and Business Memory ({memories})." },
  uk: { selected: "Ви хочете видалити вибрану компанію **{name}**? Цю дію неможливо скасувати. Для підтвердження напишіть: **Так, видали компанію {name}**.", none: "У вас немає компаній для видалення.", choose: "Яку компанію ви хочете видалити?", command: "Напишіть: **Видали компанію <назва>**. Після цього я попрошу підтвердження.", completedAll: "Готово. Я видалив компанію **{company}**, бізнес-ідею **{business}**, її цілі ({goals}) та Business Memory ({memories})." },
  fr: { selected: "Voulez-vous supprimer l’entreprise sélectionnée **{name}** ? Cette action est irréversible. Pour confirmer, écrivez : **Oui, supprime l’entreprise {name}**.", none: "Vous n’avez aucune entreprise à supprimer.", choose: "Quelle entreprise souhaitez-vous supprimer ?", command: "Écrivez : **Supprime l’entreprise <nom>**. Je demanderai ensuite une confirmation." },
  de: { selected: "Möchten Sie das ausgewählte Unternehmen **{name}** löschen? Diese Aktion kann nicht rückgängig gemacht werden. Schreiben Sie zur Bestätigung: **Ja, lösche das Unternehmen {name}**.", none: "Sie haben keine Unternehmen zum Löschen.", choose: "Welches Unternehmen möchten Sie löschen?", command: "Schreiben Sie: **Lösche das Unternehmen <Name>**. Danach bitte ich um eine Bestätigung." },
  es: { selected: "¿Quieres eliminar la empresa seleccionada **{name}**? Esta acción no se puede deshacer. Para confirmar, escribe: **Sí, elimina la empresa {name}**.", none: "No tienes empresas para eliminar.", choose: "¿Qué empresa quieres eliminar?", command: "Escribe: **Elimina la empresa <nombre>**. Después pediré confirmación." },
  it: { selected: "Vuoi eliminare l’azienda selezionata **{name}**? Questa azione non può essere annullata. Per confermare, scrivi: **Sì, elimina l’azienda {name}**.", none: "Non hai aziende da eliminare.", choose: "Quale azienda vuoi eliminare?", command: "Scrivi: **Elimina l’azienda <nome>**. Poi chiederò conferma." },
  pl: { selected: "Czy chcesz usunąć wybraną firmę **{name}**? Tej operacji nie można cofnąć. Aby potwierdzić, napisz: **Tak, usuń firmę {name}**.", none: "Nie masz firm do usunięcia.", choose: "Którą firmę chcesz usunąć?", command: "Napisz: **Usuń firmę <nazwa>**. Następnie poproszę o potwierdzenie." },
  pt: { selected: "Deseja excluir a empresa selecionada **{name}**? Esta ação não pode ser desfeita. Para confirmar, escreva: **Sim, exclua a empresa {name}**.", none: "Você não tem empresas para excluir.", choose: "Qual empresa deseja excluir?", command: "Escreva: **Exclua a empresa <nome>**. Depois pedirei confirmação." },
  nl: { selected: "Wil je het geselecteerde bedrijf **{name}** verwijderen? Deze actie kan niet ongedaan worden gemaakt. Schrijf ter bevestiging: **Ja, verwijder bedrijf {name}**.", none: "Je hebt geen bedrijven om te verwijderen.", choose: "Welk bedrijf wil je verwijderen?", command: "Schrijf: **Verwijder bedrijf <naam>**. Daarna vraag ik om bevestiging." },
  tr: { selected: "Seçili **{name}** şirketini silmek istiyor musunuz? Bu işlem geri alınamaz. Onaylamak için şunu yazın: **Evet, {name} şirketini sil**.", none: "Silinecek bir şirketiniz yok.", choose: "Hangi şirketi silmek istiyorsunuz?", command: "Şunu yazın: **<ad> şirketini sil**. Ardından onay isteyeceğim." },
  ru: { selected: "Вы хотите удалить выбранную компанию **{name}**? Это действие нельзя отменить. Для подтверждения напишите: **Да, удали компанию {name}**.", none: "У вас нет компаний для удаления.", choose: "Какую компанию вы хотите удалить?", command: "Напишите: **Удали компанию <название>**. После этого я попрошу подтверждение." },
  zh: { selected: "您要删除所选公司 **{name}** 吗？此操作无法撤销。请写下以下内容进行确认：**是的，删除公司 {name}**。", none: "您没有可删除的公司。", choose: "您要删除哪家公司？", command: "请写：**删除公司 <名称>**。随后我会要求确认。" },
  ja: { selected: "選択した会社 **{name}** を削除しますか？この操作は元に戻せません。確認するには、**はい、会社 {name} を削除** と入力してください。", none: "削除できる会社はありません。", choose: "どの会社を削除しますか？", command: "**会社 <名前> を削除** と入力してください。その後、確認を求めます。" },
  ko: { selected: "선택한 회사 **{name}**을(를) 삭제하시겠습니까? 이 작업은 취소할 수 없습니다. 확인하려면 **예, 회사 {name} 삭제**라고 입력하세요.", none: "삭제할 회사가 없습니다.", choose: "어느 회사를 삭제하시겠습니까?", command: "**회사 <이름> 삭제**라고 입력하세요. 그런 다음 확인을 요청합니다." },
  ar: { selected: "هل تريد حذف الشركة المحددة **{name}**؟ لا يمكن التراجع عن هذا الإجراء. للتأكيد، اكتب: **نعم، احذف الشركة {name}**.", none: "ليس لديك شركات لحذفها.", choose: "ما الشركة التي تريد حذفها؟", command: "اكتب: **احذف الشركة <الاسم>**. ثم سأطلب التأكيد." },
  hi: { selected: "क्या आप चुनी गई कंपनी **{name}** को हटाना चाहते हैं? यह कार्रवाई वापस नहीं की जा सकती। पुष्टि के लिए लिखें: **हाँ, कंपनी {name} हटाएँ**।", none: "हटाने के लिए आपकी कोई कंपनी नहीं है।", choose: "आप कौन-सी कंपनी हटाना चाहते हैं?", command: "लिखें: **कंपनी <नाम> हटाएँ**। इसके बाद मैं पुष्टि माँगूँगा।" },
};

export function companyDeleteCopy(language: CompanyChatLanguage, companyName?: string): CompanyDeleteCopy {
  const selected = companyName ? copies[language].selected.replaceAll("{name}", companyName) : copies[language].selected;
  return { ...copies[language], selected };
}

const completedAllCopies: Record<CompanyChatLanguage, string> = {
  en: "Done. I deleted company **{company}**, business idea **{business}**, its goals ({goals}), and Business Memory ({memories}).",
  uk: "Готово. Я видалив компанію **{company}**, бізнес-ідею **{business}**, її цілі ({goals}) та Business Memory ({memories}).",
  fr: "Terminé. J’ai supprimé l’entreprise **{company}**, l’idée d’entreprise **{business}**, ses objectifs ({goals}) et sa mémoire métier ({memories}).",
  de: "Erledigt. Ich habe das Unternehmen **{company}**, die Geschäftsidee **{business}**, ihre Ziele ({goals}) und den Geschäftsspeicher ({memories}) gelöscht.",
  es: "Listo. Eliminé la empresa **{company}**, la idea de negocio **{business}**, sus objetivos ({goals}) y la memoria del negocio ({memories}).",
  it: "Fatto. Ho eliminato l’azienda **{company}**, l’idea imprenditoriale **{business}**, i suoi obiettivi ({goals}) e la memoria aziendale ({memories}).",
  pl: "Gotowe. Usunąłem firmę **{company}**, pomysł na biznes **{business}**, jego cele ({goals}) i pamięć biznesową ({memories}).",
  pt: "Concluído. Excluí a empresa **{company}**, a ideia de negócio **{business}**, suas metas ({goals}) e a memória do negócio ({memories}).",
  nl: "Klaar. Ik heb bedrijf **{company}**, businessidee **{business}**, de doelen ({goals}) en het bedrijfsgeheugen ({memories}) verwijderd.",
  tr: "Tamamlandı. **{company}** şirketini, **{business}** iş fikrini, hedeflerini ({goals}) ve işletme hafızasını ({memories}) sildim.",
  ru: "Готово. Я удалил компанию **{company}**, бизнес-идею **{business}**, её цели ({goals}) и память бизнеса ({memories}).",
  zh: "已完成。我删除了公司 **{company}**、业务构想 **{business}**、相关目标（{goals}）和业务记忆（{memories}）。",
  ja: "完了しました。会社 **{company}**、ビジネスアイデア **{business}**、その目標（{goals}件）、ビジネスメモリ（{memories}件）を削除しました。",
  ko: "완료했습니다. 회사 **{company}**, 비즈니스 아이디어 **{business}**, 관련 목표({goals}개), 비즈니스 메모리({memories}개)를 삭제했습니다.",
  ar: "تم. حذفت الشركة **{company}** وفكرة العمل **{business}** وأهدافها ({goals}) وذاكرة النشاط التجاري ({memories}).",
  hi: "पूरा हुआ। मैंने कंपनी **{company}**, व्यवसाय विचार **{business}**, उसके लक्ष्य ({goals}) और बिज़नेस मेमोरी ({memories}) हटा दिए।",
};

const confirmAllCopies: Record<CompanyChatLanguage, string> = {
  en: "Do you want to delete company **{company}**, business idea **{business}**, all its goals, and Business Memory? This action cannot be undone. To confirm, write: **Yes, delete company {company}, business idea {business}, its goals and memory**.",
  uk: "Ви хочете видалити компанію **{company}**, бізнес-ідею **{business}**, усі її цілі та Business Memory? Цю дію неможливо скасувати. Для підтвердження напишіть: **Так, видали компанію {company}, бізнес-ідею {business}, її цілі та меморі**.",
  fr: "Voulez-vous supprimer l’entreprise **{company}**, l’idée d’entreprise **{business}**, tous ses objectifs et sa mémoire métier ? Cette action est irréversible. Pour confirmer, écrivez : **Oui, supprime l’entreprise {company}, l’idée d’entreprise {business}, ses objectifs et sa mémoire**.",
  de: "Möchten Sie das Unternehmen **{company}**, die Geschäftsidee **{business}**, alle Ziele und den Geschäftsspeicher löschen? Diese Aktion kann nicht rückgängig gemacht werden. Schreiben Sie zur Bestätigung: **Ja, lösche das Unternehmen {company}, die Geschäftsidee {business}, ihre Ziele und das Gedächtnis**.",
  es: "¿Quieres eliminar la empresa **{company}**, la idea de negocio **{business}**, todos sus objetivos y la memoria del negocio? Esta acción no se puede deshacer. Para confirmar, escribe: **Sí, elimina la empresa {company}, la idea de negocio {business}, sus objetivos y la memoria**.",
  it: "Vuoi eliminare l’azienda **{company}**, l’idea imprenditoriale **{business}**, tutti i suoi obiettivi e la memoria aziendale? Questa azione non può essere annullata. Per confermare, scrivi: **Sì, elimina l’azienda {company}, l’idea imprenditoriale {business}, i suoi obiettivi e la memoria**.",
  pl: "Czy chcesz usunąć firmę **{company}**, pomysł na biznes **{business}**, wszystkie cele i pamięć biznesową? Tej operacji nie można cofnąć. Aby potwierdzić, napisz: **Tak, usuń firmę {company}, pomysł na biznes {business}, cele i pamięć**.",
  pt: "Deseja excluir a empresa **{company}**, a ideia de negócio **{business}**, todas as metas e a memória do negócio? Esta ação não pode ser desfeita. Para confirmar, escreva: **Sim, exclua a empresa {company}, a ideia de negócio {business}, as metas e a memória**.",
  nl: "Wil je bedrijf **{company}**, businessidee **{business}**, alle doelen en het bedrijfsgeheugen verwijderen? Deze actie kan niet ongedaan worden gemaakt. Schrijf ter bevestiging: **Ja, verwijder bedrijf {company}, businessidee {business}, de doelen en het geheugen**.",
  tr: "**{company}** şirketini, **{business}** iş fikrini, tüm hedeflerini ve işletme hafızasını silmek istiyor musunuz? Bu işlem geri alınamaz. Onaylamak için şunu yazın: **Evet, {company} şirketini, {business} iş fikrini, hedeflerini ve hafızayı sil**.",
  ru: "Вы хотите удалить компанию **{company}**, бизнес-идею **{business}**, все её цели и память бизнеса? Это действие нельзя отменить. Для подтверждения напишите: **Да, удали компанию {company}, бизнес-идею {business}, её цели и память**.",
  zh: "您要删除公司 **{company}**、业务构想 **{business}**、全部目标和业务记忆吗？此操作无法撤销。请写：**是的，删除公司 {company}、业务构想 {business}、目标和记忆**。",
  ja: "会社 **{company}**、ビジネスアイデア **{business}**、すべての目標とビジネスメモリを削除しますか？この操作は元に戻せません。確認するには、**はい、会社 {company}、ビジネスアイデア {business}、目標、メモリを削除** と入力してください。",
  ko: "회사 **{company}**, 비즈니스 아이디어 **{business}**, 모든 목표와 비즈니스 메모리를 삭제하시겠습니까? 이 작업은 취소할 수 없습니다. 확인하려면 **예, 회사 {company}, 비즈니스 아이디어 {business}, 목표와 메모리 삭제**라고 입력하세요.",
  ar: "هل تريد حذف الشركة **{company}** وفكرة العمل **{business}** وجميع أهدافها وذاكرة النشاط التجاري؟ لا يمكن التراجع عن هذا الإجراء. للتأكيد، اكتب: **نعم، احذف الشركة {company} وفكرة العمل {business} والأهداف والذاكرة**.",
  hi: "क्या आप कंपनी **{company}**, व्यवसाय विचार **{business}**, उसके सभी लक्ष्य और बिज़नेस मेमोरी हटाना चाहते हैं? यह कार्रवाई वापस नहीं की जा सकती। पुष्टि के लिए लिखें: **हाँ, कंपनी {company}, व्यवसाय विचार {business}, लक्ष्य और मेमोरी हटा दें**।",
};

export function companyDeleteConfirmAll(language: CompanyChatLanguage, company: string, business: string): string {
  return confirmAllCopies[language].replaceAll("{company}", company).replaceAll("{business}", business);
}

export function companyDeleteCompletedAll(language: CompanyChatLanguage, values: { company: string; business: string; goals: number; memories: number }): string {
  return completedAllCopies[language]
    .replaceAll("{company}", values.company)
    .replaceAll("{business}", values.business)
    .replaceAll("{goals}", String(values.goals))
    .replaceAll("{memories}", String(values.memories));
}

/** A quoted name is data, not an instruction: «Temp Delete Co» must not read as a deletion request. */
/**
 * The company itself is the deleted object ("Delete only test company X", "видали компанію X"), not merely the place of
 * the deletion ("У компанії X видали агента Y"): the company noun follows the verb within three words, none of which
 * names another object.
 */
export function deletesCompanyItself(message: string): boolean {
  const match = /(?:видали|видалити|видаліть|удали|удалить|delete|remove|exclua|excluir|elimina|eliminar|lösche|löschen|supprime|supprimer)((?:\s+[\p{L}'’-]+){0,3}?)\s+(?:компані\p{L}*|компани\p{L}*|compan\p{L}*|empresa|unternehmen|firma|entreprise|azienda)/iu.exec(withoutQuotedNames(message));
  return Boolean(match && !otherDeleteTarget.test(match[1] ?? ""));
}

const otherDeleteTarget = /(?:агент|agent|webhook|вебхук|automat|автомат|project|проєкт|проект|projeto|proyecto|template|шаблон|memor|пам|goal|ціл|цел|row|рядок|строк|table|таблиц|field|поле|contact|контакт|site|сайт)/iu;
/** A delete request that names an object other than a company ("delete row X …, prove it is empty"). */
export function namesOtherDeleteTarget(message: string): boolean {
  return otherDeleteTarget.test(withoutQuotedNames(message));
}

export function withoutQuotedNames(message: string): string {
  return message.replace(/«[^»\n]{1,120}»|“[^”\n]{1,120}”|„[^“”\n]{1,120}[“”]|"[^"\n]{1,120}"/gu, "«…»");
}

const deleteWord = /(?:видал|удал|\bdelete\b|\bremove\b|supprim|lösch|elimin|borr|usuń|exclu|apagar|verwijder|\bsil\b|kaldır)/iu;
const otherActionWord = /(?:дод\p{L}*|створ\p{L}*|онов\p{L}*|змін\p{L}*|переймен\p{L}*|\badd\b|\bcreate\b|\bupdate\b|\brename\b|\bcri[ea]\p{L}*|añad\p{L}*|füge|erstell\p{L}*|ajout\p{L}*)/iu;

/** "Add an agent to Temp Delete Co": another action verb before the delete word makes the name, not the verb, matter. */
export function deleteIsTheAction(message: string): boolean {
  const remove = deleteWord.exec(message);
  // Scripts without a listed delete word (zh, ja, ko, ar, hi) keep the caller's own delete signal.
  if (!remove) return true;
  const other = otherActionWord.exec(message);
  return !other || remove.index < other.index;
}

/**
 * While the user asks to delete a company itself ("видали компанію X", "delete the company X"), only that deletion may
 * run in the request: a model whose delete was refused must not work around it by removing agents or editing fields.
 * Deleting an agent of a company ("видали агента Марко з компанії") is not a company deletion.
 */
export function onlyRequestedCompanyDeletion(message: string, action: unknown): boolean {
  const deletesCompany = /(?:видали|видалити|видаліть|удали|delete|remove|exclua|elimina|lösche|supprime)\s+(?:(?:the|my|this|that|цю|нашу|мою|ту)\s+)?(?:компані\p{L}*|компани\p{L}*|compan\p{L}*|empresa|unternehmen|entreprise|azienda)/iu.test(withoutQuotedNames(message));
  return !deletesCompany || action === "delete";
}

export function isCompanyDeleteIntent(message: string): boolean {
  message = withoutQuotedNames(message);
  if (!deleteIsTheAction(message)) return false;
  return /(?:видал|приб|удал|убер|\bdelete\b|\bremove\b|supprim|effac|lösch|entfern|elimin|borr|usuń|skasuj|exclu|apagar|verwijder|\bsil\b|kaldır|删除|削除|삭제|احذف|إزالة|हटा)/iu.test(message);
}

export function isCompanyDeleteConfirmed(message: string): boolean {
  return /(?:так[\s\S]{0,50}видал|підтвердж\p{L}*[\s\S]{0,50}видал|да[\s\S]{0,50}удал|подтвержд\p{L}*[\s\S]{0,50}удал|\byes\b[\s\S]{0,50}(?:delete|remove)|\bconfirm\p{L}*[\s\S]{0,50}(?:delete|remove)|oui[\s\S]{0,50}supprim|ja[\s\S]{0,50}(?:lösch|entfern|verwijder)|s[ií][\s\S]{0,50}(?:elimin|borr)|s[ìi][\s\S]{0,50}(?:elimin|rimuov)|tak[\s\S]{0,50}(?:usuń|skasuj)|sim[\s\S]{0,50}(?:exclu|remov|apag)|evet[\s\S]{0,50}(?:sil|kaldır)|(?:是的|确认)[\s\S]{0,30}删除|(?:はい[\s\S]{0,30}削除|削除[\s\S]{0,30}確認)|(?:예[\s\S]{0,30}삭제|확인[\s\S]{0,30}삭제)|نعم[\s\S]{0,50}(?:احذف|إزالة)|हाँ[\s\S]{0,50}हटा)/iu.test(message);
}

/** "Company «X» was not found … Nothing was changed." for every Chat language (V5-D74; was 6 of 16). */
export const namedCompanyNotFoundCopy: Record<CompanyChatLanguage, string> = {
  en: "Company «{name}» was not found among your companies (it may have been deleted). Nothing was changed.",
  uk: "Компанію «{name}» не знайдено серед ваших компаній (можливо, її видалено). Нічого не змінено.",
  fr: "L’entreprise «{name}» est introuvable parmi vos entreprises (elle a peut-être été supprimée). Rien n’a été modifié.",
  de: "Das Unternehmen «{name}» wurde nicht gefunden (vielleicht gelöscht). Nichts wurde geändert.",
  es: "No se encontró la empresa «{name}» (quizá se eliminó). No se cambió nada.",
  it: "L’azienda «{name}» non è stata trovata tra le tue aziende (forse è stata eliminata). Non è stato modificato nulla.",
  pl: "Nie znaleziono firmy «{name}» wśród Twoich firm (mogła zostać usunięta). Niczego nie zmieniono.",
  pt: "A empresa «{name}» não foi encontrada (talvez tenha sido excluída). Nada foi alterado.",
  nl: "Het bedrijf «{name}» is niet gevonden bij je bedrijven (misschien is het verwijderd). Er is niets gewijzigd.",
  tr: "«{name}» şirketi şirketleriniz arasında bulunamadı (silinmiş olabilir). Hiçbir şey değiştirilmedi.",
  ru: "Компания «{name}» не найдена среди ваших компаний (возможно, она удалена). Ничего не изменено.",
  zh: "在您的公司中未找到「{name}」（可能已被删除）。未做任何更改。",
  ja: "会社「{name}」はあなたの会社の中に見つかりませんでした（削除された可能性があります）。何も変更していません。",
  ko: "회사 「{name}」을(를) 찾을 수 없습니다(삭제되었을 수 있습니다). 아무것도 변경하지 않았습니다.",
  ar: "لم يتم العثور على الشركة «{name}» ضمن شركاتك (ربما حُذفت). لم يتم تغيير أي شيء.",
  hi: "आपकी कंपनियों में «{name}» नाम की कंपनी नहीं मिली (शायद वह हटा दी गई है)। कुछ भी नहीं बदला गया।",
};

/** The first quoted name of a request, in any of the quote styles the Chat languages use. */
export function firstQuotedName(message: string): string | undefined {
  return /«([^»\n]{2,120})»|“([^”\n]{2,120})”|„([^“”\n]{2,120})[“”]|"([^"\n]{2,120})"|「([^」\n]{2,120})」/u.exec(message)?.slice(1).find(Boolean)?.trim();
}
