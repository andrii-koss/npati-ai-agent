# C14 — eval-корпус (30+ задач, 7 типів, 4 мови) і comparative-звіт по профілях

Документ описує **виміряний** стан кроку C14 (owner decision 1). Усе, що тут написано про корпус і про
профілі, або пораховано з фікстури (`tests/fixtures/coding-agent-eval/tasks.json`), або відтворено реальним
резолвером (`resolveModelProfile`) і закріплено тестами. Числа, які неможливо виміряти в цьому потоці, прямо
позначені `not_run` — вигаданих чисел у звіті немає.

## 1. Резюме

| Що | Стан |
| --- | --- |
| Задач у корпусі | **33** (було 17; +16 нових). Наявні 17 не видалено й не переписано: `git diff` по фікстурі — це **лише** 386 доданих рядків і 2 змінені (шапка `schemaVersion`/`description`), у наявних задачах додано тільки метадані `taskType`/`language`, а `files`/`script`/`verify` не змінені жодним рядком |
| Типів задач | **7 з 7**: `bug_fix`, `feature`, `refactor`, `tests`, `multi_file`, `build_repair`, `dependency_migration` |
| Мов | **4 мови програмування** (JavaScript, TypeScript, Python, Go) + JSON-конфігурація |
| Hermetic | 33/33: лише файлові інструменти, 3 симульовані команди, жодного мережевого ендпойнта |
| Скоринг на задачу | `ok`, `steps`, `toolCalls`, `checks`, `turns`, `failures`, `tokens`, `durationMs`, `diffStats`, `costUsd` (+`costUnavailable`) |
| Версія формату | каркас і корпус — **schemaVersion 3** (було 2); старіші фікстури читаються, новіший — відмовляється |
| Comparative-звіт по профілях | `buildCodeEvalProfileReport()`: **conformance — виміряно**, **якість — `not_run`** |

## 2. Корпус: 33 hermetic-задачі

### 2.1 Розбивка по семи типах

| Тип (`taskType`) | Задач | Приклади |
| --- | --- | --- |
| `bug_fix` | 12 | `fix-bug-arithmetic`, `fix-typescript-type`, `python-fix-bug-average`, `go-fix-bug-off-by-one` |
| `feature` | 6 | `add-function-multiply`, `python-feature-clamp`, `go-feature-multiply`, `javascript-feature-parse-args` |
| `refactor` | 3 | `refactor-rename-parser`, `python-refactor-extract-helper`, `typescript-refactor-extract-type` |
| `tests` | 4 | `write-unit-test`, `python-tests-add-case`, `go-tests-add-case`, `added-test-not-flagged` |
| `multi_file` | 2 | `python-multi-file-package` (один канонічний патч на 3 файли), `typescript-multi-file-rename-export` |
| `build_repair` | 4 | `fix-build-config`, `update-tsconfig`, `build-repair-broken-manifest`, `build-repair-tsconfig-trailing-comma` |
| `dependency_migration` | 2 | `dep-migration-replace-left-pad`, `dep-migration-drop-dead-dependency` |

### 2.2 Розбивка по мовах

| Мова (`language`) | Задач | Що це означає |
| --- | --- | --- |
| `javascript` | 17 | сирці `.js` |
| `python` | 5 | сирці `.py` — **без жодної команди** (див. § 4) |
| `go` | 3 | сирці `.go` — **без жодної команди** |
| `typescript` | 4 | сирці `.ts` |
| `json` | 4 | `package.json` / `tsconfig.json` (формат конфігурації, не мова програмування) |

Метадані `taskType`/`language` — це **дані фікстури**: поле необов'язкове (щоб schema-1/2 фікстура лишалася
валідною дослівно), але в корпусі його декларує кожна задача, і обидва значення перевіряються проти закритих
словників `EVAL_TASK_KINDS` / `EVAL_LANGUAGES`. Друкарська помилка в типі чи мові — це помилка завантаження
(`eval_fixture_invalid`), а не «покриття».

### 2.3 Шістнадцять нових задач

| id | тип | мова | Що змінює | Верифікація |
| --- | --- | --- | --- | --- |
| `python-fix-bug-average` | bug_fix | python | `src/stats.py`: прибирає зайвий `- 1` | `file_contains` + `diff_stats` (1 файл / +1 / −1) |
| `python-feature-clamp` | feature | python | `src/ranges.py`: додає `clamp()` | 2×`file_contains` + `diff_stats` (1 / +2 / −0) |
| `python-refactor-extract-helper` | refactor | python | `src/report.py`: виділяє `_format_row()` | `file_contains` + `diff_stats` (1 / +3 / −4) |
| `python-tests-add-case` | tests | python | новий `tests/test_ranges.py` | `file_contains` + `diff_stats` (1 / +3 / −0) |
| `python-multi-file-package` | multi_file | python | **один** канонічний патч: `src/geo.py` + `src/__init__.py` + `tests/test_geo.py` | 3×`file_contains` + `diff_stats` (3 / +6 / −0) |
| `go-fix-bug-off-by-one` | bug_fix | go | `main.go`: `i <= len(items)` → `i < len(items)` | `file_contains` + `diff_stats` (1 / +1 / −1) |
| `go-feature-multiply` | feature | go | `math.go`: додає `Multiply` | `file_contains` + `diff_stats` (1 / +2 / −0) |
| `go-tests-add-case` | tests | go | новий `math_test.go` | `file_contains` + `diff_stats` (1 / +7 / −0) |
| `typescript-feature-optional-param` | feature | typescript | `src/format.ts`: параметр `fallback` | `file_contains` + `diff_stats` (1 / +2 / −1) |
| `typescript-refactor-extract-type` | refactor | typescript | `src/api.ts`: `interface RequestShape` | `file_contains` + `diff_stats` (1 / +4 / −1) |
| `typescript-multi-file-rename-export` | multi_file | typescript | ренейм `toCents` → `amountToCents` у 2 файлах | 2×`file_contains` + `diff_stats` (2 / +3 / −3) + `test_integrity: clean` |
| `build-repair-broken-manifest` | build_repair | json | `package.json` без коми; `check npm run build` червоний → зелений | `command_succeeds` + `file_contains` + `diff_stats` (1 / +1 / −1) |
| `build-repair-tsconfig-trailing-comma` | build_repair | json | `tsconfig.json`: зайва кома; той самий `check` | `command_succeeds` + `file_contains` + `diff_stats` (1 / +1 / −1) |
| `dep-migration-replace-left-pad` | dependency_migration | javascript | 4 файли: локальний `padStart`, прибрані імпорти `left-pad` **і** залежність із манифесту | `command_succeeds` (`deps:check`) + 2×`file_contains` + `diff_stats` (4 / +8 / −7) |
| `dep-migration-drop-dead-dependency` | dependency_migration | javascript | `package.json`: прибирає **невикористаний** `lodash`, лишає використаний `left-pad`; `check` червоний → зелений | `command_succeeds` + `file_contains` + `diff_stats` (1 / +1 / −2) |
| `javascript-feature-parse-args` | feature | javascript | `src/cli.js`: додає `parseArgs()` | `file_contains` + `diff_stats` (1 / +6 / −0) |

### 2.4 Агрегат реального прогону корпусу

Прогін 33 задач через **реальний** шлях інструментів (`CodeToolRuntime` + канонічні виконавці) з ціною моделі
`anthropic/claude-3-5-sonnet` (3.0 USD/1M prompt, 15.0 USD/1M completion). Числа закріплені асерцією в
`tests/coding-agent-c6-eval.test.ts`, тому таблиця не може розійтися з прогоном:

| Метрика | Значення |
| --- | --- |
| `totals.steps` | 135 |
| `totals.turns` | 49 |
| `totals.checks` | 22 (14 від C9 + 8 нових) |
| `totals.tokens` | 3357 |
| `totals.diffStats` | 42 файли / +80 рядків / −43 рядки |
| `totals.costUsd` | 0.019671 USD |
| `totals.durationMs` | збирається, але **не** піниться: це wall-clock, а не властивість корпусу |

`turns` (49) навмисно менший за кількість викликів інструментів (80): послідовні виклики в одному ході — це
**один** хід моделі, і саме так це описано в правилі нижче.

## 3. Симулятори названі симуляторами

Каркас не має права вдавати, що «розуміє» мову. Усі три команди корпусу — це **симулятори всередині тесту**
(`tests/coding-agent-c6-eval.test.ts`), і кожен названий тим, чим він є:

| Команда | Що це | Чого **не** робить |
| --- | --- | --- |
| `npm test` | **regex-СИМУЛЯТОР**: обчислює лише `expect(<fn>(a, b)).toBe(n)` проти `export function f(a, b) { return a <op> b; }` у JS/TS-подібних файлах, поважає `.skip`/`.todo`/`.only` | не запускає ні vitest, ні node; **не розуміє Python, Go чи будь-яку іншу мову**; не виконує довільний код |
| `npm run build` | стенд «білд може прочитати свою конфігурацію»: парсить `package.json`/`tsconfig.json` **справжнім `JSON.parse`** | нічого не компілює, не резолвить модулі, не кличе tsc |
| `npm run deps:check` | regex-скан `import`/`require` + манифест у **двобічному** напрямі: недекларований імпорт і оголошена-але-невикористана залежність | не резолвить пакети, не знає версій, не торкається реєстру |

Невідома команда повертає **помилку**, а не «зелено»: задача, що назве четверту команду, не може пройти
завдяки раннеру, якого ніхто не підключив.

**Де саме це написано:**

* у шапці корпусу — `description` у `tests/fixtures/coding-agent-eval/tasks.json` (слова `REGEX SIMULATOR` та
  «has NO understanding of Python, Go or any other language»);
* у коді — коментарі `runFixtureTests` («Deterministic stand-in for the fixture's test runner»),
  `runFixtureBuild`, `runFixtureDepsCheck` («It is a simulator and says so») і `runFixtureCommand`;
* у тесті корпусу — `it("gives the Python and Go tasks no command at all, because no simulator reads those languages")`;
* у цьому документі.

Наслідок для мов: **Python- і Go-задачі не мають жодної команди**. Їхня верифікація — `file_contains` і
`diff_stats` над change set, тобто твердження про текст фікстури, а не про виконання. Тест це пінить явно:
для кожної python/go-задачі кожен крок не може бути `check`, а кожна верифікація мусить бути
`file_contains`/`diff_stats`.

## 4. Чим доведено, що кожна задача hermetic

| Доказ | Як перевіряється |
| --- | --- |
| Лише файлові інструменти | `it("proves hermeticity from the data: file tools only, three simulated commands, no endpoint")`: словник інструментів корпусу — **рівно** `["code.fs.apply_patch","code.fs.edit","code.fs.move","code.fs.read","code.fs.write"]`. Жодного `code.shell.*`, `code.deps.*`, `code.git.*`, `code.agent.spawn`, MCP чи ask_user |
| Лише три симульовані команди | той самий тест + `it("keeps every scripted step a legal tool call shape and uses only the fixture's three simulated commands")`: `["npm run build","npm run deps:check","npm test"]` — точний список; будь-яка інша команда дає `exitCode: 1` |
| Жодного ендпойнта у фікстурах | той самий тест: вміст кожного файлу кожної задачі не містить `http://` / `https://` |
| Жодного породженого процесу | структурно: симулятори — чисті функції над `Record<string,string>` у тестовому файлі; у `apps/agent-api/src/code-eval-harness.ts` немає жодного `spawn`/`exec`/`fetch` (каркас викликає лише порти `invokeTool`/`runCommand`, які в CI підключені до цих функцій) |
| Жодної мережі/Docker/живої моделі | `resolveEvalMode` вмикає live лише за `NPATI_CODE_EVAL_LIVE=1`, і навіть тоді `runEvalSuite` **відмовляється** працювати без ін'єктованої `liveModel` (`eval_live_model_missing`) |
| Однаковий результат у CI | `eval:smoke` жене цей самий файл; артефакт — `artifacts/coding-agent-eval-smoke-report.json` |

## 5. Скоринг: точний формат

`EvalTaskResult` (на задачу) — було `{ steps, toolCalls, checks, failures, tokens, durationMs }`, стало:

```
{ id, ok, steps, toolCalls, checks, turns, failures, tokens, durationMs,
  diffStats: { files, linesAdded, linesRemoved },
  costUsd: number | null, costUnavailable?: "no_price_for_model" | "token_split_unavailable",
  reason? }
```

`EvalReport.totals` додатково несе `turns`, `diffStats` (сума), `costUsd`, `costUnavailableTasks`.

* **`turns`** — ходи моделі, виведені за явним правилом (`evalTurnIndexes`/`countEvalTurns`): максимальний
  ланцюжок послідовних `tool`-кроків — це **один** хід, що видав ці виклики; `message`, яке закриває ланцюжок,
  належить тому ж ходу; `message` без ланцюжка — хід без викликів; `check` видає цикл верифікації, а не модель,
  тому він не утворює ходу. Рахується лише **виконаний префікс** транскрипту. Це нижня межа на кількість
  викликів моделі: сусідні ходи, чиї виклики збіглися в транскрипті, не відрізнити — і метрика ніколи не
  заявляє більше, ніж доводить запис.
* **`diffStats`** — change set між початковими файлами задачі та фінальним станом, за **тим самим правилом
  рядків**, що й текст ревʼю (`renderChangeDiff`), тож метрика й текст не можуть розійтися. Правило — різниця
  множин непорожніх рядків, а не LCS: рядок, переміщений усередині файлу, не рахується ні доданим, ні
  видаленим. Це слабше за `git diff --numstat` і прямо так і задокументовано.
* **`costUsd`** — **обчислюваний**: `prompt/1e6 × promptPerM + completion/1e6 × completionPerM`, округлення до
  6 знаків (та сама арифметика, що в `CostTelemetry.calculate`). Ціну дає наявна конфігурація цін проєкту
  (`configuredModelPricing`), а не цей модуль.
  * немає ціни для моделі → `costUsd: null`, `costUnavailable: "no_price_for_model"`. **Дженерик-рядок
    `default` з таблиці цін тут не використовується**: у бюджетному шляху він дає число, але видавати його за
    ціну конкретної моделі — це вигадане вимірювання;
  * ціна є, але викликач дав лише суму токенів без розбивки → `token_split_unavailable` (оцінка суми за
    prompt-ставкою занижує, за completion-ставкою завищує);
  * `0` не використовується як «невідомо»: нуль означає рівно нуль токенів із відомою ціною;
  * `totals.costUsd` — сума лише по тих задачах, які вдалося оцінити, і `null`, якщо не вдалося жодну;
    `costUnavailableTasks` завжди каже, скільки задач у суму не ввійшло.
* **`diff_stats` як тип верифікації** (адитивно в `VERIFICATION_TYPES`/`validateVerification`/`runVerification`):
  `{ "type": "diff_stats", "expect": { "files": N, "linesAdded"?: N, "linesRemoved"?: N } }`. `files`
  обов'язкове — «нічого не змінилося» не може задовольнити твердження про change set через пропущене поле.
  Це єдина верифікація, яка валить задачу, що зробила потрібну правку **і** зайву.
* **Версії**: `CODE_EVAL_SCHEMA_VERSION = 3` (мінімум, який ще читається, — `1`). Фікстура новішого формату
  відмовляється з `eval_fixture_version_unsupported` (а не читається наполовину), і це покрито тестами —
  разом із тим, що фікстура schema 2 усе ще завантажується й проходить.

## 6. Comparative-звіт по профілях: що виміряно і що `not_run`

`buildCodeEvalProfileReport()` (`apps/agent-api/src/code-eval-profile-report.ts`) будує звіт, у якому дві
половини розділені явно. **Чому саме так:** `runEvalSuite` профіль не читає взагалі, тому «задача пройшла на
профілі X» було б ярликом — число було б однакове для всіх профілів, бо жоден профіль ні на що не впливає.

### 6.1 Conformance — ВИМІРЯНО

Для кожної пари «сценарій розгортання × модель» звіт викликає **справжній** `resolveModelProfile` і записує
справжній `modelProfileFallbackTrace`. Сценарії: `registry_unfiltered` (фільтра немає), `no_profile_enabled`
(порожній список увімкнених → fail-closed), `flags_enabled_subset` (увімкнено `hosted-native-tools` +
`local-text-tools`).

| Сценарій | Модель | Профіль | `matchedBy` | `fallbackReason` |
| --- | --- | --- | --- | --- |
| `registry_unfiltered` | `openai/gpt-4o` | `hosted-native-tools` | `provider` | — |
| `registry_unfiltered` | `anthropic/claude-3-5-haiku` | `hosted-native-tools-small-context` | `pattern` | — |
| `registry_unfiltered` | `ollama/llama3.1:8b` | `local-text-tools` | `provider` | — |
| `registry_unfiltered` | `-/acme/mystery-1` | `conservative-default` | `default` | `no_matching_profile` |
| `no_profile_enabled` | усі чотири | `conservative-default` | `default` | `profile_flag_disabled` |
| `flags_enabled_subset` | `openai/gpt-4o` | `hosted-native-tools` | `provider` | — |
| `flags_enabled_subset` | `anthropic/claude-3-5-haiku` | `hosted-native-tools` | `provider` | — |
| `flags_enabled_subset` | `ollama/llama3.1:8b` | `local-text-tools` | `provider` | — |
| `flags_enabled_subset` | `-/acme/mystery-1` | `conservative-default` | `default` | `no_matching_profile` |

Останній рядок третього сценарію — це те, що варто бачити: коли pattern-профіль не увімкнений, модель
`claude-3-5-haiku` їде на **ширшому** provider-профілі, і звіт показує переможця, а не припущення.

### 6.2 Таблиця на профіль

| Профіль | Джерело | `matchedBy` | Режим | Паралельно | Контекст | Відповідає за (виміряно) | Якість |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hosted-native-tools` | реєстр | `provider` | `native` | 4 | 200000 | `registry_unfiltered:openai/gpt-4o`; `flags_enabled_subset:openai/gpt-4o`; `flags_enabled_subset:anthropic/claude-3-5-haiku` | `not_run` |
| `hosted-native-tools-small-context` | реєстр | `pattern` | `native` | 2 | 64000 | `registry_unfiltered:anthropic/claude-3-5-haiku` | `not_run` |
| `local-text-tools` | реєстр | `provider` | `text` | 1 | 32000 | `registry_unfiltered:ollama/llama3.1:8b`; `flags_enabled_subset:ollama/llama3.1:8b` | `not_run` |
| `conservative-default` | консервативний | `default` | `auto` | 1 | 32000 | `registry_unfiltered:-/acme/mystery-1`; `flags_enabled_subset:-/acme/mystery-1`; усі чотири в `no_profile_enabled` | `not_run` |

Профіль, який **не** відповідав жодному сабджекту, теж отримує рядок — із порожнім `matchedFor` і
`quality: not_run` (тест додає такий профіль у реєстр і перевіряє саме це). Формат рядка закріплено
(`profileId`, `source`, `matchedBy`, `matchedFor`, `toolCallingMode`, `maxParallelToolCalls`, `contextWindow`,
`quality`), тому числове поле якості не можна додати непомітно.

### 6.3 Якість моделі — `not_run` (не вимірюється в цьому потоці)

`report.quality` каже це **в самому звіті**:

* `measured: false`, `status: "not_run"`, `reason: "live_run_not_performed"`;
* `requires: ["NPATI_CODE_EVAL_LIVE=1", "a liveModel port injected into the harness deps"]`;
* `refusal: { code: "eval_live_model_missing", ... }` — цитується та сама відмова, яку каркас уже робить;
* `note`: «The recorded suite never reads a model profile, so no task result may be attributed to one…».
* `corpus.records`: `producedBy: "runEvalSuite() -> EvalReport …"`, `assertedBy: "tests/coding-agent-c6-eval.test.ts"`,
  `ciArtifact: "artifacts/coding-agent-eval-smoke-report.json"` (це vitest-JSON того ж набору: він несе вердикт,
  а не per-task скоринг — і звіт цього не приписує).

Окремий source-guard у тесті читає `code-eval-harness.ts` і перевіряє, що там **немає** ані імпорту
`code-model-profiles`, ані `resolveModelProfile`/`modelProfileTrace`/`enabledProfileIds`. Це і є доказ, чому
per-profile результат із записаного прогону неможливий.

## 7. Як відтворити

```
npm run eval:smoke                      # увесь корпус через vitest (той самий файл, що в CI-job evals)
node --experimental-transform-types --no-warnings ./artifacts/c5b-policy-probe/run.mjs \
     tests/coding-agent-c6-eval.test.ts tests/coding-agent-c14-eval-metrics-and-profiles.test.ts
node artifacts/c14-corpus-gen.mjs       # read-only звіт покриття корпусу (типи, мови, команди, інструменти)
```

Тимчасовий файл: `artifacts/c14-corpus-gen.mjs` (git-ignored `artifacts/`). Він задумувався як генератор
фікстури, але **не використовувався для запису**: у цій сесії пісочниця забороняє запис файлів із породжених
процесів, тож `tasks.json` написано напряму, а скрипт перепрофільовано на читання (він і дав таблиці § 2).

## 8. Чесні обмеження

1. **Симулятор не розуміє мов.** `npm test` бачить лише JS/TS-подібний вираз; для Python і Go корпус свідомо
   не має жодної команди, і жодна задача не стверджує, що код було виконано.
2. **`diffStats` — різниця множин рядків, не LCS.** Переміщений рядок не рахується; порожні рядки не
   рахуються взагалі. Метрика існує, щоб ловити «змінено не той набір файлів», а не щоб відтворювати `git diff`.
3. **`turns` — нижня межа** кількості викликів моделі (див. § 5).
4. **`costUsd` — оцінка з токенів і ціни, а не metering.** Провайдерських цін у відповіді немає; тому невідома
   ціна дає `null`, а не «схоже на правду» число.
5. **`durationMs`** збирається на задачу, але не піниться: wall-clock не є властивістю корпусу.
6. **Якість по профілях не виміряна** (§ 6.3) — це єдина частина C14-звіту, яку можна закрити лише живим
   прогоном із `NPATI_CODE_EVAL_LIVE=1` та ін'єктованою `liveModel`.

## 9. Тести, які це пінять

| Набір | Що пінить |
| --- | --- |
| `tests/coding-agent-c6-eval.test.ts` | 33 задачі реальним шляхом інструментів; точний список id; агрегат (steps/turns/checks/tokens/diffStats/costUsd); покриття 7 типів і 5 значень мови; hermetic-словник інструментів і команд; «python/go без команд»; `diff_stats`-числа кожної задачі |
| `tests/coding-agent-c14-eval-metrics-and-profiles.test.ts` | арифметика скорингу (`computeEvalCost`, `diffStatsFor`, `evalTurnIndexes`) у двох напрямах; `diff_stats` — позитив і чотири негативні контролі + валідація; `null` замість `0` для невідомої ціни; schema 2→3 адитивність і відмова від новішого; conformance-матриця, перерахована справжнім резолвером; таблиця профілів дослівно; `not_run` без числового поля якості; source-guard «каркас не читає профіль» |
