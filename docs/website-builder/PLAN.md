# NPATI Website Builder: покрокові промти

Як користуватися:

1. Кожен крок запускайте окремою сесією кодувального агента.
2. На початку кожного кроку вставляйте **Спільний блок правил** (нижче) і потім текст кроку.
3. Не переходьте до наступного кроку, поки не виконані критерії приймання поточного.
4. Після кроку 0 перегляньте документ аудиту вручну і за потреби відкоригуйте наступні промти під реальну структуру репозиторію.

---

## Спільний блок правил (вставляти перед кожним кроком)

````
КОНТЕКСТ
Ми додаємо до NPATI AI Agent функцію Multi-Agent AI Website Builder як частину існуючої системи Company. Це НЕ окремий продукт. Ланцюжок: Company -> Main Agent -> Specialist Agents -> Capabilities -> Runs -> Activity, розширений сутностями Project -> Workspace -> Sandbox -> Files/Terminal/Git -> Preview.

ГЛОБАЛЬНІ ПРАВИЛА
1. Весь код, назви змінних, capabilities, міграцій, API-маршрутів і коментарі пишемо англійською. Спілкування зі мною українською.
2. Не припускай структуру backend. Спочатку знайди фактичну реалізацію. Якщо у документі docs/website-builder/00-audit.md вже є аудит, спирайся на нього.
3. Не дублюй існуючі системи (Runs/Tasks, capability registry, approval, Intent Router, background jobs, storage, permissions, AI routing/budget). Розширюй їх.
4. Не видаляй і не переписуй робочий код без необхідності. Дотримуйся naming conventions, UI-компонентів і стилю NPATI.
5. Усі зміни схеми БД тільки через поточну систему міграцій.
6. Безпека обов'язкова на кожному кроці: tenant isolation (user -> company -> project -> workspace -> sandbox), недовіра до project_id/company_id/sandbox_id/file path з фронтенду, заборона path traversal, секрети не потрапляють у prompts, логи, Activity UI.
7. Логіка не прив'язується до конкретної AI-моделі, до назв агентів (agent.name) чи до одного sandbox/deploy provider.
8. Працюй лише в межах поточного кроку. Все, що поза межами, не реалізуй (максимум інтерфейс або TODO з посиланням на майбутній крок).
9. Наприкінці: запусти доступні typecheck, lint, tests, build. Виправ усі помилки, спричинені твоїми змінами. Не ламай існуючі функції (Company, Agents, Main Agent, Knowledge, Memory, Run Company: auto/single/pipeline/fusion, Capability Inspector, Activity, AI Providers, Chat).
10. У фінальному звіті: список змінених/доданих файлів, що зроблено, що навмисно не зроблено, як перевірити вручну, відомі ризики.
````

---

## Крок 0. Аудит і план інтеграції (без змін коду)

````
ЗАВДАННЯ: лише аналіз. НЕ змінюй жодного файлу коду, схеми БД чи конфігурації. Єдиний дозволений результат: файл docs/website-builder/00-audit.md.

Дослідити фактичну реалізацію в репозиторії і описати:

1. Company: модель, сервіси, API, UI (apps/web/src/CompanyPage.tsx).
2. Company agents: ієрархія parent -> child, ролі, system instructions, вибір моделі, fallback, capabilities, активність.
3. Company Memory і Company Knowledge.
4. Run Company: режими auto/single/pipeline/fusion, де реалізований execution engine, як створюються Run і Task, як зберігаються.
5. Approval mechanism: де живе, як запитується і підтверджується, як підключити нову дію.
6. Activity & Run Trace (apps/web/src/ActivityPage.tsx): модель подій, як додати нові типи подій.
7. Capability registry і Capability Inspector (apps/web/src/CapabilityInspectorPage.tsx): формат опису capability (id, domain, type, risk, agent callable, approval required), конвенція назв, як реєструються нові.
8. Intent Router: де знаходиться, як класифікує, як передається контекст розмови.
9. Tool execution infrastructure: як агент викликає tools, як перевіряються permissions.
10. Background jobs / workers, file storage, integrations (особливо GitHub), AI routing/budget/fallback, система міграцій БД, API-конвенції, test infrastructure (backend і frontend).
11. Те, що вже частково існує і стосується Files/Terminal/Git/Preview/Sandbox.
12. Apps/web/src/App.tsx: навігація та маршрутизація.

ФОРМАТ документа:
- Таблиця "Що вже є -> де знаходиться (шлях до файлів) -> що перевикористати/розширити".
- Список того, чого немає і що треба створити.
- Пропозиція, як відобразити сутності Project, ProjectRun, ProjectTask, Checkpoint на існуючі Run/Task таблиці (reuse чи нові таблиці, з обґрунтуванням).
- Порівняння 2-3 варіантів першого SandboxProvider для поточної інфраструктури NPATI (Docker з обмеженнями, віддалений runner тощо) з плюсами/мінусами. Рекомендація, який обрати для MVP. Вимоги до Docker-варіанту: непривілейований користувач, ліміти CPU/RAM/disk, мережа за allowlist, без доступу до docker socket хоста.
- Ризики та відкриті питання до мене.
- Уточнений поділ кроків 1-5 під реальну архітектуру (які файли і модулі зачіпає кожен крок).

КРИТЕРІЇ ПРИЙМАННЯ:
- У репозиторії змінений лише docs/website-builder/00-audit.md (перевір git status).
- Кожне твердження в аудиті має посилання на конкретний файл.
- Є явна рекомендація щодо sandbox provider та reuse Run/Task.
````

---

## Крок 1. Сутність Project, міграції, API, Company -> Projects

````
ЗАВДАННЯ: foundation для Project без sandbox і файлів.
Спирайся на docs/website-builder/00-audit.md.

Зробити:
1. Міграції та моделі: projects (id, company_id, name, description, type, status, framework, runtime, repository_provider, repository_url, repository_branch, workspace_id, sandbox_id, preview_url, preview_port, created_by, created_at, updated_at, last_run_id, last_build_status). type: website, web_app, landing_page (розширюваний enum). status: creating, ready, working, building, previewing, failed, archived. Додатково таблиці для project_runs/project_tasks/project_checkpoints/project_previews ТІЛЬКИ якщо аудит показав, що reuse існуючих Run/Task неможливий. Інакше додай лише зв'язок Run -> Project.
2. Backend service ProjectService і API за конвенціями NPATI: create, get, list by company, update (rename), archive, delete. Кожен запит перевіряє user -> company -> project через існуючу систему permissions.
3. UI: у Settings -> Company додати розділ Projects (інтегрувати в поточну структуру сторінки, не ламаючи її). Cards: назва, type, framework, status, last updated, дії Open / Rename / Archive / Delete. Діалог New Project з варіантами Create with AI / Import repository / Upload project; у цьому кроці активний лише створення запису Project (інші варіанти позначені як coming soon).
4. Порожня сторінка Project (header з назвою та статусом) як заглушка маршруту.

НЕ РОБИТИ: workspace, sandbox, файли, terminal, preview, Intent Router.

ТЕСТИ:
- CRUD Project.
- Користувач компанії A не бачить і не змінює проєкти компанії B (list, get, update, delete).
- Користувач без доступу до Company отримує відмову.
- Архівований Project не показується у списку за замовчуванням.

КРИТЕРІЇ ПРИЙМАННЯ:
- Міграція застосовується і відкочується чистo.
- Company -> Projects працює в UI: створення, перейменування, архівація, видалення.
- Тести ізоляції зелені. Існуючі тести та build не зламані.
````

---

## Крок 2. ProjectWorkspace і Files capabilities

````
ЗАВДАННЯ: абстракція workspace і файлові інструменти для агентів.
Спирайся на docs/website-builder/00-audit.md та результат кроку 1.

Зробити:
1. Інтерфейс ProjectWorkspace з операціями: listFiles, readFile, writeFile, createFile, editFile, deleteFile, moveFile, searchFiles, getFileTree. Логіка застосунку не залежить від конкретного filesystem path. Логічний шлях: /workspaces/{company_id}/{project_id}, але фактичне сховище ховається за інтерфейсом. Workspace знає company, project, current branch, active sandbox, current revision.
2. Перша реалізація storage за інтерфейсом (на основі існуючого file storage NPATI, якщо підходить, інакше локальний ізольований каталог з конфігурованим коренем).
3. Path safety: нормалізація шляху, заборона "..", абсолютних шляхів, symlink-виходів за межі workspace, null bytes. Ліміти розміру файлу та кількості файлів (конфігуровані).
4. Revision control: кожен файл має revision (hash або лічильник). writeFile/editFile приймають expected_revision. При невідповідності повертається структурована помилка revision_conflict із поточною revision. Агент не може тихо перезаписати чужі зміни. Повна блокувальна логіка між кількома агентами належить Phase 2, тут лише expected_revision.
5. Capabilities у canonical registry за конвенцією NPATI (приклад ID: project.files.list, read, search, create, write, edit, move, delete). Якщо аналоги вже існують, перевикористай. Метадані: domain, type, risk (read = low, write = medium, delete = high), agent callable, approval required (mass delete -> approval через існуючу approval-систему). Capabilities мають бути видимі в Capability Inspector.
6. Виконання capability проходить через існуючу tool infrastructure з перевіркою: користувач -> company -> project -> workspace -> дозвіл агента (Project Read / Project Write).
7. У редакторі Company Agent додати permissions Project Read та Project Write (інші permissions Terminal/Git/Preview/Deploy додаються в наступних кроках).
8. API: get file tree, read file (для UI). UI вкладка Files на сторінці Project: дерево та перегляд файлу (read-only), пошук.

НЕ РОБИТИ: sandbox, terminal, preview, git, multi-agent, ручне редагування у UI.

ТЕСТИ (обов'язково в цьому кроці, не наприкінці):
- Path traversal: "../../etc/passwd", "/etc/passwd", "a/../../b", symlink назовні, null byte відхиляються.
- Ізоляція: project_id іншої company, іншого користувача, підміна workspace_id.
- Агент без Project Write не може викликати write/edit/delete. Агент без Project Read не може читати.
- revision_conflict при застарілому expected_revision.
- Mass delete вимагає approval.
- Capabilities відображаються в Capability Inspector.

КРИТЕРІЇ ПРИЙМАННЯ:
- Агент із Project Write через звичайний Run створює і редагує файли у workspace, зміни видно у Files UI.
- Усі тести вище зелені, існуючі тести не зламані.
````

---

## Крок 3. SandboxProvider, Terminal, risk classification

````
ЗАВДАННЯ: ізольований runtime і контрольований terminal.
Спирайся на docs/website-builder/00-audit.md (розділ про вибір sandbox provider) та кроки 1-2.

Зробити:
1. Інтерфейс SandboxProvider: createSandbox, startSandbox, stopSandbox, destroySandbox, executeCommand, uploadFiles, downloadFiles, exposePort, getLogs, getStatus. Бізнес-логіка залежить лише від інтерфейсу.
2. Перша реалізація: провайдер, обраний в аудиті (рекомендовано Docker). Вимоги: непривілейований користувач, ліміти CPU/RAM/disk/pids, мережа за allowlist (npm/pypi registry тощо), без docker socket і без монтування чогось, окрім workspace проєкту, без secrets хоста в середовищі. AI-код НІКОЛИ не виконується на основному сервері NPATI.
3. Синхронізація workspace <-> sandbox (початково через uploadFiles/downloadFiles або mount з обмеженнями), без порушення revision control із кроку 2.
4. Життєвий цикл: Project.sandbox_id, статус sandbox, автоостановка за неактивності (конфігуровано), очищення при видаленні/архівації Project.
5. Capabilities: project.terminal.exec та project.terminal.process (довготривалі процеси: старт, статус, логи, зупинка). Метадані в registry та Capability Inspector.
6. Timeouts: дефолт 120 с для команди, 600 с для install/build (конфігуровано). Обмеження розміру виводу. Завершення процесів при timeout. Агентський run не може зависнути назавжди.
7. Risk classification команд (парсинг команди, а не лише перевірка першого слова; враховувати pipe, &&, ;, subshell, змінні, backticks):
   - Safe: ls, pwd, cat, npm run build, npm test, git status, git diff тощо.
   - Controlled: npm/pnpm/yarn install, pip install, composer install (виконуються лише в sandbox, логуються).
   - Approval required: git push, deployment, database migration, mass delete (rm -rf поза build-артефактами), доступ до production, зовнішні credentials, curl/wget з невідомих хостів, будь-що деструктивне.
   - Невідома команда -> approval required за замовчуванням.
   Approval тільки через існуючу approval-систему.
8. Permission Terminal у редакторі Company Agent. Агент без нього не викликає terminal.
9. Не обмежувати Node.js: runtime визначається проєктом (npm/pnpm/yarn, python/pip, composer, git).
10. Редакція секретів у виводі команд та логах. Окремий механізм env vars/secrets: значення зберігаються в існуючому secret storage, агент отримує лише reference, значення не потрапляють у prompts, Project Context, Company Memory, логи, Activity UI.
11. UI: вкладки Terminal (read-only лог виконаних агентом команд і вивід) та Logs на сторінці Project. Ручний ввід команд користувачем лише якщо це природно вписується в поточну архітектуру, інакше пропустити.

НЕ РОБИТИ: preview proxy, git-операції (окрім git status/diff як звичайних команд), deploy, multi-agent.

ТЕСТИ:
- Класифікатор: набір команд safe/controlled/approval, включно з обхідними (a && rm -rf /, $(...), `...`, env var підстановки, rm -rf ./).
- Команда з approval не виконується без підтвердження; після підтвердження виконується; після відмови ні.
- Timeout завершує процес і повертає структуровану помилку (status, message, step, tool, retryable).
- Sandbox не бачить файлів хоста і інших проєктів; project A не може виконати команду в sandbox project B.
- Агент без Terminal отримує permission denied.
- Помилки: sandbox creation failure, install failure, команда не знайдена.
- Секрет не з'являється у логах/виводі.

КРИТЕРІЇ ПРИЙМАННЯ:
- Агент у звичайному Run створює файли, запускає npm install і npm run build у sandbox, результат видно у Terminal/Logs.
- Жодна команда не виконується на хості NPATI. Тести зелені.
````

---

## Крок 4. Preview Server, Live Preview, Changes

````
ЗАВДАННЯ: запуск сайту, безпечний preview, відображення змін.
Спирайся на кроки 1-3.

Зробити:
1. Preview service: визначення package manager (lockfile), framework, dev command, порту. НЕ hardcode npm run dev: спершу визначення з package.json/конфігурації проєкту, потім fallback-евристики. Запуск dev server як sandbox process через project.terminal.process.
2. Preview URL ніколи не відкриває внутрішній порт контейнера. Використати authenticated reverse proxy із підписаним URL і тимчасовим токеном (TTL 15 хв за замовчуванням, оновлюється з UI). Токен прив'язаний до user + company + project + sandbox. Зміна ID в URL не дає доступу до чужого preview. Налаштувати proxy для WebSocket/HMR.
3. Моніторинг: якщо dev server впав, система виявляє це і перезапускає (максимум 3 автоперезапуски, потім статус failed з повідомленням). Build/runtime error відображається як error state з текстом помилки, а не білий iframe.
4. Після успішного запису файлу preview оновлюється через hot reload dev server; якщо hot reload недоступний, UI оновлює iframe.
5. Project статуси: creating/ready/working/building/previewing/failed оновлюються коректно. Поле last_build_status.
6. Capability project.preview.start/stop/status у registry; permission Preview у редакторі агента.
7. Changes: відстеження змін відносно базового стану (початок run або останній checkpoint; повноцінні checkpoints та git у Phase 2, тут достатньо snapshot-diff на рівні workspace). Показувати Modified/Added/Deleted та unified diff.
8. UI сторінки Project: header (назва, статус, branch, build, preview, Run), ліворуч Files, по центру Chat/Agent activity, праворуч Live Preview, внизу вкладки Changes / Terminal / Logs / Activity. На mobile tabs/panels. Використовувати існуючу design system NPATI.
9. API: start/stop preview, get sandbox status, get changes.

НЕ РОБИТИ: Intent Router, checkpoints/restore, git, multi-agent.

ТЕСТИ:
- Детект package manager/framework/dev command для Next.js, Vite, простого static HTML.
- Preview URL: прострочений токен, токен іншого project/company/user, підроблений ID відхиляються.
- Падіння dev server: автоперезапуск до ліміту, потім failed.
- Build error відображається як error state.
- Порт зайнятий / preview не стартував: структурована помилка.
- Changes коректно рахує modified/added/deleted.

КРИТЕРІЇ ПРИЙМАННЯ (сценарій з оригінального завдання, розділ 55):
Company -> Main Agent -> Developer Agent з project capabilities -> Project -> запит "Create a simple landing page" -> агент створює файли -> sandbox стартує -> build успішний -> preview стартує -> сайт видно у Live Preview -> Changes показує створені файли.
````

---

## Крок 5. Intent Router, Active Project Context, Activity & Run Trace

````
ЗАВДАННЯ: розпізнавання задач у звичайному чаті, активний проєкт, інтеграція з Activity.
Спирайся на кроки 1-4.

Зробити:
1. Розширити існуючий Intent Router (не створювати другий) інтентами: CREATE_PROJECT, CREATE_WEBSITE, EDIT_PROJECT, EDIT_WEBSITE, CONTINUE_PROJECT, DEBUG_PROJECT, REVIEW_PROJECT, IMPROVE_PROJECT, TEST_PROJECT, BUILD_PROJECT, PREVIEW_PROJECT, CONNECT_REPOSITORY, COMMIT_PROJECT, DEPLOY_PROJECT. Реально працюючі в цьому кроці: CREATE_*, EDIT_*, CONTINUE_PROJECT, DEBUG_PROJECT, BUILD_PROJECT, PREVIEW_PROJECT, TEST_PROJECT. Решта розпізнаються, але відповідають, що функція буде доступна пізніше, або передаються з підказкою.
2. Класифікація не лише за ключовими словами: враховувати розмову, active company, active project, попередній run, наявність workspace, намір користувача. Приклади: "Що таке Next.js?" -> CHAT; "Створи мені сайт на Next.js" -> CREATE_PROJECT; "Зроби кнопку на головній більшою" при активному проєкті -> EDIT_PROJECT; те саме без активного проєкту -> уточнення, який проєкт.
3. Active Project Context у розмові: active_company_id, active_project_id, active_workspace_id. Зберігається в стані чату. Після створення сайту наступні повідомлення автоматично редагують цей проєкт. Користувач може явно змінити активний проєкт. Active project валідується на сервері (проєкт належить company користувача, не archived).
4. Project Manager як orchestration layer поверх існуючої task/run architecture (не окремий AI-агент і не другий execution engine). Для MVP режим single: один агент (обирається за role/description/instructions/capabilities, НЕ за agent.name; Main Agent як fallback). Потік: resolve project -> create run -> inspect project -> змінити файли -> build -> preview -> результат.
5. Дослідження перед правкою: перед змінами агент має виконати пошук/читання релевантних файлів (search/read), а не перегенерувати проєкт. Додай у system-інструкції цього сценарію правило "точкові правки, не blind rewrite" і контекст через targeted reads, а не весь репозиторій.
6. Shared Project Context (PROJECT.md або запис у БД): назва, мета, framework, архітектура, конвенції, design system, сторінки, залежності, рішення, відомі проблеми. Створюється при створенні проєкту, оновлюється після runs. НЕ містить секретів і не змішується з Company Memory.
7. Ліміти: build repair loop максимум 3 спроби (прочитати помилку -> знайти файли -> виправити -> build). Після ліміту run завершується зі статусом failed і чіткою причиною. Загальний timeout run (конфігуровано).
8. Інтеграція з Activity & Run Trace: кожен website run потрапляє в існуючий Activity з подіями: запит, план, вибрані агенти, tasks, tool calls, прочитані/змінені файли, виконані команди, build, tests, preview, approvals, помилки, фінальний результат. У Project посилання View Run. Використовувати існуючі AI routing/budget/fallback.
9. Chat UX: після визначення website intent показати Project card у чаті (назва, статус, агенти, build status, кнопки Open Project / Preview / Changes).
10. Створення проєкту з чату: якщо немає активної Company, використати існуючу логіку вибору/запиту Company; не створювати Company мовчки.

НЕ РОБИТИ: multi-agent паралельність, file locking між агентами, git, checkpoints, deploy.

ТЕСТИ:
- Інтент-класифікація: набір українських та англійських прикладів (CHAT vs CREATE vs EDIT, з активним проєктом і без).
- Активний проєкт чужої company/користувача відхиляється.
- Вибір агента за role/capabilities, а не за назвою (агент "Senior React Engineer" виконує frontend-задачу).
- Агент без потрібних capabilities -> зрозуміла відмова/ескалація, без зависання.
- Repair loop зупиняється після 3 спроб.
- Run із помилкою моделі/tool має status, message, step, agent, tool, retryable.
- Подія run видна в Activity; View Run відкриває правильний run.
- Регресія: звичайний чат, Run Company (auto/single/pipeline/fusion), Capability Inspector працюють як раніше.

КРИТЕРІЇ ПРИЙМАННЯ (повний MVP Phase 1):
1. У чаті "Create a website for NovaScale Labs" створює Project, workspace, sandbox, файли, build, preview, Project card.
2. Наступне "Make the header darker" редагує той самий проєкт.
3. Run видно в Activity. Усе ізольовано між companies/users. Небезпечні команди йдуть через approval.
````

---

## Phase 2

### Крок 6. Git і checkpoints

````
ЗАВДАННЯ: Git layer і checkpoints. Спирайся на Phase 1.

Зробити:
1. Git операції в sandbox: status, diff, log, create/switch branch, stage, commit, restore file, restore checkpoint. Capabilities project.git.* у registry; permission Git у редакторі агента.
2. Checkpoints: автоматично перед великими змінами (рахується за порогом кількості файлів/рядків, конфігуровано) і після завершеного run. Назва та опис (приклад "Before redesign"). Реалізація поверх git commits/tags або snapshot, залежно від аудиту. UI: список checkpoints і кнопка Restore (restore сам створює новий checkpoint перед відкатом).
3. Git інтеграція із зовнішнім провайдером (GitHub) лише через існуючу integration architecture. Push, create pull request, будь-який запис назовні = approval required. Credentials у secret storage, ніколи в prompts/логах.
4. Конфлікти git: структуровані помилки, агент не вирішує конфлікти мовчки; максимум 2 спроби auto-resolve, далі ескалація користувачу.
5. Інтенти COMMIT_PROJECT та CONNECT_REPOSITORY стають робочими.

ТЕСТИ: commit/diff/restore, restore checkpoint, push без approval заблоковано, credentials не витікають, ізоляція між projects, git conflict handling.
КРИТЕРІЇ: користувач бачить історію checkpoints, відкочується, агент робить commit у гілку, push тільки після підтвердження.
````

### Крок 7. Імпорт репозиторію

````
ЗАВДАННЯ: Import repository / Upload project. Спирайся на кроки 1-6.

Flow: connect -> clone (лише у sandbox) -> inspect -> detect stack -> install dependencies -> start sandbox -> preview.
- Clone через існуючу GitHub integration; для приватних репозиторіїв credentials з secret storage.
- Upload project: zip з лімітами розміру, захист від zip-slip і zip-bomb.
- Автовизначення framework, package manager, dev command; створення PROJECT.md із результатів аналізу.
- Ліміти розміру репозиторію та таймаути clone/install.

ТЕСТИ: zip-slip, великий репозиторій, невдала install, приватний репозиторій без доступу, ізоляція.
КРИТЕРІЇ: користувач імпортує простий Next.js/Vite репозиторій і бачить Live Preview.
````

### Крок 8. Multi-agent задачі, паралельність, file locking

````
ЗАВДАННЯ: multi-agent розробка поверх існуючої Company orchestration. Спирайся на Phase 1 та кроки 6-7.

Зробити:
1. Main Agent складає план і розкладає його на tasks із depends_on (приклад: Design -> Frontend -> QA; SEO паралельно після структури сторінок). Використати існуючі Run/Task моделі та режими single/pipeline/fusion/auto. Не створювати другий execution engine.
2. Вибір агентів за role, description, instructions, capabilities, model, parent, active status. Ніколи за agent.name.
3. Паралельне виконання лише для tasks без конфліктів файлів. File locking/leases: lock на файл або каталог із TTL, deadlock-захист, звільнення при падінні агента. Разом із expected_revision: при revision_conflict агент робить re-read -> compare -> merge -> retry (максимум 3 спроби), потім ескалація до Main Agent.
4. Агенти бачать статуси задач одне одного (queued/running/completed/failed/waiting). Кожному агенту передається лише: task, релевантний контекст, Project Context, залежності та результати попередніх tasks, а не весь raw conversation.
5. QA loop: implementation -> build -> tests -> preview -> QA -> issues -> Developer fixes. Максимум 2 ітерації, далі фінальний звіт із відкритими issues.
6. IMPROVE_PROJECT: Designer/Frontend/SEO/QA/Security аналізують, потім створюється план і tasks; автоматично не переписувати весь сайт.
7. Бюджет: використовувати існуючі routing/budget/context compression; ліміт кількості model calls на run (конфігуровано), зупинка при досягненні.
8. UI: список агентів і статус задач у Activity та на сторінці Project.

ТЕСТИ: два агенти редагують один файл (конфлікт, merge/retry), паралельні tasks у різних файлах, залежності tasks, падіння одного агента не вішає run, ліміт QA/repair ітерацій, ліміт бюджету, регресія Run Company режимів.
КРИТЕРІЇ: "Create SaaS website" виконується кількома агентами з видимим планом у Activity, без перезапису чужих змін.
````

---

## Phase 3 (окремі запуски за потреби)

### Крок 9. Agent worktrees

````
Додати ізольовані git worktree/гілку на агента (project/main, agent/frontend тощо). Після завершення: review -> merge -> build. Конфлікти merge: структурована ескалація. Не ламати shared-workspace режим із кроку 8 (перемикання конфігурацією). Тести: ізоляція між гілками, merge конфлікт, cleanup worktrees.
````

### Крок 10. DeployProvider

````
Додати інтерфейс DeployProvider і ПЕРШИЙ адаптер, який я обрав (вкажи: Vercel / Cloudflare Pages / Netlify / GitHub / SSH). Deploy завжди high-risk і йде через існуючу approval-систему. Перед approval показати: Environment, Branch, Files changed, Build status, Tests, Target. Credentials тільки через secret storage. Інтент DEPLOY_PROJECT стає робочим. Permission Deploy у редакторі агента. Тести: deploy без approval заблоковано, відмова, витік credentials, ізоляція.
````

### Крок 11. Browser QA

````
Додати capability browser QA: headless браузер усередині sandbox/окремого ізольованого runner відкриває preview, збирає screenshots, console errors, broken links, базові a11y/performance перевірки. QA Agent використовує результати для issues. Ліміти часу і розміру. Тести: ізоляція, timeout, витік секретів у screenshots/логах.
````

---

## Чекліст регресії після кожного кроку

- Створення та редагування Company
- Створення, редагування, ієрархія агентів, Main Agent
- Knowledge, Memory
- Run Company: auto, single, pipeline, fusion
- Capability Inspector (нові capabilities видимі з коректними risk/approval)
- Activity
- AI Providers, звичайний Chat
- typecheck, lint, tests, build