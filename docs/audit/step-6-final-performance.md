# Крок 6 — фінальна перевірка продуктивності та регресій

**Тип:** верифікація + вимірювання. **Фінальний крок.**
**Дата:** 2026-10-21. **Базується на:** [Етап 0](coding-agent-inventory.md), [Етап 1](coding-agent-performance.md), [Крок 1](step-1-tool-calls.md), [Крок 2](step-2-verification.md), [Крок 3](step-3-omniroute-context.md), [Крок 4](step-4-self-review.md), [Крок 5](step-5-streaming-preview.md).

---

## 0. Метод і чесні межі

Усі зміни Кроків 1–5 лежать у робочому дереві (комітів немає). Ізольований стек працює на **образі до змін**, а
передеплой заборонений умовами — тому **наскрізний wall time «до/після» на живому стеку виміряти неможливо**, і він
тут не заявляється.

Що виміряно насправді:

| Джерело | Що дає |
|---|---|
| Етап 1 (124 рани, 532 verify-події) + БД сьогодні (211 ранів) | **до**: wall time, TTFT, verify, self-review, помилки |
| Живі виклики OmniRoute (Кроки 1, 3, 5) | ефект конкретних змін: tool-call, токени промпту, перша дельта |
| Скриптовий harness (Крок 6, 12 сценаріїв × 3) | **після**: AI calls, tool calls, verify runs, review runs, статуси, файли |
| build / typecheck / тести / security gate / web | регресії |

Harness-числа — це **вартість оркестрації** (кількість ходів і перевірок), а не латентність провайдера: engine
скриптовий, тож `ms` у ньому (1–37 мс) не є часом рану і в таблиці не наводиться як прискорення.

---

## 1. Інтеграція Кроків 1–5

| Крок | Зміна | Точки перетину | Конфлікт |
|---|---|---|---|
| 1 | прибрано `reasoningMode`/forced tool_choice, `finish_reason` guard, loop detection для відмов | runner, tool-waves, adapter, prompt | немає |
| 2 | verification plan + reuse за ревізією, `changedOnly` реалізовано | coordinator, contracts, wiring | з Кроком 4 — спільний summary; винесено в `code-review-summary.ts` |
| 3 | компактний каталог інструментів, explicit cache для Anthropic, `cachedTokens` | `coding-agent-runner-prompt.ts`, adapter, runner | з Кроком 1 — той самий prompt-файл; з Кроком 5 — той самий adapter |
| 4 | адаптивний self-review, `risk`/`adaptiveSkip`, kill switch | coordinator, config, summary | з Кроком 2 — той самий coordinator; сумісно |
| 5 | текст-дельти, reuse static preview | adapter, runner, executor, route, preview service | з Кроком 3 — `stream:true` для обох колбеків; сумісно |

Перевірено: `cachedTokens` (3) і `onTextDelta` (5) живуть в одному запиті; `verificationSummary` (2) не втратив
`executedTools/skippedChecks/reused` після винесення (Крок 4); self-review бачить verification-статус (2→4).
**Конфліктів не знайдено.**

**Одна регресія знайдена й виправлена** — див. §6.

---

## 2. Результати верифікації

| Перевірка | Результат | Примітка |
|---|---|---|
| `npm run build` (catalog + API + web) | **PASS** (exit 0) | web bundle 2.60 МБ, gzip 682 КБ; попередження про розмір чанка — наявне |
| `npm run typecheck` (усі workspace) | **PASS** | |
| `npm run typecheck:tests` | FAIL (1) | `tests/coding-agent-data-tools.test.ts` — **до змін**, підтверджено на HEAD |
| Coding Agent suites (step1–6, c6, c9×3, chat-website, adapter, stream, chat-development) | **257/257** | 13 файлів |
| Security / approval / sandbox (c10, c11, c13, c14, c15, c4a, c5×3, r1a) | **156/167** | 11 падінь c13-mcp-approval — **на HEAD теж** (перевірено stash'ем) |
| Language / preview / git / approvals / trace | **186/186** | 14 файлів |
| Runner-state / replay / c7 / c8 / inbox / background | **128/128** | 9 файлів |
| `eval:smoke` (C6 eval) | **18/18** | artifact записано |
| `audit:code-tools` | **OK** | 50 tools, manifest v14, checksum стабільний |
| **Security gate** (183 suites) | **51 failed** | **стільки ж, скільки на HEAD** (51), групи падінь ідентичні |
| Web tests (`test:web`) | **194/195** | 1 падіння композера — **на HEAD теж** |
| `npm run lint` | FAIL (1) | size-guard на `apps/web/src/DataStudioSettingsPage.tsx` — **до змін** |

**E2E:** окремого браузерного E2E-набору в репозиторії немає; роль E2E виконують web-suite + інтеграційні
`chat-*`/`coding-agent-*` тести (усі прогнані вище) + `eval:smoke`.

---

## 3. Сценарна матриця (12 сценаріїв × 3 повтори)

Harness: реальний `CodingAgentRunner`, скриптовий engine, in-memory runtime. `Wall time (live)` не виміряно —
причина в §0.

| # | Сценарій | AI calls | Tool calls | Verify | Review | Статус | Файли |
|---|---|---|---|---|---|---|---|
| 1 | Створення нового сайту | 2 | 1 | 1 | 1 | completed | 1 |
| 2 | Зміна одного CSS-стилю | 2 | 1 | 1 | **0** | completed | 1 |
| 3 | Редагування React-компонента | 2 | 1 | 1 | 1 | completed | 1 |
| 4 | Виправлення TypeScript-помилки | 2 | 1 | 1 | 1 | completed | 1 |
| 5 | Виправлення Build | 4 | 2 | 2 | 1 | completed | 1 |
| 6 | Додавання сторінки | 2 | 1 | 1 | 1 | completed | 1 |
| 7 | Повторне редагування | 2 | 1 | 1 | 1 | completed | 1 |
| 8 | Велике редагування (6 файлів) | 4 | 6 | **1** | 1 | completed | 6 |
| 9 | Некоректний Tool Call | 3 | 1 | 1 | 1 | completed | 1 |
| 10 | Відмова AI Provider | 1 | 0 | 0 | 0 | **failed** | 0 |
| 11 | Небезпечна команда → approval | 1 | 1 | 0 | 0 | **waiting_for_user** | 0 |
| 12 | Паралельні проєкти | 2+2 | 1+1 | 1+1 | 1+1 | completed | 1+1 |

Спостереження:

- **CSS-зміна: 0 review** (адаптивний skip), компонент/сторінка/багатофайлова — **1 review**;
- **6 файлів → 1 верифікація** (план звужується/перевикористовується, а не 6 прогонів);
- repair-cycle: рівно 2 verify-прогони і 4 AI-ходи, далі 1 review;
- некоректний tool call: 1 додатковий AI-хід на відмову й recovery, ран завершується `completed`;
- provider failure: 1 виклик, 0 tool/verify, статус `failed` (без зависання);
- approval: `waiting_for_user`, tool викликаний, verify/review не запускалися;
- паралельні проєкти: обидва завершились, ізольовані стани (окремий тест).

**Не виміряно в сценаріях:** wall time p50/p90, час до першої корисної дії, token usage, verification time,
self-review time, preview readiness/update latency — усе це потребує живого стеку після передеплою. Найближчі
живі проксі: TTFT прози 1.0–1.6 с, перший tool call ≈1.2 с (Крок 5), self-review p50 4.8 с (Етап 1).

---

## 4. До / після: підтверджені проблеми Етапу 1

| Проблема Етапу 1 | До | Після | Доказ |
|---|---|---|---|
| `partial_tool_call` через обрізання аргументів | 8 із 18 викликів у записаному рані; кап **21 213** символів | **0** обрізань у живих пробах; 50 620 валідних символів | Крок 1, живий вимір |
| `changedOnly` приймався, але не діяв | повний набір щоразу | звуження для style/asset, `build` ніколи не прибирається | Крок 2 + тести |
| Повторна верифікація незміненої ревізії | **25 із 176** verify-подій без змін між ними; **928 742 мс (16%)** | reuse за ревізією; harness — 1 прогін на ревізію | Крок 2; сценарії 7, 8 |
| Дублювання каталогу інструментів у промпті | 12 452 із 16 933 символів (73%) | −7 012 символів; **9 966 → 8 491 токен (−14.8%)** | Крок 3, живий вимір |
| Текст агента лише в кінці рану | лише `result` | перша дельта **1 061–1 574 мс** (на 19–24% раніше завершення) | Крок 5, живий вимір |
| Зайвий LLM self-review | 109 викликів у корпусі | −2 у корпусі (0 blocking втрачено) | Крок 4 + SQL |
| Зайві перезапуски preview | static: stop+start щоразу | reuse, 0 перезапусків | Крок 5 (unit) |

**Фактичне прискорення (лише виміряне):** промпт −14.8% токенів; перший текст на 19.4% (коротка відповідь) і
24.3% (довгий промпт) раніше завершення виклику; 16% часу верифікації в корпусі припадало на повторні прогони
незміненої ревізії — тепер вони перевикористовуються; 1.8% self-review пропущено. **Загальний wall time рану не
заявляю** — він не виміряний на новому коді.

---

## 5. Стан системи за 30 днів (до змін, 211 ранів)

| Метрика | Значення |
|---|---|
| Завершено / failed / cancelled / interrupted / waiting | 148 / 32 / 19 / 10 / 2 |
| Завислі `running` (>1 год) | **0** |
| Стоп-причини | completed 145, cancelled 19, step_limit 11, budget 7, provider_error 6, invalid_args 5, self_review_unavailable 3, loop_detected 2, self_review_unresolved 1 |
| Model steps на ран | p50 **7**, p90 21, середнє 9.8 |
| Tool calls на ран | p50 **10**, p90 37 |
| Рани з >40 model steps / >60 tool calls | 1 / 8 |
| Рани з повторними однаковими tool calls | **40**, 184 групи, **576** зайвих викликів |
| Self-review | 152 summary, 109 LLM, 4 blocking (усі — source) |

Повторні tool calls — **не виправлялися** в Кроках 1–5: це залишковий ризик (модель повторює `read`/`grep`).

---

## 6. Регресії

**Знайдено одну, спричинену Кроком 3.** Security gate після змін: 52 падіння проти 51 на HEAD. Єдине нове —
`tests/coding-agent-c8-summary-guard-prefix.test.ts` → «keeps the data invariant inside the stable prefix»:
очікувався старий формат `- code.fs.read (v2, read-only)`, а Крок 3 замінив рядок на `- code.fs.read: …`.

- **Причина:** `compactToolLine` у `apps/agent-api/src/coding-agent-runner-prompt.ts` (Крок 3).
- **Це не дефект безпеки:** тест перевіряв, що *запис каталогу* лежить у стабільному префіксі; властивість
  збережена, змінився формат.
- **Виправлення:** асерт оновлено на `- code.fs.read: ` + явна перевірка, що версії більше немає. Після цього
  gate = **51 = HEAD**, групи падінь ідентичні.
- **Точковий відкат (якщо потрібен старий формат):** повернути `toolLines` у
  `coding-agent-runner-prompt.ts` до `(v${version}, read-only)`; це єдина зміна, що впливає на цей тест.
  Комітів немає — відкат = revert цього hunk'а.

Інших регресій немає: security gate 51/51, web 1 pre-existing, typecheck:tests — pre-existing, lint — pre-existing.

---

## 7. Залишкові ризики

1. **Немає наскрізного виміру «до/після»** на живому стеку — головна незакрита вимога кроку; потрібен дозволений
   передеплой і повтор сценаріїв 1–12 із реальним провайдером.
2. **HMR не реалізовано** (немає WS-транспорту; §Крок 5) — preview лишається production/dev-сервером.
3. **Adaptive self-review:** доказова база — 20 style-only ранів, 0 blocking; статистичної впевненості немає,
   kill switch є.
4. **Explicit cache для Anthropic** перевірено лише wire-тестом (немає підключеного провайдера).
5. **51 падіння security gate** — наявні (C13 MCP, C12/C11 manifest pins, semantic intent, preflight cancellation,
   c6 stop, c9 plan) і не пов'язані з Кроками 1–5, але це червоне світло для релізу.
6. **576 повторних tool calls** у корпусі — не адресовано.

---

## 8. Фінальний висновок

**Готовність: умовна (не безумовна).**

Позитивно: усі п'ять оптимізацій інтегровані без конфліктів; build, typecheck, 257 coding-agent тестів, 186
language/preview/git/approval, 128 runner/replay, eval 18/18 — зелені; security gate повернувся до baseline;
жодного дефекту безпеки не додано; підтверджені проблеми Етапу 1 закриті вимірюваннями (tool-call обрізання,
дублювання промпту, повторна верифікація, стрімінг, зайвий review, зайвий restart).

Умови перед релізом:

1. передеплой в ізольованому стеку й повтор 12 сценаріїв із реальним провайдером (wall time p50/p90, preview
   latency);
2. закрити або явно прийняти 51 pre-existing падіння security gate;
3. вирішити питання HMR (окремий крок із WS-транспортом) — зараз preview свідомо без нього.
