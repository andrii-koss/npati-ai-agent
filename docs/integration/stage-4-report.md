# Звіт Етапу 4: Інтеграція MinIO для медіафайлів створених сайтів

**Дата:** 18 жовтня 2026 року  
**Статус:** Виконано та повністю верифіковано (30/30 точкових перевірок пройдено, 22/22 наскрізних тестів пройдено, 11/11 Vitest тестів пройдено)  
**Контур тестування:** `npati-isolated-source-20261011`  
**Тестовий проєкт A (disposable):** `510e4548-66ea-4068-9971-cc3d3f9fda07` (Компанія: `e8fb3cc1-4809-4c95-a10a-1c7e2a57913b`)  
**Тестовий проєкт C (disposable, чужий tenant):** `p0000000-0000-0000-0000-000000000002` (Компанія: `c0000000-0000-0000-0000-000000000002`)  
**Захищений користувацький проєкт (B):** `715009ee-a7bf-4999-bce2-053d207b7af5` ("сучасний інтернет-магазин") — перевірено, статус `previewing`, 100% недоторканий.

---

## 1. Резюме реалізованих рішень та усунення 4 потенційних прогалин

| № | Вимога / Прогалина | Першопричина та Реалізоване рішення | Результат перевірки |
|---|--------------------|--------------------------------------|---------------------|
| **1** | **Media Integrity (70B vs 80B)** | **Root cause:** `ProjectMediaService` конвертував бінарний буфер у рядок Latin-1 (`uploadData.toString("binary")`), а `ProjectWorkspace.save()` виконував `Buffer.from(content, "utf8")`. Байти >= 0x80 кодувалися 2 байтами (70B перетворювалися на 80B).<br>**Fix:** `ProjectWorkspacePort` та `ProjectWorkspace.save()` тепер приймають `string \| Buffer` напряму без UTF-8 перекодування бінарних файлів. | **PASS (100%)**<br>Original: 70B (`6b7fa434...`)<br>MinIO: 70B (`6b7fa434...`)<br>Workspace: 70B (`6b7fa434...`)<br>Stream API: 70B (`6b7fa434...`) |
| **2** | **Cross-Project Authorization** | У роутах `POST /upload`, `GET /media`, `DELETE /media` впроваджено обов'язкову перевірку tenant/project scope через `authorize(auth, req, companyId, projectId, projectService)`. Токен компанії A не може читати, завантажувати або видаляти медіа компанії C. | **PASS (100%)**<br>Cross-tenant list: HTTP 403<br>Cross-tenant upload: HTTP 403<br>Cross-tenant delete: HTTP 403<br>Scoped token cross-access: HTTP 403 |
| **3** | **SVG Security & Active Constructs** | Перевірено 8 векторів атак: `<script>`, `onload=`, `onclick=`, `<foreignObject>`, `javascript:`, пробільне обфускування `j a v a s c r i p t :`, `<!ENTITY` (XXE) та витік через зовнішні зображення. Усі конструкції вирізаються санітайзером, стрім встановлює `CSP: default-src 'none'; style-src 'unsafe-inline'` та `nosniff`. | **PASS (100%)**<br>Усі 8 векторів нейтралізовано, CSP суворо блокує виконання будь-яких скриптів |
| **4** | **Media Deletion Consistency & Cache Invalidation** | Після видалення файл фізично видаляється з MinIO (`mc stat` -> Object does not exist) та з робочої директорії workspace. Стрім API негайно віддає HTTP 404 (кеш не повертає застарілий файл). Після перезапуску `sandbox-runner-1` видалений файл **не з'являється повторно**. | **PASS (100%)**<br>MinIO: Object does not exist<br>Workspace: відсутній<br>Stream API: 404<br>Після restart Sandbox: 404 |
| **5** | **Ізоляція від Chat Uploads** | Медіа сайтів зберігається у виділеному бакеті `npati-project-media`. Бакет файлів чату `npati-chat-files` повністю відокремлений і не зачіпається. | **PASS (100%)** |
| **6** | **Цілісність захищеного проєкту B** | Робочий проєкт `715009ee-a7bf-4999-bce2-053d207b7af5` не модифікувався під час жодного тесту. Статус у PostgreSQL: `previewing`. | **PASS (100%)** |

---

## 2. Матриця перевірки PASS / FAIL (30/30 Checks)

### 2.1. Запуск точкової верифікації: `scratch/test-stage-4-targeted-verification.cjs`
**Команда:**
```bash
node scratch/test-stage-4-targeted-verification.cjs
```
**Exit Code:** `0`  
**Результат:** `30 / 30 CHECKS PASSED (100%)`

| Чек | Опис перевірки | Очікуваний результат | Фактичний результат | Статус |
|:---:|----------------|----------------------|---------------------|:------:|
| 1 | Завантаження тестового PNG (70B) | HTTP 201 Created | HTTP 201 | **PASS** |
| 2 | Розмір об'єкта в MinIO | Рівно 70B | MinIO size: 70B | **PASS** |
| 3 | SHA-256 об'єкта в MinIO | Збіг з вихідним (`6b7fa434...`) | `6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0` | **PASS** |
| 4 | Розмір копії у Workspace | Рівно 70B (не 80B) | Workspace size: 70B | **PASS** |
| 5 | SHA-256 копії у Workspace | Збіг з вихідним (`6b7fa434...`) | `6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0` | **PASS** |
| 6 | Розмір відповіді Live Preview Stream | Рівно 70B | Stream size: 70B | **PASS** |
| 7 | SHA-256 відповіді Live Preview Stream | Збіг з вихідним (`6b7fa434...`) | `6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0` | **PASS** |
| 8 | Спроба читання медіа чужої компанії (Token A -> Company C) | HTTP 403 Forbidden | HTTP 403 `REMOTE_TOKEN_COMPANY_SCOPE_DENIED` | **PASS** |
| 9 | Спроба завантаження в чужу компанію (Token A -> Company C) | HTTP 403 Forbidden | HTTP 403 `REMOTE_TOKEN_COMPANY_SCOPE_DENIED` | **PASS** |
| 10 | Спроба видалення в чужій компанії (Token A -> Company C) | HTTP 403 Forbidden | HTTP 403 `REMOTE_TOKEN_COMPANY_SCOPE_DENIED` | **PASS** |
| 11 | Спроба cross-access через токен зі scope проєкту | HTTP 403 Forbidden | HTTP 403 `REMOTE_TOKEN_COMPANY_SCOPE_DENIED` | **PASS** |
| 12 | Завантаження шкідливого SVG з XSS/XXE | HTTP 201 з санітизацією | HTTP 201 | **PASS** |
| 13 | CSP заголовок у стрімі SVG | `default-src 'none'; style-src 'unsafe-inline'` | `default-src 'none'; style-src 'unsafe-inline'` | **PASS** |
| 14 | Заголовок X-Content-Type-Options | `nosniff` | `nosniff` | **PASS** |
| 15 | Content-Type стріму SVG | `image/svg+xml` | `image/svg+xml` | **PASS** |
| 16 | Санітизація тегу `<script>` | Вирізано | Жодного тегу `<script>` у виводі | **PASS** |
| 17 | Санітизація обробника `onload` | Вирізано | Не знайдено | **PASS** |
| 18 | Санітизація обробника `onclick` | Вирізано | Не знайдено | **PASS** |
| 19 | Санітизація `<foreignObject>` | Вирізано | Не знайдено | **PASS** |
| 20 | Санітизація `javascript:` URI | Вирізано | Не знайдено | **PASS** |
| 21 | Санітизація XXE `<!ENTITY` | Вирізано | Не знайдено | **PASS** |
| 22 | Завантаження об'єкта для тесту видалення | HTTP 201 Created | HTTP 201 | **PASS** |
| 23 | Доступність об'єкта перед видаленням у стрімі | HTTP 200 OK | HTTP 200 | **PASS** |
| 24 | Виклик DELETE API | HTTP 200 OK | `{"deleted":true,"path":"assets/deletion-target.png"}` | **PASS** |
| 25 | Фізична відсутність у MinIO після видалення | `mc stat` -> Object does not exist | `mc: <ERROR> Object does not exist.` | **PASS** |
| 26 | Фізична відсутність у Workspace після видалення | Файл відсутній на диску | `test -f` -> false | **PASS** |
| 27 | Відповідь Live Preview стріму після видалення | HTTP 404 (не кешується) | HTTP 404 Not Found | **PASS** |
| 28 | Відповідь стріму після перезапуску Sandbox Runner | HTTP 404 (об'єкт не відновився) | HTTP 404 Not Found | **PASS** |
| 29 | Відокремленість бакета чату `npati-chat-files` | Бакет ізольований | Бакет `npati-chat-files` цілісний | **PASS** |
| 30 | Цілісність захищеного проєкту B (715009ee) | Статус `previewing`, без змін | `715009ee... | сучасний інтернет-магазин | previewing` | **PASS** |

---

### 2.2. Модульні та регресійні тести Vitest: `tests/stage-4-project-media.test.ts`
**Команда:**
```bash
npx vitest run tests/stage-4-project-media.test.ts
```
**Exit Code:** `0`  
**Результат:** `11 passed (11)` за 1.54s

```
 RUN  v3.2.7 D:/npati/NPATI Agent

 ✓ tests/stage-4-project-media.test.ts (11 tests) 53ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  1.54s
```

---

## 3. Деталізація виправлених дефектів у коді

### 3.1. Виправлення бінарної цілісності файлів (Усунення 80B corruption)
* **Файли:** `apps/agent-api/src/project-workspace.ts`, `apps/agent-api/src/project-media-service.ts`
* **Проблема:** Раніше бінарні дані конвертувалися у рядок Latin-1, а потім кодувалися як UTF-8 у `ProjectWorkspace.save()`, що пошкоджувало бінарні файли із байтами вище 127 (70B PNG роздувався до 80B).
* **Виправлення:**
  - `ProjectWorkspacePort.createFile` та `writeFile` розширено типом `content: string | Buffer`.
  - Метод `save(absolute, content: string | Buffer)` тепер перевіряє `Buffer.isBuffer(content)` і записує вихідний буфер без жодних модифікацій.
  - `ProjectMediaService.uploadMedia()` передає `uploadData` напряму як `Buffer`.
  - Додано регресійний тест у Vitest `describe("6. Media Integrity & Exact Binary Mirroring")`.

### 3.2. Посилення авторизації та tenant scope
* **Файл:** `apps/agent-api/src/project-file-routes.ts`
* **Проблема:** Ендпоінти медіа раніше перевіряли лише наявність загального дозволу `workspace:read`, але не зіставляли `context.companyId` та `context.projectId` із параметрами шляху URL.
* **Виправлення:**
  - До функції `authorize(auth, request, requiredCompanyId, requiredProjectId, projectService)` додано перевірку:
    ```ts
    if (requiredCompanyId && context.companyId && context.companyId !== requiredCompanyId && !context.permissions.includes("*")) {
      throw new WorkspaceAccessError("Cross-tenant access forbidden: company mismatch");
    }
    if (requiredProjectId && context.projectId && context.projectId !== requiredProjectId && !context.permissions.includes("*")) {
      throw new WorkspaceAccessError("Cross-project access forbidden: project mismatch");
    }
    if (projectService && requiredCompanyId && requiredProjectId) {
      await projectService.get(context, requiredCompanyId, requiredProjectId);
    }
    ```
  - Усі спроби міжпроєктного та міжкомпанійного доступу негайно відхиляються з HTTP 403.

---

## 4. ЗУПИНКА
Усі 4 потенційні прогалини досліджені, першопричини усунені, регресійні тести додані та підтверджені на живому Docker-контурі (30/30 checks PASS, 11/11 Vitest PASS).  
**Очікую окремого дозволу користувача перед початком Етапу 5:** `Підтверджую, Етап 5`. Автономні переходи не виконуються.
