# Async Coding Agent — етап 1/8: durable inbox

Дата завершення перевірок: 2026-10-10. Основа: [implementation plan](../../../docs/coding-agent/async-harness-implementation-plan.md), крок 1. Реалізовано backend inbox і boundary admission. UI, background process promotion, completion outbox, detached children та повний collect barrier ще не реалізовані; це наступні етапи 2–8.

Уточнення плану 2026-10-10: async child має durable worker execution owner; `next-turn` означає новий runId у тій самій Coding Session/chat; process/child start і continuation потребують stable operationId/executionKey. У цьому продовженні production-код Step 1 не змінювався: додано acceptance proof переходу між двома runs через той самий `CodeSessionRunExecutor`/`CodingAgentRunner`, без створення або заміни наявного chat. C6/C6a/C9/C10/C12/C14/C15 semantics не змінено; Step 2 не розпочато.

## Що підключено

- Один чинний `CodingAgentRunner`: optional inbox port у `apps/agent-api/src/coding-agent-runner.ts`. Нового runner або policy engine немає.
- `CodeSessionInboxService` у `apps/agent-api/src/code-session-inbox.ts`: приймання input, перевірка flag/session/credentials, metadata audit, coalesced wake, shutdown через чинний cancellation registry.
- `WorkspaceStore.codeInbox`: PostgreSQL і in-memory adapters з однаковими transition rules (`packages/workspace/src/code-session-inbox*.ts`). Міграція `088_code_session_inbox` додає одну session row із bounded messages; існуючі run/checkpoint tables не замінюються.
- `app.ts`: queue dispatch через наявні `CodeRunAdmission`, `CodeBackgroundRunRegistry`, `CodeSessionRunExecutor`, `CodeRunCancellationRegistry` і sandbox cleanup. Chat, CLI, intent bridge і live replay повідомляють про settlement після власного cleanup. Жодної другої execution pipeline.
- C6a `CodeRunStateLog` лишається owner lease і side-effect journal; inbox transaction додає session admission fence для різних run ids. C10 resume, C9 verification/self-review, C12 scope/digest і C14/C15 security/mount gates збережені.

## API і семантика

`GET/POST /companies/:companyId/code/sessions/:sessionId/messages`; `PUT/DELETE .../messages/:messageId`. Чинні authentication, API version, RBAC та user/company/session ownership обов'язкові.

POST body: `{requestId, text, mode: "queue" | "steer", expectedRevision?}`. Автор і message id встановлюються сервером. POST повертає `202` зі snapshot та authoritative `receipt.target`.

PUT body: `{text, expectedRevision}`; DELETE body: `{expectedRevision}`. Тут revision належить pending message, у POST — inbox. Редагування/видалення claimed або admitted message відхиляється. GET показує pending/claimed messages, не весь admitted history. Помилки містять machine code; текст input не потрапляє в audit.

| Дія | Target / коли споживається |
|---|---|
| `queue` | `next-turn`: новий runId/task у тій самій Coding Session і наявному chat, через чинний admission/executor після terminal state і sandbox cleanup |
| `steer` при live running task | `next-step`: перед наступним model call, після settled tool batch; не змінює вже відправлений request |
| `steer` при idle, відсутній live lease або після seal | Явний receipt `next-turn` |
| Steer перед final proposal | Drain і повторна atomic seal перевірка; input не губиться на race |
| Steer під час C9 verification | На цьому етапі вже `next-turn`, бо cutoff стоїть перед C9; task-revision invalidation запланована на крок 7 |

Кожна queued task повторно перевіряє session status/mode і права; її не запускають з auth context іншого автора. Existing C12 child path, що використовує parent session, не відкриває/не споживає parent inbox.

Backend не створює chat/conversation при dispatch наступної task. Інтеграційний тест підтверджує незмінну session identity, два різні C6a run records і збереження existing conversation/history. Це не end-to-end доказ UI delivery queued results у chat: відображення та transport linkage належать Step 2/8, які тут не реалізуються. Stable identity Step 1 — persisted inbox message id та deterministic `code-inbox-<message.id>` task runId; повторний submit/claim повертає ті самі ids. Runtime operationId/executionKey для processes/children/continuations не додаються передчасно — їх контракт внесено в план кроків 3/5/6.

## State, races і recovery

Input: `pending → claimed → admitted`; лише pending можна `discarded`. Steering drain атомарно зберігає admitted text/run/turn, тому removal-to-admission crash gap відсутній. Inbox phase: `idle → reserved → running → sealed → settled → idle`. Це доповнює C6a, не перейменовує його turn/checkpoint vocabulary.

Події всередині inbox journal: `input.accepted/claimed/admitted/discarded/updated`, `task.opened/sealed/closed/dispatch_failed`. Revision монотонна; admitted content не редагується. Це JSON row із bounded message payload і журналом transitions, **не окремий immutable append-only event table**; C6a side-effect journal лишається чинним.

- PostgreSQL session row і поточні C6a run rows блокуються `FOR UPDATE` у transaction; stale lease не admits input, різні active run ids не створюють двох session drivers.
- Request id dedup у межах company/session; повтор із іншим текстом/автором — conflict. Claim вибирає deterministic run id. Crash до створення C6a row дозволяє retry того самого id; наявний run row не повторюють сліпо.
- Natural completed run dispatch-ить наступну task лише після caller cleanup. Failed/cancelled task зберігає backlog, але не запускає його автоматично. `waiting_for_user` не стає queue state: continuation залишається C10-controlled.
- Run, який програв session admission, не звільняє sandbox активного переможця. Новий run не обходить sealed/settled head до cleanup release. Це fence для перевіреного session call path, не універсальна distributed ownership гарантія над sandbox різних sessions одного project; resource generation/pinning потребуватимуть producer етапів.
- Wake latch закриває lost-wakeup race під час останнього await; dispatch failure зберігається як `lastError`, tasks не видаляються. Host close зупиняє admission і drains зареєстровані wakes через existing cancellation.
- Після restart pending/admitted inputs зберігаються в PostgreSQL. Автоматичного unattended wake після повного host restart немає: потрібен authenticated wake/submit або чинний C10 recovery. Auth context не реконструюється з persisted user id.
- Якщо lease або durable settlement неможливо підтвердити, runner повертає interrupted, не false success; подальша reconciliation — чинна C6a/C10. Немає нового exactly-once replay side effects.

## Storage і rollout limits

`code.async_inbox` — новий opt-in subflag, **off навіть для self-hosted default-on**, під master `coding_agent.enabled`. Flag не ввімкнений цими змінами; старі endpoints/tool responses не змінені.

Limits: 100 pending, 1000 total messages, 16 000 characters на message, 2 000 000 total characters; переповнення — явний `429 inbox_full`. Це backend із bounded messages, не безмежний lifetime conversation archive. Transition metadata journal поки не має окремого cap/архівації; до тривалого rollout потрібна його retention/archival policy. Наступна storage evolution має зберегти request dedup і recovery receipts.

Classification/retention належать чинній C6b family/erasure pipeline. Для shared row зберігається найсуворіша classification і найдовша retention; нижча пізніша policy їх не знижує. Retention не видаляє pending/claimed inputs або inbox running/waiting run. Explicit authorized erasure лишається через existing data lifecycle service. In-memory adapter — dev/test, не crash durability backend.

## Перевірка

| Перевірка | Результат |
|---|---|
| Новий hermetic suite `coding-agent-async-inbox.test.ts` | 18 tests passed: queue/steer, dedup, revision, lease takeover, session admission race, cleanup cutoff/ownership, credentials/tenant, author authority, wake/shutdown, реальний runner boundary, Fastify+RBAC, next-turn session/chat preservation |
| Step 1 + targeted C6/C6a/C9/C10/C12/C14/C15 regressions | 9 files / 168 tests passed; log `artifacts/async-inbox-step1-clarifications-regression.log` |
| `npm run security-gate` | 156 suites; 2258 passed, 0 failed, 0 skipped |
| `npm run security-gate:db` | 2 suites; 4 passed, 0 failed, 0 skipped; PostgreSQL 17 + pgvector у власному тимчасовому container |
| Новий PostgreSQL suite | Два pools, concurrent admission/dedup, store restart, stale lease rollback, classification/retention monotonicity, повтор міграції |
| `npm run typecheck`, API typecheck, `typecheck:tests` | Passed |
| `npm run lint` | Passed |
| `npm run test:web` | 10 files / 78 tests passed; web code на етапі 1 не змінювався |
| API та web workspace builds | Passed обидва |
| Root `npm run build` | Catalog generation blocked через відсутній `OMNIROUTE_VERSION`; pin не вигадувався, обидва workspace builds виконані окремо |
| `npm test` | Остаточний стабільний full run після уточнень: 10 failed files, 12 failed tests; 4400 passed, 15 skipped (390 files / 4427 tests). Усі 18 inbox tests passed |
| Baseline comparison | Ті самі 10 files / 12 failures відтворені на чистому `HEAD 4a21cde` в ізольованому worktree, з aliases на його workspace sources. 64 tests цих files passed. Нових failures від inbox не виявлено |

Hermetic gate/full suite запускалися з process-local PATH без Docker, щоб чинний negative-control тест «Docker unavailable» мав потрібне середовище. Source assertions/skip rules не послаблювалися. Реальні DB gates виконувалися окремо з доступним Docker і disposable database. Production services/model APIs не запускалися.

Known-red files: `advanced-memory-production`, `agent-api`, `chat-entity-mutations`, `company-orchestration`, `long-ai-company-chat`, `manual-product-e2e-web`, `per-request-no-memory-production`, `production-durable-approvals`, `production-wasm-exec`, `project-intent-router`. Quarantine не змінювалася; full suite не оголошується зеленим.

Логи — `artifacts/async-inbox-*.log`; security verdicts — існуючі `artifacts/security-gate-report.json`, `security-gate-db-report.json`. Новий hermetic suite включений у fixed gate, новий PostgreSQL suite — в обов'язковий DB gate; historical gate sizes не переписувалися.

Після уточнень плану acceptance/regression прогін повторено: 18 inbox tests, 168 targeted tests у 9 files, 2258 security tests у 156 suites, DB gate 4 tests у 2 suites, web 78 tests; workspace/test typechecks і обидва workspace builds passed. Fresh логи мають prefix `artifacts/async-inbox-step1-clarifications-*`. Перший full run під час builds/typechecks мав 15 failed / 4397 passed / 15 skipped; додаткові chat/website timeout cases повторно перевірені окремо — 3 files / 25 tests passed без зміни timeout/assertions. Остаточний full run без паралельних checks (`async-inbox-step1-clarifications-full-test-serial.log`): 12 failed / 4400 passed / 15 skipped, ті самі 10 known-red files, без нових failures. Тимчасовий PostgreSQL container цього повторного прогону прибрано.

## Наступний етап

Етап 2: active-code-session identity у chat stream, окремий submit lock, client inbox adapter/pending panel, явні queue/steer controls. Поточний textarea вже дозволяє набирати текст; blocker — `submit(... || sending)` і відсутність другого submit action, а `disabled={sending}` стосується attachments. Inbox на етапі 1 приймає тільки text; attachments не слід silently dropping або відправляти без окремого policy admission.
