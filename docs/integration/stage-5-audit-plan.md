# Етап 5: Аудит Delete Website Lifecycle, Спільні Ресурси та Безпечний Dry-Run

**Дата:** 17 жовтня 2026 року  
**Статус:** Аудит та Dry-Run виконано (Без фізичних видалень, без змін прод-інфраструктури)  
**Тестовий проєкт:** `715009ee-a7bf-4999-bce2-053d207b7af5` ("сучасний інтернет-магазин")  
**Тестова компанія:** `e8fb3cc1-4809-4c95-a10a-1c7e2a57913b`  
**DataBackend ID:** `b5533f4c-de46-4426-adf8-f6631759ee9c` ("сучасний інтернет-магазин data")  

---

## 1. Аналіз поточного життєвого циклу видалення сайту (As-Is)

На даний момент у кодовій базі існують такі точки входу та логіка видалення:

1. **Роут видалення коду проєкту:**  
   `DELETE /companies/:companyId/code/projects/:projectId` ([code-project-lifecycle-routes.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-project-lifecycle-routes.ts#L389-L435))
   - Вимагає підтвердження в тілі запиту: `{ confirm: true }`.
   - Записує подію в `audit_log` (`action: "code.project.delete"`).
   - Викликає `deps.projects.delete(ctx, companyId, projectId)`.
   - Викликає `attemptWorkspaceRemoval(ctx, companyId, projectId)` через `MountedWorkspaceProvider.removeProjectWorkspace`.

2. **Хук `ProjectService.beforeRemove`:**  
   Зареєстровано в [app.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/app.ts#L255-L260):
   ```ts
   const projectService = new ProjectService(workspaceStore, async (context, project) => {
     if (project.sandboxId && !projectSandbox) throw new Error("Sandbox runner is required to remove this Project");
     await projectSandbox?.destroy(context, project);
     await dataBackendService?.detachProjectArtifacts(context, project.companyId, project.id).catch(() => undefined);
   }, ...);
   ```
   - Знищує пісочницю в Sandbox Runner (`projectSandbox.destroy`).
   - Відв'язує артефакти DataBackend (`detachProjectArtifacts`): очищає `corsOriginsByProject[projectId]`, видаляє записи з `project_redirect_urls` та `project_api_request_logs`, встановлює `attached_backend_id = null`.
   - **НЕ чіпає саму базу даних DataBackend** (база `db_..._dev` залишається недоторканою).

3. **Видалення рядка в Core DB (`projects`):**  
   `DELETE FROM projects WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4`  
   - Каскадно видаляє (`CASCADE`): `project_terminal_events`, `project_checkpoints`, `project_deployments`, `project_qa_reports`, `code_sessions`.
   - Встановлює `SET NULL` для `company_agent_runs`.

4. **Що наразі залишається "сиротою" (Gaps):**
   - **MinIO Media (`npati-project-media`):** Об'єкти `${companyId}/${projectId}/*` не видаляються.
   - **Таблиці без FK CASCADE:** `code_activity_events` (127 рядків), `code_context_summaries` (8 рядків), `code_run_states` тощо не видаляються автоматично, якщо не налаштовано тригерів.
   - **Sandbox Runner:** Якщо sandbox був у стані `created`/`stopped`, директорія `/projects/:projectId` або запис у `/runtime-state/projects.json` може залишатися, якщо `sandboxId` не було передано.

---

## 2. Результати реального аудиту тестового проєкту (Dry-Run Fact Sheet)

Проведено реальне сканування працюючих контейнерів контуру `npati-isolated-source-20261011` для проєкту `715009ee-a7bf-4999-bce2-053d207b7af5`:

```
================================================================================
AUDIT & DRY-RUN: Resources for Project 715009ee-a7bf-4999-bce2-053d207b7af5
================================================================================

1. CORE PROJECT RECORD:
   - Name: сучасний інтернет-магазин
   - Status: previewing
   - Type: code_project
   - DataBackend ID: b5533f4c-de46-4426-adf8-f6631759ee9c
   - Sandbox ID: 98fa859f-6d1c-4c2f-899e-af9cd9693f1a
   - Created By: 599402b8-b9d5-4676-a391-7b9db1a77026

2. CORE DATABASE (npati_agent) TABLES:
   - audit_log: 30 rows
   - code_activity_events: 127 rows
   - code_context_summaries: 8 rows
   - code_process_projects: 1 rows
   - code_replay_bundles: 1 rows
   - code_run_states: 1 rows
   - code_session_inboxes: 1 rows
   - code_session_plans: 1 rows
   - code_sessions: 6 rows
   - execution_snapshots: 1 rows
   - project_api_request_logs: 18 rows
   - project_checkpoints: 7 rows
   - project_terminal_events: 1 rows
   Total related rows across core tables: 203

3. DATA BACKEND & SHARED DATABASE USAGE:
   - Backend ID: b5533f4c-de46-4426-adf8-f6631759ee9c ("сучасний інтернет-магазин data")
   - Backend Status: ready
   - Projects sharing this backend (1):
     * 715009ee-a7bf-4999-bce2-053d207b7af5 [THIS PROJECT]
   - Target Databases in postgres-projects:
     * Dev DB: db_b5533f4cde464426adf8f6631759ee9c_dev (6 tables: auth users, roles, tokens)
     * Prod DB: db_b5533f4cde464426adf8f6631759ee9c_prod

4. MINIO OBJECT STORAGE (npati-project-media):
   - Scope: e8fb3cc1-4809-4c95-a10a-1c7e2a57913b/715009ee-a7bf-4999-bce2-053d207b7af5/

5. ON-DISK WORKSPACE:
   - Agent-API host path: /app/data/project-workspaces/e8fb3cc1.../715009ee...
   - Files (11): .git, .gitignore, PROJECT.md, cart.html, checkout.html, index.html, npati-client.ts, products.html, script.js, style.css, website.config.json

6. SANDBOX RUNNER RUNTIME:
   - State entry in /runtime-state/projects.json: id 98fa859f-6d1c-4c2f-899e-af9cd9693f1a, UID 10000, Port 3001
   - Isolated directory: /projects/715009ee-a7bf-4999-bce2-053d207b7af5
   - Active slirp4netns process PID 2294 (UID 10000)
```

---

## 3. Розподіл ресурсів: Спільні vs Виділені (Dedicated)

| Категорія | Ресурс | Належність | Політика при видаленні сайту |
|-----------|--------|------------|------------------------------|
| **Виділені ресурси (Dedicated)** | Рядок `projects` у Core DB | Тільки цей проєкт | Soft Delete (перехід у `deleted`) з подальшою архівацією |
| **Виділені ресурси (Dedicated)** | Директорія робочого простору (`project-workspaces`) | Тільки цей проєкт | Архівується / очищається після retention period |
| **Виділені ресурси (Dedicated)** | Sandbox Runner контейнер / директорія (`/projects/:pId`) | Тільки цей проєкт | Зупинка процесів, видалення через `projectSandbox.destroy` |
| **Виділені ресурси (Dedicated)** | Медіафайли сайту (`npati-project-media/:cId/:pId/*`) | Тільки цей проєкт | Повне очищення через `purgeProjectMedia` після retention |
| **Виділені ресурси (Dedicated)** | Чекпоїнти, сесії коду, логи запитів API | Тільки цей проєкт | Видаляються каскадно або очищаються разом із проєктом |
| **СПІЛЬНІ РЕСУРСИ (Shared)** | **DataBackend (`data_backends`)** | Компанія / Група проєктів | **НЕ ВИДАЛЯЄТЬСЯ**. Виконується тільки `detach` (`attached_backend_id = null`). База може обслуговувати інші сайти або мобільні застосунки компанії. |
| **СПІЛЬНІ РЕСУРСИ (Shared)** | **PostgreSQL бази даних (`db_..._dev`, `db_..._prod`)** | DataBackend компанії | **НЕ ВИДАЛЯЮТЬСЯ**. Дані користувачів та таблиці залишаються цілісними. Фізичне видалення бази дозволяється тільки при явному видаленні всього DataBackend з окремим підтвердженням назви бази. |
| **СПІЛЬНІ РЕСУРСИ (Shared)** | Резервні копії та зліпки (`/app/project-snapshots`) | Компанія / Аудит | Зберігаються згідно з `NPATI_PROJECTS_SNAPSHOT_RETENTION_DAYS` (30 днів). Не підлягають негайному знищенню. |
| **СПІЛЬНІ РЕСУРСИ (Shared)** | `audit_log` у Core DB | Аудит безпеки компанії | Зберігається перманентно для аудиту (записи позначаються як пов'язані з видаленим проєктом). |

---

## 4. Запропонована Deletion State Machine

Для запобігання втраті даних через випадковий клік, забезпечення відновлення та захисту від часткових збоїв пропонується трифазна машина станів:

```
                  ┌────────────────┐
                  │     ACTIVE     │
                  └───────┬────────┘
                          │ Запит на видалення + перевірка прав власника
                          ▼
                  ┌────────────────┐
                  │    DELETING    │ (Зупинка Sandbox, Stop Preview, Detach DataBackend)
                  └───────┬────────┘
                          │ Усі сервіси підтвердили зупинку
                          ▼
                  ┌────────────────┐
                  │  SOFT DELETED  │ (Retention period: 30 днів за замовчуванням)
                  └───────┬────────┘
                          │ Закінчення терміну retention + Cron Cleanup
                          ▼
                  ┌────────────────┐
                  │  HARD PURGED   │ (Очищення MinIO media, видалення файлів workspace)
                  └────────────────┘
```

### Фази життєвого циклу:
1. **Фаза 1: Перевірка авторизації та блокування (Active → Deleting)**
   - Перевірка прав: тільки користувач з роллю `owner` або дозволом `business:manage`.
   - Перевірка активних запусків: якщо проєкт зараз компілюється або агент виконує зміни, видалення блокується з `409 CONFLICT`.
   - Встановлення `status = "deleting"`, фіксація `deleted_at = NOW()`, `deleted_by = ctx.userId`.

2. **Фаза 2: Зупинка виконання та відв'язування ресурсів (Deleting → Soft Deleted)**
   - Зупинка Live Preview через `ProjectPreviewService.stopPreview`.
   - Зупинка процесів у Sandbox Runner та виклик `ProjectSandboxService.destroy`.
   - Відв'язування DataBackend: виклик `dataBackendService.detachProjectArtifacts` (очищення CORS конкретного проєкту, правил перенаправлення, логів). База даних **не видаляється**.
   - Перехід проєкту у стан `status = "deleted"`. Сайт зникає з інтерфейсу звичайних списків, але залишається в базі.

3. **Фаза 3: Retention & Hard Purge (Soft Deleted → Purged)**
   - Проєкт перебуває у стані soft delete протягом вікна retention (за замовчуванням 30 днів).
   - Протягом цього часу власник може переглянути стан або відновити проєкт.
   - По завершенню терміну окремий фоновий воркер викликає:
     - `ProjectMediaService.purgeProjectMedia(ctx, companyId, projectId)` (очищення MinIO);
     - `MountedWorkspaceProvider.removeProjectWorkspace(ctx, companyId, projectId)` (видалення директорії з диска);
     - Фізичне видалення рядка з `projects` (з каскадним очищенням залишків).

---

## 5. Врахування зауважень Етапу 4 (Безпека та Архітектура)

1. **Розділення Public vs Private Assets:**
   - Публічний стрімінг `GET /api/projects/:projectId/media/*` обмежується виключно директорією `assets/` (публічні картинки, стилі, шрифти).
   - Приватні файли (конфігурації, документи, завантажені користувачами файли) не віддаються через публічний URL і вимагають обов'язкової автентифікації сесії або підписаного токена (Signed URL).

2. **Безпека SVG та захист від XSS:**
   - Для SVG-файлів застосовується обов'язковий заголовок `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` та `Content-Disposition: inline`.
   - Додається перевірка валідності вмісту (заборона виконання вбудованого JS через `<script>` або inline обробники `onload` при рендерингу в контексті платформи).

3. **Синхронізація MinIO та Sandbox:**
   - MinIO виступає єдиним джерелом правди (Single Source of Truth) для медіа.
   - Квота проєкту (250 MB) обраховується **виключно** за розміром об'єктів у MinIO, що унеможливлює подвійне списання квоти через дублювання файлів на диску в `public/assets/`.

4. **Fastify inject vs Browser E2E:**
   - Зафіксовано: Fastify inject залишається модульним/інтеграційним тестом бекенду. Повноцінний запуск автономного браузера Playwright для перевірки Live Preview виноситься окремим критерієм на **Етап 6**.

---

## 6. План безпечної реалізації (Safe Implementation Plan)

- [x] **Крок 5.1 (Виконано):** Повний аудит поточного коду видалення, FK залежностей і таблиць.
- [x] **Крок 5.2 (Виконано):** Сканування фактичного стану тестового проєкту в Core DB, `postgres-projects`, MinIO, Sandbox Runner та на диску.
- [x] **Крок 5.3 (Виконано):** Розробка Deletion State Machine та політики Shared vs Dedicated ресурсів.
- [ ] **Крок 5.4 (Очікує погодження):** Створення API dry-run endpoint `GET /companies/:companyId/projects/:projectId/delete-plan`, який повертає користувачу повний звіт про ресурси, що будуть зачеплені, без внесення змін.
- [ ] **Крок 5.5 (Очікує погодження):** Реалізація двохфазного видалення (Soft Delete + Detach DataBackend + Stop Sandbox) без виклику `DROP DATABASE`.
- [ ] **Крок 5.6 (Очікує погодження):** Інтеграція `purgeProjectMedia` з фоновим воркером очищення застарілих проєктів (після закінчення retention).
