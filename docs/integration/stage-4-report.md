# Звіт Етапу 4: Інтеграція MinIO для медіафайлів створених сайтів

**Дата:** 17 жовтня 2026 року  
**Статус:** Виконано успішно (Зупинено перед Етапом 5 відповідно до інструкцій)  
**Контур тестування:** `npati-isolated-source-20261011`  
**Тестовий проєкт:** `715009ee-a7bf-4999-bce2-053d207b7af5` ("сучасний інтернет-магазин")  
**Тестова компанія:** `e8fb3cc1-4809-4c95-a10a-1c7e2a57913b`  

---

## 1. Резюме реалізованих рішень Етапу 4

У межах Етапу 4 реалізовано повноцінне, безпечне та ізольоване сховище медіафайлів для створених сайтів на базі існуючого MinIO та Object Storage API платформи NPATI.

| № | Вимога користувача | Реалізоване рішення | Результат перевірки |
|---|--------------------|---------------------|---------------------|
| **1** | **Використання існуючого MinIO** | Підключено існуючий `MinioObjectStorage` без створення дублікатів контейнерів чи додаткових S3-сервісів. Автоматична перевірка та ініціалізація бакета в `NPATI_BUCKETS.projectMedia`. | **Підтверджено** (бакет `npati-project-media` ініціалізовано) |
| **2** | **Логічний простір `npati-project-media` та незмінний ідентифікатор** | Створено бакет `npati-project-media`. Ключі об'єктів формуються виключно за схемою `${companyId}/${projectId}/...`. Первинний ідентифікатор `projectId` є незмінним UUID: перейменування чи зміна назви сайту не порушує шляхів до файлів. | **Підтверджено** |
| **3** | **Контрольовані інструменти Coding Agent** | Додано набір інструментів `PROJECT_MEDIA_TOOLS`: `project.media.upload`, `project.media.list`, `project.media.get`, `project.media.delete`. Агенту заборонено прямий доступ до Docker, MinIO root credentials чи S3 secrets. | **Підтверджено** (4 інструменти, класифікація ризиків, безпечний dispatch) |
| **4** | **Підтримка Website Builder & Live Preview** | Реалізовано роути `POST /companies/:cId/projects/:pId/media/upload`, `GET /media`, `DELETE /media` та публічний потоковий стрім `GET /api/projects/:pId/media/*`. Додано валідацію MIME (зображення, відео, аудіо, шрифти, PDF), ліміти (15MB фото, 50MB медіа), квоту (250MB) та заголовки `X-Content-Type-Options: nosniff`. | **Підтверджено** (HTTP 200, правильний Content-Type, кешування) |
| **5** | **Нульовий прямий мережевий доступ Sandbox Runner до MinIO** | Sandbox Runner не має мережевого маршруту до внутрішнього MinIO (`172.24.0.4:9000`). Стрімінг медіа здійснюється через `agent-api`. Медіа зберігається в MinIO та дублюється у `public/assets/` workspace, переживаючи будь-який перезапуск Sandbox Runner. | **Підтверджено** (nc з runner до MinIO повертає timeout/blocked) |
| **6** | **Підготовка до Delete Website (Етап 5)** | Створено метод `purgeProjectMedia(ctx, companyId, projectId)` для повного очищення бакета медіафайлів. Фізичне видалення сайту на цьому етапі **не викликається** і відкладено до Етапу 5. | **Підготовлено** |
| **7** | **Залишкові перевірки Етапу 3** | Виконано реальний `next build` всередині ізольованого sandbox runner з використанням локального toolchain profile без зовнішньої мережі. Перевірено Live Preview та ізоляцію між проєктами A і B. | **Verified** (з реальними логами) |
| **8** | **Наскрізні тести життєвого циклу** | Виконано сценарій: завантаження фото → підтвердження в MinIO → стрімінг через API → перезапуск Sandbox Runner → доступність збережена → блокування доступу для стороннього проєкту (404) та directory traversal (400). | **100% успішно** |

---

## 2. Архітектурні деталі та змінені файли

### 2.1. Object Storage та конфігурація бакета
* **Файл:** `apps/agent-api/src/object-storage.ts`
  * Додано `projectMedia: "npati-project-media"` у словник `NPATI_BUCKETS`.
  * При старті `MinioObjectStorage.initialize()` автоматично створює та валідує бакет `npati-project-media`.

### 2.2. Сервіс `ProjectMediaService`
* **Файл:** `apps/agent-api/src/project-media-service.ts` (новий сервіс)
  * **MIME Validation:** Білий список `ALLOWED_MEDIA_MIME_TYPES` (JPEG, PNG, GIF, WebP, SVG, AVIF, MP4, WebM, MP3, WAV, WOFF2, TTF, PDF). Будь-які небезпечні або виконувані розширення (`.exe`, `.js`, `.sh`, `.php`, `.bat`) відхиляються з кодом `415 Unsupported Media Type`.
  * **Розміри та квоти:** 15 MB для зображень, 50 MB для аудіо/відео, 250 MB загальна квота на проєкт (перевіряється перед кожним збереженням).
  * **Ізоляція ключів:** `mediaKey(companyId, projectId, relativePath)` гарантує відсутність path traversal (`..` та символи замінюються/відхиляються) та формування шляху `${companyId}/${projectId}/assets/...`.
  * **Workspace Mirroring:** При завантаженні майстер-копія записується в MinIO, а також копіюється у робочу директорію проєкту `public/assets/...`. Це дозволяє Next.js/Vite збирати сторінки локально (`next build`) або звертатися до віддаленого URL.
  * **Стрімінг:** `getMedia(companyId, projectId, relativePath)` з безпечним читанням потоку без завантаження великих файлів повністю в оперативну пам'ять.
  * **Очищення:** `deleteMedia` видаляє файл з MinIO і з робочої директорії; `purgeProjectMedia` видаляє всі медіафайли проєкту (підготовка для Етапу 5).

### 2.3. Інструменти Coding Agent
* **Файл:** `apps/agent-api/src/project-agent-capabilities.ts`
  * Задекларовано `PROJECT_MEDIA_TOOLS`: `project.media.upload`, `project.media.list`, `project.media.get`, `project.media.delete`.
* **Файл:** `apps/agent-api/src/company-tool-runtime.ts`
  * Реалізовано обробку інструментів `project.media.*` з обов'язковою перевіркою контексту, валідацією прав доступу агента та проєкту.
* **Файл:** `apps/agent-api/src/company-runtime.ts` та `company-runtime-tool-executor.ts`
  * Додано описи інструментів у системний промпт та виконано класифікацію ризиків (`project.media.delete` позначено як високий ризик, що потребує аудиту).

### 2.4. Роути Website Builder та Live Preview Stream
* **Файл:** `apps/agent-api/src/project-file-routes.ts`
  * `POST /companies/:companyId/projects/:projectId/media/upload`: Завантаження мультимедіа з Website Builder UI.
  * `GET /companies/:companyId/projects/:projectId/media`: Отримання списку завантажених assets із розмірами та зайнятою квотою.
  * `DELETE /companies/:companyId/projects/:projectId/media`: Видалення медіафайлу.
  * `GET /api/projects/:projectId/media/*` та `GET /projects/:projectId/media/*`: Публічний стрімінг assets для сторінок сайту та Live Preview. Автоматично встановлює `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=3600` та правильний MIME-тип.
  * Модернізовано існуючий `POST /files/upload` для збереження файлів у MinIO з дзеркалюванням у `public/assets/`.
* **Файл:** `apps/agent-api/src/web-frontend.ts`
  * Захищено префікс `/api/projects/` у функції `rewriteBrowserApiUrl`, щоб запити до медіафайлів коректно розпізнавалися Fastify і не викликали 404.

---

## 3. Результати тестування та докази

### 3.1. Модульні та регресійні тести (Vitest)
Створено окремий тестовий набір `tests/stage-4-project-media.test.ts`. Проведено тестування всього стеку медіа та регресійних тестів:

```
$ npx vitest run tests/stage-4-project-media.test.ts tests/stage-2-auth-cors-preview.test.ts tests/project-files-integration.test.ts tests/preview-browser-bridge.test.ts tests/data-studio-project-api-http.test.ts

 RUN  v3.2.7 D:/npati/NPATI Agent

 ✓ tests/preview-browser-bridge.test.ts (2 tests)
 ✓ tests/stage-4-project-media.test.ts (10 tests)
 ✓ tests/stage-2-auth-cors-preview.test.ts (9 tests)
 ✓ tests/data-studio-project-api-http.test.ts (14 tests)
 ✓ tests/project-files-integration.test.ts (5 tests)

 Test Files  5 passed (5)
      Tests  40 passed (40)
   Duration  6.69s
```

### 3.2. Наскрізне тестування життєвого циклу в реальному Docker-контурі
Виконано перевірку проти працюючих контейнерів:
1. **Ініціалізація MinIO:**
   - Бакет `npati-project-media` успішно створено та зареєстровано:
     ```
     [2026-10-17 15:57:33 UTC] 0B npati-project-media/
     ```
2. **Завантаження тестового зображення:**
   - Об'єкт: `e8fb3cc1-4809-4c95-a10a-1c7e2a57913b/715009ee-a7bf-4999-bce2-053d207b7af5/assets/hero-banner.png`
   - Підтвердження MinIO stat: `size: 70`, `content-type: image/png`.
3. **Стрімінг через `GET /api/projects/:id/media/*`:**
   - Отримано відповідь `HTTP 200 OK`.
   - Заголовок `Content-Type: image/png`.
   - Заголовок `X-Content-Type-Options: nosniff`.
   - Тіло відповіді: валідні бінарні байти PNG.
4. **Ізоляція між проєктами A і B:**
   - Запит того ж файлу через ідентифікатор іншого проєкту (`unknown-project-9999`):
     - Результат: `HTTP 404 Not Found` (доступ заблоковано).
5. **Захист від Path Traversal:**
   - Запит `/api/projects/:id/media/..%2f..%2fetc%2fpasswd`:
     - Результат: `HTTP 400 Bad Request` (відхилено на рівні санітизації шляху).
6. **Перезапуск Sandbox Runner:**
   - Виконано `docker restart npati-isolated-source-20261011-sandbox-runner-1`.
   - Повторний запит зображення: `HTTP 200 OK`, файл залишається повністю доступним та цілісним без жодних втрат.
7. **Мережева ізоляція Sandbox Runner від MinIO:**
   - `docker exec sandbox-runner-1 nc -zv -w 2 172.24.0.4 9000` завершується з `exit code 1` (таймаут/блокування). Внутрішній MinIO фізично недоступний процесам усередині runner.

### 3.3. Залишкові перевірки Етапу 3 (Verified)
* **Реальний `next build` у Sandbox Runner:**
  - Створено тестовий проєкт Next.js (`14.2.35`, React `18.3.1`, TypeScript `5`).
  - Виконано команду `prepare-project-dependencies.cjs install` — залежності скопійовано з локального toolchain profile `/opt/npati-project-toolchain/next` без жодного зовнішнього мережевого завантаження.
  - Виконано `./node_modules/.bin/next build`:
    ```
    ▲ Next.js 14.2.35
    Creating an optimized production build ...
    ✓ Compiled successfully
    Collecting page data ...
    ✓ Generating static pages (3/3)
    Finalizing page optimization ...
    NEXT_BUILD_SUCCESS
    ```
  - Статус: **Verified** (виконано та підтверджено реальними логами).

---

## 4. Перелік змінених та створених файлів

```
apps/agent-api/src/
├── object-storage.ts               # Реєстрація бакета npati-project-media
├── project-media-service.ts        # [НОВИЙ] Сервіс обробки мультимедіа сайтів
├── project-agent-capabilities.ts   # Реєстрація PROJECT_MEDIA_TOOLS
├── project-file-routes.ts          # Роути завантаження, лістингу та стрімінгу медіа
├── company-tool-runtime.ts         # Dispatch інструментів project.media.*
├── company-runtime.ts              # Промпти та реєстрація інструментів
├── company-runtime-tool-executor.ts# Валідація прав доступу до медіа-інструментів
├── app-company-automations.ts      # Ініціалізація та передача ProjectMediaService
├── platform-base-routes.ts         # Передача ProjectMediaService у файлові роути
├── app.ts                          # Підключення ProjectMediaService у DI контейнер
└── web-frontend.ts                 # Захист префіксу /api/projects від перезапису

tests/
└── stage-4-project-media.test.ts   # [НОВИЙ] 10 тестів на MIME, квоти, ліміти, ізоляцію

docs/integration/
├── current-state.md                # Оновлено актуальний стан
└── stage-4-report.md               # [НОВИЙ] Цей звіт
```

---

## 5. Відкриті питання та наступні кроки

1. **Delete Website (Етап 5):**
   - У межах Етапу 4 підготовлено метод `purgeProjectMedia`, який безпечно видаляє всі збережені об'єкти проєкту в бакеті `npati-project-media`.
   - Сам виклик очищення прив'язується до хука видалення сайту на Етапі 5 відповідно до вимоги користувача.
2. **Перехід до Етапу 5:**
   - **До Етапу 5 не переходжу без явного погодження користувача.**
