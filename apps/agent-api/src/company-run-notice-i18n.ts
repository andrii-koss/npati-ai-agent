/**
 * Company-run notices in the 16 chat languages. Only Ukrainian, Russian and English existed, so an Arabic or Hindi
 * user whose model was out of credits was told in English that the task could not be completed (V6 step 13).
 */
import type { CompanyChatLanguage } from "./company-chat-i18n";

type Notices = {
  completed: string;
  notCompleted: string;
  unavailable: string;
  unreachable: (target: string, reason: string) => string;
  researchFailed: (reason: string) => string;
};

const NOTICES: Record<CompanyChatLanguage, Notices> = {
  en: {
    completed: "Company run completed.",
    notCompleted: "The company task was not completed: ",
    unavailable: "The company task could not be completed because the selected AI model is temporarily unavailable. Check the selected model connection in AI Marketplace, then try again.",
    unreachable: (t, r) => `The page ${t} could not be opened${r}\n\nWithout its content I will not analyse the site, so as not to invent findings. Check the address and that the site is reachable, or send a screenshot or the page HTML.`,
    researchFailed: (r) => `The web search returned nothing usable${r}\n\nWithout retrieved pages I will not draw conclusions, so as not to invent findings. Refine the request or name specific sites.`,
  },
  uk: {
    completed: "Завдання компанії виконано.",
    notCompleted: "Завдання компанії не виконано: ",
    unavailable: "Не вдалося виконати завдання компанії через тимчасову недоступність вибраної AI-моделі. Перевірте підключення вибраної моделі в AI Marketplace і спробуйте ще раз.",
    unreachable: (t, r) => `Не вдалося відкрити сторінку ${t}${r}\n\nБез її вмісту я не аналізую сайт, щоб не вигадувати висновки. Перевірте адресу та доступність сайту або надішліть скріншот чи HTML сторінки.`,
    researchFailed: (r) => `Вебпошук не дав результатів, на які можна спертися${r}\n\nБез знайдених сторінок я не роблю висновків, щоб не вигадувати. Спробуйте уточнити запит або назвіть конкретні сайти.`,
  },
  ru: {
    completed: "Задача компании выполнена.",
    notCompleted: "Задача компании не выполнена: ",
    unavailable: "Не удалось выполнить задачу компании из-за временной недоступности выбранной AI-модели. Проверьте подключение выбранной модели в AI Marketplace и попробуйте снова.",
    unreachable: (t, r) => `Не удалось открыть страницу ${t}${r}\n\nБез её содержимого я не анализирую сайт, чтобы не выдумывать выводы. Проверьте адрес и доступность сайта или пришлите скриншот или HTML страницы.`,
    researchFailed: (r) => `Веб-поиск не дал результатов, на которые можно опереться${r}\n\nБез найденных страниц я не делаю выводов, чтобы не выдумывать. Уточните запрос или назовите конкретные сайты.`,
  },
  de: {
    completed: "Die Firmenaufgabe ist abgeschlossen.",
    notCompleted: "Die Firmenaufgabe wurde nicht ausgeführt: ",
    unavailable: "Die Firmenaufgabe konnte nicht ausgeführt werden, weil das ausgewählte KI-Modell vorübergehend nicht verfügbar ist. Prüfe die Verbindung des Modells im AI Marketplace und versuche es erneut.",
    unreachable: (t, r) => `Die Seite ${t} konnte nicht geöffnet werden${r}\n\nOhne ihren Inhalt analysiere ich die Website nicht, um keine Ergebnisse zu erfinden. Prüfe die Adresse und ob die Website erreichbar ist, oder sende einen Screenshot oder das HTML der Seite.`,
    researchFailed: (r) => `Die Websuche hat nichts Verwertbares ergeben${r}\n\nOhne gefundene Seiten ziehe ich keine Schlüsse, um nichts zu erfinden. Präzisiere die Anfrage oder nenne konkrete Websites.`,
  },
  fr: {
    completed: "La tâche de l'entreprise est terminée.",
    notCompleted: "La tâche de l'entreprise n'a pas été effectuée : ",
    unavailable: "La tâche de l'entreprise n'a pas pu être effectuée, car le modèle d'IA sélectionné est temporairement indisponible. Vérifiez la connexion du modèle dans AI Marketplace, puis réessayez.",
    unreachable: (t, r) => `Impossible d'ouvrir la page ${t}${r}\n\nSans son contenu, je n'analyse pas le site, pour ne rien inventer. Vérifiez l'adresse et que le site est accessible, ou envoyez une capture d'écran ou le HTML de la page.`,
    researchFailed: (r) => `La recherche web n'a rien donné d'exploitable${r}\n\nSans pages trouvées, je ne tire pas de conclusions, pour ne rien inventer. Précisez la demande ou indiquez des sites précis.`,
  },
  es: {
    completed: "La tarea de la empresa se completó.",
    notCompleted: "La tarea de la empresa no se completó: ",
    unavailable: "No se pudo completar la tarea de la empresa porque el modelo de IA seleccionado no está disponible temporalmente. Revisa la conexión del modelo en AI Marketplace y vuelve a intentarlo.",
    unreachable: (t, r) => `No se pudo abrir la página ${t}${r}\n\nSin su contenido no analizo el sitio, para no inventar conclusiones. Revisa la dirección y que el sitio esté accesible, o envía una captura de pantalla o el HTML de la página.`,
    researchFailed: (r) => `La búsqueda web no devolvió nada útil${r}\n\nSin páginas encontradas no saco conclusiones, para no inventar. Precisa la consulta o indica sitios concretos.`,
  },
  it: {
    completed: "L'attività dell'azienda è stata completata.",
    notCompleted: "L'attività dell'azienda non è stata completata: ",
    unavailable: "Non è stato possibile completare l'attività dell'azienda perché il modello di IA selezionato è temporaneamente non disponibile. Controlla la connessione del modello in AI Marketplace e riprova.",
    unreachable: (t, r) => `Non è stato possibile aprire la pagina ${t}${r}\n\nSenza il suo contenuto non analizzo il sito, per non inventare conclusioni. Controlla l'indirizzo e che il sito sia raggiungibile, oppure invia uno screenshot o l'HTML della pagina.`,
    researchFailed: (r) => `La ricerca web non ha restituito nulla di utilizzabile${r}\n\nSenza pagine trovate non traggo conclusioni, per non inventare. Precisa la richiesta o indica siti specifici.`,
  },
  pl: {
    completed: "Zadanie firmy zostało wykonane.",
    notCompleted: "Zadanie firmy nie zostało wykonane: ",
    unavailable: "Nie udało się wykonać zadania firmy, ponieważ wybrany model AI jest chwilowo niedostępny. Sprawdź połączenie modelu w AI Marketplace i spróbuj ponownie.",
    unreachable: (t, r) => `Nie udało się otworzyć strony ${t}${r}\n\nBez jej treści nie analizuję witryny, żeby niczego nie wymyślać. Sprawdź adres i dostępność strony albo wyślij zrzut ekranu lub HTML strony.`,
    researchFailed: (r) => `Wyszukiwanie w sieci nie dało użytecznych wyników${r}\n\nBez znalezionych stron nie wyciągam wniosków, żeby niczego nie wymyślać. Doprecyzuj zapytanie lub podaj konkretne strony.`,
  },
  pt: {
    completed: "A tarefa da empresa foi concluída.",
    notCompleted: "A tarefa da empresa não foi concluída: ",
    unavailable: "Não foi possível concluir a tarefa da empresa porque o modelo de IA selecionado está temporariamente indisponível. Verifica a ligação do modelo no AI Marketplace e tenta novamente.",
    unreachable: (t, r) => `Não foi possível abrir a página ${t}${r}\n\nSem o seu conteúdo não analiso o site, para não inventar conclusões. Verifica o endereço e se o site está acessível, ou envia uma captura de ecrã ou o HTML da página.`,
    researchFailed: (r) => `A pesquisa na web não devolveu nada utilizável${r}\n\nSem páginas encontradas não tiro conclusões, para não inventar. Refina o pedido ou indica sites concretos.`,
  },
  nl: {
    completed: "De bedrijfstaak is voltooid.",
    notCompleted: "De bedrijfstaak is niet uitgevoerd: ",
    unavailable: "De bedrijfstaak kon niet worden uitgevoerd omdat het gekozen AI-model tijdelijk niet beschikbaar is. Controleer de verbinding van het model in AI Marketplace en probeer het opnieuw.",
    unreachable: (t, r) => `De pagina ${t} kon niet worden geopend${r}\n\nZonder de inhoud analyseer ik de site niet, om geen bevindingen te verzinnen. Controleer het adres en of de site bereikbaar is, of stuur een screenshot of de HTML van de pagina.`,
    researchFailed: (r) => `De webzoekopdracht leverde niets bruikbaars op${r}\n\nZonder gevonden pagina's trek ik geen conclusies, om niets te verzinnen. Verfijn de vraag of noem specifieke sites.`,
  },
  tr: {
    completed: "Şirket görevi tamamlandı.",
    notCompleted: "Şirket görevi tamamlanmadı: ",
    unavailable: "Seçili yapay zekâ modeli geçici olarak kullanılamadığı için şirket görevi tamamlanamadı. AI Marketplace'te modelin bağlantısını kontrol edip yeniden deneyin.",
    unreachable: (t, r) => `${t} sayfası açılamadı${r}\n\nİçeriği olmadan siteyi analiz etmiyorum, böylece sonuç uydurmuyorum. Adresi ve sitenin erişilebilir olduğunu kontrol edin ya da sayfanın ekran görüntüsünü veya HTML'ini gönderin.`,
    researchFailed: (r) => `Web araması kullanılabilir bir sonuç vermedi${r}\n\nBulunan sayfalar olmadan sonuç çıkarmıyorum, böylece bir şey uydurmuyorum. İsteği netleştirin ya da belirli siteleri belirtin.`,
  },
  zh: {
    completed: "公司任务已完成。",
    notCompleted: "公司任务未完成：",
    unavailable: "所选 AI 模型暂时不可用，公司任务未能完成。请在 AI Marketplace 中检查该模型的连接，然后重试。",
    unreachable: (t, r) => `无法打开页面 ${t}${r}\n\n没有页面内容，我不会分析该网站，以免编造结论。请检查地址和网站是否可以访问，或发送页面截图或 HTML。`,
    researchFailed: (r) => `网络搜索没有返回可用的结果${r}\n\n没有找到的页面，我不会下结论，以免编造。请细化请求或指定具体网站。`,
  },
  ja: {
    completed: "会社のタスクが完了しました。",
    notCompleted: "会社のタスクは完了しませんでした: ",
    unavailable: "選択した AI モデルが一時的に利用できないため、会社のタスクを完了できませんでした。AI Marketplace でモデルの接続を確認してから、もう一度お試しください。",
    unreachable: (t, r) => `ページ ${t} を開けませんでした${r}\n\n内容がないため、結論をでっち上げないようサイトの分析は行いません。アドレスとサイトにアクセスできるかを確認するか、ページのスクリーンショットまたは HTML を送ってください。`,
    researchFailed: (r) => `ウェブ検索で使える結果が見つかりませんでした${r}\n\n見つかったページがないため、でっち上げを避けて結論は出しません。リクエストを絞り込むか、具体的なサイトを指定してください。`,
  },
  ko: {
    completed: "회사 작업이 완료되었습니다.",
    notCompleted: "회사 작업이 완료되지 않았습니다: ",
    unavailable: "선택한 AI 모델을 일시적으로 사용할 수 없어 회사 작업을 완료하지 못했습니다. AI Marketplace에서 모델 연결을 확인한 후 다시 시도하세요.",
    unreachable: (t, r) => `페이지 ${t}을(를) 열 수 없습니다${r}\n\n내용 없이 사이트를 분석하면 결론을 지어내게 되므로 분석하지 않습니다. 주소와 사이트 접속 가능 여부를 확인하거나 페이지 스크린샷 또는 HTML을 보내 주세요.`,
    researchFailed: (r) => `웹 검색에서 쓸 만한 결과를 찾지 못했습니다${r}\n\n찾은 페이지 없이 결론을 내리면 지어내게 되므로 결론을 내리지 않습니다. 요청을 구체화하거나 특정 사이트를 알려 주세요.`,
  },
  ar: {
    completed: "اكتملت مهمة الشركة.",
    notCompleted: "لم تكتمل مهمة الشركة: ",
    unavailable: "تعذّر إكمال مهمة الشركة لأن نموذج الذكاء الاصطناعي المحدد غير متاح مؤقتًا. تحقّق من اتصال النموذج في AI Marketplace ثم حاول مرة أخرى.",
    unreachable: (t, r) => `تعذّر فتح الصفحة ${t}${r}\n\nلن أحلّل الموقع دون محتواها كي لا أختلق استنتاجات. تحقّق من العنوان ومن إمكانية الوصول إلى الموقع، أو أرسل لقطة شاشة أو HTML الصفحة.`,
    researchFailed: (r) => `لم يُرجع البحث على الويب أي نتيجة يمكن الاعتماد عليها${r}\n\nلن أستخلص استنتاجات دون صفحات تم العثور عليها كي لا أختلق شيئًا. حدّد الطلب بدقة أكبر أو اذكر مواقع بعينها.`,
  },
  hi: {
    completed: "कंपनी का कार्य पूरा हुआ।",
    notCompleted: "कंपनी का कार्य पूरा नहीं हुआ: ",
    unavailable: "चुना गया AI मॉडल अस्थायी रूप से उपलब्ध नहीं है, इसलिए कंपनी का कार्य पूरा नहीं हो सका। AI Marketplace में मॉडल का कनेक्शन जाँचें और फिर से प्रयास करें।",
    unreachable: (t, r) => `पेज ${t} नहीं खुल सका${r}\n\nइसकी सामग्री के बिना मैं साइट का विश्लेषण नहीं करता, ताकि कोई निष्कर्ष गढ़ा न जाए। पता और साइट की उपलब्धता जाँचें, या पेज का स्क्रीनशॉट या HTML भेजें।`,
    researchFailed: (r) => `वेब खोज से कोई उपयोगी परिणाम नहीं मिला${r}\n\nमिले हुए पेजों के बिना मैं निष्कर्ष नहीं निकालता, ताकि कुछ गढ़ा न जाए। अनुरोध को और स्पष्ट करें या विशिष्ट साइटें बताएं।`,
  },
};

export function companyRunNotices(language: CompanyChatLanguage): Notices {
  return NOTICES[language] ?? NOTICES.en;
}

/** A coding run that failed after writing files says which files it already changed, so the person can check them. */
const FILES_CHANGED_BEFORE_FAILURE: Record<CompanyChatLanguage, string> = {
  en: "Files changed before the failure: ", uk: "Файли, змінені до збою: ", ru: "Файлы, изменённые до сбоя: ",
  de: "Vor dem Fehler geänderte Dateien: ", fr: "Fichiers modifiés avant l'échec : ", es: "Archivos modificados antes del fallo: ",
  it: "File modificati prima dell'errore: ", pl: "Pliki zmienione przed błędem: ", pt: "Ficheiros alterados antes da falha: ",
  nl: "Bestanden die vóór de fout zijn gewijzigd: ", tr: "Hatadan önce değişen dosyalar: ", zh: "失败前已更改的文件：",
  ja: "失敗前に変更されたファイル: ", ko: "실패 전에 변경된 파일: ", ar: "الملفات التي تغيّرت قبل الفشل: ", hi: "विफलता से पहले बदली गई फ़ाइलें: ",
};
const FILES_CHANGED_BEFORE_STOP: Record<CompanyChatLanguage, string> = {
  en: "These files had already been changed before the stop and stay as they are: ", uk: "Ці файли було змінено ще до зупинки, і вони лишаються такими: ",
  ru: "Эти файлы были изменены ещё до остановки и остаются такими: ", de: "Diese Dateien wurden schon vor dem Stopp geändert und bleiben so: ",
  fr: "Ces fichiers avaient déjà été modifiés avant l'arrêt et restent ainsi : ", es: "Estos archivos ya se habían modificado antes de la detención y se quedan así: ",
  it: "Questi file erano già stati modificati prima dell'arresto e restano così: ", pl: "Te pliki zmieniono jeszcze przed zatrzymaniem i pozostają bez zmian: ",
  pt: "Estes ficheiros já tinham sido alterados antes da paragem e ficam assim: ", nl: "Deze bestanden waren al gewijzigd vóór het stoppen en blijven zo: ",
  tr: "Bu dosyalar durdurmadan önce değiştirilmişti ve öyle kalıyor: ", zh: "这些文件在停止之前已被修改，并保持原样：", ja: "これらのファイルは停止前に変更済みで、そのまま残ります：",
  ko: "이 파일들은 중지 전에 이미 변경되었으며 그대로 유지됩니다: ", ar: "عُدّلت هذه الملفات قبل الإيقاف وتبقى كما هي: ", hi: "ये फ़ाइलें रोकने से पहले बदली जा चुकी थीं और वैसी ही रहेंगी: ",
};

/** A stopped run names what it had already changed, so the person does not think nothing happened (V6 step 18). */
export function filesChangedBeforeStop(language: CompanyChatLanguage | undefined, files: string[]): string {
  if (!files.length) return "";
  return "\n\n" + (FILES_CHANGED_BEFORE_STOP[language ?? "en"] ?? FILES_CHANGED_BEFORE_STOP.en) + files.slice(0, 20).map((file) => "`" + file + "`").join(", ") + (files.length > 20 ? ", …" : "");
}

export function filesChangedBeforeFailure(language: CompanyChatLanguage | undefined, files: string[]): string {
  if (!files.length) return "";
  return "\n\n" + (FILES_CHANGED_BEFORE_FAILURE[language ?? "en"] ?? FILES_CHANGED_BEFORE_FAILURE.en) + files.slice(0, 20).map((file) => "`" + file + "`").join(", ") + (files.length > 20 ? ", …" : "");
}

/**
 * "Select a company first" for a website request with no company chosen. It was English for every language, then
 * listed a first page of company names (V6 step 13); it now says where to choose the company.
 */
const SELECT_COMPANY: Record<CompanyChatLanguage, [string, string]> = {
  en: ["Select an active Company before creating a website.", "Choose a company in the selector at the bottom of the chat input, then send the request again."],
  uk: ["Оберіть активну компанію, перш ніж створювати сайт.", "Оберіть компанію в перемикачі внизу поля вводу, а потім надішліть запит ще раз."],
  ru: ["Выберите активную компанию, прежде чем создавать сайт.", "Выберите компанию в переключателе внизу поля ввода, затем отправьте запрос ещё раз."],
  de: ["Wählen Sie eine aktive Firma aus, bevor Sie eine Website erstellen.", "Wählen Sie unten im Eingabefeld eine Firma aus und senden Sie die Anfrage dann erneut."],
  fr: ["Sélectionnez une entreprise active avant de créer un site web.", "Choisissez une entreprise dans le sélecteur en bas du champ de saisie, puis renvoyez la demande."],
  es: ["Selecciona una empresa activa antes de crear un sitio web.", "Elige una empresa en el selector de la parte inferior del campo de entrada y vuelve a enviar la solicitud."],
  it: ["Seleziona un'azienda attiva prima di creare un sito web.", "Scegli un'azienda nel selettore in fondo al campo di inserimento, poi invia di nuovo la richiesta."],
  pl: ["Wybierz aktywną firmę przed utworzeniem strony internetowej.", "Wybierz firmę w przełączniku na dole pola wpisywania, a potem wyślij prośbę ponownie."],
  pt: ["Seleciona uma empresa ativa antes de criar um site.", "Escolhe uma empresa no seletor na parte inferior do campo de mensagem e envia o pedido novamente."],
  nl: ["Selecteer een actief bedrijf voordat u een website maakt.", "Kies een bedrijf in de keuzelijst onder in het invoerveld en stuur het verzoek daarna opnieuw."],
  tr: ["Web sitesi oluşturmadan önce etkin bir şirket seçin.", "Giriş alanının altındaki seçiciden bir şirket seçin ve isteği yeniden gönderin."],
  zh: ["创建网站前，请先选择一个活动公司。", "请在输入框底部的选择器中选择一个公司，然后重新发送请求。"],
  ja: ["ウェブサイトを作成する前に、有効な会社を選択してください。", "入力欄の下にある切り替えで会社を選択してから、もう一度送信してください。"],
  ko: ["웹사이트를 만들기 전에 활성 회사를 선택하세요.", "입력창 아래의 선택기에서 회사를 선택한 다음 요청을 다시 보내세요."],
  ar: ["اختر شركة نشطة قبل إنشاء موقع ويب.", "اختر شركة من المحدد أسفل حقل الإدخال، ثم أرسل الطلب مرة أخرى."],
  hi: ["वेबसाइट बनाने से पहले एक सक्रिय कंपनी चुनें।", "इनपुट बॉक्स के नीचे वाले चयनकर्ता में एक कंपनी चुनें, फिर अनुरोध दोबारा भेजें।"],
};
export function selectCompanyForWebsite(language: CompanyChatLanguage, companyNames: string[]): string {
  const [none, choose] = SELECT_COMPANY[language] ?? SELECT_COMPANY.en;
  return companyNames.length ? choose : none;
}
