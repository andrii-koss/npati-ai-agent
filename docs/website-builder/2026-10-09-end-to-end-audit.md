# Аудит Website Builder і Data Studio — 2026-10-09

Перевірено `docs/website-builder/PLAN.md`, `docs/data-studio/PLAN.md`, поточний код, маршрути чату, оркестратор, шаблони сайту й даних, sandbox/preview, Auth, SDK, міграції та Promote. Перевірка стосується цього checkout; конфігурацію та журнали розгорнутого сервера не отримано.

**Висновок:** основні модулі обох планів існують, але критерій «запит у чаті → Next.js магазин → БД магазину → реєстрація/вхід → кошик/замовлення → build → Live Preview» не виконаний як гарантований наскрізний процес. Наявність окремих сервісів і зелених mock-тестів не підтверджує цей сценарій.

Нижче збережено початковий аудит стану до виправлень. Після аудиту внесено зміни в продуктовий код; їхній поточний стан описано в наступному розділі. Результати перевірок містяться в `artifacts/` (ця директорія ігнорується Git).

## Внесені виправлення

Для нового Next.js сайта додано послідовний bootstrap перед запуском AI: окремий DataBackend → ecommerce template для магазину → access policies → Auth initialization → SDK і публічна конфігурація → CORS → сторінки входу/реєстрації, каталог, кошик та форми. У тестовому магазині створюється демонстраційний товар. Збій обов’язкової підготовки позначає Project як failed і зупиняє генерацію; повторна спроба для такого Project запускає підготовку ще раз.

| Знахідка початкового аудиту | Внесена зміна / межа |
|---|---|
| F1, F13: прихований збій та неявне спільне використання БД | Нові websites отримують окремий backend. Bootstrap Next.js перевіряє наявність та readiness і повертає помилку замість успіху без БД. Mobile sharing збережено. |
| F2: немає ecommerce/Auth frontend | `website-bootstrap.ts` і `website-data-scaffold.ts` готують схему, SDK, `/auth`, `/shop`, каталог і кошик перед роботою агента. |
| F3: агент не має schema tools | ADD/EDIT_DATA_MODEL обирає агента з конкретними schema capabilities; новий Website Builder отримує data/auth tools. Зміна лише схеми не запускає frontend build. |
| F4: неправильні intents | Створення магазина, комбіновані create/build/preview, mobile type та додавання поля/колонки покриті регресійними тестами. |
| F5: відкритий CRUD каталогу | Публічні policies categories/products/product_variants обмежено SELECT. Створення orders/order_items через publishable API дозволене лише серверним checkout, який рахує ціну з БД та перевіряє власника кошика. Платіжний провайдер і резервування залишків до цієї зміни не входять. |
| F6: частково застосований template | Schema operations, migration history у Project DB і RLS template застосовуються в одній PostgreSQL-транзакції. Помилка DDL робить ROLLBACK; збій подальшого запису Core metadata позначає reconciliation_required. |
| F7: дубльовані relation fields | Relations template використовують існуючі `*_id` поля через FOREIGN KEY constraint. |
| F8: удаване надсилання форми | Contact/forms renderer використовує ProjectForm та append-only API. API робить INSERT без RETURNING, тому не вимагає публічного SELECT приватних повідомлень. Поля довільних forms зберігаються у JSON payload таблиці form_submissions; окремі типізовані поля додаються через schema tools. |
| F9: пізня SDK/config/CORS | Bootstrap вимагає доступний SDK, публічну URL і publishable key; додає origin API та NPATI_WEB_ORIGIN до project CORS. Публічна URL має бути налаштована в оточенні інсталяції. |
| F10: email verification/reset | Локальні signup/signin працюють через Project Auth. Реальну доставку verification/reset листів не підключено цією зміною. |
| F11: GDPR strategies | Template strategies зберігаються в environment і використовуються preview/delete; anonymize прибирає посилання на користувача та відомі персональні текстові/JSON поля. Загальна анонімізація довільної схеми потребує окремої перевірки. |
| F12: подвійний migration lock Promote | Engine приймає внутрішній lock token Promote та перевіряє його власника. Promote також переносить runtime policies, commerce flag і GDPR strategies у цільове оточення. |

Перевірки після виправлень: 225/225 тестів у 21 вибраному файлі, включно з 12 спеціальними регресійними тестами bootstrap та перевіркою повторної спроби в orchestrator; TypeScript згенерованих сторінок і SDK перевірено спільно. Звіт: `artifacts/website-data-remediation-tests.json`. Workspace typecheck, typecheck тестів, lint і окремі build API/web пройшли. Root `npm run build` зупиняється ще на catalog:generate через відсутній у checkout `OMNIROUTE_VERSION`; окремі build API/web завершилися успішно.

**Не підтверджено наживо:** повний чат → реальний AI → PostgreSQL provisioning → Next production build у Docker → браузерна реєстрація/кошик/форма. Docker daemon у цьому оточенні недоступний. Зміни не означають, що всі етапи обох планів прийняті. Для runtime потрібні налаштовані Project PostgreSQL, AI provider, sandbox runner та `NPATI_PROJECT_API_PUBLIC_URL`. Автоматичний Auth/bootstrap додано для Next.js; старий статичний HTML/CSS шлях не перетворюється на Next.js без відповідного запиту.

## Межі доказів

- **Підтверджено кодом/локальним відтворенням:** висновки з конкретних методів та виконаних діагностичних викликів.
- **Перевірено тестами:** модульні й інтеграційні тести з підміною AI, sandbox або PostgreSQL; це не перевірка реального сервера.
- **Не підтверджено наживо:** Docker sandbox, PostgreSQL provisioning/restore, зовнішній deploy, браузерний сценарій реального магазину.
- Docker CLI встановлений, але daemon недоступний: немає pipe `dockerDesktopLinuxEngine`. PostgreSQL integration test пропущено за відсутності необхідного тестового оточення.
- Історичні вимоги «на цьому кроці змінений лише один файл» неможливо підтвердити поточним станом checkout. Старі `current-state.md` використано як довідку, а не як доказ приймання.

## 1. Фактичний шлях вашого запиту

Запит: **«Створи тестовий сайт інтернет магазин на Next.js, запусти build і Live Preview.»**

1. `packages/shared/src/project-intent.ts:103` визначає framework як `Next.js`. Комбінована гілка create + preview на `:203` повертає `CREATE_WEBSITE` без уточнення. Це підтверджено виконанням функції з точним текстом, з активним проєктом і без нього.
2. `/chat` та `/chat/stream` у `apps/agent-api/src/app.ts:7167` і `:7828` передають запит у `ProjectOrchestrator.executeWebsiteTask`. Для create не передають старий projectId. Потрібна доступна Company та підключений AI provider.
3. `apps/agent-api/src/project-orchestrator.ts:396` створює Project і зберігає `Next.js`. `:434` створює Next scaffold. `packages/shared/src/website-renderer.ts:14` дійсно генерує `package.json` з `next`, `next dev`, `next build`, App Router, layout і page.
4. `ProjectService.create`, `apps/agent-api/src/project-service.ts:41`, викликає optional auto-attach. Реальна композиція `app.ts:1164` вибирає готовий DataBackend компанії або створює новий. Це **існує**, але не гарантує БД для кожного сайту.
5. Auto-attach ловить помилки, пише warning `project_data_backend_auto_attach_failed` і повертає `undefined`. `ProjectService` також придушує помилку. Project залишається створеним без БД.
6. Веборchestrator не викликає ecommerce template, налаштування Auth чи API inspect до генерації frontend. Початковий шаблон вибирається лише між `hosting` і `landing`, `project-orchestrator.ts:311`.
7. Агент генерує/редагує файли через Company runtime. Автоматично створений Website Builder має Files/Terminal/Preview, **не має** `data.schema`, `data.write`, `auth.admin` або `project.api.inspect`, `project-orchestrator.ts:159`, `project-agent-capabilities.ts:3`.
8. Для single-шляху після завершення агента `project-orchestrator.ts:733` запускає `buildProject` і `startPreview`, з максимум трьома спробами. Для multi-agent build/QA живе в `project-multi-agent.ts`.
9. `project-preview-service.ts:190` запускає install і build у sandbox. Sandbox створюється у `app.ts:1236` лише за наявності runner URL і secret або переданого provider.
10. Якщо Project API gateway підключений, кожна команда sandbox спершу викликає API environment resolver, `project-sandbox-service.ts:320`. `gateway-service.ts:103` відмовляє для проєкту без DataBackend. Отже прихований збій auto-attach здатний зупинити навіть `npm install` ще до запуску команди.
11. Preview видає підписану адресу через proxy; її наявність сама по собі не перевіряє реєстрацію, збереження форм, кошик або замовлення.

**Що доведено про вашу проблему:** точний текст не губить Next.js у класифікаторі; scaffold є справжнім Next.js. Чому саме ваш розгорнутий запуск не доходить до робочого сайту, без його Run trace встановити однозначно не можна. Перевіряти потрібно AI run, auto-attach warning, runner, install/build і API environment, а не тільки framework detection.

## 2. Підтверджені розриви та дефекти

### F1. БД створюється за принципом best effort, помилка приховується — високий пріоритет

Джерела: `app.ts:1164`, `project-service.ts:41`, `data-studio/service.ts:21`.

Відсутність Core DB configuration, адміністративного пароля projects PostgreSQL, недоступний `postgres-projects` або помилка provisioning залишають сайт без БД. Базовий Compose запускає projects PostgreSQL лише з профілем `data-studio`, `docker-compose.yml:325`. Dokploy Compose має інші умови й обов'язковий пароль. Сам факт наявності Data Studio routes не доводить готовність shared PostgreSQL: ProvisionerRouter може існувати тільки з external adapter.

Потрібний результат: для data-backed сайту повертати явний стан provisioning/failed і зрозумілу помилку. Відокремити коректний режим сайту без даних від збою обов'язкового backend. Не приховувати його за повідомленням про створення сайту.

### F2. Немає автоматичного bootstrap схеми магазину й frontend Auth — критично для вашого сценарію

Джерела: `project-orchestrator.ts:311`, `:396`, `:449`, `website-renderer.ts:14`, `project-data-templates.ts:111`.

Auto-attach створює/приєднує базу, але не її бізнес-таблиці. Ecommerce schema template існує окремо та не вибирається автоматично при створенні магазину. Next scaffold не містить `signUp`, `signIn` або `npati-client`; локальне відтворення це підтвердило.

Потрібно з'єднати bootstrap backend → ecommerce schema → policies → Auth readiness → SDK/client configuration → сторінки реєстрації/входу → frontend запити. Backend Auth API і форми на згенерованому сайті — різні частини, обидві потрібні.

### F3. Запити до БД потрапляють до агента без відповідних прав — високий пріоритет

Джерела: `project-orchestrator.ts:114`, `:159`, `:375`; `company-tool-runtime.ts:518`; `project-data-capabilities.ts`.

`ADD_DATA_MODEL` і `EDIT_DATA_MODEL` не мають окремого вибору data-capable агента: orchestrator обирає Website Builder за файловими capabilities. Обраний агент може бути придатним для frontend, але не для зміни схеми. Додавання поля через чат тому не гарантоване навіть при підключеній БД.

Потрібно обирати виконавця за потрібними capabilities конкретного наміру та передавати project/backend/schema context. Не покладатися на назву агента чи на випадкове рішення AI.

### F4. Частина природних формулювань маршрутизується неправильно — підтверджено виконанням

| Запит | Без активного Project | З активним Project |
|---|---|---|
| Точний ваш запит зі словами «сайт» і «Live Preview» | CREATE_WEBSITE, Next.js | CREATE_WEBSITE, Next.js |
| «Створи інтернет магазин на Next.js» | CHAT | ADD_DATA_MODEL |
| «Створи інтернет-магазин на Next.js» | CHAT | ADD_DATA_MODEL |
| «Додай поле phone до таблиці customers» | Уточнення Project | ADD_DATA_MODEL, підказка templates.apply |
| «Додай колонку phone у customers» | CHAT | CHAT |
| «Створи мобільний додаток для магазину і запусти Live Preview» | CREATE_PROJECT без mobile type | CREATE_PROJECT без mobile type |

Джерело: `project-intent.ts:73`, `:91`, `:203`, `:271`, `:294`.

Класифікатор переважно regex-based; аргументи conversationHistory/lastRunStatus не означають, що вони реально враховуються. Комбінована create + preview гілка втрачає `projectType: mobile_app`, тому mobile запит може створити звичайний website. Додавання колонки треба направляти до `add_field`, а не до застосування всього шаблону.

### F5. Ecommerce template відкриває публічний запис і видалення каталогу — критично

Джерела: `project-data-templates.ts:202`, `rls-compiler.ts:74`, `gateway-service.ts:377`, `auth-service.ts:1029`.

Політики categories/products/product_variants мають `rule: public` без `actions`. Обидва виконавці — gateway і RLS compiler — трактують відсутні actions як `all`. Відтворений SQL містить публічні INSERT, UPDATE і DELETE з `true`. Runtime отримує DML GRANT.

За застосованого шаблону й валідного publishable key/origin відвідувачеві дозволяються зміни каталогу. Це не обхід RLS: RLS саме так скомпільована.

Потрібно `public/select` для каталогу і окремі права керування. Замовлення, ціни, залишки та підсумки також потребують бізнес-правил; generic CRUD не дорівнює повноцінному checkout.

### F6. Template apply не атомарний, компенсаційний rollback не працює для нових таблиць — критично

Джерела: `agent-data-service.ts:403`, `migration-engine.ts:73`, `:146`, `data-provider.ts:120`.

Коментар «Execute operations atomically in a transaction» не відповідає коду: цикл викликає `migrations.apply` окремо для кожної операції. Кожна має власний BEGIN/COMMIT і lock. На помилці викликається rollback попередніх міграцій, але `create_collection` і `create_relation` позначені `reversible: false`; реальний rollback повертає SNAPSHOT_REQUIRED. Ці помилки додатково придушуються.

Тому після збою шаблону можуть лишитися частково створені таблиці. Mock у `tests/data-studio-agent-capabilities.test.ts:162` повертає успішний rollback без перевірки цих правил і не доводить атомарність.

Потрібна batch migration з однією транзакцією/lock, узгодженим журналом і policies, або гарантований snapshot recovery з перевіркою результату. Seed виконується після schema apply, теж окремо.

### F7. Ecommerce FK створюються в інших колонках, ніж поля шаблону — високий пріоритет

Джерела: `project-data-templates.ts:135`, `:194`, `data-provider.ts:165`.

Шаблон створює `products.category_id`, але relation названий `category`. `createRelation` додає нову колонку `category uuid REFERENCES categories(id)` замість FK на існуючий category_id. Аналогічно product_id/product, cart_id/cart, variant_id/variant, order_id/order.

Frontend або seed, що заповнює *_id, обходить ці фактичні FK. Потрібний контракт relation з explicit source field і додаванням constraint на нього; не створювати паралельне поле з іншою назвою.

### F8. Форми не мають гарантованого збереження — високий пріоритет

Джерела: `website-renderer.ts:628`, `:692`, `website-schema.ts:571`.

Contact renderer виконує preventDefault + `alert("Thank you! Message sent.")`. Запиту до Project API та запису в БД немає. Тип `forms` є в schema catalog, але в Next BlockRenderer немає відповідного case: default повертає null.

Для кожної форми потрібні explicit collection/field bindings, серверна валідація, access policy, збереження через SDK і перевірка, що рядок видно в Data Studio. Login/register повинні працювати з Auth service, а не зі звичайною таблицею паролів.

### F9. SDK/configuration/CORS не підготовлені як обов'язковий крок до генерації — високий пріоритет

Джерела: `gateway-service.ts:123`, `:670`, `studio-service.ts:292`, `project-sandbox-service.ts:320`, `app.ts:1130`.

SDK з'являється через API inspect або sandbox environment resolver. Website agent не має inspect capability автоматично. `NPATI_PROJECT_API_PUBLIC_URL` optional; без неї resolver повертає порожній env. До цього він уже вимагає attached backend.

Автоматичної реєстрації preview origin у `corsOriginsByProject` у переглянутому creation/preview шляху немає: запис робиться через Data Studio configuration. Next scaffold не містить browser client config; серверні `PROJECT_*` env самі по собі не стають доступними browser JS.

Потрібно доставляти SDK і публічну конфігурацію до AI-генерації, реєструвати конкретний preview origin і перевіряти запит браузера. DB credentials і PROJECT_SECRET_KEY повинні залишатися поза sandbox/frontend.

### F10. Auth існує, але email verification не готовий у штатній композиції

Джерела: `auth-service.ts:57`, `:162`, `:234`, `app.ts:1154`, `email-provider.ts:25`, `project-auth-types.ts:27`.

Auth tables/signing keys ініціалізуються через Auth flow; auto-attach не готує їх явно. Default allowRegistration=true і requireEmailVerification=false. Якщо ввімкнути verification або запросити password reset, штатний `UnconfiguredEmailProvider` поверне EMAIL_SERVICE_UNCONFIGURED. `app.ts` не передає реального email provider.

Наявність mock email tests не підтверджує надсилання листів користувачам. Потрібні реальний adapter, redirect allowlist і перевірка повного flow.

### F11. GDPR defaults шаблону не застосовуються; anonymize несумісний з обов'язковим owner_id

Джерела: `project-data-templates.ts:212`, `agent-data-service.ts:320`, `auth-service.ts:1166`, `:1228`.

Template декларує orders=retain, addresses=anonymize, але applyTemplate не зберігає ці стратегії. Auth deletion вибирає за замовчуванням orders=anonymize, інші=delete. Anonymize реалізований як SET owner_id=NULL, тоді як ecommerce orders/order_items мають required owner_id. На реальній БД це конфліктує з NOT NULL. Потрібні узгоджені metadata, FK/nullability та реальне затирання персональних полів.

### F12. Promote захоплює lock, потім блокує власну міграцію — критично для D7

Джерела: `promote-service.ts:266`, `:310`, `migration-engine.ts:84`, `repository.ts:266`.

Promote бере Core lock на backend+prod. Усередині викликає реальний engine.apply, який бере той самий lock з іншим token. Repository дозволяє заміну тільки після TTL. Перша pending migration повертає MIGRATION_BUSY, доки зовнішній lock живий.

Локально відтворено **реальними PromoteService та ProjectMigrationEngine** з детермінованим lock repository: перше acquire=true, друге acquire=false, помилка MIGRATION_BUSY. PostgreSQL не викликався, бо відмова відбувається до отримання connection.

Крім того, Promote відтворює schema operations, але не переносить access policy metadata та їх окремий RLS compilation із dev. Одних таблиць недостатньо для робочого prod API. Потрібний єдиний owner lock/пакет міграцій і явне перенесення policies/configuration з окремими prod ключами.

### F13. Автоматичне приєднання БД мовчки об'єднує різні сайти компанії

Джерело: `app.ts:1171`.

Вибирається перший готовий backend компанії, навіть якщо створюється незалежний магазин. План дозволяє shared backend, але не вимагає, щоб усі незалежні сайти автоматично мали спільні дані/Auth. Можливі конфлікти products/categories між різними проєктами. Потрібно визначити правило: новий backend для незалежного data-backed сайту; явне reuse для mobile/пов'язаного frontend. Непридатний backend не слід вибирати через fallback backends[0].

## 3. Перевірка кожного кроку Website Builder

«Модуль є» нижче означає реалізацію і відповідні локальні тести; повне приймання у реальному оточенні окремо не підтверджене.

| Крок | Що реально є і де | Результат відносно плану |
|---|---|---|
| 0. Audit/integration | `00-audit.md`, Company runtime, capability registry, міграції | Документ є; історичні обмеження diff не перевірені. Потрібне оновлення висновків цим аудитом. |
| 1. Project | `migration-054.ts`, workspace stores, `project-service.ts`, `project-routes.ts`, `ProjectSection.tsx` | CRUD, company/tenant checks, existing Runs linkage, archive/revisions перевірено тестами. Реальне apply/rollback PostgreSQL не підтверджено. Auto-attach має F1/F13. |
| 2. Files/workspace | `project-workspace.ts`, `project-files-integration.test.ts`, agent permissions | Path safety, isolation, expectedRevision, Files tools/API перевірено. Масове видалення використовує approval. Початковий Files UI розширено пізнішими кроками. |
| 3. Sandbox/terminal | `sandbox-provider.ts`, `docker-sandbox-provider.ts`, `project-sandbox-service.ts`, `terminal-command-policy.ts` | Provider abstraction, remote execution, command risk/timeout/redaction та isolation мають тести. Реальні image/network/resource limits не запущені. Для AI-коду host execution не використано. F1 може блокувати terminal через F9. |
| 4. Preview/Changes | `project-preview-service.ts`, `project-preview-routes.ts`, `project-workspace.ts:521`, `ProjectPage.tsx` | Stack detection, token scope/TTL, restart/error/changes перевірено тестами. Реальний Next HTTP/HMR не підтверджений. Sessions у пам'яті процесу — recovery після restart/multiple API replicas потребує окремої перевірки. |
| 5. Intent/context/Activity | `project-intent.ts`, `active-context-resolver.ts`, `project-orchestrator.ts`, chat routes | Точний Next запит розпізнається. Active context, cards, Runs і repair loop перевірено. F2–F4/F9 порушують business flow. PROJECT.md створюється, але системного оновлення рішень/known issues після кожного run немає. |
| 6. Git/checkpoints | `project-git-service.ts`, `project-git-routes.ts`, Git capabilities | Commit/diff/checkpoint/restore/approval/isolation мають тести. Зовнішній Git push наживо не перевірено. Помилки automatic checkpoints у orchestrator придушуються. |
| 7. Import/upload | `project-import-service.ts`, `project-import.test.ts` | Repository/template/zip paths і limits перевірено тестами. Clone/install приватного репозиторію та Live Preview наживо не підтверджено. |
| 8. Multi-agent | `project-multi-agent.ts`, `project-task-graph.ts`, `project-file-lock.ts` | Task dependencies, shared leases, bounded QA/verification мають тести. Це код продукту; під час цього аудиту додаткові агенти не запускались. Реальна AI-команда не перевірена. Data bootstrap не є обов'язковою dependency frontend. |
| 9. Worktrees | `project-git-service.ts`, `project-multi-agent.ts`, `project-git-worktrees.test.ts` | Branch/worktree isolation, merge/conflict/cleanup мають тести. Реальна багатоагентна розробка в runner не підтверджена. |
| 10. Deploy | `deploy-provider.ts`, `project-deploy-service.ts`, `project-deploy.test.ts` | Deploy abstraction і Dokploy integration/approval є. Це уточнення початкового плану adapter choice. Зовнішній deploy не виконувався; D7 має F12. |
| 11. Browser QA | `project-browser-qa-service.ts`, `project-browser-qa.test.ts` | QA interface/results/timeouts/isolation мають тести. Реального браузера в runner не запускали. Перевірка links/a11y не замінює checkout/Auth/form persistence. |

## 4. Перевірка кожного кроку Data Studio

| Крок | Реалізація/докази | Результат відносно плану |
|---|---|---|
| D0. Audit | `docs/data-studio/00-audit.md` | Архітектурний документ є. Позначки completed у current-state не є підтвердженням наскрізного магазину. |
| D1. Provisioner/data/migrations | `migration-060.ts`, `repository.ts`, `service.ts`, `provisioner.ts`, `data-provider.ts`, `migration-engine.ts`, Compose | Є окремий projects PostgreSQL, dev/prod, migrator/runtime, server admin, secret refs, RLS default-deny, validated identifiers/parameterized values, locks, diff, history, fingerprints, snapshots і limits. Реальна role isolation/provisioning/restore пропущена. F1/F6/F7 впливають на створення schema. |
| D2. Data Studio UI | `DataBackendSection.tsx`, `DataStudioPage.tsx`, `studio-service.ts`, `studio-routes.ts`, UI/API tests | Backend/project linkage, environments, CRUD schema/rows, relations, CSV/JSON, migration flags, errors/drift/lock представлені. API tests проходять; ручне браузерне приймання не виконано. Це редактор, не автоматичне створення таблиць із форми. |
| D3. Agent capabilities/templates | `project-data-capabilities.ts`, `project-data-templates.ts`, `agent-data-service.ts`, `company-tool-runtime.ts` | Structured operations, capability groups, dry-run/approval, dev scope, шаблони й PROJECT.md schema є. F3/F4 не гарантують виконавця в чаті; F5/F6/F7/F11 порушують безпечний повний template flow. Generic schema.apply у Company runtime класифікується high незалежно від additive operation — поведінка суворіша за план medium для add_field. |
| D4. Project Auth | `auth-service.ts`, `auth-crypto.ts`, `auth-migration.ts`, `rls-compiler.ts`, `auth-routes.ts`, `DataStudioAuthSection.tsx` | Password hashing, JWT issuer/audience/kid, refresh rotation/revoke, reset/verify, admin UI, policies, GDPR мають тести. Email adapter не підключений, F10; frontend login/register не генерується гарантовано, F2; GDPR mismatch, F11. Registration existing email повертає окремий EMAIL_ALREADY_EXISTS, що не виконує вимогу відсутності enumeration. |
| D5. Gateway/SDK/site integration | `gateway-service.ts`, `gateway-routes.ts`, `api-key-manager.ts`, `openapi-generator.ts`, `project-sdk-file.ts`, `packages/project-client/src/index.ts` | /v1 CRUD/Auth, keys, rate limits/CORS, runtime transaction context, SDK/OpenAPI, logs/quotas є. Найважливіший acceptance criterion магазину не підтверджено й не гарантовано кодом: F2/F3/F5/F8/F9. Один environment test падає через застаріле exact equality. |
| D6. Mobile | `mobile-app-template.ts`, mobile intent, shared backend resolution, redirect repository, SDK storage | Expo scaffold, SecureStore/shared Auth/API і redirect allowlist перевірено mock-тестами. Комбінований mobile + Live Preview губить mobile type, F4. Реальний Expo build/preview не перевірено; store builds і push навмисно поза планом. |
| D7. Prod/backups/external | `promote-service.ts`, `backup-service.ts`, `quota-service.ts`, `external-provisioner.ts`, `SELF_HOSTING.md` | Services, approval, snapshots/retention, quotas, external managed/restricted mode, detach/lifecycle є. Promote ламається через nested lock, F12, policies не переносяться. Реальний dump/restore, scheduler recovery і production deployment не підтверджено. |

Окремий audit ризику restricted external mode: він використовує owner credentials і не має тих самих гарантій, що managed runtime role; це не слід показувати як рівнозначну ізоляцію. Не змінював зовнішні бази.

## 5. Яка модель даних потрібна магазину

У каталозі вже є потрібна основа: `categories`, `products`, `product_variants`, `carts`, `cart_items`, `orders`, `order_items`, `addresses`. Створювати паралельну саморобну auth_users таблицю не потрібно: кінцеві користувачі належать Project Auth `_npati_auth_*`, окремо від користувачів NPATI.

| Об'єкти | Обов'язкова поведінка |
|---|---|
| Каталог | Public SELECT; створення/оновлення/видалення тільки уповноваженим виконавцем. Реальні FK для category_id/product_id/variant_id. |
| Кошик/адреси | Authenticated owner access, owner_id береться з перевіреного user identity. Чужий owner_id відхиляється. |
| Замовлення/позиції | Owner visibility; валідація quantities/prices, серверний підрахунок підсумку, атомарне створення order + items. Клієнт не повинен довільно підміняти ціну/статус. |
| Contact/newsletter/інша форма | Власна collection або явно заданий mapping до існуючої. Валідація, обмежені права на submit, зрозумілий success/error, запис видно власнику. |
| Додаткове поле через чат | Resolve active Project → inspect schema → add_field → dry-run/approval за ризиком → migration → update types/context/form → перевірка запису. |
| Auth | Реєстрація/вхід/вихід, getUser, sessions, помилки; додаткові profile fields через дозволені metadata або profile collection. Паролі не через data CRUD. |

Не кожна форма потребує нової таблиці: login використовує Auth, checkout — orders/order_items, редагування профілю — profile. Але кожна форма повинна мати явний серверний контракт. Схема, frontend і SDK мають створюватися узгоджено.

## 6. Пріоритетний порядок виправлень

1. Виправити public policies ecommerce, атомарний template apply та relation field mapping. Це основа безпечної schema, а не косметична правка чату.
2. Визначити backend ownership/reuse і зробити обов'язковий data provisioning явним, з відображенням помилок та відновленням після збою.
3. Додати одну bootstrap orchestration dependency перед frontend: domain schema → policies → Auth → SDK/config → frontend. Використати існуючі services/migration engine/Company Runs, не новий execution engine.
4. Розширити intent regression набором реальних українських формулювань; обирати data-capable виконавця для schema requests і не втрачати mobile type.
5. Реалізувати функціональні Auth pages і form bindings. Підготовити Next browser public config, preview CORS та Project API readiness до генерації.
6. Усунути Promote double-lock; синхронізувати policy metadata/RLS у prod. Узгодити GDPR і email delivery.
7. Додати реальний integration acceptance test із runner + Core PostgreSQL + projects PostgreSQL + браузером. AI не повинен просто відповідати «готово»: перевірка має читати реальні файли, build result і дані.

Застосування повного шаблону зараз вимагає окремого approval, `agent-data-service.ts:383`, як передбачає D3. Ваше очікування «одразу після одного запиту» треба реалізувати як узгоджену політику bootstrap дозволених нових dev-об'єктів або видимий approval етап у цьому ж процесі. Не обходити існуюче approval довільним `approved: true` для всіх schema/security операцій.

## 7. Перевірки цього аудиту

| Перевірка | Результат |
|---|---|
| 31 вибраний test file Website Builder/Data Studio | 320 tests: **318 passed, 1 failed, 1 skipped**. JSON reporter рахує також вкладені describe suites; це не кількість файлів. |
| Повторний ізольований D5 completion test file | **8 passed, 1 failed** — підтверджено стабільний результат. |
| `npm run typecheck` | Пройшов усі workspaces. |
| `npm run lint` | Пройшов lint guard та web XSS scan. |
| `npm run audit:capabilities` | Пройшов 4/4 перевірки catalog/registry/manifest/Inspector; 385 static capabilities. Це перевірка узгодженості реєстру, не виконання всіх бізнес-сценаріїв. |
| `npm run build --workspace @npati/agent-api` | Пройшов. |
| `npm run build --workspace @npati/web` | Пройшов; наявні warnings про browser externalization node:crypto та великий bundle. |
| Real PostgreSQL integration | Пропущено: немає тестового Core URL/admin password. |
| Generated Next.js install/build/Live Preview у Docker | Не виконано: daemon недоступний. Збірка NPATI web вище не є build згенерованого Next.js сайту. |
| Deterministic diagnostics | Exact prompt routing, альтернативні формулювання, public RLS SQL, scaffold без Auth/fake form, relation SQL, non-reversible create, реальний Promote/engine nested lock відтворено. |

Невдалий тест: `tests/data-studio-d5-completion.test.ts:126`. Очікує env лише з двома PROJECT_* variables, тоді як система додає 14 Git hardening variables. Це застаріле exact `toEqual`, а не доказ витоку DB password або причина відмови Next build. Правильна майбутня перевірка має контролювати необхідні public variables і відсутність заборонених secrets, з урахуванням дозволених Git variables.

Результати: `artifacts/website-data-audit-tests.json`, `artifacts/website-data-audit-repro.mts`, `artifacts/website-data-audit-repro-output.txt`. Повторити diagnostics: `node --import tsx artifacts/website-data-audit-repro.mts`.

**Тест chat-e2e зараз не доводить запуск сайту:** `tests/website-builder-chat-e2e.test.ts:75` очікує `lastBuildStatus=failed`, відсутній previewUrl, використовує fake AI без генерації коду та не підключає реальну БД/runner. Він перевіряє маршрутизацію, card і follow-up context.

## 8. Як приймати готовий результат після виправлень

1. Запустити Core DB, projects PostgreSQL і sandbox runner з готовими images, перевірити health; налаштувати PROJECT_API_PUBLIC_URL, CORS, стабільний preview secret. Значення секретів не виводити в чат чи diagnostics.
2. У Company надіслати точний запит із початку звіту. Перевірити Project.framework=Next.js, files/package.json, attached ready backend і готову domain schema. Повторення з idempotency key не повинне створити дублікати.
3. Перевірити фактичний install/build exit code 0, доступний Next HTTP response і відображення сторінки в Live Preview. Build failure не має позначатися успіхом лише через preview URL.
4. Зареєструвати двох відвідувачів A/B, виконати login/logout; додати товар у кошик і створити замовлення. Перевірити рядки у Data Studio і заборону A бачити/змінювати B.
5. Publishable key не дозволяє змінювати каталог. Перевірити server validation checkout та заборону підміни total_amount/owner_id.
6. Надіслати contact форму: рядок має з'явитися у відповідній collection. Додати через чат поле до цієї collection, переглянути diff і migration, повторити submit з новим полем.
7. Навмисно зламати template operation: повинен бути повний rollback без залишків. Повторний запуск bootstrap має відновлюватись без дублювання.
8. Promote з approval застосовує схему і policies без MIGRATION_BUSY; prod має окремі keys/users/environment. Backup/restore перевірити з реальними rows. Mobile + Live Preview має створити mobile_app і використати той самий явно обраний backend.

Для встановлення причини збою на вашому сервері потрібні **вже існуючі** Run trace й terminal events відповідного запиту, статус Project/DataBackend/environment і warning auto-attach. Конфігурація локального Codex `config.toml` не визначає runtime Website Builder цього застосунку; її не змінював.
