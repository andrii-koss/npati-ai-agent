# PLAN integration additions — 2026-10-18

The previous 2884 source clauses are unchanged. Commit integration-6 appended REQ-INT-01–10, producing **76 additional source clauses**, for **2960 total** with the unchanged extraction rule. No duplicate IDs or source anchors. Repeated cross references are contextual source occurrences, not unique additional product capabilities. New behavior remains Unassessed until its individual source-order review.

| ID | PLAN line | Section | Clause |
| --- | ---: | --- | --- |
| GLOBAL.L1124.01 | 1124 | Доповнення: Специфікація інтеграції Website Builder, Data Studio та MinIO (2026-10-18) | Усі нові вимоги додано як окремі нормативні доповнення з унікальними ідентифікаторами |
| GLOBAL.L1124.02 | 1124 | Доповнення: Специфікація інтеграції Website Builder, Data Studio та MinIO (2026-10-18) | перехресними посиланнями на план Data Studio (`docs/data-studio/PLAN.md` -> `REQ-DS-*`): |
| GLOBAL.L1127.01 | 1127 | [REQ-INT-01] Доступ до файлів проєкту через Sandbox Provider | Доступ агента до файлів коду сайтів здійснюється виключно через `ProjectWorkspace` |
| GLOBAL.L1127.02 | 1127 | [REQ-INT-01] Доступ до файлів проєкту через Sandbox Provider | `ProjectSandboxService` (`apps/agent-api/src/project-workspace.ts`, `apps/agent-api/src/shared-project-runtime-provider.ts`). |
| GLOBAL.L1128.01 | 1128 | [REQ-INT-01] Доступ до файлів проєкту через Sandbox Provider | Шляхи монтування обмежені директорією `/projects/:projectId` всередині `sandbox-runner-1`. |
| GLOBAL.L1129.01 | 1129 | [REQ-INT-01] Доступ до файлів проєкту через Sandbox Provider | Права доступу на диску: `0700` (`drwx------`) з окремим UID/GID на проект |
| GLOBAL.L1129.02 | 1129 | [REQ-INT-01] Доступ до файлів проєкту через Sandbox Provider | Прямий доступ агента до хостової файлової системи за межами робочої директорії суворо заблоковано. |
| GLOBAL.L1130.01 | 1130 | [REQ-INT-01] Доступ до файлів проєкту через Sandbox Provider | Зв'язок: [REQ-DS-01]. |
| GLOBAL.L1133.01 | 1133 | [REQ-INT-02] Керування медіафайлами через MinIO | Усі статичні |
| GLOBAL.L1133.02 | 1133 | [REQ-INT-02] Керування медіафайлами через MinIO | завантажені медіафайли зберігаються в об'єктному сховищі MinIO у бакеті `npati-project-media` (`apps/agent-api/src/project-media-service.ts`). |
| GLOBAL.L1134.01 | 1134 | [REQ-INT-02] Керування медіафайлами через MinIO | Префікс ключів: `websites/${companyId}/${projectId}/*`. |
| GLOBAL.L1135.01 | 1135 | [REQ-INT-02] Керування медіафайлами через MinIO | Забезпечено абсолютну бінарну точність без Latin-1/UTF-8 спотворення: передача сирого `Buffer` між MinIO |
| GLOBAL.L1135.02 | 1135 | [REQ-INT-02] Керування медіафайлами через MinIO | Workspace mirror |
| GLOBAL.L1135.03 | 1135 | [REQ-INT-02] Керування медіафайлами через MinIO | HTTP стрімом (SHA-256 ідентичність). |
| GLOBAL.L1136.01 | 1136 | [REQ-INT-02] Керування медіафайлами через MinIO | Безпека SVG: обов'язкова санітизація шкідливих скриптів/зовнішніх сутностей |
| GLOBAL.L1136.02 | 1136 | [REQ-INT-02] Керування медіафайлами через MinIO | віддача із заголовком `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`. |
| GLOBAL.L1137.01 | 1137 | [REQ-INT-02] Керування медіафайлами через MinIO | Зв'язок: [REQ-DS-02]. |
| GLOBAL.L1140.01 | 1140 | [REQ-INT-03] Ізольований Project Data Studio | Дані сайтів зберігаються в окремому контейнері `postgres-projects:5432` |
| GLOBAL.L1140.02 | 1140 | [REQ-INT-03] Ізольований Project Data Studio | повністю відокремленому від ядра системи. |
| GLOBAL.L1141.01 | 1141 | [REQ-INT-03] Ізольований Project Data Studio | Для кожного DataBackend автоматично створюються ізольовані бази: `db_<backendId>_dev` |
| GLOBAL.L1141.02 | 1141 | [REQ-INT-03] Ізольований Project Data Studio | `db_<backendId>_prod`. |
| GLOBAL.L1142.01 | 1142 | [REQ-INT-03] Ізольований Project Data Studio | Зв'язок: [REQ-DS-03]. |
| GLOBAL.L1145.01 | 1145 | [REQ-INT-04] Заборона прямого доступу до NPATI Core PostgreSQL | Контейнер `sandbox-runner-1` |
| GLOBAL.L1145.02 | 1145 | [REQ-INT-04] Заборона прямого доступу до NPATI Core PostgreSQL | процеси згенерованих сайтів не мають мережевого маршруту (Zero Route, `nc -zv` ECONNREFUSED/timeout) до основної бази `postgres:5432` (`npati_agent`). |
| GLOBAL.L1146.01 | 1146 | [REQ-INT-04] Заборона прямого доступу до NPATI Core PostgreSQL | Сервісні ролі сайтів у `postgres-projects` не мають прав |
| GLOBAL.L1146.02 | 1146 | [REQ-INT-04] Заборона прямого доступу до NPATI Core PostgreSQL | видимості бази ядра `npati_agent`. |
| GLOBAL.L1147.01 | 1147 | [REQ-INT-04] Заборона прямого доступу до NPATI Core PostgreSQL | Агент позбавлений можливості виконання довільного сирого SQL — усі операції виконуються через структуровані DDL/DML контракти. |
| GLOBAL.L1148.01 | 1148 | [REQ-INT-04] Заборона прямого доступу до NPATI Core PostgreSQL | Зв'язок: [REQ-DS-04]. |
| GLOBAL.L1151.01 | 1151 | [REQ-INT-05] Project-Scoped Permissions та захист Preview | Live Preview захищено криптографічно підписаним токеном (`/preview/proxy/?token=...`). |
| GLOBAL.L1152.01 | 1152 | [REQ-INT-05] Project-Scoped Permissions та захист Preview | Токен проєкту A |
| GLOBAL.L1152.02 | 1152 | [REQ-INT-05] Project-Scoped Permissions та захист Preview | застосований до проєкту B |
| GLOBAL.L1152.03 | 1152 | [REQ-INT-05] Project-Scoped Permissions та захист Preview | суворо відхиляється з кодом `HTTP 403 token_scope_denied` незалежно від валідності підпису. |
| GLOBAL.L1153.01 | 1153 | [REQ-INT-05] Project-Scoped Permissions та захист Preview | Ендпоінти Project API Gateway вимагають валідний `X-Project-Key` (PUBLISHABLE або SECRET) |
| GLOBAL.L1153.02 | 1153 | [REQ-INT-05] Project-Scoped Permissions та захист Preview | Запити без ключа відхиляються з `HTTP 401 MISSING_API_KEY`. |
| GLOBAL.L1154.01 | 1154 | [REQ-INT-05] Project-Scoped Permissions та захист Preview | Зв'язок: [REQ-DS-05]. |
| GLOBAL.L1157.01 | 1157 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | Soft Delete виконує зупинку процесів (`stopSandbox`) |
| GLOBAL.L1157.02 | 1157 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | відкликання CORS |
| GLOBAL.L1157.03 | 1157 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | блокування Preview/API з `HTTP 404/409` |
| GLOBAL.L1157.04 | 1157 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | зберігаючи вихідний код |
| GLOBAL.L1157.05 | 1157 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | медіа |
| GLOBAL.L1157.06 | 1157 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | БД на 30 днів. |
| GLOBAL.L1158.01 | 1158 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | Ендпоінт `GET /delete-plan` надає повний dry-run звіт без жодних мутацій. |
| GLOBAL.L1159.01 | 1159 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | Restoring повертає проєкт у робочий стан `ready` із відновленням усіх точок доступу. |
| GLOBAL.L1160.01 | 1160 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | Hard Purge очищає виключно виділені ресурси проєкту (каталог `/projects/:projectId` та префікс MinIO) |
| GLOBAL.L1160.02 | 1160 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | гарантуючи збереження спільних баз даних DataBackend. |
| GLOBAL.L1161.01 | 1161 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | Примусове видалення (`force: true`) дозволено виключно ролям `owner` |
| GLOBAL.L1161.02 | 1161 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | `admin` |
| GLOBAL.L1161.03 | 1161 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | Спроби відхиляються з `HTTP 403 force_purge_not_permitted` |
| GLOBAL.L1161.04 | 1161 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | аудитом. |
| GLOBAL.L1162.01 | 1162 | [REQ-INT-06] Життєвий цикл (Lifecycle) та Cleanup | Зв'язок: [REQ-DS-06]. |
| GLOBAL.L1165.01 | 1165 | [REQ-INT-07] Auth кінцевих користувачів створених сайтів (Project Auth) | Клієнти сайту (покупці) реєструються через вбудований Project Auth (`/api/auth/register`, `/api/auth/login`). |
| GLOBAL.L1166.01 | 1166 | [REQ-INT-07] Auth кінцевих користувачів створених сайтів (Project Auth) | Дані зберігаються виключно в таблиці `_npati_auth_users` проєктної бази даних із хешуванням паролів (Argon2id/Bcrypt). |
| GLOBAL.L1167.01 | 1167 | [REQ-INT-07] Auth кінцевих користувачів створених сайтів (Project Auth) | Облікові записи покупців сайтів ніколи не змішуються з користувачами платформи NPATI. |
| GLOBAL.L1168.01 | 1168 | [REQ-INT-07] Auth кінцевих користувачів створених сайтів (Project Auth) | Зв'язок: [REQ-DS-07]. |
| GLOBAL.L1171.01 | 1171 | [REQ-INT-08] Прив'язка бази даних до проєкту (DataBackend Association) | Проєкти прив'язуються до БД через сутність `DataBackend` (`data_backend_id`). |
| GLOBAL.L1172.01 | 1172 | [REQ-INT-08] Прив'язка бази даних до проєкту (DataBackend Association) | Один DataBackend може одночасно обслуговувати Web-сайт |
| GLOBAL.L1172.02 | 1172 | [REQ-INT-08] Прив'язка бази даних до проєкту (DataBackend Association) | Мобільний додаток. |
| GLOBAL.L1173.01 | 1173 | [REQ-INT-08] Прив'язка бази даних до проєкту (DataBackend Association) | Видалення окремого сайту відв'язує його CORS |
| GLOBAL.L1173.02 | 1173 | [REQ-INT-08] Прив'язка бази даних до проєкту (DataBackend Association) | артефакти |
| GLOBAL.L1173.03 | 1173 | [REQ-INT-08] Прив'язка бази даних до проєкту (DataBackend Association) | але не знищує спільний DataBackend. |
| GLOBAL.L1174.01 | 1174 | [REQ-INT-08] Прив'язка бази даних до проєкту (DataBackend Association) | Зв'язок: [REQ-DS-03] |
| GLOBAL.L1174.02 | 1174 | [REQ-INT-08] Прив'язка бази даних до проєкту (DataBackend Association) | [REQ-DS-06]. |
| GLOBAL.L1177.01 | 1177 | [REQ-INT-09] Контракти доступу до таблиць та схема | Усі DDL мутації схемы виконуються через версійні міграції NPATI Data Studio. |
| GLOBAL.L1178.01 | 1178 | [REQ-INT-09] Контракти доступу до таблиць та схема | Заборонено неавторизовані DDL виклики (відвідувачі сайту отримують `HTTP 401/403 BUSINESS_ACCESS_DENIED`). |
| GLOBAL.L1179.01 | 1179 | [REQ-INT-09] Контракти доступу до таблиць та схема | Таблиці захищаються Row-Level Security (RLS) з обов'язковими політиками `USING` |
| GLOBAL.L1179.02 | 1179 | [REQ-INT-09] Контракти доступу до таблиць та схема | `WITH CHECK`. |
| GLOBAL.L1180.01 | 1180 | [REQ-INT-09] Контракти доступу до таблиць та схема | Зв'язок: [REQ-DS-05]. |
| GLOBAL.L1183.01 | 1183 | [REQ-INT-10] Acceptance Criteria & Playwright Verification | Сценарій B: сайт успішно взаємодіє з ізольованими таблицями Data Studio (`products`, `orders`, `_npati_auth_users`). |
| GLOBAL.L1184.01 | 1184 | [REQ-INT-10] Acceptance Criteria & Playwright Verification | Сценарій D: автономний агент через чат генерує сайт |
| GLOBAL.L1184.02 | 1184 | [REQ-INT-10] Acceptance Criteria & Playwright Verification | налаштовує БД |
| GLOBAL.L1184.03 | 1184 | [REQ-INT-10] Acceptance Criteria & Playwright Verification | збирає проєкт |
| GLOBAL.L1184.04 | 1184 | [REQ-INT-10] Acceptance Criteria & Playwright Verification | проводить успішну реєстрацію |
| GLOBAL.L1184.05 | 1184 | [REQ-INT-10] Acceptance Criteria & Playwright Verification | замовлення через Playwright у Live Preview |
| GLOBAL.L1184.06 | 1184 | [REQ-INT-10] Acceptance Criteria & Playwright Verification | друге повідомлення оновлює сайт без втрати існуючих даних. |
| GLOBAL.L1185.01 | 1185 | [REQ-INT-10] Acceptance Criteria & Playwright Verification | Усі 10/10 контрольних перевірок автоматизованого тесту `scratch/run-stage-6-consolidated-suite.cjs` мають статус PASS. |
| GLOBAL.L1186.01 | 1186 | [REQ-INT-10] Acceptance Criteria & Playwright Verification | Зв'язок: [REQ-DS-01] - [REQ-DS-07]. |
