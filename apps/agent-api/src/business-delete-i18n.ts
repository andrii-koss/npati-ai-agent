import type { CompanyChatLanguage } from "./company-chat-i18n";

/** Server-side confirmation of a Business Profile deletion, as for a Company: the user must write the exact phrase. */
type BusinessDeleteCopy = { ask: string; confirm: string; done: string };

const copies: Record<CompanyChatLanguage, BusinessDeleteCopy> = {
  en: { ask: "Do you want to delete Business Profile **{name}** with its goals and Business Memory? This action cannot be undone. To confirm, write: **{confirm}**.", confirm: "Yes, delete business profile {name}", done: "Done. Business Profile **{name}** was deleted with its goals and Business Memory." },
  uk: { ask: "Ви хочете видалити бізнес-профіль **{name}** разом з його цілями та Business Memory? Цю дію неможливо скасувати. Для підтвердження напишіть: **{confirm}**.", confirm: "Так, видали бізнес-профіль {name}", done: "Готово. Бізнес-профіль **{name}** видалено разом з його цілями та Business Memory." },
  fr: { ask: "Voulez-vous supprimer le profil d’entreprise **{name}** avec ses objectifs et sa mémoire métier ? Cette action est irréversible. Pour confirmer, écrivez : **{confirm}**.", confirm: "Oui, supprime le profil d’entreprise {name}", done: "Terminé. Le profil d’entreprise **{name}** a été supprimé avec ses objectifs et sa mémoire métier." },
  de: { ask: "Möchten Sie das Unternehmensprofil **{name}** mit seinen Zielen und dem Geschäftsspeicher löschen? Diese Aktion kann nicht rückgängig gemacht werden. Schreiben Sie zur Bestätigung: **{confirm}**.", confirm: "Ja, lösche das Unternehmensprofil {name}", done: "Erledigt. Das Unternehmensprofil **{name}** wurde mit seinen Zielen und dem Geschäftsspeicher gelöscht." },
  es: { ask: "¿Quieres eliminar el perfil de negocio **{name}** con sus objetivos y su memoria? Esta acción no se puede deshacer. Para confirmar, escribe: **{confirm}**.", confirm: "Sí, elimina el perfil de negocio {name}", done: "Listo. Se eliminó el perfil de negocio **{name}** con sus objetivos y su memoria." },
  it: { ask: "Vuoi eliminare il profilo aziendale **{name}** con i suoi obiettivi e la memoria aziendale? Questa azione non può essere annullata. Per confermare, scrivi: **{confirm}**.", confirm: "Sì, elimina il profilo aziendale {name}", done: "Fatto. Il profilo aziendale **{name}** è stato eliminato con i suoi obiettivi e la memoria aziendale." },
  pl: { ask: "Czy chcesz usunąć profil biznesowy **{name}** wraz z jego celami i pamięcią biznesową? Tej operacji nie można cofnąć. Aby potwierdzić, napisz: **{confirm}**.", confirm: "Tak, usuń profil biznesowy {name}", done: "Gotowe. Profil biznesowy **{name}** został usunięty wraz z celami i pamięcią biznesową." },
  pt: { ask: "Deseja excluir o perfil de negócio **{name}** com seus objetivos e memória do negócio? Esta ação não pode ser desfeita. Para confirmar, escreva: **{confirm}**.", confirm: "Sim, exclua o perfil de negócio {name}", done: "Pronto. O perfil de negócio **{name}** foi excluído com seus objetivos e memória do negócio." },
  nl: { ask: "Wil je het bedrijfsprofiel **{name}** met zijn doelen en bedrijfsgeheugen verwijderen? Deze actie kan niet ongedaan worden gemaakt. Schrijf ter bevestiging: **{confirm}**.", confirm: "Ja, verwijder bedrijfsprofiel {name}", done: "Klaar. Bedrijfsprofiel **{name}** is verwijderd met zijn doelen en bedrijfsgeheugen." },
  tr: { ask: "**{name}** iş profilini hedefleri ve iş hafızasıyla birlikte silmek istiyor musunuz? Bu işlem geri alınamaz. Onaylamak için şunu yazın: **{confirm}**.", confirm: "Evet, {name} iş profilini sil", done: "Tamam. **{name}** iş profili hedefleri ve iş hafızasıyla birlikte silindi." },
  ru: { ask: "Вы хотите удалить бизнес-профиль **{name}** вместе с его целями и Business Memory? Это действие нельзя отменить. Для подтверждения напишите: **{confirm}**.", confirm: "Да, удали бизнес-профиль {name}", done: "Готово. Бизнес-профиль **{name}** удалён вместе с его целями и Business Memory." },
  zh: { ask: "您要删除商业档案 **{name}** 及其目标和商业记忆吗？此操作无法撤销。请写下以下内容进行确认：**{confirm}**。", confirm: "是的，删除商业档案 {name}", done: "完成。商业档案 **{name}** 及其目标和商业记忆已删除。" },
  ja: { ask: "ビジネスプロフィール **{name}** を目標とビジネスメモリーと一緒に削除しますか？この操作は元に戻せません。確認するには、**{confirm}** と入力してください。", confirm: "はい、ビジネスプロフィール {name} を削除", done: "完了しました。ビジネスプロフィール **{name}** を目標とビジネスメモリーと一緒に削除しました。" },
  ko: { ask: "비즈니스 프로필 **{name}**을(를) 목표 및 비즈니스 메모리와 함께 삭제하시겠습니까? 이 작업은 취소할 수 없습니다. 확인하려면 **{confirm}**라고 입력하세요.", confirm: "예, 비즈니스 프로필 {name} 삭제", done: "완료되었습니다. 비즈니스 프로필 **{name}**을(를) 목표 및 비즈니스 메모리와 함께 삭제했습니다." },
  ar: { ask: "هل تريد حذف ملف العمل **{name}** مع أهدافه وذاكرة العمل؟ لا يمكن التراجع عن هذا الإجراء. للتأكيد، اكتب: **{confirm}**.", confirm: "نعم، احذف ملف العمل {name}", done: "تم. حُذف ملف العمل **{name}** مع أهدافه وذاكرة العمل." },
  hi: { ask: "क्या आप व्यवसाय प्रोफ़ाइल **{name}** को उसके लक्ष्यों और बिज़नेस मेमोरी के साथ हटाना चाहते हैं? यह कार्रवाई वापस नहीं की जा सकती। पुष्टि करने के लिए लिखें: **{confirm}**।", confirm: "हाँ, व्यवसाय प्रोफ़ाइल {name} हटाओ", done: "हो गया। व्यवसाय प्रोफ़ाइल **{name}** को उसके लक्ष्यों और बिज़नेस मेमोरी के साथ हटा दिया गया।" },
};

const fill = (text: string, name: string) => text.replaceAll("{name}", name);
const normalized = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[*«»"“”„'’`.!?。！？]/gu, "").replace(/\s+/gu, " ").trim();

export function businessDeleteQuestion(language: CompanyChatLanguage, name: string): string {
  return copies[language].ask.replaceAll("{confirm}", fill(copies[language].confirm, name)).replaceAll("{name}", name);
}

export function businessDeleteDone(language: CompanyChatLanguage, name: string): string {
  return fill(copies[language].done, name);
}

/** True only when the message contains the exact confirmation phrase for this Business Profile, in any language. */
export function confirmsBusinessDeletion(message: string, name: string): boolean {
  const text = normalized(message);
  return Object.values(copies).some((copy) => text.includes(normalized(fill(copy.confirm, name))));
}
