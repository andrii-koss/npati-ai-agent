# Етап 0 — інвентаризація NPATI Coding Agent

**Тип:** фактична інвентаризація (read-only). **Нічого не змінено** — жоден файл коду, конфігурації, тест, БД чи production.
**Дата:** 2026-10-21. **Репозиторій:** `D:\npati\NPATI Agent`.
**Єдиний створений файл:** цей звіт.

---

## Короткий висновок (для рішення про наступний етап)

1. **Ядро вже модель-кероване.** Модель обирає інструменти й файли; бекенд лише фільтрує, авторизує, виконує й вирішує, коли зупинитись. Фіксованого ланцюжка «Read → Plan → Read → Edit» **немає** — його не треба «прибирати», його не існує.
2. **Реальні вузькі місця — не в циклі, а навколо нього:** відсутній prompt caching, відсутній кеш повторних читань, контекст перебудовується на кожен HTTP-запит, верифікація завжди виконує повну команду (`build`/`npm test`) без вибору тестів, self-review — це додатковий LLM-виклик щоразу.
3. **Паралелізм read-only існує, але провайдеру вимкнено `parallel_tool_calls`** — внесок механізму в швидкість не доведений.
4. **Streaming для coding-рану до клієнта відсутній**: користувач бачить маршрутизацію, activity в окремому каналі й фінальний `result`.
5. **Багато дублікатів і мертвого коду:** 4 системи делегування, 3 браузерні стеки, 4 «рушії» вибору моделі, 2 канали Activity; не підключені reaper-порти, `code-diff-guard`, `code-repo-map`, A2A control plane із заглушкою.
6. **Документація розходиться з кодом** (PolicyEngine як «єдина точка рішень»; застарілі номери рядків). Спиратися на неї як на джерело істини не можна.
7. **Перш ніж щось оптимізувати — виміряти.** П'ять метрик у §8 уже мають джерела даних у коді; нових механізмів для цього не потрібно.

---

## 0. Метод і як читати статуси

Кожен висновок нижче прив'язаний до `файл:рядок` і функції. Твердження розділені:

- **ФАКТ** — прочитано в коді (посилання на рядок наведено).
- **ГІПОТЕЗА** — випливає з коду, але не перевірено виконанням.
- **НЕ ПЕРЕВІРЕНО** — потребує runtime-спостереження.

Статуси: `Implemented` / `Partial` / `Broken` / `Missing` / `Not Verified`.
Окрема колонка — **«у chat runtime»**: чи механізм справді досяжний із `POST /chat/stream`, а не лише існує як модуль/роут/адмін-API.

**Правило досяжності, застосоване до всіх рядків:**

```
POST /chat/stream                      apps/agent-api/src/chat-stream-routes.ts:95
  → resolveChatCodeIntent              code-intent-routing.ts:169
  → CodeSessionRunExecutor.execute     code-session-run-executor.ts:163
  → CodingAgentRunner.run              coding-agent-runner.ts:102
  → CodingAgentToolWaves               coding-agent-tool-waves.ts:133
  → CodeToolRuntime.invoke             code-tool-runtime.ts:167
  → executor + write/sandbox port
```

Другий, окремий вхід — «звичайний» чат без кодування: `chat-turn.ts` / `chat-orchestration.ts` → `runChatToolLoop` (`chat-tool-orchestrator.ts:118`).

**Обмеження методу:** аналіз статичний. Нічого не запускалося (ні тести, ні сервер, ні sandbox). Твердження про рантайм-поведінку позначені як гіпотези.

---

## 1. Фактичний потік повідомлення (ФАКТ)

### 1.1. Вхід і маршрутизація наміру

| Крок | Що відбувається | Доказ |
|---|---|---|
| 1 | `POST /chat/stream` приймає `message`, `conversationId`, `contextType`, `projectId`, `attachments` | `chat-stream-routes.ts:84-95` |
| 2 | Автентифікація, перевірка `streamId`, no-memory політика | `:103-106` |
| 3 | Перевірка, що є хоч один підключений провайдер (інакше 409 `AI_PROVIDER_REQUIRED`) | `:107-118` |
| 4 | Оренда стріму (не більше одного активного на користувача/стрім) | `:123` |
| 5 | Семантичний резолвер інтенту (`resolveProjectIntent`) + історія діалогу | `:140-146` |
| 6 | Резолв активного контексту (business/company/project) | `:147` |
| 7 | Класифікація project-intent: семантична або `defaultHybridRouter.classifyProject` | `:151-156` |
| 8 | Головний перемикач кодування `CODE_AGENT_MASTER_FLAG` | `:171-172` |
| 9 | Якщо це створення сайту — створюється проєкт/сесія, готується preview-залежність | `:180-197` |
| 10 | Черга запуску код-рану (admission, ліміти per-user/per-company) | `:217-248` |
| 11 | SSE-стрім відкривається (`progress`/`delta`/`result`/`error`/`code_session`/`code_inbox`) | `:251-273` |
| 12 | Рішення «код чи звичайний чат»: `resolveChatCodeIntent` | `:292-306` |
| 13 | Запуск агентського циклу через `codeSessionRunExecutor.execute` | `:406-431` |
| 14 | Після рану — картка проєкту, збереження повідомлень, авто-Live Preview | `:458-516`; `code-route-lifecycle.ts:309-317` |

**Ключовий факт:** рішення «це coding-запит» приймає **бекенд** (`resolveChatCodeIntent`, `code-intent-routing.ts:169-214`), а не модель. Модель ще не викликана на цьому етапі.

### 1.2. Цикл агента (модель ↔ інструменти)

| Крок | Що відбувається | Доказ |
|---|---|---|
| A | Збирається **один** system prompt на ран (інструкції проєкту, контекст, скіли, ліміти) | `coding-agent-runner.ts:300-303` → `coding-agent-prompt-context.ts:30` |
| B | Формується список інструментів під сесію/режим/скоуп | `coding-agent-runner.ts:252-293` → `coding-agent-tool-catalog.ts:46-90` |
| C | Фіксується ExecutionSnapshot (невдача → ран не стартує) | `coding-agent-runner.ts:307-316` |
| D | Стартує durable run-state + replay-запис | `coding-agent-runner.ts:318-327`; `code-run-state.ts:104` |
| E | **Виклик моделі** з `tools` і `tool_choice` | `coding-agent-runner.ts:504-526` |
| F | Нормалізація tool-calls (native або текстовий протокол), валідація аргументів | `:590-596` → `code-tool-call-adapter.ts:364` |
| G | Виконання: read-only — паралельними хвилями, решта — послідовно | `:698` → `coding-agent-tool-waves.ts:508-538` |
| H | Кожен виклик проходить єдиний `CodeToolRuntime.invoke` (права → валідація → approval → checkpoint → executor) | `code-tool-runtime.ts:167-460` |
| I | Результат повертається моделі як `role:"tool"`; цикл повторюється | `coding-agent-tool-waves.ts:468` |
| J | Коли модель відповіла без tool-calls — **бекенд** запускає верифікацію/самоогляд і завершує ран | `coding-agent-runner.ts:642-682`; `coding-agent-review-coordinator.ts:561-644` |

**Цикл — модель-керований:** модель сама обирає інструмент, файли й аргументи; бекенд лише фільтрує доступне, валідує, авторизує, виконує й вирішує, коли зупинитись. Жодного фіксованого ланцюжка «Read → Plan → Read → Edit» у коді немає (див. §5).

### 1.3. Завершення рану

| Причина | Доказ |
|---|---|
| `completed` після верифікації/самоогляду | `coding-agent-review-coordinator.ts:637-643` |
| `step_limit` (кількість ходів) | `coding-agent-runner.ts:426-430` |
| `time_limit` | `:431-435` |
| `budget_exhausted` (квота токенів/костів) | `:445-449`, `:461-472` |
| `loop_detected` (однакові виклики/помилки/цикли) | `coding-agent-tool-waves.ts:220-229`, `:580-588` |
| `verification_failed` (після вичерпання repair-бюджету) | `coding-agent-review-coordinator.ts:631-635` |
| `cancelled` / `interrupted` (стоп користувача, втрата лізи, флаг) | `coding-agent-runner.ts:400-412` |
| `waiting_for_user` (чекає людину) | `code-session-run-executor.ts:238-242` |

---

## 2. Хто приймає рішення: модель чи бекенд

| Рішення | Хто | Доказ |
|---|---|---|
| Чи це coding-запит | **Бекенд** (класифікатор + feature flag) | `code-intent-routing.ts:169-214` |
| Який проєкт/сесія | **Бекенд** (контекст + картка діалогу) | `chat-stream-routes.ts:147-165`, `:313-315` |
| Яка модель | **Бекенд** (preferences, `activeModelId`, vision-кандидати) | `code-route-lifecycle.ts:322-354` |
| Які інструменти видимі | **Бекенд** (реестр + режим + скоуп + прапорці) | `coding-agent-tool-catalog.ts:46-90` |
| Який інструмент викликати і з якими аргументами | **Модель** (native tool calling; текстовий протокол як fallback) | `coding-agent-runner.ts:504-520`, `:590-596`; `code-model-profiles.ts:465-472` |
| Чи дозволено виклик | **Бекенд** | `code-tool-runtime.ts:190-380` |
| Чи потрібен approval | **Бекенд** (політика + пороги) | `code-edit-approval.ts:70-86`; `code-tool-runtime.ts:366` |
| Коли верифікувати | **Бекенд** (після ходу без tool-calls) | `coding-agent-review-coordinator.ts:577,599` |
| Коли зупинитись | **Бекенд** (ліміти, бюджет, loop, верифікація) | `coding-agent-runner.ts:426-449` |
| Чи стартувати Live Preview | **Бекенд** (гейт за результатом верифікації) | `code-chat-website.ts:73-90` |
| Чи делегувати субагенту | **Модель** (інструмент `code.agent.spawn`), але у website-ранах інструмент прибрано | `coding-agent-tool-catalog.ts:78`; `coding-agent-runner.ts:261,293` |

**Виняток (не-coding чат):** у бізнес/компанійному чаті бекенд часто **примусово** виставляє `tool_choice` на конкретний інструмент і робить окремий планувальний виклик моделі — див. §5.4.

---

## 3. Інвентар механізмів

### 3.0. Провайдери, маршрутизація, вибір моделі

| Механізм | Статус | Доказ | У chat runtime |
|---|---|---|---|
| OmniRoute HTTP engine (єдиний транспорт інференсу) | Implemented | `packages/omniroute-adapter/src/omniroute-engine.ts:72` | так |
| Розширення `auto` у список усіх chat-моделей | Implemented | `omniroute-engine.ts:57-70` | так, лише коли модель = `auto` |
| Перебір кандидатів усередині engine | Implemented | `omniroute-engine.ts:78-126` | так, але кандидат зазвичай один |
| `production-resilient-ai-engine` (обгортка над engine) | Implemented | `production-resilient-ai-engine.ts:99,123-135`; обгорнуто в `app.ts:162` | так |
| `SelfHealingAutoCombo` (перебір `[model, fallbackModel]`) | Implemented | `resilience-admission-queue.ts:216-237` | так, але `fallbackModel` з чату не приходить |
| Вибір моделі для coding-рану | Implemented (**бекенд**) | `code-route-lifecycle.ts:322-354` | так |
| `code-model-profiles` (режим tool-calling, контекст, паралелізм) | Implemented | `code-model-profiles.ts:391`; застосування `coding-agent-runner.ts:275-282` | так |
| `routing-strategies.ts` (11 стратегій) | Implemented, **поза шляхом** | `routing-strategies.ts:116`; єдиний споживач — `a2a-control-plane-routes.ts:108` | **ні** |
| `advanced-routing-engine.ts` | Implemented (dead) | `advanced-routing-engine.ts:59`; імпортер лише тест | **ні** |
| `auto-combo-profiles.ts` | Implemented (dead) | `auto-combo-profiles.ts:126`; імпортери — 2 тести | **ні** |
| `lkgp-router.ts` | Partial (пишеться лише адмін-роутом) | `lkgp-router.ts:77`; `recordSuccess` — `a2a-control-plane-routes.ts:131` | **ні** |
| `resilience-circuit-breaker.ts` | Implemented (dead) | `resilience-circuit-breaker.ts:16`; імпортер — 1 тест | **ні** |
| OmniRoute combos (`ensureCombo`) | Implemented | `omniroute-engine.ts:434`; `company-runtime.ts:568-582` | лише company-рани |
| Каталог провайдерів (352 провайдери) | Implemented (статичні дані) | `scripts/generate-omniroute-provider-catalog.mjs`; `normalized` у `normalization.ts:118` | так |
| Резолвер vision-моделі | Implemented, **дубльований** | `chat-turn.ts:227` і `chat-orchestration.ts:179` — ідентичний вираз | так |

**ФАКТ (важливо для очікувань від fallback):** `CodeSessionRunInput` **не містить** `fallbackModel` (`code-session-run-executor.ts:85-122`), і виконавець передає раннеру лише `model` (`:189-212`). Поле `CodingAgentRunInput.fallbackModel` існує (`coding-agent-runner-contracts.ts:118`) і раннер його пересилає (`coding-agent-runner.ts:522`), але **на шляху `/chat/stream` його ніхто не встановлює**: `resolveModel` повертає один рядок.

Наслідок:
- якщо в налаштуваннях **закріплена** модель (`defaultModelId`) → рівно один кандидат → **реального provider-fallback на рівні NPATI немає**; залишається лише те, що вміє сам OmniRoute;
- якщо модель не закріплена й резолвиться в `auto` → `chatCandidates` розгортає список у всі chat-моделі → fallback працює.

**ГІПОТЕЗА:** `ai-preferences.ts:51` перераховує `mode` з наявності chat-моделей і може робити «автоматичний» режим недосяжним після додавання будь-якої моделі, через що закріплена модель (без fallback) є типовим випадком. Потребує перевірки на реальних налаштуваннях.

### 3.1. Ядро агента, tool calling, паралелізм

| Механізм | Статус | Доказ | У chat runtime |
|---|---|---|---|
| Agent loop (turn-based) | Implemented | `coding-agent-runner.ts:399-700` | так |
| Model-driven tool selection (native) | Implemented | `coding-agent-runner.ts:518-520`; `omniroute-engine.ts:97` | так |
| Text-protocol fallback для слабких моделей | Implemented | `code-model-profiles.ts:465-472`; `code-tool-call-adapter.ts:364` | так |
| Валідація аргументів за JSON-схемою | Implemented | `code-tool-runtime.ts:256` | так |
| Виправлення некоректних аргументів (2 спроби) | Implemented | `coding-agent-runner-prompt.ts:34`; `coding-agent-tool-waves.ts:184-191` | так |
| Паралельні read-only хвилі | **Partial** | `coding-agent-tool-waves.ts:508-523` (`Promise.all`) | так, але див. нижче |
| Паралельні записи | **Missing** (свідомо) | записи йдуть поштучно `:538` | — (послідовно) |
| `parallel_tool_calls: false` на провайдері | Факт | `omniroute-engine.ts:97`; `code-tool-call-adapter.ts:20` | так |
| Ліміт паралелізму | Implemented | `coding-agent-tool-waves.ts:442` = min(profile 4/2/1, `parallelReadOnlyCalls` 8) | так |
| Loop detection: однаковий виклик ×3 | Implemented | `coding-agent-tool-waves.ts:217-229`; `LOOP_REPEAT_THRESHOLD=3` (`coding-agent-runner-prompt.ts:33`) | так |
| Loop detection: однакова помилка ×3 | Implemented | `coding-agent-tool-waves.ts:580-588` | так |
| Loop detection: цикл періоду 2/3 ×3 | Implemented | `coding-agent-tool-waves.ts:237-255` | так |
| Повторна та сама verify-невдача | **Partial** (лише попередження) | `coding-agent-tool-waves.ts:364-372` | так |
| Повторний write без змін (zero-diff) | **Partial** (лише попередження) | `coding-agent-tool-waves.ts:400-409` | так |
| Retry того самого виклику моделі з backoff | **Missing** | у `coding-agent-runner.ts:527-544` — одразу stop `provider_error`; у `coding-agent-tool-waves.ts` ретраїв немає | — |
| Cross-model fallback (двошаровий) | Implemented | `production-resilient-ai-engine.ts:123-135` + `resilience-admission-queue.ts:216-237`; `omniroute-engine.ts:78-126` | **Partial** — див. §3.0: чат передає лише одну модель, тому fallback реально працює тільки в режимі `auto` |
| Streaming токенів до клієнта (coding) | **Missing** | coding-гілка не шле `delta`; SSE-події `:269` | — |
| Streaming токенів (звичайний чат) | Implemented | `chat-turn.ts:455-459` | так |
| Fast mode | **Missing** | пошук `fast mode/fastMode/fast_mode/quick mode/turboMode/speedMode` в `apps/agent-api/src`, `packages`, `apps/web/src`, `.env*`, `docs` — 0 збігів (лише `.turbo`, `gpt-4-turbo`, `--turbopack`) | — |

**ФАКТ-застереження щодо паралелізму:** провайдер отримує `parallel_tool_calls: false`, тому модель зазвичай повертає один tool-call за хід; паралельні хвилі реально спрацьовують лише якщо модель усе ж повернула кілька read-only викликів. Механізм існує, але його внесок у швидкість — **НЕ ПЕРЕВІРЕНО**.

### 3.2. Files / patch / diff / Git

| Механізм | Статус | Доказ | У chat runtime |
|---|---|---|---|
| `code.fs.read/list/tree/grep`, `code.symbols.outline` | Implemented | `code-tool-schemas.json` (50 інструментів, усі `active`) | так |
| `code.fs.write` / `edit` (один файл) | Implemented | `code-tool-executors-write.ts:211,227` | так |
| `code.fs.apply_patch` (unified diff) | Implemented | `code-tools-patch.ts:240` | так |
| Batch-запис кількох файлів **в одному виклику** | Implemented, але **лише через `patch`** | `code-tools-patch.ts:254-279`; схема `{patch,dryRun}` з `additionalProperties:false` | так |
| `code.fs.diff` (diff поточного ходу) | Implemented | `code-tool-runtime.ts:351-360`; `code-tools-diff.ts:174` | так |
| `code.fs.undo_last_turn` | Implemented | `code-tool-runtime.ts:336-350`; `code-tool-runtime-write-guard.ts:275` | так |
| Атомарність патчу + rollback | Implemented | `code-patch-transaction.ts:11,38-65`; `project-file-transaction.ts:101-140` (журнал + restore) | так |
| Read-before-write як **жорсткий блок** | Implemented | `code-tool-runtime-write-guard.ts:107-114` (409 `read_before_write_required`) | так |
| Revision-конфлікт (файл змінився після читання) | Implemented | `code-tool-runtime-write-guard.ts:112-114`; `code-tools-patch.ts:270-272` | так |
| Перевірка запису після запису (read-back/hash) | **Partial** | повертається `sha256`/`revision` від порту (`project-file-transaction.ts:132-134`), але зворотного читання немає | так |
| `code.git.*` (11 інструментів) | Implemented | `code-tool-git-executors.ts:241-453` | так |
| Approval для git-write | Implemented | `code-git-workflow.ts:83-88` (restore/push/pr.create/pr.comment; commit — ні) | так |
| Protected branches | Implemented | `code-protected-branches.ts:199` | так |
| Sensitive-change matrix (CI/Dockerfile/hooks) | **Broken/unwired** | `code-diff-guard.ts:117` не імпортується поза тестами | **ні** |
| Scope guard (забагато файлів) | **Partial** (advisory) | `code-scope-guard.ts:107`; виклик `coding-agent-review-phases.ts:261` | так, лише попередження |

### 3.3. Sandbox / Terminal / процеси

| Механізм | Статус | Доказ | У chat runtime |
|---|---|---|---|
| Єдиний шлях виконання команд — sandbox | Implemented | `code-shell-runtime.ts:266` (немає sandbox → 503) | так |
| RemoteSandboxProvider (HTTP до runner) | Implemented | `sandbox-provider.ts:197` | так |
| Shared runtime (один supervisor, per-project UID/namespace/seccomp) | Implemented | `shared-project-runtime-provider.ts:45-48,207` | так (self-hosted) |
| Isolated Docker runtime (контейнер на проєкт) | Implemented | `docker-sandbox-provider.ts:393` | так (isolated) |
| Egress enforcement (fail-closed) | Implemented | `sandbox-egress-enforcement.ts:117`; iptables owner-rules `shared-project-runtime-provider.ts:95` | так |
| Resource quotas (CPU/mem/pids/disk) | **Partial** (лише Docker) | `sandbox-resource-quota.ts:53`; у shared — лише rlimit | так, режим-залежно |
| Персистентний sandbox між ходами | **Режим-залежно** | shared: `project-sandbox-service.ts:741-746` (release — no-op); isolated: `destroy()` | так |
| Персистентна terminal-сесія (PTY) | **Missing** | немає `node-pty`/PTY; кожна команда — новий `sh -s` (`docker-sandbox-provider.ts:393`, `shared-project-runtime-provider.ts:207`) | — |
| Durable background-процеси | Implemented | `code-async-process.ts:26`; маркери `/tmp/npati-process-*` (`docker-sandbox-provider.ts:504-524`) | так (`exec_async`, `process.*`) |
| Файлова площина: хост як джерело істини, синк у sandbox | Implemented | `project-sandbox-service.ts:293-321` (mount → без синку, `:299`) | так |
| Warm pool / prewarm | **Missing** | пошук `warm|prewarm|pool` — 0 | — |
| Fail-open шлях (запуск без sandbox) | **Не знайдено** | усі залежності кидають 503: `code-shell-runtime.ts:266`, `code-tool-executors-shell.ts:117`, `code-process-manager.ts:106` | — |

### 3.4. Live Preview / Browser QA

| Механізм | Статус | Доказ | У chat runtime |
|---|---|---|---|
| Live Preview (єдиний сервіс) | Implemented | `project-preview-service.ts:271` (start), `:627` (proxy) | так |
| Автостарт після успішного website-рану | Implemented | `code-session-run-executor.ts:213-215` → `code-route-lifecycle.ts:309-317` → `code-chat-website.ts:90` | так |
| Гейт: preview лише після `verification.status==="passed"` + `build` | Implemented | `code-chat-website.ts:81-85` | так |
| HMR | **Missing** | проксі — HTTP `app.all` (`project-preview-routes.ts:172-184`), немає `upgrade`/websocket/watch; після верифікованого білда запускається **production**-сервер (`project-preview-stack.ts:71-73`) | — |
| Browser QA (headless, sandbox-контейнер) | Implemented | `project-browser-qa-service.ts:54-74` | **ні** (не є chat-інструментом) |
| Browser QA як інструмент coding-рану | **Missing** | `code-tool-schemas.json` не містить `code.qa.*`/`code.browser.*` | — |
| Browser QA автоматично | **Partial** (лише multi-agent website pipeline) | `project-multi-agent.ts:340-362` | ні |
| Browser Use Worker (`browser.*`) | Implemented (інший продукт) | `browser-tool.ts:9-11`; потребує env `app.ts:233-234` | ні |
| `/browser/*` контролер | **Broken (mock)** | `browser-automation-controller.ts:142-165` повертає `{success:true}` без браузера | ні |

### 3.5. Activity & Run Trace

| Механізм | Статус | Доказ | У chat runtime |
|---|---|---|---|
| `code_activity_events` (append-only) | Implemented | `postgres-workspace-repositories.ts:450`; `code-run-activity-sink.ts:186,230` | так |
| Durable run state + turns + tool calls | Implemented | `code-run-state.ts:104,220,266,366` | так |
| Replay bundle (model steps + settled tool results) | Implemented | `code-replay-bundle.ts:450,460` | так |
| Policy decisions як activity | Implemented | `policy-decision-activity.ts:183` | так |
| Audit journal (окремо) | Implemented | `audit-log.ts:79` | так |
| SSE-стрім чату передає activity | **Missing** | `chat-stream-routes.ts:269` — лише `progress|delta|result|error|code_session|code_inbox` | — |
| UI-проєкція activity у чаті | **Partial** | `chat-development-service.ts:296-325`; якщо немає `DevelopmentProcess` — подія тихо відкидається (`:317-318`) | частково |
| Окремий канал activity (Development processes stream) | Implemented | `chat-development-stream.ts:9`; `code-monitor-routes.ts:48,70` | так |
| Єдиний рядок «tool + args + result + duration + outcome» | **Missing** | розкидано: `CodeRunToolCallRecord` без args/result (`packages/workspace/src/types/code-run-state.ts:41`), args — у replay (`code-replay-bundle.ts:460`) | — |
| Кореляція runId/sessionId | Implemented | `migration-077.ts:35-56`; `chat-development-trace.ts:60-61,128` | так |
| Code Session Inbox (async-повідомлення) | Implemented | `code-session-inbox.ts:112,16` | так |

### 3.6. Субагенти / делегування

| Механізм | Статус | Доказ | У chat runtime |
|---|---|---|---|
| `code.agent.spawn` (blocking) | Implemented | `code-tool-executors.ts:82`; `code-agent-spawn-executor.ts:350` | так (root-ран) |
| Detached: `spawn_async`/`continue`/`send_message`/`interrupt` | Implemented (flag-gated) | `code-tool-executors.ts:89-100` | так, за прапорцями |
| Depth-1 (3 шари захисту) | Implemented | `code-tool-runtime.ts:225-234`; `code-subagent-limits.ts:33` | так |
| Перетин інструментів (parent ∩ type ∩ record) | Implemented | `subagent-tool-policy.ts:77-168` | так |
| Handoff digest (metadata only) | Implemented | `code-subagent-handoff.ts:8-36,223-232` | так |
| Делегування **примусово** | **Ні** (модель-кероване) | prompt не згадує субагентів (`coding-agent-runner-prompt.ts:163-190`) | — |
| Делегування у website-ранах | **Прибрано зі списку** | `coding-agent-runner.ts:261,293` (regex не містить `code.agent.`) | ні |
| `project-multi-agent` (окремий конвеєр) | Implemented, але **примусовий етап** | `project-orchestrator.ts:476-478` | так (website-гілка) |
| A2A control plane (NestedSubagentManager тощо) | **Partial (лише реєстр)** | `a2a-control-plane-lifecycle-routes.ts:245-276` — створює вузол, нічого не запускає | ні |
| OmniConductor default executor | **Broken (заглушка)** | `a2a-smart-conductor.ts:199-203` повертає вигаданий рядок «executed successfully» | ні |

### 3.7. Контекст, кеш, компакція

| Механізм | Статус | Доказ | У chat runtime |
|---|---|---|---|
| Prompt caching (провайдер) | **Missing** | `ChatRequest` без cache-поля (`packages/omniroute-adapter/src/types.ts:43`); 0 збігів `cache_control/cachedContent/prompt_cache` | — |
| Читання cache-метрик назад | Partial | `omniroute-engine.ts:152` | так (метадані) |
| Прапорець `allowPromptCaching` | Partial (інертний) | `provider-data-policy.ts:56` | так, але нічого не додає |
| Стабільний префікс промпту (для кешу) | Implemented, **не використовується** | `coding-agent-runner-prompt.ts:127` | ні |
| Інкрементальний контекст у межах рану | Implemented | `coding-agent-runner.ts:332-335` + `push` у циклі | так |
| Перебудова контексту на кожен HTTP-запит | Факт | новий масив `[system, prompt]` на ран (`coding-agent-runner.ts:332`) | так |
| Бюджет/тиск контексту | Implemented | `code-context-budget.ts:119`; `coding-agent-runner.ts:452-473` | так |
| Компакція coding-контексту (детермінована, без LLM) | Implemented | `coding-agent-context-compactor.ts:42`; `code-conversation-compaction.ts:293` | так |
| Компакція звичайного чату (LLM-summary) | Implemented | `context-compactor.ts:60-86`; `chat-turn.ts:272` | так |
| Кеш інструкцій проєкту | **Свідомо відсутній** | `code-instructions-loader.ts:25` («There is no cache») | — |
| Кеш скілів (in-memory, per session) | Implemented | `code-skills-instructions.ts:205,396` | так |
| Кеш результатів інструментів | **Partial** (лише idempotency за toolCallId) | `code-tool-runtime.ts:298-304` | так |
| Кеш повторних читань файлів | **Missing** | `code-read-tracker.ts:37` зберігає лише hash/revision | — |
| Repo map + кеш | Implemented, **не підключено** | `code-repo-map.ts:361,272` — 0 імпортерів поза тестами | ні |
| Semantic cache | Partial (адмін-API) | `semantic-cache.ts:38`; лише `reliability-cache-and-backup-routes.ts` | ні |

### 3.8. Верифікація, відновлення, стійкість

| Механізм | Статус | Доказ | У chat runtime |
|---|---|---|---|
| Верифікація **примусова** після змін | Implemented | `coding-agent-review-coordinator.ts:577,599` | так |
| Бекенд сам викликає `code.verify.run` | Implemented | `coding-agent-review-phases.ts:204-216` | так |
| Repair-цикл з бюджетом (3) | Implemented | `code-verification-loop.ts:135-205`; `code-agent-config.ts:74,122` | так |
| Вичерпання бюджету → stop, не «успіх» | Implemented | `coding-agent-review-coordinator.ts:631-635` | так |
| Верифікація потребує людського рішення | Implemented | `VERIFICATION_APPROVAL_REQUIRED` (`code-verification-loop.ts:28`) | так |
| Adaptive/related test selection | **Missing** | `changedOnly` приймається (`code-ports-wiring.ts:197`) і **ніколи не читається** (`:194-263`) | — |
| Test-integrity guard (ослаблені тести) | **Partial** (лише звіт) | `code-test-integrity-guard.ts:1-12` | так |
| Self-review (LLM-прохід) | Implemented | `code-self-review.ts:105`; `coding-agent-review-coordinator.ts:619` | так |
| Crash detection / reconcile | Implemented | `code-run-reconciler.ts:175`; розклад `code-route-lifecycle.ts:160-170` | так |
| Автоматичний повторний запуск після краху | **Missing** | reconciler лише помічає `interrupted`; продовження — ручний роут (`code-session-durability-routes.ts:159`) | — |
| Reaper «завислих» tool-calls / прострочених ранів | **Broken/unwired** | `code-reaper.ts:409-449` потребує портів, відсутніх у `code-ports-wiring.ts:56-122` | ні |
| Background-run registry | Partial (in-process) | `code-background-run-registry.ts:1-26` | так |
| Ручний resume/rewind/fork | Implemented | `code-session-resume.ts`, `code-session-rewind.ts`, `code-session-fork.ts` | ні (роути) |
| Collect barrier (async-результати) | Implemented | `coding-agent-review-coordinator.ts:510-558` | так (за inbox) |

---

## 4. Примусові етапи

Розділено на **необхідні (безпека/коректність)** і **зайві/надлишкові**.

| # | Етап | Де | Клас | Доказ / коментар |
|---|---|---|---|---|
| 1 | Read-before-write (409) | рантайм | **Необхідний** | `code-tool-runtime-write-guard.ts:107-114` — захист від «сліпого» перезапису |
| 2 | Revision-конфлікт | рантайм | **Необхідний** | `code-tool-runtime-write-guard.ts:112`; lost-update захист |
| 3 | Approval (delete, >10 файлів, sensitive, git push/PR) | рантайм | **Необхідний** | `code-edit-approval.ts:70-86`; `code-git-workflow.ts:83-88` |
| 4 | Turn-checkpoint перед записом | рантайм | **Необхідний** | `code-tool-runtime.ts:368` — основа undo/rollback |
| 5 | Feature-прапорці (master + sub-flag) | рантайм | **Необхідний** | `code-tool-runtime.ts:200-201,253` |
| 6 | Верифікація після змін | бекенд | **Необхідний** | `coding-agent-review-coordinator.ts:577,599` |
| 7 | Гейт Live Preview за верифікацією | бекенд | **Необхідний** | `code-chat-website.ts:81-85` — «проза моделі не є доказом білда» |
| 8 | Snapshot перед першим викликом | бекенд | **Необхідний** | `coding-agent-runner.ts:307-316` |
| 9 | «Ліміт інспекції»: 3 ходи без змін → system-нагадування | бекенд | **Спірний** | `coding-agent-runner.ts:480-485`. Це підштовхування в промпті, інструменти не блокуються; для складних задач штучно тисне на «роби зараз» |
| 10 | «Порожні відповіді» ×3 → hard fail (лише при `requireImplementation`) | бекенд | **Спірний** | `coding-agent-runner.ts:642-648`. У `/chat/stream` `requireImplementation` **не передається** (`:406-431`), тому в чаті не діє; діє лише в project-creation (`chat-development-service.ts:452`) |
| 11 | Примусовий `tool_choice = code.fs.write` на ході 0 | бекенд | **Зайвий / вузький** | `coding-agent-runner.ts:519-520` — лише `emptyHtmlWorkspace` + `deepseek-flash`. Решта моделей отримують `auto`; виняток виглядає як обхід конкретної моделі |
| 12 | Prior-implementation marker (system-повідомлення з переліком змінених файлів) | бекенд | Виправданий | `coding-agent-runner.ts:486-491` — проти повторної генерації після компакції |
| 13 | Бюджетне нагадування при <40% токенів | бекенд | Виправданий | `coding-agent-runner.ts:441-444` |
| 14 | Self-review після верифікації | бекенд | Виправданий (але дорогий) | `coding-agent-review-coordinator.ts:619` — додатковий LLM-прохід щоразу |
| 15 | Collect barrier (async) | бекенд | Виправданий за наявності inbox | `coding-agent-review-coordinator.ts:510-558` |
| 16 | **Окремий планувальний LLM-виклик** у бізнес-чаті (при ≥900 символів або ≥8 рядків) | бекенд | **Зайвий/дорогий** | `chat-task-plan.ts:18-30` — ще один виклик моделі; потім план вставляється як system-повідомлення (`chat-orchestration.ts:261`) |
| 17 | Примусовий `tool_choice` на `npati_business_profile`/`npati_company_action` | бекенд | **Спірний** | `chat-orchestration.ts:261` — модель позбавляється вибору інструмента |
| 18 | «Recovery call» — повторний виклик інструмента за бекенд-складеними аргументами | бекенд | **Спірний** | `chat-tool-orchestrator.ts:139-161` |

**Фіксованої послідовності Read → Plan → Read → Edit у коді немає.** Перевірено: `coding-agent-tool-waves.ts` (весь файл), `coding-agent-runner.ts:399-700`, `code-tool-call-adapter.ts:364-622`, `coding-agent-tool-catalog.ts`. Є лише: (а) read-before-write на рівні файлу, (б) режим `plan`, який фільтрує інструменти (`coding-agent-tool-catalog.ts:86-88`), (в) текстові підказки в промпті (`coding-agent-prompt-context.ts:114-119`) — але вони не блокують інші дії.

---

## 5. Дублікати, неактивні можливості, зайві обгортки

### 5.1. Дублікати (ФАКТ)

| Що дублюється | Варіанти | Живий | Доказ |
|---|---|---|---|
| Делегування | `code.agent.spawn` (у циклі) / `project-multi-agent` (примусовий етап) / A2A control plane (реєстр) / `code-company-delegation` (нова сесія) | 1-й і 2-й | `code-tool-executors.ts:82`; `project-orchestrator.ts:476-478`; `a2a-control-plane-lifecycle-routes.ts:245`; `company-tool-runtime.ts:118-121` |
| Браузер | `ProjectBrowserQaService` / Browser Use Worker / `/browser/*` mock | 1-й (QA), 2-й (інше) | `project-browser-qa-service.ts:54`; `browser-tool.ts:9`; `browser-automation-controller.ts:142` |
| Activity | прямий sink → `code_activity_events` / проєкція `onActivity` → user-setting | обидва | `code-run-activity-sink.ts:186`; `chat-development-service.ts:296-325` |
| Компакція контексту | `context-compactor.ts` (чат, LLM) / `coding-agent-context-compactor.ts` + `code-conversation-compaction.ts` (код, детерміновано) | обидва, різні шляхи | `context-compactor.ts:60`; `coding-agent-context-compactor.ts:42` |
| Політика | `PolicyEngine` / прямі гейти рантайму (flags, writeGuard, executionModes, gitPolicy) | другі — основні | `code-tool-runtime.ts:190-380`; `code-shell-runtime.ts:297`; `code-tool-runtime-wiring.ts:231-259` |
| Точки входу чату | `/chat/stream` (UI) / `/chat` / `/api/chat` (Ollama-сумісність) / `/companies/:id/code/intents/run` / development-runs | UI — перший | `chat-stream-routes.ts:95`; `chat-routes.ts:123`; `runtime-compat-routes.ts:103`; `code-intent-routing.ts:242` |
| Preview-команди | dev-сервер vs production-сервер + `reuseDevelopmentPreview` | один сервіс, дві гілки | `project-preview-service.ts:305-311`; `project-preview-reuse.ts:8-26` |
| Планування | `code.plan.propose` (інструмент) / режим `plan` / `chat-task-plan` (бізнес-чат) | всі три | `code-tool-schemas.json`; `coding-agent-tool-catalog.ts:86`; `chat-task-plan.ts:18` |
| Вибір моделі | 4 паралельні «рушії»: `routing-strategies.ts` / `advanced-routing-engine.ts` (dead) / `auto-combo-profiles.ts` (dead) / `lkgp-router.ts` (адмін) | фактично — `resolveModel` + OmniRoute | §3.0 |
| Пам'ять відмов | `lkgp-router.ts` / `resilience-circuit-breaker.ts` (dead) / `SelfHealingAutoCombo` (живий) | третій | `resilience-admission-queue.ts:216` |
| Каталоги моделей | `routing-strategies.ts:59` (hardcoded) / `auto-combo-profiles.ts` (hardcoded) / згенерований `provider-catalog.json` | третій | — |
| Резолвер vision-моделі | ідентичний вираз у двох файлах | обидва | `chat-turn.ts:227`; `chat-orchestration.ts:179` |

### 5.2. Неактивні / не підключені можливості (ФАКТ)

| Модуль | Стан | Доказ |
|---|---|---|
| `advanced-routing-engine.ts` | Лише тест | 0 імпортерів у `src`; згадка в `tests/auto-fusion-pipeline-routing.test.ts` |
| `auto-combo-profiles.ts` | Лише тести + capability matrix | 0 імпортерів у `src` |
| `code-anomaly-detection.ts` | Лише тести | 0 імпортерів у `src` |
| `code-repo-map.ts` | Лише тест | 0 імпортерів у `src` |
| `tools-exec-process-search.ts` | Лише тест | 0 імпортерів у `src` |
| `code-diff-guard.ts` (sensitive changes) | Лише тест | `code-diff-guard.ts:117` |
| `tool-sandbox.ts` (Host `spawn`) | Мертвий код | лише `tests/sandboxing-and-format-translation.test.ts` |
| `semantic-cache.ts` | Лише адмін-API | `reliability-cache-and-backup-routes.ts:108,135` |
| `resilience-circuit-breaker.ts` | Лише тест | 0 імпортерів у `src` |
| `routing-transparency-and-dedup.ts` | Лише reliability-роути | `reliability-operations-singletons.ts:8` |
| `lkgp-router.ts` | Лише A2A-адмін-роут | `a2a-control-plane-routes.ts:131` |
| `compression-caveman-ultra-omniglyph.ts`, `compression-lite-tool-headroom.ts` | Орфани | 0 імпортерів |
| A2A `NestedSubagentManager`/`OmniConductor` | Реєстр/заглушка | `a2a-control-plane-lifecycle-routes.ts:245`; `a2a-smart-conductor.ts:199-203` |
| `systemPromptStablePrefix` | Реалізовано, не споживається | `coding-agent-runner-prompt.ts:127` |
| Reaper stuck-calls/overdue-runs | Оголошено, не підключено | `code-reaper.ts:409-449` vs `code-ports-wiring.ts:56-122` |

### 5.3. Зайві обгортки (ГІПОТЕЗА, з ознаками в коді)

- `code-tool-executors-write.ts:275-300` — legacy-гілки `edits[]`/`files[]` для patch недосяжні: схема `additionalProperties:false` відхиляє такі аргументи (`code-tool-runtime-guards.ts:122-131`).
- `code.fs.diff` входить до `CODE_WRITE_TOOLS` (`code-edit-approval.ts:25`), хоч нічого не змінює — зайва вимога `code.write`.
- `project-file-routes.ts:93` (людський роут видалення) не передає `expectedRevision` — не захищений від lost-update, на відміну від агентського шляху.

---

## 6. Safety-critical інваріанти (ФАКТ)

Ці інваріанти не можна ламати при подальшій оптимізації:

1. **Код ніколи не виконується на хості API.** Без sandbox — 503, не «запустити якось» (`code-shell-runtime.ts:266`). Fail-open шляху не знайдено.
2. **Egress fail-closed.** Вимкнений enforcement не дозволяє, а відмовляє (`sandbox-egress-enforcement.ts:6-13,119,132`).
3. **Модель не є джерелом прав.** Будь-який виклик проходить `CodeToolRuntime.invoke` (`code-tool-runtime.ts:167`): tenant isolation → прапорці → версія інструмента → read-only intent → depth → capability scope → sub-flag → аргументи → execution mode → git policy → idempotency → approval/checkpoint.
4. **Read-before-write і revision-конфлікт — жорсткі блоки, не поради.**
5. **Запис атомарний з журналом і відкатом**; частковий відкат повідомляється як `rollbackIncomplete` (`code-patch-transaction.ts:63`).
6. **Верифікація — бекенд-гейт.** Preview не стартує без `verification.status==="passed"` і `build` (`code-chat-website.ts:81-85`).
7. **Activity — лише метадані.** Контент/секрети відхиляються до запису (`code-run-activity-sink.ts:37-63,201-202`).
8. **Субагент не може делегувати далі** (depth 1) і не отримує `code.agent.*` (`code-tool-runtime.ts:225-234`; `code-agent-spawn-executor.ts:426-446`).
9. **PolicyEngine не є єдиною точкою рішення для fs-записів.** Він застосовується до shell (`code-shell-runtime.ts:297`), git (`code-tool-runtime-wiring.ts:231-250`), MCP (`mcp-run-path.ts:427`), а для `code.fs.*` — лише коли активні hooks (`code-tool-runtime.ts:418-419`). Твердження `docs/coding-agent/architecture.md` про «single decision point for every privileged action» **не відповідає коду** — це важливо знати, щоб не покладатися на нього.

---

## 7. Невідомості та розбіжності

| # | Що невідомо | Чому важливо | Де шукати |
|---|---|---|---|
| 1 | Який режим sandbox реально працює в цьому розгортанні (`shared` vs `isolated`) | визначає персистентність, квоти, поведінку preview | `.env` не містить `NPATI_SANDBOX_RUNNER_URL`; compose — `docker-compose.dokploy.yml:16-18`, `docker-compose.sandbox-runner.yml:6-8` |
| 2 | Чи досяжні shell/verify у поточному локальному середовищі | без runner URL `projectSandbox` = `undefined` (`app-sandbox-services.ts:117`), отже `code.shell.exec`/`code.verify.run` → 503 | `.env`, `.env.example` |
| 3 | Частка ранів, де `onActivity`-події тихо відкидаються (немає `DevelopmentProcess`) | UI показує не все | `chat-development-service.ts:317-318` |
| 4 | Чи модель справді повертає кілька tool-calls попри `parallel_tool_calls:false` | від цього залежить, чи паралелізм щось дає | `omniroute-engine.ts:97` |
| 5 | Реальний вплив self-review (додатковий LLM-виклик) на латентність/вартість | можливий головний «зайвий» етап | `coding-agent-review-coordinator.ts:619` |
| 6 | Чи використовується A2A control plane у продакшені | якщо ні — це мертва поверхня з заглушкою | `platform-routes.ts:495` |
| 7 | Дрейф документації | `docs/coding-agent/architecture.md` посилається на `coding-agent-runner.ts:1621`, `:1814`, `:3318-3355`, хоча файл має **702** рядки | перевірено читанням файлу |
| 8 | Чи справді закріплена модель (без fallback) є типовим випадком | від цього залежить, чи взагалі існує provider-fallback у код-ранах | `ai-preferences.ts:51` перераховує `mode`; гіпотеза: після додавання будь-якої chat-моделі «автоматичний» режим недосяжний |
| 9 | Чи робить сам OmniRoute failover провайдер→провайдер для одного id моделі | не видно з цього репозиторію; читаються лише заголовки (`omniroute-engine.ts:154`) | `vendor/omniroute` (сабмодуль), поза межами аудиту |

**Спостереження щодо документації:** `docs/coding-agent/architecture.md` описує PolicyEngine як єдину точку рішень; код це підтверджує лише частково (див. п. 9 у §6). Також документ посилається на неіснуючі номери рядків. Документи `current-state.md`/`PLAN.md` — історичні журнали, не джерело істини про поточний стан.

---

## 8. П'ять основних кандидатів для вимірювання

Усі п'ять уже мають джерело даних у коді — **нових механізмів не потрібно**.

| # | Що міряти | Навіщо | Готове джерело |
|---|---|---|---|
| 1 | **Ходи й tool-calls до завершення** (turns, toolCalls, filesChanged на ран) | головна метрика ефективності циклу; покаже, чи «ліміт інспекції»/підказки справді скорочують ходи | `summary.turns/toolCalls/filesChanged` (`coding-agent-runner.ts:113-122`); `code_run_states`/`code_run_turns` (`code-run-state.ts:104,220,266`) |
| 2 | **Час до першого токена і час до Preview** | латентність, яку відчуває користувач; відділити «модель повільна» від «інфраструктура повільна» | `model_first_token` activity (`coding-agent-runner.ts:507-510`); подія `preview` (`code-chat-website.ts:87`) |
| 3 | **First-pass верифікація та кількість repair-спроб** | якість коду й ціна верифікації; головний критерій, чи варто чіпати self-review | `summary.verification {status, attemptsUsed, maxAttempts, verificationRuns}` (`code-verification-loop.ts:150-159`; `coding-agent-review-coordinator.ts:219-226`) |
| 4 | **Тиск контексту, кількість компакцій, токени/вартість на ран** | виявити, скільки коштує відсутність prompt caching і кешу читань | `compactionCount` (`coding-agent-runner.ts:133,459`), `lastBudget` (`:458`), `summary.tokens/costUsd` (`:569-571`), `model_usage` (`:553-568`) |
| 5 | **Розподіл причин зупинки** (`completed` vs `step_limit`/`loop_detected`/`verification_failed`/`budget_exhausted`/`provider_error`) | показує, де система реально втрачає рани | `CodingAgentStopReason` (`coding-agent-runner-contracts.ts:71-95`); `details.stopReason` у run-state; `markFinished` (`code-run-state.ts:366`) |

---

## 9. Обмеження цього етапу

- Нічого не запускалося: ні тести, ні сервер, ні sandbox, ні БД.
- Не перевірено фактичне використання моделей, провайдерів і прапорців у конкретному розгортанні.
- Частина висновків отримана паралельними read-only під-аудитами тих самих файлів; ключові з них переперевірені читанням першоджерел (позначено рядками).
- Наступний етап — **лише за окремою командою**.
