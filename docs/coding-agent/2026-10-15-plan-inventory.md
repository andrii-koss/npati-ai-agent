# Coding Agent requirement inventory — 2026-10-15

This is a source-to-plan inventory, not a declaration of completion. `Untested` means the individual requirement has not been certified end to end in this audit. Stage test suites are supporting evidence, not substitutes for acceptance. `Partial` rows have explicit targeted evidence and an unresolved acceptance boundary. The current result and blockers are in [the audit report](2026-10-15-full-system-audit.md).

Inventory: 431 numbered or bulleted plan entries across 27 stages. Shared rules, architecture decisions and unnumbered prose remain in PLAN.md; they are not falsely counted as independently verified here.

## C0 evidence

[00-audit.md](../../docs/coding-agent/00-audit.md), [architecture.md](../../docs/coding-agent/architecture.md)

Supporting suites: No stage-named suite; see runtime acceptance and report.

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [197](PLAN.md) | Runtime агента: де цикл відповіді в чаті, як виконуються tool calls, чи є вже багатокрокові цикли, як працює streaming (SSE/WebSocket), скасування, обробка помилок. | Untested | Not individually certified. |
| [198](PLAN.md) | AI Providers: які провайдери і моделі підтримуються; для кожного: native tool calling, паралельні виклики, streaming аргументів, JSON mode, вікно контексту, підтримка prompt caching, reasoning-контент і його вимоги в багатоходових розмовах з tools (особливо для DeepSeek-подібних і локальних моделей). Таблиця model capability matrix. Routing, fallback, budget. | Untested | Not individually certified. |
| [199](PLAN.md) | Website Builder (/settings/websites): що реалізовано фактично: Project, Workspace, SandboxProvider, Files, Terminal, Git, Checkpoints, Preview, file revision/locking, risk classification команд. Що готове до перевикористання, чого бракує. | Untested | Not individually certified. |
| [200](PLAN.md) | Capability registry (306 canonical capabilities): існуючі capabilities файлів, shell, git, пошуку, веб; naming convention; як додати групу code.*; як у Capability Inspector відображається risk, approval, agent callable. | Untested | Not individually certified. |
| [201](PLAN.md) | Approval mechanism: як запитується і підтверджується, які дані показуються користувачу, чи підтримує payload із diff/командою, чи можна відповідати з Telegram/WhatsApp (Integrations). | Untested | Not individually certified. |
| [202](PLAN.md) | Runs/Tasks/Activity & Run Trace: модель подій, як додати події tool call, file read/edit, command, approval, subagent. | Untested | Not individually certified. |
| [203](PLAN.md) | Company agents: ролі, capabilities, ієрархія, як Main Agent делегує; режими single/pipeline/fusion/auto. | Untested | Not individually certified. |
| [204](PLAN.md) | Intent Router і chat: як додати інтенти для коду і як зберігається active project. | Untested | Not individually certified. |
| [205](PLAN.md) | Сховище сесій і повідомлень, Memory, Skills (/settings/skills), Automations, background jobs, MCP/зовнішні інтеграції. | Untested | Not individually certified. |
| [206](PLAN.md) | Sandbox: які образи і мови доступні, ресурсні ліміти, мережева політика, чи є git, ripgrep, build tools, чи достатньо для Node, Python, Go, Rust, Java, PHP. | Untested | Not individually certified. |
| [207](PLAN.md) | UI: наявні компоненти редактора/diff/терміналу/дерева файлів, design system, mobile. | Untested | Not individually certified. |
| [208](PLAN.md) | Ліцензії відкритих harness-проєктів, які можна вивчати як референс (перевірити актуальні ліцензії; код не копіювати без явного дозволу ліцензії і мого підтвердження). | Untested | Not individually certified. |
| [209](PLAN.md) | Feature flags і конфігурація: чи є існуюча система flags або runtime-конфігу без деплою, scope (global/company/user), кеш, аудит змін. | Untested | Not individually certified. |
| [210](PLAN.md) | Версіонування: конвенції версій capabilities і API в NPATI, як зберігаються tool calls у Run/Activity (формат і чи є версія), як міграції схеми влаштовані (чи можливий expand/contract). | Untested | Not individually certified. |
| [211](PLAN.md) | Supply chain: які менеджери пакетів і версії є в sandbox-образах, наявність npm/pnpm audit, pip-audit, composer audit, cargo audit або OSV-scanner, конфіги registry, можливість мережі в дві фази (fetch і build). | Untested | Not individually certified. |
| [212](PLAN.md) | Recovery: існуючі heartbeat/lease, job scheduler для reaper, як sandbox перезапускається, де зберігається workspace (чи переживе він падіння контейнера), як зараз виконуються міграції БД і інтеграція з Data Studio (migration lock, snapshots). | Untested | Not individually certified. |
| [213](PLAN.md) | Існуючі security-тести й CI: чи є job для безпеки, як додати обов'язкову job security-gate, які hermetic-мок моделей уже існують. | Untested | Not individually certified. |
| [214](PLAN.md) | RBAC: існуюча модель ролей і permissions NPATI (власник, члени Company), ідентифікація approver, чи можливий режим кількох користувачів, як працюють Automations (від чийого імені). | Untested | Not individually certified. |
| [215](PLAN.md) | Образи і ізоляція: як будуються й де зберігаються sandbox-образи, чи є registry і підпис, можливість SBOM/scan; оцінити сильнішу ізоляцію (gVisor, Kata, Firecracker) порівняно зі звичайними контейнерами для недовіреного коду. | Untested | Not individually certified. |
| [216](PLAN.md) | Мережа: як зараз налаштована мережа sandbox (docker network, firewall), чи можливий egress proxy і власний DNS-resolver, SSRF-захист існуючих NPATI-tools (web fetch, search, MCP). | Untested | Not individually certified. |
| [217](PLAN.md) | Дані: що і де зберігається (prompts, логи, Activity, workspaces), існуючі retention, backups і що в них потрапляє, secret storage. | Untested | Not individually certified. |
| [218](PLAN.md) | AI Providers: де зберігається конфігурація провайдерів і routing, чи є поняття локального/self-hosted провайдера, prompt caching, де можна додати ProviderDataPolicy. | Untested | Not individually certified. |
| [219](PLAN.md) | Observability: існуючі метрики, логи, tracing, алерти, rate limiting і бюджети; скільки ресурсів хоста доступно під sandbox. | Untested | Not individually certified. |
| [220](PLAN.md) | Audit і секрети: існуючі audit-механізми, можливість append-only таблиць (права БД, тригери), місце для anchor хеш-ланцюга поза основною БД; можливості secret storage видавати короткоживучі scoped credentials (lease/token). | Untested | Not individually certified. |
| [223](PLAN.md) | Таблиця "Що вже є -> де -> що перевикористати/розширити". | Untested | Not individually certified. |
| [224](PLAN.md) | Model capability matrix. | Untested | Not individually certified. |
| [225](PLAN.md) | Що створити з нуля. | Untested | Not individually certified. |
| [226](PLAN.md) | Пропозиція архітектури CodingAgentRunner у межах існуючої Run-інфраструктури: де живе цикл, як зберігається стан сесії, як інтегрується з Company agents. | Untested | Not individually certified. |
| [227](PLAN.md) | Пропозиція ToolCallAdapter для моделей без надійного native tool calling. | Untested | Not individually certified. |
| [228](PLAN.md) | Висновок: чи потрібно розширювати sandbox-образи, і які. | Untested | Not individually certified. |
| [229](PLAN.md) | Модель загроз: prompt injection із репозиторію/веб, витік секретів, втеча з sandbox, нескінченні цикли, витрата бюджету. | Untested | Not individually certified. |
| [230](PLAN.md) | Ризики та відкриті питання до мене. | Untested | Not individually certified. |
| [231](PLAN.md) | Уточнений поділ кроків C1-C15, а також C1a, C1b, C1c, C4a, C4b, C5a, C5b, C6a, C6b, G1, R1 під реальну архітектуру, з планом контрольних точок SG-1/SG-2/SG-3. | Untested | Not individually certified. |
| [234](PLAN.md) | Змінений лише docs/coding-agent/00-audit.md (git status). | Untested | Not individually certified. |
| [235](PLAN.md) | Кожне твердження має посилання на файл. | Untested | Not individually certified. |
| [236](PLAN.md) | Є явні рекомендації щодо: місця циклу агента, перевикористання Website Builder, формату редагування для кожного профілю моделі. | Untested | Not individually certified. |

## C1 evidence

[code-service.ts](../../apps/agent-api/src/code-service.ts), [code-toolchain-detector.ts](../../apps/agent-api/src/code-toolchain-detector.ts), [code-session.ts](../../packages/workspace/src/types/code-session.ts)

Supporting suites: [coding-agent-c1-foundation.test.ts](../../tests/coding-agent-c1-foundation.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [248](PLAN.md) | Тип проєкту code_project (розширюваний enum; Website Builder проєкти лишаються валідними і теж доступні для кодування). Поля toolchain/languages, default branch, verify_commands (конфігуровані), data_classification (public, internal, confidential, restricted; дефолт confidential) і retention_class. | Untested | Not individually certified. |
| [249](PLAN.md) | WorkspaceProvider (перевикористати/розширити ProjectWorkspace): managed workspace і git clone (з існуючої GitHub integration, приватні репозиторії через secret storage). Інтерфейс готовий до змонтованої локальної папки (C15), але вона НЕ реалізується. | Untested | Not individually certified. |
| [250](PLAN.md) | Автовизначення toolchain: Node (npm/pnpm/yarn), Python (pip/poetry/uv), Go, Rust, Java (maven/gradle), PHP (composer). Визначення тестових, lint, typecheck і build команд з package.json, pyproject, Makefile, go.mod, Cargo.toml тощо. Результат зберігається як project metadata і може бути виправлений користувачем. | Untested | Not individually certified. |
| [251](PLAN.md) | Sandbox образи: за висновком аудиту додати/розширити образи (git, ripgrep, build-essential, потрібні runtime). Непривілейований користувач, ліміти CPU/RAM/disk/pids, мережа за allowlist (package registries, налаштовані git-хости). Без docker socket і без монтування хоста. | Untested | Not individually certified. |
| [252](PLAN.md) | CodeSession: id, project_id, company_id, user_id, agent_id, mode, model_profile, status, parent_session_id, created_at, updated_at, summary, data_classification (успадковується від проєкту; підняти можна, знизити лише роллю за C5a), retention_class. Зв'язок із існуючим Run (reuse, не дублювати). Перевірка належності на сервері. | Untested | Not individually certified. |
| [253](PLAN.md) | API: create/get/list/archive code project; створення, перегляд, архівація сесій. Імпорт репозиторію (reuse кроку імпорту Website Builder, якщо є). | Untested | Not individually certified. |
| [254](PLAN.md) | Мінімальний UI: розділ Settings -> Code (/settings/code) зі списком code-проєктів та сесій (інтегрувати в навігацію поряд із Website Builder, design system NPATI). Повноцінний workspace UI буде в C7. | Untested | Not individually certified. |
| [255](PLAN.md) | Налаштування за замовчуванням: ліміти з таблиці в плані, зберігаються як конфігурація, не hardcode. | Untested | Not individually certified. |
| [256](PLAN.md) | Довідники data_classification (public, internal, confidential, restricted) і retention_class (ephemeral, short, standard, extended, until_deleted). Реальні строки задаються в R1, тут лише enum і поля. Усі сутності, що з'являються в C1-C6 (CodeSession, transcripts, tool results, термінал-логи, checkpoints, workspaces, sandbox artifacts, summaries, snapshots), створюються з обома полями (правило 18). | Untested | Not individually certified. |
| [261](PLAN.md) | CRUD code project і session; ізоляція між компаніями та користувачами. | Untested | Not individually certified. |
| [262](PLAN.md) | Визначення toolchain на тестових репозиторіях (Node, Python, Go). | Untested | Not individually certified. |
| [263](PLAN.md) | Клонування приватного репозиторію без доступу завершується структурованою помилкою; credentials не потрапляють у логи. | Untested | Not individually certified. |
| [264](PLAN.md) | Sandbox: непривілейований користувач, не бачить хоста та інших проєктів, мережа лише за allowlist. | Untested | Not individually certified. |
| [265](PLAN.md) | Website Builder проєкти продовжують працювати. | Untested | Not individually certified. |
| [266](PLAN.md) | Проєкт і сесія мають data_classification і retention_class; classification сесії не нижча за проєктну; зниження без потрібної ролі відхиляється. | Untested | Not individually certified. |
| [269](PLAN.md) | Користувач імпортує репозиторій, система визначає toolchain і verify-команди, створюється CodeSession, у Settings -> Code видно проєкт і сесію. Тести зелені. | Untested | Not individually certified. |

## C1a evidence

[feature-flags.ts](../../apps/agent-api/src/feature-flags.ts), [code-tool-registry.ts](../../apps/agent-api/src/code-tool-registry.ts)

Supporting suites: [coding-agent-c1a-flags.test.ts](../../tests/coding-agent-c1a-flags.test.ts), [coding-agent-c1a-tool-schema-artifact.test.ts](../../tests/coding-agent-c1a-tool-schema-artifact.test.ts), [coding-agent-c1a-versioning.test.ts](../../tests/coding-agent-c1a-versioning.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [308](PLAN.md) | Перевикористати існуючу систему flags/runtime-конфігу (за аудитом). Якщо її немає, зробити мінімальну: сховище (адитивна міграція NPATI) зі scope global/company/user, значенням, історією змін; зміна без деплою. | Untested | Not individually certified. |
| [309](PLAN.md) | Ієрархія flags: master kill switch coding_agent.enabled; під-flags: code.read, code.write, code.shell, code.git, code.subagents, code.background_runs, code.mounted_folder, code.hooks, code.mcp, code.full_auto_sandbox, code.model_profile.<id>. Дефолт: усе вимкнено (dark launch). | Untested | Not individually certified. |
| [310](PLAN.md) | Етапи: off -> internal/admin -> allowlist користувачів/Company -> відсоток -> GA. Для self-hosted з одним власником: перемикачі в Settings -> Code -> Experimental і в конфігурації. Для кількох користувачів: allowlist і відсоток. | Untested | Not individually certified. |
| [311](PLAN.md) | Перевірка flag ЗАВЖДИ на сервері (не лише в UI): при створенні сесії, на кожному ході і перед кожним tool call. TTL кешу не більше 30 с, щоб kill switch діяв швидко. | Untested | Not individually certified. |
| [312](PLAN.md) | Вимкнення flag. Ніколи не вмикався: розділ Code прихований (dark launch). Був увімкнений і потім вимкнений: режим History (read-only). Блокуються створення сесій, run, будь-які tools, approvals, запуск sandbox і виклики моделі. Kill switch негайно скасовує активні run-и (звичайне вимкнення дозволяє завершити поточний tool call); run отримує статус suspended_by_flag, процеси і sandbox очищаються, SecretLease відкликаються. Лишаються доступними окремим read-only шляхом, що не запускає sandbox, tools чи модель: список сесій і History, Activity, перегляд Changes/diff і checkpoints, Export, а також Delete (за RBAC). Export і Delete працюють завжди, навіть при вимкненому flag, щоб користувач міг забрати або видалити свої дані. API повертає feature_disabled для всіх дій, крім read-only History, Export і Delete. Website Builder не зачіпається. | Untested | Not individually certified. |
| [313](PLAN.md) | Rollback без змін схеми чи коду: усі зміни схеми адитивні (expand/contract), без destructive міграцій у тому самому релізі, тому попередня версія застосунку працює з новою схемою. Rollback = вимкнення flag. | Untested | Not individually certified. |
| [314](PLAN.md) | Автовимкнення (опційно, конфігуровано): при перевищенні порога помилок, security-подій або бюджету відповідний flag вимикається автоматично, власник отримує сповіщення. | Untested | Not individually certified. |
| [315](PLAN.md) | Просування етапу за межі internal дозволене лише після проходження G1 і R1. Зміни flags пишуться в AuditLog (C1c). До появи C5a змінювати flags може лише існуюча роль власника/адміністратора NPATI; C5a підключає ролі Coding Agent (owner/admin). | Untested | Not individually certified. |
| [316](PLAN.md) | Capability Inspector показує стан flag для кожної code.* capability. | Untested | Not individually certified. |
| [319](PLAN.md) | Tool schema registry: кожен code.* tool має name, version (ціле), JSON-схему аргументів і результату, статус (active/deprecated), дату deprecation. Опублікована версія незмінна. Capability Inspector показує версію. | Untested | Not individually certified. |
| [320](PLAN.md) | Правила сумісності: додавання необов'язкових полів сумісне (та сама версія); видалення, перейменування, зміна типу чи семантики створює нову версію (наприклад code.fs.edit@2), стара живе, доки є сесії, що її використовують. | Untested | Not individually certified. |
| [321](PLAN.md) | CodeSession фіксує tool_manifest_version (набір версій tools) при створенні; runner показує моделі саме ці версії; resume (C10) і replay використовують той самий манифест; оновлення манифесту лише явною дією з перевіркою сумісності. | Untested | Not individually certified. |
| [322](PLAN.md) | Run-и, Activity-події і checkpoints зберігають tool, tool_version, schema_version даних; старі записи читаються через upcasters (перетворення при читанні), без міграції історії. | Untested | Not individually certified. |
| [323](PLAN.md) | API: префікс версії (/v1 або за конвенціями NPATI); у межах версії лише адитивні зміни; відповіді містять api_version; вікно deprecation задокументоване. Клієнти (UI, пізніше CLI) передають підтримувану версію. | Untested | Not individually certified. |
| [324](PLAN.md) | Версії також для persisted JSON-форматів: transcript сесії, summary-артефакт, metadata checkpoint, model profile. | Untested | Not individually certified. |
| [325](PLAN.md) | CI: snapshot опублікованих tool schemas; зміна без підвищення версії ламає збірку; golden-fixtures записаних run-ів попередніх версій відтворюються (replay tests). | Untested | Not individually certified. |
| [330](PLAN.md) | Flag ніколи не вмикався: розділ прихований, API повертає feature_disabled. Flag вимкнено після використання: створення сесії, run, tools, approvals, sandbox і виклики моделі заблоковані (також прямими викликами API/tool), а History, Activity, Changes/diff, Export і Delete доступні read-only; flag для allowlist-користувача не вмикає функцію іншим; flag однієї Company не впливає на іншу. | Untested | Not individually certified. |
| [331](PLAN.md) | Прямий виклик API/tool при вимкненому flag відхиляється (тег security-gate). | Untested | Not individually certified. |
| [332](PLAN.md) | Kill switch під час run зупиняє його не довше ніж за TTL, процеси очищені, дані збережені. | Untested | Not individually certified. |
| [333](PLAN.md) | Rollback: попередня версія коду працює з новою схемою (перевірка адитивності міграцій). | Untested | Not individually certified. |
| [334](PLAN.md) | Сесія зі старим manifest працює після випуску нової версії tool; upcaster читає старі події. | Untested | Not individually certified. |
| [335](PLAN.md) | Зміна схеми tool без bump version падає в CI. | Untested | Not individually certified. |
| [338](PLAN.md) | Адміністратор вмикає Coding Agent для однієї Company і вимикає однією дією без деплою і без втрати даних. | Untested | Not individually certified. |
| [339](PLAN.md) | Зміна схеми tool не ламає стару сесію і стару історію run-ів. | Untested | Not individually certified. |

## C1b evidence

[sandbox-image-policy.ts](../../apps/agent-api/src/sandbox-image-policy.ts), [sandbox-image-signature.ts](../../apps/agent-api/src/sandbox-image-signature.ts)

Supporting suites: [coding-agent-c1b-image-api.test.ts](../../tests/coding-agent-c1b-image-api.test.ts), [coding-agent-c1b-images.test.ts](../../tests/coding-agent-c1b-images.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [350](PLAN.md) | Декларативний каталог образів (base, node, python, go, rust, java, php): Dockerfile, версії системних пакетів зафіксовані, мінімальний склад, непривілейований користувач, без docker socket і privileged. Збірка в CI, відтворювана наскільки можливо. | Untested | Not individually certified. |
| [351](PLAN.md) | Pin за digest: конфігурація і SandboxProvider посилаються на image@sha256:..., а не на теги (latest заборонено). Digest записується в сесію (потім у ExecutionSnapshot, C6b). | Untested | Not individually certified. |
| [352](PLAN.md) | SBOM для кожного образу (SPDX або CycloneDX) зберігається разом з метаданими образу. | Untested | Not individually certified. |
| [353](PLAN.md) | Vulnerability scan у CI і за розкладом (повторне сканування наявних образів). Критичні вразливості блокують публікацію образу; високі потребують waiver із власником і терміном. Статус образу: verified, deprecated, revoked. | Untested | Not individually certified. |
| [354](PLAN.md) | Trusted registry і підпис образів (cosign/sigstore або еквівалент): перевірка підпису й digest перед запуском. Для open-source дистрибуції: офіційні образи збираються й підписуються в CI проєкту, digests публікуються. Локально зібрані образи дозволені лише в dev-режимі, позначаються unverified і не допускаються для production-flags. | Untested | Not individually certified. |
| [355](PLAN.md) | Admission control у SandboxProvider.createSandbox: відмова, якщо образ не в allowlist, підпис недійсний, digest не збігається, скан старший за N днів (дефолт 14) або образ revoked. Чітка структурована помилка, подія в Activity. Зміни allowlist і revoke образів пишуться в AuditLog (C1c). | Untested | Not individually certified. |
| [356](PLAN.md) | Оновлення: регулярна пересборка (наприклад щотижня) і позачергова при критичній CVE; новий digest вводиться поступово через flags (C1a); сесії лишаються на своєму digest, доки його не revoked (тоді примусове оновлення зі сповіщенням); можливість відкату на попередній digest. | Untested | Not individually certified. |
| [357](PLAN.md) | Hardening запуску: drop capabilities, no-new-privileges, read-only rootfs із записуваними workspace і tmp, seccomp/AppArmor профіль, ліміти ресурсів. Оцінити (за C0) сильнішу ізоляцію (gVisor, Kata, Firecracker) як опційну runtime-реалізацію SandboxProvider; рішення задокументувати. | Untested | Not individually certified. |
| [360](PLAN.md) | Образ без підпису, з тегом замість digest, з невідповідним digest, revoked або зі старим сканом не запускається. | Untested | Not individually certified. |
| [361](PLAN.md) | Verified образ запускається; admission рішення логуються. | Untested | Not individually certified. |
| [362](PLAN.md) | Контейнер без зайвих capabilities, без docker socket, під непривілейованим користувачем, rootfs read-only. | Untested | Not individually certified. |
| [363](PLAN.md) | Сесія лишається на своєму digest після публікації нового; revoked digest примусово замінюється зі сповіщенням. | Untested | Not individually certified. |
| [366](PLAN.md) | SG-1 (частина образів): запуск неперевіреного образу неможливий жодним шляхом (API, конфіг, tool). | Untested | Not individually certified. |
| [367](PLAN.md) | SBOM і результат скану доступні для кожного образу. | Untested | Not individually certified. |

## C1c evidence

[audit-log.ts](../../apps/agent-api/src/audit-log.ts)

Supporting suites: [coding-agent-c1c-audit-log.test.ts](../../tests/coding-agent-c1c-audit-log.test.ts), [coding-agent-c1c-audit-postgres.test.ts](../../tests/coding-agent-c1c-audit-postgres.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [280](PLAN.md) | AuditLog (append-only), окремо від Activity: audit_id, timestamp, actor (user, service identity або agent id), actor_role, request_id, correlation_id (зв'язок run/approval/PR), snapshot_id (null до C6b), action, resource (тип і id), company/project, decision (allowed, denied, approved, rejected), payload_hash (hash точного payload дії), prev_hash, entry_hash, metadata (без секретів і без вмісту промптів). | Untested | Not individually certified. |
| [281](PLAN.md) | Які події записуються (підключаються поступово): зміни RBAC і ролей; рішення авторизації для привілейованих дій; production-approvals (кожен approver окремо, з однаковим payload_hash для two-person); зміни feature flags і kill switch; зміни policy engine, правил проєкту, trust project; зміни ProviderDataPolicy і classification; зміни політики захищених гілок і мережевого allowlist; allow/revoke образів sandbox; метадані SecretLease (без значень); export/delete даних. | Untested | Not individually certified. |
| [282](PLAN.md) | Append-only: роль застосунку має лише INSERT і SELECT; UPDATE і DELETE заборонені правами БД та тригером; жодного cascade delete. Видалення проєкту не видаляє аудит (лишаються id і хеші, PII мінімізується). | Untested | Not individually certified. |
| [283](PLAN.md) | Хеш-ланцюг: entry_hash = H(prev_hash + canonical(entry)), ланцюг на Company; опційно HMAC або підпис ключем поза БД. Періодичний anchor (щодня): head hash зберігається поза основною БД (окреме сховище або підписаний файл) і показується власнику; опційно зовнішній timestamp. | Untested | Not individually certified. |
| [284](PLAN.md) | Верифікація: фонова задача і API verifyChain(company, range). Розрив ланцюга або розбіжність з anchor дає критичний алерт (R1) і, за конфігурацією, блокування привілейованих операцій до розслідування. | Untested | Not individually certified. |
| [285](PLAN.md) | Fail closed: якщо запис у AuditLog неможливий, привілейована дія не виконується. | Untested | Not individually certified. |
| [286](PLAN.md) | Доступ: читання лише ролям owner/admin (до появи C5a лише існуюча роль власника NPATI); пошук за actor, request_id, correlation_id, action; експорт. | Untested | Not individually certified. |
| [287](PLAN.md) | Retention: окремий, довший за логи (значення в R1), лише метадані і хеші. | Untested | Not individually certified. |
| [290](PLAN.md) | UPDATE/DELETE рядка роллю застосунку відхиляється. | Untested | Not individually certified. |
| [291](PLAN.md) | Зміна рядка в обхід застосунку (адміністративний доступ до БД) виявляється verifyChain; розрив ланцюга створює алерт. | Untested | Not individually certified. |
| [292](PLAN.md) | Привілейована дія за недоступного аудиту відхиляється (fail closed). | Untested | Not individually certified. |
| [293](PLAN.md) | payload_hash збігається з реально виконаним payload; підміна payload між схваленням і виконанням виявляється. | Untested | Not individually certified. |
| [294](PLAN.md) | Секрети та вміст промптів відсутні в записах; ізоляція між Company. | Untested | Not individually certified. |
| [297](PLAN.md) | Усі наявні привілейовані події мають audit-запис; ланцюг верифікується; щоденний anchor створюється. | Untested | Not individually certified. |

## C2 evidence

[code-tools-fs.ts](../../apps/agent-api/src/code-tools-fs.ts), [code-tools-path.ts](../../apps/agent-api/src/code-tools-path.ts), [code-tool-runtime.ts](../../apps/agent-api/src/code-tool-runtime.ts)

Supporting suites: [coding-agent-c2-capabilities.test.ts](../../tests/coding-agent-c2-capabilities.test.ts), [coding-agent-c2-read-tools.test.ts](../../tests/coding-agent-c2-read-tools.test.ts), [coding-agent-c2-schema-parity.test.ts](../../tests/coding-agent-c2-schema-parity.test.ts), [coding-agent-c2-tool-runtime.test.ts](../../tests/coding-agent-c2-tool-runtime.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [378](PLAN.md) | code.fs.list / glob: перегляд каталогів і пошук за шаблоном, з поваги .gitignore (конфігуровано), сортування за часом зміни, ліміт кількості результатів. | Untested | Not individually certified. |
| [379](PLAN.md) | code.fs.read: читання з номерами рядків, параметри offset/limit (за замовчуванням 2000 рядків, до 1 МБ), обрізання дуже довгих рядків, визначення binary/image (повертає метадані, а не вміст), кодування. | Untested | Not individually certified. |
| [380](PLAN.md) | code.fs.grep: пошук регулярними виразами (ripgrep у sandbox), фільтр за glob і типом файлів, режими files_with_matches / content / count, контекстні рядки, ліміт результатів і розміру. | Untested | Not individually certified. |
| [381](PLAN.md) | code.fs.tree (стислий огляд структури проєкту з лімітом глибини) і, за можливості, code.symbols.outline (список символів файлу через tree-sitter або ctags; якщо аудит показав складність, залишити TODO). | Untested | Not individually certified. |
| [382](PLAN.md) | Read tracking: сесія запам'ятовує які файли і з яким hash/revision були прочитані (потрібно для read-before-write у C3). | Untested | Not individually certified. |
| [383](PLAN.md) | Політика чутливих файлів: .env, ключі, сертифікати, credentials-файли за замовчуванням не читаються моделлю або читаються з редакцією значень (конфігуровано). Нікому не віддавати секрети у tool results. | Untested | Not individually certified. |
| [384](PLAN.md) | Усі результати обрізаються до ліміту (початок + кінець) з позначкою про обрізання і підказкою, як уточнити запит. | Untested | Not individually certified. |
| [385](PLAN.md) | Результати інструментів позначаються як дані (обгортка), щоб модель не сприймала вміст файлів як інструкції. | Untested | Not individually certified. |
| [386](PLAN.md) | Path safety: нормалізація, заборона "..", абсолютних шляхів поза workspace, symlink-виходів, null bytes. | Untested | Not individually certified. |
| [391](PLAN.md) | Path traversal (../, абсолютні, symlink назовні, null byte) відхиляються. | Untested | Not individually certified. |
| [392](PLAN.md) | Великі файли, бінарні файли, довгі рядки, обрізання виводу. | Untested | Not individually certified. |
| [393](PLAN.md) | grep: regex, фільтри, ліміти, .gitignore. | Untested | Not individually certified. |
| [394](PLAN.md) | Чутливі файли не повертаються у відкритому вигляді. | Untested | Not individually certified. |
| [395](PLAN.md) | Ізоляція між проєктами/компаніями/користувачами. | Untested | Not individually certified. |
| [396](PLAN.md) | Capabilities видимі в Capability Inspector з коректним risk. | Untested | Not individually certified. |
| [397](PLAN.md) | Prompt injection: файл із текстом "ignore previous instructions" повертається як дані, без побічних ефектів. | Untested | Not individually certified. |
| [400](PLAN.md) | Агент у звичайному Run (ручний виклик інструментів через тест-харнес) знаходить функцію за описом (grep + read) у тестовому репозиторії. Тести зелені. | Untested | Not individually certified. |

## C3 evidence

[code-tool-runtime-write-guard.ts](../../apps/agent-api/src/code-tool-runtime-write-guard.ts), [code-tools-write.ts](../../apps/agent-api/src/code-tools-write.ts), [code-tools-patch.ts](../../apps/agent-api/src/code-tools-patch.ts), [code-patch-transaction.ts](../../apps/agent-api/src/code-patch-transaction.ts)

Supporting suites: [coding-agent-c3-capabilities.test.ts](../../tests/coding-agent-c3-capabilities.test.ts), [coding-agent-c3-runtime.test.ts](../../tests/coding-agent-c3-runtime.test.ts), [coding-agent-c3-schema-executor-parity.test.ts](../../tests/coding-agent-c3-schema-executor-parity.test.ts), [coding-agent-c3-write-engine.test.ts](../../tests/coding-agent-c3-write-engine.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [411](PLAN.md) | code.fs.edit: параметри path, old_string, new_string, replace_all. Вимоги: точна заміна; old_string має бути унікальним (інакше помилка з кількістю збігів і підказкою розширити контекст); файл має бути прочитаний у цій сесії і не змінений після читання (інакше помилка "re-read"). При збігу з точністю до пробілів/відступів повертати підказку з найближчим фрагментом. Зберігати кодування, закінчення рядків і права файлу. | Partial | [file-safety-final.json](../../artifacts/coding-agent-audit-2026-10-15/file-safety-final.json) — Read-before-write and truncated-file refusal tested; full filesystem encoding/permission and live-agent editing acceptance not re-certified. |
| [412](PLAN.md) | code.fs.apply_patch: пакетні зміни кількох файлів в одному виклику (формат patch узгодити за аудитом, наприклад унікальний формат "*** Begin Patch" або unified diff), атомарно: або всі зміни застосовуються, або жодна. Dry-run. Зрозумілі помилки з номерами рядків. | Partial | [patch recovery tests](../../tests/coding-agent-patch-recovery.test.ts) — Canonical/unified validation and compensating rollback tested. Arbitrary external-writer races and process-death atomicity remain open. |
| [413](PLAN.md) | code.fs.write: створення нового файлу; перезапис існуючого лише якщо він був прочитаний у сесії. Створення потрібних каталогів. | Untested | Not individually certified. |
| [414](PLAN.md) | code.fs.move / code.fs.delete: delete і масові операції (поріг конфігурується) потребують approval. | Partial | [C3 runtime tests](../../tests/coding-agent-c3-runtime.test.ts) — Patch deletion approval and payload binding tested. Full human UI move/delete flow not exercised. |
| [415](PLAN.md) | Revision control: кожен запис перевіряє expected_revision; при revision_conflict повертається структурована помилка, агент може re-read і повторити (максимум 2 спроби). | Untested | Not individually certified. |
| [416](PLAN.md) | Per-turn checkpoint: автоматичний snapshot workspace перед першим записом у ході (реалізація поверх git або snapshot з Website Builder). Команда undo last turn. | Untested | Not individually certified. |
| [417](PLAN.md) | Diff: генерація unified diff для кожної зміни і для всього ходу; статистика (files, +/-). Подія в Activity з діффом (без секретів). | Untested | Not individually certified. |
| [418](PLAN.md) | Після запису: опційний форматер проєкту (якщо налаштований) і швидка перевірка синтаксису змінених файлів; результат повертається як попередження, не блокує запис. | Untested | Not individually certified. |
| [419](PLAN.md) | Профілі моделей: поле preferred_edit_tool (edit \| apply_patch \| write_whole_file_for_small) у конфігурації профілю. Не hardcode під конкретну модель. | Untested | Not individually certified. |
| [420](PLAN.md) | Захист: не редагувати файли поза workspace, заборона запису в .git/, у файли секретів без approval, обмеження розміру зміни за один виклик. | Partial | [C3 runtime tests](../../tests/coding-agent-c3-runtime.test.ts) — Patch scopes, sensitive/bulk targets and size limits tested. Full live filesystem attack campaign not certified. |
| [425](PLAN.md) | Неунікальний old_string, відсутній old_string, змінений після читання файл. | Untested | Not individually certified. |
| [426](PLAN.md) | CRLF/LF, юнікод, табуляції, великий файл, права файлу. | Untested | Not individually certified. |
| [427](PLAN.md) | apply_patch: успіх, помилка посередині (повний відкат), dry-run. | Untested | Not individually certified. |
| [428](PLAN.md) | Запис без попереднього читання відхиляється; revision_conflict і повторна спроба. | Untested | Not individually certified. |
| [429](PLAN.md) | Checkpoint і undo відновлюють файли точно. | Untested | Not individually certified. |
| [430](PLAN.md) | Path traversal, запис у .git/ і у файли секретів. | Untested | Not individually certified. |
| [431](PLAN.md) | Delete без approval не виконується. | Untested | Not individually certified. |
| [432](PLAN.md) | Ізоляція між проєктами/користувачами. | Untested | Not individually certified. |
| [435](PLAN.md) | Через тест-харнес серія викликів read -> edit -> apply_patch змінює кілька файлів, diff коректний, undo повертає початковий стан. | Untested | Not individually certified. |

## C4 evidence

[code-shell-runtime.ts](../../apps/agent-api/src/code-shell-runtime.ts), [code-process-runtime.ts](../../apps/agent-api/src/code-process-runtime.ts), [code-secret-lease.ts](../../apps/agent-api/src/code-secret-lease.ts), [docker-sandbox-provider.ts](../../apps/agent-api/src/docker-sandbox-provider.ts), [shared-project-runtime-provider.ts](../../apps/agent-api/src/shared-project-runtime-provider.ts)

Supporting suites: [coding-agent-c4-capabilities.test.ts](../../tests/coding-agent-c4-capabilities.test.ts), [coding-agent-c4-classifier.test.ts](../../tests/coding-agent-c4-classifier.test.ts), [coding-agent-c4-credentials-environment.test.ts](../../tests/coding-agent-c4-credentials-environment.test.ts), [coding-agent-c4-policy-engine.test.ts](../../tests/coding-agent-c4-policy-engine.test.ts), [coding-agent-c4-secret-lease.test.ts](../../tests/coding-agent-c4-secret-lease.test.ts), [coding-agent-c4-shell.test.ts](../../tests/coding-agent-c4-shell.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [446](PLAN.md) | code.shell.exec: виконання команди в sandbox із cwd/env, що зберігаються між викликами в межах CodeSession (постійна shell-сесія). Таймаут (120 с за замовчуванням, 600 с для install/build), обмеження виводу (head+tail), exit code, тривалість. Команда без TTY: інтерактивні запити завершуються помилкою з підказкою, а не зависанням. | Partial | [real runner](../../artifacts/coding-agent-audit-2026-10-15/live-runtime.json) — Real commands/installs/builds/stdout/exit status on four stacks; entire persistent shell/env/TTY/timeout contract not re-certified. |
| [447](PLAN.md) | code.shell.process.*: старт фонового процесу (dev server, watcher), список, логи (з offset), зупинка. Автоочищення при завершенні сесії. | Partial | [real runner](../../artifacts/coding-agent-audit-2026-10-15/live-runtime.json) — Four real servers, separate ports, HTTP previews and cleanup. Worker-death/long-session resource recovery remains open. |
| [448](PLAN.md) | Risk classification (перевикористати і розширити класифікатор з Website Builder; аналізувати команду парсером, а не лише перше слово; враховувати pipe, &&, ;, subshell, змінні, backticks, heredoc): | Untested | Not individually certified. |
| [453](PLAN.md) | Мережа: egress allowlist (registries, налаштовані git-хости). Режим не може розширити allowlist без approval. | Untested | Not individually certified. |
| [454](PLAN.md) | Секрети через SecretLease (інтерфейс SecretLeaseProvider поверх існуючого secret storage): lease видається на ОДИН tool call (або явно затверджений процес), має scope (конкретне призначення), мінімальні permissions, короткий TTL (не довше таймаута виклику), передається лише в процес цього виклику (tmpfs-файл або env цього процесу), НЕ записується в persistent shell environment і НЕ успадковується наступними процесами чи tool calls; відкликається одразу після виконання, при скасуванні, падінні і за TTL (reaper). Фонові процеси, яким потрібен секрет (наприклад dev server), отримують окремий затверджений lease з TTL і мінімальним scope. Production-credentials як lease агенту не видаються. Значення не потрапляють у prompts, Activity, логи, tool results (редакція виводу); lease_id, scope, TTL і tool_call_id логуються (без значення), метадані йдуть в AuditLog (C1c). Shell-сесія має очищений environment без секретів. | Untested | Not individually certified. |
| [455](PLAN.md) | Ресурсні ліміти і захист від fork bomb та вичерпання диска; завершення дерева процесів при timeout. | Untested | Not individually certified. |
| [456](PLAN.md) | code.verify.run: запуск verify-команд проєкту (lint, typecheck, тести, build) за визначеним у C1 набором або за аргументом (наприклад тільки файли, що змінилися). Парсинг виводу поширених інструментів у структурований результат (файл, рядок, повідомлення, severity): tsc, eslint, pytest, jest/vitest, go test, cargo. Невідомий формат повертається як обрізаний сирий вивід. | Untested | Not individually certified. |
| [457](PLAN.md) | Capabilities у registry з коректним risk і approval required. | Untested | Not individually certified. |
| [462](PLAN.md) | Класифікатор: набір команд safe/controlled/approval/deny, включно з обхідними (a && rm -rf /, $(...), `...`, змінні, heredoc, rm -rf ./). | Untested | Not individually certified. |
| [463](PLAN.md) | Timeout, обмеження виводу, інтерактивна команда, фоновий процес і його очищення. | Untested | Not individually certified. |
| [464](PLAN.md) | Мережа: доступ до registry дозволений, до довільного хоста заблокований. | Untested | Not individually certified. |
| [465](PLAN.md) | Секрети не з'являються у виводі. | Untested | Not individually certified. |
| [466](PLAN.md) | SecretLease: значення недоступне наступному tool call (env, /proc, tmpfs, shell history), після TTL чи скасування відкликається, фоновий процес не успадковує lease без затвердження (тег security-gate). | Untested | Not individually certified. |
| [467](PLAN.md) | Lease не видається для production-credentials; запит такого lease відхиляється. | Untested | Not individually certified. |
| [468](PLAN.md) | Sandbox не бачить хоста, docker socket і інших проєктів. | Untested | Not individually certified. |
| [469](PLAN.md) | Парсинг результатів tsc/pytest на прикладах. | Untested | Not individually certified. |
| [470](PLAN.md) | Ізоляція між сесіями/проєктами/користувачами. | Untested | Not individually certified. |
| [473](PLAN.md) | Через тест-харнес: install, запуск тестів у проєкті з невдалим тестом, отримання структурованого списку помилок. Жодна команда не виконується на хості NPATI. | Untested | Not individually certified. |

## C4a evidence

[code-deps-policy.ts](../../apps/agent-api/src/code-deps-policy.ts), [code-deps-guard.ts](../../apps/agent-api/src/code-deps-guard.ts), [code-deps-audit.ts](../../apps/agent-api/src/code-deps-audit.ts)

Supporting suites: [coding-agent-c4a-audit-and-secrets.test.ts](../../tests/coding-agent-c4a-audit-and-secrets.test.ts), [coding-agent-c4a-capabilities.test.ts](../../tests/coding-agent-c4a-capabilities.test.ts), [coding-agent-c4a-classifier.test.ts](../../tests/coding-agent-c4a-classifier.test.ts), [coding-agent-c4a-deps-guard.test.ts](../../tests/coding-agent-c4a-deps-guard.test.ts), [coding-agent-c4a-install-policy.test.ts](../../tests/coding-agent-c4a-install-policy.test.ts), [coding-agent-c4a-registry-allowlist.test.ts](../../tests/coding-agent-c4a-registry-allowlist.test.ts), [coding-agent-c4a-security-gate.test.ts](../../tests/coding-agent-c4a-security-gate.test.ts), [coding-agent-c4a-typosquat-dataset.test.ts](../../tests/coding-agent-c4a-typosquat-dataset.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [484](PLAN.md) | Політика install за менеджером (усе конфігуровано): | Untested | Not individually certified. |
| [490](PLAN.md) | Дві фази: fetch (мережа лише до allowlisted registries) і build/run (мережа вимкнена). Install виконується зі scrubbed environment (без секретів, токенів, SSH-ключів), з лімітами ресурсів, окремим процесом. | Untested | Not individually certified. |
| [491](PLAN.md) | Додавання нової залежності (code.deps.add) потребує approval або (в auto_edit) автоматично лише після перевірки: пакет існує в registry; не новіший за N днів (дефолт 7); не схожий на популярний пакет (typosquatting); ім'я не вигадане моделлю; метадані (версія, ліцензія, наявність install scripts, кількість maintainers/завантажень, якщо registry це надає). Результат перевірки показується в approval. | Untested | Not individually certified. |
| [492](PLAN.md) | Джерела поза registry (git URL, tarball, http, локальний шлях) і зміна registry/index URL у .npmrc, .yarnrc, pip.conf, pyproject sources, composer repositories завжди потребують approval. | Untested | Not individually certified. |
| [493](PLAN.md) | Diff-guard: зміни lifecycle-скриптів (preinstall, install, postinstall, prepare), Makefile-таргетів, CI-конфігів (.github/workflows), Dockerfile, git hooks і конфігів package manager позначаються як чутливі й потребують approval у режимах ask та auto_edit. | Untested | Not individually certified. |
| [494](PLAN.md) | Git hooks із репозиторію не виконуються в sandbox (core.hooksPath на порожній каталог); submodules і filters не виконуються автоматично. | Untested | Not individually certified. |
| [495](PLAN.md) | Сканування: audit залежностей після будь-якої зміни lockfile і перед комітом (npm/pnpm audit, pip-audit, composer audit, cargo audit або OSV-scanner залежно від toolchain; allowlisted advisory API або офлайн-база). Критичні й високі вразливості блокують авто-коміт і створення PR без approval. Secret scanning diff перед комітом (ключі, токени, приватні ключі, .env). Опційно: перевірка ліцензій і SBOM. | Untested | Not individually certified. |
| [496](PLAN.md) | Registry: allowlist, опційний caching proxy/mirror; приватні registry через secret reference; токен приватного registry видається як SecretLease лише на виклик install і не записується в workspace (тимчасовий scoped конфіг поза workspace, що видаляється після виклику). | Untested | Not individually certified. |
| [497](PLAN.md) | Capabilities code.deps.add, code.deps.audit, code.deps.inspect у registry з версіями (C1a), під flag code.shell. | Untested | Not individually certified. |
| [498](PLAN.md) | Класифікатор з C4 доповнити: curl \| sh, pip install з URL, npm install з git URL, зміна registry, запуск lifecycle scripts. | Untested | Not individually certified. |
| [501](PLAN.md) | Тестовий пакет зі шкідливим postinstall (безпечний імітатор, що намагається прочитати env і записати файл поза workspace) за замовчуванням не виконується; в явному режимі не бачить секретів і не виходить із sandbox. | Untested | Not individually certified. |
| [502](PLAN.md) | Вигаданий, свіжий або схожий на популярний пакет блокується чи вимагає approval. | Untested | Not individually certified. |
| [503](PLAN.md) | Install з git URL/tarball і зміна registry вимагають approval. | Untested | Not individually certified. |
| [504](PLAN.md) | Невідповідність lockfile відхиляється; install відтворюваний. | Untested | Not individually certified. |
| [505](PLAN.md) | cargo build.rs і pip sdist не мають мережі на фазі build. | Untested | Not individually certified. |
| [506](PLAN.md) | Git hook із репозиторію не виконується. | Untested | Not individually certified. |
| [507](PLAN.md) | Audit знаходить відому вразливість у тестовому lockfile і блокує авто-коміт; secret scanner знаходить тестовий ключ у diff. | Untested | Not individually certified. |
| [508](PLAN.md) | Зміна postinstall у package.json позначається і потребує approval. | Untested | Not individually certified. |
| [511](PLAN.md) | SG-1: мінімальний набір security-gate для sandbox escape, secret leak, path traversal (C2-C4) і supply chain (цей крок) проходить у CI і є обов'язковою job. | Untested | Not individually certified. |

## C4b evidence

[sandbox-egress-enforcement.ts](../../apps/agent-api/src/sandbox-egress-enforcement.ts), [sandbox-egress-proxy.mjs](../../apps/agent-api/src/sandbox-egress-proxy.mjs), [ssrf-safe-http.ts](../../apps/agent-api/src/ssrf-safe-http.ts)

Supporting suites: [coding-agent-c4b-acceptance.test.ts](../../tests/coding-agent-c4b-acceptance.test.ts), [coding-agent-c4b-allowlist-wiring.test.ts](../../tests/coding-agent-c4b-allowlist-wiring.test.ts), [coding-agent-c4b-allowlist.test.ts](../../tests/coding-agent-c4b-allowlist.test.ts), [coding-agent-c4b-egress.test.ts](../../tests/coding-agent-c4b-egress.test.ts), [coding-agent-c4b-network-activity.test.ts](../../tests/coding-agent-c4b-network-activity.test.ts), [coding-agent-c4b-readiness.test.ts](../../tests/coding-agent-c4b-readiness.test.ts), [coding-agent-c4b-ssrf-client.test.ts](../../tests/coding-agent-c4b-ssrf-client.test.ts), [coding-agent-c4b-webhook-policy.test.ts](../../tests/coding-agent-c4b-webhook-policy.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [522](PLAN.md) | Default-deny: sandbox підключений до ізольованої мережі, прямий вихід заборонений на рівні firewall/network policy (nftables/iptables або можливості SandboxProvider). Єдиний маршрут назовні через керований NPATI egress proxy. Скидання HTTP_PROXY у середовищі не дає обходу, бо блокування на рівні мережі. | Untested | Not individually certified. |
| [523](PLAN.md) | DNS: sandbox не може використовувати довільні DNS-сервери; резолвінг робить proxy/керований resolver із політикою. Блокувати DoH/DoT до невідомих хостів (дозвіл лише за hostname allowlist). | Untested | Not individually certified. |
| [524](PLAN.md) | Перевірка після резолву: proxy сам резолвить ім'я і перевіряє ВСІ отримані IP за списком заборонених діапазонів: loopback (127.0.0.0/8, ::1), RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), CGNAT (100.64/10), ULA (fc00::/7), 0.0.0.0/8, multicast, IPv4-mapped IPv6, мережі Docker/хоста, IP і імена внутрішніх сервісів NPATI (основний postgres, postgres-projects, API, інші sandbox), metadata endpoints (169.254.169.254, metadata.google.internal тощо). | Untested | Not individually certified. |
| [525](PLAN.md) | Захист від DNS-rebinding: з'єднання йде на перевірений IP (pinning), без повторного резолву між перевіркою і підключенням; перевірка повторюється для кожного нового з'єднання; мінімальний TTL-кеш. | Untested | Not individually certified. |
| [526](PLAN.md) | Редиректи: кожен hop обробляється як новий запит із повною перевіркою (host, резолв, IP, порт, схема); максимум редиректів 5 (конфігуровано); перехід на небезпечну схему (file, gopher, ftp) і на заборонений діапазон блокується. | Untested | Not individually certified. |
| [527](PLAN.md) | Порти й протоколи: за замовчуванням лише 443 і 80 (та 22 для allowlisted git-хостів); UDP і ICMP заборонені, окрім DNS до керованого resolver; IPv6 вимкнений або підпадає під ті самі правила. Опційна перевірка збігу SNI і CONNECT-хоста (domain fronting). | Untested | Not individually certified. |
| [528](PLAN.md) | Allowlist за hostname (точні імена, обережна робота з wildcard, щоб evil.registry.com.attacker.net не проходив), різні набори для фази install і для інших фаз; фаза build/run без мережі (C4a). Розширення allowlist: до появи C5/C5a лише конфігурацією оператора, після C5/C5a через approval і RBAC; будь-яка зміна пишеться в AuditLog (C1c). | Untested | Not individually certified. |
| [529](PLAN.md) | SSRF-safe HTTP-клієнт для всіх NPATI-side tools (web fetch, search, MCP, webhooks, hooks): та сама валідація IP після резолву і на кожному редиректі, ліміти розміру й часу. Один спільний модуль, без власних реалізацій у кожному tool. | Untested | Not individually certified. |
| [530](PLAN.md) | Логування: кожне з'єднання (хост, IP, порт, байти, рішення) пишеться в Activity/метрики без вмісту; відмови повертаються агенту як структуровані помилки. | Untested | Not individually certified. |
| [533](PLAN.md) | IP-літерали та кодування (2130706433, 0x7f000001, 0177.0.0.1, [::ffff:127.0.0.1]) блокуються. | Untested | Not individually certified. |
| [534](PLAN.md) | Хост, що резолвиться в приватний IP (наприклад localtest.me), блокується. | Untested | Not individually certified. |
| [535](PLAN.md) | DNS-rebinding (запис, що змінюється між публічним і приватним): блокується завдяки pinning. | Untested | Not individually certified. |
| [536](PLAN.md) | Редирект на http://169.254.169.254 і на localhost блокується; редирект на дозволений публічний хост проходить; ліміт редиректів. | Untested | Not individually certified. |
| [537](PLAN.md) | Підміна імені в стилі evil.npmjs.org.attacker.com не проходить allowlist. | Untested | Not individually certified. |
| [538](PLAN.md) | Прямі з'єднання за IP, UDP, ICMP, нестандартні порти, зовнішній DNS блокуються на рівні мережі навіть при скиданні proxy-змінних. | Untested | Not individually certified. |
| [539](PLAN.md) | Доступ до внутрішніх сервісів NPATI, postgres, postgres-projects, іншого sandbox неможливий. | Untested | Not individually certified. |
| [540](PLAN.md) | SSRF-safe клієнт у NPATI-tools проходить той самий набір. | Untested | Not individually certified. |
| [541](PLAN.md) | Дозволений registry у фазі install працює, у фазі build мережі немає. | Untested | Not individually certified. |
| [544](PLAN.md) | SG-1 (мережа): весь набір вище проходить; жоден обхід не знайдений; рішення мережі видно в Activity. | Untested | Not individually certified. |

## C5 evidence

[code-policy-engine.ts](../../apps/agent-api/src/code-policy-engine.ts), [code-edit-approval.ts](../../apps/agent-api/src/code-edit-approval.ts), [code-approval-scope.ts](../../apps/agent-api/src/code-approval-scope.ts)

Supporting suites: [coding-agent-c5-approval-bypass.test.ts](../../tests/coding-agent-c5-approval-bypass.test.ts), [coding-agent-c5-approval-scope.test.ts](../../tests/coding-agent-c5-approval-scope.test.ts), [coding-agent-c5-capability-groups.test.ts](../../tests/coding-agent-c5-capability-groups.test.ts), [coding-agent-c5-decision-activity.test.ts](../../tests/coding-agent-c5-decision-activity.test.ts), [coding-agent-c5-trust-and-injection.test.ts](../../tests/coding-agent-c5-trust-and-injection.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [555](PLAN.md) | Режими сесії: | Untested | Not individually certified. |
| [560](PLAN.md) | Конвеєр рішення на кожен виклик: (a) feature flag -> (b) RBAC ролі користувача (C5a) -> (c) чи є capability у агента (capability group) -> (d) hard deny -> (e) режим сесії -> (f) allow/deny правила проєкту і користувача -> (g) risk classification -> (h) approval через існуючу систему. | Untested | Not individually certified. |
| [561](PLAN.md) | Approval payload: що саме буде зроблено (diff або команда з cwd), чому, ризик. Рішення: approve once, approve for session, approve for project (створює scoped правило, видиме і видалюване в UI), deny з коментарем (коментар повертається моделі). | Untested | Not individually certified. |
| [562](PLAN.md) | Hard deny список, який не може бути змінений жодним режимом, правилом чи інструкцією з репозиторію. Включає force push у захищені гілки, пряму запис агентом у захищені гілки, використання production-credentials агентом, вихід за workspace, доступ до docker socket. | Untested | Not individually certified. |
| [563](PLAN.md) | Захист від prompt injection: вміст файлів, веб, результатів інструментів і NPATI.md/AGENTS.md з імпортованих репозиторіїв не може змінювати режим, правила чи approvals. Інструкції з репозиторію діють лише після явного "trust this project" користувачем. | Untested | Not individually certified. |
| [564](PLAN.md) | Зміна режиму лише користувачем, не моделлю. Модель може запропонувати перейти з plan у execute, але рішення за користувачем. | Untested | Not individually certified. |
| [565](PLAN.md) | Таймаут approval (конфігуровано): без відповіді run зупиняється з чітким статусом, а не виконує дію. | Untested | Not individually certified. |
| [566](PLAN.md) | Approval з месенджера (Telegram/WhatsApp через Integrations): ОПЦІЙНО, лише якщо аудит показав готову інфраструктуру і верифікацію особи; інакше залишити TODO. | Untested | Not individually certified. |
| [567](PLAN.md) | Усі рішення пишуться в Activity (хто, що, режим, правило, результат). | Untested | Not individually certified. |
| [568](PLAN.md) | Capability groups для агентів Company (code.read, code.write, code.shell, code.git): без нової permission-системи, через існуючий механізм. | Untested | Not individually certified. |
| [571](PLAN.md) | Матриця режимів x дій (read, edit, install, test, push, delete, network) дає очікувані рішення. | Untested | Not individually certified. |
| [572](PLAN.md) | Hard deny не обходиться ні режимом, ні правилом, ні "approve for project". | Untested | Not individually certified. |
| [573](PLAN.md) | Prompt injection у файлі/README/веб-результаті не змінює режим і не створює правил. | Untested | Not individually certified. |
| [574](PLAN.md) | Правило проєкту не діє в іншому проєкті/компанії. | Untested | Not individually certified. |
| [575](PLAN.md) | Таймаут approval зупиняє run. | Untested | Not individually certified. |
| [576](PLAN.md) | Агент без capability group отримує permission denied. | Untested | Not individually certified. |
| [577](PLAN.md) | Регресія approvals інших функцій NPATI. | Untested | Not individually certified. |
| [580](PLAN.md) | У режимі plan запис неможливий; в ask кожен запис запитує approval з diff; в auto_edit редагування автоматичні, а git push вимагає approval; hard deny непорушний. | Untested | Not individually certified. |
| [581](PLAN.md) | SG-2: набір approval-bypass тестів (тег security-gate) проходить і додано в suite. | Untested | Not individually certified. |

## C5a evidence

[code-rbac.ts](../../apps/agent-api/src/code-rbac.ts), [code-membership.ts](../../apps/agent-api/src/code-membership.ts), [code-prod-operations.ts](../../apps/agent-api/src/code-prod-operations.ts)

Supporting suites: [coding-agent-c5a-automations-identity.test.ts](../../tests/coding-agent-c5a-automations-identity.test.ts), [coding-agent-c5a-membership.test.ts](../../tests/coding-agent-c5a-membership.test.ts), [coding-agent-c5a-prod-operations.test.ts](../../tests/coding-agent-c5a-prod-operations.test.ts), [coding-agent-c5a-protected-branches.test.ts](../../tests/coding-agent-c5a-protected-branches.test.ts), [coding-agent-c5a-rbac-foundation.test.ts](../../tests/coding-agent-c5a-rbac-foundation.test.ts), [coding-agent-c5a-rbac.test.ts](../../tests/coding-agent-c5a-rbac.test.ts), [coding-agent-c5a-role-escalation.test.ts](../../tests/coding-agent-c5a-role-escalation.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [592](PLAN.md) | Ролі на рівні Company: owner, admin, developer, reviewer. Для встановлення з одним власником усі права в owner, але модель і перевірки працюють однаково (готовність до кількох користувачів). | Untested | Not individually certified. |
| [593](PLAN.md) | Матриця прав (дефолти, конфігуровані власником): | Untested | Not individually certified. |
| [605](PLAN.md) | Production-операції (deploy, promote міграцій у prod, зміна політики захищених гілок, будь-яка операція з production-середовищем) мають окремий permission code.prod.operate, який не входить у жодну роль за замовчуванням. Production-операції виконуються платформними виконавцями (DeployProvider, promote flow), а не credentials в shell агента. Опційно two-person approval (конфігуровано): ініціатор і підтверджувач різні, обидва мають permission, підтверджувач бачить точний payload (перевірка hash), дія обмежена в часі, обидва підтвердження пишуться в AuditLog з однаковим payload_hash. Для встановлення з одним користувачем замість two-person діє step-up: повторна автентифікація або введення підтвердження і затримка (cooldown). | Untested | Not individually certified. |
| [606](PLAN.md) | Агент не може бути approver: токен сесії агента не має права підтверджувати approvals; підтвердження лише від автентифікованого користувача з потрібною роллю. Approvals з месенджерів (C5, пункт 8) лише для non-production і лише з верифікованою особою. | Untested | Not individually certified. |
| [607](PLAN.md) | Ефективні права: перетин capability groups агента, ролі користувача, який ініціював run, і правил проєкту. Фонові/автоматичні run-и (Automations) виконуються від service identity з явно обмеженою роллю (не вище developer, ніколи без production-операцій). | Untested | Not individually certified. |
| [608](PLAN.md) | Централізована перевірка авторизації на сервері, deny by default, використовується інструментами, approvals, API, UI. Перевіряється на кожному tool call, тож зміна ролі діє і в уже запущених сесіях. | Untested | Not individually certified. |
| [609](PLAN.md) | Аудит: усі рішення авторизації для привілейованих дій, зміни ролей, approvals і відмови пишуться в AuditLog (C1c) з actor, request_id, correlation_id, payload_hash (і snapshot_id після C6b), а також у Activity для трасування. | Untested | Not individually certified. |
| [610](PLAN.md) | UI: керування ролями в Settings -> Code (або існуючому розділі прав), відображення поточної ролі та причини відмови. | Untested | Not individually certified. |
| [613](PLAN.md) | Матриця роль x дія дає очікувані рішення. | Untested | Not individually certified. |
| [614](PLAN.md) | Спроби ескалації: developer вмикає full_auto через API, через вміст файлу, через зміну правил проєкту; reviewer запускає команду; admin однієї Company діє в іншій. | Untested | Not individually certified. |
| [615](PLAN.md) | Self-approval у режимі two-person відхиляється; replay approval для іншого payload відхиляється. | Untested | Not individually certified. |
| [616](PLAN.md) | Токен агента не може підтвердити approval. | Untested | Not individually certified. |
| [617](PLAN.md) | Зниження ролі посеред run зупиняє дії, що вимагають вищу роль. | Untested | Not individually certified. |
| [618](PLAN.md) | Automation identity не виконує production-операції. | Untested | Not individually certified. |
| [619](PLAN.md) | Регресія існуючих ролей і permissions NPATI. | Untested | Not individually certified. |
| [622](PLAN.md) | SG-2 (RBAC і approval): набір тестів проходить; жодна production-операція не виконується без code.prod.operate (і two-person/step-up, якщо ввімкнено). | Untested | Not individually certified. |

## C5b evidence

[provider-data-guard.ts](../../apps/agent-api/src/provider-data-guard.ts), [provider-data-policy.ts](../../apps/agent-api/src/provider-data-policy.ts), [provider-data-policy-service.ts](../../apps/agent-api/src/provider-data-policy-service.ts)

Supporting suites: [coding-agent-c5b-outbound-guard.test.ts](../../tests/coding-agent-c5b-outbound-guard.test.ts), [coding-agent-c5b-policy-management.test.ts](../../tests/coding-agent-c5b-policy-management.test.ts), [coding-agent-c5b-policy-rbac.test.ts](../../tests/coding-agent-c5b-policy-rbac.test.ts), [coding-agent-c5b-policy-resolver.test.ts](../../tests/coding-agent-c5b-policy-resolver.test.ts), [coding-agent-c5b-policy-store.test.ts](../../tests/coding-agent-c5b-policy-store.test.ts), [coding-agent-c5b-provider-guard.test.ts](../../tests/coding-agent-c5b-provider-guard.test.ts), [coding-agent-c5b-routing-eligibility.test.ts](../../tests/coding-agent-c5b-routing-eligibility.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [633](PLAN.md) | ProviderDataPolicy для кожного AI Provider (за потреби на рівні моделі): kind (hosted_third_party, self_hosted, local), allow_private_repo_code, max_data_classification (public, internal, confidential, restricted), allow_prompt_caching, external_retention (none, N днів, unknown), training_policy (no_training, may_train, unknown), регіон/юрисдикція (опційно), required_redactions (secrets, PII, email, tokens, ключі, внутрішні hostnames), allowed_content_types (код, термінал-вивід, логи, diff, список файлів, веб-вміст), last_reviewed_at, reviewed_by, посилання на умови провайдера. Значення вказує оператор за умовами провайдера; NPATI не може їх перевірити, тому показує дату перегляду і попереджає про застарілі (понад 180 днів). | Untested | Not individually certified. |
| [634](PLAN.md) | Дефолти консервативні: невідомий або новий hosted-провайдер: лише public, без private-коду, без prompt caching, до явного налаштування; local/self-hosted: до restricted, але з обов'язковою редакцією секретів. | Untested | Not individually certified. |
| [635](PLAN.md) | Класифікація проєкту: code_project.data_classification (за замовчуванням confidential) і правила за шляхами (наприклад каталоги з секретами restricted, vendor public) у налаштуваннях проєкту. Публічні репозиторії можна позначити public. | Untested | Not individually certified. |
| [636](PLAN.md) | ProviderDataGuard: єдина точка перед надсиланням будь-чого моделі (основний цикл, стиснення контексту C8, self-review C9, субагенти C12, hooks C13): (a) classification проєкту не вище max провайдера; (b) заборонені типи вмісту видаляються або блокуються; (c) редакція за правилами (secret scanner з C4a, PII-патерни) з placeholder на кшталт «REDACTED:secret_1»; рядки з placeholder позначаються нередагованими для моделі, а edit-інструменти ніколи не записують placeholder на диск; (d) prompt caching вимикається, якщо не дозволений; (e) логуються лише метадані (провайдер, модель, classification, кількість байтів і редакцій, версія політики), без вмісту. | Untested | Not individually certified. |
| [637](PLAN.md) | Routing: ланцюг primary/fallback/NPATI Auto фільтрується політикою. Провайдер, що не проходить, не використовується мовчки (fallback пропускається). Якщо підходящого провайдера немає, run зупиняється з чітким поясненням. Те саме для моделей субагентів, self-review і стиснення. У UI вибору моделі відображається eligibility. | Untested | Not individually certified. |
| [638](PLAN.md) | Exfiltration guard для outbound-інструментів NPATI (web search/fetch, email, месенджери, MCP, webhooks): аргументи й тіла запитів перевіряються на секрети і код, що перевищує дозволену classification; підозрілі потребують approval. | Untested | Not individually certified. |
| [639](PLAN.md) | Прозорість: у Code Workspace видно, яка модель і провайдер отримують код, і classification; при першому підключенні проєкту до hosted-провайдера потрібна явна згода користувача (зберігається). | Untested | Not individually certified. |
| [640](PLAN.md) | Керування: Settings -> AI Providers -> Data policy і налаштування classification у проєкті; зміни доступні ролям за C5a, версіонуються (policy_version для C6b) і пишуться в AuditLog (C1c). | Untested | Not individually certified. |
| [643](PLAN.md) | Restricted-проєкт не маршрутизується на hosted-провайдера; fallback пропускається; без eligible провайдера run зупиняється. | Untested | Not individually certified. |
| [644](PLAN.md) | Canary-секрет у файлі не потрапляє до mock-провайдера (редакція); placeholder ніколи не записується в файл. | Untested | Not individually certified. |
| [645](PLAN.md) | Prompt caching вимкнений, коли політика забороняє. | Untested | Not individually certified. |
| [646](PLAN.md) | Невідомий провайдер за замовчуванням отримує лише public. | Untested | Not individually certified. |
| [647](PLAN.md) | Субагенти, self-review, стиснення контексту підпорядковуються політиці. | Untested | Not individually certified. |
| [648](PLAN.md) | Outbound web search/email із фрагментом приватного коду або секретом блокується чи потребує approval. | Untested | Not individually certified. |
| [649](PLAN.md) | Зміна політики потребує ролі за C5a, створює нову версію і пишеться в аудит. | Untested | Not individually certified. |
| [652](PLAN.md) | SG-3 (дані провайдерів): приватний код і секрети не залишають NPATI до провайдерів, що не мають на це дозволу; рішення видно в Activity. | Untested | Not individually certified. |

## C6 evidence

[coding-agent-runner.ts](../../apps/agent-api/src/coding-agent-runner.ts), [coding-agent-tool-waves.ts](../../apps/agent-api/src/coding-agent-tool-waves.ts), [code-tool-call-adapter.ts](../../apps/agent-api/src/code-tool-call-adapter.ts), [omniroute-engine.ts](../../packages/omniroute-adapter/src/omniroute-engine.ts)

Supporting suites: [coding-agent-c6-eval.test.ts](../../tests/coding-agent-c6-eval.test.ts), [coding-agent-c6-intent-routing.test.ts](../../tests/coding-agent-c6-intent-routing.test.ts), [coding-agent-c6-model-profiles.test.ts](../../tests/coding-agent-c6-model-profiles.test.ts), [coding-agent-c6-runner-stop-conditions.test.ts](../../tests/coding-agent-c6-runner-stop-conditions.test.ts), [coding-agent-c6-runner.test.ts](../../tests/coding-agent-c6-runner.test.ts), [coding-agent-c6-tool-call-adapter.test.ts](../../tests/coding-agent-c6-tool-call-adapter.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [663](PLAN.md) | CodingAgentRunner: приймає CodeSession і запит користувача; формує system prompt (роль, режим, список доступних tools, інформація про середовище: ОС, cwd, git status коротко, дата; місце для інструкцій проєкту з C8); викликає модель через AI Providers (primary, fallback, NPATI Auto, budget); стрімить текст і tool calls у чат; виконує tool calls (read-only паралельно до 8, запис і shell послідовно); повертає результати моделі; повторює до завершення. | Partial | [runner tests](../../tests/coding-agent-c6-runner.test.ts) — Actual runner with scripted provider validates tool-history correlation and bounded execution. No autonomous live-model task certified. |
| [664](PLAN.md) | Умови зупинки: модель не викликає tools (готово), max turns (40), час (30 хв), бюджет токенів/вартості через існуючу систему, скасування користувачем, невиправна помилка. Кожна зупинка має причину і підсумок для користувача. | Partial | [cancellation-trace.json](../../artifacts/coding-agent-audit-2026-10-15/cancellation-trace.json) — Stop/cancellation and late-response accounting tested with scripted provider. Live budget/provider cancellation campaign remains open. |
| [665](PLAN.md) | Захист від зациклення: виявлення повторення однакових викликів і однакових помилок (3 поспіль), у такому разі система вставляє нагадування моделі змінити підхід, а після повторення зупиняє run із поясненням. | Untested | Not individually certified. |
| [666](PLAN.md) | Обробка помилок: помилка інструмента повертається моделі як структурований результат; невалідні аргументи tool call: до 2 виправлень; помилка провайдера: fallback за існуючим routing; обрив стріму: відновлення без дублювання виконаних tool calls (ідемпотентність за tool_call_id). | Partial | [runner tests](../../tests/coding-agent-c6-runner.test.ts) — Rejected/partial tool histories and correction budgets tested. Real streaming/provider failover without duplicate side effects not certified. |
| [667](PLAN.md) | ToolCallAdapter: нормалізація tool calling між провайдерами (native tool calling, часткові аргументи при стрімі, паралельні виклики) і fallback-режим для моделей без надійного tool calling (структурований формат у тексті з парсером і валідацією). Особливості reasoning-контенту окремих провайдерів у багатоходових розмовах з tools реалізувати за документацією провайдера, перевіреною в C0. | Untested | Not individually certified. |
| [668](PLAN.md) | Профілі моделей (конфігурація, не код): tool_calling_mode, preferred_edit_tool, max_parallel_tool_calls, context_window, temperature, додаткові рядки prompt, відомі обмеження. Профіль за замовчуванням для невідомих моделей консервативний. Вибір профілю автоматичний за моделлю. | Untested | Not individually certified. |
| [669](PLAN.md) | Інтеграція з Run/Activity: кожен хід, tool call, прочитаний/змінений файл, команда, approval і помилка потрапляють у Activity & Run Trace. Фінальне повідомлення: що змінено (файли, diff-статистика), результат перевірок, що лишилося. | Partial | [cancellation-trace.json](../../artifacts/coding-agent-audit-2026-10-15/cancellation-trace.json) — Late completed model calls close trace and account tokens. Lossless DB/SSE history across restart and all A–L remains untested. |
| [670](PLAN.md) | Intent Router: інтенти CREATE_CODE, EDIT_CODE, DEBUG_CODE, EXPLAIN_CODE, REVIEW_CODE, REFACTOR_CODE, TEST_CODE із урахуванням active project/session (розширити існуючий Router, не створювати другий). Запит у чаті ("виправ баг у функції X") запускає CodingAgentRunner у активному проєкті; якщо проєкту немає, питати який. | Untested | Not individually certified. |
| [671](PLAN.md) | Мінімальний eval-харнес: 8 детермінованих задач (виправити баг, додати функцію, рефакторинг, написати тест, виправити помилку збірки тощо) на малих тестових репозиторіях, з записаними/мок-відповідями моделі для CI та опційним запуском на реальній моделі. Метрики: успіх (тести проходять), кількість ходів, токени, час. | Untested | Not individually certified. |
| [672](PLAN.md) | Підключення наскрізних вимог (лише через інтерфейси цього кроку): на старті run перевіряється admission образу sandbox (C1b) і викликається ExecutionSnapshotProvider (інтерфейс/hook; у C6 діє NullSnapshotProvider, що повертає порожній snapshot_id, фактична реалізація підключається в C6b); кожен payload до моделі проходить ProviderDataGuard (C5b), а вибір моделі й fallback фільтруються політикою; мережа sandbox лише через egress proxy (C4b); кожна дія проходить RBAC (C5a). | Untested | Not individually certified. |
| [677](PLAN.md) | Цикл завершується за кожною з умов зупинки. | Untested | Not individually certified. |
| [678](PLAN.md) | Виявлення зациклення; обрив стріму без повторного виконання tool calls. | Untested | Not individually certified. |
| [679](PLAN.md) | Невалідні аргументи tool call, помилка інструмента, помилка провайдера з fallback. | Untested | Not individually certified. |
| [680](PLAN.md) | ToolCallAdapter: native, часткові аргументи, fallback-режим із некоректним форматом. | Untested | Not individually certified. |
| [681](PLAN.md) | Профіль невідомої моделі. | Untested | Not individually certified. |
| [682](PLAN.md) | Скасування користувачем завершує процеси й звільняє sandbox. | Untested | Not individually certified. |
| [683](PLAN.md) | Ізоляція між користувачами/проєктами; бюджет зупиняє run. | Untested | Not individually certified. |
| [684](PLAN.md) | Регресія звичайного чату і Run Company. | Untested | Not individually certified. |
| [687](PLAN.md) | У чаті: "виправ падаючий тест у цьому проєкті". Агент читає, редагує, запускає тести, виправляє, показує підсумок. Run видно в Activity. Eval-набір у CI зелений. | Untested | Not individually certified. |

## C6a evidence

[code-run-reconciler.ts](../../apps/agent-api/src/code-run-reconciler.ts), [code-reaper.ts](../../apps/agent-api/src/code-reaper.ts), [code-migration-safety.ts](../../apps/agent-api/src/code-migration-safety.ts)

Supporting suites: [coding-agent-c6a-migration-safety.test.ts](../../tests/coding-agent-c6a-migration-safety.test.ts), [coding-agent-c6a-reaper.test.ts](../../tests/coding-agent-c6a-reaper.test.ts), [coding-agent-c6a-reconciler.test.ts](../../tests/coding-agent-c6a-reconciler.test.ts), [coding-agent-c6a-run-state.test.ts](../../tests/coding-agent-c6a-run-state.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [698](PLAN.md) | Стан run як event-log: після кожного ходу і tool call зберігається стан (повідомлення, tool calls з tool_call_id, результати, checkpoint id). Heartbeat і lease на run (15 с / 60 с, конфігуровано). | Untested | Not individually certified. |
| [699](PLAN.md) | Reconciler при старті сервера і періодично: run зі статусом running без живого lease стає interrupted. Відновлення лише з межі ходу. Tool call, що виконувався: read-only повторюється; write/shell/невідомий автоматично НЕ повторюється, результат позначається unknown_outcome, workspace порівнюється з останнім checkpoint (diff), і ця інформація передається моделі та користувачу перед продовженням. Ідемпотентність за tool_call_id. | Partial | [reconciler tests](../../tests/coding-agent-c6a-reconciler.test.ts) — Lease-claim, resumed-worker race and competing reconcilers tested. No real API/worker kill and PostgreSQL recovery drill. |
| [700](PLAN.md) | Відновлення sandbox: health-check; при падінні створюється новий sandbox з workspace і checkpoints (workspace зберігається поза ефемерним контейнером), відновлюється кеш залежностей; фонові процеси позначаються втраченими; сесія продовжується з відповідним повідомленням. | Untested | Not individually certified. |
| [701](PLAN.md) | Reaper (інтервал 60 с, ідемпотентний, має dry-run): завершує зомбі й осиротілі процеси; убиває tool calls без прогресу вище порога (дефолт 300 с, крім явно довгих задач); зупиняє run-и, що перевищили wall-clock плюс grace; завершує прострочені approvals; видаляє осиротілі sandbox, тимчасові каталоги і незавершені worktrees; звільняє застарілі lock-и (file locks, migration locks) за TTL; контролює диск і inode. Усі дії логуються в Activity і метриках. | Untested | Not individually certified. |
| [702](PLAN.md) | Rollback невдалих змін: checkpoint на початку run і per-turn (C3). Якщо run завершився failed/cancelled/limit, зміни за замовчуванням лишаються в Changes з пропозицією Revert run. Опційний режим atomic task автоматично повертає стан на початок run, якщо verify не пройшов після ліміту repair. Невдалу збірку не комітити без явного рішення. Після відновлення перевіряти, що workspace не містить частково застосованого patch. | Untested | Not individually certified. |
| [703](PLAN.md) | Безпечні DB migrations: | Untested | Not individually certified. |
| [704](PLAN.md) | Класифікація: виконання міграцій (prisma migrate/db push, drizzle-kit, alembic, django/rails/artisan/knex/typeorm/sequelize/flyway/liquibase/goose/sqlx тощо) і прямий SQL-клієнт (psql, mysql, sqlite3 до не-локальної БД) належать до approval-класу. Написання файлів міграцій це звичайна зміна коду. | Untested | Not individually certified. |
| [705](PLAN.md) | Цілі виконання: лише ефемерна БД у sandbox або dev DataBackend через міграційний движок Data Studio (migration lock, snapshot, прапорці destructive/requires_snapshot). Credentials production, зовнішньої або невідомої БД це hard deny (визначення за host/URL/secret reference). Production лише через promote/deploy flow з approval. | Untested | Not individually certified. |
| [706](PLAN.md) | Статичний аналіз нових міграцій у diff: DROP, TRUNCATE, DELETE без WHERE, видалення чи перейменування колонок, зміна типів позначаються destructive, вимагають snapshot (де є) і approval; в approval показується план (prisma migrate diff, alembic --sql тощо) і кількість зачеплених даних, якщо відома. | Untested | Not individually certified. |
| [707](PLAN.md) | Відкат: вимога down-міграції або описаного плану; невдала міграція відкочується транзакцією, де СУБД це підтримує, інакше відновленням snapshot dev-БД; sandbox-БД ефемерна. | Untested | Not individually certified. |
| [708](PLAN.md) | Приховані міграції: аналіз package.json/Makefile/скриптів запуску (prestart, dev, test), які викликають міграції; такі скрипти позначаються й потребують approval. | Untested | Not individually certified. |
| [709](PLAN.md) | Агент не отримує і не бачить production DATABASE_URL; тести працюють з ефемерною БД. | Untested | Not individually certified. |
| [710](PLAN.md) | Chaos-перевірки: kill runner посеред ходу; kill sandbox під час install і apply_patch; обрив мережі; повний диск; перезапуск сервера з активними run-ами. | Untested | Not individually certified. |
| [711](PLAN.md) | Метрики в Activity: кількість interrupted, recovered, cleaned. | Untested | Not individually certified. |
| [714](PLAN.md) | Kill runner: run стає interrupted, після рестарту відновлюється з межі ходу без повторного виконання write/shell. | Untested | Not individually certified. |
| [715](PLAN.md) | Kill sandbox: сесія відновлюється з workspace і checkpoints. | Untested | Not individually certified. |
| [716](PLAN.md) | Reaper: зомбі, завислий tool call, осиротілий sandbox, застарілий lock; повторний запуск безпечний. | Untested | Not individually certified. |
| [717](PLAN.md) | apply_patch, перерваний посеред: workspace або повністю до, або повністю після. | Untested | Not individually certified. |
| [718](PLAN.md) | Failed run і atomic task: повертається стан початку run. | Untested | Not individually certified. |
| [719](PLAN.md) | (security-gate) міграція проти production URL це hard deny; destructive у diff потребує approval і snapshot; виконання лише в ефемерній/dev БД; прихована міграція в скрипті виявляється; невдала міграція відкочується. | Untested | Not individually certified. |
| [720](PLAN.md) | Регресія: migration lock і snapshot Data Studio працюють при виклику з агента. | Untested | Not individually certified. |
| [723](PLAN.md) | Після навмисного падіння runner і sandbox користувач бачить коректний стан, продовжує без втрат і без повторних небезпечних дій. | Untested | Not individually certified. |
| [724](PLAN.md) | Жодна міграція не виконується проти production. | Untested | Not individually certified. |
| [725](PLAN.md) | SG-3: тести recovery/міграцій із тегом security-gate проходять. | Untested | Not individually certified. |

## C6b evidence

[execution-snapshot.ts](../../apps/agent-api/src/execution-snapshot.ts), [code-replay-engine.ts](../../apps/agent-api/src/code-replay-engine.ts), [code-replay-bundle.ts](../../apps/agent-api/src/code-replay-bundle.ts)

Supporting suites: [coding-agent-c6b-activity-snapshot.test.ts](../../tests/coding-agent-c6b-activity-snapshot.test.ts), [coding-agent-c6b-replay-bundle.test.ts](../../tests/coding-agent-c6b-replay-bundle.test.ts), [coding-agent-c6b-replay-deterministic.test.ts](../../tests/coding-agent-c6b-replay-deterministic.test.ts), [coding-agent-c6b-replay-live.test.ts](../../tests/coding-agent-c6b-replay-live.test.ts), [coding-agent-c6b-snapshot-api.test.ts](../../tests/coding-agent-c6b-snapshot-api.test.ts), [coding-agent-c6b-snapshot-store.test.ts](../../tests/coding-agent-c6b-snapshot-store.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [736](PLAN.md) | ExecutionSnapshot: незмінний append-only запис, що створюється на старті сесії і заново (нова версія) на старті кожного run, бо flags і політики можуть змінитись між run-ами. Поля: session_id, run_id, tool_manifest_version, policy_version (policy engine, режими, правила проєкту, RBAC-конфіг), model_profile_version, провайдер, модель і параметри генерації, версія/hash system prompt, runner_version (build/commit), sandbox_image_digest (і посилання на SBOM), feature flags (розв'язані ефективні значення), provider_data_policy_version і classification, base git commit (гілка, наявність незафіксованих змін, hash diff), hash інструкцій проєкту (NPATI.md) і статус довіри, версії toolchain, час, ініціатор і його роль. Без секретів. | Untested | Not individually certified. |
| [737](PLAN.md) | Версіоновані сховища: політики, model profiles і system prompt зберігаються як незмінні версії з content hash. Зміна створює нову версію, а не редагує стару. | Untested | Not individually certified. |
| [738](PLAN.md) | Кожна подія Activity і кожен запис AuditLog (C1c) посилаються на snapshot_id. UI/API 'Чому агент так діяв': показує snapshot, а також diff між snapshot двох run-ів. | Untested | Not individually certified. |
| [739](PLAN.md) | Відтворення, чесно про межі: (a) deterministic replay гарантується лише з recorded/mock provider і recorded tool results: записані відповіді моделі та результати інструментів програються проти зафіксованих версій harness (для тестів і розслідувань); (b) live replay (повторний запуск на живій моделі з тим самим snapshot) має статус best-effort reproducibility: модель, package registries, GitHub і зовнішні сервіси можуть змінитись, тому збіг результату не гарантується, і UI/API це явно позначає. | Untested | Not individually certified. |
| [740](PLAN.md) | Resume (C10) і відновлення (C6a): якщо flag вимкнено, образ revoked або політика змінилась, створюється нова версія snapshot із показаним diff і повідомленням користувачу. | Untested | Not individually certified. |
| [741](PLAN.md) | Retention snapshot і метаданих відповідає політиці Activity (R1); вміст промптів, як окремі дані, має власний, коротший retention. | Untested | Not individually certified. |
| [742](PLAN.md) | Підключення до C6: реалізувати ExecutionSnapshotProvider і замінити NullSnapshotProvider з C6; run-и, створені до C6b, відображаються як legacy_no_snapshot без помилок. | Partial | [stop-condition tests](../../tests/coding-agent-c6-runner-stop-conditions.test.ts) — Configured snapshot persistence fails closed before provider/tools. Full deployed snapshot/replay/resume chain not certified. |
| [745](PLAN.md) | Snapshot створюється на кожному run, незмінний; спроба змінити відхиляється. | Untested | Not individually certified. |
| [746](PLAN.md) | Зміна flag/політики між run-ами дає нову версію з коректним diff. | Untested | Not individually certified. |
| [747](PLAN.md) | Усі події Activity мають snapshot_id. | Untested | Not individually certified. |
| [748](PLAN.md) | Deterministic replay з recorded/mock provider і recorded tool results відтворює ту саму послідовність tool calls; live replay позначається best-effort reproducibility. | Untested | Not individually certified. |
| [749](PLAN.md) | Resume з revoked образом створює новий snapshot зі сповіщенням. | Untested | Not individually certified. |
| [750](PLAN.md) | Snapshot не містить секретів (canary-перевірка). | Untested | Not individually certified. |
| [753](PLAN.md) | Для будь-якого run видно, у якому середовищі й з якими політиками він виконувався, і можна запустити deterministic replay із записаних даних (live replay: best-effort reproducibility). | Untested | Not individually certified. |

## C7 evidence

[CodeWorkspacePage.tsx](../../apps/web/src/CodeWorkspacePage.tsx), [CodeWorkspaceExecutionPanel.tsx](../../apps/web/src/code-workspace/CodeWorkspaceExecutionPanel.tsx), [CodeWorkspaceFilePanel.tsx](../../apps/web/src/code-workspace/CodeWorkspaceFilePanel.tsx), [code-monitor-routes.ts](../../apps/agent-api/src/code-monitor-routes.ts), [code-project-lifecycle-routes.ts](../../apps/agent-api/src/code-project-lifecycle-routes.ts), [project-browser-qa-service.ts](../../apps/agent-api/src/project-browser-qa-service.ts), [shared-project-runtime-provider.ts](../../apps/agent-api/src/shared-project-runtime-provider.ts), [sandbox-browser-qa.ts](../../apps/agent-api/src/sandbox-browser-qa.ts)

Supporting suites: [coding-agent-c7-chat-integration.test.ts](../../tests/coding-agent-c7-chat-integration.test.ts), [coding-agent-c7-project-files-adapter.test.ts](../../tests/coding-agent-c7-project-files-adapter.test.ts), [coding-agent-c7-project-lifecycle.test.ts](../../tests/coding-agent-c7-project-lifecycle.test.ts), [coding-agent-c7-revert-paths.test.ts](../../tests/coding-agent-c7-revert-paths.test.ts), [coding-agent-c7-run-stream.test.ts](../../tests/coding-agent-c7-run-stream.test.ts), [coding-agent-c7-session-control.test.ts](../../tests/coding-agent-c7-session-control.test.ts), [coding-agent-c7-usage-and-rbac.test.ts](../../tests/coding-agent-c7-usage-and-rbac.test.ts), [coding-agent-c7-web-xss-source-scan.test.ts](../../tests/coding-agent-c7-web-xss-source-scan.test.ts), [coding-agent-c7-workspace-cleanup.test.ts](../../tests/coding-agent-c7-workspace-cleanup.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [764](PLAN.md) | Settings -> Code: список code-проєктів і сесій (вже є мінімум з C1), створення проєкту (import repository, upload, пустий), перейменування, архівація, видалення (підтвердження; видалення прибирає workspace і sandbox). | Untested | Not individually certified. |
| [765](PLAN.md) | Workspace page: ліворуч дерево файлів; по центру стрім агента (повідомлення, tool calls як згортувані елементи з файлом/командою/результатом, змінені файли з inline diff, plan/todo блок); праворуч перегляд файлу з підсвіткою (використати існуючий editor-компонент, read-only за замовчуванням; ручне редагування лише через revision control з C3, якщо це вписується в архітектуру); внизу вкладки Changes, Terminal, Logs, Activity. | Partial | [file revision API tests](../../tests/project-files-integration.test.ts), [actual page DOM tests](../../apps/web/src/__tests__/code-workspace-page.test.tsx) — Actual file tree/read/edit, observed revisions and stale response fencing tested. Entire editor/inline-diff/plan/todo and real deployed browser acceptance remain open. |
| [766](PLAN.md) | Changes: список змінених файлів з diff, дії Revert file / Revert all (через checkpoints). | Untested | Not individually certified. |
| [767](PLAN.md) | Approval cards: diff або команда з cwd, дії Approve once / for session / for project / Deny + коментар. | Partial | [actual page DOM tests](../../apps/web/src/__tests__/code-workspace-page.test.tsx) — One card decision cannot decide another same-command/different-diff request; scoped request mapping tested. Full authenticated browser approval/resume and all deployment policies remain open. |
| [768](PLAN.md) | Панель керування: перемикач режиму (plan/ask/auto_edit/full_auto_sandbox), вибір моделі, Stop, індикатор токенів/вартості, кнопка "Open Preview" для web-проєктів (reuse Live Preview). | Untested | Not individually certified. |
| [769](PLAN.md) | Інтеграція з чатом NPATI: картка code-проєкту/сесії в звичайному чаті з кнопками Open Workspace / Changes; продовження розмови в чаті використовує active project. | Untested | Not individually certified. |
| [770](PLAN.md) | Посилання Website Builder -> Open in Code Workspace. | Untested | Not individually certified. |
| [771](PLAN.md) | Адаптація під mobile (панелі/tabs), клавіатурні скорочення для desktop, стани: порожньо, помилка sandbox, обрив зв'язку. | Untested | Not individually certified. |
| [772](PLAN.md) | Безпека UI: вивід інструментів рендериться як текст (без виконання HTML/скриптів), посилання з перевіркою. | Partial | [browser-contract-drill.json](../../artifacts/coding-agent-audit-2026-10-15/browser-contract-drill.json) — Actual Async Workspace component renders malicious output inert in Chromium with mocked HTTP. All Workspace surfaces and live transports not certified. |
| [775](PLAN.md) | Frontend: рендер стріму, tool calls, diff, approval flow, зміна режиму, Stop. | Partial | [web-current.json](../../artifacts/coding-agent-audit-2026-10-15/web-current.json) — Actual page DOM verifies approval selection, session mode revisions, stored aliases and file races. Mock HTTP does not certify a real agent/browser workflow. |
| [776](PLAN.md) | Ізоляція: не можна відкрити чужу сесію підміною ID. | Untested | Not individually certified. |
| [777](PLAN.md) | XSS у виводі інструментів і в іменах файлів. | Untested | Not individually certified. |
| [778](PLAN.md) | Регресія Website Builder і Chat. | Untested | Not individually certified. |
| [781](PLAN.md) | Користувач імпортує репозиторій, у Code Workspace просить зробити зміну, бачить стрім, підтверджує approval, бачить diff і результат тестів. | Untested | Not individually certified. |
| [782](PLAN.md) | Усе ізольовано, небезпечні дії потребують approval, run видно в Activity. | Untested | Not individually certified. |
| [783](PLAN.md) | Коли feature flag вимкнений: створення сесій, run, tools і approvals недоступні, а History, Activity, перегляд Changes і Export лишаються в режимі read-only. C7 означає feature complete, але не готовність до rollout (див. G1 і R1). | Untested | Not individually certified. |

## G1 evidence

[run-security-gate.mjs](../../scripts/lib/run-security-gate.mjs), [ci.yml](../../.github/workflows/ci.yml), [security-gate-report.md](../../docs/coding-agent/security-gate-report.md)

Supporting suites: [coding-agent-g1-clean-clone-prerequisites.test.ts](../../tests/coding-agent-g1-clean-clone-prerequisites.test.ts), [coding-agent-g1-crypto-vault-production-key-timing.test.ts](../../tests/coding-agent-g1-crypto-vault-production-key-timing.test.ts), [coding-agent-g1-migrations-postgres.test.ts](../../tests/coding-agent-g1-migrations-postgres.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [796](PLAN.md) | Suite security-gate у CI: окрема обов'язкова job (не skip-иться, блокує merge/release), hermetic, з детермінованими скриптованими атаками (mock-модель) і опційним прогоном на реальних моделях. Запускається при кожній зміні в sandbox/tools/policy/runner (path-filter) і за розкладом. | Untested | Not individually certified. |
| [797](PLAN.md) | Покриття: | Untested | Not individually certified. |
| [798](PLAN.md) | Sandbox escape: читання шляхів хоста (/proc, /etc, каталоги NPATI, змонтовані томи), docker socket, privileged/capabilities, metadata endpoints (169.254.169.254), доступ до внутрішніх сервісів NPATI, postgres і postgres-projects, доступ до sandbox іншого проєкту чи користувача, мережа поза allowlist, fork bomb, вичерпання диска і пам'яті. | Untested | Not individually certified. |
| [799](PLAN.md) | Secret leak: canary-секрети в env хоста, secret storage, .env у workspace, git config, виводі команд; перевірка, що canary не з'являються в prompts до моделі, tool results, Activity, логах, diff, Preview, підсумках, експорті сесії і повідомленнях про помилки. | Untested | Not individually certified. |
| [800](PLAN.md) | Path traversal: усі fs-tools (read, grep, edit, apply_patch, write, move, delete), symlink, hardlink, архіви (zip-slip), git операції (.git/config, hooks, submodules), нормалізація unicode, null bytes, довгі шляхи. | Untested | Not individually certified. |
| [801](PLAN.md) | Approval bypass: обфускація команд (base64, eval, змінні, підстановки, alias/PATH, heredoc), ланцюжки &&, ;, \|, запис скрипта і його запуск, npm run script, що викликає небезпечне, git hooks, зміна режиму з вмісту файлу, зловживання approve-for-project, повторне використання approval для іншої дії, TOCTOU між показаним approval і виконанням (виконується саме те, що схвалено, перевірка hash payload). | Untested | Not individually certified. |
| [802](PLAN.md) | Prompt injection: README, NPATI.md/AGENTS.md недовіреного репозиторію, коментарі в коді, вивід команд, веб-сторінки, MCP-відповіді: жодних змін режиму, дозволів, hooks чи витоку секретів. | Untested | Not individually certified. |
| [803](PLAN.md) | Supply chain (C4a) і міграції БД (C6a): повторний прогон. | Untested | Not individually certified. |
| [804](PLAN.md) | Ізоляція user/company/project/session/sandbox для API, UI, preview, WebSocket/SSE. | Untested | Not individually certified. |
| [805](PLAN.md) | UI: XSS у виводі інструментів, іменах файлів і diff; CSRF та ідентифікація на approval endpoints. | Untested | Not individually certified. |
| [806](PLAN.md) | Feature flags: вимкнений flag неможливо обійти прямим викликом API/tool; kill switch працює під навантаженням. | Untested | Not individually certified. |
| [807](PLAN.md) | RBAC: ескалація ролей, self-approval, replay approval, токен агента як approver, зміна ролі посеред run, automation identity. | Untested | Not individually certified. |
| [808](PLAN.md) | Egress: SSRF-набір з C4b (IP-кодування, DNS-rebinding, редиректи на metadata/localhost, внутрішні сервіси NPATI), SSRF-safe клієнт у NPATI-tools. | Untested | Not individually certified. |
| [809](PLAN.md) | Sandbox images: запуск unsigned/tag-only/revoked/stale-scan образу неможливий. | Untested | Not individually certified. |
| [810](PLAN.md) | Provider data policy: restricted-проєкт не йде на hosted-провайдера, canary-секрети не доходять до mock-провайдера, fallback і субагенти не обходять політику, exfiltration guard. | Untested | Not individually certified. |
| [811](PLAN.md) | Audit integrity: UPDATE/DELETE audit-рядків, виявлення зміни в обхід застосунку, розрив ланцюга, fail closed, підміна payload між схваленням і виконанням. | Untested | Not individually certified. |
| [812](PLAN.md) | SecretLease і захищені гілки: секрет не успадковується наступним tool call чи фоновим процесом, production-lease не видається; force push і пряма запис агентом у захищені гілки заблоковані для будь-якої ролі, включно з owner, а політику гілок не можна змінити з сесії агента. | Untested | Not individually certified. |
| [813](PLAN.md) | Mutation-перевірка чутливості suite: у гілці-приманці навмисно послабити контроль (наприклад вимкнути path check або секрет-редакцію) і переконатись, що suite падає. | Untested | Not individually certified. |
| [814](PLAN.md) | Звіт docs/coding-agent/security-gate-report.md: перелік тестів, результати, відомі прийняті ризики (з власником і терміном), ручний чекліст (конфігурація sandbox, права ролей, мережа) і sign-off. | Untested | Not individually certified. |
| [815](PLAN.md) | Політика: будь-який fail блокує вихід Phase 1 і просування flags за межі internal; кожна виправлена вразливість додає регресійний тест у suite. | Untested | Not individually certified. |
| [818](PLAN.md) | Усі тести зелені; mutation-перевірка підтверджує, що suite ловить послаблення захисту. | Untested | Not individually certified. |
| [819](PLAN.md) | Звіт підписаний. Rollout дозволений лише після G1 і R1 (спершу allowlist користувачів/Company). | Untested | Not individually certified. |

## R1 evidence

[code-run-queue.ts](../../apps/agent-api/src/code-run-queue.ts), [code-run-quota.ts](../../apps/agent-api/src/code-run-quota.ts), [sandbox-resource-quota.ts](../../apps/agent-api/src/sandbox-resource-quota.ts), [code-data-retention.ts](../../apps/agent-api/src/code-data-retention.ts), [code-data-erasure.ts](../../apps/agent-api/src/code-data-erasure.ts)

Supporting suites: No stage-named suite; see runtime acceptance and report.

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [832](PLAN.md) | Rate limits: запуски run-ів на користувача і на Company за період; паралельні run-и (стартово 2 на користувача, 5 на Company); паралельні sandbox (стартово 5 на Company). | Untested | Not individually certified. |
| [833](PLAN.md) | Бюджети: токени і вартість на run, на день, на Company; через існуючу систему routing/budget; зупинка з чітким поясненням і сповіщенням при 80% і 100%. | Untested | Not individually certified. |
| [834](PLAN.md) | Черга з backpressure: обмежена довжина (стартово 50), справедливе планування між Company, відмова з retry-after при переповненні, видимий стан у UI. | Untested | Not individually certified. |
| [835](PLAN.md) | Ресурсні квоти: CPU/RAM/disk/pids на sandbox (стартово 2 vCPU, 4 ГБ, 10 ГБ, 512 pids) і сумарно на Company; admission control: нові sandbox не запускаються, коли хост перевантажений (стартово CPU вище 80% або вільної RAM менше 15%). | Untested | Not individually certified. |
| [836](PLAN.md) | Квоти застосовуються на сервері і не обходяться через API, субагентів чи Automations. | Untested | Not individually certified. |
| [839](PLAN.md) | Метрики, логи і tracing для runner, sandbox, черги, інструментів, провайдерів (без вмісту промптів і секретів). | Untested | Not individually certified. |
| [840](PLAN.md) | Метрики: sandbox startup time, queue wait, tool error rate, recovery rate (успішні відновлення серед interrupted), provider fallback rate, p95 run latency, cost per run, частка approvals, використання квот. | Untested | Not individually certified. |
| [841](PLAN.md) | Стартові SLO (калібрувати за результатами evals C14): sandbox startup p95 не більше 20 с (холодний) і 5 с (теплий); queue wait p95 не більше 30 с; tool error rate не більше 5%; recovery success не менше 95%; алерт при provider fallback rate вище 20% за годину; алерт при cost per run більше 3x від медіани. | Untested | Not individually certified. |
| [842](PLAN.md) | Алерти власнику через існуючі канали (Integrations, email), runbook для кожного алерту (що перевірити, як вимкнути flag, як очистити чергу). Окремий критичний алерт при розриві ланцюга AuditLog (C1c) або невдалій верифікації anchor. Опційне автовимкнення flags (C1a) при порушенні SLO чи security-подіях. | Untested | Not individually certified. |
| [843](PLAN.md) | Сторінка стану Coding Agent (в Activity або Connected Services): стан черги, sandbox, провайдерів, квоти. | Untested | Not individually certified. |
| [846](PLAN.md) | Retention classes для: prompts і transcripts, tool results, terminal logs, checkpoints, workspaces, sandbox artifacts, snapshots, summaries, Activity-події. Стартові значення: tool results і terminal logs 30 днів, transcripts 90 днів, checkpoints 30 днів після завершення сесії, sandbox artifacts 7 днів, workspaces до видалення/архівації проєкту (архівовані 90 днів), Activity-метадані довше. Усе конфігуроване; classification впливає на строки. | Untested | Not individually certified. |
| [847](PLAN.md) | Автоочищення: періодична задача (на базі reaper із C6a), ідемпотентна, з dry-run, лог результатів. | Untested | Not individually certified. |
| [848](PLAN.md) | Export і delete користувачем: експорт сесій і diff у Markdown/JSON (без секретів); видалення сесії або проєкту прибирає transcripts, tool results, логи, checkpoints, workspace, sandbox artifacts, кеші, summaries; після видалення перевірка, що даних не лишилось. | Untested | Not individually certified. |
| [849](PLAN.md) | Backups: секрети ніколи не потрапляють у backups (secret storage виключене або шифроване окремо); файли за secret-патернами виключаються з checkpoints і backups; backups шифровані й мають обмежений retention. Задокументувати, що видалені дані лишаються в backups до кінця їх retention. | Untested | Not individually certified. |
| [850](PLAN.md) | Дані, надіслані зовнішнім провайдерам, підпадають під їхні умови (див. ProviderDataPolicy C5b); показати користувачу це в налаштуваннях приватності. | Untested | Not individually certified. |
| [851](PLAN.md) | AuditLog (C1c) має окремий довший retention і не підпадає під автоочищення логів; видалення даних користувача лишає в аудиті лише id і хеші. | Untested | Not individually certified. |
| [854](PLAN.md) | Rate limit, concurrent sandbox, бюджет і черга спрацьовують і не обходяться (через API, субагентів, Automations). | Untested | Not individually certified. |
| [855](PLAN.md) | Backpressure: переповнена черга повертає retry-after; перевантажений хост не запускає нові sandbox. | Untested | Not individually certified. |
| [856](PLAN.md) | Метрики й алерти спрацьовують на штучні збої (повільний старт sandbox, спалах помилок інструментів, масові fallback). | Untested | Not individually certified. |
| [857](PLAN.md) | Retention: дані старіші за строк очищаються; export не містить секретів; delete прибирає все (перевірка по сховищах). | Untested | Not individually certified. |
| [858](PLAN.md) | Canary-секрет не потрапляє в backup, checkpoints або export. | Untested | Not individually certified. |
| [859](PLAN.md) | Ізоляція квот між Company. | Untested | Not individually certified. |
| [862](PLAN.md) | Є дашборд і алерти за SLO; ліміти діють; retention, export і delete працюють; канарка секрету відсутня в backups. | Untested | Not individually certified. |
| [863](PLAN.md) | Після G1 і R1 дозволений rollout за межі internal (allowlist, далі відсоток). | Untested | Not individually certified. |

## C8 evidence

[code-conversation-compaction.ts](../../apps/agent-api/src/code-conversation-compaction.ts), [coding-agent-context-compactor.ts](../../apps/agent-api/src/coding-agent-context-compactor.ts), [code-repo-map.ts](../../apps/agent-api/src/code-repo-map.ts), [code-instructions-loader.ts](../../apps/agent-api/src/code-instructions-loader.ts)

Supporting suites: [coding-agent-c8-context-compaction.test.ts](../../tests/coding-agent-c8-context-compaction.test.ts), [coding-agent-c8-instructions-trust.test.ts](../../tests/coding-agent-c8-instructions-trust.test.ts), [coding-agent-c8-instructions.test.ts](../../tests/coding-agent-c8-instructions.test.ts), [coding-agent-c8-long-session.test.ts](../../tests/coding-agent-c8-long-session.test.ts), [coding-agent-c8-replay-compaction-e2e.test.ts](../../tests/coding-agent-c8-replay-compaction-e2e.test.ts), [coding-agent-c8-replay-compression.test.ts](../../tests/coding-agent-c8-replay-compression.test.ts), [coding-agent-c8-repo-map.test.ts](../../tests/coding-agent-c8-repo-map.test.ts), [coding-agent-c8-summary-guard-prefix.test.ts](../../tests/coding-agent-c8-summary-guard-prefix.test.ts), [coding-agent-c8-symbols-wiring.test.ts](../../tests/coding-agent-c8-symbols-wiring.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [874](PLAN.md) | Файл інструкцій проєкту NPATI.md у корені (читати також AGENTS.md як сумісність; ієрархія: глобальні інструкції користувача -> проєкт -> підкаталог). Додавання в system prompt з лімітом розміру. Команда init: агент аналізує репозиторій і пропонує чернетку NPATI.md (запис лише після approval). | Untested | Not individually certified. |
| [875](PLAN.md) | ДОВІРА: інструкції з імпортованого/клонованого репозиторію вважаються ненадійними; до явного "trust this project" вони показуються як дані і не можуть змінювати правила, режими, hooks. Після довіри діють лише як стилістичні/проєктні інструкції, без права підвищувати дозволи. | Untested | Not individually certified. |
| [876](PLAN.md) | Repo map: стислий ранжований огляд символів і файлів (tree-sitter або еквівалент) з кешем за commit hash, лімітом токенів, оновленням після змін. | Untested | Not individually certified. |
| [877](PLAN.md) | Керування вихідними даними: обрізання, вікна читання, заміна старих результатів інструментів на короткі заглушки, коли контекст зростає, зі збереженням самих викликів. | Untested | Not individually certified. |
| [878](PLAN.md) | Стиснення розмови при 75% вікна моделі (враховувати context_window з профілю): структурований підсумок (мета, прийняті рішення, змінені файли, виконані команди і результати, відкриті проблеми, наступні кроки) + останні N ходів дослівно. Підсумок зберігається як артефакт сесії і не містить секретів. | Untested | Not individually certified. |
| [879](PLAN.md) | Prompt caching: стабільний префікс prompt (system, tools, інструкції) для провайдерів, що це підтримують. | Untested | Not individually certified. |
| [880](PLAN.md) | Інтеграція з Company Memory (читання релевантних постійних правил компанії) і Project Context із Website Builder; не змішувати з NPATI.md; секрети не потрапляють у контекст. | Untested | Not individually certified. |
| [883](PLAN.md) | Ієрархія інструкцій; обмеження розміру. | Untested | Not individually certified. |
| [884](PLAN.md) | Інструкція з недовіреного репозиторію не змінює дозволи (injection-тест). | Untested | Not individually certified. |
| [885](PLAN.md) | Стиснення зберігає ключові факти (скриптована перевірка на сесії зі штучними фактами). | Untested | Not individually certified. |
| [886](PLAN.md) | Repo map коректний і кеш інвалідовується після змін. | Untested | Not individually certified. |
| [887](PLAN.md) | Обрізання результатів не ламає цикл. | Untested | Not individually certified. |
| [890](PLAN.md) | Сесія на великому репозиторії з 100+ ходів проходить із автоматичним стисненням без втрати мети і рішень; NPATI.md використовується тільки після довіри. | Untested | Not individually certified. |

## C9 evidence

[code-verification-loop.ts](../../apps/agent-api/src/code-verification-loop.ts), [code-self-review.ts](../../apps/agent-api/src/code-self-review.ts), [code-plan-tool.ts](../../apps/agent-api/src/code-plan-tool.ts)

Supporting suites: [coding-agent-c9-ask-user-reaper.test.ts](../../tests/coding-agent-c9-ask-user-reaper.test.ts), [coding-agent-c9-ask-user-runner.test.ts](../../tests/coding-agent-c9-ask-user-runner.test.ts), [coding-agent-c9-ask-user.test.ts](../../tests/coding-agent-c9-ask-user.test.ts), [coding-agent-c9-goal.test.ts](../../tests/coding-agent-c9-goal.test.ts), [coding-agent-c9-plan-mode.test.ts](../../tests/coding-agent-c9-plan-mode.test.ts), [coding-agent-c9-plan-tool.test.ts](../../tests/coding-agent-c9-plan-tool.test.ts), [coding-agent-c9-runner-verification.test.ts](../../tests/coding-agent-c9-runner-verification.test.ts), [coding-agent-c9-scope-guard.test.ts](../../tests/coding-agent-c9-scope-guard.test.ts), [coding-agent-c9-self-review.test.ts](../../tests/coding-agent-c9-self-review.test.ts), [coding-agent-c9-test-integrity.test.ts](../../tests/coding-agent-c9-test-integrity.test.ts), [coding-agent-c9-verification-loop.test.ts](../../tests/coding-agent-c9-verification-loop.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [901](PLAN.md) | Plan mode: в режимі plan агент досліджує код і створює план (файли, кроки, ризики, стратегія тестів); користувач затверджує, редагує або відхиляє; після затвердження запускається виконання в обраному режимі. План зберігається в сесії. | Untested | Not individually certified. |
| [902](PLAN.md) | Todo tool (code.plan.update): список задач із статусами (pending, in_progress, completed), не більше однієї in_progress; відображається в UI; агент оновлює його під час роботи. | Untested | Not individually certified. |
| [903](PLAN.md) | Verification loop: після змін агент запускає verify (lint/typecheck/тести, що стосуються змін). При невдачі repair loop максимум 3 спроби; після ліміту зупинка із звітом, що саме не проходить. Не видаляти й не послаблювати тести, щоб "зеленіло"; зміна існуючих тестів потребує обґрунтування в підсумку. | Untested | Not individually certified. |
| [904](PLAN.md) | Self-review: один прохід перегляду власного diff окремим prompt (за потреби іншою моделлю): помилки, секрети, зайві зміни, відсутні тести, стиль. Максимум 1 ітерація виправлень. | Untested | Not individually certified. |
| [905](PLAN.md) | Інструмент ask_user (code.ask_user): структуроване питання з варіантами; ставить run на паузу; відповідь в UI (і з месенджера, якщо C5 це підтримує). | Untested | Not individually certified. |
| [906](PLAN.md) | Scope guard: попередження, якщо diff охоплює більше N файлів (конфігуровано) або файли, не пов'язані із запитом. | Untested | Not individually certified. |
| [907](PLAN.md) | Формат підсумку: що зроблено, змінені файли, результат перевірок, ризики, що не зроблено. | Untested | Not individually certified. |
| [908](PLAN.md) | Правило написання тестів: за наявності тестової інфраструктури нова поведінка супроводжується тестом. | Untested | Not individually certified. |
| [911](PLAN.md) | Plan mode не змінює файли; затвердження запускає виконання. | Untested | Not individually certified. |
| [912](PLAN.md) | Repair loop зупиняється після 3 спроб. | Untested | Not individually certified. |
| [913](PLAN.md) | Спроба видалити падаючий тест позначається у звіті. | Untested | Not individually certified. |
| [914](PLAN.md) | ask_user ставить run на паузу і відновлює його. | Untested | Not individually certified. |
| [915](PLAN.md) | Self-review знаходить внесений у тесті секрет/зайву зміну. | Untested | Not individually certified. |
| [916](PLAN.md) | Eval-набір із C6 розширений задачами на verification і не регресує. | Untested | Not individually certified. |
| [919](PLAN.md) | Складна задача: plan -> approval -> реалізація -> тести -> self-review -> підсумок із чесним статусом перевірок. | Untested | Not individually certified. |

## C10 evidence

[code-session-resume.ts](../../apps/agent-api/src/code-session-resume.ts), [code-session-rewind.ts](../../apps/agent-api/src/code-session-rewind.ts), [code-background-run-routes.ts](../../apps/agent-api/src/code-background-run-routes.ts)

Supporting suites: [coding-agent-c10-background-runs.test.ts](../../tests/coding-agent-c10-background-runs.test.ts), [coding-agent-c10-queue-round-robin.test.ts](../../tests/coding-agent-c10-queue-round-robin.test.ts), [coding-agent-c10-resume-environment.test.ts](../../tests/coding-agent-c10-resume-environment.test.ts), [coding-agent-c10-resume.test.ts](../../tests/coding-agent-c10-resume.test.ts), [coding-agent-c10-rewind-fork.test.ts](../../tests/coding-agent-c10-rewind-fork.test.ts), [coding-agent-c10-route-auth-wiring.test.ts](../../tests/coding-agent-c10-route-auth-wiring.test.ts), [coding-agent-c10-run-checkpoint-link.test.ts](../../tests/coding-agent-c10-run-checkpoint-link.test.ts), [coding-agent-c10-run-queue.test.ts](../../tests/coding-agent-c10-run-queue.test.ts), [coding-agent-c10-run-request.test.ts](../../tests/coding-agent-c10-run-request.test.ts), [coding-agent-c10-sandbox-retention.test.ts](../../tests/coding-agent-c10-sandbox-retention.test.ts), [coding-agent-c10-session-durability.test.ts](../../tests/coding-agent-c10-session-durability.test.ts), [coding-agent-c10-session-export.test.ts](../../tests/coding-agent-c10-session-export.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [930](PLAN.md) | Збереження сесії: повідомлення, tool calls, підсумки стиснення, план/todo, стан режиму і правил. | Untested | Not individually certified. |
| [931](PLAN.md) | Resume: продовження сесії після перезапуску браузера і сервера; запущені процеси позначаються як втрачені, workspace і checkpoints відновлюються. | Untested | Not individually certified. |
| [932](PLAN.md) | Rewind: повернення до checkpoint будь-якого ходу у трьох варіантах: лише код, лише розмова, обидва. Rewind сам створює checkpoint перед відкатом. | Untested | Not individually certified. |
| [933](PLAN.md) | Fork сесії (нова гілка розмови з того самого checkpoint). | Untested | Not individually certified. |
| [934](PLAN.md) | Фонові run-и: довга задача триває після закриття вкладки; завершення, помилка або запит approval надсилаються існуючими каналами сповіщень (Integrations); можна повернутись у стрім. | Untested | Not individually certified. |
| [935](PLAN.md) | Черга і ліміти: паралельні run-и на користувача/Company (конфігуровано), справедлива черга, відображення стану в UI. | Untested | Not individually certified. |
| [936](PLAN.md) | Життєвий цикл sandbox: автозупинка при неактивності, відновлення при resume, очищення за політикою збереження, видалення разом із проєктом. | Untested | Not individually certified. |
| [937](PLAN.md) | Експорт сесії у Markdown (без секретів). | Untested | Not individually certified. |

## C11 evidence

[code-git-workflow.ts](../../apps/agent-api/src/code-git-workflow.ts), [code-protected-branches.ts](../../apps/agent-api/src/code-protected-branches.ts)

Supporting suites: [coding-agent-c11-git-boundary-approval.test.ts](../../tests/coding-agent-c11-git-boundary-approval.test.ts), [coding-agent-c11-git-init-approval.test.ts](../../tests/coding-agent-c11-git-init-approval.test.ts), [coding-agent-c11-git-workflow-security.test.ts](../../tests/coding-agent-c11-git-workflow-security.test.ts), [coding-agent-c11-git-workflow.test.ts](../../tests/coding-agent-c11-git-workflow.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [951](PLAN.md) | Capabilities code.git.*: status, diff, log, branch create/switch, stage, commit, restore. Push і create PR через існуючу GitHub integration, лише з approval. | Untested | Not individually certified. |
| [952](PLAN.md) | Авто-гілка на сесію (наприклад npati/{session-short-id}), щоб робота не торкалась основної гілки. Захищені гілки (шаблони за замовчуванням: main, master, release/*, конфігуровано): пряма запис агентом і force push заборонені для всіх (hard deny, включно з owner); зміни потрапляють лише через PR і merge людиною. Політику захищених гілок змінює тільки owner окремою адміністративною дією поза сесією агента (AuditLog, за конфігурацією two-person/step-up); агент і вміст репозиторію її змінити не можуть. | Untested | Not individually certified. |
| [953](PLAN.md) | Коміт: агент генерує повідомлення за стилем репозиторію (аналіз git log); коміт після approval у режимах ask/auto_edit. | Untested | Not individually certified. |
| [954](PLAN.md) | Конфлікти: структуровані помилки; максимум 2 спроби auto-resolve, далі питання користувачу. | Untested | Not individually certified. |
| [955](PLAN.md) | Опис PR: автогенерація (що змінено, як перевірено, ризики) із підсумку сесії; створення PR після approval. | Untested | Not individually certified. |
| [956](PLAN.md) | Інтент REVIEW_CODE: read-only перегляд diff/PR з коментарями за категоріями (баги, безпека, стиль, тести); коментарі в PR лише з approval. | Untested | Not individually certified. |
| [957](PLAN.md) | Git credentials у secret storage, ніколи у prompts/логах; для push/clone видаються як SecretLease на один git-виклик (credential helper), не зберігаються в .git/config і не успадковуються наступними викликами. | Untested | Not individually certified. |

## C12 evidence

[code-subagent-child-runner.ts](../../apps/agent-api/src/code-subagent-child-runner.ts), [code-subagent-limits.ts](../../apps/agent-api/src/code-subagent-limits.ts), [code-subagent-handoff.ts](../../apps/agent-api/src/code-subagent-handoff.ts), [code-agent-spawn-executor.ts](../../apps/agent-api/src/code-agent-spawn-executor.ts)

Supporting suites: [coding-agent-c12-locks-and-budget.test.ts](../../tests/coding-agent-c12-locks-and-budget.test.ts), [coding-agent-c12-parallel-verification.test.ts](../../tests/coding-agent-c12-parallel-verification.test.ts), [coding-agent-c12-subagent-activity-tree.test.ts](../../tests/coding-agent-c12-subagent-activity-tree.test.ts), [coding-agent-c12-subagent-scope.test.ts](../../tests/coding-agent-c12-subagent-scope.test.ts), [coding-agent-c12-subagent-workflow.test.ts](../../tests/coding-agent-c12-subagent-workflow.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [971](PLAN.md) | Інструмент code.agent.spawn: типи explore (read-only, швидка/дешева модель), plan, implement (обмежена область), review, test. Кожен субагент має власне вікно контексту і повертає основному агенту лише підсумок. | Untested | Not individually certified. |
| [972](PLAN.md) | Обмеження: глибина 1 (субагенти не створюють субагентів), до 4 паралельно, capabilities субагента не ширші за батьківського, спільний бюджет токенів, власний ліміт ходів. | Untested | Not individually certified. |
| [973](PLAN.md) | Інтеграція з Company: вибір виконавця за role, description, instructions, capabilities, model (не за agent.name); використовувати існуючі режими single/pipeline/fusion/auto. Не створювати другий orchestration engine. | Untested | Not individually certified. |
| [974](PLAN.md) | Паралельні implement-задачі: ізоляція через git worktree/гілку на агента (reuse Website Builder, крок worktrees), file locking і expected_revision як запобіжник; після завершення review -> merge -> verify. Конфлікти merge: структурована ескалація. | Untested | Not individually certified. |
| [975](PLAN.md) | Activity: вкладені trace для субагентів, видимі статуси задач. | Untested | Not individually certified. |
| [976](PLAN.md) | Для explore-задач включити прості типи за замовчуванням (пошук у репозиторії, огляд архітектури), щоб основний контекст не засмічувався. | Untested | Not individually certified. |

## C13 evidence

[code-hooks.ts](../../apps/agent-api/src/code-hooks.ts), [code-commands.ts](../../apps/agent-api/src/code-commands.ts), [code-skills-instructions.ts](../../apps/agent-api/src/code-skills-instructions.ts), [mcp-run-path.ts](../../apps/agent-api/src/mcp-run-path.ts)

Supporting suites: [coding-agent-c13-capability-catalog-audit.test.ts](../../tests/coding-agent-c13-capability-catalog-audit.test.ts), [coding-agent-c13-hooks-activity.test.ts](../../tests/coding-agent-c13-hooks-activity.test.ts), [coding-agent-c13-hooks-egress.test.ts](../../tests/coding-agent-c13-hooks-egress.test.ts), [coding-agent-c13-hooks.test.ts](../../tests/coding-agent-c13-hooks.test.ts), [coding-agent-c13-mcp-approval-flow.test.ts](../../tests/coding-agent-c13-mcp-approval-flow.test.ts), [coding-agent-c13-mcp-network-safety.test.ts](../../tests/coding-agent-c13-mcp-network-safety.test.ts), [coding-agent-c13-mcp-replay-modes.test.ts](../../tests/coding-agent-c13-mcp-replay-modes.test.ts), [coding-agent-c13-mcp-run-path-wiring.test.ts](../../tests/coding-agent-c13-mcp-run-path-wiring.test.ts), [coding-agent-c13-mcp-run-path.test.ts](../../tests/coding-agent-c13-mcp-run-path.test.ts), [coding-agent-c13-mcp-runtime-capabilities.test.ts](../../tests/coding-agent-c13-mcp-runtime-capabilities.test.ts), [coding-agent-c13-runner-wiring.test.ts](../../tests/coding-agent-c13-runner-wiring.test.ts), [coding-agent-c13-skills-lazy-load.test.ts](../../tests/coding-agent-c13-skills-lazy-load.test.ts), [coding-agent-c13-slash-commands.test.ts](../../tests/coding-agent-c13-slash-commands.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [990](PLAN.md) | Hooks (конфігурація в .npati/ у проєкті або в налаштуваннях користувача): події SessionStart, PreToolUse, PostToolUse, Stop. Hook виконується в sandbox або як webhook; може блокувати виклик, додати контекст, запустити форматер/лінтер. Hook НЕ може підвищити дозволи. Hooks з імпортованого репозиторію вимкнені до "trust this project". | Untested | Not individually certified. |
| [991](PLAN.md) | Slash commands: markdown-шаблони промтів у .npati/commands/ (наприклад /review, /test, /explain) з параметрами; користувацькі і проєктні. | Untested | Not individually certified. |
| [992](PLAN.md) | Інтеграція зі Skills (/settings/skills): підвантаження skill на вимогу за описом, без роздування контексту. | Untested | Not individually certified. |
| [993](PLAN.md) | MCP: підключення зовнішніх MCP-серверів як tool providers через існуючу архітектуру інтеграцій. Їх tools з'являються в Capability Inspector з risk; невідомі за замовчуванням потребують approval. Відповіді MCP вважаються даними (захист від injection). | Untested | Not individually certified. |
| [994](PLAN.md) | Порядок пріоритету налаштувань: system -> користувач -> проєкт -> сесія; ніколи не знижують hard deny. | Untested | Not individually certified. |

## C14 evidence

[code-eval-harness.ts](../../apps/agent-api/src/code-eval-harness.ts), [code-metrics.ts](../../apps/agent-api/src/code-metrics.ts), [tasks.json](../../tests/fixtures/coding-agent-eval/tasks.json)

Supporting suites: [coding-agent-c14-attack-catalogue.test.ts](../../tests/coding-agent-c14-attack-catalogue.test.ts), [coding-agent-c14-ci-and-lint-gates.test.ts](../../tests/coding-agent-c14-ci-and-lint-gates.test.ts), [coding-agent-c14-eval-metrics-and-profiles.test.ts](../../tests/coding-agent-c14-eval-metrics-and-profiles.test.ts), [coding-agent-c14-gate-mutation-sensitivity.test.ts](../../tests/coding-agent-c14-gate-mutation-sensitivity.test.ts), [coding-agent-c14-known-failures.test.ts](../../tests/coding-agent-c14-known-failures.test.ts), [coding-agent-c14-metrics-aggregation.test.ts](../../tests/coding-agent-c14-metrics-aggregation.test.ts), [coding-agent-c14-model-profile-fallback.test.ts](../../tests/coding-agent-c14-model-profile-fallback.test.ts), [coding-agent-c14-model-profile-flags.test.ts](../../tests/coding-agent-c14-model-profile-flags.test.ts), [coding-agent-c14-mutation-branch-controls.test.ts](../../tests/coding-agent-c14-mutation-branch-controls.test.ts), [coding-agent-c14-policy-phase-and-gate-size-guard.test.ts](../../tests/coding-agent-c14-policy-phase-and-gate-size-guard.test.ts), [coding-agent-c14-redteam-command-output-injection.test.ts](../../tests/coding-agent-c14-redteam-command-output-injection.test.ts), [coding-agent-c14-redteam-fork-bomb.test.ts](../../tests/coding-agent-c14-redteam-fork-bomb.test.ts), [coding-agent-c14-redteam-new-channels.test.ts](../../tests/coding-agent-c14-redteam-new-channels.test.ts), [coding-agent-c14-redteam-path-and-zip-slip.test.ts](../../tests/coding-agent-c14-redteam-path-and-zip-slip.test.ts), [coding-agent-c14-redteam-resource-exhaustion.test.ts](../../tests/coding-agent-c14-redteam-resource-exhaustion.test.ts), [coding-agent-c14-replay-cassette-engine.test.ts](../../tests/coding-agent-c14-replay-cassette-engine.test.ts), [coding-agent-c14-replay-cassette-store.test.ts](../../tests/coding-agent-c14-replay-cassette-store.test.ts), [coding-agent-c14-slo-calibration.test.ts](../../tests/coding-agent-c14-slo-calibration.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [1008](PLAN.md) | Розширений eval-набір: 30+ hermetic-задач у 3+ мовах (баг, фіча, рефакторинг, написання тестів, багатофайлова зміна, виправлення збірки, міграція залежності). Оцінка: тести проходять, розмір diff, ходи, токени, вартість, час. | Untested | Not individually certified. |
| [1009](PLAN.md) | Запуск набору на кожному профілі моделі і порівняльний звіт; smoke-підмножина в CI; запис/відтворення відповідей провайдера для детермінованих тестів. | Untested | Not individually certified. |
| [1010](PLAN.md) | Метрики в Activity: success rate, середня кількість ходів, частка невдалих edit-викликів, частка approvals, tool error rate, витрати на run. | Untested | Not individually certified. |
| [1011](PLAN.md) | Розширення red-team suite з G1 (G1 лишається обов'язковим; тут додаються нові класи атак і ширші сценарії): prompt injection через файл/README/NPATI.md/веб/MCP/вивід команди; спроби витоку секретів; спроби втечі з sandbox; path traversal; fork bomb і вичерпання ресурсів; нескінченні цикли; обхід approval через переформулювання; підміна режиму з вмісту файлу; атаки на supply chain і міграції БД. | Untested | Not individually certified. |
| [1012](PLAN.md) | Тонке налаштування лімітів і SLO, започаткованих у R1: бюджети за моделями, виявлення аномалій вартості і поведінки, калібрування порогів за результатами evals. | Untested | Not individually certified. |
| [1013](PLAN.md) | Документація: архітектура, налаштування режимів, безпека, профілі моделей, як додати нову модель і новий tool. | Untested | Not individually certified. |
| [1014](PLAN.md) | Орієнтовні пороги приймання (скоригувати за результатами): успіх edit-інструмента на наборі не нижче 95%, 0 успішних атак у red-team наборі, 0 виходів за межі sandbox. | Untested | Not individually certified. |

## C15 evidence

[mounted-workspace-provider.ts](../../apps/agent-api/src/mounted-workspace-provider.ts), [code-cli-run-routes.ts](../../apps/agent-api/src/code-cli-run-routes.ts), [ide-protocol.md](../../docs/coding-agent/ide-protocol.md)

Supporting suites: [coding-agent-c15-cli-run-start.test.ts](../../tests/coding-agent-c15-cli-run-start.test.ts), [coding-agent-c15-mount-sandbox.test.ts](../../tests/coding-agent-c15-mount-sandbox.test.ts), [coding-agent-c15-mounted-workspace.test.ts](../../tests/coding-agent-c15-mounted-workspace.test.ts)

| PLAN line | Requirement | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| [1027](PLAN.md) | Mounted local folder як WorkspaceProvider: користувач явно додає каталог (allowlist), вибирає ro/rw, підтверджує; жодного доступу до інших шляхів; захист від symlink-виходів; код і команди все одно виконуються в sandbox із цим монтуванням. | Untested | Not individually certified. |
| [1028](PLAN.md) | CLI-клієнт (наприклад npati code) для локального терміналу: автентифікація токеном до локального NPATI API, стрім сесії, approvals у терміналі. | Untested | Not individually certified. |
| [1029](PLAN.md) | Протокол для IDE (VS Code-розширення) як окремий наступний етап; зараз лише специфікація API. | Untested | Not individually certified. |
| [1030](PLAN.md) | ExternalAgentAdapter (опційно): запуск зовнішнього CLI-агента (Claude Code, Codex) як субагента в sandbox із ключами користувача, під тими самими approvals і sandbox-політиками. | Untested | Not individually certified. |
