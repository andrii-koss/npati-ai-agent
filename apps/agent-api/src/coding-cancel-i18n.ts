import type { CompanyChatLanguage } from "./company-chat-i18n";

const cancelledCopy: Record<CompanyChatLanguage, string> = {
  en: "The run was cancelled. Any running processes were stopped and the sandbox was released.",
  uk: "Запуск скасовано. Запущені процеси зупинено, пісочницю звільнено.",
  fr: "L’exécution a été annulée. Les processus en cours ont été arrêtés et l’environnement isolé a été libéré.",
  de: "Der Lauf wurde abgebrochen. Laufende Prozesse wurden gestoppt und die Sandbox wurde freigegeben.",
  es: "Se canceló la ejecución. Se detuvieron los procesos en curso y se liberó el entorno aislado.",
  it: "L’esecuzione è stata annullata. I processi in corso sono stati fermati e l’ambiente isolato è stato rilasciato.",
  pl: "Uruchomienie anulowano. Działające procesy zatrzymano, a środowisko izolowane zwolniono.",
  pt: "A execução foi cancelada. Os processos em curso foram interrompidos e o ambiente isolado foi libertado.",
  nl: "De uitvoering is geannuleerd. Actieve processen zijn gestopt en de sandbox is vrijgegeven.",
  tr: "Çalıştırma iptal edildi. Çalışan işlemler durduruldu ve yalıtılmış ortam serbest bırakıldı.",
  ru: "Запуск отменён. Работающие процессы остановлены, песочница освобождена.",
  zh: "运行已取消。正在运行的进程已停止，沙箱已释放。",
  ja: "実行をキャンセルしました。実行中のプロセスを停止し、サンドボックスを解放しました。",
  ko: "실행이 취소되었습니다. 실행 중인 프로세스를 중지하고 샌드박스를 해제했습니다.",
  ar: "أُلغي التشغيل. أُوقفت العمليات الجارية وحُررت البيئة المعزولة.",
  hi: "रन रद्द कर दिया गया। चल रही प्रक्रियाएँ रोक दी गईं और सैंडबॉक्स मुक्त कर दिया गया।",
};

export function codingCancellationMessage(language: CompanyChatLanguage = "en"): string {
  return cancelledCopy[language];
}

/** The run could not take in the person's new messages and stopped; nothing they sent is lost (V6 step 14). */
const inboxAdmissionCopy: Record<CompanyChatLanguage, string> = {
  en: "The run stopped: it could not take in your new messages. Nothing you sent was lost; repeat the request to continue.",
  uk: "Запуск зупинено: не вдалося прийняти ваші нові повідомлення. Нічого з надісланого не втрачено; повторіть запит, щоб продовжити.",
  fr: "L’exécution s’est arrêtée : elle n’a pas pu recevoir vos nouveaux messages. Rien de ce que vous avez envoyé n’est perdu ; renouvelez la demande pour continuer.",
  de: "Der Lauf wurde gestoppt: Ihre neuen Nachrichten konnten nicht übernommen werden. Nichts Gesendetes ging verloren; wiederholen Sie die Anfrage, um fortzufahren.",
  es: "La ejecución se detuvo: no pudo recibir sus mensajes nuevos. No se perdió nada de lo enviado; repita la solicitud para continuar.",
  it: "L’esecuzione si è fermata: non è riuscita a ricevere i tuoi nuovi messaggi. Nulla di quanto inviato è andato perso; ripeti la richiesta per continuare.",
  pl: "Uruchomienie zatrzymano: nie udało się przyjąć nowych wiadomości. Nic z wysłanych nie zginęło; powtórz prośbę, aby kontynuować.",
  pt: "A execução parou: não conseguiu receber as suas novas mensagens. Nada do que enviou se perdeu; repita o pedido para continuar.",
  nl: "De uitvoering is gestopt: je nieuwe berichten konden niet worden opgenomen. Er is niets verloren gegaan; herhaal het verzoek om door te gaan.",
  tr: "Çalıştırma durdu: yeni mesajlarınız alınamadı. Gönderdiklerinizden hiçbiri kaybolmadı; devam etmek için isteği yineleyin.",
  ru: "Запуск остановлен: не удалось принять ваши новые сообщения. Ничего из отправленного не потеряно; повторите запрос, чтобы продолжить.",
  zh: "运行已停止：无法接收您的新消息。您发送的内容没有丢失；请重新发送请求以继续。",
  ja: "実行が停止しました：新しいメッセージを受け取れませんでした。送信内容は失われていません。続けるにはもう一度依頼してください。",
  ko: "실행이 중지되었습니다: 새 메시지를 받을 수 없었습니다. 보낸 내용은 사라지지 않았습니다. 계속하려면 요청을 다시 보내 주세요.",
  ar: "توقف التشغيل: تعذّر استلام رسائلك الجديدة. لم يُفقد شيء مما أرسلته؛ أعد الطلب للمتابعة.",
  hi: "रन रुक गया: आपके नए संदेश नहीं लिए जा सके। आपका भेजा कुछ भी नहीं खोया; जारी रखने के लिए अनुरोध दोहराएँ।",
};

export function codingInboxAdmissionMessage(language: CompanyChatLanguage = "en"): string {
  return inboxAdmissionCopy[language] ?? inboxAdmissionCopy.en;
}
