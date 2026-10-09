# Coding Agent: перевірка плану та шляху Settings → Chat

Дата: 2026-10-09. План: [PLAN.md](PLAN.md). Перевірка поточного checkout і локального Docker-стека. Код, налаштування користувача, флаги та сайти під час цього аудиту не змінювалися.

Після цього аудиту внесено [виправлення self-hosted defaults, прав власника та запуску Settings → Workspace → Chat](2026-10-09-self-hosted-code-activation.md).
Наведений нижче стан описує інсталяцію до цих виправлень.

## Висновок

Не можна підтвердити, що всі критерії плану виконані. Backend має реалізований CodingAgentRunner, інструменти, політики, сховище сесій і маршрути запуску. Але інтеграція сторінок Settings/Workspace з цим backend неповна. Наявність компонентів і зелених тестів окремих модулів не доводить працездатність користувацького сценарію.

Локальна перевірка основної БД дала `feature_flags: []`, `code_sessions: []`. Отже, в перевіреній локальній інсталяції Coding Agent не налаштований: відсутні флаги означають `off`, а сесій для запуску немає. Це пояснює, чому звичайний чат може відповідати текстом, не запускаючи coding tools. Це не перевірка production-БД і не доказ стану іншої інсталяції.

`http://localhost:3000/settings/code` повертає HTTP 200. Запит до `/api/companies` без користувацького токена повертає 401. HTTP 200 тут підтверджує доступність вебзастосунку, але не авторизований сценарій у браузері. Реальний платний виклик моделі та повний сценарій зміни репозиторію в цій перевірці не запускалися.

## Перевірки, виконані зараз

| Перевірка | Результат | Межі доказу |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run tests/coding-agent --maxWorkers=2 --reporter=json --outputFile=artifacts/coding-agent-plan-audit-tests.json` | 164 файли; 2320 passed, 1 failed, 11 skipped; exit 1 | Модульні та інтеграційні сценарії, переважно scripted/mock models; не реальна якість підключеної моделі |
| `npm run test:web` | 9 файлів, 76 passed; exit 0 | Компоненти `code-workspace`; повний маршрут Settings → Workspace → Chat не покритий цим результатом |
| `npm run typecheck --workspace @npati/agent-api` | exit 0 | Типізація API, не runtime-поведінка |
| Read-only SQL через локальний API-контейнер | Немає записів флагів і CodeSession | Агреговані метадані основної локальної БД; секрети не виводилися |
| Docker | Основні сервіси, зокрема API та runner, healthy | Healthy не означає, що флаги, модель і доступ до проєкту налаштовані |

Один failed: `tests/coding-agent-c14-known-failures.test.ts`, тест `names tests that really exist in the suite files it points at`. Запис baseline посилається на назву `uses A2A planning, OmniRoute Pipeline…`, якої тест більше не знаходить у відповідному файлі. Це застаріла прив'язка `known-failures.json`, а не підтверджений збій виконання coding tools. Проте результат перевірки червоний; його не можна називати повністю успішним.

Пропущені 11 PostgreSQL-тестів: C1c audit (3), G1 migrations (2), R1c lifecycle (6). Вони потребують окремого DB-gate з тестовою БД. Не запускав цей gate проти користувацької локальної БД: такі тести змінюють схеми, права та тестові дані. Повний `npm test`, production sign-off, chaos-перезапуски і перевірка всіх acceptance-сценаріїв на реальній моделі не виконувалися.

## Матриця кожного кроку плану

«Автотести пройшли» означає результат відповідної групи в поточному запуску. Це не присвоєння кроку production sign-off і не твердження, що перевірений кожен підпункт вимог на живому сервері.

| Крок | Що є в коді / доказ | Поточна оцінка |
| --- | --- | --- |
| C0 — аудит | [00-audit.md](00-audit.md), [architecture.md](architecture.md) | Документи є. Старий аудит не замінює перевірку поточної інсталяції; цей звіт доповнює його |
| C1 — проєкти, workspace, сесії | [code-service.ts](../../apps/agent-api/src/code-service.ts), [code-toolchain-detector.ts](../../apps/agent-api/src/code-toolchain-detector.ts), [code-routes.ts](../../apps/agent-api/src/code-routes.ts), migration-065; 16 тестів | Foundation реалізований. Локально немає сесій. Створення проєкту/сесії саме по собі не запускає модель |
| C1c — audit | [audit-log.ts](../../apps/agent-api/src/audit-log.ts); 10 passed, 3 DB skipped | Механізм і підключення є. Права реальної application-role та append-only у PostgreSQL цим запуском не підтверджені |
| C1a — флаги, версії | [feature-flags.ts](../../apps/agent-api/src/feature-flags.ts), [code-tool-registry.ts](../../apps/agent-api/src/code-tool-registry.ts), [CodeFlagsPanel.tsx](../../apps/web/src/CodeFlagsPanel.tsx); 35 passed | Реалізовано, але локально все off за відсутністю записів. UI показує не весь список серверних підфлагів. Export суперечить вимозі доступності при вимкненому master — див. нижче |
| C1b — образи | [sandbox-image-policy.ts](../../apps/agent-api/src/sandbox-image-policy.ts), `docker/sandbox/`, image build/scan/sign scripts; 25 passed | Admission реалізований. Готовність підписаного production-образу, актуального scan і каталогу не підтверджена цими mock-тестами |
| C2 — read/search | [code-tools-fs.ts](../../apps/agent-api/src/code-tools-fs.ts), [code-tools-path.ts](../../apps/agent-api/src/code-tools-path.ts), [code-read-tracker.ts](../../apps/agent-api/src/code-read-tracker.ts); 56 passed | Реалізовано і перевірено автоматично; живе читання через підключену модель не запускалося |
| C3 — edit/patch/checkpoints | [code-tools-write.ts](../../apps/agent-api/src/code-tools-write.ts), [code-tools-patch.ts](../../apps/agent-api/src/code-tools-patch.ts), [code-workspace-checkpoint.ts](../../apps/agent-api/src/code-workspace-checkpoint.ts); 61 passed | Інструменти та revision/checkpoint guards є. Реальний сценарій агент → зміни → rollback ще потрібен |
| C4 — shell/process/verify | [code-shell-runtime.ts](../../apps/agent-api/src/code-shell-runtime.ts), [code-process-manager.ts](../../apps/agent-api/src/code-process-manager.ts), [code-secret-lease.ts](../../apps/agent-api/src/code-secret-lease.ts), [code-verify-parser.ts](../../apps/agent-api/src/code-verify-parser.ts); 81 passed | Реалізовано. Healthy runner не є доказом виконаного тесту користувацького проєкту |
| C4a — залежності | [code-deps-policy.ts](../../apps/agent-api/src/code-deps-policy.ts), [code-deps-guard.ts](../../apps/agent-api/src/code-deps-guard.ts), [code-deps-audit.ts](../../apps/agent-api/src/code-deps-audit.ts); 81 passed | Policy/guards є. Не виконувалось встановлення залежностей реального репозиторію або перевірка його registry |
| C4b — мережа | [sandbox-egress-enforcement.ts](../../apps/agent-api/src/sandbox-egress-enforcement.ts), [sandbox-egress-proxy.mjs](../../apps/agent-api/src/sandbox-egress-proxy.mjs), [ssrf-safe-http.ts](../../apps/agent-api/src/ssrf-safe-http.ts); 100 passed | Є enforcement і перевірки. Production firewall/DNS/SSRF admission на сервері цим аудитом не вимірювалися |
| C5 — режими/approvals | [code-policy-engine.ts](../../apps/agent-api/src/code-policy-engine.ts), [code-approval-scope.ts](../../apps/agent-api/src/code-approval-scope.ts); 79 passed | Backend є; опис ask/auto_edit у Settings помилковий — див. нижче |
| C5a — RBAC | [code-rbac.ts](../../apps/agent-api/src/code-rbac.ts), [code-membership.ts](../../apps/agent-api/src/code-membership.ts), [code-prod-operations.ts](../../apps/agent-api/src/code-prod-operations.ts); 158 passed | Авторизація є. У composition root production executor — `NullProductionExecutor`: відмова захищена, реальний deploy через цей порт не реалізований |
| C5b — дані провайдера | [provider-data-policy.ts](../../apps/agent-api/src/provider-data-policy.ts), [code-data-policy-routes.ts](../../apps/agent-api/src/code-data-policy-routes.ts), [CodeDataPolicyPanel.tsx](../../apps/web/src/CodeDataPolicyPanel.tsx); 125 passed | Guards/consent реалізовані. Звичайний чат із моделлю не доводить eligibility для confidential/private-коду |
| C6 — цикл агента | [coding-agent-runner.ts](../../apps/agent-api/src/coding-agent-runner.ts), [code-tool-call-adapter.ts](../../apps/agent-api/src/code-tool-call-adapter.ts), [code-intent-routing.ts](../../apps/agent-api/src/code-intent-routing.ts); 108 passed | Справжній tool loop підключений у `app.ts`. Живий запуск локально блокований передумовами: off і відсутність CodeSession |
| C6a — recovery | [code-run-state.ts](../../apps/agent-api/src/code-run-state.ts), [code-run-reconciler.ts](../../apps/agent-api/src/code-run-reconciler.ts), [code-reaper.ts](../../apps/agent-api/src/code-reaper.ts), [code-migration-safety.ts](../../apps/agent-api/src/code-migration-safety.ts); 80 passed | Автоматичні сценарії є. Реальне падіння runner/sandbox із відновленням у Docker не відтворювалося |
| C6b — snapshots/replay | [execution-snapshot.ts](../../apps/agent-api/src/execution-snapshot.ts), [code-replay-engine.ts](../../apps/agent-api/src/code-replay-engine.ts), [CodeSnapshotPanel.tsx](../../apps/web/src/CodeSnapshotPanel.tsx); 92 passed | Recording/replay механізми є. Детермінований replay не доводить однакову відповідь живої моделі |
| C7 — Workspace і Chat | [CodeSettingsPage.tsx](../../apps/web/src/CodeSettingsPage.tsx), [CodeWorkspacePage.tsx](../../apps/web/src/CodeWorkspacePage.tsx), [app.ts](../../apps/agent-api/src/app.ts); 123 backend passed + 76 web passed | **Не завершено як користувацький сценарій:** немає переходу зі списку сесій, поля запуску у Workspace, frontend-запису active-context та частини контролів |
| G1 — security gate | [security-gate-report.md](security-gate-report.md), `scripts/run-security-gate.mjs`, `.github/workflows/`; 14 G1 passed, 2 DB skipped | Автотригери CI вимкнені за раніше зафіксованим рішенням власника. Це прийняте відхилення, а не помилка, яку слід самовільно виправляти. Вимога автоматично блокувати merge/release не виконана |
| R1 — rollout | [code-run-admission.ts](../../apps/agent-api/src/code-run-admission.ts), [code-run-queue.ts](../../apps/agent-api/src/code-run-queue.ts), [code-metrics.ts](../../apps/agent-api/src/code-metrics.ts), [code-data-retention.ts](../../apps/agent-api/src/code-data-retention.ts), [code-data-erasure.ts](../../apps/agent-api/src/code-data-erasure.ts); R1a 45 passed, R1c 27 passed + 6 DB skipped | Ліміти/черга/lifecycle є. Production SLO і delivery алертів не виміряні. Видалення/експорт через UI неповні; DB erasure не підтверджений |
| C8 — контекст | [code-instructions-loader.ts](../../apps/agent-api/src/code-instructions-loader.ts), [code-repo-map.ts](../../apps/agent-api/src/code-repo-map.ts), [code-conversation-compaction.ts](../../apps/agent-api/src/code-conversation-compaction.ts); 101 passed | Реалізовано; великий живий репозиторій зі 100+ ходами не перевірявся |
| C9 — plan/verify/review | [code-plan-mode.ts](../../apps/agent-api/src/code-plan-mode.ts), [code-verification-loop.ts](../../apps/agent-api/src/code-verification-loop.ts), [code-self-review.ts](../../apps/agent-api/src/code-self-review.ts); 137 passed | Backend є. Компоненти plan/ask_user є окремо, але не підключені до поточного `CodeWorkspacePage`; повний UI-сценарій не завершено |
| C10 — resume/rewind/background | [code-session-resume.ts](../../apps/agent-api/src/code-session-resume.ts), [code-session-rewind.ts](../../apps/agent-api/src/code-session-rewind.ts), [code-background-run-registry.ts](../../apps/agent-api/src/code-background-run-registry.ts); 144 passed | Backend є; Workspace не надає повного набору відповідних дій. Реальний restart/browser-disconnect сценарій не виконувався |
| C11 — Git/PR | [code-git-workflow.ts](../../apps/agent-api/src/code-git-workflow.ts), [code-protected-branches.ts](../../apps/agent-api/src/code-protected-branches.ts), [code-tool-git-executors.ts](../../apps/agent-api/src/code-tool-git-executors.ts); 104 passed | Guards/workflow є. Реальний GitHub push/PR не виконувався; read-only review перевірено тестами |
| C12 — субагенти | [code-agent-spawn-executor.ts](../../apps/agent-api/src/code-agent-spawn-executor.ts), [code-subagent-child-runner.ts](../../apps/agent-api/src/code-subagent-child-runner.ts), [code-subagent-limits.ts](../../apps/agent-api/src/code-subagent-limits.ts); 81 passed | Підключення і guards є. Багатоагентний запуск на живих моделях не перевірявся |
| C13 — hooks/commands/skills/MCP | [code-hooks.ts](../../apps/agent-api/src/code-hooks.ts), [code-commands.ts](../../apps/agent-api/src/code-commands.ts), [code-skills-instructions.ts](../../apps/agent-api/src/code-skills-instructions.ts), runtime MCP wiring у `app.ts`; 161 passed | Автоматичні сценарії є. Користувацький MCP-сервер і його credentials/мережа не перевірялися |
| C14 — evals/hardening | [c14-final-report.md](c14-final-report.md), [code-eval-harness.ts](../../apps/agent-api/src/code-eval-harness.ts); 205 passed, **1 failed** | Частково. Baseline stale; у наявному звіті реальна якість по моделях позначена `not_run`. Тести з mock-моделлю не доводять якість підключеної моделі |
| C15 — local/CLI/IDE | [code-mounted-folder.ts](../../apps/agent-api/src/code-mounted-folder.ts), [code-cli-run-routes.ts](../../apps/agent-api/src/code-cli-run-routes.ts), [ide-protocol.md](ide-protocol.md); 71 passed | Опційний крок має реалізацію mounted/CLI та специфікацію IDE. Реальна IDE-сесія не перевірялася; готове IDE-розширення план не вимагав |

## Конкретні розриви користувацького шляху

### 1. Settings не відкриває створену сесію

У `CodeSettingsPage.tsx` список проєктів містить Details, Detect toolchain, Sessions, Archive; список сесій — Archive. Посилання на `/settings/code/:companyId/:projectId?session=:sessionId` немає. Створення сесії закриває drawer і оновлює список, але не активує її і не переводить користувача до Workspace.

Водночас `CodeWorkspacePage.tsx` радить: «Відкрийте Workspace зі списку сесій». Ця порада не відповідає наявним кнопкам. C7.1/C7.6 не завершені.

У цій Settings-сторінці також не знайдено UI для upload, перейменування проєкту або його остаточного видалення, які вимагає C7.1: архівація не замінює видалення. У `ProjectPage.tsx` не знайдено переходу «Open in Code Workspace», який вимагає C7.7. Наявність erasure API або іншого workspace-компонента не закриває ці вимоги до навігації.

### 2. Active-context є в API, але frontend його не записує

Backend підтримує `PUT /companies/:companyId/code/active-context`, перевіряє ownership/session і зберігає pointer у user settings через [code-active-context-store.ts](../../apps/agent-api/src/code-active-context-store.ts). Chat stream у `app.ts` читає його, якщо запит не містить explicit projectId.

Пошук `active-context` по `apps/web/src` не знайшов frontend-виклику цього маршруту. Відкриття Code Workspace або створення CodeSession не робить проєкт активним для чату. Карточка результату може вести у Workspace, але щоб вона з'явилася, треба спочатку успішно запустити агента — вона не вирішує початковий вибір.

### 3. Workspace переглядає роботу, але не має поля запуску

Поточний `CodeWorkspacePage.tsx` завантажує файли, події, changes, usage, approvals, preview. Він не містить composer із запитом користувача або виклику start-run. Тому сценарій плану «відкрити Workspace і попросити зробити зміну» через цю сторінку не виконується.

Окремі `ControlPanel`, `AgentStreamView`, `AskUserCard` у `code-workspace/` мають тести, але їх наявність не означає підключення до цієї сторінки. У Workspace немає вибору моделі, повного plan/ask_user flow, resume/rewind/fork controls. Режим локально починається з `plan` і не завантажується зі збереженої сесії: UI може показувати plan, коли фактична сесія має інший режим.

### 4. Підказки Settings неправильно пояснюють режими

У drawer написано `ask — відповіді без змін`, `auto_edit — правки з підтвердженням`. План і policy engine визначають інакше:

- `plan`: читання/планування, запис заборонений;
- `ask`: зміни можливі після підтвердження;
- `auto_edit`: звичайні правки автоматичні, ризикові дії потребують approval;
- `full_auto_sandbox`: ширша автономія в sandbox із збереженням hard deny та approval-класу.

Також лишилися підказки «цикл агента з'явиться в C6» і «для майбутнього циклу агента». C6 вже підключений. Це застарілий текст, не доказ відсутності runner.

### 5. Export недоступний при вимкненому master

План C1a прямо вимагає Export/Delete навіть при off. `app.ts` передає export-route перевірку `assertEnabled("code.export")`. `FeatureFlagService.resolve` для будь-якого підфлага додає `own.enabled && master.enabled`; отже, master off блокує export. Це підтверджена розбіжність із планом. Delete має окремий erasure flow; його не слід змішувати з цією export-проблемою.

### 6. Керування не всіма флагами доступне у UI

Backend визначає `code.repo_map`, `code.session_resume`, `code.rewind`, `code.session_fork`, `code.export` та pattern-based model-profile/image flags. Статичний список `CODE_SUB_FLAGS` у `CodeFlagsPanel.tsx` не містить усіх цих назв. Для частини функцій немає очевидного керування з цієї панелі.

### 7. Немає доказу production readiness

CI автоматично не запускається за попереднім рішенням власника; його не змінював. DB-gates пропущені, live model quality не виміряна, реальний production executor заглушений відмовою. Тому «всі кроки виконано і працюють у production» було б некоректним висновком.

## Як насправді запускається Coding Agent у чаті

1. Запит має належати вибраній Company.
2. Для користувача/Company master `coding_agent.enabled` має бути ефективно on.
3. Потрібен активний `code_project`; website/mobile залишаються в іншій orchestration-гілці.
4. Потрібна незархівована CodeSession цього проєкту.
5. `resolveChatCodeIntent` має розпізнати code intent.
6. Run проходить admission/квоти/RBAC, image policy, provider data policy і capability/flag перевірки.
7. `CodeSessionRunExecutor` запускає `CodingAgentRunner`; цикл викликає модель, виконує tools, повертає результати моделі й повторюється до завершення/approval/ліміту.
8. З'являються справжні Activity/tool events, diff, verify results і картка `kind: code_project`, `sessionId`, `runId`.

Master off означає звичайний chat path. Відсутній проєкт для code-запиту означає clarification. Відсутня сесія — прохання створити/вибрати сесію. Текст «я перевірив» без tool trace не є доказом запуску.

## Практична перевірка користувачем

### Передумови

У Settings → Code вибрати Company і ввімкнути master та потрібні підфлаги для неї. Для тесту читання потрібен `code.read`; створення сесії зараз також перевіряє `code.write`. Для зміни/тестів потрібні `code.write` і `code.shell`; Git-сценарії додатково `code.git`. `internal` допускає адміністративного користувача. У Company агент-виконавець повинен мати відповідні code capability groups.

Створити або імпортувати невеликий **тестовий** code project. Hosted-модель має бути дозволена ProviderDataPolicy для classification цього проєкту, з необхідною згодою на передачу коду. Не знижувати confidential/restricted лише для обходу помилки. Встановлена default-модель звичайного чату сама по собі не скасовує ці перевірки.

Створити сесію `plan` для читання, `auto_edit` або `ask` для перевірки змін. Вказати справжню verify-команду, наприклад `node --test` для невеликого Node-репозиторію.

Зараз потрібен тимчасовий API-обхід для вибору active-context, бо кнопки frontend не підключені. Маршрут у браузерному застосунку:

```http
PUT /api/companies/<companyId>/code/active-context
Authorization: Bearer <поточний користувацький токен>
Content-Type: application/json

{"contextType":"project","projectId":"<projectId>","sessionId":"<sessionId>"}
```

Відповідь повинна мати `persisted: true`. Використовувати власну авторизовану сесію; токен не надсилати в чат. Це документований обхід, а не нормальна вимога до користувацького інтерфейсу. Не робив цей запис під час аудиту.

Далі в `/chat` вибрати **ту саму Company**, без активного website-проєкту з попередньої розмови.

### Тест 1: читання без змін

```text
Поясни код цього проєкту. Через code.fs.list, code.fs.grep і code.fs.read
знайди точку входу, тестову команду та основні модулі.
Наведи назви файлів і коротко поясни, що вони роблять. Не змінюй файли.
```

Перевірити tool calls у Run Trace; Changes має бути порожнім. Відповідь із вигаданими назвами файлів без викликів tools тест не проходить.

### Тест 2: нові файли, запуск тестів і повторний хід

У сесії `auto_edit` або `ask`:

```text
Створи новий файл npati-probe/sum.cjs з функцією sum(a, b), що повертає суму.
Створи npati-probe/sum.test.cjs з тестами node:test для 2+3 і -2+2.
Запусти node --test npati-probe/sum.test.cjs.
Покажи створені файли, результат команди, exit code і runId.
```

Очікується реальна поява двох файлів у workspace, diff і результат shell-команди з exit code 0. У `ask` підтвердити конкретні edits; у `plan` їх виконання має бути заборонене. Якщо shell policy запитує approval — підтвердити показану команду.

Другим повідомленням:

```text
Зміни функцію sum у npati-probe/sum.cjs: якщо аргумент не є числом,
кидай TypeError. Додай відповідний тест у npati-probe/sum.test.cjs,
не видаляючи попередні. Повторно запусти ці тести і покажи diff та exit code.
```

Очікується read-before-write, зміна тих самих файлів, три успішні тести та продовження тієї самої project/session. Якщо агент пише загальні поради або просить проєкт повторно, перевіряти context/flags, а не вважати це успіхом.

### Тест 3: чесне виявлення помилки

```text
Додай новий тест для sum(2, 3), який очікує 99. Запусти його,
покажи помилку й exit code. Не виправляй функцію і не прибирай тест.
```

Команда повинна завершитися ненульовим exit code. Агент не повинен заявляти, що всі перевірки успішні. Автоматичний verification loop може додатково повідомити, що repair не дозволений умовою завдання або що потрібне рішення користувача.

Цей тест додає навмисно невірну перевірку лише у тестовий проєкт. Після перевірки прибрати її через Changes/Revert або окреме явне завдання.

### Ознаки успішної наскрізної перевірки

- Картка Code, а не Website Builder; є projectId/sessionId/runId.
- У Activity видно справжні read/edit/shell events та аргументи/результати.
- Файли реально змінилися; diff відповідає запиту.
- Тести реально виконані; exit code і failure output відповідають результату.
- Друге повідомлення продовжує той самий проєкт/сесію.
- `plan` не пише, `ask` запитує approval; Stop припиняє виконання.

## Порядок подальших виправлень

1. З'єднати Settings → session → Workspace → Chat: посилання, вибір/запис active-context, запуск із Workspace.
2. Завантажувати фактичний mode сесії; підключити компоненти plan/ask_user/model/durability; виправити тексти режимів.
3. Узгодити Export при master off і список керованих флагів із планом.
4. Виправити застарілий baseline; перевірити DB-gates в окремій тестовій БД.
5. Пройти описаний сценарій на реальній підключеній моделі і зафіксувати її runId, tools, diff, exit codes.

Це перелік результатів аудиту, не вже внесені виправлення. Сайти та їхню sandbox-схему залишено без змін.
