# Крок 3 — OmniRoute, prompt context і tool schemas

**Тип:** оптимізація + вимірювання. **Зупинка після кроку 3.**
**Дата:** 2026-10-21. **Базується на:** [Етап 0](coding-agent-inventory.md), [Етап 1](coding-agent-performance.md), [Крок 1](step-1-tool-calls.md), [Крок 2](step-2-verification.md).

**Що НЕ змінено:** модель-керований вибір інструментів, жоден провайдер не видалено, permission/sandbox/approval
gates, context budget, compaction, fallback.
**Змінені файли:** 3 у `packages/omniroute-adapter`, 4 у `apps/agent-api`, 1 тип у `packages/shared`, 1 новий тест.

---

## 1. Реальний шлях запиту

```
CodingAgentRunner.run
  └ ports.engine.chat({ messages, tools, toolChoice: "auto", systemCachePrefix, … })   coding-agent-runner.ts:530
      └ OmniRouteEngine.chat                                                          omniroute-engine.ts:73
          ├ providerToolNames: code.fs.read → npati_code_fs_read_<sha16>              provider-tool-names.ts:18
          ├ chatCandidates(model, fallbackModel) — послідовний перебір                 omniroute-engine.ts:75
          ├ POST {base}/api/v1/chat/completions                                       omniroute-engine.ts:109
          └ readChatStream → ChatResult { usage.cachedTokens, finishReason, … }        chat-stream.ts:4
```

`parallel_tool_calls: false` і `stream: true` (коли є `onGenerationProgress`) — не змінювалися.

---

## 2. Що реально надсилається (перевірка generation parameters)

| Параметр | Значення | Джерело |
|---|---|---|
| `model` | одна модель, `fallbackModel` лише якщо заданий | `omniroute-engine.ts:75` |
| `messages` | system + історія; **system — рядок**, крім Anthropic-моделей | див. §4 |
| `tools` | лише дозволені режимом/правами інструменти, імена аліасовані | `coding-agent-tool-catalog.ts:46-90` |
| `tool_choice` | `"auto"` (Крок 1 прибрав примусовий вибір) | `coding-agent-runner.ts:532` |
| `parallel_tool_calls` | `false` | `omniroute-engine.ts:104` |
| `stream` + `stream_options.include_usage` | лише за наявності progress-listener | `omniroute-engine.ts:102` |
| `temperature` | не надсилається (дефолт провайдера) | — |
| `max_tokens` | **не надсилається** (свідомо, див. Крок 1) | — |
| `reasoning_effort` | не надсилається; `thinking: disabled` лише за явним `reasoningMode` | `omniroute-engine.ts:101` |
| `cache_control` | лише Anthropic-family + стабільний префікс | `omniroute-engine.ts:89` |

**Перевірка некоректних параметрів (живі виклики, DeepSeek Flash):**

| Параметр | Результат |
|---|---|
| `max_tokens: 99 999 999` | 200 — шлюз не валідує; тому відсутність `max_tokens` у нас — не ризик, а свідомий вибір |
| `temperature: 0.3` | 200 |
| `reasoning_effort: "low"` | 200, reasoning-токенів 40 (див. §6) |
| `thinking:{type:"disabled"}` | 200, але `prompt_tokens` впав до 5 — шлюз перебудовує запит; Крок 1 показав, що цей режим ще й обрізає tool-аргументи |
| `cache_control`-блоки на DeepSeek | 200, але `prompt_tokens` **2 438 → 37**: system prompt фактично відкинуто — тому один формат для всіх неприпустимий |
| tool name з крапкою (`code.fs.read`) | **400** `Invalid 'tools[0].name'` — тому аліаси з `provider-tool-names.ts` є обов'язковими, а не косметикою |

---

## 3. Prompt caching: що підтверджено

### 3.1 Implicit caching уже працює (DeepSeek)

Повторний ідентичний запит повертає `prompt_tokens_details.cached_tokens`:

| Запит | prompt tokens | cached | частка |
|---|---|---|---|
| перший | 2 438 | — | 0% |
| повторний | 2 438 | 2 304 | 94.5% |

Те саме в реальних сценаріях (§7): короткі/повторні запити — **91–98%** префікса (8 448 із 9 274; 9 088 із 9 274; 16 128 із 16 369); запит із довгим контекстом — 16 256 із 28 861 (56%), бо 100 КБ нового результату ще не в кеші.
Жодного клієнтського директива для цього не потрібно — DeepSeek кешує сам.

### 3.2 Explicit cache-control: підтримка є, але не для всіх

Вендорний OmniRoute має повну підтримку Anthropic-маркерів (`vendor/omniroute/open-sse/handlers/chatCore/claudeSystemRole.ts`,
`cacheUsageMeta.ts`): він переносить `cache_control` на system-блок і читає `cache_read_input_tokens`.

Реалізовано **capability-aware** підключення до наявного стабільного префікса:

- `ChatRequest.systemCachePrefix` (`types.ts:18`) — раннер передає `systemPromptStablePrefix(systemPrompt)`
  (`coding-agent-runner.ts:530`, хелпер `coding-agent-runner-prompt.ts:158`);
- `withExplicitPromptCache` (`omniroute-engine-helpers.ts:43`) розділяє system-повідомлення на два блоки:
  стабільний префікс із `cache_control: {type:"ephemeral"}` і незмінний залишок;
- `modelSupportsExplicitPromptCache` (`:32`) — **allowlist**: `anthropic/*`, `claude*`, `*/claude*`.
  `auto/*` комбо виключені (невідомо, яка модель відповість); усі інші отримують **той самий рядок**, що й до зміни.

Це не новий кеш-рушій: той самий текст, той самий запит, лише маркер для провайдерів, які його вимагають.

**Межа:** живий Anthropic-провайдер у локальному стеку не підключений (лише DeepSeek), тому explicit-шлях
перевірено unit-тестами на точний wire-формат, але не живим викликом. Це позначено як незакрите вимірювання.

---

## 4. Розмір system prompt і tool schemas

### 4.1 Дублювання

У реальному збереженому prompt (16 933 символи p50) блок `Tools:` займав **12 452 символи — 73%** промпту, і це
той самий текст, що вже надсилається в `tools[].function.description`. Для 33 інструментів — подвійна оплата.

### 4.2 Зміна

`compactToolLine` (`coding-agent-runner-prompt.ts:64`) лишає **назву**, прапорець `(mutating)` і **перше речення**
опису (≤110 символів, `:62`). Повний опис лишається в схемі; жоден інструмент не приховано — тест перевіряє, що
кожен із 33 інструментів згаданий рівно один раз.

| Артефакт | До | Після |
|---|---|---|
| Реальний prompt (найбільший з БД), символи | 28 149 | 21 137 (**−7 012**) |
| Той самий prompt, токени (вимір провайдера) | 9 966 | 8 491 (**−1 475, −14.8%**) |
| Реальний запит із 33 tool-схемами, токени | 10 749 | 9 274 (**−1 475, −13.7%**) |
| Tool-схеми (JSON, без промпту) | 50 інстр. — 37 875 симв.; website-фільтр 33 — 24 771; plan 12 — 8 474 | без змін |

Схеми не скорочувалися: вони потрібні для tool calling, і їхній розмір уже мінімальний (лише `name/description/parameters`).
Вибір інструментів за режимом/правами/типом рану вже існує (`coding-agent-tool-catalog.ts:46-90`); додатково
ховати інструменти немає підтверджених підстав — жоден із наявних фільтрів не був причиною зайвих токенів.

---

## 5. Context budget і compaction

Не змінювалися: `resolveModelRequestPressure` (`code-context-budget.ts:119`) і детермінована компакція
(`coding-agent-context-compactor.ts:42`) працюють як раніше. Зменшення промпту лише знижує тиск на бюджет
(менше шансів на компакцію), але механізм не замінювався.

---

## 6. Reasoning effort

Виміряно на тривіальному запиті (DeepSeek Flash): `reasoning_effort: "low"` → 40 reasoning-токенів, TTFT 1 073 мс;
`thinking: disabled` → 0 reasoning, TTFT 1 181 мс. Різниця в межах шуму, а Крок 1 довів, що вимкнений reasoning
обрізає tool-аргументи на ~21.2 КБ.

**Рішення: не змінювати.** Немає виміряного виграшу, а є відомий ризик якості; для простих задач reasoning
коштує десятки токенів, не секунди.

---

## 7. Вимірювання сценаріїв (DeepSeek Flash, реальні аліаси інструментів)

| Сценарій | prompt | cached | TTFT | total | tool calls |
|---|---|---|---|---|---|
| Просте редагування, повний prompt | 10 749 | 9 856 / 10 496 | 1 264 / 1 410 | 1 724 / 2 434 | 1 (валідний JSON) |
| Просте редагування, compact prompt | 9 274 | 8 448 / 9 088 | 951 / 861 / 1 020 | 1 574 / 1 651 / 1 206 | 1 (валідний JSON) |
| Кілька tool calls в одному ході | 16 369 | 16 128 | 1 108 | 1 391 | 2 (обидва валідні) |
| Послідовні ходи 1→2→3 | 16 353 → 16 377 | 8 448 → 16 128 | 1 265 → 1 649 | 1 584 → 3 098 | валідні |
| Довгий контекст (~100 КБ результату) | 28 861 | 16 256 | 1 957 | 2 967 | 1 |
| Велике створення (400 рядків JSX) | 9 276 | 8 448 | 1 008 | 2 329 | 1 (валідний, 310 completion) |
| Провайдер без кешу (gemma4:31b) | 13 316 | **0** | 1 823 | 1 941 | 1 (валідний) |

Спостереження:

- **Кеш уже дає 91–98%** префікса на коротких/повторних запитах (56% на запиті з новим 100 КБ контекстом); compact-промпт зменшує саме некешовану частину і розмір запису в кеш.
- TTFT compact нижчий (861–1 020 проти 1 264–1 410), але це **не чисте порівняння**: перші full-запити мали
  холодніший кеш. Тому TTFT-виграш не заявляю як доведений.
- Провайдер без кешу (gemma) платить повний prompt щоразу — для нього скорочення промпту і є основним виграшем.
- Усі 6 перевірених tool-call'ів мали валідний JSON і правильне аліасоване ім'я (після мапінгу — `code.fs.read`,
  `code.fs.apply_patch`).

### Модельна матриця

| Модель | Статус | Примітка |
|---|---|---|
| `deepseek/deepseek-flash` | 200 | єдиний підключений провайдер; implicit cache |
| `ollamacloud/gemma4:31b` | 200 | кешу немає (`cached: 0`) |
| `cfp/google/gemma-4-26b-a4b-it` | 502 | upstream Playwright недоступний — не наша помилка |
| `definitely/not-a-model` | 401 | немає credentials; у рантаймі це призведе до fallback/помилки |

Fallback перевірено unit-тестом адаптера (`tests/omniroute-adapter.test.ts:340-351`: перша модель падає, друга
відповідає) — живий fallback потребує другої підключеної моделі, якої в стеку немає.

---

## 8. Змінені файли

| Файл | Зміна |
|---|---|
| `apps/agent-api/src/coding-agent-runner-prompt.ts` | `compactToolLine`, `TOOL_LINE_DESCRIPTION_LIMIT`; інтро-рядок посилається на function definitions |
| `apps/agent-api/src/coding-agent-runner.ts` | передає `systemCachePrefix`; `cachedTokens` у `model_usage` |
| `apps/agent-api/src/coding-agent-runner-contracts.ts` | (з Кроку 2) без нових змін |
| `packages/shared/src/chat-development.ts` | `ModelTurnUsage.cachedTokens` |
| `packages/omniroute-adapter/src/types.ts` | `ChatRequest.systemCachePrefix` |
| `packages/omniroute-adapter/src/omniroute-engine-helpers.ts` | `modelSupportsExplicitPromptCache`, `withExplicitPromptCache` |
| `packages/omniroute-adapter/src/omniroute-engine.ts` | застосовує маркер лише для allowlist-моделей |
| `tests/coding-agent-step3-omniroute-context.test.ts` | **новий**, 9 тестів |

---

## 9. Тести

`tests/coding-agent-step3-omniroute-context.test.ts` — 9/9:

- компактний рядок: назва збережена, версія прибрана, опис обрізаний, `(mutating)` на місці;
- усі 33 інструменти згадані рівно один раз (нічого не приховано);
- каталог компактніший за старий щонайменше вдвічі; стабільний префікс не містить маркера середовища;
- allowlist: `anthropic/*`, `dva/claude-*` — так; `auto/*`, DeepSeek, gemma — ні;
- system розділяється на маркований префікс + незмінний залишок, текст зберігається;
- не-Anthropic провайдери отримують **byte-for-byte** той самий рядок;
- відсутній/невідповідний префікс → без кешування;
- engine-wire: Anthropic → масив блоків із `cache_control`, tools/tool_choice недоторкані;
- engine-wire: DeepSeek → рядок.

Регресія: **119/119** (`omniroute-adapter`, `omniroute-chat-stream`, `c6-runner`, `step1`, `step2`, `step3`).
Typecheck обох пакетів — passed. `npm run lint`: lint-guard і XSS passed; наявне падіння size-guard на
`apps/web/src/DataStudioSettingsPage.tsx` (файл не змінювався).

---

## 10. До / після (тільки виміряне)

| Метрика | До | Після | Джерело |
|---|---|---|---|
| Токени промпту на запит (33 tools) | 10 749 | 9 274 (−13.7%) | живий вимір |
| Токени system prompt (реальний prompt) | 9 966 | 8 491 (−14.8%) | живий вимір |
| Розмір system prompt, символи | 28 149 | 21 137 | трансформація реального тексту |
| Cached tokens, повторний запит | 91–98% (уже працює; 56% на новому довгому контексті) | без змін для DeepSeek | живий вимір |
| Explicit caching для Anthropic | не надсилався | маркер на стабільному префіксі | unit/wire-тест (живого провайдера немає) |
| TTFT | 1 264–1 410 мс | 861–1 020 мс (не чисте порівняння) | живий вимір, є шум кешу |
| Кількість AI round trips | не змінювалася (Крок 3 не чіпає цикл) | — | — |
| Успішність tool calls | 6/6 валідних у вимірі | 6/6 | живий вимір |

**Не заявлено:** економії часу від compact-промпту (TTFT-різниця змішана з прогрівом кешу), економії від
explicit-кешу (немає підключеного Anthropic), змін у кількості round trips.

---

## 11. Що далі (не виконується)

1. Підключити Anthropic-провайдера в ізольованому стеку й виміряти `cache_read_input_tokens` + TTFT до/після.
2. Перевірити якість вибору інструментів на compact-промпті на ширшому корпусі (eval harness уже є) — зараз
   перевірено 6 живих tool-call'ів.
3. Розглянути прибирання префікса `NPATI tool <name>. ` в аліасах (~25 символів × 33) — не змінював, бо він
   зберігає канонічну назву видимою для моделі.
