/**
 * Texts of the confirmation cards in chat, in the 16 chat languages. A card speaks the language the person writes in
 * (the run's response language, else the language of their last message), not only the interface language, so
 * someone writing Ukrainian in an English interface still understands what the agent asks.
 */
export const APPROVAL_LANGUAGES = ["en", "uk", "ru", "de", "fr", "es", "it", "pl", "pt", "nl", "tr", "zh", "ja", "ko", "ar", "hi"] as const;
export type ApprovalLanguage = typeof APPROVAL_LANGUAGES[number];

export interface ApprovalCopy {
  /** Run card (coding agent). */
  permissionTitle: string; wantsToRun: string; policies: string; allow: string; reject: string; saving: string;
  always: string; alwaysHint: string;
  schema: Record<"add_check" | "drop_check" | "drop_foreign_key" | "drop_field" | "drop_collection" | "rename_field" | "rename_collection" | "alter_field", string>;
  rule: Record<"public" | "authenticated" | "owner" | "role", string>;
  rowsDelete: (table: string, where: string) => string;
  rowsUpdate: (table: string, values: string, where: string) => string;
  filesDelete: (paths: string) => string;
  roles: (email: string, roles: string) => string;
  attach: (from: string, to: string) => string;
  /** Plain names of actions whose request carries no details worth showing. */
  tool: Record<"shell" | "files" | "fileDelete" | "deps" | "git" | "data" | "deploy" | "memory" | "email" | "other", string>;
  /** Company agent card. */
  confirmTitle: string; approve: string; resume: string; pending: string; approved: string; rejected: string; expired: string;
  completed: string; failed: string; cancelled: string; working: string; used: string;
}

const copies: Record<ApprovalLanguage, ApprovalCopy> = {
  en: {
    permissionTitle: "Your permission is needed", wantsToRun: "The agent wants to:", policies: "The agent wants to set who can use these database tables:",
    allow: "Allow", reject: "Reject", saving: "Saving…", always: "Allow and don't ask again",
    alwaysHint: "The agents of this company will act without asking (git writes still ask). You can turn this off in the company settings.",
    schema: { add_check: "Add a value rule", drop_check: "Remove the value rule", drop_foreign_key: "Remove the foreign key (the column stays)", drop_field: "Delete the column", drop_collection: "Delete the table", rename_field: "Rename the column", rename_collection: "Rename the table", alter_field: "Change the column type" },
    rule: { public: "anyone", authenticated: "signed-in users", owner: "the owner of the row", role: "a set role" },
    rowsDelete: (t, w) => `Delete rows from ${t} where ${w}.`, rowsUpdate: (t, v, w) => `In ${t} set ${v} where ${w}.`, filesDelete: p => `Delete the file: ${p}.`,
    roles: (e, r) => `Give ${e} the roles: ${r}.`, attach: (f, t) => `«${t}» will use the database of «${f}».`,
    tool: { shell: "Run a command in the terminal", files: "Change project files", fileDelete: "Delete a file", deps: "Install or change packages", git: "Write to git (commit or push)", data: "Change the database", deploy: "Publish the project", memory: "Change the company memory", email: "Send an email", other: "Run this action" },
    confirmTitle: "Confirmation required", approve: "Approve", resume: "Continue", pending: "Waiting for your decision", approved: "Approved", rejected: "Rejected", expired: "Expired", completed: "Done", failed: "Failed", cancelled: "Cancelled", working: "Working…", used: "This confirmation was already used",
  },
  uk: {
    permissionTitle: "Потрібен ваш дозвіл", wantsToRun: "Агент хоче:", policies: "Агент хоче встановити, хто може користуватися цими таблицями бази даних:",
    allow: "Дозволити", reject: "Відхилити", saving: "Зберігаю…", always: "Дозволити і більше не питати",
    alwaysHint: "Агенти цієї компанії діятимуть без підтвердження (запис у git і далі питатиме). Вимкнути можна в налаштуваннях компанії.",
    schema: { add_check: "Додати правило значень", drop_check: "Зняти правило значень", drop_foreign_key: "Зняти зовнішній ключ (колонка лишиться)", drop_field: "Видалити колонку", drop_collection: "Видалити таблицю", rename_field: "Перейменувати колонку", rename_collection: "Перейменувати таблицю", alter_field: "Змінити тип колонки" },
    rule: { public: "будь-хто", authenticated: "зареєстровані користувачі", owner: "власник запису", role: "певна роль" },
    rowsDelete: (t, w) => `Видалити рядки з ${t}, де ${w}.`, rowsUpdate: (t, v, w) => `У ${t} встановити ${v}, де ${w}.`, filesDelete: p => `Видалити файл: ${p}.`,
    roles: (e, r) => `Дати ${e} ролі: ${r}.`, attach: (f, t) => `«${t}» буде використовувати базу даних проєкту «${f}».`,
    tool: { shell: "Виконати команду в терміналі", files: "Змінити файли проєкту", fileDelete: "Видалити файл", deps: "Встановити або змінити пакети", git: "Записати в git (commit чи push)", data: "Змінити базу даних", deploy: "Опублікувати проєкт", memory: "Змінити пам'ять компанії", email: "Надіслати лист", other: "Виконати цю дію" },
    confirmTitle: "Потрібне підтвердження", approve: "Підтвердити", resume: "Продовжити", pending: "Очікує вашого рішення", approved: "Підтверджено", rejected: "Відхилено", expired: "Термін минув", completed: "Виконано", failed: "Помилка", cancelled: "Скасовано", working: "Виконується…", used: "Це підтвердження вже використано",
  },
  ru: {
    permissionTitle: "Нужно ваше разрешение", wantsToRun: "Агент хочет:", policies: "Агент хочет задать, кто может пользоваться этими таблицами базы данных:",
    allow: "Разрешить", reject: "Отклонить", saving: "Сохраняю…", always: "Разрешить и больше не спрашивать",
    alwaysHint: "Агенты этой компании будут действовать без подтверждения (запись в git по-прежнему спросит). Отключить можно в настройках компании.",
    schema: { add_check: "Добавить правило значений", drop_check: "Снять правило значений", drop_foreign_key: "Снять внешний ключ (колонка останется)", drop_field: "Удалить колонку", drop_collection: "Удалить таблицу", rename_field: "Переименовать колонку", rename_collection: "Переименовать таблицу", alter_field: "Изменить тип колонки" },
    rule: { public: "кто угодно", authenticated: "вошедшие пользователи", owner: "владелец записи", role: "заданная роль" },
    rowsDelete: (t, w) => `Удалить строки из ${t}, где ${w}.`, rowsUpdate: (t, v, w) => `В ${t} установить ${v}, где ${w}.`, filesDelete: p => `Удалить файл: ${p}.`,
    roles: (e, r) => `Дать ${e} роли: ${r}.`, attach: (f, t) => `«${t}» будет использовать базу данных проекта «${f}».`,
    tool: { shell: "Выполнить команду в терминале", files: "Изменить файлы проекта", fileDelete: "Удалить файл", deps: "Установить или изменить пакеты", git: "Записать в git (commit или push)", data: "Изменить базу данных", deploy: "Опубликовать проект", memory: "Изменить память компании", email: "Отправить письмо", other: "Выполнить это действие" },
    confirmTitle: "Требуется подтверждение", approve: "Подтвердить", resume: "Продолжить", pending: "Ожидает вашего решения", approved: "Подтверждено", rejected: "Отклонено", expired: "Срок истёк", completed: "Выполнено", failed: "Ошибка", cancelled: "Отменено", working: "Выполняется…", used: "Это подтверждение уже использовано",
  },
  de: {
    permissionTitle: "Ihre Erlaubnis wird benötigt", wantsToRun: "Der Agent möchte:", policies: "Der Agent möchte festlegen, wer diese Datenbanktabellen nutzen darf:",
    allow: "Erlauben", reject: "Ablehnen", saving: "Wird gespeichert…", always: "Erlauben und nicht mehr fragen",
    alwaysHint: "Die Agenten dieses Unternehmens handeln ohne Rückfrage (Git-Schreibvorgänge fragen weiterhin). Abschalten in den Unternehmenseinstellungen.",
    schema: { add_check: "Wertregel hinzufügen", drop_check: "Wertregel entfernen", drop_foreign_key: "Fremdschlüssel entfernen (die Spalte bleibt)", drop_field: "Spalte löschen", drop_collection: "Tabelle löschen", rename_field: "Spalte umbenennen", rename_collection: "Tabelle umbenennen", alter_field: "Spaltentyp ändern" },
    rule: { public: "alle", authenticated: "angemeldete Nutzer", owner: "der Eigentümer der Zeile", role: "eine festgelegte Rolle" },
    rowsDelete: (t, w) => `Zeilen aus ${t} löschen, wo ${w}.`, rowsUpdate: (t, v, w) => `In ${t} ${v} setzen, wo ${w}.`, filesDelete: p => `Datei löschen: ${p}.`,
    roles: (e, r) => `${e} die Rollen geben: ${r}.`, attach: (f, t) => `«${t}» nutzt die Datenbank von «${f}».`,
    tool: { shell: "Einen Befehl im Terminal ausführen", files: "Projektdateien ändern", fileDelete: "Eine Datei löschen", deps: "Pakete installieren oder ändern", git: "In Git schreiben (Commit oder Push)", data: "Die Datenbank ändern", deploy: "Das Projekt veröffentlichen", memory: "Das Unternehmensgedächtnis ändern", email: "Eine E-Mail senden", other: "Diese Aktion ausführen" },
    confirmTitle: "Bestätigung erforderlich", approve: "Bestätigen", resume: "Fortsetzen", pending: "Wartet auf Ihre Entscheidung", approved: "Bestätigt", rejected: "Abgelehnt", expired: "Abgelaufen", completed: "Erledigt", failed: "Fehler", cancelled: "Abgebrochen", working: "Wird ausgeführt…", used: "Diese Bestätigung wurde bereits verwendet",
  },
  fr: {
    permissionTitle: "Votre autorisation est nécessaire", wantsToRun: "L'agent veut :", policies: "L'agent veut définir qui peut utiliser ces tables de la base de données :",
    allow: "Autoriser", reject: "Refuser", saving: "Enregistrement…", always: "Autoriser et ne plus demander",
    alwaysHint: "Les agents de cette entreprise agiront sans demander (les écritures git demandent toujours). Désactivable dans les paramètres de l'entreprise.",
    schema: { add_check: "Ajouter une règle de valeurs", drop_check: "Retirer la règle de valeurs", drop_foreign_key: "Retirer la clé étrangère (la colonne reste)", drop_field: "Supprimer la colonne", drop_collection: "Supprimer la table", rename_field: "Renommer la colonne", rename_collection: "Renommer la table", alter_field: "Changer le type de la colonne" },
    rule: { public: "tout le monde", authenticated: "les utilisateurs connectés", owner: "le propriétaire de la ligne", role: "un rôle défini" },
    rowsDelete: (t, w) => `Supprimer les lignes de ${t} où ${w}.`, rowsUpdate: (t, v, w) => `Dans ${t}, mettre ${v} où ${w}.`, filesDelete: p => `Supprimer le fichier : ${p}.`,
    roles: (e, r) => `Donner à ${e} les rôles : ${r}.`, attach: (f, t) => `«${t}» utilisera la base de données de «${f}».`,
    tool: { shell: "Exécuter une commande dans le terminal", files: "Modifier les fichiers du projet", fileDelete: "Supprimer un fichier", deps: "Installer ou modifier des paquets", git: "Écrire dans git (commit ou push)", data: "Modifier la base de données", deploy: "Publier le projet", memory: "Modifier la mémoire de l'entreprise", email: "Envoyer un e-mail", other: "Exécuter cette action" },
    confirmTitle: "Confirmation requise", approve: "Approuver", resume: "Continuer", pending: "En attente de votre décision", approved: "Approuvé", rejected: "Refusé", expired: "Expiré", completed: "Terminé", failed: "Échec", cancelled: "Annulé", working: "En cours…", used: "Cette confirmation a déjà été utilisée",
  },
  es: {
    permissionTitle: "Se necesita tu permiso", wantsToRun: "El agente quiere:", policies: "El agente quiere definir quién puede usar estas tablas de la base de datos:",
    allow: "Permitir", reject: "Rechazar", saving: "Guardando…", always: "Permitir y no volver a preguntar",
    alwaysHint: "Los agentes de esta empresa actuarán sin preguntar (las escrituras en git siguen preguntando). Puedes desactivarlo en los ajustes de la empresa.",
    schema: { add_check: "Añadir una regla de valores", drop_check: "Quitar la regla de valores", drop_foreign_key: "Quitar la clave foránea (la columna se queda)", drop_field: "Eliminar la columna", drop_collection: "Eliminar la tabla", rename_field: "Renombrar la columna", rename_collection: "Renombrar la tabla", alter_field: "Cambiar el tipo de la columna" },
    rule: { public: "cualquiera", authenticated: "usuarios con sesión", owner: "el dueño de la fila", role: "un rol definido" },
    rowsDelete: (t, w) => `Eliminar filas de ${t} donde ${w}.`, rowsUpdate: (t, v, w) => `En ${t} poner ${v} donde ${w}.`, filesDelete: p => `Eliminar el archivo: ${p}.`,
    roles: (e, r) => `Dar a ${e} los roles: ${r}.`, attach: (f, t) => `«${t}» usará la base de datos de «${f}».`,
    tool: { shell: "Ejecutar un comando en la terminal", files: "Cambiar archivos del proyecto", fileDelete: "Eliminar un archivo", deps: "Instalar o cambiar paquetes", git: "Escribir en git (commit o push)", data: "Cambiar la base de datos", deploy: "Publicar el proyecto", memory: "Cambiar la memoria de la empresa", email: "Enviar un correo", other: "Ejecutar esta acción" },
    confirmTitle: "Se requiere confirmación", approve: "Aprobar", resume: "Continuar", pending: "Esperando tu decisión", approved: "Aprobado", rejected: "Rechazado", expired: "Caducado", completed: "Hecho", failed: "Error", cancelled: "Cancelado", working: "En curso…", used: "Esta confirmación ya se usó",
  },
  it: {
    permissionTitle: "Serve il tuo permesso", wantsToRun: "L'agente vuole:", policies: "L'agente vuole stabilire chi può usare queste tabelle del database:",
    allow: "Consenti", reject: "Rifiuta", saving: "Salvataggio…", always: "Consenti e non chiedere più",
    alwaysHint: "Gli agenti di questa azienda agiranno senza chiedere (le scritture git chiedono ancora). Puoi disattivarlo nelle impostazioni dell'azienda.",
    schema: { add_check: "Aggiungere una regola sui valori", drop_check: "Togliere la regola sui valori", drop_foreign_key: "Togliere la chiave esterna (la colonna resta)", drop_field: "Eliminare la colonna", drop_collection: "Eliminare la tabella", rename_field: "Rinominare la colonna", rename_collection: "Rinominare la tabella", alter_field: "Cambiare il tipo della colonna" },
    rule: { public: "chiunque", authenticated: "utenti registrati", owner: "il proprietario della riga", role: "un ruolo stabilito" },
    rowsDelete: (t, w) => `Eliminare le righe da ${t} dove ${w}.`, rowsUpdate: (t, v, w) => `In ${t} impostare ${v} dove ${w}.`, filesDelete: p => `Eliminare il file: ${p}.`,
    roles: (e, r) => `Dare a ${e} i ruoli: ${r}.`, attach: (f, t) => `«${t}» userà il database di «${f}».`,
    tool: { shell: "Eseguire un comando nel terminale", files: "Modificare i file del progetto", fileDelete: "Eliminare un file", deps: "Installare o modificare pacchetti", git: "Scrivere su git (commit o push)", data: "Modificare il database", deploy: "Pubblicare il progetto", memory: "Modificare la memoria dell'azienda", email: "Inviare un'email", other: "Eseguire questa azione" },
    confirmTitle: "Conferma richiesta", approve: "Approva", resume: "Continua", pending: "In attesa della tua decisione", approved: "Approvato", rejected: "Rifiutato", expired: "Scaduto", completed: "Fatto", failed: "Errore", cancelled: "Annullato", working: "In corso…", used: "Questa conferma è già stata usata",
  },
  pl: {
    permissionTitle: "Potrzebna jest Twoja zgoda", wantsToRun: "Agent chce:", policies: "Agent chce ustalić, kto może korzystać z tych tabel bazy danych:",
    allow: "Zezwól", reject: "Odrzuć", saving: "Zapisywanie…", always: "Zezwól i nie pytaj więcej",
    alwaysHint: "Agenci tej firmy będą działać bez pytania (zapis do git nadal zapyta). Wyłączysz to w ustawieniach firmy.",
    schema: { add_check: "Dodać regułę wartości", drop_check: "Usunąć regułę wartości", drop_foreign_key: "Usunąć klucz obcy (kolumna zostaje)", drop_field: "Usunąć kolumnę", drop_collection: "Usunąć tabelę", rename_field: "Zmienić nazwę kolumny", rename_collection: "Zmienić nazwę tabeli", alter_field: "Zmienić typ kolumny" },
    rule: { public: "każdy", authenticated: "zalogowani użytkownicy", owner: "właściciel wiersza", role: "określona rola" },
    rowsDelete: (t, w) => `Usunąć wiersze z ${t}, gdzie ${w}.`, rowsUpdate: (t, v, w) => `W ${t} ustawić ${v}, gdzie ${w}.`, filesDelete: p => `Usunąć plik: ${p}.`,
    roles: (e, r) => `Nadać ${e} role: ${r}.`, attach: (f, t) => `«${t}» będzie używać bazy danych «${f}».`,
    tool: { shell: "Uruchomić polecenie w terminalu", files: "Zmienić pliki projektu", fileDelete: "Usunąć plik", deps: "Zainstalować lub zmienić pakiety", git: "Zapisać do git (commit lub push)", data: "Zmienić bazę danych", deploy: "Opublikować projekt", memory: "Zmienić pamięć firmy", email: "Wysłać e-mail", other: "Wykonać tę czynność" },
    confirmTitle: "Wymagane potwierdzenie", approve: "Zatwierdź", resume: "Kontynuuj", pending: "Czeka na Twoją decyzję", approved: "Zatwierdzono", rejected: "Odrzucono", expired: "Wygasło", completed: "Gotowe", failed: "Błąd", cancelled: "Anulowano", working: "W toku…", used: "To potwierdzenie zostało już użyte",
  },
  pt: {
    permissionTitle: "É preciso a sua permissão", wantsToRun: "O agente quer:", policies: "O agente quer definir quem pode usar estas tabelas do banco de dados:",
    allow: "Permitir", reject: "Rejeitar", saving: "Salvando…", always: "Permitir e não perguntar mais",
    alwaysHint: "Os agentes desta empresa vão agir sem perguntar (gravações no git continuam perguntando). Dá para desligar nas configurações da empresa.",
    schema: { add_check: "Adicionar uma regra de valores", drop_check: "Remover a regra de valores", drop_foreign_key: "Remover a chave estrangeira (a coluna fica)", drop_field: "Excluir a coluna", drop_collection: "Excluir a tabela", rename_field: "Renomear a coluna", rename_collection: "Renomear a tabela", alter_field: "Mudar o tipo da coluna" },
    rule: { public: "qualquer pessoa", authenticated: "usuários conectados", owner: "o dono da linha", role: "um papel definido" },
    rowsDelete: (t, w) => `Excluir linhas de ${t} onde ${w}.`, rowsUpdate: (t, v, w) => `Em ${t} definir ${v} onde ${w}.`, filesDelete: p => `Excluir o arquivo: ${p}.`,
    roles: (e, r) => `Dar a ${e} os papéis: ${r}.`, attach: (f, t) => `«${t}» vai usar o banco de dados de «${f}».`,
    tool: { shell: "Executar um comando no terminal", files: "Alterar arquivos do projeto", fileDelete: "Excluir um arquivo", deps: "Instalar ou alterar pacotes", git: "Gravar no git (commit ou push)", data: "Alterar o banco de dados", deploy: "Publicar o projeto", memory: "Alterar a memória da empresa", email: "Enviar um e-mail", other: "Executar esta ação" },
    confirmTitle: "Confirmação necessária", approve: "Aprovar", resume: "Continuar", pending: "Aguardando sua decisão", approved: "Aprovado", rejected: "Rejeitado", expired: "Expirado", completed: "Concluído", failed: "Falhou", cancelled: "Cancelado", working: "Em andamento…", used: "Esta confirmação já foi usada",
  },
  nl: {
    permissionTitle: "Je toestemming is nodig", wantsToRun: "De agent wil:", policies: "De agent wil instellen wie deze databasetabellen mag gebruiken:",
    allow: "Toestaan", reject: "Weigeren", saving: "Opslaan…", always: "Toestaan en niet meer vragen",
    alwaysHint: "De agenten van dit bedrijf handelen zonder te vragen (schrijven naar git vraagt nog steeds). Uitzetten kan in de bedrijfsinstellingen.",
    schema: { add_check: "Een waarderegel toevoegen", drop_check: "De waarderegel verwijderen", drop_foreign_key: "De vreemde sleutel verwijderen (de kolom blijft)", drop_field: "De kolom verwijderen", drop_collection: "De tabel verwijderen", rename_field: "De kolom hernoemen", rename_collection: "De tabel hernoemen", alter_field: "Het kolomtype wijzigen" },
    rule: { public: "iedereen", authenticated: "ingelogde gebruikers", owner: "de eigenaar van de rij", role: "een vastgestelde rol" },
    rowsDelete: (t, w) => `Rijen uit ${t} verwijderen waar ${w}.`, rowsUpdate: (t, v, w) => `In ${t} ${v} instellen waar ${w}.`, filesDelete: p => `Het bestand verwijderen: ${p}.`,
    roles: (e, r) => `${e} de rollen geven: ${r}.`, attach: (f, t) => `«${t}» gebruikt de database van «${f}».`,
    tool: { shell: "Een opdracht in de terminal uitvoeren", files: "Projectbestanden wijzigen", fileDelete: "Een bestand verwijderen", deps: "Pakketten installeren of wijzigen", git: "Naar git schrijven (commit of push)", data: "De database wijzigen", deploy: "Het project publiceren", memory: "Het bedrijfsgeheugen wijzigen", email: "Een e-mail versturen", other: "Deze actie uitvoeren" },
    confirmTitle: "Bevestiging vereist", approve: "Goedkeuren", resume: "Doorgaan", pending: "Wacht op je beslissing", approved: "Goedgekeurd", rejected: "Geweigerd", expired: "Verlopen", completed: "Klaar", failed: "Mislukt", cancelled: "Geannuleerd", working: "Bezig…", used: "Deze bevestiging is al gebruikt",
  },
  tr: {
    permissionTitle: "İzniniz gerekiyor", wantsToRun: "Ajan şunu yapmak istiyor:", policies: "Ajan bu veritabanı tablolarını kimin kullanabileceğini belirlemek istiyor:",
    allow: "İzin ver", reject: "Reddet", saving: "Kaydediliyor…", always: "İzin ver ve bir daha sorma",
    alwaysHint: "Bu şirketin ajanları sormadan hareket edecek (git yazma işlemleri yine sorar). Şirket ayarlarından kapatabilirsiniz.",
    schema: { add_check: "Değer kuralı ekle", drop_check: "Değer kuralını kaldır", drop_foreign_key: "Yabancı anahtarı kaldır (sütun kalır)", drop_field: "Sütunu sil", drop_collection: "Tabloyu sil", rename_field: "Sütunu yeniden adlandır", rename_collection: "Tabloyu yeniden adlandır", alter_field: "Sütun türünü değiştir" },
    rule: { public: "herkes", authenticated: "giriş yapmış kullanıcılar", owner: "satırın sahibi", role: "belirli bir rol" },
    rowsDelete: (t, w) => `${t} tablosundan ${w} olan satırları sil.`, rowsUpdate: (t, v, w) => `${t} tablosunda ${w} olanlarda ${v} yap.`, filesDelete: p => `Dosyayı sil: ${p}.`,
    roles: (e, r) => `${e} kullanıcısına roller ver: ${r}.`, attach: (f, t) => `«${t}», «${f}» veritabanını kullanacak.`,
    tool: { shell: "Terminalde bir komut çalıştır", files: "Proje dosyalarını değiştir", fileDelete: "Bir dosyayı sil", deps: "Paket kur veya değiştir", git: "Git'e yaz (commit veya push)", data: "Veritabanını değiştir", deploy: "Projeyi yayınla", memory: "Şirket hafızasını değiştir", email: "E-posta gönder", other: "Bu işlemi çalıştır" },
    confirmTitle: "Onay gerekli", approve: "Onayla", resume: "Devam et", pending: "Kararınızı bekliyor", approved: "Onaylandı", rejected: "Reddedildi", expired: "Süresi doldu", completed: "Tamamlandı", failed: "Hata", cancelled: "İptal edildi", working: "Çalışıyor…", used: "Bu onay zaten kullanıldı",
  },
  zh: {
    permissionTitle: "需要您的许可", wantsToRun: "智能体想要：", policies: "智能体想设置谁可以使用这些数据库表：",
    allow: "允许", reject: "拒绝", saving: "正在保存…", always: "允许且不再询问",
    alwaysHint: "该公司的智能体将不经确认直接执行（写入 git 仍会询问）。可在公司设置中关闭。",
    schema: { add_check: "添加取值规则", drop_check: "移除取值规则", drop_foreign_key: "移除外键（列保留）", drop_field: "删除列", drop_collection: "删除表", rename_field: "重命名列", rename_collection: "重命名表", alter_field: "更改列类型" },
    rule: { public: "任何人", authenticated: "已登录用户", owner: "该行的所有者", role: "指定角色" },
    rowsDelete: (t, w) => `从 ${t} 删除满足 ${w} 的行。`, rowsUpdate: (t, v, w) => `在 ${t} 中将满足 ${w} 的行设为 ${v}。`, filesDelete: p => `删除文件：${p}。`,
    roles: (e, r) => `授予 ${e} 角色：${r}。`, attach: (f, t) => `«${t}» 将使用 «${f}» 的数据库。`,
    tool: { shell: "在终端中运行命令", files: "修改项目文件", fileDelete: "删除文件", deps: "安装或更改软件包", git: "写入 git（commit 或 push）", data: "修改数据库", deploy: "发布项目", memory: "修改公司记忆", email: "发送邮件", other: "执行此操作" },
    confirmTitle: "需要确认", approve: "批准", resume: "继续", pending: "等待您的决定", approved: "已批准", rejected: "已拒绝", expired: "已过期", completed: "已完成", failed: "失败", cancelled: "已取消", working: "执行中…", used: "此确认已被使用",
  },
  ja: {
    permissionTitle: "許可が必要です", wantsToRun: "エージェントが実行したい操作：", policies: "エージェントはこれらのデータベーステーブルを誰が使えるか設定しようとしています：",
    allow: "許可", reject: "拒否", saving: "保存中…", always: "許可して今後は確認しない",
    alwaysHint: "この会社のエージェントは確認なしで実行します（git への書き込みは引き続き確認します）。会社の設定でオフにできます。",
    schema: { add_check: "値のルールを追加", drop_check: "値のルールを削除", drop_foreign_key: "外部キーを削除（列は残ります）", drop_field: "列を削除", drop_collection: "テーブルを削除", rename_field: "列の名前を変更", rename_collection: "テーブルの名前を変更", alter_field: "列の型を変更" },
    rule: { public: "誰でも", authenticated: "ログイン中のユーザー", owner: "行の所有者", role: "指定したロール" },
    rowsDelete: (t, w) => `${t} から ${w} の行を削除します。`, rowsUpdate: (t, v, w) => `${t} の ${w} の行を ${v} に設定します。`, filesDelete: p => `ファイルを削除：${p}。`,
    roles: (e, r) => `${e} にロールを付与：${r}。`, attach: (f, t) => `«${t}» は «${f}» のデータベースを使います。`,
    tool: { shell: "ターミナルでコマンドを実行", files: "プロジェクトのファイルを変更", fileDelete: "ファイルを削除", deps: "パッケージをインストールまたは変更", git: "git に書き込む（commit または push）", data: "データベースを変更", deploy: "プロジェクトを公開", memory: "会社のメモリを変更", email: "メールを送信", other: "この操作を実行" },
    confirmTitle: "確認が必要です", approve: "承認", resume: "続行", pending: "ご判断をお待ちしています", approved: "承認済み", rejected: "拒否済み", expired: "期限切れ", completed: "完了", failed: "失敗", cancelled: "キャンセル済み", working: "実行中…", used: "この確認はすでに使用されています",
  },
  ko: {
    permissionTitle: "허락이 필요합니다", wantsToRun: "에이전트가 하려는 작업:", policies: "에이전트가 이 데이터베이스 테이블을 누가 사용할 수 있는지 설정하려고 합니다:",
    allow: "허용", reject: "거부", saving: "저장 중…", always: "허용하고 다시 묻지 않기",
    alwaysHint: "이 회사의 에이전트는 확인 없이 실행합니다(git 쓰기는 계속 묻습니다). 회사 설정에서 끌 수 있습니다.",
    schema: { add_check: "값 규칙 추가", drop_check: "값 규칙 제거", drop_foreign_key: "외래 키 제거(열은 유지)", drop_field: "열 삭제", drop_collection: "테이블 삭제", rename_field: "열 이름 변경", rename_collection: "테이블 이름 변경", alter_field: "열 유형 변경" },
    rule: { public: "누구나", authenticated: "로그인한 사용자", owner: "행의 소유자", role: "지정된 역할" },
    rowsDelete: (t, w) => `${t}에서 ${w}인 행을 삭제합니다.`, rowsUpdate: (t, v, w) => `${t}에서 ${w}인 행을 ${v}(으)로 설정합니다.`, filesDelete: p => `파일 삭제: ${p}.`,
    roles: (e, r) => `${e}에게 역할 부여: ${r}.`, attach: (f, t) => `«${t}»은(는) «${f}»의 데이터베이스를 사용합니다.`,
    tool: { shell: "터미널에서 명령 실행", files: "프로젝트 파일 변경", fileDelete: "파일 삭제", deps: "패키지 설치 또는 변경", git: "git에 쓰기(commit 또는 push)", data: "데이터베이스 변경", deploy: "프로젝트 게시", memory: "회사 메모리 변경", email: "이메일 보내기", other: "이 작업 실행" },
    confirmTitle: "확인이 필요합니다", approve: "승인", resume: "계속", pending: "결정을 기다리는 중", approved: "승인됨", rejected: "거부됨", expired: "만료됨", completed: "완료", failed: "실패", cancelled: "취소됨", working: "실행 중…", used: "이 확인은 이미 사용되었습니다",
  },
  ar: {
    permissionTitle: "نحتاج إلى إذنك", wantsToRun: "يريد الوكيل أن:", policies: "يريد الوكيل تحديد من يمكنه استخدام جداول قاعدة البيانات هذه:",
    allow: "سماح", reject: "رفض", saving: "جارٍ الحفظ…", always: "اسمح ولا تسأل مرة أخرى",
    alwaysHint: "سيعمل وكلاء هذه الشركة دون سؤال (الكتابة إلى git ستظل تسأل). يمكنك إيقاف ذلك من إعدادات الشركة.",
    schema: { add_check: "إضافة قاعدة للقيم", drop_check: "إزالة قاعدة القيم", drop_foreign_key: "إزالة المفتاح الخارجي (يبقى العمود)", drop_field: "حذف العمود", drop_collection: "حذف الجدول", rename_field: "إعادة تسمية العمود", rename_collection: "إعادة تسمية الجدول", alter_field: "تغيير نوع العمود" },
    rule: { public: "أي شخص", authenticated: "المستخدمون المسجلون", owner: "مالك الصف", role: "دور محدد" },
    rowsDelete: (t, w) => `حذف الصفوف من ${t} حيث ${w}.`, rowsUpdate: (t, v, w) => `في ${t} تعيين ${v} حيث ${w}.`, filesDelete: p => `حذف الملف: ${p}.`,
    roles: (e, r) => `منح ${e} الأدوار: ${r}.`, attach: (f, t) => `سيستخدم «${t}» قاعدة بيانات «${f}».`,
    tool: { shell: "تشغيل أمر في الطرفية", files: "تغيير ملفات المشروع", fileDelete: "حذف ملف", deps: "تثبيت الحزم أو تغييرها", git: "الكتابة إلى git (commit أو push)", data: "تغيير قاعدة البيانات", deploy: "نشر المشروع", memory: "تغيير ذاكرة الشركة", email: "إرسال بريد إلكتروني", other: "تنفيذ هذا الإجراء" },
    confirmTitle: "التأكيد مطلوب", approve: "موافقة", resume: "متابعة", pending: "في انتظار قرارك", approved: "تمت الموافقة", rejected: "مرفوض", expired: "منتهي الصلاحية", completed: "تم", failed: "فشل", cancelled: "ملغى", working: "جارٍ التنفيذ…", used: "تم استخدام هذا التأكيد بالفعل",
  },
  hi: {
    permissionTitle: "आपकी अनुमति चाहिए", wantsToRun: "एजेंट यह करना चाहता है:", policies: "एजेंट तय करना चाहता है कि इन डेटाबेस तालिकाओं का उपयोग कौन कर सकता है:",
    allow: "अनुमति दें", reject: "अस्वीकार करें", saving: "सहेजा जा रहा है…", always: "अनुमति दें और फिर न पूछें",
    alwaysHint: "इस कंपनी के एजेंट बिना पूछे काम करेंगे (git में लिखना अब भी पूछेगा)। इसे कंपनी सेटिंग में बंद कर सकते हैं।",
    schema: { add_check: "मान का नियम जोड़ें", drop_check: "मान का नियम हटाएँ", drop_foreign_key: "फ़ॉरेन की हटाएँ (कॉलम रहेगा)", drop_field: "कॉलम हटाएँ", drop_collection: "तालिका हटाएँ", rename_field: "कॉलम का नाम बदलें", rename_collection: "तालिका का नाम बदलें", alter_field: "कॉलम का प्रकार बदलें" },
    rule: { public: "कोई भी", authenticated: "साइन-इन उपयोगकर्ता", owner: "पंक्ति का स्वामी", role: "तय भूमिका" },
    rowsDelete: (t, w) => `${t} से वे पंक्तियाँ हटाएँ जहाँ ${w}।`, rowsUpdate: (t, v, w) => `${t} में जहाँ ${w} वहाँ ${v} सेट करें।`, filesDelete: p => `फ़ाइल हटाएँ: ${p}।`,
    roles: (e, r) => `${e} को भूमिकाएँ दें: ${r}।`, attach: (f, t) => `«${t}» «${f}» का डेटाबेस उपयोग करेगा।`,
    tool: { shell: "टर्मिनल में कमांड चलाएँ", files: "प्रोजेक्ट फ़ाइलें बदलें", fileDelete: "फ़ाइल हटाएँ", deps: "पैकेज इंस्टॉल करें या बदलें", git: "git में लिखें (commit या push)", data: "डेटाबेस बदलें", deploy: "प्रोजेक्ट प्रकाशित करें", memory: "कंपनी की मेमोरी बदलें", email: "ईमेल भेजें", other: "यह कार्य चलाएँ" },
    confirmTitle: "पुष्टि आवश्यक है", approve: "स्वीकृत करें", resume: "जारी रखें", pending: "आपके निर्णय की प्रतीक्षा है", approved: "स्वीकृत", rejected: "अस्वीकृत", expired: "समय समाप्त", completed: "पूरा हुआ", failed: "विफल", cancelled: "रद्द", working: "चल रहा है…", used: "यह पुष्टि पहले ही उपयोग हो चुकी है",
  },
};

export function approvalCopy(language: string | null | undefined): ApprovalCopy {
  const code = String(language ?? "").toLowerCase().slice(0, 2) as ApprovalLanguage;
  return copies[code] ?? copies.en;
}

/** The plain name of an action a tool performs, for a card whose request carries no more detail. */
export function approvalToolLabel(toolName: string, copy: ApprovalCopy): string {
  const name = toolName.toLowerCase();
  if (/(^|\.)git(\.|$)/.test(name)) return copy.tool.git;
  if (/shell|terminal/.test(name)) return copy.tool.shell;
  if (/fs\.delete/.test(name)) return copy.tool.fileDelete;
  if (/\.fs\.|files?\./.test(name)) return copy.tool.files;
  if (/deps|package/.test(name)) return copy.tool.deps;
  if (/deploy|publish/.test(name)) return copy.tool.deploy;
  if (/\.data\.|database/.test(name)) return copy.tool.data;
  if (/memory/.test(name)) return copy.tool.memory;
  if (/email|mail/.test(name)) return copy.tool.email;
  return copy.tool.other;
}

const latinLetters: Array<[ApprovalLanguage, RegExp]> = [
  ["tr", /[ğışĞİŞ]/u], ["pl", /[ąćęłńśźżĄĆĘŁŃŚŹŻ]/u], ["de", /[äöüßÄÖÜ]/u], ["es", /[ñ¿¡Ñ]/u], ["pt", /[ãõÃÕ]/u], ["fr", /[œçèêëîïûùÿŒÇ]/u], ["it", /[òìÒÌ]/u],
];
const latinWords: Array<[ApprovalLanguage, Set<string>]> = [
  ["en", new Set(["the", "and", "please", "delete", "create", "change", "add", "make", "with", "my", "site", "file", "what", "is"])],
  ["de", new Set(["und", "der", "die", "das", "bitte", "lösche", "erstelle", "mit", "ist", "nicht", "eine", "ein"])],
  ["fr", new Set(["le", "la", "les", "et", "est", "pour", "avec", "supprime", "crée", "une", "un", "des"])],
  ["es", new Set(["el", "la", "los", "las", "y", "es", "para", "con", "elimina", "crea", "una", "por"])],
  ["it", new Set(["il", "lo", "gli", "e", "è", "per", "con", "elimina", "crea", "una", "di", "che"])],
  ["pl", new Set(["i", "jest", "dla", "z", "usuń", "utwórz", "na", "nie", "się", "to"])],
  ["pt", new Set(["o", "os", "as", "e", "é", "para", "com", "exclua", "crie", "uma", "não", "do"])],
  ["nl", new Set(["de", "het", "een", "en", "is", "voor", "met", "verwijder", "maak", "niet", "van"])],
  ["tr", new Set(["ve", "bir", "bu", "için", "ile", "sil", "oluştur", "değil", "mi"])],
];

/** The language a person writes in, from the text of their message; the fallback when the text does not say. */
export function messageLanguage(text: string | null | undefined, fallback: string): ApprovalLanguage {
  const value = String(text ?? "");
  if (/[ぁ-ゟ゠-ヿ]/u.test(value)) return "ja";
  if (/[가-힣]/u.test(value)) return "ko";
  if (/\p{Script=Han}/u.test(value)) return "zh";
  if (/\p{Script=Arabic}/u.test(value)) return "ar";
  if (/\p{Script=Devanagari}/u.test(value)) return "hi";
  if (/\p{Script=Cyrillic}/u.test(value)) {
    const uk = /[іїєґІЇЄҐ]/u.test(value), ru = /[ыэёъЫЭЁЪ]/u.test(value);
    if (uk !== ru) return uk ? "uk" : "ru";
    // Without a letter only one of them uses, the small words decide ("и", "что" against "й", "що").
    const words = value.toLowerCase().split(/[^\p{L}']+/u);
    const ukWords = words.filter(word => ["й", "що", "це", "та", "як", "для", "видали", "зміни", "створи", "додай", "будь", "ласка"].includes(word)).length;
    const ruWords = words.filter(word => ["и", "что", "это", "как", "удали", "измени", "создай", "добавь", "пожалуйста", "или", "его"].includes(word)).length;
    if (ukWords !== ruWords) return ukWords > ruWords ? "uk" : "ru";
    return fallback === "ru" ? "ru" : "uk";
  }
  if (!/\p{Script=Latin}/u.test(value)) return approvalCopyLanguage(fallback);
  const lettered = latinLetters.filter(([, pattern]) => pattern.test(value)).map(([language]) => language);
  if (lettered.length === 1) return lettered[0]!;
  const words = value.toLowerCase().split(/[^\p{L}]+/u);
  const scored = latinWords.map(([language, set]) => ({ language, hits: words.filter(word => set.has(word)).length })).sort((a, b) => b.hits - a.hits);
  if (scored[0]!.hits > 0 && scored[0]!.hits > scored[1]!.hits) return scored[0]!.language;
  return approvalCopyLanguage(fallback);
}

function approvalCopyLanguage(language: string): ApprovalLanguage {
  const code = language.toLowerCase().slice(0, 2) as ApprovalLanguage;
  return (APPROVAL_LANGUAGES as readonly string[]).includes(code) ? code : "en";
}
