# NPATI Data Studio + Project Auth: покрокові промти (D0-D7)

Це продовження плану Website Builder (кроки 0-11). Виконувати лише після того, як працює мінімум Phase 1 Website Builder (Project, Workspace, Sandbox, Preview, Intent Router).

Як користуватися:

1. Кожен крок запускайте окремою сесією кодувального агента.
2. На початку кожного кроку вставляйте **Спільний блок правил** і потім текст кроку.
3. Не переходьте далі, поки не виконані критерії приймання поточного кроку.
4. Після D0 перегляньте документ аудиту і за потреби відкоригуйте наступні промти.

## Ключові рішення архітектури (зафіксовані)

- **Два Postgres.** `postgres` це основна БД NPATI (не чіпаємо). `postgres-projects` це новий окремий контейнер, у якому створюється окрема база і окрема службова роль на кожен проєкт.
- **Один власник, self-hosted.** Користувач встановлює NPATI через docker compose, і `postgres-projects` піднімається разом з ним (опційно через compose profile).
- **`DatabaseProvisioner`.** Інтерфейс, який працює з парою `dataBackend + environment` (а не з окремим Project) і повертає параметри підключення для потрібної ролі. Зараз реалізація створює базу на спільному `postgres-projects`. Пізніше можна додати окремий контейнер на backend або зовнішню БД (Supabase, Neon) без змін в інших модулях.
- **`DataBackend`.** Окрема сутність між Project і Database, що належить Company. Один DataBackend можуть використовувати кілька Project (Website + Mobile App + Admin App). Environments (dev, prod) належать DataBackend. Project лише посилається на нього (`data_backend_id`).
- **Три ролі Postgres на DataBackend + environment:** provisioner/admin (лише backend NPATI), migrator (власник об'єктів схеми, виконує міграції), runtime (для Project API; не owner, без SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS).
- **RLS обов'язковий** для owner-based і приватних даних: ENABLE + FORCE ROW LEVEL SECURITY, default-deny, політики з `USING` і `WITH CHECK`.
- **Розподіл метаданих.** NPATI Core DB: DataBackend, environments, provider configuration, secret references, UI metadata, access policies, статус. Проєктна БД: лише системні таблиці `_npati_migrations`, `_npati_auth_*`.
- **Ключі Project API:** `PROJECT_PUBLISHABLE_KEY` (browser/mobile, не секрет, не обходить permissions/RLS) і `PROJECT_SECRET_KEY` (лише server-side, ніколи у frontend, mobile bundle, sandbox, prompts).
- **Без нової permission-системи.** Доступ агентів до Data/Auth реалізується як capability groups через існуючу систему NPATI.
- **Власний Data Studio** всередині NPATI (не Directus). Схожий UX: колекції, поля, зв'язки, рядки, API, ролі.
- **Агент не виконує довільний SQL.** Він викликає структуровані операції (create_table, add_column тощо). NPATI сам генерує SQL-міграції.
- **Два рівні користувачів.** Власник/команда входять через npati.com. Клієнти створеного сайту/застосунку реєструються через Project Auth, і їхні акаунти живуть у БД проєкту. Ці рівні ніколи не змішуються.
- **Сайт і мобільний застосунок** використовують один і той самий DataBackend, Project API та Project Auth.

## Зміни у версії 2 (архітектурні виправлення)

Порядок кроків D0-D7 не змінений. Точкові зміни:

- **DataBackend** між Project і Database (D0, D1, D2, D3, D5, D6, D7). Provisioner працює з `dataBackend + environment`.
- **Три ролі Postgres** (provisioner/migrator/runtime) і заборони для runtime (D1, D5).
- **RLS обов'язковий** із `USING` + `WITH CHECK` та FORCE (D1, D3, D4).
- **Project Auth:** signing keys на backend+environment, claims, kid/rotation, hashed refresh з reuse detection, одноразові hashed verification/reset (D4).
- **Ключі API:** `PROJECT_PUBLISHABLE_KEY` / `PROJECT_SECRET_KEY` (D5, D6).
- **Міграції:** lock, `reversible`, `destructive`, `requires_snapshot` (D1, D3, D7).
- **Schema Drift Detection:** introspect, fingerprint, detectDrift, статуси (D1, D2, D7).
- **Метадані:** розділ Core DB / проєктна БД (D0, D1, D4).
- **Capability groups** замість окремої permission Data Read/Write (D3, D4).
- **GDPR:** стратегії delete / anonymize / detach / retain замість безумовного cascade (D3, D4).

Відкриті архітектурні питання (вирішити за результатами D0):

1. Джерело істини для структури схеми: introspection проєктної БД (рекомендовано) чи desired-state у Core.
2. Привілейована серверна логіка згенерованого сайту без `PROJECT_SECRET_KEY` у sandbox: user JWT + RLS, платформні server functions чи secret key лише в deploy-середовищі.
3. Зовнішні керовані бази (Supabase/Neon): чи дозволять створити окремі ролі та RLS; потрібен обмежений режим.
4. Розбіжність Core access policies і RLS у БД (покривається drift detection, але потрібен компілятор політик із тестами).
5. Видалені за GDPR дані залишаються в backups до кінця retention.

---

## Спільний блок правил (вставляти перед кожним кроком)

````
КОНТЕКСТ
Ми додаємо до NPATI AI Agent модуль Data Studio: власні бази даних для проєктів (Website Builder), схожий за можливостями на Directus (колекції, поля, зв'язки, рядки, API, ролі), а також Project Auth для кінцевих користувачів створених сайтів і мобільних застосунків. Це НЕ окремий продукт і НЕ розгортання Directus. Це розширення існуючої моделі Company -> Project -> Workspace -> Sandbox -> Capabilities -> Runs -> Activity.

АРХІТЕКТУРНІ РІШЕННЯ (не змінювати без мого дозволу)
- Основна БД NPATI (pgvector/pgvector:pg17) не використовується для даних проєктів. Дані проєктів живуть у ОКРЕМОМУ контейнері postgres-projects: окрема база на кожен DataBackend + environment з трьома ролями Postgres (provisioner/admin, migrator, runtime).
- Доступ до даних через сутність DataBackend (належить Company, може використовуватися кількома Project) та інтерфейс DatabaseProvisioner, який працює з dataBackend + environment (зараз реалізація: спільний postgres-projects; в майбутньому: контейнер на backend або зовнішня БД).
- Provisioner/admin credentials postgres-projects доступні лише backend NPATI. Migrator credentials використовує лише движок міграцій. Runtime credentials використовує лише Project API gateway. Runtime role не owner таблиць і не має SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS. Sandbox, AI-агенти і frontend жодних DB credentials не бачать.
- Агенти не виконують довільний SQL. Лише структуровані операції, з яких NPATI генерує версійні міграції.
- Користувачі NPATI (власники) і користувачі проєкту (клієнти сайту) це різні сутності в різних базах.
- RLS обов'язковий для owner-based/private даних (ENABLE + FORCE, default-deny, USING + WITH CHECK).
- Метадані: NPATI Core DB зберігає DataBackend, environments, provider configuration, secret references, UI metadata, access policies, статус; проєктна БД зберігає лише системні таблиці _npati_migrations, _npati_auth_*.
- Ключі Project API: PROJECT_PUBLISHABLE_KEY (browser/mobile, не секрет, не обходить permissions/RLS) і PROJECT_SECRET_KEY (лише server-side; ніколи у frontend, mobile bundle, sandbox, prompts, логах).
- Доступ агентів до Data/Auth через capability groups існуючої системи NPATI; нову permission-систему не створювати.

ГЛОБАЛЬНІ ПРАВИЛА
1. Весь код, назви, capabilities, міграції, API-маршрути і коментарі пишемо англійською. Спілкування зі мною українською.
2. Не припускай структуру backend. Спочатку знайди фактичну реалізацію (спирайся на docs/data-studio/00-audit.md, якщо він є, і на docs/website-builder/00-audit.md).
3. Не дублюй існуючі системи: capability registry, approval, Intent Router, Runs/Tasks, Activity, secret storage, background jobs, permissions, UI components. Розширюй їх.
4. Не видаляй і не переписуй робочий код без необхідності. Дотримуйся naming conventions і стилю NPATI.
5. Усі зміни схеми основної БД NPATI тільки через її поточну систему міграцій. Для проєктних БД використовується окремий механізм міграцій (з кроку D1).
6. Безпека на кожному кроці: tenant isolation (user -> company -> project -> data backend -> environment), недовіра до project_id, company_id, data_backend_id, table/column names, file path з фронтенду або від AI, захист від SQL injection (параметризовані запити, ідентифікатори тільки через валідацію + quoting), секрети не потрапляють у prompts, логи, Activity UI, Project Context, Company Memory.
7. Логіка не прив'язана до конкретної AI-моделі, до назв агентів (agent.name) чи до конкретного DB provider.
8. Працюй лише в межах поточного кроку. Що поза межами, не реалізуй (максимум інтерфейс або TODO з посиланням на крок).
9. Наприкінці запусти доступні typecheck, lint, tests, build. Виправ усі помилки, спричинені твоїми змінами. Не ламай існуючі функції (Company, Agents, Run Company, Capability Inspector, Activity, Website Builder: Projects, Files, Terminal, Preview).
10. У фінальному звіті: змінені/додані файли, що зроблено, що навмисно не зроблено, як перевірити вручну, відомі ризики.
````

---

## D0. Аудит (без змін коду)

````
ЗАВДАННЯ: лише аналіз. НЕ змінюй код, схему БД чи конфігурацію. Єдиний дозволений результат: файл docs/data-studio/00-audit.md.

Дослідити і описати (з посиланнями на конкретні файли):

1. Поточне використання Postgres: docker-compose (сервіси, volumes, networks, healthchecks), ORM/query builder, інструмент міграцій, спосіб підключення, pgvector, connection pooling.
2. Секрети: де зберігаються credentials, як працює існуючий secret storage, чи можна зберігати зашифровані connection strings проєктів.
3. Website Builder (якщо вже реалізований): моделі Project, ProjectWorkspace, SandboxProvider, мережевий allowlist sandbox, як передаються env vars у sandbox, Preview proxy, Project types.
4. Capability registry, approval mechanism, Intent Router, Activity & Run Trace: де і як розширювати для нових capabilities, ризиків і подій.
5. Авторизація NPATI (npati.com): що саме перевіряється, щоб чітко відокремити її від Project Auth.
6. Існуючі UI-компоненти для таблиць, форм, діалогів, редакторів (для Data Studio). Існуючі API conventions.
7. Мобільний застосунок NPATI (якщо є в репозиторії): структура, авторизація, чи є щось спільне з Project API.
8. Email: чи є існуюча інтеграція для листів (потрібна для підтвердження email і скидання пароля в Project Auth).
9. Backup/restore: що вже є для основної БД.
10. Можливості Postgres 17 для плану: RLS і FORCE ROW LEVEL SECURITY, ролі та GRANT, advisory locks, set_config/SET LOCAL з connection pooling, pg_dump/pg_restore у контейнері, чи достатньо стандартного образу для postgres-projects.

ФОРМАТ документа:
- Таблиця "Що вже є -> де знаходиться -> що перевикористати/розширити".
- Що треба створити з нуля.
- Конкретний план змін docker-compose: сервіс postgres-projects, окремий volume, внутрішня мережа без публікації порту назовні, healthcheck, compose profile, змінні оточення, ліміти ресурсів. Без реальних змін, лише чернетка в документі.
- Дизайн сутності DataBackend і environments: поля, зв'язок Project -> DataBackend (many-to-one, nullable), як прикріпити існуючі Project, обмеження в межах однієї Company, чернетка міграції Core DB.
- Перевірка прийнятого рішення про розподіл метаданих: NPATI Core DB (DataBackend, environments, provider configuration, secret references, UI metadata, access policies, status) і проєктна БД (_npati_migrations, _npati_auth_*). Описати джерело істини для СТРУКТУРИ схеми (introspection проєктної БД чи desired-state у Core з fingerprint) і як уникнути розбіжності між access policies у Core та RLS-політиками в проєктній БД. З рекомендацією.
- Порівняння підходів до Project API: окремий сервіс чи модуль у backend NPATI, проксі і публічний доступ клієнтів сайту (CORS, rate limit, домени).
- Модель загроз: AI-агент у sandbox, кінцевий користувач сайту, сусідній проєкт, помилка в згенерованому коді.
- Ризики та відкриті питання до мене.
- Уточнений поділ кроків D1-D7 під реальну архітектуру.

КРИТЕРІЇ ПРИЙМАННЯ:
- Змінений лише docs/data-studio/00-audit.md (перевір git status).
- Кожне твердження має посилання на файл.
- Є явні рекомендації: джерело істини для структури схеми, дизайн DataBackend, як організувати Project API, як Project API виконує запити під runtime role з RLS.
````

---

## D1. postgres-projects, DatabaseProvisioner, DataProvider, міграції

````
ЗАВДАННЯ: інфраструктура баз даних проєктів і движок схеми. Без UI і без агентських capabilities.
Спирайся на docs/data-studio/00-audit.md.

Зробити:
1. docker-compose: сервіс postgres-projects (окремий від основного postgres). Окремий volume, лише внутрішня Docker-мережа, порт НЕ публікується на host. Healthcheck. Ліміти ресурсів. Compose profile, щоб сервіс можна було вимкнути. Адмінський пароль генерується/задається через env і не потрапляє в логи. Оновити приклади .env і документацію запуску.
2. Сутність DataBackend (NPATI Core DB, через поточну систему міграцій NPATI): id, company_id, name, provider (shared_postgres, external_postgres), status, created_by, created_at, updated_at. Окрема таблиця environments (dev, prod): data_backend_id, environment, provider configuration, secret references (credentials ролей, signing keys), status, schema fingerprint, sync status. Project отримує nullable data_backend_id (many-to-one; Project без Data залишається валідним). Один DataBackend може бути прикріплений до кількох Project лише в межах однієї Company; прикріплення перевіряє company_id на сервері. API: create/get/list/update/archive DataBackend, attach/detach Project.
3. Інтерфейс DatabaseProvisioner (працює з dataBackend + environment): provisionDatabase(dataBackend, environment), deprovisionDatabase(dataBackend, environment), getConnection(dataBackend, environment, role) де role = provisioner | migrator | runtime, rotateCredentials(dataBackend, environment, role), snapshot(dataBackend, environment), restoreSnapshot(dataBackend, environment, snapshot), getUsage(dataBackend, environment). Бізнес-логіка залежить лише від інтерфейсу.
4. Реалізація SharedPostgresProvisioner: на кожен dataBackend + environment окрема база (db_{backend_short_id}_{env}) і три ролі. (a) provisioner/admin на рівні сервера postgres-projects: лише для backend NPATI, ніколи не передається в sandbox чи Project API. (b) migrator: власник схеми і всіх об'єктів у базі, виконує лише міграції. (c) runtime: для Project API; НЕ owner таблиць, без SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS, лише DML-права (SELECT/INSERT/UPDATE/DELETE) на дозволені колекції через явні GRANT, без DDL. REVOKE CONNECT на базу для PUBLIC. Ліміти: connection limit на ролі, statement_timeout, idle_in_transaction_session_timeout. Ролі не мають доступу до інших баз і до системних каталогів понад необхідне. Паролі генеруються і зберігаються в існуючому secret storage; у Core DB лише references. Кожна колекція, створена DataProvider, отримує ENABLE і FORCE ROW LEVEL SECURITY з default-deny (без політик runtime role не бачить жодного рядка); політики додає компілятор access policies (D4). Додати інтеграційну перевірку, що runtime role справді не owner, не superuser і не має BYPASSRLS.
5. Інтерфейс DataProvider і реалізація для Postgres: операції схеми (createCollection, dropCollection, renameCollection, addField, alterField, dropField, createRelation, dropRelation, createIndex) та операції даних (list, get, create, update, delete з фільтрами, сортуванням, пагінацією). Типи полів MVP: string, text, integer, decimal, boolean, date, datetime, json, uuid, enum, file reference (reference лише заглушка). Зв'язки: many-to-one, one-to-many, many-to-many (через join-таблицю). Назви таблиць і колонок: сувора валідація (regex, довжина, список зарезервованих слів, заборона префікса системних таблиць) і quoting. Жодної конкатенації користувацьких значень у SQL.
6. Розподіл метаданих. NPATI Core DB: DataBackend, environments, provider configuration, secret references, UI metadata (відображення колекцій і полів, порядок, підписи), access policies (джерело істини правил, компілюються в RLS), статус і останній schema fingerprint. Проєктна БД: лише системні таблиці з префіксом _npati_ (_npati_migrations, _npati_auth_* з D4). Джерело істини для структури схеми визначити за рекомендацією аудиту (рекомендовано: фактична схема проєктної БД через introspection; Core зберігає UI metadata і fingerprint).
7. Движок міграцій проєктної БД (виконується migrator role): кожна операція схеми генерує версійну міграцію з полями reversible (чи існує безпечний відкат), destructive (чи втрачаються дані), requires_snapshot, up SQL, down SQL (може бути відсутній), автор (user/agent), run_id, час, статус, checksum. Destructive міграція НЕ вважається безпечно reversible лише через наявність down: down може відновити структуру, але не дані, тому відкат destructive міграції виконується через snapshot. Застосування в транзакції. Dry-run повертає schema diff і прапорці без застосування. Migration lock на dataBackend + environment (advisory lock у проєктній БД плюс запис блокування в Core з TTL, щоб завислий lock звільнявся): паралельні міграції відхиляються структурованою помилкою. Історія в _npati_migrations, дзеркало в Core. Міграції з destructive або requires_snapshot автоматично створюють snapshot перед виконанням.
8. Основа Schema Drift Detection: DataProvider.introspectSchema(dataBackend, environment) (таблиці, колонки, типи, constraints, індекси, статус RLS і політики), schemaFingerprint (стабільний хеш нормалізованої схеми), detectDrift(dataBackend, environment) порівнює фактичну схему з очікуваним станом (історія міграцій + Core metadata). Статуси: synced, drift_detected, reconciliation_required. При drift_detected міграції і promote блокуються до рішення користувача. Автоматичне reconciliation зараз НЕ реалізується (лише diff і статус). Fingerprint оновлюється після кожної успішної міграції. Особливо важливо для зовнішніх Postgres/Neon/Supabase (D7).
9. Життєвий цикл: база створюється при створенні DataBackend (або явній активації Data для Project, що створює DataBackend і прикріплює його). Видалення Project лише відв'язує його від DataBackend. Видалення DataBackend заборонене, поки до нього прикріплені активні Project; після відв'язування виконується з підтвердженням і періодом збереження snapshot (конфігуровано). Архівація DataBackend зупиняє доступ, але зберігає дані.
10. Ліміти (конфігуровано): максимум колекцій, полів на колекцію, розмір БД, максимум рядків на відповідь, кількість запитів.
11. Помилки: структуровані (status, message, step, retryable). Недоступний postgres-projects не валить NPATI; функція Data просто повідомляє, що сервіс недоступний.

НЕ РОБИТИ: UI, capabilities для агентів, Project Auth, Project API.

ТЕСТИ (обов'язково, не наприкінці):
- Provisioning створює базу і три ролі; ролі та ключі DataBackend A не можуть підключитися до бази DataBackend B і до бази NPATI.
- Runtime role: не owner таблиць, не SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS, не виконує DDL; migrator і provisioner credentials недоступні з Project API.
- SQL injection у назвах колекцій/полів ("a; DROP TABLE x", лапки, юнікод, надто довгі, зарезервовані) відхиляється.
- Параметризація значень у фільтрах (спроба інʼєкції через фільтр).
- Міграція up/down: створення, зміна, відкат. Нескінчені/невдалі міграції не залишають частково застосовану схему.
- Деструктивна міграція має destructive=true і requires_snapshot=true, створює snapshot до виконання, не вважається безпечно reversible через наявність down; restore зі snapshot відновлює дані.
- Ліміти: перевищення кількості колекцій/полів, statement_timeout.
- Ізоляція: користувач компанії A не може викликати операції для проєкту компанії B.
- Недоступність postgres-projects обробляється без падіння.
- RLS default-deny: нова колекція без політик недоступна runtime role; FORCE RLS діє.
- Migration lock: дві паралельні міграції на один dataBackend + environment, друга відхиляється; завислий lock звільняється за TTL.
- Drift: ручна зміна схеми поза NPATI дає drift_detected, міграції блокуються; fingerprint змінюється лише після успішної міграції.
- Два Project однієї Company прикріплюються до одного DataBackend; Project іншої Company прикріпити не можна; видалення Project не видаляє DataBackend.

КРИТЕРІЇ ПРИЙМАННЯ:
- docker compose up піднімає postgres-projects разом з NPATI; без профілю NPATI працює як раніше.
- Через інтеграційний тест: створити DataBackend -> провізія dev-бази (три ролі) -> прикріпити Project -> створити колекцію з полями і зв'язком -> додати/прочитати рядки через runtime role -> відкотити reversible-міграцію -> видалити Project (backend лишається) -> видалити DataBackend і БД.
- Всі тести ізоляції зелені, існуючі тести та build не зламані.
````

---

## D2. Data Studio UI

````
ЗАВДАННЯ: інтерфейс Data Studio для ручної роботи з даними проєкту. Спирайся на D1.

Зробити:
1. Data Studio працює на DataBackend. Company -> Data: список DataBackend, створення, прикріплення/відкріплення Project, статус і sync status. У Company -> Project додати розділ Data, що відкриває прикріплений DataBackend (або пропонує створити/прикріпити). Перемикач environment (dev/prod); зміни схеми prod лише через Promote (D7). Інтегрувати у поточну структуру сторінок із design system NPATI.
2. Collections: список колекцій, створення, перейменування, видалення (destructive -> підтвердження).
3. Schema editor: додавання, редагування, видалення полів; типи, обов'язковість, unique, значення за замовчуванням, enum-значення; зв'язки між колекціями (UI для many-to-one, one-to-many, many-to-many). Перед застосуванням показувати schema diff (dry-run із D1) і кнопку Apply. Список міграцій з історією і кнопкою Revert (де можливо).
4. Data view: таблиця рядків із пагінацією, сортуванням, фільтрами, пошуком; створення, редагування, видалення рядків; форма генерується зі схеми, враховує типи і зв'язки (вибір пов'язаного рядка). Масове видалення вимагає підтвердження.
5. Імпорт/експорт CSV та JSON з лімітами розміру і валідацією за схемою.
6. Видимість звʼязку з агентом: у списку міграцій позначати автора (user або agent) і run, із посиланням View Run.
7. Стани: порожній проєкт без Data, сервіс недоступний, помилки валідації. Адаптація під mobile (таблиці прокручуються, форми в панелях).
8. API endpoints (за конвенціями NPATI) для UI, усі з перевіркою user -> company -> project.
9. Шапка Data Studio показує sync status (synced / drift_detected / reconciliation_required) і migration lock (хто тримає, з якого часу). При drift_detected Apply заблокований, показується різниця фактичної схеми й очікуваного стану (лише перегляд, без авто-reconciliation). У списку міграцій показувати прапорці reversible / destructive / requires_snapshot.

НЕ РОБИТИ: capabilities для агентів, Project Auth, публічний Project API.

ТЕСТИ:
- Frontend: створення колекції і поля, перегляд diff, Apply, відображення помилок.
- Backend/API: ізоляція між компаніями та користувачами, відхилення підроблених project_id і імен таблиць.
- Імпорт CSV: некоректні типи, надто великий файл, формульні ін'єкції (значення, що починаються з =, +, -, @, при експорті екрануються).
- Регресія: інші розділи Project (Files, Terminal, Preview) працюють.
- Той самий DataBackend відкривається з двох Project; прикріплення DataBackend іншої Company відхиляється; drift_detected блокує Apply.

КРИТЕРІЇ ПРИЙМАННЯ:
- Користувач вручну створює таблицю products з полями і зв'язком з categories, додає рядки, бачить міграції, відкочує одну з них. Усе ізольовано між проєктами.
- Один DataBackend бачать сайт і мобільний Project; статус sync відображається коректно.
````

---

## D3. Capabilities для агентів, approval, шаблони схем

````
ЗАВДАННЯ: дати агентам Company керувати схемою і даними через capabilities. Спирайся на D1-D2 і на існуючий capability registry та approval.

Зробити:
1. Capabilities у canonical registry за конвенцією NPATI (перевір, чи є існуючі аналоги): project.data.schema.inspect, project.data.schema.apply (структуровані операції, не raw SQL), project.data.rows.list/read/create/update/delete, project.data.migrations.list, project.data.templates.list/apply. Метадані: domain, type, risk, agent callable, approval required. Видимі в Capability Inspector.
2. Ризики: inspect/read = low; create_collection/add_field/rows create = medium; drop collection/field, зміна типу, масове видалення/оновлення рядків = high і ПОТРЕБУЮТЬ approval через існуючу approval-систему. Перед approval показати schema diff, кількість зачеплених рядків і прапорці міграції (reversible, destructive, requires_snapshot). Destructive міграція не вважається безпечно reversible лише через наявність down.
3. Агент не має capability виконувати довільний SQL. Якщо в майбутньому потрібен SQL console, це окремий high-risk capability з обов'язковим approval (не додавати зараз).
4. Без нової permission-системи Data Read/Data Write: capabilities групуються в capability groups (наприклад data.read, data.write, data.schema, auth.admin) через існуючу систему NPATI і вмикаються для агента так само, як інші групи (включно з project-групами Website Builder). Агент без групи отримує permission denied.
5. Шаблони схем: каталог готових шаблонів (початково: ecommerce [categories, products, product_variants, carts, cart_items, orders, order_items, addresses], blog [posts, categories, tags, comments], crm [contacts, companies, deals, notes], saas-basic [organizations, memberships, subscriptions]). Шаблон це декларативний опис операцій схеми, який проходить через той самий движок міграцій. Показується як план + diff, застосовується після підтвердження користувача (для ecommerce/CRM достатньо одного підтвердження плану, не окремо кожної колекції).
6. Інтеграція з Project Manager і Intent Router: інтенти типу ADD_DATA_MODEL/EDIT_DATA_MODEL ("додай таблицю для замовлень", "зроби інтернет-магазин") маршрутизуються в Project run, де агент спочатку виконує schema.inspect, пропонує план (шаблон або власну схему), потім застосовує. Для запиту "створи інтернет-магазин" сайт і схема створюються в одному плані: schema -> API/auth -> frontend.
7. Activity & Run Trace: нові події (схема прочитана, міграція запропонована/застосована, approval, помилка). Міграція посилається на run.
8. Shared Project Context (PROJECT.md або аналог): автоматично додається опис схеми (колекції, поля, зв'язки), без даних рядків і секретів.
9. Ліміти: максимум операцій схеми за один run, максимум рядків на агентську вставку, максимум ітерацій виправлення помилки міграції (3).
10. Резолв DataBackend: усі project.data.* capabilities визначають DataBackend через Project (project.data_backend_id) і працюють з environment=dev. Агент не може адресувати prod; будь-яка зміна prod лише через Promote (D7).
11. Шаблони декларують access policies для приватних колекцій (carts, orders, addresses, contacts): owner-based за owner_id, які компілюються в RLS (D1/D4). Шаблон із приватною колекцією без policies не проходить валідацію. Шаблони також декларують дефолтні GDPR-стратегії (delete / anonymize / detach / retain) для колекцій, пов'язаних з користувачем.

ТЕСТИ:
- Агент без capability group data.schema/data.write не може змінювати схему; окремої permission Data Read/Write не існує.
- Агент не може адресувати prod; запит схеми завжди резолвиться через Project -> DataBackend із перевіркою company.
- Шаблон із приватною колекцією без access policies відхиляється.
- Drop/зміна типу без approval не виконуються; після approval виконуються; після відмови ні.
- Некоректні операції від моделі (вигадані типи, SQL у назвах) відхиляються з зрозумілою помилкою.
- Шаблон ecommerce застосовується повністю або відкочується повністю (транзакція).
- Ізоляція проєктів, відсутність витоку секретів у логах/Activity.
- Capabilities відображаються в Capability Inspector.
- Регресія Run Company (auto/single/pipeline/fusion).

КРИТЕРІЇ ПРИЙМАННЯ:
- У чаті "додай у проєкт таблиці для інтернет-магазину" агент показує план зі схемою, після підтвердження застосовує, у Data Studio видно колекції, у Activity видно run і міграції.
````

---

## D4. Project Auth (користувачі створених сайтів і застосунків)

````
ЗАВДАННЯ: готова система авторизації для кінцевих користувачів проєкту. Це НЕ авторизація NPATI (npati.com). Спирайся на D1-D3.

Зробити:
1. Системні таблиці в проєктній БД DataBackend (префікс _npati_auth_*): users (id, email, password_hash, email_verified, status, created_at, last_login), refresh_tokens (token_hash, family_id, user_id, expires_at, rotated_at, revoked_at), email_verification_tokens і password_reset_tokens (лише token_hash), roles/user_roles. Таблиці належать migrator role; runtime role має лише потрібні DML-права. Користувачі спільні для всіх Project, прикріплених до DataBackend (Website і Mobile входять тими самими акаунтами), окремо для кожного environment. Налаштування Auth (метадані) в Core DB, ключі в secret storage. Кастомні поля профілю: звичайні колекції з посиланням на auth user id.
2. Паролі: argon2id. Мінімальні вимоги до пароля, захист від перебору: rate limit на login/register/reset (по IP і по email), тимчасове блокування, однакові повідомлення про помилку (без user enumeration).
3. Токени: access token (JWT, короткоживучий) з claims iss (DataBackend + environment), aud (Project API цього DataBackend/environment), sub (auth user id), exp, iat, jti, а також role; заголовок містить kid. Signing keys окремі для кожного DataBackend + environment, зберігаються в secret storage і підтримують rotation: нові токени підписуються активним ключем, старий ключ залишається для перевірки до закінчення TTL access token, потім видаляється. Валідація перевіряє підпис за kid, iss, aud, exp; токен іншого DataBackend/environment відхиляється. Алгоритм: асиметричний (EdDSA або ES256) рекомендовано, остаточно за аудитом. Refresh token: випадковий opaque, у БД зберігається ТІЛЬКИ hash; кожне використання ротує токен; reuse detection: повторне використання вже ротованого refresh token відкликає всю token family і вимагає повторного логіну; logout відкликає family.
4. Flows: register, login, logout, refresh, me, email verification, forgot/reset password, change password, delete account. Verification і reset токени одноразові, зберігаються лише як hash, мають TTL, інвалідуються після використання, а reset-токени також при зміні пароля. Email через існуючу email-інтеграцію NPATI або через абстракцію EmailProvider (SMTP як перша реалізація). Якщо email не налаштований, функція verification/reset вимикається з чіткою помилкою, а не мовчить.
5. OAuth providers (Google/GitHub) лише як інтерфейс AuthProvider без реалізації зараз. Додати TODO.
6. Ролі та правила доступу до колекцій. Джерело істини: access policies у Core DB (public, authenticated, owner через owner_id, role-based). Компілятор перетворює їх на PostgreSQL RLS-політики в проєктній БД (виконує migrator role). RLS ОБОВ'ЯЗКОВИЙ для owner-based і приватних колекцій: ENABLE + FORCE ROW LEVEL SECURITY, default-deny, політики мають і USING (які рядки видно/змінюються), і WITH CHECK (які значення дозволено записати), тож користувач не може створити або змінити рядок з чужим owner_id. owner_id отримує default зі значення користувача з контексту запиту і не змінюється після створення. Контекст запиту (user id, role, project id) Project API передає в транзакцію через set_config(..., true) / SET LOCAL, політики читають його через current_setting. Runtime role не owner таблиць і без BYPASSRLS, тому RLS завжди діє. Політики входять у schema fingerprint (drift detection з D1), щоб виявляти розбіжність між Core policies і БД.
7. UI в Data Studio: розділ Authentication: список користувачів проєкту (без паролів), статус, ролі, блокування, видалення; налаштування (дозволена реєстрація, обов'язкове підтвердження email, мінімальні вимоги до пароля, TTL токенів). Правила доступу на кожну колекцію (Permissions).
8. Capabilities для агентів: project.auth.inspect, project.auth.configure (low/medium; зміна ролей і вимкнення верифікації = high з approval). Агент ніколи не бачить password_hash і токени.
9. GDPR-основи: експорт даних користувача і видалення/деперсоналізація БЕЗ безумовного cascade delete. Для кожної колекції, що посилається на auth user, у Core metadata задається стратегія: delete (видалити рядки), anonymize (залишити рядок, затерти персональні поля), detach (залишити рядок, обнулити посилання на користувача), retain (залишити з обґрунтуванням, наприклад фінансові записи за законом). Стратегії узгоджуються з FK (RESTRICT/SET NULL), а не з ON DELETE CASCADE за замовчуванням. Перед видаленням показується affected data: колекції, стратегія і кількість рядків (без персональних даних); виконується лише після підтвердження. Шаблони постачаються з дефолтними стратегіями (наприклад orders: retain/anonymize, carts: delete). Дані у backups зберігаються до закінчення retention (задокументувати).

НЕ РОБИТИ: публічний Project API gateway (крок D5), мобільні застосунки (D6), OAuth реалізації.

ТЕСТИ:
- Реєстрація, логін, refresh з ротацією, відкликання, logout.
- Токен DataBackend/environment A не діє в B (iss/aud/kid). Прострочений, підроблений, з невідомим kid токен відхиляється. Rotation signing key: старі токени діють до TTL, нові підписані новим kid.
- Refresh: у БД лише hash; ротація при кожному використанні; reuse detection відкликає family; logout відкликає family.
- Verification/reset токени одноразові, hashed, з TTL; повторне використання відхиляється; reset інвалідується при зміні пароля.
- Rate limit і блокування, відсутність user enumeration.
- password_hash і токени не з'являються у відповідях API, логах, Activity, prompts.
- Правила доступу і RLS: public/authenticated/owner/role; спроба читати чужий рядок; INSERT/UPDATE з чужим owner_id відхиляється завдяки WITH CHECK; owner_id не змінюється; runtime role не обходить RLS.
- Видалення користувача та експорт даних: стратегії delete/anonymize/detach/retain застосовуються по колекціях, безумовного cascade немає, affected data показується перед видаленням.
- Ізоляція між компаніями/користувачами NPATI у адмін-розділі Authentication.
- Агент без відповідних capability groups (data.write, auth.admin) не може змінювати налаштування Auth.

КРИТЕРІЇ ПРИЙМАННЯ:
- Для DataBackend увімкнено Auth; тестовий клієнт реєструється, підтверджує email, логіниться, отримує лише свої рядки в owner-колекції і не бачить чужих. Той самий акаунт працює і в Website, і в Mobile Project цього DataBackend.
````

---

## D5. Project API, SDK і підключення до sandbox та згенерованих сайтів

````
ЗАВДАННЯ: публічний API проєкту і клієнтська бібліотека, щоб згенеровані сайти і застосунки працювали з даними та Auth. Спирайся на D1-D4 і Website Builder (Sandbox, Preview).

Зробити:
1. Project API gateway (рішення з аудиту: модуль backend NPATI або окремий сервіс): REST маршрути на колекції проєкту (list/get/create/update/delete з фільтрами, сортуванням, пагінацією, вибором полів, підвантаженням зв'язків) і маршрути Auth з D4. Версіонування API (/v1). Відповіді та помилки в єдиному форматі. OpenAPI-специфікація для кожного проєкту, що генерується зі схеми.
2. Ключі в межах DataBackend + environment: PROJECT_PUBLISHABLE_KEY (для browser і mobile, НЕ секрет; дозволяє лише те, що дозволяють access policies і RLS, і ніколи не обходить permissions/RLS) і PROJECT_SECRET_KEY (лише server-side для адмін-операцій Project API; ніколи не потрапляє у frontend-код, mobile bundle, sandbox, prompts, preview, логи, Activity). Ключі в secret storage, ротація, окремі для dev і prod. Кінцеві користувачі і клієнти НІКОЛИ не підключаються до Postgres напряму. PROJECT_SECRET_KEY не дає BYPASSRLS: адмін-операції виконуються через runtime role з явним service-режимом у політиках.
3. Захист: CORS allowlist на DataBackend + environment, де кожен origin прив'язаний до конкретного Project (включно з preview-доменом цього Project), rate limit на ключ і на IP, ліміт розміру запиту, ліміт кількості рядків відповіді, validation за схемою, параметризовані запити, перевірка access policies на кожен запит.
4. SDK: невелика клієнтська бібліотека (TypeScript, що працює у браузері, Node і React Native) з методами auth і data (signUp, signIn, signOut, getUser, from(collection).list/get/create/update/delete). Генерується або публікується як пакет, доступний sandbox; типи генеруються зі схеми.
5. Інтеграція з Website Builder: у sandbox Project передаються лише PROJECT_API_URL і PROJECT_PUBLISHABLE_KEY (через secret reference). PROJECT_SECRET_KEY, credentials будь-якої DB-ролі і DATABASE_URL у sandbox і frontend-код не потрапляють. Мережевий allowlist sandbox дозволяє лише Project API. Серверна логіка згенерованого сайту (SSR, server actions) у dev/preview працює через user JWT і RLS без secret key; використання PROJECT_SECRET_KEY дозволене лише в цільовому середовищі deploy (D7/DeployProvider) після approval. Агенту дається compact-документація SDK/API у Project Context, щоб він генерував код авторизації і запитів із SDK, а не вигадував власне.
6. Capabilities: project.api.inspect (схема/ендпоінти, без ключів). Генерація клієнтського коду виконується звичайними project.files.* capabilities.
7. Логування запитів до Project API (метод, шлях, статус, час, без тіл запитів із персональними даними і без токенів) та перегляд у Data Studio.
8. Quotas/usage: лічильники запитів і розміру БД, відображення в Data Studio.
9. Виконання запитів: gateway підключається лише runtime role. На кожен запит у транзакції SET LOCAL (user id, role, project id), без BYPASSRLS; сумісність із connection pooling перевірити. Migrator і provisioner credentials gateway не використовує.

ТЕСТИ:
- CRUD через API з PROJECT_PUBLISHABLE_KEY відповідно до access policies і RLS; PROJECT_SECRET_KEY працює лише на серверних маршрутах і теж не обходить RLS.
- Запит з чужого origin відхиляється (CORS), перевищення rate limit повертає 429.
- Ключ DataBackend A не працює для DataBackend B; ключ dev не працює на prod; origin Project A не дозволений для іншого DataBackend.
- PROJECT_SECRET_KEY, DATABASE_URL і credentials ролей не з'являються в sandbox env, згенерованих файлах, mobile bundle, preview, логах, Activity.
- SQL injection через фільтри/сортування/імена полів.
- Згенерований тестовий сайт (форма реєстрації + список товарів) працює в Live Preview.
- Регресія Website Builder preview proxy.

КРИТЕРІЇ ПРИЙМАННЯ:
- Користувач у чаті: "Створи інтернет-магазин". Агент: схема -> Auth -> Project API -> frontend із SDK. У Live Preview відвідувач реєструється, переглядає товари, додає в кошик, створює замовлення. Власник бачить замовлення в Data Studio.
````

---

## D6. Мобільні проєкти (mobile_app)

````
ЗАВДАННЯ: підтримка мобільних застосунків як типу проєкту, які використовують той самий Project API та Auth. Спирайся на D1-D5 і Website Builder.

ВАЖЛИВО: тут мова про застосунки, які агент створює для користувача (приклад: Expo/React Native). Мобільний застосунок NPATI Agent та його авторизація через npati.com не змінюються.

Зробити:
1. Новий тип проєкту mobile_app (розширюваний enum), framework початково Expo (React Native) з TypeScript. Шаблон проєкту, визначення стека, dev command, порт.
2. Preview: запуск Expo Web (або еквівалент) у sandbox через існуючий preview proxy, щоб користувач бачив застосунок у Live Preview. Прямий запуск на фізичному пристрої/симуляторі не входить у цей крок.
3. SDK із D5 працює у React Native: безпечне зберігання refresh token (expo-secure-store або еквівалент), а не AsyncStorage у відкритому вигляді. Deep links для підтвердження email та скидання пароля (схема застосунку, конфігурується на проєкт). Allowlist redirect URL на проєкт.
4. Той самий backend: mobile_app Project прикріплюється до того самого DataBackend (data_backend_id), що й web Project, а не отримує копію БД. Однакові колекції, Auth і access policies/RLS для сайту і застосунку. Мобільний клієнт використовує лише PROJECT_PUBLISHABLE_KEY; PROJECT_SECRET_KEY у бандл не потрапляє. Додати це правило в Project Context для агента.
5. Інструкції та шаблони: агент створює екрани auth, список/деталі даних, форму з валідацією за схемою, використовуючи SDK.
6. Збірка iOS/Android (EAS Build або інший сервіс) НЕ реалізується зараз. Додати інтерфейс BuildProvider і документований TODO, бо потрібні акаунти Apple/Google і підписання. Будь-яка публікація в сторах пізніше, як high-risk дія з approval.
7. Intent Router: розпізнавання запитів на мобільний застосунок ("створи мобільний додаток для цього магазину") і створення нового Project типу mobile_app із прикріпленням існуючого DataBackend цієї Company (не копія БД). Якщо у Company кілька DataBackend, агент питає, який саме.

НЕ РОБИТИ: збірки для сторів, push notifications, нативні модулі, що потребують власного білду.

ТЕСТИ:
- Створення mobile_app з шаблону, build/preview у sandbox.
- Auth flow із SDK у RN-середовищі (мок), безпечне зберігання токена.
- Redirect URL/deep link поза allowlist відхиляється.
- Два Project (web і mobile) прикріплені до одного DataBackend; ті самі користувачі й дані; ізоляція від інших DataBackend і компаній збережена.
- PROJECT_SECRET_KEY і DB credentials відсутні в мобільному бандлі й файлах.

КРИТЕРІЇ ПРИЙМАННЯ:
- Користувач має магазин (сайт + БД + Auth) і просить мобільний застосунок: агент створює mobile_app, що логіниться тими самими користувачами і показує ті самі товари; Live Preview працює.
````

---

## D7. Середовища dev/prod, backups, застосування міграцій при deploy

````
ЗАВДАННЯ: надійність і безпечний перехід від розробки до продакшну. Спирайся на D1-D6 і (якщо вже реалізований) DeployProvider з Website Builder.

Зробити:
1. Середовища: dev (для Live Preview і розробки агентом) і prod належать DataBackend. DatabaseProvisioner працює з dataBackend + environment. Окремі бази (або окремі схеми з окремими ролями за рішенням аудиту), окремі три ролі, ключі Project API і JWT signing keys для кожного environment.
2. Promote (dev -> prod, на рівні DataBackend): спершу detectDrift для prod (статус має бути synced, інакше promote блокується); migration lock на dataBackend + environment; показати schema diff, прапорці міграцій (reversible, destructive, requires_snapshot), кількість зачеплених даних; створити snapshot prod (обов'язково для destructive і requires_snapshot); застосувати лише після approval через існуючу approval-систему. Автоматичного застосування міграцій при deploy без approval немає. Дані dev не копіюються в prod, якщо користувач явно не обрав seed-дані. Після застосування оновити fingerprint prod.
3. Backups (на рівні DataBackend + environment): автоматичні snapshots за розкладом (конфігуровано: періодичність і кількість), snapshot перед кожною destructive/requires_snapshot-міграцією і перед promote, ручний backup/restore в UI. Збереження в окремому volume (опціонально зовнішнє сховище через інтерфейс). Restore вимагає approval. Backup/restore даних не потрапляє в prompts агента. Задокументувати, що дані, видалені за GDPR, залишаються в backups до закінчення retention.
4. Seed data: опціональні демо-дані для шаблонів (ecommerce тощо), що застосовуються лише в dev.
5. Quotas і моніторинг: розмір БД, кількість підключень, запити, відображення в Data Studio; попередження при наближенні до ліміту; блокування записів при перевищенні жорсткого ліміту з чітким повідомленням.
6. Зовнішні бази: ExternalDatabaseProvisioner (підключення користувачем власної Postgres/Neon/Supabase за connection string у secret storage). Перед використанням: introspectSchema, перевірка можливості створити окремі migrator і runtime ролі та підтримки RLS; якщо неможливо, обмежений режим із чітким повідомленням. Drift detection (introspectSchema, schemaFingerprint, detectDrift) обов'язково виконується перед кожною міграцією і promote, бо зовнішню схему можуть змінювати поза NPATI. Статуси synced / drift_detected / reconciliation_required; автоматичне reconciliation не реалізується, лише diff і рішення користувача.
7. Життєвий цикл: архівація Project не зупиняє DataBackend, якщо до нього прикріплені інші активні Project. Видалення Project лише відв'язує його (CORS origin і ключові прив'язки Project прибираються). Видалення DataBackend заборонене, поки є прикріплені активні Project; після відв'язування видаляє бази, ролі, ключі та секрети після періоду збереження snapshot (конфігуровано).
8. Документація для self-hosted встановлення: як запустити postgres-projects, змінні оточення, backup, відновлення, оновлення, типові помилки.

ТЕСТИ:
- Promote: diff, destructive без approval заблоковано, після approval виконується, після відмови ні; snapshot перед застосуванням.
- Restore snapshot відновлює схему й дані; restore без approval заблоковано.
- Ключі dev не працюють на prod.
- Ліміти розміру БД.
- Паралельний promote на один dataBackend + environment блокується migration lock.
- Promote при drift_detected на prod заблоковано; після рішення користувача дозволено.
- Зовнішня БД: introspection, fingerprint і виявлення drift працюють; без можливості створити ролі/RLS вмикається обмежений режим.
- Видалення Project не видаляє DataBackend, якщо є інші Project; видалення DataBackend очищає БД, ролі, секрети, ключі.
- Ізоляція між компаніями/користувачами і середовищами.
- Регресія: Website Builder, Deploy, Data Studio, Project Auth.

КРИТЕРІЇ ПРИЙМАННЯ:
- Користувач розробляє магазин у dev, натискає Promote, бачить diff, підтверджує, і prod отримує ту саму схему. Після помилкової міграції відновлює prod зі snapshot.
````

---

## Чекліст регресії після кожного кроку

- Створення та редагування Company, агенти, Main Agent
- Knowledge, Memory
- Run Company: auto, single, pipeline, fusion
- Capability Inspector (нові capabilities видимі з коректними risk/approval)
- Activity & Run Trace
- Website Builder: Projects, Files, Terminal, Preview, Changes
- AI Providers, звичайний Chat
- Основна БД NPATI працює незалежно від postgres-projects
- typecheck, lint, tests, build