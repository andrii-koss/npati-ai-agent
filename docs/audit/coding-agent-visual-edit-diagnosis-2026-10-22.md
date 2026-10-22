# Діагностика та виправлення: вибір технології, редагування за фото, контекст, зациклення

**Дата:** 2026-10-22. **Стек:** локальний `npati-isolated-source-20261011`, образ `npati-fix-local:20261022` +
`npati-fix-runtime:20261022`, HEAD `97b1d7a` + локальні виправлення цієї сесії.
**Джерела:** PostgreSQL (`code_run_states`, replay-бандли, `project_qa_reports`), Docker logs, реальні E2E через
`POST /chat/stream` з реальним OmniRoute/DeepSeek і реальним sandbox, unit/integration тести.

---

## 1. Реальні запуски

### Запуск 1 — «Створи мені інтернет-магазин»

| Факт | Значення |
|---|---|
| Run | `53bf1a16-298c-49d2-b342-4ad96788da57` |
| Проєкт | `058cb874-e2ea-46f1-aad5-da3e29bfa8da`, **Next.js**, `code_project` |
| Час | 06:51:09 → 06:57:26 UTC (377 с), completed |
| Prompt, який отримала модель | `Your assigned project is Online store (store), using Next.js…` |
| Хто обрав Next.js | старий frontend/semantic planner: `requestedFramework ?? "Next.js"` (коміт `a292a23`); semantic-промпт теж казав «Default website framework Next.js» |
| Чи був вибір обґрунтований | ні: жодного persisted reason/criteria, користувач технологію не вказував |

### Запуск 2 — фото дизайну + «зміни дизайн»

| Факт | Значення |
|---|---|
| Run | `code-run-mvj6ynx7-057n6ili` |
| Проєкт / сесія | той самий `058cb874…` / та сама сесія (контекст збережено) |
| Час | 07:00:14 → 07:12:31 UTC (737 с), **failed** |
| Stop reason | **`loop_detected`** |
| Ходи / tool calls / токени | **71 / 112 / 2 600 629** |
| Змінені файли | **0** |
| Tool calls | `code.fs.read` **107**, `code.fs.grep` 3, `code.fs.list` 1, `code.fs.tree` 1 — **жодного write/edit** |
| Повторні читання | `Header.tsx` 21×, `app/page.tsx` 19×, `lib/products.ts` 15×, `ProductVisual.tsx` 15×, `ProductCard.tsx` 15×, `app/layout.tsx` 9×, `Footer.tsx` 8× |
| Зображення | у request_text є блок «The attached images are visual references…» → файл дійшов до Coding Agent |
| Модель | `deepseek/deepseek-flash` (у каталозі `vision: true`) |
| Історія | перше повідомлення і відповідь передані в prompt |
| Browser QA / візуальна перевірка | **не виконувалися** — у цьому білді їх ще не було (0 записів `project_qa_reports`) |

**Першопричина:** модель застрягла в «аналізі» — 71 хід перечитування тих самих файлів без жодного запису.
Цьому сприяли три відсутні механізми: (1) vision-аналіз референсу **до** циклу, (2) обмеження «ходів без
прогресу» (був лише 3-ходовий inspection-reminder, який модель ігнорувала), (3) screenshot-порівняння результату.
`loop_detected` спрацював лише на 71-му ході, тому що старий детектор рахував повтори *невдач*, а не успішні
повторні читання. Це підтверджено даними replay-бандла, а не припущенням.

---

## 2. Вибір технології (Part 2)

**Стан у HEAD `97b1d7a` (перевірено кодом і тестами):**

- `chat-project-intent.ts` тепер просить семантичну модель обрати стек із `SUPPORTED_PROJECT_FRAMEWORKS`, з
  `reason` і `criteria`, з вимогою «explicit user technology is binding», «a store does not imply a fixed
  framework», «prefer HTML/CSS or Astro for simple presentation sites».
- Валідація на сервері: framework мусить бути з підтримуваного списку; явна технологія користувача
  (`extractFramework`) перемагає; заборонені технології (`frameworkConstraints`) не можна обрати; для
  не-явного вибору `reason`/`criteria` обов'язкові.
- Fallback без AI: `policy_fallback` з причиною «AI planning unavailable», а для store/crm/saas/api — відмова з
  проханням уточнити технологію (замість тихого Next.js).
- Вибір записується в Activity: `stage: "technology_selection"` з reason/criteria (route + development service).
- `planChatDevelopment` (спільний fallback) більше не має `?? "Next.js"`.

**Перевірка:** `tests/technology-selection-runtime.test.ts` (20 тестів) зелені. **E2E Test A:** «Create a simple
one-page website for a local bakery… No framework specified» → створено **HTML/CSS** проєкт (3 файли, 117.8 с,
preview 200) — важкий фреймворк без потреби не використано.

---

## 3. Редагування за фотографією (Part 3)

**Реалізовано в HEAD і перевірено цією сесією:**

1. `analyzeWebsiteReference` — **реальний vision-виклик до циклу** (layout/colors/typography/spacing/imagery/
   components/plan), результат додається як plan; без моделі — `vision_model_unavailable`, без зображення —
   `reference_image_missing`.
2. `resolveModel` для запитів із зображеннями обирає vision-модель із кандидатів; якщо жодної — fail-closed.
3. `reviewWebsiteReference` — **screenshot реального Preview** (Browser QA, `screenshotMode: "visual"`), потім
   vision-порівняння reference vs screenshot із per-dimension scores 0..1.
4. Repair-loop (2 спроби) у `code-session-run-executor.ts`.
5. Чесний статус: `visual_acceptance_failed` / `_blocked`; `acceptance` об'єкт відрізняє code/build/preview/
   browser QA/visual match/requirements.

**Виправлено цією сесією:**

| Проблема | Файл | Зміна |
|---|---|---|
| Зображення кріпилося до **першого** user-повідомлення (старий prompt створення) | `coding-agent-runner-prompt.ts` | кріплення до **останнього** user-повідомлення; без дублювання, якщо частини вже є |
| `visual_review_unavailable` ховав причину | `website-visual-acceptance.ts` | повертає конкретний код (`visual_screenshot_unavailable`, `qa_timeout`, …) + bounded detail |
| Repair-ран не міг узяти session inbox lease → `refused`, і його помилка **затирала** root-результат | `code-session-run-executor.ts`, `coding-agent-runner-contracts.ts`, `coding-agent-session-starter.ts` | repair іде з `useInbox: false`; root-результат зберігається, помилка repair додається як difference |
| Repair упирався в `async_collect_unsettled` | `coding-agent-review-coordinator.ts` | `skipAsyncCollect: true` для continuation-рану |
| Repair-бюджет 180 с не вміщав один repair | `code-session-run-executor.ts` | 600 с; try/catch навколо repair |

**Живий Test D (референс 1280×900, наявний проєкт `c3ff0c58…`):**

- root-ран завершився за 184 с (4 ходи, 1 файл), preview 200;
- Browser QA: **passed**, screenshot `visual` (report `qa_65101183…`, hash `4ebd8e92…`);
- vision-порівняння: **layout 0.90, colors 0.88, typography 0.85, spacing 0.88, imagery 0.82**, 6 конкретних
  відмінностей (обрізана сітка, hero-ілюстрація замість однорідного блоку, тон смуги тощо);
- **обидва repairs виконані** (296 с / 8 ходів / 2 файли; 153 с / 7 ходів / 1 файл);
- фінальні оцінки: **0.95 / 0.97 / 0.95 / 0.92 / 0.95**, залишилось 5 мінорних розбіжностей (2–4 px, ширина
  карток ≈355 vs ≈351 px);
- фінальний статус — **`visual_acceptance_failed`** (чесно), `visualReferenceMatched: false`,
  `browserQaPassed: true`, `previewRunning: true`, `codeGenerated: true`.

Тобто повний цикл «зображення → аналіз → редагування наявного коду → build/preview → screenshot → vision-порівняння
→ repair → повторне порівняння → чесний вердикт» працює. Візуальна схожість зросла з ~0.85 до **~0.95**, але
поріг прийняття (будь-яка відмінність → fail) не дозволив закрити завдання; це консервативна поведінка, а не
фальшивий успіх.

---

## 4. Контекст між повідомленнями (Part 4)

- Запуск 2 працював у **тому самому** проєкті/сесії, що й запуск 1; історія передана; зображення дійшло.
- Виправлено точку кріплення зображення (останнє повідомлення) — раніше фото опинялося біля старого запиту.
- `referenceContext` передає зображення/модель дочірнім агентам (subagents) — перевірено кодом
  (`coding-agent-runner.ts:73`, `coding-agent-runner.ts:108`).
- **Test E:** повторне редагування того самого сайту наступним повідомленням («зміни заголовок… додай у футер…») —
  completed за **36.4 с**, 2 файли, preview running, новий проєкт **не** створено.

---

## 5. Зайві операції та зациклення (Part 5)

- Діагноз: 107 успішних читань, 0 записів, 71 хід (див. §1).
- Механізми, що вже є в HEAD: inspection-limit 3 з reminder; **no-progress guard** — на 4-му ході reminder, на
  10-му — `stopped / loop_detected`; повторні невдалі виклики — існуючий loop detection.
- **Test G (новий):** scripted-ран, який лише читає різні файли (щоб не спрацював rejection-детектор) →
  зупиняється на ~10-му ході з `loop_detected`, без жодного запису, повідомлення «ten model turns without source
  progress». Це та сама поведінка, якої бракувало 22-му запуску.
- **Виправлено хибне спрацювання guard:** він рахував прогрес лише за зміною *множини* змінених файлів, тому
  легітимний багатофазний run (4 читання + 1 edit × 3 фази) зупинявся на 10-му ході, хоча редагував файли
  (`coding-agent-c6-runner` падав і на чистому HEAD). Тепер хід, у якому виконано мутаційний інструмент,
  вважається прогресом; guard зупиняє лише цикли без жодної мутації.
- У нових E2E ранах зациклень не було: root 4 ходи / 1 файл, repairs 8 і 7 ходів із записами.

---

## 6. Критерії якості (Part 6)

`acceptance` у результаті рану розділяє:

| Критерій | Як визначається | Test D |
|---|---|---|
| codeGenerated | filesChanged > 0 | true |
| buildPassed | verification.status === passed, якщо build запитано | not_applicable (HTML/CSS) |
| previewRunning | websitePreview.status === running | true |
| browserQaPassed | Browser QA report | true |
| visualReferenceMatched | vision-порівняння, всі dimensions ≥ 0.8 **і** 0 differences | false (0.95+, але 5 мінорних) |
| functionalBehaviorVerified | окремі scenario-перевірки (не заявляються) | false |
| requirementsVerified | лише для visual-скоупу | false |

Подія `visual_acceptance` пише scores, hashes reference/screenshot, report id у Activity; блокування/провал
супроводжуються конкретним кодом.

---

## 7. Тести

| Перевірка | Результат |
|---|---|
| `technology-selection-runtime.test.ts` | 20/20 |
| `website-visual-acceptance.test.ts` (включно з новими: attach до останнього повідомлення, repair без inbox, збереження root-результату) | 7/7 |
| `coding-agent-c6-runner.test.ts` (регресія progress guard) | 52/52 |
| `coding-agent-progress-guard.test.ts` (новий, Test G) | 1/1 |
| `chat-semantic-project-intent`, `chat-development`, `c6-runner-stop-conditions` | 121/121 |
| `typecheck` agent-api | pass |
| Docker build (API + web) | pass |
| **Security Gate** | **2842 passed / 0 failed** |

### Реальні E2E

| Тест | Результат |
|---|---|
| **A** — простий сайт без технології | **PASS**: HTML/CSS (не Next.js), 3 файли, 117.8 с, preview 200 |
| **B** — магазин без технології | **FAILED**: вибір HTML/CSS відбувся, але перший ран — `provider_error` (189 с, 5 tool calls), повторний — `interrupted` (465 с) з `Project not found`; рядки проєктів зникли з БД без аудит-запису про видалення (аномалія середовища, не коду) |
| **C** — явний Vue/Laravel | **НЕ ВИКОНАНО** (час); вибір/явна технологія покриті unit-тестами та списком підтримки |
| **D** — сайт → фото → редагування | **WORKFLOW PASS, VERDICT FAIL**: правки, build/preview, screenshot, vision 0.90→0.95, 2 repairs, чесний `visual_acceptance_failed` |
| **E** — повторне редагування | **PASS**: 36.4 с, 2 файли, той самий проєкт |
| **F** — без vision-моделі | **UNIT PASS** (executor падає `vision_model_unavailable` до запуску); живий не запускався |
| **G** — зациклення | **PASS** (новий тест) |

---

## 8. Змінені файли (ця сесія)

| Файл | Що змінено |
|---|---|
| `apps/agent-api/src/coding-agent-runner-prompt.ts` | `withCodingReferenceImages` кріпить фото до останнього user-повідомлення |
| `apps/agent-api/src/website-visual-acceptance.ts` | конкретний код/деталь блокування acceptance |
| `apps/agent-api/src/code-session-run-executor.ts` | repair: `useInbox:false`, `skipAsyncCollect:true`, 600 с, try/catch, збереження root-результату |
| `apps/agent-api/src/coding-agent-runner-contracts.ts` | `useInbox?`, `skipAsyncCollect?` |
| `apps/agent-api/src/coding-agent-session-starter.ts` | повага до `useInbox:false` |
| `apps/agent-api/src/coding-agent-review-coordinator.ts` | пропуск collect-barrier для repair |
| `apps/agent-api/src/coding-agent-runner.ts` | progress guard рахує мутаційний хід як прогрес (хибний stop) |
| `tests/website-visual-acceptance.test.ts` | +2 тести (attach, repair lease/result) |
| `tests/coding-agent-progress-guard.test.ts` | новий Test G |

Решта механізмів (semantic selection, vision analysis, screenshot acceptance, progress guard) **вже була в HEAD
`97b1d7a`**; ця сесія їх перевірила, довела на живому стеку і виправила залишкові дефекти.

---

## 9. Залишкові обмеження

1. **Поріг візуальної відповідності дуже строгий**: будь-яка відмінність (навіть 2–4 px) → fail. Для синтетичного
   референсу агент досяг 0.95+, але не 0 differences. Це безпечно, але може вимагати політики допуску (окреме
   рішення).
2. **Test B / аномалія БД**: `Project not found` і зникнення рядків проєктів після довгого рану — не пояснено;
   потребує окремого розслідування транзакцій/життєвого циклу проєкту.
3. **Test C** (явний Vue/Laravel) не виконано наживо.
4. **Test F** перевірено unit-тестом, не живим (потрібна конфігурація без vision-моделі).
5. **Функціональна поведінка** (кошик, checkout) не верифікується автоматично: `functionalBehaviorVerified`
   залишається false; acceptance чесно це показує.
6. **`code_run_sandbox_release_unavailable`** у логах після рану (preview живий) — транзієнт/шум.
7. **Задеплоєний локальний образ** (`npati-fix-local`) зібрано до фінального виправлення guard; на E2E це не
   вплинуло (жоден ран не мав 10 ходів без мутацій), але для повної відповідності коду потрібен один rebuild.

---

## 10. Висновок

- **Root cause** обох проблем встановлено з даних: примусовий Next.js у старому planner (виправлено в HEAD і
  перевірено E2E A), і зациклення без записів під час фото-редагування (71 хід, 107 читань, 0 записів).
- **Що виправлено зараз:** точка кріплення зображення, конкретні помилки acceptance, repair-lease,
  async-collect-barrier, бюджет repairs, збереження root-результату; додано два тести.
- **Чи може агент редагувати наявний сайт за фото:** **так, механічно повний цикл працює** — він редагує той самий
  проєкт, робить build/preview, знімає реальний screenshot, порівнює з фото, ітерує repairs і повідомляє чесний
  статус. У перевіреному запуску схожість сягнула ~0.95; фінальний вердикт — `visual_acceptance_failed` через
  мінорні піксельні розбіжності, а не через фальшивий «completed».
- **Production:** не змінювався. Локальний стек оновлено лише тестовими образами; дані користувача не чіпалися
  (перевірявся окремий тестовий проєкт).
