import type { CompanyChatLanguage } from "./company-chat-i18n";

/**
 * What a chat says about its run that a server restart interrupted (V6 step 18): the API was killed during an edit and
 * the reopened chat showed only "Error · 0:00", with no reason and no next step.
 */
const NOTICE: Record<CompanyChatLanguage, string> = {
  en: "⚠️ This work was interrupted: the server restarted while the agent was running. Steps completed before that are shown above; nothing after them was done. Send the request again to continue.",
  uk: "⚠️ Роботу перервано: сервер перезапустився, поки агент працював. Кроки, виконані до цього, показано вище; далі нічого не робилося. Надішліть запит ще раз, щоб продовжити.",
  ru: "⚠️ Работа прервана: сервер перезапустился, пока агент работал. Шаги, выполненные до этого, показаны выше; дальше ничего не делалось. Отправьте запрос ещё раз, чтобы продолжить.",
  de: "⚠️ Die Arbeit wurde unterbrochen: Der Server wurde neu gestartet, während der Agent arbeitete. Die bis dahin erledigten Schritte stehen oben; danach wurde nichts mehr getan. Senden Sie die Anfrage erneut, um fortzufahren.",
  fr: "⚠️ Le travail a été interrompu : le serveur a redémarré pendant que l'agent travaillait. Les étapes terminées avant cela sont affichées ci-dessus ; rien n'a été fait ensuite. Renvoyez la demande pour continuer.",
  es: "⚠️ El trabajo se interrumpió: el servidor se reinició mientras el agente trabajaba. Los pasos completados antes se muestran arriba; después no se hizo nada. Envía la solicitud de nuevo para continuar.",
  it: "⚠️ Il lavoro è stato interrotto: il server si è riavviato mentre l'agente lavorava. I passaggi completati prima sono mostrati sopra; dopo non è stato fatto nulla. Invia di nuovo la richiesta per continuare.",
  pl: "⚠️ Praca została przerwana: serwer uruchomił się ponownie, gdy agent pracował. Kroki wykonane wcześniej są pokazane powyżej; potem nic nie zrobiono. Wyślij prośbę ponownie, aby kontynuować.",
  pt: "⚠️ O trabalho foi interrompido: o servidor reiniciou enquanto o agente trabalhava. Os passos concluídos antes são mostrados acima; depois nada foi feito. Envie o pedido novamente para continuar.",
  nl: "⚠️ Het werk is onderbroken: de server is opnieuw gestart terwijl de agent bezig was. De stappen die daarvoor klaar waren staan hierboven; daarna is niets meer gedaan. Stuur het verzoek opnieuw om verder te gaan.",
  tr: "⚠️ Çalışma kesildi: ajan çalışırken sunucu yeniden başladı. Öncesinde tamamlanan adımlar yukarıda; sonrasında hiçbir şey yapılmadı. Devam etmek için isteği yeniden gönderin.",
  zh: "⚠️ 工作已中断：代理运行时服务器重新启动。之前完成的步骤显示在上方；之后没有执行任何操作。请再次发送请求以继续。",
  ja: "⚠️ 作業が中断されました：エージェントの実行中にサーバーが再起動しました。それまでに完了した手順は上に表示されています。その後は何も行われていません。続けるにはもう一度リクエストを送信してください。",
  ko: "⚠️ 작업이 중단되었습니다: 에이전트가 작업하는 동안 서버가 다시 시작되었습니다. 그 전에 완료된 단계는 위에 표시되어 있으며, 그 이후에는 아무것도 수행되지 않았습니다. 계속하려면 요청을 다시 보내세요.",
  ar: "⚠️ توقف العمل: أُعيد تشغيل الخادم أثناء عمل الوكيل. الخطوات المكتملة قبل ذلك معروضة أعلاه؛ ولم يُنفَّذ شيء بعدها. أرسل الطلب مرة أخرى للمتابعة.",
  hi: "⚠️ काम रुक गया: एजेंट के काम करते समय सर्वर फिर से शुरू हो गया। उससे पहले पूरे हुए कदम ऊपर दिखाए गए हैं; उसके बाद कुछ नहीं किया गया। जारी रखने के लिए अनुरोध फिर से भेजें।",
};

export function runInterruptedNotice(language: string | undefined): string {
  return NOTICE[language as CompanyChatLanguage] ?? NOTICE.en;
}
