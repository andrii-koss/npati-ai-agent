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
