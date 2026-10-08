# C14 — the provider cassette, and the `argumentsHash` blocker it exposed

Цей документ описує **виміряний** стан двох речей: (1) касета провайдера (файловий `ReplayBundlePersistPort` +
адаптація `CodeRunEnginePort.chat`), (2) виправлення блокера `argumentsHash`, через який **детермінований
replay справжнього прогону не працював узагалі**. Числа тут або пораховані цим репозиторієм, або взяті з
прогонів, названих у § 5; вигаданих чисел немає.

---

## 1. Точна причина блокера: два різні матеріали на двох боках

`code-replay-engine.ts` порівнює `argumentsHash` **кроку моделі** і **кроку виклику інструмента**:

```
code-replay-engine.ts:486   expected.argumentsHash = String(call.argumentsHash)   // з model_step.response.toolCalls[]
code-replay-engine.ts:496   actualHash            = String(step.argumentsHash)   // з tool_call
code-replay-engine.ts:516   if (expected.argumentsHash !== actualHash) -> divergence("arguments_hash", …)
```

Раннер писав ці два хеші з **різного матеріалу**:

| Місце | Рядок (до виправлення) | Матеріал |
| --- | --- | --- |
| крок моделі | `coding-agent-runner.ts:3941` `bundleHash(call.function?.arguments ?? "")` | **рядок** JSON, як його повернув провайдер |
| крок виклику (звичайний шлях) | `coding-agent-runner.ts:4321` `bundleHash(outcome.call.arguments ?? {})` | **розпарсений об'єкт** після `normalizeToolCalls` |
| крок виклику (MCP-шлях після схвалення) | `coding-agent-runner.ts:3653` `bundleHash(approved.args ?? {})` | теж **об'єкт** |

`bundleHash` канонікалізує те, що йому дали (`canonicalizeJson`), тому для одного виклику виходили **дві різні
величини**. Проба `artifacts/c14-cassette-probe.mjs` (наявна з попереднього потоку, не видалялася):

```
hash of the raw JSON string  : d8f508ffd2c11e5b   <- крок моделі
hash of the parsed object    : 5aff422311aaf6f4   <- крок виклику
```

**Наслідок:** бандл, записаний реальним раннером, на `replayRecorded` давав divergence `arguments_hash` (409) на
**кожному** прогоні, який виконав хоч один інструмент. Детермінований replay справжнього прогону не працював —
і тестів на це не було, бо всі replay-фікстури будували кроки руками (де той самий рядок можна написати з обох
боків), а єдиний виклик `replayRecorded` над реальним записом раннера
(`tests/coding-agent-c13-mcp-run-path.test.ts`) відмовляв **раніше** — на перевірці MCP-манифеста.

Клас дефекту той самий, що вже двічі бив по кроці: **вакуумний replay-guard** (C13: поле без письменника) і
**approval-payload mismatch** (C11: два різні будівники хеша). Порівняння не могло зійтися **за побудовою**.

## 2. Що визнано авторитетним матеріалом

**Авторитетним є значення аргументів (argument value), а не його серіалізація.** Обґрунтування:

1. **Обидві сторони описують один виклик.** Крок моделі тримає текст провайдера (`ChatToolCall.function.arguments`
   — рядок за контрактом `packages/omniroute-adapter/src/types.ts:20`), крок виклику — об'єкт, який адаптер
   розібрав і який пройшов policy/approval. Це два **подання одного значення**.
2. **`argumentsHash` — це вже хеш значення.** Крок виклику завжди хешував об'єкт (`bundleHash(obj)` =
   `bundleHash(canonicalizeJson(obj))`), тому авторитетним боком є саме він; крок моделі був **єдиним**, хто
   хешував текст.
3. **Хеш тексту — це хеш рядкового літерала.** `bundleHash('{"a":1}')` канонікалізує **рядок**, тобто хешує
   `"{\"a\":1}"` разом із лапками. Це не «сильніша» перевірка, це інший матеріал.
4. **Байти не можна зробити спільним матеріалом.** MCP-шлях після схвалення (`approved.args`) тримає **лише
   об'єкт** — сирих байтів провайдера там уже немає. Якби авторитетними були байти, довелося б або
   ре-серіалізувати об'єкт (тобто вигадувати байти), або тримати **два** формати хеша — а це прямо заборонено
   брифом.
5. **Реплей відтворює значення, а не орфографію.** `{}` і `null` і `""` — це порожні аргументи; `{"path":"a"}`
   і `{ "path": "a" }` — той самий виклик. Реплей, чутливий до пробілів провайдера, ламався б із причини, яка
   не має відношення до прогону.

Записані **байти** лишаються в бандлі (`response.toolCalls[].arguments`, `code-replay-bundle.ts:172`), і це не
суперечність: касета **мусить** віддати консюмеру `ChatResult`, у якого `function.arguments` — рядок, а хеш
**не реконструює** виклик. Тому байти — це те, **що подається**; значення — те, **що піниться**.

## 3. Що змінено: **одна** нормалізація

Нова функція в `apps/agent-api/src/code-replay-bundle.ts` (поруч із `bundleHash`, у модулі, який володіє
форматом кроку):

```
canonicalReplayArguments(value: unknown): unknown   // code-replay-bundle.ts:171
replayArgumentsHash(value: unknown): string         // code-replay-bundle.ts:192  = bundleHash(canonicalReplayArguments(value))
```

Правила `canonicalReplayArguments`, кожне з яких не може вигадати виклик:

| Вхід | Результат | Чому |
| --- | --- | --- |
| об'єкт | він сам (канонікалізується `canonicalizeJson`) | `{a:1,b:2}` і `{b:2,a:1}` — один виклик |
| JSON-текст | `JSON.parse(text)` | текст провайдера і об'єкт адаптера — одне значення |
| текст, що не парситься | сам текст | це не значення, яке проєкт уміє прочитати; `{}` зробив би два різні фрагменти однаковими. Адаптер такий виклик усе одно відмовляє (`invalid_tool_arguments`) |
| `""`, `null`, `undefined` | `{}` | порожні аргументи мають **один** хеш, як би їх не записали |
| масив, число, boolean | як є | адаптер їх відмовляє; хеш, що сплющив би їх у `{}`, стер би різницю між відмовленим викликом і порожнім валідним |

**Повертається значення, а не його серіалізація.** Це не деталь: `bundleHash` канонікалізує те, що отримав, тому
повернення канонічного **тексту** дало б хеш рядкового літерала — **другий, інакше записаний матеріал**, тобто
той самий дефект в іншій формі. (Саме ця помилка була зроблена в першій редакції helper'а і **спіймана** новим
тестом: `expect(bundleHash(ARGUMENT_BYTES)).not.toBe(recordedCall.argumentsHash)`.)

Виклики (усі — через `replayArgumentsHash`, жодного прямого `bundleHash` на аргументах):

| Файл:рядок | Що це |
| --- | --- |
| `apps/agent-api/src/coding-agent-runner.ts:3954` | крок моделі, з `call.function?.arguments` (текст) |
| `apps/agent-api/src/coding-agent-runner.ts:4334` | крок виклику, з `outcome.call.arguments` (об'єкт) |
| `apps/agent-api/src/coding-agent-runner.ts:3660` | MCP-крок виклику, з `approved.args` (об'єкт) |
| `apps/agent-api/src/code-replay-cassette.ts:251` | перевірка записаних байтів проти записаного `argumentsHash` |

Тобто **один** матеріал (значення), **одна** нормалізація (`canonicalReplayArguments`), **один** будівник хеша
(`replayArgumentsHash`) — і ним користуються і письменник, і обидва читачі.

## 4. Формат, літерал C10 і доля вже записаних бандлів

* **`REPLAY_BUNDLE_FORMAT_VERSION` не рухався: 3.** Змінився **матеріал** одного хеша, не форма збереженого
  кроку. `replayInputHash` — це хеш **кроків**, і форма кроків не змінилася, тому він рахується як раніше;
  літерал `sha256:579374f118457967140d5f0cadb61f1a9bb004b8fa8fe7656938ea6e6d8fab17`
  (`tests/coding-agent-c10-rewind-fork.test.ts:569`) **уцілів** — ця фікстура сама передає `argumentsHash` і не
  несе байтів аргументів. Те саме пінить `tests/coding-agent-c14-replay-cassette-engine.test.ts` (він звіряє
  літерал проти тієї ж фікстури в обох сховищах). Бімп версії зробив би нечитабельними **збережені** бандли, які
  читаються чудово — протилежне до того, що версія захищає.
* **Старі бандли: виправлення нічого не регресує, і це доведено, а не припущено.** Бандл, записаний до
  виправлення, тримає в кроці моделі хеш **тексту**, а в кроці виклику — хеш **значення**. Тому він **уже** давав
  divergence `arguments_hash` на кожному прогоні, який виконав інструмент: він був нереплеєбельним **до**
  виправлення, а не після. Що з ним стається тепер:
  * він лишається **читабельним доказом**: payload-и кроків не чіпаються, `replayInputHash` збігається (читач
    рахує його тим самим способом) — `integrityFailure` як був `false`, так і лишається;
  * він **не** ретро-фічується: немає другої нормалізації, немає гілки «старі бандли порівнюються інакше», немає
    міграції, яка переписує збережений запис;
  * касета, яка не має **байтів** (усе, що записано до C14), так само відмовляє
    `replay_cassette_arguments_unavailable` — нічого не довигадується.
* Доведення «нічого не регресує» — це не міркування, а два прогони в
  `tests/coding-agent-c13-mcp-run-path.test.ts` (§ 5): запис **реального** раннера реплеїться чисто, а
  **підміна** хеша на кроці моделі все ще дає `arguments_hash`.

## 5. Доказ: невакуумний тест і негативний контроль

`tests/coding-agent-c13-mcp-run-path.test.ts` → `describe("security-gate: C14 — a bundle the real runner recorded
replays (one arguments hash per call)")` → `it("replays the recorded run without an `arguments_hash` divergence,
and refuses substituted argument bytes")`.

Що він робить **справжнім** шляхом (нічого не збудовано руками):

1. `createHarness()` піднімає **реального** `CodingAgentRunner` із реальним `ReplayBundleRecorder`
   (`ports.replayBundle.start`), реальним MCP-transport'ом над `ssrfSafeFetch` і фейковим **сокетом**;
2. `discoverThenAllowByOwnerPolicy(...)` виконує прогрів-прогін і знижує ризик через справжній owner-флоу;
3. скриптований хід моделі кличе MCP-інструмент `mcp:conn-1/read_file` з аргументами `{"path":"a.txt"}`; раннер
   реально його виконує через Integration, і **сам** записує `model_step` + `tool_call` + фінальний `model_step`;
4. тест читає бандл **існуючим** читачем (`readReplayBundle`) і перевіряє те, що робить дефект неможливим:
   * крок моделі тримає саме текст провайдера (`arguments === '{"path":"a.txt"}'`);
   * `argumentsHash` кроку моделі **дорівнює** `argumentsHash` кроку виклику (до виправлення — ні);
   * негативний контроль: **старий** матеріал (`bundleHash(ARGUMENT_BYTES)`, тобто хеш рядкового літерала)
     **не дорівнює** записаному хешу — отже рівність вище не тавтологія, і старий код тут справді падав;
   * `replayRecorded(...)` над цим записом дає `ok: true`, `divergences: []`, `toolCalls.matched = 1`,
     `providerCalls = 0`, `toolExecutions = 0`;
   * **негативний контроль (стіна стоїть):** хеш кроку моделі замінюється на `replayArgumentsHash('{"path":"b.txt"}')`
     в **обох** публікаціях запису (`steps` і `replayInput`) і `replayInputHash` перераховується, тобто
     перевірка цілісності проходить **за побудовою**. Replay усе одно дає divergence `arguments_hash`:
     `actual` = хеш кроку виклику, `expected` = підмінений хеш, і наступний divergence `missing_tool_call` —
     тобто записаний виклик лишається невідповідним (всього 2 divergence).

Друга половина стіни — на рівні касети — доведена там, де вона й живе:
`tests/coding-agent-c14-replay-cassette-engine.test.ts` (кейс (3) блоку «refuses a tampered cassette loudly»)
підміняє **байти** аргументів і перераховує хеш бандла, а касета відмовляє
`replay_cassette_arguments_mismatch` із `reason: "arguments_hash_mismatch"`.

## 6. Як відтворити (тимчасовий харнес)

Сесійна пісочниця забороняє piped stdio, тому `node_modules/vitest/vitest.mjs` напряму не стартує
(`esbuild` спавнить сервіс, `spawn EPERM`). Тимчасовий харнес (`artifacts/`, git-ignored):

```
node --import ./artifacts/c14-cassette-loader.mjs \
     --import ./artifacts/c14-cassette-preload.mjs \
     node_modules/vitest/vitest.mjs run \
     --configLoader native \
     --config artifacts/c14-cassette-vitest.config.mjs \
     tests/coding-agent-c13-mcp-run-path.test.ts
```

* `artifacts/c14-cassette-loader.mjs` — **виправлено в цьому кроці**: `--import` лише **виконує** модуль і не
  реєструє його хуки, тому без явного `module.register(import.meta.url)` (bootstrap у кінці файлу) заміна
  `esbuild`/`node:child_process` не діяла взагалі. Плюс `--configLoader native`, щоб TS-конфіг імпортувався
  напряму, а не через `esbuild.build()`.
* `artifacts/c14-cassette-preload.mjs` — той самий `exec("net use")`-патч (Windows-realpath-проба Vite).
* `artifacts/c14-cassette-vitest.config.mjs` — той самий набір плагінів/`include`, `pool: "threads"`.
* `artifacts/c14-cassette-report-summary.mjs` — читає vitest-JSON і друкує `passed/failed` по файлах.
* `artifacts/c14-cassette-gate-info.mjs` — `suites=` / `missing_count=` із самого `scripts/run-security-gate.mjs`.
* `artifacts/c14-probe-esbuild.mjs`, `artifacts/c14-probe-arguments-hash.mjs` — проби харнесу/хешів (створені цим
  кроком, не видалялися).

Харнес — **дозволяючий оракул**: він лише запускає набір. Обов'язкові
`npm test` / `security-gate` / `test:web` / обидві збірки виконує ескальований прогін (див. звіт кроку).

## 7. Чесні обмеження

1. **Текстовий режим tool-calling не реплеїться цим рушієм і не починав реплеїтися.** Крок моделі записує лише
   `result.toolCalls` (нативні виклики), тож виклик, розібраний із прози, не має пари в кроці моделі — рушій
   відмовляє його як `unexpected_tool_call`. Це поведінка **до** і **після** виправлення; воно не розширювало
   область зміни.
2. **Касета без байтів аргументів не стає реплеєбельною.** Виправлення матеріалу хеша не реконструює виклик:
   запис до C14 усе ще відмовляється з `replay_cassette_arguments_unavailable` — свідомо, бо `""` був би іншим
   викликом.
3. **Другий самостійний матеріал не створено.** `settledResultHash` (хеш `{ settled }`) лишається як був: він
   хешує одну величину з одного боку і не брав участі в дефекті.
4. **Доведено на MCP-інструменті** (єдиний шлях, де інструмент реально виконується в наявному харнесі).
   Звичайний (не-MCP) шлях використовує **той самий** рядок `appendToolResult`
   (`coding-agent-runner.ts:4334`), тому окремого тесту для нього немає — це той самий код, а не паралельна
   реалізація.
5. **Виклик без аргументів тепер має один хеш замість двох.** `""`/`null`/`undefined` → `{}` в
   `canonicalReplayArguments`. Для виклику, який провайдер прислав без аргументів, стара пара була
   `bundleHash("")` (крок моделі) проти `bundleHash({})` (крок виклику) — тобто теж нерозв'язна; тепер обидва
   боки дають `bundleHash({})`. Окремого тесту на це немає: поведінка випливає з тієї самої функції, яку пінить
   наскрізний тест, а асерція на літерал `sha256:…` для `{}` була б піном реалізації, не властивості.
6. **Порівняння стало нечутливим до орфографії аргументів** (`{ "path": "a" }` ≡ `{"path":"a"}`) — це
   властивість обраного матеріалу, і вона задокументована тут прямо. Байти, як і раніше, піняться **окремо** —
   касетою, яка звіряє їх із записаним хешем перед тим, як віддати `ChatResult`.
