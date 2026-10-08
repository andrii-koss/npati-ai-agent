# R1 — секція A (ліміти і квоти): звіт кроку

Це звіт кроку **R1-A** (пункти 1–5 секції A плану `docs/coding-agent/PLAN.md:818-823`). Код і коментарі в
репозиторії — англійською; цей документ — українською. Число наборів гейта оновлено в
`docs/coding-agent/security-gate-report.md` (153 → **155**) разом із цим кроком.

**Стан після кроку:** `npm run typecheck` → **exit 0**; `npm run typecheck:tests` → **exit 0**;
`npm run lint` → **exit 0**; `node scripts/migration-registry-check.mjs` → **exit 0**
(`files=87 registered=87 first=001_… last=087_code_data_retention issues=0`);
`node scripts/mutation-controls-check.mjs` → **exit 0** (`rows=3 decoy=2 cosmetic=1 ok=true issues=0`);
`node scripts/run-security-gate.mjs --list` → **155** рядків (було 153).
`npm test` **мусить лишитися 10 файлів / 15 тестів** — крок не чіпає `known-failures.json`, не додає
`.skip`/`.only`/`.todo` і не змінює жодного з 15 передіснуючих падінь.

**Що ще має прогнати ескалований прогін власника:** `npm test` (очікування: **10 файлів / 15 тестів**, GREEN),
`security-gate` (очікування: **155 наборів**, **+45** нових тестів — 27 у `coding-agent-r1a-limits-and-quotas`,
18 у `coding-agent-r1a-sandbox-quotas` — `failed=0`, `skipped=0`), `test:web`
(очікування: **9 файлів / 76 тестів**), обидві збірки, `security-gate:db` (`passed=3`) і `gate:upgrade:db`
(`passed=2`, 87 міграцій).

---

## 1. Межа цього середовища (чесно, до деталей)

`vitest` у цій пісочниці **не стартує взагалі**: Vite/esbuild піднімає сервіс-процес із **pipe**-stdio, а
sandbox це забороняє (`spawn EPERM` у `esbuild/lib/main.js`). Тому `security-gate`, `npm test`, `test:web`,
`security-gate:db` і `gate:upgrade:db` **не прогнані тут** — їх ескаловано проганяє власник (як і зазначено в
брифі). Щоб не залишати логіку неперевіреною, крок виміряно **власним харнесом** на власному type-stripping
Node (без vitest і без esbuild):

* `artifacts/r1a-verify/verify.ts` — **99** перевірок, що дзеркалять обидва нові набори (assert-хелпер +
  `check`);
* `artifacts/r1a-verify/guard-check.cjs` — дзеркало читачів guard-набору розміру гейта
  (`gateSuitesFromScript` + `documentedGateSizes`): `suites parsed = 155`,
  `claims = [["canonical","155"],["--list","155"],["suites","155"],["present","155"],["missing","0"]]`,
  `GUARD OK`, `ALL SUITE FILES EXIST` (**exit 0**);
* `artifacts/r1a-verify/loader.mjs` — резолвер extensionless-специфікаторів і підстановка
  `@npati/workspace` → стаб (справжній барель **eager**-реекспортує `.sql`-міграції, які вміє читати лише
  Vite-плагін, — це та сама причина, чому харнес попереднього кроку теж не імпортує барель);
* `artifacts/r1a-verify/workspace-stub.mjs` — стаб (`WorkspaceAccessError`, `WorkspaceNotFoundError`,
  `mountedFolderPathKey`, дві константи класифікації).

Запуск і результат:

```
node --experimental-transform-types --experimental-loader ./artifacts/r1a-verify/loader.mjs artifacts/r1a-verify/verify.ts
→ checks passed: 99 / ALL CHECKS PASSED     (node exit=0)
```

Каталог `artifacts/` — у `.gitignore` (рядок 14), тому ці файли **не** потрапляють у коміт; вони названі тут,
щоб їх можна було або повторити, або видалити. **Це не заміна vitest**: справжній вердикт — ескалований
`security-gate` (155 наборів) і `npm test` (10/15).

---

## 2. A1 — паралельність і rate limits за період

### A1.1 Періодичний ліміт запусків (окремий лімітер)

Новий модуль `apps/agent-api/src/code-run-rate-limit.ts`:

| Що | Де |
| --- | --- |
| R1-старт: **30** запусків/користувач/період, **120**/Company/період, період **1 год** | `code-run-rate-limit.ts:44` (`DEFAULT_CODE_RUN_RATE_LIMITS`) |
| env-ключі `NPATI_CODE_RUN_RATE_LIMIT_PER_USER_PER_PERIOD`, `…_PER_COMPANY_PER_PERIOD`, `…_PERIOD_MS` | `:61` (`resolveCodeRunRateLimits`) |
| стелі (1000 / 10000 / 24 год) — конфігурація може лише знижувати | `:51-56` |
| відмова `CodeRunRateLimitedError` (підклас `CodeRunRefusedError`, код `rate_limited`) з **власним** `retryAfterMs` | `:86-95` |
| віконний лічильник, два незалежні ключі (користувач + Company), `check`/`assertWithinLimit`/`record`/`state`/`cleanup` | `:130-227` |

**Чому окремий, а не `route-guard-tiers.ts`:** той обслуговує Company/Chat **HTTP-запити** за тарифом клієнта
з фіксованим вікном у 1 хвилину; запуск коду — не HTTP-запит, платить за нього Company, а зловживання — це
**сплеск запусків**, кожен з яких тримає sandbox і бюджет. `route-guard-tiers.ts` **не змінений і не
імпортований** у жодному новому файлі (перевірено `git status`).

**Код `rate_limited` доданий у `CodeRunRefusalCode`** (`code-run-queue.ts:99`) — саме для того, щоб наявні
маппінги (429 у чаті, таблиця статусів CLI) продовжували працювати без другого словника. CLI:
`code-cli-run-routes.ts:125` (`rate_limited: 429`) і `:129` (`ERROR_RETRYABLE`).

### A1.2 Паралельні sandbox 5/Company

`DEFAULT_SANDBOX_COMPANY_QUOTA.maxSandboxesPerCompany = 5` —
`sandbox-resource-quota.ts:61-67`, застосовується в `DockerSandboxProvider.createSandbox`
(`docker-sandbox-provider.ts:239`) **перед** будь-яким викликом Docker; env-ключ
`NPATI_SANDBOX_MAX_PER_COMPANY` (`:116`), стеля 64 (`:79`).

### A1.3 Паралельні run — механізм був, значення змінене **явно**

`DEFAULT_CODE_RUN_QUEUE_LIMITS.maxConcurrentPerCompany` 4 → **5** (`code-run-queue.ts:47-52`, коментар прямо
називає, що було 4). `maxConcurrentPerUser: 2` і `queueTimeoutMs: 120_000` **не змінювалися** — R1 стартує їх
саме з цих значень. Env-override `NPATI_CODE_RUN_MAX_CONCURRENT_PER_COMPANY` збережений, кламп до стелі 64.

---

## 3. A2 — бюджети: добові, на Company, і сповіщення 80 %/100 %

Усе — **через наявний** `A2AQuotaManager` (жодної другої системи обліку). Розширено
`apps/agent-api/src/code-run-quota.ts`:

| Що | Де |
| --- | --- |
| добові бюджети: **2 000 000** токенів/користувач/добу, **$20**; **10 000 000** токенів/Company/добу, **$100** | `code-run-quota.ts:73-84` (`DEFAULT_CODE_RUN_DAILY_BUDGET`) |
| env `NPATI_CODE_RUN_DAILY_MAX_TOKENS_PER_USER`, `…_COST_USD_PER_USER`, `…_TOKENS_PER_COMPANY`, `…_COST_USD_PER_COMPANY` + стелі | `:99-121`, `:90-91` |
| ключ добового бюджету містить **дату UTC** (`code-run-daily:<YYYY-MM-DD>:user:<id>` / `:company:<id>`) — нова доба = новий ключ, без таймера й без втрати після рестарту | `:220-228` |
| перевірка: сесійний бюджет → добовий користувача → добовий Company; зупинка з **явним** поясненням `A2A_DAILY_QUOTA_EXCEEDED: … (used/max tokens, $used/$max). The day's allowance resets at 00:00 UTC; …` | `:247-317` |
| облік у три ключі одразу | `:319-344` |
| сповіщення: `warning` при ≥ 80 %, `exhausted` при ≥ 100 %, **один раз на ключ і рівень**, для всіх трьох областей | `:356-387`, константа `CODE_RUN_BUDGET_WARNING_RATIO = 0.8` (`:145`) |
| перехід доби скидає «вже повідомлено», тому друга доба не глушиться першою | `:347-353` |
| слухач, що кидає, **не** змінює ні облік, ні вердикт | `:376-385` |

**Сповіщення — це запис у наявний канал Coding Agent, а не лог, що ротується:** `app.ts:5066-5098`
(`quota: new CodeRunSharedQuota(globalQuotaManager, { onThreshold: … })`) пише подію `run_activity` з
`event_type: "budget_threshold"` через **наявний** `codeActivitySink` + структурований `app.log.warn`.
Канали месенджерів свідомо **не** перевикористані: їхній перемикач має власний словник
(`automation`/`background_run`/`approval`), і надіслати бюджетне сповіщення під чужим перемикачем було б
неправдою; це записано в коментарі на місці.

Порт отримав **необов'язковий** п'ятий параметр `scope?: { userId?; companyId? }`
(`coding-agent-runner.ts:369`, `:371`); runner передає його в обох місцях (`:3725` — перед кожним викликом
моделі, `:3902` — після відповіді). Виклик без `scope` (уся попередня контрактна поведінка і тести C12)
працює **точно як до R1**.

Зупинка з поясненням — це наявний шлях `budget_exhausted`: вердикт `checkQuota` повертає `error`, а
`coding-agent-runner.ts:3726-3729` перетворює його на `stop("stopped", "budget_exhausted", "Stopped: …")`.

---

## 4. A3 — довжина черги, видимий стан, retry-after

* **Довжина черги: 50** — `code-run-queue.ts:51` (було 200; env `NPATI_CODE_RUN_QUEUE_MAX_DEPTH`, стеля 5000
  `:56`). Відмова — наявний `queue_full`-шлях: `CodeRunRefusedError` з текстом
  `The code run queue is full (N waiting)` (`code-run-queue.ts:197-201`), у HTTP — 429 + `retry-after`.
* **`CodeRunQueue.state()` нарешті має виклик**: новий read-only роут
  `GET /companies/:companyId/code/runs/queue` — `apps/agent-api/src/code-queue-status-routes.ts`
  (реєстрація в `app.ts:6223`). Дві властивості навмисні:
  1. **нічого не запускає і не змінює** — тому роут лишається доступним і при вимкнених флагах (як History /
     Activity / Export); потрібен лише `workspace:read`;
  2. **відповідь звужена до власної Company** — чиста функція `buildCodeQueueStatusView` (`:47-80`) фільтрує
     `state().queue`/`activePerCompany`/`activePerUser` до `companyId` виклику, тому сирий (deployment-wide)
     `state()`, який перелічує чужі `sessionId`, назовні не потрапляє. Додатково `:companyId` у шляху вже
     звіряється самим auth-провайдером (`auth.ts:241-242`).
* **UI:** мінімальна панель `apps/web/src/CodeQueuePanel.tsx` (стан черги, паралельність «ви / компанія»,
  лічильники періоду, черга цієї Company з позиціями й часом очікування), підключена в
  `apps/web/src/CodeSettingsPage.tsx:846` поруч із наявними панелями. Панель нічого не мутує.
* **Ротацію і retry-after не переробляв** — вони вже правильні (кругова ротація `code-run-queue.ts:371-390`,
  `retry-after` у `app.ts:7971-7981`). Єдине, що додано: **періодична** відмова повертає **власну оцінку вікна**
  (`CodeRunRateLimitedError.retryAfterMs`, `app.ts:7962-7978`), а не фіксований `queueTimeoutMs`.

---

## 5. A4 — ресурсні квоти sandbox, сумарна квота Company, host admission

Новий модуль `apps/agent-api/src/sandbox-resource-quota.ts`.

### 5.1 Ресурсні стелі — конфігуровані, R1-старт 2 vCPU / 4 ГБ / 10 ГБ / 512 pids

| Що | Де |
| --- | --- |
| `DEFAULT_SANDBOX_RESOURCE_LIMITS` = 2 / 4096 MB / 10 GiB / 512 | `sandbox-resource-quota.ts:53-59` |
| env `NPATI_SANDBOX_CPU`, `NPATI_SANDBOX_MEMORY` (Docker-форма), `NPATI_SANDBOX_MEMORY_MB` (цілі МБ, має приоритет), `NPATI_SANDBOX_DISK_BYTES`, `NPATI_SANDBOX_PIDS` | `:103-113` |
| парсер Docker-пам'яті (`4096m`/`4g`/`512k`) і зворотний `sandboxMemoryArg` | `:88-100` |
| **провайдер бере дефолти з цього модуля, а не з власних літералів** | `docker-sandbox-provider.ts:38-40` |

`docker-sandbox-provider.ts:26-29` (старі літерали `cpu:"1"`, `memory:"1536m"`, `diskBytes:1536*1024*1024`,
`pids:128`) замінені на `String(DEFAULT_SANDBOX_RESOURCE_LIMITS.cpu)`,
`sandboxMemoryArg(DEFAULT_SANDBOX_RESOURCE_LIMITS.memoryMb)`, `…diskBytes`, `…pids` — тобто **одне джерело
істини** для флагів контейнера і для сумарної квоти Company. Env-ключі задокументовані в `.env.example`
(новий блок `R1 (section A, item 4)`), а `docker-compose.dokploy.yml:187-195` (який досі **жорстко** пінив
`1 / 1536m / 128 / 1610612736` і тому мовчки перекривав дефолти коду — compose завжди виставляє змінну)
оновлений на ті самі R1-значення з тим самим `${VAR:-…}`-ідіомом.

### 5.2 Сумарна квота на Company

`SandboxCompanyQuota` (`:173-277`): `maxSandboxesPerCompany` + сумарні `cpu`/`memoryMb`/`diskBytes`/`pids`
(старт 5 / 10 / 20 480 MB / 50 GiB / 2560). `admit` **ідемпотентний** за `(companyId, projectId)` (бо
`ProjectSandboxService.ensure` повторює той самий проєкт), `release` ідемпотентний; у провайдера — admit у
`createSandbox` (`:239`) і release у `destroySandbox` (`:366`), **плюс** release у `catch` невдалого
створення (`:257`), щоб провал не з'їдав ємність назавжди. Env-ключі `NPATI_SANDBOX_MAX_PER_COMPANY`,
`…_MAX_CPU_PER_COMPANY`, `…_MAX_MEMORY_MB_PER_COMPANY`, `…_MAX_DISK_BYTES_PER_COMPANY`,
`…_MAX_PIDS_PER_COMPANY` зі стелями (`:79-84`).

### 5.3 Host admission — точний механізм

* **Умова:** відмова, якщо `cpuUsageRatio > 0.8` **або** `freeMemoryRatio < 0.15` (стартові значення
  `DEFAULT_HOST_ADMISSION_LIMITS`, `:279-283`); межі **виключні** (`:372-378`) — хост рівно на 80 %/15 %
  допускається. Env: `NPATI_HOST_ADMISSION_MAX_CPU_PERCENT` / `…_MIN_FREE_MEMORY_PERCENT` /
  `…_SAMPLE_TTL_MS` (`:288-306`); `0` — легальне (найсуворіше) значення, а не «не задано».
* **Вимірювання CPU:** `sampleHostLoad` (`:316-350`) бере **дельту** кумулятивних `os.cpus()` (`idle` проти
  суми `user+nice+sys+irq+idle`) між двома знімками; без придатного попереднього знімка — `os.loadavg()[0] /
  cpus.length`. Пам'ять — `os.freemem()/os.totalmem()`. Читання кешується на `sampleTtlMs` (старт 5 с,
  стеля 60 с), тому рішення не перечитує `/proc` на кожен виклик. Якщо `os.cpus()` не дає записів, CPU
  вважається 0 (пам'ять усе одно вирішує): «не можу виміряти» не перетворюється на «перевантажено» — це
  задокументована межа в коментарі.
* **Де саме застосовується:** `DockerSandboxProvider.createSandbox` — **перший** рядок тіла
  (`docker-sandbox-provider.ts:236`), до `admitImage` (`:243`) і до будь-якого `docker`-виклику. Провайдер
  створює контейнери лише в процесі sandbox-runner, і саме там він скомпонований
  (`sandbox-runner-server.ts:146-153`, передача 5-м/6-м аргументом `:199`).
* **Доказ, що він не торкається Company-ранів:**
  1. **джерельний** — `app.ts` **не містить** ні `HostAdmissionController`, ні `hostAdmission`, ні
     `SandboxCompanyQuota`, а `admissionGate` досі читає **лише** reaper
     (`app.ts:5269`: `{ isRefusingNewRuns: () => codeReaper.isRefusingNewRuns() }`);
     `resilience-admission-queue.ts` і `company-runtime.ts` не містять ні `HostAdmissionController`, ні
     `sandbox-resource-quota` (перевіряється в наборі `coding-agent-r1a-sandbox-quotas`);
  2. **поведінковий** — із перевантаженим `HostAdmissionController` черга Company (`AdaptiveAdmissionQueue`)
     продовжує приймати задачі: вона не отримує цей вердикт ні як порт, ні як залежність (той самий тест
     окремо пінить, що `admissionGate` в `app.ts` змін не зазнав);
  3. **структурний** — єдиний прод-виклик `new HostAdmissionController()` — у `sandbox-runner-server.ts`;
     `AdmissionError`/`admissionGate` (Company) і `SandboxQuotaError` (sandbox) — різні типи з різними
     статусами, і жоден шлях Company-рану не імпортує модуль квоти sandbox.

---

## 6. A5 — доказ, що квоти не обходяться (API / субагенти / Automations)

1. **Один вхід.** Новий `apps/agent-api/src/code-run-admission.ts` — єдина функція, що викликає
   `queue.acquire`. Обидва наявні входи переведені на неї: чат/Workspace SSE (`app.ts:7501` — до
   `reply.hijack()`, тому відмова ще може бути чесним HTTP 429; і `:7634-7635` — запасний шлях після hijack) і
   CLI/IDE (`app.ts:6137`). Порядок усередині: **періодичний** ліміт → черга; `record` виконується **лише
   після** реально виданого слоту, тому тікет, що вичерпався в черзі, не витрачає добовий/періодичний ліміт.
2. **Структурний доказ проти третього входу.** Набір читає `app.ts` як текст і вимагає **рівно нуль**
   входжень `codeRunQueue.acquire(` і **щонайменше три** використання `codeRunAdmission.(admit|canAdmit)(`.
   Тобто нова поверхня, що спробує взяти слот напряму, валить гейт; видалення спільних дверей — теж.
3. **Субагенти.** Делегований ран виконується **в тій самій сесії** (`budgetKey`), тому не карбує ні слота, ні
   бюджету: набір вимірює, що перший же `checkQuota` дитини відмовляється (`A2A_TOKEN_QUOTA_EXCEEDED`), а
   `getBudget("session-child")` — `undefined`; добовий ключ користувача при цьому бачить витрату батька.
   `code-subagent-child-runner.ts` не містить ні `code-run-admission`, ні `CodeRunQueue`.
4. **Automations.** Automation виконує **Company-ран** (`app.ts:~3400` `companyRuntime.execute`), а не код-ран;
   `company-runtime.ts` не містить ні дверей адмісії, ні черги код-ранів — тобто квоти код-рану для нього
   навіть не застосовні, а його власні ліміти (`AdmissionError`/`admissionGate`) не змінені жодним рядком.
5. **Ізоляція між Company** виміряна в обох половинах: періодичний лічильник (`rate isolates companies`),
   добові бюджети (`daily company refusal` + `daily isolation across tenants`), сумарна квота sandbox
   (`cap isolates companies`, `aggregate untouched after refusal`).

---

## 7. Невакуумність кожного нового guard-а (прибрати умову → тест падає)

| Guard | Прийом | Де в наборі |
| --- | --- | --- |
| періодичний ліміт | той самий набір `record`, ліміт 1 → відмова; ліміт 2 → допуск; далі знову відмова | `r1a-limits-and-quotas` → `is not vacuous: raising only the user allowance admits…` |
| єдині двері адмісії | видалити друге використання `codeRunAdmission.admit` або додати `codeRunQueue.acquire(` — точні лічильники падають | там же → `keeps the admission door single…` |
| добові бюджети | ліміт 100 → відмова; ліміт 200 при тій самій витраті → допуск | там же → `is not vacuous: raising only the daily allowance…` |
| пороги 80 %/100 % | 80 → `warning` рівно раз; 100 → `exhausted` рівно раз; друга доба → знову; відмова на перед-перевірці теж сповіщає | там же → два тести про пороги й `reports a pre-flight that is refused…` |
| tenant-скоуп роута стану | стан містить тікет **іншої** Company, а JSON відповіді його не містить; `state()` під шпигуном доводить, що роут читає живе джерело | там же → `projects the deployment-wide state onto one Company…` |
| сумарна квота Company | межа-в-межу допускається (6 vCPU / 12 288 MB), тісніша межа відмовляє з `memory 12288MB/12000MB`; «звільнена» квота знову допускає | `r1a-sandbox-quotas` → `refuses a sandbox that would exceed…`, `is not vacuous: a Company quota with room…` |
| host admission | 0.95 CPU → `cpu_overloaded`; 0.14 RAM → `memory_pressure`; **рівно** 0.8/0.15 → допуск (негативний контроль проти «відмовляти все»); `maxCpuUsageRatio: 1` → допуск | там же → `refuses above 80 % CPU…`, `is not vacuous: a controller whose ceiling cannot be crossed…` |
| порядок у провайдері | перевантажений хост дає `host_overloaded`, а не `sandbox_image_policy_unavailable`, який дає той самий провайдер без перевантаження — тобто саме ця умова змінила результат | там же → `refuses an overloaded host before any Docker work…` |
| звільнення ємності | провал створення → `quota.state().companies === []` (без `catch`-release слот лишився б) | там же → `releases the Company's capacity when a creation fails…` |

---

## 8. Що саме змінилося в дефолтах і чому це не зламало наявні піни

| Файл:рядок | Було | Стало | Чому не зламало |
| --- | --- | --- | --- |
| `code-run-queue.ts:49` | 4 | **5** | `tests/coding-agent-c10-run-queue.test.ts` порівнює `resolveCodeRunQueueLimits(nonsense)` з **експортованою константою** `DEFAULT_CODE_RUN_QUEUE_LIMITS` (рядок 102), а не з літералом 4; решта тестів передають власні ліміти явно. Літерал «5» у `c10-queue-round-robin` — параметр конструктора, не дефолт. |
| `code-run-queue.ts:51` | 200 | **50** | тест, що перевіряє глибину, створює `new CodeRunQueue({ …, maxQueueDepth: 1 })`/`2` явно (`:303`); клампований `enormous.maxQueueDepth < 1_000_000` лишається істинним. |
| `docker-sandbox-provider.ts:36-41` | `1 / 1536m / 1536 MiB / 128` | **2 / 4096m / 10 GiB / 512** | жоден наявний тест не пінить **дефолти** провайдера: усі, хто перевіряє `--pids-limit 128` / `--memory 1536m` / `size=1536*1024*1024` (`c14-redteam-fork-bomb:159-174`, `c14-redteam-resource-exhaustion:51-86`, `c1b-images:272-285`, `c15-mount-sandbox:46,88`), передають ці значення **аргументами** в `buildSandboxCreateArgs(...)`. Перевірено грепом `new DockerSandboxProvider` по `tests/`: усі виклики або без лімітів (перевіряють лише «не кидає»), або з явними проблемними значеннями (`pids: 0`, `cpu: "0"`, `diskBytes: 0/1/16_000_000-1`). |
| `sandbox-runner-server.ts:162-165` | `?? "1"`, `?? "1536m"`, `|| 1536*1024*1024`, `|| 128` | ті самі значення з `sandboxResourceLimits` | тестів, що читають ці літерали, немає (перевірено грепом). |
| `docker-compose.dokploy.yml:187-190` | `1 / 1536m / 128 / 1610612736` | **2 / 4096m / 512 / 10737418240** | `tests/architecture.test.ts` читає цей файл, але пінить інші рядки (health-check, ELO-флаг, Redis). |

**Одне наявне твердження оновлене явно** (не послаблене): `tests/coding-agent-c15-mount-sandbox.test.ts:449`
пінило підрядок `"runnerMountGate)"` у `sandbox-runner-server.ts`. Крок A4 додав **після** mount gate ще два
аргументи, тому підрядок з `)` зник. Твердження замінене на `"runnerMountGate, sandboxCompanyQuota,
hostAdmission)"` — сенс той самий (mount gate переданий позиційно), і воно **сильніше**, бо пінить і нові
залежності. Причина записана коментарем у самому тесті.

**Анкери мутаційних контролів не зсунулися**: `node scripts/mutation-controls-check.mjs` →
`rows=3 decoy=2 cosmetic=1 ok=true issues=0` (exit 0). Матриця прив'язана до
`code-shell-classifier.ts` і `code-tools-path.ts` — жоден із них кроком не змінювався.

---

## 9. Що додано в гейт і що оновлено в документі

* `scripts/lib/run-security-gate.mjs` — у `SECURITY_GATE_TESTS` додано **два** герметичні набори:
  `tests/coding-agent-r1a-limits-and-quotas.test.ts` і `tests/coding-agent-r1a-sandbox-quotas.test.ts`
  (з коментарем, що саме доводить кожен). Обидва — без Postgres, без Docker, без порту; жодного
  `.skip`/`.only`/`.todo`; тому вони саме в герметичному списку, а не в `SECURITY_GATE_DB_TESTS`.
* `tsconfig.tests.json` — обидва набори додані в `include` (правило репозиторію: новий набір входить у
  гейт **і** в type-gate одночасно); `npm run typecheck:tests` → exit 0.
* `docs/coding-agent/security-gate-report.md` — число наборів оновлено **явно** у трьох місцях, які читає
  guard-набір (`--list`-рядок, `suites=… present=… missing=…`, канонічне речення «Поточний розмір…»):
  було 153, стало **155**; додано блок-посилання на цей звіт.
* `node scripts/run-security-gate.mjs --list` → **155** рядків (збігається з документом).
* `tests/coding-agent-c15-mount-sandbox.test.ts:449` — оновлене твердження про аргументи runner-а (§ 8).

---

## 10. Чесні межі

* `security-gate`, `npm test`, `test:web`, обидві збірки й обидва DB-гейти тут **не прогнані** (спільна межа
  середовища, § 1); локальний доказ — **99** перевірок харнесом і чотири CLI-гейти (`typecheck`, `typecheck:tests`,
  `lint`, `migration-registry`, `mutation-controls`), усі exit 0.
* Періодичний ліміт і черга — **in-process**: на `N` репліках API можливо до `N × ліміт` запусків у вікні.
  Це та сама межа, яку `code-run-queue.ts:5-12` вже визнає для паралельності; спільний лічильник вимагав би
  Redis-потоку, який ця черга свідомо не використовує. Те, що крок справді гарантує: **всередині одного
  розгортання** жоден шлях не запускає код-ран повз єдину функцію адмісії.
* Сумарна квота sandbox і admit/release живуть у процесі sandbox-runner: перезапуск runner-а «забуває» вже
  створені контейнери (вони лишаються, але квота рахує з нуля). Це задокументовано коментарем біля
  `SandboxCompanyQuota`; повне усунення вимагало б реєстру живих sandbox, якого цей крок не вводить.
* Пороги host admission вимірюються на **хості runner-а**; на платформі без `os.cpus()`-записів CPU
  репортується як 0 (вирішує пам'ять) — свідомий вибір, щоб відсутній вимір не ставав відмовою всьому.
* Бюджетне сповіщення — це подія Activity (`run_activity` → `budget_threshold`) плюс структурований лог;
  месенджер-канали не перевикористані (причина в § 3).
