# Фінальний звіт верифікації Етапу 6 та готовності до Dark Launch

**Дата аудиту:** 17 жовтня 2026 р.  
**Контур тестування:** Реальна Docker-інфраструктура NPATI (`npati-isolated-source-20261011`), MinIO S3 (`npati-project-media`), PostgreSQL Core (`npati_agent`), PostgreSQL Projects (`postgres-projects:5432`), Agent API (`port 13001`), Sandbox Runner (`port 7865`), Playwright Chromium.  
**Регламент:** Production deployment не запускався, робочі бази не модифікувалися, платні CI workflows не викликалися.

---

## 1. Точкова перевірка 8 обов'язкових пунктів

### Пункт 1: Створення та редагування сайту реальною AI-моделлю
- **Статус:** **VERIFIED (для HTML/CSS/JS)** / **BLOCKED (для автономного Next.js)**
- **Конкретні докази:**
  - **Run ID:** `55090487-a8df-492c-a704-f79df7573e44`
  - **Session ID:** `45e990ae-c090-4168-969e-254723887922`
  - **Project ID:** `715009ee-a7bf-4999-bce2-053d207b7af5` (назва: «сучасний інтернет-магазин»)
  - **Статус Run:** `completed` (кількість кроків: 13 turns, 12 tool calls, 234,554 токенів, 6 змінених файлів).
  - **Текст вихідного запиту:** `User request: Створити сучасний інтернет-магазин на HTML / CSS / JavaScript`.
  - **Виклики інструментів:** `code.fs.write`, `code.fs.read` (створено `index.html`, `products.html`, `cart.html`, `checkout.html`, `script.js`, `style.css`).
  - **Обмеження:** Реальний запуск створив магазин на стеку **HTML/CSS/JS**. Автономна генерація проєкту саме на Next.js із проходженням `next build` моделлю не виконувалася через ізоляцію пісочниці.

---

### Пункт 2: Точний технологічний стек створеного сайту
- **Статус:** **VERIFIED (як HTML / CSS / JavaScript / Node.js runtime)** / **BLOCKED (як Next.js `next build`)**
- **Конкретні докази:**
  - Фактичний робочий проєкт у каталозі `/app/data/project-workspaces/.../715009ee-a7bf-4999-bce2-053d207b7af5` містить:
    `index.html`, `products.html`, `cart.html`, `checkout.html`, `script.js`, `style.css`, `website.config.json`, `npati-client.ts`.
  - У середовищі Sandbox pre-cached тулчейн для Next.js існує за адресою `/opt/npati-project-toolchain/next` (Next.js 14.2.14, React 18.3.1), проте в тестових прогонах Live Preview запускався через легковаговий Node.js HTTP runtime, а не через компіляцію `next build`.
  - **Висновок:** Стек класифікується як **Vanilla HTML/CSS/JS + Node.js HTTP runtime**. Зарахування його як Next.js суворо відхилено відповідно до інструкції.

---

### Пункт 3: Повторна перевірка мережевої ізоляції безпосередньо з процесу сайту
- **Статус:** **VERIFIED (100% мережева ізоляція підтверджена)**
- **Конкретні докази (прямі TCP-проби з процесу Sandbox):**
  - TCP `postgres:5432` -> **BLOCKED (TIMEOUT)**
  - TCP `postgres-projects:5432` -> **BLOCKED (ENOTFOUND)**
  - TCP `redis:6379` -> **BLOCKED (TIMEOUT)**
  - TCP `npati-isolated-source-20261011-minio-internal:9000` -> **BLOCKED (ENOTFOUND)**
  - TCP `minio:9000` -> **BLOCKED (TIMEOUT)**
  - Прямий IP до Core PostgreSQL (`172.24.0.8:5432`) -> **BLOCKED (ECONNREFUSED)**
  - Прямий IP до MinIO (`172.24.0.4:9000`) -> **BLOCKED (ECONNREFUSED)**
- **Висновок:** Відсутність доступу обумовлена не відсутністю таблиць, а фізичною неможливістю встановити TCP з'єднання на мережевому рівні контейнера та простору імен Bubblewrap (`--unshare-net`).

---

### Пункт 4: Безпека Hard Purge
- **Статус:** **VERIFIED**
- **Конкретні докази:**
  - **Окремі права:** Маршрут `/hard-purge` вимагає роль `owner` або `admin`. Спроба користувача з роллю `developer` викликати `{ force: true }` повернула **HTTP 403 `force_purge_not_permitted`**.
  - **Явне підтвердження:** Тіло запиту зобов'язане містити `confirm: true` (інакше HTTP 400 `confirmation_required`).
  - **CSRF Protection:** Захист забезпечено токенами `ScopedRemoteAccessToken` (`rat_...`) з підписом HMAC-SHA256, прив'язкою до `companyId` та `userId`.
  - **Retention Guard:** Проєкти зі статусом `soft_deleted` зберігаються 30 днів (`purge_after`), несанкціоноване примусове видалення неможливе.
  - **Аудит:** Усі спроби (успішні та відхилені) фіксуються в таблиці `audit_log` у криптографічному хеш-ланцюгу.

---

### Пункт 5: Production Auth-конфігурація та Email Verification
- **Статус:** **BLOCKED (Release Blocker для публічного релізу)**
- **Конкретні докази:**
  - У коді `apps/agent-api/src/data-backend-services.ts` (рядки 81–83) реалізовано:
    ```typescript
    const emailProvider = process.env.NODE_ENV === "production"
      ? new UnconfiguredEmailProvider()
      : new MockEmailProvider();
    ```
  - У продакшн-режимі підключається `UnconfiguredEmailProvider`, який при спробі надіслати лист викидає помилку **HTTP 503 `EMAIL_SERVICE_UNCONFIGURED`**.
  - Email verification **не вимкнено** (система відмовляється реєструвати неперевірених користувачів без відправки листа).
  - Справжній поштовий провайдер (SMTP / SendGrid / Resend) для Project Auth наразі не налаштований.
  - **Висновок:** Це є офіційним **Release Blocker** для публічного релізу інтернет-магазинів із обов'язковою верифікацією email.

---

### Пункт 6: Очищення disposable-ресурсів та цілісність робочої бази
- **Статус:** **VERIFIED**
- **Конкретні докази:**
  - Виконано скрипт очищення `scratch/cleanup-disposable-resources.cjs`:
    - Видалено 12 одноразових проєктів із Core DB.
    - Видалено 7 одноразових DataBackend із Core DB.
    - Знищено 14 одноразових баз даних із `postgres-projects:5432` (`db_dispdbs6...`, `db_020c5...`, `db_13d37...`).
    - Видалено 18 одноразових об'єктів SVG із MinIO бакета `npati-project-media`.
  - **Цілісність робочого магазину:**
    - Проєкт `715009ee-a7bf-4999-bce2-053d207b7af5` (`сучасний інтернет-магазин`) має статус `previewing`, `revision: 6`.
    - Бази `db_b5533f4cde464426adf8f6631759ee9c_dev` та `db_b5533f4cde464426adf8f6631759ee9c_prod` повністю збережені та не зазнали змін.
    - Тестові користувачі (`olena@test.ai`) та тестові замовлення в робочу базу не потрапили.

---

### Пункт 7: Підсумкові регресійні тести та перевірка журналів
- **Статус:** **VERIFIED**
- **Конкретні докази:**
  - `tests/stage-5-delete-lifecycle.test.ts` — **15/15 passed**.
  - `tests/stage-4-project-media.test.ts` — **10/10 passed**.
  - `tests/stage-2-auth-cors-preview.test.ts` — **9/9 passed**.
  - `tests/preview-browser-bridge.test.ts` — **2/2 passed**.
  - `tests/run-trace-and-observability.test.ts` — **7/7 passed**.
  - Загальний результат: **43 тести пройдено (0 помилок, 0 збоїв)**.
  - Компіляція TypeScript: `npx tsc --noEmit` для `packages/workspace` та `apps/agent-api` завершилася з кодом 0 (0 помилок типізації).
  - В Activity & Run Trace відсутні нові критичні помилки; попередження reaper про заблоковані порти відповідають відсутності фонових завдань.

---

### Пункт 8: Оновлення звіту та фінальний вердикт
- **Статус:** **VERIFIED**
- Документ оновлено, дані синхронізовано з реальними логами системи.

---

## 2. Підсумкова матриця верифікації

| № | Вимога перевірки | Статус | Коментар |
| :-: | :--- | :---: | :--- |
| 1 | Створення сайту реальною AI-моделлю | **VERIFIED** | Run ID `55090487`, 13 кроків, 12 tool calls, HTML/CSS/JS. |
| 2 | Справжній стек Next.js (`next build`) | **BLOCKED** | Створено і запущено Vanilla HTML/CSS/JS + Node.js runtime. Не зараховано як Next.js. |
| 3 | Фізична мережева TCP-ізоляція | **VERIFIED** | Повний TCP-блок до Postgres, Redis, MinIO (Timeout/Econnrefused). |
| 4 | Безпека Hard Purge та retention | **VERIFIED** | 403 при `{ force: true }` для non-owner, явний confirm, CSRF, AuditLog. |
| 5 | Production Auth без MockEmailProvider | **BLOCKED** | `UnconfiguredEmailProvider` повертає 503. Release blocker для публічного email auth. |
| 6 | Очищення disposable-ресурсів | **VERIFIED** | 14 тестових DB, 12 проєктів та 18 MinIO файлів видалено. Робочий магазин недоторканий. |
| 7 | Регресія та чистота трейсів | **VERIFIED** | 43/43 тестів зелені, 0 помилок tsc, трейси стабільні. |
| 8 | Оновлення документації | **VERIFIED** | Звіт зафіксовано в `docs/integration/stage-6-final-report.md`. |

---

## 3. Фінальний вердикт

1. **Чи готова система до контрольованого Dark Launch?**
   - **ТАК, ГОТОВА (з обмеженнями).**
   - Для внутрішнього використання, тестування розробниками та контрольованого dark launch за участі довірених клієнтів (де використовується сесійний вхід без перевірки зовнішньої пошти) система повністю стабільна, безпечна та ізольована.

2. **Які вимоги залишаються заблокованими перед публічним релізом?**
   - **Блокер 1 (Email Provider):** Відсутність реального SMTP/API транспорту для `ProjectAuthService` у продакшн-конфігурації (`UnconfiguredEmailProvider` видає 503 при спробі реєстрації з верифікацією пошти).
   - **Блокер 2 (Next.js Compilation):** Підтримка повноцінного `next build` всередині суворо ізольованого контейнера Sandbox без виходу в інтернет (потрібна адаптація кешованого Next.js-середовища або запуск через Vite/Static HTML).

3. **Що необхідно зробити перед повноцінним публічним релізом (Public GA):**
   - Налаштувати реальні облікові дані SMTP / транзакційного сервісу (наприклад, Resend або SendGrid) у конфігурації `emailProvider`.
   - Для проєктів, які заявляються як Next.js, реалізувати попередній підігрів залежностей через `/opt/npati-project-toolchain/next` із виконанням валідаційного `next build` під час старту.
   - Залишити ввімкненим поточний механізм суворої ізоляції мережі та захисту від примусового видалення.
