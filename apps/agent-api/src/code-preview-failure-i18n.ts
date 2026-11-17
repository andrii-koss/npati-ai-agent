import type { CompanyChatLanguage } from "./company-chat-i18n";

/**
 * The notice added to a finished run's reply when its Preview does not start, in the language of the request. Every
 * chat language is required by the type: a three-language map answered a German or Japanese request in English
 * (V6 step 17). "backend" is a server that did not start; "website" is a site whose Preview did not start.
 */
type Notice = (reason: string) => string;
const notices: Record<CompanyChatLanguage, { backend: Notice; website: Notice }> = {
  en: {
    backend: r => `⚠️ The server did not start in Preview: ${r}. The code and changes are saved; start Preview again or ask the agent to fix the start.`,
    website: r => `⚠️ The site Preview did not start: ${r}. The file changes are saved; start Preview again or ask the agent to fix the start.`,
  },
  uk: {
    backend: r => `⚠️ Сервер не запустився в Preview: ${r}. Код і зміни збережено; запустіть Preview знову або попросіть агента виправити запуск.`,
    website: r => `⚠️ Preview сайту не запустився: ${r}. Зміни у файлах збережено; запустіть Preview знову або попросіть агента виправити запуск.`,
  },
  ru: {
    backend: r => `⚠️ Сервер не запустился в Preview: ${r}. Код и изменения сохранены; запустите Preview снова или попросите агента исправить запуск.`,
    website: r => `⚠️ Preview сайта не запустился: ${r}. Изменения в файлах сохранены; запустите Preview снова или попросите агента исправить запуск.`,
  },
  de: {
    backend: r => `⚠️ Der Server ist in der Preview nicht gestartet: ${r}. Code und Änderungen sind gespeichert; starten Sie die Preview erneut oder bitten Sie den Agenten, den Start zu beheben.`,
    website: r => `⚠️ Die Preview der Website ist nicht gestartet: ${r}. Die Dateiänderungen sind gespeichert; starten Sie die Preview erneut oder bitten Sie den Agenten, den Start zu beheben.`,
  },
  fr: {
    backend: r => `⚠️ Le serveur n'a pas démarré dans la Preview : ${r}. Le code et les modifications sont enregistrés ; relancez la Preview ou demandez à l'agent de corriger le démarrage.`,
    website: r => `⚠️ La Preview du site n'a pas démarré : ${r}. Les modifications des fichiers sont enregistrées ; relancez la Preview ou demandez à l'agent de corriger le démarrage.`,
  },
  es: {
    backend: r => `⚠️ El servidor no se inició en la Preview: ${r}. El código y los cambios están guardados; vuelve a iniciar la Preview o pide al agente que corrija el arranque.`,
    website: r => `⚠️ La Preview del sitio no se inició: ${r}. Los cambios en los archivos están guardados; vuelve a iniciar la Preview o pide al agente que corrija el arranque.`,
  },
  it: {
    backend: r => `⚠️ Il server non si è avviato nella Preview: ${r}. Il codice e le modifiche sono salvati; riavvia la Preview o chiedi all'agente di correggere l'avvio.`,
    website: r => `⚠️ La Preview del sito non si è avviata: ${r}. Le modifiche ai file sono salvate; riavvia la Preview o chiedi all'agente di correggere l'avvio.`,
  },
  pl: {
    backend: r => `⚠️ Serwer nie uruchomił się w Preview: ${r}. Kod i zmiany są zapisane; uruchom Preview ponownie albo poproś agenta o naprawienie startu.`,
    website: r => `⚠️ Preview strony się nie uruchomił: ${r}. Zmiany w plikach są zapisane; uruchom Preview ponownie albo poproś agenta o naprawienie startu.`,
  },
  pt: {
    backend: r => `⚠️ O servidor não iniciou na Preview: ${r}. O código e as alterações foram guardados; inicie a Preview novamente ou peça ao agente para corrigir o arranque.`,
    website: r => `⚠️ A Preview do site não iniciou: ${r}. As alterações nos ficheiros foram guardadas; inicie a Preview novamente ou peça ao agente para corrigir o arranque.`,
  },
  nl: {
    backend: r => `⚠️ De server is niet gestart in de Preview: ${r}. De code en wijzigingen zijn opgeslagen; start de Preview opnieuw of vraag de agent de start te herstellen.`,
    website: r => `⚠️ De Preview van de site is niet gestart: ${r}. De bestandswijzigingen zijn opgeslagen; start de Preview opnieuw of vraag de agent de start te herstellen.`,
  },
  tr: {
    backend: r => `⚠️ Sunucu Preview'da başlamadı: ${r}. Kod ve değişiklikler kaydedildi; Preview'ı yeniden başlatın veya ajandan başlatmayı düzeltmesini isteyin.`,
    website: r => `⚠️ Sitenin Preview'ı başlamadı: ${r}. Dosya değişiklikleri kaydedildi; Preview'ı yeniden başlatın veya ajandan başlatmayı düzeltmesini isteyin.`,
  },
  zh: {
    backend: r => `⚠️ 服务器未能在 Preview 中启动：${r}。代码和更改已保存；请重新启动 Preview，或让代理修复启动问题。`,
    website: r => `⚠️ 网站的 Preview 未能启动：${r}。文件更改已保存；请重新启动 Preview，或让代理修复启动问题。`,
  },
  ja: {
    backend: r => `⚠️ サーバーが Preview で起動しませんでした：${r}。コードと変更は保存されています。Preview を再起動するか、エージェントに起動の修正を依頼してください。`,
    website: r => `⚠️ サイトの Preview が起動しませんでした：${r}。ファイルの変更は保存されています。Preview を再起動するか、エージェントに起動の修正を依頼してください。`,
  },
  ko: {
    backend: r => `⚠️ 서버가 Preview에서 시작되지 않았습니다: ${r}. 코드와 변경 사항은 저장되었습니다. Preview를 다시 시작하거나 에이전트에게 시작 문제를 고쳐 달라고 요청하세요.`,
    website: r => `⚠️ 사이트 Preview가 시작되지 않았습니다: ${r}. 파일 변경 사항은 저장되었습니다. Preview를 다시 시작하거나 에이전트에게 시작 문제를 고쳐 달라고 요청하세요.`,
  },
  ar: {
    backend: r => `⚠️ لم يبدأ الخادم في Preview: ${r}. تم حفظ الكود والتغييرات؛ أعد تشغيل Preview أو اطلب من الوكيل إصلاح التشغيل.`,
    website: r => `⚠️ لم تبدأ Preview الموقع: ${r}. تم حفظ تغييرات الملفات؛ أعد تشغيل Preview أو اطلب من الوكيل إصلاح التشغيل.`,
  },
  hi: {
    backend: r => `⚠️ सर्वर Preview में शुरू नहीं हुआ: ${r}. कोड और बदलाव सहेज लिए गए हैं; Preview फिर से शुरू करें या एजेंट से शुरुआत ठीक करने को कहें।`,
    website: r => `⚠️ साइट का Preview शुरू नहीं हुआ: ${r}. फ़ाइलों के बदलाव सहेज लिए गए हैं; Preview फिर से शुरू करें या एजेंट से शुरुआत ठीक करने को कहें।`,
  },
};

export function previewFailedNotice(kind: "backend" | "website", language: string | undefined, reason: string): string {
  return (notices[language as CompanyChatLanguage] ?? notices.en)[kind](reason);
}
