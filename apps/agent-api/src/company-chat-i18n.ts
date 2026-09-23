export type CompanyChatLanguage = "en" | "uk" | "fr" | "de" | "es" | "it" | "pl" | "pt" | "nl" | "tr" | "ru" | "zh" | "ja" | "ko" | "ar" | "hi";

export type CompanyChatCopy = {
  created: string;
  updated: string;
  deleted: string;
  configured: string;
  company: string;
  name: string;
  status: string;
  active: string;
  inactive: string;
  industry: string;
  website: string;
  languages: string;
  brandTone: string;
  description: string;
  products: string;
  agents: string;
  mainAgent: string;
  noAgents: string;
  notSpecified: string;
  openSettings: string;
  nextStep: string;
  incomplete: string;
  noAction: string;
  failed: string;
  partial: string;
  unchanged: string;
};

const copy: Record<CompanyChatLanguage, CompanyChatCopy> = {
  en: { created: "Done. I created **{name}** and saved it in company settings.", updated: "Done. I updated **{name}**.", deleted: "Done. Company **{name}** was deleted.", configured: "Here is the current configuration:", company: "Company", name: "Name", status: "Status", active: "Active", inactive: "Inactive", industry: "Industry", website: "Website", languages: "Languages", brandTone: "Brand tone", description: "Company description", products: "Products or services", agents: "Agent team", mainAgent: "main agent", noAgents: "No agents have been added yet.", notSpecified: "Not specified", openSettings: "Open company settings →", nextStep: "**Next step:** would you like me to refine the roles, instructions, and models for these agents?", incomplete: "I couldn't complete the company change because the action was incomplete. Please try again.", noAction: "I couldn't complete the company change. No company or agent changes were saved. Please clarify the request or try again.", failed: "I couldn't complete the company change", partial: "Some changes may have been saved. Review Settings > Company before retrying.", unchanged: "No changes were saved." },
  uk: { created: "Готово, я створив компанію **{name}** і зберіг її в налаштуваннях.", updated: "Готово, я оновив компанію **{name}**.", deleted: "Готово, компанію **{name}** видалено.", configured: "Ось що зараз налаштовано:", company: "Компанія", name: "Назва", status: "Статус", active: "Активна", inactive: "Неактивна", industry: "Галузь", website: "Вебсайт", languages: "Мови", brandTone: "Тон бренду", description: "Опис компанії", products: "Продукти або послуги", agents: "Команда агентів", mainAgent: "головний агент", noAgents: "Агентів ще не додано.", notSpecified: "Не вказано", openSettings: "Відкрити налаштування компанії →", nextStep: "**Наступний крок:** хочете, щоб я детальніше налаштував ролі, інструкції та моделі для цих агентів?", incomplete: "Не вдалося виконати зміну компанії, тому що команда була неповною. Спробуйте ще раз.", noAction: "Не вдалося виконати зміну компанії. Компанію та агентів не було змінено. Уточніть запит або спробуйте ще раз.", failed: "Не вдалося виконати зміну компанії", partial: "Частину змін могло бути збережено. Перевірте Налаштування > Компанія перед повторною спробою.", unchanged: "Зміни не збережено." },
  fr: { created: "Terminé. J’ai créé l’entreprise **{name}** et l’ai enregistrée dans les paramètres.", updated: "Terminé. J’ai mis à jour l’entreprise **{name}**.", deleted: "Terminé. L’entreprise **{name}** a été supprimée.", configured: "Voici la configuration actuelle :", company: "Entreprise", name: "Nom", status: "Statut", active: "Active", inactive: "Inactive", industry: "Secteur", website: "Site web", languages: "Langues", brandTone: "Ton de marque", description: "Description de l’entreprise", products: "Produits ou services", agents: "Équipe d’agents", mainAgent: "agent principal", noAgents: "Aucun agent n’a encore été ajouté.", notSpecified: "Non renseigné", openSettings: "Ouvrir les paramètres de l’entreprise →", nextStep: "**Étape suivante :** souhaitez-vous que je précise les rôles, les instructions et les modèles de ces agents ?", incomplete: "Je n’ai pas pu effectuer la modification, car l’action était incomplète. Réessayez.", noAction: "Je n’ai pas pu effectuer la modification. Aucune entreprise ni aucun agent n’a été modifié. Précisez votre demande ou réessayez.", failed: "Je n’ai pas pu effectuer la modification de l’entreprise", partial: "Certaines modifications ont peut-être été enregistrées. Vérifiez Paramètres > Entreprise avant de réessayer.", unchanged: "Aucune modification n’a été enregistrée." },
  de: { created: "Erledigt. Ich habe **{name}** erstellt und in den Unternehmenseinstellungen gespeichert.", updated: "Erledigt. Ich habe **{name}** aktualisiert.", deleted: "Erledigt. Das Unternehmen **{name}** wurde gelöscht.", configured: "Das ist die aktuelle Konfiguration:", company: "Unternehmen", name: "Name", status: "Status", active: "Aktiv", inactive: "Inaktiv", industry: "Branche", website: "Website", languages: "Sprachen", brandTone: "Markenton", description: "Unternehmensbeschreibung", products: "Produkte oder Dienstleistungen", agents: "Agententeam", mainAgent: "Hauptagent", noAgents: "Es wurden noch keine Agenten hinzugefügt.", notSpecified: "Nicht angegeben", openSettings: "Unternehmenseinstellungen öffnen →", nextStep: "**Nächster Schritt:** Soll ich die Rollen, Anweisungen und Modelle dieser Agenten genauer konfigurieren?", incomplete: "Die Unternehmensänderung konnte nicht abgeschlossen werden, weil die Aktion unvollständig war. Bitte erneut versuchen.", noAction: "Die Unternehmensänderung konnte nicht abgeschlossen werden. Unternehmen und Agenten wurden nicht geändert. Bitte die Anfrage präzisieren oder erneut versuchen.", failed: "Die Unternehmensänderung konnte nicht abgeschlossen werden", partial: "Einige Änderungen wurden möglicherweise gespeichert. Prüfen Sie Einstellungen > Unternehmen, bevor Sie es erneut versuchen.", unchanged: "Es wurden keine Änderungen gespeichert." },
  es: { created: "Listo. He creado **{name}** y la he guardado en la configuración de la empresa.", updated: "Listo. He actualizado **{name}**.", deleted: "Listo. La empresa **{name}** ha sido eliminada.", configured: "Esta es la configuración actual:", company: "Empresa", name: "Nombre", status: "Estado", active: "Activa", inactive: "Inactiva", industry: "Sector", website: "Sitio web", languages: "Idiomas", brandTone: "Tono de marca", description: "Descripción de la empresa", products: "Productos o servicios", agents: "Equipo de agentes", mainAgent: "agente principal", noAgents: "Todavía no se han añadido agentes.", notSpecified: "No especificado", openSettings: "Abrir la configuración de la empresa →", nextStep: "**Siguiente paso:** ¿quieres que configure con más detalle los roles, las instrucciones y los modelos de estos agentes?", incomplete: "No pude completar el cambio porque la acción estaba incompleta. Inténtalo de nuevo.", noAction: "No pude completar el cambio. No se modificó ninguna empresa ni agente. Aclara la solicitud o inténtalo de nuevo.", failed: "No pude completar el cambio de la empresa", partial: "Es posible que se hayan guardado algunos cambios. Revisa Configuración > Empresa antes de volver a intentarlo.", unchanged: "No se guardó ningún cambio." },
  it: { created: "Fatto. Ho creato **{name}** e l’ho salvata nelle impostazioni dell’azienda.", updated: "Fatto. Ho aggiornato **{name}**.", deleted: "Fatto. L’azienda **{name}** è stata eliminata.", configured: "Ecco la configurazione attuale:", company: "Azienda", name: "Nome", status: "Stato", active: "Attiva", inactive: "Inattiva", industry: "Settore", website: "Sito web", languages: "Lingue", brandTone: "Tono del brand", description: "Descrizione dell’azienda", products: "Prodotti o servizi", agents: "Team di agenti", mainAgent: "agente principale", noAgents: "Non sono ancora stati aggiunti agenti.", notSpecified: "Non specificato", openSettings: "Apri le impostazioni dell’azienda →", nextStep: "**Passaggio successivo:** vuoi che configuri meglio ruoli, istruzioni e modelli di questi agenti?", incomplete: "Non ho potuto completare la modifica perché l’azione era incompleta. Riprova.", noAction: "Non ho potuto completare la modifica. Nessuna azienda o agente è stato modificato. Specifica meglio la richiesta o riprova.", failed: "Non ho potuto completare la modifica dell’azienda", partial: "Alcune modifiche potrebbero essere state salvate. Controlla Impostazioni > Azienda prima di riprovare.", unchanged: "Nessuna modifica è stata salvata." },
  pl: { created: "Gotowe. Utworzyłem firmę **{name}** i zapisałem ją w ustawieniach.", updated: "Gotowe. Zaktualizowałem firmę **{name}**.", deleted: "Gotowe. Firma **{name}** została usunięta.", configured: "Oto bieżąca konfiguracja:", company: "Firma", name: "Nazwa", status: "Status", active: "Aktywna", inactive: "Nieaktywna", industry: "Branża", website: "Strona internetowa", languages: "Języki", brandTone: "Ton marki", description: "Opis firmy", products: "Produkty lub usługi", agents: "Zespół agentów", mainAgent: "główny agent", noAgents: "Nie dodano jeszcze agentów.", notSpecified: "Nie podano", openSettings: "Otwórz ustawienia firmy →", nextStep: "**Następny krok:** czy mam dokładniej skonfigurować role, instrukcje i modele tych agentów?", incomplete: "Nie udało się zakończyć zmiany, ponieważ akcja była niekompletna. Spróbuj ponownie.", noAction: "Nie udało się wykonać zmiany. Firma ani agenci nie zostali zmienieni. Doprecyzuj prośbę lub spróbuj ponownie.", failed: "Nie udało się wykonać zmiany firmy", partial: "Niektóre zmiany mogły zostać zapisane. Przed ponowną próbą sprawdź Ustawienia > Firma.", unchanged: "Nie zapisano żadnych zmian." },
  pt: { created: "Concluído. Criei **{name}** e salvei nas configurações da empresa.", updated: "Concluído. Atualizei **{name}**.", deleted: "Concluído. A empresa **{name}** foi excluída.", configured: "Esta é a configuração atual:", company: "Empresa", name: "Nome", status: "Status", active: "Ativa", inactive: "Inativa", industry: "Setor", website: "Site", languages: "Idiomas", brandTone: "Tom da marca", description: "Descrição da empresa", products: "Produtos ou serviços", agents: "Equipe de agentes", mainAgent: "agente principal", noAgents: "Nenhum agente foi adicionado ainda.", notSpecified: "Não informado", openSettings: "Abrir configurações da empresa →", nextStep: "**Próximo passo:** quer que eu detalhe as funções, instruções e modelos desses agentes?", incomplete: "Não consegui concluir a alteração porque a ação estava incompleta. Tente novamente.", noAction: "Não consegui concluir a alteração. Nenhuma empresa ou agente foi modificado. Esclareça o pedido ou tente novamente.", failed: "Não consegui concluir a alteração da empresa", partial: "Algumas alterações podem ter sido salvas. Verifique Configurações > Empresa antes de tentar novamente.", unchanged: "Nenhuma alteração foi salva." },
  nl: { created: "Klaar. Ik heb **{name}** aangemaakt en opgeslagen in de bedrijfsinstellingen.", updated: "Klaar. Ik heb **{name}** bijgewerkt.", deleted: "Klaar. Bedrijf **{name}** is verwijderd.", configured: "Dit is de huidige configuratie:", company: "Bedrijf", name: "Naam", status: "Status", active: "Actief", inactive: "Inactief", industry: "Sector", website: "Website", languages: "Talen", brandTone: "Merktoon", description: "Bedrijfsbeschrijving", products: "Producten of diensten", agents: "Agententeam", mainAgent: "hoofdagent", noAgents: "Er zijn nog geen agenten toegevoegd.", notSpecified: "Niet opgegeven", openSettings: "Bedrijfsinstellingen openen →", nextStep: "**Volgende stap:** zal ik de rollen, instructies en modellen van deze agenten verder instellen?", incomplete: "De bedrijfswijziging kon niet worden voltooid omdat de actie onvolledig was. Probeer het opnieuw.", noAction: "De bedrijfswijziging kon niet worden voltooid. Het bedrijf en de agenten zijn niet gewijzigd. Verduidelijk het verzoek of probeer het opnieuw.", failed: "De bedrijfswijziging kon niet worden voltooid", partial: "Sommige wijzigingen zijn mogelijk opgeslagen. Controleer Instellingen > Bedrijf voordat u het opnieuw probeert.", unchanged: "Er zijn geen wijzigingen opgeslagen." },
  tr: { created: "Tamamlandı. **{name}** şirketini oluşturdum ve şirket ayarlarına kaydettim.", updated: "Tamamlandı. **{name}** şirketini güncelledim.", deleted: "Tamamlandı. **{name}** şirketi silindi.", configured: "Mevcut yapılandırma:", company: "Şirket", name: "Ad", status: "Durum", active: "Aktif", inactive: "Pasif", industry: "Sektör", website: "Web sitesi", languages: "Diller", brandTone: "Marka tonu", description: "Şirket açıklaması", products: "Ürünler veya hizmetler", agents: "Ajan ekibi", mainAgent: "ana ajan", noAgents: "Henüz ajan eklenmedi.", notSpecified: "Belirtilmedi", openSettings: "Şirket ayarlarını aç →", nextStep: "**Sonraki adım:** bu ajanların rollerini, talimatlarını ve modellerini ayrıntılı şekilde yapılandırmamı ister misiniz?", incomplete: "İşlem eksik olduğu için şirket değişikliği tamamlanamadı. Tekrar deneyin.", noAction: "Şirket değişikliği tamamlanamadı. Şirket veya ajanlarda değişiklik yapılmadı. İsteği netleştirin ya da tekrar deneyin.", failed: "Şirket değişikliği tamamlanamadı", partial: "Bazı değişiklikler kaydedilmiş olabilir. Tekrar denemeden önce Ayarlar > Şirket bölümünü kontrol edin.", unchanged: "Hiçbir değişiklik kaydedilmedi." },
  ru: { created: "Готово. Я создал компанию **{name}** и сохранил её в настройках.", updated: "Готово. Я обновил компанию **{name}**.", deleted: "Готово. Компания **{name}** удалена.", configured: "Текущая конфигурация:", company: "Компания", name: "Название", status: "Статус", active: "Активна", inactive: "Неактивна", industry: "Отрасль", website: "Сайт", languages: "Языки", brandTone: "Тон бренда", description: "Описание компании", products: "Продукты или услуги", agents: "Команда агентов", mainAgent: "главный агент", noAgents: "Агенты ещё не добавлены.", notSpecified: "Не указано", openSettings: "Открыть настройки компании →", nextStep: "**Следующий шаг:** хотите, чтобы я подробнее настроил роли, инструкции и модели этих агентов?", incomplete: "Не удалось выполнить изменение компании: действие было неполным. Попробуйте ещё раз.", noAction: "Не удалось выполнить изменение компании. Компания и агенты не были изменены. Уточните запрос или попробуйте ещё раз.", failed: "Не удалось выполнить изменение компании", partial: "Некоторые изменения могли сохраниться. Перед повторной попыткой проверьте Настройки > Компания.", unchanged: "Изменения не сохранены." },
  zh: { created: "已完成。我已创建 **{name}** 并将其保存到公司设置中。", updated: "已完成。我已更新 **{name}**。", deleted: "已完成。公司 **{name}** 已删除。", configured: "当前配置如下：", company: "公司", name: "名称", status: "状态", active: "启用", inactive: "停用", industry: "行业", website: "网站", languages: "语言", brandTone: "品牌语调", description: "公司简介", products: "产品或服务", agents: "智能体团队", mainAgent: "主智能体", noAgents: "尚未添加智能体。", notSpecified: "未指定", openSettings: "打开公司设置 →", nextStep: "**下一步：**需要我进一步配置这些智能体的角色、指令和模型吗？", incomplete: "操作不完整，因此无法完成公司变更。请重试。", noAction: "无法完成公司变更。公司和智能体均未更改。请明确请求或重试。", failed: "无法完成公司变更", partial: "部分更改可能已保存。重试前请检查“设置 > 公司”。", unchanged: "未保存任何更改。" },
  ja: { created: "完了しました。**{name}** を作成し、会社設定に保存しました。", updated: "完了しました。**{name}** を更新しました。", deleted: "完了しました。会社 **{name}** を削除しました。", configured: "現在の設定は次のとおりです：", company: "会社", name: "名前", status: "ステータス", active: "有効", inactive: "無効", industry: "業種", website: "ウェブサイト", languages: "言語", brandTone: "ブランドトーン", description: "会社概要", products: "製品またはサービス", agents: "エージェントチーム", mainAgent: "メインエージェント", noAgents: "エージェントはまだ追加されていません。", notSpecified: "未指定", openSettings: "会社設定を開く →", nextStep: "**次のステップ：**これらのエージェントの役割、指示、モデルをさらに設定しますか？", incomplete: "操作が不完全なため、会社の変更を完了できませんでした。もう一度お試しください。", noAction: "会社の変更を完了できませんでした。会社やエージェントは変更されていません。依頼を明確にして再度お試しください。", failed: "会社の変更を完了できませんでした", partial: "一部の変更が保存された可能性があります。再試行する前に「設定 > 会社」を確認してください。", unchanged: "変更は保存されていません。" },
  ko: { created: "완료했습니다. **{name}** 회사를 만들고 회사 설정에 저장했습니다.", updated: "완료했습니다. **{name}** 회사를 업데이트했습니다.", deleted: "완료했습니다. **{name}** 회사가 삭제되었습니다.", configured: "현재 구성은 다음과 같습니다:", company: "회사", name: "이름", status: "상태", active: "활성", inactive: "비활성", industry: "산업", website: "웹사이트", languages: "언어", brandTone: "브랜드 톤", description: "회사 설명", products: "제품 또는 서비스", agents: "에이전트 팀", mainAgent: "메인 에이전트", noAgents: "아직 에이전트가 추가되지 않았습니다.", notSpecified: "지정되지 않음", openSettings: "회사 설정 열기 →", nextStep: "**다음 단계:** 이 에이전트들의 역할, 지침, 모델을 더 자세히 설정할까요?", incomplete: "작업이 불완전하여 회사 변경을 완료할 수 없습니다. 다시 시도해 주세요.", noAction: "회사 변경을 완료할 수 없습니다. 회사와 에이전트는 변경되지 않았습니다. 요청을 명확히 하거나 다시 시도해 주세요.", failed: "회사 변경을 완료할 수 없습니다", partial: "일부 변경 사항이 저장되었을 수 있습니다. 다시 시도하기 전에 설정 > 회사를 확인하세요.", unchanged: "변경 사항이 저장되지 않았습니다." },
  ar: { created: "تم. أنشأت شركة **{name}** وحفظتها في إعدادات الشركة.", updated: "تم. حدّثت شركة **{name}**.", deleted: "تم حذف شركة **{name}**.", configured: "هذا هو الإعداد الحالي:", company: "الشركة", name: "الاسم", status: "الحالة", active: "نشطة", inactive: "غير نشطة", industry: "المجال", website: "الموقع الإلكتروني", languages: "اللغات", brandTone: "نبرة العلامة التجارية", description: "وصف الشركة", products: "المنتجات أو الخدمات", agents: "فريق الوكلاء", mainAgent: "الوكيل الرئيسي", noAgents: "لم تتم إضافة وكلاء بعد.", notSpecified: "غير محدد", openSettings: "فتح إعدادات الشركة ←", nextStep: "**الخطوة التالية:** هل تريد أن أضبط أدوار هؤلاء الوكلاء وتعليماتهم ونماذجهم بمزيد من التفصيل؟", incomplete: "تعذر إكمال تعديل الشركة لأن الإجراء غير مكتمل. حاول مرة أخرى.", noAction: "تعذر إكمال تعديل الشركة. لم يتم تغيير الشركة أو الوكلاء. وضّح الطلب أو حاول مرة أخرى.", failed: "تعذر إكمال تعديل الشركة", partial: "ربما تم حفظ بعض التغييرات. راجع الإعدادات > الشركة قبل المحاولة مرة أخرى.", unchanged: "لم يتم حفظ أي تغييرات." },
  hi: { created: "पूरा हुआ। मैंने **{name}** कंपनी बनाई और उसे कंपनी सेटिंग्स में सहेज दिया।", updated: "पूरा हुआ। मैंने **{name}** को अपडेट किया।", deleted: "पूरा हुआ। कंपनी **{name}** हटा दी गई।", configured: "वर्तमान कॉन्फ़िगरेशन यह है:", company: "कंपनी", name: "नाम", status: "स्थिति", active: "सक्रिय", inactive: "निष्क्रिय", industry: "उद्योग", website: "वेबसाइट", languages: "भाषाएँ", brandTone: "ब्रांड टोन", description: "कंपनी का विवरण", products: "उत्पाद या सेवाएँ", agents: "एजेंट टीम", mainAgent: "मुख्य एजेंट", noAgents: "अभी कोई एजेंट नहीं जोड़ा गया है।", notSpecified: "निर्दिष्ट नहीं", openSettings: "कंपनी सेटिंग्स खोलें →", nextStep: "**अगला कदम:** क्या आप चाहते हैं कि मैं इन एजेंटों की भूमिकाएँ, निर्देश और मॉडल अधिक विस्तार से सेट करूँ?", incomplete: "कार्रवाई अधूरी होने के कारण कंपनी परिवर्तन पूरा नहीं हो सका। फिर से प्रयास करें।", noAction: "कंपनी परिवर्तन पूरा नहीं हो सका। कंपनी या एजेंटों में कोई बदलाव नहीं किया गया। अनुरोध स्पष्ट करें या फिर से प्रयास करें।", failed: "कंपनी परिवर्तन पूरा नहीं हो सका", partial: "कुछ बदलाव सहेजे गए हो सकते हैं। फिर से प्रयास करने से पहले सेटिंग्स > कंपनी जाँचें।", unchanged: "कोई बदलाव सहेजा नहीं गया।" },
};

const latinSignals: Array<[CompanyChatLanguage, RegExp]> = [
  ["fr", /\b(?:crée|créer|entreprise|société|agents?|avec|supprime|modifier|mets à jour)\b/giu],
  ["de", /\b(?:erstelle|unternehmen|firma|agenten?|mit|lösche|ändere|aktualisiere)\b/giu],
  ["es", /\b(?:crea|crear|empresa|compañía|agentes?|con|elimina|modifica|actualiza)\b/giu],
  ["it", /\b(?:crea|creare|azienda|società|agenti?|con|elimina|modifica|aggiorna)\b/giu],
  ["pl", /\b(?:utwórz|stwórz|firma|firmę|spółkę|agentów|usuń|zmień|zaktualizuj)\b/giu],
  ["pt", /\b(?:crie|criar|empresa|companhia|agentes?|com|exclua|altere|atualize)\b/giu],
  ["nl", /\b(?:maak|bedrijf|onderneming|agenten?|met|verwijder|wijzig|werk bij)\b/giu],
  ["tr", /\b(?:oluştur|şirket|firma|ajanlar?|ile|sil|değiştir|güncelle)\b/giu],
];

export function detectCompanyChatLanguage(message = ""): CompanyChatLanguage {
  if (/[ぁ-ゟ゠-ヿ]/u.test(message)) return "ja";
  if (/[가-힣]/u.test(message)) return "ko";
  if (/\p{Script=Han}/u.test(message)) return "zh";
  if (/\p{Script=Arabic}/u.test(message)) return "ar";
  if (/\p{Script=Devanagari}/u.test(message)) return "hi";
  if (/\b(?:lösche|entferne|gerade\s+erstellt)\b/iu.test(message)) return "de";
  if (/\b(?:verwijder|zojuist\s+(?:hebt\s+)?gemaakt)\b/iu.test(message)) return "nl";
  if (/^(?:так|гаразд|добре|підтверджую)[\s,.!?]*$/iu.test(message.trim())) return "uk";
  if (/[іїєґ]/iu.test(message) || /\b(?:так|гаразд|добре|підтверджую|створи|створити|додай|видали|зміни|компанію|компанії|агента|агентів|мені|будь ласка|потрібно|хочу)\b/iu.test(message)) return "uk";
  if (/\p{Script=Cyrillic}/u.test(message)) return "ru";
  if (/[ąćęłńśźż]/iu.test(message)) return "pl";
  if (/[ğışİ]/u.test(message)) return "tr";
  if (/[ãõ]/iu.test(message)) return "pt";
  if (/ß/u.test(message)) return "de";
  let best: { language: CompanyChatLanguage; score: number } = { language: "en", score: 0 };
  for (const [language, pattern] of latinSignals) {
    pattern.lastIndex = 0;
    const score = [...message.matchAll(pattern)].length;
    if (score > best.score) best = { language, score };
  }
  return best.score >= 2 ? best.language : "en";
}

const companyManagementPatterns: RegExp[] = [
  /(?=.*(?:crée|créer|ajoute|ajouter|modifie|modifier|supprime|supprimer|configure|configurer))(?=.*(?:entreprise|société|agents?))/iu,
  /(?=.*(?:erstelle|erstellen|füge|ändere|aktualisiere|lösche|konfiguriere))(?=.*(?:unternehmen|firma|agenten?))/iu,
  /(?=.*(?:crea|crear|añade|agrega|modifica|actualiza|elimina|configura))(?=.*(?:empresa|compañía|agentes?))/iu,
  /(?=.*(?:crea|creare|aggiungi|modifica|aggiorna|elimina|configura))(?=.*(?:azienda|società|agenti?))/iu,
  /(?=.*(?:utwórz|stwórz|dodaj|zmień|zaktualizuj|usuń|skonfiguruj))(?=.*(?:firmę|firma|spółkę|agentów|agenta))/iu,
  /(?=.*(?:crie|criar|adicione|altere|atualize|exclua|configure))(?=.*(?:empresa|companhia|agentes?))/iu,
  /(?=.*(?:maak|voeg|wijzig|werk bij|verwijder|configureer))(?=.*(?:bedrijf|onderneming|agenten?))/iu,
  /(?=.*(?:oluştur|ekle|değiştir|güncelle|sil|yapılandır))(?=.*(?:şirket|firma|ajanlar?|ajanı))/iu,
  /(?=.*(?:создай|создать|добавь|измени|обнови|удали|настрой))(?=.*(?:компани|агент))/iu,
  /(?=.*(?:创建|新建|添加|修改|更新|删除|配置))(?=.*(?:公司|企业|智能体|代理))/u,
  /(?=.*(?:作成|追加|変更|更新|削除|設定))(?=.*(?:会社|企業|エージェント))/u,
  /(?=.*(?:만들|생성|추가|수정|업데이트|삭제|설정))(?=.*(?:회사|기업|에이전트))/u,
  /(?=.*(?:أنشئ|إنشاء|أضف|عدّل|حدّث|احذف|اضبط))(?=.*(?:شركة|مؤسسة|وكيل|وكلاء))/u,
  /(?=.*(?:बनाएँ|बनाओ|बनाना|जोड़ें|बदलें|अपडेट|हटाएँ|कॉन्फ़िगर))(?=.*(?:कंपनी|व्यवसाय|एजेंट))/u,
];

export function isLocalizedCompanyManagementRequest(message: string): boolean {
  return companyManagementPatterns.some((pattern) => pattern.test(message));
}

export function companyChatCopy(message = ""): CompanyChatCopy {
  return copy[detectCompanyChatLanguage(message)];
}

const languageNames: Record<CompanyChatLanguage, string> = {
  en: "English", uk: "Ukrainian", fr: "French", de: "German", es: "Spanish", it: "Italian", pl: "Polish", pt: "Portuguese",
  nl: "Dutch", tr: "Turkish", ru: "Russian", zh: "Simplified Chinese", ja: "Japanese", ko: "Korean", ar: "Arabic", hi: "Hindi",
};

export function chatLanguageInstruction(message = ""): string {
  const language = detectCompanyChatLanguage(message);
  return `\n\nMANDATORY RESPONSE LANGUAGE: The latest user message is detected as ${languageNames[language]} (${language}). Reply entirely in ${languageNames[language]}. This applies to normal prose, headings, interactive card titles and labels, summaries, follow-up questions, warnings, and limitation messages. Keep code, URLs, record IDs, model IDs, and quoted source text unchanged. If the user explicitly requests a different response language, follow that explicit request.`;
}

export function insertCompanyName(template: string, name: string): string {
  return template.replace("{name}", name);
}
