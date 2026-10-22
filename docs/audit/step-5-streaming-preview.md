# Крок 5 — стрімінг Coding Agent і Live Preview

**Тип:** оптимізація + вимірювання. **Зупинка після кроку 5.**
**Дата:** 2026-10-21. **Базується на:** [Етап 0](coding-agent-inventory.md), [Етап 1](coding-agent-performance.md), [Крок 1](step-1-tool-calls.md), [Крок 2](step-2-verification.md), [Крок 3](step-3-omniroute-context.md), [Крок 4](step-4-self-review.md).

**Що НЕ змінено:** Chat SSE-сервіс (той самий `send`, ті самі `id:`, той самий heartbeat), Activity/Run Trace,
sandbox isolation, preview proxy, auth/tenant isolation, egress policy, обов'язкова верифікація перед production
preview, сам механізм HMR-у дев-сервері.
**Змінені файли:** 3 у `apps/agent-api`, 2 у `packages/omniroute-adapter`, 1 новий тест + 1 тест-кейс.

---

## 1. Як зараз влаштований стрімінг coding-run

```
POST /chat/stream
  ├ send("code_session")            — сесія/проєкт, один раз
  ├ send("code_inbox")              — ревізія inbox
  ├ (activity) → chatDevelopment.recordActivity → flush (100 мс) → notifyListeners
  │                                   → GET /chat/development/processes/stream → UI-картка прогресу
  └ send("result")                  — фінальне повідомлення, коли ран завершився
```

Два різні канали:

1. **Чат-SSE** (`chat-stream-routes.ts:269`) — те, що бачить відкритий чат: `code_session`, `code_inbox`,
   `progress`, `delta`, `result`, `error`. Кожна подія має монотонний `id:` (reconnect/replay), спільний
   `sequence`, heartbeat кожні 15 с.
2. **Development trace** (`chat-development-stream.ts` → `/chat/development/processes/stream`) — картка процесу:
   `recordActivity` батчить події (100 мс, або 32 події, або термінальний статус/preview — негайно),
   `flushActivities` пише проєкцію і `notifyListeners()` пушить снапшот.

**Чому тексту не було видно:** coding-run викликав модель **без** `stream:true` — адаптер має прапорець
`onGenerationProgress`, але він віддає лише лічильники (символи/аргументи), не текст. Тому єдиним текстом був
`result` у кінці рану, а під час рану — лише Activity.

---

## 2. Що зроблено (через наявний механізм)

Потік даних: **провайдер → адаптер → runner → executor sink → той самий `send("delta")`**.

| Шар | Зміна |
|---|---|
| `packages/omniroute-adapter/src/chat-stream.ts` | `request.onTextDelta(delta.content)` у тому ж циклі, що й збірка tool-calls |
| `packages/omniroute-adapter/src/types.ts` | `ChatRequest.onTextDelta` |
| `packages/omniroute-adapter/src/omniroute-engine.ts` | `stream:true`, коли є `onTextDelta` **або** `onGenerationProgress` |
| `apps/agent-api/src/coding-agent-runner-contracts.ts` | `CodingAgentRunInput.onTextDelta` |
| `apps/agent-api/src/coding-agent-runner.ts` | передає `onTextDelta` у `engine.chat` (лише коли транспорт попросив) |
| `apps/agent-api/src/code-session-run-executor.ts` | `CodeRunEventSink.emitDelta?` + прокидання `onTextDelta` |
| `apps/agent-api/src/chat-stream-routes.ts` | `emitDelta → send("delta", { delta, runId })` |

**Що саме стрімиться:** тільки `delta.content` — текст відповіді. `reasoning_content`, `reasoning_text` і
`tool_calls[].function.arguments` **не** передаються в колбек (тест це фіксує: у потоці є лише «Hello», немає ні
«private reasoning», ні фрагмента `{"path":`). Це виконує вимогу «не показувати часткові JSON-аргументи».

**Порядок, reconnect, скасування:** дельти йдуть через той самий `send`, отже мають той самий `sequence`/`id:`,
heartbeat і перевірку `reply.raw.destroyed`. Скасування не змінилося: сигнал рану перериває читання стріму, далі
дельт немає, термінальна подія — як і раніше `result`/`error`. Фонові рани не пишуть у закритий reply (`send`
перевіряє `destroyed`), а їхній прогрес іде через development trace.

**Без дублікатів:** дельта — це **превʼю** фінального повідомлення; контракт задокументовано в типі сіnk'а та в
маршруті: клієнт замінює стрімлений текст фінальним `result`, а не додає обидва. Activity-події не дублюються:
вони, як і раніше, живуть лише в development trace (один запис на `id`).

---

## 3. Live Preview

### 3.1 Що є зараз

- `project-preview-stack.ts` уже вміє і dev-команду, і production-команду (`next start`, `vite preview`, …).
- `startPreview` обирає production-команду, коли `verifiedBuild` (тобто після успішної верифікації), інакше — dev.
- `reuseDevelopmentPreview` повторно використовує живий процес, але **лише** коли `verifiedBuild === false`.
- Проксі (`project-preview-routes.ts:172-183`) — звичайний HTTP `app.all`; **обробника `upgrade` немає**.

### 3.2 HMR: чому він не працює через поточний Preview Service

Next.js Fast Refresh, Vite HMR і SvelteKit HMR передають оновлення через **WebSocket** на тому ж порту. Наш
preview-проксі — HTTP-only: WS-апгрейд не обробляється, а sandbox-абстракція надає лише HTTP-проксі
(`sandbox.proxyPreview`), без TCP/WS-транспорту до контейнера.

Щоб увімкнути HMR, потрібно:
1. додати WS-upgrade проксі в API (raw socket piping, з перевіркою токена й tenant-скоупу на upgrade);
2. додати WS-транспорт у sandbox-шар (нове мережеве вікно/порт або підтримка upgrade у `proxyPreview`).

Це саме те, що заборонено умовами кроку (нові мережеві порти, обхід sandbox isolation / egress policy), і це не
«через існуючий Preview Service». Тому **HMR не ввімкнено**; поточна поведінка збережена: dev-сервер
використовується для style-preview, production — після верифікації. Це задокументовано як відому межу, а не
приховано.

### 3.3 Що зроблено: прибрані зайві перезапуски

`canReusePreviewSession` (`project-preview-reuse.ts:24`) — нове чисте правило, яке розширює reuse на **static**
preview (HTML/CSS, `python -m http.server`): такий сервер читає файли з workspace на кожен запит, тому
перезапуск не потрібен.

| Випадок | Було | Стало |
|---|---|---|
| dev-сервер (`verifiedBuild=false`, Next/Vite/… ) | reuse, якщо живий | без змін |
| **static** (HTML/CSS) після зміни | stop + start щоразу | **reuse**, якщо живий процес із тим самим command/port відповідає 2xx |
| production (`next start`, `vite preview`, …) | restart | **restart** (build читається на старті — це не зайвий перезапуск) |
| явний `command`/`port` у запиті | без reuse | без reuse |

Reuse перевіряє: `project.status === "previewing"`, `sandbox.supportsPreviewProxy()`, точний збіг команди
(`refreshPreview`), HTTP-відповідь `/` у 2xx/3xx, свіжий токен. Якщо хоч одна умова не виконана — звичайний
старт.

**Безпека:** верифікаційний гейт (`code-chat-website.ts:81-85`: `verification.status === "passed"` і `build` у
`requestedTools`) не змінювався; reuse не запускає неперевірений build, він лише не перезапускає вже
перевірений static/dev-процес. Сесії ключовані `projectId`, тому одночасні preview різних проєктів не
перетинаються.

---

## 4. Вимірювання

### 4.1 Перший текст (живий виклик, локальний OmniRoute, DeepSeek Flash)

| Сценарій | перша дельта | кінець тексту | кінець виклику | символів |
|---|---|---|---|---|
| коротка відповідь | **1 574 мс** | 1 931 мс | 1 954 мс | 355 |
| довгий system prompt (~6k токенів) | **1 061 мс** | 1 363 мс | 1 402 мс | 332 |
| tool-call хід | — (0 символів) | — | 1 178 мс | 0 |

Висновки:

- користувач бачить текст на **1.0–1.6 с** раніше, ніж завершується виклик; до зміни він чекав `result`;
- tool-call хід не має прози взагалі — там прогрес дає Activity (уже стрімиться), а не текст;
- для довгих відповідей виграш більший, ніж для коротких (текст іде безперервно).

### 4.2 Activity

Не змінювалася: батч **100 мс**, негайний flush на `failed/cancelled/awaiting_approval/preview`. Наскрізну
затримку «tool executed → картка в UI» на живому стеку не міряв (потрібен браузер і запущений стек);
заявлене значення — це вікно батча з коду, не вимір.

### 4.3 Preview

| Метрика | Значення |
|---|---|
| Час старту preview | **Не виміряно** — потрібен Docker-sandbox; контейнери працюють на образі до змін, передеплой заборонений умовами |
| Час оновлення після зміни (static) | **Не виміряно** з тієї ж причини; логічно — 0 перезапусків замість 1 |
| Зайві перезапуски (static) | 1 → **0**, коли жива сесія відповідає (unit-тест правила; живого підрахунку немає) |
| HMR | не ввімкнено (немає WS-транспорту; §3.2) |

**Не заявлено:** економії секунд на preview без живого виміру; HMR-виграшу.

---

## 5. Тести

`tests/coding-agent-step5-streaming-preview.test.ts` — 6/6:

| Сценарій | Перевірка |
|---|---|
| dev/static reuse | predicate: dev і static — так; production, explicit command/port — ні |
| executor → sink | `emitDelta` до `emitResult`, `emitResult` рівно один раз |
| транспорт без delta-каналу | ран не падає |
| runner → engine | `onTextDelta` доходить до модельного виклику, текст стрімиться до завершення |
| без запиту | `onTextDelta` не передається |
| — | + `omniroute-chat-stream.test.ts`: у дельтах лише `content`, без reasoning і tool-arguments |

Регресія: **257/257** у 13 файлах (step1–step5, c6, c9×3, chat-website, chat-development, адаптер, stream).
Typecheck обох пакетів — passed.

**Не покрито тестом:** сам Fastify-маршрут `/chat/stream` з реальним SSE (перевірено на рівні sink/executor і
wire-контракту дельт); WS/HMR — не реалізовано.

---

## 6. Змінені файли

| Файл | Зміна |
|---|---|
| `packages/omniroute-adapter/src/chat-stream.ts` | колбек тексту (лише `content`) |
| `packages/omniroute-adapter/src/types.ts` | `onTextDelta` |
| `packages/omniroute-adapter/src/omniroute-engine.ts` | `stream:true` за наявності текстового колбека |
| `apps/agent-api/src/coding-agent-runner-contracts.ts` | `onTextDelta` у вході рану |
| `apps/agent-api/src/coding-agent-runner.ts` | прокидання колбека у модель |
| `apps/agent-api/src/code-session-run-executor.ts` | `emitDelta` у сіnk'у + прокидання |
| `apps/agent-api/src/chat-stream-routes.ts` | `send("delta", { delta, runId })` |
| `apps/agent-api/src/project-preview-reuse.ts` | `canReusePreviewSession` (dev + static) |
| `apps/agent-api/src/project-preview-service.ts` | використовує правило reuse |
| `tests/coding-agent-step5-streaming-preview.test.ts` | **новий**, 6 тестів |

---

## 7. Що далі (не виконується)

1. WS-upgrade проксі + sandbox-транспорт для HMR — окремий крок із переглядом мережевої політики.
2. Виміряти preview start/update на живому стеку після дозволеного передеплою.
3. Якщо UI почне рендерити coding-дельти — прибрати дублювання з фінальним повідомленням у клієнті (контракт уже
   зафіксований у типах).
