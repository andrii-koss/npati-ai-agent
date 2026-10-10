# Async Coding Agent — Step 2: повідомлення під час run

Дата: 2026-10-10. Scope: Step 2 із [implementation plan](../../../docs/coding-agent/async-harness-implementation-plan.md), поверх [Step 1](async-inbox-step-1.md). Кроки 3–8 не реалізовувалися. Harness code не переносився.

## Зміни

- `BusinessWorkspace.tsx`: `sending` відповідає за основний chat stream; `inboxSubmitting` — за короткий submit/edit/remove. Після підтвердження Coding Session новий текст іде в inbox, без другого `/chat/stream`. До отримання session identity повторний submit під час stream не запускає роботу; набраний текст залишається в чернетці.
- Enter / «Наступне завдання» → `queue`; «Додати до поточної роботи» → `steer`. UI показує фактичний receipt target, включно з late steer → next-turn. Збережено Stop основного stream і legacy submit для non-code chat.
- `CodePendingMessages.tsx`: server-authoritative pending/claimed list, редагування та видалення тільки pending із `expectedRevision`. Conflict викликає snapshot refresh, а не повтор stale mutation. Текст escaped React, без HTML execution. Є посилання в чинний Code Workspace.
- `code-inbox-client.ts`: чинні messages endpoints, bearer auth, стабільний request id для повтору незавершеного submit, synchronous duplicate-submit guard. Acknowledgement очищає лише ту саму чернетку того самого chat owner. Мережева помилка зберігає текст; новіший текст не перезаписується старим chat failure.
- `use-code-inbox.ts`: observation, generation guards і monotonic snapshot revision. Session/chat pointer зберігається як metadata hint у sessionStorage; текст inbox там не записується. GET після відновлення, focus/online та revision hints повторно перевіряє server authority. Active/unresolved inbox оновлюється раз на 3 секунди у видимій вкладці, без overlapping reads; idle без backlog не poll-иться.
- `chat-stream.ts` та API `app.ts`: additive SSE `code_session` з company/project/session ids та `code_inbox` із session id/revision. Identity оголошується тільки з увімкненим `code.async_inbox` і без private/no-memory mode. Старі SSE consumers можуть ігнорувати нові event types.
- `CodeSessionInboxService.observe()`: process-local revision hints після успішного store commit, dedup ревізій, scoped subscriptions та contained observer failures. Підписка chat знімається у finally; hint не містить тексту і не виконує task. Content читається через вже захищений GET. Snapshot refresh покриває інші hosts і queued runs після завершення первинного SSE.
- Локалізовані labels/statuses для всіх семи чинних мов; компактний CSS із перенесенням довгих повідомлень і кнопок.

## Reuse і незмінні межі

Використано існуючі auth, `code.async_inbox`, CodeRbac/messages API, WorkspaceStore, C6a/session admission, executor/queue і єдиний CodingAgentRunner із Step 1. Step 2 не додає runner, policy engine, worker, process manager, database schema або власну execution ownership.

`next-turn` зберігає Coding Session і chat pointer користувача; backend створює новий runId за Step 1. UI observation не claims input, не запускає execution під час reconnect і не змінює C6/C6a/C9/C10/C12/C14/C15 semantics. При server `feature_disabled` прибирається тільки browser hint і відновлюється legacy UI; durable записи лишаються на сервері. Новий флаг не вмикався.

## Перевірки

| Перевірка | Результат |
|---|---|
| `npm run typecheck`, `typecheck:tests`; фінальний API typecheck та web build typecheck | Passed |
| API build / фінальний web build | Passed / Passed |
| `npm run test:web` | 11 files / 89 tests passed, із них 11 нових Step 2 tests |
| Targeted regressions: inbox, SSE, chat context/cards, self-hosted flags, C6a, C10 cleanup, C12 quota/scope, C15 run-start | 11 files / 134 tests passed |
| `npm run security-gate` | 156 suites / 2259 passed, 0 failed/skipped; schema/image/catalog guards passed |
| `npm test` | 390 files: 375 passed / 10 failed / 5 skipped; 4401 passed / 12 failed / 15 skipped |
| `git diff --check` | Passed |

У full suite ті самі 12 failing cases у 10 файлах, що й фінальний Step 1 baseline: `Compare-Object` між FAIL headers двох serial logs не має відмінностей. Нових failing files/cases не виявлено. Baseline попередньо відтворений на чистому HEAD 4a21cde; assertions, timeout та quarantine не змінювалися. Загальний `npm test` не оголошується зеленим.

Логи: `artifacts/async-inbox-step2-{final-typecheck,final-tests-typecheck,final-api-typecheck,api-build,web-build,web-tests,regressions,security-gate,full-test,diff-check}.log`. Heavy builds/checks завершено до full suite, щоб не створювати штучні timeout failures. Останню зміну ізоляції inbox notice від chat notice повторно перевірено фінальними web build і test:web. Root `npm run build` із catalog generation має попередню вимогу OMNIROUTE_VERSION; перевірено обидві чинні workspace builds, pin не вигадувався.

Автоматизований web coverage включає реальний SSE parser із відкритим auth stream та inbox POST для database у queue/steer, один chat request, authoritative receipt, ambiguous retry/request identity, simultaneous-submit guard, newer draft/foreign chat races, reconnect GET, edit/remove revisions, error propagation, XSS rendering, pending vs claimed controls, queued work після першого stream і legacy SSE. Backend suite перевіряє commit-before-notify, tenant scope, duplicate hints, unsubscribe та observer failure containment. Попередні runner/admission/security tests збережено.

## Межі та залишкові ризики

1. Inbox — текстовий. Вкладення, private/no-memory та TTS не надсилаються цим шляхом; UI пояснює обмеження і залишає чернетку. Це не нова attachment admission policy.
2. Process-local live hints не є durable event tail. Authoritative snapshot і bounded UI refresh забезпечують відновлення стану. Unified snapshot+sequence tail, jobs/children UI та їх completion flow належать наступним крокам.
3. SessionStorage pointer — reconnect hint тієї самої вкладки/збереженого chat id, не durable server conversation linkage. Нова вкладка без hint і disconnect до отримання нового conversation id потребують чинного Code Workspace. Автоматичний replay submit після reload не виконується.
4. Queued task results зберігаються у чинній Coding Session/run history; Step 2 не створює додаткові assistant bubbles з повного transcript queued run. Pending panel, receipt і Code Workspace показують прийняття/стан. Unified completion presentation належить Step 8.
5. Web environment репозиторію — Node + SSR і mocked browser transport, без jsdom/RTL. DOM click-through, реальний browser reload, production SSE proxy і live model не перевірені цими тестами. Транспортні, race та escaping перевірки виконуються автоматично.
6. Зберігаються обмеження Step 1 щодо unattended host-restart wake, retention inbox journal та project-wide sandbox ownership. Step 2 не маскує їх новою RAM execution системою.
