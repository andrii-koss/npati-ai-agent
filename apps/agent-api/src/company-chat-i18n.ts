import { detectCompanyChatLanguage, cyrillicFunctionWords, detectedLanguage, latinLanguageEvidence, normalizedLanguageText, type CompanyChatLanguage } from "@npati/shared";
export { detectCompanyChatLanguage, type CompanyChatLanguage } from "@npati/shared";

export type CompanyChatCopy = {
  created: string;
  updated: string;
  deleted: string;
  alreadyExists: string;
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
  en: { created: "Done. I created **{name}** and saved it in company settings.", updated: "Done. I updated **{name}**.", deleted: "Done. Company **{name}** was deleted.", alreadyExists: "Company **{name}** already exists. You can view or edit it in settings.", configured: "Here is the current configuration:", company: "Company", name: "Name", status: "Status", active: "Active", inactive: "Inactive", industry: "Industry", website: "Website", languages: "Languages", brandTone: "Brand tone", description: "Company description", products: "Products or services", agents: "Agent team", mainAgent: "main agent", noAgents: "No agents have been added yet.", notSpecified: "Not specified", openSettings: "Open company settings в†’", nextStep: "**Next step:** would you like me to refine the roles, instructions, and models for these agents?", incomplete: "I couldn't complete the company change because the action was incomplete. Please try again.", noAction: "I couldn't complete the company change. No company or agent changes were saved. Please clarify the request or try again.", failed: "I couldn't complete the company change", partial: "Some changes may have been saved. Review Settings > Company before retrying.", unchanged: "No changes were saved." },
  uk: { created: "Р“РѕС‚РѕРІРѕ, СЏ СЃС‚РІРѕСЂРёРІ РєРѕРјРїР°РЅС–СЋ **{name}** С– Р·Р±РµСЂС–Рі С—С— РІ РЅР°Р»Р°С€С‚СѓРІР°РЅРЅСЏС….", updated: "Р“РѕС‚РѕРІРѕ, СЏ РѕРЅРѕРІРёРІ РєРѕРјРїР°РЅС–СЋ **{name}**.", deleted: "Р“РѕС‚РѕРІРѕ, РєРѕРјРїР°РЅС–СЋ **{name}** РІРёРґР°Р»РµРЅРѕ.", alreadyExists: "РљРѕРјРїР°РЅС–СЏ **{name}** СѓР¶Рµ С–СЃРЅСѓС”. Р’Рё РјРѕР¶РµС‚Рµ РїРµСЂРµРіР»СЏРЅСѓС‚Рё Р°Р±Рѕ Р·РјС–РЅРёС‚Рё С—С— РІ РЅР°Р»Р°С€С‚СѓРІР°РЅРЅСЏС….", configured: "РћСЃСЊ С‰Рѕ Р·Р°СЂР°Р· РЅР°Р»Р°С€С‚РѕРІР°РЅРѕ:", company: "РљРѕРјРїР°РЅС–СЏ", name: "РќР°Р·РІР°", status: "РЎС‚Р°С‚СѓСЃ", active: "РђРєС‚РёРІРЅР°", inactive: "РќРµР°РєС‚РёРІРЅР°", industry: "Р“Р°Р»СѓР·СЊ", website: "Р’РµР±СЃР°Р№С‚", languages: "РњРѕРІРё", brandTone: "РўРѕРЅ Р±СЂРµРЅРґСѓ", description: "РћРїРёСЃ РєРѕРјРїР°РЅС–С—", products: "РџСЂРѕРґСѓРєС‚Рё Р°Р±Рѕ РїРѕСЃР»СѓРіРё", agents: "РљРѕРјР°РЅРґР° Р°РіРµРЅС‚С–РІ", mainAgent: "РіРѕР»РѕРІРЅРёР№ Р°РіРµРЅС‚", noAgents: "РђРіРµРЅС‚С–РІ С‰Рµ РЅРµ РґРѕРґР°РЅРѕ.", notSpecified: "РќРµ РІРєР°Р·Р°РЅРѕ", openSettings: "Р’С–РґРєСЂРёС‚Рё РЅР°Р»Р°С€С‚СѓРІР°РЅРЅСЏ РєРѕРјРїР°РЅС–С— в†’", nextStep: "**РќР°СЃС‚СѓРїРЅРёР№ РєСЂРѕРє:** С…РѕС‡РµС‚Рµ, С‰РѕР± СЏ РґРµС‚Р°Р»СЊРЅС–С€Рµ РЅР°Р»Р°С€С‚СѓРІР°РІ СЂРѕР»С–, С–РЅСЃС‚СЂСѓРєС†С–С— С‚Р° РјРѕРґРµР»С– РґР»СЏ С†РёС… Р°РіРµРЅС‚С–РІ?", incomplete: "РќРµ РІРґР°Р»РѕСЃСЏ РІРёРєРѕРЅР°С‚Рё Р·РјС–РЅСѓ РєРѕРјРїР°РЅС–С—, С‚РѕРјСѓ С‰Рѕ РєРѕРјР°РЅРґР° Р±СѓР»Р° РЅРµРїРѕРІРЅРѕСЋ. РЎРїСЂРѕР±СѓР№С‚Рµ С‰Рµ СЂР°Р·.", noAction: "РќРµ РІРґР°Р»РѕСЃСЏ РІРёРєРѕРЅР°С‚Рё Р·РјС–РЅСѓ РєРѕРјРїР°РЅС–С—. РљРѕРјРїР°РЅС–СЋ С‚Р° Р°РіРµРЅС‚С–РІ РЅРµ Р±СѓР»Рѕ Р·РјС–РЅРµРЅРѕ. РЈС‚РѕС‡РЅС–С‚СЊ Р·Р°РїРёС‚ Р°Р±Рѕ СЃРїСЂРѕР±СѓР№С‚Рµ С‰Рµ СЂР°Р·.", failed: "РќРµ РІРґР°Р»РѕСЃСЏ РІРёРєРѕРЅР°С‚Рё Р·РјС–РЅСѓ РєРѕРјРїР°РЅС–С—", partial: "Р§Р°СЃС‚РёРЅСѓ Р·РјС–РЅ РјРѕРіР»Рѕ Р±СѓС‚Рё Р·Р±РµСЂРµР¶РµРЅРѕ. РџРµСЂРµРІС–СЂС‚Рµ РќР°Р»Р°С€С‚СѓРІР°РЅРЅСЏ > РљРѕРјРїР°РЅС–СЏ РїРµСЂРµРґ РїРѕРІС‚РѕСЂРЅРѕСЋ СЃРїСЂРѕР±РѕСЋ.", unchanged: "Р—РјС–РЅРё РЅРµ Р·Р±РµСЂРµР¶РµРЅРѕ." },
  fr: { created: "TerminГ©. JвЂ™ai crГ©Г© lвЂ™entreprise **{name}** et lвЂ™ai enregistrГ©e dans les paramГЁtres.", updated: "TerminГ©. JвЂ™ai mis Г  jour lвЂ™entreprise **{name}**.", deleted: "TerminГ©. LвЂ™entreprise **{name}** a Г©tГ© supprimГ©e.", alreadyExists: "LвЂ™entreprise **{name}** existe dГ©jГ . Vous pouvez la consulter ou la modifier dans les paramГЁtres.", configured: "Voici la configuration actuelle :", company: "Entreprise", name: "Nom", status: "Statut", active: "Active", inactive: "Inactive", industry: "Secteur", website: "Site web", languages: "Langues", brandTone: "Ton de marque", description: "Description de lвЂ™entreprise", products: "Produits ou services", agents: "Г‰quipe dвЂ™agents", mainAgent: "agent principal", noAgents: "Aucun agent nвЂ™a encore Г©tГ© ajoutГ©.", notSpecified: "Non renseignГ©", openSettings: "Ouvrir les paramГЁtres de lвЂ™entreprise в†’", nextStep: "**Г‰tape suivante :** souhaitez-vous que je prГ©cise les rГґles, les instructions et les modГЁles de ces agents ?", incomplete: "Je nвЂ™ai pas pu effectuer la modification, car lвЂ™action Г©tait incomplГЁte. RГ©essayez.", noAction: "Je nвЂ™ai pas pu effectuer la modification. Aucune entreprise ni aucun agent nвЂ™a Г©tГ© modifiГ©. PrГ©cisez votre demande ou rГ©essayez.", failed: "Je nвЂ™ai pas pu effectuer la modification de lвЂ™entreprise", partial: "Certaines modifications ont peut-ГЄtre Г©tГ© enregistrГ©es. VГ©rifiez ParamГЁtres > Entreprise avant de rГ©essayer.", unchanged: "Aucune modification nвЂ™a Г©tГ© enregistrГ©e." },
  de: { created: "Erledigt. Ich habe **{name}** erstellt und in den Unternehmenseinstellungen gespeichert.", updated: "Erledigt. Ich habe **{name}** aktualisiert.", deleted: "Erledigt. Das Unternehmen **{name}** wurde gelГ¶scht.", alreadyExists: "Das Unternehmen **{name}** existiert bereits. Sie kГ¶nnen es in den Einstellungen anzeigen oder bearbeiten.", configured: "Das ist die aktuelle Konfiguration:", company: "Unternehmen", name: "Name", status: "Status", active: "Aktiv", inactive: "Inaktiv", industry: "Branche", website: "Website", languages: "Sprachen", brandTone: "Markenton", description: "Unternehmensbeschreibung", products: "Produkte oder Dienstleistungen", agents: "Agententeam", mainAgent: "Hauptagent", noAgents: "Es wurden noch keine Agenten hinzugefГјgt.", notSpecified: "Nicht angegeben", openSettings: "Unternehmenseinstellungen Г¶ffnen в†’", nextStep: "**NГ¤chster Schritt:** Soll ich die Rollen, Anweisungen und Modelle dieser Agenten genauer konfigurieren?", incomplete: "Die UnternehmensГ¤nderung konnte nicht abgeschlossen werden, weil die Aktion unvollstГ¤ndig war. Bitte erneut versuchen.", noAction: "Die UnternehmensГ¤nderung konnte nicht abgeschlossen werden. Unternehmen und Agenten wurden nicht geГ¤ndert. Bitte die Anfrage prГ¤zisieren oder erneut versuchen.", failed: "Die UnternehmensГ¤nderung konnte nicht abgeschlossen werden", partial: "Einige Г„nderungen wurden mГ¶glicherweise gespeichert. PrГјfen Sie Einstellungen > Unternehmen, bevor Sie es erneut versuchen.", unchanged: "Es wurden keine Г„nderungen gespeichert." },
  es: { created: "Listo. He creado **{name}** y la he guardado en la configuraciГіn de la empresa.", updated: "Listo. He actualizado **{name}**.", deleted: "Listo. La empresa **{name}** ha sido eliminada.", alreadyExists: "La empresa **{name}** ya existe. Puedes verla o editarla en la configuraciГіn.", configured: "Esta es la configuraciГіn actual:", company: "Empresa", name: "Nombre", status: "Estado", active: "Activa", inactive: "Inactiva", industry: "Sector", website: "Sitio web", languages: "Idiomas", brandTone: "Tono de marca", description: "DescripciГіn de la empresa", products: "Productos o servicios", agents: "Equipo de agentes", mainAgent: "agente principal", noAgents: "TodavГ­a no se han aГ±adido agentes.", notSpecified: "No especificado", openSettings: "Abrir la configuraciГіn de la empresa в†’", nextStep: "**Siguiente paso:** Вїquieres que configure con mГЎs detalle los roles, las instrucciones y los modelos de estos agentes?", incomplete: "No pude completar el cambio porque la acciГіn estaba incompleta. IntГ©ntalo de nuevo.", noAction: "No pude completar el cambio. No se modificГі ninguna empresa ni agente. Aclara la solicitud o intГ©ntalo de nuevo.", failed: "No pude completar el cambio de la empresa", partial: "Es posible que se hayan guardado algunos cambios. Revisa ConfiguraciГіn > Empresa antes de volver a intentarlo.", unchanged: "No se guardГі ningГєn cambio." },
  it: { created: "Fatto. Ho creato **{name}** e lвЂ™ho salvata nelle impostazioni dellвЂ™azienda.", updated: "Fatto. Ho aggiornato **{name}**.", deleted: "Fatto. LвЂ™azienda **{name}** ГЁ stata eliminata.", alreadyExists: "LвЂ™azienda **{name}** esiste giГ . Puoi visualizzarla o modificarla nelle impostazioni.", configured: "Ecco la configurazione attuale:", company: "Azienda", name: "Nome", status: "Stato", active: "Attiva", inactive: "Inattiva", industry: "Settore", website: "Sito web", languages: "Lingue", brandTone: "Tono del brand", description: "Descrizione dellвЂ™azienda", products: "Prodotti o servizi", agents: "Team di agenti", mainAgent: "agente principale", noAgents: "Non sono ancora stati aggiunti agenti.", notSpecified: "Non specificato", openSettings: "Apri le impostazioni dellвЂ™azienda в†’", nextStep: "**Passaggio successivo:** vuoi che configuri meglio ruoli, istruzioni e modelli di questi agenti?", incomplete: "Non ho potuto completare la modifica perchГ© lвЂ™azione era incompleta. Riprova.", noAction: "Non ho potuto completare la modifica. Nessuna azienda o agente ГЁ stato modificato. Specifica meglio la richiesta o riprova.", failed: "Non ho potuto completare la modifica dellвЂ™azienda", partial: "Alcune modifiche potrebbero essere state salvate. Controlla Impostazioni > Azienda prima di riprovare.", unchanged: "Nessuna modifica ГЁ stata salvata." },
  pl: { created: "Gotowe. UtworzyЕ‚em firmД™ **{name}** i zapisaЕ‚em jД… w ustawieniach.", updated: "Gotowe. ZaktualizowaЕ‚em firmД™ **{name}**.", deleted: "Gotowe. Firma **{name}** zostaЕ‚a usuniД™ta.", alreadyExists: "Firma **{name}** juЕј istnieje. MoЕјesz jД… przejrzeД‡ lub edytowaД‡ w ustawieniach.", configured: "Oto bieЕјД…ca konfiguracja:", company: "Firma", name: "Nazwa", status: "Status", active: "Aktywna", inactive: "Nieaktywna", industry: "BranЕјa", website: "Strona internetowa", languages: "JД™zyki", brandTone: "Ton marki", description: "Opis firmy", products: "Produkty lub usЕ‚ugi", agents: "ZespГіЕ‚ agentГіw", mainAgent: "gЕ‚Гіwny agent", noAgents: "Nie dodano jeszcze agentГіw.", notSpecified: "Nie podano", openSettings: "OtwГіrz ustawienia firmy в†’", nextStep: "**NastД™pny krok:** czy mam dokЕ‚adniej skonfigurowaД‡ role, instrukcje i modele tych agentГіw?", incomplete: "Nie udaЕ‚o siД™ zakoЕ„czyД‡ zmiany, poniewaЕј akcja byЕ‚a niekompletna. SprГіbuj ponownie.", noAction: "Nie udaЕ‚o siД™ wykonaД‡ zmiany. Firma ani agenci nie zostali zmienieni. Doprecyzuj proЕ›bД™ lub sprГіbuj ponownie.", failed: "Nie udaЕ‚o siД™ wykonaД‡ zmiany firmy", partial: "NiektГіre zmiany mogЕ‚y zostaД‡ zapisane. Przed ponownД… prГіbД… sprawdЕє Ustawienia > Firma.", unchanged: "Nie zapisano Ејadnych zmian." },
  pt: { created: "ConcluГ­do. Criei **{name}** e salvei nas configuraГ§Гµes da empresa.", updated: "ConcluГ­do. Atualizei **{name}**.", deleted: "ConcluГ­do. A empresa **{name}** foi excluГ­da.", alreadyExists: "A empresa **{name}** jГЎ existe. VocГЄ pode visualizГЎ-la ou editГЎ-la nas configuraГ§Гµes.", configured: "Esta Г© a configuraГ§ГЈo atual:", company: "Empresa", name: "Nome", status: "Status", active: "Ativa", inactive: "Inativa", industry: "Setor", website: "Site", languages: "Idiomas", brandTone: "Tom da marca", description: "DescriГ§ГЈo da empresa", products: "Produtos ou serviГ§os", agents: "Equipe de agentes", mainAgent: "agente principal", noAgents: "Nenhum agente foi adicionado ainda.", notSpecified: "NГЈo informado", openSettings: "Abrir configuraГ§Гµes da empresa в†’", nextStep: "**PrГіximo passo:** quer que eu detalhe as funГ§Гµes, instruГ§Гµes e modelos desses agentes?", incomplete: "NГЈo consegui concluir a alteraГ§ГЈo porque a aГ§ГЈo estava incompleta. Tente novamente.", noAction: "NГЈo consegui concluir a alteraГ§ГЈo. Nenhuma empresa ou agente foi modificado. EsclareГ§a o pedido ou tente novamente.", failed: "NГЈo consegui concluir a alteraГ§ГЈo da empresa", partial: "Algumas alteraГ§Гµes podem ter sido salvas. Verifique ConfiguraГ§Гµes > Empresa antes de tentar novamente.", unchanged: "Nenhuma alteraГ§ГЈo foi salva." },
  nl: { created: "Klaar. Ik heb **{name}** aangemaakt en opgeslagen in de bedrijfsinstellingen.", updated: "Klaar. Ik heb **{name}** bijgewerkt.", deleted: "Klaar. Bedrijf **{name}** is verwijderd.", alreadyExists: "Bedrijf **{name}** bestaat al. U kunt het bekijken of bewerken in de instellingen.", configured: "Dit is de huidige configuratie:", company: "Bedrijf", name: "Naam", status: "Status", active: "Actief", inactive: "Inactief", industry: "Sector", website: "Website", languages: "Talen", brandTone: "Merktoon", description: "Bedrijfsbeschrijving", products: "Producten of diensten", agents: "Agententeam", mainAgent: "hoofdagent", noAgents: "Er zijn nog geen agenten toegevoegd.", notSpecified: "Niet opgegeven", openSettings: "Bedrijfsinstellingen openen в†’", nextStep: "**Volgende stap:** zal ik de rollen, instructies en modellen van deze agenten verder instellen?", incomplete: "De bedrijfswijziging kon niet worden voltooid omdat de actie onvolledig was. Probeer het opnieuw.", noAction: "De bedrijfswijziging kon niet worden voltooid. Het bedrijf en de agenten zijn niet gewijzigd. Verduidelijk het verzoek of probeer het opnieuw.", failed: "De bedrijfswijziging konдёЌж–­ Р·Р°РІРµСЂС€РµРЅР°", partial: "Sommige wijzigingen zijn mogelijk opgeslagen. Controleer Instellingen > Bedrijf voordat u het opnieuw probeert.", unchanged: "Er zijn geen wijzigingen opgeslagen." },
  tr: { created: "TamamlandД±. **{name}** Еџirketini oluЕџturdum ve Еџirket ayarlarД±na kaydettim.", updated: "TamamlandД±. **{name}** Еџirketini gГјncelledim.", deleted: "TamamlandД±. **{name}** Еџirketi silindi.", alreadyExists: "**{name}** Еџirketi zaten mevcut. Ayarlardan gГ¶rГјntГјleyebilir veya dГјzenleyebilirsiniz.", configured: "Mevcut yapД±landД±rma:", company: "Ећirket", name: "Ad", status: "Durum", active: "Aktif", inactive: "Pasif", industry: "SektГ¶r", website: "Web sitesi", languages: "Diller", brandTone: "Marka tonu", description: "Ећirket aГ§Д±klamasД±", products: "ГњrГјnler veya hizmetler", agents: "Ajan ekibi", mainAgent: "ana ajan", noAgents: "HenГјz ajan eklenmedi.", notSpecified: "Belirtilmedi", openSettings: "Ећirket ayarlarД±nД± aГ§ в†’", nextStep: "**Sonraki adД±m:** bu ajanlarД±n rollerini, talimatlarД±nД± ve modellerini ayrД±ntД±lД± Еџekilde yapД±landД±rmamД± ister misiniz?", incomplete: "Д°Еџlem eksik olduДџu iГ§in Еџirket deДџiЕџikliДџi tamamlanamadД±. Tekrar deneyin.", noAction: "Ећirket deДџiЕџikliДџi tamamlanamadД±. Ећirket veya ajanlarda deДџiЕџiklik yapД±lmadД±. Д°steДџi netleЕџtirin ya da tekrar deneyin.", failed: "Ећirket deДџiЕџikliДџi tamamlanamadД±", partial: "BazД± deДџiЕџiklikler kaydedilmiЕџ olabilir. Tekrar denemeden Г¶nce Ayarlar > Ећirket bГ¶lГјmГјnГј kontrol edin.", unchanged: "HiГ§bir deДџiЕџiklik kaydedilmedi." },
  ru: { created: "Р“РѕС‚РѕРІРѕ. РЇ СЃРѕР·РґР°Р» РєРѕРјРїР°РЅРёСЋ **{name}** Рё СЃРѕС…СЂР°РЅРёР» РµС‘ РІ РЅР°СЃС‚СЂРѕР№РєР°С….", updated: "Р“РѕС‚РѕРІРѕ. РЇ РѕР±РЅРѕРІРёР» РєРѕРјРїР°РЅРёСЋ **{name}**.", deleted: "Р“РѕС‚РѕРІРѕ. РљРѕРјРїР°РЅРёСЏ **{name}** СѓРґР°Р»РµРЅР°.", alreadyExists: "РљРѕРјРїР°РЅРёСЏ **{name}** СѓР¶Рµ СЃСѓС‰РµСЃС‚РІСѓРµС‚. Р’С‹ РјРѕР¶РµС‚Рµ РїСЂРѕСЃРјРѕС‚СЂРµС‚СЊ РёР»Рё РёР·РјРµРЅРёС‚СЊ РµС‘ РІ РЅР°СЃС‚СЂРѕР№РєР°С….", configured: "РўРµРєСѓС‰Р°СЏ РєРѕРЅС„РёРіСѓСЂР°С†РёСЏ:", company: "РљРѕРјРїР°РЅРёСЏ", name: "РќР°Р·РІР°РЅРёРµ", status: "РЎС‚Р°С‚СѓСЃ", active: "РђРєС‚РёРІРЅР°", inactive: "РќРµР°РєС‚РёРІРЅР°", industry: "РћС‚СЂР°СЃР»СЊ", website: "РЎР°Р№С‚", languages: "РЇР·С‹РєРё", brandTone: "РўРѕРЅ Р±СЂРµРЅРґР°", description: "РћРїРёСЃР°РЅРёРµ РєРѕРјРїР°РЅРёРё", products: "РџСЂРѕРґСѓРєС‚С‹ РёР»Рё СѓСЃР»СѓРіРё", agents: "РљРѕРјР°РЅРґР° Р°РіРµРЅС‚РѕРІ", mainAgent: "РіР»Р°РІРЅС‹Р№ Р°РіРµРЅС‚", noAgents: "РђРіРµРЅС‚С‹ РµС‰С‘ РЅРµ РґРѕР±Р°РІР»РµРЅС‹.", notSpecified: "РќРµ СѓРєР°Р·Р°РЅРѕ", openSettings: "РћС‚РєСЂС‹С‚СЊ РЅР°СЃС‚СЂРѕР№РєРё РєРѕРјРїР°РЅРёРё в†’", nextStep: "**РЎР»РµРґСѓСЋС‰РёР№ С€Р°Рі:** С…РѕС‚РёС‚Рµ, С‡С‚РѕР±С‹ СЏ РїРѕРґСЂРѕР±РЅРµРµ РЅР°СЃС‚СЂРѕРёР» СЂРѕР»Рё, РёРЅСЃС‚СЂСѓРєС†РёРё Рё РјРѕРґРµР»Рё СЌС‚РёС… Р°РіРµРЅС‚РѕРІ?", incomplete: "РќРµ СѓРґР°Р»РѕСЃСЊ РІС‹РїРѕР»РЅРёС‚СЊ РёР·РјРµРЅРµРЅРёРµ РєРѕРјРїР°РЅРёРё: РґРµР№СЃС‚РІРёРµ Р±С‹Р»Рѕ РЅРµРїРѕР»РЅС‹Рј. РџРѕРїСЂРѕР±СѓР№С‚Рµ РµС‰С‘ СЂР°Р·.", noAction: "РќРµ СѓРґР°Р»РѕСЃСЊ РІС‹РїРѕР»РЅРёС‚СЊ РёР·РјРµРЅРµРЅРёРµ РєРѕРјРїР°РЅРёРё. РљРѕРјРїР°РЅРёСЏ Рё Р°РіРµРЅС‚С‹ РЅРµ Р±С‹Р»Рё РёР·РјРµРЅРµРЅС‹. РЈС‚РѕС‡РЅРёС‚Рµ Р·Р°РїСЂРѕСЃ РёР»Рё РїРѕРїСЂРѕР±СѓР№С‚Рµ РµС‰С‘ СЂР°Р·.", failed: "РќРµ СѓРґР°Р»РѕСЃСЊ РІС‹РїРѕР»РЅРёС‚СЊ РёР·РјРµРЅРµРЅРёРµ РєРѕРјРїР°РЅРёРё", partial: "РќРµРєРѕС‚РѕСЂС‹Рµ РёР·РјРµРЅРµРЅРёСЏ РјРѕРіР»Рё СЃРѕС…СЂР°РЅРёС‚СЊСЃСЏ. РџРµСЂРµРґ РїРѕРІС‚РѕСЂРЅРѕР№ РїРѕРїС‹С‚РєРѕР№ РїСЂРѕРІРµСЂСЊС‚Рµ РќР°СЃС‚СЂРѕР№РєРё > РљРѕРјРїР°РЅРёСЏ.", unchanged: "РР·РјРµРЅРµРЅРёСЏ РЅРµ СЃРѕС…СЂР°РЅРµРЅС‹." },
  zh: { created: "е·Іе®Њж€ђгЂ‚ж€‘е·Іе€›е»є **{name}** е№¶е°†е…¶дїќе­е€°е…¬еЏёи®ѕзЅ®дё­гЂ‚", updated: "е·Іе®Њж€ђгЂ‚ж€‘е·Іж›ґж–° **{name}**гЂ‚", deleted: "е·Іе®Њж€ђгЂ‚е…¬еЏё **{name}** е·Іе€ й™¤гЂ‚", alreadyExists: "е…¬еЏё **{name}** е·Іе­ењЁгЂ‚ж‚ЁеЏЇд»ҐењЁи®ѕзЅ®дё­жџҐзњ‹ж€–зј–иѕ‘е®ѓгЂ‚", configured: "еЅ“е‰Ќй…ЌзЅ®е¦‚дё‹пјљ", company: "е…¬еЏё", name: "еђЌз§°", status: "зЉ¶жЂЃ", active: "еђЇз”Ё", inactive: "еЃњз”Ё", industry: "иЎЊдёљ", website: "зЅ‘з«™", languages: "иЇ­иЁЂ", brandTone: "е“Ѓз‰ЊиЇ­и°ѓ", description: "е…¬еЏёз®Ђд»‹", products: "дє§е“Ѓж€–жњЌеЉЎ", agents: "ж™єиѓЅдЅ“е›ўйџ", mainAgent: "дё»ж™єиѓЅдЅ“", noAgents: "е°љжњЄж·»еЉ ж™єиѓЅдЅ“гЂ‚", notSpecified: "жњЄжЊ‡е®љ", openSettings: "ж‰“ејЂе…¬еЏёи®ѕзЅ® в†’", nextStep: "**дё‹дёЂж­Ґпјљ**йњЂи¦Ѓж€‘иї›дёЂж­Ґй…ЌзЅ®иї™дє›ж™єиѓЅдЅ“зљ„и§’и‰ІгЂЃжЊ‡д»¤е’ЊжЁЎећ‹еђ—пјџ", incomplete: "ж“ЌдЅњдёЌе®Њж•ґпјЊе› ж­¤ж— жі•е®Њж€ђе…¬еЏёеЏж›ґгЂ‚иЇ·й‡ЌиЇ•гЂ‚", noAction: "ж— жі•е®Њж€ђе…¬еЏёеЏж›ґгЂ‚е…¬еЏёе’Њж™єиѓЅдЅ“еќ‡жњЄж›ґж”№гЂ‚иЇ·жЋзЎ®иЇ·ж±‚ж€–й‡ЌиЇ•гЂ‚", failed: "ж— жі•е®Њж€ђе…¬еЏёеЏж›ґ", partial: "йѓЁе€†ж›ґж”№еЏЇиѓЅе·Ідїќе­гЂ‚й‡ЌиЇ•е‰ЌиЇ·жЈЂжџҐвЂњи®ѕзЅ® > е…¬еЏёвЂќгЂ‚", unchanged: "жњЄдїќе­д»»дЅ•ж›ґж”№гЂ‚" },
  ja: { created: "е®Њдє†гЃ—гЃѕгЃ—гЃџгЂ‚**{name}** г‚’дЅњж€ђгЃ—гЂЃдјљз¤ѕиЁ­е®љгЃ«дїќе­гЃ—гЃѕгЃ—гЃџгЂ‚", updated: "е®Њдє†гЃ—гЃѕгЃ—гЃџгЂ‚**{name}** г‚’ж›ґж–°гЃ—гЃѕгЃ—гЃџгЂ‚", deleted: "е®Њдє†гЃ—гЃѕгЃ—гЃџгЂ‚дјљз¤ѕ **{name}** г‚’е‰Љй™¤гЃ—гЃѕгЃ—гЃџгЂ‚", alreadyExists: "дјљз¤ѕ **{name}** гЃЇж—ўгЃ«е­ењЁгЃ—гЃѕгЃ™гЂ‚иЁ­е®љгЃ‹г‚‰зўєиЄЌгЃѕгЃџгЃЇз·Ёй›†гЃ§гЃЌгЃѕгЃ™гЂ‚", configured: "зЏѕењЁгЃ®иЁ­е®љгЃЇж¬ЎгЃ®гЃЁгЃЉг‚ЉгЃ§гЃ™пјљ", company: "дјљз¤ѕ", name: "еђЌе‰Ќ", status: "г‚№гѓ†гѓјг‚їг‚№", active: "жњ‰еЉ№", inactive: "з„ЎеЉ№", industry: "жҐ­зЁ®", website: "г‚¦г‚§гѓ–г‚µг‚¤гѓ€", languages: "иЁЂиЄћ", brandTone: "гѓ–гѓ©гѓігѓ‰гѓ€гѓјгѓі", description: "дјљз¤ѕж¦‚и¦Ѓ", products: "иЈЅе“ЃгЃѕгЃџгЃЇг‚µгѓјгѓ“г‚№", agents: "г‚Ёгѓјг‚ёг‚§гѓігѓ€гѓЃгѓјгѓ ", mainAgent: "гѓЎг‚¤гѓіг‚Ёгѓјг‚ёг‚§гѓігѓ€", noAgents: "г‚Ёгѓјг‚ёг‚§гѓігѓ€гЃЇгЃѕгЃ иїЅеЉ гЃ•г‚ЊгЃ¦гЃ„гЃѕгЃ›г‚“гЂ‚", notSpecified: "жњЄжЊ‡е®љ", openSettings: "дјљз¤ѕиЁ­е®љг‚’й–‹гЃЏ в†’", nextStep: "**ж¬ЎгЃ®г‚№гѓ†гѓѓгѓ—пјљ**гЃ“г‚Њг‚‰гЃ®г‚Ёгѓјг‚ёг‚§гѓігѓ€гЃ®еЅ№е‰ІгЂЃжЊ‡з¤єгЂЃгѓўгѓ‡гѓ«г‚’гЃ•г‚‰гЃ«иЁ­е®љгЃ—гЃѕгЃ™гЃ‹пјџ", incomplete: "ж“ЌдЅњгЃЊдёЌе®Ње…ЁгЃЄгЃџг‚ЃгЂЃдјљз¤ѕгЃ®е¤‰ж›ґг‚’е®Њдє†гЃ§гЃЌгЃѕгЃ›г‚“гЃ§гЃ—гЃџгЂ‚г‚‚гЃ†дёЂеє¦гЃЉи©¦гЃ—гЃЏгЃ гЃ•гЃ„гЂ‚", noAction: "дјљз¤ѕгЃ®е¤‰ж›ґг‚’е®Њдє†гЃ§гЃЌгЃѕгЃ›г‚“гЃ§гЃ—гЃџгЂ‚дјљз¤ѕг‚„г‚Ёгѓјг‚ёг‚§гѓігѓ€гЃЇе¤‰ж›ґгЃ•г‚ЊгЃ¦гЃ„гЃѕгЃ›г‚“гЂ‚дѕќй јг‚’жЋзўєгЃ«гЃ—гЃ¦е†Ќеє¦гЃЉи©¦гЃ—гЃЏгЃ гЃ•гЃ„гЂ‚", failed: "дјљз¤ѕгЃ®е¤‰ж›ґг‚’е®Њдє†гЃ§гЃЌгЃѕгЃ›г‚“гЃ§гЃ—гЃџ", partial: "дёЂйѓЁгЃ®е¤‰ж›ґгЃЊдїќе­гЃ•г‚ЊгЃџеЏЇиѓЅжЂ§гЃЊгЃ‚г‚ЉгЃѕгЃ™гЂ‚е†Ќи©¦иЎЊгЃ™г‚‹е‰ЌгЃ«гЂЊиЁ­е®љ > дјљз¤ѕгЂЌг‚’зўєиЄЌгЃ—гЃ¦гЃЏгЃ гЃ•гЃ„гЂ‚", unchanged: "е¤‰ж›ґгЃЇдїќе­гЃ•г‚ЊгЃ¦гЃ„гЃѕгЃ›г‚“гЂ‚" },
  ko: { created: "м™„лЈЊн–€мЉµл‹€л‹¤. **{name}** нљЊм‚¬лҐј л§Њл“¤кі  нљЊм‚¬ м„¤м •м—ђ м ЂмћҐн–€мЉµл‹€л‹¤.", updated: "м™„лЈЊн–€мЉµл‹€л‹¤. **{name}** нљЊм‚¬лҐј м—…лЌ°мќґнЉён–€мЉµл‹€л‹¤.", deleted: "м™„лЈЊн–€мЉµл‹€л‹¤. **{name}** нљЊм‚¬к°Ђ м‚­м њлђм—€мЉµл‹€л‹¤.", alreadyExists: "**{name}** нљЊм‚¬к°Ђ мќґлЇё мЎґмћ¬н•©л‹€л‹¤. м„¤м •м—ђм„њ н™•мќён•к±°л‚ м€м •н•  м€ мћ€мЉµл‹€л‹¤гЂ‚", configured: "н„мћ¬ кµ¬м„±мќЂ л‹¤мќЊкіј к°™мЉµл‹€л‹¤:", company: "нљЊм‚¬", name: "мќґл¦„", status: "мѓЃнѓњ", active: "н™њм„±", inactive: "л№„н™њм„±", industry: "м‚°м—…", website: "м›№м‚¬мќґнЉё", languages: "м–ём–ґ", brandTone: "лёЊлћњл“њ н†¤", description: "нљЊм‚¬ м„¤лЄ…", products: "м њн’€ лђлЉ” м„њл№„мЉ¤", agents: "м—ђмќґм „нЉё нЊЂ", mainAgent: "л©”мќё м—ђмќґм „нЉё", noAgents: "м•„м§Ѓ м—ђмќґм „нЉёк°Ђ м¶”к°Ђлђм§Ђ м•Љм•мЉµл‹€л‹¤.", notSpecified: "м§Ђм •лђм§Ђ м•ЉмќЊ", openSettings: "нљЊм‚¬ м„¤м • м—ґкё° в†’", nextStep: "**л‹¤мќЊ л‹Ёкі„:** мќґ м—ђмќґм „нЉёл“¤мќ м—­н• , м§Ђм№Ё, лЄЁлЌёмќ„ лЌ” мћђм„ёнћ€ м„¤м •н• к№Њмљ”?", incomplete: "мћ‘м—…мќґ л¶€м™„м „н•м—¬ нљЊм‚¬ ліЂкІЅмќ„ м™„лЈЊн•  м€ м—†мЉµл‹€л‹¤. л‹¤м‹њ м‹њлЏ„н•ґ мЈјм„ёмљ”.", noAction: "нљЊм‚¬ ліЂкІЅмќ„ м™„лЈЊн•  м€ м—†мЉµл‹€л‹¤. нљЊм‚¬м™Ђ м—ђмќґм „нЉёлЉ” ліЂкІЅлђм§Ђ м•Љм•мЉµл‹€л‹¤. мљ”мІ­мќ„ лЄ…н™•нћ€ н•к±°л‚ л‹¤м‹њ м‹њлЏ„н•ґ мЈјм„ёмљ”.", failed: "нљЊм‚¬ ліЂкІЅмќ„ м™„лЈЊн•  м€ м—†мЉµл‹€л‹¤", partial: "мќјл¶Ђ ліЂкІЅ м‚¬н•­мќґ м ЂмћҐлђм—€мќ„ м€ мћ€мЉµл‹€л‹¤. л‹¤м‹њ м‹њлЏ„н•кё° м „м—ђ м„¤м • > нљЊм‚¬лҐј н™•мќён•м„ёмљ”.", unchanged: "ліЂкІЅ м‚¬н•­мќґ м ЂмћҐлђм§Ђ м•Љм•мЉµл‹€л‹¤." },
  ar: { created: "ШЄЩ…. ШЈЩ†ШґШЈШЄ ШґШ±ЩѓШ© **{name}** Щ€Ш­ЩЃШёШЄЩ‡Ш§ ЩЃЩЉ ШҐШ№ШЇШ§ШЇШ§ШЄ Ш§Щ„ШґШ±ЩѓШ©.", updated: "ШЄЩ…. Ш­ШЇЩ‘Ш«ШЄ ШґШ±ЩѓШ© **{name}**.", deleted: "ШЄЩ… Ш­Ш°ЩЃ ШґШ±ЩѓШ© **{name}**.", alreadyExists: "Ш§Щ„ШґШ±ЩѓШ© **{name}** Щ…Щ€Ш¬Щ€ШЇШ© ШЁШ§Щ„ЩЃШ№Щ„. ЩЉЩ…ЩѓЩ†Щѓ Ш№Ш±Ш¶Щ‡Ш§ ШЈЩ€ ШЄШ№ШЇЩЉЩ„Щ‡Ш§ ЩЃЩЉ Ш§Щ„ШҐШ№ШЇШ§ШЇШ§ШЄ.", configured: "Щ‡Ш°Ш§ Щ‡Щ€ Ш§Щ„ШҐШ№ШЇШ§ШЇ Ш§Щ„Ш­Ш§Щ„ЩЉ:", company: "Ш§Щ„ШґШ±ЩѓШ©", name: "Ш§Щ„Ш§ШіЩ…", status: "Ш§Щ„Ш­Ш§Щ„Ш©", active: "Щ†ШґШ·Ш©", inactive: "ШєЩЉШ± Щ†ШґШ·Ш©", industry: "Ш§Щ„Щ…Ш¬Ш§Щ„", website: "Ш§Щ„Щ…Щ€Щ‚Ш№ Ш§Щ„ШҐЩ„ЩѓШЄШ±Щ€Щ†ЩЉ", languages: "Ш§Щ„Щ„ШєШ§ШЄ", brandTone: "Щ†ШЁШ±Ш© Ш§Щ„Ш№Щ„Ш§Щ…Ш© Ш§Щ„ШЄШ¬Ш§Ш±ЩЉШ©", description: "Щ€ШµЩЃ Ш§Щ„ШґШ±ЩѓШ©", products: "Ш§Щ„Щ…Щ†ШЄШ¬Ш§ШЄ ШЈЩ€ Ш§Щ„Ш®ШЇЩ…Ш§ШЄ", agents: "ЩЃШ±ЩЉЩ‚ Ш§Щ„Щ€ЩѓЩ„Ш§ШЎ", mainAgent: "Ш§Щ„Щ€ЩѓЩЉЩ„ Ш§Щ„Ш±Ш¦ЩЉШіЩЉ", noAgents: "Щ„Щ… ШЄШЄЩ… ШҐШ¶Ш§ЩЃШ© Щ€ЩѓЩ„Ш§ШЎ ШЁШ№ШЇ.", notSpecified: "ШєЩЉШ± Щ…Ш­ШЇШЇ", openSettings: "ЩЃШЄШ­ ШҐШ№ШЇШ§ШЇШ§ШЄ Ш§Щ„ШґШ±ЩѓШ© в†ђ", nextStep: "**Ш§Щ„Ш®Ш·Щ€Ш© Ш§Щ„ШЄШ§Щ„ЩЉШ©:** Щ‡Щ„ ШЄШ±ЩЉШЇ ШЈЩ† ШЈШ¶ШЁШ· ШЈШЇЩ€Ш§Ш± Щ‡Ш¤Щ„Ш§ШЎ Ш§Щ„Щ€ЩѓЩ„Ш§ШЎ Щ€ШЄШ№Щ„ЩЉЩ…Ш§ШЄЩ‡Щ… Щ€Щ†Щ…Ш§Ш°Ш¬Щ‡Щ… ШЁЩ…ШІЩЉШЇ Щ…Щ† Ш§Щ„ШЄЩЃШµЩЉЩ„Шџ", incomplete: "ШЄШ№Ш°Ш± ШҐЩѓЩ…Ш§Щ„ ШЄШ№ШЇЩЉЩ„ Ш§Щ„ШґШ±ЩѓШ© Щ„ШЈЩ† Ш§Щ„ШҐШ¬Ш±Ш§ШЎ ШєЩЉШ± Щ…ЩѓШЄЩ…Щ„. Ш­Ш§Щ€Щ„ Щ…Ш±Ш© ШЈШ®Ш±Щ‰.", noAction: "ШЄШ№Ш°Ш± ШҐЩѓЩ…Ш§Щ„ ШЄШ№ШЇЩЉЩ„ Ш§Щ„ШґШ±ЩѓШ©. Щ„Щ… ЩЉШЄЩ… ШЄШєЩЉЩЉШ± Ш§Щ„ШґШ±ЩѓШ© ШЈЩ€ Ш§Щ„Щ€ЩѓЩ„Ш§ШЎ. Щ€Ш¶Щ‘Ш­ Ш§Щ„Ш·Щ„ШЁ ШЈЩ€ Ш­Ш§Щ€Щ„ Щ…Ш±Ш© ШЈШ®Ш±Щ‰.", failed: "ШЄШ№Ш°Ш± ШҐЩѓЩ…Ш§Щ„ ШЄШ№ШЇЩЉЩ„ Ш§Щ„ШґШ±ЩѓШ©", partial: "Ш±ШЁЩ…Ш§ ШЄЩ… Ш­ЩЃШё ШЁШ№Ш¶ Ш§Щ„ШЄШєЩЉЩЉШ±Ш§ШЄ. Ш±Ш§Ш¬Ш№ Ш§Щ„ШҐШ№ШЇШ§ШЇШ§ШЄ > Ш§Щ„ШґШ±ЩѓШ© Щ‚ШЁЩ„ Ш§Щ„Щ…Ш­Ш§Щ€Щ„Ш© Щ…Ш±Ш© ШЈШ®Ш±Щ‰.", unchanged: "Щ„Щ… ЩЉШЄЩ… Ш­ЩЃШё ШЈЩЉ ШЄШєЩЉЩЉШ±Ш§ШЄ." },
  hi: { created: "а¤ЄаҐ‚а¤°а¤ѕ а¤№аҐЃа¤†аҐ¤ а¤®аҐ€а¤‚а¤ЁаҐ‡ **{name}** а¤•а¤‚а¤Єа¤ЁаҐЂ а¤¬а¤Ёа¤ѕа¤€ а¤”а¤° а¤‰а¤ёаҐ‡ а¤•а¤‚а¤Єа¤ЁаҐЂ а¤ёаҐ‡а¤џа¤їа¤‚а¤—аҐЌа¤ё а¤®аҐ‡а¤‚ а¤ёа¤№аҐ‡а¤њ а¤¦а¤їа¤Їа¤ѕаҐ¤", updated: "а¤ЄаҐ‚а¤°а¤ѕ а¤№аҐЃа¤†аҐ¤ а¤®аҐ€а¤‚а¤ЁаҐ‡ **{name}** а¤•аҐ‹ а¤…а¤Єа¤ЎаҐ‡а¤џ а¤•а¤їа¤Їа¤ѕаҐ¤", deleted: "а¤ЄаҐ‚а¤°а¤ѕ а¤№аҐЃа¤†аҐ¤ а¤•а¤‚а¤Єа¤ЁаҐЂ **{name}** а¤№а¤џа¤ѕ а¤¦аҐЂ а¤—а¤€аҐ¤", alreadyExists: "а¤•а¤‚а¤Єа¤ЁаҐЂ **{name}** а¤Єа¤№а¤ІаҐ‡ а¤ёаҐ‡ а¤®аҐЊа¤њаҐ‚а¤¦ а¤№аҐ€аҐ¤ а¤†а¤Є а¤‡а¤ёаҐ‡ а¤ёаҐ‡а¤џа¤їа¤‚а¤—аҐЌа¤ё а¤®аҐ‡а¤‚ а¤¦аҐ‡а¤– а¤Їа¤ѕ а¤ёа¤‚а¤Єа¤ѕа¤¦а¤їа¤¤ а¤•а¤° а¤ёа¤•а¤¤аҐ‡ а¤№аҐ€а¤‚аҐ¤", configured: "а¤µа¤°аҐЌа¤¤а¤®а¤ѕа¤Ё а¤•аҐ‰а¤ЁаҐЌа¤«а¤ја¤їа¤—а¤°аҐ‡а¤¶а¤Ё а¤Їа¤№ а¤№аҐ€:", company: "а¤•а¤‚а¤Єа¤ЁаҐЂ", name: "а¤Ёа¤ѕа¤®", status: "а¤ёаҐЌа¤Ґа¤їа¤¤а¤ї", active: "а¤ёа¤•аҐЌа¤°а¤їа¤Ї", inactive: "а¤Ёа¤їа¤·аҐЌа¤•аҐЌа¤°а¤їа¤Ї", industry: "а¤‰а¤¦аҐЌа¤ЇаҐ‹а¤—", website: "а¤µаҐ‡а¤¬а¤ёа¤ѕа¤‡а¤џ", languages: "а¤­а¤ѕа¤·а¤ѕа¤Џа¤Ѓ", brandTone: "а¤¬аҐЌа¤°а¤ѕа¤‚а¤Ў а¤џаҐ‹а¤Ё", description: "а¤•а¤‚а¤Єа¤ЁаҐЂ а¤•а¤ѕ а¤µа¤їа¤µа¤°а¤Ј", products: "а¤‰а¤¤аҐЌа¤Єа¤ѕа¤¦ а¤Їа¤ѕ а¤ёаҐ‡а¤µа¤ѕа¤Џа¤Ѓ", agents: "а¤Џа¤њаҐ‡а¤‚а¤џ а¤џаҐЂа¤®", mainAgent: "а¤®аҐЃа¤–аҐЌа¤Ї а¤Џа¤њаҐ‡а¤‚а¤џ", noAgents: "а¤…а¤­аҐЂ а¤•аҐ‹а¤€ а¤Џа¤њаҐ‡а¤‚а¤џ а¤Ёа¤№аҐЂа¤‚ а¤њаҐ‹а¤Ўа¤ја¤ѕ а¤—а¤Їа¤ѕ а¤№аҐ€аҐ¤", notSpecified: "а¤Ёа¤їа¤°аҐЌа¤¦а¤їа¤·аҐЌа¤џ а¤Ёа¤№аҐЂа¤‚", openSettings: "а¤•а¤‚а¤Єа¤ЁаҐЂ а¤ёаҐ‡а¤џа¤їа¤‚а¤—аҐЌа¤ё а¤–аҐ‹а¤ІаҐ‡а¤‚ в†’", nextStep: "**а¤…а¤—а¤Іа¤ѕ а¤•а¤¦а¤®:** а¤•аҐЌа¤Їа¤ѕ а¤†а¤Є а¤ља¤ѕа¤№а¤¤аҐ‡ а¤№аҐ€а¤‚ а¤•а¤ї а¤®аҐ€а¤‚ а¤‡а¤Ё а¤Џа¤њаҐ‡а¤‚а¤џаҐ‹а¤‚ а¤•аҐЂ а¤­аҐ‚а¤®а¤їа¤•а¤ѕа¤Џа¤Ѓ, а¤Ёа¤їа¤°аҐЌа¤¦аҐ‡а¤¶ а¤”а¤° а¤®аҐ‰а¤Ўа¤І а¤…а¤§а¤їа¤• а¤µа¤їа¤ёаҐЌа¤¤а¤ѕа¤° а¤ёаҐ‡ а¤ёаҐ‡а¤џ а¤•а¤°аҐ‚а¤Ѓ?", incomplete: "а¤•а¤ѕа¤°аҐЌа¤°а¤µа¤ѕа¤€ а¤…а¤§аҐ‚а¤°аҐЂ а¤№аҐ‹а¤ЁаҐ‡ а¤•аҐ‡ а¤•а¤ѕа¤°а¤Ј а¤•а¤‚а¤Єа¤ЁаҐЂ а¤Єа¤°а¤їа¤µа¤°аҐЌа¤¤а¤Ё а¤ЄаҐ‚а¤°а¤ѕ а¤Ёа¤№аҐЂа¤‚ а¤№аҐ‹ а¤ёа¤•а¤ѕаҐ¤ а¤«а¤їа¤° а¤ёаҐ‡ а¤ЄаҐЌа¤°а¤Їа¤ѕа¤ё а¤•а¤°аҐ‡а¤‚аҐ¤", noAction: "а¤•а¤‚а¤Єа¤ЁаҐЂ а¤Єа¤°а¤їа¤µа¤°аҐЌа¤¤а¤Ё а¤ЄаҐ‚а¤°а¤ѕ а¤Ёа¤№аҐЂа¤‚ а¤№аҐ‹ а¤ёа¤•а¤ѕаҐ¤ а¤•а¤‚а¤Єа¤ЁаҐЂ а¤Їа¤ѕ а¤Џа¤њаҐ‡а¤‚а¤џаҐ‹а¤‚ а¤®аҐ‡а¤‚ а¤•аҐ‹а¤€ а¤¬а¤¦а¤Іа¤ѕа¤µ а¤Ёа¤№аҐЂа¤‚ а¤•а¤їа¤Їа¤ѕ а¤—а¤Їа¤ѕаҐ¤ а¤…а¤ЁаҐЃа¤°аҐ‹а¤§ а¤ёаҐЌа¤Єа¤·аҐЌа¤џ а¤•а¤°аҐ‡а¤‚ а¤Їа¤ѕ а¤«а¤їа¤° а¤ёаҐ‡ а¤ЄаҐЌа¤°а¤Їа¤ѕа¤ё а¤•а¤°аҐ‡а¤‚аҐ¤", failed: "а¤•а¤‚а¤Єа¤ЁаҐЂ а¤Єа¤°а¤їа¤µа¤°аҐЌа¤¤а¤Ё а¤ЄаҐ‚а¤°а¤ѕ а¤Ёа¤№аҐЂа¤‚ а¤№аҐ‹ а¤ёа¤•а¤ѕ", partial: "а¤•аҐЃа¤› а¤¬а¤¦а¤Іа¤ѕа¤µ а¤ёа¤№аҐ‡а¤њаҐ‡ а¤—а¤Џ а¤№аҐ‹ а¤ёа¤•а¤¤аҐ‡ а¤№аҐ€а¤‚аҐ¤ а¤«а¤їа¤° а¤ёаҐ‡ а¤ЄаҐЌа¤°а¤Їа¤ѕа¤ё а¤•а¤°а¤ЁаҐ‡ а¤ёаҐ‡ а¤Єа¤№а¤ІаҐ‡ а¤ёаҐ‡а¤џа¤їа¤‚а¤—аҐЌа¤ё > а¤•а¤‚а¤Єа¤ЁаҐЂ а¤ња¤ѕа¤Ѓа¤љаҐ‡а¤‚аҐ¤", unchanged: "а¤•аҐ‹а¤€ а¤¬а¤¦а¤Іа¤ѕа¤µ а¤ёа¤№аҐ‡а¤ња¤ѕ а¤Ёа¤№аҐЂа¤‚ а¤—а¤Їа¤ѕаҐ¤" },
};


const companyManagementPatterns: RegExp[] = [
  /^(?=.*(?:crГ©e|crГ©er|ajoute|ajouter|modifie|modifier|supprime|supprimer|configure|configurer))(?=.*(?:entreprise|sociГ©tГ©|agents?))/miu,
  /^(?=.*(?:erstelle|erstellen|fГјge|Г¤ndere|aktualisiere|lГ¶sche|konfiguriere))(?=.*(?:unternehmen|firma|agenten?))/miu,
  /^(?=.*(?:crea|crear|aГ±ade|agrega|modifica|actualiza|elimina|configura))(?=.*(?:empresa|compaГ±Г­a|agentes?))/miu,
  /^(?=.*(?:crea|creare|aggiungi|modifica|aggiorna|elimina|configura))(?=.*(?:azienda|societГ |agenti?))/miu,
  /^(?=.*(?:utwГіrz|stwГіrz|dodaj|zmieЕ„|zaktualizuj|usuЕ„|skonfiguruj))(?=.*(?:firmД™|firma|spГіЕ‚kД™|agentГіw|agenta|agent|agenci))/miu,
  /^(?=.*(?:crie|cria|criar|adicione|adiciona|altere|altera|atualize|atualiza|exclua|exclui|configure|muda|renomeia))(?=.*(?:empresa|companhia|agentes?))/miu,
  /^(?=.*(?:maak|voeg|wijzig|werk bij|verwijder|configureer))(?=.*(?:bedrijf|onderneming|agenten?))/miu,
  /^(?=.*(?:oluЕџtur|ekle|deДџiЕџtir|gГјncelle|sil|yapД±landД±r))(?=.*(?:Еџirket|firma|ajanlar?|ajanД±))/miu,
  /^(?=.*(?:СЃРѕР·РґР°Р№|СЃРѕР·РґР°С‚СЊ|РґРѕР±Р°РІСЊ|РґРѕР±Р°РІРёС‚СЊ|РёР·РјРµРЅРё|РѕР±РЅРѕРІРё|СѓРґР°Р»Рё|РЅР°СЃС‚СЂРѕР№))(?=.*(?:РєРѕРјРїР°РЅРё|Р°РіРµРЅС‚))/miu,
  /^(?=.*(?:СЃС‚РІРѕСЂРё|СЃС‚РІРѕСЂРёС‚Рё|РґРѕРґР°Р№|РґРѕРґР°С‚Рё|Р·РјС–РЅРё|Р·РјС–РЅРёС‚Рё|РІРёРґР°Р»Рё|РІРёРґР°Р»РёС‚Рё|РЅР°Р»Р°С€С‚СѓР№|РЅР°Р»Р°С€С‚СѓРІР°С‚Рё))(?=.*(?:РєРѕРјРїР°РЅС–|Р°РіРµРЅС‚))/miu,
  /^(?=.*(?:е€›е»є|ж–°е»є|ж·»еЉ |дї®ж”№|ж›ґж–°|е€ й™¤|й…ЌзЅ®))(?=.*(?:е…¬еЏё|дјЃдёљ|ж™єиѓЅдЅ“|д»Јзђ†))/mu,
  /^(?=.*(?:дЅњж€ђ|иїЅеЉ |е¤‰ж›ґ|ж›ґж–°|е‰Љй™¤|иЁ­е®љ))(?=.*(?:дјљз¤ѕ|дјЃжҐ­|г‚Ёгѓјг‚ёг‚§гѓігѓ€))/mu,
  /^(?=.*(?:л§Њл“¤|мѓќм„±|м¶”к°Ђ|м€м •|м—…лЌ°мќґнЉё|м‚­м њ|м„¤м •))(?=.*(?:нљЊм‚¬|кё°м—…|м—ђмќґм „нЉё))/mu,
  /^(?=.*(?:ШЈЩ†ШґШ¦|ШҐЩ†ШґШ§ШЎ|ШЈШ¶ЩЃ|Ш№ШЇЩ‘Щ„|Ш­ШЇЩ‘Ш«|Ш§Ш­Ш°ЩЃ|Ш§Ш¶ШЁШ·))(?=.*(?:ШґШ±ЩѓШ©|Щ…Ш¤ШіШіШ©|Щ€ЩѓЩЉЩ„|Щ€ЩѓЩ„Ш§ШЎ))/mu,
  /^(?=.*(?:а¤¬а¤Ёа¤ѕа¤Џа¤Ѓ|а¤¬а¤Ёа¤ѕа¤“|а¤¬а¤Ёа¤ѕа¤Ёа¤ѕ|а¤њаҐ‹а¤Ўа¤јаҐ‡а¤‚|а¤¬а¤¦а¤ІаҐ‡а¤‚|а¤…а¤Єа¤ЎаҐ‡а¤џ|а¤№а¤џа¤ѕа¤Џа¤Ѓ|а¤•аҐ‰а¤ЁаҐЌа¤«а¤ја¤їа¤—а¤°))(?=.*(?:а¤•а¤‚а¤Єа¤ЁаҐЂ|а¤µаҐЌа¤Їа¤µа¤ёа¤ѕа¤Ї|а¤Џа¤њаҐ‡а¤‚а¤џ))/mu,
];

export function isLocalizedCompanyManagementRequest(message: string): boolean {
  return companyManagementPatterns.some((pattern) => pattern.test(message));
}

export function companyChatCopy(message = "", language?: CompanyChatLanguage): CompanyChatCopy {
  return copy[language ?? detectCompanyChatLanguage(message)];
}

const languageNames: Record<CompanyChatLanguage, string> = {
  en: "English", uk: "Ukrainian", fr: "French", de: "German", es: "Spanish", it: "Italian", pl: "Polish", pt: "Portuguese",
  nl: "Dutch", tr: "Turkish", ru: "Russian", zh: "Simplified Chinese", ja: "Japanese", ko: "Korean", ar: "Arabic", hi: "Hindi",
};

const explicitEnglishLanguageNames: Record<CompanyChatLanguage, string[]> = {
  en: ["English"], uk: ["Ukrainian"], fr: ["French"], de: ["German"], es: ["Spanish"], it: ["Italian"], pl: ["Polish"], pt: ["Portuguese"],
  nl: ["Dutch"], tr: ["Turkish"], ru: ["Russian"], zh: ["Chinese", "Simplified Chinese"], ja: ["Japanese"], ko: ["Korean"], ar: ["Arabic"], hi: ["Hindi"],
};

function explicitlyRequestedLanguage(message: string): CompanyChatLanguage | undefined {
  if (!/\b(?:reply|respond|answer|write|continue|switch|speak)\b/iu.test(message)) return undefined;
  for (const [language, names] of Object.entries(explicitEnglishLanguageNames) as Array<[CompanyChatLanguage, string[]]>) {
    if (names.some((name) => new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "iu").test(message))) return language;
  }
  return undefined;
}

const languageScript = (language: CompanyChatLanguage): string => ({ uk: "cyrillic", ru: "cyrillic", zh: "han", ja: "kana", ko: "hangul", ar: "arabic", hi: "devanagari" } as Partial<Record<CompanyChatLanguage, string>>)[language] ?? "latin";

export function resolveConversationLanguage(
  message = "",
  history: Array<{ role: string; content: string | null | unknown[] }> = [],
): CompanyChatLanguage {
  let active: CompanyChatLanguage | undefined;
  const userMessages = history.filter((item) => item.role === "user" && typeof item.content === "string").map((item) => item.content as string);
  for (const text of [...userMessages, message]) {
    const requested = explicitlyRequestedLanguage(text);
    if (requested) { active = requested; continue; }
    const candidate = detectedLanguage(text);
    if (!active) {
      if (candidate.letters >= 3) {
        const confidentInitialDetection = candidate.language === "en"
          || candidate.letters >= 24
          || candidate.confidence >= 0.04
          // Uncertain only between languages of this script: a short Cyrillic message is still not English.
          || languageScript(candidate.language) !== languageScript("en");
        active = confidentInitialDetection ? candidate.language : "en";
      }
      continue;
    }
    if (candidate.language === active) continue;
    // Ukrainian and Russian share most letters, and surzhyk ("РґР°Р±Р°РІ РІ РїРѕСЃС‚Рё РїРѕР»Рµ") scores close to both: without a letter
    // or a function word of only one of them, the conversation keeps its language.
    if ((active === "uk" || active === "ru") && (candidate.language === "uk" || candidate.language === "ru") && !/[С–С—С”Т‘С‹СЌС‘СЉ]/iu.test(text)) {
      const words = normalizedLanguageText(text).split(" ");
      const own = words.filter((word) => cyrillicFunctionWords[candidate.language as "uk" | "ru"].has(word)).length, other = words.filter((word) => cyrillicFunctionWords[active as "uk" | "ru"].has(word)).length;
      if (own <= other) continue;
    }
    // A message in another script cannot continue the active language, however short ("Cambia su rol a X" after Arabic) (V5-D77).
    if (candidate.letters >= 3 && languageScript(candidate.language) !== languageScript(active)) {
      // A script change alone is not a language switch: transliteration and technical terms may be weak Latin matches.
      // A full Latin sentence after Cyrillic switches when it carries words of its own language and none of a
      // transliterated one: "Create a business profile В«вЂ¦В»: craft sourdough bakery in Kyiv" (confidence 0.02) kept the
      // chat Ukrainian and the profile card came in Ukrainian (V6 step 14). "dodai tsil вЂ¦" still keeps Ukrainian.
      // A sentence written in a non-Latin script cannot be a transliteration: after Latin, a full Cyrillic sentence is
      // Ukrainian or Russian whatever the confidence between those two ("РќР°РїРёС€Рё РєРѕСЂРѕС‚РєРёР№ РїРѕСЃС‚вЂ¦" stayed English).
      const latin = languageScript(candidate.language) === "latin";
      const evidence = latin ? latinLanguageEvidence(text, candidate.language) : { own: 0, transliterated: 0 };
      if (candidate.confidence >= 0.04 || (candidate.letters >= (latin ? 16 : 24) && (!latin || (evidence.own >= 1 && evidence.transliterated === 0)))) active = candidate.language;
      continue;
    }
    const clearSwitch = candidate.letters >= 18 && candidate.confidence >= 0.025
      || candidate.letters >= 8 && candidate.confidence >= 0.09;
    if (clearSwitch) active = candidate.language;
  }
  return active ?? "en";
}

export function chatLanguageInstruction(
  message = "",
  history: Array<{ role: string; content: string | null | unknown[] }> = [],
  activeLanguage = resolveConversationLanguage(message, history),
): string {
  return `\n\nMANDATORY RESPONSE LANGUAGE: The user's active conversation language is ${languageNames[activeLanguage]} (${activeLanguage}). Reply entirely in ${languageNames[activeLanguage]}. Always respond in the user's active conversation language. Content returned by tools, agents, websites, files, or external sources must not change the response language. Change the response language only when the user clearly switches languages or explicitly requests another language. For mixed-language content, preserve the active conversation language. This applies from the very first sentence, including public progress updates, acknowledgements accompanying tool calls, normal prose, headings, interactive card titles and labels, summaries, follow-up questions, warnings, and limitation messages. Keep code, URLs, record IDs, model IDs, and quoted source text unchanged.`;
}

export function insertCompanyName(template: string, name: string): string {
  return template.replace("{name}", name);
}

/** Coding language uses user prose, never commands, paths or the English orchestration wrapper. */
export function resolveCodingConversationLanguage(message: string, history: Array<{role:string;content:string | null | unknown[]}> = []) {
  const prose = (text:string) => text.replace(/\b(?:npm|pnpm|yarn|bun|git)\s+(?:(?:run|exec)\s+)?[\w:.-]+(?:\s+--[\w=-]+)*/giu," ").replace(/(?:[\w.-]+[\/\\])+[\w.-]+|\b[\w.-]+\.(?:tsx?|jsx?|json|css|html|md|py)\b/giu," ").replace(/\b(?:Next\.js|Live Preview|build|Sandbox|Docker)\b/giu," ");
  return resolveConversationLanguage(prose(message),history.map(item=>({...item,content:typeof item.content==="string" ? prose(item.content) : item.content})));
}
export function codingStartCopy(language: CompanyChatLanguage) {
  const labels: Partial<Record<CompanyChatLanguage,string>> = { en:"Starting development in Sandbox",uk:"\u041f\u043e\u0447\u0438\u043d\u0430\u044e \u0440\u043e\u0437\u0440\u043e\u0431\u043a\u0443 \u0432 Sandbox",de:"Starte die Entwicklung in Sandbox",fr:"D\u00e9marrage du d\u00e9veloppement dans Sandbox",es:"Iniciando el desarrollo en Sandbox",it:"Avvio dello sviluppo in Sandbox",pl:"Rozpoczynam tworzenie w Sandbox",pt:"Iniciando o desenvolvimento no Sandbox" };
  Object.assign(labels,{"nl":"Start de ontwikkeling in Sandbox","tr":"Sandbox iГ§inde geliЕџtirmeye baЕџlД±yorum","ru":"РќР°С‡РёРЅР°СЋ СЂР°Р·СЂР°Р±РѕС‚РєСѓ РІ Sandbox","zh":"ејЂе§‹ењЁ Sandbox дё­ејЂеЏ‘","ja":"Sandbox гЃ§й–‹з™єг‚’й–‹е§‹гЃ—гЃѕгЃ™","ko":"Sandboxм—ђм„њ к°њл°њмќ„ м‹њмћ‘н•©л‹€л‹¤","ar":"ШЈШЁШЇШЈ Ш§Щ„ШЄШ·Щ€ЩЉШ± ЩЃЩЉ Sandbox","hi":"Sandbox а¤®аҐ‡а¤‚ а¤µа¤їа¤•а¤ѕа¤ё а¤¶аҐЃа¤°аҐ‚ а¤•а¤° а¤°а¤№а¤ѕ а¤№аҐ‚а¤Ѓ"});
  return labels[language] ?? labels.en!;
}

export function browserCheckUnavailableNotice(language: CompanyChatLanguage): string {
  const labels: Record<CompanyChatLanguage,string> = {
    en:"вљ пёЏ Not verified: Preview is running, but the automatic browser check could not finish. Please check the page.",
    uk:"вљ пёЏ РќРµ РїРµСЂРµРІС–СЂРµРЅРѕ: Preview РїСЂР°С†СЋС”, Р°Р»Рµ Р°РІС‚РѕРјР°С‚РёС‡РЅСѓ РїРµСЂРµРІС–СЂРєСѓ РІ Р±СЂР°СѓР·РµСЂС– РЅРµ РІРґР°Р»РѕСЃСЏ Р·Р°РІРµСЂС€РёС‚Рё. РџРµСЂРµРіР»СЏРЅСЊС‚Рµ СЃС‚РѕСЂС–РЅРєСѓ.",
    ru:"вљ пёЏ РќРµ РїСЂРѕРІРµСЂРµРЅРѕ: Preview СЂР°Р±РѕС‚Р°РµС‚, РЅРѕ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєСѓСЋ РїСЂРѕРІРµСЂРєСѓ РІ Р±СЂР°СѓР·РµСЂРµ РЅРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РІРµСЂС€РёС‚СЊ. РџСЂРѕРІРµСЂСЊС‚Рµ СЃС‚СЂР°РЅРёС†Сѓ.",
    de:"вљ пёЏ Nicht geprГјft: Preview lГ¤uft, aber die automatische Browser-PrГјfung konnte nicht abgeschlossen werden. Bitte die Seite prГјfen.",
    fr:"вљ пёЏ Non vГ©rifiГ© : Preview fonctionne, mais la vГ©rification automatique dans le navigateur nвЂ™a pas pu se terminer. Veuillez vГ©rifier la page.",
    es:"вљ пёЏ Sin verificar: Preview funciona, pero la comprobaciГіn automГЎtica en el navegador no pudo completarse. Revise la pГЎgina.",
    it:"вљ пёЏ Non verificato: Preview ГЁ attivo, ma il controllo automatico nel browser non ГЁ stato completato. Controlla la pagina.",
    pl:"вљ пёЏ Nie sprawdzono: Preview dziaЕ‚a, ale automatyczna kontrola w przeglД…darce nie zakoЕ„czyЕ‚a siД™. SprawdЕє stronД™.",
    pt:"вљ пёЏ NГЈo verificado: o Preview estГЎ a funcionar, mas a verificaГ§ГЈo automГЎtica no navegador nГЈo terminou. Verifique a pГЎgina.",
    nl:"вљ пёЏ Niet gecontroleerd: Preview draait, maar de automatische browsercontrole is niet voltooid. Controleer de pagina.",
    tr:"вљ пёЏ DoДџrulanmadД±: Preview Г§alД±ЕџД±yor, ancak otomatik tarayД±cД± kontrolГј tamamlanamadД±. LГјtfen sayfayД± kontrol edin.",
    zh:"вљ пёЏ жњЄйЄЊиЇЃпјљPreview ж­ЈењЁиїђиЎЊпјЊдЅ†жµЏи§€е™Ёи‡ЄеЉЁжЈЂжџҐжњЄиѓЅе®Њж€ђпјЊиЇ·жЈЂжџҐйЎµйќўгЂ‚",
    ja:"вљ пёЏ жњЄзўєиЄЌпјљPreview гЃЇе‹•дЅњгЃ—гЃ¦гЃ„гЃѕгЃ™гЃЊгЂЃгѓ–гѓ©г‚¦г‚¶гЃ®и‡Єе‹•гѓЃг‚§гѓѓг‚Їг‚’е®Њдє†гЃ§гЃЌгЃѕгЃ›г‚“гЃ§гЃ—гЃџгЂ‚гѓљгѓјг‚ёг‚’зўєиЄЌгЃ—гЃ¦гЃЏгЃ гЃ•гЃ„гЂ‚",
    ko:"вљ пёЏ н™•мќёлђм§Ђ м•ЉмќЊ: PreviewлЉ” м‹¤н–‰ м¤‘мќґм§Ђл§Њ лёЊлќјмљ°м Ђ мћђлЏ™ кІЂм‚¬лҐј м™„лЈЊн•м§Ђ лЄ»н–€мЉµл‹€л‹¤. нЋмќґм§ЂлҐј н™•мќён•ґ мЈјм„ёмљ”.",
    ar:"вљ пёЏ Щ„Щ… ЩЉШЄЩ… Ш§Щ„ШЄШ­Щ‚Щ‚: ЩЉШ№Щ…Щ„ Preview Щ„ЩѓЩ† ЩЃШ­Шµ Ш§Щ„Щ…ШЄШµЩЃШ­ Ш§Щ„ШЄЩ„Щ‚Ш§Ш¦ЩЉ Щ„Щ… ЩЉЩѓШЄЩ…Щ„. ЩЉШ±Ш¬Щ‰ Ш§Щ„ШЄШ­Щ‚Щ‚ Щ…Щ† Ш§Щ„ШµЩЃШ­Ш©.",
    hi:"вљ пёЏ а¤ња¤ѕа¤Ѓа¤љ а¤Ёа¤№аҐЂа¤‚ а¤№аҐЃа¤€: Preview а¤ља¤І а¤°а¤№а¤ѕ а¤№аҐ€, а¤Єа¤° а¤¬аҐЌа¤°а¤ѕа¤‰а¤ња¤ја¤° а¤•аҐЂ а¤ёаҐЌа¤µа¤ља¤ѕа¤Іа¤їа¤¤ а¤ња¤ѕа¤Ѓа¤љ а¤ЄаҐ‚а¤°аҐЂ а¤Ёа¤№аҐЂа¤‚ а¤№аҐ‹ а¤ёа¤•аҐЂаҐ¤ а¤•аҐѓа¤Єа¤Їа¤ѕ а¤ЄаҐ‡а¤њ а¤¦аҐ‡а¤–аҐ‡а¤‚аҐ¤",
  };
  return labels[language];
}

export function selfReviewFindingsNotice(language: CompanyChatLanguage, detail: string): string {
  const labels: Record<CompanyChatLanguage,string> = {
    en:"вљ пёЏ The automatic code review found issues that were not fixed. Please check them:",
    uk:"вљ пёЏ РђРІС‚РѕРјР°С‚РёС‡РЅР° РїРµСЂРµРІС–СЂРєР° РєРѕРґСѓ Р·РЅР°Р№С€Р»Р° РїСЂРѕР±Р»РµРјРё, СЏРєС– РЅРµ РІРґР°Р»РѕСЃСЏ РІРёРїСЂР°РІРёС‚Рё. РџРµСЂРµРІС–СЂС‚Рµ С—С…:",
    ru:"вљ пёЏ РђРІС‚РѕРјР°С‚РёС‡РµСЃРєР°СЏ РїСЂРѕРІРµСЂРєР° РєРѕРґР° РЅР°С€Р»Р° РїСЂРѕР±Р»РµРјС‹, РєРѕС‚РѕСЂС‹Рµ РЅРµ СѓРґР°Р»РѕСЃСЊ РёСЃРїСЂР°РІРёС‚СЊ. РџСЂРѕРІРµСЂСЊС‚Рµ РёС…:",
    de:"вљ пёЏ Die automatische Code-PrГјfung hat Probleme gefunden, die nicht behoben wurden. Bitte prГјfen:",
    fr:"вљ пёЏ La revue automatique du code a trouvГ© des problГЁmes non corrigГ©s. Veuillez les vГ©rifier :",
    es:"вљ пёЏ La revisiГіn automГЎtica del cГіdigo encontrГі problemas sin corregir. RevГ­selos:",
    it:"вљ пёЏ La revisione automatica del codice ha trovato problemi non corretti. Controllali:",
    pl:"вљ пёЏ Automatyczny przeglД…d kodu znalazЕ‚ problemy, ktГіrych nie naprawiono. SprawdЕє je:",
    pt:"вљ пёЏ A revisГЈo automГЎtica do cГіdigo encontrou problemas nГЈo corrigidos. Verifique-os:",
    nl:"вљ пёЏ De automatische codereview vond problemen die niet zijn opgelost. Controleer ze:",
    tr:"вљ пёЏ Otomatik kod incelemesi dГјzeltilemeyen sorunlar buldu. LГјtfen kontrol edin:",
    zh:"вљ пёЏ и‡ЄеЉЁд»Јз Ѓе®ЎжџҐеЏ‘зЋ°дє†жњЄдї®е¤Ќзљ„й—®йўпјЊиЇ·жЈЂжџҐпјљ",
    ja:"вљ пёЏ и‡Єе‹•г‚ігѓјгѓ‰гѓ¬гѓ“гѓҐгѓјгЃ§жњЄдї®ж­ЈгЃ®е•ЏйЎЊгЃЊи¦‹гЃ¤гЃ‹г‚ЉгЃѕгЃ—гЃџгЂ‚зўєиЄЌгЃ—гЃ¦гЃЏгЃ гЃ•гЃ„пјљ",
    ko:"вљ пёЏ мћђлЏ™ мЅ”л“њ кІЂн† м—ђм„њ м€м •лђм§Ђ м•ЉмќЂ л¬ём њлҐј л°њкІ¬н–€мЉµл‹€л‹¤. н™•мќён•ґ мЈјм„ёмљ”:",
    ar:"вљ пёЏ Щ€Ш¬ШЇШЄ Щ…Ш±Ш§Ш¬Ш№Ш© Ш§Щ„ШґЩЉЩЃШ±Ш© Ш§Щ„ШЄЩ„Щ‚Ш§Ш¦ЩЉШ© Щ…ШґЩѓЩ„Ш§ШЄ Щ„Щ… ШЄЩЏШµЩ„Ш­. ЩЉШ±Ш¬Щ‰ Ш§Щ„ШЄШ­Щ‚Щ‚ Щ…Щ†Щ‡Ш§:",
    hi:"вљ пёЏ а¤ёаҐЌа¤µа¤ља¤ѕа¤Іа¤їа¤¤ а¤•аҐ‹а¤Ў а¤ёа¤®аҐЂа¤•аҐЌа¤·а¤ѕ а¤®аҐ‡а¤‚ а¤ђа¤ёаҐЂ а¤ёа¤®а¤ёаҐЌа¤Їа¤ѕа¤Џа¤Ѓ а¤®а¤їа¤ІаҐЂа¤‚ а¤њаҐ‹ а¤ аҐЂа¤• а¤Ёа¤№аҐЂа¤‚ а¤№аҐЃа¤€а¤‚аҐ¤ а¤•аҐѓа¤Єа¤Їа¤ѕ а¤ња¤ѕа¤Ѓа¤љаҐ‡а¤‚:",
  };
  return `**${labels[language]}**\n\n${detail}`;
}

export function selfReviewUnavailableNotice(language: CompanyChatLanguage): string {
  const labels: Record<CompanyChatLanguage,string> = {
    en:"вљ пёЏ Not verified: the automatic code review could not finish, so this result was not reviewed.",
    uk:"вљ пёЏ РќРµ РїРµСЂРµРІС–СЂРµРЅРѕ: Р°РІС‚РѕРјР°С‚РёС‡РЅСѓ РїРµСЂРµРІС–СЂРєСѓ РєРѕРґСѓ РЅРµ РІРґР°Р»РѕСЃСЏ Р·Р°РІРµСЂС€РёС‚Рё, С‚РѕРјСѓ С†РµР№ СЂРµР·СѓР»СЊС‚Р°С‚ РЅРµ РїРµСЂРµРІС–СЂСЏРІСЃСЏ.",
    ru:"вљ пёЏ РќРµ РїСЂРѕРІРµСЂРµРЅРѕ: Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєСѓСЋ РїСЂРѕРІРµСЂРєСѓ РєРѕРґР° РЅРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РІРµСЂС€РёС‚СЊ, РїРѕСЌС‚РѕРјСѓ СЌС‚РѕС‚ СЂРµР·СѓР»СЊС‚Р°С‚ РЅРµ РїСЂРѕРІРµСЂСЏР»СЃСЏ.",
    de:"вљ пёЏ Nicht geprГјft: Die automatische Code-PrГјfung konnte nicht abgeschlossen werden, dieses Ergebnis wurde daher nicht geprГјft.",
    fr:"вљ пёЏ Non vГ©rifiГ© : la revue automatique du code nвЂ™a pas pu se terminer, ce rГ©sultat nвЂ™a donc pas Г©tГ© vГ©rifiГ©.",
    es:"вљ пёЏ Sin verificar: la revisiГіn automГЎtica del cГіdigo no pudo completarse, por lo que este resultado no se revisГі.",
    it:"вљ пёЏ Non verificato: la revisione automatica del codice non ГЁ stata completata, quindi questo risultato non ГЁ stato controllato.",
    pl:"вљ пёЏ Nie sprawdzono: automatycznego przeglД…du kodu nie udaЕ‚o siД™ ukoЕ„czyД‡, wiД™c ten wynik nie zostaЕ‚ sprawdzony.",
    pt:"вљ пёЏ NГЈo verificado: a revisГЈo automГЎtica do cГіdigo nГЈo pГґde ser concluГ­da, por isso este resultado nГЈo foi revisto.",
    nl:"вљ пёЏ Niet gecontroleerd: de automatische codereview kon niet worden voltooid, dus dit resultaat is niet gecontroleerd.",
    tr:"вљ пёЏ DoДџrulanmadД±: otomatik kod incelemesi tamamlanamadД±, bu nedenle bu sonuГ§ incelenmedi.",
    zh:"вљ пёЏ жњЄйЄЊиЇЃпјљи‡ЄеЉЁд»Јз Ѓе®ЎжџҐжњЄиѓЅе®Њж€ђпјЊе› ж­¤ж­¤з»“жћњжњЄз»Џе®ЎжџҐгЂ‚",
    ja:"вљ пёЏ жњЄзўєиЄЌпјљи‡Єе‹•г‚ігѓјгѓ‰гѓ¬гѓ“гѓҐгѓјг‚’е®Њдє†гЃ§гЃЌгЃЄгЃ‹гЃЈгЃџгЃџг‚ЃгЂЃгЃ“гЃ®зµђжћњгЃЇгѓ¬гѓ“гѓҐгѓјгЃ•г‚ЊгЃ¦гЃ„гЃѕгЃ›г‚“гЂ‚",
    ko:"вљ пёЏ н™•мќёлђм§Ђ м•ЉмќЊ: мћђлЏ™ мЅ”л“њ кІЂн† лҐј м™„лЈЊн•м§Ђ лЄ»н•ґ мќґ кІ°кіјлЉ” кІЂн† лђм§Ђ м•Љм•мЉµл‹€л‹¤.",
    ar:"вљ пёЏ Щ„Щ… ЩЉШЄЩ… Ш§Щ„ШЄШ­Щ‚Щ‚: ШЄШ№Ш°Щ‘Ш± ШҐЩѓЩ…Ш§Щ„ Ш§Щ„Щ…Ш±Ш§Ш¬Ш№Ш© Ш§Щ„ШЄЩ„Щ‚Ш§Ш¦ЩЉШ© Щ„Щ„ЩѓЩ€ШЇШЊ Щ„Ш°Ш§ Щ„Щ… ШЄШЄЩ… Щ…Ш±Ш§Ш¬Ш№Ш© Щ‡Ш°Щ‡ Ш§Щ„Щ†ШЄЩЉШ¬Ш©.",
    hi:"вљ пёЏ а¤ёа¤¤аҐЌа¤Їа¤ѕа¤Єа¤їа¤¤ а¤Ёа¤№аҐЂа¤‚: а¤ёаҐЌа¤µа¤ља¤ѕа¤Іа¤їа¤¤ а¤•аҐ‹а¤Ў а¤ёа¤®аҐЂа¤•аҐЌа¤·а¤ѕ а¤ЄаҐ‚а¤°аҐЂ а¤Ёа¤№аҐЂа¤‚ а¤№аҐ‹ а¤ёа¤•аҐЂ, а¤‡а¤ёа¤Іа¤їа¤Џ а¤‡а¤ё а¤Єа¤°а¤їа¤Ја¤ѕа¤® а¤•аҐЂ а¤ёа¤®аҐЂа¤•аҐЌа¤·а¤ѕ а¤Ёа¤№аҐЂа¤‚ а¤•аҐЂ а¤—а¤€аҐ¤",
  };
  return labels[language];
}

/** User-facing copy policy only; execution and verification remain unchanged. */
export function codingChatResponseInstruction(): string {
  return "\nCommunication: keep public progress updates to one short sentence about the actual next action. Unless the user explicitly asks for a detailed report, finish with 2-4 concise sentences: the concrete changes, actual verification result, and any actionable blocker. Do not repeat command logs, a file-by-file report, unchanged-file lists or unsolicited next steps; real execution details are available in the chat activity. Do not claim Preview is ready before the system confirms it. Answer in the user request language.";
}

type CardCopy = { type: string; business: string; confidence: string; company: string; status: string; active: string; completed: string; schedule: string; timezone: string; nextRun: string; mode: string; steps: string; toolCalls: string; duration: string; openMemory: string; openAutomations: string; openActivity: string; openContent: string };
const cardCopies: Record<string, CardCopy> = {
  en: { type: "Type", business: "Business", confidence: "Confidence", company: "Company", status: "Status", active: "Active", completed: "Completed", schedule: "Schedule", timezone: "Timezone", nextRun: "Next run", mode: "Mode", steps: "Steps", toolCalls: "Tool calls", duration: "Duration", openMemory: "Open Business Memory", openAutomations: "Open Automations", openActivity: "Open Activity & Run Trace", openContent: "Open Content Hub" },
  uk: { type: "РўРёРї", business: "Р‘С–Р·РЅРµСЃ", confidence: "Р”РѕСЃС‚РѕРІС–СЂРЅС–СЃС‚СЊ", company: "РљРѕРјРїР°РЅС–СЏ", status: "РЎС‚Р°С‚СѓСЃ", active: "РђРєС‚РёРІРЅР°", completed: "Р—Р°РІРµСЂС€РµРЅРѕ", schedule: "Р РѕР·РєР»Р°Рґ", timezone: "Р§Р°СЃРѕРІРёР№ РїРѕСЏСЃ", nextRun: "РќР°СЃС‚СѓРїРЅРёР№ Р·Р°РїСѓСЃРє", mode: "Р РµР¶РёРј", steps: "РљСЂРѕРєРё", toolCalls: "Р’РёРєР»РёРєРё С–РЅСЃС‚СЂСѓРјРµРЅС‚С–РІ", duration: "РўСЂРёРІР°Р»С–СЃС‚СЊ", openMemory: "Р’С–РґРєСЂРёС‚Рё РїР°РјвЂ™СЏС‚СЊ Р±С–Р·РЅРµСЃСѓ", openAutomations: "Р’С–РґРєСЂРёС‚Рё Р°РІС‚РѕРјР°С‚РёР·Р°С†С–С—", openActivity: "Р’С–РґРєСЂРёС‚Рё Р¶СѓСЂРЅР°Р» Р°РєС‚РёРІРЅРѕСЃС‚С–", openContent: "Р’С–РґРєСЂРёС‚Рё Content Hub" },
  fr: { type: "Type", business: "Entreprise", confidence: "Confiance", company: "SociГ©tГ©", status: "Statut", active: "Active", completed: "TerminГ©", schedule: "Planification", timezone: "Fuseau horaire", nextRun: "Prochaine exГ©cution", mode: "Mode", steps: "Г‰tapes", toolCalls: "Appels dвЂ™outils", duration: "DurГ©e", openMemory: "Ouvrir la mГ©moire mГ©tier", openAutomations: "Ouvrir les automatisations", openActivity: "Ouvrir lвЂ™activitГ© et la trace", openContent: "Ouvrir le centre de contenu" },
  de: { type: "Typ", business: "GeschГ¤ft", confidence: "Vertrauen", company: "Unternehmen", status: "Status", active: "Aktiv", completed: "Abgeschlossen", schedule: "Zeitplan", timezone: "Zeitzone", nextRun: "NГ¤chste AusfГјhrung", mode: "Modus", steps: "Schritte", toolCalls: "Werkzeugaufrufe", duration: "Dauer", openMemory: "GeschГ¤ftsgedГ¤chtnis Г¶ffnen", openAutomations: "Automatisierungen Г¶ffnen", openActivity: "AktivitГ¤t und Ablauf Г¶ffnen", openContent: "Content Hub Г¶ffnen" },
  es: { type: "Tipo", business: "Negocio", confidence: "Confianza", company: "Empresa", status: "Estado", active: "Activa", completed: "Completado", schedule: "ProgramaciГіn", timezone: "Zona horaria", nextRun: "PrГіxima ejecuciГіn", mode: "Modo", steps: "Pasos", toolCalls: "Llamadas de herramientas", duration: "DuraciГіn", openMemory: "Abrir memoria del negocio", openAutomations: "Abrir automatizaciones", openActivity: "Abrir actividad y trazas", openContent: "Abrir Content Hub" },
  it: { type: "Tipo", business: "AttivitГ ", confidence: "AffidabilitГ ", company: "Azienda", status: "Stato", active: "Attiva", completed: "Completato", schedule: "Pianificazione", timezone: "Fuso orario", nextRun: "Prossima esecuzione", mode: "ModalitГ ", steps: "Passaggi", toolCalls: "Chiamate agli strumenti", duration: "Durata", openMemory: "Apri memoria aziendale", openAutomations: "Apri automazioni", openActivity: "Apri attivitГ  e traccia", openContent: "Apri Content Hub" },
  pl: { type: "Typ", business: "Firma", confidence: "PewnoЕ›Д‡", company: "Firma", status: "Status", active: "Aktywna", completed: "UkoЕ„czono", schedule: "Harmonogram", timezone: "Strefa czasowa", nextRun: "NastД™pne uruchomienie", mode: "Tryb", steps: "Kroki", toolCalls: "WywoЕ‚ania narzД™dzi", duration: "Czas trwania", openMemory: "OtwГіrz pamiД™Д‡ firmy", openAutomations: "OtwГіrz automatyzacje", openActivity: "OtwГіrz aktywnoЕ›Д‡ i Е›lad", openContent: "OtwГіrz Content Hub" },
  pt: { type: "Tipo", business: "NegГіcio", confidence: "ConfianГ§a", company: "Empresa", status: "Status", active: "Ativa", completed: "ConcluГ­do", schedule: "Agenda", timezone: "Fuso horГЎrio", nextRun: "PrГіxima execuГ§ГЈo", mode: "Modo", steps: "Etapas", toolCalls: "Chamadas de ferramentas", duration: "DuraГ§ГЈo", openMemory: "Abrir memГіria do negГіcio", openAutomations: "Abrir automaГ§Гµes", openActivity: "Abrir atividade e rastreamento", openContent: "Abrir Content Hub" },
  nl: { type: "Type", business: "Bedrijf", confidence: "Betrouwbaarheid", company: "Bedrijf", status: "Status", active: "Actief", completed: "Voltooid", schedule: "Planning", timezone: "Tijdzone", nextRun: "Volgende uitvoering", mode: "Modus", steps: "Stappen", toolCalls: "Toolaanroepen", duration: "Duur", openMemory: "Bedrijfsgeheugen openen", openAutomations: "Automatiseringen openen", openActivity: "Activiteit en trace openen", openContent: "Content Hub openen" },
  tr: { type: "TГјr", business: "Д°Еџletme", confidence: "GГјven", company: "Ећirket", status: "Durum", active: "Aktif", completed: "TamamlandД±", schedule: "Program", timezone: "Saat dilimi", nextRun: "Sonraki Г§alД±Еџma", mode: "Mod", steps: "AdД±mlar", toolCalls: "AraГ§ Г§aДџrД±larД±", duration: "SГјre", openMemory: "Д°Еџletme hafД±zasД±nД± aГ§", openAutomations: "OtomasyonlarД± aГ§", openActivity: "Etkinlik ve Г§alД±Еџma izini aГ§", openContent: "Content HubвЂ™Д± aГ§" },
  ru: { type: "РўРёРї", business: "Р‘РёР·РЅРµСЃ", confidence: "Р”РѕСЃС‚РѕРІРµСЂРЅРѕСЃС‚СЊ", company: "РљРѕРјРїР°РЅРёСЏ", status: "РЎС‚Р°С‚СѓСЃ", active: "РђРєС‚РёРІРЅР°", completed: "Р—Р°РІРµСЂС€РµРЅРѕ", schedule: "Р Р°СЃРїРёСЃР°РЅРёРµ", timezone: "Р§Р°СЃРѕРІРѕР№ РїРѕСЏСЃ", nextRun: "РЎР»РµРґСѓСЋС‰РёР№ Р·Р°РїСѓСЃРє", mode: "Р РµР¶РёРј", steps: "РЁР°РіРё", toolCalls: "Р’С‹Р·РѕРІС‹ РёРЅСЃС‚СЂСѓРјРµРЅС‚РѕРІ", duration: "Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ", openMemory: "РћС‚РєСЂС‹С‚СЊ РїР°РјСЏС‚СЊ Р±РёР·РЅРµСЃР°", openAutomations: "РћС‚РєСЂС‹С‚СЊ Р°РІС‚РѕРјР°С‚РёР·Р°С†РёРё", openActivity: "РћС‚РєСЂС‹С‚СЊ Р°РєС‚РёРІРЅРѕСЃС‚СЊ Рё С‚СЂР°СЃСЃРёСЂРѕРІРєСѓ", openContent: "РћС‚РєСЂС‹С‚СЊ Content Hub" },
  zh: { type: "з±»ећ‹", business: "дёљеЉЎ", confidence: "еЏЇдїЎеє¦", company: "е…¬еЏё", status: "зЉ¶жЂЃ", active: "еђЇз”Ё", completed: "е·Іе®Њж€ђ", schedule: "и®Ўе€’", timezone: "ж—¶еЊє", nextRun: "дё‹ж¬ЎиїђиЎЊ", mode: "жЁЎејЏ", steps: "ж­ҐйЄ¤", toolCalls: "е·Ґе…·и°ѓз”Ё", duration: "иЂ—ж—¶", openMemory: "ж‰“ејЂдёљеЉЎи®°еї†", openAutomations: "ж‰“ејЂи‡ЄеЉЁеЊ–", openActivity: "ж‰“ејЂжґ»еЉЁдёЋиїђиЎЊи·џиёЄ", openContent: "ж‰“ејЂе†…е®№дё­еїѓ" },
  ja: { type: "зЁ®йЎћ", business: "гѓ“г‚ёгѓЌг‚№", confidence: "дїЎй јеє¦", company: "дјљз¤ѕ", status: "зЉ¶ж…‹", active: "жњ‰еЉ№", completed: "е®Њдє†", schedule: "г‚№г‚±г‚ёгѓҐгѓјгѓ«", timezone: "г‚їг‚¤гѓ г‚ѕгѓјгѓі", nextRun: "ж¬Ўе›ће®џиЎЊ", mode: "гѓўгѓјгѓ‰", steps: "г‚№гѓ†гѓѓгѓ—", toolCalls: "гѓ„гѓјгѓ«е‘јгЃіе‡єгЃ—", duration: "ж‰Ђи¦Ѓж™‚й–“", openMemory: "гѓ“г‚ёгѓЌг‚№гѓЎгѓўгѓЄг‚’й–‹гЃЏ", openAutomations: "и‡Єе‹•еЊ–г‚’й–‹гЃЏ", openActivity: "г‚ўг‚Їгѓ†г‚Јгѓ“гѓ†г‚ЈгЃЁе®џиЎЊгѓ€гѓ¬гѓјг‚№г‚’й–‹гЃЏ", openContent: "г‚ігѓігѓ†гѓігѓ„гѓЏгѓ–г‚’й–‹гЃЏ" },
  ko: { type: "мњ н•", business: "л№„м¦€л‹€мЉ¤", confidence: "м‹ лў°лЏ„", company: "нљЊм‚¬", status: "мѓЃнѓњ", active: "н™њм„±", completed: "м™„лЈЊ", schedule: "мќјм •", timezone: "м‹њк°„лЊЂ", nextRun: "л‹¤мќЊ м‹¤н–‰", mode: "лЄЁл“њ", steps: "л‹Ёкі„", toolCalls: "лЏ„кµ¬ нём¶њ", duration: "м†Њмљ” м‹њк°„", openMemory: "л№„м¦€л‹€мЉ¤ л©”лЄЁл¦¬ м—ґкё°", openAutomations: "мћђлЏ™н™” м—ґкё°", openActivity: "н™њлЏ™ л°Џ м‹¤н–‰ м¶”м Ѓ м—ґкё°", openContent: "мЅн…ђмё  н—€лёЊ м—ґкё°" },
  ar: { type: "Ш§Щ„Щ†Щ€Ш№", business: "Ш§Щ„Щ†ШґШ§Ш· Ш§Щ„ШЄШ¬Ш§Ш±ЩЉ", confidence: "Ш§Щ„Ш«Щ‚Ш©", company: "Ш§Щ„ШґШ±ЩѓШ©", status: "Ш§Щ„Ш­Ш§Щ„Ш©", active: "Щ†ШґШ·Ш©", completed: "Щ…ЩѓШЄЩ…Щ„", schedule: "Ш§Щ„Ш¬ШЇЩ€Щ„", timezone: "Ш§Щ„Щ…Щ†Ш·Щ‚Ш© Ш§Щ„ШІЩ…Щ†ЩЉШ©", nextRun: "Ш§Щ„ШЄШґШєЩЉЩ„ Ш§Щ„ШЄШ§Щ„ЩЉ", mode: "Ш§Щ„Щ€Ш¶Ш№", steps: "Ш§Щ„Ш®Ш·Щ€Ш§ШЄ", toolCalls: "Ш§ШіШЄШЇШ№Ш§ШЎШ§ШЄ Ш§Щ„ШЈШЇЩ€Ш§ШЄ", duration: "Ш§Щ„Щ…ШЇШ©", openMemory: "ЩЃШЄШ­ Ш°Ш§ЩѓШ±Ш© Ш§Щ„Щ†ШґШ§Ш· Ш§Щ„ШЄШ¬Ш§Ш±ЩЉ", openAutomations: "ЩЃШЄШ­ Ш№Щ…Щ„ЩЉШ§ШЄ Ш§Щ„ШЈШЄЩ…ШЄШ©", openActivity: "ЩЃШЄШ­ Ш§Щ„Щ†ШґШ§Ш· Щ€ШЄШЄШЁШ№ Ш§Щ„ШЄЩ†ЩЃЩЉШ°", openContent: "ЩЃШЄШ­ Щ…Ш±ЩѓШІ Ш§Щ„Щ…Ш­ШЄЩ€Щ‰" },
  hi: { type: "а¤ЄаҐЌа¤°а¤•а¤ѕа¤°", business: "а¤µаҐЌа¤Їа¤µа¤ёа¤ѕа¤Ї", confidence: "а¤µа¤їа¤¶аҐЌа¤µа¤ёа¤ЁаҐЂа¤Їа¤¤а¤ѕ", company: "а¤•а¤‚а¤Єа¤ЁаҐЂ", status: "а¤ёаҐЌа¤Ґа¤їа¤¤а¤ї", active: "а¤ёа¤•аҐЌа¤°а¤їа¤Ї", completed: "а¤ЄаҐ‚а¤°аҐЌа¤Ј", schedule: "а¤ёа¤®а¤Ї-а¤ёа¤ѕа¤°а¤ЈаҐЂ", timezone: "а¤ёа¤®а¤Ї а¤•аҐЌа¤·аҐ‡а¤¤аҐЌа¤°", nextRun: "а¤…а¤—а¤Іа¤ѕ а¤°а¤Ё", mode: "а¤®аҐ‹а¤Ў", steps: "а¤ља¤°а¤Ј", toolCalls: "а¤џаҐ‚а¤І а¤•аҐ‰а¤І", duration: "а¤…а¤µа¤§а¤ї", openMemory: "а¤µаҐЌа¤Їа¤µа¤ёа¤ѕа¤Ї а¤®аҐ‡а¤®аҐ‹а¤°аҐЂ а¤–аҐ‹а¤ІаҐ‡а¤‚", openAutomations: "а¤‘а¤џаҐ‹а¤®аҐ‡а¤¶а¤Ё а¤–аҐ‹а¤ІаҐ‡а¤‚", openActivity: "а¤—а¤¤а¤їа¤µа¤їа¤§а¤ї а¤”а¤° а¤°а¤Ё а¤џаҐЌа¤°аҐ‡а¤ё а¤–аҐ‹а¤ІаҐ‡а¤‚", openContent: "а¤•а¤‚а¤џаҐ‡а¤‚а¤џ а¤№а¤¬ а¤–аҐ‹а¤ІаҐ‡а¤‚" },
};

/** Automation list labels (V6 step 12: the list was English in every language). */
const automationListCopy: Partial<Record<CompanyChatLanguage, { agent: string; lastRun: string; automaticAgent: string; none: string; cancelled: string; stopped: string; noRuns: string }>> = {
  en: { agent: "Agent", lastRun: "Last run", automaticAgent: "automatic selection", none: "No automations are configured.", cancelled: "Cancelled", stopped: "Stopped on request before it finished; nothing was produced.", noRuns: "This automation has no runs yet." },
  uk: { agent: "РђРіРµРЅС‚", lastRun: "РћСЃС‚Р°РЅРЅС–Р№ Р·Р°РїСѓСЃРє", automaticAgent: "Р°РІС‚РѕРјР°С‚РёС‡РЅРёР№ РІРёР±С–СЂ", none: "РђРІС‚РѕРјР°С‚РёР·Р°С†С–Р№ С‰Рµ РЅРµРјР°С”.", cancelled: "РЎРєР°СЃРѕРІР°РЅРѕ", stopped: "Р—СѓРїРёРЅРµРЅРѕ РЅР° Р·Р°РїРёС‚ РґРѕ Р·Р°РІРµСЂС€РµРЅРЅСЏ; СЂРµР·СѓР»СЊС‚Р°С‚Сѓ РЅРµРјР°С”.", noRuns: "Р¦СЏ Р°РІС‚РѕРјР°С‚РёР·Р°С†С–СЏ С‰Рµ РЅРµ Р·Р°РїСѓСЃРєР°Р»Р°СЃСЊ." },
  ru: { agent: "РђРіРµРЅС‚", lastRun: "РџРѕСЃР»РµРґРЅРёР№ Р·Р°РїСѓСЃРє", automaticAgent: "Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРёР№ РІС‹Р±РѕСЂ", none: "РђРІС‚РѕРјР°С‚РёР·Р°С†РёР№ РїРѕРєР° РЅРµС‚.", cancelled: "РћС‚РјРµРЅРµРЅРѕ", stopped: "РћСЃС‚Р°РЅРѕРІР»РµРЅРѕ РїРѕ Р·Р°РїСЂРѕСЃСѓ РґРѕ Р·Р°РІРµСЂС€РµРЅРёСЏ; СЂРµР·СѓР»СЊС‚Р°С‚Р° РЅРµС‚.", noRuns: "Р­С‚Р° Р°РІС‚РѕРјР°С‚РёР·Р°С†РёСЏ РµС‰С‘ РЅРµ Р·Р°РїСѓСЃРєР°Р»Р°СЃСЊ." },
  de: { agent: "Agent", lastRun: "Letzter Lauf", automaticAgent: "automatische Auswahl", none: "Es sind keine Automatisierungen eingerichtet.", cancelled: "Abgebrochen", stopped: "Auf Anfrage vor dem Ende gestoppt; es gibt kein Ergebnis.", noRuns: "Diese Automatisierung ist noch nicht gelaufen." },
  es: { agent: "Agente", lastRun: "Гљltima ejecuciГіn", automaticAgent: "selecciГіn automГЎtica", none: "No hay automatizaciones configuradas.", cancelled: "Cancelada", stopped: "Detenida a peticiГіn antes de terminar; no hay resultado.", noRuns: "Esta automatizaciГіn aГєn no se ha ejecutado." },
  fr: { agent: "Agent", lastRun: "DerniГЁre exГ©cution", automaticAgent: "sГ©lection automatique", none: "Aucune automatisation n'est configurГ©e.", cancelled: "AnnulГ©e", stopped: "ArrГЄtГ©e sur demande avant la fin ; aucun rГ©sultat.", noRuns: "Cette automatisation nвЂ™a pas encore Г©tГ© exГ©cutГ©e." },
  it: { agent: "Agente", lastRun: "Ultima esecuzione", automaticAgent: "selezione automatica", none: "Nessuna automazione configurata.", cancelled: "Annullata", stopped: "Interrotta su richiesta prima della fine; nessun risultato.", noRuns: "Questa automazione non ГЁ ancora stata eseguita." },
  pl: { agent: "Agent", lastRun: "Ostatnie uruchomienie", automaticAgent: "wybГіr automatyczny", none: "Brak skonfigurowanych automatyzacji.", cancelled: "Anulowano", stopped: "Zatrzymano na ЕјД…danie przed zakoЕ„czeniem; brak wyniku.", noRuns: "Ta automatyzacja jeszcze siД™ nie uruchomiЕ‚a." },
  pt: { agent: "Agente", lastRun: "Гљltima execuГ§ГЈo", automaticAgent: "seleГ§ГЈo automГЎtica", none: "Nenhuma automaГ§ГЈo configurada.", cancelled: "Cancelada", stopped: "Interrompida a pedido antes de terminar; nГЈo hГЎ resultado.", noRuns: "Esta automaГ§ГЈo ainda nГЈo foi executada." },
};
export function automationListLabels(message = "") {
  return automationListCopy[detectCompanyChatLanguage(message)] ?? automationListCopy.en!;
}

export function workspaceCardCopy(message = ""): CardCopy & { paused: string } {
  const language = detectCompanyChatLanguage(message);
  const paused: Partial<Record<CompanyChatLanguage, string>> = { en: "Paused", uk: "РџСЂРёР·СѓРїРёРЅРµРЅРѕ", ru: "РџСЂРёРѕСЃС‚Р°РЅРѕРІР»РµРЅРѕ", de: "Pausiert", es: "Pausada", pt: "Pausada", fr: "En pause", it: "In pausa", pl: "Wstrzymano" };
  return { ...(cardCopies[language] ?? cardCopies.en!), paused: paused[language] ?? "Paused" };
}

const visionUnavailableCopy: Partial<Record<CompanyChatLanguage, string>> = {
  uk: "Р”Р»СЏ СЂРѕР±РѕС‚Рё Р· С„РѕС‚Рѕ РїРѕС‚СЂС–Р±РЅР° РїС–РґРєР»СЋС‡РµРЅР° РјРѕРґРµР»СЊ С–Р· РїС–РґС‚СЂРёРјРєРѕСЋ Р·РѕР±СЂР°Р¶РµРЅСЊ. РћР±РµСЂС–С‚СЊ С—С— РІ РЅР°Р»Р°С€С‚СѓРІР°РЅРЅСЏС… AI.",
  ru: "Р”Р»СЏ СЂР°Р±РѕС‚С‹ СЃ С„РѕС‚Рѕ РЅСѓР¶РЅР° РїРѕРґРєР»СЋС‡С‘РЅРЅР°СЏ РјРѕРґРµР»СЊ СЃ РїРѕРґРґРµСЂР¶РєРѕР№ РёР·РѕР±СЂР°Р¶РµРЅРёР№. Р’С‹Р±РµСЂРёС‚Рµ РµС‘ РІ РЅР°СЃС‚СЂРѕР№РєР°С… AI.",
  de: "FГјr Fotos wird ein verbundenes Modell mit BildunterstГјtzung benГ¶tigt. WГ¤hlen Sie es in den AI-Einstellungen aus.",
  es: "Para trabajar con fotos se necesita un modelo conectado que admita imГЎgenes. ElГ­gelo en la configuraciГіn de IA.",
  pt: "Para trabalhar com fotos Г© necessГЎrio um modelo conectado com suporte a imagens. Escolha-o nas configuraГ§Гµes de IA.",
};
/** The reply when no connected provider confirms a model that can read the attached image. */
export function visionUnavailableMessage(message = ""): string {
  return visionUnavailableCopy[detectCompanyChatLanguage(message)] ?? "Working with photos needs a connected model that supports images. Choose one in AI settings.";
}

const capabilityAgentCopy: Partial<Record<CompanyChatLanguage, (tool: string, company: string) => string>> = {
  uk: (tool, company) => `Р–РѕРґРµРЅ Р°РєС‚РёРІРЅРёР№ Р°РіРµРЅС‚ РєРѕРјРїР°РЅС–С— В«${company}В» РЅРµ РјР°С” С–РЅСЃС‚СЂСѓРјРµРЅС‚Р° \`${tool}\`, С‚РѕР¶ СЏ РЅС–С‡РѕРіРѕ РЅРµ Р·РјС–РЅСЋРІР°РІ Сѓ РґР°РЅРёС…. Р’Р»Р°СЃРЅРёРє РјРѕР¶Рµ РІРёРґР°С‚Рё С†РµР№ С–РЅСЃС‚СЂСѓРјРµРЅС‚ Р°РіРµРЅС‚РѕРІС– РЅР° СЃС‚РѕСЂС–РЅС†С– Р°РіРµРЅС‚С–РІ РєРѕРјРїР°РЅС–С— Р№ РїРѕРІС‚РѕСЂРёС‚Рё Р·Р°РїРёС‚.`,
  ru: (tool, company) => `РќРё Сѓ РѕРґРЅРѕРіРѕ Р°РєС‚РёРІРЅРѕРіРѕ Р°РіРµРЅС‚Р° РєРѕРјРїР°РЅРёРё В«${company}В» РЅРµС‚ РёРЅСЃС‚СЂСѓРјРµРЅС‚Р° \`${tool}\`, РїРѕСЌС‚РѕРјСѓ СЏ РЅРёС‡РµРіРѕ РЅРµ РјРµРЅСЏР» РІ РґР°РЅРЅС‹С…. Р’Р»Р°РґРµР»РµС† РјРѕР¶РµС‚ РІС‹РґР°С‚СЊ СЌС‚РѕС‚ РёРЅСЃС‚СЂСѓРјРµРЅС‚ Р°РіРµРЅС‚Сѓ РЅР° СЃС‚СЂР°РЅРёС†Рµ Р°РіРµРЅС‚РѕРІ РєРѕРјРїР°РЅРёРё Рё РїРѕРІС‚РѕСЂРёС‚СЊ Р·Р°РїСЂРѕСЃ.`,
  de: (tool, company) => `Kein aktiver Agent der Firma вЂћ${company}вЂњ hat das Werkzeug \`${tool}\`, daher habe ich keine Daten geГ¤ndert. Der Inhaber kann es einem Agenten auf der Agentenseite der Firma zuweisen und die Anfrage wiederholen.`,
  es: (tool, company) => `NingГєn agente activo de la empresa В«${company}В» tiene la herramienta \`${tool}\`, asГ­ que no cambiГ© ningГєn dato. El propietario puede asignarla a un agente en la pГЎgina de agentes de la empresa y repetir la solicitud.`,
  pt: (tool, company) => `Nenhum agente ativo da empresa В«${company}В» tem a ferramenta \`${tool}\`, por isso nГЈo alterei nenhum dado. O proprietГЎrio pode atribuГ­-la a um agente na pГЎgina de agentes da empresa e repetir o pedido.`,
};
const capabilityModelCopy: Partial<Record<CompanyChatLanguage, string>> = {
  uk: "РћР±СЂР°РЅР° РјРѕРґРµР»СЊ РЅРµ РІРјС–С” РІРёРєР»РёРєР°С‚Рё СЃС‚СЂСѓРєС‚СѓСЂРѕРІР°РЅС– С–РЅСЃС‚СЂСѓРјРµРЅС‚Рё, С‚РѕР¶ СЏ РЅС–С‡РѕРіРѕ РЅРµ Р·РјС–РЅСЋРІР°РІ Сѓ РґР°РЅРёС…. РћР±РµСЂС–С‚СЊ РјРѕРґРµР»СЊ С–Р· РїС–РґС‚СЂРёРјРєРѕСЋ tool calling Сѓ РЅР°Р»Р°С€С‚СѓРІР°РЅРЅСЏС… AI.",
  ru: "Р’С‹Р±СЂР°РЅРЅР°СЏ РјРѕРґРµР»СЊ РЅРµ СѓРјРµРµС‚ РІС‹Р·С‹РІР°С‚СЊ СЃС‚СЂСѓРєС‚СѓСЂРёСЂРѕРІР°РЅРЅС‹Рµ РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹, РїРѕСЌС‚РѕРјСѓ СЏ РЅРёС‡РµРіРѕ РЅРµ РјРµРЅСЏР» РІ РґР°РЅРЅС‹С…. Р’С‹Р±РµСЂРёС‚Рµ РјРѕРґРµР»СЊ СЃ РїРѕРґРґРµСЂР¶РєРѕР№ tool calling РІ РЅР°СЃС‚СЂРѕР№РєР°С… AI.",
  de: "Das gewГ¤hlte Modell kann keine strukturierten Werkzeuge aufrufen, daher habe ich keine Daten geГ¤ndert. WГ¤hlen Sie in den AI-Einstellungen ein Modell mit Tool-Calling.",
  es: "El modelo elegido no puede llamar herramientas estructuradas, asГ­ que no cambiГ© ningГєn dato. Elige un modelo con tool calling en la configuraciГіn de IA.",
  pt: "O modelo escolhido nГЈo consegue chamar ferramentas estruturadas, por isso nГЈo alterei nenhum dado. Escolha um modelo com tool calling nas configuraГ§Гµes de IA.",
};
/** The reply when a structured project capability has no authorized executor; nothing is executed and no rights are granted. */
export function projectCapabilityUnavailableMessage(input: { message: string; tool: string; company: string; modelLacksTools: boolean }): string {
  const language = detectCompanyChatLanguage(input.message);
  if (input.modelLacksTools) return capabilityModelCopy[language] ?? "The selected model cannot call structured tools, so I did not change any data. Choose a model with tool calling in AI settings.";
  return capabilityAgentCopy[language]?.(input.tool, input.company)
    ?? `No active agent of company "${input.company}" has the \`${input.tool}\` tool, so I did not change any data. The owner can grant this tool to an agent on the company's Agents page and repeat the request.`;
}

/**
 * The check ran, but the page's own script comes from an outside host the check does not open (a game engine from a
 * CDN), so what that script draws was never run. Saying "passed" would claim a game nobody saw (V6 step 07).
 */
export function browserCheckScriptBlockedNotice(language: CompanyChatLanguage, hosts: string[]): string {
  const list = hosts.join(", ");
  if (language === "uk") return `вљ пёЏ РќРµ РїРµСЂРµРІС–СЂРµРЅРѕ РїРѕРІРЅС–СЃС‚СЋ: СЃС‚РѕСЂС–РЅРєР° Р·Р°РІР°РЅС‚Р°Р¶СѓС” СЃРєСЂРёРїС‚ Р· ${list}, Р° Р°РІС‚РѕРјР°С‚РёС‡РЅР° РїРµСЂРµРІС–СЂРєР° Р·РѕРІРЅС–С€РЅС– СЃРµСЂРІРµСЂРё РЅРµ РІС–РґРєСЂРёРІР°С”, С‚РѕР¶ С‚Рµ, С‰Рѕ РјР°Р»СЋС” С†РµР№ СЃРєСЂРёРїС‚ (РЅР°РїСЂРёРєР»Р°Рґ, РіСЂСѓ), РЅРµ Р·Р°РїСѓСЃРєР°Р»РѕСЃСЏ. РџРµСЂРµРІС–СЂС‚Рµ РІ Preview.`;
  if (language === "ru") return `вљ пёЏ РџСЂРѕРІРµСЂРµРЅРѕ РЅРµ РїРѕР»РЅРѕСЃС‚СЊСЋ: СЃС‚СЂР°РЅРёС†Р° Р·Р°РіСЂСѓР¶Р°РµС‚ СЃРєСЂРёРїС‚ СЃ ${list}, Р° Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєР°СЏ РїСЂРѕРІРµСЂРєР° РІРЅРµС€РЅРёРµ СЃРµСЂРІРµСЂС‹ РЅРµ РѕС‚РєСЂС‹РІР°РµС‚, РїРѕСЌС‚РѕРјСѓ С‚Рѕ, С‡С‚Рѕ СЂРёСЃСѓРµС‚ СЌС‚РѕС‚ СЃРєСЂРёРїС‚ (РЅР°РїСЂРёРјРµСЂ, РёРіСЂСѓ), РЅРµ Р·Р°РїСѓСЃРєР°Р»РѕСЃСЊ. РџСЂРѕРІРµСЂСЊС‚Рµ РІ Preview.`;
  if (language === "en") return `вљ пёЏ Not fully verified: the page loads its script from ${list}, and the automatic check does not open outside servers, so what that script draws (such as a game) was not run. Please check it in Preview.`;
  return `${browserCheckUnavailableNotice(language)} (${list})`;
}
