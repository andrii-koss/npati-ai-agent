# План рефакторингу великих файлів — NPATI Agent

> **Призначення.** Покроковий план (1 крок = 1 файл), який доводить усі завеликі файли проєкту до керованого розміру, після чого їх можна читати й редагувати цілком — і людиною, і агентом.
>
> **Статус:** план + чекліст виконання. Позначай `[x]` одразу після завершення кроку.
>
> Baseline заміряно: **2026-10-10**, гілка `main`, HEAD `4c12892`, робоче дерево брудне (35 змінених + 10 untracked).

---

## 0. Як користуватися цим документом

1. Крок = **один файл** + **один коміт**. Не об'єднуй два файли в один крок і не змішуй рефакторинг зі зміною поведінки.
2. Перед кроком прочитай його блок: «шви» (межі розділення), цільові модулі, ризики.
3. **Обов'язково** переглянь розділ 4 — перехресні guard-и, які ламає будь-яке переміщення коду. Це не теорія: 6 тестів і 2 сканери читають конкретні файли як **текст**.
4. Виконуй **стандартний цикл кроку** (розділ 5) — він однаковий для всіх кроків.
5. Після кроку: `[ ]` → `[x]` + рядок у Журналі (розділ 15).

---

## 1. Baseline: що маємо на старті

Замір по `apps/`, `packages/`, `scripts/`, `tests/` (без `node_modules`, `.git`, `dist`, `build`, `vendor`, `.npati-data`):

| Поріг | Файлів |
|---|---:|
| ≥ 5000 рядків | 6 |
| ≥ 3000 рядків | 11 |
| ≥ 2000 рядків | 27 |
| ≥ 1500 рядків | 34 |
| ≥ 1000 рядків | 56 |
| ≥ 800 рядків | 85 |
| ≥ 500 рядків | 187 |

Найгірші п'ять:

| Рядків | Розмір | Файл |
|---:|---:|---|
| 21 754 | 426 KB | `apps/web/src/styles.css` |
| 8 441 | 521 KB | `apps/agent-api/src/app.ts` |
| 7 283 | 215 KB | `packages/shared/src/capability-catalog.ts` |
| 5 025 | 299 KB | `packages/workspace/src/postgres-store.ts` |
| 4 861 | 131 KB | `packages/shared/src/capability-matrix.ts` |

### Чому це проблема

- Файл на 8000 рядків не входить у робочий контекст агента цілком → агент редагує «наосліп» і робить регресії.
- Один збій у такому файлі = повний rollback великого обсягу роботи.
- Два агенти не можуть паралельно працювати в одному файлі — постійні конфлікти.
- Дифф на 8000 рядків неможливо якісно рев'ювити.
- Повільніший typecheck/IDE, вищий ризик випадкових циклічних імпортів.

---

## 2. Цільові ліміти та визначення «готово»

| Тип файлу | М'яка ціль | Жорсткий ліміт |
|---|---:|---:|
| Звичайний модуль (утиліти, сервіс, типи) | ≤ 300 | **600** |
| Роутер на домен (Fastify) | ≤ 400 | **800** |
| React-сторінка / великий компонент | ≤ 500 | **800** |
| React-підкомпонент, панель, модалка | ≤ 250 | **400** |
| CSS-модуль | ≤ 600 | **800** |
| Тестовий файл | ≤ 500 | **800** |
| **Словник локалі (`i18n/locales/*.ts`)** | — | **виключення, див. Рішення D1** |

> Ліміти застосовуються до `apps/`, `packages/`, `scripts/`, `tests/`. Тека `docs/` — виключена: це документація, а не код (цей план теж довший за 800 рядків, і це нормально).

**Definition of Done:**

1. Жоден файл у `apps/`, `packages/`, `scripts/`, `tests/` не перевищує **800 рядків** — крім 7 словників локалей, якщо Рішення D1 = «лишити як є».
2. Публічні API не змінені: `buildApp(config)`, інтерфейс `WorkspaceStore`, барель-експорти `@npati/shared` / `@npati/workspace` / `@npati/omniroute-adapter`.
3. `npm run typecheck` і `npm run lint` — зелені. Набір падаючих тестів не гірший за `known-failures.json`.
4. `npm run build` проходить; для CSS/UI-кроків ключові сторінки візуально ідентичні.
5. Guard-скрипт (Додаток B) у CI не дає файлам знову вирости.
6. Жоден перехресний guard з розділу 4 не обійдений «тихо» — кожна зміна текстового контракту оформлена явно в тому ж коміті.

---

## 3. Передумови (виконати ДО кроку 1)

> ⚠️ **Робоче дерево брудне:** 35 змінених і 10 untracked файлів, серед яких `apps/agent-api/src/app.ts`, `code-tool-runtime.ts`, `coding-agent-runner.ts`. Починати поверх цього **не можна** — неможливо відрізнити регресію рефакторингу від незавершеної роботи.

- [ ] **P1.** Закомітити або застосувати (`git stash`) 45 змін. Дерево мусить бути чистим.
- [ ] **P2.** `git tag refactor-baseline`.
- [ ] **P3.** Baseline тестів: `npm run typecheck`, `npm test`, `npm run test:known-failures` → артефакти в `artifacts/`.
- [ ] **P4.** `git switch -c refactor/large-files`.
- [ ] **P5.** Guard-скрипт (Додаток B) + `file-size-baseline.json`.
- [ ] **P6.** Скрипти в `package.json`: `"size:check"`, `"size:report"`.
- [ ] **P7.** Винести з репо `artifacts/minio-local-rootfs.tar` (**168 MB**) і додати в `.gitignore`.

### Стан середовища на 2026-10-10 (важливо для виконання)

- **`pwsh` у цій сесії не має прав на запис у робочий простір**, хоч політика сесії — `workspace-write`: створення теки, створення файлу й перезапис наявного файлу падають з відмовою. Файлові інструменти (`write`/`edit`) працюють нормально.
  Діагностика за скілом `diagnose-windows-sandbox-acl` полагодила права на `apps`, `apps/web`, `apps/web/src` і `apps/web/src/styles` (**4 зміни, усі перевірені**, бекапи й команди відкату — у `C:\Users\hostk\npati-acl-diagnosis\`), але **запис для `pwsh` усе одно лишається закритим**.
  **Наслідок:** кожен крок, який пише файли через `pwsh` (а всі кроки такі — потрібне масове переміщення коду), потребує **одноразового розширеного доступу з підтвердженням користувача**. Альтернатива — перевести сесію в режим повного доступу.
- **`core.autocrlf = true`:** канонічний вміст у git — LF, робоча копія — CRLF. **Хеші рахувати тільки по канонічному (LF) вмісту**, інакше отримаєш хибну розбіжність (перевірено на кроці 1).
- **PowerShell і stderr:** `2>&1` разом з `$ErrorActionPreference = "Stop"` перетворює будь-яке попередження сторонньої програми (напр. `vite` про `node:crypto`) на помилку, яка обриває скрипт. Для збірок використовувати `$ErrorActionPreference = "Continue"` + `$PSNativeCommandUseErrorActionPreference = $false` і перевіряти `$LASTEXITCODE`.
- **Оновлено (після кроку 1):** сесію переведено в **повний доступ** (`danger-full-access`), тому підтвердження на кожну команду більше не потрібні. Механізм ACL-грантів, описаний вище, лишається в силі лише для режиму `workspace-write`: там запис дозволений тільки в теках, яким скрипт діагностики видав повний доступ (він додає його **на конкретну теку**, а не на все піддерево).
- **Знайдений борг репозиторію (baseline P3):** `tests/agent-api.test.ts` має **1 падаючий тест** (`expect(second.body).toContain("omniroute-roadmap_edited.xlsx")` у сценарії редагування таблиці), якого **немає** в `known-failures.json`. Доведено A/B-прогоном: тест падає **однаково** і на закоміченому `app.ts` без змін рефакторингу. Це не регресія кроків 1–2a, але це або борг, який треба внести в `known-failures.json`, або дефект, який треба полагодити.

---

## 4. Перехресні guard-и: що ламається від переміщення коду

Це найважливіший розділ плану. Проєкт має **текстові контракти**: тести й сканери читають вихідні файли як рядки. Будь-яке переміщення коду з цих файлів ламає перевірки — і падає не typecheck, а `npm run lint` / тести.

| # | Guard | Що саме перевіряє | Що робити |
|---|---|---|---|
| G1 | `scripts/lib/scan-web-xss.mjs` (allowlist L35–82, enforcement L151–185) | **шлях + точна кількість** небезпечних патернів на файл (`dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function(`); обхід усього `apps/web/src` | при перенесенні коду з такими патернами **у тому ж коміті** оновити allowlist: перенести запис на новий шлях і поправити `occurrences` |
| G2 | `scripts/lint-baseline.json` | «заморожена» кількість `as any` **на кожен файл**; новий файл з `as any` = падіння `npm run lint` | після кроку `node scripts/lint-guard.mjs --update-baseline`, дельту — в коміт |
| G3 | `tests/coding-agent-c10-run-request.test.ts` L400 | `readFileSync("packages/workspace/src/postgres-store.ts")` | зберегти перевірене в `postgres-store.ts` або оновити тест у тому ж коміті |
| G4 | `tests/coding-agent-c10-session-durability.test.ts` L228, L282 | L228 — реєстрація міграції `082_…` у `postgres-store.ts`; L282 — **негативна** перевірка 7 назв методів у `types.ts` | L228: код реєстрації лишити в файлі; L282 переживає розділення |
| G5 | `tests/coding-agent-c12-subagent-activity-tree.test.ts` L86, L102 | L86 — реєстрація міграції `084`; L102 — **точна regex-перевірка списку колонок** `parent_run_id AS "parentRunId", …` + мапер рядка | SQL-константу з аліасами лишити в `postgres-store.ts` або оновити тест |
| G6 | `tests/coding-agent-c15-mounted-workspace.test.ts` L539 | `readFileSync("packages/workspace/src/postgres-store.ts")` | як G3 |
| G7 | `tests/durable-memory-features.test.ts` L37–38 | regex по **тексту** `capability-matrix.ts`, який **перетинає два записи**: `"capabilityId": "research.fts5_keyword_search" … "status": "NOT_IMPLEMENTED"` | обидва записи мають лишитися в **одному** файлі, або тест оновити |
| G8 | `tests/coding-agent-c14-model-profile-fallback.test.ts` L328–336 | `toContain("modelProfiles: {")` у `i18n/types.ts` **і** в кожному з 7 словників локалей; також `emptyHint:` і `{{count}}` | літерал `modelProfiles: {` мусить лишитися досяжним саме у `i18n/types.ts` (простий `export type … from` цього **не** задовольняє) — або оновити тест свідомо |
| G9 | `scripts/revalidate-306-capabilities.mjs` L11–23 | regex + `eval` по **тексту** `capability-matrix.ts` (`export const CAPABILITY_MATRIX: CapabilityMatrixEntry[] = ([...]);`) і `tool-test-matrix.ts` (`TOOL_TEST_MATRIX`) | спершу перевести скрипт на імпорт модулів (як зроблено в `verify-capability-matrix.mjs`), потім розділяти файли. Знімає проблему одразу для кроків 5 і 37 |
| G10 | `packages/workspace/package.json` (`"exports": "./src/index.ts"`) + `index.ts` (`export * from …`) | публічна поверхня пакета = **усі** експорти `types.ts`, `in-memory-store.ts`, `postgres-store.ts` | барель мусить експортувати ті самі імена; `WorkspaceStore` (types.ts L1648–2140) лишається незмінним — у `app.ts` 296 посилань на нього |

**Правило:** якщо крок торкається файлу з таблиці вище — у блоці кроку є відповідне попередження, а в коміті — явна правка guard-а. «Тихо» обійти не можна.

### 4.1 Точні цифри G2 (`as any` у `scripts/lint-baseline.json`)

Заморожені ліміти для файлів цього плану. Під час розділення код з `as any` переїжджає в **новий** файл → guard бачить новий файл з кастами і падає. Після кроку: `node scripts/lint-guard.mjs --update-baseline`, дельту — в коміт (це рев'ювана зміна, не «обхід»).

| `as any` | Файл | Крок |
|---:|---|---|
| 12 | `apps/agent-api/src/app.ts` | 2 |
| 10 | `apps/web/src/WebsiteEditor.tsx` | 7 |
| 10 | `apps/agent-api/src/reliability-and-operations-routes.ts` | 22 |
| 7 | `apps/agent-api/src/multimodal-routes.ts` | 20 |
| 5 | `apps/web/src/BusinessWorkspace.tsx` | 24 |
| 5 | `apps/agent-api/src/company-runtime.ts` | 21 |
| 3 | `apps/agent-api/src/email-routes.ts` | 19 |
| 3 | `apps/web/src/EmailInboxPage.tsx` | 25 |
| 3 | `apps/web/src/WebsiteBuilderDashboard.tsx` | 31 |
| 3 | `apps/web/src/DataStudioPage.tsx` | 26 |
| 2 | `apps/agent-api/src/email-inbox-repository.ts` | 13 |
| 2 | `apps/web/src/IntegrationsPage.tsx` | 30 |
| 2 | `apps/web/src/EmailSettingsPage.tsx` | 8 |
| 1 | `packages/shared/src/code-capabilities.ts` | 3 |
| 1 | `apps/web/src/ActivityPage.tsx` | 36 |
| 1 | `apps/web/src/i18n/providerDescriptions.ts` | 46 |
| 1 | `apps/agent-api/src/coding-agent-runner.ts` | 6 |

Решта 20 файлів плану в baseline відсутні — для них будь-який новий `as any` = падіння лінта (і це бажано: не додавай кастів під час переміщення).

### 4.2 Точні цифри G1 (XSS-allowlist)

| Файл | Патерн | Дозволено | Крок |
|---|---|---:|---|
| `apps/web/src/CompanyPage.tsx` | `dangerouslySetInnerHTML` | 2 | 32 |
| `apps/web/src/ChatMessageContent.tsx` | `dangerouslySetInnerHTML` | 2 | 35 |
| `apps/web/src/ChatMessageContent.tsx` | `innerHTML` | 8 | 35 |
| `apps/web/src/EmailInboxPage.tsx` | `dangerouslySetInnerHTML` | 1 | 25 |
| `apps/web/src/EmailInboxPage.tsx` | `innerHTML` | 1 | 25 |
| `apps/web/src/AIProviderMarketplace.tsx` | `attr:template-src` | 1 | — (741 рядок, нижче порогу 800; у план не входить, але запис у allowlist існує) |
| `apps/web/src/ProjectPage.tsx` | `attr:template-src` | 1 | 29 |

> Переносиш код із цими патернами в новий файл — перенеси й **запис allowlist** (новий шлях + правильний `occurrences` + `reason`) у тому ж коміті.

### 4.3 Текстові контракти конкретних файлів (перевірено)

Це тести, які читають **текст конкретного файлу** й вимагають певних рядків або порядку. Ці рядки **не можна** виносити, інакше падають тести, а не компілятор.

| Файл | Тест | Що мусить залишитись у файлі |
|---|---|---|
| `apps/agent-api/src/project-git-service.ts` | `tests/coding-agent-c15-mount-sandbox.test.ts:437–441` | **НЕ** містити `path.join(this.workspaceRoot`; **містити** `await this.bases.resolve(ctx, companyId, projectId)` і `"MOUNTED_FOLDER_READ_ONLY"` → метод `resolveProjectWorkspace` (L318–372) лишається на місці |
| `apps/agent-api/src/app.ts` | `tests/coding-agent-c15-mount-sandbox.test.ts:425–440` | рівно **одне** входження `path.join(config.dataDirectory ?? ".data", "project-workspaces")`; `new ProjectWorkspaceBaseResolver({`; `new MountedWorkspaceProvider(projectService`; regex `projectGitService = new ProjectGitService(… projectWorkspaceBases,`; `workspaceStore.getProjectMountedFolder(ctx, companyId, projectId)`; `mountedFolderFlags = featureFlagService` → **увесь блок «одного канонічного workspace» лишається в `app.ts`** (перевірено відкатом 2b-4) |
| `apps/agent-api/src/code-tool-executors.ts` | `tests/coding-agent-c12-subagent-workflow.test.ts:781–783` | `...canonicalSubagentExecutors(options)` і `"code.agent.spawn": createCodeAgentSpawnExecutor(` → обидві агрегатні мапи (`allCanonicalExecutors` L960–982, `canonicalExecutors` L1175–1263) лишаються |
| `apps/agent-api/src/company-runtime.ts` | `tests/advanced-memory-production.test.ts:22–27` | **порядок у тому самому файлі:** `indexOf("const actionPlanningContext") < indexOf("const planningRequest")`; плюс рядки `"Mandatory action-sensitive rules"` і `plan.toolRequests.map(request=>request.tool)` — усе це всередині `process` (L276–615) |
| `apps/agent-api/src/company-runtime.ts` | `tests/coding-agent-r1a-limits-and-quotas.test.ts:323–329`, `tests/coding-agent-r1a-sandbox-quotas.test.ts:323–331` | **не** містити `code-run-admission`, `CodeRunQueue`, `codeRunQueue`, `host_admission`, `HostAdmissionController`, `sandbox-resource-quota` (перевірка **per-file** — новий модуль може порушити її непомітно) |
| `apps/agent-api/src/code-policy-engine.ts` | `tests/coding-agent-c14-policy-phase-and-gate-size-guard.test.ts:41–53` | union `PolicyPhase`; **точний підпис** `private async evaluateInternal(request: PolicyRequest): Promise<PolicyResult>`; тіло цього методу > 5 000 символів і містить `MODE_RISK_MATRIX`; коментар `Phase order is fixed` |
| `apps/agent-api/src/code-policy-engine.ts` | `tests/coding-agent-c13-hooks.test.ts:658–666` | інтерфейс `PolicyRequest` **не** має члена з `/hook/i`; файл **не** містить `code-hooks` |
| `apps/web/src/App.tsx` | `tests/npati-backend-auth.test.ts:155–178` | `resolveNpatiAvatarUrl(user?.avatar)`, `<img src={avatarUrl}`, `user?.firstName`, `user?.lastName`, `<small>{email}</small>` (це `ChatUserMenu` L80–163); **не** містити `"Disconnect account"` |
| `apps/web/src/App.tsx` | `tests/runtime-compat-capabilities.test.ts:51–53` | `path="/chat"` і точний рядок `<Navigate to="/settings/connections" replace />` |
| `apps/web/src/ProjectPage.tsx` | `tests/coding-agent-c7-project-files-adapter.test.ts:132–136` | містити `./project-files-client` і **не** мати file-URL патерну |
| `apps/web/src/WebsiteBuilderDashboard.tsx` | `tests/coding-agent-c7-project-files-adapter.test.ts:138–139` | містити `"/settings/code/"` |
| `scripts/lib/run-security-gate.mjs` | `scripts/lib/mutation-controls-check.mjs:288` (+ `:42`, `:305`), `tests/coding-agent-c14-policy-phase-and-gate-size-guard.test.ts:57`, `:223`, `:364–380` | літерал `export const SECURITY_GATE_TESTS = [` **саме в цьому файлі** (парситься текстом) |
| `scripts/lib/run-security-gate.mjs` | `tests/coding-agent-g1-clean-clone-prerequisites.test.ts:204–213` | `export function prepareTyposquatDataset(`, `'const TYPOSQUAT_GENERATOR_PATH = …;'`, `[generator, "--root", root]`, `runStep("typosquat dataset guard", …)` |
| `scripts/lib/run-security-gate.mjs` | `scripts/security-gate-mutation-branch.mjs:586`, `:595` + `tests/coding-agent-c14-mutation-branch-controls.test.ts:633` | `GATE_ARTIFACT_PATH`, `DB_GATE_ARTIFACT_PATH` як точні рядки |
| `scripts/security-gate-mutation-branch.mjs` | `tests/coding-agent-c14-mutation-branch-controls.test.ts:489–491`, `:564–576`, `:738–741` | `failureTitleMatches(entry.title, expectedTest)` (**не** `entry.title === expectedTest`), `BASELINE RED`, `observeGateRun({`, речення про non-equivalent environment, `writeGateTranscript(ROOT, "baseline", baselineRun.transcript)`, `writeGateTranscript(ROOT, row.id, run.transcript)`, `transcript: baselineTranscript` |
| `packages/shared/src/tool-test-matrix.ts` | `scripts/revalidate-306-capabilities.mjs:20–23` | `export const TOOL_TEST_MATRIX: ToolTestMatrixEntry[] = (\[...\]);` як **один літерал** (regex + `eval`) |

### 4.4 `SECURITY_GATE_TESTS` і `GATE_SIZE` — пастка при розділенні тестів

Три тести з плану мають різну ціну розділення, і це не видно з коду:

| Тест | У `SECURITY_GATE_TESTS`? | Наслідок розділення |
|---|---|---|
| `tests/data-studio-project-auth.test.ts` | **ні** | розділяти вільно |
| `tests/coding-agent-c13-mcp-run-path.test.ts` | **так** (`run-security-gate.mjs:720`) | нові імена файлів треба **додати в список** → змінюється `GATE_SIZE` → треба оновити `docs/coding-agent/security-gate-report.md` (її числа пінять `c14-policy-phase-and-gate-size-guard.test.ts:251–261`, `:364–380`) + `tsconfig.tests.json` (явний список) |
| `tests/coding-agent-c6-eval.test.ts` | **так** (`run-security-gate.mjs:146`) + названий у `package.json` `eval:smoke` | шлях мусить лишитися **реальним сьютом**: «обгортка без тестів» не працює — файл із нульовими тестами валить `findEmptySuites`/`findMissingSuites` (`run-security-gate.mjs:1008–1022`) |

> Для тестів «залишити старий файл як ре-експорт» **неможливо** — на відміну від звичайних модулів.

---

## 5. Інваріанти (що заборонено ламати)

1. **Тільки переміщення коду.** У коміті рефакторингу не змінюй логіку, назви публічних символів, порядок побічних ефектів, формат даних.
2. **Публічний API стабільний.** Якщо модуль імпортується ззовні — лишай тонкий `index.ts` (barrel) з тими самими експортами.
3. **Оновлення залежностей, форматування, перейменування** — окремі задачі, не тут.
4. **Два бекенди змінюються разом.** `postgres-store.ts` та `in-memory-store.ts` реалізують один `WorkspaceStore` — однакове доменне розділення в обох, інакше вони розійдуться назавжди.
5. **CSS: порядок = поведінка.** Розбивати `styles.css` тільки на **суміжні** діапазони рядків і підключати у вихідному порядку.
6. **Генеровані файли правляться в генераторі,** а не в результаті.
7. **i18n-локалі — окреме рішення** (Рішення D1). Розділення однієї локалі без шести інших руйнує структурний паритет, який є єдиною гарантією консистентності.
8. **Тести не реформуємо.** При розділенні тестового файлу зберігай назви `describe`/`it` і спільні фікстури.
9. **Один крок = один коміт = один revert.**

---

## 6. Стандартний цикл одного кроку (9 фаз)

**Фаза 0 — Baseline кроку**
```powershell
$f = "шлях\до\файлу"; (Get-Content $f).Count
git rev-parse HEAD
```
Записати, які тести покривають цей файл, і прогнати їх **до** змін.

**Фаза 1 — Інвентаризація.** Карта файлу (імпорти, декларації, експорти) + список усіх, хто його імпортує.

**Фаза 2 — Вибір шва.** Межа мусить бути **суміжною** і з низьким зв'язуванням. Не розрізай функцію навпіл. Якщо шва немає — спочатку введи його (окремий під-крок).

**Фаза 3 — Механічне переміщення.** Створити файли, перенести блоки **без змін**, додати `export`, зробити barrel. Старі шляхи імпорту працюють як раніше.

**Фаза 4 — Імпорти й компіляція.** `npm run typecheck` — він показує всі місця, які треба доправити.

**Фаза 5 — Верифікація**
```powershell
npm run lint                     # scan-web-xss + lint-guard (див. розділ 4!)
npx vitest run <цільові тести>
npm run test:known-failures
npm run size:report
```
Для `packages/shared`: ще `npm run audit:capabilities`, `npm run audit:code-tools`, `npm run revalidate:306`.
Для `apps/web`: ще `npm run build --workspace @npati/web`, `npm run test:web`.

**Фаза 6 — Прибирання.** Прибрати дублювання й мертві імпорти. Barrel — лише там, де є зовнішні споживачі.

**Фаза 7 — Замір після.** `npm run size:report` — жоден новий файл не > ліміту.

**Фаза 8 — Коміт.**
```
refactor(<scope>): split <file> into <N> modules (step <N>)
```

> **Супутні правки, які крок тягне за собою** (бюджетувати одразу, див. розділ 4):
> - файл під `apps/*/src` або `packages/*/src` і в ньому є `as any` → `node scripts/lint-guard.mjs --update-baseline`, дельту — в коміт;
> - файл під `apps/web/src` і код із `dangerouslySetInnerHTML`/`innerHTML`/`attr:template-src` переїжджає → перенести запис у `scripts/lib/scan-web-xss.mjs` (новий шлях + точна кількість) і `npm run lint`;
> - додано/перейменовано сюїт із `SECURITY_GATE_TESTS` → оновити список у `scripts/lib/run-security-gate.mjs`, числа в `docs/coding-agent/security-gate-report.md` і явний `include` у `tsconfig.tests.json`;
> - переміщено рядок, який пінить текстовий тест (розділ 4.3) → оновити той тест **у тому ж коміті**, окремим рядком у його описі.

**Фаза 9 — Оновлення доку.** `[x]` + рядок у Журналі (розділ 15).

**Rollback:** `git revert <sha>`.

---

## 7. Черговість: огляд

Порядок **не** «просто за розміром»: він враховує залежності та текстові контракти (розділ 4).

| Фаза | Зміст | Кроки | Файлів |
|---|---|---|---:|---:|
| 0 | Інфраструктура: чисте дерево, guard, baseline | P1–P7 | — |
| 1 | Найбільші файли з низьким зв'язуванням | 1–8 | 8 (**1 ✓**) |
| 2 | Шар `workspace` (найризикованіший, робиться разом) | 9–12 | 4 |
| 3 | `agent-api`: репозиторії, сервіси, роутери ≥ 1000 | 13–22 | 10 |
| 4 | `apps/web` + `i18n` ≥ 1000 | 23–36 | 14 |
| 5 | Спільні пакети: схеми й матриці ≥ 800 | 37–40 | 4 |
| 6 | Скрипти гейтів (**низька віддача** — можна відкласти) | 41–42 | 2 |
| 7 | Тести ≥ 1000 | 43–45 | 3 |
| 8 | Решта 800–999 | 46–69 | 24 |

**Чому `postgres-store.ts` (4-й за розміром) не в Фазі 1:** він пов'язаний одним інтерфейсом з `types.ts` і `in-memory-store.ts`, а три тести читають його як текст (G3–G6). Розділяти ці три файли нарізно = гарантований дрейф бекендів і зламані текстові тести.

**Про порядок кроку 2 (`app.ts`) і кроків 19 / 20 / 22 (роутери).** Усі три реєстратори (`registerEmailInboxRoutes` `app.ts:294→:7064`, `registerMultimodalRoutes` `:256→:7072`, `registerReliabilityAndOperationsRoutes` `:247→:7069`) імпортуються й викликаються **рівно один раз** — тому їхній розділ **не змінює `app.ts`** (лише робить кожну функцію тонким композитором під-реєстраторів). Наслідки:
- порядок довільний: крок 2 можна робити першим, переносячи виклики **дослівно**;
- **вигідно** зробити 19/20/22 **раніше** за крок 2 — тоді `app.ts` бачить три маленькі реєстратори замість трьох монолітів по 1 000+ рядків;
- **єдине, що мусить лишитися незмінним**, — `globalAdmissionQueue`: його імпортує `app.ts:247` і використовує `app.ts:967`, тому він лишається досяжним за шляхом `reliability-and-operations-routes.ts` (переїзд — тільки разом із тими двома рядками). Так само `SUPPORTED_PROVIDERS` лишається реекспортованим з `multimodal-routes.ts` (`tests/production-p12-multimodal.test.ts:24` імпортує його звідси).

### Рішення D1 — 7 словників локалей (`fr/es/it/en/de/uk/pl`, 2573–2749 рядків)

**Рекомендація: НЕ розділяти.** Обґрунтування:

- Вони **не генеровані**: жоден скрипт репозиторію їх не пише, заголовка «do not edit» немає, цілі `i18n` у кореневому `package.json` немає (усі `generate-locales.mjs` лежать у `vendor/omniroute`). Отже, розділення = 7 × N файлів ручної правки.
- Усі сім мають **однаковий набір із 25 неймспейсів** — це структурний паритет, і він і є єдиною гарантією, що ключ не загубиться.
- `t()` приймає **рядковий** dotted-ключ, тож файли-по-неймспейсах не дають жодної додаткової типізації.
- `tests/coding-agent-c14-model-profile-fallback.test.ts` L331–336 читає **всі сім** файлів як текст (G8).
- Словники — це дані з низькою частотою змін; вони не заважають агенту так, як `app.ts`.

**Правильна альтернатива:** розділити не словники, а **`apps/web/src/i18n/types.ts`** (2609-рядковий монолітний `interface TranslationSchema`) на `i18n/schema/` по неймспейсах, лишивши `types.ts` як shim. Це крок 23.

**Якщо все ж розділяти локалі** — тільки механічно, усі 7 атомарно, з правкою G8 у тому ж коміті; і окремим Рішенням поза цим планом.

---

## 8. Фаза 1 — найбільші файли з низьким зв'язуванням (кроки 1–8)

| # | Файл | Рядків | Стан |
|---|---|---:|---|
| 1 | `apps/web/src/styles.css` | 21 754 | [x] |
| 2 | `apps/agent-api/src/app.ts` | 8 449 → **5 628** | [~] 2a, 2b-1…2b-3, 2c-1…2c-4 ✓ |
| 3 | `packages/shared/src/code-capabilities.ts` | 4 079 | [ ] |
| 4 | `packages/shared/src/capability-catalog.ts` | 7 283 | [ ] |
| 5 | `packages/shared/src/capability-matrix.ts` | 4 861 | [ ] |
| 6 | `apps/agent-api/src/coding-agent-runner.ts` | 4 802 | [ ] |
| 7 | `apps/web/src/WebsiteEditor.tsx` | 4 126 | [ ] |
| 8 | `apps/web/src/EmailSettingsPage.tsx` | 2 923 | [ ] |

> Крок 3 (`code-capabilities`) стоїть перед 4–5, бо його матриці (`CODE_*_MATRIX`, `CODE_*_CAPABILITIES`) імпортуються і каталогом, і матрицею: спочатку стабілізуємо листовий модуль, потім агрегатори.

### [x] Крок 1 — `apps/web/src/styles.css` (21 754 → 28 модулів ≤ 800) ✅ виконано

**Чому перший.** Найбільший файл проєкту (426 KB) і найбезпечніший: чистий CSS без логіки.

**Факти.** CSS-змінні живуть у `@npati/branding/theme.css`; `styles.css` імпортується **рівно один раз** — `apps/web/src/main.tsx` рядок 10. Отже схема підключення безпечна, якщо зберегти порядок.

**⚠️ УРОК, ЗДОБУТИЙ НА ЦЬОМУ КРОЦІ (обов'язковий для всіх CSS-кроків).**
Початковий план різав файл по **рядках коментарів-секцій**. Це дало побайтово точну суму модулів, але **зламало збірку**: `postcss-import: 02-*.css: Unclosed block` — межа впала всередину CSS-правила, а кожен модуль мусить бути валідним CSS **сам по собі** (postcss парсить його окремо, до інлайну).
**Правильне правило:** різати лише там, де закрито блок верхнього рівня — тобто після рядка, у якого `Trim() -eq '}'` і глибина вкладеності дорівнює 0. Глибину рахувати з урахуванням коментарів і рядкових літералів.

**ЯК ЗРОБЛЕНО.** 28 **суміжних** модулів ≤ 800 рядків, межі — на закриваючих `}` верхнього рівня (2710 безпечних точок розрізу в оригіналі). Файл замінено на 39-рядковий entry з `@import` у вихідному порядку; `main.tsx` **не змінювався**.

| Модуль (`apps/web/src/styles/`) | Рядки вихідного | Рядків |
|---|---|---:|
| `01-base-and-shell.css` | 1–799 | 799 |
| `02-toasts-and-buttons.css` | 800–1592 | 793 |
| `03-buttons.css` | 1593–2390 | 798 |
| `04-buttons-and-notice-modal.css` | 2391–3185 | 795 |
| `05-notice-modal-and-skills.css` | 3186–3981 | 796 |
| `06-skills-catalog.css` | 3982–4777 | 796 |
| `07-skills-and-dropdowns.css` | 4778–5574 | 797 |
| `08-chat-bubbles.css` | 5575–6238 | 664 |
| `09-chat-and-company-config.css` | 6239–7032 | 794 |
| `10-company-config.css` | 7033–7832 | 800 |
| `11-company-cards.css` | 7833–8628 | 796 |
| `12-auth-and-capability-inspector.css` | 8629–9425 | 797 |
| `13-activity-and-dispatch.css` | 9426–10225 | 800 |
| `14-activity-trace-detail.css` | 10226–11025 | 800 |
| `15-memory-engine.css` | 11026–11821 | 796 |
| `16-content-and-automations.css` | 11822–12619 | 798 |
| `17-automations-and-goals.css` | 12620–13410 | 791 |
| `18-documents.css` | 13411–14210 | 800 |
| `19-chat-rendering.css` | 14211–15007 | 797 |
| `20-dialogs-and-language.css` | 15008–15799 | 792 |
| `21-email-inbox.css` | 15800–16596 | 797 |
| `22-email-analytics-and-project.css` | 16597–17387 | 791 |
| `23-project-runs-and-deployments.css` | 17388–18173 | 786 |
| `24-website-builder-panels.css` | 18174–18967 | 794 |
| `25-website-builder-canvas-inspector.css` | 18968–19763 | 796 |
| `26-data-studio.css` | 19764–20557 | 794 |
| `27-data-studio-auth-and-backups.css` | 20558–21347 | 790 |
| `28-data-studio-settings-and-code.css` | 21348–21754 | 407 |

**РЕЗУЛЬТАТ (виконано 2026-10-10).** `styles.css`: **21 754 → 39 рядків**; 28 модулів (максимум 800). `main.tsx` не змінювався.

**Доказ еквівалентності — не «на око».** Канонічний вміст у git має **LF** (`core.autocrlf=true` дає CRLF у робочій копії, тому хеш рахувати тільки по канонічному вмісту — інакше отримаєш хибну розбіжність):

```
sha256(concat(01..28)) == sha256(оригінал)
                       == 0346fe2a0a3131fa8997b9f1b09d1ef1e1452d73a18023301b7f750ff840296b
```

**Що прогнано:**
1. `npm run build --workspace @npati/web` → **exit 0**, `✓ built in 8.20s`, CSS 360 KB.
2. `npm run lint` (lint-guard + scan-web-xss) → **exit 0**, 7/7 allowlist-записів збіглись.
3. Кожен модуль окремо: дужки збалансовані (28/28) — тобто кожен валідний CSS.
4. Порядок каскаду в артефакті: `.home-shell` (модуль 01) на позиції **10 314**, `.code-workspace-controls` (модуль 28) — **358 939** → порядок збережено.
5. 28 `@import` ↔ 28 файлів на диску: відсутніх і зайвих немає.
6. Ім'я та розмір зібраного файлу (`index-BRNWCKqJ.css`) не змінились після перейменування модулів — артефакт ідентичний.

**Єдина неперевірена ланка:** візуальний смоук сторінок (`/`, `/chat`, `/settings/capabilities`, `/settings/company`, `/projects`, `/settings/data-studio`) не робився — потрібен браузер. Вміст CSS побайтово ідентичний, тому ризик мінімальний.

**Rollback:** `git checkout -- apps/web/src/styles.css` + видалити теку `apps/web/src/styles/`.
**Effort:** M (фактично одна механічна операція + одне виправлення меж).

---

### [ ] Крок 2 — `apps/agent-api/src/app.ts` (8 441 → ~15 модулів ≤ 800)

**Чому другий.** Головний блокер для агента: один файл 8 441 рядок / 521 KB, у якому вся проводка застосунку.

**Факти (замірено).** Це Fastify, не Express.

| Діапазон | Що там |
|---|---|
| 1–336 | **281 імпорт** |
| 337–892 | модульні хелпери: regex-детектори інтентів (uk/ru/en/…), телеметрія, вкладення, дедуплікація джерел |
| 893–3548 | тіло `buildApp()`: ~600 локальних `const` — сервіси, порти, таймери, черги |
| 3549–4880 | замикання чату: `contextBuilder` + оркестрація `/chat` (~1 330 рядків) |
| 4880–4890 | `app.register(cors)`, `setErrorHandler` |
| 4890–7072 | **~70 викликів `register*Routes(app, …)`** + доменна проводка code-* |
| 7094–7144 | `/health/live`, `/health`, `/skills` |
| 7337–8440 | `/chat/streams/:streamId/cancel`, `/chat/compact`, `/chat`, `/chat/stream` (~1 100 рядків) |
| 8440 | `return app` |

**Цільові модулі.**

1. `chat/chat-intent-helpers.ts` — 337–536.
2. `chat/chat-attachments.ts` — 537–707, 776–892.
3. `chat/chat-telemetry.ts` — 414–435, 638–775.
4. `bootstrap/context.ts` — тип/фабрика контексту залежностей (вводиться першим).
5. `bootstrap/core-services.ts` — 893–1128 (logger, session registry, `aiEngine`, research, marketplace, auth, storage, files).
6. `bootstrap/data-backend-services.ts` — 1137–1247 (провізіонери, `dataBackendService`, quota/promote/backup, data-studio).
7. `bootstrap/project-services.ts` — 1175–1400 + 3220–3235 (project service, workspace resolver, git, import, preview, sandbox, deploy, QA, terminal).
8. `bootstrap/code-services.ts` (2–3 файли) — 1396–3220 + 4931–6700.
9. `bootstrap/company-services.ts` — 3236–3548 (company runtime, orchestrator, automations, messaging, email worker).
10. `chat/chat-orchestrator.ts` — 3549–4880.
11. `routes/register-platform-routes.ts` — 4890–4934 + 6887–7072.
12. `routes/register-code-routes.ts` — 4934–6702.
13. `routes/register-health-routes.ts` — 7094–7144.
14. `chat/chat-routes.ts` — 7337–8440.
15. `app.ts` — імпорти + `buildApp()` ~150–250 рядків.

**Під-кроки (окремі коміти).** Порядок **змінено проти початкового плану** — і ось чому.

- [x] **2a (виконано, коміт `2b4868c`).** Винести **модульні хелпери** (колишні рядки 337–892, 507 рядків) у 6 модулів. Це найнижче зв'язування: чисті функції з явними параметрами, жодного стану замикання.
  - `chat-intent-helpers.ts` (129) · `chat-attachments.ts` (168) · `chat-public-errors.ts` (70) · `chat-text-directives.ts` (68) · `backend-health-probe.ts` (50) · `chat-telemetry.ts` (22)
  - `app.ts`: **8449 → 7954**; прибрано 8 імпортів, що стали мертвими; `isSpreadsheetEditRequest` і `mapColumnDirectiveFromProposal` ре-експортовано (їх імпортує `tests/chat-language-routing.test.ts`).
  - ⚠️ **Відхилення від тексту плану:** модулі створено **пласко** (`chat-intent-helpers.ts`), а не в підтеках `chat/`, `bootstrap/` — бо в `apps/agent-api/src/` уже є така конвенція (`chat-task-plan.ts`, `chat-tool-orchestrator.ts`, `chat-file-service.ts`, `chat-inference-candidates.ts`) і лише одна підтека `data-studio/`. Триматися наявної конвенції важливіше за букву плану.
- **⚠️ Чому «об'єкт залежностей» (колишній 2a) не можна зробити наступним кроком.** Усі ~70 викликів `register*Routes(app, …)` живуть **усередині** `buildApp` і посилаються на локальні `const` (сервіси, репозиторії, порти). Винести виклик із функції = передати ці залежності явно. Отже маршрути **не можуть** поїхати раніше, ніж з'явиться фабрика залежностей. Перетворення ~600 локальних `const` на один об'єкт одним комітом — це дифф на тисячі рядків і найвищий ризик у плані, тому його розбито:
- [~] **2b. Сервісна проводка за доменами** — `createXServices(inputs) → outputs`, один домен на коміт; `buildApp` лише викликає фабрики й передає результати далі. Виконано:
  - [x] **2b-1 (коміт `6f027a5`).** `audit-services.ts` (87 рядків): журнал аудиту, його конфіг, порт C5a для рішень про погодження і **два фонових таймери C1c** (перевірка ланцюга + щоденний якір). `app.ts` 7954 → 7922.
  - [x] **2b-2 (коміт `fbf2ecc`).** `core-services.ts` (199 рядків): web-research і маркетплейс, стор документів, об'єктне сховище і файли, auth-провайдер, налаштування, active-context resolver, рушії пам'яті, scoped memory, guardrail-репозиторій. `app.ts` 7922 → **7834**.
  - [x] **2b-3 (коміт `80f0e20`).** `data-backend-services.ts` (111 рядків): провізіонери shared/external Postgres, data provider, `DataBackendService`, migration engine, quota/promote/backup, `projectAuthService`, redirect-репозиторій і таймер бекапів. `app.ts` 7834 → **7792**. Ланіве посилання на `projectService` вирішено входом `getProject` — рівно як планувалось.
  - [x] ~~**2b-4.**~~ **спробувано й відкочено: домен project-\* не виноситься.** `tests/coding-agent-c15-mount-sandbox.test.ts:425–440` **пінить у тексті `app.ts` п'ять літералів**: рівно одне входження `path.join(config.dataDirectory ?? ".data", "project-workspaces")`; `new ProjectWorkspaceBaseResolver({`; `new MountedWorkspaceProvider(projectService`; regex `projectGitService = new ProjectGitService(… projectWorkspaceBases,`; `workspaceStore.getProjectMountedFolder(ctx, companyId, projectId)` і `mountedFolderFlags = featureFlagService`. А `projectApiGatewayService` та `agentDataStudioService` **споживають** `projectWorkspace`, що залежить від `projectService` — тож передати блок у фабрику можна лише як входи, і чистий виграш ≈ 0 рядків. **Домен лишається в `app.ts`.**
  - [ ] **2b-5.** Домен code-* (найбільший сліс проводки) — **не наступним кроком**, див. висновок нижче.

> **Урок 2b (три пастки, які вже коштували часу):**
> 1. **Кластери з `let`-станом не можна деструктурувати.** `engineDataPolicyResolver`, `outboundPolicySnapshot`, `refreshOutboundPolicySnapshot` оголошені через `let` і **присвоюються пізніше** в `buildApp`; деструктуризація робить їх `const` і ламає присвоєння (TS2588). Такі кластери лишаються в `app.ts`, а їхні **результати** (тут — `baseAiEngine` і `aiEngine`) передаються у фабрику як входи.
> 2. **Default-імпорти переносяться як `import X from "…"`, а не `import { X } from "…"`** — інакше TS2595 (`path` з `node:path`). Генератор імпортів мусить розрізняти обидві форми.
> 3. **`git checkout` переписує файл у CRLF** (бо `core.autocrlf=true`), навіть якщо до цього він був LF. Після будь-якого відкату — нормалізувати до LF перед комітом, інакше в коміт поїде весь файл.
>
> **G2 підтверджено на практиці:** 3 касти `as any` переїхали в `core-services.ts` → `npm run lint` упав. Лікування — `node scripts/lint-guard.mjs --update-baseline`; дельта реєстру (`app.ts` 12 → 9, `core-services.ts` 0 → 3) пішла в той самий коміт як рев'ювана зміна. Повторилося на 2b-2 і 2b-3 (по одному касту в кожному новому модулі) — це вже рутина, а не сюрприз.
>
> **Урок 2b-4 (процесний, найдорожчий у раунді).** Перед виносом будь-якого кластера — **грепати ВЕСЬ тестовий файл на `app.ts`**, а не діапазон рядків навколо відомого твердження. Я перевірив `c15-mount-sandbox.test.ts:437–441` і пропустив `:431` — цього вистачило, щоб зламати security-гейт. Робоче правило: `Select-String -Pattern 'src/app\.ts' -Context 0,10` по всьому тесту, і лише потім різати.
>
> **Стратегічний висновок (змінює порядок робіт).** Мікро-фабрики далі не окупуються: те, що лишилось у `app.ts`, — це переважно **реєстрація маршрутів (~1900 рядків)**, **чат-замикання (~1300)** і **чат-ендпоінти (~1300)**, а не проводка сервісів. Їх не винести частинами, поки немає одного об'єкта залежностей. Тому **2c перед 2b-5**.
- [~] **2c. Реєстрація маршрутів** — один домен на коміт, шаблон `registerXRoutes(app, deps)`, як у наявних `*-routes.ts`. Виконано:
  - [x] **2c-1 (коміт `bb39b7f`).** `health-routes.ts` (82 рядки): `/health/live`, `/health`, `/skills`. `app.ts` 7792 → 7750.
  - [x] **2c-2 (коміт `6b93dc7`).** `platform-routes.ts` (564 рядки): **22 реєстратори** (code data-erasure/goals/instructions/trust/mounted-folder/approval/ask-user, network, deploy, QA, company runtime, content library, MCP policy, email, api keys, scoped memory, memory documents, guardrail, reliability, browser automation/credentials, multimodal, A2A) плюс їхня власна проводка (контексти, `messagingRoutes`, хук email-шлюзу). `app.ts` 7750 → **7393**.
  - [x] **2c-3 (коміт `15f375c`).** `platform-base-routes.ts` (134 рядки): 19 реєстраторів (auth, installation auth, session stream, AI, runtime compat, workspace, project routes, data-backend, data-studio, project auth, gateway, files, terminal, preview, git, import, code, sandbox images, code tools) + хук teardown, що належить їм. `app.ts` 7393 → 7364.
  - [x] **2c-4 (коміт `cbd821b`).** `code-route-wiring.ts`: **1745 рядків** — 11 сервісів проводки code-поверхні (rbac, run state, session inbox, cancellation, run executor, queue limits/admission, background runs, data erasure, erasure contexts, run environment) і 16 реєстраторів із їхніми per-route хуками. `app.ts` 7364 → **5628** (−1736 за один коміт — найбільший крок).
    *Три нові пастки, пройдені тут:* (1) **компоненти, які читаються ДО регіону** в замиканнях (`codeRunEnvironment` на рядку 2164) — їх не видно в аналізі «використано після регіону», тому вони теж мусять повертатися з модуля; (2) **три пізні рефи** (`codingAgentRunnerRef`, `codeSubagentOperationsRef`, `subagentChildRunnerWithAck`) перейменовано на `*Value` і повернено; (3) **мій парсер імпортів читав лише однорядкові** — через це 36 імпортів реєстраторів не потрапили в модуль; парсер мусить бути багаторядковим.
  - [ ] **2c-5 (обов'язково).** ⚠️ **`code-route-wiring.ts` — 1921 рядок, тобто новий великий файл.** Розбити за родинами маршрутів (session/run, stream, durability, replay, metrics/snapshot, export/queue, background/CLI runs, agent control, intent, inbox) — по одному модулю на коміт. Поки це не зроблено, мета «жодного файлу > 800» не досягнута, і guard-скрипт (Додаток B) зафлагує цей файл.
  - [ ] **2c-6.** Ранні code-реєстратори (`registerCodeProductionRoutes` L995, `registerCodeSessionModeRoutes` L1234, `registerCodeMembershipRoutes` L1251, `registerCodeDataPolicyRoutes` L1390) — вони розкидані серед проводки code-* сервісів.
  - [ ] **2c-7.** `/capabilities` і `/capability-inspector` (наступні після health) та чат-ендпоінти `/chat*` (~1300 рядків).

> **Рецепт виносу групи маршрутів (перевірено на 2c-2, 357 рядків за один коміт):**
> 1. **Межі — за шаблоном, не за номерами** (`findIndex` на `register<Domain>Routes(app`): попередній крок додає імпорт і зсуває все на ±1.
> 2. **Набір залежностей** = імена, оголошені **до** регіону (`const`/`let`/`function`/модульні `const`) ∪ **імена, деструктуровані з фабрик** (їх не видно серед `const`!) ∪ параметр `buildApp` `config`. Мінус те, що регіон оголошує сам.
> 3. **Типи залежностей** виводяться з оголошень: `ReturnType<typeof createXServices>["field"]` для виходів фабрик, ім'я класу для `new X(...)`, явна анотація для `const X: T = …`. Для `async function X(...)` типового виведення немає — сигнатуру треба виписати руками.
> 4. **Логер** оголошувати як `FastifyBaseLogger`, а не власним інтерфейсом: частина реєстраторів приймає pino-подібний `warn(message, meta)`, і саморобний інтерфейс не проходить перевірку.
> 5. `AppConfig` імпортувати як `import type { AppConfig } from "./app"` — типовий імпорт стирається, тож циклу виконання немає.
> 6. **⚠️ Пізно зв'язані порти.** Якщо `let X` оголошено до регіону, а **присвоюється всередині** (тут: `codeUserQuestionReaperPort`, `mcpApprovalPauseRelease`), перенести присвоєння не можна: `buildApp` читає ці змінні після виклику. Рішення — оголосити їх у модулі як `const`, **повернути** з `registerXRoutes`, а в `app.ts` присвоїти одразу після виклику. Урок 2b-4 у новій формі: спершу шукати `^  let …` і перевіряти, чи не присвоюються вони в регіоні.
> 7. Після виносу — пройтись по імпортах: у 2c-2 **30 імпортів** стали мертвими.
- [ ] **2d.** Чат: `chat-orchestrator.ts` + `chat-routes.ts` (найбільший сліс, ~2400 рядків; робити останнім, коли всі його залежності вже в фабриках).
- [ ] **2e.** Довести `app.ts` до ≤ 250 рядків.

> **Урок 2a (для решти кроків):** `[System.IO.File]::WriteAllLines` на Windows пише **CRLF**, навіть якщо вхідні рядки були LF. Це непомітно змінює закінчення рядків у всьому файлі. Писати тільки через `WriteAllText` з явним `"`n"` і `UTF8Encoding($false)` — і після кожного кроку перевіряти, що CRLF-входжень нуль.

**Guard-и.** G10 (296 посилань на `WorkspaceStore` — тип не чіпаємо). Перенесення викликів `register*Routes` не змінює їхнього тексту, тому крок незалежний від кроків 19/20/22 — але є два винятки, які треба зберегти **дослівно**:
- **`globalAdmissionQueue`** — імпорт `app.ts:247`, використання `app.ts:967` (у кроці 22 цей синглтон лишається на своєму шляху);
- **teardown** `emailInboxWorker`/`emailInboxRepo` на `app.ts:7074–7075` (`onClose`/`onReady`) — він належить життєвому циклу застосунку і не переїжджає в `routes/*`.
Якщо крок 2 робиться **першим** — після нього кроки 19/20/22 стають ще простішими (у `routes/register-*-routes.ts` уже лежать тонкі виклики).
**Верифікація.** `npm run typecheck`, `npx vitest run tests/agent-api.test.ts tests/company-chat-actions.test.ts`, далі смоук `buildApp()` + `GET /health`.
**Ризики.** `buildApp()` — одне гігантське замикання з ~600 взаємозалежних локальних змінних → тільки інкрементально, **без** перейменувань локальних змінних.
**Effort:** L.

---

### [ ] Крок 3 — `packages/shared/src/code-capabilities.ts` (4 079 → ~6 модулів)

**Роль.** Набори можливостей code-* (`CODE_READ_CAPABILITIES`, `CODE_WRITE_MATRIX`, …), які імпортують і каталог (крок 4), і матриця (крок 5).

**Шов.** За підсистемами: `capabilities/code-read.ts`, `code-write.ts`, `code-shell.ts`, `code-deps.ts`, `code-plan.ts`, `code-git.ts`, `code-subagent.ts`, `code-ask-user.ts`, `code-async-process.ts`, `code-agent-control.ts` + barrel, що зберігає **всі** наявні імена експортів (їх імпортують двічі — у кроках 4 і 5).

**Guard-и.** G9 (спочатку — на кроці 5). G10 не стосується.
**Верифікація.** `npm run typecheck`, `npm run audit:code-tools`, `npm run eval:smoke`.
**Ризики.** Порядок записів усередині кожної матриці; не міняти імена експортів.
**Effort:** M.

---

### [ ] Крок 4 — `packages/shared/src/capability-catalog.ts` (7 283 → ~11 модулів)

**Факти (перевірено).**

- Рядок 1: `// Auto-generated canonical Capability Catalog covering all 306 inventory items`.
- Рядок 4: `export const CAPABILITY_CATALOG: CapabilityDefinition[] = [` … закриття `];` на рядку **7242** (7 238 рядків одного літерала).
- Рядки **7244–7283**: `import` + **18** `CAPABILITY_CATALOG.push(...)` з `./project-*-capabilities` та `./code-capabilities`.
- **Генератора цього файлу в репозиторії немає** (пошук по `scripts/` і всьому репо не знайшов скрипта, який його пише). Попри заголовок — файл зараз джерело істини, яке правлять вручну.
- Аудит читає його **як модуль** (`scripts/capability-audit-runtime.mjs` → `capability-catalog-audit.ts`), не регуляркою → розділення безпечне для гейтів.

**Шов.**

| Модуль | Що переносимо |
|---|---|
| `capability-catalog/{ai,chat,workspace,data,email,company,integrations,automation,platform}.ts` | суміжні діапазони літерала 4–7242 за полем `domain` (9 файлів ≤ 800) |
| `capability-catalog/assembled.ts` | `push`-блок 7244–7283 у вихідному порядку (`import` — на початок!) |
| `capability-catalog.ts` | тонкий: імпорт 9 частин + assembled, експорт `CAPABILITY_CATALOG` |

**Guard-и.** G9 не стосується каталогу (лише матриця + tool-test-matrix).
**Верифікація.** `npm run typecheck`, `npm run audit:capabilities`, `npm run revalidate:306`, `npx vitest run tests/coding-agent-c13-capability-catalog-audit.test.ts`.
**Доказ еквівалентності:** `CAPABILITY_CATALOG.map(c => c.id).join(",")` до і після — однаковий (306 записів, той самий порядок).
**Ризики.** Порядок записів бачать і аудит, і UI-інспектор. Заголовок «Auto-generated» вводить в оману — оновити в тому ж коміті.
**Effort:** M.

---

### [ ] Крок 5 — `packages/shared/src/capability-matrix.ts` (4 861 → ~7 модулів)

**Факти (перевірено).**

- Рядок 15: `export const CAPABILITY_MATRIX: CapabilityMatrixEntry[] = [` … закриття на рядку **4822**.
- Рядки **4824–4861**: `import` **у середині файлу** + 10 `CAPABILITY_MATRIX.push(...)` (`PROJECT_*`, `CODE_*`).
- ⚠️ **Guard G9:** `scripts/revalidate-306-capabilities.mjs` L11–17 читає файл regex + `eval`; той самий скрипт (L20–23) так само читає `TOOL_TEST_MATRIX` з `tool-test-matrix.ts` (крок 37).
- ⚠️ **Guard G7:** `tests/durable-memory-features.test.ts` L37–38 вимагає, щоб у тексті файлу були **разом** `"capabilityId": "research.fts5_keyword_search"` і `"status": "NOT_IMPLEMENTED"`.

**Шов.**
- **5a (обов'язково першим).** Перевести `scripts/revalidate-306-capabilities.mjs` з regex+`eval` на імпорт модулів (як `verify-capability-matrix.mjs` через `capability-audit-runtime.mjs`). Одним рухом знімає крихкість для кроків 5 і 37.
- **5b.** Тримати записи `research.fts5_keyword_search` і його статус **в одному модулі** (це дослідницький домен) — або оновити G7 у тому ж коміті.
- **5c.** Розділити літерал 15–4822 за доменами на 7 модулів ≤ 800; `import`-и на початок; `push`-блок лишити в асемблері у вихідному порядку.

**Верифікація.** `npm run typecheck`, `npm run audit:capabilities`, `npm run revalidate:306`, `npm run upgrade-gate`, `npx vitest run tests/durable-memory-features.test.ts`.
**Ризики.** Матриця зв'язана з каталогом (крок 4) — робити після нього. Regex `[\s\S]*\]` «жадібний»: до правки скрипта розділення непомітно змінює те, що він парсить.
**Effort:** M.

---

### [ ] Крок 6 — `apps/agent-api/src/coding-agent-runner.ts` (4 802 → ~7 модулів)

**Факти (замірено).** 64 топ-левел декларації; **~1 000 рядків (126–1 128) — самі лише типи/порти** (`CodeRunStatePort`, `CodeRunReplayPort`, `CodingAgentRunnerPorts`, …); клас `CodingAgentRunner` починається на 1 681 і тягнеться до кінця (~3 100 рядків).

**Шов.**

| Модуль | Що переносимо |
|---|---|
| `coding-agent-runner/types.ts` | усі `interface`/`type` 126–1 128 |
| `coding-agent-runner/prompt.ts` | `systemPromptStablePrefix`, `buildSystemPrompt`, константи 1 399–1 680 |
| `coding-agent-runner/tool-normalization.ts` | `stableJson`, `toolCallSignature`, `toChatToolCall`, `assertMetadataOnly`, read-only набори 1 439–1 680 |
| `coding-agent-runner/policy-composition.ts` | `createCodeRunPolicyComposition`, хеші матриць, `buildRunnerVersion` 1 467–1 560 |
| `coding-agent-runner/loop.ts` | цикл класу: виклик моделі, валідація аргументів, повтори |
| `coding-agent-runner/verification.ts` | верифікація + self-review (типи 1 271–1 340) |
| `coding-agent-runner.ts` | фасад ≤ 700 рядків |

**Guard-и.** Немає текстових контрактів; але це найбільша група тестів проєкту — вона і є захистом.
**Верифікація.** `npx vitest run tests/coding-agent-*`, `npm run eval:smoke`.
**Ризики.** Клас тримає стан прогону (лічильники, кеші, лізи) — розділення методів на вільні функції вимагає явної передачі стану; **не** вводити глобальний стан. Перед початком перевірити сусідні `code-self-review.ts` (955) і `code-run-state.ts` (954) — частина логіки вже винесена.
**Effort:** L.

---

### [ ] Крок 7 — `apps/web/src/WebsiteEditor.tsx` (4 126 → ~9 модулів)

**Факти (замірено).** ~50 інлайн-іконок (`IconBack` 53 … `IconZap` 567 — ~520 рядків SVG), `PAGE_ICON_OPTIONS` (575), `ICON_PATH_MAP` (678), `RenderPageIcon` (788), `IconSectionSymbol` (808), `authHeaders/apiGet/apiPost` (876–917), `buildMockupDocument` (918–1126), сам `WebsiteEditor()` з 1 127 до кінця (~3 000 рядків UI).

**Шов.**

| Модуль | Що переносимо |
|---|---|
| `website-editor/icons.tsx` | 53–567 |
| `website-editor/page-icons.tsx` | 575–875 |
| `website-editor/api.ts` | типи 17–52 + 876–917 |
| `website-editor/mockup.ts` | `buildMockupDocument` 918–1126 |
| `website-editor/LeftPanel.tsx` | панель сторінок/шарів/ассетів |
| `website-editor/Canvas.tsx` | канвас + оверлеї блоків |
| `website-editor/Inspector.tsx` | права панель |
| `website-editor/Drawers.tsx` | слайд-овери AI/Files/History/SEO |
| `WebsiteEditor.tsx` | композиція ≤ 500 рядків |

**Guard-и.** Перевірити перед кроком, чи файл не потрапляє в XSS-allowlist (G1) — у поточному списку його немає; якщо додасте код з `dangerouslySetInnerHTML` у нові модулі — allowlist мусить оновитись.
**Верифікація.** `npm run typecheck`, `npm run test:web`, `npm run lint`, `npm run build --workspace @npati/web`, візуальний смоук редактора.
**Ризики.** Стан редактора (вибраний блок, історія, чекпойнти) живе в головному компоненті: на першому проході виносити **лише** презентаційні підкомпоненти й передавати пропси.
**Effort:** L.

---

### [ ] Крок 8 — `apps/web/src/EmailSettingsPage.tsx` (2 923 → ~9 модулів)

**Найкраще співвідношення користь/ризик у всій Фазі 2–4** (за оцінкою інвентаризації): рівно один експорт, 900 суміжних рядків незалежних форм, немає ні XSS-запису, ні `as-any` у baseline, ні текстових тестів.

**Факти.** Один експорт `EmailSettingsPage` (L190–2923), ~95 `useState`, ~28 асинхронних хелперів, далі hero/toolbar/4 stat-картки/аналітика (L997–1428), 5 табів (L1428–1519), п'ять таб-тіл, і **чотири інлайн-форми-дровери** в хвості.

**Шов.** Нова тека `apps/web/src/email-settings/`:

| Модуль | Що переносимо |
|---|---|
| `types.ts` | L9–127 + `EMAIL_PERMISSION_OPTIONS` L129–156 |
| `account-cache.ts` | L158–188 |
| `EmailAccountDrawer.tsx` | L2033–2427 (**~395 рядків — головний виграш**; `initial?: EmailAccount` об'єднує add/edit) |
| `RoutingRuleDrawer.tsx` | L2428–2607 |
| `ResponseTemplateDrawer.tsx` | L2608–2710 |
| `ContactDrawer.tsx` | L2711–2822 |
| `DnsAuditDrawer.tsx` | L2823–2923 |
| `EmailAnalyticsPanels.tsx` | L1116–1428 (чиста презентація над `EmailAnalytics`) |
| `EmailSettingsPage.tsx` | ~1100 рядків: hero/toolbar/таби + тіла табів L1522–2032 |

**Guard-и.** Немає.
**Верифікація.** `npm run typecheck`, `npm run lint`, `npm run test:web`, `npm run build --workspace @npati/web`.
**Ризики.** Чотири дровери володіють 20–35 хуками кожен — винесення вимагає явних пропсів або `useAccountForm()`, інакше локальний стан губиться при ре-рендері.
**Під-кроки.** 8a — типи/кеш/аналітика; 8b — дровери ACCOUNTS + DNS; 8c — RULES/TEMPLATES/CONTACTS; 8d — довести головний компонент ≤ 800.
**Effort:** M.

---

## 9. Фаза 2 — шар `workspace` (кроки 9–12)

| # | Файл | Рядків | Стан |
|---|---|---:|---|
| 9 | `packages/workspace/src/types.ts` | 2 486 | [ ] |
| 10 | `packages/workspace/src/postgres-store.ts` | 5 025 | [ ] |
| 11 | `packages/workspace/src/in-memory-store.ts` | 2 795 | [ ] |
| 12 | `packages/workspace/src/code-session-durability-store.ts` | 898 | [ ] |

> Фаза робиться **як один серіал**: спочатку типи, потім обидва бекенди за **однаковим** доменним швом. Це найризикованіша частина плану.

### [ ] Крок 9 — `packages/workspace/src/types.ts` (2 486 → ~10 модулів)

**Факти.** Це **не** чистий файл типів. (a) L1–119: type-only імпорти + **три наявні барелі** (`code-goal-types` L37–66, `code-question-store` L67–89, `code-session-durability-store` L95–119 — уже винесені з коментарями про уникнення циклу). (b) L121–1647: доменні типи **плюс рантайм** — const-масиви (`PROJECT_TYPES` L156, `DATA_CLASSIFICATIONS` L164, `RETENTION_CLASSES` L167, `CODE_SESSION_MODES` L591, `COMPANY_ROLES` L993), функції (`isClassificationAtLeast` L172, `resolveCodeRetentionWindows` L211, `mergeCodeRunToolCalls` L1512, `encodeCodeRunScanCursor` L1567), класи помилок (`WorkspaceAccessError` L967, `CodeRunStateStoreError` L1598). (c) `export interface WorkspaceStore` **L1648–2140 (492 рядки)**, далі типи L2140–2486.

**Шов.** Виносити **лише самодостатні кластери** в `packages/workspace/src/types/`: `retention.ts` L163–336, `audit.ts` L439–490, `feature-flags.ts` L491–532, `sandbox-image.ts` L541–590, `membership.ts` L992–1111, `provider-data-policy.ts` L1114–1261, `execution-snapshot.ts` L2140–2244, `code-activity.ts` L2245–2360, `replay.ts` L2372–2486. **`WorkspaceStore` та його прямі залежності лишити на місці** — інакше буде цикл.

**Guard-и.** G10 (усе — публічний API через `export *`), G4/L282 (негативна перевірка 7 назв методів у тексті `types.ts` — розділення переживає, shim збереже контракт).
**Верифікація.** `npm run typecheck`, `npx vitest run tests/coding-agent-c10-session-durability.test.ts`, тести шарів workspace.
**Ризики.** Ефект обмежений читабельністю: `types.ts` усе одно мусить реекспортувати все.
**Effort:** M (або S, якщо обмежитись `provider-data-policy.ts` + `audit.ts`/`feature-flags.ts`).

### [ ] Крок 10 — `packages/workspace/src/postgres-store.ts` (5 025 → ~8 модулів)

**Факти.** Клас `PostgresWorkspaceStore implements WorkspaceStore` (L523) з **~250 методами**. Найгірше — `initialize()` (545–1599, ~1 050 рядків DDL/міграцій). Уже є патерн делегування: `private questions()`, `private goals()`, `private durability()`.

**Шов (розширення наявного патерну; фасад лишається єдиною публічною точкою).**

| Модуль | Що переносимо (вихідні рядки) |
|---|---|
| `postgres/schema.ts` | SQL-константи колонок і предикатів, L79–520 |
| `postgres/initialize.ts` | розбитий `initialize()` L545–1599 за доменами (порядок DDL **не** змінювати) |
| `postgres/code-store.ts` | code session/run/goal/turn/durability L1599–1876, L2525–3120, L3937–4310 |
| `postgres/audit-store.ts` | audit chain/anchors/approval rules L1878–2080 |
| `postgres/company-store.ts` | company/agent/run/edges L2249–2390, L2822–3140 |
| `postgres/policy-store.ts` | provider/project data policy, consents L3620–3936 |
| `postgres/workspace-core.ts` | business/goal/memory/conversation/onboarding/members L2082–2249, L3140–3620 |
| `postgres-store.ts` | фасад ≤ 500 рядків |

**⚠️ Guard-и G3, G4, G5, G6 — вирішити ДО переміщення.** Три тести читають цей файл як текст. Рекомендація:
- **Реєстрацію міграцій 082/084** (G4/L228, G5/L86) — **лишити фізично** в `postgres-store.ts` (це ~50 рядків «bootstrap», вони й логічно належать фасаду).
- **SQL-константу з аліасами** `parent_run_id AS "parentRunId", …` (G5/L102) — або лишити в `schema.ts`, який імпортується назад у `postgres-store.ts`… **ні**: тоді текст не знайдеться у файлі. Отже або константа лишається у `postgres-store.ts`, або G5-тест оновлюється свідомо. **Рішення зафіксувати в коміті.**
- G3/L400 і G6/L539 — перевірити, що саме вони шукають, і за потреби оновити тести в тому ж коміті.

**Верифікація.** `npm run typecheck`, `npx vitest run tests/coding-agent-c10-*.test.ts tests/coding-agent-c12-subagent-activity-tree.test.ts tests/coding-agent-c15-mounted-workspace.test.ts`, тести з Postgres.
**Ризики.** SQL-константи з підстановками (`*Columns`, `RETENTION_*`) використовуються по всьому файлу → виносити **першими**, одним модулем. Порядок DDL = семантика міграцій.
**Effort:** L.

### [ ] Крок 11 — `packages/workspace/src/in-memory-store.ts` (2 795 → ~12 модулів)

**Факти.** Один клас `InMemoryWorkspaceStore implements WorkspaceStore` (L54–2795), **277 методів**, ~40 приватних `Map` (L64–136). Кластери: businesses L138–271, companies+agents+projects L272–481, code sessions L482–535, audit L536–649, flags+manifest L650–707, approval+sandbox L708–811, project trust/mount L812–976, checkpoints/deploy/QA L977–1130, company runs L1131–1365, goals/memory/chat L1366–1552, onboarding L1553–1651, membership L1652–1806, data policy L1807–2089, code run state L2090–2351, snapshots L2373–2490, durability L2491–2680, replay L2707–2794.

**Шов.** Той самий, що у кроці 10 (це головна вимога інваріанта 4): `in-memory/core.ts` (оболонка класу + 40 `Map` + `initialize`/`health`) + доменні модулі.

**Ризики (високі).** 470 посилань `this.` і ~40 спільних приватних полів: будь-яке розділення мусить відкрити весь стан, а доменні модулі імпортують тип класу назад з `core.ts` → ризик циклів. У репо **немає** прецеденту міксинів/prototype-розширення. Найбезпечніший варіант — делегування до під-сторів (композиція), але це механічна переробка 277 методів. `WorkspaceStore` мусить лишитися байт-у-байт незмінним.
**Верифікація.** Тести, що використовують in-memory бекенд (`NODE_ENV=test` — основний шлях) + повний `npm test` після кроку.
**Effort:** L (30+ під-кроків).

### [ ] Крок 12 — `packages/workspace/src/code-session-durability-store.ts` (898 → 3 модулі)

**Шов.** За сутностями durability (head/recovery notice/rewind/fork), якщо файл повторює структуру `postgres/code-store.ts`. Робити **після** кроку 10, щоб шов збігався.
**Guard-и.** G4/L282 (негативна перевірка назв методів у `types.ts`, не тут), `tests/coding-agent-c10-session-durability.test.ts`.
**Effort:** S.

---

## 10. Фаза 3 — `agent-api`: репозиторії, сервіси, роутери (кроки 13–22)

| # | Файл | Рядків | Стан |
|---|---|---:|---|
| 13 | `apps/agent-api/src/email-inbox-repository.ts` | 2 347 | [ ] |
| 14 | `apps/agent-api/src/project-git-service.ts` | 1 955 | [ ] |
| 15 | `apps/agent-api/src/code-tool-runtime.ts` | 1 778 | [ ] |
| 16 | `apps/agent-api/src/data-studio/auth-service.ts` | 1 270 | [ ] |
| 17 | `apps/agent-api/src/code-tool-executors.ts` | 1 263 | [ ] |
| 18 | `apps/agent-api/src/code-policy-engine.ts` | 1 172 | [ ] |
| 19 | `apps/agent-api/src/email-routes.ts` | 1 172 | [ ] |
| 20 | `apps/agent-api/src/multimodal-routes.ts` | 1 166 | [ ] |
| 21 | `apps/agent-api/src/company-runtime.ts` | 1 131 | [ ] |
| 22 | `apps/agent-api/src/reliability-and-operations-routes.ts` | 1 085 | [ ] |

### [ ] Крок 13 — `email-inbox-repository.ts` (2 347 → ~11 модулів)

**Факти.** Клас `EmailInboxRepository` (L103–2347), **76 методів**; перед ним `normalizeEmailSubject` L58–69, `extractCandidateMessageIds` L71–101 і SQL-константи `accountCols` L19, `threadCols` L33, `messageCols` L46. Кластери: crypto/legacy L133–262, OAuth state L263–316, accounts L317–611, threads+locks L612–1233, messages+drafts L1234–1465, contacts L1466–1595, templates L1596–1719, rules L1720–1851, rate limit/quota L1852–2036, jobs L2037–2171, notifications+analytics L2172–2347.

**Шов.** `apps/agent-api/src/email-inbox/`: `sql-columns.ts` (L19–57), `subject-utils.ts` (L58–101), доменні модулі `accounts.ts`, `oauth-state.ts`, `threads.ts`, `messages.ts`, `contacts-templates.ts`, `rules.ts`, `rate-limit.ts`, `jobs.ts`, `notifications-analytics.ts`; `email-inbox-repository.ts` лишається оболонкою класу (L103–132) і реекспортує хелпери.

**Guard-и.** Текстових контрактів немає. Але **blast radius**: 12 файлів у `apps/agent-api/src` (`app.ts`, `email-routes.ts`, `email-worker.ts`, `worker.ts`, `email-agent-tools.ts`, `email-ai-processor.ts`, `email-chat-actions.ts`, `browser-credentials-routes.ts`, `email-messaging-adapter.ts`, `messaging-integrations-routes.ts`, `workspace-chat-actions.ts`) + 5 тестових файлів.
**Верифікація.** `npm run typecheck`, `npx vitest run tests/email-ai-inbox.test.ts tests/email-chat-actions.test.ts tests/email-messaging-gateway.test.ts tests/email-flood-stability-and-security.test.ts tests/email-transport.test.ts`.
**Ризики.** Деякі методи — це один довгий SQL (`listThreads` L612–736 = 125 рядків, `checkRateLimit` L1852–1937): **переносити, не переписувати**.
**Effort:** M–L.

### [ ] Крок 14 — `project-git-service.ts` (1 955 → ~12 модулів)

**Факти.** Клас `ProjectGitService` L271–1955 (~1 685 рядків, 50+ методів). Помилки L24–98 (`GitError`, `GitConflictError`, `GitConflictEscalationError`, `GitApprovalRequiredError`), порти/типи L100–244, хелпери L245–270. Кластери: резолв робочого простору L318–428, repo connect/inspect/init L429–577, working tree status/diff/commit/restore L578–762, `countWorkspaceFiles`/`isLargeChange` L763–794, чекпойнти L795–905, `restorePaths` + symlink-гарди L906–1058, `push` L1059–1221, `createPullRequest` L1222–1327, `commentOnPullRequest` L1328–1407, write intent/approval/boundary L1408–1599, credential lease L1600–1641, agent worktrees L1642–1955.

**Шов.** `apps/agent-api/src/git/`: `errors.ts` (24–98), `types.ts` (100–244), `working-tree.ts` (578–794), `checkpoints.ts` (795–905), `restore-paths.ts` (906–1058), `remote-push.ts` (1059–1221), `pull-requests.ts` (1222–1407), `approval-boundary.ts` (1408–1599), `credentials.ts` (1600–1641), `worktrees.ts` (1642–1955), а `project-git-service.ts` лишається фасадом.

**⚠️ Guard (див. 4.3).** `tests/coding-agent-c15-mount-sandbox.test.ts:437–441` читає **текст цього файлу**: він **не** має містити `path.join(this.workspaceRoot`, але **мусить** містити `await this.bases.resolve(ctx, companyId, projectId)` і `"MOUNTED_FOLDER_READ_ONLY"` — усе це в `resolveProjectWorkspace` (L318–372), отже **метод лишається у файлі**.
**Ризики.** Методи активно викликають один одного між кластерами (`restorePaths` → `createCheckpoint`/`getCheckpoint`/`assertNoSymlinkPath`; `push` → `requireGitWriteApproval`/`assertGitWriteBoundary`/`captureWorkspaceRevision`/`acquireCredential`), тому виносити **методи** можна лише в колаборатор, який отримує спільні внутрішні поля (`bases`, `workspaceStore`, `runGit`, `assertSafeIndex`) — не у вільні функції.
**Верифікація.** `npm run typecheck` + `npx vitest run tests/coding-agent-c11-git-workflow-security.test.ts tests/coding-agent-c15-mount-sandbox.test.ts tests/coding-agent-c5a-protected-branches.test.ts`.
**Effort:** L.

### [ ] Крок 15 — `code-tool-runtime.ts` (1 778 → ~7 модулів)

**Факти.** Union `CodeToolErrorCode` L49–169 (~121 рядок), `CANONICAL_ERROR_CODES` L170–219, `canonicalFailure` L220–246, `CodeToolError` L247–266, порти L267–531, експортовані хелпери L533–637 (`isSensitiveWorkspacePath`, `assertSafeWorkspacePath`, `sha256Hex`, `wrapUntrustedResult`, `validateArguments`), дефолтні порти L638–728, клас `CodeToolRuntime` L729–1775 — де **`invoke` L817–1275 — це 460 рядків**, і приватні хелпери L1276–1775 (`collectWriteTargets` 1283, `assertReadBeforeWrite` 1323, `assertApproved` 1353, `requestApprovalDecision` 1477, `ensureTurnCheckpoint` 1523, `restoreTurn` 1546, `diffForTurn` 1560, `recordRevisionConflict` 1602, `preToolPolicyAllows` 1618, `runPostWriteHooks` 1642, `recordActivity` 1725, `recordAudit` 1739).

**Шов.** `apps/agent-api/src/code-tool-runtime/`: `errors.ts` (49–266), `ports.ts` (267–531), `guards.ts` (533–637), `workspace-ports.ts` (638–728), `write-guard.ts` (1283–1617), `audit-and-hooks.ts` (1618–1775), `runtime.ts` (`invoke` + `listTools`/`listReads`), і `index.ts` як **барель, що реекспортує поточну публічну поверхню за поточним шляхом**.

**⚠️ Ризик (найвищий серед code-*).** ~25 сьютів імпортують **точний шлях** `../apps/agent-api/src/code-tool-runtime` (c2-tool-runtime, c3-runtime, c3-schema-executor-parity, c6-eval, c6-tool-call-adapter, c11-*, c12-*, c13-hooks, c14-redteam-*) → барель обов'язковий. `invoke` ділить один великий локальний скоуп (`ctx`/`input`/`port`/`args`) з усіма приватними хелперами → потрібен **об'єкт параметрів**. Мапа `revisions` — це стан-замикання інстанса, тому не глобалізувати. Файл у CI-рецепті `paths:` (`c14-ci-and-lint-gates.test.ts:342`).
**Верифікація.** `npm run typecheck`, `npm run audit:code-tools`, `npx vitest run tests/coding-agent-c2-* tests/coding-agent-c3-* tests/coding-agent-c12-*`.
**Effort:** L.

### [ ] Крок 16 — `data-studio/auth-service.ts` (1 270 → ~7 модулів)

**Факти.** Один клас `ProjectAuthService` L43–1270, **~40 методів**. Спільна проводка: `ownerContext` 63, `resolveAuthRedirect` 71, `authLink` 85, `getRedirectUrls` 91, `updateRedirectUrls` 97, `getBackend` 111, `getPool` 144, `ensureInitialized` 162, `getAuthSettings` 187, `updateAuthSettings` 199, `expectedIss`/`expectedAud` 217/221. Далі: `register` 229, `login` 362, `refresh` 471, `logout` 566, `me` 592; `verifyEmail` 646, `forgotPassword` 696, `resetPassword` 743, `changePassword` 809; `listUsers` 854, `setUserStatus` 924, `setUserRoles` 946; `getAccessPolicies` 990, `applyAccessPolicies` 1000; `rotateSigningKey` 1044; `findUserReferenceCollections` 1068, `exportUserData` 1084, `previewDeleteUser` 1146, `deleteUser` 1197; `close` 1266.

**Шов.** `apps/agent-api/src/data-studio/project-auth/` (за наявною конвенцією теки `data-studio/`: auth-crypto, auth-routes, auth-migration, rls-compiler, email-provider, redirect-repository): `service.ts` (фасад + спільна проводка 43–228), `credentials.ts` (229–645), `password-reset.ts` (646–853), `users.ts` (854–989), `access-policies.ts` (990–1043), `signing-keys.ts` (1044–1067), `gdpr.ts` (1068–1265).

**⚠️ Ризик.** Кожен метод тягнеться до `this.getBackend()` (111), `this.getPool()` (144), `this.ensureInitialized()` (162), а `pools = new Map<string, Pool>()` (51) — це **per-instance ідентичність з'єднань**, яку закриває `close()` (1266). Винесення мусить передавати **один** резолвлений контекст і зберегти **рівно одну** мапу `pools`, інакше з'єднання дублюються/течуть.
**Guard-и.** `as any: 1`; `tests/data-studio-project-auth.test.ts` імпортує клас лише за шляхом (без текстових перевірок).
**Верифікація.** `npm run typecheck`, `npx vitest run tests/data-studio-project-auth.test.ts` (це і крок 43).
**Effort:** L.

### [ ] Крок 17 — `code-tool-executors.ts` (1 263 → ~8 модулів)

**Факти.** Спільний шар: `rethrowCanonical` L48, `toCanonicalPort` L67, хелпери L156–349 (`writePortOf`, `readCurrent`, `expectedRevisionFor`, `applyUnifiedDiffToFile`, `patchBlocks`, `toEngineWritePort`, `engineOptions`, `canonicalEditArgs`). Родини: write-виконавці `canonicalWriteExecutors` L350–503, shell L504–760, deps L761–863, plan L864–959, `allCanonicalExecutors` L960–982, subagent L983–1038, ask_user L1039–1151, `runSandboxPostWriteHook` L1152–1174, `canonicalExecutors` L1175–1263.

**Шов.** `apps/agent-api/src/code-tool-executors/`: `write.ts` (37–503), `shell.ts` (504–760), `deps.ts` (761–863), `plan.ts` (864–959), `subagent.ts` (983–1038), `ask-user.ts` (1039–1151), `post-write-hook.ts` (1152–1174).

**⚠️ Guard (див. 4.3).** `code-tool-executors.ts` **не можна** зводити до чистого `export *`-бареля: тест `c12-subagent-workflow.test.ts:781–783` шукає в **тексті цього файлу** рядки `...canonicalSubagentExecutors(options)` і `"code.agent.spawn": createCodeAgentSpawnExecutor(`. Обидві **агрегатні мапи** (`allCanonicalExecutors` L960–982 і `canonicalExecutors` L1175–1263) мусять лишитися у файлі — разом зі спільним шаром (48–143, 156–349), який не має імпортувати родини назад.

**Верифікація.** `npm run typecheck`, `npx vitest run tests/coding-agent-c12-subagent-workflow.test.ts tests/coding-agent-c3-runtime.test.ts`, `npm run audit:code-tools`.
**Ризики.** ~25 сьютів імпортують **точний шлях** `../apps/agent-api/src/code-tool-runtime` та `code-tool-executors` → барель обов'язковий. Файл входить у CI-рецепт `paths:` (`tests/coding-agent-c14-ci-and-lint-gates.test.ts:344`).
**Effort:** M.

### [ ] Крок 18 — `code-policy-engine.ts` (1 172, але переміщуються лише ~400 рядків)

**Факти.** Типи L52–303, `PolicyError` L304–318, флаги L319–344, набори інструментів L345–417 (`APPROVAL_GATED_TOOLS` L345, `MODE_RISK_MATRIX` L359, `READ_TOOLS` L379, `PLAN_SAFE_TOOLS` L396, `REVIEW_SAFE_GIT_TOOLS` L409, `SHELL_TOOLS` L411, `WRITE_TOOLS` L412), предикати L418–528, клас `PolicyEngine` L529–1092 (`evaluate` L532, **`evaluateInternal` L547–882**, `gitWriteIntentsFor` L883–951, `requireApproval` L952–1077, `describeRejection` L1078–1092), вільні функції `deny` L1093–1118, `payloadHashFor` L1119–1155, `fnv1a` L1156–1164, `digestOf` L1165–1172.

**⚠️ Guard (див. 4.3) — незмінюване ядро.** У файлі мусять лишитись: union `PolicyPhase`, інтерфейс `PolicyRequest` (тест `c13-hooks` читає **його тіло саме у цьому файлі**), **точний підпис** `private async evaluateInternal(request: PolicyRequest): Promise<PolicyResult>` з тілом > 5 000 символів, яке містить `MODE_RISK_MATRIX`, і коментар `Phase order is fixed`.

**Шов (реалістичний).** `apps/agent-api/src/code-policy/`: `flags.ts` (319–344), `tool-classification.ts` (345–528), `git-intents.ts` (883–951), `approval.ts` (952–1118), `hashing.ts` (1119–1172). `requireApproval`/`gitWriteIntentsFor` зараз використовують `this.deps` (з конструктора L530) — після винесення вони мусять приймати `deps` параметром.

**Верифікація.** `npm run typecheck`, `npx vitest run tests/coding-agent-c14-policy-phase-and-gate-size-guard.test.ts tests/coding-agent-c13-hooks.test.ts tests/coding-agent-c11-*`.
**Оцінка віддачі: низька** (~400 з 1 172 рядків, двоє текстових парсерів). Якщо час обмежений — цей крок кандидат на перенесення в самий кінець.
**Effort:** S/M.

### [ ] Кроки 19–22 — роутери та `company-runtime.ts`

**Спільний шов для трьох роутерів (19, 20, 22).** Кожен експортує **одну** функцію `register<Domain>Routes(app, …)`, яку `app.ts` імпортує й викликає **рівно один раз** (`:7064` email, `:7072` multimodal, `:7069` reliability). Розділення = зробити її тонким композитором під-реєстраторів, **не змінюючи ні шлях імпорту, ні call site**:

```
registerEmailInboxRoutes(app, deps)  →  registerEmailAccountRoutes(app, deps) | registerEmailThreadRoutes(…) | …
```

`app.ts` при цьому **не змінюється** — тому кроки 19–22 незалежні від кроку 2. Якщо крок 2 робиться першим — перенести виклики **дослівно** і зберегти імпорт `globalAdmissionQueue`.

| Крок | Файл | Факти | Специфіка |
|---|---|---|---|
| 19 | `email-routes.ts` (1 172) | **40 маршрутів** у 8 секціях-банерах: accounts 98–350, threads/messages 351–841, inbound 842–903, contacts/VIP 904–959, templates/signatures 960–1016, rules 1017–1073, analytics 1074–1132, agent tooling 1133–1172 | хелпери 22–80 (`err`, `ctx`, `resolveEmailScope`, …) використовує майже кожна секція → `email-routes/context.ts`; ⚠️ `aiProcessor` L95 і `agentTools` L96 — **спільні інстанси на всю реєстрацію**, передавати вниз, не створювати вдруге (інакше форкається AI/аудит); `as any: 3` |
| 20 | `multimodal-routes.ts` (1 166) | **29 маршрутів** у 12 секціях: providers, image 103–232, understanding 233–318, OCR 319–388, documents 389–449, bridge 450–509, audio translation 510–558, video understanding 559–621, video generation 622–721, music 722–792, realtime speech 793–911, voice call 912–1023, mobile voice 1024–1166 | ⚠️ **7 модульних синглтонів L32–38** (`globalVideoPipeline`, `globalMusicEngine`, `globalSpeechEngine`, `globalVoiceCallManager`, `globalMobileVoiceAdapter`, `globalAudioTranslationEngine`, `globalVideoUnderstandingEngine`) — їхня **ідентичність і є спільним ресурсом**: усі мусять жити в одному модулі `multimodal-routes/engines.ts` і **імпортуватись**, а не створюватись; `SUPPORTED_PROVIDERS` лишити реекспортованим (`tests/production-p12-multimodal.test.ts:24` імпортує його звідси); `as any: 7` |
| 21 | `company-runtime.ts` (1 131) | клас `CompanyDelegationRuntime` 241–1131; `process` **276–615 (~340 рядків)**, `tools` **726–1069 (~344)**, `recordInference` 655–725, `combos` 1070–1131; хелпери/промпти 55–240 | ⚠️ **Guard 4.3:** `advanced-memory-production.test.ts:22–27` вимагає, щоб `const actionPlanningContext` стояв **раніше за** `const planningRequest` **у тому самому файлі** — тобто `process` виносити не можна (або оновлювати тест у тому ж коміті). Безпечний перший крок: винести лише промпти/хелпери (55–240) і `combos` (1070–1131) + `recordInference`, а тіла `process`/`tools` лишити. Другий guard: файл **не** має містити `code-run-admission`, `CodeRunQueue`, `codeRunQueue`, `host_admission`, `HostAdmissionController`, `sandbox-resource-quota` (два тести r1a) — і нові модулі теж, тому список файлів у тих тестах варто розширити свідомо. `as any: 5` |
| 22 | `reliability-and-operations-routes.ts` (1 085) | **44 маршрути** у 13+ секціях (cache 90–244, backups 245–336, session search 337–400, prune 401–434, eval 435–455, compression 456–502, context budget 503–520, per-request override 521–602, output styles 603–690, queue 691–703, admission 704–725, self-healing 726–756, quota-share 757–825, RPM leases 826–882, group sessions 883–1010, session tools 1011–1085) | ⚠️ **10 модульних синглтонів L32–49**, і `globalAdmissionQueue` **імпортується в `app.ts:247` та використовується в `app.ts:967`** → мусить лишитися досяжним за цим шляхом (або переїжджати **разом** із тими двома рядками `app.ts`). Секції мусять **імпортувати** синглтони, ніколи не створювати свої — інакше тихий split-brain: компілюється, але маршрути працюють не з тією чергою. `authorize`/`sendError` (51–75) → `reliability/context.ts`. `as any: 10` (найбільше з трьох) |

**Верифікація.** `npm run typecheck` + `npx vitest run tests/coding-agent-c15-mount-sandbox.test.ts tests/production-p12-multimodal.test.ts tests/advanced-memory-production.test.ts tests/email-ai-inbox.test.ts tests/company-*`.
**Порядок.** Усі три реєстратори signature-preserving → їх вигідно зробити **раніше** за крок 2: тоді `app.ts` побачить три маленькі реєстратори замість трьох монолітів по 1 000+ рядків.
**Effort:** M (19, 20), L (21, 22).

---

## 11. Фаза 4 — `apps/web` та `i18n` (кроки 23–36)

| # | Файл | Рядків | Стан |
|---|---|---:|---|
| 23 | `apps/web/src/i18n/types.ts` | 2 631 | [ ] |
| 24 | `apps/web/src/BusinessWorkspace.tsx` | 2 106 | [ ] |
| 25 | `apps/web/src/EmailInboxPage.tsx` | 2 013 | [ ] |
| 26 | `apps/web/src/DataStudioPage.tsx` | 1 976 | [ ] |
| 27 | `apps/web/src/DataStudioSettingsPage.tsx` | 1 939 | [ ] |
| 28 | `apps/web/src/App.tsx` | 1 550 | [ ] |
| 29 | `apps/web/src/ProjectPage.tsx` | 1 475 | [ ] |
| 30 | `apps/web/src/IntegrationsPage.tsx` | 1 470 | [ ] |
| 31 | `apps/web/src/WebsiteBuilderDashboard.tsx` | 1 367 | [ ] |
| 32 | `apps/web/src/CompanyPage.tsx` | 1 363 | [ ] |
| 33 | `apps/web/src/CodeSettingsPage.tsx` | 1 360 | [ ] |
| 34 | `apps/web/src/AutomationsPage.tsx` | 1 324 | [ ] |
| 35 | `apps/web/src/ChatMessageContent.tsx` | 1 259 | [ ] |
| 36 | `apps/web/src/ActivityPage.tsx` | 1 001 | [ ] |

> ⚠️ Файли 25, 29, 32, 35 та 30 — у XSS-allowlist (G1). Файли 24, 26–28, 31, 33, 34, 36 — перевірити G1/G2 перед кроком.

### [ ] Крок 23 — `apps/web/src/i18n/types.ts` (2 631 → ~25 модулів + shim) — правильна альтернатива розділенню локалей

**Факти.** `SupportedLanguage` L1, `LanguageInfo` L3–8, `SUPPORTED_LANGUAGES` L10–18, далі **один монолітний `export interface TranslationSchema` L20–2628** (2609 рядків), 24 блочні неймспейси + `codeInbox` одним рядком. Найбільші: `emailSettings` L1117–1545 (429), `integrationsPage` L2240–2608 (369), `companySettings` L535–798 (264).

**Шов.** `apps/web/src/i18n/schema/` — по одному модулю на неймспейс (`EmailSettingsMessages`, `CompanySettingsMessages`, `IntegrationsPageMessages`, …) + `translation-schema.ts`, що композирує `TranslationSchema`. Це чистий cut-and-paste суміжних блоків.

**⚠️ Guard G8.** `tests/coding-agent-c14-model-profile-fallback.test.ts` L328–329 робить `toContain("modelProfiles: {")` **саме на `i18n/types.ts`**. Простий `export type { … } from` цього не задовольнить. Два варіанти — обрати й зафіксувати в коміті:
- **(рекомендовано)** лишити `modelProfiles` (і `codeInbox`) в `types.ts`, а решту винести в `schema/`;
- або оновити G8-тест свідомо (тоді ж перевірити, чи `types.ts` лишається валідним джерелом контракту).

Також `types.ts` мусить і далі експортувати `TranslationSchema`, `SupportedLanguage`, `LanguageInfo`, `SUPPORTED_LANGUAGES` за тим самим шляхом: його імпортують `index.tsx` L2–3, `providerDescriptions.ts` L1, усі 7 локалей L1.

**Верифікація.** `npm run typecheck`, `npm run lint`, `npm run test:web`, `npx vitest run tests/coding-agent-c14-model-profile-fallback.test.ts`.
**Effort:** M (~8 під-кроків). **Робити до будь-якого рішення про локалі.**

### [ ] Крок 24 — `apps/web/src/BusinessWorkspace.tsx` (2 106 → ~10 модулів)

**Факти.** Типи/контекст L23–64, `WorkspaceProvider` L114–147, `useWorkspace` L149–153, `BusinessSwitcher` L157–169, `PageIntro` L178, `Notice` L182, `FloatingNotice` L186–247, `BusinessForm` L249–496, `BusinessSettingsHeader` L498–524; експорти `BusinessPage` L526–685, `EmptyBusiness` L686, `GoalsPage` L690–725, `MemoryPage` L727–753, `SkillsPage` L809–948, `AssistantMessageToolbar` L971–1084, `ProjectChatCard` L1087–1264, і найбільший — `BusinessChatPage` **L1266–2106 (840 рядків)**. JSX-коментарів-секцій майже немає — структуру задають межі компонентів.

**Шов.** `apps/web/src/business/`: `workspace-context.tsx` (L23–64 + L114–176), `shared-ui.tsx` (L178–247), `BusinessForm.tsx`, `business-pages.tsx` (L526–688), `GoalsPage.tsx`, `MemoryPage.tsx`, `SkillsPage.tsx` (L755–948), `AssistantMessageToolbar.tsx`, `ProjectChatCard.tsx`, `BusinessChatPage.tsx`. `BusinessWorkspace.tsx` лишається барелем (9 публічних експортів мусять зберегтись: `App.tsx`, `AutomationsPage.tsx`, `CompanyPage.tsx`, `ConversationalChat.tsx`, `ChatMessageContent.tsx`, `GoalsPage.tsx`, `MemoryPage.tsx`, `project-files-client.ts`, `project-files-paths.ts`, `chat-website-card.test.tsx`).

**Guard-и.** Немає текстових контрактів і запису в lint-baseline.
**Верифікація.** `npm run typecheck`, `npm run lint`, `npm run test:web`, `npm run build --workspace @npati/web`.
**Ризики.** `BusinessChatPage` (840 рядків) — окрема внутрішня декомпозиція (список повідомлень, композер, кроки прогресу, активація картки проєкту) — винести в **окремий наступний крок**, не в цей.
**Effort:** M (або L, якщо чіпати `BusinessChatPage`).

### [ ] Крок 25 — `apps/web/src/EmailInboxPage.tsx` (2 013 → ~8 модулів)

**Факти.** Модульні хелпери: `getStatusLabel` L86–109, `sanitizeEmailHtml` L111–151, `api`-обгортка ~L176–196, `toDataUrl` ~L199–211, `EmailImageAttachment` L213–274. Компонент `EmailInboxPage` L276–2013: ~80 хуків L277–434, ~20 хендлерів L447–995, далі Top Header L910, Toolbar L953, **3-колонкова картка L1058–1800** (ліва тека L1063–1171, середній список L1172–1283, роздільник L1284–1297, права панель треда L1298–1800: заголовок L1312, дії L1429, контекст клієнта L1499, попередження L1539, блок чернетки L1546, таймлайн L1627, історія L1705), композер L1801–2013.

**Шов.** `apps/web/src/email-inbox/`: `sanitize-email-html.ts` (L111–151), `email-api.ts` (L176–211), `EmailImageAttachment.tsx` (L213–274), `FolderSidebar.tsx` (L1063–1171), `ThreadListColumn.tsx` (L1172–1283), `ThreadDetail.tsx` (L1298–1800, з власним під-розділенням), `ReplyComposer.tsx` (L1801–2013), `ComposeModal.tsx`.

**⚠️ Guard G1 (XSS).** `scripts/lib/scan-web-xss.mjs` L57–67 дозволяє `apps/web/src/EmailInboxPage.tsx` рівно `dangerouslySetInnerHTML` ×1 і `innerHTML` ×1 **за точним шляхом і кількістю**. Перенесення `sanitizeEmailHtml` (у ньому і є `innerHTML`-readback, L112–113) у новий файл **зламає `npm run lint`**. У тому ж коміті: перенести обидва записи allowlist на нові шляхи з правильними `occurrences` (і `reason`).
**Порядок:** почати з листових модулів (`EmailImageAttachment` + `ComposeModal` + `ReplyComposer` — ~500 рядків), потім декомпозиція 3-колонкового рендеру.
**Верифікація.** `npm run lint` (обов'язково!), `npm run typecheck`, `npm run test:web`, `npm run build --workspace @npati/web`.
**Effort:** M–L (краще двома PR).

### [ ] Крок 26 — `apps/web/src/DataStudioPage.tsx` (1 976 → ~14 модулів)

**Факти.** Один компонент `DataStudioPage` L116–1976; типи L13–115; **~90 `useState`** L121–290; хендлери згруповані банерами `// ---`: backend attach/create 291–332, schema-операції через preview-diff 333–383, collection 384–424, field 425–460, relation 461–473, revert міграції 474–494, row CRUD 495–599, import/export 600–663. Порожній стан 664–748. Основний UI 749–1522 (header 763–832, banners 833–856, сайдбар колекцій 857–949, правий вміст 950–1522 з union табів `"data"|"schema"|"migrations"|"auth"|"api"|"backups"|"operations"` на L132). Модалки/дровери 1523–1976: create collection 1523, add field 1559, add relation 1643, schema dry-run diff 1708, row drawer 1775, import rows 1865, drift 1914.

**Шов.** `apps/web/src/data-studio/` (прецедент уже є — сусідні `DataStudioAuthSection.tsx`, `DataStudioApiSection.tsx`, `DataStudioBackupsSection.tsx`, `DataStudioOperationsSection.tsx` обслуговують той самий перемикач табів, імпорти 7–10): `panels/CollectionsSidebar.tsx` (857–949), `panels/RowsPanel.tsx` (~1096–1420), `panels/SchemaPanel.tsx` (1421–1522), `modals/CreateCollectionModal.tsx` (1523–1558), `modals/AddFieldModal.tsx` (1559–1642), `modals/AddRelationModal.tsx` (1643–1707), `modals/SchemaDiffModal.tsx` (1708–1774), `drawers/RowDrawer.tsx` (1775–1864), `modals/ImportRowsModal.tsx` (1865–1913), `modals/DriftModal.tsx` (1914–1976), `types.ts` (13–115), `useDataStudioActions.ts` (291–663).

**Guard-и.** Немає текстових тестів, немає запису в XSS-allowlist; `as any: 3` → перефіксувати після кроку.
**Ризики.** ~90 хуків і стан schema-diff (333–383) **спільні** між табом schema і модалкою diff → панелі й модалки потребують пропсів або контексту; стан у діти не переносити.
**Верифікація.** `npm run lint`, `npm run typecheck`, `npm run test:web`, `npm run build --workspace @npati/web`, `npx vitest run tests/data-studio-*`.
**Порядок.** Спершу 7 модалок/дроверів (найдешевше), потім панелі.
**Effort:** L (M, якщо обмежитись модалками/дроверами).

### [ ] Крок 27 — `apps/web/src/DataStudioSettingsPage.tsx` (1 939 → ~6 модулів) — один із найдешевших

**Факти.** Типи L11–126, константи L129–136, хелпери L140–198 (`apiFetch`, `errorCode`, `statusPillClass`, `formatBytes`, …), головний компонент L199–1306, і **три вже окремі prop-driven компоненти**: `CreateDatabaseDrawer` L1307–1434, `TransferDatabaseDrawer` L1435–1579, `SchemaDrawer` L1580–1938. Наприкінці `export default DataStudioSettingsPage` (L1939), який `App.tsx:23` **не використовує** (там іменований імпорт).

**Шов.** `apps/web/src/data-studio-settings/`: `CreateDatabaseDrawer.tsx` (1307–1434), `TransferDatabaseDrawer.tsx` (1435–1579), `SchemaDrawer.tsx` (1580–1938), `helpers.ts` (140–198), `types.ts` (11–126), і головний компонент (199–1306), який далі ділиться на `DatabasesPanel.tsx` (1150–1306) і `TablesPanel.tsx` (902–1060).

**Guard-и.** Немає ні текстових тестів, ні XSS-запису, ні `as any` у baseline — найчистіший файл фази.
**Ризики.** Прибрати або перевести на іменований експорт «мертвий» `export default` у тому ж коміті.
**Верифікація.** `npm run lint`, `npm run typecheck`, `npm run test:web`, `npm run build --workspace @npati/web`.
**Effort:** M.

### [ ] Крок 28 — `apps/web/src/App.tsx` (1 550 → ~10 модулів)

**Факти.** Модульний мутабельний стан кешів: `legacyChatStorageResetMarker` L57, `clearLegacyLocalChatsOnce` L58; `cachedSidebarConversations`/`isSidebarConversationsLoaded`/`activeSidebarConversationsFetch`/`cachedChatOpen`/`cachedBusinessOpen` L253–257; `cachedSidebarDrafts`/`cachedSidebarBusinesses`/`isSidebarBusinessesLoaded` L297–299 з гетерами/сетерами L259–362. Інлайн-компоненти: `BrandMark` 69, `NpatiAgentLogo` 71, **`ChatUserMenu` 80–163**, `Home` 165–250, 7 іконок 364–451, **`Sidebar` 463–1054 (~590 рядків)**, `FullscreenRoute` 1059, `Workspace` 1072–1132, `CanonicalChatRoute` 1182–1252, `SettingsPage` 1262–1477 (літерал карток 1264–1453), `App` 1493–1550. **44 `<Route>` у L1500–1544, нуль `lazy(`**, і **8 імпортів стоять у середині файлу — L1253–1260**.

**⚠️ Guard (див. 4.3) — 5 текстових перевірок.** `npati-backend-auth.test.ts:155–178` вимагає `resolveNpatiAvatarUrl(user?.avatar)`, `<img src={avatarUrl}`, `user?.firstName`, `user?.lastName`, `<small>{email}</small>` (це `ChatUserMenu`, L136) і **не** містить `"Disconnect account"`; `runtime-compat-capabilities.test.ts:51–53` — `path="/chat"` і точний рядок `<Navigate to="/settings/connections" replace />`. Тому переміщення `ChatUserMenu` або таблиці маршрутів **вимагає правки цих тестів у тому ж коміті**.

**Шов (під-кроки).** `apps/web/src/app/`: **28a** — підняти 8 імпортів із L1253–1260 на початок (механічно, без ризику); **28b** — винести `sidebar-cache.ts` (252–362) як **єдиного власника** кешів; **28c** — винести `shell/Sidebar.tsx` (463–1054), `shell/ChatUserMenu.tsx` (80–163), `shell/icons.tsx` (364–451), `shell/brand.tsx` (69–78), `shell/Workspace.tsx` (1059–1132); **28d** — `routes/Home.tsx` (165–250), `routes/ChatRoutes.tsx` (1135–1252), `routes/SettingsPage.tsx` (1262–1477); **28e** — винести таблицю 44 маршрутів у `routes.tsx` і перевести ~20 імпортів сторінок на `React.lazy` з `<Suspense>` на кожну гілку layout.

**Ризики.** Порядок провайдерів і `ConfirmDialogContainer` в `App` — **load-bearing**, не переставляти. `Sidebar` залежить від модульних кешів і `overview` → кеш-модуль мусить стати єдиним власником.
**Верифікація.** `npm run lint`, `npm run typecheck`, `npm run test:web`, `npx vitest run tests/npati-backend-auth.test.ts tests/runtime-compat-capabilities.test.ts`, `npm run build --workspace @npati/web`.
**Effort:** M (28a–28c) / L (28d–28e).

### [ ] Кроки 29–36 — решта web-сторінок (перевірені шви)

| Крок | Файл | Guard | Шов |
|---|---|---|---|
| 29 | `ProjectPage.tsx` (1 475) | ⚠️ XSS `attr:template-src` ×1 (QA-скриншот, allowlist:76–81); `c7-project-files-adapter.test.ts:132–136` вимагає `./project-files-client` **саме в цьому файлі** і забороняє file-URL патерн | типи 8–88, api 90–122, шапка 611–694, 3 колонки 732–932, дровер 933–1475 → `drawer/{ChangesTab,TerminalTab,CheckpointsTab,DeploymentsTab,QaTab,LogsTab,ActivityTab}.tsx` (1005–1475) + `panels/*` |
| 30 | `IntegrationsPage.tsx` (1 470) | `as any: 2` | `ConnectionManager` L107–727 (11 гілок `section === "…"` L291–726) → `connection-sections/*`; `IntegrationDrawer` 728–1171; кеші 1172–1215; `ui.tsx` 63–89 |
| 31 | `WebsiteBuilderDashboard.tsx` (1 367) | ⚠️ `c7-project-files-adapter.test.ts:138–139` вимагає `"/settings/code/"` **саме тут**; `as any: 3` | `TEMPLATES` 57–137 → `templates.ts`; `copy` (i18n en/uk) 138–266 → `copy.ts`; `apiFetch` 267–282; модалка створення → окремий компонент; ~10 сетерів форми L305–312 → один об'єкт/редюсер |
| 32 | `CompanyPage.tsx` (1 363) | ⚠️ XSS `dangerouslySetInnerHTML` ×2 (allowlist:36–41, notice ~L843) | `OrgChart` 190–233, `RunCard` 946–1063, `KnowledgePanel` 1080–1225, `CompanyDrawer` 1226–1255, `AgentDrawer` 1256–1362, `company-tools.ts` 48–99, `company-cache.ts` 100–161 |
| 33 | `CodeSettingsPage.tsx` (1 360) | немає (найчистіший) | `CreateProjectDrawer` 925–1081, `ProjectDetailsDrawer` 1082–1271, `CreateSessionDrawer` 1272–1360, `Drawer.tsx` 229–269, `labels.ts` 100–228, `types.ts` 15–80 |
| 34 | `AutomationsPage.tsx` (1 324) | немає | `BrowserCampaignPanel` 890–1149, `AutomationEditorDrawer` 1150–1260, `AutomationHistoryDrawer` 1261–1324, кеші 94–155; спершу `useAutomationForm()`, інакше поверхня пропсів ~25 |
| 35 | `ChatMessageContent.tsx` (1 259) | ⚠️ **XSS: `dangerouslySetInnerHTML` ×2 + `innerHTML` ×8** (allowlist:43–55) | `cards/EditableContentCard.tsx` 776–1033 (**володіє всіма 8 `innerHTML`**), `cards/sanitize-card-html.ts` 629–775, `attachments/*` 235–438, `blocks/*` 439–628, `sources.tsx` 93–234, `text.ts` 7–92; ⚠️ `faviconUrls`/`failedFavicons` (L22–23) → **один** модуль, інакше кеш форкається |
| 36 | `ActivityPage.tsx` (1 001) | `as any: 1` | `TraceDetail.tsx` 778–1000 (потрібні лише 3 пропси: `activeRunDetails` 139–146, `copiedId` 168, `viewMode` 154), `TaskDispatchCard.tsx` 529–639, `StatCards.tsx` 398–421, `run-cache.ts` 88–124, `types.ts` 14–81 |

**Для всіх:** якщо код із небезпечними патернами переїжджає в новий файл — перенести **запис allowlist** (новий шлях + точна кількість) у тому ж коміті (G1); після кроку — `node scripts/lint-guard.mjs --update-baseline` і дельту в коміт (G2).
**Верифікація кожного:** `npm run lint`, `npm run typecheck`, `npm run test:web`, `npm run build --workspace @npati/web`.

---

## 12. Фаза 5 — спільні пакети: схеми й матриці (кроки 37–40)

| # | Файл | Рядків | Стан |
|---|---|---:|---|
| 37 | `packages/shared/src/tool-test-matrix.ts` | 1 455 | [ ] |
| 38 | `packages/shared/src/website-schema.ts` | 1 068 | [ ] |
| 39 | `packages/shared/src/capability-catalog-audit.ts` | 857 | [ ] |
| 40 | `packages/omniroute-adapter/src/omniroute-engine.ts` | 834 | [ ] |

- **37.** `tool-test-matrix.ts`: рядок 1 — `// Auto-generated Tool Test Matrix…`, але **генератора в репо немає** (як і в каталозі) → файл правлять вручну, попри заголовок. Структура: `ToolTestMatrixEntry` L4–17, літерал `export const TOOL_TEST_MATRIX` **L19–1449 — це 42 записи × рівно 34 рядки** з JSON-ключами без виразів; єдина логіка — `getToolTestMatrix(toolId)` L1450–1455. Експортується барелем `packages/shared/src/index.ts` L216.
  **Шов (рекомендований):** винести дані в `tool-test-matrix.data.json` + типізований лоадер, що лишає `ToolTestMatrixEntry` і `getToolTestMatrix`. Альтернатива без JSON — 4–5 модулів `tool-test-matrix/{research,browser,code,data}.ts`, зібраних в одному.
  ⚠️ **Guard G9:** `TOOL_TEST_MATRIX` читається regex+`eval` у `scripts/revalidate-306-capabilities.mjs` L19–23 **за шляхом `.ts` і точною формою оголошення**. Або спершу зробити крок 5a (перевести скрипт на імпорт/читання JSON), або лишити оголошення в `.ts`.
  **Доказ еквівалентності:** `tests/tool-test-matrix.test.ts` L13 і `tests/tool-test-matrix-execution.test.ts` L33–37 пінять `TOOL_TEST_MATRIX.length === 42`, а `describe.each(TOOL_TEST_MATRIX)` генерує тест на кожен запис — кількість і `tool_id` є контрактом.
  **Верифікація:** `npm run typecheck`, `npx vitest run tests/tool-test-matrix.test.ts tests/tool-test-matrix-execution.test.ts`, `npm run revalidate:306`.
- **38.** `website-schema.ts` — **дані + логіка**, і значно безпечніший за крок 37: **жоден скрипт не парсить його текстом** (пошук `website-schema.ts` у `scripts/` нічого не дає), а всі споживачі імпортують **символи** (`COMPONENT_REGISTRY`, `createDefaultWebsiteDocument` через `@npati/shared`).
  **Факти:** типи L1–121 (`WebsiteBlockType` 1–16 … `ComponentDefinition` 112–120); **літерал `COMPONENT_REGISTRY` L122–667 (~546 рядків)** — по одному запису на тип блоку з `defaultProps`/`defaultStyles`/`propertySchema`; `createDefaultWebsiteDocument` **L669–1067 (~400 рядків логіки)** з внутрішніми білдерами (`makeNavbar` L684) і гілками шаблонів (hosting/saas/ecommerce/portfolio/landing/blank).
  **Шов:** `packages/shared/src/website/` — `types.ts` (1–121), `component-registry.ts` (122–667) *або* `.data.json` + лоадер, `templates/{hosting,saas,ecommerce,portfolio,landing,blank}.ts`, `index.ts` зі збереженням `createDefaultWebsiteDocument`.
  **Ризик:** при переході на JSON втрачається типова перевірка повноти `Record<WebsiteBlockType, ComponentDefinition>` — лоадер мусить сам assert-ити повноту, інакше пропущений тип блоку перестане бути помилкою компіляції. Також зникає ергономіка спреду `{...COMPONENT_REGISTRY.navbar.defaultProps}`.
  **Верифікація:** `npm run typecheck`, `npx vitest run tests/website-builder-schema.test.ts tests/website-data-bootstrap.test.ts tests/project-runtime-dependencies.test.ts`.
- **39.** Аудит каталогу — виносити за типами перевірок; пам'ятати, що його імпортують гейти (`capability-audit-runtime.mjs`).
- **40.** Двигун OmniRoute — за фазами (маршрутизація, ретраї, стрімінг, телеметрія); це публічний пакет, барель обов'язковий.

**Верифікація:** `npm run typecheck`, `npm run audit:capabilities`, `npm run revalidate:306`, `npm run eval:smoke`.

---

## 13. Фаза 6 — скрипти гейтів (кроки 41–42) — **низька віддача**

| # | Файл | Рядків | Переміщується | Стан |
|---|---|---:|---:|---|
| 41 | `scripts/lib/run-security-gate.mjs` | 1 526 | ~270 | [ ] |
| 42 | `scripts/security-gate-mutation-branch.mjs` | 1 271 | ~310 | [ ] |

> **Обидва файли вже наполовину відрефакторені, і більша частина рядків — це незмінювані дані або пінований текст.** Рекомендація: робити цю фазу **останньою** або свідомо пропустити — віддача тут найнижча з усього плану.

### [ ] Крок 41 — `scripts/lib/run-security-gate.mjs`

**Факти.** Тонка обгортка `scripts/run-security-gate.mjs` **уже існує** (23 рядки: shebang, `export * from "./lib/run-security-gate.mjs"`, `export { main }`, `isEntryPoint`) і піниться `tests/coding-agent-c14-metrics-aggregation.test.ts:565–567`. Усередині бібліотеки: константи й запис артефактів 29–68; **`SECURITY_GATE_TESTS` — L71–946, ~875 рядків, ~150 сьютів**; `SECURITY_GATE_DB_TESTS` 947–971; чисті парсери звітів 972–1105; `runDatabaseSuiteGate` 1106–1243; `prepareTyposquatDataset` 1244–1269; `main` 1270–1515.

**⚠️ Незмінюване (див. 4.3).** `SECURITY_GATE_TESTS` **не можна** виносити: `scripts/lib/mutation-controls-check.mjs:288` парсить текстом рівно `export const SECURITY_GATE_TESTS = [` з файлу `GATE_SCRIPT_PATH = "scripts/lib/run-security-gate.mjs"` (`:42`, перевіряється і legacy-шлях `:305`), а `c14-policy-phase-and-gate-size-guard.test.ts:223` кидає помилку, якщо парс нічого не дав. Також лишаються `TYPOSQUAT_GENERATOR_PATH` (`:32`), `GATE_ARTIFACT_PATH` (`:45`), `DB_GATE_ARTIFACT_PATH` (`:51`) і `prepareTyposquatDataset` — усі вони є **доказами** в `security-gate-mutation-branch.mjs:586/595` та `g1-clean-clone-prerequisites.test.ts:204–213`.

**Шов (єдиний безпечний).** `scripts/lib/security-gate/report.mjs` (972–1105, чисті парсери) + `scripts/lib/security-gate/database-gate.mjs` (1106–1269). Більше нічого не рухати.
**Верифікація.** `npm run lint`, `npm run security-gate`, `npm run mutation:branch` (не змінювати CLI-контракт: аргументи, коди виходу).
**Effort:** M.

### [ ] Крок 42 — `scripts/security-gate-mutation-branch.mjs`

**Факти.** Хелпери/транскрипти 95–133, чисті парсери 134–444 (`parseGateTranscript` 140, `normalizeSuite` 166, `parseFailureMessages` 186, `failureTitleMatches` 225, `readGateArtifact` 233, `observeGateRun` 297, `baselineProblem` 329, `classifyGateRun` 360–444), git/дзеркало 445–770, `GATE_IGNORED_RESOURCES` 576–599, apply/reset 771–824, `main` **868–1225**, перевірка точки входу 1267–1271.

**⚠️ Найвище текстове зв'язування у всьому плані.** `tests/coding-agent-c14-mutation-branch-controls.test.ts` вимагає в **тексті цього файлу** такі літерали: `failureTitleMatches(entry.title, expectedTest)` і **не** `entry.title === expectedTest` (`:489–491`), `BASELINE RED`, `observeGateRun({`, речення про non-equivalent environment (`:564–576`), `writeGateTranscript(ROOT, "baseline", baselineRun.transcript)`, `writeGateTranscript(ROOT, row.id, run.transcript)`, `transcript: baselineTranscript` (`:738–741`). Усе це живе в `classifyGateRun` (360–444) і `main` (868–1225) — тобто саме в тих тілах, які хотілося б винести.

**Шов.** Найбезпечніший варіант — винести **лише чисті парсери транскриптів** (134–444) у `scripts/lib/mutation-branch/transcript.mjs` і лишити решту: тоді жоден пінований рядок не переїжджає. Повний варіант вимагає такої ж тонкої обгортки, як у кроці 41 (файл виконується напряму, `main` — у `lib/mutation-branch/main.mjs`, а 1267–1271 лишається), **і** правки 7 тверджень у тесті в тому ж коміті.
**Верифікація.** `npm run mutation:branch`, `npx vitest run tests/coding-agent-c14-mutation-branch-controls.test.ts`, `npm run lint`.
**Effort:** M (лише парсери) / L (повний).

---

## 14. Фаза 7 — тести ≥ 1000 (кроки 43–45)

| # | Файл | Рядків | `describe` / `it` | У `SECURITY_GATE_TESTS`? | Стан |
|---|---|---:|---|---|---|
| 43 | `tests/data-studio-project-auth.test.ts` | 1 230 | 10 / 19 | **ні** | [ ] |
| 44 | `tests/coding-agent-c13-mcp-run-path.test.ts` | 1 175 | 5 / 18 | **так** (`:720`) | [ ] |
| 45 | `tests/coding-agent-c6-eval.test.ts` | 1 047 | 3 / 18 | **так** (`:146`) | [ ] |

**Спільне для всіх трьох.** Фікстури стоять на початку файлу, `beforeEach`/`beforeAll` — **нуль** (кожен тест сам викликає свій harness). Тому розділення = чисте перенесення функції-harness у `tests/support/` (тека вже існує: `database-describe.ts`, `run-with-cleanup.ts`) + нові файли під `tests/<suite>/__tests__/` (кореневий `include` — `tests/**/*.test.ts`, тому вкладені файли підхоплюються). Назви `describe`/`it` зберегти дослівно, тіла не переписувати.

### [ ] Крок 43 — `tests/data-studio-project-auth.test.ts` (1 230 → ~10 файлів) — найдешевший

**Факти.** Один зовнішній `describe` L24, який володіє `async function createHarness()` L25 (~440 рядків). Далі 9 вкладених: password/rate-limit 469–516, tokens 517–614, email provider 615–631, RLS compiler 632–696, end-to-end auth flows 697–917, GDPR 918–998, tenant isolation 999–1020, agent capabilities 1021–1169, HTTP routes 1170–1230.

**Шов.** `tests/support/data-studio-project-auth-harness.ts` (harness дослівно) + 9 файлів за діапазонами.
**Guard-и.** **Не** входить у `SECURITY_GATE_TESTS` → розділення не змінює `GATE_SIZE` і не тягне правок у документах. `createHarness` замикається лише на імпорти модулів (немає мутабельного стану, кожен тест будує свій store) → порядок і паралелізм не змінюються.
**Верифікація.** `npx vitest run tests/data-studio-project-auth/**`, `npm run test:known-failures`.
**Effort:** S/M.

### [ ] Крок 44 — `tests/coding-agent-c13-mcp-run-path.test.ts` (1 175 → ~6 файлів)

**Факти.** Імпорти 1–55, специфікаційний коментар 57–89, фікстури 90–507 (`WORKSPACE` 90, `session()` 133, `nativeCall()` 150, `recordingSocket()` 167, `toolsListBody()` 186, `toolCallBody()` 200, **`createHarness()` 233–475**, `discoverThenAllowByOwnerPolicy()` 476–499, `replayDivergence()` 500–507). Далі 5 describe: discovery + fail-closed 508–602, execution / untrusted data 603–758, idempotency / snapshot / tenant isolation 759–928, negative controls 929–1063, C14 replay 1064–1175.

**Шов.** `tests/support/c13-mcp-harness.ts` (90–507 дослівно) + `tests/coding-agent-c13/{discovery,untrusted-data,snapshot-and-idempotency,negative-controls,replay}.test.ts`.

**⚠️ Guard 4.4 — три дії в тому самому коміті.** (1) Файл є **доказом гейта**: `scripts/lib/run-security-gate.mjs:720` (+ `-wiring` :727) → нові імена треба додати в список, а це змінює `GATE_SIZE`; (2) тому ж коміті оновити числа в `docs/coding-agent/security-gate-report.md` (їх пінять `c14-policy-phase-and-gate-size-guard.test.ts:251–261`, `:364–380`); (3) додати нові файли в явний `include`-список `tsconfig.tests.json`.
**Ризики.** Специфікація сюїту (57–89) прямо вимагає, щоб **кожен об'єкт будувався свіжим у файлі** — експортувати **функцію** `createHarness`, ніколи не інстанс: синглтон тихо зламає саме ту властивість, яку сюїт перевіряє. «Обгортка-реекспорт» неможлива: файл із нульовими тестами валить `findEmptySuites`/`findMissingSuites` (`run-security-gate.mjs:1008–1022`, піниться `tests/coding-agent-c4a-security-gate.test.ts`).
**Верифікація.** `npx vitest run tests/coding-agent-c13*`, `npm run security-gate`, `npm run typecheck:tests`.
**Effort:** M.

### [ ] Крок 45 — `tests/coding-agent-c6-eval.test.ts` (1 047 → ~3 файли + harness)

**Факти.** Імпорти 1–79, стаб `allowAll` 80, **17 модульних хелперів 82–428** (`evalFilePath` 82, `loadFixture*` 88/92, `verificationList` 96, `fixtureImplementation` 132, `runFixtureTests` 151, `runFixtureBuild` 196, `runFixtureDepsCheck` 223, `runFixtureCommand` 252, `inMemoryWorkspace` 270–350, `evalHarness` 351–417, `runOne` 418, `fixtureTask` 423). Далі 3 describe: 33-задачний прогін + SLO-калібрування 429–864 (перший тест 429–556 — моноліт на ~130 рядків), C14 corpus coverage/hermeticity 865–922, C9 corpus loop/guards 923–1047. Хелпери чисті, без спільного мутабельного стану (`inMemoryWorkspace` — на виклик, `evalHarness` приймає опції).

**Шов (безпечна форма).** Хелпери 80–428 → `tests/support/coding-agent-eval-harness.ts`; **`tests/coding-agent-c6-eval.test.ts` лишається реальною сюїтою** (33 задачі + SLO, 429–864), а дві нові corpus-сюїти додаються **окремими файлами** (865–922, 923–1047).

**⚠️ Guard 4.4.** Цей шлях **названий у `package.json`** (`eval:smoke` = `vitest run tests/coding-agent-c6-eval.test.ts --reporter=json --outputFile=artifacts/coding-agent-eval-smoke-report.json`, і CI викликає `npm run eval:smoke` — `c14-ci-and-lint-gates.test.ts:372`) → він мусить залишитися робочою сюїтою. Файл також у `SECURITY_GATE_TESTS` (`run-security-gate.mjs:146`) → нові імена додати в список + оновити числа в `docs/coding-agent/security-gate-report.md` + внести нові файли в `tsconfig.tests.json`.
**Верифікація.** `npm run eval:smoke`, `npx vitest run tests/coding-agent-c6-eval*`, `npm run security-gate`, `npm run typecheck:tests`.
**Effort:** M.

---

## 15. Фаза 8 — решта 800–999 рядків (кроки 46–69)

| # | Файл | Рядків | Стан |
|---|---|---:|---|
| 46 | `apps/web/src/i18n/providerDescriptions.ts` | 998 | [ ] |
| 47 | `apps/agent-api/src/email-ai-processor.ts` | 997 | [ ] |
| 48 | `tests/coding-agent-c15-cli-run-start.test.ts` | 995 | [ ] |
| 49 | `apps/agent-api/src/code-session-resume.ts` | 993 | [ ] |
| 50 | `apps/agent-api/src/project-orchestrator.ts` | 981 | [ ] |
| 51 | `tests/agent-api.test.ts` | 980 | [ ] |
| 52 | `apps/agent-api/src/code-self-review.ts` | 955 | [ ] |
| 53 | `apps/agent-api/src/code-run-state.ts` | 954 | [ ] |
| 54 | `tests/coding-agent-c5a-protected-branches.test.ts` | 939 | [ ] |
| 55 | `apps/agent-api/src/code-eval-harness.ts` | 936 | [ ] |
| 56 | `apps/agent-api/src/code-hooks.ts` | 913 | [ ] |
| 57 | `tests/email-ai-inbox.test.ts` | 908 | [ ] |
| 58 | `apps/agent-api/src/a2a-control-plane-routes.ts` | 899 | [ ] |
| 59 | `apps/agent-api/src/provider-data-policy-service.ts` | 890 | [ ] |
| 60 | `tests/coding-agent-c13-mcp-approval-flow.test.ts` | 888 | [ ] |
| 61 | `apps/web/src/GoalsPage.tsx` | 875 | [ ] |
| 62 | `apps/web/src/ContentPage.tsx` | 857 | [ ] |
| 63 | `apps/agent-api/src/code-protected-branches.ts` | 854 | [ ] |
| 64 | `apps/agent-api/src/data-studio/gateway-service.ts` | 848 | [ ] |
| 65 | `tests/company-chat-actions.test.ts` | 840 | [ ] |
| 66 | `tests/coding-agent-c11-git-workflow-security.test.ts` | 838 | [ ] |
| 67 | `apps/web/src/CodeWorkspacePage.tsx` | 837 | [ ] |
| 68 | `apps/agent-api/src/provider-data-policy.ts` | 826 | [ ] |
| 69 | `apps/web/src/DataStudioAuthSection.tsx` (818) + `tests/coding-agent-c12-subagent-workflow.test.ts` (818) + `apps/web/src/MemoryPage.tsx` (805) | 818/818/805 | [ ] |

**Правила фази.** Можна брати 2–3 файли на крок, але **один файл = один коміт**. Пріоритет — файли з активною історією змін, не тести й не таблиці. Перед кожним: перевірити G1/G2 для web-файлів і G9 для `packages/shared`.

---

## 16. Антискоуп — чого в цьому плані НЕ рефакторимо

| Файл | Чому | Що робити натомість |
|---|---|---|
| `package-lock.json` (7 864) | генерується npm | нічого |
| `packages/omniroute-adapter/src/generated/provider-catalog.json` (6 421) | generated | правити `scripts/generate-omniroute-provider-catalog.mjs` |
| `apps/agent-api/src/code-tool-schemas.json` (2 791) | **генерується** `scripts/code-tool-schemas-generate.mjs` | правити генератор |
| `artifacts/capability-classification-report.json` (4 834) | артефакт звіту | нічого |
| `docs/coding-agent/current-state.md` (2 782), `security-gate-report.md` (1 580) | звіти, не код | за потреби розділити на частини в `docs/` |
| `artifacts/*.log` (2–3 тис. рядків) | логи тестів | не комітити / чистити |
| `artifacts/minio-local-rootfs.tar` (**168 MB**) | бінарний артефакт | винести з репо (P7) |
| `apps/web/src/i18n/locales/*.ts` (7 × 2573–2749) | див. Рішення D1 | **не розділяти**; розділити `i18n/types.ts` (крок 23) |

---

## 17. Ризики та як їх гасити

| Ризик | Гашення |
|---|---|
| Брудне дерево змішується з рефакторингом | P1: тільки чистий старт |
| Тихо зламані текстові контракти (розділ 4) | Читати блок кроку; правки guard-ів — у тому ж коміті; `npm run lint` **завжди**, він ловить G1/G2 |
| Циклічні імпорти | Спільні типи/константи — окремим листовим модулем **першими**; залежності строго вниз |
| Зламаний публічний API пакета | Barrel з тими самими експортами; `npm run typecheck` по монорепо після кожного кроку |
| CSS «пливе» | Суміжні діапазони + побайтове порівняння + візуальний смоук |
| Регресія маскується «вже падаючими» тестами | `npm run test:known-failures` після кожного кроку |
| Неможливі для рев'ю диффи | 1 крок = 1 файл = 1 коміт; під-кроки обов'язкові на кроках 2, 10, 11, 23, 25, 28 |
| Два бекенди розходяться | Кроки 10 і 11 — один серіал, один шов |
| Рефакторинг «назавжди» | Guard-скрипт (Додаток B) + allowlist, що може лише скорочуватись |
| Розділення тесту з `SECURITY_GATE_TESTS` ламає `GATE_SIZE` | Не «забути»: список у `run-security-gate.mjs`, числа в `docs/coding-agent/security-gate-report.md`, `include` у `tsconfig.tests.json` — у тому ж коміті (розділ 4.4) |
| Модульний синглтон продубльований у новому файлі (тихий split-brain: компілюється, але працює не з тим об'єктом) | Секції **імпортують** `global*` з одного модуля (крок 20, 22); `pools` в auth-service — рівно одна мапа (крок 16) |
| Модульний мутабельний стан форкається при винесенні | Кеші мають одного власника: `App.tsx` (крок 28), `faviconUrls`/`failedFavicons` (крок 35), `sidebar-cache` (крок 28) |
| Втрата типізації при винесенні даних у JSON | `COMPONENT_REGISTRY` — лоадер мусить assert-ити `Record<WebsiteBlockType, …>` (крок 38) |
| Робота витрачена на файли з низькою віддачею | Фаза 6 (кроки 41–42) — ~270 і ~310 переміщуваних рядків при жорстких текстових guard-ах; крок 18 — ~400 з 1 172. Робити останніми |

---

## 18. Додатки

### Додаток A — команда заміру (PowerShell)

```powershell
$root = "D:\npati\NPATI Agent"
$exts = @('.ts','.tsx','.js','.jsx','.mjs','.cjs','.css')
$skip = '\\(node_modules|\.git|dist|build|out|\.next|coverage|vendor|__pycache__|\.venv|venv|target|\.npati-data)\\'
Get-ChildItem -Path $root -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch $skip -and $exts -contains $_.Extension.ToLower() } |
  ForEach-Object {
    $lines = 0; try { $lines = ([System.IO.File]::ReadAllLines($_.FullName)).Count } catch { return }
    [PSCustomObject]@{ Lines = $lines; Path = $_.FullName.Substring($root.Length+1) }
  } | Sort-Object Lines -Descending |
  Where-Object { $_.Lines -ge 800 } | Format-Table -AutoSize
```

### Додаток B — guard-скрипт `scripts/check-file-size.mjs`

`file-size-baseline.json` містить allowlist (файл → поточний ліміт). Скрипт падає, якщо:
1. з'явився новий файл > 800 рядків, якого немає в allowlist;
2. файл з allowlist став довшим, ніж у baseline;
3. (на CI) allowlist не зменшився після кроку — «прогрес обов'язковий».

```js
// scripts/check-file-size.mjs
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const HARD_LIMIT = 800;
const baseline = JSON.parse(readFileSync("file-size-baseline.json", "utf8"));
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n").filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|css)$/.test(f));

const violations = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n").length;
  const allowed = baseline[file];
  if (allowed === undefined) {
    if (lines > HARD_LIMIT) violations.push(`${file}: ${lines} > ${HARD_LIMIT} (немає в allowlist)`);
  } else if (lines > allowed) {
    violations.push(`${file}: ${lines} > дозволених ${allowed} (файл виріс)`);
  }
}
if (violations.length) { console.error(violations.join("\n")); process.exit(1); }
console.log("file-size guard: OK");
```

> Локалі з Рішення D1 додаються в allowlist із поточними лімітами, щоб guard не «червонів» на них.

### Додаток C — шаблон коміта

```
refactor(<scope>): split <file> into <N> modules (step <N>)

До:    <file> — <X> рядків
Після: <file> — <Y> рядків; нові модулі: <list, max Z рядків кожен>

Публічний API: без змін (<barrel / export list>)
Guard-и:       <G1/G2/G9 — оновлено так-то | не торкались>
Перевірено:    typecheck, lint, <targeted tests>, <audit script>
```

### Додаток D — шаблон нотатки кроку

```
Крок N — <file>  (<X> → <Y> рядків)
Шов:        <як розрізали>
Нові файли: <список>
API:        <що лишилось незмінним>
Guard-и:    <які перевірені/оновлені>
Тести:      <що прогнали, результат>
Ризики:     <що виявили>
Rollback:   git revert <sha>
```

---

## 19. Журнал виконання

| Крок | Файл | Було | Стало | Коміт | Дата |
|---|---|---:|---:|---|---|
| 1 | `apps/web/src/styles.css` | 21 754 | 39 рядків entry + 28 модулів (макс. 800) | `a253b28`, `76ab098` | 2026-10-10 |
| 2a | `apps/agent-api/src/app.ts` | 8 449 | 7 954 (винесено 6 модулів, 507 рядків) | `2b4868c` | 2026-10-10 |
| 2b-1 | `apps/agent-api/src/app.ts` | 7 954 | 7 922 (аудит → `audit-services.ts`) | `6f027a5` | 2026-10-10 |
| 2b-2 | `apps/agent-api/src/app.ts` | 7 922 | 7 834 (ядро → `core-services.ts`) | `fbf2ecc` | 2026-10-10 |
| 2b-3 | `apps/agent-api/src/app.ts` | 7 834 | 7 792 (data-backend → `data-backend-services.ts`) | `80f0e20` | 2026-10-10 |
| 2b-4 | `apps/agent-api/src/app.ts` | 7 792 | 7 792 — **спробувано й відкочено**: тест `c15-mount-sandbox` пінить 5 літералів у `app.ts` | — (відкат) | 2026-10-10 |
| 2c-1 | `apps/agent-api/src/app.ts` | 7 792 | 7 750 (health/skills → `health-routes.ts`) | `bb39b7f` | 2026-10-10 |
| 2c-2 | `apps/agent-api/src/app.ts` | 7 750 | 7 393 (22 реєстратори → `platform-routes.ts`) | `6b93dc7` | 2026-10-10 |
| 2c-3 | `apps/agent-api/src/app.ts` | 7 393 | 7 364 (19 реєстраторів → `platform-base-routes.ts`) | `15f375c` | 2026-10-10 |
| 2c-4 | `apps/agent-api/src/app.ts` | 7 364 | **5 628** (code-проводка + 16 реєстраторів → `code-route-wiring.ts`) | `cbd821b` | 2026-10-10 |
