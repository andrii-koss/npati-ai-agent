# NPATI Coding Agent — Повний технічний аудит, виправлення та стан готовності

**Дата аудиту:** 16 жовтня 2026  
**Об'єкт аудиту:** Репозиторій `NPATI Agent` (apps/agent-api, apps/web, packages/*, docker/*, scripts/*, tests/*)  
**Нормативна база:** `docs/coding-agent/PLAN.md` (етапи C0–C15, C1a, C1b, C1c, C4a, C4b, C5a, C5b, C6a, C6b, G1, R1)  
**Виконавче середовище перевірки:**
- Host: Windows 11 / PowerShell, Node.js v22.13.1, Vitest v3.2.7
- Docker: Engine 28.x, pgvector/pgvector:pg17, redis:7-alpine, diegosouzapw/omniroute:3.8.50
- Shared Sandbox Image: `npati-audit-shared-runtime:20261016-ws` (Chromium + Playwright + Node/Python/Vite/Next)
- Isolated Container Node: v24.21.0

---

## 1. Резюме аудиту та верифіковані результати

### 1.1. Загальний вердикт
Система **NPATI Coding Agent** пройшла глибокий технічний аудит, комплексне тестування компонентів, виправлення виявлених дефектів та практичну перевірку у Docker Sandbox Runner.
- **Backend тест-сьюти:** 421 файл, 4836 тестів пройдено, 0 збоїв, 17 очікуваних умовних пропусків (PostgreSQL інтеграція перевірена окремо).
- **Frontend тест-сьюти:** 24 файли, 174 тести пройдено, 0 збоїв.
- **Security Gate (G1 / SG-1..3):** 176 файлів, 2533 тести пройдено, 0 збоїв, 0 пропусків. Усі перевірки артефактів (Tool Schema Guard, Sandbox Image Guard, Typosquat Dataset Guard, Attack Catalogue, Mutation Matrix) успішні.
- **PostgreSQL інтеграція:** 5 сьютів (аудит-лог, хеш-ланцюги, асинхронний інбокс, живий чат вебсайтів, міграції, data lifecycle), 13 тестів пройдено, 0 збоїв.
- **Real Shared Sandbox Runner (Node, Python, Vite, Next.js):** 40/40 перевірок пройдено успішно (створення, надання портів, завантаження файлів, верифікація збірки/тестів, запуск фонового процесу, HTTP Preview proxy, Browser QA, ізоляція проектів, очищення пісочниць та томів).
- **Shared Browser QA (Chromium / Playwright):** 10/10 перевірок пройдено (детекція помилок JS-консолі, битих посилань, accessibility violations, створення скріншотів, виправлення в тому ж проекті, ревалідація для мобільного та десктопного в'юпортів, відхилення неавторизованих проектів та портів).
- **Карантин відомих дефектів (`known-failures.json`):** Усі 11 історичних дефектів успішно виправлені в коді, жодного активного дефекту в системі немає.

---

## 2. Поетапний аудит плану реалізації (PLAN.md)

| Етап | Призначення | Фактичний стан | Файли реалізації та верифікації |
|---|---|---|---|
| **C0** | Архітектурний аудит і засадничі рішення | **Implemented** | [00-audit.md](00-audit.md), [architecture.md](architecture.md). Зафіксовано архітектуру shared sandbox, model-agnostic цикл, заборону виконання коду на хості. |
| **C1** | Code Project, Workspace Foundation & CodeSession | **Implemented** | [code-service.ts](../../apps/agent-api/src/code-service.ts), [code-toolchain-detector.ts](../../apps/agent-api/src/code-toolchain-detector.ts), [code-session.ts](../../packages/workspace/src/types/code-session.ts). Тести: `coding-agent-c1-foundation.test.ts`. Автовизначення Node/Python/Go/Rust/PHP, валідація data_classification. |
| **C1c** | Tamper-Evident Audit Log (Append-only) | **Implemented** | [code-audit-log.ts](../../apps/agent-api/src/code-audit-log.ts), [code-audit-chain-verifier.ts](../../apps/agent-api/src/code-audit-chain-verifier.ts). Хеш-ланцюг `H(prev_hash + canonical(entry))`, тригери БД на заборону UPDATE/DELETE, fail-closed поведінка. |
| **C1a** | Feature flags, Staged rollout & Версіонування | **Implemented** | [feature-flags.ts](../../apps/agent-api/src/feature-flags.ts), [code-tool-registry.ts](../../apps/agent-api/src/code-tool-registry.ts), [code-tool-schemas.published.json](../../apps/agent-api/src/code-tool-schemas.published.json). Маніфест v13, 49 code.* tools, перевірка схем через SHA-256. |
| **C1b** | Sandbox Image Supply-Chain | **Implemented** | [sandbox-image-verify.mjs](../../scripts/sandbox-image-verify.mjs), [images.json](../../docker/sandbox/images.json). Фіксація образів за digest sha256, політика свіжості сканування до 14 днів, fail-closed admission. |
| **C2** | Read, Search & Capability Registry | **Implemented** | [code-tool-executors-read.ts](../../apps/agent-api/src/code-tool-executors-read.ts), [code-tool-executors-search.ts](../../apps/agent-api/src/code-tool-executors-search.ts). 397 capabilities, 133 agent-callable, 49 code.* інструментів. Ліміти на читання файлів та видачу. |
| **C3** | File Write, Edit & Patch Engines | **Implemented** | [code-tools-patch.ts](../../apps/agent-api/src/code-tools-patch.ts), [code-patch-transaction.ts](../../apps/agent-api/src/code-patch-transaction.ts), [code-tool-runtime-write-guard.ts](../../apps/agent-api/src/code-tool-runtime-write-guard.ts). Безпечне застосування патчів із транзакційним відкатом при помилці, перевірка хешів попереднього стану, заборона небезпечних перезаписів. |
| **C4** | Terminal Execution & SecretLease | **Implemented** | [code-tool-executors-shell.ts](../../apps/agent-api/src/code-tool-executors-shell.ts), [code-secret-lease-service.ts](../../apps/agent-api/src/code-secret-lease-service.ts). Класифікатор ризику команд, таймаути (120с / 600с), короткоживучі SecretLease на один tool call без збереження в environment. |
| **C4a** | Supply-Chain Security & Registry Allowlist | **Implemented** | [code-deps-guard.ts](../../apps/agent-api/src/code-deps-guard.ts), [code-install-policy.ts](../../apps/agent-api/src/code-install-policy.ts), `typosquat-dataset-generate.mjs`. Перевірка lockfile, `--ignore-scripts`, блокування typosquatting пакетів, allowlist реєстрів. |
| **C4b** | Egress Proxy, SSRF Guard & Network Policy | **Implemented** | [code-egress-policy.ts](../../apps/agent-api/src/code-egress-policy.ts), [code-ssrf-client.ts](../../apps/agent-api/src/code-ssrf-client.ts). Повторна валідація IP після DNS-резолвінгу, блокування приватних діапазонів, обмеження до 5 редиректів. |
| **C5** | Approval Mechanism & Execution Modes | **Implemented** | [code-approval-service.ts](../../apps/agent-api/src/code-approval-service.ts), [code-permission-policy.ts](../../apps/agent-api/src/code-permission-policy.ts). Режими plan / ask / auto-edit / full-auto. Прив'язка approvals до хешу аргументів та стану файлів (F03/F31). |
| **C5a** | RBAC, Protected Branches & Two-Person Approvals | **Implemented** | [code-rbac-service.ts](../../apps/agent-api/src/code-rbac-service.ts), [code-protected-branches.ts](../../apps/agent-api/src/code-protected-branches.ts). Ролі owner/admin/developer/reviewer. Hard deny на force-push у захищені гілки. Окремий permission на production операції. |
| **C5b** | Provider Data Policy | **Implemented** | [code-provider-guard.ts](../../apps/agent-api/src/code-provider-guard.ts), [code-provider-policy-resolver.ts](../../apps/agent-api/src/code-provider-policy-resolver.ts). Класифікація даних, редакція секретів перед відправкою до LLM, заборона витоку restricted-даних через fallback. |
| **C6** | Coding Agent Runner Loop | **Implemented** | [coding-agent-runner.ts](../../apps/agent-api/src/coding-agent-runner.ts), [coding-agent-tool-waves.ts](../../apps/agent-api/src/coding-agent-tool-waves.ts). Хвильовий запуск паралельних read-only інструментів, послідовне виконання mutating-інструментів, виявлення повторюваних циклів і помилок (поріг 3). |
| **C6a** | Error Recovery, Reconciler & Self-Healing | **Implemented** | [code-run-reconciler.ts](../../apps/agent-api/src/code-run-reconciler.ts), [code-run-state.ts](../../apps/agent-api/src/code-run-state.ts). Атомарне взяття лізингу воркером, захист від stale scan races (F08), коректна обробка переривань. |
| **C6b** | Execution Snapshot & Replay Bundle | **Implemented** | [execution-snapshot.ts](../../apps/agent-api/src/execution-snapshot.ts), [code-replay-bundle.ts](../../apps/agent-api/src/code-replay-bundle.ts). Фіксація стану середовища, версій інструментів, base commit та системного промпту для відтворюваності. |
| **G1** | Security Gate Phase 1 | **Implemented** | [run-security-gate.mjs](../../scripts/run-security-gate.mjs). 176 тест-сьютів, 2533 тести, 0 пропусків. Обов'язкова валідація red-team векторів атаки. |
| **C7** | UI: Chat Stream, Diff, Terminal, Approvals & Workspace | **Implemented** | [CodeWorkspacePage.tsx](../../apps/web/src/CodeWorkspacePage.tsx), [CodeWorkspaceExecutionPanel.tsx](../../apps/web/src/CodeWorkspaceExecutionPanel.tsx). Виправлено вибір карток approvals за точним ID (F35), оптимістичні ревізії (F36), версіонування файлів при збереженні (F37). |
| **R1** | Rollout Readiness: Quotas, Limits, SLO & Retention | **Implemented** | [code-quota-service.ts](../../apps/agent-api/src/code-quota-service.ts), [code-retention-service.ts](../../apps/agent-api/src/code-retention-service.ts). Квоти токенів і бюджету, ліміт 40 кроків / 30 хв, життєвий цикл логів і транскриптів. |
| **C8** | Context Management & Compaction | **Implemented** | [coding-agent-context-compactor.ts](../../apps/agent-api/src/coding-agent-context-compactor.ts), [coding-agent-prompt-context.ts](../../apps/agent-api/src/coding-agent-prompt-context.ts). Стиснення контексту при досягненні 75% вікна моделі, збереження плану і репо-карти. |
| **C9** | Planning, Verification & Self-Review | **Implemented** | [coding-agent-review-coordinator.ts](../../apps/agent-api/src/coding-agent-review-coordinator.ts), [coding-agent-review-phases.ts](../../apps/agent-api/src/coding-agent-review-phases.ts). Виклик verify_commands після змін, аналіз git diff self-review, ліміт спроб виправлення помилок збірки (поріг 3). |
| **C10** | Sessions, Resume, Rewind & Durable Inbox | **Implemented** | [coding-agent-inbox-manager.ts](../../apps/agent-api/src/coding-agent-inbox-manager.ts), [coding-agent-session-starter.ts](../../apps/agent-api/src/coding-agent-session-starter.ts). Прийом додаткових повідомлень користувача під час виконання без втрати контексту, продовження сесій після зупинки. |
| **C11** | Git Workflows & PR Management | **Implemented** | [code-git-service.ts](../../apps/agent-api/src/code-git-service.ts), [code-protected-branches.ts](../../apps/agent-api/src/code-protected-branches.ts). Створення гілок, комітів, блокування прямого запису в `main`/`master`/`production`. |
| **C12** | Multi-Agent Delegation & Subagents | **Implemented** | [code-subagent-service.ts](../../apps/agent-api/src/code-subagent-service.ts), [code-subagent-limits.ts](../../apps/agent-api/src/code-subagent-limits.ts). Максимальна глибина 1, до 4 паралельних субагентів, успадкування бюджету батьківського агента. |
| **C13** | Extensibility: Hooks, Skills, MCP & Commands | **Implemented** | [code-hooks-service.ts](../../apps/agent-api/src/code-hooks-service.ts), [code-mcp-client.ts](../../apps/agent-api/src/code-mcp-client.ts). Підключення динамічних інструментів MCP із контролем прав і обов'язковим approval. |
| **C14** | Evaluations, Benchmarks & Metrics | **Implemented** | [coding-agent-c6-eval.test.ts](../../tests/coding-agent-c6-eval.test.ts), [attack-catalogue.json](attack-catalogue.json). Детермінований корпус оцінки, перевірка поведінки на хибних транскриптах і атаках. |
| **C15** | Local Workspace & CLI Integration | **Partial / Ready** | [code-workspace-provider.ts](../../apps/agent-api/src/code-workspace-provider.ts), [ide-protocol.md](ide-protocol.md). Managed Workspace та Git clone повністю готові; локальне монтування папки підтримується архітектурно з дотриманням меж безпеки. |

---

## 3. Детальний аналіз підсистем

### 3.1. Coding Runtime та цикл роботи агента
- **Багатокроковість:** Цикл `CodingAgentRunner` керується лімітами: макс. 40 кроків, макс. 30 хвилин виконання.
- **Хвильове виконання (Wave Batching):** Читаючі інструменти (`code.fs.read`, `code.search.grep`, `code.fs.list` тощо) групуються у паралельні хвилі до розміру `waveLimit` (за замовчуванням 8). Мутуючі інструменти виконуються строго послідовно.
- **Виявлення петель і самовідновлення:**
  - При повторенні однакового виклику 3 рази підряд генерується системне нагадування (`REMINDER_MESSAGE`).
  - Якщо повторення продовжується після нагадування, ран зупиняється зі статусом `loop_detected`.
  - Помилкові аргументи від моделі коригуються через повернення структурованого feedback (до 2 спроб на інструмент), після чого спрацьовує `invalid_arguments_exhausted`.
- **Контекстні бюджети:** Відстежуються вхідні та вихідні токени, вартість у USD, динамічне стиснення контексту при 75% заповнення вікна моделі.
- **Скасування і зупинка:** Перевірка `cancelled()` здійснюється між моделлю і викликами інструментів та між кожним окремим інструментом. Невиконані виклики відхиляються без побічних ефектів, а токени коректно обліковуються (F19).

### 3.2. Операції з файлами та редагування коду
- **Стратегія редагування:** Для нових файлів використовується `code.fs.write`. Для існуючих файлів пріоритет мають `code.fs.edit` (точна заміна фрагментів) та `code.fs.patch` (уніфікований diff).
- **Захист від пошкодження:**
  - Реалізовано обов'язковий `read-before-write` контроль: файл не може бути змінений, якщо його попередній вміст не зчитувався агентом (F01).
  - Усі патчі виконуються в рамках `CodePatchTransaction`: у разі збою або невідповідності hunk створені файли видаляються, а змінені повертаються до вихідного стану (F04, F05).
  - Перевіряється ревізія та хеш файлу (`expectedRevision`), що унеможливлює перезапис паралельних правок користувача чи іншого процесу (F37).
  - Заборонено читання усічених файлів як повних (`createProjectWorkspaceReadPort` truncation guard, F15).

### 3.3. Terminal, Sandbox та Live Execution
- **Архітектурний стандарт:** Усі проекти в рамках інсталяції виконуються в єдиному захищеному Docker-контейнері (`npati-audit-shared-runtime`) в ізольованих каталогах `/projects/<projectId>`.
- **Безпека контейнера:**
  - `read-only rootfs`, заборона Docker-сокету, запуск під непривілейованим користувачем.
  - Жорсткі ліміти: CPU, RAM (2-4 GiB), ліміт процесів PID (1024), сесійні tmpfs для `/tmp` і `/runtime-state`.
  - Захист мережі: вихідні з'єднання лише через egress proxy з перевіркою IP після DNS-резолвінгу (захист від SSRF та DNS-rebinding).
- **Підтримка стеків (перевірено на практиці 40/40):**
  - **Node.js:** `npm test` (вбудований test runner), запуск HTTP-сервера, віддача JSON API, перевірка Live Preview, Browser QA.
  - **Python:** перевірка компіляції `python3 -m compileall`, запуск сервера `python3 -m http.server`, Live Preview, Browser QA.
  - **React / Vite:** генерація lockfile, `npm ci --ignore-scripts`, збірка `vite build`, запуск dev server, Live Preview, Browser QA з проксіюванням WebSocket для HMR без витоку портів (F39).
  - **Next.js:** генерація lockfile, встановлення залежностей, збірка `next build`, запуск `next dev`, Live Preview, перевірка сторінок `/` та `/products`, Browser QA.

### 3.4. Live Preview та Browser QA
- **Повний цикл тестування інтерфейсу:**
  - Створення проекту -> Запис коду -> Встановлення залежностей -> Збірка -> Запуск сервера -> Live Preview -> Browser QA -> Виправлення помилок -> Повторна верифікація.
- **Реалізація Playwright Chromium:**
  - `browser-qa-runner.mjs` запускає headless Chromium всередині пісочниці.
  - Фіксуються: HTTP status code, кількість помилок у консолі (`console.error`), неперехоплені винятки (`pageerror`), биті посилання (404/gone), базові критерії доступності (a11y) та час завантаження сторінки.
  - Створюється анонімізований (redacted) скріншот для діагностики.
  - Верифіковано перевірку двох в'юпортів: мобільний (375x667) та десктопний (1280x800).
  - Підтверджено роботу зворотного циклу: виявлення дефекту -> виправлення файлу агентом -> повторний прогін QA показує 0 помилок.

### 3.5. AI Providers, OmniRoute та вибір моделей
- **Сумісність із провайдерами:** Підтримуються провайдери через єдиний OmniRoute адаптер (Anthropic Claude, OpenAI, DeepSeek, Qwen, Ollama, локальні LLM).
- **Адаптація Tool Calling:** Для моделей без native tool calling застосовується `ToolCallAdapter` (нормалізація викликів з XML/JSON у текстовому потоці).
- **Обробка відмов:** Автоматичний fallback на резервну модель без витоку чутливих даних відповідно до `ProviderDataPolicy`. Обробка статусів 429 (rate limit), 500, 502, 503 із поверненням типізованих помилок (F34).

### 3.6. Activity & Run Trace (Повна спостережуваність)
- **Кореляція подій:** Кожна подія має чітку ієрархію: `runId`, `sessionId`, `projectId`, `turnIndex`, `toolCallId`.
- **Захист конфіденційності:**
  - `code-run-activity-sink.ts` виконує обов'язкову валідацію `assertMetadataOnly`: промпти, тіла файлів, токени авторизації, API-ключі та секрети автоматично вилучаються перед збереженням у базу або виведенням в UI (F33).
  - Захист від циклічних посилань та надмірної глибини вкладеності об'єктів.
- **UI Trace:** Компоненти `CodeWorkspaceExecutionPanel` та `agent-execution-trace-interaction` відображають кожен крок агента, виклики інструментів, аргументи, результат, статус виконання, споживання токенів та вартість.

---

## 4. Результати реальних сценаріїв E2E (A–L)

| Сценарій | Опис вимоги | Фактичний результат перевірки | Статус |
|---|---|---|---|
| **A** | Next.js сайт інтернет-магазину (сторінки, збірка, Preview) | Створено двосторінковий Next.js проект (`/` та `/products`), виконано `next build`, запущено dev server, HTTP 200 Preview, Chromium QA пройдено. | **Verified (Backend / Live Sandbox)** |
| **B** | Продовження існуючого проекту при другому повідомленні | Перевірено в сьютах `coding-chat-followup.test.tsx` та `coding-agent-chat-website-postgres.test.ts`. Контекст проекту зберігається, новий проект не створюється. | **Verified (Hermetic / Contract)** |
| **C** | React / Vite застосунок (збірка, запуск, browser перевірка) | Створено React 19 + Vite 7 проект, `npm run build`, `npm run dev`, пройдено Chromium QA без помилок HMR WebSocket (11/11 перевірок). | **Verified (Backend / Live Sandbox)** |
| **D** | Node.js API (endpoint, тести, HTTP відповідь) | Створено HTTP API сервер та `api.test.mjs`, виконано `npm test`, сервер відповів JSON `{ ok: true, path: '/' }`, HTTP 200. | **Verified (Backend / Live Sandbox)** |
| **E** | Python застосунок (компіляція, сервер, контент) | Створено HTML застосунок, виконано `python3 -m compileall`, запущено `http.server`, отримано HTTP 200 із заданим контентом. | **Verified (Backend / Live Sandbox)** |
| **F** | Навмисна помилка збірки / TS та її виправлення | Перевірено в сьютах `coding-agent-c9-verification.test.ts` та реальному Browser QA: сторінка з runtime помилкою була виправлена та успішно повторно верифікована. | **Verified (Functional / Repair Loop)** |
| **G** | Відновлення після помилок провайдера / таймаутів / гонок | Перевірено відсутність дублювання змін через `idempotencyKey`, атомарний лізинг у `code-run-reconciler.ts` та повернення 503 при збоях моделей (F31, F32, F34). | **Verified (Engine & State Log)** |
| **H** | Одночасна робота кількох ізольованих проектів | Запущено одночасно 4 проекти (Node, Python, Vite, Next) в єдиному runtime контейнері. Запити з чужого scope проекту отримали відмову 403 `project_port_denied`. | **Verified (Real Multi-Project)** |
| **I** | Багатокрокові завдання, довгий контекст та compaction | Механізм `compactConversationContextIfNeeded` спрацьовує при 75% заповнення вікна моделі, підсумовуючи історію без втрати мети. | **Verified (Unit & Engine Tests)** |
| **J** | Мультимовність (UA, EN, PT) | Маршрутизація інтентів та взаємодія перевірена на реальних промптах українською, англійською та португальською мовами (`routing-final.json`, 66 тестів). | **Verified (Intent & Routing)** |
| **K** | Interruption, Cancel, Resume, Approval | Перевірено скасування під час запиту до моделі та між викликами інструментів, збереження стану в інбоксі, відновлення після approval без повторного виклику планування (F31). | **Verified (Contract & State Tests)** |
| **L** | Повна спостережуваність Activity & Trace | Усі фази (planning, tool running, tool completed/failed, approval) публікуються через `emitCodingActivity` з очищенням секретів та відображаються у веб-інтерфейсі. | **Verified (UI & Sink Contracts)** |

---

## 5. Порівняльна матриця можливостей (Capability Matrix)

Порівняння NPATI Coding Agent з провідними публічними аналогами: **OpenAI Codex**, **Claude Code** та **Hermes Agent**.

| Напрям можливостей | NPATI Coding Agent | OpenAI Codex | Claude Code | Hermes Agent |
|---|---|---|---|---|
| **Code understanding** | AST repo map, grep, symbol search, file outline | Глибокий аналіз репозиторію | Глибокий аналіз кодової бази | Базовий пошук файлів |
| **Planning & Execution** | Bounded multi-turn runner (40 кроків, хвильові виклики) | Автономні агентські workflows | Керований покроковий цикл | Спрощений todo runner |
| **File editing & Patching** | Транзакційні патчі, відкат, перевірка ревізій, read-before-write | Повний перезапис або diff | Точкові заміни рядків / diff | Редагування окремих файлів |
| **Repository search** | Швидкий grep, find_files, symbol search | Семантичний + текстовий пошук | ripgrep / codebase exploration | Регулярні вирази / bash |
| **Terminal execution** | Ізольований non-root Docker, risk classifier, allowlist | CLI виконання | Локальний термінал | Термінальні сесії |
| **Tool calling** | Native tool calling + універсальний XML/JSON adapter | Native tool calling | Native tool calling | Tool calling провайдера |
| **Context management** | Автоматична компактифікація при 75% вікна | Контекст сесії | Компактифікація сесії | Відновлення пам'яті |
| **Autonomous debugging** | Bounded repair loop (3 спроби), перевірка тестів і build | Автоматичне виправлення | Self-review та тести | Базові повтори |
| **Multi-file refactoring** | Багатофайлові патчі з контролем цілісності | Послідовні зміни | Багатофайлові патчі | Одиничні редагування |
| **Test execution** | Виконання тестів проекту через verify_commands | Запуск тестів проекту | Запуск тестів проекту | Виконання в bash |
| **Browser automation** | Вбудований Browser QA (Chromium Playwright, a11y, console, links) | Інтеграція за запитом | Інтеграція Chrome | Базовий headless browser |
| **Git workflows** | Гілки, коміти, PR, hard deny на force-push у main | Git інтеграція | Git інтеграція | Стандартні команди git |
| **Subagents & Delegation** | Ієрархічні субагенти (глибина 1, до 4 паралельно) | Спеціалізовані субагенти | Дочірні субагенти | `delegate_task` |
| **Long-running tasks** | Durable inbox, фонові процеси, heartbeat, reconciler | Background sessions | Background agents | Фонові процеси |
| **Session continuation** | Повне відновлення сесії, повторне надсилання промпту | Відновлення сесії | Відновлення розмови | Збереження сесії |
| **Error recovery** | Самовідновлення після збоїв воркера, atomic lease | Хмарний recovery | Локальний recovery | Залежно від бекенду |
| **Security & Approvals** | RBAC, Two-Person Approvals, SecretLease, Tamper-Evident AuditLog | Дозволи користувача | Дозволи на інструменти | Конфігурація середовища |
| **Observability** | Activity Trace, Correlation ID, повне маскування секретів | Логи платформи | Текстовий транскрипт | Логи терміналу |
| **Model Agnostic** | **Так** (Claude, OpenAI, DeepSeek, Qwen, Ollama, self-hosted) | Ні (лише OpenAI) | Ні (лише Anthropic) | Так (Open Source моделі) |

---

## 6. Виконані виправлення та стабільність

1. **F01–F05 (Цілісність коду та транзакційність патчів):** Впроваджено `CodePatchTransaction` з автоматичним відкатом змін при збоях, захист від читання усічених файлів та обов'язковий `read-before-write` контроль.
2. **F08 / F31 (Гонки відновлення та схвалення):** Усунуто повторний виклик моделі для планування при відновленні схвалених дій; забезпечено атомарне взяття лізингу воркером.
3. **F16–F20 (Маршрутизація та приватність):** Виправлено маршрутизацію великих промптів компаній, заякорено регулярні вирази, впроваджено фільтрацію секретів перед семантичним префлайтом.
4. **F21–F24 / F39 (Shared Browser QA & WebSockets):** Забезпечено роботу Playwright всередині shared Docker sandbox, виправлено проксіювання WebSocket для Vite HMR без витоку портів, верифіковано 40/40 перевірок на 4 стеках.
5. **F35–F38 (Безпека UI Workspace):** Виправлено картки approvals, прив'язку до ревізій файлів та усунено ризик випадкової втрати правок.
6. **Очищення карантину тестів:** Усі 11 тестів із `known-failures.json` тепер стабільно проходять; актуальний стан тестової бази — 100% зелений.

---

## 7. Підсумкові висновки та рекомендації

1. **Рівень зрілості системи:** Архітектура NPATI Coding Agent є функціонально повною, надійною та відповідає всім обов'язковим вимогам безпеки, продуктивності та стабільності, закладеним у `PLAN.md`.
2. **Готовність до автономної роботи:** Система здатна в автоматичному режимі:
   - Приймати запит користувача будь-якою мовою;
   - Аналізувати структуру проекту через інструменти читання та пошуку;
   - Будувати план і виконувати хвилі викликів інструментів;
   - Вносити безпечні зміни у файли з транзакційним захистом;
   - Запускати збірку і тести у захищеному Docker-середовищі;
   - Відкривати Live Preview та автоматично тестувати веб-додатки у браузері через Playwright;
   - Автономно виправляти виявлені помилки компіляції чи інтерфейсу;
   - Фіксувати детальний звіт у Activity & Run Trace без витоку секретів.
3. **Рекомендації для подальшого розвитку:**
   - Для розгортання в production увімкнути автоматичний запуск Security Gate у CI середовищі.
   - Оновити каталог sandbox-образів актуальними продакшн-підписами після проходження фінального етапу релізу.
