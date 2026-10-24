/** Deterministic intent signals for workspace chat actions (moved from workspace-chat-actions.ts). */
export const actionSignals = [
  /\b(?:create|add|schedule|run|start|save|remember|generate|write|prepare|configure|edit|update|change|delete|remove|pause|resume|cancel|disable|enable|deactivate|activate|turn\s+(?:on|off))\b/iu,
  /(?:створ|дод|заплан|запуст|почн|збереж|запам.?ят|генер|напиш|підгот|налашт|редаг|змін|онов|видал|приб|призуп|віднов|скас|вимкн|увімкн|вмикн|деактив)/iu,
  /(?:cré\p{L}*|ajout\p{L}*|planifi\p{L}*|lanc\p{L}*|enregistr\p{L}*|mémoris\p{L}*|génér\p{L}*|écri\p{L}*|configur\p{L}*|modifi\p{L}*|mettr\p{L}* à jour|supprim\p{L}*|retir\p{L}*|suspend\p{L}*|repren\p{L}*|annul\p{L}*)/iu,
  /(?:erstell\p{L}*|hinzufüg\p{L}*|plan\p{L}*|start\p{L}*|speicher\p{L}*|merk\p{L}*|generier\p{L}*|schreib\p{L}*|konfigurier\p{L}*|bearbeit\p{L}*|aktualisier\p{L}*|änder\p{L}*|lösch\p{L}*|entfern\p{L}*|pausier\p{L}*|fortsetz\p{L}*|abbrech\p{L}*)/iu,
  /(?:crea\p{L}*|añad\p{L}*|program\p{L}*|inici\p{L}*|guard\p{L}*|record\p{L}*|gener\p{L}*|escri\p{L}*|configur\p{L}*|edit\p{L}*|actualiz\p{L}*|cambi\p{L}*|elimin\p{L}*|borr\p{L}*|paus\p{L}*|reanud\p{L}*|cancel\p{L}*)/iu,
  /(?:crea\p{L}*|aggiung\p{L}*|pianific\p{L}*|avvi\p{L}*|salv\p{L}*|ricord\p{L}*|gener\p{L}*|scriv\p{L}*|configur\p{L}*|modific\p{L}*|aggiorn\p{L}*|cambi\p{L}*|elimin\p{L}*|rimuov\p{L}*|sospend\p{L}*|riprend\p{L}*|annull\p{L}*)/iu,
  /(?:utwórz|dodaj|zaplanuj|uruchom|zapisz|zapamiętaj|wygeneruj|napisz|skonfiguruj|edytuj|zaktualizuj|zmień|usuń|wstrzymaj|wznów|anuluj)/iu,
  /(?:cri\p{L}*|adicion\p{L}*|agend\p{L}*|inici\p{L}*|salv\p{L}*|lembr\p{L}*|ger\p{L}*|escrev\p{L}*|configur\p{L}*|edit\p{L}*|atualiz\p{L}*|alter\p{L}*|exclu\p{L}*|remov\p{L}*|paus\p{L}*|retom\p{L}*|cancel\p{L}*)/iu,
  /(?:maak|maken|toevoeg\p{L}*|plan\p{L}*|start\p{L}*|opsla\p{L}*|onthoud\p{L}*|genere\p{L}*|schrijf\p{L}*|configure\p{L}*|bewerk\p{L}*|werk\p{L}* bij|wijzig\p{L}*|verwijder\p{L}*|pauzeer\p{L}*|hervat\p{L}*|annuleer\p{L}*)/iu,
  /(?:oluştur|ekle|planla|başlat|kaydet|hatırla|üret|yaz|yapılandır|düzenle|güncelle|değiştir|sil|kaldır|duraklat|sürdür|iptal)/iu,
  /(?:созда|добав|заплан|запуст|сохран|запом|сгенер|напиш|настро|редакт|измен|обнов|удал|приостанов|возобнов|отмен)/iu,
  /(?:创建|新增|添加|安排|运行|开始|保存|记住|生成|撰写|配置|编辑|更新|修改|删除|移除|暂停|恢复|取消)/u,
  /(?:作成|追加|予定|実行|開始|保存|記憶|生成|書いて|設定|編集|更新|変更|削除|一時停止|再開|キャンセル)/u,
  /(?:생성|추가|예약|실행|시작|저장|기억|작성|설정|편집|업데이트|변경|삭제|제거|일시 중지|재개|취소)/u,
  /(?:أنشئ|إنشاء|أضف|جدول|شغل|ابدأ|احفظ|تذكر|اكتب|كوّن|حرر|حدث|غيّر|احذف|أزل|أوقف|استأنف|ألغ)/u,
  /(?:बनाएं|बनाओ|जोड़ें|शेड्यूल|चलाएं|शुरू|सहेजें|याद|लिखें|कॉन्फ़िगर|संपादित|अपडेट|बदलें|हटाएं|रोकें|फिर शुरू|रद्द)/u,
];

export const resourceSignals = [
  /\b(?:activit(?:y|ies)|run trace|execution trace|automation|scheduled task|cron job|content hub|article|seo blueprint|social draft|business memory|memory item|memory|brand voice|audience profile)\b/iu,
  /(?:активност|трасуван|запуск|автоматизац|запланован.*завдан|контент|статт|seo|соціальн.*допис|пам.?ят|мемор|тон.*бренд|аудитор)/iu,
  /(?:activité|trace d.exécution|automatisation|tâche planifiée|contenu|article|mémoire|voix de marque|audience)/iu,
  /(?:aktivität|ausführungsspur|automatisierung|geplante aufgabe|inhalt|artikel|gedächtnis|markenstimme|zielgruppe)/iu,
  /(?:actividad|traza de ejecución|automatización|tarea programada|contenido|artículo|memoria|voz de marca|audiencia)/iu,
  /(?:attività|traccia di esecuzione|automazione|attività pianificata|contenuto|articolo|memoria|voce del marchio|pubblico)/iu,
  /(?:aktywno\p{L}*|ślad wykonania|automatyza\p{L}*|zaplanowane zadanie|treś\p{L}*|artyku\p{L}*|pamię\p{L}*|głos marki|odbiorcy)/iu,
  /(?:atividade|rastreamento de execução|automação|tarefa agendada|conteúdo|artigo|memória|voz da marca|público)/iu,
  /(?:activiteit|uitvoeringstrace|automatisering|geplande taak|inhoud|artikel|geheugen|merkstem|doelgroep)/iu,
  /(?:etkinlik|çalıştırma izi|otomasyon|zamanlanmış görev|içerik|makale|hafıza|marka sesi|hedef kitle)/iu,
  /(?:активност|трассиров|запуск|автоматизац|запланирован.*задач|контент|стать|памят|голос.*бренд|аудитор)/iu,
  /(?:活动|运行跟踪|执行跟踪|自动化|定时任务|内容|文章|记忆|品牌语气|受众)/u,
  /(?:アクティビティ|実行トレース|自動化|スケジュール.*タスク|コンテンツ|記事|メモリ|ブランドボイス|対象者)/u,
  /(?:활동|실행 추적|자동화|예약 작업|콘텐츠|기사|메모리|브랜드 보이스|대상 고객)/u,
  /(?:نشاط|تتبع التنفيذ|أتمتة|مهمة مجدولة|محتوى|مقال|ذاكرة|صوت العلامة|الجمهور)/u,
  /(?:गतिविधि|निष्पादन ट्रेस|ऑटोमेशन|निर्धारित कार्य|सामग्री|लेख|मेमोरी|ब्रांड वॉइस|दर्शक)/u,
];

export const mutationSignals = [
  /\b(?:edit|update|change|delete|remove|pause|resume|cancel)\b/iu,
  /(?:редаг|змін|онов|видал|приб|призуп|віднов|скас)/iu,
  /(?:modifi|mettre à jour|supprim|retir|suspend|repren|annul)/iu,
  /(?:bearbeit|aktualisier|änder|lösch|entfern|pausier|fortsetz|abbrech)/iu,
  /(?:edit|actualiz|cambi|elimin|borr|paus|reanud|cancel)/iu,
  /(?:modific|aggiorn|cambi|elimin|rimuov|sospend|riprend|annull)/iu,
  /(?:edytuj|zaktualizuj|zmień|usuń|wstrzymaj|wznów|anuluj)/iu,
  /(?:edit|atualiz|alter|exclu|remov|paus|retom|cancel)/iu,
  /(?:bewerk|werk.*bij|wijzig|verwijder|pauzeer|hervat|annuleer)/iu,
  /(?:düzenle|güncelle|değiştir|sil|kaldır|duraklat|sürdür|iptal)/iu,
  /(?:редакт|измен|обнов|удал|приостанов|возобнов|отмен)/iu,
  /(?:编辑|更新|修改|删除|移除|暂停|恢复|取消)/u,
  /(?:編集|更新|変更|削除|一時停止|再開|キャンセル)/u,
  /(?:편집|업데이트|변경|삭제|제거|일시 중지|재개|취소)/u,
  /(?:حرر|حدث|غيّر|احذف|أزل|أوقف|استأنف|ألغ)/u,
  /(?:संपादित|अपडेट|बदलें|हटाएं|रोकें|फिर शुरू|रद्द)/u,
];
export const referenceSignals = [
  /\b(?:it|this|that|one|last|previous)\b/iu,
  /(?:її|його|це|цю|цей|останн|попередн)/iu,
  /\b(?:le|la|les|ceci|cela|dernier|précédent)\b/iu,
  /\b(?:es|dies|diese|letzte|vorherige)\b/iu,
  /\b(?:lo|la|esto|esta|últim|anterior)\b/iu,
  /\b(?:lo|la|quest|ultim|precedent)\b/iu,
  /\b(?:to|ten|ta|ostatni|poprzedni)\b/iu,
  /\b(?:isso|isto|este|esta|últim|anterior)\b/iu,
  /\b(?:het|dit|deze|laatste|vorige)\b/iu,
  /\b(?:onu|bunu|şunu|son|önceki)\b/iu,
  /(?:её|его|это|эту|этот|последн|предыдущ)/iu,
  /(?:它|这个|这条|最后|上一个)/u,
  /(?:それ|これ|この|最後|前の)/u,
  /(?:그것|이것|이 항목|마지막|이전)/u,
  /(?:إياه|إياها|هذا|هذه|الأخير|السابق)/u,
  /(?:इसे|यह|इसको|अंतिम|पिछल)/u,
];

// Brand voice and audience are also Company / Business Profile fields: they only name a memory resource when the
// request is not about a company or business profile ("Create company X. Brand tone: warm" creates a company).
export const profileFieldTerms = /(?:brand\s+(?:voice|tone)|audience(?:\s+profile)?|тон\p{L}*\s+бренд\p{L}*|аудитор\p{L}*|voix de marque|markenstimme|zielgruppe|voz de marca|audiencia|voce del marchio|pubblico|głos marki|odbiorcy|voz da marca|público|merkstem|doelgroep|marka sesi|hedef kitle|голос\p{L}*\s+бренд\p{L}*|品牌语气|受众)/giu;
export const profileEntitySignal = /(?:компан\p{L}*|бізнес[- ]?профіл\p{L}*|бизнес[- ]?профил\p{L}*|\bcompan(?:y|ies)\b|business\s+profile|entreprise|unternehmen|empresa|azienda|perfil\s+de\s+neg[óo]cio|bedrijf|şirket|公司)/iu;

// An imperative "Remember ..." is a memory action by its verb alone (Ukrainian "запам'ятай" already contains "пам'ят");
// "Do you remember ...?" is a question, not an action.
/** "Remember … in this chat / as this conversation checkpoint": conversation-scoped, never a durable Memory write. */
export const conversationScopedRemember = /(?:(?:this|current)\s+(?:conversation|chat)|in\s+this\s+chat|(?:цьому|цієї|поточному)\s+(?:чаті|розмові|чату|розмови)|(?:этом|этого|текущем)\s+(?:чате|разговоре|чата)|(?:este|esta)\s+(?:chat|conversaci[oó]n|conversa)|nesta\s+conversa|neste\s+chat|(?:diesem|dieses|diesen)\s+(?:chat|gespr[aä]ch))/iu;
export const memoryVerbSignal = /(?:^|[.!?;:]\s+)(?:please\s+|por favor,?\s+|bitte\s+)?(?:remember|merk(?:e|t)?\s+dir|merken?\s+sie|recuerd[ae]|lembr[ae](?:-?se)?|m[ée]morise|ricorda|zapamiętaj|onthoud|hatırla|запомни)(?![\p{L}])/iu;

/** Researching or analysing websites is reading them, not managing the campaign's website targets. */
export const researchVerbSignal = /(?:\bresearch\b|recherch\p{L}*|pesquis\p{L}*|investiga\p{L}*|\bsearch\b|\banaly[sz]e\b|analysier\p{L}*|\bcompare\b|vergleich\p{L}*|досліди\p{L}*|дослідж\p{L}*|проаналізуй|порівня\p{L}*|знайди\s+в\s+інтернеті)/iu;

export const automationReadSignals = [
  /\b(?:list|show|which|when|status|history|runs?|tasks?|websites?|sites?)\b/iu,
  /(?:покажи|перегля|список|який|яка|які|коли|статус|історі|запуск|завдан|сайт)/iu,
];
export const websiteResourceSignals = [
  /\b(?:website registration|website publishing|browser campaign|campaign sites?|websites|sites)\b/iu,
  /(?:реєстрац\p{L}*.*сайт|публікац\p{L}*.*сайт|сайт\p{L}*.*(?:реєстрац|публікац)|сайти|сайтів|вебсайти|вебсайтів)/iu,
  /(?:автоматизац\p{L}*|запланован\p{L}*.*завдан|агент\p{L}*.*завдан)/iu,
];
