# Звіт Етапу 2: Виправлення Signup/Login через Data Studio та Live Preview

**Дата:** 17 жовтня 2026 року  
**Статус:** Виконано успішно (Зупинено перед Етапом 3 відповідно до інструкції)  
**Проєкт тестування:** `715009ee-a7bf-4999-bce2-053d207b7af5` ("сучасний інтернет-магазин")  
**Publishable Key:** `npati_pk_dev_b577740e361c0ce46ce9ca1d766137ed`  

---

## 1. Резюме реалізованих виправлень

В межах Етапу 2 було усунено корінні причини збоїв реєстрації та входу користувачів на створених сайтах у Data Studio та режимі Live Preview без створення паралельних систем авторизації, без послаблення безпеки і без відкриття небезпечних глобальних wildcard-дозволів.

| № | Напрямок | Root Cause | Реалізоване рішення | Статус |
|---|----------|------------|---------------------|--------|
| **1** | **CORS у Data Studio Gateway** | `gateway-service.ts` перевіряв лише `corsOriginsByProject[projectId]` (порожній за замовчуванням), тоді як API keys створювали top-level `corsAllowedOrigins`. Будь-який браузерний запит з `Origin: http://localhost:3000` блокувався з `403 CORS_FORBIDDEN`. | 1) Додано `resolveAllowedOrigins` з автоматичною синхронізацією між `corsOriginsByProject[projectId]` та fallback до валідованих `corsAllowedOrigins`.<br>2) Сувора валідація протоколів (`http:`, `https:`), заборона `*` (wildcards).<br>3) Автоматична реєстрація перевіреного `callerOrigin` при старті Preview. | **Виправлено та підтверджено** |
| **2** | **Ізоляція сесій Preview Proxy** | `handleProxy` у `project-preview-service.ts` повністю скидав заголовки `Cookie` та `Set-Cookie`, не дозволяючи сайтам у preview зберігати сесії. Одночасно існував ризик витоку сесійних cookie та токенів NPATI у sandbox. | 1) **Cookie Namespacing:** Вихідні `Set-Cookie` від сайту переписуються з префіксом `_npati_p_<project8>_`, атрибут `Path` звужується до шляху proxy, атрибут `Domain` вирізається, фіксується `SameSite=Lax`.<br>2) **Cookie Filtering:** Вхідні `Cookie` фільтруються: службові cookies NPATI (`npati_session` тощо) відсікаються, а сайту передаються тільки його власні cookies з видаленням префіксу.<br>3) **Token Protection:** Службові токени платформи (`previewToken`, `npati_live_*`) блокуються від пересилання в sandbox; токени кінцевих користувачів сайту пропускаються. | **Виправлено та підтверджено** |
| **3** | **Email Verification & Fail-Closed** | `data-backend-services.ts` створював `ProjectAuthService` без email-провайдера, тому активувався `UnconfiguredEmailProvider`, що призводило до помилки `EMAIL_SERVICE_UNCONFIGURED` при увімкненій верифікації. | Впроваджено ізольований `MockEmailProvider` для локальної розробки та тестування (із фіксацією листів, токенів та deep links), зберігаючи в production суворий `fail-closed` (`UnconfiguredEmailProvider`). Обов'язкова перевірка пошти не вимикається. | **Виправлено та підтверджено** |
| **4** | **Ізоляція даних користувачів** | Перевірка цілісності даних. | Користувацькі облікові дані та хеші паролів scrypt зберігаються виключно в базі даних проєкту `postgres-projects` (`db_b5533f4cde464426adf8f6631759ee9c_dev`). Core DB NPATI не містить таблиць `_npati_auth*` та не має відкритих SQL-доступів для сайту. | **Підтверджено** |
| **5** | **Блокер Sandbox Runner (P0)** | Мережева вразливість sandbox runner. | Зафіксовано як критичний security blocker. Не запускався недовірений код чи автономний браузер без ізоляції. | **Зафіксовано** |

---

## 2. Детальний опис виправлень та змінених файлів

### 2.1. Синхронізація CORS та захист від Wildcard
* **Файл:** `apps/agent-api/src/data-studio/gateway-service.ts`
  * Додано метод `resolveAllowedOrigins(providerConfig, projectId)`. Якщо для конкретного проєкту налаштовано origins, вони валідуються на точний URL (без зірочок). Якщо ні — здійснюється fallback до валідованих origins середовища.
  * У методі `isOriginAllowed` додано жорстку відмову для будь-яких origins із символом `*`.
* **Файл:** `apps/agent-api/src/data-studio/studio-service.ts`
  * Метод `updateCorsOrigins` оновлює синхронно `corsOriginsByProject[projectId]` та `corsAllowedOrigins`.
  * Додано метод `registerPreviewCorsOrigin(ctx, companyId, projectId, environment, origin)`, що безпечно реєструє перевірений preview origin при старті live preview.
* **Файл:** `apps/agent-api/src/project-preview-service.ts`
  * Додано функцію `parseExactHttpOrigin(raw)` для строгої верифікації протоколу (`http:`, `https:`), порту та відсутності wildcard.
  * У `startPreview` додано параметр `callerOrigin`, який валідується та безпечно реєструється через `onPreviewStart`.
* **Файл:** `apps/agent-api/src/project-preview-routes.ts`
  * У роуті `POST .../preview/start` зчитується `request.headers.origin` і передається в `startPreview`.
* **Файл:** `apps/agent-api/src/app.ts`
  * Підключено callback `onPreviewStart` до конструктора `ProjectPreviewService`, що викликає `dataStudioService.registerPreviewCorsOrigin`.

### 2.2. Preview Proxy: Ізоляція сесій та захист токенів
* **Файл:** `apps/agent-api/src/project-preview-service.ts`
  * **`rewriteSetCookieHeader(cookieStr, projectPrefix, proxyPath)`**:
    - Перейменовує cookie: `${projectPrefix}${name}` (наприклад `_npati_p_715009ee_session_id=...`).
    - Переписує `Path` на префікс preview proxy `/api/companies/.../preview/proxy`. Браузер надсилає ці cookie виключно у межах preview цього проєкту.
    - Видаляє атрибут `Domain` (запобігає поширенню cookie на інші субдомени).
    - Встановлює `SameSite=Lax` та зберігає прапорець `HttpOnly`.
  * **`filterIncomingCookies(rawCookieHeader, projectPrefix)`**:
    - Розбирає рядок cookie.
    - Відкидає всі cookies платформи NPATI (`npati_session`, `_npati_auth_token` тощо) та cookies інших проєктів.
    - Залишає лише cookies поточного проєкту та видаляє внутрішній префікс перед відправкою у dev-сервер sandbox.
  * **Захист токенів у `handleProxy`**:
    - Якщо заголовок `Authorization` містить previewToken або префікс платформи (`npati_`), він не надсилається у dev-сервер сайту.
    - Токени користувачів сайту (Ed25519 JWT сайту, `x-user-token`) коректно передаються далі.

### 2.3. Безпека Email Verification & Fail-Closed
* **Файл:** `apps/agent-api/src/data-backend-services.ts`
  * Конструктор `ProjectAuthService` отримує `emailProvider`:
    ```ts
    const emailProvider = process.env.NODE_ENV === "production"
      ? new UnconfiguredEmailProvider()
      : new MockEmailProvider();
    ```
  * У режимі тестування та dev-середовищі `MockEmailProvider` збирає листи верифікації та відновлення паролю в пам'яті (із фіксацією токена та deep link).
  * У production зберігається поведінка `fail-closed` (`UnconfiguredEmailProvider`), яка забороняє відправку без налаштованого SMTP/поштового сервісу.

---

## 3. Результати тестів та валідації

### 3.1. Модульні та регресійні тести (Vitest)
Було створено новий тестовий набір `tests/stage-2-auth-cors-preview.test.ts` та виконано прогін усіх пов'язаних наборів тестів:
```
✓ tests/preview-browser-bridge.test.ts (2 tests)
✓ tests/stage-2-auth-cors-preview.test.ts (9 tests)
✓ tests/data-studio-project-api-http.test.ts (14 tests)
✓ tests/project-preview.test.ts (27 tests)
✓ tests/data-studio-project-auth.test.ts (19 tests)

Test Files  5 passed (5)
Tests       71 passed (71)
```

### 3.2. Наскрізне тестування в живому середовищі (10 реальних HTTP-запитів)
Тестування проведено проти працюючого контейнера `agent-api-1` (`http://127.0.0.1:13001`):

1. **Preflight OPTIONS:**
   - Запит: `OPTIONS /v1/projects/:id/auth/signup` з `Origin: http://localhost:3000`
   - Результат: `HTTP 204 No Content`, `access-control-allow-origin: http://localhost:3000`, `access-control-allow-credentials: true` — **УСПІХ**.
2. **Signup:**
   - Запит: `POST /v1/projects/:id/auth/signup` з `Origin: http://localhost:3000` та `X-Project-Key`
   - Результат: `HTTP 201 Created`, зареєстровано `user_1792249032842@example.com` (ID `4f8dd6af-c962-4c6b-ad59-33b0611d9ff6`) — **УСПІХ**.
3. **Duplicate Email (Негативний тест):**
   - Запит: Повторна реєстрація того ж email
   - Результат: `HTTP 409 Conflict`, помилка `EMAIL_ALREADY_EXISTS` — **УСПІХ**.
4. **Login:**
   - Запит: `POST /v1/projects/:id/auth/login` з валідними даними
   - Результат: `HTTP 200 OK`, отримано Ed25519 JWT `token` та `refreshToken` — **УСПІХ**.
5. **Wrong Password (Негативний тест):**
   - Запит: `POST /v1/projects/:id/auth/login` з невірним паролем
   - Результат: `HTTP 401 Unauthorized`, помилка `INVALID_CREDENTIALS` — **УСПІХ**.
6. **Session Check (`/me`):**
   - Запит: `GET /v1/projects/:id/auth/me` з `Authorization: Bearer <token>`
   - Результат: `HTTP 200 OK`, підтверджено ID та email користувача — **УСПІХ**.
7. **Refresh Token (Ротація токенів):**
   - Запит: `POST /v1/projects/:id/auth/refresh` з `refreshToken`
   - Результат: `HTTP 200 OK`, видано новий `token` та новий `refreshToken` (ротація відбулася) — **УСПІХ**.
8. **Logout:**
   - Запит: `POST /v1/projects/:id/auth/logout` з новим токеном
   - Результат: `HTTP 200 OK`, `{ success: true }` — **УСПІХ**.
9. **Re-use of Revoked Token (Негативний тест):**
   - Запит: Спроба повторного refresh після logout
   - Результат: `HTTP 401 Unauthorized`, помилка `TOKEN_REVOKED` — **УСПІХ**.
10. **Cross-Origin Rejection (Тест безпеки):**
    - Запит: `POST /v1/projects/:id/auth/signup` з `Origin: https://attacker.evil.com`
    - Результат: `HTTP 403 Forbidden`, помилка `CORS_ORIGIN_NOT_ALLOWED` — **УСПІХ**.

### 3.3. Перевірка ізоляції PostgreSQL
- **Project PostgreSQL (`postgres-projects-1` / `db_b5533f4cde464426adf8f6631759ee9c_dev`):**
  - Таблиця `_npati_auth_users` містить облікові записи кінцевих користувачів сайту (хеші scrypt, статус, email).
- **Core PostgreSQL (`postgres-1` / `npati_agent`):**
  - Виконано перевірку: `\dt _npati_auth*` повернуло `Did not find any relation named "_npati_auth*"`.
  - У таблиці `users` платформи відсутні облікові записи користувачів сайту.
  - Прямого доступу з контейнера preview до Core DB немає.

---

## 4. Фіксація статусу P0 Sandbox Runner та вплив на Етап 3

> [!WARNING]
> **Критичний Security Blocker (P0):**  
> Контейнер `sandbox-runner-1` одночасно підключений до двох мереж Docker:
> 1. `npati-isolated-source-20261011_npati-backend` (`172.24.0.0/16`) — де знаходяться Core PostgreSQL (`172.24.0.8`), MinIO (`172.24.0.5`), Redis (`172.24.0.4`) та Agent API (`172.24.0.7`).
> 2. `npati-isolated-source-20261011_npati-sandbox` (`172.26.0.0/16`) — мережа ізольованих середовищ виконання проєктів.
>
> Згідно з правилами iptables runner'а, ізоляція трафіку поширюється лише на UID від 10000 до 60000. Процеси, запущені з іншими UID (або root всередині runner), мають пряму мережеву видимість чутливих внутрішніх сервісів Core NPATI.

**Вплив на Етап 3:**
1. **Runner:** Потрібне повне відключення `sandbox-runner` від мережі `npati-backend` або впровадження жорсткого L4/L7 bridge-проксі, через який дозволено виключно трафік між `agent-api` та `runner` по фіксованому порту `7865`.
2. **API:** Усі виклики між API та Runner залишаться без змін за протоколом RPC на порту 7865, але Runner більше не матиме маршрутизації до PostgreSQL / MinIO / Redis.
3. **Live Preview:** Проксі-сервіс `ProjectPreviewService.handleProxy` продовжує проксіювати запити через `sandbox.proxyPreview` по локальному Unix-сокету або виділеному каналу без потреби прямого доступу сайту до будь-якої мережі NPATI.

---

## 5. Зупинка

Всі вимоги Етапу 2 виконано в повному обсязі.  
Роботу зупинено. Перехід до Етапу 3 очікує вашого підтвердження.
