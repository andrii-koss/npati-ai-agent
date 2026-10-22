# Крок 8 — виправлення Security Gate і semantic routing

**Дата:** 2026-10-21. **Базується на:** [Крок 7](step-7-security-gate-analysis.md), [Крок 6](step-6-final-performance.md).

**Результат:** Security Gate **2838 passed / 0 failed** (було 2787 / 51). Усі 51 цільові тести зелені.
Жоден тест не вимкнено, жоден permission/approval/sandbox-контроль не послаблено.

---

## 1. Група A — Manifest / Catalog pins (15 падінь)

### Першопричина

Коміт `b545d0c` додав 50-й інструмент `code.data.backend.create` і підняв published manifest до **v14**, але не
оновив три піни: `TOOL_SCHEMA_MANIFEST_VERSION` (13), `STATIC_CATALOG_BASELINE` (397, каталог 398) і очікування в
C9/C11/C12.

### Security-review `code.data.backend.create` (перед оновленням пінів)

| Властивість | Факт |
|---|---|
| Дозвіл | `requiredPermissions: ["workspace:write"]`; входить до `CODE_WRITE_TOOLS` (`code-edit-approval.ts`) |
| Policy | `dataPolicy.evaluate({ctx, companyId, projectId})`; `decision !== "allow"` → `policy_denied` 403 |
| Approval | загальний guard: не-`rows.list` і не-`dryRun` без `input.approved` → `approval_required` 403 |
| Tenant isolation | `createBackend(ctx, companyId, projectId, …)`; `assertBackend` для інших data-операцій |
| Секрети | повертає лише public SDK identity, «never credentials» |
| БД-зміни | створює backend, привʼязаний до проєкту, ідемпотентно; сирого SQL не приймає |

**Висновок рев'ю: PASS.** Єдина асиметрія — каталог має `requiresConfirmation: false`, тоді як runtime вимагає
approval; це не послаблює контроль (approval enforced server-side), тому політику не змінював, лише задокументував.

### Зміни

| Файл | Зміна |
|---|---|
| `packages/shared/src/capability-catalog-audit-types.ts` | `TOOL_SCHEMA_MANIFEST_VERSION` 13→**14**; `STATIC_CATALOG_BASELINE` 397/133/264 → **398/134/264**; коментар із результатом рев'ю |
| `tests/coding-agent-c9-plan-tool.test.ts` | версія 14, `CODE_TOOL_SCHEMAS` 50, `current.tools` 50 |
| `tests/coding-agent-c11-git-workflow.test.ts` | версія 14, 50 схем |
| `tests/coding-agent-c12-subagent-workflow.test.ts` | версія 14, 50 схем |
| `tests/coding-agent-c13-capability-catalog-audit.test.ts` | facts: version 14, manifest/catalog 50, negative control 51/50 |
| `tests/coding-agent-c13-mcp-run-path.test.ts` | static 398, combined 400 |
| `tests/coding-agent-c13-mcp-run-path-wiring.test.ts` | anchor `this.toolDescriptors(` замість рядка з `;` (рефактор додав `.filter`) |

Піни оновлені **після** рев'ю, а не «щоб зеленило»: спершу перевірено permission/policy/approval/tenant, потім
синхронізовано числа.

---

## 2. Група B — C13 MCP (24 падіння)

### Першопричина (справжній дефект, не тестове оточення)

Discovery **працював**: `prepareForRun` публікував `mcp:conn-1/read_file` (діагностика показала
`result: "published", toolCount: 1`), інструмент був у model-visible списку. Падав **наступний крок**:

`code-tool-call-adapter.ts` перевіряв native-імʼя регуляркою `^[a-zA-Z0-9_.-]{1,128}$`. Канонічний MCP-id
(`mcp:<connectionId>/<toolName>`) містить `:` і `/`, тому **кожен** MCP-виклик відхилявся як
`malformed_native_tool_call` — до runtime, до permission policy, до approval. Звідси «run reported no pending
approval» і `completed` замість `waiting_for_user`: пауза просто не досягалася.

### Виправлення

`apps/agent-api/src/code-tool-call-adapter.ts`: дозволені `:` і `/` у native-імʼї (`^[a-zA-Z0-9_.:/-]{1,128}$`).

Чому це не послаблює контроль:

- наступний рядок — `resolveKnownTool(knownTools, rawName)`; id, який ніхто не публікував, лишається
  `unknown_tool` і **не виконується**;
- символьний набір markup-у (`<`, `>`, пробіли, лапки) і далі відхиляється;
- discovery, permission policy, `approval_required` та consume — не змінювалися.

### Покриття lifecycle

Після виправлення зелені **11/11** approval-тестів (пауза, рівно один запит, approve-once, deny, timeout,
cancellation, restart, schema/args binding), **18/18** run-path і **5/5** wiring (усього 59/59 з runtime
capabilities). Тобто «до approval жодна захищена операція не виконується» тепер перевіряється реальним шляхом,
а не обходиться.

---

## 3. Група C — Semantic intent (9 падінь)

### Першопричина

`chat-project-intent.ts` мав детермінований fast-path: якщо `classifyProjectIntent` каже CREATE_*, він одразу
повертав рішення, **не питаючи семантичний класифікатор**. Модальність («як створити сайт?») не перевірялася, і
`chat-stream-routes.ts:151-180` для CREATE_WEBSITE створює проєкт і запускає ран.

### Виправлення

Fast-path **прибрано** (той самий файл, рядки 72-76): створення завжди проходить через наявний семантичний
класифікатор, інструкція якого прямо розрізняє питання/пораду/приклад від імператива і працює для всіх мов.
Нових regex, keyword-евристик чи другого роутера не додано. Детерміновані CHAT-guards лишилися — вони й далі
відповідають без виклику моделі там, де це безпечно.

**Ціна:** для явного створення додається один семантичний виклик (раніше fast-path його пропускав). Це
усвідомлений обмін: коректність модальності важливіша за один дешевий routing-виклик.

Результат: 9/9 semantic тестів і 2/2 preflight (група D) — провайдер знову викликається на етапі preflight.

---

## 4. Групи D і E

**D (preflight cancellation, 2):** наслідок C — провайдер не викликався, тест чекав на нього і падав за таймаутом.
Після фіксу C обидва тести проходять; lease/cancellation/cleanup не змінювалися.

**E (C6 telemetry, 1):** контракт Activity: подія `planning` несе текст асистента (`title: result.content`) і
емітується лише коли проза є. У тесті scripted-хід має порожній `content` — отже події немає за контрактом.
Оновлено assertion на точний контракт (порожній «planning completed» не фабрикується), решта перевірок
(токени 18, `model_call/completed`, статус `cancelled`, 0 tool calls) збережені.

---

## 5. Результати тестів

| Перевірка | Було | Стало |
|---|---|---|
| **Security Gate** | 2787 passed / **51 failed** | **2838 passed / 0 failed** |
| 11 файлів із 51 падінням | 221: 51 failed | **221: 0 failed** |
| Coding Agent regression (step1–6, c6, c9×3, chat-website, adapter, stream, development) | 259 | **259 passed** |
| Multilingual / OmniRoute / preview / git / approvals / trace | 188 (6 flake під навантаженням) | **188 passed** (окремо — 31/31 OmniRoute) |
| Sandbox / tenant / approval / rollback / cancellation | 222 | **222 passed** |
| `npm run typecheck` | pass | **pass** |
| `npm run build` (API + web) | pass | **pass** |
| `npm run audit:code-tools` | OK (50, v14) | **OK** |
| `npm run lint` | 1 pre-existing (size guard `DataStudioSettingsPage.tsx`) | без змін |
| `npm run typecheck:tests` | 1 pre-existing (`coding-agent-data-tools.test.ts`, не пов'язаний) | без змін |

«6 flake під навантаженням» — під час першого паралельного прогону (одночасно з повним gate) частина
OmniRoute-тестів впала за таймаутом; повторний прогін на вільній машині — 188/188 і 31/31. Це не регресія, але
зафіксовано як спостереження.

---

## 6. Змінені файли

| Файл | Що саме |
|---|---|
| `apps/agent-api/src/code-tool-call-adapter.ts` | native-name regex: дозволено `:` і `/` (MCP-id), після чого — точний `resolveKnownTool` |
| `apps/agent-api/src/chat-project-intent.ts` | прибрано deterministic creation fast-path; створення → семантичний класифікатор |
| `packages/shared/src/capability-catalog-audit-types.ts` | manifest pin 14, catalog baseline 398/134/264 (+ коментар рев'ю) |
| `tests/coding-agent-c9-plan-tool.test.ts`, `c11-git-workflow.test.ts`, `c12-subagent-workflow.test.ts` | pins 14 / 50 |
| `tests/coding-agent-c13-capability-catalog-audit.test.ts` | facts 14 / 50 / 51 |
| `tests/coding-agent-c13-mcp-run-path.test.ts` | static 398, combined 400 |
| `tests/coding-agent-c13-mcp-run-path-wiring.test.ts` | anchor після рефактору `.filter(...)` |
| `tests/coding-agent-c6-runner-stop-conditions.test.ts` | контракт: немає прози — немає `planning`-події |

Тимчасові діагностичні `console.error` (у `coding-agent-runner.ts`, `coding-agent-tool-waves.ts`,
`mcp-run-path.ts`), додані під час розслідування, **видалені**; `mcp-run-path.ts` побайтово збігається з HEAD.

---

## 7. Що використано з наявного

- semantic classifier (`chat-project-intent.ts`) — без нового роутера;
- `resolveKnownTool` / `normalizeToolCalls` — без обходу перевірки імен;
- `approval_required` + runState pause + durable approvals — без змін;
- capability catalog / manifest registry / baseline pins — той самий governance-механізм;
- Activity/Run Trace — без нових подій.

---

## 8. Залишкові ризики

1. **MCP перевірено in-process gate-набором** (транспорт-заглушка), не живим MCP-сервером; для production потрібен
   ізольований E2E з реальним Integration.
2. **Живий стек досі на образі до змін** — наскрізні метрики після Кроків 1–8 не знято (передеплой заборонений).
3. **`requiresConfirmation:false` vs runtime approval** — задокументована асиметрія; якщо UI покладається на поле,
   варто узгодити окремим рішенням.
4. **+1 семантичний виклик на явне створення** — свідома ціна усунення дефекту модальності.
5. **`typecheck:tests`** — pre-existing помилка типів у `coding-agent-data-tools.test.ts` (мок `createBackend`), не
   пов'язана зі змінами; не виправлялася в межах кроку.

---

## 9. Готовність

- **До ізольованого E2E: готово.** Gate зелений, 51/51 виправлено, регресії чисті, typecheck/build проходять.
- **До production release: умовно.** Потрібно: (а) ізольований передеплой і повтор MCP E2E з реальним сервером,
  (б) рішення щодо `requiresConfirmation`, (в) зняти наскрізні метрики Кроку 6 на новому коді.

Security policy, approval gates, sandbox isolation, permission scopes і release gates не послаблювалися; тести не
вимикалися.
