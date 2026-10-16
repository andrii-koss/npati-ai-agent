# NPATI Coding Agent — E2E QA Етап 1: Технічний аудит реалізації (E0 Audit)

**Дата аудиту:** 16 жовтня 2026  
**Commit SHA:** `bde1d0af45a402ef93e14e77d3d42d9212358892` (branch: `main`)  
**Host Environment:** Windows 11 (PowerShell 7 / cmd), Node.js v22.13.1, Docker Desktop Engine 29.4.0 (Linux containers)  
**Регламент:** `docs/coding-agent/e2e-testing/PLAN.md`, `docs/coding-agent/PLAN.md` (read-only)  

---

## 1. Scope та Non-Scope Етапу 1

### 1.1. В межах етапу (Scope)
1. **Повний статичний та архітектурний аналіз репозиторію:** перевірка реальних викликів, інтерфейсів, маршрутів, баз даних, міграцій, sandbox-контейнера та UI-компонентів.
2. **Точна прив'язка до коду:** фіксація шляхів файлів, експортованих символів, номерів рядків та контрактів API для кожної підсистеми.
3. **Картування кандидатних тест-сценаріїв:** аналіз усіх 69 сценаріїв (T001–T069) з `TEST-MATRIX.md` з категоріями Feasibility (feasible / blocked / missing API / missing environment).
4. **Формулювання архітектури E2E-раннера:** вибір єдиного фреймворку (Vitest + Playwright), схема сценаріїв, каталог, структура звітності.
5. **Розробка запобіжників ізоляції (Production Safety Guards):** алгоритм створення та видалення ефемерних БД, користувачів, проектів і сесій, правила захисту від зачіпання production.
6. **Перелік Preflight Checks:** підготовка списку технічних перевірок середовища, які **не запускалися** під час аудиту.
7. **Оновлення артефактів:** створення цього аудиту в `docs/coding-agent/e2e-testing/00-audit.md` та синхронізація `current-state.md`.

### 1.2. Поза межами етапу (Non-Scope)
- Жодних правок продуктового коду, конфігурацій, схем баз даних або кодової бази `apps/*`, `packages/*`.
- Жодних запусків тестових раннерів із навантаженням на живі Docker-контейнери чи API.
- Жодних мутацій даних у PostgreSQL, Redis чи MinIO.
- Жодного переходу до Етапу 2 (E1 Smoke) без явної команди користувача.

---

## 2. Докази реальної реалізації в репозиторії (Implementation Evidence)

### 2.1. Chat API, HTTP, SSE та життєвий цикл сесії
- **SSE Stream Endpoint:** `POST /chat/stream` зареєстровано у [chat-stream-routes.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/chat-stream-routes.ts#L80-L130). Підтримує заголовки `text/event-stream`, події:
  - `event: progress` — статус кроків підготовки (`project`, `files`, `agent`, черга).
  - `event: delta` — стрімінг токенів відповіді.
  - `event: result` — термінальний підсумок із `projectCard`, `projectAction`, `activeContext`.
  - `event: error` — помилки валідації або провайдера.
  - `event: code_session`, `event: code_inbox` — статус черги інбоксу для паралельних взаємодій.
- **Скасування стріму:** `POST /chat/streams/:streamId/cancel` у [chat-routes.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/chat-routes.ts#L50-L57).
- **Спеціалізований запуск Code Run (CLI / Headless):** `POST /companies/:companyId/code/runs` у [code-cli-run-routes.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-cli-run-routes.ts#L10-L70). Повертає `202 Accepted` із виділеним `runId` до відкриття стріму, запобігає side-effects чату.
- **Background Stream для Code Runs:** `GET /companies/:companyId/code/runs/:runId/background-stream` через [code-background-run-routes.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-background-run-routes.ts), із підтримкою `fromSeq` для відновлення зв'язку без втрати подій.

### 2.2. Автентифікація, токени та RBAC
- **Провайдер автентифікації:** `NpatiBackendAuthProvider` у [auth.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/auth.ts#L93-L365).
  - Підтримує Bearer JWT (перевірка HS256 через `jwtSecret` або `NPATI_JWT_SECRET`).
  - Генератор тестових JWT: функція `createMockNpatiJwt` у [auth.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/auth.ts#L425-L445).
  - Підтримка API-ключів `npati_live_*` у [auth.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/auth.ts#L207-L258).
  - Підтримка Remote Access Tokens `rat_*` у [auth.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/auth.ts#L261-L300).
  - Режим `LocalDevAuthProvider` (при `allowDevFallback: true`) у [auth.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/auth.ts#L25-L36).
- **RBAC та захист від підвищення привілеїв:** [code-rbac.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-rbac.ts). Розподіл прав: `workspace:read`, `workspace:write`, `business:manage`, `tools:execute`. Жорстка заборона агентам і сервісним токенам схвалювати власні дії (`isNonHumanPrincipal` у [approvals-routes.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/approvals-routes.ts#L25-L31)).

### 2.3. OmniRoute, AI Провайдери та бюджетування
- **Адаптер OmniRoute:** `OmniRouteEngine` у [omniroute-engine.ts](file:///d:/npati/NPATI%20Agent/packages/omniroute-adapter/src/omniroute-engine.ts). Застосовується єдиний інтерфейс `AIEngine` для OpenAI, Anthropic, Qwen, DeepSeek, Ollama.
- **Маркетплейс моделей:** `OmniRouteMarketplace` у [marketplace-client.ts](file:///d:/npati/NPATI%20Agent/packages/omniroute-adapter/src/marketplace-client.ts).
- **Model Profiles & Fallback:** [code-model-profiles.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-model-profiles.ts). При відмові або перевантаженні (429/503) виконується типізований fallback згідно з політикою `ProviderDataPolicy`.
- **Контекстний тиск і Compaction:** [code-context-budget.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-context-budget.ts) та `ContextCompactor` у [context-compactor.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/context-compactor.ts). Стиснення контексту спрацьовує при досягненні 75% вікна моделі зі збереженням репо-карти та початкового завдання.

### 2.4. Coding Runtime, ліміти та хвильовий запуск інструментів
- **Головний цикл раннера:** `CodingAgentRunner` у [coding-agent-runner.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/coding-agent-runner.ts#L65-L200).
- **Хвильове групування (Wave Batching):** `CodingAgentToolWaves` у [coding-agent-tool-waves.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/coding-agent-tool-waves.ts). До 8 паралельних read-only інструментів (`code.fs.read`, `code.search.grep`, `code.fs.list`). Мутуючі інструменти виконуються строго послідовно.
- **Конфігураційні ліміти (DEFAULT_CODE_AGENT_LIMITS):** [code-agent-config.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-agent-config.ts#L64-L94):
  - `maxStepsPerRun: 40` кроків моделі;
  - `maxRunMinutes: 30` хвилин;
  - `commandTimeoutMs: 120_000` (2 хв);
  - `installBuildTimeoutMs: 600_000` (10 хв);
  - `repairLoopAttempts: 3` спроби виправлення помилок збірки/тестів;
  - `toolCallNoProgressMs: 300_000` (5 хв таймаут відсутності прогресу);
  - `subagentDepth: 1` (максимальна глибина субагентів);
  - `subagentParallelism: 4` (максимум паралельних субагентів).
- **Детекція зациклення (Loop Detection):** Поріг 3 ідентичних виклики поспіль генерує `REMINDER_MESSAGE`, якщо прогресу немає — статус `loop_detected`.

### 2.5. Файлові операції та транзакційні патчі
- **Захист цілісності файлів:** [code-tools-patch.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-tools-patch.ts) та [code-patch-transaction.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-patch-transaction.ts).
  - Принцип `read-before-write` контролюється через [code-read-tracker.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-read-tracker.ts).
  - Патчі валідуються за хешем `expectedRevision` перед внесенням змін.
  - У разі помилки транзакція повертає файли у вихідний стан.

### 2.6. Shared Docker Sandbox, ізоляція та мережеві запобіжники
- **Архітектурний стандарт:** Всі сайти розміщуються в єдиному контейнері `npati-project-runtime` (образ на базі `apps/agent-api/Dockerfile`, target `project-runtime`) у каталогах `/projects/<projectId>` ([docker-compose.sandbox-runner.yml](file:///d:/npati/NPATI%20Agent/docker-compose.sandbox-runner.yml#L18-L57)).
- **Supervisor всередині контейнера:** `SharedProjectRuntimeProvider` у [shared-project-runtime-provider.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/shared-project-runtime-provider.ts#L41-L150) та Fastify API на порті `7865` ([shared-project-runtime-server.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/shared-project-runtime-server.ts#L10-L79)).
- **Ізоляція між проектами:**
  - Кожен проект запускається під унікальним UID (`10000–60000`);
  - Серверний порт проекту (`3001–65000`) захищено правилами iptables `NPATI_PROJECTS` (доступ лише власному UID);
  - Шляхи перевіряються через `safeProjectPath` у [project-workspace.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/project-workspace.ts) (заборона виходу за межі `/projects/<projectId>`);
  - Контейнер має `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges: true`, сесійні tmpfs для `/tmp` і `/runtime-state`.
  - Захист від SSRF: [code-egress-policy.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-egress-policy.ts) блокує приватні IP (10.x, 172.16-31.x, 192.168.x, 127.x) після DNS-резолвінгу.

### 2.7. Live Preview та Authenticated Reverse Proxy
- **Preview контролер:** `ProjectPreviewService` у [project-preview-service.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/project-preview-service.ts).
- **Маршрути запуску та проксі:** [project-preview-routes.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/project-preview-routes.ts#L31-L182):
  - `POST /companies/:companyId/projects/:projectId/preview/start`
  - `POST /companies/:companyId/projects/:projectId/preview/stop`
  - `GET /companies/:companyId/projects/:projectId/preview/status`
  - `GET /companies/:companyId/projects/:projectId/preview/token`
  - `ALL /companies/:companyId/projects/:projectId/preview/proxy/*` — проксіювання HTTP та WebSocket до внутрішнього порту проекту з валідацією тимчасового підписаного токена.

### 2.8. Browser QA через Playwright Chromium
- **Служба перевірки інтерфейсу:** `ProjectBrowserQaService` у [project-browser-qa-service.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/project-browser-qa-service.ts#L46-L130).
- **Маршрути Browser QA:** [project-qa-routes.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/project-qa-routes.ts#L45-L105):
  - `POST /companies/:companyId/projects/:projectId/qa/inspect`
  - `GET /companies/:companyId/projects/:projectId/qa/reports`
  - `GET /companies/:companyId/projects/:projectId/qa/latest`
- **Headless Runner всередині контейнера:** [browser-qa-runner.mjs](file:///d:/npati/NPATI%20Agent/apps/agent-api/browser-qa-runner.mjs#L1-L70). Запускає Chromium (`playwright@1.63.0`), фіксує HTTP status, помилки `console.error`, неперехоплені `pageerror`, биті посилання, accessibility violations та redacted скріншот.

### 2.9. Activity & Run Trace (Спостережуваність)
- **Захищений Sink подій:** `CodeRunActivitySink` у [code-run-activity-sink.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-run-activity-sink.ts#L37-L120).
  - Заборона збереження контенту: перевірка `assertMetadataOnlyActivityPayload` блокує ключі `command`, `content`, `prompt`, `stdout`, `diff`, `token`, `password` тощо.
  - Захист від витоку секретів: `assertNoSecretsInActivityPayload` через `scanTextForSecrets`.
- **Таблиця бази даних:** `code_activity_events` (міграції `077_code_activity_events` та `084_code_activity_parents` у [packages/workspace](file:///d:/npati/NPATI%20Agent/packages/workspace/src/migration-077.ts)). Поля: `company_id`, `session_id`, `run_id`, `parent_run_id`, `snapshot_id`, `kind`, `payload`, `created_at`.
- **API отримання трейсу:** `GET /companies/:companyId/code/runs/:runId/turns` у [code-run-stream-routes.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-run-stream-routes.ts#L303-L393).
- **Веб-інтерфейс:** Панелі `CodeWorkspaceExecutionPanel` ([CodeWorkspaceExecutionPanel.tsx](file:///d:/npati/NPATI%20Agent/apps/web/src/code-workspace/CodeWorkspaceExecutionPanel.tsx)) та нижні вкладки `Changes / Terminal / Logs / Activity` ([code-workspace-bottom-tabs.tsx](file:///d:/npati/NPATI%20Agent/apps/web/src/code-workspace-bottom-tabs.tsx#L16-L60)).

### 2.10. Approvals та Subagents
- **Маршрути схвалень:**
  - `GET /companies/:companyId/approvals` та `POST /companies/:companyId/approvals/:approvalId/decide` у [approvals-routes.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/approvals-routes.ts#L43-L120).
  - Схвалення прив'язані до хешу аргументів інструменту (`replayArgumentsHash`).
- **Субагенти:** [code-subagent-limits.ts](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-subagent-limits.ts#L25-L55) фіксує `CODE_SUBAGENT_MAX_DEPTH = 1` та `CODE_SUBAGENT_MAX_PARALLELISM = 4`. Дочірній агент позбавлений інструменту `code.agent.spawn` для унеможливлення неконтрольованої рекурсії.

---

## 3. Картування кандидатних сценаріїв (TEST-MATRIX.md: T001–T069)

Для кожного з 69 сценаріїв визначено реальну здійсненність у репозиторії:

| ID | Категорія | Сценарій | Suite | Стан аналізу | Feasibility | Передумови та точки перевірки в коді |
|---|---|---|---|---|---|---|
| **T001** | Smoke | `chat-auth-real` | Smoke | Implemented | **Feasible** | `POST /chat/stream` з Bearer JWT (`auth.ts:197`). Відповідь 200 SSE, валідація AuthContext. |
| **T002** | Smoke | `chat-streaming-termination` | Smoke | Implemented | **Feasible** | `POST /chat/stream` емітує delta, коректно завершує з'єднання подією result, або обробляє cancel. |
| **T003** | Smoke | `create-small-project` | Smoke | Implemented | **Feasible** | Створення проекту через чат або `POST /companies/:id/projects/:id`. Перевірка запису в store. |
| **T004** | Smoke | `create-file` | Smoke | Implemented | **Feasible** | Виклик агентом `code.fs.write`. Перевірка появи файлу у `/projects/<projectId>` пісочниці. |
| **T005** | Smoke | `edit-existing-file` | Smoke | Implemented | **Feasible** | `code.fs.read` -> `code.fs.patch`/`edit`. Контроль read-before-write та оновлення ревізії. |
| **T006** | Smoke | `safe-terminal` | Smoke | Implemented | **Feasible** | `code.shell.exec` безпечної команди (`node -v`). Класифікатор ризику дозволяє виконання. |
| **T007** | Smoke | `small-build` | Smoke | Implemented | **Feasible** | Запуск `npm test` або скрипту збірки в пісочниці. Перевірка exitCode 0. |
| **T008** | Smoke | `preview-http` | Smoke | Implemented | **Feasible** | Запуск сервера через `/preview/start`, перевірка повернення HTTP 200 через `/preview/proxy/*`. |
| **T009** | Smoke | `same-chat-second-turn` | Smoke | Implemented | **Feasible** | Друге повідомлення в ту саму сесію; перевірка збереження `projectId` без створення дубліката. |
| **T010** | Smoke | `trace-minimum` | Smoke | Implemented | **Feasible** | Запис подій у `code_activity_events` та видача через `GET /code/runs/:runId/turns`. |
| **T011** | Coding | `nextjs-create-pages` | Regression | Implemented | **Feasible** | Генерація сторінок Next.js (`/`, `/products`). Перевірка структури файлів. |
| **T012** | Coding | `nextjs-red-theme` | Regression | Implemented | **Feasible** | Модифікація CSS/стилів Next.js. Перевірка збереження решти сторінок. |
| **T013** | Coding | `nextjs-search-products` | Regression | Implemented | **Feasible** | Додавання компонента пошуку і фільтрації. Перевірка відсутності регресій. |
| **T014** | Coding | `nextjs-cart-detail` | Regression | Implemented | **Feasible** | Створення сторінки товару і стану кошика. Перевірка транзакційного патча. |
| **T015** | Coding | `nextjs-refactor-preserve` | Regression | Implemented | **Feasible** | Рефакторинг коду зі збереженням існуючого функціоналу сторінок. |
| **T016** | Coding | `vite-create-app` | Regression | Implemented | **Feasible** | Створення React + Vite застосунку, виконання `vite build` без помилок. |
| **T017** | Coding | `node-api-endpoint` | Regression | Implemented | **Feasible** | Створення HTTP сервера Node.js, `npm test`, віддача валідного JSON. |
| **T018** | Coding | `python-app-if-supported` | Regression | Implemented | **Feasible** | Перевірка `python3 -m compileall` та `http.server` у середовищі пісочниці. |
| **T019** | Coding | `multifile-rename` | Regression | Implemented | **Feasible** | Багатофайлове перейменування з оновленням імпортів. |
| **T020** | Coding | `bugfix-ts-error` | Regression | Implemented | **Feasible** | Самовідновлення: помилка TypeScript -> зворотний зв'язок -> виправлення -> збірка успішна. |
| **T021** | Coding | `dependency-install` | Regression | Implemented | **Feasible** | Виклик `code.deps.add`, блокування typosquatting, валідація lockfile. |
| **T022** | Coding | `rollback-checkpoint` | Regression | Implemented | **Feasible** | Створення Git-чекпойнта перед змінами та відновлення через `restoreCheckpoint`. |
| **T023** | Interaction | `real-browser-login` | Regression | Implemented | **Feasible** | Авторизація користувача через Playwright у формі входу веб-додатка. |
| **T024** | Interaction | `real-browser-chat-stream` | Regression | Implemented | **Feasible** | Введення повідомлення в Chat UI через браузер і відстеження SSE-потоку в DOM. |
| **T025** | Interaction | `DOM-navigation` | Regression | Implemented | **Feasible** | Навігація сторінками згенерованого застосунку в Preview iframe. |
| **T026** | Interaction | `DOM-search` | Regression | Implemented | **Feasible** | Взаємодія з полем пошуку на згенерованій сторінці, перевірка результатів у DOM. |
| **T027** | Interaction | `DOM-cart` | Regression | Implemented | **Feasible** | Клік "Add to Cart", перевірка лічильника кошика в DOM. |
| **T028** | Interaction | `DOM-contact-form` | Regression | Implemented | **Feasible** | Заповнення та відправка форми, перевірка появи повідомлення про успіх. |
| **T029** | Interaction | `browser-console` | Regression | Implemented | **Feasible** | Фіксація відсутності неперехоплених помилок у JS-консолі через Browser QA. |
| **T030** | Interaction | `browser-accessibility-basics` | Regression | Implemented | **Feasible** | Перевірка базових критеріїв a11y (наявність alt, form labels, lang атрибута). |
| **T031** | Context | `long-prompt-instructions` | Regression | Implemented | **Feasible** | Обробка складного багатокрокового промпту без втрати частин завдання. |
| **T032** | Context | `second-turn-same-project` | Regression | Implemented | **Feasible** | Контекстна пам'ять зберігає стан проекту між раундами діалогу. |
| **T033** | Context | `UA-reply-language` | Regression | Implemented | **Feasible** | Відповідь українською мовою на український запит (перевірено у `routing-final.json`). |
| **T034** | Context | `EN-reply-language` | Regression | Implemented | **Feasible** | Відповідь англійською мовою на запит англійською. |
| **T035** | Context | `PT-reply-language` | Regression | Implemented | **Feasible** | Відповідь португальською мовою на запит португальською. |
| **T036** | Context | `refresh-chat` | Regression | Implemented | **Feasible** | Перезавантаження сторінки веб-інтерфейсу, відновлення історії повідомлень з API. |
| **T037** | Context | `SSE-reconnect` | Regression | Implemented | **Feasible** | Відновлення обірваного SSE-з'єднання з параметром `fromSeq`. |
| **T038** | Context | `context-compaction` | Regression | Implemented | **Feasible** | Стиснення контексту при 75% заповнення вікна (`compactConversationContextIfNeeded`). |
| **T039** | Context | `session-resume` | Regression | Implemented | **Feasible** | Відновлення виконання сесії після паузи через `CodeSessionResumeService`. |
| **T040** | Trace | `tool-call-correlation` | Full | Implemented | **Feasible** | Перевірка зв'язку `runId -> turnIndex -> toolCallId` у `code_activity_events`. |
| **T041** | Trace | `stderr-exit-code` | Full | Implemented | **Feasible** | Фіксація ненульового exitCode та bounded stderr у трейсі. |
| **T042** | Trace | `build-failure-trace` | Full | Implemented | **Feasible** | Помилка збірки коректно відображається в Activity без падіння процесу сервера. |
| **T043** | Trace | `preview-failure-trace` | Full | Implemented | **Feasible** | Збій старту preview фіксується у трейсі зі зрозумілим користувачеві статусом. |
| **T044** | Trace | `trace-refresh-persistence` | Full | Implemented | **Feasible** | Події трейсу зберігаються у PostgreSQL і не зникають після перезавантаження. |
| **T045** | Trace | `retry-events` | Full | Implemented | **Feasible** | Фіксація номерів повторних спроб (attempts) у метаданих подій. |
| **T046** | Trace | `approval-trace` | Full | Implemented | **Feasible** | Запит на схвалення та рішення людини потрапляють до tamper-evident audit log. |
| **T047** | Trace | `loop-no-progress` | Full | Implemented | **Feasible** | Зупинка зі статусом `loop_detected` при повторенні викликів без прогресу. |
| **T048** | Recovery | `provider-429` | Full | Implemented | **Feasible** | Fault-injection 429: виклик fallback моделі або повернення типізованої помилки 429. |
| **T049** | Recovery | `provider-502` | Full | Implemented | **Feasible** | Fault-injection 502: повернення 503 сервісу без зависання та без витоку ключів. |
| **T050** | Recovery | `provider-model-mismatch` | Full | Implemented | **Feasible** | Модель без native tool-calling адаптується через `ToolCallAdapter` (XML/JSON). |
| **T051** | Recovery | `terminal-timeout` | Full | Implemented | **Feasible** | Перевищення ліміту часу команди (120с) примусово завершує процес SIGKILL. |
| **T052** | Recovery | `worker-restart` | Full | Implemented | **Feasible** | Перезапуск воркера: `code-run-reconciler.ts` атомарно перехоплює завислий ран. |
| **T053** | Recovery | `duplicate-message` | Full | Implemented | **Feasible** | `idempotencyKey` запобігає створенню дублюючих ранів при повторному надсиланні. |
| **T054** | Recovery | `cancel-during-build` | Full | Implemented | **Feasible** | Скасування під час білду вбиває дочірні процеси та вивільняє слот черги. |
| **T055** | Recovery | `approval-denied` | Full | Implemented | **Feasible** | Відхилення схвалення користувачем: агент отримує відмову і продовжує план без дії. |
| **T056** | Recovery | `child-agent-resume` | Full | Implemented | **Feasible** | Виконання делегованого субагента з поверненням результату батьківському агенту. |
| **T057** | Recovery | `preview-crash` | Full | Implemented | **Feasible** | Падіння dev-сервера проекту повертає 502/503 та оновлює статус preview на stopped. |
| **T058** | Security | `project-isolation` | Full | Implemented | **Feasible** | Спроба читання/запису у `/projects/<otherProject>` блокується `safeProjectPath` та UID. |
| **T059** | Security | `tenant-boundary` | Full | Implemented | **Feasible** | Користувач Company A отримує 403/404 при спробі доступу до проектів/ранів Company B. |
| **T060** | Security | `path-traversal-denied` | Full | Implemented | **Feasible** | Шляхи виду `../../etc/passwd` або `%2e%2e%2f` відхиляються на рівні tool guard. |
| **T061** | Security | `approval-bypass-denied` | Full | Implemented | **Feasible** | Спроба агента схвалити власну дію блокується `userDecisionContext` (лише людина). |
| **T062** | Security | `secret-redaction` | Full | Implemented | **Feasible** | Токени й паролі у виводах маскуються `scanTextForSecrets` перед записом у трейс. |
| **T063** | Security | `sandbox-host-escape-denied` | Full | Implemented | **Feasible** | Запуск non-root користувачем, read-only rootfs та seccomp унеможливлюють доступ до хоста. |
| **T064** | Security | `fault-injection-prod-off` | Full | Implemented | **Feasible** | Тестові моки та ін'єкції збоїв жорстко заблоковані при `NODE_ENV=production`. |
| **T065** | Concurrency | `two-projects-parallel` | Full | Implemented | **Feasible** | Одночасний білд двох проектів у пісочниці без конфлікту портів чи файлів. |
| **T066** | Concurrency | `simultaneous-file-edits` | Full | Implemented | **Feasible** | Конфлікт ревізій файлу повертає 409 `revision_conflict`, запобігаючи перезапису. |
| **T067** | Concurrency | `orphan-cleanup` | Full | Implemented | **Feasible** | Reaper періодично зупиняє осиротілі процеси та очищує тимчасові файли. |
| **T068** | Concurrency | `budget-hard-stop` | Full | Implemented | **Feasible** | Зупинка рану при перевищенні ліміту токенів або 40 кроків зі статусом `max_steps`. |
| **T069** | Concurrency | `report-negative-fixture` | Full | Implemented | **Feasible** | Негативний фікстур-тест перевіряє коректне фіксування очікуваного Failed статусу. |

**Підсумок придатності матриці (69 сценаріїв):**
- **Feasible (здійсненні):** 69/69 сценаріїв мають повну підтримку в кодовій базі `agent-api`, `omniroute-adapter`, `workspace` та shared sandbox runner.
- **Blocked / Missing Environment (блоковані середовищем на момент Етапу 1):** Всі 69 тестів мають статус **Not Verified**, оскільки на Етапі 1 виконання заборонено за регламентом до завершення preflight checks та підтвердження користувачем.

---

## 4. Стратегія ізоляції та запобіжники проти production

### 4.1. Фізична та логічна недосяжність Production
1. **Ефемерні бази даних (PostgreSQL):**
   - Тестові раннери підключаються до локального пулу і створюють повністю ізольовану тимчасову БД із випадковим UUID:
     `npati_e2e_<uuid>`.
   - Застосовуються стандартні міграції, виконується тестовий прогін, і в блоці `finally` база примусово видаляється:
     `DROP DATABASE "npati_e2e_<uuid>" WITH (FORCE)`.
   - Жоден запит не йде до основної БД `npati_agent` чи продакшн-інстансів.
2. **Ізоляція файлової системи (Sandbox Workspaces):**
   - Усі тестові проекти використовують префікс `e2e-proj-<uuid>` та ізольований каталог у пісочниці: `/projects/e2e-proj-<uuid>`.
   - Жоден файл із реальних проектів не зчитується і не модифікується.
   - Очищення після кожного тесту видаляє створений каталог та вивільняє порт.
3. **Ефемерні облікові записи та токени:**
   - Генерація тимчасового користувача: `user:e2e-<uuid>` та тенанта `workspace:e2e-<uuid>`.
   - Підписання тестового JWT через `createMockNpatiJwt` з локальним секретом або використання `LocalDevAuthProvider`.
   - Заборонено використання production API-ключів або облікових записів адміністраторів без дозволу.
4. **Запобіжники в коді (Preflight Guards):**
   - Тестовий раннер відмовляється запускатися, якщо назва бази даних не містить префікса `test` або `e2e`.
   - Заборонено підключення до зовнішніх IP/доменів, крім локальних хостів `127.0.0.1`, `localhost` або Docker bridge мережі.
   - Перевірка `process.env.NODE_ENV !== "production"` fail-closed блокує будь-які тестові моки в бойовому режимі.

---

## 5. Пропонована архітектура E2E-раннера (для Етапу 2)

### 5.1. Вибір фреймворку
- **Рекомендований фреймворк:** **Vitest + Playwright** (уніфікований стек).
  - Vitest є стандартним тестовим фреймворком репозиторію (`vitest.config.ts`, Vitest v3.2.7), підтримує TypeScript, ESM, паралельний запуск та генерацію звітів у JSON/HTML.
  - Playwright (`playwright@1.63.0`) вже інтегрований у `browser-qa-runner.mjs` та використовується для UI-тестів інтерфейсу.
  - Каталог для E2E-раннера: `tests/coding-agent-e2e/` (або `tests/e2e/`).

### 5.2. Компоненти раннера
1. **PreflightGuard:** Перевірка доступності локального Docker, Shared Sandbox на `http://127.0.0.1:7865`, тестової БД PostgreSQL, та наявності тестових моделей у OmniRoute.
2. **EnvironmentFixtureManager:** Створення ефемерної БД, генерація JWT-токенів, виділення каталогу проекту, ініціалізація та гарантоване очищення (`runWithCleanup`).
3. **ScenarioRunner / SchemaValidator:** Завантаження декларативних сценаріїв за схемою з `SCENARIOS.md` (id, version, suite, preconditions, chat_steps, assertions, timeouts, cost_budget).
4. **AuthenticatedChatDriver:**
   - Робота через реальний HTTP/SSE API (`POST /chat/stream` або `POST /companies/:id/code/runs`).
   - Парсинг SSE-потоку в режимі реального часу, збір чанків `delta`, обробка подій `progress` та `result`.
5. **RunEventCollector:** Моніторинг статусу виконання через `GET /turns` та background stream із фіксацією монотонічних `seq`.
6. **ObjectiveAssertions:**
   - Перевірка файлів (наявність, sha256, зміст);
   - Перевірка компіляції та збірки (exitCode 0);
   - Перевірка доступності HTTP Preview (status 200 через `/preview/proxy/*`);
   - Браузерні assertions (Playwright DOM locators, стан кошика, пошук);
   - Трейс-перевірки (наявність подій у `code_activity_events`, валідація відсутності секретів).
7. **ReportWriter:** Запис результатів у форматі JSON (`artifacts/coding-agent-e2e-report.json`) та HTML у `test-results/coding-agent/`.

### 5.3. Бюджетні обмеження для тестових прогонів
- **Smoke Suite (E1, 5–10 тестів):**
  - Ліміт токенів: до 50 000 токенів на тест.
  - Ліміт часу: до 120 секунд на сценарій.
  - Орієнтовна вартість: < $0.05 на прогін.
- **Regression Suite (E3, 20–30 тестів):**
  - Ліміт часу: до 300 секунд на сценарій.
- **Concurrency & Rate Limit:** Максимум 2 паралельні тести для запобігання перевантаженню пісочниці.

---

## 6. Список Preflight Checks (Не запускалися в Етапі 1)

Перед переходом до Етапу 2 (E1 Smoke) необхідно виконати технічні перевірки готовності середовища:
1. `CHECK_DOCKER`: Доступність Docker daemon (`docker info` — підтверджено наявність Docker 29.4.0).
2. `CHECK_SANDBOX_RUNNER`: Перевірка стану контейнера `npati-isolated-source-20261011-sandbox-runner-1` на порті `7865` (`GET http://127.0.0.1:7865/health`).
3. `CHECK_POSTGRES_TEST_POOL`: Доступність локального підключення PostgreSQL для створення тестової бази даних `npati_e2e_*`.
4. `CHECK_OMNIROUTE`: Доступність локального OmniRoute на портах 20128/20129 та наявність підключеної тестової моделі.
5. `CHECK_SECRETS_REDACTION`: Перевірка роботи сканера секретів `code-secret-scanner.ts` на тестовому рядку перед першим запуском.
6. `CHECK_PORTS_FREE`: Перевірка вільності портів для preview та локального API.

---

## 7. Запитання та необхідні конфігурації від користувача перед Етапом 2

1. **AI Provider & Model для E2E Smoke:**
   - Чи використовувати локальну модель через запущений контейнер `omniroute` (наприклад, Ollama/Qwen/DeepSeek), чи надати тестовий API ключ (Anthropic / OpenAI / інший)?
2. **PostgreSQL для ефемерних баз:**
   - Чи використовувати існуючий тестовий контейнер `npati-isolated-source-20261011-postgres-1` (port 5432) для створення тимчасових БД `npati_e2e_*`?
3. **Запуск тестового API:**
   - Чи запускати `agent-api` локально на хості через `npm run dev:api` (або `buildApp` у пам'яті всередині Vitest процесу), чи надсилати запити до запущеного Docker-контейнера `npati-isolated-source-20261011-agent-api-1` (port 13001)?
   *(Рекомендовано: запуск `buildApp` всередині тест-процесу Vitest або виклик локального API для максимальної ізоляції та швидкості збирання покриття).*

---

## 8. Вердикт Етапу 1

- **Статус Етапу 1:** **COMPLETED** (Аудит кодової бази, картування матриці 69 сценаріїв, проектування архітектури E2E-раннера та заходи безпеки завершено).
- **Зміни продуктового коду:** 0 рядків змінено. Жодних продуктових фіксів не вносилося.
- **Готовність до Етапу 2:** Повна. Необхідне узгодження конфігурацій та підтвердження користувача.
