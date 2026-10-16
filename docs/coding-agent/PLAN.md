# NPATI Coding Agent (harness): покрокові промти C0-C15 (версія 4: + C1a, C1b, C1c, C4a, C4b, C5a, C5b, C6a, C6b, G1, R1)

Це третій план, після Website Builder (кроки 0-11) і Data Studio (D0-D7). Мета: щоб агент NPATI міг читати, писати й змінювати код, запускати команди та перевіряти результат, як це роблять Claude Code, Codex та подібні системи, але на ваших моделях (AI Providers) і всередині існуючої архітектури Company / Capabilities / Runs / Activity.

> Audit checkpoint, 2026-10-15: [implementation repairs and actual limits](2026-10-15-full-system-audit.md),
> [431-entry source inventory](2026-10-15-plan-inventory.md), and
> [verification results](2026-10-15-verification-results.md). This plan is a specification, not a completion ledger.
> Continuation 2026-10-16: F16–F20 repair Company/Business intent, routing privacy, large prompts and cancellation accounting; see the updated report and verification evidence.
> Continuation F25-F38: imported migration checks, bounded preflight cancellation/leases, attachment/onboarding routing native API compatibility, saved-plan approval resume and independent keyed business creation, Activity payload privacy and typed runtime HTTP errors and actual Workspace approval/mode/file revision controls repaired; focused evidence remains distinct from autonomous E2E.
> Architecture reaffirmed 2026-10-16: all sites in this installation share ONE sandbox container in separate /projects/<projectId> folders; per-project logical IDs do not imply containers. F39 fixes project-scoped Browser QA WebSockets; real Vite 11/11 and sequential four-stack 40/40 pass with project/container/volume cleanup. Complete acceptance still requires the remaining evidence.
> Checkpoint F40: real PostgreSQL migrations/audit/inbox/chat-edit/retention checks passed 13/13 after repairing DB-only fixture prerequisites. Hermetic backend passed 4836 with 17 existing conditional skips; frontend 174 and fixed gate 2533 passed. None of these marks the full 431-entry plan or autonomous A-L complete.
> Full acceptance remains open. Real shared-runtime Node/Python/Vite/Next commands, builds and HTTP Preview were
> exercised. Shared Browser QA was implemented on 2026-10-16; real fixture detection, file repair and two-viewport QA passed in a temporary runtime. Autonomous scenarios A–L, mandatory
> automatic CI, production image admission and deployment crash/recovery certification are not marked complete.
> The shared/self-hosted runtime decision in `docs/website-builder/SHARED_PROJECT_RUNTIME.md` supersedes assumptions
> about one Docker container per project. Current self-hosted flag defaults also differ from the original dark-launch
> specification. This audit preserves the configured self-hosted defaults. Published tool schemas/checksums are preserved.

Як користуватися:

1. Кожен крок запускайте окремою сесією кодувального агента.
2. На початку кожного кроку вставляйте **Спільний блок правил** і потім текст кроку.
3. Не переходьте далі, поки не виконані критерії приймання поточного кроку.
4. Після C0 перегляньте аудит і за потреби відкоригуйте наступні промти.

## Зміни у версії 2 (обов'язкові додатки)

Нумерація C0-C15 збережена. Додані чотири кроки та наскрізні правила:

- **C1a** Feature flags, staged rollout, rollback без змін схеми/коду, версіонування `code.*` tools і API.
- **C4a** Supply-chain security: install policy, lockfiles, package scripts, dependency/secret scanning.
- **C6a** Recovery, cleanup, rollback невдалих змін, безпечна обробка DB migrations.
- **G1** Security gate Phase 1: мінімальний red-team набір (sandbox escape, secret leak, path traversal, approval bypass) обов'язковий до виходу Phase 1. Тести з тегом `security-gate` накопичуються з C2 і запускаються на контрольних точках SG-1 (після C4/C4a), SG-2 (після C5), SG-3 (після C6/C6a) і G1 (після C7).
- Оновлені: таблиця складових, ключові рішення, ліміти, спільний блок правил (правила 9 і 12-16), C0, C14 (тепер розширює G1), фази, відкриті питання, чекліст регресії.

## Зміни у версії 3 (наскрізні вимоги: RBAC, snapshot, образи, мережа, дані, провайдери, ліміти)

- **C1b** Sandbox image supply-chain: образи за digest, SBOM, scan, підпис, admission control.
- **C4b** Egress enforcement: proxy/firewall з перевіркою після DNS-резолву, редиректів, захист від SSRF і DNS-rebinding (реалізація, а не лише тести).
- **C5a** RBAC: ролі owner/admin/developer/reviewer, хто що може, окремий permission і two-person approval для production-операцій.
- **C5b** Provider data policy: що і якому AI Provider дозволено надсилати, classification, redaction, caching, routing з урахуванням політики.
- **C6b** Versioned execution snapshot: policy/model profile/runner/sandbox image digest/flags/base commit для кожного run.
- **R1** Rollout readiness: ліміти, черги, квоти, observability, SLO/alerts і data lifecycle (retention, export/delete). Обов'язковий разом із G1 перед виходом за internal.
- Оновлені: таблиця складових, ключові рішення, ліміти, спільний блок (нові правила 17-21), C0, C1a, C5, C6, G1 (нові покриття), C14, фази, відкриті питання, чекліст.

## Зміни у версії 4 (виправлення суперечностей перед заморожуванням плану)

- **C6 і C6b:** у C6 лише інтерфейс `ExecutionSnapshotProvider` із заглушкою `NullSnapshotProvider`, реалізація в C6b. Replay: deterministic лише з recorded/mock provider і recorded tool results, live replay це best-effort reproducibility.
- **C1:** явні поля `data_classification` і `retention_class` для проєкту, сесії та інших сутностей.
- **Захищені гілки:** force push і пряма запис агентом у захищені гілки це hard deny для всіх, включно з owner (C4, C5, C5a, C11). Політику гілок змінює лише owner окремою адміністративною дією з аудитом.
- **Ступені готовності:** C7 = feature complete, G1 = security ready, R1 = production/rollout ready, Phase 1 complete лише після R1.
- **Вимкнений flag (C1a):** створення сесій, run, tools і approvals блокуються, а History, Activity, Changes, Export і Delete лишаються read-only.
- **SecretLease (C4):** секрети лише короткоживучі, на один tool call, з відкликанням; не успадковуються наступними процесами.
- **C1c:** tamper-evident AuditLog (append-only, хеш-ланцюг, payload_hash, fail closed) для привілейованих подій.
- **Залежності вперед:** посилання на майбутній крок означають інтерфейс/конфігурацію, а не реалізацію (нове правило 24). Додатково виправлено: зміна flags у C1a до C5a (існуюча роль власника), розширення allowlist у C4b до C5/C5a (лише конфігурація оператора), force push у переліку production-операцій C5a.

## Що таке harness і що саме ми будуємо

Якість coding-агента залежить не лише від моделі, а й від «обв'язки» навколо неї. Складові:

| Складова | Що робить | Кроки |
|---|---|---|
| Інструменти | read, grep, edit, patch, shell, git | C2-C4 |
| Політика дозволів | режими plan / ask / auto-edit / full-auto, approvals | C5 |
| Цикл агента | модель -> tool calls -> результати -> повтор до завершення | C6 |
| Інтерфейс | чат-стрім, diff, термінал, approvals | C7 |
| Керування контекстом | інструкції проєкту, repo map, стиснення розмови | C8 |
| Планування і перевірка | plan mode, todo, тести, self-review | C9 |
| Сесії | resume, rewind, фонові задачі | C10 |
| Git і PR | гілки, коміти, pull request | C11 |
| Субагенти | explore / plan / implement / review | C12 |
| Розширення | hooks, slash commands, skills, MCP | C13 |
| Оцінка і безпека | evals, red-team, метрики | C14 |
| Локальний режим | змонтована папка, CLI, IDE | C15 |
| Образи sandbox | pin за digest, SBOM, scan, підпис, admission | C1b |
| Мережа | egress proxy/firewall, SSRF, DNS-rebinding | C4b |
| RBAC | ролі, production-permission, two-person approval | C5a |
| Політика даних провайдерів | classification, redaction, routing | C5b |
| Execution snapshot | відтворюваність і пояснюваність run-ів | C6b |
| Rollout readiness | ліміти, SLO, retention, export/delete | R1 |
| Tamper-evident audit | AuditLog, хеш-ланцюг, fail closed | C1c |
| Секрети в sandbox | SecretLease на один tool call | C4 |
| Rollout і версіонування | feature flags, staged rollout, версії tool schemas | C1a |
| Supply-chain | політика install, lockfiles, скани залежностей | C4a |
| Recovery | відновлення, cleanup, rollback, безпечні міграції БД | C6a |
| Security gate | обов'язковий gate Phase 1 | G1 |

## Ключові рішення архітектури (зафіксовані)

- **Не окремий продукт.** Coding Agent це режим існуючих агентів Company (Main Agent, спеціалісти) з новою групою capabilities `code.*`. Він використовує Runs, Activity, Approvals, Capability Inspector, AI Providers, Memory, Skills.
- **Перевикористання Website Builder.** Project, Workspace, Sandbox, Files, Terminal, Git, Checkpoints, Preview розширюються, а не дублюються. Website Builder стає окремим випадком code-проєкту. Якщо щось із цього ще не реалізовано, це робиться в C1-C4 з розрахунком на обидва сценарії.
- **Власний цикл агента в NPATI**, а не обгортка над CLI Claude Code чи Codex. Він model-agnostic через AI Providers. Опційно в C15 можна додати адаптер зовнішніх CLI-агентів для користувачів з власними ключами.
- **Код виконується лише в sandbox.** Основний сервер NPATI не запускає код, створений AI.
- **Де живе код:** `WorkspaceProvider` з варіантами managed workspace, git clone і (пізніше, C15) змонтована локальна папка. Доступ до локальної файлової системи лише до явно змонтованих каталогів.
- **Надійність редагування.** Основні інструменти: `edit` (точна заміна фрагмента) і `apply_patch`. Повний перезапис файлу лише для нових файлів. Формат редагування обирається профілем моделі.
- **Профілі моделей.** Різні моделі (Claude, OpenAI, DeepSeek, локальні) по-різному викликають інструменти. Поведінка (режим tool calling, формат редагування, ліміти) задається конфігурацією, а не if-ами в коді.
- **Усе через capability registry.** Жодних прихованих інструментів поза ним.
- **Eval з самого початку.** Без набору автоматичних тестів неможливо виміряти, чи harness покращується.
- **Репозиторії і веб-вміст ненадійні.** Інструкції з клонованого репозиторію чи сторінки не можуть змінювати режим дозволів агента.
- **Не копіювати чужий код.** Claude Code пропрієтарний. Використовуйте патерни і ідеї. Відкриті harness-проєкти (наприклад Codex CLI, Aider, OpenHands, Cline, OpenCode) можна вивчати як референс, але ліцензії перевіряються в C0 перед будь-яким запозиченням коду.
- **Поетапний випуск.** Coding Agent вимкнений за замовчуванням і вмикається flags для окремих користувачів/Company. Rollback = вимкнення flag без змін схеми чи коду (C1a). Усі міграції схеми адитивні.
- **Версіоване API tools.** `code.*` tools і API версіонуються; CodeSession фіксує manifest версій, тому старі сесії й run-и не ламаються (C1a).
- **Supply-chain за замовчуванням безпечний.** Lockfiles, install без lifecycle scripts, мережа вимкнена на фазі build, перевірка нових пакетів, audit і secret scanning (C4a).
- **Відновлюваність.** Стан run зберігається як event-log, є reconciler, reaper, rollback і безпечна обробка DB migrations (C6a).
- **Security gate.** Набір тестів безпеки росте з кожним кроком і є обов'язковим gate для Phase 1; без нього flags не просуваються за internal (G1).
- **RBAC.** Ефективні права = перетин capability groups агента, ролі користувача і правил проєкту. Агент ніколи не є approver. Production-операції мають окремий permission і за потреби two-person approval (C5a).
- **Політика даних провайдерів.** До моделі йдуть лише дані, дозволені ProviderDataPolicy проєкту; fallback не може її обійти (C5b).
- **Execution snapshot.** Кожен run прив'язаний до незмінного знімка середовища, політик, версій і base commit (C6b).
- **Образи і мережа.** Sandbox запускається лише з перевіреного образу за digest (C1b); мережа лише через egress proxy з перевіркою після DNS (C4b).
- **Rollout readiness.** Вихід за internal лише після G1 і R1 (ліміти, SLO, retention) (R1).
- **Захищені гілки.** Force push і пряма запис агентом у захищені гілки заборонені для всіх (hard deny). Зміни лише через PR/merge людиною; політику гілок змінює owner адміністративною дією поза сесією агента (C5a, C11).
- **Секрети.** До sandbox потрапляють лише як SecretLease на один tool call (scoped, TTL, відкликання), не у persistent shell environment. Production-credentials агенту не видаються (C4).
- **Аудит.** Привілейовані дії пишуться в append-only AuditLog із хеш-ланцюгом; якщо запис неможливий, дія не виконується (C1c).
- **Ступені готовності.** C7 = feature complete, G1 = security ready, R1 = production/rollout ready, Phase 1 complete лише після R1.

## Дефолтні ліміти (усе конфігуроване)

| Параметр | Значення |
|---|---|
| Максимум ходів у run | 40 |
| Максимальний час run | 30 хв |
| Вивід інструмента | 30 000 символів (початок + кінець) |
| Читання файлу за замовчуванням | 2000 рядків, розмір до 1 МБ |
| Таймаут команди | 120 с (install/build 600 с) |
| Паралельні read-only виклики | до 8 |
| Спроби виправити помилку редагування | 2 |
| Repair loop (тести/збірка) | 3 |
| Стиснення контексту | при 75% вікна моделі |
| Субагенти | глибина 1, до 4 паралельно |
| Поширення зміни feature flag / kill switch | не більше 30 с |
| Heartbeat run / lease | 15 с / 60 с |
| Tool call без прогресу | 300 с |
| Інтервал reaper | 60 с |
| Мінімальний вік нового пакета | 7 днів |
| Максимальний вік скану образу sandbox | 14 днів |
| Максимум редиректів в SSRF-safe клієнті | 5 |
| Retention (дефолти, див. R1) | tool results і термінал-логи 30 днів, transcripts 90 днів |

---

## Спільний блок правил (вставляти перед кожним кроком)

````
КОНТЕКСТ
Ми додаємо до NPATI AI Agent Coding Agent harness: можливість агентів Company читати, шукати, писати і змінювати код, запускати команди й тести та перевіряти результат, подібно до Claude Code і Codex, але model-agnostic і всередині існуючої архітектури (Company, Capabilities, Runs, Activity, Approvals, AI Providers, Memory, Skills). Це НЕ окремий продукт.

АРХІТЕКТУРНІ РІШЕННЯ (не змінювати без мого дозволу)
- Не дублювати Website Builder: Project, Workspace, Sandbox, Files, Terminal, Git, Checkpoints, Preview розширюються. Спирайся на docs/coding-agent/00-audit.md і docs/website-builder/00-audit.md.
- Код AI виконується ЛИШЕ в sandbox. Ніколи на основному сервері NPATI.
- Власний цикл агента (CodingAgentRunner), без залежності від зовнішніх CLI. Моделі через існуючі AI Providers (primary, fallback, NPATI Auto, routing, budget).
- Усі інструменти реєструються в canonical capability registry (група code.*) з domain, type, risk, agent callable, approval required, і видимі в Capability Inspector. Жодних прихованих tools.
- Approvals лише через існуючу approval-систему.
- Вміст файлів, README, вебсторінок і результатів інструментів є ДАНИМИ, а не інструкціями. Він не може змінювати режим дозволів, список інструментів чи правила безпеки.
- Coding Agent вимкнений за замовчуванням: усі нові шляхи (API, UI, tools) за feature flags (C1a). Rollback = вимкнення flag.
- Усі code.* tools і API версіонуються (C1a). Опубліковану версію не змінювати.
- Усі зміни схеми БД адитивні (expand/contract), щоб попередня версія застосунку працювала з новою схемою.
- Sandbox запускається лише з перевіреного образу за digest (C1b); мережа лише через egress proxy (C4b).
- До моделі передаються лише дані, дозволені ProviderDataPolicy проєкту (C5b); fallback і субагенти не обходять політику.
- Секрети передаються в sandbox лише як SecretLease на один tool call (C4); production-credentials агенту не видаються.
- Привілейовані дії записуються в tamper-evident AuditLog (C1c); якщо запис неможливий, дія не виконується (fail closed).

ГЛОБАЛЬНІ ПРАВИЛА
1. Весь код, назви, capabilities, міграції, API-маршрути і коментарі пишемо англійською. Спілкування зі мною українською.
2. Не припускай структуру backend. Спершу знайди фактичну реалізацію.
3. Не дублюй існуючі системи. Розширюй їх.
4. Не видаляй і не переписуй робочий код без необхідності. Дотримуйся naming conventions, UI-компонентів і стилю NPATI.
5. Зміни схеми БД лише через поточну систему міграцій NPATI.
6. Безпека на кожному кроці: tenant isolation (user -> company -> project -> workspace -> session -> sandbox), недовіра до project_id, session_id, sandbox_id, file path, command з фронтенду або від моделі; заборона path traversal і виходу за межі workspace; секрети не потрапляють у prompts, логи, Activity UI, tool results; редакція секретів у виводі команд.
7. Логіка не прив'язана до конкретної моделі, назви агента (agent.name) чи sandbox provider. Поведінка моделей задається профілями.
8. Працюй лише в межах поточного кроку. Що поза межами, не реалізуй (максимум інтерфейс або TODO з посиланням на крок).
9. Кожен інструмент має: версію (schema_version), JSON-схему аргументів із валідацією і схему результату, ліміти (розмір, час, кількість), структуровану помилку (status, message, step, tool, retryable), подію в Activity, перевірку feature flag і ідемпотентність за tool_call_id.
10. Наприкінці запусти доступні typecheck, lint, tests, build. Виправ усі помилки, спричинені твоїми змінами. Не ламай існуюче (Company, Agents, Run Company, Capability Inspector, Activity, Website Builder, Data Studio, Chat, AI Providers, Integrations, Automations).
11. У фінальному звіті: змінені/додані файли, що зроблено, що навмисно не зроблено, як перевірити вручну, відомі ризики.
12. Кожен крок додає свої тести безпеки в suite з тегом security-gate (sandbox escape, secret leak, path traversal, approval bypass, prompt injection, ізоляція). Тести цього suite не пропускаються і не послаблюються.
13. Усі code.* tools, API і persisted JSON-формати мають версію. Зміна схеми без підвищення версії неприпустима (див. C1a).
14. Кожна дія, що змінює стан, має бути відновлюваною: збережений стан, ідемпотентність, checkpoint, можливість відкату (див. C6a).
15. Залежності: install без lifecycle scripts за замовчуванням, відтворюваний за lockfile, мережа лише до allowlisted registries (див. C4a).
16. Нові можливості не ввімкнені за замовчуванням і не просуваються за межі internal без проходження відповідної контрольної точки security gate.
17. Авторизація: кожна дія перевіряється RBAC (C5a) на сервері. Ефективні права = перетин capability groups агента, ролі користувача і правил проєкту. Агент і його токен ніколи не можуть бути approver.
18. Дані: кожна збережена сутність (prompts, tool results, логи, checkpoints, workspaces, artifacts) має data_classification і retention_class з моменту створення (див. R1). Нічого не йде до провайдера повз ProviderDataGuard (C5b).
19. Кожен run має ExecutionSnapshot (C6b), і кожна подія Activity посилається на нього.
20. Sandbox: лише перевірений образ за digest (C1b); мережа лише через egress proxy з повторною перевіркою після DNS-резолву і редиректів (C4b).
21. Вихід за межі internal лише після проходження G1 і R1.
22. Секрети: лише SecretLease (scoped до tool call, TTL, відкликання після виконання), без успадкування наступними процесами чи tool calls і без запису в persistent shell environment.
23. Аудит: кожна привілейована дія (RBAC, production approvals, flags, зміни політик, захищені гілки, образи, SecretLease-метадані, export/delete) пишеться в AuditLog (C1c) з actor, request_id, correlation_id, snapshot_id (коли доступний), payload_hash.
24. Залежності вперед: посилання на пізніший крок означає вимогу до інтерфейсу або конфігурації, а не реалізацію. До появи відповідного кроку діє безпечна заглушка (deny або Null-провайдер) або існуюча роль/механізм NPATI. Не реалізовувати функціональність майбутніх кроків.
````

---

## C0. Аудит (без змін коду)

````
ЗАВДАННЯ: лише аналіз. НЕ змінюй код, схему БД чи конфігурацію. Єдиний результат: docs/coding-agent/00-audit.md.

Дослідити і описати (з посиланнями на конкретні файли):

1. Runtime агента: де цикл відповіді в чаті, як виконуються tool calls, чи є вже багатокрокові цикли, як працює streaming (SSE/WebSocket), скасування, обробка помилок.
2. AI Providers: які провайдери і моделі підтримуються; для кожного: native tool calling, паралельні виклики, streaming аргументів, JSON mode, вікно контексту, підтримка prompt caching, reasoning-контент і його вимоги в багатоходових розмовах з tools (особливо для DeepSeek-подібних і локальних моделей). Таблиця model capability matrix. Routing, fallback, budget.
3. Website Builder (/settings/websites): що реалізовано фактично: Project, Workspace, SandboxProvider, Files, Terminal, Git, Checkpoints, Preview, file revision/locking, risk classification команд. Що готове до перевикористання, чого бракує.
4. Capability registry (306 canonical capabilities): існуючі capabilities файлів, shell, git, пошуку, веб; naming convention; як додати групу code.*; як у Capability Inspector відображається risk, approval, agent callable.
5. Approval mechanism: як запитується і підтверджується, які дані показуються користувачу, чи підтримує payload із diff/командою, чи можна відповідати з Telegram/WhatsApp (Integrations).
6. Runs/Tasks/Activity & Run Trace: модель подій, як додати події tool call, file read/edit, command, approval, subagent.
7. Company agents: ролі, capabilities, ієрархія, як Main Agent делегує; режими single/pipeline/fusion/auto.
8. Intent Router і chat: як додати інтенти для коду і як зберігається active project.
9. Сховище сесій і повідомлень, Memory, Skills (/settings/skills), Automations, background jobs, MCP/зовнішні інтеграції.
10. Sandbox: які образи і мови доступні, ресурсні ліміти, мережева політика, чи є git, ripgrep, build tools, чи достатньо для Node, Python, Go, Rust, Java, PHP.
11. UI: наявні компоненти редактора/diff/терміналу/дерева файлів, design system, mobile.
12. Ліцензії відкритих harness-проєктів, які можна вивчати як референс (перевірити актуальні ліцензії; код не копіювати без явного дозволу ліцензії і мого підтвердження).
13. Feature flags і конфігурація: чи є існуюча система flags або runtime-конфігу без деплою, scope (global/company/user), кеш, аудит змін.
14. Версіонування: конвенції версій capabilities і API в NPATI, як зберігаються tool calls у Run/Activity (формат і чи є версія), як міграції схеми влаштовані (чи можливий expand/contract).
15. Supply chain: які менеджери пакетів і версії є в sandbox-образах, наявність npm/pnpm audit, pip-audit, composer audit, cargo audit або OSV-scanner, конфіги registry, можливість мережі в дві фази (fetch і build).
16. Recovery: існуючі heartbeat/lease, job scheduler для reaper, як sandbox перезапускається, де зберігається workspace (чи переживе він падіння контейнера), як зараз виконуються міграції БД і інтеграція з Data Studio (migration lock, snapshots).
17. Існуючі security-тести й CI: чи є job для безпеки, як додати обов'язкову job security-gate, які hermetic-мок моделей уже існують.
18. RBAC: існуюча модель ролей і permissions NPATI (власник, члени Company), ідентифікація approver, чи можливий режим кількох користувачів, як працюють Automations (від чийого імені).
19. Образи і ізоляція: як будуються й де зберігаються sandbox-образи, чи є registry і підпис, можливість SBOM/scan; оцінити сильнішу ізоляцію (gVisor, Kata, Firecracker) порівняно зі звичайними контейнерами для недовіреного коду.
20. Мережа: як зараз налаштована мережа sandbox (docker network, firewall), чи можливий egress proxy і власний DNS-resolver, SSRF-захист існуючих NPATI-tools (web fetch, search, MCP).
21. Дані: що і де зберігається (prompts, логи, Activity, workspaces), існуючі retention, backups і що в них потрапляє, secret storage.
22. AI Providers: де зберігається конфігурація провайдерів і routing, чи є поняття локального/self-hosted провайдера, prompt caching, де можна додати ProviderDataPolicy.
23. Observability: існуючі метрики, логи, tracing, алерти, rate limiting і бюджети; скільки ресурсів хоста доступно під sandbox.
24. Audit і секрети: існуючі audit-механізми, можливість append-only таблиць (права БД, тригери), місце для anchor хеш-ланцюга поза основною БД; можливості secret storage видавати короткоживучі scoped credentials (lease/token).

ФОРМАТ документа:
- Таблиця "Що вже є -> де -> що перевикористати/розширити".
- Model capability matrix.
- Що створити з нуля.
- Пропозиція архітектури CodingAgentRunner у межах існуючої Run-інфраструктури: де живе цикл, як зберігається стан сесії, як інтегрується з Company agents.
- Пропозиція ToolCallAdapter для моделей без надійного native tool calling.
- Висновок: чи потрібно розширювати sandbox-образи, і які.
- Модель загроз: prompt injection із репозиторію/веб, витік секретів, втеча з sandbox, нескінченні цикли, витрата бюджету.
- Ризики та відкриті питання до мене.
- Уточнений поділ кроків C1-C15, а також C1a, C1b, C1c, C4a, C4b, C5a, C5b, C6a, C6b, G1, R1 під реальну архітектуру, з планом контрольних точок SG-1/SG-2/SG-3.

КРИТЕРІЇ ПРИЙМАННЯ:
- Змінений лише docs/coding-agent/00-audit.md (git status).
- Кожне твердження має посилання на файл.
- Є явні рекомендації щодо: місця циклу агента, перевикористання Website Builder, формату редагування для кожного профілю моделі.
````

---

## C1. Code Project і Workspace foundation

````
ЗАВДАННЯ: розширити Project/Workspace для довільного коду і додати сутність CodeSession. Без інструментів і без циклу агента.
Спирайся на C0 і Website Builder.

Зробити:
1. Тип проєкту code_project (розширюваний enum; Website Builder проєкти лишаються валідними і теж доступні для кодування). Поля toolchain/languages, default branch, verify_commands (конфігуровані), data_classification (public, internal, confidential, restricted; дефолт confidential) і retention_class.
2. WorkspaceProvider (перевикористати/розширити ProjectWorkspace): managed workspace і git clone (з існуючої GitHub integration, приватні репозиторії через secret storage). Інтерфейс готовий до змонтованої локальної папки (C15), але вона НЕ реалізується.
3. Автовизначення toolchain: Node (npm/pnpm/yarn), Python (pip/poetry/uv), Go, Rust, Java (maven/gradle), PHP (composer). Визначення тестових, lint, typecheck і build команд з package.json, pyproject, Makefile, go.mod, Cargo.toml тощо. Результат зберігається як project metadata і може бути виправлений користувачем.
4. Sandbox образи: за висновком аудиту додати/розширити образи (git, ripgrep, build-essential, потрібні runtime). Непривілейований користувач, ліміти CPU/RAM/disk/pids, мережа за allowlist (package registries, налаштовані git-хости). Без docker socket і без монтування хоста.
5. CodeSession: id, project_id, company_id, user_id, agent_id, mode, model_profile, status, parent_session_id, created_at, updated_at, summary, data_classification (успадковується від проєкту; підняти можна, знизити лише роллю за C5a), retention_class. Зв'язок із існуючим Run (reuse, не дублювати). Перевірка належності на сервері.
6. API: create/get/list/archive code project; створення, перегляд, архівація сесій. Імпорт репозиторію (reuse кроку імпорту Website Builder, якщо є).
7. Мінімальний UI: розділ Settings -> Code (/settings/code) зі списком code-проєктів та сесій (інтегрувати в навігацію поряд із Website Builder, design system NPATI). Повноцінний workspace UI буде в C7.
8. Налаштування за замовчуванням: ліміти з таблиці в плані, зберігаються як конфігурація, не hardcode.
9. Довідники data_classification (public, internal, confidential, restricted) і retention_class (ephemeral, short, standard, extended, until_deleted). Реальні строки задаються в R1, тут лише enum і поля. Усі сутності, що з'являються в C1-C6 (CodeSession, transcripts, tool results, термінал-логи, checkpoints, workspaces, sandbox artifacts, summaries, snapshots), створюються з обома полями (правило 18).

НЕ РОБИТИ: file/shell tools, цикл агента, UI редактора.

ТЕСТИ:
- CRUD code project і session; ізоляція між компаніями та користувачами.
- Визначення toolchain на тестових репозиторіях (Node, Python, Go).
- Клонування приватного репозиторію без доступу завершується структурованою помилкою; credentials не потрапляють у логи.
- Sandbox: непривілейований користувач, не бачить хоста та інших проєктів, мережа лише за allowlist.
- Website Builder проєкти продовжують працювати.
- Проєкт і сесія мають data_classification і retention_class; classification сесії не нижча за проєктну; зниження без потрібної ролі відхиляється.

КРИТЕРІЇ ПРИЙМАННЯ:
- Користувач імпортує репозиторій, система визначає toolchain і verify-команди, створюється CodeSession, у Settings -> Code видно проєкт і сесію. Тести зелені.
````

---

## C1c. Tamper-evident audit log (обов'язково; виконується після C1, до C1a)

````
ЗАВДАННЯ: незмінюваний журнал привілейованих подій. Activity лишається для трасування run-ів, AuditLog для рішень, які мають бути доказовими (особливо two-person approval). Спирайся на C0 (пункт 24). Інтерфейс AuditLog.record() доступний усім наступним крокам, події підключаються в міру появи відповідних функцій.

Зробити:
1. AuditLog (append-only), окремо від Activity: audit_id, timestamp, actor (user, service identity або agent id), actor_role, request_id, correlation_id (зв'язок run/approval/PR), snapshot_id (null до C6b), action, resource (тип і id), company/project, decision (allowed, denied, approved, rejected), payload_hash (hash точного payload дії), prev_hash, entry_hash, metadata (без секретів і без вмісту промптів).
2. Які події записуються (підключаються поступово): зміни RBAC і ролей; рішення авторизації для привілейованих дій; production-approvals (кожен approver окремо, з однаковим payload_hash для two-person); зміни feature flags і kill switch; зміни policy engine, правил проєкту, trust project; зміни ProviderDataPolicy і classification; зміни політики захищених гілок і мережевого allowlist; allow/revoke образів sandbox; метадані SecretLease (без значень); export/delete даних.
3. Append-only: роль застосунку має лише INSERT і SELECT; UPDATE і DELETE заборонені правами БД та тригером; жодного cascade delete. Видалення проєкту не видаляє аудит (лишаються id і хеші, PII мінімізується).
4. Хеш-ланцюг: entry_hash = H(prev_hash + canonical(entry)), ланцюг на Company; опційно HMAC або підпис ключем поза БД. Періодичний anchor (щодня): head hash зберігається поза основною БД (окреме сховище або підписаний файл) і показується власнику; опційно зовнішній timestamp.
5. Верифікація: фонова задача і API verifyChain(company, range). Розрив ланцюга або розбіжність з anchor дає критичний алерт (R1) і, за конфігурацією, блокування привілейованих операцій до розслідування.
6. Fail closed: якщо запис у AuditLog неможливий, привілейована дія не виконується.
7. Доступ: читання лише ролям owner/admin (до появи C5a лише існуюча роль власника NPATI); пошук за actor, request_id, correlation_id, action; експорт.
8. Retention: окремий, довший за логи (значення в R1), лише метадані і хеші.

ТЕСТИ (security-gate):
- UPDATE/DELETE рядка роллю застосунку відхиляється.
- Зміна рядка в обхід застосунку (адміністративний доступ до БД) виявляється verifyChain; розрив ланцюга створює алерт.
- Привілейована дія за недоступного аудиту відхиляється (fail closed).
- payload_hash збігається з реально виконаним payload; підміна payload між схваленням і виконанням виявляється.
- Секрети та вміст промптів відсутні в записах; ізоляція між Company.

КРИТЕРІЇ ПРИЙМАННЯ:
- Усі наявні привілейовані події мають audit-запис; ланцюг верифікується; щоденний anchor створюється.
````

---

## C1a. Feature flags, staged rollout і версіонування (обов'язково)

````
ЗАВДАННЯ: керований випуск і сумісність. Виконується одразу після C1 і до C2: усі наступні інструменти створюються вже за flags і з версіями. Спирайся на C0.

A. Feature flags і staged rollout
1. Перевикористати існуючу систему flags/runtime-конфігу (за аудитом). Якщо її немає, зробити мінімальну: сховище (адитивна міграція NPATI) зі scope global/company/user, значенням, історією змін; зміна без деплою.
2. Ієрархія flags: master kill switch coding_agent.enabled; під-flags: code.read, code.write, code.shell, code.git, code.subagents, code.background_runs, code.mounted_folder, code.hooks, code.mcp, code.full_auto_sandbox, code.model_profile.<id>. Дефолт: усе вимкнено (dark launch).
3. Етапи: off -> internal/admin -> allowlist користувачів/Company -> відсоток -> GA. Для self-hosted з одним власником: перемикачі в Settings -> Code -> Experimental і в конфігурації. Для кількох користувачів: allowlist і відсоток.
4. Перевірка flag ЗАВЖДИ на сервері (не лише в UI): при створенні сесії, на кожному ході і перед кожним tool call. TTL кешу не більше 30 с, щоб kill switch діяв швидко.
5. Вимкнення flag. Ніколи не вмикався: розділ Code прихований (dark launch). Був увімкнений і потім вимкнений: режим History (read-only). Блокуються створення сесій, run, будь-які tools, approvals, запуск sandbox і виклики моделі. Kill switch негайно скасовує активні run-и (звичайне вимкнення дозволяє завершити поточний tool call); run отримує статус suspended_by_flag, процеси і sandbox очищаються, SecretLease відкликаються. Лишаються доступними окремим read-only шляхом, що не запускає sandbox, tools чи модель: список сесій і History, Activity, перегляд Changes/diff і checkpoints, Export, а також Delete (за RBAC). Export і Delete працюють завжди, навіть при вимкненому flag, щоб користувач міг забрати або видалити свої дані. API повертає feature_disabled для всіх дій, крім read-only History, Export і Delete. Website Builder не зачіпається.
6. Rollback без змін схеми чи коду: усі зміни схеми адитивні (expand/contract), без destructive міграцій у тому самому релізі, тому попередня версія застосунку працює з новою схемою. Rollback = вимкнення flag.
7. Автовимкнення (опційно, конфігуровано): при перевищенні порога помилок, security-подій або бюджету відповідний flag вимикається автоматично, власник отримує сповіщення.
8. Просування етапу за межі internal дозволене лише після проходження G1 і R1. Зміни flags пишуться в AuditLog (C1c). До появи C5a змінювати flags може лише існуюча роль власника/адміністратора NPATI; C5a підключає ролі Coding Agent (owner/admin).
9. Capability Inspector показує стан flag для кожної code.* capability.

B. Версіонування
10. Tool schema registry: кожен code.* tool має name, version (ціле), JSON-схему аргументів і результату, статус (active/deprecated), дату deprecation. Опублікована версія незмінна. Capability Inspector показує версію.
11. Правила сумісності: додавання необов'язкових полів сумісне (та сама версія); видалення, перейменування, зміна типу чи семантики створює нову версію (наприклад code.fs.edit@2), стара живе, доки є сесії, що її використовують.
12. CodeSession фіксує tool_manifest_version (набір версій tools) при створенні; runner показує моделі саме ці версії; resume (C10) і replay використовують той самий манифест; оновлення манифесту лише явною дією з перевіркою сумісності.
13. Run-и, Activity-події і checkpoints зберігають tool, tool_version, schema_version даних; старі записи читаються через upcasters (перетворення при читанні), без міграції історії.
14. API: префікс версії (/v1 або за конвенціями NPATI); у межах версії лише адитивні зміни; відповіді містять api_version; вікно deprecation задокументоване. Клієнти (UI, пізніше CLI) передають підтримувану версію.
15. Версії також для persisted JSON-форматів: transcript сесії, summary-артефакт, metadata checkpoint, model profile.
16. CI: snapshot опублікованих tool schemas; зміна без підвищення версії ламає збірку; golden-fixtures записаних run-ів попередніх версій відтворюються (replay tests).

НЕ РОБИТИ: самі інструменти, цикл агента.

ТЕСТИ:
- Flag ніколи не вмикався: розділ прихований, API повертає feature_disabled. Flag вимкнено після використання: створення сесії, run, tools, approvals, sandbox і виклики моделі заблоковані (також прямими викликами API/tool), а History, Activity, Changes/diff, Export і Delete доступні read-only; flag для allowlist-користувача не вмикає функцію іншим; flag однієї Company не впливає на іншу.
- Прямий виклик API/tool при вимкненому flag відхиляється (тег security-gate).
- Kill switch під час run зупиняє його не довше ніж за TTL, процеси очищені, дані збережені.
- Rollback: попередня версія коду працює з новою схемою (перевірка адитивності міграцій).
- Сесія зі старим manifest працює після випуску нової версії tool; upcaster читає старі події.
- Зміна схеми tool без bump version падає в CI.

КРИТЕРІЇ ПРИЙМАННЯ:
- Адміністратор вмикає Coding Agent для однієї Company і вимикає однією дією без деплою і без втрати даних.
- Зміна схеми tool не ламає стару сесію і стару історію run-ів.
````

---

## C1b. Sandbox image supply-chain (обов'язково)

````
ЗАВДАННЯ: захист самих образів sandbox (C4a захищає залежності проєкту, цей крок захищає середовище, в якому вони виконуються). Виконується після C1a і до першого запуску sandbox. Спирайся на C0.

Зробити:
1. Декларативний каталог образів (base, node, python, go, rust, java, php): Dockerfile, версії системних пакетів зафіксовані, мінімальний склад, непривілейований користувач, без docker socket і privileged. Збірка в CI, відтворювана наскільки можливо.
2. Pin за digest: конфігурація і SandboxProvider посилаються на image@sha256:..., а не на теги (latest заборонено). Digest записується в сесію (потім у ExecutionSnapshot, C6b).
3. SBOM для кожного образу (SPDX або CycloneDX) зберігається разом з метаданими образу.
4. Vulnerability scan у CI і за розкладом (повторне сканування наявних образів). Критичні вразливості блокують публікацію образу; високі потребують waiver із власником і терміном. Статус образу: verified, deprecated, revoked.
5. Trusted registry і підпис образів (cosign/sigstore або еквівалент): перевірка підпису й digest перед запуском. Для open-source дистрибуції: офіційні образи збираються й підписуються в CI проєкту, digests публікуються. Локально зібрані образи дозволені лише в dev-режимі, позначаються unverified і не допускаються для production-flags.
6. Admission control у SandboxProvider.createSandbox: відмова, якщо образ не в allowlist, підпис недійсний, digest не збігається, скан старший за N днів (дефолт 14) або образ revoked. Чітка структурована помилка, подія в Activity. Зміни allowlist і revoke образів пишуться в AuditLog (C1c).
7. Оновлення: регулярна пересборка (наприклад щотижня) і позачергова при критичній CVE; новий digest вводиться поступово через flags (C1a); сесії лишаються на своєму digest, доки його не revoked (тоді примусове оновлення зі сповіщенням); можливість відкату на попередній digest.
8. Hardening запуску: drop capabilities, no-new-privileges, read-only rootfs із записуваними workspace і tmp, seccomp/AppArmor профіль, ліміти ресурсів. Оцінити (за C0) сильнішу ізоляцію (gVisor, Kata, Firecracker) як опційну runtime-реалізацію SandboxProvider; рішення задокументувати.

ТЕСТИ (security-gate):
- Образ без підпису, з тегом замість digest, з невідповідним digest, revoked або зі старим сканом не запускається.
- Verified образ запускається; admission рішення логуються.
- Контейнер без зайвих capabilities, без docker socket, під непривілейованим користувачем, rootfs read-only.
- Сесія лишається на своєму digest після публікації нового; revoked digest примусово замінюється зі сповіщенням.

КРИТЕРІЇ ПРИЙМАННЯ:
- SG-1 (частина образів): запуск неперевіреного образу неможливий жодним шляхом (API, конфіг, tool).
- SBOM і результат скану доступні для кожного образу.
````

---

## C2. Інструменти читання і пошуку

````
ЗАВДАННЯ: безпечні інструменти для дослідження коду. Спирайся на C1.

Зробити (capabilities групи code.fs.* у canonical registry, risk = low):
1. code.fs.list / glob: перегляд каталогів і пошук за шаблоном, з поваги .gitignore (конфігуровано), сортування за часом зміни, ліміт кількості результатів.
2. code.fs.read: читання з номерами рядків, параметри offset/limit (за замовчуванням 2000 рядків, до 1 МБ), обрізання дуже довгих рядків, визначення binary/image (повертає метадані, а не вміст), кодування.
3. code.fs.grep: пошук регулярними виразами (ripgrep у sandbox), фільтр за glob і типом файлів, режими files_with_matches / content / count, контекстні рядки, ліміт результатів і розміру.
4. code.fs.tree (стислий огляд структури проєкту з лімітом глибини) і, за можливості, code.symbols.outline (список символів файлу через tree-sitter або ctags; якщо аудит показав складність, залишити TODO).
5. Read tracking: сесія запам'ятовує які файли і з яким hash/revision були прочитані (потрібно для read-before-write у C3).
6. Політика чутливих файлів: .env, ключі, сертифікати, credentials-файли за замовчуванням не читаються моделлю або читаються з редакцією значень (конфігуровано). Нікому не віддавати секрети у tool results.
7. Усі результати обрізаються до ліміту (початок + кінець) з позначкою про обрізання і підказкою, як уточнити запит.
8. Результати інструментів позначаються як дані (обгортка), щоб модель не сприймала вміст файлів як інструкції.
9. Path safety: нормалізація, заборона "..", абсолютних шляхів поза workspace, symlink-виходів, null bytes.

НЕ РОБИТИ: запис, shell, цикл агента.

ТЕСТИ:
- Path traversal (../, абсолютні, symlink назовні, null byte) відхиляються.
- Великі файли, бінарні файли, довгі рядки, обрізання виводу.
- grep: regex, фільтри, ліміти, .gitignore.
- Чутливі файли не повертаються у відкритому вигляді.
- Ізоляція між проєктами/компаніями/користувачами.
- Capabilities видимі в Capability Inspector з коректним risk.
- Prompt injection: файл із текстом "ignore previous instructions" повертається як дані, без побічних ефектів.

КРИТЕРІЇ ПРИЙМАННЯ:
- Агент у звичайному Run (ручний виклик інструментів через тест-харнес) знаходить функцію за описом (grep + read) у тестовому репозиторії. Тести зелені.
````

---

## C3. Інструменти редагування, checkpoints, diff

````
ЗАВДАННЯ: надійне редагування коду. Спирайся на C1-C2 і revision control з Website Builder (expected_revision).

Зробити (capabilities code.fs.*, risk = medium; видалення/масові дії = high з approval):
1. code.fs.edit: параметри path, old_string, new_string, replace_all. Вимоги: точна заміна; old_string має бути унікальним (інакше помилка з кількістю збігів і підказкою розширити контекст); файл має бути прочитаний у цій сесії і не змінений після читання (інакше помилка "re-read"). При збігу з точністю до пробілів/відступів повертати підказку з найближчим фрагментом. Зберігати кодування, закінчення рядків і права файлу.
2. code.fs.apply_patch: пакетні зміни кількох файлів в одному виклику (формат patch узгодити за аудитом, наприклад унікальний формат "*** Begin Patch" або unified diff), атомарно: або всі зміни застосовуються, або жодна. Dry-run. Зрозумілі помилки з номерами рядків.
3. code.fs.write: створення нового файлу; перезапис існуючого лише якщо він був прочитаний у сесії. Створення потрібних каталогів.
4. code.fs.move / code.fs.delete: delete і масові операції (поріг конфігурується) потребують approval.
5. Revision control: кожен запис перевіряє expected_revision; при revision_conflict повертається структурована помилка, агент може re-read і повторити (максимум 2 спроби).
6. Per-turn checkpoint: автоматичний snapshot workspace перед першим записом у ході (реалізація поверх git або snapshot з Website Builder). Команда undo last turn.
7. Diff: генерація unified diff для кожної зміни і для всього ходу; статистика (files, +/-). Подія в Activity з діффом (без секретів).
8. Після запису: опційний форматер проєкту (якщо налаштований) і швидка перевірка синтаксису змінених файлів; результат повертається як попередження, не блокує запис.
9. Профілі моделей: поле preferred_edit_tool (edit | apply_patch | write_whole_file_for_small) у конфігурації профілю. Не hardcode під конкретну модель.
10. Захист: не редагувати файли поза workspace, заборона запису в .git/, у файли секретів без approval, обмеження розміру зміни за один виклик.

НЕ РОБИТИ: shell, цикл агента, UI diff-перегляду (C7).

ТЕСТИ:
- Неунікальний old_string, відсутній old_string, змінений після читання файл.
- CRLF/LF, юнікод, табуляції, великий файл, права файлу.
- apply_patch: успіх, помилка посередині (повний відкат), dry-run.
- Запис без попереднього читання відхиляється; revision_conflict і повторна спроба.
- Checkpoint і undo відновлюють файли точно.
- Path traversal, запис у .git/ і у файли секретів.
- Delete без approval не виконується.
- Ізоляція між проєктами/користувачами.

КРИТЕРІЇ ПРИЙМАННЯ:
- Через тест-харнес серія викликів read -> edit -> apply_patch змінює кілька файлів, diff коректний, undo повертає початковий стан.
````

---

## C4. Shell, процеси і запуск перевірок

````
ЗАВДАННЯ: виконання команд у sandbox і автоматична верифікація. Спирайся на C1-C3 і Terminal з Website Builder.

Зробити:
1. code.shell.exec: виконання команди в sandbox із cwd/env, що зберігаються між викликами в межах CodeSession (постійна shell-сесія). Таймаут (120 с за замовчуванням, 600 с для install/build), обмеження виводу (head+tail), exit code, тривалість. Команда без TTY: інтерактивні запити завершуються помилкою з підказкою, а не зависанням.
2. code.shell.process.*: старт фонового процесу (dev server, watcher), список, логи (з offset), зупинка. Автоочищення при завершенні сесії.
3. Risk classification (перевикористати і розширити класифікатор з Website Builder; аналізувати команду парсером, а не лише перше слово; враховувати pipe, &&, ;, subshell, змінні, backticks, heredoc):
   - Safe: читання, status, diff, запуск тестів/lint/typecheck/build.
   - Controlled: install залежностей, форматування, запуск скриптів проєкту.
   - Approval: git push, deploy, міграції БД, мережа поза allowlist, curl/wget | sh, видалення поза build-артефактами, доступ до production і зовнішніх credentials, невідомі команди.
   - Hard deny (жодний режим не дозволяє, включно з owner): rm -rf / і подібне, запис поза workspace, доступ до docker socket, зміна sandbox/мережевих налаштувань, читання секретів хоста, force push у захищені гілки та пряма запис агентом у захищені гілки, використання production/зовнішніх production-credentials у shell агента (production-операції виконуються лише платформними виконавцями за approval).
4. Мережа: egress allowlist (registries, налаштовані git-хости). Режим не може розширити allowlist без approval.
5. Секрети через SecretLease (інтерфейс SecretLeaseProvider поверх існуючого secret storage): lease видається на ОДИН tool call (або явно затверджений процес), має scope (конкретне призначення), мінімальні permissions, короткий TTL (не довше таймаута виклику), передається лише в процес цього виклику (tmpfs-файл або env цього процесу), НЕ записується в persistent shell environment і НЕ успадковується наступними процесами чи tool calls; відкликається одразу після виконання, при скасуванні, падінні і за TTL (reaper). Фонові процеси, яким потрібен секрет (наприклад dev server), отримують окремий затверджений lease з TTL і мінімальним scope. Production-credentials як lease агенту не видаються. Значення не потрапляють у prompts, Activity, логи, tool results (редакція виводу); lease_id, scope, TTL і tool_call_id логуються (без значення), метадані йдуть в AuditLog (C1c). Shell-сесія має очищений environment без секретів.
6. Ресурсні ліміти і захист від fork bomb та вичерпання диска; завершення дерева процесів при timeout.
7. code.verify.run: запуск verify-команд проєкту (lint, typecheck, тести, build) за визначеним у C1 набором або за аргументом (наприклад тільки файли, що змінилися). Парсинг виводу поширених інструментів у структурований результат (файл, рядок, повідомлення, severity): tsc, eslint, pytest, jest/vitest, go test, cargo. Невідомий формат повертається як обрізаний сирий вивід.
8. Capabilities у registry з коректним risk і approval required.

НЕ РОБИТИ: цикл агента, режими дозволів (C5), UI.

ТЕСТИ:
- Класифікатор: набір команд safe/controlled/approval/deny, включно з обхідними (a && rm -rf /, $(...), `...`, змінні, heredoc, rm -rf ./).
- Timeout, обмеження виводу, інтерактивна команда, фоновий процес і його очищення.
- Мережа: доступ до registry дозволений, до довільного хоста заблокований.
- Секрети не з'являються у виводі.
- SecretLease: значення недоступне наступному tool call (env, /proc, tmpfs, shell history), після TTL чи скасування відкликається, фоновий процес не успадковує lease без затвердження (тег security-gate).
- Lease не видається для production-credentials; запит такого lease відхиляється.
- Sandbox не бачить хоста, docker socket і інших проєктів.
- Парсинг результатів tsc/pytest на прикладах.
- Ізоляція між сесіями/проєктами/користувачами.

КРИТЕРІЇ ПРИЙМАННЯ:
- Через тест-харнес: install, запуск тестів у проєкті з невдалим тестом, отримання структурованого списку помилок. Жодна команда не виконується на хості NPATI.
````

---

## C4a. Supply-chain security (обов'язково)

````
ЗАВДАННЯ: захист від шкідливих і вразливих залежностей та install-скриптів. Спирайся на C4 (shell, класифікатор, мережа).

Зробити:
1. Політика install за менеджером (усе конфігуровано):
   - npm/pnpm/yarn: lockfile обов'язковий; відтворюваний install (npm ci, pnpm install --frozen-lockfile, yarn --immutable); lifecycle scripts за замовчуванням вимкнені (--ignore-scripts); потрібні скрипти запускаються окремо лише для allowlist-пакетів (наприклад onlyBuiltDependencies) після approval.
   - pip/uv/poetry: lockfile або constraints, за замовчуванням лише wheels (--only-binary); sdist (виконує setup.py) лише з approval; перевірка hash де можливо.
   - composer: --no-scripts і --no-plugins за замовчуванням; composer.lock обов'язковий.
   - cargo: --locked; build.rs і procedural macros виконують код, тому збірка відбувається без мережі після cargo fetch (--offline).
   - go: go.sum, -mod=readonly, GOPROXY за allowlist.
2. Дві фази: fetch (мережа лише до allowlisted registries) і build/run (мережа вимкнена). Install виконується зі scrubbed environment (без секретів, токенів, SSH-ключів), з лімітами ресурсів, окремим процесом.
3. Додавання нової залежності (code.deps.add) потребує approval або (в auto_edit) автоматично лише після перевірки: пакет існує в registry; не новіший за N днів (дефолт 7); не схожий на популярний пакет (typosquatting); ім'я не вигадане моделлю; метадані (версія, ліцензія, наявність install scripts, кількість maintainers/завантажень, якщо registry це надає). Результат перевірки показується в approval.
4. Джерела поза registry (git URL, tarball, http, локальний шлях) і зміна registry/index URL у .npmrc, .yarnrc, pip.conf, pyproject sources, composer repositories завжди потребують approval.
5. Diff-guard: зміни lifecycle-скриптів (preinstall, install, postinstall, prepare), Makefile-таргетів, CI-конфігів (.github/workflows), Dockerfile, git hooks і конфігів package manager позначаються як чутливі й потребують approval у режимах ask та auto_edit.
6. Git hooks із репозиторію не виконуються в sandbox (core.hooksPath на порожній каталог); submodules і filters не виконуються автоматично.
7. Сканування: audit залежностей після будь-якої зміни lockfile і перед комітом (npm/pnpm audit, pip-audit, composer audit, cargo audit або OSV-scanner залежно від toolchain; allowlisted advisory API або офлайн-база). Критичні й високі вразливості блокують авто-коміт і створення PR без approval. Secret scanning diff перед комітом (ключі, токени, приватні ключі, .env). Опційно: перевірка ліцензій і SBOM.
8. Registry: allowlist, опційний caching proxy/mirror; приватні registry через secret reference; токен приватного registry видається як SecretLease лише на виклик install і не записується в workspace (тимчасовий scoped конфіг поза workspace, що видаляється після виклику).
9. Capabilities code.deps.add, code.deps.audit, code.deps.inspect у registry з версіями (C1a), під flag code.shell.
10. Класифікатор з C4 доповнити: curl | sh, pip install з URL, npm install з git URL, зміна registry, запуск lifecycle scripts.

ТЕСТИ (усі з тегом security-gate):
- Тестовий пакет зі шкідливим postinstall (безпечний імітатор, що намагається прочитати env і записати файл поза workspace) за замовчуванням не виконується; в явному режимі не бачить секретів і не виходить із sandbox.
- Вигаданий, свіжий або схожий на популярний пакет блокується чи вимагає approval.
- Install з git URL/tarball і зміна registry вимагають approval.
- Невідповідність lockfile відхиляється; install відтворюваний.
- cargo build.rs і pip sdist не мають мережі на фазі build.
- Git hook із репозиторію не виконується.
- Audit знаходить відому вразливість у тестовому lockfile і блокує авто-коміт; secret scanner знаходить тестовий ключ у diff.
- Зміна postinstall у package.json позначається і потребує approval.

КРИТЕРІЇ ПРИЙМАННЯ:
- SG-1: мінімальний набір security-gate для sandbox escape, secret leak, path traversal (C2-C4) і supply chain (цей крок) проходить у CI і є обов'язковою job.
````

---

## C4b. Egress enforcement: реалізація мережевої ізоляції (обов'язково)

````
ЗАВДАННЯ: мережева ізоляція sandbox реалізується механізмом, а не лише тестами. Розширює мережеві вимоги C4 і C4a. Спирайся на C0 (мережева архітектура).

Зробити:
1. Default-deny: sandbox підключений до ізольованої мережі, прямий вихід заборонений на рівні firewall/network policy (nftables/iptables або можливості SandboxProvider). Єдиний маршрут назовні через керований NPATI egress proxy. Скидання HTTP_PROXY у середовищі не дає обходу, бо блокування на рівні мережі.
2. DNS: sandbox не може використовувати довільні DNS-сервери; резолвінг робить proxy/керований resolver із політикою. Блокувати DoH/DoT до невідомих хостів (дозвіл лише за hostname allowlist).
3. Перевірка після резолву: proxy сам резолвить ім'я і перевіряє ВСІ отримані IP за списком заборонених діапазонів: loopback (127.0.0.0/8, ::1), RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), CGNAT (100.64/10), ULA (fc00::/7), 0.0.0.0/8, multicast, IPv4-mapped IPv6, мережі Docker/хоста, IP і імена внутрішніх сервісів NPATI (основний postgres, postgres-projects, API, інші sandbox), metadata endpoints (169.254.169.254, metadata.google.internal тощо).
4. Захист від DNS-rebinding: з'єднання йде на перевірений IP (pinning), без повторного резолву між перевіркою і підключенням; перевірка повторюється для кожного нового з'єднання; мінімальний TTL-кеш.
5. Редиректи: кожен hop обробляється як новий запит із повною перевіркою (host, резолв, IP, порт, схема); максимум редиректів 5 (конфігуровано); перехід на небезпечну схему (file, gopher, ftp) і на заборонений діапазон блокується.
6. Порти й протоколи: за замовчуванням лише 443 і 80 (та 22 для allowlisted git-хостів); UDP і ICMP заборонені, окрім DNS до керованого resolver; IPv6 вимкнений або підпадає під ті самі правила. Опційна перевірка збігу SNI і CONNECT-хоста (domain fronting).
7. Allowlist за hostname (точні імена, обережна робота з wildcard, щоб evil.registry.com.attacker.net не проходив), різні набори для фази install і для інших фаз; фаза build/run без мережі (C4a). Розширення allowlist: до появи C5/C5a лише конфігурацією оператора, після C5/C5a через approval і RBAC; будь-яка зміна пишеться в AuditLog (C1c).
8. SSRF-safe HTTP-клієнт для всіх NPATI-side tools (web fetch, search, MCP, webhooks, hooks): та сама валідація IP після резолву і на кожному редиректі, ліміти розміру й часу. Один спільний модуль, без власних реалізацій у кожному tool.
9. Логування: кожне з'єднання (хост, IP, порт, байти, рішення) пишеться в Activity/метрики без вмісту; відмови повертаються агенту як структуровані помилки.

ТЕСТИ (security-gate):
- IP-літерали та кодування (2130706433, 0x7f000001, 0177.0.0.1, [::ffff:127.0.0.1]) блокуються.
- Хост, що резолвиться в приватний IP (наприклад localtest.me), блокується.
- DNS-rebinding (запис, що змінюється між публічним і приватним): блокується завдяки pinning.
- Редирект на http://169.254.169.254 і на localhost блокується; редирект на дозволений публічний хост проходить; ліміт редиректів.
- Підміна імені в стилі evil.npmjs.org.attacker.com не проходить allowlist.
- Прямі з'єднання за IP, UDP, ICMP, нестандартні порти, зовнішній DNS блокуються на рівні мережі навіть при скиданні proxy-змінних.
- Доступ до внутрішніх сервісів NPATI, postgres, postgres-projects, іншого sandbox неможливий.
- SSRF-safe клієнт у NPATI-tools проходить той самий набір.
- Дозволений registry у фазі install працює, у фазі build мережі немає.

КРИТЕРІЇ ПРИЙМАННЯ:
- SG-1 (мережа): весь набір вище проходить; жоден обхід не знайдений; рішення мережі видно в Activity.
````

---

## C5. Режими дозволів і policy engine

````
ЗАВДАННЯ: єдиний механізм рішень "дозволити, спитати, заборонити". Спирайся на C2-C4 та існуючу approval-систему.

Зробити:
1. Режими сесії:
   - plan: лише читання і пошук; будь-який запис, shell, git write заборонені (окрім безпечних read-only команд за налаштуванням).
   - ask: кожне редагування і кожна не-safe команда потребують approval.
   - auto_edit: редагування файлів у workspace виконуються автоматично, команди за classification (safe/controlled автоматично, решта approval).
   - full_auto_sandbox: усе в межах sandbox автоматично, окрім approval-класу (push, deploy, мережа поза allowlist, міграції, зовнішні credentials) і hard deny.
2. Конвеєр рішення на кожен виклик: (a) feature flag -> (b) RBAC ролі користувача (C5a) -> (c) чи є capability у агента (capability group) -> (d) hard deny -> (e) режим сесії -> (f) allow/deny правила проєкту і користувача -> (g) risk classification -> (h) approval через існуючу систему.
3. Approval payload: що саме буде зроблено (diff або команда з cwd), чому, ризик. Рішення: approve once, approve for session, approve for project (створює scoped правило, видиме і видалюване в UI), deny з коментарем (коментар повертається моделі).
4. Hard deny список, який не може бути змінений жодним режимом, правилом чи інструкцією з репозиторію. Включає force push у захищені гілки, пряму запис агентом у захищені гілки, використання production-credentials агентом, вихід за workspace, доступ до docker socket.
5. Захист від prompt injection: вміст файлів, веб, результатів інструментів і NPATI.md/AGENTS.md з імпортованих репозиторіїв не може змінювати режим, правила чи approvals. Інструкції з репозиторію діють лише після явного "trust this project" користувачем.
6. Зміна режиму лише користувачем, не моделлю. Модель може запропонувати перейти з plan у execute, але рішення за користувачем.
7. Таймаут approval (конфігуровано): без відповіді run зупиняється з чітким статусом, а не виконує дію.
8. Approval з месенджера (Telegram/WhatsApp через Integrations): ОПЦІЙНО, лише якщо аудит показав готову інфраструктуру і верифікацію особи; інакше залишити TODO.
9. Усі рішення пишуться в Activity (хто, що, режим, правило, результат).
10. Capability groups для агентів Company (code.read, code.write, code.shell, code.git): без нової permission-системи, через існуючий механізм.

ТЕСТИ:
- Матриця режимів x дій (read, edit, install, test, push, delete, network) дає очікувані рішення.
- Hard deny не обходиться ні режимом, ні правилом, ні "approve for project".
- Prompt injection у файлі/README/веб-результаті не змінює режим і не створює правил.
- Правило проєкту не діє в іншому проєкті/компанії.
- Таймаут approval зупиняє run.
- Агент без capability group отримує permission denied.
- Регресія approvals інших функцій NPATI.

КРИТЕРІЇ ПРИЙМАННЯ:
- У режимі plan запис неможливий; в ask кожен запис запитує approval з diff; в auto_edit редагування автоматичні, а git push вимагає approval; hard deny непорушний.
- SG-2: набір approval-bypass тестів (тег security-gate) проходить і додано в suite.
````

---

## C5a. RBAC для Coding Agent і approvals (обов'язково)

````
ЗАВДАННЯ: розмежування прав людей (не лише capabilities агентів). Спирайся на C5 і існуючу модель ролей NPATI (C0, пункт 18). Нову permission-систему не створювати: розширити існуючу.

Зробити:
1. Ролі на рівні Company: owner, admin, developer, reviewer. Для встановлення з одним власником усі права в owner, але модель і перевірки працюють однаково (готовність до кількох користувачів).
2. Матриця прав (дефолти, конфігуровані власником):
   - Увімкнути режим full_auto_sandbox для проєкту: owner, admin.
   - Використовувати plan, ask, auto_edit: owner, admin, developer.
   - Створювати сесії і запускати run: owner, admin, developer.
   - Підтверджувати звичайні approvals (редагування, безпечні команди, install): owner, admin, developer (власні run-и).
   - push у незахищені гілки: owner, admin, developer. Push агентом у захищені гілки і force push у захищені гілки: hard deny для всіх ролей, включно з owner (зміни потрапляють у захищені гілки лише через PR/merge людиною). Політику захищених гілок змінює лише owner окремою адміністративною дією поза сесією агента (запис в AuditLog, за конфігурацією two-person або step-up); агент і вміст репозиторію її змінити не можуть.
   - Створення PR: owner, admin, developer; схвалення PR/коміту як reviewer: reviewer, admin, owner (не автор).
   - Підтвердження міграцій БД (dev): owner, admin; production-міграції (promote): окремий permission.
   - Змінювати правила проєкту (allow/deny, trust project, hooks, MCP-сервери, розширення мережевого allowlist): owner, admin; developer може лише запропонувати зміну.
   - Змінювати feature flags, ProviderDataPolicy, RBAC: owner (admin лише в межах своєї Company, якщо дозволено).
   - Переглядати сесії, diff, Activity: усі ролі; reviewer лише читання і коментарі, без запуску і редагування.
   - Export/delete даних сесій і проєкту: owner, admin; користувач завжди керує власними сесіями.
3. Production-операції (deploy, promote міграцій у prod, зміна політики захищених гілок, будь-яка операція з production-середовищем) мають окремий permission code.prod.operate, який не входить у жодну роль за замовчуванням. Production-операції виконуються платформними виконавцями (DeployProvider, promote flow), а не credentials в shell агента. Опційно two-person approval (конфігуровано): ініціатор і підтверджувач різні, обидва мають permission, підтверджувач бачить точний payload (перевірка hash), дія обмежена в часі, обидва підтвердження пишуться в AuditLog з однаковим payload_hash. Для встановлення з одним користувачем замість two-person діє step-up: повторна автентифікація або введення підтвердження і затримка (cooldown).
4. Агент не може бути approver: токен сесії агента не має права підтверджувати approvals; підтвердження лише від автентифікованого користувача з потрібною роллю. Approvals з месенджерів (C5, пункт 8) лише для non-production і лише з верифікованою особою.
5. Ефективні права: перетин capability groups агента, ролі користувача, який ініціював run, і правил проєкту. Фонові/автоматичні run-и (Automations) виконуються від service identity з явно обмеженою роллю (не вище developer, ніколи без production-операцій).
6. Централізована перевірка авторизації на сервері, deny by default, використовується інструментами, approvals, API, UI. Перевіряється на кожному tool call, тож зміна ролі діє і в уже запущених сесіях.
7. Аудит: усі рішення авторизації для привілейованих дій, зміни ролей, approvals і відмови пишуться в AuditLog (C1c) з actor, request_id, correlation_id, payload_hash (і snapshot_id після C6b), а також у Activity для трасування.
8. UI: керування ролями в Settings -> Code (або існуючому розділі прав), відображення поточної ролі та причини відмови.

ТЕСТИ (security-gate):
- Матриця роль x дія дає очікувані рішення.
- Спроби ескалації: developer вмикає full_auto через API, через вміст файлу, через зміну правил проєкту; reviewer запускає команду; admin однієї Company діє в іншій.
- Self-approval у режимі two-person відхиляється; replay approval для іншого payload відхиляється.
- Токен агента не може підтвердити approval.
- Зниження ролі посеред run зупиняє дії, що вимагають вищу роль.
- Automation identity не виконує production-операції.
- Регресія існуючих ролей і permissions NPATI.

КРИТЕРІЇ ПРИЙМАННЯ:
- SG-2 (RBAC і approval): набір тестів проходить; жодна production-операція не виконується без code.prod.operate (і two-person/step-up, якщо ввімкнено).
````

---

## C5b. Provider data policy (обов'язково)

````
ЗАВДАННЯ: контроль того, який код і дані можна надсилати кожному AI Provider. Виконується до першого реального виклику моделі в C6. Спирайся на C0 (пункт 22), C4a (secret scanning), C5a.

Зробити:
1. ProviderDataPolicy для кожного AI Provider (за потреби на рівні моделі): kind (hosted_third_party, self_hosted, local), allow_private_repo_code, max_data_classification (public, internal, confidential, restricted), allow_prompt_caching, external_retention (none, N днів, unknown), training_policy (no_training, may_train, unknown), регіон/юрисдикція (опційно), required_redactions (secrets, PII, email, tokens, ключі, внутрішні hostnames), allowed_content_types (код, термінал-вивід, логи, diff, список файлів, веб-вміст), last_reviewed_at, reviewed_by, посилання на умови провайдера. Значення вказує оператор за умовами провайдера; NPATI не може їх перевірити, тому показує дату перегляду і попереджає про застарілі (понад 180 днів).
2. Дефолти консервативні: невідомий або новий hosted-провайдер: лише public, без private-коду, без prompt caching, до явного налаштування; local/self-hosted: до restricted, але з обов'язковою редакцією секретів.
3. Класифікація проєкту: code_project.data_classification (за замовчуванням confidential) і правила за шляхами (наприклад каталоги з секретами restricted, vendor public) у налаштуваннях проєкту. Публічні репозиторії можна позначити public.
4. ProviderDataGuard: єдина точка перед надсиланням будь-чого моделі (основний цикл, стиснення контексту C8, self-review C9, субагенти C12, hooks C13): (a) classification проєкту не вище max провайдера; (b) заборонені типи вмісту видаляються або блокуються; (c) редакція за правилами (secret scanner з C4a, PII-патерни) з placeholder на кшталт «REDACTED:secret_1»; рядки з placeholder позначаються нередагованими для моделі, а edit-інструменти ніколи не записують placeholder на диск; (d) prompt caching вимикається, якщо не дозволений; (e) логуються лише метадані (провайдер, модель, classification, кількість байтів і редакцій, версія політики), без вмісту.
5. Routing: ланцюг primary/fallback/NPATI Auto фільтрується політикою. Провайдер, що не проходить, не використовується мовчки (fallback пропускається). Якщо підходящого провайдера немає, run зупиняється з чітким поясненням. Те саме для моделей субагентів, self-review і стиснення. У UI вибору моделі відображається eligibility.
6. Exfiltration guard для outbound-інструментів NPATI (web search/fetch, email, месенджери, MCP, webhooks): аргументи й тіла запитів перевіряються на секрети і код, що перевищує дозволену classification; підозрілі потребують approval.
7. Прозорість: у Code Workspace видно, яка модель і провайдер отримують код, і classification; при першому підключенні проєкту до hosted-провайдера потрібна явна згода користувача (зберігається).
8. Керування: Settings -> AI Providers -> Data policy і налаштування classification у проєкті; зміни доступні ролям за C5a, версіонуються (policy_version для C6b) і пишуться в AuditLog (C1c).

ТЕСТИ (security-gate):
- Restricted-проєкт не маршрутизується на hosted-провайдера; fallback пропускається; без eligible провайдера run зупиняється.
- Canary-секрет у файлі не потрапляє до mock-провайдера (редакція); placeholder ніколи не записується в файл.
- Prompt caching вимкнений, коли політика забороняє.
- Невідомий провайдер за замовчуванням отримує лише public.
- Субагенти, self-review, стиснення контексту підпорядковуються політиці.
- Outbound web search/email із фрагментом приватного коду або секретом блокується чи потребує approval.
- Зміна політики потребує ролі за C5a, створює нову версію і пишеться в аудит.

КРИТЕРІЇ ПРИЙМАННЯ:
- SG-3 (дані провайдерів): приватний код і секрети не залишають NPATI до провайдерів, що не мають на це дозволу; рішення видно в Activity.
````

---

## C6. Цикл агента (CodingAgentRunner) і адаптери моделей

````
ЗАВДАННЯ: серце harness. Спирайся на C1-C5 і docs/coding-agent/00-audit.md (model capability matrix).

Зробити:
1. CodingAgentRunner: приймає CodeSession і запит користувача; формує system prompt (роль, режим, список доступних tools, інформація про середовище: ОС, cwd, git status коротко, дата; місце для інструкцій проєкту з C8); викликає модель через AI Providers (primary, fallback, NPATI Auto, budget); стрімить текст і tool calls у чат; виконує tool calls (read-only паралельно до 8, запис і shell послідовно); повертає результати моделі; повторює до завершення.
2. Умови зупинки: модель не викликає tools (готово), max turns (40), час (30 хв), бюджет токенів/вартості через існуючу систему, скасування користувачем, невиправна помилка. Кожна зупинка має причину і підсумок для користувача.
3. Захист від зациклення: виявлення повторення однакових викликів і однакових помилок (3 поспіль), у такому разі система вставляє нагадування моделі змінити підхід, а після повторення зупиняє run із поясненням.
4. Обробка помилок: помилка інструмента повертається моделі як структурований результат; невалідні аргументи tool call: до 2 виправлень; помилка провайдера: fallback за існуючим routing; обрив стріму: відновлення без дублювання виконаних tool calls (ідемпотентність за tool_call_id).
5. ToolCallAdapter: нормалізація tool calling між провайдерами (native tool calling, часткові аргументи при стрімі, паралельні виклики) і fallback-режим для моделей без надійного tool calling (структурований формат у тексті з парсером і валідацією). Особливості reasoning-контенту окремих провайдерів у багатоходових розмовах з tools реалізувати за документацією провайдера, перевіреною в C0.
6. Профілі моделей (конфігурація, не код): tool_calling_mode, preferred_edit_tool, max_parallel_tool_calls, context_window, temperature, додаткові рядки prompt, відомі обмеження. Профіль за замовчуванням для невідомих моделей консервативний. Вибір профілю автоматичний за моделлю.
7. Інтеграція з Run/Activity: кожен хід, tool call, прочитаний/змінений файл, команда, approval і помилка потрапляють у Activity & Run Trace. Фінальне повідомлення: що змінено (файли, diff-статистика), результат перевірок, що лишилося.
8. Intent Router: інтенти CREATE_CODE, EDIT_CODE, DEBUG_CODE, EXPLAIN_CODE, REVIEW_CODE, REFACTOR_CODE, TEST_CODE із урахуванням active project/session (розширити існуючий Router, не створювати другий). Запит у чаті ("виправ баг у функції X") запускає CodingAgentRunner у активному проєкті; якщо проєкту немає, питати який.
9. Мінімальний eval-харнес: 8 детермінованих задач (виправити баг, додати функцію, рефакторинг, написати тест, виправити помилку збірки тощо) на малих тестових репозиторіях, з записаними/мок-відповідями моделі для CI та опційним запуском на реальній моделі. Метрики: успіх (тести проходять), кількість ходів, токени, час.
10. Підключення наскрізних вимог (лише через інтерфейси цього кроку): на старті run перевіряється admission образу sandbox (C1b) і викликається ExecutionSnapshotProvider (інтерфейс/hook; у C6 діє NullSnapshotProvider, що повертає порожній snapshot_id, фактична реалізація підключається в C6b); кожен payload до моделі проходить ProviderDataGuard (C5b), а вибір моделі й fallback фільтруються політикою; мережа sandbox лише через egress proxy (C4b); кожна дія проходить RBAC (C5a).

НЕ РОБИТИ: повний UI (C7), стиснення контексту (C8), субагенти (C12).

ТЕСТИ:
- Цикл завершується за кожною з умов зупинки.
- Виявлення зациклення; обрив стріму без повторного виконання tool calls.
- Невалідні аргументи tool call, помилка інструмента, помилка провайдера з fallback.
- ToolCallAdapter: native, часткові аргументи, fallback-режим із некоректним форматом.
- Профіль невідомої моделі.
- Скасування користувачем завершує процеси й звільняє sandbox.
- Ізоляція між користувачами/проєктами; бюджет зупиняє run.
- Регресія звичайного чату і Run Company.

КРИТЕРІЇ ПРИЙМАННЯ:
- У чаті: "виправ падаючий тест у цьому проєкті". Агент читає, редагує, запускає тести, виправляє, показує підсумок. Run видно в Activity. Eval-набір у CI зелений.
````

---

## C6a. Recovery, cleanup, rollback і безпечні DB migrations (обов'язково)

````
ЗАВДАННЯ: система переживає збої, не залишає сміття і не псує дані. Спирайся на C3-C6 та C1a.

Зробити:
1. Стан run як event-log: після кожного ходу і tool call зберігається стан (повідомлення, tool calls з tool_call_id, результати, checkpoint id). Heartbeat і lease на run (15 с / 60 с, конфігуровано).
2. Reconciler при старті сервера і періодично: run зі статусом running без живого lease стає interrupted. Відновлення лише з межі ходу. Tool call, що виконувався: read-only повторюється; write/shell/невідомий автоматично НЕ повторюється, результат позначається unknown_outcome, workspace порівнюється з останнім checkpoint (diff), і ця інформація передається моделі та користувачу перед продовженням. Ідемпотентність за tool_call_id.
3. Відновлення sandbox: health-check; при падінні створюється новий sandbox з workspace і checkpoints (workspace зберігається поза ефемерним контейнером), відновлюється кеш залежностей; фонові процеси позначаються втраченими; сесія продовжується з відповідним повідомленням.
4. Reaper (інтервал 60 с, ідемпотентний, має dry-run): завершує зомбі й осиротілі процеси; убиває tool calls без прогресу вище порога (дефолт 300 с, крім явно довгих задач); зупиняє run-и, що перевищили wall-clock плюс grace; завершує прострочені approvals; видаляє осиротілі sandbox, тимчасові каталоги і незавершені worktrees; звільняє застарілі lock-и (file locks, migration locks) за TTL; контролює диск і inode. Усі дії логуються в Activity і метриках.
5. Rollback невдалих змін: checkpoint на початку run і per-turn (C3). Якщо run завершився failed/cancelled/limit, зміни за замовчуванням лишаються в Changes з пропозицією Revert run. Опційний режим atomic task автоматично повертає стан на початок run, якщо verify не пройшов після ліміту repair. Невдалу збірку не комітити без явного рішення. Після відновлення перевіряти, що workspace не містить частково застосованого patch.
6. Безпечні DB migrations:
   a. Класифікація: виконання міграцій (prisma migrate/db push, drizzle-kit, alembic, django/rails/artisan/knex/typeorm/sequelize/flyway/liquibase/goose/sqlx тощо) і прямий SQL-клієнт (psql, mysql, sqlite3 до не-локальної БД) належать до approval-класу. Написання файлів міграцій це звичайна зміна коду.
   b. Цілі виконання: лише ефемерна БД у sandbox або dev DataBackend через міграційний движок Data Studio (migration lock, snapshot, прапорці destructive/requires_snapshot). Credentials production, зовнішньої або невідомої БД це hard deny (визначення за host/URL/secret reference). Production лише через promote/deploy flow з approval.
   c. Статичний аналіз нових міграцій у diff: DROP, TRUNCATE, DELETE без WHERE, видалення чи перейменування колонок, зміна типів позначаються destructive, вимагають snapshot (де є) і approval; в approval показується план (prisma migrate diff, alembic --sql тощо) і кількість зачеплених даних, якщо відома.
   d. Відкат: вимога down-міграції або описаного плану; невдала міграція відкочується транзакцією, де СУБД це підтримує, інакше відновленням snapshot dev-БД; sandbox-БД ефемерна.
   e. Приховані міграції: аналіз package.json/Makefile/скриптів запуску (prestart, dev, test), які викликають міграції; такі скрипти позначаються й потребують approval.
   f. Агент не отримує і не бачить production DATABASE_URL; тести працюють з ефемерною БД.
7. Chaos-перевірки: kill runner посеред ходу; kill sandbox під час install і apply_patch; обрив мережі; повний диск; перезапуск сервера з активними run-ами.
8. Метрики в Activity: кількість interrupted, recovered, cleaned.

ТЕСТИ:
- Kill runner: run стає interrupted, після рестарту відновлюється з межі ходу без повторного виконання write/shell.
- Kill sandbox: сесія відновлюється з workspace і checkpoints.
- Reaper: зомбі, завислий tool call, осиротілий sandbox, застарілий lock; повторний запуск безпечний.
- apply_patch, перерваний посеред: workspace або повністю до, або повністю після.
- Failed run і atomic task: повертається стан початку run.
- (security-gate) міграція проти production URL це hard deny; destructive у diff потребує approval і snapshot; виконання лише в ефемерній/dev БД; прихована міграція в скрипті виявляється; невдала міграція відкочується.
- Регресія: migration lock і snapshot Data Studio працюють при виклику з агента.

КРИТЕРІЇ ПРИЙМАННЯ:
- Після навмисного падіння runner і sandbox користувач бачить коректний стан, продовжує без втрат і без повторних небезпечних дій.
- Жодна міграція не виконується проти production.
- SG-3: тести recovery/міграцій із тегом security-gate проходять.
````

---

## C6b. Versioned execution snapshot (обов'язково)

````
ЗАВДАННЯ: кожен run можна точно пояснити і, наскільки це можливо, відтворити. Спирайся на C1a (tool manifest), C1b (digest), C5a, C5b, C6, C6a.

Зробити:
1. ExecutionSnapshot: незмінний append-only запис, що створюється на старті сесії і заново (нова версія) на старті кожного run, бо flags і політики можуть змінитись між run-ами. Поля: session_id, run_id, tool_manifest_version, policy_version (policy engine, режими, правила проєкту, RBAC-конфіг), model_profile_version, провайдер, модель і параметри генерації, версія/hash system prompt, runner_version (build/commit), sandbox_image_digest (і посилання на SBOM), feature flags (розв'язані ефективні значення), provider_data_policy_version і classification, base git commit (гілка, наявність незафіксованих змін, hash diff), hash інструкцій проєкту (NPATI.md) і статус довіри, версії toolchain, час, ініціатор і його роль. Без секретів.
2. Версіоновані сховища: політики, model profiles і system prompt зберігаються як незмінні версії з content hash. Зміна створює нову версію, а не редагує стару.
3. Кожна подія Activity і кожен запис AuditLog (C1c) посилаються на snapshot_id. UI/API 'Чому агент так діяв': показує snapshot, а також diff між snapshot двох run-ів.
4. Відтворення, чесно про межі: (a) deterministic replay гарантується лише з recorded/mock provider і recorded tool results: записані відповіді моделі та результати інструментів програються проти зафіксованих версій harness (для тестів і розслідувань); (b) live replay (повторний запуск на живій моделі з тим самим snapshot) має статус best-effort reproducibility: модель, package registries, GitHub і зовнішні сервіси можуть змінитись, тому збіг результату не гарантується, і UI/API це явно позначає.
5. Resume (C10) і відновлення (C6a): якщо flag вимкнено, образ revoked або політика змінилась, створюється нова версія snapshot із показаним diff і повідомленням користувачу.
6. Retention snapshot і метаданих відповідає політиці Activity (R1); вміст промптів, як окремі дані, має власний, коротший retention.
7. Підключення до C6: реалізувати ExecutionSnapshotProvider і замінити NullSnapshotProvider з C6; run-и, створені до C6b, відображаються як legacy_no_snapshot без помилок.

ТЕСТИ:
- Snapshot створюється на кожному run, незмінний; спроба змінити відхиляється.
- Зміна flag/політики між run-ами дає нову версію з коректним diff.
- Усі події Activity мають snapshot_id.
- Deterministic replay з recorded/mock provider і recorded tool results відтворює ту саму послідовність tool calls; live replay позначається best-effort reproducibility.
- Resume з revoked образом створює новий snapshot зі сповіщенням.
- Snapshot не містить секретів (canary-перевірка).

КРИТЕРІЇ ПРИЙМАННЯ:
- Для будь-якого run видно, у якому середовищі й з якими політиками він виконувався, і можна запустити deterministic replay із записаних даних (live replay: best-effort reproducibility).
````

---

## C7. Code Workspace UI (feature complete)

````
ЗАВДАННЯ: інтерфейс для роботи з кодовим агентом. Спирайся на C1-C6, UI Website Builder і design system NPATI.

Зробити:
1. Settings -> Code: список code-проєктів і сесій (вже є мінімум з C1), створення проєкту (import repository, upload, пустий), перейменування, архівація, видалення (підтвердження; видалення прибирає workspace і sandbox).
2. Workspace page: ліворуч дерево файлів; по центру стрім агента (повідомлення, tool calls як згортувані елементи з файлом/командою/результатом, змінені файли з inline diff, plan/todo блок); праворуч перегляд файлу з підсвіткою (використати існуючий editor-компонент, read-only за замовчуванням; ручне редагування лише через revision control з C3, якщо це вписується в архітектуру); внизу вкладки Changes, Terminal, Logs, Activity.
3. Changes: список змінених файлів з diff, дії Revert file / Revert all (через checkpoints).
4. Approval cards: diff або команда з cwd, дії Approve once / for session / for project / Deny + коментар.
5. Панель керування: перемикач режиму (plan/ask/auto_edit/full_auto_sandbox), вибір моделі, Stop, індикатор токенів/вартості, кнопка "Open Preview" для web-проєктів (reuse Live Preview).
6. Інтеграція з чатом NPATI: картка code-проєкту/сесії в звичайному чаті з кнопками Open Workspace / Changes; продовження розмови в чаті використовує active project.
7. Посилання Website Builder -> Open in Code Workspace.
8. Адаптація під mobile (панелі/tabs), клавіатурні скорочення для desktop, стани: порожньо, помилка sandbox, обрив зв'язку.
9. Безпека UI: вивід інструментів рендериться як текст (без виконання HTML/скриптів), посилання з перевіркою.

ТЕСТИ:
- Frontend: рендер стріму, tool calls, diff, approval flow, зміна режиму, Stop.
- Ізоляція: не можна відкрити чужу сесію підміною ID.
- XSS у виводі інструментів і в іменах файлів.
- Регресія Website Builder і Chat.

КРИТЕРІЇ ПРИЙМАННЯ (повний MVP Phase 1):
1. Користувач імпортує репозиторій, у Code Workspace просить зробити зміну, бачить стрім, підтверджує approval, бачить diff і результат тестів.
2. Усе ізольовано, небезпечні дії потребують approval, run видно в Activity.
3. Коли feature flag вимкнений: створення сесій, run, tools і approvals недоступні, а History, Activity, перегляд Changes і Export лишаються в режимі read-only. C7 означає feature complete, але не готовність до rollout (див. G1 і R1).
````

---

## G1. Security Gate Phase 1 (security ready; виконується після C7)

Тести з тегом `security-gate` накопичуються з C2. Контрольні точки: **SG-1** після C4, C4a, C4b і C1b (sandbox escape, secret leak, path traversal, supply chain, мережа, образи), **SG-2** після C5 і C5a (approval bypass, RBAC), **SG-3** після C5b, C6, C6a і C6b (prompt injection end-to-end, дані провайдерів, зловживання циклом, recovery, міграції, snapshot), **G1** після C7 (повний набір, UI, ізоляція). Ступені готовності: C7 = feature complete, G1 = security ready, R1 = production/rollout ready; Phase 1 завершено лише після R1. Вихід за межі internal і просування feature flags дозволені лише після G1 і R1.

````
ЗАВДАННЯ: зібрати, доповнити і зробити обов'язковим security gate. Цей крок змінює лише тести, звіт і CI; знайдені вразливості виправляються окремими змінами у відповідних модулях з регресійним тестом.

Зробити:
1. Suite security-gate у CI: окрема обов'язкова job (не skip-иться, блокує merge/release), hermetic, з детермінованими скриптованими атаками (mock-модель) і опційним прогоном на реальних моделях. Запускається при кожній зміні в sandbox/tools/policy/runner (path-filter) і за розкладом.
2. Покриття:
   a. Sandbox escape: читання шляхів хоста (/proc, /etc, каталоги NPATI, змонтовані томи), docker socket, privileged/capabilities, metadata endpoints (169.254.169.254), доступ до внутрішніх сервісів NPATI, postgres і postgres-projects, доступ до sandbox іншого проєкту чи користувача, мережа поза allowlist, fork bomb, вичерпання диска і пам'яті.
   b. Secret leak: canary-секрети в env хоста, secret storage, .env у workspace, git config, виводі команд; перевірка, що canary не з'являються в prompts до моделі, tool results, Activity, логах, diff, Preview, підсумках, експорті сесії і повідомленнях про помилки.
   c. Path traversal: усі fs-tools (read, grep, edit, apply_patch, write, move, delete), symlink, hardlink, архіви (zip-slip), git операції (.git/config, hooks, submodules), нормалізація unicode, null bytes, довгі шляхи.
   d. Approval bypass: обфускація команд (base64, eval, змінні, підстановки, alias/PATH, heredoc), ланцюжки &&, ;, |, запис скрипта і його запуск, npm run script, що викликає небезпечне, git hooks, зміна режиму з вмісту файлу, зловживання approve-for-project, повторне використання approval для іншої дії, TOCTOU між показаним approval і виконанням (виконується саме те, що схвалено, перевірка hash payload).
   e. Prompt injection: README, NPATI.md/AGENTS.md недовіреного репозиторію, коментарі в коді, вивід команд, веб-сторінки, MCP-відповіді: жодних змін режиму, дозволів, hooks чи витоку секретів.
   f. Supply chain (C4a) і міграції БД (C6a): повторний прогон.
   g. Ізоляція user/company/project/session/sandbox для API, UI, preview, WebSocket/SSE.
   h. UI: XSS у виводі інструментів, іменах файлів і diff; CSRF та ідентифікація на approval endpoints.
   i. Feature flags: вимкнений flag неможливо обійти прямим викликом API/tool; kill switch працює під навантаженням.
   j. RBAC: ескалація ролей, self-approval, replay approval, токен агента як approver, зміна ролі посеред run, automation identity.
   k. Egress: SSRF-набір з C4b (IP-кодування, DNS-rebinding, редиректи на metadata/localhost, внутрішні сервіси NPATI), SSRF-safe клієнт у NPATI-tools.
   l. Sandbox images: запуск unsigned/tag-only/revoked/stale-scan образу неможливий.
   m. Provider data policy: restricted-проєкт не йде на hosted-провайдера, canary-секрети не доходять до mock-провайдера, fallback і субагенти не обходять політику, exfiltration guard.
   n. Audit integrity: UPDATE/DELETE audit-рядків, виявлення зміни в обхід застосунку, розрив ланцюга, fail closed, підміна payload між схваленням і виконанням.
   o. SecretLease і захищені гілки: секрет не успадковується наступним tool call чи фоновим процесом, production-lease не видається; force push і пряма запис агентом у захищені гілки заблоковані для будь-якої ролі, включно з owner, а політику гілок не можна змінити з сесії агента.
3. Mutation-перевірка чутливості suite: у гілці-приманці навмисно послабити контроль (наприклад вимкнути path check або секрет-редакцію) і переконатись, що suite падає.
4. Звіт docs/coding-agent/security-gate-report.md: перелік тестів, результати, відомі прийняті ризики (з власником і терміном), ручний чекліст (конфігурація sandbox, права ролей, мережа) і sign-off.
5. Політика: будь-який fail блокує вихід Phase 1 і просування flags за межі internal; кожна виправлена вразливість додає регресійний тест у suite.

КРИТЕРІЇ ПРИЙМАННЯ:
- Усі тести зелені; mutation-перевірка підтверджує, що suite ловить послаблення захисту.
- Звіт підписаний. Rollout дозволений лише після G1 і R1 (спершу allowlist користувачів/Company).
````

---

## R1. Rollout readiness: ліміти, observability, SLO і data lifecycle (production/rollout ready; завершує Phase 1)

Вихід за межі internal дозволений лише після **G1 і R1**. Нові збережені сутності з C1 уже мають data_classification і retention_class (правило 18); тут реалізуються ліміти, спостережуваність і життєвий цикл даних.

````
ЗАВДАННЯ: виробничі обмеження, спостережуваність і керування даними. Спирайся на C0 (пункти 21 і 23), C6a (reaper), C6b.

A. Ліміти і квоти (усе конфігуроване, значення нижче це стартові)
1. Rate limits: запуски run-ів на користувача і на Company за період; паралельні run-и (стартово 2 на користувача, 5 на Company); паралельні sandbox (стартово 5 на Company).
2. Бюджети: токени і вартість на run, на день, на Company; через існуючу систему routing/budget; зупинка з чітким поясненням і сповіщенням при 80% і 100%.
3. Черга з backpressure: обмежена довжина (стартово 50), справедливе планування між Company, відмова з retry-after при переповненні, видимий стан у UI.
4. Ресурсні квоти: CPU/RAM/disk/pids на sandbox (стартово 2 vCPU, 4 ГБ, 10 ГБ, 512 pids) і сумарно на Company; admission control: нові sandbox не запускаються, коли хост перевантажений (стартово CPU вище 80% або вільної RAM менше 15%).
5. Квоти застосовуються на сервері і не обходяться через API, субагентів чи Automations.

B. Observability, SLO і алерти
6. Метрики, логи і tracing для runner, sandbox, черги, інструментів, провайдерів (без вмісту промптів і секретів).
7. Метрики: sandbox startup time, queue wait, tool error rate, recovery rate (успішні відновлення серед interrupted), provider fallback rate, p95 run latency, cost per run, частка approvals, використання квот.
8. Стартові SLO (калібрувати за результатами evals C14): sandbox startup p95 не більше 20 с (холодний) і 5 с (теплий); queue wait p95 не більше 30 с; tool error rate не більше 5%; recovery success не менше 95%; алерт при provider fallback rate вище 20% за годину; алерт при cost per run більше 3x від медіани.
9. Алерти власнику через існуючі канали (Integrations, email), runbook для кожного алерту (що перевірити, як вимкнути flag, як очистити чергу). Окремий критичний алерт при розриві ланцюга AuditLog (C1c) або невдалій верифікації anchor. Опційне автовимкнення flags (C1a) при порушенні SLO чи security-подіях.
10. Сторінка стану Coding Agent (в Activity або Connected Services): стан черги, sandbox, провайдерів, квоти.

C. Data lifecycle і privacy
11. Retention classes для: prompts і transcripts, tool results, terminal logs, checkpoints, workspaces, sandbox artifacts, snapshots, summaries, Activity-події. Стартові значення: tool results і terminal logs 30 днів, transcripts 90 днів, checkpoints 30 днів після завершення сесії, sandbox artifacts 7 днів, workspaces до видалення/архівації проєкту (архівовані 90 днів), Activity-метадані довше. Усе конфігуроване; classification впливає на строки.
12. Автоочищення: періодична задача (на базі reaper із C6a), ідемпотентна, з dry-run, лог результатів.
13. Export і delete користувачем: експорт сесій і diff у Markdown/JSON (без секретів); видалення сесії або проєкту прибирає transcripts, tool results, логи, checkpoints, workspace, sandbox artifacts, кеші, summaries; після видалення перевірка, що даних не лишилось.
14. Backups: секрети ніколи не потрапляють у backups (secret storage виключене або шифроване окремо); файли за secret-патернами виключаються з checkpoints і backups; backups шифровані й мають обмежений retention. Задокументувати, що видалені дані лишаються в backups до кінця їх retention.
15. Дані, надіслані зовнішнім провайдерам, підпадають під їхні умови (див. ProviderDataPolicy C5b); показати користувачу це в налаштуваннях приватності.
16. AuditLog (C1c) має окремий довший retention і не підпадає під автоочищення логів; видалення даних користувача лишає в аудиті лише id і хеші.

ТЕСТИ:
- Rate limit, concurrent sandbox, бюджет і черга спрацьовують і не обходяться (через API, субагентів, Automations).
- Backpressure: переповнена черга повертає retry-after; перевантажений хост не запускає нові sandbox.
- Метрики й алерти спрацьовують на штучні збої (повільний старт sandbox, спалах помилок інструментів, масові fallback).
- Retention: дані старіші за строк очищаються; export не містить секретів; delete прибирає все (перевірка по сховищах).
- Canary-секрет не потрапляє в backup, checkpoints або export.
- Ізоляція квот між Company.

КРИТЕРІЇ ПРИЙМАННЯ:
- Є дашборд і алерти за SLO; ліміти діють; retention, export і delete працюють; канарка секрету відсутня в backups.
- Після G1 і R1 дозволений rollout за межі internal (allowlist, далі відсоток).
````

---

## C8. Керування контекстом

````
ЗАВДАННЯ: щоб агент працював із великими репозиторіями і довгими сесіями. Спирайся на C6-C7.

Зробити:
1. Файл інструкцій проєкту NPATI.md у корені (читати також AGENTS.md як сумісність; ієрархія: глобальні інструкції користувача -> проєкт -> підкаталог). Додавання в system prompt з лімітом розміру. Команда init: агент аналізує репозиторій і пропонує чернетку NPATI.md (запис лише після approval).
2. ДОВІРА: інструкції з імпортованого/клонованого репозиторію вважаються ненадійними; до явного "trust this project" вони показуються як дані і не можуть змінювати правила, режими, hooks. Після довіри діють лише як стилістичні/проєктні інструкції, без права підвищувати дозволи.
3. Repo map: стислий ранжований огляд символів і файлів (tree-sitter або еквівалент) з кешем за commit hash, лімітом токенів, оновленням після змін.
4. Керування вихідними даними: обрізання, вікна читання, заміна старих результатів інструментів на короткі заглушки, коли контекст зростає, зі збереженням самих викликів.
5. Стиснення розмови при 75% вікна моделі (враховувати context_window з профілю): структурований підсумок (мета, прийняті рішення, змінені файли, виконані команди і результати, відкриті проблеми, наступні кроки) + останні N ходів дослівно. Підсумок зберігається як артефакт сесії і не містить секретів.
6. Prompt caching: стабільний префікс prompt (system, tools, інструкції) для провайдерів, що це підтримують.
7. Інтеграція з Company Memory (читання релевантних постійних правил компанії) і Project Context із Website Builder; не змішувати з NPATI.md; секрети не потрапляють у контекст.

ТЕСТИ:
- Ієрархія інструкцій; обмеження розміру.
- Інструкція з недовіреного репозиторію не змінює дозволи (injection-тест).
- Стиснення зберігає ключові факти (скриптована перевірка на сесії зі штучними фактами).
- Repo map коректний і кеш інвалідовується після змін.
- Обрізання результатів не ламає цикл.

КРИТЕРІЇ ПРИЙМАННЯ:
- Сесія на великому репозиторії з 100+ ходів проходить із автоматичним стисненням без втрати мети і рішень; NPATI.md використовується тільки після довіри.
````

---

## C9. Планування, todo, верифікація і self-review

````
ЗАВДАННЯ: якість результату, а не лише виконання. Спирайся на C5-C8.

Зробити:
1. Plan mode: в режимі plan агент досліджує код і створює план (файли, кроки, ризики, стратегія тестів); користувач затверджує, редагує або відхиляє; після затвердження запускається виконання в обраному режимі. План зберігається в сесії.
2. Todo tool (code.plan.update): список задач із статусами (pending, in_progress, completed), не більше однієї in_progress; відображається в UI; агент оновлює його під час роботи.
3. Verification loop: після змін агент запускає verify (lint/typecheck/тести, що стосуються змін). При невдачі repair loop максимум 3 спроби; після ліміту зупинка із звітом, що саме не проходить. Не видаляти й не послаблювати тести, щоб "зеленіло"; зміна існуючих тестів потребує обґрунтування в підсумку.
4. Self-review: один прохід перегляду власного diff окремим prompt (за потреби іншою моделлю): помилки, секрети, зайві зміни, відсутні тести, стиль. Максимум 1 ітерація виправлень.
5. Інструмент ask_user (code.ask_user): структуроване питання з варіантами; ставить run на паузу; відповідь в UI (і з месенджера, якщо C5 це підтримує).
6. Scope guard: попередження, якщо diff охоплює більше N файлів (конфігуровано) або файли, не пов'язані із запитом.
7. Формат підсумку: що зроблено, змінені файли, результат перевірок, ризики, що не зроблено.
8. Правило написання тестів: за наявності тестової інфраструктури нова поведінка супроводжується тестом.

ТЕСТИ:
- Plan mode не змінює файли; затвердження запускає виконання.
- Repair loop зупиняється після 3 спроб.
- Спроба видалити падаючий тест позначається у звіті.
- ask_user ставить run на паузу і відновлює його.
- Self-review знаходить внесений у тесті секрет/зайву зміну.
- Eval-набір із C6 розширений задачами на verification і не регресує.

КРИТЕРІЇ ПРИЙМАННЯ:
- Складна задача: plan -> approval -> реалізація -> тести -> self-review -> підсумок із чесним статусом перевірок.
````

---

## C10. Сесії, checkpoints, resume, фонові задачі

````
ЗАВДАННЯ: довговічність роботи. Спирайся на C1-C9.

Зробити:
1. Збереження сесії: повідомлення, tool calls, підсумки стиснення, план/todo, стан режиму і правил.
2. Resume: продовження сесії після перезапуску браузера і сервера; запущені процеси позначаються як втрачені, workspace і checkpoints відновлюються.
3. Rewind: повернення до checkpoint будь-якого ходу у трьох варіантах: лише код, лише розмова, обидва. Rewind сам створює checkpoint перед відкатом.
4. Fork сесії (нова гілка розмови з того самого checkpoint).
5. Фонові run-и: довга задача триває після закриття вкладки; завершення, помилка або запит approval надсилаються існуючими каналами сповіщень (Integrations); можна повернутись у стрім.
6. Черга і ліміти: паралельні run-и на користувача/Company (конфігуровано), справедлива черга, відображення стану в UI.
7. Життєвий цикл sandbox: автозупинка при неактивності, відновлення при resume, очищення за політикою збереження, видалення разом із проєктом.
8. Експорт сесії у Markdown (без секретів).

ТЕСТИ: перезапуск посеред run, rewind (код/розмова/обидва), fork, фонова задача із approval, ліміти паралельності, очищення sandbox, ізоляція користувачів.
КРИТЕРІЇ: користувач запускає довгу задачу, закриває вкладку, отримує сповіщення про запит approval, підтверджує, run завершується; після цього може відкотити останній хід.
````

---

## C11. Git workflow і Pull Request

````
ЗАВДАННЯ: нормальний процес роботи з гілками і PR. Спирайся на Git layer Website Builder (перевикористати) і C3-C5.

Зробити:
1. Capabilities code.git.*: status, diff, log, branch create/switch, stage, commit, restore. Push і create PR через існуючу GitHub integration, лише з approval.
2. Авто-гілка на сесію (наприклад npati/{session-short-id}), щоб робота не торкалась основної гілки. Захищені гілки (шаблони за замовчуванням: main, master, release/*, конфігуровано): пряма запис агентом і force push заборонені для всіх (hard deny, включно з owner); зміни потрапляють лише через PR і merge людиною. Політику захищених гілок змінює тільки owner окремою адміністративною дією поза сесією агента (AuditLog, за конфігурацією two-person/step-up); агент і вміст репозиторію її змінити не можуть.
3. Коміт: агент генерує повідомлення за стилем репозиторію (аналіз git log); коміт після approval у режимах ask/auto_edit.
4. Конфлікти: структуровані помилки; максимум 2 спроби auto-resolve, далі питання користувачу.
5. Опис PR: автогенерація (що змінено, як перевірено, ризики) із підсумку сесії; створення PR після approval.
6. Інтент REVIEW_CODE: read-only перегляд diff/PR з коментарями за категоріями (баги, безпека, стиль, тести); коментарі в PR лише з approval.
7. Git credentials у secret storage, ніколи у prompts/логах; для push/clone видаються як SecretLease на один git-виклик (credential helper), не зберігаються в .git/config і не успадковуються наступними викликами.

ТЕСТИ: гілка на сесію, коміт, захищена гілка, push без approval заблоковано, конфлікт, генерація PR, REVIEW_CODE не пише в репозиторій, ізоляція, витік credentials.
КРИТЕРІЇ: задача -> гілка -> зміни -> тести -> коміт -> PR з описом, push тільки після підтвердження.
````

---

## C12. Субагенти і паралельна робота

````
ЗАВДАННЯ: розділення роботи між агентами. Спирайся на C6-C11 і Company agents.

Зробити:
1. Інструмент code.agent.spawn: типи explore (read-only, швидка/дешева модель), plan, implement (обмежена область), review, test. Кожен субагент має власне вікно контексту і повертає основному агенту лише підсумок.
2. Обмеження: глибина 1 (субагенти не створюють субагентів), до 4 паралельно, capabilities субагента не ширші за батьківського, спільний бюджет токенів, власний ліміт ходів.
3. Інтеграція з Company: вибір виконавця за role, description, instructions, capabilities, model (не за agent.name); використовувати існуючі режими single/pipeline/fusion/auto. Не створювати другий orchestration engine.
4. Паралельні implement-задачі: ізоляція через git worktree/гілку на агента (reuse Website Builder, крок worktrees), file locking і expected_revision як запобіжник; після завершення review -> merge -> verify. Конфлікти merge: структурована ескалація.
5. Activity: вкладені trace для субагентів, видимі статуси задач.
6. Для explore-задач включити прості типи за замовчуванням (пошук у репозиторії, огляд архітектури), щоб основний контекст не засмічувався.

ТЕСТИ: ліміти глибини і паралельності, звуження capabilities, паралельні зміни різних файлів, конфлікт merge, падіння субагента не вішає run, бюджет, вибір за role а не за ім'ям, регресія режимів Run Company.
КРИТЕРІЇ: велика задача розбивається на explore + кілька implement + review із видимим деревом у Activity і без перезапису чужих змін.
````

---

## C13. Розширення: hooks, slash commands, skills, MCP

````
ЗАВДАННЯ: налаштовуваність. Спирайся на C5-C12.

Зробити:
1. Hooks (конфігурація в .npati/ у проєкті або в налаштуваннях користувача): події SessionStart, PreToolUse, PostToolUse, Stop. Hook виконується в sandbox або як webhook; може блокувати виклик, додати контекст, запустити форматер/лінтер. Hook НЕ може підвищити дозволи. Hooks з імпортованого репозиторію вимкнені до "trust this project".
2. Slash commands: markdown-шаблони промтів у .npati/commands/ (наприклад /review, /test, /explain) з параметрами; користувацькі і проєктні.
3. Інтеграція зі Skills (/settings/skills): підвантаження skill на вимогу за описом, без роздування контексту.
4. MCP: підключення зовнішніх MCP-серверів як tool providers через існуючу архітектуру інтеграцій. Їх tools з'являються в Capability Inspector з risk; невідомі за замовчуванням потребують approval. Відповіді MCP вважаються даними (захист від injection).
5. Порядок пріоритету налаштувань: system -> користувач -> проєкт -> сесія; ніколи не знижують hard deny.

ТЕСТИ: hook блокує виклик; hook не обходить approval; hook з недовіреного репозиторію не виконується; slash command; MCP tool з approval; injection через MCP-відповідь; пріоритет налаштувань.
КРИТЕРІЇ: користувач додає hook форматера і slash-команду /review, підключає MCP-сервер, усе видно в Capability Inspector і не послаблює безпеку.
````

---

## C14. Evals, метрики і hardening

````
ЗАВДАННЯ: виміряти і закріпити якість та безпеку. Мінімальний security gate вже пройдений у G1; цей крок розширює покриття і додає якість (evals). Спирайся на всі попередні кроки.

Зробити:
1. Розширений eval-набір: 30+ hermetic-задач у 3+ мовах (баг, фіча, рефакторинг, написання тестів, багатофайлова зміна, виправлення збірки, міграція залежності). Оцінка: тести проходять, розмір diff, ходи, токени, вартість, час.
2. Запуск набору на кожному профілі моделі і порівняльний звіт; smoke-підмножина в CI; запис/відтворення відповідей провайдера для детермінованих тестів.
3. Метрики в Activity: success rate, середня кількість ходів, частка невдалих edit-викликів, частка approvals, tool error rate, витрати на run.
4. Розширення red-team suite з G1 (G1 лишається обов'язковим; тут додаються нові класи атак і ширші сценарії): prompt injection через файл/README/NPATI.md/веб/MCP/вивід команди; спроби витоку секретів; спроби втечі з sandbox; path traversal; fork bomb і вичерпання ресурсів; нескінченні цикли; обхід approval через переформулювання; підміна режиму з вмісту файлу; атаки на supply chain і міграції БД.
5. Тонке налаштування лімітів і SLO, започаткованих у R1: бюджети за моделями, виявлення аномалій вартості і поведінки, калібрування порогів за результатами evals.
6. Документація: архітектура, налаштування режимів, безпека, профілі моделей, як додати нову модель і новий tool.
7. Орієнтовні пороги приймання (скоригувати за результатами): успіх edit-інструмента на наборі не нижче 95%, 0 успішних атак у red-team наборі, 0 виходів за межі sandbox.

КРИТЕРІЇ ПРИЙМАННЯ: звіт із метриками по моделях, усі red-team тести пройдені, документація готова, CI блокує регресії.
````

---

## C15. Опційно: локальна папка, CLI, IDE

````
ЗАВДАННЯ: розширити способи входу. Виконувати лише якщо потрібно, після C14.

Зробити:
1. Mounted local folder як WorkspaceProvider: користувач явно додає каталог (allowlist), вибирає ro/rw, підтверджує; жодного доступу до інших шляхів; захист від symlink-виходів; код і команди все одно виконуються в sandbox із цим монтуванням.
2. CLI-клієнт (наприклад npati code) для локального терміналу: автентифікація токеном до локального NPATI API, стрім сесії, approvals у терміналі.
3. Протокол для IDE (VS Code-розширення) як окремий наступний етап; зараз лише специфікація API.
4. ExternalAgentAdapter (опційно): запуск зовнішнього CLI-агента (Claude Code, Codex) як субагента в sandbox із ключами користувача, під тими самими approvals і sandbox-політиками.

ТЕСТИ: монтування поза allowlist відхиляється, symlink-втеча, ro-режим не дозволяє запис, токен CLI ізольований, зовнішній агент не обходить policy.
````

---

## Фази

- **Phase 1 (MVP):** C0, C1, C1c, C1a, C1b, C2, C3, C4, C4a, C4b, C5, C5a, C5b, C6, C6a, C6b, C7, G1, R1. Ступені готовності: **C7 = feature complete, G1 = security ready, R1 = production/rollout ready, Phase 1 complete лише після R1.** Після C7 користувач може працювати з кодом у чаті й у Code Workspace, але до G1 і R1 функція доступна тільки на етапі internal (за feature flags). Вихід за internal дозволений лише після G1 і R1.
- **Phase 2:** C8-C11. Великі репозиторії, якість, довговічність, git/PR.
- **Phase 3:** C12-C15. Субагенти, розширення, evals і hardening, локальний режим.

Контрольні точки безпеки не відкладаються до C14: SG-1 після C4/C4a/C4b/C1b, SG-2 після C5/C5a, SG-3 після C5b/C6/C6a/C6b, G1 після C7. Ліміти, SLO і data lifecycle (R1) також не відкладаються. C14 розширює покриття і додає evals якості, його варто запускати після Phase 1 і повторювати після кожної фази.

## Відкриті питання (вирішити за результатами C0)

1. Який стан Website Builder (sandbox, terminal, git уже є чи ні): від цього залежить обсяг C1 і C4.
2. Особливості tool calling і reasoning-контенту у ваших конкретних моделях (DeepSeek, локальні): визначають ToolCallAdapter і профілі.
3. Чи потрібен режим змонтованої локальної папки (C15) раніше: це суттєво змінює модель безпеки.
4. Чи потрібні approvals з Telegram/WhatsApp: потребує верифікації особи.
5. Ліцензії референсних відкритих harness-проєктів, якщо захочете запозичувати код, а не лише ідеї.
6. Чи є в NPATI система feature flags/runtime-конфігу без деплою, чи потрібна мінімальна власна (рішення в C0, реалізація в C1a).
7. Один власник чи кілька користувачів: від цього залежить, наскільки реальні RBAC і two-person approval (для одного користувача діє step-up замість two-person).
8. Які саме AI Providers ви використовуватимете і який рівень даних дозволяєте кожному: політику ви задаєте самі за умовами провайдера, NPATI не може її перевірити.
9. Ізоляція sandbox: звичайні контейнери чи сильніша (gVisor, Kata, Firecracker): компроміс між безпекою, швидкістю і складністю розгортання.
10. Хто і де робить backups зараз і чи можливо виключити секрети та secret-файли з них.
11. Де зберігати anchor хеш-ланцюга AuditLog поза основною БД (окремий volume, підписаний файл, зовнішній timestamp) і чи потрібна підписана верифікація власником.

## Чекліст регресії після кожного кроку

- Company, агенти, Main Agent, Memory, Knowledge
- Run Company: auto, single, pipeline, fusion
- Capability Inspector (нові capabilities з коректним risk і approval)
- Activity & Run Trace
- Website Builder і Data Studio (Projects, Files, Terminal, Preview, DataBackend)
- AI Providers, Integrations, Automations, звичайний Chat
- Feature flags: вимкнений Coding Agent не впливає на інші функції NPATI
- security-gate suite зелений (контрольні точки SG-1/SG-2/SG-3/G1)
- RBAC і політика даних провайдерів не ламають існуючі ролі та routing інших функцій NPATI
- Ліміти, квоти і retention Coding Agent не впливають на інші функції
- AuditLog append-only, ланцюг верифікується, привілейовані дії fail closed
- typecheck, lint, tests, build
