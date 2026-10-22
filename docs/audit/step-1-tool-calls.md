# Крок 1 — Fix Partial Tool Calls and Loop Detection

**Тип:** виправлення дефекту + ізольовані тести. **Зупинка після кроку 1.**
**Дата:** 2026-10-21. **Базується на:** [Етап 0](coding-agent-inventory.md), [Етап 1](coding-agent-performance.md).

**Що НЕ змінено:** permission policy, sandbox isolation, file transactions, approval gates, tool schemas, БД.
**Змінені файли:** 5 у `apps/agent-api/src` + 1 наявний тест + 1 новий тест (див. §4).

---

## 1. Першопричина (підтверджена експериментом)

`partial_tool_call` — це не «поганий JSON від моделі» і не помилка стрімінгу. Це **обрізання аргументів
tool-call на боці провайдера**, яке виникає лише в режимі `thinking: disabled`.

`CodingAgentRunner` для створення порожнього HTML-проєкту передавав `reasoningMode: "disabled"`
(до зміни — `coding-agent-runner.ts:505`, функція `CodingAgentRunner.run`), а `OmniRouteEngine` перетворював
це на `thinking: {type:"disabled"}, reasoning_effort: "none"` для `deepseek/deepseek-flash`
(`omniroute-engine.ts:94`). У цьому режимі провайдер обрізає буфер аргументів tool-call на
**21 213 символах** і повертає `finish_reason: "tool_calls"` — тобто вигадує «нормальне» завершення, хоча
JSON обірваний.

### 1.1. Експеримент (ізольований, без записів у проєкти)

Той самий запит, модель, tools і `tool_choice`; змінювався лише режим reasoning. Запит ішов через той самий
`OmniRoute`, що й агент (локальний стек `npati-isolated-source-20261011`), модель викликалась напряму —
жоден tool не виконувався, у БД нічого не писалося.

| # | Режим | `max_tokens` | Очікувано правил | Отримано символів аргументів | JSON валідний | `finish_reason` |
|---|---|---|---|---|---|---|
| 1 | default (thinking on) | — | 1200 | **50 620** | **так** | `tool_calls` |
| 2 | thinking disabled | — | 1200 | 21 213 | **ні** (unterminated string) | `tool_calls` |
| 3 | thinking disabled, forced tool_choice | — | 1200 | 21 228 | **ні** | `tool_calls` |
| 4 | thinking disabled | 16 384 | 1200 | 21 213 | **ні** | `tool_calls` |
| 5 | thinking disabled | 32 768 | 1200 | 21 213 | **ні** | `tool_calls` |
| 6 | thinking disabled | — | 400 | 16 618 | **так** | `tool_calls` |
| 7 | thinking disabled | — | 800 | 21 213 | **ні** | `tool_calls` |

Висновки:

- **Межа — не `max_tokens`.** Явні 16 384 і 32 768 не змінили нічого: обрізання завжди на 21 213 символах.
  Тому додавати `max_tokens` як «виправлення» було б неправдою (і ризиковано: thinking-режим законно віддає
  ~19 839 completion-токенів, і фіксований ліміт міг би обрізати те, що зараз проходить).
- **Межа залежить від розміру, а не від вмісту:** 400 правил (16 618 символів) проходять, 800 — уже обрізані.
- **`finish_reason` не сигналізує про обрізання** для цього провайдера: він каже `tool_calls`. Тому
  структурна перевірка JSON лишається основною, а `length` — лише додатковий захист для провайдерів, які
  його повідомляють.
- **Примусовий `tool_choice` несумісний із thinking:** провайдер відповідає `400 Thinking mode does not
  support this tool_choice`. Саме тому раніше його вмикали лише разом з `thinking: disabled`.

### 1.2. Як це виглядало в реальному прогоні (Етап 1)

`stream-final-live.log`, створення HTML/CSS-магазину, `deepseek/deepseek-flash`, `emptyHtmlWorkspace: true`:

- 19 ходів, 18 tool-calls, **8 із них** — `partial_tool_call` (44%);
- на ці 8 ходів пішло **186 255 мс із 296 510 мс (62.8% усього часу)**;
- повтори йшли серіями (ходи 2, 3, 5, 7, 8, 9, 17, 18) без жодної коригуючої дії.

---

## 2. Виправлення

### 2.1. Прибрано режим, що спричиняв обрізання (`coding-agent-runner.ts`)

- Більше **не надсилається** `reasoningMode: "disabled"` для `emptyHtmlWorkspace`.
- Прибрано примусовий `toolChoice: code.fs.write` для DeepSeek Flash (він і так вимагав вимкненого
  reasoning, а з увімкненим провайдер відповідає 400). Тепер завжди `toolChoice: "auto"`.
- Перший хід усе одно починається з запису — це вже задано промптом
  (`coding-agent-prompt-context.ts:117`), а не параметром запиту.

Це не новий механізм: видалено один параметр і один вузький хак; решта tool calling не змінилася.

### 2.2. Другий рубіж: `finish_reason=length` (`code-tool-call-adapter.ts`)

Якщо провайдер усе ж повідомляє `length`, **жоден** tool-call із цієї відповіді не виконується: кожен
позначається `partial` і відхиляється з `partial_tool_call`, додається warning `output_limit_tool_calls`.
Це закриває випадок, коли JSON синтаксично валідний, але тіло файлу вже обрізане.

Для DeepSeek Flash цей рубіж не спрацьовує (він каже `tool_calls`), тому первинним лишається структурний
аналіз незакритого JSON, який існував і раніше.

### 2.3. Коригуюча дія замість «виправте аргументи» (`coding-agent-runner-prompt.ts`, `coding-agent-tool-waves.ts`)

Для `partial_tool_call` модель більше не отримує безглузде «Retry with corrected arguments» — у неї немає
аргументів, які можна виправити. Замість цього додано `TRUNCATED_TOOL_CALL_HINT`: пояснити, що виклик
обрізано, нічого не записано, і запропонувати **менший обсяг** через наявні `code.fs.apply_patch` / `code.fs.edit`
(нових інструментів не додано).

### 2.4. Відхилені виклики тепер беруть участь у наявному Loop Detection (`coding-agent-tool-waves.ts`)

- Підпис відхилення (`rejected:<tool>:<code>`) додається до того самого масиву `repeatedSignatures`, що й
  успішні виклики.
- 3 однакові підписи → існуючий `REMINDER_MESSAGE` (запис `reminder` із `reason: "repeated_call"`).
- Наступний повтор → контрольоване завершення `loop_detected`.
- Простір імен `rejected:` унеможливлює плутанину з успішним викликом; різні інструменти дають різні підписи,
  тому нормальна робота не може зачепити детектор.

**Чому truncation не витрачає бюджет `MAX_ARGUMENT_CORRECTIONS`:** це не помилка аргументів, а обрізання
провайдером. Якби воно зупиняло ран на 3-й спробі, модель не встигла б перейти на менший patch. Тепер
truncation обмежується детектором повторів (максимум 4 ходи), а помилкові аргументи (unknown tool, invalid
args) — наявним бюджетом (3 ходи, `invalid_arguments_exhausted`), як і раніше.

### 2.5. Діагностика

`finishReason` тепер записується в `model_call` activity-подію (`coding-agent-runner-ports.ts`,
`coding-agent-runner.ts:552`) — щоб наступні вимірювання могли відрізняти `length` від `tool_calls`.

---

## 3. Гарантія «частковий запис не потрапляє у Workspace»

Три незалежні рубежі, всі збережені:

1. `readNativeArguments` → `looksTruncatedJson` → `partial: true` (`code-tool-call-adapter.ts:274,433`).
2. `executableToolCalls()` відкидає `partial` за побудовою (`:628`), `planToolCallWaves()` — теж (`:637`).
3. Новий `finish_reason=length` рубіж (`:587`) позначає `partial` навіть синтаксично валідні виклики.

У тестах це перевірено як «нуль викликів `toolRuntime.invoke`» на всіх шляхах відхилення.

---

## 4. Змінені файли

| Файл | Зміна |
|---|---|
| `apps/agent-api/src/coding-agent-runner.ts` | прибрано `reasoningMode: "disabled"` і примусовий `toolChoice`; додано `finishReason` в activity |
| `apps/agent-api/src/coding-agent-tool-waves.ts` | відхилення → loop detection; truncation-специфічна підказка; `turnHadFailure` для ходів без роботи |
| `apps/agent-api/src/code-tool-call-adapter.ts` | fail-closed на `finish_reason=length` |
| `apps/agent-api/src/coding-agent-runner-prompt.ts` | `TRUNCATED_TOOL_CALL_HINT` |
| `apps/agent-api/src/coding-agent-runner-ports.ts` | `finishReason?` у `CodeRunActivityEvent` |
| `tests/coding-agent-c6-runner.test.ts` | оновлено тест, що фіксував стару поведінку (reasoning off + forced tool_choice) |
| `tests/coding-agent-step1-tool-calls.test.ts` | **новий**, 11 тестів (див. §5) |

---

## 5. Тести

Новий файл: `tests/coding-agent-step1-tool-calls.test.ts` — 11 тестів, усі на scripted engine та in-memory
tool runtime (без workspace, провайдера й БД).

| Обов'язкова перевірка | Тест | Результат |
|---|---|---|
| Валідний великий Tool Call | adapter: 200 000 символів `content` → `partial=false`, executable; runner: 120 000 символів → виконано | ✅ |
| Обрізаний JSON | adapter: незакритий рядок → `partial_tool_call`, `executableToolCalls` порожній | ✅ |
| `finish_reason=length` | adapter: валідний JSON + `length` → примусово `partial`, warning | ✅ |
| Незавершений tool-call stream | наявний `tests/omniroute-chat-stream.test.ts` → `provider_stream_incomplete`, часткові аргументи не виконуються | ✅ (регресія) |
| Text-protocol fallback | adapter: обірваний ```-блок → `partial`; повний блок → executable | ✅ |
| Повторення ідентичної помилки | runner: 4 однакові truncation → reminder на 3-й, `loop_detected` на 4-й, 0 викликів | ✅ |
| Відновлення після коригуючої помилки | runner: truncation → hint → менший `write` виконано → `completed` | ✅ |
| Контрольоване завершення після невиправної помилки | runner: 3× `unknown_tool` → `invalid_arguments_exhausted` | ✅ |
| Жоден частковий write не потрапляє у Workspace | усі шляхи відхилення: `invocations === 0` | ✅ |
| Немає хибних Loop Detection | 5 різних успішних читань; truncation + різна успішна робота → без `loop_detected` | ✅ |

**Регресія (8 файлів, 157 тестів):** `coding-agent-c6-runner`, `coding-agent-c6-tool-call-adapter`,
`coding-agent-c9-ask-user-runner`, `coding-agent-c9-verification-loop`, `coding-agent-c9-self-review`,
`coding-agent-c8-context-compaction`, `coding-agent-patch-recovery`, `coding-agent-step1-tool-calls` — **157/157 passed**.
`tests/omniroute-chat-stream.test.ts` (wire-формат, thinking, незавершений стрім) — passed.
`npm run typecheck --workspace @npati/agent-api` — passed. `npm run lint`: lint-guard і XSS — passed.

**Наявні падіння, не пов'язані зі зміною (перевірено):**

- `tests/coding-agent-c6-runner-stop-conditions.test.ts` → «does not execute model tool calls that resolve after
  cancellation» падає **на чистому HEAD** (перевірено `git stash` + повторний прогін) — тест очікує
  `planning`-подію, якої при скасуванні не буває. Не виправляв: поза межами кроку 1.
- `npm run typecheck:tests`: помилка типів у `tests/coding-agent-data-tools.test.ts` (файл не змінювався).
- `npm run lint`: `source-size-guard` на `apps/web/src/DataStudioSettingsPage.tsx` (файл не змінювався;
  зафіксовано ще в REPORT.md попереднього етапу).

---

## 6. До / після

| Метрика | До | Після | Джерело |
|---|---|---|---|
| Обрізання аргументів на великому записі | 21 213 символів, JSON невалідний (3/3 прогони) | 50 620 символів, JSON валідний (1/1 прогін) | прямий експеримент §1.1 |
| `partial_tool_call` у реальному прогоні | 8 із 18 викликів (44%) | механізм усунено для цього режиму; для інших провайдерів — обмежено 4 ходами | лог Етапу 1 + тести |
| Ходи, витрачені на повтори | 8 із 19 (186.3 с, 62.8% wall) | максимум 3 корисні спроби + 1 зупинка = 4 ходи, далі `loop_detected` | тест «repeated truncation» |
| AI Calls до контрольованої зупинки | не обмежено в тому білді (8 повторів) | 4 (3 підказки + зупинка) | тест |
| Час виконання | 296.5 с (той прогін) | **Не виміряно на живому стеку** — див. нижче | — |

**Чому немає «часу після» на реальному рантаймі:** локальний стек працює на образі, зібраному до цієї зміни.
Передеплой змінив би стан середовища, що заборонено умовами кроку. Час після виправлення треба зняти
окремим контрольованим прогоном після деплою; очікування: менше ходів (немає 8 повторів), але можливе
зростання TTFT через увімкнений reasoning — це треба виміряти, а не припускати.

**Розмір вибірки:** прямий експеримент — 7 викликів (1 thinking-on, 5 thinking-off, 1 контроль розміру),
1 модель, 1 провайдер. Це достатньо, щоб підтвердити механізм, але не для статистики латентності.

---

## 7. Сумісність із провайдерами

- **Native tool calling:** без змін; `code-model-profiles` і `parallel_tool_calls: false` не чіпалися.
- **Text-protocol fallback:** без змін; доданий лише один тест, що обірваний блок не виконується, а повний —
  виконується.
- **`max_tokens`:** не додано навмисно. Перевірено: для цього провайдера він не впливає на обрізання, а
  фіксований дефолт міг би обрізати законні 19 839 completion-токенів у thinking-режимі. Якщо інший
  провайдер матиме низький дефолт, це видно через нове поле `finishReason` в activity і новий
  `finish_reason=length` рубіж.
- **`finish_reason`:** тепер зберігається в activity для спостережуваності.

---

## 8. Що далі (не виконується на цьому кроці)

1. Після деплою — контрольований прогін сценарію 1 і порівняння: ходи, `partial_tool_call`, TTFT, wall time.
2. Якщо reasoning справді додає латентність — виміряти, чи виграш від усунення 8 повторів його перекриває
   (дані для рішення вже будуть у `model_call`/`finishReason`).
3. Окремо — наявне падіння `coding-agent-c6-runner-stop-conditions` (не пов'язане з tool calls).
