# Аудит інструментів Npati Code (Coding Agent)

**Тип:** аудит, лише читання. Робочий код, схема БД, конфігурація, flags і політики **не змінювалися**.
**Дата:** 2026-10-22. **HEAD:** `f763346` (Agent code-3). **Локальний стек:** `npati-isolated-source-20261011-*`, образ API `npati-fix-local:20261022` (runner `fix-97b1d7a`).
**Створено:** цей файл. Допоміжні скрипти лежать поза репозиторієм (scratchpad сесії) і нічого не змінюють:
`tools-inventory.mts` (імпортує реальний реєстр, каталог і executors), `tools-live-check.mts` (реальні виклики в тимчасовій теці), `q.sh` (SQL у `BEGIN TRANSACTION READ ONLY … ROLLBACK`).

Як читати позначки:
- **ФАКТ** — прочитано в коді (є `файл:рядок`) або отримано виконанням чи запитом до БД (метод вказано).
- **ГІПОТЕЗА** — випливає з коду чи даних, але виконанням не перевірено.
- **РЕКОМЕНДАЦІЯ** — пропозиція. Перед кожною перевірено, чи вже існує механізм, який можна розширити.

Пов'язані документи, щоб не дублювати: `docs/audit/coding-agent-inventory.md` (загальний потік, 21.10) і `docs/audit/coding-agent-visual-edit-diagnosis-2026-10-22.md` (редагування за фото, guard прогресу).

---

## 0. Короткий висновок

1. **Зареєстровано 50 інструментів `code.*`.** Обробник є у всіх 50: 48 в карті executors, а `code.fs.diff` і `code.fs.undo_last_turn` обробляються прямо в `CodeToolRuntime.invoke`. Заглушок немає. Реєстр і схеми збігаються 1:1. Інструментів preview, перегляду зображень, web fetch/search і явного `finish` у наборі `code.*` **немає**.
2. **Модель отримує 31–50 інструментів.** Це 6–10 тис. токенів схем на кожен виклик, а при вікні компакції 16–32 тис. це 20–60 % бюджету. Профіль моделі на набір інструментів **не впливає**: він змінює лише режим парсингу, паралелізм і `contextWindow`.
3. **Головна причина зациклення — компакція контексту, а не інструменти.** Поріг компакції `min(0.75·window, modelInputTokens)` дорівнює 16 384 (локально 32 768) незалежно від профілю. Компакція лишає без змін лише 4 останні **повідомлення**. Тому модель знову й знову перечитує ті самі файли: запуск зі старою збіркою дав 71 хід, 112 read, 0 edit і 2,6 млн токенів.
4. **`code.shell.exec` фактично не працює в чат-запусках:** 88 зі 105 викликів невдалі. Причина — два незалежні класифікатори команд: `classifyShellCommand` у PolicyEngine і значно суворіший allowlist `classifyTerminalCommand` у sandbox. Навіть `node --version` і `node --check app.js` вимагають схвалення, якого чат-запуск отримати не може.
5. **Правила «коли використовувати / коли не використовувати» вже існують** у Capability Registry (`useWhen`/`doNotUseWhen` для всіх 50), але **моделі не передаються**: у запит іде лише `description` зі схеми.
6. **Data Studio:** 7 інструментів `code.data.*` викликають той самий `AgentDataStudioService`, що й чат-агент (без дублювання). У Coding Agent бракує seed/rows, templates, migrations.list, RLS/auth і promote, хоча всі вони вже є в сервісі.

---

## 1. Інвентар (A)

### 1.1. Де визначаються, реєструються й викликаються інструменти (ФАКТ)

| Шар | Файл і символ | Роль |
|---|---|---|
| Схеми (джерело істини) | `apps/agent-api/src/code-tool-schemas.json` (50 записів) | `name`, `version`, `status`, `description`, `inputSchema`, `outputSchema` |
| Маніфест і версії | `code-tool-registry.ts:205` `CODE_TOOL_MANIFEST_VERSION = 14`; заморожені набори V5–V13 (`:114–204`) | сесія пінить версію маніфесту при створенні (`code-service.ts:256`) |
| Capability Registry / Inspector | `@npati/shared` `defaultCapabilityRegistry` (398 capabilities, з них 50 `code.*`); `capability-routes.ts:9,35` `CapabilityInspectorService` | `risk`, `useWhen`, `doNotUseWhen`, `requiredPermissions` |
| Групи (C5) | `code-capability-groups.ts:21–71` `CODE_CAPABILITY_GROUPS` | `code.read/write/shell/git`; перевіряються в `code-policy-engine.ts:386–395` |
| Ознака запису | `code-edit-approval.ts:14` `CODE_WRITE_TOOLS` | `write: true` у каталозі |
| Каталог для моделі | `coding-agent-tool-catalog.ts:46–90` `toolDescriptors`, `:96–112` `chatToolDefinitions` | фільтрація і формування `tools` |
| Цикл агента | `coding-agent-runner.ts:278` (фільтр website), `:307–310` (фільтр requireImplementation), `:567–568` (`tools`, `toolChoice: "auto"`) | відправка в модель |
| Виконання хвилями | `coding-agent-tool-waves.ts:475` (паралелізм), `:477–500` (результат → повідомлення `tool`) | |
| Runtime | `code-tool-runtime.ts:167` `invoke`; executors зібрані в `code-tool-runtime-wiring.ts:80` `allCanonicalExecutors` | |
| Політика | `code-policy-engine.ts:340+` `evaluateInternal` (flags → RBAC → capability → groups → trust → mode → approval) | |
| Профілі моделей | `code-model-profiles.ts:115–141` `DEFAULT_CODE_MODEL_PROFILES` | |
| MCP-міст | `mcp-run-path.ts:296` `prepareForRun` (під flag `code.mcp`) → `runtimeTools` у каталозі | |
| Hooks | `code-tool-runtime-hooks.ts`, `code-hooks.ts` (PreToolUse/PostToolUse/Stop) | |

### 1.2. Таблиця інструментів

Спільне для всіх рядків. Схема: `code-tool-schemas.json`, усі `version 1`, `status active`. Запис у Capability Registry є для всіх 50 (перевірено скриптом: розбіжностей 0). Майстер-flag `coding_agent.enabled` плюс суб-flag із `subFlagForTool` (`code-policy-tools.ts:130–146`). «Ризик» узято з `risk` реєстру; R/W/D означає read / write / destructive.

Умови видимості (В):
- **В0** — завжди, крім фільтрів нижче.
- **В-plan** — лишається в режимі `plan` (`coding-agent-tool-catalog.ts:86–88`: `isReadOnlyRunTool || isPlanSafeTool`).
- **В-ro** — лишається при `readOnlyIntent` (`:83–85`, плюс `code.git.status/diff/log/pr.comment`).
- **−web** — прибирається в чат-редагуванні сайту і при `requireImplementation`. Регулярний вираз `^code\.(fs\.|deps\.|shell\.|verify\.|browser\.|web\.|data\.|plan\.|project\.info$|ask_user$)` (`coding-agent-runner.ts:278,310`) прибирає `code.git.*`, `code.agent.*` і `code.symbols.outline`.
- **−deleg** — прибирається, якщо делегування заборонене (`:78`).
- **async-flag** — з'являється лише з відповідним flag (`:68–76`; проводка `code-route-wiring.ts:362–366`).
- **pin≤v11** — сесії, пінені до маніфесту ≤ v11, не бачать `code.data.*` (`code-tool-registry.ts:202`).

| Інструмент | Обробник (`файл:рядок`, функція) | Реалізація | Бачить модель | Суб-flag | Ризик |
|---|---|---|---|---|---|
| code.fs.list | `code-tool-executors.ts:139` `canonicalExecutors` | повна (live ✓) | В0, В-plan, В-ro | code.read | R / low |
| code.fs.read | `code-tool-executors.ts:152` | повна (live ✓); зображення → лише метадані (`code-tools-fs.ts:343–349`) | В0, В-plan, В-ro | code.read | R / low |
| code.fs.grep | `code-tool-executors.ts:164` → `code-tool-runtime-workspace.ts:53` `runSearch` → `project-sandbox-service.ts:543` `search` | повна, **лише з sandbox** (без нього `sandbox_unavailable`, live) | В0, В-plan, В-ro | code.read | R / low |
| code.fs.tree | `code-tool-executors.ts:181` | повна (live ✓) | В0, В-plan, В-ro | code.read | R / low |
| code.symbols.outline | `code-tool-executors.ts:192` (ctags через sandbox, `code-tool-runtime-wiring.ts:122+`) | часткова: ctags або «недоступно» | В0, В-plan, В-ro; **−web** | code.read | R / low |
| code.project.info | `code-tool-executors.ts:201` | повна | В0, В-plan, В-ro | code.read | R / low |
| code.fs.edit | `code-tool-executors-write.ts:227` | повна (live ✓) | В0; −plan | code.write | W / medium |
| code.fs.apply_patch | `code-tool-executors-write.ts:251`; парсер `code-tools-patch.ts:76,121` | повна, строгий формат (голий `@@` відхиляється, live) | В0; −plan | code.write | W / medium |
| code.fs.write | `code-tool-executors-write.ts:211` | повна (live ✓) | В0; −plan | code.write | W / medium |
| code.fs.move | `code-tool-executors-write.ts` (`canonicalWriteExecutors`) | повна | В0; −plan | code.write | W / medium |
| code.fs.delete | `code-tool-executors-write.ts:241` | повна, завжди approval | В0; −plan | code.write | D / high |
| code.fs.diff | inline `code-tool-runtime.ts:351–360` (`writeGuard.diffForTurn`) | повна (live ✓) | В0; **не в plan** (немає в `CODE_RUN_READ_ONLY_TOOLS`) | code.read | R / low (але в `CODE_WRITE_TOOLS`) |
| code.fs.undo_last_turn | inline `code-tool-runtime.ts:336–349` | повна, потрібно `confirm: true` | В0; −plan | code.write | W / medium |
| code.shell.exec | `code-tool-executors-shell.ts:162` → `CodeShellRuntime.exec` → sandbox `project-sandbox-service.ts:352` `run` | повна, але **подвійний шлюз схвалення** (§3.3) | В0; −plan | code.shell | W / high |
| code.shell.process.start/list/logs/stop | `code-tool-executors-shell.ts:197–250` | повна | В0; −plan | code.shell | high / low / low / medium |
| code.shell.exec_async | `code-tool-executors-shell.ts` (`execAsync`) | повна | async-flag `code.async_processes`+`code.background_runs`+tracked sandbox | code.shell | W / high |
| code.shell.process.wait | `code-tool-executors-shell.ts:150` | повна | async-flag, як вище | code.shell | R / low |
| code.verify.run | `code-tool-executors-shell.ts:252` → `code-ports-wiring.ts:204–272` | повна | В0; −plan | code.shell | W / medium |
| code.deps.inspect | `code-tool-executors-deps.ts` | повна | В0, В-plan, В-ro | code.read | R / low |
| code.deps.audit | `code-tool-executors-deps.ts` | повна | В0; −plan | code.shell | medium |
| code.deps.add | `code-tool-executors-deps.ts:91` | повна | В0; −plan | code.shell | W / high |
| code.plan.propose / update | `code-tool-executors-plan.ts:62`+; сховище `code-tool-runtime-wiring.ts:93–121` | повна | В0, В-plan, В-ro | code.read | low |
| code.ask_user | `code-tool-executors-ask-user.ts:78` | повна (пауза run) | В0, В-plan, В-ro | code.read | low |
| code.git.status / diff / log | `code-tool-git-executors.ts:241,262`+ | повна (live ✓ status/diff) | В0, В-ro; **−web** | code.git | R / low |
| code.git.branch.create/switch, stage, commit | `code-tool-git-executors.ts` | повна | В0; **−web** | code.git | low–medium |
| code.git.restore | `code-tool-git-executors.ts` | повна, approval | В0; **−web** | code.git | D / high |
| code.git.push / pr.create | `code-tool-git-executors.ts` | повна, approval + protected branch | В0; **−web** | code.git | high |
| code.git.pr.comment | `code-tool-git-executors.ts` | повна, власне approval | В0, В-ro; **−web** | code.git | medium |
| code.agent.spawn | `code-tool-executors.ts:82` `createCodeAgentSpawnExecutor` | повна | В0; **−web**, −deleg | write (default) | medium |
| code.agent.spawn_async | `code-tool-executors.ts:89` | повна | async-flag `code.async_subagents`+inbox; −web, −deleg | write | medium |
| code.agent.continue / send_message / interrupt | `canonicalCodeAgentControlExecutors` (`code-tool-executors.ts:81`) | повна | async-flag `code.async_agent_control`+inbox; −web, −deleg | write | medium |
| code.data.schema.inspect | `code-data-tools.ts:84` → `AgentDataStudioService.inspectSchema` | повна | В0, В-plan, В-ro; pin≤v11 ✗ | write (default) | R / low |
| code.data.schema.apply | `code-data-tools.ts:85` → `applySchema` (лише create_collection/add_field/create_index) | повна | В0; pin≤v11 ✗ | write | W / medium |
| code.data.schema.modify | `code-data-tools.ts:79` (`extended`) | повна, approval | В0; pin≤v12 ✗ | write | D / high |
| code.data.rows.list | `code-data-tools.ts:80` | повна | В0, В-plan, В-ro | write | R / low |
| code.data.rows.transfer | `code-data-tools.ts:81` | повна, approval | В0 | write | D / high |
| code.data.backend.attach | `code-data-tools.ts:82` | повна, approval | В0 | write | high |
| code.data.backend.create | `code-data-tools.ts:83` | повна | В0; pin≤v13 ✗ | write | medium |

ФАКТ (скрипт `tools-inventory.mts`, `allCanonicalExecutors({})`): `executors 48`, «schemas without executor: code.fs.diff, code.fs.undo_last_turn». Обидва обробляються inline (див. рядки вище).

**Розбіжності класифікації (ФАКТ):**
- 17 інструментів **не мають групи C5**: `code.plan.*`, `code.ask_user`, `code.agent.*` (6), `code.shell.exec_async`, `code.shell.process.wait`, `code.data.*` (7). Скрипт показав, що `assertCapabilityGranted` при заповнених `capabilityGroups` відхилить усі 17 (`capability_not_granted`).
- `code.fs.diff` позначений як write (`code-edit-approval.ts:25`), хоча він read. У `READ_TOOLS` політики він є (`code-policy-tools.ts:88`), а в `CODE_RUN_READ_ONLY_TOOLS` каталогу немає (`coding-agent-runner-prompt.ts:11–25`). Тому в `plan` модель його не бачить.
- `CODE_RUN_READ_ONLY_TOOLS` містить `code.protected_branches.read`, `code.membership.list`, `code.audit.read`, яких немає в схемах (мертві записи).
- Регулярні вирази `code.browser.`/`code.web.` у фільтрі `coding-agent-runner.ts:278,310` і `code.fs.(search|glob)` у лічильнику інспекції (`:679`) не відповідають жодному інструменту.

### 1.3. Згадані в `docs/coding-agent/`, але не зареєстровані як інструмент моделі

Метод: регулярний вираз `code.<a>.<b>` по всіх `docs/coding-agent/*.md` мінус 50 схем.

| Назва | Де згадано | Статус |
|---|---|---|
| `code.deps.install` | `2026-10-13-chat-development.md`, `permission-modes.md` | не існує; промпт прямо забороняє його вигадувати (`chat-stream-routes.ts:428`) |
| `code.deps.update` | `permission-modes.md` | не існує |
| `code.migrations.run`, `code.deploy.release` | `current-state.md` | не існує як інструмент; міграції йдуть через `code.data.*` |
| `code.prod.operate` | 8 документів | це **дозвіл**, а не інструмент (`code-membership.ts:10`, `code-prod-operations.ts:20`) |
| `code.policy.manage`, `code.trust.manage`, `code.rbac.manage`, `code.protected_branches.update` | `permission-modes.md`, `current-state.md` | адмін-дозволи, не інструменти моделі (і не мають ними бути) |
| `code.search.grep`, `code.fs.patch`, `code.shell.run`, `code.shell.process` | аудити 15–16.10, `PLAN.md` | старі назви чи псевдоніми теперішніх `code.fs.grep`, `code.fs.apply_patch`, `code.shell.exec`, `code.shell.process.*` |
| `code.changes.read`, `code.question.*`, `code.session.*` | `ide-protocol.md`, `async-workspace-step-8.md` | ендпоїнти IDE/HTTP, а не інструменти моделі |
| Preview / screenshot / web fetch / web search | `PLAN.md:90,638,768` («reuse Live Preview», exfiltration guard для web) | інструментів `code.*` **немає**. Є capabilities в основному реєстрі: `project.preview.start/stop/status`, `browser.browser_screenshots`, `browser.web_fetch`, `research.web_search` (`agentCallable: true`), але Coding Agent їх не отримує |

---

## 2. Що фактично отримує модель (B)

### 2.1. Де формується `tools` (ФАКТ)

`coding-agent-runner.ts:278` `toolDescriptors(...)` → фільтр website → `:307` `chatToolDefinitions(...)` → фільтр `requireImplementation` → `:567–568` `tools: definitions, toolChoice: "auto"`. Кожне визначення має вигляд `{type:"function", function:{name, description: schema.description, parameters: schema.inputSchema}}` (`coding-agent-tool-catalog.ts:106–109`). Окремо системний промпт містить компактний індекс: назва, позначка «(mutating)» і перше речення опису до 110 символів (`coding-agent-runner-prompt.ts:66–71,178,198–199`). Адаптер завжди додає `parallel_tool_calls: false` (`packages/omniroute-adapter/src/omniroute-engine.ts:96,104`).

### 2.2. Профілі моделей (ФАКТ)

| Профіль | Збіг | Режим | Паралельно | Вікно |
|---|---|---|---|---|
| hosted-native-tools | провайдери anthropic, openai, google, … (`code-model-profiles.ts:117`) | native, preferred `apply_patch` | 4 | 200 000 |
| hosted-native-tools-small-context | `*mini*`, `*flash*`, `*haiku*`, `*small*` | native | 2 | 64 000 |
| local-text-tools | ollama, lmstudio, vllm, … `*local*` | text | 1 | 32 000 |
| conservative-default | без збігу або flag вимкнено | auto | 1 | 32 000 |

**Профіль не змінює набір інструментів.** Каталог фільтрується лише за режимом сесії, наміром, website/requireImplementation, async-flags, делегуванням і маніфестом (`coding-agent-tool-catalog.ts:46–90`). Профіль впливає на парсинг (`code-tool-call-adapter.ts:377`), паралелізм хвилі (`coding-agent-tool-waves.ts:475`) і вікно компакції (§4.4). Отже для всіх трьох профілів кількість і розмір однакові.

Резолюція профілю (скрипт, усі три flags увімкнені): `auto` і `deepseek/deepseek-chat` → conservative-default; `deepseek/deepseek-flash` і `openai/gpt-4o-mini` → small-context; `anthropic/*` і `kiro/*` → hosted-native; `ollama/*` → local-text. Локально всі три flags `code.model_profile.*` увімкнені (`feature_flags`, read-only запит).

### 2.3. Скільки й чого йде в запит

Метод: скрипт викликає реальні `CodingAgentToolCatalog.toolDescriptors` і `chatToolDefinitions`. Токени рахуються оцінювачем самого runner, `estimateContextTokens` = символи/4 (`code-context-budget.ts:24,56`). Це оцінка, не токенізатор провайдера.

| Сценарій | Інструментів | Схеми, токенів (символів) | Індекс у промпті |
|---|---|---|---|
| `plan` | 12 | ≈2 213 (8 849) | ≈283 |
| `readOnlyIntent` | 16 | ≈2 776 (11 102) | ≈394 |
| `ask` / `auto_edit` / `full_auto`, async-flags вимкнені | 44 | ≈8 520 (34 077) | ≈1 148 |
| те саме, усі async-flags увімкнені (як локально) | **50** | **≈9 839** (39 356) | ≈1 282 |
| чат-редагування сайту, async вимкнені | 31 | ≈5 979 (23 916) | ≈813 |
| чат-редагування сайту, async увімкнені (як локально) | **33** | ≈6 450 | ≈880 |
| сайт, сесія пінена до v10/v11 | 24 | ≈4 260 | ≈575 |

Підтвердження з реальних запитів (`code_replay_bundle_steps.payload.request.toolNames`, 229 бандлів): 32 інструменти — 153 бандли, 49 — 45, 33 — 31. Тобто в живих запусках модель отримує 32–49 інструментів.

Найдорожчі визначення: `code.agent.spawn` 597, `code.agent.spawn_async` 493, `code.ask_user` 484, `code.data.schema.modify` 394, `code.shell.exec_async` 350, `code.data.rows.transfer` 339, `code.data.schema.apply` 336, `code.shell.exec` 327 токенів.

### 2.4. Фільтрація за режимом, наміром і flags (ФАКТ)

- **Режим:** лише `plan` звужує набір (до read і plan-safe). `ask`, `auto_edit` і `full_auto` отримують **однаковий** список. Різниця між ними — лише в рішенні політики під час виклику (`code-policy-engine.ts:556`, `MODE_RISK_MATRIX`).
- **Намір:** `readOnlyIntent` (EXPLAIN/REVIEW) і жорсткий фільтр для website/requireImplementation. Динамічного вибору за наміром (наприклад, «колір» → лише fs) немає.
- **Flags:** async-інструменти і делегування. `code.mcp` додає runtime-інструменти, але локально їх 0: 210 × `mcp_integration_source_unavailable`, 32 × `empty`.

### 2.5. Правила «коли використовувати / коли не використовувати»

- ФАКТ: у `description` схем такі формулювання є лише частково (20 із 50 мають `do not` / `only when` / `instead of` / `prefer`; скрипт, колонка `hasWhenNot`).
- ФАКТ: Capability Registry містить `useWhen` (1–3 пункти) і `doNotUseWhen` (1–4 пункти) для **кожного** з 50. Приклад `code.fs.delete`: `doNotUseWhen: ["The intent is to replace content: use code.fs.write or code.fs.edit instead of deleting.", …]`. Обсяг ≈18 286 символів (≈4,6 тис. токенів) на всі 50.
- ФАКТ: `chatToolDefinitions` передає лише `schema.description` (`coding-agent-tool-catalog.ts:108`). `useWhen`/`doNotUseWhen` до моделі **не доходять**.

---

## 3. Перевірки (C), використання (D), діагностика (E)

### 3.1. Методика живої перевірки (C)

- Ізольований проєкт: `createC3ProofFixture()` (`tests/support/c3-workspace-proof.ts:22`) — `mkdtemp` у системному temp, `InMemoryWorkspaceStore`, локальний git. Production і проєкти користувачів не зачіпалися; тека видаляється наприкінці.
- Runtime: справжній `CodeToolRuntime` + `allCanonicalExecutors` + `CODE_TOOL_SCHEMAS`, checkpoints з git, `FeatureFlagService` з `enabledByDefault`.
- Shell і verify: справжній `CodeShellRuntime` і справжній `classifyShellCommand`. **Обмеження:** sandbox-порт підмінено локальним `spawnSync` у тимчасовій теці (Docker-sandbox не викликався), а PolicyEngine — дублером, що повторює вердикти класифікатора (той самий підхід, що в `tests/coding-agent-c4-shell.test.ts:40–66`). Verify-runner — копія логіки `code-ports-wiring.ts:204–272` з тим самим `parseVerifyOutput`.
- «Що бачить модель» відтворено точно як у `coding-agent-tool-waves.ts:477–500`: `compactWriteReceipt` + `boundText(…, 30000)` для успіху і `canonicalizeSettledToolResult` для помилки.

### 3.2. Результати (ФАКТ, виконано)

| # | Виклик | Результат | Що отримала модель |
|---|---|---|---|
| 1 | `code.fs.list {dir:"."}` | ok | 7 записів з типом і розміром, 798 символів |
| 2 | `code.fs.tree {}` | ok | текстове дерево + entries |
| 3 | `code.fs.grep {pattern:"--primary"}` | **fail** `sandbox_unavailable` | «Text search requires the sandbox runner…», `retryable:true`. Без sandbox grep не працює взагалі; fallback на ФС немає (`code-tool-runtime-workspace.ts:53–56`) |
| 4 | `code.fs.edit` без попереднього read | fail `read_before_write_required` | зрозуміла помилка з `path` |
| 5 | `code.fs.read` | ok | рядки з номерами, `revision` |
| 6 | `code.fs.edit` `#2255ff→#ff3366` | **ok** | `replacements:1`, `linesAdded/Removed`, **повний unified diff** — «застосовано + diff» ✓ |
| 7 | `code.fs.edit` неіснуючий рядок | fail `edit_no_match` | «old_string was not found in the file; check indentation or use code.fs.write», `details:{}`. **Поточного фрагмента немає**; підказка з рядком є лише при whitespace-подібному збігу (`code-tools-write.ts:242–250`). Порада `use code.fs.write` штовхає до перезапису всього файлу |
| 8 | `code.fs.apply_patch` з голим `@@` | **fail** `patch_invalid` | «Hunk content without a "@@" header on line 3». Парсер вимагає `@@ -a,b +c,d @@` (`code-tools-patch.ts:76`), хоча далі знаходить hunk за контекстом. Опис у схемі каже «Unified diff (---/+++/@@ hunks)», а внутрішній формат `*** Begin Patch` (`code-tools-patch.ts:14–27`) у схемі не описано |
| 9 | `code.fs.write` нового файлу | ok | `created:true` + diff |
| 10 | `code.fs.diff {turnOnly:true}` | ok | net-diff ходу по двох файлах |
| 11 | `code.git.status` | ok | `unstaged:["src/styles.css"]`, `untracked:["src/new.ts"]` |
| 12 | `code.git.diff` | ok | unified diff |
| 13 | `code.shell.exec "node --version"` | ok (класифікатор PolicyEngine: safe) | `exitCode:0`, stdout |
| 14 | `code.shell.exec "npm run build"` (3000 рядків, помилка в stderr, exit 1) | ok, `exitCode:1` | `exitCode` на початку і `ERROR…` з хвоста **дійшли** (shell обрізає head+tail, `code-shell-runtime.ts:203–211`). Але після бюджетного обрізання runtime текст **потрійно JSON-екранований** (`truncatedPreview` у рядку в рядку), тобто ≈30 тис. символів, значна частка яких — `\\\"` |
| 15 | `"npm run build 2>&1 \| tail -20"` | fail `invalid_arguments` | заборонені `\|&;$<>` (`code-tool-executors-shell.ts:167`); повідомлення радить `code.verify.run` ✓ |
| 16 | `"npm test"` | ok | exit 0 |
| 17 | `"npm run lint"` | **fail** `approval_required` | `classifyShellCommand` дає `approval` для `npm run lint` і `npx tsc --noEmit`, але `safe` для `npm run build`/`npm test` |
| 18 | `node tsc --noEmit` | fail `approval_required` | як вище |
| 19 | `code.verify.run [typecheck,test,lint,build]` | ok | per-tool `ok`/`exitCode` і **структуровані findings** (`src/bad.ts:1:14 TS2322`). Для build у production-порті `stdout`/`stderr` обрізаються лише з **початку** до 4000 символів (`code-ports-wiring.ts:260`); findings будуються з повного виводу, а raw-хвіст губиться |

Підсумок C:
- read/list/tree/edit/write/diff/git status/diff працюють і повертають зрозумілий результат.
- grep залежить від sandbox.
- apply_patch має вужчий формат, ніж очікують моделі.
- edit-помилка «не знайдено» не містить поточного фрагмента.
- Через shell build і test запускаються; lint і typecheck, за класифікатором PolicyEngine, вимагають approval. Шлях для них — `code.verify.run`, і він працює та доносить exit code і findings до моделі.
- **Preview:** інструменту немає. Live Preview запускає система після успіху (`chat-stream-routes.ts:428`, «The system verifies saved edits and starts Live Preview»), тому перевірити його як виклик інструмента неможливо.

### 3.3. Подвійний шлюз shell у реальних запусках (ФАКТ, БД)

Дані: `code_replay_bundle_steps` (5 635 кроків, 229 бандлів), read-only.

- Невдалі виклики `code.shell.exec` мають два різні джерела:
  - `"phase":"approval" … "matrix:auto_edit/approval=require_approval"` — PolicyEngine;
  - `"message":"Terminal command requires approval","tool":"project.terminal.exec"` — sandbox `project-sandbox-service.ts:359–362`, який викликає **другий** класифікатор `classifyTerminalCommand` (`terminal-command-policy.ts:49–79`).
- Другий класифікатор — allowlist. Будь-який символ `;&|`$<>\(){}[]*?!#'"~` дає approval (`:52`). Safe лише `pwd`, `ls`, `cat <file>`, `git status/diff`, `npm test`, `npm run build|test` і ще кілька. Решта отримує «Unknown or destructive command requires approval» (`:78`).
- `CodeShellRuntime` передає в sandbox `approved: input.approved === true` (`code-shell-runtime.ts:415`). Тож коли PolicyEngine дає `allow` без approval, sandbox усе одно відмовляє. `policy_decision`: 146 × `allow` для `code.shell.exec`.
- Приклади відмов sandbox у реальних запусках: `node -v`, `node --version`, `node --check app.js`, `python -m py_compile app.py`, `npx astro build`, `npm ls --depth=0`, `cp …`, `find …`, `file public/references/…png`.
- По днях: 20.10 — 25 PolicyEngine + 9 terminal gate + 25 invalid_arguments проти 9 ok; **22.10 — 6 terminal gate проти 1 ok**. Проблема актуальна для поточної збірки.

### 3.4. Фактичне використання (D)

Джерело: `code_activity_events` (27 804 подій, 13–22.10.2026), `kind='code_tool_activity'`. Записи реальні, нічого не домислено.

| Інструмент | Викликів | Невдалих | Сер. мс | Основні помилки |
|---|---|---|---|---|
| code.fs.read | 1 852 | 6 | 477 | invalid_path 4 |
| code.fs.edit | 346 | 16 | 2 687 | edit_no_match 13, unchanged 2 |
| code.fs.grep | 314 | 17 | 3 180 | approval_required 10 (лише 14–15.10; з 19.10 — 0), search_failed 5 |
| code.fs.write | 297 | 10 | 1 464 | read_before_write_required 8 |
| code.fs.list | 211 | 0 | 963 | |
| code.verify.run | 186 | 0 | **33 162** | |
| code.fs.tree | 147 | 0 | 2 891 | |
| code.shell.exec | 105 | **88** | 3 240 | approval_required 56, invalid_arguments 27, tool_failed 5 |
| code.fs.apply_patch | 76 | 20 | 1 832 | patch_conflict 17 |
| code.project.info | 58 | 0 | 514 | |
| code.fs.diff | 16 | 0 | 90 | |
| code.data.rows.list | 10 | 1 | | |
| code.deps.add | 9 | 4 | | tool_failed 4 |
| code.shell.process.logs/start/list | 9 / 5 / 3 | 0 / 1 / 0 | | |
| code.plan.propose / update | 7 / 2 | 0 | | |
| code.deps.inspect, data.schema.inspect | 4 / 4 | 0 | | |
| code.shell.process.wait | 4 | 4 | | tool_failed |
| code.fs.move | 3 | 2 | | invalid_path |
| code.ask_user | 2 | 0 | | |
| code.symbols.outline, fs.undo_last_turn, git.status | 1 / 1 / 1 | 0 / 1 / 1 | | checkpoint_not_found; git_write_intent_required (13.10) |

**Жодного разу не викликалися (25 із 50):** усі `code.git.*` крім одного status, `code.agent.*` (6), `code.deps.audit`, `code.fs.delete`, `code.shell.exec_async`, `code.shell.process.stop`, `code.data.schema.apply/modify`, `code.data.rows.transfer`, `code.data.backend.*`.

Підсумки запусків (`code_run_states`, тривалість < 2 год):

| Статус | К-сть | Сер. ходів | Сер. викликів | Сер. тис. токенів | Сер. с |
|---|---|---|---|---|---|
| completed | 168 | 8 | 11 | 168 | 118 |
| failed | 40 | 18 | 32 | 508 | 231 |
| cancelled | 20 | 6 | 16 | 158 | 108 |

Причини failed: step_limit 10, provider_error 7, invalid_arguments_exhausted 5, budget_exhausted 5, loop_detected 3, self_review_unavailable 3, visual_acceptance_* 4, refused 2. Серед completed 10 мають `filesChanged = 0`.

**Недоліки спостережуваності (ФАКТ):**
- Activity принципово metadata-only (`assertMetadataOnly`, `coding-agent-runner-prompt.ts:79–88`). Команди shell, шляхи й аргументи є лише в replay-бандлах; Activity і replay доводиться з'єднувати через `tool_call_id`.
- Для HTTP 400 від провайдера записано лише `httpStatus:400`, без тексту помилки (запуск 2, §3.5).
- Для `interrupted` не записується причина (запуск 3).
- Немає події «компакція викинула результат читання файлу X». Видно лише `stubbed=N`.

### 3.5. Діагностика зациклення й обриву (E)

Три реальні невдалі запуски з локального стеку. Вибір: «зроби дизайн як на фото», «змінити колір» і довге завдання.

**Запуск 1 — `code-run-mvj6ynx7-057n6ili`, 22.10 07:00, «зміни дизайн сайта, зроби такий як на фото».** Runner `step10-b545d0c` — до виправлень `97b1d7a`.
- Модель `deepseek/deepseek-flash` → профіль small-context (64k). У запиті 33 інструменти.
- 71 хід, 112 викликів: **усі** `code.fs.read` / `grep` / `list` / `tree`. Edit не було жодного, тож і перевіряти не було чого. 2 600 629 токенів, 736 с.
- Послідовність: ходи 1–5 читають 9 файлів. З ходу 6 до 71 читаються ті самі `Header.tsx`, `ProductCard.tsx`, `ProductVisual.tsx`, `page.tsx`, `layout.tsx` і `products.ts` частинами, з дедалі більшим `maxLineLength` (160 → 400).
- `promptTokens` стабільно 26–43 тис. (компакція): `compressionArtifactCount: 29`.
- Завершення: `loop_detected` (cycle detector, нагадування на ході 70). Guard `no_source_progress` у цій збірці ще не існував.
- `imageCount` у запитах відсутній: стара версія replay, тож поле не записувалося.

**Запуск 2 — `code-run-mvfir8nm-gr3amrz4`, 19.10 17:19, «зміни колір на сайті, постав білий основний колір».** Runner `chat-runtime-fix-20261019-r14`.
- Модель `deepseek/deepseek-flash`. 26 ходів, 41 виклик, усі read/grep/list/tree. Edit 0, verify 0.
- Компакції на ходах 5, 8, 13, 17, 22, 26: `stubbed=6 tokens=23995->15110`, `stubbed=3 …21676->10768` і т. д.
- Завершення: на ході 27 HTTP **400** від провайдера, `retryScheduled:false` → `provider_error`. Текст 400 в Activity не збережено.
- ГІПОТЕЗА: 400 спричинила саме послідовність повідомлень після компакції (stub/«Runtime execution history» або невідповідність `tool_call_id`). Не перевірено: тіло запиту не зберігається.

**Запуск 3 — `code-run-mvja4x4x-ceatc9dq`, 22.10 08:29, «Create an online store for handmade ceramics…».** Runner `fix-97b1d7a`.
- 16 ходів, 19 викликів: `project.info`, `tree`, `list`, `read`, `write` × 3, `grep` × 3. На ході 15 двічі `code.shell.exec` → `approval_required`. `code.verify.run` не викликався.
- Далі self-review: модельний виклик тривав **134 с**, знайшов `n=2 blocking=1 (missing_tests, security)` і додав нагадування `self_review_fix`.
- У ту саму мілісекунду (08:36:50.292) run став `interrupted`, `stopReason: interrupted`. 425 459 токенів, 465 с.
- ГІПОТЕЗА: run lease (TTL 60 с, `lease_expires_at = heartbeat + 60 s`) не продовжувався під час 134-секундного синхронного self-review, тож на наступній ітерації спрацювало `leaseState.lost` (`coding-agent-runner.ts:421–424`). Не перевірено; причину interrupted не записано.

**Умови зупинки і ліміти (ФАКТ, HEAD):**

| Механізм | Де | Значення |
|---|---|---|
| Ліміт ходів | `coding-agent-runner.ts:447–451`; `code-agent-config.ts:70,119` | 40 за замовчуванням; **локально `NPATI_CODE_MAX_STEPS=0` = без ліміту** |
| Ліміт часу | `:452–456`; `code-agent-config.ts:71,120` | 30 хв; **локально `NPATI_CODE_MAX_RUN_MINUTES=0` = без ліміту** |
| Бюджет токенів/вартості | `:457–494` (`CodeRunSharedQuota`) | локально 10 млн токенів на run |
| Однаковий виклик 3 рази | `coding-agent-tool-waves.ts:240–255` | нагадування, на 4-й — `loop_detected` |
| Цикл з періодом 2–3 ходи × 3 | `:257–284` | нагадування, потім стоп |
| Однакова помилка 3 рази | `:612–621` | нагадування, потім стоп |
| 4 однакові падіння verify | `:623–627` | стоп |
| 3 edit без змін у тому ж файлі | `:629–633` | стоп |
| Немає прогресу в джерелах | `coding-agent-runner.ts:501–514` | 4 ходи — нагадування, 10 — стоп. **Лише при `websiteEdit` або `requireImplementation`** |
| 3 ходи лише інспекції | `:516–522` | нагадування; лічильник не знає неіснуючих `search`/`glob` |
| Таймаут HTTP до моделі | `omniroute-engine.ts:113,184` | 180 с на **весь** запит разом зі стрімом; окремого idle-таймауту стріму немає |
| Ретраї провайдера | `omniroute-engine.ts:127–133` | лише на наступну модель-кандидата; без fallback 400/429/5xx одразу завершують run |
| Таймаут shell / install-build | `code-agent-config.ts:75–76` | 120 с / 600 с |

---

## 4. Прогалини (F) і Data Studio (G)

### 4.1. Порівняння з Claude Code (F)

| Claude Code | Npati Code | Статус | Що вже покриває функцію |
|---|---|---|---|
| Read | code.fs.read | є | — |
| Grep | code.fs.grep (ripgrep у sandbox) | є, лише з sandbox | — |
| Glob | code.fs.list `glob` + code.fs.tree | є (через list) | окремий інструмент не потрібен |
| Edit | code.fs.edit | є; помилка без фрагмента | — |
| Write | code.fs.write | є | — |
| (MultiEdit / patch) | code.fs.apply_patch | є, строгий формат | — |
| Bash | code.shell.exec (+ process.*, exec_async) | **частково**: подвійний шлюз, без пайпів | code.verify.run для build/test/lint/typecheck |
| WebFetch | — | у `code.*` немає | `browser.web_fetch` в основному реєстрі; Crawl4AI (`services/crawler`, `packages/web-research`) |
| WebSearch | — | у `code.*` немає | `research.web_search` в основному реєстрі |
| TodoWrite | code.plan.update (+ propose) | є (2 виклики за 10 днів) | — |
| Task (субагенти) | code.agent.spawn / spawn_async / … | є, але **прибрано в website-режимі** | — |
| Перегляд зображень | — | **немає**: `code.fs.read` повертає для зображень лише метадані (`code-tools-fs.ts:343–349`) | фото користувача прикріплюється до запиту (`withCodingReferenceImages`, `coding-agent-runner-prompt.ts:250–278`). У replay `imageCount=1` у всіх запусках «за фото» 22.10. Чи провайдер реально обробив зображення, з логів не видно. Модель **намагалася** роздивитися `public/references/*.png` через shell (`file …`, `python3 -c "from PIL import Image…"`) і отримала відмову |
| Скриншот Live Preview | — як інструмент | системний етап | `reviewWebsiteReference` (Browser QA, `screenshotMode:"visual"`, `code-route-lifecycle.ts`) після run; capability `browser.browser_screenshots` в основному реєстрі |
| AskUserQuestion | code.ask_user | є | — |
| LSP | code.symbols.outline (ctags) | частково; прибрано в website-режимі | — |
| MCP | runtime overlay (`mcp-run-path.ts`) | інфраструктура є; локально 0 інструментів | — |
| Явне завершення | — | немає. Завершення = відповідь без tool calls (`coding-agent-runner.ts:699–737`) | для website-запусків промпт каже «finish your response» |

### 4.2. Data Studio (G)

**Як чат-агент створює бази й таблиці (ФАКТ).**
- `company-tool-runtime.ts:210,572–660` `projectDataTool`: `project.data.schema.inspect/apply`, `rows.list/read/create/update/delete`, `migrations.list`, `promote`, `templates.list/apply` (`seedDemoData` лише для dev), `project.auth.inspect/configure` (RLS/policies), `project.api.inspect`.
- Усі вони викликають `AgentDataStudioService` (`data-studio/agent-data-service.ts`: `createBackend :112`, `applySchema :174`, `listRows :251`, `createRow :276`, `updateRow :283`, `deleteRows :290`, `promoteDevToProd :315`, `listMigrations :346`, `applyTemplate :362`, `inspectAuth :493`, `configureAuth :513`).

**Що вже має Coding Agent (ФАКТ, `code-data-tools.ts`).** Той самий `AgentDataStudioService`, без дублювання:

| Операція | Coding (`code.data.*`) | Чат (`project.data.*`) |
|---|---|---|
| schema read | ✓ inspect | ✓ |
| create table / add field / index | ✓ schema.apply (`:62`) | ✓ |
| alter / rename / drop | ✓ schema.modify (approval) | ✓ через apply + approval |
| rows list | ✓ | ✓ |
| rows create / update / delete (seed) | ✗ | ✓ |
| templates (+ seed demo, dev) | ✗ | ✓ |
| migrations list (план, історія) | ✗ | ✓ |
| RLS / auth policies | ✗ | ✓ auth.inspect/configure |
| promote dev → prod | ✗ | ✓ (завжди approval) |
| backend create / attach | ✓ | — |
| rows transfer | ✓ | — |

**Обмеження безпеки, що вже діють (ФАКТ):**
- Лише dev: `applySchema` завжди виконує `environment: "dev"` (`agent-data-service.ts:193,226`); prod — лише через `promoteDevToProd` з approval.
- Захист від дрейфу і гонок: `DRIFT_BLOCKED` (`:188`), `STALE_SCHEMA` за fingerprint (`:222–224`), `BACKEND_CHANGED` (`:184`).
- Destructive (`drop_*`, `requiresSnapshot`) → `approvalRequired` (`:198–211`); snapshot перед destructive (`migration-engine.ts:113`).
- Migration lock: репозиторний lock на 120 с + `pg_try_advisory_xact_lock` (`migration-engine.ts:94–96,120–123`) → `MIGRATION_BUSY`.
- У Coding: `schema.apply` завжди передає `approved:false` («Model arguments and filesystem approvals never grant database approval», `code-data-tools.ts:68–69`); високоризикові операції повертають 409 «requires review in Data Studio» (`:71`). `modify/transfer/attach` вимагають `approvalId` (`code-tool-runtime.ts:317–332`). Сирого SQL немає (`code-data-tools.ts:62`).
- Тобто розширювати можна через той самий сервіс: нові executors у `code-data-tools.ts` поверх наявних методів, без нового шару.

---

## 5. Класифікація інструментів

| Група | Інструменти | Обґрунтування |
|---|---|---|
| **Працює і потрібен** | fs.read, fs.list, fs.tree, fs.grep (з sandbox), fs.edit, fs.write, fs.apply_patch, verify.run, project.info, fs.diff, data.schema.inspect, data.rows.list | live ✓ і реальне використання (D) |
| **Працює, але рідкісний** (показувати лише за наміром) | symbols.outline, deps.inspect/audit/add, plan.propose/update, ask_user, shell.process.start/list/logs/stop, fs.move, fs.undo_last_turn, усі code.git.*, усі code.data.* крім inspect/rows.list, усі code.agent.* | 0–10 викликів за 10 днів; разом ≈5–6 тис. токенів схем у кожному запиті |
| **Не працює** (виправити або сховати) | **code.shell.exec** (84 % відмов, подвійний шлюз); **code.shell.process.wait** (4/4 tool_failed); **code.shell.exec_async** (не викликався; залежить від того самого sandbox-шляху) | §3.3, §3.4 |
| **Не реалізований** (прибрати з видимого списку чи коду) | інструментів-заглушок немає. Прибрати мертві посилання: `code.browser.`/`code.web.` у фільтрі `coding-agent-runner.ts:278,310`, `code.fs.search/glob` у `:679`, три неіснуючі імена в `CODE_RUN_READ_ONLY_TOOLS` | §1.2 |
| **Дублює інший** (об'єднати) | `code.shell.exec` ↔ `code.shell.exec_async` (async-режим з `waitTimeoutMs` покриває sync); `code.agent.spawn` ↔ `code.agent.spawn_async`; `code.git.diff` ↔ `code.fs.diff` (turn net-diff проти git-diff; для моделі достатньо одного у website-режимі); класифікатори `classifyShellCommand` ↔ `classifyTerminalCommand` | §1.2, §3.3 |

---

## 6. Знахідки

Формат: ID · проблема · файл і функція · доказ · вплив · мінімальна зміна · ризик регресії · як перевірити.

**F-01 · Компакція відрізає контекст, потрібний для правки, і спричиняє перечитування.**
- Де: `coding-agent-context-compactor.ts:75` (`compressionRatio: min(ratio, modelInputTokens / contextWindow)`), `code-agent-config.ts:81` (`modelInputTokens: 16_384`), `code-conversation-compaction.ts:34,294,300` (`DEFAULT_KEEP_RECENT_TURNS = 4`, рахується в повідомленнях).
- Доказ: запуск 1 — 71 хід, 112 read, 29 компакцій, 0 edit; запуск 2 — компакція кожні 3–5 ходів (`stubbed=6 tokens=23995->15110`), 0 edit. У запитах 6–10 тис. токенів займають самі схеми.
- Вплив: **High** (швидкість і точність).
- Мінімальна зміна: (а) не стабити результати `code.fs.read` для файлів, які ще не змінювались у цьому run і читались ≤ N ходів тому. Механізм pinned evidence уже є (`code-conversation-compaction.ts:131–185`), його треба розширити, а не писати новий. (б) `keepRecentTurns` рахувати в ходах (assistant + його tool-повідомлення), а не в повідомленнях. (в) Брати `modelInputTokens` з профілю (64k для small-context), а не одне глобальне число.
- Ризик регресії: ріст вартості запиту; можливий 400 за вікном у моделей із меншим реальним вікном.
- Як перевірити: повторити сценарій «зміни колір» на deepseek-flash; метрики — кількість `context_compacted`, повторних `code.fs.read` того самого шляху, ходів до першого edit.

**F-02 · Подвійний класифікатор shell: PolicyEngine дозволяє, sandbox відмовляє.**
- Де: `code-shell-runtime.ts:415` (`approved: input.approved === true`) → `project-sandbox-service.ts:359–362` → `terminal-command-policy.ts:49–79` `classifyTerminalCommand`.
- Доказ: 56 + 27 відмов зі 105; 22.10: 6 terminal gate проти 1 ok; `node --version` у sandbox відхилено, у PolicyEngine — safe.
- Вплив: **High**.
- Мінімальна зміна: одне джерело рішення. Коли PolicyEngine уже виніс `allow` для цього виклику, передавати в sandbox ознаку policy-approved (як для verify-порту, де вже передається `approved: true`, `code-ports-wiring.ts:223–224`). Альтернатива — вирівняти allowlist sandbox з `classifyShellCommand`, але це гірше: два списки знову розійдуться.
- Ризик регресії: безпековий — розширення того, що виконується. Hard-deny у PolicyEngine лишається.
- Як перевірити: `tests/coding-agent-c4-shell.test.ts` + новий тест «policy allow → sandbox виконує»; security-gate.

**F-03 · `useWhen`/`doNotUseWhen` з реєстру не доходять до моделі.**
- Де: `coding-agent-tool-catalog.ts:108` `chatToolDefinitions`.
- Доказ: §2.5 — у реєстрі є для всіх 50; у визначення йде лише `description`.
- Вплив: **Medium** (точність вибору інструмента).
- Мінімальна зміна: дописувати 1 рядок `Use when / Not when` із реєстру лише для 10–12 базових інструментів. Не для всіх, бо +4,6 тис. токенів. Або замінити ними частину довгих описів.
- Ризик регресії: зміна тексту схеми потребує нової версії маніфесту (`code-tool-registry.ts:11–17`). Краще додавати в індекс системного промпту, який не версіонується.
- Як перевірити: eval-корпус C14 (`tests/coding-agent-c14-*`), частка невірних інструментів.

**F-04 · Модель отримує 32–50 інструментів незалежно від задачі; набір не залежить від профілю.**
- Де: `coding-agent-tool-catalog.ts:46–90`; `coding-agent-runner.ts:278,310`.
- Доказ: §2.3 (6–10 тис. токенів); 25 із 50 не викликались жодного разу (§3.4).
- Вплив: **Medium–High** (вартість кожного ходу; у поєднанні з F-01 — точність).
- Мінімальна зміна: розширити наявний website-регекс до «core set» за замовчуванням (read/list/tree/grep/edit/apply_patch/write/diff/verify/project.info/ask_user). Решту показувати за наміром (git, якщо запит про git; data, якщо проєкт має backend або запит про БД; agent.*, лише для великих задач), використовуючи вже наявний `resolveChatCodeIntent`.
- Ризик регресії: модель не побачить потрібний рідкісний інструмент. Пом'якшення — індекс у промпті з назвою прихованих.
- Як перевірити: replay-бандли; порівняти `promptTokens` першого ходу і частку completed.

**F-05 · `edit_no_match` не повертає поточний фрагмент і радить `code.fs.write`.**
- Де: `code-tools-write.ts:242–250`.
- Доказ: live #7; 13 × `edit_no_match` у Activity.
- Вплив: **Medium**.
- Мінімальна зміна: у `details` повертати найближчий фрагмент (у функції вже є `findWhitespaceTolerantMatch`; додати fallback — рядки навколо найкращого часткового збігу, ≤ 20 рядків). Пораду змінити на «re-read the range and retry edit», а не «use code.fs.write».
- Ризик регресії: низький.
- Як перевірити: unit-тест на `editFile` + статистика `edit_no_match → наступний виклик`.

**F-06 · `apply_patch` відхиляє голий `@@`; формат у схемі описано інакше, ніж приймає парсер.**
- Де: `code-tools-patch.ts:76,121,146`; опис у `code-tool-schemas.json` (`code.fs.apply_patch`).
- Доказ: live #8; 20/76 невдалих у Activity (17 conflict, 1 invalid).
- Вплив: **Medium** (hosted-native-tools має `preferredEditTool: apply_patch`).
- Мінімальна зміна: приймати `@@` без діапазонів (`beforeStart = -1`), бо пошук за контекстом уже реалізовано в `applyHunksToContent` (`:185–195`); в описі схеми показати фактичний формат `*** Begin Patch`.
- Ризик регресії: неоднозначні hunks — вже обробляються (`ambiguous_context`).
- Як перевірити: `tests/coding-agent-c3-*`.

**F-07 · 17 інструментів без групи C5 (латентна відмова).**
- Де: `code-capability-groups.ts:21–71`; `code-policy-engine.ts:386–395`; `enriched-policy-engine-wiring.ts:36–45`.
- Доказ: скрипт — `assertCapabilityGranted` відхиляє всі 17. У чат-запусках `agentId` = відображуване ім'я «NPATI Coding Agent» (`chat-stream-routes.ts:423`), а `getCompanyAgent` шукає за id. ГІПОТЕЗА: агента не знайдено → `capabilityGroups` не заповнюється → фаза C5 фактично не діє.
- Вплив: **Medium**: або перевірка груп не працює, або при справжньому id зламаються plan/ask_user/data.
- Мінімальна зміна: додати групи для `code.plan.*`/`ask_user` (read), `code.data.*` (нова `code.data` або read/write), `code.agent.*`, `exec_async`/`process.wait` (shell); передавати справжній agent id.
- Ризик регресії: увімкнення C5 почне реально відхиляти виклики.
- Як перевірити: `tests/coding-agent-c5-*`, security-gate.

**F-08 · Немає перегляду зображень у workspace.**
- Де: `code-tools-fs.ts:343–349`.
- Доказ: модель намагалася аналізувати `public/references/*.png` через shell (PIL, `file`) і отримала відмову (§3.3).
- Вплив: **Medium** для сценарію «як на фото».
- Мінімальна зміна: не новий інструмент, а опція `code.fs.read` для зображень ≤ N КБ — повертати image part у наступне повідомлення через той самий `withCodingReferenceImages`. Активувати лише для vision-моделі (вибір уже є в `resolveModel`, `code-route-lifecycle.ts:330–337`).
- Ризик регресії: prompt injection через зображення; є `security.vision_bridge_guardrail`.
- Як перевірити: сценарій з reference-asset.

**F-09 · Вивід verify: `stdout`/`stderr` обрізаються лише з початку.**
- Де: `code-ports-wiring.ts:260`; у verify-parser так само (`code-verify-parser.ts:48`).
- Доказ: код; live-копія показала, що findings рятують typecheck, але raw-хвіст build губиться.
- Вплив: **Low–Medium**.
- Мінімальна зміна: використати наявний `truncateShellOutput` (head + tail).
- Ризик: низький.
- Як перевірити: тест verify з довгим build-логом.

**F-10 · Потрійне JSON-екранування великих результатів.**
- Де: обгортка бюджету в `CodeToolRuntime.wrap` (`code-tool-runtime.ts:510`) + `boundText` у waves.
- Доказ: live #14 — `truncatedPreview` усередині рядка усередині рядка.
- Вплив: **Low** (зайві токени, гірша читабельність).
- Мінімальна зміна: обрізати поля `stdout`/`stderr` до серіалізації, а не серіалізований JSON.
- Ризик: низький.
- Як перевірити: розмір повідомлення `tool` для `npm run build`.

**F-11 · Компакція в тиші міняє послідовність повідомлень; HTTP 400 без тексту.**
- Де: `coding-agent-context-compactor.ts`; `omniroute-engine.ts:117–133`; запис у `coding-agent-runner.ts:583`.
- Доказ: запуск 2 (400 одразу після компакції на ході 26).
- Вплив: **Medium** (обрив).
- Мінімальна зміна: записувати в Activity перші 300 символів тексту помилки провайдера (`lastError` уже формується) і тип останньої компакції.
- Ризик: дані провайдера в Activity — пропускати через наявний `assertMetadataOnly` / redaction.
- Як перевірити: повторення сценарію.

**F-12 · Причина `interrupted` не записується; синхронний self-review 134 с.**
- Де: `coding-agent-runner.ts:421–424`; `coding-agent-review-coordinator.ts`.
- Доказ: запуск 3.
- Вплив: **Medium**.
- Мінімальна зміна: записувати `reason` (lease_lost / signal / flag); продовжувати heartbeat під час self-review.
- Ризик: низький.
- Як перевірити: штучна затримка self-review > lease TTL у тесті.

**F-13 · Локальні ліміти вимкнені (`NPATI_CODE_MAX_STEPS=0`, `NPATI_CODE_MAX_RUN_MINUTES=0`).**
- Де: env контейнера `agent-api`; `code-agent-config.ts:119–120`.
- Доказ: `docker exec … env`; запуск 1 тривав 71 хід.
- Вплив: **Medium** (без guard прогресу run іде до бюджету).
- Мінімальна зміна: конфігурація, не код — повернути розумні значення для self-hosted. Це рішення власника; у межах аудиту нічого не змінено.
- Ризик: обрив довгих задач.
- Як перевірити: env.

**F-14 · Guard прогресу діє лише для website/requireImplementation.**
- Де: `coding-agent-runner.ts:501`.
- Доказ: код.
- Вплив: **Low–Medium** для звичайних code-проєктів (там лишаються лише детектори повторів).
- Мінімальна зміна: умову `!readOnlyIntent && mode !== "plan"` поширити на всі edit-наміри.
- Ризик: хибні зупинки на дослідницьких задачах.
- Як перевірити: `tests/coding-agent-progress-guard.test.ts`.

**F-15 · Мертві посилання і розбіжності класифікації.**
- Де: `coding-agent-runner.ts:278,310,679`; `coding-agent-runner-prompt.ts:11–25`; `code-edit-approval.ts:25`.
- Доказ: §1.2.
- Вплив: **Low**.
- Мінімальна зміна: видалити або вирівняти; `code.fs.diff` додати в `CODE_RUN_READ_ONLY_TOOLS`.
- Ризик: мінімальний.
- Як перевірити: typecheck + c2/c3 parity-тести.

**F-16 · Сесії, пінені до старого маніфесту, не бачать `code.data.*`.**
- Де: `coding-agent-tool-catalog.ts:52–54`; `code-tool-registry.ts:200–204`; чат бере `codeSessions[0]` (`chat-stream-routes.ts:313–315`).
- Доказ: скрипт — v10/v11 у website-режимі дають 24 інструменти без data.
- Вплив: **Low–Medium** («створи таблицю» у давньому проєкті).
- Мінімальна зміна: для чат-сесій оновлювати pin до поточного маніфесту, коли нова версія лише додає інструменти (additive).
- Ризик: відтворюваність replay — pin фіксується в execution snapshot.
- Як перевірити: створити сесію з pin=10 і перевірити список.

---

## 7. Топ-5 змін за впливом на швидкість і точність

1. **F-01 Компакція:** зберігати результати читань незмінених файлів (розширити pinned evidence), рахувати `keepRecent` у ходах, брати бюджет із профілю. Це прибирає основний механізм зациклення «читаю → забуваю → читаю».
2. **F-02 Один шлюз для shell:** sandbox довіряє рішенню PolicyEngine для вже авторизованого виклику. Це відновлює `node --check`, `py_compile`, `ls`/`cat` тощо: 84 % відмов → очікувано одиниці.
3. **F-04 + F-03 Core set + правила використання:** 11–12 базових інструментів за замовчуванням, решта за наміром; короткі `use/not when` із реєстру для базових. Мінус ≈3–6 тис. токенів на кожен хід, менше хибних виборів.
4. **F-05 + F-06 Зрозумілі помилки редагування:** фрагмент у `edit_no_match`, `@@` без діапазонів в `apply_patch`, коректний опис формату. Це 30 з 422 невдалих edit/patch-викликів і пов'язані з ними повторні читання.
5. **F-11 + F-12 Спостережуваність обривів:** текст помилки провайдера, причина `interrupted`, heartbeat під час self-review. Без цього provider_error та interrupted (≈20 % невдалих запусків) не діагностуються.

---

## 8. Підсумок

**Працює правильно (підтверджено):** read / list / tree / edit / write / diff / git status / git diff; read-before-write; edit повертає «застосовано» разом із diff; `code.verify.run` доносить exit code і структуровані findings; детектори повторів і циклів; dev-only, fingerprint і migration lock у Data Studio; прикріплення фото до запиту (`imageCount=1`).

**Підтверджено як проблему:** компакція і перечитування (F-01); подвійний шлюз shell (F-02); `useWhen`/`doNotUseWhen` не доходять до моделі (F-03); 32–50 інструментів у кожному запиті при 25 невикористаних (F-04); `edit_no_match` без фрагмента (F-05); голий `@@` (F-06); 17 інструментів без групи C5 (F-07, частина — гіпотеза); немає перегляду зображень (F-08); head-only обрізання у verify (F-09); потрійне екранування (F-10).

**Не вдалося перевірити:**
- Справжній Docker-sandbox у живих викликах C (використано локальний дублер; поведінку sandbox підтверджено лише даними БД).
- Чи провайдер DeepSeek через OmniRoute реально обробляє `image_url` (у логах лише лічильник).
- Причину HTTP 400 у запуску 2 і причину `interrupted` у запуску 3 (не записуються).
- Чи `getCompanyAgent` з іменем «NPATI Coding Agent» справді повертає `null` у Postgres-сховищі (F-07).
- Поведінку HEAD `f763346` у живих запусках: локальний образ зібрано з `97b1d7a`.
- Токени рахувалися оцінкою «символи/4», а не токенізатором провайдера.
